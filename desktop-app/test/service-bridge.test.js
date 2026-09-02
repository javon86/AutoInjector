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
  jarvis: {
    status: () => ({ manager: { taskId: null, status: 'idle', codeRuns: [] } }),
    start: async (goal) => { calls.jarvisGoal = goal; return { manager: { taskId: 'T1', status: 'classifying', userRequest: goal } }; },
    stop: async () => { calls.jarvisStop = true; return { ok: true }; },
  },
  interpreter: {
    status: () => ({ configured: true, enabled: true, endpoint: 'http://127.0.0.1:9/run', model: 'local', autoRun: false }),
    configure: (patch) => ({ configured: true, enabled: !!patch.enabled, endpoint: patch.endpoint || 'http://127.0.0.1:9/run' }),
    run: async (task, { onEvent }) => {
      calls.interpreterRun = task;
      onEvent({ type: 'code', format: 'python', content: 'print(1)' });
      onEvent({ type: 'output', content: '1' });
      return { ok: true, message: `ran: ${task}`, events: [{ type: 'code' }, { type: 'output' }] };
    },
  },
  tools: {
    list: () => [{ name: 'echo', description: 'echo', risk: 'monitor' }, { name: 'http-fetch', description: 'GET a URL', risk: 'ask' }],
    run: async (name, args, { onEvent }) => { calls.toolRun = { name, args }; onEvent({ type: 'output', content: 'ok' }); return { ok: true, message: `tool ${name} ok` }; },
  },
  voice: {
    status: () => ({ configured: true, enabled: false, endpoint: 'http://127.0.0.1:8232', speakOnAck: true }),
    configure: (patch) => ({ configured: true, enabled: !!patch.enabled, endpoint: patch.endpoint || 'http://127.0.0.1:8232', speakOnAck: true }),
    speak: async (text) => { calls.voiceSpeak = text; return { ok: true, ms: 5 }; },
    listen: async (opts) => { calls.voiceListen = opts; return { ok: true, text: 'heard something' }; },
  },
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

  console.log('\n== Open Interpreter (code execution) capability ==');
  {
    const st = await req('GET', '/interpreter/status', { token: TOKEN });
    assert(st.status === 200 && st.json.configured === true && st.json.endpoint, 'GET /interpreter/status reports the OI endpoint');
    const cfg = await req('POST', '/interpreter/settings', { token: TOKEN, body: { enabled: true, endpoint: 'http://127.0.0.1:9/run' } });
    assert(cfg.status === 200 && cfg.json.ok === true, 'POST /interpreter/settings configures the adapter');
    const run = await req('POST', '/interpreter/run', { token: TOKEN, body: { task: 'add 2 and 2' } });
    assert(run.status === 200 && run.json.ok === true && run.json.message === 'ran: add 2 and 2', 'POST /interpreter/run executes and returns the result');
    assert(calls.interpreterRun === 'add 2 and 2', 'the run reached the interpreter adapter with the task');
    const noTask = await req('POST', '/interpreter/run', { token: TOKEN, body: {} });
    assert(noTask.status === 400 && noTask.json.error === 'NEED_TASK', 'a run with no task is rejected');
  }

  console.log('\n== Jarvis orchestrator (native supervisor) ==');
  {
    const st = await req('GET', '/jarvis/status', { token: TOKEN });
    assert(st.status === 200 && st.json.manager && st.json.manager.status === 'idle', 'GET /jarvis/status returns the supervisor state');
    const start = await req('POST', '/jarvis/start', { token: TOKEN, body: { goal: 'summarize the news and compute a total' } });
    assert(start.status === 200 && start.json.manager && start.json.manager.taskId === 'T1', 'POST /jarvis/start kicks off a task');
    assert(calls.jarvisGoal === 'summarize the news and compute a total', 'the goal reached the orchestrator');
    const noGoal = await req('POST', '/jarvis/start', { token: TOKEN, body: {} });
    assert(noGoal.status === 400 && noGoal.json.error === 'NEED_GOAL', 'a start with no goal is rejected');
    const stop = await req('POST', '/jarvis/stop', { token: TOKEN });
    assert(stop.status === 200 && calls.jarvisStop === true, 'POST /jarvis/stop stops the task');
  }

  console.log('\n== Tools registry (N5) ==');
  {
    const lst = await req('GET', '/tools/list', { token: TOKEN });
    assert(lst.status === 200 && Array.isArray(lst.json.tools) && lst.json.tools.some((t) => t.name === 'echo'), 'GET /tools/list returns the registry');
    const run = await req('POST', '/tools/run', { token: TOKEN, body: { tool: 'echo', args: { x: 1 } } });
    assert(run.status === 200 && run.json.ok === true && run.json.message === 'tool echo ok', 'POST /tools/run invokes a tool and returns its result');
    assert(calls.toolRun && calls.toolRun.name === 'echo' && calls.toolRun.args.x === 1, 'the tool name + args reached the registry');
    const noTool = await req('POST', '/tools/run', { token: TOKEN, body: {} });
    assert(noTool.status === 400 && noTool.json.error === 'NEED_TOOL', 'a run with no tool is rejected');
  }

  console.log('\n== Voice (N2) ==');
  {
    const st = await req('GET', '/voice/status', { token: TOKEN });
    assert(st.status === 200 && st.json.configured === true && st.json.speakOnAck === true, 'GET /voice/status reports the voice config');
    const cfg = await req('POST', '/voice/settings', { token: TOKEN, body: { enabled: true } });
    assert(cfg.status === 200 && cfg.json.ok === true && cfg.json.enabled === true, 'POST /voice/settings configures voice');
    const spk = await req('POST', '/voice/speak', { token: TOKEN, body: { text: 'hello there' } });
    assert(spk.status === 200 && spk.json.ok === true && calls.voiceSpeak === 'hello there', 'POST /voice/speak speaks the text');
    const noText = await req('POST', '/voice/speak', { token: TOKEN, body: {} });
    assert(noText.status === 400 && noText.json.error === 'NEED_TEXT', 'a speak with no text is rejected');
    const lsn = await req('POST', '/voice/listen', { token: TOKEN, body: { seconds: 4 } });
    assert(lsn.status === 200 && lsn.json.ok === true && lsn.json.text === 'heard something', 'POST /voice/listen returns a transcript');
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
            listener('manager-ack', { taskId: 'T1', text: 'On it — working on: ...' });
            listener('manager-state', { status: 'delegating' });
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
    assert(events.includes('jarvis-ack'), 'the butler ack is delivered as a "jarvis-ack" event');
    assert(events.includes('jarvis'), 'the butler state is delivered as a "jarvis" event');
    assert(events.filter((e) => e === 'error').length >= 2, 'an internal error log (poll-error) is also surfaced as "error"');
  }

  await bridge.stop();
  assert(true, 'bridge.stop() closed the server cleanly');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('crashed:', e && e.stack || e); process.exit(1); });
