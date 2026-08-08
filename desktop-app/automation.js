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

function siteConfig(site) {
  const cfg = SITES[site];
  if (!cfg) throw new Error(`Unknown site: ${site}`);
  return cfg;
}

function buildSendScript(site, text, overrides) {
  const cfg = siteConfig(site);
  const ov = overrides || {};
  const payload = JSON.stringify({
    text,
    INPUT_CANDIDATES: ov.input ? [ov.input, ...cfg.INPUT_CANDIDATES] : cfg.INPUT_CANDIDATES,
    SEND_CANDIDATES: ov.send ? [ov.send, ...cfg.SEND_CANDIDATES] : cfg.SEND_CANDIDATES
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

    async function injectText(text) {
      const input = qsAllAny(CFG.INPUT_CANDIDATES);
      if (!input) return { ok: false, error: "INPUT_NOT_FOUND" };
      focusNode(input);

      if (input.tagName === "TEXTAREA" || input.matches("textarea")) {
        try { setNativeValue(input, text); return { ok: true }; } catch {}
      }
      if (input.isContentEditable || input.getAttribute("contenteditable") === "true") {
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
      const input = qsAllAny(CFG.INPUT_CANDIDATES);
      if (!input) return true; // can't find it to check anymore -- don't block success on that
      const remaining = (input.tagName === "TEXTAREA" ? input.value : input.textContent) || "";
      return remaining.trim().length === 0;
    }

    // A single fixed-delay snapshot (the old version of this) reports a
    // false SEND_NOT_CONFIRMED on any page that's just a bit slower than
    // usual to clear its input box (a big paste, a laggy tab) -- polling
    // over a longer window gives a genuinely slow-but-real send room to
    // actually confirm, instead of a one-shot guess.
    async function confirmSent() {
      const start = Date.now();
      while (Date.now() - start < 2500) {
        if (await inputIsEmpty()) return true;
        await new Promise((r) => setTimeout(r, 150));
      }
      return inputIsEmpty();
    }

    async function attemptSend() {
      const btn = qsAllAny(CFG.SEND_CANDIDATES);
      if (btn) {
        try { btn.click(); } catch {}
        if (await confirmSent()) return { ok: true, method: "click" };
      }
      const active = document.activeElement || document.body;
      try {
        active.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
      } catch {}
      if (await confirmSent()) return { ok: true, method: "enter" };
      return { ok: false, error: "SEND_NOT_CONFIRMED" };
    }

    const inj = await injectText(CFG.text);
    if (!inj.ok) return inj;
    return attemptSend();
  })();
  `;
}

function buildReadScript(site, overrides) {
  const cfg = siteConfig(site);
  const ov = overrides || {};
  const payload = JSON.stringify({
    ASSISTANT_CANDIDATES: ov.assistant ? [ov.assistant, ...cfg.ASSISTANT_CANDIDATES] : cfg.ASSISTANT_CANDIDATES
  });

  return `
  (() => {
    const CFG = ${payload};
    const all = [];
    for (const sel of CFG.ASSISTANT_CANDIDATES) {
      document.querySelectorAll(sel).forEach((n) => all.push(n));
    }
    if (!all.length) return { ok: true, text: "" };
    const node = all[all.length - 1];
    return { ok: true, text: node.innerText || node.textContent || "" };
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
function buildPickScript(role) {
  const TIMEOUT_MS = 30000;
  const label = role === "input" ? "the message box you type into" : role === "send" ? "the Send button" : "the text of a reply";
  return `
  (() => new Promise((resolve) => {
    // __AUTOINJECTOR_PICK__
    const ROLE = ${JSON.stringify(role)};
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
      if (el.getAttribute && el.getAttribute("data-testid")) return '[data-testid="' + el.getAttribute("data-testid") + '"]';
      if (el.getAttribute && el.getAttribute("aria-label")) return el.tagName.toLowerCase() + '[aria-label="' + el.getAttribute("aria-label") + '"]';
      if (el.id && !/^[a-f0-9]{6,}$/i.test(el.id)) return "#" + CSS.escape(el.id);
      if (el.className && typeof el.className === "string") {
        const cls = el.className.trim().split(/\\s+/).filter((c) => c && c.length > 2 && !/\\d{4,}/.test(c)).slice(0, 2);
        if (cls.length) return el.tagName.toLowerCase() + "." + cls.map((c) => CSS.escape(c)).join(".");
      }
      return el.tagName.toLowerCase();
    }

    function nearestByRole(el) {
      if (ROLE === "input") return el.closest('textarea, [contenteditable="true"]') || el;
      if (ROLE === "send") return el.closest('button, [role="button"], input[type="submit"]') || el;
      // assistant: climb through plain single-child wrapper elements only,
      // so clicking inner text lands on the smallest element that still
      // contains the whole reply rather than the message list container.
      let node = el, depth = 0;
      while (node.parentElement && node.parentElement.children.length <= 1 && depth < 6) {
        node = node.parentElement;
        depth++;
      }
      return node;
    }

    function onClick(e) {
      if (done) return;
      done = true;
      e.preventDefault();
      e.stopImmediatePropagation();
      const target = nearestByRole(e.target);
      const selector = attrSelector(target);
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

module.exports = { buildSendScript, buildReadScript, buildFileInputFinderExpression, buildPickScript };
