'use strict';
/*
 * llm-speed.js — how fast each local model REALLY answers on this PC.
 *
 * Every time Alfred gets a reply from Ollama's own API (/api/chat), Ollama says how many word-pieces
 * ("tokens") it wrote (eval_count) and how long that took (eval_duration, nanoseconds). record() keeps a
 * running average per model, so the model finder (🔎 Find a model) can show "measured on this PC" instead
 * of its estimate. Very short replies (under 8 tokens) are ignored: their timing is mostly noise.
 *
 *   speed.configure({ file })      remember the speeds across restarts in a small JSON file (optional)
 *   speed.recordOllama(model, j)   from an /api/chat answer body (eval_count / eval_duration)
 *   speed.record(model, tokensPerSec)
 *   speed.get(model) -> { tokensPerSec, samples, at } | null
 *   speed.all() -> { model: { tokensPerSec, samples, at } }
 *
 * Never throws; nothing here logs.
 */
const fs = require('fs');
const path = require('path');

const MIN_TOKENS = 8;
const MAX_MODELS = 200;
let speeds = Object.create(null);
let file = null;
let loaded = false;

function key(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return '';
  return /:[^/]+$/.test(n) ? n : `${n}:latest`;
}
function load() {
  if (loaded) return;
  loaded = true;
  if (!file) return;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && typeof j === 'object') for (const k of Object.keys(j)) { const v = j[k]; if (v && Number(v.tokensPerSec) > 0 && !speeds[key(k)]) speeds[key(k)] = { tokensPerSec: Number(v.tokensPerSec), samples: Number(v.samples) || 1, at: v.at || null }; }
  } catch (_) { /* no file yet, or unreadable: start fresh */ }
}
function save() {
  if (!file) return;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(speeds, null, 1)); } catch (_) { /* best effort */ }
}
function configure(opts) {
  const o = opts || {};
  file = o.file || null;
  loaded = false;
  load(); // what is on disk joins what was measured before configure() (newer wins)
}
/** Add one measurement (tokens/second). The average leans on the latest replies (the PC may change). */
function record(model, tokensPerSec) {
  const k = key(model);
  const t = Number(tokensPerSec);
  if (!k || !Number.isFinite(t) || t <= 0 || t > 5000) return null;
  load();
  const prev = speeds[k];
  const samples = prev ? Math.min(20, prev.samples + 1) : 1;
  const avg = prev ? prev.tokensPerSec + (t - prev.tokensPerSec) / samples : t;
  speeds[k] = { tokensPerSec: Math.round(avg * 10) / 10, samples, at: new Date().toISOString() };
  const keys = Object.keys(speeds);
  if (keys.length > MAX_MODELS) { keys.sort((a, b) => String(speeds[a].at).localeCompare(String(speeds[b].at))); delete speeds[keys[0]]; }
  save();
  return speeds[k];
}
/** From Ollama's /api/chat (or /api/generate) answer: eval_count tokens in eval_duration nanoseconds. */
function recordOllama(model, body) {
  const b = body || {};
  const n = Number(b.eval_count);
  const ns = Number(b.eval_duration);
  if (!Number.isFinite(n) || n < MIN_TOKENS || !Number.isFinite(ns) || ns <= 0) return null;
  return record(model || b.model, n / (ns / 1e9));
}
function get(model) { load(); return speeds[key(model)] || null; }
function all() { load(); return Object.assign({}, speeds); }
/** Forget everything (as if the app just started, with no file yet). For tests. */
function reset() { speeds = Object.create(null); file = null; loaded = false; }

module.exports = { configure, record, recordOllama, get, all, reset, key, MIN_TOKENS };
