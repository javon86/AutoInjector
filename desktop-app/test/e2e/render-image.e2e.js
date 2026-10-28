'use strict';
// test/e2e/render-image.e2e.js — POST /render/image in REAL Electron (render-image.js + service-bridge.js):
// an SVG becomes a 1600 × 2560 JPEG (and a PNG) through the token-protected bridge, with the right colours where
// they belong, and a picture inside the SVG that points at the network is NOT fetched.
// Run: xvfb-run -a node test/e2e/render-image.e2e.js   (node re-launches itself inside Electron)
const path = require('path');

if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  const electronBin = require('electron');
  const r = spawnSync(electronBin, ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', __filename], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, env: Object.assign({}, process.env, { ELECTRON_ENABLE_LOGGING: '' }) });
  const out = String(r.stdout || '');
  process.stdout.write(out);
  if (r.status !== 0 || !/ 0 failed/.test(out)) { process.stderr.write(String(r.stderr || '').split('\n').filter((l) => !/dbus|Fontconfig|NODE_OPTION/.test(l)).join('\n')); process.exit(1); }
  process.exit(0);
}

const http = require('http');
const electron = require('electron');
const { app } = electron;
const renderImage = require(path.join(__dirname, '..', '..', 'render-image'));
const { createServiceBridge } = require(path.join(__dirname, '..', '..', 'service-bridge'));

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

function post(port, token, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const rq = http.request({ host: '127.0.0.1', port, path: '/render/image', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: `Bearer ${token}` } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch (e) { reject(e); } });
    });
    rq.on('error', reject); rq.write(data); rq.end();
  });
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  // a network request from the page would show up here (it must not happen)
  let netHits = 0;
  const trap = http.createServer((q, s) => { netHits++; s.end('x'); });
  await new Promise((r) => trap.listen(0, '127.0.0.1', r));
  const trapUrl = `http://127.0.0.1:${trap.address().port}/x.png`;

  const bridge = createServiceBridge({ renderer: renderImage.createRenderer({ makeWindow: renderImage.electronWindowFactory(electron) }) });
  const st = await bridge.start({ port: 0, token: 'e2e-token' });
  try {
    console.log('\n== 🖨 SVG → JPEG / PNG in real Chromium ==');
    const svg = '<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 432 691.2">'
      + '<rect width="432" height="345.6" fill="#cc0000"/><rect y="345.6" width="432" height="345.6" fill="#0000cc"/>'
      + `<image href="${trapUrl}" x="0" y="0" width="20" height="20"/>`
      + '<image href="data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#00cc00"/></svg>').toString('base64') + '" x="166" y="300" width="100" height="100"/>'
      + '<text x="216" y="120" font-size="40" text-anchor="middle" fill="#ffffff">TITLE</text></svg>';
    const r = await post(st.port, 'e2e-token', { svg, width: 1600, height: 2560, format: 'jpeg', quality: 92 });
    assert(r.status === 200 && r.json.ok && r.json.mime === 'image/jpeg', `the bridge answers 200 with a JPEG (${r.json.bytes} bytes)`);
    const buf = Buffer.from(r.json.imageBase64 || '', 'base64');
    assert(buf.slice(0, 3).toString('hex') === 'ffd8ff', 'the bytes are a JPEG');
    const img = electron.nativeImage.createFromBuffer(buf);
    const sz = img.getSize();
    assert(sz.width === 1600 && sz.height === 2560, `it is exactly 1600 × 2560 (${sz.width} × ${sz.height})`);
    const bm = img.toBitmap();
    const px = (x, y) => { const i = (y * sz.width + x) * 4; return [bm[i + 2], bm[i + 1], bm[i]]; };
    const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 40);
    assert(near(px(800, 600), [204, 0, 0]), 'the top half is red');
    assert(near(px(800, 2400), [0, 0, 204]), 'the bottom half is blue (the SVG fills the whole height, not cut at the screen size)');
    assert(near(px(800, 1270), [0, 204, 0]), 'an embedded data: URI picture is drawn');
    assert(netHits === 0, 'a picture pointing at the network is not fetched');
    const p = await post(st.port, 'e2e-token', { svg, width: 400, height: 640, format: 'png' });
    const pb = Buffer.from(p.json.imageBase64 || '', 'base64');
    assert(p.status === 200 && pb.slice(1, 4).toString() === 'PNG' && electron.nativeImage.createFromBuffer(pb).getSize().width === 400, 'format png gives a 400 × 640 PNG');
    const bad = await post(st.port, 'e2e-token', { svg, width: 9000, height: 100 });
    assert(bad.status === 400 && bad.json.error === 'INVALID_PARAM', 'a size over the limit is refused');
  } catch (e) {
    assert(false, `crashed: ${(e && e.stack) || e}`);
  } finally {
    await bridge.stop();
    trap.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  app.exit(failed ? 1 : 0);
});
