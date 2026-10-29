'use strict';
/*
 * alfred-ai.js — Alfred's "brain" connections. Three kinds, all behind one next() call:
 *
 *   local  a local model through Ollama's OpenAI-compatible API (default http://127.0.0.1:11434/v1)
 *          with native tool calling ("tools" / "tool_calls").
 *   api    the AI already connected for the butler/manager (manager-provider config: RunPod,
 *          LM Studio, any OpenAI-compatible endpoint + key) — same request shape.
 *   pane   one of the web AIs (ChatGPT / Claude / Gemini) through AutoInjector's own send/capture
 *          path; tool calls are a small JSON text protocol because web chats have no tool API.
 *
 * Models that ignore "tools" but answer with a JSON object {"tool": "...", "args": {...}} are
 * understood too (the same text protocol), so a weaker local model still works.
 *
 * Nothing here logs: callers get structured results and decide what (codes only) to log.
 * Secrets (an API key) are redacted from every error detail that comes back.
 */
const client = require('./openai-client');

const DEFAULT_LOCAL_BASE = 'http://127.0.0.1:11434/v1';

function chatUrl(endpoint) {
  const e = String(endpoint || '').trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(e)) return e;
  return `${e}/chat/completions`;
}
function baseUrl(endpoint) { return String(endpoint || '').trim().replace(/\/chat\/completions.*$/, '').replace(/\/+$/, ''); }

let callSeq = 0;
function newCallId() { callSeq += 1; return `call_${Date.now().toString(36)}_${callSeq}`; }

/** A tool call written as text: {"tool":"x","args":{}} / {"name":"x","arguments":{}} / {"action":"x",...}. */
function textToolCall(content) {
  const obj = client.extractJsonObject(content);
  if (!obj || typeof obj !== 'object') return null;
  const name = typeof obj.tool === 'string' ? obj.tool : typeof obj.name === 'string' && (obj.arguments !== undefined || obj.args !== undefined) ? obj.name : null;
  if (!name) return null;
  let args = obj.args !== undefined ? obj.args : obj.arguments !== undefined ? obj.arguments : {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch (_) { /* validated later */ } }
  return { id: newCallId(), name: String(name), args, native: false };
}
/** {"reply":"..."} from the text protocol, else null. */
function textReply(content) {
  const obj = client.extractJsonObject(content);
  return obj && typeof obj.reply === 'string' ? obj.reply : null;
}

/** Normalize one OpenAI-style assistant message -> { content, toolCalls:[{id,name,args,native}] }. */
/** Reasoning models (qwen3, deepseek-r1 …) can put their thinking in the answer: <think>…</think>. Drop it. */
function stripThinking(text) {
  let t = String(text || '');
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
  if (/<\/think>/i.test(t)) t = t.slice(t.search(/<\/think>/i) + 8); // the opening tag was cut off
  if (/^\s*<think>/i.test(t)) t = ''; // thinking that never finished: nothing usable
  return t.trim();
}
function normalizeMessage(m) {
  const content = m && typeof m.content === 'string' ? stripThinking(m.content) : '';
  const calls = [];
  for (const tc of (m && Array.isArray(m.tool_calls) ? m.tool_calls : [])) {
    const fn = tc && (tc.function || tc);
    if (!fn || !fn.name) continue;
    let args = fn.arguments;
    if (typeof args === 'string') { try { args = args.trim() ? JSON.parse(args) : {}; } catch (_) { /* keep the string: validation explains */ } }
    calls.push({ id: tc.id || newCallId(), name: String(fn.name), args: args == null ? {} : args, native: true });
  }
  if (!calls.length && content) {
    const t = textToolCall(content);
    if (t) calls.push(t);
  }
  const reply = !calls.length ? (textReply(content) != null ? textReply(content) : content) : content;
  return { content: reply, toolCalls: calls };
}

/** POST an OpenAI-compatible chat completion with tools. Never throws. */
async function chatWithTools({ endpoint, apiKey, model, messages, tools, timeoutMs, signal, temperature }) {
  if (!endpoint) return { ok: false, kind: 'config', error: 'NO_ENDPOINT' };
  if (!model) return { ok: false, kind: 'config', error: 'NO_MODEL' };
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) { if (signal.aborted) return { ok: false, kind: 'cancelled' }; signal.addEventListener('abort', onAbort, { once: true }); }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1000, timeoutMs || 120000));
  try {
    const body = { model, messages, temperature: temperature == null ? 0.2 : temperature, stream: false };
    if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
    let res;
    try {
      res = await fetch(chatUrl(endpoint), {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        body: JSON.stringify(body), signal: controller.signal,
      });
    } catch (e) {
      if (signal && signal.aborted) return { ok: false, kind: 'cancelled' };
      if (timedOut || (e && e.name === 'AbortError')) return { ok: false, kind: 'timeout' };
      return { ok: false, kind: 'network', detail: client.redactSecrets(String(e && e.cause ? `${e.message} (${e.cause.code || e.cause.message || ''})` : e), apiKey) };
    }
    if (!res.ok) {
      let detail = ''; try { detail = await res.text(); } catch (_) { /* best effort */ }
      // A model/server without tool support often says so with a 400: let the caller retry without tools.
      return { ok: false, kind: 'http', status: res.status, detail: client.redactSecrets(String(detail).slice(0, 400), apiKey), noTools: res.status === 400 && /tool/i.test(detail) };
    }
    let j; try { j = await res.json(); } catch (_) { return { ok: false, kind: 'bad-body' }; }
    const m = j && j.choices && j.choices[0] && j.choices[0].message;
    if (!m) return { ok: false, kind: 'bad-body' };
    return { ok: true, message: normalizeMessage(m) };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// ---------------------------------------------------------------------------- Ollama's own API
// Ollama's OpenAI-compatible /v1 cannot set the context size, and Ollama's default (2–4k tokens) is far smaller
// than Alfred's tool list (~10k tokens): the model would silently lose its instructions and tools. Ollama's own
// /api/chat takes options.num_ctx per request, so a local brain on Ollama uses it (falls back to /v1 otherwise).
const nativeBases = new Map(); // base -> true (use /api/chat) | false (not Ollama: use /v1)
// Speed (PC test: ~1½ min per answer on a local model). Ollama RELOADS the model whenever num_ctx changes, and a
// reload also throws away its cached prompt (the ~11k-token tool list it would otherwise re-use between calls).
// contextFor() grows in 4k steps with the conversation, so one question (ask -> tool -> answer) and the next could
// each land on a different size: a reload + a full re-read of the tool list every time. The size is now STICKY per
// server + model: it only ever grows (with a 4k head-room the first time), so after the first call it stays put.
const ctxSticky = new Map();   // `${base}|${model}` -> num_ctx last used
// A model that refused "tools" once (HTTP 400) is asked with the text protocol straight away from then on,
// instead of a failing call + a retry on EVERY step.
const noToolsModels = new Set(); // `${base}|${model}`
function stickyContext(base, model, need) {
  const key = `${base}|${String(model || '').toLowerCase()}`;
  const prev = ctxSticky.get(key);
  const want = prev ? Math.max(prev, need) : Math.min(32768, need + 4096);
  ctxSticky.set(key, want);
  return want;
}
const ollamaBase = (endpoint) => baseUrl(endpoint).replace(/\/v1$/, '');
/** The context window a request needs: everything we send, with room for the answer, in 4k steps (8k–32k). */
function contextFor(messages, tools) {
  const chars = JSON.stringify(messages || []).length + JSON.stringify(tools || []).length;
  const tokens = Math.ceil(chars / 3.2) + 2048;
  return Math.min(32768, Math.max(8192, Math.ceil(tokens / 4096) * 4096));
}
/** OpenAI-shaped history -> Ollama /api/chat messages (tool calls carry objects, tool results carry tool_name). */
function toOllamaMessages(messages) {
  return (messages || []).map((m) => {
    if (m.role === 'tool') return { role: 'tool', content: String(m.content == null ? '' : m.content), tool_name: m.name || undefined };
    const out = { role: m.role, content: String(m.content == null ? '' : m.content) };
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      out.tool_calls = m.tool_calls.map((tc) => {
        const fn = tc.function || tc; let args = fn.arguments;
        if (typeof args === 'string') { try { args = args.trim() ? JSON.parse(args) : {}; } catch (_) { args = {}; } }
        return { function: { name: fn.name, arguments: args && typeof args === 'object' ? args : {} } };
      });
    }
    return out;
  });
}
async function ollamaChat({ endpoint, model, messages, tools, timeoutMs, signal, temperature }) {
  const base = ollamaBase(endpoint);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) { if (signal.aborted) return { ok: false, kind: 'cancelled' }; signal.addEventListener('abort', onAbort, { once: true }); }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1000, timeoutMs || 300000));
  try {
    const body = { model, messages: toOllamaMessages(messages), stream: false, keep_alive: '30m', options: { num_ctx: stickyContext(base, model, contextFor(messages, tools)), temperature: temperature == null ? 0.2 : temperature } };
    if (tools && tools.length) body.tools = tools;
    let res;
    try { res = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal }); }
    catch (e) {
      if (signal && signal.aborted) return { ok: false, kind: 'cancelled' };
      if (timedOut || (e && e.name === 'AbortError')) return { ok: false, kind: 'timeout' };
      return { ok: false, kind: 'network', detail: String(e && e.cause ? `${e.message} (${e.cause.code || e.cause.message || ''})` : e).slice(0, 300) };
    }
    if (!res.ok) {
      let detail = ''; try { detail = await res.text(); } catch (_) { /* best effort */ }
      return { ok: false, kind: 'http', status: res.status, detail: String(detail).slice(0, 400), noTools: res.status === 400 && /tool/i.test(detail), notOllama: res.status === 404 && !/model/i.test(detail) };
    }
    let j; try { j = await res.json(); } catch (_) { return { ok: false, kind: 'bad-body' }; }
    if (!j || !j.message) return { ok: false, kind: 'bad-body', notOllama: true };
    return { ok: true, message: normalizeMessage(j.message), numCtx: body.options.num_ctx };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}
/** Is this endpoint an Ollama server (it has /api/version)? Cached per address. */
async function isOllama(endpoint) {
  const base = ollamaBase(endpoint);
  if (nativeBases.has(base)) return nativeBases.get(base);
  let yes = false;
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 2500);
    try { const r = await fetch(`${base}/api/version`, { signal: c.signal }); if (r.ok) { const j = await r.json().catch(() => null); yes = !!(j && typeof j.version === 'string'); } } finally { clearTimeout(t); }
  } catch (_) { yes = false; }
  nativeBases.set(base, yes);
  return yes;
}
/** qwen3's documented switch to answer without a long thinking pass (faster, and nothing to strip). */
function withNoThink(messages, model) {
  if (!/qwen3/i.test(String(model || ''))) return messages;
  return messages.map((m, i) => (i === 0 && m.role === 'system' && !/\/no_think/.test(m.content) ? Object.assign({}, m, { content: `${m.content}\n/no_think` }) : m));
}

/** Is an OpenAI-compatible server answering? GET {base}/models. */
async function probe({ endpoint, apiKey, timeoutMs }) {
  const r = await client.probeModels({ endpoint: chatUrl(endpoint), apiKey, timeoutMs: timeoutMs || 4000 });
  return { reachable: !!r.reachable, ok: !!r.ok, status: r.status || null };
}

// ---------------------------------------------------------------------------- the text protocol (panes)
const TEXT_PROTOCOL = [
  'You are acting as Alfred, the assistant inside the AutoInjector app. You control the app ONLY through the tools listed below.',
  'Answer with exactly ONE JSON object and nothing else:',
  '  to use a tool:   {"tool": "<tool name>", "args": { ... }}',
  '  to answer me:    {"reply": "<short plain-English answer>"}',
  'Use only the tools listed. Never invent results; after a tool result arrives, answer from it.',
].join('\n');
function toolCatalogText(tools) {
  return tools.map((t) => {
    const f = t.function || t;
    const props = Object.keys((f.parameters && f.parameters.properties) || {});
    const req = (f.parameters && f.parameters.required) || [];
    return `- ${f.name}(${props.map((p) => (req.includes(p) ? p : `${p}?`)).join(', ')}): ${f.description}`;
  }).join('\n');
}
/** Turn the conversation into the next message to type into a web AI pane. */
function panePrompt(messages, tools) {
  const last = messages[messages.length - 1];
  if (last && (last.role === 'tool' || (last.role === 'user' && last._toolResult))) {
    const results = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'tool' || m._toolResult) results.unshift(`Result of ${m.name || m._tool || 'the tool'}: ${String(m.content).slice(0, 3000)}`);
      else break;
    }
    return `${results.join('\n\n')}\n\nReply with the next single JSON object (another {"tool": …} or your {"reply": …}).`;
  }
  const sys = messages.find((m) => m.role === 'system');
  const convo = messages.filter((m) => (m.role === 'user' && !m._toolResult) || (m.role === 'assistant' && m.content)).slice(-7, -1)
    .map((m) => `${m.role === 'user' ? 'Me' : 'You'}: ${String(m.content).slice(0, 600)}`);
  return [TEXT_PROTOCOL, '', 'Tools:', toolCatalogText(tools), sys ? `\nAbout the app: ${String(sys.content).slice(0, 1200)}` : '',
    convo.length ? `\nEarlier:\n${convo.join('\n')}` : '', '', `Me: ${String(last && last.content || '').slice(0, 4000)}`].join('\n');
}

/**
 * One brain step. cfg: { kind:'local'|'api'|'pane', endpoint, apiKey, model, site, timeoutMs }
 * deps.paneAsk(site, text, { timeoutMs, signal }) -> { ok, text } | { ok:false, error }
 * -> { ok:true, message:{content, toolCalls} } | { ok:false, kind, error?, status?, detail? }
 */
async function next(cfg, messages, tools, deps = {}, opts = {}) {
  if (cfg.kind === 'pane') {
    if (typeof deps.paneAsk !== 'function') return { ok: false, kind: 'config', error: 'NO_PANE' };
    const r = await deps.paneAsk(cfg.site, panePrompt(messages, tools), { timeoutMs: cfg.timeoutMs, signal: opts.signal });
    if (opts.signal && opts.signal.aborted) return { ok: false, kind: 'cancelled' };
    if (!r || !r.ok) return { ok: false, kind: r && r.error === 'TIMEOUT' ? 'timeout' : 'network', error: (r && r.error) || 'PANE_FAILED' };
    return { ok: true, message: normalizeMessage({ content: String(r.text || '') }) };
  }
  if (cfg.kind === 'local') messages = withNoThink(messages, cfg.model);
  if (cfg.kind === 'local' && !cfg.noNative && await isOllama(cfg.endpoint)) {
    const ntKey = `${ollamaBase(cfg.endpoint)}|${String(cfg.model || '').toLowerCase()}`;
    const textOnly = () => {
      const m2 = messages.slice(); m2.splice(1, 0, { role: 'system', content: `${TEXT_PROTOCOL}\n\nTools:\n${toolCatalogText(tools)}` });
      return ollamaChat({ endpoint: cfg.endpoint, model: cfg.model, messages: m2.map((m) => (m.role === 'tool' ? { role: 'user', content: `Result of ${m.name || 'the tool'}: ${m.content}` } : m)), tools: null, timeoutMs: cfg.timeoutMs, signal: opts.signal });
    };
    let n = noToolsModels.has(ntKey) && tools && tools.length ? await textOnly() : await ollamaChat({ endpoint: cfg.endpoint, model: cfg.model, messages, tools, timeoutMs: cfg.timeoutMs, signal: opts.signal });
    if (!n.ok && n.noTools) { noToolsModels.add(ntKey); n = await textOnly(); }
    if (n.ok || !n.notOllama) return n;
    nativeBases.set(ollamaBase(cfg.endpoint), false); // not Ollama after all: use /v1 from now on
  }
  const base = { endpoint: cfg.endpoint, apiKey: cfg.apiKey, model: cfg.model, timeoutMs: cfg.timeoutMs, signal: opts.signal };
  const ntKey = `${baseUrl(cfg.endpoint)}|${String(cfg.model || '').toLowerCase()}`;
  let r = noToolsModels.has(ntKey) && tools && tools.length ? { ok: false, noTools: true } : await chatWithTools(Object.assign({ messages, tools }, base));
  if (!r.ok && r.noTools) {
    noToolsModels.add(ntKey);
    // The model can't take "tools": explain the text protocol instead and ask again once.
    const m2 = messages.map((m) => (m.role === 'tool' ? { role: 'user', content: `Result of ${m.name || 'the tool'}: ${m.content}` } : m.role === 'assistant' && m.tool_calls ? { role: 'assistant', content: m.content || JSON.stringify({ tool: m.tool_calls[0].function.name, args: m.tool_calls[0].function.arguments }) } : m));
    m2.splice(1, 0, { role: 'system', content: `${TEXT_PROTOCOL}\n\nTools:\n${toolCatalogText(tools)}` });
    r = await chatWithTools(Object.assign({ messages: m2, tools: null }, base));
  }
  return r;
}

module.exports = { DEFAULT_LOCAL_BASE, chatUrl, baseUrl, chatWithTools, probe, next, normalizeMessage, panePrompt, textToolCall, TEXT_PROTOCOL, stripThinking, contextFor, toOllamaMessages, ollamaChat, isOllama, _resetOllamaCache: () => { nativeBases.clear(); ctxSticky.clear(); noToolsModels.clear(); }, stickyContext };
