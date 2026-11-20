// test/phone.test.js — 📱 the phone app:
//   * phone-core.js: the pairing key, the PC's Wi-Fi address, the link, the book card and which answers the phone may
//     give, the chat, who hears a message, Alfred, alerts, the wrong-key guard
//   * phone-server.js + phone-main.js over real HTTP (a fake PC): the page loads without the key; every call needs it;
//     the AIs, ⏹ Stop, ⏸ Pause / ▶ Continue, answering the book (approve needs a confirm, "I edited it" is PC-only),
//     chapters, Alfred, alerts; a foreign web page can't post; too many wrong keys → wait; un-pair; on / off
//   * phone-app.js in jsdom against that server: pairing from the link, the five tabs, sending, answering, reading,
//     Alfred, alerts, an AI's text never becomes HTML, a revoked key goes back to "Pair this phone"
//   * phone-pair.js (the PC's 📱 Phone window) in jsdom
// Run with: node test/phone.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const core = require('../phone-core');
const { createPhone } = require('../phone-main');
const { makeFakePc } = require('./fixtures/phone-fake');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); } else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}
const DIR = path.join(__dirname, '..');
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function req(port, method, p, { key, body, headers } = {}) {
  return new Promise((resolve) => {
    const h = Object.assign({}, headers || {});
    if (key) h.Authorization = `Bearer ${key}`;
    let data = null;
    if (body !== undefined) { data = typeof body === 'string' ? body : JSON.stringify(body); h['Content-Type'] = 'application/json'; }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(raw); } catch (_) { /* page */ } resolve({ status: res.statusCode, headers: res.headers, raw, json }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code }));
    if (data) r.write(data);
    r.end();
  });
}

function files() {
  const f = (n, type) => ({ type, body: () => fs.readFileSync(path.join(DIR, n)) });
  return { '/': f('phone-app.html', 'text/html; charset=utf-8'), '/phone-app.js': f('phone-app.js', 'text/javascript'), '/phone-app.css': f('phone-app.css', 'text/css'), '/icon.svg': f('phone-icon.svg', 'image/svg+xml'), '/manifest.webmanifest': { type: 'application/manifest+json', body: '{}' } };
}

(async () => {
  console.log('== phone-core.js ==');
  const k1 = core.newToken();
  assert(/^[A-Za-z0-9_-]{32}$/.test(k1) && k1 !== core.newToken(), 'a pairing key: 32 url-safe characters, new each time');
  assert(core.sameToken(k1, k1) && !core.sameToken(k1, `${k1}x`) && !core.sameToken('', '') && !core.sameToken(k1, null), 'keys compare exactly (and empty never matches)');
  const addrs = core.lanAddresses({ 'vEthernet (WSL)': [{ family: 'IPv4', address: '172.22.80.1' }], 'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.42' }], Ethernet: [{ family: 'IPv4', address: '10.0.0.5' }], lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }], x: [{ family: 'IPv6', address: 'fe80::1' }], pub: [{ family: 'IPv4', address: '8.8.8.8' }] });
  assert(addrs.map((a) => a.address).join() === '192.168.1.42,10.0.0.5,172.22.80.1', 'the Wi-Fi address first, virtual adapters last, no loopback / IPv6 / public');
  assert(core.pairUrl('192.168.1.42', 47800, 'ab c') === 'http://192.168.1.42:47800/#k=ab%20c', 'the link carries the key after # (never sent to a server)');
  const fake = makeFakePc();
  const bv = core.bookView(fake.state.run);
  assert(bv.title === 'The Salt Tuner' && bv.percent === 58 && bv.done === 11 && bv.total === 19 && bv.leftS === 6000, 'book card: title, progress, steps, time left');
  assert(bv.question && bv.question.choices.map((c) => c.action).join() === 'accept_change,keep_original,approve_anyway', 'the phone offers the book\'s answers it may give');
  assert(bv.question.pcOnly && bv.question.choices.find((c) => c.action === 'approve_anyway').confirm, '"I edited it" stays on the PC; "approve anyway" asks first');
  assert(bv.question.change.includes('hands shake'), 'the proposed change is shown');
  assert(core.bookView(null) === null && core.bookView({}) === null, 'no run → no book card');
  const live = core.bookView({ id: 'r', alive: true, state: 'working', steps_done: 3, steps_total: 10 });
  assert(live.canPause && !live.canContinue && live.percent === 30 && !live.question, 'a working run: Pause, percent from the steps');
  const paused = core.bookView({ id: 'r', alive: false, state: 'paused', alert: { choices: [{ action: 'resume', label: '▶ Resume' }] } });
  assert(!paused.canPause && paused.question.choices[0].action === 'resume', 'a paused run: ▶ Resume');
  assert(core.answerRequest('run-1', 'retry').path === '/api/autobook/run-1/decide' && core.answerRequest('run-1', 'retry').body.action === 'retry', 'retry → decide');
  assert(core.answerRequest('run-1', 'resume').path === '/api/autobook/run-1/resume', 'resume → resume');
  assert(core.answerRequest('run-1', 'approve_anyway').error === 'CONFIRM_NEEDED' && core.answerRequest('run-1', 'approve_anyway', true).body.author_confirms === true, 'approve anyway only with a confirm');
  assert(core.answerRequest('run-1', 'edited').error === 'NOT_ON_PHONE' && core.answerRequest('../x', 'retry').error === 'NO_RUN', 'PC-only answers and odd run ids refused');
  const cv = core.chatView([{ id: 1, site: 'claude', text: 'hi', ts: 2 }, { id: 2, site: 'evil', text: 'x', ts: 3 }], [{ id: 'm1', to: ['claude'], text: 'yo', ts: 1 }]);
  assert(cv.map((m) => m.who).join() === 'me,claude', 'chat: yours and theirs in time order; unknown senders dropped');
  const av = core.aisView(fake.state.participants);
  assert(av.map((a) => a.words).join() === 'Ready,Writing…,Off', 'the AIs: Ready / Writing… / Off');
  assert(core.targets([], av).join() === 'chatgpt,claude' && core.targets(['gemini', 'claude'], av).join() === 'claude' && core.targets(['zz'], av).join() === 'chatgpt,claude', 'who hears you: the ticked ones that are on, else all that are on');
  const alv = core.alfredView(Object.assign({}, fake.state.alfred, { card: { title: 'Make a picture' } }));
  assert(alv.on && alv.chat.length === 2 && alv.chat[0].who === 'me' && alv.waitingOnPc === 'Make a picture', 'Alfred: on, his chat, a card waits for the PC');
  const al = core.createAlerts(3);
  const a1 = al.add({ key: 'k1', title: 'One' }, 1);
  assert(al.add({ key: 'k1', title: 'Again' }, 2) === null, 'the same waiting alert is not added twice');
  al.add({ title: 'Two' }, 3); al.add({ title: 'Three' }, 4); al.add({ title: 'Four' }, 5);
  assert(al.view().length === 3 && al.view()[0].title === 'Four' && al.unseen() === 3, 'alerts: newest first, at most the limit');
  assert(al.seen(a1.id) === 0 && al.seen('all') === 3 && al.unseen() === 0, 'mark read (one / all)');
  const g = core.createGuard({ limit: 3, windowMs: 1000 });
  g.fail('ip', 0); g.fail('ip', 1); g.fail('ip', 2);
  assert(g.blocked('ip', 3) && !g.blocked('ip', 1500) && !g.blocked('other', 3), 'too many wrong keys → wait (per address, for a while)');

  console.log('== phone-server.js + phone-main.js (real HTTP, a fake PC) ==');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-'));
  const pc = makeFakePc();
  const logs = [];
  const port = 47000 + Math.floor(Math.random() * 900);
  const phone = createPhone(Object.assign({ settingsFile: path.join(tmp, 'phone.json'), host: '127.0.0.1', port, files: files(), log: (k, d) => logs.push([k, d]) }, pc.deps));
  let st = await phone.status();
  assert(!st.enabled && !st.running && st.links[0].address === '192.168.1.42' && !st.qr, 'off by default: no server, no code');
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'phone.json'), 'utf8'));
  assert(saved.enabled === false && saved.key.length === 32, 'the key is made once and kept');
  assert((await req(port, 'GET', '/')).status === 0, 'off: nothing listens');
  st = await phone.setEnabled(true);
  assert(st.ok && st.enabled && st.running && /^<svg/.test(st.qr) && st.links[0].url === `http://192.168.1.42:${port}/#k=${saved.key}`, 'on: the server runs, the code and the link carry the key');
  const key = saved.key;
  let r = await req(port, 'GET', '/');
  assert(r.status === 200 && /<title>AutoInjector<\/title>/.test(r.raw) && /script-src 'self'/.test(r.headers['content-security-policy']) && r.headers['x-frame-options'] === 'DENY', 'the app page loads without the key, with a strict content policy');
  assert((await req(port, 'GET', '/phone-app.js')).status === 200 && (await req(port, 'GET', '/icon.svg')).status === 200 && (await req(port, 'GET', '/../main.js')).status === 404, 'its files load; nothing else of the app does');
  r = await req(port, 'GET', '/api/state');
  assert(r.status === 401 && r.json.error === 'NOT_PAIRED', 'no key → not paired');
  r = await req(port, 'GET', '/api/state', { key: 'x'.repeat(32) });
  assert(r.status === 401, 'a wrong key → not paired');
  r = await req(port, 'GET', '/api/state', { key });
  assert(r.status === 200 && r.json.ok && r.json.pc === 'BATCAVE-PC' && r.json.ais.length === 3 && r.json.book.title === 'The Salt Tuner', 'the state: PC name, AIs, the book');
  assert(r.json.alerts.some((a) => a.kind === 'book' && /decision/.test(a.title)), 'the book\'s question is an alert');
  assert(r.headers['cache-control'] === 'no-store', 'answers are never cached');
  r = await req(port, 'POST', '/api/chat', { key, body: { text: 'Hello both', to: ['claude', 'gemini'] } });
  assert(r.json.ok && /Claude/.test(r.json.words) && pc.calls.filter((c) => c.fn === 'sendTo').map((c) => c.site).join() === 'claude', 'send: only to the ticked AIs that are on');
  r = await req(port, 'GET', '/api/chat', { key });
  assert(r.json.messages.some((m) => m.who === 'me' && m.text === 'Hello both') && r.json.messages.some((m) => m.who === 'claude'), 'the chat shows yours and theirs');
  assert((await req(port, 'POST', '/api/chat', { key, body: { text: '  ' } })).json.error === 'EMPTY', 'an empty message is refused');
  r = await req(port, 'POST', '/api/stop', { key, body: {} });
  assert(r.json.ok && pc.calls.some((c) => c.fn === 'stopAll'), '⏹ Stop stops the AIs');
  r = await req(port, 'POST', '/api/book/answer', { key, body: { action: 'edited' } });
  assert(!r.json.ok && r.json.error === 'NOT_NOW', '"I edited it" can\'t be sent from the phone');
  r = await req(port, 'POST', '/api/book/answer', { key, body: { action: 'approve_anyway' } });
  assert(!r.json.ok && r.json.error === 'CONFIRM_NEEDED' && !pc.calls.some((c) => c.p && c.p.endsWith('/decide')), 'approve anyway without the confirm → nothing sent');
  r = await req(port, 'POST', '/api/book/answer', { key, body: { action: 'accept_change' } });
  const dec = pc.calls.find((c) => c.p === '/api/autobook/run-abc123/decide');
  assert(r.json.ok && dec && dec.body.action === 'accept_change', 'accept the change → the book app gets it');
  r = await req(port, 'POST', '/api/book/pause', { key, body: {} });
  assert(r.json.ok && pc.calls.some((c) => c.p === '/api/autobook/run-abc123/pause'), '⏸ Pause → the book app pauses');
  r = await req(port, 'GET', '/api/book/chapters', { key });
  assert(r.json.ok && r.json.chapters.length === 3 && !('text' in r.json.chapters[0]), 'chapters: the list (no text)');
  r = await req(port, 'GET', '/api/book/chapters/2', { key });
  assert(r.json.ok && r.json.number === 2 && /Gullhaven/.test(r.json.text) && r.json.of === 3, 'one chapter\'s text');
  assert(!(await req(port, 'GET', '/api/book/chapters/9', { key })).json.ok, 'a chapter not written → says so');
  r = await req(port, 'GET', '/api/alfred', { key });
  assert(r.json.ok && r.json.on && r.json.chat.length === 2, 'Alfred: his chat');
  r = await req(port, 'POST', '/api/alfred', { key, body: { text: 'Any news?' } });
  assert(r.json.ok && pc.calls.some((c) => c.channel === 'alfred:ask' && c.payload.text === 'Any news?'), 'ask Alfred');
  pc.state.alfred.card = { title: 'Make a picture of Mara' };
  r = await req(port, 'POST', '/api/alfred', { key, body: { text: 'more' } });
  assert(!r.json.ok && /OK on the PC/.test(r.json.words), 'Alfred waiting on a card → the phone is told to OK it on the PC');
  r = await req(port, 'GET', '/api/state', { key });
  assert(r.json.alerts.some((a) => a.kind === 'alfred'), 'Alfred waiting is an alert too');
  pc.state.alfred.card = null;
  pc.state.alfred.enabled = false;
  assert(!(await req(port, 'POST', '/api/alfred', { key, body: { text: 'hi' } })).json.ok, 'Alfred off → says so');
  phone.notice({ key: 'x', title: 'Your book needs you', body: 'Chapter 7', target: 'akowe' });
  r = await req(port, 'GET', '/api/state', { key });
  const n = r.json.alerts.find((a) => a.title === 'Your book needs you');
  assert(n && n.kind === 'book', 'a desktop notice reaches the phone\'s alerts');
  r = await req(port, 'POST', '/api/alerts/seen', { key, body: { id: 'all' } });
  assert(r.json.ok && r.json.marked >= 1, 'mark all read');
  // safety
  r = await req(port, 'POST', '/api/stop', { key, body: {}, headers: { Origin: 'https://evil.example' } });
  assert(r.status === 403 && r.json.error === 'FOREIGN_PAGE', 'a web page from elsewhere can\'t post, even with the key');
  r = await req(port, 'POST', '/api/stop', { key, body: {}, headers: { Origin: `http://127.0.0.1:${port}` } });
  assert(r.status === 200, 'the phone app\'s own page may');
  r = await req(port, 'POST', '/api/chat', { key, body: JSON.stringify({ text: 'x'.repeat(40000) }) });
  assert(r.status === 413, 'a too-big request is refused');
  assert((await req(port, 'POST', '/api/chat', { key, body: '{not json' })).status === 400, 'garbage is refused');
  assert((await req(port, 'GET', '/api/files/C:/secret', { key })).status === 404 && (await req(port, 'POST', '/api/run', { key, body: { cmd: 'del' } })).status === 404, 'there is no file or command call at all');
  for (let i = 0; i < 10; i++) await req(port, 'GET', '/api/state', { key: `wrong-${i}` });
  r = await req(port, 'GET', '/api/state', { key });
  assert(r.status === 429, 'ten wrong keys in a minute → even the right one waits');
  phone.server.handle; // (the guard is per address; the test machine is the one that guessed)
  st = await phone.status();
  assert(st.phones.length >= 1, 'the phones that used it are listed');
  assert(phone.phoneName('Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A)') === 'Pixel 8' && phone.phoneName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)') === 'iPhone', 'phone names from the browser');
  // Akọwe not running
  pc.state.akoweUp = false;
  const phone2 = createPhone(Object.assign({ settingsFile: path.join(tmp, 'p2.json'), host: '127.0.0.1', port: port + 1, files: files() }, pc.deps));
  await phone2.setEnabled(true);
  const k2 = (await phone2.load()).key;
  r = await req(port + 1, 'GET', '/api/state', { key: k2 });
  assert(r.json.ok && r.json.book === null && r.json.bookApp === false, 'the book app not running → no book card, the rest works');
  assert((await req(port + 1, 'POST', '/api/book/pause', { key: k2, body: {} })).json.error === 'NO_BOOK_APP', 'Pause with no book app → says so');
  await phone2.setEnabled(false);
  pc.state.akoweUp = true;
  // un-pair
  const before = phone.load().key;
  st = await phone.newKey();
  const after = phone.load().key;
  assert(st.ok && after !== before && /un-paired/.test(st.words), 'Un-pair all phones → a new key');
  // off
  st = await phone.setEnabled(false);
  assert(st.ok && !st.running && (await req(port, 'GET', '/')).status === 0, 'off → the server stops');
  const phone3 = createPhone(Object.assign({ settingsFile: path.join(tmp, 'phone.json'), host: '127.0.0.1', port }, pc.deps));
  await phone3.startup();
  assert(!phone3.server.running(), 'after a restart it stays off when it was off');
  await phone3.setEnabled(true);
  const phone4 = createPhone(Object.assign({ settingsFile: path.join(tmp, 'phone.json'), host: '127.0.0.1', port: port + 2 }, pc.deps));
  await phone3.stopServer();
  await phone4.startup();
  assert(phone4.server.running(), 'after a restart it comes back on when it was on');
  await phone4.stopServer();
  // port in use
  const blocker = http.createServer(() => {});
  await new Promise((res) => blocker.listen(port + 3, '127.0.0.1', res));
  const phone5 = createPhone(Object.assign({ settingsFile: path.join(tmp, 'p5.json'), host: '127.0.0.1', port: port + 3 }, pc.deps));
  st = await phone5.setEnabled(true);
  assert(!st.ok && st.error === 'EADDRINUSE' && !st.enabled && /port/.test(st.words), 'the port in use → a plain error, stays off');
  blocker.close();
  assert(!logs.some(([, d]) => JSON.stringify(d || {}).includes('Hello both') || JSON.stringify(d || {}).includes('Gullhaven')), 'the log never holds message or book text');

  console.log('== phone-app.js (jsdom, against the real server) ==');
  let JSDOM = null;
  try { ({ JSDOM } = require('jsdom')); } catch (_) { /* not installed */ }
  if (!JSDOM) assert(true, 'jsdom not installed — the app screens are tested in the e2e test only');
  else {
    const pc2 = makeFakePc();
    const p6port = port + 4;
    const phone6 = createPhone(Object.assign({ settingsFile: path.join(tmp, 'p6.json'), host: '127.0.0.1', port: p6port, files: files() }, pc2.deps));
    await phone6.setEnabled(true);
    const key6 = phone6.load().key;
    const html = fs.readFileSync(path.join(DIR, 'phone-app.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
    const open = (hash) => {
      const dom = new JSDOM(html, { url: `http://127.0.0.1:${p6port}/${hash || ''}`, runScripts: 'outside-only', pretendToBeVisual: true });
      const w = dom.window;
      w.__PHONE_APP_NO_AUTOSTART = true;
      w.scrollTo = () => {};
      w.eval(fs.readFileSync(path.join(DIR, 'phone-app.js'), 'utf8'));
      const fetchFn = async (p, o) => {
        const r2 = await req(p6port, o.method, p, { key: (o.headers.Authorization || '').replace('Bearer ', ''), body: o.body ? JSON.parse(o.body) : undefined });
        return { status: r2.status, json: async () => r2.json };
      };
      const app = w.PhoneApp.start(w.document, { fetch: fetchFn, poll: false, location: w.location, history: w.history });
      return { dom, w, app, $: (id) => w.document.getElementById(id) };
    };
    let A = open('');
    await tick(80);
    assert(!A.$('s-pair').hidden && A.$('tabs').hidden && /Not paired/.test(A.$('pc-words').textContent), 'no key → "Pair this phone", no tabs');
    A = open(`#k=${encodeURIComponent(key6)}`);
    await tick(150);
    assert(A.w.localStorage.getItem('autoinjector.phone.key') === key6 && !A.w.location.hash, 'the key from the link is kept on the phone and taken out of the address');
    assert(A.$('s-pair').hidden && !A.$('s-home').hidden && A.$('pc-words').textContent === 'BATCAVE-PC', 'paired → Home, the PC\'s name, connected');
    assert(/The Salt Tuner/.test(A.$('home-book').textContent) && A.$('home-book').querySelector('.bar i').style.width === '58%', 'Home: the book card with its progress');
    assert(/A decision for you/.test(A.$('home-question').textContent) && A.$('home-question').querySelector('button').textContent === 'Answer', 'Home: the question, with Answer');
    assert(A.$('home-ais').querySelectorAll('.ai').length === 3 && /Writing…/.test(A.$('home-ais').textContent), 'Home: the three AIs');
    assert(!A.$('alerts-badge').hidden && A.$('alerts-badge').textContent === '1', 'the 🔔 tab shows how many alerts are new');
    // Book tab + answering
    A.$('home-question').querySelector('button').click();
    await tick(150);
    assert(!A.$('s-book').hidden && A.$('s-home').hidden, 'Answer → the 📖 Book tab');
    const choices = [...A.$('book-question').querySelectorAll('button.choice')].map((b) => b.dataset.action);
    assert(choices.join() === 'accept_change,keep_original,approve_anyway' && /edit it yourself, use the PC/.test(A.$('book-question').textContent), 'the answers, and "edit on the PC"');
    assert(/hands shake/.test(A.$('book-question').textContent), 'the proposed change is shown');
    A.w.confirm = () => false;
    A.$('book-question').querySelector('[data-action="approve_anyway"]').click();
    await tick(100);
    assert(!pc2.calls.some((c) => c.p && c.p.endsWith('/decide')), 'approve anyway, then Cancel → nothing sent');
    A.$('book-question').querySelector('[data-action="keep_original"]').click();
    await tick(250);
    assert(pc2.calls.some((c) => c.p === '/api/autobook/run-abc123/decide' && c.body.action === 'keep_original') && /book carries on/.test(A.$('toast').textContent), 'keep the original → sent; "the book carries on"');
    await A.app.loadState();
    assert(!A.$('book-question').textContent && /Writing/.test(A.$('book-card').textContent), 'the question goes away; the book is writing again');
    // reader
    await tick(100);
    assert(A.$('book-chapters').querySelectorAll('.item').length === 3, 'the chapter list');
    A.$('book-chapters').querySelectorAll('.item')[1].click();
    await tick(200);
    assert(!A.$('s-reader').hidden && A.$('s-book').hidden && A.$('reader-text').querySelector('h1').textContent === 'Chapter 2: Salt and Iron' && A.$('reader-text').querySelectorAll('p').length === 3, 'the reader: the heading and the paragraphs');
    assert(A.$('reader-where').textContent === 'Chapter 2 of 3' && !A.$('reader-prev').disabled && !A.$('reader-next').disabled, 'the reader: where you are, previous / next');
    A.$('reader-bigger').click();
    assert(A.$('reader-text').style.getPropertyValue('--reader-size') === '21px', 'A+ makes the text bigger (and it is remembered)');
    A.$('reader-next').click();
    await tick(200);
    assert(A.$('reader-where').textContent === 'Chapter 3 of 3' && A.$('reader-next').disabled, 'next chapter; no next after the last');
    A.$('reader-back').click();
    assert(A.$('s-reader').hidden && !A.$('s-book').hidden, '‹ Chapters goes back');
    // chat
    A.w.document.querySelector('[data-tab="chat"]').click();
    await tick(200);
    assert(!A.$('s-chat').hidden && A.$('chat-feed').querySelectorAll('.bubble').length === 2, '💬 Chat: their messages');
    const chips = [...A.$('chat-to').querySelectorAll('.chip')];
    assert(chips.map((c) => c.getAttribute('aria-pressed')).join() === 'true,true,false' && chips[2].disabled, 'who hears you: the AIs that are on; Gemini (off) can\'t be picked');
    chips[0].click();
    A.$('chat-text').value = 'Only Claude please';
    A.$('chat-form').dispatchEvent(new A.w.Event('submit', { cancelable: true }));
    await tick(250);
    assert(pc2.calls.some((c) => c.fn === 'sendTo' && c.site === 'claude' && c.text === 'Only Claude please') && !pc2.calls.some((c) => c.fn === 'sendTo' && c.site === 'chatgpt'), 'untick ChatGPT → only Claude gets it');
    assert(A.$('chat-text').value === '' && [...A.$('chat-feed').querySelectorAll('.bubble.me')].some((b) => /Only Claude/.test(b.textContent)), 'the box empties; your message shows');
    pc2.state.replies.push({ id: 9, site: 'claude', text: '<img src=x onerror="window.pwned=1">bold?', ts: Date.now() });
    await A.app.loadChat();
    assert(!A.$('chat-feed').querySelector('img') && !A.w.pwned && /<img src=x/.test(A.$('chat-feed').textContent), 'an AI\'s text is shown as text, never run as HTML');
    A.$('chat-stop').click();
    await tick(150);
    assert(pc2.calls.some((c) => c.fn === 'stopAll'), '⏹ Stop');
    // Alfred
    A.w.document.querySelector('[data-tab="alfred"]').click();
    await tick(200);
    assert(!A.$('s-alfred').hidden && A.$('alfred-feed').querySelectorAll('.bubble.alfred').length === 1, '🎩 Alfred: his chat');
    A.$('alfred-text').value = 'Is the cover done?';
    A.$('alfred-form').dispatchEvent(new A.w.Event('submit', { cancelable: true }));
    await tick(1800);
    assert(pc2.calls.some((c) => c.channel === 'alfred:ask' && c.payload.text === 'Is the cover done?') && /look into it/.test(A.$('alfred-feed').textContent), 'ask Alfred; his answer shows');
    // alerts
    phone6.notice({ title: 'Claude hit its usage limit', body: 'Try again at 6 pm' });
    await A.app.loadState();
    A.w.document.querySelector('[data-tab="alerts"]').click();
    await tick(100);
    assert(/usage limit/.test(A.$('alerts-list').textContent) && A.$('alerts-list').querySelectorAll('.unseen').length >= 1, '🔔 Alerts: the new ones stand out');
    A.$('alerts-all').click();
    await tick(250);
    assert(A.$('alerts-badge').hidden, 'Mark all read → no badge');
    // the key is revoked on the PC → back to pairing
    await phone6.newKey();
    await A.app.loadState();
    assert(!A.$('s-pair').hidden && A.$('tabs').hidden && !A.w.localStorage.getItem('autoinjector.phone.key'), 'un-paired on the PC → the phone shows "Pair this phone" again');
    await phone6.setEnabled(false);

    console.log('== phone-pair.js (the PC\'s 📱 Phone window, jsdom) ==');
    const ph = fs.readFileSync(path.join(DIR, 'phone-pair.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
    const dom = new JSDOM(ph, { runScripts: 'outside-only' });
    const w = dom.window;
    w.__PHONE_PAIR_NO_AUTOSTART = true;
    w.eval(fs.readFileSync(path.join(DIR, 'phone-pair.js'), 'utf8'));
    const $ = (id) => w.document.getElementById(id);
    const calls = [];
    let cur = { enabled: false, running: false, port: 47800, links: [{ name: 'Wi-Fi', address: '192.168.1.42', url: 'http://192.168.1.42:47800/#k=abc' }], qr: '', phones: [] };
    const api = {
      phoneAppStatus: async () => cur,
      phoneAppSetEnabled: async (on) => { calls.push(['on', on]); cur = Object.assign({}, cur, { enabled: on, running: on, qr: on ? '<svg xmlns="http://www.w3.org/2000/svg"></svg>' : '', phones: on ? [{ phone: 'Pixel 8', lastSeen: Date.now() - 120000 }] : [] }); return Object.assign({ ok: true }, cur); },
      phoneAppNewKey: async () => { calls.push(['newkey']); return Object.assign({ ok: true, words: 'Every phone is un-paired.' }, cur); },
    };
    const stopPair = w.PhonePair.start(w.document, api);
    await tick(30);
    assert(!$('ph-on').checked && $('ph-pair').hidden && /Off/.test($('ph-state').textContent), 'off: the switch is off, no code shown');
    $('ph-on').checked = true;
    $('ph-on').dispatchEvent(new w.Event('change'));
    await tick(30);
    assert(calls.some((c) => c[0] === 'on' && c[1] === true) && !$('ph-pair').hidden && $('qr').querySelector('img').src.startsWith('data:image/svg+xml;base64,'), 'on: the QR code and the steps show');
    assert($('ph-link').value === 'http://192.168.1.42:47800/#k=abc' && /Pixel 8 · 2 min ago/.test($('ph-phones').textContent), 'the link, and the phone that used it');
    w.confirm = () => true;
    $('ph-newkey').click();
    await tick(30);
    assert(calls.some((c) => c[0] === 'newkey') && /un-paired/.test($('msg').textContent), 'Un-pair all phones');
    stopPair();
  }

  console.log('== 🌍 from anywhere (Tailscale) ==');
  {
    assert(core.tailnetAddresses({ Tailscale: [{ family: 'IPv4', address: '100.101.5.9' }], cgnatNot: [{ family: 'IPv4', address: '100.20.1.1' }], 'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.42' }] }).map((a) => a.address).join() === '100.101.5.9', 'the Tailscale address (100.64–100.127 only)');
    const tss = core.tailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'BATCAVE-PC.tail1a2b.ts.net.', TailscaleIPs: ['100.101.5.9', 'fd7a::1'] } }));
    assert(tss.running && tss.dnsName === 'batcave-pc.tail1a2b.ts.net' && tss.ip === '100.101.5.9', 'tailscale status: connected, the PC\'s Tailscale name and address');
    assert(core.tailscaleStatus('not json').running === false && core.tailscaleStatus({ BackendState: 'NeedsLogin' }).needsLogin, 'odd or signed-out status → not running / needs sign-in');
    assert(core.secureUrl('pc.tail.ts.net.', 'a b') === 'https://pc.tail.ts.net/#k=a%20b' && core.tailscaleLink('To enable, visit:\n  https://login.tailscale.com/f/serve?node=x1 \n') === 'https://login.tailscale.com/f/serve?node=x1', 'the secure link; Tailscale\'s "allow it" link picked out of its words');
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-ts-'));
    const pcT = makeFakePc();
    const ts = { installed: false, state: 'Running', serving: false, needOk: false, calls: [] };
    const fakeTs = async (args) => {
      ts.calls.push(args.join(' '));
      if (!ts.installed) return null;
      if (args[0] === 'status') return { code: 0, out: JSON.stringify({ BackendState: ts.state, Self: { DNSName: 'batcave-pc.tail1a2b.ts.net.', TailscaleIPs: ['100.101.5.9'] } }) };
      if (args[0] === 'serve' && args[1] === 'status') return { code: 0, out: ts.serving ? JSON.stringify({ Web: { 'batcave-pc.tail1a2b.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${port + 7}` } } } } }) : '{}' };
      if (args[0] === 'serve' && args[1] === '--bg') { if (ts.needOk) return { code: 1, out: 'Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=nABC123\n' }; ts.serving = true; return { code: 0, out: 'Available within your tailnet: https://batcave-pc.tail1a2b.ts.net/' }; }
      if (args[0] === 'serve' && args[1] === '--https=443') { ts.serving = false; return { code: 0, out: '' }; }
      return { code: 1, out: 'unknown' };
    };
    let ifs = pcT.deps.interfaces();
    const pT = createPhone(Object.assign({}, pcT.deps, { settingsFile: path.join(tmp2, 'p.json'), host: '127.0.0.1', port: port + 7, files: files(), tailscale: fakeTs, interfaces: () => ifs }));
    await pT.setEnabled(true);
    let st2 = await pT.status();
    assert(!st2.anywhere.tailscale.installed && !st2.anywhere.url, 'Tailscale not installed → no "anywhere" link (the window shows how to set it up)');
    ts.installed = true;
    ts.state = 'NeedsLogin';
    st2 = await (async () => { await pT.tailscaleInfo(true); return pT.status(); })();
    assert(st2.anywhere.tailscale.installed && st2.anywhere.tailscale.needsLogin && !st2.anywhere.tailscale.running, 'installed but signed out → says so');
    ts.state = 'Running';
    ifs = Object.assign({}, pcT.deps.interfaces(), { Tailscale: [{ family: 'IPv4', address: '100.101.5.9', internal: false }] });
    await pT.tailscaleInfo(true);
    st2 = await pT.status();
    const k7 = pT.load().key;
    assert(st2.anywhere.tailscale.running && st2.anywhere.url === `http://100.101.5.9:${port + 7}/#k=${k7}` && /^<svg/.test(st2.anywhere.qr), 'connected → the "from anywhere" link and its own QR code');
    assert(!st2.anywhere.secure.on && !st2.links.some((l) => l.address.startsWith('100.')), 'no secure link yet; the Tailscale address is not offered as a Wi-Fi address');
    ts.needOk = true;
    let r7 = await pT.setSecure(true);
    assert(!r7.ok && r7.error === 'TAILSCALE_NEEDS_OK' && r7.link === 'https://login.tailscale.com/f/serve?node=nABC123' && /allow it/.test(r7.words), 'the first time: Tailscale\'s "allow HTTPS" link is shown with what to do');
    ts.needOk = false;
    r7 = await pT.setSecure(true);
    assert(r7.ok && r7.anywhere.secure.on && r7.anywhere.secure.url === `https://batcave-pc.tail1a2b.ts.net/#k=${k7}` && /^<svg/.test(r7.anywhere.secure.qr), '🔒 secure link on → https://<pc>.<tailnet>.ts.net with its QR code');
    assert(ts.calls.includes(`serve --bg http://127.0.0.1:${port + 7}`), '…made with `tailscale serve` in front of the phone server');
    let rr = await req(port + 7, 'POST', '/api/stop', { key: k7, body: {}, headers: { Origin: 'https://batcave-pc.tail1a2b.ts.net' } });
    assert(rr.status === 200, 'the phone app on the secure link may post (its own name is trusted)');
    rr = await req(port + 7, 'POST', '/api/stop', { key: k7, body: {}, headers: { Origin: 'https://someone-else.tail9.ts.net' } });
    assert(rr.status === 403, 'another Tailscale name may not');
    rr = await req(port + 7, 'POST', '/api/stop', { key: k7, body: {}, headers: { Origin: 'http://batcave-pc.tail1a2b.ts.net' } });
    assert(rr.status === 403, 'nor the same name over plain http');
    r7 = await pT.setSecure(false);
    assert(r7.ok && !r7.anywhere.secure.on && ts.calls.includes('serve --https=443 off'), '🔓 secure link off');
    ts.state = 'Stopped';
    await pT.tailscaleInfo(true);
    r7 = await pT.setSecure(true);
    assert(!r7.ok && r7.error === 'TAILSCALE_OFF', 'Tailscale switched off → "open it and sign in"');
    await pT.setEnabled(false);
    st2 = await pT.status();
    assert(!st2.anywhere.url && !st2.anywhere.qr, 'phone access off → no anywhere link either');
    fs.rmSync(tmp2, { recursive: true, force: true });

    if (JSDOM) {
      const ph = fs.readFileSync(path.join(DIR, 'phone-pair.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
      const dom = new JSDOM(ph, { runScripts: 'outside-only' });
      const w = dom.window;
      w.__PHONE_PAIR_NO_AUTOSTART = true;
      w.eval(fs.readFileSync(path.join(DIR, 'phone-pair.js'), 'utf8'));
      const $ = (id) => w.document.getElementById(id);
      const base = { enabled: true, running: true, port: 47800, links: [{ name: 'Wi-Fi', address: '192.168.1.42', url: 'http://192.168.1.42:47800/#k=abc' }], qr: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', phones: [] };
      let cur = Object.assign({}, base, { anywhere: { tailscale: { installed: false }, url: '', qr: '', secure: { on: false } } });
      const calls = [];
      const api = { phoneAppStatus: async () => cur, phoneAppSetEnabled: async () => cur, phoneAppNewKey: async () => cur,
        phoneAppSecure: async (on) => { calls.push(on); if (calls.length === 1) return Object.assign({ ok: false, error: 'TAILSCALE_NEEDS_OK', link: 'https://login.tailscale.com/f/serve?node=n1', words: 'Tailscale needs your OK first' }, cur); cur = Object.assign({}, cur, { anywhere: Object.assign({}, cur.anywhere, { secure: { on: true, url: 'https://batcave-pc.tail1a2b.ts.net/#k=abc', qr: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' } }) }); return Object.assign({ ok: true, words: 'The secure link is on.' }, cur); } };
      const stop = w.PhonePair.start(w.document, api);
      await tick(30);
      assert(!$('ph-anywhere').hidden && !$('ph-ts-setup').hidden && $('ph-ts-ready').hidden && /not installed/.test($('ph-ts-state').textContent) && /tailscale\.com\/download/.test($('ph-ts-setup').textContent), '📱 Phone window: no Tailscale → the three set-up steps');
      cur = Object.assign({}, base, { anywhere: { tailscale: { installed: true, running: true, dnsName: 'batcave-pc.tail1a2b.ts.net' }, url: 'http://100.101.5.9:47800/#k=abc', qr: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', secure: { on: false } } });
      w.PhonePair.render(w.document, cur, Date.now());
      assert($('ph-ts-setup').hidden && !$('ph-ts-ready').hidden && $('qr-any').querySelector('img') && $('ph-any-link').value === 'http://100.101.5.9:47800/#k=abc' && /batcave-pc\.tail1a2b\.ts\.net/.test($('ph-ts-name').textContent), 'connected → the "from anywhere" QR code and link');
      $('ph-secure').click();
      await tick(30);
      assert(!$('ph-secure-link-row').hidden && $('ph-secure-link').value === 'https://login.tailscale.com/f/serve?node=n1', 'the secure link needs Tailscale\'s OK → its link is shown to open');
      $('ph-secure').click();
      await tick(30);
      assert(calls.join() === 'true,true' && !$('ph-secure-box').hidden && $('qr-secure').querySelector('img') && $('ph-secure-url').value.startsWith('https://') && /Turn off/.test($('ph-secure').textContent), 'then on → the 🔒 QR code and link; the button turns it off');
      stop();

      // 🎤 on the phone: only on a secure page with speech recognition
      const ah = fs.readFileSync(path.join(DIR, 'phone-app.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
      const mk = (secure) => {
        const d2 = new JSDOM(ah, { url: 'https://batcave-pc.tail1a2b.ts.net/', runScripts: 'outside-only', pretendToBeVisual: true });
        const w2 = d2.window;
        w2.__PHONE_APP_NO_AUTOSTART = true;
        w2.scrollTo = () => {};
        Object.defineProperty(w2, 'isSecureContext', { value: secure, configurable: true });
        const recs = [];
        w2.webkitSpeechRecognition = function () { this.start = () => recs.push(this); this.stop = () => { if (this.onend) this.onend(); }; };
        w2.eval(fs.readFileSync(path.join(DIR, 'phone-app.js'), 'utf8'));
        w2.PhoneApp.start(w2.document, { fetch: async () => ({ status: 200, json: async () => ({ ok: true }) }), poll: false, location: w2.location, history: w2.history });
        return { w2, recs };
      };
      let M = mk(false);
      assert(!M.w2.document.querySelector('.mic'), 'plain home link (not secure) → no 🎤 button (the keyboard\'s 🎤 is the way)');
      M = mk(true);
      const mics = M.w2.document.querySelectorAll('.mic');
      assert(mics.length === 2, 'secure link → a 🎤 in Chat and in Alfred');
      M.w2.document.getElementById('chat-text').value = 'Hello';
      mics[0].click();
      assert(M.recs.length === 1 && mics[0].getAttribute('aria-pressed') === 'true', 'tap 🎤 → it listens');
      M.recs[0].onresult({ results: [[{ transcript: 'tell Claude to keep going' }]] });
      M.recs[0].stop();
      assert(M.w2.document.getElementById('chat-text').value === 'Hello tell Claude to keep going' && mics[0].getAttribute('aria-pressed') === 'false', 'what you said is added to the message; tap again / it stops');
    }
  }

  console.log('== the wiring ==');
  const main = fs.readFileSync(path.join(DIR, 'main.js'), 'utf8');
  for (const ch of ['phoneapp:window', 'phoneapp:status', 'phoneapp:set-enabled', 'phoneapp:new-key', 'phoneapp:secure']) assert(main.includes(`ipcMain.handle("${ch}"`), `main.js handles ${ch}`);
  assert(/function phoneLanEnabled\(\) \{\s*return process\.env\.AUTOINJECTOR_BRIDGE_HOST === "0\.0\.0\.0";/.test(main), 'the old switch can no longer put the whole bridge on the Wi-Fi');
  assert(/_phoneApp\.notice\(n\)/.test(main), 'desktop notices go to the phone\'s alerts');
  const preload = fs.readFileSync(path.join(DIR, 'preload.js'), 'utf8');
  for (const fn of ['phoneAppOpenWindow', 'phoneAppStatus', 'phoneAppSetEnabled', 'phoneAppNewKey', 'phoneAppSecure']) assert(preload.includes(`${fn}:`), `preload: ${fn}`);
  const pkg = JSON.parse(fs.readFileSync(path.join(DIR, 'package.json'), 'utf8'));
  for (const f of ['phone-core.js', 'phone-server.js', 'phone-main.js', 'phone-app.html', 'phone-app.js', 'phone-app.css', 'phone-icon.svg', 'phone-pair.html', 'phone-pair.js']) assert(pkg.build.files.includes(f), `packaged: ${f}`);
  assert(pkg.dependencies.qrcode === '1.5.4', 'the QR code maker is a pinned dependency');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
