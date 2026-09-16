'use strict';
/*
 * openai-client.js — the single OpenAI-compatible chat-completions client used
 * by the manager/supervisor (manager-provider.js). It owns the shared plumbing
 * that used to be copied per-provider (AI-006): request + timeout,
 * error mapping, secret redaction, JSON extraction, and a /models reachability
 * probe. It is deliberately format-agnostic — each provider keeps its OWN prompt
 * building and its own response schema/validation; this module never decides
 * what the model is asked or what a valid answer looks like.
 */
const DEFAULT_TIMEOUT_MS = 60000;

// fetch with an abort timeout. Any host-provided global fetch is used (so tests
// that stub global.fetch still work).
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  try { return await fetch(url, Object.assign({}, options, { signal: controller.signal })); }
  finally { clearTimeout(timer); }
}

// Replace every occurrence of a secret with [REDACTED]. No-op if either arg is
// missing/non-string.
function redactSecrets(text, apiKey) {
  if (typeof text !== 'string' || !apiKey) return text;
  return text.split(apiKey).join('[REDACTED]');
}

// Pull the first {...} JSON object out of a model reply (tolerates code fences /
// stray prose). Returns null when there's nothing parseable.
// Find the FIRST balanced {...} object in a string (respecting quoted strings),
// so we can pull one clean object out of prose, trailing commentary, or several
// concatenated objects — the shapes weaker local models tend to emit.
function _firstBalancedObject(s) {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}
function _tryParse(candidate) {
  if (!candidate) return null;
  try { return JSON.parse(candidate); } catch (_) {}
  // Forgive trailing commas (a very common local-model slip).
  try { return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1')); } catch (_) {}
  return null;
}
function extractJsonObject(text) {
  if (text == null) return null;
  let s = String(text).trim();
  // Strip a ```json … ``` (or bare ```) code fence if the model wrapped it.
  const fence = s.match(/```(?:json|javascript|js)?\s*([\s\S]*?)```/i);
  if (fence && fence[1].trim()) s = fence[1].trim();
  let obj = _tryParse(s);
  if (obj && typeof obj === 'object') return obj;
  // The first complete, balanced object anywhere in the text.
  obj = _tryParse(_firstBalancedObject(s));
  if (obj && typeof obj === 'object') return obj;
  // Last resort: the old first-"{" to last-"}" slice.
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start >= 0 && end > start) { obj = _tryParse(s.slice(start, end + 1)); if (obj && typeof obj === 'object') return obj; }
  return null;
}

/**
 * POST an OpenAI-compatible chat completion. Returns a structured result the
 * caller maps to its OWN error vocabulary (so neither provider's public
 * behavior changes):
 *   { ok:true,  content, status, body }
 *   { ok:false, kind:'timeout' }
 *   { ok:false, kind:'network', detail }          // detail = raw error string (UNredacted; caller redacts)
 *   { ok:false, kind:'http', status, detail }     // detail = response body text (UNredacted)
 *   { ok:false, kind:'bad-body', status }         // 2xx but body wasn't JSON
 */
async function chatCompletion({ endpoint, apiKey, model, messages, temperature, timeoutMs }) {
  let res;
  try {
    res = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      body: JSON.stringify(Object.assign({ model, messages }, temperature == null ? {} : { temperature })),
    }, timeoutMs);
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, kind: 'timeout' };
    return { ok: false, kind: 'network', detail: String(e) };
  }
  if (!res.ok) {
    let detail = ''; try { detail = await res.text(); } catch (_) { /* best effort */ }
    return { ok: false, kind: 'http', status: res.status, detail };
  }
  let body; try { body = await res.json(); } catch (_) { return { ok: false, kind: 'bad-body', status: res.status }; }
  const content = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
  return { ok: true, content, status: res.status, body };
}

/**
 * GET {base}/models — reachability probe for a "Test connection" button.
 * `ok` is true only for a 2xx (a 404 means the server answered but the models
 * route is wrong: reachable, not usable — see AI-002).
 *   { ok:<2xx>, reachable:true, status }  |  { ok:false, reachable:false, error }
 */
async function probeModels({ endpoint, apiKey, timeoutMs }) {
  const base = String(endpoint || '').replace(/\/chat\/completions.*$/, '').replace(/\/$/, '');
  try {
    const res = await fetchWithTimeout(`${base}/models`, { method: 'GET', headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} }, timeoutMs || 6000);
    return { ok: res.ok, reachable: true, status: res.status };
  } catch (e) {
    return { ok: false, reachable: false, error: e && e.name === 'AbortError' ? 'TIMEOUT' : `NETWORK_ERROR: ${String(e)}` };
  }
}

module.exports = { fetchWithTimeout, redactSecrets, extractJsonObject, chatCompletion, probeModels, DEFAULT_TIMEOUT_MS };
