// test/phone-pc.test.js — 📱🖥 the phone as a remote control for the whole program:
//   * phone-pc.js: which actions the phone may run (exactly the channels the PC panel's preload.js uses), the live
//     updates queue (long-poll, falling behind), JSON-safe answers, the panel page for the phone
//   * over real HTTP (phone-main + phone-server, a fake PC): the panel page and its scripts load without the key (code
//     only) and nothing else of the app folder does; every action needs the key; an action the panel does not have is
//     refused; a foreign page can't post; the PC's live updates reach the phone; the shim runs the real preload.js
//   * 📚 the book app's door (phone-akowe-door.js): closed without the phone app's cookie; with it, Akọwe's pages and
//     API pass through unchanged (its own token still needed), the cookie is not passed on; off with the phone app
// Run with: node test/phone-pc.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const pc = require('../phone-pc');
const { createPhone } = require('../phone-main');
const { doorValue, COOKIE } = require('../phone-akowe-door');
const { makeFakePc } = require('./fixtures/phone-fake');

let passed = 0;
let failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log(`  ok   - ${msg}`); } else { failed++; console.log(`  FAIL - ${msg}`); } return cond; }
const DIR = path.join(__dirname, '..');
const read = (n) => fs.readFileSync(path.join(DIR, n), 'utf8');

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

async function unit() {
  console.log('\n== phone-pc.js: the actions the phone may run = the PC panel\'s own ==');
  const ch = pc.channelsOf(read('preload.js'));
  assert(ch.invoke.has('send:compose') && ch.invoke.has('state:get') && ch.invoke.has('logs:extract-all'), `the panel's actions are found (${ch.invoke.size} of them)`);
  assert(ch.on.has('prompts-changed') && ch.on.has('ai-download'), `…and its live updates (${ch.on.size})`);
  assert(ch.invoke.size > 200, 'every action of the Windows panel is there (not a hand-picked few)');
  const fake = pc.channelsOf('ipcRenderer.invoke("a:b", x); ipcRenderer.on("c", f); foo.invoke("nope")');
  assert(fake.invoke.has('a:b') && !fake.invoke.has('nope') && fake.on.has('c'), 'only ipcRenderer.invoke/on calls count');

  console.log('\n== the live updates queue ==');
  const q = pc.createEventQueue({ max: 5 });
  const w = q.wait(0, 2000);
  q.push('state', { n: 1, fn: () => 1 });
  const got = await w;
  assert(got.events.length === 1 && got.events[0].channel === 'state' && got.events[0].payload.n === 1 && !('fn' in got.events[0].payload), 'a waiting phone gets the next update at once (functions dropped)');
  for (let i = 2; i <= 9; i++) q.push('state', { n: i });
  assert(q.size() === 5, 'only the newest updates are kept');
  const behind = q.since(1);
  assert(behind.gap === true, 'a phone that fell behind is told to reload (gap)');
  const fresh = q.since(q.last());
  assert(fresh.events.length === 0 && !fresh.gap, 'nothing new: an empty answer');
  const t0 = Date.now();
  const none = await q.wait(q.last(), 150);
  assert(none.events.length === 0 && Date.now() - t0 >= 140, 'a long-poll with nothing new waits, then answers empty');

  console.log('\n== JSON-safe answers ==');
  const cyc = { a: 1 }; cyc.self = cyc;
  const s = pc.jsonSafe({ cyc, buf: Buffer.from('abc'), d: new Date(0), m: new Map([['x', 1]]), set: new Set([1, 2]), e: new Error('boom'), nan: NaN, big: 10n });
  assert(s.cyc.self === null && s.buf.bytes === 3 && s.d === '1970-01-01T00:00:00.000Z' && s.m.x === 1 && s.set.length === 2 && s.e.message === 'boom' && s.nan === null && s.big === '10', 'cycles, Buffers, dates, maps, sets, errors, NaN and BigInt become plain JSON');

  console.log('\n== the panel page for the phone ==');
  const html = read('controls.html');
  const page = pc.pcPage(html);
  const iShim = page.indexOf('/pc/__shim.js');
  const iPre = page.indexOf('/pc/__preload.js');
  const iFirst = page.indexOf('<script src="alfred-format.js"') >= 0 ? page.search(/<script src="(?!\/pc\/)/) : -1;
  assert(/name="viewport"/.test(page) && /<base href="\/pc\/">/.test(page), 'a phone viewport and the /pc/ base');
  assert(iShim > 0 && iShim < iPre && iPre < iFirst, 'the shim, then the PC\'s preload.js, before the panel\'s own scripts');
  const scripts = pc.pageScripts(html);
  assert(scripts.has('controls.js') && scripts.has('images-studio.js') && !scripts.has('main.js'), `the panel's own scripts (${scripts.size})`);

  console.log('\n== the shim runs the real preload.js (window.api, the same as in Electron) ==');
  const posts = [];
  const win = { location: { hash: '#k=KEY123', pathname: '/pc/', search: '' }, history: { replaceState() {} }, console };
  const store = {};
  win.localStorage = { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = String(v); } };
  win.fetch = async (url, o) => { posts.push({ url, o }); return { status: 200, json: async () => ({ ok: true, value: { echoed: JSON.parse(o.body).channel } }) }; };
  win.document = { addEventListener() {} };
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(pc.shimSource(), ctx);
  vm.runInContext(read('preload.js'), ctx);
  assert(typeof win.api === 'object' && typeof win.api.sendCompose === 'function', 'window.api is the PC panel\'s own api');
  const v = await win.api.sendCompose('hello', ['claude']);
  const body = JSON.parse(posts[0].o.body);
  assert(posts[0].url === '/api/ipc' && body.channel === 'send:compose' && body.args[0].text === 'hello' && body.args[0].targets[0] === 'claude' && v.echoed === 'send:compose', 'pressing Send on the phone runs send:compose on the PC, with the same arguments');
  assert(posts[0].o.headers.Authorization === 'Bearer KEY123' && store['autoinjector.phone.key'] === 'KEY123', 'with the pairing key from the link (kept like the phone app keeps it)');
}

async function http_() {
  console.log('\n== over real HTTP: the whole panel on the phone ==');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-pc-'));
  const fake = makeFakePc({ now: Date.now() });
  const ran = [];
  // a fake Akọwe on this PC
  const akoweSeen = [];
  const akoweSrv = http.createServer((rq, rs) => { akoweSeen.push({ url: rq.url, host: rq.headers.host, cookie: rq.headers.cookie || '', auth: rq.headers.authorization || '' }); if (rq.url === '/' ) { rs.writeHead(200, { 'Content-Type': 'text/html' }); rs.end('<h1>Akọwe</h1>'); } else if (rq.url === '/api/books') { if (rq.headers.authorization !== 'Bearer AKTOKEN') { rs.writeHead(401); rs.end('{}'); } else { rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end('{"books":[1]}'); } } else { rs.writeHead(302, { Location: 'http://127.0.0.1:1/somewhere' }); rs.end(); } });
  await new Promise((r) => akoweSrv.listen(0, '127.0.0.1', r));
  const akowePort = akoweSrv.address().port;
  const port = 47960 + Math.floor(Math.random() * 30);
  const phone = createPhone(Object.assign({ settingsFile: path.join(tmp, 'p.json'), host: '127.0.0.1', port, now: () => Date.now(),
    files: { '/': { type: 'text/html', body: '<html></html>' } },
    ipcCall: async (channel, args) => { ran.push({ channel, args }); if (channel === 'state:get') return { participants: [], fn: () => 1, when: new Date(0) }; if (channel === 'transcript:clear') throw new Error('boom'); return { ok: true }; },
    preloadSource: () => read('preload.js'),
    appFile: (n) => (/^[A-Za-z0-9_\-]+\.(js|html)$/.test(n) ? read(n) : null),
    akoweLink: () => ({ token: 'AKTOKEN' }),
    akowePort: () => akowePort,
  }, fake.deps));
  await phone.setEnabled(true);
  const key = phone.load().key;
  try {
    const pg = await req(port, 'GET', '/pc/');
    assert(pg.status === 200 && /__shim\.js/.test(pg.raw) && /text\/html/.test(pg.headers['content-type']) && /script-src 'self'/.test(pg.headers['content-security-policy']), 'the panel page loads (no key needed: it is code), with a strict script policy');
    const js = await req(port, 'GET', '/pc/controls.js');
    assert(js.status === 200 && js.raw.length > 10000, 'the panel\'s scripts load');
    assert((await req(port, 'GET', '/pc/__preload.js')).status === 200 && (await req(port, 'GET', '/pc/__shim.js')).status === 200, 'the preload and the shim load');
    for (const p of ['/pc/main.js', '/pc/phone-main.js', '/pc/../main.js', '/pc/package.json', '/pc/akowe-server.js']) {
      assert((await req(port, 'GET', p)).status === 404, `nothing else of the app folder: ${p}`);
    }
    assert((await req(port, 'POST', '/api/ipc', { body: { channel: 'state:get', args: [] } })).status === 401, 'an action needs the key');
    const st = await req(port, 'POST', '/api/ipc', { key, body: { channel: 'state:get', args: [] }, headers: { Origin: `http://127.0.0.1:${port}` } });
    assert(st.status === 200 && st.json.ok && st.json.value.when === '1970-01-01T00:00:00.000Z' && !('fn' in st.json.value), 'an action runs on the PC and its answer comes back as plain JSON');
    const send = await req(port, 'POST', '/api/ipc', { key, body: { channel: 'send:compose', args: [{ text: 'hi', targets: ['claude'] }] } });
    assert(send.json.ok && ran.some((r) => r.channel === 'send:compose' && r.args[0].text === 'hi'), 'the same arguments reach the PC\'s own handler');
    const no = await req(port, 'POST', '/api/ipc', { key, body: { channel: 'app:delete-everything', args: [] } });
    assert(no.json.ok === false && no.json.error === 'NOT_ALLOWED' && !ran.some((r) => r.channel === 'app:delete-everything'), 'an action the Windows panel does not have is refused');
    const boom = await req(port, 'POST', '/api/ipc', { key, body: { channel: 'transcript:clear', args: [] } });
    assert(boom.json.ok === false && boom.json.error === 'PC_ERROR', 'a handler that fails gives a plain error, not a crash');
    const foreign = await req(port, 'POST', '/api/ipc', { key, body: { channel: 'state:get' }, headers: { Origin: 'https://evil.example' } });
    assert(foreign.status === 403, 'a foreign web page can\'t run actions');
    const big = await req(port, 'POST', '/api/ipc', { key, body: { channel: 'send:compose', args: [{ text: 'x'.repeat(100 * 1024) }] } });
    assert(big.json.ok, 'a long prompt (100 KB) goes through');

    console.log('\n== the PC\'s live updates reach the phone ==');
    const first = await req(port, 'GET', '/api/ipc/events?since=0&wait=0', { key });
    const s0 = first.json.seq;
    const later = req(port, 'GET', `/api/ipc/events?since=${s0}&wait=5000`, { key });
    await new Promise((r) => setTimeout(r, 100));
    phone.pushEvent('prompts-changed', { list: [1, 2] });
    phone.pushEvent('not-a-panel-event', { x: 1 });
    const got = await later;
    assert(got.json.ok && got.json.events.length === 1 && got.json.events[0].channel === 'prompts-changed' && got.json.events[0].payload.list.length === 2, 'a waiting phone gets the update the PC panel gets (and only panel updates)');
    assert((await req(port, 'GET', '/api/ipc/events?since=0&wait=0')).status === 401, 'updates need the key too');

    console.log('\n== 📚 the book app\'s door ==');
    const doorPort = phone.door.info().port;
    assert(doorPort === port + 1, 'the door is on the next port');
    const closed = await req(doorPort, 'GET', '/');
    assert(closed.status === 401 && /Open the book app from the phone app/.test(closed.raw) && akoweSeen.length === 0, 'without the phone app\'s cookie the door stays shut (Akọwe is never asked)');
    const wrong = await req(doorPort, 'GET', '/', { headers: { Cookie: `${COOKIE}=nope` } });
    assert(wrong.status === 401, 'a wrong cookie: shut');
    assert((await req(port, 'GET', '/api/akowe/link')).status === 401, 'the book app link needs the key');
    const link = await req(port, 'GET', '/api/akowe/link', { key });
    const setc = String((link.headers['set-cookie'] || [])[0] || '');
    assert(link.json.ok && link.json.url === `http://127.0.0.1:${doorPort}/#token=AKTOKEN` && !('cookie' in link.json), 'the phone gets the book app\'s address with Akọwe\'s token');
    assert(setc.startsWith(`${COOKIE}=${doorValue(key)};`) && /HttpOnly/.test(setc) && /SameSite=Lax/.test(setc), '…and the door cookie (HttpOnly)');
    const cookie = `${COOKIE}=${doorValue(key)}; other=1`;
    const home = await req(doorPort, 'GET', '/', { headers: { Cookie: cookie } });
    assert(home.status === 200 && /Akọwe/.test(home.raw), 'with the cookie, Akọwe\'s own page comes through');
    const api = await req(doorPort, 'GET', '/api/books', { headers: { Cookie: cookie, Authorization: 'Bearer AKTOKEN' } });
    assert(api.status === 200 && api.json.books.length === 1, 'Akọwe\'s API works through the door (with its own token)');
    const noTok = await req(doorPort, 'GET', '/api/books', { headers: { Cookie: cookie } });
    assert(noTok.status === 401, 'Akọwe still refuses without its token');
    const seen = akoweSeen[akoweSeen.length - 1];
    assert(seen.host === `127.0.0.1:${akowePort}` && !seen.cookie, 'Akọwe sees a local request, never the door cookie');
    const redir = await req(doorPort, 'GET', '/redirect', { headers: { Cookie: cookie } });
    assert(redir.status === 302 && redir.headers.location === '/somewhere', 'Akọwe\'s own redirects stay on the door');

    await phone.setEnabled(false);
    assert(!phone.door.running() && (await req(doorPort, 'GET', '/', { headers: { Cookie: cookie } })).status === 0, 'switching the phone app off closes the door too');
    const newKeyPhone = await phone.setEnabled(true);
    assert(newKeyPhone.ok && phone.door.running(), 'and on again opens it');
    await phone.newKey();
    const old = await req(doorPort, 'GET', '/', { headers: { Cookie: cookie } });
    assert(old.status === 401, 'a new pairing key also locks the old door cookie out');
  } finally {
    await phone.setEnabled(false);
    await new Promise((r) => akoweSrv.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async () => {
  try { await unit(); await http_(); } catch (e) { failed++; console.log('  FAIL - crashed:', e && e.stack); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
