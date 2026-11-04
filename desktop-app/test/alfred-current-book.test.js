// test/alfred-current-book.test.js — 🎩 Alfred talks about the book we are working on NOW.
//
// Real PC (build f1265f4): Akọwe's run for "The Last Soundkeep" (saved as "The Winter the Ocean Turned to Glass")
// was paused at step 3 of 16 "Characters and places" on an AI reviewer's REVISE. Asked "why do we have this error"
// Alfred explained an OLD book's outline problem (POV character "odile-marsh"), and asked "the name of the book we're
// working on right now" he said "The Lamplighter's Last Ferry" — an old book. Cause: his "current book" guess sorted
// by fields Akọwe never sent (so: the first, oldest book), ignored the paused run, listed books by project name, and
// nothing live told his AI which book is current. These tests rebuild that state: two books, the old one with an old
// outline problem, the newer one paused at Characters and places with a REVISE problem.
// Run: node test/alfred-current-book.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const registry = require('../alfred-tools');
const { createAlfred } = require('../alfred');
const { peekPath, openBookFromUrl } = require('../alfred-main');
const { fakeLlm, toolCall, lastMsg } = require('./alfred-fakes');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-cur-'));

const OLD = 'proj-2ff70c8f7f65';
const NEW = 'proj-9a1c0d2e3f40';
const steps16 = (done, cur, names = {}) => Array.from({ length: 16 }, (_, i) => ({ id: `s${i}`, title: names[i] || `Step ${i + 1}`, state: i < done ? 'done' : i === done ? cur : 'pending' }));
const REVISE_MSG = "The AI reviewer still says REVISE for the entry 'Silas Rook is the principal antagonist…' after 2 fixes.";

/** Akọwe as the user's PC had it. Projects come oldest first (like Akọwe); the OLD run is listed first on purpose. */
function world(opts = {}) {
  const requests = [];
  const projects = [
    { project_id: OLD, name: "The Lamplighter's Last Ferry", created_at: '2026-09-02T10:00:00Z', profile: { title: "The Lamplighter's Last Ferry" } },
    // the project's name is the first idea / saved folder; the author's title (profile) is what the run shows
    { project_id: NEW, name: 'The Winter the Ocean Turned to Glass', created_at: '2026-08-20T09:00:00Z', profile: { title: 'The Last Soundkeep', author: 'Elian Voss' } },
  ];
  if (opts.akoweMarksOpen) projects[1].open = true, projects[1].last_opened_at = '2026-10-31T21:00:00Z';
  const oldRun = { id: 'ab-old', project_id: OLD, title: "The Lamplighter's Last Ferry", status: 'paused', updated_at: '2026-10-02T08:00:00Z',
    steps: steps16(5, 'paused', { 5: 'Chapter outline' }),
    problem: { code: 'CHECKS_REFUSED', message: "The chapter outline names a POV character 'odile-marsh' who is not in the canon.", options: ['retry'] } };
  const newRun = { id: 'ab-new', project_id: NEW, title: 'The Last Soundkeep', status: 'paused', state: 'needs_decision', needs_decision: true, needs_you: true,
    state_words: 'Paused: it needs your decision (approve anyway, edit it, or try again).', updated_at: '2026-10-31T21:05:00Z', steps_done: 2, steps_total: 16,
    steps: steps16(2, 'paused', { 0: 'Backup', 1: 'Book profile', 2: 'Characters and places' }),
    phase: '⚠️ Characters and places: needs you',
    problem: { code: 'REVIEW_NOT_PASSED', message: REVISE_MSG, verdict: 'REVISE', record_id: 'rec-silas', step: 'canon',
      fix: 'Decide: ✔ Approve anyway (your own approval), ✏️ Edit it yourself and then press Continue, or 🔁 Try again (the AI gets two more fixes).',
      reasons: ["The character ID 'silas-rook-2' does not match the approved canon entry 'silas-rook'."],
      where: { book: 'The Last Soundkeep', step: 'Characters and places' }, options: ['approve_anyway', 'edit', 'retry'] } };
  const journals = {
    [OLD]: { entries: [{ at: '2026-10-02T08:00:00Z', what: "POV character 'odile-marsh' is missing from the canon (chapter outline)", problem: { code: 'CHECKS_REFUSED' } }] },
    [NEW]: { entries: [{ at: '2026-10-31T21:05:00Z', what: 'AI review: REVISE (Silas Rook)', problem: { code: 'REVISE' } }] },
  };
  const books = {
    [OLD]: { steps: [{ id: 'profile', title: 'Book profile', state: 'done' }, { id: 'outline', title: 'Chapter outline', state: 'needs_you' }] },
    [NEW]: { steps: [{ id: 'profile', title: 'Book profile', state: 'done' }, { id: 'canon', title: 'Characters and places', state: 'needs_you' }] },
  };
  const autobook = () => ({ runs: [oldRun, newRun], active: [], current: opts.noCurrent ? undefined : newRun });
  const ctx = {
    akowe: async (m, p) => {
      requests.push(`${m} ${p}`);
      if (m === 'GET' && p === '/api/projects') return { status: 200, json: projects };
      if (m === 'GET' && p === '/api/autobook') return { status: 200, json: autobook() };
      if (m === 'GET' && p === '/api/slots/states') return { status: 200, json: { slots: [{ slot_id: 'AI-1', name: 'Claude', state: 'ok', word: 'works' }] } };
      const mm = /^\/api\/projects\/([^/]+)\/branches\/main\/(book|journal)/.exec(p);
      if (m === 'GET' && mm) return { status: 200, json: mm[2] === 'book' ? books[mm[1]] : journals[mm[1]] };
      return { status: 404, json: { errors: [{ code: 'NOT_FOUND', message: 'no' }] } };
    },
  };
  if (opts.openBook !== undefined) ctx.openBook = async () => opts.openBook;
  return { ctx, requests, oldRun, newRun };
}

async function main() {
  console.log('\n== book_status: the current book is the newer one paused at Characters and places ==');
  {
    const w = world();
    const r = await registry.get('book_status').run({}, w.ctx);
    const d = r.data || {};
    assert(r.ok && d.current_book && d.current_book.title === 'The Last Soundkeep' && d.current_book.project_id === NEW, `the current book is “The Last Soundkeep” (got “${d.current_book && d.current_book.title}”)`);
    assert(d.current_book.saved_as === 'The Winter the Ocean Turned to Glass', 'the project name (saved as) is told apart from the book\'s title');
    assert(/paused and waiting for you/.test(d.current_book.why), `and why it is the current one: “${d.current_book.why}”`);
    assert(d.run && d.run.run_id === 'ab-new' && d.run.on_step === 'step 3 of 16 (Characters and places)', `the run is the new book's, at step 3 of 16 (Characters and places): ${d.run && d.run.on_step}`);
    const p = d.run && d.run.problem;
    assert(p && p.what === REVISE_MSG && p.reviewer_verdict === 'REVISE', 'the exact problem text and the reviewer\'s verdict');
    assert(p && p.reasons && /silas-rook-2/.test(p.reasons[0]) && /'silas-rook'/.test(p.reasons[0]), 'the reviewer\'s reason (silas-rook-2 vs the approved silas-rook)');
    const ch = (p && p.choices || []).join(' | ');
    assert(/Try again/.test(ch) && /Approve anyway/.test(ch) && /Edit it myself/.test(ch) && /I edited it — continue/.test(ch), `the choices in the words on Akọwe's buttons: ${ch}`);
    assert(/“The Last Soundkeep”/.test(d.now) && /step 3 of 16 \(Characters and places\)/.test(d.now) && /REVISE/.test(d.now) && /silas-rook-2/.test(d.now) && /Approve anyway/.test(d.now), `one plain sentence says it all: “${d.now.slice(0, 160)}…”`);
    assert(d.checklist && d.checklist.book === 'The Last Soundkeep' && d.checklist.steps.some((s) => s.title === 'Characters and places'), 'the checklist is the new book\'s');
    assert(!/odile-marsh/.test(JSON.stringify(d.run)) && !/odile-marsh/.test(d.now) && !/odile-marsh/.test(JSON.stringify(d.checklist)) && !/odile-marsh/.test(JSON.stringify(d.earlier_journal_notes || [])), 'the old book\'s outline problem (odile-marsh) is never presented as the current problem');
    assert(!w.requests.some((q) => q.includes(`/projects/${OLD}/branches`)), 'the old book\'s checklist / journal is not even read');
    assert(d.earlier_journal_notes && /may already be fixed/.test(d.earlier_journal_notes_are), 'journal notes are labelled as older notes (may already be fixed)');
    const old = (d.other_books || []).find((b) => b.project_id === OLD);
    assert(old && old.title === "The Lamplighter's Last Ferry" && !old.current, 'the old book is listed as another book, not the current one');
    assert((d.other_runs_waiting_for_you || []).some((o) => o.book === "The Lamplighter's Last Ferry"), 'its old paused run is reported under "other books", labelled with its own book');
  }

  console.log('\n== which book wins, and why ==');
  {
    let w = world({ openBook: { project_id: OLD, from: 'tab' } });
    let r = await registry.get('book_status').run({}, w.ctx);
    assert(r.data.current_book.project_id === OLD && /open in the 📖 Akọwe tab/.test(r.data.current_book.why), 'the book open in the Akọwe tab wins (the author is looking at it) — and says so');
    assert((r.data.other_runs_waiting_for_you || []).some((o) => o.book === 'The Last Soundkeep' && /REVISE/.test(o.problem)), '…and the paused Soundkeep run is still mentioned as another book waiting for you');
    w = world({ openBook: { project_id: NEW, from: 'tab' } });
    r = await registry.get('book_status').run({}, w.ctx);
    assert(r.data.current_book.project_id === NEW && /open in the 📖 Akọwe tab/.test(r.data.current_book.why), 'open tab = the Soundkeep book');
    w = world({ openBook: { project_id: 'proj-deleted', from: 'tab' } });
    r = await registry.get('book_status').run({}, w.ctx);
    assert(r.data.current_book.project_id === NEW, 'a tab showing a book that is gone is ignored');
    w = world({ noCurrent: true });
    r = await registry.get('book_status').run({}, w.ctx);
    assert(r.data.current_book.project_id === NEW, 'the newest paused run wins by time, not by list order (the old run was listed first)');
    // the AI remembered the OLD book's id from an earlier answer
    w = world();
    r = await registry.get('book_status').run({ project_id: OLD }, w.ctx);
    assert(r.data.current_book.project_id === OLD && /The book open \/ being worked on now is “The Last Soundkeep”/.test(r.data.now), `asked about the old book by id: the answer says which book is current now (“${r.data.note}”)`);
    r = await registry.get('book_status').run({ project_id: 'proj-gone' }, w.ctx);
    assert(r.data.current_book.project_id === NEW && /no book with the id/.test(r.data.note), 'an id that is no book any more falls back to the current book');
    // tools that change a book act on the same one
    const b = await registry._resolveBook(world().ctx, {});
    assert(b.ok && b.pid === NEW && b.title === 'The Last Soundkeep', 'tools that change a book (edit profile, rules …) pick the same current book');
    const lb = await registry.get('list_books').run({}, world().ctx);
    const cur = lb.data.find((x) => x.current);
    assert(cur && cur.project_id === NEW && cur.title === 'The Last Soundkeep' && lb.data.find((x) => x.project_id === OLD).title === "The Lamplighter's Last Ferry", 'list_books shows the titles and marks the current book');
    // Akọwe (new) marks the book the author opened last: used when no run waits and no tab is known
    const quiet = world({ akoweMarksOpen: true });
    quiet.oldRun.status = 'done'; quiet.oldRun.problem = null; quiet.newRun.status = 'done'; quiet.newRun.state = 'done'; quiet.newRun.needs_decision = false; quiet.newRun.needs_you = false; quiet.newRun.problem = null;
    r = await registry.get('book_status').run({}, quiet.ctx);
    assert(r.data.current_book.project_id === NEW && /last opened in Akọwe/.test(r.data.current_book.why), 'no run waiting: the book Akọwe says was opened last (not the first / oldest one)');
  }

  console.log('\n== Alfred\'s AI gets the live current book with every request ==');
  {
    const w = world();
    const sys = [];
    const llm = await fakeLlm((body) => { sys.push(body.messages[0].content); return lastMsg(body).role === 'tool' ? { content: 'It is “The Last Soundkeep”.' } : toolCall('book_status', {}); });
    const file = path.join(TMP, 's1.json');
    fs.writeFileSync(file, JSON.stringify({ enabled: true, brain: 'local', local: { endpoint: llm.base, model: 'fake-model' } }));
    const a = createAlfred({ settingsFile: file, ctx: w.ctx, noTimers: true, log: () => {}, emit: () => {}, akoweReady: () => true });
    const out = await a.ask("Tell me the name of the book that we're working on right now");
    const s = sys[0] || '';
    assert(/LIVE BOOK STATUS/.test(s) && /The book we are working on now is “The Last Soundkeep”/.test(s), 'the system message names “The Last Soundkeep” as the current book');
    assert(/step 3 of 16 \(Characters and places\)/.test(s) && /REVISE/.test(s) && /silas-rook-2/.test(s) && /I edited it — continue/.test(s), 'with its step, the REVISE problem, the reviewer\'s reason and the choices');
    assert(!/odile-marsh/.test(s) && !/The book we are working on now is “The Lamplighter/.test(s), 'the old book and its old outline problem are not presented as current');
    assert(/may be out of date/.test(s), 'and says older answers in the chat may be out of date');
    assert(out.type === 'reply' && /Last Soundkeep/.test(out.text), `his answer: “${out.text}”`);
    // Akọwe off: no live line, nothing breaks
    const w2 = world();
    const sys2 = [];
    const llm2 = await fakeLlm((body) => { sys2.push(body.messages[0].content); return { content: 'Akọwe is not running.' }; });
    const file2 = path.join(TMP, 's2.json');
    fs.writeFileSync(file2, JSON.stringify({ enabled: true, brain: 'local', local: { endpoint: llm2.base, model: 'fake-model' } }));
    const a2 = createAlfred({ settingsFile: file2, ctx: w2.ctx, noTimers: true, log: () => {}, emit: () => {}, akoweReady: () => false });
    await a2.ask('how is my book?');
    assert(!/LIVE BOOK STATUS/.test(sys2[0] || '') && w2.requests.length === 0, 'Akọwe not running: no live line and no Akọwe call');
    await llm.close(); await llm2.close();
  }

  console.log('\n== H25: pause / resume / cancel act on the open book\'s run, and ask when several books have one ==');
  {
    const two = (openPid, active) => {
      const w = world({ openBook: openPid ? { project_id: openPid } : undefined });
      const posted = [];
      const base = w.ctx.akowe;
      w.oldRun.status = 'running';  // the OLD book's run is the one Akọwe lists as active
      w.ctx.akowe = async (m, p, body) => {
        if (m === 'GET' && p === '/api/autobook') return { status: 200, json: { runs: [w.oldRun, w.newRun], active: active || [w.oldRun], current: w.oldRun } };
        const mm = /^\/api\/autobook\/([^/]+)\/(pause|resume|cancel)$/.exec(p);
        if (m === 'POST' && mm) { posted.push(`${mm[2]} ${mm[1]}`); return { status: 200, json: Object.assign({}, mm[1] === 'ab-new' ? w.newRun : w.oldRun, { status: mm[2] === 'pause' ? 'paused' : 'running' }) }; }
        return base(m, p, body);
      };
      return { w, posted };
    };
    let t = two(NEW);
    let r = await registry.get('resume_run').run({}, t.w.ctx);
    assert(r.ok && t.posted.join() === 'resume ab-new', `the book open in Akọwe ("The Last Soundkeep") is resumed, not the other book's active run (posted: ${t.posted.join() || 'nothing'})`);
    t = two(undefined);
    r = await registry.get('pause_run').run({}, t.w.ctx);
    assert(!r.ok && r.error === 'WHICH_RUN' && !t.posted.length && r.choices.length === 2 && /Which one do you mean/.test(r.message), `no open book and two runs: Alfred asks which (“${r.message}”), nothing is paused`);
    r = await registry.get('pause_run').run({ project_id: OLD }, t.w.ctx);
    assert(r.ok && t.posted.join() === 'pause ab-old', 'naming the book picks its run');
    t = two(OLD, []);
    t.w.oldRun.status = 'done';
    r = await registry.get('cancel_run').run({}, t.w.ctx);
    assert(!r.ok && r.error === 'NO_RUN' && !t.posted.length && /has no “Make a book for me” run going/.test(r.message), 'the open book has no run: nothing of another book is cancelled');
  }

  console.log('\n== notices: an old paused run of an older book is not announced as news ==');
  {
    const w = world({ noCurrent: true });
    const file = path.join(TMP, 'n.json');
    fs.writeFileSync(file, JSON.stringify({ enabled: true, brain: 'local', local: { endpoint: 'http://127.0.0.1:9/v1', model: 'm' } }));
    let t = 1e9;
    const a = createAlfred({ settingsFile: file, ctx: w.ctx, noTimers: true, now: () => (t += 1000), log: () => {}, emit: () => {}, akoweReady: () => true });
    await a.pollBooks();
    const notes = a.status().chat.filter((m) => m.role === 'notice');
    assert(notes.length === 1 && /The Last Soundkeep/.test(notes[0].text) && /needs your decision \(step 3 of 16\)/.test(notes[0].text), `first look: only the newest run waiting for a decision is told (“${notes[0] && notes[0].text}”)`);
    assert(!notes.some((n) => /Lamplighter/.test(n.text)), 'the old Lamplighter run is not told as news');
  }

  console.log('\n== the main-process side: peek reads and the open Akọwe tab ==');
  {
    assert(peekPath('GET', `/api/projects/${NEW}/branches/main/book`) === `/api/projects/${NEW}/branches/main/book?peek=1`, 'Alfred\'s reads of a book carry ?peek=1 (Akọwe does not take them for the author opening it)');
    assert(peekPath('GET', `/api/projects/${NEW}/branches/main/journal?problems=1`) === `/api/projects/${NEW}/branches/main/journal?problems=1&peek=1`, '…also with a query already there');
    assert(peekPath('PUT', `/api/projects/${NEW}/branches/main/review/world/rules`) === `/api/projects/${NEW}/branches/main/review/world/rules` && peekPath('GET', '/api/projects') === '/api/projects' && peekPath('GET', '/api/autobook') === '/api/autobook', 'changes and the lists are sent as they are');
    assert(JSON.stringify(openBookFromUrl(`http://127.0.0.1:8765/#/p/${NEW}/main/book`)) === JSON.stringify({ project_id: NEW, from: 'tab' }), 'the open book is read from the Akọwe tab\'s address (#/p/<book>/…)');
    assert(openBookFromUrl('http://127.0.0.1:8765/#/') === null && openBookFromUrl('http://127.0.0.1:8765/#token=abc') === null && openBookFromUrl('') === null, 'the shelf, the start link or no tab: no open book');
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert(/akoweViewUrl: \(\) =>/.test(main) && /akowePushedBook: \(\) =>/.test(main), 'main.js hands Alfred the Akọwe tab\'s address and the book Akọwe last pushed');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
