'use strict';
// test/alfred-team.test.js — 👥 Alfred's team (alfred-team.js + alfred.js):
//   - routing: the words choose the role (named: "bad boy, …", "director, …", "assistant, …", "prompt writer, …";
//     by intent: a picture / video / cover / portrait → the Prompt writer, "step by step" / "break it up" → the Director);
//     the book's own pictures and "ask ChatGPT to draw" keep their tools; intent only for a role with its own model;
//   - role fallback: a role without a model uses the Butler's;
//   - the ★1–5 fit ratings (role strengths, size vs the 16 GB card, measured speed) with plain reasons, the 💡
//     suggestions and "Pick the best for each role" (downloaded models only, nothing is pulled);
//   - the VRAM guard (vramPlan + the real unload through Ollama's /api/ps and keep_alive 0);
//   - the flows against the fake Ollama (test/fixtures/fake-ollama.js): Bad boy (no tools, the book's content limits),
//     Prompt writer → the "I will" card → generate_image, Director → steps → cards → the Butler's report, reject stops
//     the plan, Assistant = the tool loop on its own model; who answered is on every reply; logs are text-free;
//   - teamStatus(): ✔ / ⚪ / ⚠ with a plain fix, the "team ready" line, standing by for a running book.
// Run: node test/alfred-team.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const team = require('../alfred-team');
const { createAlfred } = require('../alfred');
const ai = require('../alfred-ai');
const { fakeOllama } = require('./fixtures/fake-ollama');
const { fakeAkowe } = require('./alfred-fakes');
const { nodeHttp } = require('../akowe-link-test');
const catalog = require('../model-catalog');
const hwLib = require('../llm-hardware');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-team-'));
const GB = 1024 ** 3;
function freePort() { return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
// the user's PC: an RTX 5070 Ti, 16 GB
const HW = { ok: true, gpus: [{ name: 'NVIDIA GeForce RTX 5070 Ti', vendor: 'nvidia', vramMB: 16303 }], bestVramMB: 16303, ramMB: 32768, freeRamMB: 20000, cpu: 'Ryzen', cores: 12, platform: 'win32', appleSilicon: false, notes: [] };
const M = (name, gb, extra) => Object.assign({ name, sizeBytes: Math.round(gb * GB) }, extra || {});
const MODELS = [M('qwen2.5:14b', 9.0), M('qwen2.5:3b', 1.9), M('dolphin3:8b', 4.9), M('qwen3:14b', 9.3), M('llama3.3:70b', 43), M('nomic-embed-text:latest', 0.27), M('qwen2.5-coder:7b', 4.7)];
const CTX = { hw: HW, speeds: {}, HW: hwLib, catalog: catalog.CURATED };

async function main() {
  console.log('\n== routing: the words choose the role ==');
  const R = (t) => team.route(t);
  const named = [
    ['bad boy, write a filthy limerick about my landlord', 'badboy', 'write a filthy limerick about my landlord'],
    ['Bad boy: roast my opening line', 'badboy', 'roast my opening line'],
    ['hey badboy tell me a dark joke', 'badboy', 'tell me a dark joke'],
    ['ask the bad boy to write a villain monologue', 'badboy', 'write a villain monologue'],
    ['Director, plan the launch of my book', 'director', 'plan the launch of my book'],
    ['let the director sort out my week', 'director', 'sort out my week'],
    ['assistant, check the status of my book', 'assistant', 'check the status of my book'],
    ['prompt writer, a dragon over a burning city', 'prompt', 'a dragon over a burning city'],
    ['Butler, what can you do?', 'butler', 'what can you do?'],
  ];
  for (const [t, role, text] of named) { const r = R(t); assert(r.role === role && r.why === 'named' && r.text === text, `"${t}" → ${role} (named), "${r.text}"`); }
  assert(R('what would the bad boy say about chapter two?').role === 'badboy', '"the bad boy" anywhere in the sentence → the Bad boy');
  const intents = [
    ['make me a picture of a castle in the rain', 'prompt', 'picture', 'free'],
    ['Make me a portrait of Mara, the lighthouse keeper', 'prompt', 'picture', 'portrait'],
    ['design a cover for my book', 'prompt', 'picture', 'cover'],
    ['draw me a fox', 'prompt', 'picture', 'free'],
    ['make a short video of waves crashing on rocks', 'prompt', 'video', 'video'],
    ['write me an image prompt for a haunted mill', 'prompt', 'picture', 'free'],
  ];
  for (const [t, role, kind, purpose] of intents) { const r = R(t); assert(r.role === role && r.why === 'intent' && r.media && r.media.kind === kind && r.media.purpose === purpose, `"${t}" → ${role} (${kind}, ${purpose})`); }
  for (const t of ['break it up: write the blurb, then make the cover, then post it', 'do this step by step: check my book and fix the outline', 'first read chapter one, then summarise it, and finally rate it', 'make a plan for the launch week']) assert(R(t).role === 'director' && R(t).why === 'intent', `"${t}" → director (intent)`);
  for (const t of ["what's the status of my book?", 'ask ChatGPT to draw a cat', 'illustrate chapter 3', 'make the book trailer', 'directory of my files please', 'how do I make a picture?', 'hello Alfred']) assert(R(t).role === 'butler' && R(t).why === 'default', `"${t}" → the Butler (default)`);
  assert(team.route('bad boy, make me a picture of a demon queen').media && team.route('bad boy, make me a picture of a demon queen').media.kind === 'picture', 'the Bad boy asked for a picture: he writes the (uncensored) prompt');

  console.log('\n== role fallback: no model → the Butler\'s ==');
  const t0 = team.sanitizeTeam({ badboy: { model: 'dolphin3:8b' }, director: 'qwen3:14b', prompt: { model: 'bad name; rm -rf' } });
  assert(team.modelFor(t0, 'badboy', 'qwen2.5:14b').model === 'dolphin3:8b' && team.modelFor(t0, 'badboy', 'qwen2.5:14b').own, 'a role with its own model uses it');
  assert(team.modelFor(t0, 'assistant', 'qwen2.5:14b').model === 'qwen2.5:14b' && !team.modelFor(t0, 'assistant', 'qwen2.5:14b').own, 'a role without one uses the Butler\'s (so one model is enough)');
  assert(team.modelFor(t0, 'director', 'x').model === 'qwen3:14b', 'a plain string is accepted too');
  assert(t0.prompt.model === 'badnamerm-rf', 'a model name is cleaned (no spaces / ; )');
  assert(team.modelFor({}, 'butler', 'qwen2.5:7b').model === 'qwen2.5:7b', 'the Butler: his ⚙ Model');

  console.log('\n== ★ fit ratings for each role (16 GB card) ==');
  const rt = (role, name, ctx) => team.rate(role, MODELS.find((m) => m.name === name) || { name }, ctx || CTX);
  for (const role of team.ROLE_IDS) for (const m of MODELS) { const r = rt(role, m.name); if (!(r.stars >= 1 && r.stars <= 5 && r.why.length)) assert(false, `${role}/${m.name}: ${JSON.stringify(r)}`); }
  assert(true, 'every role × model: 1–5 stars, with reasons');
  assert(rt('badboy', 'dolphin3:8b').stars > rt('badboy', 'qwen2.5:14b').stars && /Uncensored/.test(rt('badboy', 'dolphin3:8b').text) && /refuse/.test(rt('badboy', 'qwen2.5:14b').text), `Bad boy: dolphin3 ★${rt('badboy', 'dolphin3:8b').stars} > qwen2.5:14b ★${rt('badboy', 'qwen2.5:14b').stars} ("${rt('badboy', 'qwen2.5:14b').text}")`);
  assert(rt('assistant', 'qwen2.5:14b').stars > rt('assistant', 'dolphin3:8b').stars && /tools/.test(rt('assistant', 'qwen2.5:14b').text), `Assistant: tool-calling qwen2.5:14b ★${rt('assistant', 'qwen2.5:14b').stars} > dolphin3 ★${rt('assistant', 'dolphin3:8b').stars}`);
  assert(rt('director', 'qwen3:14b').stars >= 4 && rt('director', 'qwen3:14b').stars > rt('director', 'qwen2.5:3b').stars && /reasoning/.test(rt('director', 'qwen3:14b').text), `Director: reasoning qwen3:14b ★${rt('director', 'qwen3:14b').stars} > qwen2.5:3b ★${rt('director', 'qwen2.5:3b').stars}`);
  assert(rt('prompt', 'qwen2.5-coder:7b').stars < rt('prompt', 'qwen2.5:14b').stars && /coding/.test(rt('prompt', 'qwen2.5-coder:7b').text), 'Prompt writer: a coding model rates lower');
  assert(rt('butler', 'llama3.3:70b').stars <= 2 && /Too big|slow/i.test(rt('butler', 'llama3.3:70b').text), `a 70B model on a 16 GB card: ★${rt('butler', 'llama3.3:70b').stars} ("${rt('butler', 'llama3.3:70b').why[0]}")`);
  assert(rt('butler', 'nomic-embed-text:latest').stars === 1 && /cannot chat/.test(rt('butler', 'nomic-embed-text:latest').text), 'an embedding model: ★1, it cannot chat');
  assert(/Small \(3B\)/.test(rt('assistant', 'qwen2.5:3b').text) && /Very small/.test(team.rate('assistant', { name: 'qwen2.5:0.5b', sizeBytes: 0.4 * GB }, CTX).text), 'a 3B model is "small", a 0.5B one "very small — picks the wrong tool"');
  const slow = rt('butler', 'qwen2.5:14b', Object.assign({}, CTX, { speeds: { 'qwen2.5:14b': { tokensPerSec: 4 } } }));
  const fast = rt('butler', 'qwen2.5:14b', Object.assign({}, CTX, { speeds: { 'qwen2.5:14b': 60 } }));
  assert(slow.stars < fast.stars && /Measured on this PC/.test(slow.text), `measured speed counts: slow ★${slow.stars} < fast ★${fast.stars}`);
  assert(team.rate('butler', { name: 'mystery-model' }, {}).stars >= 1, 'an unknown model without hardware info still gets a rating');
  assert(team.starsText(4) === '★★★★☆', 'stars text');

  console.log('\n== 💡 suggestions and "Pick the best for each role" (downloaded models only) ==');
  const sg = team.suggest('director', 'qwen2.5:3b', MODELS, CTX);
  assert(sg && sg.model === 'qwen3:14b' && sg.stars >= sg.current + 1, `Director on qwen2.5:3b → 💡 ${sg && sg.model} (★${sg && sg.stars} vs ★${sg && sg.current})`);
  assert(team.suggest('director', 'qwen3:14b', MODELS, CTX) === null, 'no suggestion when the current one is already the best');
  assert(team.suggest('badboy', '', [], CTX) === null, 'no downloaded models: no suggestion');
  const best = team.pickBest(MODELS, CTX, 'qwen2.5:14b');
  assert(best.badboy === 'dolphin3:8b' && best.director === 'qwen3:14b' && /qwen/.test(best.assistant) && best.butler && MODELS.some((m) => m.name === best.prompt), `best: ${JSON.stringify(best)}`);
  assert(!Object.values(best).some((n) => /70b|embed/.test(n)), 'never the too-big or the embedding model');
  const tie = team.pickBest([M('a-model:7b', 4.7, { family: 'qwen2.5' }), M('b-model:7b', 4.7, { family: 'qwen2.5' })], CTX, 'b-model:7b');
  assert(tie.assistant === tie.butler, 'a tie goes to the model the Butler already uses (one model loaded = no swapping)');

  console.log('\n== VRAM guard: never two big models fighting over 16 GB ==');
  const sizeOf = (n) => (MODELS.find((m) => m.name === n) || {}).sizeBytes;
  let v = team.vramPlan({ want: 'qwen3:14b', loaded: [{ name: 'qwen2.5:14b', sizeVram: 9.6 * GB }], vramMB: 16303, sizeOf });
  assert(v.unload.length === 1 && v.unload[0] === 'qwen2.5:14b' && v.fits === true && !v.reuse, 'a second 14B model: the first is unloaded first');
  v = team.vramPlan({ want: 'qwen2.5:14b', loaded: [{ name: 'qwen2.5:14b', sizeVram: 9.6 * GB }], vramMB: 16303, sizeOf });
  assert(v.reuse && !v.unload.length, 'the same model: reused, nothing unloaded');
  v = team.vramPlan({ want: 'qwen2.5:3b', loaded: [{ name: 'dolphin3:8b', sizeVram: 5.2 * GB }], vramMB: 16303, sizeOf });
  assert(!v.unload.length && v.fits, 'two that fit together stay together');
  v = team.vramPlan({ want: 'qwen2.5:3b', loaded: [{ name: 'a:1b', sizeVram: 7 * GB }, { name: 'b:1b', sizeVram: 8.5 * GB }], vramMB: 16303, sizeOf });
  assert(v.unload[0] === 'b:1b' && v.unload.length === 1, 'the biggest other model goes first, only as many as needed');
  assert(!team.vramPlan({ want: 'x', loaded: [{ name: 'y', size: 9 * GB }], vramMB: 0, sizeOf: () => GB }).unload.length, 'unknown graphics memory: leave it to Ollama');

  console.log('\n== the "team ready" line ==');
  const ok = (id, state) => ({ id, name: team.byId(id).name, state, fix: state === 'problem' ? 'Ollama isn\'t running — press 🛠 Set up his AI (one button).' : '' });
  let line = team.teamLine({ enabled: true, local: true, roles: ['butler', 'assistant', 'director', 'prompt', 'badboy'].map((id) => ok(id, 'ok')), book: { title: 'The Lighthouse Keeper' } });
  assert(line.text === "🎩 Alfred's team is connected and working for your book “The Lighthouse Keeper”: Butler ✔ · Assistant ✔ · Director ✔ · Prompt writer ✔ · Bad boy ✔" && line.tone === 'ok', line.text);
  line = team.teamLine({ enabled: true, local: true, roles: [ok('butler', 'ok'), ok('assistant', 'unset'), ok('badboy', 'problem')], book: null, run: { title: 'Fog', live: true } });
  assert(/needs a hand/.test(line.text) && /Assistant ⚪/.test(line.text) && /Bad boy ⚠/.test(line.text) && /press 🛠 Set up his AI/.test(line.text) && line.tone === 'warn', line.text);
  line = team.teamLine({ enabled: true, local: true, roles: [ok('butler', 'ok')], run: { title: 'Fog', live: true } });
  assert(/standing by for your book “Fog” while Akọwe writes it/.test(line.text), line.text);
  assert(team.teamLine({ enabled: false, roles: [] }).text === '', 'Alfred off: no line');
  assert(/all roles think with Claude/.test(team.teamLine({ enabled: true, local: false, brainWord: 'Claude (web pane)', roles: [ok('butler', 'ok')] }).text), 'a web pane brain: every role thinks with it');

  console.log('\n== the Director\'s plan ==');
  const pl = team.parsePlan({ steps: [{ role: 'Assistant', task: 'Check the book' }, { role: 'prompt writer', task: 'A cover prompt' }, { role: 'wizard', task: 'Do magic' }, { role: 'butler', task: 'x' }] });
  assert(pl.length === 3 && pl[0].role === 'assistant' && pl[1].role === 'prompt' && pl[2].role === 'assistant', `roles normalised, unknown → assistant, too-short tasks dropped (${JSON.stringify(pl)})`);
  assert(team.parsePlan({ nope: 1 }) === null && team.parsePlan({ steps: [] }) === null, 'no steps → null');

  await flows();
}

// ===================================================================================================== the flows
async function flows() {
  const port = await freePort();
  const fo = fakeOllama(port);
  const G = (gb) => Math.round(gb * GB);
  fo.st.models = [{ name: 'qwen2.5:14b', size: G(9.0) }, { name: 'dolphin3:8b', size: G(4.9) }, { name: 'qwen3:14b', size: G(9.3) }, { name: 'qwen2.5:7b', size: G(4.7) }];
  const seen = []; // [role-ish, model, tools?]
  fo.st.chat = (j) => {
    const sys = String((j.messages[0] || {}).content || '');
    const last = j.messages[j.messages.length - 1] || {};
    if (/Prompt writer in Alfred's team/.test(sys)) { seen.push(['prompt', j.model, !!j.tools]); return { content: 'Prompt: "A lone lighthouse keeper on a storm-lashed cliff at dusk, oil painting, warm lamp light"' }; }
    if (/You are the Director/.test(sys)) { seen.push(['director', j.model, !!j.tools]); return { content: '<think>hmm</think>{"steps":[{"role":"assistant","task":"Tell me the status of my book"},{"role":"prompt","task":"make a picture of the lighthouse keeper"}]}' }; }
    if (/the "bad boy" of Alfred's team/.test(sys)) { seen.push(['badboy', j.model, !!j.tools]); return { content: 'Wicked words, darling.' }; }
    if (/team just finished/.test(sys)) { seen.push(['report', j.model, !!j.tools]); return { content: 'All done: your book is being written and the picture is saved.' }; }
    seen.push(['loop', j.model, !!j.tools]);
    if (last.role === 'tool') return { content: 'Your book is being written.' };
    return { content: '', tool_calls: [{ function: { name: 'book_status', arguments: {} } }] };
  };
  await fo.up();
  const TOKEN = 'tok-team';
  const ak = await fakeAkowe(TOKEN);
  ak.state.projects[0].profile = { title: 'The Lighthouse Keeper', content_limits: 'No gore. No harm to animals.' };
  const calls = { generateImage: [] };
  const logs = [];
  const chatMsgs = [];
  function make(settings) {
    const file = path.join(TMP, `s-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(Object.assign({ enabled: true, brain: 'local', local: { endpoint: `${fo.base}/v1`, model: 'qwen2.5:14b' } }, settings || {})));
    return createAlfred({
      settingsFile: file, noTimers: true, log: (k, d) => logs.push({ k, d }), emit: (p) => { if (p && p.type === 'message') chatMsgs.push(p.message); },
      akoweReady: () => true, hardware: async () => HW, speeds: () => ({}),
      ctx: {
        akowe: (method, p, body) => nodeHttp({ method, url: ak.base + p, headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' }, body, timeoutMs: 5000 }).catch(() => ({ status: 0, json: null })),
        openBook: async () => ({ project_id: 'proj-1', from: 'tab' }),
        generateImage: async (o) => { calls.generateImage.push(o); return { ok: true, path: '/out/images/img-1.png', paths: ['/out/images/img-1.png'], count: 1 }; },
        listOutputs: async () => [],
      },
    });
  }
  ai._resetOllamaCache();
  const a = make({ team: { badboy: { model: 'dolphin3:8b' }, director: { model: 'qwen3:14b' }, prompt: { model: 'qwen2.5:14b' } } });
  const ofKind = (k) => logs.filter((l) => l.k === k).map((l) => l.d);

  console.log('\n== 🎩 Butler (default): the tool loop on his model; who answered is on the reply ==');
  let r = await a.ask("what's the status of my book?");
  assert(r.type === 'reply' && r.text === 'Your book is being written.', `the Butler answered (${r.text})`);
  assert(seen.filter((x) => x[0] === 'loop').every((x) => x[1] === 'qwen2.5:14b' && x[2]), 'with his model and the tools');
  let lastAlfred = a.status().chat.filter((m) => m.role === 'alfred').pop();
  assert(lastAlfred.by && lastAlfred.by.role === 'butler' && lastAlfred.by.name === 'Butler' && lastAlfred.by.model === 'qwen2.5:14b' && lastAlfred.by.icon === '🎩', `the reply says who: ${JSON.stringify(lastAlfred.by)}`);
  assert(fo.st.loaded.includes('qwen2.5:14b'), '(the Butler\'s model is now in memory)');

  console.log('\n== 😈 Bad boy: named → uncensored text on his model, no tools; the book\'s content limits ==');
  seen.length = 0;
  r = await a.ask('bad boy, write me a wicked toast');
  assert(r.type === 'reply' && r.text === 'Wicked words, darling.', 'he answers');
  assert(seen.length === 1 && seen[0][0] === 'badboy' && seen[0][1] === 'dolphin3:8b' && seen[0][2] === false, `on his own model, without tools (${JSON.stringify(seen)})`);
  lastAlfred = a.status().chat.filter((m) => m.role === 'alfred').pop();
  assert(lastAlfred.by.role === 'badboy' && lastAlfred.by.icon === '😈' && lastAlfred.by.model === 'dolphin3:8b', 'shown as 😈 Bad boy (dolphin3:8b)');
  assert(!fo.st.apiChats[fo.st.apiChats.length - 1].messages[0].content.includes('No gore'), 'not about the book: no content limits added');
  r = await a.ask('bad boy, write the opening scene of chapter 4 of my book');
  const sys = fo.st.apiChats[fo.st.apiChats.length - 1].messages[0].content;
  assert(/CONTENT LIMITS/.test(sys) && /No gore\. No harm to animals\./.test(sys) && /The Lighthouse Keeper/.test(sys), 'for the book: the author\'s content limits are hard rules for him too');
  assert(ofKind('alfred-team-limits').length === 1, 'logged: alfred-team-limits');
  assert(ofKind('alfred-team').some((d) => d.role === 'badboy' && d.why === 'named'), 'logged: alfred-team {role: badboy, why: named}');

  console.log('\n== VRAM guard: a second big model → the first is unloaded (fake Ollama /api/ps + keep_alive 0) ==');
  fo.st.loaded = ['qwen2.5:14b']; fo.st.unloads = [];
  seen.length = 0;
  r = await a.ask('director, check my book and then make a picture of the keeper');
  assert(fo.st.unloads.includes('qwen2.5:14b'), `before the Director's qwen3:14b (9.3 GB) answered, the Butler's qwen2.5:14b was unloaded (${JSON.stringify(fo.st.unloads)})`);
  const vr = ofKind('alfred-team-vram').find((x) => x.model === 'qwen3:14b');
  assert(vr && vr.model === 'qwen3:14b' && vr.unloaded[0] === 'qwen2.5:14b' && vr.fits === true, `logged: alfred-team-vram ${JSON.stringify(vr)}`);
  const dirCall = fo.st.apiChats.find((c) => c.model === 'qwen3:14b');
  assert(dirCall && dirCall.keep_alive === '5m', 'a role\'s other model leaves memory sooner (keep_alive 5m; the Butler\'s stays 30m)');

  console.log('\n== 🎬 Director: plan → steps (Assistant, then Prompt writer) → card → ✔ → the Butler reports ==');
  assert(r.type === 'confirm' && r.card && r.card.steps[0].tool === 'generate_image', `the plan ran to the picture step's card (${r.type})`);
  const roles = seen.map((x) => x[0]);
  assert(roles[0] === 'director' && roles.includes('loop') && roles[roles.length - 1] === 'prompt', `order: director → assistant's tool loop → prompt writer (${roles.join(', ')})`);
  assert(seen.find((x) => x[0] === 'loop')[1] === 'qwen2.5:14b', 'the Assistant has no model of his own: the Butler\'s');
  const chatNow = a.status().chat;
  const planMsg = chatNow.find((m) => m.role === 'alfred' && /Here is the plan/.test(m.text));
  assert(planMsg && planMsg.by.role === 'director' && /1\. 🧰 Assistant — Tell me the status of my book/.test(planMsg.text) && /2\. 🎨 Prompt writer — make a picture/.test(planMsg.text), 'the plan is shown, with who does each step');
  assert(chatNow.filter((m) => m.role === 'notice' && /step \d of 2/.test(m.text)).length === 2, 'each step is announced');
  assert(r.card.by && r.card.by.role === 'prompt' && /Prompt writer \(qwen2\.5:14b\) wrote this prompt/.test(r.card.intro) && /storm-lashed cliff/.test(r.card.steps[0].text), `the card shows who wrote the prompt: ${r.card.intro.slice(0, 80)}`);
  const d = await a.confirm(r.card.id);
  assert(calls.generateImage.length === 1 && /^A lone lighthouse keeper on a storm-lashed cliff/.test(calls.generateImage[0].prompt), `✔ → generate_image with the written prompt ("${calls.generateImage[0] && calls.generateImage[0].prompt.slice(0, 40)}…")`);
  assert(d.type === 'reply' && d.text === 'All done: your book is being written and the picture is saved.', `then the Butler reports back: ${d.text}`);
  lastAlfred = a.status().chat.filter((m) => m.role === 'alfred').pop();
  assert(lastAlfred.by.role === 'butler', 'the report is the Butler\'s');
  assert(ofKind('alfred-team-plan')[0].steps === 2 && ofKind('alfred-team-done').pop().steps === 2, 'logged: alfred-team-plan, alfred-team-done');
  assert(!a.status().busy && !a.status().card, 'nothing left waiting');

  console.log('\n== ✖ No on a plan\'s card stops the plan ==');
  fo.st.chat = ((orig) => (j) => (/You are the Director/.test(String(j.messages[0].content)) ? { content: '{"steps":[{"role":"prompt","task":"make a picture of a gull"},{"role":"butler","task":"say something nice about it"}]}' } : orig(j)))(fo.st.chat);
  r = await a.ask('break it up: make a picture of a gull, then say something nice');
  assert(r.type === 'confirm', 'the first step\'s card');
  const no = a.reject(r.card.id);
  assert(/stopped the Director's plan here/.test(no.text) && !a.status().busy, `✖ No → "${no.text}"`);
  assert(calls.generateImage.length === 1, 'nothing was made');

  console.log('\n== 🎨 Prompt writer by intent (it has its own model) ==');
  seen.length = 0;
  r = await a.ask('make me a portrait of the lighthouse keeper');
  assert(r.type === 'confirm' && r.card.steps[0].tool === 'generate_image' && seen[0][0] === 'prompt' && seen[0][2] === false, 'the Prompt writer writes, then the card (no tools in his call)');
  a.reject(r.card.id);
  const b = make({}); // no team: one model, everything as before
  seen.length = 0;
  r = await b.ask('make me a picture of a castle');
  assert(!seen.some((x) => x[0] === 'prompt') && seen[0][0] === 'loop', 'no Prompt writer model: the Butler handles a picture request as before (his tools)');
  if (r.card) b.reject(r.card.id);
  seen.length = 0;
  r = await b.ask('prompt writer, a castle in the fog');
  assert(seen[0][0] === 'prompt' && seen[0][1] === 'qwen2.5:14b' && r.type === 'confirm', 'named, without a model of his own: the Prompt writer on the Butler\'s model');
  b.reject(r.card.id);

  console.log('\n== 🧰 Assistant named: the tool loop on his model ==');
  const c = make({ team: { assistant: { model: 'qwen2.5:7b' } } });
  seen.length = 0;
  r = await c.ask('assistant, what is the status of my book?');
  assert(r.type === 'reply' && seen.every((x) => x[0] === 'loop' && x[1] === 'qwen2.5:7b' && x[2]), `the Assistant on qwen2.5:7b with tools (${JSON.stringify(seen)})`);
  assert(c.status().chat.filter((m) => m.role === 'alfred').pop().by.role === 'assistant', 'shown as 🧰 Assistant');

  console.log('\n== teamStatus(): ✔ / ⚪ / ⚠, the line, ratings, suggestions ==');
  ak.state.run.status = 'done';
  const e = make({ team: { badboy: { model: 'dolphin3:8b' }, director: { model: 'not-downloaded:9b' } } });
  let st = await e.teamStatus();
  const role = (id) => st.roles.find((x) => x.id === id);
  assert(st.ok && st.local && st.ollama && st.models.length === 4, 'the downloaded models');
  assert(role('butler').state === 'ok' && role('badboy').state === 'ok' && role('assistant').state === 'unset' && role('prompt').state === 'unset' && role('director').state === 'problem', `states: ${st.roles.map((x) => `${x.id}=${x.state}`).join(' ')}`);
  assert(/not-downloaded:9b isn't downloaded — pick a downloaded one/.test(role('director').fix), `a plain fix: ${role('director').fix}`);
  assert(/uses the Butler's model \(qwen2\.5:14b\)/.test(role('assistant').note), role('assistant').note);
  assert(role('badboy').rating.stars >= 4 && Object.keys(role('badboy').ratings).length === 4 && role('badboy').ratings['qwen2.5:14b'].stars < role('badboy').rating.stars, 'a rating for the chosen model and for every downloaded one');
  assert(role('director').suggestion && role('director').suggestion.model === 'qwen3:14b', `💡 ${JSON.stringify(role('director').suggestion)}`);
  assert(/needs a hand/.test(st.line.text) && /Director ⚠/.test(st.line.text) && st.line.tone === 'warn', st.line.text);
  assert(st.hw && st.hw.vramMB === 16303, 'the graphics card is known');
  st = await e.setTeam({ role: 'director', model: 'qwen3:14b' });
  assert(role('director').state === 'ok' && /Director: qwen3:14b/.test(st.message) && e.getSettings().team.director.model === 'qwen3:14b', 'Use it → the Director has qwen3:14b');
  assert(/connected and working for your book “The Lighthouse Keeper”: Butler ✔ · Assistant ⚪ · Director ✔ · Prompt writer ⚪ · Bad boy ✔/.test(st.line.text), st.line.text);
  ak.state.run.status = 'running';
  st = await e.teamStatus();
  assert(/standing by for your book “The Lighthouse Keeper” while Akọwe writes it/.test(st.line.text), `a running book: ${st.line.text}`);
  st = await e.setTeam({ role: 'butler', model: '' });
  assert(st.ok === false && st.error === 'EMPTY', 'the Butler can\'t be left without a model');
  assert((await e.setTeam({ role: 'wizard', model: 'x' })).error === 'BAD_ROLE', 'no such role');
  const pulls0 = fo.st.pulls.length;
  st = await e.pickBestTeam();
  assert(st.ok && e.getSettings().team.badboy.model === 'dolphin3:8b' && e.getSettings().team.director.model === 'qwen3:14b' && /Nothing was downloaded/.test(st.message), `✨ Pick the best: ${st.message}`);
  assert(fo.st.pulls.length === pulls0, 'no downloads');
  assert(st.roles.every((x) => x.state === 'ok'), 'every role ✔ after it');
  assert(!logs.some((l) => /wicked|lighthouse keeper|toast|gull|castle|storm-lashed|No gore/i.test(JSON.stringify(l.d))), 'the logs hold codes only — never what was asked or written');

  console.log('\n== Ollama not running ==');
  await fo.down();
  st = await e.teamStatus();
  assert(!st.ollama && st.roles.every((x) => x.state === 'problem' && /Ollama isn't running/.test(x.fix)) && /needs a hand/.test(st.line.text), `⚠ with the fix: ${st.roles[0].fix}`);
  const best2 = await e.pickBestTeam();
  assert(best2.ok === false && best2.error === 'NO_MODELS', 'Pick the best without Ollama: says why');
  await ak.close();
}

main().then(() => { console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0); }).catch((e) => { console.error(e); process.exit(1); });
