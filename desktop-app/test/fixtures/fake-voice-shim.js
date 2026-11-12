#!/usr/bin/env node
'use strict';
// fake-voice-shim.js — a tiny stand-in for integrations/voice/voice_shim.py (no whisper, no piper) for the 🎤 / 🔊
// tests. Same contract: GET /health, POST /transcribe {audio_b64, mime}, POST /synthesize {text, voice}, GET /voices.
//   node test/fixtures/fake-voice-shim.js --port 8232          (the app can run it: AUTOINJECTOR_VOICE_SPAWN=node,
//                                                               AUTOINJECTOR_VOICE_SHIM=<this file>)
//   const { startFakeVoiceShim } = require('./fake-voice-shim'); const s = await startFakeVoiceShim({ text: 'hi' });
// Env / options: FAKE_VOICE_TEXT (what it "heard"; default "hello from the microphone"), FAKE_VOICE_PIPER=1 (piper
// voices installed: /synthesize returns a short silent WAV), FAKE_VOICE_DELAY_MS (slow transcription),
// FAKE_VOICE_KOKORO=ready|fail (✨ Kokoro installed; "fail": it breaks on every request so piper reads instead).
// GET /__calls lists what it was asked (path, audio size, mime, voice) — never used by the app.
const http = require('http');

function silentWav(ms = 200, rate = 16000) {
  const n = Math.round((rate * ms) / 1000);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
}

function startFakeVoiceShim(opts = {}) {
  const o = {
    text: opts.text != null ? opts.text : (process.env.FAKE_VOICE_TEXT || 'hello from the microphone'),
    piper: opts.piper != null ? !!opts.piper : process.env.FAKE_VOICE_PIPER === '1',
    delayMs: Number(opts.delayMs != null ? opts.delayMs : process.env.FAKE_VOICE_DELAY_MS) || 0,
    stt: opts.stt !== false,
    kokoro: opts.kokoro != null ? opts.kokoro : (process.env.FAKE_VOICE_KOKORO || ''), // '' | 'ready' | 'fail'
    python: opts.python != null ? opts.python : '/fake/voice-engine/python', // the interpreter it says it runs in
  };
  const calls = [];
  let loaded = false;
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', async () => {
      const send = (code, obj) => { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length, Connection: 'close' }); res.end(b); };
      const url = (req.url || '').replace(/\/+$/, '') || '/';
      if (req.method === 'GET' && (url === '/' || url === '/health')) return send(200, { ok: true, service: 'voice-shim', fake: true, tts: true, stt: o.stt, piper_voices: o.piper ? 2 : 0, stt_model: 'base.en', stt_loaded: loaded, stt_cached: false, stt_mb: 145, kokoro: !!o.kokoro, kokoro_model: !!o.kokoro, kokoro_ready: !!o.kokoro, kokoro_loaded: false, kokoro_device: '', python: o.python });
      if (req.method === 'GET' && url === '/voices') return send(200, { ok: true, voices: o.piper ? ['en_US-lessac-medium', 'en_GB-alan-medium'] : [] });
      if (req.method === 'GET' && url === '/__calls') return send(200, { ok: true, calls });
      if (req.method !== 'POST') return send(404, { ok: false, error: 'NOT_FOUND' });
      let body;
      try { body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch (_) { return send(400, { ok: false, error: 'BAD_JSON' }); }
      if (url === '/transcribe') {
        if (typeof body.audio_b64 !== 'string' || !body.audio_b64.trim()) return send(400, { ok: false, error: 'NEED_AUDIO' });
        const bytes = Buffer.from(body.audio_b64, 'base64');
        calls.push({ path: '/transcribe', bytes: bytes.length, mime: body.mime || '' });
        if (!o.stt) return send(200, { ok: false, error: 'NO_STT', detail: 'pip install faster-whisper' });
        if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
        loaded = true;
        const said = bytes.slice(0, 7).toString('latin1') === 'SILENCE' ? '' : o.text;
        return send(200, { ok: true, text: said, ms: 5, device: 'cpu', model: 'base.en' });
      }
      if (url === '/synthesize') {
        if (typeof body.text !== 'string' || !body.text.trim()) return send(400, { ok: false, error: 'NEED_TEXT' });
        calls.push({ path: '/synthesize', chars: body.text.length, voice: body.voice || '', engine: body.engine || '', kokoro_voice: body.kokoro_voice || '', device: body.device || '' });
        let extra = {};
        if (body.engine === 'kokoro') {
          if (o.kokoro === 'ready') return send(200, { ok: true, audio_b64: silentWav(200, 24000).toString('base64'), mime: 'audio/wav', voice: body.kokoro_voice || 'af_heart', engine: 'kokoro', device: body.device === 'gpu' ? 'gpu' : 'cpu' });
          extra = { fallback_from: 'kokoro', kokoro_error: o.kokoro ? 'KOKORO_FAILED' : 'NO_KOKORO' };
        }
        if (!o.piper) return send(200, { ok: false, error: 'NO_TTS_MODEL', detail: 'no piper voice', ...extra });
        return send(200, { ok: true, audio_b64: silentWav().toString('base64'), mime: 'audio/wav', voice: body.voice || 'en_US-lessac-medium', engine: 'piper', ...extra });
      }
      return send(404, { ok: false, error: 'NOT_FOUND' });
    });
  });
  return new Promise((resolve) => {
    server.listen(Number(opts.port) || 0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ port, base: `http://127.0.0.1:${port}`, calls, options: o, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

module.exports = { startFakeVoiceShim, silentWav };

if (require.main === module) {
  const i = process.argv.indexOf('--port');
  const port = i >= 0 ? Number(process.argv[i + 1]) : 8232;
  startFakeVoiceShim({ port }).then((s) => console.log(`fake voice-shim listening on ${s.base}`));
}
