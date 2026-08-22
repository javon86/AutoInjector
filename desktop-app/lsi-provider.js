'use strict';
/*
 * lsi-provider.js — LSI-001: Local Supervisor AI.
 *
 * A small local model that makes AutoInjector's fuzzy decisions: a fixed prompt
 * contract in, a strict JSON verdict out. Same HTTP shape as manager-provider.js
 * (one configurable OpenAI-compatible endpoint — Ollama / LM Studio / a RunPod
 * pod). This is the layer every LM subtask (SCS-008/009/010/011, LSI-002..009)
 * calls.
 *
 * "Done when": every supervisor call returns schema-valid JSON with a confidence
 * score, and the call is logged with input hash, verdict, and latency.
 * Degradation: invalid JSON → one reparse attempt, then VERDICT_UNAVAILABLE and
 * the caller's safe default; hard timeout (default 10s); if the supervisor is
 * offline the whole system runs in PG-only mode — degraded judgment, zero
 * downtime. It never throws into the caller.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const secretStore = require('./secret-store');
const client = require('./openai-client'); // AI-006: shared OpenAI-compatible HTTP client

const DEFAULT_TIMEOUT_MS = 10000;
const LOG_MAX = 200;

let _settingsPath = null;
const DEFAULTS = { enabled: false, endpoint: '', model: '', apiKey: '', timeoutMs: DEFAULT_TIMEOUT_MS };
let _settings = Object.assign({}, DEFAULTS);
let _log = [];

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function init(userDataDir) {
  try {
    _settingsPath = path.join(userDataDir || __dirname, 'lsi-settings.json');
    if (fs.existsSync(_settingsPath)) {
      const raw = JSON.parse(fs.readFileSync(_settingsPath, 'utf8'));
      // AI-001: the key lives on disk only as sealed ciphertext (apiKeyEnc).
      // Decrypt into memory for use; migrate any legacy plaintext apiKey.
      let apiKey = '';
      if (raw.apiKeyEnc) apiKey = secretStore.open(raw.apiKeyEnc);
      else if (raw.apiKey) apiKey = raw.apiKey; // legacy plaintext — migrated on next _save
      _settings = Object.assign({}, DEFAULTS, raw, { apiKey });
      delete _settings.apiKeyEnc;
      if (raw.apiKey || raw.apiKeyEnc) _save(); // rewrite in the sealed-only format
    }
  } catch (_) { _settings = Object.assign({}, DEFAULTS); }
  return getSettings();
}

// Persist WITHOUT the plaintext key: seal it into apiKeyEnc (dropped entirely if
// encryption is unavailable, so a readable key never touches disk).
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

function getSettings() {
  const s = clone(_settings); const hasApiKey = !!s.apiKey; delete s.apiKey;
  return Object.assign(s, { hasApiKey });
}
function setSettings(patch) {
  patch = patch || {};
  const next = Object.assign({}, _settings, patch);
  if (patch.apiKey === undefined || patch.apiKey === '') next.apiKey = _settings.apiKey;
  _settings = Object.assign({}, DEFAULTS, next);
  _save();
  return getSettings();
}
function isEnabled() { return !!(_settings.enabled && _settings.endpoint && _settings.model); }

// AI-006: redaction just binds the shared helper to this module's current key
// (String() preserves the old always-returns-a-string behavior).
function redactSecrets(s) { return client.redactSecrets(String(s), _settings.apiKey); }
function hashInput(s) { return crypto.createHash('sha256').update(String(s == null ? '' : s)).digest('hex').slice(0, 16); }

// AI-006: JSON extraction is the shared client's (same tolerant behavior).
const extractJsonObject = client.extractJsonObject;

function _valid(p, opts) {
  return !!p && typeof p.verdict === 'string'
    && (!opts.allowed || opts.allowed.includes(p.verdict))
    && typeof p.confidence === 'number' && p.confidence >= 0 && p.confidence <= 1;
}

async function _call(system, check, input) {
  // Any failure (network, timeout, non-2xx, bad body) -> null = "unavailable",
  // exactly as before; the shared client maps them all to r.ok === false.
  const r = await client.chatCompletion({
    endpoint: _settings.endpoint, apiKey: _settings.apiKey, model: _settings.model, temperature: 0,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `CHECK: ${check}\nINPUT: ${input}` },
    ],
    timeoutMs: _settings.timeoutMs || DEFAULT_TIMEOUT_MS,
  });
  if (!r.ok) return null;
  return extractJsonObject(r.content);
}

function _record(check, input, v, t0) {
  const latencyMs = Date.now() - t0;
  _log.push({ check, inputHash: hashInput(input), verdict: v.verdict, confidence: v.confidence, latencyMs, at: new Date().toISOString(), unavailable: !!v.unavailable });
  if (_log.length > LOG_MAX) _log = _log.slice(-LOG_MAX);
  return { ok: !v.unavailable, verdict: v.verdict, confidence: v.confidence, reason: v.reason || '', unavailable: !!v.unavailable, latencyMs };
}

/**
 * Ask the supervisor for a verdict.
 * @param {string} check   the fuzzy question, e.g. "is this a duplicate ack?"
 * @param {string} input   the material to judge
 * @param {{allowed?:string[], safeDefault?:string, system?:string}} [opts]
 * @returns {Promise<{ok:boolean, verdict:string, confidence:number, reason:string, unavailable:boolean, latencyMs:number}>}
 */
async function ask(check, input, opts = {}) {
  const t0 = Date.now();
  const safe = opts.safeDefault != null ? opts.safeDefault : 'VERDICT_UNAVAILABLE';
  if (!isEnabled()) {
    return _record(check, input, { verdict: safe, confidence: 0, reason: 'supervisor offline (PG-only mode)', unavailable: true }, t0);
  }
  const allowedList = opts.allowed ? JSON.stringify(opts.allowed) : 'a short string';
  const system = opts.system ||
    `You are a local supervisor for an automation system. Respond with STRICT JSON only, no prose: ` +
    `{"verdict": one of ${allowedList}, "confidence": a number 0..1, "reason": "<short>"}.`;

  let parsed = await _call(system, check, input);
  if (!_valid(parsed, opts)) parsed = await _call(system + ' Return ONLY the JSON object, nothing else.', check, input); // 1 reparse attempt
  if (!_valid(parsed, opts)) {
    return _record(check, input, { verdict: safe, confidence: 0, reason: 'invalid or unavailable verdict', unavailable: true }, t0);
  }
  return _record(check, input, { verdict: parsed.verdict, confidence: parsed.confidence, reason: parsed.reason }, t0);
}

/** Lightweight reachability check for the panel's Test button. */
async function testConnection() {
  if (!_settings.endpoint) return { ok: false, error: 'NO_ENDPOINT' };
  // AI-002/AI-006: reachability via the shared /models probe. A 404 is
  // reachable-but-not-usable (ok requires a 2xx); a network error is redacted.
  const r = await client.probeModels({ endpoint: _settings.endpoint, apiKey: _settings.apiKey, timeoutMs: 6000 });
  if (r.reachable) return { ok: r.ok, reachable: true, status: r.status };
  return { ok: false, reachable: false, error: redactSecrets(r.error) };
}

/** Recent supervisor-call log (input HASHES only, never the raw input). */
function logs(limit = 50) { return _log.slice(-limit).reverse(); }

module.exports = { DEFAULTS, init, getSettings, setSettings, isEnabled, ask, testConnection, logs, redactSecrets, extractJsonObject };
