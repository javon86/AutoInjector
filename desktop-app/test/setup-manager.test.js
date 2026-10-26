// test/setup-manager.test.js — the butler's self-install engine. Verifies the
// fixed allowlist, per-kind install (pip / download / ollama / handoff) with
// stubbed processes + a stub HTTP server, detection, model-name validation, and
// the auto() sequence. No Electron, no real installs. Run: node test/setup-manager.test.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const sm = require('../setup-manager');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }

// A fake child process that emits some output then closes with a code.
function fakeChild(code, out) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    if (out) child.stdout.emit('data', Buffer.from(out));
    child.emit('close', code);
  });
  return child;
}

async function main() {
  console.log('\n== the fixed allowlist ==');
  const ids = sm.list().map((t) => t.id);
  for (const need of ['open-interpreter', 'voice', 'voice-model', 'ollama-model', 'stability-matrix']) {
    assert(ids.includes(need), `allowlist includes ${need}`);
  }
  assert(sm.has('open-interpreter') && !sm.has('rm -rf'), 'has() reflects the allowlist and rejects junk');
  assert(sm.get('open-interpreter').kind === 'pip', 'open-interpreter is a pip target (the keystone)');
  assert(sm.list().every((t) => !('packages' in t) || true) && typeof sm.list()[0].label === 'string', 'list() returns UI-friendly metadata');
  assert(sm.AUTO_ORDER[0] === 'open-interpreter', 'Auto-setup installs Open Interpreter first (the keystone)');

  console.log('\n== install rejects an unknown target (butler can only pass an id) ==');
  const un = await sm.install('anything-else');
  assert(un.ok === false && un.error === 'UNKNOWN_TARGET', 'an off-allowlist target -> UNKNOWN_TARGET');

  console.log('\n== pip install shells out with an argv array, no shell ==');
  let spawnArgs = null;
  sm.configure({ spawn: (cmd, args) => { spawnArgs = { cmd, args }; return fakeChild(0, 'Successfully installed open-interpreter'); } });
  const lines = [];
  const pip = await sm.install('open-interpreter', { onProgress: (l) => lines.push(l) });
  assert(pip.ok, 'a successful pip install resolves ok');
  assert(Array.isArray(spawnArgs.args) && spawnArgs.args.includes('pip') && spawnArgs.args.includes('install') && spawnArgs.args.includes('open-interpreter'),
    'pip is invoked as `<python> -m pip install … open-interpreter` via argv (no shell)');
  assert(lines.some((l) => /open-interpreter/.test(l)), 'install streams progress lines');
  sm.configure({ spawn: () => fakeChild(1, 'ERROR: could not install') });
  const pipFail = await sm.install('voice');
  assert(pipFail.ok === false && /exited 1/.test(pipFail.error), 'a non-zero exit -> ok:false with the exit code');

  console.log('\n== download target saves fixed files into models/<category> ==');
  const modelsBase = fs.mkdtempSync(path.join(os.tmpdir(), 'setupmodels-'));
  const stub = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '4' }); res.end('DATA'); });
  const port = await listen(stub);
  // Point the voice-model target's files at the stub by overriding just its urls.
  const t = sm.get('voice-model');
  const realFiles = t.files.map((f) => ({ ...f }));
  t.files.forEach((f) => { f.url = `http://127.0.0.1:${port}/${f.name}`; delete f.minBytes; delete f.json; });
  sm.configure({ modelsDir: (cat) => { const d = path.join(modelsBase, cat); fs.mkdirSync(d, { recursive: true }); return d; } });
  const dl = await sm.install('voice-model', { onProgress: () => {} });
  assert(dl.ok, 'the download target resolves ok against a reachable server');
  assert(fs.existsSync(path.join(modelsBase, 'voice', 'en_US-lessac-medium.onnx')), 'the voice model file landed in models/voice');
  const det = await sm.detect('voice-model');
  assert(det.installed === true, 'detect() sees the downloaded files as installed');
  stub.close();

  console.log('\n== a damaged voice model is detected and re-downloaded (size checks, force) ==');
  {
    // a server that serves a "model" of a known size; can also cut the body short
    let cut = false, hits = 0;
    const BODY = 'M'.repeat(2048);
    const srv = http.createServer((req, res) => {
      hits++;
      if (/\.json$/.test(req.url)) { const j = '{"audio":{"sample_rate":22050},"pad":"' + 'x'.repeat(600) + '"}'; res.writeHead(200, { 'Content-Length': String(Buffer.byteLength(j)) }); return res.end(j); }
      res.writeHead(200, { 'Content-Length': String(BODY.length) });
      if (cut) { res.write(BODY.slice(0, 100)); setTimeout(() => res.destroy(), 20); return; }
      res.end(BODY);
    });
    const p2 = await listen(srv);
    const base2 = fs.mkdtempSync(path.join(os.tmpdir(), 'setupmodels2-'));
    sm.configure({ modelsDir: (cat) => { const d = path.join(base2, cat); fs.mkdirSync(d, { recursive: true }); return d; } });
    t.files.forEach((f, i) => { f.url = `http://127.0.0.1:${p2}/${f.name}`; f.minBytes = i === 0 ? 1024 : 500; if (i === 1) f.json = true; });
    const onnx = path.join(base2, 'voice', 'en_US-lessac-medium.onnx');
    fs.mkdirSync(path.dirname(onnx), { recursive: true });
    fs.writeFileSync(onnx, 'tiny'); // a partial download from before
    fs.writeFileSync(onnx + '.json', '{"ok":true,"pad":"' + 'y'.repeat(600) + '"}');
    const d0 = await sm.detect('voice-model');
    assert(d0.installed === false && d0.damaged === true && /damaged or incomplete/.test(d0.reason), `detect() reports a too-small model as damaged (got ${JSON.stringify(d0)})`);
    assert(sm.fileProblem(onnx, t.files[0]) && !sm.fileProblem(onnx + '.json', t.files[1]), 'fileProblem flags the short .onnx, passes a valid .json');
    const lines2 = [];
    const r1 = await sm.install('voice-model', { onProgress: (l) => lines2.push(l) });
    assert(r1.ok && fs.statSync(onnx).size === 2048, 'install() fetches a damaged file again instead of "already present"');
    assert(lines2.some((l) => /damaged/.test(l)), 'progress says the file was damaged');
    // force: re-download even when the file looks fine (onnxruntime said it can't load it)
    hits = 0;
    const r2 = await sm.install('voice-model', { force: true, onProgress: () => {} });
    assert(r2.ok && hits === 2 && /Re-downloaded/.test(r2.message), 'force re-downloads both files');
    // a dropped connection mid-download is a failure, and the old copy is kept
    cut = true;
    const r3 = await sm.install('voice-model', { force: true, onProgress: () => {} });
    assert(!r3.ok && /download failed/.test(r3.error), `a body cut short is reported as a failed download (got ${JSON.stringify(r3)})`);
    assert(fs.statSync(onnx).size === 2048, 'the previous good copy is left in place');
    assert(!fs.existsSync(onnx + '.part'), 'no .part file is left behind');
    cut = false;
    // a broken .json is caught too
    fs.writeFileSync(onnx + '.json', 'not json'.repeat(100));
    const d1 = await sm.detect('voice-model');
    assert(d1.installed === false && /not valid JSON/.test(d1.reason), 'a .json that does not parse is damaged');
    srv.close();
  }
  t.files.splice(0, t.files.length, ...realFiles); // restore real urls for other tests/runs

  console.log('\n== ollama target validates the model name and delegates to the puller ==');
  let pulled = null;
  sm.configure({ pullOllamaModel: (model) => { pulled = model; return { done: Promise.resolve({ ok: true, model }) }; } });
  const oll = await sm.install('ollama-model', { onProgress: () => {} });
  assert(oll.ok && pulled === 'llama3.2:3b', 'ollama-model pulls the default model via the injected puller');
  const ollCustom = await sm.install('ollama-model', { model: 'qwen2.5:7b' });
  assert(ollCustom.ok && pulled === 'qwen2.5:7b', 'a valid custom model tag is passed through');
  const ollBad = await sm.install('ollama-model', { model: 'evil; rm -rf /' });
  assert(ollBad.ok === false && ollBad.error === 'BAD_MODEL', 'a model name with shell metacharacters -> BAD_MODEL');

  console.log('\n== handoff target opens the official page (GUI installer) ==');
  let opened = null;
  sm.configure({ openExternal: (url) => { opened = url; } });
  const ho = await sm.install('stability-matrix');
  assert(ho.ok && ho.handoff === true && /StabilityMatrix/.test(opened), 'stability-matrix is a handoff that opens its download page');

  console.log('\n== auto() runs the whole sequence in order and reports each ==');
  sm.configure({
    spawn: () => fakeChild(0, 'ok'),
    pullOllamaModel: (model) => ({ done: Promise.resolve({ ok: true, model }) }),
    // download will hit the (now closed) stub — force those to be already-present instead
    modelsDir: (cat) => { const d = path.join(modelsBase, cat); fs.mkdirSync(d, { recursive: true }); return d; },
  });
  const steps = [];
  const res = await sm.auto({ onStep: (s) => { if (s.phase === 'done') steps.push(s.target); } });
  assert(res.total === sm.AUTO_ORDER.length, 'auto() attempts every target in the order');
  assert(steps[0] === 'open-interpreter' && steps[steps.length - 1] === 'stability-matrix', 'auto() keeps the keystone-first order');
  assert(res.installed >= 1, 'auto() reports how many succeeded');

  console.log('\n== Python resolution: pick a wheel-compatible interpreter, and guide when it is too new ==');
  // Simulate a machine that has ONLY Python 3.14 (the version-specific probes
  // all fail; a bare `python`/`python3` answers 3.14). This is the real user's
  // case: litellm/tiktoken have no 3.14 wheel, so the install must warn + guide.
  const cp = require('child_process');
  const probeStub = (cmd, args, opts, cb) => {
    const isVersion = Array.isArray(args) && args.includes('-c');
    if (isVersion && (cmd === 'python' || cmd === 'python3')) { cb(null, '3.14\n', ''); }
    else if (isVersion) { cb(new Error('not found')); }
    else { cb(new Error('unexpected execFile in test')); }
    return { on() {} };
  };
  sm._resetPython();
  sm.configure({ execFile: probeStub });
  const py = await sm.pythonStatus();
  assert(py.version === '3.14' && py.compatible === false, 'a machine with only Python 3.14 resolves as incompatible (no wheels)');
  assert(/3\.12/.test(py.note) && /python\.org/i.test(py.note), 'the status explains the fix: install Python 3.12');

  sm._resetPython();
  sm.configure({ execFile: probeStub, spawn: () => fakeChild(1, 'error: metadata-generation-failed; Cargo is not installed') });
  const oiFail = await sm.install('open-interpreter', { onProgress: () => {} });
  assert(oiFail.ok === false && /no prebuilt package/.test(oiFail.error) && /python\.org/i.test(oiFail.error),
    'a too-new-Python pip failure explains the cause and points to Python 3.12 (not just "exited 1")');

  // A compatible Python installs via a prebuilt wheel (no source build needed).
  const spawnSeen = [];
  sm._resetPython();
  sm.configure({
    execFile: (cmd, args, opts, cb) => { if (args.includes('-c')) cb(null, '3.12\n', ''); else cb(new Error('n/a')); return { on() {} }; },
    spawn: (cmd, args) => { spawnSeen.push({ cmd, args }); return fakeChild(0, 'Successfully installed open-interpreter'); },
  });
  const oiOk = await sm.install('open-interpreter', { onProgress: () => {} });
  assert(oiOk.ok === true, 'a compatible Python (3.12) installs cleanly');
  assert(spawnSeen[0].args.includes('--prefer-binary'), 'the install prefers a prebuilt wheel over compiling from source (--prefer-binary)');
  // Restore real process deps + cache so nothing leaks to other runs.
  sm.configure({ execFile: cp.execFile, spawn: cp.spawn });
  sm._resetPython();

  console.log('\n== Windows: find an installed 3.12 via the launcher AND the standard install dirs ==');
  const winCands = sm._pyCandidates('win32', { LOCALAPPDATA: 'C:\\Users\\javon\\AppData\\Local', ProgramFiles: 'C:\\Program Files' });
  // Normalize separators so the check holds whether the test host is Windows
  // (path.join → "\\") or POSIX (path.join → "/").
  const asStr = winCands.map((c) => `${c.cmd} ${c.pre.join(' ')}`.trim().replace(/\\/g, '/'));
  assert(asStr.includes('py -3.12'), 'the py launcher (py -3.12) is tried first on Windows');
  assert(asStr.some((s) => /AppData\/Local\/Programs\/Python\/Python312\/python\.exe$/.test(s)), 'the per-user install dir (…/Programs/Python/Python312/python.exe) is probed directly');
  assert(asStr.some((s) => /Program Files\/Python312\/python\.exe$/.test(s)), 'the per-machine Program Files/Python312 dir is probed too');
  assert(asStr.indexOf('py -3.12') < asStr.findIndex((s) => /Python312\/python\.exe/.test(s)), 'the launcher is preferred over a hard-coded path');

  console.log('\n== OP-14: Python lookup probes candidates at the same time, keeps the preference order ==');
  {
    const D = 150;
    let calls = 0;
    // Every candidate takes 150ms to answer; only python3.11 and python3 work.
    const slowStub = (cmd, args, opts, cb) => {
      calls++;
      setTimeout(() => {
        if (cmd === 'python3.11') cb(null, '3.11\n', '');
        else if (cmd === 'python3') cb(null, '3.13\n', '');
        else cb(new Error('not found'));
      }, D);
      return { on() {} };
    };
    sm._resetPython();
    sm.configure({ execFile: slowStub });
    const t0 = Date.now();
    const [a, b] = await Promise.all([sm.resolvePython(true), sm.resolvePython(true)]);
    const took = Date.now() - t0;
    const n = sm._pyCandidates().length;
    console.log(`     (measured ${took}ms for ${n} candidates; one at a time would be ~${n * D}ms)`);
    assert(took < (n * D) / 2, `all candidates are probed concurrently (${took}ms)`);
    assert(a === b && calls <= n, 'two callers at once share ONE lookup (no duplicate process storm)');
    assert(a.version === '3.11' && a.compatible === true, 'the first compatible Python in preference order still wins');
    sm.configure({ execFile: cp.execFile });
    sm._resetPython();
  }

  console.log('\n== OP-14: "no Python" is not cached forever (installing Python is picked up) ==');
  {
    let pythonInstalled = false;
    const stub = (cmd, args, opts, cb) => { if (pythonInstalled && cmd === 'python3') cb(null, '3.12\n', ''); else cb(new Error('not found')); return { on() {} }; };
    sm._resetPython();
    sm.configure({ execFile: stub });
    const s1 = await sm.pythonStatus();
    assert(s1.missing === true, 'no Python on the machine → missing');
    pythonInstalled = true;
    const realNow = Date.now;
    Date.now = () => realNow() + 31000; // 31s later
    try {
      const s2 = await sm.pythonStatus();
      assert(s2.missing === false && s2.version === '3.12', 'after the user installs Python, the next check finds it (no restart needed)');
    } finally { Date.now = realNow; }
    sm.configure({ execFile: cp.execFile });
    sm._resetPython();
  }

  console.log('\n== OP-14: install detection runs at the same time, and says why ==');
  {
    const D = 150;
    const stub = (cmd, args, opts, cb) => {
      setTimeout(() => {
        if (args.includes('-c')) return cb(null, '3.12\n', '');
        if (args.includes('show')) return cb(null, 'Name: x\n', '');
        cb(new Error('n/a'));
      }, D);
      return { on() {} };
    };
    sm.configure({
      execFile: stub,
      detectOllama: () => new Promise((r) => setTimeout(() => r({ available: true, version: '0.5' }), D)),
      listOllamaModels: async () => ({ ok: true, models: [] }),
    });
    sm._resetPython();
    await sm.resolvePython(); // resolve Python first (measured above) so only detection is timed
    const t0 = Date.now();
    const all = await sm.detectAll();
    const took = Date.now() - t0;
    console.log(`     (measured ${took}ms; one at a time would be ≥${3 * D}ms)`);
    assert(took < 3 * D, `pip show ×2 and the Ollama check overlap (${took}ms)`);
    assert(all['open-interpreter'].installed === true && all.voice.installed === true, 'pip targets are detected');
    assert(all['ollama-model'].installed === false && /no model is downloaded/.test(all['ollama-model'].reason), 'Ollama present but no model → NOT reported as installed, and says why');

    sm.configure({ listOllamaModels: async () => ({ ok: true, models: ['llama3.2:3b'] }) });
    assert((await sm.detect('ollama-model')).installed === true, 'Ollama with a model downloaded → installed');
    sm.configure({ listOllamaModels: async () => ({ ok: false, models: [], reason: 'unreachable' }) });
    const unk = await sm.detect('ollama-model');
    assert(unk.installed === null && /server didn't answer/.test(unk.reason), "Ollama installed but its server is down → \"couldn't tell\", not a false yes/no");
    sm.configure({ detectOllama: async () => ({ available: false }) });
    const noOl = await sm.detect('ollama-model');
    assert(noOl.installed === false && /not installed/.test(noOl.reason), 'no Ollama → not installed, with the reason');

    // No Python → pip targets are "not installed" without spawning pip at all.
    let pipSpawned = false;
    sm.configure({ execFile: (cmd, args, opts, cb) => { if (args.includes('show')) pipSpawned = true; cb(new Error('not found')); return { on() {} }; } });
    sm._resetPython();
    const noPy = await sm.detect('voice');
    assert(noPy.installed === false && /Python/.test(noPy.reason) && !pipSpawned, 'no Python → pip targets report "needs Python" without running pip');
    sm.configure({ execFile: cp.execFile });
    sm._resetPython();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
