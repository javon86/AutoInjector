// test/alfred.test.js — 🎩 Alfred: the tool registry and its schemas, read-only vs "I will" confirm
// flow, refusal of unknown tools, max steps, cancel, switch OFF = no calls and no UI, the "AI
// unreachable" notice, the Akọwe tools against a fake Akọwe API, logging without secrets, Open
// Interpreter off by default and confirm-first, always-allow, the watcher, the text protocol and the
// web-pane brain. A fake OpenAI-compatible (Ollama /v1) server returns scripted tool calls.
// Run: node test/alfred.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');
const registry = require('../alfred-tools');
const { createAlfred } = require('../alfred');
const brain = require('../alfred-ai');
const { nodeHttp } = require('../akowe-link-test');
const { fakeLlm, fakeAkowe, toolCall, lastMsg, lastUser } = require('./alfred-fakes');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-test-'));
const AKOWE_TOKEN = 'akowe-secret-token-XYZ';

/** A ready Alfred wired to fakes. ctx overrides replace tool functions. */
function make({ llm, akowe, ctx = {}, settings = {}, deps = {} } = {}) {
  const logs = [];
  const events = [];
  const calls = { generateImage: [], interpreterRun: [], journal: [], sendToAi: [], openAkowePage: [] };
  const file = path.join(TMP, `s-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(Object.assign({ enabled: true, brain: 'local', local: { endpoint: llm ? llm.base : 'http://127.0.0.1:9/v1', model: 'fake-model' } }, settings)));
  const fullCtx = Object.assign({
    akowe: (method, p, body) => akowe ? nodeHttp({ method, url: akowe.base + p, headers: { Authorization: `Bearer ${AKOWE_TOKEN}`, Accept: 'application/json' }, body, timeoutMs: 5000 }).catch(() => ({ status: 0, json: null, error: 'ERR' })) : Promise.resolve({ status: 0, json: null, error: 'NOT_READY' }),
    openAkowePage: async (hash) => { calls.openAkowePage.push(hash); return { ok: true }; },
    generateImage: async (o) => { calls.generateImage.push(o); return { ok: true, path: '/out/images/img-1.png', paths: ['/out/images/img-1.png'], count: 1 }; },
    listOutputs: async () => [{ name: 'img-1.png', path: '/out/images/img-1.png' }],
    videoStatus: () => ({ enabled: false, configured: false }),
    generateVideo: async () => ({ ok: false, error: 'X' }),
    sendToAi: async (sites, text) => { calls.sendToAi.push({ sites, text }); return Object.fromEntries(sites.map((s) => [s, { ok: true }])); },
    latestReply: () => ({ text: 'Hello from Claude', ts: 1 }),
    aiHealth: () => ({ chatgpt: { state: 'ok' } }),
    runCheckin: () => ({ started: ['chatgpt'] }),
    openOutput: async () => ({ ok: true }),
    exportLogs: async () => ({ ok: true, file: '/out/logs/x.txt' }),
    interpreterRun: async (task) => { calls.interpreterRun.push(task); return { ok: true, message: 'ran', events: [{ type: 'output', content: '4' }] }; },
  }, ctx);
  const a = createAlfred(Object.assign({
    settingsFile: file, ctx: fullCtx, noTimers: true,
    log: (k, d) => logs.push({ k, d }), emit: (p) => events.push(p),
    journal: async (pid, code, title) => { calls.journal.push({ pid, code, title }); },
    akoweReady: () => !!akowe,
  }, deps));
  return { a, logs, events, calls, file };
}
/** A script: answer each user request by calling `name(args)` once, then reply with text. */
function oneTool(name, args, final) {
  return (body) => (lastMsg(body).role === 'tool' ? { content: final || `Done: ${lastMsg(body).content.slice(0, 80)}` } : toolCall(name, args));
}

async function main() {
  // ------------------------------------------------------------------------------------------
  console.log('\n== the fixed tool registry ==');
  const names = registry.TOOLS.map((t) => t.name);
  assert(new Set(names).size === names.length, `tool names are unique (${names.length} tools)`);
  assert(registry.TOOLS.every((t) => t.name && t.title && t.description && t.args && t.args.type === 'object' && typeof t.changes === 'boolean' && typeof t.run === 'function'), 'every tool has a name, title, plain description, JSON args schema, a "changes things?" flag and an implementation');
  assert(registry.TOOLS.filter((t) => t.changes).every((t) => typeof t.describe === 'function'), 'every tool that changes something says what it will do (the "I will" line)');
  for (const n of ['image_generator_status', 'start_image_generator', 'stop_image_generator', 'find_models', 'character_locks', 'book_status', 'start_book', 'pause_run', 'resume_run', 'cancel_run', 'edit_profile', 'edit_character', 'add_story_rule', 'add_world_detail', 'rewrite_chapter', 'open_akowe_page', 'make_book_report', 'save_book', 'generate_image', 'list_images', 'video_status', 'generate_video', 'send_to_ai', 'read_latest_reply', 'ai_health', 'run_checkin', 'list_outputs', 'open_output', 'export_logs', 'run_code']) assert(!!registry.get(n), `tool ${n} exists`);
  assert(['book_status', 'list_images', 'read_latest_reply', 'ai_health', 'list_outputs', 'open_akowe_page', 'video_status'].every((n) => !registry.get(n).changes), 'status / list / read tools are read-only');
  assert(['start_book', 'edit_profile', 'generate_image', 'send_to_ai', 'run_code', 'export_logs', 'rewrite_chapter'].every((n) => registry.get(n).changes), 'tools that change or create something are flagged');
  assert(registry.get('generate_image').allowAlways && !registry.get('start_book').allowAlways && !registry.get('run_code').allowAlways && !registry.get('send_to_ai').allowAlways, '"always allow" only for harmless ones (generate image yes; start a book, send to an AI, run code no)');
  assert(!registry.openAiTools().some((t) => t.function.name === 'run_code') && registry.openAiTools({ interpreter: true }).some((t) => t.function.name === 'run_code'), 'Open Interpreter is offered to the AI only when turned on');
  const gi = registry.get('generate_image');
  assert(registry.validate(gi, { prompt: 'a lighthouse' }).ok, 'valid arguments pass');
  assert(registry.validate(gi, '{"prompt":"a lighthouse","width":512}').ok, 'arguments as a JSON string pass');
  const oo = registry.get('open_output'); // generate_image's prompt is optional now (a reference view can come from a character alone) — open_output's path is required
  assert(!registry.validate(oo, {}).ok && /path is required/.test(registry.validate(oo, {}).error), 'a missing required argument is refused');
  assert(registry.get('generate_image').check({}).ok === false && registry.get('generate_image').check({ character: 'Odile', purpose: 'view', view: 'side' }).ok && !registry.get('generate_image').check({ character: 'Odile', purpose: 'view' }).ok, 'generate_image: something to draw (prompt, character or appearance) is still required; purpose "view" needs a view');
  assert(!registry.validate(gi, { prompt: 5 }).ok, 'a wrong type is refused');
  { const ex = registry.get('export_logs'); assert(registry.canAllowAlways(ex, { scope: 'book' }) && registry.canAllowAlways(ex, { scope: 'day' }) && !registry.canAllowAlways(ex, { scope: 'everything' }) && !registry.allowableKey('export_logs:everything') && registry.allowableKey('export_logs:book'), 'export_logs "everything" always asks (can never be always-allowed); book / day can'); }
  { const v = registry.validate(gi, { prompt: 'x y', evil: 1 }); assert(v.ok && !('evil' in v.args) && v.ignored.includes('evil'), 'an unknown argument is dropped (and reported), never passed on'); }
  { const v = registry.validate(gi, { args: { prompt: 'x y', width: '640' } }); assert(v.ok && v.args.prompt === 'x y' && v.args.width === 640, 'small-model slips are forgiven: arguments wrapped in "args", a number sent as text'); }
  assert(!registry.validate(oo, { args: { width: 640 } }).ok, 'a required argument is never invented');
  assert(!registry.validate(gi, { prompt: 'x y', width: 99999 }).ok, 'a number out of range is refused');
  assert(!registry.validate(registry.get('send_to_ai'), { to: 'bing', message: 'hi' }).ok, 'an enum outside its choices is refused');
  assert(!registry.validate(gi, 'not json').ok, 'arguments that are not JSON are refused');
  assert(registry.directToolFor('draw a picture of a cat') === 'generate_image' && registry.directToolFor('compute 2+2') === null, 'the "a direct tool exists" guard for Open Interpreter');

  // ------------------------------------------------------------------------------------------
  console.log('\n== master switch OFF: no calls, no notices, no UI beyond the switch ==');
  {
    const llm = await fakeLlm(() => ({ content: 'hi' }));
    const ak = await fakeAkowe(AKOWE_TOKEN);
    const { a, logs } = make({ llm, akowe: ak, settings: { enabled: false } });
    assert(a.status().enabled === false, 'a fresh Alfred with the switch off reports Off');
    const fresh = createAlfred({ settingsFile: path.join(TMP, 'never-written.json'), noTimers: true });
    assert(fresh.status().enabled === false, 'the default is Off');
    const r = await a.ask('what is the status of my book?');
    assert(r.ok === false && r.error === 'OFF', 'asking while Off answers OFF');
    assert((await a.confirm('card-x')).error === 'OFF' && (await a.testAi()).error === 'OFF', 'confirm / test are refused while Off');
    a.onAppEvent('self-repair', { site: 'claude', event: { kind: 'fixed' } });
    await a.pollBooks();
    assert(llm.requests.length === 0, 'no AI call was made');
    assert(ak.requests.length === 0, 'no Akọwe call was made (the watcher does not poll)');
    assert(a.status().chat.length === 0, 'no notice was shown');
    assert(!logs.some((l) => /alfred-(ask|tool|notice)/.test(l.k)), 'nothing of Alfred was logged');
    await llm.close(); await ak.close();
  }
  {
    // the panel in jsdom: Off -> only the switch; On -> the drawer
    const html = fs.readFileSync(path.join(__dirname, '..', 'controls.html'), 'utf8');
    const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
    let stateOn = false; const calls = [];
    const st = () => ({ ok: true, enabled: stateOn, settings: { brain: 'local', local: { endpoint: '', model: 'qwen2.5:7b' }, pane: { site: 'chatgpt' }, maxSteps: 8, notices: true, interpreter: false, alwaysAllow: {} }, chat: [], activity: [], card: null, busy: false, ai: {}, connected: {} });
    dom.window.api = {
      alfredStatus: async () => { calls.push('status'); return st(); },
      alfredSetEnabled: async (on) => { calls.push(`set:${on}`); stateOn = on; return st(); },
      onAlfred: () => {}, syncPanes: async () => ({ ok: true }),
    };
    dom.window.eval(fs.readFileSync(path.join(__dirname, '..', 'alfred-panel.js'), 'utf8'));
    await sleep(30);
    const d = dom.window.document;
    assert(d.getElementById('btn-alfred-switch').textContent === '🎩 Alfred: Off', 'the switch shows "🎩 Alfred: Off"');
    assert(!d.getElementById('alfred-drawer') && !d.getElementById('alfred-style') && !d.body.classList.contains('alfred-open'), 'Off: no drawer, no extra styles, the layout is untouched');
    assert(calls.join(',') === 'status', 'Off: the panel only asked for the status (no other calls)');
    d.getElementById('btn-alfred-switch').click();
    await sleep(30);
    assert(d.getElementById('btn-alfred-switch').textContent === '🎩 Alfred: On' && d.getElementById('btn-alfred-switch').getAttribute('aria-checked') === 'true', 'clicking turns him On');
    assert(!!d.getElementById('alfred-drawer') && !!d.getElementById('alfred-input') && d.body.classList.contains('alfred-open'), 'On: the drawer with the chat appears and the layout makes room for it');
    d.getElementById('btn-alfred-switch').click();
    await sleep(30);
    assert(!d.getElementById('alfred-drawer') && !d.body.classList.contains('alfred-open'), 'Off again: the drawer is gone');
  }

  // ------------------------------------------------------------------------------------------
  console.log('\n== read-only tools run directly ==');
  {
    const llm = await fakeLlm(oneTool('book_status', {}, 'Your book "The Lighthouse Keeper" is being written: chapter 2 is in progress.'));
    const ak = await fakeAkowe(AKOWE_TOKEN);
    const { a, logs } = make({ llm, akowe: ak });
    const r = await a.ask("what's the status of my book?");
    assert(r.ok && r.type === 'reply' && /Lighthouse Keeper/.test(r.text), 'a status question is answered from the tool result');
    assert(llm.requests.length === 2, 'two AI calls: the tool call, then the answer');
    const sent = llm.requests[0].body;
    assert(Array.isArray(sent.tools) && sent.tools.some((t) => t.function.name === 'book_status') && sent.model === 'fake-model', 'the tools and the model are sent (OpenAI-compatible, like Ollama /v1)');
    const toolMsg = llm.requests[1].body.messages.find((m) => m.role === 'tool');
    assert(toolMsg && /Lighthouse Keeper/.test(toolMsg.content) && /Write the chapters/.test(toolMsg.content), 'the tool result (books, run, checklist) goes back to the AI');
    assert(ak.requests.every((q) => q.auth === `Bearer ${AKOWE_TOKEN}`) && ak.requests.some((q) => q.path === '/api/autobook') && ak.requests.some((q) => q.path === '/api/slots/states'), 'Akọwe was asked with the token AutoInjector holds (books, run, AI health)');
    assert(!a.status().card && a.status().activity.length === 0, 'no card for a read-only tool, and it is not listed as a change');
    assert(logs.some((l) => l.k === 'alfred-tool' && l.d.tool === 'book_status' && l.d.ok), 'the tool run is in the activity log');
    await llm.close(); await ak.close();
  }

  // ------------------------------------------------------------------------------------------
  console.log('\n== changes wait for the "I will" card ==');
  {
    const llm = await fakeLlm(oneTool('generate_image', { prompt: 'a lighthouse at dusk' }, 'Here is your lighthouse.'));
    const { a, logs, calls, events } = make({ llm });
    const r = await a.ask('make an image of a lighthouse');
    assert(r.ok && r.type === 'confirm' && r.card && r.card.steps.length === 1, 'a change returns an "I will" card');
    assert(/Make an image of “a lighthouse at dusk”/.test(r.card.steps[0].text), `the card says exactly what will happen ("${r.card.steps[0].text}")`);
    assert(calls.generateImage.length === 0, 'nothing ran before ✔ Do it');
    assert(events.some((e) => e.type === 'card'), 'the panel is told about the card');
    const busy = await a.ask('and another thing');
    assert(busy.error === 'BUSY', 'a new request waits until the card is answered');
    const done = await a.confirm(r.card.id);
    assert(calls.generateImage.length === 1 && calls.generateImage[0].prompt === 'a lighthouse at dusk', '✔ Do it runs the tool through the image adapter');
    assert(done.ok && done.type === 'reply' && /lighthouse/.test(done.text), 'then Alfred answers');
    const act = a.status().activity;
    assert(act.length === 1 && act[0].tool === 'generate_image' && act[0].ok, '"what Alfred did" lists it');
    assert(a.status().chat.some((m) => m.role === 'notice' && /image is ready/.test(m.text)), 'a notice says the image finished');
    assert(!JSON.stringify(logs).includes('lighthouse'), 'the activity log never holds the prompt or the request text');
    assert(logs.some((l) => l.k === 'alfred-card') && logs.some((l) => l.k === 'alfred-confirm') && logs.some((l) => l.k === 'alfred-tool' && l.d.title === 'Generate an image'), 'card, confirm and the action (by its fixed title) are logged');
    // ✖ No
    const r2 = await a.ask('make another image');
    const no = a.reject(r2.card.id);
    assert(no.ok && /didn't do that/.test(no.text) && calls.generateImage.length === 1, '✖ No: nothing runs');
    assert(logs.some((l) => l.k === 'alfred-reject'), 'the refusal is logged');
    await llm.close();
  }

  // ------------------------------------------------------------------------------------------
  console.log('\n== always allow (harmless tools only) ==');
  {
    const llm = await fakeLlm(oneTool('generate_image', { prompt: 'a red boat' }, 'Done.'));
    const { a, calls } = make({ llm });
    const r = await a.ask('picture of a red boat');
    await a.confirm(r.card.id, { alwaysAllow: ['generate_image', 'start_book'] });
    assert(a.getSettings().alwaysAllow.generate_image === true && !a.getSettings().alwaysAllow.start_book, '"always allow" is kept for generate image, ignored for start a book');
    const r2 = await a.ask('picture of a blue boat');
    assert(r2.type === 'reply' && calls.generateImage.length === 2, 'next time it runs without a card');
    assert(a.status().activity.some((x) => x.auto), 'and is marked as always-allowed in what Alfred did');
    a.setSettings({ alwaysAllow: { generate_image: false } });
    assert(!a.getSettings().alwaysAllow.generate_image, '"Forget always allow" works');
    await llm.close();
  }

  // ------------------------------------------------------------------------------------------
  console.log('\n== unknown tools are refused ==');
  {
    const llm = await fakeLlm((body) => (lastMsg(body).role === 'tool' ? { content: 'I cannot do that.' } : toolCall('format_disk', { drive: 'C:' })));
    const { a, logs } = make({ llm });
    const r = await a.ask('wipe my disk');
    assert(r.ok && r.type === 'reply' && r.text === 'I cannot do that.', 'the AI is told the tool does not exist and answers');
    const toolMsg = llm.requests[1].body.messages.find((m) => m.role === 'tool');
    assert(toolMsg && /UNKNOWN_TOOL/.test(toolMsg.content), 'the refusal goes back to the AI');
    assert(logs.some((l) => l.k === 'alfred-refused' && l.d.reason === 'UNKNOWN_TOOL' && l.d.tool === 'format_disk'), 'the refusal is logged (name only)');
    const llm2 = await fakeLlm((body) => (lastMsg(body).role === 'tool' ? { content: 'ok' } : toolCall('generate_image', { prompt: 7 })));
    const m2 = make({ llm: llm2 });
    await m2.a.ask('image please');
    assert(m2.calls.generateImage.length === 0 && m2.logs.some((l) => l.k === 'alfred-refused' && l.d.reason === 'BAD_ARGS'), 'bad arguments are refused before anything runs');
    await llm.close(); await llm2.close();
  }

  // ------------------------------------------------------------------------------------------
  console.log('\n== bounded loops: max steps ==');
  {
    const llm = await fakeLlm(() => toolCall('list_books', {}));
    const ak = await fakeAkowe(AKOWE_TOKEN);
    const { a, logs } = make({ llm, akowe: ak, settings: { maxSteps: 3 } });
    const r = await a.ask('loop forever');
    assert(r.ok && r.limit && /stopped after 3 steps/.test(r.text), 'he stops after the step limit and says so');
    assert(llm.requests.length === 3, 'exactly maxSteps AI calls');
    assert(logs.some((l) => l.k === 'alfred-steps-limit'), 'the limit is logged');
    await llm.close(); await ak.close();
  }

  // ------------------------------------------------------------------------------------------
  console.log('\n== cancel ==');
  {
    const llm = await fakeLlm(() => ({ delayMs: 3000, message: { content: 'too late' } }));
    const { a } = make({ llm });
    const t0 = Date.now();
    const p = a.ask('slow question');
    await sleep(150);
    assert(a.status().busy, 'busy while the AI thinks');
    a.cancel();
    const r = await p;
    assert(r.cancelled && Date.now() - t0 < 2000, `■ Stop ends the request at once (${Date.now() - t0} ms)`);
    assert(!a.status().busy, 'and he is free again');
    // cancel while a card waits
    const llm2 = await fakeLlm(oneTool('save_book', {}, 'saved'));
    const m2 = make({ llm: llm2, akowe: null });
    const c = await m2.a.ask('save my book');
    assert(c.type === 'confirm', 'a card waits');
    m2.a.cancel();
    assert(!m2.a.status().card && !m2.a.status().busy, 'Stop also drops a waiting card (nothing runs)');
    await llm.close(); await llm2.close();
  }

  // ------------------------------------------------------------------------------------------
  console.log('\n== his AI unreachable: a plain notice, nothing else breaks ==');
  {
    const { a, logs } = make({ settings: { local: { endpoint: 'http://127.0.0.1:9/v1', model: 'qwen2.5:7b' } } });
    const r = await a.ask('hello?');
    assert(r.ok && r.notice && r.unreachable && /can't reach my AI/.test(r.text) && /Everything else in the app still works/.test(r.text) && /ollama pull qwen2\.5:7b/.test(r.text), 'a plain-English notice with the fix');
    assert(!a.status().busy && a.status().ai.ok === false, 'he is free again and the status line shows his AI is not reachable');
    assert(logs.some((l) => l.k === 'alfred-ai-error' && l.d.code === 'network'), 'logged as a code');
    const llm404 = await fakeLlm(() => ({ status: 404, body: { error: 'model "nope" not found' } }));
    const m2 = make({ llm: llm404 });
    const r2 = await m2.a.ask('hi');
    assert(/doesn't have the model/.test(r2.text), 'a missing model is explained (pull it or pick another)');
    const m3 = make({ settings: { brain: 'api' }, deps: { managerConfig: () => null } });
    const r3 = await m3.a.ask('hi');
    assert(r3.notice && /don't have an AI/.test(r3.text), '"connected AI" chosen but none is connected: a plain notice');
    // the user's real log: "Test my AI" said OK (Ollama answered) but the model wasn't installed, so every question got a 404
    const installed = ['qwen2.5:0.5b', 'llama3.1:latest'];
    const listModels = async () => ({ ok: true, models: installed });
    const m4 = make({ llm: llm404, settings: { local: { endpoint: llm404.base, model: 'qwen2.5:7b' } }, deps: { listModels } });
    const r4 = await m4.a.ask('hi');
    assert(/It has: qwen2\.5:0\.5b, llama3\.1:latest/.test(r4.text) && /ollama pull qwen2\.5:7b/.test(r4.text), 'a 404 names the models Ollama DOES have');
    const t4 = await m4.a.testAi();
    assert(!t4.ok && /isn't installed/.test(t4.message) && t4.installed.includes('qwen2.5:0.5b') && m4.logs.some((l) => l.k === 'alfred-ai-error' && l.d.code === 'MODEL_NOT_INSTALLED'), '"Test my AI" checks the model is installed, not only that Ollama answers (and offers the installed ones)');
    const m5 = make({ llm: llm404, settings: { local: { endpoint: llm404.base, model: 'qwen2.5:0.5b' } }, deps: { listModels } });
    const t5 = await m5.a.testAi();
    assert(t5.ok && t5.small && /very small model/.test(t5.message), 'an installed but tiny model passes, with a plain warning');
    const m6 = make({ llm: llm404, settings: { local: { endpoint: llm404.base, model: 'llama3.1' } }, deps: { listModels } });
    const t6 = await m6.a.testAi();
    assert(t6.ok && !t6.small, '"llama3.1" matches the installed "llama3.1:latest"');
    const m7 = make({ llm: llm404, settings: { local: { endpoint: llm404.base, model: 'qwen2.5:7b' } }, deps: { listModels: async () => ({ ok: true, models: [] }) } });
    assert(/has no models yet/.test((await m7.a.testAi()).message), 'Ollama with no models: says to pull one');
    await llm404.close();
  }

  // ------------------------------------------------------------------------------------------
  console.log('\n== logging without secrets (the connected AI with an API key) ==');
  {
    const KEY = 'sk-SECRET-KEY-123456';
    const llm = await fakeLlm(oneTool('list_books', {}, 'You have one book.'));
    const ak = await fakeAkowe(AKOWE_TOKEN);
    const { a, logs, events, file } = make({ llm, akowe: ak, settings: { brain: 'api' }, deps: { managerConfig: () => ({ endpoint: `${llm.base}/chat/completions`, apiKey: KEY, model: 'gpt-x' }) } });
    a.setSettings({ maxSteps: 7 }); // writes the settings file
    const r = await a.ask('list my books please, my password is hunter2');
    assert(r.ok && /one book/.test(r.text), 'the connected AI (API slot) works as his brain');
    assert(llm.requests[0].auth === `Bearer ${KEY}`, 'the key is sent to that AI only, as a header');
    const everything = JSON.stringify({ logs, events, status: a.status(), settings: a.getSettings(), file: fs.readFileSync(file, 'utf8') });
    assert(!everything.includes(KEY) && !everything.includes(AKOWE_TOKEN), 'no key or token in logs, events, status or the settings file');
    assert(!JSON.stringify(logs).includes('hunter2') && !JSON.stringify(logs).includes('One book'), 'no prompt or prose in the logs');
    // an error detail with the key in it is redacted
    const leak = await fakeLlm(() => ({ status: 500, body: { error: `bad key ${KEY}` } }));
    const red = await brain.chatWithTools({ endpoint: leak.base, apiKey: KEY, model: 'm', messages: [{ role: 'user', content: 'x' }] });
    assert(red.ok === false && !String(red.detail).includes(KEY) && /REDACTED/.test(red.detail), 'error details from the AI are redacted');
    await llm.close(); await ak.close(); await leak.close();
  }

  // ------------------------------------------------------------------------------------------
  console.log('\n== Akọwe tools against a fake Akọwe API ==');
  {
    const ak = await fakeAkowe(AKOWE_TOKEN);
    const queue = [];
    const llm = await fakeLlm((body) => (lastMsg(body).role === 'tool' ? { content: 'ok' } : queue.shift()));
    const { a, calls } = make({ llm, akowe: ak });
    const run = async (tool, args) => { queue.push(toolCall(tool, args)); const r = await a.ask(`do ${tool}`); return r.type === 'confirm' ? a.confirm(r.card.id).then((x) => ({ card: r.card, after: x })) : { reply: r }; };
    const req = (m, p) => ak.requests.filter((q) => q.method === m && q.path === p);

    let x = await run('start_book', { idea: 'A keeper finds a message in a bottle', genre: 'mystery', length: 'novella' });
    assert(/Your ✔ Do it is your consent for this one run/.test(x.card.steps[0].text), 'start a book: the card says Do it is the consent for this run');
    const sb = req('POST', '/api/autobook')[0];
    assert(sb && sb.body.author_confirms === true && sb.body.idea === 'A keeper finds a message in a bottle' && sb.body.length === 'novella', 'start a book: POST /api/autobook with the idea, consent only after ✔ Do it');

    x = await run('pause_run', {});
    assert(req('POST', '/api/autobook/run-abc/pause').length === 1, 'pause the run: the current run is paused');
    x = await run('resume_run', {});
    assert(req('POST', '/api/autobook/run-abc/resume').length === 1, 'resume it');

    x = await run('edit_profile', { title: 'The Last Keeper', tone: 'quiet', choices: { ending: 'bittersweet' } });
    const pf = req('PUT', '/api/projects/proj-1/profile')[0];
    assert(pf && pf.body.title === 'The Last Keeper' && pf.body.choices.ending === 'bittersweet' && !('idea' in pf.body), 'edit the profile & story choices: only the named fields are sent');

    x = await run('edit_character', { character: 'mara', sheet: { secret: 'she can not swim' }, voice: { rhythm: 'clipped' } });
    const ch = req('PUT', '/api/projects/proj-1/branches/main/review/characters/rec-mara')[0];
    assert(ch && ch.body.sheet.secret === 'she can not swim' && ch.body.sheet.wants === 'find her master' && ch.body.version === 2 && ch.body.voice.rhythm === 'clipped', 'edit a character sheet / voice card: found by name, other fields kept, version checked');

    x = await run('add_story_rule', { text: 'Ghosts cannot cross salt.', category: 'belief' });
    const rl = req('PUT', '/api/projects/proj-1/branches/main/review/world/rules')[0];
    assert(rl && rl.body.rules.length === 2 && rl.body.rules[1].text === 'Ghosts cannot cross salt.' && rl.body.version === 3, 'add a story rule: appended to the ledger with its version');

    x = await run('add_world_detail', { detail: 'Lamp oil costs a shilling a pint', kind: 'economy' });
    const tx = req('PUT', '/api/projects/proj-1/branches/main/review/world/texture')[0];
    assert(tx && tx.body.items.length === 2 && tx.body.items[1].kind === 'economy', 'add a world detail');

    x = await run('rewrite_chapter', { chapter: '2', note: 'More fog, less dialogue.' });
    const fx = req('POST', '/api/projects/proj-1/branches/main/review/fix')[0];
    assert(fx && fx.body.record_id === 'rec-c2' && fx.body.note === 'More fog, less dialogue.', 'ask for a chapter rewrite with a note (the draft of chapter 2)');
    x = await run('rewrite_chapter', { chapter: 'ch1', note: 'change it' });
    assert(/already approved/.test(JSON.stringify(llm.requests[llm.requests.length - 1].body.messages.slice(-1))), 'an approved chapter is not rewritten behind the author\'s back');

    x = await run('open_akowe_page', { page: 'grid' });
    assert(x.reply && calls.openAkowePage.includes('#/p/proj-1/main/grid'), 'open the scene grid page in the Akọwe tab (read-only, no card)');
    x = await run('make_book_report', {});
    assert(req('POST', '/api/projects/proj-1/branches/main/report').length === 1, 'make the book report');
    x = await run('save_book', {});
    assert(req('POST', '/api/projects/proj-1/branches/main/save').length === 1, 'save the book');
    const codes = calls.journal.map((j) => j.code);
    assert(['edit_profile', 'edit_character', 'add_story_rule', 'rewrite_chapter', 'save_book'].every((c) => codes.includes(c)) && calls.journal.every((j) => j.pid === 'proj-1' && j.title && !/fog|swim/.test(JSON.stringify(j))), 'book actions go to the Akọwe journal (codes and titles only)');
    assert(!ak.requests.some((q) => q.method === 'POST' && /approve|decide/.test(q.path)), 'Alfred never approves anything in Akọwe');
    // Akọwe not running: a plain message
    const offLlm = await fakeLlm(oneTool('book_status', {}, 'Akọwe is off.'));
    const off = make({ llm: offLlm, akowe: null });
    const ro = await off.a.ask('status?');
    const tm = offLlm.requests[1].body.messages.find((m) => m.role === 'tool');
    assert(ro.ok && tm && /AKOWE_NOT_READY/.test(tm.content) && /isn't running right now/.test(tm.content), 'Akọwe not running: the tool says so in plain words and he still answers');
    await offLlm.close();
    await llm.close(); await ak.close();
  }

  // ------------------------------------------------------------------------------------------
  console.log('\n== Open Interpreter: off by default, always asks, shows the exact code ==');
  {
    const code = 'print(sum(range(10)))';
    const llm = await fakeLlm((body) => (lastMsg(body).role === 'tool' ? { content: 'The answer is 45.' } : toolCall('run_code', { language: 'python', code, why: 'add up numbers' })));
    const off = make({ llm });
    assert(off.a.getSettings().interpreter === false, 'Open Interpreter is off by default');
    await off.a.ask('add the numbers 0..9 with python');
    assert(!llm.requests[0].body.tools.some((t) => t.function.name === 'run_code'), 'it is not even offered to his AI while off');
    assert(off.calls.interpreterRun.length === 0 && off.logs.some((l) => l.k === 'alfred-refused' && l.d.reason === 'INTERPRETER_OFF'), 'a call to it is refused');
    const on = make({ llm, settings: { interpreter: true, alwaysAllow: { run_code: true } } });
    assert(!on.a.getSettings().alwaysAllow.run_code, 'it can never be "always allowed"');
    const r = await on.a.ask('add the numbers 0..9 with python');
    assert(r.type === 'confirm' && r.card.steps[0].code && r.card.steps[0].code.code === code && r.card.steps[0].code.language === 'python', 'turned on: the card shows the exact code first');
    assert(on.calls.interpreterRun.length === 0, 'nothing ran before ✔ Do it');
    const d = await on.a.confirm(r.card.id);
    assert(on.calls.interpreterRun.length === 1 && on.calls.interpreterRun[0].includes(code) && /45/.test(d.text), '✔ Do it runs exactly that code');
    const llm2 = await fakeLlm((body) => (lastMsg(body).role === 'tool' ? { content: 'ok' } : toolCall('run_code', { language: 'python', code: 'make_image("cat")', why: 'draw a picture' })));
    const g = make({ llm: llm2, settings: { interpreter: true } });
    const r2 = await g.a.ask('draw');
    assert(r2.type === 'reply' && g.logs.some((l) => l.d.reason === 'DIRECT_TOOL_EXISTS'), 'never used when a direct tool exists (an image goes to generate_image)');
    await llm.close(); await llm2.close();
  }

  // ------------------------------------------------------------------------------------------
  console.log('\n== the watcher: rule-based notices, rate-limited ==');
  {
    const ak = await fakeAkowe(AKOWE_TOKEN);
    const llm = await fakeLlm(() => ({ content: 'x' }));
    const { a, logs } = make({ llm, akowe: ak });
    a.onAppEvent('self-repair', { site: 'claude', event: { kind: 'fixed' } });
    a.onAppEvent('self-repair', { site: 'claude', event: { kind: 'fixed' } });
    const notes = () => a.status().chat.filter((m) => m.role === 'notice');
    assert(notes().length === 1 && /Claude had a problem and AutoInjector fixed it/.test(notes()[0].text), 'an AI pane broke and was fixed -> one notice (the repeat is rate-limited)');
    await a.pollBooks();
    const n0 = notes().length;
    ak.state.run.status = 'paused'; ak.state.run.problem = { record_id: 'rec-c2', message: 'The reviewer still wants changes' };
    await a.pollBooks();
    assert(notes().length === n0 + 1 && /needs your decision/.test(notes()[notes().length - 1].text), 'a book run paused and needs approval -> notice');
    ak.state.run.status = 'done'; ak.state.run.problem = null;
    await a.pollBooks();
    assert(/finished/.test(notes()[notes().length - 1].text), 'a book run finished -> notice');
    a.onAppEvent('manager-log', { category: 'image', summary: 'Image rendered -> /out/images/img-9.png' });
    assert(/An image finished/.test(notes()[notes().length - 1].text), 'an image finished -> notice');
    for (let i = 0; i < 12; i++) a.onAppEvent('self-repair', { site: `s${i}`, event: { kind: 'broken' } });
    assert(notes().length <= 6 + 1, `at most 6 notices per 10 minutes (${notes().length})`);
    assert(llm.requests.length === 0, 'no AI call for any notice');
    assert(logs.filter((l) => l.k === 'alfred-notice').every((l) => Object.keys(l.d).join() === 'kind'), 'notices are logged by kind only');
    a.setSettings({ notices: false });
    const before = notes().length;
    a.onAppEvent('self-repair', { site: 'gemini', event: { kind: 'fixed' } });
    assert(notes().length === before, 'notices can be turned off');
    await llm.close(); await ak.close();
  }

  // ------------------------------------------------------------------------------------------
  console.log('\n== models without native tool calling, and a web pane as his brain ==');
  {
    const llm = await fakeLlm((body) => (lastMsg(body).role === 'user' && /^Result of/.test(lastMsg(body).content) ? { content: '{"reply": "You have one book."}' } : { content: 'Sure! {"tool": "list_books", "args": {}}' }));
    const ak = await fakeAkowe(AKOWE_TOKEN);
    const { a } = make({ llm, akowe: ak });
    const r = await a.ask('which books?');
    assert(r.ok && r.text === 'You have one book.', 'a tool call written as JSON text works too');
    const noTools = await fakeLlm((body) => (body.tools ? { status: 400, body: { error: 'model does not support tools' } } : { content: '{"reply":"hello"}' }));
    const m2 = make({ llm: noTools });
    const r2 = await m2.a.ask('hi');
    assert(r2.text === 'hello' && noTools.requests.length === 2 && !noTools.requests[1].body.tools, 'a server that refuses "tools" is asked again with the text protocol');
    const typed = [];
    const paneAsk = async (site, text) => { typed.push({ site, text }); return { ok: true, text: typed.length === 1 ? '{"tool":"ai_health","args":{}}' : '{"reply":"All three AIs work."}' }; };
    const m3 = make({ settings: { brain: 'pane', pane: { site: 'claude' } }, deps: { paneAsk } });
    const r3 = await m3.a.ask('are the AIs ok?');
    assert(r3.text === 'All three AIs work.' && typed[0].site === 'claude' && /"tool"/.test(typed[0].text) && /ai_health/.test(typed[0].text), 'a web AI pane can be his brain (JSON text protocol through the pane)');
    assert(/Result of ai_health/.test(typed[1].text), 'tool results are typed back into the pane');
    await llm.close(); await ak.close(); await noTools.close();
  }

  // ------------------------------------------------------------------------------------------
  console.log('\n== the switch itself ==');
  {
    const llm = await fakeLlm(() => ({ delayMs: 2000, message: { content: 'late' } }));
    const { a, logs, file } = make({ llm });
    const p = a.ask('slow');
    await sleep(100);
    a.setEnabled(false);
    const r = await p;
    assert(r.cancelled && !a.status().busy, 'turning him Off stops what he was doing');
    assert(JSON.parse(fs.readFileSync(file, 'utf8')).enabled === false, 'the switch is remembered');
    assert(logs.some((l) => l.k === 'alfred-off'), 'switching is logged');
    await llm.close();
  }
  {
    // auto: the local model when it answers, else the connected API
    const llm = await fakeLlm(() => ({ content: 'from api' }));
    const m = make({ settings: { brain: 'auto', local: { endpoint: 'http://127.0.0.1:9/v1', model: 'q' } }, deps: { managerConfig: () => ({ endpoint: `${llm.base}/chat/completions`, model: 'api-model' }) } });
    const r = await m.a.ask('hi');
    assert(r.text === 'from api', 'Automatic: no local model answering -> the connected AI is used');
    await llm.close();
  }

  // ------------------------------------------------------------------------------------------
  console.log('\n== images through the sd-api module (the 🎨 Images tab\'s API) + SD tools ==');
  {
    const { createImageAdapter } = require('../alfred-image');
    const seen = [];
    const fakeModule = {
      images: { generate: async (req) => { seen.push(req); return { ok: true, images: [{ path: '/out/images/sd-1.png', seed: 7 }], warnings: [] }; } },
      sd: { status: async () => ({ ok: true, image: { enabled: true, endpoint: 'http://127.0.0.1:7860', label: 'Forge', checkpoint: 'dreamshaper_8' }, managed: { phase: 'running' } }), start: async (t) => { seen.push({ start: t || null }); return { ok: true }; }, stop: async () => { seen.push({ stop: true }); return { ok: true }; } },
      library: { characterLock: async (n) => (/odile/i.test(n) ? { id: 'lock-1', character: 'Odile', loras: [{ name: 'odile_face', weight: 0.8 }], triggerWords: ['odile woman'], prompt: 'red hair' } : null), locks: async () => [{ id: 'lock-1', character: 'Odile', loras: [{ name: 'odile_face', weight: 0.8 }], triggerWords: ['odile woman'] }], find: async (q) => [{ id: 'lora:odile_face', name: 'odile_face', kind: 'lora', base: 'SD1.5', triggerWords: ['odile woman'], defaultWeight: 0.8 }].filter((x) => x.name.includes(q)) },
    };
    let providerCalled = false;
    const adapter = createImageAdapter({ sdApi: { get: () => fakeModule }, imageProvider: { generate: async () => { providerCalled = true; return { ok: false }; } }, outputManager: {}, dbService: {} });
    const r1 = await adapter.generate({ prompt: 'Odile at the harbor', character: 'Odile', style: 'ink wash', width: 768, height: 512 });
    assert(r1.ok && r1.path === '/out/images/sd-1.png' && !providerCalled, 'the adapter generates through sd-api images.generate (not the old provider)');
    assert(seen[0].characterLock === 'Odile' && /in the style of ink wash/.test(seen[0].prompt) && seen[0].width === 768 && seen[0].from === 'alfred', 'a saved character lock is used by name; style and size are passed');
    await adapter.generate({ prompt: 'a gull', character: 'Bob' });
    assert(!seen[1].characterLock && /featuring Bob/.test(seen[1].prompt), 'no lock for that name: the character is described in the prompt instead');
    const fallback = createImageAdapter({ sdApi: { get: () => null }, imageProvider: { getSettings: () => ({ width: 512, height: 512 }), setSettings: () => {}, generate: async () => ({ ok: false, error: 'NO_ENDPOINT' }), status: () => ({}) }, outputManager: {}, dbService: {} });
    const r3 = await fallback.generate({ prompt: 'x y' });
    assert(!r3.ok && /Images tab/.test(r3.message), 'without the module it falls back to image-provider, with a plain message');

    const llmQ = [];
    const llm = await fakeLlm((body) => (lastMsg(body).role === 'tool' ? { content: `ok ${lastMsg(body).content.slice(0, 200)}` } : llmQ.shift()));
    const { a } = make({ llm, ctx: {
      sdStatus: () => fakeModule.sd.status(), sdStart: (t) => fakeModule.sd.start(t), sdStop: () => fakeModule.sd.stop(),
      libraryFind: (q, f) => fakeModule.library.find(q, f), characterLock: (n) => fakeModule.library.characterLock(n), characterLocks: () => fakeModule.library.locks(),
    } });
    llmQ.push(toolCall('image_generator_status', {}));
    let r = await a.ask('is SD running?');
    assert(r.type === 'reply' && /Forge/.test(r.text) && /dreamshaper_8/.test(r.text), 'image generator status (read-only, no card)');
    llmQ.push(toolCall('find_models', { query: 'odile', kind: 'lora' }));
    r = await a.ask('find odile loras');
    assert(r.type === 'reply' && /odile_face/.test(r.text), 'library search (read-only)');
    llmQ.push(toolCall('character_locks', { name: 'odile' }));
    r = await a.ask('show odile lock');
    assert(r.type === 'reply' && /odile_face:0.8/.test(r.text), 'character lock lookup (read-only)');
    llmQ.push(toolCall('start_image_generator', {}));
    r = await a.ask('start SD');
    assert(r.type === 'confirm' && /Start Stable Diffusion/.test(r.card.steps[0].text) && !seen.some((x) => x.start !== undefined), 'starting SD waits for the card');
    await a.confirm(r.card.id);
    assert(seen.some((x) => x.start === null), '✔ Do it starts it through sd-api');
    llmQ.push(toolCall('stop_image_generator', {}));
    r = await a.ask('stop SD');
    await a.confirm(r.card.id);
    assert(seen.some((x) => x.stop), 'and stops it');
    assert(registry.validate(registry.get('generate_image'), { prompt: 'p q', loras: [{ name: 'odile_face', weight: 0.7 }] }).ok && !registry.validate(registry.get('generate_image'), { prompt: 'p q', loras: [{ weight: 1 }] }).ok, 'generate_image accepts LoRAs (name + weight), checked');
    await llm.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
