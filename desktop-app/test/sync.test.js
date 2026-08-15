// test/sync.test.js — TASK 1 synchronization subtasks, each checked against its
// own "Done when":
//   SCS-003 thread walks REPLY-TO to origin; unknown recipient flagged; dangling reply nulled
//   SCS-004 per-model read position + exact lag; ahead-of-log clamps
//   SCS-006 per-recipient delivery states; backoff/max-retries; nothing stuck PENDING
//   SCS-007 replaying a message stores one + one DROP_DUPLICATE row
//   SCS-012 exactly one CURRENT baseline; mismatched prev-hash refused
// Run: node test/sync.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../shared/db');
const { MessageLog } = require('../shared/message-log');
const { ReadPositions, Deliveries, Baselines } = require('../shared/sync');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}
function freshDb() {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atlsync-')), 's.db');
  return db.openDatabase(f);
}

// ---- SCS-003 ---------------------------------------------------------------
function testThreadingAndRouting() {
  console.log('\n== SCS-003: REPLY-TO walks back to the originating message; routing anomalies flagged ==');
  const d = freshDb();
  const log = new MessageLog(d);
  log.ensureProject('P', 'P');
  const a = log.append({ projectId: 'P', from: 'user', to: 'claude', body: 'write chapter 1' });
  const b = log.append({ projectId: 'P', from: 'claude', to: 'chatgpt', replyTo: a.msgId, body: 'draft done' });
  const c = log.append({ projectId: 'P', from: 'chatgpt', to: 'claude', replyTo: b.msgId, body: 'looks good' });

  const chain = log.thread('P', c.msgId).map((m) => m.msgId);
  assert(chain.length === 3 && chain[0] === a.msgId && chain[2] === c.msgId,
    'thread() returns origin..message in order (MSG1 -> MSG2 -> MSG3)');
  assert(log.originOf('P', c.msgId).msgId === a.msgId, 'originOf() resolves the user message that started the thread');

  const unknown = log.append({ projectId: 'P', from: 'claude', to: 'deepseek', body: 'hi there' });
  assert(unknown.routingStatus === 'ROUTING_UNRESOLVED', 'a message to an unknown recipient is flagged ROUTING_UNRESOLVED, not dropped');
  assert(log.logs('P').some((r) => r.code === 'ROUTING_UNRESOLVED'), 'the unresolved routing is logged');

  const dangling = log.append({ projectId: 'P', from: 'user', to: 'claude', replyTo: 'MSG-009999', body: 'reply to a ghost' });
  const stored = log.read('P').find((m) => m.msgId === dangling.msgId);
  assert(stored.replyTo === '', 'a reply_to pointing at a nonexistent message is nulled, never left dangling');
  assert(log.logs('P').some((r) => r.code === 'REPLY_TO_NULLED'), 'the nulled reply_to is logged');
  d.close();
}

// ---- SCS-007 ---------------------------------------------------------------
function testDedup() {
  console.log('\n== SCS-007: replaying the same message stores one message and one DROP_DUPLICATE row ==');
  const d = freshDb();
  const log = new MessageLog(d);
  log.ensureProject('P', 'P');
  const first = log.append({ projectId: 'P', from: 'claude', to: 'chatgpt', body: 'identical body' });
  const replay = log.append({ projectId: 'P', from: 'claude', to: 'chatgpt', body: 'identical body' });

  assert(replay.dropped === true && replay.duplicateOf === first.msgId, 'the replay is reported as a duplicate of the original');
  assert(log.read('P').length === 1, 'only one message is stored');
  const drops = log.drops('P');
  assert(drops.length === 1 && drops[0].reason === 'DROP_DUPLICATE' && drops[0].original_msg_id === first.msgId,
    'a DROP_DUPLICATE row records the reason and the original MSG id (recoverable, not lost)');

  const outsideWindow = new MessageLog(d, { dedupWindowMs: 0 });
  const third = outsideWindow.append({ projectId: 'P', from: 'claude', to: 'chatgpt', body: 'identical body' });
  assert(!third.dropped, 'an identical message outside the dedup window is NOT dropped');
  d.close();
}

// ---- SCS-004 ---------------------------------------------------------------
function testReadPositions() {
  console.log('\n== SCS-004: each model\'s exact read lag is known; a position ahead of the log is clamped ==');
  const d = freshDb();
  const log = new MessageLog(d);
  log.ensureProject('P', 'P');
  for (let i = 0; i < 6; i++) log.append({ projectId: 'P', from: 'user', body: `m${i}` }); // seq 1..6
  const rp = new ReadPositions(d);
  rp.confirm('P', 'chatgpt', 6);
  rp.confirm('P', 'gemini', 4);

  assert(rp.lag('P', 'chatgpt') === 0, 'a fully-caught-up model reports lag 0');
  assert(rp.lag('P', 'gemini') === 2, 'a model at MSG 4 of 6 reports lag 2');
  const all = new Map(rp.all('P').map((r) => [r.model, r]));
  assert(all.get('gemini').position === 4 && all.get('gemini').lag === 2, 'all() reports exact position and lag per model');

  rp.confirm('P', 'claude', 3);
  assert(rp.confirm('P', 'claude', 1) === 3, 'read position only advances — a lower confirm does not move it back');

  // Corruption: a stored position ahead of the log max is clamped + flagged.
  rp.confirm('P', 'ahead', 999);
  assert(rp.lag('P', 'ahead') === 0, 'a position ahead of the log clamps to the max (lag 0)');
  assert(log.logs('P').concat(d.prepare("SELECT * FROM system_log").all()).some((r) => r.code === 'READ_POSITION_CLAMPED'),
    'the clamp is flagged for resync');
  d.close();
}

// ---- SCS-006 ---------------------------------------------------------------
function testDeliveryRetries() {
  console.log('\n== SCS-006: per-recipient delivery reaches a terminal state; backoff, max 3 retries, no stuck PENDING ==');
  const d = freshDb();
  const log = new MessageLog(d);
  log.ensureProject('P', 'P');
  const m = log.append({ projectId: 'P', from: 'user', to: 'all', body: 'broadcast' });

  let t = 1000000;
  const del = new Deliveries(d, { now: () => t, timeoutMs: 30000 });
  del.queue('P', m.msgId, ['claude', 'gemini']);
  let st = new Map(del.state('P', m.msgId).map((r) => [r.recipient, r]));
  assert(st.get('claude').state === 'PENDING' && st.get('gemini').state === 'PENDING', 'both recipients start PENDING');

  del.markDelivered('P', m.msgId, 'claude');
  assert(del.state('P', m.msgId).find((r) => r.recipient === 'claude').state === 'DELIVERED', 'a confirmed recipient becomes DELIVERED');

  t += 30001; // past the timeout
  del.sweep();
  const gem1 = del.state('P', m.msgId).find((r) => r.recipient === 'gemini');
  assert(gem1.state === 'RETRY' && gem1.attempts === 1, 'a recipient still PENDING past its timeout moves to RETRY-1 (never stuck PENDING)');

  t += 5001; del.sweep();   // backoff 5s
  t += 15001; del.sweep();  // backoff 15s
  let gem = del.state('P', m.msgId).find((r) => r.recipient === 'gemini');
  assert(gem.attempts === 3 && gem.state === 'RETRY', 'after three retries it is at RETRY-3');

  t += 45001; del.sweep();  // backoff 45s -> exhausted
  gem = del.state('P', m.msgId).find((r) => r.recipient === 'gemini');
  assert(gem.state === 'FAILED_PERMANENT', 'after 3 retries it gives up as FAILED_PERMANENT');
  assert(del.state('P', m.msgId).find((r) => r.recipient === 'claude').state === 'DELIVERED', 'the delivered recipient is unaffected (same MSG id, no second message)');
  assert(del.allTerminal('P', m.msgId), 'every recipient has reached a terminal state');
  assert(d.prepare("SELECT COUNT(*) c FROM system_log WHERE code='FAILED_PERMANENT'").get().c === 1, 'the permanent failure raised exactly one alert');
  d.close();
}

// ---- SCS-012 ---------------------------------------------------------------
function testBaselines() {
  console.log('\n== SCS-012: exactly one CURRENT baseline; a mismatched prev-hash is refused ==');
  const d = freshDb();
  const log = new MessageLog(d);
  log.ensureProject('P', 'P');
  const bl = new Baselines(d);

  const first = bl.promote('P', 'HASH_A', { stage: 'DRAFT' });
  assert(first.promoted && bl.current('P').hash === 'HASH_A', 'the first baseline promotes and becomes CURRENT');

  const bad = bl.promote('P', 'HASH_B', { prevHash: 'WRONG' });
  assert(!bad.promoted && bl.current('P').hash === 'HASH_A', 'a promotion with a mismatched prev_hash is refused; prior baseline stays CURRENT');
  assert(log.logs('P').some((r) => r.code === 'BASELINE_REFUSED'), 'the refused promotion is logged');

  const good = bl.promote('P', 'HASH_B', { prevHash: 'HASH_A' });
  assert(good.promoted && bl.current('P').hash === 'HASH_B', 'a promotion presenting the correct prev_hash succeeds');
  assert(bl.current('P').prev_hash === 'HASH_A', 'the new baseline is linked to its predecessor');
  assert(bl.history('P').length === 2, 'full history is retained');
  const currents = d.prepare("SELECT COUNT(*) c FROM baselines WHERE project_id='P' AND is_current=1").get().c;
  assert(currents === 1, 'exactly one baseline row is CURRENT');

  const empty = bl.promote('P', '   ', { prevHash: 'HASH_B' });
  assert(!empty.promoted, 'an empty/unverifiable hash refuses promotion');
  d.close();
}

function main() {
  testThreadingAndRouting();
  testDedup();
  testReadPositions();
  testDeliveryRetries();
  testBaselines();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
