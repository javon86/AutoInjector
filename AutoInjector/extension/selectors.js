// selectors.js â€” central DOM selectors (no exports; content script reads global)
window.__AI_SELECTORS__ = {
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
};
