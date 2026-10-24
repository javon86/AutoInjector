// test/log-extract.test.js — P16 scoped Extract (log-extract.js), pure Node:
// the book tracker (which bridge requests belong to which BookForge project, and
// persistence), scope filtering (book only / time range / everything), the header,
// the file name, redaction of planted secrets and paths, and the Relay Trace filter.
// Run: node test/log-extract.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const lx = require('../log-extract');
const relayTraceLib = require('../relay-trace');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

const T0 = new Date('2026-10-20T09:00:00').getTime();
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;

function trackerFixture(file) {
  let t = T0;
  const tr = lx.createBookTracker({ file, now: () => t, saveDelayMs: 0 });
  // Book A runs 09:00..09:20, then again 13:00..13:10 (two run windows).
  tr.noteStatus({ id: 'proj-a', title: 'The Lighthouse Keeper' }, T0);
  tr.noteRequest('bf-r1-claude-c0-a0', 'claude', T0 + 1 * MIN); tr.noteSeq('bf-r1-claude-c0-a0', '0010'); tr.noteActivity('bf-r1-claude-c0-a0', T0 + 5 * MIN);
  tr.noteRequest('bf-r2-gemini-c0-a0', 'gemini', T0 + 10 * MIN); tr.noteSeq('bf-r2-gemini-c0-a0', '0011'); tr.noteActivity('bf-r2-gemini-c0-a0', T0 + 20 * MIN);
  tr.noteRequest('selftest-xyz', 'claude', T0 + 11 * MIN); // the link test never counts
  tr.noteRequest('bf-r3-claude-c0-a0', 'claude', T0 + 4 * HOUR); tr.noteSeq('bf-r3-claude-c0-a0', '0014'); tr.noteActivity('bf-r3-claude-c0-a0', T0 + 4 * HOUR + 10 * MIN);
  // Then BookForge switches to book B.
  tr.noteStatus({ id: 'proj-b', title: 'Other Book' }, T0 + 5 * HOUR);
  tr.noteRequest('bf-r9-claude-c0-a0', 'claude', T0 + 5 * HOUR + MIN); tr.noteSeq('bf-r9-claude-c0-a0', '0020');
  t = T0 + 6 * HOUR;
  return tr;
}

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logextract-'));
  const file = path.join(dir, 'bookforge-extract-books.json');

  console.log('\n== the book tracker: requests belong to the project that was current ==');
  const tr = trackerFixture(file);
  const a = tr.book('proj-a'), b = tr.book('proj-b');
  assert(a && a.requestIds.size === 3 && a.requestIds.has('bf-r1-claude-c0-a0') && !a.requestIds.has('bf-r9-claude-c0-a0'), 'book A has its 3 requests, not book B\'s');
  assert(!a.requestIds.has('selftest-xyz') && !b.requestIds.has('selftest-xyz'), 'link-test (selftest-) requests are never recorded');
  assert(b.requestIds.size === 1 && b.title === 'Other Book', 'book B has its own request');
  assert(a.seqs.has('0010') && a.seqs.has('0014') && !a.seqs.has('0020'), 'the [MSG #] numbers are kept per book');
  assert(a.windows.length === 2 && a.windows[0][0] === T0 + MIN && a.windows[0][1] === T0 + 20 * MIN && a.windows[1][0] === T0 + 4 * HOUR, `two run windows (gap > 30 min) from first to last request (${JSON.stringify(a.windows)})`);
  const rs = tr.requestBySeq('0011');
  assert(rs && rs.requestId === 'bf-r2-gemini-c0-a0' && rs.projectId === 'proj-a', 'requestBySeq finds the request + book of a [MSG #]');
  const list = tr.books();
  assert(list.length === 2 && list[0].id === 'proj-b' && list[0].current && list[1].requests === 3, 'books() lists the newest first, marks the current one');
  const saved = fs.readFileSync(file, 'utf8');
  assert(!/prompt|text/i.test(saved.replace(/"title"/g, '')) && saved.length < 4000, 'the persisted JSON is small and holds ids/times only');
  const tr2 = lx.createBookTracker({ file, saveDelayMs: 0 });
  assert(tr2.book('proj-a') && tr2.book('proj-a').requestIds.size === 3 && tr2.current().id === 'proj-b', 'the mapping survives a restart (reloaded from the JSON file)');
  fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
  assert(lx.createBookTracker({ file: path.join(dir, 'bad.json') }).books().length === 0, 'a broken file starts empty instead of crashing');
  const tr3 = lx.createBookTracker({ saveDelayMs: 0 });
  tr3.noteRequest('bf-x-claude-c0-a0', 'claude', T0);
  assert(tr3.books()[0].id === lx.UNKNOWN_PROJECT && /no title reported/.test(tr3.books()[0].title), 'requests before any status go to an unnamed book (not dropped, not mixed into a named one)');

  console.log('\n== defaultScope(): never "everything" ==');
  assert(JSON.stringify(lx.defaultScope({ connected: true, books: list, now: T0 + 6 * HOUR })) === JSON.stringify({ scope: 'book', bookId: 'proj-b' }), 'connected + a book known -> that book');
  assert(lx.defaultScope({ connected: false, books: list, now: T0 + 10 * DAY }).scope === 'time', 'not connected and the book is old -> last 24 h');
  assert(lx.defaultScope({ connected: false, books: [], now: T0 }).preset === 'day', 'no book -> last 24 h');

  // A transcript: a private conversation weeks earlier, an unrelated chat today, book A's replies, book B's reply.
  const transcript = [
    { id: 1, site: 'claude', label: 'Claude', ts: T0 - 20 * DAY, text: 'PRIVATE_LEGAL my divorce settlement draft, see /home/javon/Documents/Legal/settlement draft.pdf' },
    { id: 2, site: 'chatgpt', label: 'ChatGPT', ts: T0 + 2 * MIN, text: 'UNRELATED_CHAT about dinner recipes' },
    { id: 3, site: 'claude', label: 'Claude', ts: T0 + 5 * MIN, text: 'BOOK_A_CHAPTER_1 The lamp burned.', bf: { requestId: 'bf-r1-claude-c0-a0', projectId: 'proj-a' } },
    { id: 4, site: 'gemini', label: 'Gemini', ts: T0 + 20 * MIN, text: 'BOOK_A_REVIEW looks good', bf: { requestId: 'bf-r2-gemini-c0-a0', projectId: 'proj-a' } },
    { id: 5, site: 'claude', label: 'Claude', ts: T0 + 4 * HOUR + 10 * MIN, text: 'BOOK_A_CHAPTER_2', bf: { requestId: 'bf-r3-claude-c0-a0', projectId: 'proj-a' } },
    { id: 6, site: 'claude', label: 'Claude', ts: T0 + 5 * HOUR + 3 * MIN, text: 'BOOK_B_TEXT', bf: { requestId: 'bf-r9-claude-c0-a0', projectId: 'proj-b' } }
  ];
  const log = [
    { ts: T0 - 20 * DAY, kind: 'captured', detail: { site: 'claude', chars: 80 } },
    { ts: T0 + 1 * MIN, kind: 'bookforge-request', detail: { site: 'claude', request_id: 'bf-r1-claude-c0-a0', chars: 900 } },
    { ts: T0 + 1 * MIN + 1, kind: 'send-retry', detail: { target: 'claude', seq: '0010', attempt: 1 } },
    { ts: T0 + 2 * MIN, kind: 'captured', detail: { site: 'chatgpt', chars: 30 } },
    { ts: T0 + 5 * MIN, kind: 'bookforge-outcome', detail: { site: 'claude', request_id: 'bf-r1-claude-c0-a0', outcome: 'OK' } },
    { ts: T0 + 6 * MIN, kind: 'bookforge-listening', detail: { host: '127.0.0.1', port: 17891 } },
    { ts: T0 + 5 * HOUR + MIN, kind: 'bookforge-request', detail: { site: 'claude', request_id: 'bf-r9-claude-c0-a0' } },
    { ts: T0 + 3 * HOUR, kind: 'bookforge-error', detail: { error: 'between windows' } }
  ];
  const book = tr.book('proj-a');
  const base = { transcript, log, siteLabel: (s) => s, buildLine: 'Build: v1.0.0', now: T0 + 6 * HOUR, relayReport: (f) => ({ text: `RELAY TRACE — seqs ${f.seqs ? Array.from(f.seqs).sort().join(',') : 'all'}`, messages: f.seqs ? f.seqs.size : 99 }) };

  console.log('\n== scope "book": only this book\'s bridge-owned replies + its events ==');
  const rb = lx.buildExtract(Object.assign({}, base, { scope: 'book', book }));
  assert(/BOOK_A_CHAPTER_1/.test(rb.text) && /BOOK_A_REVIEW/.test(rb.text) && /BOOK_A_CHAPTER_2/.test(rb.text), 'all of book A\'s replies (both run windows) are in');
  assert(!/PRIVATE_LEGAL/.test(rb.text) && !/divorce/.test(rb.text), 'the older private conversation is NOT in');
  assert(!/UNRELATED_CHAT/.test(rb.text), 'an unrelated chat during the book\'s run window is NOT in (not bridge-owned)');
  assert(!/BOOK_B_TEXT/.test(rb.text) && !/bf-r9/.test(rb.text), 'the other project (book B) is NOT in');
  assert(rb.counts.messages === 3 && rb.counts.events === 4, `counts: 3 messages, 4 events (${JSON.stringify(rb.counts)})`);
  assert(/bookforge-request — .*bf-r1/.test(rb.text) && /send-retry — .*"seq":"0010"/.test(rb.text) && /bookforge-listening/.test(rb.text), 'its request events, the send events of its [MSG #] and bridge events inside the window are in');
  assert(!/between windows/.test(rb.text) && !/"chars":30/.test(rb.text), 'bridge events outside the run windows and unrelated captures are left out');
  assert(/RELAY TRACE — seqs 0010,0011,0014/.test(rb.text), 'the Relay Trace is limited to this book\'s [MSG #] numbers');

  console.log('\n== the header says exactly what is in the file ==');
  assert(/WHAT IS IN THIS FILE/.test(rb.header) && /Scope: +This BookForge book only — "The Lighthouse Keeper"/.test(rb.header), 'scope + book title');
  assert(/Book: +"The Lighthouse Keeper" \(BookForge project proj-a\)/.test(rb.header) && /Requests: +3 BookForge requests/.test(rb.header), 'project id and request count');
  assert(/Run windows: .*;/.test(rb.header) && /Time range: /.test(rb.header), 'time range and both run windows');
  assert(/AI conversation: +3 messages/.test(rb.header) && /Activity log: +4 events/.test(rb.header) && /Relay trace: +3 messages traced/.test(rb.header), 'per-section counts');
  assert(/Your own conversations with the AIs are NOT included/.test(rb.header) && /Redaction:/.test(rb.header), 'says what is excluded and that it is redacted');
  assert(/^Build: v1\.0\.0$/m.test(rb.text), 'the build line is kept');
  assert(rb.preview.split('\n').length <= lx.PREVIEW_LINES + 1 && /WHAT IS IN THIS FILE/.test(rb.preview), 'preview = the first lines');

  console.log('\n== options: sections can be left out ==');
  const rn = lx.buildExtract(Object.assign({}, base, { scope: 'book', book, include: { conversation: false, activity: true, relay: false } }));
  assert(!/BOOK_A_CHAPTER_1/.test(rn.text) && /AI conversation: +not included/.test(rn.header) && /Relay trace: +not included/.test(rn.header) && !/RELAY TRACE — seqs/.test(rn.text), 'unticked sections are not in the file, and the header says so');
  assert(/AI CONVERSATION/.test(rn.text) && /\(not included in this extract\)/.test(rn.text), 'the section heading stays with "(not included)"');

  console.log('\n== scope "time" ==');
  const rt = lx.buildExtract(Object.assign({}, base, { scope: 'time', from: T0, to: T0 + 30 * MIN }));
  assert(/UNRELATED_CHAT/.test(rt.text) && /BOOK_A_CHAPTER_1/.test(rt.text) && /BOOK_A_REVIEW/.test(rt.text), 'everything inside the range');
  assert(!/PRIVATE_LEGAL/.test(rt.text) && !/BOOK_A_CHAPTER_2/.test(rt.text) && !/BOOK_B_TEXT/.test(rt.text), 'nothing outside it');
  assert(rt.counts.messages === 3 && /Time range: .*to/.test(rt.header), 'counts + range in the header');
  const rd = lx.buildExtract(Object.assign({}, base, { scope: 'time', preset: 'day' }));
  assert(rd.counts.messages === 5 && !/PRIVATE_LEGAL/.test(rd.text) && /last 24 hours/.test(rd.header), 'preset "last 24 h" leaves out the conversation from 20 days ago');
  const rh = lx.buildExtract(Object.assign({}, base, { scope: 'time', preset: 'hour' }));
  assert(rh.counts.messages === 1 && /BOOK_B_TEXT/.test(rh.text), 'preset "last hour"');
  const rtoday = lx.buildExtract(Object.assign({}, base, { scope: 'time', preset: 'today' }));
  assert(/today/.test(rtoday.header) && !/PRIVATE_LEGAL/.test(rtoday.text), 'preset "today"');

  console.log('\n== scope "everything" (warned) ==');
  const re = lx.buildExtract(Object.assign({}, base, { scope: 'everything' }));
  assert(re.counts.messages === 6 && /PRIVATE_LEGAL/.test(re.text), 'everything is in');
  assert(/includes ALL conversations, including older private ones/.test(re.header), 'with the warning in the header');
  assert(/RELAY TRACE — seqs all/.test(re.text), 'and the full Relay Trace');

  console.log('\n== file names ==');
  assert(/^The Lighthouse Keeper - AutoInjector log - \d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.txt$/.test(rb.fileName), `book: "<title> - AutoInjector log - <stamp>.txt" (${rb.fileName})`);
  assert(/^AutoInjector log - last 24 h - .*\.txt$/.test(rd.fileName) && /^AutoInjector log - everything - .*\.txt$/.test(re.fileName) && /^AutoInjector log - time range - /.test(rt.fileName), 'time / everything names say the scope');
  const weird = lx.buildExtract(Object.assign({}, base, { scope: 'book', book: Object.assign({}, book, { title: '../../etc/pass:wd*?<Book>' }) }));
  assert(!/[\\/:*?"<>|]/.test(weird.fileName) && !weird.fileName.includes('..'), `a hostile title cannot make a path (${weird.fileName})`);

  console.log('\n== redaction: planted secrets and paths never reach the file ==');
  const KEY = 'Zk3Jq9pLm2Xv8Rt5Wy1Bn4Hc7Df0Ga6Ss3Ee9Uu2Ii';
  const PAIR = 'Ab3dEf7hJk9m';
  const SK = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx1234567890';
  const GOOG = 'AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q';
  const HEX = 'deadbeef0123456789abcdef0123456789abcdef';
  const planted = [
    `connection key ${KEY} pasted`,
    `pairing code: ${PAIR}`,
    `open http://127.0.0.1:5000/#/pair?code=${PAIR}&bridge=x`,
    `my key is ${SK}`, `gemini ${GOOG}`,
    `Authorization: Bearer ${KEY}x`,
    `token=${HEX}`,
    `"api_key":"q1w2e3r4t5y6u7i8o9p0"`,
    'secret near here: ' + 'QWxhZGRpbjpvcGVuIHNlc2FtZQ12345678abcdefgh',
    'saved to /home/javon/AutoInjector/stuff and thing/logs/x.txt',
    'see /home/javon/Documents/Legal/settlement draft.pdf now',
    'win C:\\Users\\Javon\\Desktop\\taxes 2025.xlsx and json "C:\\\\Users\\\\Javon\\\\Secret\\\\a.txt"',
    'mac /Users/javon/Private/notes.md',
    'other /home/someone/x/y.txt'
  ].join('\n');
  const red = lx.redact(planted, { secrets: [KEY, PAIR], home: '/home/javon', appDirs: ['/home/javon/AutoInjector'] });
  const out = red.text;
  for (const [name, v] of [['connection key', KEY], ['pairing code', PAIR], ['sk- key', SK], ['AIza key', GOOG], ['hex token', HEX], ['api_key value', 'q1w2e3r4t5y6u7i8o9p0'], ['base64 secret', 'QWxhZGRpbjpvcGVuIHNlc2FtZQ12345678abcdefgh']]) {
    assert(!out.includes(v), `${name} is removed`);
  }
  assert(!out.includes('/home/javon') && !out.includes('Javon') && !out.includes('/Users/javon') && !out.includes('/home/someone'), 'no home-folder path (Linux, Windows, JSON-escaped, macOS, other users) is left');
  assert(out.includes('~/AutoInjector/stuff and thing/logs/x.txt'), `the app's own folder stays, shown under ~ (${out.split('\n')[9]})`);
  assert(!/Legal|settlement|taxes|Private|notes\.md/.test(out) && /\[private path\]/.test(out), 'a path outside the app\'s folders is replaced by [private path]');
  assert(red.count >= 12, `redactions are counted (${red.count})`);
  const plain = 'The lighthouse keeper read chapter 12 at 09:30. Internationalization is long. Request bf-r1-claude-c0-a0 OK in 12s. MSG #0010. https://example.com/a/b';
  assert(lx.redact(plain, { secrets: [], home: '/home/javon', appDirs: [] }).text === plain, 'ordinary prose, ids, numbers and URLs are left alone (conservative)');
  const rbs = lx.buildExtract(Object.assign({}, base, { scope: 'everything', transcript: transcript.concat([{ id: 9, site: 'claude', ts: T0, text: `my key ${SK} and code ${PAIR}` }]), redaction: { secrets: [PAIR], home: '/home/javon', appDirs: [] } }));
  assert(!rbs.text.includes(SK) && !rbs.text.includes(PAIR) && !/\/home\/javon/.test(rbs.text) && !/Legal\/settlement/.test(rbs.text), 'buildExtract redacts every scope (here: Everything)');

  console.log('\n== Relay Trace report(filter) ==');
  let now = 1000;
  const trace = relayTraceLib.createRelayTrace({ now: () => now });
  for (const [seq, site, at] of [['0001', 'claude', 1000], ['0002', 'gemini', 2000], ['0003', 'claude', 3000]]) {
    now = at; trace.noteSend({ seq, target: site, text: `hi ${seq}` }); trace.noteSendResult(seq, { ok: true, verified: true });
    now = at + 100; trace.noteCapture(site, Number(seq));
  }
  const all = trace.report();
  const only = trace.report({ seqs: new Set(['0001', '0003']) });
  const ranged = trace.report({ from: 1500, to: 2500 });
  assert(all.messages === 3 && all.replies === 3, 'unfiltered: everything');
  assert(only.messages === 2 && only.replies === 2 && !only.sites.gemini && only.sites.claude.sent === 2, 'by [MSG #]: only those messages and their replies');
  assert(ranged.messages === 1 && ranged.sites.gemini && !ranged.sites.claude && ranged.since === 1500 && ranged.at === 2500, 'by time range');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main();
