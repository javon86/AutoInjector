'use strict';
// smart-json.js — read JSON (and tagged data) out of an AI's reply even when the
// chat site "prettified" its punctuation.
//
// Claude's website shows plain quotes as curly ones (“ ” and ‘ ’), and what the app
// reads off the page is what the site shows — so a reply that the AI wrote as
// {"ok": true} arrives as {“ok”: true}, which no JSON reader accepts. Sites also
// slip in non-breaking / thin spaces, zero-width characters and a real minus sign
// (−). PC test 2026-10-28: the connection test failed 3 of 3 times on Claude for
// exactly this reason.
//
// Strict first, always: JSON that already parses is returned untouched, so curly
// quotes INSIDE its string values ("the “best” day") are never changed. Only when
// strict parsing fails is the text repaired, and then carefully: a curly quote
// counts as a string's start or end only where JSON's structure needs one (a
// closing quote is followed by : , } ] or the end); any other curly quote is left
// as it is, as part of the words. A plain swap of every curly quote is tried last.
//
// Pure functions, no app state — test/smart-json.test.js.

const DOUBLE_QUOTES = new Set(['“', '”', '„', '‟', '″', '‶', '＂']); // “ ” „ ‟ ″ ‶ ＂
const SINGLE_QUOTES = new Set(['‘', '’', '‚', '‛', '′', '‵', '＇']); // ‘ ’ ‚ ‛ ′ ‵ ＇
const ZERO_WIDTH = new Set(['​', '‌', '‍', '⁠', '﻿', '­']);
const ODD_SPACES = /[   -   　]/;
const MINUS = new Set(['−', '‒', '–', '﹣', '－']); // − ‒ – ﹣ － (outside strings: a minus sign)

function isSpace(c) { return c === ' ' || c === '\n' || c === '\r' || c === '\t' || ODD_SPACES.test(c) || ZERO_WIDTH.has(c); }

// Does the text hold any of the punctuation this module repairs?
function hasSmartPunctuation(text) {
  const s = String(text == null ? '' : text);
  for (const c of s) if (DOUBLE_QUOTES.has(c) || SINGLE_QUOTES.has(c) || ZERO_WIDTH.has(c) || ODD_SPACES.test(c) || MINUS.has(c)) return true;
  return false;
}

// Structure-aware repair (see the header). Returns the repaired text.
function repairJsonText(text) {
  const s = String(text == null ? '' : text);
  const n = s.length;
  let out = '';
  let inStr = false;
  let kind = null; // 'd' (opened by a double quote) | 's' (opened by a single quote)
  const nextSolid = (i) => { let j = i; while (j < n && isSpace(s[j])) j++; return j; };
  for (let i = 0; i < n; i++) {
    const c = s[i];
    if (!inStr) {
      if (c === '"' || DOUBLE_QUOTES.has(c)) { inStr = true; kind = 'd'; out += '"'; }
      else if (c === "'" || SINGLE_QUOTES.has(c)) { inStr = true; kind = 's'; out += '"'; }
      else if (ZERO_WIDTH.has(c)) { /* dropped */ }
      else if (ODD_SPACES.test(c)) out += ' ';
      else if (MINUS.has(c)) out += '-';
      else out += c;
      continue;
    }
    if (c === '\\') { out += c + (i + 1 < n ? s[i + 1] : ''); i++; continue; }
    const closes = kind === 'd' ? (c === '"' || DOUBLE_QUOTES.has(c)) : (c === "'" || SINGLE_QUOTES.has(c));
    if (closes) {
      const j = nextSolid(i + 1);
      if (j >= n || s[j] === ':' || s[j] === ',' || s[j] === '}' || s[j] === ']') { inStr = false; kind = null; out += '"'; continue; }
      out += c === '"' ? '\\"' : c; // a quote that is part of the words
      continue;
    }
    if (c === '"') { out += '\\"'; continue; } // inside a single-quoted string
    if (c === '\n') { out += '\\n'; continue; }
    if (c === '\r') { out += '\\r'; continue; }
    if (c === '\t') { out += '\\t'; continue; }
    out += c;
  }
  return out;
}

// The blunt version: every curly double quote becomes ", odd spaces become spaces.
function swapSmartQuotes(text) {
  let out = '';
  for (const c of String(text == null ? '' : text)) {
    if (DOUBLE_QUOTES.has(c)) out += '"';
    else if (SINGLE_QUOTES.has(c)) out += "'";
    else if (ZERO_WIDTH.has(c)) continue;
    else if (ODD_SPACES.test(c)) out += ' ';
    else out += c;
  }
  return out;
}

// Plain-text version for tagged data and words ([TO: X], a check-in word, "quoted"
// tokens): curly quotes -> straight, odd spaces -> spaces, zero-width gone.
function normalizeSmartPunctuation(text) { return swapSmartQuotes(text); }

// JSON.parse with the repairs above as fallbacks. -> { ok: true, value, repaired } | { ok: false }
// repaired: false (it parsed as it was) | 'smart-quotes' (it needed the repair).
function parseJsonLenient(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return { ok: false };
  try { return { ok: true, value: JSON.parse(s), repaired: false }; } catch (_) {}
  if (!hasSmartPunctuation(s) && s.indexOf("'") === -1 && !/[\n\r\t]/.test(s)) return { ok: false };
  for (const fix of [repairJsonText, swapSmartQuotes]) {
    let t;
    try { t = fix(s); } catch (_) { continue; }
    if (t === s) continue;
    try { return { ok: true, value: JSON.parse(t), repaired: 'smart-quotes' }; } catch (_) {}
    // a trailing comma on top of it (a common slip)
    try { return { ok: true, value: JSON.parse(t.replace(/,\s*([}\]])/g, '$1')), repaired: 'smart-quotes' }; } catch (_) {}
  }
  return { ok: false };
}

// JSON.parse that never throws: the value, or `fallback` (default null).
function tryParseJson(text, fallback = null) {
  const r = parseJsonLenient(text);
  return r.ok ? r.value : fallback;
}

// A short, safe excerpt of what an AI wrote, for "Technical details": one line,
// control characters removed, at most `max` characters (with … when cut).
function replyExcerpt(text, max = 160) {
  const s = String(text == null ? '' : text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

module.exports = { parseJsonLenient, tryParseJson, repairJsonText, swapSmartQuotes, normalizeSmartPunctuation, hasSmartPunctuation, replyExcerpt, DOUBLE_QUOTES, SINGLE_QUOTES };
