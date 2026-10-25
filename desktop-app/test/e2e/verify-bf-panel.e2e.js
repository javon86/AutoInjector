'use strict';
// verify-bf-panel.e2e.js — acceptance look at AutoInjector's own window with the Akọwe panel: launch the REAL
// Electron app (xvfb), point it at a running Akọwe (BF_URL + BF_TOKEN), press "🔗 Connect Akọwe" like the
// author, finish the pairing the way Akọwe's #/pair page does, and screenshot the panel in each state.
//   xvfb-run -a env BF_URL=http://127.0.0.1:PORT/ BF_TOKEN=... SHOTS=dir node test/e2e/verify-bf-panel.e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { makeAsserts } = require('./helpers');
const electron = require('playwright')._electron;

const BF_URL = String(process.env.BF_URL || '').replace(/\/$/, '');
const BF_TOKEN = process.env.BF_TOKEN || '';
const SHOTS = process.env.SHOTS || path.join(__dirname, '__screenshots__');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function bf(method, p, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(BF_URL + p);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname, method, agent: false,
      headers: Object.assign({ Authorization: `Bearer ${BF_TOKEN}` }, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) }, (res) => {
      const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString()); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

async function main() {
  const { assert, state } = makeAsserts();
  fs.mkdirSync(SHOTS, { recursive: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-home-'));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-nobf-'));
  const port = await freePort();
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], cwd: path.join(__dirname, '..', '..'),
    env: Object.assign({}, process.env, { HOME: home, AUTOINJECTOR_AKOWE_PORT: String(port), AUTOINJECTOR_AKOWE_APP_URL: `${BF_URL}/api/ping`,
      AUTOINJECTOR_AKOWE_DIR: empty, AUTOINJECTOR_AKOWE_SERVER: '0', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }),
  });
  const shotsTaken = [];
  try {
    let controls = null;
    for (let i = 0; i < 100 && !controls; i++) {
      for (const w of app.windows()) { try { if (await w.$('#btn-bf-connect')) controls = w; } catch (_) {} }
      if (!controls) await sleep(400);
    }
    assert(!!controls, 'control panel with the Akọwe panel appears');
    if (!controls) return 1;
    await controls.setViewportSize({ width: 1366, height: 860 }).catch(() => {});
    const errors = [];
    controls.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    controls.on('pageerror', (e) => errors.push(String(e)));
    await app.evaluate(({ shell }) => { global.__opened = []; shell.openExternal = async (u) => { global.__opened.push(String(u)); }; });
    const shot = async (name) => {
      const f = path.join(SHOTS, `${name}.png`);
      await controls.screenshot({ path: f });
      const panel = await controls.$('.bf-panel');
      if (panel) await panel.screenshot({ path: path.join(SHOTS, `${name}_panel.png`) }).catch(() => {});
      shotsTaken.push(f);
    };
    await sleep(2500);
    await shot('ai_01_bf_off');
    const panelText = async () => (await controls.$eval('.bf-panel', (e) => e.innerText)).replace(/\s+\n/g, '\n');
    console.log('--- panel (off):\n' + (await panelText()).slice(0, 600));
    await controls.click('#btn-bf-connect');
    let link = null;
    for (let i = 0; i < 40 && !link; i++) { link = (await app.evaluate(() => global.__opened)).find((u) => /#\/pair\?code=/.test(u)); if (!link) await sleep(250); }
    assert(!!link, `Connect opens Akọwe's pairing link (${link})`);
    await sleep(500);
    await shot('ai_02_bf_waiting');
    console.log('--- panel (waiting):\n' + (await panelText()).slice(0, 600));
    if (link) {
      const m = /code=([A-Za-z0-9]+)&bridge=([^&]+)/.exec(link);
      const pr = await bf('POST', '/api/slots/pair-autoinjector', { code: m[1], bridge_url: decodeURIComponent(m[2]) });
      assert(pr.status === 200 && pr.json && pr.json.connected, `Akọwe pairs with the real app's bridge (HTTP ${pr.status}; slots ${JSON.stringify((pr.json || {}).slots || []).slice(0, 300)})`);
      let txt = '';
      for (let i = 0; i < 40; i++) { txt = await panelText(); if (/Connected/i.test(await controls.$eval('#bf-status', (e) => e.textContent))) break; await sleep(500); }
      await sleep(1500);
      await shot('ai_03_bf_connected');
      console.log('--- panel (connected):\n' + txt.slice(0, 1500));
      assert(/Connected/i.test(await controls.$eval('#bf-status', (e) => e.textContent)), 'the panel says Connected');
      // expand details if collapsed
      try { await controls.click('#bf-title'); await sleep(800); await shot('ai_04_bf_toggled'); } catch (_) {}
      const over = await controls.evaluate(() => {
        const p = document.querySelector('.bf-panel'); const W = p.getBoundingClientRect().right; const out = [];
        for (const e of p.querySelectorAll('*')) { const r = e.getBoundingClientRect(); if (r.width && r.right > W + 1) out.push(`${e.tagName}#${e.id}.${String(e.className).slice(0, 20)} +${Math.round(r.right - W)}px`); }
        return out.slice(0, 10);
      });
      assert(over.length === 0, `nothing in the Akọwe panel sticks out of it at 1366 px (${over.join('; ')})`);
    }
    assert(errors.length === 0, `no console errors in the control panel (${errors.slice(0, 3).join(' | ')})`);
    console.log('screenshots:', shotsTaken.join(', '));
  } finally {
    await app.close().catch(() => {});
  }
  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  return state.failed ? 1 : 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
