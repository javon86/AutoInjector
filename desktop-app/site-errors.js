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

// The sites' short canned refusals (PR #120, log 2026-11-04: Gemini answered two
// ~56,000-character Akọwe editor prompts with "I'm having a hard time fulfilling
// your request. Can I help you with something else instead?" and it was taken as
// the answer). A refusal is never what Akọwe asked for: it is a site problem —
// wait, or use another AI. Only for SHORT replies (REFUSAL_MAX_CHARS) so a real
// answer that merely contains the words is never caught.
const REFUSAL_MAX_CHARS = 300;
const REFUSAL_RES = [
  /\bhaving a hard time fulfilling (?:your|this|that) request\b/i,             // Gemini
  /\bcan i help you with something else(?: instead)?\s*\?/i,                   // Gemini
  /\b(?:i'm|i am|i’m) (?:just |only )?a (?:large )?language model,? (?:and|so) (?:i )?(?:can't|can’t|cannot|don't|don’t|am not able|am unable|have no)\b/i, // Gemini
  /\bas (?:i'm |i am |i’m )?(?:just |only )?a (?:large )?language model,? (?:i'm |i am |i’m |i )?(?:not able|unable|can't|can’t|cannot|don't|don’t)\b/i,
  /\b(?:not able|unable) to (?:help|assist)(?: you)? with (?:that|this),? (?:as|since|because) (?:i'm|i am|i’m) (?:only |just )?a (?:large )?language model\b/i,
  /\b(?:i'm|i am|i’m) a text-based ai,? and (?:that|this) is outside (?:of )?my capabilities\b/i, // Gemini
  /^(?:i'm |i am |i’m )?(?:so )?sorry,? (?:but )?i (?:can't|can’t|cannot|won't|won’t) (?:help|assist)(?: you)? with (?:that|this)(?: request)?[.!]?$/i, // ChatGPT
  /^(?:i'm |i am |i’m )?(?:not able|unable) to (?:help|assist|comply)(?: you)? with (?:that|this)(?: request)?[.!]?$/i,
  /^i (?:can't|can’t|cannot) (?:help|assist)(?: you)? with (?:that|this)(?: request)?[.!]?$/i
];
// The site turned the message down because it is too long (ChatGPT "The message you
// submitted was too long…", Claude "Your message will exceed the length limit…").
const TOO_LONG_RES = [
  /\bmessage (?:you submitted )?(?:was|is) too long\b/i,
  /\bexceed(?:s|ed)? the (?:length|context|character) limit\b/i,
  /\b(?:prompt|input|message) is too long\b/i
];

// The site says the CONVERSATION is full (not just this one message): Claude "Your
// message will exceed the length limit for this chat… start a new chat", ChatGPT
// "You've reached the maximum length for this conversation… start a new chat",
// Gemini "This conversation is too long". The fix is a fresh chat (main.js opens one
// before the next Akọwe prompt to that AI), not a shorter prompt or another AI.
const CHAT_FULL_RES = [
  /\blength limit for this (?:chat|conversation|thread)\b/i,
  /\bmaximum (?:length|context|size) (?:for|of) this (?:chat|conversation|thread)\b/i,
  /\b(?:chat|conversation|thread) (?:is|has gotten|has become|got|has grown) too long\b/i,
  /\b(?:reached|hit|exceeded) the (?:maximum |max )?(?:chat|conversation|thread) (?:length|size|limit)\b/i,
  /\b(?:chat|conversation) (?:length )?limit (?:reached|exceeded)\b/i
];
// "…start a new chat" only counts together with a word about the chat being full.
const NEW_CHAT_RE = /\b(?:start(?:ing)?|open(?:ing)?|begin(?:ning)?|creat(?:e|ing)) a new (?:chat|conversation|thread)\b/i;
const FULL_WORD_RE = /\b(?:limit|too long|maximum|max length|full|longer than)\b/i;
function chatFull(t) { return CHAT_FULL_RES.some((re) => re.test(t)); }

// A reply the AI wrote for Akọwe / the relay carries its data or its tag.
function carriesData(text) {
  if (/\[\s*FROM:\s*[^\]\r\n]{1,40}\]/i.test(text)) return true; // the AI's own reply tag
  if (/\{[\s\S]*\}/.test(text)) return true;                       // a JSON object
  if (/\[[\s\S]*[:"][\s\S]*\]/.test(text) && !/^\s*\[\s*TO:/i.test(text)) return true; // a JSON list
  return false;
}

// null, or { kind: 'chat-full' | 'rate-limit' | 'error' | 'refused' | 'too-long' } when `text` is
// the site's own short error notice or canned refusal (never a real answer).
function siteErrorOf(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t || t.length >= MAX_CHARS) return null;
  if (carriesData(t)) return null;
  if (chatFull(t)) return { kind: 'chat-full' };
  if (RATE_LIMIT_RES.some((re) => re.test(t))) return { kind: 'rate-limit' };
  if (NEW_CHAT_RE.test(t) && FULL_WORD_RE.test(t)) return { kind: 'chat-full' };
  if (TOO_LONG_RES.some((re) => re.test(t))) return { kind: 'too-long' };
  // a leading [TO: …] tag (the AI's own envelope) does not count for a refusal
  const bare = t.replace(/^\s*\[\s*TO\s*:[^\]\r\n]{0,40}\]\s*/i, '').trim();
  if (bare.length < REFUSAL_MAX_CHARS && REFUSAL_RES.some((re) => re.test(bare))) return { kind: 'refused' };
  if (ERROR_RES.some((re) => re.test(t))) return { kind: 'error' };
  return null;
}
// A prompt this long (characters) is named when a site refuses it: very long
// prompts are a likely reason (Gemini refused 56,000-character editor prompts).
const LONG_PROMPT_CHARS = 30000;
function longPromptNote(label, kind, promptChars) {
  const n = Number(promptChars) || 0;
  if ((kind !== 'refused' && kind !== 'too-long') || n < LONG_PROMPT_CHARS) return '';
  return ` — the prompt was very long (${n.toLocaleString('en-US')} characters); ${label || 'the AI'} may refuse prompts that long, so a shorter prompt or another AI may work better`;
}

// How long Akọwe should wait before asking that site again (seconds, a hint; it
// doubles on each retry on Akọwe's side: 30 s, 60 s, 120 s).
// A full chat is fixed by the fresh chat AutoInjector opens before the next prompt: ask again soon.
function retryAfterSeconds(kind) { return kind === 'rate-limit' ? 60 : kind === 'chat-full' ? 10 : 30; }

// Plain words for the activity feed / log.
function describeSiteError(label, kind, promptChars) {
  const L = label || 'The AI';
  const tail = longPromptNote(label, kind, promptChars);
  if (kind === 'rate-limit') return `${L} showed a usage-limit message instead of an answer — waiting and trying again (or another AI)`;
  if (kind === 'refused') return `${L} answered with a short refusal ("I can't help with that") instead of an answer — waiting and trying again, or another AI${tail}`;
  if (kind === 'chat-full') return `${L} said its chat is full ("too long — start a new chat") — AutoInjector starts a fresh ${L} chat before the next request`;
  if (kind === 'too-long') return `${L} said the message was too long — another AI, or a shorter prompt${tail}`;
  return `${L} showed an error message instead of an answer — waiting and trying again`;
}

module.exports = { CHAT_FULL_RES, siteErrorOf, retryAfterSeconds, describeSiteError, longPromptNote, MAX_CHARS, REFUSAL_MAX_CHARS, LONG_PROMPT_CHARS };
