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
 * Phases: idle · starting · running · restarting · failed · stopped.
 * Errors: NO_TARGET | NO_PYTHON | SPAWN_FAILED | HEALTH_TIMEOUT | CRASHED | UNSUPPORTED.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const child_process = require('child_process');
const sdBackends = require('./sd-backends');
const sdLibrary = require('./sd-library');
const sdInstaller = require('./sd-installer');

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
  if (portable) list.push({ id: 'portable:comfyui', source: 'AutoInjector', kind: 'comfy', label: 'ComfyUI', displayName: 'ComfyUI (installed by AutoInjector)', dir: portable.root, models: portable.models, python: portable.python, launchCommand: path.join('ComfyUI', 'main.py'), extraArgs: [], supported: true, portable: true });
  // Supported first; ComfyUI/Forge before the rest.
  const rank = { forge: 0, reforge: 1, comfy: 2, a1111: 3, sdnext: 4 };
  return list.sort((a, b) => (b.supported - a.supported) || ((rank[a.kind] ?? 9) - (rank[b.kind] ?? 9)));
}

function defaultPort(kind) { return kind === 'comfy' ? 8188 : 7860; }
function launchSpec(t, port, opts = {}) {
  if (!t || !t.supported) return null;
  const env = Object.assign({}, opts.env || process.env, { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' });
  if (t.portable) {
    const args = ['-s', t.launchCommand, '--windows-standalone-build', '--port', String(port)];
    if (opts.cpu) args.push('--cpu');
    return { cmd: t.python, args, cwd: t.dir, env };
  }
  const args = [t.launchCommand, ...(t.extraArgs || [])];
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

// ------------------------------------------------------------ the manager
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
  let st = { phase: 'idle', target: null, port: null, base: null, kind: null, owned: false, pid: null, error: null, message: '', restarts: 0, startedAt: null, readyAt: null };
  let child = null, gen = 0, stopping = false, restartTimer = null, stableTimer = null, current = null;

  function set(p) { st = Object.assign({}, st, p); try { onChange(status()); } catch {} }
  function status() {
    const t = current;
    return Object.assign({}, st, { ready: st.phase === 'running', target: t ? { id: t.id, label: t.label, displayName: t.displayName, kind: t.kind, source: t.source } : null,
      message: st.message || (st.phase === 'running' ? `✔ ${t ? t.label : 'Stable Diffusion'} running on :${st.port}${st.owned ? ' (managed)' : ' (started outside AutoInjector)'}` : '') });
  }
  function writeLog(text) {
    if (!o.logFile) return;
    try {
      fs.mkdirSync(path.dirname(o.logFile), { recursive: true });
      try { if (fs.statSync(o.logFile).size > o.logMaxBytes) fs.renameSync(o.logFile, `${o.logFile}.old`); } catch {}
      fs.appendFileSync(o.logFile, String(text).split(/\r?\n/).filter((l) => l.length).map(redact).join('\n') + '\n');
    } catch {}
  }
  function fail(error, message) { logger('sd-runner-failed', { error }); set({ phase: 'failed', error, message, pid: null }); return status(); }

  async function start(target, so = {}) {
    if (st.phase === 'running' || st.phase === 'starting' || st.phase === 'restarting') return status();
    const t = target;
    if (!t) return fail('NO_TARGET', 'No Stable Diffusion app to start. Install one (⬇ Install Stable Diffusion) or add a package in Stability Matrix.');
    if (!t.supported) return fail('UNSUPPORTED', `${t.label || 'This package'} can't be driven by AutoInjector. Add “SD WebUI Forge” or “ComfyUI” in Stability Matrix.`);
    current = t; stopping = false; gen++;
    const myGen = gen;
    set({ phase: 'starting', error: null, message: `Starting ${t.label}…`, restarts: so.keepRestarts ? st.restarts : 0, kind: t.kind === 'comfy' ? 'comfy' : 'a1111' });
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

  async function spawnIt(t, port, myGen) {
    if (myGen !== gen || stopping) return status();
    if (!t.python || !fs.existsSync(t.python)) return fail('NO_PYTHON', `${t.label}'s Python was not found (${t.python || 'no venv folder'}). Start it once from Stability Matrix so it finishes installing, then try again.`);
    const spec = launchSpec(t, port, { cpu: opts.cpu, env: opts.env });
    let c;
    try { c = spawnFn(spec.cmd, spec.args, { cwd: spec.cwd, env: spec.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return fail('SPAWN_FAILED', `${t.label} could not be started (${(e && e.code) || 'error'}). Details are in the log.`); }
    child = c; c.__gen = myGen; c.__startedAt = now();
    logger('sd-runner-start', { kind: t.kind, port, pid: c.pid || null, attempt: st.restarts + 1, source: t.source });
    writeLog(`[AutoInjector] starting ${t.label} on 127.0.0.1:${port}: ${path.basename(spec.cmd)} ${spec.args.join(' ')}`);
    set({ phase: 'starting', owned: true, port, base: `http://127.0.0.1:${port}`, pid: c.pid || null, startedAt: now(), readyAt: null, message: st.restarts ? `Restarting ${t.label} (try ${st.restarts + 1})…` : `Starting ${t.label}… the first start can take several minutes while it gets ready.` });
    const onData = (b) => writeLog(b.toString('utf8'));
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
        logger('sd-runner-ready', { port, ms: now() - c.__startedAt, kind: r.kind });
        writeLog(`[AutoInjector] ${t.label} is ready on port ${port}`);
        set({ phase: 'running', readyAt: now(), message: '' });
        if (stableTimer) clearT(stableTimer);
        stableTimer = setT(() => { stableTimer = null; if (c === child && st.phase === 'running') set({ restarts: 0 }); }, o.stableMs);
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
      logger('sd-runner-crash', { code: code == null ? null : code, signal: sig || null, crashes: n, severity: 'error' });
      writeLog(`[AutoInjector] stopped unexpectedly (exit ${code == null ? sig || c.__spawnError || '?' : code})`);
      if (c.__spawnError === 'ENOENT') { set({ restarts: n }); fail('NO_PYTHON', 'Its Python could not be started. Start the package once from Stability Matrix (or reinstall), then try again.'); return; }
      if (n > o.maxRestarts) { set({ restarts: n }); fail('CRASHED', `Stable Diffusion stopped unexpectedly ${n} times in a row, so AutoInjector stopped restarting it. Open the log to see why, then press Start.`); return; }
      const wait = o.backoffMs[Math.min(n - 1, o.backoffMs.length - 1)];
      const myGen = gen; const t = current; const port = st.port;
      set({ phase: 'restarting', restarts: n, pid: null, readyAt: null, message: `Stable Diffusion stopped unexpectedly. Restarting in ${Math.round(wait / 1000)} s (try ${n + 1} of ${o.maxRestarts + 1})…` });
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
  return { start, stop, status, killNow, isOwnedAlive: () => !!(child && !child.__exited), logFile: o.logFile };
}

module.exports = { createSdRunner, findSmPackages, targets, launchSpec, smArgs, kindOfPackage, redact, venvPythonOf, defaultPort, portFree, DEFAULTS };
