// test/images-judge-ui.test.js — the 🎨 Images tab's 💾 recipe picker, "Settings used", 🧑‍⚖️ Judge, 🔁 Make it better
// strip, "Make 4, pick the best", the judge settings drawer, "📖 Book pictures use: <recipe>" and 🎩 Alfred changing the
// form — in jsdom (controls.html + sd-record.js + sd-quality.js + images-studio.js, a stub window.api.sd).
// Run: node test/images-judge-ui.test.js
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const SD15 = 'dreamshaper_8.safetensors [879db523c3]';
const XL = 'juggernautXL_v9.safetensors [c9e3e68f89]';

function judgeOf(overall, verdict) { return { scores: { prompt: overall, quality: overall, anatomy: overall - 1, artifacts: overall, composition: overall, character: null }, overall, min: overall - 1, verdict, good: ['clear subject'], bad: ['soft hands'], fixes: [{ type: 'steps', delta: 6, why: 'more detail' }, { type: 'adetailer', target: 'face' }], promptEdits: { add: ['sharp focus'], remove: [], front: [] }, by: 'claude-code', byLabel: 'Claude Code (on this PC)', seconds: 21 }; }

function stub() {
  const calls = [];
  let recipes = [
    { id: 'starter-sdxl-portrait', name: 'Realistic portrait — SDXL (starter)', starter: true, family: 'SDXL', short: '832×1216 · DPM++ 2M Karras', description: 'starter' },
    { id: 'r-ferry', name: 'Ferry look', starter: false, family: 'SD1.5', short: '512×768', description: '' },
  ];
  let defaultId = '';
  let judgeSet = { order: ['claude-code', 'pane', 'local'], enabled: { 'claude-code': true, pane: true, local: true }, paneSite: 'claude', bar: 7.5, rounds: 3, autoBook: false };
  let quality = { bookCheckpoint: '', bookRecipe: '' };
  const handlers = {};
  const recs = {
    '/out/images/sd-1.png': { prompt: 'odile woman, a ferryman, RAW photo, photorealistic', promptTyped: 'odile woman, a ferryman', style: 'photo', negativePrompt: 'lowres, cartoon', negativeAuto: true, checkpoint: SD15, family: 'SD1.5', checkpointHash: '879db523c3', steps: 26, cfgScale: 6.5, width: 512, height: 768, seed: 1234, sampler: 'DPM++ 2M', scheduler: 'Karras', loras: [{ name: 'odile_face', weight: 0.6, hash: 'abcdef1234' }], triggers: ['odile woman'], backend: 'a1111', label: 'Forge', engine: 'sd', askedBy: { who: 'you', from: 'images-tab' }, appVersion: '1.0.0', createdAt: '2026-11-08T10:00:00Z' },
  };
  const sd = {
    status: async () => ({ ok: true, enabled: true, endpoint: 'http://127.0.0.1:7860/sdapi/v1/txt2img', backend: 'a1111', base: 'http://127.0.0.1:7860', label: 'Forge', model: 'dreamshaper_8', steps: 20, cfgScale: 7, width: 512, height: 768, batchSize: 1, seed: -1 }),
    connect: async () => ({ ok: true, kind: 'a1111', label: 'Forge', port: 7860, model: 'dreamshaper_8', message: 'Connected to Forge on :7860' }),
    lists: async () => ({ ok: true, backend: 'a1111', checkpoints: [{ name: SD15, title: SD15 }, { name: XL, title: XL }], loras: [{ name: 'odile_face', alias: 'odile_face' }], samplers: ['Euler a', 'DPM++ 2M'], schedulers: ['Automatic', 'Karras'], vaes: ['Automatic'], embeddings: [], current: { checkpoint: SD15 } }),
    check: async () => ({ ok: true, warnings: [] }),
    generate: async (req) => { calls.push(['generate', req]); return { ok: true, seed: 1234, warnings: [], settings: Object.assign({}, recs['/out/images/sd-1.png']), images: [{ path: '/out/images/sd-1.png', url: 'file:///out/images/sd-1.png', seed: 1234 }] }; },
    progress: async () => ({ ok: true, busy: false }),
    gallery: async () => ({ ok: true, items: [] }),
    record: async (p) => (recs[p] ? { ok: true, record: recs[p] } : { ok: false }),
    libList: async () => ({ ok: true, items: [{ id: 'lora:odile_face', kind: 'lora', name: 'odile_face', base: 'SD1.5', triggerWords: ['odile woman'], tags: [], collections: [], onDisk: true }, { id: 'checkpoint:dreamshaper_8', kind: 'checkpoint', name: 'dreamshaper_8', base: 'SD1.5', onDisk: true }, { id: 'checkpoint:juggernautxl_v9', kind: 'checkpoint', name: 'juggernautXL_v9', base: 'SDXL', onDisk: true }], total: 3, collections: [], tags: [], folders: [] }),
    locks: async () => ({ ok: true, locks: [] }),
    targets: async () => ({ ok: true, targets: [], runner: { phase: 'idle' }, install: { installed: false } }),
    extras: async () => ({ ok: true, backend: 'a1111', upscalers: ['Latent'], upscaleModels: ['None'], controlnet: null, adetailer: { models: ['face_yolov8n.pt', 'hand_yolov8n.pt'] }, styles: [], scripts: null, optionKeys: [], workflows: [] }),
    quality: async (patch) => { calls.push(['quality', patch]); if (patch && 'bookRecipe' in patch) quality = { bookCheckpoint: '', bookRecipe: patch.bookRecipe }; else if (patch && 'bookCheckpoint' in patch) quality = { bookCheckpoint: patch.bookCheckpoint, bookRecipe: '' }; return Object.assign({ ok: true }, quality); },
    chatgptStatus: async () => ({ ok: true, ready: false }),
    recipes: async (op, a) => {
      calls.push(['recipes', op, a]);
      if (op === 'list') return { ok: true, recipes, defaultId };
      if (op === 'get') {
        if (a.id === 'r-ferry') return { ok: true, recipe: { id: 'r-ferry', name: 'Ferry look', family: 'SD1.5', promptTemplate: '{subject}, soft window light', settings: { checkpoint: SD15, steps: 31, cfgScale: 6, width: 512, height: 768, sampler: 'DPM++ 2M', scheduler: 'Karras', style: 'photo', negativeMode: 'auto', loras: [{ name: 'odile_face', weight: 0.5 }], hires: { scale: 1.5, denoise: 0.4, upscaler: 'Latent' }, adetailer: [{ model: 'face_yolov8n.pt', denoise: 0.35 }] } } };
        return { ok: true, recipe: { id: a.id, name: 'Realistic portrait — SDXL (starter)', starter: true, family: 'SDXL', promptTemplate: '{subject}, head and shoulders portrait', settings: { steps: 28, cfgScale: 5.5, width: 832, height: 1216, sampler: 'DPM++ 2M', scheduler: 'Karras', style: 'photo', negativeMode: 'auto' } } };
      }
      if (op === 'save') { const r = { id: 'r-new', name: a.recipe.name, settings: a.recipe.settings, promptTemplate: a.recipe.promptTemplate || '' }; recipes = recipes.concat([{ id: 'r-new', name: r.name, starter: false, short: '' }]); return { ok: true, created: true, recipe: r }; }
      if (op === 'rename') { recipes = recipes.map((x) => (x.id === a.id ? Object.assign({}, x, { name: a.name }) : x)); return { ok: true, recipe: { id: a.id, name: a.name } }; }
      if (op === 'delete') { recipes = recipes.filter((x) => x.id !== a.id); return { ok: true, deleted: a.id }; }
      if (op === 'setDefault') { defaultId = a.id; return { ok: true, defaultId }; }
      if (op === 'fromPicture') { recipes = recipes.concat([{ id: 'r-pic', name: a.name, starter: false }]); return { ok: true, recipe: { id: 'r-pic', name: a.name } }; }
      return { ok: false };
    },
    judge: async (p) => { calls.push(['judge', p]); return { ok: true, judge: judgeOf(6, 'fix'), say: 'This one is a good start but needs some changes (6/10, judged by Claude Code (on this PC)).' }; },
    improve: async (p, rounds) => {
      calls.push(['improve', p, rounds]);
      if (handlers.judge) { handlers.judge({ kind: 'improve', phase: 'making', round: 2, rounds: 3, changed: ['steps 26 → 32'] }); handlers.judge({ kind: 'improve', phase: 'judged', round: 2, rounds: 3, result: { round: 2, path: '/out/images/r2.png', url: 'file:///out/images/r2.png', overall: 7.2, verdict: 'fix', changed: ['steps 26 → 32'] } }); }
      return { ok: true, best: 2, stopReason: 'passed', say: 'Round 3 passed (8.6/10).', defaultsChanged: false, rounds: [
        { round: 1, path: p, url: 'file:///out/images/sd-1.png', overall: 6, verdict: 'fix', judge: judgeOf(6, 'fix'), changed: [] },
        { round: 2, path: '/out/images/r2.png', url: 'file:///out/images/r2.png', overall: 7.2, verdict: 'fix', judge: judgeOf(7.2, 'fix'), changed: ['steps 26 → 32', 'ADetailer face on'] },
        { round: 3, path: '/out/images/r3.png', url: 'file:///out/images/r3.png', overall: 8.6, verdict: 'keep', judge: judgeOf(8.6, 'keep'), changed: ['prompt: added “sharp focus”'] }] };
    },
    improveStop: async () => { calls.push(['improveStop']); return { ok: true }; },
    makeBest: async (req, count) => { calls.push(['makeBest', req, count]); return { ok: true, best: 2, say: 'Picture 3 of 4 is the best (8.1/10).', images: [1, 2, 3, 4].map((i) => ({ path: `/out/images/b${i}.png`, url: `file:///out/images/b${i}.png`, seed: 100 + i, overall: [6, 7, 8.1, 5][i - 1], judge: judgeOf([6, 7, 8.1, 5][i - 1], 'fix') })) }; },
    judgeSettings: async (patch) => { calls.push(['judgeSettings', patch]); if (patch && Object.keys(patch).length) { judgeSet = Object.assign({}, judgeSet, patch, patch.enabled ? { enabled: Object.assign({}, judgeSet.enabled, patch.enabled) } : {}); } return Object.assign({ ok: true }, judgeSet); },
    judgeStatus: async () => ({ ok: true, next: 'pane', nextLabel: 'Claude (web pane)', judges: { 'claude-code': { ok: false, why: 'Claude Code is not installed on this PC' }, pane: { ok: true }, local: { ok: false, why: 'Ollama is not running' } } }),
    formReport: async (f) => { calls.push(['formReport', f]); return { ok: true }; },
    onJudge: (cb) => { handlers.judge = cb; },
    onFormApply: (cb) => { handlers.form = cb; },
    onRunner: () => {}, onInstall: () => {}, onConnected: () => {},
  };
  return { sd, calls, handlers };
}

async function load() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'controls.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/controls.html', pretendToBeVisual: true });
  const h = stub();
  dom.window.api = new Proxy({ sd: h.sd, akoweTab: async () => ({}) }, { get(t, k) { if (k in t) return t[k]; if (typeof k === 'string' && /^on[A-Z]/.test(k)) return () => {}; return async () => ({}); } });
  dom.window.api.sd = new Proxy(h.sd, { get(t, k) { if (k in t) return t[k]; if (typeof k === 'string' && /^on[A-Z]/.test(k)) return () => {}; return async () => ({ ok: false }); } });
  dom.window.confirm = () => true;
  for (const f of ['sd-record.js', 'sd-quality.js', 'images-studio.js']) dom.window.eval(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
  const d = dom.window.document;
  const t = Object.assign(h, { dom, d, $: (id) => d.getElementById(id), click: (el) => (typeof el === 'string' ? d.getElementById(el) : el).dispatchEvent(new dom.window.Event('click', { bubbles: true })), fire: (el, type) => el.dispatchEvent(new dom.window.Event(type, { bubbles: true })) });
  t.click('tab-app-images');
  await tick(250);
  return t;
}
const last = (t, name) => { const g = t.calls.filter((c) => c[0] === name); return g.length ? g[g.length - 1] : null; };

(async () => {
  const t = await load();
  console.log('== 💾 the recipe picker ==');
  const opts = [...t.$('sd-recipe').options].map((o) => o.textContent);
  assert(opts[0] === '— my own settings —' && opts.includes('Ferry look') && opts.includes('Realistic portrait — SDXL (starter)'), 'the Recipe dropdown at the top of the form lists my recipes and the starter ones');
  assert([...t.$('sd-recipe').querySelectorAll('optgroup')].map((g) => g.label).join('|') === 'My recipes|Starter recipes (a good beginning)', 'grouped: my recipes, then the starters');
  assert(t.$('sd-recipe-row').querySelectorAll('button.sd-mini').length === 4 && t.$('btn-sd-recipe-rename').disabled && t.$('btn-sd-recipe-delete').disabled, 'four small buttons (💾 ✏ 🗑 ⭐); ✏ / 🗑 off until a recipe is chosen');
  assert(t.$('sd-form').firstElementChild.id === 'sd-recipe-row' || t.$('sd-form').querySelector('#sd-recipe-row') === t.$('sd-form').children[0], 'the picker is the first row of the form');
  t.$('sd-recipe').value = 'r-ferry'; t.fire(t.$('sd-recipe'), 'change');
  await tick(80);
  assert(t.$('sd-steps').value === '31' && t.$('sd-cfg').value === '6' && t.$('sd-sampler').value === 'DPM++ 2M' && t.$('sd-scheduler').value === 'Karras' && t.$('sd-checkpoint').value === SD15, 'choosing a recipe fills the form: steps, CFG, sampler, scheduler, checkpoint');
  assert(t.$('sd-hr-on').checked && t.$('sd-hr-scale').value === '1.5' && t.$('sd-ad-on').checked && t.d.querySelectorAll('#sd-lora-chips .sd-chip').length === 1 && t.d.querySelector('#sd-style-row [data-style="photo"]').getAttribute('aria-pressed') === 'true', '… hires fix, ADetailer, the LoRA and the style chip');
  assert(/Loaded “Ferry look”/.test(t.$('sd-recipe-note').textContent) && /soft window light/.test(t.$('sd-recipe-note').textContent) && !t.$('btn-sd-recipe-rename').disabled, 'it says so (and shows its prompt template); ✏ / 🗑 / ⭐ come on');
  t.$('sd-prompt').value = 'odile woman, a ferryman'; t.fire(t.$('sd-prompt'), 'input');
  t.click('btn-sd-generate');
  await tick(120);
  const g = last(t, 'generate')[1];
  assert(/^odile woman, a ferryman, soft window light/.test(g.prompt) && g.promptTyped === 'odile woman, a ferryman' && g.recipeUsed === 'r-ferry' && g.triggers.includes('odile woman') && g.steps === 31, 'Generate: the recipe template wraps the words; what was typed, the trigger words and the recipe go with it (for the sidecar)');
  console.log('== Settings used + 🧑‍⚖️ Judge ==');
  assert(!t.$('btn-sd-judge').disabled && !t.$('btn-sd-improve').disabled && !t.$('btn-sd-save-recipe').disabled, 'the picture has 🧑‍⚖️ Judge, 🔁 Make it better and 💾 Save as recipe');
  const dts = [...t.d.querySelectorAll('#sd-used-list dt')].map((x) => x.textContent);
  assert(dts.includes('What you asked for') && dts.includes('Seed (the number that makes this exact picture)') && dts.includes('LoRAs (add-on styles / faces)') && dts.includes('Asked by'), `"Settings used" lists every setting in plain words (${dts.length} rows)`);
  assert(/automatic default/.test(t.$('sd-used-list').textContent) && /hash abcdef1234/.test(t.$('sd-used-list').textContent), '… incl. that the negative was automatic and the LoRA hash');
  t.click('btn-sd-judge');
  await tick(80);
  const jb = t.$('sd-judge-box');
  assert(last(t, 'judge')[1] === '/out/images/sd-1.png' && !jb.hidden && /Good start — fix it · 6\/10/.test(jb.textContent) && jb.querySelectorAll('.sd-jbar').length === 5, 'Judge: the verdict and a bar per score');
  assert(/clear subject/.test(jb.textContent) && /soft hands/.test(jb.textContent) && /steps \+6 — more detail/.test(jb.textContent) && /fix the face \(ADetailer\)/.test(jb.textContent) && /add to the prompt: sharp focus/.test(jb.textContent), '… what is good, what is bad and what to change, in plain words');
  assert(/judged by Claude Code \(on this PC\) in 21 s/.test(jb.textContent) && /good start/.test(t.$('sd-msg').textContent), '… which judge was used; the message says it plainly');
  assert(/one AI answer/.test(t.$('btn-sd-judge').title) && /one AI answer per round/.test(t.$('btn-sd-improve').title) && /4 AI answers/.test(t.$('sd-make-best').parentNode.title), 'the tooltips say each judgement uses AI usage');
  console.log('== 🔁 Make it better ==');
  t.click('btn-sd-improve');
  await tick(120);
  const strip = t.$('sd-improve-strip');
  assert(last(t, 'improve')[2] === 3 && !t.$('sd-improve-box').hidden && strip.querySelectorAll('.sd-round').length === 3, 'Make it better: a strip of 3 rounds');
  assert(strip.querySelector('.sd-round[data-best="1"]') && /Round 3: 8\.6\/10 ✔ ★ best/.test(strip.querySelector('.sd-round[data-best="1"]').textContent) && /changed: steps 26 → 32; ADetailer face on/.test(strip.children[1].textContent), 'each round with its score and what changed; the best is marked');
  assert(!t.$('sd-improve-actions').hidden && /Round 3 passed/.test(t.$('sd-improve-msg').textContent), '✔ Keep this one / 💾 Save these settings as a recipe appear when it is done');
  t.click(strip.children[1]);
  await tick(30);
  assert(t.$('sd-preview').src.endsWith('r2.png') && strip.children[1].getAttribute('aria-selected') === 'true', 'clicking a round shows it');
  t.click('btn-sd-improve-recipe');
  await tick(20);
  assert(!t.$('sd-recipe-name-row').hidden && t.$('sd-recipe-template').hidden === false, 'Save these settings as a recipe → the name box');
  t.$('sd-recipe-name').value = 'Round 2 look';
  t.click('btn-sd-recipe-name-ok');
  await tick(60);
  assert(last(t, 'recipes')[1] === 'list' && t.calls.some((c) => c[0] === 'recipes' && c[1] === 'fromPicture' && c[2].path === '/out/images/r2.png' && c[2].name === 'Round 2 look'), '… it saves the chosen round\'s settings (only when pressed — never by itself)');
  t.click('btn-sd-improve-keep');
  await tick(30);
  assert(/Kept round 2/.test(t.$('sd-msg').textContent), '✔ Keep this one makes it the result');
  console.log('== Make 4, pick the best ==');
  t.$('sd-make-best').checked = true;
  t.click('btn-sd-generate');
  await tick(120);
  const mb = last(t, 'makeBest');
  assert(mb && mb[2] === 4 && mb[1].prompt && strip.querySelectorAll('.sd-round').length === 4 && /Picture 3: 8\.1\/10/.test(strip.querySelector('[data-best="1"]').textContent), '"Make 4, pick the best": 4 pictures judged, picture 3 marked best');
  t.$('sd-make-best').checked = false;
  console.log('== 💾 save / rename / default / delete ==');
  t.click('btn-sd-recipe-save');
  t.$('sd-recipe-name').value = 'Lighthouse nights'; t.$('sd-recipe-template').value = '{subject}, night';
  t.click('btn-sd-recipe-name-ok');
  await tick(60);
  const sv = t.calls.find((c) => c[0] === 'recipes' && c[1] === 'save');
  assert(sv && sv[2].recipe.name === 'Lighthouse nights' && sv[2].recipe.replace === true && sv[2].recipe.settings.steps === 31 && sv[2].recipe.settings.loras[0].name === 'odile_face' && sv[2].recipe.promptTemplate === '{subject}, night' && !('prompt' in sv[2].recipe.settings), '💾 saves the form\'s settings (no prompt text), with the template');
  assert(t.$('sd-recipe').value === 'r-new' && /Saved the recipe “Lighthouse nights”/.test(t.$('sd-recipe-note').textContent), 'the new recipe is chosen and it says so');
  t.click('btn-sd-recipe-rename');
  t.$('sd-recipe-name').value = 'Lighthouse at night';
  t.click('btn-sd-recipe-name-ok');
  await tick(60);
  assert(t.calls.some((c) => c[0] === 'recipes' && c[1] === 'rename' && c[2].name === 'Lighthouse at night'), '✏ renames');
  t.click('btn-sd-recipe-default');
  await tick(60);
  assert(t.calls.some((c) => c[0] === 'recipes' && c[1] === 'setDefault' && c[2].id === 'r-new') && /⭐/.test(t.$('sd-recipe').selectedOptions[0].textContent), '⭐ makes it the default (marked in the list)');
  t.click('btn-sd-recipe-delete');
  await tick(60);
  assert(t.calls.some((c) => c[0] === 'recipes' && c[1] === 'delete' && c[2].id === 'r-new') && t.$('sd-recipe').value === '', '🗑 deletes (after asking)');
  console.log('== 📖 Book pictures use: <checkpoint or recipe> ==');
  const book = t.$('sd-book-checkpoint');
  assert([...book.querySelectorAll('optgroup option')].some((o) => o.value === 'recipe:r-ferry'), 'the list has the recipes too');
  book.value = 'recipe:r-ferry'; t.fire(book, 'change');
  await tick(40);
  assert(last(t, 'quality')[1].bookRecipe === 'r-ferry' && /recipe “Ferry look”/.test(t.$('sd-book-note').textContent), 'choosing a recipe saves it and says so');
  console.log('== 🧑‍⚖️ judge settings ==');
  t.$('sd-sec-judge').open = true; t.$('sd-sec-judge').dispatchEvent(new t.dom.window.Event('toggle'));
  await tick(80);
  assert(t.d.querySelectorAll('#sd-judge-order [role=listitem]').length === 3 && /Next judge: Claude \(web pane\)/.test(t.$('sd-judge-status').textContent) && /not installed/.test(t.$('sd-judge-status').textContent), 'the judges in order, on/off, and which one is ready (and why not)');
  const cbs = t.d.querySelectorAll('#sd-judge-order input[type=checkbox]');
  cbs[2].checked = false; t.fire(cbs[2], 'change');
  await tick(40);
  assert(last(t, 'judgeSettings')[1].enabled.local === false, 'switching a judge off saves it');
  t.d.querySelectorAll('#sd-judge-order button')[0].click();
  await tick(40);
  assert(last(t, 'judgeSettings')[1].order.join() === 'pane,claude-code,local', '▲ moves a judge earlier');
  t.$('sd-judge-autobook').checked = true; t.fire(t.$('sd-judge-autobook'), 'change');
  await tick(40);
  assert(last(t, 'judgeSettings')[1].autoBook === true && /costs AI usage/.test(t.$('sd-judge-autobook').parentNode.title), '"Judge and improve book pictures automatically" (off by default, it says it costs AI usage)');
  console.log('== 🎩 Alfred changes the form ==');
  t.handlers.form({ patch: { steps: 44, style: 'cinematic', aspect: 'landscape', hires: false, seed: 77, loras: [] }, how: 'set' });
  await tick(60);
  assert(t.$('sd-steps').value === '44' && t.d.querySelector('#sd-style-row [data-style="cinematic"]').getAttribute('aria-pressed') === 'true' && !t.$('sd-hr-on').checked && t.$('sd-seed').value === '77' && t.d.querySelectorAll('#sd-lora-chips .sd-chip').length === 0, 'an approved images.form.set fills the fields (steps, style, size, hires off, seed, no LoRAs)');
  if (process.env.IMGJ_DEBUG) console.log('MSG', JSON.stringify(t.$('sd-msg').textContent));
  assert(/🎩 Alfred changed the form: /.test(t.$('sd-msg').textContent) && /steps/.test(t.$('sd-msg').textContent) && /style/.test(t.$('sd-msg').textContent), '… and the person sees what Alfred changed');
  await tick(500);
  const fr = last(t, 'formReport');
  assert(fr && fr[1].steps === 44 && fr[1].engine === 'sd' && !('initImage' in fr[1]), 'the form reports what it shows (so Alfred can read it)');
  console.log('== ♻ Remake brings back the typed words and the style ==');
  t.d.querySelector('#sd-style-row [data-style="cinematic"]').click();
  await t.dom.window.eval('Promise.resolve()');
  t.click('btn-sd-generate');
  await tick(120);
  t.handlers.form({ patch: { prompt: '' }, how: 'set' });
  t.click('btn-sd-remake');
  await tick(40);
  if (process.env.IMGJ_DEBUG) console.log('RM', JSON.stringify([t.$('sd-prompt').value, t.$('sd-negative').value, t.$('sd-seed').value, t.d.querySelector('#sd-style-row [aria-pressed="true"]') && t.d.querySelector('#sd-style-row [aria-pressed="true"]').dataset.style, t.$('btn-sd-remake').disabled]));
  assert(t.$('sd-prompt').value === 'odile woman, a ferryman' && t.d.querySelector('#sd-style-row [data-style="photo"]').getAttribute('aria-pressed') === 'true' && t.$('sd-negative').value === '' && t.$('sd-seed').value === '1234', 'Remake puts back what was typed, the style chip (so the same words are sent), the automatic negative and the seed');
  t.dom.window.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
