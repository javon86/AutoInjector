'use strict';
/*
 * mcp-client.js — a small MCP (Model Context Protocol) client in plain Node (no npm packages).
 *
 * Talks JSON-RPC 2.0 to ONE tool server, over either
 *   stdio  — the server is a program we start (command + args + env); newline-delimited JSON on its
 *            stdin/stdout, its stderr kept (last few KB, secrets taken out) to explain errors;
 *   http   — "Streamable HTTP": every message is a POST to the server's URL; the answer is either JSON
 *            or a short SSE stream (text/event-stream). The Mcp-Session-Id the server hands out on
 *            initialize is sent back on every later request.
 *
 * What it does: initialize (protocolVersion 2025-06-18, clientInfo AutoInjector) → notifications/initialized
 * → tools/list (follows nextCursor) → tools/call. Every request has a timeout. A stdio server that crashes
 * after it was connected is restarted (at most `maxRestarts` times in `restartWindowMs`); stop() closes it
 * cleanly (stdin closed → SIGTERM → SIGKILL). Errors come back as one plain sentence; nothing here ever
 * logs or returns a secret (env values, header values, tokens in text are replaced by •••).
 *
 *   const c = createMcpClient({ name, transport: 'stdio', command, args, env })   // or { transport:'http', url, headers }
 *   await c.start()            -> { ok, tools } | { ok:false, error, message }
 *   await c.callTool(n, args)  -> { ok, text, images, resources, structured, isError } | { ok:false, error, message }
 *   c.status()                 -> { status: stopped|starting|connected|error, tools, error, message, stderr, serverInfo }
 *   await c.stop(); c.killNow()
 */
const cp = require('child_process');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = Object.freeze({ name: 'AutoInjector', version: '1.0.0' });
const MAX_LINE = 8 * 1024 * 1024;   // one JSON message from a stdio server
const MAX_BODY = 16 * 1024 * 1024;  // one HTTP answer
const STDERR_KEEP = 4096;
const MAX_TOOLS = 1000;
const MAX_PAGES = 50;
const MAX_TEXT = 20000;

// ---------------------------------------------------------------------------------------------- redaction
const SECRET_PATTERNS = [
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 •••'],
  [/\b(sk|pk|rk|ghp|gho|ghu|ghs|github_pat|hf|xox[abprs]|glpat|AKIA)[-_]?[A-Za-z0-9_-]{12,}/g, '•••'],
  [/((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|authorization)["']?\s*[=:]\s*["']?)[^\s"'&,;]{4,}/gi, '$1•••'],
  [/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1•••@'],
];
/** A function that takes text and returns it with every given secret (and anything that looks like a key) hidden. */
function makeRedactor(secrets) {
  const vals = (Array.isArray(secrets) ? secrets : []).map((s) => String(s == null ? '' : s)).filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
  return function redact(text) {
    let t = String(text == null ? '' : text);
    for (const v of vals) t = t.split(v).join('•••');
    for (const [re, to] of SECRET_PATTERNS) t = t.replace(re, to);
    return t;
  };
}

// ---------------------------------------------------------------------------------------------- results
/**
 * A tools/call result → something usable: all text joined; pictures counted (and saved through
 * saveImage(buffer, mimeType) -> path when given); embedded resources' text included; links listed.
 */
function formatContent(result, opts = {}) {
  const r = result && typeof result === 'object' ? result : {};
  const parts = [];
  const images = [];
  const resources = [];
  const items = Array.isArray(r.content) ? r.content : [];
  for (const c of items.slice(0, 200)) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text') { parts.push(String(c.text == null ? '' : c.text)); continue; }
    if (c.type === 'image' || c.type === 'audio') {
      const mime = String(c.mimeType || (c.type === 'image' ? 'image/png' : 'audio/wav')).slice(0, 80);
      const b64 = typeof c.data === 'string' ? c.data : '';
      const bytes = Math.floor((b64.length * 3) / 4);
      const it = { kind: c.type, mimeType: mime, bytes };
      if (c.type === 'image' && b64 && typeof opts.saveImage === 'function') {
        try { const p = opts.saveImage(Buffer.from(b64, 'base64'), mime); if (p) it.path = String(p); } catch (_) { /* keep the summary */ }
      }
      images.push(it);
      parts.push(it.path ? `[${c.type} saved: ${it.path}]` : `[${c.type}: ${mime}, ${Math.max(1, Math.round(bytes / 1024))} KB]`);
      continue;
    }
    if (c.type === 'resource' && c.resource && typeof c.resource === 'object') {
      const res = c.resource;
      const it = { uri: String(res.uri || '').slice(0, 2000), mimeType: res.mimeType ? String(res.mimeType).slice(0, 80) : undefined };
      if (typeof res.text === 'string') { it.text = res.text.slice(0, MAX_TEXT); parts.push(`[${it.uri}]\n${res.text}`); }
      else if (typeof res.blob === 'string') { it.bytes = Math.floor((res.blob.length * 3) / 4); parts.push(`[${it.uri}: ${it.mimeType || 'binary'}, ${Math.max(1, Math.round(it.bytes / 1024))} KB]`); }
      resources.push(it);
      continue;
    }
    if (c.type === 'resource_link') {
      const it = { uri: String(c.uri || '').slice(0, 2000), name: c.name ? String(c.name).slice(0, 200) : undefined, mimeType: c.mimeType ? String(c.mimeType).slice(0, 80) : undefined, link: true };
      resources.push(it);
      parts.push(`[link: ${it.name ? `${it.name} ` : ''}${it.uri}]`);
    }
  }
  let text = parts.join('\n');
  if (!text && r.structuredContent !== undefined) { try { text = JSON.stringify(r.structuredContent); } catch (_) { text = ''; } }
  const truncated = text.length > MAX_TEXT;
  if (truncated) text = `${text.slice(0, MAX_TEXT)}… (${text.length} characters in all)`;
  const out = { text, images, resources, isError: r.isError === true };
  if (r.structuredContent !== undefined) out.structured = r.structuredContent;
  if (truncated) out.truncated = true;
  return out;
}

// ---------------------------------------------------------------------------------------------- helpers
function splitCommandLine(line) {
  const out = []; let cur = ''; let q = null; let has = false;
  const s = String(line || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === q) q = null; else if (ch === '\\' && q === '"' && (s[i + 1] === '"' || s[i + 1] === '\\')) cur += s[++i]; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (cur || has) { out.push(cur); cur = ''; has = false; } continue; }
    cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}
const winQuote = (a) => (/^[A-Za-z0-9_./:=@+\\-]+$/.test(a) ? a : `"${String(a).replace(/"/g, '\\"')}"`);

function plainNetError(e, url) {
  const code = (e && e.code) || '';
  if (code === 'ECONNREFUSED') return `Nothing is answering at ${url}. Is the tool server running?`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `This computer can't find ${url} (check the address and the internet connection).`;
  if (code === 'ECONNRESET' || code === 'EPIPE') return `The tool server at ${url} closed the connection.`;
  if (/CERT|SSL|TLS/i.test(code) || /certificate/i.test(String(e && e.message))) return `The secure connection to ${url} failed (certificate problem).`;
  return `Couldn't reach ${url} (${code || String((e && e.message) || e).slice(0, 120)}).`;
}

// ---------------------------------------------------------------------------------------------- the client
function createMcpClient(options = {}) {
  const o = Object.assign({
    name: 'tool server', transport: 'stdio', command: '', args: [], env: {}, cwd: undefined,
    url: '', headers: {}, timeoutMs: 30000, initTimeoutMs: 30000, maxRestarts: 3, restartWindowMs: 60000,
    restartDelayMs: 500, spawn: cp.spawn, platform: process.platform, log: () => {}, onChange: () => {}, saveImage: null,
    execFile: cp.execFile, // for taskkill on Windows (injectable for tests)
  }, options);
  // On Windows the server runs under cmd.exe (shell:true), so ch.kill() would only end cmd.exe and leave the real
  // server (node / python …) running: taskkill /T /F ends the whole tree, like sd-runner does.
  function killProc(ch, sig) {
    if (!ch) return;
    if (o.platform === 'win32' && ch.pid) {
      try { o.execFile('taskkill', ['/pid', String(ch.pid), '/T', '/F'], { windowsHide: true }, () => {}); return; } catch (_) {}
    }
    try { ch.kill(sig); } catch (_) {}
  }
  const name = String(o.name || 'tool server');
  const transport = o.transport === 'http' ? 'http' : 'stdio';
  const secretValues = [...Object.values(o.env || {}), ...Object.values(o.headers || {})];
  if (o.url) { try { const u = new URL(o.url); if (u.password) secretValues.push(u.password); for (const v of u.searchParams.values()) if (v.length >= 8) secretValues.push(v); } catch (_) {} }
  const redact = makeRedactor(secretValues.concat(Array.isArray(o.secrets) ? o.secrets : []));
  const shownUrl = o.url ? redact(String(o.url)) : '';

  let status = 'stopped';
  let lastError = null; // { error, message }
  let tools = [];
  let serverInfo = null;
  let protocolVersion = null;
  let stderrTail = '';
  let child = null;
  let childGen = 0;
  let stopping = false;
  let starting = null; // the promise of a start in progress
  let restarts = [];
  let restartTimer = null;
  let sessionId = null;
  let nextId = 1;
  const pending = new Map(); // id -> { resolve, reject, timer, method }
  const httpReqs = new Set();

  const log = (step, d) => { try { o.log(step, Object.assign({ server: name, transport }, d || {})); } catch (_) {} };
  const changed = () => { try { o.onChange(publicStatus()); } catch (_) {} };
  function setStatus(s, err) {
    status = s;
    lastError = err ? { error: err.error || 'ERROR', message: redact(err.message || err.error || 'Something went wrong.') } : (s === 'error' ? lastError : null);
    changed();
  }
  function fail(error, message) { return { ok: false, error, message: redact(message) }; }
  function stderrHint() {
    const t = redact(stderrTail).trim().split(/\r?\n/).filter(Boolean).slice(-4).join(' / ');
    return t ? ` What it said: ${t.slice(-400)}` : '';
  }

  // ---------------------------------------------------------------- JSON-RPC layer
  function rejectAll(error, message) {
    for (const [id, p] of pending) { clearTimeout(p.timer); pending.delete(id); p.reject(Object.assign(new Error(message), { code: error })); }
  }
  function handleMessage(msg) {
    if (Array.isArray(msg)) { for (const m of msg) handleMessage(m); return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.id != null && (Object.prototype.hasOwnProperty.call(msg, 'result') || Object.prototype.hasOwnProperty.call(msg, 'error')) && !msg.method) {
      const p = pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer); pending.delete(msg.id);
      if (msg.error) {
        const m = msg.error && msg.error.message ? String(msg.error.message) : 'error';
        p.reject(Object.assign(new Error(m), { code: 'SERVER_ERROR', rpcCode: msg.error.code }));
      } else p.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id != null) { // a request from the server: we answer the harmless ones, refuse the rest
      let reply;
      if (msg.method === 'ping') reply = { jsonrpc: '2.0', id: msg.id, result: {} };
      else if (msg.method === 'roots/list') reply = { jsonrpc: '2.0', id: msg.id, result: { roots: [] } };
      else reply = { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'AutoInjector does not support this request' } };
      sendRaw(reply).catch(() => {});
      return;
    }
    if (msg.method === 'notifications/tools/list_changed' && status === 'connected') {
      listAllTools().then((t) => { tools = t; log('tools-changed', { tools: t.length }); changed(); }).catch(() => {});
    }
  }
  function request(method, params, timeoutMs) {
    const id = nextId++;
    const ms = Math.max(200, Number(timeoutMs) || o.timeoutMs);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        // tell the server we gave up (best effort)
        sendRaw({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'timeout' } }).catch(() => {});
        reject(Object.assign(new Error(`The tool server "${name}" didn't answer in ${Math.round(ms / 1000)} seconds.`), { code: 'TIMEOUT' }));
      }, ms);
      pending.set(id, { resolve, reject, timer, method });
      const msg = { jsonrpc: '2.0', id, method };
      if (params !== undefined) msg.params = params;
      sendRaw(msg, ms).then((delivered) => {
        // http: the exchange is over; if our answer wasn't in it, it never will be
        if (transport === 'http' && delivered && pending.has(id)) {
          const p = pending.get(id); clearTimeout(p.timer); pending.delete(id);
          p.reject(Object.assign(new Error(`The tool server "${name}" ended its answer without a result.`), { code: 'NO_ANSWER' }));
        }
      }, (e) => {
        const p = pending.get(id); if (!p) return;
        clearTimeout(p.timer); pending.delete(id);
        p.reject(e);
      });
    });
  }
  function notify(method, params) {
    const msg = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    return sendRaw(msg);
  }
  function httpIdleMs(waitMs) { return Math.max(1000, Number(waitMs) || 0, Number(o.timeoutMs) || 0, Number(o.initTimeoutMs) || 0) + 2000; }
  function sendRaw(msg, ms) { return transport === 'http' ? httpSend(msg, ms) : stdioSend(msg); }

  // ---------------------------------------------------------------- stdio transport
  function stdioSend(msg) {
    if (!child || !child.stdin || child.stdin.destroyed) return Promise.reject(Object.assign(new Error(`The tool server "${name}" is not running.`), { code: 'NOT_RUNNING' }));
    return new Promise((resolve, reject) => {
      try { child.stdin.write(`${JSON.stringify(msg)}\n`, (e) => (e ? reject(Object.assign(new Error(`Couldn't talk to the tool server "${name}" (${e.code || e.message}).`), { code: 'WRITE_FAILED' })) : resolve(true))); }
      catch (e) { reject(Object.assign(new Error(`Couldn't talk to the tool server "${name}".`), { code: 'WRITE_FAILED' })); }
    });
  }
  function spawnChild() {
    const gen = ++childGen;
    const env = Object.assign({}, process.env, o.env || {});
    const args = (o.args || []).map(String);
    const win = o.platform === 'win32';
    let ch;
    try {
      // Windows: npx / npm are .cmd scripts, which only start through the shell
      ch = win
        ? o.spawn([o.command, ...args].map(winQuote).join(' '), [], { env, cwd: o.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: true })
        : o.spawn(o.command, args, { env, cwd: o.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return { error: e };
    }
    child = ch;
    let buf = '';
    if (ch.stdout) {
      ch.stdout.setEncoding && ch.stdout.setEncoding('utf8');
      ch.stdout.on('data', (d) => {
        if (gen !== childGen) return;
        buf += String(d);
        if (buf.length > MAX_LINE && buf.indexOf('\n') < 0) { stderrTail = (stderrTail + '\n[a message from the server was too big and was dropped]').slice(-STDERR_KEEP); buf = ''; return; }
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          let msg; try { msg = JSON.parse(line); } catch (_) { stderrTail = (stderrTail + '\n' + line.slice(0, 300)).slice(-STDERR_KEEP); continue; }
          handleMessage(msg);
        }
      });
    }
    if (ch.stderr) {
      ch.stderr.setEncoding && ch.stderr.setEncoding('utf8');
      ch.stderr.on('data', (d) => { if (gen === childGen) stderrTail = (stderrTail + String(d)).slice(-STDERR_KEEP); });
    }
    if (ch.stdin && ch.stdin.on) ch.stdin.on('error', () => {}); // EPIPE when it died: handled by 'exit'
    const onGone = (code, signal, err) => {
      if (gen !== childGen) return;
      childGen++; child = null;
      const wasConnected = status === 'connected';
      const why = err
        ? (err.code === 'ENOENT'
          ? `Couldn't start "${o.command}" — it isn't installed on this computer (or not on its PATH). Install it${/^(npx|npm|node)$/i.test(String(o.command)) ? ' (npx comes with Node.js from nodejs.org)' : ''}, or type the full path to the program.`
          : `Couldn't start "${o.command}" (${err.code || err.message}).`)
        : `The tool server "${name}" stopped${code != null ? ` (exit code ${code})` : signal ? ` (${signal})` : ''}.${stderrHint()}`;
      rejectAll(err ? 'SPAWN_FAILED' : 'CRASHED', why);
      if (stopping) return;
      log('exit', { code, signal: signal || null, connected: wasConnected });
      if (wasConnected) scheduleRestart(why);
      else if (!starting) setStatus('error', { error: err ? 'SPAWN_FAILED' : 'CRASHED', message: why });
      else lastError = { error: err ? 'SPAWN_FAILED' : 'CRASHED', message: redact(why) };
    };
    ch.on('error', (e) => onGone(null, null, e));
    ch.on('exit', (code, signal) => onGone(code, signal, null));
    return { ok: true };
  }
  function scheduleRestart(why) {
    const now = Date.now();
    restarts = restarts.filter((t) => now - t < o.restartWindowMs);
    if (restarts.length >= o.maxRestarts) {
      setStatus('error', { error: 'KEEPS_CRASHING', message: `${why} It crashed ${restarts.length + 1} times in a short while, so I stopped restarting it. Press Start to try again.` });
      log('gave-up', { restarts: restarts.length });
      return;
    }
    restarts.push(now);
    setStatus('starting', { error: 'RESTARTING', message: `${why} Restarting it…` });
    const delay = o.restartDelayMs * restarts.length;
    log('restart', { attempt: restarts.length, delayMs: delay });
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => { restartTimer = null; if (!stopping) start({ restart: true }).catch(() => {}); }, delay);
  }

  // ---------------------------------------------------------------- http transport
  function httpSend(msg, waitMs) {
    let u;
    try { u = new URL(o.url); } catch (_) { return Promise.reject(Object.assign(new Error(`"${shownUrl}" is not a web address.`), { code: 'BAD_URL' })); }
    const lib = u.protocol === 'https:' ? https : http;
    const body = Buffer.from(JSON.stringify(msg));
    const headers = Object.assign({}, o.headers || {}, {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': body.length,
      'User-Agent': 'AutoInjector-mcp/1.0',
    });
    if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const isRequest = msg.id != null && msg.method;
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (e, v) => { if (settled) return; settled = true; httpReqs.delete(req); if (e) reject(e); else resolve(v); };
      const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'POST', headers }, (res) => {
        const sid = res.headers['mcp-session-id'];
        if (sid && msg.method === 'initialize') sessionId = String(sid).slice(0, 200);
        const st = res.statusCode || 0;
        if (st === 202 || st === 204) { res.resume(); return done(null, true); }
        if (st >= 400) {
          let t = ''; res.setEncoding('utf8');
          res.on('data', (d) => { if (t.length < 2000) t += d; });
          res.on('end', () => {
            let m = '';
            try { const j = JSON.parse(t); m = (j.error && (j.error.message || j.error)) || j.message || ''; } catch (_) { m = t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200); }
            const code = st === 404 && sessionId ? 'SESSION_EXPIRED' : st === 401 || st === 403 ? 'UNAUTHORIZED' : `HTTP_${st}`;
            const plain = st === 401 || st === 403
              ? `The tool server at ${shownUrl} refused the request (HTTP ${st}) — check the key or token in its headers.`
              : st === 404 && sessionId ? `The tool server at ${shownUrl} forgot our session.`
                : `The tool server at ${shownUrl} answered with an error (HTTP ${st})${m ? `: ${String(m).slice(0, 200)}` : ''}.`;
            done(Object.assign(new Error(plain), { code }));
          });
          res.on('error', () => done(Object.assign(new Error(`The tool server at ${shownUrl} answered with an error (HTTP ${st}).`), { code: `HTTP_${st}` })));
          return;
        }
        const ctype = String(res.headers['content-type'] || '').toLowerCase();
        res.setEncoding('utf8');
        let size = 0;
        if (ctype.includes('text/event-stream')) {
          let buf = ''; let data = [];
          const flush = () => {
            if (!data.length) return;
            const payload = data.join('\n'); data = [];
            try { handleMessage(JSON.parse(payload)); } catch (_) { /* not JSON: ignore */ }
            if (isRequest && !pending.has(msg.id)) { try { req.destroy(); } catch (_) {} done(null, true); } // got our answer: close the stream
          };
          res.on('data', (d) => {
            size += d.length; if (size > MAX_BODY) { try { req.destroy(); } catch (_) {} return done(Object.assign(new Error(`The answer from ${shownUrl} was too big.`), { code: 'TOO_BIG' })); }
            buf += d;
            let i;
            while ((i = buf.search(/\r?\n/)) >= 0) {
              const line = buf.slice(0, i); buf = buf.slice(buf[i] === '\r' ? i + 2 : i + 1);
              if (line === '') { flush(); continue; }
              if (line.startsWith(':')) continue;
              const k = line.indexOf(':'); const field = k < 0 ? line : line.slice(0, k); let val = k < 0 ? '' : line.slice(k + 1); if (val.startsWith(' ')) val = val.slice(1);
              if (field === 'data') data.push(val);
            }
          });
          res.on('end', () => { flush(); done(null, true); });
          res.on('error', () => done(null, true));
          return;
        }
        let t = '';
        res.on('data', (d) => { size += d.length; if (size > MAX_BODY) { try { req.destroy(); } catch (_) {} return done(Object.assign(new Error(`The answer from ${shownUrl} was too big.`), { code: 'TOO_BIG' })); } t += d; });
        res.on('end', () => {
          if (t.trim()) { try { handleMessage(JSON.parse(t)); } catch (_) { return done(Object.assign(new Error(`The tool server at ${shownUrl} didn't answer in the MCP format (not JSON).`), { code: 'BAD_ANSWER' })); } }
          done(null, true);
        });
        res.on('error', () => done(null, true));
      });
      httpReqs.add(req);
      req.on('error', (e) => done(Object.assign(new Error(plainNetError(e, shownUrl)), { code: e.code || 'NET_ERROR' })));
      // The socket may sit idle for as long as this request may take (a 180 s tool call, a slow initialize):
      // never cut it before the request's own timeout gives up.
      req.setTimeout(httpIdleMs(waitMs), () => { try { req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); } catch (_) {} });
      req.end(body);
    });
  }

  // ---------------------------------------------------------------- lifecycle
  async function listAllTools() {
    const out = []; let cursor; let pages = 0;
    do {
      const r = await request('tools/list', cursor ? { cursor } : {}, o.timeoutMs);
      const list = r && Array.isArray(r.tools) ? r.tools : [];
      for (const t of list) {
        if (!t || typeof t.name !== 'string' || !t.name) continue;
        out.push({
          name: t.name.slice(0, 128),
          title: t.title ? String(t.title).slice(0, 200) : undefined,
          description: String(t.description || '').slice(0, 2000),
          inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object' },
          annotations: t.annotations && typeof t.annotations === 'object' ? t.annotations : undefined,
        });
        if (out.length >= MAX_TOOLS) return out;
      }
      cursor = r && typeof r.nextCursor === 'string' && r.nextCursor ? r.nextCursor : null;
    } while (cursor && ++pages < MAX_PAGES);
    return out;
  }
  async function connectOnce() {
    if (transport === 'stdio') {
      if (!o.command) return fail('NO_COMMAND', `The tool server "${name}" has no program to start.`);
      stderrTail = '';
      const s = spawnChild();
      if (s.error) return fail('SPAWN_FAILED', `Couldn't start "${o.command}" (${s.error.code || s.error.message}).`);
    } else {
      if (!o.url) return fail('NO_URL', `The tool server "${name}" has no web address.`);
      sessionId = null; protocolVersion = null;
    }
    try {
      const init = await request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, o.initTimeoutMs);
      protocolVersion = (init && typeof init.protocolVersion === 'string' && init.protocolVersion) || PROTOCOL_VERSION;
      serverInfo = init && init.serverInfo ? { name: String(init.serverInfo.name || '').slice(0, 120), version: String(init.serverInfo.version || '').slice(0, 40) } : null;
      await notify('notifications/initialized');
      tools = await listAllTools();
      return { ok: true };
    } catch (e) {
      let message = String((e && e.message) || e);
      if (lastError && (e.code === 'CRASHED' || e.code === 'SPAWN_FAILED' || e.code === 'NOT_RUNNING' || e.code === 'WRITE_FAILED')) message = lastError.message || message;
      if (e && e.code === 'SERVER_ERROR') message = `The tool server "${name}" said: ${message}`;
      if (e && e.code === 'TIMEOUT' && transport === 'stdio') message += `${stderrHint()} (Is it really an MCP tool server? Some need a minute to download the first time — press Start again.)`;
      killNow();
      return fail((e && e.code) || 'INIT_FAILED', message);
    }
  }
  function start(opts = {}) {
    if (starting) return starting;
    if (status === 'connected' && !opts.restart) return Promise.resolve({ ok: true, tools: tools.slice() });
    stopping = false;
    if (!opts.restart) { restarts = []; clearTimeout(restartTimer); restartTimer = null; }
    lastError = null;
    setStatus('starting');
    log('start', { restart: !!opts.restart });
    starting = (async () => {
      const r = await connectOnce();
      starting = null;
      if (stopping) return fail('STOPPED', `The tool server "${name}" was stopped.`);
      if (!r.ok) {
        log('start-failed', { error: r.error, restart: !!opts.restart });
        if (opts.restart) scheduleRestart(r.message); else setStatus('error', r);
        return r;
      }
      setStatus('connected');
      log('connected', { tools: tools.length });
      return { ok: true, tools: tools.slice(), serverInfo };
    })();
    return starting;
  }
  function killNow() {
    const ch = child; childGen++; child = null;
    if (ch) { try { ch.stdin && ch.stdin.end(); } catch (_) {} killProc(ch, 'SIGKILL'); }
    for (const r of httpReqs) { try { r.destroy(); } catch (_) {} }
    httpReqs.clear();
  }
  async function stop() {
    stopping = true;
    clearTimeout(restartTimer); restartTimer = null;
    rejectAll('STOPPED', `The tool server "${name}" was stopped.`);
    const ch = child;
    if (transport === 'stdio' && ch) {
      childGen++; child = null;
      await new Promise((resolve) => {
        let gone = false;
        const end = () => { if (gone) return; gone = true; clearTimeout(t1); clearTimeout(t2); resolve(); };
        ch.once('exit', end);
        if (ch.exitCode != null || ch.signalCode != null) return end();
        try { ch.stdin && ch.stdin.end(); } catch (_) {}
        const t1 = setTimeout(() => killProc(ch, 'SIGTERM'), 1500);
        const t2 = setTimeout(() => { killProc(ch, 'SIGKILL'); setTimeout(end, 300); }, 3500);
      });
    }
    if (transport === 'http') {
      for (const r of httpReqs) { try { r.destroy(); } catch (_) {} }
      httpReqs.clear();
      if (sessionId) { // tell the server the session is over (best effort, short)
        try {
          const u = new URL(o.url); const lib = u.protocol === 'https:' ? https : http;
          await new Promise((resolve) => {
            const rq = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'DELETE', headers: Object.assign({}, o.headers || {}, { 'Mcp-Session-Id': sessionId }) }, (res) => { res.resume(); res.on('end', resolve); });
            rq.on('error', resolve); rq.setTimeout(2000, () => { try { rq.destroy(); } catch (_) {} resolve(); }); rq.end();
          });
        } catch (_) {}
      }
      sessionId = null;
    }
    tools = [];
    setStatus('stopped');
    log('stopped');
    return { ok: true };
  }

  async function callTool(toolName, args, opts = {}) {
    if (status !== 'connected') {
      if (starting) await starting;
      if (status !== 'connected') return fail('NOT_CONNECTED', `The tool server "${name}" is not connected${lastError ? ` (${lastError.message})` : ''}.`);
    }
    if (!tools.some((t) => t.name === toolName)) return fail('UNKNOWN_TOOL', `The tool server "${name}" has no tool called "${String(toolName).slice(0, 80)}".`);
    const attempt = async () => request('tools/call', { name: toolName, arguments: args && typeof args === 'object' ? args : {} }, opts.timeoutMs || o.timeoutMs);
    let result;
    try { result = await attempt(); } catch (e) {
      if (e && e.code === 'SESSION_EXPIRED' && transport === 'http') { // the server restarted: one new session, one retry
        const r = await connectOnce();
        if (r.ok) { try { result = await attempt(); } catch (e2) { return fail(e2.code || 'CALL_FAILED', e2.code === 'SERVER_ERROR' ? `The tool server "${name}" said: ${e2.message}` : e2.message); } }
        else { setStatus('error', r); return r; }
      } else {
        return fail((e && e.code) || 'CALL_FAILED', e && e.code === 'SERVER_ERROR' ? `The tool server "${name}" said: ${e.message}` : String((e && e.message) || e));
      }
    }
    const f = formatContent(result, { saveImage: o.saveImage });
    f.text = redact(f.text);
    log('call', { tool: String(toolName).slice(0, 80), ok: !f.isError });
    if (f.isError) return Object.assign({ ok: false, error: 'TOOL_ERROR', message: `The tool "${toolName}" on "${name}" reported a problem: ${f.text.slice(0, 600) || 'no details'}` }, f);
    return Object.assign({ ok: true }, f);
  }

  function publicStatus() {
    return {
      name, transport, status,
      error: lastError ? lastError.error : null,
      message: lastError ? lastError.message : null,
      serverInfo, tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema })),
      stderr: stderrTail ? redact(stderrTail).slice(-1500) : '',
      pid: child && child.pid ? child.pid : null,
      restarts: restarts.length,
    };
  }

  return {
    start, stop, killNow, callTool, httpIdleMs,
    listTools: async (opts = {}) => {
      if (opts.refresh && status === 'connected') { try { tools = await listAllTools(); changed(); } catch (e) { return fail(e.code || 'LIST_FAILED', e.message); } }
      return { ok: status === 'connected', tools: tools.slice() };
    },
    status: publicStatus,
    get tools() { return tools.slice(); },
    get name() { return name; },
    redact,
  };
}

module.exports = { createMcpClient, formatContent, makeRedactor, splitCommandLine, PROTOCOL_VERSION, CLIENT_INFO };
