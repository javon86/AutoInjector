'use strict';
// self-repair.e2e.js — P18 in the REAL Electron app (xvfb), with the three AI panes
// pointed at test/fixtures/fake-chat.html (AUTOINJECTOR_SITE_URL_<SITE>):
//   * ChatGPT's replies use markup that matches NONE of the app's selectors
//     (layout=changed): the start-up check-in fails (NO_REPLY_FOUND), the built-in
//     alternatives don't match, the page search learns the reply blocks, a second
//     check-in passes -> ✔ fixed, learned selector saved.
//   * Gemini shows a log-in page: needs you (LOGGED_OUT) without a message typed;
//     once the page is the chat again (the user "logged in"), it re-checks by itself.
//   * Claude: 🎓 teach step — the user types "Repeat this number: ####" into
//     Claude's box and presses Send; the app learns the box, Send, the user's
//     message and the reply and confirms with a check-in -> ✔ Fixed.
//   * Cancelling a teach step leaves the AI "Not working" with the ⚠️ pop-over
//     listing what was tried.
// Screenshots of each state go to SHOTS (default test/e2e/__screenshots__).
//   xvfb-run -a node test/e2e/self-repair.e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeAsserts } = require('./helpers');
const electron = require('playwright')._electron;

const SHOTS = process.env.SHOTS || path.join(__dirname, '__screenshots__');
const FIX = path.join(__dirname, '..', 'fixtures', 'fake-chat.html');
const url = (q) => `file://${FIX}?${q}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { assert, state } = makeAsserts();
  fs.mkdirSync(SHOTS, { recursive: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-sr-home-'));
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], cwd: path.join(__dirname, '..', '..'),
    env: Object.assign({}, process.env, {
      HOME: home, AUTOINJECTOR_BRIDGE: '0', AUTOINJECTOR_PANE_ZOOM: '0.8',
      AUTOINJECTOR_SITE_URL_CHATGPT: url('site=chatgpt&layout=changed&quirks=none&speed=0.4'),
      AUTOINJECTOR_SITE_URL_CLAUDE: url('site=claude&quirks=none&speed=0.4'),
      AUTOINJECTOR_SITE_URL_GEMINI: url('site=gemini&page=login'),
      AUTOINJECTOR_PROBE_DELAY_MS: '1500', AUTOINJECTOR_CHECKIN_STARTUP_DELAY_MS: '800', AUTOINJECTOR_CHECKIN_TICK_MS: '700',
      AUTOINJECTOR_PROBE_TIMEOUT_MS: '20000', AUTOINJECTOR_PROBE_EARLY_MS: '3000', AUTOINJECTOR_NEEDS_USER_RECHECK_MS: '1500',
      AUTOINJECTOR_RELOAD_SETTLE_MS: '600', AUTOINJECTOR_TEACH_POLL_MS: '300', AUTOINJECTOR_CAPTURE_SETTLE_MS: '400',
      AUTOINJECTOR_BOOKFORGE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ai-nobf-')), NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost'
    }),
  });
  const shots = [];
  try {
    let controls = null;
    for (let i = 0; i < 100 && !controls; i++) {
      for (const w of app.windows()) { try { if (await w.$('#bf-ais')) controls = w; } catch (_) {} }
      if (!controls) await sleep(400);
    }
    assert(!!controls, 'control panel with the BookForge panel appears');
    if (!controls) return 1;
    await controls.setViewportSize({ width: 1366, height: 900 }).catch(() => {});
    const errors = [];
    controls.on('pageerror', (e) => errors.push(String(e)));
    const status = () => controls.evaluate(() => window.api.selfRepairStatus());
    const waitFor = async (fn, ms, step = 250) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = await fn(); if (r) return r; await sleep(step); } return null; };
    const panelShot = async (name) => {
      // Scroll the panel into view BELOW the sticky User Panel (it would cover it).
      await controls.evaluate(() => {
        const p = document.getElementById('col-bookforge'); if (!p) return;
        p.scrollIntoView({ block: 'start' });
        const up = document.getElementById('col-userpanel');
        const top = up && getComputedStyle(up).position === 'sticky' ? up.getBoundingClientRect().bottom : 0;
        let sc = p.parentElement; while (sc && sc !== document.body && sc.scrollHeight <= sc.clientHeight + 2) sc = sc.parentElement;
        const el = sc && sc !== document.body ? sc : (document.scrollingElement || document.documentElement);
        el.scrollTop -= Math.max(0, top - p.getBoundingClientRect().top + 8);
      });
      await sleep(300);
      const f = path.join(SHOTS, `${name}.png`);
      const panel = await controls.$('#col-bookforge');
      if (panel) await panel.screenshot({ path: f }).catch(async () => { await controls.screenshot({ path: f }); });
      else await controls.screenshot({ path: f });
      shots.push(f);
      return f;
    };
    // A pane's own picture (native views aren't in the control page's screenshot).
    const paneShot = async (site, name) => {
      const f = path.join(SHOTS, `${name}.png`);
      const b64 = await app.evaluate(async ({ webContents }, s) => {
        const wc = webContents.getAllWebContents().find((w) => /fake-chat\.html/.test(w.getURL()) && w.getURL().includes(`site=${s}`));
        if (!wc) return null;
        const img = await wc.capturePage();
        return img.toPNG().toString('base64');
      }, site);
      if (b64) { fs.writeFileSync(f, Buffer.from(b64, 'base64')); shots.push(f); }
      return b64 ? f : null;
    };
    const inPane = (site, js) => app.evaluate(async ({ webContents }, a) => {
      const wc = webContents.getAllWebContents().find((w) => /fake-chat\.html/.test(w.getURL()) && w.getURL().includes(`site=${a.site}`));
      return wc ? wc.executeJavaScript(a.js, true) : null;
    }, { site, js });

    console.log('\n== ChatGPT: start-up check-in fails (unknown reply markup) -> repaired by itself ==');
    let sawRepair = null;
    const okChat = await waitFor(async () => {
      const s = await status();
      const x = s.sites.chatgpt;
      if (!sawRepair && x.state === 'repairing') {
        sawRepair = x;
        await controls.evaluate(() => window.api.bookforgeStatus({}).then(() => 0));
        await sleep(150);
        if (await controls.$('.bf-ai[data-site="chatgpt"][data-st="repair"]')) await panelShot('p18_01_chatgpt_repairing');
      }
      return x.state === 'ok' && x.fixedAt ? x : null;
    }, 90000, 200);
    assert(!!sawRepair && sawRepair.problem === 'NO_REPLY_FOUND', `the start-up check-in detected NO_REPLY_FOUND and started repairing (${sawRepair && sawRepair.problem})`);
    assert(!!okChat, `ChatGPT repaired itself (${okChat && JSON.stringify(okChat.tried.map((t) => `${t.step}:${t.outcome}`))})`);
    assert(okChat && okChat.tried.some((t) => t.step === 'page_search' && t.outcome === 'LEARNED') && okChat.learned.assistant && okChat.learned.assistant.how === 'page-search', 'by the page search, and the learned reply selector is saved');
    await sleep(1500);

    console.log('\n== Gemini: logged out -> needs you; recovers by itself once the chat is back ==');
    const nu = await waitFor(async () => { const x = (await status()).sites.gemini; return x.state === 'needs_user' ? x : null; }, 60000);
    assert(nu && nu.problem === 'LOGGED_OUT' && /log in/i.test((nu.fix || []).join(' ')), `Gemini: needs you — LOGGED_OUT, with what to do (${nu && nu.problem})`);
    await sleep(1200);
    await panelShot('p18_02_chips_ok_fixed_and_needs_you');
    const marker = await controls.$('.bf-ai[data-site="gemini"] .bf-hz');
    assert(!!marker, 'a ⚠️ marker sits on Gemini');
    if (marker) {
      await marker.click(); await sleep(500);
      const pop = await controls.$eval('#bf-pop', (e) => e.innerText).catch(() => '');
      assert(/Gemini needs you/.test(pop) && /log in/i.test(pop) && /What AutoInjector already tried/i.test(pop) && !/Show AutoInjector/.test(pop), `its pop-over says exactly what to do and what was tried (no teach step for a log-in) [${pop.replace(/\s+/g, ' ').slice(0, 400)}]`);
      await panelShot('p18_03_needs_you_popover');
      await controls.keyboard.press('Escape').catch(() => {});
      await controls.evaluate(() => { const b = document.getElementById('bf-pop'); if (b) b.hidden = true; });
    }
    // the user logs in: the pane shows the chat again
    await app.evaluate(({ webContents }, u) => { const wc = webContents.getAllWebContents().find((w) => /site=gemini/.test(w.getURL())); if (wc) wc.loadURL(u); }, url('site=gemini&quirks=none&speed=0.4'));
    const back = await waitFor(async () => { const x = (await status()).sites.gemini; return x.state === 'ok' ? x : null; }, 60000);
    assert(!!back, 'Gemini noticed by itself that it works again (signature gone -> one check-in -> ok)');

    console.log('\n== Claude: 🎓 teach step ==');
    const okClaude = await waitFor(async () => { const x = (await status()).sites.claude; return x.state === 'ok' && !x.running ? x : null; }, 60000);
    assert(!!okClaude, 'Claude passed its start-up check-in');
    const t = await controls.evaluate(() => window.api.selfRepairTeachStart('claude'));
    assert(t && t.ok && /^\d{4}$/.test(t.number), `teach step started (number ${t && t.number})`);
    await waitFor(() => controls.$eval('#bf-teach', (e) => !e.hidden && /Repeat this number/.test(e.innerText)).catch(() => false), 8000);
    const teachText = await controls.$eval('#bf-teach', (e) => e.innerText).catch(() => '');
    assert(new RegExp(`Repeat this number: ${t.number}`).test(teachText) && /Cancel/.test(teachText), 'the pop-up in the controls panel says exactly what to type, with Cancel');
    await panelShot('p18_04_teach_popup');
    await sleep(800);
    const banner = await inPane('claude', 'String((document.querySelector("[data-autoinjector-overlay]") || {}).textContent || "")');
    assert(new RegExp(`Repeat this number: ${t.number}`).test(banner || ''), 'the same request shows as a banner inside Claude\'s window');
    await paneShot('claude', 'p18_05_teach_banner_in_claude_pane');
    // the user types the line and presses Send (real DOM events in the real page)
    await inPane('claude', `(() => { const ed = document.querySelector('[contenteditable="true"]'); ed.focus(); ed.textContent = ${JSON.stringify(`Repeat this number: ${t.number}`)}; ed.dispatchEvent(new InputEvent('input', { bubbles: true })); return true; })()`);
    await sleep(1200);
    await inPane('claude', `(() => { const b = document.getElementById('send'); b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); b.click(); return true; })()`);
    const taught = await waitFor(async () => { const x = (await status()).sites.claude; return x.teach && x.teach.result ? x : null; }, 60000);
    assert(taught && taught.teach.result === 'fixed' && taught.state === 'ok', `taught and confirmed by a new check-in (${taught && taught.teach.result}; missing ${taught && taught.teach.missing})`);
    assert(taught && taught.learned.input && taught.learned.assistant && taught.learned.input.how === 'teach' && taught.learned.assistant.how === 'teach', 'message box + reply learned from the teach step');
    await waitFor(() => controls.$eval('#bf-teach', (e) => /Fixed — Claude is working again/.test(e.innerText)).catch(() => false), 8000);
    assert(/Fixed — Claude is working again/.test(await controls.$eval('#bf-teach', (e) => e.innerText).catch(() => '')), '"✔ Fixed — Claude is working again"');
    await panelShot('p18_06_teach_fixed');
    await controls.evaluate(() => { const b = Array.from(document.querySelectorAll('#bf-teach-actions button')).find((x) => /Close/.test(x.textContent)); if (b) b.click(); });

    console.log('\n== Not working: a cancelled teach step, the ⚠️ pop-over lists what was tried ==');
    const t2 = await controls.evaluate(() => window.api.selfRepairTeachStart('chatgpt'));
    assert(t2 && t2.ok, 'teach started for ChatGPT');
    await sleep(800);
    await controls.evaluate(() => window.api.selfRepairTeachCancel('chatgpt'));
    const br = await waitFor(async () => { const x = (await status()).sites.chatgpt; return x.state === 'broken' ? x : null; }, 15000);
    assert(!!br, 'cancel -> ChatGPT shows as not working');
    await sleep(1200);
    const m2 = await controls.$('.bf-ai[data-site="chatgpt"] .bf-hz');
    if (m2) { await m2.click(); await sleep(500); }
    const pop2 = await controls.$eval('#bf-pop', (e) => (e.hidden ? '' : e.innerText)).catch(() => '');
    assert(/isn't working/.test(pop2) && /What AutoInjector already tried/i.test(pop2) && /Show AutoInjector/.test(pop2), `the ⚠️ pop-over: what was tried + 🎓 Show AutoInjector / 🔄 Reload [${pop2.replace(/\s+/g, ' ').slice(0, 400)}]`);
    await panelShot('p18_07_broken_popover');
    await controls.evaluate(() => { const b = document.getElementById('bf-pop'); if (b) b.hidden = true; });
    await controls.evaluate(() => window.api.selfRepairProbe(['chatgpt']));
    const again = await waitFor(async () => { const x = (await status()).sites.chatgpt; return x.state === 'ok' && !x.running ? x : null; }, 60000);
    assert(!!again, '🩺 Check now: ChatGPT works again (the learned selector is still there)');
    await sleep(1200);
    await panelShot('p18_08_all_ok');

    const diag = await controls.evaluate(() => window.api.bookforgeDiagnostics({}));
    assert(diag && diag.ok && /Self-repair chatgpt: state ok/.test(diag.text) && /Self-repair claude: state ok/.test(diag.text) && /Self-repair claude: .*assistant\(teach/.test(diag.text), `diagnostics list the self-repair per AI [${diag && String(diag.text).split('\n').filter((l) => /Self-repair/.test(l)).join(' | ')}]`);
    assert(!/Repeat this number|Reply with only this word/.test(diag.text), 'diagnostics carry no message text');
    assert(errors.length === 0, `no page errors in the control panel (${errors.slice(0, 3).join(' | ')})`);
    console.log('screenshots:\n  ' + shots.join('\n  '));
  } finally {
    const done = await Promise.race([app.close().then(() => true, () => true), sleep(15000).then(() => false)]);
    if (!done) { try { const pr = app.process(); if (pr && pr.pid) pr.kill('SIGKILL'); } catch (_) {} }
  }
  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  return state.failed ? 1 : 0;
}
setTimeout(() => { console.error('self-repair e2e watchdog: still running after 9 minutes — exiting'); process.exit(1); }, 9 * 60 * 1000).unref();
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
