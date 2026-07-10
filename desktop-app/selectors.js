// selectors.js — shared DOM selector candidates per AI site (CommonJS; used by the
// Electron main process to build page-injection scripts). Kept in sync by hand with
// AutoInjector/extension/selectors.js, which serves the same purpose for the browser
// extension. Sites can change their DOM at any time — these are best-effort, with
// fallbacks — so this is the first file to check if injection stops working.
module.exports = {
  chatgpt: {
    label: "ChatGPT",
    home: "https://chatgpt.com",
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
    home: "https://claude.ai/new",
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
    home: "https://gemini.google.com/app",
    INPUT_CANDIDATES: [
      'rich-textarea div[contenteditable="true"]',
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
