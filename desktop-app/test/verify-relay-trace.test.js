// test/verify-relay-trace.test.js — pre-merge verification of the relay-trace.js
// noteCapture change ("a reply counts only for the older open messages when the
// newest wasn't seen being answered"). Runs every scenario against BOTH the new
// relay-trace.js and origin/main's copy (if git can produce it) and asserts:
//   - normal AutoInjector flows (BookForge OFF) give the SAME answer attribution
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

console.log('\n== normal flows (BookForge OFF): identical to main ==');
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

console.log('\n== where the new rule changes attribution (diagnostics only when BookForge is OFF) ==');
// A message typed while the AI is still writing (no new idle->generating edge):
// the reply on the page answers the OLDER one; the newer stays open for the next
// reply. main marked both answered by the first reply and the second reply then
// answered nothing. The new behaviour is the more accurate one here.
differs('typed while still writing, then answered', [
  { send: '0001', to: 'claude' }, { t: 500, gen: 'claude' }, { t: 500, send: '0002', to: 'claude' }, { t: 3000, cap: 'claude', turn: 1 },
  { t: 500, gen: 'claude' }, { t: 3000, cap: 'claude', turn: 2 }
], '0001:t1 0002:t2', '0001:t1 0002:t1');

// RISK: an older message that was SEEN being answered but whose reply was never
// captured (e.g. a second identical NONE is swallowed without a capture, or a
// same-text reply is treated as a re-draw) stays open + started. If the next
// message is answered faster than one poll (POLL_MS 1500 ms by default, so the
// generating edge is never seen), the new rule gives the captured reply to the
// STALE message and leaves the new one open -> a false "NO REPLY" for it.
const staleSteps = [
  { send: '0001', to: 'gemini' }, { t: 500, gen: 'gemini' }, { t: 1000, cap: 'gemini', turn: 1, none: true },
  { send: '0002', to: 'gemini' }, { t: 500, gen: 'gemini' }, // second NONE: never captured (main.js returns early: seen.text === text)
  { t: 5000, send: '0003', to: 'gemini' }, { t: 900, cap: 'gemini', turn: 3 } // fast real reply
];
const st = differs('stale started message + a fast reply', staleSteps, '0001:t1 0002:t3 0003:OPEN', '0001:t1 0002:t3 0003:t3');
assert(st.noReply === 1, `new rule reports a false NO REPLY for 0003 (noReply=${st.noReply})`);
// With the BookForge bridge ON this is the ownership input: answersOf(turn 3)
// would not contain 0003, so a bridge prompt typed as 0003 would NOT own its
// own answer (the answer would go to the normal relay and the request time out).
assert(JSON.stringify(st.answersOf(3)) === '["0002"]', `answersOf(3) = ${JSON.stringify(st.answersOf(3))} (bridge prompt 0003 would not own its answer)`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
