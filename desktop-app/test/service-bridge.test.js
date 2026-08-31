// test/service-bridge.test.js — the local service bridge (service-bridge.js).
// Starts a real HTTP server on an ephemeral port with STUB deps and drives it
// over real HTTP, so it verifies the transport + routing + auth + SSE without
// any Electron or relay machinery. Run: node test/service-bridge.test.js
const http = require('http');
const { createServiceBridge } = require('../service-bridge');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

const TOKEN = 'test-secret';
const calls = { sendTo: [], sendAll: [], councilStart: [], councilStop: 0 };
let listener = null; // the broadcast listener the bridge registers via subscribe()

const bridge = createServiceBridge({
  version: '9.9.9',
  status: () => ({
    participants: [
      { id: 'chatgpt', label: 'ChatGPT', enabled: true, ready: true, generating: false, waiting: false },
      { id: 'claude', label: 'Claude', enabled: true, ready: false, generating: true, waiting: true },
    ],
    council: { active: false, mode: null },
    routing: { chatgpt: [], claude: [], gemini: [] },
    mesh: false,
  }),
  responses: ({ since, limit, site }) => {
    const rows = [{ id: 1, site: 'chatgpt', text: 'first', ts: 10 }, { id: 2, site: 'claude', text: 'second', ts: 20 }];
    return rows.filter((r) => (!site || r.site === site) && (!since || r.id > since)).slice(-(limit || 100));
  },
  sendTo: async (site, text) => { calls.sendTo.push({ site, text }); return site === 'chatgpt' ? { ok: true, method: 'click' } : { ok: false, error: 'BAD_SITE' }; },
  sendAll: async (text, targets) => { calls.sendAll.push({ text, targets }); return { results: { chatgpt: { ok: true } } }; },
  councilStart: async (args) => { calls.councilStart.push(args); return args.mode ? { ok: true, houseRule: { mode: args.mode, active: true } } : { ok: false, error: 'BAD_MODE' }; },
  councilStop: async () => { calls.councilStop++; return { ok: true, houseRule: { active: false } }; },
  subscribe: (fn) => { listener = fn; return () => { listener = null; }; },
});

function req(method, path, { body, token, raw } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
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

  console.log('\n== auth: a token-protected bridge rejects unauthenticated requests ==');
  {
    const noAuth = await req('GET', '/status');
    assert(noAuth.status === 401, 'no token -> 401 UNAUTHORIZED');
    const badAuth = await req('GET', '/status', { token: 'wrong' });
    assert(badAuth.status === 401, 'wrong token -> 401');
    const ok = await req('GET', '/health', { token: TOKEN });
    assert(ok.status === 200 && ok.json.service === 'autoinjector' && ok.json.version === '9.9.9', 'correct token -> 200 with service/version');
  }

  console.log('\n== status + participants ==');
  {
    const s = await req('GET', '/status', { token: TOKEN });
    assert(s.status === 200 && Array.isArray(s.json.participants) && s.json.participants.length === 2, 'GET /status returns the participant list');
    assert(s.json.participants[1].generating === true && s.json.participants[1].waiting === true, 'per-participant generation/waiting state is exposed');
    const p = await req('GET', '/participants', { token: TOKEN });
    assert(p.status === 200 && p.json.participants[0].id === 'chatgpt', 'GET /participants returns just the participants');
  }

  console.log('\n== captured responses (since / site filters) ==');
  {
    const all = await req('GET', '/responses', { token: TOKEN });
    assert(all.status === 200 && all.json.responses.length === 2, 'GET /responses returns captured responses');
    const since = await req('GET', '/responses?since=1', { token: TOKEN });
    assert(since.json.responses.length === 1 && since.json.responses[0].id === 2, 'since= filters to newer responses');
    const site = await req('GET', '/responses?site=chatgpt', { token: TOKEN });
    assert(site.json.responses.length === 1 && site.json.responses[0].site === 'chatgpt', 'site= filters by participant');
  }

  console.log('\n== sending: one participant + all participants ==');
  {
    const one = await req('POST', '/participants/chatgpt/send', { token: TOKEN, body: { text: 'hello gpt' } });
    assert(one.status === 200 && one.json.ok === true, 'POST /participants/chatgpt/send delivers and reports ok');
    assert(calls.sendTo.length === 1 && calls.sendTo[0].site === 'chatgpt' && calls.sendTo[0].text === 'hello gpt', 'sendTo was called with the right site + text');
    const bad = await req('POST', '/participants/claude/send', { token: TOKEN, body: { text: 'x' } });
    assert(bad.status === 400 && bad.json.ok === false, 'a failed send surfaces as a 400 with ok:false');
    const noText = await req('POST', '/participants/chatgpt/send', { token: TOKEN, body: {} });
    assert(noText.status === 400 && noText.json.error === 'NEED_TEXT', 'a send with no text is rejected');
    const all = await req('POST', '/send', { token: TOKEN, body: { text: 'to everyone' } });
    assert(all.status === 200 && all.json.results, 'POST /send fans out to all participants');
    assert(calls.sendAll.length === 1 && calls.sendAll[0].text === 'to everyone', 'sendAll got the text');
    const some = await req('POST', '/send', { token: TOKEN, body: { text: 'two', targets: ['chatgpt', 'gemini'] } });
    assert(some.status === 200 && JSON.stringify(calls.sendAll[1].targets) === JSON.stringify(['chatgpt', 'gemini']), 'POST /send honors an explicit targets list');
  }

  console.log('\n== Council start / stop ==');
  {
    const start = await req('POST', '/council/start', { token: TOKEN, body: { mode: 'debate', topic: 'AI', rounds: 2 } });
    assert(start.status === 200 && start.json.ok === true, 'POST /council/start starts a run');
    assert(calls.councilStart.length === 1 && calls.councilStart[0].mode === 'debate' && calls.councilStart[0].topic === 'AI', 'councilStart got mode/topic/rounds');
    const bad = await req('POST', '/council/start', { token: TOKEN, body: { topic: 'x' } });
    assert(bad.status === 400, 'a bad council start (no mode) surfaces as 400');
    const stop = await req('POST', '/council/stop', { token: TOKEN });
    assert(stop.status === 200 && calls.councilStop === 1, 'POST /council/stop stops the run');
  }

  console.log('\n== unknown route ==');
  {
    const nf = await req('GET', '/nope', { token: TOKEN });
    assert(nf.status === 404 && nf.json.error === 'NOT_FOUND', 'unknown path -> 404');
  }

  console.log('\n== SSE: live events stream (response, generation, error, rate-limit, council) ==');
  {
    const events = [];
    await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: PORT, path: `/events?token=${TOKEN}`, method: 'GET' }, (res) => {
        assert(res.statusCode === 200 && /text\/event-stream/.test(res.headers['content-type'] || ''), 'GET /events opens an event-stream (token via query for EventSource)');
        let buf = '';
        res.on('data', (c) => {
          buf += c;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = (chunk.match(/^event: (.+)$/m) || [])[1];
            if (ev) events.push(ev);
          }
          // Once the bridge has registered our listener, push broadcasts through it.
          if (listener && events.includes('hello') && events.length === 1) {
            listener('capture', { site: 'claude', text: 'a reply', id: 7 });
            listener('generation', { site: 'claude', generating: false });
            listener('send-error', { site: 'gemini', error: 'NO_VIEW' });
            listener('capture', { site: 'chatgpt', text: 'rate limited', id: 8, isRateLimited: true });
            listener('houserule-state', { active: true, mode: 'debate' });
            listener('log', { kind: 'poll-error', error: 'boom' });
          }
          // Close only after the LAST-emitted event (the 2nd error, from the
          // poll-error log) has arrived, so nothing earlier is raced by the close.
          if (events.filter((e) => e === 'error').length >= 2 && events.includes('council')) { res.destroy(); resolve(); }
        });
        res.on('error', () => resolve());
      });
      r.on('error', reject);
      r.end();
      setTimeout(resolve, 3000); // safety
    });
    assert(events[0] === 'hello', 'the stream opens with a hello event');
    assert(events.includes('response'), 'a capture is delivered as a "response" event');
    assert(events.includes('generation'), 'a generation-state change is delivered');
    assert(events.includes('error'), 'a send-error is delivered as an "error" event');
    assert(events.includes('rate-limit'), 'a rate-limited capture also emits a "rate-limit" event');
    assert(events.includes('council'), 'a House-Rules/Council state change is delivered as "council"');
    assert(events.filter((e) => e === 'error').length >= 2, 'an internal error log (poll-error) is also surfaced as "error"');
  }

  await bridge.stop();
  assert(true, 'bridge.stop() closed the server cleanly');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('crashed:', e && e.stack || e); process.exit(1); });
