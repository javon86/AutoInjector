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
const https = require('https');
const { URL } = require('url');
const { spawn } = require('child_process');

let settings = {
  enabled: false,
  endpoint: '',        // e.g. http://127.0.0.1:8232  (a voice shim base URL; no path)
  speakOnAck: true,    // speak the butler's ack + status updates aloud
  listenSeconds: 6,    // default record window for a push-to-talk listen
  // A distinct voice per speaker so you can tell who's talking. Values are
  // piper voice names the shim maps to a model (empty = the shim's default).
  voices: { butler: '', chatgpt: '', claude: '', gemini: '' },
  micDevice: '',       // preferred input (microphone) device — passed to the shim
  speakerDevice: '',   // preferred output (speaker) device — passed to the shim
  timeoutMs: 60000,
};
const managed = { child: null, lastError: '' };
// The address the managed shim listens on when nothing else is configured.
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8232';

function getSettings() { return { ...settings, voices: { ...settings.voices } }; }
function setSettings(patch) {
  if (!patch || typeof patch !== 'object') return getSettings();
  for (const k of ['enabled', 'speakOnAck']) if (k in patch) settings[k] = !!patch[k];
  for (const k of ['endpoint', 'micDevice', 'speakerDevice']) if (k in patch) settings[k] = String(patch[k] || '');
  if (patch.voices && typeof patch.voices === 'object') { for (const who of Object.keys(settings.voices)) if (who in patch.voices) settings.voices[who] = String(patch.voices[who] || ''); }
  if ('listenSeconds' in patch) { const n = Number(patch.listenSeconds); if (Number.isFinite(n)) settings.listenSeconds = Math.max(1, Math.min(60, n)); }
  if ('timeoutMs' in patch) settings.timeoutMs = Math.max(2000, Number(patch.timeoutMs) || settings.timeoutMs);
  return getSettings();
}
function status() {
  return { configured: !!settings.endpoint, enabled: !!settings.enabled, endpoint: settings.endpoint, speakOnAck: !!settings.speakOnAck, voices: { ...settings.voices }, micDevice: settings.micDevice, speakerDevice: settings.speakerDevice, managed: !!managed.child, managedPid: managed.child ? managed.child.pid : null, lastStartError: managed.lastError || '' };
}
// Resolve the piper voice for a speaker id (butler/chatgpt/claude/gemini).
function voiceFor(who) { return (settings.voices && settings.voices[who]) || ''; }

// ---- plain-language errors (OP-12) -----------------------------------------
// Callers keep getting the short machine code in `error` (ECONNREFUSED,
// NO_ENDPOINT, ...); `message` says in plain words what is wrong and what to do,
// so the UI never has to show a bare socket code.
const WHERE_SETTINGS = 'the Voice settings (System AI panel → 🔊 Voice)';
const HOW_TO_START = 'Start it from Setup Wizard → Installs → "Voice engine" (the app then runs it for you), or start the voice shim yourself (integrations/voice/voice_shim.py --port 8232)';

// Short, safe reason from an error body (JSON {error|detail|message} or text).
function _bodyDetail(buf) {
  const s = String(buf || '').slice(0, 2000);
  if (!s.trim()) return '';
  try {
    const j = JSON.parse(s);
    const m = j && (j.error || j.detail || j.message);
    if (m) return String(m).replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch { /* not JSON */ }
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

// explainError({ error, body? }, endpoint?) -> one or two plain sentences.
function explainError(r, endpoint) {
  const code = String((r && r.error) || 'UNKNOWN');
  const ep = endpoint != null ? String(endpoint) : settings.endpoint;
  const at = ep ? ` at ${ep}` : '';
  if (code === 'VOICE_DISABLED') return `Voice is turned off. Tick "Speak the butler's replies aloud" in ${WHERE_SETTINGS} and press Save.`;
  if (code === 'NO_ENDPOINT') return `No voice service address is set. Enter it in ${WHERE_SETTINGS} (usually ${DEFAULT_ENDPOINT}) and press Save.`;
  if (code === 'BAD_ENDPOINT') return `The voice address "${ep}" isn't a valid web address. Use something like ${DEFAULT_ENDPOINT} in ${WHERE_SETTINGS}.`;
  if (code === 'NEED_TEXT') return 'There was nothing to say.';
  if (code === 'ECONNREFUSED') {
    const tried = managed.lastError ? ` (The app tried to start the voice service but it didn't come up: ${managed.lastError}.)` : '';
    // On Windows "localhost" can resolve to the IPv6 ::1 while the shim listens
    // on 127.0.0.1 only — a common reason for a refused connection.
    let lh = '';
    try { if (new URL(ep).hostname === 'localhost') lh = ' If it is already running, try 127.0.0.1 instead of "localhost" in the address.'; } catch { /* not a URL */ }
    return `The voice service isn't running${at} — nothing answered at that address. ${HOW_TO_START}, or change the voice address in ${WHERE_SETTINGS} to where your voice service is running.${lh}${tried}`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `The voice address${at} names a computer that can't be found. Check the address in ${WHERE_SETTINGS} (for this computer use ${DEFAULT_ENDPOINT}).`;
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EADDRNOTAVAIL') return `The voice address${at} can't be reached from this computer. Check the address in ${WHERE_SETTINGS} (for this computer use ${DEFAULT_ENDPOINT}).`;
  if (code === 'TIMEOUT' || code === 'ETIMEDOUT') return `The voice service${at} didn't answer in time. It may be busy or stuck — restart it, or check the address in ${WHERE_SETTINGS}.`;
  if (code === 'ECONNRESET' || code === 'EPIPE') return `The voice service${at} dropped the connection — it may have crashed. Restart it (${HOW_TO_START.charAt(0).toLowerCase()}${HOW_TO_START.slice(1)}).`;
  if (code === 'HTTP_404' || code === 'HTTP_405' || code === 'BAD_JSON') return `Something is answering${at}, but it isn't the AutoInjector voice service. Check the voice address in ${WHERE_SETTINGS} — it should point at the voice shim (default ${DEFAULT_ENDPOINT}).`;
  if (/^HTTP_\d+$/.test(code)) {
    const d = _bodyDetail(r && r.body);
    return `The voice service${at} reported an error (${code.replace('_', ' ')}${d ? `: ${d}` : ''}). Check the voice service's window or the app log for details.`;
  }
  return `Voice didn't work${at}: ${code}.`;
}
// Attach the plain-language message to a failed result (success passes through).
function _withMessage(r) { return r && r.ok === false ? { ...r, message: explainError(r) } : r; }

// ---- cheap connectivity check (GET /health) ---------------------------------
// Used by diagnostics and the settings Test so a dead address is reported in
// plain words before anything tries to speak. Never rejects.
function checkConnection(opts = {}) {
  const ep = settings.endpoint;
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (settled) return; settled = true;
      if (r.ok) return resolve({ ok: true, reachable: true, endpoint: ep, message: `The voice service is running at ${ep}.` });
      resolve({ ...r, ok: false, reachable: false, endpoint: ep, message: explainError(r, ep) });
    };
    if (!ep) return done({ ok: false, error: 'NO_ENDPOINT' });
    let base; try { base = new URL(ep); } catch { return done({ ok: false, error: 'BAD_ENDPOINT' }); }
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return done({ ok: false, error: 'BAD_ENDPOINT' });
    const lib = base.protocol === 'https:' ? https : http;
    let req;
    try {
      req = lib.request(
        { hostname: base.hostname, port: base.port || (base.protocol === 'https:' ? 443 : 80), path: '/health', method: 'GET', timeout: Math.max(300, Number(opts.timeoutMs) || 2000), headers: { Accept: 'application/json' } },
        (res) => {
          let buf = ''; res.setEncoding('utf8');
          res.on('data', (d) => { if (buf.length < 4096) buf += d; });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 400) return done({ ok: false, error: `HTTP_${res.statusCode}`, body: buf });
            let j = null; try { j = JSON.parse(buf || ''); } catch { /* not JSON */ }
            if (!j || typeof j !== 'object' || j.ok === false) return done({ ok: false, error: 'BAD_JSON' });
            done({ ok: true });
          });
          res.on('error', (e) => done({ ok: false, error: String((e && e.code) || (e && e.message) || e) }));
        }
      );
    } catch (e) { return done({ ok: false, error: String((e && e.code) || (e && e.message) || e) }); }
    req.on('error', (e) => done({ ok: false, error: String((e && e.code) || (e && e.message) || e) }));
    req.on('timeout', () => { done({ ok: false, error: 'TIMEOUT' }); try { req.destroy(); } catch {} });
    req.end();
  });
}

// ---- one JSON request/response --------------------------------------------
function _postJson(pathName, body) {
  return new Promise((resolve) => {
    if (!settings.endpoint) return resolve({ ok: false, error: 'NO_ENDPOINT' });
    let base; try { base = new URL(settings.endpoint); } catch { return resolve({ ok: false, error: 'BAD_ENDPOINT' }); }
    const lib = base.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body || {});
    const req = lib.request(
      { hostname: base.hostname, port: base.port || (base.protocol === 'https:' ? 443 : 80), path: pathName, method: 'POST', timeout: settings.timeoutMs, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Accept: 'application/json' } },
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

// Speak text aloud, in a chosen speaker's voice. Fire-and-forget; never rejects.
// opts.who ('butler'|'chatgpt'|'claude'|'gemini') picks that speaker's voice;
// opts.voice overrides directly. The output device is passed to the shim.
async function speak(text, opts = {}) {
  const t = String(text || '').trim();
  if (!t) return _withMessage({ ok: false, error: 'NEED_TEXT' });
  if (!settings.enabled) return _withMessage({ ok: false, error: 'VOICE_DISABLED' });
  const voice = opts.voice || voiceFor(opts.who) || '';
  const body = { text: t };
  if (voice) body.voice = voice;
  if (settings.speakerDevice) body.device = settings.speakerDevice;
  return _withMessage(await _postJson('/speak', body));
}
// Record + transcribe. Resolves { ok, text }. The input device is passed along.
async function listen(opts = {}) {
  if (!settings.enabled) return _withMessage({ ok: false, error: 'VOICE_DISABLED' });
  const seconds = Math.max(1, Math.min(60, Number(opts.seconds) || settings.listenSeconds));
  const body = { seconds };
  if (settings.micDevice) body.device = settings.micDevice;
  return _withMessage(await _postJson('/listen', body));
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
  managed.lastError = '';
  let child;
  try {
    child = spawn(command, Array.isArray(opts.args) ? opts.args : [], { cwd: opts.cwd || undefined, env: Object.assign({}, process.env, opts.env || {}), stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { managed.lastError = `could not run "${command}": ${(e && e.message) || e}`; return { ok: false, error: String((e && e.message) || e) }; }
  managed.child = child;
  try {
    if (child.stdout) child.stdout.on('data', (d) => onLog('stdout', String(d)));
    if (child.stderr) child.stderr.on('data', (d) => onLog('stderr', String(d)));
  } catch {}
  child.on('exit', (code) => {
    onLog('exit', `voice shim exited (${code})`);
    if (managed.child === child) { managed.child = null; if (!managed.lastError) managed.lastError = `the voice shim exited (code ${code}) — check the app log for its output`; }
  });
  child.on('error', (e) => { managed.lastError = `could not run "${command}": ${(e && e.message) || e}`; onLog('error', String((e && e.message) || e)); if (managed.child === child) managed.child = null; });
  const ready = await _waitForHealth(host, port, readyTimeoutMs);
  if (!ready || managed.child !== child) {
    if (!managed.lastError) managed.lastError = `it did not answer on http://${host}:${port} within ${Math.round(readyTimeoutMs / 1000)}s (check the app log for the voice shim's output)`;
    stopManaged(); return { ok: false, error: 'SHIM_NOT_READY' };
  }
  managed.lastError = '';
  const endpoint = `http://${host}:${port}`;
  setSettings({ enabled: true, endpoint });
  return { ok: true, endpoint, pid: child.pid };
}
function stopManaged() {
  if (managed.child) { try { managed.child.kill(); } catch {} managed.child = null; return { ok: true, stopped: true }; }
  return { ok: true, stopped: false };
}

module.exports = { DEFAULT_ENDPOINT, getSettings, setSettings, status, speak, listen, checkConnection, explainError, startManaged, stopManaged };
