'use strict';
// pane-fixes.e2e.js — the user's log of 2026-11-09 (build a916ba9), in the REAL app (xvfb):
//   • ChatGPT shows a reply's "[TO: USER]" line in its OWN small block and the answer in the blocks after it
//     (test/fixtures/fake-chat.html?layout=tagsplit). The whole reply is read and shown — no "reply-unreadable",
//     no "missing [TO:] tag" nag, no reload.
//   • Claude's saved reply selector no longer fits its page and was already seen not to fit on 2 earlier starts:
//     on this (3rd) start it is retired by itself — the control panel shows one plain line
//     "Claude's page changed; AutoInjector stopped using an old saved setting that no longer fits." with
//     "↩ Put it back", which brings it back.
// Screenshots go to SHOTS (default test/e2e/__screenshots__ — never committed).
//   xvfb-run -a node test/e2e/pane-fixes.e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeAsserts, findWindow, APP_DIR } = require('./helpers');

let electron;
try { electron = require('playwright')._electron; } catch (_) { console.error('needs playwright'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.SHOTS || path.join(__dirname, '__screenshots__');
const FIX = path.join(__dirname, '..', 'fixtures', 'fake-chat.html');
const url = (q) => `file://${FIX}?${q}`;

async function main() {
  const { assert, state } = makeAsserts();
  fs.mkdirSync(SHOTS, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-fixes-e2e-'));
  const userData = path.join(tmp, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  const now = Date.now(), H = 3600e3;
  fs.writeFileSync(path.join(userData, 'autoinjector-state.json'), JSON.stringify({
    schemaVersion: 1, savedAt: now - H,
    selectorOverrides: { chatgpt: {}, claude: { assistant: 'div.claude-old-reply-block' }, gemini: {} },
    pickMeta: { version: 1, sites: { claude: { assistant: { savedAt: now - 40 * H, how: 'pick', rev: 1, version: 1 } } } },
    staleEvidence: { claude: { assistant: { selector: 'div.claude-old-reply-block', starts: 2, lastRun: 'an-earlier-start', at: now - 3 * H } } }
  }));
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', `--user-data-dir=${userData}`], cwd: APP_DIR,
    env: Object.assign({}, process.env, {
      HOME: tmp, AUTOINJECTOR_CHECKIN: '0', AUTOINJECTOR_BRIDGE: '0', AUTOINJECTOR_AKOWE_SERVER: '0', AUTOINJECTOR_HEALTH: '0', AUTOINJECTOR_CONTENT_SCAN: '0',
      AUTOINJECTOR_SD_AUTOSTART: '0', AUTOINJECTOR_PANE_ZOOM: '0.8', AUTOINJECTOR_PROBE_DELAY_MS: '1000', AUTOINJECTOR_CAPTURE_SETTLE_MS: '400',
      AUTOINJECTOR_AKOWE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ai-nobf-')),
      AUTOINJECTOR_SITE_URL_CHATGPT: url('site=chatgpt&layout=tagsplit&quirks=stop&speed=0.4'),
      AUTOINJECTOR_SITE_URL_CLAUDE: url('site=claude&quirks=stop&speed=0.4'),
      AUTOINJECTOR_SITE_URL_GEMINI: url('site=gemini&quirks=none&speed=0.4'),
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    }),
  });
  try {
    const c = await findWindow(app, '#up-zone-compose', 40000);
    assert(!!c, 'the control panel appears');
    if (!c) return;
    await c.setViewportSize({ width: 1366, height: 900 }).catch(() => {});
    const errors = []; c.on('pageerror', (e) => errors.push(String(e)));
    const inPane = (site, js) => app.evaluate(async ({ webContents }, a) => {
      const wc = webContents.getAllWebContents().find((w) => /fake-chat\.html/.test(w.getURL()) && w.getURL().includes(`site=${a.site}`));
      return wc ? wc.executeJavaScript(a.js, true) : null;
    }, { site, js });
    const until = async (fn, ms, step = 250) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); } return null; };
    const getState = () => c.evaluate(() => window.api.getState());
    await until(async () => (await inPane('chatgpt', 'typeof window.__fake')) === 'object' && (await inPane('claude', 'typeof window.__fake')) === 'object', 30000);
    // both fake AIs answer the user only (no AI-to-AI relay in this test)
    const hook = (lines) => `window.__fakeHook = () => ({ lines: ${JSON.stringify(lines)}, to: "USER", tagged: true }); true`;
    await inPane('chatgpt', hook(['Here is the plan for chapter two.', '{"chapter": 2, "beats": ["arrival", "storm"]}']));
    await inPane('claude', hook(['Claude read the page fine.']));
    await sleep(2500); // the first page checks

    console.log('\n== ChatGPT: "[TO: USER]" in its own block, the answer after it — read whole ==');
    await c.evaluate(() => window.api.sendCompose('Plan chapter two, please.', ['chatgpt']));
    const turn = await until(async () => ((await getState()).transcript || []).find((t) => t.site === 'chatgpt' && /plan for chapter two/.test(t.text)), 30000);
    assert(!!turn && /"beats"/.test(turn.text) && !/\[TO:|\[FROM:/.test(turn.text), `the whole reply is captured, tags stripped (${JSON.stringify(turn && turn.text)})`);
    await sleep(1500);
    let log = (await getState()).log || [];
    const bad = log.filter((e) => e.detail && e.detail.site === 'chatgpt' && /^(reply-unreadable|totag-missing|endtag-missing)$/.test(e.kind));
    assert(bad.length === 0, `no "reply-unreadable" / missing-tag nag for ChatGPT (${bad.map((e) => e.kind).join(', ') || 'none'})`);
    assert(!log.some((e) => e.kind === 'reload' && e.detail && e.detail.site === 'chatgpt'), 'ChatGPT\'s page was never reloaded');
    const posted = await inPane('chatgpt', 'window.__fake.dump().posted.length');
    assert(posted === 1, `only the user's message was typed into ChatGPT — no tag reminder (${posted})`);
    await c.screenshot({ path: path.join(SHOTS, 'pane-fixes-01-chatgpt-tagsplit.png') }).catch(() => {});

    console.log('\n== Claude: an old saved setting that no longer fits, seen on 2 earlier starts -> retired on this one ==');
    await c.evaluate(() => window.api.sendCompose('Hello Claude.', ['claude']));
    const notice = await until(async () => { const t = await c.textContent('#retire-notice').catch(() => ''); return (await c.isVisible('#retire-notice').catch(() => false)) && /Claude's page changed/.test(t) ? t : null; }, 30000);
    assert(!!notice && /Claude's page changed; AutoInjector stopped using an old saved setting that no longer fits\./.test(notice) && /↩ Put it back/.test(notice), `one plain line with ↩ Put it back ("${notice && notice.trim()}")`);
    log = (await getState()).log || [];
    const ret = log.find((e) => e.kind === 'selector-retired' && e.detail && e.detail.site === 'claude');
    assert(!!ret && ret.detail.role === 'assistant' && ret.detail.starts === 3, `logged as selector-retired (starts: ${ret && ret.detail.starts})`);
    const ct = await until(async () => ((await getState()).transcript || []).find((t) => t.site === 'claude' && /read the page fine/.test(t.text)), 20000);
    assert(!!ct, "Claude's reply is still read (by the built-in reader)");
    await c.screenshot({ path: path.join(SHOTS, 'pane-fixes-02-retire-notice.png') }).catch(() => {});
    await c.click('#retire-notice button:has-text("Put it back")');
    await until(async () => !(await c.isVisible('#retire-notice').catch(() => true)), 5000, 150);
    assert(!(await c.isVisible('#retire-notice').catch(() => true)), 'after ↩ Put it back the notice goes');
    assert(/Claude: the old saved setting is back\./.test(await c.textContent('#status')), `the status line says so ("${await c.textContent('#status')}")`);
    const ps = await c.evaluate(() => window.api.pickerStatus ? window.api.pickerStatus('claude') : null).catch(() => null);
    if (ps) assert(ps.items && ps.items.assistant && ps.items.assistant.state !== 'none', 'Claude\'s saved reply reader is back on its 🎯 card');
    assert(errors.length === 0, `no page errors in the control panel (${errors.join(' | ')})`);
  } finally {
    await app.close().catch(() => {});
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  process.exit(state.failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
