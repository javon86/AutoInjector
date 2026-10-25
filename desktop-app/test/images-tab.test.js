// test/images-tab.test.js — the 🎨 Images tab (controls.html + images-studio.js) in jsdom
// with a stub window.api.sd: the tab switch (and hiding the Akọwe view), the
// connection status line, the --api hint, the LoRA picker (chips, weights,
// trigger words, mismatch warning), Generate with progress, the gallery +
// Remake, the library list/editor, character locks, and Start/Install.
// Run: node test/images-tab.test.js
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function makeSd(over = {}) {
  const calls = [];
  const libItems = [
    { id: 'lora:odile_face', kind: 'lora', name: 'odile_face', base: 'SD1.5', triggerWords: ['odile woman'], tags: ['face'], collections: ['Characters'], favorite: true, defaultWeight: 0.7, size: 151000000, file: 'C:/SM/Data/Models/Lora/odile_face.safetensors', relPath: 'odile_face.safetensors', onDisk: true, compat: { level: 'hard', message: 'x' }, datasetTags: ['silver hair'] },
    { id: 'checkpoint:dreamshaper_8', kind: 'checkpoint', name: 'dreamshaper_8', base: 'SD1.5', triggerWords: [], tags: [], collections: [], size: 2100000000, file: 'C:/x.safetensors', relPath: 'dreamshaper_8.safetensors', onDisk: true, compat: { level: 'unknown' } },
  ];
  let status = { ok: true, enabled: false, endpoint: '', backend: '', base: '', label: '', steps: 20, cfgScale: 7, width: 512, height: 512, batchSize: 1, seed: -1 };
  let locks = [];
  const progressSeq = [];
  const sd = {
    status: async () => { calls.push(['status']); return status; },
    detect: async () => { calls.push(['detect']); return over.detect || { ok: true, found: [{ kind: 'a1111', label: 'Forge', port: 7860, base: 'http://127.0.0.1:7860', usable: true, message: 'Connected to Forge on :7860 — model dreamshaper_8' }], problems: [], best: { kind: 'a1111', label: 'Forge', port: 7860, base: 'http://127.0.0.1:7860', usable: true } }; },
    connect: async (url) => {
      calls.push(['connect', url]);
      if (over.connect) return over.connect(url);
      status = Object.assign({}, status, { enabled: true, endpoint: url + '/sdapi/v1/txt2img', backend: 'a1111', base: url, label: 'Forge', model: 'dreamshaper_8' });
      return { ok: true, kind: 'a1111', label: 'Forge', port: 7860, model: 'dreamshaper_8', message: 'Connected to Forge on :7860 — model dreamshaper_8', status };
    },
    lists: async () => ({ ok: true, backend: 'a1111', checkpoints: [{ name: 'dreamshaper_8.safetensors [879db523c3]', title: 'dreamshaper_8.safetensors [879db523c3]' }, { name: 'juggernautXL_v9.safetensors [c9]', title: 'juggernautXL_v9' }], loras: [{ name: 'odile_face', alias: 'odile_face' }], samplers: ['Euler a', 'DPM++ 2M'], schedulers: ['Automatic', 'Karras'], vaes: ['Automatic', 'None', 'vae-ft-mse'], embeddings: [], current: { checkpoint: 'dreamshaper_8.safetensors [879db523c3]' } }),
    settings: async () => ({ ok: true }),
    check: async (loras, ck) => { calls.push(['check', loras.map((l) => l.name).join(), ck]); return /XL/i.test(ck) ? { ok: true, checkpointBase: 'SDXL', warnings: [{ name: 'odile_face', level: 'hard', message: '“odile_face” was made for SD1.5, but the checkpoint is SDXL — it won\'t work' }] } : { ok: true, warnings: [] }; },
    generate: async (req) => { calls.push(['generate', req]); progressSeq.push('gen'); await tick(700); return { ok: true, seed: 1234, warnings: [], settings: Object.assign({}, req, { backend: 'a1111', seed: 1234 }), images: [{ path: '/out/images/sd-1.png', url: 'file:///out/images/sd-1.png', seed: 1234 }] }; },
    test: async () => { calls.push(['test']); return { ok: true, seed: 5, warnings: [], settings: { prompt: 'a red apple', width: 512, height: 512, purpose: 'test' }, images: [{ path: '/out/images/test-1.png', url: 'file:///out/images/test-1.png', seed: 5 }] }; },
    progress: async () => { calls.push(['progress']); return { ok: true, busy: true, progress: 0.5, step: 10, steps: 20, etaSeconds: 3, elapsed: 2 }; },
    cancel: async () => { calls.push(['cancel']); return { ok: true }; },
    gallery: async () => ({ ok: true, items: [{ path: '/out/images/old.png', url: 'file:///out/images/old.png', name: 'old.png', record: { prompt: 'an old lighthouse', negativePrompt: 'blurry', seed: 777, steps: 30, cfgScale: 5, width: 640, height: 448, sampler: 'DPM++ 2M', checkpoint: 'dreamshaper_8.safetensors [879db523c3]', loras: [{ name: 'odile_face', weight: 0.6 }] } }] }),
    record: async () => ({ ok: true }),
    openImagesFolder: async () => { calls.push(['openFolder']); return { ok: true }; },
    openUi: async () => ({ ok: true }), showFile: async (p) => { calls.push(['showFile', p]); return { ok: true }; },
    libList: async (f) => { calls.push(['libList', f]); let items = libItems; if (f && f.kind) items = items.filter((x) => x.kind === f.kind); return { ok: true, items, total: items.length, collections: ['Characters', 'Styles'], tags: ['face'], lastScan: { count: 2 }, folders: [{ path: 'C:/SM/Data/Models/Lora', kind: 'lora', source: 'Stability Matrix', exists: true }], checkpointBase: 'SD1.5' }; },
    libScan: async () => { calls.push(['libScan']); return { ok: true, count: 2 }; },
    libUpdate: async (id, patch) => { calls.push(['libUpdate', id, patch]); return { ok: true }; },
    libFolders: async () => ({ ok: true, folders: [] }), libAddFolder: async () => ({ ok: false, error: 'CANCELLED' }), libRemoveFolder: async () => ({ ok: true }),
    libCollection: async (op, name) => { calls.push(['coll', op, name]); return { ok: true }; },
    locks: async () => ({ ok: true, locks }),
    saveLock: async (l) => { calls.push(['saveLock', l]); const lock = Object.assign({ id: 'lock-1' }, l, { id: 'lock-1' }); locks = [lock]; return { ok: true, lock }; },
    deleteLock: async () => { locks = []; return { ok: true }; },
    targets: async () => ({ ok: true, targets: over.targets || [{ id: 'sm:aaa', label: 'SD WebUI Forge', displayName: 'Forge', kind: 'forge', source: 'Stability Matrix', supported: true, hasPython: true }], runner: { phase: 'idle' }, install: { installed: false, phase: 'idle' }, startWithApp: false, targetId: '' }),
    start: async (id) => { calls.push(['start', id]); return { ok: true, runner: { phase: 'running', port: 7860, owned: true, message: '✔ SD WebUI Forge running on :7860 (managed)', target: { label: 'SD WebUI Forge' } } }; },
    stop: async () => { calls.push(['stop']); return { ok: true, runner: { phase: 'stopped' } }; },
    openLog: async () => ({ ok: true }), setAutostart: async (on) => { calls.push(['autostart', on]); return { ok: true }; },
    installCheck: async () => ({ ok: true, supported: true, installed: false, gpu: { message: 'NVIDIA GeForce RTX 4070 (12 GB) found — AutoInjector will install ComfyUI\'s NVIDIA build.' }, spaceMessage: 'Needs about 9.2 GB free (about 4 GB for ComfyUI plus 2–7 GB per model); this drive has 120.0 GB free.', enoughSpace: true, models: [{ id: 'sd15', label: 'DreamShaper 8 (SD 1.5) — 2.1 GB' }, { id: 'sdxl', label: 'SDXL base — 6.9 GB' }] }),
    install: async () => { calls.push(['install']); return { ok: true, verified: true }; },
    installModel: async (id) => { calls.push(['installModel', id]); return { ok: true }; },
    installCancel: async () => ({ ok: true }), openInstallFolder: async () => ({ ok: true }),
    onRunner: () => {}, onInstall: () => {}, onConnected: () => {},
    // the advanced sections
    extras: async () => { calls.push(['extras']); const comfy = status.backend === 'comfy'; return { ok: true, backend: comfy ? 'comfy' : 'a1111', upscalers: comfy ? ['Latent', '4x-UltraSharp.pth'] : ['Latent', 'Latent (bicubic)', 'R-ESRGAN 4x+', '4x-UltraSharp'], upscaleModels: comfy ? ['4x-UltraSharp.pth'] : ['None', 'R-ESRGAN 4x+', '4x-UltraSharp'], controlnet: { models: ['control_v11p_sd15_canny [d14c016b]'], modules: ['none', 'canny'] }, adetailer: comfy ? null : { models: ['face_yolov8n.pt', 'hand_yolov8n.pt'] }, styles: comfy ? [] : ['Cinematic', 'Oil painting'], scripts: comfy ? null : { txt2img: ['x/y/z plot'], img2img: ['loopback'] }, optionKeys: comfy ? [] : ['CLIP_stop_at_last_layers', 'jpeg_quality'], workflows: [{ id: 'portrait-flow', name: 'Portrait flow', params: ['prompt', 'seed'] }] }; },
    img2img: async (req) => { calls.push(['img2img', req]); return { ok: true, seed: 3, warnings: [], settings: Object.assign({}, req), images: [{ path: '/out/images/img2img-1.png', url: 'file:///out/images/img2img-1.png', seed: 3 }] }; },
    inpaint: async (req) => { calls.push(['inpaint', req]); return { ok: true, seed: 4, warnings: [], settings: Object.assign({}, req), images: [{ path: '/out/images/inpaint-1.png', url: 'file:///out/images/inpaint-1.png', seed: 4 }] }; },
    upscale: async (req) => { calls.push(['upscale', req]); return { ok: true, settings: { kind: 'upscale', factor: req.factor, upscaler: req.upscaler }, images: [{ path: '/out/images/upscale-1.png', url: 'file:///out/images/upscale-1.png' }] }; },
    optionsGet: async (keys) => { calls.push(['optionsGet', keys]); return { ok: true, options: { [keys[0]]: 1 } }; },
    optionsSet: async (o) => { calls.push(['optionsSet', o]); return { ok: true }; },
    workflowSave: async (w) => { calls.push(['workflowSave', w]); return { ok: true, workflow: { id: 'my-flow', name: w.name, params: ['prompt'] } }; },
    workflowRun: async (r) => { calls.push(['workflowRun', r]); return { ok: true, settings: { kind: 'workflow', workflowName: 'Portrait flow' }, images: [{ path: '/out/images/workflow-1.png', url: 'file:///out/images/workflow-1.png' }] }; },
  };
  return { sd, calls, setStatus: (s) => { status = Object.assign({}, status, s); } };
}

async function load(over) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'controls.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/controls.html' });
  const h = makeSd(over);
  const known = { sd: h.sd, akoweTab: async (a) => { h.calls.push(['akoweTab', a]); return {}; } };
  dom.window.api = new Proxy(known, { get(t, k) { if (k in t) return t[k]; if (typeof k === 'string' && /^on[A-Z]/.test(k)) return () => {}; return async () => ({}); } });
  dom.window.confirm = () => true;
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true });
  try { dom.window.eval(fs.readFileSync(path.join(__dirname, '..', 'controls.js'), 'utf8')); } catch (e) { console.log('controls.js threw (ignored for this test):', e.message); }
  dom.window.eval(fs.readFileSync(path.join(__dirname, '..', 'images-studio.js'), 'utf8'));
  await tick(30);
  const d = dom.window.document;
  return Object.assign(h, { dom, d, $: (id) => d.getElementById(id), click: (id) => d.getElementById(id).dispatchEvent(new dom.window.Event('click', { bubbles: true })), fire: (el, type) => el.dispatchEvent(new dom.window.Event(type, { bubbles: true })) });
}

(async () => {
  console.log('== the 🎨 Images tab ==');
  let t = await load();
  assert(t.$('tab-app-images') && t.$('images-tab').hidden, 'the 🎨 Images tab button exists; its panel starts hidden');
  t.click('tab-app-images');
  await tick(80);
  assert(t.d.body.dataset.appTab === 'images' && !t.$('images-tab').hidden && t.$('tab-app-images').getAttribute('aria-selected') === 'true', 'clicking it shows the Images panel (and hides the rest via CSS)');
  assert(t.calls.some((c) => c[0] === 'akoweTab' && c[1] === false), 'it tells main to hide the Akọwe view');
  assert(/Not connected yet/.test(t.$('sd-hint').textContent) && !t.$('sd-hint').hidden, 'not connected → a plain hint with what to do');
  assert(!t.$('btn-sd-run').hidden && /Start SD WebUI Forge with API/.test(t.$('btn-sd-run').textContent), 'a Stability Matrix package was found → "▶ Start SD WebUI Forge with API" on the bar');

  console.log('== connect ==');
  t.click('btn-sd-find');
  await tick(80);
  assert(t.calls.some((c) => c[0] === 'detect') && t.calls.some((c) => c[0] === 'connect' && c[1] === 'http://127.0.0.1:7860'), 'Find my SD app → detect, then connect to the best one');
  assert(/✔ Connected to Forge on :7860 — model dreamshaper_8/.test(t.$('sd-status-text').textContent), `status line: "${t.$('sd-status-text').textContent}"`);
  assert(t.$('sd-dot').dataset.tone === 'ok' && t.$('sd-tab-dot').dataset.tone === 'ok', 'the dots turn green');
  assert(t.$('sd-checkpoint').options.length === 3 && [...t.$('sd-sampler').options].some((o) => o.value === 'DPM++ 2M') && [...t.$('sd-vae').options].some((o) => o.value === 'vae-ft-mse'), 'checkpoint / sampler / VAE lists filled from the SD app');

  console.log('== LoRA picker ==');
  t.$('sd-prompt').value = 'portrait of a ferry captain';
  t.$('sd-lora-search').value = 'odile';
  t.fire(t.$('sd-lora-search'), 'input');
  await tick(30);
  const sugg = t.d.querySelector('.sd-sugg');
  assert(sugg && /odile_face/.test(sugg.textContent) && /SD1\.5/.test(sugg.textContent), 'typing shows matching LoRAs with their base model');
  sugg.dispatchEvent(new t.dom.window.Event('mousedown', { bubbles: true }));
  await tick(40);
  const chip = t.d.querySelector('.sd-chip');
  assert(chip && chip.dataset.name === 'odile_face' && chip.querySelector('input').value === '0.7', 'picking one adds a chip with its default weight (0.7)');
  assert(/odile woman/.test(t.$('sd-prompt').value), 'its trigger words are added to the prompt');
  assert(/<lora:odile_face:0\.7>/.test(t.$('sd-final-prompt').textContent), 'the A1111 syntax is shown: <lora:odile_face:0.7>');
  t.$('sd-checkpoint').value = 'juggernautXL_v9.safetensors [c9]';
  t.fire(t.$('sd-checkpoint'), 'change');
  await tick(40);
  assert(/made for SD1\.5/.test(t.$('sd-warnings').textContent) && t.d.querySelector('.sd-chip').dataset.compat === 'hard', 'choosing an SDXL checkpoint warns that the SD1.5 LoRA won\'t work (chip turns red)');
  t.$('sd-checkpoint').value = 'dreamshaper_8.safetensors [879db523c3]';
  t.fire(t.$('sd-checkpoint'), 'change');
  await tick(40);
  assert(t.$('sd-warnings').textContent === '', 'back to a matching checkpoint → warning gone');

  console.log('== generate ==');
  t.click('btn-sd-generate');
  await tick(20);
  assert(t.$('btn-sd-stop').disabled === false && t.$('btn-sd-generate').disabled, 'while rendering: Generate disabled, Stop enabled');
  await tick(1100);
  const gen = t.calls.find((c) => c[0] === 'generate');
  assert(gen && gen[1].loras[0].name === 'odile_face' && gen[1].loras[0].weight === 0.7 && gen[1].checkpoint === 'dreamshaper_8.safetensors [879db523c3]' && gen[1].sampler === '' && gen[1].width === 512, 'Generate sends prompt, LoRAs with weights, checkpoint, size');
  assert(t.calls.some((c) => c[0] === 'progress'), 'progress was polled while rendering');
  assert(/1 picture saved \(seed 1234\)/.test(t.$('sd-msg').textContent) && t.$('sd-preview').src.endsWith('sd-1.png') && !t.$('sd-preview').hidden, 'the result is shown with its seed');
  assert(t.d.querySelectorAll('#sd-gallery img').length === 1, 'the gallery lists saved pictures');
  t.d.querySelector('#sd-gallery img').dispatchEvent(new t.dom.window.Event('click', { bubbles: true }));
  await tick(10);
  assert(/an old lighthouse/.test(t.$('sd-preview-info').textContent) && /seed 777/.test(t.$('sd-preview-info').textContent), 'clicking a gallery picture shows its recorded settings');
  t.click('btn-sd-remake');
  await tick(10);
  assert(t.$('sd-prompt').value === 'an old lighthouse' && t.$('sd-seed').value === '777' && t.$('sd-steps').value === '30' && t.$('sd-width').value === '640' && t.$('sd-sampler').value === 'DPM++ 2M' && t.d.querySelector('.sd-chip input').value === '0.6', 'Remake puts the exact settings (seed, steps, size, sampler, LoRA weight) back');
  t.click('btn-sd-showfile');
  await tick(10);
  assert(t.calls.some((c) => c[0] === 'showFile' && c[1] === '/out/images/old.png'), 'Show file');
  t.click('btn-sd-test');
  await tick(900);
  assert(t.calls.some((c) => c[0] === 'test') && /Stable Diffusion works!/.test(t.$('sd-msg').textContent), '🧪 Test makes the 512px picture and says it works');

  console.log('== library ==');
  t.click('sd-sub-library');
  await tick(80);
  assert(!t.$('sd-view-library').hidden && t.$('sd-view-generate').hidden, 'Library view shown');
  const cards = t.d.querySelectorAll('.sd-libcard');
  assert(cards.length === 2 && /odile_face/.test(cards[0].textContent) && /SD1\.5/.test(cards[0].textContent) && /odile woman/.test(cards[0].textContent), 'cards show name, base model, trigger words');
  assert(/1 model folder/.test(t.$('sd-lib-summary').textContent) && /Stability Matrix/.test(t.$('sd-lib-folders').textContent), 'the folder summary names where models come from');
  cards[0].dispatchEvent(new t.dom.window.Event('click', { bubbles: true }));
  await tick(60);
  assert(!t.$('sd-lib-editor').hidden && t.$('sd-ed-fav').checked && t.$('sd-ed-tags').value === 'face' && /silver hair/.test(t.$('sd-ed-dataset').textContent), 'the editor shows favourite, tags, dataset tags');
  t.$('sd-ed-tags').value = 'face, heroine';
  t.$('sd-ed-weight').value = '0.65';
  t.d.querySelector('#sd-ed-colls input[value="Styles"]').checked = true;
  t.click('btn-sd-ed-save');
  await tick(60);
  const up = t.calls.find((c) => c[0] === 'libUpdate');
  assert(up && up[1] === 'lora:odile_face' && up[2].tags === 'face, heroine' && up[2].defaultWeight === 0.65 && up[2].collections.includes('Styles') && up[2].collections.includes('Characters'), 'Save sends tags, weight and collections');
  assert(/model files are not changed/.test(t.$('sd-ed-msg').textContent), 'and says the model files are not changed');
  t.$('sd-lib-kind').value = 'checkpoint';
  t.fire(t.$('sd-lib-kind'), 'change');
  await tick(300);
  assert(t.calls.some((c) => c[0] === 'libList' && c[1] && c[1].kind === 'checkpoint'), 'filters go to the library');
  t.$('sd-lib-newcoll-name').value = "Odile's look";
  t.click('btn-sd-lib-newcoll');
  await tick(30);
  assert(t.calls.some((c) => c[0] === 'coll' && c[1] === 'add' && c[2] === "Odile's look"), '＋ Collection adds a collection');

  console.log('== character locks ==');
  t.click('sd-sub-locks');
  await tick(40);
  t.$('sd-lk-character').value = 'Odile';
  t.$('sd-lk-loras').value = 'odile_face:0.75, <lora:ink:0.4>';
  t.$('sd-lk-triggers').value = 'odile woman';
  t.$('sd-lk-prompt').value = 'silver hair, navy coat';
  t.click('btn-sd-lk-save');
  await tick(60);
  const sl = t.calls.find((c) => c[0] === 'saveLock');
  assert(sl && sl[1].character === 'Odile' && sl[1].loras.length === 2 && sl[1].loras[0].weight === 0.75 && sl[1].loras[1].name === 'ink' && sl[1].loras[1].weight === 0.4 && sl[1].triggerWords[0] === 'odile woman', 'Save lock parses "name:weight" and <lora:…> forms');
  assert(t.d.querySelectorAll('.sd-lockitem').length === 1 && [...t.$('sd-lock-pick').options].some((o) => o.value === 'lock-1'), 'the lock is listed and offered in the generator');

  console.log('== start & install ==');
  t.click('sd-sub-setup');
  await tick(80);
  assert(/RTX 4070/.test(t.$('sd-install-check').textContent) && /4 GB for ComfyUI/.test(t.$('sd-install-check').textContent), 'install box shows the GPU check and disk space in plain words');
  assert(t.$('sd-run-target').value === 'sm:aaa', 'the Stability Matrix package is selected');
  t.click('btn-sd-run2');
  await tick(80);
  assert(t.calls.some((c) => c[0] === 'start' && c[1] === 'sm:aaa') && /running on :7860 \(managed\)/.test(t.$('sd-run-state').textContent), '▶ Start → "✔ SD WebUI Forge running on :7860 (managed)"');
  t.$('sd-autostart').checked = true; t.fire(t.$('sd-autostart'), 'change');
  await tick(10);
  assert(t.calls.some((c) => c[0] === 'autostart' && c[1] === true), '"Start Stable Diffusion with AutoInjector" is saved');
  t.click('btn-sd-install');
  await tick(80);
  assert(t.calls.some((c) => c[0] === 'install') && /installed \(checksum verified\)/.test(t.$('sd-install-msg').textContent), '⬇ Install runs and reports the verified install');

  console.log('== more settings: hires, refiner, clip skip, extra fields ==');
  t.click('sd-sub-generate');
  await tick(20);
  assert(t.calls.some((c) => c[0] === 'extras') && [...t.$('sd-hr-upscaler').options].some((o) => o.value === 'R-ESRGAN 4x+') && [...t.$('sd-rf-checkpoint').options].some((o) => /juggernaut/.test(o.value)), 'after connecting, the sections get the upscalers and checkpoints');
  assert(!t.$('sd-sec-ad').hidden && t.$('sd-sec-wf').hidden && [...t.$('sd-adv-styles').options].length === 2 && [...t.$('sd-opt-keys').options].length === 2, 'Forge: ADetailer / styles / settings shown; the ComfyUI workflow picker hidden');
  assert([...t.d.querySelectorAll('details.sd-adv')].every((d) => !d.open) && !t.$('sd-hr-on').checked && t.$('sd-i2i-mode').value === '', 'all sections start closed and off (the plain form is unchanged)');
  t.$('sd-prompt').value = 'a lighthouse at dusk';
  t.$('sd-hr-on').checked = true; t.fire(t.$('sd-hr-on'), 'change');
  t.$('sd-hr-scale').value = '1.5'; t.$('sd-hr-upscaler').value = 'R-ESRGAN 4x+'; t.$('sd-hr-denoise').value = '0.35';
  t.$('sd-rf-on').checked = true; t.$('sd-rf-checkpoint').value = 'juggernautXL_v9.safetensors [c9]';
  t.$('sd-adv-clipskip').value = '2'; t.$('sd-adv-restore').checked = true;
  t.$('sd-adv-styles').options[0].selected = true;
  t.$('sd-adv-script').value = 'x/y/z plot'; t.$('sd-adv-script-args').value = '[1, "10,20"]';
  t.$('sd-adv-extra').value = '{ "s_churn": 0.5 }';
  t.$('sd-adv-override').value = '{ "eta_noise_seed_delta": 31337 }';
  t.$('sd-ad-on').checked = true; t.$('sd-ad-model').value = 'hand_yolov8n.pt';
  t.fire(t.$('sd-adv-extra'), 'input');
  assert(/on ×1\.5/.test(t.$('sd-hr-badge').textContent) && /clip skip 2/.test(t.$('sd-adv-badge').textContent) && /extra/.test(t.$('sd-adv-badge').textContent), 'section headers show what is switched on');
  let n0 = t.calls.filter((c) => c[0] === 'generate').length;
  t.click('btn-sd-generate');
  await tick(900);
  let g2 = t.calls.filter((c) => c[0] === 'generate')[n0];
  assert(g2 && g2[1].hires.scale === 1.5 && g2[1].hires.upscaler === 'R-ESRGAN 4x+' && g2[1].hires.denoise === 0.35 && g2[1].refiner.checkpoint === 'juggernautXL_v9.safetensors [c9]' && g2[1].refiner.switchAt === 0.8, 'Generate sends hires fix + refiner');
  assert(g2[1].clipSkip === 2 && g2[1].restoreFaces === true && g2[1].styles[0] === 'Cinematic' && g2[1].script.name === 'x/y/z plot' && g2[1].script.args[1] === '10,20' && g2[1].extra.s_churn === 0.5 && g2[1].overrideSettings.eta_noise_seed_delta === 31337 && g2[1].adetailer[0].model === 'hand_yolov8n.pt', '…and clip skip, restore faces, styles, script, extra fields, override settings, ADetailer');
  t.$('sd-adv-extra').value = '{ s_churn: 0.5 ';
  n0 = t.calls.filter((c) => c[0] === 'generate').length;
  t.click('btn-sd-generate');
  await tick(30);
  assert(t.calls.filter((c) => c[0] === 'generate').length === n0 && /Extra fields: that isn't valid JSON/.test(t.$('sd-msg').textContent), 'bad JSON in Extra fields → a plain message, nothing sent');
  for (const id of ['sd-hr-on', 'sd-rf-on', 'sd-adv-restore', 'sd-ad-on']) t.$(id).checked = false;
  for (const id of ['sd-adv-clipskip', 'sd-adv-extra', 'sd-adv-override', 'sd-adv-script-args']) t.$(id).value = '';
  t.$('sd-adv-script').value = ''; t.$('sd-adv-styles').options[0].selected = false;

  console.log('== img2img / inpaint with the mask brush, ControlNet, upscale ==');
  const W = t.dom.window;
  const ctxCalls = [];
  W.HTMLCanvasElement.prototype.getContext = function () { const c = this; return { clearRect: () => ctxCalls.push('clear'), fillRect: () => ctxCalls.push('fillRect'), drawImage: () => ctxCalls.push('drawImage'), beginPath: () => {}, moveTo: () => {}, lineTo: () => {}, stroke: () => ctxCalls.push('stroke'), arc: () => {}, fill: () => ctxCalls.push('dot'), set fillStyle(v) { c._fill = v; }, set strokeStyle(v) {}, set lineWidth(v) {}, set lineCap(v) {}, set lineJoin(v) {}, set globalCompositeOperation(v) { c._op = v; } }; };
  W.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,TUFTSw==';
  t.d.querySelector('#sd-gallery img').dispatchEvent(new W.Event('click', { bubbles: true }));
  await tick(10);
  t.$('sd-i2i-mode').value = 'img2img'; t.fire(t.$('sd-i2i-mode'), 'change');
  t.click('btn-sd-generate');
  await tick(30);
  assert(/Choose the start picture first/.test(t.$('sd-msg').textContent), 'img2img without a start picture → says what to do');
  t.click('btn-sd-i2i-current');
  await tick(10);
  assert(!t.$('sd-mask-wrap').hidden && /old\.png/.test(t.$('sd-i2i-img').src) && /img2img/.test(t.$('btn-sd-generate').textContent), '"Use result" puts the shown picture in as the start picture');
  t.$('sd-i2i-denoise').value = '0.45'; t.$('sd-i2i-resize').value = 'crop and resize';
  t.click('btn-sd-generate');
  await tick(60);
  let ic = t.calls.find((c) => c[0] === 'img2img');
  assert(ic && ic[1].initImage === '/out/images/old.png' && ic[1].denoise === 0.45 && ic[1].resizeMode === 'crop and resize' && !ic[1].mask, 'img2img → api.img2img with the picture\'s path, denoise, resize mode');
  t.$('sd-i2i-mode').value = 'inpaint'; t.fire(t.$('sd-i2i-mode'), 'change');
  assert(!t.$('sd-inpaint-opts').hidden && !t.$('sd-mask-tools').hidden && /Inpaint/.test(t.$('btn-sd-generate').textContent), 'Inpaint mode shows the brush tools and inpaint options');
  t.click('btn-sd-generate');
  await tick(30);
  assert(/Brush over the part to repaint/.test(t.$('sd-msg').textContent) && !t.calls.some((c) => c[0] === 'inpaint'), 'Inpaint with an empty mask → asks you to brush first');
  const cv = t.$('sd-mask-canvas');
  cv.dispatchEvent(new W.MouseEvent('pointerdown', { clientX: 10, clientY: 10, bubbles: true }));
  cv.dispatchEvent(new W.MouseEvent('pointermove', { clientX: 40, clientY: 30, bubbles: true }));
  cv.dispatchEvent(new W.MouseEvent('pointerup', { bubbles: true }));
  assert(ctxCalls.includes('dot') && ctxCalls.includes('stroke') && cv._op === 'source-over', 'brushing paints white strokes on the mask canvas');
  t.$('sd-ip-fill').value = 'latent noise'; t.$('sd-ip-blur').value = '8'; t.$('sd-ip-only').checked = true; t.$('sd-ip-pad').value = '48';
  t.click('btn-sd-generate');
  await tick(60);
  ic = t.calls.find((c) => c[0] === 'inpaint');
  assert(ic && ic[1].initImage === '/out/images/old.png' && ic[1].mask === 'data:image/png;base64,TUFTSw==' && ic[1].inpaint.fill === 'latent noise' && ic[1].inpaint.maskBlur === 8 && ic[1].inpaint.onlyMasked === true && ic[1].inpaint.padding === 48, 'Inpaint → api.inpaint with the mask (white on black PNG) and the inpaint options');
  assert(ctxCalls.includes('fillRect') && ctxCalls.includes('drawImage'), 'the mask is exported on a black background');
  t.$('sd-i2i-mode').value = ''; t.fire(t.$('sd-i2i-mode'), 'change');
  t.click('btn-sd-cn-add');
  await tick(10);
  const unit = t.d.querySelector('.sd-cn-unit');
  assert(unit && unit.querySelector('.cn-model').value === 'control_v11p_sd15_canny [d14c016b]' && [...unit.querySelector('.cn-module').options].some((o) => o.value === 'canny') && /1 unit/.test(t.$('sd-cn-badge').textContent), '＋ Add a ControlNet unit: models and preprocessors listed');
  t.click('btn-sd-generate');
  await tick(30);
  assert(/needs a control picture/.test(t.$('sd-msg').textContent), 'a unit without a control picture → plain message');
  unit.querySelector('.cn-current').dispatchEvent(new W.Event('click', { bubbles: true }));
  unit.querySelector('.cn-module').value = 'canny'; unit.querySelector('.cn-weight').value = '0.7'; unit.querySelector('.cn-pp').checked = true;
  n0 = t.calls.filter((c) => c[0] === 'generate').length;
  t.click('btn-sd-generate');
  await tick(900);
  g2 = t.calls.filter((c) => c[0] === 'generate')[n0];
  assert(g2 && g2[1].controlnet.length === 1 && g2[1].controlnet[0].image === '/out/images/inpaint-1.png' && g2[1].controlnet[0].module === 'canny' && g2[1].controlnet[0].weight === 0.7 && g2[1].controlnet[0].pixelPerfect === true && g2[1].controlnet[0].controlMode === 'Balanced', 'Generate sends the ControlNet unit (picture, preprocessor, model, weight, pixel perfect, mode)');
  unit.querySelector('.cn-remove').dispatchEvent(new W.Event('click', { bubbles: true }));
  assert(!t.d.querySelector('.sd-cn-unit') && t.$('sd-cn-badge').textContent === '', '× removes the unit');
  assert(!t.$('btn-sd-upscale').disabled, 'Upscale is enabled when a picture is shown');
  t.$('sd-up-upscaler').value = '4x-UltraSharp'; t.$('sd-up-factor').value = '3';
  t.click('btn-sd-upscale');
  await tick(60);
  const uc = t.calls.find((c) => c[0] === 'upscale');
  assert(uc && uc[1].upscaler === '4x-UltraSharp' && uc[1].factor === 3 && /upscale-1\.png/.test(t.$('sd-preview').src) && /Upscaled/.test(t.$('sd-msg').textContent), '⤢ Upscale → api.upscale(picture, upscaler, factor); the result is shown');

  console.log('== settings menu: read / set any option ==');
  t.$('sd-opt-key').value = 'CLIP_stop_at_last_layers';
  t.click('btn-sd-opt-get');
  await tick(20);
  assert(t.calls.some((c) => c[0] === 'optionsGet' && c[1][0] === 'CLIP_stop_at_last_layers') && t.$('sd-opt-value').value === '1', 'Read shows the option\'s current value');
  t.$('sd-opt-value').value = '2';
  t.click('btn-sd-opt-set');
  await tick(20);
  assert(t.calls.some((c) => c[0] === 'optionsSet' && c[1].CLIP_stop_at_last_layers === 2) && /is now 2/.test(t.$('sd-opt-msg').textContent), 'Set sends the value (JSON-parsed: 2 is a number)');

  console.log('== ComfyUI: the workflow picker ==');
  const tc = await load({ connect: (url) => { tc.setStatus({ enabled: true, endpoint: url, backend: 'comfy', base: url, label: 'ComfyUI' }); return { ok: true, kind: 'comfy', label: 'ComfyUI', port: 8188, message: 'Connected to ComfyUI on :8188', status: Object.assign({}, { enabled: true, endpoint: url, backend: 'comfy', base: url, label: 'ComfyUI' }) }; } });
  tc.click('tab-app-images');
  await tick(60);
  tc.$('sd-url').value = 'http://127.0.0.1:8188';
  tc.click('btn-sd-connect');
  await tick(80);
  assert(!tc.$('sd-sec-wf').hidden && tc.$('sd-sec-ad').hidden && [...tc.$('sd-wf-pick').options].some((o) => o.value === 'portrait-flow'), 'ComfyUI: the workflow picker is shown (ADetailer hidden) and lists saved workflows');
  tc.$('sd-wf-pick').value = 'portrait-flow'; tc.fire(tc.$('sd-wf-pick'), 'change');
  assert(/prompt, seed/.test(tc.$('sd-wf-params-list').textContent), 'picking one shows its parameters');
  tc.$('sd-prompt').value = 'an old sailor';
  tc.$('sd-wf-params').value = '{ "seed": 42 }';
  tc.click('btn-sd-wf-run');
  await tick(60);
  const wr = tc.calls.find((c) => c[0] === 'workflowRun');
  assert(wr && wr[1].id === 'portrait-flow' && wr[1].params.seed === 42 && wr[1].params.prompt === 'an old sailor' && /workflow-1\.png/.test(tc.$('sd-preview').src), '▶ Run workflow sends the params (prompt from the prompt box) and shows the picture');
  tc.$('sd-wf-json').value = '{ "3": { "class_type": "KSampler", "inputs": {} } }'; tc.$('sd-wf-name').value = 'My flow';
  tc.click('btn-sd-wf-save');
  await tick(40);
  const ws = tc.calls.find((c) => c[0] === 'workflowSave');
  assert(ws && ws[1].name === 'My flow' && ws[1].workflow['3'].class_type === 'KSampler' && /Saved “My flow”/.test(tc.$('sd-wf-msg').textContent), 'Save workflow sends the pasted API JSON');
  tc.$('sd-wf-json').value = '{ nope';
  tc.click('btn-sd-wf-save');
  await tick(20);
  assert(/isn't valid JSON/.test(tc.$('sd-wf-msg').textContent), 'pasting bad JSON → plain message');

  console.log('== the --api mistake ==');
  t = await load({
    detect: { ok: true, found: [], problems: [{ kind: 'webui-no-api', port: 7860, base: 'http://127.0.0.1:7860', usable: false, message: 'A Stable Diffusion WebUI is running on port 7860, but its API is switched off… In Stability Matrix: … tick “API” (or type --api …)' }], best: null, message: 'x' },
    targets: [],
  });
  t.click('tab-app-images');
  await tick(60);
  t.click('btn-sd-find');
  await tick(60);
  assert(/API is switched off/.test(t.$('sd-hint').textContent) && /--api/.test(t.$('sd-hint').textContent) && t.$('sd-hint').dataset.tone === 'warn', 'a WebUI without --api → the exact fix is shown');
  assert(/API is off/.test(t.$('sd-status-text').textContent), 'status line says the API is off');
  assert(t.$('btn-sd-run').hidden, 'no packages → no Start button on the bar');
  t.click('tab-app-main');
  await tick(20);
  assert(t.$('images-tab').hidden && t.d.body.dataset.appTab !== 'images', 'back to 🤖 AutoInjector hides the Images panel');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
