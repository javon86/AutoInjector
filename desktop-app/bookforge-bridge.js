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
 *     sendToSite(site, text, meta)       -> Promise<{ ok, error?, seq? }>   (meta = { request_id })
 *     siteReady(site)                    -> bool   (pane exists and is loaded)
 *     wrapPrompt(site, text)?            -> text   (adds the [FROM: <SITE>] reply-envelope instruction)
 *     now()?, logger(kind, detail)?, sites?, timeScale?
 *   }) -> { start(), stop(), onCaptured(turn) -> bool, status() }
 *
 * onCaptured(turn) is called by main.js for every captured reply ({ site, text }).
 * It returns true when the reply belonged to a bridge request (main.js must then
 * skip ALL relay handling for it) and false otherwise.
 *
 * Logging: only site, request_id, chars, outcome/status and elapsed_ms are ever
 * logged — never prompt/reply text and never the token.
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

const BRIDGE_VERSION = '1';
const DEFAULT_PORT = 17891;
const DEFAULT_SITES = ['chatgpt', 'claude', 'gemini'];
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB (413 above this)
const HARD_DRAIN_CAP = 32 * 1024 * 1024; // past this we stop draining an oversized body and drop the socket
const CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 240000;
const MIN_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 900000;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const TOKEN_FILE = 'bookforge-bridge-token';

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

// --- the bridge ---------------------------------------------------------------
function createBridge(opts) {
  const o = opts || {};
  const host = o.host || '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) throw new Error(`bookforge-bridge: refusing to bind non-loopback host ${host}`);
  const port = o.port == null ? DEFAULT_PORT : Number(o.port);
  const getToken = typeof o.getToken === 'function' ? o.getToken : () => '';
  const sendToSite = o.sendToSite;
  const siteReady = typeof o.siteReady === 'function' ? o.siteReady : () => true;
  const wrapPrompt = typeof o.wrapPrompt === 'function' ? o.wrapPrompt : defaultWrapPrompt;
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const sites = Array.isArray(o.sites) && o.sites.length ? o.sites.slice() : DEFAULT_SITES.slice();
  const timeScale = Number(o.timeScale) > 0 ? Number(o.timeScale) : 1;
  if (typeof sendToSite !== 'function') throw new Error('bookforge-bridge: sendToSite is required');

  function log(kind, detail) {
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
  function begin(site, prompt, requestId) {
    let resolve;
    const outcome = new Promise((r) => { resolve = r; });
    const entry = {
      site, requestId, startedAt: now(), seq: null, phase: 'sending',
      outcome, resolve, done: false, lateTimer: null, promptChars: prompt.length
    };
    active.set(site, entry);
    inflight.set(requestId, entry);
    log('request', { site, request_id: requestId, chars: prompt.length });
    let sendPromise;
    try { sendPromise = Promise.resolve(sendToSite(site, wrapPrompt(site, prompt), { request_id: requestId })); }
    catch (e) { sendPromise = Promise.reject(e); }
    sendPromise.then((r) => {
      if (entry.done) return;
      if (r && r.ok) {
        if (r.seq != null) entry.seq = String(r.seq);
        if (entry.phase === 'sending') entry.phase = 'waiting';
        log('sent', { site, request_id: requestId, seq: entry.seq });
        return;
      }
      const code = r && r.error ? String(r.error) : 'unknown';
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

  // Wait for an entry's outcome for at most timeoutMs. On timeout the entry
  // enters its "late" window: the site stays busy until the reply is captured
  // (then cached under the request_id) or timeoutMs more passes.
  function awaitEntry(entry, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (entry.done) return;
        if (entry.phase !== 'late') {
          entry.phase = 'late';
          entry.lateTimer = setTimeout(() => {
            if (entry.done) return;
            log('outcome', { site: entry.site, request_id: entry.requestId, outcome: 'LATE_EXPIRED', elapsed_ms: now() - entry.startedAt });
            entry.done = true;
            if (active.get(entry.site) === entry) active.delete(entry.site);
            if (inflight.get(entry.requestId) === entry) inflight.delete(entry.requestId);
            entry.resolve({ status: 504, body: errBody('TIMEOUT', 'no reply was captured; the late-reply window has expired', true) });
          }, Math.max(1, Math.round(timeoutMs * timeScale)));
        }
        log('outcome', { site: entry.site, request_id: entry.requestId, outcome: 'TIMEOUT', elapsed_ms: now() - entry.startedAt });
        resolve({ status: 504, body: errBody('TIMEOUT', `sent, but no reply was captured from ${entry.site} within ${timeoutMs} ms; it may still arrive — retry with the same request_id to collect it`, true) });
      }, Math.max(1, Math.round(timeoutMs * timeScale)));
      entry.outcome.then((out) => { clearTimeout(timer); resolve(out); });
    });
  }

  function onCaptured(turn) {
    if (!turn || typeof turn.site !== 'string') return false;
    const entry = active.get(turn.site);
    if (!entry || entry.done) return false;
    const text = stripEnvelope(turn.text);
    const elapsed = now() - entry.startedAt;
    const body = { ok: true, site: entry.site, request_id: entry.requestId, text, seq: entry.seq, elapsed_ms: elapsed };
    log('outcome', { site: entry.site, request_id: entry.requestId, outcome: entry.phase === 'late' ? 'LATE_REPLY_STORED' : 'OK', chars: text.length, elapsed_ms: elapsed });
    finish(entry, { status: 200, body });
    return true;
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

  function status() {
    return { listening: !!server && listeningPort != null, host, port: listeningPort != null ? listeningPort : port, error: lastError, bridge_version: BRIDGE_VERSION, sites: siteStatus() };
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

  async function handleComplete(raw, res) {
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch (_) {
      return send(res, 400, errBody('BAD_REQUEST', 'body must be JSON', false));
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, errBody('BAD_REQUEST', 'body must be a JSON object', false));
    const { site, prompt, request_id: requestId } = body;
    if (typeof site !== 'string' || !site) return send(res, 400, errBody('BAD_REQUEST', 'site is required', false));
    if (typeof prompt !== 'string' || !prompt.trim()) return send(res, 400, errBody('BAD_REQUEST', 'prompt must be a non-empty string', false));
    if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) return send(res, 400, errBody('BAD_REQUEST', 'request_id must be 1..128 chars of [A-Za-z0-9._:-]', false));
    let timeoutMs = DEFAULT_TIMEOUT_MS;
    if (body.timeout_ms !== undefined) {
      if (!Number.isInteger(body.timeout_ms) || body.timeout_ms < MIN_TIMEOUT_MS || body.timeout_ms > MAX_TIMEOUT_MS) {
        return send(res, 400, errBody('BAD_REQUEST', `timeout_ms must be an integer ${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS}`, false));
      }
      timeoutMs = body.timeout_ms;
    }
    if (!sites.includes(site)) return send(res, 404, errBody('UNKNOWN_SITE', `unknown site; expected one of ${sites.join('|')}`, false));

    pruneCache();
    const cached = cache.get(requestId);
    if (cached) {
      if (cached.site !== site) return send(res, 400, errBody('BAD_REQUEST', 'request_id was already used for a different site', false));
      log('outcome', { site, request_id: requestId, outcome: 'CACHED' });
      return send(res, 200, cached.body);
    }
    const existing = inflight.get(requestId);
    if (existing && !existing.done) {
      if (existing.site !== site) return send(res, 400, errBody('BAD_REQUEST', 'request_id is in flight for a different site', false));
      log('join', { site, request_id: requestId });
      const out = await awaitEntry(existing, timeoutMs);
      return send(res, out.status, out.body);
    }
    const busy = active.get(site);
    if (busy && !busy.done) return send(res, 409, errBody('SITE_BUSY', `another bridge request is in flight for ${site}`, false));
    let ready = false;
    try { ready = !!siteReady(site); } catch (_) { ready = false; }
    if (!ready) {
      log('outcome', { site, request_id: requestId, outcome: 'SITE_NOT_READY' });
      return send(res, 503, errBody('SITE_NOT_READY', `${site} pane is missing or not loaded`, false));
    }
    const entry = begin(site, prompt, requestId);
    const out = await awaitEntry(entry, timeoutMs);
    return send(res, out.status, out.body);
  }

  function handle(req, res) {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) tooLarge = true;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { tooLarge = true; chunks.length = 0; }
      else if (!tooLarge) chunks.push(c);
      if (size > HARD_DRAIN_CAP) req.destroy();
    });
    req.on('error', () => {});
    req.on('end', () => {
      Promise.resolve().then(async () => {
        if (!authorized(req)) return send(res, 401, errBody('UNAUTHORIZED', 'missing or wrong bearer token', false));
        const url = String(req.url || '').split('?')[0];
        if (url === '/v1/health' && req.method === 'GET') {
          return send(res, 200, { ok: true, bridge_version: BRIDGE_VERSION, sites: siteStatus() });
        }
        if (url === '/v1/complete' && req.method === 'POST') {
          if (tooLarge) {
            log('outcome', { outcome: 'TOO_LARGE', chars: size });
            return send(res, 413, errBody('TOO_LARGE', 'request body is over 1 MiB', false));
          }
          return handleComplete(Buffer.concat(chunks), res);
        }
        return send(res, 404, errBody('NOT_FOUND', 'no such endpoint', false));
      }).catch(() => send(res, 500, errBody('INTERNAL', 'internal bridge error', false)));
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
      finish(entry, { status: 503, body: errBody('SITE_NOT_READY', 'the bridge was stopped', false) });
    }
    const srv = server;
    server = null;
    listeningPort = null;
    if (!srv) return Promise.resolve();
    return new Promise((resolve) => {
      srv.close(() => resolve());
      try { srv.closeAllConnections(); } catch (_) {}
      log('stopped', {});
    });
  }

  return { start, stop, onCaptured, status, address: () => (server ? server.address() : null) };
}

module.exports = {
  createBridge,
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
  CACHE_TTL_MS
};
