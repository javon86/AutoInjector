// test/files.test.js — task ownership + the shared file gateway, each against
// its "Done when":
//   SCS-013 a second assignment on an owned task is refused; expired lease returns it
//   MDC-009 all file access flows through the gateway; policy-checked; atomic; versioned
//   MDC-007 a model requests a file by name; logged; unknown→suggestions; denied→ACCESS_DENIED
// Run: node test/files.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../shared/db');
const { MessageLog } = require('../shared/message-log');
const { TaskOwnership } = require('../shared/ownership');
const { FileManager } = require('../shared/file-manager');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}
function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlfile-'));
  const d = db.openDatabase(path.join(dir, 'm.db'));
  new MessageLog(d).ensureProject('P', 'P');
  return { d, root: path.join(dir, 'files') };
}

// ---- SCS-013 ---------------------------------------------------------------
function testOwnership() {
  console.log('\n== SCS-013: an owned task refuses a second claim; an expired lease returns it to the queue ==');
  const { d } = fresh();
  let t = 1000000;
  const own = new TaskOwnership(d, { now: () => t, leaseMs: 10000 });

  const first = own.claim('P', 'TASK-027', 'claude');
  assert(first.granted && own.owner('P', 'TASK-027') === 'claude', 'the first claim is granted');

  const second = own.claim('P', 'TASK-027', 'gemini');
  assert(!second.granted && /owned by claude/.test(second.reason), 'a second model is refused with a clear reason');

  assert(own.claim('P', 'TASK-027', 'claude').renewed, 'the owner can renew its own lease');

  t += 10001; // lease elapses
  const takeover = own.claim('P', 'TASK-027', 'gemini');
  assert(takeover.granted && takeover.tookOverFrom === 'claude', 'after the lease expires another model may take over');
  assert(d.prepare("SELECT COUNT(*) c FROM system_log WHERE code='OWNER_LEASE_EXPIRED'").get().c === 1, 'the expiry is logged as OWNER_LEASE_EXPIRED');

  const rel = own.release('P', 'TASK-027', 'claude');
  assert(!rel.released, 'a non-owner cannot release the task');
  assert(own.release('P', 'TASK-027', 'gemini').released, 'the real owner can release it');

  own.claim('P', 'TASK-050', 'claude', { leaseMs: 1000 });
  t += 2000;
  const swept = own.sweepExpired();
  assert(swept.includes('TASK-050') && own.owner('P', 'TASK-050') === null, 'sweepExpired() releases a crashed owner\'s lease');
  d.close();
}

// ---- MDC-009 ---------------------------------------------------------------
function testFileGateway() {
  console.log('\n== MDC-009: writes are policy-checked, atomic, and versioned; a denied write leaves the file intact ==');
  const { d, root } = fresh();
  const fm = new FileManager(d, root, { projectId: 'P' });

  const w1 = fm.write('claude', '04_CHAPTERS/ch01/scenes/s01.md', 'chapter one v1');
  assert(w1.ok && w1.version === 1, 'claude may write a chapter (version 1)');
  const r1 = fm.read('claude', '04_CHAPTERS/ch01/scenes/s01.md');
  assert(r1.ok && r1.body === 'chapter one v1' && r1.version === 1, 'the file reads back through the gateway at version 1');

  const w2 = fm.write('claude', '04_CHAPTERS/ch01/scenes/s01.md', 'chapter one v2');
  assert(w2.version === 2 && fm.read('claude', '04_CHAPTERS/ch01/scenes/s01.md').body === 'chapter one v2', 'a second write bumps to version 2');

  const denied = fm.write('gemini', '04_CHAPTERS/ch01/scenes/s01.md', 'auditor overwriting a chapter');
  assert(!denied.ok && denied.error === 'ACCESS_DENIED', 'the auditor is denied write access to a chapter');
  assert(fm.read('claude', '04_CHAPTERS/ch01/scenes/s01.md').body === 'chapter one v2', 'the denied write left the previous version untouched');

  const traversal = fm.write('claude', '04_CHAPTERS/../../../etc/passwd', 'escape');
  assert(!traversal.ok && traversal.error === 'BAD_PATH', 'a path-traversal write is rejected');
  assert(!fm.list().some((f) => f.includes('passwd')), 'no escaped file was created anywhere under the project root');

  assert(fm.artifacts.history('P', '04_CHAPTERS/ch01/scenes/s01.md').length === 2, 'the artifact store holds the full version history');
  d.close();
}

// ---- MDC-007 ---------------------------------------------------------------
function testFileRequests() {
  console.log('\n== MDC-007: a file request returns the current version and is logged; misses suggest, denials say ACCESS_DENIED ==');
  const { d, root } = fresh();
  const fm = new FileManager(d, root, { projectId: 'P' });
  fm.write('chatgpt', '01_DESIGN/BLUEPRINT.md', '# Blueprint');

  const ok = fm.request('claude', '01_DESIGN/BLUEPRINT.md');
  assert(ok.ok && ok.version === 1, 'a valid request returns the authoritative current version');
  const logged = fm.requests('claude');
  assert(logged.length === 1 && logged[0].path === '01_DESIGN/BLUEPRINT.md' && logged[0].result === 'OK', 'the request is logged with requester, file and result');

  const miss = fm.request('claude', 'BLUEPRINT.md'); // right name, wrong path
  assert(!miss.ok && miss.error === 'FILE_NOT_FOUND', 'an unknown file returns FILE_NOT_FOUND (not an empty body)');
  assert(miss.suggestions.includes('01_DESIGN/BLUEPRINT.md'), 'the closest matching name is suggested');

  const denied = fm.request('deepseek', '01_DESIGN/BLUEPRINT.md'); // unknown model
  assert(!denied.ok && denied.error === 'ACCESS_DENIED', 'an unknown requester is denied with an explicit reason');
  assert(fm.requests().some((r) => r.result === 'FILE_NOT_FOUND') && fm.requests().some((r) => r.result === 'ACCESS_DENIED'),
    'both the miss and the denial are recorded in the request log');
  d.close();
}

function main() {
  testOwnership();
  testFileGateway();
  testFileRequests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
