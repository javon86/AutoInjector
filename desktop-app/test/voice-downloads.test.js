'use strict';
// test/voice-downloads.test.js — voice-downloads.js against a fake download server: both files arrive (the small
// settings file first) with progress; a dropped connection is retried and RESUMES (Range); ✕ cancel keeps the .part
// and the next ⬇ carries on from it; a good file already there is kept, a damaged one is left alone (never
// overwritten); broken settings (.json) or a short file never become a voice; 404 / plain http to another computer /
// two downloads of one voice at once are refused in plain words; a sample is fetched in memory with a size cap.
// Run: node test/voice-downloads.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createVoiceDownloads } = require('../voice-downloads');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

const BIG = Buffer.alloc(300 * 1024, 7); for (let i = 0; i < BIG.length; i += 997) BIG[i] = i % 251;
const JSON_OK = Buffer.from(JSON.stringify({ audio: { sample_rate: 22050 }, espeak: { voice: 'en-us' }, pad: 'x'.repeat(600) }));
const srv = { drops: 0, slowMs: 0, log: [], badJson: false };

function startServer() {
  const server = http.createServer((req, res) => {
    const url = req.url;
    srv.log.push({ url, range: req.headers.range || '' });
    if (url === '/redir.onnx') { res.writeHead(302, { Location: '/v.onnx' }); return res.end(); }
    if (url === '/v.onnx.json') { const b = srv.badJson ? Buffer.from('<html>oops</html>'.padEnd(600, ' ')) : JSON_OK; res.writeHead(200, { 'Content-Length': b.length }); return res.end(b); }
    if (url === '/sample.mp3') { const b = Buffer.alloc(2000, 1); res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': b.length }); return res.end(b); }
    if (url === '/huge.mp3') { const b = Buffer.alloc(50000, 1); res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': b.length }); return res.end(b); }
    if (url === '/v.onnx') {
      let start = 0;
      const m = /bytes=(\d+)-/.exec(req.headers.range || '');
      if (m) start = Number(m[1]);
      if (start >= BIG.length) { res.writeHead(416); return res.end(); }
      const body = BIG.subarray(start);
      res.writeHead(m ? 206 : 200, m ? { 'Content-Length': body.length, 'Content-Range': `bytes ${start}-${BIG.length - 1}/${BIG.length}` } : { 'Content-Length': body.length });
      if (srv.drops > 0) { srv.drops--; res.write(body.subarray(0, 64 * 1024)); return setTimeout(() => res.destroy(), 20); }
      if (srv.slowMs) { let i = 0; const t = setInterval(() => { if (res.destroyed) return clearInterval(t); const c = body.subarray(i, i + 16 * 1024); i += c.length; if (!c.length) { clearInterval(t); res.end(); } else res.write(c); }, srv.slowMs); return; }
      return res.end(body);
    }
    res.writeHead(404); res.end('no');
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

(async () => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'better-voices-dl-'));
  const files = (over = {}) => [
    { name: 'v.onnx', url: `${base}/v.onnx`, bytes: BIG.length, minBytes: 1000, ...over },
    { name: 'v.onnx.json', url: `${base}/v.onnx.json`, minBytes: 500, json: true },
  ];
  const events = [];
  const logs = [];
  const dl = createVoiceDownloads({ emit: (e) => events.push(e), log: (c, d) => logs.push(d), retryDelayMs: 10, progressMs: 0 });

  console.log('# download both files, settings first, with progress');
  let dir = path.join(TMP, 'a');
  let r = await dl.start({ id: 'v1', dir, files: files() });
  assert(r.ok, 'the download finishes');
  assert(fs.readFileSync(path.join(dir, 'v.onnx')).equals(BIG), 'the voice file is complete and exact');
  assert(fs.existsSync(path.join(dir, 'v.onnx.json')), 'its settings file (.onnx.json) is there too');
  assert(!fs.existsSync(path.join(dir, 'v.onnx.part')), 'no .part left behind');
  const urls = srv.log.map((x) => x.url);
  assert(urls.indexOf('/v.onnx.json') < urls.indexOf('/v.onnx'), 'the small settings file is fetched first');
  assert(events.some((e) => e.phase === 'progress' && e.total === BIG.length && e.got > 0), 'progress shows how much of how much');
  assert(events.some((e) => e.phase === 'done' && /Ready/.test(e.message)), 'it says when the voice is ready');
  assert(!JSON.stringify(logs).includes(TMP), 'the log has names and sizes only, never the folder');

  console.log('# a dropped connection is retried and carries on where it stopped');
  dir = path.join(TMP, 'b'); srv.log = []; srv.drops = 1; events.length = 0;
  r = await dl.start({ id: 'v2', dir, files: files() });
  assert(r.ok, 'it still finishes');
  assert(fs.readFileSync(path.join(dir, 'v.onnx')).equals(BIG), 'and the file is exact (no doubled or missing bytes)');
  assert(srv.log.some((x) => x.url === '/v.onnx' && /^bytes=\d+-$/.test(x.range) && x.range !== 'bytes=0-'), 'the retry asks only for the rest (resume)');
  assert(events.some((e) => e.phase === 'retry' && /trying again/.test(e.message)), 'the retry is said in plain words');

  console.log('# redirects are followed (the download site sends you to its file store)');
  dir = path.join(TMP, 'r');
  r = await dl.start({ id: 'vr', dir, files: [{ name: 'v.onnx', url: `${base}/redir.onnx`, bytes: BIG.length }] });
  assert(r.ok && fs.readFileSync(path.join(dir, 'v.onnx')).equals(BIG), 'a redirect still gives the right file');

  console.log('# ✕ cancel keeps what came, the next ⬇ resumes');
  dir = path.join(TMP, 'c'); srv.log = []; srv.slowMs = 5; events.length = 0;
  const p = dl.start({ id: 'v3', dir, files: files() });
  await new Promise((res) => { const t = setInterval(() => { if (events.some((e) => e.id === 'v3' && e.phase === 'progress' && e.got > 40 * 1024)) { clearInterval(t); res(); } }, 5); });
  assert(dl.active().some((a) => a.id === 'v3'), 'it shows as downloading');
  const again = await dl.start({ id: 'v3', dir, files: files() });
  assert(!again.ok && again.error === 'ALREADY_RUNNING', 'the same voice can\'t download twice at once');
  assert(dl.cancel('v3').ok, 'cancel is accepted');
  r = await p;
  assert(!r.ok && r.error === 'CANCELLED' && /carry on/.test(r.message), 'cancel says it can carry on later');
  const partSize = dl.partial(dir, 'v.onnx');
  assert(partSize > 0 && partSize < BIG.length, 'the part already downloaded is kept');
  assert(!fs.existsSync(path.join(dir, 'v.onnx')), 'a cancelled download is never a voice');
  srv.slowMs = 0; srv.log = [];
  r = await dl.start({ id: 'v3', dir, files: files() });
  assert(r.ok && fs.readFileSync(path.join(dir, 'v.onnx')).equals(BIG), 'pressing ⬇ again finishes it, exactly');
  assert(srv.log.some((x) => x.url === '/v.onnx' && x.range === `bytes=${partSize}-`), 'from where it stopped');

  console.log('# never overwrite a file that is already there');
  dir = path.join(TMP, 'd'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'v.onnx'), BIG); srv.log = [];
  r = await dl.start({ id: 'v4', dir, files: files() });
  assert(r.ok && !srv.log.some((x) => x.url === '/v.onnx'), 'a good voice file already there is kept (not fetched again)');
  dir = path.join(TMP, 'e'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'v.onnx'), 'my own file');
  r = await dl.start({ id: 'v5', dir, files: files() });
  assert(!r.ok && r.error === 'FILE_IN_THE_WAY' && /left alone/.test(r.message), 'a damaged one is reported, in plain words');
  assert(fs.readFileSync(path.join(dir, 'v.onnx'), 'utf8') === 'my own file', 'and left exactly as it was');

  console.log('# a broken download never becomes a voice');
  dir = path.join(TMP, 'f'); srv.badJson = true;
  r = await dl.start({ id: 'v6', dir, files: files() });
  srv.badJson = false;
  assert(!r.ok && r.error === 'DAMAGED' && !fs.existsSync(path.join(dir, 'v.onnx.json')), 'settings that are not valid JSON are thrown away');
  assert(!fs.existsSync(path.join(dir, 'v.onnx')), 'and the big file is not fetched for nothing');
  dir = path.join(TMP, 'g');
  r = await dl.start({ id: 'v7', dir, files: [{ name: 'v.onnx', url: `${base}/v.onnx`, bytes: BIG.length + 5 }] });
  assert(!r.ok && !fs.existsSync(path.join(dir, 'v.onnx')), 'a file of the wrong size is not kept');

  console.log('# refused in plain words');
  r = await dl.start({ id: 'v8', dir: path.join(TMP, 'h'), files: [{ name: 'gone.onnx', url: `${base}/gone.onnx` }] });
  assert(!r.ok && r.error === 'HTTP_404' && /isn't on the download site/.test(r.message), '404 -> "isn\'t on the download site any more"');
  r = await dl.start({ id: 'v9', dir: path.join(TMP, 'h'), files: [{ name: 'x.onnx', url: 'http://example.com/x.onnx' }] });
  assert(!r.ok && r.error === 'BAD_NAME', 'plain http to another computer is refused');
  r = await dl.start({ id: 'v10', dir: path.join(TMP, 'h'), files: [{ name: '../evil.onnx', url: `${base}/v.onnx` }] });
  assert(!r.ok && !fs.existsSync(path.join(TMP, 'evil.onnx')), 'a file name with a path in it is refused');

  console.log('# ▶ sample: small, in memory only, capped');
  let s = await dl.fetchSmall(`${base}/sample.mp3`);
  assert(s.ok && s.buffer.length === 2000 && s.mime === 'audio/mpeg', 'a short sample comes back');
  s = await dl.fetchSmall(`${base}/huge.mp3`, 10000);
  assert(!s.ok && s.error === 'TOO_BIG', 'anything bigger than the cap is refused');

  server.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
