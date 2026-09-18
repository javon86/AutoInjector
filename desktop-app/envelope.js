'use strict';
// envelope.js — the [TO:]/[FROM:] message-envelope parser, extracted from main.js
// so it can be unit-tested in isolation (main.js only runs inside the Electron
// harness). Pure string functions, no app state.
//
// The protocol: a baseline reply STARTS with a routing tag "[TO: X]" (who it's
// addressed to) and ENDS with a closing tag "[FROM: <who>]" whose PRESENCE is the
// completion signal. This module recognizes, validates and strips both.

// Recognized [TO:] destinations: the three web AIs, the special ALL/USER/NONE,
// and BUTLER — the local supervisor (see main.js's [TO: BUTLER] delivery path).
// A missing/unrecognized tag defaults to USER (Rule 1).
// E06: tolerate a stray space before the colon ("[TO : X]") — a real parse-miss
// the audit hit — as well as the usual bracket/space slack.
const ROUNDTABLE_TAG_RE = /^\s*\[\s*TO\s*:\s*(GEMINI|CHATGPT|CLAUDE|BUTLER|ALL|USER|NONE)\s*\]\s*/i;
function parseRoundtableTag(text) {
  const m = ROUNDTABLE_TAG_RE.exec(text);
  if (!m) return { tag: "USER", body: text }; // Rule 1: a missing tag defaults to the user
  return { tag: m[1].toUpperCase(), body: text.slice(m[0].length) };
}

// End-tag protocol: every baseline reply must close with [FROM: <who>]. Its
// PRESENCE is the completion signal — the moment it appears the AI has finished.
// The sender NAME is matched LOOSELY (we already know which pane it is, so any
// short label counts), and a short trailing tail after the tag (a sign-off, a
// period) is tolerated — otherwise very common real outputs would be dropped.
// We take the LAST tag that qualifies as the terminator, so a [FROM:] quoted
// MID-reply doesn't prematurely complete the message. parseEndTag() strips it so
// the marker never reaches the transcript, a routed message, or a PDF.
const END_TAG_RE = /\[\s*FROM\s*:\s*([^\]\r\n]{1,40}?)\s*\]/gi;
const END_TAG_MAX_TAIL = 40; // chars allowed after the closing tag (a brief sign-off / punctuation) before it's judged "still has content"
function findEndTag(text) {
  const s = String(text || "");
  let last = null, m;
  END_TAG_RE.lastIndex = 0;
  while ((m = END_TAG_RE.exec(s))) {
    // E04: a genuine terminator is not an inline quoted/fenced EXAMPLE. Skip a
    // [FROM: X] whose immediately-preceding non-space character is a quote or a
    // backtick ("[FROM: X]" / `[FROM: X]`) — that's a literal example, e.g.
    // Example: "[FROM: CHATGPT]" — and skip one with a code fence still ahead in
    // its tail (the reply continues inside/after a code block). Then take the LAST
    // tag that actually qualifies, so a quoted example never truncates real text.
    const before = s.slice(0, m.index).replace(/[ \t]*$/, "");
    const prev = before.slice(-1);
    if (prev === '"' || prev === "'" || prev === "`") continue;
    const tail = s.slice(m.index + m[0].length);
    if (tail.length > END_TAG_MAX_TAIL || /\n\s*\n/.test(tail)) continue; // real content after → not the close
    if (tail.indexOf("```") !== -1) continue; // a closing code fence still ahead → the tag was inside code
    last = m;
  }
  if (!last) return null;
  return { index: last.index, from: (last[1] || "").trim().toUpperCase() };
}
function hasEndTag(text) { return !!findEndTag(text); }
function parseEndTag(text) {
  const s = String(text || "");
  const f = findEndTag(s);
  if (!f) return { from: null, body: s };
  return { from: f.from, body: s.slice(0, f.index).replace(/\s+$/, "") };
}

// "NONE" is a complete "nothing to add" signal that stands on its own — it needs
// no [FROM:] closing tag. Recognize it whether written bare ("NONE"), bracketed
// ("[NONE]"), formatted ("**NONE**"), or as the routing tag ("[TO: NONE]"). Only
// a reply whose ENTIRE content is NONE counts — "None of this works" is real.
function isNoneSkip(text) {
  const s = String(text || "");
  if (parseRoundtableTag(s).tag === "NONE") return true;
  const body = parseEndTag(parseRoundtableTag(s).body).body;
  return body.replace(/[^a-z]/gi, "").toUpperCase() === "NONE";
}

// Strip the [TO:]/[FROM:] envelope from a stored raw reply — for the few places
// that forward or display raw captured text.
function stripEnvelope(text) {
  return parseEndTag(parseRoundtableTag(String(text || "")).body).body;
}

module.exports = {
  ROUNDTABLE_TAG_RE, END_TAG_RE, END_TAG_MAX_TAIL,
  parseRoundtableTag, findEndTag, hasEndTag, parseEndTag, isNoneSkip, stripEnvelope,
};
