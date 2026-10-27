// test/sd-studio.test.js — the Images tab's brain + the Akọwe contract:
// generate → PNGs saved in images/ with the settings embedded (PNG text chunk +
// .json sidecar) so any image can be remade; gallery; character locks applied;
// mismatch warnings; and the bridge routes POST /image/request, GET /image/locks,
// GET /image/backend against a fake A1111 and a fake ComfyUI.
// Run: node test/sd-studio.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const ip = require('../image-provider');
const L = require('../sd-library');
const sdImages = require('../sd-images');
const { createSdStudio, sizeFor } = require('../sd-studio');
const { createServiceBridge } = require('../service-bridge');
const { fakeA1111, fakeComfy, PNG } = require('./fixtures/fake-sd');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
function writeSafetensors(file, metadata) {
  const json = Buffer.from(JSON.stringify({ __metadata__: metadata, w: { dtype: 'F16', shape: [2], data_offsets: [0, 4] } }));
  const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(json.length));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([len, json, Buffer.from([1, 2, 3, 4])]));
}
function req(port, method, p, body, token) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.assign({ Authorization: `Bearer ${token}` }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e }));
    if (data) r.write(data); r.end();
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdstudio-'));
  const models = path.join(tmp, 'Models');
  writeSafetensors(path.join(models, 'Lora', 'odile_face.safetensors'), { ss_base_model_version: 'sd_v1' });
  writeSafetensors(path.join(models, 'Lora', 'xl_ink.safetensors'), { ss_base_model_version: 'sdxl_base_v1-0' });
  writeSafetensors(path.join(models, 'StableDiffusion', 'dreamshaper_8.safetensors'), { 'modelspec.architecture': 'stable-diffusion-v1' });
  writeSafetensors(path.join(models, 'StableDiffusion', 'juggernautXL_v9.safetensors'), { 'modelspec.architecture': 'stable-diffusion-xl-v1-base' });
  const imagesDir = path.join(tmp, 'images');
  const lib = L.createLibrary({ storePath: path.join(tmp, 'sd-library.json'), env: {}, findStabilityMatrix: () => [{ models }] });
  lib.scan();
  const recorded = []; const logs = []; let persisted = 0;
  const studio = createSdStudio({ imageProvider: ip, library: lib, imagesDir: () => imagesDir, recordImage: (e) => recorded.push(e), persist: () => { persisted++; }, log: (t, d) => logs.push([t, d]), fileUrl: (p) => `file://${p}` });

  console.log('\n== PNG text chunks ==');
  const tagged = sdImages.addPngText(PNG, { parameters: 'a cat\nSteps: 20', autoinjector: JSON.stringify({ prompt: 'Ọ̀ṣun at the river', seed: 7 }) });
  const back = sdImages.readPngText(tagged);
  assert(sdImages.isPng(tagged) && back.parameters === 'a cat\nSteps: 20' && JSON.parse(back.autoinjector).prompt === 'Ọ̀ṣun at the river', 'settings round-trip through iTXt chunks (UTF-8 tone marks kept)');
  assert(tagged.subarray(tagged.length - 8, tagged.length - 4).toString('latin1') === 'IEND', 'IEND stays the last chunk');
  assert(sdImages.addPngText(Buffer.from('not a png'), { a: 'b' }).toString() === 'not a png', 'non-PNG data is left alone');
  assert(sdImages.crc32(Buffer.from('123456789')) === 0xcbf43926, 'CRC32 is the standard one');

  console.log('\n== nothing connected: plain words, nothing breaks ==');
  ip.setSettings({ enabled: false, endpoint: '', backend: '' });
  let g = await studio.generate({ prompt: 'x' });
  assert(!g.ok && /switched off|connected/i.test(g.message), 'generate() with no SD app → a plain sentence, no throw');
  const rq0 = await studio.request({ prompt: 'x' });
  assert(!rq0.ok && rq0.error === 'NO_IMAGE_ENGINE' && /no Stable Diffusion app is connected/.test(rq0.message), 'the Akọwe request (engine auto, no ChatGPT engine here) says no SD app is connected → NO_IMAGE_ENGINE');
  const rq1 = await studio.request({ prompt: 'x', engine: 'sd' });
  assert(!rq1.ok && rq1.error === 'SD_NOT_CONNECTED', 'engine "sd" with no SD app → SD_NOT_CONNECTED');

  console.log('\n== A1111: generate + save + remake ==');
  const a = await fakeA1111();
  const c = await studio.connect(a.base);
  assert(c.ok && c.lists && c.lists.loras === 2 && persisted > 0, 'connect() fetches the lists and saves the setting');
  g = await studio.generate({ prompt: 'portrait of odile', negativePrompt: 'blurry', loras: [{ name: 'odile_face', weight: 0.8 }], checkpoint: 'juggernautXL_v9.safetensors [c9e3e68f89]', steps: 12, width: 512, height: 512, seed: 99, batchSize: 2, sampler: 'Euler a' });
  assert(g.ok && g.images.length === 2 && fs.existsSync(g.images[0].path) && fs.existsSync(g.images[1].path), 'both pictures saved to the images/ folder');
  const hardW = g.warnings.filter((w) => w.level === 'hard');
  assert(hardW.length === 1 && /SD1\.5/.test(hardW[0].message), 'the SD1.5 LoRA on the SDXL checkpoint gives a warning (the picture is still made)');
  assert(g.warnings.some((w) => w.kind === 'safe' && w.field === 'size' && /SDXL checkpoints are made for about 1024/.test(w.message)), '…and 512×512 on an SDXL checkpoint gets a soft size warning (not blocked)');
  const rec = JSON.parse(fs.readFileSync(g.images[0].json, 'utf8'));
  assert(rec.prompt === 'portrait of odile' && rec.negativePrompt === 'blurry' && rec.seed === 99 && rec.steps === 12 && rec.sampler === 'Euler a' && rec.loras[0].name === 'odile_face' && rec.backend === 'a1111', 'the .json sidecar records prompt, negative, seed, steps, sampler, LoRAs, backend');
  assert(JSON.parse(fs.readFileSync(g.images[1].json, 'utf8')).seed === 100, 'the 2nd image of the batch records its own seed (all_seeds)');
  const chunks = sdImages.readPngText(fs.readFileSync(g.images[0].path));
  assert(JSON.parse(chunks.autoinjector).seed === 99 && /Steps: 12, Sampler: Euler a, CFG scale: 7, Seed: 99, Size: 512x512/.test(chunks.parameters) && /Lora: "odile_face:0.8"/.test(chunks.parameters), 'the PNG itself carries the settings (A1111 "parameters" infotext + JSON)');
  assert(recorded.length === 2 && recorded[0].sha256 && recorded[0].from === 'images-tab', 'each picture is recorded as a project image (with its hash)');
  assert(g.images[0].url.startsWith('file://') && !('imageBase64' in g.images[0]), 'the UI gets file URLs, not base64');
  const gal = studio.gallery(10);
  assert(gal.ok && gal.items.length === 2 && gal.items[0].record && gal.items[0].record.prompt === 'portrait of odile', 'gallery lists the pictures with their settings');
  const rr = studio.record(g.images[0].path);
  fs.unlinkSync(g.images[0].json);
  const rr2 = studio.record(g.images[0].path);
  assert(rr.ok && rr2.ok && rr2.record.seed === 99, 'record() reads the settings back (from the sidecar, or from the PNG if the sidecar is gone)');
  const remake = await studio.generate(rr2.record);
  assert(remake.ok && a.state.lastTxt2img.seed === 99 && a.state.lastTxt2img.prompt === 'portrait of odile <lora:odile_face:0.8>' && a.state.lastTxt2img.override_settings.sd_model_checkpoint === 'juggernautXL_v9.safetensors [c9e3e68f89]', 'feeding a record back in remakes the same request (seed, prompt, LoRA, checkpoint)');
  const t = await studio.test();
  assert(t.ok && a.state.lastTxt2img.width === 512 && a.state.lastTxt2img.height === 512 && t.settings.purpose === 'test', '"Test: make a 512px image" renders a 512×512 picture');

  console.log('\n== character locks ==');
  const lock = lib.saveLock({ character: 'Odile', book: 'Ferry', loras: [{ name: 'odile_face', weight: 0.75 }], triggerWords: 'odile woman', prompt: 'silver hair, navy coat', negative: 'smiling', seed: 4242 }).lock;
  g = await studio.generate({ prompt: 'on the ferry at dusk', characterLock: 'Odile', purpose: 'portrait' });
  let body = a.state.lastTxt2img;
  assert(g.ok && body.prompt === 'odile woman, silver hair, navy coat, on the ferry at dusk <lora:odile_face:0.75>' && body.negative_prompt === 'smiling' && body.seed === 4242, 'the lock adds trigger words, fixed bits, its LoRA, negative and seed');
  assert(body.width === 512 && body.height === 768, 'portrait on an SD1.5 checkpoint → 512×768');
  assert(g.settings.characterLock.character === 'Odile' && g.images[0].path.includes('portrait-'), 'the record names the lock; the file name says portrait');
  assert(!(await studio.generate({ prompt: 'x', characterLock: 'Nobody' })).ok, 'an unknown lock is refused in plain words');
  assert(sizeFor('cover', 'SDXL').height === 1216 && sizeFor('scene', 'SD1.5').width === 768 && sizeFor('free', '').width === 512, 'sizeFor(): cover/portrait tall, scene wide, bigger for SDXL');

  console.log('\n== the bridge routes Akọwe will use ==');
  const TOKEN = 'tok-123';
  const bridge = createServiceBridge({ version: '1', sdStudio: { request: (b) => studio.request(b), locks: () => studio.locks(), backend: () => studio.backendInfo() } });
  const st = await bridge.start({ port: 0, host: '127.0.0.1', token: TOKEN });
  let r = await req(st.port, 'GET', '/image/backend', null, TOKEN);
  assert(r.status === 200 && r.json.connected && r.json.backend === 'a1111', 'GET /image/backend → connected A1111');
  r = await req(st.port, 'GET', '/image/locks', null, TOKEN);
  assert(r.status === 200 && r.json.locks.length === 1 && r.json.locks[0].character === 'Odile', 'GET /image/locks lists the character locks');
  r = await req(st.port, 'POST', '/image/request', { purpose: 'portrait', characterLock: 'odile', prompt: 'reading a letter', book: 'Ferry', from: 'akowe', returnImage: true }, TOKEN);
  assert(r.status === 200 && r.json.ok && r.json.images.length === 1 && fs.existsSync(r.json.images[0].path) && r.json.images[0].imageBase64 && r.json.seed === 4242, 'POST /image/request with a character lock → saved file path, seed and (asked for) the base64');
  const rrec = JSON.parse(fs.readFileSync(r.json.images[0].path.replace(/\.png$/, '.json'), 'utf8'));
  assert(rrec.from === 'bridge:akowe' && rrec.book === 'Ferry' && rrec.purpose === 'portrait', 'the record says it came from Akọwe, for which book and purpose');
  r = await req(st.port, 'POST', '/image/request', { purpose: 'cover', prompt: 'a lantern on dark water' }, TOKEN);
  assert(r.status === 200 && !r.json.images[0].imageBase64 && a.state.lastTxt2img.height === 768, 'without returnImage only paths come back; a cover is tall');
  r = await req(st.port, 'POST', '/image/request', { purpose: 'view', view: 'side', characterLock: 'Odile' }, TOKEN);
  let vb = a.state.lastTxt2img;
  assert(r.status === 200 && r.json.engine === 'sd' && r.json.view === 'side' && r.json.purpose === 'view' && /^odile woman, silver hair, navy coat, full body, head to toe, standing, seen exactly from the side \(profile\)/.test(vb.prompt) && /cut off feet/.test(vb.negative_prompt) && /smiling/.test(vb.negative_prompt),
    `a reference view on SD (engine auto → sd): the lock's words, then the side framing; a negative that keeps the body in frame (${vb.prompt.slice(0, 80)}…)`);
  assert(vb.width === 512 && vb.height === 768 && r.json.seed === 4242 && r.json.paths.length === 1 && /view-side-/.test(r.json.paths[0]), 'views are tall, keep the lock\'s seed across the series, and the file says view-side');
  r = await req(st.port, 'POST', '/image/request', { purpose: 'view', view: 'back', characterLock: 'Odile', keepSeed: false, seed: 555, engine: 'sd' }, TOKEN);
  assert(r.status === 200 && a.state.lastTxt2img.seed === 555 && /seen exactly from behind/.test(a.state.lastTxt2img.prompt), 'the caller\'s own seed is used for the next view of the series');
  r = await req(st.port, 'POST', '/image/request', { purpose: 'sheet', characterLock: 'Odile' }, TOKEN);
  vb = a.state.lastTxt2img;
  assert(r.status === 200 && r.json.engine === 'sd' && /^character turnaround sheet/.test(vb.prompt) && vb.width === 1024 && vb.height === 512 && !r.json.view, 'a turnaround sheet on SD: wide, "character turnaround sheet" words');
  r = await req(st.port, 'POST', '/image/request', { prompt: 'x', engine: 'chatgpt' }, TOKEN);
  assert(r.status === 503 && r.json.error === 'CHATGPT_NOT_READY', 'engine chatgpt in a build without the ChatGPT engine → 503 CHATGPT_NOT_READY');
  r = await req(st.port, 'GET', '/image/backend', null, TOKEN);
  assert(r.json.engines && r.json.engines.sd.connected === true && r.json.engines.chatgpt.ready === false && r.json.engines.chatgpt.why, 'GET /image/backend reports both engines');
  r = await req(st.port, 'POST', '/image/request', { characterLock: 'Nobody' }, TOKEN);
  assert(r.status === 400 && r.json.error === 'NO_LOCK', 'unknown lock → 400 NO_LOCK');
  r = await req(st.port, 'POST', '/image/request', {}, TOKEN);
  assert(r.status === 400 && r.json.error === 'NEED_PROMPT', 'empty request → 400 NEED_PROMPT');
  r = await req(st.port, 'POST', '/image/request', { prompt: 'x' }, 'wrong');
  assert(r.status === 401, 'the route needs the bridge token');
  r = await req(st.port, 'POST', '/image/request', { prompt: 'a ferry', hires: { scale: 2, denoise: 0.4 }, clipSkip: 2 }, TOKEN);
  assert(r.status === 200 && a.state.lastTxt2img.enable_hr === true && a.state.lastTxt2img.denoising_strength === 0.4 && a.state.lastTxt2img.override_settings.CLIP_stop_at_last_layers === 2, 'POST /image/request accepts the advanced settings (hires fix, clip skip)');
  r = await req(st.port, 'POST', '/image/request', { prompt: 'x', hires: { upscaler: 'Magic 8x' } }, TOKEN);
  assert(r.status === 200 && r.json.ok && a.state.lastTxt2img.enable_hr === true && a.state.lastTxt2img.hr_upscaler === 'Latent' && r.json.warnings.some((w) => /no upscaler called “Magic 8x”/.test(w.message)), 'an upscaler the app doesn\'t have is left out (its default is used) with a plain warning — not a 400 / 500');
  r = await req(st.port, 'POST', '/image/request', { prompt: 'x', hires: { upscaler: 'r-esrgan 4x+' } }, TOKEN);
  assert(r.status === 200 && a.state.lastTxt2img.hr_upscaler === 'R-ESRGAN 4x+', 'an upscaler name in other case / punctuation is sent in the app\'s own spelling');
  await a.close();
  r = await req(st.port, 'POST', '/image/request', { prompt: 'x' }, TOKEN);
  assert(r.status === 502 && /Nothing is answering|closed the connection/.test(r.json.message), 'SD app gone → 502 with a plain message');
  const b2 = createServiceBridge({ version: '1' });
  const s2 = await b2.start({ port: 0, host: '127.0.0.1', token: TOKEN });
  r = await req(s2.port, 'POST', '/image/request', { prompt: 'x' }, TOKEN);
  assert(r.status === 501 && r.json.error === 'IMAGE_NOT_WIRED', 'a bridge without the image module answers 501');
  bridge.stop(); b2.stop();

  console.log('\n== ComfyUI through the same studio ==');
  const cf = await fakeComfy();
  await studio.connect(cf.base);
  g = await studio.generate({ prompt: 'odile portrait', characterLock: lock.id, purpose: 'portrait', checkpoint: 'dreamshaper_8' });
  const graph = cf.state.lastGraph;
  const lor = Object.values(graph).filter((n) => n.class_type === 'LoraLoader');
  assert(g.ok && lor.length === 1 && lor[0].inputs.lora_name === 'Characters\\odile_face.safetensors' && lor[0].inputs.strength_model === 0.75, 'the lock\'s LoRA becomes a LoraLoader node (ComfyUI path resolved)');
  assert(graph['3'].inputs.seed === 4242 && JSON.parse(fs.readFileSync(g.images[0].json, 'utf8')).backend === 'comfy', 'seed from the lock; record says comfy');
  await cf.close();

  console.log('\n== sd-api: the module API for Alfred ==');
  const sdApi = require('../sd-api');
  const api = sdApi.register(sdApi.createImagesApi({ studio, library: lib, runner: () => ({ status: () => ({ phase: 'idle' }) }), installer: () => ({ status: () => ({ installed: false }), check: async () => ({ ok: true }) }) }));
  assert(sdApi.get() === api, 'register()/get() hand the same API to any caller');
  const found = await api.library.find('odile', { kind: 'lora' });
  assert(Array.isArray(found) && found.length === 1 && found[0].name === 'odile_face', 'library.find(query, {kind})');
  assert((await api.library.characterLock('odile')).id === lock.id && (await api.library.characterLock('nobody')) === null, 'library.characterLock(name)');
  const ist = await api.images.status();
  assert(ist.ok && ist.managed.phase === 'idle', 'images.status() includes the managed runner state');
  const gen2 = await api.images.generate({ prompt: 'x' });
  assert(!gen2.ok && typeof gen2.message === 'string', 'images.generate() with the SD app gone resolves with a plain message (never throws)');
  const boom = sdApi.createImagesApi({ studio: { status: () => { throw new Error('kaboom'); } }, library: lib });
  const b = await boom.images.status();
  assert(!b.ok && b.error === 'INTERNAL' && /kaboom/.test(b.message), 'an internal error becomes { ok:false, message }');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
