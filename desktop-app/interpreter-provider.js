'use strict';
// interpreter-provider.js — adapter to a locally-running Open Interpreter as
// AutoInjector's "run code / control the computer" capability. Like the manager
// supervisor, this is the scoped exception to the no-API-keys rule: the three
// web AIs are still driven only through the browser panes; Open Interpreter is a
// separate local agent that executes code, and this module just streams work to
// it and normalizes what comes back.
//
// Transport contract (kept deliberately small + tolerant so it survives Open
// Interpreter's version churn — classic Python server, the Rust build, or a thin
// user shim can all speak it):
//   POST <endpoint>            body { task, auto_run }   (path configurable)
//   response: a stream of events, one JSON object per line OR SSE `data:` lines.
// Each event is normalized to { type, content, format? } where type is one of:
//   'message' (assistant prose) | 'code' (code about to run; `format` = python/
//   shell/…) | 'output' (execution result / console) | 'confirmation' (waiting on
//   approval when auto_run is off) | 'error' | 'done'.
// The parser also accepts Open Interpreter's native "lmc" chunks
//   { role, type:'message'|'code'|'console', format?, content, start?, end? }
// and folds them into the same normalized shape.
const http = require('http');
const https = require('https');
const { URL } = require('url');

let settings = {
  enabled: false,
  endpoint: '', // e.g. http://127.0.0.1:8000/run  (an Open Interpreter server or shim)
  model: '',    // informational; the model is configured on the OI side
  apiKey: '',   // optional bearer for the OI endpoint
  autoRun: false, // if true, OI runs code without asking (use with care)
  timeoutMs: 300000,
};

function getSettings() {
  const { apiKey, ...rest } = settings;
  return { ...rest, hasApiKey: !!apiKey };
}
function setSettings(patch) {
  if (!patch || typeof patch !== 'object') return getSettings();
  for (const k of ['enabled', 'autoRun']) if (k in patch) settings[k] = !!patch[k];
  for (const k of ['endpoint', 'model', 'apiKey']) if (k in patch) settings[k] = String(patch[k] || '');
  if ('timeoutMs' in patch) settings.timeoutMs = Math.max(5000, Number(patch.timeoutMs) || settings.timeoutMs);
  return getSettings();
}
function status() {
  return { configured: !!settings.endpoint, enabled: !!settings.enabled, endpoint: settings.endpoint, model: settings.model, autoRun: !!settings.autoRun, managed: !!managed.child, managedPid: managed.child ? managed.child.pid : null };
}

// --- Managed mode: AutoInjector runs the Open Interpreter shim itself, so the
// user doesn't have to start anything. spawn the process, wait for its /health,
// point the endpoint at it. Opt-in (a command must be given). ------------------
const { spawn } = require('child_process');
const managed = { child: null };

function _pingHealth(host, port, cb) {
  const req = http.request({ hostname: host, port, path: '/health', method: 'GET', timeout: 1500 }, (res) => {
    res.resume(); cb(res.statusCode && res.statusCode < 500);
  });
  req.on('error', () => cb(false));
  req.on('timeout', () => { try { req.destroy(); } catch (_) {} cb(false); });
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

// startManaged({ command, args, port, host, cwd, env, readyTimeoutMs, onLog })
// Spawns the shim and, once its health endpoint answers, enables the adapter
// pointed at it. Returns { ok, endpoint, pid } or { ok:false, error }.
async function startManaged(opts = {}) {
  const command = opts.command;
  if (!command) return { ok: false, error: 'NO_COMMAND' };
  const host = opts.host || '127.0.0.1';
  const port = Number(opts.port) || 8231;
  const readyTimeoutMs = Number(opts.readyTimeoutMs) || 20000;
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  stopManaged();
  let child;
  try {
    child = spawn(command, Array.isArray(opts.args) ? opts.args : [], {
      cwd: opts.cwd || undefined,
      env: Object.assign({}, process.env, opts.env || {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  managed.child = child;
  try {
    if (child.stdout) child.stdout.on('data', (d) => onLog('stdout', String(d)));
    if (child.stderr) child.stderr.on('data', (d) => onLog('stderr', String(d)));
  } catch (_) {}
  child.on('exit', (code) => { onLog('exit', `interpreter shim exited (${code})`); if (managed.child === child) managed.child = null; });
  child.on('error', (e) => { onLog('error', String((e && e.message) || e)); if (managed.child === child) managed.child = null; });

  const ready = await _waitForHealth(host, port, readyTimeoutMs);
  if (!ready || managed.child !== child) { stopManaged(); return { ok: false, error: 'SHIM_NOT_READY' }; }
  const endpoint = `http://${host}:${port}/run`;
  setSettings({ enabled: true, endpoint });
  return { ok: true, endpoint, pid: child.pid };
}
function stopManaged() {
  if (managed.child) { try { managed.child.kill(); } catch (_) {} managed.child = null; return { ok: true, stopped: true }; }
  return { ok: true, stopped: false };
}

// Fold one raw event (already JSON-parsed) into a normalized { type, content, format }.
function normalize(ev) {
  if (!ev || typeof ev !== 'object') return null;
  // Native Open Interpreter "lmc" chunk.
  if (ev.role && ev.type) {
    if (ev.end) return null; // end markers carry no content of their own
    const t = ev.type === 'console' ? 'output' : ev.type; // console -> output
    const type = t === 'message' || t === 'code' || t === 'output' || t === 'confirmation' ? t : 'message';
    return { type, content: ev.content == null ? '' : String(ev.content), format: ev.format || undefined };
  }
  // Simple contract event.
  if (ev.type) {
    return { type: String(ev.type), content: ev.content == null ? '' : String(ev.content), format: ev.format || undefined };
  }
  return null;
}

// Run a task through Open Interpreter, streaming normalized events to onEvent.
// Resolves { ok, events, message, error } — `message` is the concatenated prose.
function run(task, opts = {}) {
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  return new Promise((resolve) => {
    if (!task || !String(task).trim()) return resolve({ ok: false, error: 'NEED_TASK' });
    if (!settings.enabled) return resolve({ ok: false, error: 'INTERPRETER_DISABLED' });
    if (!settings.endpoint) return resolve({ ok: false, error: 'NO_ENDPOINT' });

    let url;
    try { url = new URL(settings.endpoint); } catch (_) { return resolve({ ok: false, error: 'BAD_ENDPOINT' }); }
    const lib = url.protocol === 'https:' ? https : http;
    const payload = JSON.stringify({ task: String(task), auto_run: !!settings.autoRun, model: settings.model || undefined });
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Accept: 'application/x-ndjson, text/event-stream' };
    if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

    const events = [];
    const parts = [];
    let settled = false;
    const finish = (out) => { if (settled) return; settled = true; try { req.destroy(); } catch (_) {} resolve(out); };

    const req = lib.request({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search, method: 'POST', headers, timeout: settings.timeoutMs }, (res) => {
      if (res.statusCode && res.statusCode >= 400) { finish({ ok: false, error: `HTTP_${res.statusCode}` }); return; }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          let line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          if (line.startsWith('data:')) line = line.slice(5).trim(); // SSE
          if (line === '[DONE]') { onEvent({ type: 'done' }); continue; }
          let raw; try { raw = JSON.parse(line); } catch (_) { continue; }
          const ev = normalize(raw);
          if (!ev) continue;
          events.push(ev);
          if (ev.type === 'message' && ev.content) parts.push(ev.content);
          onEvent(ev);
        }
      });
      res.on('end', () => finish({ ok: true, events, message: parts.join('') }));
      res.on('error', (e) => finish({ ok: false, error: String((e && e.message) || e), events }));
    });
    req.on('error', (e) => finish({ ok: false, error: String((e && e.code) || (e && e.message) || e) }));
    req.on('timeout', () => finish({ ok: false, error: 'TIMEOUT', events }));
    req.write(payload);
    req.end();
  });
}

module.exports = { getSettings, setSettings, status, run, normalize, startManaged, stopManaged };
