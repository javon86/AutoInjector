'use strict';
/*
 * ollama-manager.js — detect Ollama, list/recommend/download local models for
 * the "system AI" (the Local Supervisor / Manager). Everything is best-effort
 * and defensive: if Ollama isn't installed, detect() says so and the rest
 * no-ops. The actual model download shells out to `ollama pull`, which only
 * works when Ollama is present on the machine.
 */
const { execFile, spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';
// The app's own Ollama listens here (a dedicated port so it never fights a
// system Ollama already on 11434). Its store is pointed at "stuff and thing".
const DEFAULT_MANAGED_HOST = '127.0.0.1:11435';

function _ollamaBin() { return process.env.OLLAMA_BIN || 'ollama'; }

/**
 * Where Ollama keeps its model store when nothing redirects it. This is the
 * place models already downloaded on this machine actually live — the source
 * for a "move into stuff and thing" migration. (env.OLLAMA_MODELS wins if set;
 * otherwise the per-user default ~/.ollama/models, %USERPROFILE%\.ollama\models
 * on Windows.)
 */
function defaultStoreDir(env, platform) {
  const e = env || process.env;
  if (e.OLLAMA_MODELS) return e.OLLAMA_MODELS;
  const home = e.HOME || e.USERPROFILE || os.homedir();
  return path.join(home, '.ollama', 'models');
}

/** Is Ollama installed? Returns { available, version } (never throws). */
function detect() {
  return new Promise((resolve) => {
    try {
      execFile(_ollamaBin(), ['--version'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve({ available: false, reason: 'Ollama not found on PATH' });
        resolve({ available: true, version: String(stdout || '').trim() });
      });
    } catch (e) { resolve({ available: false, reason: String((e && e.message) || e) }); }
  });
}

/** Models already installed locally (via the Ollama API). */
// AI-005: bound the discovery call with an abort timeout so a malformed or
// unreachable endpoint can't hang the refresh on the OS/network timeout, and
// report a timeout distinctly from "no models installed".
async function listInstalled(endpoint, timeoutMs) {
  const base = endpoint || DEFAULT_ENDPOINT;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs || 5000));
  try {
    const res = await fetch(`${base}/api/tags`, { method: 'GET', signal: controller.signal });
    if (!res.ok) return { ok: false, models: [], reason: `HTTP ${res.status}` };
    const body = await res.json();
    const models = (body && Array.isArray(body.models) ? body.models : []).map((m) => m.name).filter(Boolean);
    return { ok: true, models };
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, models: [], reason: 'timeout' };
    return { ok: false, models: [], reason: 'unreachable' };
  } finally { clearTimeout(t); }
}

// Curated small→large local models keyed to VRAM (GB). These are good general
// "system AI" choices for the Supervisor/Manager; smaller = lighter.
function recommended(vramGB) {
  const v = Number(vramGB) || 0;
  if (v >= 24) return ['qwen2.5:14b', 'llama3.1:8b', 'qwen2.5:7b'];
  if (v >= 12) return ['qwen2.5:7b', 'llama3.1:8b', 'mistral:7b'];
  if (v >= 8) return ['llama3.1:8b', 'qwen2.5:7b', 'phi3.5'];
  if (v >= 6) return ['qwen2.5:3b', 'llama3.2:3b', 'phi3.5'];
  if (v >= 4) return ['llama3.2:3b', 'qwen2.5:1.5b', 'llama3.2:1b'];
  return ['llama3.2:1b', 'qwen2.5:0.5b', 'qwen2.5:1.5b'];
}

/**
 * Download/install a model with `ollama pull <name>`. Streams progress lines to
 * onProgress(text). Resolves { ok } or { ok:false, error }. Only works if
 * Ollama is installed.
 * @returns {{child: import('child_process').ChildProcess, done: Promise}}
 */
function pull(model, onProgress, opts = {}) {
  const name = String(model || '').trim();
  if (!name) return { child: null, done: Promise.resolve({ ok: false, error: 'no model specified' }) };
  // A pull can legitimately run a long time (gigabytes), but it streams progress
  // the whole way. Watch for *silence*: if nothing arrives for idleMs, the pull
  // has stalled — kill it so it can't hold a download slot forever.
  const idleMs = opts.idleMs || 180000; // 3 minutes of no output
  let child;
  // opts.host points the pull at a specific Ollama server (e.g. the app's own,
  // whose store is the "stuff and thing" folder) via OLLAMA_HOST, so the blobs
  // land there instead of in whatever daemon happens to own port 11434.
  const spawnEnv = opts.host ? Object.assign({}, process.env, { OLLAMA_HOST: opts.host }) : process.env;
  const done = new Promise((resolve) => {
    try {
      child = spawn(_ollamaBin(), ['pull', name], { windowsHide: true, env: spawnEnv });
    } catch (e) { return resolve({ ok: false, error: `could not start ollama: ${(e && e.message) || e}` }); }
    let stalled = false;
    let idle = null;
    const resetIdle = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => { stalled = true; try { child.kill(); } catch (_) {} }, idleMs);
    };
    const emit = (buf) => { resetIdle(); const s = String(buf).trim(); if (s && typeof onProgress === 'function') onProgress(s); };
    child.stdout && child.stdout.on('data', emit);
    child.stderr && child.stderr.on('data', emit); // ollama writes progress to stderr
    child.on('error', (e) => { if (idle) clearTimeout(idle); resolve({ ok: false, error: String((e && e.message) || e) }); });
    child.on('close', (code) => {
      if (idle) clearTimeout(idle);
      if (stalled) return resolve({ ok: false, error: 'ollama pull stalled (no progress) and was stopped' });
      resolve(code === 0 ? { ok: true, model: name } : { ok: false, error: `ollama pull exited ${code}` });
    });
    resetIdle();
  });
  return { child, done };
}

// --- The app's own Ollama server -------------------------------------------
// We run `ollama serve` ourselves with OLLAMA_MODELS pointed at the shared
// models/llm folder and OLLAMA_HOST on a dedicated port. Then everything the
// app pulls (which we target at this same host) is stored in "stuff and thing".
let _managed = null; // { child, host, modelsDir }

/**
 * Start the app-managed Ollama server. Best-effort and non-throwing.
 * @param {{modelsDir:string, host?:string, bin?:string, spawnFn?:Function, onLog?:Function}} opts
 */
function startManaged(opts = {}) {
  const host = opts.host || DEFAULT_MANAGED_HOST;
  const modelsDir = opts.modelsDir;
  const spawnFn = opts.spawnFn || spawn;
  const bin = opts.bin || _ollamaBin();
  if (!modelsDir) return { ok: false, error: 'no modelsDir given' };
  if (_managed && _managed.child && !_managed.child.killed) {
    return { ok: true, already: true, host: _managed.host, modelsDir: _managed.modelsDir };
  }
  let child;
  try {
    child = spawnFn(bin, ['serve'], {
      windowsHide: true,
      env: Object.assign({}, process.env, { OLLAMA_HOST: host, OLLAMA_MODELS: modelsDir }),
    });
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  _managed = { child, host, modelsDir };
  if (typeof opts.onLog === 'function' && child) {
    child.stdout && child.stdout.on('data', (b) => { try { opts.onLog(String(b).trim()); } catch (_) {} });
    child.stderr && child.stderr.on('data', (b) => { try { opts.onLog(String(b).trim()); } catch (_) {} });
  }
  if (child && typeof child.on === 'function') child.on('close', () => { if (_managed && _managed.child === child) _managed = null; });
  return { ok: true, host, modelsDir };
}

/** Stop the app-managed Ollama server (safe no-op if none is running). */
function stopManaged() {
  if (_managed && _managed.child) { try { _managed.child.kill(); } catch (_) {} }
  _managed = null;
  return { ok: true };
}

/** Is the app's own Ollama running, and where does it store models? */
function managedStatus() {
  const running = !!(_managed && _managed.child && !_managed.child.killed);
  return {
    running,
    host: running ? _managed.host : null,
    endpoint: running ? `http://${_managed.host}` : null,
    modelsDir: running ? _managed.modelsDir : null,
  };
}

/** Poll a host until its /api/tags answers (server is up). Non-throwing. */
async function waitReady(host, timeoutMs = 15000) {
  const base = `http://${host || DEFAULT_MANAGED_HOST}`;
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  while (Date.now() < deadline) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 1500);
      let ok = false;
      try { const res = await fetch(`${base}/api/tags`, { signal: c.signal }); ok = !!(res && res.ok); } finally { clearTimeout(t); }
      if (ok) return { ok: true };
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return { ok: false, error: 'timeout' };
}

/**
 * Move Ollama's model store (blobs/ + manifests/) from `from` into `to`,
 * merging. Blobs are content-addressed, so a name that already exists at the
 * destination is identical content — it's skipped, never overwritten. A rename
 * is used when possible (instant, same volume) and falls back to copy+unlink
 * across volumes. Injectable fs for tests; non-throwing.
 * @param {{from:string, to:string, fs?:object, onLog?:Function}} opts
 */
function migrateStore(opts = {}) {
  const from = opts.from, to = opts.to;
  const f = opts.fs || fs;
  const log = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  if (!from || !to) return { ok: false, error: 'need both a source and a destination folder' };
  if (path.resolve(from) === path.resolve(to)) return { ok: true, moved: 0, skipped: 0, bytes: 0, from, to, note: 'already storing in this folder' };
  if (!f.existsSync(from)) return { ok: false, error: `nothing to move — ${from} does not exist` };
  let moved = 0, skipped = 0, bytes = 0;
  const walk = (srcDir, dstDir) => {
    let entries;
    try { entries = f.readdirSync(srcDir, { withFileTypes: true }); } catch (_) { return; }
    try { f.mkdirSync(dstDir, { recursive: true }); } catch (_) {}
    for (const ent of entries) {
      const s = path.join(srcDir, ent.name);
      const d = path.join(dstDir, ent.name);
      const isDir = ent.isDirectory ? ent.isDirectory() : false;
      if (isDir) { walk(s, d); continue; }
      if (f.existsSync(d)) { skipped++; continue; }
      try {
        try { f.renameSync(s, d); }
        catch (_) { f.copyFileSync(s, d); try { f.unlinkSync(s); } catch (_) {} }
        moved++;
        try { bytes += f.statSync(d).size; } catch (_) {}
        log(`moved ${ent.name}`);
      } catch (e) { log(`could not move ${ent.name}: ${(e && e.message) || e}`); skipped++; }
    }
  };
  for (const sub of ['blobs', 'manifests']) {
    const src = path.join(from, sub);
    if (f.existsSync(src)) walk(src, path.join(to, sub));
  }
  if (moved === 0 && skipped === 0) return { ok: true, moved, skipped, bytes, from, to, note: 'no models found to move' };
  return { ok: true, moved, skipped, bytes, from, to };
}

module.exports = {
  DEFAULT_ENDPOINT, DEFAULT_MANAGED_HOST,
  detect, listInstalled, recommended, pull,
  defaultStoreDir, startManaged, stopManaged, managedStatus, waitReady, migrateStore,
};
