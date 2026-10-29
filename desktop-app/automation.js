// automation.js — builds the small scripts run inside each site's WebContentsView
// via webContents.executeJavaScript(). Two independent one-shot scripts instead of
// one big type+send+wait script:
//   - buildSendScript: types text into the chat box and clicks send. Returns
//     immediately once sent — it does NOT wait for a reply.
//   - buildReadScript: just reads whatever the latest assistant message currently
//     says. Cheap enough to poll repeatedly from main.js to notice when a reply
//     finishes streaming, independently of who sent what to whom.
// Splitting these lets main.js route messages freely between panes (any pane to
// any other pane, on demand or automatically) instead of a fixed turn order.
const SITES = require("./selectors");
const { excludeSelectorsFor } = require("./reply-clean");
// Claude's page since 2026-10-29: messages in rows, who-wrote-what per row, and
// page chrome (the sidebar's recent chats) that is never a reply — embedded by
// source into the read / send / probe scripts below.
const { rowKit, rowConfigFor } = require("./transcript-rows");
const ROWKIT_SRC = rowKit.toString();

// TR-24: a selector that is only a tag name ("span", "p", "div") matches
// hundreds of unrelated elements — never a usable override. Shared by the
// read/probe scripts (they skip it) and main.js (it refuses to save it).
function isBareTagSelector(sel) { return /^\s*[a-z][a-z0-9-]*\s*$/i.test(String(sel || "")); }
function usableOverride(sel) { return sel && !isBareTagSelector(sel) ? sel : null; }

function siteConfig(site) {
  const cfg = SITES[site];
  if (!cfg) throw new Error(`Unknown site: ${site}`);
  return cfg;
}

// E11: when a provider parks a conversation behind a safeguard (e.g. Claude's
// "reasoning_extraction" pause), the composer disappears — so a send fails with a
// bare INPUT_NOT_FOUND that tells the user nothing. These markers, checked ONLY
// when the input is already missing, let us report PROVIDER_PAUSED with a reason
// instead. Specific phrases only, so an ordinary reply never trips them.
const DEFAULT_PAUSE_MARKERS = [
  "reasoning_extraction",
  "paused this conversation",
  "conversation is paused",
  "unable to continue the conversation",
];

// The "[MSG #0042]" header at the top of a send, or null.
function messageMarker(text) {
  const m = /^\[MSG #\d+\]/.exec(String(text || ""));
  return m ? m[0] : null;
}

// In-pane feedback pop-ups the sites show now and then (PC test 2026-10-28:
// Claude's "How is Claude doing this session?" card inside its pane). They are not
// part of the chat; before typing, the send script closes one with its own
// Dismiss / Close / ✕ button — never a rating button, never anything else. Only a
// card whose text holds one of these phrases is touched.
const SURVEY_PHRASES = {
  claude: ["how is claude doing", "how's claude doing", "how’s claude doing", "rate this conversation", "how was this conversation"],
  chatgpt: ["is this conversation helpful so far", "do you like this personality", "how was this conversation", "rate this conversation"],
  gemini: ["how was this conversation", "rate this conversation", "how is gemini doing"],
  generic: ["how was this conversation", "rate this conversation"]
};
// The elements that hold ONE message of the user's in the conversation, per site.
// A send that empties the box but adds no such message (and whose [MSG #] never
// shows) did not arrive (PC test 2026-10-28: ChatGPT's box emptied, nothing was
// sent, and the app waited 3 minutes for an answer to a message ChatGPT never got).
const USER_TURNS = {
  chatgpt: ['[data-message-author-role="user"]'],
  claude: ['[data-testid="user-message"]', '.font-user-message'],
  gemini: ['user-query'],
  generic: ['[data-message-author-role="user"]', '[data-testid="user-message"]', 'user-query']
};
function buildSendScript(site, text, overrides, sendOpts) {
  const cfg = siteConfig(site);
  const ov = overrides || {};
  const payload = JSON.stringify({
    text,
    // a SAVED / learned Send button (🎯, 🔢, self-repair): reported as stale when
    // it is no longer on the page — the built-in ones and Enter are used instead
    OVERRIDE_SEND: usableOverride(ov.send) || null,
    SURVEYS: SURVEY_PHRASES[site] || SURVEY_PHRASES.generic,
    USER_TURNS: USER_TURNS[site] || USER_TURNS.generic,
    // the user's own "this is my message" selector (🔢 / 🎯), when there is one:
    // on Claude's 2026-10-29 page it can be the hidden heading of EVERY row, so
    // it is counted once per row and never in Claude's rows (userTurns() below)
    USER_OVERRIDE: usableOverride(sendOpts && sendOpts.userSel) || null,
    ROWKIT: rowConfigFor(SITES, site),
    INPUT_CANDIDATES: usableOverride(ov.input) ? [ov.input, ...cfg.INPUT_CANDIDATES] : cfg.INPUT_CANDIDATES,
    SEND_CANDIDATES: usableOverride(ov.send) ? [ov.send, ...cfg.SEND_CANDIDATES] : cfg.SEND_CANDIDATES,
    STOP_CANDIDATES: usableOverride(ov.stop) ? [ov.stop, ...(cfg.STOP_CANDIDATES || [])] : (cfg.STOP_CANDIDATES || []),
    ASSISTANT_CANDIDATES: usableOverride(ov.assistant) ? [ov.assistant, ...cfg.ASSISTANT_CANDIDATES] : cfg.ASSISTANT_CANDIDATES,
    PAUSE_MARKERS: ov.pauseMarkers || cfg.PAUSE_MARKERS || DEFAULT_PAUSE_MARKERS,
    // The [MSG #0042] header main.js stamps on every send. It is unique per send,
    // so seeing it in the conversation (outside the composer) is PROOF the
    // message really went out — see markerShown() below.
    marker: messageMarker(text),
    // How many times the marker was ALREADY in the chat before this send's
    // first try (main.js passes it back in on retries). Numbers restart when
    // the app restarts, so an old "[MSG #0001]" may already be on the page —
    // only a count ABOVE this baseline proves THIS send landed.
    markerBaseline: sendOpts && Number.isInteger(sendOpts.markerBaseline) ? sendOpts.markerBaseline : null
  });

  return `
  (async () => {
    const CFG = ${payload};

    function qsAllAny(candidates) {
      for (const sel of candidates) {
        const node = document.querySelector(sel);
        if (node) return node;
      }
      return null;
    }

    // TR-27: a saved "message box" selector can point at a WRAPPER around the
    // real editor (e.g. a div labelled "Ask ChatGPT" that holds the editable
    // box) or at a paragraph INSIDE it. Typing into the wrapper never reaches
    // the editor, so the send can't go out (ChatGPT's SEND_NOT_CONFIRMED).
    // Always work on the real editable element: the textarea, or the OUTERMOST
    // contenteditable element.
    const EDITABLE = 'textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]';
    function isEditable(n) { return !!n && (n.tagName === "TEXTAREA" || n.isContentEditable === true); }
    function resolveEditable(n) {
      if (!n) return null;
      if (n.tagName === "TEXTAREA") return n;
      if (n.isContentEditable) {
        let r = n;
        while (r.parentElement && r.parentElement.isContentEditable) r = r.parentElement;
        return r;
      }
      // Inside a wrapper: prefer a VISIBLE editable box (sites keep a hidden
      // fallback textarea next to the real editor).
      let inner = null;
      try {
        const list = Array.from(n.querySelectorAll(EDITABLE));
        inner = list.find(isShown) || list[0] || null;
      } catch {}
      return inner ? resolveEditable(inner) : n;
    }
    // The first candidate that leads to a VISIBLE editable box; else a hidden
    // editable one; else the first match at all.
    function findInput() {
      let first = null, hidden = null;
      for (const sel of CFG.INPUT_CANDIDATES) {
        let list = [];
        try { list = document.querySelectorAll(sel); } catch { continue; }
        for (const n of list) {
          const r = resolveEditable(n);
          if (isEditable(r) && isShown(r)) return r;
          if (isEditable(r) && !hidden) hidden = r;
          if (!first) first = r;
        }
      }
      return hidden || first;
    }
    const isShown = (b) => { try { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return true; } };
    const isOff = (b) => !!(b.disabled || b.getAttribute("aria-disabled") === "true");
    // TR-27: the Send button of the FIRST selector that matches a VISIBLE
    // button (a hidden leftover can match first). Within that selector an
    // enabled one wins; a disabled one is still returned — the caller waits
    // for it to enable rather than clicking some lower-priority button.
    // Nothing visible at all: the first match.
    function findSendButton() {
      let first = null;
      for (const sel of CFG.SEND_CANDIDATES) {
        let list = [];
        try { list = Array.from(document.querySelectorAll(sel)); } catch { continue; }
        if (!first && list.length) first = list[0];
        const shown = list.filter(isShown);
        if (shown.length) return shown.find((b) => !isOff(b)) || shown[0];
      }
      return first;
    }

    function focusNode(n) {
      try { n.focus(); } catch {}
      try { n.scrollIntoView({ block: "nearest" }); } catch {}
    }

    function setNativeValue(elm, value) {
      const propDesc = Object.getOwnPropertyDescriptor(elm.__proto__, "value");
      const setter = propDesc && propDesc.set;
      if (setter) setter.call(elm, value);
      elm.dispatchEvent(new Event("input", { bubbles: true }));
      elm.dispatchEvent(new Event("change", { bubbles: true }));
    }

    async function typeByKeyboard(elm, text, delay) {
      focusNode(elm);
      for (const ch of text) {
        elm.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: ch, bubbles: true }));
        elm.textContent = (elm.textContent || "") + ch;
        elm.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: ch, bubbles: true }));
        await new Promise((r) => setTimeout(r, delay || 3));
      }
    }

    function composerText(input) {
      if (!input) return "";
      return String((input.tagName === "TEXTAREA" ? input.value : (input.innerText || input.textContent)) || "");
    }
    const squash = (s) => String(s || "").replace(/\s+/g, "");
    // Does the composer now hold (the start of) our text? Whitespace-insensitive,
    // because editors turn line breaks into paragraphs.
    function holdsText(input, text) {
      const want = squash(text).slice(0, 60);
      return !!want && squash(composerText(input)).indexOf(want) !== -1;
    }

    // Rich editors (ProseMirror, Lexical, Quill…) keep their OWN copy of what's
    // typed. Writing textContent directly changes the screen but not that copy,
    // so the page can wipe the box without ever sending (the false "sent" that
    // starved ChatGPT). execCommand("insertText") goes through the browser's
    // real editing pipeline, which every editor listens to.
    function selectAllIn(input) {
      focusNode(input);
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    const settle = () => new Promise((r) => setTimeout(r, 60)); // editors re-render a beat later
    async function insertViaEditor(input, text) {
      // 1) The browser's own editing command. Don't trust its return value
      //    (editors that handle the edit themselves make it return false);
      //    check the box instead.
      try {
        selectAllIn(input);
        // Line by line, with a real line break between, so multi-line
        // messages (code blocks, [TO:] on its own line) keep their shape.
        const lines = String(text).split("\\n");
        lines.forEach((line, i) => {
          if (i > 0) document.execCommand("insertLineBreak");
          if (line) document.execCommand("insertText", false, line);
        });
        await settle();
        if (holdsText(input, text)) return "insertText";
      } catch {}
      // 2) A paste. Every rich editor handles paste itself, reading the
      //    clipboard data rather than the screen.
      try {
        selectAllIn(input);
        const dt = new DataTransfer();
        dt.setData("text/plain", text);
        input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
        await settle();
        if (holdsText(input, text)) return "paste";
      } catch {}
      return "";
    }

    async function injectText(text) {
      const input = findInput();
      if (!input) return { ok: false, error: "INPUT_NOT_FOUND" };
      focusNode(input);

      if (input.tagName === "TEXTAREA" || input.matches("textarea")) {
        try { setNativeValue(input, text); return { ok: true }; } catch {}
      }
      if (input.isContentEditable || input.getAttribute("contenteditable") === "true") {
        const via = await insertViaEditor(input, text);
        if (via) return { ok: true, via };
        try {
          input.focus();
          input.textContent = "";
          input.dispatchEvent(new InputEvent("input", { inputType: "insertFromPaste", data: text, bubbles: true }));
          input.textContent = text;
          input.dispatchEvent(new InputEvent("input", { inputType: "insertFromPaste", data: text, bubbles: true }));
          return { ok: true };
        } catch {}
      }
      try { await typeByKeyboard(input, text); return { ok: true }; } catch {}
      return { ok: false, error: "INJECT_FAILED" };
    }

    // Clicking a wrong or disabled button never throws -- it just silently
    // does nothing, and the old version of this script reported that as a
    // success. Every real chat UI clears its input box the instant a message
    // is actually submitted (a local UI action, not waiting on the network),
    // so checking for that is a reliable, site-agnostic way to tell a real
    // send from a no-op click.
    async function inputIsEmpty() {
      const input = findInput();
      if (!input) return true; // can't find it to check anymore -- don't block success on that
      const remaining = (input.tagName === "TEXTAREA" ? input.value : input.textContent) || "";
      return remaining.trim().length === 0;
    }

    // A single fixed-delay snapshot (the old version of this) reports a
    // false SEND_NOT_CONFIRMED on any page that's just a bit slower than
    // usual to clear its input box (a big paste, a laggy tab) -- polling
    // over a longer window gives a genuinely slow-but-real send room to
    // actually confirm, instead of a one-shot guess.
    // How many times our [MSG #n] marker shows in the page OUTSIDE the composer
    // (i.e. in the conversation). > 0 = the message is really in the chat.
    // Every message box on the page counts as "the box", not only the one
    // findInput() picks: a stale saved selector can point at a different box than
    // the one the text sits in, and the text still sitting in ANY box is no proof.
    function markerCount() {
      if (!CFG.marker) return 0;
      const count = (s) => String(s || "").split(CFG.marker).length - 1;
      let page = "";
      try { page = document.body.innerText || ""; } catch { return 0; }
      let inBoxes = 0;
      try {
        const seen = new Set();
        for (const n of document.querySelectorAll('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]')) {
          const r = resolveEditable(n);
          if (!r || seen.has(r) || r.tagName === "TEXTAREA") continue;
          seen.add(r);
          inBoxes += count(r.innerText || r.textContent || "");
        }
      } catch {}
      return Math.max(0, count(page) - inBoxes);
    }
    const baseline = CFG.markerBaseline != null ? CFG.markerBaseline : markerCount();
    function markerShown() { return !!CFG.marker && markerCount() > baseline; }
    // How many messages of the user's the conversation shows (-1: none of the
    // site's user-message selectors match anything, so this can't tell).
    // 2026-10-29: Claude's page shows every message as a row; who wrote each row
    // is decided per row (transcript-rows.js), and page chrome never counts.
    const RK = (${ROWKIT_SRC})(CFG.ROWKIT);
    function userTurns() {
      let info = null;
      try { info = RK.enabled ? RK.classify(document) : null; } catch (_) { info = null; }
      const rowMode = !!(info && info.rows.length);
      if (CFG.USER_OVERRIDE) {
        let list = [];
        try { list = Array.from(document.querySelectorAll(CFG.USER_OVERRIDE)); } catch (_) { list = []; }
        const seen = new Set();
        for (const n of list) {
          if (RK.inChrome(n)) continue;
          if (RK.says(n) === "assistant") continue; // a "Claude said:" heading
          const r = rowMode ? RK.rowOf(info, n) : null;
          if (r && r.role !== "user") continue;
          seen.add(r ? r.el : n);
        }
        if (seen.size) return seen.size;
      }
      for (const sel of (CFG.USER_TURNS || [])) {
        let list = [];
        try { list = Array.from(document.querySelectorAll(sel)).filter((n) => !RK.inChrome(n)); } catch { continue; }
        if (list.length) return list.length;
      }
      if (rowMode) return info.users;
      return -1;
    }
    const turnsBefore = userTurns();
    function turnAdded() { const n = userTurns(); return turnsBefore >= 0 && n > turnsBefore; }
    // Is the saved / learned Send button still on the page (visible)?
    function savedSendState() {
      if (!CFG.OVERRIDE_SEND) return null;
      let list = [];
      try { list = Array.from(document.querySelectorAll(CFG.OVERRIDE_SEND)); } catch { return "bad"; }
      return list.some(isShown) ? "found" : "missing";
    }
    const savedSend = savedSendState();

    // -> "seen" (marker in the conversation: proof), "empty" (box cleared, no
    // proof yet), or "" (still sitting in the box). With a marker we keep
    // watching for proof a little longer after the box clears.
    async function confirmSent() {
      const start = Date.now();
      let emptySince = 0;
      while (Date.now() - start < 6000) {
        if (markerShown()) return "seen";
        if (await inputIsEmpty()) {
          // the box emptied AND a new message of the user's appeared: proof too
          if (turnAdded()) return "turn";
          if (!CFG.marker) return "empty";
          if (!emptySince) emptySince = Date.now();
          if (Date.now() - emptySince > 3000) return "empty";
        } else if (Date.now() - start > 2500 && !emptySince) {
          return "";
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      return markerShown() ? "seen" : (await inputIsEmpty()) ? (turnAdded() ? "turn" : "empty") : "";
    }
    // verified: proven to be in the chat (its [MSG #] showed, or the box emptied
    // and a new message of the user's appeared). turnsCountable: the page shows
    // the user's messages in a way this script can count — so "the box emptied
    // but no new message appeared" really means it did not arrive.
    const extra = () => Object.assign(savedSend && savedSend !== "found" ? { savedSend } : {}, dismissed.length ? { dismissed } : {});
    const result = (how, method) => Object.assign({ ok: true, method, verified: how === "seen" || how === "turn", proof: how === "seen" ? "number" : how === "turn" ? "new-message" : null, turnsCountable: turnsBefore >= 0, markerBaseline: baseline }, extra());

    // The AI's latest reply (count + length) — it changes while an AI is still
    // writing. Falls back to the page text outside the message box when no
    // reply selector matches.
    function pageSig() {
      for (const sel of (CFG.ASSISTANT_CANDIDATES || [])) {
        let list = [];
        try { list = document.querySelectorAll(sel); } catch { continue; }
        if (list.length) { const last = list[list.length - 1]; return list.length * 1000003 + String(last.innerText || last.textContent || "").length; }
      }
      let page = 0;
      try { page = (document.body.innerText || "").length; } catch {}
      return page - composerText(findInput()).length;
    }
    // A short description of what the send used, for the Activity Log when a
    // send can't be confirmed (so the next report shows WHY).
    function describe(n) {
      if (!n) return null;
      let cls = "";
      try { cls = String(n.className && n.className.baseVal != null ? n.className.baseVal : n.className || "").slice(0, 60); } catch {}
      return { tag: (n.tagName || "").toLowerCase(), id: n.id || null, cls: cls || null, label: (n.getAttribute && n.getAttribute("aria-label")) || null, visible: isShown(n), disabled: isOff(n), editable: isEditable(n) };
    }
    function diag(method) {
      const box = findInput();
      return { method, input: describe(box), boxChars: composerText(box).trim().length, button: describe(findSendButton()) };
    }

    async function attemptSend() {
      // Editors enable their Send button a moment after the text lands; clicking
      // it while still disabled does nothing. Give it up to ~1.5s — but if the
      // page keeps changing meanwhile, the AI is still writing its last reply
      // (its Stop button just wasn't recognised): don't click the moment it
      // finishes, or that reply is typed over before it's captured (TR-30).
      let btn = findSendButton();
      const sig0 = pageSig();
      let waited = false;
      for (let i = 0; btn && isOff(btn) && i < 10; i++) {
        waited = true;
        await new Promise((r) => setTimeout(r, 150));
        btn = findSendButton();
        if (btn && isOff(btn) && Math.abs(pageSig() - sig0) > 0) return { ok: false, error: "AI_BUSY", busyHow: "send-locked-while-page-changes", markerBaseline: baseline };
      }
      if (waited && btn && !isOff(btn) && Math.abs(pageSig() - sig0) > 0) return { ok: false, error: "AI_BUSY", busyHow: "reply-finished-while-waiting", markerBaseline: baseline };
      if (btn) {
        try { btn.click(); } catch {}
        const how = await confirmSent();
        if (how) return result(how, "click");
      }
      // Enter goes to the editor itself (where the site listens), not to
      // whatever happens to have focus.
      const box = findInput();
      if (box) focusNode(box);
      const active = box || document.activeElement || document.body;
      try {
        active.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
      } catch {}
      const how = await confirmSent();
      if (how) return result(how, "enter");
      return Object.assign({ ok: false, error: "SEND_NOT_CONFIRMED", markerBaseline: baseline, diag: diag(btn ? "click+enter" : "enter (no Send button found)") }, extra());
    }

    // E11: distinguish a provider-paused conversation from a plain missing box.
    function detectPause() {
      let body = "";
      try { body = String((document.body && (document.body.innerText || document.body.textContent)) || "").toLowerCase(); } catch (_) { return null; }
      if (!body) return null;
      for (const mk of (CFG.PAUSE_MARKERS || [])) {
        const needle = String(mk || "").toLowerCase();
        if (needle && body.indexOf(needle) !== -1) return mk;
      }
      return null;
    }

    // A feedback pop-up inside the pane ("How is Claude doing this session?"):
    // close it with its own Dismiss / Close / ✕ button. A card is only touched when
    // its text holds one of CFG.SURVEYS, is small (not the conversation), and
    // holds no message box; a button is only pressed when it plainly closes.
    function dismissSurveys() {
      const out = [];
      const phrases = (CFG.SURVEYS || []).map((p) => String(p).toLowerCase());
      if (!phrases.length || !document.body) return out;
      const closeRe = /^(dismiss|close|skip|not now|no thanks|maybe later|×|✕|x)$/i;
      const closeLabelRe = /\b(dismiss|close|skip|not now|no thanks)\b/i;
      let walker;
      try { walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); } catch { return out; }
      const hits = [];
      for (let n = walker.nextNode(), i = 0; n && i < 20000; n = walker.nextNode(), i++) {
        const t = String(n.nodeValue || "").toLowerCase();
        if (t.length < 8 || t.length > 200) continue;
        if (phrases.some((p) => t.indexOf(p) !== -1)) hits.push(n.parentElement);
      }
      for (const h of hits) {
        if (!h || h.closest('[data-autoinjector-overlay]') || isEditable(h) || (h.closest && h.closest(EDITABLE))) continue;
        let card = h;
        let btn = null;
        for (let up = 0; card && up < 6 && !btn; up++) {
          const txt = String(card.innerText || card.textContent || "");
          if (txt.length > 600 || card.querySelector(EDITABLE)) break; // grew past a small card
          for (const b of card.querySelectorAll('button, [role="button"]')) {
            const label = String(b.getAttribute("aria-label") || b.getAttribute("title") || "").trim();
            const words = String(b.innerText || b.textContent || "").trim();
            if ((label && closeLabelRe.test(label)) || (words && closeRe.test(words))) { btn = b; break; }
          }
          if (!btn) card = card.parentElement;
        }
        if (btn && isShown(btn)) { try { btn.click(); out.push(String(h.textContent || "").trim().slice(0, 60)); } catch {} }
      }
      return out;
    }
    let dismissed = [];
    try { dismissed = dismissSurveys(); } catch {}
    if (dismissed.length) await new Promise((r) => setTimeout(r, 150));
    // A retry of a send whose first try DID land (just too slowly to confirm)
    // must not post the message twice.
    if (markerShown()) return { ok: true, method: "already-sent", verified: true, proof: "number", markerBaseline: baseline };
    // TR-25: the AI is still writing its last reply (its Stop button shows).
    // Chat sites won't take a new message then — say so instead of typing
    // into the box and failing three times.
    // Same rule as the reader's "generating" flag: the FIRST Stop selector that
    // matches anything, and only if that button is visible.
    for (const sel of CFG.STOP_CANDIDATES) {
      let b = null; try { b = document.querySelector(sel); } catch (_) {}
      if (!b) continue;
      const r = b.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return { ok: false, error: "AI_BUSY", markerBaseline: baseline };
      break;
    }
    const inj = await injectText(CFG.text);
    if (!inj.ok) {
      if (inj.error === "INPUT_NOT_FOUND") {
        const reason = detectPause();
        if (reason) return { ok: false, error: "PROVIDER_PAUSED", reason };
      }
      return inj;
    }
    return attemptSend();
  })();
  `;
}

// P37.2: per site, the element that holds one whole AI message (outermost wins).
const MESSAGE_CONTAINERS = {
  chatgpt: ['[data-message-author-role="assistant"]', 'article[data-turn="assistant"]'],
  claude: ['.font-claude-response', '.font-claude-message', '[data-testid="assistant-message"]'],
  gemini: ['message-content', 'model-response'],
  generic: ['[data-message-author-role="assistant"]', 'model-response']
};
function buildReadScript(site, overrides) {
  const cfg = siteConfig(site);
  const ov = overrides || {};
  const ovAssistant = usableOverride(ov.assistant);
  const payload = JSON.stringify({
    ASSISTANT_CANDIDATES: ovAssistant ? [ovAssistant, ...cfg.ASSISTANT_CANDIDATES] : cfg.ASSISTANT_CANDIDATES,
    DEFAULT_ASSISTANT: cfg.ASSISTANT_CANDIDATES,
    OVERRIDE: ovAssistant,
    // P18.4/P18.7: a reply selector the self-repair LEARNED (and proved with a
    // check-in) is read on its own when it matches — the built-in ones that
    // stopped working must not win over it with some stale element.
    STRICT: !!(ovAssistant && ov.assistantStrict),
    SEND_CANDIDATES: usableOverride(ov.send) ? [ov.send, ...cfg.SEND_CANDIDATES] : cfg.SEND_CANDIDATES,
    STOP_CANDIDATES: usableOverride(ov.stop) ? [ov.stop, ...(cfg.STOP_CANDIDATES || [])] : (cfg.STOP_CANDIDATES || []),
    INPUT_CANDIDATES: usableOverride(ov.input) ? [ov.input, ...(cfg.INPUT_CANDIDATES || [])] : (cfg.INPUT_CANDIDATES || []),
    // P37.2: the element that holds ONE whole AI message on each site — the reader
    // uses its full text when the matched node only has part of the reply.
    MESSAGE_CONTAINERS: MESSAGE_CONTAINERS[site] || MESSAGE_CONTAINERS.generic,
    // Page chrome inside a reply that is never part of its words (screen-reader
    // headings, Claude's thinking summary, code-block headers, timestamps) —
    // see reply-clean.js. Skipped when the reply's text is read.
    EXCLUDE: excludeSelectorsFor(site).join(", "),
    ROWKIT: rowConfigFor(SITES, site)
  });

  // Returns { ok, text, generating, sendReady }. `generating` is the site's own
  // "still producing this reply" signal: while a reply streams, the Send button
  // is replaced by a Stop button (or Send is disabled). main.js uses it to avoid
  // capturing a half-written reply — it only completes a turn once generation has
  // stopped (the Send button is back / clickable). If the stop/send selectors
  // don't match (a site changed its DOM), `generating` is false and completion
  // falls back to the [FROM:] tag / stability timer exactly as before.
  return `
  (() => {
    const CFG = ${payload};
    function findAny(cands) {
      for (const sel of (cands || [])) { try { const n = document.querySelector(sel); if (n) return n; } catch (_) {} }
      return null;
    }
    function isVisible(el) {
      if (!el) return false;
      try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch (_) { return false; }
    }
    function isDisabled(el) {
      if (!el) return false;
      try { return !!el.disabled || el.getAttribute("aria-disabled") === "true" || el.getAttribute("disabled") !== null; } catch (_) { return false; }
    }

    // The reply's text WITHOUT page chrome (CFG.EXCLUDE). With nothing to skip
    // this is exactly innerText / textContent. Otherwise: textContent from a copy
    // with those parts removed; innerText (which needs layout, so no detached
    // copy) by hiding them for the length of this one synchronous read and then
    // restoring their inline style — nothing paints in between.
    function chromeIn(n) {
      if (!n || !CFG.EXCLUDE || !n.querySelectorAll) return [];
      try { return Array.from(n.querySelectorAll(CFG.EXCLUDE)); } catch (_) { return []; }
    }
    function tcOf(n) {
      if (!n) return "";
      const skip = chromeIn(n);
      if (!skip.length) return String(n.textContent || "");
      try {
        const copy = n.cloneNode(true);
        copy.querySelectorAll(CFG.EXCLUDE).forEach((e) => { try { e.remove(); } catch (_) {} });
        return String(copy.textContent || "");
      } catch (_) { return String(n.textContent || ""); }
    }
    function innerOf(n) {
      if (!n) return "";
      let raw;
      try { raw = n.innerText; } catch (_) { raw = undefined; }
      if (typeof raw !== "string") return tcOf(n); // no layout engine (tests) — the plain-text path
      const skip = chromeIn(n);
      if (!skip.length) return raw;
      const saved = [];
      try {
        for (const e of skip) {
          saved.push([e, e.style.getPropertyValue("display"), e.style.getPropertyPriority("display")]);
          e.style.setProperty("display", "none", "important");
        }
        const t = n.innerText;
        return typeof t === "string" ? t : raw;
      } catch (_) {
        return raw;
      } finally {
        for (const [e, v, pr] of saved) {
          try { if (v) e.style.setProperty("display", v, pr); else e.style.removeProperty("display"); if (!e.getAttribute("style")) e.removeAttribute("style"); } catch (_) {}
        }
      }
    }
    const textOf = (n) => innerOf(n) || tcOf(n);

    // 2026-10-29: never page chrome (the sidebar's recent chats matched as "the
    // reply"); on a page of message ROWS never a node in the user's row, outside
    // every row, or holding several rows (transcript-rows.js).
    const RK = (${ROWKIT_SRC})(CFG.ROWKIT);
    let rowInfo = null;
    try { rowInfo = RK.enabled ? RK.classify(document) : null; } catch (_) { rowInfo = null; }
    const rowMode = !!(rowInfo && rowInfo.rows.length);
    function okNode(n) {
      if (!n) return false;
      try { if (RK.inChrome(n)) return false; } catch (_) {}
      if (rowMode) { const r = RK.rowOf(rowInfo, n); if (!r || r.role !== "assistant") return false; }
      return true;
    }
    function qsaOk(sel) { try { return Array.from(document.querySelectorAll(sel)).filter(okNode); } catch (_) { return []; } }

    let all = [];
    const overrideOk = CFG.OVERRIDE ? qsaOk(CFG.OVERRIDE).length : 0;
    if (CFG.STRICT) all = qsaOk(CFG.OVERRIDE);
    const strictHit = all.length > 0;
    if (!strictHit) for (const sel of CFG.ASSISTANT_CANDIDATES) all.push(...qsaOk(sel));
    let node = all.length ? all[all.length - 1] : null;
    let text = node ? textOf(node) : "";
    // Rows: the reply is Claude's LATEST row — and only when it comes after the
    // user's latest row (before that, Claude hasn't started answering: nothing to
    // read yet, never the previous reply or the user's own message). Inside that
    // row: the one block of message text, or the whole row (minus its hidden
    // heading and buttons, CFG.EXCLUDE) when the text is in several blocks.
    let via = null;
    if (rowMode) {
      const A = rowInfo.lastAsst >= 0 ? rowInfo.rows[rowInfo.lastAsst] : null;
      if (!A || rowInfo.lastUser > rowInfo.lastAsst) { node = null; text = ""; via = "rows-waiting"; }
      else {
        const inRow = all.filter((n) => n === A.el || A.el.contains(n));
        const blocks = Array.from(new Set(inRow.concat(RK.contentIn(A.el))));
        const outer = blocks.filter((n) => !blocks.some((m) => m !== n && m.contains(n)));
        node = outer.length === 1 ? outer[0] : A.el;
        text = textOf(node);
        via = "rows";
      }
    }
    // A saved / learned reply selector that finds no proper reply (nothing, only
    // the user's rows or page chrome) is passed over for the built-in reader.
    const overrideIgnored = !!(CFG.OVERRIDE && overrideOk === 0 && (via === "rows" || (node && text.trim())));
    // TR-23: a saved "reply" selector that only reaches PART of the reply (a
    // single paragraph — e.g. just the "[FROM: X]" line) made whole replies
    // look empty. If the built-in selectors find a reply whose text ENDS WITH
    // what the override read, the override is reading a fragment: use the
    // whole reply instead.
    let fragmentFixed = false;
    if (!via && CFG.OVERRIDE && text.trim() && !strictHit) {
      let full = null;
      for (const sel of CFG.DEFAULT_ASSISTANT) {
        const list = qsaOk(sel); if (list.length) { full = list[list.length - 1]; break; }
      }
      const fullText = full ? textOf(full) : "";
      if (full && fullText.trim().length > text.trim().length && fullText.trim().endsWith(text.trim())) { node = full; text = fullText; fragmentFixed = "defaults"; }
    }
    // Still only part of a reply (it closes with [FROM:] but has no [TO:] —
    // e.g. the site splits one reply into several blocks, or its layout
    // changed): climb to the element that holds the whole reply. Never into a
    // block that contains the user's own message or more than one reply.
    const hasFrom = (s) => /\\[\\s*FROM\\s*:/i.test(s);
    const startsWithTo = (s) => /^\\s*\\[\\s*TO\\s*:/i.test(s);
    // Only when the block we read has no [TO: anywhere — if it does, the AI
    // wrote (or quoted) it there and climbing could pick up a quoted tag.
    if (!via && node && hasFrom(text) && !startsWithTo(text) && !/\\[\\s*TO\\s*:/i.test(text)) {
      const USER_MARKERS = '[data-message-author-role="user"], [data-testid="user-message"], user-query, .user-query';
      let cur = node;
      for (let i = 0; i < 10 && cur.parentElement && cur.parentElement !== document.body; i++) {
        const p = cur.parentElement;
        let hasUser = false; try { hasUser = !!p.querySelector(USER_MARKERS); } catch (_) {}
        if (hasUser) break;
        const t = textOf(p);
        if ((t.match(/\\[\\s*FROM\\s*:/gi) || []).length > 1) break; // that's more than one reply
        cur = p;
        const m = /(^|\\n)[ \\t]*\\[\\s*TO\\s*:[^\\]]*\\][\\s\\S]*\\[\\s*FROM\\s*:/i.exec(t); // the tag must start a line
        if (m) {
          const start = m.index + m[1].length;
          // end right after the LAST [FROM: …] so page buttons below it don't tag along
          let end = t.length, fm; const fre = /\\[\\s*FROM\\s*:[^\\]]*\\]/gi;
          while ((fm = fre.exec(t))) end = fm.index + fm[0].length;
          node = p; text = t.slice(start, end); fragmentFixed = "climb"; break;
        }
      }
    }

    // TR-31: the reader got only the START of a reply — a few characters like
    // "[TO:" (seen live on Gemini) — because the page split the reply into
    // pieces the selector doesn't cover. Climb to the element holding the
    // whole reply, with the same guards (no user message, one reply only).
    if (!via && node && !fragmentFixed && !hasFrom(text) && text.trim().length <= 40 && startsWithTo(text)) {
      const USER_MARKERS2 = '[data-message-author-role="user"], [data-testid="user-message"], user-query, .user-query';
      let cur = node;
      for (let i = 0; i < 10 && cur.parentElement && cur.parentElement !== document.body; i++) {
        const p = cur.parentElement;
        let hasUser = false; try { hasUser = !!p.querySelector(USER_MARKERS2); } catch (_) {}
        if (hasUser) break;
        const t = textOf(p);
        if ((t.match(/\\[\\s*FROM\\s*:/gi) || []).length > 1) break;
        cur = p;
        // the FIRST line-start [TO: — the reply's own tag (a quoted example later
        // in the reply must not cut it short)
        let idx = -1; const tm = /(^|\\n)[ \\t]*\\[\\s*TO\\s*:/i.exec(t);
        if (tm) idx = tm.index + tm[1].length;
        if (idx < 0) continue;
        let cand = t.slice(idx);
        if (hasFrom(cand)) { let end = cand.length, fm; const fre = /\\[\\s*FROM\\s*:[^\\]]*\\]/gi; while ((fm = fre.exec(cand))) end = fm.index + fm[0].length; cand = cand.slice(0, end); }
        if (cand.trim().length > text.trim().length + 5) { node = p; text = cand; fragmentFixed = "climb-start"; break; }
      }
    }
    // P37.2: read the WHOLE reply. The page may split one reply over several nodes
    // (Gemini: "[TO:" in one, the rest in others; code blocks / markdown parts): when
    // the node we read is just the envelope start, or much shorter than the AI
    // message it belongs to, use that message's full text. Never a container that
    // holds the user's message or more than one reply.
    const fullOf = (n) => { let t = ""; try { t = innerOf(n) || ""; } catch (_) {} const tc = tcOf(n); return t.trim().length >= tc.trim().length * 0.6 ? t : tc; };
    const squash = (s) => String(s || "").replace(/\\s+/g, " ").trim();
    let containerChars = null;
    if (!via && node && !fragmentFixed) {
      // innerText of a part the page hasn't laid out (collapsed / not yet painted)
      // can be shorter than its real text
      const tcText = tcOf(node);
      if (text.trim().length <= 40 && tcText.trim().length > text.trim().length + 5) { text = tcText; fragmentFixed = "textcontent"; }
      let box = null;
      for (const sel of CFG.MESSAGE_CONTAINERS || []) { try { const c = node.closest(sel); if (c && (!box || box.contains(c))) box = c; } catch (_) {} }
      if (box && box !== node) {
        const USER_MARKERS3 = '[data-message-author-role="user"], [data-testid="user-message"], user-query, .user-query';
        let hasUser = false; try { hasUser = !!box.querySelector(USER_MARKERS3) || !!(box.closest && box.closest(USER_MARKERS3)); } catch (_) {}
        let ct = fullOf(box);
        containerChars = ct.length;
        const froms = (ct.match(/\\[\\s*FROM\\s*:/gi) || []).length;
        const short = text.trim().length <= 40 && startsWithTo(text) && !hasFrom(text);
        if (!hasUser && froms <= 1 && squash(ct).length > squash(text).length + 5 && squash(ct).indexOf(squash(text).slice(0, 30)) !== -1 && (short || squash(text).length < squash(ct).length * 0.6)) {
          // from the reply's own [TO: (a line start) to right after its [FROM:], so
          // page buttons around it don't tag along
          const tm = /(^|\\n)[ \\t]*\\[\\s*TO\\s*:/i.exec(ct);
          if (tm) ct = ct.slice(tm.index + tm[1].length);
          if (hasFrom(ct)) { let end = ct.length, fm; const fre = /\\[\\s*FROM\\s*:[^\\]]*\\]/gi; while ((fm = fre.exec(ct))) end = fm.index + fm[0].length; ct = ct.slice(0, end); }
          node = box; text = ct; fragmentFixed = "container";
        }
      }
    }
    // For the log when a reply can't be read properly: what the reader landed on.
    let nodeInfo = null;
    if (node && text.trim().length <= 40) {
      try { nodeInfo = { tag: node.tagName.toLowerCase(), cls: String(node.className || "").slice(0, 60) || null, parentTag: node.parentElement ? node.parentElement.tagName.toLowerCase() : null, parentChars: node.parentElement ? (node.parentElement.innerText || "").length : 0, siblings: node.parentElement ? node.parentElement.children.length : 0, containerChars }; } catch (_) {}
    }

    // Is the composer empty? A Send button is ALSO disabled when there's simply
    // nothing to send (idle, empty composer) — so an empty composer must NOT be
    // read as "still generating" (E03: a finished reply left the Send button
    // disabled and its reply stayed uncaptured until a later send).
    // TR-27: a saved selector may name a wrapper around the real box.
    // Prefer a VISIBLE editable box (sites keep a hidden fallback textarea).
    let inputBox = null, inputFirst = null;
    for (const sel of (CFG.INPUT_CANDIDATES || [])) {
      let list = [];
      try { list = Array.from(document.querySelectorAll(sel)); } catch (_) { continue; }
      for (let n of list) {
        if (n.tagName !== "TEXTAREA" && !n.isContentEditable) {
          try { const inner = Array.from(n.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]')); n = inner.find(isVisible) || inner[0] || n; } catch (_) {}
        }
        if (!inputFirst) inputFirst = n;
        if ((n.tagName === "TEXTAREA" || n.isContentEditable) && isVisible(n)) { inputBox = n; break; }
      }
      if (inputBox) break;
    }
    if (!inputBox) inputBox = inputFirst;
    const composerText = inputBox ? (inputBox.value != null ? inputBox.value : (inputBox.innerText || inputBox.textContent || "")) : "";
    const composerEmpty = !String(composerText).trim();

    // Generation is in progress if a Stop button is visible (the reliable signal),
    // or — only for sites with no Stop button that disable Send mid-stream — if
    // Send is disabled WHILE the composer still holds text. A disabled Send over an
    // empty composer is the idle state, not streaming.
    const stopBtn = findAny(CFG.STOP_CANDIDATES);
    // TR-27: same Send-button rule as the send script — a hidden, disabled
    // leftover "Send" that matches first must not make the pane look busy.
    let sendBtn = null, firstSend = null;
    for (const sel of (CFG.SEND_CANDIDATES || [])) {
      let list = [];
      try { list = Array.from(document.querySelectorAll(sel)); } catch (_) { continue; }
      if (!firstSend && list.length) firstSend = list[0];
      const shown = list.filter(isVisible);
      if (shown.length) { sendBtn = shown.find((b) => !isDisabled(b)) || shown[0]; break; }
    }
    if (!sendBtn) sendBtn = firstSend;
    let generating = false;
    if (stopBtn && isVisible(stopBtn)) generating = true;
    else if (sendBtn && isDisabled(sendBtn) && !composerEmpty) generating = true;
    // The Send button is back and clickable — the model is done speaking.
    const sendReady = !generating && !!sendBtn && isVisible(sendBtn) && !isDisabled(sendBtn);

    // How many reply blocks are on the page: a re-drawn reply keeps the count,
    // a genuinely new reply adds one (TR-17). Counted with ONE selector only —
    // the first that matches — so nested wrappers or a saved override that
    // matches the same nodes can never inflate it.
    // After a fragment fix the override's matches are paragraphs, not replies:
    // count with the built-in selectors, or report "unknown" after a climb.
    let count = 0;
    const countWith = strictHit ? [CFG.OVERRIDE] : fragmentFixed === "defaults" ? CFG.DEFAULT_ASSISTANT : CFG.ASSISTANT_CANDIDATES;
    for (const sel of countWith) {
      const n = qsaOk(sel).length; if (n) { count = n; break; }
    }
    if (fragmentFixed === "climb") count = null;
    if (rowMode) count = rowInfo.assistants; // one row = one message
    const stopShown = !!(stopBtn && isVisible(stopBtn)); // TR-28: the page's own "still writing" signal, on its own
    const inputFound = !!inputBox; // the AI's message box is on the page (a signed-out page has none)
    const rows = rowMode ? { n: rowInfo.rows.length, user: rowInfo.users, assistant: rowInfo.assistants, how: rowInfo.how, waiting: via === "rows-waiting" } : null;
    return { ok: true, text, generating, stopShown, sendReady, composerEmpty, inputFound, count, fragmentFixed, nodeInfo, rows, overrideIgnored };
  })();
  `;
}

// buildPickScript builds a one-shot "click-to-pick" script for the selector
// picker feature: instead of the user hand-typing a CSS selector (or opening
// DevTools themselves), they click a role (input/send/assistant) in the
// control panel, then click the real element live in the pane. This script
// shows a small banner, captures the NEXT click on the real page (preventing
// its default action so nothing actually submits/navigates), works out a
// best-effort selector for it, and resolves with that -- executeJavaScript()
// awaits the returned Promise automatically, same as the other scripts here,
// it just doesn't resolve until a click happens (or TIMEOUT_MS elapses).
// __AUTOINJECTOR_PICK__ is a literal marker so the test mock can recognize
// this script by content, the same way it recognizes buildSendScript's
// output via "typeByKeyboard".
function buildPickScript(role, site) {
  const TIMEOUT_MS = 30000;
  let defaults = [];
  try { defaults = site ? siteConfig(site).ASSISTANT_CANDIDATES : []; } catch (_) {}
  // Only markers that mean "an AI reply" — never "article" or *message*
  // test-ids, which also match the user's own turns or one fixed old turn.
  const MESSAGE_MARKERS = [...defaults, '[data-message-author-role="assistant"]', "model-response", "message-content", ".standard-markdown", ".markdown"];
  const label = role === "input" ? "the message box you type into" : role === "send" ? "the Send button" : "the text of a reply";
  return `
  (() => new Promise((resolve) => {
    // __AUTOINJECTOR_PICK__
    const ROLE = ${JSON.stringify(role)};
    const MESSAGE_MARKERS = ${JSON.stringify(MESSAGE_MARKERS)};
    let done = false;
    const banner = document.createElement("div");
    banner.textContent = "AutoInjector: click ${label} now\\u2026";
    banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#111;color:#fff;font:14px system-ui,sans-serif;padding:8px 14px;text-align:center;pointer-events:none;";
    document.documentElement.appendChild(banner);
    const prevCursor = document.documentElement.style.cursor;
    document.documentElement.style.cursor = "crosshair";

    function cleanup() {
      document.removeEventListener("click", onClick, true);
      banner.remove();
      document.documentElement.style.cursor = prevCursor;
    }

    function attrSelector(el) {
      // a test-id that ends in a number names ONE turn (e.g. conversation-turn-12) — not usable
      if (el.getAttribute && el.getAttribute("data-testid") && !/\\d+$/.test(el.getAttribute("data-testid"))) return '[data-testid="' + el.getAttribute("data-testid") + '"]';
      if (el.getAttribute && el.getAttribute("aria-label")) return el.tagName.toLowerCase() + '[aria-label="' + el.getAttribute("aria-label") + '"]';
      if (el.id && !/^[a-f0-9]{6,}$/i.test(el.id)) return "#" + CSS.escape(el.id);
      if (el.className && typeof el.className === "string") {
        const cls = el.className.trim().split(/\\s+/).filter((c) => c && c.length > 2 && !/\\d{4,}/.test(c)).slice(0, 2);
        if (cls.length) return el.tagName.toLowerCase() + "." + cls.map((c) => CSS.escape(c)).join(".");
      }
      return el.tagName.toLowerCase();
    }

    function nearestByRole(el) {
      if (ROLE === "input") {
        // TR-27: snap to the real editable box — the outermost contenteditable
        // (or textarea) — even if the click landed on a wrapper or placeholder.
        let n = el.closest('textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]');
        if (!n) { try { n = el.querySelector('textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'); } catch (_) {} }
        if (!n) { let p = el.parentElement; for (let i = 0; p && i < 4 && !n; i++, p = p.parentElement) { try { n = p.querySelector('textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'); } catch (_) {} } }
        if (n && n.tagName !== "TEXTAREA") { while (n.parentElement && n.parentElement.isContentEditable) n = n.parentElement; }
        return n || el;
      }
      if (ROLE === "send") return el.closest('button, [role="button"], input[type="submit"]') || el;
      // assistant (TR-24): snap to the element that holds the WHOLE reply —
      // the site's own message container — never the word or paragraph that
      // was clicked (that is how "span" / one-paragraph selectors got saved).
      for (const sel of MESSAGE_MARKERS) {
        try { const c = el.closest(sel); if (c) { c.__aiPickSelector = sel; return c; } } catch (_) {}
      }
      // No known container: climb single-child wrappers, then keep climbing
      // until the element has something more specific than a bare tag.
      let node = el, depth = 0;
      while (node.parentElement && node.parentElement.children.length <= 1 && depth < 6) {
        node = node.parentElement;
        depth++;
      }
      while (node.parentElement && node.parentElement !== document.body && /^[a-z0-9-]+$/i.test(attrSelector(node)) && depth < 12) { node = node.parentElement; depth++; }
      return node;
    }

    function onClick(e) {
      if (done) return;
      done = true;
      e.preventDefault();
      e.stopImmediatePropagation();
      const target = nearestByRole(e.target);
      // A reply pick that snapped to a known reply container saves THAT
      // container's selector (it matches every reply, and only replies).
      const selector = target.__aiPickSelector || attrSelector(target);
      const sample = (target.innerText || target.textContent || "").trim().slice(0, 120);
      const tag = target.tagName.toLowerCase();
      // Validated right here, against the live page, in the same tick as the
      // click -- not trusted blindly. matchCount catches a generated selector
      // that doesn't actually resolve back to (only) the clicked element;
      // visible catches picking something hidden/zero-size; roleOk catches
      // clicking the wrong kind of element for input/send (an "assistant"
      // pick has no fixed expected tag, so it's always considered role-ok).
      let matchCount = 0;
      try { matchCount = document.querySelectorAll(selector).length; } catch { matchCount = 0; }
      const rect = target.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;
      const isEditable = tag === "textarea" || target.isContentEditable === true;
      const isButton = tag === "button" || target.getAttribute("role") === "button" || (tag === "input" && target.type === "submit");
      const roleOk = ROLE === "input" ? isEditable : ROLE === "send" ? isButton : true;
      cleanup();
      resolve({ ok: true, selector, tag, sample, matchCount, visible, roleOk });
    }
    document.addEventListener("click", onClick, true);

    setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      resolve({ ok: false, error: "TIMEOUT" });
    }, ${TIMEOUT_MS});
  }))();
  `;
}

// buildFileInputFinderExpression is different in kind from buildSendScript/
// buildReadScript: it's NOT run via webContents.executeJavaScript(). It's the
// `expression` field of a CDP Runtime.evaluate call (see attachFileToSite()
// in main.js) — we need Runtime.evaluate's raw objectId (a live handle
// DOM.setFileInputFiles can target directly), not a JSON-serializable return
// value like the send/read scripts produce.
function buildFileInputFinderExpression(site) {
  const cfg = siteConfig(site);
  const candidates = JSON.stringify(cfg.FILE_INPUT_CANDIDATES || []);
  return `(() => {
    const CANDIDATES = ${candidates};
    for (const sel of CANDIDATES) {
      const node = document.querySelector(sel);
      if (node) return node;
    }
    return null;
  })()`;
}

// buildLoginFillScript backs the 🔑 saved-logins feature: purely manual
// (never runs on its own -- only fired when the user clicks a specific
// saved login), it types the given username/password into whatever login
// fields are actually present on screen right now and clicks whatever
// looks like the submit button. Real login flows for these three sites are
// often multi-step (email on one screen, password on the next), so this
// doesn't assume both fields exist at once -- it fills whichever is
// present, which is also why clicking the same saved login again after the
// page advances to the next step is expected, not a bug.
function buildLoginFillScript(site, username, password) {
  const cfg = siteConfig(site);
  const payload = JSON.stringify({
    username,
    password,
    USERNAME_CANDIDATES: cfg.LOGIN_USERNAME_CANDIDATES || [],
    PASSWORD_CANDIDATES: cfg.LOGIN_PASSWORD_CANDIDATES || [],
    SUBMIT_CANDIDATES: cfg.LOGIN_SUBMIT_CANDIDATES || []
  });
  return `
  (() => {
    // __AUTOINJECTOR_LOGIN_FILL__
    const CFG = ${payload};

    function qsAllAny(candidates) {
      for (const sel of candidates) {
        const node = document.querySelector(sel);
        if (node && node.offsetParent !== null) return node; // skip hidden/off-screen fields (e.g. a not-yet-revealed password step)
      }
      return null;
    }

    function setNativeValue(elm, value) {
      const propDesc = Object.getOwnPropertyDescriptor(elm.__proto__, "value");
      const setter = propDesc && propDesc.set;
      if (setter) setter.call(elm, value);
      elm.dispatchEvent(new Event("input", { bubbles: true }));
      elm.dispatchEvent(new Event("change", { bubbles: true }));
    }

    const usernameField = qsAllAny(CFG.USERNAME_CANDIDATES);
    const passwordField = qsAllAny(CFG.PASSWORD_CANDIDATES);
    if (!usernameField && !passwordField) return { ok: false, error: "NO_LOGIN_FORM_FOUND" };

    const filled = [];
    // Multi-step login: only fill whichever field(s) are actually present
    // right now, never assume both are on the same screen.
    if (usernameField) { setNativeValue(usernameField, CFG.username); filled.push("username"); }
    if (passwordField) { setNativeValue(passwordField, CFG.password); filled.push("password"); }

    const submitBtn = qsAllAny(CFG.SUBMIT_CANDIDATES);
    if (!submitBtn) return { ok: true, filled, submitted: false, warning: "SUBMIT_NOT_FOUND" };
    submitBtn.click();
    return { ok: true, filled, submitted: true };
  })();
  `;
}

// TR-08: a READ-ONLY page check — sends nothing, clicks nothing. Reports which
// of each selector list actually matches on the live page right now, so a
// changed site (or a signed-out pane) shows up before any message is lost.
// -> { ok, url, input:{found,selector}, send:{found,selector},
//      assistant:{count,selector}, stop:{found}, signedOutHint }
function buildProbeScript(site, overrides) {
  const cfg = siteConfig(site);
  const ov = overrides || {};
  const payload = JSON.stringify({
    INPUT: usableOverride(ov.input) ? [ov.input, ...cfg.INPUT_CANDIDATES] : cfg.INPUT_CANDIDATES,
    SEND: usableOverride(ov.send) ? [ov.send, ...cfg.SEND_CANDIDATES] : cfg.SEND_CANDIDATES,
    ASSISTANT: usableOverride(ov.assistant) ? [ov.assistant, ...cfg.ASSISTANT_CANDIDATES] : cfg.ASSISTANT_CANDIDATES,
    STOP: usableOverride(ov.stop) ? [ov.stop, ...(cfg.STOP_CANDIDATES || [])] : (cfg.STOP_CANDIDATES || []),
    OVERRIDE: usableOverride(ov.assistant) || null,
    DEFAULT_ASSISTANT: cfg.ASSISTANT_CANDIDATES,
    ROWKIT: rowConfigFor(SITES, site),
  });
  return `
  (() => {
    const CFG = ${payload};
    function first(list) {
      for (const sel of list || []) { try { if (document.querySelector(sel)) return sel; } catch (_) {} }
      return null;
    }
    // Same rules as the reader: never page chrome (the sidebar's recent chats),
    // and on a page of message rows only matches in the AI's rows count.
    const RK = (${ROWKIT_SRC})(CFG.ROWKIT);
    let rowInfo = null;
    try { rowInfo = RK.enabled ? RK.classify(document) : null; } catch (_) { rowInfo = null; }
    const rowMode = !!(rowInfo && rowInfo.rows.length);
    function okNode(n) {
      try { if (RK.inChrome(n)) return false; } catch (_) {}
      if (rowMode) { const r = RK.rowOf(rowInfo, n); if (!r || r.role !== "assistant") return false; }
      return true;
    }
    function countOk(sel) { try { return Array.from(document.querySelectorAll(sel)).filter(okNode).length; } catch (_) { return 0; } }
    function firstReply(list) {
      for (const sel of list || []) { const n = countOk(sel); if (n) return { sel, n }; }
      return null;
    }
    const withOv = firstReply(CFG.ASSISTANT);
    const builtIn = firstReply(CFG.DEFAULT_ASSISTANT);
    let assistantCount = withOv ? withOv.n : 0, assistantSel = withOv ? withOv.sel : null;
    let builtinCount = builtIn ? builtIn.n : 0, builtinSel = builtIn ? builtIn.sel : null;
    if (rowMode) {
      // one row = one message; the reader takes the AI's latest row
      assistantCount = rowInfo.assistants; builtinCount = rowInfo.assistants;
      if (!assistantSel && assistantCount) assistantSel = "rows:" + (rowInfo.selector || rowInfo.how);
      if (!builtinSel && builtinCount) builtinSel = "rows:" + (rowInfo.selector || rowInfo.how);
    }
    const overrideFinds = CFG.OVERRIDE ? countOk(CFG.OVERRIDE) : null;
    // the saved / learned reply selector finds no proper reply but the built-in
    // reader does: the built-in one is used (the reader passes the saved one over)
    const overrideMisses = !!(CFG.OVERRIDE && overrideFinds === 0 && builtinCount > 0);
    const inputSel = first(CFG.INPUT);
    let body = "";
    try { body = String(document.body ? document.body.innerText : "").slice(0, 4000).toLowerCase(); } catch (_) {}
    const signedOutHint = !inputSel && /(log ?in|sign ?in|sign up|create account|continue with google)/.test(body);
    return {
      ok: true,
      url: String(location.href || ""),
      input: { found: !!inputSel, selector: inputSel },
      send: { found: !!first(CFG.SEND), selector: first(CFG.SEND) },
      assistant: { count: assistantCount, selector: assistantSel, builtinCount, builtinSelector: builtinSel, overrideFinds, overrideMisses },
      rows: rowMode ? { n: rowInfo.rows.length, user: rowInfo.users, assistant: rowInfo.assistants, how: rowInfo.how, roleBy: Array.from(new Set(rowInfo.rows.map((r) => r.why || "order"))).slice(0, 4) } : null,
      stop: { found: !!first(CFG.STOP) },
      signedOutHint,
    };
  })();
  `;
}

module.exports = {
  USER_TURNS, SURVEY_PHRASES, MESSAGE_CONTAINERS, buildSendScript, buildReadScript, buildFileInputFinderExpression, buildPickScript, buildLoginFillScript, buildProbeScript, isBareTagSelector, usableOverride };
