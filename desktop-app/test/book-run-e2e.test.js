// test/book-run-e2e.test.js — drive the REAL Book Studio workflow runner in
// main.js end to end with MOCKED AI replies, and confirm it advances through the
// whole sequence by itself. Uses the mock-electron harness (no browser, no real
// panes); each step's "reply" is injected via the pane's currentText, the real
// poll loop captures it, and the runner auto-advances. The one human touch the
// design requires — pressing Continue after the intake questionnaire — is
// simulated once; everything after it is hands-off.
//
// Run: node test/book-run-e2e.test.js

// Fast, internally-consistent clock (same knobs the integration harness uses).
process.env.AUTOINJECTOR_POLL_MS = process.env.AUTOINJECTOR_POLL_MS || '40';
process.env.AUTOINJECTOR_STABLE_MS = process.env.AUTOINJECTOR_STABLE_MS || '60';
process.env.AUTOINJECTOR_RETRY_BACKOFF_MS = process.env.AUTOINJECTOR_RETRY_BACKOFF_MS || '120';
process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS = process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS || '50';
// Force the V1 flat path so this test is a clean, self-contained view of the
// runner (no Python scaffold/authority spawns) — the auto-advance logic is
// identical for governed books.
process.env.ATELIER_PYTHON = process.env.ATELIER_PYTHON || '/nonexistent-python-for-mock-run';

const path = require('path');
const fs = require('fs');
const Module = require('module');
const mockPath = path.join(__dirname, 'mock-electron.js');
const origLoad = Module._load;
Module._load = function (request) { if (request === 'electron') return require(mockPath); return origLoad.apply(this, arguments); };
const mock = require(mockPath);

const SITES = ['chatgpt', 'claude', 'gemini'];
let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
function reg(s) { return mock.__registry[s]; }
// End-tag protocol: a book deliverable is captured only once it closes with the
// AI's [FROM: X] tag. Auto-append it (unless already present) so the mocked
// replies satisfy the completion gate exactly like a compliant AI would.
function say(s, t) { reg(s).webContents.currentText = /\[\s*FROM:/i.test(t) ? t : `${t}\n[FROM: ${s.toUpperCase()}]`; }
function call(ch, p) { const h = mock.__ipcHandlers[ch]; if (!h) throw new Error(`no ipc handler: ${ch}`); return h({}, p); }
async function waitUntil(fn, { timeout = 8000, interval = 50, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return true; await new Promise((r) => setTimeout(r, interval)); }
  console.log(`  ... timed out waiting for: ${label}`);
  return false;
}
async function snap(id) { const r = await call('book:runner-status'); return (r && r.snapshot) || {}; }

async function main() {
  require(path.join(__dirname, '..', 'main.js'));
  await waitUntil(() => { const r = reg('chatgpt'); return r && r.webContents && Array.isArray(r.webContents.sentLog); }, { label: 'app startup' });
  for (const s of SITES) { reg(s).webContents.sentLog = []; reg(s).webContents.currentText = ''; }

  console.log('\n== Create a book + a chapter ==');
  const created = await call('book:create', 'Mock Run ' + Date.now());
  assert(created && created.ok, 'book created');
  const id = created.project.id;
  const ch = await call('book:add-chapter', { id, title: 'Chapter One' });
  assert(ch && ch.ok, 'chapter added');

  console.log('\n== Start Making Book — it sends ChatGPT the intake questionnaire and waits ==');
  await call('book:workflow-start', { id, chapterId: ch.chapterId });
  let s = await snap(id);
  const total = s.total;
  assert(s.active && s.step === 0 && s.status === 'awaiting-user',
    `step 1/${total} (intake) is sent and waits for the human (status=${s.status})`);

  console.log('\n== Simulate the user answering, then let it run itself ==');
  await call('book:workflow-next', { id }); // the one human "Continue" after intake

  const seen = [];
  let guard = 0;
  while (guard++ < total + 5) {
    s = await snap(id);
    if (!s.active || s.status === 'done') break;
    if (s.status === 'awaiting-user') { await call('book:workflow-next', { id }); continue; }
    if (s.status === 'paused' || s.status === 'stalled') { console.log(`  parked (${s.status}) at step ${s.step + 1}`); break; }
    // waiting-reply: mock this step's target AI producing its output.
    const before = s.step;
    seen.push(`${before + 1}:${s.stepId}→${s.target}`);
    say(s.target, `=== MOCK REPLY for step ${before + 1} (${s.stepId}) from ${s.target} ===\nHere is the produced content for this section. Lorem ipsum dolor sit amet.`);
    const advanced = await waitUntil(async () => { const n = await snap(id); return n.step > before || n.status === 'done' || !n.active; }, { label: `advance past step ${before + 1} (${s.stepId})` });
    if (advanced) console.log(`  → step ${before + 1} (${s.stepId}) output captured from ${s.target}; advancing`);
    else { assert(false, `stuck at step ${before + 1} (${s.stepId})`); break; }
  }

  console.log('\n== Did it run the whole way by itself? ==');
  s = await snap(id);
  assert(s.status === 'done', `the workflow reached DONE on its own (final status=${s.status}, ${seen.length} AI steps auto-advanced)`);
  console.log(`  auto-advanced AI steps: ${seen.join('  ')}`);

  const proj = (await call('book:get', id)).project;
  assert(proj.workflow.status === 'done', 'the book records the workflow as done');
  const outs = Object.keys(proj.workflow.outputs || {});
  assert(outs.length >= 8, `every AI step saved its output (${outs.length} outputs: ${outs.join(', ')})`);
  const gate = (await call('book:pdf-gate', id)).gate;
  assert(gate.present >= 1 && gate.present === gate.total, `every deliverable has a PDF filed (${gate.present}/${gate.total})`);
  const log = proj.log.map((l) => l.text);
  assert(log.some((t) => /section .* complete .* PDF filed/i.test(t)) || log.some((t) => /output saved/i.test(t)), 'the activity log shows the sections completing');

  console.log('\n== The AI conversation was recorded to a text file alongside the book ==');
  const convLog = path.join(proj.dir, 'conversation-log.txt');
  assert(fs.existsSync(convLog), 'conversation-log.txt was written into the book folder');
  const convText = fs.existsSync(convLog) ? fs.readFileSync(convLog, 'utf8') : '';
  assert(/Recording started/.test(convText), 'the log opens with a "Recording started" header');
  assert(/MOCK REPLY for step/.test(convText), 'the log captured the AI replies from the run');
  const stopped = await call('book:record-stop');
  assert(stopped && stopped.ok && stopped.count > 0, `Stop closes the recording after ${stopped && stopped.count} captured messages`);
  assert(/Recording stopped/.test(fs.readFileSync(convLog, 'utf8')), 'the log is footered with "Recording stopped" once Stop is pressed');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('crashed:', e && e.stack || e); process.exit(1); });
