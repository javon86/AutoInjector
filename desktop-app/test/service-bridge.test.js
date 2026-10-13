// test/service-bridge.test.js — the lean local bridge (service-bridge.js) that the
// phone companion talks to. Starts a real HTTP server on an ephemeral port with
// STUB deps and drives it over HTTP: auth, status, responses, send, silence, the
// phone shell (no token), same-origin writes, and the SSE stream.
// Run: node test/service-bridge.test.js
const http = require('http');
const { createServiceBridge } = require('../service-bridge');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

const TOKEN = 'test-secret';
const calls = { sendTo: [], sendAll: [], silenced: 0 };
let listener = null;

const bridge = createServiceBridge({
  version: '9.9.9',
  status: () => ({
    participants: [
      { id: 'chatgpt', label: 'ChatGPT', enabled: true, waiting: false },
      { id: 'claude', label: 'Claude', enabled: true, waiting: true },
    ],
    routing: { chatgpt: [], claude: [], gemini: [] },
    mesh: false,
  }),
  responses: ({ since, limit, site }) => {
    const rows = [{ id: 1, site: 'chatgpt', label: 'ChatGPT', text: 'first', ts: 10 }, { id: 2, site: 'claude', label: 'Claude', text: 'second', ts: 20 }];
    return rows.filter((r) => (!site || r.site === site) && (!since || r.id > since)).slice(-(limit || 100));
  },
  sendTo: async (site, text) => { calls.sendTo.push({ site, text }); return site === 'chatgpt' ? { ok: true, method: 'click' } : { ok: false, error: 'BAD_SITE' }; },
  sendAll: async (text, targets) => { calls.sendAll.push({ text, targets }); return { results: { chatgpt: { ok: true } } }; },
  silence: async () => { calls.silenced++; return { ok: true, global: { meshActive: false } }; },
  subscribe: (fn) => { listener = fn; return () => { listener = null; }; },
  mobilePage: '<!doctype html><title>AI Phone</title><body>phone shell</body>',
});

function req(method, path, { body, token, raw, origin, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (origin) headers['Origin'] = origin;
    if (host) headers['Host'] = host;
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method, headers }, (res) => {
      let buf = ''; res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: raw ? buf : safeJson(buf) }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
function safeJson(s) { try { return JSON.parse(s); } catch (_) { return s; } }

let PORT = 0;

async function main() {
  const started = await bridge.start({ port: 0, host: '127.0.0.1', token: TOKEN });
  assert(started.ok && started.port > 0, `bridge started on 127.0.0.1:${started.port}`);
  PORT = started.port;

  console.log('\n== auth: a token-protected bridge rejects unauthenticated data calls ==');
  assert((await req('GET', '/status')).status === 401, 'no token -> 401');
  assert((await req('GET', '/status', { token: 'wrong' })).status === 401, 'wrong token -> 401');
  const ok = await req('GET', '/health', { token: TOKEN });
  assert(ok.status === 200 && ok.json.service === 'autoinjector', 'correct token -> 200');

  console.log('\n== status + responses ==');
  const s = await req('GET', '/status', { token: TOKEN });
  assert(s.status === 200 && s.json.participants.length === 2, 'GET /status returns participants');
  const all = await req('GET', '/responses', { token: TOKEN });
  assert(all.json.responses.length === 2 && all.json.responses[0].text === 'first', 'GET /responses returns the captured transcript');
  const since = await req('GET', '/responses?since=1', { token: TOKEN });
  assert(since.json.responses.length === 1 && since.json.responses[0].id === 2, 'since= filters to newer');

  console.log('\n== send + silence ==');
  const one = await req('POST', '/participants/chatgpt/send', { token: TOKEN, body: { text: 'hi gpt' } });
  assert(one.status === 200 && calls.sendTo[0].text === 'hi gpt', 'POST /participants/chatgpt/send delivers');
  const fan = await req('POST', '/send', { token: TOKEN, body: { text: 'everyone' } });
  assert(fan.status === 200 && calls.sendAll[0].text === 'everyone', 'POST /send fans out');
  const noText = await req('POST', '/send', { token: TOKEN, body: {} });
  assert(noText.status === 400 && noText.json.error === 'NEED_TEXT', 'a send with no text is rejected');
  const stop = await req('POST', '/silence', { token: TOKEN });
  assert(stop.status === 200 && calls.silenced === 1, 'POST /silence halts all relay');

  console.log('\n== phone shell + origin rules ==');
  const page = await req('GET', '/m', { raw: true });
  assert(page.status === 200 && /AI Phone/.test(page.json), 'GET /m serves the phone shell WITHOUT a token');
  const foreign = await req('POST', '/send', { token: TOKEN, origin: 'https://evil.example', body: { text: 'x' } });
  assert(foreign.status === 403 && foreign.json.error === 'FORBIDDEN_ORIGIN', 'a foreign-Origin write is refused');
  const localhost = await req('POST', '/send', { token: TOKEN, origin: 'http://localhost:3000', body: { text: 'ok' } });
  assert(localhost.status === 200, 'a localhost-Origin write is allowed');
  // Same-origin: the page served over the LAN/Tailscale posting back (Origin host === Host).
  const sameOrigin = await req('POST', '/silence', { token: TOKEN, host: '100.90.1.2:' + PORT, origin: 'http://100.90.1.2:' + PORT, body: {} });
  assert(sameOrigin.status === 200, 'a same-origin write from the served page is allowed over the network');
  const readForeign = await req('GET', '/status', { token: TOKEN, origin: 'https://evil.example' });
  assert(readForeign.status === 200, 'a GET is not origin-gated (the token already guards reads)');

  console.log('\n== SSE: a capture is delivered as a live "response" event ==');
  await new Promise((resolve) => {
    const events = [];
    const r = http.request({ host: '127.0.0.1', port: PORT, path: `/events?token=${TOKEN}`, method: 'GET' }, (res) => {
      assert(res.statusCode === 200 && /text\/event-stream/.test(res.headers['content-type'] || ''), 'GET /events opens an event-stream');
      let buf = '';
      res.on('data', (c) => {
        buf += c; let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = (chunk.match(/^event: (.+)$/m) || [])[1];
          if (ev) events.push(ev);
        }
        if (listener && events.includes('hello') && events.length === 1) {
          listener('capture', { id: 7, site: 'claude', label: 'Claude', text: 'a live reply', ts: 1 });
          listener('sent', { target: 'chatgpt' });
        }
        if (events.includes('response') && events.includes('sent')) { res.destroy(); assert(true, 'a capture -> "response", a send -> "sent"'); resolve(); }
      });
      res.on('error', () => resolve());
    });
    r.on('error', () => resolve());
    r.end();
    setTimeout(resolve, 3000);
  });

  await bridge.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('crashed:', e && e.stack || e); process.exit(1); });
