'use strict';
/*
 * fresh-chat.js — start a NEW chat in an AI pane before its conversation gets too long.
 *
 * Why: every Akọwe prompt (often 20,000–75,000 characters) used to be typed into whatever chat was open in the
 * pane, so a 40-chapter book (about 1,000 messages) piled into ONE endless conversation. Claude then refuses with
 * "Your message will exceed the length limit for this chat", ChatGPT gets very slow or says the conversation is too
 * long, and every message re-reads the whole chat (which also uses up the site's usage allowance faster).
 *
 * What it does (main.js asks it before typing each Akọwe prompt, so it never happens mid-request):
 *   - counts the Akọwe requests and the characters sent into (and answered in) the pane's current chat;
 *   - says "start a fresh chat now" after N requests (default 15) or about X characters (default 300,000), or at
 *     once when the site said the chat is full ('chat-full');
 *   - holds off while the AI is still writing, and while YOU have been using that pane yourself in the last few
 *     minutes (your own conversation is never swapped away under you — unless the site itself says it is full).
 *   - a NEW BOOK starts in a fresh chat (reason 'new-book'): Akọwe says which book (and which ⚡ run) each request is
 *     for; when that differs from the book of the pane's last Akọwe request, the chat is swapped first — otherwise
 *     the AI can take names or story details from the other book still in that chat (a user's run "invented" a pen
 *     name that was a character from their other book). The same book (a resume, ▶ Continue) keeps its chat. Same
 *     holds as above (never mid-answer, never under the user). Setting: newBook (default on).
 * The page scripts click the site's own "New chat" button (several selectors, then a "New chat" label match); if
 * that doesn't give an empty chat, main.js opens the site's new-chat address instead.
 *
 * Electron-free and pure (state in a closure), unit-tested in test/fresh-chat.test.js.
 */

const MARKER = '__AUTOINJECTOR_FRESHCHAT__';

// The sites' own "New chat" controls (2026 DOM), most specific first. A label match ("New chat") runs after these.
const NEW_CHAT_CANDIDATES = {
  chatgpt: [
    'a[data-testid="create-new-chat-button"]',
    'button[data-testid="create-new-chat-button"]',
    'button[data-testid="new-chat-button"]',
    'a[aria-label="New chat"]',
    'button[aria-label="New chat"]',
    'nav a[href="/"]'
  ],
  claude: [
    'a[data-testid="new-chat-button"]',
    'button[data-testid="new-chat-button"]',
    'a[aria-label="New chat"]',
    'button[aria-label="New chat"]',
    'a[href="/new"]'
  ],
  gemini: [
    '[data-test-id="new-chat-button"] button',
    '[data-test-id="new-chat-button"] a',
    '[data-test-id="new-chat-button"]',
    'button[aria-label="New chat"]',
    'a[aria-label="New chat"]',
    'side-nav-action-button[data-test-id="new-chat-button"]'
  ]
};
const LABEL_WORDS = ['new chat', 'new conversation', 'start new chat'];

const DEFAULTS = Object.freeze({
  everyRequests: 15,       // a fresh chat after this many Akọwe requests in one chat (0 = never by count)
  everyChars: 300000,      // …or after about this many characters went through the chat (0 = never by size)
  userQuietMs: 10 * 60000, // the user's own use of the pane in the last 10 minutes holds a planned fresh chat back
  newBook: true            // a new book (or ⚡ run of another book) starts each pane it uses in a fresh chat
});

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** { id, run } from what Akọwe sent (ids only; anything else is dropped) -> null when it names no book. */
function cleanBook(b) {
  if (!b || typeof b !== 'object') return null;
  const id = typeof b.id === 'string' && ID_RE.test(b.id) ? b.id : null;
  const run = typeof b.run === 'string' && ID_RE.test(b.run) ? b.run : null;
  return id || run ? { id, run } : null;
}
/**
 * Is `cur` another book than `prev` (the book of the pane's last Akọwe request)?
 *   both name a book -> compare the books (a new ⚡ run that continues the SAME book keeps its chat);
 *   otherwise both name a run -> compare the runs (a new run's first steps come before its book exists);
 *   nothing known about the last one -> yes (the chat may hold anything: another book, the user's own chat).
 */
function isNewBook(prev, cur) {
  if (!cur) return false;
  if (!prev) return true;
  if (cur.id && prev.id) return cur.id !== prev.id;
  if (cur.run && prev.run) return cur.run !== prev.run;
  return false;
}

const clampInt = (v, lo, hi, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };

function createFreshChat(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const cfg = {
    everyRequests: clampInt(opts.everyRequests, 0, 500, DEFAULTS.everyRequests),
    everyChars: clampInt(opts.everyChars, 0, 50000000, DEFAULTS.everyChars),
    userQuietMs: clampInt(opts.userQuietMs, 0, 24 * 3600000, DEFAULTS.userQuietMs),
    newBook: opts.newBook === undefined ? DEFAULTS.newBook : opts.newBook !== false
  };
  const S = {};
  const site = (s) => (S[s] = S[s] || { requests: 0, chars: 0, full: false, since: now(), fresh: 0, book: null, newBook: false });


  /** An Akọwe prompt of `chars` characters was typed into this pane's current chat. */
  function noteSent(s, chars) { const x = site(s); x.requests++; x.chars += Math.max(0, Number(chars) || 0); }
  /** Its answer (`chars` long) landed in the same chat — the chat grew by that much too. */
  function noteReply(s, chars) { site(s).chars += Math.max(0, Number(chars) || 0); }
  /** The site said "this chat is too long / start a new chat". */
  function markFull(s) { site(s).full = true; }
  /** A new chat was opened (by us, by self-repair, or by the user's "fresh chat" button). */
  function reset(s) { const x = site(s); x.requests = 0; x.chars = 0; x.full = false; x.since = now(); x.fresh++; x.newBook = false; }
  /**
   * The next Akọwe request to `s` is for this book ({ id, run }). A different book than the last one marks the
   * pane's chat for a fresh start (reason 'new-book') — kept until a fresh chat really happens (a hold by the
   * user only delays it). A chat this app opened that nothing went into yet needs no new one.
   * -> { changed } (changed: another book than the last one)
   */
  function noteBook(s, book) {
    const cur = cleanBook(book);
    if (!cur) return { changed: false };
    const x = site(s);
    const prev = x.book;
    const changed = isNewBook(prev, cur);
    // remember the most complete name of the book: a run's first steps say only the run, later ones the book too
    x.book = !changed && prev ? { id: cur.id || prev.id, run: cur.run || prev.run } : cur;
    const emptyChat = x.fresh > 0 && x.requests === 0 && x.chars === 0;
    if (changed && cfg.newBook && !emptyChat) x.newBook = true;
    return { changed };
  }
  /** The book of each pane's last Akọwe request, from an earlier start of the app (saved with the settings). */
  function restoreBooks(map) {
    if (!map || typeof map !== 'object') return;
    for (const [s, b] of Object.entries(map)) { const c = cleanBook(b); if (c && !site(s).book) site(s).book = c; }
  }
  function books() { const o = {}; for (const k of Object.keys(S)) if (S[k].book) o[k] = Object.assign({}, S[k].book); return o; }

  /**
   * Should a fresh chat be started before the next Akọwe prompt to `s`?
   *   ctx.busy: the AI is still writing / something is being sent (never then);
   *   ctx.userAt: when the user last used this pane themselves (typing in it, or their own relay conversation).
   * -> { due, reason: 'full'|'requests'|'chars'|null, held: 'busy'|'user'|null, requests, chars }
   */
  function due(s, ctx = {}) {
    const x = site(s);
    const out = { due: false, reason: null, held: null, requests: x.requests, chars: x.chars };
    if (x.full) out.reason = 'full';
    else if (x.newBook && cfg.newBook) out.reason = 'new-book';
    else if (cfg.everyRequests > 0 && x.requests >= cfg.everyRequests) out.reason = 'requests';
    else if (cfg.everyChars > 0 && x.chars >= cfg.everyChars) out.reason = 'chars';
    if (!out.reason) return out;
    if (ctx.busy) { out.held = 'busy'; return out; }
    const userAt = Number(ctx.userAt) || 0;
    // a full chat can't be used anyway; a planned one waits until the user has left the pane alone for a while
    if (out.reason !== 'full' && userAt && now() - userAt < cfg.userQuietMs) { out.held = 'user'; return out; }
    out.due = true;
    return out;
  }

  function settings(patch) {
    if (patch && typeof patch === 'object') {
      if (patch.everyRequests !== undefined) cfg.everyRequests = clampInt(patch.everyRequests, 0, 500, cfg.everyRequests);
      if (patch.everyChars !== undefined) cfg.everyChars = clampInt(patch.everyChars, 0, 50000000, cfg.everyChars);
      if (patch.userQuietMs !== undefined) cfg.userQuietMs = clampInt(patch.userQuietMs, 0, 24 * 3600000, cfg.userQuietMs);
      if (patch.newBook !== undefined) cfg.newBook = patch.newBook !== false;
    }
    return Object.assign({}, cfg);
  }
  function snapshot() { const o = {}; for (const k of Object.keys(S)) o[k] = Object.assign({}, S[k]); return o; }
  return { noteSent, noteReply, markFull, reset, noteBook, books, restoreBooks, due, settings, snapshot };
}

/** Plain words for the activity log. */
function describe(label, reason, info) {
  const L = label || 'the AI';
  const i = info || {};
  const n = Number(i.requests) || 0;
  const k = Math.round((Number(i.chars) || 0) / 1000);
  if (reason === 'full') return `${L} said its chat is full, so AutoInjector started a fresh ${L} chat for Akọwe`;
  if (reason === 'new-book') return `Started a fresh ${L} chat for Akọwe's new book — nothing from the last book's chat (names, story details) can slip into this one`;
  const why = reason === 'requests' ? `the old one already had ${n} Akọwe requests` : `about ${k.toLocaleString('en-US')},000 characters had gone through the old one`;
  return `Started a fresh ${L} chat for Akọwe (${why}) — long chats get slow and hit the site's length limit`;
}
function describeHeld(label, held, reason) {
  const L = label || 'the AI';
  if (reason === 'new-book') {
    return held === 'user'
      ? `Akọwe started another book, but you've used ${L}'s pane yourself in the last few minutes, so AutoInjector left your conversation alone for now (a fresh chat comes with a later request)`
      : `Akọwe started another book; a fresh ${L} chat starts once ${L} has finished what it is doing`;
  }
  return held === 'user'
    ? `${L}'s chat is getting long, but you've used that pane yourself in the last few minutes, so AutoInjector left your conversation alone for now`
    : `${L}'s chat is getting long; a fresh chat starts once ${L} has finished what it is doing`;
}

/** Page script: click the site's "New chat" control. -> { ok, clicked: 'selector' | 'label' | null } */
function buildNewChatScript(s, extra) {
  const list = (NEW_CHAT_CANDIDATES[s] || []).concat(Array.isArray(extra) ? extra.filter((x) => typeof x === 'string') : []);
  const CFG = { list, words: LABEL_WORDS };
  return `(function(){ // ${MARKER} new-chat
  const CFG = ${JSON.stringify(CFG)};
  const vis = (el) => { try { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; } catch (_) { return false; } };
  for (const sel of CFG.list) {
    let el = null;
    try { el = Array.from(document.querySelectorAll(sel)).find(vis) || null; } catch (_) { el = null; }
    if (el) { try { el.click(); return { ok: true, clicked: sel }; } catch (_) {} }
  }
  const all = Array.from(document.querySelectorAll('a, button, [role="button"]'));
  for (const el of all) {
    const t = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).replace(/\\s+/g, ' ').trim().toLowerCase();
    if (!t || t.length > 40) continue;
    if (CFG.words.some((w) => t === w || t.startsWith(w + ' ') || t.endsWith(' ' + w)) && vis(el)) { try { el.click(); return { ok: true, clicked: 'label' }; } catch (_) {} }
  }
  return { ok: false, clicked: null };
})()`;
}

/** Page script: is the pane now an empty chat with its message box? -> { ok, replies, input, url } */
function buildFreshCheckScript(assistantSelectors, inputSelectors) {
  const CFG = { a: (assistantSelectors || []).filter((x) => typeof x === 'string'), i: (inputSelectors || []).filter((x) => typeof x === 'string') };
  return `(function(){ // ${MARKER} check
  const CFG = ${JSON.stringify(CFG)};
  let replies = 0; let input = false;
  for (const sel of CFG.a) { try { const n = document.querySelectorAll(sel).length; if (n > replies) replies = n; } catch (_) {} }
  for (const sel of CFG.i) { try { if (document.querySelector(sel)) { input = true; break; } } catch (_) {} }
  return { ok: true, replies, input, url: String(location.href || '') };
})()`;
}

module.exports = { createFreshChat, cleanBook, isNewBook, describe, describeHeld, buildNewChatScript, buildFreshCheckScript, NEW_CHAT_CANDIDATES, DEFAULTS, MARKER };
