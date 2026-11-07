'use strict';
// test/voice-read.test.js — the plain helpers behind 🎤 / 🔊 (voice-read.js): what is said aloud from an AI reply
// (no markdown marks, code blocks -> "(code block)", links -> "a link to example.com", no routing tags), short
// pieces so Stop is instant, previews, one AI's reply list from the conversation, and a different voice per
// speaker from the voices a PC has. Run: node test/voice-read.test.js
const VR = require('../voice-read');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

console.log('\n== cleanForSpeech ==');
const md = [
  '[MSG #0012]',
  '[TO: Claude]',
  '# The plan',
  'Here is **the plan** and *why* it _works_ — see [the docs](https://docs.example.com/x?y=1).',
  '- first step',
  '* second step',
  '1. numbered',
  '> a quote',
  '```python',
  'print("hello")',
  'for i in range(3): pass',
  '```',
  'Visit https://www.example.org/very/long/path?with=query and `npm ci` then `const reallyLongInlineCodeThatGoesOnAndOn = somethingElse()`.',
  '| Name | Age |',
  '|------|-----|',
  '| Ann  | 3   |',
  '---',
  '![a cat](cat.png)',
  '[FROM: ChatGPT]',
].join('\n');
const c = VR.cleanForSpeech(md);
assert(!/\[MSG|\[TO:|\[FROM:/.test(c), 'routing tags gone');
assert(!/[*#`|>]/.test(c.replace(/\(code block\)/g, '')), `no markdown marks left ("${c.replace(/\n/g, ' / ').slice(0, 160)}…")`);
assert(/\(code block\)/.test(c) && !/print\(/.test(c), 'a code block becomes "(code block)"');
assert(/a link to example\.org/.test(c) && !/https?:/.test(c), 'bare links become "a link to example.org"');
assert(/see the docs\./.test(c), 'markdown links keep their words');
assert(/npm ci/.test(c) && /\(code\)/.test(c), 'short inline code is read, long inline code becomes "(code)"');
assert(/Ann, 3\./.test(c) && !/---/.test(c), 'table rows read as "Ann, 3."');
assert(/\(picture: a cat\)/.test(c), 'pictures say what they show');
assert(/^The plan/m.test(c) && /^first step/m.test(c) && /^1\. numbered/m.test(c), 'headings / bullets keep their words');
assert(VR.cleanForSpeech('```\nonly code, never closed') === '(code block)', 'an unclosed code block too');
assert(VR.cleanForSpeech(null) === '' && VR.cleanForSpeech('') === '', 'empty in, empty out');

console.log('\n== chunkForSpeech ==');
const long = Array.from({ length: 30 }, (_, i) => `This is sentence number ${i + 1} of a long reply.`).join(' ');
const ch = VR.chunkForSpeech(long, 220);
assert(ch.length > 4 && ch.every((x) => x.length <= 220), `${ch.length} pieces, each ≤ 220 characters`);
assert(ch.join(' ') === long, 'nothing lost or reordered');
const run = 'word, '.repeat(200);
const rc = VR.chunkForSpeech(run, 100);
assert(rc.every((x) => x.length <= 101) && rc.join(' ').replace(/\s+/g, ' ').trim() === run.trim(), 'one huge sentence is cut at commas');
assert(VR.chunkForSpeech('Hi.\n\nThere!', 220).length === 2, 'paragraphs are separate pieces');
assert(VR.chunkForSpeech('', 220).length === 0, 'nothing -> no pieces');

console.log('\n== preview / replyList ==');
assert(VR.preview('**Hello** there, this is a long answer with many words', 5) === 'Hello there, this is a…', 'preview: first words, plain');
const tr = [
  { id: 1, site: 'claude', text: 'one' }, { id: 2, site: 'gemini', text: 'g' }, { id: 3, site: 'claude', text: 'limit', isRateLimited: true },
  { id: 4, site: 'claude', text: 'chat full', siteError: 'chat-full' }, { id: 5, site: 'claude', text: '  ' }, { id: 6, site: 'claude', text: 'two' },
];
const l = VR.replyList(tr, 'claude');
assert(l.length === 2 && l[0].id === 1 && l[1].id === 6 && l[1].n === 2 && l[1].preview === 'two', 'only real, non-empty replies of that AI, oldest first, numbered');
assert(VR.replyList(null, 'claude').length === 0, 'no transcript -> empty');

console.log('\n== a different voice per speaker ==');
const win = [
  { name: 'Microsoft David - English (United States)', lang: 'en-US', localService: true },
  { name: 'Microsoft Zira - English (United States)', lang: 'en-US', localService: true },
  { name: 'Microsoft Mark - English (United States)', lang: 'en-US', localService: true },
  { name: 'Microsoft George - English (United Kingdom)', lang: 'en-GB', localService: true },
  { name: 'Microsoft Hortense - French', lang: 'fr-FR', localService: true },
  { name: 'Google US English', lang: 'en-US', localService: false },
];
const p = VR.pickBrowserVoices(win);
assert(new Set(Object.values(p)).size === 4, `Windows' 4 English voices: one each (${JSON.stringify(p)})`);
assert(/George/.test(p.butler) && /Zira/.test(p.chatgpt) && /David/.test(p.claude) && /Mark/.test(p.gemini), 'Alfred British, ChatGPT Zira, Claude David, Gemini Mark');
assert(!Object.values(p).some((n) => /Hortense|Google/.test(n)), 'never a French voice or an online one when local English ones exist');
const two = VR.pickBrowserVoices(win.slice(0, 2));
assert(Object.values(two).every(Boolean) && new Set(Object.values(two)).size === 2, 'only two voices: shared, but everyone has one');
const none = VR.pickBrowserVoices([]);
assert(Object.values(none).every((v) => v === ''), 'no voices: empty names (the page then uses the default)');
const pv = VR.defaultPiperVoices(['en_US-lessac-medium']);
assert(Object.values(pv).every((v) => v === 'en_US-lessac-medium'), 'one piper voice: everyone uses it');
const pv2 = VR.defaultPiperVoices(['en_US-lessac-medium', 'en_GB-alan-medium', 'en_US-ryan-high', 'en_US-amy-medium']);
assert(new Set(Object.values(pv2)).size === 4 && pv2.butler === 'en_GB-alan-medium' && pv2.chatgpt === 'en_US-lessac-medium', `four piper voices: one each (${JSON.stringify(pv2)})`);
assert(VR.STYLE.butler.pitch !== VR.STYLE.gemini.pitch, 'each speaker also has its own pitch / pace');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
