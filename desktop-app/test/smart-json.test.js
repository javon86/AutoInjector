'use strict';
// test/smart-json.test.js — JSON out of an AI's reply when the chat site showed its
// quotes as curly ones (PC test 2026-10-28: Claude's site renders " as “ ”, and the
// connection test failed 3 of 3 times with "no JSON object found").
// Run: node test/smart-json.test.js
const S = require('../smart-json');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\n== curly quotes the way Claude\'s site shows them ==');
const claude = '{\u201Cok\u201D: true, \u201Csite\u201D: \u201Cclaude\u201D, \u201Cword\u201D: \u201Charbor\u201D}';
assert(claude.length === 48, `the reply from the PC test is 48 characters — the whole answer, not a cut-off one (${claude.length})`);
let r = S.parseJsonLenient(claude);
assert(r.ok && eq(r.value, { ok: true, site: 'claude', word: 'harbor' }) && r.repaired === 'smart-quotes', `read, and marked as repaired (${JSON.stringify(r)})`);
r = S.parseJsonLenient('{\u2018ok\u2019: true, \u2018word\u2019: \u2018maple\u2019}');
assert(r.ok && eq(r.value, { ok: true, word: 'maple' }), 'curly single quotes as the string marks are read too');
r = S.parseJsonLenient('{\u201Cn\u201D:\u00A0\u22125, \u201Cs\u201D: \u201Ca \u2212 b\u201D}');
assert(r.ok && r.value.n === -5 && r.value.s === 'a \u2212 b', 'a non-breaking space and a real minus sign between the values are fixed; a minus sign inside the words is kept');
r = S.parseJsonLenient('{\u201Cs\u201D: \u201Cline one\nline two\u201D}');
assert(r.ok && r.value.s === 'line one\nline two', 'a line break inside a string (the page shows one) is kept as \\n');
r = S.parseJsonLenient('{\u201Ca\u201D: 1, \u201Cb\u201D: [1, 2,],}');
assert(r.ok && eq(r.value, { a: 1, b: [1, 2] }), 'a trailing comma on top of the curly quotes is forgiven');

console.log('\n== never corrupts curly quotes that are part of the words ==');
const valid = '{"title": "The \u201Cbest\u201D day", "note": "it\u2019s fine"}';
r = S.parseJsonLenient(valid);
assert(r.ok && r.repaired === false && r.value.title === 'The \u201Cbest\u201D day' && r.value.note === 'it\u2019s fine', 'valid JSON is read as it is: “best” and it’s stay curly');
r = S.parseJsonLenient('{\u201Ctitle\u201D: \u201CThe \u201Cbest\u201D day, it\u2019s\u201D}');
assert(r.ok && r.value.title === 'The \u201Cbest\u201D day, it\u2019s', `curly marks AND curly quotes in the words: only the marks change (${JSON.stringify(r.value)})`);
r = S.parseJsonLenient('{\u201Cq\u201D: \u201Cshe said "hi" twice\u201D}');
assert(r.ok && r.value.q === 'she said "hi" twice', 'a straight quote inside curly-marked words is kept as a quote');

console.log('\n== what is not JSON stays not JSON ==');
for (const bad of ['', 'not json', 'Here is the word: harbor', '{ok: true}', '\u201Cjust words\u201D and more']) {
  const x = S.parseJsonLenient(bad);
  assert(!x.ok || typeof x.value !== 'object', `"${bad}" -> no object`);
}
assert(S.tryParseJson('nope', 'fallback') === 'fallback' && eq(S.tryParseJson(claude), { ok: true, site: 'claude', word: 'harbor' }), 'tryParseJson: the value or the fallback, never a throw');

console.log('\n== helpers ==');
assert(S.hasSmartPunctuation(claude) && !S.hasSmartPunctuation('{"ok": true}'), 'hasSmartPunctuation');
assert(S.normalizeSmartPunctuation('\u201Chi\u201D \u2018x\u2019\u00A0y\u200B') === '"hi" \'x\' y', 'normalizeSmartPunctuation: straight quotes, plain spaces, no zero-width');
assert(S.replyExcerpt('a\n\nb\tc') === 'a b c', 'replyExcerpt: one line');
const long = 'x'.repeat(500);
assert(S.replyExcerpt(long, 50).length === 50 && S.replyExcerpt(long, 50).endsWith('\u2026'), 'replyExcerpt: cut with …');
assert(S.replyExcerpt('a\u0007b') === 'ab', 'replyExcerpt: control characters removed');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
