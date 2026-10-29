/*
 * alfred-format.js — what Alfred SAYS, made readable (used by alfred.js in main and alfred-panel.js in the page).
 *
 * On the first real PC test his (correct) answer showed raw markdown marks (**, #, -) and JSON-like computer
 * words ({"status":"paused","needs_decision":true}, project_id, run_id). Two steps:
 *
 *   cleanReply(text)  main process, before the reply is stored: drops tool-call echoes and raw tool results,
 *                     turns a JSON object into plain "Status: paused" lines, and computer words (needs_decision,
 *                     project_id) into plain words. Markdown is KEPT — the panel shows it as formatting.
 *   toBlocks(text)    a tiny, safe markdown subset -> blocks: paragraphs, bullet / numbered lists, code blocks,
 *                     headings; inline **bold**, *italic*, `code`. The panel builds DOM nodes from these with
 *                     textContent only — never innerHTML — so nothing a model writes can inject HTML.
 *
 * Plain JS, no dependencies: CommonJS in Node, window.AlfredFormat in the page.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AlfredFormat = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // computer words a model copies out of tool results -> plain words
  const WORDS = {
    needs_decision: 'needs your decision', needs_you: 'needs you', ai_can: 'the AI can do it', project_id: 'book', run_id: 'run',
    record_id: 'item', branch_id: 'version', chapter_id: 'chapter', slot_id: 'AI slot', recent_events: 'recent events',
    steps_done: 'steps done', steps_total: 'steps in all', current_task: 'current step', working_on: 'working on',
    in_progress: 'in progress', not_started: 'not started', ok: 'OK',
  };
  const SKIP_KEYS = /^(id|run_id|project_id|record_id|branch_id|slot_id|chapter_id|request_id|tool_call_id|ok|error|notes|ignored_arguments)$/i;

  function humanKey(k) {
    const w = WORDS[k] || String(k).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
    return w.charAt(0).toUpperCase() + w.slice(1);
  }
  function humanValue(v) {
    if (v === true) return 'yes';
    if (v === false) return 'no';
    if (v == null) return '—';
    if (typeof v === 'string') return WORDS[v] || v;
    return String(v);
  }
  /** A parsed JSON value -> plain lines ("- Status: paused"). Ids and plumbing are left out; nesting is shallow. */
  function jsonToLines(v, depth) {
    const d = depth || 0;
    const out = [];
    if (Array.isArray(v)) {
      for (const x of v.slice(0, 12)) {
        if (x && typeof x === 'object') { const inner = jsonToLines(x, d + 1); if (inner.length) out.push(`- ${inner.map((l) => l.replace(/^- /, '')).join(', ')}`); }
        else out.push(`- ${humanValue(x)}`);
      }
      return out;
    }
    if (!v || typeof v !== 'object') return v == null ? [] : [humanValue(v)];
    if (typeof v.message === 'string' && d === 0 && Object.keys(v).every((k) => /^(ok|message|error|code)$/.test(k))) return [v.message];
    // a tool result {ok, message?, data}: what matters is the message and the data
    if (d === 0 && v.data !== undefined && Object.keys(v).every((k) => /^(ok|message|data|notes|error)$/.test(k))) {
      return [].concat(typeof v.message === 'string' ? [v.message] : [], jsonToLines(v.data, 0)).slice(0, 24);
    }
    for (const [k, x] of Object.entries(v)) {
      if (SKIP_KEYS.test(k)) continue;
      if (x && typeof x === 'object') {
        if (d >= 2) continue;
        const inner = jsonToLines(x, d + 1);
        if (inner.length) out.push(`- ${humanKey(k)}: ${inner.map((l) => l.replace(/^- /, '')).join('; ')}`);
      } else out.push(`- ${humanKey(k)}: ${humanValue(x)}`);
      if (out.length >= 16) break;
    }
    return out;
  }

  /** The balanced {...} / [...] starting at i, or -1. Strings are respected. */
  function matchEnd(s, i) {
    const stack = [];
    let inStr = false; let esc = false;
    for (let j = i; j < s.length && j < i + 20000; j++) {
      const c = s[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
      else if (c === '}' || c === ']') { if (stack.pop() !== c) return -1; if (!stack.length) return j; }
    }
    return -1;
  }
  function tryJson(t) { try { return JSON.parse(t); } catch (_) { return undefined; } }
  const isToolEcho = (o) => !!o && typeof o === 'object' && !Array.isArray(o) && (typeof o.tool === 'string' || (typeof o.name === 'string' && ('arguments' in o || 'args' in o)) || Array.isArray(o.tool_calls));

  /** Replace JSON objects/arrays in prose by plain lines (tool-call echoes are dropped). Code spans are left alone. */
  function replaceJson(text) {
    let out = '';
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '`') { // keep `code` and ```blocks``` as they are (handled elsewhere)
        const fence = text.startsWith('```', i) ? '```' : '`';
        const end = text.indexOf(fence, i + fence.length);
        if (end > i) { out += text.slice(i, end + fence.length); i = end + fence.length; continue; }
      }
      if ((c === '{' || c === '[') && /["{[\]]/.test(text.slice(i + 1, i + 3).replace(/\s/g, '').charAt(0) || '')) {
        const end = matchEnd(text, i);
        if (end > i) {
          const val = tryJson(text.slice(i, end + 1));
          if (val !== undefined && val !== null && typeof val === 'object') {
            if (!isToolEcho(val)) {
              const lines = jsonToLines(val);
              const before = out.replace(/[ \t]+$/, '');
              if (lines.length) out = `${before}${before && !/\n$/.test(before) ? '\n' : ''}${lines.join('\n')}\n`;
            }
            i = end + 1;
            if (out.endsWith('\n')) while (text[i] === ' ' || text[i] === '\t') i++;
            continue;
          }
        }
      }
      out += c; i++;
    }
    return out;
  }
  /** Known computer words (needs_decision, project_id …) -> plain words, outside `code`. Other names with
   *  underscores (dreamshaper_8, read_file, my_book.png) are real names and stay as they are. */
  function plainWords(line) {
    return line.split(/(`[^`]*`)/).map((part, k) => (k % 2 ? part : part.replace(/(^|[^\w./\\-])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?=$|[^\w./\\-])/g, (m, pre, w) => `${pre}${WORDS[w] || w}`))).join('');
  }

  /**
   * A model's reply -> what the user reads. Keeps markdown; removes computer leftovers.
   * Returns '' when nothing readable is left (the caller says "Done." or similar).
   */
  function cleanReply(text) {
    let t = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    // "Result of book_status: {...}" (the text protocol leaking back)
    t = t.replace(/^\s*Result of [\w-]+:\s*/gim, '');
    // fenced JSON blocks: ```json {...} ``` -> plain lines (a tool echo -> nothing)
    t = t.replace(/```(?:json|javascript|js)?\s*\n?([\s\S]*?)```/gi, (m, body) => {
      const v = tryJson(body.trim());
      if (v === undefined || v === null || typeof v !== 'object') return m;
      return isToolEcho(v) ? '' : `\n${jsonToLines(v).join('\n')}\n`;
    });
    t = replaceJson(t);
    // stray "key": value lines from a half-copied object
    t = t.replace(/^[ \t]*"([A-Za-z_][\w ]{0,40})"\s*:\s*("?)([^\n]*?)\2,?[ \t]*$/gm, (m, k, q, v) => (SKIP_KEYS.test(k) ? '' : `- ${humanKey(k)}: ${humanValue(v === 'true' ? true : v === 'false' ? false : v)}`));
    t = t.split('\n').map((l) => (/^\s*```/.test(l) ? l : plainWords(l))).join('\n');
    // inside fenced code blocks the words were left alone above only per-line; keep blocks intact
    t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return t;
  }

  // ---------------------------------------------------------------------------------------- markdown -> blocks
  /** Inline marks -> [{ t: 'text'|'b'|'i'|'code', v }]. */
  function inline(s) {
    const out = [];
    const push = (t, v) => { if (!v) return; const last = out[out.length - 1]; if (last && last.t === t && t === 'text') last.v += v; else out.push({ t, v }); };
    const re = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|(^|[\s(])\*([^*\s][^*\n]*?)\*(?=$|[\s.,;:!?)])|(^|[\s(])_([^_\s][^_\n]*?)_(?=$|[\s.,;:!?)])/g;
    let i = 0; let m;
    const str = String(s);
    while ((m = re.exec(str))) {
      push('text', str.slice(i, m.index));
      if (m[1] != null) push('code', m[1]);
      else if (m[2] != null || m[3] != null) push('b', m[2] != null ? m[2] : m[3]);
      else if (m[5] != null) { push('text', m[4]); push('i', m[5]); }
      else if (m[7] != null) { push('text', m[6]); push('i', m[7]); }
      i = re.lastIndex;
    }
    push('text', str.slice(i));
    return out;
  }
  /**
   * Text -> [{ type: 'p', spans } | { type: 'h', spans } | { type: 'ul'|'ol', items: [spans] } | { type: 'code', text }].
   */
  function toBlocks(text) {
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let para = null; let list = null;
    const endPara = () => { if (para) { blocks.push({ type: 'p', spans: inline(para.join('\n')) }); para = null; } };
    const endList = () => { if (list) { blocks.push(list); list = null; } };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = /^\s*```/.exec(line);
      if (fence) {
        endPara(); endList();
        const body = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
        blocks.push({ type: 'code', text: body.join('\n') });
        continue;
      }
      const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
      const ul = /^\s{0,6}[-*•+]\s+(.*)$/.exec(line);
      const ol = /^\s{0,6}(\d{1,3})[.)]\s+(.*)$/.exec(line);
      if (!line.trim()) { endPara(); endList(); continue; }
      if (h) { endPara(); endList(); blocks.push({ type: 'h', spans: inline(h[1]) }); continue; }
      if (ul || ol) {
        endPara();
        const type = ul ? 'ul' : 'ol';
        if (!list || list.type !== type) { endList(); list = { type, items: [] }; if (ol) list.start = Number(ol[1]) || 1; }
        list.items.push(inline(ul ? ul[1] : ol[2]));
        continue;
      }
      if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) { endPara(); endList(); continue; } // --- rules: dropped
      if (list && /^\s{2,}\S/.test(line)) { const last = list.items[list.items.length - 1]; last.push({ t: 'text', v: ' ' }, ...inline(line.trim())); continue; }
      endList();
      (para || (para = [])).push(line.replace(/^\s{0,3}>\s?/, ''));
    }
    endPara(); endList();
    return blocks;
  }
  /** The plain text of a reply without any marks (for the activity log, the Butler mirror, tooltips). */
  function plainText(text) {
    return toBlocks(text).map((b) => (b.type === 'code' ? b.text : b.type === 'ul' || b.type === 'ol' ? b.items.map((it) => `• ${it.map((s) => s.v).join('')}`).join('\n') : b.spans.map((s) => s.v).join(''))).join('\n');
  }

  return { cleanReply, toBlocks, inline, plainText, jsonToLines, WORDS };
}));
