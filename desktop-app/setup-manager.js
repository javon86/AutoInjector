'use strict';
/*
 * setup-manager.js — the butler's self-install engine.
 *
 * The whole point: the user should NOT have to hand-install Open Interpreter,
 * the voice engine, a voice model, or a local LLM, and should not have to type
 * endpoints or paths into a wizard. The butler (or a single "Auto-setup" click)
 * installs the things it needs, in a sensible order, and wires them up.
 *
 * Two hard safety rails, because this shells out to real installers:
 *   1) FIXED ALLOWLIST. Only the targets defined in TARGETS below can ever be
 *      installed. The butler passes a target *id* from an enum — never a command,
 *      never a URL, never a package name it made up. The one free field is an
 *      optional Ollama model name, and it is regex-validated to a bare model tag.
 *   2) NO SHELL. Every child process is spawned with an argv array (no shell:true),
 *      so even if a string slipped through it could not be interpreted as a command.
 *
 * Everything is dependency-injected (spawn/execFile/https/modelsDir/...) so it is
 * unit-testable with stubs and Electron-free. Every step streams progress lines to
 * an onProgress callback and resolves a plain { ok, ... } — a failure never throws.
 *
 * Kinds of target:
 *   pip       — `<python> -m pip install <fixed packages…>`  (Open Interpreter, voice)
 *   download  — HTTPS GET fixed file(s) into the shared models/<category> folder
 *   ollama    — `ollama pull <model>` via the injected puller (a local LLM)
 *   handoff   — can't be installed silently (a GUI app); open its official page
 */
const child_process = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// -------- the fixed allowlist -------------------------------------------------
// The order here is also the recommended install order for "Auto-setup":
// Open Interpreter first (the keystone — once it's in, the butler can run code),
// then voice + a voice model, then a small local LLM, then the image installer.
const TARGETS = {
  'open-interpreter': {
    id: 'open-interpreter',
    label: 'Open Interpreter — run code / control the computer',
    kind: 'pip',
    packages: ['open-interpreter'],
    check: 'open-interpreter', // `pip show` distribution name
    note: 'The keystone. Gives the butler RUN_CODE so it can act on the machine and drive the rest of its own setup.',
  },
  'voice': {
    id: 'voice',
    label: 'Voice engine — offline speak & listen (piper + whisper)',
    kind: 'pip',
    packages: ['piper-tts', 'faster-whisper', 'sounddevice'],
    check: 'piper-tts',
    note: 'The butler speaks its acknowledgements and can take a spoken goal. Fully offline.',
  },
  'voice-model': {
    id: 'voice-model',
    label: 'Voice model — a ready English piper voice',
    kind: 'download',
    category: 'voice',
    files: [
      {
        url: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx',
        name: 'en_US-lessac-medium.onnx',
      },
      {
        url: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json',
        name: 'en_US-lessac-medium.onnx.json',
      },
    ],
    note: 'A natural US-English voice for piper, downloaded into models/voice so the voice engine has something to speak with.',
  },
  'ollama-model': {
    id: 'ollama-model',
    label: 'Local LLM — a small model for the System AI brain (Ollama)',
    kind: 'ollama',
    defaultModel: 'llama3.2:3b',
    note: 'Downloads a local language model that can drive the butler with no cloud key. Needs Ollama installed.',
  },
  'stability-matrix': {
    id: 'stability-matrix',
    label: 'Stability Matrix — one-click image-generation installer ⭐',
    kind: 'handoff',
    url: 'https://github.com/LykosAI/StabilityMatrix/releases/latest',
    note: 'A GUI installer for Stable Diffusion (A1111/ComfyUI) with its own model downloader. It is a desktop app, so it cannot be installed silently — this opens its official download page.',
  },
};

// -------- injectable dependencies (real ones by default) ----------------------
const deps = {
  spawn: child_process.spawn,
  execFile: child_process.execFile,
  https,
  http,
  fs,
  // where a downloaded model file for <category> should land; injected from main
  // (outputManager.modelsDir). Defaults to throwing so a mis-wired call is loud.
  modelsDir: null,
  // pull an Ollama model: (model, onProgress) => { child, done: Promise<{ok,...}> }
  pullOllamaModel: null,
  // is Ollama installed? () => Promise<{ available }>
  detectOllama: null,
  // open a URL in the user's browser (for handoff targets): (url) => void
  openExternal: null,
};

function configure(patch) {
  if (!patch || typeof patch !== 'object') return;
  for (const k of Object.keys(deps)) if (k in patch && patch[k] != null) deps[k] = patch[k];
}

// The python to install into. Env override first, then the usual names.
function pythonBin() {
  return process.env.AUTOINJECTOR_PYTHON || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

// -------- choose a Python that can actually install the pip targets -----------
// Open Interpreter's dependency tree (litellm, tiktoken, …) ships prebuilt
// wheels only up to a certain Python. On a too-new Python (3.13/3.14) pip finds
// no wheel and falls back to compiling from source, which needs Rust/Cargo and
// usually fails. So we probe for a Python in the known-good range and install
// into THAT, rather than whatever happens to be first on PATH.
const PY_MIN_MINOR = 8;   // 3.8
const PY_MAX_MINOR = 12;  // 3.12 (inclusive) — has wheels for the pip targets

function _pyCandidates() {
  const list = [];
  const envPy = process.env.AUTOINJECTOR_PYTHON || process.env.PYTHON;
  if (envPy) list.push({ cmd: envPy, pre: [] });
  if (process.platform === 'win32') {
    // The Windows launcher can select an exact version: `py -3.12 …`.
    for (const v of ['3.12', '3.11', '3.10', '3.9', '3.8']) list.push({ cmd: 'py', pre: [`-${v}`] });
    list.push({ cmd: 'python3.12', pre: [] }, { cmd: 'python3.11', pre: [] }, { cmd: 'python3.10', pre: [] });
    list.push({ cmd: 'python', pre: [] }, { cmd: 'python3', pre: [] });
  } else {
    for (const v of ['3.12', '3.11', '3.10', '3.9', '3.8']) list.push({ cmd: `python${v}`, pre: [] });
    list.push({ cmd: 'python3', pre: [] }, { cmd: 'python', pre: [] });
  }
  return list;
}

function _probePy(cand) {
  return new Promise((resolve) => {
    let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const args = [...cand.pre, '-c', 'import sys;print("%d.%d" % sys.version_info[:2])'];
      const child = deps.execFile(cand.cmd, args, { timeout: 6000, windowsHide: true }, (err, stdout) => {
        if (err) return finish(null);
        const m = String(stdout || '').trim().match(/(\d+)\.(\d+)/);
        if (!m) return finish(null);
        finish({ cmd: cand.cmd, pre: cand.pre, major: +m[1], minor: +m[2], version: `${m[1]}.${m[2]}` });
      });
      if (child && child.on) child.on('error', () => finish(null));
    } catch (_) { finish(null); }
  });
}

function _pyCompatible(p) { return !!(p && p.major === 3 && p.minor >= PY_MIN_MINOR && p.minor <= PY_MAX_MINOR); }

let _pyResolved = null;
/**
 * Resolve the best Python for pip installs: the first that works AND is in the
 * known-good range; otherwise the first that works (flagged incompatible), so
 * the caller can warn. Cached; pass force=true to re-probe. Non-throwing.
 */
async function resolvePython(force) {
  if (_pyResolved && !force) return _pyResolved;
  let firstWorking = null;
  const seen = new Set();
  for (const c of _pyCandidates()) {
    const key = `${c.cmd} ${c.pre.join(' ')}`;
    if (seen.has(key)) continue; seen.add(key);
    const p = await _probePy(c); // eslint-disable-line no-await-in-loop
    if (!p) continue;
    if (!firstWorking) firstWorking = p;
    if (_pyCompatible(p)) { _pyResolved = { ...p, compatible: true }; return _pyResolved; }
  }
  _pyResolved = firstWorking
    ? { ...firstWorking, compatible: false }
    : { cmd: (process.platform === 'win32' ? 'python' : 'python3'), pre: [], major: null, minor: null, version: null, compatible: false, missing: true };
  return _pyResolved;
}

/** For the UI / self-check: which Python will be used, and is it usable? */
async function pythonStatus() {
  const p = await resolvePython();
  return {
    version: p.version, compatible: p.compatible, missing: !!p.missing,
    invocation: [p.cmd, ...p.pre].join(' '),
    note: p.missing
      ? 'No Python found. Install Python 3.12 from python.org, then try again.'
      : p.compatible
        ? `Using Python ${p.version}.`
        : `Python ${p.version} is too new for Open Interpreter's packages — install Python 3.12 (python.org) and it will be used automatically.`,
  };
}

// Reset the cached Python resolution (used by tests).
function _resetPython() { _pyResolved = null; }

function has(id) { return Object.prototype.hasOwnProperty.call(TARGETS, id); }
function get(id) { return TARGETS[id] || null; }

// A UI-friendly list of every target with its metadata (no detection — cheap).
function list() {
  return Object.values(TARGETS).map((t) => ({ id: t.id, label: t.label, kind: t.kind, note: t.note, url: t.url || null }));
}

// -------- detection: is a target already installed? (best-effort) -------------
async function _pipShow(pkg) {
  const py = await resolvePython();
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const child = deps.execFile(py.cmd, [...py.pre, '-m', 'pip', 'show', pkg], { timeout: 8000, windowsHide: true }, (err, stdout) => {
        finish(!err && /Name:/i.test(String(stdout || '')));
      });
      if (child && child.on) child.on('error', () => finish(false));
    } catch (_) { finish(false); }
  });
}

async function detect(id) {
  const t = TARGETS[id];
  if (!t) return { id, installed: null, reason: 'unknown target' };
  try {
    if (t.kind === 'pip') {
      const ok = await _pipShow(t.check || t.packages[0]);
      return { id, installed: ok };
    }
    if (t.kind === 'download') {
      let dir = null;
      try { dir = deps.modelsDir ? deps.modelsDir(t.category) : null; } catch (_) { dir = null; }
      if (!dir) return { id, installed: null, reason: 'models folder not ready' };
      const all = t.files.every((f) => { try { return deps.fs.existsSync(path.join(dir, f.name)); } catch (_) { return false; } });
      return { id, installed: all };
    }
    if (t.kind === 'ollama') {
      if (!deps.detectOllama) return { id, installed: null, reason: 'no ollama detector' };
      const d = await deps.detectOllama();
      // "installed" here means the runtime is present; a specific model is pulled on demand.
      return { id, installed: !!(d && d.available), detail: d };
    }
    if (t.kind === 'handoff') return { id, installed: null, reason: 'external installer' };
  } catch (e) { return { id, installed: null, reason: String((e && e.message) || e) }; }
  return { id, installed: null };
}

async function detectAll() {
  const out = {};
  for (const id of Object.keys(TARGETS)) out[id] = await detect(id);
  return out;
}

// -------- install one target --------------------------------------------------
function _runProcess(command, args, onProgress) {
  return new Promise((resolve) => {
    let child;
    const emit = (buf) => { const s = String(buf).replace(/\s+$/, ''); if (s && typeof onProgress === 'function') onProgress(s); };
    try {
      child = deps.spawn(command, args, { windowsHide: true });
    } catch (e) { return resolve({ ok: false, error: `could not start ${command}: ${(e && e.message) || e}` }); }
    if (child.stdout && child.stdout.on) child.stdout.on('data', emit);
    if (child.stderr && child.stderr.on) child.stderr.on('data', emit); // pip writes plenty to stderr
    child.on('error', (e) => resolve({ ok: false, error: String((e && e.message) || e) }));
    child.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: `${path.basename(String(command))} exited ${code}` }));
  });
}

// HTTPS GET to a file, following redirects (HuggingFace resolves to a CDN).
function _download(fileUrl, destPath, onProgress, redirects) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(fileUrl); } catch (_) { return resolve({ ok: false, error: 'bad url' }); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return resolve({ ok: false, error: 'refusing non-http(s) url' });
    const lib = url.protocol === 'https:' ? deps.https : deps.http;
    const tmp = `${destPath}.part`;
    let file;
    try { file = deps.fs.createWriteStream(tmp); } catch (e) { return resolve({ ok: false, error: String((e && e.message) || e) }); }
    let settled = false;
    const fail = (err) => { if (settled) return; settled = true; try { file.close(); } catch (_) {} try { deps.fs.unlinkSync(tmp); } catch (_) {} resolve({ ok: false, error: err }); };
    const req = lib.get({ hostname: url.hostname, port: url.port || undefined, path: url.pathname + url.search, headers: { 'User-Agent': 'AutoInjector-setup' } }, (res) => {
      const sc = res.statusCode || 0;
      if (sc >= 300 && sc < 400 && res.headers.location) {
        res.resume();
        if ((redirects || 0) >= 5) return fail('too many redirects');
        const next = new URL(res.headers.location, url).toString();
        return _download(next, destPath, onProgress, (redirects || 0) + 1).then(resolve);
      }
      if (sc !== 200) { res.resume(); return fail(`HTTP ${sc}`); }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0, lastPct = -1;
      res.on('data', (chunk) => {
        got += chunk.length;
        if (total && typeof onProgress === 'function') {
          const pct = Math.floor((got / total) * 100);
          if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; onProgress(`${path.basename(destPath)} ${pct}%`); }
        }
      });
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          try { deps.fs.renameSync(tmp, destPath); resolve({ ok: true, path: destPath }); }
          catch (e) { fail(String((e && e.message) || e)); }
        });
      });
      file.on('error', (e) => fail(String((e && e.message) || e)));
      res.on('error', (e) => fail(String((e && e.message) || e)));
    });
    req.on('error', (e) => fail(String((e && e.code) || (e && e.message) || e)));
  });
}

const OLLAMA_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,80}$/;

// install(id, { model?, onProgress? }) -> { ok, message?, error? }
async function install(id, opts = {}) {
  const t = TARGETS[id];
  if (!t) return { ok: false, error: 'UNKNOWN_TARGET', target: id };
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  onProgress(`Installing: ${t.label}`);

  try {
    if (t.kind === 'pip') {
      const py = await resolvePython();
      if (py.missing) return { ok: false, error: 'No Python found. Install Python 3.12 from python.org, then try again.' };
      onProgress(`Using Python ${py.version || '?'} (${[py.cmd, ...py.pre].join(' ')})`);
      if (!py.compatible) {
        // Warn up-front — a too-new Python is the usual cause of the litellm /
        // Rust source-build failure. We still try (a wheel may exist), but the
        // guidance is there if it fails.
        onProgress(`⚠ Python ${py.version} is newer than these packages support (need 3.8–3.12). If this fails, install Python 3.12 from python.org and it will be picked up automatically.`);
      }
      // --prefer-binary: take a prebuilt wheel over compiling from source, so a
      // missing Rust/compiler toolchain can't sink the install.
      const r = await _runProcess(py.cmd, [...py.pre, '-m', 'pip', 'install', '--upgrade', '--prefer-binary', ...t.packages], onProgress);
      if (r.ok) return { ok: true, message: `Installed ${t.packages.join(', ')}` };
      // Add the actionable cause when the failure looks like the too-new-Python
      // source-build trap (Rust/Cargo, or wheel-build metadata failures).
      const hint = !py.compatible
        ? ` — Python ${py.version} has no prebuilt package for one of these; install Python 3.12 from https://www.python.org/downloads/ and run Install Missing again.`
        : '';
      return { ok: false, error: `${r.error}${hint}` };
    }

    if (t.kind === 'download') {
      let dir;
      try { dir = deps.modelsDir(t.category); } catch (e) { return { ok: false, error: `models folder unavailable: ${(e && e.message) || e}` }; }
      const saved = [];
      for (const f of t.files) {
        const dest = path.join(dir, f.name);
        if (deps.fs.existsSync(dest)) { onProgress(`${f.name} already present`); saved.push(dest); continue; }
        onProgress(`Downloading ${f.name}…`);
        const r = await _download(f.url, dest, onProgress, 0);
        if (!r.ok) return { ok: false, error: `download failed (${f.name}): ${r.error}` };
        saved.push(r.path);
      }
      return { ok: true, message: `Downloaded ${saved.length} file(s) into ${dir}`, paths: saved };
    }

    if (t.kind === 'ollama') {
      if (!deps.pullOllamaModel) return { ok: false, error: 'ollama puller not wired' };
      const model = String(opts.model || t.defaultModel || '').trim();
      if (!OLLAMA_MODEL_RE.test(model)) return { ok: false, error: 'BAD_MODEL' };
      onProgress(`Pulling Ollama model ${model}…`);
      const handle = deps.pullOllamaModel(model, (line) => onProgress(line));
      const r = await (handle && handle.done ? handle.done : Promise.resolve({ ok: false, error: 'puller returned no promise' }));
      return r && r.ok ? { ok: true, message: `Pulled ${model}`, model } : (r || { ok: false, error: 'pull failed' });
    }

    if (t.kind === 'handoff') {
      if (typeof deps.openExternal === 'function') { try { deps.openExternal(t.url); } catch (_) {} }
      return { ok: true, handoff: true, url: t.url, message: `Opened ${t.label} download page — finish the install there.` };
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  return { ok: false, error: 'UNSUPPORTED_KIND' };
}

// The recommended full sequence, in order. Stops nothing on a single failure —
// each target is independent — but reports each result so the caller can show
// which ones need attention.
const AUTO_ORDER = ['open-interpreter', 'voice', 'voice-model', 'ollama-model', 'stability-matrix'];

async function auto(opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const onStep = typeof opts.onStep === 'function' ? opts.onStep : () => {};
  const order = Array.isArray(opts.order) && opts.order.length ? opts.order.filter(has) : AUTO_ORDER;
  const results = [];
  for (const id of order) {
    onStep({ target: id, phase: 'start' });
    const r = await install(id, { model: opts.model, onProgress: (line) => onProgress(id, line) });
    results.push({ target: id, ...r });
    onStep({ target: id, phase: 'done', ok: !!(r && r.ok), error: (r && r.error) || null });
  }
  const okCount = results.filter((r) => r.ok).length;
  return { ok: okCount > 0, results, installed: okCount, total: results.length };
}

module.exports = { TARGETS, AUTO_ORDER, configure, pythonBin, resolvePython, pythonStatus, _resetPython, has, get, list, detect, detectAll, install, auto };
