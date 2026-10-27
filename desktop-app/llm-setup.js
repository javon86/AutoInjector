'use strict';
/*
 * llm-setup.js — 🎩 Alfred's AI: ONE-BUTTON setup + a CHECK that says, in plain English, whether
 * everything is installed and running (B6 Lane B).
 *
 *   findOllama()          the Ollama program on PATH or in the standard install places (+ the app's own
 *                         install folder); points ollama-manager at it (setBin) so a fresh install is used
 *                         WITHOUT restarting the app.
 *   installOllama()       Windows: OllamaSetup.exe (silent Inno Setup); macOS: Ollama-darwin.zip into
 *                         ~/Applications; Linux: the official tarball into an app-local folder (no sudo).
 *                         Download with % progress, resume + retry; cancellable.
 *   startOllama()/stop    reuse an Ollama already answering (the app's 11435 or the usual 11434), else start
 *                         the app's own server (ollama-manager.startManaged) and wait until it answers.
 *   pullModel()           POST /api/pull (NDJSON) → percent, MB/s, time left; disk check first; cancellable.
 *   removeModel() / listModels() / useModel()   DELETE /api/delete, GET /api/tags, point Alfred (and the old
 *                         Butler) at a model, then a quick test.
 *   check() / fix()       the 🩺 rows (each failing row has a one-click fix).
 *   setupAll()            THE ONE BUTTON: PC → install Ollama → start → choose the best model that fits →
 *                         download → use it → check. Idempotent.
 *
 * Electron-free: everything outside (fetch, spawn, execFile, fs, platform, env, ollama-manager, hardware,
 * the model catalog, folders, Alfred's / the Butler's settings, log, emit) is injected. Nothing here
 * throws to the caller; every failure is a plain sentence a non-technical user can act on. Nothing secret
 * (a Hugging Face token) is ever put in a log line or an event.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const child_process = require('child_process');

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;
const DOWNLOAD_BASE = 'https://ollama.com/download';
const SYSTEM_BASE = 'http://127.0.0.1:11434';
const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/@+-]{0,200}$/;
const UNCENSORED_RE = /uncensored|abliterat|dolphin|hermes|lexi|unfiltered|nsfw/i;

// ------------------------------------------------------------------------------------------------ helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const modelKey = (m) => { const t = String(m || '').trim().toLowerCase(); return t && !t.includes(':') ? `${t}:latest` : t; };
const sameModel = (a, b) => !!a && !!b && modelKey(a) === modelKey(b);
const isUncensored = (name) => UNCENSORED_RE.test(String(name || ''));
function gbText(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return '?';
  const g = bytes / GB;
  return g >= 10 ? `${Math.round(g)} GB` : g >= 1 ? `${g.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / MB))} MB`;
}
function timeText(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '';
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  return `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`;
}
function parseVersion(text) {
  const m = /(\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?)/.exec(String(text || ''));
  return m ? m[1] : null;
}
/** Billions of parameters from a model name: "qwen2.5:7b" → 7, "dolphin-mixtral:8x7b" → 47. */
function paramsFromName(name) {
  const s = String(name || '').toLowerCase();
  const moe = /(\d+)x(\d+(?:\.\d+)?)b/.exec(s);
  if (moe) return Math.round(Number(moe[1]) * Number(moe[2]) * 0.84);
  const m = /(?:^|[:\-_/])(\d+(?:\.\d+)?)b(?:$|[-_:.])/.exec(s);
  if (m) return Number(m[1]);
  const known = { 'dolphin-phi': 2.7, tinydolphin: 1.1, 'phi3.5': 3.8, phi3: 3.8, 'dolphin3': 8, hermes3: 8, mistral: 7, 'llama3.1': 8, 'llama3.2': 3, 'qwen2.5': 7 };
  const base = s.split(':')[0].split('/').pop();
  return known[base] != null ? known[base] : null;
}
/** A rough Q4 download size for a model name (when nothing better is known). */
function estimateSizeBytes(name) {
  const p = paramsFromName(name);
  return p == null ? null : Math.round((p * 0.6 + 0.3) * GB);
}
/** Fallback fit rating (used only when llm-hardware.js is not part of this build). Same contract. */
function fallbackFit(sizeBytes, hw, opts = {}) {
  if (!sizeBytes || !hw) return { rating: 'unknown', stars: 0, label: '? Unknown fit', reason: 'I could not tell how big this model is.', needMB: null, runsOn: 'cpu' };
  const ctx = opts.contextTokens || 8192;
  const needMB = Math.round((sizeBytes * 1.15) / MB + ctx * 0.125 + 500);
  const vram = Number(hw.bestVramMB) || 0;
  const freeRam = Number(hw.freeRamMB || hw.ramMB) || 0;
  const mk = (rating, stars, label, reason, runsOn) => ({ rating, stars, label, reason, needMB, runsOn });
  if (vram && needMB + 1536 <= vram) return mk('great', 3, '★★★ Great fit', `Needs about ${gbText(needMB * MB)}; your graphics card has ${gbText(vram * MB)} — plenty of room.`, 'gpu');
  if (vram && needMB <= vram) return mk('good', 2, '★★ Good fit', `Needs about ${gbText(needMB * MB)}; it fits in your graphics card's ${gbText(vram * MB)}.`, 'gpu');
  if (needMB <= vram + freeRam * 0.8) return mk('slow', 1, '★ Runs, slowly', vram ? `Needs about ${gbText(needMB * MB)} — more than the graphics card's ${gbText(vram * MB)}, so part runs on the processor (slower).` : `No usable graphics card found — it runs on the processor (slower).`, vram ? 'gpu+cpu' : 'cpu');
  return mk('too-big', 0, '✖ Too big for this PC', `Needs about ${gbText(needMB * MB)}, more than this PC has free.`, 'cpu');
}
const fitUsable = (fit) => !!fit && (fit.rating === 'great' || fit.rating === 'good');

/** Turn low-level errors into one plain sentence. `what` = what we were doing ("download Ollama"). */
function friendlyError(err, what) {
  const code = err && (err.code || (err.cause && err.cause.code));
  const msg = String((err && (err.message || err.error)) || err || '');
  const all = `${code || ''} ${msg} ${err && err.cause ? String(err.cause.message || '') : ''}`;
  if (/ENOSPC|no space/i.test(all)) return `The disk is full, so I couldn't ${what}. Free up some space (empty the Recycle Bin, delete big downloads) and press the button again.`;
  if (/EACCES|EPERM|access is denied|operation not permitted/i.test(all)) return `Your computer didn't allow me to ${what} (no permission — an antivirus or a protected folder may be blocking it). Allow it, or run the Ollama installer from ollama.com yourself.`;
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|fetch failed|network|socket|getaddrinfo/i.test(all)) return `I couldn't ${what}: this PC doesn't seem to be connected to the internet (or ollama.com is blocked). Check the connection and press the button again.`;
  if (/timeout|timed out|AbortError/i.test(all)) return `It took too long to ${what}. Check the internet connection and try again.`;
  return `I couldn't ${what}${msg ? ` (${msg.slice(0, 160)})` : ''}.`;
}

// ------------------------------------------------------------------------------------------------ factory
function createLlmSetup(deps = {}) {
  const d = {
    fetch: deps.fetch || ((...a) => fetch(...a)),
    spawn: deps.spawn || child_process.spawn,
    execFile: deps.execFile || child_process.execFile,
    fs: deps.fs || fs,
    platform: deps.platform || process.platform,
    arch: deps.arch || process.arch,
    env: deps.env || process.env,
    homedir: deps.homedir || ((deps.env && (deps.env.HOME || deps.env.USERPROFILE)) || os.homedir()),
    ollamaManager: deps.ollamaManager || require('./ollama-manager'),
    paths: Object.assign({ downloadsDir: () => path.join(os.tmpdir(), 'autoinjector-downloads'), modelsDir: () => null, appInstallDir: () => null }, deps.paths || {}),
    log: typeof deps.log === 'function' ? deps.log : () => {},
    emit: typeof deps.emit === 'function' ? deps.emit : () => {},
    alfred: deps.alfred || null,
    butler: deps.butler || null,
    systemBase: (deps.systemBase || SYSTEM_BASE).replace(/\/+$/, ''),
    managedHost: deps.managedHost || null,
    downloadBase: (deps.downloadBase || DOWNLOAD_BASE).replace(/\/+$/, ''),
    secrets: typeof deps.secrets === 'function' ? deps.secrets : () => [],
    readyTimeoutMs: deps.readyTimeoutMs || 25000,
    retryDelayMs: deps.retryDelayMs != null ? deps.retryDelayMs : 1500,
    idleMs: deps.idleMs || 120000,
    chatTimeoutMs: deps.chatTimeoutMs || 120000,
    installerTimeoutMs: deps.installerTimeoutMs || 15 * 60 * 1000,
  };
  const om = d.ollamaManager;
  const P = d.platform === 'win32' ? path.win32 : path.posix;
  const managedHost = () => d.managedHost || d.env.AUTOINJECTOR_OLLAMA_HOST || om.DEFAULT_MANAGED_HOST || '127.0.0.1:11435';
  const managedBase = () => `http://${managedHost()}`;

  // Lane A modules are optional (guarded): a function getter or the module itself, or null.
  // Each may be the module/object itself or a getter function returning it (so main.js can require lazily).
  const opt = (v) => { try { return typeof v === 'function' ? v() : v; } catch (_) { return null; } };
  const catalog = () => opt(deps.catalog) || null;
  const hwLib = () => opt(deps.llmHardware) || null;

  // ---- secrets never leave: scrub any known secret from text that goes to a log or an event ----
  function redact(s) {
    let out = String(s == null ? '' : s);
    let list = [];
    try { list = d.secrets() || []; } catch (_) { list = []; }
    for (const sec of list) if (sec && String(sec).length >= 4) out = out.split(String(sec)).join('••••');
    return out.replace(/\bhf_[A-Za-z0-9]{8,}\b/g, 'hf_••••');
  }
  function scrub(v) {
    if (v == null) return v;
    if (typeof v === 'string') return redact(v);
    if (Array.isArray(v)) return v.map(scrub);
    if (typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) { if (/token|secret|password|apikey/i.test(k)) continue; o[k] = scrub(x); } return o; }
    return v;
  }
  function emit(payload) { try { d.emit(scrub(payload)); } catch (_) {} }
  function log(kind, detail) { try { d.log(kind, scrub(detail || {})); } catch (_) {} }
  function say(message, level = 'info', task) { emit({ type: 'log', level, task: task || null, message, at: Date.now() }); }

  // ---- busy / cancel ----
  let busy = null;       // 'install' | 'pull' | 'setup' | null
  let controller = null; // AbortController for the running task
  let child = null;      // a running installer / extractor
  function begin(task) { busy = task; controller = new AbortController(); return controller.signal; }
  function end(task) { if (busy === task) { busy = null; controller = null; child = null; } }
  function cancel() {
    if (!busy) return { ok: true, cancelled: false, message: 'Nothing is running.' };
    const was = busy;
    try { controller && controller.abort(); } catch (_) {}
    try { child && child.kill && child.kill(); } catch (_) {}
    say('Cancelled.', 'warn', was);
    log('llm-cancel', { task: was });
    return { ok: true, cancelled: true, task: was };
  }

  // ---- HTTP (never throws) ----
  async function http(url, { method = 'GET', body, timeoutMs = 5000, signal, headers } = {}) {
    const c = new AbortController();
    const onAbort = () => c.abort();
    if (signal) { if (signal.aborted) return { ok: false, error: 'cancelled' }; signal.addEventListener('abort', onAbort, { once: true }); }
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; c.abort(); }, Math.max(200, timeoutMs));
    try {
      const res = await d.fetch(url, { method, headers: Object.assign(body !== undefined ? { 'Content-Type': 'application/json' } : {}, headers || {}), body: body !== undefined ? JSON.stringify(body) : undefined, signal: c.signal });
      let text = ''; try { text = await res.text(); } catch (_) {}
      let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
      return { ok: !!res.ok, status: res.status, json, text };
    } catch (e) {
      if (signal && signal.aborted) return { ok: false, error: 'cancelled' };
      if (timedOut) return { ok: false, error: 'timeout' };
      return { ok: false, error: 'network', detail: String((e && e.message) || e) };
    } finally { clearTimeout(t); if (signal) signal.removeEventListener('abort', onAbort); }
  }
  async function probe(base, timeoutMs = 2000) {
    const r = await http(`${base}/api/version`, { timeoutMs });
    if (r.ok) return { ok: true, version: (r.json && r.json.version) || null };
    if (r.status === 404) { const t = await http(`${base}/api/tags`, { timeoutMs }); if (t.ok) return { ok: true, version: null }; }
    return { ok: false };
  }

  // ---- hardware ----
  let hwCache = null, hwAt = 0;
  async function fallbackHardware() {
    let gpus = [];
    const notes = [];
    try {
      const gm = deps.gpuMonitor || require('./gpu-monitor');
      const r = await gm.read();
      if (r && r.available) gpus = r.gpus.map((g) => ({ name: g.name, vendor: 'nvidia', vramMB: Number(g.memTotal) || 0 }));
      else notes.push('No NVIDIA graphics card found (other makes are not detected in this build).');
    } catch (_) { notes.push('Could not read the graphics card.'); }
    const osm = deps.os || os;
    const ramMB = Math.round(osm.totalmem() / MB), freeRamMB = Math.round(osm.freemem() / MB);
    const cpus = (osm.cpus && osm.cpus()) || [];
    const appleSilicon = d.platform === 'darwin' && d.arch === 'arm64';
    let bestVramMB = gpus.reduce((m, g) => Math.max(m, g.vramMB || 0), 0);
    if (appleSilicon) { bestVramMB = Math.round(ramMB * 0.7); gpus = [{ name: 'Apple Silicon', vendor: 'apple', vramMB: bestVramMB }]; notes.push('Apple Silicon shares its memory: about 70% of it can hold a model.'); }
    return { ok: true, gpus, bestVramMB, ramMB, freeRamMB, cpu: cpus[0] ? cpus[0].model : '', cores: cpus.length, platform: d.platform, appleSilicon, notes };
  }
  async function hardware(fresh) {
    if (!fresh && hwCache && Date.now() - hwAt < 60000) return hwCache;
    let hw = null;
    try {
      if (typeof deps.hardware === 'function') hw = await deps.hardware();
      else { const lib = hwLib(); hw = lib && typeof lib.detectHardware === 'function' ? await lib.detectHardware() : await fallbackHardware(); }
    } catch (_) { hw = null; }
    if (!hw || typeof hw !== 'object') { try { hw = await fallbackHardware(); } catch (_) { hw = { ok: false, gpus: [], bestVramMB: 0, ramMB: 0, freeRamMB: 0, notes: ['Could not read this PC\'s hardware.'] }; } }
    hwCache = hw; hwAt = Date.now();
    return hw;
  }
  function hwLine(hw) {
    if (!hw) return 'Could not read this PC.';
    const g = (hw.gpus || []).slice().sort((a, b) => (b.vramMB || 0) - (a.vramMB || 0))[0];
    const parts = [];
    if (g) parts.push(`${g.name}${g.vramMB ? ` ${gbText(g.vramMB * MB)}` : ''}`); else parts.push('no graphics card found');
    if (hw.ramMB) parts.push(`${gbText(hw.ramMB * MB)} RAM`);
    return `Your PC: ${parts.join(' · ')}`;
  }
  function fitFor(sizeBytes, hw) {
    const lib = hwLib();
    try { if (lib && typeof lib.rateFit === 'function') return lib.rateFit(sizeBytes, hw); } catch (_) {}
    return fallbackFit(sizeBytes, hw);
  }

  // ---- find Ollama ----
  function exists(p) { try { return !!p && d.fs.existsSync(p); } catch (_) { return false; } }
  function appInstallDir() { try { return d.paths.appInstallDir() || null; } catch (_) { return null; } }
  function candidatePaths() {
    const env = d.env, home = d.homedir, out = [];
    const add = (p, where) => { if (p && !out.some((x) => x.path === p)) out.push({ path: p, where }); };
    if (env.OLLAMA_BIN && /[\\/]/.test(env.OLLAMA_BIN)) add(env.OLLAMA_BIN, 'setting');
    const exe = d.platform === 'win32' ? 'ollama.exe' : 'ollama';
    for (const dir of String(env.PATH || env.Path || '').split(d.platform === 'win32' ? ';' : ':').filter(Boolean)) add(P.join(dir, exe), 'path');
    const app = appInstallDir();
    if (d.platform === 'win32') {
      if (env.LOCALAPPDATA) add(P.join(env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'), 'standard');
      add(P.join(home, 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe'), 'standard');
      if (env.ProgramFiles) add(P.join(env.ProgramFiles, 'Ollama', 'ollama.exe'), 'standard');
      if (app) add(P.join(app, 'ollama.exe'), 'app');
    } else if (d.platform === 'darwin') {
      add('/Applications/Ollama.app/Contents/Resources/ollama', 'standard');
      add(P.join(home, 'Applications', 'Ollama.app', 'Contents', 'Resources', 'ollama'), 'standard');
      add('/usr/local/bin/ollama', 'standard');
      add('/opt/homebrew/bin/ollama', 'standard');
      if (app) add(P.join(app, 'Ollama.app', 'Contents', 'Resources', 'ollama'), 'app');
    } else {
      add('/usr/local/bin/ollama', 'standard');
      add('/usr/bin/ollama', 'standard');
      add(P.join(home, '.local', 'bin', 'ollama'), 'standard');
      if (app) add(P.join(app, 'bin', 'ollama'), 'app');
    }
    return out;
  }
  function runVersion(bin) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        const c = d.execFile(bin, ['--version'], { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
          const v = parseVersion(`${stdout || ''}\n${stderr || ''}`);
          if (v) return finish({ ok: true, version: v });
          finish({ ok: !err, version: null, error: err ? String(err.code || err.message || err) : null });
        });
        if (c && typeof c.on === 'function') c.on('error', () => finish({ ok: false }));
      } catch (e) { finish({ ok: false, error: String((e && e.message) || e) }); }
    });
  }
  let lastFound = null, lastFoundAt = 0;
  async function findOllama(opts = {}) {
    if (opts.cached && lastFound && lastFound.ok && Date.now() - lastFoundAt < 15000) return lastFound;
    lastFoundAt = Date.now();
    try {
      for (const c of candidatePaths()) {
        if (!exists(c.path)) continue;
        const v = await runVersion(c.path);
        if (!v.ok && !v.version) continue;
        try { om.setBin && om.setBin(c.path); } catch (_) {}
        lastFound = { ok: true, found: true, bin: c.path, version: v.version, where: c.where };
        return lastFound;
      }
      // last resort: whatever the OS resolves "ollama" to (PATHEXT etc.)
      const v = await runVersion('ollama');
      if (v.ok || v.version) { lastFound = { ok: true, found: true, bin: 'ollama', version: v.version, where: 'path' }; return lastFound; }
    } catch (_) { /* fall through */ }
    lastFound = { ok: false, found: false, error: 'Ollama (the program that runs local AI models) is not installed yet.' };
    return lastFound;
  }

  // ---- download with progress, resume and retry ----
  function freeBytes(dir) {
    if (typeof deps.freeBytes === 'function') { try { return deps.freeBytes(dir); } catch (_) { return null; } }
    try {
      let p = dir;
      while (p && !exists(p)) { const up = P.dirname(p); if (up === p) break; p = up; }
      const st = d.fs.statfsSync(p);
      return Number(st.bavail) * Number(st.bsize);
    } catch (_) { return null; }
  }
  async function download(url, dest, { signal, onProgress, label = 'Downloading', retries = 3 } = {}) {
    const part = `${dest}.part`;
    try { d.fs.mkdirSync(P.dirname(dest), { recursive: true }); } catch (e) { return { ok: false, error: friendlyError(e, 'make the download folder') }; }
    let lastErr = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
      if (signal && signal.aborted) return { ok: false, cancelled: true, error: 'Cancelled.' };
      let start = 0;
      try { start = exists(part) ? d.fs.statSync(part).size : 0; } catch (_) { start = 0; }
      const c = new AbortController();
      const onAbort = () => c.abort();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      let idle = null, stalled = false;
      const kick = () => { if (idle) clearTimeout(idle); idle = setTimeout(() => { stalled = true; c.abort(); }, d.idleMs); };
      let ws = null;
      try {
        kick();
        const res = await d.fetch(url, { headers: start ? { Range: `bytes=${start}-` } : {}, signal: c.signal, redirect: 'follow' });
        if (res.status === 416 && start > 0) { d.fs.renameSync(part, dest); return { ok: true, file: dest, bytes: start, resumed: true }; }
        if (res.status === 404) return { ok: false, notFound: true, error: 'The download address was not found (404).' };
        if (!res.ok) { lastErr = new Error(`the server answered HTTP ${res.status}`); throw lastErr; }
        if (res.status !== 206 && start > 0) start = 0; // the server ignored the resume: start over
        const len = Number(res.headers && res.headers.get && res.headers.get('content-length')) || 0;
        const total = len ? start + len : null;
        if (len) {
          const free = freeBytes(P.dirname(dest));
          if (free != null && free < len * 1.1 + 50 * MB) return { ok: false, error: `Not enough free disk space: the download needs about ${gbText(len)} and the drive has ${gbText(free)} free. Free up some space and try again.` };
        }
        ws = d.fs.createWriteStream(part, { flags: start ? 'a' : 'w' });
        let wsErr = null; ws.on('error', (e) => { wsErr = e; });
        let got = start, lastEmit = 0, t0 = Date.now(), base = start;
        const reader = res.body && res.body.getReader ? res.body.getReader() : null;
        const write = (buf) => new Promise((resolve, reject) => { if (wsErr) return reject(wsErr); ws.write(buf, (e) => (e ? reject(e) : resolve())); });
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            kick();
            await write(Buffer.from(value));
            got += value.length;
            const now = Date.now();
            if (onProgress && (now - lastEmit > 250)) {
              lastEmit = now;
              const secs = Math.max(0.001, (now - t0) / 1000);
              const rate = (got - base) / secs;
              onProgress({ percent: total ? Math.min(100, Math.floor((got / total) * 100)) : null, completedBytes: got, totalBytes: total, mbps: rate / MB, etaSec: total && rate > 0 ? (total - got) / rate : null, message: `${label} — ${total ? `${Math.floor((got / total) * 100)}% (${gbText(got)} of ${gbText(total)})` : gbText(got)}${rate > 0 ? ` · ${(rate / MB).toFixed(1)} MB/s` : ''}${total && rate > 0 ? ` · about ${timeText((total - got) / rate)} left` : ''}` });
            }
          }
        } else {
          const buf = Buffer.from(await res.arrayBuffer());
          await write(buf); got += buf.length;
        }
        await new Promise((resolve, reject) => ws.end((e) => (e ? reject(e) : resolve())));
        ws = null;
        if (wsErr) throw wsErr;
        if (total && got < total) { lastErr = new Error('the download was cut off'); throw lastErr; }
        d.fs.renameSync(part, dest);
        if (onProgress) onProgress({ percent: 100, completedBytes: got, totalBytes: total || got, message: `${label} — done (${gbText(got)})` });
        return { ok: true, file: dest, bytes: got, resumed: base > 0 };
      } catch (e) {
        if (ws) { try { ws.destroy(); } catch (_) {} }
        if (signal && signal.aborted) return { ok: false, cancelled: true, error: 'Cancelled.' };
        if (e && (e.code === 'ENOSPC' || e.code === 'EACCES' || e.code === 'EPERM')) return { ok: false, error: friendlyError(e, 'save the download') };
        lastErr = stalled ? new Error('the download stalled (no data for a while)') : e;
        if (attempt < retries) { emit({ type: 'log', level: 'warn', message: `${label}: connection problem — retrying (${attempt + 1} of ${retries})…` }); await sleep(d.retryDelayMs * attempt); }
      } finally { if (idle) clearTimeout(idle); if (signal) signal.removeEventListener('abort', onAbort); }
    }
    return { ok: false, error: friendlyError(lastErr, 'download it') };
  }

  function runProcess(bin, args, { signal, timeoutMs, what } = {}) {
    return new Promise((resolve) => {
      let done = false, timer = null;
      const finish = (v) => { if (!done) { done = true; if (timer) clearTimeout(timer); child = null; resolve(v); } };
      let c;
      try { c = d.spawn(bin, args, { windowsHide: true }); } catch (e) { return finish({ ok: false, error: friendlyError(e, what) }); }
      child = c;
      if (!c || typeof c.on !== 'function') return finish({ ok: false, error: `I couldn't ${what}.` });
      c.on('error', (e) => finish({ ok: false, error: friendlyError(e, what), code: e && e.code }));
      c.on('close', (code) => {
        if (signal && signal.aborted) return finish({ ok: false, cancelled: true, error: 'Cancelled.' });
        finish(code === 0 ? { ok: true } : { ok: false, exitCode: code });
      });
      timer = setTimeout(() => { try { c.kill(); } catch (_) {} finish({ ok: false, error: `It took too long to ${what} — it was stopped.` }); }, timeoutMs || d.installerTimeoutMs);
      if (signal) signal.addEventListener('abort', () => { try { c.kill(); } catch (_) {} }, { once: true });
    });
  }
  function innoError(code) {
    switch (code) {
      case 1: return 'The Ollama installer could not start. Restart the PC and press the button again, or install it from ollama.com.';
      case 2: case 5: return 'The Ollama installer was cancelled before it finished.';
      case 3: case 4: case 6: return 'The Ollama installer stopped with an error (an antivirus may have blocked it, or Ollama is running and could not be replaced). Close Ollama from its tray icon and try again.';
      case 7: case 8: return 'The Ollama installer needs the PC to restart first. Restart, then press the button again.';
      default: return `The Ollama installer stopped with error ${code}. An antivirus may have blocked it — allow it, or install Ollama from ollama.com yourself.`;
    }
  }

  // ---- install ----
  async function installOllama(opts = {}) {
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const pre = await findOllama();
    if (pre.ok) return { ok: true, already: true, bin: pre.bin, version: pre.version, message: `Ollama ${pre.version || ''} is already installed.`.replace('  ', ' ') };
    const nested = busy === 'setup';
    if (busy && !nested) return { ok: false, busy: true, error: 'I am already busy with something — wait for it to finish (or press Cancel).' };
    const signal = nested ? controller.signal : begin('install');
    const progress = (p) => { const ev = Object.assign({ type: 'progress', task: 'install' }, p); emit(ev); if (onProgress) { try { onProgress(ev); } catch (_) {} } };
    try {
      let dlDir; try { dlDir = d.paths.downloadsDir(); } catch (_) { dlDir = null; }
      if (!dlDir) dlDir = P.join(os.tmpdir(), 'autoinjector-downloads');
      say('Installing Ollama (the program that runs Alfred\'s AI on this PC)…', 'info', 'install');
      log('llm-install-start', { platform: d.platform, arch: d.arch });
      let r;
      if (d.platform === 'win32') {
        const exe = P.join(dlDir, 'OllamaSetup.exe');
        const dl = await download(`${d.downloadBase}/OllamaSetup.exe`, exe, { signal, onProgress: progress, label: 'Downloading Ollama' });
        if (!dl.ok) return finishInstall(dl);
        progress({ percent: null, message: 'Running the Ollama installer (this can take a minute)…' });
        const run = await runProcess(exe, ['/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES', '/SP-'], { signal, what: 'run the Ollama installer' });
        if (!run.ok) return finishInstall(run.exitCode != null ? { ok: false, error: innoError(run.exitCode) } : run);
        r = { ok: true };
      } else if (d.platform === 'darwin') {
        const zip = P.join(dlDir, 'Ollama-darwin.zip');
        const dl = await download(`${d.downloadBase}/Ollama-darwin.zip`, zip, { signal, onProgress: progress, label: 'Downloading Ollama' });
        if (!dl.ok) return finishInstall(dl);
        const apps = P.join(d.homedir, 'Applications');
        try { d.fs.mkdirSync(apps, { recursive: true }); } catch (_) {}
        progress({ percent: null, message: 'Unpacking Ollama into your Applications folder…' });
        let run = await runProcess('ditto', ['-x', '-k', zip, apps], { signal, timeoutMs: 10 * 60000, what: 'unpack Ollama' });
        if (!run.ok && !run.cancelled) run = await runProcess('unzip', ['-o', '-q', zip, '-d', apps], { signal, timeoutMs: 10 * 60000, what: 'unpack Ollama' });
        if (!run.ok) return finishInstall(run.error ? run : { ok: false, error: 'I couldn\'t unpack Ollama (the download may be damaged). Press the button again.' });
        r = { ok: true };
      } else {
        const dir = appInstallDir() || P.join(d.homedir, '.local', 'share', 'autoinjector', 'ollama');
        try { d.fs.mkdirSync(dir, { recursive: true }); } catch (e) { return finishInstall({ ok: false, error: friendlyError(e, 'make the Ollama folder') }); }
        const arch = d.arch === 'arm64' ? 'arm64' : 'amd64';
        const tries = [[`ollama-linux-${arch}.tgz`, ['-xzf']], [`ollama-linux-${arch}.tar.zst`, ['--zstd', '-xf']]];
        let dl = null, flags = null;
        for (const [name, f] of tries) {
          dl = await download(`${d.downloadBase}/${name}`, P.join(dlDir, name), { signal, onProgress: progress, label: 'Downloading Ollama' });
          if (dl.ok) { flags = f; break; }
          if (!dl.notFound) break;
        }
        if (!dl || !dl.ok) return finishInstall(dl && dl.notFound ? { ok: false, error: 'I couldn\'t find the Ollama download for this computer on ollama.com. Install it from ollama.com yourself, then press 🩺 Check.' } : dl);
        progress({ percent: null, message: 'Unpacking Ollama…' });
        const run = await runProcess('tar', [...flags, dl.file, '-C', dir], { signal, timeoutMs: 10 * 60000, what: 'unpack Ollama' });
        if (!run.ok) return finishInstall(run.error ? run : { ok: false, error: 'I couldn\'t unpack Ollama (the download may be damaged, or the disk is full). Press the button again.' });
        r = { ok: true };
      }
      if (!r.ok) return finishInstall(r);
      let found = null;
      for (let i = 0; i < 20; i++) { found = await findOllama(); if (found.ok || (signal && signal.aborted)) break; await sleep(500); }
      if (!found || !found.ok) return finishInstall({ ok: false, error: 'Ollama was installed, but I can\'t find the program afterwards. Restart AutoInjector and press 🩺 Check — or install Ollama from ollama.com yourself.' });
      return finishInstall({ ok: true, bin: found.bin, version: found.version, message: `✓ Ollama ${found.version || ''} installed.`.replace('  ', ' ') });
    } catch (e) {
      return finishInstall({ ok: false, error: friendlyError(e, 'install Ollama') });
    } finally { if (!nested) end('install'); }

    function finishInstall(res) {
      const out = Object.assign({}, res);
      if (signal && signal.aborted) { out.ok = false; out.cancelled = true; out.error = 'Cancelled.'; }
      if (!out.ok && !out.error) out.error = 'I couldn\'t install Ollama.';
      emit({ type: 'done', task: 'install', ok: !!out.ok, message: out.ok ? out.message : out.error });
      log(out.ok ? 'llm-install-done' : 'llm-install-error', { ok: !!out.ok, error: out.error || null, version: out.version || null });
      return out;
    }
  }

  // ---- the server ----
  async function resolveServer() {
    try {
      const ms = om.managedStatus ? om.managedStatus() : null;
      if (ms && ms.running && ms.endpoint) { const p = await probe(ms.endpoint.replace(/\/+$/, '')); if (p.ok) return { ok: true, base: ms.endpoint.replace(/\/+$/, ''), which: 'app', version: p.version }; }
    } catch (_) {}
    for (const [base, which] of [[managedBase(), 'app'], [d.systemBase, 'system']]) {
      const p = await probe(base);
      if (p.ok) return { ok: true, base, which, version: p.version };
    }
    return { ok: false };
  }
  function alfredBase() {
    try {
      const s = d.alfred && d.alfred.getSettings ? d.alfred.getSettings() : null;
      const ep = s && s.local && s.local.endpoint;
      return ep ? String(ep).replace(/\/chat\/completions.*$/, '').replace(/\/v1\/?$/, '').replace(/\/+$/, '') : null;
    } catch (_) { return null; }
  }
  /** The Ollama in use: Alfred's own address when it answers, else whichever one is up. */
  async function currentServer() {
    const ab = alfredBase();
    if (ab) { const p = await probe(ab); if (p.ok) return { ok: true, base: ab, which: ab === managedBase() ? 'app' : ab === d.systemBase ? 'system' : 'custom', version: p.version }; }
    return resolveServer();
  }
  function whereText(srv) { return srv.which === 'app' ? `AutoInjector's own Ollama at ${srv.base}` : srv.which === 'system' ? `the Ollama already running on this PC at ${srv.base}` : `Ollama at ${srv.base}`; }
  async function startOllama() {
    try {
      const cur = await currentServer();
      if (cur.ok) return { ok: true, already: true, base: cur.base, which: cur.which, message: `Ollama is running — ${whereText(cur)}.` };
      const found = await findOllama();
      if (!found.ok) return { ok: false, error: 'Ollama isn\'t installed yet — press ⚡ Set up (or Install Ollama) first.', fix: { action: 'install', label: '⬇ Install Ollama' } };
      let modelsDir = null; try { modelsDir = d.paths.modelsDir(); } catch (_) {}
      if (!modelsDir) return { ok: false, error: 'The app\'s content folder isn\'t ready yet, so I can\'t start Ollama. Wait a moment and try again.' };
      try { d.fs.mkdirSync(modelsDir, { recursive: true }); } catch (_) {}
      const host = managedHost();
      say(`Starting Ollama (models stored in ${modelsDir})…`, 'info', 'start');
      const r = om.startManaged({ modelsDir, host, bin: found.bin, spawnFn: d.spawn, onLog: () => {} });
      if (!r || !r.ok) return { ok: false, error: friendlyError({ message: r && r.error }, 'start Ollama') };
      const deadline = Date.now() + d.readyTimeoutMs;
      while (Date.now() < deadline) {
        const p = await probe(`http://${host}`, 1500);
        if (p.ok) { log('llm-start', { host, ok: true }); emit({ type: 'server', running: true, base: `http://${host}`, which: 'app' }); return { ok: true, started: true, base: `http://${host}`, which: 'app', message: `✓ Ollama started at http://${host}.` }; }
        await sleep(300);
      }
      log('llm-start', { host, ok: false });
      return { ok: false, error: 'Ollama started but isn\'t answering yet. Wait a few seconds and press 🩺 Check — if it stays like this, restart the PC.' };
    } catch (e) { return { ok: false, error: friendlyError(e, 'start Ollama') }; }
  }
  async function stopOllama() {
    try {
      const ms = om.managedStatus ? om.managedStatus() : { running: false };
      if (ms.running) { om.stopManaged(); log('llm-stop', {}); emit({ type: 'server', running: false }); return { ok: true, stopped: true, message: 'Stopped AutoInjector\'s Ollama.' }; }
      const sys = await probe(d.systemBase);
      if (sys.ok) return { ok: true, stopped: false, message: 'The Ollama running now was started outside AutoInjector (by its own app) — to turn it off, quit Ollama from its icon in the taskbar / menu bar.' };
      return { ok: true, stopped: false, message: 'Ollama isn\'t running.' };
    } catch (e) { return { ok: false, error: friendlyError(e, 'stop Ollama') }; }
  }

  // ---- models ----
  async function listModels(opts = {}) {
    const srv = opts.base ? { ok: true, base: opts.base } : await currentServer();
    if (!srv.ok) return { ok: false, models: [], error: 'Ollama isn\'t running, so I can\'t list the models.' };
    const r = await http(`${srv.base}/api/tags`, { timeoutMs: 5000 });
    if (!r.ok) return { ok: false, models: [], base: srv.base, error: r.error === 'timeout' ? 'Ollama didn\'t answer in time.' : 'Ollama didn\'t give me its list of models.' };
    let hw = opts.hardware || hwCache;
    if (!hw) { try { hw = await hardware(); } catch (_) { hw = null; } }
    const models = ((r.json && r.json.models) || []).filter((m) => m && (m.name || m.model)).map((m) => {
      const det = m.details || {};
      const sizeBytes = Number(m.size) || null;
      return { name: m.name || m.model, sizeBytes, sizeText: gbText(sizeBytes), modified: m.modified_at || null, family: det.family || null, params: det.parameter_size || null, quant: det.quantization_level || null, uncensored: isUncensored(m.name || m.model), fit: hw && sizeBytes ? fitFor(sizeBytes, hw) : null };
    });
    return { ok: true, base: srv.base, which: srv.which, models };
  }
  function pullError(raw, name) {
    const s = String(raw || '');
    if (/file does not exist|not found|manifest unknown|no such model|invalid model name/i.test(s)) return `Ollama couldn't find a model called "${name}". Check the name (for example qwen2.5:7b).`;
    if (/unauthori[sz]ed|forbidden|401|403|gated|access/i.test(s)) return `"${name}" needs permission to download (it is gated or private). Open its page, accept the terms, or pick another model.`;
    if (/no space|disk full|ENOSPC/i.test(s)) return 'The disk is full — free up some space and try again.';
    if (/dial tcp|lookup|no such host|connection refused|i\/o timeout|network|TLS|EOF|reset/i.test(s)) return 'Ollama couldn\'t reach the model library — check the internet connection and try again.';
    return `The download of "${name}" failed${s ? ` (${s.slice(0, 160)})` : ''}.`;
  }
  async function pullModel(pullName, opts = {}) {
    const name = String(pullName || '').trim();
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    if (!MODEL_NAME_RE.test(name)) return { ok: false, error: 'That doesn\'t look like a model name (for example qwen2.5:7b).' };
    const nested = busy === 'setup';
    if (busy && !nested) return { ok: false, busy: true, error: 'I am already busy with something — wait for it to finish (or press Cancel).' };
    const signal = nested ? controller.signal : begin('pull');
    const progress = (p) => { const ev = Object.assign({ type: 'progress', task: 'pull', model: name, pullName: name }, p); if (ev.etaSec != null && ev.eta == null) ev.eta = timeText(ev.etaSec); emit(ev); if (onProgress) { try { onProgress(ev); } catch (_) {} } };
    const finish = (res) => {
      const out = Object.assign({ model: name, pullName: name }, res);
      if (signal.aborted) { out.ok = false; out.cancelled = true; out.error = 'Download cancelled.'; }
      emit({ type: 'done', task: 'pull', model: name, pullName: name, ok: !!out.ok, message: out.ok ? out.message : out.error });
      log(out.ok ? 'llm-pull-done' : 'llm-pull-error', { model: name, ok: !!out.ok, error: out.error || null });
      if (!nested) end('pull');
      return out;
    };
    try {
      let srv = opts.base ? { ok: true, base: opts.base } : await currentServer();
      if (!srv.ok) { const st = await startOllama(); if (!st.ok) return finish({ ok: false, error: st.error, fix: st.fix }); srv = st; }
      const size = Number(opts.sizeBytes) || null;
      if (size && !opts.allowTooBig) {
        let fit = null; try { fit = fitFor(size, await hardware()); } catch (_) { fit = null; }
        if (fit && fit.rating === 'too-big') return finish({ ok: false, tooBig: true, fit, error: `${name} is too big for this PC, so I won't download it. ${fit.reason || ''} Pick a smaller size.`.trim() });
      }
      if (size) {
        let dir = null;
        try { dir = srv.which === 'app' ? d.paths.modelsDir() : om.defaultStoreDir ? om.defaultStoreDir(d.env) : null; } catch (_) {}
        const free = dir ? freeBytes(dir) : null;
        if (free != null && free < size * 1.1 + GB) return finish({ ok: false, error: `Not enough free disk space for ${name}: it needs about ${gbText(size * 1.1 + GB)} and the drive has ${gbText(free)} free. Free up some space or pick a smaller model.` });
      }
      say(`Downloading ${name}…`, 'info', 'pull');
      progress({ percent: 0, status: 'starting', message: `Starting the download of ${name}…` });
      const c = new AbortController();
      const onAbort = () => c.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      let idle = null, stalled = false;
      const kick = () => { if (idle) clearTimeout(idle); idle = setTimeout(() => { stalled = true; c.abort(); }, d.idleMs); };
      kick();
      let res;
      try {
        res = await d.fetch(`${srv.base}/api/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name, name, stream: true }), signal: c.signal });
      } catch (e) {
        clearTimeout(idle); signal.removeEventListener('abort', onAbort);
        if (signal.aborted) return finish({ ok: false });
        return finish({ ok: false, error: stalled ? 'The download stalled (no progress for a while). Press the button again — it picks up where it stopped.' : 'Ollama stopped answering while starting the download. Press ▶ Start Ollama and try again.' });
      }
      if (res.status === 404 || res.status === 405) {
        // a very old Ollama without the HTTP pull: fall back to `ollama pull`
        clearTimeout(idle); signal.removeEventListener('abort', onAbort);
        const host = srv.base.replace(/^https?:\/\//, '');
        const h = om.pull(name, (line) => progress({ percent: null, status: 'cli', message: String(line).slice(0, 200) }), { host });
        const onA = () => { try { h.child && h.child.kill(); } catch (_) {} };
        signal.addEventListener('abort', onA, { once: true });
        const r = await h.done;
        signal.removeEventListener('abort', onA);
        return finish(r.ok ? { ok: true, message: `✓ ${name} downloaded.` } : { ok: false, error: pullError(r.error, name) });
      }
      if (!res.ok) {
        let t = ''; try { t = await res.text(); } catch (_) {}
        clearTimeout(idle); signal.removeEventListener('abort', onAbort);
        let msg = t; try { msg = JSON.parse(t).error || t; } catch (_) {}
        return finish({ ok: false, error: pullError(msg || `HTTP ${res.status}`, name) });
      }
      const layers = new Map();
      let buf = '', status = '', error = null, success = false, lastEmit = 0;
      const t0 = Date.now();
      let startBytes = null;
      const reader = res.body && res.body.getReader ? res.body.getReader() : null;
      const handle = (line) => {
        if (!line.trim()) return;
        let j; try { j = JSON.parse(line); } catch (_) { return; }
        if (j.error) { error = j.error; return; }
        const changed = !!j.status && j.status !== status;
        if (j.status) status = j.status;
        if (j.digest && j.total) layers.set(j.digest, { total: Number(j.total) || 0, completed: Number(j.completed) || 0 });
        if (j.status === 'success') success = true;
        const total = [...layers.values()].reduce((a, l) => a + l.total, 0);
        const done = [...layers.values()].reduce((a, l) => a + Math.min(l.total, l.completed), 0);
        if (startBytes == null && total) startBytes = done;
        const now = Date.now();
        if (now - lastEmit > 250 || changed || j.status === 'success' || !j.digest) {
          lastEmit = now;
          const secs = Math.max(0.001, (now - t0) / 1000);
          const rate = total ? (done - (startBytes || 0)) / secs : 0;
          const pct = total ? Math.min(100, Math.floor((done / total) * 100)) : null;
          const eta = total && rate > 0 ? (total - done) / rate : null;
          const words = j.status === 'success' ? 'done' : /^pulling manifest/.test(status) ? 'getting ready' : /^pulling /.test(status) ? 'downloading' : /^verifying/.test(status) ? 'checking the download' : /^writing/.test(status) ? 'finishing' : status;
          progress({ percent: success ? 100 : pct, status: words, rawStatus: status, completedBytes: done, totalBytes: total || null, mbps: rate / MB, etaSec: eta, message: `${name}: ${words}${pct != null && !success ? ` — ${pct}% (${gbText(done)} of ${gbText(total)})` : ''}${rate > 0 && !success ? ` · ${(rate / MB).toFixed(1)} MB/s` : ''}${eta != null && !success ? ` · about ${timeText(eta)} left` : ''}` });
        }
      };
      try {
        if (reader) {
          const dec = new TextDecoder();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            kick();
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
          }
          handle(buf);
        } else { for (const l of String(await res.text()).split('\n')) handle(l); }
      } catch (e) {
        if (signal.aborted) return finish({ ok: false });
        return finish({ ok: false, error: stalled ? 'The download stalled (no progress for a while). Press the button again — it picks up where it stopped.' : 'The connection to Ollama broke during the download. Press the button again — it picks up where it stopped.' });
      } finally { clearTimeout(idle); signal.removeEventListener('abort', onAbort); }
      if (error) return finish({ ok: false, error: pullError(error, name) });
      if (!success) return finish({ ok: false, error: 'The download ended before it finished. Press the button again — it picks up where it stopped.' });
      return finish({ ok: true, message: `✓ ${name} downloaded.`, base: srv.base });
    } catch (e) {
      return finish({ ok: false, error: friendlyError(e, `download ${name}`) });
    }
  }
  async function removeModel(name) {
    const n = String(name || '').trim();
    if (!MODEL_NAME_RE.test(n)) return { ok: false, error: 'That doesn\'t look like a model name.' };
    const srv = await currentServer();
    if (!srv.ok) return { ok: false, error: 'Ollama isn\'t running, so I can\'t remove the model. Press ▶ Start Ollama first.' };
    const r = await http(`${srv.base}/api/delete`, { method: 'DELETE', body: { model: n, name: n }, timeoutMs: 15000 });
    if (r.ok) { log('llm-remove', { model: n }); emit({ type: 'models-changed' }); return { ok: true, message: `Removed ${n}.` }; }
    if (r.status === 404) return { ok: false, error: `${n} isn't installed.` };
    return { ok: false, error: `Ollama didn't remove ${n}${r.json && r.json.error ? ` (${String(r.json.error).slice(0, 120)})` : ''}.` };
  }

  // ---- talking to a model ----
  async function chat(base, model, body, timeoutMs) {
    return http(`${base}/v1/chat/completions`, { method: 'POST', body: Object.assign({ model, stream: false, temperature: 0 }, body), timeoutMs: timeoutMs || d.chatTimeoutMs, signal: controller ? controller.signal : undefined });
  }
  function chatError(r, model) {
    if (r.error === 'timeout') return `${model} took too long to answer — it may be too big for this PC. Try a smaller model.`;
    if (r.error === 'network') return 'Ollama stopped answering. Press ▶ Start Ollama and check again.';
    if (r.error === 'cancelled') return 'Cancelled.';
    const e = String((r.json && r.json.error && (r.json.error.message || r.json.error)) || r.text || '');
    if (r.status === 404 || /not found/i.test(e)) return `${model} isn't downloaded yet.`;
    if (/memory|out of memory|requires more system memory/i.test(e)) return `This PC doesn't have enough free memory to load ${model}. Close other programs or pick a smaller model.`;
    return `${model} didn't answer properly${e ? ` (${e.slice(0, 140)})` : ''}.`;
  }
  async function quickTest(base, model) {
    const t0 = Date.now();
    const r = await chat(base, model, { messages: [{ role: 'user', content: 'Reply with just the word: ready' }], max_tokens: 24 });
    if (!r.ok) return { ok: false, error: chatError(r, model) };
    const m = r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].message;
    const text = m ? String(m.content || m.reasoning_content || m.reasoning || '').trim() : '';
    if (!text) return { ok: false, error: `${model} answered with nothing.` };
    return { ok: true, reply: text.slice(0, 80), ms: Date.now() - t0 };
  }
  async function toolTest(base, model) {
    const tools = [{ type: 'function', function: { name: 'get_time', description: 'Get the current time on this computer.', parameters: { type: 'object', properties: {}, required: [] } } }];
    const r = await chat(base, model, { messages: [{ role: 'system', content: 'You are a helpful assistant. Use the tools you are given.' }, { role: 'user', content: 'What time is it? Use the get_time tool.' }], tools, tool_choice: 'auto', max_tokens: 120 });
    const m = r.ok && r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].message;
    const calls = m && Array.isArray(m.tool_calls) ? m.tool_calls : [];
    if (calls.some((c) => c && c.function && c.function.name === 'get_time')) return { ok: true, native: true };
    if (!r.ok && r.error) return { ok: false, error: chatError(r, model) };
    // the text protocol (what Alfred falls back to when a model has no native tool calls)
    const t = await chat(base, model, { messages: [{ role: 'system', content: 'You control a computer ONLY through tools. Available tool: get_time (no arguments) — gets the current time. Answer with exactly ONE JSON object and nothing else: to use a tool {"tool": "<tool name>", "args": {}} or to answer {"reply": "<text>"}.' }, { role: 'user', content: 'What time is it?' }], max_tokens: 80 });
    const tm = t.ok && t.json && t.json.choices && t.json.choices[0] && t.json.choices[0].message;
    const txt = tm ? String(tm.content || '') : '';
    const js = /\{[\s\S]*\}/.exec(txt);
    let obj = null; try { obj = js ? JSON.parse(js[0]) : null; } catch (_) { obj = null; }
    if (obj && (obj.tool === 'get_time' || obj.name === 'get_time')) return { ok: true, native: false, text: true };
    if (!t.ok && t.error) return { ok: false, error: chatError(t, model) };
    return { ok: false, native: false, text: false };
  }

  // ---- Alfred / Butler ----
  function alfredSettings() { try { return (d.alfred && d.alfred.getSettings && d.alfred.getSettings()) || null; } catch (_) { return null; } }
  function butlerConfig() { try { return (d.butler && d.butler.get && d.butler.get()) || null; } catch (_) { return null; } }
  function butlerIsLocalOrEmpty(c) {
    if (!c || (!c.endpoint && !c.model)) return true;
    if (c.provider && c.provider !== 'openai-compatible') return false;
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[?::1\]?)(:\d+)?(\/|$)/i.test(String(c.endpoint || ''));
  }
  async function useModel(name, opts = {}) {
    try {
      const n = String(name || '').trim();
      if (!MODEL_NAME_RE.test(n)) return { ok: false, error: 'That doesn\'t look like a model name.' };
      const alsoButler = opts.alsoButler !== false;
      const srv = opts.base ? { ok: true, base: opts.base } : await currentServer();
      if (!srv.ok) return { ok: false, error: 'Ollama isn\'t running. Press ▶ Start Ollama first.', fix: { action: 'start', label: '▶ Start Ollama' } };
      const list = await listModels({ base: srv.base });
      if (list.ok && !list.models.some((m) => sameModel(m.name, n))) return { ok: false, error: `${n} isn't downloaded yet — download it first.` };
      const endpoint = `${srv.base}/v1`;
      let alfredOk = false;
      if (!opts.butlerOnly) {
        if (d.alfred && d.alfred.setSettings) {
          try { const r = d.alfred.setSettings({ local: { endpoint, model: n } }); alfredOk = !(r && r.ok === false); } catch (_) { alfredOk = false; }
        }
      }
      let butler = 'not-asked';
      if (alsoButler || opts.butlerOnly) {
        const cur = butlerConfig();
        if (!d.butler || !d.butler.set) butler = 'unavailable';
        else if (!butlerIsLocalOrEmpty(cur) && !opts.forceButler) butler = 'skipped';
        else {
          try { const r = await d.butler.set({ provider: 'openai-compatible', endpoint: `${srv.base}/v1/chat/completions`, model: n }); butler = r && r.ok === false ? 'failed' : 'set'; } catch (_) { butler = 'failed'; }
        }
      }
      log('llm-use', { model: n, base: srv.base, butler });
      emit({ type: 'model-changed', model: n, endpoint });
      const test = opts.skipTest ? null : await quickTest(srv.base, n);
      const bits = [];
      if (!opts.butlerOnly) bits.push(alfredOk ? `Alfred now uses ${n}` : `I couldn't save ${n} as Alfred's model`);
      if (butler === 'set') bits.push(opts.butlerOnly ? `the Butler now uses ${n}` : 'so does the old Butler');
      if (butler === 'skipped') bits.push('the old Butler is connected to a remote AI service, so I left it alone');
      const msg = `${bits.join('; ')}.${test ? (test.ok ? ' ✓ It answers.' : ` But: ${test.error}`) : ''}`;
      return { ok: (opts.butlerOnly || alfredOk) && (!test || test.ok), model: n, endpoint, alfred: alfredOk, butler, test, message: msg.charAt(0).toUpperCase() + msg.slice(1), error: test && !test.ok ? test.error : (!alfredOk && !opts.butlerOnly ? `I couldn't save ${n} as Alfred's model.` : undefined) };
    } catch (e) { return { ok: false, error: friendlyError(e, 'switch the model') }; }
  }

  // ---- choosing a model ----
  async function recommendedPicks(hw, { uncensored } = {}) {
    const out = [];
    const cat = catalog();
    if (cat && typeof cat.curated === 'function') {
      try {
        let list = await cat.curated(hw, { uncensored: !!uncensored });
        if (list && !Array.isArray(list)) list = list.models || [];
        const lib = hwLib();
        for (const m of list || []) {
          if (!m) continue;
          const variants = (Array.isArray(m.variants) ? m.variants : []).filter((v) => v && (v.pullName || v.tag));
          let v = null;
          if (variants.length) {
            const rated = variants.map((x) => Object.assign({}, x, { fit: x.fit || fitFor(x.sizeBytes, hw) }));
            try { v = lib && typeof lib.pickVariant === 'function' ? lib.pickVariant(rated, hw) : null; } catch (_) { v = null; }
            if (!v) v = ['great', 'good', 'slow'].map((r) => rated.filter((x) => x.fit && x.fit.rating === r).sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0))[0]).find(Boolean) || null;
            if (v && !v.fit) v.fit = fitFor(v.sizeBytes, hw);
          }
          const pullName = (v && (v.pullName || (m.pullName ? `${String(m.pullName).split(':')[0]}:${v.tag}` : null))) || m.pullName;
          if (!pullName) continue;
          const sizeBytes = (v && v.sizeBytes) || m.sizeBytes || estimateSizeBytes(pullName);
          out.push({ pullName, title: m.title || m.name || pullName, sizeBytes, uncensored: m.uncensored != null ? !!m.uncensored : isUncensored(pullName), tools: m.tools == null ? null : !!m.tools, fit: (v && v.fit) || m.fit || fitFor(sizeBytes, hw), source: 'catalog' });
        }
      } catch (_) { /* fall back below */ }
    }
    if (!out.length) {
      const vramGB = (Number(hw && hw.bestVramMB) || 0) / 1024;
      const names = uncensored ? om.recommendedUncensored(vramGB) : om.recommended(vramGB);
      for (const n of names) { const sizeBytes = estimateSizeBytes(n); out.push({ pullName: n, title: n, sizeBytes, uncensored: isUncensored(n), tools: null, fit: fitFor(sizeBytes, hw), source: 'built-in' }); }
    }
    if (uncensored) out.sort((a, b) => Number(b.uncensored) - Number(a.uncensored));
    return out;
  }
  function choose(picks) {
    for (const r of ['great', 'good', 'slow']) { const p = picks.find((x) => x.fit && x.fit.rating === r); if (p) return p; }
    return null;
  }

  // ---- 🩺 check ----
  async function check(opts = {}) {
    const rows = [];
    const row = (id, label, ok, detail, fix) => { const r = { id, label, ok, detail, fix: fix || null }; rows.push(r); return r; };
    try {
      const hw = await hardware(!!opts.freshHardware);
      const s = alfredSettings() || { local: {} };
      const alfredModel = (s.local && s.local.model) || '';
      const found = await findOllama();
      row('installed', 'Ollama installed', !!found.ok, found.ok ? `Ollama ${found.version || '(version unknown)'} — ${found.bin}` : 'Ollama (the program that runs Alfred\'s AI) is not installed.', found.ok ? null : { action: 'install', label: '⬇ Install Ollama' });
      const srv = await currentServer();
      row('server', 'Ollama running', !!srv.ok, srv.ok ? `Answering — ${whereText(srv)}.` : found.ok ? 'Ollama is installed but not running.' : 'Not running (install it first).', srv.ok ? null : found.ok ? { action: 'start', label: '▶ Start Ollama' } : { action: 'install', label: '⬇ Install Ollama' });
      let dir = null;
      try { dir = srv.ok && srv.which !== 'app' ? (om.defaultStoreDir ? om.defaultStoreDir(d.env) : null) : d.paths.modelsDir(); } catch (_) { dir = null; }
      const free = dir ? freeBytes(dir) : null;
      row('disk', 'Models folder + free disk', dir ? (free == null ? null : free < 2 * GB ? false : free < 10 * GB ? null : true) : null, dir ? `${dir}${free != null ? ` — ${gbText(free)} free${free < 10 * GB ? ' (a model needs about 2–10 GB)' : ''}` : ''}` : 'The models folder isn\'t set yet.', null);
      let models = [];
      if (srv.ok) { const l = await listModels({ base: srv.base, hardware: hw }); models = l.ok ? l.models : []; }
      const picks = await recommendedPicks(hw, { uncensored: isUncensored(alfredModel) });
      const best = choose(picks);
      const dlFix = best ? { action: 'download-recommended', label: `⬇ Download ${best.pullName}` } : null;
      row('any-model', 'A model downloaded', srv.ok ? models.length > 0 : null, srv.ok ? (models.length ? `${models.length} model${models.length === 1 ? '' : 's'}: ${models.slice(0, 5).map((m) => m.name).join(', ')}${models.length > 5 ? '…' : ''}` : 'No model downloaded yet.') : 'Skipped — Ollama isn\'t running.', srv.ok && !models.length ? dlFix : null);
      const mine = models.find((m) => sameModel(m.name, alfredModel));
      const other = models.find((m) => fitUsable(m.fit)) || models[0];
      row('alfred-model', 'Alfred\'s model downloaded', srv.ok ? !!mine : null, !srv.ok ? 'Skipped — Ollama isn\'t running.' : mine ? `${alfredModel} (${mine.sizeText})` : `Alfred is set to ${alfredModel || '(nothing)'}, which isn't downloaded.`, srv.ok && !mine ? (other ? { action: 'use', model: other.name, label: `Use ${other.name}` } : dlFix) : null);
      let answers = null, tools = null;
      if (mine && !opts.quick) {
        const t = await quickTest(srv.base, alfredModel);
        answers = row('answers', 'Alfred\'s model answers', !!t.ok, t.ok ? `Answered "${t.reply}" in ${(t.ms / 1000).toFixed(1)} s.` : t.error, t.ok ? null : /memory|too long|too big/i.test(t.error || '') ? dlFix : { action: 'start', label: '▶ Start Ollama' });
        if (t.ok) {
          const tt = await toolTest(srv.base, alfredModel);
          tools = row('tools', 'It can use Alfred\'s tools', tt.native ? true : tt.text ? null : false, tt.native ? 'Yes — it calls tools natively.' : tt.text ? 'It works through the text protocol (a little slower and less reliable than native tool calls).' : tt.error || 'It did not call the test tool. Alfred needs a model that can use tools — a 7B–8B one like qwen2.5:7b or llama3.1:8b.', tt.native ? null : dlFix);
        }
      }
      if (!answers) row('answers', 'Alfred\'s model answers', null, opts.quick ? 'Not tested (quick check).' : 'Skipped — the model isn\'t ready.', null);
      if (!tools) row('tools', 'It can use Alfred\'s tools', null, 'Skipped — the model isn\'t answering yet.', null);
      const g = (hw.gpus || []).slice().sort((a, b) => (b.vramMB || 0) - (a.vramMB || 0))[0];
      row('gpu', 'Graphics card found', g ? true : null, g ? `${g.name}${g.vramMB ? ` — ${gbText(g.vramMB * MB)}` : ''}` : 'No graphics card found — models run on the processor (slower). Small models still work.', null);
      const sizeOfMine = mine ? mine.sizeBytes : null;
      const fit = mine ? (mine.fit || fitFor(sizeOfMine, hw)) : null;
      row('fit', 'The model fits this PC', fit ? (fitUsable(fit) ? true : fit.rating === 'slow' || fit.rating === 'unknown' ? null : false) : null, fit ? `${fit.label} — ${fit.reason}` : 'Skipped — no model yet.', fit && fit.rating === 'too-big' ? dlFix : null);
      const b = butlerConfig();
      const bSet = !!(b && b.model && b.endpoint);
      const bInstalled = bSet && models.some((m) => sameModel(m.name, b.model));
      const bLocal = butlerIsLocalOrEmpty(b);
      row('butler', 'Old Butler model set', !bSet ? null : (!bLocal || bInstalled || !srv.ok) ? true : null, !bSet ? 'The old 🤵 Butler has no model set.' : !bLocal ? `Uses ${b.model} on a remote AI service.` : bInstalled ? `${b.model}` : `${b.model} — not downloaded in this Ollama.`, (!bSet || (bLocal && !bInstalled && srv.ok)) && mine ? { action: 'butler-use', model: alfredModel, label: `Use ${alfredModel} for the Butler too` } : null);
      const bad = rows.filter((r) => r.ok === false), warn = rows.filter((r) => r.ok === null && r.fix);
      const ok = bad.length === 0 && !!mine;
      const summary = ok ? `✓ All set — Alfred uses ${alfredModel} on ${whereText(srv)}.${warn.length ? ` (${warn.length} thing${warn.length === 1 ? '' : 's'} could be better.)` : ''}` : `${bad.length || 1} thing${bad.length > 1 ? 's need' : ' needs'} attention: ${(bad.length ? bad : rows.filter((r) => r.ok !== true)).slice(0, 3).map((r) => r.label.toLowerCase()).join(', ')}. Press its Fix button, or ⚡ Set up.`;
      const out = { ok, rows, summary, hardware: hwLine(hw) };
      emit({ type: 'check', result: out });
      log('llm-check', { ok, bad: bad.map((r) => r.id) });
      return out;
    } catch (e) {
      return { ok: false, rows, summary: friendlyError(e, 'finish the check') };
    }
  }

  async function fix(action) {
    const a = typeof action === 'string' ? { action } : (action || {});
    try {
      switch (a.action) {
        case 'install': return await installOllama();
        case 'start': return await startOllama();
        case 'stop': return await stopOllama();
        case 'use': return await useModel(a.model, { alsoButler: a.alsoButler !== false });
        case 'butler-use': {
          const m = a.model || ((alfredSettings() || {}).local || {}).model;
          return await useModel(m, { butlerOnly: true, forceButler: true });
        }
        case 'download-recommended': {
          const hw = await hardware();
          const s = alfredSettings() || { local: {} };
          const best = a.model ? { pullName: a.model, sizeBytes: estimateSizeBytes(a.model) } : choose(await recommendedPicks(hw, { uncensored: a.uncensored != null ? !!a.uncensored : isUncensored(s.local && s.local.model) }));
          if (!best) return { ok: false, error: 'None of the recommended models fit this PC.' };
          const p = await pullModel(best.pullName, { sizeBytes: best.sizeBytes });
          if (!p.ok) return p;
          return await useModel(best.pullName, { alsoButler: true });
        }
        case 'setup': return await setupAll({ uncensored: !!a.uncensored });
        default: return { ok: false, error: 'I don\'t know that fix.' };
      }
    } catch (e) { return { ok: false, error: friendlyError(e, 'apply the fix') }; }
  }

  // ---- what is ALREADY on this PC (never download what is there) ----
  const usableInstalled = (fit) => !fit || fit.rating !== 'too-big'; // a model you already have is used even when slow
  const FIT_RANK = { great: 3, good: 2, slow: 1, unknown: 0 };
  /** Does an Ollama model folder hold any downloaded model? (it has manifests) */
  function storeHasModels(dir) {
    if (!dir) return false;
    const walk = (p, depth) => {
      let ents; try { ents = d.fs.readdirSync(p, { withFileTypes: true }); } catch (_) { return false; }
      for (const e of ents) {
        if (e.isFile && e.isFile()) return true;
        if (depth < 5 && e.isDirectory && e.isDirectory() && walk(path.join(p, e.name), depth + 1)) return true;
      }
      return false;
    };
    return walk(path.join(dir, 'manifests'), 0);
  }
  /** Every Ollama answering on this PC (the app's own and the one Ollama's app runs) with its models. */
  async function allServers(hw) {
    const out = [];
    const seen = new Set();
    for (const [base, which] of [[alfredBase(), 'alfred'], [managedBase(), 'app'], [d.systemBase, 'system']]) {
      if (!base || seen.has(base)) continue;
      seen.add(base);
      const p = await probe(base);
      if (!p.ok) continue;
      const l = await listModels({ base, hardware: hw });
      out.push({ base, which: base === managedBase() ? 'app' : base === d.systemBase ? 'system' : which, models: l.ok ? l.models : [] });
    }
    return out;
  }
  /** The best model already downloaded: Alfred's own choice when it is there, else the best fit (biggest first). */
  function bestInstalled(servers, opts = {}) {
    const all = [];
    for (const sv of servers) for (const m of sv.models) all.push({ m, sv });
    const want = opts.prefer;
    if (want) { const hit = all.find((x) => sameModel(x.m.name, want) && usableInstalled(x.m.fit)); if (hit && (!opts.uncensored || isUncensored(hit.m.name))) return hit; }
    const ok = all.filter((x) => usableInstalled(x.m.fit) && !/embed/i.test(x.m.name) && (!opts.uncensored || isUncensored(x.m.name)));
    if (!ok.length) return null;
    const score = (x) => {
      const p = paramsFromName(x.m.name);
      return [(p == null || p >= 3) ? 1 : 0, FIT_RANK[(x.m.fit && x.m.fit.rating) || 'unknown'] || 0, Number(x.m.sizeBytes) || 0];
    };
    ok.sort((a, b) => { const A = score(a), B = score(b); for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) return B[i] - A[i]; return 0; });
    return ok[0];
  }
  /** Start the app's own Ollama on whichever model folder already HAS models (its own, else Ollama's usual one). */
  async function startOnStoreWithModels(found) {
    let appDir = null; try { appDir = d.paths.modelsDir(); } catch (_) {}
    let defDir = null; try { defDir = om.defaultStoreDir ? om.defaultStoreDir(d.env) : null; } catch (_) {}
    const dir = storeHasModels(appDir) ? appDir : storeHasModels(defDir) ? defDir : appDir;
    if (!dir) return { ok: false, error: 'The app\'s content folder isn\'t ready yet. Wait a moment and try again.' };
    try { d.fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    const ms = om.managedStatus ? om.managedStatus() : { running: false };
    if (ms.running && ms.modelsDir === dir) return { ok: true, base: managedBase(), which: 'app', dir };
    if (ms.running) { try { om.stopManaged(); } catch (_) {} await sleep(400); }
    const host = managedHost();
    say(`Starting Ollama with the models in ${dir}…`, 'info', 'start');
    const r = om.startManaged({ modelsDir: dir, host, bin: found.bin, spawnFn: d.spawn, onLog: () => {} });
    if (!r || !r.ok) return { ok: false, error: friendlyError({ message: r && r.error }, 'start Ollama') };
    const deadline = Date.now() + d.readyTimeoutMs;
    while (Date.now() < deadline) {
      const p = await probe(`http://${host}`, 1500);
      if (p.ok) { emit({ type: 'server', running: true, base: `http://${host}`, which: 'app' }); return { ok: true, base: `http://${host}`, which: 'app', dir, started: true }; }
      await sleep(300);
    }
    return { ok: false, error: 'Ollama started but isn\'t answering yet. Wait a few seconds and try again.' };
  }

  // ---- 🔍 FIND WHAT'S INSTALLED: Ollama, its model folders, the servers' models, loose .gguf files ----
  /** Model files other programs downloaded (LM Studio, GPT4All, Jan, Downloads…): Ollama can take them in. */
  function ggufPlaces() {
    const home = d.homedir, env = d.env || {}, out = [];
    const add = (dir, from) => { if (dir && !out.some((x) => x.dir === dir)) out.push({ dir, from }); };
    add(P.join(home, '.lmstudio', 'models'), 'LM Studio');
    add(P.join(home, '.cache', 'lm-studio', 'models'), 'LM Studio');
    add(P.join(home, 'jan', 'models'), 'Jan');
    if (env.LOCALAPPDATA) add(P.join(env.LOCALAPPDATA, 'nomic.ai', 'GPT4All'), 'GPT4All');
    add(P.join(home, '.local', 'share', 'nomic.ai', 'GPT4All'), 'GPT4All');
    add(P.join(home, 'Library', 'Application Support', 'nomic.ai', 'GPT4All'), 'GPT4All');
    add(P.join(home, 'Downloads'), 'Downloads');
    try { const m = d.paths.modelsDir(); if (m) add(m, 'AutoInjector'); } catch (_) {}
    return out;
  }
  function findGgufs(limit = 60) {
    const found = [];
    const walk = (dir, depth, from) => {
      if (found.length >= limit) return;
      let ents; try { ents = d.fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of ents) {
        if (found.length >= limit) return;
        const full = P.join(dir, e.name);
        if (e.isDirectory && e.isDirectory()) { if (depth < 4 && !/^(blobs|manifests|\.git|node_modules)$/i.test(e.name)) walk(full, depth + 1, from); continue; }
        if (!/\.gguf$/i.test(e.name) || /mmproj|-0000[2-9]-of-/i.test(e.name)) continue;
        let size = 0; try { size = d.fs.statSync(full).size; } catch (_) {}
        if (size < 50 * 1024 * 1024) continue; // not a model (a vocab / test file)
        found.push({ path: full, file: e.name, sizeBytes: size, sizeText: gbText(size), from, suggestedName: ggufName(e.name) });
      }
    };
    for (const pl of ggufPlaces()) walk(pl.dir, 0, pl.from);
    return found;
  }
  function ggufName(file) {
    return String(file).replace(/\.gguf$/i, '').replace(/-0000\d-of-\d+$/i, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'my-model';
  }
  function storeCandidates() {
    const out = [];
    const add = (dir, label) => { if (dir && !out.some((x) => x.dir === dir)) out.push({ dir, label }); };
    try { add(d.paths.modelsDir(), 'AutoInjector\'s folder ("stuff and thing")'); } catch (_) {}
    try { if (d.env && d.env.OLLAMA_MODELS) add(d.env.OLLAMA_MODELS, 'OLLAMA_MODELS setting'); } catch (_) {}
    try { add(om.defaultStoreDir ? om.defaultStoreDir(Object.assign({}, d.env, { OLLAMA_MODELS: '' })) : null, 'Ollama\'s usual folder'); } catch (_) {}
    return out;
  }
  async function scanInstalled() {
    let hw = null; try { hw = await hardware(); } catch (_) {}
    const ollama = await findOllama();
    const servers = await allServers(hw);
    const ms = om.managedStatus ? om.managedStatus() : {};
    const stores = storeCandidates().map((st) => ({ dir: st.dir, label: st.label, hasModels: storeHasModels(st.dir), inUse: !!(ms.running && ms.modelsDir === st.dir) }));
    const ggufs = findGgufs();
    const n = servers.reduce((a, sv) => a + sv.models.length, 0);
    const parts = [ollama.ok ? `Ollama ${ollama.version || ''} is installed`.replace('  ', ' ') : 'Ollama isn\'t installed', `${n} model${n === 1 ? '' : 's'} ready in Ollama`];
    const other = stores.filter((x) => x.hasModels && !x.inUse).length;
    if (other) parts.push(`${other} other model folder${other === 1 ? '' : 's'} with models`);
    if (ggufs.length) parts.push(`${ggufs.length} model file${ggufs.length === 1 ? '' : 's'} (.gguf) Ollama can take in`);
    log('llm-scan', { ollama: !!ollama.ok, servers: servers.length, models: n, stores: stores.filter((x) => x.hasModels).length, ggufs: ggufs.length });
    return { ok: true, ollama: { installed: !!ollama.ok, version: ollama.version || null, bin: ollama.bin || null }, servers: servers.map((sv) => ({ base: sv.base, which: sv.which, where: whereText(sv), models: sv.models })), stores, ggufs, alfredModel: (alfredSettings() || { local: {} }).local.model || null, summary: `${parts.join(' · ')}.` };
  }
  /** Run the app's Ollama on a folder that already has models (instead of downloading them again). */
  async function useStore(dir) {
    if (!dir || !storeHasModels(dir)) return { ok: false, error: 'That folder has no Ollama models in it.' };
    const found = await findOllama();
    if (!found.ok) return { ok: false, error: 'Ollama isn\'t installed yet — press ⚡ Set up (first time).' };
    if (om.managedStatus && om.managedStatus().running) { try { om.stopManaged(); } catch (_) {} await sleep(400); }
    const host = managedHost();
    const r = om.startManaged({ modelsDir: dir, host, bin: found.bin, spawnFn: d.spawn, onLog: () => {} });
    if (!r || !r.ok) return { ok: false, error: friendlyError({ message: r && r.error }, 'start Ollama') };
    const deadline = Date.now() + d.readyTimeoutMs;
    while (Date.now() < deadline) { if ((await probe(`http://${host}`, 1500)).ok) break; await sleep(300); }
    const l = await listModels({ base: `http://${host}` });
    log('llm-use-store', { ok: !!l.ok, models: l.ok ? l.models.length : 0 });
    emit({ type: 'models-changed' });
    return l.ok ? { ok: true, base: `http://${host}`, models: l.models, message: `✓ AutoInjector's Ollama now uses ${dir} — ${l.models.length} model${l.models.length === 1 ? '' : 's'} ready (nothing downloaded).` } : { ok: false, error: 'Ollama started on that folder but didn\'t list its models — press 🔍 again in a moment.' };
  }
  /** Take a .gguf another program downloaded into Ollama (ollama create … FROM <file>): no download. */
  async function importGguf(file, name) {
    const f = String(file || '');
    if (!/\.gguf$/i.test(f) || !exists(f)) return { ok: false, error: 'That model file isn\'t there any more.' };
    const n = ggufName(name || P.basename(f));
    if (!MODEL_NAME_RE.test(n)) return { ok: false, error: 'Pick a simple name for it (letters, numbers, - and _).' };
    const found = await findOllama();
    if (!found.ok) return { ok: false, error: 'Ollama isn\'t installed yet — press ⚡ Set up (first time).' };
    let srv = await currentServer();
    if (!srv.ok) { const st = await startOllama(); if (!st.ok) return { ok: false, error: st.error }; srv = { ok: true, base: st.base }; }
    if (busy) return { ok: false, busy: true, error: 'I am already busy with something — wait for it to finish.' };
    begin('import');
    try {
      const dir = d.paths.downloadsDir();
      try { d.fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
      const mf = P.join(dir, `Modelfile-${n.replace(/[^a-z0-9._-]/gi, '_')}`);
      d.fs.writeFileSync(mf, `FROM ${f}\n`);
      say(`Adding ${P.basename(f)} to Ollama as ${n} (it reads the file — no download)…`, 'info', 'import');
      const host = srv.base.replace(/^https?:\/\//, '');
      const res = await new Promise((resolve) => {
        let c; let out = '';
        try { c = d.spawn(found.bin, ['create', n, '-f', mf], { windowsHide: true, env: Object.assign({}, process.env, d.env, { OLLAMA_HOST: host }) }); } catch (e) { return resolve({ ok: false, error: friendlyError(e, 'add it to Ollama') }); }
        const grab = (b) => { out = (out + String(b)).slice(-600); };
        if (c.stdout) c.stdout.on('data', grab); if (c.stderr) c.stderr.on('data', grab);
        c.on('error', (e) => resolve({ ok: false, error: friendlyError(e, 'add it to Ollama') }));
        c.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: `Ollama couldn't take that file in${out ? ` (${out.trim().split('\n').pop().slice(0, 160)})` : ''}.` }));
      });
      log('llm-import', { ok: !!res.ok });
      emit({ type: 'models-changed' });
      return res.ok ? { ok: true, name: n, message: `✓ ${n} is now in Ollama — press Use (or ▶ Start Alfred).` } : res;
    } catch (e) { return { ok: false, error: friendlyError(e, 'add it to Ollama') }; } finally { end('import'); }
  }

  // ---- ▶ START ALFRED: one click, uses only what is already downloaded ----
  async function startAlfred(opts = {}) {
    if (busy) return { ok: false, busy: true, error: 'I am already busy with something — wait for it to finish (or press Cancel).' };
    begin('start-alfred');
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const tell = (message) => { const ev = { type: 'step', task: 'start-alfred', message }; emit(ev); if (onProgress) { try { onProgress(ev); } catch (_) {} } };
    const done = (out) => { emit({ type: 'done', task: 'start-alfred', ok: !!out.ok, message: out.ok ? out.message : out.error }); log('llm-start-alfred', { ok: !!out.ok, model: out.model || null, which: out.which || null, error: out.ok ? undefined : out.code }); end('start-alfred'); return out; };
    try {
      const found = await findOllama();
      if (!found.ok) return done({ ok: false, code: 'NO_OLLAMA', needSetup: true, error: 'Ollama isn\'t installed yet. Press ⚡ Set up once — it installs Ollama and one model.', fix: { action: 'setup', label: '⚡ Set up (once)' } });
      tell('Looking for the models you already have…');
      let hw = null; try { hw = await hardware(); } catch (_) {}
      const s = alfredSettings() || { local: {} };
      const prefer = s.local && s.local.model;
      let servers = await allServers(hw);
      let pick = bestInstalled(servers, { prefer });
      if (!pick) {
        // Nothing running has a model: start the app's Ollama on a folder that does (e.g. Ollama's usual one).
        tell('Starting Ollama…');
        const st = await startOnStoreWithModels(found);
        if (!st.ok) return done({ ok: false, code: 'START_FAILED', error: st.error });
        servers = await allServers(hw);
        pick = bestInstalled(servers, { prefer });
      }
      if (!pick) return done({ ok: false, code: 'NO_MODELS', needSetup: true, error: 'No models are downloaded on this PC yet. Press ⚡ Set up once — it downloads one that fits (you never need to again).', fix: { action: 'setup', label: '⚡ Set up (once)' } });
      const name = pick.m.name; const base = pick.sv.base;
      tell(`Using ${name}…`);
      const same = prefer && sameModel(prefer, name) && alfredBase() === base;
      if (!same) {
        const u = await useModel(name, { base, alsoButler: true, skipTest: true });
        if (!u.ok) return done({ ok: false, code: 'USE_FAILED', error: u.error || 'I couldn\'t save the model choice.' });
      }
      tell(`Loading ${name} into memory (the first time can take a minute)…`);
      const warm = await http(`${base}/api/generate`, { method: 'POST', body: { model: name, prompt: '', keep_alive: '30m' }, timeoutMs: 240000 });
      const where = whereText({ base, which: pick.sv.which });
      const pp = paramsFromName(name);
      const fit = (pick.m.fit && pick.m.fit.rating === 'slow' ? ' It is big for this PC, so answers will be slow.' : '') + (pp != null && pp < 3 ? ' It is a very small model, so he may pick the wrong tool — ⚡ Set up gets a better one.' : '');
      return done({ ok: true, model: name, base, which: pick.sv.which, warmed: !!warm.ok, message: `✓ Alfred is ready with ${name} (${where}).${fit}${warm.ok ? '' : ' (It will load when you first ask him something.)'}` });
    } catch (e) { return done({ ok: false, code: 'ERROR', error: friendlyError(e, 'start Alfred') }); }
  }

  // ---- ⚡ THE ONE BUTTON ----
  async function setupAll(opts = {}) {
    if (busy) return { ok: false, busy: true, error: 'I am already busy with something — wait for it to finish (or press Cancel).' };
    const signal = begin('setup');
    const uncensored = !!opts.uncensored;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const steps = [];
    const step = (id, label, state, message, extra) => {
      let s = steps.find((x) => x.id === id);
      if (!s) { s = { id, label }; steps.push(s); }
      Object.assign(s, { state, message: message || '' }, extra || {});
      const ev = { type: 'step', task: 'setup', step: id, label, state, message: message || '', index: steps.indexOf(s) + 1, of: 6 };
      emit(ev); if (onProgress) { try { onProgress(ev); } catch (_) {} }
    };
    const stop = (id, label, error, fixA) => {
      step(id, label, 'failed', error);
      const out = { ok: false, steps, error, fix: fixA || null };
      if (signal.aborted) { out.cancelled = true; out.error = 'Cancelled.'; }
      emit({ type: 'done', task: 'setup', ok: false, message: out.error });
      log('llm-setup-all', { ok: false, step: id, error: out.error });
      return out;
    };
    try {
      log('llm-setup-all', { start: true, uncensored });
      step('hardware', 'Look at this PC', 'running', 'Looking at this PC…');
      const hw = await hardware(true);
      step('hardware', 'Look at this PC', 'done', hwLine(hw));
      if (signal.aborted) return stop('hardware', 'Look at this PC', 'Cancelled.');

      step('ollama', 'Install Ollama', 'running', 'Looking for Ollama…');
      let found = await findOllama();
      if (!found.ok) {
        step('ollama', 'Install Ollama', 'running', 'Ollama isn\'t installed — installing it now…');
        const inst = await installOllama({ onProgress });
        if (!inst.ok) return stop('ollama', 'Install Ollama', inst.error, { action: 'install', label: '⬇ Try installing Ollama again' });
        found = await findOllama();
      }
      step('ollama', 'Install Ollama', 'done', `Ollama ${found.version || ''} is installed.`.replace('  ', ' '));

      step('start', 'Start Ollama', 'running', 'Starting Ollama…');
      let st = await startOllama();
      if (!st.ok) return stop('start', 'Start Ollama', st.error, { action: 'start', label: '▶ Start Ollama' });
      step('start', 'Start Ollama', 'done', st.message);
      let base = st.base;
      // A model you already downloaded — on this Ollama, the other one, or in Ollama's usual folder — is used, never downloaded again.
      let existing = bestInstalled(await allServers(hw), { prefer: (alfredSettings() || { local: {} }).local.model, uncensored });
      if (!existing) {
        const st2 = await startOnStoreWithModels(found);
        if (st2.ok) existing = bestInstalled(await allServers(hw), { prefer: (alfredSettings() || { local: {} }).local.model, uncensored });
      }
      // …but ⚡ Set up is for a CAPABLE model: a tiny one (under 3B) you have is not enough for his tools.
      const tiny = (x) => x && paramsFromName(x.m.name) != null && paramsFromName(x.m.name) < 3;
      if (tiny(existing)) existing = null;
      if (existing) base = existing.sv.base;

      step('model', 'Choose a model', 'running', 'Choosing the best model for this PC…');
      const l = await listModels({ base, hardware: hw });
      const installed = l.ok ? l.models : [];
      const picks = await recommendedPicks(hw, { uncensored });
      const s = alfredSettings() || { local: {} };
      const current = installed.find((m) => sameModel(m.name, s.local && s.local.model));
      const okFor = (m) => m && fitUsable(m.fit || fitFor(m.sizeBytes, hw)) && (!uncensored || isUncensored(m.name)) && (paramsFromName(m.name) == null || paramsFromName(m.name) >= 3);
      let keep = existing ? existing.m : okFor(current) ? current : installed.find((m) => okFor(m) && picks.some((p) => sameModel(p.pullName, m.name)));
      let chosen = null;
      if (keep) step('model', 'Choose a model', 'done', `${keep.name} is already downloaded — using it (nothing new to download).`, { model: keep.name });
      else {
        chosen = choose(picks);
        if (!chosen) return stop('model', 'Choose a model', 'None of the recommended models fit this PC (it needs more memory). You can still connect Alfred to an online AI in 🎩 settings.');
        step('model', 'Choose a model', 'done', `${chosen.pullName} — ${chosen.fit ? chosen.fit.label : ''}${chosen.sizeBytes ? ` · about ${gbText(chosen.sizeBytes)}` : ''}${chosen.uncensored ? ' · 🔓 uncensored' : ''}`, { model: chosen.pullName });
      }
      if (signal.aborted) return stop('model', 'Choose a model', 'Cancelled.');

      const modelName = keep ? keep.name : chosen.pullName;
      if (!keep) {
        step('download', 'Download the model', 'running', `Downloading ${modelName}…`);
        const already = installed.find((m) => sameModel(m.name, modelName));
        if (!already) {
          const p = await pullModel(modelName, { base, sizeBytes: chosen.sizeBytes, onProgress });
          if (!p.ok) return stop('download', 'Download the model', p.error, { action: 'download-recommended', label: '⬇ Try the download again' });
        }
        step('download', 'Download the model', 'done', `${modelName} is downloaded.`);
      } else step('download', 'Download the model', 'done', 'Nothing to download.');

      step('use', 'Point Alfred at it', 'running', `Setting Alfred up to use ${modelName}…`);
      const u = await useModel(modelName, { base, alsoButler: true, skipTest: true });
      if (!u.ok) return stop('use', 'Point Alfred at it', u.error || 'I couldn\'t save the model choice.');
      step('use', 'Point Alfred at it', 'done', u.message);

      step('check', 'Check everything', 'running', 'Checking everything…');
      const c = await check();
      step('check', 'Check everything', c.ok ? 'done' : 'failed', c.summary);
      const out = { ok: c.ok, model: modelName, base, steps, check: c, summary: c.ok ? `✓ Alfred's AI is ready: ${modelName}.` : c.summary };
      if (signal.aborted) { out.ok = false; out.cancelled = true; out.summary = 'Cancelled.'; }
      emit({ type: 'done', task: 'setup', ok: out.ok, message: out.summary });
      log('llm-setup-all', { ok: out.ok, model: modelName });
      return out;
    } catch (e) {
      const msg = friendlyError(e, 'finish the setup');
      emit({ type: 'done', task: 'setup', ok: false, message: msg });
      return { ok: false, steps, error: msg };
    } finally { end('setup'); }
  }

  // ---- status (cheap: no model test) ----
  async function status() {
    try {
      const found = await findOllama({ cached: true });
      const srv = await currentServer();
      const l = srv.ok ? await listModels({ base: srv.base }) : { ok: false, models: [] };
      const s = alfredSettings() || { local: {} };
      const b = butlerConfig();
      let managed = null; try { managed = om.managedStatus(); } catch (_) {}
      return {
        ok: true,
        ollama: { installed: !!found.ok, bin: found.bin || null, version: found.version || null },
        server: srv.ok ? { running: true, base: srv.base, which: srv.which, managed: !!(managed && managed.running) } : { running: false, managed: false },
        models: l.models || [],
        alfred: { model: (s.local && s.local.model) || null, endpoint: (s.local && s.local.endpoint) || null, brain: s.brain || null },
        butler: b ? { model: b.model || null, endpoint: b.endpoint || null, provider: b.provider || null } : null,
        hardware: hwCache ? hwLine(hwCache) : null,
        busy,
      };
    } catch (e) { return { ok: false, error: friendlyError(e, 'read the status') }; }
  }

  return {
    findOllama, installOllama, startOllama, stopOllama, pullModel, removeModel, listModels, useModel, startAlfred, allServers, bestInstalled, storeHasModels, scanInstalled, useStore, importGguf, findGgufs,
    check, fix, setupAll, cancel, status, hardware, hwLine, recommendedPicks, fitFor, currentServer, download,
    isBusy: () => busy,
  };
}

module.exports = { createLlmSetup, friendlyError, fallbackFit, estimateSizeBytes, paramsFromName, parseVersion, isUncensored, gbText, timeText, DOWNLOAD_BASE };
