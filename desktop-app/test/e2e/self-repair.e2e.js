'use strict';
// self-repair.e2e.js — P18 in the REAL Electron app (xvfb), with the three AI panes
// pointed at test/fixtures/fake-chat.html (AUTOINJECTOR_SITE_URL_<SITE>):
//   * ChatGPT's replies use markup that matches NONE of the app's selectors
//     (layout=changed): the start-up check-in fails (NO_REPLY_FOUND), the built-in
//     alternatives don't match, the page search learns the reply blocks, a second
//     check-in passes -> ✔ fixed, learned selector saved.
//   * Gemini shows a log-in page: needs you (LOGGED_OUT) without a message typed;
//     once the page is the chat again (the user "logged in"), it re-checks by itself.
//   * Claude: P38 🔢 number teach from the 🎯 card — the user types the shown
//     4 digits into Claude's box and presses Send; AutoInjector itself asks Claude
//     to "Write the number #### backwards, digits only.", learns the reply area
//     from where the reversed digits appear, saves all three and confirms with a
//     check-in -> "✔ Saved — Claude is working again."
//   * ChatGPT made "not working" -> the ⚠️ pop-over offers 🎯 Point at it / 🔢;
//     🎯 opens the card with "AI's reply" chosen; OK -> the banner in ChatGPT's
//     window; hover outlines, click picks (blue -> green chip); Save that ONE item
//     (green ✓); Test it -> the check-in works.
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
      AUTOINJECTOR_RELOAD_SETTLE_MS: '600', AUTOINJECTOR_CHECKIN_OWED_DEMAND_MS: '1500', AUTOINJECTOR_TEACH_POLL_MS: '300', AUTOINJECTOR_CAPTURE_SETTLE_MS: '400',
      AUTOINJECTOR_AKOWE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ai-nobf-')), AUTOINJECTOR_AKOWE_SERVER: '0', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost'
    }),
  });
  const shots = [];
  try {
    let controls = null;
    for (let i = 0; i < 100 && !controls; i++) {
      for (const w of app.windows()) { try { if (await w.$('#bf-ais')) controls = w; } catch (_) {} }
      if (!controls) await sleep(400);
    }
    assert(!!controls, 'control panel with the Akọwe panel appears');
    if (!controls) return 1;
    await controls.setViewportSize({ width: 1366, height: 900 }).catch(() => {});
    const errors = [];
    controls.on('pageerror', (e) => errors.push(String(e)));
    const status = () => controls.evaluate(() => window.api.selfRepairStatus());
    const waitFor = async (fn, ms, step = 250) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = await fn(); if (r) return r; await sleep(step); } return null; };
    const panelShot = async (name) => {
      // Scroll the panel into view BELOW the sticky User Panel (it would cover it).
      await controls.evaluate(() => {
        const p = document.getElementById('col-akowe'); if (!p) return;
        p.scrollIntoView({ block: 'start' });
        const up = document.getElementById('col-userpanel');
        const top = up && getComputedStyle(up).position === 'sticky' ? up.getBoundingClientRect().bottom : 0;
        let sc = p.parentElement; while (sc && sc !== document.body && sc.scrollHeight <= sc.clientHeight + 2) sc = sc.parentElement;
        const el = sc && sc !== document.body ? sc : (document.scrollingElement || document.documentElement);
        el.scrollTop -= Math.max(0, top - p.getBoundingClientRect().top + 8);
      });
      await sleep(300);
      const f = path.join(SHOTS, `${name}.png`);
      const panel = await controls.$('#col-akowe');
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
        await controls.evaluate(() => window.api.akoweStatus({}).then(() => 0));
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

    // the 🎯 card of one pane (it sits in the pane's strip of the control window)
    const cardShot = async (site, name) => {
      await controls.evaluate((s) => { const m = document.getElementById(`pick-menu-${s}`); if (m) m.scrollIntoView({ block: 'center' }); }, site);
      await sleep(250);
      const f = path.join(SHOTS, `${name}.png`);
      const card = await controls.$(`#pick-menu-${site}`);
      if (card) await card.screenshot({ path: f }).catch(async () => { await controls.screenshot({ path: f }); });
      shots.push(f);
      return f;
    };
    const cardClick = (site, sel) => controls.evaluate((a) => { const m = document.getElementById(`pick-menu-${a.site}`); const b = m && m.querySelector(a.sel); if (!b) return false; b.click(); return true; }, { site, sel });
    const chipOf = (site, role) => controls.evaluate((a) => { const c = document.querySelector(`#pick-menu-${a.site} .pk-row[data-role="${a.role}"] .pk-chip`); return c ? { st: c.dataset.st, text: c.textContent } : null; }, { site, role });

    console.log('\n== Claude: 🔢 number teach from the 🎯 card (type → Send → AutoInjector asks for it backwards → saved) ==');
    const okClaude = await waitFor(async () => { const x = (await status()).sites.claude; return x.state === 'ok' && !x.running ? x : null; }, 60000);
    assert(!!okClaude, 'Claude passed its start-up check-in');
    await controls.evaluate(() => { const b = document.querySelector('#col-claude .pick-btn'); if (b) b.click(); });
    await sleep(600);
    const cardText = await controls.$eval('#pick-menu-claude', (e) => e.innerText).catch(() => '');
    assert(/What do you want to point at\?/.test(cardText) && /Message box/.test(cardText) && /Send button/.test(cardText) && /AI's reply/.test(cardText) && /Do it for me with a number/.test(cardText), '🎯 opens the card with the three choices and “🔢 Do it for me with a number”');
    await cardShot('claude', 'p38_01_picker_card_three_choices');
    await cardClick('claude', '.pk-number');
    const tst = await waitFor(async () => { const x = (await status()).sites.claude; return x.teach && x.teach.active ? x.teach : null; }, 8000);
    assert(tst && /^\d{4}$/.test(tst.number), `number teach started (number ${tst && tst.number})`);
    const N = tst ? tst.number : '0000'; const REV = N.split('').reverse().join('');
    await waitFor(() => controls.$eval('#bf-teach', (e) => !e.hidden && /Number teach/.test(e.innerText)).catch(() => false), 8000);
    const teachText = await controls.$eval('#bf-teach', (e) => e.innerText).catch(() => '');
    assert(new RegExp(`Type\\s*${N}\\s*into Claude's message box and press Send`).test(teachText.replace(/\n/g, ' ')) && /Cancel/.test(teachText), 'the Akọwe panel box says exactly what to type, with Cancel');
    await panelShot('p38_02_number_teach_type');
    await sleep(600);
    const banner = await inPane('claude', 'String((document.querySelector("[data-autoinjector-overlay]") || {}).textContent || "")');
    assert(new RegExp(`type\\s+${N}\\s+into Claude`).test(banner || ''), 'the same request shows as a banner inside Claude\'s window');
    await paneShot('claude', 'p38_03_number_teach_banner_in_claude_pane');
    // the user types the number and presses Send (real DOM events in the real page)
    await inPane('claude', `(() => { const ed = document.querySelector('[contenteditable="true"]'); ed.focus(); ed.textContent = ${JSON.stringify(N)}; ed.dispatchEvent(new InputEvent('input', { bubbles: true })); return true; })()`);
    await sleep(1200);
    await inPane('claude', `(() => { const b = document.getElementById('send'); b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); b.click(); return true; })()`);
    const asked = await waitFor(async () => { const x = (await status()).sites.claude; return x.teach && (x.teach.phase === 'wait_reply' || x.teach.result) ? x.teach : null; }, 30000, 150);
    assert(asked && asked.asked, `after the user's message AutoInjector asked Claude to write ${N} backwards (${asked && asked.phase})`);
    await panelShot('p38_04_number_teach_asked_backwards');
    const askedInPane = await inPane('claude', `document.body.innerText.includes(${JSON.stringify(`Write the number ${N} backwards, digits only.`)})`);
    assert(askedInPane, 'the follow-up “Write the number #### backwards, digits only.” is in Claude\'s chat');
    await waitFor(() => inPane('claude', `document.body.innerText.includes(${JSON.stringify(REV)})`), 15000);
    await inPane('claude', `(() => { const hit = Array.from(document.querySelectorAll('#log p')).filter((p) => p.textContent.trim() === ${JSON.stringify(REV)}).pop(); const blk = hit ? (hit.closest('.font-claude-message') || hit) : null; const ask = blk ? blk.previousElementSibling : null; const top = (ask || blk); if (top) window.scrollTo(0, top.getBoundingClientRect().top + window.scrollY - 70); return !!hit; })()`);
    await sleep(200);
    await paneShot('claude', 'p38_05_claude_wrote_it_backwards');
    const taught = await waitFor(async () => { const x = (await status()).sites.claude; return x.teach && x.teach.result ? x : null; }, 60000);
    assert(taught && taught.teach.result === 'fixed' && taught.state === 'ok', `learned, saved and confirmed by a check-in (${taught && taught.teach.result}; part ${taught && taught.teach.failedPart})`);
    const pkc = await controls.evaluate(() => window.api.pickerStatus('claude'));
    assert(pkc && ['input', 'send', 'assistant'].every((r) => pkc.items[r].state === 'saved' && pkc.items[r].how === 'number'), `all three saved like 🎯 picks (${pkc && JSON.stringify(Object.fromEntries(Object.entries(pkc.items).map(([k, v]) => [k, v.state + '/' + v.how])))})`);
    await waitFor(() => controls.$eval('#bf-teach', (e) => /Saved — Claude is working again/.test(e.innerText)).catch(() => false), 8000);
    assert(/✔ Saved — Claude is working again\./.test(await controls.$eval('#bf-teach', (e) => e.innerText).catch(() => '')), '“✔ Saved — Claude is working again.”');
    await panelShot('p38_06_number_teach_saved');
    await sleep(500);
    await cardShot('claude', 'p38_07_card_after_number_teach_saved');
    const nags = await controls.evaluate(() => window.api.getState ? window.api.getState().then((s) => (s.log || []).filter((e) => /totag-missing|endtag-missing/.test(e.kind) && e.detail && e.detail.site === 'claude').length) : 0);
    assert(nags === 0, `no missing-tag nags were sent to Claude for the teach answers (${nags})`);
    await controls.evaluate(() => { const b = Array.from(document.querySelectorAll('#bf-teach-actions button')).find((x) => /Close/.test(x.textContent)); if (b) b.click(); });
    await controls.evaluate(() => { const m = document.getElementById('pick-menu-claude'); if (m) m.classList.add('collapsed'); });

    console.log('\n== ChatGPT not working -> ⚠️ pop-over -> 🎯 Point at it -> pick the reply -> Save that ONE item -> Test it ==');
    await controls.evaluate(() => window.api.selfRepairForgetLearned('chatgpt'));
    const tfail = await controls.evaluate(() => window.api.pickerTest('chatgpt'));
    assert(tfail && !tfail.ok, `with what it learned forgotten, “Test it” fails (${tfail && tfail.state} ${tfail && tfail.problem})`);
    const br = await waitFor(async () => { const x = (await status()).sites.chatgpt; return x.state === 'broken' ? x : null; }, 15000);
    assert(!!br, 'ChatGPT shows as not working');
    await sleep(1200);
    const m2 = await controls.$('.bf-ai[data-site="chatgpt"] .bf-hz');
    if (m2) { await m2.click(); await sleep(500); }
    const pop2 = await controls.$eval('#bf-pop', (e) => (e.hidden ? '' : e.innerText)).catch(() => '');
    assert(/isn't working/.test(pop2) && /What AutoInjector already tried/i.test(pop2) && /Point at it/.test(pop2) && /Do it for me with a number/.test(pop2), `the ⚠️ pop-over: what was tried + 🎯 Point at it / 🔢 Do it for me with a number [${pop2.replace(/\s+/g, ' ').slice(0, 400)}]`);
    await panelShot('p38_08_broken_popover_point_at_it');
    await controls.evaluate(() => { const b = Array.from(document.querySelectorAll('#bf-pop button')).find((x) => /Point at it/.test(x.textContent)); if (b) b.click(); });
    await sleep(700);
    const sel0 = await controls.evaluate(() => { const r = document.querySelector('#pick-menu-chatgpt .pk-row.sel'); const m = document.getElementById('pick-menu-chatgpt'); return { open: !!m && !m.classList.contains('collapsed'), role: r ? r.dataset.role : null }; });
    assert(sel0.open && sel0.role === 'assistant', `the pop-over opened ChatGPT's 🎯 card with “AI's reply” chosen (${JSON.stringify(sel0)})`);
    const c0 = await chipOf('chatgpt', 'assistant');
    assert(c0 && c0.st === 'none' && (await chipOf('chatgpt', 'input')).st === 'none', `chips start BLUE (${c0 && c0.text})`);
    await cardShot('chatgpt', 'p38_09_card_blue_chips');
    await cardClick('chatgpt', '.pk-ok');
    await waitFor(() => inPane('chatgpt', '!!document.querySelector("[data-autoinjector-overlay]")'), 8000);
    const pbanner = await inPane('chatgpt', 'String((document.querySelector("[data-autoinjector-overlay]") || {}).textContent || "")');
    assert(/Click the AI's latest reply in this window/.test(pbanner || ''), `pick mode: ChatGPT's window says “Click the AI's latest reply in this window” (${pbanner})`);
    // hover the newest reply (outline), take the picture, then click it
    await inPane('chatgpt', `(() => { const l = document.querySelectorAll('.answer-body'); const t = l[l.length - 1].querySelector('p:nth-child(2)') || l[l.length - 1]; t.scrollIntoView({ block: 'center' }); t.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return true; })()`);
    await sleep(300);
    await paneShot('chatgpt', 'p38_10_pick_banner_and_hover_outline');
    await inPane('chatgpt', `(() => { const l = document.querySelectorAll('.answer-body'); const t = l[l.length - 1].querySelector('p:nth-child(2)') || l[l.length - 1]; t.click(); return true; })()`);
    const green = await waitFor(async () => { const c = await chipOf('chatgpt', 'assistant'); return c && c.st === 'picked' ? c : null; }, 8000);
    assert(!!green, `the reply chip turned GREEN with a preview (${green && green.text})`);
    assert((await chipOf('chatgpt', 'input')).st === 'none' && (await chipOf('chatgpt', 'send')).st === 'none', 'the other two stay blue');
    await cardShot('chatgpt', 'p38_11_card_green_picked');
    await cardClick('chatgpt', '.pk-row[data-role="assistant"] .pk-save');
    const savedChip = await waitFor(async () => { const c = await chipOf('chatgpt', 'assistant'); return c && c.st === 'saved' ? c : null; }, 5000);
    assert(!!savedChip && /✓ Saved/.test(savedChip.text), `Save -> green ✓ (${savedChip && savedChip.text})`);
    const pkg = await controls.evaluate(() => window.api.pickerStatus('chatgpt'));
    assert(pkg.items.assistant.state === 'saved' && pkg.items.input.state === 'none' && pkg.items.send.state === 'none', 'only that ONE item is saved');
    await cardClick('chatgpt', '.pk-test');
    const tested = await waitFor(() => controls.$eval('#pick-status-chatgpt', (e) => (/answered the check-in/.test(e.textContent) ? e.textContent : null)).catch(() => null), 40000, 300);
    assert(!!tested, `Test it: the check-in works with the saved pick (${tested})`);
    const again = await waitFor(async () => { const x = (await status()).sites.chatgpt; return x.state === 'ok' && !x.running ? x : null; }, 20000);
    assert(!!again, 'ChatGPT works again');
    await cardShot('chatgpt', 'p38_12_card_saved_and_tested');
    await sleep(1200);
    await panelShot('p18_08_all_ok');

    const diag = await controls.evaluate(() => window.api.akoweDiagnostics({}));
    assert(diag && diag.ok && /Self-repair chatgpt: state ok/.test(diag.text) && /Self-repair claude: state ok/.test(diag.text) && /Self-repair claude: .*🎯 saved .*assistant\(number/.test(diag.text) && /Self-repair chatgpt: .*🎯 saved assistant\(pick/.test(diag.text), `diagnostics list the self-repair and the saved picks per AI [${diag && String(diag.text).split('\n').filter((l) => /Self-repair/.test(l)).join(' | ')}]`);
    assert(!/Repeat this number|Reply with only this word|backwards, digits only/.test(diag.text), 'diagnostics carry no message text');
    console.log('\n== Claude stalls mid-conversation, gets a check-in, answers only the word — and is asked to carry on ==');
    const CARRY = 'Thanks — that was only a quick connection check from AutoInjector; please ignore it. Continue exactly where you left off in our conversation.';
    await controls.evaluate(() => window.api.hopLimit(4)); // keep the fake AIs' own conversation short
    await inPane('claude', 'window.__fake.stallNext = true; true');
    const cPosted0 = await inPane('claude', 'window.__fake.posted.length');
    await controls.evaluate(() => window.api.sendCompose('Plan a picnic with the others, step by step. PICNIC-START', ['claude']));
    const stalledSeq = await waitFor(() => inPane('claude', '(window.__fake.stalled || []).slice(-1)[0] || null'), 15000);
    assert(!!stalledSeq, `Claude got the message and stalled (no answer to [MSG #${stalledSeq}])`);
    await sleep(2200); // a stalled message stops blocking a check-in after a while (3 min in the app; 1.5 s here)
    const pr2 = await controls.evaluate(() => window.api.selfRepairProbe(['claude']));
    assert(pr2 && pr2.started && pr2.started.includes('claude'), `a check-in goes to the stalled Claude (${JSON.stringify(pr2 && pr2.skipped)})`);
    const fuPost = await waitFor(() => inPane('claude', `(window.__fake.posted.slice(${cPosted0}).find((p) => p.text.includes(${JSON.stringify(CARRY)})) || {}).text || null`), 60000, 300);
    assert(!!fuPost, 'after Claude answered the check-in with only its word, AutoInjector asked it to carry on');
    const cPosts = await inPane('claude', `window.__fake.posted.slice(${cPosted0}).map((p) => p.text)`);
    const iCk = cPosts.map((t) => /Reply with only this word/.test(t)).lastIndexOf(true);
    const iFu = cPosts.findIndex((t) => t.includes(CARRY));
    assert(iCk >= 0 && iFu > iCk && cPosts.filter((t) => t.includes(CARRY)).length === 1, `in Claude's chat: the check-in, then ONE follow-up (posts: ${cPosts.map((t) => (t.includes(CARRY) ? 'CARRY-ON' : /Reply with only/.test(t) ? 'CHECK-IN' : 'MSG')).join(', ')})`);
    assert(fuPost && fuPost.includes(`You had not answered [MSG #${stalledSeq}] yet`) && /PICNIC-START/.test(fuPost), 'the follow-up sends the stalled message again, with its [MSG #]');
    const fuSeq = fuPost && (/^\[MSG #(\d+)\]/.exec(fuPost) || [])[1];
    const cReply = await waitFor(async () => (await controls.evaluate(() => window.api.getState())).transcript.find((t) => t.site === 'claude' && new RegExp(`to #${fuSeq}\\b`).test(t.text)) || null, 30000, 300);
    assert(!!cReply, `Claude's answer to the follow-up is in the conversation like any reply (${cReply && cReply.text.slice(0, 60)})`);
    const tokenM = cReply && /token (CLAUDE-R\d+)/.exec(cReply.text);
    const passedOn = tokenM && await waitFor(async () => {
      for (const s of ['chatgpt', 'gemini']) { if (await inPane(s, `window.__fake.posted.some((p) => p.text.includes(${JSON.stringify(tokenM[1])}))`)) return s; }
      return null;
    }, 30000, 300);
    assert(!!passedOn, `…and it was passed on to ${passedOn || 'the next AI'}: the conversation goes on`);
    const contLog = await controls.evaluate(() => window.api.getState().then((s) => (s.log || []).filter((e) => e.kind === 'checkin-continue' && e.detail && e.detail.site === 'claude').map((e) => e.detail)));
    assert(contLog.length === 1 && contLog[0].sent === true && Array.isArray(contLog[0].resent) && contLog[0].resent.includes(stalledSeq), `logged once: checkin-continue (claude, ${contLog[0] && contLog[0].reason}, resent ${contLog[0] && JSON.stringify(contLog[0].resent)})`);
    const feedLine = await waitFor(() => controls.evaluate(() => window.api.akoweStatus({}).then((st) => ((st.activity || []).find((e) => /Asked Claude to carry on where it left off/.test(e.say || '')) || {}).say || null)), 8000);
    assert(!!feedLine, `the activity feed says it in plain words (${feedLine})`);
    const box = await controls.$eval('#bf-carryon', (e) => ({ checked: e.checked, label: e.parentElement.textContent.trim() })).catch(() => null);
    assert(box && box.checked && /After a check-in, ask the AI to carry on/.test(box.label), 'the setting “After a check-in, ask the AI to carry on” is shown, ticked');
    await panelShot('checkin_continue_01_feed');
    await controls.evaluate(() => window.api.silenceAll()); // stop the fake AIs' conversation
    await controls.evaluate(() => window.api.hopLimit(30));
    await sleep(1500);
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
