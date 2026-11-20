'use strict';
// phone-server.js — 📱 the phone app's own little web server (Node's http, no extra packages).
//
// Separate from the service bridge on purpose: the bridge can run code and tools for local programs and stays on
// this PC only (127.0.0.1). This server is the ONLY thing a phone on the Wi-Fi can reach, and it can only do the
// phone's few things (phone-core.js). It is off until you turn it on in the 📱 Phone window.
//
//   GET  /                         the phone app (a page; no key needed to load it — it carries the key itself)
//   GET  /phone-app.js, /phone-app.css, /manifest.webmanifest, /icon.svg
//   — everything below needs the pairing key (Authorization: Bearer <key>) —
//   GET  /api/state                AIs, the book card, alerts, Alfred on/off, the PC's name
//   GET  /api/chat                 the conversation with the AIs
//   POST /api/chat {text, to?}     send to the AIs (to: ["claude", …]; none = every AI that is on)
//   POST /api/stop                 ⏹ stop the AIs
//   POST /api/book/pause | /api/book/continue
//   POST /api/book/answer {action, confirm?}
//   GET  /api/book/chapters        the written chapters; GET /api/book/chapters/<n> one chapter's text
//   GET  /api/alfred · POST /api/alfred {text}
//   POST /api/alerts/seen {id|"all"}

const http = require('http');
const core = require('./phone-core');

const MAX_BODY = 32 * 1024;

function createPhoneServer(deps) {
  const d = deps || {};
  const now = d.now || (() => Date.now());
  const log = d.log || (() => {});
  const files = d.files || {}; // { '/': {type, body}, ... }
  const guard = core.createGuard();
  const phones = new Map(); // ip → { ip, agent, lastSeen }
  let server = null;
  let info = null;

  const SEC = {
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  };
  const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

  function send(res, code, body, headers) {
    const isBuf = Buffer.isBuffer(body);
    const data = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, SEC, headers || {}));
    res.end(data);
  }
  const fail = (res, code, error, words) => send(res, code, { ok: false, error, words });

  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      let over = false;
      req.on('data', (c) => { if (over) return; size += c.length; if (size > MAX_BODY) { over = true; resolve({ tooBig: true }); return; } chunks.push(c); });
      req.on('end', () => { if (over) return; const raw = Buffer.concat(chunks).toString('utf8'); if (!raw.trim()) { resolve({ body: {} }); return; } try { resolve({ body: JSON.parse(raw) }); } catch (_) { resolve({ bad: true }); } });
      req.on('error', () => resolve({ bad: true }));
    });
  }

  function ipOf(req) { return String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, ''); }

  // A page the phone app served posts back to the same host; a random website on the phone must not.
  // 🌍 Through Tailscale's secure link (`tailscale serve`) the page is https://<pc>.<tailnet>.ts.net and the request
  // arrives from Tailscale on this PC: that one name (this PC's own) is trusted too.
  function originOk(req) {
    const o = req.headers.origin;
    if (!o) return true;
    let u;
    try { u = new URL(o); } catch (_) { return false; }
    if (u.host === String(req.headers.host || '')) return true;
    let trusted = [];
    try { trusted = (d.trustedHosts && d.trustedHosts()) || []; } catch (_) { trusted = []; }
    return u.protocol === 'https:' && trusted.includes(u.hostname.toLowerCase());
  }

  async function api(req, res, path) {
    const ip = ipOf(req);
    const t = now();
    if (guard.blocked(ip, t)) return fail(res, 429, 'TOO_MANY_TRIES', 'Too many wrong keys — wait a minute.');
    const h = String(req.headers.authorization || '');
    const key = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!core.sameToken(key, d.token && d.token())) { guard.fail(ip, t); return fail(res, 401, 'NOT_PAIRED', 'This phone is not paired. Scan the code in AutoInjector\'s 📱 Phone window again.'); }
    guard.ok(ip);
    phones.set(ip, { ip, agent: String(req.headers['user-agent'] || '').slice(0, 160), lastSeen: t });
    if (req.method === 'POST' && !originOk(req)) return fail(res, 403, 'FOREIGN_PAGE', 'Only the phone app itself may do that.');
    let body = {};
    if (req.method === 'POST') {
      const b = await readBody(req);
      if (b.tooBig) return fail(res, 413, 'TOO_BIG', 'That is too long.');
      if (b.bad || !b.body || typeof b.body !== 'object' || Array.isArray(b.body)) return fail(res, 400, 'BAD_REQUEST', 'The phone sent something odd — reload the app.');
      body = b.body;
    }
    const call = async (fn, ...a) => { try { return await fn(...a); } catch (e) { log('phone-error', { path, error: String((e && e.message) || e).slice(0, 200) }); return { ok: false, error: 'PC_ERROR', words: 'The PC hit a problem doing that — try again.' }; } };
    const m = req.method;
    const out = (r) => send(res, 200, r == null ? { ok: false, error: 'PC_ERROR', words: 'No answer from the PC.' } : r);
    if (m === 'GET' && path === '/api/state') return out(await call(d.state));
    if (m === 'GET' && path === '/api/chat') return out(await call(d.chat));
    if (m === 'POST' && path === '/api/chat') {
      const text = String(body.text || '').trim();
      if (!text) return fail(res, 400, 'EMPTY', 'Write the message first.');
      if (text.length > 8000) return fail(res, 400, 'TOO_LONG', 'Keep it under 8,000 characters.');
      return out(await call(d.send, { text, to: Array.isArray(body.to) ? body.to.map(String) : [] }));
    }
    if (m === 'POST' && path === '/api/stop') return out(await call(d.stop));
    if (m === 'POST' && path === '/api/book/pause') return out(await call(d.bookPause));
    if (m === 'POST' && path === '/api/book/continue') return out(await call(d.bookAnswer, 'resume', false));
    if (m === 'POST' && path === '/api/book/answer') return out(await call(d.bookAnswer, String(body.action || ''), body.confirm === true));
    if (m === 'GET' && path === '/api/book/chapters') return out(await call(d.chapters));
    const ch = /^\/api\/book\/chapters\/(\d{1,4})$/.exec(path);
    if (m === 'GET' && ch) return out(await call(d.chapter, Number(ch[1])));
    if (m === 'GET' && path === '/api/alfred') return out(await call(d.alfred));
    if (m === 'POST' && path === '/api/alfred') {
      const text = String(body.text || '').trim();
      if (!text) return fail(res, 400, 'EMPTY', 'Write the message first.');
      if (text.length > 6000) return fail(res, 400, 'TOO_LONG', 'Keep it under 6,000 characters.');
      return out(await call(d.alfredAsk, text));
    }
    if (m === 'POST' && path === '/api/alerts/seen') return out(await call(d.alertsSeen, String(body.id || '')));
    return fail(res, 404, 'NOT_FOUND', 'The phone app asked for something this PC does not have — update both.');
  }

  async function handle(req, res) {
    let path = '/';
    try { path = new URL(req.url, 'http://phone').pathname; } catch (_) { return fail(res, 400, 'BAD_REQUEST', 'Bad address.'); }
    if (req.method === 'OPTIONS') return send(res, 204, '', { 'Content-Type': 'text/plain' });
    if (path.startsWith('/api/')) return api(req, res, path);
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'NOT_ALLOWED', 'Not allowed.');
    const f = files[path === '/index.html' ? '/' : path];
    if (!f) return fail(res, 404, 'NOT_FOUND', 'Not here.');
    const body = typeof f.body === 'function' ? f.body() : f.body;
    if (body == null) return fail(res, 404, 'NOT_FOUND', 'Not here.');
    return send(res, 200, body, Object.assign({ 'Content-Type': f.type, 'Cache-Control': 'no-cache' }, f.type.startsWith('text/html') ? { 'Content-Security-Policy': CSP } : {}));
  }

  return {
    start({ port, host } = {}) {
      return new Promise((resolve) => {
        if (server) { resolve({ ok: true, port: info.port, host: info.host, already: true }); return; }
        const s = http.createServer((req, res) => { handle(req, res).catch((e) => { try { fail(res, 500, 'PC_ERROR', 'The PC hit a problem.'); } catch (_) { /* closed */ } log('phone-error', { error: String(e).slice(0, 200) }); }); });
        s.headersTimeout = 20000;
        s.requestTimeout = 60000;
        s.keepAliveTimeout = 5000;
        s.once('error', (e) => { resolve({ ok: false, error: e.code || 'START_FAILED', words: e.code === 'EADDRINUSE' ? `Another program is using port ${port}.` : `The phone server could not start (${e.code || e.message}).` }); });
        s.listen(port, host || '0.0.0.0', () => {
          server = s;
          info = { port: s.address().port, host: host || '0.0.0.0' };
          log('phone-server', { step: 'started', port: info.port, host: info.host });
          resolve({ ok: true, port: info.port, host: info.host });
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (!server) { resolve({ ok: true }); return; }
        const s = server;
        server = null;
        info = null;
        try { if (s.closeAllConnections) s.closeAllConnections(); } catch (_) { /* old Node */ }
        s.close(() => resolve({ ok: true }));
        log('phone-server', { step: 'stopped' });
      });
    },
    running() { return !!server; },
    info() { return info ? Object.assign({}, info) : null; },
    phones(t = now()) { return [...phones.values()].filter((p) => t - p.lastSeen < 24 * 3600000).sort((a, b) => b.lastSeen - a.lastSeen); },
    forgetPhones() { phones.clear(); },
    handle,
  };
}

module.exports = { createPhoneServer, MAX_BODY };
