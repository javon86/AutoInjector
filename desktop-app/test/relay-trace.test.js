// test/relay-trace.test.js — TR-13 Relay Trace: every [MSG #n] followed through
// its stages, and the report says where messages stop. Run: node test/relay-trace.test.js
const { createRelayTrace, formatReport } = require('../relay-trace');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

let clock = 1000;
const T = createRelayTrace({ now: () => clock, noReplyMs: 60000 });
const send = (seq, target, extra = {}) => T.noteSend({ seq, target, text: `[MSG #${seq}]\n${extra.text || 'body ' + seq}`, ...extra });

console.log('\n== a healthy round trip and a hand-off chain ==');
send('0001', 'claude', { kind: 'program' });
T.noteSendResult('0001', { ok: true, verified: true, attempts: 1 });
clock += 2000; T.noteGenerating('claude');
clock += 8000; T.noteCapture('claude', 11);
send('0002', 'gemini', { from: 'claude', kind: 'relay', sourceTurnId: 11, text: 'claude says hi' });
T.noteSendResult('0002', { ok: true, verified: true, attempts: 1 });
clock += 5000; T.noteCapture('gemini', 12);
T.noteHeld(12, 'to-user');
let r = T.report();
assert(r.sites.claude.sent === 1 && r.sites.claude.proven === 1 && r.sites.claude.answered === 1 && r.sites.claude.started === 1, 'Claude: sent, proven, started, answered');
assert(r.sites.claude.medianReplySec === 10 && !r.sites.claude.stopsAt, 'reply time measured; no losses');
assert(r.replyOutcomes.forwarded === 1 && r.replyOutcomes.held['to-user'] === 1, "Claude's reply was passed on; Gemini's was held for the user");

console.log('\n== the ChatGPT failure from the 21 Oct extract ==');
for (let i = 3; i <= 6; i++) {
  const seq = String(i).padStart(4, '0');
  send(seq, 'chatgpt', { from: 'gemini', kind: 'relay', text: `relay ${i}` });
  T.noteSendResult(seq, { ok: true, verified: true, attempts: 2 });
  clock += 1000;
}
T.noteGenerating('chatgpt');
clock += 61000;
r = T.report();
const c = r.sites.chatgpt;
assert(c.sent === 4 && c.proven === 4 && c.answered === 0 && c.noReply === 4, `4 proven, 0 answered, 4 no-reply (${JSON.stringify(c)})`);
assert(c.retried === 4, 'every one needed a retry — counted');
assert(/capturing/.test(c.stopsAt), `it names the stage: the AI replied but nothing was captured (${c.stopsAt})`);

console.log('\n== failures, unproven sends, duplicates, batched replies ==');
send('0007', 'gemini', { from: 'claude', kind: 'relay', text: 'same body' });
T.noteSendResult('0007', { ok: false, error: 'SEND_NOT_CONFIRMED', attempts: 3 });
send('0008', 'gemini', { from: 'claude', kind: 'relay', text: 'same body' });
T.noteSendResult('0008', { ok: true, verified: true });
send('0009', 'gemini', { from: 'claude', kind: 'relay', text: 'same body' });
T.noteSendResult('0009', { ok: true, verified: true });
send('0010', 'claude', { text: 'unproven one' });
T.noteSendResult('0010', { ok: true, verified: false });
clock += 3000; T.noteCapture('gemini', 13);
r = T.report();
const g = r.sites.gemini;
assert(g.failed === 1 && g.errors.SEND_NOT_CONFIRMED === 1 && /sending/.test(g.stopsAt), 'a failed send is counted with its error');
assert(g.duplicates === 1, `the same body delivered twice is flagged once — the failed try doesn't count (${g.duplicates})`);
assert(g.answered === 3, 'one reply answers every message that AI was still waiting on');
assert(r.sites.claude.unproven === 1, 'an unproven send is counted');
assert(r.anomalies.some((a) => a.seq === '0009' && /duplicate/.test(a.what)) && r.anomalies.some((a) => a.seq === '0007' && /failed/.test(a.what)), 'problems list names the message numbers');

console.log('\n== the written report ==');
const text = formatReport(r, { timeFmt: (t) => `t${t}` });
assert(/RELAY TRACE/.test(text) && /ChatGPT: 4 sent · 4 proven/.test(text), 'per-AI line');
assert(/Messages stop at: capturing/.test(text), 'says where ChatGPT stops');
assert(/DUPLICATE/.test(text) && /#0009/.test(text), 'flags the duplicate by number');
assert(/held back — addressed to you/.test(text), 'explains held replies');

console.log('\n== TR-30: repeats you sent and reminders are not app duplicates; a reply typed over is flagged ==');
{
  let c2 = 0;
  const R = createRelayTrace({ now: () => c2, noReplyMs: 600000 });
  const s2 = (seq, target, extra = {}) => R.noteSend({ seq, target, text: extra.text || 'same', ...extra });
  s2('0001', 'claude', { kind: 'program', text: 'do it' }); R.noteSendResult('0001', { ok: true, verified: true });
  c2 += 5000; s2('0002', 'claude', { kind: 'program', text: 'do it' }); R.noteSendResult('0002', { ok: true, verified: true });
  c2 += 5000; s2('0003', 'gemini', { kind: 'auto', text: 'reminder' }); R.noteSendResult('0003', { ok: true, verified: true });
  c2 += 5000; s2('0004', 'gemini', { kind: 'auto', text: 'reminder' }); R.noteSendResult('0004', { ok: true, verified: true });
  let rr = R.report();
  assert(!rr.anomalies.some((a) => /duplicate/.test(a.what)), 'the same text sent again by you, or a repeated reminder, is not reported as an app duplicate');
  assert(rr.sites.claude.repeatedByYou === 1 && /1 sent again by you/.test(formatReport(rr)), 'a repeat you sent is noted as yours');
  // ChatGPT starts answering #0005, then #0006 is typed before that reply is captured.
  s2('0005', 'chatgpt', { from: 'claude', kind: 'relay', text: 'one' }); R.noteSendResult('0005', { ok: true, verified: true });
  c2 += 1000; R.noteGenerating('chatgpt');
  c2 += 3000; s2('0006', 'chatgpt', { from: 'gemini', kind: 'relay', text: 'two' }); R.noteSendResult('0006', { ok: true, verified: true });
  c2 += 3000; R.noteCapture('chatgpt', 99);
  rr = R.report();
  assert(rr.anomalies.some((a) => a.seq === '0005' && /typed while its reply was still on the page/.test(a.what)), 'a message typed over an uncaptured reply is flagged, even though a later reply was captured');
}

console.log('\n== P18.1: wouldAnswer() predicts answersOf() without recording ==');
{
  let c3 = 0;
  const R = createRelayTrace({ now: () => c3, noReplyMs: 600000 });
  R.noteSend({ seq: '0010', target: 'gemini', kind: 'program', text: 'chapter please' }); R.noteSendResult('0010', { ok: true, verified: true });
  c3 += 1000; R.noteSend({ seq: '0011', target: 'gemini', kind: 'auto', text: 'Reply with only this word: harbor' }); R.noteSendResult('0011', { ok: true, verified: true });
  const before = R.wouldAnswer('gemini');
  assert(before.join() === '0010,0011' && R.wouldAnswer('gemini').join() === '0010,0011', 'the older Akọwe prompt and the check-in are both open (asking twice changes nothing)');
  assert(R.openMessages('gemini').map((m) => `${m.seq}:${m.kind}`).join() === '0010:program,0011:auto', 'openMessages lists what is owed, with its kind (no text)');
  c3 += 1000; R.noteCapture('gemini', 7);
  assert(R.answersOf(7).join() === before.join() && R.wouldAnswer('gemini').length === 0, 'noteCapture records exactly what wouldAnswer said');
}

console.log('\n== cap + reset ==');
const S = createRelayTrace({ now: () => 0, maxMessages: 5 });
for (let i = 0; i < 9; i++) S.noteSend({ seq: String(i), target: 'claude', text: `x${i}` });
assert(S._msgs().length === 5, 'keeps only the newest maxMessages');
S.reset();
assert(S.report().messages === 0 && /nothing sent yet/.test(formatReport(S.report())), 'reset empties it');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
