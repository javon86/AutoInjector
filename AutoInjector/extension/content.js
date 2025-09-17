\
// content.js â€” injected into ChatGPT pages
// Provides: PING_CONTENT, INJECT_AND_WAIT, WS_HEALTH, GET_TRACE

(function() {
  const TRACE = [];
  const addTrace = (t) => { TRACE.push({ t, ts: Date.now() }); if (TRACE.length > 200) TRACE.shift(); };

  const SEL = (window.__AI_SELECTORS__ || {}).INPUT_CANDIDATES ? window.__AI_SELECTORS__ : {
    INPUT_CANDIDATES: ["#prompt-textarea",'div[role="textbox"]','div[data-testid="textbox"]',"main textarea","textarea",'div[contenteditable="true"]'],
    SEND_CANDIDATES: ['button[data-testid="send-button"]','button[aria-label*="Send"]','form button[type="submit"]'],
    ASSISTANT_CANDIDATES: ['[data-testid="assistant-message"]']
  };

  function qsAllAny(candidates) {
    for (const sel of candidates) {
      const node = document.querySelector(sel);
      if (node) { addTrace("selector-hit:" + sel); return { node, sel }; }
      addTrace("selector-miss:" + sel);
    }
    return { node: null, sel: null };
  }

  function focusNode(n) {
    try { n.focus(); } catch {}
    try { n.scrollIntoView({block:"nearest"}); } catch {}
  }

  function setNativeValue(el, value) {
    const propDesc = Object.getOwnPropertyDescriptor(el.__proto__, 'value');
    const setter = propDesc && propDesc.set;
    if (setter) setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function typeByKeyboard(el, text, delay=3) {
    focusNode(el);
    for (const ch of text) {
      el.dispatchEvent(new InputEvent('beforeinput', {inputType: 'insertText', data: ch, bubbles: true}));
      el.textContent = (el.textContent || "") + ch;
      el.dispatchEvent(new InputEvent('input', {inputType: 'insertText', data: ch, bubbles: true}));
      await new Promise(r=>setTimeout(r, delay));
    }
  }

  async function injectText(text) {
    const { node: input } = qsAllAny(SEL.INPUT_CANDIDATES);
    if (!input) return { ok:false, error:"INPUT_NOT_FOUND" };
    focusNode(input);

    // Strategy 1: textarea/value-based
    if (input.tagName === "TEXTAREA" || input.matches("textarea")) {
      try {
        setNativeValue(input, text);
        return { ok:true, method:"value" };
      } catch {}
    }

    // Strategy 2: contentEditable
    if (input.isContentEditable || input.getAttribute("contenteditable")==="true") {
      try {
        input.focus();
        input.textContent = "";
        input.dispatchEvent(new InputEvent('input', {inputType:'insertFromPaste', data:text, bubbles:true}));
        input.textContent = text;
        input.dispatchEvent(new InputEvent('input', {inputType:'insertFromPaste', data:text, bubbles:true}));
        return { ok:true, method:"contenteditable" };
      } catch {}
    }

    // Strategy 3: simulated typing
    try {
      await typeByKeyboard(input, text);
      return { ok:true, method:"keyboard" };
    } catch {}

    return { ok:false, error:"INJECT_FAILED" };
  }

  function clickSendOrEnter() {
    // try clicking
    const { node: btn } = qsAllAny(SEL.SEND_CANDIDATES);
    if (btn) {
      try { btn.click(); return { ok:true, method:"click" }; } catch {}
    }
    // fallback: synthesize Enter
    const active = document.activeElement || document.body;
    try {
      const ev = new KeyboardEvent("keydown", { key:"Enter", code:"Enter", bubbles:true });
      active.dispatchEvent(ev);
      return { ok:true, method:"enter" };
    } catch {}
    return { ok:false, error:"SEND_FAILED" };
  }

  function readAssistantLatest() {
    // Prefer the last assistant block
    const all = [];
    for (const sel of SEL.ASSISTANT_CANDIDATES) {
      document.querySelectorAll(sel).forEach(n=>all.push(n));
    }
    if (!all.length) return "";
    const node = all[all.length-1];
    return node.innerText || node.textContent || "";
  }

  async function waitForReply(timeoutMs=180000) {
    const start = Date.now();
    let last = readAssistantLatest();
    if (last) addTrace("assistant-initial:"+last.slice(0,80));

    return new Promise((resolve) => {
      let stableTimer = null;
      const obs = new MutationObserver(()=>{
        const cur = readAssistantLatest();
        if (cur !== last) {
          last = cur;
          if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
          stableTimer = setTimeout(()=>{
            obs.disconnect();
            resolve({ ok:true, text: cur });
          }, 2000);
        }
      });
      obs.observe(document.body, { subtree:true, childList:true, characterData:true });

      const t = setInterval(()=>{
        if (Date.now() - start > timeoutMs) {
          try { obs.disconnect(); } catch {}
          try { clearInterval(t); } catch {}
          resolve({ ok:false, error:"TIMEOUT_REPLY" });
        }
      }, 500);
    });
  }

  function wsHealth() {
    const urls = Array.from(document.querySelectorAll('a[href^="wss://"], a[href^="ws://"]')).map(a=>a.href);
    return { ok:true, hasWss: urls.some(u=>u.startsWith("wss://")), urls: urls.slice(0,5) };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg?.type === "PING_CONTENT") { sendResponse({ ok:true, version:"v2.2.3" }); return; }
        if (msg?.type === "WS_HEALTH") { sendResponse(wsHealth()); return; }
        if (msg?.type === "GET_TRACE") { sendResponse({ ok:true, trace: TRACE.slice(-20) }); return; }
        if (msg?.type === "INJECT_AND_WAIT") {
          const messages = Array.isArray(msg.messages) ? msg.messages : [];
          const prompt = messages.map(m => `[${m.role}] ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`).join("\n\n");
          const inj = await injectText(prompt);
          if (!inj.ok) { sendResponse(inj); return; }
          const sent = clickSendOrEnter();
          if (!sent.ok) { sendResponse(sent); return; }
          const res = await waitForReply(msg.timeoutMs ?? 180000);
          sendResponse(res);
          return;
        }
        sendResponse({ ok:false, error:"UNKNOWN_MESSAGE" });
      } catch (e) { sendResponse({ ok:false, error:String(e) }); }
    })();
    return true;
  });

})();
