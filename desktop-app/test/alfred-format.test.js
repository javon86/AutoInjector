// test/alfred-format.test.js — PC test: Alfred's (correct) answer showed raw markdown marks and JSON-like
// computer words, took ~1½ min with nothing but "Working on it…", and his "paused, needs your decision" note kept
// showing after the book run was resumed and finished.
//   • cleanReply: tool echoes / raw JSON / snake_case field names -> plain words (markdown kept)
//   • toBlocks + the panel: **bold**, lists, `code` shown as formatting, built without innerHTML (no injection)
//   • the panel's "🎩 Thinking… N s" line from status().progress
//   • notices about a book run are marked "Old news — now: …" when the run moves on; health problems when fixed
// Run: node test/alfred-format.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');
const fmt = require('../alfred-format');
const { createAlfred } = require('../alfred');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-fmt-'));

(async () => {
  console.log('== cleanReply: no computer words in what he says ==');
  {
    const raw = 'Here is your book:\n{"run":{"run_id":"ab-1","status":"paused","needs_decision":true},"books":[{"project_id":"p1","title":"The Lamplighter\'s Last Ferry"}]}';
    const c = fmt.cleanReply(raw);
    assert(!/[{}"]/.test(c) && !/run_id|project_id|needs_decision/.test(c), `raw JSON -> plain lines:\n${c.replace(/^/gm, '        ')}`);
    assert(/Status: paused/.test(c) && /Needs your decision: yes/.test(c) && /Lamplighter/.test(c), 'the facts are kept, in plain words');
    assert(fmt.cleanReply('{"tool":"book_status","args":{}}') === '', 'a tool-call echo is dropped entirely');
    assert(fmt.cleanReply('Result of book_status: {"ok":true,"message":"Saved."}') === 'Saved.', '"Result of …: {message}" -> the message');
    const words = fmt.cleanReply('The run is paused and needs_decision is set; the project_id is p1. Saved to my_book.png and C:\\out\\run_log.txt; `run_id` stays code.');
    assert(/needs your decision is set/.test(words) && /the book is p1/.test(words), `snake_case -> words: “${words}”`);
    assert(/my_book\.png/.test(words) && /run_log\.txt/.test(words) && /`run_id`/.test(words), 'file names and `code` are left alone');
    const md = fmt.cleanReply('**Your book** is *paused*.\n\n- step 7 of 16\n- 2 chapters left');
    assert(md === '**Your book** is *paused*.\n\n- step 7 of 16\n- 2 chapters left', 'markdown is kept (the panel formats it)');
    const fenced = fmt.cleanReply('Status:\n```json\n{"status":"done","steps_done":16}\n```');
    assert(/- Status: done/.test(fenced) && /Steps done: 16/.test(fenced) && !/```/.test(fenced), 'a ```json block -> plain lines');
    assert(fmt.cleanReply('Line "status": "paused",') === 'Line "status": "paused",', 'quotes inside a sentence are left alone');
    assert(fmt.cleanReply('  ') === '', 'nothing left -> empty (the caller says “Done.”)');
  }

  console.log('\n== toBlocks: a small, safe markdown subset ==');
  {
    const b = fmt.toBlocks('# Your book\n**Bold** and *it* and `code`\n- a\n- b\n1. x\n2. y\n```\n<script>alert(1)</script>\n```');
    assert(b[0].type === 'h' && b[1].type === 'p' && b[2].type === 'ul' && b[3].type === 'ol' && b[4].type === 'code', 'heading, paragraph, bullets, numbers, code block');
    assert(b[1].spans.map((s) => s.t).join() === 'b,text,i,text,code', 'inline bold / italic / code');
    assert(b[4].text === '<script>alert(1)</script>', 'code is kept as text');
    assert(fmt.toBlocks('snake_case_word and 2*3*4').every((x) => x.spans.every((s) => s.t === 'text')), 'underscores in words and a*b*c are not italics');
    assert(fmt.plainText('**Hi** there\n- one') === 'Hi there\n• one', 'plainText: no marks');
  }

  console.log('\n== the panel: formatted, never HTML from the model, a ticking “Thinking…” ==');
  {
    const dom = new JSDOM('<!doctype html><html><body><button id="btn-alfred-switch"></button><div id="app"></div></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    let state = { ok: true, enabled: true, settings: { personality: { name: 'Alfred' }, brain: 'local', local: { model: 'qwen2.5:7b' }, pane: { site: 'chatgpt' }, profiles: [] }, busy: true, progress: { doing: 'thinking', step: 1, elapsedMs: 12000, brain: 'local' }, card: null, ai: {}, chat: [
      { role: 'you', text: '**not formatted** <b>x</b>', ts: 1 },
      { role: 'alfred', text: '**Your book** is paused:\n- step 7 of 16\n- `Resume` to go on\n<img src=x onerror="window.__pwned=1">', ts: 2 },
      { role: 'notice', text: '📖 The book run paused and needs your decision.', ts: 3, kind: 'book', ref: 'run:ab-1', outdated: true, nowText: 'Finished' },
    ], activity: [], tools: [], connected: {} };
    w.api = new Proxy({ alfredStatus: async () => state, onAlfred: () => {} }, { get(t, k) { if (k in t) return t[k]; if (/^on[A-Z]/.test(String(k))) return () => {}; return async () => ({}); } });
    w.requestAnimationFrame = (f) => setTimeout(f, 0);
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'alfred-format.js'), 'utf8'));
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'alfred-panel.js'), 'utf8'));
    await tick(50);
    const d = w.document;
    const msgs = d.querySelectorAll('#alfred-chat .al-msg');
    assert(msgs.length === 3, `three messages shown (${msgs.length})`);
    const al = d.querySelector('#alfred-chat .al-alfred');
    assert(al && al.querySelector('strong') && al.querySelector('strong').textContent === 'Your book', 'his **bold** is bold, without the marks');
    assert(al && al.querySelectorAll('li').length === 2 && al.querySelector('code').textContent === 'Resume', 'his list is a list, `code` is code');
    assert(!al.querySelector('img') && /<img src=x/.test(al.textContent) && !w.__pwned, 'HTML he writes is shown as text, never run');
    const you = d.querySelector('#alfred-chat .al-you');
    assert(you && !you.querySelector('strong') && you.textContent === '**not formatted** <b>x</b>', 'your own words stay exactly as typed');
    const old = d.querySelector('#alfred-chat .al-notice');
    assert(old && old.classList.contains('al-outdated') && /Old news — now: Finished/.test(old.textContent), 'an outdated notice is greyed out and says what is true now');
    const busy = d.getElementById('alfred-busy-text');
    assert(busy && /Thinking… 1[2-3] s/.test(busy.textContent), `busy line: “${busy && busy.textContent}”`);
    await tick(1100);
    assert(/Thinking… 1[3-4] s/.test(busy.textContent), `…and it ticks: “${busy.textContent}”`);
    state = Object.assign({}, state, { progress: { doing: 'thinking', step: 2, elapsedMs: 31000, brain: 'local' } });
    w.eval('void 0'); // re-render through a fresh status
    const r = await w.api.alfredStatus();
    assert(r.progress.elapsedMs === 31000, '(status carries the elapsed time)');
  }

  console.log('\n== status().progress while he works ==');
  {
    let release;
    const gate = new Promise((r) => { release = r; });
    const file = path.join(TMP, 's.json');
    fs.writeFileSync(file, JSON.stringify({ enabled: true, brain: 'local', local: { endpoint: 'http://127.0.0.1:9/v1', model: 'm' } }));
    const a = createAlfred({ settingsFile: file, noTimers: true, ctx: {}, akoweReady: () => false });
    const brain = require('../alfred-ai');
    const orig = brain.next;
    brain.next = async () => { await gate; return { ok: true, message: { content: '{"status":"done","project_id":"p1"}', toolCalls: [] } }; };
    try {
      const p = a.ask('how is my book?');
      await tick(20);
      const st = a.status();
      assert(st.busy && st.progress && st.progress.doing === 'thinking' && st.progress.elapsedMs >= 0, 'busy: progress says he is thinking, with the elapsed time');
      release();
      const out = await p;
      assert(out.type === 'reply' && out.text === '- Status: done', `the JSON-only answer is cleaned before it is shown: “${out.text}”`);
      assert(a.status().progress === null, 'idle: no progress');
    } finally { brain.next = orig; }
  }

  console.log('\n== notices: old news is marked when the run moves on ==');
  {
    const file = path.join(TMP, 'n.json');
    fs.writeFileSync(file, JSON.stringify({ enabled: true, brain: 'local', local: { endpoint: 'http://127.0.0.1:9/v1', model: 'm' } }));
    const steps = (done, cur) => Array.from({ length: 16 }, (_, i) => ({ title: `s${i}`, state: i < done ? 'done' : i === done && cur ? cur : 'pending' }));
    let runs = [{ id: 'ab-1', status: 'running', title: 'The Lamplighter\'s Last Ferry', project_id: 'p1', steps: steps(6, 'running') }];
    let t = 1e9;
    const a = createAlfred({ settingsFile: file, noTimers: true, now: () => (t += 1000), akoweReady: () => true, ctx: { akowe: async () => ({ status: 200, json: { runs, active: [] } }) } });
    const notes = () => a.status().chat.filter((m) => m.role === 'notice');
    await a.pollBooks();
    runs = [Object.assign({}, runs[0], { status: 'paused', problem: { record_id: 'r-1', message: 'reviewer' }, steps: steps(6, 'paused') })];
    await a.pollBooks();
    assert(notes().length === 1 && /needs your decision \(step 7 of 16\)/.test(notes()[0].text) && !notes()[0].outdated, `paused: “${notes()[0] && notes()[0].text}”`);
    runs = [Object.assign({}, runs[0], { status: 'interrupted', problem: null })];
    await a.pollBooks();
    assert(notes()[0].outdated && /Stopped when Akọwe closed/.test(notes()[0].nowText), `Akọwe closed: the “needs your decision” note is old news (now: ${notes()[0].nowText})`);
    assert(/stopped when Akọwe closed \(step 7 of 16\)/.test(notes()[1].text), `…and says so in plain words: “${notes()[1].text}”`);
    runs = [Object.assign({}, runs[0], { status: 'running', steps: steps(8, 'running') })];
    await a.pollBooks();
    assert(notes()[1].outdated && /writing again/.test(notes()[2].text), 'resumed: “writing again”, the stop note is old news');
    runs = [Object.assign({}, runs[0], { status: 'done', steps: steps(16) })];
    await a.pollBooks();
    const n = notes();
    assert(/finished/.test(n[n.length - 1].text) && !n[n.length - 1].outdated && n.slice(0, -1).every((m) => m.outdated && m.nowText === 'Finished'), 'finished: only “finished” is current; every older note about the run says “now: Finished”');
    // a newer Akọwe: an AI-error pause is not a decision; a replaced run's notes become old news, nothing new is said
    runs = [{ id: 'ab-9', status: 'running', title: 'B', project_id: 'p2', steps: steps(2, 'running') }];
    await a.pollBooks();
    runs = [Object.assign({}, runs[0], { status: 'paused', state: 'problem', needs_decision: false, problem: { record_id: 'r-2', message: 'The AI did not answer' } })];
    await a.pollBooks();
    const last = notes()[notes().length - 1];
    assert(!/needs your decision/.test(last.text) && /paused/.test(last.text), `an AI-error pause is not “needs your decision”: “${last.text}”`);
    const count = notes().length;
    runs = [Object.assign({}, runs[0], { status: 'cancelled', state: 'replaced', replaced_by: 'ab-10' })];
    await a.pollBooks();
    assert(notes().length === count && notes()[count - 1].outdated && /newer run/.test(notes()[count - 1].nowText), 'replaced by a newer run: no new note, the old one is old news');
    a.notice('health', 'health:problem:SD_DOWN', '🩺 Stable Diffusion stopped answering.', { force: true });
    a.notice('health', 'health:fixed:SD_DOWN', '✔ Stable Diffusion answers again.', { force: true });
    const h = notes().filter((m) => m.kind === 'health');
    assert(h.length === 2 && h[0].outdated && !h[1].outdated, 'a health problem is old news once it is fixed');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
