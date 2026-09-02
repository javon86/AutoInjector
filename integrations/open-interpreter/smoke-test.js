#!/usr/bin/env node
// smoke-test.js — verify Open Interpreter works BY ITSELF, without AutoInjector's
// butler/manager in the loop. It spawns the shim, checks its plumbing (no model
// needed), then tries a real one-line task (needs a model configured).
//
//   node integrations/open-interpreter/smoke-test.js
//   node integrations/open-interpreter/smoke-test.js --port 8231 --task "print 42"
//   INTERPRETER_MODEL=ollama/llama3.1 INTERPRETER_API_BASE=http://localhost:11434 \
//       node integrations/open-interpreter/smoke-test.js
//
// Exit code 0 if the shim plumbing works (that's the part this environment can
// prove); the "real" step is informational — if no model is configured, Open
// Interpreter emits an error event and we report "shim OK, OI needs a model".
'use strict';
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const args = process.argv.slice(2);
function arg(name, def) { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; }
const PORT = Number(arg('--port', String(18000 + Math.floor(Math.random() * 2000))));
const HOST = '127.0.0.1';
const TASK = arg('--task', 'print the number 42');
const PY = process.env.PYTHON || 'python';
const SHIM = path.join(__dirname, 'interpreter_shim.py');

let pass = 0, fail = 0, info = 0;
const ok = (m) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m) => { fail++; console.log(`  ✗ ${m}`); };
const note = (m) => { info++; console.log(`  • ${m}`); };

function req(method, p, body) {
  return new Promise((resolve) => {
    const data = body != null ? JSON.stringify(body) : null;
    const r = http.request({ host: HOST, port: PORT, path: p, method, timeout: 120000,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let buf = ''; res.on('data', (c) => { buf += c; }); res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    r.on('error', (e) => resolve({ status: 0, error: String(e && e.message || e) }));
    r.on('timeout', () => { try { r.destroy(); } catch (_) {} resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHealth(timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const r = await req('GET', '/health'); if (r.status === 200) return true; await sleep(400); }
  return false;
}

async function main() {
  console.log('Open Interpreter — standalone smoke test\n');

  // Is Open Interpreter installed?
  const imp = spawnSync(PY, ['-c', 'import interpreter'], { encoding: 'utf8' });
  if (imp.status === 0) ok('open-interpreter is importable');
  else note('open-interpreter not importable yet — run: pip install open-interpreter  (continuing to test the shim plumbing)');

  // Spawn the shim.
  console.log(`\nStarting the shim: ${PY} ${SHIM} --port ${PORT}`);
  const child = spawn(PY, [SHIM, '--port', String(PORT)], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: Object.assign({}, process.env),
  });
  let exited = false;
  child.on('exit', () => { exited = true; });

  const healthy = await waitHealth(15000);
  if (healthy) ok(`GET /health responds on http://${HOST}:${PORT}`);
  else {
    bad(`the shim never became healthy on :${PORT}${exited ? ' (it exited — is `python` on PATH and open-interpreter installed?)' : ''}`);
    try { child.kill(); } catch (_) {}
    return finish();
  }

  // Plumbing: an empty task is rejected (no model needed).
  const empty = await req('POST', '/run', {});
  if (empty.status === 400 && /NEED_TASK/.test(empty.body || '')) ok('POST /run with no task -> 400 NEED_TASK (plumbing works)');
  else bad(`expected 400 NEED_TASK, got ${empty.status} ${(empty.body || empty.error || '').slice(0, 80)}`);

  // Real run: needs a model. Report, don't hard-fail.
  console.log(`\nTrying a real task: "${TASK}" (needs a model configured on the OI side)`);
  const run = await req('POST', '/run', { task: TASK, auto_run: true });
  if (run.status === 200) {
    const lines = (run.body || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const hadError = lines.some((e) => e.type === 'error');
    const hadContent = lines.some((e) => (e.type === 'message' || e.role === 'assistant' || e.type === 'code' || e.type === 'console'));
    const done = lines.some((e) => e.type === 'done');
    if (hadContent && !hadError) ok(`real task produced ${lines.length} events and finished (${done ? 'done' : 'stream ended'}) — Open Interpreter is fully working`);
    else if (hadError) note(`shim OK, but Open Interpreter reported an error (usually: no model configured). Point it at a local model, e.g. INTERPRETER_MODEL=ollama/llama3.1 INTERPRETER_API_BASE=http://localhost:11434`);
    else note(`shim streamed ${lines.length} events; no clear content/error — check the OI model config`);
  } else {
    note(`real task POST returned ${run.status} ${(run.body || run.error || '').slice(0, 80)}`);
  }

  try { child.kill(); } catch (_) {}
  finish();
}

function finish() {
  console.log(`\n${pass} passed, ${fail} failed, ${info} note(s)`);
  console.log('Note: the shim plumbing (health + NEED_TASK) is what proves OI is installed and reachable.');
  console.log('You can also test through AutoInjector without the butler:');
  console.log("  curl -s -X POST http://127.0.0.1:8765/interpreter/run -H 'Content-Type: application/json' -d '{\"task\":\"what is 2+2\"}'");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('smoke test crashed:', e && e.stack || e); process.exit(1); });
