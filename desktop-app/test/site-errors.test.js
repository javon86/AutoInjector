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

console.log('\n== PR #120: short canned refusals are site problems (kind "refused"), never answers ==');
const refusals = [
  "I'm having a hard time fulfilling your request. Can I help you with something else instead?", // the user's log, 91 chars, taken as an Akọwe answer
  '[TO: USER]\nI’m having a hard time fulfilling your request. Can I help you with something else instead?',
  'Can I help you with something else instead?',
  "I'm a text-based AI, and that is outside of my capabilities.",
  "I'm just a language model, so I can't help you with that.",
  "I'm not able to help with that, as I'm only a language model.",
  'As a language model, I’m not able to assist you with that.',
  "I'm sorry, but I can't assist with that.",
  "Sorry, I can't help with that.",
  "I can't help with that request.",
  "I'm unable to help with that."
];
for (const t of refusals) assert((SE.siteErrorOf(t) || {}).kind === 'refused', `refusal: “${t.slice(0, 60)}” -> ${(SE.siteErrorOf(t) || {}).kind}`);
assert((SE.siteErrorOf('The message you submitted was too long, please reload the conversation and submit something shorter.') || {}).kind === 'too-long', 'ChatGPT "message too long" -> too-long');
// PR #123: "…for this chat" means the CHAT is full (a fresh chat fixes it), not this one message
assert((SE.siteErrorOf('Your message will exceed the length limit for this chat.') || {}).kind === 'chat-full', 'Claude "exceed the length limit for this chat" -> chat-full');
assert((SE.siteErrorOf('Your message will exceed the length limit.') || {}).kind === 'too-long', 'Claude "exceed the length limit" (no chat named) -> too-long');
const notRefusals = [
  "I can't help with that, but here is what you can do instead: open Settings, choose Display, and turn the scale down to 100 percent.",
  '{"note": "I\'m having a hard time fulfilling your request"}',
  '[TO: USER]\nMara said: "I\'m sorry, but I can\'t help with that." Then she left.\n[FROM: CLAUDE]',
  'Chapter 9. "' + "I'm having a hard time fulfilling your request," + '" the clerk said, and asked whether he could help with something else instead. ' + 'The rain went on. '.repeat(14)
];
for (const t of notRefusals) assert(SE.siteErrorOf(t) === null, `a real answer that holds the words is not a refusal: ${JSON.stringify(t.slice(0, 50))}`);
assert(SE.REFUSAL_MAX_CHARS === 300, 'refusals are only looked for in replies under 300 characters');
assert(/short refusal/.test(SE.describeSiteError('Gemini', 'refused')) && !/very long/.test(SE.describeSiteError('Gemini', 'refused', 2000)), 'plain words for a refusal (a normal-length prompt is not mentioned)');
const longNote = SE.describeSiteError('Gemini', 'refused', 56012);
assert(/56,012 characters/.test(longNote) && /may refuse prompts that long/.test(longNote), `a refusal of a very long prompt names its length (${longNote})`);
assert(SE.longPromptNote('Gemini', 'error', 90000) === '', 'an ordinary error notice never blames the prompt length');

console.log('\n== when a usage limit resets, read from the site\'s notice (limit_reset_at for Akọwe) ==');
{
  const NOW = new Date(2026, 10, 5, 13, 0, 0, 0).getTime(); // Thu Nov 5 2026, 1:00 PM local time
  const at = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi, 0, 0).getTime();
  const cases = [
    ['You are out of free messages until 3:40 PM', at(2026, 10, 5, 15, 40)],
    ['5-hour limit reached ∙ resets 3pm', at(2026, 10, 5, 15, 0)],
    ["You've reached the current usage cap for GPT-4, please try again after 10:21 PM.", at(2026, 10, 5, 22, 21)],
    ['You have hit your limit. Try again in 2 hours 30 minutes.', NOW + 150 * 60000],
    ['Usage limit reached. Please try again in 45 minutes', NOW + 45 * 60000],
    ['Your limit resets in about 3 hours', NOW + 3 * 3600000],
    ["You've reached your limit for 2.5 Pro until Nov 6, 1:43 AM", at(2026, 10, 6, 1, 43)],
    ['Your limit resets tomorrow at 9:00 AM', at(2026, 10, 6, 9, 0)],
    ['You are out of messages until 11:30 AM', at(2026, 10, 6, 11, 30)],       // 11:30 AM already passed today -> tomorrow
    ['message limit reached — available again at 17:15', at(2026, 10, 5, 17, 15)],
    ['you’ve reached your usage limit. your limit will reset at 4:05 pm.', at(2026, 10, 5, 16, 5)], // lower-case (self-repair's notice text)
    ['Claude usage limit reached. Your limit will reset at 12 AM.', at(2026, 10, 6, 0, 0)],
    ['Out of free messages until Monday at 8:00 AM', at(2026, 10, 9, 8, 0)]
  ];
  for (const [text, want] of cases) {
    const got = SE.limitResetAt(text, NOW);
    assert(got === want, `“${text}” -> ${got ? new Date(got).toString().slice(0, 21) : got} (want ${new Date(want).toString().slice(0, 21)})`);
  }
  const none = [
    'You have reached your usage limit. Please try again later.',
    "You've sent 40 messages in 3 hours.",
    'Usage limit reached until 5',
    'Your limit resets at 25:00',
    'Upgrade to continue',
    ''
  ];
  for (const t of none) assert(SE.limitResetAt(t, NOW) === null, `no time named -> null (never a guess): ${JSON.stringify(t)}`);
  assert(SE.limitResetAt('Try again in 400 hours', NOW) === null, 'a reset more than 8 days away is not trusted');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
