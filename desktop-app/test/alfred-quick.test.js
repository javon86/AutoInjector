// test/alfred-quick.test.js — PR #124: 🎩 Alfred's big buttons never depend on his AI choosing a tool.
// Log 2026-11-04 (build a0a220e): "🎨 Make a picture" → "Ask Alfred" → alfred-ask, then nothing: a small local model
// answered in words only, five times, and the log could not say what happened. Checked here:
//   - the quick-action plans (form fields → tool calls) for every big button;
//   - 🎨 / 🎬 / 🖼 / 🧑 / ✍ with a fake model that NEVER calls a tool: the "I will" card shows at once (no AI call),
//     ✔ Do it runs the tool, the result is said plainly; ✖ No, "always allow", an empty field;
//   - 📖 My book / ✍ Continue answered in words (or the AI down): the status read directly, a Resume card;
//   - free text "draw me a lighthouse" with a words-only model → one stricter retry → a "🎨 Make it now" card;
//     a model that calls the tool on the retry → the normal card; a plain question is not retried;
//   - alfred-reply / alfred-no-action / alfred-retry in the activity log, text-free; the Extract's book scope keeps them;
//   - the picture tool against a fake Forge WITHOUT ADetailer (the real sd-studio + sd-api + alfred-image path, the
//     same as the 🎨 Images tab's Generate since PR #120): the picture is made, the "left out" note reaches the user;
//     an image error reaches the user in plain words and alfred-tool carries the code;
//   - the side panel (jsdom): the picture form's size / engine, alfred:quick with the fields, the "Make it now" label.
// Run: node test/alfred-quick.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');
const { createAlfred, quickPlan, actionIntent } = require('../alfred');
const { nodeHttp } = require('../akowe-link-test');
const { fakeLlm, fakeAkowe, toolCall, lastMsg } = require('./alfred-fakes');
const { fakeA1111 } = require('./fixtures/fake-sd');
const logExtract = require('../log-extract');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-quick-'));
const TOKEN = 'akowe-secret-token-Q';

function make({ llm, akowe, ctx = {}, settings = {} } = {}) {
  const logs = []; const calls = { generateImage: [], videoInvoke: [] };
  const file = path.join(TMP, `s-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(Object.assign({ enabled: true, brain: 'local', local: { endpoint: llm ? llm.base : 'http://127.0.0.1:9/v1', model: 'qwen2.5:3b' } }, settings)));
  const fullCtx = Object.assign({
    akowe: (method, p, body) => (akowe ? nodeHttp({ method, url: akowe.base + p, headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' }, body, timeoutMs: 5000 }).catch(() => ({ status: 0, json: null })) : Promise.resolve({ status: 0, json: null, error: 'NOT_READY' })),
    generateImage: async (o) => { calls.generateImage.push(o); return { ok: true, path: '/out/images/img-1.png', paths: ['/out/images/img-1.png'], count: 1 }; },
    videoMethods: async () => [{ method: 'video.generate' }],
    videoInvoke: async (m, p) => { calls.videoInvoke.push({ m, p }); return { ok: true, path: '/out/videos/v.mp4', seconds: p.seconds || 4 }; },
    videoStatus: () => ({ enabled: true, configured: true }),
    listOutputs: async () => [],
  }, ctx);
  const a = createAlfred({ settingsFile: file, ctx: fullCtx, noTimers: true, log: (k, d) => logs.push({ k, d }), emit: () => {}, akoweReady: () => !!akowe });
  return { a, logs, calls };
}
const kinds = (logs) => logs.map((l) => l.k);
const ofKind = (logs, k) => logs.filter((l) => l.k === k).map((l) => l.d);

async function main() {
  console.log('\n== the plans: form fields → tool calls (no AI) ==');
  {
    let p = quickPlan('picture', { what: 'a lighthouse at dusk', size: '832x1216', engine: 'sd' });
    assert(p.steps.length === 1 && p.steps[0].name === 'generate_image' && p.steps[0].args.prompt === 'a lighthouse at dusk' && p.steps[0].args.width === 832 && p.steps[0].args.height === 1216 && p.steps[0].args.engine === 'sd' && p.text === 'Make a picture of a lighthouse at dusk.', '🎨 picture: prompt, size, engine from the form');
    p = quickPlan('picture', { what: 'x y', size: '99999x1', engine: 'auto' });
    assert(!('width' in p.steps[0].args) && !('engine' in p.steps[0].args), '🎨 an unknown size is left out; engine auto = the default');
    assert(quickPlan('picture', { what: ' ' }).error === 'EMPTY', '🎨 nothing to draw → EMPTY (no request)');
    p = quickPlan('video', { what: 'waves on rocks', seconds: '6' });
    assert(p.steps[0].name === 'generate_video' && p.steps[0].args.prompt === 'waves on rocks' && p.steps[0].args.seconds === 6, '🎬 video: prompt + seconds');
    p = quickPlan('cover', { what: 'a lighthouse in a storm' });
    assert(p.steps[0].name === 'make_cover_art' && p.steps[0].args.note === 'a lighthouse in a storm' && quickPlan('cover', {}).steps[0].name === 'make_cover_art', '🖼 cover: make_cover_art with the note (optional)');
    p = quickPlan('character', { name: 'Mara', about: 'the keeper who hates the sea' });
    assert(p.steps.map((s) => s.name).join(',') === 'create_dossier,forge_character' && p.steps[0].args.kind === 'characters' && p.steps[0].args.name === 'Mara' && p.steps[0].args.about === 'the keeper who hates the sea' && p.steps[1].args.character === 'Mara', '🧑 character: add (or find) them, then invent the rest as proposals');
    p = quickPlan('newbook', { idea: 'A keeper finds a door under the sea', genre: 'cosy mystery' });
    assert(p.steps[0].name === 'start_book' && p.steps[0].args.idea === 'A keeper finds a door under the sea' && p.steps[0].args.genre === 'cosy mystery', '✍ new book: start_book with the idea and genre');
    assert(quickPlan('book').ai && quickPlan('continue').ai && quickPlan('nope').error === 'BAD_KIND', '📖 / ✍ go to his AI first (with a direct fallback); an unknown button is refused');
  }

  console.log('\n== free text that asks for a picture / a video ==');
  {
    const yes = [['draw me a lighthouse', 'picture', 'a lighthouse'], ['Make a picture of a cat on a windowsill.', 'picture', 'a cat on a windowsill'], ['can you generate an image of a dragon please?', 'picture', 'a dragon'], ['paint a stormy sea', 'picture', 'a stormy sea'], ['make a short video of waves crashing', 'video', 'waves crashing']];
    for (const [t, k, subj] of yes) { const i = actionIntent(t); assert(i && i.kind === k && i.subject === subj, `"${t}" → ${k} of "${i && i.subject}"`); }
    for (const t of ['what pictures are in my book?', 'how do I make a picture?', 'illustrate chapter 2', 'make the cover art', 'hello Alfred', 'what is the status of my book?', 'draw Mara\'s portrait for her dossier']) assert(!actionIntent(t), `"${t}" is not a free picture request (its own tool, or a question)`);
  }

  // a model that never calls a tool (what the user's local model did)
  const words = await fakeLlm(() => ({ content: 'What a lovely idea! A lighthouse at dusk would look wonderful with warm light.' }));

  console.log('\n== 🎨 Make a picture with a words-only model: the card at once, no AI call ==');
  {
    const { a, logs, calls } = make({ llm: words });
    const n0 = words.requests.length;
    const r = await a.quick('picture', { what: 'a lighthouse at dusk', size: '768x768', engine: 'sd' });
    assert(r.ok && r.type === 'confirm' && r.card.steps.length === 1 && r.card.steps[0].tool === 'generate_image' && /a lighthouse at dusk/.test(r.card.steps[0].text) && /768×768/.test(r.card.steps[0].text), `the "I will" card shows at once and says what will be made ("${r.card && r.card.steps[0].text}")`);
    assert(words.requests.length === n0, 'his AI was not asked at all (the form is the request)');
    assert(calls.generateImage.length === 0 && a.status().card && a.status().card.id === r.card.id, 'nothing is made before ✔ Do it; the card waits in his status');
    assert(a.status().chat.some((m) => m.role === 'you' && m.text === 'Make a picture of a lighthouse at dusk.'), 'the chat shows what you asked');
    const busy = await a.quick('picture', { what: 'another' });
    assert(busy.ok === false && busy.error === 'BUSY', 'a second button while the card waits: "answer the card first"');
    const d = await a.confirm(r.card.id);
    assert(calls.generateImage.length === 1 && calls.generateImage[0].prompt === 'a lighthouse at dusk' && calls.generateImage[0].width === 768 && calls.generateImage[0].height === 768 && calls.generateImage[0].engine === 'sd', '✔ Do it → generate_image with the form\'s prompt, size and engine');
    assert(d.type === 'reply' && /Saved 1 image/.test(d.text) && words.requests.length === n0, `the result is said plainly, still without asking his AI ("${d.text}")`);
    assert(!a.status().busy && !a.status().card, 'he is free again');
    const ask = ofKind(logs, 'alfred-ask')[0];
    assert(ask && ask.quick === 'picture' && ask.chars > 0, 'alfred-ask records the button (quick: picture) and the length only');
    const replies = ofKind(logs, 'alfred-reply');
    assert(replies.length === 2 && replies[0].outcome === 'card' && replies[0].card === true && replies[0].brain === 'direct' && replies[1].outcome === 'done' && replies[1].tools_called.join() === 'generate_image' && replies[1].quick === 'picture' && Number.isFinite(replies[1].ms) && replies[1].chars === d.text.length, `alfred-reply: card, then done with the tool (${JSON.stringify(replies[1])})`);
    const tl = ofKind(logs, 'alfred-tool')[0];
    assert(tl && tl.tool === 'generate_image' && tl.ok === true && tl.req === ask.req && tl.quick === 'picture', 'alfred-tool: ok, tied to the request');
    assert(!kinds(logs).includes('alfred-no-action'), 'no alfred-no-action: it did act');
    const all = JSON.stringify(logs);
    assert(!/lighthouse|dusk|Saved 1 image/.test(all), 'nothing anyone wrote is in the log (no prompt, no reply text)');
  }

  console.log('\n== ✖ No, "always allow", an empty field, Stop ==');
  {
    const { a, logs, calls } = make({ llm: words });
    let r = await a.quick('picture', { what: 'a red boat' });
    const no = a.reject(r.card.id);
    assert(no.ok && calls.generateImage.length === 0 && ofKind(logs, 'alfred-reply').pop().outcome === 'declined' && !a._history().some((m) => m.role === 'user' && /^Result of/.test(m.content)), '✖ No: nothing made, outcome "declined", the conversation stays clean');
    r = await a.quick('picture', { what: 'a red boat' });
    await a.confirm(r.card.id, { alwaysAllow: ['generate_image'] });
    const before = calls.generateImage.length;
    r = await a.quick('picture', { what: 'a blue boat' });
    assert(r.type === 'reply' && calls.generateImage.length === before + 1 && /Saved/.test(r.text), '"always allow" ticked once: the next 🎨 makes it straight away (no card)');
    r = await a.quick('picture', { what: '' });
    assert(r.ok === false && r.error === 'EMPTY' && /picture should show/.test(r.message) && !a.status().busy, 'an empty description: a plain sentence, no request');
    const { a: a2, calls: c2 } = make({ llm: words });
    r = await a2.quick('video', { what: 'waves' });
    a2.cancel();
    assert(!a2.status().card && !a2.status().busy && c2.videoInvoke.length === 0, '■ Stop while the card waits: nothing is done');
  }

  console.log('\n== 🎬 video, 🖼 cover, 🧑 character, ✍ new book: their cards, against a fake Akọwe ==');
  {
    const ak = await fakeAkowe(TOKEN);
    const { a, logs, calls } = make({ llm: words, akowe: ak });
    let r = await a.quick('video', { what: 'waves on the rocks', seconds: '4' });
    assert(r.type === 'confirm' && r.card.steps[0].tool === 'generate_video', '🎬 → the generate_video card');
    let d = await a.confirm(r.card.id);
    assert(calls.videoInvoke[0] && calls.videoInvoke[0].m === 'video.generate' && calls.videoInvoke[0].p.prompt === 'waves on the rocks' && calls.videoInvoke[0].p.seconds === 4 && /Saved the clip/.test(d.text), `… ✔ → the 🎬 Video module, said plainly ("${d.text}")`);
    r = await a.quick('cover', { what: 'a lighthouse in a storm' });
    d = await a.confirm(r.card.id);
    assert(r.card.steps[0].tool === 'make_cover_art' && ak.requests.some((x) => x.method === 'PUT' && /\/cover$/.test(x.path) && x.body && x.body.art_note === 'a lighthouse in a storm') && ak.requests.some((x) => x.method === 'POST' && /\/cover\/art$/.test(x.path)) && /cover art/.test(d.text), '🖼 → make_cover_art: the note, then the art (Akọwe)');
    r = await a.quick('character', { name: 'Odile', about: 'a smuggler' });
    assert(r.card.steps.length === 2 && /Odile/.test(r.card.steps[0].text) && /proposals/.test(r.card.steps[1].text), '🧑 → one card, two steps: add Odile, then invent the rest');
    // the fake Akọwe knows Mara only: after create, forge looks Odile up — the fake has no Odile, so step 2 explains plainly
    d = await a.confirm(r.card.id);
    assert(ak.requests.some((x) => x.method === 'POST' && /\/forge\/characters$/.test(x.path) && x.body.name === 'Odile' && x.body.about === 'a smuggler') && /^✔ /.test(d.text) && /didn't work: I couldn't find a character called “Odile”/.test(d.text), `step 1 ran; step 2's problem is said plainly ("${d.text.replace(/\n/g, ' | ').slice(0, 200)}")`);
    assert(ofKind(logs, 'alfred-reply').pop().outcome === 'error' && ofKind(logs, 'alfred-tool').some((t) => t.tool === 'forge_character' && t.ok === false && t.error === 'NO_CHARACTER'), 'the outcome is "error" and alfred-tool carries the code');
    r = await a.quick('character', { name: 'Mara Vell' });
    d = await a.confirm(r.card.id);
    assert(/✔ .*Mara Vell/.test(d.text) && ak.state.forgeCalls.some((x) => x.kind === 'forge'), `a character the book has: forged ("${d.text.replace(/\n/g, ' | ').slice(0, 160)}")`);
    r = await a.quick('newbook', { idea: 'A keeper finds a door under the sea' });
    d = await a.confirm(r.card.id);
    assert(r.card.steps[0].tool === 'start_book' && ak.requests.some((x) => x.method === 'POST' && x.path === '/api/autobook' && x.body.author_confirms === true) && /run started/.test(d.text), '✍ new book → start_book after ✔ (your consent for this one run)');
    await ak.close();
  }

  console.log('\n== 📖 My book / ✍ Continue: answered in words, or his AI down → the status, read directly ==');
  {
    const ak = await fakeAkowe(TOKEN);
    let { a, logs } = make({ llm: words, akowe: ak });
    let r = await a.quick('book');
    assert(r.type === 'reply' && /📖 The book we are working on now is “The Lighthouse Keeper”/.test(r.text), `📖 answered in words without looking → what Akọwe says ("${r.text.slice(0, 120)}")`);
    assert(ofKind(logs, 'alfred-fallback')[0] && ofKind(logs, 'alfred-reply').pop().outcome === 'fallback-status' && ofKind(logs, 'alfred-reply').pop().tools_called.includes('book_status'), 'logged: alfred-fallback, outcome fallback-status, book_status called');
    ({ a, logs } = make({ akowe: ak })); // nothing answers at the AI address
    r = await a.quick('book');
    assert(r.type === 'reply' && /^My AI didn't answer/.test(r.text) && /Lighthouse Keeper/.test(r.text), `📖 with his AI down: says so, and the status anyway ("${r.text.slice(0, 140)}")`);
    ak.state.run.status = 'interrupted';
    ({ a, logs } = make({ llm: words, akowe: ak }));
    r = await a.quick('continue');
    assert(r.type === 'confirm' && r.card.steps[0].tool === 'resume_run' && /Lighthouse Keeper/.test(r.card.intro), '✍ Continue answered in words, the run stopped → a ▶ Resume card');
    const n = ak.requests.length;
    await a.confirm(r.card.id);
    assert(ak.requests.slice(n).some((x) => x.method === 'POST' && x.path === '/api/autobook/run-abc/resume'), '… ✔ resumes the run');
    ak.state.run.status = 'running';
    ({ a, logs } = make({ llm: words, akowe: ak }));
    r = await a.quick('continue');
    assert(r.type === 'reply' && /already writing/.test(r.text), '✍ while it writes: says so plainly');
    // a model that does call book_status: his own words, no fallback
    const good = await fakeLlm((body) => (lastMsg(body).role === 'tool' ? { content: 'Your book is being written.' } : toolCall('book_status', {})));
    ({ a, logs } = make({ llm: good, akowe: ak }));
    r = await a.quick('book');
    assert(r.text === 'Your book is being written.' && !kinds(logs).includes('alfred-fallback') && ofKind(logs, 'alfred-reply').pop().outcome === 'done', 'a model that looks: his answer stands (outcome done)');
    await good.close(); await ak.close();
  }

  console.log('\n== free text "draw me a lighthouse": words → one stricter retry → a "🎨 Make it now" card ==');
  {
    const { a, logs, calls } = make({ llm: words });
    const n0 = words.requests.length;
    const r = await a.ask('draw me a lighthouse');
    assert(words.requests.length === n0 + 2, `his AI was asked twice (once more after words only) (${words.requests.length - n0})`);
    const second = words.requests[words.requests.length - 1].body.messages;
    assert(/Call the generate_image tool NOW/.test(second[second.length - 1].content) && !a._history().some((m) => /A note from the app/.test(m.content || '')), 'the retry carried a plain "use the tool" note (for that call only)');
    assert(r.type === 'confirm' && r.card.doLabel === '🎨 Make it now' && r.card.steps[0].tool === 'generate_image' && /“a lighthouse”/.test(r.card.steps[0].text) && /answered only in words/.test(r.card.intro), `then a one-click card built from the request ("${r.card && r.card.steps[0].text}")`);
    const d = await a.confirm(r.card.id);
    assert(calls.generateImage.length === 1 && calls.generateImage[0].prompt === 'a lighthouse' && /Saved/.test(d.text), '🎨 Make it now → the picture');
    const retry = ofKind(logs, 'alfred-retry')[0]; const na = ofKind(logs, 'alfred-no-action')[0]; const rep = ofKind(logs, 'alfred-reply');
    assert(retry && retry.intent === 'picture' && retry.model === 'qwen2.5:3b' && na && na.quick === 'free:picture' && na.severity === 'warn' && na.brain === 'local' && rep[0].outcome === 'fallback-card' && rep[0].retried === true && rep[1].outcome === 'done', `logged: alfred-retry, alfred-no-action (warn), fallback-card, done (${JSON.stringify(na)})`);
    assert(!/lighthouse/.test(JSON.stringify(logs)), 'text-free');
  }
  {
    // the retry works: the model calls the tool the second time → the normal card
    const late = await fakeLlm((body, n) => (lastMsg(body).role === 'tool' ? { content: 'There it is.' } : /A note from the app/.test(lastMsg(body).content || '') ? toolCall('generate_image', { prompt: 'a lighthouse on a cliff' }) : { content: 'Sure, I love lighthouses.' }));
    const { a, logs } = make({ llm: late });
    const r = await a.ask('draw me a lighthouse');
    assert(r.type === 'confirm' && !r.card.doLabel && /a lighthouse on a cliff/.test(r.card.steps[0].text), 'a model that calls the tool on the retry: its own card');
    const d = await a.confirm(r.card.id);
    assert(d.text === 'There it is.' && ofKind(logs, 'alfred-reply').pop().outcome === 'done' && ofKind(logs, 'alfred-reply').pop().retried === true && !kinds(logs).includes('alfred-no-action'), 'outcome done (retried), no alfred-no-action');
    await late.close();
  }
  {
    const { a, logs } = make({ llm: words });
    const n0 = words.requests.length;
    const r = await a.ask('what is a good name for a lighthouse keeper?');
    assert(r.type === 'reply' && words.requests.length === n0 + 1 && !kinds(logs).includes('alfred-retry'), 'a plain question answered in words: no retry, no card');
    const rp = ofKind(logs, 'alfred-reply')[0];
    assert(rp && rp.outcome === 'answered-in-words' && rp.tools_called.length === 0 && rp.card === false && rp.brain === 'local' && rp.model === 'qwen2.5:3b' && rp.steps === 1 && rp.chars === r.text.length && !kinds(logs).includes('alfred-no-action'), `alfred-reply for words: ${JSON.stringify(rp)}`);
    const r2 = await a.ask('make a picture of a cat', {}); // (not a button: free text)
    assert(r2.type === 'confirm' && r2.card.doLabel, '"make a picture of a cat" → the same fallback card');
    a.reject(r2.card.id);
  }

  console.log('\n== an AI-path button answered in words: alfred-no-action (warn) ==');
  {
    // ✍ Continue with no Akọwe at all: the fallback can't read anything → his words stand, flagged
    const { a, logs } = make({ llm: words });
    const r = await a.quick('continue');
    const na = ofKind(logs, 'alfred-no-action')[0];
    assert(r.type === 'reply' && na && na.quick === 'continue' && na.severity === 'warn' && na.model === 'qwen2.5:3b', `logged alfred-no-action for ✍ (${JSON.stringify(na)})`);
  }

  console.log('\n== the Extract (book scope) keeps Alfred\'s outcome records ==');
  {
    const t0 = 1_700_000_000_000;
    const book = { id: 'p1', title: 'B', windows: [[t0, t0 + 60000]], requestIds: new Set(), seqs: new Set() };
    const log = [{ ts: t0 + 1000, kind: 'alfred-ask', detail: { req: 'req-1', chars: 20, quick: 'picture' } }, { ts: t0 + 2000, kind: 'alfred-reply', detail: { req: 'req-1', outcome: 'answered-in-words' } }, { ts: t0 + 2001, kind: 'alfred-no-action', detail: { req: 'req-1', quick: 'picture' } }, { ts: t0 + 999999, kind: 'alfred-reply', detail: { req: 'req-9' } }, { ts: t0 + 3000, kind: 'butler-chat', detail: {} }];
    const sel = logExtract.selectEntries({ scope: 'book', book, transcript: [], log });
    assert(sel.events.map((e) => e.kind).join() === 'alfred-ask,alfred-reply,alfred-no-action', `book scope: Alfred's records inside the run window come along, others don't (${sel.events.map((e) => e.kind).join()})`);
    assert(logExtract.ALFRED_TROUBLE.has('alfred-reply') && logExtract.ALFRED_TROUBLE.has('alfred-no-action') && logExtract.ALFRED_TROUBLE.has('alfred-tool'), 'the list names them');
  }

  console.log('\n== the picture tool on a Forge WITHOUT ADetailer: the 🎨 Images tab\'s own path (PR #120) ==');
  {
    const ip = require('../image-provider');
    const sdApi = require('../sd-api');
    const { createSdStudio } = require('../sd-studio');
    const { createImageAdapter } = require('../alfred-image');
    const { sdMethodsOf } = require('../alfred-main');
    const imagesDir = path.join(TMP, 'images');
    const sdLogs = [];
    const studio = createSdStudio({ imageProvider: ip, library: null, imagesDir: () => imagesDir, workflowsDir: () => path.join(TMP, 'wf'), workflowFilesDir: () => path.join(TMP, 'wff'), fileUrl: (p) => `file://${p}`, log: (k, d) => sdLogs.push([k, d]) });
    const api = sdApi.createImagesApi({ studio, library: { list: () => ({ items: [] }), get: () => null, getLock: () => null, listLocks: () => ({ locks: [] }), scan: () => ({ ok: true }), characterLock: async () => null } });
    const forge = await fakeA1111({ flavor: 'forge', noExtensions: true, title: 'Stable Diffusion WebUI Forge' });
    await studio.connect(forge.base);
    const adapter = createImageAdapter({ sdApi: { get: () => api } });
    const ctx = { generateImage: (o) => adapter.generate(o), sdMethods: async () => sdMethodsOf(api), sdInvoke: async (m, x) => api.call(m, Object.assign({ from: 'alfred' }, x || {})) };
    const { a, logs } = make({ llm: words, ctx });
    let r = await a.quick('picture', { what: 'a lighthouse keeper', size: '512x512' });
    let d = await a.confirm(r.card.id);
    const pics = fs.existsSync(imagesDir) ? fs.readdirSync(imagesDir).filter((f) => f.endsWith('.png')) : [];
    assert(d.type === 'reply' && /Saved 1 image/.test(d.text) && !!forge.state.lastTxt2img && forge.state.lastTxt2img.prompt === 'a lighthouse keeper' && forge.state.lastTxt2img.width === 512 && pics.length === 1, `🎨 → txt2img on Forge (no ADetailer) → a PNG saved ("${d.text}")`);
    const sg = sdLogs.filter((x) => x[0] === 'sd-generate').pop();
    assert(sg && sg[1].ok === true && /^api:alfred/.test(sg[1].from), `it went through the 🎨 Images module (sd-generate from ${sg && sg[1].from}) — the same studio.generate as the tab's 🎨 Generate`);
    // the tab's ADetailer setting passed on through sd_call: left out with a plain note, never UNSUPPORTED_ON_BACKEND
    const ad = await fakeLlm((body) => (lastMsg(body).role === 'tool' ? { content: `RESULT ${lastMsg(body).content}` } : toolCall('sd_call', { method: 'images.generate', args: { prompt: 'a keeper, close up', adetailer: [{ model: 'face_yolov8n.pt' }] } })));
    const { a: a2, logs: l2 } = make({ llm: ad, ctx });
    r = await a2.ask('make it with face fixing');
    d = await a2.confirm(r.card.id);
    assert(/"ok":true/.test(d.raw || d.text) && /ADetailer \(fix faces \/ hands\) was left out/.test(d.raw || d.text) && !forge.state.lastTxt2img.alwayson_scripts, 'sd_call images.generate with ADetailer on a Forge without it: made without it, the "left out" note reaches him (and the user)');
    assert(ofKind(l2, 'alfred-tool').some((t) => t.tool === 'sd_call' && t.ok === true), 'alfred-tool ok');
    await ad.close();
    // an image error in plain words + its code in the log
    const empty = await fakeA1111({ flavor: 'forge', noModels: true });
    await studio.connect(empty.base);
    r = await a.quick('picture', { what: 'a gull' });
    d = await a.confirm(r.card.id);
    const tl = ofKind(logs, 'alfred-tool').pop();
    assert(d.type === 'reply' && /^Generate an image didn't work: /.test(d.text) && !/UNSUPPORTED|undefined|\{/.test(d.text) && d.text.length > 40, `a failure is said in plain words ("${d.text.slice(0, 200)}")`);
    assert(tl && tl.tool === 'generate_image' && tl.ok === false && /^[A-Z_]+$/.test(tl.error) && tl.severity === 'warn' && ofKind(logs, 'alfred-reply').pop().outcome === 'error', `alfred-tool carries the code (${tl && tl.error}), the reply outcome is "error"`);
    await empty.close(); await forge.close();
  }

  console.log('\n== the side panel (jsdom): the forms send alfred:quick with their fields ==');
  {
    const html = fs.readFileSync(path.join(__dirname, '..', 'controls.html'), 'utf8');
    const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
    const wc = []; let onAlfred = null;
    const status = (extra) => Object.assign({ ok: true, enabled: true, settings: { brain: 'local', local: { endpoint: '', model: 'qwen2.5:3b' }, pane: { site: 'chatgpt' }, maxSteps: 8, notices: true, interpreter: false, alwaysAllow: {}, personality: { name: 'Alfred' }, panel: { open: true }, profiles: [] }, chat: [], activity: [], card: null, busy: false, ai: {}, connected: {} }, extra || {});
    let cur = status();
    dom.window.api = {
      alfredStatus: async () => cur, alfredSetEnabled: async () => cur, onAlfred: (cb) => { onAlfred = cb; }, syncPanes: async () => ({ ok: true }),
      alfredAsk: async (t) => { wc.push(`ask:${t}`); return { ok: true }; },
      alfredQuick: async (k, f) => { wc.push(`quick:${k}:${JSON.stringify(f)}`); return k === 'video' ? { ok: false, error: 'EMPTY', message: 'Say what the video should show first.' } : { ok: true, type: 'confirm' }; },
      alfredConfirm: async (id) => { wc.push(`confirm:${id}`); return { ok: true }; }, alfredReject: async () => ({ ok: true }),
      alfredBooks: async () => ({ ok: true, akowe: true, books: [{ project_id: 'p1', title: 'B' }] }),
    };
    dom.window.eval(fs.readFileSync(path.join(__dirname, '..', 'alfred-panel.js'), 'utf8'));
    await sleep(30);
    const d = dom.window.document;
    const submit = async () => { d.getElementById('alfred-form').dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await sleep(20); };
    d.getElementById('alfred-a-picture').click(); await sleep(10);
    const size = d.getElementById('alfred-f-size'); const engine = d.getElementById('alfred-f-engine');
    assert(size && size.tagName === 'SELECT' && Array.from(size.options).some((o) => o.value === '1024x1024') && engine && Array.from(engine.options).map((o) => o.value).join() === 'auto,sd,chatgpt', '🎨 form: what + size + "made by" (Stable Diffusion / ChatGPT)');
    d.getElementById('alfred-f-what').value = 'a lighthouse at dusk'; size.value = '1216x832'; engine.value = 'chatgpt';
    await submit();
    assert(wc.includes('quick:picture:{"what":"a lighthouse at dusk","size":"1216x832","engine":"chatgpt"}') && !wc.some((x) => x.startsWith('ask:')) && d.getElementById('alfred-form').hidden, '"Ask Alfred" sends alfred:quick with the fields (not words for his AI)');
    d.getElementById('alfred-a-video').click(); await sleep(10);
    d.getElementById('alfred-f-what').value = 'w'; d.getElementById('alfred-f-seconds').value = '6';
    await submit();
    assert(wc.includes('quick:video:{"what":"w","seconds":"6"}') && /video should show/.test(d.getElementById('alfred-quick-msg').textContent), '🎬 sends seconds too; a refusal is shown as his note');
    d.getElementById('alfred-a-book').click(); await sleep(30);
    assert(wc.includes('quick:book:{}'), '📖 My book → alfred:quick book');
    d.getElementById('alfred-a-character').click(); await sleep(30);
    d.getElementById('alfred-f-name').value = 'Mara'; await submit();
    assert(wc.includes('quick:character:{"name":"Mara"}'), '🧑 → alfred:quick character');
    cur = status({ card: { id: 'card-9', intro: 'My AI answered only in words…', doLabel: '🎨 Make it now', steps: [{ n: 1, tool: 'generate_image', title: 'Generate an image', text: 'Make an image of “a lighthouse”', allowAlways: true, allowKey: 'generate_image' }] } });
    onAlfred({ type: 'state', state: cur }); await sleep(10);
    assert(d.getElementById('alfred-do-it').textContent === '🎨 Make it now', 'the fallback card\'s button reads "🎨 Make it now"');
    d.getElementById('alfred-do-it').click(); await sleep(10);
    assert(wc.includes('confirm:card-9'), '… and confirms the card');
    // an older main without alfred:quick: the words, as before
    delete dom.window.api.alfredQuick;
    cur = status(); onAlfred({ type: 'state', state: cur }); await sleep(10);
    d.getElementById('alfred-a-picture').click(); await sleep(10);
    d.getElementById('alfred-f-what').value = 'a ship'; await submit();
    assert(wc.includes('ask:Make a picture of a ship.'), 'without alfred:quick (older main): the request in words, as before');
  }

  await words.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
