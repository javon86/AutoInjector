'use strict';
/*
 * akowe-server.js — AutoInjector runs Akọwe's local server itself ("one app,
 * one launcher"). PURE NODE: no Electron import; main.js supplies the logger,
 * the log file and the change callback, and shows the result in the window.
 *
 *   const m = createServerManager({ app: findAppDir(__dirname), logFile, logger, onChange, ... });
 *   m.start()   -> Promise: reuse an Akọwe that already answers (started by hand), else
 *                  find Python 3.10+ (the launcher's private venv first; it is made the same
 *                  way run-akowe.bat does when missing, and what Akọwe needs is installed once),
 *                  start `python -m akowe --no-browser --host 127.0.0.1 --port <free port>`,
 *                  and wait until GET /api/ping answers. Never throws; problems end up in status().
 *   m.status()  -> { phase, ready, owned, port, base, version, pid, error, message, restarts, python, ... }
 *                  (never the access token)
 *   m.startLink() -> the start link http://127.0.0.1:<port>/#token=<token> (the token is read from
 *                  the server's own "Open:" line, or from its data folder's local_token after the
 *                  ping proof says it belongs to this server) — for the window only, never logged
 *   m.retry()   -> "Try again": forget the failure and the crash count, start again
 *   m.stop()    -> Promise: stop OUR server (SIGINT, then a hard kill after stopGraceMs); a
 *                  server started by hand is left running
 *   m.killNow() -> last-resort synchronous kill (process exit)
 *
 * Phases: idle · checking (is one running already?) · finding_python · preparing (making the venv) ·
 * installing (pip, first start only) · starting · running · restarting (after a crash, with
 * backoff) · failed (error: NO_APP | NO_PYTHON | INSTALL_FAILED | SPAWN_FAILED | HEALTH_TIMEOUT |
 * CRASHED) · stopped.
 *
 * Crash handling: an unexpected exit restarts the server after backoffMs[n] (n = crashes so far);
 * after maxRestarts crashes in a row it stops trying (phase failed, CRASHED). A server that stayed
 * up for stableMs resets the count. A server that never answers /api/ping within healthTimeoutMs is
 * stopped and reported (HEALTH_TIMEOUT) — no automatic retry, the window offers "Try again".
 *
 * Logging: logger(kind, detail) gets short, text-free events (start, ready, reuse, crash,
 * restart, stop, failed, ...): ports, exit codes, python version — never the token. The server's
 * own output goes to logFile with any token=... / Bearer ... hidden.
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const os = require('os');

const DEFAULT_PORT = 8780;
const PORT_SPAN = 20; // Akọwe itself tries 8780..8799
const APP_IDS = ['akowe', 'bookforge']; // /api/ping "app" (bookforge = before the rename)
const PYTHON_DOWNLOAD_URL = 'https://www.python.org/downloads/';
const PY_CHECK = "import sys; print('%d.%d.%d' % sys.version_info[:3]); sys.exit(0 if sys.version_info >= (3, 10) else 1)";
const DEFAULTS = {
  healthTimeoutMs: 60000, healthPollMs: 300, tokenWaitMs: 3000, pingTimeoutMs: 1500,
  maxRestarts: 4, backoffMs: [2000, 5000, 15000, 30000], stableMs: 120000, stopGraceMs: 4000,
  checkTimeoutMs: 20000, venvTimeoutMs: 240000, installTimeoutMs: 600000,
  reuseWatchMs: 20000, logMaxBytes: 1024 * 1024
};
const START_LINK_RE = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})\/#token=([A-Za-z0-9_\-]+)/;
const ALREADY_RE = /already running/i;

// ---------------------------------------------------------------- helpers (pure, exported for tests)

// The Akọwe folder next to AutoInjector: <explicit> or ../akowe (or ../bookforge from before the
// rename), recognised by its Python package. -> { dir, module } | null
function findAppDir(baseDir, explicitDir, exists) {
  const ex = exists || fs.existsSync;
  const dirs = explicitDir ? [explicitDir] : [path.join(baseDir, '..', 'akowe'), path.join(baseDir, '..', 'bookforge')];
  for (const d of dirs) {
    for (const mod of ['akowe', 'bookforge']) {
      try { if (ex(path.join(d, mod, '__main__.py'))) return { dir: path.resolve(d), module: mod }; } catch (_) {}
    }
  }
  return null;
}

// Where the launcher keeps Akọwe's folder (data + venv): %LOCALAPPDATA%\Akowe on Windows,
// ~/.local/share/akowe elsewhere — and the folder of the same name from before the rename.
function appHomes(platform, env) {
  const e = env || process.env;
  if (platform === 'win32') {
    const root = e.LOCALAPPDATA || (e.USERPROFILE ? path.win32.join(e.USERPROFILE, 'AppData', 'Local') : os.homedir());
    return { home: path.win32.join(root, 'Akowe'), legacy: path.win32.join(root, 'Bookforge'), win: true };
  }
  const root = e.XDG_DATA_HOME || path.join(e.HOME || os.homedir(), '.local', 'share');
  return { home: path.join(root, 'akowe'), legacy: path.join(root, 'bookforge'), win: false };
}
function venvPython(home, platform) {
  return platform === 'win32' ? path.win32.join(home, 'venv', 'Scripts', 'python.exe') : path.join(home, 'venv', 'bin', 'python');
}
// Data folders whose local_token may belong to a running Akọwe (AKOWE_DATA first, as Akọwe reads it).
function dataDirCandidates(platform, env) {
  const e = env || process.env;
  const given = e.AKOWE_DATA || e.BOOKFORGE_DATA;
  if (given) return [given];
  const h = appHomes(platform, e);
  return [h.home, h.legacy];
}
function pingProof(token, challenge) {
  return crypto.createHmac('sha256', String(token)).update(`akowe-ping:${challenge}`).digest('hex');
}
// Hide anything secret in a line of the server's output before it goes into the log file.
function redact(line) {
  return String(line)
    .replace(/(token=)[^\s&"']+/gi, '$1<hidden>')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1<hidden>');
}
function parseStartLink(line) {
  const m = START_LINK_RE.exec(String(line || ''));
  return m ? { port: Number(m[1]), token: m[2] } : null;
}
// GET http://127.0.0.1:<port>/api/ping[?challenge=] -> { app, version, proof } | null
function httpPing(port, challenge, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const req = http.request({ host: '127.0.0.1', port, method: 'GET', agent: false,
        path: '/api/ping' + (challenge ? `?challenge=${challenge}` : ''), headers: { Accept: 'application/json' } }, (res) => {
        const chunks = [];
        res.on('data', (c) => { chunks.push(c); if (chunks.length > 64) req.destroy(); });
        res.on('end', () => {
          if (res.statusCode !== 200) return finish(null);
          try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8')); finish(j && typeof j === 'object' ? j : null); }
          catch (_) { finish(null); }
        });
        res.on('error', () => finish(null));
      });
      req.setTimeout(timeoutMs || 1500, () => { req.destroy(); finish(null); });
      req.on('error', () => finish(null));
      req.end();
    } catch (_) { finish(null); }
  });
}
// Can we listen on 127.0.0.1:<port> right now? (port 0 -> resolves with the OS-chosen free port)
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(port === 0 ? null : false));
    s.listen(port, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(port === 0 ? p : true));
    });
  });
}
function isAppId(v) { return APP_IDS.includes(v); }

// ---------------------------------------------------------------- the manager

function createServerManager(opts) {
  const o = Object.assign({}, DEFAULTS);
  for (const [k, v] of Object.entries(opts || {})) if (v !== undefined) o[k] = v; // undefined = keep the default
  const platform = o.platform || process.platform;
  const P = platform === 'win32' ? path.win32 : path; // paths on the platform Akọwe runs on
  const env = o.env || process.env;
  const app = o.app || null; // { dir, module }
  const spawnFn = o.spawn || require('child_process').spawn;
  const execFileFn = o.execFile || require('child_process').execFile;
  const ping = o.ping || httpPing;
  const isPortFree = o.portFree || portFree;
  const exists = o.exists || fs.existsSync;
  const readFile = o.readFile || ((f) => fs.readFileSync(f, 'utf8'));
  const rename = o.rename || fs.renameSync;
  const now = o.now || Date.now;
  const setT = o.setTimeout || setTimeout;
  const clearT = o.clearTimeout || clearTimeout;
  const sleep = (ms) => new Promise((r) => setT(r, ms));
  const logger = typeof o.logger === 'function' ? o.logger : () => {};
  const onChange = typeof o.onChange === 'function' ? o.onChange : () => {};
  const logFile = o.logFile || null;

  const st = {
    phase: 'idle', owned: false, port: null, version: null, pid: null, error: null, message: null,
    restarts: 0, python: null, startedAt: null, readyAt: null, nextRestartAt: null, alreadyRunning: false
  };
  let token = null;
  let child = null;
  let booting = null;
  let stopping = false;
  let restartTimer = null;
  let stableTimer = null;
  let watchTimer = null;
  let generation = 0; // bumps on stop/retry so an old boot can't change the state afterwards

  // -- log file (the server's own output; tokens hidden)
  if (logFile) {
    try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); } catch (_) {}
    try { if (fs.statSync(logFile).size > o.logMaxBytes) fs.renameSync(logFile, logFile + '.1'); } catch (_) {}
  }
  function writeLog(text) {
    if (!logFile) return;
    const stamp = new Date(now()).toISOString();
    const lines = String(text).split(/\r?\n/).filter((l) => l.length).map((l) => `${stamp} ${redact(l)}`);
    if (!lines.length) return;
    try { fs.appendFileSync(logFile, lines.join('\n') + '\n'); } catch (_) {}
  }

  function set(patch) {
    Object.assign(st, patch);
    try { onChange(status()); } catch (_) {}
  }
  function fail(error, message, detail) {
    logger('failed', Object.assign({ error }, detail || {}));
    writeLog(`[AutoInjector] Akọwe could not start: ${error} — ${message}`);
    set({ phase: 'failed', error, message, nextRestartAt: null });
  }
  function base() { return st.port ? `http://127.0.0.1:${st.port}/` : null; }
  function status() {
    return {
      phase: st.phase, ready: st.phase === 'running', owned: st.owned, port: st.port, base: base(),
      version: st.version, pid: st.pid, error: st.error, message: st.message, restarts: st.restarts,
      maxRestarts: o.maxRestarts, python: st.python ? Object.assign({}, st.python) : null,
      startedAt: st.startedAt, readyAt: st.readyAt, nextRestartAt: st.nextRestartAt,
      hasToken: !!token, appFound: !!app, appDir: app ? app.dir : null, logFile,
      pythonUrl: st.error === 'NO_PYTHON' ? PYTHON_DOWNLOAD_URL : null
    };
  }
  function startLink() {
    const b = base();
    if (!b) return null;
    return token ? `${b}#token=${encodeURIComponent(token)}` : b;
  }

  // -- running a short command (python checks, venv, pip)
  function run(cmd, args, timeoutMs) {
    return new Promise((resolve) => {
      try {
        execFileFn(cmd, args, { timeout: timeoutMs, windowsHide: true, cwd: app ? app.dir : undefined, env, maxBuffer: 4 * 1024 * 1024 },
          (err, stdout, stderr) => {
            const out = String(stdout || '');
            const errOut = String(stderr || '');
            resolve({ ok: !err, code: err ? (err.code != null ? err.code : 1) : 0, stdout: out, stderr: errOut });
          });
      } catch (e) { resolve({ ok: false, code: (e && e.code) || 'SPAWN_FAILED', stdout: '', stderr: String(e) }); }
    });
  }
  async function pyVersion(cmd, args) {
    const r = await run(cmd, [...args, '-c', PY_CHECK], o.checkTimeoutMs);
    const v = (r.stdout.match(/(\d+)\.(\d+)\.(\d+)/) || [])[0] || null;
    return { ok: r.ok && !!v, version: v, tooOld: !r.ok && !!v };
  }
  async function findBasePython() {
    const list = platform === 'win32'
      ? [['py', ['-3']], ['python', []], ['python3', []]]
      : [[env.PYTHON || 'python3', []], ['python', []]];
    let tooOld = null;
    for (const [cmd, args] of list) {
      const v = await pyVersion(cmd, args);
      if (v.ok) return { cmd, args, version: v.version };
      if (v.tooOld) tooOld = v.version;
    }
    return { none: true, tooOld };
  }
  // Like run-akowe.bat / run-akowe.sh: the folder of the old name moves over once, before the venv is made.
  function homeFolder() {
    const h = appHomes(platform, env);
    if (!exists(h.home) && exists(h.legacy)) {
      try { rename(h.legacy, h.home); logger('legacy-folder-moved', {}); writeLog(`[AutoInjector] Akọwe was called BookForge before: moved ${h.legacy} to ${h.home}`); }
      catch (_) { return h.legacy; }
    }
    return h.home;
  }
  async function resolvePython() {
    const override = String(env.AUTOINJECTOR_AKOWE_PYTHON || '').trim();
    if (override) {
      const v = await pyVersion(override, []);
      if (v.ok) return { cmd: override, args: [], version: v.version, venv: false, source: 'setting' };
      return { error: 'NO_PYTHON', message: `AUTOINJECTOR_AKOWE_PYTHON (${path.basename(override)}) is not Python 3.10 or newer. Install it from ${PYTHON_DOWNLOAD_URL}, or remove that setting, then press Try again.` };
    }
    const home = homeFolder();
    const vpy = venvPython(home, platform);
    if (exists(vpy)) {
      const v = await pyVersion(vpy, []);
      if (v.ok) return { cmd: vpy, args: [], version: v.version, venv: true, source: 'venv' };
    }
    const basePy = await findBasePython();
    if (basePy.none) {
      return { error: 'NO_PYTHON', message: basePy.tooOld
        ? `Akọwe needs Python 3.10 or newer; this computer has Python ${basePy.tooOld}. Install a newer Python from ${PYTHON_DOWNLOAD_URL} (on Windows tick “Add python.exe to PATH”), then press Try again.`
        : `Akọwe needs Python 3.10 or newer, and it was not found. Install it from ${PYTHON_DOWNLOAD_URL} (on Windows tick “Add python.exe to PATH” on the first screen), then press Try again.` };
    }
    set({ phase: 'preparing', message: 'First start: preparing Akọwe’s own Python environment (about a minute)…' });
    logger('venv-create', { python: basePy.version });
    writeLog(`[AutoInjector] making Akọwe's private Python environment in ${P.join(home, 'venv')}`);
    try { fs.mkdirSync(home, { recursive: true }); } catch (_) {}
    const r = await run(basePy.cmd, [...basePy.args, '-m', 'venv', P.join(home, 'venv')], o.venvTimeoutMs);
    if (r.stderr) writeLog(r.stderr);
    if (r.ok && exists(vpy)) {
      const v = await pyVersion(vpy, []);
      if (v.ok) return { cmd: vpy, args: [], version: v.version, venv: true, source: 'venv-new' };
    }
    logger('venv-failed', { code: r.code });
    writeLog('[AutoInjector] could not make a private environment; using the normal Python instead');
    return { cmd: basePy.cmd, args: basePy.args, version: basePy.version, venv: false, source: 'system' };
  }
  async function ensureDeps(py) {
    const has = await run(py.cmd, [...py.args, '-c', 'import jsonschema'], o.checkTimeoutMs);
    if (has.ok) return true;
    set({ phase: 'installing', message: 'First start: installing what Akọwe needs (needs the internet once)…' });
    logger('install', { venv: py.venv });
    const req = P.join(app.dir, 'requirements.txt');
    const args = [...py.args, '-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '-r', req];
    let r = await run(py.cmd, args, o.installTimeoutMs);
    if (!r.ok && !py.venv) r = await run(py.cmd, [...args, '--user'], o.installTimeoutMs);
    writeLog(r.stdout); writeLog(r.stderr);
    if (!r.ok) return false;
    logger('installed', {});
    return true;
  }

  // -- is an Akọwe already answering? (started by hand, or left over from an earlier run)
  function candidatePorts() {
    const p = Number(env.AKOWE_PORT || env.BOOKFORGE_PORT);
    const first = Number.isInteger(p) && p > 0 && p < 65536 ? p : DEFAULT_PORT;
    const out = [first];
    for (let i = 0; i < PORT_SPAN; i++) if (DEFAULT_PORT + i !== first) out.push(DEFAULT_PORT + i);
    return out;
  }
  async function findExisting() {
    const ports = candidatePorts();
    const answers = await Promise.all(ports.map((p) => ping(p, null, o.pingTimeoutMs).catch(() => null)));
    for (let i = 0; i < ports.length; i++) {
      const a = answers[i];
      if (a && isAppId(a.app)) return { port: ports[i], version: a.version || null };
    }
    return null;
  }
  // The access token of the Akọwe on <port>: a data folder's local_token whose HMAC proof matches.
  async function tokenFromFiles(port) {
    const toks = [];
    for (const d of dataDirCandidates(platform, env)) {
      try { const t = String(readFile(P.join(d, 'local_token')) || '').trim(); if (t && !toks.includes(t)) toks.push(t); } catch (_) {}
    }
    if (!toks.length) return null;
    const challenge = crypto.randomBytes(16).toString('hex');
    const a = await ping(port, challenge, o.pingTimeoutMs).catch(() => null);
    if (!a || typeof a.proof !== 'string') return null;
    for (const t of toks) {
      const want = pingProof(t, challenge);
      if (want.length === a.proof.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(a.proof))) return t;
    }
    return null;
  }
  async function pickPort(preferred) {
    const list = candidatePorts();
    if (preferred && !list.includes(preferred)) list.unshift(preferred);
    else if (preferred) { list.splice(list.indexOf(preferred), 1); list.unshift(preferred); }
    for (const p of list) { if (await isPortFree(p)) return p; }
    return await isPortFree(0); // every usual port is busy: any free one
  }

  async function adoptExisting(found, gen) {
    if (gen !== generation) return;
    token = await tokenFromFiles(found.port);
    if (gen !== generation) return;
    logger('reuse', { port: found.port, version: found.version, token: token ? 'matched' : 'unknown' });
    writeLog(`[AutoInjector] Akọwe is already running on port ${found.port} (started outside AutoInjector) — using it`);
    set({ phase: 'running', owned: false, port: found.port, version: found.version, pid: null, error: null,
      message: token ? null : 'Akọwe is already running, but with a different data folder, so AutoInjector cannot sign in to it. Use the link in Akọwe’s own window.',
      readyAt: now(), nextRestartAt: null });
    watchExternal(gen);
  }
  // A hand-started Akọwe can be closed any time: notice it, then start our own.
  function watchExternal(gen) {
    if (!o.reuseWatchMs) return;
    let misses = 0;
    const tick = async () => {
      watchTimer = null;
      if (gen !== generation || stopping || st.owned || st.phase !== 'running') return;
      const a = await ping(st.port, null, o.pingTimeoutMs).catch(() => null);
      if (gen !== generation || stopping) return;
      if (a && isAppId(a.app)) misses = 0; else misses++;
      if (misses >= 2) {
        logger('reuse-gone', { port: st.port });
        writeLog(`[AutoInjector] the Akọwe on port ${st.port} stopped; starting Akọwe here`);
        token = null;
        set({ phase: 'idle', port: null, version: null });
        boot(gen).catch(() => {});
        return;
      }
      watchTimer = setT(tick, o.reuseWatchMs);
    };
    watchTimer = setT(tick, o.reuseWatchMs);
  }

  // -- the whole start sequence
  async function boot(gen) {
    if (gen !== generation || stopping) return;
    set({ phase: 'checking', error: null, message: 'Looking for a running Akọwe…' });
    const found = await findExisting();
    if (gen !== generation || stopping) return;
    if (found) return adoptExisting(found, gen);
    if (!app) return fail('NO_APP', 'Akọwe’s folder was not found next to AutoInjector (it should be the “akowe” folder beside “desktop-app”).');
    set({ phase: 'finding_python', message: 'Looking for Python…' });
    const py = await resolvePython();
    if (gen !== generation || stopping) return;
    if (py.error) return fail(py.error, py.message);
    set({ python: { version: py.version, venv: py.venv, source: py.source, name: path.basename(py.cmd) } });
    const okDeps = await ensureDeps(py);
    if (gen !== generation || stopping) return;
    if (!okDeps) return fail('INSTALL_FAILED', 'Akọwe could not install the one package it needs (jsonschema). Check this computer is connected to the internet, then press Try again. Details are in the log.');
    st.pythonCmd = py;
    await spawnServer(gen, null);
  }

  async function spawnServer(gen, preferredPort) {
    if (gen !== generation || stopping) return;
    const port = await pickPort(preferredPort);
    if (gen !== generation || stopping) return;
    if (!port) return fail('SPAWN_FAILED', 'No free local port was found for Akọwe.');
    const py = st.pythonCmd;
    const args = [...py.args, '-m', app.module, '--no-browser', '--host', '127.0.0.1', '--port', String(port)];
    token = null;
    let c;
    try {
      c = spawnFn(py.cmd, args, {
        cwd: app.dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.assign({}, env, { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' })
      });
    } catch (e) {
      return fail('SPAWN_FAILED', `Akọwe could not be started (${(e && e.code) || 'error'}). Details are in the log.`);
    }
    child = c;
    c.__gen = gen;
    c.__startedAt = now();
    c.__abandoned = false;
    c.__already = false;
    logger('start', { port, python: py.version, venv: py.venv, pid: c.pid || null, attempt: st.restarts + 1 });
    writeLog(`[AutoInjector] starting Akọwe on 127.0.0.1:${port} (Python ${py.version}${py.venv ? ', private environment' : ''})`);
    set({ phase: 'starting', owned: true, port, pid: c.pid || null, error: null, startedAt: now(), readyAt: null, nextRestartAt: null,
      message: st.restarts ? `Restarting Akọwe (try ${st.restarts + 1} of ${o.maxRestarts + 1})…` : 'Starting Akọwe…' });
    const onData = (buf) => {
      const text = buf.toString('utf8');
      writeLog(text);
      for (const line of text.split(/\r?\n/)) {
        const sl = parseStartLink(line);
        if (sl && c === child) token = sl.token;
        if (ALREADY_RE.test(line)) c.__already = true;
      }
    };
    if (c.stdout && c.stdout.on) c.stdout.on('data', onData);
    if (c.stderr && c.stderr.on) c.stderr.on('data', onData);
    c.on('error', (e) => {
      writeLog(`[AutoInjector] could not run Python: ${(e && e.code) || e}`);
      if (c !== child) return;
      c.__spawnError = (e && e.code) || 'error';
      // 'exit' may not follow a spawn error: handle it as an exit.
      setT(() => { if (c === child && !c.__exited) onExit(c, null, null); }, 50);
    });
    c.on('exit', (code, signal) => onExit(c, code, signal));
    await waitHealthy(c, gen, port);
  }

  async function waitHealthy(c, gen, port) {
    const t0 = now();
    while (now() - t0 < o.healthTimeoutMs) {
      if (c !== child || gen !== generation || c.__exited || stopping) return;
      const a = await ping(port, null, o.pingTimeoutMs).catch(() => null);
      if (c !== child || gen !== generation || c.__exited || stopping) return;
      if (a && isAppId(a.app)) {
        const until = now() + o.tokenWaitMs;
        while (!token && now() < until && c === child && !c.__exited) await sleep(50);
        if (!token) token = await tokenFromFiles(port);
        if (c !== child || gen !== generation) return;
        logger('ready', { port, ms: now() - c.__startedAt, version: a.version || null, token: token ? 'yes' : 'no' });
        writeLog(`[AutoInjector] Akọwe ${a.version || ''} is running on port ${port}`);
        set({ phase: 'running', version: a.version || null, readyAt: now(), message: null });
        if (stableTimer) clearT(stableTimer);
        stableTimer = setT(() => { stableTimer = null; if (c === child && st.phase === 'running' && st.restarts) set({ restarts: 0 }); }, o.stableMs);
        return;
      }
      await sleep(o.healthPollMs);
    }
    if (c !== child || gen !== generation || c.__exited) return;
    logger('health-timeout', { port, ms: now() - t0 });
    c.__abandoned = true;
    killChild(c);
    child = null;
    fail('HEALTH_TIMEOUT', `Akọwe started but did not answer within ${Math.round(o.healthTimeoutMs / 1000)} seconds. Press Try again, or open the log to see why.`, { port });
  }

  function onExit(c, code, signal) {
    if (c.__exited) return;
    c.__exited = true;
    const waiters = c.__waiters || [];
    c.__waiters = [];
    try { exitNow(c, code, signal); }
    finally { for (const w of waiters) { try { w(); } catch (_) {} } }
  }
  function exitNow(c, code, signal) {
    if (c !== child) return; // an abandoned / replaced process
    child = null;
    const uptime = now() - (c.__startedAt || now());
    if (stableTimer) { clearT(stableTimer); stableTimer = null; }
    if (stopping || c.__gen !== generation) {
      logger('stopped', { code, signal: signal || null, uptime_ms: uptime });
      writeLog('[AutoInjector] Akọwe stopped');
      set({ phase: 'stopped', pid: null, readyAt: null });
      return;
    }
    if (c.__already && code === 0) {
      // Another Akọwe took the port meanwhile: use that one.
      writeLog('[AutoInjector] another Akọwe is already running; using it');
      boot(generation).catch(() => {});
      return;
    }
    const wasReady = st.phase === 'running';
    const n = st.restarts + 1;
    logger('crash', { code: code == null ? null : code, signal: signal || null, uptime_ms: uptime, crashes: n, was_ready: wasReady, error: c.__spawnError || undefined, severity: 'error' });
    writeLog(`[AutoInjector] Akọwe stopped unexpectedly (exit ${code == null ? signal || c.__spawnError || '?' : code}) after ${Math.round(uptime / 1000)} s`);
    if (c.__spawnError === 'ENOENT') {
      set({ restarts: n });
      return fail('SPAWN_FAILED', 'Python could not be started. Install Python 3.10 or newer, then press Try again.');
    }
    if (n > o.maxRestarts) {
      set({ restarts: n, pid: null });
      return fail('CRASHED', `Akọwe stopped unexpectedly ${n} times in a row, so AutoInjector stopped restarting it. Press Try again, or open the log to see why.`, { crashes: n });
    }
    const wait = o.backoffMs[Math.min(n - 1, o.backoffMs.length - 1)];
    const gen = generation;
    logger('restart', { in_ms: wait, attempt: n + 1, of: o.maxRestarts + 1 });
    set({ phase: 'restarting', restarts: n, pid: null, readyAt: null, nextRestartAt: now() + wait,
      message: `Akọwe stopped unexpectedly. Restarting it in ${Math.round(wait / 1000)} s (try ${n + 1} of ${o.maxRestarts + 1})…` });
    restartTimer = setT(() => { restartTimer = null; spawnServer(gen, st.port).catch(() => {}); }, wait);
  }

  function killChild(c, sig) {
    try {
      if (platform === 'win32') c.kill();
      else c.kill(sig || 'SIGINT'); // Akọwe stops cleanly on Ctrl+C
    } catch (_) {}
  }
  function clearTimers() {
    if (restartTimer) { clearT(restartTimer); restartTimer = null; }
    if (stableTimer) { clearT(stableTimer); stableTimer = null; }
    if (watchTimer) { clearT(watchTimer); watchTimer = null; }
  }

  function start() {
    if (booting) return booting;
    if (st.phase === 'running' || st.phase === 'starting' || st.phase === 'restarting') return Promise.resolve(status());
    stopping = false;
    const gen = generation;
    booting = boot(gen)
      .catch((e) => { fail('SPAWN_FAILED', `Akọwe could not be started (${String((e && e.message) || e).slice(0, 80)}).`); })
      .then(() => { booting = null; return status(); });
    return booting;
  }
  function stop() {
    stopping = true;
    generation++;
    clearTimers();
    const c = child;
    if (!c || c.__exited) {
      if (st.phase !== 'failed' && st.phase !== 'idle') set({ phase: 'stopped', pid: null, readyAt: null });
      if (!st.owned && st.port) logger('leave-running', { port: st.port });
      return Promise.resolve(status());
    }
    logger('stop', { port: st.port, pid: c.pid || null });
    return new Promise((resolve) => {
      let hard = null;
      (c.__waiters = c.__waiters || []).push(() => { if (hard) clearT(hard); resolve(status()); });
      killChild(c);
      hard = setT(() => {
        if (c.__exited) return;
        logger('stop-forced', { pid: c.pid || null });
        try { c.kill('SIGKILL'); } catch (_) {}
        // give up waiting soon after; the OS will finish the job
        setT(() => { if (!c.__exited) { onExit(c, null, 'SIGKILL'); } }, 1000);
      }, o.stopGraceMs);
    });
  }
  async function retry() {
    if (child && !child.__exited) await stop();
    generation++;
    clearTimers();
    stopping = false;
    booting = null;
    token = null;
    set({ phase: 'idle', error: null, message: null, restarts: 0, nextRestartAt: null, port: null, owned: false });
    logger('retry', {});
    return start();
  }
  function killNow() {
    const c = child;
    if (c && !c.__exited) { try { c.kill(platform === 'win32' ? undefined : 'SIGKILL'); } catch (_) {} }
  }

  return {
    start, stop, retry, killNow, status, startLink,
    token: () => token,
    isOwnedAlive: () => !!(child && !child.__exited),
    _state: st
  };
}

module.exports = {
  createServerManager, findAppDir, appHomes, venvPython, dataDirCandidates, pingProof, redact, parseStartLink,
  httpPing, portFree, isAppId, DEFAULT_PORT, PORT_SPAN, PYTHON_DOWNLOAD_URL, DEFAULTS
};
