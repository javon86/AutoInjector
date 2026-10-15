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
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { URL } = require('url');

// Injected by main.js after output-manager init. Kept behind a setter so this
// module has no hard dependency on Electron/app paths and stays unit-testable.
let config = {
  outputRoot: '',        // read/write-file + list-dir are sandboxed to this tree
  fetchAllowlist: [],    // http-fetch host allowlist; empty = any http(s) host allowed
  fetchMaxBytes: 512 * 1024,
  fetchTimeoutMs: 15000,
  // Computer-power tools (run-command, install-package, created "full code"
  // tools) — every one is risk:"ask", so main.js's approval gate pauses for the
  // user before it ever runs. These deps are injected so this module stays
  // Electron-free and unit-testable with stubs.
  spawn: cp.spawn,            // process runner (injectable for tests)
  openPath: null,            // Electron shell.openPath — set by main.js
  openExternal: null,        // Electron shell.openExternal — set by main.js
  commandTimeoutMs: 120000,  // hard cap on any single command/script
  commandMaxBytes: 64 * 1024, // captured stdout/stderr cap
  toolsFile: '',             // where the butler's self-made tools persist
};
function configure(patch) {
  if (!patch || typeof patch !== 'object') return { ...config };
  if ('outputRoot' in patch) config.outputRoot = String(patch.outputRoot || '');
  if ('fetchAllowlist' in patch && Array.isArray(patch.fetchAllowlist)) config.fetchAllowlist = patch.fetchAllowlist.map(String);
  if ('fetchMaxBytes' in patch) config.fetchMaxBytes = Math.max(1024, Number(patch.fetchMaxBytes) || config.fetchMaxBytes);
  if ('fetchTimeoutMs' in patch) config.fetchTimeoutMs = Math.max(1000, Number(patch.fetchTimeoutMs) || config.fetchTimeoutMs);
  if (typeof patch.spawn === 'function') config.spawn = patch.spawn;
  if ('openPath' in patch) config.openPath = typeof patch.openPath === 'function' ? patch.openPath : null;
  if ('openExternal' in patch) config.openExternal = typeof patch.openExternal === 'function' ? patch.openExternal : null;
  if ('commandTimeoutMs' in patch) config.commandTimeoutMs = Math.max(1000, Number(patch.commandTimeoutMs) || config.commandTimeoutMs);
  if ('commandMaxBytes' in patch) config.commandMaxBytes = Math.max(1024, Number(patch.commandMaxBytes) || config.commandMaxBytes);
  if ('toolsFile' in patch) config.toolsFile = String(patch.toolsFile || '');
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

function _resolveInRoot(rel) {
  const p = String(rel || '').trim();
  if (!p) return { error: 'NEED_PATH' };
  if (!config.outputRoot) return { error: 'NO_OUTPUT_ROOT' };
  const root = path.resolve(config.outputRoot);
  const full = path.resolve(root, p);
  if (full !== root && !full.startsWith(root + path.sep)) return { error: 'PATH_ESCAPE' };
  return { full, root };
}
function _writeFile({ path: rel, content } = {}) {
  const r = _resolveInRoot(rel); if (r.error) return { ok: false, error: r.error };
  try {
    fs.mkdirSync(path.dirname(r.full), { recursive: true });
    fs.writeFileSync(r.full, String(content == null ? '' : content));
    return { ok: true, message: `Wrote ${path.relative(r.root, r.full)} (${Buffer.byteLength(String(content || ''))} bytes).`, data: { path: r.full } };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}
function _listDir({ path: rel } = {}) {
  const r = _resolveInRoot(rel || '.'); if (r.error) return { ok: false, error: r.error };
  try {
    const items = fs.readdirSync(r.full, { withFileTypes: true }).map((d) => (d.isDirectory() ? d.name + '/' : d.name));
    return { ok: true, message: items.join('\n'), data: { count: items.length } };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// ---- Computer-power tools (all risk:"ask") --------------------------------
// Spawn a process, capture stdout/stderr (capped), enforce a hard timeout.
function _spawnCapture(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = config.spawn(cmd, args || [], { cwd: opts.cwd || config.outputRoot || undefined, shell: !!opts.shell, windowsHide: true }); }
    catch (e) { return resolve({ ok: false, error: `SPAWN_FAILED: ${String((e && e.message) || e)}` }); }
    let out = '', err = '', done = false, overflow = false;
    const cap = config.commandMaxBytes;
    const finish = (res) => { if (done) return; done = true; clearTimeout(timer); try { child.kill && child.kill(); } catch (_) {} resolve(res); };
    const timer = setTimeout(() => finish({ ok: false, error: 'TIMEOUT', message: out.slice(0, cap), data: { timedOut: true } }), opts.timeoutMs || config.commandTimeoutMs);
    if (child.stdout && child.stdout.on) child.stdout.on('data', (d) => { if (out.length < cap) out += String(d); else overflow = true; });
    if (child.stderr && child.stderr.on) child.stderr.on('data', (d) => { if (err.length < cap) err += String(d); else overflow = true; });
    if (child.on) child.on('error', (e) => finish({ ok: false, error: String((e && e.message) || e) }));
    if (child.on) child.on('close', (code) => finish({ ok: code === 0, message: out.slice(0, cap) || err.slice(0, cap), error: code === 0 ? null : (err.slice(0, cap) || `exited ${code}`), data: { code, truncated: overflow } }));
  });
}
function _runCommand({ command, cwd } = {}) {
  const c = String(command || '').trim();
  if (!c) return Promise.resolve({ ok: false, error: 'NEED_COMMAND' });
  return _spawnCapture(c, [], { shell: true, cwd });
}
async function _openPath({ target } = {}) {
  const t = String(target || '').trim();
  if (!t) return { ok: false, error: 'NEED_TARGET' };
  const isUrl = /^https?:\/\//i.test(t);
  const fn = isUrl ? config.openExternal : config.openPath;
  if (typeof fn !== 'function') return { ok: false, error: 'OPEN_UNAVAILABLE' };
  try { const r = await fn(t); return { ok: !(typeof r === 'string' && r), message: r ? `open reported: ${r}` : `Opened ${t}`, data: { target: t } }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}
const PKG_MANAGERS = new Set(['pip', 'pip3', 'pipx', 'npm']);
function _installPackage({ manager, name } = {}) {
  const mgr = String(manager || '').trim();
  const nm = String(name || '').trim();
  if (!PKG_MANAGERS.has(mgr)) return Promise.resolve({ ok: false, error: 'BAD_MANAGER' });
  if (!/^[A-Za-z0-9][A-Za-z0-9._@/+=<>~-]{0,120}$/.test(nm)) return Promise.resolve({ ok: false, error: 'BAD_PACKAGE' });
  return _spawnCapture(mgr, ['install', nm], { shell: false });
}

// ---- The butler's self-made tools ("full code" tools) ---------------------
// A created tool's authored code is NEVER eval'd inside this app — it's written
// to a temp file and run as a SEPARATE, approval-gated child process. So it has
// full power on the machine (the user chose that) but can't corrupt the app's
// own process, and every run pauses for the user's OK (risk:"ask").
const createdTools = new Map(); // name -> { name, description, language, code }
const RESERVED_NAMES = new Set(['http-fetch', 'read-file', 'write-file', 'list-dir', 'run-command', 'open-path', 'install-package', 'create-tool']);
function _validToolName(n) { return /^[a-z0-9][a-z0-9_-]{1,40}$/i.test(String(n || '')); }
async function _runCreated(spec, args = {}) {
  const extra = args && args.args != null ? String(args.args) : '';
  if (spec.language === 'shell') return _spawnCapture(spec.code, [], { shell: true });
  const ext = spec.language === 'python' ? '.py' : '.js';
  const bin = spec.language === 'python' ? (process.platform === 'win32' ? 'python' : 'python3') : 'node';
  let file;
  try { file = path.join(os.tmpdir(), `butler-tool-${spec.name}-${Date.now()}${ext}`); fs.writeFileSync(file, spec.code); }
  catch (e) { return { ok: false, error: `WRITE_FAILED: ${String((e && e.message) || e)}` }; }
  const r = await _spawnCapture(bin, extra ? [file, extra] : [file], { shell: false });
  try { fs.unlinkSync(file); } catch (_) {}
  return r;
}
function _registerCreated(spec) {
  register({ name: spec.name, description: `[self-made] ${spec.description}`, schema: { args: 'string (optional) passed to the script' }, risk: 'ask', source: 'created', invoke: (a) => _runCreated(spec, a) });
}
function _saveCreated() {
  if (!config.toolsFile) return;
  try { fs.mkdirSync(path.dirname(config.toolsFile), { recursive: true }); fs.writeFileSync(config.toolsFile, JSON.stringify(Array.from(createdTools.values()), null, 2)); } catch (_) {}
}
function _createTool({ name, description, language, code } = {}) {
  const nm = String(name || '').trim();
  if (!_validToolName(nm)) return { ok: false, error: 'BAD_NAME' };
  if (RESERVED_NAMES.has(nm.toLowerCase())) return { ok: false, error: 'NAME_RESERVED' };
  const lang = ['shell', 'python', 'node'].includes(language) ? language : 'shell';
  const body = String(code == null ? '' : code);
  if (!body.trim()) return { ok: false, error: 'NEED_CODE' };
  const spec = { name: nm, description: String(description || `Custom ${lang} tool`).slice(0, 200), language: lang, code: body };
  createdTools.set(nm, spec);
  _registerCreated(spec);
  _saveCreated();
  return { ok: true, message: `Created tool "${nm}" (${lang}). It will ask for your approval each time it runs.`, data: { name: nm, language: lang } };
}
// Re-register the butler's saved tools on startup (called by main.js).
function loadCreatedTools() {
  if (!config.toolsFile) return { ok: true, loaded: 0 };
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(config.toolsFile, 'utf8')); } catch (_) { return { ok: true, loaded: 0 }; }
  let n = 0;
  for (const spec of (Array.isArray(arr) ? arr : [])) {
    if (spec && _validToolName(spec.name) && !RESERVED_NAMES.has(String(spec.name).toLowerCase()) && typeof spec.code === 'string') {
      createdTools.set(spec.name, { name: spec.name, description: String(spec.description || ''), language: ['shell', 'python', 'node'].includes(spec.language) ? spec.language : 'shell', code: spec.code });
      _registerCreated(createdTools.get(spec.name)); n++;
    }
  }
  return { ok: true, loaded: n };
}

// Register the built-ins once at module load.
register({ name: 'http-fetch', description: 'GET a URL and return its text body (size-capped).', schema: { url: 'string' }, risk: 'ask', invoke: (args) => _httpFetch(args) });
register({ name: 'read-file', description: "Read a text file from the app's output folder (sandboxed).", schema: { path: 'string (relative to output/)' }, risk: 'monitor', invoke: (args) => _readFile(args) });
register({ name: 'write-file', description: "Write text to a file in the app's output folder (sandboxed).", schema: { path: 'string (relative to output/)', content: 'string' }, risk: 'monitor', invoke: (args) => _writeFile(args) });
register({ name: 'list-dir', description: "List files in a folder of the app's output folder (sandboxed).", schema: { path: 'string (relative to output/, default root)' }, risk: 'monitor', invoke: (args) => _listDir(args) });
register({ name: 'run-command', description: 'Run a shell command on this computer and return its output. Asks for your approval first.', schema: { command: 'string', cwd: 'string (optional)' }, risk: 'ask', invoke: (args) => _runCommand(args) });
register({ name: 'open-path', description: 'Open a URL, file or folder in the default app (e.g. a program download page). Asks first.', schema: { target: 'string (url or path)' }, risk: 'ask', invoke: (args) => _openPath(args) });
register({ name: 'install-package', description: 'Install a package with pip or npm. Asks first.', schema: { manager: 'pip|pip3|pipx|npm', name: 'string (package name)' }, risk: 'ask', invoke: (args) => _installPackage(args) });
register({ name: 'create-tool', description: "Create a NEW reusable tool the butler can call later — give it a name, description, language (shell|python|node) and the code to run. The tool (and every run) asks for your approval.", schema: { name: 'string', description: 'string', language: 'shell|python|node', code: 'string' }, risk: 'ask', invoke: (args) => _createTool(args) });

module.exports = { configure, register, unregister, list, has, get, status, run, registerMcpServer, loadCreatedTools };
