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
  const image = d.image || null; // { status(), configure(patch), generate(prompt, {onEvent}) }
  // 🎨 Akọwe's image contract: { request(body), locks(), backend() } — docs/SD_IMAGE_API.md
  const sdStudio = d.sdStudio || null;
  // 🎬 Video: { backend(), request(body) } — docs/VIDEO_API.md (Wan on ComfyUI, or the old endpoint)
  const video = d.video || null;
  // The minimal phone client: the bridge serves this HTML shell (no token needed
  // to LOAD it — it carries the token from the pairing URL and uses it for data).
  const mobilePage = d.mobilePage || null; // string of HTML, or null to disable
  const silence = d.silence || null; // async () => stop all AI messaging (relay:silence)

  let server = null;
  let unsub = null;
  let token = null;
  // Security posture (see E01): the bridge can run tools and code, so by default
  // it (a) demands a token, (b) refuses writes from a foreign browser Origin, and
  // (c) will NOT run a risk:"ask" tool over the wire unless the operator opts in.
  let allowRiskyTools = false;
  let allowedOrigins = [];
  const sseClients = new Set();

  function safeCall(fn, arg) { try { return fn(arg); } catch (_) { return null; } }

  // Is this Origin a trusted local caller? An ABSENT Origin means a non-browser
  // process (curl, a local shim, the merged supervisor) — allowed. A browser page
  // always sends its Origin, and a random site you visit must not be able to POST
  // to the bridge: only localhost origins (or explicitly configured ones) may do
  // state-changing calls. A literal "null" Origin (sandboxed iframe / file://) is
  // treated as foreign and refused. This is the drive-by-RCE guard.
  function originAllowed(origin) {
    if (!origin) return true;
    if (allowedOrigins.includes(origin)) return true;
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|\[0:0:0:0:0:0:0:1\])(:\d+)?$/i.test(origin);
  }
  // Same-origin: the phone page the bridge itself served (Origin host === the
  // request's Host, port included) posting back to it. Allowed even over the LAN.
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
    }, extraHeaders || {}, res.req && res.req.bodyTooBig ? { Connection: 'close' } : {}));
    // A body over the limit was left unread: close the connection after answering, or (with no
    // server timeouts) its socket would stay open forever.
    if (res.req && res.req.bodyTooBig) res.end(data, () => { try { res.req.destroy(); } catch (_) {} });
    else res.end(data);
  }

  function authorized(req, url) {
    if (!token) return true;
    const h = req.headers['authorization'] || '';
    if (h === `Bearer ${token}`) return true;
    try { if (url.searchParams.get('token') === token) return true; } catch (_) {}
    return false;
  }

  function readJsonBody(req, maxBytes) {
    const limit = maxBytes || 1e6;
    return new Promise((resolve) => {
      let buf = '';
      let tooBig = false;
      req.on('data', (c) => { if (tooBig) return; buf += c; if (buf.length > limit) { tooBig = true; buf = ''; req.bodyTooBig = true; try { req.pause(); } catch (_) {} resolve(undefined); } });
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

    // The phone client shell is static HTML with no data in it, so it loads
    // WITHOUT a token (it then carries the token from the pairing URL for every
    // data call). Served before the auth gate for exactly that reason.
    if (mobilePage && req.method === 'GET' && (path === '/m' || path === '/mobile')) {
      return reply(res, 200, mobilePage, { 'Content-Type': 'text/html; charset=utf-8' });
    }

    if (!authorized(req, url)) return reply(res, 401, { ok: false, error: 'UNAUTHORIZED' });
    // A cross-site browser page must not be able to drive execution even if a
    // token ever leaked: refuse any state-changing method from a foreign Origin.
    // A same-origin request (the served phone page posting back to this bridge)
    // is fine — its Origin host matches the request Host.
    if (req.method !== 'GET' && !originAllowed(req.headers['origin']) && !sameOrigin(req.headers['origin'], req)) {
      return reply(res, 403, { ok: false, error: 'FORBIDDEN_ORIGIN' });
    }
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
      // "Stop AIs Talking" from the phone: halt every automatic relay at once.
      if (method === 'POST' && path === '/silence') {
        if (!silence) return reply(res, 501, { ok: false, error: 'NOT_WIRED' });
        const r = await silence();
        return reply(res, 200, Object.assign({ ok: true }, r || {}));
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
        const name = String(body.tool);
        // The approval boundary the desktop UI enforces for risk:"ask" tools must
        // also hold here — a risky tool (run-command, install-package, …) is NOT
        // runnable over the bridge unless the operator explicitly opted in.
        if (!allowRiskyTools) {
          const meta = (safeCall(tools.list) || []).find((t) => t && t.name === name);
          if (meta && meta.risk === 'ask') return reply(res, 403, { ok: false, error: 'TOOL_NEEDS_APPROVAL' });
        }
        const r = await tools.run(name, body.args || {}, { onEvent: (ev) => emit('tool', ev) });
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
      // --- Image generation (Stable Diffusion) ---
      if (image && method === 'GET' && path === '/image/status') {
        return reply(res, 200, Object.assign({ ok: true }, safeCall(image.status) || {}));
      }
      if (image && method === 'POST' && path === '/image/settings') {
        const body = await readJsonBody(req);
        if (body === undefined) return reply(res, 400, { ok: false, error: 'BAD_JSON' });
        const s = image.configure ? image.configure(body || {}) : (safeCall(image.status) || {});
        return reply(res, 200, Object.assign({ ok: true }, s));
      }
      if (image && method === 'POST' && path === '/image/generate') {
        const body = await readJsonBody(req);
        if (body === undefined) return reply(res, 400, { ok: false, error: 'BAD_JSON' });
        if (!body.prompt) return reply(res, 400, { ok: false, error: 'NEED_PROMPT' });
        const r = await image.generate(String(body.prompt), { negativePrompt: body.negativePrompt, onEvent: (ev) => emit('image', ev) });
        emit('image', { type: 'done' });
        // Never stream the raw base64 back over the bridge — just the outcome.
        return reply(res, r && r.ok ? 200 : 400, { ok: !!(r && r.ok), info: (r && r.info) || '', error: (r && r.error) || null, detail: (r && r.detail) || null, count: r && Array.isArray(r.images) ? r.images.length : (r && r.imageBase64 ? 1 : 0), bytes: r && r.imageBase64 ? r.imageBase64.length : 0 });
      }
      // --- 🎨 Character portraits / covers for Akọwe (docs/SD_IMAGE_API.md) ---
      if (sdStudio && method === 'GET' && path === '/image/backend') {
        return reply(res, 200, Object.assign({ ok: true }, safeCall(sdStudio.backend) || {}));
      }
      if (sdStudio && method === 'GET' && path === '/image/locks') {
        return reply(res, 200, Object.assign({ ok: true }, safeCall(sdStudio.locks) || { locks: [] }));
      }
      if (sdStudio && method === 'POST' && path === '/image/request') {
        const body = await readJsonBody(req);
        if (body === undefined) return reply(res, 400, { ok: false, error: 'BAD_JSON' });
        emit('image', { type: 'request', purpose: body.purpose || 'free', view: body.view || null, engine: body.engine || 'auto', characterLock: body.characterLock || null });
        // A ChatGPT picture takes 30–180 s (callers use a ≥300 s timeout); the server
        // itself never times this request out (see start()). A request that throws
        // still answers.
        let r;
        try { r = await sdStudio.request(body || {}); } catch (e) { r = { ok: false, error: 'INTERNAL', message: `Something went wrong: ${(e && e.message) || e}` }; }
        emit('image', { type: 'done', ok: !!(r && r.ok), engine: (r && r.engine) || null, error: r && !r.ok ? r.error : undefined });
        const CLIENT = ['NEED_PROMPT', 'NO_LOCK', 'INVALID_PARAM', 'UNKNOWN_VALUE', 'UNKNOWN_FIELD', 'BAD_TYPE', 'BAD_VALUE', 'UNKNOWN_OPTION', 'UNSUPPORTED_ON_BACKEND'];
        const UNAVAILABLE = ['NO_ENDPOINT', 'IMAGE_DISABLED', 'SD_NOT_CONNECTED', 'CHATGPT_NOT_READY', 'NO_IMAGE_ENGINE'];
        const BY_CODE = { IMAGE_REFUSED: 422, IMAGE_LIMIT: 429, IMAGE_TIMEOUT: 504 };
        const err = r && r.error;
        const code = r && r.ok ? 200 : CLIENT.includes(err) ? 400 : UNAVAILABLE.includes(err) ? 503 : BY_CODE[err] || 502;
        return reply(res, code, Object.assign({ ok: false }, r || {}));
      }
      // --- 🎬 Video for Akọwe / other programs (docs/VIDEO_API.md) ---
      if (video && method === 'GET' && path === '/video/backend') {
        let b;
        try { b = await video.backend(); } catch (e) { b = { ok: false, error: 'INTERNAL', message: String((e && e.message) || e) }; }
        return reply(res, 200, Object.assign({ ok: true }, b || {}));
      }
      if (video && method === 'POST' && path === '/video/request') {
        // A picture may come as base64 in the body: up to 40 MB of JSON. Long-running (minutes):
        // the server never times it out (see start()); a request that throws still answers.
        const body = await readJsonBody(req, 40 * 1024 * 1024);
        if (body === undefined) return reply(res, 400, { ok: false, error: 'BAD_JSON', code: 'BAD_JSON', message: 'The body must be JSON (at most 40 MB; send a large picture as a file path instead).' });
        emit('video', { type: 'request', mode: body.image ? 'animate' : 'generate', purpose: body.purpose || 'free', from: body.from || null });
        let r;
        try { r = await video.request(body || {}); } catch (e) { r = { ok: false, error: 'VIDEO_FAILED', code: 'VIDEO_FAILED', message: `Something went wrong: ${(e && e.message) || e}` }; }
        emit('video', { type: 'done', ok: !!(r && r.ok), engine: (r && r.engine) || null, error: r && !r.ok ? r.error : undefined });
        const CLIENT = ['INVALID_PARAM', 'NEED_PROMPT', 'NO_LOCK', 'UNSUPPORTED_ON_BACKEND'];
        const UNAVAILABLE = ['VIDEO_NOT_SET_UP', 'VIDEO_MODEL_MISSING', 'BUSY'];
        const BY_CODE = { VIDEO_TIMEOUT: 504, VIDEO_CANCELLED: 409, VIDEO_OOM: 507 };
        const err = r && r.error;
        const code = r && r.ok ? 200 : CLIENT.includes(err) ? 400 : UNAVAILABLE.includes(err) ? 503 : BY_CODE[err] || 502;
        return reply(res, code, Object.assign({ ok: false }, r || {}));
      }
      if (!video && (path === '/video/backend' || path === '/video/request')) {
        return reply(res, 501, { ok: false, error: 'VIDEO_NOT_WIRED' });
      }
      if (!sdStudio && (path === '/image/backend' || path === '/image/locks' || path === '/image/request')) {
        return reply(res, 501, { ok: false, error: 'IMAGE_NOT_WIRED' });
      }
      if (!image && (path === '/image/status' || path === '/image/settings' || path === '/image/generate')) {
        return reply(res, 501, { ok: false, error: 'IMAGE_NOT_WIRED' });
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
    allowRiskyTools = !!o.allowRiskyTools;
    allowedOrigins = Array.isArray(o.allowedOrigins) ? o.allowedOrigins.slice() : [];
    const host = o.host || '127.0.0.1';
    const port = o.port == null ? 8765 : o.port;
    return new Promise((resolve) => {
      server = http.createServer(handle);
      // /image/request with engine "chatgpt" can run for minutes (and the Jarvis /
      // interpreter routes too): no server-side request or idle-socket timeout —
      // Node's default requestTimeout (5 min) would cut a long one off. Localhost
      // only; each route has its own time limits.
      try { server.requestTimeout = 0; server.timeout = 0; server.headersTimeout = 60000; server.keepAliveTimeout = 5000; } catch (_) {}
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

  return { start, stop, emit, sseClientCount: () => sseClients.size, server: () => server };
}

module.exports = { createServiceBridge };
