'use strict';
// chatgpt-image.e2e.js — ChatGPT as the second image engine in the REAL app (xvfb), with the
// ChatGPT pane pointed at test/fixtures/fake-chat.html?image=ok (a placeholder, a blurred
// preview, then a real PNG drawn on a canvas and served as a blob: URL; a 28 px avatar in
// every turn). Checks:
//   • 🎨 Images → Engine: ChatGPT → Generate: "ChatGPT is drawing… N s", the picture is saved
//     as a real 512×768 PNG with its sidecar, shown under Result;
//   • Reference views → Side: the exact framing is typed into ChatGPT;
//   • a message for ChatGPT sent while it draws waits until the picture is in (the pane is held);
//   • the image turn is never relayed / put in the conversation;
//   • the service bridge: POST /image/request {engine:"chatgpt", purpose:"view", view:"back"}
//     and GET /image/backend {engines:{sd, chatgpt}}; a refusal page → 422 IMAGE_REFUSED.
// Screenshots go to SHOTS (default test/e2e/__screenshots__).
//   xvfb-run -a node test/e2e/chatgpt-image.e2e.js
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { makeAsserts, APP_DIR } = require('./helpers');
const { sniff } = require('../../chatgpt-image');

let electron;
try { electron = require('playwright')._electron; } catch (_) { console.error('needs playwright'); process.exit(2); }

const SHOTS = process.env.SHOTS || path.join(__dirname, '__screenshots__');
const FIX = path.join(__dirname, '..', 'fixtures', 'fake-chat.html');
const url = (q) => `file://${FIX}?${q}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() { return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
function req(port, method, p, body, token) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: Object.assign({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
    });
    r.setTimeout(300000, () => { r.destroy(); resolve({ status: 0, error: 'TIMEOUT' }); });
    r.on('error', (e) => resolve({ status: 0, error: String(e) }));
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  const { assert, state } = makeAsserts();
  fs.mkdirSync(SHOTS, { recursive: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-cg-home-'));
  const port = await freePort();
  const TOKEN = 'e2e-chatimg-token';
  const t0 = Date.now() - 1000;
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], cwd: APP_DIR,
    env: Object.assign({}, process.env, {
      HOME: home, AUTOINJECTOR_BRIDGE_PORT: String(port), AUTOINJECTOR_BRIDGE_TOKEN: TOKEN, AUTOINJECTOR_CHECKIN: '0', AUTOINJECTOR_PANE_ZOOM: '0.8',
      AUTOINJECTOR_SITE_URL_CHATGPT: url('site=chatgpt&quirks=none&image=ok&avatar=1&imgdelay=2500&speed=0.4'),
      AUTOINJECTOR_SITE_URL_CLAUDE: url('site=claude&quirks=none&speed=0.4'),
      AUTOINJECTOR_SITE_URL_GEMINI: url('site=gemini&quirks=none&speed=0.4'),
      AUTOINJECTOR_PROBE_DELAY_MS: '1000', AUTOINJECTOR_CHATIMG_POLL_MS: '300', AUTOINJECTOR_CHATIMG_SETTLE_MS: '800',
      AUTOINJECTOR_AKOWE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ai-nobf-')), AUTOINJECTOR_AKOWE_SERVER: '0', AUTOINJECTOR_SD_AUTOSTART: '0',
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    }),
  });
  const made = [];
  try {
    let c = null;
    for (let i = 0; i < 100 && !c; i++) { for (const w of app.windows()) { try { if (await w.$('#tab-app-images')) c = w; } catch (_) {} } if (!c) await sleep(400); }
    assert(!!c, 'the control panel appears');
    if (!c) return;
    await c.setViewportSize({ width: 1366, height: 900 }).catch(() => {});
    const errors = []; c.on('pageerror', (e) => errors.push(String(e)));
    const inPane = (site, js) => app.evaluate(async ({ webContents }, a) => {
      const wc = webContents.getAllWebContents().find((w) => /fake-chat\.html/.test(w.getURL()) && w.getURL().includes(`site=${a.site}`));
      return wc ? wc.executeJavaScript(a.js, true) : null;
    }, { site, js });
    const until = async (fn, ms, step = 250) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); } return null; };

    const ready = await until(async () => { const s = await c.evaluate(() => window.api.sd.chatgptStatus()); return s && s.ready ? s : null; }, 30000);
    assert(!!ready, 'the ChatGPT image engine says the pane is ready');

    console.log('\n== 🎨 Images → Engine: ChatGPT → Generate ==');
    await c.click('#tab-app-images');
    await c.waitForSelector('#images-tab:not([hidden])', { timeout: 10000 });
    await c.selectOption('#sd-engine', 'chatgpt');
    await c.waitForFunction(() => /ChatGPT is ready/.test(document.getElementById('sd-engine-note').textContent), null, { timeout: 10000 }).catch(() => {});
    assert(/ChatGPT is ready/.test(await c.textContent('#sd-engine-note')), 'the engine note says ChatGPT is ready');
    await c.fill('#sd-prompt', 'a lighthouse keeper with a lantern, oil painting');
    await c.click('#btn-sd-generate');
    const drawing = await until(async () => { const t = await c.textContent('#sd-msg'); return /ChatGPT is (drawing|finishing)…( \d+ s)?/.test(t) ? t : null; }, 15000, 150);
    assert(!!drawing, `progress while ChatGPT works: "${drawing}"`);
    await c.screenshot({ path: path.join(SHOTS, 'chatimg-01-drawing.png') }).catch(() => {});
    // a message for ChatGPT sent now waits for the picture (the pane is held)
    const composeAt = Date.now();
    const composeP = c.evaluate(() => window.api.sendCompose('Hello ChatGPT, a normal message.', ['chatgpt']));
    await c.waitForFunction(() => /drawn by ChatGPT/.test(document.getElementById('sd-msg').textContent), null, { timeout: 60000 }).catch(() => {});
    const done = await c.textContent('#sd-msg');
    assert(/✔ 1 picture saved — drawn by ChatGPT/.test(done), `Generate → "${done.split('\n')[0]}"`);
    const src = await c.getAttribute('#sd-preview', 'src');
    const file = src ? decodeURIComponent(new URL(src).pathname).replace(/^\/([A-Za-z]:)/, '$1') : '';
    if (file) made.push(file);
    const sn = file && fs.existsSync(file) ? sniff(fs.readFileSync(file)) : {};
    assert(sn.type === 'png' && sn.width === 512 && sn.height === 768, `the picture from the page is saved as a real 512×768 PNG (${path.basename(file)}, ${JSON.stringify(sn)})`);
    const rec = file ? JSON.parse(fs.readFileSync(file.replace(/\.png$/, '.json'), 'utf8')) : {};
    assert(rec.engine === 'chatgpt' && /Create an image: a lighthouse keeper/.test(rec.chatgptPrompt) && rec.from === 'images-tab', 'its sidecar says ChatGPT made it, with the exact request');
    await c.screenshot({ path: path.join(SHOTS, 'chatimg-02-result.png') }).catch(() => {});
    await composeP;
    const posted = await until(async () => { const d = await inPane('chatgpt', 'window.__fake.dump()'); return d && d.posted.length >= 2 ? d : null; }, 20000);
    const imgReply = posted && posted.replies.find((r) => r.image);
    const hello = posted && posted.posted.find((p) => /Hello ChatGPT/.test(p.text));
    assert(!!(imgReply && hello && hello.at >= imgReply.finishedAt), `the normal message waited until the picture was in (typed ${hello && imgReply ? hello.at - imgReply.finishedAt : '?'} ms after it; asked ${Date.now() - composeAt} ms ago)`);
    const tr = await c.evaluate(() => window.api.getState()).catch(() => null);
    const chatTurns = ((tr && tr.transcript) || []).filter((t) => t.site === 'chatgpt').map((t) => t.text).join(' ');
    assert(!/Creating image/.test(chatTurns), 'the image turn never reaches the conversation (held, not relayed)');

    console.log('\n== Reference views → Side ==');
    await c.click('#sd-sec-views > summary');
    await c.fill('#sd-rv-appearance', 'a wiry courier in a yellow rain cape');
    await c.click('#btn-sd-rv-side');
    await c.waitForFunction(() => /drawn by ChatGPT/.test(document.getElementById('sd-msg').textContent) && !document.getElementById('btn-sd-generate').disabled, null, { timeout: 60000 }).catch(() => {});
    const d2 = await inPane('chatgpt', 'window.__fake.dump()');
    const sidePost = d2 && d2.posted.map((p) => p.text).find((t) => /Framing:/.test(t));
    assert(!!sidePost && /a wiry courier in a yellow rain cape/.test(sidePost) && /seen exactly from the side \(profile\), plain neutral light-grey studio background, even soft lighting, no text/.test(sidePost), 'the side framing is typed into ChatGPT');
    const src2 = await c.getAttribute('#sd-preview', 'src');
    const f2 = src2 ? decodeURIComponent(new URL(src2).pathname) : '';
    if (f2) made.push(f2);
    assert(/view-side-/.test(path.basename(f2)) && fs.existsSync(f2), `saved as ${path.basename(f2)}`);
    await c.screenshot({ path: path.join(SHOTS, 'chatimg-03-reference-view.png') }).catch(() => {});

    console.log('\n== the service bridge (Akọwe\'s contract) ==');
    let r = await req(port, 'GET', '/image/backend', null, TOKEN);
    assert(r.status === 200 && r.json.engines && r.json.engines.chatgpt.ready === true && r.json.engines.sd.connected === false, `GET /image/backend → engines ${JSON.stringify(r.json && r.json.engines)}`);
    r = await req(port, 'POST', '/image/request', { purpose: 'view', view: 'back', appearance: 'a tall woman in a red cloak', from: 'akowe' }, TOKEN);
    assert(r.status === 200 && r.json.ok && r.json.engine === 'chatgpt' && r.json.view === 'back' && r.json.paths.length === 1 && fs.existsSync(r.json.paths[0]), `POST /image/request (engine auto, no SD app) → ChatGPT, view back (${r.status} ${r.json && (r.json.error || r.json.paths[0])})`);
    if (r.json && r.json.paths) made.push(...r.json.paths);
    await app.evaluate(({ webContents }, u) => { const wc = webContents.getAllWebContents().find((w) => /site=chatgpt/.test(w.getURL())); if (wc) wc.loadURL(u); }, url('site=chatgpt&quirks=none&image=refuse&imgdelay=800&speed=0.4'));
    await sleep(2500);
    r = await req(port, 'POST', '/image/request', { prompt: 'something it will not draw', engine: 'chatgpt' }, TOKEN);
    assert(r.status === 422 && r.json.error === 'IMAGE_REFUSED' && /content policy/.test(r.json.message) && r.json.hint, `a refusal → 422 IMAGE_REFUSED with ChatGPT's reason (${r.status} ${r.json && r.json.message})`);
    r = await req(port, 'POST', '/image/request', { prompt: 'x', engine: 'sd' }, TOKEN);
    assert(r.status === 503 && r.json.error === 'SD_NOT_CONNECTED', 'engine sd with no SD app → 503 SD_NOT_CONNECTED');
    assert(!errors.length, `no page errors in the control panel (${errors.slice(0, 2).join(' | ')})`);
  } finally {
    await app.close().catch(() => {});
    for (const f of made) for (const g of [f, f.replace(/\.(png|jpe?g)$/i, '.json')]) { try { fs.unlinkSync(g); } catch (_) {} }
    if (made[0]) { // anything else this run saved
      const dir = path.dirname(made[0]);
      try { for (const n of fs.readdirSync(dir)) { const f = path.join(dir, n); if (/^(chatgpt|view|sheet|portrait)-.*\.(png|jpg|json)$/.test(n) && fs.statSync(f).mtimeMs >= t0) fs.unlinkSync(f); } } catch (_) {}
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  process.exit(state.failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
