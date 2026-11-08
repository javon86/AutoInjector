/*
 * llm-local-info.js — 🖥 what Akọwe's "Local AI backup" (plan item 5c) needs to know about Alfred's local model,
 * from llm-setup.js's status(): is Ollama running and where, which model Alfred uses, how big it is, and how well it
 * fits this PC (llm-hardware.js's fit rating). Served on the service bridge as GET /llm/local.
 *
 *   localInfo(status, paramsFromName) -> { found, endpoint, model, params_b, fit, models: [{ name, params_b, fit }] }
 *
 * Plain JS, no dependencies. Never includes chat text, keys or paths.
 */
'use strict';

function paramsOf(m, paramsFromName) {
  const p = m && m.params ? /(\d+(?:\.\d+)?)\s*([bm])\b/i.exec(String(m.params)) : null;
  if (p) return p[2].toLowerCase() === 'm' ? Number(p[1]) / 1000 : Number(p[1]);
  const n = typeof paramsFromName === 'function' ? paramsFromName(m && m.name) : null;
  return Number.isFinite(n) ? n : null;
}

function fitOf(f) {
  if (!f || typeof f !== 'object' || !f.rating) return null;
  return { rating: String(f.rating), label: String(f.label || f.rating) };
}

function localInfo(st, paramsFromName) {
  const s = st && typeof st === 'object' ? st : {};
  const srv = s.server || {};
  if (!s.ok || !srv.running) return { found: false, endpoint: null, model: null, params_b: null, fit: null, models: [] };
  const models = (Array.isArray(s.models) ? s.models : []).filter((m) => m && m.name && !/embed/i.test(m.name))
    .map((m) => ({ name: String(m.name), params_b: paramsOf(m, paramsFromName), fit: fitOf(m.fit) }));
  const want = (s.alfred && s.alfred.model) || (s.butler && s.butler.model) || null;
  const hit = models.find((m) => m.name === want) || null;
  return {
    found: true,
    endpoint: String(srv.base || '').replace(/\/v1\/?$/, '') || null,
    model: hit ? hit.name : null,
    params_b: hit ? hit.params_b : null,
    fit: hit ? hit.fit : null,
    models: models.slice(0, 30),
  };
}

module.exports = { localInfo, paramsOf };
