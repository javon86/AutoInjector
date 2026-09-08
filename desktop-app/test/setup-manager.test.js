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
  t.files.forEach((f) => { f.url = `http://127.0.0.1:${port}/${f.name}`; });
  sm.configure({ modelsDir: (cat) => { const d = path.join(modelsBase, cat); fs.mkdirSync(d, { recursive: true }); return d; } });
  const dl = await sm.install('voice-model', { onProgress: () => {} });
  assert(dl.ok, 'the download target resolves ok against a reachable server');
  assert(fs.existsSync(path.join(modelsBase, 'voice', 'en_US-lessac-medium.onnx')), 'the voice model file landed in models/voice');
  const det = await sm.detect('voice-model');
  assert(det.installed === true, 'detect() sees the downloaded files as installed');
  stub.close();
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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
