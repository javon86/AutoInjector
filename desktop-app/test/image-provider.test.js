// test/image-provider.test.js — the Stable Diffusion (A1111 txt2img) adapter.
// Spins up a stub SD server returning a base64 PNG and checks settings, guards,
// generate() success + normalization, and error handling. No real SD needed.
// Run: node test/image-provider.test.js
const http = require('http');
const ip = require('../image-provider');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }

// A tiny 1x1 PNG, base64.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function main() {
  console.log('\n== settings + status ==');
  ip.setSettings({ enabled: false, endpoint: '', steps: 20, width: 512, height: 512 });
  let s = ip.status();
  assert(s.configured === false && s.enabled === false, 'status reflects unconfigured/disabled');
  const set = ip.setSettings({ steps: 33, width: 768, height: 640 });
  assert(set.steps === 33 && set.width === 768 && set.height === 640, 'steps/width/height are stored');
  assert(ip.setSettings({ width: -10 }).width === 768, 'a non-positive size is ignored (keeps the last good value)');

  console.log('\n== guards: empty prompt / disabled / no endpoint ==');
  assert((await ip.generate('')).error === 'NEED_PROMPT', 'empty prompt -> NEED_PROMPT');
  assert((await ip.generate('a cat')).error === 'IMAGE_DISABLED', 'disabled -> IMAGE_DISABLED');
  ip.setSettings({ enabled: true, endpoint: '' });
  assert((await ip.generate('a cat')).error === 'NO_ENDPOINT', 'enabled but no endpoint -> NO_ENDPOINT');

  console.log('\n== generate(): posts txt2img and returns the base64 image ==');
  let seenBody = null;
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { seenBody = JSON.parse(body); } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ images: [PNG_B64], info: 'ok' }));
    });
  });
  const port = await listen(server);
  ip.setSettings({ enabled: true, endpoint: `http://127.0.0.1:${port}/sdapi/v1/txt2img`, steps: 12, width: 256, height: 256 });
  const evs = [];
  const r = await ip.generate('a red apple', { onEvent: (e) => evs.push(e.type) });
  assert(r.ok && r.imageBase64 === PNG_B64, 'generate returns the base64 image from the SD server');
  assert(seenBody && seenBody.prompt === 'a red apple' && seenBody.steps === 12 && seenBody.width === 256, 'the prompt + steps + size reached the SD server');
  assert(evs.includes('image-start') && evs.includes('image'), 'generate streams image-start … image events');

  console.log('\n== a data-URI-prefixed image is cleaned to raw base64 ==');
  const server2 = http.createServer((req, res) => { req.resume(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ images: ['data:image/png;base64,' + PNG_B64] })); });
  const port2 = await listen(server2);
  ip.setSettings({ enabled: true, endpoint: `http://127.0.0.1:${port2}/sdapi/v1/txt2img` });
  const r2 = await ip.generate('x');
  assert(r2.ok && r2.imageBase64 === PNG_B64, 'a data:image/png;base64, prefix is stripped');

  console.log('\n== errors: no image + HTTP error ==');
  const server3 = http.createServer((req, res) => { req.resume(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ images: [] })); });
  const port3 = await listen(server3);
  ip.setSettings({ enabled: true, endpoint: `http://127.0.0.1:${port3}/sdapi/v1/txt2img` });
  assert((await ip.generate('x')).error === 'NO_IMAGE', 'an empty images array -> NO_IMAGE');
  const server4 = http.createServer((req, res) => { req.resume(); res.writeHead(500); res.end('boom'); });
  const port4 = await listen(server4);
  ip.setSettings({ enabled: true, endpoint: `http://127.0.0.1:${port4}/sdapi/v1/txt2img` });
  assert((await ip.generate('x')).error === 'HTTP_500', 'a 5xx from the SD server -> HTTP_500');

  server.close(); server2.close(); server3.close(); server4.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
