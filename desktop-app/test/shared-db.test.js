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

function testCorruptionNoSnapshotStartsFresh() {
  console.log('\n== MDC-001: with no snapshot, a corrupt database is set aside (kept) and a fresh one starts ==');
  const f = tmpFile('e.db');
  db.openDatabase(f).close();
  // Remove every snapshot, so there is genuinely nothing to restore from.
  for (const snap of db.listSnapshots(f)) { try { fs.unlinkSync(snap); } catch (_) {} }
  for (const side of ['-wal', '-shm']) { try { fs.unlinkSync(f + side); } catch (_) {} }
  fs.writeFileSync(f, Buffer.from('garbage, and no snapshot exists'));
  const report = {};
  let d = null, threw = null;
  try { d = db.openDatabase(f, { report }); } catch (e) { threw = e; }
  assert(!threw && d, 'a corrupt database with nothing to restore no longer stops the app');
  assert(report.repaired && report.how === 'fresh' && report.salvagedRows === 0, 'the report says: repaired, a fresh database (nothing readable)');
  const aside = fs.readdirSync(path.dirname(f)).filter((n) => n.startsWith('e.db.damaged-') && !/-(wal|shm)$/.test(n));
  assert(aside.length === 1 && /garbage/.test(fs.readFileSync(path.join(path.dirname(f), aside[0]), 'utf8')), 'the damaged file is kept beside it, not deleted');
  const log = new MessageLog(d);
  log.ensureProject('P9', 'P9');
  log.append({ projectId: 'P9', from: 'user', body: 'works again' });
  assert(log.read('P9').length === 1, 'the fresh database works');
  d.close();
}

function testCorruptionSalvagesReadableRows() {
  console.log('\n== a damaged database: every row that can still be read is copied into the fresh one ==');
  const { DatabaseSync } = require('node:sqlite');
  const f = tmpFile('s.db');
  let d = db.openDatabase(f);
  const log = new MessageLog(d);
  log.ensureProject('P2', 'P2');
  for (let i = 0; i < 200; i++) log.append({ projectId: 'P2', from: 'user', body: `message ${i}` });
  d.close();
  for (const snap of db.listSnapshots(f)) { try { fs.unlinkSync(snap); } catch (_) {} }
  // damage it the way a crash can: an index points at the wrong page (integrity_check fails; the table still reads)
  const raw = new DatabaseSync(f);
  const rp = raw.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'projects'").get().rootpage;
  raw.exec('PRAGMA writable_schema=ON');
  raw.prepare("UPDATE sqlite_master SET rootpage = ? WHERE name = 'idx_messages_project_seq'").run(rp);
  raw.close();
  const report = {};
  d = db.openDatabase(f, { report });
  const rows = new MessageLog(d).read('P2');
  assert(report.repaired && report.how === 'fresh', 'the damage is found at start and repaired');
  assert(rows.length === 200 && rows[199].body === 'message 199', `all 200 readable messages are saved (${rows.length}, report ${report.salvagedRows})`);
  assert(d.prepare('PRAGMA integrity_check').get().integrity_check === 'ok', 'the new database is undamaged');
  d.close();
}

function testDailySnapshot() {
  console.log('\n== one snapshot a day, the newest 3 kept ==');
  const f = tmpFile('day.db');
  const t0 = Date.parse('2026-11-01T10:00:00Z');
  db.openDatabase(f, { now: t0 }).close();
  const daily = () => db.listSnapshots(f).filter((s) => /snap-daily-/.test(s));
  assert(daily().length === 1, 'the first start takes a snapshot');
  db.openDatabase(f, { now: t0 + 3600e3 }).close();
  assert(daily().length === 1, 'a second start the same day does not');
  for (let i = 1; i <= 5; i++) {
    for (const s of daily()) fs.utimesSync(s, new Date(t0 - 2 * 86400e3), new Date(t0 - 2 * 86400e3 - i * 1000)); // age them
    db.openDatabase(f, { now: t0 + i * 86400e3 }).close();
  }
  assert(daily().length === 3, `only the newest 3 daily snapshots are kept (${daily().length})`);
}

// ---- SCS-003: routing status handles multi-recipient fan-out sends ----------
function testMultiTargetRoutingStatus() {
  console.log('\n== SCS-003: a fan-out send to several known panes is RESOLVED, not a false warning ==');
  const f = tmpFile('routing.db');
  const d = db.openDatabase(f);
  const log = new MessageLog(d);
  log.ensureProject('P', 'P');

  const single = log.append({ projectId: 'P', from: 'user', to: 'claude', body: 'hi', status: 'SENT' });
  assert(single.routingStatus === 'RESOLVED', 'a single known recipient is RESOLVED');

  const multi = log.append({ projectId: 'P', from: 'user', to: 'chatgpt,claude,gemini', body: 'all', status: 'SENT' });
  assert(multi.routingStatus === 'RESOLVED', 'a comma-joined list of KNOWN panes is RESOLVED (was the false-warning bug)');

  const bad = log.append({ projectId: 'P', from: 'user', to: 'chatgpt,mystery', body: 'oops', status: 'SENT' });
  assert(bad.routingStatus === 'ROUTING_UNRESOLVED', 'a genuinely unknown recipient is still flagged');

  d.close();
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
  testCorruptionNoSnapshotStartsFresh();
  testCorruptionSalvagesReadableRows();
  testDailySnapshot();
  testAllSourcesOneOrderedLog();
  testMultiTargetRoutingStatus();
  testFailedWriteParkedNotPartial();
  testNumbersAreSystemAssigned();
  await testConcurrentNumbering();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('Test runner crashed:', e); process.exit(1); });
