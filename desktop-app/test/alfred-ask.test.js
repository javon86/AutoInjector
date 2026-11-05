// test/alfred-ask.test.js — PR #126: "When I talk to the butler and ask him a question, he doesn't talk to me. I asked
// him to get a prompt from one of the AIs and then change it, and he didn't do it."
// Checked here:
//   A. (Alfred core, fakes) the typed-request intent ("get a prompt from ChatGPT … and make it …", "ask Claude to …");
//      a model that NEVER calls a tool → one stricter retry → a "💬 Ask ChatGPT now" (ask_ai) card → ✔ → the answer
//      comes back → his AI rewrites it (or, his AI down, the answer is shown and he says plainly he couldn't change it);
//      his AI down altogether → the ask card at once; ask_ai timeout / Akọwe using the AI → a plain message; an empty
//      model reply → a visible plain message + alfred-reply outcome "empty"; only refused tool calls → plain words;
//      ■ Stop reaches a waiting ask; the "stronger brain" tip after two struggles in a row (never changed by itself).
//   B. (the REAL main.js under mock Electron, fake panes, the Akọwe bridge on) the same typed request end to end: the
//      card → ✔ → typed into the ChatGPT pane with its [MSG #] → the pane answers (even without a [FROM:] tag) → Alfred
//      gets THAT answer, rewritten by his AI; it is shown in the conversation but never relayed; the wait times out
//      with a plain message; an AI an Akọwe request is waiting on is refused (nothing typed into it).
//   C. (the side panel, jsdom) the tip's buttons: "Use Claude (web pane) as Alfred's brain" / "Use a bigger model".
// Run: node test/alfred-ask.test.js
process.env.AUTOINJECTOR_BRIDGE = '0';
process.env.AUTOINJECTOR_CHECKIN = '0';
process.env.AUTOINJECTOR_AKOWE_SERVER = '0';
process.env.AUTOINJECTOR_SD_AUTOSTART = '0';
process.env.AUTOINJECTOR_POLL_MS = '50';
process.env.AUTOINJECTOR_STABLE_MS = '80';
process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS = '60';
process.env.AUTOINJECTOR_RETRY_BACKOFF_MS = '50';
process.env.AUTOINJECTOR_NOTAG_QUIET_MS = '400';
process.env.AUTOINJECTOR_CAPTURE_SETTLE_MS = '150';
process.env.AUTOINJECTOR_AKOWE_PORT = String(21000 + Math.floor(Math.random() * 20000));
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Module = require('module');
const { JSDOM } = require('jsdom');
const { createAlfred, askAiIntent } = require('../alfred');
const registry = require('../alfred-tools');
const { fakeLlm, toolCall, lastMsg } = require('./alfred-fakes');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, every = 40) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every); } return null; }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-ask-'));
const ofKind = (logs, k) => logs.filter((l) => l.k === k).map((l) => l.d);
const isRewrite = (body) => body.messages.some((m) => m.role === 'system' && /You rewrite a text for the user/.test(m.content));
const REQUEST = 'get a prompt from ChatGPT for a dragon picture and make it more dramatic';
const CHATGPT_ANSWER = 'A red dragon resting on a hill at sunset, detailed scales, soft light.';

function make({ llm, ctx = {}, settings = {} } = {}) {
  const logs = [];
  const file = path.join(TMP, `s-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(Object.assign({ enabled: true, brain: 'local', local: { endpoint: llm ? llm.base : 'http://127.0.0.1:9/v1', model: 'qwen2.5:7b' } }, settings)));
  const a = createAlfred({ settingsFile: file, ctx, noTimers: true, log: (k, d) => logs.push({ k, d }), emit: () => {} });
  return { a, logs };
}

async function partA() {
  console.log('\n== A1. the typed-request intent ==');
  {
    const i = askAiIntent(REQUEST);
    assert(i && i.site === 'chatgpt' && i.message === 'Please write a prompt for a dragon picture.' && i.change === 'make it more dramatic', `"${REQUEST}" → ChatGPT, "${i && i.message}", change "${i && i.change}"`);
    const yes = [['ask Claude to write a poem about the sea', 'claude', 'Please write a poem about the sea.'], ['have Gemini write a story about a fox', 'gemini', 'Please write a story about a fox.'], ['ask chatgpt for a prompt for a sunset photo', 'chatgpt', 'Please give me a prompt for a sunset photo.'], ['Get me a dragon prompt from ChatGPT and rewrite it to be scarier.', 'chatgpt', 'Please write a dragon prompt.']];
    for (const [t, site, msg] of yes) { const x = askAiIntent(t); assert(x && x.site === site && x.message === msg, `"${t}" → ${site}: "${x && x.message}"`); }
    for (const t of ['is ChatGPT working?', 'what did Claude say?', 'how do I ask Claude something?', 'hello Alfred', 'send hi to all three AIs', 'ask ChatGPT to make a picture of a cat']) assert(!askAiIntent(t), `"${t}" is not an ask-and-wait request`);
    const tool = registry.get('ask_ai');
    assert(tool && tool.changes === true && tool.group === 'ais' && tool.allowAlways === true && tool.timeoutMs > 180000, 'ask_ai: group ais, asks first (an "I will" card), may be "always allowed", waits longer than its 3 minutes');
  }

  // a model that never calls a tool, but rewrites text when asked (no tools offered then)
  const words = await fakeLlm((body) => (isRewrite(body) ? { content: 'A colossal crimson dragon roars from a storm-torn cliff, lightning splitting a blood-red sky.' } : { content: 'What a lovely idea! Dragons are wonderful.' }));

  console.log('\n== A2. words-only model: retry → 💬 Ask ChatGPT now → ✔ → the answer → rewritten ==');
  {
    const asked = [];
    const { a, logs } = make({ llm: words, ctx: { askAi: async (site, text, o) => { asked.push({ site, text, o }); return { ok: true, text: CHATGPT_ANSWER }; } } });
    const n0 = words.requests.length;
    const r = await a.ask(REQUEST);
    assert(words.requests.length === n0 + 2, `his AI was asked twice (once more with a plain note) (${words.requests.length - n0})`);
    const second = words.requests[words.requests.length - 1].body.messages;
    assert(/Call the ask_ai tool NOW with to = "chatgpt"/.test(second[second.length - 1].content) && !a._history().some((m) => /A note from the app/.test(m.content || '')), 'the retry named ask_ai and ChatGPT (for that call only)');
    assert(r.type === 'confirm' && r.card.doLabel === '💬 Ask ChatGPT now' && r.card.steps[0].tool === 'ask_ai' && /Ask ChatGPT “Please write a prompt for a dragon picture\.”/.test(r.card.steps[0].text) && /make it more dramatic/.test(r.card.intro), `a one-click ask_ai card built from the request ("${r.card && r.card.steps[0].text}" / "${r.card && r.card.intro}")`);
    assert(!asked.length, 'nothing is sent before ✔');
    const d = await a.confirm(r.card.id);
    assert(asked.length === 1 && asked[0].site === 'chatgpt' && asked[0].text === 'Please write a prompt for a dragon picture.' && asked[0].o.timeoutMs === 180000 && asked[0].o.signal && typeof asked[0].o.signal.aborted === 'boolean', '✔ → ask_ai: ChatGPT, the message, a 3-minute wait, and the request\'s Stop signal');
    assert(d.type === 'reply' && /changed as you asked \(make it more dramatic\)/.test(d.text) && /colossal crimson dragon/.test(d.text) && !/lovely idea/.test(d.text), `Alfred's AI rewrote ChatGPT's answer and he shows it ("${d.text.slice(0, 120)}")`);
    const rw = words.requests[words.requests.length - 1].body;
    assert(isRewrite(rw) && JSON.stringify(rw.messages).includes(CHATGPT_ANSWER) && !(rw.tools && rw.tools.length), 'the rewrite call carried ChatGPT\'s answer and offered no tools');
    const rep = ofKind(logs, 'alfred-reply');
    assert(rep.length === 2 && rep[0].outcome === 'fallback-card' && rep[0].retried === true && rep[1].outcome === 'done' && rep[1].rewrite === 'done' && rep[1].tools_called.join() === 'ask_ai', `logged: fallback-card, then done (rewrite done) (${JSON.stringify(rep[1])})`);
    assert(ofKind(logs, 'alfred-retry')[0].intent === 'ask-ai' && ofKind(logs, 'alfred-no-action')[0].quick === 'free:ask-ai', 'logged: alfred-retry (ask-ai), alfred-no-action (free:ask-ai)');
    assert(!/dragon|Dragon/.test(JSON.stringify(logs)), 'text-free: no request, answer or rewrite in the log');
    assert(a._history().some((m) => m.role === 'assistant' && /colossal crimson dragon/.test(m.content)), 'the rewritten text is in the conversation (so "send it to Claude" can follow)');
  }

  console.log('\n== A3. the rewrite fails (his AI errors) → ChatGPT\'s answer, and a plain "I couldn\'t change it" ==');
  {
    const flaky = await fakeLlm((body) => (isRewrite(body) ? { status: 500, body: { error: 'boom' } } : { content: 'Sure!' }));
    const { a, logs } = make({ llm: flaky, ctx: { askAi: async () => ({ ok: true, text: CHATGPT_ANSWER }) } });
    const r = await a.ask(REQUEST);
    const d = await a.confirm(r.card.id);
    assert(d.type === 'reply' && d.text.includes(CHATGPT_ANSWER) && /I couldn't make it more dramatic myself/.test(d.text) && /HTTP 500/.test(d.text), `the fetched text is shown; he says plainly he couldn't change it ("${d.text.replace(/\n/g, ' | ').slice(0, 220)}")`);
    assert(ofKind(logs, 'alfred-reply').pop().rewrite === 'failed', 'alfred-reply: rewrite failed');
    await flaky.close();
  }

  console.log('\n== A4. his AI down altogether → the ask card at once; the answer shown, "couldn\'t change it" ==');
  {
    const { a } = make({ ctx: { askAi: async () => ({ ok: true, text: CHATGPT_ANSWER }) } }); // nothing answers at the AI address
    const r = await a.ask(REQUEST);
    assert(r.type === 'confirm' && r.card.steps[0].tool === 'ask_ai' && /^My AI didn't answer/.test(r.card.intro), `the ask card even with his AI down ("${r.card && r.card.intro.slice(0, 100)}")`);
    const d = await a.confirm(r.card.id);
    assert(d.text.includes(CHATGPT_ANSWER) && /I couldn't make it more dramatic myself: I can't reach my AI/.test(d.text), `answer shown + why it wasn't changed ("${d.text.replace(/\n/g, ' | ').slice(0, 200)}")`);
  }

  console.log('\n== A5. ask_ai timeout / Akọwe using the AI / not sent → plain messages ==');
  {
    const tool = registry.get('ask_ai');
    let out = await tool.run({ to: 'chatgpt', message: 'hi' }, { askAi: async () => ({ ok: false, error: 'TIMEOUT', typed: true }) });
    assert(!out.ok && out.error === 'TIMEOUT' && /ChatGPT didn't answer within 3 minutes/.test(out.message) && /read ChatGPT's latest reply/.test(out.message), `timeout: "${out.message}"`);
    out = await tool.run({ to: 'claude', message: 'hi' }, { askAi: async () => ({ ok: false, error: 'AKOWE_USING' }) });
    assert(!out.ok && /Akọwe is using Claude right now/.test(out.message) && /didn't type anything/.test(out.message), `Akọwe owns the pane: "${out.message}"`);
    out = await tool.run({ to: 'gemini', message: 'hi' }, { askAi: async () => ({ ok: false, error: 'TURNED_OFF' }) });
    assert(!out.ok && /Gemini is turned off/.test(out.message), `turned off: "${out.message}"`);
    out = await tool.run({ to: 'gemini', message: 'hi' }, {});
    assert(!out.ok && out.error === 'NO_ASK' && /not available in this build/.test(out.message), 'an older main without askAi: said plainly');
    // through Alfred: the timeout reaches the user in words (the quick path says it, no AI needed)
    const { a, logs } = make({ llm: words, ctx: { askAi: async () => ({ ok: false, error: 'TIMEOUT', typed: true }) } });
    const r = await a.ask(REQUEST);
    const d = await a.confirm(r.card.id);
    assert(d.type === 'reply' && /Ask an AI and wait for its answer didn't work: ChatGPT didn't answer within 3 minutes/.test(d.text) && ofKind(logs, 'alfred-reply').pop().outcome === 'error', `the timeout is said plainly ("${d.text.slice(0, 140)}")`);
    const { a: a2 } = make({ llm: words, ctx: { askAi: async () => ({ ok: false, error: 'AKOWE_USING' }) } });
    const r2 = await a2.ask('ask Claude to write a poem about the sea');
    const d2 = await a2.confirm(r2.card.id);
    assert(/Akọwe is using Claude right now/.test(d2.text), `Akọwe owns Claude: refused plainly ("${d2.text.slice(0, 120)}")`);
  }

  console.log('\n== A6. ■ Stop while ask_ai waits ==');
  {
    let seen = null;
    const { a } = make({ llm: words, ctx: { askAi: (site, text, o) => new Promise((res) => { seen = o.signal; o.signal.addEventListener('abort', () => res({ ok: false, error: 'CANCELLED', typed: true })); }) } });
    const r = await a.ask('ask Claude to write a poem about the sea');
    const p = a.confirm(r.card.id);
    await until(() => seen);
    a.cancel();
    const d = await p;
    assert(seen && seen.aborted && /Stopped/.test(d.text) && !a.status().busy, `■ Stop reaches the waiting ask ("${d.text.slice(0, 80)}")`);
  }

  console.log('\n== A7. an empty model reply → a visible plain message + outcome "empty" ==');
  {
    const empty = await fakeLlm(() => ({ content: '' }));
    const { a, logs } = make({ llm: empty });
    const r = await a.ask('hello there, how are you today?');
    assert(r.type === 'reply' && /^I couldn't do that, because my AI \(qwen2\.5:7b\) sent back an empty answer/.test(r.text) && /stronger AI/.test(r.text), `a plain message, never nothing ("${r.text}")`);
    assert(a.status().chat.some((m) => m.role === 'alfred' && m.text === r.text), 'it is in his chat (the panel shows it)');
    const rp = ofKind(logs, 'alfred-reply').pop();
    assert(rp.outcome === 'empty' && rp.severity === 'warn' && rp.chars === r.text.length && ofKind(logs, 'alfred-empty').length === 1, `alfred-reply outcome "empty" (${JSON.stringify(rp)})`);
    await empty.close();
    // only punctuation = unusable, too
    const junk = await fakeLlm(() => ({ content: ' … !! ' }));
    const { a: a2, logs: l2 } = make({ llm: junk });
    const r2 = await a2.ask('what can you see?');
    assert(/^I couldn't do that/.test(r2.text) && ofKind(l2, 'alfred-reply').pop().outcome === 'empty', `punctuation only: also a plain message ("${r2.text.slice(0, 60)}")`);
    await junk.close();
    // the model called ask_ai (its own card) and then said nothing: the answer it fetched is shown
    const q = [toolCall('ask_ai', { to: 'claude', message: 'Three titles please' })];
    const quiet = await fakeLlm((body) => (lastMsg(body).role === 'tool' ? { content: '' } : q.shift() || { content: '' }));
    const { a: a3, logs: l3 } = make({ llm: quiet, ctx: { askAi: async () => ({ ok: true, text: 'Salt and Lamp; The Long Watch; Keeper' }) } });
    const r3 = await a3.ask('get three titles from Claude');
    const d3 = await a3.confirm(r3.card.id);
    assert(/\*\*Claude answered:\*\*/.test(d3.text) && /The Long Watch/.test(d3.text) && ofKind(l3, 'alfred-reply').pop().outcome === 'empty', `his AI went quiet after ask_ai: Claude's answer is shown anyway ("${d3.text.replace(/\n/g, ' | ').slice(0, 120)}")`);
    await quiet.close();
  }

  console.log('\n== A8. only refused tool calls → plain words (no silent loop to the step limit) ==');
  {
    const bad = await fakeLlm(() => toolCall('make_magic', { x: 1 }));
    const { a, logs } = make({ llm: bad });
    const r = await a.ask('tidy up my desktop');
    assert(r.type === 'reply' && /kept asking for things I can't do \(a tool that does not exist\)/.test(r.text) && bad.requests.length === 2, `after two refused rounds: "${r.text.slice(0, 120)}" (${bad.requests.length} AI calls)`);
    assert(ofKind(logs, 'alfred-reply').pop().outcome === 'empty' && ofKind(logs, 'alfred-refused').length === 2, 'outcome "empty", each refusal logged');
    // the same with a clear "ask ChatGPT" request → the ask card instead
    const { a: a2 } = make({ llm: bad, ctx: { askAi: async () => ({ ok: true, text: 'ok' }) } });
    const r2 = await a2.ask('ask ChatGPT to write a haiku about rain');
    assert(r2.type === 'confirm' && r2.card.steps[0].tool === 'ask_ai' && /couldn't pick the right tool/.test(r2.card.intro), 'refused twice on a clear "ask ChatGPT …": the ask card');
    a2.reject(r2.card.id);
    await bad.close();
  }

  console.log('\n== A9. the "stronger brain" tip: two struggles in a row with a local model, never changed by itself ==');
  {
    const { a } = make({ llm: words, ctx: { askAi: async () => ({ ok: true, text: 'x' }) } });
    await a.ask('what is the weather like?');
    assert(!a.status().tip, 'one words-only answer: no tip yet');
    await a.ask('and tomorrow?');
    const tip = a.status().tip;
    assert(tip && tip.count === 2 && /qwen2\.5:7b/.test(tip.text) && tip.actions.map((x) => x.id).join() === 'use-pane,bigger' && tip.actions[0].label === "Use Claude (web pane) as Alfred's brain" && tip.actions[1].label === 'Use a bigger model' && JSON.stringify(tip.actions[0].settings) === '{"brain":"pane","pane":{"site":"claude"}}', `two in a row: the tip with both choices (${tip && tip.text})`);
    assert(a.getSettings().brain === 'local', 'nothing was changed by itself');
    a.setSettings({ brain: 'pane', pane: { site: 'claude' } });
    assert(!a.status().tip, 'choosing another brain clears it');
    const good = await fakeLlm((body) => (lastMsg(body).role === 'tool' ? { content: 'Two AIs are working.' } : toolCall('ai_health', {})));
    const { a: b } = make({ llm: good, ctx: { aiHealth: () => ({}) } });
    await b.ask('x?'); await b.ask('y?');
    assert(!b.status().tip, 'a model that uses its tools: no tip');
    const { a: c } = make({ llm: words, settings: { brain: 'api' } });
    assert(!c.status().tip, 'a connected (API) brain never shows the local-model tip');
    await good.close();
  }
  await words.close();
}

// ------------------------------------------------------------------------------------------------ B. the real app
function request(method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const req = http.request({ host: '127.0.0.1', port: Number(process.env.AUTOINJECTOR_AKOWE_PORT), method, path: urlPath, headers }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(t); } catch (_) {} resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
async function partB() {
  console.log('\n== B. the real app: typed request → card → ✔ → ChatGPT pane answers → Alfred gets it ==');
  const mockPath = path.join(__dirname, 'mock-electron.js');
  const origLoad = Module._load;
  Module._load = function (r) { if (r === 'electron') return require(mockPath); return origLoad.apply(this, arguments); };
  const mock = require(mockPath);
  mock.shell = { openPath: async () => '', openExternal: async () => {}, showItemInFolder: () => {} };
  require('../main.js');
  await sleep(300);
  const call = (ch, p) => mock.__ipcHandlers[ch]({}, p);
  const wc = (s) => mock.__registry[s].webContents;
  const debugLog = () => { try { return fs.readFileSync(path.join(mock.__userDataDir, 'autoinjector-debug.log'), 'utf8'); } catch (_) { return ''; } };
  let rewriteFail = false;
  const llm = await fakeLlm((body) => (isRewrite(body) ? (rewriteFail ? { status: 503, body: {} } : { content: 'A colossal crimson dragon roars from a storm-torn cliff.' }) : { content: 'Dragons are lovely!' }));
  await call('alfred:set-enabled', { on: true });
  await call('alfred:settings', { brain: 'local', local: { endpoint: llm.base, model: 'qwen2.5:7b' }, notices: false });
  await call('routing:set', { source: 'chatgpt', target: 'gemini', enabled: true }); // Auto on: Alfred's answer must still not be relayed
  wc('gemini').sentLog = [];
  {
    const n0 = wc('chatgpt').sentLog.length;
    const r = await call('alfred:ask', { text: REQUEST });
    assert(r && r.type === 'confirm' && r.card.steps[0].tool === 'ask_ai' && r.card.doLabel === '💬 Ask ChatGPT now', `the real app: the "💬 Ask ChatGPT now" card (${r && r.card && r.card.steps[0].text})`);
    assert(wc('chatgpt').sentLog.length === n0, 'nothing typed into ChatGPT before ✔');
    const pend = call('alfred:confirm', { id: r.card.id });
    const sent = await until(() => wc('chatgpt').sentLog.slice(n0).find((x) => /dragon picture/.test(String(x.text || ''))));
    assert(sent && /^\[MSG #\d{4}\]\n/.test(sent.text) && /\[FROM: CHATGPT\]/.test(sent.text), 'typed into the ChatGPT pane with its [MSG #] and the reply envelope (the proven send path)');
    await sleep(150);
    wc('chatgpt').currentText = CHATGPT_ANSWER; // no [FROM:] tag: taken as finished while Alfred waits (no reminder)
    const d = await pend;
    assert(d && d.type === 'reply' && /colossal crimson dragon/.test(d.text) && /changed as you asked/.test(d.text), `Alfred received ChatGPT's answer and his AI rewrote it ("${d && d.text.slice(0, 120)}")`);
    const rw = llm.requests[llm.requests.length - 1].body;
    assert(isRewrite(rw) && JSON.stringify(rw.messages).includes(CHATGPT_ANSWER), 'the rewrite got exactly ChatGPT\'s answer');
    const st = await call('state:get');
    assert(st.transcript.some((t) => t.site === 'chatgpt' && t.text === CHATGPT_ANSWER), 'ChatGPT\'s answer is shown in the conversation');
    await sleep(300);
    assert(wc('gemini').sentLog.length === 0, 'it was NOT relayed to Gemini (it answers Alfred)');
    assert(!wc('chatgpt').sentLog.slice(n0).some((x) => /FROM:/.test(String(x.text || '')) && x !== sent), 'no missing-tag reminder was typed into ChatGPT');
    const as = await call('alfred:status');
    assert(as.chat.some((m) => m.role === 'alfred' && /colossal crimson dragon/.test(m.text)) && !as.busy && !as.card, 'his panel shows the answer; he is free again');
    await until(() => /alfred-ask-ai/.test(debugLog()), 2000);
    const lg = debugLog();
    assert(/alfred-ask-ai/.test(lg) && /"outcome":"answered"/.test(lg) && !/red dragon resting/.test(lg) && !/dragon picture/.test(lg), 'activity log: alfred-ask-ai sent / answered — no prompt or answer text');
  }
  {
    // the rewrite fails in the real app too → the fetched text and a plain sentence
    rewriteFail = true;
    const n0 = wc('chatgpt').sentLog.length;
    const r = await call('alfred:ask', { text: REQUEST });
    const pend = call('alfred:confirm', { id: r.card.id });
    await until(() => wc('chatgpt').sentLog.length > n0);
    await sleep(150);
    wc('chatgpt').currentText = 'A second dragon prompt. [FROM: CHATGPT]';
    const d = await pend;
    assert(/A second dragon prompt\./.test(d.text) && /I couldn't make it more dramatic myself/.test(d.text), `his AI failing: the answer + "I couldn't …" ("${d.text.replace(/\n/g, ' | ').slice(0, 160)}")`);
    rewriteFail = false;
  }
  {
    // the wait times out → a plain message (a short wait for the test)
    process.env.AUTOINJECTOR_ALFRED_ASK_MAX_MS = '1200';
    const r = await call('alfred:ask', { text: 'ask Gemini to write a limerick about lamps' });
    const d = await call('alfred:confirm', { id: r.card.id });
    assert(d && d.type === 'reply' && /Gemini didn't answer within 3 minutes/.test(d.text) && /latest reply/.test(d.text), `no answer → a plain timeout message ("${d && d.text.slice(0, 160)}")`);
    delete process.env.AUTOINJECTOR_ALFRED_ASK_MAX_MS;
  }
  {
    // an Akọwe request waits on Claude: Alfred refuses plainly, nothing is typed into Claude
    let st = await call('akowe:set-enabled', { enabled: true });
    const token = (await call('akowe:reveal-token')).token;
    assert(st.enabled && token, 'the Akọwe bridge is on');
    wc('claude').sentLog = [];
    const p = request('POST', '/v1/complete', token, { site: 'claude', prompt: 'Write the outline.', request_id: 'ak-1', timeout_ms: 30000 });
    await until(() => wc('claude').sentLog[0]);
    const r = await call('alfred:ask', { text: 'ask Claude to write a poem about the sea' });
    const d = await call('alfred:confirm', { id: r.card.id });
    assert(d && /Akọwe is using Claude right now/.test(d.text) && wc('claude').sentLog.length === 1, `Akọwe owns Claude: refused plainly, nothing typed (${wc('claude').sentLog.length} send) ("${d && d.text.slice(0, 120)}")`);
    wc('claude').currentText = 'Here is the outline. [FROM: CLAUDE]';
    const ak = await p;
    assert(ak.status === 200 && ak.json.text === 'Here is the outline.', 'Akọwe still gets its own answer');
    st = await call('akowe:set-enabled', { enabled: false });
  }
  await call('routing:set', { source: 'chatgpt', target: 'gemini', enabled: false });
  await llm.close();
}

async function partC() {
  console.log('\n== C. the side panel: the tip and its buttons ==');
  const html = fs.readFileSync(path.join(__dirname, '..', 'controls.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const calls = []; let onAlfred = null;
  const base = { ok: true, enabled: true, settings: { brain: 'local', local: { endpoint: '', model: 'qwen2.5:7b' }, pane: { site: 'chatgpt' }, maxSteps: 8, notices: true, interpreter: false, alwaysAllow: {}, personality: { name: 'Alfred' }, panel: { open: true }, profiles: [] }, chat: [], activity: [], card: null, busy: false, ai: {}, connected: {} };
  const tip = { count: 2, model: 'qwen2.5:7b', text: 'My local model (qwen2.5:7b) has had trouble with your last 2 requests. A stronger AI does much better with the tools:', actions: [{ id: 'use-pane', label: "Use Claude (web pane) as Alfred's brain", settings: { brain: 'pane', pane: { site: 'claude' } } }, { id: 'bigger', label: 'Use a bigger model' }] };
  let cur = Object.assign({}, base);
  dom.window.api = { alfredStatus: async () => cur, alfredSetEnabled: async () => cur, onAlfred: (cb) => { onAlfred = cb; }, alfredSettings: async (p) => { calls.push(p); return cur.settings; }, alfredAsk: async () => ({ ok: true }) };
  dom.window.eval(fs.readFileSync(path.join(__dirname, '..', 'alfred-panel.js'), 'utf8'));
  await sleep(30);
  const d = dom.window.document;
  assert(d.getElementById('alfred-tip') && d.getElementById('alfred-tip').hidden, 'no tip while he does fine');
  cur = Object.assign({}, base, { tip }); onAlfred({ type: 'state', state: cur }); await sleep(10);
  const box = d.getElementById('alfred-tip');
  assert(!box.hidden && /trouble with your last 2 requests/.test(box.textContent) && d.getElementById('alfred-tip-use-pane').textContent === "Use Claude (web pane) as Alfred's brain" && d.getElementById('alfred-tip-bigger').textContent === 'Use a bigger model', 'two struggles: the one-line tip with both buttons');
  assert(!calls.length, 'showing the tip changes nothing');
  d.getElementById('alfred-tip-bigger').click(); await sleep(10);
  assert(!calls.length, '"Use a bigger model" opens the set-up (🎩 Butler section) — no setting changed');
  d.getElementById('alfred-tip-use-pane').click(); await sleep(20);
  assert(calls.length === 1 && calls[0].brain === 'pane' && calls[0].pane.site === 'claude' && /Claude in its pane/.test(d.getElementById('alfred-quick-msg').textContent), 'the click (only the click) makes Claude\'s web pane his brain, and says so');
  cur = Object.assign({}, base, { tip: Object.assign({}, tip, { count: 3 }) }); onAlfred({ type: 'state', state: cur }); await sleep(10);
  d.getElementById('alfred-tip-close').click(); await sleep(5);
  assert(box.hidden, '✕ hides it');
  onAlfred({ type: 'state', state: cur }); await sleep(10);
  assert(box.hidden, '… and it stays hidden until he struggles again');
  cur = Object.assign({}, base, { tip: Object.assign({}, tip, { count: 4 }) }); onAlfred({ type: 'state', state: cur }); await sleep(10);
  assert(!box.hidden, 'another struggle: it comes back');
}

(async () => {
  await partA();
  await partC();
  await partB();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
