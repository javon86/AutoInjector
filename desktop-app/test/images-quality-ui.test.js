// test/images-quality-ui.test.js — PR #128: the 🎨 Images → Generate form in jsdom (controls.html +
// sd-quality.js + images-studio.js, a stub window.api.sd): the compact layout (top block, ⚙ More
// settings, the collapsed sections, the sticky Generate bar), the model family → its own sizes / steps /
// CFG, the Style chips and default negative in what is sent, "📝 Shortened for the model", the 🧩 LoRA
// browser (search, filters, cards, click to add), LoRA rows with a weight slider → <lora:name:0.55>,
// 🔑 trigger words, the base-model mismatch, "📖 Book pictures use", and remembered open sections.
// Run: node test/images-quality-ui.test.js
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const SD15 = 'dreamshaper_8.safetensors [879db523c3]';
const XL = 'juggernautXL_v9.safetensors [c9e3e68f89]';
function stub() {
  const calls = [];
  let quality = { bookCheckpoint: '' };
  const libItems = [
    { id: 'lora:odile_face', kind: 'lora', name: 'odile_face', base: 'SD1.5', triggerWords: ['odile woman'], tags: ['face'], collections: [], favorite: true, defaultWeight: 0.7, onDisk: true, previewUrl: 'file:///m/odile_face.preview.png' },
    { id: 'lora:xl_ink', kind: 'lora', name: 'xl_ink', base: 'SDXL', triggerWords: [], datasetTags: ['ink wash', 'monochrome', 'brush strokes'], tags: [], collections: [], onDisk: true },
    { id: 'lora:film_grain_xl', kind: 'lora', name: 'film_grain_xl', base: 'SDXL', triggerWords: ['film grain'], tags: [], collections: [], onDisk: true },
    { id: 'checkpoint:dreamshaper_8', kind: 'checkpoint', name: 'dreamshaper_8', base: 'SD1.5', size: 2.1e9, onDisk: true },
    { id: 'checkpoint:juggernautxl_v9', kind: 'checkpoint', name: 'juggernautXL_v9', base: 'SDXL', size: 6.9e9, onDisk: true },
  ];
  let status = { ok: true, enabled: true, endpoint: 'http://127.0.0.1:7860/sdapi/v1/txt2img', backend: 'a1111', base: 'http://127.0.0.1:7860', label: 'Forge', model: 'dreamshaper_8', steps: 20, cfgScale: 7, width: 512, height: 768, batchSize: 1, seed: -1 };
  const sd = {
    status: async () => status,
    connect: async (url) => { calls.push(['connect', url]); return { ok: true, kind: 'a1111', label: 'Forge', port: 7860, model: 'dreamshaper_8', message: 'Connected to Forge on :7860', status }; },
    lists: async () => ({ ok: true, backend: 'a1111', checkpoints: [{ name: SD15, title: SD15 }, { name: XL, title: XL }], loras: [{ name: 'odile_face', alias: 'odile_face' }, { name: 'xl_ink', alias: 'xl_ink' }, { name: 'only_in_forge', alias: 'only_in_forge', metadata: { ss_base_model_version: 'sd_v1', 'modelspec.trigger_phrase': 'forge thing' } }], samplers: ['Euler a', 'DPM++ 2M'], schedulers: ['Automatic', 'Karras'], vaes: ['Automatic', 'None'], embeddings: [], current: { checkpoint: SD15 } }),
    check: async (loras, ck) => { calls.push(['check', loras.map((l) => l.name).join(), ck]); return /XL/i.test(ck) && loras.some((l) => l.name === 'odile_face') ? { ok: true, warnings: [{ name: 'odile_face', level: 'hard', message: '“odile_face” was made for SD1.5, but the checkpoint is SDXL — it won\'t work' }] } : { ok: true, warnings: [] }; },
    generate: async (req) => { calls.push(['generate', req]); return { ok: true, seed: 1, warnings: [], settings: Object.assign({}, req, { checkpoint: req.checkpoint || SD15, family: /XL/.test(req.checkpoint) ? 'SDXL' : 'SD1.5' }), images: [{ path: '/out/images/sd-1.png', url: 'file:///out/images/sd-1.png', seed: 1 }] }; },
    progress: async () => ({ ok: true, busy: false }),
    gallery: async () => ({ ok: true, items: [{ path: '/out/images/book.png', url: 'file:///out/images/book.png', name: 'book.png', record: { prompt: 'portrait of Adaeze', checkpoint: XL, family: 'SDXL', from: 'bridge:akowe-forge', fullPrompt: 'Portrait of Adaeze … (long)', width: 832, height: 1216 } }] }),
    libList: async (f) => { calls.push(['libList', f]); let items = libItems.slice(); if (f && f.kind) items = items.filter((x) => x.kind === f.kind); return { ok: true, items, total: items.length, collections: [], tags: [], lastScan: { count: 5 }, folders: [], checkpointBase: '' }; },
    libUpdate: async (id, patch) => { calls.push(['libUpdate', id, patch]); const it = libItems.find((x) => x.id === id); if (it && 'favorite' in patch) it.favorite = patch.favorite; return { ok: true }; },
    libScan: async () => { calls.push(['libScan']); return { ok: true }; },
    refresh: async (what) => { calls.push(['refresh', what]); return { ok: true }; },
    locks: async () => ({ ok: true, locks: [] }),
    targets: async () => ({ ok: true, targets: [], runner: { phase: 'idle' }, install: { installed: false }, startWithApp: false }),
    extras: async () => ({ ok: true, backend: 'a1111', upscalers: ['Latent'], upscaleModels: ['None'], controlnet: null, adetailer: null, styles: [], scripts: null, optionKeys: [], workflows: [] }),
    quality: async (patch) => { calls.push(['quality', patch]); if (patch && 'bookCheckpoint' in patch) quality = { bookCheckpoint: patch.bookCheckpoint }; return Object.assign({ ok: true }, quality); },
    chatgptStatus: async () => ({ ok: true, ready: false }),
    onRunner: () => {}, onInstall: () => {}, onConnected: () => {},
  };
  return { sd, calls };
}

async function load(prefs) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'controls.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/controls.html', pretendToBeVisual: true });
  for (const [k, v] of Object.entries(prefs || {})) dom.window.localStorage.setItem(k, v);
  const h = stub();
  const known = { sd: h.sd, akoweTab: async () => ({}) };
  dom.window.api = new Proxy(known, { get(t, k) { if (k in t) return t[k]; if (typeof k === 'string' && /^on[A-Z]/.test(k)) return () => {}; return async () => ({}); } });
  dom.window.sd = h.sd;
  // the stub's sd is a plain object: anything else the tab asks for answers {}
  dom.window.api.sd = new Proxy(h.sd, { get(t, k) { if (k in t) return t[k]; if (typeof k === 'string' && /^on[A-Z]/.test(k)) return () => {}; return async () => ({ ok: false }); } });
  dom.window.confirm = () => true;
  dom.window.eval(fs.readFileSync(path.join(__dirname, '..', 'sd-quality.js'), 'utf8'));
  dom.window.eval(fs.readFileSync(path.join(__dirname, '..', 'images-studio.js'), 'utf8'));
  const d = dom.window.document;
  const t = Object.assign(h, { dom, d, $: (id) => d.getElementById(id), click: (el) => (typeof el === 'string' ? d.getElementById(el) : el).dispatchEvent(new dom.window.Event('click', { bubbles: true })), fire: (el, type) => el.dispatchEvent(new dom.window.Event(type, { bubbles: true })) });
  t.click('tab-app-images');
  await tick(150);
  return t;
}
const lastGen = (t) => { const g = t.calls.filter((c) => c[0] === 'generate'); return g.length ? g[g.length - 1][1] : null; };
async function generate(t) { t.click('btn-sd-generate'); await tick(60); return lastGen(t); }

(async () => {
  console.log('== the compact layout ==');
  let t = await load();
  const form = t.$('sd-form');
  const order = ['sd-engine-row', 'sd-style-row', 'sd-size-row', 'sd-prompt', 'sd-neg-box', 'sd-lora-row', 'sd-lora-chips', 'sd-lock-row', 'sd-sec-more', 'sd-advanced'].map((id) => t.$(id));
  assert(order.every((e) => e && form.contains(e)), 'the top block, ⚙ More settings and the extra sections are all in the form card');
  assert(order.every((e, i) => i === 0 || (order[i - 1].compareDocumentPosition(e) & 4)), 'in this order: Engine · Checkpoint → Style → Size → Prompt → Negative → LoRAs → Character → ⚙ More settings → the extra sections');
  assert(t.$('sd-engine-row').contains(t.$('sd-checkpoint')), 'the checkpoint sits next to the engine');
  for (const id of ['sd-sampler', 'sd-scheduler', 'sd-steps', 'sd-cfg', 'sd-batch', 'sd-seed', 'sd-vae', 'sd-book-checkpoint']) assert(t.$('sd-sec-more').contains(t.$(id)), `#${id} is inside ⚙ More settings`);
  assert(!t.$('sd-sec-more').open && t.$('sd-neg-box').tagName === 'DETAILS' && !t.$('sd-neg-box').open, '⚙ More settings and the negative prompt start folded (one line each)');
  assert(t.$('sd-size-custom').hidden && t.$('sd-size-custom').contains(t.$('sd-width')) && t.$('sd-size-custom').contains(t.$('sd-height')), 'the exact Width / Height sliders live under Custom (hidden by default)');
  assert([...t.d.querySelectorAll('#sd-advanced > details')].map((x) => x.id).join() === 'sd-sec-views,sd-sec-hires,sd-sec-refiner,sd-sec-img2img,sd-sec-cn,sd-sec-ad,sd-sec-up,sd-sec-adv,sd-sec-wf', 'the extra sections stay as collapsed rows with their ids');
  assert(t.d.querySelector('.sd-gobar').contains(t.$('btn-sd-generate')) && t.d.querySelector('.sd-gobar').contains(t.$('btn-sd-stop')), 'Generate / Stop stay in the sticky bar');
  assert(t.d.querySelectorAll('#sd-style-row [data-style]').length === 5 && t.d.querySelectorAll('#sd-size-row [data-aspect]').length === 4, 'Style: 5 chips; Size: Portrait / Square / Landscape / Custom');

  console.log('== the model family picks the size, steps and CFG ==');
  t.$('sd-url').value = 'http://127.0.0.1:7860';
  t.click('btn-sd-connect');
  await tick(150);
  assert(t.$('sd-family').textContent === 'SD1.5' && !t.$('sd-family').hidden, 'dreamshaper_8 → the SD1.5 badge');
  assert(t.d.querySelector('#sd-size-row [data-aspect="portrait"]').getAttribute('aria-pressed') === 'true' && t.$('sd-width').value === '512' && t.$('sd-height').value === '768', 'stored 512×768 → Portrait, 512×768 on SD1.5');
  assert(t.$('sd-steps').value === '28' && t.$('sd-cfg').value === '7', 'SD1.5 → 28 steps, CFG 7 (never moved by hand)');
  assert(!t.$('sd-size-hires-wrap').hidden, 'SD1.5 offers ✨ Hires ×1.5 right next to the size');
  t.$('sd-checkpoint').value = XL; t.fire(t.$('sd-checkpoint'), 'change');
  await tick(80);
  assert(t.$('sd-family').textContent === 'SDXL' && t.$('sd-width').value === '832' && t.$('sd-height').value === '1216', 'an SDXL checkpoint → Portrait becomes 832×1216');
  assert(t.$('sd-steps').value === '28' && t.$('sd-cfg').value === '5.5', 'SDXL → CFG 5.5');
  assert(/DPM\+\+ 2M/.test(t.$('sd-sampler').options[0].textContent) && /Karras/.test(t.$('sd-scheduler').options[0].textContent) && t.$('sd-sampler').value === '', '"(default)" now says what it stands for: DPM++ 2M · Karras (the value stays "")');
  assert(/DPM\+\+ 2M · Karras · 28 steps · CFG 5\.5/.test(t.$('sd-more-sum').textContent), `the folded ⚙ More settings line sums it up ("${t.$('sd-more-sum').textContent}")`);
  t.click(t.d.querySelector('#sd-size-row [data-aspect="square"]'));
  assert(t.$('sd-width').value === '1024' && t.$('sd-height').value === '1024' && /1024×1024/.test(t.$('sd-size-readout').textContent), 'Square → 1024×1024');
  t.click(t.d.querySelector('#sd-size-row [data-aspect="custom"]'));
  assert(!t.$('sd-size-custom').hidden, 'Custom shows the exact sliders');
  t.$('sd-width').value = '512'; t.fire(t.$('sd-width'), 'input'); t.$('sd-height').value = '512'; t.fire(t.$('sd-height'), 'input');
  assert(!t.$('sd-size-warn').hidden && /SDXL makes poor pictures this small/.test(t.$('sd-size-warn').textContent), `SDXL at 512×512 → "${t.$('sd-size-warn').textContent.slice(0, 60)}…"`);
  t.click(t.d.querySelector('#sd-size-row [data-aspect="portrait"]'));
  assert(t.$('sd-size-warn').hidden && t.$('sd-width').value === '832', 'back to Portrait → the warning goes');
  assert(t.dom.window.localStorage.getItem('sd-aspect') === 'portrait', 'the size choice is remembered');

  console.log('== Style chips + the default negative in what is sent ==');
  t.$('sd-prompt').value = 'portrait of an old ferryman at dusk'; t.fire(t.$('sd-prompt'), 'input');
  let g = await generate(t);
  assert(g && g.prompt === 'portrait of an old ferryman at dusk' && /lowres/.test(g.negativePrompt) && g.width === 832 && g.height === 1216 && g.checkpoint === XL && g.sampler === '', 'no style: the prompt as typed, the default negative, 832×1216, sampler "" (main fills DPM++ 2M)');
  assert(/default: lowres/.test(t.$('sd-neg-preview').textContent), 'the folded Negative line shows the default it will use');
  t.click(t.d.querySelector('#sd-style-row [data-style="photo"]'));
  assert(t.d.querySelector('#sd-style-row [data-style="photo"]').getAttribute('aria-pressed') === 'true', 'Photo-real is one click');
  g = await generate(t);
  assert(/^portrait of an old ferryman at dusk, RAW photo, photorealistic/.test(g.prompt) && /cartoon/.test(g.negativePrompt) && /3d render/.test(g.negativePrompt) && g.style === 'photo', 'Photo-real adds its quality words and "cartoon, 3d render" to the negative');
  assert(/Sent: .*RAW photo/.test(t.$('sd-final-prompt').textContent), 'the line under the form shows what is really sent');
  t.$('sd-negative').value = 'hat'; t.fire(t.$('sd-negative'), 'input');
  g = await generate(t);
  assert(/^hat, .*cartoon/.test(g.negativePrompt) && !/lowres/.test(g.negativePrompt), 'your own negative replaces the default (the style\'s terms are still added)');
  t.$('sd-negative').value = ''; t.fire(t.$('sd-negative'), 'input');
  t.click(t.d.querySelector('#sd-style-row [data-style="photo"]'));
  assert(t.d.querySelector('#sd-style-row [data-style="photo"]').getAttribute('aria-pressed') === 'false', 'clicking it again turns the style off');

  console.log('== 📝 Shortened for the model ==');
  const LONG = `Portrait of Adaeze, a 42-year-old market trader with deep-set amber eyes, grey cornrows and a thin scar on her left cheek. ${'She raised three children alone and remembers every debt, and the traders respect her temper and her proverbs. '.repeat(8)}She wears an indigo wrapper. Lantern light, realistic photograph.`;
  t.$('sd-prompt').value = LONG; t.fire(t.$('sd-prompt'), 'input');
  await tick(260);
  assert(!t.$('sd-prompt-short').hidden && /Shortened for the model/.test(t.$('sd-prompt-short-msg').textContent), `a very long prompt → "${t.$('sd-prompt-short-msg').textContent.slice(0, 70)}…"`);
  assert(/chunks/.test(t.$('sd-prompt-tokens').textContent), `the token count shows the CLIP chunks ("${t.$('sd-prompt-tokens').textContent}")`);
  t.click('btn-sd-prompt-full');
  assert(!t.$('sd-prompt-short-text').hidden && /amber eyes/.test(t.$('sd-prompt-short-text').textContent), 'show what is sent → the short version, with the looks');
  g = await generate(t);
  assert(g.prompt.length < LONG.length / 2 && /amber eyes/.test(g.prompt) && /scar/.test(g.prompt) && g.fullPrompt === LONG, 'Generate sends the short prompt and the full text (kept in the .json)');
  t.$('sd-prompt-short-on').checked = false; t.fire(t.$('sd-prompt-short-on'), 'change');
  g = await generate(t);
  assert(g.prompt === LONG && !g.fullPrompt, '"shorten" off → the whole text goes');
  t.$('sd-prompt-short-on').checked = true;
  t.$('sd-prompt').value = 'portrait of an old ferryman'; t.fire(t.$('sd-prompt'), 'input');
  await tick(260);
  assert(t.$('sd-prompt-short').hidden, 'a normal prompt → no note');

  console.log('== 🧩 the LoRA browser ==');
  assert(t.$('sd-lora-drawer').hidden, 'the browser starts closed');
  t.click('btn-sd-lora-browser');
  await tick(30);
  assert(!t.$('sd-lora-drawer').hidden && t.$('btn-sd-lora-browser').getAttribute('aria-expanded') === 'true', '🧩 LoRAs opens it under the LoRA row');
  let cards = [...t.d.querySelectorAll('#sd-ld-grid .sd-ldcard')];
  assert(cards.length === 4 && /4 of 4/.test(t.$('sd-ld-count').textContent), `every LoRA is a card: the library's three + one only Forge lists (${cards.map((c) => c.dataset.name).join(', ')})`);
  const odile = t.d.querySelector('.sd-ldcard[data-name="odile_face"]');
  assert(odile.querySelector('img') && /preview/.test(odile.querySelector('img').src) && odile.querySelector('.sd-badge').textContent === 'SD1.5' && /odile woman/.test(odile.querySelector('.sd-ld-trig').textContent) && /★/.test(odile.querySelector('.sd-ld-fav').textContent), 'a card: its preview picture, base badge, trigger words, ★');
  assert(t.d.querySelector('.sd-ldcard[data-name="xl_ink"] .sd-ld-thumb').textContent.trim() === 'XI' && /ink wash/.test(t.d.querySelector('.sd-ldcard[data-name="xl_ink"] .sd-ld-trig').textContent), 'no preview → a placeholder with its initials; no trigger words → its training set\'s top tags');
  assert(t.d.querySelector('.sd-ldcard[data-name="only_in_forge"] .sd-badge').textContent === 'SD1.5', 'a LoRA only Forge lists gets its base from its metadata');
  assert(odile.dataset.compat === 'hard' && /SDXL/.test(t.$('sd-ld-f-match').textContent), 'on SDXL the SD1.5 LoRA is marked ⛔; the filter says "Fits SDXL"');
  t.click(t.d.querySelector('#sd-lora-drawer [data-ldf="match"]'));
  cards = [...t.d.querySelectorAll('#sd-ld-grid .sd-ldcard')].map((c) => c.dataset.name);
  assert(cards.join() === 'film_grain_xl,xl_ink', `Fits SDXL → only the SDXL LoRAs (${cards.join(', ')})`);
  t.click(t.d.querySelector('#sd-lora-drawer [data-ldf="all"]'));
  t.$('sd-ld-q').value = 'grain'; t.fire(t.$('sd-ld-q'), 'input');
  await tick(160);
  cards = [...t.d.querySelectorAll('#sd-ld-grid .sd-ldcard')].map((c) => c.dataset.name);
  assert(cards.join() === 'film_grain_xl', 'search finds by name / trigger words');
  t.$('sd-ld-q').value = ''; t.fire(t.$('sd-ld-q'), 'input');
  await tick(160);
  t.click(t.d.querySelector('.sd-ldcard[data-name="xl_ink"]'));
  await tick(40);
  let chip = t.d.querySelector('.sd-chip[data-name="xl_ink"]');
  assert(chip && chip.querySelector('input[type=range]').value === '0.8' && chip.querySelector('input[type=range]').min === '-1' && chip.querySelector('input[type=range]').max === '2' && chip.querySelector('input[type=range]').step === '0.05', 'click a card → a LoRA row with a weight slider −1…2, step 0.05, at 0.8');
  assert(t.d.querySelector('.sd-ldcard[data-name="xl_ink"]').dataset.added === '1' && /✓ added/.test(t.d.querySelector('.sd-ldcard[data-name="xl_ink"]').textContent) && t.$('sd-lora-count').textContent === '1', 'the card says ✓ added; the 🧩 LoRAs button counts 1');
  assert(/<lora:xl_ink:0\.8>/.test(t.$('sd-final-prompt').textContent), 'the prompt line shows <lora:xl_ink:0.8>');
  const rng = chip.querySelector('input[type=range]'); rng.value = '0.55'; t.fire(rng, 'input');
  assert(/<lora:xl_ink:0\.55>/.test(t.$('sd-final-prompt').textContent) && chip.querySelector('.sd-chip-w').textContent === '0.55', 'moving the slider → <lora:xl_ink:0.55>');
  t.click(chip.querySelector('.sd-chip-trig'));
  assert(/ink wash, monochrome, brush strokes/.test(t.$('sd-prompt').value), '🔑 puts its trigger words (here: its top training tags) into the prompt');
  g = await generate(t);
  assert(g.loras.length === 1 && g.loras[0].name === 'xl_ink' && g.loras[0].weight === 0.55, 'Generate sends the LoRA with its weight (main writes <lora:xl_ink:0.55>)');
  t.click(t.d.querySelector('.sd-ldcard[data-name="odile_face"]'));
  await tick(60);
  chip = t.d.querySelector('.sd-chip[data-name="odile_face"]');
  assert(chip && chip.dataset.compat === 'hard' && /made for SD1\.5, but the checkpoint is SDXL/.test(t.$('sd-warnings').textContent), 'an SD1.5 LoRA on SDXL → its row turns red with a plain warning');
  assert(/odile woman/.test(t.$('sd-prompt').value), 'its trigger words were added when it was picked');
  t.click(chip.querySelector('button[aria-label="Remove odile_face"]'));
  await tick(40);
  assert(!t.d.querySelector('.sd-chip[data-name="odile_face"]') && t.$('sd-warnings').textContent === '', '✕ removes it (and the warning)');
  t.click(t.d.querySelector('#sd-lora-drawer [data-ldf="recent"]'));
  cards = [...t.d.querySelectorAll('#sd-ld-grid .sd-ldcard')].map((c) => c.dataset.name);
  assert(cards.join() === 'odile_face,xl_ink', `Recent → the last used first (${cards.join(', ')})`);
  t.click(t.d.querySelector('#sd-lora-drawer [data-ldf="fav"]'));
  t.click(t.d.querySelector('.sd-ldcard[data-name="odile_face"] .sd-ld-fav'));
  await tick(60);
  assert(t.calls.some((c) => c[0] === 'libUpdate' && c[1] === 'lora:odile_face' && c[2].favorite === false) && !t.d.querySelector('.sd-ldcard[data-name="odile_face"]'), '☆/★ on a card saves the favourite in the library (★ filter updates)');
  t.click(t.d.querySelector('#sd-lora-drawer [data-ldf="all"]'));
  t.click('btn-sd-ld-refresh');
  await tick(80);
  assert(t.calls.some((c) => c[0] === 'refresh' && c[1] === 'loras') && t.calls.some((c) => c[0] === 'libScan'), '↻ asks the SD app to refresh its LoRAs (/sdapi/v1/refresh-loras) and rescans the folders');
  t.$('sd-lora-drawer').dispatchEvent(new t.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert(t.$('sd-lora-drawer').hidden, 'Esc closes it');
  t.$('sd-lora-search').value = 'film'; t.fire(t.$('sd-lora-search'), 'input');
  assert(t.d.querySelector('.sd-sugg[data-name="film_grain_xl"]'), 'the quick "Type to find a LoRA…" box still works next to the button');

  console.log('== 📖 Book pictures use + which checkpoint made each picture ==');
  assert([...t.$('sd-book-checkpoint').options].map((o) => o.value).join('|') === `|${SD15}|${XL}`, 'the "Book pictures use" list: (whatever is loaded) + the checkpoints');
  assert(/whatever checkpoint is loaded/.test(t.$('sd-book-note').textContent), 'it starts as whatever is loaded, said plainly');
  t.$('sd-book-checkpoint').value = XL; t.fire(t.$('sd-book-checkpoint'), 'change');
  await tick(40);
  assert(t.calls.some((c) => c[0] === 'quality' && c[1] && c[1].bookCheckpoint === XL) && new RegExp(XL.replace(/[[\]().]/g, '\\$&')).test(t.$('sd-book-note').textContent), 'choosing one saves it (sd:quality) and says so');
  const gi = t.d.querySelector('#sd-gallery img');
  assert(gi && /🧠 juggernautXL_v9/.test(gi.title) && /akowe-forge/.test(gi.title), 'a gallery picture says which checkpoint made it and who asked');
  t.click(gi);
  assert(/🧠 model juggernautXL_v9.*\(SDXL\)/.test(t.$('sd-preview-info').textContent) && /Shortened for the model/.test(t.$('sd-preview-info').textContent), 'the picture\'s details: the checkpoint (+ family) and that the prompt was shortened');

  t.click('btn-sd-remake');
  await tick(40);
  assert(t.$('sd-prompt').value === 'Portrait of Adaeze … (long)' && t.$('sd-width').value === '832' && t.$('sd-height').value === '1216', '♻ Remake puts the full description back (it is shortened again when sent) and the size');
  console.log('== remembered open sections ==');
  t.$('sd-sec-more').open = true; t.$('sd-sec-more').dispatchEvent(new t.dom.window.Event('toggle'));
  assert(t.dom.window.localStorage.getItem('sd-open:sd-sec-more') === '1', 'opening ⚙ More settings is remembered');
  t.dom.window.close();
  t = await load({ 'sd-open:sd-sec-more': '1', 'sd-open:sd-neg-box': '1', 'sd-style': 'cinematic', 'sd-aspect': 'landscape' });
  assert(t.$('sd-sec-more').open && t.$('sd-neg-box').open && !t.$('sd-sec-hires').open, 'next time: ⚙ More settings and Negative open again, the rest stays folded');
  assert(t.d.querySelector('#sd-style-row [data-style="cinematic"]').getAttribute('aria-pressed') === 'true' && t.d.querySelector('#sd-size-row [data-aspect="landscape"]').getAttribute('aria-pressed') === 'true', 'the style and size choice come back too');
  t.dom.window.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
