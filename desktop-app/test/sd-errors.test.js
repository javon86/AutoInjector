// test/sd-errors.test.js — reading what the Stable Diffusion app said when a picture failed
// (sd-errors.js), the one-click "Use Automatic VAE and retry" (sets sd_vae, retries ONCE),
// and the library's VAE header check (not a full VAE / wrong model family).
// The case from the user's log: A1111 answered every Generate with HTTP 500
// "Error(s) in loading state_dict for AutoencoderKL: Missing key(s) … encoder.conv_in.weight".
// Fake servers only (test/fixtures/fake-sd.js), no GPU.     Run: node test/sd-errors.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../sd-errors');
const sd = require('../sd-backends');
const ip = require('../image-provider');
const L = require('../sd-library');
const { createSdStudio } = require('../sd-studio');
const { fakeA1111, fakeComfy, A1111_ERRORS } = require('./fixtures/fake-sd');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const res = (status, json) => ({ ok: false, error: `HTTP_${status}`, status, raw: JSON.stringify(json) });

// A tiny .safetensors: 8-byte header length + JSON header (tensor names + shapes) + a few bytes.
function writeSafetensors(file, tensors, metadata) {
  const h = Object.assign({ __metadata__: metadata || {} }, tensors);
  const json = Buffer.from(JSON.stringify(h));
  const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(json.length));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([len, json, Buffer.from([1, 2, 3, 4])]));
}
const T = (shape) => ({ dtype: 'F16', shape: shape || [2], data_offsets: [0, 4] });
const FULL_VAE = (ch = 4) => ({ 'encoder.conv_in.weight': T([128, 3, 3, 3]), 'encoder.conv_in.bias': T([128]), 'encoder.down.0.block.0.norm1.weight': T([128]), 'decoder.conv_in.weight': T([512, ch, 3, 3]), 'decoder.conv_out.weight': T([3, 128, 3, 3]), 'quant_conv.weight': T([2 * ch, 2 * ch, 1, 1]) });

async function main() {
  console.log('\n== explainSdError: the exact A1111 VAE 500 body ==');
  let ex = E.explainSdError(res(500, A1111_ERRORS.vae), { vae: 'taesd_decoder' });
  assert(ex.known && ex.code === 'VAE_LOAD_FAILED', `the AutoencoderKL state_dict error → VAE_LOAD_FAILED (${ex.code})`);
  assert(/The VAE you picked \(“taesd_decoder”\) can't be loaded\. It isn't a full VAE or doesn't match this model\./.test(ex.message), `the message names the VAE: "${ex.message}"`);
  assert(/Automatic/.test(ex.fix) && ex.actions.length === 1 && ex.actions[0].id === 'vae-automatic' && /Use Automatic VAE and retry/.test(ex.actions[0].label), 'fix: set VAE to Automatic + the one-click "Use Automatic VAE and retry"');
  assert(/^RuntimeError: Error\(s\) in loading state_dict for AutoencoderKL/.test(ex.details) && ex.details.length <= 600 && !/\\"/.test(ex.details), 'details = the server\'s own words, decoded (not escaped JSON), at most 600 chars');
  ex = E.explainSdError(res(500, A1111_ERRORS.vae), {});
  assert(ex.code === 'VAE_LOAD_FAILED' && /The VAE your SD app is set to can't be loaded/.test(ex.message), 'no VAE in the form → "the VAE your SD app is set to"');
  ex = E.explainSdError(res(500, A1111_ERRORS.vae), { vae: 'Automatic' });
  assert(/your SD app is set to/.test(ex.message), '"Automatic" is not named as the culprit');
  ex = E.explainSdError(res(500, A1111_ERRORS.vae), { vae: 'bad', vaeInfo: { problem: 'it is decoder-only (no encoder), not a full VAE' } });
  assert(/checked the file: it is decoder-only/.test(ex.message), 'the library\'s header check is added to the message when known');

  console.log('\n== explainSdError: the other known causes ==');
  ex = E.explainSdError(res(500, A1111_ERRORS.oom));
  assert(ex.code === 'OOM' && /ran out of memory/.test(ex.message) && /512×512/.test(ex.fix) && /--medvram/.test(ex.fix) && /batch/.test(ex.fix), 'CUDA out of memory → OOM with smaller size / --medvram / fewer batches');
  ex = E.explainSdError(res(500, A1111_ERRORS.nan), { vae: 'kl-f8-anime' });
  assert(ex.code === 'NAN' && /--no-half-vae/.test(ex.fix) && /another VAE/.test(ex.fix) && ex.actions[0] && ex.actions[0].id === 'vae-automatic', 'all-NaN in the VAE → NAN, hint --no-half-vae or another VAE (+ Automatic button when a VAE was picked)');
  ex = E.explainSdError(res(500, { error: 'NansException', errors: 'A tensor with all NaNs was produced in Unet.' }));
  assert(ex.code === 'NAN' && /--no-half/.test(ex.fix) && !ex.actions.length, 'all-NaN in the UNet → --no-half / --upcast-sampling, no VAE button');
  ex = E.explainSdError(res(500, A1111_ERRORS.ckpt), { checkpoint: 'broken_model.safetensors [abcdef1234]' });
  assert(ex.code === 'CHECKPOINT_LOAD_FAILED' && /“broken_model\.safetensors”/.test(ex.message) && /download it again/.test(ex.fix), 'a checkpoint that can\'t be read → CHECKPOINT_LOAD_FAILED naming it (hash stripped)');
  ex = E.explainSdError(res(500, { error: 'RuntimeError', errors: 'Error(s) in loading state_dict for LatentDiffusion: size mismatch for model.diffusion_model.input_blocks.0.0.weight' }));
  assert(ex.code === 'CHECKPOINT_LOAD_FAILED', 'a LatentDiffusion state_dict error is the checkpoint, not the VAE');
  ex = E.explainSdError(res(500, A1111_ERRORS.lora));
  assert(ex.code === 'LORA_MISSING' && /“missing_face”/.test(ex.message), 'Couldn\'t find Lora with name X → LORA_MISSING naming it');
  ex = E.explainSdError(res(500, { error: 'RuntimeError', errors: 'embedding easyneg not found' }));
  assert(ex.code === 'EMBEDDING_MISSING', 'a missing embedding → EMBEDDING_MISSING');
  ex = E.explainSdError({ ok: false, error: 'REFUSED' }, { base: 'http://127.0.0.1:7860' });
  assert(ex.code === 'CONNECTION_REFUSED' && /Nothing is answering at http:\/\/127\.0\.0\.1:7860/.test(ex.message) && /Launch/.test(ex.fix), 'connection refused → CONNECTION_REFUSED with how to start the app');
  ex = E.explainSdError(res(500, A1111_ERRORS.traceback));
  assert(ex.code === 'SD_ERROR' && /KeyError: 'sd_xl_refiner'/.test(ex.message) && !/Traceback|File "/.test(ex.message), `an unknown error → the first useful line ("${ex.message}")`);
  ex = E.explainSdError({ ok: false, error: 'HTTP_500', status: 500, raw: '<html><head><title>500 Internal Server Error</title></head><body><h1>Internal Server Error</h1></body></html>' });
  assert(ex.code === 'SD_ERROR' && /Internal Server Error/.test(ex.message) && !/<h1>/.test(ex.details), 'an HTML 500 page → its text, without tags');
  ex = E.explainSdError({ ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', message: 'steps must be a number.' });
  assert(!ex.known && ex.code === 'INVALID_PARAM' && ex.message === 'steps must be a number.', 'a plain validation answer (no server text) stays as it was');
  assert(E.explainSdError(null).code && E.explainSdError(undefined, null).message !== undefined, 'never throws on nothing');
  const ann = E.annotate({ ok: false, error: 'HTTP_500', status: 500, raw: JSON.stringify(A1111_ERRORS.oom), message: 'old' }, {});
  assert(ann.error === 'HTTP_500' && ann.code === 'OOM' && ann.message !== 'old' && ann.serverError && ann.fix, 'annotate() keeps error (HTTP_500) and adds code / message / fix / serverError');

  console.log('\n== ComfyUI: node_errors and execution errors ==');
  ex = E.explainSdError({ ok: false, error: 'COMFY_REJECTED', status: 400, raw: JSON.stringify({ error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' }, node_errors: { 20: { class_type: 'VAELoader', errors: [{ type: 'custom_validation_failed', message: 'Error loading VAE', details: "vae_name: 'taesd_decoder.safetensors' Missing key(s) in state_dict: encoder.conv_in.weight" }] } } }) });
  assert(ex.code === 'VAE_LOAD_FAILED' && /taesd_decoder/.test(ex.message) && ex.actions[0].id === 'vae-automatic' && /VAELoader #20/.test(ex.details), 'a VAELoader node error → VAE_LOAD_FAILED naming the file, details list the node');
  ex = E.explainSdError({ ok: false, error: 'COMFY_ERROR', raw: JSON.stringify({ node_type: 'VAEDecode', exception_type: 'torch.OutOfMemoryError', exception_message: 'Allocation on device 0 would exceed allowed memory. (out of memory)' }) });
  assert(ex.code === 'OOM', 'a VAEDecode out-of-memory execution error → OOM (not a VAE file problem)');

  console.log('\n== against a fake A1111: the VAE 500, the error box data, the log ==');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sderr-'));
  const models = path.join(tmp, 'Models');
  writeSafetensors(path.join(models, 'VAE', 'vae-ft-mse-840000.safetensors'), FULL_VAE(4));
  writeSafetensors(path.join(models, 'VAE', 'taesd_decoder.safetensors'), { 'decoder.conv_in.weight': T([64, 4, 3, 3]), 'decoder.up.0.block.0.conv1.weight': T([64, 64, 3, 3]) });
  writeSafetensors(path.join(models, 'VAE', 'taesdxl.safetensors'), { 'encoder.layers.0.weight': T([64, 3, 3, 3]), 'decoder.layers.0.weight': T([64, 4, 3, 3]) });
  writeSafetensors(path.join(models, 'VAE', 'shiny_lora.safetensors'), { 'lora_unet_down_blocks_0.lora_down.weight': T([4, 320]) });
  writeSafetensors(path.join(models, 'VAE', 'dreamshaper_copy.safetensors'), { 'model.diffusion_model.input_blocks.0.0.weight': T([320, 4, 3, 3]), 'first_stage_model.encoder.conv_in.weight': T([128, 3, 3, 3]), 'first_stage_model.decoder.conv_in.weight': T([512, 4, 3, 3]) });
  writeSafetensors(path.join(models, 'VAE', 'flux_ae.safetensors'), FULL_VAE(16));
  writeSafetensors(path.join(models, 'VAE', 'sdxl_vae.safetensors'), FULL_VAE(4));
  writeSafetensors(path.join(models, 'StableDiffusion', 'dreamshaper_8.safetensors'), { w: T() }, { 'modelspec.architecture': 'stable-diffusion-v1' });
  const lib = L.createLibrary({ storePath: path.join(tmp, 'sd-library.json'), env: {}, findStabilityMatrix: () => [{ models }] });
  lib.scan();
  const logs = [];
  const studio = createSdStudio({ imageProvider: ip, library: lib, imagesDir: () => path.join(tmp, 'images'), log: (t, d) => logs.push([t, d]), fileUrl: (p) => `file://${p}` });
  const a = await fakeA1111({ badVae: 'taesd_decoder' });
  await studio.connect(a.base);
  const PROMPT = 'a secret prompt about the lighthouse keeper';
  let r = await studio.generate({ prompt: PROMPT, vae: 'taesd_decoder', width: 512, height: 512, steps: 4 });
  assert(!r.ok && r.error === 'HTTP_500' && r.code === 'VAE_LOAD_FAILED', `the 500 is read: code VAE_LOAD_FAILED (error stays ${r.error})`);
  assert(/“taesd_decoder”/.test(r.message) && /decoder-only/.test(r.message) && r.actions && r.actions[0].id === 'vae-automatic' && /AutoencoderKL/.test(r.serverError), 'message names the VAE + what the library found; fix button; server text for "details"');
  assert(r.warnings.some((w) => w.kind === 'vae' && w.level === 'hard' && /not a full VAE/.test(w.message)), 'the library already warned before sending (not a full VAE)');
  const ev = logs.filter((l) => l[0] === 'sd-generate').pop();
  assert(ev && ev[1].code === 'VAE_LOAD_FAILED' && ev[1].ok === false && !JSON.stringify(logs).includes('secret prompt'), 'the log event carries the code — and never the prompt text');

  console.log('\n== "Use Automatic VAE and retry": sets sd_vae, retries once ==');
  const calls0 = a.state.txt2imgCalls;
  r = await studio.fixAndRetry('vae-automatic', { prompt: PROMPT, vae: 'taesd_decoder', width: 512, height: 512, steps: 4 });
  assert(r.ok && r.retried === true && r.fixed === 'vae-automatic' && r.images.length === 1, 'the retry makes the picture');
  assert(a.state.optionsSet.some((o) => o.sd_vae === 'Automatic') && a.state.options.sd_vae === 'Automatic' && r.applied.includes('sd_vae'), 'A1111\'s own sd_vae option is set to Automatic');
  assert(a.state.txt2imgCalls - calls0 === 1, `exactly one retry was sent (${a.state.txt2imgCalls - calls0})`);
  assert(a.state.lastTxt2img.override_settings && a.state.lastTxt2img.override_settings.sd_vae === 'Automatic' && ip.getSettings().vae === '', 'the retry asks for VAE Automatic, and the form default is Automatic now');
  // the VAE is A1111's own setting (not the form's): the message names it, the fix clears it
  a.state.options.sd_vae = 'taesd_decoder';
  r = await studio.generate({ prompt: 'x', width: 512, height: 512, steps: 4 });
  assert(!r.ok && r.code === 'VAE_LOAD_FAILED' && /“taesd_decoder”/.test(r.message), 'VAE set inside A1111 → read from its options and named');
  r = await studio.fixAndRetry('vae-automatic', { prompt: 'x', width: 512, height: 512, steps: 4 });
  assert(r.ok && a.state.options.sd_vae === 'Automatic', '…and the fix switches A1111 to Automatic, so the picture works');
  // a fix that doesn't help: still ONE retry, then the error again (no loop)
  a.state.failWith = 'vae';
  const calls1 = a.state.txt2imgCalls;
  r = await studio.fixAndRetry('vae-automatic', { prompt: 'x', width: 512, height: 512, steps: 4 });
  assert(!r.ok && r.retried === true && r.code === 'VAE_LOAD_FAILED' && a.state.txt2imgCalls - calls1 === 1, 'when it still fails: one retry only, the error comes back (no retry loop)');
  a.state.failWith = null;
  const test = await studio.fixAndRetry('vae-automatic', { test: true });
  assert(test.ok && test.settings.purpose === 'test', 'the 🧪 Test button\'s failure retries the test picture');
  r = await studio.fixAndRetry('reboot-gpu', {});
  assert(!r.ok && r.code === 'UNKNOWN_FIX', 'an unknown fix → UNKNOWN_FIX, nothing sent');

  console.log('\n== the other A1111 bodies through the real path ==');
  for (const [fw, code] of [['oom', 'OOM'], ['nan', 'NAN'], ['ckpt', 'CHECKPOINT_LOAD_FAILED'], ['lora', 'LORA_MISSING'], ['traceback', 'SD_ERROR'], ['html', 'SD_ERROR']]) {
    a.state.failWith = fw;
    r = await ip.generate('x', { width: 512, height: 512, steps: 4 });
    assert(!r.ok && r.code === code && r.message && !/^HTTP_500$/.test(r.message), `${fw} → ${code}: "${String(r.message).slice(0, 70)}…"`);
  }
  a.state.failWith = null;
  await a.close();
  r = await ip.generate('x', { width: 512, height: 512, steps: 4 });
  assert(!r.ok && r.code === 'CONNECTION_REFUSED' && r.error === 'REFUSED', 'the app closed → CONNECTION_REFUSED');

  console.log('\n== ComfyUI through the real path ==');
  const c1 = await fakeComfy({ nodeErrors: { 20: { class_type: 'VAELoader', errors: [{ type: 'exception_during_validation', message: 'Error loading VAE', details: "vae_name: 'vae-ft-mse-840000.safetensors' Error(s) in loading state_dict for AutoencoderKL: Missing key(s): encoder.conv_in.weight" }] } } });
  ip.setSettings({ enabled: true, backend: 'comfy', endpoint: c1.base });
  r = await ip.generate('x', { vae: 'vae-ft-mse-840000.safetensors', width: 512, height: 512, steps: 4, pollMs: 20 });
  assert(!r.ok && r.code === 'VAE_LOAD_FAILED' && r.actions && r.actions[0].id === 'vae-automatic', 'ComfyUI node_errors on VAELoader → VAE_LOAD_FAILED + the Automatic button');
  await c1.close();
  const c2 = await fakeComfy({ failWith: 'CUDA out of memory. Tried to allocate 1.5 GiB', failNode: 'VAEDecode', failType: 'torch.OutOfMemoryError' });
  ip.setSettings({ enabled: true, backend: 'comfy', endpoint: c2.base });
  r = await ip.generate('x', { width: 512, height: 512, steps: 4, pollMs: 20 });
  assert(!r.ok && r.code === 'OOM' && /VAEDecode/.test(r.serverError), 'a ComfyUI execution_error (out of memory) → OOM, details name the node');
  await c2.close();

  console.log('\n== the library checks VAE files (safetensors header only) ==');
  const vaes = lib.list({ kind: 'vae' }).items;
  const by = (n) => vaes.find((x) => x.name === n) || {};
  assert(by('vae-ft-mse-840000').vae && by('vae-ft-mse-840000').vae.full === true && by('vae-ft-mse-840000').vae.latentChannels === 4, 'a full VAE (encoder + decoder) passes, 4 latent channels');
  assert(by('taesd_decoder').vae.full === false && /decoder-only/.test(by('taesd_decoder').vae.problem), 'decoder-only → "not a full VAE"');
  assert(by('taesdxl').vae.full === false && /TAESD/.test(by('taesdxl').vae.problem), 'a tiny autoencoder (TAESD) → flagged');
  assert(by('shiny_lora').vae.full === false && /LoRA/.test(by('shiny_lora').vae.problem), 'a LoRA in the VAE folder → flagged');
  assert(by('dreamshaper_copy').vae.full === false && /whole checkpoint/.test(by('dreamshaper_copy').vae.problem), 'a whole checkpoint in the VAE folder → flagged (A1111 fails on it with exactly the missing encoder.* keys)');
  assert(by('flux_ae').vae.full === true && by('flux_ae').vae.latentChannels === 16 && by('flux_ae').vae.latentFamily === 'SD3/Flux', 'a 16-channel VAE is recognised as SD3 / Flux from its shapes');
  assert(by('taesd_decoder').compat.level === 'hard', 'a broken VAE is a hard warning in the list');
  let cv = lib.checkVae('flux_ae', 'dreamshaper_8');
  assert(cv.level === 'hard' && /SD3 \/ Flux VAE/.test(cv.message), 'a Flux VAE on an SD1.5 checkpoint → hard warning (certain, from the shapes)');
  cv = lib.checkVae('sdxl_vae', 'dreamshaper_8');
  assert(cv.level === 'soft' && /going by its name/.test(cv.message), 'an "sdxl" VAE on an SD1.5 checkpoint → soft warning (a guess from the name — the shapes are the same)');
  cv = lib.checkVae('vae-ft-mse-840000', 'dreamshaper_8');
  assert(cv.level === 'ok' && lib.checkVae('Automatic', 'x').level === 'ok' && lib.checkVae('unknown_vae', 'x').known === false, 'a fitting VAE / Automatic / an unknown name → no warning');
  // cached items from an older build are re-read once so the new check appears
  const db = JSON.parse(fs.readFileSync(path.join(tmp, 'sd-library.json'), 'utf8'));
  for (const c of Object.values(db.cache)) { delete c.item.v; delete c.item.vae; }
  fs.writeFileSync(path.join(tmp, 'sd-library.json'), JSON.stringify(db));
  const lib2 = L.createLibrary({ storePath: path.join(tmp, 'sd-library.json'), env: {}, findStabilityMatrix: () => [{ models }] });
  const sc = lib2.scan();
  assert(sc.reread >= 8 && lib2.list({ kind: 'vae' }).items.find((x) => x.name === 'taesd_decoder').vae.full === false, 'an old cache is re-read once (VAE check filled in)');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
