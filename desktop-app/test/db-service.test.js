// test/db-service.test.js — the app-facing SQLite bridge: records the live
// conversation and reads it back, and degrades safely. Run: node test/db-service.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const svc = require('../db-service');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}

function testRecordsAndReads() {
  console.log('\n== db-service records captured turns and user messages, and reads them back ==');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlsvc-'));
  const s = svc.init(dir);
  assert(s.available, `the database initialized (${s.available ? s.file : s.reason})`);

  svc.recordUserMessage('write chapter one', ['claude']);
  svc.recordTurn({ site: 'claude', text: 'Here is chapter one.' });
  svc.recordTurn({ site: 'gemini', text: 'Continuity looks fine.' });

  const recent = svc.recent(10);
  assert(recent.length === 3, 'all three messages were recorded');
  assert(recent[0].from === 'user' && recent[1].from === 'claude' && recent[2].from === 'gemini', 'they read back in order across sources');
  assert(/^MSG-000001$/.test(recent[0].msgId), 'AutoInjector assigned the message numbers');
  assert(svc.status().count === 3, 'status() reports the live count');

  // empty/whitespace bodies are ignored, not recorded as blanks
  assert(svc.recordTurn({ site: 'claude', text: '   ' }) === null && svc.recent(10).length === 3, 'a blank capture is not recorded');
}

function testSafeWhenUninitialized() {
  console.log('\n== db-service degrades safely when not initialized ==');
  // Force the unavailable path by pointing init where a parent is a FILE, not a
  // directory — mkdir fails fast with ENOTDIR, exercising the catch path.
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atlbad-')), 'afile');
  fs.writeFileSync(f, 'x');
  const s = svc.init(path.join(f, 'sub', 'db.sqlite'));
  assert(!s.available, 'a broken location reports unavailable rather than hanging');
  // Either it initialized somewhere writable or it reported unavailable; either
  // way the methods must never throw.
  let threw = false;
  try { svc.recordTurn({ site: 'claude', text: 'x' }); svc.recent(5); svc.status(); }
  catch (_) { threw = true; }
  assert(!threw, 'recordTurn/recent/status never throw, even on a bad init');
  assert(typeof s.available === 'boolean', 'init always returns a status object');
}

function testMemoryAndState() {
  console.log('\n== db-service exposes memory (create/search/summary) and project state ==');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlsvc2-'));
  svc.init(dir);

  const a = svc.memoryCreate('character', { name: 'Mara Vey', notes: 'keeps the lighthouse lens' });
  const b = svc.memoryCreate('task', { title: 'Draft chapter 7' });
  assert(a.ok && /^CHAR-/.test(a.id) && b.ok && /^TASK-/.test(b.id), 'memoryCreate stores typed entities with prefixed ids');

  const bad = svc.memoryCreate('character', {});
  assert(!bad.ok && /required/.test(bad.error), 'a schema-invalid create is rejected with a reason');

  const sum = svc.memorySummary();
  assert(sum.available && sum.total === 2 && sum.counts.character === 1, 'memorySummary counts entities per type');

  const found = svc.memorySearch('lighthouse');
  assert(found.available && found.results.length === 1 && found.results[0].title === 'Mara Vey', 'memorySearch returns the matching entity with a title');
  assert(svc.memorySearch('').results.length === 0, 'an empty query returns no results (no crash)');

  const st = svc.projectState();
  assert(st.available && Array.isArray(st.readPositions) && Array.isArray(st.ownedTasks), 'projectState returns the sync/ownership/artifact snapshot');
}

function testRecordImage() {
  console.log('\n== db-service records a Stable Diffusion render as a searchable project image ==');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlimg-'));
  svc.init(dir);
  const row = svc.recordImage({ prompt: 'a lighthouse at dusk', seed: 42, from: 'claude', path: '/tmp/sd-images/img-1.png', sha256: 'abc123' });
  assert(row && /^IMG-/.test(row.id), 'the render is stored as an IMG- entity');
  const imgs = svc.imageEntries();
  assert(imgs.length === 1 && imgs[0].prompt === 'a lighthouse at dusk' && imgs[0].from === 'claude', 'imageEntries returns it with prompt and requester');
  const found = svc.memorySearch('lighthouse');
  assert(found.available && found.results.some((r) => r.type === 'image'), 'the image is findable via project memory search');
}

function main() {
  testRecordsAndReads();
  testMemoryAndState();
  testRecordImage();
  testSafeWhenUninitialized();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
