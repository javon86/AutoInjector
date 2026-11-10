// test/fresh-per-book.test.js — a NEW book starts each AI pane in a fresh chat (fresh-chat.js noteBook, reason
// 'new-book'), and the bridge passes Akọwe's book_id / run_id on to the host (akowe-bridge.js, meta.book).
// The user's run: the AI took a character name from their OTHER book (still in the chat) as the "invented" pen name.
// Run with: node test/fresh-per-book.test.js
const http = require('http');
const FC = require('../fresh-chat');
const { createBridge } = require('../akowe-bridge');

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log(`  ok   - ${msg}`); } else { failed++; console.log(`  FAIL - ${msg}`); } return cond; }

function unit() {
  console.log('\n== fresh-chat.js: which request is a new book ==');
  assert(FC.isNewBook(null, { id: 'proj-a', run: null }), 'nothing known about the pane\'s last book: a new book (the chat may hold anything)');
  assert(!FC.isNewBook({ id: 'proj-a', run: 'run-1' }, null), 'a request that names no book changes nothing');
  assert(FC.isNewBook({ id: 'proj-a', run: 'run-1' }, { id: 'proj-b', run: 'run-1' }), 'another book: new');
  assert(!FC.isNewBook({ id: 'proj-a', run: 'run-1' }, { id: 'proj-a', run: 'run-2' }), '▶ Continue (a new run of the SAME book): keeps its chat');
  assert(FC.isNewBook({ id: 'proj-a', run: 'run-1' }, { id: null, run: 'run-2' }), 'a new ⚡ run whose book does not exist yet: new');
  assert(!FC.isNewBook({ id: null, run: 'run-2' }, { id: 'proj-b', run: 'run-2' }), '…and its book appearing later in the same run is not another new book');
  assert(FC.cleanBook({ id: 'bad id with spaces', run: 'run-1' }).id === null && FC.cleanBook({ id: 'x y' }) === null, 'only ids are kept (never titles or text)');

  let t = 1000000;
  const fc = FC.createFreshChat({ everyRequests: 0, everyChars: 0, now: () => t });
  assert(fc.settings().newBook === true, 'on by default');
  fc.noteBook('claude', { id: 'proj-a', run: 'run-1' });
  let d = fc.due('claude');
  assert(d.due && d.reason === 'new-book', 'the first book in an unknown chat: a fresh chat is due (reason new-book)');
  fc.reset('claude');
  fc.noteSent('claude', 1000);
  assert(!fc.due('claude').due, 'after the fresh chat: nothing due');
  fc.noteBook('claude', { id: 'proj-a', run: 'run-1' });
  fc.noteSent('claude', 1000);
  assert(!fc.due('claude').due, 'the same book again: keeps its chat');
  fc.noteBook('claude', { id: 'proj-a', run: 'run-7' });
  assert(!fc.due('claude').due, 'a resume / ▶ Continue of the same book: keeps its chat');
  fc.noteBook('claude', { id: 'proj-b', run: 'run-8' });
  d = fc.due('claude', { userAt: t - 1000 });
  assert(!d.due && d.reason === 'new-book' && d.held === 'user', 'another book, but the user just used the pane: held (their chat is left alone)');
  d = fc.due('claude', { busy: true });
  assert(!d.due && d.held === 'busy', 'never while the AI is still writing');
  fc.noteSent('claude', 1000);
  fc.noteBook('claude', { id: 'proj-b', run: 'run-8' });
  t += 11 * 60000;
  d = fc.due('claude', { userAt: 1000000 });
  assert(d.due && d.reason === 'new-book', 'the held new-book chat comes with a later request of that book, once the user left the pane alone');
  fc.reset('claude');
  // a chat this app just opened that nothing went into needs no new one
  fc.noteBook('claude', { id: 'proj-c' });
  assert(!fc.due('claude').due, 'a new book in an empty fresh chat: no second fresh chat');
  // the switch
  fc.settings({ newBook: false });
  fc.noteSent('claude', 10);
  fc.noteBook('claude', { id: 'proj-d' });
  assert(!fc.due('claude').due, 'switched off: a new book carries on in the current chat');
  fc.settings({ newBook: true });
  // remembered across a restart (saved with the settings)
  const saved = fc.books();
  assert(saved.claude && saved.claude.id === 'proj-d', 'the book of each pane\'s last request can be saved');
  const fc2 = FC.createFreshChat({ everyRequests: 0, everyChars: 0 });
  fc2.restoreBooks(saved);
  fc2.noteBook('claude', { id: 'proj-d', run: 'run-9' });
  assert(!fc2.due('claude').due, 'after a restart, resuming the same book keeps its chat');
  fc2.noteBook('claude', { id: 'proj-e' });
  assert(fc2.due('claude').reason === 'new-book', '…and another book gets a fresh one');
  assert(/fresh Claude chat for Akọwe's new book/.test(FC.describe('Claude', 'new-book', {})), 'plain words for the log');
  assert(/started another book/.test(FC.describeHeld('Claude', 'user', 'new-book')), 'plain words for a hold');
}

function post(port, token, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/complete', agent: false,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
      const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString('utf8')); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

async function bridge() {
  console.log('\n== akowe-bridge.js: book_id / run_id reach the host ==');
  const metas = [];
  let b;
  const port = 30000 + Math.floor(Math.random() * 20000);
  b = createBridge({
    port, host: '127.0.0.1', getToken: () => 'tok', siteReady: () => true,
    sendToSite: async (site, text, meta) => {
      metas.push(meta);
      setTimeout(() => b.onCaptured({ site, text: 'answer', answers: [String(metas.length).padStart(4, '0')] }), 10);
      return { ok: true, seq: String(metas.length).padStart(4, '0') };
    }
  });
  await b.start();
  try {
    let r = await post(port, 'tok', { site: 'claude', prompt: 'hi', request_id: 'fb-1', timeout_ms: 10000, book_id: 'proj-abc', run_id: 'run-123' });
    assert(r.status === 200, `answered (${r.status})`);
    assert(metas[0] && metas[0].book && metas[0].book.id === 'proj-abc' && metas[0].book.run === 'run-123', 'meta.book = { id, run }');
    r = await post(port, 'tok', { site: 'claude', prompt: 'hi', request_id: 'fb-2', timeout_ms: 10000 });
    assert(r.status === 200 && metas[1] && !metas[1].book, 'an older Akọwe without the fields: no meta.book (nothing changes)');
    r = await post(port, 'tok', { site: 'claude', prompt: 'hi', request_id: 'fb-3', timeout_ms: 10000, book_id: 'The Glass Road' });
    assert(r.status === 400 && r.json.error === 'BAD_REQUEST' && metas.length === 2, 'a book_id that is not an id is refused (400), nothing typed');
    r = await post(port, 'tok', { site: 'claude', prompt: 'hi', request_id: 'fb-4', timeout_ms: 10000, run_id: 'run-9' });
    assert(r.status === 200 && metas[2].book && metas[2].book.id === null && metas[2].book.run === 'run-9', 'run_id alone (a run whose book does not exist yet)');
  } finally { await b.stop(); }
}

(async () => {
  unit();
  await bridge();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
