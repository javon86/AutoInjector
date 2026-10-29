// selectors.js — shared DOM selector candidates per AI site (CommonJS; used by the
// Electron main process to build page-injection scripts). Kept in sync by hand with
// AutoInjector/extension/selectors.js, which serves the same purpose for the browser
// extension. Sites can change their DOM at any time — these are best-effort, with
// fallbacks — so this is the first file to check if injection stops working.
module.exports = {
  chatgpt: {
    label: "ChatGPT",
    home: "https://chatgpt.com",
    newChat: "https://chatgpt.com/",
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
    // While a reply is streaming, the Send button is replaced by a Stop button.
    // A visible Stop button is the site's own "still generating" signal — when it
    // disappears (Send returns), the model is done speaking. Best-effort/fallback
    // like every list here: if none match, completion falls back to the tag/timer.
    STOP_CANDIDATES: [
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="stop"]'
    ],
    ASSISTANT_CANDIDATES: [
      '[data-testid="assistant-message"]',
      'div[data-message-author-role="assistant"]',
      'article:has([data-message-author-role="assistant"])'
    ],
    // ChatGPT's own image generation (chatgpt-image.js): the finished picture in the
    // newest assistant turn. Best-effort like every list here — avatars, icons and
    // anything under 200 px are filtered out by the reader, and the 🎯 picker's
    // "Generated picture" item saves a better one if ChatGPT changes its page.
    IMAGE_CANDIDATES: [
      '[data-message-author-role="assistant"] img',
      'article[data-turn="assistant"] img',
      '[class*="imagegen"] img',
      'img[alt*="Generated image" i]',
      '[data-testid*="image-gen"] img'
    ],
    // Best-effort/unverified, same as every other candidate list in this
    // file — used to deliver a real file into the chat via the CDP-based
    // attach flow in main.js's attachFileToSite(). Fix via the 🔍 Inspect
    // button on the live pane if these ever stop matching.
    FILE_INPUT_CANDIDATES: [
      'input[type="file"]',
      'input[data-testid="file-upload-input"]',
      'form input[type="file"]'
    ],
    // Best-effort/unverified, same caveat as every other candidate list in
    // this file -- ChatGPT's login is Auth0-hosted and typically multi-step
    // (email first, password on a following screen), so these are tried
    // against whatever's actually on screen at the moment of a login-fill
    // click, not assumed to both be present at once. See buildLoginFillScript()
    // in automation.js.
    LOGIN_USERNAME_CANDIDATES: [
      'input[type="email"]',
      'input[name="username"]',
      'input[id="email-input"]',
      'input[type="text"]'
    ],
    LOGIN_PASSWORD_CANDIDATES: [
      'input[type="password"]',
      'input[name="password"]'
    ],
    LOGIN_SUBMIT_CANDIDATES: [
      'button[type="submit"]',
      'button[name="action"]',
      'button[data-action-button-primary="true"]'
    ]
  },
  claude: {
    label: "Claude",
    home: "https://claude.ai/new",
    newChat: "https://claude.ai/new",
    // Claude's page since 2026-10-29 (PC log: the user's 🎯 picks matched exactly
    // one each): the composer is div[data-cds="Editor"] (contenteditable itself)
    // and Send is button[data-testid="chat-input-send"]. The older ones stay as
    // fallbacks.
    INPUT_CANDIDATES: [
      'div[data-cds="Editor"][contenteditable="true"]',
      'div[data-cds="Editor"]',
      '[data-cds="Editor"] [contenteditable="true"]',
      'div[contenteditable="true"][data-testid]',
      'div[contenteditable="true"].ProseMirror',
      'div[contenteditable="true"][class*="composer"]',
      'div[contenteditable="true"][placeholder]',
      'div[contenteditable="true"]',
      "textarea"
    ],
    SEND_CANDIDATES: [
      'button[data-testid="chat-input-send"]',
      'button[aria-label="Send Message"]',
      'button[aria-label="Send message"]',
      'button[data-testid="send-message-button"]',
      'form button[type="submit"]'
    ],
    STOP_CANDIDATES: [
      'button[data-testid="chat-input-stop"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="stop"]',
      'button[data-testid="stop-button"]'
    ],
    // Claude's page since 2026-10-29: every message — yours AND Claude's — is a
    // div[data-testid="transcript-row"] with a visually-hidden heading
    // (h3[data-find-omitted]) and its text in div[data-cds="Prose"]. A selector
    // can't tell the two apart, so the reader works per ROW (transcript-rows.js):
    // it decides who wrote each row and reads Claude's latest row after your
    // latest one. When no row selector matches, rows are found from the hidden
    // "You said" / "Claude said" headings instead.
    ROW_CANDIDATES: [
      'div[data-testid="transcript-row"]',
      '[data-testid="transcript-row"]',
      '[data-testid^="transcript-row"]'
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
    ],
    FILE_INPUT_CANDIDATES: [
      'input[type="file"]',
      'input[data-testid="file-upload"]',
      'form input[type="file"]'
    ],
    // Best-effort/unverified. Claude's login also tends to be multi-step
    // (email, then password or a magic-link/SSO choice) -- see the note on
    // ChatGPT's list above, same reasoning applies here.
    LOGIN_USERNAME_CANDIDATES: [
      'input[type="email"]',
      'input[name="email"]'
    ],
    LOGIN_PASSWORD_CANDIDATES: [
      'input[type="password"]',
      'input[name="password"]'
    ],
    LOGIN_SUBMIT_CANDIDATES: [
      'button[type="submit"]',
      "form button"
    ]
  },
  gemini: {
    label: "Gemini",
    home: "https://gemini.google.com/app",
    newChat: "https://gemini.google.com/app",
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
    STOP_CANDIDATES: [
      'button[aria-label*="Stop"]',
      'button[aria-label*="stop"]',
      "button.stop",
      'button.send-button.stop'
    ],
    ASSISTANT_CANDIDATES: [
      "message-content .markdown",
      "div.model-response-text",
      "div[data-response-index]"
    ],
    FILE_INPUT_CANDIDATES: [
      'input[type="file"]',
      'input[name="Filedata"]',
      'form input[type="file"]'
    ],
    // Best-effort/unverified. Gemini's login goes through accounts.google.com,
    // which is notoriously multi-step (email on one screen, password on the
    // next, both with somewhat obfuscated markup) -- these candidates target
    // Google's known, long-stable field/button ids where possible.
    LOGIN_USERNAME_CANDIDATES: [
      "#identifierId",
      'input[type="email"]',
      'input[name="identifier"]'
    ],
    LOGIN_PASSWORD_CANDIDATES: [
      'input[type="password"]',
      'input[name="Passwd"]',
      'input[name="password"]'
    ],
    LOGIN_SUBMIT_CANDIDATES: [
      "#identifierNext button",
      "#passwordNext button",
      'button[type="submit"]',
      'div[role="button"][id*="Next"]'
    ]
  }
};
