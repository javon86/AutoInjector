// test/endpoint-detect.test.js — presets, detect (probe localhost), and test().
// Uses a real stub HTTP server for the "up" case and an unused port for "down".
// Run: node test/endpoint-detect.test.js
const http = require('http');
const ed = require('../endpoint-detect');
let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
function listen(s) { return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port))); }

async function main() {
  console.log('\n== presets give a labelled dropdown per kind ==');
  const ip = ed.presets('image');
  assert(ip.length >= 2 && ip.every((p) => p.label && /^https?:\/\//.test(p.endpoint)), 'image presets carry a label + a full endpoint URL');
  assert(ed.presets('video').length >= 2, 'video presets exist too');
  assert(ip.some((p) => /7860/.test(p.endpoint)), 'the A1111 default (7860) is offered');
  const vpre = ed.presets('video');
  assert(!vpre.some((p) => /comfy/i.test(p.label) || /:8188\b|\/prompt\b/.test(p.endpoint)), 'no ComfyUI video preset (its /prompt API only queues a job, so it can never return a clip)');
  assert(!ed.CANDIDATES.video.some((c) => /:8188\b/.test(c.health)), 'auto-detect never offers ComfyUI as a video backend either');
  assert(!ed.CANDIDATES.image.some((c) => /:8188\b/.test(c.health) || /\/prompt\b/.test(c.endpoint)), 'nor as an image backend (its /prompt only queues a job)');
  const ad = vpre.find((p) => /AnimateDiff/.test(p.label));
  assert(ad && /txt2img/.test(ad.endpoint) && /AnimateDiff extension/.test(ad.label) && /still images/.test(ad.label), 'the AnimateDiff preset says it needs the AnimateDiff extension (else still images)');

  console.log('\n== probe(): up vs down ==');
  const stub = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
  const port = await listen(stub);
  assert((await ed.probe(`http://127.0.0.1:${port}/`)).ok === true, 'a listening server probes ok');
  assert((await ed.probe(`http://127.0.0.1:1/`, 400)).ok === false, 'a dead port probes not-ok (no throw)');

  console.log('\n== detect(): points a candidate at the stub and finds it ==');
  // Redirect the image candidates to our stub via configure() is overkill; instead
  // monkeypatch CANDIDATES for the test to include the live stub.
  ed.CANDIDATES.image.unshift({ label: 'stub', endpoint: `http://127.0.0.1:${port}/gen`, health: `http://127.0.0.1:${port}/health` });
  const d = await ed.detect('image', { timeoutMs: 800 });
  assert(d.ok && d.reachable.some((r) => r.label === 'stub' && r.endpoint === `http://127.0.0.1:${port}/gen`), 'detect() reports the reachable stub backend');
  ed.CANDIDATES.image.shift(); // restore

  console.log('\n== test(): reachable reflects the base host ==');
  const t = await ed.test(`http://127.0.0.1:${port}/sdapi/v1/txt2img`);
  assert(t.reachable === true && t.base === `http://127.0.0.1:${port}`, 'a reachable endpoint → reachable:true, with the base host');
  assert((await ed.test(`http://127.0.0.1:1/x`, { timeoutMs: 400 })).reachable === false, 'an unreachable endpoint → reachable:false');
  assert((await ed.test('')).error === 'NO_URL', 'no url → NO_URL');
  stub.close();

  console.log('\n== OP-14: probe() says WHY it failed, and never waits past its limit ==');
  const net = require('net');
  const tmp = net.createServer(); await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
  const dead = tmp.address().port; await new Promise((r) => tmp.close(r));
  const pr = await ed.probe(`http://127.0.0.1:${dead}/`, 800);
  assert(pr.ok === false && pr.reason === 'refused', 'a closed port → reason "refused" (nothing running there)');
  const tr = await ed.test(`http://127.0.0.1:${dead}/x`, { timeoutMs: 800 });
  assert(tr.reachable === false && tr.reason === 'refused', 'test() passes the reason through');
  // Accepts the connection, starts a response, then trickles one header byte
  // every 100ms and never finishes the headers: the socket is never idle, so
  // only a wall-clock cap stops it.
  const trickle = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.write('HTTP/1.1 200 OK\r\nX-Slow: ');
    const iv = setInterval(() => { try { sock.write('a'); } catch (_) {} }, 100);
    sock.on('close', () => clearInterval(iv));
  });
  await new Promise((r) => trickle.listen(0, '127.0.0.1', r));
  const t0 = Date.now();
  const hr = await ed.probe(`http://127.0.0.1:${trickle.address().port}/`, 400);
  const took = Date.now() - t0;
  assert(hr.ok === false && hr.reason === 'timeout' && took < 1000, `a server that keeps the socket busy but never answers times out at the limit (${took}ms)`);
  trickle.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
