'use strict';
// akowe-oneapp.e2e.js — one app, one launcher: launch the REAL Electron app and check that
// AutoInjector starts the REAL Akọwe server from this repo (../akowe, `python -m akowe
// --no-browser`), that the 📖 Akọwe tab shows the signed-in Akọwe workspace inside
// AutoInjector's own window, that it pops out and comes back, that Akọwe was paired with the
// bridge by itself (no Connect press), and that quitting AutoInjector stops the server.
//   xvfb-run -a node test/e2e/akowe-oneapp.e2e.js
// Env: AKOWE_E2E_PYTHON (default python3) — a Python 3.10+ with jsonschema;
//      SHOTS=<dir> also saves screenshots of the whole screen (needs ImageMagick `import`).
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { execFileSync } = require('child_process');
const { makeAsserts, APP_DIR } = require('./helpers');
const electron = require('playwright')._electron;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.SHOTS || '';
function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function ping(port) {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/api/ping', agent: false, timeout: 1500 }, (res) => {
      const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString())); } catch (_) { resolve(null); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
  });
}
async function until(fn, ms, every = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(every); }
  return null;
}
function screen(name) {
  if (!SHOTS || !process.env.DISPLAY) return;
  try { fs.mkdirSync(SHOTS, { recursive: true }); execFileSync('import', ['-window', 'root', path.join(SHOTS, `${name}.png`)], { timeout: 15000 }); console.log(`  (screenshot ${name}.png)`); }
  catch (e) { console.log(`  (no screenshot: ${String(e.message || e).slice(0, 80)})`); }
}

async function main() {
  const { assert, state } = makeAsserts();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-oneapp-home-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-oneapp-akowe-'));
  const fake = 'file://' + path.join(APP_DIR, 'test', 'fixtures', 'fake-chat.html');
  const bridgePort = await freePort();
  const t0 = Date.now();
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], cwd: APP_DIR,
    env: Object.assign({}, process.env, {
      HOME: home, AKOWE_DATA: data, AUTOINJECTOR_AKOWE_SERVER: '1', AUTOINJECTOR_AKOWE_PYTHON: process.env.AKOWE_E2E_PYTHON || 'python3',
      AUTOINJECTOR_AKOWE_PORT: String(bridgePort), AUTOINJECTOR_CHECKIN: '0', AUTOINJECTOR_BRIDGE: '0',
      AUTOINJECTOR_SITE_URL_CHATGPT: fake, AUTOINJECTOR_SITE_URL_CLAUDE: fake, AUTOINJECTOR_SITE_URL_GEMINI: fake,
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    }),
  });
  let port = null;
  try {
    const controls = await until(async () => { for (const w of app.windows()) { if (await w.$('#tab-app-akowe').catch(() => null)) return w; } return null; }, 40000, 400);
    assert(!!controls, 'the control panel with the 📖 Akọwe tab appears');
    if (!controls) return 1;
    assert(await controls.isVisible('#up-zone-compose'), 'AutoInjector itself is usable right away (its startup does not wait for Akọwe)');

    console.log('\n== AutoInjector starts the real Akọwe server ==');
    const st = await until(async () => { const s = await controls.evaluate(() => window.api.akoweServerStatus()); return s && (s.phase === 'running' || s.phase === 'failed') ? s : null; }, 90000, 300);
    assert(st && st.phase === 'running', `the Akọwe server is running (${st && st.phase}${st && st.error ? ' ' + st.error + ': ' + st.message : ''}) after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (!st || st.phase !== 'running') return 1;
    port = st.port;
    assert(st.owned === true && st.hasToken === true, 'started by AutoInjector itself, signed in (token read from its start line)');
    const p = await ping(port);
    assert(p && p.app === 'akowe', `GET /api/ping on 127.0.0.1:${port} answers app=akowe (v${p && p.version})`);
    assert(!JSON.stringify(st).includes('token='), 'the status the window gets has no token');

    console.log('\n== 📖 Akọwe tab: the workspace inside AutoInjector\'s window ==');
    await controls.click('#tab-app-akowe');
    assert(await controls.evaluate(() => document.body.dataset.appTab === 'akowe' && !document.getElementById('akowe-tab').hidden), 'the Akọwe tab is selected');
    const page = await until(async () => app.windows().find((w) => { try { return w.url().startsWith(`http://127.0.0.1:${port}/`); } catch (_) { return false; } }), 30000, 300);
    assert(!!page, 'a view inside the app loads Akọwe from the local server');
    if (!page) return 1;
    const h1 = await page.waitForSelector('main h1, h1', { state: 'visible', timeout: 30000 }).then((e) => e.textContent()).catch(() => null);
    assert(!!h1 && !/start link/i.test(h1), `the workspace is shown, signed in (h1 "${h1}")`);
    assert(!/token=/.test(page.url()), 'the token is gone from the address after loading');
    const vis = await until(() => page.evaluate(() => (document.visibilityState === 'visible' && innerWidth > 300 && innerHeight > 200 ? { w: innerWidth, h: innerHeight } : null)), 10000, 250);
    assert(!!vis, `it is laid into the window and visible (${vis ? vis.w + '×' + vis.h : 'hidden'})`);
    const shown = await until(async () => { const s = await controls.evaluate(() => window.api.akoweServerStatus()); return s.view && s.view.shown; }, 5000, 200);
    assert(!!shown, 'the window reports the Akọwe view as shown over the tab');
    await sleep(800);
    screen('akowe-tab-inside-autoinjector');

    console.log('\n== navigation stays on the local server ==');
    await app.evaluate(({ shell }) => { global.__opened = []; shell.openExternal = async (u) => { global.__opened.push(String(u)); }; });
    await page.evaluate(() => { const a = document.createElement('a'); a.href = 'https://example.com/elsewhere'; a.id = 'ext-test-link'; a.textContent = 'x'; document.body.appendChild(a); a.click(); });
    const opened = await until(async () => (await app.evaluate(() => global.__opened)).find((u) => /example\.com/.test(u)), 5000, 200);
    assert(!!opened, 'an outside link opens in the browser');
    assert(page.url().startsWith(`http://127.0.0.1:${port}/`), 'and the Akọwe view stays on Akọwe');

    console.log('\n== paired with the bridge by itself (no Connect press) ==');
    const conn = await until(async () => { const s = await controls.evaluate(() => window.api.akoweStatus({ panelOpen: true })); return s && s.connection && s.connection.paired ? s : null; }, 30000, 500);
    assert(!!conn, 'Akọwe paired with AutoInjector\'s bridge automatically');
    assert(conn && conn.enabled && conn.listening, 'the bridge was turned on for it');

    console.log('\n== pop out and back ==');
    await controls.click('#btn-akowe-popout');
    const popped = await until(async () => { const s = await controls.evaluate(() => window.api.akoweServerStatus()); return s.view && s.view.popped; }, 8000, 200);
    assert(!!popped, 'Akọwe pops out to its own window');
    assert(await controls.evaluate(() => /own window/.test(document.getElementById('akowe-notice').textContent)), 'the tab says where Akọwe is and offers to bring it back');
    await sleep(600);
    screen('akowe-popped-out');
    await controls.click('#btn-akowe-popout');
    const back = await until(async () => { const s = await controls.evaluate(() => window.api.akoweServerStatus()); return s.view && !s.view.popped; }, 8000, 200);
    assert(!!back, 'and comes back into the tab');
    const vis2 = await until(() => page.evaluate(() => document.visibilityState === 'visible' && innerWidth > 300), 8000, 250);
    assert(!!vis2 && page.url().startsWith(`http://127.0.0.1:${port}/`), 'still showing Akọwe in the window');

    await controls.click('#tab-app-main');
    const hidden = await until(async () => { const s = await controls.evaluate(() => window.api.akoweServerStatus()); return s.view && s.view.loaded && !s.view.shown; }, 5000, 200);
    assert(!!hidden, 'switching back to 🤖 AutoInjector hides the Akọwe view');
    screen('autoinjector-tab');
  } finally {
    await app.close().catch(() => {});
  }
  if (port) {
    const gone = await until(async () => !(await ping(port)), 10000, 300);
    assert(!!gone, 'quitting AutoInjector stopped the Akọwe server it started');
  }

  console.log('\n== no Python: a clear notice, the rest of AutoInjector works ==');
  const app2 = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], cwd: APP_DIR,
    env: Object.assign({}, process.env, {
      PATH: '/nonexistent', HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'ai-oneapp-nopy-')), AKOWE_DATA: data, AUTOINJECTOR_AKOWE_SERVER: '1',
      AUTOINJECTOR_AKOWE_PYTHON: '', PYTHON: '', AKOWE_PORT: String(await freePort()),
      AUTOINJECTOR_AKOWE_PORT: String(bridgePort), AUTOINJECTOR_CHECKIN: '0', AUTOINJECTOR_BRIDGE: '0',
      AUTOINJECTOR_SITE_URL_CHATGPT: fake, AUTOINJECTOR_SITE_URL_CLAUDE: fake, AUTOINJECTOR_SITE_URL_GEMINI: fake,
    }),
  });
  try {
    const c2 = await until(async () => { for (const w of app2.windows()) { if (await w.$('#tab-app-akowe').catch(() => null)) return w; } return null; }, 40000, 400);
    assert(!!c2, 'the app starts without Python');
    if (c2) {
      const s2 = await until(async () => { const s = await c2.evaluate(() => window.api.akoweServerStatus()); return s && s.phase === 'failed' ? s : null; }, 40000, 300);
      assert(s2 && s2.error === 'NO_PYTHON' && /python\.org\/downloads/.test(s2.message), `Akọwe says it needs Python, with the link (${s2 && s2.error})`);
      await c2.click('#tab-app-akowe');
      assert(await c2.isVisible('#btn-akowe-getpython') && await c2.isVisible('#btn-akowe-retry'), 'the tab offers ⬇ Get Python and ↻ Try again');
      assert(await c2.evaluate(() => document.getElementById('akowe-tab-dot').dataset.tone === 'error'), 'the tab dot turns red');
      await sleep(700);
      screen('akowe-no-python');
      await c2.click('#tab-app-main');
      assert(await c2.isVisible('#up-zone-compose') && await c2.isVisible('#btn-bf-connect'), 'the rest of AutoInjector is there and works');
    }
  } finally { await app2.close().catch(() => {}); }
  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  return state.failed ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
