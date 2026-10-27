// test/sd-sanitize.test.js — "make it safe before sending" (sd-sanitize.js + sd-studio.js):
// names matched to the SD app's own lists (case / punctuation, "dpm++ 2m karras" split into
// sampler + schedule, checkpoints by file name), unknown names dropped with a plain warning,
// numbers clamped, model-family size warnings, and the ONE safe retry (unknown 500 → basics,
// OOM → smaller, broken VAE → Automatic for callers that can't click). Against the fake
// Forge (strictNames / rejectNonBasic / oomAbove / badVae) and the fake ComfyUI; Alfred's
// tool result carries the warnings. ChatGPT-engine calls are never retried.
// Run: node test/sd-sanitize.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const ip = require('../image-provider');
const L = require('../sd-library');
const S = require('../sd-sanitize');
const { createSdStudio } = require('../sd-studio');
const sdApi = require('../sd-api');
const { fakeA1111, fakeComfy } = require('./fixtures/fake-sd');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
function writeSafetensors(file, metadata) {
  const json = Buffer.from(JSON.stringify({ __metadata__: metadata, w: { dtype: 'F16', shape: [2], data_offsets: [0, 4] } }));
  const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(json.length));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([len, json, Buffer.from([1, 2, 3, 4])]));
}

const A_LISTS = {
  samplers: ['Euler a', 'Euler', 'DPM++ 2M', 'DPM++ 2M SDE'], schedulers: ['Automatic', 'Uniform', 'Karras', 'Exponential', 'SGM Uniform'],
  checkpoints: [{ name: 'dreamshaper_8.safetensors [879db523c3]', title: 'dreamshaper_8.safetensors [879db523c3]', model_name: 'dreamshaper_8', file: '/m/Stable-diffusion/dreamshaper_8.safetensors' }, { name: 'juggernautXL_v9.safetensors [c9e3e68f89]', title: 'juggernautXL_v9.safetensors [c9e3e68f89]', model_name: 'juggernautXL_v9', file: '/m/Stable-diffusion/juggernautXL_v9.safetensors' }],
  vaes: ['Automatic', 'None', 'vae-ft-mse-840000'], loras: [{ name: 'odile_face', alias: 'odile_face', file: '/m/Lora/odile_face.safetensors' }],
  upscalers: ['Latent', 'Lanczos', 'R-ESRGAN 4x+', '4x-UltraSharp'],
};
const C_LISTS = { samplers: ['euler', 'euler_ancestral', 'dpmpp_2m'], schedulers: ['normal', 'karras', 'simple'], checkpoints: [{ name: 'sd15/dreamshaper_8.safetensors', title: 'sd15/dreamshaper_8.safetensors' }], vaes: ['Automatic', 'vae-ft-mse-840000.safetensors'], loras: [{ name: 'Characters\\odile_face.safetensors', alias: 'odile_face' }], upscalers: ['Latent', '4x-UltraSharp.pth'] };
const FAM = (ck) => (/xl/i.test(String(ck || '')) ? 'SDXL' : ck ? 'SD1.5' : '');
const A = (o, cur) => S.sanitize(o, { backend: 'a1111', lists: A_LISTS, current: cur || {}, family: FAM });
const C = (o, cur) => S.sanitize(o, { backend: 'comfy', lists: C_LISTS, current: cur || {}, family: FAM });

async function main() {
  console.log('\n== names: matched to the server\'s own spelling ==');
  let r = A({ sampler: 'euler a' });
  assert(r.opts.sampler === 'Euler a' && !r.warnings.length, '"euler a" → "Euler a" (no warning for a spelling fix)');
  r = A({ sampler: 'dpm++ 2m karras' });
  assert(r.opts.sampler === 'DPM++ 2M' && r.opts.scheduler === 'Karras', '"dpm++ 2m karras" → sampler "DPM++ 2M" + scheduler "Karras" (Forge / A1111 ≥ 1.9)');
  r = A({ sampler: 'DPM++ 2M SDE Exponential', scheduler: 'Automatic' });
  assert(r.opts.sampler === 'DPM++ 2M SDE' && r.opts.scheduler === 'Exponential', '"DPM++ 2M SDE Exponential" with schedule Automatic → the schedule from the name');
  r = A({ sampler: 'dpm++ 2m karras', scheduler: 'uniform' });
  assert(r.opts.sampler === 'DPM++ 2M' && r.opts.scheduler === 'Uniform', 'an explicit schedule wins over the one in the sampler name');
  r = S.sanitize({ sampler: 'dpm++ 2m karras' }, { backend: 'a1111', lists: { samplers: ['Euler a', 'DPM++ 2M Karras'], schedulers: [] } });
  assert(r.opts.sampler === 'DPM++ 2M Karras' && r.opts.scheduler === undefined, 'old A1111 (sampler names carry the schedule, no /schedulers) → "DPM++ 2M Karras" kept whole');
  r = A({ sampler: 'euler_ancestral', scheduler: 'sgm_uniform' });
  assert(r.opts.sampler === 'Euler a' && r.opts.scheduler === 'SGM Uniform', 'ComfyUI spellings on Forge → "Euler a" / "SGM Uniform"');
  r = A({ sampler: 'Heun' });
  assert(r.opts.sampler === 'Euler a' && r.warnings.length === 1 && r.warnings[0].message === 'There\'s no sampler called “Heun” — used Euler a.' && r.unknown.includes('sampler'), `unknown sampler → dropped, plain warning: ${r.warnings[0] && r.warnings[0].message}`);
  r = A({ sampler: 'Heun' }, { sampler: 'DPM++ 2M' });
  assert(r.opts.sampler === 'DPM++ 2M' && /used DPM\+\+ 2M/.test(r.warnings[0].message), '…the app\'s current sampler is used when it has one');
  r = A({}, { sampler: 'LMS Karras' });
  assert(r.opts.sampler === 'Euler a' && /your saved setting/.test(r.warnings[0].message), 'a saved form sampler the server lacks is not sent either');
  r = A({ scheduler: 'Polyexponential' });
  assert(r.opts.scheduler === 'Automatic' && /no schedule type called “Polyexponential” — used Automatic/.test(r.warnings[0].message), 'unknown schedule → Automatic + warning');
  r = A({ checkpoint: 'JuggernautXL_v9' });
  assert(r.opts.checkpoint === 'juggernautXL_v9.safetensors [c9e3e68f89]', 'checkpoint by file name (any case, no extension / hash) → the server\'s title');
  r = A({ checkpoint: 'C:\\models\\dreamshaper_8.safetensors' });
  assert(r.opts.checkpoint === 'dreamshaper_8.safetensors [879db523c3]', 'checkpoint given as a path → matched by its file name');
  r = A({ checkpoint: 'realisticVision_v51' });
  assert(r.opts.checkpoint === '' && /no checkpoint called “realisticVision_v51” — used the one your SD app has loaded/.test(r.warnings[0].message), 'unknown checkpoint → not sent (the loaded one is used) + warning');
  r = A({ vae: 'auto' });
  assert(r.opts.vae === 'Automatic' && !r.warnings.length, 'vae "auto" → "Automatic"');
  r = A({ vae: 'VAE-FT-MSE-840000.safetensors' });
  assert(r.opts.vae === 'vae-ft-mse-840000', 'VAE by file name → the listed name');
  r = A({ vae: 'kl-f8-anime2' });
  assert(r.opts.vae === 'Automatic' && /no VAE called “kl-f8-anime2” — used Automatic/.test(r.warnings[0].message), 'unknown VAE → Automatic + warning');
  r = A({ loras: [{ name: 'Odile Face', weight: 0.7 }, { name: 'ghost_lora', weight: 1 }] });
  assert(r.opts.loras.length === 1 && r.opts.loras[0].name === 'odile_face' && r.opts.loras[0].weight === 0.7 && /no LoRA called “ghost_lora”/.test(r.warnings[0].message), 'LoRAs: matched by name, an unknown one left out with a warning');
  r = A({ hires: { scale: 2, upscaler: 'r-esrgan 4x+', sampler: 'euler a' } });
  assert(r.opts.hires.upscaler === 'R-ESRGAN 4x+' && r.opts.hires.sampler === 'Euler a', 'hires upscaler / sampler matched too');
  r = A({ hires: { scale: 2, upscaler: 'Magic 8x' }, refiner: { checkpoint: 'sdxl_refiner' } });
  assert(r.opts.hires.upscaler === undefined && r.opts.hires.scale === 2 && r.opts.refiner === undefined && r.warnings.length === 2, 'unknown hires upscaler / refiner checkpoint → left out with warnings');
  r = S.sanitize({ sampler: 'whatever', checkpoint: 'x' }, { backend: 'a1111', lists: {} });
  assert(r.opts.sampler === 'whatever' && r.opts.checkpoint === 'x' && !r.warnings.length, 'no lists (unknown) → names left alone');

  console.log('\n== ComfyUI names ==');
  r = C({ sampler: 'Euler a' });
  assert(r.opts.sampler === 'euler_ancestral', '"Euler a" on ComfyUI → euler_ancestral');
  r = C({ sampler: 'dpm++ 2m karras' });
  assert(r.opts.sampler === 'dpmpp_2m' && r.opts.scheduler === 'karras', '"dpm++ 2m karras" on ComfyUI → dpmpp_2m + karras');
  r = C({ sampler: 'Heun', scheduler: 'Karras', checkpoint: 'dreamshaper_8', loras: [{ name: 'odile_face', weight: 1 }] });
  assert(r.opts.sampler === 'euler' && /used euler/.test(r.warnings[0].message) && r.opts.scheduler === 'karras' && r.opts.checkpoint === 'sd15/dreamshaper_8.safetensors' && r.opts.loras[0].name === 'Characters\\odile_face.safetensors', 'unknown sampler → euler; schedule / checkpoint / LoRA in ComfyUI\'s own spelling (with folders)');

  console.log('\n== numbers ==');
  r = A({ width: 1001, height: 5000, steps: 500, cfgScale: 0, batchSize: 20, batchCount: 0, denoise: 1.5, seed: 3.7 });
  assert(r.opts.width === 1000 && r.opts.height === 2048 && r.opts.steps === 150 && r.opts.cfgScale === 1 && r.opts.batchSize === 8 && r.opts.batchCount === 1 && r.opts.denoise === 1 && r.opts.seed === 4, `clamped: ${JSON.stringify(r.opts)}`);
  assert(r.warnings.some((w) => w.field === 'size' && /1001×5000/.test(w.message) && /1000×2048/.test(w.message)) && r.warnings.some((w) => w.field === 'steps' && /150/.test(w.message)), 'size + steps changes are explained');
  r = A({ width: 10, height: '768', steps: '30', cfgScale: '6.5', seed: 'abc' });
  assert(r.opts.width === 64 && r.opts.height === 768 && r.opts.steps === 30 && r.opts.cfgScale === 6.5 && r.opts.seed === -1 && r.warnings.some((w) => w.field === 'seed'), 'tiny width → 64; numbers given as text → numbers; a non-number seed → -1 (random)');
  r = A({ width: 512, height: 768, steps: 20, cfgScale: 7, seed: -1 });
  assert(!r.warnings.length && !r.fixes.length, 'a normal request is left exactly as it is');
  r = A({ hires: { denoise: 3 } });
  assert(r.opts.hires.denoise === 1, 'hires denoise → 0..1');

  console.log('\n== model family vs size (warn, never block) ==');
  r = A({ checkpoint: 'juggernautXL_v9', width: 512, height: 512 });
  assert(r.opts.width === 512 && r.warnings.some((w) => /SDXL checkpoints are made for about 1024/.test(w.message)), 'SDXL at 512×512 → warning');
  r = A({ checkpoint: 'dreamshaper_8', width: 1024, height: 1024 });
  assert(r.opts.width === 1024 && r.warnings.some((w) => /SD1\.5 checkpoints are made for 512/.test(w.message)), 'SD1.5 at 1024×1024 → warning');
  r = A({ checkpoint: 'dreamshaper_8', width: 512, height: 768 });
  assert(!r.warnings.length, 'SD1.5 at 512×768 → nothing to say');

  console.log('\n== the one safe retry (plan) ==');
  let p = S.retryPlan({ ok: false, code: 'SD_ERROR', status: 500 }, { width: 640, height: 640, steps: 20, sampler: 'DPM++ 2M', hires: { scale: 2 }, checkpoint: 'x', loras: [{ name: 'a' }], negativePrompt: 'n', seed: 5 }, { why: "KeyError: 'x'" });
  assert(p && p.kind === 'basics' && p.opts.sampler === '' && p.opts.checkpoint === '' && p.opts.vae === 'Automatic' && !p.opts.hires && !p.opts.loras.length && p.opts.width === 640 && p.opts.seed === 5 && p.opts.negativePrompt === 'n', 'unknown 500 with extra settings → only the basics (current checkpoint, Automatic VAE, no sampler / hires / LoRAs)');
  assert(/Your SD app refused some of the settings \(KeyError: 'x'\); made it with the basics instead \(left out: sampler, checkpoint, loras, hires\)/.test(p.warning.message), `…and says so: ${p.warning.message}`);
  assert(S.retryPlan({ ok: false, code: 'SD_ERROR' }, { width: 512, height: 512, steps: 20, vae: 'Automatic', scheduler: 'Automatic' }, {}) === null, 'unknown 500 with only basic settings → no retry (nothing to leave out)');
  assert(S.retryPlan({ ok: false, code: 'SD_ERROR' }, { width: 512 }, { current: { sampler: 'DPM++ 2M' } }).kind === 'basics', 'the form\'s saved sampler counts as a non-basic setting');
  p = S.retryPlan({ ok: false, code: 'OOM' }, { width: 1536, height: 1536, batchSize: 2, hires: { scale: 2 } }, { family: 'SDXL' });
  assert(p && p.kind === 'smaller' && p.opts.width === 1024 && p.opts.height === 1024 && p.opts.batchSize === 1 && !p.opts.hires && /ran out of memory at 1536×1536/.test(p.warning.message), 'OOM on SDXL 1536² ×2 + hires → 1024², batch 1, no hires');
  p = S.retryPlan({ ok: false, code: 'OOM' }, { width: 1024, height: 1536 }, { family: 'SD1.5' });
  assert(p && p.opts.width === 320 && p.opts.height === 512, 'OOM on SD1.5 → the long side 512 (shape kept)');
  assert(S.retryPlan({ ok: false, code: 'OOM' }, { width: 512, height: 512, batchSize: 1 }, { family: 'SD1.5' }) === null, 'OOM at 512² batch 1 → nothing smaller to try');
  assert(S.retryPlan({ ok: false, code: 'VAE_LOAD_FAILED' }, { vae: 'taesd' }, { interactive: true }) === null, 'a broken VAE in the Images tab → no auto retry (it has the one-click button)');
  p = S.retryPlan({ ok: false, code: 'VAE_LOAD_FAILED' }, { vae: 'taesd' }, {});
  assert(p && p.opts.vae === 'Automatic' && /“taesd” can't be loaded — made it with Automatic VAE/.test(p.warning.message), 'a broken VAE for Alfred / Akọwe → once with Automatic VAE');
  for (const code of ['CHECKPOINT_LOAD_FAILED', 'LORA_MISSING', 'NAN', 'CANCELLED', 'CONNECTION_REFUSED', 'UNKNOWN_VALUE', 'BUSY']) assert(S.retryPlan({ ok: false, code }, { sampler: 'x', width: 2048, height: 2048, batchSize: 4 }, {}) === null, `${code} → no auto retry`);

  console.log('\n== through the studio against a strict fake Forge (Alfred\'s path) ==');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdsafe-'));
  const models = path.join(tmp, 'Models');
  writeSafetensors(path.join(models, 'StableDiffusion', 'dreamshaper_8.safetensors'), { 'modelspec.architecture': 'stable-diffusion-v1' });
  writeSafetensors(path.join(models, 'StableDiffusion', 'juggernautXL_v9.safetensors'), { 'modelspec.architecture': 'stable-diffusion-xl-v1-base' });
  const lib = L.createLibrary({ storePath: path.join(tmp, 'sd-library.json'), env: {}, findStabilityMatrix: () => [{ models }] });
  lib.scan();
  const logs = [];
  let cgCalls = 0;
  const chatgpt = { readiness: () => ({ ready: true }), status: () => ({ ready: true }), generate: async () => { cgCalls++; return { ok: false, engine: 'chatgpt', error: 'HTTP_500', code: 'SD_ERROR', message: 'boom' }; } };
  const studio = createSdStudio({ imageProvider: ip, library: lib, imagesDir: () => path.join(tmp, 'images'), log: (t, d) => logs.push([t, d]), fileUrl: (x) => `file://${x}`, chatgpt });
  const api = sdApi.createImagesApi({ studio, library: lib });
  const forge = await fakeA1111({ flavor: 'forge', strictNames: true, badVae: 'taesd_decoder' });
  await studio.connect(forge.base);
  const SECRET = 'a secret prompt about the lighthouse keeper';
  let g = await api.images.generate({ prompt: SECRET, sampler: 'euler a', checkpoint: 'juggernautxl_v9', width: 1001, height: 1001, steps: 4, from: 'alfred' });
  let body = forge.state.lastTxt2img;
  assert(g.ok && body.sampler_name === 'Euler a' && body.override_settings.sd_model_checkpoint === 'juggernautXL_v9.safetensors [c9e3e68f89]' && body.width === 1000 && body.height === 1000, `names in the app's spelling, size on the 8 grid → no 500 (${g.message || 'ok'})`);
  g = await api.images.generate({ prompt: SECRET, sampler: 'dpm++ 2m karras', width: 512, height: 512, steps: 4 });
  body = forge.state.lastTxt2img;
  assert(g.ok && body.sampler_name === 'DPM++ 2M' && body.scheduler === 'Karras', '"dpm++ 2m karras" reaches Forge as sampler "DPM++ 2M" + scheduler "Karras"');
  g = await api.images.generate({ prompt: SECRET, sampler: 'Heun', scheduler: 'polyexponential', checkpoint: 'realisticVision_v51', vae: 'kl-f8-anime2', width: 512, height: 512, steps: 4 });
  body = forge.state.lastTxt2img;
  assert(g.ok && body.sampler_name === 'Euler a' && body.scheduler === 'Automatic' && !(body.override_settings && body.override_settings.sd_model_checkpoint) && body.override_settings.sd_vae === 'Automatic', 'unknown sampler / schedule / checkpoint / VAE are never sent (the strict fake would 500)');
  const msgs = g.warnings.map((w) => w.message).join(' | ');
  assert(/no sampler called “Heun” — used Euler a/.test(msgs) && /no checkpoint called “realisticVision_v51”/.test(msgs) && /no VAE called “kl-f8-anime2”/.test(msgs), `the caller gets plain warnings: ${msgs.slice(0, 160)}…`);
  let ev = logs.filter((l) => l[0] === 'sd-generate').pop();
  assert(ev && ev[1].ok && ev[1].corrected && ev[1].corrected.includes('sampler:fixed') && ev[1].names && ev[1].names.some((n) => /^sampler: Heun → Euler a$/.test(n)), `the log names what was corrected (${JSON.stringify(ev && ev[1].names)})`);

  console.log('\n== safe retry: an unknown 500 → the basics, once ==');
  forge.state.rejectNonBasic = true;
  let calls0 = forge.state.txt2imgCalls;
  g = await api.images.generate({ prompt: SECRET, sampler: 'DPM++ 2M', scheduler: 'Karras', hires: { scale: 2 }, checkpoint: 'dreamshaper_8', loras: [{ name: 'odile_face', weight: 0.8 }], width: 512, height: 768, steps: 4, seed: 7, from: 'alfred' });
  body = forge.state.lastTxt2img;
  assert(g.ok && forge.state.txt2imgCalls - calls0 === 2 && !body.sampler_name && !body.scheduler && !body.enable_hr && !body.override_settings.sd_model_checkpoint && body.override_settings.sd_vae === 'Automatic' && body.seed === 7 && body.width === 512 && body.height === 768 && !/<lora:/.test(body.prompt), 'Forge 500s on the extras → made once more with only the basics (same size, seed; Automatic VAE)');
  const rw = g.warnings.find((w) => w.kind === 'retry');
  assert(rw && /^Your SD app refused some of the settings \(TypeError: 'NoneType' object is not subscriptable\); made it with the basics instead/.test(rw.message) && g.retried && g.retried.kind === 'basics', `…and says so: ${rw && rw.message}`);
  ev = logs.filter((l) => l[0] === 'sd-generate' && l[1].retry).pop();
  assert(ev && ev[1].retry === 'basics' && ev[1].after === 'SD_ERROR' && ev[1].ok === true && ev[1].left.includes('sampler'), 'the retry is logged with codes / setting names');
  assert(!JSON.stringify(logs).includes('secret prompt'), 'the log never carries the prompt');
  calls0 = forge.state.txt2imgCalls;
  g = await studio.generate({ prompt: 'x', sampler: 'DPM++ 2M', width: 512, height: 512, steps: 4 }, 'images-tab');
  assert(g.ok && forge.state.txt2imgCalls - calls0 === 2 && g.warnings.some((w) => w.kind === 'retry'), 'the Images tab gets the same safe retry');
  forge.state.rejectNonBasic = false;
  forge.state.failWith = 'traceback';
  calls0 = forge.state.txt2imgCalls;
  g = await api.images.generate({ prompt: 'x', sampler: 'DPM++ 2M', width: 512, height: 512, steps: 4 });
  assert(!g.ok && forge.state.txt2imgCalls - calls0 === 2 && g.retried && g.retried.ok === false && g.warnings.some((w) => /Tried once more \(with only the basic settings\) — that failed too/.test(w.message)), 'still failing → exactly one retry, then the error (no loop)');
  calls0 = forge.state.txt2imgCalls;
  g = await api.images.generate({ prompt: 'x', width: 512, height: 512, steps: 4 });
  assert(!g.ok && g.code === 'SD_ERROR' && forge.state.txt2imgCalls - calls0 === 1 && !g.retried, 'an unknown 500 on a basic request → no retry (nothing to leave out)');
  forge.state.failWith = 'ckpt';
  calls0 = forge.state.txt2imgCalls;
  g = await api.images.generate({ prompt: 'x', sampler: 'DPM++ 2M', width: 512, height: 512, steps: 4 });
  assert(!g.ok && g.code === 'CHECKPOINT_LOAD_FAILED' && forge.state.txt2imgCalls - calls0 === 1, 'a known cause with its own fix (checkpoint) → no auto retry');
  forge.state.failWith = null;

  console.log('\n== OOM → once at a smaller size, batch 1 ==');
  forge.state.oomAbove = 600000;
  calls0 = forge.state.txt2imgCalls;
  g = await api.images.generate({ prompt: 'x', checkpoint: 'dreamshaper_8', width: 1024, height: 1024, count: 2, steps: 4 });
  body = forge.state.lastTxt2img;
  assert(g.ok && forge.state.txt2imgCalls - calls0 === 2 && body.width === 512 && body.height === 512 && body.batch_size === 1 && g.images.length === 1, 'out of memory at 1024² ×2 on SD1.5 → one picture at 512²');
  assert(g.warnings.some((w) => /ran out of memory at 1024×1024 \(batch 2\) — made one picture at 512×512/.test(w.message)), 'the warning says what changed');
  forge.state.oomAbove = 0;

  console.log('\n== a broken VAE: Alfred gets Automatic once; the Images tab keeps its button ==');
  calls0 = forge.state.txt2imgCalls;
  g = await api.images.generate({ prompt: 'x', vae: 'taesd_decoder', width: 512, height: 512, steps: 4, from: 'alfred' });
  assert(g.ok && forge.state.txt2imgCalls - calls0 === 2 && forge.state.lastTxt2img.override_settings.sd_vae === 'Automatic' && g.warnings.some((w) => /“taesd_decoder” can't be loaded — made it with Automatic VAE/.test(w.message)), 'Alfred: VAE_LOAD_FAILED → made once more with Automatic VAE');
  assert(forge.state.options.sd_vae === 'Automatic' && !forge.state.optionsSet.some((o) => 'sd_vae' in o) && ip.getSettings().vae === '', '…without changing the user\'s saved VAE settings');
  calls0 = forge.state.txt2imgCalls;
  g = await studio.generate({ prompt: 'x', vae: 'taesd_decoder', width: 512, height: 512, steps: 4 }, 'images-tab');
  assert(!g.ok && g.code === 'VAE_LOAD_FAILED' && g.actions && g.actions[0].id === 'vae-automatic' && forge.state.txt2imgCalls - calls0 === 1, 'Images tab: the red box + "Use Automatic VAE and retry" as before (no auto retry)');
  calls0 = forge.state.txt2imgCalls;
  g = await studio.fixAndRetry('vae-automatic', { prompt: 'x', vae: 'taesd_decoder', sampler: 'DPM++ 2M', width: 512, height: 512, steps: 4 });
  assert(g.ok && forge.state.txt2imgCalls - calls0 === 1, 'the button\'s retry is the one retry');

  console.log('\n== the bridge (Akọwe) and ChatGPT ==');
  g = await studio.request({ prompt: 'x', sampler: 'Heun', from: 'akowe' });
  assert(g.ok && forge.state.lastTxt2img.sampler_name === 'Euler a' && g.warnings.some((w) => /no sampler called “Heun”/.test(w.message)), 'POST /image/request: the same make-it-safe step + warnings');
  g = await studio.requestFrom({ prompt: 'x', engine: 'chatgpt', sampler: 'DPM++ 2M' }, 'api:alfred');
  assert(!g.ok && cgCalls === 1, 'a ChatGPT-engine failure is never retried through this');

  console.log('\n== Alfred sees the warnings in his tool result ==');
  const tools = require('../alfred-tools');
  const sdCall = tools.get('sd_call');
  const res = await sdCall.run({ method: 'images.generate', args: { prompt: 'x', sampler: 'Heun' } }, { sdInvoke: (m, a) => api.call ? api.call(m, a) : api.images.generate(a) });
  assert(res.ok && /Notes: There's no sampler called “Heun” — used Euler a\./.test(res.message) && res.data.warnings.length >= 1, `sd_call result: "${res.message.slice(0, 110)}"`);
  const gi = tools.get('generate_image');
  const res2 = await gi.run({ prompt: 'x', width: 3000, height: 512 }, { generateImage: async (o) => { const r2 = await api.images.generate({ prompt: o.prompt, width: o.width, height: o.height }); return { ok: r2.ok, path: r2.images[0].path, paths: r2.images.map((i) => i.path), count: r2.images.length, warnings: r2.warnings, engine: 'sd' }; } });
  assert(res2.ok && /Notes: The size 3000×512 isn't one Stable Diffusion can make — used 2048×512/.test(res2.message) && res2.data.warnings.length, `generate_image result: "${res2.message.slice(0, 120)}"`);
  await forge.close();

  console.log('\n== ComfyUI through the studio ==');
  const cf = await fakeComfy();
  await studio.connect(cf.base);
  g = await studio.generate({ prompt: 'x', sampler: 'dpm++ 2m karras', checkpoint: 'Dreamshaper_8', width: 512, height: 512, steps: 4, pollMs: 10 }, 'api:alfred');
  let ks = Object.values(cf.state.lastGraph).find((n) => n.class_type === 'KSampler');
  assert(g.ok && ks.inputs.sampler_name === 'dpmpp_2m' && ks.inputs.scheduler === 'karras' && cf.state.lastGraph['4'].inputs.ckpt_name === 'sd15/dreamshaper_8.safetensors', '"dpm++ 2m karras" → dpmpp_2m + karras; checkpoint in ComfyUI\'s spelling');
  g = await studio.generate({ prompt: 'x', sampler: 'Heun', width: 512, height: 512, steps: 4, pollMs: 10 }, 'api:alfred');
  ks = Object.values(cf.state.lastGraph).find((n) => n.class_type === 'KSampler');
  assert(g.ok && ks.inputs.sampler_name === 'euler' && g.warnings.some((w) => /no sampler called “Heun” — used euler/.test(w.message)), 'unknown sampler on ComfyUI → euler + warning');
  await cf.close();

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
