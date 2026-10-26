'use strict';
// reply-clean.js — keeps page chrome out of a captured AI reply.
//
// The three chat sites wrap each reply in things a person never sees as part of
// the answer: a screen-reader heading ("ChatGPT said:", "Gemini said", Claude's
// "Claude responded: <preview>"), Claude's extended-thinking summary, a relative
// timestamp ("just now"), a code block's language label ("Python") and Gemini's
// "Code output" label. Two layers keep them out:
//
//   1. DOM (preferred): EXCLUDE_SELECTORS lists the elements the read script in
//      automation.js skips when it reads a reply's text — screen-reader-only
//      text, the thinking disclosure, code-block headers, timestamps.
//   2. Text (backup): cleanReplyText() removes the same things from the text
//      when the DOM layer missed them (the site renamed a class). It only ever
//      touches the FIRST line (a heading) and the LAST line (a timestamp), plus
//      two narrow Claude/Gemini patterns — never words in the middle of a reply,
//      so a reply that mentions "ChatGPT said" mid-text is kept as written.
//
// Pure functions, no app state — unit-tested in test/reply-clean.test.js and run
// against real Chromium in test/browser.test.js.

// Elements never part of the reply's words. Every selector here is scoped to the
// descendants of the node being read (the read script runs querySelectorAll on
// it), so it can never hide the reply node itself.
const COMMON_EXCLUDE = [
  // screen-reader-only text: "ChatGPT said:", "Gemini said", "Claude responded: …"
  '.sr-only', '.visually-hidden', '.screen-reader-only', '.cdk-visually-hidden', '.a11y-hidden',
  // relative timestamps ("just now", "2 minutes ago") — markdown never makes a <time>
  'time',
];
const SITE_EXCLUDE = {
  chatgpt: [],
  claude: [
    // the extended-thinking / "thought process" disclosure above the answer
    '[data-testid*="thinking" i]',
    '[class*="thinking-block" i]',
    '[class*="thinking-summary" i]',
    '[aria-label*="thought process" i]',
    '[aria-label*="thinking" i]',
  ],
  gemini: [
    // the bar above a code block that holds its language label + copy button
    '.code-block-decoration',
    '[class*="code-block-decoration"]',
    // the "Code output" label above an executed code result
    '.code-execution-result-header',
    '[class*="execution-result-header" i]',
  ],
  generic: [],
};
// Code-block headers on any site.
const CODE_HEADER_EXCLUDE = ['[class*="code-block-header" i]', '[class*="codeblock-header" i]'];

function excludeSelectorsFor(site) {
  const own = SITE_EXCLUDE[site] || SITE_EXCLUDE.generic;
  return [...COMMON_EXCLUDE, ...own, ...CODE_HEADER_EXCLUDE];
}

// ── text backup ─────────────────────────────────────────────────────────────

// A whole line that is only a relative time ("just now", "5 minutes ago", "1h ago").
const RELATIVE_TIME_LINE = /^[ \t]*(?:just now|yesterday|(?:a|an|\d{1,3})[ \t]*(?:s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|wk|weeks?|mo|months?|y|yr|years?)[ \t]+ago)[ \t]*$/i;

// Code-block language labels Gemini glues to the first line of the code.
// (Short or word-like names — Go, Java, Text — are left out: "Gotcha = 1" is prose.)
const CODE_LABELS = ['Python', 'JavaScript', 'TypeScript', 'JSON', 'Bash', 'Shell', 'HTML', 'CSS', 'SQL', 'C\\+\\+', 'Rust', 'Ruby', 'PHP', 'Kotlin', 'Swift', 'YAML', 'XML', 'Plaintext'];
// "Pythontoken = …": the label, then code that starts with a lowercase identifier
// followed straight away by an assignment / call / index / block.
const GLUED_LABEL_RE = new RegExp('^(' + CODE_LABELS.join('|') + ')(?=[a-z_$][\\w$.]*\\s*(?:=|\\(|\\[|\\{))', '');

function stripLeadingHeading(site, s) {
  // ChatGPT: a first line that is exactly "ChatGPT said:" (the sr-only <h5>/<h6>).
  if (site === 'chatgpt' || site === 'generic') {
    const m = /^\s*ChatGPT said:[ \t]*(?:\r?\n|$)/.exec(s);
    if (m) return s.slice(m[0].length);
  }
  // Claude: "Claude responded: <a preview of the reply>" — that whole first line
  // is the sr-only summary; the real reply follows on the next lines.
  if (site === 'claude' || site === 'generic') {
    const m = /^\s*Claude (?:responded|said):[^\n]*(?:\r?\n|$)/.exec(s);
    if (m && s.slice(m[0].length).trim()) return s.slice(m[0].length);
  }
  // Gemini: "Gemini said" — inline, often with a leading space and no colon
  // (" Gemini said L8E8GE-…"). Stripped only when it carries a sign of being the
  // hidden heading — leading whitespace, a colon or a line break after it — so a
  // reply that genuinely starts "Gemini said that…" is left alone.
  if (site === 'gemini' || site === 'generic') {
    const m = /^(\s*)Gemini said(:?)([ \t]*)(\r?\n)?/.exec(s);
    if (m && (m[1].length > 0 || m[2] || m[4])) {
      const rest = s.slice(m[0].length);
      if (rest.trim()) return rest;
    }
  }
  return s;
}

// Claude's thinking summary, read as text: the same short line twice in a row at
// the very top ("Reversing the given character string." ×2 — the collapsed button
// and its live label), followed by a blank line and the real answer.
function stripClaudeThinkingEcho(s) {
  const m = /^[ \t]*([^\n]{6,200}?)[ \t]*\r?\n[ \t]*\1[ \t]*\r?\n[ \t]*\r?\n/.exec(s);
  if (!m) return s;
  const line = m[1];
  if (/\[\s*(?:TO|FROM)\s*:/i.test(line)) return s; // an envelope line is never a summary
  const rest = s.slice(m[0].length);
  return rest.trim() ? rest : s;
}

function stripTrailingTimestamp(s) {
  const lines = s.split('\n');
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  if (end > 1 && RELATIVE_TIME_LINE.test(lines[end - 1])) {
    const kept = lines.slice(0, end - 1);
    if (kept.join('\n').trim()) return kept.join('\n').replace(/\s+$/, '');
  }
  return s;
}

function separateGeminiLabels(s) {
  return s.split('\n').map((line) => {
    // "Code outputDFROYU-…" → "Code output" on its own line
    let l = line.replace(/^([ \t]*)Code output(?=\S)/, '$1Code output\n');
    l = l.replace(GLUED_LABEL_RE, '$1\n');
    return l;
  }).join('\n');
}

// Clean one captured reply. Returns the text unchanged unless a pattern matched.
function cleanReplyText(site, text) {
  const orig = String(text == null ? '' : text);
  if (!orig.trim()) return orig;
  let s = orig;
  try {
    s = stripLeadingHeading(site, s);
    if (site === 'claude') s = stripClaudeThinkingEcho(s);
    s = stripTrailingTimestamp(s);
    if (site === 'gemini') s = separateGeminiLabels(s);
    if (s === orig) return orig;
    s = s.replace(/^\s*\n/, '').replace(/^[ \t]+(?=\S)/, '').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
    return s.trim() ? s : orig;
  } catch (_) {
    return orig; // never lose a reply over a cleaning problem
  }
}

module.exports = { cleanReplyText, excludeSelectorsFor, COMMON_EXCLUDE, SITE_EXCLUDE, RELATIVE_TIME_LINE };
