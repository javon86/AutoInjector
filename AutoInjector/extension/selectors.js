// selectors.js — central DOM selectors, one entry per AI site.
// No exports; the content script reads these off `window`.
(function () {
  const SITES = {
    chatgpt: {
      label: "ChatGPT",
      match: (host) => /(^|\.)chat\.openai\.com$/.test(host) || /(^|\.)chatgpt\.com$/.test(host),
      INPUT_CANDIDATES: [
        "#prompt-textarea",
        'div[role="textbox"]',
        'div[data-testid="textbox"]',
        "main textarea",
        "textarea",
        'div[contenteditable="true"]'
      ],
      SEND_CANDIDATES: [
        'button[data-testid="send-button"]',
        'button[aria-label*="Send"]',
        'form button[type="submit"]'
      ],
      ASSISTANT_CANDIDATES: [
        '[data-testid="assistant-message"]',
        'div[data-message-author-role="assistant"]',
        'article:has([data-message-author-role="assistant"])'
      ]
    },
    claude: {
      label: "Claude",
      match: (host) => /(^|\.)claude\.ai$/.test(host),
      INPUT_CANDIDATES: [
        'div[contenteditable="true"][data-testid]',
        'div[contenteditable="true"].ProseMirror',
        'div[contenteditable="true"][class*="composer"]',
        'div[contenteditable="true"][placeholder]',
        'div[contenteditable="true"]',
        "textarea"
      ],
      SEND_CANDIDATES: [
        'button[aria-label="Send Message"]',
        'button[aria-label="Send message"]',
        'button[data-testid="send-message-button"]',
        'form button[type="submit"]'
      ],
      ASSISTANT_CANDIDATES: [
        '[data-testid="chat-message"]',
        "div.font-claude-message",
        '[data-testid="message-content"]',
        // confirmed via live DOM inspection (2026-07): the reply text now lives in
        // <p class="font-claude-response-body"> inside this markdown container div —
        // read the whole container (not the <p> alone) so multi-paragraph/list/code
        // replies aren't truncated to just their last block.
        "div.standard-markdown"
      ]
    },
    gemini: {
      label: "Gemini",
      match: (host) => /(^|\.)gemini\.google\.com$/.test(host),
      INPUT_CANDIDATES: [
        "rich-textarea div[contenteditable=\"true\"]",
        'div.ql-editor[contenteditable="true"]',
        'div[contenteditable="true"]',
        "textarea"
      ],
      SEND_CANDIDATES: [
        'button[aria-label="Send message"]',
        "button.send-button",
        'form button[type="submit"]'
      ],
      ASSISTANT_CANDIDATES: [
        "message-content .markdown",
        "div.model-response-text",
        "div[data-response-index]"
      ]
    }
  };

  function detectSite() {
    const host = location.hostname;
    for (const [id, cfg] of Object.entries(SITES)) {
      if (cfg.match(host)) return id;
    }
    return null;
  }

  const siteId = detectSite();
  window.__AI_SITES__ = SITES;
  window.__AI_SITE__ = siteId;
  window.__AI_SELECTORS__ = siteId ? SITES[siteId] : null;
})();
