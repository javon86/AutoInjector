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
function normalizeMessage(m) {
  const content = m && typeof m.content === 'string' ? m.content : '';
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
  const base = { endpoint: cfg.endpoint, apiKey: cfg.apiKey, model: cfg.model, timeoutMs: cfg.timeoutMs, signal: opts.signal };
  let r = await chatWithTools(Object.assign({ messages, tools }, base));
  if (!r.ok && r.noTools) {
    // The model can't take "tools": explain the text protocol instead and ask again once.
    const m2 = messages.map((m) => (m.role === 'tool' ? { role: 'user', content: `Result of ${m.name || 'the tool'}: ${m.content}` } : m.role === 'assistant' && m.tool_calls ? { role: 'assistant', content: m.content || JSON.stringify({ tool: m.tool_calls[0].function.name, args: m.tool_calls[0].function.arguments }) } : m));
    m2.splice(1, 0, { role: 'system', content: `${TEXT_PROTOCOL}\n\nTools:\n${toolCatalogText(tools)}` });
    r = await chatWithTools(Object.assign({ messages: m2, tools: null }, base));
  }
  return r;
}

module.exports = { DEFAULT_LOCAL_BASE, chatUrl, baseUrl, chatWithTools, probe, next, normalizeMessage, panePrompt, textToolCall, TEXT_PROTOCOL };
