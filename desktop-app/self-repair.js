'use strict';
/*
 * self-repair.js — "AIs that always answer" (BookForge improvement plan, Section 1,
 * P18.1–P18.8 + P18.10). PURE NODE: no Electron import. main.js supplies the
 * pane-facing pieces (send a message, run a page script, reload, read state).
 *
 *   P18.1  Check-in probe: a tiny message "Reply with only this word: <word>" sent
 *          to an AI at start, every N minutes while it is idle, and on demand
 *          (BookForge POST /v1/probe). Its reply is owned here: never relayed to
 *          another AI, never shown in the conversation, never nagged about tags.
 *   P18.2  classify(evidence) -> one failure code (CODES). Page signals for log-in
 *          pages, "are you human" checks, usage limits and page errors live in ONE
 *          table (PAGE_SIGNATURES) that is easy to update.
 *   P18.3  Fix 1: built-in alternative selectors per site (ALT_SELECTORS) for the
 *          message box, Send button, reply blocks and the Stop button, tried in order.
 *   P18.4  Fix 2: page search — find the check-in word in a NEW element, walk up to
 *          a stable container selector, verify it, save it (learned, versioned,
 *          with a timestamp) and check in again.
 *   P18.6  Fix 3: reload the AI's window (then check in again); unfreeze a stuck AI
 *          (press its Stop button, wait, send the check-in once more).
 *   P18.7  Teach step: the user types "Repeat this number: ####" into the AI; a page
 *          watcher learns the message box, how it was sent, the user's message block
 *          and the reply block, saves them and confirms with a new check-in.
 *   P18.8  User-only problems (logged out / captcha / usage limit) -> state
 *          "needs_user" with exactly what to do; cheap signature checks every 60 s
 *          (and when the page changes), a check-in only once the signature is gone.
 *   P18.10 Every detection, step and result goes to deps.log('self-repair', …) —
 *          codes, site, step, outcome only, NEVER prompt/reply text — plus a small
 *          text-free event ring for diagnostics and the panel's "what was tried".
 *
 * Page scripts: every script built here is ONE expression string for
 * webContents.executeJavaScript(); the DOM logic lives in pageKit(), which is
 * embedded by source (pageKit.toString()) so the exact same code also runs in
 * Node tests against test/fake-dom.js. Scripts never return page text — only
 * booleans, counts, codes and CSS selectors.
 */
const crypto = require('crypto');

const MARKER = '__AUTOINJECTOR_SELFREPAIR__';
const LEARNED_VERSION = 1;

// ---- P18.2 failure codes -----------------------------------------------------------
const CODES = ['TYPE_FAILED', 'SEND_NOT_CONFIRMED', 'NO_REPLY_FOUND', 'FALSE_DUPLICATE', 'STUCK_GENERATING',
  'LOGGED_OUT', 'CAPTCHA', 'USAGE_LIMIT', 'NETWORK_ERROR', 'PAGE_ERROR', 'UNKNOWN'];
const USER_ONLY = new Set(['LOGGED_OUT', 'CAPTCHA', 'USAGE_LIMIT']);
const STATES = ['ok', 'repairing', 'needs_user', 'broken', 'unknown'];

// Plain words for each code (the panel, the log's "say" line and BookForge's 503 message).
const PROBLEM_TEXT = {
  TYPE_FAILED: { short: "can't type", say: (L) => `AutoInjector can't find or type into ${L}'s message box.` },
  SEND_NOT_CONFIRMED: { short: "can't send", say: (L) => `AutoInjector typed into ${L} but the message didn't go out (the Send button may have moved).` },
  NO_REPLY_FOUND: { short: "can't read replies", say: (L) => `${L} answered, but AutoInjector can't find its replies on the page.` },
  FALSE_DUPLICATE: { short: 'reply taken as old', say: (L) => `${L}'s new reply was mistaken for an old one.` },
  STUCK_GENERATING: { short: 'stuck writing', say: (L) => `${L} seems stuck — it keeps "writing" and never finishes.` },
  LOGGED_OUT: { short: 'logged out', say: (L) => `${L} is logged out.`, fix: (L) => [`Open ${L}'s window (its pane in AutoInjector) and log in.`, 'AutoInjector notices by itself when you are back and checks again — nothing else to do.'] },
  CAPTCHA: { short: 'human check', say: (L) => `${L} is showing an "are you a human?" check.`, fix: (L) => [`Open ${L}'s window and complete the check (tick the box / solve the puzzle).`, 'AutoInjector notices by itself when it is gone and checks again.'] },
  USAGE_LIMIT: { short: 'usage limit', say: (L) => `${L} says you've reached its usage limit.`, fix: (L) => [`Wait until the time ${L} shows in its window (or switch to another account / plan).`, 'AutoInjector re-checks every minute and carries on by itself when the limit is gone.', 'Meanwhile BookForge can use your other AIs.'] },
  NETWORK_ERROR: { short: "didn't load", say: (L) => `${L}'s page didn't load (no internet, or the site is down).` },
  PAGE_ERROR: { short: 'page error', say: (L) => `${L}'s page shows an error ("something went wrong").` },
  UNKNOWN: { short: 'not answering', say: (L) => `${L} didn't answer a check-in and AutoInjector couldn't tell why.` }
};
function describeProblem(code, label) {
  const t = PROBLEM_TEXT[code] || PROBLEM_TEXT.UNKNOWN;
  const L = label || 'the AI';
  return { code: PROBLEM_TEXT[code] ? code : 'UNKNOWN', short: t.short, say: t.say(L), fix: t.fix ? t.fix(L) : null, userOnly: USER_ONLY.has(code) };
}
const STEP_TEXT = {
  check: 'checked in', alternatives: 'tried other known ways to find things', page_search: 'searched the page for the reply',
  retry: 'checked in once more', unfreeze: 'pressed Stop and sent again', reload: 'reloaded the window',
  reload_home: 'opened a fresh page', teach: 'asked you to show it', signals: 'looked for log-in / limit messages'
};

// ---- P18.2 page signals: ONE table, easy to update ----------------------------------
// Each signature: { id, code, sites: ['*'] or a list, url (regex source, matched on the
// page URL), selector (any VISIBLE match), text (lower-case phrases), where: 'notices'
// (alert/dialog/toast/banner elements + the area around the message box) or 'page'
// (the whole page text — only used with noInput: true, i.e. when there is no message
// box, so a reply that merely talks about logging in never trips it). A signature hits
// when its url OR selector OR text matches. Order matters only for reporting.
const PAGE_SIGNATURES = [
  // logged out
  { id: 'login-url', code: 'LOGGED_OUT', sites: ['*'], url: '(?:/auth/login|/log-?in(?:[/?#]|$)|/signin|accounts\\.google\\.com/(?:v3/)?signin|auth\\.openai\\.com|/login\\?)' },
  { id: 'login-button', code: 'LOGGED_OUT', sites: ['chatgpt'], selector: 'button[data-testid="login-button"], a[data-testid="login-button"]', noInput: true },
  { id: 'login-link', code: 'LOGGED_OUT', sites: ['*'], selector: 'a[href*="/login"], a[href*="accounts.google.com/ServiceLogin"], a[href*="/signin"]', noInput: true },
  { id: 'login-text', code: 'LOGGED_OUT', sites: ['*'], where: 'page', noInput: true, text: ['log in', 'sign in', 'sign up', 'create account', 'continue with google', 'welcome back'] },
  // "are you a human?" checks
  { id: 'captcha-frame', code: 'CAPTCHA', sites: ['*'], selector: 'iframe[src*="challenges.cloudflare.com"], iframe[src*="recaptcha"], iframe[src*="hcaptcha.com"], iframe[title*="challenge"], #challenge-form, #challenge-stage, .cf-turnstile, #cf-challenge-running' },
  { id: 'captcha-url', code: 'CAPTCHA', sites: ['*'], url: '(?:/cdn-cgi/challenge|google\\.com/sorry/|/captcha)' },
  { id: 'captcha-text', code: 'CAPTCHA', sites: ['*'], where: 'page', noInput: true, text: ['verify you are human', 'are you a robot', 'unusual traffic', 'checking your browser', 'complete the security check', 'confirm you are human', 'just a moment'] },
  { id: 'captcha-notice', code: 'CAPTCHA', sites: ['*'], where: 'notices', text: ['verify you are human', 'are you a robot', 'confirm you are human'] },
  // usage limits (shown as a banner / near the message box, or instead of it)
  { id: 'limit-notice', code: 'USAGE_LIMIT', sites: ['*'], where: 'notices', text: ["you've reached your", 'you’ve reached your', 'you have reached your', 'usage limit', 'usage cap', "you've hit your limit", 'you’ve hit your limit', 'out of free messages', 'message limit', 'limit resets', 'limit will reset', 'reached the current usage cap', 'rate limit exceeded', 'too many requests', 'upgrade to continue', 'you are out of'] },
  { id: 'limit-page', code: 'USAGE_LIMIT', sites: ['*'], where: 'page', noInput: true, text: ['usage limit', 'usage cap', 'out of free messages', 'too many requests', 'limit resets'] },
  // page errors (auto-fix: reload)
  { id: 'error-notice', code: 'PAGE_ERROR', sites: ['*'], where: 'notices', text: ['something went wrong', 'network error', 'an error occurred', 'there was an error', 'error generating', 'unable to load', 'connection lost', 'conversation not found', 'failed to fetch', 'temporarily unavailable', 'internal server error', 'gone wrong', 'try reloading'] },
  { id: 'error-page', code: 'PAGE_ERROR', sites: ['*'], where: 'page', noInput: true, text: ["this site can't be reached", 'err_', 'bad gateway', 'service unavailable', '502', '503 service'] }
];
const NOTICE_SELECTOR = '[role="alert"], [role="alertdialog"], [role="dialog"], [role="status"], [aria-live="assertive"], [aria-live="polite"], [class*="toast"], [class*="banner"], [class*="snackbar"], [data-testid*="error"], [class*="error-message"], [class*="limit"], [data-testid*="limit"]';

function signaturesFor(site) { return PAGE_SIGNATURES.filter((s) => s.sites.includes('*') || s.sites.includes(site)); }

// ---- P18.3 built-in alternative selectors (best effort, 2026 DOM patterns) ----------
// Tried in order AFTER the selectors in selectors.js. Site lists first, then generic
// heuristics (role / aria / data-* attributes, "last assistant message" containers).
const ALT_SELECTORS = {
  chatgpt: {
    input: ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]', 'textarea[name="prompt-textarea"]', 'form [contenteditable="true"][role="textbox"]', 'form textarea[placeholder]'],
    send: ['#composer-submit-button', 'button[data-testid="send-button"]', 'button[data-testid="composer-send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label*="Send"]', 'form button[type="submit"]'],
    assistant: ['div[data-message-author-role="assistant"]', '[data-message-author-role="assistant"] .markdown', 'article[data-turn="assistant"]', '[data-turn="assistant"]', 'article[data-testid^="conversation-turn"] .markdown', 'div.markdown.prose', '.agent-turn .markdown'],
    stop: ['button[data-testid="stop-button"]', '#composer-submit-button[aria-label*="Stop"]', 'button[aria-label="Stop streaming"]', 'button[aria-label*="Stop"]'],
    user: ['[data-message-author-role="user"]', 'article[data-turn="user"]', '[data-turn="user"]']
  },
  claude: {
    input: ['div[contenteditable="true"].ProseMirror', '[data-testid="chat-input"]', 'div[aria-label*="prompt"][contenteditable="true"]', 'fieldset div[contenteditable="true"]', '[role="textbox"][contenteditable="true"]'],
    send: ['button[aria-label="Send message"]', 'button[aria-label="Send Message"]', 'button[data-testid="send-button"]', 'fieldset button[type="submit"]', 'button[aria-label*="Send"]'],
    assistant: ['div.font-claude-response', '.font-claude-response', 'div.font-claude-message', '[data-is-streaming] .standard-markdown', 'div.standard-markdown', '.progressive-markdown', '[data-testid="assistant-message"]'],
    stop: ['button[aria-label="Stop response"]', 'button[aria-label*="Stop"]', 'button[data-testid="stop-button"]'],
    user: ['[data-testid="user-message"]', '.font-user-message']
  },
  gemini: {
    input: ['rich-textarea .ql-editor[contenteditable="true"]', '.ql-editor[contenteditable="true"]', 'div[role="textbox"][contenteditable="true"]', '[aria-label*="prompt"][contenteditable="true"]', 'rich-textarea textarea'],
    send: ['button.send-button', 'button[aria-label="Send message"]', 'button[mattooltip="Send message"]', '.send-button-container button', 'button[aria-label*="Send"]'],
    assistant: ['model-response message-content .markdown', 'message-content .markdown', 'model-response .model-response-text', 'div.model-response-text', 'structured-content-container .markdown', '.response-content .markdown', 'model-response message-content', 'model-response'],
    stop: ['button.send-button.stop', 'button[aria-label="Stop response"]', 'button[aria-label*="Stop"]'],
    user: ['user-query', '.user-query', '.query-text']
  },
  generic: {
    input: ['[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]', '[contenteditable="plaintext-only"]', 'textarea'],
    send: ['button[type="submit"]', 'button[aria-label*="Send"]', 'button[aria-label*="send"]', 'button[data-testid*="send"]', '[role="button"][aria-label*="Send"]'],
    assistant: ['[data-message-author-role="assistant"]', '[data-role="assistant"]', '[data-author="assistant"]', '[data-turn="assistant"]', '[data-testid*="assistant"]', '[class*="assistant-message"]', '[class*="assistant"] .markdown', '[class*="response"] .markdown', '[class*="model-response"]', '[class*="message-content"]', '.markdown', '[class*="markdown"]'],
    stop: ['button[aria-label*="Stop"]', 'button[data-testid*="stop"]', 'button[class*="stop"]'],
    user: ['[data-message-author-role="user"]', '[data-role="user"]', '[data-testid*="user-message"]', '[class*="user-message"]']
  }
};
function altsFor(site, role) {
  const s = (ALT_SELECTORS[site] && ALT_SELECTORS[site][role]) || [];
  const g = ALT_SELECTORS.generic[role] || [];
  return Array.from(new Set([...s, ...g]));
}

// ---- the page kit: runs INSIDE the pane (and in Node tests on a fake DOM) -----------
// Must stay self-contained (no closure over module scope): it is embedded by source.
function pageKit() {
  const OVERLAY = '[data-autoinjector-overlay]';
  const EDITABLE = 'textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]';
  const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, HEAD: 1 };
  const lc = (s) => String(s == null ? '' : s).toLowerCase();
  const textOf = (e) => { try { return String(e.textContent || ''); } catch (_) { return ''; } };
  function qsa(root, sel) { try { return Array.from(root.querySelectorAll(sel)); } catch (_) { return null; } }
  function shown(e) { try { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch (_) { return true; } }
  function inOverlay(e) { try { return !!(e && e.closest && e.closest(OVERLAY)); } catch (_) { return false; } }
  function isEditable(e) { return !!e && e.nodeType === 1 && (e.tagName === 'TEXTAREA' || e.isContentEditable === true); }
  function inEditable(e) { for (let x = e; x && x.nodeType === 1; x = x.parentElement) if (isEditable(x)) return true; return false; }
  function holdsEditable(e) { const l = qsa(e, EDITABLE); return !!(l && l.length); }
  function outerEditable(e) { let r = e; if (r && r.tagName !== 'TEXTAREA') while (r.parentElement && r.parentElement.isContentEditable) r = r.parentElement; return r; }
  function editableValue(e) { return e.tagName === 'TEXTAREA' || e.tagName === 'INPUT' ? String(e.value || '') : textOf(e); }
  function after(a, b) { try { return !!(a.compareDocumentPosition(b) & 4); } catch (_) { return false; } }
  function overlaps(a, b) { return !!a && !!b && (a === b || a.contains(b) || b.contains(a)); }
  // Deepest elements whose text contains `needle` (case-insensitive), in page order;
  // never inside the overlay, a script/style, or a message box. `accept` (optional)
  // filters the hits; when no text node holds the needle on its own (the page split
  // it, e.g. "peli<b>can</b>"), the deepest elements whose whole text holds it count.
  function findText(doc, needle, accept) {
    const want = lc(needle);
    const ok = typeof accept === 'function' ? accept : () => true;
    const out = [];
    if (!want || !doc.body) return out;
    const seen = new Set();
    (function walk(n) {
      for (const c of Array.from(n.childNodes || [])) {
        if (c.nodeType === 3) {
          if (lc(c.data).indexOf(want) !== -1 && n.nodeType === 1 && !seen.has(n)) { seen.add(n); if (ok(n)) out.push(n); }
        } else if (c.nodeType === 1 && !SKIP_TAGS[c.tagName] && !(c.matches && safeMatches(c, OVERLAY)) && !isEditable(c)) walk(c);
      }
    })(doc.body);
    if (out.length) return out;
    for (const e of qsa(doc.body, '*') || []) {
      if (SKIP_TAGS[e.tagName] || inOverlay(e) || inEditable(e)) continue;
      if (lc(textOf(e)).indexOf(want) === -1) continue;
      if (Array.from(e.children).some((k) => lc(textOf(k)).indexOf(want) !== -1)) continue;
      if (ok(e)) out.push(e);
    }
    return out;
  }
  // Text of `root` without the parts inside elements matching `skipSel` (and the box).
  function textExcept(root, skipSel, box) {
    let out = '';
    (function walk(n) {
      for (const c of Array.from(n.childNodes || [])) {
        if (c.nodeType === 3) out += c.data;
        else if (c.nodeType === 1 && c !== box && !SKIP_TAGS[c.tagName] && !(skipSel && safeMatches(c, skipSel))) walk(c);
      }
    })(root);
    return out;
  }
  // Elements with their own visible words (a list of messages has several).
  function textChildren(e) { return Array.from(e.children || []).filter((k) => textOf(k).trim().length > 0).length; }
  function safeMatches(e, sel) { try { return e.matches(sel); } catch (_) { return false; } }

  // ---- selector candidates for one element --------------------------------------
  const VOLATILE = /(\d{3,}|[0-9a-f]{8,}|[0-9a-f]{4,}-[0-9a-f]{4,}|^\d+$|^:r)/i;
  const UTILITY = /^(?:[a-z0-9]+:|-?[mp][xytrbl]?-|w-|h-|min-|max-|size-|text-|bg-|border|rounded|flex|grid|gap-|items-|justify-|self-|overflow|relative|absolute|fixed|sticky|inset|top-|left-|right-|bottom-|z-|font-|leading-|tracking-|shadow|opacity|transition|duration|ease|cursor|select-|whitespace|break-|truncate|sr-only|hidden|block|inline|contents|group|peer|space-|order-|col-|row-|place-|align-|origin-|transform|translate|scale|rotate|ring|outline|fill-|stroke-|visible|invisible|pointer-events|resize|list-|decoration|underline|italic|antialiased|container|mx-auto|dark|light|active|selected|hover|focus|disabled|ng-|mat-|mdc-|css-|sc-|jsx-)/;
  const IDENT = /^-?[A-Za-z_][\w-]*$/;
  const SKIP_DATA = /^data-(?:start|end|index|offset|state|headlessui|radix|reactroot|v-|ved|hveid|ei|sentry|testid-index)/;
  function q(v) { return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }
  function candidatesFor(e, role) {
    const tag = String(e.localName || e.tagName || '').toLowerCase();
    if (!tag || !IDENT.test(tag)) return [];
    const out = [];
    const add = (sel, score) => out.push({ sel, score });
    if (tag.indexOf('-') !== -1) add(tag, 90);
    // Message blocks (assistant / user): attribute VALUES must look like names, never
    // like words someone wrote (no spaces, no labels/titles) — a learned selector must
    // never carry page text, and must match the NEXT reply too.
    const block = role === 'assistant' || role === 'user' || role === 'anchor';
    for (const a of Array.from(e.attributes || [])) {
      const n = String(a.name || '').toLowerCase(); const v = String(a.value == null ? '' : a.value);
      if (!IDENT.test(n)) continue;
      if (n.indexOf('data-') === 0 && !SKIP_DATA.test(n)) {
        if (v && v.length <= 40 && !VOLATILE.test(v) && !/[\n\r]/.test(v) && !(block && /\s/.test(v))) { add(tag + '[' + n + '=' + q(v) + ']', 100); add('[' + n + '=' + q(v) + ']', 97); }
        else add(tag + '[' + n + ']', /(?:^|-)id$|-key$|uuid/.test(n) ? 66 : 60);
      } else if (n === 'role' && v && !/\s/.test(v)) add(tag + '[role=' + q(v) + ']', role === 'assistant' ? 70 : 80);
      else if (!block && (n === 'aria-label' || n === 'mattooltip' || n === 'title') && v && v.length <= 40 && !VOLATILE.test(v)) add(tag + '[' + n + '=' + q(v) + ']', 82);
      else if (n === 'id' && IDENT.test(v) && !VOLATILE.test(v)) add('#' + v, role === 'assistant' || role === 'user' ? 5 : 88);
      else if ((n === 'name' || n === 'placeholder') && v && v.length <= 40 && role === 'input') add(tag + '[' + n + '=' + q(v) + ']', 78);
      else if (n === 'type' && v === 'submit' && role === 'send') add(tag + '[type="submit"]', 55);
    }
    const cls = String((e.className && e.className.baseVal != null ? e.className.baseVal : e.className) || '').split(/\s+/).filter((c) => c && c.length <= 40 && IDENT.test(c) && !VOLATILE.test(c));
    const stable = cls.filter((c) => !UTILITY.test(c));
    for (const c of stable.slice(0, 4)) { add(tag + '.' + c, 62); add('.' + c, 58); }
    if (stable.length >= 2) add(tag + '.' + stable[0] + '.' + stable[1], 64);
    if (role === 'input' && e.isContentEditable && e.tagName !== 'TEXTAREA') add(tag + '[contenteditable="true"]', 30);
    if (role === 'input' && e.tagName === 'TEXTAREA') add('textarea', 25);
    return out;
  }
  // Strong ancestor anchors (data-*=value, custom tags, roles) qualify weak candidates.
  function withAncestors(e, own) {
    const out = own.slice();
    const weak = own.filter((c) => c.score < 70);
    let anc = e.parentElement;
    for (let i = 0; anc && i < 6 && anc.tagName !== 'BODY'; i++, anc = anc.parentElement) {
      const strong = candidatesFor(anc, 'anchor').filter((c) => c.score >= 80 && c.sel.charAt(0) !== '#');
      for (const s of strong.slice(0, 2)) for (const w of weak.slice(0, 4)) out.push({ sel: s.sel + ' ' + w.sel, score: Math.round((s.score + w.score) / 2) + 4 });
    }
    return out;
  }

  // ---- reply blocks (P18.4 page search; also used by the teach step) -------------
  // isUser(el) -> true when the element is (or holds) the user's own message.
  function validateReply(doc, sel, word, isUser) {
    const list = qsa(doc, sel);
    if (!list || !list.length) return { ok: false, reason: 'NO_MATCH' };
    const l = list.filter((x) => !inOverlay(x));
    if (!l.length) return { ok: false, reason: 'NO_MATCH' };
    if (l.length > 200) return { ok: false, reason: 'TOO_BROAD' };
    if (l.some((x) => isUser(x))) return { ok: false, reason: 'MATCHES_USER_MESSAGE' };
    if (l.some((x) => inEditable(x) || holdsEditable(x))) return { ok: false, reason: 'MATCHES_MESSAGE_BOX' };
    const last = l[l.length - 1];
    if (lc(textOf(last)).indexOf(lc(word)) === -1) return { ok: false, reason: 'NEWEST_LACKS_WORD' };
    return { ok: true, count: l.length };
  }
  function learnReplyFrom(doc, base, word, isUser) {
    const levels = [];
    for (let e = base, i = 0; e && e.nodeType === 1 && e.tagName !== 'BODY' && e.tagName !== 'HTML' && i < 12; e = e.parentElement, i++) {
      if (isUser(e) || holdsEditable(e) || inOverlay(e)) break;
      levels.push(e);
    }
    if (!levels.length) return { ok: false, reason: 'NO_CONTAINER' };
    const baseLen = textOf(base).trim().length;
    let best = null; let tried = 0;
    levels.forEach((node, li) => {
      const t = textOf(node);
      const tight = t.trim().length <= baseLen + 160 && (t.match(/\[\s*FROM\s*:/gi) || []).length <= 1;
      for (const c of withAncestors(node, candidatesFor(node, 'assistant'))) {
        tried++;
        const v = validateReply(doc, c.sel, word, isUser);
        if (!v.ok) continue;
        const score = c.score + (tight ? li * 3 : -40);
        if (!best || score > best.score) best = { selector: c.sel, score, count: v.count, level: li };
      }
    });
    if (!best) return { ok: false, reason: 'NO_STABLE_SELECTOR', tried };
    return { ok: true, selector: best.selector, count: best.count, level: best.level, score: best.score, tried };
  }
  // P18.4: the check-in word in a NEW element that is not the user's message (which
  // holds `phrase`, e.g. "reply with only this word") and not the message box.
  function learnReply(doc, word, phrase) {
    const isUser = (e) => lc(textOf(e)).indexOf(lc(phrase)) !== -1;
    const bases = findText(doc, word, (e) => !isUser(e) && !inEditable(e) && !inOverlay(e));
    if (!bases.length) return { ok: false, reason: 'WORD_NOT_FOUND' };
    return learnReplyFrom(doc, bases[bases.length - 1], word, isUser);
  }

  // ---- what is on the page right now (evidence for the classifier) --------------
  function scan(doc, word, phrase, assistantSelectors) {
    const isUser = (e) => lc(textOf(e)).indexOf(lc(phrase)) !== -1;
    const replyHits = findText(doc, word, (e) => !isUser(e) && !inEditable(e) && !inOverlay(e));
    let readerHasWord = false, readerCount = 0;
    for (const sel of assistantSelectors || []) {
      const l = qsa(doc, sel);
      if (l && l.length) { readerCount = l.length; readerHasWord = lc(textOf(l[l.length - 1])).indexOf(lc(word)) !== -1; break; }
    }
    return { ok: true, wordOnPage: replyHits.length > 0, userBubble: findText(doc, phrase, (e) => !inEditable(e) && !inOverlay(e)).length > 0, readerCount, readerHasWord };
  }

  // ---- P18.3 try built-in alternatives in order -----------------------------------
  function tryAlternatives(doc, alts, roles, word, phrase, skip) {
    const isUser = (e) => !!phrase && lc(textOf(e)).indexOf(lc(phrase)) !== -1;
    const out = {};
    const skipSet = new Set(skip || []);
    for (const role of roles) {
      for (const sel of alts[role] || []) {
        if (skipSet.has(sel)) continue;
        const l = qsa(doc, sel);
        if (!l || !l.length) continue;
        if (role === 'input') { if (l.some((e) => isEditable(outerEditable(e)) && shown(e)) || l.some((e) => { const k = qsa(e, EDITABLE); return k && k.some(shown); })) { out.input = sel; break; } }
        else if (role === 'send') { if (l.some((e) => shown(e) && (e.tagName === 'BUTTON' || (e.getAttribute && e.getAttribute('role') === 'button')))) { out.send = sel; break; } }
        else if (role === 'stop') { if (l.some(shown)) { out.stop = sel; break; } }
        else if (role === 'assistant') { if (word && validateReply(doc, sel, word, isUser).ok) { out.assistant = sel; break; } }
      }
    }
    return { ok: true, found: out };
  }

  // ---- P18.2 page signals ------------------------------------------------------------
  function signals(doc, loc, table, inputSelectors, noticeSel, messageSel) {
    const url = String((loc && loc.href) || '');
    let inputFound = false;
    for (const s of inputSelectors || []) { const l = qsa(doc, s); if (l && l.some((e) => shown(e))) { inputFound = true; break; } }
    let notices = null, page = null;
    const noticeText = () => {
      if (notices != null) return notices;
      const parts = [];
      for (const e of qsa(doc, noticeSel) || []) if (shown(e) && !inOverlay(e)) parts.push(textOf(e));
      // the area around the message box (limits are often shown right there) —
      // never the conversation: stop before a container that holds several
      // messages, and leave out anything that looks like a message block.
      for (const s of inputSelectors || []) {
        const l = qsa(doc, s); const box = l && l.find(shown);
        if (!box) continue;
        let area = box;
        for (let i = 0; i < 3 && area.parentElement && area.parentElement.tagName !== 'BODY'; i++) {
          const p = area.parentElement;
          if (messageSel && (qsa(p, messageSel) || []).length) break;
          if (textOf(p).length - textOf(box).length > 600) break;
          area = p;
        }
        parts.push(textExcept(area, messageSel, box));
        break;
      }
      notices = lc(parts.join('\n')).slice(0, 20000);
      return notices;
    };
    const pageText = () => { if (page == null) page = lc(doc.body ? textOf(doc.body) : '').slice(0, 30000); return page; };
    const codes = [];
    for (const sig of table) {
      if (sig.noInput && inputFound) continue;
      let hit = false;
      try { if (sig.url && new RegExp(sig.url, 'i').test(url)) hit = true; } catch (_) {}
      if (!hit && sig.selector) { const l = qsa(doc, sig.selector); hit = !!(l && l.some((e) => shown(e) && !inOverlay(e))); }
      if (!hit && sig.text) { const hay = sig.where === 'page' ? pageText() : noticeText(); hit = sig.text.some((t) => hay.indexOf(t) !== -1); }
      if (hit) codes.push({ code: sig.code, id: sig.id });
    }
    return { ok: true, inputFound, codes };
  }

  // ---- P18.6 unfreeze: press the Stop button -------------------------------------------
  function pressStop(doc, stopSelectors) {
    for (const s of stopSelectors || []) {
      const l = qsa(doc, s);
      const b = l && l.find((e) => shown(e) && !inOverlay(e));
      if (b) { try { b.click(); } catch (_) {} return { ok: true, pressed: true }; }
    }
    return { ok: true, pressed: false };
  }

  // ---- P18.7 teach step ------------------------------------------------------------------
  function deriveFor(doc, el, role, validate) {
    const own = candidatesFor(el, role);
    const cands = (role === 'send' || role === 'input') ? own : withAncestors(el, own);
    cands.sort((a, b) => b.score - a.score);
    for (const c of cands) { if (validate(c.sel)) return c.sel; }
    return null;
  }
  function deriveInput(doc, box) {
    return deriveFor(doc, box, 'input', (sel) => {
      const l = qsa(doc, sel); if (!l || !l.length || l.length > 3) return false;
      const firstShown = l.map(outerEditable).find((e) => isEditable(e) && shown(e));
      return firstShown === box;
    });
  }
  function deriveSend(doc, btn) {
    return deriveFor(doc, btn, 'send', (sel) => { const l = qsa(doc, sel); return !!l && l.length >= 1 && l.length <= 3 && l.filter(shown)[0] === btn; });
  }
  // The message block around `base`: climb wrappers, but never into a container
  // that holds several messages (two or more children with words), the message
  // box, our overlay, or anything `holdsBad` refuses.
  function blockTop(base, holdsBad) {
    let top = base; const len = textOf(base).trim().length;
    for (let i = 0; i < 8 && top.parentElement && top.parentElement.tagName !== 'BODY'; i++) {
      const p = top.parentElement;
      if (holdsEditable(p) || inOverlay(p) || (holdsBad && holdsBad(p))) break;
      if (textOf(p).trim().length > len + 160) break;
      if (textChildren(p) > 1) break; // a list of messages (or a label + message: the inner block is fine)
      top = p;
    }
    return top;
  }
  function teachState(win) { return win && win.__aiTeach ? win.__aiTeach : null; }
  function teachInstall(doc, win, number, bannerText) {
    teachRemove(doc, win);
    const st = { number: String(number), phase: 'type', events: [], startedAt: Date.now(), input: null, send: null, sendHow: null, user: null, reply: null, replyKey: null, replyStableSince: 0, polls: 0, box: null, userBase: null, userTop: null };
    win.__aiTeach = st;
    try {
      const b = doc.createElement('div');
      b.setAttribute('data-autoinjector-overlay', '1');
      b.setAttribute('role', 'status');
      b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#3b2a8a;color:#fff;font:600 15px/1.4 system-ui,sans-serif;padding:10px 16px;text-align:center;pointer-events:none;box-shadow:0 2px 10px rgba(0,0,0,.4)';
      b.textContent = bannerText;
      (doc.body || doc.documentElement).appendChild(b);
    } catch (_) {}
    st.onClick = (ev) => { try { const t = ev.target && ev.target.closest ? ev.target.closest('button, [role="button"], input[type="submit"]') : null; if (t && !inOverlay(t)) st.events.push({ type: 'click', t: Date.now(), el: t }); } catch (_) {} };
    st.onKey = (ev) => { try { if (ev.key === 'Enter' && !ev.shiftKey && ev.target && inEditable(ev.target)) st.events.push({ type: 'enter', t: Date.now() }); } catch (_) {} };
    try { doc.addEventListener('click', st.onClick, true); doc.addEventListener('mousedown', st.onClick, true); doc.addEventListener('keydown', st.onKey, true); } catch (_) {}
    return { ok: true };
  }
  function teachRemove(doc, win) {
    const st = teachState(win);
    if (st) { try { doc.removeEventListener('click', st.onClick, true); doc.removeEventListener('mousedown', st.onClick, true); doc.removeEventListener('keydown', st.onKey, true); } catch (_) {} }
    for (const o of qsa(doc, OVERLAY) || []) { try { o.remove(); } catch (_) {} }
    if (win) { try { delete win.__aiTeach; } catch (_) { win.__aiTeach = undefined; } }
    return { ok: true };
  }
  // One step of the teach watcher. Pure apart from `st`; `now` passed in for tests.
  function teachStep(doc, st, now) {
    st.polls++;
    const num = st.number;
    if (st.phase === 'type' || st.phase === 'typed') {
      let holding = null;
      for (const e of qsa(doc, EDITABLE) || []) {
        const o = outerEditable(e);
        if (!inOverlay(o) && editableValue(o).indexOf(num) !== -1) { holding = o; break; }
      }
      if (holding) {
        if (st.box !== holding || !st.input) { st.box = holding; st.input = deriveInput(doc, holding); }
        st.phase = 'typed';
        if (!st.typedAt) st.typedAt = now;
      } else if (st.phase === 'typed') {
        st.phase = 'sent'; st.sentAt = now;
        const recent = (type) => st.events.filter((x) => x.type === type && now - x.t < 5000).pop();
        const click = recent('click'); const enter = recent('enter');
        if (click && click.el && (!enter || click.t >= enter.t)) { st.sendHow = 'click'; st.send = deriveSend(doc, click.el); if (!st.send) st.sendHow = 'click-unlearned'; }
        else if (enter) st.sendHow = 'enter';
        else st.sendHow = 'unknown';
      }
    }
    if (st.phase === 'sent') {
      const hits = findText(doc, num, (e) => !inEditable(e) && !inOverlay(e));
      // the user's message is the one that holds "Repeat this number" (the reply may
      // already be there too when the AI is quick); else the first new hit
      if (hits.length) { st.userBase = hits.filter((e) => lc(textOf(e)).indexOf('repeat this number') !== -1).pop() || hits[0]; st.phase = 'wait_reply'; }
      else if (now - st.sentAt > 20000) st.phase = 'wait_reply_nouser';
    }
    if (st.phase === 'wait_reply' || st.phase === 'wait_reply_nouser') {
      const ub = st.userBase;
      const hits = findText(doc, num, (e) => !inEditable(e) && !inOverlay(e) && (ub ? !overlaps(e, ub) && after(ub, e) : lc(textOf(e)).indexOf('repeat this number') === -1));
      if (hits.length) {
        const r = hits[hits.length - 1];
        // The user's block and the reply's block are the two branches below their
        // closest common ancestor (the message list) — so a first message alone in
        // the list never swallows the reply that comes after it.
        let userTop = null, replyTop = r;
        if (ub) {
          let lca = ub.parentElement;
          while (lca && !lca.contains(r)) lca = lca.parentElement;
          userTop = ub; while (userTop.parentElement && userTop.parentElement !== lca) userTop = userTop.parentElement;
          while (replyTop.parentElement && replyTop.parentElement !== lca) replyTop = replyTop.parentElement;
        }
        const key = lc(textOf(replyTop));
        if (st.replyKey !== key) { st.replyKey = key; st.replyStableSince = now; }
        else if (now - st.replyStableSince >= 1200) {
          st.userTop = userTop;
          if (userTop) st.user = deriveFor(doc, userTop, 'user', (sel) => { const l = qsa(doc, sel); return !!l && l.length >= 1 && l.length <= 200 && l.some((x) => overlaps(x, userTop)) && !l.some((x) => overlaps(x, r) || holdsEditable(x)); });
          const userEls = st.user ? (qsa(doc, st.user) || []) : [];
          const isUser = (e) => (userTop && overlaps(e, userTop)) || userEls.some((u) => overlaps(u, e));
          const res = learnReplyFrom(doc, r, num, isUser);
          st.reply = res.ok ? res.selector : null;
          st.replyReason = res.ok ? null : res.reason;
          st.phase = 'done';
        }
      }
    }
    return teachSummary(st);
  }
  function teachSummary(st) {
    return { ok: true, phase: st.phase, polls: st.polls, sendHow: st.sendHow, selectors: { input: st.input, send: st.send, user: st.user, assistant: st.reply }, replyReason: st.replyReason || null };
  }

  return { findText, candidatesFor, validateReply, learnReply, learnReplyFrom, scan, tryAlternatives, signals, pressStop, teachInstall, teachRemove, teachStep, teachSummary, teachState, deriveInput, deriveSend };
}

// ---- script builders ----------------------------------------------------------------
// Each returns ONE expression. `document`, `window`, `location` are the page's own.
function kitScript(body) {
  return `(() => { /* ${MARKER} */ const K = (${pageKit.toString()})(); ${body} })()`;
}
function cfgJson(o) { return JSON.stringify(o).replace(/</g, '\\u003c'); }
function siteDefaults(SITES, site) { return (SITES && SITES[site]) || {}; }
function currentLists(SITES, site, overrides) {
  const cfg = siteDefaults(SITES, site);
  const ov = overrides || {};
  const pre = (sel, list) => (sel ? [sel].concat(list || []) : (list || []).slice());
  return {
    input: pre(ov.input, cfg.INPUT_CANDIDATES), send: pre(ov.send, cfg.SEND_CANDIDATES),
    assistant: pre(ov.assistant, cfg.ASSISTANT_CANDIDATES), stop: pre(ov.stop, cfg.STOP_CANDIDATES)
  };
}
function buildSignalScript(site, SITES, overrides) {
  const lists = currentLists(SITES, site, overrides);
  const msgs = Array.from(new Set(lists.assistant.concat(altsFor(site, 'assistant'), altsFor(site, 'user')))).join(', ');
  return kitScript(`const CFG = ${cfgJson({ table: signaturesFor(site), input: Array.from(new Set(lists.input.concat(altsFor(site, 'input')))), notice: NOTICE_SELECTOR, messages: msgs })}; return K.signals(document, location, CFG.table, CFG.input, CFG.notice, CFG.messages);`);
}
function buildScanScript(site, SITES, overrides, word, phrase) {
  const lists = currentLists(SITES, site, overrides);
  return kitScript(`const CFG = ${cfgJson({ word, phrase, assistant: lists.assistant })}; return K.scan(document, CFG.word, CFG.phrase, CFG.assistant);`);
}
function buildAlternativesScript(site, SITES, overrides, roles, word, phrase) {
  const lists = currentLists(SITES, site, overrides);
  const alts = {}; for (const r of roles) alts[r] = altsFor(site, r);
  // never "find" what is already failing: skip the reply / stop selectors in use
  const skip = [].concat(roles.includes('assistant') ? lists.assistant : [], roles.includes('stop') ? lists.stop : []);
  return kitScript(`const CFG = ${cfgJson({ alts, roles, word: word || '', phrase: phrase || '', skip })}; return K.tryAlternatives(document, CFG.alts, CFG.roles, CFG.word, CFG.phrase, CFG.skip);`);
}
function buildLearnReplyScript(word, phrase) {
  return kitScript(`const CFG = ${cfgJson({ word, phrase })}; return K.learnReply(document, CFG.word, CFG.phrase);`);
}
function buildUnfreezeScript(site, SITES, overrides) {
  const lists = currentLists(SITES, site, overrides);
  return kitScript(`const CFG = ${cfgJson({ stop: Array.from(new Set(lists.stop.concat(altsFor(site, 'stop')))) })}; return K.pressStop(document, CFG.stop);`);
}
function teachBanner(label, number) {
  return `AutoInjector: please type   Repeat this number: ${number}   into ${label}'s message box below and press Send. (This shows AutoInjector where things are.)`;
}
function buildTeachStartScript(label, number) {
  return kitScript(`const CFG = ${cfgJson({ number: String(number), banner: teachBanner(label, number) })}; return K.teachInstall(document, window, CFG.number, CFG.banner);`);
}
function buildTeachPollScript() {
  return kitScript('const st = K.teachState(window); if (!st) return { ok: false, error: "NO_TEACH" }; return K.teachStep(document, st, Date.now());');
}
function buildTeachStopScript() {
  return kitScript('return K.teachRemove(document, window);');
}

// ---- P18.2 the classifier --------------------------------------------------------------
// evidence = {
//   loadFailed: bool, signals: [code…] (page signals), send: null | { ok, error, verified },
//   read: { textLen, generating, generatingMs, hasWord }, page: { wordOnPage, userBubble },
//   captured: bool, stuckMs: number (default 120000)
// } -> one of CODES (never throws).
function classify(ev) {
  const e = ev || {};
  const sig = new Set((e.signals || []).map((x) => (typeof x === 'string' ? x : x && x.code)).filter(Boolean));
  const read = e.read || {};
  const page = e.page || {};
  const send = e.send || null;
  const stuckMs = Number(e.stuckMs) > 0 ? Number(e.stuckMs) : 120000;
  if (e.loadFailed) return 'NETWORK_ERROR';
  if (sig.has('CAPTCHA')) return 'CAPTCHA';
  if (sig.has('LOGGED_OUT')) return 'LOGGED_OUT';
  if (sig.has('USAGE_LIMIT')) return 'USAGE_LIMIT';
  if (e.captured) return 'UNKNOWN'; // (a captured check-in is not a failure; callers don't classify it)
  if (send && !send.ok) {
    const err = String(send.error || '');
    if (/^(INPUT_NOT_FOUND|INJECT_FAILED|NO_INPUT)$/.test(err)) return 'TYPE_FAILED';
    if (/^(SEND_NOT_CONFIRMED|SEND_UNVERIFIED)$/.test(err)) return 'SEND_NOT_CONFIRMED';
    if (/^(AI_BUSY|CANCELLED)$/.test(err)) return 'STUCK_GENERATING';
    if (err === 'NO_VIEW') return 'NETWORK_ERROR';
    if (err === 'PROVIDER_PAUSED' || sig.has('PAGE_ERROR')) return 'PAGE_ERROR';
    return 'UNKNOWN';
  }
  if (sig.has('PAGE_ERROR')) return 'PAGE_ERROR';
  if (read.generating && Number(read.generatingMs || 0) >= stuckMs) return 'STUCK_GENERATING';
  if (read.hasWord) return 'FALSE_DUPLICATE'; // the reader sees the answer, but it wasn't taken
  if (page.wordOnPage) return 'NO_REPLY_FOUND'; // the AI answered; the reply selector misses it
  if (send && send.ok && send.verified === false && !page.userBubble) return 'SEND_NOT_CONFIRMED';
  if (!Number(read.textLen || 0) && page.userBubble) return 'NO_REPLY_FOUND';
  if (read.generating) return 'STUCK_GENERATING';
  return 'UNKNOWN';
}

// Repair ladders (P18.3 / P18.4 / P18.6, then the P18.7 teach step).
const LADDERS = {
  TYPE_FAILED: ['alternatives', 'reload', 'teach'],
  SEND_NOT_CONFIRMED: ['alternatives', 'reload', 'teach'],
  NO_REPLY_FOUND: ['alternatives', 'page_search', 'reload', 'teach'],
  FALSE_DUPLICATE: ['retry', 'page_search', 'reload', 'teach'],
  STUCK_GENERATING: ['unfreeze', 'reload', 'give_up'],
  PAGE_ERROR: ['reload', 'reload_home', 'give_up'],
  NETWORK_ERROR: ['reload', 'reload_home', 'give_up'],
  UNKNOWN: ['alternatives', 'page_search', 'reload', 'teach']
};
const ALT_ROLES = { TYPE_FAILED: ['input'], SEND_NOT_CONFIRMED: ['send', 'input'], NO_REPLY_FOUND: ['assistant'], FALSE_DUPLICATE: ['assistant'], UNKNOWN: ['input', 'send', 'assistant'], STUCK_GENERATING: ['stop'] };

// Check-in words: ordinary, unusual enough not to be on the page already.
const WORDS = ('marigold quokka zephyr tundra lantern pebble walrus juniper saffron origami mosaic cobalt ' +
  'hazelnut kestrel lagoon meadow nutmeg obsidian pelican quartz rhubarb sequoia tamarind umbrella ' +
  'velvet wombat yarrow zinnia anchovy bramble cactus dragonfly eclipse fjord gazelle harbor iguana ' +
  'jasmine kayak lilac mango narwhal octopus paprika quince raccoon sapphire tortoise ukulele violet ' +
  'waffle xylophone yogurt zucchini acorn biscuit canyon dolphin emerald falcon glacier hammock ' +
  'igloo jellyfish koala lemonade magnolia nectar orchid penguin quiver ribbon sparrow thistle ' +
  'unicorn volcano willow almond blossom compass dandelion ember feather galaxy honeycomb').split(/\s+/);
function pickWord(avoid) {
  const bad = new Set((avoid || []).map((w) => String(w).toLowerCase()));
  for (let i = 0; i < 20; i++) { const w = WORDS[crypto.randomInt(WORDS.length)]; if (!bad.has(w)) return w; }
  return WORDS[crypto.randomInt(WORDS.length)];
}
function pickNumber() { return String(1000 + crypto.randomInt(9000)); }
const PROBE_PHRASE = 'reply with only this word';
const TEACH_PHRASE = 'repeat this number';
function probeText(word) { return `Reply with only this word: ${word}`; }

// Learned selectors (persisted by main.js): { version, sites: { site: { role: { selector, how, learnedAt, version } } } }
function sanitizeLearned(raw, sites, isBadSelector) {
  const out = {};
  for (const s of sites) out[s] = {};
  if (!raw || typeof raw !== 'object') return out;
  const src = raw.sites && typeof raw.sites === 'object' ? raw.sites : raw;
  for (const s of sites) {
    const m = src[s];
    if (!m || typeof m !== 'object') continue;
    for (const role of ['input', 'send', 'assistant', 'stop', 'user']) {
      const x = m[role];
      if (!x || typeof x !== 'object' || typeof x.selector !== 'string') continue;
      const sel = x.selector.trim();
      if (!sel || sel.length > 300 || (isBadSelector && isBadSelector(sel))) continue;
      out[s][role] = { selector: sel, how: typeof x.how === 'string' ? x.how.slice(0, 20) : 'learned', learnedAt: Number(x.learnedAt) || 0, version: Number(x.version) || LEARNED_VERSION };
    }
  }
  return out;
}

// ---- the engine ----------------------------------------------------------------------------
const EVENT_RING = 60;
function createSelfRepair(deps) {
  const d = deps || {};
  const sites = Array.isArray(d.sites) && d.sites.length ? d.sites.slice() : ['chatgpt', 'claude', 'gemini'];
  const now = typeof d.now === 'function' ? d.now : Date.now;
  const sleep = typeof d.sleep === 'function' ? d.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const label = typeof d.label === 'function' ? d.label : (s) => s;
  const log = (detail) => { try { if (typeof d.log === 'function') d.log('self-repair', detail); } catch (_) {} };
  const opt = Object.assign({
    probeTimeoutMs: 90000, sendTimeoutMs: 45000, earlyQuietMs: 10000, stuckMs: 120000,
    intervalMs: 20 * 60000, needsUserRecheckMs: 60000, teachTimeoutMs: 4 * 60000, teachPollMs: 800,
    reloadSettleMs: 4000, unfreezeWaitMs: 3000, recentWordsMs: 10 * 60000, pollStepMs: 1000,
    autoChecks: true // false: no automatic check-ins at all (startup / after a failure); on-demand ones still run
  }, d.options || {});
  const S = {};
  for (const s of sites) S[s] = { state: 'unknown', problem: null, since: null, lastProbeOkAt: null, lastProbeAt: 0, lastCheckReason: null, running: false, step: null, tried: [], teach: null, pending: null, lastSignalCheckAt: 0, startupDone: false, fixedAt: null };
  const events = [];
  const createdAt = now(); // periodic check-ins count from app start (the start-up one is separate)
  const awaiting = {}; // site -> { word, resolve, captured }
  const recent = {};   // site -> [{ word, until }]  (late check-in replies are still owned)
  const teachCtl = {}; // site -> { cancel: bool }

  function event(kind, fields) {
    const e = { kind, at: now() };
    for (const k of ['site', 'step', 'code', 'outcome', 'reason', 'state', 'how', 'role']) if (fields && fields[k] != null) e[k] = String(fields[k]).slice(0, 48);
    events.push(e);
    if (events.length > EVENT_RING) events.shift();
    log(e);
    return e;
  }
  function snap(site) {
    const x = S[site];
    if (!x) return null;
    const t = x.teach;
    return {
      state: x.state, problem: x.problem, since: x.since, lastProbeOkAt: x.lastProbeOkAt, lastProbeAt: x.lastProbeAt || null,
      running: x.running, step: x.step, fixedAt: x.fixedAt,
      say: x.problem ? describeProblem(x.problem, label(site)).say : null,
      fix: x.problem ? describeProblem(x.problem, label(site)).fix : null,
      tried: x.tried.slice(-12).map((r) => ({ step: r.step, outcome: r.outcome, code: r.code, at: r.at, say: STEP_TEXT[r.step] || r.step })),
      teach: t ? { active: !!t.active, number: t.number, phase: t.phase, startedAt: t.startedAt, learned: Object.assign({}, t.learned), sendHow: t.sendHow || null, missing: (t.missing || []).slice(), result: t.result || null, code: t.code || null } : null
    };
  }
  function emit(site, ev) { try { if (typeof d.onChange === 'function') d.onChange(site, snap(site), ev || null); } catch (_) {} }
  function setState(site, state, problem) {
    const x = S[site];
    const changed = x.state !== state || x.problem !== (problem || null);
    if (changed) { x.state = state; x.problem = problem || null; x.since = state === 'unknown' ? null : now(); }
    if (changed) event('state', { site, state, code: x.problem });
    emit(site);
  }
  function note(site, step, code, outcome) {
    const x = S[site];
    x.tried.push({ step, code, outcome, at: now() });
    if (x.tried.length > 30) x.tried.shift();
    event('step', { site, step, code, outcome });
    emit(site);
  }
  async function page(site, script) {
    try { return await d.runPage(site, script); } catch (e) { return { ok: false, error: 'SCRIPT_FAILED' }; }
  }
  const overrides = (site) => { try { return (typeof d.overrides === 'function' && d.overrides(site)) || {}; } catch (_) { return {}; } };

  // ---- ownership of check-in / teach replies (pollSite asks) ----------------------
  function wordsFor(site) {
    const out = [];
    if (awaiting[site]) out.push(awaiting[site].word);
    const t = S[site] && S[site].teach;
    if (t && t.active) out.push(t.number);
    for (const r of recent[site] || []) if (r.until > now()) out.push(r.word);
    return out;
  }
  // Is this reply text the answer to a check-in / teach message here? (never the
  // user's message itself, which also holds the word but also the instruction)
  function expects(site, text) {
    const t = String(text || '').toLowerCase();
    if (!t || t.indexOf(PROBE_PHRASE) !== -1 || t.indexOf(TEACH_PHRASE) !== -1) return false;
    return wordsFor(site).some((w) => t.indexOf(String(w).toLowerCase()) !== -1);
  }
  function onCaptured(site, turn) {
    if (!S[site] || !turn) return false;
    const text = String(turn.text || '');
    if (!expects(site, text)) return false;
    const a = awaiting[site];
    if (a && text.toLowerCase().indexOf(a.word.toLowerCase()) !== -1 && !a.captured) { a.captured = true; try { a.resolve(true); } catch (_) {} }
    return true;
  }
  function awaitingReply(site) { return !!awaiting[site] || !!(S[site] && S[site].teach && S[site].teach.active); }
  function teachActive(site) { return !!(S[site] && S[site].teach && S[site].teach.active); }

  // ---- one check-in ---------------------------------------------------------------------
  async function signalsOf(site) {
    const r = await page(site, buildSignalScript(site, d.SITES, overrides(site)));
    return r && r.ok ? r : { ok: false, codes: [], inputFound: null };
  }
  function readState(site) { try { return (typeof d.readState === 'function' && d.readState(site)) || {}; } catch (_) { return {}; } }
  async function evidence(site, word, sendRes, captured) {
    const rs = readState(site);
    const sig = await signalsOf(site);
    const sc = word ? await page(site, buildScanScript(site, d.SITES, overrides(site), word, PROBE_PHRASE)) : null;
    return {
      loadFailed: !!rs.loadFailed, signals: sig.codes || [], send: sendRes,
      read: { textLen: Number(rs.textLen || 0), generating: !!rs.generating, generatingMs: Number(rs.generatingMs || 0), hasWord: !!(word && String(rs.text || '').toLowerCase().indexOf(word.toLowerCase()) !== -1) },
      page: sc && sc.ok ? { wordOnPage: !!sc.wordOnPage, userBubble: !!sc.userBubble } : {},
      captured: !!captured, stuckMs: opt.stuckMs
    };
  }
  async function probeOnce(site, reason) {
    const x = S[site];
    x.lastProbeAt = now();
    x.lastCheckReason = reason;
    // cheap checks first: a page that didn't load, a log-in page, a captcha, a limit
    const rs0 = readState(site);
    if (rs0.loadFailed) return { ok: false, code: 'NETWORK_ERROR', word: null };
    const sig = await signalsOf(site);
    const user = (sig.codes || []).map((c) => c.code).find((c) => USER_ONLY.has(c));
    if (user) return { ok: false, code: user, word: null, signals: sig.codes };
    const word = pickWord(wordsFor(site));
    let resolve; const got = new Promise((r) => { resolve = r; });
    const a = { word, resolve, captured: false };
    awaiting[site] = a;
    (recent[site] = (recent[site] || []).filter((r) => r.until > now())).push({ word, until: now() + opt.recentWordsMs });
    event('probe', { site, reason, step: 'check' });
    const token = { cancelled: false, typing: false };
    let sendRes;
    try {
      const sendP = Promise.resolve(d.sendProbe(site, probeText(word), token));
      const tm = sleep(opt.sendTimeoutMs).then(() => ({ timedOut: true }));
      sendRes = await Promise.race([sendP, tm]);
      if (sendRes && sendRes.timedOut) { token.cancelled = true; sendRes = await sendP.catch(() => ({ ok: false, error: 'CANCELLED' })); }
    } catch (e) { sendRes = { ok: false, error: 'EXCEPTION' }; }
    sendRes = sendRes && typeof sendRes === 'object' ? { ok: !!sendRes.ok, error: sendRes.error || null, verified: sendRes.verified } : { ok: false, error: 'UNKNOWN' };
    try {
      if (sendRes.ok || a.captured) {
        const t0 = now();
        let quietSince = 0;
        while (!a.captured && now() - t0 < opt.probeTimeoutMs) {
          const r = await Promise.race([got, sleep(opt.pollStepMs).then(() => false)]);
          if (r === true || a.captured) break;
          // early stop: the reader already shows the answer but nothing took it
          const rs = readState(site);
          const hasWord = String(rs.text || '').toLowerCase().indexOf(word) !== -1;
          if (hasWord && !rs.generating) { if (!quietSince) quietSince = now(); if (now() - quietSince >= opt.earlyQuietMs) break; }
          else quietSince = 0;
        }
      }
      if (a.captured) return { ok: true, word };
      const ev = await evidence(site, word, sendRes, false);
      return { ok: false, code: classify(ev), word, send: sendRes.ok ? 'ok' : sendRes.error };
    } finally { if (awaiting[site] === a) delete awaiting[site]; }
  }

  function markOk(site, how) {
    const x = S[site];
    x.lastProbeOkAt = now();
    const wasBad = x.state !== 'ok' && x.state !== 'unknown';
    if (wasBad) x.fixedAt = now();
    setState(site, 'ok', null);
    event('result', { site, outcome: wasBad ? 'FIXED' : 'OK', how });
    emit(site, wasBad ? { kind: 'fixed', how } : { kind: 'ok' });
    return { ok: true, state: 'ok', fixed: wasBad, how };
  }
  function needsUser(site, code) {
    setState(site, 'needs_user', code);
    S[site].lastSignalCheckAt = now();
    event('result', { site, outcome: 'NEEDS_USER', code });
    emit(site, { kind: 'needs_user', code });
    return { ok: false, state: 'needs_user', problem: code };
  }
  function broken(site, code) {
    setState(site, 'broken', code);
    event('result', { site, outcome: 'BROKEN', code });
    emit(site, { kind: 'broken', code });
    return { ok: false, state: 'broken', problem: code };
  }

  // ---- repair steps -------------------------------------------------------------------------
  async function runStep(site, step, code, last) {
    const word = last && last.word;
    if (step === 'retry') return { applied: true, outcome: 'RETRY' };
    if (step === 'alternatives') {
      const roles = (ALT_ROLES[code] || ALT_ROLES.UNKNOWN).filter((r) => r !== 'assistant' || word);
      if (!roles.length) return { applied: false, outcome: 'NO_WORD' };
      const r = await page(site, buildAlternativesScript(site, d.SITES, overrides(site), roles, word, PROBE_PHRASE));
      const found = (r && r.found) || {};
      const learned = Object.keys(found).filter((role) => found[role] && found[role] !== (overrides(site) || {})[role]);
      for (const role of learned) { try { d.saveLearned(site, role, found[role], 'alternative'); } catch (_) {} event('learned', { site, role, how: 'alternative' }); }
      return { applied: learned.length > 0, outcome: learned.length ? `FOUND:${learned.join('+')}` : 'NONE_WORKED' };
    }
    if (step === 'page_search') {
      if (!word) return { applied: false, outcome: 'NO_WORD' };
      const r = await page(site, buildLearnReplyScript(word, PROBE_PHRASE));
      if (!r || !r.ok || !r.selector) return { applied: false, outcome: (r && r.reason) || 'NOT_FOUND' };
      try { d.saveLearned(site, 'assistant', r.selector, 'page-search'); } catch (_) {}
      event('learned', { site, role: 'assistant', how: 'page-search' });
      return { applied: true, outcome: 'LEARNED' };
    }
    if (step === 'unfreeze') {
      const r = await page(site, buildUnfreezeScript(site, d.SITES, overrides(site)));
      if (!r || !r.pressed) return { applied: false, outcome: 'NO_STOP_BUTTON' };
      await sleep(opt.unfreezeWaitMs);
      return { applied: true, outcome: 'PRESSED_STOP' };
    }
    if (step === 'reload' || step === 'reload_home') {
      let r;
      try { r = await d.reload(site, { home: step === 'reload_home' }); } catch (_) { r = { ok: false }; }
      if (!r || !r.ok) return { applied: false, outcome: 'RELOAD_FAILED' };
      await sleep(opt.reloadSettleMs);
      return { applied: true, outcome: 'RELOADED' };
    }
    return { applied: false, outcome: 'SKIPPED' };
  }

  async function runCheck(site, reason, o) {
    const x = S[site];
    if (!x) return { skipped: 'unknown_site' };
    if (x.running) return { skipped: 'checking' };
    if (x.teach && x.teach.active) return { skipped: 'teaching' };
    x.running = true; x.step = 'check'; x.pending = null;
    emit(site);
    try {
      let r = await probeOnce(site, reason);
      if (r.ok) return markOk(site, 'check-in');
      let code = r.code;
      event('detect', { site, code, reason });
      if (USER_ONLY.has(code)) { note(site, 'signals', code, 'FOUND'); return needsUser(site, code); }
      if (o && o.repair === false) return broken(site, code);
      setState(site, 'repairing', code);
      const done = new Set();
      let ladder = (LADDERS[code] || LADDERS.UNKNOWN).slice();
      while (ladder.length) {
        const step = ladder.shift();
        if (done.has(step)) continue;
        done.add(step);
        if (step === 'give_up') break;
        if (step === 'teach') { x.running = false; x.step = null; startTeach(site, code, { auto: true }); return { ok: false, state: 'needs_user', problem: code, teach: true }; }
        x.step = step; emit(site);
        const out = await runStep(site, step, code, r);
        note(site, step, code, out.outcome);
        if (!out.applied) continue;
        x.step = 'check'; emit(site);
        r = await probeOnce(site, `after-${step}`);
        if (r.ok) { note(site, step, code, 'FIXED'); return markOk(site, step); }
        note(site, 'check', r.code, 'STILL_FAILING');
        if (USER_ONLY.has(r.code)) return needsUser(site, r.code);
        if (r.code !== code) { code = r.code; setState(site, 'repairing', code); ladder = (LADDERS[code] || LADDERS.UNKNOWN).filter((s) => !done.has(s)); }
      }
      return broken(site, code);
    } catch (e) {
      event('error', { site, outcome: 'EXCEPTION' });
      return broken(site, 'UNKNOWN');
    } finally { x.running = false; x.step = null; emit(site); }
  }

  // ---- P18.7 teach ----------------------------------------------------------------------------
  async function startTeach(site, code, o) {
    const x = S[site];
    if (!x) return { ok: false, error: 'BAD_SITE' };
    if (x.teach && x.teach.active) return { ok: true, already: true, number: x.teach.number };
    if (x.running && !(o && o.auto)) return { ok: false, error: 'CHECKING' };
    const number = pickNumber();
    x.teach = { active: true, number, phase: 'type', startedAt: now(), learned: {}, sendHow: null, missing: [], result: null, code: code || x.problem || null };
    teachCtl[site] = { cancel: false };
    setState(site, 'needs_user', code || x.problem || 'UNKNOWN');
    event('teach', { site, outcome: 'STARTED', code: x.teach.code });
    emit(site, { kind: 'teach', phase: 'type' });
    // run the watcher loop in the background
    teachLoop(site).catch(() => {});
    return { ok: true, number };
  }
  async function teachLoop(site) {
    const x = S[site];
    const t = x.teach;
    const ctl = teachCtl[site];
    const L = label(site);
    let installed = await page(site, buildTeachStartScript(L, t.number));
    let summary = null;
    while (!ctl.cancel && now() - t.startedAt < opt.teachTimeoutMs) {
      await sleep(opt.teachPollMs);
      if (ctl.cancel) break;
      let r = await page(site, buildTeachPollScript());
      if (!r || !r.ok) {
        // the page was reloaded / navigated: put the watcher back (same number)
        if (!installed || !installed.ok || (r && r.error === 'NO_TEACH')) installed = await page(site, buildTeachStartScript(L, t.number));
        continue;
      }
      summary = r;
      const before = JSON.stringify([t.phase, t.learned, t.sendHow]);
      t.phase = r.phase;
      t.sendHow = r.sendHow || null;
      t.learned = { input: !!(r.selectors && r.selectors.input), send: !!(r.selectors && r.selectors.send) || r.sendHow === 'enter', user: !!(r.selectors && r.selectors.user), reply: !!(r.selectors && r.selectors.assistant) };
      if (JSON.stringify([t.phase, t.learned, t.sendHow]) !== before) {
        event('teach', { site, outcome: `PHASE_${String(t.phase).toUpperCase()}`, how: t.sendHow || undefined });
        emit(site, { kind: 'teach', phase: t.phase });
      }
      if (r.phase === 'done') break;
    }
    await page(site, buildTeachStopScript());
    if (ctl.cancel) {
      t.active = false; t.result = 'cancelled';
      event('teach', { site, outcome: 'CANCELLED' });
      return broken(site, t.code || 'UNKNOWN');
    }
    const sel = (summary && summary.selectors) || {};
    // save what was learned (each part separately)
    const saved = [];
    if (sel.input) { d.saveLearned(site, 'input', sel.input, 'teach'); saved.push('input'); }
    if (sel.send) { d.saveLearned(site, 'send', sel.send, 'teach'); saved.push('send'); }
    if (sel.user) { d.saveLearned(site, 'user', sel.user, 'teach'); }
    if (sel.assistant) { d.saveLearned(site, 'assistant', sel.assistant, 'teach'); saved.push('assistant'); }
    for (const role of saved) event('learned', { site, role, how: 'teach' });
    t.missing = [];
    if (!sel.input) t.missing.push('input');
    if (!sel.send && t.sendHow !== 'enter') t.missing.push('send');
    if (!sel.assistant) t.missing.push('assistant');
    const timedOut = !summary || summary.phase !== 'done';
    t.active = false;
    if (timedOut && !saved.length) {
      t.result = 'timeout';
      event('teach', { site, outcome: 'TIMEOUT' });
      note(site, 'teach', t.code, 'TIMEOUT');
      return broken(site, t.code || 'UNKNOWN');
    }
    note(site, 'teach', t.code, saved.length ? `LEARNED:${saved.join('+')}` : 'NOTHING_LEARNED');
    // confirm with a new check-in
    x.running = true; x.step = 'check'; emit(site, { kind: 'teach', phase: 'confirming' });
    let r;
    try { r = await probeOnce(site, 'after-teach'); } finally { x.running = false; x.step = null; }
    if (r.ok) { t.result = 'fixed'; note(site, 'teach', t.code, 'FIXED'); return markOk(site, 'teach'); }
    t.result = 'failed';
    if (!t.missing.length) t.missing = ALT_ROLES[r.code] ? ALT_ROLES[r.code].filter((role) => role !== 'stop') : ['assistant'];
    note(site, 'check', r.code, 'STILL_FAILING');
    if (USER_ONLY.has(r.code)) return needsUser(site, r.code);
    return broken(site, r.code);
  }
  function cancelTeach(site) {
    if (!teachCtl[site] || !teachActive(site)) return { ok: false, error: 'NOT_TEACHING' };
    teachCtl[site].cancel = true;
    return { ok: true };
  }

  // ---- scheduling (P18.1 / P18.8) ---------------------------------------------------------------
  function busy(site, level) { try { return (typeof d.busyReason === 'function' && d.busyReason(site, level)) || null; } catch (_) { return 'busy'; } }
  function isActive(site) { try { return typeof d.isActive === 'function' ? !!d.isActive(site) : true; } catch (_) { return false; } }
  // Start check-ins now (not awaited). level: 'periodic' | 'startup' | 'demand'.
  function probeMany(list, reason, level) {
    const want = Array.isArray(list) && list.length ? list : sites.filter(isActive);
    const started = []; const skipped = {};
    for (const site of want) {
      if (!S[site]) { skipped[site] = 'unknown_site'; continue; }
      if (!isActive(site)) { skipped[site] = 'inactive'; continue; }
      if (S[site].running) { skipped[site] = 'checking'; continue; }
      if (teachActive(site)) { skipped[site] = 'teaching'; continue; }
      const b = busy(site, level || 'demand');
      if (b) { skipped[site] = b; continue; }
      started.push(site);
      runCheck(site, reason || 'demand').catch(() => {});
    }
    if (started.length || Object.keys(skipped).length) event('probe_many', { reason, outcome: `started:${started.length} skipped:${Object.keys(skipped).length}` });
    return { started, skipped };
  }
  // Something went wrong in normal use (a timeout, a stall): check this AI when it is free.
  function requestCheck(site, reason) {
    const x = S[site];
    if (!opt.autoChecks || !x || x.running || teachActive(site)) return false;
    x.pending = { reason: String(reason || 'request').slice(0, 40), at: now() };
    event('pending', { site, reason: x.pending.reason });
    return true;
  }
  function startup(site) {
    const x = S[site];
    if (!opt.autoChecks || !x || x.startupDone) return false;
    x.startupDone = true;
    x.pending = { reason: 'startup', at: now() };
    return true;
  }
  let lastTick = 0;
  async function tick() {
    const t = now();
    lastTick = t;
    for (const site of sites) {
      const x = S[site];
      if (x.running || teachActive(site) || !isActive(site)) continue;
      // P18.8: a user-only problem — cheap signature check every needsUserRecheckMs
      if (x.state === 'needs_user' && USER_ONLY.has(x.problem)) {
        if (t - x.lastSignalCheckAt < opt.needsUserRecheckMs) continue;
        x.lastSignalCheckAt = t;
        const sig = await signalsOf(site);
        const still = (sig.codes || []).some((c) => c.code === x.problem);
        event('recheck', { site, code: x.problem, outcome: still ? 'STILL_THERE' : 'GONE' });
        if (!still && !busy(site, 'demand')) runCheck(site, 'user-fixed').catch(() => {});
        continue;
      }
      if (x.pending) {
        const lvl = x.pending.reason === 'startup' ? 'startup' : 'demand';
        if (!busy(site, lvl)) { const why = x.pending.reason; x.pending = null; runCheck(site, why).catch(() => {}); }
        continue;
      }
      const every = opt.intervalMs;
      if (every > 0 && t - Math.max(x.lastProbeAt || 0, createdAt) >= every && !busy(site, 'periodic')) runCheck(site, 'periodic').catch(() => {});
    }
  }
  // The page changed (navigated / loaded): a user-only problem may be fixed now.
  function onPageChanged(site) {
    const x = S[site];
    if (!x || x.state !== 'needs_user' || !USER_ONLY.has(x.problem)) return;
    x.lastSignalCheckAt = 0; // the next tick checks right away
  }
  // A normal exchange worked (a proven send got its reply): the AI works again.
  function noteWorking(site) {
    const x = S[site];
    if (!x || x.running || teachActive(site)) return;
    if (x.state === 'broken' || (x.state === 'needs_user' && USER_ONLY.has(x.problem))) { event('result', { site, outcome: 'WORKING_AGAIN', how: 'normal-reply' }); markOk(site, 'normal-reply'); }
  }
  function setIntervalMs(ms) { opt.intervalMs = Math.max(0, Number(ms) || 0); }

  // BookForge contract v1.2 fields
  function health(site) {
    const x = S[site];
    if (!x) return { state: 'unknown', problem: null, since: null, last_probe_ok_at: null };
    return { state: x.state, problem: x.problem, since: x.since, last_probe_ok_at: x.lastProbeOkAt };
  }
  function isUsable(site) { const x = S[site]; return !x || x.state === 'ok' || x.state === 'unknown'; }

  return {
    runCheck, probeMany, requestCheck, startup, tick, onPageChanged, noteWorking,
    onCaptured, expects, awaitingReply, teachActive, startTeach, cancelTeach,
    state: snap, snapshot: () => Object.fromEntries(sites.map((s) => [s, snap(s)])), health, isUsable,
    events: () => events.map((e) => Object.assign({}, e)), setIntervalMs, options: opt, lastTick: () => lastTick
  };
}

module.exports = {
  CODES, USER_ONLY, STATES, PROBLEM_TEXT, STEP_TEXT, PAGE_SIGNATURES, NOTICE_SELECTOR, ALT_SELECTORS, LADDERS, ALT_ROLES,
  LEARNED_VERSION, MARKER, PROBE_PHRASE, TEACH_PHRASE, WORDS,
  describeProblem, signaturesFor, altsFor, pageKit, classify, createSelfRepair, sanitizeLearned,
  buildSignalScript, buildScanScript, buildAlternativesScript, buildLearnReplyScript, buildUnfreezeScript,
  buildTeachStartScript, buildTeachPollScript, buildTeachStopScript, teachBanner, probeText, pickWord, pickNumber
};
