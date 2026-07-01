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

function buildSendScript(site, text) {
  const cfg = siteConfig(site);
  const payload = JSON.stringify({
    text,
    INPUT_CANDIDATES: cfg.INPUT_CANDIDATES,
    SEND_CANDIDATES: cfg.SEND_CANDIDATES
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

    function clickSendOrEnter() {
      const btn = qsAllAny(CFG.SEND_CANDIDATES);
      if (btn) { try { btn.click(); return { ok: true }; } catch {} }
      const active = document.activeElement || document.body;
      try {
        active.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
        return { ok: true };
      } catch {}
      return { ok: false, error: "SEND_FAILED" };
    }

    const inj = await injectText(CFG.text);
    if (!inj.ok) return inj;
    return clickSendOrEnter();
  })();
  `;
}

function buildReadScript(site) {
  const cfg = siteConfig(site);
  const payload = JSON.stringify({ ASSISTANT_CANDIDATES: cfg.ASSISTANT_CANDIDATES });

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

module.exports = { buildSendScript, buildReadScript };
