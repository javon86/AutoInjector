'use strict';
/*
 * sd-provider.js — Stable Diffusion image generation (Phase 1).
 *
 * Same shape as manager-provider.js: a single configurable HTTP endpoint (an
 * Automatic1111 / Forge server, local or on a RunPod pod) reached with fetch,
 * with timeout and error mapping. Both the operator (via the Image Studio panel)
 * and an AI (via an `[IMAGE: ...]` tag in its reply) route through generate().
 *
 * Off unless enabled AND an endpoint is configured. Every failure is returned as
 * a structured { ok:false, error } — it never throws into main.js.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const secretStore = require('./secret-store');

const DEFAULT_ENDPOINT = 'http://127.0.0.1:7860';
const DEFAULT_TIMEOUT_MS = 180000; // generation can be slow
const GALLERY_MAX = 60;

let _settingsPath = null;
let _imagesDir = null;
let _gallery = []; // { file, prompt, ts, from, seed }
const DEFAULTS = {
  enabled: false,
  autoFromAI: false,          // let an AI's [IMAGE: ...] tag trigger a render
  endpoint: DEFAULT_ENDPOINT,
  apiKey: '',
  steps: 25, cfg: 7, width: 512, height: 512,
  negativePrompt: '',
  sampler: 'Euler a',
  model: '',                  // checkpoint name; '' = whatever the server has loaded (default: a light SD 1.5)
  batch: 1,                   // images per Generate
};
let _settings = Object.assign({}, DEFAULTS);

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function nowMs() { return Date.now(); }

function init(userDataDir) {
  try {
    const base = userDataDir || __dirname;
    _settingsPath = path.join(base, 'sd-settings.json');
    _imagesDir = path.join(base, 'sd-images');
    fs.mkdirSync(_imagesDir, { recursive: true });
    if (fs.existsSync(_settingsPath)) {
      const raw = JSON.parse(fs.readFileSync(_settingsPath, 'utf8'));
      // AI-001: key stored sealed (apiKeyEnc); decrypt to memory, migrate legacy.
      let apiKey = '';
      if (raw.apiKeyEnc) apiKey = secretStore.open(raw.apiKeyEnc);
      else if (raw.apiKey) apiKey = raw.apiKey;
      _settings = Object.assign({}, DEFAULTS, raw, { apiKey });
      delete _settings.apiKeyEnc;
      if (raw.apiKey || raw.apiKeyEnc) _save();
    }
    const idx = path.join(_imagesDir, 'gallery.json');
    _gallery = fs.existsSync(idx) ? (JSON.parse(fs.readFileSync(idx, 'utf8')) || []) : [];
  } catch (_) { _settings = Object.assign({}, DEFAULTS); _gallery = []; }
  return getSettings();
}

// Persist WITHOUT the plaintext key (AI-001): seal it into apiKeyEnc, or omit.
function _save() {
  try {
    if (!_settingsPath) return;
    const out = clone(_settings);
    delete out.apiKey;
    const enc = secretStore.seal(_settings.apiKey);
    if (enc) out.apiKeyEnc = enc; else delete out.apiKeyEnc;
    fs.writeFileSync(_settingsPath, JSON.stringify(out, null, 2), 'utf8');
  } catch (_) {}
}
function _saveGallery() {
  try { if (_imagesDir) fs.writeFileSync(path.join(_imagesDir, 'gallery.json'), JSON.stringify(_gallery.slice(-GALLERY_MAX), null, 2), 'utf8'); } catch (_) {}
}

/** Settings for the UI — apiKey is never returned, only whether one is set. */
function getSettings() {
  const s = clone(_settings);
  const hasApiKey = !!s.apiKey;
  delete s.apiKey;
  return Object.assign(s, { hasApiKey });
}

function setSettings(patch) {
  patch = patch || {};
  // Only overwrite apiKey when a non-empty one is provided.
  const next = Object.assign({}, _settings, patch);
  if (patch.apiKey === undefined || patch.apiKey === '') next.apiKey = _settings.apiKey;
  _settings = Object.assign({}, DEFAULTS, next);
  _save();
  return getSettings();
}

function isEnabled() { return !!_settings.enabled; }
function autoFromAI() { return !!(_settings.enabled && _settings.autoFromAI); }

function redactSecrets(s) {
  if (!_settings.apiKey) return String(s);
  return String(s).split(_settings.apiKey).join('[REDACTED]');
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  try { return await fetch(url, Object.assign({}, options, { signal: controller.signal })); }
  finally { clearTimeout(timer); }
}

function _headers() {
  return Object.assign({ 'Content-Type': 'application/json' },
    _settings.apiKey ? { Authorization: `Bearer ${_settings.apiKey}` } : {});
}

/**
 * Recognise an `[IMAGE: prompt]` tag at the very start of a reply (parallel to
 * the roundtable's `[TO: X]`). Returns the prompt, or null.
 */
function parseImageTag(text) {
  const m = /^\s*\[IMAGE:\s*([^\]]+)\]/i.exec(String(text || ''));
  return m ? m[1].trim() : null;
}

/** List the checkpoint models the server has (for the Model picker). */
async function listModels() {
  if (!_settings.endpoint) return { ok: false, error: 'NO_ENDPOINT', models: [] };
  try {
    const res = await fetchWithTimeout(`${_settings.endpoint}/sdapi/v1/sd-models`, { method: 'GET', headers: _headers() }, 8000);
    if (!res.ok) return { ok: false, error: `HTTP_${res.status}`, models: [] };
    const rows = await res.json();
    const models = (Array.isArray(rows) ? rows : []).map((m) => m.model_name || m.title).filter(Boolean);
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? 'TIMEOUT' : `NETWORK_ERROR: ${redactSecrets(String(e))}`, models: [] };
  }
}

/** Reachability check for the config UI's "Test" button. */
async function testConnection() {
  if (!_settings.endpoint) return { ok: false, error: 'NO_ENDPOINT' };
  try {
    const res = await fetchWithTimeout(`${_settings.endpoint}/sdapi/v1/sd-models`, { method: 'GET', headers: _headers() }, 8000);
    if (!res.ok) return { ok: false, error: `HTTP_${res.status}` };
    let models = [];
    try { models = await res.json(); } catch (_) {}
    return { ok: true, models: Array.isArray(models) ? models.length : 0 };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? 'TIMEOUT' : `NETWORK_ERROR: ${redactSecrets(String(e))}` };
  }
}

/**
 * Generate an image via Automatic1111 txt2img and save the first result.
 * @param {{prompt:string, negativePrompt?:string, steps?:number, cfg?:number,
 *          width?:number, height?:number, seed?:number, from?:string}} opts
 * @returns {Promise<{ok:boolean, error?:string, file?:string, dataUri?:string, prompt?:string, from?:string}>}
 */
async function generate(opts) {
  opts = opts || {};
  if (!_settings.enabled) return { ok: false, error: 'DISABLED' };
  if (!_settings.endpoint) return { ok: false, error: 'NO_ENDPOINT' };
  const prompt = String(opts.prompt || '').trim();
  if (!prompt) return { ok: false, error: 'NO_PROMPT' };

  const batch = Math.max(1, Math.min(Number(opts.batch || _settings.batch || 1), 8));
  const model = opts.model != null ? String(opts.model) : _settings.model;
  const payload = {
    prompt,
    negative_prompt: opts.negativePrompt != null ? String(opts.negativePrompt) : _settings.negativePrompt,
    steps: opts.steps || _settings.steps,
    cfg_scale: opts.cfg || _settings.cfg,
    width: opts.width || _settings.width,
    height: opts.height || _settings.height,
    seed: opts.seed != null ? opts.seed : -1,
    sampler_name: opts.sampler || _settings.sampler || undefined,
    batch_size: batch,
    n_iter: 1,
  };
  // Pick a specific checkpoint (e.g. an SD 1.5 vs an SDXL model) per request.
  if (model) payload.override_settings = { sd_model_checkpoint: model };

  let res;
  try {
    res = await fetchWithTimeout(`${_settings.endpoint}/sdapi/v1/txt2img`,
      { method: 'POST', headers: _headers(), body: JSON.stringify(payload) }, opts.timeoutMs);
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? 'TIMEOUT' : `NETWORK_ERROR: ${redactSecrets(String(e))}` };
  }
  if (!res.ok) {
    let t = ''; try { t = await res.text(); } catch (_) {}
    return { ok: false, error: `HTTP_${res.status}`, detail: redactSecrets(t).slice(0, 500) };
  }
  let body;
  try { body = await res.json(); } catch (_) { return { ok: false, error: 'INVALID_RESPONSE_BODY' }; }
  const imgs = body && Array.isArray(body.images) ? body.images : [];
  if (!imgs.length) return { ok: false, error: 'NO_IMAGE_RETURNED' };

  const seed = _seedFromInfo(body);
  const from = opts.from || 'user';
  const saved = [];
  for (const b64 of imgs) {
    const clean = String(b64).replace(/^data:image\/\w+;base64,/, '');
    const bytes = Buffer.from(clean, 'base64');
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const ts = nowMs() + saved.length;
    const file = _imagesDir ? path.join(_imagesDir, `img-${ts}.png`) : null;
    try { if (file) fs.writeFileSync(file, bytes); } catch (_) { /* keep going; still return dataUri */ }
    _gallery.push({ file, prompt, ts, from, seed, sha256 });
    saved.push({ file, dataUri: `data:image/png;base64,${clean}`, sha256 });
  }
  if (_gallery.length > GALLERY_MAX) _gallery = _gallery.slice(-GALLERY_MAX);
  _saveGallery();

  const first = saved[0];
  return { ok: true, file: first.file, dataUri: first.dataUri, sha256: first.sha256, prompt, from, seed, images: saved, count: saved.length };
}

function _seedFromInfo(body) {
  try { const info = body && body.info ? JSON.parse(body.info) : null; return info && info.seed != null ? info.seed : null; }
  catch (_) { return null; }
}

/** Recent gallery entries (newest first), each as a data URI for display. */
function gallery(limit = 24) {
  const out = [];
  for (const e of _gallery.slice(-limit).reverse()) {
    let dataUri = null;
    try { if (e.file && fs.existsSync(e.file)) dataUri = `data:image/png;base64,${fs.readFileSync(e.file).toString('base64')}`; } catch (_) {}
    out.push({ prompt: e.prompt, ts: e.ts, from: e.from, seed: e.seed, dataUri });
  }
  return out;
}

module.exports = {
  DEFAULTS, init, getSettings, setSettings, isEnabled, autoFromAI,
  testConnection, listModels, generate, parseImageTag, gallery, redactSecrets,
};
