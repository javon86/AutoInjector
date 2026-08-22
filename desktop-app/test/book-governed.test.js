// test/book-governed.test.js — BG-001: New Book scaffolds the governed ATELIER
// (v2) tree and it becomes canonical; chapters live in 04_CHAPTERS between the
// strict manuscript markers; BG-007 strict assembly builds the manuscript.
// Requires Python 3 (the ATELIER engine). Skips cleanly if it isn't present.
// Run: node test/book-governed.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const bp = require('../book-project');
const bridge = require('../atelier-bridge');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

function main() {
  const books = fs.mkdtempSync(path.join(os.tmpdir(), 'gbooks-'));
  bp.init(books);
  const governed = bp.configure({ atelier: bridge });
  if (!governed) {
    console.log('\n== governed (ATELIER v2) mode ==\n  SKIP - Python 3 / ATELIER not available; V1 fallback is exercised elsewhere');
    console.log('\n0 passed, 0 failed');
    process.exit(0);
  }

  console.log('\n== New Book scaffolds the governed tree and marks it canonical ==');
  const c = bp.create('The Salt Line');
  assert(c.ok && c.project.id, 'a governed book is created');
  const id = c.project.id;
  const proj = bp.get(id);
  assert(proj.governed === true, 'the book is flagged governed (v2)');
  assert(fs.existsSync(path.join(proj.dir, '00_CONTROL', 'STATE.md')), 'the governed 00_CONTROL/STATE.md exists');
  assert(fs.existsSync(path.join(proj.dir, '04_CHAPTERS')), 'the governed 04_CHAPTERS/ exists');
  assert(bp.create('The Salt Line').ok === false, 'a duplicate governed title is refused');

  console.log('\n== chapters are the single source, in 04_CHAPTERS with strict markers ==');
  const ch = bp.addChapter(id, 'Voices Went First');
  assert(ch.ok && ch.chapterId === 'CH-001', 'first chapter is CH-001');
  const scene = path.join(proj.dir, '04_CHAPTERS', 'CH-001', 'scenes', 's01.md');
  assert(fs.existsSync(scene), 'the chapter manuscript lives at 04_CHAPTERS/CH-001/scenes/s01.md');
  assert(/-----< Start >-----/.test(fs.readFileSync(scene, 'utf8')), 'the scene has the strict manuscript boundary markers');
  // The write step fills the manuscript body between the markers.
  bp.recordStepOutput(id, { index: 5, stepId: 'write', target: 'claude', label: 'Write the chapter', text: 'The salt line held through the night.', chapterId: 'CH-001', sourceTurnId: 42 });
  const filled = fs.readFileSync(scene, 'utf8');
  assert(/salt line held/.test(filled), 'the write step writes the body into the governed scene');

  console.log('\n== BG-003: the chapter is routed through the governed gateway with provenance ==');
  const prov = bp.get(id).provenance || [];
  const chapterProv = prov.find((p) => p.stepId === 'write' && p.delivered);
  assert(chapterProv && chapterProv.role === 'claude' && /04_CHAPTERS/.test(chapterProv.target),
    'the chapter delivery is recorded (role claude → 04_CHAPTERS)');
  assert(chapterProv && /^[0-9a-f]{64}$/.test(chapterProv.sha256) && chapterProv.sourceTurnId != null,
    'provenance carries the content sha256 and the source turn id');
  // The governed DELIVERIES ledger on disk holds the same digest (provenance).
  const deliveries = path.join(proj.dir, '00_CONTROL', 'DELIVERIES.json');
  assert(fs.existsSync(deliveries) && fs.readFileSync(deliveries, 'utf8').includes(chapterProv.sha256),
    'the ATELIER DELIVERIES.json records the same digest');

  console.log('\n== BG-007: strict assembly builds the manuscript ==');
  const asm = bp.assembleManuscript(id);
  assert(asm.ok, 'strict assembly succeeds');
  if (asm.ok) {
    const man = fs.readFileSync(path.join(proj.dir, '07_BUILD', 'manuscript.md'), 'utf8');
    assert(/salt line held/.test(man), 'the assembled manuscript contains the chapter body');
    assert(!/Start >-----/.test(man), 'the assembled manuscript excludes the marker/notes (only in-book text)');
  }

  console.log('\n== reopening reconstructs the governed book ==');
  bp.init(books); bp.configure({ atelier: bridge });
  const re = bp.get(id);
  assert(re && re.governed === true && re.chapters.length === 1 && re.title === 'The Salt Line',
    'a new session recalls the governed book, its stage and chapters');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
