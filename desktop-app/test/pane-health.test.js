// test/pane-health.test.js — TR-07 (honest per-pane lights) and TR-03
// (a stalled pane says WHY). Run: node test/pane-health.test.js
const { createPaneHealth } = require('../pane-health');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

let clock = 1000;
const H = createPaneHealth({ sites: ['chatgpt', 'claude', 'gemini'], now: () => clock, stallMs: 60000 });
const lvl = (s) => H.evaluate(s).level;

console.log('\n== levels ==');
assert(lvl('claude') === 'idle', 'nothing sent yet -> idle');
H.onSendResult('claude', { ok: true, verified: true });
assert(lvl('claude') === 'waiting', 'delivered -> waiting');
clock += 5000; H.onCapture('claude');
assert(lvl('claude') === 'ok', 'reply captured after the send -> ok (green)');
H.onSendResult('gemini', { ok: false, error: 'SEND_NOT_CONFIRMED' });
assert(lvl('gemini') === 'error' && /SEND_NOT_CONFIRMED/.test(H.evaluate('gemini').text), 'a failed send -> error, with the code');
H.onSendResult('gemini', { ok: true, verified: true });
assert(lvl('gemini') === 'waiting', 'a later good send clears the error');
H.onSendResult('chatgpt', { ok: true, verified: false });
assert(lvl('chatgpt') === 'warn', 'an unproven send -> warn (amber), not green');

console.log('\n== stalls explain themselves ==');
H.onRead('chatgpt', { textLen: 0, generating: false, hasEndTag: false, tail: '' });
clock += 61000;
const e = H.evaluate('chatgpt');
{
  // TR-31: the reader only sees "[TO:" — named as a reading problem, not a missing tag.
  let c3 = 1000;
  const H3 = createPaneHealth({ sites: ['gemini'], now: () => c3, stallMs: 1000 });
  H3.onSendResult('gemini', { ok: true, verified: true });
  H3.onRead('gemini', { textLen: 4, generating: false, hasEndTag: false, tail: '[TO:' });
  c3 += 2000;
  const g = H3.evaluate('gemini');
  assert(g.level === 'stalled' && /only sees the start of the reply/.test(g.text), `a "[TO:" fragment is explained as a reading problem (${g.text})`);
}
assert(e.level === 'stalled' && /selector matches nothing/.test(e.text), `no reply text on the page -> blamed on the reply selector (${e.text})`);
let st = H.newStalls();
assert(st.length === 2 && st.some((x) => x.site === 'chatgpt'), 'each stalled pane is reported once');
assert(H.newStalls().length === 0, '...and not again on the next tick');
H.onRead('gemini', { textLen: 500, generating: false, hasEndTag: false, tail: 'no tag here' });
assert(/no closing \[FROM:\] tag/.test(H.evaluate('gemini').text), 'reply without its closing tag is named as the reason');
H.onRead('gemini', { textLen: 500, generating: true, hasEndTag: false, tail: '' });
assert(H.evaluate('gemini').level === 'waiting' && /Still writing/.test(H.evaluate('gemini').text), 'a long reply still being written is NOT a stall yet');
clock += 200000;
assert(/still says it is generating/.test(H.evaluate('gemini').text), 'but a page stuck on "generating" for 4x the limit is, and says why');
H.onCapture('gemini');
assert(lvl('gemini') === 'ok', 'a capture ends the stall');
H.onRead('gemini', { textLen: 500, generating: false, hasEndTag: true, tail: '' });
H.onSendResult('gemini', { ok: true, verified: true }); clock += 61000;
assert(H.newStalls().some((x) => x.site === 'gemini'), 'a NEW stall after a new send is reported again');
assert(Object.keys(H.snapshot()).length === 3, 'snapshot covers every pane');

console.log('\n== TR-23: a reply reader stuck on the last line is named ==');
{
  let c2 = 1; const P = createPaneHealth({ sites: ['chatgpt'], now: () => c2, stallMs: 1000 });
  P.onSendResult('chatgpt', { ok: true, verified: true });
  P.onRead('chatgpt', { textLen: 15, generating: false, hasEndTag: true, tail: '[FROM: CHATGPT]' });
  c2 = 2000;
  assert(/reads only the last line/.test(P.evaluate('chatgpt').text), `stall reason names the narrow reader (${P.evaluate('chatgpt').text})`);
}
console.log('\n== TR-08: the page check shows on the light before anything is sent ==');
{
  const P = createPaneHealth({ sites: ['chatgpt'], now: () => 0 });
  P.onProbe('chatgpt', { ok: true, input: { found: false }, send: { found: false }, assistant: { count: 0 }, signedOutHint: true });
  assert(P.evaluate('chatgpt').level === 'error' && /Signed out/.test(P.evaluate('chatgpt').text), 'no message box + a sign-in page -> red, "signed out?"');
  P.onProbe('chatgpt', { ok: true, input: { found: true }, send: { found: true }, assistant: { count: 3 }, signedOutHint: false });
  assert(P.evaluate('chatgpt').level === 'idle' && /Page check OK/.test(P.evaluate('chatgpt').text), 'box found -> grey, "page check OK"');
  P.onProbe('chatgpt', { ok: false, error: 'NO_RESULT' });
  assert(P.evaluate('chatgpt').level === 'idle', 'a check that could not run never turns the light red');
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
