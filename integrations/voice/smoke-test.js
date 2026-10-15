#!/usr/bin/env node
// smoke-test.js — verify the local VOICE shim works BY ITSELF, without
// AutoInjector's butler/manager in the loop. It spawns the shim, checks its
// plumbing (no model needed), then tries a real /speak (needs a TTS backend).
//
//   node integrations/voice/smoke-test.js
//   node integrations/voice/smoke-test.js --port 8232 --text "hello there"
//   PYTHON=python3 node integrations/voice/smoke-test.js
//
// Exit code 0 if the shim plumbing works (that's the part this environment can
// prove); the "real" speak step is informational — with no TTS backend the shim
// answers {ok:false, error:NO_TTS}, reported as "shim OK, needs a backend".
'use strict';
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
function arg(name, def) { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; }
const PORT = Number(arg('--port', String(18200 + Math.floor(Math.random() * 1500))));
const HOST = '127.0.0.1';
const TEXT = arg('--text', 'AutoInjector voice is working.');
const PY = process.env.PYTHON || 'python';
const SHIM = path.join(__dirname, 'voice_shim.py');

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
  console.log('AutoInjector Voice — standalone smoke test\n');
  console.log(`Starting the shim: ${PY} ${SHIM} --port ${PORT}`);
  const child = spawn(PY, [SHIM, '--port', String(PORT)], { stdio: ['ignore', 'inherit', 'inherit'], env: Object.assign({}, process.env) });
  let exited = false;
  child.on('exit', () => { exited = true; });

  const healthy = await waitHealth(15000);
  if (healthy) ok(`GET /health responds on http://${HOST}:${PORT}`);
  else {
    bad(`the shim never became healthy on :${PORT}${exited ? ' (it exited — is `python` on PATH?)' : ''}`);
    try { child.kill(); } catch (_) {}
    return finish();
  }

  // Report which backends the shim found (informational).
  const health = await req('GET', '/health');
  try { const h = JSON.parse(health.body || '{}'); note(`backends: tts=${!!h.tts}, stt=${!!h.stt}`); } catch (_) {}

  // Plumbing: an empty /speak is rejected (no backend needed).
  const empty = await req('POST', '/speak', {});
  if (empty.status === 400 && /NEED_TEXT/.test(empty.body || '')) ok('POST /speak with no text -> 400 NEED_TEXT (plumbing works)');
  else bad(`expected 400 NEED_TEXT, got ${empty.status} ${(empty.body || empty.error || '').slice(0, 80)}`);

  // A bad JSON body is rejected cleanly.
  const bj = await new Promise((resolve) => {
    const r = http.request({ host: HOST, port: PORT, path: '/speak', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 3 } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', () => resolve({ status: 0 }));
    r.write('{ x'); r.end();
  });
  if (bj.status === 400 && /BAD_JSON/.test(bj.body || '')) ok('POST /speak with bad JSON -> 400 BAD_JSON');
  else note(`bad-JSON check returned ${bj.status} ${(bj.body || '').slice(0, 60)}`);

  // Real speak: needs a TTS backend. Report, don't hard-fail.
  console.log(`\nTrying a real /speak: "${TEXT}" (needs a TTS backend: piper or say/espeak)`);
  const spoke = await req('POST', '/speak', { text: TEXT });
  if (spoke.status === 200) {
    let j = {}; try { j = JSON.parse(spoke.body || '{}'); } catch (_) {}
    if (j.ok) ok(`/speak succeeded (${j.ms}ms) — voice output is fully working`);
    else note(`shim OK, but no TTS backend (${j.error}${j.hint ? ' — ' + j.hint : ''})`);
  } else {
    note(`/speak returned ${spoke.status} ${(spoke.body || spoke.error || '').slice(0, 80)}`);
  }

  try { child.kill(); } catch (_) {}
  finish();
}

function finish() {
  console.log(`\n${pass} passed, ${fail} failed, ${info} note(s)`);
  console.log('Note: the shim plumbing (health + NEED_TEXT + BAD_JSON) is what proves the voice bridge is reachable.');
  console.log('You can also test through AutoInjector without the butler:');
  console.log("  curl -s -X POST http://127.0.0.1:8765/voice/speak -H 'Content-Type: application/json' -d '{\"text\":\"hello\"}'");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('smoke test crashed:', e && e.stack || e); process.exit(1); });
