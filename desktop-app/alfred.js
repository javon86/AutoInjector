'use strict';
/*
 * alfred.js — 🎩 Alfred, the user's assistant (the butler grown up): he can use everything in the
 * app through a FIXED tool registry (alfred-tools.js), asks before he changes anything, and keeps
 * a plain record of what he did.
 *
 *   Master switch   settings.enabled (default OFF). Off = no AI calls, no polling, no UI beyond
 *                   the switch, and every entry point answers { ok:false, error:'OFF' }.
 *   His AI          'auto' (local Ollama if it answers, else the connected API), 'local', 'api', or
 *                   'pane' (a web AI pane) — see alfred-ai.js.
 *   Safety          read-only tools run directly; tools that change or create something wait on an
 *                   "I will: …" card (✔ Do it / ✖ No); optional per-tool "always allow" for the
 *                   harmless ones. Unknown tools are refused. Max steps per request, a cancel,
 *                   timeouts, plain-English errors.
 *   Records         every executed action -> the activity log (tool name + fixed title + outcome code,
 *                   never prompts/prose/keys) and, for books, the Akọwe journal.
 *   Watcher         rule-based notices (no AI call) from app events, rate-limited.
 *
 * Electron-free: main.js injects everything (deps), the tests inject fakes.
 */
const fs = require('fs');
const path = require('path');
const registry = require('./alfred-tools');
const brainLib = require('./alfred-ai');

const DEFAULTS = Object.freeze({
  enabled: false,
  brain: 'auto',                 // auto | local | api | pane
  local: { endpoint: '', model: 'qwen2.5:7b' },
  pane: { site: 'chatgpt' },
  maxSteps: 8,                   // AI calls per request
  aiTimeoutMs: 120000,           // per AI call
  interpreter: false,            // the Open Interpreter tool (always asks first)
  alwaysAllow: {},               // { tool_name: true } — only tools marked allowAlways
  notices: true,                 // the proactive watcher
});
const NOTICE_MIN_GAP_MS = 5 * 60 * 1000;   // same notice at most every 5 minutes
const NOTICE_WINDOW_MS = 10 * 60 * 1000;   // and at most NOTICE_MAX notices per 10 minutes overall
const NOTICE_MAX = 6;
const BOOK_POLL_MS = 20000;
const HISTORY_MAX = 24;
const ACTIVITY_MAX = 60;

const SYSTEM_PROMPT = [
  'You are Alfred, the friendly butler inside AutoInjector, a desktop app on the user\'s own computer.',
  'The app holds Akọwe (the book-writing workspace), three web AIs (ChatGPT, Claude, Gemini), a local image generator, the output folders and logs.',
  'You act ONLY through the tools you are given. Use a tool whenever the user asks about or for something a tool covers; never pretend you did something a tool did not report.',
  'Tools that change or create something are shown to the user on an "I will" card and run only after they press Do it — so just call them; do not ask "shall I?" in prose first.',
  'Never try to approve book drafts for the user or get around Akọwe\'s own approvals: those decisions stay with the author.',
  'Prefer the direct tools. Use run_code (Open Interpreter) only if it is offered AND no other tool can do the job.',
  'Answer in short, plain, friendly English (a sentence or a few bullet points). Say plainly when something is not available yet.',
].join(' ');

const safeName = (s) => String(s == null ? '' : s).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) || '?';
function clone(v) { return JSON.parse(JSON.stringify(v)); }

function plainAiError(r, cfg) {
  const where = cfg.kind === 'pane' ? (registry.SITE_LABEL[cfg.site] || cfg.site) : cfg.kind === 'api' ? 'the connected AI' : `Ollama at ${brainLib.baseUrl(cfg.endpoint) || brainLib.DEFAULT_LOCAL_BASE}`;
  const tail = ' Everything else in the app still works.';
  switch (r && r.kind) {
    case 'timeout': return `My AI (${where}) took too long to answer, so I stopped.${tail}`;
    case 'network': return cfg.kind === 'local'
      ? `I can't reach my AI — nothing answered at ${brainLib.baseUrl(cfg.endpoint)}. Is Ollama running, with the model "${cfg.model}" pulled (ollama pull ${cfg.model})? Or choose a connected AI for me in 🎩 settings.${tail}`
      : `I can't reach my AI (${where}).${tail}`;
    case 'http': return r.status === 404 && cfg.kind !== 'pane'
      ? `My AI (${where}) doesn't have the model "${cfg.model}". Pull it (ollama pull ${cfg.model}) or pick another model in 🎩 settings.${tail}`
      : `My AI (${where}) answered with an error (HTTP ${r.status}).${tail}`;
    case 'config': return r.error === 'NO_AI' ? `I don't have an AI to think with yet: install Ollama and a model (see docs/ALFRED.md), or pick a connected AI in 🎩 settings.${tail}` : `My AI isn't set up (${r.error}). Open 🎩 settings.${tail}`;
    case 'bad-body': return `My AI (${where}) sent back something I couldn't read.${tail}`;
    default: return `Something went wrong talking to my AI (${where}).${tail}`;
  }
}

function withTimeout(p, ms, code) {
  let t;
  return Promise.race([p, new Promise((resolve) => { t = setTimeout(() => resolve({ ok: false, error: code || 'TIMEOUT', message: `That took too long (over ${Math.round(ms / 1000)} s), so I stopped waiting.` }), ms); })]).finally(() => clearTimeout(t));
}

/**
 * deps: {
 *   settingsFile, ctx (tool context, see alfred-tools.js), log(kind, detail), emit(payload),
 *   journal(pid, code, title) -> Promise, managerConfig() -> {endpoint, apiKey, model} | null,
 *   paneAsk(site, text, opts), managedOllama() -> {running, endpoint}, akoweReady() -> bool, now()
 * }
 */
function createAlfred(deps = {}) {
  const log = (k, d) => { try { if (deps.log) deps.log(k, d || {}); } catch (_) { /* never throw from logging */ } };
  const emit = (p) => { try { if (deps.emit) deps.emit(p); } catch (_) { /* UI may be gone */ } };
  const now = () => (deps.now ? deps.now() : Date.now());
  let settings = load();
  let history = [];            // the conversation (OpenAI message shapes; prose stays in memory only)
  let chat = [];               // what the panel shows: { role:'you'|'alfred'|'notice', text, ts }
  let activity = [];           // "what Alfred did": { ts, tool, title, text, ok, message, auto }
  let req = null;              // the request in progress
  let card = null;             // the "I will" card waiting for the user
  let seq = 0;
  let lastAi = { kind: null, ok: null, at: 0, model: null };
  const noticeLog = [];        // [{key, at}]
  let pollTimer = null;
  const runSeen = new Map();   // run id -> last status (book watcher)

  // ------------------------------------------------------------------ settings
  function load() {
    let s = {};
    try { if (deps.settingsFile && fs.existsSync(deps.settingsFile)) s = JSON.parse(fs.readFileSync(deps.settingsFile, 'utf8')) || {}; } catch (_) { s = {}; }
    return sanitize(Object.assign(clone(DEFAULTS), s));
  }
  function sanitize(s) {
    const out = clone(DEFAULTS);
    out.enabled = s.enabled === true;
    out.brain = ['auto', 'local', 'api', 'pane'].includes(s.brain) ? s.brain : 'auto';
    out.local = { endpoint: String((s.local && s.local.endpoint) || '').trim().slice(0, 300), model: String((s.local && s.local.model) || DEFAULTS.local.model).trim().slice(0, 120) || DEFAULTS.local.model };
    out.pane = { site: registry.SITES.includes(s.pane && s.pane.site) ? s.pane.site : 'chatgpt' };
    out.maxSteps = Math.min(20, Math.max(1, Math.round(Number(s.maxSteps) || DEFAULTS.maxSteps)));
    out.aiTimeoutMs = Math.min(600000, Math.max(5000, Math.round(Number(s.aiTimeoutMs) || DEFAULTS.aiTimeoutMs)));
    out.interpreter = s.interpreter === true;
    out.notices = s.notices !== false;
    out.alwaysAllow = {};
    for (const [k, v] of Object.entries(s.alwaysAllow || {})) { const t = registry.get(k); if (v === true && t && t.allowAlways) out.alwaysAllow[k] = true; }
    return out;
  }
  function save() {
    if (!deps.settingsFile) return;
    try { fs.mkdirSync(path.dirname(deps.settingsFile), { recursive: true }); fs.writeFileSync(deps.settingsFile, JSON.stringify(settings, null, 2)); } catch (_) { /* best effort */ }
  }
  function publicSettings() { return clone(settings); }
  function setSettings(patch) {
    if (!patch || typeof patch !== 'object') return publicSettings();
    const next = clone(settings);
    for (const k of ['brain', 'maxSteps', 'aiTimeoutMs', 'interpreter', 'notices']) if (k in patch) next[k] = patch[k];
    if (patch.local && typeof patch.local === 'object') next.local = Object.assign({}, next.local, patch.local);
    if (patch.pane && typeof patch.pane === 'object') next.pane = Object.assign({}, next.pane, patch.pane);
    if (patch.alwaysAllow && typeof patch.alwaysAllow === 'object') next.alwaysAllow = Object.assign({}, next.alwaysAllow, patch.alwaysAllow);
    const before = settings;
    settings = sanitize(Object.assign(next, { enabled: before.enabled }));
    save();
    log('alfred-settings', { brain: settings.brain, maxSteps: settings.maxSteps, interpreter: settings.interpreter, notices: settings.notices });
    emitState();
    return publicSettings();
  }

  // ------------------------------------------------------------------ master switch
  function setEnabled(on) {
    const want = on === true;
    if (want === settings.enabled) return status();
    settings.enabled = want;
    save();
    log(want ? 'alfred-on' : 'alfred-off', {});
    if (!want) {
      if (req) { req.cancelled = true; try { req.controller.abort(); } catch (_) {} }
      req = null; card = null;
      stopWatch();
    } else {
      startWatch();
    }
    emitState();
    return status();
  }

  // ------------------------------------------------------------------ which AI
  async function resolveBrain() {
    const base = { timeoutMs: settings.aiTimeoutMs };
    const localEndpoint = () => {
      if (settings.local.endpoint) return settings.local.endpoint;
      try { const m = deps.managedOllama && deps.managedOllama(); if (m && m.running && m.endpoint) return `${String(m.endpoint).replace(/\/+$/, '')}/v1`; } catch (_) {}
      return brainLib.DEFAULT_LOCAL_BASE;
    };
    const api = () => { try { const c = deps.managerConfig && deps.managerConfig(); return c && c.endpoint && c.model ? c : null; } catch (_) { return null; } };
    if (settings.brain === 'local') return Object.assign(base, { kind: 'local', endpoint: localEndpoint(), model: settings.local.model });
    if (settings.brain === 'pane') return Object.assign(base, { kind: 'pane', site: settings.pane.site, timeoutMs: Math.max(settings.aiTimeoutMs, 180000) });
    if (settings.brain === 'api') { const c = api(); return c ? Object.assign(base, { kind: 'api', endpoint: c.endpoint, apiKey: c.apiKey, model: c.model }) : Object.assign(base, { kind: 'api', missing: true }); }
    // auto: the local model when it answers, else the connected API
    const ep = localEndpoint();
    const pr = await brainLib.probe({ endpoint: ep, timeoutMs: 2500 });
    if (pr.reachable) return Object.assign(base, { kind: 'local', endpoint: ep, model: settings.local.model });
    const c = api();
    if (c) return Object.assign(base, { kind: 'api', endpoint: c.endpoint, apiKey: c.apiKey, model: c.model });
    return Object.assign(base, { kind: 'local', endpoint: ep, model: settings.local.model, unreachable: true });
  }
  function tools() { return registry.openAiTools({ interpreter: settings.interpreter }); }

  // ------------------------------------------------------------------ status / UI events
  function status() {
    return {
      ok: true, enabled: settings.enabled, settings: publicSettings(), busy: !!req && !card, card: card ? card.public : null,
      ai: lastAi, chat: chat.slice(-60), activity: activity.slice(-ACTIVITY_MAX),
      tools: registry.publicList({ interpreter: settings.interpreter }).map((t) => ({ name: t.name, title: t.title, group: t.group, changes: t.changes, allowAlways: t.allowAlways })),
      connected: connectedTools(),
    };
  }
  function connectedTools() {
    const c = deps.connected ? (() => { try { return deps.connected(); } catch (_) { return {}; } })() : {};
    return { akowe: !!(c.akowe), images: !!(c.images), video: !!(c.video), panes: c.panes || 0, interpreter: settings.interpreter && !!c.interpreter };
  }
  function emitState() { emit({ type: 'state', state: status() }); }
  function say(role, text, extra) {
    const m = Object.assign({ role, text: String(text || ''), ts: now() }, extra || {});
    chat.push(m); if (chat.length > 120) chat.splice(0, chat.length - 120);
    emit({ type: 'message', message: m });
    return m;
  }
  function trimHistory() {
    if (history.length <= HISTORY_MAX) return;
    // keep whole exchanges: cut at a user message so tool results never lose their call
    let cut = history.length - HISTORY_MAX;
    while (cut < history.length && !(history[cut].role === 'user' && !history[cut]._toolResult)) cut++;
    history = history.slice(cut);
  }
  function addActivity(entry) {
    activity.push(entry); if (activity.length > ACTIVITY_MAX) activity.shift();
    emit({ type: 'activity', entry });
  }

  // ------------------------------------------------------------------ running one tool
  async function execute(tool, args, { auto } = {}) {
    let r;
    try { r = await withTimeout(Promise.resolve().then(() => tool.run(args, deps.ctx || {})), tool.timeoutMs || 60000); }
    catch (e) { r = { ok: false, error: 'TOOL_ERROR', message: `Something went wrong while doing "${tool.title}".` }; }
    r = r && typeof r === 'object' ? r : { ok: false, error: 'TOOL_ERROR' };
    const entry = { ts: now(), tool: tool.name, title: tool.title, text: registry.describe(tool, args), ok: !!r.ok, message: String(r.message || (r.ok ? 'Done.' : r.error || 'failed')).slice(0, 400), auto: !!auto, image: r.image || null };
    if (tool.changes) addActivity(entry);
    // Activity log: the tool, its fixed title and the outcome code — never arguments, prompts or text.
    log('alfred-tool', { tool: tool.name, title: tool.title, changes: !!tool.changes, ok: !!r.ok, error: r.ok ? undefined : safeName(r.error), auto: auto || undefined });
    if (tool.changes && tool.book && r.ok && deps.journal) {
      const pid = r.project_id || (args && args.project_id) || null;
      if (pid) Promise.resolve(deps.journal(pid, tool.name, tool.title)).catch(() => {});
    }
    if (tool.name === 'generate_image' && r.ok) notice('image', `image:${r.image}`, `🎨 The image is ready: ${r.image}`, { force: true, image: r.image });
    return r;
  }
  function toolMessage(call, content) {
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    const c = text.length > 6000 ? `${text.slice(0, 6000)}… (cut)` : text;
    return call.native ? { role: 'tool', tool_call_id: call.id, name: call.name, content: c } : { role: 'user', _toolResult: true, _tool: call.name, content: `Result of ${call.name}: ${c}` };
  }
  function resultForAi(r) {
    const o = { ok: !!r.ok };
    if (r.message) o.message = r.message;
    if (r.error && !r.ok) o.error = r.error;
    if (r.data !== undefined) o.data = r.data;
    return o;
  }

  // ------------------------------------------------------------------ the loop
  async function ask(text) {
    if (!settings.enabled) return { ok: false, error: 'OFF', message: 'Alfred is off. Turn him on with the 🎩 switch.' };
    const t = String(text || '').trim();
    if (!t) return { ok: false, error: 'EMPTY' };
    if (req) return { ok: false, error: 'BUSY', message: card ? 'Please answer the card first (✔ Do it or ✖ No).' : "I'm still working on the last request — press ■ Stop to cancel it." };
    if (t.length > 6000) return { ok: false, error: 'TOO_LONG', message: 'That message is too long for me (6000 characters at most).' };
    seq += 1;
    req = { id: `req-${seq}`, steps: 0, cancelled: false, controller: new AbortController(), startedAt: now() };
    say('you', t);
    history.push({ role: 'user', content: t });
    trimHistory();
    log('alfred-ask', { req: req.id, chars: t.length });
    emitState();
    return loop(req);
  }

  async function loop(r) {
    const finish = (out) => {
      if (req === r) req = null;
      card = null;
      emitState();
      return Object.assign({ ok: true }, out);
    };
    const reply = (textOut, extra) => { say('alfred', textOut, extra); return finish(Object.assign({ type: 'reply', text: textOut }, extra || {})); };
    let cfg;
    try { cfg = await resolveBrain(); } catch (_) { cfg = { kind: 'local', endpoint: brainLib.DEFAULT_LOCAL_BASE, model: settings.local.model }; }
    for (;;) {
      if (r.cancelled) { log('alfred-cancel', { req: r.id, steps: r.steps }); return reply('Stopped. (Nothing else was done.)', { cancelled: true }); }
      if (r.steps >= settings.maxSteps) {
        log('alfred-steps-limit', { req: r.id, steps: r.steps });
        return reply(`I stopped after ${r.steps} steps (my limit for one request) so I don't go round in circles. Tell me what to do next, or ask in smaller pieces.`, { limit: true });
      }
      if (cfg.missing) { lastAi = { kind: cfg.kind, ok: false, at: now(), model: null }; log('alfred-ai-error', { brain: cfg.kind, code: 'NO_AI' }); return reply(plainAiError({ kind: 'config', error: 'NO_AI' }, cfg), { notice: true }); }
      r.steps += 1;
      const messages = [{ role: 'system', content: SYSTEM_PROMPT }].concat(history.map((m) => { const c = Object.assign({}, m); delete c._toolResult; delete c._tool; return c; }));
      let res;
      try { res = await brainLib.next(cfg, messages, tools(), { paneAsk: deps.paneAsk }, { signal: r.controller.signal }); }
      catch (_) { res = { ok: false, kind: 'network' }; }
      if (r.cancelled || (res && res.kind === 'cancelled')) { r.cancelled = true; continue; }
      if (!res || !res.ok) {
        lastAi = { kind: cfg.kind, ok: false, at: now(), model: cfg.model || cfg.site || null };
        log('alfred-ai-error', { brain: cfg.kind, code: safeName((res && (res.status ? `HTTP_${res.status}` : res.kind)) || 'error') });
        const lastMsg = history[history.length - 1];
        if (lastMsg && lastMsg.role === 'user' && !lastMsg._toolResult) history.pop(); // keep the conversation clean for next time
        return reply(plainAiError(res, cfg), { notice: true, unreachable: res && (res.kind === 'network' || res.kind === 'timeout') });
      }
      lastAi = { kind: cfg.kind, ok: true, at: now(), model: cfg.model || cfg.site || null };
      const msg = res.message;
      if (!msg.toolCalls.length) {
        const textOut = String(msg.content || '').trim() || 'Done.';
        history.push({ role: 'assistant', content: textOut });
        trimHistory();
        return reply(textOut);
      }
      // Record the assistant's tool calls (native shape when the model used native tool calling).
      const native = msg.toolCalls.filter((c) => c.native);
      if (native.length) history.push({ role: 'assistant', content: msg.content || '', tool_calls: native.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args || {}) } })) });
      else history.push({ role: 'assistant', content: msg.content || JSON.stringify({ tool: msg.toolCalls[0].name, args: msg.toolCalls[0].args }) });
      const pending = [];
      for (const call of msg.toolCalls.slice(0, 6)) {
        const tool = registry.get(call.name);
        if (!tool || (tool.interpreter && !settings.interpreter)) {
          log('alfred-refused', { req: r.id, tool: safeName(call.name), reason: tool ? 'INTERPRETER_OFF' : 'UNKNOWN_TOOL' });
          history.push(toolMessage(call, { ok: false, error: tool ? 'INTERPRETER_OFF' : 'UNKNOWN_TOOL', message: tool ? 'Open Interpreter is turned off in Alfred\'s settings.' : `There is no tool called "${safeName(call.name)}". Use only the listed tools.` }));
          continue;
        }
        const v = registry.validate(tool, call.args);
        if (!v.ok) {
          log('alfred-refused', { req: r.id, tool: tool.name, reason: 'BAD_ARGS' });
          history.push(toolMessage(call, { ok: false, error: 'BAD_ARGS', message: `The arguments for ${tool.name} were not right: ${v.error}.` }));
          continue;
        }
        if (tool.interpreter) {
          const direct = registry.directToolFor(`${v.args.code} ${v.args.why}`);
          if (direct) {
            log('alfred-refused', { req: r.id, tool: tool.name, reason: 'DIRECT_TOOL_EXISTS' });
            history.push(toolMessage(call, { ok: false, error: 'DIRECT_TOOL_EXISTS', message: `Don't use run_code for this — use ${direct}.` }));
            continue;
          }
        }
        if (!tool.changes) {
          const out = await execute(tool, v.args);
          history.push(toolMessage(call, resultForAi(out)));
          if (r.cancelled) break;
          continue;
        }
        if (tool.allowAlways && settings.alwaysAllow[tool.name]) {
          const out = await execute(tool, v.args, { auto: true });
          history.push(toolMessage(call, resultForAi(out)));
          if (r.cancelled) break;
          continue;
        }
        pending.push({ call, tool, args: v.args, text: registry.describe(tool, v.args) });
      }
      if (pending.length && !r.cancelled) {
        const id = `card-${seq}-${r.steps}`;
        card = {
          id, req: r, steps: pending,
          public: { id, intro: msg.content ? String(msg.content).slice(0, 600) : '', steps: pending.map((p, i) => ({ n: i + 1, tool: p.tool.name, title: p.tool.title, text: p.text, allowAlways: !!p.tool.allowAlways, code: p.tool.interpreter ? { language: p.args.language, code: p.args.code } : null })) },
        };
        log('alfred-card', { req: r.id, card: id, tools: pending.map((p) => p.tool.name) });
        emit({ type: 'card', card: card.public });
        emitState();
        return { ok: true, type: 'confirm', card: card.public };
      }
      // read-only results are in: let the AI continue (bounded by maxSteps)
    }
  }

  async function confirm(cardId, opts = {}) {
    if (!settings.enabled) return { ok: false, error: 'OFF' };
    if (!card || card.id !== cardId) return { ok: false, error: 'NO_CARD', message: 'That card is no longer waiting.' };
    const c = card;
    card = null;
    const allow = Array.isArray(opts.alwaysAllow) ? opts.alwaysAllow : [];
    let changed = false;
    for (const name of allow) { const t = registry.get(name); if (t && t.allowAlways && !settings.alwaysAllow[name]) { settings.alwaysAllow[name] = true; changed = true; } }
    if (changed) { save(); log('alfred-settings', { alwaysAllow: Object.keys(settings.alwaysAllow) }); }
    log('alfred-confirm', { req: c.req.id, card: c.id, tools: c.steps.map((s) => s.tool.name) });
    emitState();
    for (const s of c.steps) {
      if (c.req.cancelled) { history.push(toolMessage(s.call, { ok: false, error: 'CANCELLED', message: 'The user stopped it before this step; nothing was done.' })); continue; }
      const out = await execute(s.tool, s.args);
      history.push(toolMessage(s.call, resultForAi(out)));
    }
    return loop(c.req);
  }

  function reject(cardId) {
    if (!card || card.id !== cardId) return { ok: false, error: 'NO_CARD' };
    const c = card;
    card = null;
    for (const s of c.steps) history.push(toolMessage(s.call, { ok: false, error: 'DECLINED', message: 'The user said no. Nothing was done.' }));
    history.push({ role: 'assistant', content: "All right — I didn't do that." });
    log('alfred-reject', { req: c.req.id, card: c.id, tools: c.steps.map((s) => s.tool.name) });
    if (req === c.req) req = null;
    say('alfred', "All right — I didn't do that.");
    emitState();
    return { ok: true, type: 'reply', text: "All right — I didn't do that." };
  }

  function cancel() {
    if (!req) return { ok: true, idle: true };
    const r = req;
    r.cancelled = true;
    try { r.controller.abort(); } catch (_) {}
    if (card && card.req === r) {
      const c = card; card = null;
      for (const s of c.steps) history.push(toolMessage(s.call, { ok: false, error: 'CANCELLED', message: 'The user stopped it; nothing was done.' }));
      req = null;
      log('alfred-cancel', { req: r.id, steps: r.steps });
      say('alfred', 'Stopped. (Nothing else was done.)', { cancelled: true });
      emitState();
    }
    return { ok: true };
  }

  function clearChat() { history = []; chat = []; emitState(); return { ok: true }; }

  // ------------------------------------------------------------------ the watcher (rule-based, no AI call)
  function notice(kind, key, text, opts = {}) {
    if (!settings.enabled || !settings.notices) return false;
    const t = now();
    while (noticeLog.length && t - noticeLog[0].at > NOTICE_WINDOW_MS) noticeLog.shift();
    if (!opts.force) {
      if (noticeLog.some((n) => n.key === key && t - n.at < NOTICE_MIN_GAP_MS)) return false;
      if (noticeLog.length >= NOTICE_MAX) return false;
    }
    noticeLog.push({ key, at: t });
    log('alfred-notice', { kind });
    say('notice', text, { kind, image: opts.image || undefined });
    return true;
  }
  /** App events (main.js forwards broadcast channels here). Ignored entirely while Alfred is off. */
  function onAppEvent(channel, payload) {
    if (!settings.enabled || !settings.notices || !payload) return;
    if (channel === 'self-repair') {
      const ev = payload.event || {};
      const L = registry.SITE_LABEL[payload.site] || payload.site;
      if (ev.kind === 'fixed') notice('pane', `pane-fixed:${payload.site}`, `✔ ${L} had a problem and AutoInjector fixed it — it works again.`);
      else if (ev.kind === 'broken' || ev.kind === 'needs_user') notice('pane', `pane-broken:${payload.site}`, `⚠ ${L} isn't working right now${ev.code ? ` (${safeName(ev.code)})` : ''}. AutoInjector is trying to fix it; the other AIs carry on.`);
    } else if (channel === 'manager-log') {
      const e = payload || {};
      if (e.category === 'image' && /^Image rendered/.test(String(e.summary || ''))) notice('image', `image:${e.summary}`, `🎨 An image finished: ${String(e.summary).replace(/^Image rendered -> /, '')}`);
    }
  }
  function onRun(run) {
    if (!run || !run.id) return;
    const prev = runSeen.get(run.id);
    runSeen.set(run.id, run.status);
    // First sight of a run: quiet, unless it is already waiting for the author's decision.
    if (prev === undefined && !(run.status === 'paused' && run.problem && run.problem.record_id)) return;
    if (prev === run.status) return;
    const name = run.title ? `“${String(run.title).slice(0, 80)}”` : 'your book';
    if (run.status === 'paused') {
      const needs = run.problem && run.problem.record_id;
      notice('book', `run-${run.id}-paused`, needs ? `📖 The book run for ${name} paused and needs your decision (approve anyway / edit / try again) — open it in the 📖 Akọwe tab.` : `📖 The book run for ${name} paused${run.problem && run.problem.message ? `: ${String(run.problem.message).slice(0, 160)}` : '.'}`);
    } else if (run.status === 'done') notice('book', `run-${run.id}-done`, `📖 The book run for ${name} finished.`);
    else if (run.status === 'interrupted' || run.status === 'error') notice('book', `run-${run.id}-stop`, `📖 The book run for ${name} stopped (${run.status}). Ask me "resume the book run" or open the 📖 Akọwe tab.`);
    else if (run.status === 'cancelled') notice('book', `run-${run.id}-cancel`, `📖 The book run for ${name} was cancelled.`);
  }
  async function pollBooks() {
    if (!settings.enabled || !settings.notices) return;
    if (deps.akoweReady && !deps.akoweReady()) return;
    if (!deps.ctx || typeof deps.ctx.akowe !== 'function') return;
    let r;
    try { r = await deps.ctx.akowe('GET', '/api/autobook'); } catch (_) { return; }
    if (!r || r.status !== 200 || !r.json) return;
    for (const run of (r.json.runs || []).slice(0, 5)) onRun(run);
  }
  function startWatch() {
    stopWatch();
    if (deps.noTimers) return;
    pollTimer = setInterval(() => { pollBooks().catch(() => {}); }, deps.bookPollMs || BOOK_POLL_MS);
    if (pollTimer.unref) pollTimer.unref();
  }
  function stopWatch() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

  /** "Test my AI": one probe (no prompt is sent). */
  async function testAi() {
    if (!settings.enabled) return { ok: false, error: 'OFF' };
    const cfg = await resolveBrain();
    if (cfg.kind === 'pane') return { ok: true, kind: 'pane', site: cfg.site, message: `I'll think with ${registry.SITE_LABEL[cfg.site]} (its pane must be logged in).` };
    if (cfg.missing) return { ok: false, kind: cfg.kind, message: plainAiError({ kind: 'config', error: 'NO_AI' }, cfg) };
    const pr = await brainLib.probe({ endpoint: cfg.endpoint, apiKey: cfg.apiKey, timeoutMs: 4000 });
    lastAi = { kind: cfg.kind, ok: pr.reachable, at: now(), model: cfg.model };
    emitState();
    return pr.reachable ? { ok: true, kind: cfg.kind, model: cfg.model, message: `My AI answers (${cfg.kind === 'local' ? 'Ollama' : 'the connected AI'}, model ${cfg.model}).` } : { ok: false, kind: cfg.kind, message: plainAiError({ kind: 'network' }, cfg) };
  }

  if (settings.enabled) startWatch();

  return {
    status, getSettings: publicSettings, setSettings, setEnabled, ask, confirm, reject, cancel, clearChat, testAi,
    onAppEvent, pollBooks, notice, stopWatch,
    isEnabled: () => settings.enabled,
    _history: () => history, _resolveBrain: resolveBrain,
  };
}

module.exports = { createAlfred, DEFAULTS, SYSTEM_PROMPT, plainAiError, NOTICE_MAX };
