'use strict';
// site-errors.js — tells a chat site's OWN error message apart from a real answer.
//
// When ChatGPT, Claude or Gemini have a short outage they show a message in the
// reply spot instead of an answer: "Sorry, something went wrong. Please try your
// request again." (Gemini), "I seem to be encountering an error…", "Something went
// wrong. If this issue persists…" (ChatGPT), "There was an error generating a
// response", "Network error", "Claude will return soon", "overloaded", usage /
// rate limits. Taken as an answer, it burns Akọwe's retries in a minute (a real
// log: three Gemini error messages in a row for one 54k-character prompt, each
// sent back as "OK, 60 characters"). siteErrorOf() spots them so the Akọwe bridge
// can report "the site had a temporary problem — wait and try again" instead.
//
// Narrow on purpose, so a real answer is never thrown away:
//   * only SHORT replies (under MAX_CHARS) — an error notice is a sentence or two;
//   * never a reply that carries the expected data: a JSON object / list (what
//     Akọwe asks for) or a [FROM: …] reply tag the AI wrote itself;
//   * only well-known wordings of the sites' error notices.
// Pure functions, no app state — unit-tested in test/site-errors.test.js.

const MAX_CHARS = 400;

// Usage / rate limits (same idea as main.js RATE_LIMIT_PATTERNS).
const RATE_LIMIT_RES = [
  /rate limit/i,
  /usage limit/i,
  /quota exceeded/i,
  /reached your (current |daily |hourly )?(usage |message )?limit/i,
  /too many requests/i,
  /out of (free )?messages/i,
  /message limit/i
];
// The sites' own "it broke" notices.
const ERROR_RES = [
  /\bsomething went wrong\b/i,                                   // all three ("Sorry, something went wrong…", ChatGPT, Claude)
  /\bsomething seems to have gone wrong\b/i,                     // ChatGPT "Hmm...something seems to have gone wrong."
  /\b(?:i|i'm|i am)\s+(?:seem to be\s+)?(?:encountering|encountered|running into|ran into|having)\s+(?:an?\s+|some\s+)?(?:error|errors|issue|issues|problem|problems|trouble)\b/i, // Gemini
  /\bthere was an error (?:generating|while generating|processing|in) /i, // ChatGPT
  /\berror (?:generating|in) (?:a |the )?(?:response|message stream|body stream)\b/i,
  /\bnetwork error\b/i,
  /\bconnection (?:error|lost|failed|interrupted)\b/i,
  /\bclaude will return soon\b/i,
  /\b(?:is|are|currently|temporarily|been)\s+overloaded\b/i,      // Claude "Claude is currently overloaded"
  /\boverloaded_error\b/i,
  /\b(?:at|over) capacity\b/i,
  /\bcapacity constraints\b/i,                                 // Claude "Due to unexpected capacity constraints…"
  /\bis unable to respond\b/i,
  /\btemporarily (?:unavailable|blocked)\b/i,
  /\bplease try (?:your request |again )?(?:again )?later\b/i,
  /\bunexpected error\b/i,
  /\binternal server error\b/i,
  /\bservice (?:is )?unavailable\b/i,
  /\brequest (?:failed|timed out)\b/i,
  /\bunable to (?:load|reach|connect|generate)\b/i
];

// A reply the AI wrote for Akọwe / the relay carries its data or its tag.
function carriesData(text) {
  if (/\[\s*FROM:\s*[^\]\r\n]{1,40}\]/i.test(text)) return true; // the AI's own reply tag
  if (/\{[\s\S]*\}/.test(text)) return true;                       // a JSON object
  if (/\[[\s\S]*[:"][\s\S]*\]/.test(text) && !/^\s*\[\s*TO:/i.test(text)) return true; // a JSON list
  return false;
}

// null, or { kind: 'rate-limit' | 'error' } when `text` is the site's own short
// error notice (never a real answer).
function siteErrorOf(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t || t.length >= MAX_CHARS) return null;
  if (carriesData(t)) return null;
  if (RATE_LIMIT_RES.some((re) => re.test(t))) return { kind: 'rate-limit' };
  if (ERROR_RES.some((re) => re.test(t))) return { kind: 'error' };
  return null;
}

// How long Akọwe should wait before asking that site again (seconds, a hint; it
// doubles on each retry on Akọwe's side: 30 s, 60 s, 120 s).
function retryAfterSeconds(kind) { return kind === 'rate-limit' ? 60 : 30; }

// Plain words for the activity feed / log.
function describeSiteError(label, kind) {
  const L = label || 'The AI';
  return kind === 'rate-limit'
    ? `${L} showed a usage-limit message instead of an answer — waiting and trying again (or another AI)`
    : `${L} showed an error message instead of an answer — waiting and trying again`;
}

module.exports = { siteErrorOf, retryAfterSeconds, describeSiteError, MAX_CHARS };
