'use strict';
// service-bridge.js — exposes AutoInjector's relay as a separately callable
// LOCAL service over HTTP + Server-Sent Events (no external dependencies). It is
// a thin transport adapter over injected handlers: it owns NO relay logic — no
// panes, selectors, routing, retry, or Council logic live here. main.js wires it
// to the real sendTextTo/pollSite/House-Rules machinery. Bind is localhost-only;
// an optional bearer token gates every request (also accepted as ?token= for the
// SSE stream, since EventSource can't set headers).
//
// HTTP API (all JSON unless noted):
//   GET  /health                       -> { ok, service, version }
//   GET  /status                       -> { ok, participants:[...], council, routing, mesh }
//   GET  /participants                 -> { ok, participants:[{id,label,enabled,ready,generating,waiting,...}] }
//   GET  /responses?since=&limit=&site=-> { ok, responses:[{id,site,text,ts,...}] }
//   POST /participants/:site/send {text}     -> send to one participant
//   POST /send {text, targets?}              -> send to all enabled (or given) participants
//   POST /council/start {mode, topic, rounds}-> start a Council/roundtable run
//   POST /council/stop                       -> stop it
//   GET  /events   (SSE)               -> stream of: response, generation, sent,
//                                         status, council, error, rate-limit
const http = require('http');

// broadcast channel -> SSE event type (capture/log handled specially below).
const CHANNEL_MAP = {
  sent: 'sent',
  'send-error': 'error',
  generation: 'generation',
  'houserule-state': 'council',
  'waiting-changed': 'status',
  'manager-state': 'jarvis',
  'manager-log': 'jarvis-log',
  'manager-ack': 'jarvis-ack',
};

function createServiceBridge(deps) {
  const d = deps || {};
  const status = d.status || (() => ({}));
  const responses = d.responses || (() => []);
  const sendTo = d.sendTo || (async () => ({ ok: false, error: 'NOT_WIRED' }));
  const sendAll = d.sendAll || (async () => ({ ok: false, error: 'NOT_WIRED' }));
  const councilStart = d.councilStart || (async () => ({ ok: false, error: 'NOT_WIRED' }));
  const councilStop = d.councilStop || (async () => ({ ok: false, error: 'NOT_WIRED' }));
  const subscribe = d.subscribe || null;
  const log = d.log || (() => {});
  const version = d.version || '1.0.0';
  // Optional "run code / control computer" capability (Open Interpreter).
  const interpreter = d.interpreter || null; // { status(), configure(patch), run(task, {onEvent}) }
  // Optional native "Jarvis" orchestrator (the System AI supervisor): give it a
  // goal and it plans, delegates to the Council + runs code, with a critic gate.
  const jarvis = d.jarvis || null; // { start(goal), stop(), status() }
  // Optional external-tool registry (N5) and local voice capability (N2).
  const tools = d.tools || null; // { list(), run(name, args, {onEvent}) }
  const voice = d.voice || null; // { status(), configure(patch), speak(text), listen(opts) }

  let server = null;
  let unsub = null;
  let token = null;
  const sseClients = new Set();

  function safeCall(fn, arg) { try { return fn(arg); } catch (_) { return null; } }

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
    if (!authorized(req, url)) return reply(res, 401, { ok: false, error: 'UNAUTHORIZED' });

    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method;
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
      if (method === 'POST' && path === '/council/start') {
        const body = (await readJsonBody(req)) || {};
        if (body === undefined) return reply(res, 400, { ok: false, error: 'BAD_JSON' });
        const r = await councilStart({ mode: body.mode, topic: body.topic, rounds: body.rounds });
        return reply(res, r && r.ok ? 200 : 400, Object.assign({ ok: false }, r));
      }
      if (method === 'POST' && path === '/council/stop') {
        const r = await councilStop();
        return reply(res, 200, Object.assign({ ok: true }, r));
      }
      // --- Open Interpreter (code execution / computer control) ---
      if (interpreter && method === 'GET' && path === '/interpreter/status') {
        return reply(res, 200, Object.assign({ ok: true }, safeCall(interpreter.status) || {}));
      }
      if (interpreter && method === 'POST' && path === '/interpreter/settings') {
        const body = await readJsonBody(req);
        if (body === undefined) return reply(res, 400, { ok: false, error: 'BAD_JSON' });
        const s = interpreter.configure ? interpreter.configure(body || {}) : (safeCall(interpreter.status) || {});
        return reply(res, 200, Object.assign({ ok: true }, s));
      }
      if (interpreter && method === 'POST' && path === '/interpreter/run') {
        const body = await readJsonBody(req);
        if (body === undefined) return reply(res, 400, { ok: false, error: 'BAD_JSON' });
        if (!body.text && !body.task) return reply(res, 400, { ok: false, error: 'NEED_TASK' });
        // Stream each execution event over SSE as it happens; return the final
        // result on the HTTP response so a simple caller can just await it.
        const r = await interpreter.run(String(body.task || body.text), { onEvent: (ev) => emit('interpreter', ev) });
        emit('interpreter', { type: 'done' });
        return reply(res, r && r.ok ? 200 : 400, Object.assign({ ok: false }, r));
      }
      if (!interpreter && (path === '/interpreter/status' || path === '/interpreter/run' || path === '/interpreter/settings')) {
        return reply(res, 501, { ok: false, error: 'INTERPRETER_NOT_WIRED' });
      }
      // --- Jarvis orchestrator (the native supervisor over the whole system) ---
      if (jarvis && method === 'GET' && path === '/jarvis/status') {
        return reply(res, 200, Object.assign({ ok: true }, safeCall(jarvis.status) || {}));
      }
      if (jarvis && method === 'POST' && path === '/jarvis/start') {
        const body = await readJsonBody(req);
        if (body === undefined) return reply(res, 400, { ok: false, error: 'BAD_JSON' });
        const goal = body.goal || body.task || body.text;
        if (!goal) return reply(res, 400, { ok: false, error: 'NEED_GOAL' });
        const r = await jarvis.start(String(goal));
        return reply(res, 200, Object.assign({ ok: true }, r && r.manager ? { manager: r.manager } : r));
      }
      if (jarvis && method === 'POST' && path === '/jarvis/stop') {
        const r = await jarvis.stop();
        return reply(res, 200, Object.assign({ ok: true }, r));
      }
      if (!jarvis && (path === '/jarvis/status' || path === '/jarvis/start' || path === '/jarvis/stop')) {
        return reply(res, 501, { ok: false, error: 'JARVIS_NOT_WIRED' });
      }
      // --- Tools registry (N5: external tools; MCP-ready) ---
      if (tools && method === 'GET' && path === '/tools/list') {
        return reply(res, 200, { ok: true, tools: safeCall(tools.list) || [] });
      }
      if (tools && method === 'POST' && path === '/tools/run') {
        const body = await readJsonBody(req);
        if (body === undefined) return reply(res, 400, { ok: false, error: 'BAD_JSON' });
        if (!body.tool) return reply(res, 400, { ok: false, error: 'NEED_TOOL' });
        const r = await tools.run(String(body.tool), body.args || {}, { onEvent: (ev) => emit('tool', ev) });
        emit('tool', { type: 'done' });
        return reply(res, r && r.ok ? 200 : 400, Object.assign({ ok: false }, r));
      }
      if (!tools && (path === '/tools/list' || path === '/tools/run')) {
        return reply(res, 501, { ok: false, error: 'TOOLS_NOT_WIRED' });
      }
      // --- Voice (N2: local speak/listen) ---
      if (voice && method === 'GET' && path === '/voice/status') {
        return reply(res, 200, Object.assign({ ok: true }, safeCall(voice.status) || {}));
      }
      if (voice && method === 'POST' && path === '/voice/settings') {
        const body = await readJsonBody(req);
        if (body === undefined) return reply(res, 400, { ok: false, error: 'BAD_JSON' });
        const s = voice.configure ? voice.configure(body || {}) : (safeCall(voice.status) || {});
        return reply(res, 200, Object.assign({ ok: true }, s));
      }
      if (voice && method === 'POST' && path === '/voice/speak') {
        const body = await readJsonBody(req);
        if (body === undefined) return reply(res, 400, { ok: false, error: 'BAD_JSON' });
        if (!body.text) return reply(res, 400, { ok: false, error: 'NEED_TEXT' });
        const r = await voice.speak(String(body.text));
        return reply(res, r && r.ok ? 200 : 400, Object.assign({ ok: false }, r));
      }
      if (voice && method === 'POST' && path === '/voice/listen') {
        const body = await readJsonBody(req);
        if (body === undefined) return reply(res, 400, { ok: false, error: 'BAD_JSON' });
        const r = await voice.listen(body || {});
        return reply(res, r && r.ok ? 200 : 400, Object.assign({ ok: false }, r));
      }
      if (!voice && (path === '/voice/status' || path === '/voice/settings' || path === '/voice/speak' || path === '/voice/listen')) {
        return reply(res, 501, { ok: false, error: 'VOICE_NOT_WIRED' });
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
      if (channel === 'capture') {
        emit('response', payload);
        if (payload && payload.isRateLimited) emit('rate-limit', payload);
        return;
      }
      if (channel === 'log') {
        if (payload && payload.kind && /error|fail|rate-limit|stalled/i.test(String(payload.kind))) emit('error', payload);
        return;
      }
      const type = CHANNEL_MAP[channel];
      if (type) emit(type, payload);
    });
  }

  function start(opts) {
    const o = opts || {};
    token = o.token || null;
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
