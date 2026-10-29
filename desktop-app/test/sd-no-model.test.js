// test/sd-no-model.test.js — PC test problem 5: Forge (Stability Matrix) was running and the 🎨 Images tab said
// "Connected ✓", but its Checkpoint list was empty, so every picture failed "Failed to find available model" —
// also Alfred's pictures. Six models sat in Stability Matrix's shared Data/Models/StableDiffusion folder, which
// Forge wasn't pointed at. Against the fake Forge with NO model (fake-sd.js noModels):
//   • connect: "Connected, but Forge has no picture model loaded" + where the models are + --ckpt-dir "<folder>"
//   • a picture / the 🧪 Test: NO_MODEL in plain words with the same fix (and "↻ Restart Forge with my models")
//   • the Images tab: amber dot, "⚠ Connected, but Forge has no picture model loaded", the fix and the button
//   • Alfred's generate_image (image adapter) and image_generator_status say so; 🩺 health watch / Check everything
//   • the runner restarts a Stability Matrix Forge with --ckpt-dir
// Run: node test/sd-no-model.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');
const { fakeA1111 } = require('./fixtures/fake-sd');
const sdBackends = require('../sd-backends');
const sdErrors = require('../sd-errors');
const ip = require('../image-provider');
const L = require('../sd-library');
const { createSdStudio } = require('../sd-studio');
const hw = require('../health-watch');
const { createImageAdapter } = require('../alfred-image');
const registry = require('../alfred-tools');
const runner = require('../sd-runner');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-nomodel-'));
  // Stability Matrix's shared models folder with two checkpoints (tiny stand-ins: the library reads headers only)
  const smModels = path.join(tmp, 'StabilityMatrix', 'Data', 'Models');
  const ckDir = path.join(smModels, 'StableDiffusion');
  fs.mkdirSync(ckDir, { recursive: true });
  for (const n of ['dreamshaper_8.safetensors', 'juggernautXL_v9.safetensors']) fs.writeFileSync(path.join(ckDir, n), Buffer.alloc(3 * 1024 * 1024));
  const forge = await fakeA1111({ flavor: 'forge', noModels: true });

  console.log('== the server\'s words -> plain words ==');
  {
    const ex = sdErrors.explainSdError({ ok: false, error: 'HTTP_500', status: 500, json: { error: 'ValueError', detail: '', body: '', errors: 'Failed to find available model' } }, { label: 'Forge' });
    assert(ex.known && ex.code === 'NO_MODEL', `“Failed to find available model” -> NO_MODEL (${ex.code})`);
    assert(/Forge is running, but it has no picture model \(checkpoint\) loaded/.test(ex.message) && /--ckpt-dir/.test(ex.fix) && /Data\/Models\/StableDiffusion/.test(ex.fix), `message: “${ex.message}”`);
    assert(sdErrors.explainSdError({ ok: false, json: { errors: "You do not have any model! Please download at least one model in [models/Stable-diffusion]." } }).code === 'NO_MODEL', 'Forge\'s other wording too');
  }

  console.log('\n== connect: not just “Connected ✓” ==');
  {
    const id = await sdBackends.identify(forge.base);
    assert(id.usable && id.noModels === true && id.models === 0, 'identify: it answers (usable) but noModels');
    assert(/Connected to Forge on :\d+, but Forge has no picture model loaded/.test(id.message), `identify message: “${id.message}”`);
    const lib = L.createLibrary({ storePath: path.join(tmp, 'lib.json'), env: {}, findStabilityMatrix: () => [{ models: smModels }], defaultFolders: [] });
    lib.scan();
    let canRestart = true;
    const studio = createSdStudio({ imageProvider: ip, library: lib, imagesDir: () => path.join(tmp, 'images'), log: () => {}, canRestartWithModels: () => canRestart });
    const r = await studio.connect(forge.base);
    assert(r.ok && r.noModels && r.status.noModels, 'connect: ok (it answers), noModels, and status() says so');
    assert(/^Connected, but Forge has no picture model loaded/.test(r.message), `connect message: “${r.message}”`);
    assert(r.fix.includes(ckDir) && r.fix.includes(`--ckpt-dir "${ckDir}"`) && /2 picture models/.test(r.fix) && /Launch Options/.test(r.fix), `fix names the folder the library found and the launch option:\n        ${r.fix}`);
    assert(r.help.ckptDir === ckDir && r.help.actions[0] && r.help.actions[0].id === 'restart-with-models', 'help: the folder + “↻ Restart Forge with my models”');
    assert(!r.model, 'no stale “— model …” on the status line');

    console.log('\n== a picture / the 🧪 Test ==');
    const g = await studio.generate({ prompt: 'a lighthouse' }, 'images-tab');
    assert(!g.ok && g.code === 'NO_MODEL' && /no picture model/.test(g.message) && g.fix.includes(ckDir), `generate: NO_MODEL in plain words (“${g.message}”)`);
    assert(Array.isArray(g.actions) && g.actions.some((a) => a.id === 'restart-with-models'), 'with the restart button');
    assert(forge.state.txt2imgCalls === undefined || forge.state.txt2imgCalls <= 2, 'no retry storm');
    const t = await studio.test();
    assert(!t.ok && t.code === 'NO_MODEL' && t.fix.includes('--ckpt-dir'), '🧪 Test: the same plain words');
    const mc = await studio.modelCheck();
    assert(mc.connected && mc.reachable && mc.noModels && mc.checkpoints === 0 && mc.fix.includes(ckDir), 'modelCheck (🩺 / Check everything): no models, with the fix');
    canRestart = false;
    assert(!studio.modelHelp().actions.length && !/Restart Forge with my models/.test(studio.modelHelp().fix), 'no SM package AutoInjector can start: no restart button');

    console.log('\n== Alfred ==');
    const sdApi = { get: () => ({ images: { generate: (req) => studio.request(Object.assign({ engine: 'sd' }, req)) }, library: { characterLock: async () => null } }) };
    const ad = createImageAdapter({ imageProvider: ip, outputManager: {}, dbService: {}, sdApi });
    const ar = await ad.generate({ prompt: 'a lighthouse' });
    assert(!ar.ok && ar.error === 'NO_MODEL' && /no picture model/.test(ar.message) && ar.message.includes(ckDir), `generate_image: “${ar.message.slice(0, 140)}…”`);
    const gi = await registry.get('generate_image').run({ prompt: 'a lighthouse' }, { generateImage: (o) => ad.generate(o) });
    assert(!gi.ok && /no picture model/.test(gi.message) && !/^The image couldn't be made/.test(gi.message), 'the tool result tells the AI the real cause and the fix');
    const st = await registry.get('image_generator_status').run({}, { sdStatus: async () => ({ ok: true, image: ip.status(), managed: {} }) });
    assert(st.ok && st.data.connected && st.data.can_make_pictures === false && /no picture model loaded/.test(st.message), 'image_generator_status: connected, but can\'t make pictures — said plainly');

    console.log('\n== 🩺 health watch ==');
    const told = [];
    const w = hw.createHealthWatch({ noTimers: true, sd: () => ({ enabled: true, configured: true, base: forge.base }), probe: async () => true,
      sdModels: () => studio.modelCheck().then((m) => Object.assign(m, { canRestart: true })), notify: (n) => told.push(n),
      runFix: async (fix) => { told.push({ ran: fix.channel }); return { ok: true }; } });
    await w.runOnce({ only: ['sd'] });
    const p = w.problems().find((x) => x.code === 'sd-no-model');
    assert(p && /no picture model loaded/.test(p.text) && /Failed to find available model/.test(p.text) && p.text.includes(ckDir) && p.fix && /Restart Forge with my models/.test(p.fix.label), `health problem sd-no-model, told to Alfred, with a one-click fix (“${p && p.fix && p.fix.label}”)`);
    assert(told.some((n) => n.type === 'problem' && n.problem && n.problem.code === 'sd-no-model'), 'told once (Alfred + the Butler section)');
    await w.fix('sd-no-model');
    assert(told.some((n) => n.ran === 'sd:restart-with-models'), 'the fix button runs sd:restart-with-models');
  }

  console.log('\n== the Images tab ==');
  {
    const html = fs.readFileSync(path.join(__dirname, '..', 'controls.html'), 'utf8');
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/controls.html' });
    const calls = [];
    const status = { ok: true, enabled: true, endpoint: 'http://127.0.0.1:7860/sdapi/v1/txt2img', backend: 'a1111', base: 'http://127.0.0.1:7860', label: 'Forge', model: '', noModels: true, steps: 20, cfgScale: 7, width: 512, height: 512, batchSize: 1, seed: -1 };
    const help = { ckptDir: 'C:\\SM\\Data\\Models\\StableDiffusion', actions: [{ id: 'restart-with-models', label: '↻ Restart Forge with my models' }] };
    const sd = new Proxy({
      status: async () => status,
      connect: async () => ({ ok: true, noModels: true, label: 'Forge', message: 'Connected, but Forge has no picture model loaded — it can\'t make pictures yet.', fix: 'There are 6 picture models on this PC in C:\\SM\\Data\\Models\\StableDiffusion … add --ckpt-dir "C:\\SM\\Data\\Models\\StableDiffusion"', help, status }),
      lists: async () => ({ ok: true, backend: 'a1111', checkpoints: [], loras: [], samplers: ['Euler a'], schedulers: [], vaes: ['Automatic'], embeddings: [], current: {} }),
      restartWithModels: async () => { calls.push('restart'); status.noModels = false; return { ok: true, message: '✔ SD WebUI Forge restarted with your models (6 found).' }; },
      libList: async () => ({ ok: true, items: [], total: 0, collections: [], tags: [], folders: [] }), locks: async () => ({ ok: true, locks: [] }), gallery: async () => ({ ok: true, items: [] }),
      targets: async () => ({ ok: true, targets: [], runner: { phase: 'idle' }, install: {} }), extras: async () => ({ ok: false }),
    }, { get(t, k) { if (k in t) return t[k]; if (/^on[A-Z]/.test(String(k))) return () => {}; return async () => ({ ok: true }); } });
    dom.window.api = new Proxy({ sd }, { get(t, k) { if (k in t) return t[k]; if (/^on[A-Z]/.test(String(k))) return () => {}; return async () => ({}); } });
    dom.window.confirm = () => true;
    try { dom.window.eval(fs.readFileSync(path.join(__dirname, '..', 'controls.js'), 'utf8')); } catch (_) { /* not needed here */ }
    dom.window.eval(fs.readFileSync(path.join(__dirname, '..', 'images-studio.js'), 'utf8'));
    await tick(30);
    const d = dom.window.document;
    d.getElementById('tab-app-images').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await tick(80);
    const text = d.getElementById('sd-status-text').textContent;
    assert(/^⚠ Connected, but Forge has no picture model loaded/.test(text) && !/✔/.test(text), `status line: “${text}” (was “✔ Connected to Forge”)`);
    assert(d.getElementById('sd-dot').dataset.tone === 'warn' && d.getElementById('sd-tab-dot').dataset.tone === 'warn', 'amber dot (tab and bar), not green');
    assert(!d.getElementById('sd-hint').hidden && /--ckpt-dir/.test(d.getElementById('sd-hint').textContent), 'the hint says exactly what to do');
    const btn = d.querySelector('#sd-error-actions button[data-fix="restart-with-models"]');
    assert(btn && /Restart Forge with my models/.test(btn.textContent), 'and offers “↻ Restart Forge with my models”');
    btn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await tick(80);
    assert(calls[0] === 'restart' && /restarted with your models/.test(d.getElementById('sd-msg').textContent), 'the button restarts it through main');
    assert(/^✔ Connected to Forge/.test(d.getElementById('sd-status-text').textContent) && d.getElementById('sd-dot').dataset.tone === 'ok', 'afterwards: ✔ Connected, green');
  }

  console.log('\n== the runner: Forge from Stability Matrix with --ckpt-dir ==');
  {
    const t = { id: 'sm:1', kind: 'forge', label: 'SD WebUI Forge', supported: true, python: '/x/venv/bin/python', launchCommand: 'launch.py', dir: '/x', extraArgs: ['--xformers'] };
    const spec = runner.launchSpec(t, 7860, { ckptDir: ckDir });
    const i = spec.args.indexOf('--ckpt-dir');
    assert(i > 0 && spec.args[i + 1] === ckDir && spec.args.includes('--xformers') && spec.args.includes('--api'), `launch: ${spec.args.join(' ')}`);
    const own = runner.launchSpec(Object.assign({}, t, { extraArgs: ['--ckpt-dir', '/mine'] }), 7860, { ckptDir: ckDir });
    assert(own.args.filter((a) => a === '--ckpt-dir').length === 1 && own.args.includes('/mine'), 'the user\'s own --ckpt-dir is kept, never doubled');
    assert(!runner.launchSpec(Object.assign({}, t, { kind: 'comfy' }), 8188, { ckptDir: ckDir }).args.includes('--ckpt-dir'), 'ComfyUI is never given --ckpt-dir');
  }

  await forge.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
