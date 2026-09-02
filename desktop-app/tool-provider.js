'use strict';
// tool-provider.js — the butler's external-tool capability (N5). A small,
// in-process TOOL REGISTRY the manager can invoke via the USE_TOOL action,
// deliberately shaped so a real MCP (Model Context Protocol) client can register
// an external server's advertised tools into the SAME registry later, with no
// change to the USE_TOOL contract.
//
// A tool is { name, description, schema, risk, invoke(args) -> Promise<result> }:
//   - name        unique id the manager names in {"action":"USE_TOOL","tool":name}
//   - description one line the manager sees, so it knows when to reach for it
//   - schema      informational arg shape (not enforced here)
//   - risk        "monitor" (auto-runs) | "ask" (routed through the approval gate)
//   - invoke      async; returns { ok, message, data?, error? } or throws
//
// run(name, args) normalizes every tool's return into { ok, message, events,
// error } — the exact shape interpreter-provider.run resolves — so main.js's
// executor treats a tool result just like a RUN_CODE result.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// Injected by main.js after output-manager init. Kept behind a setter so this
// module has no hard dependency on Electron/app paths and stays unit-testable.
let config = {
  outputRoot: '',        // read-file is sandboxed to this directory tree
  fetchAllowlist: [],    // http-fetch host allowlist; empty = any http(s) host allowed
  fetchMaxBytes: 512 * 1024,
  fetchTimeoutMs: 15000,
};
function configure(patch) {
  if (!patch || typeof patch !== 'object') return { ...config };
  if ('outputRoot' in patch) config.outputRoot = String(patch.outputRoot || '');
  if ('fetchAllowlist' in patch && Array.isArray(patch.fetchAllowlist)) config.fetchAllowlist = patch.fetchAllowlist.map(String);
  if ('fetchMaxBytes' in patch) config.fetchMaxBytes = Math.max(1024, Number(patch.fetchMaxBytes) || config.fetchMaxBytes);
  if ('fetchTimeoutMs' in patch) config.fetchTimeoutMs = Math.max(1000, Number(patch.fetchTimeoutMs) || config.fetchTimeoutMs);
  return { ...config };
}

// ---- The registry ---------------------------------------------------------
const registry = new Map();

function register(tool) {
  if (!tool || !tool.name || typeof tool.invoke !== 'function') {
    return { ok: false, error: 'BAD_TOOL' };
  }
  registry.set(tool.name, {
    name: String(tool.name),
    description: String(tool.description || ''),
    schema: tool.schema || {},
    risk: tool.risk === 'ask' ? 'ask' : 'monitor',
    source: tool.source || 'builtin',
    invoke: tool.invoke,
  });
  return { ok: true, name: tool.name };
}
function unregister(name) { return registry.delete(name); }

// What the manager (and the UI) see -- never leaks the invoke function.
function list() {
  return Array.from(registry.values()).map((t) => ({
    name: t.name, description: t.description, schema: t.schema, risk: t.risk, source: t.source,
  }));
}
function has(name) { return registry.has(name); }
function get(name) { return registry.get(name) || null; }
function status() { return { count: registry.size, tools: list().map((t) => t.name) }; }

// Invoke a registered tool. Normalizes to interpreter-provider.run's shape.
async function run(name, args = {}, opts = {}) {
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const tool = registry.get(name);
  if (!tool) return { ok: false, error: 'UNKNOWN_TOOL', events: [] };
  const events = [];
  const emit = (ev) => { events.push(ev); onEvent(ev); };
  emit({ type: 'tool-start', content: name });
  try {
    const res = await tool.invoke(args || {}, { emit });
    const ok = !res || res.ok !== false;
    const message = res && res.message != null ? String(res.message) : (ok ? 'ok' : '');
    const out = { ok, message, data: res && res.data, error: ok ? null : (res && res.error) || 'TOOL_FAILED', events };
    emit({ type: ok ? 'output' : 'error', content: message || out.error || '' });
    emit({ type: 'done' });
    return out;
  } catch (e) {
    const error = String((e && e.message) || e);
    emit({ type: 'error', content: error });
    emit({ type: 'done' });
    return { ok: false, message: '', error, events };
  }
}

// ---- MCP-ready seam -------------------------------------------------------
// A future MCP client would connect to a server (stdio or HTTP), read its
// advertised tools, and call register(...) once per tool with an invoke() that
// forwards to that server. Not implemented now -- documented so the wiring point
// is unambiguous and the USE_TOOL contract above never has to change.
function registerMcpServer(/* cfg */) {
  return { ok: false, error: 'MCP_NOT_IMPLEMENTED', hint: 'register() each advertised tool with an invoke() that forwards to the MCP server' };
}

// ---- Built-in tools -------------------------------------------------------
function _hostAllowed(hostname) {
  if (!config.fetchAllowlist.length) return true; // empty allowlist = allow any http(s) host (risk "ask" gates it)
  return config.fetchAllowlist.some((h) => hostname === h || hostname.endsWith('.' + h));
}

function _httpFetch({ url } = {}) {
  return new Promise((resolve) => {
    const target = String(url || '').trim();
    if (!target) return resolve({ ok: false, error: 'NEED_URL' });
    let u; try { u = new URL(target); } catch { return resolve({ ok: false, error: 'BAD_URL' }); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return resolve({ ok: false, error: 'BAD_PROTOCOL' });
    if (!_hostAllowed(u.hostname)) return resolve({ ok: false, error: 'HOST_NOT_ALLOWED' });
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'GET', timeout: config.fetchTimeoutMs, headers: { 'User-Agent': 'AutoInjector-tool/1.0', Accept: 'text/*, application/json' } },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) { res.resume(); return resolve({ ok: false, error: `HTTP_${res.statusCode}` }); }
        let buf = ''; let done = false;
        const finish = (over) => { if (done) return; done = true; resolve({ ok: true, message: buf, data: { status: res.statusCode, truncated: over, bytes: Buffer.byteLength(buf) } }); };
        res.setEncoding('utf8');
        res.on('data', (d) => {
          if (done) return;
          buf += d;
          // On overflow, return the truncated body as a success — destroying the
          // request here would make `end` never fire, so resolve inline instead.
          if (Buffer.byteLength(buf) > config.fetchMaxBytes) { buf = buf.slice(0, config.fetchMaxBytes); try { res.destroy(); } catch {} finish(true); }
        });
        res.on('end', () => finish(false));
        res.on('error', (e) => { if (!done) resolve({ ok: false, error: String((e && e.message) || e) }); });
      }
    );
    req.on('error', (e) => resolve({ ok: false, error: String((e && e.code) || (e && e.message) || e) }));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ ok: false, error: 'TIMEOUT' }); });
    req.end();
  });
}

function _readFile({ path: rel } = {}) {
  const p = String(rel || '').trim();
  if (!p) return { ok: false, error: 'NEED_PATH' };
  if (!config.outputRoot) return { ok: false, error: 'NO_OUTPUT_ROOT' };
  // Sandbox: the resolved path must stay inside outputRoot (no .. escape, no absolute break-out).
  const root = path.resolve(config.outputRoot);
  const full = path.resolve(root, p);
  if (full !== root && !full.startsWith(root + path.sep)) return { ok: false, error: 'PATH_ESCAPE' };
  try {
    const st = fs.statSync(full);
    if (!st.isFile()) return { ok: false, error: 'NOT_A_FILE' };
    if (st.size > config.fetchMaxBytes) {
      const fd = fs.openSync(full, 'r'); const b = Buffer.alloc(config.fetchMaxBytes);
      fs.readSync(fd, b, 0, config.fetchMaxBytes, 0); fs.closeSync(fd);
      return { ok: true, message: b.toString('utf8'), data: { truncated: true, bytes: st.size } };
    }
    return { ok: true, message: fs.readFileSync(full, 'utf8'), data: { truncated: false, bytes: st.size } };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// Register the built-ins once at module load.
register({ name: 'http-fetch', description: 'GET a URL and return its text body (size-capped).', schema: { url: 'string' }, risk: 'ask', invoke: (args) => _httpFetch(args) });
register({ name: 'read-file', description: "Read a text file from the app's output folder (sandboxed).", schema: { path: 'string (relative to output/)' }, risk: 'monitor', invoke: (args) => _readFile(args) });

module.exports = { configure, register, unregister, list, has, get, status, run, registerMcpServer };
