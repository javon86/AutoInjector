'use strict';
// longrun.e2e.js — PR #123 in the REAL Electron app (xvfb), with the three AI panes pointed at
// test/fixtures/fake-chat.html (no internet needed):
//   * the AI panes run with backgroundThrottling off (they keep full speed when the window is minimised / hidden)
//   * Akọwe reports a running book (POST /v1/status) -> the real powerSaveBlocker keeps the PC awake
//   * closing the window then asks "A book is being written. Keep it running in the background, or stop it?"
//     (the real dialog is answered by the test): Keep running -> the window hides (a tray icon where the desktop has
//     a tray) and the app stays up; the run then needs a decision -> a desktop notification is asked for;
//     Stop it and quit -> the app really quits
//   xvfb-run -a node test/e2e/longrun.e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { makeAsserts } = require('./helpers');
const electron = require('playwright')._electron;

const FIX = path.join(__dirname, '..', 'fixtures', 'fake-chat.html');
const url = (q) => `file://${FIX}?${q}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { let r = null; try { r = await fn(); } catch (_) { r = null; } if (r) return r; await sleep(200); } return null; }

function post(port, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': data.length }, agent: false }, (res) => {
      const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(c).toString('utf8') }));
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

async function main() {
  const { assert, state } = makeAsserts();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-longrun-home-'));
  const port = 21000 + Math.floor(Math.random() * 15000);
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], cwd: path.join(__dirname, '..', '..'),
    env: Object.assign({}, process.env, {
      HOME: home, AUTOINJECTOR_BRIDGE: '0', AUTOINJECTOR_AKOWE_SERVER: '0', AUTOINJECTOR_CHECKIN: '0', AUTOINJECTOR_CONTENT_SCAN: '0',
      AUTOINJECTOR_AKOWE_PORT: String(port), AUTOINJECTOR_RUN_GUARD_MS: '300', AUTOINJECTOR_WAKE_GRACE_MS: '500',
      AUTOINJECTOR_SITE_URL_CHATGPT: url('site=chatgpt&quirks=none&speed=0.3'),
      AUTOINJECTOR_SITE_URL_CLAUDE: url('site=claude&quirks=none&speed=0.3'),
      AUTOINJECTOR_SITE_URL_GEMINI: url('site=gemini&quirks=none&speed=0.3')
    })
  });
  let closed = false;
  app.on('close', () => { closed = true; });
  try {
    const controls = await waitUntil(async () => { for (const w of app.windows()) { if (await w.$('#up-zone-compose')) return w; } return null; }, 40000);
    assert(!!controls, 'the control panel opened');
    const logFile = path.join(await app.evaluate(({ app: a }) => a.getPath('userData')), 'autoinjector-debug.log');
    const logHas = (re) => { try { return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter((e) => e && re(e)); } catch (_) { return []; } };

    console.log('\n== the AI panes keep running when the window is minimised ==');
    const thr = await waitUntil(() => app.evaluate(({ webContents }) => {
      const panes = webContents.getAllWebContents().filter((w) => /fake-chat\.html/.test(w.getURL()));
      return panes.length >= 3 ? panes.map((w) => w.getBackgroundThrottling()) : null;
    }));
    assert(thr && thr.length >= 3 && thr.every((x) => x === false), `all three AI panes: backgroundThrottling off (${JSON.stringify(thr)})`);

    console.log('\n== Akọwe reports a running book: the PC is kept awake ==');
    const en = await controls.evaluate(() => window.api.akoweSetEnabled(true));
    assert(en && en.listening, 'the bridge is on');
    const token = (await controls.evaluate(() => window.api.akoweRevealToken())).token;
    let r = await post(port, '/v1/status', token, { app: 'akowe', version: 1, project: { id: 'p1', title: 'The Glass Road' }, run: { id: 'run-e2e', title: 'The Glass Road', status: 'running', state: 'working', step: 9, steps_total: 16 } });
    assert(r.status === 200, `status accepted (${r.status})`);
    const awake = await waitUntil(() => logHas((e) => e.kind === 'keep-awake' && e.detail && e.detail.on === true)[0]);
    assert(awake && /Keeping the PC awake while a book is being written/.test(awake.detail.say), `the real powerSaveBlocker is on ("${awake && awake.detail.say}")`);

    console.log('\n== closing the window asks; "Keep running in the background" hides it ==');
    await app.evaluate(({ dialog }) => {
      global.__asked = [];
      global.__answer = 0;
      dialog.showMessageBox = async (_w, opts) => { global.__asked.push(opts.message); return { response: global.__answer }; };
    });
    await app.evaluate(({ BaseWindow }) => { const w = BaseWindow.getAllWindows().find((x) => /Automation/.test(x.getTitle())); w.close(); });
    await sleep(800);
    const after = await app.evaluate(({ BaseWindow }) => { const w = BaseWindow.getAllWindows().find((x) => /Automation/.test(x.getTitle())); return { asked: global.__asked.slice(), exists: !!w, visible: w ? w.isVisible() : null }; });
    assert(after.asked.length === 1 && /^A book is being written\. Keep it running in the background, or stop it\?$/.test(after.asked[0]), `asked: "${after.asked[0]}"`);
    assert(after.exists && after.visible === false && !closed, 'Keep running: the window is hidden, the app is still running');
    const bg = logHas((e) => e.kind === 'window-background')[0];
    assert(bg && typeof bg.detail.tray === 'boolean', `logged (tray icon on this desktop: ${bg && bg.detail.tray})`);

    console.log('\n== the run needs a decision: the user is told ==');
    r = await post(port, '/v1/status', token, { app: 'akowe', version: 1, project: { id: 'p1', title: 'The Glass Road' }, run: { id: 'run-e2e', title: 'The Glass Road', status: 'paused', state: 'needs_decision', needs_decision: true, step: 9, steps_total: 16 } });
    const told = await waitUntil(() => logHas((e) => e.kind === 'attention' && /run:run-e2e:needs_you/.test(e.detail.key))[0]);
    assert(told && /needs your decision \(step 9 of 16\)/.test(told.detail.note), `a desktop notification ("${told && told.detail.note}")`);

    console.log('\n== "Stop it and quit" really quits ==');
    await post(port, '/v1/status', token, { app: 'akowe', version: 1, run: { id: 'run-e2e', status: 'running', state: 'working', step: 9, steps_total: 16 } });
    await sleep(700);
    await app.evaluate(({ BaseWindow }) => { global.__answer = 1; const w = BaseWindow.getAllWindows().find((x) => /Automation/.test(x.getTitle())); w.close(); });
    const quit = await waitUntil(() => closed, 20000);
    assert(quit, 'the app quit');
  } finally {
    if (!closed) await app.close().catch(() => {});
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  process.exit(state.failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
