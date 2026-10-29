'use strict';
/*
 * sd-runner.js — AutoInjector starts and looks after Stable Diffusion itself,
 * the same way akowe-server.js runs Akọwe: a managed child process started
 * hidden, a health wait, restart with backoff after a crash, a clean stop on
 * quit, a log file without secrets, and never blocking the app's start.
 *
 * What it can start (targets()):
 *   • Stability Matrix packages — read from <library>/settings.json
 *     "InstalledPackages" (or found in <library>/Packages): Forge, reForge, A1111,
 *     SD.Next, ComfyUI. Launched like Stability Matrix does it: the package's own
 *     venv Python running its launch command (launch.py / main.py) with the launch
 *     options saved in Stability Matrix, plus --api (ComfyUI needs none) and
 *     --port. Their shared model folders (Data/Models) keep working because the
 *     package folder already links to them.
 *   • The ComfyUI portable that sd-installer.js installed:
 *     python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build --port N
 *
 *   const r = createSdRunner({ logFile, logger, onChange });
 *   r.start(target) → Promise<status>   (reuses an SD app already answering on the port)
 *   r.stop()        → Promise<status>   (only stops what WE started)
 *   r.status()      → { phase, target, port, base, kind, owned, pid, error, message, restarts }
 *   r.start(target, { cpu:true }) — ComfyUI on the processor (slow, works on any PC)
 *   r.installFinished(ok) — main.js calls it when sd-installer finishes; a Start pressed
 *                    during the install (phase 'waiting') then starts by itself
 *   r.start(target, { ckptDir }) — Forge / A1111 with --ckpt-dir <folder> (the user's models, when it had none)
 * Phases: idle · waiting (for the install) · starting · running · restarting · failed · stopped.
 * Errors: NO_TARGET | NO_PYTHON | INSTALLING | INSTALL_NOT_FINISHED | SPAWN_FAILED | HEALTH_TIMEOUT | CRASHED | UNSUPPORTED.
 *
 * Pressing Start while it is starting returns the same start (no second start sequence).
 * A crash keeps the last ~40 lines the app printed (in memory); the crash event and
 * status carry a short redacted `tail`, and sd-errors.explainExit() turns the exit code
 * (0xC0000005 access violation, 0xC0000409, 0xC0000135 missing DLL, 1 = Python error …)
 * into a plain message + fix + actions. After the 2nd identical access violation of a
 * ComfyUI it restarts ONCE with --disable-cuda-malloc; if that crashes too it stops and
 * offers "Start on the processor" / "Use the other ComfyUI build" (never run by itself).
 * The overall cap stays maxRestarts + 1 starts.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const child_process = require('child_process');
const sdBackends = require('./sd-backends');
const sdLibrary = require('./sd-library');
const sdInstaller = require('./sd-installer');
const sdErrors = require('./sd-errors');
const logExtract = require('./log-extract');

const DEFAULTS = { healthTimeoutMs: 15 * 60 * 1000, healthPollMs: 1500, maxRestarts: 3, backoffMs: [3000, 10000, 30000], stableMs: 120000, stopGraceMs: 6000, logMaxBytes: 2 * 1024 * 1024 };

// ------------------------------------------------------------ helpers
function redact(line) {
  return String(line)
    .replace(/(token|api[_-]?key|apikey|password|secret)=([^&\s"']+)/gi, '$1=***')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/g, 'Bearer ***')
    .replace(/\bhf_[A-Za-z0-9]{10,}\b/g, 'hf_***')
    .replace(/(--(?:api-auth|gradio-auth|civitai-api-key|hf-token)[=\s]+)\S+/gi, '$1***');
}
function kindOfPackage(name, dir) {
  const s = `${name || ''} ${path.basename(dir || '')}`.toLowerCase();
  if (/comfy/.test(s)) return 'comfy';
  if (/reforge/.test(s)) return 'reforge';
  if (/forge/.test(s)) return 'forge';
  if (/automatic|sd\.?next|vlad/.test(s)) return 'sdnext';
  if (/fooocus/.test(s)) return 'fooocus';
  if (/invoke/.test(s)) return 'invoke';
  if (/stable-diffusion-webui|automatic1111|a1111/.test(s)) return 'a1111';
  if (dir) {
    if (fs.existsSync(path.join(dir, 'comfy')) && fs.existsSync(path.join(dir, 'main.py'))) return 'comfy';
    if (fs.existsSync(path.join(dir, 'modules_forge'))) return 'forge';
    if (fs.existsSync(path.join(dir, 'launch.py')) && fs.existsSync(path.join(dir, 'modules'))) return 'a1111';
  }
  return 'other';
}
const LABEL = { comfy: 'ComfyUI', forge: 'SD WebUI Forge', reforge: 'SD WebUI reForge', a1111: 'Automatic1111', sdnext: 'SD.Next', fooocus: 'Fooocus', invoke: 'InvokeAI', other: 'package' };
const SUPPORTED = new Set(['comfy', 'forge', 'reforge', 'a1111', 'sdnext']);
function venvPythonOf(dir, platform) {
  const win = (platform || process.platform) === 'win32';
  const cands = win ? [path.join(dir, 'venv', 'Scripts', 'python.exe'), path.join(dir, '.venv', 'Scripts', 'python.exe')] : [path.join(dir, 'venv', 'bin', 'python'), path.join(dir, 'venv', 'bin', 'python3'), path.join(dir, '.venv', 'bin', 'python')];
  return cands.find((p) => fs.existsSync(p)) || null;
}
// Stability Matrix LaunchArgs → argv (skipping the ones AutoInjector sets itself).
function smArgs(list) {
  const out = [];
  for (const o of Array.isArray(list) ? list : []) {
    if (!o || !o.Name) continue;
    const name = String(o.Name).trim().split(/\s+/)[0];
    if (/^--(port|api|listen|nowebui)$/.test(name)) continue;
    const v = o.OptionValue;
    if (v === true || v === 'True' || v === 'true') out.push(name);
    else if (v !== false && v != null && v !== '' && v !== 'False' && v !== 'false' && typeof v !== 'object') out.push(name, String(v));
  }
  return out;
}

// Every Stability Matrix package on this PC.
function findSmPackages(opts = {}) {
  const libs = (opts.findStabilityMatrix || sdLibrary.findStabilityMatrix)({ env: opts.env, home: opts.home, drives: opts.drives });
  const out = [];
  const seen = new Set();
  for (const lib of libs) {
    let settings = null;
    try { settings = JSON.parse(fs.readFileSync(path.join(lib.library, 'settings.json'), 'utf8').replace(/^﻿/, '')); } catch {}
    const listed = settings && Array.isArray(settings.InstalledPackages) ? settings.InstalledPackages : [];
    const add = (dir, meta) => {
      const key = path.resolve(dir).toLowerCase();
      if (seen.has(key) || !fs.existsSync(dir)) return;
      seen.add(key);
      const kind = kindOfPackage(meta.PackageName, dir);
      const launchCommand = meta.LaunchCommand || (kind === 'comfy' ? 'main.py' : kind === 'fooocus' ? 'entry_with_update.py' : 'launch.py');
      out.push({
        id: `sm:${meta.Id || path.basename(dir)}`, source: 'Stability Matrix', kind, label: LABEL[kind], displayName: meta.DisplayName || path.basename(dir),
        packageName: meta.PackageName || '', dir, library: lib.library, models: lib.models, python: venvPythonOf(dir, opts.platform), launchCommand,
        extraArgs: smArgs(meta.LaunchArgs), supported: SUPPORTED.has(kind),
      });
    };
    for (const p of listed) if (p && p.LibraryPath) add(path.join(lib.library, p.LibraryPath), p);
    const pk = path.join(lib.library, 'Packages');
    try { for (const e of fs.readdirSync(pk, { withFileTypes: true })) if (e.isDirectory()) add(path.join(pk, e.name), {}); } catch {}
  }
  return out;
}

// Everything the runner could start: SM packages + our own ComfyUI portable.
function targets(opts = {}) {
  const list = findSmPackages(opts);
  const portable = sdInstaller.findPortable(opts.portableHome || sdInstaller.defaultHome(opts.platform, opts.env));
  if (portable) list.push({ id: 'portable:comfyui', source: 'AutoInjector', kind: 'comfy', label: 'ComfyUI', displayName: `ComfyUI (installed by AutoInjector${portable.build && sdInstaller.BUILDS[portable.build] ? `, ${sdInstaller.BUILDS[portable.build].label} build` : ''})`, dir: portable.root, models: portable.models, python: portable.python, launchCommand: path.join('ComfyUI', 'main.py'), extraArgs: [], supported: true, portable: true, build: portable.build || null });
  // Supported first; ComfyUI/Forge before the rest.
  const rank = { forge: 0, reforge: 1, comfy: 2, a1111: 3, sdnext: 4 };
  return list.sort((a, b) => (b.supported - a.supported) || ((rank[a.kind] ?? 9) - (rank[b.kind] ?? 9)));
}

function defaultPort(kind) { return kind === 'comfy' ? 8188 : 7860; }
// Safer start flags after repeated crashes (ComfyUI only): no CUDA malloc (the async
// allocator crashes some driver / card combinations with 0xC0000005).
const SAFE_FLAGS = ['--disable-cuda-malloc'];
function safeFlagsFor(t) {
  if (!t || t.kind !== 'comfy') return [];
  const have = new Set(t.extraArgs || []);
  if (have.has('--cpu')) return [];
  return SAFE_FLAGS.filter((f) => !have.has(f));
}
// opts: { cpu, safe, env } — the user's own launch options (t.extraArgs) are always kept;
// AutoInjector only adds a flag that isn't there yet.
function launchSpec(t, port, opts = {}) {
  if (!t || !t.supported) return null;
  const env = Object.assign({}, opts.env || process.env, { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' });
  const user = Array.isArray(t.extraArgs) ? t.extraArgs : [];
  const extra = [];
  if (opts.safe) for (const f of safeFlagsFor(t)) extra.push(f);
  if (opts.cpu && t.kind === 'comfy' && !user.includes('--cpu')) extra.push('--cpu');
  // "Restart Forge with my models": the folder the library found the user's checkpoints in (Forge / A1111 only)
  if (opts.ckptDir && t.kind !== 'comfy' && !user.includes('--ckpt-dir')) extra.push('--ckpt-dir', String(opts.ckptDir));
  if (t.portable) {
    const args = ['-s', t.launchCommand, '--windows-standalone-build', '--port', String(port), ...user, ...extra];
    return { cmd: t.python, args, cwd: t.dir, env };
  }
  const args = [t.launchCommand, ...user, ...extra];
  if (t.kind !== 'comfy') args.push('--api');
  args.push('--port', String(port));
  return { cmd: t.python, args, cwd: t.dir, env };
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

// The last lines a process printed, kept in memory (for "why did it crash?").
const TAIL_LINES = 40, TAIL_MAX = 600;
function pushTail(buf, text) {
  const parts = (buf.__partial || '') + String(text);
  const lines = parts.split(/\r?\n|\r/);
  buf.__partial = lines.pop();
  for (const l of lines) { const t = l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trimEnd(); if (t.trim()) buf.push(t.slice(0, 400)); }
  if (buf.__partial.length > 2000) buf.__partial = buf.__partial.slice(-2000);
  while (buf.length > TAIL_LINES) buf.shift();
}
// The useful end of it: progress bars and blank lines dropped, ≤600 chars, secrets and the home folder hidden.
function usefulTail(buf, redactFn) {
  const all = buf.concat(buf.__partial && buf.__partial.trim() ? [buf.__partial.trim()] : []);
  const lines = all.filter((l) => !/\d+%\|[█▏▎▍▌▋▊▉ #]*\|/.test(l) && !/^\s*[-=_*]{5,}\s*$/.test(l));
  const out = [];
  let len = 0;
  for (let i = lines.length - 1; i >= 0 && out.length < 12; i--) {
    const l = (redactFn ? redactFn(lines[i]) : lines[i]).slice(0, 300);
    if (len + l.length + 1 > TAIL_MAX && out.length) break;
    out.unshift(l); len += l.length + 1;
  }
  return out.join('\n').slice(-TAIL_MAX);
}
let _home = ''; try { _home = os.homedir(); } catch { _home = ''; }
// Secrets (redact above) + your home folder as ~ — the same path redaction as the rest of the app's logs (log-extract.js).
function redactOutput(text, redaction) {
  let o = null;
  try { o = typeof redaction === 'function' ? redaction() : redaction; } catch { o = null; }
  if (!o || typeof o !== 'object') o = { home: _home };
  let s = redact(text);
  try { s = logExtract.redact(s, o).text; } catch {}
  return s;
}

// ------------------------------------------------------------ the manager
// opts (besides the DEFAULTS): logFile, logger, onChange, spawn, identify, platform, cpu, env,
//   redaction()      → { home, secrets, appDirs } for hiding paths in the crash tail (main.js: the log-extract options)
//   installing()     → true while sd-installer is downloading / unpacking (Start then waits for it)
//   refreshTarget(t) → the same target found again after the install finished (now with its Python)
//   gpu()            → { vendor, name } for the crash explanation
//   otherBuild(t)    → { build, label } | null — whether "Use the other ComfyUI build" can be offered
const BUSY = new Set(['starting', 'restarting']);
const SETTLED = new Set(['running', 'failed', 'stopped', 'idle', 'waiting']);
const INSTALLING_MSG = 'ComfyUI is still being installed — it starts by itself when the install finishes.';
function createSdRunner(opts = {}) {
  const o = Object.assign({}, DEFAULTS, opts);
  const spawnFn = opts.spawn || child_process.spawn;
  const identify = opts.identify || ((base) => sdBackends.identify(base, { timeoutMs: 2500 }));
  const logger = opts.logger || (() => {});
  const onChange = opts.onChange || (() => {});
  const platform = opts.platform || process.platform;
  const setT = opts.setTimeout || setTimeout; const clearT = opts.clearTimeout || clearTimeout;
  const now = opts.now || Date.now;
  const sleep = (ms) => new Promise((r) => setT(r, ms));
  const call = (fn, ...a) => { try { return typeof fn === 'function' ? fn(...a) : null; } catch { return null; } };
  let st = { phase: 'idle', target: null, port: null, base: null, kind: null, owned: false, pid: null, error: null, message: '', restarts: 0, startedAt: null, readyAt: null, mode: null, cause: null, fix: '', actions: [], crash: null, tried: [] };
  let child = null, gen = 0, stopping = false, restartTimer = null, stableTimer = null, current = null;
  let mode = { cpu: false, safe: false };   // this start sequence: --cpu (asked for) / safer flags (after repeated crashes)
  let crashes = [];                          // this start sequence's crash causes, in order
  let inflight = null;                       // the start sequence running now (pressing Start again returns it)
  let pending = null;                        // { target, so } waiting for the install to finish
  let settleWaiters = [];

  function set(p) {
    st = Object.assign({}, st, p);
    try { onChange(status()); } catch {}
    if (SETTLED.has(st.phase) && settleWaiters.length) { const w = settleWaiters; settleWaiters = []; for (const f of w) { try { f(); } catch {} } }
  }
  function waitSettled() { return new Promise((r) => settleWaiters.push(r)); }
  function status() {
    const t = current;
    return Object.assign({}, st, { ready: st.phase === 'running', busy: BUSY.has(st.phase), target: t ? { id: t.id, label: t.label, displayName: t.displayName, kind: t.kind, source: t.source } : null,
      message: st.message || (st.phase === 'running' ? `✔ ${t ? t.label : 'Stable Diffusion'} running on :${st.port}${st.owned ? ' (managed)' : ' (started outside AutoInjector)'}${st.mode === 'cpu' ? ' — on the processor (slow)' : st.mode === 'safe' ? ' — with safer settings' : ''}` : '') });
  }
  function writeLog(text) {
    if (!o.logFile) return;
    try {
      fs.mkdirSync(path.dirname(o.logFile), { recursive: true });
      try { if (fs.statSync(o.logFile).size > o.logMaxBytes) fs.renameSync(o.logFile, `${o.logFile}.old`); } catch {}
      fs.appendFileSync(o.logFile, String(text).split(/\r?\n/).filter((l) => l.length).map(redact).join('\n') + '\n');
    } catch {}
  }
  function fail(error, message, extra) { logger('sd-runner-failed', Object.assign({ error }, extra && extra.cause ? { cause: extra.cause } : {})); set(Object.assign({ phase: 'failed', error, message, pid: null }, extra || {})); return status(); }
  const installing = () => !!call(opts.installing);
  const pythonOk = (t) => !!(t && t.python && fs.existsSync(t.python));

  // Start (or reuse) target. Pressing Start again while it is starting returns the same
  // start (no second start sequence). so: { port, cpu }.
  function start(target, so = {}) {
    if (st.phase === 'running') return Promise.resolve(status());
    if (st.phase === 'waiting') { logger('sd-runner-already-starting', { phase: 'waiting' }); return Promise.resolve(Object.assign(status(), { alreadyStarting: true })); }
    if (inflight || BUSY.has(st.phase)) {
      logger('sd-runner-already-starting', { phase: st.phase });
      return (inflight || waitSettled().then(() => status())).then((s) => Object.assign({}, s, { alreadyStarting: true }));
    }
    const p = (async () => {
      let s = await begin(target, so);
      while (BUSY.has(st.phase)) { await waitSettled(); s = status(); }
      return s;
    })();
    inflight = p;
    const clear = () => { if (inflight === p) inflight = null; };
    p.then(clear, clear);
    return p;
  }

  async function begin(target, so) {
    const t = target;
    // Start pressed before the install finished: wait for it, then start by itself.
    if ((!t || (t.portable && !pythonOk(t))) && installing()) {
      pending = { target: t, so };
      current = t || current;
      logger('sd-runner-wait-install', { target: t ? t.kind : null });
      set({ phase: 'waiting', error: 'INSTALLING', message: INSTALLING_MSG, pid: null });
      return Object.assign(status(), { error: 'INSTALLING' });
    }
    if (!t) return fail('NO_TARGET', 'No Stable Diffusion app to start. Install one (⬇ Install Stable Diffusion) or add a package in Stability Matrix.');
    if (!t.supported) return fail('UNSUPPORTED', `${t.label || 'This package'} can't be driven by AutoInjector. Add “SD WebUI Forge” or “ComfyUI” in Stability Matrix.`);
    current = t; stopping = false; gen++;
    const myGen = gen;
    mode = { cpu: !!(so.cpu || opts.cpu), safe: false, ckptDir: so.ckptDir ? String(so.ckptDir) : '' };
    crashes = [];
    set({ phase: 'starting', error: null, cause: null, fix: '', actions: [], crash: null, tried: [], message: `Starting ${t.label}${mode.cpu ? ' on the processor' : ''}…`, restarts: so.keepRestarts ? st.restarts : 0, kind: t.kind === 'comfy' ? 'comfy' : 'a1111', mode: mode.cpu ? 'cpu' : null });
    // Already running (started by hand / by Stability Matrix)? Use it.
    const want = so.port || defaultPort(t.kind);
    const pre = await identify(`http://127.0.0.1:${want}`).catch(() => null);
    if (myGen !== gen) return status();
    if (pre && pre.usable) {
      logger('sd-runner-reuse', { port: want, kind: pre.kind });
      set({ phase: 'running', owned: false, port: want, base: pre.base, readyAt: now(), message: `✔ Using the ${pre.label} that is already running on :${want}` });
      return status();
    }
    let port = want;
    if (!(await portFree(port))) { for (let p = want + 1; p < want + 20; p++) if (await portFree(p)) { port = p; break; } }
    return spawnIt(t, port, myGen);
  }

  // The install finished (ok) or stopped (not ok): start what was waiting for it.
  function installFinished(ok) {
    if (st.phase !== 'waiting' || !pending) return Promise.resolve(status());
    const p = pending; pending = null;
    if (!ok) { logger('sd-runner-wait-install-cancelled', {}); return Promise.resolve(fail('INSTALL_NOT_FINISHED', 'The ComfyUI install did not finish, so it was not started. Press ⬇ Install Stable Diffusion to continue the install, then Start.')); }
    const t = call(opts.refreshTarget, p.target) || p.target;
    logger('sd-runner-install-done-start', { target: t ? t.kind : null });
    set({ phase: 'idle', error: null, message: '' });
    return start(t, p.so);
  }

  async function spawnIt(t, port, myGen) {
    if (myGen !== gen || stopping) return status();
    if (!pythonOk(t)) {
      if (t.portable) return fail('NO_PYTHON', `${t.label}'s install is not finished (its Python is missing). Press ⬇ Install Stable Diffusion to finish it — or, if it is installing now, wait: it starts by itself when the install finishes.`);
      return fail('NO_PYTHON', `${t.label}'s Python was not found (${t.python || 'no venv folder'}). Start it once from Stability Matrix so it finishes installing, then try again.`);
    }
    const spec = launchSpec(t, port, { cpu: mode.cpu, safe: mode.safe, ckptDir: mode.ckptDir, env: opts.env });
    let c;
    try { c = spawnFn(spec.cmd, spec.args, { cwd: spec.cwd, env: spec.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return fail('SPAWN_FAILED', `${t.label} could not be started (${(e && e.code) || 'error'}). Details are in the log.`); }
    child = c; c.__gen = myGen; c.__startedAt = now(); c.__tail = []; c.__mode = Object.assign({}, mode);
    const flags = [mode.cpu ? '--cpu' : null, ...(mode.safe ? safeFlagsFor(t) : [])].filter(Boolean);
    logger('sd-runner-start', Object.assign({ kind: t.kind, port, pid: c.pid || null, attempt: st.restarts + 1, source: t.source }, flags.length ? { flags } : {}));
    writeLog(`[AutoInjector] starting ${t.label} on 127.0.0.1:${port}: ${path.basename(spec.cmd)} ${spec.args.join(' ')}`);
    set({ phase: 'starting', owned: true, port, base: `http://127.0.0.1:${port}`, pid: c.pid || null, startedAt: now(), readyAt: null, mode: mode.cpu ? 'cpu' : mode.safe ? 'safe' : null,
      message: st.restarts ? `Restarting ${t.label} (try ${st.restarts + 1})${mode.safe ? ' with safer settings (--disable-cuda-malloc)' : ''}…` : `Starting ${t.label}${mode.cpu ? ' on the processor' : ''}… the first start can take several minutes while it gets ready.` });
    const onData = (b) => { const s = b.toString('utf8'); pushTail(c.__tail, s); writeLog(s); };
    if (c.stdout && c.stdout.on) c.stdout.on('data', onData);
    if (c.stderr && c.stderr.on) c.stderr.on('data', onData);
    c.on('error', (e) => { c.__spawnError = (e && e.code) || 'error'; writeLog(`[AutoInjector] could not run: ${c.__spawnError}`); setT(() => { if (!c.__exited) onExit(c, null, null); }, 30); });
    c.on('exit', (code, sig) => onExit(c, code, sig));
    // Health wait.
    const t0 = now();
    while (now() - t0 < o.healthTimeoutMs) {
      if (c !== child || c.__exited || myGen !== gen || stopping) return status();
      const r = await identify(`http://127.0.0.1:${port}`).catch(() => null);
      if (c !== child || c.__exited || myGen !== gen) return status();
      if (r && r.usable) {
        logger('sd-runner-ready', Object.assign({ port, ms: now() - c.__startedAt, kind: r.kind }, flags.length ? { flags } : {}));
        writeLog(`[AutoInjector] ${t.label} is ready on port ${port}`);
        set({ phase: 'running', readyAt: now(), message: '', error: null });
        if (stableTimer) clearT(stableTimer);
        stableTimer = setT(() => { stableTimer = null; if (c === child && st.phase === 'running') { crashes = []; set({ restarts: 0 }); } }, o.stableMs);
        return status();
      }
      await sleep(o.healthPollMs);
    }
    if (c !== child) return status();
    logger('sd-runner-health-timeout', { port });
    c.__abandoned = true; killChild(c); child = null;
    return fail('HEALTH_TIMEOUT', `${t.label} started but did not answer within ${Math.round(o.healthTimeoutMs / 60000)} minutes. Open the log to see why, then press Start again.`);
  }

  function onExit(c, code, sig) {
    if (c.__exited) return; c.__exited = true;
    const waiters = c.__waiters || []; c.__waiters = [];
    try {
      if (c !== child) return;
      child = null;
      if (stableTimer) { clearT(stableTimer); stableTimer = null; }
      if (stopping || c.__gen !== gen) { logger('sd-runner-stopped', { code }); writeLog('[AutoInjector] stopped'); set({ phase: 'stopped', pid: null, readyAt: null, message: 'Stable Diffusion is stopped.' }); return; }
      const n = st.restarts + 1;
      const t = current;
      // Why: the exit code (Windows NTSTATUS) + the last lines it printed.
      const tail = usefulTail(c.__tail || [], (l) => redactOutput(l, opts.redaction));
      const other = t && t.portable ? call(opts.otherBuild, t) : null;
      const ex = sdErrors.explainExit(code, { tail, label: t ? t.label : 'Stable Diffusion', kind: t ? t.kind : undefined, canCpu: !!(t && t.kind === 'comfy' && !c.__mode.cpu), gpu: call(opts.gpu) || undefined, otherBuild: other || null });
      const crash = { exitCode: code == null ? null : code, hex: ex.hex || null, signal: sig || null, cause: ex.code, line: ex.line || '', tail, mode: c.__mode.cpu ? 'cpu' : c.__mode.safe ? 'safe' : 'normal', at: now() };
      crashes.push(ex.code);
      logger('sd-runner-crash', Object.assign({ code: code == null ? null : code }, ex.hex ? { hex: ex.hex } : {}, { signal: sig || null, crashes: n, cause: ex.code }, c.__mode.safe ? { flags: SAFE_FLAGS } : {}, c.__mode.cpu ? { cpu: true } : {}, tail ? { tail } : {}, { severity: 'error' }));
      writeLog(`[AutoInjector] stopped unexpectedly (exit ${code == null ? sig || c.__spawnError || '?' : `${code}${ex.hex ? ` = ${ex.hex}` : ''}`}) — ${ex.code}`);
      const info = { cause: ex.code, fix: ex.fix || '', actions: ex.actions || [], crash, lastOutput: tail };
      const label = t ? t.label : 'Stable Diffusion';
      if (c.__spawnError === 'ENOENT') { set({ restarts: n }); fail('NO_PYTHON', 'Its Python could not be started. Start the package once from Stability Matrix (or reinstall), then try again.'); return; }
      const av = ex.code === 'ACCESS_VIOLATION';
      // The safer flags crashed the same way too: don't keep trying — offer the processor / the other build.
      if (c.__mode.safe && av) {
        logger('sd-runner-safe-mode-failed', { crashes: n, tried: st.tried, offered: info.actions.map((a) => a.id) });
        set({ restarts: n });
        fail('CRASHED', `${label} crashed ${n} times while starting, also with safer settings (${SAFE_FLAGS.join(' ')}). ${ex.message}`, info);
        return;
      }
      if (n > o.maxRestarts) { set({ restarts: n }); fail('CRASHED', `${label} stopped unexpectedly ${n} times in a row, so AutoInjector stopped restarting it. ${ex.message}`, info); return; }
      // Self-recovery: the 2nd identical access violation → restart ONCE with safer flags.
      let note = '';
      if (av && crashes.length >= 2 && crashes[crashes.length - 2] === 'ACCESS_VIOLATION' && !mode.safe && !mode.cpu && t && safeFlagsFor(t).length) {
        mode = Object.assign({}, mode, { safe: true });
        logger('sd-runner-safe-mode', { flags: safeFlagsFor(t), after: n, reason: ex.code });
        writeLog(`[AutoInjector] crashed twice with ${ex.hex || ex.code}: restarting once with ${safeFlagsFor(t).join(' ')}`);
        set({ tried: st.tried.concat([`restart with ${safeFlagsFor(t).join(' ')}`]) });
        note = ` Trying once more with safer settings (${safeFlagsFor(t).join(' ')}).`;
      }
      const wait = o.backoffMs[Math.min(n - 1, o.backoffMs.length - 1)];
      const myGen = gen; const port = st.port;
      set(Object.assign({ phase: 'restarting', restarts: n, pid: null, readyAt: null, message: `${label} stopped unexpectedly${ex.hex ? ` (${ex.hex})` : ''}. Restarting in ${Math.round(wait / 1000)} s (try ${n + 1} of ${o.maxRestarts + 1}).${note}` }, info));
      restartTimer = setT(() => { restartTimer = null; spawnIt(t, port, myGen).catch(() => {}); }, wait);
    } finally { for (const w of waiters) { try { w(); } catch {} } }
  }
  function killChild(c, sig) {
    try {
      if (platform === 'win32' && c.pid && !opts.spawn) child_process.execFile('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true }, () => {}); // the whole tree (python spawns children)
      else c.kill(sig || 'SIGINT');
    } catch {}
  }
  function stop() {
    stopping = true; gen++;
    pending = null;
    if (restartTimer) { clearT(restartTimer); restartTimer = null; }
    if (stableTimer) { clearT(stableTimer); stableTimer = null; }
    const c = child;
    if (!c || c.__exited) { if (st.phase !== 'idle') set({ phase: 'stopped', pid: null, readyAt: null, owned: st.owned && false, message: st.owned ? 'Stable Diffusion is stopped.' : (st.phase === 'running' ? 'AutoInjector did not start this one, so it keeps running.' : 'Stopped.') }); return Promise.resolve(status()); }
    logger('sd-runner-stop', { pid: c.pid || null });
    return new Promise((resolve) => {
      let hard = null;
      (c.__waiters = c.__waiters || []).push(() => { if (hard) clearT(hard); resolve(status()); });
      killChild(c);
      hard = setT(() => { if (c.__exited) return; try { c.kill('SIGKILL'); } catch {} setT(() => { if (!c.__exited) onExit(c, null, 'SIGKILL'); }, 800); }, o.stopGraceMs);
    });
  }
  function killNow() { const c = child; if (c && !c.__exited) { try { c.kill(platform === 'win32' ? undefined : 'SIGKILL'); } catch {} } }
  return { start, stop, status, killNow, installFinished, isBusy: () => !!inflight || BUSY.has(st.phase) || st.phase === 'waiting', isOwnedAlive: () => !!(child && !child.__exited), logFile: o.logFile };
}

module.exports = { createSdRunner, findSmPackages, targets, launchSpec, safeFlagsFor, SAFE_FLAGS, smArgs, kindOfPackage, redact, redactOutput, pushTail, usefulTail, venvPythonOf, defaultPort, portFree, DEFAULTS, INSTALLING_MSG };
