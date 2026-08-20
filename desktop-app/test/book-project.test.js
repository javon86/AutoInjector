// test/book-project.test.js — the on-disk book project model + the V2 prompts.
// Uses a throwaway books dir. Run: node test/book-project.test.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const bp = require("../book-project");
const prompts = require("../book-prompts");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}

function main() {
  const books = fs.mkdtempSync(path.join(os.tmpdir(), "books-"));
  bp.init(books);

  console.log("\n== create + list + persistence ==");
  const c = bp.create("My Great Novel");
  assert(c.ok && /^PRJ-\d+$/.test(c.project.id), "create returns a PRJ id");
  assert(fs.existsSync(path.join(books, "My Great Novel", "book.json")), "a book folder with book.json is written");
  const id = c.project.id;
  assert(bp.create("My Great Novel").ok === false, "a duplicate title is refused");
  const c2 = bp.create("Second Book");
  assert(c2.ok && c2.project.id !== id, "a second book gets its own id");
  assert(bp.list().length === 2, "list() shows both books");

  console.log("\n== stages ==");
  assert(bp.setStage(id, "drafting").ok, "stage can advance to a known value");
  assert(bp.setStage(id, "nonsense").ok === false, "an unknown stage is refused");
  assert(bp.get(id).stage === "drafting", "the stage is saved");

  console.log("\n== chapters + status ==");
  const ch = bp.addChapter(id, "Arrival");
  assert(ch.ok && ch.chapterId === "CH-001", "first chapter is CH-001");
  bp.addChapter(id, "The Letter");
  assert(bp.get(id).chapters.length === 2 && bp.get(id).chapters[1].id === "CH-002", "chapter ids increment");
  assert(fs.existsSync(path.join(books, "My Great Novel", "chapters", "CH-001.md")), "a chapter manuscript file is created");
  assert(bp.setChapterStatus(id, "CH-001", "LOCKED").ok, "chapter status can be set");
  assert(bp.setChapterStatus(id, "CH-001", "bogus").ok === false, "an unknown status is refused");
  assert(bp.get(id).chapters[0].status === "LOCKED", "the status is saved");

  console.log("\n== records ==");
  const r = bp.addRecord(id, "REQ", "Hero must lose the sword", "Full requirement text.");
  assert(r.ok && r.recordId === "REQ-001", "first REQ is REQ-001");
  bp.addRecord(id, "CHR", "Protagonist");
  assert(bp.addRecord(id, "ZZZ", "x").ok === false, "an unknown record type is refused");
  assert(bp.listRecords(id).length === 2, "records are listed");
  const read = bp.readRecord(id, "REQ-001");
  assert(read.ok && /Full requirement text/.test(read.content), "a record's content reads back");
  const readCh = bp.readRecord(id, "CH-001");
  assert(readCh.ok && /CH-001/.test(readCh.content), "a chapter's manuscript reads back by id too");

  console.log("\n== log + persistence across a 'restart' ==");
  bp.appendLog(id, "sent to Claude (Write)");
  const before = bp.get(id).log.length;
  assert(before >= 5, "the activity log accumulates entries");
  // Simulate a new session: re-init the same books dir and re-read.
  bp.init(books);
  const reopened = bp.get(id);
  assert(reopened && reopened.title === "My Great Novel" && reopened.log.length === before,
    "everything persists — a new session recalls the saved book by id");

  console.log("\n== V2 prompts compose correctly ==");
  const task = prompts.composeTask("story-review", { title: "My Great Novel", chapter: "CH-001" });
  assert(task && task.target === "chatgpt" && /STORY/.test(task.text) && /Review ID: REV/.test(task.text),
    "story-review composes for ChatGPT and includes the review schema");
  const write = prompts.composeTask("write");
  assert(write.target === "claude", "the write task targets Claude");
  const briefs = prompts.composeBriefAll(reopened);
  assert(briefs.length === 3 && briefs.some((b) => b.target === "gemini" && /caught up/.test(b.text)),
    "a brief is produced for all three panes to catch them up on the book");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
