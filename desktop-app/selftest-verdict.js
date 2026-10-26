'use strict';
// selftest-verdict.js — judges the reply to the connectivity self-test ("reverse
// this token"). Pulled out of main.js so it can be unit-tested.
//
// The test sends a fresh token and asks for it reversed. A real reply holds the
// reversed token and not the original; a reader that also picks up the user's
// own sent message holds both (SELECTOR_TOO_BROAD). One honest exception: an AI
// that RUNS CODE to do it (Gemini does) shows the original token inside its code
// (`token = "AUTOINJ-…"`) and the reversed one as the output. That is a good
// reply, not a too-broad reader — as long as the reversed token stands on its
// own and the original appears only inside the code, and nothing of the sent
// message itself was captured.

// The self-test prompt. The token stays LAST (tests and the log rely on that).
function selftestPrompt(token) {
  return `[AutoInjector connectivity test -- not a real task, no need to elaborate] Reverse the letters of this token in your head and reply with ONLY the reversed text as plain words, nothing else -- do not run code or use any tools, no code block, no punctuation, no explanation: ${token}`;
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Does the capture contain the sent message itself? Any run of 6 consecutive
// words of the prompt (the token removed) showing up in the capture says so.
function echoesPrompt(text, prompt, token) {
  if (!prompt) return false;
  const words = norm(String(prompt).split(token).join(' ')).split(' ').filter(Boolean);
  const hay = norm(text);
  const RUN = 6;
  if (words.length < RUN) return words.length > 0 && hay.includes(words.join(' '));
  for (let i = 0; i + RUN <= words.length; i++) {
    if (hay.includes(words.slice(i, i + RUN).join(' '))) return true;
  }
  return false;
}

// The reversed token as a word of its own — not glued to a label or other text.
function standsAlone(text, word) {
  const re = new RegExp('(^|[^A-Za-z0-9-])' + escapeRe(word) + '(?=$|[^A-Za-z0-9-])', 'm');
  return re.test(String(text || ''));
}

// Every occurrence of the original token is inside code: a ``` fenced block, or
// a line that reads as code — the token quoted ("…" / '…' / `…`) on a line with
// an assignment or a call.
function onlyInCode(text, token) {
  const lines = String(text || '').split('\n');
  let inFence = false, seen = 0;
  for (const line of lines) {
    if (/^\s*```/.test(line)) { inFence = !inFence; if (!line.includes(token)) continue; }
    if (!line.includes(token)) continue;
    seen++;
    if (inFence) continue;
    const quoted = new RegExp('["\'`]' + escapeRe(token) + '["\'`]').test(line);
    const codey = /[=(]/.test(line.replace(new RegExp('["\'`]' + escapeRe(token) + '["\'`]', 'g'), ''));
    if (!(quoted && codey)) return false;
  }
  return seen > 0;
}

// → null (nothing decisive yet), { ok: true [, ranCode] } or { ok: false, error, text }.
function classifySelftestReply(text, token, reversedToken, prompt) {
  const s = String(text || '');
  const hasReversed = s.includes(reversedToken);
  const hasOriginal = s.includes(token);
  if (hasReversed && hasOriginal) {
    if (!echoesPrompt(s, prompt, token) && standsAlone(s, reversedToken) && onlyInCode(s, token)) return { ok: true, ranCode: true };
    return { ok: false, error: 'SELECTOR_TOO_BROAD', text: s.slice(0, 200) };
  }
  if (hasReversed) return { ok: true };
  if (hasOriginal) return { ok: false, error: 'REPLY_ECHO', text: s.slice(0, 200) };
  return null;
}

module.exports = { selftestPrompt, classifySelftestReply, echoesPrompt, standsAlone, onlyInCode };
