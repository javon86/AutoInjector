'use strict';
// test/longrun.test.js — the pure parts of PR #123 (long book runs on a real PC):
//   fresh-chat.js      when an AI pane gets a fresh chat for Akọwe (by count, by size, when the site says it is full;
//                      never while the AI writes, never under the user's own conversation)
//   site-errors.js     the sites' "this chat is too long — start a new chat" notices -> 'chat-full'
//   self-repair.js     the CHAT_FULL page signal and its fix (a fresh page)
//   run-guard.js       keep-awake lock, the window-close question, the "needs you" notifications (once, again after
//                      30 min), the tray icon picture
//   transcript-store.js short Akọwe replies, the capped list + archive, the background state writer
// Run: node test/longrun.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const FC = require('../fresh-chat');
const SE = require('../site-errors');
const SR = require('../self-repair');
const RG = require('../run-guard');
const TS = require('../transcript-store');
const { buildSignalScript } = SR;
const { JSDOM } = require('jsdom');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

function freshChat() {
  console.log('\n== fresh-chat.js: when a pane gets a fresh chat ==');
  let t = 1000000;
  const fc = FC.createFreshChat({ everyRequests: 3, everyChars: 1000, userQuietMs: 60000, now: () => t });
  assert(!fc.due('claude').due && fc.due('claude').reason === null, 'a new pane is not due');
  fc.noteSent('claude', 100); fc.noteSent('claude', 100);
  assert(!fc.due('claude').due, '2 requests (under 3) is not due');
  fc.noteSent('claude', 100);
  let d = fc.due('claude');
  assert(d.due && d.reason === 'requests' && d.requests === 3, 'after 3 Akọwe requests a fresh chat is due (by count)');
  d = fc.due('claude', { busy: true });
  assert(!d.due && d.held === 'busy', 'never while the AI is still writing / something is being sent');
  d = fc.due('claude', { userAt: t - 5000 });
  assert(!d.due && d.held === 'user', "held back while the user used the pane in the last minutes (their conversation isn't swapped away)");
  d = fc.due('claude', { userAt: t - 120000 });
  assert(d.due, '…but due once the user has left the pane alone for a while');
  fc.reset('claude');
  assert(!fc.due('claude').due && fc.snapshot().claude.requests === 0 && fc.snapshot().claude.fresh === 1, 'reset after a new chat: counts start again');
  fc.noteSent('gemini', 600); fc.noteReply('gemini', 500);
  d = fc.due('gemini');
  assert(d.due && d.reason === 'chars' && d.chars === 1100, 'by size: prompt + answer characters past the limit');
  fc.markFull('chatgpt');
  d = fc.due('chatgpt', { userAt: t - 1000 });
  assert(d.due && d.reason === 'full', "the site said the chat is full: due at once (even right after the user's own use)");
  assert(!fc.due('chatgpt', { busy: true }).due, '…but still never mid-reply');
  const s = fc.settings({ everyRequests: 0, everyChars: 0 });
  assert(s.everyRequests === 0 && s.everyChars === 0, 'settings: 0 turns a limit off');
  fc.noteSent('x', 999999); for (let i = 0; i < 50; i++) fc.noteSent('x', 1);
  assert(!fc.due('x').due, 'with both limits off, only a full chat starts a fresh one');
  assert(FC.createFreshChat().settings().everyRequests === 15 && FC.createFreshChat().settings().everyChars === 300000, 'defaults: every 15 requests or about 300,000 characters');
  assert(/fresh Claude chat for Akọwe \(the old one already had 15 Akọwe requests\)/.test(FC.describe('Claude', 'requests', { requests: 15 })), 'plain words for the log (by count)');
  assert(/about 312,000 characters/.test(FC.describe('Gemini', 'chars', { chars: 312345 })), 'plain words for the log (by size)');
  assert(/said its chat is full/.test(FC.describe('ChatGPT', 'full', {})), 'plain words for the log (full)');
  assert(/you've used that pane yourself/.test(FC.describeHeld('Claude', 'user')), 'plain words when held back for the user');
  for (const site of ['chatgpt', 'claude', 'gemini']) assert(FC.NEW_CHAT_CANDIDATES[site].length >= 3, `${site}: several "New chat" selectors (fallbacks)`);

  // the page scripts, run against a real DOM
  const dom = new JSDOM('<nav><a href="/x">Chats</a><button aria-label="New chat" id="nc">+</button></nav><main><div class="font-claude-response">old</div><div contenteditable="true" class="ProseMirror"></div></main>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.HTMLElement.prototype.getBoundingClientRect = function () { return { width: 10, height: 10 }; };
  let clicked = false;
  w.document.getElementById('nc').addEventListener('click', () => { clicked = true; });
  const r = w.eval(FC.buildNewChatScript('claude'));
  assert(r.ok && clicked && r.clicked === 'button[aria-label="New chat"]', `the click script presses the site's New chat button (${r.clicked})`);
  const chk = w.eval(FC.buildFreshCheckScript(['div.font-claude-response'], ['div.ProseMirror[contenteditable="true"]']));
  assert(chk.ok && chk.replies === 1 && chk.input === true, 'the check script counts the replies still on the page and finds the message box');
  const dom2 = new JSDOM('<div><span role="button" id="b">New chat</span></div>', { runScripts: 'outside-only' });
  dom2.window.HTMLElement.prototype.getBoundingClientRect = function () { return { width: 10, height: 10 }; };
  let c2 = false; dom2.window.document.getElementById('b').addEventListener('click', () => { c2 = true; });
  const r2 = dom2.window.eval(FC.buildNewChatScript('gemini'));
  assert(r2.ok && c2 && r2.clicked === 'label', 'a control only labelled "New chat" is found too (when the selectors miss)');
  const dom3 = new JSDOM('<div><button>Send</button></div>', { runScripts: 'outside-only' });
  assert(dom3.window.eval(FC.buildNewChatScript('chatgpt')).ok === false, 'no New chat control -> not ok (main.js then opens the new-chat address)');
}

function siteErrors() {
  console.log('\n== site-errors.js: "this chat is too long" is chat-full ==');
  const full = [
    'Your message will exceed the length limit for this chat. Try shortening your message or starting a new chat.',
    "You've reached the maximum length for this conversation, but you can keep talking by starting a new chat.",
    'This conversation is too long. Please start a new chat.',
    'Conversation limit reached. Start a new chat to continue.'
  ];
  for (const t of full) assert((SE.siteErrorOf(t) || {}).kind === 'chat-full', `chat-full: "${t.slice(0, 50)}…"`);
  assert((SE.siteErrorOf('The message you submitted was too long, please reload the conversation and submit something shorter.') || {}).kind === 'too-long', 'one message too long stays too-long');
  assert((SE.siteErrorOf("You've reached your usage limit. Please try again later.") || {}).kind === 'rate-limit', 'a usage limit stays rate-limit');
  assert(SE.siteErrorOf('Sure, let me start a new chat about cats') === null, '"start a new chat" alone (no word about a limit) is not a site notice');
  assert(SE.siteErrorOf('{"chapter": "This conversation is too long, she said."}') === null, 'a JSON answer that happens to contain the words is never a notice');
  assert(SE.retryAfterSeconds('chat-full') === 10, 'chat-full: ask again soon (10 s) — the fresh chat fixes it');
  assert(/starts a fresh Claude chat/.test(SE.describeSiteError('Claude', 'chat-full')), 'plain words for chat-full');
}

function selfRepair() {
  console.log('\n== self-repair.js: CHAT_FULL page signal and its fix ==');
  assert(SR.CODES.includes('CHAT_FULL') && SR.LADDERS.CHAT_FULL[0] === 'reload_home', 'CHAT_FULL is a code whose fix is a fresh page (a new chat)');
  assert(SR.classify({ signals: ['CHAT_FULL', 'USAGE_LIMIT'] }) === 'CHAT_FULL', 'a full chat is told apart (before a usage limit)');
  assert(!SR.USER_ONLY.has('CHAT_FULL'), 'it is fixed automatically, never "needs you"');
  assert(/too long/.test(SR.describeProblem('CHAT_FULL', 'Claude').say), 'plain words');
  const sig = SR.PAGE_SIGNATURES.find((x) => x.code === 'CHAT_FULL');
  assert(sig && sig.where === 'notices', 'the signal only reads notices (never a reply that talks about long chats)');
  // run the real signal script on a page with Claude's notice
  const dom = new JSDOM('<main><div role="alert">Your message will exceed the length limit for this chat. Try shortening your message or starting a new chat.</div><div contenteditable="true" class="ProseMirror"></div></main>', { runScripts: 'outside-only', url: 'https://claude.ai/chat/abc' });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return { width: 100, height: 20, top: 0, left: 0, bottom: 20, right: 100 }; };
  let out = null;
  try { out = dom.window.eval(buildSignalScript('claude', require('../selectors'), {})); } catch (e) { out = { error: String(e) }; }
  const codes = out && Array.isArray(out.codes) ? out.codes.map((x) => (typeof x === "string" ? x : x.code)) : [];
  assert(codes.includes('CHAT_FULL'), `the page signal script finds Claude's "length limit for this chat" notice (${JSON.stringify(out).slice(0, 160)})`);
}

async function runGuard() {
  console.log('\n== run-guard.js: keep awake, ask before closing, tell the user ==');
  let a = RG.activityOf({ run: { state: 'writing', live: true }, inFlight: 0 });
  assert(a.busy && a.runLive && a.why[0] === 'a book is being written', 'a live run is busy');
  assert(!RG.activityOf({ run: { state: 'writing', live: true, stale: true } }).busy, "a run Akọwe hasn't reported for a while (stale) does not count");
  assert(RG.activityOf({ inFlight: 1 }).busy && RG.activityOf({ media: ['a video is being made'] }).busy, 'an Akọwe request in flight, or a video / picture job, is busy');
  assert(!RG.activityOf({ run: { state: 'needs_you' } }).busy, 'a paused run waiting for the user is not "working"');

  let t = 0; const blocker = { started: [], stopped: [], start(type) { this.started.push(type); return 7; }, stop(id) { this.stopped.push(id); } };
  const logs = [];
  const wl = RG.createWakeLock({ blocker, now: () => t, idleGraceMs: 120000, log: (k, d) => logs.push(d) });
  wl.update(RG.activityOf({ inFlight: 1 }));
  assert(blocker.started.length === 1 && blocker.started[0] === 'prevent-app-suspension' && wl.awake(), 'busy -> powerSaveBlocker.start("prevent-app-suspension")');
  wl.update(RG.activityOf({ run: { state: 'writing', live: true } }));
  assert(blocker.started.length === 1, 'started once, not on every look');
  assert(logs.filter((d) => d.on === true).length === 2 && /a book is being written/.test(logs[logs.length - 1].say), 'the main reason changed (Akọwe request -> book run): said once more, the lock is not started again');
  wl.update(RG.activityOf({ run: { state: 'writing', live: true } }));
  assert(logs.filter((d) => d.on === true).length === 2, 'same reason again: not repeated');
  t += 60000; wl.update(RG.activityOf({}));
  assert(wl.awake() && !blocker.stopped.length, 'idle for 1 minute: still held (between two requests)');
  t += 61000; wl.update(RG.activityOf({}));
  assert(!wl.awake() && blocker.stopped[0] === 7, 'idle for 2 minutes: released (the PC may sleep again)');
  assert(logs.some((d) => /Keeping the PC awake while a book is being written|Keeping the PC awake while Akọwe/.test(d.say || '')) && logs.some((d) => /may sleep again/.test(d.say || '')), 'plain words in the log, on and off');
  const wl2 = RG.createWakeLock({ blocker: null });
  assert(wl2.update(RG.activityOf({ inFlight: 1 })).busy === true && !wl2.awake(), 'no Electron: busy is still known, no lock (no crash)');

  assert(RG.closeQuestion(RG.activityOf({})) === null, 'nothing working: no question on close');
  const q = RG.closeQuestion(RG.activityOf({ run: { state: 'writing', live: true } }));
  assert(q && /^A book is being written\. Keep it running in the background, or stop it\?$/.test(q.message), `the close question in plain words: "${q && q.message}"`);
  assert(q.buttons.length === 3 && /background/.test(q.buttons[0]) && /quit/i.test(q.buttons[1]) && q.buttons[2] === 'Cancel' && q.cancelId === 2, 'three answers: keep running in the background / stop it and quit / cancel');
  assert(/icon by the clock/.test(q.detail) && /Resume/.test(q.detail), 'it says how to open the window again, and that a run can be resumed');
  assert(RG.closeChoice(0) === 'background' && RG.closeChoice(1) === 'quit' && RG.closeChoice(2) === 'cancel' && RG.closeChoice(undefined) === 'cancel', 'answers map to background / quit / cancel');
  assert(/video/.test(RG.closeQuestion(RG.activityOf({ media: ['a video is being made'] })).message), 'a video job is named in the question');

  const sites = { chatgpt: { label: 'ChatGPT', active: true, health: { state: 'ok' } }, claude: { label: 'Claude', active: true, health: { state: 'needs_user', problem: 'LOGGED_OUT' } }, gemini: { label: 'Gemini', active: false, health: { state: 'broken', problem: 'UNKNOWN' } } };
  let c = RG.conditionsFrom({ run: { id: 'r1', state: 'needs_you', title: 'The Glass Road', at: 9, total: 16 }, sites, watching: false });
  assert(c.length === 2 && c[0].key === 'run:r1:needs_you' && c[0].target === 'akowe' && /“The Glass Road” needs your decision \(step 9 of 16\)/.test(c[0].body), 'a run that needs the user -> one condition, plain words, opens Akọwe');
  assert(c[1].key.startsWith('pane:claude') && /Claude is logged out/.test(c[1].body) && !c.some((x) => /gemini/.test(x.key)), 'a pane that needs the user (only Active AIs)');
  assert(RG.conditionsFrom({ run: null, sites, watching: false }).length === 0, 'no run and Akọwe not using the AIs: a broken pane is not announced');
  const lim = { chatgpt: { label: 'ChatGPT', active: true, health: { state: 'needs_user', problem: 'USAGE_LIMIT' } }, claude: { label: 'Claude', active: true, health: { state: 'needs_user', problem: 'USAGE_LIMIT' } } };
  c = RG.conditionsFrom({ run: { id: 'r', state: 'writing', live: true }, sites: lim });
  assert(c.length === 1 && c[0].key === 'all-limited' && /ChatGPT, Claude all say/.test(c[0].body), 'every AI rate-limited -> ONE "every AI has hit its usage limit" notice');
  assert(RG.conditionsFrom({ run: { id: 'r', state: 'paused' } })[0].title === 'Your book run is paused', 'a paused run is announced too');

  t = 0; const shown = []; const flashes = [];
  const n = RG.createNotifier({ now: () => t, show: (x) => shown.push(x), flash: (on) => flashes.push(on), renotifyMs: 30 * 60000, getSettings: () => ({ on: true, sound: false }) });
  const cond = [{ key: 'run:r1:needs_you', title: 'T', body: 'B', target: 'akowe' }];
  n.update(cond);
  assert(shown.length === 1 && shown[0].silent === true && flashes[0] === true, 'said once (silent when sound is off) and the taskbar flashes');
  t += 60000; n.update(cond); t += 60000; n.update(cond);
  assert(shown.length === 1, 'not repeated every look (no spam)');
  n.seen();
  assert(flashes[flashes.length - 1] === false, 'the user came back: the flashing stops');
  t += 30 * 60000; n.update(cond);
  assert(shown.length === 2 && shown[1].again === true, 'still waiting after 30 minutes: said again');
  n.update([]); n.update(cond);
  assert(shown.length === 3, 'a condition that went away and came back is said again');
  const off = RG.createNotifier({ show: (x) => shown.push(x), getSettings: () => ({ on: false }) });
  off.update(cond);
  assert(shown.length === 3, 'notifications turned off: nothing shown');

  const png = RG.makeIconPng(32);
  assert(png.slice(1, 4).toString() === 'PNG' && png.length > 100 && png.readUInt32BE(16) === 32, 'the tray icon is a real 32×32 PNG');
  alertNotices();
}

// 🔔 Akọwe's alert (akowe/alerts.py) -> the desktop notification: category + icon, what, what is wrong, why it stopped
function alertNotices() {
  console.log('\n== run-guard.js / akowe-run.js: the plain alert of a run that needs the user ==');
  const AR = require('../akowe-run');
  const ansel = { category: 'character', icon: '🧑', label: 'Character issue', what: 'Ansel Marrant (character)',
    wrong: "His background has a timeline contradiction: he is eight at his father's wake but about ten when his mother died, while the approved family timeline says the father drowned when he was a baby.",
    why: 'The reviewer and the writer disagreed twice about the same thing, so it needs you.',
    next: 'Pick one: accept the change, keep the original, or edit it yourself. The book carries on after you choose.',
    choices: [{ action: 'accept_change', label: '✔ Accept change' }], change: { field: 'background', before: "At eight, during their father's wake…", after: "During their mother's wake…" },
    key: 'character:REVIEW_DECISION:A01-x:2', code: 'REVIEW_DECISION' };
  const sum = AR.summarizeRun({ id: 'run-7', title: "The Salt Keeper's Ledger", status: 'paused', state: 'needs_decision', needs_decision: true, steps_total: 19, step: 3, alert: ansel });
  assert(sum.alert && sum.alert.label === 'Character issue' && sum.alert.icon === '🧑' && sum.alert.what === 'Ansel Marrant (character)' && sum.alert.change.after, 'the run summary carries Akọwe\'s alert');
  assert(AR.summarizeRun({ id: 'r', status: 'running', state: 'working', alert: ansel }).alert === null, 'a working run carries no alert');
  assert(AR.alertOf({ label: '' }) === null && AR.alertOf(null) === null, 'no label: no alert (older Akọwe)');
  let c = RG.conditionsFrom({ run: sum });
  assert(c.length === 1 && c[0].title === "📖 The Salt Keeper's Ledger: 🧑 Character issue (step 3 of 19)", `the title names the book, the category and the step ("${c[0].title}")`);
  assert(c[0].body.startsWith('Ansel Marrant (character): His background has a timeline contradiction') && /disagreed twice about the same thing, so it needs you\.$/.test(c[0].body), `the body says what and why ("${c[0].body}")`);
  assert(c[0].title.length <= RG.TITLE_MAX && c[0].body.length <= RG.BODY_MAX && RG.BODY_MAX <= 200, 'title and body within the notification limits');
  assert(c[0].key.startsWith('run:run-7:needs_you:') && c[0].target === 'akowe' && c[0].category === 'character' && c[0].code === 'REVIEW_DECISION', 'one condition: opens Akọwe, keyed by the decision, codes for the log');
  const longBook = Object.assign({}, sum, { title: 'A'.repeat(150), alert: Object.assign({}, sum.alert, { label: 'Story map connection', icon: '🗺', what: 'W'.repeat(80), wrong: 'x '.repeat(400) }) });
  c = RG.conditionsFrom({ run: longBook });
  assert(c[0].title.length <= RG.TITLE_MAX && /🗺 Story map connection \(step 3 of 19\)$/.test(c[0].title) && c[0].body.length <= RG.BODY_MAX && /…/.test(c[0].title), 'a very long book name / finding is cut, the category and step stay');
  const paused = AR.summarizeRun({ id: 'run-8', title: 'B', status: 'paused', state: 'paused', pause_reason: 'author', steps_total: 19, step: 5, alert: { category: 'paused', icon: '⏸', label: 'Paused by you', what: 'Write every chapter', wrong: 'Nothing is wrong.', why: 'You pressed Pause.', next: 'Press ▶ Resume when you are ready.', key: 'paused:paused::' } });
  c = RG.conditionsFrom({ run: paused });
  assert(c[0].title === '📖 B: ⏸ Paused by you (step 5 of 19)' && /You pressed Pause\.$/.test(c[0].body), 'Pause says so plainly');
  const ai = AR.summarizeRun({ id: 'run-9', title: 'B', status: 'paused', state: 'problem', steps_total: 19, step: 11, problem: { message: 'x' }, alert: { category: 'ai', icon: '⚠', label: 'AI problem', what: 'Write every chapter', wrong: 'The AI did not answer in time while writing chapter 4.', why: 'The AI could not do this step (a usage limit, the connection or an error).', next: 'Press 🔁 Try again.', key: 'ai:TIMEOUT:x:' } });
  c = RG.conditionsFrom({ run: ai });
  assert(/⚠ AI problem \(step 11 of 19\)$/.test(c[0].title) && /did not answer in time/.test(c[0].body), 'an AI problem is named as one');
  // repeats: the same decision once (again after 30 min); a NEW decision of the same run is said at once
  let t = 0; const shown = [];
  const n = RG.createNotifier({ now: () => t, show: (x) => shown.push(x), renotifyMs: 30 * 60000, getSettings: () => ({ on: true, sound: true }) });
  const first = RG.conditionsFrom({ run: sum });
  n.update(first); t += 60000; n.update(first);
  assert(shown.length === 1 && shown[0].silent === false, 'the same decision is said once (with its sound)');
  t += 30 * 60000; n.update(first);
  assert(shown.length === 2 && shown[1].again === true, 'still waiting after 30 minutes: said again');
  const next = RG.conditionsFrom({ run: Object.assign({}, sum, { alert: Object.assign({}, sum.alert, { key: 'place:REVIEW_NOT_PASSED:A04-y:3', label: 'Place / world rule', icon: '📍' }) }) });
  n.update(next);
  assert(shown.length === 3 && /📍 Place \/ world rule/.test(shown[2].title), 'a different decision of the same run is announced at once');
}

async function transcriptStore() {
  console.log('\n== transcript-store.js: short Akọwe replies, capped list, background writes ==');
  const long = 'x'.repeat(25000);
  const s = TS.trimOwnedText(long);
  assert(s.trimmed && s.text.length < 2200 && s.text.startsWith('x'.repeat(2000)) && /… \(full answer handed to Akọwe\) — 25,000 characters in all$/.test(s.text) && s.fullChars === 25000, 'a 25,000-character Akọwe reply is kept as its first 2,000 characters + a note');
  assert(!TS.trimOwnedText('short answer').trimmed && TS.trimOwnedText('short answer').text === 'short answer', 'a short reply is kept as it is');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-test-'));
  const arc = TS.createArchive({ file: path.join(dir, 'arc.jsonl'), maxBytes: 300 });
  const arr = Array.from({ length: 12 }, (_, i) => ({ id: i, text: `turn ${i}` }));
  const moved = TS.capTurns(arr, 5, arc);
  assert(moved === 7 && arr.length === 5 && arr[0].id === 7, 'the list keeps the newest 5; 7 moved out');
  const lines = fs.readFileSync(path.join(dir, 'arc.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert(lines.length === 7 && lines[0].id === 0, 'the older turns are in the archive file, oldest first');
  for (let i = 0; i < 20; i++) arc.append([{ id: 100 + i, text: 'y'.repeat(40) }]);
  assert(fs.existsSync(path.join(dir, 'arc.jsonl.1')) && fs.statSync(path.join(dir, 'arc.jsonl')).size < 400, 'the archive rotates (one older .1 file kept)');

  const file = path.join(dir, 'state.json');
  let n = 0; let t = 0;
  const w = TS.createStateWriter({ file, serialize: () => JSON.stringify({ n: ++n }), delayMs: 20, minGapMs: 200, now: () => Date.now() + t });
  for (let i = 0; i < 10; i++) w.schedule();
  await w.idle();
  assert(JSON.parse(fs.readFileSync(file, 'utf8')).n === 1 && w.stats().writes === 1, '10 changes in a row -> ONE write');
  const t0 = Date.now();
  w.schedule(); await w.idle();
  assert(Date.now() - t0 >= 150 && JSON.parse(fs.readFileSync(file, 'utf8')).n === 2, `writes are at least minGap apart (${Date.now() - t0} ms)`);
  w.schedule();
  assert(w.flushSync() && JSON.parse(fs.readFileSync(file, 'utf8')).n === 3, 'flushSync (on quit) writes now');
  await w.idle();
  assert(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), 'no temp files left behind (temp + rename)');
  // a write in progress when a flush happens never puts older text over the newer file
  const slowFs = Object.assign({}, fs, { promises: Object.assign({}, fs.promises, { writeFile: async (p, d) => { await new Promise((r) => setTimeout(r, 80)); return fs.promises.writeFile(p, d); } }) });
  let m = 0;
  const w2 = TS.createStateWriter({ file, serialize: () => JSON.stringify({ m: ++m }), delayMs: 1, minGapMs: 1, fs: slowFs });
  w2.schedule(); await new Promise((r) => setTimeout(r, 20));
  w2.flushSync();
  await w2.idle();
  assert(JSON.parse(fs.readFileSync(file, 'utf8')).m === 2, 'an older background write never lands over a newer flush');
  const bad = TS.createStateWriter({ file: path.join(dir, 'nope', 'x.json'), serialize: () => '{}', delayMs: 1, minGapMs: 1, onError: () => { bad.err = true; } });
  bad.schedule(); await bad.idle();
  assert(bad.err === true, 'a write that fails is reported (never throws)');
  fs.rmSync(dir, { recursive: true, force: true });
}

(async () => {
  freshChat();
  siteErrors();
  selfRepair();
  await runGuard();
  await transcriptStore();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
