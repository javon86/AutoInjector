'use strict';
// test/framepack.test.js — 🎞 FramePack as a 🎬 Video engine, without a GPU / torch / FramePack:
//   1. finding it: not found, a chosen folder that isn't FramePack, Stability Matrix's Packages, AUTOINJECTOR_FRAMEPACK,
//      its venv python missing, the models ("stuff and thing" first, else hf_download; the missing list; a missing shard);
//   2. the runner process (framepack.js) against the fake runner (test/fixtures/fake-framepack-runner.js, same JSON-lines
//      protocol): load once, generate with progress, offline env + cwd, BUSY, cancel, OOM words, a crash, no python;
//   3. video-studio with engine framepack: status / auto (FramePack when Wan isn't installed; Wan when it is), picture→video
//      → mp4 + poster + sidecar in videos/ + gallery, progress (parts / steps), Stop, text→video = a picture first (🎨 Images)
//      then animated, a failed picture, FramePack's own settings (seconds 1–10, steps, TeaCache, GPU memory), Remake,
//      settings (backend framepack, framepackDir), the 2-second test from a test picture, errors in plain words;
//   4. video-api: capabilities (picture→video available with FramePack), engine / FramePack params, video.framepack.*;
//   5. book trailers with FramePack shots (the shot key includes the engine);
//   6. health-watch: the FramePack row and problems.
// Run: node test/framepack.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const FP = require('../framepack');
const VS = require('../video-studio');
const VA = require('../video-api');
const VT = require('../video-trailer');
const HW = require('../health-watch');
const F = require('./fixtures/fake-framepack');
const { fakeComfy, PNG } = require('./fixtures/fake-sd');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(20); } return null; }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'framepack-test-'));
const ENV0 = Object.assign({}, process.env);
function setEnv(o) { for (const k of ['AUTOINJECTOR_FRAMEPACK_PYTHON', 'AUTOINJECTOR_FRAMEPACK_RUNNER', 'FAKE_FP_MODE', 'FAKE_FP_LOG', 'FAKE_FP_STEP_MS', 'AUTOINJECTOR_FRAMEPACK']) delete process.env[k]; Object.assign(process.env, o || {}); }
const readLog = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } };

const png = FP.testPicture();
async function main() {
  // =====================================================================
  console.log('\n== 1. finding FramePack ==');
  setEnv({});
  const fpDir = F.makeFramePackDir(path.join(TMP, 'SM', 'Data', 'Packages', 'FramePack'));
  const stuffHf = path.join(TMP, 'stuff', 'models', 'video', 'framepack', 'hf');
  {
    let f = FP.findFramePack({ env: {}, smPackages: () => [], modelsDir: stuffHf });
    assert(!f.found && !f.ready && /not found/.test(f.message) && /Choose FramePack folder/.test(f.message), `nothing anywhere → not found, in plain words (${f.message})`);
    assert(FP.notReady(f).code === 'FRAMEPACK_NOT_FOUND' && /Choose FramePack folder/.test(FP.notReady(f).fix), 'FRAMEPACK_NOT_FOUND says what to press');
    f = FP.findFramePack({ dir: path.join(TMP, 'nothing-here'), env: {}, smPackages: () => [] });
    assert(!f.found && f.chosenMissing && /no FramePack in the chosen folder/.test(f.message), 'a chosen folder that is not FramePack → said so');
    f = FP.findFramePack({ env: {}, smPackages: () => [{ dir: path.join(TMP, 'SM', 'Data', 'Packages', 'ComfyUI'), packageName: 'ComfyUI' }, { dir: fpDir, packageName: 'FramePack', displayName: 'FramePack' }], modelsDir: stuffHf });
    assert(f.found && f.dir === fpDir && f.source === 'Stability Matrix', 'Stability Matrix\'s Packages\\FramePack is found');
    assert(f.pythonOk && /venv/.test(f.python), `its own venv python is used (${f.python})`);
    assert(!f.models.ok && f.models.missing.length === 8 && f.models.missing.includes('hunyuanvideo-community/HunyuanVideo/vae') && f.models.missing.includes('lllyasviel/FramePackI2V_HY'), `no models yet → all 8 parts listed as missing (${f.models.missing.length})`);
    assert(FP.notReady(f).code === 'FRAMEPACK_MODEL_MISSING' && FP.notReady(f).missing.length === 8 && /Nothing is downloaded/.test(FP.notReady(f).fix), 'FRAMEPACK_MODEL_MISSING lists which, and never downloads');
    // models in FramePack's own hf_download only
    F.makeHfCache(path.join(fpDir, 'hf_download'));
    f = FP.findFramePack({ env: {}, smPackages: () => [{ dir: fpDir, packageName: 'FramePack' }], modelsDir: stuffHf });
    assert(f.ready && f.hfHome === path.join(fpDir, 'hf_download') && /hf_download/.test(f.hfSource), 'models only in FramePack\'s hf_download → used from there');
    // "stuff and thing" wins when it has them
    F.makeHfCache(stuffHf);
    f = FP.findFramePack({ env: {}, smPackages: () => [{ dir: fpDir, packageName: 'FramePack' }], modelsDir: stuffHf });
    assert(f.ready && f.hfHome === stuffHf && /stuff and thing/.test(f.hfSource) && /✔ FramePack is ready/.test(f.message), '"stuff and thing"/models/video/framepack/hf is used first');
    const c = FP.checkModels(stuffHf);
    assert(c.ok && c.repos.length === 3 && c.repos.every((r) => r.ok && r.label), 'checkModels: the three models, each with a plain label');
    // a missing part / a missing shard
    const partial = path.join(TMP, 'partial-hf');
    F.makeHfCache(partial, { skip: ['hunyuanvideo-community/HunyuanVideo/vae', 'lllyasviel/flux_redux_bfl/image_encoder'], dropPart: 'diffusion_pytorch_model-00002-of-00003.safetensors' });
    const cp = FP.checkModels(partial);
    assert(!cp.ok && cp.missing.length === 3 && cp.missing.includes('hunyuanvideo-community/HunyuanVideo/vae') && cp.missing.includes('lllyasviel/flux_redux_bfl/image_encoder') && cp.missing.some((m) => /FramePackI2V_HY \(missing 1 of 3 parts/.test(m)), `missing folders and a missing shard are named: ${cp.missing.join(' | ')}`);
    // AUTOINJECTOR_FRAMEPACK and a missing venv
    const noVenv = F.makeFramePackDir(path.join(TMP, 'FramePack-novenv'), { venv: false });
    f = FP.findFramePack({ env: { AUTOINJECTOR_FRAMEPACK: noVenv }, smPackages: () => [], modelsDir: stuffHf });
    assert(f.found && f.source === 'AUTOINJECTOR_FRAMEPACK' && !f.pythonOk && FP.notReady(f).code === 'FRAMEPACK_PYTHON_MISSING' && /Stability Matrix/.test(FP.notReady(f).fix), 'AUTOINJECTOR_FRAMEPACK is used; no venv → FRAMEPACK_PYTHON_MISSING with what to do');
    f = FP.findFramePack({ dir: fpDir, env: { AUTOINJECTOR_FRAMEPACK: noVenv }, smPackages: () => [], modelsDir: stuffHf });
    assert(f.found && f.dir === fpDir && f.source === 'chosen folder', 'the chosen folder comes first');
    assert(FP.isFramePackDir(fpDir) && !FP.isFramePackDir(path.join(TMP, 'stuff')), 'isFramePackDir: demo_gradio.py + diffusers_helper');
    const sz = VS.imageSize(png);
    assert(sz && sz.type === 'png' && sz.width === 640 && sz.height === 480 && png.length > 1000, 'the built-in test picture is a real 640×480 PNG');
  }

  // =====================================================================
  console.log('\n== 2. the runner process (fake runner, same protocol) ==');
  const runLog = path.join(TMP, 'runner.log');
  setEnv(F.runnerEnv({ log: runLog }));
  const findOk = () => FP.findFramePack({ dir: fpDir, smPackages: () => [], modelsDir: stuffHf });
  const events = [];
  let mgr = FP.createFramePack({ find: findOk, onEvent: (e) => events.push(e), cancelKillMs: 3000 });
  {
    const s0 = mgr.status();
    assert(s0.ready && !s0.running && !s0.loaded && /NVIDIA/.test(s0.vramHint), 'status before anything: ready, not running, a VRAM hint');
    const l = await mgr.load();
    assert(l.ok && l.loaded && l.vramGB === 11.5 && mgr.status().loaded && mgr.status().running, `▶ Load: the models load once (${JSON.stringify(l)})`);
    assert(events.some((e) => e.type === 'loading' && /text encoder/.test(e.stage)) && events.some((e) => e.type === 'loaded'), 'loading stages are told (for the Setup card)');
    const l2 = await mgr.load();
    assert(l2.ok && l2.already, 'a second ▶ Load does nothing (already loaded)');
    const start = readLog(runLog).find((x) => x.start);
    assert(start && start.HF_HOME === stuffHf && start.HF_HUB_OFFLINE === '1' && start.cwd === fpDir && start.framepackDir === fpDir && start.hfHome === stuffHf, 'the runner runs offline (HF_HUB_OFFLINE=1), HF_HOME = the models folder, in the FramePack folder');
    const pic = path.join(TMP, 'pic.png'); fs.writeFileSync(pic, png);
    const out = path.join(TMP, 'gen', 'a.mp4');
    const prog = [];
    const r = await mgr.generate({ image: pic, prompt: 'clouds drift', seconds: 2, steps: 4, seed: 7, out, poster: path.join(TMP, 'gen', 'a.png') }, (ev) => prog.push(ev));
    assert(r.ok && r.path === out && fs.existsSync(out) && r.frames === 73 && r.fps === 30 && r.seconds === 2.43 && r.sections === 2, `generate → mp4 (${r.frames} frames, ${r.seconds} s, 2 parts)`);
    assert(prog.some((p) => p.phase === 'sampling' && p.section === 2 && p.step === 4 && p.steps === 4) && prog.some((p) => p.phase === 'decoding'), 'progress: part i of n, step, decoding');
    const gen = readLog(runLog).map((x) => x.cmd).filter((x) => x && x.cmd === 'generate').pop();
    assert(gen && gen.image === pic && gen.seconds === 2 && gen.steps === 4 && gen.seed === 7 && gen.out === out, 'the runner got the request as JSON');
    // BUSY + cancel
    const slow = mgr.generate({ image: pic, seconds: 5, steps: 200, out: path.join(TMP, 'gen', 'b.mp4') }, () => {});
    await sleep(80);
    const busy = await mgr.generate({ image: pic, seconds: 1, out: path.join(TMP, 'gen', 'c.mp4') }, () => {});
    assert(!busy.ok && busy.code === 'FRAMEPACK_BUSY', 'a second video while one runs → FRAMEPACK_BUSY');
    assert(mgr.cancel().cancelled, 'Stop → cancel sent');
    const rc = await slow;
    assert(!rc.ok && rc.code === 'FRAMEPACK_CANCELLED' && mgr.status().running && mgr.status().loaded, 'cancelled; FramePack stays loaded for the next video');
    mgr.stop();
    await until(() => !mgr.status().running, 3000);
    assert(!mgr.status().running && !mgr.status().loaded, '⏏ Unload stops the runner (frees the card)');
  }
  {
    setEnv(F.runnerEnv({ mode: 'oom' }));
    mgr = FP.createFramePack({ find: findOk });
    const pic = path.join(TMP, 'pic.png');
    const r = await mgr.generate({ image: pic, seconds: 1, steps: 5, out: path.join(TMP, 'gen', 'oom.mp4') }, () => {});
    assert(!r.ok && r.code === 'FRAMEPACK_OOM' && /ran out of memory/.test(r.message) && /GPU memory to keep free/.test(r.fix) && /shorter clip/.test(r.fix), `CUDA out of memory → FRAMEPACK_OOM: “${r.message}” / “${r.fix}”`);
    assert(mgr.status().lastError && mgr.status().lastError.code === 'FRAMEPACK_OOM', 'the last problem is kept (health watch)');
    mgr.stop();
    setEnv(F.runnerEnv({ mode: 'crash' }));
    mgr = FP.createFramePack({ find: findOk });
    const rc = await mgr.generate({ image: pic, seconds: 1, steps: 5, out: path.join(TMP, 'gen', 'crash.mp4') }, () => {});
    assert(!rc.ok && rc.code === 'FRAMEPACK_FAILED' && /stopped unexpectedly \(exit code 3\)/.test(rc.message) && /something broke inside FramePack/.test(rc.serverError || ''), `a crash → FRAMEPACK_FAILED with what it printed (${rc.message})`);
    assert(!mgr.status().running, 'after a crash nothing is left running');
    setEnv({ AUTOINJECTOR_FRAMEPACK_PYTHON: path.join(TMP, 'no-such-python'), AUTOINJECTOR_FRAMEPACK_RUNNER: F.RUNNER });
    mgr = FP.createFramePack({ find: findOk });
    const rp = await mgr.load();
    assert(!rp.ok && rp.code === 'FRAMEPACK_PYTHON_MISSING', `no python → FRAMEPACK_PYTHON_MISSING (${rp.code})`);
    setEnv(F.runnerEnv({ mode: 'noready' }));
    mgr = FP.createFramePack({ find: findOk, readyTimeoutMs: 400 });
    const rn = await mgr.load();
    assert(!rn.ok && rn.code === 'FRAMEPACK_FAILED' && /did not start in time/.test(rn.message), 'a runner that never answers → FRAMEPACK_FAILED “did not start in time”');
    mgr.stop();
  }

  // =====================================================================
  console.log('\n== 3. video-studio with FramePack ==');
  setEnv(F.runnerEnv({ log: runLog, stepMs: 25 }));
  const videos = path.join(TMP, 'videos');
  let settingsSaved = null;
  let fpDirSetting = '';
  mgr = FP.createFramePack({ find: () => FP.findFramePack({ dir: fpDirSetting, smPackages: () => [{ dir: fpDir, packageName: 'FramePack' }], modelsDir: stuffHf }), cancelKillMs: 3000 });
  const pictures = [];
  let pictureFails = false;
  const studio = VS.createVideoStudio({
    framepack: () => mgr, videosDir: () => videos, persist: (s) => { settingsSaved = s; fpDirSetting = s.framepackDir; }, comfy: async () => null,
    makePicture: async (o) => { pictures.push(o); if (pictureFails) return { ok: false, error: 'SD_NOT_CONNECTED', message: 'Stable Diffusion is not connected.', fix: 'Start it in 🎨 Images.' }; const p = path.join(TMP, `made-${pictures.length}.png`); fs.writeFileSync(p, png); return { ok: true, path: p, engine: 'sd' }; },
  });
  {
    let s = await studio.status();
    assert(s.ready && s.backend === 'framepack' && /✔ Ready: FramePack/.test(s.message) && s.framepack.found && s.framepack.ready && s.framepack.models.ok, `auto + FramePack found + no Wan → FramePack (${s.message})`);
    assert(s.framepack.dir === fpDir && s.framepack.source === 'Stability Matrix' && s.framepack.models.repos.length === 3, 'FramePack has its own block in the status (folder, where found, models)');
    const pic = path.join(TMP, 'portrait.png'); fs.writeFileSync(pic, png);
    const pend = studio.animate({ image: pic, prompt: 'she breathes and smiles', seconds: 2, steps: 6, seed: 99 }, 'test');
    const seen = await until(async () => { const p = await studio.progress(); return p.busy && p.engine === 'framepack' && p.sections === 2 && p.step > 0 ? p : null; }, 8000);
    assert(seen && seen.steps === 12 && seen.pct > 0 && seen.section >= 1, `progress while it renders: part ${seen && seen.section} of ${seen && seen.sections}, step ${seen && seen.step} of ${seen && seen.steps}`);
    const busy = await studio.animate({ image: pic }, 'test');
    assert(!busy.ok && busy.code === 'BUSY', 'one video at a time (BUSY)');
    const r = await pend;
    assert(r.ok && r.engine === 'framepack' && r.model === 'framepack-i2v-hy' && r.fps === 30 && r.seconds === 2.43 && r.frames === 73 && path.dirname(r.path) === videos && /^animate-.*\.mp4$/.test(path.basename(r.path)), `picture→video → ${path.basename(r.path || '')} in videos/`);
    assert(r.poster && fs.existsSync(r.poster) && fs.existsSync(r.json), 'with its poster and .json sidecar');
    const rec = JSON.parse(fs.readFileSync(r.json, 'utf8'));
    assert(rec.engine === 'framepack' && rec.steps === 6 && rec.teacache === true && rec.gpuMemoryPreservation === 6 && rec.distilledCfg === 10 && rec.seed === 99 && rec.framepack.sections === 2 && rec.sourceImage === pic, 'the sidecar has every FramePack setting (steps, TeaCache, GPU memory, distilled CFG, seed, parts)');
    assert(!fs.readdirSync(videos).some((n) => n.startsWith('.framepack-')), 'no temporary files are left in videos/');
    const g = studio.gallery(10);
    assert(g.items.length === 1 && g.items[0].record.engine === 'framepack' && g.items[0].posterUrl, 'the gallery lists it (poster, settings)');
    const sent = readLog(runLog).map((x) => x.cmd).filter((x) => x && x.cmd === 'generate').pop();
    assert(sent.image === pic && sent.prompt === 'she breathes and smiles' && sent.seconds === 2 && sent.steps === 6 && sent.gs === 10 && sent.cfg === 1 && sent.use_teacache === true && sent.gpu_memory_preservation === 6 && sent.mp4_crf === 16 && sent.seed === 99, 'FramePack got the demo\'s settings (CFG 1, distilled CFG 10, TeaCache, 6 GB kept free, MP4 quality 16)');
    // FramePack's own settings + clamping
    const r2 = await studio.animate({ image: pic, seconds: 14, steps: 3, teacache: false, gpuMemoryPreservation: 9, distilledCfg: 8 }, 'test');
    const sent2 = readLog(runLog).map((x) => x.cmd).filter((x) => x && x.cmd === 'generate').pop();
    assert(r2.ok && sent2.seconds === 10 && sent2.use_teacache === false && sent2.gpu_memory_preservation === 9 && sent2.gs === 8 && r2.warnings.some((w) => /1–10 seconds/.test(w.message)) && !r2.warnings.some((w) => /Wan/.test(w.message)), 'seconds 14 → 10 (said so; no Wan notes), TeaCache off, 9 GB kept free, distilled CFG 8');
    const bad = await studio.animate({ image: pic, teacache: 'yes' }, 'test');
    assert(!bad.ok && bad.code === 'INVALID_PARAM' && bad.field === 'teacache', 'a wrong FramePack setting names the field');
    // a picture as base64 (written to a temp file for FramePack, removed after)
    const r3 = await studio.animate({ image: `data:image/png;base64,${png.toString('base64')}`, seconds: 1, steps: 2 }, 'test');
    assert(r3.ok && !fs.readdirSync(videos).some((n) => n.startsWith('.framepack-')), 'a picture given as base64 works (temp file cleaned up)');
    // text → video = a picture first (🎨 Images), then animated
    const t = await studio.generate({ prompt: 'a lighthouse at night, waves', seconds: 1, steps: 2, purpose: 'trailer_shot', seed: 5 }, 'test');
    assert(t.ok && t.engine === 'framepack' && t.mode === 't2v' && pictures.length === 1 && pictures[0].prompt === 'a lighthouse at night, waves' && pictures[0].width === 896 && pictures[0].height === 512 && pictures[0].seed === 5, 'text→video with FramePack: the picture is made first from the prompt (wide, same seed)');
    assert(t.warnings.some((w) => /picture was made first with Stable Diffusion/.test(w.message)), 'and it says so');
    const trec = JSON.parse(fs.readFileSync(t.json, 'utf8'));
    assert(trec.sourcePicture === path.join(TMP, 'made-1.png') && trec.pictureEngine === 'sd' && trec.mode === 't2v', 'the sidecar keeps the picture it was made from');
    const sent3 = readLog(runLog).map((x) => x.cmd).filter((x) => x && x.cmd === 'generate').pop();
    assert(sent3.image === path.join(TMP, 'made-1.png') && sent3.prompt === 'a lighthouse at night, waves', 'FramePack animated that picture');
    pictureFails = true;
    const tf = await studio.generate({ prompt: 'a fox', seconds: 1 }, 'test');
    assert(!tf.ok && tf.code === 'FRAMEPACK_PICTURE_FAILED' && /makes a picture first/.test(tf.message) && /not connected/.test(tf.message) && /Start it/.test(tf.fix), `the first picture fails → said plainly (${tf.message})`);
    pictureFails = false;
    // Stop
    const pend2 = studio.animate({ image: pic, seconds: 5, steps: 100 }, 'test');
    await until(async () => { const p = await studio.progress(); return p.busy && p.step > 0; }, 8000);
    const cc = await studio.cancel();
    const rc = await pend2;
    assert(cc.cancelled && !rc.ok && rc.code === 'VIDEO_CANCELLED' && rc.engine === 'framepack', '⏹ Stop → VIDEO_CANCELLED');
    // Remake (the record's model) asks for FramePack again
    const rm = await studio.animate({ image: pic, model: 'framepack-i2v-hy', seconds: 1, steps: 2, seed: rec.seed }, 'test');
    assert(rm.ok && rm.engine === 'framepack' && rm.seed === 99, '♻ Remake with the record (model framepack-i2v-hy, its seed) works');
    // engine words
    const e1 = await studio.animate({ image: pic, engine: 'banana' }, 'test');
    assert(!e1.ok && e1.field === 'engine' && /framepack/.test(e1.hint), 'engine "banana" → INVALID_PARAM naming the engines');
    // settings
    let st = studio.settings({ backend: 'framepack' });
    assert(st.ok && st.settings.backend === 'framepack' && settingsSaved.backend === 'framepack', 'settings: backend framepack is saved');
    st = studio.settings({ backend: 'wan' });
    assert(st.ok && st.settings.backend === 'comfy-wan', 'backend "wan" means ComfyUI + Wan');
    assert(studio.settings({ framepackGpuMemory: 200 }).settings.framepackGpuMemory === 128, 'framepackGpuMemory is clamped to 6–128');
    st = studio.settings({ framepackDir: path.join(TMP, 'nothing-here'), backend: 'framepack' });
    s = await studio.status({ fresh: true });
    assert(st.ok && s.ready && s.framepack.chosenMissing && /chosen folder .* has no FramePack, so this one is used/.test(s.framepack.message), `a chosen folder without FramePack, but Stability Matrix has one → that one is used, and said (${s.framepack.message})`);
    {
      const lone = FP.createFramePack({ find: () => FP.findFramePack({ dir: path.join(TMP, 'nothing-here'), smPackages: () => [], modelsDir: stuffHf }) });
      const st1 = VS.createVideoStudio({ framepack: lone, videosDir: () => videos, comfy: async () => null, settings: { backend: 'framepack', framepackDir: path.join(TMP, 'nothing-here') } });
      const s1 = await st1.status();
      assert(!s1.ready && /chosen as the video engine, but it isn't ready/.test(s1.message) && /no FramePack in the chosen folder/.test(s1.message), `only a chosen folder without FramePack: not ready, said why (${s1.message})`);
      const nf = await st1.animate({ image: pic }, 'test');
      assert(!nf.ok && nf.code === 'FRAMEPACK_NOT_FOUND' && /Choose FramePack folder/.test(nf.fix), 'making a video then → FRAMEPACK_NOT_FOUND + what to press');
    }
    studio.settings({ framepackDir: fpDir, backend: 'auto', framepackGpuMemory: 8 });
    // the 2-second test from a test picture
    const tst = await studio.framepack.test();
    const sentT = readLog(runLog).map((x) => x.cmd).filter((x) => x && x.cmd === 'generate').pop();
    assert(tst.ok && tst.engine === 'framepack' && /^test-/.test(path.basename(tst.path)) && sentT.seconds === 2 && sentT.gpu_memory_preservation === 8 && VS.imageSize(fs.readFileSync(sentT.image)).width === 640, '🧪 Test: a 2-second clip from the built-in test picture (the saved GPU memory setting is used)');
    const tt = await studio.test();
    assert(tt.ok && tt.engine === 'framepack', 'the general 🧪 test uses FramePack when it is the engine');
    const fs1 = await studio.framepack.status({});
    assert(fs1.ok && fs1.ready && fs1.loaded && fs1.running && fs1.models.repos.length === 3, 'video.framepack.status: ready, loaded, the three models');
    const un = await studio.framepack.unload();
    assert(un.ok && /graphics memory is free/.test(un.message), '⏏ Unload');
    await until(() => !mgr.status().running, 3000);
    const ld = await studio.framepack.load();
    assert(ld.ok && /FramePack is loaded/.test(ld.message), '▶ Load FramePack (warm-up)');
    // OOM through the studio
    mgr.stop(); await until(() => !mgr.status().running, 3000);
    setEnv(F.runnerEnv({ mode: 'oom', log: runLog }));
    const oom = await studio.animate({ image: pic, seconds: 1, steps: 5 }, 'test');
    assert(!oom.ok && oom.code === 'FRAMEPACK_OOM' && oom.engine === 'framepack' && /ran out of memory/.test(oom.message) && /GPU memory to keep free/.test(oom.fix), 'out of graphics memory → FRAMEPACK_OOM with the fix');
    mgr.stop(); await until(() => !mgr.status().running, 3000);
    setEnv(F.runnerEnv({ log: runLog }));
    // models missing → FRAMEPACK_MODEL_MISSING with the list (via the studio)
    const mgrMiss = FP.createFramePack({ find: () => FP.findFramePack({ dir: fpDir, smPackages: () => [], modelsDir: partialOnly() }) });
    function partialOnly() { const p = path.join(TMP, 'partial-only'); if (!fs.existsSync(p)) F.makeHfCache(p, { skip: ['lllyasviel/FramePackI2V_HY'] }); return p; }
    const studioMiss = VS.createVideoStudio({ framepack: mgrMiss, videosDir: () => videos, comfy: async () => null, settings: { backend: 'framepack' } });
    const mm = await studioMiss.animate({ image: pic }, 'test');
    const sm = await studioMiss.status();
    // FramePack's own hf_download is complete, so it is used instead of the partial "stuff and thing" copy
    assert(mm.ok && sm.framepack.hfSource.includes('hf_download'), 'a partial "stuff and thing" copy → FramePack\'s complete hf_download is used');
    fs.rmSync(path.join(fpDir, 'hf_download'), { recursive: true, force: true });
    mgrMiss.stop(); mgrMiss.refresh();
    const mm2 = await studioMiss.animate({ image: pic }, 'test');
    assert(!mm2.ok && mm2.code === 'FRAMEPACK_MODEL_MISSING' && mm2.missing.length === 1 && /FramePackI2V_HY/.test(mm2.message), `a missing model → FRAMEPACK_MODEL_MISSING (${mm2.message})`);
    const sm2 = await studioMiss.status({ fresh: true });
    assert(!sm2.ready && /isn't ready/.test(sm2.message) && sm2.framepack.models.missing.length === 1, 'and status says it is not ready, with the list');
    F.makeHfCache(path.join(fpDir, 'hf_download'));
  }
  {
    // auto with Wan installed and ready → Wan; engine framepack still picks FramePack
    const comfy = await fakeComfy({ videoPolls: 1 });
    const studio2 = VS.createVideoStudio({ framepack: () => mgr, videosDir: () => videos, comfy: async () => ({ base: comfy.base, label: 'ComfyUI', source: 'test' }), pollMs: 20, noWs: true,
      installer: () => ({ check: (listed) => ({ ok: true, installed: listed && listed.diffusion_models && listed.diffusion_models.length ? ['wan22-ti2v-5b', 'wan21-t2v-1.3b'] : [], models: [], anyComfy: true, roots: [] }), status: () => ({}) }) });
    const s = await studio2.status({ fresh: true });
    assert(s.backend === 'comfy-wan' && s.framepack.ready, 'auto: Wan installed and ComfyUI ready → ComfyUI + Wan (FramePack stays available)');
    const pic = path.join(TMP, 'portrait.png');
    const g0 = comfy.state.videoGraphs.length;
    const rw = await studio2.animate({ image: pic, seconds: 1 }, 'test');
    assert(rw.ok && rw.engine === 'comfy-wan' && comfy.state.videoGraphs.length === g0 + 1, 'auto → the clip is made by Wan');
    const rf = await studio2.animate({ image: pic, seconds: 1, steps: 2, engine: 'framepack' }, 'test');
    assert(rf.ok && rf.engine === 'framepack' && comfy.state.videoGraphs.length === g0 + 1, 'engine "framepack" → FramePack even when Wan is ready');
    assert(await studio2.engineFor() === 'comfy-wan', 'engineFor() → the engine auto would use (comfy-wan)');
    await comfy.close();
    const studio3 = VS.createVideoStudio({ framepack: () => mgr, videosDir: () => videos, comfy: async () => null, installer: () => ({ check: () => ({ ok: true, installed: ['wan22-ti2v-5b'], models: [], anyComfy: true, roots: [{ source: 'test' }] }), status: () => ({}) }) });
    const s3 = await studio3.status();
    assert(!s3.ready && s3.backend === '' && /not running/.test(s3.message), 'auto: Wan installed but ComfyUI not running → not FramePack (ComfyUI is started for a video)');
    const r3 = await studio3.animate({ image: pic, seconds: 1, steps: 2 }, 'test');
    assert(r3.ok && r3.engine === 'framepack', '…and when ComfyUI can\'t be started, FramePack makes the video instead');
  }

  // =====================================================================
  console.log('\n== 4. video-api ==');
  {
    const api = VA.createVideoApi({ studio });
    const cap = await api.capabilities();
    const anim = cap.operations.find((o) => o.name === 'video.animate');
    assert(cap.ready && cap.backend === 'framepack' && anim.available && cap.framepack && cap.framepack.ready && cap.errors.includes('FRAMEPACK_OOM') && cap.errors.includes('FRAMEPACK_MODEL_MISSING'), 'capabilities: FramePack ready → picture→video available; FRAMEPACK_* errors listed');
    assert(['video.framepack.status', 'video.framepack.load', 'video.framepack.unload', 'video.framepack.test'].every((n) => cap.operations.some((o) => o.name === n)), 'video.framepack.status / load / unload / test are operations');
    const gp = cap.operations.find((o) => o.name === 'video.generate').params.properties;
    assert(gp.engine && gp.engine.enum.includes('framepack') && gp.teacache && gp.gpuMemoryPreservation && gp.backend.enum.includes('framepack'), 'video.generate takes engine / teacache / gpuMemoryPreservation');
    const st = await api.call('video.framepack.status', {});
    assert(st.ok && st.found && st.ready, 'call video.framepack.status');
    const r = await api.call('video.animate', { image: path.join(TMP, 'portrait.png'), seconds: 1, steps: 2, engine: 'framepack', teacache: true });
    assert(r.ok && r.engine === 'framepack', 'call video.animate with engine framepack');
    const bad = await api.call('video.generate', { prompt: 'x', engine: 'framepak' });
    assert(!bad.ok && bad.code === 'INVALID_PARAM' && /engine/.test(bad.field || bad.message), 'an unknown engine is refused');
  }

  // =====================================================================
  console.log('\n== 5. trailers with FramePack shots ==');
  {
    const shot = { prompt: 'waves', seconds: 4 };
    assert(VT.shotKey(shot, undefined) === VT.shotKey(shot, undefined, 'comfy-wan') && VT.shotKey(shot, undefined, 'framepack') !== VT.shotKey(shot, undefined, 'comfy-wan'), 'the shot key includes the engine (FramePack shots are not reused for Wan, Wan keys unchanged)');
    const recorded = [];
    const trailer = VT.createTrailerMaker({
      studio, trailersDir: () => path.join(TMP, 'trailers'), fileUrl: (p) => p, waitMs: 20,
      record: (plan, out) => ({ done: (async () => { recorded.push(plan); fs.writeFileSync(out, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])); return { ok: true, path: out, seconds: plan.total, bytes: 8, tracks: [] }; })(), stop: () => {} }),
      ffmpeg: () => null,
    });
    const pic = path.join(TMP, 'portrait.png');
    const n0 = pictures.length;
    const m = await trailer.make({ book: 'Sea Book', items: [{ type: 'card', text: 'Sea Book', seconds: 1 }, { type: 'shot', prompt: 'waves crash on rocks', seconds: 2 }, { type: 'shot', image: pic, prompt: 'she looks at the sea', seconds: 2 }], engine: 'framepack', mp4: false, wait: true });
    assert(m.ok && recorded.length === 1, `the trailer is made (${m.message || m.error || ''})`);
    const stj = JSON.parse(fs.readFileSync(path.join(TMP, 'trailers', 'Sea Book', 'trailer.json'), 'utf8'));
    const cached = Object.values(stj.shots || {});
    assert(cached.length === 2 && cached.every((c) => c.engine === 'framepack' && c.model === 'framepack-i2v-hy'), 'both shots were made by FramePack');
    assert(pictures.length === n0 + 1 && pictures[n0].prompt === 'waves crash on rocks', 'the text shot got its picture made first; the picture shot was animated directly');
    assert(stj.plan && stj.plan.engine === 'framepack', 'the plan remembers the engine');
    const again = await trailer.make({ book: 'Sea Book', items: [{ type: 'card', text: 'Sea Book', seconds: 1 }, { type: 'shot', prompt: 'waves crash on rocks', seconds: 2 }, { type: 'shot', image: pic, prompt: 'she looks at the sea', seconds: 2 }], engine: 'framepack', mp4: false, wait: true });
    assert(again.ok && pictures.length === n0 + 1 && again.reused === 2, 'made again → the FramePack shots are reused');
    const bad = await trailer.make({ book: 'Sea Book', items: [{ type: 'shot', prompt: 'x', seconds: 2 }], engine: 'sora', wait: true });
    assert(!bad.ok && bad.field === 'engine', 'an unknown trailer engine is refused');
  }

  // =====================================================================
  console.log('\n== 6. health watch: the FramePack row ==');
  {
    let fpInfo = { setUp: true, found: true, ready: true, dir: fpDir, pythonOk: true, missing: [], loaded: false, lastError: null };
    const told = [];
    const hw = HW.createHealthWatch({ noTimers: true, framepack: () => fpInfo, notify: (x) => told.push(x) });
    let st = await hw.runOnce({ only: ['framepack'] });
    assert(st.problems.length === 0 && st.info.some((r) => r.check === 'framepack' && r.ok && /FramePack: ✔ ready/.test(r.text)), 'set up and fine → a ✔ FramePack row for 🩺 Check everything');
    fpInfo = Object.assign({}, fpInfo, { ready: false, missing: ['lllyasviel/FramePackI2V_HY'] });
    st = await hw.runOnce({ only: ['framepack'] });
    assert(st.problems.some((p) => p.code === 'framepack-models' && /missing 1 model part/.test(p.text) && p.fix) && st.info.some((r) => r.check === 'framepack' && !r.ok), 'a model gone → a problem in plain words, with “Open 🎬 Video → Setup”');
    fpInfo = Object.assign({}, fpInfo, { found: false });
    st = await hw.runOnce({ only: ['framepack'] });
    assert(st.problems.some((p) => p.code === 'framepack-gone'), 'the folder gone → framepack-gone');
    fpInfo = { setUp: true, found: true, ready: true, pythonOk: true, missing: [], lastError: { code: 'FRAMEPACK_OOM', message: 'Your graphics card ran out of memory making this video.', at: Date.now() } };
    st = await hw.runOnce({ only: ['framepack'] });
    assert(st.problems.some((p) => p.code === 'framepack-stopped' && /GPU memory to keep free/.test(p.text)), 'it ran out of memory last time → said, with the fix');
    fpInfo = { setUp: false };
    st = await hw.runOnce({ only: ['framepack'] });
    assert(!st.problems.length && !st.info.length, 'not set up → no row, no problem');
  }

  try { mgr.stop(); } catch (_) {}
  setEnv({});
  for (const k of Object.keys(process.env)) if (!(k in ENV0)) delete process.env[k];
  await sleep(200);
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
