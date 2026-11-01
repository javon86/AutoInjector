'use strict';
// test/site-errors.test.js — site-errors.js: a chat site's own short error notice is
// told apart from a real answer (never a long reply, a JSON answer or a tagged reply).
// Run with: node test/site-errors.test.js
const SE = require('../site-errors');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

console.log('\n== the notices from the user\'s log (Gemini) and the other sites ==');
const errors = [
  'Sorry, something went wrong. Please try your request again.',
  'I seem to be encountering an error. Can I try something else for you?',
  'I encountered an error doing what you asked. Could you try again?',
  "I'm having trouble right now. Please try again later.",
  'Something went wrong. If this issue persists please contact us through our help center at help.openai.com.',
  'There was an error generating a response',
  'Network error',
  'Hmm...something seems to have gone wrong.',
  'Error in message stream',
  'Claude will return soon',
  'Claude is currently overloaded. Please try again later.',
  'Something went wrong. Please try again.',
  'Due to unexpected capacity constraints, Claude is unable to respond to your message. Please try again soon.'
];
for (const t of errors) {
  const r = SE.siteErrorOf(t);
  assert(r && (r.kind === 'error' || r.kind === 'rate-limit'), `error notice: “${t.slice(0, 60)}” -> ${r && r.kind}`);
}
const limits = [
  "You've reached your usage limit. Please try again later.",
  'You have hit the rate limit. Try again in 20 minutes.',
  "You're out of free messages until 5:00 PM",
  'Too many requests in 1 hour. Try again later.'
];
for (const t of limits) assert((SE.siteErrorOf(t) || {}).kind === 'rate-limit', `usage / rate limit: “${t.slice(0, 50)}”`);

console.log('\n== real answers are never taken for an error notice ==');
const answers = [
  '{"verdict": "good", "scores": {"pace": 4}}',
  '{"note": "Something went wrong for the hero in chapter 3"}',
  '[{"id": "f1", "text": "Network error is a phrase in chapter 2"}]',
  '[TO: USER]\nSomething went wrong for the hero, and that is the plot.\n[FROM: GEMINI]',
  'Here is the outline of chapter 4: the hero arrives at the harbour.',
  'NONE',
  '',
  null,
  'Sorry, something went wrong. '.repeat(20) // long: a real reply that discusses errors
];
for (const t of answers) assert(SE.siteErrorOf(t) === null, `not an error notice: ${JSON.stringify(t == null ? t : String(t).slice(0, 50))}`);
assert(SE.MAX_CHARS === 400, 'only replies under 400 characters are ever checked');

console.log('\n== wait hint + plain words ==');
assert(SE.retryAfterSeconds('error') === 30 && SE.retryAfterSeconds('rate-limit') === 60, 'wait 30 s after an error notice, 60 s after a usage limit');
assert(SE.describeSiteError('Gemini', 'error') === 'Gemini showed an error message instead of an answer — waiting and trying again', 'plain words for the log');
assert(/usage-limit message/.test(SE.describeSiteError('Claude', 'rate-limit')), 'plain words for a usage limit');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
