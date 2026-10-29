'use strict';
// transcript-rows.js — who wrote which message, on pages that show the chat as a
// list of ROWS (Claude's page since 2026-10-29), and what is page chrome.
//
// Claude's new page puts every message — the user's AND Claude's — in the same
// kind of row (div[data-testid="transcript-row"]), with a visually-hidden heading
// (h3[data-find-omitted]) and the text in the same kind of block for both. A CSS
// selector alone can no longer tell "Claude's reply" from "your own message", and
// a generic one matched the sidebar's recent-chats list (PC log 2026-10-29:
// replySelector div[data-testid="sidebar-recents"]). rowKit() answers both:
//
//   inChrome(el)      true inside the sidebar / history / navigation / page header
//                     (never a wrapper that also holds the message box or the chat)
//   classify(doc)     the rows in page order, each with a role ("user" |
//                     "assistant") decided from the strongest signal it has:
//                       1. role attributes (data-message-author-role, data-role, …)
//                       2. the site's known user / assistant markers inside the row
//                       3. the hidden heading's words ("You said:" / "Claude said:",
//                          any case) — only its first words, never the message
//                       4. streaming flag (data-is-streaming) — only the AI streams
//                       5. buttons: "Edit" only on the user's rows; Retry / feedback
//                          only on the AI's
//                       6. the user's initials avatar
//                     and, when a row has none of these, by alternation from its
//                     nearest known neighbour (user, AI, user, AI … when nothing at
//                     all is known).
//   rowOf(info, el)   the row an element belongs to (null outside every row, or
//                     for an element that holds several rows)
//
// rowKit is SELF-CONTAINED (no closure over module scope): automation.js and
// self-repair.js embed it by source (rowKit.toString()) into the scripts they run
// inside a pane, and the tests run the very same function on a fake DOM / Chromium.

const CONTENT_DEFAULT = ['[data-cds="Prose"]', '.standard-markdown', '.font-claude-response', '.font-claude-message', '.progressive-markdown', '.markdown', 'message-content'];
const USER_MARKERS_DEFAULT = ['[data-testid="user-message"]', '.font-user-message', 'user-query', '[data-message-author-role="user"]'];
const ASSISTANT_MARKERS_DEFAULT = ['.font-claude-response', '.font-claude-message', '[data-testid="assistant-message"]', '[data-message-author-role="assistant"]', 'model-response', '[data-is-streaming]'];

function rowKit(o) {
  const opt = o || {};
  const ROWS = Array.isArray(opt.rows) ? opt.rows.filter(Boolean) : [];
  const CONTENT = (opt.content || []).join(', ');
  const UM = (opt.userMarkers || []).join(', ');
  const AM = (opt.assistantMarkers || []).join(', ');
  const HEADING_ROWS = !!opt.headingRows;
  const ENABLED = ROWS.length > 0 || HEADING_ROWS;
  const CHROME = 'nav, aside, header, [role="navigation"], [role="complementary"], [role="banner"], [data-testid*="sidebar" i], [data-testid*="recents" i], [data-testid*="history" i], [aria-label*="sidebar" i], [aria-label*="recents" i], [aria-label*="chat history" i], [id*="sidebar" i]';
  const EDIT = 'textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]';
  const OVERLAY = '[data-autoinjector-overlay]';
  const HIDDEN_HEAD = '[data-find-omitted], .sr-only, .visually-hidden, .screen-reader-only';
  const HEADS = 'h1, h2, h3, h4, h5, h6, [role="heading"], ' + HIDDEN_HEAD;
  const ROLE_ATTRS = ['data-message-author-role', 'data-author-role', 'data-role', 'data-author', 'data-turn', 'data-sender', 'data-speaker'];
  const USER_W = /^(?:you|user|me|human)$/i;
  const ASST_W = /^(?:assistant|model|bot|ai|claude|gemini|chatgpt|agent)$/i;
  const STRONG_USER = /^\s*(?:you|user)\s+(?:said|wrote|asked|sent)\b/i;
  const STRONG_ASST = /^\s*(?:claude|assistant|chatgpt|gemini|the assistant|ai|model)\s+(?:said|says|responded|replied|wrote|answered)\b/i;
  const WEAK_USER = /^\s*(?:you|user|me)\b/i;
  const WEAK_ASST = /^\s*(?:claude|assistant|chatgpt|gemini|ai|model)\b/i;

  function qsa(root, sel) { if (!root || !sel) return []; try { return Array.from(root.querySelectorAll(sel)); } catch (_) { return []; } }
  function matches(e, sel) { try { return !!sel && !!e && e.nodeType === 1 && e.matches(sel); } catch (_) { return false; } }
  function closest(e, sel) { try { return e && e.closest ? e.closest(sel) : null; } catch (_) { return null; } }
  const text = (e) => { try { return String((e && e.textContent) || ''); } catch (_) { return ''; } };
  function tiny(e) { try { const r = e.getBoundingClientRect(); return r.width <= 2 || r.height <= 2; } catch (_) { return false; } }
  function outermost(list) { return list.filter((x) => !list.some((y) => y !== x && y.contains(x))); }
  function inOrder(list) { return list.slice().sort((a, b) => { try { return a.compareDocumentPosition(b) & 4 ? -1 : 1; } catch (_) { return 0; } }); }

  // ---- page chrome --------------------------------------------------------------
  // A chrome-looking element that also holds the message box or the conversation
  // is a layout wrapper (some apps wrap everything in a "with-sidebar" shell), not
  // chrome — so only a sidebar / header that holds neither counts.
  function holdsChat(c) {
    if (qsa(c, EDIT).length) return true;
    if (ROWS.length && qsa(c, ROWS.join(', ')).length) return true;
    return false;
  }
  function chromeRoot(e) { return matches(e, CHROME) && !holdsChat(e); }
  function inChrome(n) {
    let c = n && n.nodeType === 1 ? closest(n, CHROME) : (n && n.parentElement ? closest(n.parentElement, CHROME) : null);
    for (let i = 0; c && i < 12; i++) {
      if (!holdsChat(c)) return true;
      c = c.parentElement ? closest(c.parentElement, CHROME) : null;
    }
    return false;
  }

  // ---- one row's role ------------------------------------------------------------
  function headingRole(h, strongOnly) {
    const t = text(h).slice(0, 60);
    if (STRONG_USER.test(t)) return 'user';
    if (STRONG_ASST.test(t)) return 'assistant';
    if (strongOnly) return null;
    if (matches(h, HIDDEN_HEAD) || tiny(h)) {
      if (WEAK_USER.test(t)) return 'user';
      if (WEAK_ASST.test(t)) return 'assistant';
    }
    return null;
  }
  // a heading inside the message text (a markdown "## You should…") never counts
  function structuralHeading(h) { return matches(h, HIDDEN_HEAD) || !(CONTENT && closest(h, CONTENT)); }
  function says(e) { return headingRole(e, false); }
  function rowRole(row) {
    let u = 0, a = 0; const why = [];
    // 1. role attributes
    for (const n of [row].concat(qsa(row, ROLE_ATTRS.map((x) => '[' + x + ']').join(', ')))) {
      for (const at of ROLE_ATTRS) {
        const v = n.getAttribute ? String(n.getAttribute(at) || '').trim() : '';
        if (!v) continue;
        if (USER_W.test(v)) { u += 3; why.push('attr'); } else if (ASST_W.test(v)) { a += 3; why.push('attr'); }
      }
    }
    // 2. known markers
    const hasU = UM && (matches(row, UM) || qsa(row, UM).length > 0);
    const hasA = AM && (matches(row, AM) || qsa(row, AM).length > 0);
    if (hasU && !hasA) { u += 3; why.push('marker'); } else if (hasA && !hasU) { a += 3; why.push('marker'); }
    // 3. the hidden heading's first words
    for (const h of qsa(row, HEADS)) {
      if (!structuralHeading(h)) continue;
      const r = headingRole(h, false);
      if (r === 'user') { u += 3; why.push('heading'); break; }
      if (r === 'assistant') { a += 3; why.push('heading'); break; }
    }
    // 4. only the AI streams
    if (matches(row, '[data-is-streaming]') || qsa(row, '[data-is-streaming]').length) { a += 2; why.push('streaming'); }
    // the strong signals decided it: skip the costlier weak ones (this runs on every
    // poll, for every row of a long chat)
    if (u !== a) return u > a ? { role: 'user', sure: true, why: why.join('+') } : { role: 'assistant', sure: true, why: why.join('+') };
    // 5. buttons
    let bu = 0, ba = 0;
    for (const b of qsa(row, 'button, [role="button"]')) {
      const l = String((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '') + ' ' + (b.getAttribute('data-testid') || '') + ' ' + text(b).slice(0, 40)).toLowerCase();
      if (/\bedit\b/.test(l) && !/\bcode\b/.test(l)) bu++;
      if (/\b(retry|regenerate|try again|good response|bad response|thumbs|feedback)\b/.test(l)) ba++;
    }
    if (bu > ba) { u += 1; why.push('buttons'); } else if (ba > bu) { a += 1; why.push('buttons'); }
    // 6. the user's initials avatar (one or two capital letters on their own)
    if (u === a) for (const e of qsa(row, 'div, span').slice(0, 300)) {
      if (e.children && e.children.length) continue;
      if (CONTENT && closest(e, CONTENT)) continue;
      if (/^\s*[A-Z]{1,2}\s*$/.test(text(e))) { u += 1; why.push('avatar'); break; }
    }
    if (u > a) return { role: 'user', sure: true, why: why.join('+') };
    if (a > u) return { role: 'assistant', sure: true, why: why.join('+') };
    return { role: null, sure: false, why: '' };
  }

  // ---- the rows ------------------------------------------------------------------
  function headingRowList(doc) {
    const heads = qsa(doc.body || doc, HEADS).filter((h) => structuralHeading(h) && !inChrome(h) && !closest(h, OVERLAY) && headingRole(h, !matches(h, HIDDEN_HEAD)));
    if (!heads.length) return [];
    const tops = [];
    for (const h of heads) {
      let top = h;
      for (let i = 0; i < 16 && top.parentElement && top.parentElement.tagName !== 'BODY' && top.parentElement.tagName !== 'HTML'; i++) {
        const p = top.parentElement;
        if (heads.some((x) => x !== h && p.contains(x))) break;
        if (qsa(p, EDIT).length || closest(p, OVERLAY)) break;
        top = p;
      }
      if (tops.indexOf(top) === -1) tops.push(top);
    }
    return outermost(tops);
  }
  function findRows(doc) {
    for (const sel of ROWS) {
      const l = outermost(qsa(doc, sel).filter((e) => !inChrome(e) && !closest(e, OVERLAY)));
      if (l.length) return { rows: inOrder(l), how: 'selector', selector: sel };
    }
    if (HEADING_ROWS) {
      const l = headingRowList(doc);
      if (l.length) return { rows: inOrder(l), how: 'headings', selector: null };
    }
    return { rows: [], how: null, selector: null };
  }
  // -> { rows: [{ el, role, sure, why }], how, selector, lastUser, lastAsst, users, assistants }
  function classify(doc) {
    const empty = { rows: [], how: null, selector: null, lastUser: -1, lastAsst: -1, users: 0, assistants: 0 };
    if (!ENABLED || !doc) return empty;
    const f = findRows(doc);
    if (!f.rows.length) return empty;
    const rows = f.rows.map((el) => Object.assign({ el }, rowRole(el)));
    const known = rows.map((r, i) => (r.role ? i : -1)).filter((i) => i >= 0);
    const flip = (r) => (r === 'user' ? 'assistant' : 'user');
    rows.forEach((r, i) => {
      if (r.role) return;
      if (!known.length) { r.role = i % 2 === 0 ? 'user' : 'assistant'; r.why = 'order'; return; }
      let j = -1;
      for (let k = known.length - 1; k >= 0; k--) if (known[k] < i) { j = known[k]; break; }
      if (j < 0) j = known[0];
      r.role = Math.abs(i - j) % 2 === 0 ? rows[j].role : flip(rows[j].role);
      r.why = 'order';
    });
    let lastUser = -1, lastAsst = -1, users = 0, assistants = 0;
    rows.forEach((r, i) => { if (r.role === 'user') { lastUser = i; users++; } else { lastAsst = i; assistants++; } });
    return { rows, how: f.how, selector: f.selector, lastUser, lastAsst, users, assistants };
  }
  function rowOf(info, n) {
    if (!info || !info.rows || !n) return null;
    for (const r of info.rows) if (r.el === n || r.el.contains(n)) return r;
    return null;
  }
  // An element that holds one or more whole rows (a transcript wrapper).
  function holdsRows(info, n) {
    if (!info || !info.rows || !n) return [];
    return info.rows.filter((r) => r.el !== n && n.contains(r.el));
  }
  // The blocks of message text inside one row (outermost first, page order).
  function contentIn(row) { return CONTENT ? inOrder(outermost(qsa(row, CONTENT).filter((e) => !closest(e, OVERLAY)))) : []; }
  return { enabled: ENABLED, CHROME, HIDDEN_HEAD, inChrome, chromeRoot, classify, rowOf, holdsRows, contentIn, says, rowRole };
}

// The rowKit configuration for one site (from selectors.js): rows only where the
// site lists ROW_CANDIDATES; page-chrome filtering everywhere.
function rowConfigFor(SITES, site) {
  const cfg = (SITES && SITES[site]) || {};
  const rows = Array.isArray(cfg.ROW_CANDIDATES) ? cfg.ROW_CANDIDATES.slice() : [];
  return {
    rows,
    headingRows: rows.length > 0,
    content: (cfg.ROW_CONTENT_CANDIDATES || CONTENT_DEFAULT).slice(),
    userMarkers: (cfg.USER_MARKERS || USER_MARKERS_DEFAULT).slice(),
    assistantMarkers: (cfg.ASSISTANT_MARKERS || ASSISTANT_MARKERS_DEFAULT).slice()
  };
}

// A selector for the AI's reply / the user's message that names page chrome
// (the sidebar's recent chats, history, navigation) is never a usable one.
function isChromeSelector(sel) {
  return /sidebar|recents|history|\bnav\b|\baside\b|navigation|complementary|banner/i.test(String(sel || ''));
}

module.exports = { rowKit, rowConfigFor, isChromeSelector, CONTENT_DEFAULT, USER_MARKERS_DEFAULT, ASSISTANT_MARKERS_DEFAULT };
