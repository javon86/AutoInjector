#!/usr/bin/env node
'use strict';
/*
 * fake-bridge-host.js — runs the REAL ../../akowe-bridge.js HTTP server with
 * fake chat panes (no Electron), for cross-process tests of the Akọwe side
 * (contract v1: docs/AKOWE_AUTOINJECTOR_BRIDGE.md).
 *
 * Each fake pane's sendToSite records the prompt and, after --delay-ms, calls
 * bridge.onCaptured({ site, text }) with a reply produced by a responder, ending
 * in `[FROM: <SITE>]` exactly like a real pane reply.
 *
 * CLI (stable — a Python integration test depends on it):
 *   node test/fixtures/fake-bridge-host.js [options]
 *     --port N          port on 127.0.0.1 (default $AUTOINJECTOR_AKOWE_PORT or 17891; 0 = pick a free port)
 *     --token T         bearer token (default $AUTOINJECTOR_AKOWE_TOKEN or "fake-bridge-token-0123456789abcdef")
 *     --mode M          valid | invalid-then-valid | timeout | busy   (default $FAKE_BRIDGE_MODE or valid)
 *                         valid              every reply is the default schema-satisfying JSON answer
 *                         invalid-then-valid per site, odd-numbered replies (1st, 3rd, ...) are an invalid
 *                                            answer ({"invalid_sample": true}, required fields missing) and
 *                                            even-numbered ones are valid — i.e. each logical call needs one re-ask
 *                         timeout            prompts are recorded but never answered (-> 504 TIMEOUT)
 *                         busy               every site is pre-occupied by a never-answered internal request,
 *                                            so every /v1/complete returns 409 SITE_BUSY
 *     --delay-ms N      reply delay in ms (default 50)
 *     --time-scale F    multiply real waits (timeout_ms and the late window) by F, e.g. 0.01 so a
 *                       10000 ms timeout fires after 100 ms (default 1)
 *     --not-ready LIST  comma-separated sites that report ready:false (-> 503 SITE_NOT_READY)
 *     --responder PATH  module exporting ({ site, prompt, requestId, callIndex, mode }) => string | Promise<string>
 *                       returning the reply body; `[FROM: <SITE>]` is appended if the body has none.
 *                       Overrides the default responder (mode still controls timeout/busy).
 *     --record-file P   append one JSON line per received prompt: {"site","request_id","prompt"} (the
 *                       prompt as the pane would receive it, i.e. with the envelope instruction)
 *     --verbose         print bridge log events (never prompt/reply text) to stderr
 *     --pairing-code-file P   (contract v1.1) make a one-time pairing code with the bridge's
 *                       createPairingCode() and write it (just the code) to file P before READY.
 *                       Each SIGUSR2 (not on Windows) makes a new code and rewrites P.
 *     --status-file P   (contract v1.1) whenever Akọwe POSTs /v1/status, write the bridge's
 *                       sanitized view of it (status().akowe, JSON) to file P.
 *     --site-state LIST (contract v1.2) pin self-repair states, e.g.
 *                       "chatgpt=needs_user:LOGGED_OUT,gemini=repairing:NO_REPLY_FOUND" (state[:PROBLEM]).
 *                       Pinned sites show that state in /v1/health (ready:false unless ok/unknown) and
 *                       get 503 SITE_NOT_READY {state, problem} from /v1/complete. Other sites start
 *                       "unknown"; POST /v1/probe marks them "ok" (last_probe_ok_at = now) after --delay-ms.
 *                       Each SIGUSR1 (not on Windows) clears every pinned state (-> "ok"), so a test can
 *                       watch an AI recover.
 *   Env equivalents: AUTOINJECTOR_AKOWE_PORT, AUTOINJECTOR_AKOWE_TOKEN, FAKE_BRIDGE_MODE,
 *   FAKE_BRIDGE_DELAY_MS, FAKE_BRIDGE_TIME_SCALE. CLI flags win over env.
 *
 *   Prints exactly one line `READY <port>` on stdout once listening (and, in busy mode, once
 *   every site is occupied). Nothing else is written to stdout. SIGINT/SIGTERM stop it cleanly.
 *
 * Default responder: finds the LAST `JSON_SCHEMA:` line in the prompt, parses the JSON on the
 * following lines up to a line `END_JSON_SCHEMA`, and answers with a minimal object satisfying
 * it (strings "sample <field>", integers minimum-or-1, booleans true, arrays [] when minItems is
 * 0 else minItems sample items, enums/const first value, nullable -> null, objects recursively
 * with their required properties — or all properties when `required` is absent; local $ref,
 * allOf, anyOf/oneOf supported), wrapped in prose and a ```json fence. No schema -> {}.
 *
 * Also usable in-process: const { startFakeHost } = require('./fake-bridge-host');
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createBridge } = require('../../akowe-bridge');

const SITES = ['chatgpt', 'claude', 'gemini'];
const DEFAULT_TOKEN = 'fake-bridge-token-0123456789abcdef';

// --- schema -> minimal sample --------------------------------------------------
function extractSchema(prompt) {
  const lines = String(prompt || '').split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].trim() === 'JSON_SCHEMA:') start = i;
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === 'END_JSON_SCHEMA') break;
    body.push(lines[i]);
  }
  try { return JSON.parse(body.join('\n')); } catch (_) { return null; }
}

function resolveRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) return {};
  let node = root;
  for (const part of ref.slice(1).split('/').filter(Boolean)) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!node || typeof node !== 'object') return {};
    node = node[key];
  }
  return node || {};
}

function allowsNull(s) {
  if (!s || typeof s !== 'object') return false;
  if (s.nullable === true) return true;
  if (s.type === 'null') return true;
  if (Array.isArray(s.type) && s.type.includes('null')) return true;
  for (const k of ['anyOf', 'oneOf']) {
    if (Array.isArray(s[k]) && s[k].some((x) => x && (x.type === 'null' || (Array.isArray(x.type) && x.type.includes('null'))))) return true;
  }
  return false;
}

function sampleString(s, name) {
  if (s.format === 'date-time') return '2026-01-01T00:00:00Z';
  if (s.format === 'date') return '2026-01-01';
  if (s.format === 'uri' || s.format === 'url') return 'https://example.com/sample';
  if (s.format === 'email') return 'sample@example.com';
  if (s.format === 'uuid') return '00000000-0000-4000-8000-000000000000';
  let v = `sample ${name || 'value'}`;
  if (Number.isInteger(s.minLength) && v.length < s.minLength) v = v + 'x'.repeat(s.minLength - v.length);
  if (Number.isInteger(s.maxLength) && v.length > s.maxLength) v = v.slice(0, s.maxLength);
  return v;
}

function sampleNumber(s, integer) {
  let v;
  if (typeof s.minimum === 'number') v = s.minimum;
  else if (typeof s.exclusiveMinimum === 'number') v = integer ? Math.floor(s.exclusiveMinimum) + 1 : s.exclusiveMinimum + 1;
  else v = 1;
  if (integer) v = Math.ceil(v);
  if (typeof s.maximum === 'number' && v > s.maximum) v = integer ? Math.floor(s.maximum) : s.maximum;
  if (typeof s.exclusiveMaximum === 'number' && v >= s.exclusiveMaximum) v = integer ? Math.ceil(s.exclusiveMaximum) - 1 : s.exclusiveMaximum - 0.5;
  return v;
}

function sample(schema, root, name, depth) {
  const s = schema && typeof schema === 'object' ? schema : {};
  if (depth > 32) return null;
  if (s.$ref) return sample({ ...resolveRef(root, s.$ref), ...Object.fromEntries(Object.entries(s).filter(([k]) => k !== '$ref')) }, root, name, depth + 1);
  if (Array.isArray(s.allOf) && s.allOf.length) {
    const merged = { ...s };
    delete merged.allOf;
    for (const part of s.allOf) {
      const p = part && part.$ref ? resolveRef(root, part.$ref) : part || {};
      Object.assign(merged, p, {
        properties: { ...(merged.properties || {}), ...(p.properties || {}) },
        required: [...(merged.required || []), ...(p.required || [])]
      });
    }
    return sample(merged, root, name, depth + 1);
  }
  if ('const' in s) return s.const;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (allowsNull(s)) return null;
  for (const k of ['anyOf', 'oneOf']) {
    if (Array.isArray(s[k]) && s[k].length) return sample(s[k][0], root, name, depth + 1);
  }
  let type = s.type;
  if (Array.isArray(type)) type = type.find((t) => t !== 'null') || 'null';
  if (!type) type = s.properties ? 'object' : s.items ? 'array' : 'string';
  switch (type) {
    case 'object': {
      const props = s.properties || {};
      const keys = Array.isArray(s.required) ? s.required : Object.keys(props);
      const out = {};
      for (const k of keys) out[k] = sample(props[k] || {}, root, k, depth + 1);
      return out;
    }
    case 'array': {
      const min = Number.isInteger(s.minItems) ? s.minItems : 0;
      const out = [];
      for (let i = 0; i < min; i++) {
        let v = sample(s.items || {}, root, i === 0 ? name : `${name} ${i + 1}`, depth + 1);
        if (s.uniqueItems && typeof v === 'number') v += i;
        out.push(v);
      }
      return out;
    }
    case 'string': return sampleString(s, name);
    case 'integer': return sampleNumber(s, true);
    case 'number': return sampleNumber(s, false);
    case 'boolean': return true;
    case 'null': return null;
    default: return null;
  }
}

function sampleFromSchema(schema) {
  if (!schema || typeof schema !== 'object') return {};
  return sample(schema, schema, 'value', 0);
}

function fenced(obj, lead) {
  return `${lead}\n\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n\nLet me know if you need any changes.`;
}

function defaultResponder({ prompt, valid }) {
  if (!valid) return fenced({ invalid_sample: true }, 'Here is my attempt (deliberately invalid for testing):');
  return fenced(sampleFromSchema(extractSchema(prompt)), 'Sure — here is the JSON object you asked for.');
}

// --- host ------------------------------------------------------------------------
async function startFakeHost(options = {}) {
  const mode = options.mode || 'valid';
  if (!['valid', 'invalid-then-valid', 'timeout', 'busy'].includes(mode)) throw new Error(`unknown --mode ${mode}`);
  const token = options.token || DEFAULT_TOKEN;
  const delayMs = Number.isFinite(options.delayMs) ? options.delayMs : 50;
  const notReady = new Set(options.notReady || []);
  // contract v1.2: self-repair states per site ({ state, problem, since, last_probe_ok_at })
  const siteStates = {};
  for (const s of SITES) siteStates[s] = { state: 'unknown', problem: null, since: null, last_probe_ok_at: null };
  for (const [s, v] of Object.entries(options.siteStates || {})) if (siteStates[s]) siteStates[s] = { state: v.state, problem: v.problem || null, since: Date.now(), last_probe_ok_at: null, pinned: true };
  const probesStarted = [];
  const responder = options.responder || null;
  const recordFile = options.recordFile || null;
  const prompts = []; // { site, request_id, prompt }
  const callCount = { chatgpt: 0, claude: 0, gemini: 0 };
  const internalIds = new Set();
  let bridge = null;

  bridge = createBridge({
    port: options.port == null ? 17891 : options.port,
    host: '127.0.0.1',
    getToken: () => token,
    siteReady: (s) => !notReady.has(s),
    siteState: (s) => siteStates[s],
    startProbe: (want) => {
      const started = []; const skipped = {};
      for (const s of want || SITES) {
        if (notReady.has(s)) { skipped[s] = 'not_ready'; continue; }
        started.push(s);
        probesStarted.push(s);
        if (!siteStates[s].pinned) setTimeout(() => { siteStates[s] = { state: 'ok', problem: null, since: Date.now(), last_probe_ok_at: Date.now() }; }, delayMs);
      }
      return { started, skipped };
    },
    timeScale: options.timeScale || 1,
    logger: options.verbose ? (kind, detail) => process.stderr.write(`[bridge] ${kind} ${JSON.stringify(detail)}\n`) : undefined,
    sendToSite: async (site, text, meta) => {
      const requestId = meta && meta.request_id;
      if (internalIds.has(requestId)) return { ok: true, seq: '0000' }; // busy-mode occupier: never answered
      prompts.push({ site, request_id: requestId, prompt: text });
      if (recordFile) {
        try { fs.appendFileSync(recordFile, JSON.stringify({ site, request_id: requestId, prompt: text }) + '\n'); } catch (_) {}
      }
      callCount[site] = (callCount[site] || 0) + 1;
      const callIndex = callCount[site];
      const seq = String(prompts.length).padStart(4, '0');
      if (mode === 'timeout') return { ok: true, seq };
      const valid = mode !== 'invalid-then-valid' || callIndex % 2 === 0;
      setTimeout(async () => {
        let body;
        try {
          body = responder
            ? await responder({ site, prompt: text, requestId, callIndex, mode, valid })
            : defaultResponder({ prompt: text, valid });
        } catch (e) {
          body = `responder error: ${String(e && e.message || e)}`;
        }
        body = String(body == null ? '' : body);
        if (!/\[\s*FROM:/i.test(body)) body += `\n\n[FROM: ${site.toUpperCase()}]`;
        bridge.onCaptured({ site, text: body });
      }, delayMs);
      return { ok: true, seq };
    }
  });
  const addr = await bridge.start();

  if (mode === 'busy') {
    // Occupy every site with a never-answered request through the real HTTP path.
    for (const site of SITES) {
      const id = `fake-host-occupier-${site}`;
      internalIds.add(id);
      const data = Buffer.from(JSON.stringify({ site, prompt: 'occupy', request_id: id, timeout_ms: 900000 }));
      const req = http.request({ host: '127.0.0.1', port: addr.port, method: 'POST', path: '/v1/complete', agent: false,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': data.length } });
      req.on('error', () => {});
      req.on('response', (res) => res.resume());
      req.end(data);
    }
    for (let i = 0; i < 200; i++) {
      const st = bridge.status().sites;
      if (SITES.every((s) => notReady.has(s) || st[s].busy)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  return {
    port: addr.port,
    token,
    prompts,
    bridge,
    siteStates,
    probesStarted,
    clearSiteStates: () => { for (const s of SITES) if (siteStates[s].pinned) siteStates[s] = { state: 'ok', problem: null, since: Date.now(), last_probe_ok_at: Date.now() }; },
    stop: () => bridge.stop()
  };
}

// "chatgpt=needs_user:LOGGED_OUT,gemini=repairing" -> { chatgpt: { state, problem }, ... }
function parseSiteStates(spec) {
  const out = {};
  for (const part of String(spec || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^(chatgpt|claude|gemini)=(ok|repairing|needs_user|broken|unknown)(?::([A-Z][A-Z0-9_]{1,40}))?$/.exec(part);
    if (!m) throw new Error(`bad --site-state entry ${part}`);
    out[m[1]] = { state: m[2], problem: m[3] || null };
  }
  return out;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`missing value for ${a}`); return v; };
    if (a === '--port') out.port = Number(next());
    else if (a === '--token') out.token = next();
    else if (a === '--mode') out.mode = next();
    else if (a === '--delay-ms') out.delayMs = Number(next());
    else if (a === '--time-scale') out.timeScale = Number(next());
    else if (a === '--not-ready') out.notReady = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--responder') out.responderPath = next();
    else if (a === '--record-file') out.recordFile = next();
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--pairing-code-file') out.pairingCodeFile = next();
    else if (a === '--status-file') out.statusFile = next();
    else if (a === '--site-state') out.siteStates = parseSiteStates(next());
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

async function cli() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(2); }
  if (args.help) {
    const src = fs.readFileSync(__filename, 'utf8');
    process.stderr.write(src.slice(src.indexOf('/*'), src.indexOf('*/') + 2) + '\n');
    process.exit(0);
  }
  const env = process.env;
  const opts = {
    port: args.port != null ? args.port : env.AUTOINJECTOR_AKOWE_PORT != null && env.AUTOINJECTOR_AKOWE_PORT !== '' ? Number(env.AUTOINJECTOR_AKOWE_PORT) : 17891,
    token: args.token || env.AUTOINJECTOR_AKOWE_TOKEN || DEFAULT_TOKEN,
    mode: args.mode || env.FAKE_BRIDGE_MODE || 'valid',
    delayMs: args.delayMs != null ? args.delayMs : env.FAKE_BRIDGE_DELAY_MS ? Number(env.FAKE_BRIDGE_DELAY_MS) : 50,
    timeScale: args.timeScale != null ? args.timeScale : env.FAKE_BRIDGE_TIME_SCALE ? Number(env.FAKE_BRIDGE_TIME_SCALE) : 1,
    notReady: args.notReady || [],
    siteStates: args.siteStates || {},
    recordFile: args.recordFile || null,
    verbose: !!args.verbose
  };
  if (args.responderPath) {
    const mod = require(path.resolve(args.responderPath));
    opts.responder = typeof mod === 'function' ? mod : mod.respond || mod.default;
    if (typeof opts.responder !== 'function') { process.stderr.write('--responder module must export a function\n'); process.exit(2); }
  }
  let host;
  try { host = await startFakeHost(opts); }
  catch (e) { process.stderr.write(`fake-bridge-host failed to start: ${e && (e.code || e.message)}\n`); process.exit(1); }
  if (args.pairingCodeFile) {
    const writeCode = () => { try { fs.writeFileSync(args.pairingCodeFile, host.bridge.createPairingCode()); } catch (e) { process.stderr.write(`could not write pairing code file: ${e.code || e.message}\n`); } };
    writeCode();
    if (process.platform !== 'win32') process.on('SIGUSR2', writeCode);
  }
  if (args.statusFile) {
    let lastAt = null;
    const t = setInterval(() => {
      const b = host.bridge.akoweStatus();
      if (b && b.receivedAt !== lastAt) { lastAt = b.receivedAt; try { fs.writeFileSync(args.statusFile, JSON.stringify(b)); } catch (_) {} }
    }, 50);
    t.unref();
  }
  if (process.platform !== 'win32') process.on('SIGUSR1', () => host.clearSiteStates());
  process.stdout.write(`READY ${host.port}\n`);
  const shutdown = () => { host.stop().then(() => process.exit(0), () => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { startFakeHost, extractSchema, sampleFromSchema, defaultResponder, parseSiteStates };

if (require.main === module) cli();
