'use strict';
/*
 * ollama-manager.js — detect Ollama, list/recommend/download local models for
 * the "system AI" (the Local Supervisor / Manager). Everything is best-effort
 * and defensive: if Ollama isn't installed, detect() says so and the rest
 * no-ops. The actual model download shells out to `ollama pull`, which only
 * works when Ollama is present on the machine.
 */
const { execFile, spawn } = require('child_process');

const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';

function _ollamaBin() { return process.env.OLLAMA_BIN || 'ollama'; }

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
  const done = new Promise((resolve) => {
    try {
      child = spawn(_ollamaBin(), ['pull', name], { windowsHide: true });
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

module.exports = { DEFAULT_ENDPOINT, detect, listInstalled, recommended, pull };
