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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
