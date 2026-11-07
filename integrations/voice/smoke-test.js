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

  // 🎤 /transcribe and 🔊 /synthesize argument checks (no model needed).
  const noAudio = await req('POST', '/transcribe', {});
  if (noAudio.status === 400 && /NEED_AUDIO/.test(noAudio.body || '')) ok('POST /transcribe with no audio -> 400 NEED_AUDIO');
  else bad(`expected 400 NEED_AUDIO, got ${noAudio.status} ${(noAudio.body || noAudio.error || '').slice(0, 80)}`);
  const numAudio = await req('POST', '/transcribe', { audio_b64: 12345 });
  if (numAudio.status === 400 && /NEED_AUDIO/.test(numAudio.body || '')) ok('POST /transcribe with a non-text audio_b64 -> 400 NEED_AUDIO');
  else bad(`expected 400 NEED_AUDIO for a number, got ${numAudio.status} ${(numAudio.body || '').slice(0, 80)}`);
  const junk = await req('POST', '/transcribe', { audio_b64: Buffer.from('not really audio at all').toString('base64'), mime: 'audio/webm' });
  let jj = {}; try { jj = JSON.parse(junk.body || '{}'); } catch (_) {}
  if (junk.status === 200 && jj.ok === false && /^(NO_STT|BAD_AUDIO|STT_FAILED)$/.test(jj.error || '')) ok(`POST /transcribe with junk audio -> a clean {ok:false, error:${jj.error}} (no crash)`);
  else if (junk.status === 200 && jj.ok === true) note('junk audio was accepted as silence (speech-to-text installed)');
  else bad(`junk /transcribe: ${junk.status} ${(junk.body || junk.error || '').slice(0, 120)}`);
  const noText = await req('POST', '/synthesize', { text: '   ' });
  if (noText.status === 400 && /NEED_TEXT/.test(noText.body || '')) ok('POST /synthesize with no text -> 400 NEED_TEXT');
  else bad(`expected 400 NEED_TEXT from /synthesize, got ${noText.status} ${(noText.body || '').slice(0, 80)}`);
  const badVoice = await req('POST', '/synthesize', { text: 'hello', voice: '../../etc/passwd' });
  if (badVoice.status === 400 && /BAD_VOICE/.test(badVoice.body || '')) ok('POST /synthesize with a path as the voice -> 400 BAD_VOICE');
  else bad(`expected 400 BAD_VOICE, got ${badVoice.status} ${(badVoice.body || '').slice(0, 80)}`);
  const longText = await req('POST', '/synthesize', { text: 'a'.repeat(4001) });
  if (longText.status === 413 && /TEXT_TOO_LONG/.test(longText.body || '')) ok('POST /synthesize with 4001 characters -> 413 TEXT_TOO_LONG');
  else bad(`expected 413 TEXT_TOO_LONG, got ${longText.status} ${(longText.body || '').slice(0, 80)}`);
  const syn = await req('POST', '/synthesize', { text: 'hello' });
  let sj = {}; try { sj = JSON.parse(syn.body || '{}'); } catch (_) {}
  if (syn.status === 200 && sj.ok && sj.audio_b64) ok(`/synthesize returned a WAV (${Math.round(sj.audio_b64.length * 0.75 / 1024)} KB, voice ${sj.voice})`);
  else if (syn.status === 200 && sj.ok === false) note(`/synthesize: shim OK, no piper voice (${sj.error})`);
  else bad(`/synthesize: ${syn.status} ${(syn.body || syn.error || '').slice(0, 80)}`);
  const voices = await req('GET', '/voices');
  let vj = {}; try { vj = JSON.parse(voices.body || '{}'); } catch (_) {}
  if (voices.status === 200 && vj.ok && Array.isArray(vj.voices)) ok(`GET /voices lists ${vj.voices.length} piper voice(s)`);
  else bad(`GET /voices: ${voices.status} ${(voices.body || '').slice(0, 80)}`);
  try { const h = JSON.parse(health.body || '{}'); if ('stt_model' in h && 'stt_loaded' in h && 'stt_mb' in h) ok(`/health says which speech model (${h.stt_model || 'none'}, ${h.stt_mb} MB, loaded=${h.stt_loaded})`); else bad('/health lacks stt_model / stt_loaded / stt_mb'); } catch (_) { bad('/health is not JSON'); }

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
