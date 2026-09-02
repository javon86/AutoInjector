'use strict';
// voice-provider.js — the butler's voice capability (N2). Fully local, matching
// AutoInjector's no-cloud ethos: it talks to a small local shim
// (integrations/voice/voice_shim.py) that wraps piper (text-to-speech) and
// whisper.cpp / faster-whisper (speech-to-text). Shaped exactly like
// interpreter-provider.js (settings + status + startManaged) so the app can run
// the shim for the user.
//
// Transport contract (small + tolerant):
//   GET  /health                       -> { ok:true, service:"voice-shim" }
//   POST /speak   { text }             -> { ok, ms? }   (plays audio on the host)
//   POST /listen  { seconds? }         -> { ok, text }  (records + transcribes)
// Both POSTs return a single JSON object (not a stream) -- speech is naturally
// request/response, unlike Open Interpreter's event stream.
const http = require('http');
const { URL } = require('url');
const { spawn } = require('child_process');

let settings = {
  enabled: false,
  endpoint: '',        // e.g. http://127.0.0.1:8232  (a voice shim base URL; no path)
  speakOnAck: true,    // speak the butler's ack + status updates aloud
  listenSeconds: 6,    // default record window for a push-to-talk listen
  timeoutMs: 60000,
};
const managed = { child: null };

function getSettings() { return { ...settings }; }
function setSettings(patch) {
  if (!patch || typeof patch !== 'object') return getSettings();
  for (const k of ['enabled', 'speakOnAck']) if (k in patch) settings[k] = !!patch[k];
  if ('endpoint' in patch) settings.endpoint = String(patch.endpoint || '');
  if ('listenSeconds' in patch) { const n = Number(patch.listenSeconds); if (Number.isFinite(n)) settings.listenSeconds = Math.max(1, Math.min(60, n)); }
  if ('timeoutMs' in patch) settings.timeoutMs = Math.max(2000, Number(patch.timeoutMs) || settings.timeoutMs);
  return getSettings();
}
function status() {
  return { configured: !!settings.endpoint, enabled: !!settings.enabled, endpoint: settings.endpoint, speakOnAck: !!settings.speakOnAck, managed: !!managed.child, managedPid: managed.child ? managed.child.pid : null };
}

// ---- one JSON request/response --------------------------------------------
function _postJson(pathName, body) {
  return new Promise((resolve) => {
    if (!settings.endpoint) return resolve({ ok: false, error: 'NO_ENDPOINT' });
    let base; try { base = new URL(settings.endpoint); } catch { return resolve({ ok: false, error: 'BAD_ENDPOINT' }); }
    const payload = JSON.stringify(body || {});
    const req = http.request(
      { hostname: base.hostname, port: base.port || 80, path: pathName, method: 'POST', timeout: settings.timeoutMs, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Accept: 'application/json' } },
      (res) => {
        let buf = ''; res.setEncoding('utf8');
        res.on('data', (d) => { buf += d; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) return resolve({ ok: false, error: `HTTP_${res.statusCode}`, body: buf });
          try { const j = JSON.parse(buf || '{}'); resolve(j && j.ok === false ? { ok: false, ...j } : { ok: true, ...j }); }
          catch { resolve({ ok: false, error: 'BAD_JSON', body: buf }); }
        });
        res.on('error', (e) => resolve({ ok: false, error: String((e && e.message) || e) }));
      }
    );
    req.on('error', (e) => resolve({ ok: false, error: String((e && e.code) || (e && e.message) || e) }));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ ok: false, error: 'TIMEOUT' }); });
    req.write(payload); req.end();
  });
}

// Speak text aloud. Fire-and-forget friendly: never rejects.
async function speak(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, error: 'NEED_TEXT' };
  if (!settings.enabled) return { ok: false, error: 'VOICE_DISABLED' };
  return _postJson('/speak', { text: t });
}
// Record + transcribe. Resolves { ok, text }.
async function listen(opts = {}) {
  if (!settings.enabled) return { ok: false, error: 'VOICE_DISABLED' };
  const seconds = Math.max(1, Math.min(60, Number(opts.seconds) || settings.listenSeconds));
  return _postJson('/listen', { seconds });
}

// ---- Managed mode: the app runs the shim itself (same pattern as OI) --------
function _pingHealth(host, port, cb) {
  const req = http.request({ hostname: host, port, path: '/health', method: 'GET', timeout: 1500 }, (res) => { res.resume(); cb(res.statusCode && res.statusCode < 500); });
  req.on('error', () => cb(false));
  req.on('timeout', () => { try { req.destroy(); } catch {} cb(false); });
  req.end();
}
function _waitForHealth(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => _pingHealth(host, port, (ok) => {
      if (ok) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 400);
    });
    tick();
  });
}
async function startManaged(opts = {}) {
  const command = opts.command;
  if (!command) return { ok: false, error: 'NO_COMMAND' };
  const host = opts.host || '127.0.0.1';
  const port = Number(opts.port) || 8232;
  const readyTimeoutMs = Number(opts.readyTimeoutMs) || 20000;
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  stopManaged();
  let child;
  try {
    child = spawn(command, Array.isArray(opts.args) ? opts.args : [], { cwd: opts.cwd || undefined, env: Object.assign({}, process.env, opts.env || {}), stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  managed.child = child;
  try {
    if (child.stdout) child.stdout.on('data', (d) => onLog('stdout', String(d)));
    if (child.stderr) child.stderr.on('data', (d) => onLog('stderr', String(d)));
  } catch {}
  child.on('exit', (code) => { onLog('exit', `voice shim exited (${code})`); if (managed.child === child) managed.child = null; });
  child.on('error', (e) => { onLog('error', String((e && e.message) || e)); if (managed.child === child) managed.child = null; });
  const ready = await _waitForHealth(host, port, readyTimeoutMs);
  if (!ready || managed.child !== child) { stopManaged(); return { ok: false, error: 'SHIM_NOT_READY' }; }
  const endpoint = `http://${host}:${port}`;
  setSettings({ enabled: true, endpoint });
  return { ok: true, endpoint, pid: child.pid };
}
function stopManaged() {
  if (managed.child) { try { managed.child.kill(); } catch {} managed.child = null; return { ok: true, stopped: true }; }
  return { ok: true, stopped: false };
}

module.exports = { getSettings, setSettings, status, speak, listen, startManaged, stopManaged };
