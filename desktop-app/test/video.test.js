'use strict';
// test/video.test.js — the 🎬 video engine without Electron:
//   1. the Wan graph (t2v / i2v, both models: nodes, links, clamped params);
//   2. params: validation, clamping (4n+1 frames, 32/16 px grid), purpose, picture shape;
//   3. video-installer against a fake HTTP file server (progress, resume, cancel, a bad size,
//      Stability Matrix folder names, the one-click ComfyUI + model);
//   4. error mapping (OOM, missing model, missing node, timeout, cancel);
//   5. video-studio against the fake ComfyUI (text→video, picture→video with upload, poster,
//      sidecar, progress, cancel, OOM, missing model, old ComfyUI, .webm fallback, character lock,
//      the endpoint backend, BUSY);
//   6. video-api capabilities() / call();
//   7. the bridge routes GET /video/backend and POST /video/request.
// Run: node test/video.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const VS = require('../video-studio');
const VI = require('../video-installer');
const VE = require('../video-errors');
const VA = require('../video-api');
const { fakeComfy, PNG, MP4 } = require('./fixtures/fake-sd');
const { createServiceBridge } = require('../service-bridge');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'video-test-'));
const link = (g, id, input) => g[id].inputs[input];
const nodeOf = (g, cls) => Object.entries(g).find(([, n]) => n.class_type === cls);

// A JPEG header with SOF0 640×480 (enough for imageSize()).
function fakeJpeg(w, h) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14), sof, Buffer.from([0xff, 0xd9])]);
}
function pngOf(w, h) { const b = Buffer.from(PNG); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; }

async function main() {
  // =====================================================================
  console.log('\n== 1. the Wan graph ==');
  {
    const n = VS.normalize('t2v', { prompt: 'waves at dusk' }).params;
    const g = VS.buildWanGraph(n, VI.MODELS['wan22-ti2v-5b']);
    const cls = Object.values(g).map((x) => x.class_type);
    assert(['UNETLoader', 'CLIPLoader', 'VAELoader', 'ModelSamplingSD3', 'Wan22ImageToVideoLatent', 'KSampler', 'VAEDecode', 'CreateVideo', 'SaveVideo', 'ImageFromBatch', 'SaveImage'].every((c) => cls.includes(c)) && !cls.includes('LoadImage'), '5B text→video: every core node, no LoadImage');
    assert(g[1].inputs.unet_name === 'wan2.2_ti2v_5B_fp16.safetensors' && g[2].inputs.clip_name === 'umt5_xxl_fp8_e4m3fn_scaled.safetensors' && g[2].inputs.type === 'wan' && g[3].inputs.vae_name === 'wan2.2_vae.safetensors', '5B: the right model, text encoder (type wan) and VAE files');
    assert(JSON.stringify(link(g, '4', 'model')) === '["1",0]' && JSON.stringify(link(g, '9', 'model')) === '["4",0]' && JSON.stringify(link(g, '9', 'latent_image')) === '["7",0]' && JSON.stringify(link(g, '7', 'vae')) === '["3",0]', 'links: UNET → shift → KSampler; latent ← Wan22ImageToVideoLatent(vae)');
    assert(JSON.stringify(link(g, '5', 'clip')) === '["2",0]' && JSON.stringify(link(g, '9', 'positive')) === '["5",0]' && JSON.stringify(link(g, '9', 'negative')) === '["6",0]', 'links: both prompts through the umt5 CLIP into the sampler');
    assert(JSON.stringify(link(g, '10', 'samples')) === '["9",0]' && JSON.stringify(link(g, '11', 'images')) === '["10",0]' && JSON.stringify(link(g, '12', 'video')) === '["11",0]' && JSON.stringify(link(g, '13', 'image')) === '["10",0]' && JSON.stringify(link(g, '14', 'images')) === '["13",0]', 'links: decode → CreateVideo → SaveVideo, and decode → ImageFromBatch(0) → SaveImage (poster)');
    assert(g[7].inputs.width === 1280 && g[7].inputs.height === 704 && g[7].inputs.length === 121 && g[11].inputs.fps === 24, '5B defaults: 1280×704, 121 frames, 24 fps (ComfyUI\'s template)');
    assert(g[9].inputs.steps === 20 && g[9].inputs.cfg === 5 && g[9].inputs.sampler_name === 'uni_pc' && g[9].inputs.scheduler === 'simple' && g[4].inputs.shift === 8 && g[9].inputs.denoise === 1, '5B defaults: 20 steps, cfg 5, uni_pc / simple, shift 8');
    const i = VS.normalize('i2v', { prompt: 'she smiles', seconds: 4 }, { imageInfo: { width: 768, height: 1024 } }).params;
    i.imageName = 'autoinjector-video-x.png';
    const gi = VS.buildWanGraph(i, VI.MODELS['wan22-ti2v-5b']);
    const li = nodeOf(gi, 'LoadImage');
    assert(li && li[1].inputs.image === 'autoinjector-video-x.png' && JSON.stringify(gi[7].inputs.start_image) === JSON.stringify([li[0], 0]), '5B picture→video: LoadImage(uploaded name) → start_image');
    assert(gi[7].inputs.length === 97 && i.seconds === 4, 'seconds 4 at 24 fps → 97 frames (4n+1)');
    assert(gi[7].inputs.width % 32 === 0 && gi[7].inputs.height % 32 === 0 && gi[7].inputs.height > gi[7].inputs.width && Math.abs(gi[7].inputs.width / gi[7].inputs.height - 0.75) < 0.06, `a 768×1024 picture keeps its shape: ${gi[7].inputs.width}×${gi[7].inputs.height}`);
    const s = VS.normalize('t2v', { prompt: 'a fox', model: 'wan21-t2v-1.3b' }).params;
    const g2 = VS.buildWanGraph(s, VI.MODELS['wan21-t2v-1.3b']);
    assert(nodeOf(g2, 'EmptyHunyuanLatentVideo') && !nodeOf(g2, 'Wan22ImageToVideoLatent') && g2[1].inputs.unet_name === 'wan2.1_t2v_1.3B_fp16.safetensors' && g2[3].inputs.vae_name === 'wan_2.1_vae.safetensors', '1.3B: EmptyHunyuanLatentVideo, its own model + Wan 2.1 VAE');
    assert(g2[7].inputs.width === 832 && g2[7].inputs.height === 480 && g2[7].inputs.length === 33 && g2[11].inputs.fps === 16 && g2[9].inputs.steps === 30 && g2[9].inputs.cfg === 6, '1.3B defaults: 832×480, 33 frames, 16 fps, 30 steps, cfg 6');
    const gw = VS.buildWanGraph(s, VI.MODELS['wan21-t2v-1.3b'], { save: 'SaveWEBM', poster: false, clipDevice: false });
    assert(nodeOf(gw, 'SaveWEBM') && !nodeOf(gw, 'SaveVideo') && !nodeOf(gw, 'CreateVideo') && !nodeOf(gw, 'SaveImage') && gw[12].inputs.fps === 16 && gw[12].inputs.codec === 'vp9' && !('device' in gw[2].inputs), 'the .webm graph (SaveWEBM), no poster, an old CLIPLoader without device');
  }

  // =====================================================================
  console.log('\n== 2. params: checked and clamped to the model ==');
  {
    const n = (mode, r, ctx) => VS.normalize(mode, r, ctx);
    let r = n('t2v', { prompt: 'x', width: 1000, height: 333, frames: 50 });
    assert(r.params.width === 992 && r.params.height === 320 && r.params.frames === 49 && r.warnings.some((w) => w.field === 'size'), '5B: 1000×333 → 992×320 (×32), 50 frames → 49 (4n+1), with a warning');
    r = n('t2v', { prompt: 'x', width: 5000, height: 10, frames: 900 });
    assert(r.params.width === 1280 && r.params.height === 256 && r.params.frames === 121, 'too big / too small → clamped (1280 max side, 256 min, 121 frames max)');
    r = n('t2v', { prompt: 'x', model: 'wan21-t2v-1.3b', width: 850, seconds: 10 });
    assert(r.params.width === 848 && r.params.frames === 81 && r.params.fps === 16, '1.3B: width on a 16 px grid, at most 81 frames (5 s at 16 fps)');
    r = n('t2v', { prompt: 'x', seed: -1 }); assert(Number.isInteger(r.params.seed) && r.params.seed >= 0, 'seed -1 → a random seed (recorded)');
    r = n('t2v', { prompt: 'x', seed: 42, steps: 500, cfgScale: 0, shift: 99 }); assert(r.params.seed === 42 && r.params.steps === 100 && r.params.cfgScale === 1 && r.params.shift === 20, 'steps / cfg / shift clamped');
    r = n('t2v', { prompt: 'x', purpose: 'clip' }); assert(r.params.frames === 97 && r.params.seconds === 4, 'purpose clip → 4 s');
    r = n('t2v', { prompt: 'x', purpose: 'trailer_shot' }); assert(r.params.frames === 121 && r.params.width === 1280, 'purpose trailer_shot → 5 s, 16:9');
    assert(n('t2v', { prompt: 'x', purpose: 'movie' }).error.field === 'purpose', 'an unknown purpose is refused');
    assert(n('t2v', { prompt: 'x', model: 'sora' }).error.code === 'INVALID_PARAM', 'an unknown model is refused');
    assert(n('t2v', { prompt: 'x', width: 'big' }).error.field === 'width', 'a non-number is refused');
    assert(n('i2v', { model: 'wan21-t2v-1.3b' }).error.field === 'model', 'picture→video with the text-only model (asked for) is refused');
    assert(n('i2v', {}, { settings: { model: 'wan21-t2v-1.3b' } }).params.model === 'wan22-ti2v-5b', 'picture→video with the text-only model as the default → Wan 2.2 5B');
    assert(VS.imageSize(fakeJpeg(640, 480)).width === 640 && VS.imageSize(pngOf(300, 200)).height === 200, 'imageSize reads PNG and JPEG headers');
    const f = path.join(TMP, 'pic.png'); fs.writeFileSync(f, pngOf(512, 512));
    assert(VS.readImage(f).width === 512 && VS.readImage(`data:image/png;base64,${pngOf(8, 8).toString('base64')}`).width === 8 && VS.readImage(pngOf(9, 9).toString('base64')).width === 9, 'a picture as a path, a data: URL or base64');
    assert(VS.readImage(path.join(TMP, 'nope.png')).error.code === 'INVALID_PARAM' && VS.readImage('hello').error && VS.readImage(Buffer.from('not a picture at all, just text ok').toString('base64')).error, 'a missing file / junk is refused');
  }

  // =====================================================================
  console.log('\n== 3. installing the models (fake file server) ==');
  {
    const sizes = { 'a.bin': 300000, 'b.bin': 120000, 'c.bin': 50000 };
    const hits = []; let slow = false; let wrongSize = false;
    const srv = http.createServer((req, res) => {
      const name = req.url.split('/').pop(); hits.push({ name, range: req.headers.range || '' });
      const total = sizes[name]; if (!total) { res.writeHead(404); return res.end(); }
      const body = Buffer.alloc(wrongSize ? total - 10 : total, 7);
      const m = /bytes=(\d+)-/.exec(req.headers.range || '');
      const from = m ? Number(m[1]) : 0;
      res.writeHead(m ? 206 : 200, { 'Content-Length': body.length - from });
      if (!slow) return res.end(body.slice(from));
      let i = from; const t = setInterval(() => { if (i >= body.length || res.destroyed) { clearInterval(t); return res.end(); } res.write(body.slice(i, i + 20000)); i += 20000; }, 30);
      res.on('close', () => clearInterval(t));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const tiny = { id: 'tiny', label: 'Tiny', short: 'Tiny', family: 'wan21', modes: ['t2v'], vramGB: 1, defaults: VI.MODELS['wan21-t2v-1.3b'].defaults, limits: VI.MODELS['wan21-t2v-1.3b'].limits,
      files: [{ kind: 'diffusion_models', name: 'a.bin', url: `${base}/a.bin`, bytes: sizes['a.bin'] }, { kind: 'text_encoders', name: 'b.bin', url: `${base}/b.bin`, bytes: sizes['b.bin'] }, { kind: 'vae', name: 'c.bin', url: `${base}/c.bin`, bytes: sizes['c.bin'] }] };
    const comfyRoot = path.join(TMP, 'ComfyUI', 'models');
    const events = [];
    const vi = VI.createVideoInstaller({ models: { tiny }, roots: () => [{ path: comfyRoot, layout: 'comfy', source: 'test ComfyUI' }], onChange: (s) => events.push(s), freeBytes: () => 1e12 });
    let c = vi.check();
    const tm = c.models.find((m) => m.id === 'tiny');
    assert(c.ok && c.anyComfy && tm && !tm.installed && tm.missing.length === 3 && c.models.some((m) => m.id === 'wan22-ti2v-5b' && m.default), 'check(): every catalog model, what is missing, the default marked');
    assert(c.models.find((m) => m.id === 'wan22-ti2v-5b').approxBytes === 9999658848 + 6735906897 + 1409400960 && c.models.find((m) => m.id === 'wan21-t2v-1.3b').approxBytes === 2838303560 + 6735906897 + 253815318, 'the catalog carries the exact Hugging Face sizes');
    let d = await vi.downloadModel('tiny');
    assert(d.ok && fs.statSync(path.join(comfyRoot, 'diffusion_models', 'a.bin')).size === 300000 && fs.existsSync(path.join(comfyRoot, 'text_encoders', 'b.bin')) && fs.existsSync(path.join(comfyRoot, 'vae', 'c.bin')), 'downloadModel: the files land in diffusion_models / text_encoders / vae');
    assert(events.some((e) => e.phase === 'downloading' && e.total === 470000) && events[events.length - 1].phase === 'installed', 'progress over all files, then "installed"');
    assert(vi.check().models.find((m) => m.id === 'tiny').installed, 'check(): now installed');
    hits.length = 0; d = await vi.downloadModel('tiny');
    assert(d.ok && d.already && !hits.length, 'a second download does nothing');
    // cancel mid-way, then resume with a Range request
    const root2 = path.join(TMP, 'C2', 'models');
    const vi2 = VI.createVideoInstaller({ models: { tiny }, roots: () => [{ path: root2, layout: 'comfy' }], freeBytes: () => 1e12 });
    slow = true; hits.length = 0;
    const pr = vi2.downloadModel('tiny');
    await sleep(120);
    assert(vi2.status().busy, 'a download is busy');
    assert((await vi2.downloadModel('tiny')).error === 'BUSY', 'a second download while one runs → BUSY');
    vi2.cancel();
    d = await pr;
    assert(!d.ok && d.error === 'CANCELLED' && vi2.status().phase === 'paused' && fs.existsSync(path.join(root2, 'diffusion_models', 'a.bin.part')) && !fs.existsSync(path.join(root2, 'diffusion_models', 'a.bin')), 'cancel → paused, the partial .part file is kept, no final file');
    const part = fs.statSync(path.join(root2, 'diffusion_models', 'a.bin.part')).size;
    assert(vi2.check().models.find((m) => m.id === 'tiny').files[0].partialBytes === part, 'check() sees the partial download');
    slow = false; hits.length = 0;
    d = await vi2.downloadModel('tiny');
    assert(d.ok && hits.find((h) => h.name === 'a.bin').range === `bytes=${part}-` && fs.statSync(path.join(root2, 'diffusion_models', 'a.bin')).size === 300000, `resumed with Range: bytes=${part}- and finished`);
    // a server that sends the wrong size
    const root3 = path.join(TMP, 'C3', 'models');
    const vi3 = VI.createVideoInstaller({ models: { tiny }, roots: () => [{ path: root3, layout: 'comfy' }], freeBytes: () => 1e12 });
    wrongSize = true;
    d = await vi3.downloadModel('tiny');
    assert(!d.ok && d.error === 'SIZE_MISMATCH' && /did not download completely/.test(d.message) && !fs.existsSync(path.join(root3, 'diffusion_models', 'a.bin')), 'a wrong size → SIZE_MISMATCH, never renamed into place');
    wrongSize = false;
    // Stability Matrix layout
    const sm = path.join(TMP, 'SM', 'Data', 'Models');
    fs.mkdirSync(path.join(sm, 'VAE'), { recursive: true });
    const vi4 = VI.createVideoInstaller({ models: { tiny }, roots: () => [{ path: sm, layout: 'sm', source: 'Stability Matrix' }], freeBytes: () => 1e12 });
    d = await vi4.downloadModel('tiny');
    assert(d.ok && fs.existsSync(path.join(sm, 'DiffusionModels', 'a.bin')) && fs.existsSync(path.join(sm, 'TextEncoders', 'b.bin')) && fs.existsSync(path.join(sm, 'VAE', 'c.bin')), 'Stability Matrix: DiffusionModels / TextEncoders / VAE (its shared folder names)');
    // no space, no ComfyUI, unknown model
    const vi5 = VI.createVideoInstaller({ models: { tiny }, roots: () => [{ path: path.join(TMP, 'C5') }], freeBytes: () => 1000 });
    assert((await vi5.downloadModel('tiny')).error === 'NO_SPACE', 'not enough disk space → NO_SPACE with the sizes');
    const vi6 = VI.createVideoInstaller({ roots: () => [] });
    assert((await vi6.downloadModel('wan22-ti2v-5b')).code === 'VIDEO_NOT_SET_UP' && !vi6.check().anyComfy && /No ComfyUI/.test(vi6.check().message), 'no ComfyUI → VIDEO_NOT_SET_UP, check() says so');
    assert((await vi6.downloadModel('nope')).code === 'INVALID_PARAM', 'an unknown model id is refused');
    // one click: ComfyUI (sd-installer) + the model
    let installed = false;
    const fakeSdInst = { portable: () => (installed ? { models: path.join(TMP, 'portable', 'models') } : null), install: async () => { installed = true; return { ok: true }; }, cancel: () => {} };
    const vi7 = VI.createVideoInstaller({ models: { tiny }, sdInstaller: () => fakeSdInst, freeBytes: () => 1e12 });
    d = await vi7.installAll('tiny');
    assert(d.ok && installed && d.comfyInstalled && fs.existsSync(path.join(TMP, 'portable', 'models', 'vae', 'c.bin')), 'installAll: installs ComfyUI first, then the model into its models folder');
    const vi8 = VI.createVideoInstaller({ models: { tiny }, sdInstaller: () => ({ portable: () => null, install: async () => ({ ok: false, error: 'NOT_WINDOWS', message: 'The one-click install is for Windows.' }), cancel: () => {} }) });
    d = await vi8.installAll('tiny');
    assert(!d.ok && d.step === 'comfyui' && /Windows/.test(d.message), 'installAll: a ComfyUI install failure is reported plainly');
    // the model files found in the connected ComfyUI's lists count too
    const vi9 = VI.createVideoInstaller({ roots: () => [{ path: path.join(TMP, 'empty') }] });
    assert(vi9.check({ diffusion_models: ['wan/wan2.1_t2v_1.3B_fp16.safetensors'], text_encoders: ['umt5_xxl_fp8_e4m3fn_scaled.safetensors'], vae: ['wan_2.1_vae.safetensors'] }).installed.includes('wan21-t2v-1.3b'), 'files ComfyUI lists (even in a subfolder) count as installed');
    await new Promise((r) => srv.close(r));
  }

  // =====================================================================
  console.log('\n== 4. errors in plain words ==');
  {
    const M = Object.values(VI.MODELS);
    let e = VE.explainVideoError({ error: 'COMFY_ERROR', raw: JSON.stringify({ node_type: 'KSampler', exception_type: 'torch.OutOfMemoryError', exception_message: 'Allocation on device 0 would exceed allowed memory' }) }, { models: M });
    assert(e.code === 'VIDEO_OOM' && /832×480/.test(e.fix), 'out of memory → VIDEO_OOM with a fix');
    e = VE.explainVideoError({ error: 'COMFY_REJECTED', raw: JSON.stringify({ error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' }, node_errors: { 1: { class_type: 'UNETLoader', errors: [{ type: 'value_not_in_list', message: 'Value not in list', details: "unet_name: 'wan2.2_ti2v_5B_fp16.safetensors' not in []" }] } } }) }, { models: M });
    assert(e.code === 'VIDEO_MODEL_MISSING' && e.model === 'wan22-ti2v-5b' && /Download/.test(e.fix), 'a model file ComfyUI lacks → VIDEO_MODEL_MISSING with the model id');
    e = VE.explainVideoError({ error: 'COMFY_ERROR', raw: JSON.stringify({ node_type: 'CLIPLoader', exception_message: "FileNotFoundError: No such file 'umt5_xxl_fp8_e4m3fn_scaled.safetensors'" }) }, { models: M, model: 'wan21-t2v-1.3b' });
    assert(e.code === 'VIDEO_MODEL_MISSING', 'a file ComfyUI can\'t open → VIDEO_MODEL_MISSING');
    e = VE.explainVideoError({ error: 'COMFY_REJECTED', raw: JSON.stringify({ error: { type: 'invalid_prompt', message: 'Cannot execute because node Wan22ImageToVideoLatent does not exist.', details: "Node ID '#7'" }, node_errors: {} }) }, { models: M });
    assert(e.code === 'VIDEO_FAILED' && e.cause === 'NODE_MISSING' && e.node === 'Wan22ImageToVideoLatent' && /Update ComfyUI/.test(e.fix), 'a missing node → "update ComfyUI"');
    assert(VE.explainVideoError({ error: 'TIMEOUT' }).code === 'VIDEO_TIMEOUT' && VE.explainVideoError({ error: 'CANCELLED' }).code === 'VIDEO_CANCELLED' && VE.explainVideoError({ error: 'REFUSED' }).code === 'VIDEO_NOT_SET_UP', 'timeout / cancelled / nothing answering');
    e = VE.explainVideoError({ error: 'COMFY_ERROR', raw: JSON.stringify({ node_type: 'VAEDecode', exception_type: 'RuntimeError', exception_message: 'Traceback (most recent call last):\n  File "x.py"\nRuntimeError: shape mismatch in decoder' }) });
    assert(e.code === 'VIDEO_FAILED' && /shape mismatch/.test(e.message) && e.details, 'anything else → VIDEO_FAILED with the first useful line + details');
  }

  // =====================================================================
  console.log('\n== 5. making videos against the fake ComfyUI ==');
  const comfy = await fakeComfy({ videoPolls: 3 });
  const videos = path.join(TMP, 'videos');
  const logs = [];
  const lib = { getLock: (k) => (k === 'Odile' || k === 'lock-1' ? { id: 'lock-1', character: 'Odile', book: 'Ferry', triggerWords: ['odile woman'], prompt: 'red hair, green coat', negative: 'blonde' } : null),
    applyLock: (lock, scene) => ({ prompt: [...lock.triggerWords, lock.prompt, scene.prompt].filter(Boolean).join(', '), negativePrompt: [lock.negative, scene.negativePrompt].filter(Boolean).join(', ') }) };
  let comfyBase = comfy.base;
  const mkStudio = (o = {}) => VS.createVideoStudio(Object.assign({
    comfy: async () => (comfyBase ? { base: comfyBase, label: 'ComfyUI', source: 'test' } : null),
    installer: () => VI.createVideoInstaller({ roots: () => [{ path: path.join(TMP, 'comfy-models') }] }),
    library: lib, videosDir: () => videos, log: (t, d) => logs.push({ t, d }), fileUrl: (p) => `file://${p}`, pollMs: 40, noWs: true,
  }, o));
  const studio = mkStudio();
  {
    let s = await studio.status();
    assert(s.ok && s.ready && s.backend === 'comfy-wan' && s.installed.includes('wan22-ti2v-5b') && s.comfy.saveFormat === 'mp4', `status: ready on comfy-wan with both models (${s.message})`);
    // text → video
    const p = studio.generate({ prompt: 'waves at dusk', seconds: 2, width: 832, height: 480, seed: 7, from: 'test' }, 'test');
    await sleep(60);
    const pg = await studio.progress();
    assert(pg.busy && pg.mode === 't2v' && typeof pg.seconds === 'number', `progress while rendering: ${pg.phase}`);
    assert((await studio.generate({ prompt: 'again' })).error === 'BUSY', 'one video at a time → BUSY');
    const r = await p;
    const g = comfy.state.videoGraphs[comfy.state.videoGraphs.length - 1];
    assert(r.ok && r.engine === 'comfy-wan' && r.model === 'wan22-ti2v-5b' && r.width === 832 && r.height === 480 && r.frames === 49 && r.fps === 24 && r.seed === 7 && r.seconds === 2, `text→video result: ${JSON.stringify({ path: r.path && path.basename(r.path), frames: r.frames, seconds: r.seconds })}`);
    assert(r.path && /\.mp4$/.test(r.path) && fs.readFileSync(r.path).equals(MP4) && r.poster && fs.readFileSync(r.poster).slice(0, 8).equals(PNG.slice(0, 8)), 'the .mp4 and the .png poster are saved in videos/');
    const side = JSON.parse(fs.readFileSync(r.json, 'utf8'));
    assert(side.kind === 'video' && side.prompt === 'waves at dusk' && side.seed === 7 && side.model === 'wan22-ti2v-5b' && side.frames === 49 && side.promptId && side.poster === path.basename(r.poster), 'the .json sidecar has every setting');
    assert(g && nodeOf(g, 'Wan22ImageToVideoLatent')[1].inputs.length === 49 && nodeOf(g, 'KSampler')[1].inputs.seed === 7 && nodeOf(g, 'CreateVideo')[1].inputs.fps === 24, 'ComfyUI got the graph with those settings');
    assert(comfy.state.views.some((f) => /\.mp4$/.test(f)) && comfy.state.views.some((f) => /poster.*\.png$/.test(f)), 'the video and the poster were fetched from /view');
    // picture → video
    const pic = path.join(TMP, 'portrait.png'); fs.writeFileSync(pic, pngOf(832, 1216));
    const ups = comfy.state.uploads.length;
    const a = await studio.animate({ image: pic, seconds: 4, purpose: 'clip', from: 'akowe-forge', returnPoster: true });
    const ga = comfy.state.videoGraphs[comfy.state.videoGraphs.length - 1];
    const li = nodeOf(ga, 'LoadImage');
    assert(a.ok && comfy.state.uploads.length === ups + 1 && li && li[1].inputs.image === comfy.state.uploads[comfy.state.uploads.length - 1].name, 'picture→video: the picture is uploaded and LoadImage uses it');
    assert(a.frames === 97 && a.seconds === 4 && a.height > a.width && a.width % 32 === 0 && /^clip-/.test(path.basename(a.path)) && a.posterBase64, `clip: 4 s, portrait shape ${a.width}×${a.height}, posterBase64 returned`);
    assert(/subtle natural motion/.test(nodeOf(ga, 'KSampler') && ga[5].inputs.text), 'animate without a prompt → a gentle idle-motion prompt');
    // character lock
    const cl = await studio.generate({ prompt: 'walks along the pier', characterLock: 'Odile', seconds: 1 });
    const gl = comfy.state.videoGraphs[comfy.state.videoGraphs.length - 1];
    assert(cl.ok && /odile woman, red hair, green coat, walks along the pier/.test(gl[5].inputs.text) && /blonde/.test(gl[6].inputs.text), 'characterLock adds the lock\'s looks (and its negative)');
    assert((await studio.generate({ prompt: 'x', characterLock: 'Nobody' })).error === 'NO_LOCK', 'an unknown lock → NO_LOCK');
    // gallery
    const gal = studio.gallery(10);
    assert(gal.ok && gal.items.length >= 3 && gal.items[0].posterUrl && gal.items.every((x) => /\.(mp4|webm)$/.test(x.path)) && gal.items.some((x) => x.record && x.record.prompt === 'waves at dusk'), 'gallery: newest first, with posters and sidecars');
    // checks before anything is queued
    assert((await studio.generate({ prompt: 'x', sampler: 'nope' })).field === 'sampler', 'a sampler ComfyUI lacks is refused (with the list)');
    assert((await studio.generate({ image: pic })).field === 'image', 'generate with a picture → use animate');
    assert((await studio.animate({ prompt: 'x' })).field === 'image', 'animate without a picture is refused');
    assert((await studio.generate({})).error === 'NEED_PROMPT', 'no prompt → NEED_PROMPT');
    // the 1-second test
    const t = await studio.test();
    assert(t.ok && t.model === 'wan21-t2v-1.3b' && t.frames === 17 && t.seconds === 1 && t.width === 416, `test(): a 1-second clip with the small model (${t.width}×${t.height}, ${t.frames} frames)`);
  }
  // cancel
  {
    const c2 = await fakeComfy({ videoPolls: 1000 });
    comfyBase = c2.base;
    const st2 = mkStudio();
    const p = st2.generate({ prompt: 'slow' });
    await sleep(150);
    const cr = await st2.cancel();
    const r = await p;
    assert(cr.cancelled && r.error === 'VIDEO_CANCELLED' && c2.state.interrupted && c2.state.deleted.length === 1, 'cancel → /interrupt + removed from the queue → VIDEO_CANCELLED');
    const pt = await st2.generate({ prompt: 'slow', timeoutMs: 10000 });
    assert(!pt.ok, 'after an interrupt the fake stays interrupted (sanity)');
    await c2.close();
    // timeout
    const c3 = await fakeComfy({ videoPolls: 1000 });
    comfyBase = c3.base;
    const st3 = mkStudio({ settings: { timeoutMs: 60000 } });
    const tp = st3.generate({ prompt: 'slow', timeoutMs: 10000 });
    const t0 = Date.now(); const rt = await tp;
    assert(rt.error === 'VIDEO_TIMEOUT' && Date.now() - t0 >= 9000, 'a render past timeoutMs → VIDEO_TIMEOUT');
    await c3.close();
  }
  // OOM, missing model, old ComfyUI, webm fallback, nothing running
  {
    const oom = await fakeComfy({ failWith: 'Allocation on device 0 would exceed allowed memory. (Currently allocated: 11.5 GiB)', failType: 'torch.OutOfMemoryError', failNode: 'KSampler' });
    comfyBase = oom.base;
    let r = await mkStudio().generate({ prompt: 'x' });
    assert(!r.ok && r.error === 'VIDEO_OOM' && r.code === 'VIDEO_OOM' && r.fix && r.serverError, 'out of memory → VIDEO_OOM + fix + what ComfyUI said');
    await oom.close();
    const nom = await fakeComfy({ wanModels: ['wan2.1_t2v_1.3B_fp16.safetensors', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', 'wan_2.1_vae.safetensors'] });
    comfyBase = nom.base;
    r = await mkStudio().animate({ image: pngOf(64, 64).toString('base64') });
    assert(!r.ok && r.error === 'VIDEO_MODEL_MISSING' && r.model === 'wan22-ti2v-5b' && !nom.state.videoGraphs.length, 'the 5B model missing → VIDEO_MODEL_MISSING (model id), nothing queued');
    const s = await mkStudio().status();
    assert(s.ready && s.installed.join() === 'wan21-t2v-1.3b', 'status: only the 1.3B model is installed');
    const caps = await VA.createVideoApi({ studio: mkStudio() }).capabilities();
    const an = caps.operations.find((o) => o.name === 'video.animate');
    assert(!an.available && /Wan 2.2 5B/.test(an.hint), 'capabilities: animate is not available without the 5B model, and says why');
    await nom.close();
    const old = await fakeComfy({ noWan: true });
    comfyBase = old.base;
    r = await mkStudio().generate({ prompt: 'x' });
    assert(!r.ok && r.error === 'VIDEO_FAILED' && r.cause === 'NODE_MISSING' && /Update ComfyUI/.test(r.fix), 'a ComfyUI without the Wan nodes → "update ComfyUI"');
    assert(/too old/.test((await mkStudio().status()).message), 'status says the ComfyUI is too old');
    await old.close();
    const webm = await fakeComfy({ noSaveVideo: true });
    comfyBase = webm.base;
    r = await mkStudio().generate({ prompt: 'x', seconds: 1 });
    assert(r.ok && /\.webm$/.test(r.path) && nodeOf(webm.state.videoGraphs[0], 'SaveWEBM'), 'a ComfyUI without SaveVideo → SaveWEBM → .webm');
    await webm.close();
    const rej = await fakeComfy({ rejectSaveVideo: true });
    comfyBase = rej.base;
    r = await mkStudio().generate({ prompt: 'x', seconds: 1 });
    assert(r.ok && /\.webm$/.test(r.path) && rej.state.videoGraphs.length === 1 && r.warnings.some((w) => w.field === 'format'), 'SaveVideo refused its inputs → retried once with SaveWEBM (and said so)');
    await rej.close();
    const nop = await fakeComfy({ noPosterNodes: true });
    comfyBase = nop.base;
    const pic = path.join(TMP, 'p2.png'); fs.writeFileSync(pic, pngOf(64, 64));
    r = await mkStudio().animate({ image: pic, seconds: 1 });
    assert(r.ok && r.poster && fs.readFileSync(r.poster).equals(fs.readFileSync(pic)), 'no poster nodes → the input picture becomes the poster');
    r = await mkStudio().generate({ prompt: 'x', seconds: 1 });
    assert(r.ok && !r.poster && r.warnings.some((w) => w.field === 'poster'), 'text→video without poster nodes → no poster, with a warning');
    await nop.close();
    comfyBase = null;
    r = await mkStudio({ installer: () => VI.createVideoInstaller({ roots: () => [] }) }).generate({ prompt: 'x' });
    assert(!r.ok && r.error === 'VIDEO_NOT_SET_UP' && /Install ComfyUI/.test(r.fix), 'no ComfyUI at all → VIDEO_NOT_SET_UP with the one-click fix');
    r = await mkStudio().generate({ prompt: 'x' });
    assert(!r.ok && r.error === 'VIDEO_NOT_SET_UP' && /Start ComfyUI/.test(r.fix), 'ComfyUI installed but not running → VIDEO_NOT_SET_UP, "▶ Start ComfyUI"');
    assert(!(await mkStudio().status()).ready, 'status: not ready');
  }
  // the endpoint backend (the old video-provider)
  {
    const calls = [];
    const vp = { status: () => ({ configured: true, enabled: true, endpoint: 'http://x/gen' }), getSettings: () => ({ frames: 16, fps: 8, width: 512, height: 512, seed: -1 }), generate: async (prompt, o) => { calls.push({ prompt, o }); return { ok: true, videoBase64: MP4.toString('base64') }; } };
    comfyBase = null;
    const se = mkStudio({ videoProvider: vp });
    const s = await se.status();
    assert(s.ready && s.backend === 'endpoint', 'no ComfyUI but the endpoint is on → backend "endpoint"');
    let r = await se.generate({ prompt: 'a cube spins', negativePrompt: 'blur' });
    assert(r.ok && r.engine === 'endpoint' && calls[0].prompt === 'a cube spins' && calls[0].o.negativePrompt === 'blur' && /\.mp4$/.test(r.path) && fs.existsSync(r.json) && r.frames === 16 && r.fps === 8, 'text→video through the endpoint, saved with a sidecar');
    r = await se.animate({ image: pngOf(32, 32).toString('base64') });
    assert(!r.ok && r.error === 'UNSUPPORTED_ON_BACKEND', 'picture→video on the endpoint → UNSUPPORTED_ON_BACKEND');
    const caps = await VA.createVideoApi({ studio: se }).capabilities();
    assert(caps.operations.find((o) => o.name === 'video.animate').code === 'UNSUPPORTED_ON_BACKEND', 'capabilities: animate marked UNSUPPORTED_ON_BACKEND on the endpoint');
    vp.generate = async () => ({ ok: false, error: 'VIDEO_DISABLED', message: 'Video generation is turned off.' });
    r = await se.generate({ prompt: 'x' });
    assert(r.error === 'VIDEO_NOT_SET_UP' && r.engine === 'endpoint', 'endpoint off → VIDEO_NOT_SET_UP');
    vp.generate = async () => ({ ok: false, error: 'TIMEOUT', message: 'slow' });
    assert((await se.generate({ prompt: 'x' })).error === 'VIDEO_TIMEOUT', 'endpoint timeout → VIDEO_TIMEOUT');
    // settings
    assert(se.settings({ backend: 'comfy-wan', model: 'wan21-t2v-1.3b', comfyUrl: '127.0.0.1:8188', timeoutMs: 120000 }).ok && se.getSettings().comfyUrl === 'http://127.0.0.1:8188' && se.getSettings().model === 'wan21-t2v-1.3b', 'settings: backend, model, address (normalised), time limit');
    assert(se.settings({ backend: 'magic' }).field === 'backend' && se.settings({ model: 'x' }).field === 'model', 'bad settings are refused');
    assert(!(await se.status()).ready, 'backend comfy-wan with no ComfyUI → not ready (no silent fallback)');
  }

  // =====================================================================
  console.log('\n== 6. video-api: capabilities() and call() ==');
  comfyBase = comfy.base;
  const api = VA.createVideoApi({ studio: mkStudio() });
  {
    const caps = await api.capabilities();
    const names = caps.operations.map((o) => o.name);
    assert(caps.ok && caps.ready && caps.backend === 'comfy-wan' && ['video.status', 'video.capabilities', 'video.models', 'video.cancel', 'video.progress', 'video.gallery', 'video.generate', 'video.animate', 'video.install.check', 'video.install.downloadModel', 'video.install.cancel'].every((n) => names.includes(n)), 'capabilities(): every method in the contract');
    assert(caps.operations.every((o) => typeof o.changes === 'boolean' && typeof o.available === 'boolean' && o.params && o.params.type === 'object' && typeof o.hint === 'string'), 'every operation: JSON schema, changes, available, hint');
    assert(!caps.operations.find((o) => o.name === 'video.status').changes && caps.operations.find((o) => o.name === 'video.generate').changes && caps.operations.find((o) => o.name === 'video.install.downloadModel').changes, 'read-only ops have changes:false, making / downloading have changes:true');
    assert(caps.models.length === 2 && caps.models.every((m) => m.installed) && caps.errors.includes('VIDEO_MODEL_MISSING'), 'capabilities(): models + error codes');
    assert(JSON.stringify(VA.operationNames()) === JSON.stringify(VA.OPS.map((o) => o.name)) && VA.get() === null && VA.register(api) === api && VA.get() === api, 'operationNames / register / get');
    let r = await api.call('video.generate', { prompt: 'a lantern', seconds: 1 });
    assert(r.ok && r.engine === 'comfy-wan' && fs.existsSync(r.path), 'call("video.generate") makes a video');
    r = await api.call('video.animate', { image: pngOf(64, 96).toString('base64'), seconds: 1 });
    assert(r.ok && r.height > r.width, 'call("video.animate") with base64');
    r = await api.call('video.generate', { prompt: 'x', lenght: 3 });
    assert(r.error === 'INVALID_PARAM' && r.field === 'lenght', 'call: an unknown parameter is refused (with a suggestion)');
    assert((await api.call('video.generate', {})).field === 'prompt' && (await api.call('video.animate', { prompt: 'x' })).field === 'image', 'call: required params');
    assert((await api.call('video.nope', {})).error === 'UNKNOWN_OPERATION', 'call: unknown operation');
    assert((await api.video.generate({ prompt: 'x', colour: 'red' })).field === 'colour', 'direct method: unknown key refused');
    assert((await api.call('video.status')).ok && (await api.call('video.models')).models.length === 2 && (await api.call('video.progress')).busy === false && (await api.call('video.gallery', { limit: 2 })).items.length === 2, 'status / models / progress / gallery through call');
    assert((await api.call('video.install.check')).ok && (await api.call('video.install.cancel')).ok && (await api.call('video.cancel')).ok, 'install.check / install.cancel / cancel through call');
    assert((await api.call('video.capabilities')).operations.length === VA.OPS.length, 'video.capabilities = capabilities()');
    const broken = VA.createVideoApi({ studio: { status: () => { throw new Error('boom'); } } });
    assert((await broken.video.status()).error === 'INTERNAL' && (await broken.capabilities()).ok, 'never throws (a throwing studio → INTERNAL; capabilities still answers)');
    assert((await VA.createVideoApi({ studio: {} }).video.generate({ prompt: 'x' })).error === 'NOT_WIRED', 'a missing method → NOT_WIRED');
  }

  // =====================================================================
  console.log('\n== 7. the bridge: GET /video/backend, POST /video/request ==');
  {
    const st = mkStudio();
    const bridge = createServiceBridge({ video: { backend: () => st.backendInfo(), request: (b) => st.request(b, `bridge:${b.from || 'akowe'}`) } });
    const started = await bridge.start({ port: 0, host: '127.0.0.1', token: 'tok' });
    const port = started.port || (started.address && started.address.port);
    const req = (method, p, body, token = 'tok') => new Promise((resolve) => {
      const data = body ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : null;
      const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: `Bearer ${token}` } : {}, data ? { 'Content-Length': data.length } : {}) }, (res) => { const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(ch).toString('utf8')); } catch (_) {} resolve({ status: res.statusCode, json: j }); }); });
      r.on('error', (e) => resolve({ status: 0, error: e.code }));
      if (data) r.write(data); r.end();
    });
    let r = await req('GET', '/video/backend', null, '');
    assert(r.status === 401, 'same auth as /image/*: no token → 401');
    r = await req('GET', '/video/backend');
    assert(r.status === 200 && r.json.ok && r.json.ready && r.json.backend === 'comfy-wan' && r.json.models.length === 2, 'GET /video/backend: ready, comfy-wan, the models');
    const pic = path.join(TMP, 'akowe-portrait.png'); fs.writeFileSync(pic, pngOf(512, 768));
    r = await req('POST', '/video/request', { image: pic, prompt: 'subtle idle motion, breathing, cloth moving, camera still', seconds: 4, purpose: 'clip', from: 'akowe-forge', returnPoster: true });
    assert(r.status === 200 && r.json.ok && r.json.engine === 'comfy-wan' && r.json.frames === 97 && /\.mp4$/.test(r.json.path) && /\.png$/.test(r.json.poster) && r.json.posterBase64, 'POST /video/request with a picture path → animate (Akọwe\'s clip), poster as base64');
    r = await req('POST', '/video/request', { prompt: 'a ship in fog', seconds: 1, image: pngOf(64, 64).toString('base64') });
    assert(r.status === 200 && r.json.ok && r.json.mode === 'i2v', 'POST /video/request with base64 → animate');
    r = await req('POST', '/video/request', { prompt: 'a ship in fog', seconds: 1 });
    assert(r.status === 200 && r.json.ok && r.json.mode === 't2v' && !r.json.posterBase64, 'POST /video/request without image → text→video');
    r = await req('POST', '/video/request', { prompt: 'x', purpose: 'movie' });
    assert(r.status === 400 && r.json.error === 'INVALID_PARAM', 'a bad param → 400 INVALID_PARAM');
    r = await req('POST', '/video/request', '{nope');
    assert(r.status === 400 && r.json.error === 'BAD_JSON', 'bad JSON → 400');
    comfyBase = null;
    r = await req('POST', '/video/request', { prompt: 'x' });
    assert(r.status === 503 && r.json.error === 'VIDEO_NOT_SET_UP' && r.json.message, 'not set up → 503 VIDEO_NOT_SET_UP with a message');
    comfyBase = comfy.base;
    const throwing = createServiceBridge({ video: { backend: () => { throw new Error('x'); }, request: () => { throw new Error('boom'); } } });
    const s2 = await throwing.start({ port: 0, host: '127.0.0.1', token: 'tok' });
    const port2 = s2.port || (s2.address && s2.address.port);
    const r2 = await new Promise((resolve) => { const rq = http.request({ host: '127.0.0.1', port: port2, path: '/video/request', method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' } }, (res) => { const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(ch).toString()) })); }); rq.end('{"prompt":"x"}'); });
    assert(r2.status === 502 && r2.json.error === 'VIDEO_FAILED' && /boom/.test(r2.json.message), 'a request that throws still answers (502 VIDEO_FAILED)');
    const unwired = createServiceBridge({});
    const s3 = await unwired.start({ port: 0, host: '127.0.0.1', token: 'tok' });
    const r3 = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: s3.port || s3.address.port, path: '/video/backend', headers: { Authorization: 'Bearer tok' } }, (res) => { res.resume(); resolve(res.statusCode); }));
    assert(r3 === 501, 'no video wired → 501');
    await bridge.stop(); await throwing.stop(); await unwired.stop();
  }
  // ---- from the 360 review: stop / time out, model in another ComfyUI's folder, an oversized bridge body ----
  console.log('\n== stopping a video never leaves it rendering; a time-out stops it too ==');
  {
    const slow = await fakeComfy({ videoPolls: 1000 });
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'vcancel-'));
    const st = VS.createVideoStudio({ comfy: async () => { await new Promise((r) => setTimeout(r, 300)); return { base: slow.base }; }, installer: () => VI.createVideoInstaller({ roots: () => [] }), videosDir: () => T, pollMs: 40, noWs: true });
    const pr = st.generate({ prompt: 'slow' });
    await new Promise((r) => setTimeout(r, 50));
    await st.cancel();
    const r = await pr;
    assert(r.error === 'VIDEO_CANCELLED' && Object.keys(slow.state.prompts).length === 0 && slow.state.interrupted === false, 'Stop while ComfyUI is still starting: nothing is queued, and nothing else ComfyUI renders is interrupted');
    const st2 = VS.createVideoStudio({ comfy: async () => ({ base: slow.base }), installer: () => VI.createVideoInstaller({ roots: () => [] }), videosDir: () => T, pollMs: 40, noWs: true });
    const pr2 = st2.generate({ prompt: 'slow' });
    for (let i = 0; i < 100 && !Object.keys(slow.state.prompts).length; i++) await new Promise((res) => setTimeout(res, 20));
    await st2.cancel();
    const r2 = await pr2;
    assert(r2.error === 'VIDEO_CANCELLED' && slow.state.deleted.length >= 1, 'Stop while it renders: this job\'s prompt is interrupted and taken off the queue');
    await slow.close();
  }
  console.log('\n== a model file in ANOTHER ComfyUI\'s folder is not "installed" for the running one ==');
  {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'vroot-'));
    const files = new Map([['/v.bin', Buffer.from('abcd')]]);
    const srv = http.createServer((req, res) => { const b = files.get(req.url); if (!b) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Length': b.length }); res.end(b); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/v.bin`;
    const tiny = { id: 'tiny', label: 't', short: 'Tiny', family: 'wan22', modes: ['t2v'], vramGB: 1, files: [{ kind: 'vae', name: 'v.bin', url, bytes: 4 }], defaults: {}, limits: {} };
    const sm = path.join(T, 'sm'); const port = path.join(T, 'portable');
    fs.mkdirSync(path.join(sm, 'VAE'), { recursive: true }); fs.mkdirSync(port, { recursive: true });
    fs.writeFileSync(path.join(sm, 'VAE', 'v.bin'), 'abcd');
    const vi = VI.createVideoInstaller({ models: { tiny }, roots: () => [{ path: sm, layout: 'sm' }], sdInstaller: () => ({ portable: () => ({ models: port }) }), preferredRoot: () => ({ path: port }), freeBytes: () => 1e12 });
    const c = vi.check({ diffusion_models: [], text_encoders: [], vae: [] });
    assert(!c.models.find((m) => m.id === 'tiny').installed, 'check(): the running ComfyUI lists no such VAE → not installed (even though Stability Matrix has it)');
    const d = await vi.downloadModel('tiny');
    assert(d.ok && !d.already && fs.existsSync(path.join(port, 'vae', 'v.bin')), 'Download puts it into the TARGET ComfyUI instead of answering "already downloaded"');
    try { srv.closeAllConnections(); } catch (_) {} srv.close();
  }
  console.log('\n== an oversized bridge body is refused and its connection closed ==');
  {
    const b = createServiceBridge({ video: { backend: () => ({}), request: async () => ({ ok: true }) } });
    const s4 = await b.start({ port: 0, host: '127.0.0.1', token: 'tok' });
    const r = await new Promise((resolve) => {
      // The answer is decided by the headers; the server then destroys the socket, so never wait for 'end'
      // (and never longer than 20 s), or the suite could hang on a fast close.
      let done = false; const fin = (v) => { if (!done) { done = true; clearTimeout(tm); resolve(v); } };
      const tm = setTimeout(() => fin({ status: 0, conn: 'timeout' }), 20000);
      const rq = http.request({ host: '127.0.0.1', port: s4.port || s4.address.port, method: 'POST', path: '/video/request', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' } }, (res) => { fin({ status: res.statusCode, conn: res.headers.connection }); res.resume(); res.on('error', () => {}); });
      rq.on('error', () => fin({ status: 0, conn: 'error' }));
      const chunk = Buffer.alloc(1024 * 1024, 'a'); let n = 0;
      const pump = () => { while (n < 45) { n++; if (!rq.write(chunk)) { rq.once('drain', pump); return; } } rq.end(); };
      pump();
    });
    assert((r.status === 400 && r.conn === 'close') || r.conn === 'error', `over 40 MB → refused and the connection closed, never left hanging (${r.status} ${r.conn})`);
    await b.stop();
  }
  await comfy.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
