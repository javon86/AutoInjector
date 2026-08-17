// test/shared-db.test.js — verifies the TASK 1 / TASK 2 bootstrap trio against
// each subtask's own "Done when" acceptance test:
//   MDC-001  schema created, migrations versioned, survives restart, self-heals
//   SCS-001  all sources write one ordered log; failed write parked, not partial
//   SCS-002  AutoInjector assigns numbers; 1,000 concurrent inserts -> 1..1000
// Runs on plain Node (uses the built-in node:sqlite). Run: node test/shared-db.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const db = require('../shared/db');
const { MessageLog, AppendParked } = require('../shared/message-log');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}
function tmpFile(name) { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atldb-')), name); }

// ---- MDC-001 ---------------------------------------------------------------
function testSchemaAndVersion() {
  console.log('\n== MDC-001: schema is created and migrations are versioned ==');
  const f = tmpFile('a.db');
  const d = db.openDatabase(f);
  assert(db.schemaVersion(d) === db.MIGRATIONS.length, `schema is at version ${db.MIGRATIONS.length} after open`);
  const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  assert(tables.includes('projects') && tables.includes('messages') && tables.includes('messages_deadletter'),
    'projects, messages and messages_deadletter tables exist');
  const jm = d.prepare('PRAGMA journal_mode').get().journal_mode;
  assert(String(jm).toLowerCase() === 'wal', 'WAL mode is on');
  d.close();
}

function testMigrationsAreIdempotent() {
  console.log('\n== MDC-001: re-opening does not re-run migrations ==');
  const f = tmpFile('b.db');
  db.openDatabase(f).close();
  const d = db.openDatabase(f); // second open
  assert(db.schemaVersion(d) === db.MIGRATIONS.length, 'version unchanged on the second open (no double-apply)');
  d.close();
}

function testSurvivesRestart() {
  console.log('\n== MDC-001: the database survives a service restart with all data intact ==');
  const f = tmpFile('c.db');
  let d = db.openDatabase(f);
  let log = new MessageLog(d);
  log.ensureProject('PROJECT-004', 'Lighthouse Novel');
  log.append({ projectId: 'PROJECT-004', from: 'user', body: 'start the book' });
  d.close(); // simulate service stop

  d = db.openDatabase(f); // simulate restart
  log = new MessageLog(d);
  const rows = log.read('PROJECT-004');
  assert(rows.length === 1 && rows[0].body === 'start the book', 'the message written before restart is still there');
  const proj = d.prepare('SELECT name FROM projects WHERE project_id=?').get('PROJECT-004');
  assert(proj && proj.name === 'Lighthouse Novel', 'the project row survives the restart');
  d.close();
}

function testCorruptionRestoresSnapshot() {
  console.log('\n== MDC-001: on corruption the service restores the last good snapshot, not damaged data ==');
  const f = tmpFile('d.db');
  let d = db.openDatabase(f);
  const log = new MessageLog(d);
  log.ensureProject('P1', 'P1');
  log.append({ projectId: 'P1', from: 'user', body: 'valuable data' });
  db.snapshot(d, db.snapshotPathFor(f, 'good'));     // a known-good snapshot
  d.close();

  // Corrupt the main database file (and drop stale WAL/SHM so the damage shows).
  for (const side of ['-wal', '-shm']) { try { fs.unlinkSync(f + side); } catch (_) {} }
  fs.writeFileSync(f, Buffer.from('this is not a sqlite database at all'));

  d = db.openDatabase(f); // should detect corruption and self-heal from the snapshot
  const rows = new MessageLog(d).read('P1');
  assert(rows.length === 1 && rows[0].body === 'valuable data', 'data recovered from the snapshot after corruption');
  d.close();
}

function testCorruptionNoSnapshotRefuses() {
  console.log('\n== MDC-001: with no snapshot, a corrupt database refuses to start dirty ==');
  const f = tmpFile('e.db');
  db.openDatabase(f).close();
  // Remove the pre-migration snapshot too, so there is genuinely nothing to
  // restore from — the true "refuse to start dirty" path.
  for (const snap of db.listSnapshots(f)) { try { fs.unlinkSync(snap); } catch (_) {} }
  for (const side of ['-wal', '-shm']) { try { fs.unlinkSync(f + side); } catch (_) {} }
  fs.writeFileSync(f, Buffer.from('garbage, and no snapshot exists'));
  let threw = false;
  try { db.openDatabase(f); } catch (_) { threw = true; }
  assert(threw, 'refuses to open a corrupt database when there is nothing good to restore');
}

// ---- SCS-001 ---------------------------------------------------------------
function testAllSourcesOneOrderedLog() {
  console.log('\n== SCS-001: all five+ sources write one log; seq order reproduces the conversation, no gaps ==');
  const f = tmpFile('f.db');
  const d = db.openDatabase(f);
  const log = new MessageLog(d);
  log.ensureProject('BOOK', 'BOOK');
  const sources = ['user', 'chatgpt', 'claude', 'gemini', 'local', 'system'];
  sources.forEach((s, i) => log.append({ projectId: 'BOOK', from: s, body: `${s} says ${i}` }));

  const rows = log.read('BOOK');
  assert(rows.length === 6, 'every source wrote into the same table');
  assert(rows.map((r) => r.from).join(',') === sources.join(','), 'reading in seq order reproduces the exact conversation order');
  assert(rows.map((r) => r.seq).join(',') === '1,2,3,4,5,6', 'seqs are 1..6 with no gaps');
  const v = log.verifyContiguous('BOOK');
  assert(v.ok && v.gaps.length === 0 && v.duplicates.length === 0, 'verifyContiguous confirms no gaps and no duplicates');
  d.close();
}

function testFailedWriteParkedNotPartial() {
  console.log('\n== SCS-001: a write that fails is parked in the dead-letter, never partially committed ==');
  const f = tmpFile('g.db');
  const d = db.openDatabase(f);
  const log = new MessageLog(d, { retryWrites: 1, retrySeq: 1 });
  // Appending for a project that was never created violates the FK — a real,
  // non-retryable write failure.
  let parked = false;
  try { log.append({ projectId: 'GHOST', from: 'claude', body: 'orphaned message' }); }
  catch (e) { parked = e instanceof AppendParked; }
  assert(parked, 'the failing write raises AppendParked rather than succeeding');
  const inLog = d.prepare("SELECT COUNT(*) c FROM messages WHERE project_id='GHOST'").get().c;
  assert(inLog === 0, 'nothing was partially committed to the messages table');
  const dead = log.deadletters('GHOST');
  assert(dead.length === 1 && JSON.parse(dead[0].payload).body === 'orphaned message',
    'the raw payload is preserved in messages_deadletter — never dropped');
  d.close();
}

function testNumbersAreSystemAssigned() {
  console.log('\n== SCS-002: a caller may not choose the number ==');
  const f = tmpFile('h.db');
  const d = db.openDatabase(f);
  const log = new MessageLog(d);
  log.ensureProject('P', 'P');
  let rejected = 0;
  try { log.append({ projectId: 'P', from: 'user', body: 'x', seq: 99 }); } catch (_) { rejected++; }
  try { log.append({ projectId: 'P', from: 'user', body: 'x', msgId: 'MSG-000999' }); } catch (_) { rejected++; }
  assert(rejected === 2, 'supplying seq or msgId is rejected — AutoInjector assigns numbers');
  const first = log.append({ projectId: 'P', from: 'user', body: 'first' });
  assert(first.msgId === 'MSG-000001' && first.seq === 1, 'the first message is numbered MSG-000001');
  d.close();
}

// ---- SCS-002 (the headline acceptance test) --------------------------------
function testConcurrentNumbering() {
  console.log('\n== SCS-002: 1,000 concurrent inserts -> 1,000 unique consecutive IDs, zero duplicates, zero gaps ==');
  const f = tmpFile('conc.db');
  const d = db.openDatabase(f);      // parent creates schema + project first
  new MessageLog(d).ensureProject('RACE', 'RACE');
  d.close();

  const workers = 8, per = 125;      // 8 * 125 = 1000, across separate processes
  const worker = path.join(__dirname, '_dbworker.js');
  const procs = [];
  for (let i = 0; i < workers; i++) {
    // Run synchronously-launched but truly parallel OS processes.
    procs.push({ src: `w${i}`, promise: null });
  }
  // Launch all, then collect — execFileSync blocks, so spawn via a small pool
  // using child_process.spawn for real overlap.
  const { spawnSync, spawn } = require('child_process');
  const children = procs.map((p) => spawn(process.execPath, [worker, f, 'RACE', p.src, String(per)], { stdio: 'ignore' }));
  const exits = children.map((c) => new Promise((res) => c.on('exit', (code) => res(code))));

  return Promise.all(exits).then((codes) => {
    assert(codes.every((c) => c === 0), 'every worker process committed all its messages');
    const d2 = db.openDatabase(f);
    const log = new MessageLog(d2);
    const rows = log.read('RACE');
    assert(rows.length === workers * per, `exactly ${workers * per} messages were stored (got ${rows.length})`);
    const v = log.verifyContiguous('RACE');
    assert(v.duplicates.length === 0, 'zero duplicate sequence numbers');
    assert(v.gaps.length === 0, 'zero gaps — the ids are consecutive 1..1000');
    const ids = new Set(rows.map((r) => r.msgId));
    assert(ids.size === workers * per, 'every msg_id is unique');
    d2.close();
  });
}

async function main() {
  testSchemaAndVersion();
  testMigrationsAreIdempotent();
  testSurvivesRestart();
  testCorruptionRestoresSnapshot();
  testCorruptionNoSnapshotRefuses();
  testAllSourcesOneOrderedLog();
  testFailedWriteParkedNotPartial();
  testNumbersAreSystemAssigned();
  await testConcurrentNumbering();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('Test runner crashed:', e); process.exit(1); });
