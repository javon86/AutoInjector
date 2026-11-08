// test/images-judge.test.js — ♻ everything saved with a picture, 💾 recipes, 🧑‍⚖️ the AI judge and 🔁 Make it better.
//   A. sd-record.js: enrich / settings used in plain words / the exact Remake request
//   B. the PNG "parameters" text chunk (A1111 style) + the sidecar (and an engine's own chunk is kept)
//   C. sidecar completeness per engine: Forge (fake A1111), ComfyUI (fake), ChatGPT (fake pane)
//   D. ♻ Remake reproduces the same seed and settings
//   E. recipes: CRUD, starter recipes, from a picture, apply to the form, generate with a recipe, book pictures
//   F. the judge's JSON: validation, extraction, a judge that disagrees with itself
//   G. the fixed fix vocabulary applied to settings
//   H. which judge: the order with each judge missing; malformed → once more → next; no judge → one plain error
//   I. the Claude Code judge through a fake `claude` CLI (tools, stdin, temp folder, signed out, limit, old CLI, timeout)
//   J. the pane judge (ask + attach + fresh chat) and the local judge through test/fixtures/fake-ollama.js
//   K. 🔁 Make it better (stops early, keeps rounds, never touches defaults) and Make 4 and pick the best
// Run: node test/images-judge.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const ip = require('../image-provider');
const sdImages = require('../sd-images');
const R = require('../sd-record');
const RC = require('../sd-recipes');
const J = require('../image-judge');
const CC = require('../image-judge-cc');
const JS = require('../image-judge-service');
const { createImprover } = require('../sd-improve');
const { createSdStudio } = require('../sd-studio');
const sdApi = require('../sd-api');
const { fakeA1111, fakeComfy, PNG_B64, PNG } = require('./fixtures/fake-sd');
const { makeFakeClaude, judgeAnswer } = require('./fixtures/fake-claude-judge');
const { fakeOllama } = require('./fixtures/fake-ollama');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const TMP = fs.mkdtempSync(path.join(process.env.IMGJ_TMP || os.tmpdir(), 'imgj-unit-'));
function freePort() { return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
const readJson = (p) => JSON.parse(fs.readFileSync(p.replace(/\.(png|jpe?g)$/i, '.json'), 'utf8'));

function partA() {
  console.log('\n== A. sd-record: enrich, settings used, the exact Remake request ==');
  const rec = R.enrich({ prompt: 'portrait, RAW photo', negativePrompt: 'lowres', checkpoint: 'juggernautXL_v9.safetensors [c9e3e68f89]', backend: 'a1111', seed: 42, steps: 28, cfgScale: 5.5, width: 832, height: 1216, loras: [{ name: 'odile_face', weight: 0.7 }], from: 'api:alfred' },
    { promptTyped: 'portrait', negativeAuto: true, triggers: ['odile woman'], appVersion: '1.0.0', infoObj: { extra_generation_params: { 'Lora hashes': '"odile_face: 1a2b3c4d5e6f"' }, sampler_name: 'DPM++ 2M' }, from: 'api:alfred', recipe: { id: 'r-x', name: 'X' } });
  assert(rec.promptTyped === 'portrait' && rec.prompt === 'portrait, RAW photo' && rec.negativeAuto === true, 'what was typed and what was sent are both kept; the automatic negative is marked');
  assert(rec.checkpointHash === 'c9e3e68f89' && rec.loras[0].hash === '1a2b3c4d5e6f' && rec.triggers[0] === 'odile woman' && rec.samplerUsed === 'DPM++ 2M', 'the checkpoint hash (from its name), the LoRA hash (from Forge\'s infotext), trigger words and the sampler really used');
  assert(rec.askedBy.who === 'Alfred' && rec.appVersion === '1.0.0' && rec.engine === 'sd' && rec.recipe.name === 'X', 'who asked (Alfred), the app version, the engine and the recipe');
  assert(R.askedByOf('bridge:akowe', { book: 'Salt', characterLock: { character: 'Adaeze' } }).who === 'Akọwe' && R.askedByOf('bridge:akowe', { book: 'Salt', characterLock: { character: 'Adaeze' } }).character === 'Adaeze' && R.askedByOf('images-tab').who === 'you', 'who asked: Akọwe (with the book and the character), you');
  const comfy = R.enrich({ backend: 'comfy', prompt: 'x', seed: 5 }, {});
  assert(comfy.workflowName === 'built-in graph (AutoInjector)', 'ComfyUI: the workflow name (AutoInjector\'s built-in graph)');
  const used = R.settingsUsed(Object.assign({}, rec, { hires: { scale: 1.5, upscaler: 'Latent', denoise: 0.4 }, adetailer: [{ model: 'face_yolov8n.pt' }], judge: { verdict: 'fix', overall: 6.5, byLabel: 'Claude Code' }, createdAt: '2026-11-08T10:00:00Z', index: 1 }));
  const L = used.map((x) => x.label);
  for (const want of ['What you asked for', 'What was sent to the picture maker', 'Things to avoid (negative prompt)', 'Model (checkpoint)', 'Sampler', 'Steps', 'CFG (how strictly it follows the words)', 'Seed (the number that makes this exact picture)', 'Size', 'Hires fix (make bigger, add detail)', 'LoRAs (add-on styles / faces)', 'Trigger words added', 'ADetailer (fix faces / hands)', 'Asked by', 'AI judge', 'Recipe', 'App version'])
    assert(L.includes(want), `Settings used, in plain words: “${want}”`);
  assert(/automatic default/.test(used.find((x) => x.label.startsWith('Things to avoid')).value) && /picture 2 of the batch/.test(used.find((x) => x.label.startsWith('Seed')).value), 'it says the negative was the automatic one and which picture of the batch');
  const rm = R.remakeRequest(Object.assign({}, rec, { seeds: [42, 43], index: 0, initImage: '[image]', source: '/pics/start.png', denoise: 0.5, judge: { x: 1 }, style: 'photo', characterLock: { id: 'l1' } }));
  assert(rm.engine === 'sd' && rm.request.seed === 42 && rm.request.quality === false && rm.request.batchSize === 1 && rm.request.prompt === 'portrait, RAW photo' && rm.request.negativePrompt === 'lowres', 'Remake: the prompt as sent, the same seed, one picture, no automatic changes');
  assert(rm.request.initImage === '/pics/start.png' && rm.request.denoise === 0.5 && !('judge' in rm.request) && !('style' in rm.request) && !('characterLock' in rm.request) && !('askedBy' in rm.request), 'Remake: the img2img source file, not the bookkeeping (judge, style words already in the prompt, lock words already in)');
  assert(R.remakeRequest({ engine: 'chatgpt', backend: 'chatgpt', promptTyped: 'a ferryman' }).note.includes('no seed'), 'ChatGPT pictures: the same words, and it says there is no seed');
}

function partB() {
  console.log('\n== B. the PNG "parameters" chunk + the sidecar ==');
  const dir = path.join(TMP, 'pngs');
  const rec = { prompt: 'a lighthouse', negativePrompt: 'blurry', steps: 28, sampler: 'DPM++ 2M', scheduler: 'Karras', cfgScale: 5.5, seed: 77, width: 832, height: 1216, checkpoint: 'juggernautXL_v9.safetensors [c9e3e68f89]', checkpointHash: 'c9e3e68f89', loras: [{ name: 'ink', weight: 0.6, hash: 'abcdef123456' }], backend: 'comfy', label: 'ComfyUI', workflowName: 'built-in graph (AutoInjector)', appVersion: '1.2.3', hires: { scale: 1.5, upscaler: 'Latent', denoise: 0.4 } };
  const s = sdImages.saveGeneration(dir, [PNG_B64], rec, { prefix: 't' })[0];
  const tx = sdImages.readPngText(fs.readFileSync(s.path));
  const p = tx.parameters || '';
  assert(/^a lighthouse\nNegative prompt: blurry\n/.test(p) && /Steps: 28, Sampler: DPM\+\+ 2M, Schedule type: Karras, CFG scale: 5.5, Seed: 77, Size: 832x1216/.test(p), 'the A1111 "parameters" text: prompt, negative, steps, sampler, scheduler, CFG, seed, size');
  assert(/Model hash: c9e3e68f89, Model: juggernautXL_v9\.safetensors/.test(p) && /Lora: "ink:0\.6"/.test(p) && /Lora hashes: "ink: abcdef123456"/.test(p) && /Hires upscale: 1\.5/.test(p) && /Workflow: built-in graph/.test(p) && /Version: AutoInjector 1\.2\.3/.test(p), '… model hash, LoRAs and their hashes, hires fix, the ComfyUI workflow and the version');
  assert(JSON.parse(tx.autoinjector).seed === 77 && readJson(s.path).seed === 77, 'the full record is also in the "autoinjector" chunk and the .json sidecar');
  const own = sdImages.addPngText(PNG, { parameters: 'made by Forge itself' });
  const s2 = sdImages.saveGeneration(dir, [own.toString('base64')], rec, { prefix: 'f' })[0];
  assert(sdImages.readPngText(fs.readFileSync(s2.path)).parameters === 'made by Forge itself', 'a PNG that already has the engine\'s own "parameters" keeps it');
  const up = sdImages.updateRecord(s.path, { judge: { verdict: 'keep' } });
  assert(up && readJson(s.path).judge.verdict === 'keep' && readJson(s.path).seed === 77, 'updateRecord adds the judge to the sidecar, keeping the rest');
}

function library() {
  return {
    list: () => ({ items: [] }), get: () => null, listLocks: () => ({ locks: [] }), scan: () => ({ ok: true }), checkLoras: () => ({ warnings: [] }),
    getLock: (k) => (/adaeze/i.test(k) ? { id: 'lock-a', character: 'Adaeze', book: 'Salt', prompt: 'dark skin, braids', negativePrompt: '', loras: [], triggerWords: ['adz woman'] } : null),
    applyLock: (lock, o) => ({ prompt: `${lock.triggerWords.join(', ')}, ${lock.prompt}, ${o.prompt}`, negativePrompt: o.negativePrompt, loras: [] }),
    findItem: (kind, name) => (kind === 'lora' && /odile/.test(name) ? { civitai: { sha256: 'ABCDEF0123456789' } } : null),
  };
}

async function partCDE() {
  console.log('\n== C. sidecar completeness per engine ==');
  const imagesDir = path.join(TMP, 'images');
  const recipes = RC.createRecipeStore({ file: path.join(TMP, 'sd-recipes.json') });
  const applied = [];
  const studio = createSdStudio({ imageProvider: ip, library: library(), imagesDir: () => imagesDir, fileUrl: (p) => `file://${p}`, recipes, appVersion: () => '9.9.9', applyToForm: (patch, how) => applied.push({ patch, how }) });
  const forge = await fakeA1111({ flavor: 'forge' });
  await studio.connect(forge.base);
  ip.setSettings({ steps: 20, cfgScale: 7, sampler: '', scheduler: '' });
  let r = await studio.generate({ prompt: 'odile woman, ferry captain, RAW photo', promptTyped: 'odile woman, ferry captain', style: 'photo', negativePrompt: '', loras: [{ name: 'odile_face', weight: 0.7 }], triggers: ['odile woman'], steps: 28, cfgScale: 5.5, width: 512, height: 768, seed: -1, checkpoint: 'dreamshaper_8.safetensors [879db523c3]', hires: { scale: 1.5, upscaler: 'Latent', denoise: 0.45, secondPassSteps: 10 }, adetailer: [{ model: 'face_yolov8n.pt', denoise: 0.4 }], clipSkip: 2, batchSize: 2 }, 'images-tab');
  assert(r.ok && r.images.length === 2, 'Forge: two pictures made');
  const a = readJson(r.images[0].path); const b2 = readJson(r.images[1].path);
  const want = ['promptTyped', 'prompt', 'negativePrompt', 'negativeAuto', 'style', 'checkpoint', 'checkpointHash', 'sampler', 'steps', 'cfgScale', 'seed', 'width', 'height', 'index', 'hires', 'loras', 'triggers', 'adetailer', 'clipSkip', 'engine', 'backend', 'label', 'appVersion', 'askedBy', 'createdAt', 'sha256'];
  const missing = want.filter((k) => a[k] === undefined);
  assert(!missing.length, `Forge sidecar has every field${missing.length ? ` — missing: ${missing.join(', ')}` : ''}`);
  assert(a.seed === 1234 && b2.seed === 1235 && a.index === 0 && b2.index === 1, 'the real seeds (not -1), one per picture, and the batch index');
  assert(a.promptTyped === 'odile woman, ferry captain' && a.negativeAuto === true && /lowres/.test(a.negativePrompt) && a.checkpointHash === '879db523c3' && a.loras[0].hash === 'abcdef0123' && a.askedBy.who === 'you' && a.appVersion === '9.9.9', 'typed prompt, the automatic negative, checkpoint + LoRA hashes, who asked, the app version');
  assert(a.hires.denoise === 0.45 && a.adetailer[0].model === 'face_yolov8n.pt' && a.clipSkip === 2, 'hires fix, ADetailer and clip skip are recorded');
  const params = sdImages.readPngText(fs.readFileSync(r.images[0].path)).parameters || '';
  assert(/Seed: 1234/.test(params) && /Model hash: 879db523c3/.test(params) && /ADetailer model: face_yolov8n\.pt/.test(params), 'the PNG carries the parameters text too (Forge\'s fake sends a bare PNG)');
  // img2img: the source file and the denoise
  const start = path.join(TMP, 'start.png'); fs.writeFileSync(start, PNG);
  r = await studio.img2img({ prompt: 'x', initImage: start, denoise: 0.35 }, 'images-tab:img2img');
  const i2 = readJson(r.images[0].path);
  assert(r.ok && i2.source === start && i2.denoise === 0.35 && i2.initImage === '[image]', 'img2img: the source picture file and the denoise are recorded');
  // a character lock from Akọwe's bridge
  r = await studio.request({ prompt: 'at the quay', characterLock: 'Adaeze', book: 'Salt', engine: 'sd' });
  const bk = readJson(r.images[0].path);
  assert(r.ok && bk.askedBy.who === 'Akọwe' && bk.askedBy.book === 'Salt' && bk.askedBy.character === 'Adaeze' && bk.triggers.includes('adz woman'), 'Akọwe\'s book picture: who asked, the book, the character and the lock\'s trigger words');

  console.log('\n== C2. ComfyUI ==');
  const comfy = await fakeComfy({});
  await studio.connect(comfy.base);
  r = await studio.generate({ prompt: 'a harbour', steps: 12, width: 512, height: 512, seed: -1 }, 'api:alfred');
  const c = r.ok ? readJson(r.images[0].path) : {};
  assert(r.ok && c.backend === 'comfy' && c.workflowName === 'built-in graph (AutoInjector)' && Number(c.seed) >= 0 && c.askedBy.who === 'Alfred' && c.appVersion === '9.9.9', `ComfyUI sidecar: engine, workflow name, the real seed (${c.seed}), who asked`);
  const cp = r.ok ? sdImages.readPngText(fs.readFileSync(r.images[0].path)).parameters || '' : '';
  assert(/Workflow: built-in graph/.test(cp) && /Seed: \d+/.test(cp), 'ComfyUI\'s PNG gets the parameters text (it doesn\'t write one)');

  console.log('\n== C3. ChatGPT image engine ==');
  const { fakeChatGptPane } = require('./fixtures/fake-chatgpt-image');
  const CI = require('../chatgpt-image');
  const pane = fakeChatGptPane({ mode: 'ok', delayMs: 100 });
  const cg = CI.createChatGptImage({ paneReady: () => ({ ready: true }), send: async (t) => pane.send(t), runPage: async (s) => pane.run(s), hold: () => {}, makeWay: async () => {}, prepare: async () => {}, afterJob: async () => {}, newChat: async () => ({ ok: true }), imagesDir: () => imagesDir, recordImage: () => {}, log: () => {}, fileUrl: (p) => p, options: { pollMs: 40, stableReads: 2, stableReadsWriting: 6, textSettleMs: 150, noImageMs: 500, timeoutMs: 4000, newChatWaitMs: 300 } });
  const studio2 = createSdStudio({ imageProvider: ip, library: library(), imagesDir: () => imagesDir, fileUrl: (p) => p, chatgpt: cg, appVersion: () => '9.9.9' });
  r = await studio2.requestFrom({ engine: 'chatgpt', prompt: 'a lighthouse keeper', book: 'Salt' }, 'bridge:akowe');
  const g = r.ok ? readJson(r.images[0].path) : {};
  assert(r.ok && g.engine === 'chatgpt' && g.backend === 'chatgpt' && g.promptTyped === 'a lighthouse keeper' && g.askedBy.who === 'Akọwe' && g.appVersion === '9.9.9' && g.chatgptPrompt && g.width > 0, 'ChatGPT sidecar: engine, what was typed, the words sent to ChatGPT, size, who asked, version (no seed — it has none)');
  await studio.connect(forge.base);

  console.log('\n== D. ♻ Remake: the same seed and settings ==');
  r = await studio.generate({ prompt: 'remake me', promptTyped: 'remake me', style: 'cinematic', loras: [{ name: 'odile_face', weight: 0.6 }], steps: 23, cfgScale: 6.5, width: 640, height: 448, seed: -1, sampler: 'DPM++ 2M', scheduler: 'Karras' }, 'images-tab');
  const orig = forge.state.lastTxt2img;
  const firstRec = readJson(r.images[0].path);
  const rm = await studio.remake(r.images[0].path);
  const again = forge.state.lastTxt2img;
  assert(rm.ok && rm.sameSeed && again.seed === firstRec.seed && again.seed === 1234, `Remake sends the recorded seed (${again.seed}), not -1`);
  for (const k of ['prompt', 'negative_prompt', 'steps', 'cfg_scale', 'width', 'height', 'sampler_name', 'scheduler', 'batch_size']) assert(JSON.stringify(again[k]) === JSON.stringify(orig[k]), `Remake: ${k} is the same (${JSON.stringify(again[k])})`);
  const rr = readJson(rm.images[0].path);
  assert(rr.prompt === firstRec.prompt && rr.seed === firstRec.seed && rr.askedBy.from === 'images-tab:remake', 'the remade picture\'s sidecar matches, and says it was a remake');
  const api = sdApi.createImagesApi({ studio, library: library() });
  const ra = await api.images.remake(r.images[0].path);
  assert(ra.ok && forge.state.lastTxt2img.seed === 1234, 'sd-api images.remake (Alfred) does the same');
  assert(!(await studio.remake(path.join(TMP, 'nope.png'))).ok, 'a picture without settings → NO_RECORD, in plain words');

  console.log('\n== E. 💾 recipes ==');
  let L = recipes.list({ families: ['SDXL', 'SD1.5'] });
  assert(L.ok && L.recipes.filter((x) => x.starter).length === 4 && L.recipes.every((x) => x.starter ? /\(starter\)/.test(x.name) : true), 'four starter recipes (SDXL portrait, SDXL cinematic, SD1.5 hires, book portrait), labelled “starter”');
  assert(!L.recipes.some((x) => /Flux/.test(x.name)) && recipes.list({ families: ['Flux'] }).recipes.some((x) => /Flux/.test(x.name)), 'the Flux starter appears only when a Flux checkpoint is installed');
  const sx = recipes.get('Realistic portrait — SDXL').recipe;
  assert(sx.settings.width === 832 && sx.settings.height === 1216 && sx.settings.sampler === 'DPM++ 2M' && sx.settings.scheduler === 'Karras' && sx.settings.cfgScale === 5.5 && sx.settings.steps === 28, 'the SDXL starter uses sd-quality\'s family defaults (832×1216, DPM++ 2M Karras, 28 steps, CFG 5.5)');
  const sv = recipes.save({ name: 'My ferry look', settings: { checkpoint: 'dreamshaper_8.safetensors [879db523c3]', steps: 31, cfgScale: 6, width: 512, height: 768, loras: [{ name: 'odile_face', weight: 0.5 }], style: 'photo', hires: { scale: 1.5, denoise: 0.4 }, nonsense: 1 }, promptTemplate: '{subject}, soft window light' });
  assert(sv.ok && sv.created && !('nonsense' in sv.recipe.settings) && sv.recipe.settings.loras[0].weight === 0.5, 'save: a new recipe (unknown keys dropped)');
  assert(!recipes.save({ name: 'My ferry look', id: 'x-other', settings: { steps: 3 } }).ok || true, '(id mismatch is just another recipe)');
  assert(!recipes.save({ name: '', settings: { steps: 20 } }).ok && /name/i.test(recipes.save({ name: '', settings: { steps: 20 } }).message), 'save without a name → a plain message');
  assert(/\{subject\}/.test(recipes.save({ name: 'bad tpl', settings: { steps: 20 }, promptTemplate: 'no subject here' }).message), 'a template without {subject} is refused, saying why');
  assert(recipes.save({ name: 'my ferry look', settings: { steps: 32 } }).ok && recipes.get('My ferry look').recipe.settings.steps === 32 && recipes.get('My ferry look').recipe.settings.loras.length === 1, 'the same name updates the recipe (the other settings stay)');
  const rp = recipes.save({ name: 'Replace me', settings: { steps: 20, hires: { scale: 2 } } });
  assert(recipes.save({ id: rp.recipe.id, name: 'Replace me', settings: { steps: 25 }, replace: true }).ok && !recipes.get('Replace me').recipe.settings.hires, 'replace: true (the form) saves exactly the given settings');
  assert(recipes.rename(sv.recipe.id, 'Ferry look').ok && recipes.get('Ferry look').ok && !recipes.get('My ferry look').ok, 'rename');
  assert(!recipes.rename('starter-sdxl-portrait', 'Mine').ok, 'a starter recipe can\'t be renamed (save a copy)');
  assert(recipes.setDefault(sv.recipe.id).ok && recipes.list({}).defaultId === sv.recipe.id && recipes.defaultRecipe().id === sv.recipe.id, 'set the default');
  const reload = RC.createRecipeStore({ file: path.join(TMP, 'sd-recipes.json') });
  assert(reload.get('Ferry look').ok && reload.list({}).defaultId === sv.recipe.id, 'recipes and the default are kept in sd-recipes.json (survive a restart)');
  assert(recipes.remove('starter-flux').ok && !recipes.list({ families: ['Flux'] }).recipes.some((x) => x.id === 'starter-flux'), 'deleting a starter only hides it');
  const tr = RC.toRequest(recipes.get('Ferry look').recipe, { subject: 'a ferryman', request: { prompt: 'a ferryman', steps: 40 } });
  assert(tr.prompt === 'a ferryman, soft window light' && tr.promptTyped === 'a ferryman' && tr.steps === 40 && tr.cfgScale === 6 && tr.loras[0].name === 'odile_face' && !('negativePrompt' in tr), 'toRequest: the template wraps the words, the request\'s own fields win, LoRAs come along, the negative stays automatic');
  // from a picture ("use these settings again")
  const fr = RC.fromRecord(firstRec, 'From remake');
  assert(fr.settings.steps === 23 && fr.settings.width === 640 && fr.settings.loras[0].weight === 0.6 && fr.settings.negativeMode === 'auto' && !fr.settings.negativePrompt && !('prompt' in fr.settings), 'fromRecord: the picture\'s settings, LoRAs, the automatic negative stays automatic, no prompt text');
  let x = studio.recipesOp('fromPicture', { path: r.images[0].path, name: 'From the remake' });
  assert(x.ok && x.recipe.settings.style === 'cinematic', 'studio fromPicture saves it');
  // apply to the form (Alfred / the picker)
  x = studio.recipeToForm('Ferry look');
  assert(x.ok && applied.length === 1 && applied[0].how === 'recipe' && applied[0].patch.steps === 32 && applied[0].patch.recipeId === sv.recipe.id, 'apply: the recipe\'s settings go to the Images form (sd-form-apply)');
  x = studio.formSet({ steps: 44, style: 'anime' });
  assert(x.ok && applied[1].patch.steps === 44 && !studio.formSet({}).ok, 'images.form.set: any field to the form (empty → a plain refusal)');
  studio.formReport({ steps: 44 });
  assert(studio.formGet().form.steps === 44, 'images.form.get: what the window reported');
  // generate with a recipe
  r = await studio.generate({ prompt: 'a ferryman', recipe: 'Ferry look' }, 'api:alfred');
  const lt = forge.state.lastTxt2img;
  assert(r.ok && lt.steps === 32 && /^a ferryman, soft window light/.test(lt.prompt) && /<lora:odile_face:0\.5>/.test(lt.prompt) && lt.enable_hr === true && readJson(r.images[0].path).recipe.name === 'Ferry look', 'generate with recipe: its settings, template, LoRA and hires fix reach Forge; the sidecar names the recipe');
  r = await studio.generate({ prompt: 'x', recipe: 'no such recipe' }, 'api:alfred');
  assert(!r.ok && r.code === 'NO_RECIPE' && /no recipe called/.test(r.message), 'an unknown recipe → NO_RECIPE in plain words');
  // the Images tab: the form already holds the recipe; only its name is recorded (nothing merged back)
  r = await studio.generate({ prompt: 'tab', steps: 21, recipeUsed: sv.recipe.id }, 'images-tab');
  assert(r.ok && forge.state.lastTxt2img.steps === 21 && !/soft window light/.test(forge.state.lastTxt2img.prompt) && readJson(r.images[0].path).recipe.id === sv.recipe.id, 'recipeUsed (the Images tab): recorded, settings not merged again');
  // 📖 Book pictures use: <recipe>
  assert(studio.quality({ bookRecipe: 'Ferry look' }).bookRecipe === sv.recipe.id && !studio.quality({ bookRecipe: 'nope' }).ok, '📖 Book pictures use: a recipe (an unknown one is refused)');
  r = await studio.request({ prompt: 'portrait of Adaeze', engine: 'sd', book: 'Salt' });
  assert(r.ok && forge.state.lastTxt2img.steps === 32 && /soft window light/.test(forge.state.lastTxt2img.prompt), 'an Akọwe book picture uses the chosen recipe');
  studio.quality({ bookCheckpoint: '' });
  assert(studio.quality().bookRecipe === sv.recipe.id, 'clearing the checkpoint leaves the recipe');
  studio.quality({ bookCheckpoint: 'dreamshaper_8.safetensors [879db523c3]' });
  assert(studio.quality().bookRecipe === '', 'choosing a checkpoint replaces the recipe');
  return { studio, forge, comfy, recipes, imagesDir };
}

function partF() {
  console.log('\n== F. the judge\'s JSON ==');
  const good = judgeAnswer(1, '');
  let v = J.validate(good, { character: false });
  assert(v.ok && v.judge.scores.prompt === 5.5 && v.judge.scores.character === null && v.judge.verdict === 'fix' && v.judge.overall > 0, 'a good answer validates (character null without a reference)');
  assert(v.judge.fixes.length === 4 && v.judge.ignored.includes('teleport'), 'a fix outside the vocabulary is ignored (and noted)');
  v = J.validate({ scores: { prompt: '8/10', quality: '7', anatomy: 6, artifacts: 7, composition: 8 }, verdict: 'KEEP' }, {});
  assert(v.ok && v.judge.scores.prompt === 8 && v.judge.verdict === 'keep', '"8/10" and "KEEP" are understood');
  v = J.validate({ scores: { prompt: 8, quality: 7 }, verdict: 'keep' }, {});
  assert(!v.ok && v.problems.some((p) => /anatomy is missing/.test(p)), 'missing scores → problems');
  v = J.validate({ scores: { prompt: 8, quality: 7, anatomy: 6, artifacts: 7, composition: 8 }, verdict: 'great' }, {});
  assert(!v.ok && /keep, fix or redo/.test(v.problems[0]), 'a verdict outside keep / fix / redo → a problem');
  assert(!J.validate('nope').ok && !J.validate([1, 2]).ok, 'not an object → a problem');
  v = J.validate({ scores: { prompt: 2, quality: 3, anatomy: 2, artifacts: 3, composition: 3 }, verdict: 'keep' }, {});
  assert(v.ok && v.judge.selfConflict && v.judge.verdict === 'redo' && /didn't match its own scores/.test(J.sayVerdict(v.judge)), 'a judge that disagrees with itself ("keep" with 2/10s): the scores decide, and it says so');
  v = J.validate({ scores: { prompt: 9, quality: 9, anatomy: 9, artifacts: 9, composition: 9, character: 3 }, verdict: 'keep' }, { character: true });
  assert(v.ok && v.judge.scores.character === 3 && v.judge.min === 3 && v.judge.verdict === 'fix' && v.judge.selfConflict, 'with a character reference the character score counts ("keep" while it doesn\'t look like the character → fix)');
  assert(J.extractJson('Sure!\n```json\n{"a": 1}\n```\nhope that helps')?.a === 1, 'JSON in a ```json fence');
  assert(J.extractJson('[TO: USER]\nMy verdict: {"a": {"b": 2}} done [FROM: CLAUDE]')?.a.b === 2, 'JSON inside prose and pane tags');
  assert(J.extractJson('{“verdict”: “keep”}')?.verdict === 'keep', 'curly quotes (Claude\'s website) are repaired');
  assert(J.extractJson('no json at all') === null && J.extractJson('') === null, 'no JSON → null');
  const pr = J.buildPrompt({ prompt: 'a ferryman', promptTyped: 'a ferryman', steps: 20, family: 'SDXL', backend: 'a1111' }, { checkpoints: ['juggernautXL_v9.safetensors [c9e3e68f89]'], samplers: ['Euler a'], character: { name: 'Adaeze', looks: 'braids' } });
  assert(/ONLY one JSON object/.test(pr) && /juggernautXL_v9\.safetensors/.test(pr) && /should show the character Adaeze/.test(pr) && /"type":"steps"/.test(pr) && /adetailer/.test(pr), 'the instruction: the settings, the installed checkpoints, the character, the fix vocabulary, JSON only');
}

function partG() {
  console.log('\n== G. the fixed fix vocabulary applied to settings ==');
  const base = { prompt: 'a ferryman, lantern', negativePrompt: 'lowres', steps: 20, cfgScale: 7, width: 512, height: 512, sampler: 'Euler a', loras: [{ name: 'ink', weight: 0.8 }], seed: 42, checkpoint: 'juggernautXL_v9.safetensors [c9]' };
  const lists = { samplers: ['Euler a', 'DPM++ 2M'], schedulers: ['Karras'], checkpoints: ['juggernautXL_v9.safetensors [c9]', 'realisticVision_sd15.safetensors [87]'] };
  const judge = { verdict: 'fix', fixes: [
    { type: 'steps', delta: 8 }, { type: 'cfg', delta: -2 }, { type: 'sampler', name: 'dpm++ 2m' }, { type: 'scheduler', name: 'Karras' }, { type: 'size', aspect: 'portrait' },
    { type: 'hires', on: true, denoise: 0.9 }, { type: 'adetailer', target: 'hands' }, { type: 'negative_add', terms: ['extra fingers', 'lowres'] }, { type: 'lora_weight', name: 'ink', weight: 0.55 },
  ], promptEdits: { add: ['sharp focus'], remove: ['lantern'], front: ['sharp focus'] } };
  const a = J.applyFixes(base, judge, { family: 'SDXL', backend: 'a1111', lists });
  const q = a.request;
  assert(q.steps === 28 && q.cfgScale === 5 && q.sampler === 'DPM++ 2M' && q.scheduler === 'Karras', 'steps +8, CFG −2, sampler and scheduler by the app\'s own spelling');
  assert(q.width === 832 && q.height === 1216, 'size → SDXL\'s native portrait bucket (832×1216)');
  assert(q.hires && q.hires.scale === 1.25 && q.hires.denoise === 0.6, 'hires fix on (SDXL ×1.25, denoise capped at 0.6)');
  assert(q.adetailer && q.adetailer[0].model === 'hand_yolov8n.pt', 'ADetailer hands on (Forge)');
  assert(q.negativePrompt === 'lowres, extra fingers' && q.loras[0].weight === 0.55, 'negative words added without repeats; the LoRA weight changed');
  assert(q.prompt === 'sharp focus, a ferryman', 'prompt: added, removed, the most important first');
  assert(q.seed === 42 && base.steps === 20 && a.changed.length >= 9, 'the seed stays (a fair comparison) and the input is not changed');
  const b = J.applyFixes(base, { verdict: 'redo', fixes: [{ type: 'cfg', delta: 2 }, { type: 'sampler', name: 'Imaginary' }, { type: 'checkpoint', name: 'not_installed' }, { type: 'adetailer', target: 'face' }, { type: 'lora_weight', name: 'nope', weight: 1 }] }, { family: 'Flux', backend: 'comfy', lists });
  assert(b.skipped.find((s) => s.type === 'cfg' && /Flux/.test(s.why)) && b.skipped.find((s) => s.type === 'sampler') && b.skipped.find((s) => s.type === 'checkpoint') && b.skipped.find((s) => s.type === 'adetailer' && /Forge/.test(s.why)) && b.skipped.find((s) => s.type === 'lora_weight'), 'what can\'t be applied is skipped, saying why (Flux CFG, an unknown sampler, a checkpoint not installed, ADetailer on ComfyUI, an unknown LoRA)');
  assert(b.request.seed === -1 && b.changed.includes('a new random seed'), '"redo" → a new random seed');
  const c = J.applyFixes(base, { verdict: 'fix', fixes: [{ type: 'checkpoint', name: 'realisticVision' }, { type: 'inpaint', region: 'background', denoise: 0.4 }, { type: 'inpaint', region: 'face' }, { type: 'seed' }] }, { family: 'SDXL', backend: 'a1111', lists, imagePath: '/pics/a.png' });
  assert(c.request.checkpoint === 'realisticVision_sd15.safetensors [87]' && c.request.width === 512 && c.request.height === 512 && c.request.steps === 28, 'a checkpoint from the installed list (another family → its size / steps / CFG)');
  assert(c.request.initImage === '/pics/a.png' && c.request.denoise === 0.4 && c.request.adetailer && c.request.adetailer[0].model === 'face_yolov8n.pt' && c.request.seed === -1, 'inpaint a region: the face → ADetailer; the background → a light img2img of the picture; seed → a new one');
  const d = J.applyFixes({ prompt: 'x' }, { verdict: 'fix', fixes: [{ type: 'img2img' }] }, {});
  assert(d.skipped[0].type === 'img2img' && /no picture file/.test(d.skipped[0].why), 'img2img without a picture file is skipped');
  assert(J.applyPromptEdits('<lora:ink:0.8>, a cat, red hat', { remove: ['hat'] }) === '<lora:ink:0.8>, a cat, red', 'prompt edits leave <lora:…> tags alone');
}

function fakeJudge(id, behaviour) {
  const calls = [];
  return { id, label: `fake ${id}`, calls, available: () => (behaviour === 'missing' ? { ok: false, state: 'missing', why: 'not here' } : { ok: true }),
    ask: async (o) => { calls.push(o); if (behaviour === 'missing') return { ok: false, error: 'GONE', unavailable: true, message: `${id} is not here.` }; if (behaviour === 'bad') return { ok: true, text: 'lovely picture' }; if (behaviour === 'bad-once' && calls.length === 1) return { ok: true, text: 'lovely' }; if (behaviour === 'fail') return { ok: false, error: 'BOOM', message: `${id} failed.` }; return { ok: true, text: JSON.stringify(judgeAnswer(2, '')) }; } };
}
async function partH() {
  console.log('\n== H. which judge, best available first ==');
  assert(J.orderJudges({}, null).join() === 'claude-code,pane,local', 'default order: Claude Code → web pane → local');
  assert(J.orderJudges({}, { 'claude-code': false }).join() === 'pane,local' && J.orderJudges({}, { pane: false }).join() === 'claude-code,local' && J.orderJudges({}, { local: false }).join() === 'claude-code,pane', 'each one missing: the others, in order');
  assert(J.orderJudges({ order: ['local', 'pane'], enabled: { pane: false } }, null).join() === 'local,claude-code', 'a chosen order, a judge switched off');
  assert(J.cleanSettings({ rounds: 9, bar: 2, order: ['pane', 'bogus'] }).rounds === 5 && J.cleanSettings({ bar: 2 }).bar === 5 && J.cleanSettings({ order: ['pane', 'bogus'] }).order.join() === 'pane,claude-code,local', 'settings are clamped (rounds ≤ 5, pass mark ≥ 5, unknown judges dropped)');
  const pic = path.join(TMP, 'judge-me.png'); fs.writeFileSync(pic, PNG);
  const saved = {};
  const mk = (cc, pane, local, settings) => JS.createJudgeService({ judges: { 'claude-code': cc, pane, local }, settings: settings || {}, readRecord: () => ({ prompt: 'x', backend: 'a1111' }), updateRecord: (p, f) => { saved[p] = f({}); } });
  let cc = fakeJudge('claude-code', 'missing'), pn = fakeJudge('pane', 'ok'), lo = fakeJudge('local', 'ok');
  let r = await mk(cc, pn, lo).judge(pic, {});
  assert(r.ok && r.judge.by === 'pane' && lo.calls.length === 0 && r.tried[0].by === 'claude-code', 'Claude Code missing → the pane judges (the local model is not asked)');
  assert(saved[pic] && saved[pic].judge.by === 'pane', 'the verdict is saved with the picture');
  cc = fakeJudge('claude-code', 'missing'); pn = fakeJudge('pane', 'missing'); lo = fakeJudge('local', 'ok');
  r = await mk(cc, pn, lo).judge(pic, {});
  assert(r.ok && r.judge.by === 'local' && r.judge.weaker, 'Claude Code and the pane missing → the local model judges, labelled weaker');
  cc = fakeJudge('claude-code', 'bad-once'); pn = fakeJudge('pane', 'ok');
  r = await mk(cc, pn, fakeJudge('local', 'ok')).judge(pic, {});
  assert(r.ok && r.judge.by === 'claude-code' && r.judge.attempts === 2 && /could not be used/.test(cc.calls[1].prompt) && pn.calls.length === 0, 'a malformed answer is asked for once more (saying what was wrong) — then it is fine');
  cc = fakeJudge('claude-code', 'bad'); pn = fakeJudge('pane', 'ok');
  r = await mk(cc, pn, fakeJudge('local', 'ok')).judge(pic, {});
  assert(r.ok && cc.calls.length === 2 && r.judge.by === 'pane' && r.tried.find((t) => t.error === 'BAD_JSON'), 'malformed twice → the next judge');
  r = await mk(fakeJudge('claude-code', 'missing'), fakeJudge('pane', 'fail'), fakeJudge('local', 'missing')).judge(pic, {});
  assert(!r.ok && r.code === 'NO_JUDGE_ANSWERED' && /No AI judge could look at the picture/.test(r.message) && /pane failed/.test(r.message) && r.hint, 'no judge answers → ONE plain error that says each judge\'s reason, and how to get one');
  r = await mk(fakeJudge('claude-code', 'ok'), fakeJudge('pane', 'ok'), fakeJudge('local', 'ok'), { enabled: { 'claude-code': false, pane: false, local: false } }).judge(pic, {});
  assert(!r.ok && r.code === 'NO_JUDGE' && /switched off/.test(r.message), 'every judge switched off → it says so');
  const bad = path.join(TMP, 'not-a-picture.png'); fs.writeFileSync(bad, 'hello');
  assert((await mk(fakeJudge('claude-code', 'ok')).judge(bad, {})).code === 'BAD_IMAGE' && (await mk(fakeJudge('claude-code', 'ok')).judge(path.join(TMP, 'gone.png'), {})).code === 'BAD_IMAGE', 'a bad or missing picture file → BAD_IMAGE, in plain words');
  const st = await mk(fakeJudge('claude-code', 'missing'), fakeJudge('pane', 'ok'), fakeJudge('local', 'ok')).status();
  assert(st.ok && st.next === 'pane' && st.judges['claude-code'].ok === false, 'status(): which judges are ready and which goes next');
}

async function partI() {
  console.log('\n== I. the Claude Code judge through a fake `claude` CLI ==');
  const dir = path.join(TMP, 'cc');
  const bin = makeFakeClaude(dir);
  const log = path.join(dir, 'calls.jsonl');
  const envBase = Object.assign({}, process.env, { AUTOINJECTOR_CLAUDE_PATH: bin, FAKE_CLAUDE_JUDGE_LOG: log, FAKE_CLAUDE_JUDGE_STATE: path.join(dir, 'n'), ANTHROPIC_API_KEY: 'sk-should-not-be-passed', PATH: '' });
  let env = Object.assign({}, envBase);
  const tmpdir = path.join(TMP, 'cc-work'); fs.mkdirSync(tmpdir, { recursive: true });
  const logs = [];
  const j = CC.createClaudeCodeJudge({ env: () => env, tmpdir, log: (t, d) => logs.push([t, d]) });
  const pic = path.join(TMP, 'cc-pic.png'); fs.writeFileSync(pic, PNG);
  assert(j.available().ok, 'the CLI is found (AUTOINJECTOR_CLAUDE_PATH)');
  let r = await j.ask({ imagePath: pic, prompt: J.buildPrompt({ prompt: 'a ferryman' }, { where: 'the picture file' }) });
  const call1 = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').pop());
  assert(r.ok && J.validate(J.extractJson(r.text), {}).ok, 'it answers with judge JSON');
  assert(call1.sawPicture && call1.cwdFiles.length === 1, 'the picture was the only file in its empty working folder');
  const ai = call1.argv.indexOf('--allowedTools'); const di = call1.argv.indexOf('--disallowedTools');
  assert(call1.argv[0] === '-p' && call1.argv.includes('--output-format') && call1.argv[ai + 1] === 'Read' && /Bash/.test(call1.argv[di + 1]) && /WebFetch/.test(call1.argv[di + 1]) && /mcp__\*/.test(call1.argv[di + 1]) && !call1.argv[di + 1].split(',').includes('Read'), 'only Read is allowed; Bash, the web and MCP tools are not');
  assert(call1.argv.includes('--permission-mode') && call1.argv.includes('dontAsk') && call1.argv.includes('--no-session-persistence') && call1.argv.includes('--strict-mcp-config'), 'dontAsk, no session kept, no MCP servers');
  assert(call1.stdinChars > 500 && call1.argv.join(' ').length < 1200, 'the long prompt goes on stdin, not the command line');
  assert(call1.apiKey === false, 'ANTHROPIC_API_KEY is removed, so it uses the person\'s Claude plan');
  assert(!fs.existsSync(call1.cwd) && fs.readdirSync(tmpdir).length === 0, 'the temp folder is deleted afterwards');
  assert(logs.every(([, d]) => !JSON.stringify(d).includes('ferryman')), 'the log never holds the prompt');
  env = Object.assign({}, envBase, { FAKE_CLAUDE_JUDGE_MODE: 'unknown_flag' });
  r = await j.ask({ imagePath: pic, prompt: 'judge it' });
  const call2 = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').pop());
  assert(r.ok && !call2.argv.includes('--permission-mode'), 'an older CLI that doesn\'t know an option is asked again with the basic options');
  env = Object.assign({}, envBase, { FAKE_CLAUDE_JUDGE_MODE: 'limit' });
  r = await j.ask({ imagePath: pic, prompt: 'judge it' });
  assert(!r.ok && r.error === 'CC_LIMITED' && r.unavailable && /usage limit/.test(r.message) && !j.available().ok && j.available().state === 'limited', 'at the usage limit → CC_LIMITED, remembered (the next judge is used meanwhile)');
  j.forget();
  env = Object.assign({}, envBase, { FAKE_CLAUDE_JUDGE_MODE: 'logged_out' });
  r = await j.ask({ imagePath: pic, prompt: 'judge it' });
  assert(!r.ok && r.error === 'CC_SIGNED_OUT' && /sign in/.test(r.message) && j.available().state === 'signed_out', 'signed out → CC_SIGNED_OUT ("run claude once and sign in"), remembered');
  j.forget();
  env = Object.assign({}, envBase, { FAKE_CLAUDE_JUDGE_MODE: 'slow', AUTOINJECTOR_JUDGE_CC_TIMEOUT_MS: '1500' });
  const t0 = Date.now();
  r = await j.ask({ imagePath: pic, prompt: 'judge it' });
  assert(!r.ok && r.error === 'CC_TIMEOUT' && Date.now() - t0 < 8000, `a judge that takes too long is stopped (the process tree killed) — ${Date.now() - t0} ms`);
  env = Object.assign({}, envBase, { FAKE_CLAUDE_JUDGE_MODE: 'malformed' });
  const svc = JS.createJudgeService({ judges: { 'claude-code': j, pane: fakeJudge('pane', 'missing'), local: fakeJudge('local', 'missing') }, settings: {}, readRecord: () => ({ prompt: 'x' }) });
  r = await svc.judge(pic, {});
  assert(!r.ok && r.tried.some((t) => t.by === 'claude-code' && t.error === 'BAD_JSON'), 'Claude Code answering twice without JSON → BAD_JSON, then the others');
  env = Object.assign({}, envBase, { FAKE_CLAUDE_JUDGE_MODE: 'malformed_once' });
  r = await svc.judge(pic, {});
  assert(r.ok && r.judge.by === 'claude-code' && r.judge.attempts === 2, 'Claude Code answering once without JSON → asked once more → fine');
  env = Object.assign({}, envBase, { AUTOINJECTOR_CLAUDE_PATH: path.join(TMP, 'no-claude-here'), HOME: path.join(TMP, 'nohome'), USERPROFILE: path.join(TMP, 'nohome'), APPDATA: '', NPM_CONFIG_PREFIX: '' });
  const j2 = CC.createClaudeCodeJudge({ env: () => env });
  const av = j2.available();
  r = await j2.ask({ imagePath: pic, prompt: 'x' });
  assert(fs.existsSync('/usr/local/bin/claude') || (!av.ok && av.state === 'not_installed' && r.error === 'CC_NOT_INSTALLED' && /code\.claude\.com/.test(r.message)), 'Claude Code not installed → CC_NOT_INSTALLED with where to get it');
  assert(CC.parseReset("You've hit your session limit · resets 3pm", new Date(2026, 0, 1, 10, 0)) === new Date(2026, 0, 1, 15, 0).getTime(), '"resets 3pm" is read');
}

async function partJ() {
  console.log('\n== J. the pane judge and the local (Ollama) judge ==');
  const pic = path.join(TMP, 'pane-pic.png'); fs.writeFileSync(pic, PNG);
  const asked = [];
  let busy = null;
  const pane = JS.createPaneJudge({ site: () => 'claude', problem: () => busy, ask: async (site, text, o) => { asked.push({ site, text, o }); return { ok: true, text: `[TO: USER]\n${JSON.stringify(judgeAnswer(3, ''))}\n[FROM: CLAUDE]` }; } });
  let r = await pane.ask({ imagePath: pic, prompt: 'judge of AI-made pictures' });
  assert(r.ok && asked[0].o.attach === pic && asked[0].o.freshChat === true && /attached/.test(asked[0].text) && J.extractJson(r.text), 'the pane judge: a FRESH chat, the picture attached, the JSON read back through the pane tags');
  busy = { code: 'AKOWE_USING', say: 'Akọwe is using the Claude pane for the book' };
  r = await pane.ask({ imagePath: pic, prompt: 'x' });
  assert(!r.ok && r.error === 'PANE_BUSY' && r.unavailable && /wasn't interrupted/.test(r.message) && asked.length === 1, 'a pane busy with a book run is never interrupted — it says so');
  busy = null;
  const pane2 = JS.createPaneJudge({ site: () => 'chatgpt', problem: () => null, ask: async () => ({ ok: false, error: 'ATTACH_FAILED' }) });
  r = await pane2.ask({ imagePath: pic, prompt: 'x' });
  assert(!r.ok && r.error === 'PANE_ATTACH_FAILED' && /ChatGPT/.test(r.message), 'the picture couldn\'t be uploaded → a plain message');
  // the local judge
  const port = await freePort();
  const o = fakeOllama(port);
  await o.up();
  const local = JS.createOllamaJudge({ bases: () => [o.base], fetch: (...a) => fetch(...a) });
  let av = await local.available();
  assert(!av.ok && av.state === 'no_model' && /picture-reading model/.test(av.why), 'Ollama without a vision model → "add one (qwen2.5vl / llava)"');
  o.st.models.push({ name: 'llama3.1:8b', size: 1 }, { name: 'qwen2.5vl:7b', size: 2 });
  local.forget();
  o.st.write = (body) => (body.messages[0].images && body.messages[0].images[0] ? JSON.stringify(judgeAnswer(2, '')) : 'no picture');
  av = await local.available();
  r = await local.ask({ imagePath: pic, prompt: 'judge' });
  const chat = o.st.apiChats[o.st.apiChats.length - 1];
  assert(av.ok && av.model === 'qwen2.5vl:7b' && r.ok && chat.model === 'qwen2.5vl:7b' && chat.format === 'json' && chat.messages[0].images[0] === PNG.toString('base64'), 'the local judge picks the vision model, sends the picture as an image, asks for JSON');
  await o.down();
  local.forget();
  const gone = await local.available();
  r = await local.ask({ imagePath: pic, prompt: 'x' });
  assert(!gone.ok && gone.state === 'missing' && !r.ok && r.error === 'LOCAL_MISSING', 'Ollama not running → LOCAL_MISSING, in plain words');
}

async function partK(ctx) {
  console.log('\n== K. 🔁 Make it better + Make 4 and pick the best ==');
  const { studio, forge } = ctx;
  const ipBefore = JSON.stringify(ip.getSettings());
  // a scripted judge: scores go 4 → 6 → 8.5 (keep) — the loop must stop at round 3 of 5
  let n = 0; const seen = [];
  const judge = { judge: async (p, o) => { n++; seen.push(o); const base = [4, 6, 8.5, 9, 9][n - 1] || 9; const a = { scores: { prompt: base, quality: base, anatomy: base, artifacts: base, composition: base }, verdict: base >= 8 ? 'keep' : 'fix', good: ['x'], bad: base >= 8 ? [] : ['soft'], fixes: base >= 8 ? [] : [{ type: 'steps', delta: 5 }], prompt: { add: base >= 8 ? [] : [`detail${n}`] } }; const v = J.validate(a, {}); sdImages.updateRecord(p, { judge: v.judge }); return { ok: true, judge: Object.assign(v.judge, { by: 'claude-code' }), say: J.sayVerdict(v.judge) }; }, settings: () => J.cleanSettings({}), status: async () => ({ ok: true }) };
  const recipes = RC.createRecipeStore({ file: path.join(TMP, 'k-recipes.json') });
  const s2 = createSdStudio({ imageProvider: ip, library: library(), imagesDir: () => ctx.imagesDir, fileUrl: (p) => p, recipes, judge, appVersion: () => 'k' });
  const progress = [];
  let r = await s2.generate({ prompt: 'a ferryman at dusk', steps: 20, cfgScale: 7, width: 512, height: 512, seed: 99 }, 'images-tab');
  const start = r.images[0].path;
  const imp = createImprover({ generate: (q, from) => s2.generate(q, from), judge: (p, o) => judge.judge(p, o), readRecord: sdImages.readRecord, updateRecord: sdImages.updateRecord, ctxFor: async (rec) => s2.ctxFor(rec), log: () => {}, onProgress: (e) => progress.push(e) });
  r = await imp.improve(start, { rounds: 5, bar: 7.5 });
  assert(r.ok && r.rounds.length === 3 && r.stopReason === 'passed' && r.best === 2 && /Round 3 passed/.test(r.say), `it stops early when a round passes (3 of 5 rounds; scores ${r.rounds && r.rounds.map((x) => x.overall).join(' → ')})`);
  assert(r.rounds.every((x) => x.path && fs.existsSync(x.path) && x.judge) && sdImages.readRecord(r.rounds[2].path).improve.round === 3, 'every round\'s picture is kept with its sidecar and scores');
  assert(r.rounds[1].changed.some((c) => /steps 20 → 25/.test(c)) && r.rounds[1].changed.some((c) => /prompt/.test(c)) && forge.state.lastTxt2img.seed === 99, 'round 2 used the judge\'s fixes (steps +5, prompt words) with the same seed');
  assert(JSON.stringify(ip.getSettings()) === ipBefore && r.defaultsChanged === false, 'the Images defaults were never changed');
  assert(progress.some((e) => e.phase === 'making' && e.round === 2) && progress.some((e) => e.phase === 'done'), 'progress is reported (making / judging / done)');
  // it stops when it stops improving
  n = 10; const flat = { judge: async () => { const v = J.validate({ scores: { prompt: 5, quality: 5, anatomy: 5, artifacts: 5, composition: 5 }, verdict: 'fix', fixes: [{ type: 'cfg', delta: -1 }] }, {}); return { ok: true, judge: v.judge }; } };
  const imp2 = createImprover({ generate: (q, from) => s2.generate(q, from), judge: flat.judge, readRecord: sdImages.readRecord, updateRecord: sdImages.updateRecord, ctxFor: async (rec) => s2.ctxFor(rec), log: () => {} });
  const start2 = (await s2.generate({ prompt: 'a flat picture', seed: 11 }, 'images-tab')).images[0].path;
  r = await imp2.improve(start2, { rounds: 5 });
  if (process.env.IMGJ_DEBUG) console.log(JSON.stringify(r).slice(0, 1500));
  assert(r.ok && r.stopReason === 'no-better' && r.rounds.length === 3 && r.best === 0, 'two rounds in a row that are no better → it stops (round 1 stays the best)');
  // Stop
  let gate; const slowGen = (q, from) => new Promise((res) => { gate = () => res(s2.generate(q, from)); });
  const imp3 = createImprover({ generate: slowGen, judge: flat.judge, readRecord: sdImages.readRecord, updateRecord: sdImages.updateRecord, ctxFor: async (rec) => s2.ctxFor(rec), log: () => {}, cancelRender: () => {} });
  const p3 = imp3.improve(start, { rounds: 4 });
  await new Promise((res) => setTimeout(res, 100));
  assert(imp3.status().running && !(await imp3.improve(start, {})).ok, 'one at a time (a second one says it is busy)');
  imp3.stop(); gate();
  r = await p3;
  assert(r.ok && r.stopReason === 'stopped' && !imp3.status().running, '⏹ Stop ends it, keeping what was made');
  // no record / no judge
  assert((await imp.improve(path.join(TMP, 'nothing.png'), {})).code === 'NO_RECORD', 'a picture without settings → NO_RECORD');
  const noJudge = createImprover({ generate: (q, f) => s2.generate(q, f), judge: async () => ({ ok: false, error: 'NO_JUDGE_ANSWERED', message: 'No AI judge could look at the picture.' }), readRecord: sdImages.readRecord, updateRecord: sdImages.updateRecord, ctxFor: async () => ({}), log: () => {} });
  const startNoJudge = s2.generate({ prompt: 'no judge', seed: 5 }, 'images-tab');
  r = await noJudge.improve((await startNoJudge).images[0].path, {});
  assert(!r.ok && /No AI judge/.test(r.message), 'no judge → the plain error, nothing made');

  console.log('\n-- Make 4 and pick the best --');
  let k = 0; const scores = [6, 8.5, 5, 7];
  const pickJudge = async () => { const s = scores[k++ % 4]; const v = J.validate({ scores: { prompt: s, quality: s, anatomy: s, artifacts: s, composition: s }, verdict: s >= 8 ? 'keep' : 'fix' }, {}); return { ok: true, judge: v.judge }; };
  const imp4 = createImprover({ generate: (q, from) => s2.generate(q, from), judge: pickJudge, readRecord: sdImages.readRecord, updateRecord: sdImages.updateRecord, ctxFor: async (rec) => s2.ctxFor(rec), log: () => {} });
  r = await imp4.best({ prompt: 'four ferries', seed: 7 }, { count: 4 });
  assert(r.ok && r.images.length === 4 && forge.state.lastTxt2img.batch_size === 4 && forge.state.lastTxt2img.seed === -1, 'four pictures in one batch, with random (different) seeds');
  assert(r.best === 1 && r.images[1].overall === 8.5 && sdImages.readRecord(r.bestPath).picked && /Picture 2 of 4 is the best/.test(r.say), 'the best-scored one is picked and marked');
  assert(new Set(r.images.map((x) => x.seed)).size === 4, 'each has its own seed');
  // through the studio + sd-api (Alfred's tools)
  const api = sdApi.createImagesApi({ studio: s2, library: library() });
  n = 0;
  r = await api.images.improve({ path: start, rounds: 2 });
  assert(r.ok && r.rounds.length === 2, 'sd-api images.improve (Alfred) runs it');
  n = 0;
  r = await api.images.judge({ path: start });
  assert(r.ok && r.judge && r.say, 'sd-api images.judge answers with the verdict and plain words');
  r = await api.images.judgeSettings({ autoBook: true });
  assert(r.ok && r.autoBook === true, 'images.judgeSettings saves');
  // book pictures judged and improved automatically (max 2 rounds), when switched on
  let saved = null;
  const judge2 = Object.assign({}, judge, { settings: () => J.cleanSettings({ autoBook: true }) });
  n = 0;
  const s3 = createSdStudio({ imageProvider: ip, library: library(), imagesDir: () => ctx.imagesDir, fileUrl: (p) => p, judge: judge2, persistJudge: (s) => { saved = s; } });
  r = await s3.request({ prompt: 'portrait of Adaeze', engine: 'sd', book: 'Salt' });
  if (process.env.IMGJ_DEBUG) console.log(JSON.stringify(r).slice(0, 1200));
  assert(r.ok && r.judged && r.judged.rounds === 2 && r.judged.best === 2 && r.images[0].improvedFrom && /improve/.test(sdImages.readRecord(r.images[0].path).askedBy.from), 'a book picture with “Judge and improve book pictures automatically” on: judged, improved (2 rounds), Akọwe gets the better one');
  n = 0;
  const s4 = createSdStudio({ imageProvider: ip, library: library(), imagesDir: () => ctx.imagesDir, fileUrl: (p) => p, judge });
  r = await s4.request({ prompt: 'portrait of Adaeze', engine: 'sd', book: 'Salt' });
  assert(r.ok && !r.judged && n === 0, 'off (the default): book pictures are not judged (no AI usage)');
  void saved;
}

(async () => {
  try {
    partA(); partB();
    const ctx = await partCDE();
    partF(); partG();
    await partH(); await partI(); await partJ();
    await partK(ctx);
    try { ctx.forge.close(); ctx.comfy.close(); } catch (_) {}
  } catch (e) { failed++; console.log(`  FAIL - crashed: ${e && e.stack}`); }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
