'use strict';
/*
 * self-repair.js — "AIs that always answer" (Akọwe improvement plan, Section 1,
 * P18.1–P18.8 + P18.10). PURE NODE: no Electron import. main.js supplies the
 * pane-facing pieces (send a message, run a page script, reload, read state).
 *
 *   P18.1  Check-in probe: a tiny message "Reply with only this word: <word>" sent
 *          to an AI at start, every N minutes while it is idle, and on demand
 *          (Akọwe POST /v1/probe). Its reply is owned here: never relayed to
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
 *   P38    🔢 Number teach (replaces the P18.7 teach box): the user types the shown
 *          4 digits into the AI and presses Send (the watcher learns the box, Send and
 *          the user's message), AutoInjector then asks the AI to write the number
 *          backwards and learns the reply area from where the reversed digits appear;
 *          saved like a 🎯 Save, confirmed by a check-in. Never started by itself.
 *   P38    🎯 Picker page script (pickStart): point at ONE thing; hover outlines it.
 *   P37.1  Every learned selector is GENERAL: per-message numbers/ids/keys are stripped
 *          (fallback-turn-7:2:assistant -> [..$=":assistant"]) and, with 2+ replies on
 *          the page, it must match at least two of them.
 *   P37.3  After every automatic fix failed: one notice for the user (ask_user), no
 *          automatic teach step, re-checks back off 5 -> 15 -> 60 minutes.
 *   P37.4  probeReplyKind: late / unproven check-in and teach answers are never
 *          relayed or nagged about missing tags.
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

// Plain words for each code (the panel, the log's "say" line and Akọwe's 503 message).
const PROBLEM_TEXT = {
  TYPE_FAILED: { short: "can't type", say: (L) => `AutoInjector can't find or type into ${L}'s message box.` },
  SEND_NOT_CONFIRMED: { short: "can't send", say: (L) => `AutoInjector typed into ${L} but the message didn't go out (the Send button may have moved).` },
  NO_REPLY_FOUND: { short: "can't read replies", say: (L) => `${L} answered, but AutoInjector can't find its replies on the page.` },
  FALSE_DUPLICATE: { short: 'reply taken as old', say: (L) => `${L}'s new reply was mistaken for an old one.` },
  STUCK_GENERATING: { short: 'stuck writing', say: (L) => `${L} seems stuck — it keeps "writing" and never finishes.` },
  LOGGED_OUT: { short: 'logged out', say: (L) => `${L} is logged out.`, fix: (L) => [`Open ${L}'s window (its pane in AutoInjector) and log in.`, 'AutoInjector notices by itself when you are back and checks again — nothing else to do.'] },
  CAPTCHA: { short: 'human check', say: (L) => `${L} is showing an "are you a human?" check.`, fix: (L) => [`Open ${L}'s window and complete the check (tick the box / solve the puzzle).`, 'AutoInjector notices by itself when it is gone and checks again.'] },
  USAGE_LIMIT: { short: 'usage limit', say: (L) => `${L} says you've reached its usage limit.`, fix: (L) => [`Wait until the time ${L} shows in its window (or switch to another account / plan).`, 'AutoInjector re-checks every minute and carries on by itself when the limit is gone.', 'Meanwhile Akọwe can use your other AIs.'] },
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
  // P37.1: words in an attribute value that say WHAT KIND of message it is (kept
  // when the per-message number around them is stripped).
  const ROLE_WORD = /^(?:assistant|model|bot|ai|response|answer|reply|agent|user|human|query|prompt|request)$/i;
  const DIGIT = /\d/;
  function q(v) { return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }
  // P37.1: a value that names ONE message ("fallback-turn-7:2:assistant", "msg-41")
  // -> the parts every message of that kind shares: [a$=":assistant"], [a*="assistant"],
  // [a^="fallback-turn-"]. Never the number itself.
  function partialsFor(tag, n, v, add) {
    if (!v || v.length > 80 || /["\\\n\r\s]/.test(v)) return;
    const first = v.search(/\d/);
    if (first < 0) return;
    let last = -1; for (let i = v.length - 1; i >= 0; i--) if (DIGIT.test(v.charAt(i))) { last = i; break; }
    const suffix = v.slice(last + 1); const prefix = v.slice(0, first);
    if (/[a-z]{3,}/i.test(suffix) && suffix.length <= 40) { add(tag + '[' + n + '$=' + q(suffix) + ']', 93); add('[' + n + '$=' + q(suffix) + ']', 90); }
    for (const w of v.split(/[^A-Za-z]+/).filter((x) => ROLE_WORD.test(x)).slice(0, 2)) add(tag + '[' + n + '*=' + q(w) + ']', 86);
    if (/[a-z]{3,}/i.test(prefix) && prefix.length <= 40) add(tag + '[' + n + '^=' + q(prefix) + ']', 72);
  }
  function candidatesFor(e, role) {
    const tag = String(e.localName || e.tagName || '').toLowerCase();
    if (!tag || !IDENT.test(tag)) return [];
    const out = [];
    const add = (sel, score) => out.push({ sel, score });
    if (tag.indexOf('-') !== -1) add(tag, 90);
    // Message blocks (assistant / user): attribute VALUES must look like names, never
    // like words someone wrote (no spaces, no labels/titles) — a learned selector must
    // never carry page text, and must match the NEXT reply too (P37.1: no value with
    // a digit in it — turn numbers, ids and indices name ONE message).
    const block = role === 'assistant' || role === 'user' || role === 'anchor';
    const volatile = (v) => VOLATILE.test(v) || (block && DIGIT.test(v));
    for (const a of Array.from(e.attributes || [])) {
      const n = String(a.name || '').toLowerCase(); const v = String(a.value == null ? '' : a.value);
      if (!IDENT.test(n)) continue;
      if (n.indexOf('data-') === 0 && !SKIP_DATA.test(n)) {
        if (v && v.length <= 40 && !volatile(v) && !/[\n\r]/.test(v) && !(block && /\s/.test(v))) { add(tag + '[' + n + '=' + q(v) + ']', 100); add('[' + n + '=' + q(v) + ']', 97); }
        else {
          if (block) partialsFor(tag, n, v, add);
          add(tag + '[' + n + ']', /(?:^|-)id$|-key$|uuid/.test(n) ? 66 : 60);
        }
      } else if (n === 'role' && v && !/\s/.test(v)) add(tag + '[role=' + q(v) + ']', role === 'assistant' ? 70 : 80);
      else if (!block && (n === 'aria-label' || n === 'mattooltip' || n === 'title') && v && v.length <= 40 && !VOLATILE.test(v)) add(tag + '[' + n + '=' + q(v) + ']', 82);
      else if (n === 'id' && IDENT.test(v) && !volatile(v)) add('#' + v, block ? 5 : 88);
      else if (n === 'id' && block) partialsFor(tag, 'id', v, (sel, score) => add(sel, score - 20));
      else if ((n === 'name' || n === 'placeholder') && v && v.length <= 40 && role === 'input') add(tag + '[' + n + '=' + q(v) + ']', 78);
      else if (n === 'type' && v === 'submit' && role === 'send') add(tag + '[type="submit"]', 55);
    }
    const cls = String((e.className && e.className.baseVal != null ? e.className.baseVal : e.className) || '').split(/\s+/).filter((c) => c && c.length <= 40 && IDENT.test(c) && !volatile(c));
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

  // ---- reply blocks (P18.4 page search; the teach step; the 🎯 picker) ----------
  // A user-message test from a phrase (the check-in / teach text) and/or a selector
  // list of known user-message markers.
  function userTest(phrase, userSel) {
    return (e) => {
      if (!e || e.nodeType !== 1) return false;
      if (phrase && lc(textOf(e)).indexOf(lc(phrase)) !== -1) return true;
      if (userSel) { if (safeMatches(e, userSel)) return true; try { if (e.closest && e.closest(userSel)) return true; } catch (_) {} const k = qsa(e, userSel); if (k && k.length) return true; }
      return false;
    };
  }
  // P37.1: the highest ancestor of `base` that is still only this message (the next
  // one up holds the user's message, the message box or our overlay).
  function turnOf(base, isUser) {
    let top = base;
    for (let i = 0; i < 14 && top.parentElement && top.parentElement.tagName !== 'BODY' && top.parentElement.tagName !== 'HTML'; i++) {
      const p = top.parentElement;
      if (isUser(p) || holdsEditable(p) || inOverlay(p)) break;
      top = p;
    }
    return top;
  }
  function shapeOf(e) {
    const names = Array.from(e.attributes || []).map((a) => String(a.name).toLowerCase()).filter((n) => n !== 'id' && n !== 'style' && n !== 'class').sort().join(',');
    const cls = String((e.className && e.className.baseVal != null ? e.className.baseVal : e.className) || '').split(/\s+/).filter((c) => c && !DIGIT.test(c)).sort().join('.');
    return String(e.localName || '') + '|' + names + '|' + cls;
  }
  // How many messages of the same kind (same tag, attribute names and classes as
  // this message's top element, not the user's) are on the page.
  function peersOf(doc, turn, isUser) {
    const want = shapeOf(turn);
    let n = 0;
    for (const e of qsa(doc, String(turn.localName || '*')) || []) {
      if (shapeOf(e) !== want || inOverlay(e) || holdsEditable(e) || isUser(e) || !textOf(e).trim()) continue;
      n++;
    }
    return n;
  }
  // o = { isUser, word (the newest match must hold it), cover (some match must
  // hold this element), minCount (P37.1: must match at least this many) }
  function validateBlocks(doc, sel, o) {
    const list = qsa(doc, sel);
    if (!list || !list.length) return { ok: false, reason: 'NO_MATCH' };
    const l = list.filter((x) => !inOverlay(x));
    if (!l.length) return { ok: false, reason: 'NO_MATCH' };
    if (l.length > 200) return { ok: false, reason: 'TOO_BROAD' };
    if (l.some((x) => o.isUser(x))) return { ok: false, reason: 'MATCHES_USER_MESSAGE' };
    if (l.some((x) => inEditable(x) || holdsEditable(x))) return { ok: false, reason: 'MATCHES_MESSAGE_BOX' };
    if (l.length > 1 && l.some((x) => l.some((y) => y !== x && x.contains(y)))) return { ok: false, reason: 'NESTED' };
    const last = l[l.length - 1];
    if (o.word && lc(textOf(last)).indexOf(lc(o.word)) === -1) return { ok: false, reason: 'NEWEST_LACKS_WORD' };
    if (o.cover && !l.some((x) => overlaps(x, o.cover))) return { ok: false, reason: 'MISSES_PICK' };
    if (o.minCount && l.length < o.minCount) return { ok: false, reason: 'TOO_NARROW' };
    return { ok: true, count: l.length };
  }
  // isUser(el) -> true when the element is (or holds) the user's own message.
  function validateReply(doc, sel, word, isUser) { return validateBlocks(doc, sel, { word, isUser }); }
  // P37.1: learn a selector that fits EVERY reply, not one: per-message numbers are
  // never part of it (candidatesFor), and when two or more replies are on the page
  // it must match at least two of them (else it names one message: rejected).
  function learnReplyFrom(doc, base, word, isUser, opts) {
    const o = opts || {};
    const levels = [];
    for (let e = base, i = 0; e && e.nodeType === 1 && e.tagName !== 'BODY' && e.tagName !== 'HTML' && i < 12; e = e.parentElement, i++) {
      if (isUser(e) || holdsEditable(e) || inOverlay(e)) break;
      levels.push(e);
    }
    if (!levels.length) return { ok: false, reason: 'NO_CONTAINER' };
    const peers = peersOf(doc, turnOf(base, isUser), isUser);
    const minCount = peers >= 2 ? 2 : 0;
    const baseLen = textOf(base).trim().length;
    let best = null; let tried = 0; let narrow = 0;
    levels.forEach((node, li) => {
      const t = textOf(node);
      const tight = t.trim().length <= baseLen + 160 && (t.match(/\[\s*FROM\s*:/gi) || []).length <= 1;
      for (const c of withAncestors(node, candidatesFor(node, 'assistant'))) {
        tried++;
        const v = validateBlocks(doc, c.sel, { word, isUser, cover: o.cover || null, minCount });
        if (!v.ok) { if (v.reason === 'TOO_NARROW') narrow++; continue; }
        const score = c.score + (tight ? li * 3 : -40);
        if (!best || score > best.score) best = { selector: c.sel, score, count: v.count, level: li };
      }
    });
    if (!best) return { ok: false, reason: narrow ? 'ONLY_ONE_MESSAGE' : 'NO_STABLE_SELECTOR', tried, peers };
    return { ok: true, selector: best.selector, count: best.count, level: best.level, score: best.score, tried, peers };
  }
  // P18.4: the check-in word in a NEW element that is not the user's message (which
  // holds `phrase`, e.g. "reply with only this word") and not the message box.
  function learnReply(doc, word, phrase, userSel) {
    const isUser = userTest(phrase, userSel);
    const bases = findText(doc, word, (e) => !isUser(e) && !inEditable(e) && !inOverlay(e));
    if (!bases.length) return { ok: false, reason: 'WORD_NOT_FOUND' };
    return learnReplyFrom(doc, bases[bases.length - 1], word, isUser);
  }
  // P37.2: the whole text of the message an element belongs to (its top element).
  function wholeText(base) { return base ? String(base.innerText || textOf(base) || '') : ''; }

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

  // ---- P38 🔢 number teach -----------------------------------------------------------
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
  // 🎨 A picture ChatGPT made: a selector that finds it (and the next ones like it)
  // without matching every <img> on the page — anchored on its message / turn /
  // image container, else its alt text or an image-ish class.
  function deriveImage(doc, img) {
    const okSel = (sel) => { const l = qsa(doc, sel); return !!l && l.length >= 1 && l.length <= 60 && l.indexOf(img) >= 0; };
    const cands = [];
    const tokOk = (t) => t && t.length <= 40 && !/[:/\[\]()!@%]/.test(t) && /image|img|picture|media|imagegen/i.test(t);
    let a = img.parentElement;
    for (let i = 0; a && i < 10 && a.tagName !== 'BODY'; i++, a = a.parentElement) {
      if (inOverlay(a)) break;
      const tag = a.localName;
      const role = a.getAttribute('data-message-author-role'); if (role) cands.push('[data-message-author-role=' + q(role) + '] img');
      const turn = a.getAttribute('data-turn'); if (turn) cands.push(tag + '[data-turn=' + q(turn) + '] img');
      const tid = a.getAttribute('data-testid'); if (tid) { const m = /^(.*?-)\d+$/.exec(tid); cands.push(m ? '[data-testid^=' + q(m[1]) + '] img' : '[data-testid=' + q(tid) + '] img'); }
      for (const t of String((a.className && a.className.baseVal !== undefined ? a.className.baseVal : a.className) || '').split(/\s+/)) if (tokOk(t)) cands.push('.' + t + ' img');
    }
    const alt = String(img.getAttribute('alt') || '').trim();
    if (alt && alt.length <= 40) cands.push('img[alt=' + q(alt) + ']');
    else if (alt) cands.push('img[alt^=' + q(alt.slice(0, 24)) + ']');
    for (const t of String(img.className || '').split(/\s+/)) if (tokOk(t)) cands.push('img.' + t);
    for (const c of cands) if (okSel(c)) return c;
    return null;
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
  function overlay(doc, text, extra) {
    const b = doc.createElement('div');
    b.setAttribute('data-autoinjector-overlay', '1');
    b.setAttribute('role', 'status');
    b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#3b2a8a;color:#fff;font:600 15px/1.4 system-ui,sans-serif;padding:10px 16px;text-align:center;pointer-events:none;box-shadow:0 2px 10px rgba(0,0,0,.4)' + (extra || '');
    b.textContent = text;
    (doc.body || doc.documentElement).appendChild(b);
    return b;
  }
  function teachState(win) { return win && win.__aiTeach ? win.__aiTeach : null; }
  // PC test 2026-10-28: the success message vanished at once. After the teach, a
  // green note stays in the AI's window for `ms` (default 12 s) or until its ✕ is
  // clicked. It never blocks the page (only the ✕ takes clicks).
  function teachDone(doc, win, text, ms, tone) {
    for (const o of qsa(doc, OVERLAY) || []) { try { o.remove(); } catch (_) {} }
    const b = overlay(doc, text, tone === 'err' ? ';background:#6b2c30' : ';background:#1f7a4a');
    b.setAttribute('data-autoinjector-done', '1');
    const x = doc.createElement('button');
    x.type = 'button'; x.textContent = '✕'; x.title = 'Close'; x.setAttribute('aria-label', 'Close');
    x.style.cssText = 'pointer-events:auto;margin-left:12px;background:transparent;color:#fff;border:1px solid rgba(255,255,255,.6);border-radius:4px;cursor:pointer;font:inherit;padding:0 6px';
    x.addEventListener('click', (ev) => { try { ev.preventDefault(); ev.stopPropagation(); b.remove(); } catch (_) {} }, true);
    b.appendChild(x);
    try { setTimeout(() => { try { b.remove(); } catch (_) {} }, Math.max(1000, Number(ms) || 12000)); } catch (_) {}
    return { ok: true };
  }
  // The user types the shown digits into the AI's box and presses Send; the watcher
  // learns the box (where the digits appear while typing), how it was sent (the
  // click / Enter that emptied the box) and the user's message block (the digits in
  // a new block). AutoInjector then asks the AI to write the number BACKWARDS
  // (teachAsked) and the watcher learns the reply area from where the reversed
  // digits appear — in a new block that is neither the user's message nor the box.
  function teachInstall(doc, win, number, bannerText, reversed, phrase, userSel) {
    teachRemove(doc, win);
    const num = String(number);
    const pre = new Set(findText(doc, num, () => true));
    const st = { number: num, reversed: String(reversed || num.split('').reverse().join('')), phrase: lc(phrase || 'backwards, digits only'), userSel: userSel || '', phase: 'type', events: [], startedAt: Date.now(), input: null, send: null, sendHow: null, user: null, reply: null, replyKey: null, replyStableSince: 0, polls: 0, box: null, userBase: null, userTop: null, pre };
    win.__aiTeach = st;
    try { st.banner = overlay(doc, bannerText); } catch (_) {}
    st.onClick = (ev) => { try { const t = ev.target && ev.target.closest ? ev.target.closest('button, [role="button"], input[type="submit"]') : null; if (t && !inOverlay(t)) st.events.push({ type: 'click', t: Date.now(), el: t }); } catch (_) {} };
    st.onKey = (ev) => { try { if (ev.key === 'Enter' && !ev.shiftKey && ev.target && inEditable(ev.target)) st.events.push({ type: 'enter', t: Date.now() }); } catch (_) {} };
    // PC test 2026-10-28: typed and sent faster than one poll (0.8 s), the box was
    // never SEEN holding the digits and the teach hung at "You type the number".
    // Every keystroke now notes the box that holds the digits the moment it does.
    st.onInput = (ev) => {
      try {
        const tg = ev.target && ev.target.nodeType === 1 ? ev.target : (ev.target && ev.target.parentElement);
        if (!tg || inOverlay(tg)) return;
        const box = inEditable(tg) ? outerEditable(tg.closest ? (tg.closest('textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]') || tg) : tg) : null;
        if (box && editableValue(box).indexOf(st.number) !== -1) { st.seenBox = box; if (!st.seenTypedAt) st.seenTypedAt = Date.now(); }
      } catch (_) {}
    };
    try { doc.addEventListener('click', st.onClick, true); doc.addEventListener('mousedown', st.onClick, true); doc.addEventListener('keydown', st.onKey, true); doc.addEventListener('input', st.onInput, true); } catch (_) {}
    return { ok: true };
  }
  function teachRemove(doc, win) {
    const st = teachState(win);
    if (st) { try { doc.removeEventListener('click', st.onClick, true); doc.removeEventListener('mousedown', st.onClick, true); doc.removeEventListener('keydown', st.onKey, true); if (st.onInput) doc.removeEventListener('input', st.onInput, true); } catch (_) {} }
    for (const o of qsa(doc, OVERLAY) || []) { try { o.remove(); } catch (_) {} }
    if (win) { try { delete win.__aiTeach; } catch (_) { win.__aiTeach = undefined; } }
    return { ok: true };
  }
  // AutoInjector has sent "Write the number #### backwards, digits only." (P38).
  function teachAsked(doc, st, now, bannerText) {
    st.phase = 'wait_reply'; st.askedAt = now; st.replyKey = null;
    if (bannerText && st.banner) { try { st.banner.textContent = bannerText; } catch (_) {} }
    return teachSummary(st);
  }
  function teachIsUser(doc, st) {
    const userEls = st.user ? (qsa(doc, st.user) || []) : [];
    const known = userTest(null, st.userSel);
    return (e) => (st.userTop && overlaps(e, st.userTop)) || userEls.some((u) => overlaps(u, e)) || lc(textOf(e)).indexOf(st.phrase) !== -1 || known(e);
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
      } else if (st.phase === 'type' && (st.seenBox || findText(doc, num, (e) => !inEditable(e) && !inOverlay(e) && !st.pre.has(e)).length)) {
        // typed AND sent between two polls: the box was only seen by the input
        // listener (or not at all) — the digits are already in a new message
        if (st.seenBox && (doc.contains ? doc.contains(st.seenBox) : true)) { st.box = st.seenBox; st.input = deriveInput(doc, st.seenBox); }
        st.typedAt = st.seenTypedAt || now;
        st.phase = 'typed';
        st.fast = true;
      }
      if (!holding && st.phase === 'typed') {
        st.phase = 'sent'; st.sentAt = now;
        const recent = (type) => st.events.filter((x) => x.type === type && now - x.t < 5000).pop();
        const click = recent('click'); const enter = recent('enter');
        if (click && click.el && (!enter || click.t >= enter.t)) { st.sendHow = 'click'; st.send = deriveSend(doc, click.el); if (!st.send) st.sendHow = 'click-unlearned'; }
        else if (enter) st.sendHow = 'enter';
        else st.sendHow = 'unknown';
      }
    }
    if (st.phase === 'sent') {
      // the user's message: the digits in a NEW block (not the box, not our banner)
      const hits = findText(doc, num, (e) => !inEditable(e) && !inOverlay(e) && !st.pre.has(e));
      if (hits.length) {
        st.userBase = hits[0];
        st.userTop = blockTop(st.userBase, (p) => findText(p, num, () => true).length > 1);
        const ut = st.userTop;
        st.user = deriveFor(doc, ut, 'user', (sel) => { const l = qsa(doc, sel); return !!l && l.length >= 1 && l.length <= 200 && l.some((x) => overlaps(x, ut)) && !l.some((x) => holdsEditable(x) || inOverlay(x)); });
        st.phase = 'user_seen';
      } else if (now - st.sentAt > 20000) st.phase = 'user_seen';
    }
    if (st.phase === 'wait_reply') {
      const isUser = teachIsUser(doc, st);
      const ub = st.userBase;
      const hits = findText(doc, st.reversed, (e) => !inEditable(e) && !inOverlay(e) && !isUser(e) && (!ub || after(ub, e)));
      if (hits.length) {
        const r = hits[hits.length - 1];
        const key = lc(textOf(turnOf(r, isUser)));
        if (st.replyKey !== key) { st.replyKey = key; st.replyStableSince = now; }
        else if (now - st.replyStableSince >= 1200) {
          const res = learnReplyFrom(doc, r, st.reversed, isUser);
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

  // ---- P38 🎯 picker: point at ONE thing in the AI's window --------------------------
  // cfg = { role: input|send|assistant, banner, timeoutMs, markers (reply containers),
  //         userSel (user-message markers) }. Hovering outlines what a click would
  // pick; the click itself is swallowed (nothing is sent or opened). Resolves with
  // { ok, role, selector, preview, count } — the preview is for the panel only.
  const EDIT_SEL = 'textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]';
  function snapFor(doc, el, cfg) {
    if (!el || el.nodeType !== 1) return null;
    if (cfg.role === 'input') {
      let n = el.closest ? el.closest(EDIT_SEL) : null;
      if (!n) { const k = qsa(el, EDIT_SEL); n = k && k.length ? k[0] : null; }
      for (let p = el.parentElement, i = 0; !n && p && i < 4; p = p.parentElement, i++) { const k = qsa(p, EDIT_SEL); if (k && k.length) n = k.find(shown) || k[0]; }
      return n ? outerEditable(n) : null;
    }
    if (cfg.role === 'send') return el.closest ? el.closest('button, [role="button"], input[type="submit"]') : null;
    if (cfg.role === 'image') {
      if (el.tagName === 'IMG') return el;
      // a click on an overlay / wrapper over the picture: the biggest shown <img> nearby
      for (let p = el, i = 0; p && i < 4; p = p.parentElement, i++) {
        const k = (qsa(p, 'img') || []).filter((x) => shown(x) && !inOverlay(x));
        if (k.length) { k.sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight)); return k[0]; }
      }
      return null;
    }
    for (const m of cfg.markers || []) { try { const c = el.closest(m); if (c) return c; } catch (_) {} }
    return el;
  }
  function pickResolve(doc, el, cfg) {
    const target = snapFor(doc, el, cfg);
    if (!target || inOverlay(target)) return { ok: false, error: 'WRONG_ELEMENT_TYPE' };
    if (cfg.role === 'input') {
      if (!isEditable(target)) return { ok: false, error: 'WRONG_ELEMENT_TYPE' };
      const sel = deriveInput(doc, target);
      return sel ? { ok: true, role: 'input', selector: sel, preview: 'Message box found', count: (qsa(doc, sel) || []).length, tag: target.localName } : { ok: false, error: 'NO_STABLE_SELECTOR' };
    }
    if (cfg.role === 'image') {
      if (target.tagName !== 'IMG') return { ok: false, error: 'WRONG_ELEMENT_TYPE' };
      if ((target.naturalWidth || 0) < 200 || (target.naturalHeight || 0) < 200) return { ok: false, error: 'TOO_SMALL' };
      const sel = deriveImage(doc, target);
      return sel ? { ok: true, role: 'image', selector: sel, preview: 'Picture found (' + target.naturalWidth + '×' + target.naturalHeight + ')', count: (qsa(doc, sel) || []).length, tag: 'img' } : { ok: false, error: 'NO_STABLE_SELECTOR' };
    }
    if (cfg.role === 'send') {
      const sel = deriveSend(doc, target);
      return sel ? { ok: true, role: 'send', selector: sel, preview: 'Send button found', count: (qsa(doc, sel) || []).length, tag: target.localName } : { ok: false, error: 'NO_STABLE_SELECTOR' };
    }
    const isUser = userTest(null, cfg.userSel);
    if (inEditable(target) || holdsEditable(target)) return { ok: false, error: 'WRONG_ELEMENT_TYPE' };
    if (isUser(target)) return { ok: false, error: 'LOOKS_LIKE_USER' };
    const res = learnReplyFrom(doc, target, null, isUser, { cover: el });
    if (!res.ok) return { ok: false, error: res.reason || 'NO_STABLE_SELECTOR' };
    const l = (qsa(doc, res.selector) || []).filter((x) => !inOverlay(x));
    const mine = l.find((x) => overlaps(x, el)) || l[l.length - 1];
    const words = String(wholeText(mine)).replace(/\s+/g, ' ').trim();
    return { ok: true, role: 'assistant', selector: res.selector, preview: words.slice(0, 80) + (words.length > 80 ? '…' : ''), count: res.count, tag: mine ? mine.localName : null, latest: mine === l[l.length - 1] };
  }
  function pickStart(doc, win, cfg, resolve) {
    if (win.__aiPick) { try { win.__aiPick.cancel('REPLACED'); } catch (_) {} }
    let done = false;
    const parts = [];
    let box = null, timer = null;
    const finish = (r) => {
      if (done) return; done = true;
      try { if (timer) clearTimeout(timer); } catch (_) {}
      for (const [t, f] of [['mouseover', onOver], ['click', onClick], ['mousedown', block], ['pointerdown', block], ['mouseup', block], ['keydown', onKey]]) { try { doc.removeEventListener(t, f, true); } catch (_) {} }
      for (const p of parts) { try { p.remove(); } catch (_) {} }
      try { delete win.__aiPick; } catch (_) { win.__aiPick = undefined; }
      resolve(r);
    };
    function onOver(ev) {
      try {
        const t = snapFor(doc, ev.target, cfg);
        if (!t || inOverlay(t) || !box) return;
        const r = t.getBoundingClientRect();
        box.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border:3px solid #2f9bff;border-radius:6px;background:rgba(47,155,255,.12);left:' + (r.left - 3) + 'px;top:' + (r.top - 3) + 'px;width:' + (r.width + 6) + 'px;height:' + (r.height + 6) + 'px';
        box.setAttribute('data-target', String(t.localName || ''));
      } catch (_) {}
    }
    function block(ev) { if (ev && ev.target && inOverlay(ev.target)) return; try { ev.preventDefault(); ev.stopImmediatePropagation(); } catch (_) {} }
    function onClick(ev) {
      if (ev && ev.target && inOverlay(ev.target)) return;
      block(ev);
      finish(pickResolve(doc, ev.target, cfg));
    }
    function onKey(ev) { if (ev && ev.key === 'Escape') { block(ev); finish({ ok: false, error: 'CANCELLED' }); } }
    try {
      parts.push(overlay(doc, cfg.banner, ';background:#0b5ed7'));
      box = doc.createElement('div'); box.setAttribute('data-autoinjector-overlay', '1'); box.style.cssText = 'display:none'; (doc.body || doc.documentElement).appendChild(box); parts.push(box);
    } catch (_) {}
    for (const [t, f] of [['mouseover', onOver], ['click', onClick], ['mousedown', block], ['pointerdown', block], ['mouseup', block], ['keydown', onKey]]) { try { doc.addEventListener(t, f, true); } catch (_) {} }
    win.__aiPick = { cancel: (why) => finish({ ok: false, error: why || 'CANCELLED' }), cfg };
    timer = setTimeout(() => finish({ ok: false, error: 'TIMEOUT' }), Number(cfg.timeoutMs) || 60000);
    return { ok: true };
  }
  function pickCancel(win) { if (win && win.__aiPick) { try { win.__aiPick.cancel('CANCELLED'); } catch (_) {} return { ok: true, cancelled: true }; } return { ok: true, cancelled: false }; }
  // Does each saved selector still find its thing on the page? (red ⚠️ when not)
  function matchCheck(doc, sels, replyHints) {
    const out = {};
    for (const role of Object.keys(sels || {})) {
      const sel = sels[role]; if (!sel) continue;
      const l = qsa(doc, sel);
      if (l === null) { out[role] = { ok: false, count: 0, bad: true }; continue; }
      const vis = l.filter((e) => !inOverlay(e) && shown(e));
      out[role] = { ok: vis.length > 0, count: vis.length };
    }
    let repliesOnPage = 0;
    for (const s of replyHints || []) { const l = qsa(doc, s); if (l && l.length) { repliesOnPage = l.length; break; } }
    return { ok: true, roles: out, repliesOnPage };
  }

  return { findText, candidatesFor, validateReply, validateBlocks, learnReply, learnReplyFrom, userTest, turnOf, peersOf, wholeText, scan, tryAlternatives, signals, pressStop, teachInstall, teachRemove, teachStep, teachAsked, teachSummary, teachState, teachDone, deriveInput, deriveSend, deriveImage, pickStart, pickCancel, pickResolve, matchCheck };
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
function userSelFor(site) { return altsFor(site || 'generic', 'user').join(', '); }
function buildLearnReplyScript(word, phrase, site) {
  return kitScript(`const CFG = ${cfgJson({ word, phrase, user: site ? userSelFor(site) : '' })}; return K.learnReply(document, CFG.word, CFG.phrase, CFG.user);`);
}
function buildUnfreezeScript(site, SITES, overrides) {
  const lists = currentLists(SITES, site, overrides);
  return kitScript(`const CFG = ${cfgJson({ stop: Array.from(new Set(lists.stop.concat(altsFor(site, 'stop')))) })}; return K.pressStop(document, CFG.stop);`);
}
// P38 🔢 number teach: what the user is asked to type, and AutoInjector's follow-up.
const FOLLOWUP_PHRASE = 'backwards, digits only';
function reverseDigits(n) { return String(n).split('').reverse().join(''); }
function followupText(number) { return `Write the number ${number} backwards, digits only.`; }
function teachBanner(label, number) {
  return `AutoInjector: please type   ${number}   into ${label}'s message box below and press Send. (This shows AutoInjector where things are.)`;
}
function teachAskedBanner(label, number) {
  return `AutoInjector asked ${label} to write ${number} backwards — watching where the answer appears…`;
}
function buildTeachStartScript(label, number, site) {
  return kitScript(`const CFG = ${cfgJson({ number: String(number), reversed: reverseDigits(number), banner: teachBanner(label, number), phrase: FOLLOWUP_PHRASE, user: userSelFor(site) })}; return K.teachInstall(document, window, CFG.number, CFG.banner, CFG.reversed, CFG.phrase, CFG.user);`);
}
function buildTeachPollScript() {
  return kitScript('const st = K.teachState(window); if (!st) return { ok: false, error: "NO_TEACH" }; return K.teachStep(document, st, Date.now());');
}
function buildTeachAskedScript(label, number) {
  return kitScript(`const CFG = ${cfgJson({ banner: teachAskedBanner(label, number) })}; const st = K.teachState(window); if (!st) return { ok: false, error: "NO_TEACH" }; return K.teachAsked(document, st, Date.now(), CFG.banner);`);
}
function buildTeachDoneScript(text, ms, tone) {
  return kitScript(`const CFG = ${cfgJson({ text: String(text || ''), ms: Number(ms) || 12000, tone: tone || 'ok' })}; K.teachRemove(document, window); return K.teachDone(document, window, CFG.text, CFG.ms, CFG.tone);`);
}
// What the number teach found out, in words (the panel, the 🎯 card and the
// AI's window all say the same): which parts were saved, and how Send works.
function teachLearnedWords(t, label) {
  const saved = (t && Array.isArray(t.saved)) ? t.saved : [];
  const parts = [];
  if (saved.includes('input')) parts.push('message box');
  if (saved.includes('assistant')) parts.push('reply area');
  const send = saved.includes('send') ? 'the Send button (saved)'
    : (t && (t.sendHow === 'enter' || t.sendVia === 'enter')) ? 'Send: the Enter key works (no button needed)'
    : (t && t.sendVia === 'click') ? `Send: ${label || 'the AI'}'s usual Send button works`
    : null;
  const learned = parts.length ? `learned ${label ? `${label}'s ` : ''}${parts.join(' and ')}` : 'checked the page';
  return send ? `${learned}; ${send}` : learned;
}
function buildTeachStopScript() {
  return kitScript('return K.teachRemove(document, window);');
}
// P38 🎯 picker
const PICK_THING = { input: 'the message box (where you type)', send: 'the Send button', assistant: "the AI's latest reply", image: 'a picture ChatGPT made' };
function pickBanner(label, role) { return `🎯 Click ${PICK_THING[role] || 'it'} in this window  (${label} · Esc = cancel)`; }
function replyMarkers(site, SITES) {
  const cfg = siteDefaults(SITES, site);
  const own = (cfg.MESSAGE_CONTAINERS || []);
  const known = { chatgpt: ['[data-message-author-role="assistant"]', 'article[data-turn="assistant"]'], claude: ['.font-claude-response', '.font-claude-message', '[data-testid="assistant-message"]'], gemini: ['model-response'] }[site] || [];
  return Array.from(new Set(own.concat(known, ['[data-message-author-role="assistant"]', 'model-response'])));
}
function buildPickScript(site, role, label, SITES, timeoutMs) {
  const cfg = { role, banner: pickBanner(label || site, role), timeoutMs: Number(timeoutMs) || 60000, markers: role === 'assistant' ? replyMarkers(site, SITES) : [], userSel: userSelFor(site) };
  return kitScript(`const CFG = ${cfgJson(cfg)}; return new Promise((resolve) => { K.pickStart(document, window, CFG, resolve); });`);
}
function buildPickCancelScript() { return kitScript('return K.pickCancel(window);'); }
function buildMatchCheckScript(site, SITES, sels) {
  const hints = Array.from(new Set((siteDefaults(SITES, site).ASSISTANT_CANDIDATES || []).concat(altsFor(site, 'assistant'))));
  return kitScript(`const CFG = ${cfgJson({ sels: sels || {}, hints })}; return K.matchCheck(document, CFG.sels, CFG.hints);`);
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
// A number whose digits read differently backwards (never 4774 / 1111), so the
// reversed digits can only come from the AI's answer (P38).
function pickNumber() {
  for (let i = 0; i < 50; i++) { const n = String(1000 + crypto.randomInt(9000)); if (n.split('').reverse().join('') !== n && n.charAt(3) !== '0') return n; }
  return '4827';
}
const PROBE_PHRASE = 'reply with only this word';
const TEACH_PHRASE = 'repeat this number';
function probeText(word) { return `Reply with only this word: ${word}`; }
// Does `text` hold `word` as a whole word (case-insensitive)? "harbor" is in
// "the harbor." but not in "harbormaster" — a chapter that merely contains the
// letters must never pass for a check-in answer.
function containsWord(text, word) {
  const w = String(word == null ? '' : word).trim();
  if (!w) return false;
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // zero-width characters / soft hyphens a site may slip into words are ignored (PC test 2026-10-28)
  const t = String(text == null ? '' : text).replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '');
  try { return new RegExp(`(^|[^\\p{L}\\p{N}_])${esc}($|[^\\p{L}\\p{N}_])`, 'iu').test(t); } catch (_) { return false; }
}

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
    intervalMs: 20 * 60000, needsUserRecheckMs: 60000, teachTimeoutMs: 4 * 60000, teachPollMs: 800, teachDoneMs: 12000,
    reloadSettleMs: 4000, unfreezeWaitMs: 3000, recentWordsMs: 10 * 60000, pollStepMs: 1000,
    autoChecks: true, // false: no automatic check-ins at all (startup / after a failure); on-demand ones still run
    // P37.3: after an AI is marked "not working" it is re-checked (check-in only,
    // no repairs, no teach step) after 5, then 15, then every 60 minutes — until the
    // user does something (🎯 Save, 🔢, 🩺, reload) or a normal reply proves it works.
    brokenBackoffMs: [5 * 60000, 15 * 60000, 60 * 60000],
    probeWordsMs: 60 * 60000 // P37.4: replies holding a check-in / teach word this recent are never nagged
  }, d.options || {});
  const S = {};
  for (const s of sites) S[s] = { state: 'unknown', problem: null, since: null, lastProbeOkAt: null, lastProbeAt: 0, lastCheckReason: null, running: false, step: null, tried: [], teach: null, pending: null, lastSignalCheckAt: 0, startupDone: false, fixedAt: null, yieldReq: false, displacedCount: 0, backoffN: 0, askNotified: false, askedAt: null, nextCheckAt: null };
  const events = [];
  const createdAt = now(); // periodic check-ins count from app start (the start-up one is separate)
  const awaiting = {}; // site -> check-in record { word, resolve, captured, token (token.seq = its [MSG #]), typed, withdrawn, displaced, orphaned }
  const recent = {};   // site -> [{ word, until, a }]  (a late answer to a recent check-in's OWN message is still owned)
  const teachCtl = {}; // site -> { cancel: bool }
  const seenSeqs = {};  // site -> Set of every check-in / teach follow-up [MSG #] (P37.4)
  const probeWords = {}; // site -> [{ word, until }] check-in words, teach numbers (P37.4)
  function rememberProbe(site, word, seq) {
    if (word) { (probeWords[site] = (probeWords[site] || []).filter((r) => r.until > now())).push({ word: String(word), until: now() + opt.probeWordsMs }); }
    if (seq != null) { const set = seenSeqs[site] || (seenSeqs[site] = new Set()); set.add(String(seq)); if (set.size > 200) set.delete(set.values().next().value); }
  }

  function event(kind, fields) {
    const e = { kind, at: now() };
    for (const k of ['site', 'step', 'code', 'outcome', 'reason', 'state', 'how', 'role', 'part']) if (fields && fields[k] != null) e[k] = String(fields[k]).slice(0, 48);
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
      askUser: x.state === 'broken' && !!x.askedAt, askedAt: x.askedAt, nextCheckAt: x.state === 'broken' ? nextBrokenCheck(site) : null,
      say: x.problem ? describeProblem(x.problem, label(site)).say : null,
      fix: x.problem ? describeProblem(x.problem, label(site)).fix : null,
      tried: x.tried.slice(-12).map((r) => ({ step: r.step, outcome: r.outcome, code: r.code, at: r.at, say: STEP_TEXT[r.step] || r.step })),
      teach: t ? { active: !!t.active, number: t.number, reversed: t.reversed, phase: t.phase, asked: !!t.asked, startedAt: t.startedAt, learned: Object.assign({}, t.learned), saved: (t.saved || []).slice(), sendHow: t.sendHow || null, sendVia: t.sendVia || null, missing: (t.missing || []).slice(), failedPart: t.failedPart || null, result: t.result || null, code: t.code || null } : null
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

  // ---- ownership of check-in / teach replies (main.js's capture path asks) ----------
  // A reply belongs to a check-in ONLY when the Relay Trace says it answers the
  // check-in's own [MSG #] (answers = the [MSG #] numbers it answers, relay-trace.js
  // answersOf / wouldAnswer) AND it holds the check-in's word as a whole word. A
  // reply that also answers any other message (an older Akọwe prompt, a relay,
  // the user's message) belongs to that message's owner. Anything else goes
  // wherever it would go without check-ins.
  function wordsFor(site) {
    const out = [];
    if (awaiting[site]) out.push(awaiting[site].word);
    const t = S[site] && S[site].teach;
    if (t && t.active) out.push(t.number, t.reversed);
    for (const r of recent[site] || []) if (r.until > now()) out.push(r.word);
    for (const r of probeWords[site] || []) if (r.until > now()) out.push(r.word);
    return out;
  }
  function seqOf(a) { return a && a.token && a.token.seq != null ? String(a.token.seq) : null; }
  function checkinsOf(site) {
    const out = [];
    if (awaiting[site]) out.push(awaiting[site]);
    for (const r of recent[site] || []) if (r.until > now() && r.a && !out.includes(r.a)) out.push(r.a);
    return out;
  }
  function isCheckinSeq(site, q) { return checkinsOf(site).some((a) => seqOf(a) === String(q)); }
  function ownerOf(site, text, answers) {
    if (!S[site]) return null;
    const t = String(text || '');
    const low = t.toLowerCase();
    // never the user's / app's message itself (it holds the word AND the instruction)
    if (!t || low.indexOf(PROBE_PHRASE) !== -1 || low.indexOf(TEACH_PHRASE) !== -1 || low.indexOf(FOLLOWUP_PHRASE) !== -1) return null;
    const ans = Array.isArray(answers) ? answers.map(String) : null;
    if (ans) {
      for (const a of checkinsOf(site)) {
        const seq = seqOf(a);
        if (!seq || !containsWord(t, a.word)) continue;
        if (ans.includes(seq)) {
          // it also answers a message that is not a check-in (an older Akọwe
          // prompt / relay / the user's message, or one typed after it): that
          // owner comes first — a check-in never takes a reply that may be theirs
          if (ans.some((q) => q !== seq && !isCheckinSeq(site, q))) continue;
          return { kind: 'checkin', a };
        }
        // the check-in's message was taken by a reply that belonged to an older
        // message (batched in the Relay Trace): its real answer now answers nothing
        if (!ans.length && a.orphaned) return { kind: 'checkin', a };
      }
    }
    // the teach message is typed by the user (no [MSG #]). While 🔢 runs nothing
    // else is typed into this pane and any Akọwe request still waiting here was
    // released (main.js teachParkWaiting), so a reply holding the teach number is
    // the setup's — even when the Relay Trace still ties it to an older message
    // that never got its answer (PC test 2026-10-28: the typed number was taken
    // as ChatGPT's late answer to a failed test, LATE_REPLY_STORED, 4 characters).
    const tc = S[site].teach;
    if (tc && tc.active && (containsWord(t, tc.number) || containsWord(t, tc.reversed))) return { kind: 'teach' };
    return null;
  }
  // P37.4: a reply that is (very likely) the answer to a check-in or a number-teach
  // message, even when ownerOf can't prove it (a late answer, a [MSG #] the Relay
  // Trace gave to it alone, a reply without its word). Such a reply is never
  // relayed and never nagged about missing tags. -> 'owned' | 'answers-checkin' | 'has-word' | null
  // o.loose: a short reply holding a recent check-in / teach word counts even when
  // the Relay Trace ties it to another message (the caller makes sure no Akọwe
  // request is waiting for this AI's answer).
  function probeReplyKind(site, text, answers, o) {
    if (!S[site]) return null;
    if (ownerOf(site, text, answers)) return 'owned';
    const t = String(text || '');
    const low = t.toLowerCase();
    if (!t || low.indexOf(PROBE_PHRASE) !== -1 || low.indexOf(FOLLOWUP_PHRASE) !== -1) return null;
    const ans = Array.isArray(answers) ? answers.map(String) : null;
    const seqs = seenSeqs[site];
    if (ans && ans.length && seqs && ans.every((q) => seqs.has(q))) return 'answers-checkin';
    const body = t.replace(/\[\s*(?:TO|FROM)\s*:[^\]]*\]/gi, '').trim();
    if ((!ans || !ans.length || (o && o.loose)) && body.length <= 300 && wordsFor(site).some((w) => containsWord(body, w))) return 'has-word';
    return null;
  }
  // Is this reply the answer to a check-in / teach message here?
  function expects(site, text, answers) { return !!ownerOf(site, text, answers); }
  function onCaptured(site, turn) {
    if (!S[site] || !turn) return false;
    const own = ownerOf(site, turn.text, turn.answers);
    if (!own) { noteForeignReply(site, turn.answers); return false; }
    const a = own.a;
    if (a && !a.captured) { a.captured = true; try { a.resolve(true); } catch (_) {} }
    return true;
  }
  // A reply that is NOT a check-in answer was captured. When the Relay Trace says
  // it also answered a check-in's message (an older message's reply, batched),
  // that check-in was displaced: it must not be failed (or the AI marked broken)
  // because of it — its own answer may still come, otherwise it is re-sent later.
  function noteForeignReply(site, answers) {
    if (!S[site] || !Array.isArray(answers) || !answers.length) return false;
    const ans = answers.map(String);
    if (ans.every((q) => isCheckinSeq(site, q))) return false; // only check-in messages: an answer without its word, not a displacement
    let hit = false;
    for (const a of checkinsOf(site)) {
      const seq = seqOf(a);
      if (!seq || a.captured || !ans.includes(seq)) continue;
      a.displaced = true; a.orphaned = true; hit = true;
      event('displaced', { site, outcome: 'OTHER_REPLY' });
    }
    return hit;
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
      read: { textLen: Number(rs.textLen || 0), generating: !!rs.generating, generatingMs: Number(rs.generatingMs || 0), hasWord: !!(word && containsWord(rs.text, word)) },
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
    // a bridge request asked for this AI while the cheap checks ran: don't send
    if (x.yieldReq) return { ok: false, displaced: true, word: null };
    const word = pickWord(wordsFor(site));
    let resolve; const got = new Promise((r) => { resolve = r; });
    const token = { cancelled: false, typing: false, seq: null }; // seq: stamped by the host with the check-in's [MSG #]
    const a = { word, resolve, captured: false, token, typed: false, withdrawn: false, displaced: false, orphaned: false };
    awaiting[site] = a;
    (recent[site] = (recent[site] || []).filter((r) => r.until > now())).push({ word, until: now() + opt.recentWordsMs, a });
    event('probe', { site, reason, step: 'check' });
    let sendRes;
    try {
      const sendP = Promise.resolve(d.sendProbe(site, probeText(word), token));
      const tm = sleep(opt.sendTimeoutMs).then(() => ({ timedOut: true }));
      sendRes = await Promise.race([sendP, tm]);
      if (sendRes && sendRes.timedOut) { token.cancelled = true; sendRes = await sendP.catch(() => ({ ok: false, error: 'CANCELLED' })); }
    } catch (e) { sendRes = { ok: false, error: 'EXCEPTION' }; }
    sendRes = sendRes && typeof sendRes === 'object' ? { ok: !!sendRes.ok, error: sendRes.error || null, verified: sendRes.verified } : { ok: false, error: 'UNKNOWN' };
    if (sendRes.ok) a.typed = true;
    rememberProbe(site, word, token.seq);
    try {
      // withdrawn before it was typed, to make way for an Akọwe request: not a failure
      if (a.withdrawn && !sendRes.ok && !a.captured) return { ok: false, displaced: true, word };
      if (sendRes.ok || a.captured) {
        const t0 = now();
        let quietSince = 0;
        while (!a.captured && now() - t0 < opt.probeTimeoutMs) {
          const r = await Promise.race([got, sleep(opt.pollStepMs).then(() => false)]);
          if (r === true || a.captured) break;
          // another owner's reply took the check-in's message and a bridge request waits: stop now
          if (a.displaced && x.yieldReq) break;
          // early stop: the reader already shows the answer but nothing took it
          // (not when another owner's reply took the check-in's message: that reply
          // may merely mention the word)
          const rs = readState(site);
          const hasWord = !a.displaced && containsWord(rs.text, word);
          if (hasWord && !rs.generating) { if (!quietSince) quietSince = now(); if (now() - quietSince >= opt.earlyQuietMs) break; }
          else quietSince = 0;
        }
      }
      if (a.captured) return { ok: true, word };
      // its message was answered by a reply that belonged to someone else: no verdict
      if (a.displaced) return { ok: false, displaced: true, word };
      const ev = await evidence(site, word, sendRes, false);
      return { ok: false, code: classify(ev), word, send: sendRes.ok ? 'ok' : sendRes.error };
    } finally { if (awaiting[site] === a) delete awaiting[site]; }
  }

  function markOk(site, how) {
    const x = S[site];
    x.lastProbeOkAt = now();
    x.displacedCount = 0;
    x.backoffN = 0; x.askNotified = false; x.askedAt = null;
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
  function broken(site, code, o) {
    const ask = !!(o && o.ask);
    setState(site, 'broken', code);
    event('result', { site, outcome: 'BROKEN', code, reason: ask ? 'ask-user' : undefined });
    emit(site, { kind: 'broken', code, ask });
    return { ok: false, state: 'broken', problem: code, ask };
  }
  // P37.3: every automatic fix failed. Show the user ONE noticeable notice (the
  // panel's ⚠️ with 🎯 / 🔢, plus a sound if they want one) — never start the teach
  // step by itself, and back off the re-checks until the user acts.
  function askUser(site, code) {
    const x = S[site];
    const first = !x.askNotified;
    x.askNotified = true;
    if (!x.askedAt) x.askedAt = now();
    if (first) event('ask_user', { site, code });
    return broken(site, code, { ask: first });
  }
  function nextBrokenCheck(site) {
    const x = S[site];
    const list = Array.isArray(opt.brokenBackoffMs) && opt.brokenBackoffMs.length ? opt.brokenBackoffMs : [3600000];
    const wait = Number(list[Math.min(x.backoffN || 0, list.length - 1)]) || 3600000;
    return Math.max(x.lastProbeAt || 0, x.since || 0) + wait;
  }
  // The user did something about this AI (🎯 Save / Clear, 🔢, 🩺, reload): the
  // re-check back-off starts over and a new failure is announced again.
  function userActed(site) {
    const x = S[site];
    if (!x) return false;
    x.backoffN = 0; x.askNotified = false;
    return true;
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
      const r = await page(site, buildLearnReplyScript(word, PROBE_PHRASE, site));
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
    x.running = true; x.step = 'check'; x.pending = null; x.yieldReq = false;
    const prev = { state: x.state, problem: x.problem };
    emit(site);
    // No verdict: the check-in made way for an Akọwe request, or another owner's
    // reply took its message. The AI's state stays as it was (never "broken" for
    // this); with automatic check-ins on, it is sent again later, when the AI is
    // free (at most twice in a row) — otherwise it just ends quietly.
    const deferred = (why) => {
      if (x.state !== prev.state || x.problem !== prev.problem) setState(site, prev.state, prev.problem);
      x.displacedCount = (x.displacedCount || 0) + 1;
      const again = !!opt.autoChecks && x.displacedCount <= 2;
      if (again) x.pending = { reason: 're-check', at: now() };
      event('result', { site, outcome: 'DEFERRED', reason: why });
      emit(site, { kind: 'deferred', reason: why });
      return { ok: false, deferred: true, reason: why, state: x.state, again };
    };
    try {
      let r = await probeOnce(site, reason);
      if (r.ok) return markOk(site, 'check-in');
      if (r.displaced) return deferred(x.yieldReq ? 'akowe' : 'other-reply');
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
        if (x.yieldReq) return deferred('akowe'); // an Akọwe request waits for this AI: repair later
        if (step === 'teach') return askUser(site, code);
        x.step = step; emit(site);
        const out = await runStep(site, step, code, r);
        note(site, step, code, out.outcome);
        if (!out.applied) continue;
        x.step = 'check'; emit(site);
        r = await probeOnce(site, `after-${step}`);
        if (r.ok) { note(site, step, code, 'FIXED'); return markOk(site, step); }
        if (r.displaced) return deferred(x.yieldReq ? 'akowe' : 'other-reply');
        note(site, 'check', r.code, 'STILL_FAILING');
        if (USER_ONLY.has(r.code)) return needsUser(site, r.code);
        if (r.code !== code) { code = r.code; setState(site, 'repairing', code); ladder = (LADDERS[code] || LADDERS.UNKNOWN).filter((s) => !done.has(s)); }
      }
      return broken(site, code);
    } catch (e) {
      event('error', { site, outcome: 'EXCEPTION' });
      return broken(site, 'UNKNOWN');
    } finally { x.running = false; x.step = null; x.yieldReq = false; emit(site); }
  }

  // An Akọwe request wants this AI (main.js calls this before typing the prompt).
  // A check-in that is not typed yet is withdrawn; one already typed is left to
  // settle (the caller waits, bounded, until busyWithSite() is false) and the
  // repair steps after it are put off. Returns 'none' | 'withdrawn' | 'wait'.
  function makeWay(site) {
    const x = S[site];
    if (!x) return 'none';
    const a = awaiting[site];
    if (!x.running && !a) return 'none';
    x.yieldReq = true;
    if (a && !a.typed && !a.captured && a.token && !a.token.typing && !a.withdrawn) {
      a.withdrawn = true; a.token.cancelled = true;
      event('yield', { site, outcome: 'WITHDRAWN' });
      return 'withdrawn';
    }
    event('yield', { site, outcome: 'WAIT' });
    return 'wait';
  }
  // A check-in (or its repair steps) is under way on this AI.
  function busyWithSite(site) { const x = S[site]; return !!(x && (x.running || awaiting[site])); }

  // ---- P38 🔢 number teach (replaces the P18.7 "Repeat this number" box) ----------------
  // 1. the user types the shown 4 digits into the AI's box and presses Send — the
  //    watcher learns the box, Send (or Enter) and the user's message block;
  // 2. AutoInjector itself sends "Write the number #### backwards, digits only."
  //    (with the learned box / Send) — its answer is owned here: never relayed,
  //    never nagged about tags;
  // 3. where the reversed digits appear (a NEW block, not the user's message, not the
  //    box) is the reply area — learned as a GENERAL selector (P37.1);
  // 4. all of it is saved (d.savePick, like a 🎯 Save) and a check-in confirms it.
  // Never started automatically (P37.3); Cancel; 4-minute timeout; never loops.
  async function startTeach(site, code, o) {
    const x = S[site];
    if (!x) return { ok: false, error: 'BAD_SITE' };
    if (x.teach && x.teach.active) return { ok: true, already: true, number: x.teach.number };
    if (x.running) return { ok: false, error: 'CHECKING' };
    const number = pickNumber();
    x.teach = { active: true, number, reversed: reverseDigits(number), phase: 'type', asked: false, startedAt: now(), learned: {}, saved: [], sendHow: null, missing: [], failedPart: null, result: null, code: code || x.problem || null, prev: { state: x.state, problem: x.problem } };
    teachCtl[site] = { cancel: false };
    userActed(site);
    event('teach', { site, outcome: 'STARTED', code: x.teach.code });
    emit(site, { kind: 'teach', phase: 'type' });
    teachLoop(site).catch(() => { try { const t = x.teach; if (t && t.active) { t.active = false; t.result = 'failed'; emit(site, { kind: 'teach', phase: 'failed' }); } } catch (_) {} });
    return { ok: true, number };
  }
  function savePart(site, role, sel) {
    try { if (typeof d.savePick === 'function') return d.savePick(site, role, sel, 'number') !== false; d.saveLearned(site, role, sel, 'teach'); return true; } catch (_) { return false; }
  }
  async function teachLoop(site) {
    const x = S[site];
    const t = x.teach;
    const ctl = teachCtl[site];
    const L = label(site);
    const setTeachOverrides = (sel) => { try { if (typeof d.teachOverrides === 'function') d.teachOverrides(site, sel); } catch (_) {} };
    let installed = await page(site, buildTeachStartScript(L, t.number, site));
    let summary = null;
    let sendFail = null;
    while (!ctl.cancel && now() - t.startedAt < opt.teachTimeoutMs) {
      await sleep(opt.teachPollMs);
      if (ctl.cancel) break;
      const r = await page(site, buildTeachPollScript());
      if (!r || !r.ok) {
        // the page was reloaded / navigated: put the watcher back (same number)
        if (!installed || !installed.ok || (r && r.error === 'NO_TEACH')) { installed = await page(site, buildTeachStartScript(L, t.number, site)); if (t.asked && installed && installed.ok) await page(site, buildTeachAskedScript(L, t.number)); }
        continue;
      }
      summary = r;
      const before = JSON.stringify([t.phase, t.learned, t.sendHow]);
      t.phase = t.asked && r.phase === 'user_seen' ? 'asking' : r.phase;
      t.sendHow = r.sendHow || null;
      t.learned = { input: !!(r.selectors && r.selectors.input), send: !!(r.selectors && r.selectors.send) || r.sendHow === 'enter', user: !!(r.selectors && r.selectors.user), reply: !!(r.selectors && r.selectors.assistant) };
      if (JSON.stringify([t.phase, t.learned, t.sendHow]) !== before) {
        event('teach', { site, outcome: `PHASE_${String(t.phase).toUpperCase()}`, how: t.sendHow || undefined });
        emit(site, { kind: 'teach', phase: t.phase });
      }
      if (r.phase === 'done') break;
      if (r.phase === 'user_seen' && !t.asked) {
        // step 2: AutoInjector asks for the number backwards, with what was just learned
        t.asked = true; t.phase = 'asking';
        emit(site, { kind: 'teach', phase: 'asking' });
        const sel = r.selectors || {};
        setTeachOverrides({ input: sel.input || null, send: sel.send || null });
        const token = { cancelled: false, typing: false, seq: null };
        const fa = { word: t.reversed, resolve: () => {}, captured: false, token, typed: false, withdrawn: false, displaced: false, orphaned: false, teach: true };
        (recent[site] = (recent[site] || []).filter((q) => q.until > now())).push({ word: t.reversed, until: now() + opt.recentWordsMs, a: fa });
        rememberProbe(site, t.number, null); rememberProbe(site, t.reversed, null);
        let res;
        try {
          const sendP = Promise.resolve(d.sendProbe(site, followupText(t.number), token));
          res = await Promise.race([sendP, sleep(opt.sendTimeoutMs).then(() => ({ timedOut: true }))]);
          if (res && res.timedOut) { token.cancelled = true; res = await sendP.catch(() => ({ ok: false, error: 'CANCELLED' })); }
        } catch (_) { res = { ok: false, error: 'EXCEPTION' }; }
        rememberProbe(site, null, token.seq);
        if (res && res.ok && res.method) t.sendVia = res.method === 'enter' ? 'enter' : res.method === 'click' ? 'click' : null;
        event('teach', { site, outcome: res && res.ok ? 'ASKED' : 'ASK_FAILED', how: t.sendVia || undefined });
        if (!res || !res.ok) { sendFail = String((res && res.error) || 'UNKNOWN'); break; }
        fa.typed = true;
        await page(site, buildTeachAskedScript(L, t.number));
        t.phase = 'wait_reply';
        emit(site, { kind: 'teach', phase: 'wait_reply' });
      }
    }
    await page(site, buildTeachStopScript());
    setTeachOverrides(null);
    if (ctl.cancel) {
      t.active = false; t.result = 'cancelled';
      event('teach', { site, outcome: 'CANCELLED' });
      // nothing changed: the AI keeps the state it had before (no new verdict)
      if (t.prev && (x.state !== t.prev.state || x.problem !== t.prev.problem)) setState(site, t.prev.state, t.prev.problem);
      emit(site, { kind: 'teach', phase: 'cancelled' });
      return { ok: false, cancelled: true };
    }
    const sel = (summary && summary.selectors) || {};
    // save what was learned (each part separately — the box and Send are proven by
    // the digits appearing in / leaving the box, the reply by the reversed digits)
    const saved = [];
    if (sel.input && savePart(site, 'input', sel.input)) saved.push('input');
    if (sel.send && savePart(site, 'send', sel.send)) saved.push('send');
    if (sel.user) savePart(site, 'user', sel.user);
    if (sel.assistant && savePart(site, 'assistant', sel.assistant)) saved.push('assistant');
    for (const role of saved) event('learned', { site, role, how: 'number' });
    t.saved = saved;
    // Sent by Enter (the user's message or AutoInjector's follow-up) and no Send
    // button learned: a saved Send button that isn't on the page is useless — the
    // host drops it, so the 🎯 card stops saying "⚠️ not found" (PC test 2026-10-28).
    if (!sel.send && (t.sendHow === 'enter' || t.sendVia)) { try { if (typeof d.sendWorks === 'function') await d.sendWorks(site, t.sendHow === 'enter' ? 'enter' : t.sendVia); } catch (_) {} }
    t.missing = [];
    if (!sel.input) t.missing.push('input');
    if (!sel.send && t.sendHow !== 'enter') t.missing.push('send');
    if (!sel.assistant) t.missing.push('assistant');
    // which part failed (the panel offers 🎯 for just that part)
    t.failedPart = sendFail ? (/INPUT|INJECT|TYPE/.test(sendFail) ? 'input' : 'send')
      : !sel.input ? 'input' : (!sel.send && t.sendHow !== 'enter') && !t.asked ? 'send' : !sel.assistant ? 'assistant' : null;
    const timedOut = !summary || summary.phase !== 'done';
    t.active = false;
    if (sendFail) {
      t.result = 'failed';
      note(site, 'teach', t.code, 'ASK_FAILED');
      emit(site, { kind: 'teach', phase: 'failed', part: t.failedPart });
      return { ok: false, result: 'failed', part: t.failedPart };
    }
    if (timedOut) {
      t.result = t.phase === 'type' ? 'timeout' : 'failed';
      event('teach', { site, outcome: 'TIMEOUT', part: t.failedPart });
      note(site, 'teach', t.code, 'TIMEOUT');
      emit(site, { kind: 'teach', phase: t.result, part: t.failedPart });
      return { ok: false, result: t.result, part: t.failedPart };
    }
    note(site, 'teach', t.code, saved.length ? `LEARNED:${saved.join('+')}` : 'NOTHING_LEARNED');
    if (!sel.assistant) {
      t.result = 'failed';
      emit(site, { kind: 'teach', phase: 'failed', part: 'assistant' });
      return { ok: false, result: 'failed', part: 'assistant' };
    }
    // confirm with a new check-in
    x.running = true; x.step = 'check'; emit(site, { kind: 'teach', phase: 'confirming' });
    let r;
    try { r = await probeOnce(site, 'after-teach'); } finally { x.running = false; x.step = null; }
    if (r.ok) {
      t.result = 'fixed'; note(site, 'teach', t.code, 'FIXED');
      const out = markOk(site, 'number');
      try { await page(site, buildTeachDoneScript(`✔ Saved — AutoInjector ${teachLearnedWords(t, L)}, and a check-in worked. ${L} is ready.`, opt.teachDoneMs)); } catch (_) {}
      return out;
    }
    if (r.displaced) { t.result = 'deferred'; if (opt.autoChecks) x.pending = { reason: 'after-teach', at: now() }; event('result', { site, outcome: 'DEFERRED', reason: 'after-teach' }); emit(site, { kind: 'teach', phase: 'deferred' }); return { ok: false, deferred: true }; }
    t.result = 'failed';
    t.failedPart = (ALT_ROLES[r.code] || ['assistant']).filter((role) => role !== 'stop')[0] || 'assistant';
    if (!t.missing.length) t.missing = [t.failedPart];
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
  // While an AI is "not working" (P37.3) only the user's own actions check it at
  // once; automatic reasons (a stall, an Akọwe timeout) wait for the back-off.
  const USER_REASON = /^(?:after-|you-asked|user|picked|saved|number)/;
  function requestCheck(site, reason) {
    const x = S[site];
    if (!opt.autoChecks || !x || x.running || teachActive(site)) return false;
    const why = String(reason || 'request').slice(0, 40);
    if (x.state === 'broken' && !USER_REASON.test(why)) { event('pending', { site, reason: why, outcome: 'BACKED_OFF' }); return false; }
    if (USER_REASON.test(why)) userActed(site);
    x.pending = { reason: why, at: now() };
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
      // P37.3: a "not working" AI: a plain check-in after 5 / 15 / 60 minutes (no
      // repairs, no teach step) — the user was told once and decides what to do.
      if (x.state === 'broken') {
        if (opt.autoChecks && t >= nextBrokenCheck(site) && !busy(site, 'periodic')) { x.backoffN = (x.backoffN || 0) + 1; runCheck(site, 'broken-recheck', { repair: false }).catch(() => {}); }
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

  // Akọwe contract v1.2 fields
  function health(site) {
    const x = S[site];
    if (!x) return { state: 'unknown', problem: null, since: null, last_probe_ok_at: null };
    return { state: x.state, problem: x.problem, since: x.since, last_probe_ok_at: x.lastProbeOkAt };
  }
  function isUsable(site) { const x = S[site]; return !x || ((x.state === 'ok' || x.state === 'unknown') && !teachActive(site)); }

  return {
    runCheck, probeMany, requestCheck, startup, tick, onPageChanged, noteWorking,
    onCaptured, expects, probeReplyKind, noteForeignReply, awaitingReply, teachActive, startTeach, cancelTeach, makeWay, busyWithSite, userActed,
    state: snap, snapshot: () => Object.fromEntries(sites.map((s) => [s, snap(s)])), health, isUsable,
    events: () => events.map((e) => Object.assign({}, e)), setIntervalMs, options: opt, lastTick: () => lastTick
  };
}

module.exports = {
  CODES, USER_ONLY, STATES, PROBLEM_TEXT, STEP_TEXT, PAGE_SIGNATURES, NOTICE_SELECTOR, ALT_SELECTORS, LADDERS, ALT_ROLES,
  LEARNED_VERSION, MARKER, PROBE_PHRASE, TEACH_PHRASE, WORDS,
  describeProblem, signaturesFor, altsFor, pageKit, classify, createSelfRepair, sanitizeLearned,
  buildSignalScript, buildScanScript, buildAlternativesScript, buildLearnReplyScript, buildUnfreezeScript,
  buildTeachStartScript, buildTeachPollScript, buildTeachAskedScript, buildTeachStopScript, buildTeachDoneScript, teachLearnedWords, teachBanner, teachAskedBanner, probeText, pickWord, pickNumber, containsWord,
  FOLLOWUP_PHRASE, followupText, reverseDigits, PICK_THING, pickBanner, replyMarkers, buildPickScript, buildPickCancelScript, buildMatchCheckScript, userSelFor
};
