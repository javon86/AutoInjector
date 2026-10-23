'use strict';
/*
 * bookforge-bridge.js — the AutoInjector desktop side of the BookForge bridge
 * (contract v1: docs/BOOKFORGE_AUTOINJECTOR_BRIDGE.md, which is normative).
 *
 * A tiny loopback-only HTTP server that lets BookForge send one prompt to one of
 * the chat panes (chatgpt|claude|gemini) and get the next captured reply back.
 * PURE NODE: no Electron import. main.js supplies the pane-facing pieces:
 *
 *   createBridge({
 *     port = 17891, host = "127.0.0.1",
 *     getToken()                         -> current bearer token string ('' = refuse all)
 *     sendToSite(site, text, meta)       -> Promise<{ ok, error?, seq? }>
 *                                           meta = { request_id, cancelToken }; cancelToken is
 *                                           { cancelled, typing }: the bridge sets cancelled when
 *                                           the request times out before its prompt was typed, and
 *                                           the host then withdraws the queued send (error
 *                                           "CANCELLED") and sets typing while it is typing
 *     siteReady(site)                    -> bool   (pane exists, loaded, and its message box is on the page)
 *     siteProblem(site)?                 -> string|null (why it isn't ready, in plain words, for the 503 message)
 *     wrapPrompt(site, text)?            -> text   (adds the [FROM: <SITE>] reply-envelope instruction)
 *     now()?, logger(kind, detail)?, sites?, timeScale?, bodyTimeLimitMs?,
 *     onEvent(event)?                    -> called for every activity event (see below)
 *   }) -> { start(), stop(), onCaptured(turn) -> bool, status(), recordEvent(kind, fields),
 *          createPairingCode() -> string, bookforgeStatus() -> object|null }
 *
 * onCaptured(turn) is called by main.js for every captured reply
 * ({ site, text, answers }). It returns true when the reply belonged to a bridge
 * request (main.js must then skip ALL relay handling for it) and false otherwise.
 * A reply belongs to the request ONLY when it answers that request's prompt:
 * the prompt was typed (sendToSite resolved ok with its [MSG #] seq) and
 * turn.answers — the [MSG #] numbers the Relay Trace says this reply answers —
 * contains that seq. (Without turn.answers, a reply captured before the prompt
 * was typed is still never taken.) A reply to the user's side question, or one
 * captured while the prompt is still queued behind a busy AI, is left to the
 * normal relay. awaitingReply(site) says whether a typed prompt awaits its answer.
 *
 * Timeouts (BF-02 / NEW-bridge-2): if the prompt was never typed when the
 * request times out, the queued send is withdrawn, the site is free at once and
 * the 504 says typed:false (asking again with any request_id is safe). If it was
 * typed, the 504 says typed:true + seq and the site stays reserved for its answer
 * for a late window (min(timeout_ms, LATE_WINDOW_MAX_MS)); a retry with the SAME
 * request_id collects it, a different request_id gets 409 SITE_BUSY saying so.
 * Every 200 carries seq (the [MSG #] its prompt was typed as) and reply_to (the
 * [MSG #] the captured reply answers) — they are always equal.
 *
 * HTTP hardening (BF-09): only Host 127.0.0.1 / localhost / [::1] (with this
 * bridge's port) is served (DNS rebinding); the key is checked from the headers
 * before any body is read; bodies have size and time limits; /v1/pair needs a
 * JSON Content-Type and no Origin header, so a web page can neither pair nor
 * trip the pairing lockout with a "simple" cross-site POST (a JSON POST needs a
 * CORS preflight, which this server never grants).
 *
 * Logging: only site, request_id, chars, outcome/status and elapsed_ms are ever
 * logged — never prompt/reply text and never the token.
 *
 * Activity (for the desktop panel): status() also reports lastContactAt (any
 * authenticated request), lastExternalContactAt (same, minus the app's own
 * link test), counters, the request in flight per site, each site's last
 * result, and a ring buffer of the most recent EVENT_RING_SIZE events. An event
 * is ONLY { kind, site, request_id, outcome, elapsed_ms, http_status, at,
 * selftest } — never prompt/reply text and never a presented or real key. The
 * app's own link test marks itself with the header `X-AutoInjector-Selftest: 1`
 * (health checks) and request_ids starting with "selftest-" (completions), so
 * it never counts as "BookForge connected".
 *
 * Contract v1.1 (backward compatible) adds:
 *   POST /v1/pair    (NO Authorization) — trade a one-time pairing code made by
 *                    createPairingCode() for the connection key. 12 chars
 *                    [A-Za-z0-9], valid PAIR_CODE_TTL_MS, single use; a new code
 *                    invalidates older unused ones; constant-time compare; after
 *                    PAIR_MAX_FAILS failures in PAIR_WINDOW_MS every pair attempt
 *                    gets 429 for PAIR_LOCK_MS. Codes and the key are never logged
 *                    or recorded — only the outcome.
 *   POST /v1/status  (Bearer) — BookForge reports what it is doing (current
 *                    sub-module step, approvals, book checklist). The body is
 *                    whitelisted and capped (sanitizeBookforgeStatus); the latest
 *                    one is kept and exposed as status().bookforge (stale after
 *                    BF_STATUS_STALE_MS). Its content never goes to the activity
 *                    ring — only a "status received" event.
 *
 * timeScale (default 1) multiplies every real wait (request timeout and the
 * post-504 late window). It exists only so tests / the fake host can exercise
 * timeout behaviour quickly; validation of timeout_ms still uses the contract's
 * 10000..900000 range.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BRIDGE_VERSION = '1.1';
const DEFAULT_PORT = 17891;
const DEFAULT_SITES = ['chatgpt', 'claude', 'gemini'];
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB (413 above this)
const HARD_DRAIN_CAP = 32 * 1024 * 1024; // past this we stop draining an oversized body and drop the socket
const CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 240000;
const MIN_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 900000;
// The late window after a 504 for a prompt that WAS typed: the site stays
// reserved for its answer for min(timeout_ms, this). BookForge's busy-retry
// budget (jobs.DEFAULT_RETRY max_total_s = 600 s) is twice this, so a request
// refused with 409 meanwhile still gets its turn.
const LATE_WINDOW_MAX_MS = 5 * 60 * 1000;
const BODY_TIME_LIMIT_MS = 30000; // a request body must arrive within this
const STOP_FLUSH_MS = 2000; // stop(): how long answers already given may take to go out before connections are dropped
const MAX_PAIR_BODY_BYTES = 4096;
const HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/i;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const TOKEN_FILE = 'bookforge-bridge-token';
const EVENT_RING_SIZE = 50;
const RECONNECT_GAP_MS = 5 * 60 * 1000; // silence longer than this, then a request = a new "connected" event
const SELFTEST_ID_PREFIX = 'selftest-';
// --- contract v1.1: pairing + BookForge status ---
const PAIR_CODE_LEN = 12;
const PAIR_CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const PAIR_CODE_TTL_MS = 120 * 1000;
const PAIR_MAX_FAILS = 10;
const PAIR_WINDOW_MS = 60 * 1000;
const PAIR_LOCK_MS = 60 * 1000;
const MAX_STATUS_BYTES = 32 * 1024; // POST /v1/status bodies over this -> 413
const BF_STATUS_STALE_MS = 90 * 1000;
// outcome -> the HTTP status BookForge saw (or would see) for it.
const OUTCOME_HTTP = {
  OK: 200, CACHED: 200, LATE_REPLY_STORED: 200, TIMEOUT: 504, LATE_EXPIRED: 504,
  SITE_NOT_READY: 503, SEND_FAILED: 502, TOO_LARGE: 413, SITE_BUSY: 409,
  BAD_REQUEST: 400, UNKNOWN_SITE: 404, NOT_FOUND: 404, UNAUTHORIZED: 401,
  PAIRED: 200, PAIRING_CODE_INVALID: 401, PAIRING_CODE_EXPIRED: 410, TOO_MANY_ATTEMPTS: 429, NOT_READY: 503
};
const EVENT_FIELDS = ['site', 'request_id', 'outcome', 'elapsed_ms', 'http_status', 'port', 'error'];

// --- envelope helpers ---------------------------------------------------------
// Mirrors main.js's withEnvelope() text; main.js passes its own wrapper anyway.
function defaultWrapPrompt(site, text) {
  const tag = String(site || '').toUpperCase() || 'YOU';
  return String(text == null ? '' : text) +
    `\n\n[Reply envelope required: start with [TO: USER] and end with [FROM: ${tag}] — the closing tag is how this app knows your reply is complete; without it your reply is not received.]`;
}
const LEADING_TO_RE = /^\s*\[\s*TO:\s*[^\]\r\n]{1,40}\]\s*/i;
const END_TAG_RE = /\[\s*FROM:\s*([^\]\r\n]{1,40}?)\s*\]/gi;
// Strip a leading [TO: X] and the closing [FROM: X] (same "last tag with a short
// tail" rule main.js uses). main.js already hands us stripped text; this is a
// safety net so the HTTP reply never carries envelope markers.
function stripEnvelope(text) {
  let s = String(text == null ? '' : text).replace(LEADING_TO_RE, '');
  let last = null, m;
  END_TAG_RE.lastIndex = 0;
  while ((m = END_TAG_RE.exec(s))) last = m;
  if (last) {
    const tail = s.slice(last.index + last[0].length);
    if (tail.length <= 40 && !/\n\s*\n/.test(tail)) s = s.slice(0, last.index);
  }
  return s.replace(/\s+$/, '').replace(/^\s+/, '');
}

// --- token helpers (file in the app's userData dir, mode 0600) -----------------
function generateToken() {
  return crypto.randomBytes(32).toString('base64url'); // 43 URL-safe chars, 32 bytes of entropy
}
function tokenPath(dir) { return path.join(dir, TOKEN_FILE); }
function readToken(dir) {
  try {
    const t = fs.readFileSync(tokenPath(dir), 'utf8').trim();
    return t.length >= 24 ? t : '';
  } catch (_) { return ''; }
}
// Atomic write: temp file created with mode 0600, then renamed over the real
// path. chmod afterwards as well (umask can't widen 0600, but an older file
// might have looser bits). On Windows chmod is effectively a no-op; the file
// then relies on the per-user ACLs of the userData directory.
function writeToken(dir, token) {
  fs.mkdirSync(dir, { recursive: true });
  const target = tokenPath(dir);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, token, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch (_) {}
  fs.renameSync(tmp, target);
  try { fs.chmodSync(target, 0o600); } catch (_) {}
  return token;
}
function loadOrCreateToken(dir) {
  return readToken(dir) || writeToken(dir, generateToken());
}
function regenerateToken(dir) { return writeToken(dir, generateToken()); }

// --- contract v1.1 helpers ------------------------------------------------------
function generatePairingCode() {
  let c = '';
  for (let i = 0; i < PAIR_CODE_LEN; i++) c += PAIR_CODE_ALPHABET[crypto.randomInt(PAIR_CODE_ALPHABET.length)];
  return c;
}
// Constant-time string compare over fixed-length digests.
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const y = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(x, y) && String(a).length === String(b).length;
}

// Sanitize a POST /v1/status body from BookForge. Whitelists fields, caps string
// lengths and array sizes, and keeps only loopback http URLs. Returns
// { ok: true, value } or { ok: false, message }.
const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
function capStr(v, max) {
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string') return null;
  const s = v.replace(CTRL_RE, '').trim();
  return s ? s.slice(0, max) : null;
}
function loopbackUrl(v) {
  if (typeof v !== 'string' || v.length > 2000) return null;
  let u;
  try { u = new URL(v.trim()); } catch (_) { return null; }
  if (u.protocol !== 'http:' || (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost')) return null;
  if (u.username || u.password) return null;
  return u.href.slice(0, 1000);
}
function capInt(v, max) {
  const n = Number(v);
  if (typeof v === 'boolean' || v === null || v === '' || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(max, Math.floor(n)));
}
// ISO 8601 string, or Unix epoch in seconds or milliseconds -> epoch ms (or null).
function toEpochMs(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.round(v < 1e12 ? v * 1000 : v);
  if (typeof v === 'string' && v.length <= 64) { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
}
function sanitizeBookforgeStatus(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, message: 'body must be a JSON object' };
  if (body.app !== 'bookforge') return { ok: false, message: 'app must be "bookforge"' };
  const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : null);
  const out = { app: 'bookforge', version: capInt(body.version, 1000000), bookforge_url: loopbackUrl(body.bookforge_url) };
  const p = obj(body.project);
  out.project = p ? { id: capStr(p.id, 100), title: capStr(p.title, 200) } : null;
  const ct = obj(body.current_task);
  out.current_task = ct ? {
    set: capStr(ct.set, 20), op: capStr(ct.op, 40), title: capStr(ct.title, 200),
    state: capStr(ct.state, 40), message: capStr(ct.message, 500), url: loopbackUrl(ct.url)
  } : null;
  const w = obj(body.working_on);
  out.working_on = w ? { op: capStr(w.op, 40), title: capStr(w.title, 200), started_at: toEpochMs(w.started_at) } : null;
  const ap = obj(body.approvals);
  if (ap) {
    const items = (Array.isArray(ap.items) ? ap.items : []).slice(0, 20).map(obj).filter(Boolean)
      .map((i) => ({ op: capStr(i.op, 40), set: capStr(i.set, 20), title: capStr(i.title, 200) }));
    const count = capInt(ap.count, 100000);
    out.approvals = { count: count == null ? items.length : count, items, url: loopbackUrl(ap.url) };
  } else out.approvals = null;
  out.checklist = (Array.isArray(body.checklist) ? body.checklist : []).slice(0, 40).map(obj).filter(Boolean)
    .map((c) => ({ id: capStr(c.id, 60), title: capStr(c.title, 200), set: capStr(c.set, 20), state: capStr(c.state, 40) }));
  out.done = capInt(body.done, 100000);
  out.total = capInt(body.total, 100000);
  out.updated_at = toEpochMs(body.updated_at);
  return { ok: true, value: out };
}

// --- the bridge ---------------------------------------------------------------
function createBridge(opts) {
  const o = opts || {};
  const host = o.host || '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) throw new Error(`bookforge-bridge: refusing to bind non-loopback host ${host}`);
  const port = o.port == null ? DEFAULT_PORT : Number(o.port);
  const getToken = typeof o.getToken === 'function' ? o.getToken : () => '';
  const sendToSite = o.sendToSite;
  const siteReady = typeof o.siteReady === 'function' ? o.siteReady : () => true;
  const siteProblem = typeof o.siteProblem === 'function' ? o.siteProblem : () => null;
  const wrapPrompt = typeof o.wrapPrompt === 'function' ? o.wrapPrompt : defaultWrapPrompt;
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const sites = Array.isArray(o.sites) && o.sites.length ? o.sites.slice() : DEFAULT_SITES.slice();
  const timeScale = Number(o.timeScale) > 0 ? Number(o.timeScale) : 1;
  const bodyTimeLimitMs = Number(o.bodyTimeLimitMs) > 0 ? Number(o.bodyTimeLimitMs) : BODY_TIME_LIMIT_MS;
  if (typeof sendToSite !== 'function') throw new Error('bookforge-bridge: sendToSite is required');

  // --- activity: counters, last contact, per-site last result, event ring ----
  // Text-free by construction: recordEvent() copies only whitelisted scalar
  // fields (EVENT_FIELDS), so no caller can leak prompt/reply text or a key.
  const events = [];
  const counters = { requests: 0, answered: 0, timeouts: 0, failed: 0, busy: 0, rejected: 0, unauthorized: 0, health_checks: 0, pair_attempts: 0, status_updates: 0 };
  const siteLast = {};
  let lastContactAt = null;
  let lastExternalContactAt = null;
  function recordEvent(kind, fields) {
    const f = fields || {};
    const ev = { kind: String(kind), at: now() };
    for (const k of EVENT_FIELDS) {
      const v = f[k];
      if (v === undefined || v === null) continue;
      if (typeof v === 'number' && Number.isFinite(v)) ev[k] = v;
      else if (typeof v === 'string') ev[k] = v.slice(0, 128);
    }
    if (ev.outcome && ev.http_status == null && OUTCOME_HTTP[ev.outcome]) ev.http_status = OUTCOME_HTTP[ev.outcome];
    const selftest = f.selftest === true || (typeof ev.request_id === 'string' && ev.request_id.startsWith(SELFTEST_ID_PREFIX));
    if (selftest) ev.selftest = true;
    events.push(ev);
    if (events.length > EVENT_RING_SIZE) events.shift();
    if (ev.kind === 'outcome' && ev.site && sites.includes(ev.site) && ev.outcome !== 'CACHED') {
      siteLast[ev.site] = { outcome: ev.outcome, http_status: ev.http_status, elapsed_ms: ev.elapsed_ms, request_id: ev.request_id, at: ev.at, selftest: !!ev.selftest };
    }
    if (typeof o.onEvent === 'function') { try { o.onEvent(Object.assign({}, ev)); } catch (_) {} }
    return ev;
  }
  function countOutcome(outcome) {
    if (outcome === 'OK' || outcome === 'LATE_REPLY_STORED') counters.answered++;
    else if (outcome === 'TIMEOUT') counters.timeouts++;
    else if (outcome === 'SEND_FAILED' || outcome === 'SITE_NOT_READY') counters.failed++;
    else if (outcome === 'SITE_BUSY') counters.busy++;
    else if (outcome === 'BAD_REQUEST' || outcome === 'TOO_LARGE' || outcome === 'UNKNOWN_SITE' || outcome === 'NOT_FOUND') counters.rejected++;
  }
  // Called for every authenticated request.
  function noteContact(selftest) {
    const t = now();
    lastContactAt = t;
    if (selftest) return;
    const gap = lastExternalContactAt == null || t - lastExternalContactAt > RECONNECT_GAP_MS;
    lastExternalContactAt = t;
    if (gap) recordEvent('connected', {});
  }

  // --- pairing (contract v1.1) ---------------------------------------------------
  // Only ONE code is live at a time. The code itself is never logged/recorded.
  let pairing = null; // { code, createdAt, expiresAt, used }
  let lastPairedAt = null;
  let lastPairResult = null; // outcome string only
  const pairFails = []; // timestamps of failed pair attempts (rolling PAIR_WINDOW_MS)
  let pairLockedUntil = 0;
  function createPairingCode() {
    const code = generatePairingCode();
    const t = now();
    pairing = { code, createdAt: t, expiresAt: t + PAIR_CODE_TTL_MS, used: false };
    recordEvent('pair_code', {});
    return code;
  }
  function pairingStatus() {
    const t = now();
    return {
      pending: !!(pairing && !pairing.used && pairing.expiresAt > t),
      createdAt: pairing ? pairing.createdAt : null,
      expiresAt: pairing ? pairing.expiresAt : null,
      lastPairedAt, lastResult: lastPairResult,
      locked: pairLockedUntil > t
    };
  }
  // --- latest status from BookForge (contract v1.1) ------------------------------
  let bfStatus = null; // { data, receivedAt }
  let bfStatusEventAt = 0;
  function bookforgeStatus() {
    if (!bfStatus) return null;
    const t = now();
    const age = Math.max(0, t - bfStatus.receivedAt);
    return Object.assign(JSON.parse(JSON.stringify(bfStatus.data)), { receivedAt: bfStatus.receivedAt, age_ms: age, stale: age > BF_STATUS_STALE_MS });
  }

  function log(kind, detail) {
    // Mirror the request lifecycle into the activity ring (text-free).
    if (detail && (kind === 'request' || kind === 'outcome' || kind === 'join')) {
      if (kind === 'request') counters.requests++;
      if (kind === 'outcome') countOutcome(detail.outcome);
      recordEvent(kind, detail);
    } else if (kind === 'listening' || kind === 'stopped') recordEvent(kind, detail || {});
    if (typeof o.logger !== 'function') return;
    try { o.logger(kind, detail); } catch (_) {}
  }

  // site -> in-flight entry (busy). request_id -> in-flight entry.
  const active = new Map();
  const inflight = new Map();
  // request_id -> { site, body, expiresAt } for completed 200s.
  const cache = new Map();
  let server = null;
  let listeningPort = null;
  let lastError = null;
  const openResponses = new Set(); // HTTP responses not yet written (L2)

  function pruneCache() {
    const t = now();
    for (const [id, c] of cache) if (c.expiresAt <= t) cache.delete(id);
  }

  function errBody(error, message, ambiguous) {
    return { ok: false, error, message, ambiguous: !!ambiguous };
  }

  function finish(entry, outcome) {
    if (entry.done) return;
    entry.done = true;
    clearTimeout(entry.lateTimer);
    if (active.get(entry.site) === entry) active.delete(entry.site);
    if (inflight.get(entry.requestId) === entry) inflight.delete(entry.requestId);
    if (outcome.status === 200) cache.set(entry.requestId, { site: entry.site, body: outcome.body, expiresAt: now() + CACHE_TTL_MS });
    entry.resolve(outcome);
  }

  // Start a new bridge request. Returns the entry; entry.outcome resolves with
  // { status, body } once the reply is captured or the send fails/aborts.
  // phase: 'sending' (queued / waiting for the AI, not typed yet) -> 'waiting'
  // (typed as [MSG #seq], answer due) -> 'late' (timed out, answer still due).
  function begin(site, prompt, requestId) {
    let resolve;
    const outcome = new Promise((r) => { resolve = r; });
    const cancelToken = { cancelled: false, typing: false };
    const entry = {
      site, requestId, startedAt: now(), seq: null, typed: false, typedAt: null, phase: 'sending',
      outcome, resolve, done: false, lateTimer: null, lateWindowMs: 0, promptChars: prompt.length,
      cancelToken, sendSettled: null
    };
    active.set(site, entry);
    inflight.set(requestId, entry);
    log('request', { site, request_id: requestId, chars: prompt.length });
    let sendPromise;
    try { sendPromise = Promise.resolve(sendToSite(site, wrapPrompt(site, prompt), { request_id: requestId, cancelToken })); }
    catch (e) { sendPromise = Promise.reject(e); }
    entry.sendSettled = sendPromise.then((r) => {
      if (r && r.ok) {
        if (entry.done) return; // stopped meanwhile
        entry.typed = true;
        entry.typedAt = now();
        if (r.seq != null) entry.seq = String(r.seq);
        if (entry.phase === 'sending') entry.phase = 'waiting';
        log('sent', { site, request_id: requestId, seq: entry.seq });
        return;
      }
      if (entry.done) return;
      const code = r && r.error ? String(r.error) : 'unknown';
      if (code === 'CANCELLED') return; // we withdrew it (timeout/stop); that path answers the request
      if (code === 'NO_VIEW' || code === 'SITE_NOT_READY') {
        log('outcome', { site, request_id: requestId, outcome: 'SITE_NOT_READY', elapsed_ms: now() - entry.startedAt });
        finish(entry, { status: 503, body: errBody('SITE_NOT_READY', `${site} pane is missing or not loaded`, false) });
      } else {
        log('outcome', { site, request_id: requestId, outcome: 'SEND_FAILED', error: code.slice(0, 80), elapsed_ms: now() - entry.startedAt });
        finish(entry, { status: 502, body: errBody('SEND_FAILED', `the prompt could not be delivered to the ${site} pane (${code.slice(0, 80)})`, false) });
      }
    }, (e) => {
      if (entry.done) return;
      log('outcome', { site, request_id: requestId, outcome: 'SEND_FAILED', error: 'exception', elapsed_ms: now() - entry.startedAt });
      finish(entry, { status: 502, body: errBody('SEND_FAILED', `the prompt could not be delivered to the ${site} pane`, false) });
      void e;
    });
    return entry;
  }

  function lateSeconds(entry) { return Math.max(1, Math.round(entry.lateWindowMs / 1000)); }

  // The request's time is up. Not typed yet: withdraw the queued send (wait for
  // an attempt that is typing right now to end), free the site, 504 typed:false.
  // Typed: start the late window (once) and answer 504 typed:true. Returns the
  // 504 for the typed case; null when entry.outcome carries the answer.
  async function expire(entry, timeoutMs) {
    if (entry.done) return null;
    if (!entry.typed) {
      entry.cancelToken.cancelled = true;
      if (entry.cancelToken.typing && entry.sendSettled) { try { await entry.sendSettled; } catch (_) {} }
      if (entry.done) return null;
      if (!entry.typed) {
        log('outcome', { site: entry.site, request_id: entry.requestId, outcome: 'TIMEOUT', error: 'not typed', elapsed_ms: now() - entry.startedAt });
        finish(entry, { status: 504, body: Object.assign(errBody('TIMEOUT',
          `${entry.site} was still busy, so the prompt was never typed; it was withdrawn and nothing is pending — asking again is safe`, false),
          { typed: false, seq: null }) });
        return null;
      }
    }
    if (entry.phase !== 'late') {
      entry.phase = 'late';
      entry.lateWindowMs = Math.min(timeoutMs, LATE_WINDOW_MAX_MS);
      entry.lateTimer = setTimeout(() => {
        if (entry.done) return;
        log('outcome', { site: entry.site, request_id: entry.requestId, outcome: 'LATE_EXPIRED', elapsed_ms: now() - entry.startedAt });
        finish(entry, { status: 504, body: Object.assign(errBody('TIMEOUT',
          `the prompt was typed into ${entry.site} as [MSG #${entry.seq}], but no answer to it was captured, even after another ${lateSeconds(entry)} s; ${entry.site} is free again`, true),
          { typed: true, seq: entry.seq, late_expired: true }) });
      }, Math.max(1, Math.round(entry.lateWindowMs * timeScale)));
    }
    log('outcome', { site: entry.site, request_id: entry.requestId, outcome: 'TIMEOUT', elapsed_ms: now() - entry.startedAt });
    return { status: 504, body: Object.assign(errBody('TIMEOUT',
      `the prompt was typed into ${entry.site} as [MSG #${entry.seq}], but its answer was not captured within ${timeoutMs} ms; it may still arrive — ask again with the same request_id within ${lateSeconds(entry)} s to collect it`, true),
      { typed: true, seq: entry.seq, late_window_ms: entry.lateWindowMs }) };
  }

  // Wait for an entry's outcome for at most timeoutMs (see expire()).
  function awaitEntry(entry, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        expire(entry, timeoutMs).then((out) => { if (out) resolve(out); }, () => {});
      }, Math.max(1, Math.round(timeoutMs * timeScale)));
      entry.outcome.then((out) => { clearTimeout(timer); resolve(out); });
    });
  }

  // BF-01: own a captured reply only if it answers THIS request's typed prompt.
  function onCaptured(turn) {
    if (!turn || typeof turn.site !== 'string') return false;
    const entry = active.get(turn.site);
    if (!entry || entry.done || !entry.typed) return false; // nothing typed yet: it can't be our answer
    if (Array.isArray(turn.answers)) {
      if (entry.seq == null || !turn.answers.map(String).includes(entry.seq)) return false;
    } else if (typeof turn.ts === 'number' && entry.typedAt != null && turn.ts < entry.typedAt) return false;
    const text = stripEnvelope(turn.text);
    const elapsed = now() - entry.startedAt;
    const body = { ok: true, site: entry.site, request_id: entry.requestId, text, seq: entry.seq, reply_to: entry.seq, elapsed_ms: elapsed };
    log('outcome', { site: entry.site, request_id: entry.requestId, outcome: entry.phase === 'late' ? 'LATE_REPLY_STORED' : 'OK', chars: text.length, elapsed_ms: elapsed });
    finish(entry, { status: 200, body });
    return true;
  }

  // A typed bridge prompt on this site is waiting for its answer.
  function awaitingReply(site) {
    const entry = active.get(site);
    return !!(entry && !entry.done && entry.typed);
  }

  function siteStatus() {
    const out = {};
    for (const s of sites) {
      let ready = false;
      try { ready = !!siteReady(s); } catch (_) { ready = false; }
      out[s] = { ready, busy: active.has(s) };
    }
    return out;
  }

  function activeRequests() {
    const out = {};
    const t = now();
    for (const [s, e] of active) {
      if (e.done) continue;
      out[s] = { request_id: e.requestId, started_at: e.startedAt, elapsed_ms: t - e.startedAt, phase: e.phase, typed: e.typed, seq: e.seq, selftest: e.requestId.startsWith(SELFTEST_ID_PREFIX) };
    }
    return out;
  }

  function status() {
    return {
      listening: !!server && listeningPort != null, host, port: listeningPort != null ? listeningPort : port, error: lastError, bridge_version: BRIDGE_VERSION, sites: siteStatus(),
      now: now(),
      lastContactAt, lastExternalContactAt,
      counters: Object.assign({}, counters),
      active: activeRequests(),
      siteLast: JSON.parse(JSON.stringify(siteLast)),
      events: events.map((e) => Object.assign({}, e)),
      pairing: pairingStatus(),
      bookforge: bookforgeStatus()
    };
  }

  function authorized(req) {
    const token = String(getToken() || '');
    const h = req.headers['authorization'];
    if (!token || typeof h !== 'string') return false;
    const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
    if (!m) return false;
    // Constant-time compare over fixed-length digests (timingSafeEqual needs equal lengths).
    const a = crypto.createHash('sha256').update(m[1], 'utf8').digest();
    const b = crypto.createHash('sha256').update(token, 'utf8').digest();
    return crypto.timingSafeEqual(a, b) && m[1].length === token.length;
  }

  function send(res, status, body) {
    if (res.headersSent || res.writableEnded) return;
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
    res.end(data);
  }

  // A request refused before it reached a pane (400/404/409): record it too.
  function refuse(res, status, code, message, site, requestId) {
    countOutcome(code);
    recordEvent('outcome', { site: typeof site === 'string' && sites.includes(site) ? site : undefined, request_id: typeof requestId === 'string' && REQUEST_ID_RE.test(requestId) ? requestId : undefined, outcome: code, http_status: status });
    return send(res, status, errBody(code, message, false));
  }

  // POST /v1/pair — no Authorization. Never logs or records the code or the key.
  function handlePair(raw, res, tooLarge) {
    const t = now();
    counters.pair_attempts++;
    const outcome = (status, code, body) => {
      lastPairResult = code;
      if (status !== 200) {
        if (code !== 'TOO_MANY_ATTEMPTS' && code !== 'NOT_READY') {
          pairFails.push(t);
          while (pairFails.length && t - pairFails[0] > PAIR_WINDOW_MS) pairFails.shift();
          if (pairFails.length >= PAIR_MAX_FAILS) { pairLockedUntil = t + PAIR_LOCK_MS; pairFails.length = 0; }
        }
      }
      recordEvent('pair', { outcome: code, http_status: status });
      if (typeof o.logger === 'function') { try { o.logger('pair', { outcome: code, http_status: status }); } catch (_) {} }
      return send(res, status, body);
    };
    if (pairLockedUntil > t) return outcome(429, 'TOO_MANY_ATTEMPTS', errBody('TOO_MANY_ATTEMPTS', 'too many wrong pairing codes; wait a minute and try again', false));
    if (tooLarge) return outcome(400, 'BAD_REQUEST', errBody('BAD_REQUEST', 'body too large', false));
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch (_) { body = undefined; }
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.code !== 'string' || !body.code || body.code.length > 128 ||
        (body.client !== undefined && typeof body.client !== 'string')) {
      return outcome(400, 'BAD_REQUEST', errBody('BAD_REQUEST', 'body must be {"code": "<pairing code>", "client": "bookforge"}', false));
    }
    const p = pairing;
    if (!p || p.used || !safeEqual(body.code, p.code)) return outcome(401, 'PAIRING_CODE_INVALID', errBody('PAIRING_CODE_INVALID', 'that pairing code is unknown or was already used', false));
    if (p.expiresAt <= t) return outcome(410, 'PAIRING_CODE_EXPIRED', errBody('PAIRING_CODE_EXPIRED', 'that pairing code has expired; press Connect again in AutoInjector', false));
    const token = String(getToken() || '');
    if (!token) return outcome(503, 'NOT_READY', errBody('NOT_READY', 'the bridge has no connection key yet', false));
    p.used = true;
    lastPairedAt = t;
    return outcome(200, 'PAIRED', { ok: true, token, bridge_version: BRIDGE_VERSION });
  }

  // POST /v1/status — BookForge's progress report (Bearer). Content never logged.
  function handleStatus(raw, res, size) {
    if (size > MAX_STATUS_BYTES) return send(res, 413, errBody('TOO_LARGE', `status body is over ${MAX_STATUS_BYTES} bytes`, false));
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch (_) { return send(res, 400, errBody('BAD_REQUEST', 'body must be JSON', false)); }
    const r = sanitizeBookforgeStatus(body);
    if (!r.ok) return send(res, 400, errBody('BAD_REQUEST', r.message, false));
    const t = now();
    const firstAfterGap = !bfStatus || t - bfStatus.receivedAt > BF_STATUS_STALE_MS || (lastPairedAt != null && bfStatusEventAt < lastPairedAt);
    bfStatus = { data: r.value, receivedAt: t };
    counters.status_updates++;
    // Only "status received" (no content), and only on the first one / after a gap / after pairing.
    if (firstAfterGap) { bfStatusEventAt = t; recordEvent('status', {}); }
    return send(res, 200, { ok: true });
  }

  async function handleComplete(raw, res) {
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch (_) {
      return refuse(res, 400, 'BAD_REQUEST', 'body must be JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse(res, 400, 'BAD_REQUEST', 'body must be a JSON object');
    const { site, prompt, request_id: requestId } = body;
    if (typeof site !== 'string' || !site) return refuse(res, 400, 'BAD_REQUEST', 'site is required', site, requestId);
    if (typeof prompt !== 'string' || !prompt.trim()) return refuse(res, 400, 'BAD_REQUEST', 'prompt must be a non-empty string', site, requestId);
    if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) return refuse(res, 400, 'BAD_REQUEST', 'request_id must be 1..128 chars of [A-Za-z0-9._:-]', site);
    let timeoutMs = DEFAULT_TIMEOUT_MS;
    if (body.timeout_ms !== undefined) {
      if (!Number.isInteger(body.timeout_ms) || body.timeout_ms < MIN_TIMEOUT_MS || body.timeout_ms > MAX_TIMEOUT_MS) {
        return refuse(res, 400, 'BAD_REQUEST', `timeout_ms must be an integer ${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS}`, site, requestId);
      }
      timeoutMs = body.timeout_ms;
    }
    if (!sites.includes(site)) return refuse(res, 404, 'UNKNOWN_SITE', `unknown site; expected one of ${sites.join('|')}`, undefined, requestId);

    pruneCache();
    const cached = cache.get(requestId);
    if (cached) {
      if (cached.site !== site) return refuse(res, 400, 'BAD_REQUEST', 'request_id was already used for a different site', site, requestId);
      log('outcome', { site, request_id: requestId, outcome: 'CACHED' });
      return send(res, 200, cached.body);
    }
    const existing = inflight.get(requestId);
    if (existing && !existing.done) {
      if (existing.site !== site) return refuse(res, 400, 'BAD_REQUEST', 'request_id is in flight for a different site', site, requestId);
      log('join', { site, request_id: requestId });
      const out = await awaitEntry(existing, timeoutMs);
      return send(res, out.status, out.body);
    }
    const busy = active.get(site);
    if (busy && !busy.done) {
      const why = busy.phase === 'late'
        ? `${site} is still reserved for the answer to an earlier BookForge prompt (request ${busy.requestId}, typed as [MSG #${busy.seq}], which timed out); ask again with that request_id to collect it — ${site} is free again when it arrives or within ${lateSeconds(busy)} s`
        : busy.typed
          ? `${site} is answering another bridge request (request ${busy.requestId}, typed as [MSG #${busy.seq}])`
          : `another bridge request for ${site} (request ${busy.requestId}) is waiting to be typed`;
      return refuse(res, 409, 'SITE_BUSY', why, site, requestId);
    }
    let ready = false;
    try { ready = !!siteReady(site); } catch (_) { ready = false; }
    if (!ready) {
      log('outcome', { site, request_id: requestId, outcome: 'SITE_NOT_READY' });
      let why = null;
      try { why = siteProblem(site); } catch (_) { why = null; }
      return send(res, 503, errBody('SITE_NOT_READY', why ? `${site} isn't ready: ${String(why).slice(0, 200)}` : `${site} pane is missing or not loaded`, false));
    }
    const entry = begin(site, prompt, requestId);
    const out = await awaitEntry(entry, timeoutMs);
    return send(res, out.status, out.body);
  }

  // Close the connection after an early answer (the unread body is discarded).
  function sendAndClose(res, status, body) {
    if (res.headersSent || res.writableEnded) return;
    res.setHeader('Connection', 'close');
    send(res, status, body);
  }

  // BF-09: a page on another site that resolves its own name to 127.0.0.1 (DNS
  // rebinding) sends its own name as Host — only loopback names are served.
  function hostAllowed(req) {
    const m = HOST_RE.exec(String(req.headers.host || '').trim());
    if (!m) return false;
    return !m[1] || listeningPort == null || Number(m[1]) === listeningPort;
  }

  function contentTypeIsJson(req) {
    return /^application\/json\s*(?:;|$)/i.test(String(req.headers['content-type'] || '').trim());
  }

  // Read the body: at most `limit` bytes, within BODY_TIME_LIMIT_MS. Calls
  // done(buffer, size, tooLarge) once, or answers 408 itself.
  function readBody(req, res, limit, done) {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    let finished = false;
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) tooLarge = true;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      sendAndClose(res, 408, errBody('BAD_REQUEST', 'the request body did not arrive in time', false));
      setImmediate(() => { try { req.destroy(); } catch (_) {} });
    }, bodyTimeLimitMs);
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { tooLarge = true; chunks.length = 0; }
      else if (!tooLarge) chunks.push(c);
      if (size > HARD_DRAIN_CAP) { finished = true; clearTimeout(timer); req.destroy(); }
    });
    req.on('error', () => {});
    req.on('end', () => {
      clearTimeout(timer);
      if (finished) return;
      finished = true;
      done(Buffer.concat(chunks), size, tooLarge);
    });
  }

  function handle(req, res) {
    req.on('error', () => {});
    // L2: stop() lets these answers go out before it drops the connections.
    openResponses.add(res);
    const forget = () => openResponses.delete(res);
    res.once('finish', forget);
    res.once('close', forget);
    const url = String(req.url || '').split('?')[0];
    const fail = () => send(res, 500, errBody('INTERNAL', 'internal bridge error', false));
    if (!hostAllowed(req)) {
      recordEvent('forbidden_host', { http_status: 403 });
      return sendAndClose(res, 403, errBody('FORBIDDEN', 'this bridge only answers requests addressed to 127.0.0.1 or localhost', false));
    }
    // v1.1 pairing: the one endpoint that takes no Authorization header.
    if (url === '/v1/pair' && req.method === 'POST') {
      // A web page can POST here only as a "simple" request (no JSON Content-Type)
      // and always sends Origin: refused, and NOT counted toward the lockout.
      if (req.headers.origin !== undefined || !contentTypeIsJson(req)) {
        recordEvent('pair', { outcome: 'BAD_REQUEST', http_status: 403 });
        return sendAndClose(res, 403, errBody('FORBIDDEN', 'pairing requests must come from BookForge itself (JSON, no browser Origin)', false));
      }
      return readBody(req, res, MAX_PAIR_BODY_BYTES, (raw, size, tooLarge) => {
        Promise.resolve().then(() => handlePair(raw, res, tooLarge)).catch(fail);
      });
    }
    // The key is checked from the headers BEFORE any body is read.
    if (!authorized(req)) {
      // Never record the presented key — only that an attempt was refused.
      counters.unauthorized++;
      recordEvent('unauthorized', { http_status: 401, selftest: req.headers['x-autoinjector-selftest'] === '1' });
      return sendAndClose(res, 401, errBody('UNAUTHORIZED', 'missing or wrong bearer token', false));
    }
    noteContact(req.headers['x-autoinjector-selftest'] === '1');
    const limit = url === '/v1/status' ? MAX_STATUS_BYTES : MAX_BODY_BYTES;
    readBody(req, res, limit, (raw, size, tooLarge) => {
      Promise.resolve().then(async () => {
        if (url === '/v1/health' && req.method === 'GET') {
          counters.health_checks++;
          return send(res, 200, { ok: true, bridge_version: BRIDGE_VERSION, sites: siteStatus() });
        }
        if (url === '/v1/complete' && req.method === 'POST') {
          if (tooLarge) {
            log('outcome', { outcome: 'TOO_LARGE', chars: size });
            return send(res, 413, errBody('TOO_LARGE', 'request body is over 1 MiB', false));
          }
          return handleComplete(raw, res);
        }
        if (url === '/v1/status' && req.method === 'POST') {
          if (tooLarge) return send(res, 413, errBody('TOO_LARGE', `status body is over ${MAX_STATUS_BYTES} bytes`, false));
          return handleStatus(raw, res, size);
        }
        return refuse(res, 404, 'NOT_FOUND', 'no such endpoint');
      }).catch(fail);
    });
  }

  function start() {
    if (server) return Promise.resolve({ host, port: listeningPort });
    return new Promise((resolve, reject) => {
      const srv = http.createServer(handle);
      srv.requestTimeout = 0; // a /v1/complete may legitimately wait up to 15 min
      srv.headersTimeout = 30000;
      srv.keepAliveTimeout = 5000;
      srv.once('error', (e) => { lastError = e && e.code ? e.code : String(e); server = null; listeningPort = null; reject(e); });
      srv.listen(port, host, () => {
        server = srv;
        listeningPort = srv.address().port;
        lastError = null;
        srv.on('error', (e) => { lastError = e && e.code ? e.code : String(e); });
        log('listening', { host, port: listeningPort });
        resolve({ host, port: listeningPort });
      });
    });
  }

  function stop() {
    // Fail anything still waiting so no HTTP handler hangs, then close.
    for (const entry of Array.from(active.values())) {
      entry.cancelToken.cancelled = true; // a prompt not typed yet is withdrawn too
      finish(entry, { status: 503, body: Object.assign(errBody('SITE_NOT_READY', 'the bridge was stopped', false), { typed: entry.typed }) });
    }
    const srv = server;
    server = null;
    listeningPort = null;
    if (!srv) return Promise.resolve();
    // L2: stop listening now (and drop idle keep-alive sockets), but let the
    // answers just given above (503 "the bridge was stopped", with `typed`) be
    // written before any open connection is dropped — closing every connection
    // in this same tick reset them (ECONNRESET) instead. Anything still open
    // after STOP_FLUSH_MS (a client that stopped reading) is dropped anyway.
    return new Promise((resolve) => {
      srv.close(() => resolve());
      try { srv.closeIdleConnections(); } catch (_) {}
      log('stopped', {});
      const started = Date.now();
      const drop = () => {
        if (openResponses.size && Date.now() - started < STOP_FLUSH_MS) { setTimeout(drop, 10); return; }
        try { srv.closeAllConnections(); } catch (_) {}
      };
      setImmediate(drop);
    });
  }

  return { start, stop, onCaptured, awaitingReply, status, recordEvent, createPairingCode, bookforgeStatus, pairingStatus, address: () => (server ? server.address() : null) };
}

// --- plain-English activity lines (for the desktop panel + link-test report) ---
// Pure: turns one text-free activity event into a sentence a non-technical
// person understands, plus a tone (ok | warn | error | info) for styling.
function formatDuration(ms) {
  const s = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function describeEvent(ev, label) {
  const e = ev || {};
  const L = e.site ? (typeof label === 'function' ? label(e.site) : e.site) : 'the AI';
  const who = e.selftest ? 'The link test' : 'BookForge';
  const id = e.request_id ? ` (request ${e.request_id})` : '';
  const dur = formatDuration(e.elapsed_ms);
  switch (e.kind) {
    case 'connected': return { say: 'BookForge connected', tone: 'ok' };
    case 'request': return { say: `${who} asked ${L}${id}`, tone: 'info' };
    case 'join': return { say: `${who} checked back on a request that is still running for ${L}${id}`, tone: 'info' };
    case 'unauthorized': return e.selftest
      ? { say: 'The link test checked that a wrong connection key is refused', tone: 'info' }
      : { say: 'Something tried to connect with a wrong or missing connection key — it was refused', tone: 'warn' };
    case 'forbidden_host': return { say: 'Refused a request that was not addressed to 127.0.0.1/localhost (a web page may have tried to reach the bridge)', tone: 'warn' };
    case 'listening': return { say: `Bridge turned on — listening on 127.0.0.1:${e.port != null ? e.port : '?'}`, tone: 'ok' };
    case 'stopped': return { say: 'Bridge turned off', tone: 'info' };
    case 'key_changed': return { say: 'A new connection key was made — BookForge needs the new one before it can connect again', tone: 'warn' };
    case 'start_failed': return { say: `The bridge couldn't start (${e.error || 'unknown error'})`, tone: 'error' };
    case 'pair_code': return { say: 'Made a one-time pairing code and opened BookForge to connect', tone: 'info' };
    case 'status': return { say: 'BookForge sent an update on your book', tone: 'ok' };
    case 'pair': switch (e.outcome) {
      case 'PAIRED': return { say: 'BookForge picked up the connection key (paired)', tone: 'ok' };
      case 'PAIRING_CODE_EXPIRED': return { say: 'A pairing code was used too late (codes last 2 minutes) — press Connect again', tone: 'warn' };
      case 'TOO_MANY_ATTEMPTS': return { say: 'Too many wrong pairing codes — pairing is paused for a minute', tone: 'warn' };
      case 'PAIRING_CODE_INVALID': return { say: 'Something tried an unknown or already-used pairing code — it was refused', tone: 'warn' };
      default: return { say: `A pairing attempt was refused (${e.outcome || 'error'})`, tone: 'warn' };
    }
    case 'outcome': break;
    default: return { say: String(e.kind || 'event'), tone: 'info' };
  }
  switch (e.outcome) {
    case 'OK': return { say: `${L} answered in ${dur}${e.selftest ? ' (link test)' : ''}`, tone: 'ok' };
    case 'LATE_REPLY_STORED': return { say: `${L} answered late (after ${dur}) — saved so ${who} gets it if it asks again`, tone: 'warn' };
    case 'TIMEOUT': return { say: `${L} hadn't answered after ${dur} — timed out${e.selftest ? '' : '. BookForge will ask you before retrying'}`, tone: 'error' };
    case 'LATE_EXPIRED': return { say: `${L} never answered${id}; ${L} is free again`, tone: 'warn' };
    case 'CACHED': return { say: `${who} collected ${L}'s earlier answer again (nothing re-sent)`, tone: 'info' };
    case 'SITE_NOT_READY': return { say: `${L}'s window isn't loaded, so the request was turned away`, tone: 'error' };
    case 'SEND_FAILED': return { say: `Couldn't type the prompt into ${L}'s window`, tone: 'error' };
    case 'SITE_BUSY': return { say: `${L} was still busy with another request — ${who} was told to wait`, tone: 'warn' };
    case 'TOO_LARGE': return { say: 'Refused a request that was too big (over 1 MB)', tone: 'warn' };
    default: return { say: `Refused a request this app couldn't use (${e.outcome || 'error'})`, tone: 'warn' };
  }
}

module.exports = {
  createBridge,
  describeEvent,
  formatDuration,
  stripEnvelope,
  defaultWrapPrompt,
  generateToken,
  readToken,
  writeToken,
  loadOrCreateToken,
  regenerateToken,
  tokenPath,
  BRIDGE_VERSION,
  DEFAULT_PORT,
  MAX_BODY_BYTES,
  CACHE_TTL_MS,
  EVENT_RING_SIZE,
  SELFTEST_ID_PREFIX,
  sanitizeBookforgeStatus,
  generatePairingCode,
  PAIR_CODE_LEN,
  PAIR_CODE_TTL_MS,
  PAIR_MAX_FAILS,
  PAIR_LOCK_MS,
  MAX_STATUS_BYTES,
  BF_STATUS_STALE_MS,
  LATE_WINDOW_MAX_MS,
  BODY_TIME_LIMIT_MS
};
