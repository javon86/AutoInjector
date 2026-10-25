// test/verify-relay-trace.test.js — pre-merge verification of the relay-trace.js
// noteCapture change ("a reply counts only for the older open messages when the
// newest wasn't seen being answered"). Runs every scenario against BOTH the new
// relay-trace.js and origin/main's copy (if git can produce it) and asserts:
//   - normal AutoInjector flows (Akọwe OFF) give the SAME answer attribution
//     and the same anomalies as before;
//   - the cases where they differ are listed explicitly (documented, not hidden).
// Run: node test/verify-relay-trace.test.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const NEW = require('../relay-trace');

let OLD = null;
try {
  const src = execFileSync('git', ['show', 'origin/main:desktop-app/relay-trace.js'], { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rt-main-')), 'relay-trace.js');
  fs.writeFileSync(f, src);
  OLD = require(f);
} catch (_) { OLD = null; }

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

const NO_REPLY = 60000;
// A scenario is a list of steps run against a trace; returns a summary.
function run(lib, steps) {
  let clock = 1000;
  const T = lib.createRelayTrace({ now: () => clock, noReplyMs: NO_REPLY });
  for (const s of steps) {
    if (s.t) clock += s.t;
    if (s.send) { T.noteSend({ seq: s.send, target: s.to, kind: s.kind || 'relay', from: s.from || null, text: `[MSG #${s.send}]\nbody ${s.send}` }); T.noteSendResult(s.send, { ok: true, verified: true, attempts: 1 }); }
    if (s.gen) T.noteGenerating(s.gen);
    if (s.idle && T.noteIdle) T.noteIdle(s.idle); // main.js reports the writing->idle edge (M1)
    if (s.cap) T.noteCapture(s.cap, s.turn, { none: !!s.none });
  }
  clock += NO_REPLY + 1;
  const r = T.report();
  const msgs = T._msgs().map((m) => `${m.seq}:${m.answerTurn == null ? (m.answeredAt ? 'none' : 'OPEN') : 't' + m.answerTurn}`);
  const noReply = Object.values(r.sites).reduce((a, x) => a + (x.noReply || 0), 0);
  return { msgs: msgs.join(' '), noReply, answersOf: (id) => (T.answersOf ? T.answersOf(id) : null) };
}

function same(name, steps) {
  const n = run(NEW, steps);
  if (!OLD) { assert(true, `${name}: (origin/main copy unavailable) new = ${n.msgs}`); return n; }
  const o = run(OLD, steps);
  assert(n.msgs === o.msgs && n.noReply === o.noReply, `${name}: same as main — ${n.msgs} (noReply ${n.noReply})${n.msgs === o.msgs ? '' : ` vs main ${o.msgs}`}`);
  return n;
}
function differs(name, steps, expectNew, expectOld) {
  const n = run(NEW, steps);
  assert(n.msgs === expectNew, `${name}: new attribution ${n.msgs} (expected ${expectNew}); noReply=${n.noReply}`);
  if (OLD) { const o = run(OLD, steps); assert(o.msgs === expectOld, `${name}: main gave ${o.msgs} (expected ${expectOld}); noReply=${o.noReply}`); }
  return n;
}

console.log('\n== normal flows (Akọwe OFF): identical to main ==');
same('single relay, generation seen', [{ send: '0001', to: 'claude' }, { t: 1000, gen: 'claude' }, { t: 5000, cap: 'claude', turn: 1 }]);
same('single relay, fast reply (generation never seen)', [{ send: '0001', to: 'claude' }, { t: 900, cap: 'claude', turn: 1 }]);
same('two relays typed before the AI started (batched)', [{ send: '0001', to: 'claude', from: 'chatgpt' }, { send: '0002', to: 'claude', from: 'gemini' }, { t: 1000, gen: 'claude' }, { t: 5000, cap: 'claude', turn: 1 }]);
same('two relays batched, no generation seen', [{ send: '0001', to: 'claude' }, { send: '0002', to: 'claude' }, { t: 900, cap: 'claude', turn: 1 }]);
same('round trip, then a fast one', [{ send: '0001', to: 'claude' }, { t: 500, gen: 'claude' }, { t: 4000, cap: 'claude', turn: 1 }, { send: '0002', to: 'claude' }, { t: 700, cap: 'claude', turn: 2 }]);
same('NONE reply', [{ send: '0001', to: 'gemini' }, { t: 500, gen: 'gemini' }, { t: 1000, cap: 'gemini', turn: 1, none: true }]);
same('three panes in a mesh round', [
  { send: '0001', to: 'chatgpt', kind: 'program' }, { t: 300, gen: 'chatgpt' }, { t: 3000, cap: 'chatgpt', turn: 1 },
  { send: '0002', to: 'claude', from: 'chatgpt' }, { send: '0003', to: 'gemini', from: 'chatgpt' },
  { t: 300, gen: 'claude' }, { gen: 'gemini' }, { t: 3000, cap: 'claude', turn: 2 }, { t: 200, cap: 'gemini', turn: 3 },
  { send: '0004', to: 'chatgpt', from: 'claude' }, { send: '0005', to: 'gemini', from: 'claude' }, { send: '0006', to: 'chatgpt', from: 'gemini' }, { send: '0007', to: 'claude', from: 'gemini' },
  { t: 300, gen: 'chatgpt' }, { gen: 'gemini' }, { gen: 'claude' }, { t: 3000, cap: 'chatgpt', turn: 4 }, { cap: 'gemini', turn: 5 }, { cap: 'claude', turn: 6 }
]);
same('missing-tag nudge, resend seen being written', [{ send: '0001', to: 'claude' }, { t: 500, gen: 'claude' }, { t: 3000 }, { send: '0002', to: 'claude', kind: 'auto' }, { t: 400, gen: 'claude' }, { t: 3000, cap: 'claude', turn: 1 }]);

console.log('\n== where the new rule changes attribution (diagnostics only when Akọwe is OFF) ==');
// A message typed while the AI is still writing (no new idle->generating edge):
// the reply on the page answers the OLDER one; the newer stays open for the next
// reply. main marked both answered by the first reply and the second reply then
// answered nothing. The new behaviour is the more accurate one here.
differs('typed while still writing, then answered', [
  { send: '0001', to: 'claude' }, { t: 500, gen: 'claude' }, { t: 500, send: '0002', to: 'claude' }, { t: 3000, cap: 'claude', turn: 1 },
  { t: 500, gen: 'claude' }, { t: 3000, cap: 'claude', turn: 2 }
], '0001:t1 0002:t2', '0001:t1 0002:t1');

// M1 (was a RISK, now fixed): an older message that was SEEN being answered but
// whose reply was never captured as a new reply (a second identical NONE, or a
// same-text reply treated as a re-draw) stays open + started. When the next
// message is typed while the AI is idle and answered faster than one poll (no
// writing edge seen), the captured reply must answer the NEW message too —
// not leave it open (false "NO REPLY"; with Akọwe ON the bridge prompt
// would not own its own answer -> 504, then a LATE_REPLY_STORED mix-up).
// The "keep the newest open" rule now applies only to messages typed while
// the AI was still writing (the "typed while still writing" case above).
const staleSteps = [
  { send: '0001', to: 'gemini' }, { t: 500, gen: 'gemini' }, { t: 1000, cap: 'gemini', turn: 1, none: true },
  { send: '0002', to: 'gemini' }, { t: 500, gen: 'gemini' }, { t: 1000, idle: 'gemini' }, // second NONE: never captured (main.js: seen.text === text)
  { t: 5000, send: '0003', to: 'gemini' }, { t: 900, cap: 'gemini', turn: 3 } // fast real reply
];
const st = same('stale started message + a fast reply (typed while idle)', staleSteps);
assert(st.noReply === 0, `no false NO REPLY for 0003 (noReply=${st.noReply})`);
assert(JSON.stringify(st.answersOf(3)).includes('"0003"'), `answersOf(3) = ${JSON.stringify(st.answersOf(3))} includes the new message 0003 (a bridge prompt owns its answer)`);
// main.js also closes the stale message when the second NONE / same text is seen
// (closeUncapturedReply -> noteCapture(site, null)); then turn 3 answers only 0003.
const closed = run(NEW, [
  { send: '0001', to: 'gemini' }, { t: 500, gen: 'gemini' }, { t: 1000, cap: 'gemini', turn: 1, none: true },
  { send: '0002', to: 'gemini' }, { t: 500, gen: 'gemini' }, { t: 1000, cap: 'gemini', turn: null, none: true },
  { t: 5000, send: '0003', to: 'gemini' }, { t: 900, cap: 'gemini', turn: 3 }
]);
assert(closed.msgs === '0001:t1 0002:none 0003:t3' && closed.noReply === 0, `stale message closed by the repeated NONE: ${closed.msgs} (noReply ${closed.noReply})`);
assert(JSON.stringify(closed.answersOf(3)) === '["0003"]', `answersOf(3) = ${JSON.stringify(closed.answersOf(3))}`);
// Typed over the stale message's reply while the AI was STILL writing, then a
// fast reply: the older message keeps the reply, the newer stays open (the
// rule's purpose is preserved).
const over = run(NEW, [
  { send: '0001', to: 'gemini' }, { t: 500, gen: 'gemini' }, { t: 300, send: '0002', to: 'gemini' }, { t: 900, cap: 'gemini', turn: 1 },
  { t: 300, gen: 'gemini' }, { t: 900, cap: 'gemini', turn: 2 }
]);
assert(over.msgs === '0001:t1 0002:t2', `typed while writing: ${over.msgs}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
