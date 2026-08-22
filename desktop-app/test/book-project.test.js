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

  console.log("\n== stages (BG-004 transitions) ==");
  assert(bp.setStage(id, "planning").ok, "stage can advance one step (setup → planning)");
  assert(bp.setStage(id, "nonsense").ok === false, "an unknown stage is refused");
  assert(bp.setStage(id, "assembly").ok === false, "skipping several stages forward is refused");
  assert(bp.setStage(id, "assembly", { override: true, reason: "test" }).ok, "an override can jump stages, with a reason");
  assert(bp.setStage(id, "planning").ok, "moving backward (assembly → planning) is allowed");
  assert(bp.setStage(id, "roadmap").ok, "and forward one again");
  assert(bp.get(id).stage === "roadmap", "the stage is saved");

  console.log("\n== chapters + status ==");
  const ch = bp.addChapter(id, "Arrival");
  assert(ch.ok && ch.chapterId === "CH-001", "first chapter is CH-001");
  bp.addChapter(id, "The Letter");
  assert(bp.get(id).chapters.length === 2 && bp.get(id).chapters[1].id === "CH-002", "chapter ids increment");
  assert(fs.existsSync(path.join(books, "My Great Novel", "chapters", "CH-001.md")), "a chapter manuscript file is created");
  assert(bp.setChapterStatus(id, "CH-001", "bogus").ok === false, "an unknown status is refused");
  // BG-004: transitions are enforced — no lock without a review first.
  assert(bp.setChapterStatus(id, "CH-001", "LOCKED").ok === false, "NOT STARTED → LOCKED is refused (must review first)");
  assert(bp.setChapterStatus(id, "CH-001", "DRAFTING").ok, "NOT STARTED → DRAFTING is allowed");
  assert(bp.setChapterStatus(id, "CH-001", "IN REVIEW").ok, "DRAFTING → IN REVIEW is allowed");
  assert(bp.setChapterStatus(id, "CH-001", "LOCKED").ok, "IN REVIEW → LOCKED is allowed");
  assert(bp.get(id).chapters[0].status === "LOCKED", "the status is saved");
  // An override can force an otherwise-disallowed transition, with a reason.
  assert(bp.setChapterStatus(id, "CH-001", "DRAFTING", { override: true, reason: "reopen for edits" }).ok, "an override forces a disallowed transition");
  assert(bp.setChapterStatus(id, "CH-001", "IN REVIEW").ok && bp.setChapterStatus(id, "CH-001", "LOCKED").ok, "re-lock after override");

  console.log("\n== records ==");
  const r = bp.addRecord(id, "REQ", "Hero must lose the sword", "Full requirement text.");
  assert(r.ok && r.recordId === "REQ-001", "first REQ is REQ-001");
  bp.addRecord(id, "CHR", "Protagonist");
  assert(bp.addRecord(id, "ZZZ", "x").ok === false, "an unknown record type is refused");
  assert(bp.listRecords(id).length === 2, "records are listed");
  // BG-005: a record's content can be edited (no more permanent empty shells).
  const empty = bp.addRecord(id, "CHR", "Antagonist"); // created with no content
  assert(bp.setRecordContent(id, empty.recordId, "The villain's full profile.").ok, "a record's content can be edited");
  assert(/villain's full profile/.test(bp.readRecord(id, empty.recordId).content), "the edited content reads back");
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

  console.log("\n== workflow runner: starts with ChatGPT intake, steps in order, persists ==");
  const step0 = prompts.composeStep(0, {});
  assert(step0 && step0.target === "chatgpt" && /questionnaire/i.test(step0.text) && step0.index === 0,
    "step 0 is ChatGPT's intake questionnaire");
  assert(prompts.WORKFLOW.length >= 10 && prompts.composeStep(prompts.WORKFLOW.length) === null,
    "the workflow has a defined length and stops at the end");
  bp.setWorkflow(id, { status: "running", step: 0 }, "started");
  assert(bp.get(id).workflow.status === "running" && bp.get(id).workflow.step === 0, "workflow state is saved");
  bp.setWorkflow(id, { step: 3 });
  bp.init(books); // new session
  assert(bp.get(id).workflow.step === 3, "workflow position survives a restart (resume where you left off)");
  bp.setWorkflow(id, { status: "paused" }, "paused");
  assert(bp.get(id).workflow.status === "paused", "workflow can be paused and stays paused");

  console.log("\n== step output is saved to disk (so the book HOLDS each step's result) ==");
  const outline = bp.recordStepOutput(id, { index: 2, stepId: "outline", target: "chatgpt", label: "Master chapter outline", text: "1. Arrival\n2. The Letter" });
  assert(outline.ok && /steps[\\/]/.test(outline.file), "recordStepOutput writes a steps/ file");
  assert(fs.existsSync(path.join(books, "My Great Novel", outline.file)), "the step output file exists on disk");
  assert(fs.readFileSync(path.join(books, "My Great Novel", outline.file), "utf8").includes("The Letter"), "the AI's output text is in the file");
  assert(bp.get(id).workflow.outputs && bp.get(id).workflow.outputs.outline && bp.get(id).workflow.outputs.outline.target === "chatgpt",
    "the output is indexed in workflow.outputs by step id");
  // The write step's output becomes the chapter manuscript (CH-002 is unlocked).
  const wrote = bp.recordStepOutput(id, { index: 5, stepId: "write", target: "claude", label: "Write the chapter", text: "It was a dark and stormy night.", chapterId: "CH-002" });
  assert(wrote.ok, "write-step output is recorded");
  const chRead = bp.readRecord(id, "CH-002");
  assert(chRead.ok && /dark and stormy night/.test(chRead.content), "the write step's text is written into the chapter manuscript");
  assert(bp.get(id).chapters[1].status === "DRAFTING", "writing a chapter advances its status out of NOT STARTED");
  // A LOCKED chapter's manuscript is never overwritten by a later write step.
  bp.recordStepOutput(id, { index: 5, stepId: "write", target: "claude", label: "Write the chapter", text: "OVERWRITE ATTEMPT", chapterId: "CH-001" });
  const locked = bp.readRecord(id, "CH-001");
  assert(locked.ok && !/OVERWRITE ATTEMPT/.test(locked.content), "a LOCKED chapter is protected from write-step overwrite");

  console.log("\n== PDF completion gate (Rules 36–39): filled-out work becomes a downloadable PDF ==");
  // recordStepOutput already produced PDFs above — a step output and a chapter.
  const pdfs = bp.listPdfs(id);
  assert(pdfs.length >= 2 && pdfs.every((p) => p.exists), `PDFs were generated and exist on disk (${pdfs.length})`);
  const outlinePdf = pdfs.find((p) => /Master Chapter Outline\.pdf$/.test(p.file));
  assert(outlinePdf, "the outline step produced a rules-named PDF");
  const pdfBytes = fs.readFileSync(path.join(books, "My Great Novel", outlinePdf.file));
  assert(pdfBytes.slice(0, 5).toString() === "%PDF-" && pdfBytes.slice(-5).toString().includes("EOF"), "the PDF is a real, valid PDF file");
  const chapterPdf = pdfs.find((p) => /Chapter 02/.test(p.file));
  assert(chapterPdf, "the write step produced a Chapter PDF named per the rules");
  // The gate reports which deliverables have a PDF.
  const gate = bp.pdfGate(id);
  assert(gate.total >= 2 && gate.present >= 1, `the gate lists deliverables and how many have PDFs (${gate.present}/${gate.total})`);
  assert(gate.items.some((i) => i.type === "Chapter" && i.present), "a chapter shows as PDF-present in the gate");
  // generateAllPdfs re-makes everything on demand.
  const all = bp.generateAllPdfs(id);
  assert(all.ok && all.made >= 2, `generateAllPdfs (re)creates the book's PDFs (${all.made})`);
  // Finding a downloaded PDF: drop a matching file in a temp "downloads" dir.
  const dl = fs.mkdtempSync(path.join(os.tmpdir(), "dl-"));
  fs.writeFileSync(path.join(dl, "My Great Novel - Character Master Record - Hero.pdf"), "%PDF-1.4\n%%EOF");
  fs.writeFileSync(path.join(dl, "Unrelated Book - notes.pdf"), "%PDF-1.4\n%%EOF");
  const scan = bp.scanPdfs(id, [dl]);
  assert(scan.ok && scan.imported.some((f) => /Character Master Record/.test(f)) && !scan.imported.some((f) => /Unrelated/.test(f)),
    "scanPdfs finds & imports downloaded PDFs for THIS book only");
  assert(bp.listPdfs(id).some((p) => /Character Master Record/.test(p.file)), "the imported PDF is registered with the book");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
