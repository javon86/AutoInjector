// test/memory.test.js — TASK 2 shared-memory subtasks, each against its "Done when":
//   MDC-002 typed entities: stable ID prefix, timestamps, project FK; schema-validated writes; orphans rejected
//   MDC-003 FTS5 search across entity types (fast), with a LIKE fallback path
//   MDC-008 artifact version/hash tracking; integrity check offers the previous good version
// Run: node test/memory.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../shared/db');
const { MemoryStore, Search } = require('../shared/memory');
const { ArtifactStore, sha256 } = require('../shared/artifacts');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}
function freshDb() {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atlmem-')), 'm.db');
  const d = db.openDatabase(f);
  new (require('../shared/message-log').MessageLog)(d).ensureProject('P', 'P');
  return d;
}

// ---- MDC-002 ---------------------------------------------------------------
function testTypedEntities() {
  console.log('\n== MDC-002: every entity type has a stable ID prefix, timestamps and a project FK ==');
  const d = freshDb();
  const mem = new MemoryStore(d);

  const ch = mem.create('character', 'P', { name: 'Mara Vey', role: 'lighthouse keeper' });
  assert(/^CHAR-000001$/.test(ch.id), 'a character gets the CHAR- prefix and a per-project number');
  assert(ch.created_at && ch.updated_at && ch.project_id === 'P', 'it carries created/updated timestamps and the project id');

  const task = mem.create('task', 'P', { title: 'Draft chapter 7' });
  const dec = mem.create('decision', 'P', { summary: 'Ending stays ambiguous' });
  assert(task.id === 'TASK-000001' && dec.id === 'DEC-000001', 'each type keeps its own prefixed counter');

  const ch2 = mem.create('character', 'P', { name: 'Ivor Cobb' });
  assert(ch2.id === 'CHAR-000002', 'the character counter advances independently');
  d.close();
}

function testSchemaValidation() {
  console.log('\n== MDC-002: writes are validated against the type schema with a specific field-level reason ==');
  const d = freshDb();
  const mem = new MemoryStore(d);

  let msg = '';
  try { mem.create('character', 'P', { role: 'no name given' }); } catch (e) { msg = e.message; }
  assert(/character\.name is required/.test(msg), 'a missing required field is rejected by name: ' + JSON.stringify(msg));

  msg = '';
  try { mem.create('character', 'P', { name: 'X', hair: 'red' }); } catch (e) { msg = e.message; }
  assert(/character\.hair: unknown field/.test(msg), 'an unknown field is rejected by name');

  msg = '';
  try { mem.create('dragon', 'P', { name: 'X' }); } catch (e) { msg = e.message; }
  assert(/unknown entity type "dragon"/.test(msg), 'an unknown entity type is rejected');
  d.close();
}

function testOrphanRejected() {
  console.log('\n== MDC-002: an orphaned row (unknown project) is rejected at write time ==');
  const d = freshDb();
  const mem = new MemoryStore(d);
  let threw = false;
  try { mem.create('task', 'NO_SUCH_PROJECT', { title: 'orphan' }); } catch (_) { threw = true; }
  assert(threw, 'creating an entity for a nonexistent project fails on the foreign key');
  d.close();
}

// ---- MDC-003 ---------------------------------------------------------------
function testFullTextSearch() {
  console.log('\n== MDC-003: full-text search returns results across entity types, fast ==');
  const d = freshDb();
  const mem = new MemoryStore(d);
  mem.create('character', 'P', { name: 'Mara Vey', notes: 'tends the lighthouse lens nightly' });
  mem.create('decision', 'P', { summary: 'The lighthouse lens is salvaged, not replaced' });
  mem.create('task', 'P', { title: 'Buy groceries' });
  // bulk to make the timing test meaningful
  for (let i = 0; i < 300; i++) mem.create('fact', 'P', { statement: `filler fact number ${i}` });

  const search = new Search(d);
  const t0 = Date.now();
  const res = search.search('P', 'lighthouse lens');
  const elapsed = Date.now() - t0;
  const ids = res.results.map((r) => r.id);
  assert(!res.degraded && res.results.length === 2, 'a phrase search finds the two matching records across types');
  assert(res.results.some((r) => r.type === 'character') && res.results.some((r) => r.type === 'decision'),
    'results span multiple entity types');
  assert(elapsed < 1000, `search completes in under a second (${elapsed}ms on 303 records)`);
  assert(ids.every((id) => id), 'every hit resolves to a real entity id');
  d.close();
}

function testSearchRebuildAndFallback() {
  console.log('\n== MDC-003: a stale index rebuilds; FTS failure falls back to LIKE, flagged DEGRADED ==');
  const d = freshDb();
  const mem = new MemoryStore(d);
  mem.create('character', 'P', { name: 'Mara Vey' });
  d.exec('DELETE FROM mem_fts'); // simulate a lost/stale index
  const search = new Search(d);
  search.ensureIndex();          // should rebuild from the entity tables
  assert(search.search('P', 'Mara').results.length === 1, 'search works again after an automatic rebuild');

  const fallback = search._likeFallback('P', 'Mara');
  assert(fallback.degraded && fallback.results.length === 1, 'the LIKE fallback still finds the record and flags DEGRADED');
  d.close();
}

// ---- MDC-008 ---------------------------------------------------------------
function testArtifactVersioning() {
  console.log('\n== MDC-008: artifacts are versioned and hash-verified; history is complete ==');
  const d = freshDb();
  const art = new ArtifactStore(d);

  const v1 = art.put('P', 'BLUEPRINT.md', '# Blueprint v1');
  const v2 = art.put('P', 'BLUEPRINT.md', '# Blueprint v2 (revised)');
  assert(v1.version === 1 && v2.version === 2, 'each write is a new version');
  assert(v2.sha256 === sha256('# Blueprint v2 (revised)'), 'the recorded hash matches the content');

  const got = art.get('P', 'BLUEPRINT.md');
  assert(got.ok && got.version === 2 && got.body === '# Blueprint v2 (revised)', 'get() returns the authoritative current version');
  assert(art.verify('P', 'BLUEPRINT.md'), 'the current version verifies against its recorded hash');
  assert(art.history('P', 'BLUEPRINT.md').length === 2, 'the full version history is retained');
  d.close();
}

function testArtifactIntegrityFailure() {
  console.log('\n== MDC-008: a hash mismatch blocks delivery and offers the previous verified version ==');
  const d = freshDb();
  const art = new ArtifactStore(d);
  art.put('P', 'CH04.md', 'chapter four, first draft');       // v1 (good)
  art.put('P', 'CH04.md', 'chapter four, revised draft');     // v2 (will be tampered)

  // Tamper with the stored bytes of v2 without updating its recorded hash.
  d.prepare("UPDATE artifact_versions SET body = 'TAMPERED' WHERE path='CH04.md' AND version=2").run();

  const got = art.get('P', 'CH04.md');
  assert(!got.ok && got.error === 'ARTIFACT_INTEGRITY_FAIL', 'a tampered current version is refused, not delivered');
  assert(got.offered && got.offered.version === 1 && got.offered.body === 'chapter four, first draft',
    'the previous verified version is offered instead');
  assert(d.prepare("SELECT COUNT(*) c FROM system_log WHERE code='ARTIFACT_INTEGRITY_FAIL'").get().c === 1, 'the integrity failure is logged');
  d.close();
}

function main() {
  testTypedEntities();
  testSchemaValidation();
  testOrphanRejected();
  testFullTextSearch();
  testSearchRebuildAndFallback();
  testArtifactVersioning();
  testArtifactIntegrityFailure();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
