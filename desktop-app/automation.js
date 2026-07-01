// automation.js — builds a self-contained script string that, when run inside a
// site's WebContentsView via webContents.executeJavaScript(), types a prompt into
// that site's chat box, clicks send, waits for the reply to finish streaming, and
// resolves with { ok:true, text } or { ok:false, error }. This mirrors the injection
// logic in AutoInjector/extension/content.js, but runs as a one-shot script instead
// of a persistent content-script message listener.
const SITES = require("./selectors");

function buildAutomationScript(site, promptText, timeoutMs) {
  const cfg = SITES[site];
  if (!cfg) throw new Error(`Unknown site: ${site}`);

  const payload = JSON.stringify({
    text: promptText,
    timeoutMs: timeoutMs,
    INPUT_CANDIDATES: cfg.INPUT_CANDIDATES,
    SEND_CANDIDATES: cfg.SEND_CANDIDATES,
    ASSISTANT_CANDIDATES: cfg.ASSISTANT_CANDIDATES
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

    function readAssistantLatest() {
      const all = [];
      for (const sel of CFG.ASSISTANT_CANDIDATES) {
        document.querySelectorAll(sel).forEach((n) => all.push(n));
      }
      if (!all.length) return "";
      const node = all[all.length - 1];
      return node.innerText || node.textContent || "";
    }

    function waitForReply(timeoutMs) {
      const start = Date.now();
      let last = readAssistantLatest();
      return new Promise((resolve) => {
        let stableTimer = null;
        const obs = new MutationObserver(() => {
          const cur = readAssistantLatest();
          if (cur !== last) {
            last = cur;
            if (stableTimer) clearTimeout(stableTimer);
            stableTimer = setTimeout(() => {
              obs.disconnect();
              resolve({ ok: true, text: cur });
            }, 2000);
          }
        });
        obs.observe(document.body, { subtree: true, childList: true, characterData: true });
        const t = setInterval(() => {
          if (Date.now() - start > timeoutMs) {
            try { obs.disconnect(); } catch {}
            try { clearInterval(t); } catch {}
            resolve({ ok: false, error: "TIMEOUT_REPLY" });
          }
        }, 500);
      });
    }

    const inj = await injectText(CFG.text);
    if (!inj.ok) return inj;
    const sent = clickSendOrEnter();
    if (!sent.ok) return sent;
    return await waitForReply(CFG.timeoutMs);
  })();
  `;
}

module.exports = { buildAutomationScript };
