'use strict';
// service-bridge.js — a small LOCAL HTTP + Server-Sent-Events adapter over the
// relay, so a phone (or any client) can watch the messages and send. It owns NO
// relay logic — main.js wires it to the real send/transcript machinery. Lean by
// design for the bare-bones core: status, captured responses, send, stop, a live
// event stream, and the static phone shell.
//
// Security (this bridge can drive the AIs, so it is never open):
//   - a token is required for every DATA call (also ?token= for the SSE stream),
//   - a state-changing call from a foreign browser Origin is refused; only an
//     absent/localhost/same-origin caller may write,
//   - the phone shell at /m loads WITHOUT a token (it is just static HTML; it
//     carries the token from the pairing URL for its own data calls).
//
// HTTP API (JSON unless noted):
//   GET  /health                 -> { ok, service, version }
//   GET  /status                 -> { ok, participants, routing, mesh, relayEnabled }
//   GET  /responses?since&limit&site -> { ok, responses:[{id,site,label,text,ts}] }
//   POST /participants/:site/send {text}
//   POST /send {text, targets?}
//   POST /silence                -> stop all automatic relay
//   GET  /m | /mobile            -> the phone shell (no token)
//   GET  /events (SSE)           -> response, sent, generation, status, error
const http = require('http');

const CHANNEL_MAP = {
  sent: 'sent',
  'send-error': 'error',
  generation: 'generation',
  'waiting-changed': 'status',
};

function createServiceBridge(deps) {
  const d = deps || {};
  const status = d.status || (() => ({}));
  const responses = d.responses || (() => []);
  const sendTo = d.sendTo || (async () => ({ ok: false, error: 'NOT_WIRED' }));
  const sendAll = d.sendAll || (async () => ({ ok: false, error: 'NOT_WIRED' }));
  const silence = d.silence || null; // async () => stop all relay
  const subscribe = d.subscribe || null;
  const log = d.log || (() => {});
  const version = d.version || '1.0.0';
  const mobilePage = d.mobilePage || null; // static HTML string, or null

  let server = null;
  let unsub = null;
  let token = null;
  let allowedOrigins = [];
  const sseClients = new Set();

  function safeCall(fn, arg) { try { return fn(arg); } catch (_) { return null; } }

  // Absent Origin = a non-browser process (curl, a native client) — allowed. A
  // browser page always sends its Origin; only localhost (or configured) origins
  // may drive writes, so a random site you visit cannot POST to the bridge.
  function originAllowed(origin) {
    if (!origin) return true;
    if (allowedOrigins.includes(origin)) return true;
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|\[0:0:0:0:0:0:0:1\])(:\d+)?$/i.test(origin);
  }
  // Same-origin: the page the bridge itself served (over the LAN or a tunnel)
  // posting back to it — Origin host === the request Host.
  function sameOrigin(origin, req) {
    if (!origin) return false;
    try { return new URL(origin).host === (req.headers['host'] || ''); } catch (_) { return false; }
  }

  function reply(res, code, body, extraHeaders) {
    const isText = typeof body === 'string';
    const data = isText ? body : JSON.stringify(body);
    res.writeHead(code, Object.assign({
      'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    }, extraHeaders || {}));
    res.end(data);
  }

  function authorized(req, url) {
    if (!token) return true;
    const h = req.headers['authorization'] || '';
    if (h === `Bearer ${token}`) return true;
    try { if (url.searchParams.get('token') === token) return true; } catch (_) {}
    return false;
  }

  function readJsonBody(req) {
    return new Promise((resolve) => {
      let buf = '';
      let tooBig = false;
      req.on('data', (c) => { buf += c; if (buf.length > 1e6) { tooBig = true; req.destroy(); } });
      req.on('end', () => {
        if (tooBig) return resolve(undefined);
        if (!buf) return resolve({});
        try { resolve(JSON.parse(buf)); } catch (_) { resolve(undefined); }
      });
      req.on('error', () => resolve(undefined));
    });
  }

  function emit(type, payload) {
    if (!sseClients.size) return;
    const line = `event: ${type}\ndata: ${JSON.stringify(payload == null ? null : payload)}\n\n`;
    for (const res of sseClients) { try { res.write(line); } catch (_) {} }
  }

  async function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (_) { return reply(res, 400, { ok: false, error: 'BAD_URL' }); }
    if (req.method === 'OPTIONS') return reply(res, 204, '');

    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method;

    // The phone shell is static HTML with no data in it — loads without a token.
    if (mobilePage && method === 'GET' && (path === '/m' || path === '/mobile')) {
      return reply(res, 200, mobilePage, { 'Content-Type': 'text/html; charset=utf-8' });
    }

    if (!authorized(req, url)) return reply(res, 401, { ok: false, error: 'UNAUTHORIZED' });
    // A cross-site browser page must not drive execution even if a token leaked.
    if (method !== 'GET' && !originAllowed(req.headers['origin']) && !sameOrigin(req.headers['origin'], req)) {
      return reply(res, 403, { ok: false, error: 'FORBIDDEN_ORIGIN' });
    }

    try {
      if (method === 'GET' && (path === '/' || path === '/health')) {
        return reply(res, 200, { ok: true, service: 'autoinjector', version });
      }
      if (method === 'GET' && path === '/status') {
        return reply(res, 200, Object.assign({ ok: true }, safeCall(status) || {}));
      }
      if (method === 'GET' && path === '/participants') {
        const s = safeCall(status) || {};
        return reply(res, 200, { ok: true, participants: s.participants || [] });
      }
      if (method === 'GET' && path === '/responses') {
        const since = Number(url.searchParams.get('since')) || 0;
        const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
        const site = url.searchParams.get('site') || null;
        return reply(res, 200, { ok: true, responses: safeCall(responses, { since, limit, site }) || [] });
      }
      const oneSend = path.match(/^\/participants\/([a-z0-9_-]+)\/send$/i);
      if (method === 'POST' && oneSend) {
        const body = await readJsonBody(req);
        if (body === undefined) return reply(res, 400, { ok: false, error: 'BAD_JSON' });
        if (!body.text) return reply(res, 400, { ok: false, error: 'NEED_TEXT' });
        const r = await sendTo(oneSend[1], String(body.text));
        return reply(res, r && r.ok ? 200 : 400, Object.assign({ ok: false }, r));
      }
      if (method === 'POST' && path === '/send') {
        const body = await readJsonBody(req);
        if (body === undefined) return reply(res, 400, { ok: false, error: 'BAD_JSON' });
        if (!body.text) return reply(res, 400, { ok: false, error: 'NEED_TEXT' });
        const targets = Array.isArray(body.targets) ? body.targets : null;
        const r = await sendAll(String(body.text), targets);
        return reply(res, 200, Object.assign({ ok: true }, r));
      }
      if (method === 'POST' && path === '/silence') {
        if (!silence) return reply(res, 501, { ok: false, error: 'NOT_WIRED' });
        const r = await silence();
        return reply(res, 200, Object.assign({ ok: true }, r || {}));
      }
      if (method === 'GET' && path === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        res.write(`event: hello\ndata: ${JSON.stringify({ service: 'autoinjector', version })}\n\n`);
        sseClients.add(res);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
        const drop = () => { clearInterval(ping); sseClients.delete(res); };
        req.on('close', drop);
        req.on('error', drop);
        return;
      }
      return reply(res, 404, { ok: false, error: 'NOT_FOUND' });
    } catch (e) {
      log('bridge-request-error', { path, error: String((e && e.message) || e) });
      return reply(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  }

  function wireEvents() {
    if (!subscribe) return null;
    return subscribe((channel, payload) => {
      if (channel === 'capture') { emit('response', payload); return; }
      if (channel === 'log') {
        if (payload && payload.kind && /error|fail|stalled/i.test(String(payload.kind))) emit('error', payload);
        return;
      }
      const type = CHANNEL_MAP[channel];
      if (type) emit(type, payload);
    });
  }

  function start(opts) {
    const o = opts || {};
    token = o.token || null;
    allowedOrigins = Array.isArray(o.allowedOrigins) ? o.allowedOrigins.slice() : [];
    const host = o.host || '127.0.0.1';
    const port = o.port == null ? 8765 : o.port;
    return new Promise((resolve) => {
      server = http.createServer(handle);
      server.on('error', (e) => {
        log('bridge-error', { error: String((e && e.code) || (e && e.message) || e) });
        server = null;
        resolve({ ok: false, error: String((e && e.code) || (e && e.message) || e) });
      });
      server.listen(port, host, () => {
        unsub = wireEvents();
        const addr = server.address();
        const actual = addr && typeof addr === 'object' ? addr.port : port;
        log('bridge-listening', { host, port: actual });
        resolve({ ok: true, host, port: actual, url: `http://${host}:${actual}` });
      });
    });
  }

  function stop() {
    try { if (unsub) unsub(); } catch (_) {}
    unsub = null;
    for (const res of sseClients) { try { res.end(); } catch (_) {} }
    sseClients.clear();
    return new Promise((resolve) => {
      if (!server) return resolve();
      const s = server; server = null;
      s.close(() => resolve());
    });
  }

  return { start, stop, emit, sseClientCount: () => sseClients.size };
}

module.exports = { createServiceBridge };
