'use strict';
/*
 * mcp-manager.js — the user's saved tool servers (MCP) and their running clients.
 *
 * Off by default: the list starts empty and nothing runs until the user adds a server in
 * ⚙ More settings → 🧰 Tools (🎩 Butler section). A server is
 *   { id, name, transport: 'stdio' | 'http', command + args + env  |  url + headers, enabled }
 * `enabled` = it was started and not stopped, so it starts again with the app.
 *
 * Secrets: every env value and header value is sealed with secret-store.js (the OS keychain) before it
 * is written to disk. When this PC can't seal, they are kept for this session only (never written in
 * plain text) and the server says so. They are never logged, shown, broadcast or returned: the public
 * view lists only the NAMES of the env variables / headers.
 *
 * Connected servers' tools are registered into tool-provider.js (the butler's USE_TOOL path) as
 * "mcp:<server-id>/<tool>" — always risk "ask". Alfred reaches them through tools() and call().
 */
const fs = require('fs');
const path = require('path');
const { createMcpClient, splitCommandLine, makeRedactor } = require('./mcp-client');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,39}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HEADER_KEY = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const BLOCKED_HEADERS = new Set(['host', 'content-length', 'content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'connection', 'transfer-encoding']);
const MAX_SERVERS = 20;
const MAX_SECRET_LINES = 30;

function slug(name) { return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'server'; }

/** "KEY=value" lines → env, "Header-Name: value" lines → headers. Empty lines and # comments are skipped. */
function parseSecrets(text) {
  const env = {}; const headers = {}; const bad = [];
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  for (const line of lines.slice(0, MAX_SECRET_LINES)) {
    let m = /^([A-Za-z_][A-Za-z0-9_]{0,63})\s*=(.*)$/.exec(line);
    if (m) { env[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1'); continue; }
    m = /^([A-Za-z0-9][A-Za-z0-9-]{0,63})\s*:\s*(.+)$/.exec(line);
    if (m && !/^https?$/i.test(m[1])) { headers[m[1]] = m[2].trim(); continue; }
    bad.push(line.replace(/[=:].*$/, '').slice(0, 40));
  }
  if (lines.length > MAX_SECRET_LINES) bad.push(`(more than ${MAX_SECRET_LINES} lines)`);
  return { env, headers, bad };
}

function createMcpManager(opts = {}) {
  const o = Object.assign({
    file: '', seal: () => null, open: () => '', spawn: undefined, log: () => {}, saveImage: null,
    toolProvider: null, timeoutMs: 60000, initTimeoutMs: 90000, clientOptions: {}, onChange: () => {},
  }, opts);
  const entries = new Map(); // id -> { spec, client, unsaved, missing }
  let loaded = false;

  const log = (step, d) => { try { o.log('mcp', Object.assign({ step }, d || {})); } catch (_) {} };
  const changed = () => { try { o.onChange(); } catch (_) {} };

  // ------------------------------------------------------------------ persistence
  function load() {
    if (loaded) return;
    loaded = true;
    if (!o.file) return;
    let j = null;
    try { j = JSON.parse(fs.readFileSync(o.file, 'utf8')); } catch (_) { return; }
    for (const s of (j && Array.isArray(j.servers) ? j.servers : []).slice(0, MAX_SERVERS)) {
      if (!s || !NAME_RE.test(String(s.name || '')) || entries.has(slug(s.name))) continue;
      const spec = { id: slug(s.name), name: String(s.name), transport: s.transport === 'http' ? 'http' : 'stdio', command: String(s.command || '').slice(0, 1000), args: Array.isArray(s.args) ? s.args.map((x) => String(x).slice(0, 2000)).slice(0, 60) : [], url: String(s.url || '').slice(0, 2000), env: {}, headers: {}, enabled: s.enabled === true, added: s.added || null };
      const missing = [];
      // keys this run couldn't open: their sealed blob (or the {enc:null} placeholder) is written back unchanged on
      // save, so a keychain that is unavailable today doesn't erase the secret for good.
      const keep = { env: {}, headers: {} };
      for (const kind of ['env', 'headers']) {
        for (const [k, v] of Object.entries(s[kind] || {})) {
          if (kind === 'env' ? !ENV_KEY.test(k) : !HEADER_KEY.test(k)) continue;
          let val = ''; try { val = v && typeof v === 'object' && v.enc ? o.open(v.enc) : ''; } catch (_) { val = ''; }
          if (val) spec[kind][k] = val; else { missing.push(k); keep[kind][k] = v && typeof v === 'object' && typeof v.enc === 'string' ? v.enc : null; }
        }
      }
      entries.set(spec.id, { spec, client: null, unsaved: false, missing, keep });
    }
  }
  function save() {
    if (!o.file) return { ok: true, sealed: true };
    let allSealed = true;
    const servers = [];
    for (const e of entries.values()) {
      const s = e.spec;
      const out = { name: s.name, transport: s.transport, command: s.command, args: s.args, url: s.url, env: {}, headers: {}, enabled: !!s.enabled, added: s.added };
      let sealedHere = true;
      for (const kind of ['env', 'headers']) {
        for (const [k, v] of Object.entries(s[kind] || {})) {
          let enc = null; try { enc = v ? o.seal(v) : null; } catch (_) { enc = null; }
          // never plain text on disk: a secret that can't be sealed leaves a placeholder, so the next run says
          // "needs its secrets again" instead of starting the server without it
          if (enc) out[kind][k] = { enc }; else if (v) { sealedHere = false; out[kind][k] = { enc: null }; }
        }
        const kept = (e.keep && e.keep[kind]) || {};
        for (const [k, enc] of Object.entries(kept)) if (!(k in out[kind])) out[kind][k] = { enc: enc || null };
      }
      e.unsaved = !sealedHere;
      if (!sealedHere) allSealed = false;
      servers.push(out);
    }
    try {
      fs.mkdirSync(path.dirname(o.file), { recursive: true });
      const tmp = `${o.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, servers }, null, 2));
      fs.renameSync(tmp, o.file);
    } catch (e) { log('save-error', { error: String((e && e.code) || e) }); return { ok: false, sealed: allSealed }; }
    return { ok: true, sealed: allSealed };
  }

  // ------------------------------------------------------------------ helpers
  function find(ref) {
    load();
    const r = String(ref == null ? '' : ref).trim();
    if (!r) return null;
    return entries.get(r) || entries.get(slug(r)) || [...entries.values()].find((e) => e.spec.name.toLowerCase() === r.toLowerCase()) || null;
  }
  function redactorOf(e) {
    const s = e.spec;
    const vals = [...Object.values(s.env || {}), ...Object.values(s.headers || {})];
    return makeRedactor(vals);
  }
  function targetText(e) {
    const s = e.spec; const red = redactorOf(e);
    if (s.transport === 'http') {
      try { const u = new URL(s.url); for (const k of [...u.searchParams.keys()]) if (/key|token|secret|auth|pass/i.test(k)) u.searchParams.set(k, '•••'); if (u.password) u.password = '•••'; return red(u.toString()); } catch (_) { return red(s.url); }
    }
    return red([s.command, ...s.args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '));
  }
  function publicOne(e) {
    const s = e.spec;
    const st = e.client ? e.client.status() : { status: 'stopped', tools: [], error: null, message: null, serverInfo: null, stderr: '' };
    const tools = (st.tools || []).map((t) => ({ name: t.name, title: t.title, description: t.description }));
    let summary;
    if (st.status === 'connected') summary = `connected · ${tools.length} tool${tools.length === 1 ? '' : 's'}`;
    else if (st.status === 'starting') summary = st.message ? 'restarting…' : 'starting…';
    else if (st.status === 'error') summary = st.message || 'not working';
    else summary = 'stopped';
    return {
      id: s.id, name: s.name, transport: s.transport, target: targetText(e),
      runsProgram: s.transport === 'stdio',
      envKeys: Object.keys(s.env || {}), headerKeys: Object.keys(s.headers || {}),
      secretsNotSaved: !!e.unsaved, missingSecrets: e.missing.slice(),
      enabled: !!s.enabled, status: st.status, summary, error: st.error, message: st.message,
      serverInfo: st.serverInfo, tools, toolCount: tools.length,
      stderr: st.status === 'error' ? (st.stderr || '').slice(-800) : '',
    };
  }
  function syncRegistry(e) {
    const tp = o.toolProvider;
    if (!tp || typeof tp.registerMcpServer !== 'function') return;
    try { tp.unregisterMcpServer(e.spec.id); } catch (_) {}
    const st = e.client && e.client.status();
    if (!st || st.status !== 'connected') return;
    try {
      tp.registerMcpServer({ name: e.spec.id, label: e.spec.name, runsProgram: e.spec.transport === 'stdio', tools: st.tools, call: (tool, args) => call(e.spec.id, tool, args) });
    } catch (_) {}
  }
  function clientFor(e) {
    if (e.client) return e.client;
    const s = e.spec;
    e.client = createMcpClient(Object.assign({
      name: s.name, transport: s.transport, command: s.command, args: s.args, env: s.env, url: s.url, headers: s.headers,
      timeoutMs: o.timeoutMs, initTimeoutMs: o.initTimeoutMs, saveImage: o.saveImage,
      log: (step, d) => log(step, { server: s.id, tools: d && d.tools, error: d && d.error, code: d && d.code, attempt: d && d.attempt, tool: d && d.tool, ok: d && d.ok }),
      onChange: () => { syncRegistry(e); changed(); },
    }, o.spawn ? { spawn: o.spawn } : {}, o.clientOptions || {}));
    return e.client;
  }

  // ------------------------------------------------------------------ API
  function list() { load(); return { ok: true, servers: [...entries.values()].map(publicOne) }; }

  function add(input = {}) {
    load();
    const name = String(input.name || '').trim();
    if (!name) return { ok: false, error: 'NEED_NAME', message: 'Give the tool server a short name (for example "files").' };
    if (!NAME_RE.test(name)) return { ok: false, error: 'BAD_NAME', message: 'Use a short name (up to 40 letters, numbers, spaces, - or _).' };
    if (find(name)) return { ok: false, error: 'NAME_TAKEN', message: `There is already a tool server called "${name}". Pick another name, or remove the old one first.` };
    if (entries.size >= MAX_SERVERS) return { ok: false, error: 'TOO_MANY', message: `You can keep up to ${MAX_SERVERS} tool servers. Remove one first.` };
    const line = String(input.line || input.url || '').trim();
    let transport = input.transport === 'http' || /^https?:\/\//i.test(line) ? 'http' : 'stdio';
    let command = ''; let args = []; let url = '';
    if (transport === 'http') {
      url = line;
      let u = null; try { u = new URL(url); } catch (_) { u = null; }
      if (!u || !/^https?:$/.test(u.protocol)) return { ok: false, error: 'BAD_URL', message: 'That is not a web address. It should look like http://127.0.0.1:3000/mcp' };
    } else {
      if (input.command) { command = String(input.command).trim(); args = Array.isArray(input.args) ? input.args.map(String) : []; }
      else { const parts = splitCommandLine(line); command = parts[0] || ''; args = parts.slice(1); }
      if (!command) return { ok: false, error: 'NEED_COMMAND', message: 'Type the command that starts the tool server (for example: npx -y @modelcontextprotocol/server-filesystem C:\\Users\\me\\Documents) or its web address.' };
      if (command.length > 1000 || args.length > 60) return { ok: false, error: 'TOO_LONG', message: 'That command is too long.' };
    }
    const sec = parseSecrets(input.secrets);
    const strs = (x) => Object.fromEntries(Object.entries(x && typeof x === 'object' && !Array.isArray(x) ? x : {}).map(([k, v]) => [k, String(v == null ? '' : v).slice(0, 4000)]));
    const env = Object.assign({}, sec.env, strs(input.env));
    const headers = Object.assign({}, sec.headers, strs(input.headers));
    if (sec.bad.length) return { ok: false, error: 'BAD_SECRETS', message: `I couldn't read these lines: ${sec.bad.join(', ')}. Write one per line: NAME=value (for a program) or Header-Name: value (for a web address).` };
    for (const k of Object.keys(env)) if (!ENV_KEY.test(k)) return { ok: false, error: 'BAD_SECRETS', message: `"${k.slice(0, 40)}" can't be a setting name (use letters, numbers and _).` };
    for (const k of Object.keys(headers)) if (!HEADER_KEY.test(k) || BLOCKED_HEADERS.has(k.toLowerCase())) return { ok: false, error: 'BAD_SECRETS', message: `"${k.slice(0, 40)}" can't be used as a header.` };
    if (transport === 'http' && Object.keys(env).length) return { ok: false, error: 'BAD_SECRETS', message: 'NAME=value lines are for tool servers that are programs. For a web address, write headers: Authorization: Bearer …' };
    if (transport === 'stdio' && Object.keys(headers).length) return { ok: false, error: 'BAD_SECRETS', message: 'Header lines (Name: value) are for web-address tool servers. For a program, write NAME=value.' };
    const spec = { id: slug(name), name, transport, command, args, url, env, headers, enabled: false, added: new Date().toISOString() };
    if (entries.has(spec.id)) return { ok: false, error: 'NAME_TAKEN', message: `There is already a tool server called "${name}".` };
    const e = { spec, client: null, unsaved: false, missing: [], keep: { env: {}, headers: {} } };
    entries.set(spec.id, e);
    const sv = save();
    log('added', { server: spec.id, transport, env: Object.keys(env).length, headers: Object.keys(headers).length, sealed: sv.sealed });
    changed();
    return { ok: true, server: publicOne(e), message: e.unsaved ? `Added "${name}". This PC can't store secrets encrypted, so its keys are kept only until AutoInjector closes.` : `Added "${name}".` };
  }

  // persist:false (a one-off start for a confirmed tool call) leaves "start with the app" as the user set it.
  async function start(ref, { persist = true } = {}) {
    const e = find(ref);
    if (!e) return { ok: false, error: 'NO_SERVER', message: `There is no tool server called "${String(ref || '').slice(0, 60)}".` };
    if (e.missing.length) return { ok: false, error: 'MISSING_SECRETS', message: `"${e.spec.name}" needs its secrets again (${e.missing.join(', ')}) — this PC couldn't unlock them. Remove it and add it again.`, server: publicOne(e) };
    if (persist) { e.spec.enabled = true; save(); }
    const r = await clientFor(e).start();
    syncRegistry(e);
    changed();
    return r.ok ? { ok: true, server: publicOne(e), message: `“${e.spec.name}” is connected · ${r.tools.length} tool${r.tools.length === 1 ? '' : 's'}.` } : { ok: false, error: r.error, message: r.message, server: publicOne(e) };
  }
  async function stop(ref, { keepEnabled = false } = {}) {
    const e = find(ref);
    if (!e) return { ok: false, error: 'NO_SERVER', message: `There is no tool server called "${String(ref || '').slice(0, 60)}".` };
    if (!keepEnabled) { e.spec.enabled = false; save(); }
    if (e.client) await e.client.stop();
    syncRegistry(e);
    changed();
    return { ok: true, server: publicOne(e), message: `Stopped “${e.spec.name}”.` };
  }
  async function remove(ref) {
    const e = find(ref);
    if (!e) return { ok: false, error: 'NO_SERVER', message: `There is no tool server called "${String(ref || '').slice(0, 60)}".` };
    if (e.client) await e.client.stop();
    if (o.toolProvider && typeof o.toolProvider.unregisterMcpServer === 'function') { try { o.toolProvider.unregisterMcpServer(e.spec.id); } catch (_) {} }
    entries.delete(e.spec.id);
    save();
    log('removed', { server: e.spec.id });
    changed();
    return { ok: true, message: `Removed “${e.spec.name}”.` };
  }
  /** Start the servers that were running when the app last closed. Nothing when none were added. */
  async function autoStart() {
    load();
    const todo = [...entries.values()].filter((e) => e.spec.enabled && !e.missing.length);
    const res = await Promise.allSettled(todo.map((e) => start(e.spec.id)));
    return { ok: true, started: res.filter((r) => r.status === 'fulfilled' && r.value.ok).length, of: todo.length };
  }
  /** Tools of the connected servers (optionally one server), with their input schemas. */
  function tools(ref) {
    load();
    const pick = ref ? [find(ref)].filter(Boolean) : [...entries.values()];
    const servers = pick.map((e) => { const p = publicOne(e); return { id: p.id, name: p.name, transport: p.transport, runsProgram: p.runsProgram, status: p.status, summary: p.summary }; });
    const out = [];
    for (const e of pick) {
      const st = e.client && e.client.status();
      if (!st || st.status !== 'connected') continue;
      for (const t of st.tools) out.push({ server: e.spec.name, serverId: e.spec.id, runsProgram: e.spec.transport === 'stdio', tool: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema });
    }
    return { ok: true, servers, tools: out, missing: ref && !pick.length ? String(ref).slice(0, 60) : undefined };
  }
  /** Call a tool. A stopped (or failed) server is started first — the user confirmed the call. */
  async function call(ref, tool, args, callOpts = {}) {
    const e = find(ref);
    if (!e) return { ok: false, error: 'NO_SERVER', message: `There is no tool server called "${String(ref || '').slice(0, 60)}".` };
    const c = clientFor(e);
    if (c.status().status !== 'connected') {
      const r = await start(e.spec.id, { persist: false }); // the user's Stop (enabled=false) stays as it was
      if (!r.ok) return r;
    }
    // The caller's own time limit (Alfred's mcp_call allows 180 s) — not the manager's default for every call.
    const timeoutMs = Number(callOpts && callOpts.timeoutMs) > 0 ? Math.min(Number(callOpts.timeoutMs), 600000) : undefined;
    return c.callTool(String(tool || ''), args && typeof args === 'object' && !Array.isArray(args) ? args : {}, timeoutMs ? { timeoutMs } : {});
  }
  /** App quit: stop every running server (keeps their "start with the app" state). */
  async function stopAll() {
    await Promise.allSettled([...entries.values()].filter((e) => e.client).map((e) => e.client.stop()));
    return { ok: true };
  }
  function killAll() { for (const e of entries.values()) { try { if (e.client) e.client.killNow(); } catch (_) {} } }
  function count() { load(); return entries.size; }

  return { list, add, start, stop, remove, autoStart, tools, call, stopAll, killAll, count, find: (r) => { const e = find(r); return e ? publicOne(e) : null; } };
}

module.exports = { createMcpManager, parseSecrets, slug };
