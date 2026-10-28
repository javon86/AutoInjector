// test/llm-setup.test.js — 🎩 Alfred's AI: one-button setup + check (llm-setup.js), offline.
// A fake Ollama HTTP server (version / tags / pull NDJSON / delete / chat with + without tools), a fake
// installer download server (Range resume, a dropped connection, 404s), a fake spawn (installer, tar,
// ditto, `ollama serve`) and a fake execFile (`ollama --version`). Covers: finding Ollama (PATH, standard
// places, the app's own folder) and making ollama-manager use it without a restart, installing on
// Windows / macOS / Linux, start/stop, pulling with real % progress, cancel, disk checks, remove, use,
// every check row + its fix, setupAll end to end (twice = harmless), uncensored, the catalog path, busy,
// plain-English errors, and that a secret never reaches a log or an event.
// Run: node test/llm-setup.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { EventEmitter } = require('events');
const om = require('../ollama-manager');
const lib = require('../llm-setup');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() { return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
const GB = 1024 ** 3;

// ------------------------------------------------------------------ fake Ollama (shared with test/e2e/llm-setup.e2e.js)
const { fakeOllama } = require('./fixtures/fake-ollama');

// ------------------------------------------------------------------ fake download server
function fakeDownloads() {
  const files = { 'OllamaSetup.exe': Buffer.alloc(300 * 1024, 7), 'ollama-linux-amd64.tgz': Buffer.alloc(200 * 1024, 3), 'Ollama-darwin.zip': Buffer.alloc(150 * 1024, 5) };
  const st = { requests: [], dropFirst: false, dropped: false };
  const server = http.createServer((req, res) => {
    const name = req.url.replace(/^\/+/, '');
    st.requests.push({ name, range: req.headers.range || null });
    const buf = files[name];
    if (!buf) { res.writeHead(404); return res.end('nope'); }
    let start = 0;
    const m = /bytes=(\d+)-/.exec(req.headers.range || '');
    if (m) start = Number(m[1]);
    const part = buf.slice(start);
    res.writeHead(m ? 206 : 200, { 'Content-Length': part.length, 'Content-Type': 'application/octet-stream' });
    if (st.dropFirst && !st.dropped) { st.dropped = true; res.write(part.slice(0, 100 * 1024)); setTimeout(() => res.destroy(), 30); return; }
    res.end(part);
  });
  return { st, files, server, listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))) };
}

// ------------------------------------------------------------------ fake processes + fs
function fakeChild() { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.killed = false; c.kill = () => { if (c.killed) return; c.killed = true; setTimeout(() => c.emit('close', null), 5); }; return c; }
const norm = (p) => String(p).replace(/\\/g, '/');
function makeFs(virtual) {
  return {
    existsSync: (p) => virtual.has(norm(p)) || fs.existsSync(norm(p)),
    statSync: (p) => fs.statSync(norm(p)),
    mkdirSync: (p, o) => fs.mkdirSync(norm(p), o),
    createWriteStream: (p, o) => fs.createWriteStream(norm(p), o),
    renameSync: (a, b) => fs.renameSync(norm(a), norm(b)),
    statfsSync: (p) => fs.statfsSync(norm(p)),
    readdirSync: (p, o) => fs.readdirSync(norm(p), o),
    writeFileSync: (p, d2) => fs.writeFileSync(norm(p), d2),
    readFileSync: (p, o) => fs.readFileSync(norm(p), o),
    unlinkSync: (p) => fs.unlinkSync(norm(p)),
  };
}
function makeWorld(opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-setup-'));
  const virtual = new Set(opts.virtual || []);
  const spawned = [];
  const events = [];
  const logs = [];
  let alfred = { local: { endpoint: '', model: 'qwen2.5:7b' }, brain: 'auto' };
  let butler = opts.butler || { provider: 'runpod-serverless', endpoint: '', model: '' };
  const w = {
    tmp, virtual, spawned, events, logs,
    get alfred() { return alfred; }, get butler() { return butler; },
    onSpawn: opts.onSpawn || null,
  };
  w.spawn = (bin, args) => {
    spawned.push({ bin: norm(bin), args });
    const c = fakeChild();
    const r = w.onSpawn ? w.onSpawn(bin, args, c) : undefined;
    if (r !== 'handled') setTimeout(() => c.emit('close', 0), 10);
    return c;
  };
  w.execFile = (bin, args, o, cb) => {
    const b = norm(bin);
    setTimeout(() => {
      if (args[0] === '--version' && (virtual.has(b) || (b !== 'ollama' && fs.existsSync(b)))) return cb(null, 'ollama version is 0.5.7\n', '');
      const e = new Error('spawn ollama ENOENT'); e.code = 'ENOENT'; cb(e, '', '');
    }, 2);
    return new EventEmitter();
  };
  w.deps = (extra = {}) => Object.assign({
    platform: 'linux', arch: 'x64',
    env: { PATH: path.join(tmp, 'emptybin'), HOME: path.join(tmp, 'home') },
    homedir: path.join(tmp, 'home'),
    fs: makeFs(virtual), spawn: w.spawn, execFile: w.execFile, ollamaManager: om,
    paths: { downloadsDir: () => path.join(tmp, 'downloads'), modelsDir: () => path.join(tmp, 'models', 'llm'), appInstallDir: () => path.join(tmp, 'app-ollama') },
    hardware: async () => ({ ok: true, gpus: [{ name: 'RTX 3060', vendor: 'nvidia', vramMB: 12288 }], bestVramMB: 12288, ramMB: 32768, freeRamMB: 20000, notes: [] }),
    log: (k, dd) => logs.push([k, dd]), emit: (p) => events.push(p),
    alfred: { getSettings: () => JSON.parse(JSON.stringify(alfred)), setSettings: (p) => { alfred = Object.assign({}, alfred, p, { local: Object.assign({}, alfred.local, p.local || {}) }); return { ok: true }; } },
    butler: { get: () => Object.assign({}, butler), set: (c) => { butler = Object.assign({}, butler, c); return { ok: true }; } },
    retryDelayMs: 20, readyTimeoutMs: 3000, chatTimeoutMs: 3000, freeBytes: () => 500 * GB,
  }, extra);
  return w;
}

let OLL, SYS_CLOSED, DL, DL_BASE;

async function testFind() {
  console.log('\n== findOllama: PATH, the standard places, the app\'s own folder — and ollama-manager uses it at once ==');
  om.setBin(null);
  let w = makeWorld();
  let s = lib.createLlmSetup(w.deps());
  let r = await s.findOllama();
  assert(!r.ok && /not installed/.test(r.error), 'nothing installed → a plain "not installed yet"');

  const bin = path.join(w.tmp, 'mybin'); fs.mkdirSync(bin); fs.writeFileSync(path.join(bin, 'ollama'), '#!/bin/sh\n');
  s = lib.createLlmSetup(w.deps({ env: { PATH: `/nowhere:${bin}`, HOME: w.tmp } }));
  r = await s.findOllama();
  assert(r.ok && r.where === 'path' && r.version === '0.5.7', `on PATH → found with its version (${r.version})`);
  assert(om.getBin() === path.join(bin, 'ollama'), 'ollama-manager now runs that exact program (setBin)');

  w = makeWorld({ virtual: ['/usr/local/bin/ollama'] });
  s = lib.createLlmSetup(w.deps());
  r = await s.findOllama();
  assert(r.ok && r.bin === '/usr/local/bin/ollama' && r.where === 'standard', 'Linux: /usr/local/bin/ollama (not on the app\'s PATH) is found');

  w = makeWorld({ virtual: ['C:/Users/Ann/AppData/Local/Programs/Ollama/ollama.exe'] });
  s = lib.createLlmSetup(w.deps({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\Ann\\AppData\\Local', PATH: 'C:\\Windows' }, homedir: 'C:\\Users\\Ann' }));
  r = await s.findOllama();
  assert(r.ok && /Programs\\Ollama\\ollama\.exe$/.test(r.bin), 'Windows: %LOCALAPPDATA%\\Programs\\Ollama\\ollama.exe is found');

  w = makeWorld({ virtual: ['/Users/ann/Applications/Ollama.app/Contents/Resources/ollama'] });
  s = lib.createLlmSetup(w.deps({ platform: 'darwin', homedir: '/Users/ann', env: { PATH: '/usr/bin' } }));
  r = await s.findOllama();
  assert(r.ok && /Applications\/Ollama\.app/.test(r.bin), 'macOS: ~/Applications/Ollama.app/…/ollama is found');
  om.setBin(null);
}

async function testInstallLinux() {
  console.log('\n== installOllama (Linux): the official tarball into an app-local folder, with % progress ==');
  const appDir = { v: null };
  const w = makeWorld({ onSpawn: (bin, args) => { if (bin === 'tar') { const dir = args[args.indexOf('-C') + 1]; fs.mkdirSync(path.join(dir, 'bin'), { recursive: true }); fs.writeFileSync(path.join(dir, 'bin', 'ollama'), 'x'); appDir.v = dir; } } });
  const s = lib.createLlmSetup(w.deps({ downloadBase: DL_BASE }));
  const r = await s.installOllama();
  assert(r.ok && /installed/.test(r.message), `installs (${r.message || r.error})`);
  const tar = w.spawned.find((x) => x.bin === 'tar');
  assert(tar && tar.args.includes('-xzf') && tar.args.includes(path.join(w.tmp, 'app-ollama')), 'unpacks with tar -xzf into the app\'s own folder (no sudo)');
  assert(r.bin === path.join(w.tmp, 'app-ollama', 'bin', 'ollama') && om.getBin() === r.bin, 'finds the new program and ollama-manager uses it — no restart needed');
  const prog = w.events.filter((e) => e.type === 'progress' && e.task === 'install' && e.percent != null);
  assert(prog.length >= 1 && prog[prog.length - 1].percent === 100, `download progress in % (${prog.map((p) => p.percent).join(',')})`);
  assert(w.events.some((e) => e.type === 'done' && e.task === 'install' && e.ok), 'a "done" event');
  const again = await s.installOllama();
  assert(again.ok && again.already, 'installing again is harmless (already installed)');
  om.setBin(null);
}

async function testStalePart() {
  console.log('\n== a left-over OllamaSetup.exe.part: never resumed against a newer release ==');
  const FULL = Buffer.alloc(5000, 1);
  // a stub server: GET with Range/If-Range, HEAD with the size; `size` can change (a new release)
  const mk = (srv) => async (url, o = {}) => {
    const h = o.headers || {};
    srv.reqs.push({ method: o.method || 'GET', range: h.Range || null, ifRange: h['If-Range'] || null });
    const head = (k) => ({ 'content-length': String(srv.body.length), etag: srv.etag })[k] || null;
    if (o.method === 'HEAD') return { status: 200, ok: true, headers: { get: head }, body: null };
    const m = /bytes=(\d+)-/.exec(h.Range || '');
    const st = m ? Number(m[1]) : 0;
    const sameFile = !h['If-Range'] || h['If-Range'] === srv.etag;
    if (m && sameFile && st >= srv.body.length) return { status: 416, ok: false, headers: { get: () => null }, body: null };
    const resume = m && sameFile;
    const b = resume ? srv.body.subarray(st) : srv.body;
    return { status: resume ? 206 : 200, ok: true, headers: { get: (k) => (k === 'content-length' ? String(b.length) : k === 'etag' ? srv.etag : null) }, body: null, arrayBuffer: async () => b };
  };
  const w = makeWorld();
  const dlDir = path.join(w.tmp, 'dl'); fs.mkdirSync(dlDir, { recursive: true });
  const dest = path.join(dlDir, 'OllamaSetup.exe');
  const URL1 = 'http://x/OllamaSetup.exe';
  // 1) a .part older than a day is thrown away: the download starts from 0 (no Range)
  let srv = { body: FULL, etag: '"v2"', reqs: [] };
  let s = lib.createLlmSetup(w.deps({ fetch: mk(srv) }));
  fs.writeFileSync(dest + '.part', Buffer.alloc(3000, 9));
  const old = (Date.now() - 2 * 24 * 3600 * 1000) / 1000; fs.utimesSync(dest + '.part', old, old);
  let r = await s.download(URL1, dest);
  assert(r.ok && !srv.reqs[0].range && fs.readFileSync(dest).equals(FULL), 'a .part older than a day is deleted, not resumed (the whole file is downloaded again)');
  fs.rmSync(dest);
  // 2) a fresh .part resumes with If-Range = the stored ETag; a newer release (other ETag) → the server sends it whole
  srv = { body: FULL, etag: '"v1"', reqs: [] };
  s = lib.createLlmSetup(w.deps({ fetch: mk(srv) }));
  fs.writeFileSync(dest + '.part', FULL.subarray(0, 2000));
  fs.writeFileSync(dest + '.part.meta', JSON.stringify({ url: URL1, etag: '"v1"' }));
  r = await s.download(URL1, dest);
  assert(r.ok && srv.reqs[0].range === 'bytes=2000-' && srv.reqs[0].ifRange === '"v1"' && fs.readFileSync(dest).equals(FULL) && !fs.existsSync(dest + '.part.meta'), 'a fresh .part resumes with Range + If-Range (its stored ETag)');
  fs.rmSync(dest);
  const NEW = Buffer.alloc(6000, 2);
  srv = { body: NEW, etag: '"v3"', reqs: [] };
  s = lib.createLlmSetup(w.deps({ fetch: mk(srv) }));
  fs.writeFileSync(dest + '.part', FULL.subarray(0, 2000));
  fs.writeFileSync(dest + '.part.meta', JSON.stringify({ url: URL1, etag: '"v1"' }));
  r = await s.download(URL1, dest);
  assert(r.ok && fs.readFileSync(dest).equals(NEW), 'the release changed (ETag differs): the new file arrives whole, not old bytes + new bytes');
  fs.rmSync(dest);
  // 3) 416: accepted only when the .part is exactly the size HEAD reports; else the download starts over
  srv = { body: FULL, etag: '"v1"', reqs: [] };
  s = lib.createLlmSetup(w.deps({ fetch: mk(srv) }));
  fs.writeFileSync(dest + '.part', FULL);
  r = await s.download(URL1, dest);
  assert(r.ok && srv.reqs.some((q) => q.method === 'HEAD') && fs.readFileSync(dest).equals(FULL), '416 with a .part the size HEAD reports → complete');
  fs.rmSync(dest);
  srv = { body: Buffer.alloc(4000, 3), etag: '"v4"', reqs: [] };
  s = lib.createLlmSetup(w.deps({ fetch: mk(srv) }));
  fs.writeFileSync(dest + '.part', Buffer.alloc(4500, 8)); // longer than the current file → 416
  r = await s.download(URL1, dest);
  assert(r.ok && fs.readFileSync(dest).equals(srv.body) && srv.reqs.filter((q) => q.method === 'GET').slice(-1)[0].range === null, '416 with a .part of another size → deleted and downloaded again (never renamed as if complete)');
}

async function testInstallWindows() {
  console.log('\n== installOllama (Windows): OllamaSetup.exe, resume after a dropped connection, silent install ==');
  DL.st.dropFirst = true; DL.st.dropped = false; DL.st.requests.length = 0;
  const exePath = 'C:/Users/Ann/AppData/Local/Programs/Ollama/ollama.exe';
  const w = makeWorld({ onSpawn: (bin) => { if (/OllamaSetup\.exe$/.test(norm(bin))) w.virtual.add(exePath); } });
  const dl = path.join(w.tmp, 'downloads');
  const s = lib.createLlmSetup(w.deps({ platform: 'win32', downloadBase: DL_BASE, env: { LOCALAPPDATA: 'C:\\Users\\Ann\\AppData\\Local', PATH: 'C:\\Windows' }, homedir: 'C:\\Users\\Ann', paths: { downloadsDir: () => dl, modelsDir: () => path.join(w.tmp, 'm') } }));
  const r = await s.installOllama();
  assert(r.ok, `installs (${r.message || r.error})`);
  const reqs = DL.st.requests.filter((q) => q.name === 'OllamaSetup.exe');
  assert(reqs.length >= 2 && reqs[1].range && /^bytes=\d+-$/.test(reqs[1].range), `the dropped download resumes with a Range request (${reqs.map((q) => q.range).join(' | ')})`);
  assert(fs.statSync(path.join(dl, 'OllamaSetup.exe')).size === DL.files['OllamaSetup.exe'].length, 'the installer arrives complete');
  const run = w.spawned.find((x) => /OllamaSetup\.exe$/.test(x.bin));
  assert(run && ['/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES'].every((a) => run.args.includes(a)), 'runs it silently (/VERYSILENT /NORESTART /SUPPRESSMSGBOXES)');
  assert(r.bin && /ollama\.exe$/.test(r.bin), 'then finds ollama.exe');
  DL.st.dropFirst = false;

  const w2 = makeWorld({ onSpawn: (bin, args, c) => { setTimeout(() => c.emit('close', 2), 5); return 'handled'; } });
  const s2 = lib.createLlmSetup(w2.deps({ platform: 'win32', downloadBase: DL_BASE, env: { LOCALAPPDATA: 'C:\\X', PATH: '' }, homedir: 'C:\\Users\\Ann', paths: { downloadsDir: () => path.join(w2.tmp, 'dl'), modelsDir: () => null } }));
  const r2 = await s2.installOllama();
  assert(!r2.ok && /cancelled before it finished/.test(r2.error), `installer exit code → a plain sentence (${r2.error})`);

  const w3 = makeWorld({ onSpawn: (bin, args, c) => { setTimeout(() => { const e = new Error('spawn EPERM'); e.code = 'EPERM'; c.emit('error', e); }, 5); return 'handled'; } });
  const s3 = lib.createLlmSetup(w3.deps({ platform: 'win32', downloadBase: DL_BASE, env: { LOCALAPPDATA: 'C:\\X', PATH: '' }, homedir: 'C:\\Users\\Ann', paths: { downloadsDir: () => path.join(w3.tmp, 'dl'), modelsDir: () => null } }));
  const r3 = await s3.installOllama();
  assert(!r3.ok && /antivirus|permission/i.test(r3.error), `blocked installer → "antivirus / permission" (${r3.error})`);
  om.setBin(null);
}

async function testInstallMacAndErrors() {
  console.log('\n== installOllama (macOS) + the plain errors: no internet, disk full, cancel ==');
  const w = makeWorld({ onSpawn: (bin, args) => { if (bin === 'ditto') w.virtual.add('/Users/ann/Applications/Ollama.app/Contents/Resources/ollama'); } });
  const s = lib.createLlmSetup(w.deps({ platform: 'darwin', arch: 'arm64', downloadBase: DL_BASE, homedir: '/Users/ann', env: { PATH: '/usr/bin' }, fs: Object.assign(makeFs(w.virtual), { mkdirSync: (p, o) => (String(p).startsWith('/Users/') ? undefined : fs.mkdirSync(p, o)) }) }));
  const r = await s.installOllama();
  const ditto = w.spawned.find((x) => x.bin === 'ditto');
  assert(r.ok && ditto && ditto.args.includes('/Users/ann/Applications'), `macOS: unzips Ollama.app into ~/Applications (${r.message || r.error})`);

  const w2 = makeWorld();
  const s2 = lib.createLlmSetup(w2.deps({ downloadBase: SYS_CLOSED }));
  const r2 = await s2.installOllama();
  assert(!r2.ok && /internet/i.test(r2.error), `no internet → "check the connection" (${r2.error})`);
  assert(w2.events.some((e) => e.type === 'log' && /retrying/.test(e.message)), 'it retried before giving up');

  const w3 = makeWorld();
  const s3 = lib.createLlmSetup(w3.deps({ downloadBase: DL_BASE, freeBytes: () => 1000 }));
  const r3 = await s3.installOllama();
  assert(!r3.ok && /Not enough free disk space/.test(r3.error), `disk full → says so before downloading (${r3.error})`);

  // cancel during a slow download
  const slow = http.createServer((req, res) => { res.writeHead(200, { 'Content-Length': 10 * 1024 * 1024 }); const iv = setInterval(() => { if (res.destroyed) return clearInterval(iv); res.write(Buffer.alloc(1024)); }, 20); res.on('close', () => clearInterval(iv)); });
  await new Promise((rr) => slow.listen(0, '127.0.0.1', rr));
  const w4 = makeWorld();
  const s4 = lib.createLlmSetup(w4.deps({ downloadBase: `http://127.0.0.1:${slow.address().port}` }));
  const p4 = s4.installOllama();
  await sleep(150);
  const c = s4.cancel();
  const r4 = await p4;
  assert(c.cancelled && c.task === 'install' && !r4.ok && r4.cancelled, 'Cancel stops the download');
  slow.closeAllConnections && slow.closeAllConnections(); slow.close();
  om.setBin(null);
}

function serverWorld(extra = {}) {
  // Ollama installed (virtual), the app's server is the fake (comes up on `serve`), nothing on the "system" port
  const w = makeWorld(Object.assign({ virtual: ['/usr/local/bin/ollama'], onSpawn: (bin, args, c) => { if (args[0] === 'serve') { OLL.up(); c.kill = () => { c.killed = true; OLL.down().then(() => c.emit('close', 0)); }; return 'handled'; } } }, extra));
  const s = lib.createLlmSetup(w.deps(Object.assign({ systemBase: SYS_CLOSED, managedHost: `127.0.0.1:${OLL.port}`, downloadBase: DL_BASE }, extra.deps || {})));
  return { w, s };
}
async function reset() { om.stopManaged(); await OLL.down(); OLL.st.models = []; OLL.st.pulls = []; OLL.st.pullMode = 'ok'; OLL.st.nativeTools = true; OLL.st.textTools = true; om.setBin(null); }

async function testStartStop() {
  console.log('\n== startOllama / stopOllama: reuse one that answers, else start the app\'s own server ==');
  await reset();
  const { w, s } = serverWorld();
  let r = await s.startOllama();
  assert(r.ok && r.started && r.base === OLL.base, `starts the app's server and waits until it answers (${r.message || r.error})`);
  const serve = w.spawned.find((x) => x.args[0] === 'serve');
  assert(serve && serve.bin === '/usr/local/bin/ollama', 'with the Ollama program it found');
  r = await s.startOllama();
  assert(r.ok && r.already, 'already running → reused, not started twice');
  assert(w.spawned.filter((x) => x.args[0] === 'serve').length === 1, 'only one server');
  r = await s.stopOllama();
  assert(r.ok && r.stopped && !OLL.running, 'Stop stops the app\'s server');
  // a system Ollama we didn't start: reused, and Stop explains instead of killing it
  await OLL.up();
  const w2 = makeWorld({ virtual: ['/usr/local/bin/ollama'] });
  const s2 = lib.createLlmSetup(w2.deps({ systemBase: OLL.base, managedHost: SYS_CLOSED.replace('http://', '') }));
  r = await s2.startOllama();
  assert(r.ok && r.already && r.which === 'system' && !w2.spawned.length, 'an Ollama already running on this PC is reused');
  r = await s2.stopOllama();
  assert(r.ok && !r.stopped && /outside AutoInjector/.test(r.message), 'Stop on someone else\'s Ollama explains how to quit it instead');
  await OLL.down();
  // not installed
  const w3 = makeWorld();
  const s3 = lib.createLlmSetup(w3.deps({ systemBase: SYS_CLOSED, managedHost: SYS_CLOSED.replace('http://', '') }));
  r = await s3.startOllama();
  assert(!r.ok && r.fix && r.fix.action === 'install', 'not installed → says so, with the Install fix');
}

async function testPull() {
  console.log('\n== pullModel: POST /api/pull NDJSON → %, MB/s, time left; errors; cancel; disk check ==');
  await reset();
  const { w, s } = serverWorld();
  const seen = [];
  let r = await s.pullModel('qwen2.5:7b', { onProgress: (p) => seen.push(p) });
  assert(r.ok && OLL.st.pulls.includes('qwen2.5:7b'), `downloads through Ollama's HTTP API (${r.message || r.error})`);
  const pcts = seen.filter((p) => p.percent != null).map((p) => p.percent);
  assert(pcts.length >= 2 && pcts[pcts.length - 1] === 100 && pcts.every((v, i) => i === 0 || v >= pcts[i - 1]), `percent climbs to 100 (${pcts.join(',')})`);
  assert(seen.some((p) => p.totalBytes === OLL.st.pullSize && p.mbps != null), 'reports bytes and MB/s');
  assert(w.events.some((e) => e.type === 'done' && e.task === 'pull' && e.ok && e.pullName === 'qwen2.5:7b'), 'a "done" event on the llm channel (with pullName)');
  assert(seen.every((p) => p.pullName === 'qwen2.5:7b') && seen.some((p) => p.status === 'downloading'), 'progress carries pullName + a plain status');
  r = await s.pullModel('llama3.1:70b', { sizeBytes: 43 * GB });
  assert(!r.ok && r.tooBig && /too big for this PC/.test(r.error) && !OLL.st.pulls.includes('llama3.1:70b'), `a size rated "too big" is refused before downloading (${r.error})`);
  const l = await s.listModels();
  assert(l.ok && l.models.some((m) => m.name === 'qwen2.5:7b' && m.sizeBytes === OLL.st.pullSize && m.fit && m.fit.rating), 'listModels: the model with its size and a fit rating');

  OLL.st.pullMode = 'missing';
  r = await s.pullModel('nosuch:1b');
  assert(!r.ok && /couldn't find a model called "nosuch:1b"/.test(r.error), `unknown model → plain English (${r.error})`);
  OLL.st.pullMode = 'cut';
  r = await s.pullModel('cut:1b');
  assert(!r.ok && /ended before it finished/.test(r.error), 'a stream that ends early is not "done"');
  OLL.st.pullMode = 'slow';
  const p = s.pullModel('big:70b');
  await sleep(200);
  const busyTry = await s.pullModel('other:1b');
  assert(!busyTry.ok && busyTry.busy, 'a second download while one runs → "busy"');
  s.cancel();
  r = await p;
  assert(!r.ok && r.cancelled && /cancelled/i.test(r.error), 'Cancel stops the download');
  OLL.st.pullMode = 'ok';
  const { s: s2 } = serverWorld({ deps: { freeBytes: () => 2 * GB } });
  r = await s2.pullModel('mid:8b', { sizeBytes: 5 * GB });
  assert(!r.ok && /Not enough free disk space/.test(r.error), 'disk check first when the size is known');
  r = await s.pullModel('rm -rf /');
  assert(!r.ok && /doesn't look like a model name/.test(r.error), 'a bad name is refused');
  r = await s.pullModel('hf.co/bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M');
  assert(r.ok, 'a Hugging Face GGUF (hf.co/<repo>:<QUANT>) pulls the same way');

  r = await s.removeModel('cut:1b');
  assert(!r.ok && /isn't installed/.test(r.error), 'remove: not installed → says so');
  r = await s.removeModel('hf.co/bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M');
  assert(r.ok && OLL.st.deletes.includes('hf.co/bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M'), 'remove: DELETE /api/delete');
}

async function testUseAndCheck() {
  console.log('\n== useModel + check(): Alfred (and the old Butler) point at it; every row and its fix ==');
  await reset();
  // nothing installed at all
  let wNo = makeWorld();
  let sNo = lib.createLlmSetup(wNo.deps({ systemBase: SYS_CLOSED, managedHost: SYS_CLOSED.replace('http://', '') }));
  let c = await sNo.check();
  const row = (cc, id) => cc.rows.find((r) => r.id === id);
  assert(!c.ok && row(c, 'installed').ok === false && row(c, 'installed').fix.action === 'install', 'not installed → ✖ with the Install fix');
  assert(row(c, 'server').ok === false && row(c, 'any-model').ok === null, 'and the rest is skipped, not guessed');
  const ids = c.rows.map((r) => r.id).join(',');
  assert(ids === 'installed,server,disk,any-model,alfred-model,answers,tools,gpu,fit,butler', `all ten rows (${ids})`);

  const { w, s } = serverWorld({ butler: { provider: 'runpod-serverless', endpoint: 'https://api.runpod.ai/v2/abc/runsync', model: 'big-remote' } });
  c = await s.check();
  assert(row(c, 'installed').ok && /0\.5\.7/.test(row(c, 'installed').detail), 'installed → ✔ with the version');
  assert(row(c, 'server').ok === false && row(c, 'server').fix.action === 'start', 'not running → ✖ with Start');
  let f = await s.fix(row(c, 'server').fix);
  assert(f.ok && OLL.running, 'Fix: Start → running');
  c = await s.check();
  assert(row(c, 'any-model').ok === false && row(c, 'any-model').fix.action === 'download-recommended' && /qwen2\.5:7b/.test(row(c, 'any-model').fix.label), `no model → "Download qwen2.5:7b" (12 GB card) (${row(c, 'any-model').fix.label})`);
  f = await s.fix(row(c, 'any-model').fix);
  assert(f.ok && w.alfred.local.model === 'qwen2.5:7b' && w.alfred.local.endpoint === `${OLL.base}/v1`, `Fix: download + use → Alfred set to ${w.alfred.local.endpoint} / ${w.alfred.local.model}`);
  assert(w.butler.provider === 'runpod-serverless' && w.butler.model === 'big-remote', 'the old Butler (a remote provider) is left alone by default');
  c = await s.check();
  assert(c.ok, `all good → ok (${c.summary})`);
  assert(row(c, 'answers').ok && row(c, 'tools').ok === true && /natively/.test(row(c, 'tools').detail), 'answers + native tool calls ✔');
  assert(row(c, 'gpu').ok && /RTX 3060/.test(row(c, 'gpu').detail) && row(c, 'fit').ok === true, 'graphics card + fit ✔');
  assert(row(c, 'butler').ok === true, 'the old Butler on a remote service counts as set up');

  OLL.st.nativeTools = false;
  c = await s.check();
  assert(row(c, 'tools').ok === null && /text protocol/.test(row(c, 'tools').detail), 'no native tools but the text protocol works → ⚠');
  OLL.st.textTools = false;
  c = await s.check();
  assert(row(c, 'tools').ok === false && !c.ok, 'neither → ✖');
  OLL.st.nativeTools = true; OLL.st.textTools = true;

  // Alfred set to a model that isn't installed → "Use <installed>"
  w.deps; // (same world)
  const s2 = lib.createLlmSetup(Object.assign(w.deps({ systemBase: SYS_CLOSED, managedHost: `127.0.0.1:${OLL.port}` }), { alfred: { getSettings: () => ({ local: { endpoint: '', model: 'llama3.1:8b' } }), setSettings: () => ({ ok: true }) } }));
  c = await s2.check();
  assert(row(c, 'alfred-model').ok === false && row(c, 'alfred-model').fix.action === 'use' && row(c, 'alfred-model').fix.model === 'qwen2.5:7b', 'Alfred\'s model missing → "Use qwen2.5:7b" (one that is installed)');

  // the old Butler: empty local config → set; fix butler-use
  const wb = serverWorld({ butler: { provider: 'openai-compatible', endpoint: '', model: '' } });
  OLL.st.models = [{ name: 'qwen2.5:7b', size: 4.7 * GB }];
  let u = await wb.s.useModel('qwen2.5:7b');
  assert(u.ok && wb.w.butler.model === 'qwen2.5:7b' && wb.w.butler.endpoint === `${OLL.base}/v1/chat/completions` && u.test && u.test.ok, `use → Alfred + the old Butler, then a quick test (${u.message})`);
  u = await wb.s.useModel('notthere:1b');
  assert(!u.ok && /isn't downloaded yet/.test(u.error), 'use a model that isn\'t downloaded → says so');
  // too big
  OLL.st.models = [{ name: 'qwen2.5:7b', size: 4.7 * GB }, { name: 'llama3.1:70b', size: 40 * GB }];
  const sBig = lib.createLlmSetup(Object.assign(w.deps({ systemBase: SYS_CLOSED, managedHost: `127.0.0.1:${OLL.port}`, hardware: async () => ({ gpus: [{ name: 'GTX 1650', vramMB: 4096 }], bestVramMB: 4096, ramMB: 16384, freeRamMB: 8000 }) }), { alfred: { getSettings: () => ({ local: { endpoint: '', model: 'llama3.1:70b' } }), setSettings: () => ({ ok: true }) } }));
  c = await sBig.check({ quick: true });
  assert(row(c, 'fit').ok === false && /Too big/.test(row(c, 'fit').detail) && row(c, 'fit').fix && row(c, 'fit').fix.action === 'download-recommended', 'a model too big for this PC → ✖ with a fix');
}

async function testSetupAll() {
  console.log('\n== setupAll: THE ONE BUTTON from nothing — install → start → choose → download → use → check; twice = harmless ==');
  await reset();
  const w = makeWorld({ onSpawn: (bin, args, c) => {
    if (bin === 'tar') { const dir = args[args.indexOf('-C') + 1]; fs.mkdirSync(path.join(dir, 'bin'), { recursive: true }); fs.writeFileSync(path.join(dir, 'bin', 'ollama'), 'x'); }
    if (args[0] === 'serve') { OLL.up(); c.kill = () => { c.killed = true; OLL.down().then(() => c.emit('close', 0)); }; return 'handled'; }
  } });
  const s = lib.createLlmSetup(w.deps({ systemBase: SYS_CLOSED, managedHost: `127.0.0.1:${OLL.port}`, downloadBase: DL_BASE }));
  const steps = [];
  const r = await s.setupAll({ onProgress: (e) => { if (e.type === 'step' && e.state !== 'running') steps.push(e.step); } });
  assert(r.ok, `ready (${r.summary || r.error})`);
  assert(steps.join(',') === 'hardware,ollama,start,model,download,use,check', `the steps, in order (${steps.join(',')})`);
  assert(w.spawned.some((x) => x.bin === 'tar') && w.spawned.some((x) => x.args[0] === 'serve' && /app-ollama\/bin\/ollama$/.test(x.bin)), 'installed Ollama and started it from the fresh install (no restart)');
  assert(r.model === 'qwen2.5:7b' && OLL.st.pulls.includes('qwen2.5:7b') && w.alfred.local.model === 'qwen2.5:7b', 'picked the best fit for a 12 GB card, downloaded it, Alfred uses it');
  assert(r.check && r.check.ok, 'and the check passes');
  const spawnsBefore = w.spawned.length, pullsBefore = OLL.st.pulls.length;
  const r2 = await s.setupAll();
  assert(r2.ok && w.spawned.length === spawnsBefore && OLL.st.pulls.length === pullsBefore, 'running it again installs/downloads nothing');
  assert(r2.steps.find((x) => x.id === 'model').message.includes('already downloaded'), 'and says it keeps the model it has');

  console.log('\n== setupAll: 🔓 prefer uncensored; the catalog (Lane A) when present; busy; errors stop with a fix ==');
  const r3 = await s.setupAll({ uncensored: true });
  assert(r3.ok && /hermes3|dolphin/.test(r3.model) && OLL.st.pulls.includes(r3.model), `uncensored → ${r3.model}`);

  const catalog = { curated: async (hw, o) => [
    { id: 'c1', name: 'qwen3', title: 'Qwen 3', pullName: 'qwen3', uncensored: false, tools: true, variants: [{ tag: '32b', pullName: 'qwen3:32b', sizeBytes: 20 * GB }, { tag: '8b', pullName: 'qwen3:8b', sizeBytes: 5.2 * GB }, { tag: '4b', pullName: 'qwen3:4b', sizeBytes: 2.6 * GB }] },
    { id: 'c2', name: 'huihui_ai/qwen3-abliterated', title: 'Qwen 3 abliterated', pullName: 'huihui_ai/qwen3-abliterated', uncensored: true, tools: true, variants: [{ tag: '8b', pullName: 'huihui_ai/qwen3-abliterated:8b', sizeBytes: 5.2 * GB }] },
  ].sort((a, b) => (o.uncensored ? Number(b.uncensored) - Number(a.uncensored) : 0)) };
  const picked = [];
  const llmHardware = { rateFit: lib.fallbackFit, pickVariant: (vs, hw) => { picked.push(vs.map((v) => v.tag).join(',')); return vs.filter((v) => v.fit.rating === 'great').sort((a, b) => b.sizeBytes - a.sizeBytes)[0] || null; } };
  OLL.st.models = [];
  const s4 = lib.createLlmSetup(w.deps({ systemBase: SYS_CLOSED, managedHost: `127.0.0.1:${OLL.port}`, catalog: () => catalog, llmHardware }));
  const r4 = await s4.setupAll();
  assert(r4.ok && r4.model === 'qwen3:8b' && picked.includes('32b,8b,4b'), `catalog: the biggest variant with a great fit (${r4.model})`);
  OLL.st.models = [];
  const r5 = await s4.setupAll({ uncensored: true });
  assert(r5.ok && r5.model === 'huihui_ai/qwen3-abliterated:8b', `catalog + uncensored → ${r5.model}`);
  const picks = await s4.recommendedPicks(await s4.hardware(), {});
  assert(picks.length === 2 && picks[0].fit && picks[0].fit.label, 'recommendedPicks: rated picks');

  OLL.st.pullMode = 'slow';
  OLL.st.models = [];
  const p6 = s4.setupAll();
  await sleep(150);
  const b = await s4.setupAll();
  assert(!b.ok && b.busy, 'pressing it again while it runs → "busy", nothing doubled');
  await sleep(150);
  s4.cancel();
  const r6 = await p6;
  assert(!r6.ok && r6.cancelled, 'Cancel stops the setup');
  OLL.st.pullMode = 'missing';
  const r7 = await s4.setupAll();
  assert(!r7.ok && r7.fix && r7.fix.action === 'download-recommended' && /couldn't find/.test(r7.error), 'a failing step stops with a plain message + the fix');
  OLL.st.pullMode = 'ok';

  const tiny = lib.createLlmSetup(w.deps({ systemBase: SYS_CLOSED, managedHost: `127.0.0.1:${OLL.port}`, hardware: async () => ({ gpus: [], bestVramMB: 0, ramMB: 1024, freeRamMB: 200 }) }));
  OLL.st.models = [];
  const r8 = await tiny.setupAll();
  assert(!r8.ok && /None of the recommended models fit/.test(r8.error), 'a PC too small for any model → says so (never downloads one that can\'t run)');
}

async function testSafety() {
  console.log('\n== safety: nothing secret in logs/events; never throws ==');
  await reset();
  const { w, s } = serverWorld({ deps: { secrets: () => ['hf_SECRETTOKEN12345'] } });
  await s.startOllama();
  OLL.st.pullMode = 'secret';
  const r = await s.pullModel('hf.co/me/private-GGUF:Q4_K_M');
  assert(!r.ok && /permission/.test(r.error), `a gated model → "needs permission" (${r.error})`);
  const dump = JSON.stringify(w.events) + JSON.stringify(w.logs) + JSON.stringify(r);
  assert(!dump.includes('SECRETTOKEN'), 'the token never appears in an event, a log line or the result');
  OLL.st.pullMode = 'ok';

  const boom = makeWorld();
  const sb = lib.createLlmSetup(boom.deps({ fetch: () => { throw new Error('boom'); }, execFile: () => { throw new Error('boom'); }, spawn: () => { throw new Error('boom'); }, hardware: async () => { throw new Error('boom'); }, systemBase: SYS_CLOSED, managedHost: SYS_CLOSED.replace('http://', '') }));
  let threw = false;
  try {
    const out = await Promise.all([sb.status(), sb.check(), sb.findOllama(), sb.startOllama(), sb.stopOllama(), sb.listModels(), sb.pullModel('x:1b'), sb.removeModel('x:1b'), sb.useModel('x:1b'), sb.fix('nope'), sb.installOllama()]);
    assert(out.every((o) => o && typeof o === 'object'), 'every call returns an object even when everything underneath throws');
    const s2 = await sb.setupAll();
    assert(!s2.ok && typeof (s2.error || s2.summary) === 'string', 'setupAll too');
  } catch (e) { threw = true; console.log(e); }
  assert(!threw, 'nothing throws');

  console.log('\n== helpers ==');
  assert(lib.parseVersion('Warning: could not connect to a running Ollama instance\nWarning: client version is 0.6.2') === '0.6.2', 'parseVersion reads "client version is …" too');
  assert(lib.paramsFromName('dolphin-mixtral:8x7b') === 47 && lib.paramsFromName('qwen2.5:0.5b') === 0.5 && lib.paramsFromName('hf.co/x/Llama-3.1-8B-GGUF:Q4_K_M') === 8, 'paramsFromName');
  const hw = { bestVramMB: 12288, ramMB: 32768, freeRamMB: 16000 };
  assert(lib.fallbackFit(4.7 * GB, hw).rating === 'great' && lib.fallbackFit(8 * GB, hw).rating === 'good' && lib.fallbackFit(20 * GB, hw).rating === 'slow' && lib.fallbackFit(60 * GB, hw).rating === 'too-big', 'fallbackFit: great / good / slow / too-big');
  assert(/internet/.test(lib.friendlyError({ code: 'ENOTFOUND' }, 'x')) && /disk is full/.test(lib.friendlyError({ code: 'ENOSPC' }, 'x')), 'friendlyError');
  assert(lib.isUncensored('huihui_ai/qwen3-abliterated:8b') && lib.isUncensored('dolphin3') && !lib.isUncensored('qwen2.5:7b'), 'isUncensored');
}


async function testStartAlfred() {
  console.log('\n== ▶ Start Alfred: one click, only what is already downloaded (never a download) ==');
  await reset();
  let w = makeWorld();
  let s = lib.createLlmSetup(w.deps({ systemBase: SYS_CLOSED, managedHost: `127.0.0.1:${OLL.port}` }));
  let r = await s.startAlfred();
  assert(!r.ok && r.needSetup && r.fix && r.fix.action === 'setup' && /isn't installed/.test(r.error), 'no Ollama → "press ⚡ Set up once" (with that fix)');

  // the user's OWN model (not one of the recommended picks), already downloaded in the app's store
  await reset();
  ({ w, s } = serverWorld());
  fs.mkdirSync(path.join(w.tmp, 'models', 'llm', 'manifests', 'registry', 'x'), { recursive: true });
  fs.writeFileSync(path.join(w.tmp, 'models', 'llm', 'manifests', 'registry', 'x', 'latest'), '{}');
  OLL.st.models = [{ name: 'mistral-nemo:12b', size: 7 * GB }, { name: 'nomic-embed-text:latest', size: 0.3 * GB }];
  const msgs = [];
  r = await s.startAlfred({ onProgress: (e) => msgs.push(e.message) });
  assert(r.ok && r.model === 'mistral-nemo:12b' && w.alfred.local.model === 'mistral-nemo:12b' && /\/v1$/.test(w.alfred.local.endpoint), `starts Ollama and uses the model you already have (${r.message || r.error})`);
  assert(OLL.st.pulls.length === 0, 'downloads NOTHING');
  assert(msgs.some((m) => /already have/.test(m)) && msgs.some((m) => /Loading/.test(m)), 'says what it is doing (looking, loading)');
  const pulls = OLL.st.pulls.length;
  const r2 = await s.setupAll();
  assert(r2.ok && OLL.st.pulls.length === pulls && r2.model === 'mistral-nemo:12b', `⚡ Set up keeps your own model too — no download (${r2.model})`);
  r = await s.startAlfred();
  assert(r.ok && r.model === 'mistral-nemo:12b', 'pressing it again is harmless');

  // Alfred's own choice wins over a bigger one
  OLL.st.models.push({ name: 'qwen3:14b', size: 9 * GB });
  w.alfred.local.model = 'mistral-nemo:12b';
  r = await s.startAlfred();
  assert(r.ok && r.model === 'mistral-nemo:12b', 'the model Alfred already uses is kept');
  w.alfred.local.model = 'gone:1b';
  r = await s.startAlfred();
  assert(r.ok && ['qwen3:14b', 'mistral-nemo:12b'].includes(r.model) && OLL.st.pulls.length === pulls, `his model is gone → the best fit you already have (${r.model}), not a download`);

  // nothing downloaded anywhere
  await reset();
  ({ w, s } = serverWorld());
  r = await s.startAlfred();
  assert(!r.ok && r.needSetup && /No models/.test(r.error) && OLL.st.pulls.length === 0, 'no models anywhere → "press ⚡ Set up once", still no download');

  // the models live in Ollama's usual folder (~/.ollama/models), the app's own folder is empty
  await reset();
  const home = path.join(os.tmpdir(), `llm-home-${process.pid}`);
  fs.mkdirSync(path.join(home, '.ollama', 'models', 'manifests', 'registry.ollama.ai', 'library', 'qwen3'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ollama', 'models', 'manifests', 'registry.ollama.ai', 'library', 'qwen3', '8b'), '{}');
  ({ w, s } = serverWorld({ deps: { env: { HOME: home, PATH: '/usr/bin' }, homedir: home } }));
  assert(s.storeHasModels(path.join(home, '.ollama', 'models')) && !s.storeHasModels(path.join(w.tmp, 'models', 'llm')), 'storeHasModels: Ollama\'s usual folder has models, the app\'s is empty');
  OLL.st.models = [{ name: 'qwen3:8b', size: 5 * GB }];
  r = await s.startAlfred();
  const ms = om.managedStatus();
  assert(r.ok && r.model === 'qwen3:8b' && ms.modelsDir === path.join(home, '.ollama', 'models'), `starts Ollama on the folder that HAS your models (${ms.modelsDir}) — nothing downloaded again`);
  await reset();
}

async function testScan() {
  console.log('\n== 🔍 Find what\'s installed: Ollama, folders with models, the servers\' models, .gguf files — and use them ==');
  await reset();
  const home = path.join(os.tmpdir(), `llm-scan-${process.pid}`);
  fs.rmSync(home, { recursive: true, force: true });
  // Ollama's usual folder has models; LM Studio downloaded a .gguf; a tiny .gguf in Downloads is ignored
  fs.mkdirSync(path.join(home, '.ollama', 'models', 'manifests', 'registry.ollama.ai', 'library', 'qwen3'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ollama', 'models', 'manifests', 'registry.ollama.ai', 'library', 'qwen3', '8b'), '{}');
  const lm = path.join(home, '.lmstudio', 'models', 'bartowski', 'Mistral-Nemo-GGUF');
  fs.mkdirSync(lm, { recursive: true });
  const big = path.join(lm, 'Mistral-Nemo-Instruct-Q4_K_M.gguf');
  fs.writeFileSync(big, ''); fs.truncateSync(big, 60 * 1024 * 1024);
  fs.mkdirSync(path.join(home, 'Downloads'), { recursive: true });
  fs.writeFileSync(path.join(home, 'Downloads', 'vocab.gguf'), 'x');
  const created = [];
  const { w, s } = serverWorld({ deps: { env: { HOME: home, PATH: '/usr/bin' }, homedir: home }, onSpawn: (bin, args, c) => {
    if (args[0] === 'serve') { OLL.up(); c.kill = () => { c.killed = true; OLL.down().then(() => c.emit('close', 0)); }; return 'handled'; }
    if (args[0] === 'create') { created.push({ name: args[1], modelfile: fs.readFileSync(args[3], 'utf8') }); OLL.st.models.push({ name: `${args[1]}:latest`, size: 60 * 1024 * 1024 }); setTimeout(() => c.emit('close', 0), 5); return 'handled'; }
  } });
  OLL.st.models = [{ name: 'qwen2.5:7b', size: 4.7 * GB }];
  await s.startOllama();
  let r = await s.scanInstalled();
  assert(r.ok && r.ollama.installed && r.servers.length === 1 && r.servers[0].models[0].name === 'qwen2.5:7b', `finds Ollama and the models it has (${r.summary})`);
  const usual = r.stores.find((x) => x.dir === path.join(home, '.ollama', 'models'));
  assert(usual && usual.hasModels && !usual.inUse, 'finds Ollama\'s usual folder has models (not the one in use)');
  assert(r.ggufs.length === 1 && r.ggufs[0].path === big && r.ggufs[0].from === 'LM Studio' && /mistral-nemo/.test(r.ggufs[0].suggestedName), `finds LM Studio's .gguf, skips a tiny file (${r.ggufs.map((g) => g.file).join(', ')})`);
  r = await s.useStore(usual.dir);
  assert(r.ok && om.managedStatus().modelsDir === usual.dir && /nothing downloaded/.test(r.message), 'Use this folder → the app\'s Ollama runs on it (nothing downloaded)');
  r = await s.importGguf(big, 'mistral-nemo-lm');
  assert(r.ok && created.length === 1 && created[0].name === 'mistral-nemo-lm' && created[0].modelfile.trim() === `FROM ${big}` && OLL.st.pulls.length === 0, `➕ Add to Ollama → ollama create from the file, no download (${r.message || r.error})`);
  r = await s.importGguf(path.join(home, 'nope.gguf'));
  assert(!r.ok && /isn't there/.test(r.error), 'a missing file → plain error');
  assert(!(await s.useStore(path.join(home, 'empty'))).ok, 'a folder without models is refused');
  fs.rmSync(home, { recursive: true, force: true });
  await reset();
}

(async () => {
  const p = await freePort();
  OLL = fakeOllama(p);
  SYS_CLOSED = `http://127.0.0.1:${await freePort()}`;
  DL = fakeDownloads();
  DL_BASE = await DL.listen();
  const tests = [testFind, testInstallLinux, testInstallWindows, testStalePart, testInstallMacAndErrors, testStartStop, testPull, testUseAndCheck, testSetupAll, testStartAlfred, testScan, testSafety];
  for (const t of tests) { try { await t(); } catch (e) { failed++; console.log(`  FAIL - ${t.name} threw: ${e && e.stack}`); } }
  await reset();
  DL.server.closeAllConnections && DL.server.closeAllConnections(); DL.server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
