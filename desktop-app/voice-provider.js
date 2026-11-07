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
const os = require('os');
const { redact } = require('./log-extract');

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
  // 🎤 / 🔊 in the control panel (voice-ui.js): who the title-bar mic sends to, the read-aloud speed, and the
  // built-in (no-install) voice per speaker — the browser's own voices, used when piper isn't there.
  micTarget: 'all',    // 'all' | 'chatgpt' | 'claude' | 'gemini' | 'butler'
  rate: 1,             // read-aloud speed (0.5 – 2)
  browserVoices: { butler: '', chatgpt: '', claude: '', gemini: '' },
};
const MIC_TARGETS = ['all', 'chatgpt', 'claude', 'gemini', 'butler'];
const managed = { child: null, lastError: '' };
// The address the managed shim listens on when nothing else is configured.
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8232';

function getSettings() { return { ...settings, voices: { ...settings.voices }, browserVoices: { ...settings.browserVoices } }; }
function setSettings(patch) {
  if (!patch || typeof patch !== 'object') return getSettings();
  for (const k of ['enabled', 'speakOnAck']) if (k in patch) settings[k] = !!patch[k];
  for (const k of ['endpoint', 'micDevice', 'speakerDevice']) if (k in patch) settings[k] = String(patch[k] || '');
  if (patch.voices && typeof patch.voices === 'object') { for (const who of Object.keys(settings.voices)) if (who in patch.voices) settings.voices[who] = String(patch.voices[who] || ''); }
  if ('listenSeconds' in patch) { const n = Number(patch.listenSeconds); if (Number.isFinite(n)) settings.listenSeconds = Math.max(1, Math.min(60, n)); }
  if ('timeoutMs' in patch) settings.timeoutMs = Math.max(2000, Number(patch.timeoutMs) || settings.timeoutMs);
  if ('micTarget' in patch && MIC_TARGETS.includes(patch.micTarget)) settings.micTarget = patch.micTarget;
  if ('rate' in patch) { const n = Number(patch.rate); if (Number.isFinite(n)) settings.rate = Math.max(0.5, Math.min(2, Math.round(n * 100) / 100)); }
  if (patch.browserVoices && typeof patch.browserVoices === 'object') { for (const who of Object.keys(settings.browserVoices)) if (who in patch.browserVoices) settings.browserVoices[who] = String(patch.browserVoices[who] || '').slice(0, 200); }
  return getSettings();
}
function status() {
  return { configured: !!settings.endpoint, enabled: !!settings.enabled, endpoint: settings.endpoint, speakOnAck: !!settings.speakOnAck, voices: { ...settings.voices }, micDevice: settings.micDevice, speakerDevice: settings.speakerDevice, micTarget: settings.micTarget, rate: settings.rate, browserVoices: { ...settings.browserVoices }, managed: !!managed.child, managedPid: managed.child ? managed.child.pid : null, lastStartError: managed.lastError || '' };
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

// Paths in a message are shown the way the log extract shows them: your home
// folder as ~ (and any other private path as [private path]) — never a raw
// "C:\Users\<your name>\…". Same redaction code as log-extract.js.
// main.js hands in the same options the log extract uses (home + the app's own
// folders, which stay readable as ~/…; anything else private is [private path]).
let _home = '';
try { _home = os.homedir(); } catch { _home = ''; }
let _redactionProvider = null;
function setRedactionProvider(fn) { _redactionProvider = typeof fn === 'function' ? fn : null; }
function redactPaths(text) {
  const s = String(text == null ? '' : text);
  let opts = null;
  try { opts = _redactionProvider ? _redactionProvider() : null; } catch { opts = null; }
  if (!opts || typeof opts !== 'object') opts = { home: _home };
  try { return redact(s, opts).text; } catch { return s; }
}

// A voice model that onnxruntime can't load: piper's "[ONNXRuntimeError] : 1 :
// FAIL : Load model from …\models\voice\en_US-lessac-medium.onnx failed: …",
// "Protobuf parsing failed", … — the .onnx file is corrupt or only partly
// downloaded. Returns { file } (the voice file's name, when it can be read) or null.
const ONNX_LOAD_RE = /ONNXRuntimeError|Load model from|Protobuf parsing failed|INVALID_PROTOBUF|\bonnx\b[^\n]{0,80}\b(?:corrupt|truncated|invalid model)/i;
function voiceModelProblem(r) {
  if (!r || r.ok !== false) return null;
  const parts = [r.error, r.detail, r.reason, r.stderr];
  try { if (r.body) parts.push(_bodyDetail(r.body)); } catch { /* ignore */ }
  const raw = parts.filter((x) => typeof x === 'string' && x).join(' ');
  if (!raw || !ONNX_LOAD_RE.test(raw)) return null;
  const m = raw.match(/([^\\/\s"'`:]+\.onnx)(?![A-Za-z0-9.])/i);
  return { file: m ? m[1] : '', raw };
}
const REDOWNLOAD_HOW = 'press "Re-download the voice" in the capability test results (it fetches a fresh copy and checks its size), or delete that file from the models/voice folder and run Setup Wizard → Installs → "Voice model"';

// explainError({ error, body? }, endpoint?) -> one or two plain sentences.
function explainError(r, endpoint) {
  const code = String((r && r.error) || 'UNKNOWN');
  const ep = endpoint != null ? String(endpoint) : settings.endpoint;
  const at = ep ? ` at ${ep}` : '';
  const bad = voiceModelProblem(r);
  if (bad || code === 'VOICE_MODEL_DAMAGED') {
    const file = (bad && bad.file) || (r && r.voiceFile) || '';
    return `The voice file${file ? ` (${file})` : ''} is damaged or incomplete — re-download it: ${REDOWNLOAD_HOW}.`;
  }
  if (code === 'VOICE_DISABLED') return `Voice is turned off. Tick "Speak the butler's replies aloud" in ${WHERE_SETTINGS} and press Save.`;
  if (code === 'NO_ENDPOINT') return `No voice service address is set. Enter it in ${WHERE_SETTINGS} (usually ${DEFAULT_ENDPOINT}) and press Save.`;
  if (code === 'BAD_ENDPOINT') return `The voice address "${ep}" isn't a valid web address. Use something like ${DEFAULT_ENDPOINT} in ${WHERE_SETTINGS}.`;
  if (code === 'NEED_TEXT') return 'There was nothing to say.';
  if (code === 'NEED_AUDIO') return 'Nothing was recorded — try the 🎤 again and speak after it turns red.';
  if (code === 'AUDIO_TOO_LONG') return 'That recording is too long. Keep each 🎤 message under about 5 minutes.';
  if (code === 'BAD_AUDIO') return "The recording couldn't be read. Try the 🎤 again; if it keeps happening, pick another microphone in the 🔊 Voice settings.";
  if (code === 'VOICE_NOT_INSTALLED') return 'Talking to the AIs needs the free voice engine on this PC (it works offline). Install it once: Setup Wizard → Installs → "Voice engine".';
  if (code === 'NO_STT') return 'The voice engine is running but its speech-to-text part is missing. Install it again from Setup Wizard → Installs → "Voice engine".';
  if (code === 'NO_TTS' || code === 'NO_TTS_MODEL') return 'No piper voice is installed yet, so the built-in voices of this PC are used. For nicer voices: Setup Wizard → Installs → "Voice model".';
  if (code === 'STT_FAILED') return `The voice engine couldn't turn the recording into words${r && r.detail ? ` (${redactPaths(String(r.detail)).slice(0, 160)})` : ''}. Try again; if it keeps happening, restart AutoInjector.`;
  if (code === 'TTS_FAILED') return "The piper voice couldn't speak that, so the built-in voice is used.";
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
    const d = redactPaths(_bodyDetail(r && r.body));
    return `The voice service${at} reported an error (${code.replace('_', ' ')}${d ? `: ${d}` : ''}). Check the voice service's window or the app log for details.`;
  }
  return `Voice didn't work${at}: ${redactPaths(code).slice(0, 300)}.`;
}
// Attach the plain-language message to a failed result (success passes through).
// A damaged voice file becomes error VOICE_MODEL_DAMAGED with a one-click fix
// (fix.action "voice:redownload"); the raw onnxruntime text is kept, paths redacted.
function _withMessage(r) {
  if (!r || r.ok !== false) return r;
  const bad = voiceModelProblem(r);
  if (bad) {
    const out = { ...r, error: 'VOICE_MODEL_DAMAGED', rawError: redactPaths(bad.raw).slice(0, 400), voiceFile: bad.file || '', fix: { action: 'voice:redownload', label: 'Re-download the voice' } };
    delete out.body;
    out.message = explainError(out);
    return out;
  }
  const out = { ...r, message: explainError(r) };
  if (typeof out.error === 'string') out.error = redactPaths(out.error);
  return out;
}

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

// ---- 🎤 transcribe / 🔊 synthesize (voice-ui.js in the control panel) ------
// The mic records in the page (MediaRecorder, webm/opus); the bytes come here and go to the shim's
// /transcribe. /synthesize returns a WAV the page plays itself (so ⏹ Stop is instant). Neither needs
// "Speak the butler's replies aloud" ticked — that switch is about the butler talking on its own.
// An empty address means the usual one (DEFAULT_ENDPOINT), where the app runs the shim.
function effectiveEndpoint() { return settings.endpoint || DEFAULT_ENDPOINT; }
function _request(method, ep, pathName, body, timeoutMs) {
  return new Promise((resolve) => {
    let base; try { base = new URL(ep); } catch { return resolve({ ok: false, error: 'BAD_ENDPOINT' }); }
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return resolve({ ok: false, error: 'BAD_ENDPOINT' });
    const lib = base.protocol === 'https:' ? https : http;
    const payload = body == null ? null : JSON.stringify(body);
    const headers = { Accept: 'application/json' };
    if (payload != null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let req;
    try {
      req = lib.request({ hostname: base.hostname, port: base.port || (base.protocol === 'https:' ? 443 : 80), path: pathName, method, timeout: timeoutMs, headers }, (res) => {
        const parts = []; res.on('data', (d) => parts.push(d));
        res.on('end', () => {
          const buf = Buffer.concat(parts).toString('utf8');
          let j = null; try { j = JSON.parse(buf || '{}'); } catch { /* not JSON */ }
          if (res.statusCode && res.statusCode >= 400) return done(j && j.error ? { ok: false, ...j, status: res.statusCode } : { ok: false, error: `HTTP_${res.statusCode}`, body: buf.slice(0, 2000) });
          if (!j || typeof j !== 'object') return done({ ok: false, error: 'BAD_JSON', body: buf.slice(0, 2000) });
          done(j.ok === false ? { ok: false, ...j } : { ok: true, ...j });
        });
        res.on('error', (e) => done({ ok: false, error: String((e && e.code) || (e && e.message) || e) }));
      });
    } catch (e) { return done({ ok: false, error: String((e && e.code) || (e && e.message) || e) }); }
    req.on('error', (e) => done({ ok: false, error: String((e && e.code) || (e && e.message) || e) }));
    req.on('timeout', () => { done({ ok: false, error: 'TIMEOUT' }); try { req.destroy(); } catch {} });
    if (payload != null) req.write(payload);
    req.end();
  });
}
// GET /health at the effective address -> { ok, tts, stt, stt_model, stt_loaded, stt_cached, stt_mb, ... }
async function health(opts = {}) {
  const ep = effectiveEndpoint();
  const r = await _request('GET', ep, '/health', null, Math.max(300, Number(opts.timeoutMs) || 1500));
  if (!r.ok) return { ...r, endpoint: ep, message: explainError(r, ep) };
  return { ...r, endpoint: ep };
}
const MAX_AUDIO_B64 = 40 * 1024 * 1024; // ~30 MB of audio: far more than a few minutes of opus
async function transcribe(audioB64, opts = {}) {
  const a = typeof audioB64 === 'string' ? audioB64.replace(/^data:[^,]*,/, '') : '';
  if (!a || a.length < 16) return _withMessageAt({ ok: false, error: 'NEED_AUDIO' });
  if (a.length > MAX_AUDIO_B64) return _withMessageAt({ ok: false, error: 'AUDIO_TOO_LONG' });
  const mime = String(opts.mime || 'audio/webm').slice(0, 80);
  const r = await _request('POST', effectiveEndpoint(), '/transcribe', { audio_b64: a, mime }, Math.max(5000, Number(opts.timeoutMs) || 10 * 60000));
  if (r.ok) return { ok: true, text: String(r.text || '').trim(), ms: r.ms, device: r.device, model: r.model };
  return _withMessageAt(r);
}
async function synthesize(text, opts = {}) {
  const t = String(text || '').trim();
  if (!t) return _withMessageAt({ ok: false, error: 'NEED_TEXT' });
  const voice = String(opts.voice || voiceFor(opts.who) || '');
  const body = { text: t.slice(0, 4000) };
  if (voice) body.voice = voice;
  const r = await _request('POST', effectiveEndpoint(), '/synthesize', body, Math.max(3000, Number(opts.timeoutMs) || 60000));
  if (r.ok && typeof r.audio_b64 === 'string' && r.audio_b64) return { ok: true, audio: r.audio_b64, mime: r.mime || 'audio/wav', voice: r.voice || voice };
  if (r.ok) return _withMessageAt({ ok: false, error: 'BAD_JSON' });
  return _withMessageAt(r);
}
function _withMessageAt(r) {
  const out = _withMessage(r);
  if (out && out.ok === false) {
    out.message = (out.error === 'VOICE_MODEL_DAMAGED') ? out.message : explainError(out, effectiveEndpoint());
    delete out.body;
  }
  return out;
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

module.exports = { DEFAULT_ENDPOINT, MIC_TARGETS, getSettings, setSettings, status, speak, listen, checkConnection, effectiveEndpoint, health, transcribe, synthesize, explainError, voiceModelProblem, redactPaths, setRedactionProvider, startManaged, stopManaged, _setHome: (h) => { _home = String(h || ''); } };
