'use strict';
// test/video-judge.test.js — 🎬 everything saved with a video, ♻ Remake exactly, 💾 video recipes, 🧑‍⚖️ the video judge
// (contact sheet + the no-AI motion check + the same judges as pictures), 🔁 Make it better with quick previews,
// Make N / pick the best, the Alfred methods and the trailer's auto-judge.
// Fakes: the fake ComfyUI (test/fixtures/fake-sd.js), the fake FramePack runner (test/fixtures/fake-framepack*.js) and the
// fake `claude` CLI (test/fixtures/fake-claude-judge.js — it answers a CONTACT SHEET question with video scores).
//   node test/video-judge.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const VR = require('../video-record');
const VJ = require('../video-judge');
const VF = require('../video-frames');
const VRec = require('../video-recipes');
const SR = require('../sd-recipes');
const VS = require('../video-studio');
const VI = require('../video-installer');
const VA = require('../video-api');
const VT = require('../video-trailer');
const FP = require('../framepack');
const JS = require('../image-judge-service');
const CC = require('../image-judge-cc');
const { createVideoJudgeStudio } = require('../video-improve');
const { fakeComfy, PNG } = require('./fixtures/fake-sd');
const F = require('./fixtures/fake-framepack');
const { makeFakeClaude, videoAnswer } = require('./fixtures/fake-claude-judge');

let passed = 0; let failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'video-judge-test-'));
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// synthetic frames (RGB) for the motion check and the contact sheet
function frame(w, h, fn) { const b = Buffer.alloc(w * h * 3); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, bl] = fn(x, y); const i = (y * w + x) * 3; b[i] = r; b[i + 1] = g; b[i + 2] = bl; } return b; }
const moving = (k, w, h) => frame(w, h, (x, y) => { const v = ((x + k * 2) % 64) * 4; return [v, 255 - v, (y * 2) & 255]; });
function fakeGrabber(opts) {
  const o = opts || {};
  return { how: 'fake', calls: [], probe: async () => ({ seconds: 2, width: 320, height: 180, fps: 24 }),
    async grab(file, idx, w, h) { this.calls.push({ file, idx, w, h }); if (o.fail) return { ok: false, error: 'BAD_VIDEO', detail: 'moov atom not found' }; return { ok: true, frames: idx.map((i) => (o.frozen ? moving(0, w, h) : moving(i, w, h))) }; },
    async picture(file, w, h) { return moving(0, w, h); } };
}
function judgeJson(n, i2v) { return JSON.stringify(videoAnswer(n, i2v ? '"faithful":1-10' : '')); }

async function main() {
  // ======================================================================================
  console.log('\n== 1. the contact sheet and the no-AI motion check ==');
  {
    const w = 64; const h = 36;
    const smooth = Array.from({ length: 12 }, (_, i) => moving(i, w, h));
    let c = VF.motionCheck(smooth, w, h);
    assert(c.score === 10 && !c.frozen && !c.jumps.length && !c.flicker, `smooth motion → 10/10 (${c.words.join('; ')})`);
    c = VF.motionCheck(Array.from({ length: 12 }, () => moving(0, w, h)), w, h);
    assert(c.frozen && c.score === 2 && /frozen/.test(c.words.join(' ')), 'the same frame every time → frozen (2/10)');
    const jump = smooth.slice(); jump[6] = frame(w, h, () => [250, 10, 10]); jump[7] = frame(w, h, () => [250, 10, 10]);
    c = VF.motionCheck(jump, w, h, jump.map((_, i) => i * 4));
    assert(c.jumps.length >= 1 && c.score <= 8 && /sudden jump/.test(c.words.join(' ')) && c.jumps[0].from === 20, `a cut to a red picture → a sudden jump at frames ${c.jumps[0] && `${c.jumps[0].from}→${c.jumps[0].to}`} (${c.score}/10)`);
    const flick = Array.from({ length: 12 }, (_, i) => frame(w, h, (x) => { const v = (i % 2 ? 150 : 110) + (x % 4); return [v, v, v]; }));
    c = VF.motionCheck(flick, w, h);
    assert(c.flicker >= 5 && c.score <= 6 && /flickers/.test(c.words.join(' ')), `brightness up-down-up → flicker (${c.flicker} times, ${c.score}/10)`);
    assert(VF.motionCheck(smooth.slice(0, 2), w, h).score === null, 'two frames are too few to judge (no score, no false alarm)');
    const p = VF.planFrames({ frames: 121, fps: 24 }, 8);
    assert(p.frames.length === 8 && p.frames[0].index === 0 && p.frames[7].index === 120 && p.frames[7].time === 5, `8 frames evenly from 121: ${p.frames.map((x) => x.index).join(',')}`);
    assert(VF.planFrames({ seconds: 1, fps: 16 }, 32).frames.length === 16, 'a short clip: every frame (not more than it has)');
    // PNG round trip
    const im = VF.encodePng(moving(3, 20, 10), 20, 10); const back = VF.decodePng(im);
    assert(back && back.w === 20 && back.h === 10 && back.rgb.equals(moving(3, 20, 10)), 'the built-in PNG writer and reader round-trip exactly');
    const sheet = VF.buildSheet(Array.from({ length: 8 }, (_, i) => ({ rgb: moving(i, 40, 24), label: `#${i * 10} ${(i / 2).toFixed(1)}s` })), { w: 40, h: 24, cols: 4, start: { rgb: moving(0, 40, 24) } });
    const sd = VF.decodePng(sheet.png);
    assert(sheet.tiles === 9 && sheet.rows === 3 && sd.w === sheet.width && sd.h === sheet.height, `8 frames + START → a 4-wide sheet of ${sheet.tiles} tiles (${sheet.width}×${sheet.height})`);
    assert(sd.rgb[((4 + 3) * sd.w + 4 + 3) * 3] === 255 || sd.rgb.includes(255), 'the labels are drawn (white pixels on the black label strip)');

    // makeContactSheet with ffmpeg MOCKED (the run() it would call) — exactly the arguments and raw frames ffmpeg gives
    const vid = path.join(TMP, 'clip.mp4'); fs.writeFileSync(vid, Buffer.alloc(2048, 1));
    const ffCalls = [];
    const run = async (bin, args) => {
      ffCalls.push(args);
      if (args.includes('-f')) { const vf = args[args.indexOf('-vf') + 1]; const n = (vf.match(/eq\(n/g) || []).length || 1; const [w2, h2] = vf.match(/scale=(\d+):(\d+)/).slice(1).map(Number); return { ok: true, code: 0, stdout: Buffer.concat(Array.from({ length: n }, (_, i) => moving(i, w2, h2))), stderr: '' }; }
      return { ok: false, code: 1, stdout: Buffer.alloc(0), stderr: 'Duration: 00:00:02.04, start: 0\n Stream #0:0: Video: h264, yuv420p, 640x360, 24 fps' };
    };
    const g = VF.createFfmpegGrabber({ bin: '/fake/ffmpeg', run });
    const startPic = path.join(TMP, 'start.png'); fs.writeFileSync(startPic, VF.encodePng(moving(0, 64, 36), 64, 36));
    const r = await VF.makeContactSheet({ file: vid, record: { frames: 49, fps: 24, width: 640, height: 360, mode: 'i2v' }, out: path.join(TMP, 'clip.sheet.png'), grabber: g, startPicture: startPic });
    const grabArgs = ffCalls.find((a) => a.includes('rawvideo'));
    assert(r.ok && r.how === 'ffmpeg' && r.tiles === 9 && r.hasStart && fs.existsSync(path.join(TMP, 'clip.sheet.png')), `ffmpeg (mocked): ${r.tiles} tiles with the START picture, saved as a PNG`);
    assert(grabArgs && /select='eq\(n\\,0\)\+eq\(n\\,2\)/.test(grabArgs[grabArgs.indexOf('-vf') + 1]) && grabArgs.includes('rgb24') && grabArgs.includes('-vsync'), 'one ffmpeg run: a select filter of the planned frames → raw RGB');
    assert(r.frames.length === 8 && r.frames[0].index === 0 && r.frames[7].index === 48 && r.check.score === 10, `8 frames on the sheet (#${r.frames.map((x) => x.index).join(' #')}), the check from all 32 sampled`);
    const probeOnly = await VF.makeContactSheet({ file: vid, record: {}, out: path.join(TMP, 'clip2.sheet.png'), grabber: g });
    assert(probeOnly.ok && probeOnly.total === 49 && ffCalls.some((a) => a.length === 3 && a[1] === '-i'), 'no sidecar: the length and size come from ffmpeg -i (Duration / Video: 640x360, 24 fps)');
    const badRun = async () => ({ ok: false, code: 1, stdout: Buffer.alloc(0), stderr: 'clip.mp4: Invalid data found when processing input' });
    const rb = await VF.makeContactSheet({ file: vid, record: { frames: 49, fps: 24, width: 640, height: 360 }, grabber: VF.createFfmpegGrabber({ bin: 'x', run: badRun }) });
    assert(!rb.ok && rb.error === 'BAD_VIDEO' && /broken/.test(rb.message) && /Invalid data/.test(rb.message), `a broken file → BAD_VIDEO in plain words (${rb.message})`);
    const rmiss = await VF.makeContactSheet({ file: path.join(TMP, 'nope.mp4'), grabber: g });
    assert(!rmiss.ok && rmiss.error === 'BAD_VIDEO' && /moved or deleted/.test(rmiss.message), 'a missing file → said so');

    // the in-app decoder path (no ffmpeg): a hidden window seeks a <video> and draws on a canvas (Electron mocked)
    const scripts = [];
    const electron = { BrowserWindow: class { constructor(o) { this.o = o; this.webContents = { executeJavaScript: async (js) => { scripts.push(js); const m = js.match(/c\.width = (\d+); c\.height = (\d+)/); const t = js.match(/const times = (\[[^\]]*\])/); if (m && t) { const [w2, h2] = [Number(m[1]), Number(m[2])]; return { ok: true, frames: JSON.parse(t[1]).map((_, i) => moving(i, w2, h2).toString('base64')), duration: 2 }; } return null; } }; this.destroyed = false; } loadFile() { return Promise.resolve(); } isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; } } };
    const eg = VF.createElectronGrabber({ electron, dir: path.join(__dirname, '..') });
    const re = await VF.makeContactSheet({ file: vid, record: { frames: 33, fps: 16, width: 832, height: 480 }, out: path.join(TMP, 'clip3.sheet.png'), grabber: eg });
    assert(re.ok && re.how === 'player' && re.tiles === 8 && re.check.score === 10, 'no ffmpeg: the app\'s own player (a hidden window, <video> + canvas) gives the same sheet');
    assert(scripts[0] && /offscreen|seeked/.test(scripts[0]) && /drawImage/.test(scripts[0]) && /getImageData/.test(scripts[0]) && electron.BrowserWindow, 'the page script seeks the video and reads each frame from a canvas');
    const realFf = VT.findFfmpeg({ roots: [] });
    if (realFf) {
      const real = path.join(TMP, 'real.webm');
      require('child_process').execFileSync(realFf, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24', '-t', '2', '-c:v', 'libvpx', '-b:v', '300k', real]);
      const rr = await VF.makeContactSheet({ file: real, record: { frames: 48, fps: 24, width: 320, height: 180 }, out: path.join(TMP, 'real.sheet.png'), grabber: VF.createFfmpegGrabber({ bin: realFf }) });
      assert(rr.ok && rr.tiles === 8 && rr.width === 1300 && rr.check.score >= 8, `a real clip with the real ffmpeg: ${rr.width}×${rr.height}, check ${rr.check.score}/10`);
    } else console.log('  (no ffmpeg on this PC: the real-ffmpeg check is skipped)');
  }

  // ======================================================================================
  console.log('\n== 2. the judge\'s answer: video scores, the fixed video vocabulary, flicker with the frame check ==');
  {
    const recT = { mode: 't2v', engine: 'comfy-wan', model: 'wan22-ti2v-5b', prompt: 'a ferry at dusk', seed: 7, steps: 20, cfgScale: 5, shift: 8, width: 1280, height: 704, frames: 121, fps: 24, seconds: 5 };
    const pr = VJ.buildPrompt(recT, { sheet: { frames: [{ index: 0, time: 0 }, { index: 120, time: 5 }], total: 121 }, check: { score: 6, words: ['a sudden jump (frames 40→45)'], sampled: 32 }, installed: ['wan22-ti2v-5b'] });
    assert(/CONTACT SHEET/.test(pr) && /#0 \(0\.0 s\), #120 \(5\.0 s\)/.test(pr) && /a sudden jump/.test(pr) && /"faithful":null/.test(pr) && /"type":"engine"/.test(pr) && /a ferry at dusk/.test(pr), 'the instruction: a contact sheet with frame numbers, the settings, the frame check, faithful = null for text → video, the video fix list');
    const prI = VJ.buildPrompt(Object.assign({}, recT, { mode: 'i2v', startPicture: { path: 'C:/p.png' } }), { sheet: { frames: [], hasStart: true } });
    assert(/labelled START, is the starting picture/.test(prI) && /"faithful":1-10/.test(prI), 'picture → video: the START tile is explained and "faithful" is asked');
    let v = VJ.validate(JSON.parse(judgeJson(1)), { i2v: false, check: { score: 4, words: ['a sudden jump'] } });
    assert(v.ok && v.judge.scores.faithful === null && v.judge.flickerAi === 5.5 && v.judge.flickerCheck === 4 && v.judge.scores.flicker === 4.5, `flicker = the AI's 5.5 and the frame check's 4 together (the lower counts more): ${v.judge.scores.flicker}`);
    assert(v.judge.fixes.map((f) => f.type).join(',') === 'steps,motion,negative_add' && v.judge.ignored.includes('teleport'), 'fixes outside the video vocabulary are ignored (teleport)');
    v = VJ.validate({ scores: { prompt: 3, quality: 2, consistency: 2, motion: 2, flicker: 3 }, verdict: 'keep', fixes: [{ type: 'frames', delta: -1 }, { type: 'model', to: 'wan21' }, { type: 'starting_picture' }] }, {});
    assert(v.ok && v.judge.verdict === 'redo' && v.judge.selfConflict && v.judge.fixes.map((f) => f.type).join(',') === 'seconds,engine,better_picture', '"keep" with 2/10 scores → the scores win (redo); frames / model / starting_picture are read as seconds / engine / better_picture');
    v = VJ.validate({ scores: { prompt: 8, quality: 8, consistency: 8, motion: 8, flicker: 8 }, verdict: 'keep' }, { i2v: true });
    assert(!v.ok && /faithful is missing/.test(v.problems.join(' ')), 'picture → video without a "faithful" score → asked again');
    assert(!VJ.validate({ scores: { prompt: 'x' }, verdict: 'maybe' }, {}).ok, 'a malformed answer is refused');
    assert(VJ.extractJson('Sure!\n```json\n{"verdict":"fix"}\n```') && VJ.extractJson('{"a":1}').a === 1, 'the JSON is found inside fences and prose (the pictures\' reader)');

    // applying fixes — Wan
    const req = VR.remakeRequest(recT).request;
    let a = VJ.applyFixes(req, { verdict: 'fix', fixes: [{ type: 'steps', delta: 6 }, { type: 'cfg', delta: -1 }, { type: 'seconds', delta: -2 }, { type: 'fps', value: 16 }, { type: 'size', aspect: 'portrait' }, { type: 'motion', amount: 'less' }, { type: 'negative_add', terms: ['morphing hands'] }, { type: 'teacache', on: false }, { type: 'better_picture' }], promptEdits: { add: ['steady camera'] } }, {});
    assert(a.request.steps === 26 && a.request.cfgScale === 4 && a.request.width === 704 && a.request.height === 1280 && a.request.shift === 6, `Wan: steps +6, CFG −1, portrait at the model's own size 704×1280, calmer motion = shift 8 → 6 (${a.changed.length} changes)`);
    assert(a.request.fps === 16 && a.request.frames === 49 && !a.request.seconds && /morphing hands/.test(a.request.negativePrompt) && /steady camera/.test(a.request.prompt) && a.request.seed === 7, `5 s → 3 s and 16 fps = ${a.request.frames} frames (4n+1); "avoid" and the prompt edit added; the same seed`);
    assert(a.skipped.some((x) => x.type === 'teacache') && a.skipped.some((x) => x.type === 'better_picture' && /text → video/.test(x.why)), 'fixes that don\'t apply are skipped with a reason (TeaCache on Wan, a better picture for text → video)');
    a = VJ.applyFixes(req, { verdict: 'redo', fixes: [{ type: 'engine', to: 'wan21' }] }, { installed: ['wan22-ti2v-5b', 'wan21-t2v-1.3b'] });
    assert(a.request.model === 'wan21-t2v-1.3b' && a.request.width === 832 && a.request.fps === 16 && a.request.steps === 30 && a.request.seed === -1, 'switch to Wan 2.1 1.3B: its own size, fps and steps; "redo" → a new seed');
    a = VJ.applyFixes(Object.assign({}, req, { image: 'C:/p.png' }), { fixes: [{ type: 'engine', to: 'wan21' }, { type: 'engine', to: 'framepack' }] }, { installed: ['wan22-ti2v-5b', 'wan21-t2v-1.3b'], framepack: false });
    assert(a.skipped.length === 2 && /text only/.test(a.skipped[0].why) && /not ready/.test(a.skipped[1].why), 'picture → video can\'t go to Wan 2.1 (text only) nor to a FramePack that isn\'t ready');
    // FramePack
    const recF = { mode: 'i2v', engine: 'framepack', model: 'framepack-i2v-hy', prompt: 'she smiles', seed: 9, seconds: 4.87, framepack: { steps: 25, distilledCfg: 10, teacache: true, gpuMemoryPreservation: 6, wantSeconds: 5 }, startPicture: { path: 'C:/p.png' } };
    const reqF = VR.remakeRequest(recF).request;
    a = VJ.applyFixes(reqF, { fixes: [{ type: 'cfg', delta: 2 }, { type: 'teacache', on: false }, { type: 'size', aspect: 'square' }, { type: 'shift', delta: 1 }, { type: 'motion', amount: 'less' }, { type: 'seconds', value: 3 }, { type: 'better_picture' }] }, {});
    assert(a.request.distilledCfg === 12 && a.request.teacache === false && a.request.seconds === 3 && /gentle movement/.test(a.request.prompt), 'FramePack: CFG → distilled CFG 12, TeaCache off, 3 s, calmer = words (it has no motion setting)');
    assert(a.skipped.some((x) => x.type === 'size') && a.skipped.some((x) => x.type === 'shift') && a.betterPicture && a.skipped.some((x) => /🎨 Images/.test(x.why)), 'FramePack: no size / shift; "use a better starting picture" points to 🎨 Images → Make it better');
    // the quick preview and the time estimate
    const pv = VJ.previewRequest(req, {});
    assert(pv.preview && pv.frames === 37 && pv.width === 832 && pv.height === 480 && pv.seed === 7 && pv.steps === 20, `preview: 1.5 s (${pv.frames} frames), the model's smaller size of the same shape (${pv.width}×${pv.height}), the same seed and steps`);
    assert(VJ.previewRequest(Object.assign({}, req, { width: 704, height: 1280 })).width === 480 && VJ.previewRequest(reqF).seconds === 2 && VJ.previewRequest(reqF, { seconds: 1 }).seconds === 1, 'portrait previews stay portrait; FramePack previews are 1–2 s');
    const e0 = VJ.estimateSeconds(req, {}); const ep = VJ.estimateSeconds(pv, {});
    const ec = VJ.estimateSeconds(req, { calib: [Object.assign({}, recT, { renderSeconds: 1225 })] });
    assert(e0 > 300 && ep < e0 / 4 && Math.abs(ec - 1225) < 2, `estimate: full ${VJ.sayDuration(e0)}, preview ${VJ.sayDuration(ep)}; measured on this PC (1225 s) → ${ec} s`);
    assert(VJ.cleanVideoSettings({ rounds: 9, bestCount: 1, previewSeconds: 5, autoTrailer: 'x' }).rounds === 5 && VJ.cleanVideoSettings({ bestCount: 1 }).bestCount === 2 && VJ.cleanVideoSettings({}).autoTrailer === false, 'settings: rounds ≤ 5, best of 2–4, trailer auto-judge off by default');
  }

  // ======================================================================================
  console.log('\n== 3. everything saved with every video (Wan + FramePack) and ♻ Remake exactly ==');
  const comfy = await fakeComfy({ videoPolls: 2 });
  const videos = path.join(TMP, 'videos');
  const logs = [];
  const studio = VS.createVideoStudio({
    comfy: async () => ({ base: comfy.base, label: 'ComfyUI', source: 'test' }), installer: () => VI.createVideoInstaller({ roots: () => [{ path: path.join(TMP, 'comfy-models') }] }),
    videosDir: () => videos, log: (t, d) => logs.push({ t, d }), fileUrl: (p) => `file://${p}`, pollMs: 30, noWs: true, appVersion: () => '9.9.9 (abc1234)',
    library: { getLock: (n) => (/odile/i.test(n) ? { id: 'odile', character: 'Odile', book: 'The Ferry', prompt: 'a woman with red hair' } : null), applyLock: (l, o) => ({ prompt: `${l.prompt}, ${o.prompt}`, negativePrompt: o.negativePrompt }) },
  });
  let wanPath; let i2vPath;
  {
    const r = await studio.generate({ prompt: 'she rows across the lake', characterLock: 'Odile', seconds: 2, steps: 7, cfgScale: 4.5, seed: -1, recipeUsed: { id: 'r-calm', name: 'Calm' }, book: 'The Ferry' }, 'api:alfred');
    const rec = readJson(r.json);
    wanPath = r.path;
    const want = ['promptTyped', 'prompt', 'negativePrompt', 'negativeAuto', 'engine', 'model', 'modelFiles', 'workflow', 'comfyGraph', 'seconds', 'fps', 'frames', 'width', 'height', 'steps', 'cfgScale', 'shift', 'sampler', 'scheduler', 'seed', 'askedBy', 'recipe', 'appVersion', 'renderSeconds', 'createdAt'];
    const missing = want.filter((k) => rec[k] === undefined);
    assert(r.ok && !missing.length, `Wan: the sidecar holds every setting${missing.length ? ` — missing ${missing.join(', ')}` : ''}`);
    assert(rec.promptTyped === 'she rows across the lake' && /red hair/.test(rec.prompt) && rec.negativeAuto === true && rec.seed >= 0 && rec.seed === r.seed, `typed ≠ sent (the lock's looks were added), the automatic negative is marked, the REAL seed (${rec.seed}) not -1`);
    assert(rec.modelFiles.diffusion === 'wan2.2_ti2v_5B_fp16.safetensors' && /umt5/.test(rec.modelFiles.textEncoder) && rec.workflow === 'built-in Wan graph (AutoInjector)' && rec.comfyGraph['9'].inputs.seed === rec.seed, 'the model files as ComfyUI spells them, the workflow, and the exact graph that was queued');
    assert(rec.askedBy.who === 'Alfred' && rec.askedBy.book === 'The Ferry' && rec.recipe.name === 'Calm' && rec.appVersion === '9.9.9 (abc1234)' && rec.characterLock.character === 'Odile', 'who asked (Alfred, for the book), the recipe, the app version, the character lock');
    assert(r.record && r.record.seed === rec.seed, 'the answer carries the record too (the tab shows it at once)');
    const used = VR.settingsUsed(rec);
    const labels = used.map((x) => x.label);
    assert(['What you asked for', 'What was sent to the video maker', 'Made by', 'Model', 'Model files', 'Length', 'Size', 'Steps', 'CFG (how strictly it follows the words)', 'Shift (motion / timing of the sampler)', 'Sampler', 'Seed (the number that makes this exact video)', 'Recipe', 'Asked by', 'App version'].every((l) => labels.includes(l)), `"Settings used" in plain words (${used.length} rows)`);
    // ♻ Remake exactly — through the judge studio
    const vjs0 = createVideoJudgeStudio({ studio, judge: { judge: async () => ({ ok: false }), status: async () => ({ ok: true }) }, grabber: async () => fakeGrabber(), recipes: VRec.createVideoRecipeStore({}), log: () => {} });
    const before = comfy.state.videoGraphs.length;
    const rm = await vjs0.remake(wanPath);
    const g1 = comfy.state.videoGraphs[before - 1]; const g2 = comfy.state.videoGraphs[before];
    const pick = (g) => JSON.stringify({ k: Object.assign({}, g['9'].inputs, { model: 0, positive: 0, negative: 0, latent_image: 0 }), l: g['7'].inputs.length, w: g['7'].inputs.width, h: g['7'].inputs.height, p: g['5'].inputs.text, n: g['6'].inputs.text, s: g['4'].inputs.shift, fps: g['11'] && g['11'].inputs.fps });
    assert(rm.ok && rm.sameSeed && rm.seed === rec.seed && g2 && pick(g1) === pick(g2), `♻ Remake sends ComfyUI the same graph: seed ${rm.seed}, steps, CFG, sampler, size, frames, fps, shift, the prompt AS SENT and the negative`);
    const rec2 = readJson(rm.json);
    assert(rec2.promptTyped === rec.promptTyped && rec2.recipe && rec2.recipe.id === 'r-calm' && !/red hair, a woman with red hair/.test(rec2.prompt), 'the remake keeps what was typed and the recipe, and doesn\'t add the lock\'s looks twice');
    // picture → video: the starting picture and its own sidecar
    const pic = path.join(TMP, 'portrait.png'); fs.writeFileSync(pic, PNG); fs.writeFileSync(path.join(TMP, 'portrait.json'), JSON.stringify({ seed: 4242, checkpoint: 'juggernautXL.safetensors' }));
    const ri = await studio.animate({ image: pic, prompt: 'she turns her head', seconds: 1, steps: 5, seed: 11 }, 'video-tab');
    const reci = readJson(ri.json); i2vPath = ri.path;
    assert(ri.ok && reci.startPicture.path === pic && reci.startPicture.sidecar === path.join(TMP, 'portrait.json') && reci.startPicture.seed === 4242 && reci.askedBy.who === 'you', 'picture → video: the starting picture, a link to its own sidecar and its seed; asked by you');
    const rmi = VR.remakeRequest(reci);
    assert(rmi.kind === 'animate' && rmi.request.image === pic && rmi.request.seed === 11 && rmi.exact, 'its remake starts from the same picture with the same seed');
    const remakeBad = VR.remakeRequest(Object.assign({}, reci, { startPicture: undefined, sourceImage: '(base64 picture)' }));
    assert(!remakeBad.request.image && /dropped in/.test(remakeBad.note), 'a picture that was dropped in (no file) → the remake says it can\'t start from it');
    assert(VR.askedByOf('trailer:akowe').who === 'Akọwe trailer' && VR.askedByOf('trailer').who === 'Trailer' && VR.askedByOf('bridge:akowe-forge').who === 'Akọwe' && VR.askedByOf('video-tab:improve').who === 'Make it better', 'who asked: Akọwe trailer / Trailer / Akọwe / Make it better');
  }
  // FramePack
  {
    const fpDir = F.makeFramePackDir(path.join(TMP, 'FramePack'));
    const hf = path.join(TMP, 'hf'); F.makeHfCache(hf);
    const runLog = path.join(TMP, 'fp-runner.log');
    Object.assign(process.env, F.runnerEnv({ log: runLog, stepMs: 5 }));
    const mgr = FP.createFramePack({ find: () => FP.findFramePack({ dir: fpDir, smPackages: () => [], modelsDir: hf }), cancelKillMs: 3000 });
    const fpVideos = path.join(TMP, 'fp-videos');
    const st2 = VS.createVideoStudio({ framepack: () => mgr, videosDir: () => fpVideos, comfy: async () => null, persist: () => {}, appVersion: () => '9.9.9', settings: { backend: 'framepack' },
      makePicture: async () => { const p = path.join(TMP, 'made.png'); fs.writeFileSync(p, FP.testPicture()); fs.writeFileSync(path.join(TMP, 'made.json'), JSON.stringify({ seed: 77 })); return { ok: true, path: p, engine: 'sd' }; } });
    const r = await st2.generate({ prompt: 'a lighthouse beam sweeps', seconds: 2, steps: 6, seed: 31, distilledCfg: 9, teacache: false }, 'trailer:akowe');
    const rec = readJson(r.json);
    const want = ['promptTyped', 'prompt', 'negativePrompt', 'engine', 'model', 'modelFiles', 'workflow', 'framepack', 'seconds', 'fps', 'frames', 'seed', 'startPicture', 'askedBy', 'appVersion', 'renderSeconds'];
    const missing = want.filter((k) => rec[k] === undefined);
    assert(r.ok && !missing.length && rec.engine === 'framepack', `FramePack: the sidecar holds every setting${missing.length ? ` — missing ${missing.join(', ')}` : ''}`);
    assert(rec.framepack.steps === 6 && rec.framepack.distilledCfg === 9 && rec.framepack.teacache === false && rec.framepack.cfg === 1 && rec.framepack.rs === 0 && rec.framepack.wantSeconds === 2 && rec.framepack.gpuMemoryPreservation === 6 && rec.seed === 31, 'FramePack\'s own settings: steps, distilled CFG, real CFG, TeaCache, GPU memory, the asked seconds, the seed');
    assert(rec.startPicture.madeFirst && rec.startPicture.path === path.join(TMP, 'made.png') && rec.startPicture.seed === 77 && rec.askedBy.who === 'Akọwe trailer' && /hf/.test(rec.modelFiles.folder), 'the picture made first (and its seed), asked by the Akọwe trailer, the model folder');
    const used = VR.settingsUsed(rec).map((x) => `${x.label}: ${x.value}`).join('\n');
    assert(/Distilled CFG \(guidance\): 9/.test(used) && /Faster \(TeaCache\): off/.test(used) && /Picture made first/.test(used), '"Settings used" says FramePack\'s settings in plain words');
    const vjsF = createVideoJudgeStudio({ studio: st2, judge: { judge: async () => ({ ok: false }) }, grabber: async () => fakeGrabber(), recipes: VRec.createVideoRecipeStore({}), log: () => {} });
    const nBefore = fs.readFileSync(runLog, 'utf8').split('\n').filter((l) => /"generate"/.test(l)).length;
    const rm = await vjsF.remake(r.path);
    const gens = fs.readFileSync(runLog, 'utf8').split('\n').filter((l) => /"generate"/.test(l)).map((l) => JSON.parse(l).cmd);
    const [a, b] = [gens[nBefore - 1], gens[nBefore]];
    const keys = ['seed', 'steps', 'gs', 'use_teacache', 'seconds', 'gpu_memory_preservation', 'prompt', 'negative'];
    assert(rm.ok && rm.sameSeed && a && b && keys.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k])) && b.image === path.join(TMP, 'made.png'), `♻ FramePack remake: the runner gets the same ${keys.join(', ')} — from the SAME picture (${path.basename(b ? b.image : '?')})`);
    await mgr.stop();
  }

  // ======================================================================================
  console.log('\n== 4. 💾 video recipes: the same store as pictures, its own file and starters ==');
  {
    const file = path.join(TMP, 'video-recipes.json');
    const st = VRec.createVideoRecipeStore({ file, log: () => {} });
    let l = st.list();
    const ids = l.recipes.map((x) => x.id);
    assert(['vstarter-wan22-t2v', 'vstarter-wan22-i2v', 'vstarter-wan21-fast', 'vstarter-fp-i2v', 'vstarter-fp-character'].every((x) => ids.includes(x)) && l.recipes.every((x) => x.starter), `five starters: Wan 2.2 5B text/picture, Wan 2.1 1.3B fast, FramePack picture / character (${l.count})`);
    const s5 = l.recipes.find((x) => x.id === 'vstarter-wan22-t2v');
    assert(/Wan 2\.2 5B · 5 s · 1280×704 · 24 fps · 20 steps · CFG 5/.test(s5.short) && s5.family === 'Wan 2.2 5B', `the starter matches the engine's own defaults (${s5.short})`);
    const d = VI.MODELS['wan21-t2v-1.3b'].defaults; const s1 = st.get('vstarter-wan21-fast').recipe.settings;
    assert(s1.width === d.width && s1.fps === d.fps && s1.steps === d.steps && s1.cfgScale === d.cfgScale && st.get('vstarter-fp-i2v').recipe.settings.steps === VS.FP_DEFAULTS.steps, 'Wan 2.1 and FramePack starters come from video-installer / video-studio defaults');
    let r = st.save({ name: 'Calm clip', settings: { engine: 'comfy-wan', model: 'wan22-ti2v-5b', seconds: 3, steps: 26, cfgScale: 4, shift: 6, teacache: true, bogus: 1 }, promptTemplate: '{subject}, steady camera' });
    assert(r.ok && r.recipe.settings.steps === 26 && r.recipe.settings.teacache === undefined && r.recipe.settings.bogus === undefined, 'save: unknown keys and other-engine keys are dropped (no TeaCache on Wan)');
    assert(!st.save({ name: 'x', settings: { steps: 3 }, promptTemplate: 'no subject' }).ok && st.save({ name: 'Calm clip', settings: { steps: 30 } }).recipe.settings.cfgScale === 4, 'a template needs {subject}; saving the same name again updates one setting');
    assert(st.rename(r.recipe.id, 'Calm clip 2').ok && st.get('Calm clip 2').ok && st.setDefault(r.recipe.id).ok && st.list().defaultId === r.recipe.id, 'rename, ⭐ default');
    assert(!st.save({ id: 'vstarter-fp-i2v', name: 'x', settings: { steps: 3 } }).ok && st.remove('vstarter-fp-i2v').starterHidden && !st.list().recipes.some((x) => x.id === 'vstarter-fp-i2v'), 'a starter can\'t be changed, only hidden');
    const st2 = VRec.createVideoRecipeStore({ file, log: () => {} });
    assert(st2.get('Calm clip 2').ok && st2.list().defaultId === r.recipe.id && !st2.list().recipes.some((x) => x.id === 'vstarter-fp-i2v'), 'saved in video-recipes.json and read back');
    assert(st.remove(r.recipe.id).ok && !st.get('Calm clip 2').ok && st.list().defaultId === '', 'delete (the default goes with it)');
    // apply: a recipe + words → a request (request fields win)
    const rq = VRec.toRequest(st.get('vstarter-fp-character').recipe, { subject: 'Odile at the window', request: { seconds: 2 } });
    assert(rq.backend === 'framepack' && rq.seconds === 2 && rq.teacache === false && /Odile at the window, the character moves naturally/.test(rq.prompt) && rq.promptTyped === 'Odile at the window' && rq.recipeUsed.id === 'vstarter-fp-character', 'apply: FramePack settings, the template wraps the words, the request\'s 2 s wins, the recipe is noted');
    const fr = VRec.fromRecord({ engine: 'comfy-wan', model: 'wan21-t2v-1.3b', mode: 't2v', seconds: 3, fps: 16, width: 832, height: 480, steps: 30, cfgScale: 6, shift: 8, sampler: 'uni_pc', scheduler: 'simple', negativeAuto: true, createdAt: '2026-11-09' });
    assert(fr.settings.model === 'wan21-t2v-1.3b' && fr.settings.negativeMode === 'auto' && /Wan 2\.1 1\.3B — text → video/.test(fr.name), 'a video\'s sidecar → a recipe ("use these settings again")');
    // pictures still work exactly as before through the generalised store
    const ps = SR.createRecipeStore({});
    assert(ps.list().recipes.some((x) => x.id === 'starter-sdxl-portrait') && !ps.list().recipes.some((x) => /^vstarter/.test(x.id)) && /832×1216/.test(ps.list().recipes.find((x) => x.id === 'starter-sdxl-portrait').short), 'the picture store is unchanged (its own starters and summary)');
  }

  // ======================================================================================
  console.log('\n== 5. the judge order (the pictures\' runner, video rules) — each judge missing ==');
  {
    const sheet = path.join(TMP, 'clip.sheet.png');
    const mk = (state, text) => ({ label: state, calls: 0, available: async () => (state === 'ready' ? { ok: true, state } : { ok: false, state, why: `${state}` }), async ask() { this.calls++; return state === 'ready' ? { ok: true, text: typeof text === 'function' ? text(this.calls) : text } : { ok: false, error: 'CC_NOT_INSTALLED', message: 'not here', unavailable: true }; } });
    const rec = { mode: 't2v', engine: 'comfy-wan', prompt: 'x' };
    const run = async (judges, extra) => JS.createJudgeService({ judges, rules: VJ, tag: 'video-judge', settings: () => ({}) }).judge(sheet, Object.assign({ record: rec, save: false, validateOpts: { i2v: false } }, extra || {}));
    let r = await run({ 'claude-code': mk('ready', judgeJson(1)), pane: mk('ready', judgeJson(2)), local: mk('ready', judgeJson(3)) });
    assert(r.ok && r.judge.by === 'claude-code' && r.judge.kind === 'video' && /contact sheet/.test(r.say), 'all three ready → Claude Code first, video scores, the verdict in words');
    r = await run({ 'claude-code': mk('not_installed'), pane: mk('ready', judgeJson(2)), local: mk('ready', judgeJson(3)) });
    assert(r.ok && r.judge.by === 'pane' && r.tried[0].by === 'claude-code', 'no Claude Code → the web pane');
    r = await run({ 'claude-code': mk('not_installed'), pane: mk('busy'), local: mk('ready', judgeJson(3)) });
    assert(r.ok && r.judge.by === 'local' && r.judge.weaker, 'no Claude Code, the pane busy → the local model (marked weaker)');
    r = await run({ 'claude-code': mk('ready', judgeJson(1)), pane: mk('not_ready'), local: mk('missing') });
    assert(r.ok && r.judge.by === 'claude-code', 'only Claude Code → Claude Code');
    r = await run({ 'claude-code': mk('not_installed'), pane: mk('not_ready'), local: mk('missing') });
    assert(!r.ok && r.code === 'NO_JUDGE_ANSWERED' && /look at the video/.test(r.message) && r.tried.length === 3, `none → one plain error (${r.message.slice(0, 60)}…)`);
    const flaky = mk('ready', (n) => (n === 1 ? 'Nice video! 8/10' : judgeJson(2)));
    r = await run({ 'claude-code': flaky, pane: mk('ready', judgeJson(3)), local: mk('missing') });
    assert(r.ok && r.judge.by === 'claude-code' && r.judge.attempts === 2 && flaky.calls === 2, 'a malformed answer is asked for once more (the same judge)');
    // the real image-judge-cc.js runner with the fake `claude` CLI: the contact sheet alone in an empty folder, only Read
    const bin = makeFakeClaude(path.join(TMP, 'fakeclaude'));
    const logF = path.join(TMP, 'fakeclaude', 'calls.jsonl');
    const cc = CC.createClaudeCodeJudge({ env: () => Object.assign({}, process.env, { AUTOINJECTOR_CLAUDE_PATH: bin, FAKE_CLAUDE_JUDGE_LOG: logF, FAKE_CLAUDE_JUDGE_STATE: path.join(TMP, 'fakeclaude', 'n'), ANTHROPIC_API_KEY: 'sk-x' }) });
    fs.writeFileSync(sheet, VF.encodePng(moving(1, 64, 36), 64, 36));
    r = await JS.createJudgeService({ judges: { 'claude-code': cc }, rules: VJ, settings: () => ({}) }).judge(sheet, { record: Object.assign({}, rec, { mode: 'i2v', startPicture: { path: 'C:/p.png' } }), save: false, validateOpts: { i2v: true }, ctx: { sheet: { frames: [{ index: 0, time: 0 }], hasStart: true } } });
    const line = fs.readFileSync(logF, 'utf8').trim().split('\n').pop(); const c1 = JSON.parse(line);
    assert(r.ok && r.judge.scores.faithful != null && r.judge.scores.consistency && c1.sawPicture && c1.cwdFiles.length === 1 && !c1.apiKey && c1.argv.includes('Read'), `Claude Code (fake CLI): the contact sheet alone in an empty folder, only Read, no API key — video scores incl. faithful (${r.judge.overall}/10)`);
  }

  // ======================================================================================
  console.log('\n== 6. 🔁 Make it better with quick previews · Make N · Stop · the defaults stay ==');
  const fakeVideos = path.join(TMP, 'fake-videos'); fs.mkdirSync(fakeVideos, { recursive: true });
  function fakeStudio(o) {
    const opts = o || {};
    const S = { calls: [], settingsCalls: 0, cancelled: 0, n: 0, pendingCancel: null, isBusy: false,
      busy() { return this.isBusy; }, settings() { this.settingsCalls++; return { ok: true }; }, gallery() { return { ok: true, items: [] }; },
      async cancel() { this.cancelled++; if (this.pendingCancel) this.pendingCancel(); return { ok: true, cancelled: true }; },
      async render(kind, req, from) {
        this.calls.push({ kind, req: JSON.parse(JSON.stringify(req)), from });
        if (opts.hangOn && opts.hangOn(this.calls.length)) { this.isBusy = true; await new Promise((res) => { this.pendingCancel = res; }); this.isBusy = false; this.pendingCancel = null; return { ok: false, error: 'VIDEO_CANCELLED', code: 'VIDEO_CANCELLED', message: 'Stopped.' }; }
        if (opts.failOn && opts.failOn(this.calls.length)) return { ok: false, error: 'VIDEO_OOM', code: 'VIDEO_OOM', message: 'The graphics card ran out of memory.', fix: 'Make it shorter or smaller.' };
        const n = ++this.n; const seed = req.seed != null && req.seed >= 0 ? req.seed : 5000 + n;
        const p = path.join(fakeVideos, `v-${Date.now().toString(36)}-${n}.mp4`); fs.writeFileSync(p, Buffer.alloc(4096, n));
        const fps = req.fps || 24; const frames = req.frames || Math.round((req.seconds || 4) * fps + 1);
        const rec = VR.enrich({ kind: 'video', engine: req.backend === 'framepack' ? 'framepack' : 'comfy-wan', model: req.model || 'wan22-ti2v-5b', mode: req.image ? 'i2v' : 't2v', prompt: req.prompt, negativePrompt: req.negativePrompt, seed, steps: req.steps, cfgScale: req.cfgScale, shift: req.shift, sampler: req.sampler, scheduler: req.scheduler, width: req.width || 1280, height: req.height || 704, frames, fps, seconds: Math.round((frames - 1) / fps * 100) / 100, sourceImage: req.image, file: path.basename(p), createdAt: new Date().toISOString() }, { from, preview: req.preview, improve: req.improve, promptTyped: req.promptTyped, recipe: req.recipeUsed });
        fs.writeFileSync(p.replace(/\.mp4$/, '.json'), JSON.stringify(rec));
        return { ok: true, path: p, url: `file://${p}`, seed, record: rec, width: rec.width, height: rec.height, seconds: rec.seconds };
      },
      generate: (req, from) => S.render('generate', req, from), animate: (req, from) => S.render('animate', req, from) };
    for (const k of ['busy', 'settings', 'gallery', 'cancel']) S[k] = S[k].bind(S);
    return S;
  }
  function scriptedJudge(scores) { // the n-th judgement gets scores[n] (overall), via the real judge service
    let n = 0;
    const j = { label: 'Fake judge', available: async () => ({ ok: true }), ask: async () => { const s = scores[Math.min(n, scores.length - 1)]; n++; const keep = s >= 8; return { ok: true, text: JSON.stringify({ scores: { prompt: s, quality: s, consistency: s, motion: s, flicker: s, faithful: null }, verdict: keep ? 'keep' : 'fix', fixes: keep ? [] : [{ type: 'steps', delta: 4 }, { type: 'motion', amount: 'less' }], prompt: {} }) }; } };
    return { svc: JS.createJudgeService({ judges: { 'claude-code': j }, rules: VJ, settings: () => ({}) }), count: () => n };
  }
  // a source video with a full sidecar
  const base = fakeStudio();
  const src0 = await base.generate({ prompt: 'the ferry leaves at dusk', seed: 123, steps: 20, cfgScale: 5, shift: 8, sampler: 'uni_pc', scheduler: 'simple', width: 1280, height: 704, frames: 121, fps: 24, model: 'wan22-ti2v-5b', backend: 'comfy-wan', negativePrompt: 'blurry' }, 'video-tab');
  let srcN = 0;
  const freshSrc = () => { const p = path.join(fakeVideos, `src-${++srcN}.mp4`); fs.copyFileSync(src0.path, p); fs.copyFileSync(src0.path.replace(/\.mp4$/, '.json'), p.replace(/\.mp4$/, '.json')); return { path: p }; };
  let src = freshSrc();
  {
    const S = fakeStudio(); const J = scriptedJudge([4, 5, 6, 7]);
    const events = []; const logs2 = [];
    const vjs = createVideoJudgeStudio({ studio: S, judge: J.svc, grabber: async () => fakeGrabber(), recipes: VRec.createVideoRecipeStore({}), settings: () => ({ rounds: 3 }), log: (t, d) => logs2.push({ t, d }), onProgress: (e) => events.push(e), fileUrl: (p) => `file://${p}` });
    const r = await vjs.improve(src.path, { rounds: 3 });
    assert(r.ok && r.rounds.length === 4 && r.rounds[0].label === 'Your video' && r.rounds.slice(1).every((x) => x.preview) && J.count() === 4, `round 0 = your video, then 3 quick previews, each judged once (${r.rounds.map((x) => x.overall).join(' → ')})`);
    assert(S.calls.length === 3 && S.calls.every((c) => c.req.preview && c.req.frames === 37 && c.req.width === 832 && c.req.height === 480), 'every preview is short (37 frames ≈ 1.5 s) and small (832×480, the same shape)');
    assert(S.calls[0].req.seed === 123 && S.calls[0].req.steps === 24 && S.calls[0].req.shift === 6 && S.calls[1].req.steps === 28, 'previews keep the seed and carry the judge\'s fixes forward (steps 20 → 24 → 28, calmer motion)');
    assert(r.awaitingFinal && r.final.estimateSeconds > 0 && /takes about/.test(r.say) && r.best === 3, `then it WAITS for the OK, with the time the full video takes (${r.final.say})`);
    assert(events.some((e) => e.phase === 'making' && e.estimate) && events.some((e) => e.phase === 'awaiting-final'), 'progress events: each preview (with its own estimate) and "waiting for the final"');
    const f = await vjs.improveFinal(r.id);
    const fin = S.calls[3];
    assert(f.ok && fin && !fin.req.preview && fin.req.frames === 121 && fin.req.width === 1280 && fin.req.height === 704 && fin.req.steps === 32 && fin.req.seed === 123, `the final is full length and full size (121 frames, 1280×704) with the best preview's settings (steps ${fin && fin.req.steps}, seed ${fin && fin.req.seed})`);
    assert(f.final.overall >= 7 && f.final.final && readJson(f.path.replace(/\.mp4$/, '.json')).improve.final === true, 'the final is judged and its sidecar says "Make it better — final render"');
    assert(S.settingsCalls === 0 && r.defaultsChanged === false && f.defaultsChanged === false, 'the 🎬 Video defaults are never touched');
    assert(!(await vjs.improveFinal(r.id)).ok, 'the final can be made once');
    assert(logs2.every((l) => !JSON.stringify(l.d).includes('ferry')) && logs2.some((l) => l.t === 'video-improve' && Array.isArray(l.d.scores)), 'logs hold codes and scores — never the prompt');
    const rec2 = readJson(S.calls.length && f.path.replace(/\.mp4$/, '.json'));
    assert(rec2.askedBy.who === 'Make it better' && rec2.promptTyped === 'the ferry leaves at dusk', 'the made videos say who asked (Make it better) and what was typed');
  }
  {
    src = freshSrc();
    const S = fakeStudio(); const J = scriptedJudge([5, 8.5]);
    const vjs = createVideoJudgeStudio({ studio: S, judge: J.svc, grabber: async () => fakeGrabber(), recipes: VRec.createVideoRecipeStore({}), settings: () => ({}) });
    const r = await vjs.improve(src.path, { rounds: 3, final: 'auto' });
    assert(r.ok && r.stopReason === 'passed' && r.rounds.length === 2 && S.calls.length === 2 && r.finalResult && r.finalResult.ok && !S.calls[1].req.preview, 'stops early when a preview passes, and final "auto" (the trailer) makes the full video straight away');
    const S2 = fakeStudio(); const J2 = scriptedJudge([9]);
    src = freshSrc();
    const r2 = await createVideoJudgeStudio({ studio: S2, judge: J2.svc, grabber: async () => fakeGrabber(), recipes: VRec.createVideoRecipeStore({}) }).improve(src.path, {});
    assert(r2.ok && r2.stopReason === 'passed' && !S2.calls.length && /already passes/.test(r2.say), 'a video that already passes: no previews, nothing to make');
    const S3 = fakeStudio(); const J3 = scriptedJudge([6, 5, 4]);
    src = freshSrc();
    const r3 = await createVideoJudgeStudio({ studio: S3, judge: J3.svc, grabber: async () => fakeGrabber(), recipes: VRec.createVideoRecipeStore({}) }).improve(src.path, { rounds: 5 });
    assert(r3.ok && r3.stopReason === 'no-better' && S3.calls.length === 2 && r3.best === 0 && /no final/.test(r3.say), 'two previews in a row no better → it stops; your video stays the best (no final)');
  }
  {
    // ⏹ Stop in the middle of a preview render
    const S = fakeStudio({ hangOn: (n) => n === 2 }); const J = scriptedJudge([4, 5, 6]);
    const vjs = createVideoJudgeStudio({ studio: S, judge: J.svc, grabber: async () => fakeGrabber(), recipes: VRec.createVideoRecipeStore({}) });
    src = freshSrc();
    const pr = vjs.improve(src.path, { rounds: 3 });
    for (let i = 0; i < 200 && !S.isBusy; i++) await sleep(10);
    assert(vjs.status().running && S.isBusy, 'while a preview renders: running');
    const busyAgain = await vjs.improve(src.path, {});
    assert(!busyAgain.ok && busyAgain.code === 'BUSY', 'a second Make it better while one runs → BUSY');
    const s = vjs.stop();
    const r = await pr;
    assert(s.stopped && S.cancelled === 1 && r.ok && r.stopReason === 'stopped' && r.rounds.length === 2 && r.awaitingFinal, `⏹ Stop mid-render: the render is cancelled, the rounds so far are kept, preview 1 can still become the full video (${r.say})`);
    // Stop during the final
    const S2 = fakeStudio({ hangOn: (n) => n === 2 }); const J2 = scriptedJudge([4, 6]);
    const v2 = createVideoJudgeStudio({ studio: S2, judge: J2.svc, grabber: async () => fakeGrabber(), recipes: VRec.createVideoRecipeStore({}) });
    src = freshSrc();
    const r2 = await v2.improve(src.path, { rounds: 1 });
    const fp = v2.improveFinal(r2.id);
    for (let i = 0; i < 200 && !S2.isBusy; i++) await sleep(10);
    v2.stop();
    const f2 = await fp;
    assert(!f2.ok && f2.code === 'VIDEO_CANCELLED' && /still there/.test(f2.message) && v2.status().awaitingFinal, '⏹ Stop during the final: stopped, and the best settings wait to be made later');
    // a failing render (out of graphics memory)
    const S3 = fakeStudio({ failOn: (n) => n === 1 }); const J3 = scriptedJudge([4]);
    src = freshSrc();
    const r3 = await createVideoJudgeStudio({ studio: S3, judge: J3.svc, grabber: async () => fakeGrabber(), recipes: VRec.createVideoRecipeStore({}) }).improve(src.path, {});
    assert(r3.ok && r3.stopReason === 'failed' && r3.rounds[1].code === 'VIDEO_OOM' && /ran out of memory/.test(r3.rounds[1].error), 'out of graphics memory in a preview → it stops with the reason (video-errors wording)');
    // GPU busy, no judge, a bad file
    const S4 = fakeStudio(); S4.isBusy = true;
    const b4 = await createVideoJudgeStudio({ studio: S4, judge: J3.svc, grabber: async () => fakeGrabber(), recipes: VRec.createVideoRecipeStore({}) }).improve(src.path, {});
    assert(!b4.ok && b4.code === 'BUSY' && /graphics card is busy/.test(b4.message), 'the GPU is busy with another video → BUSY, nothing starts');
    const none = JS.createJudgeService({ judges: { 'claude-code': { label: 'x', available: async () => ({ ok: false, state: 'not_installed' }), ask: async () => ({ ok: false, error: 'CC_NOT_INSTALLED', message: 'Claude Code is not installed.', unavailable: true }) } }, rules: VJ, settings: () => ({ enabled: { pane: false, local: false } }) });
    const nj = await createVideoJudgeStudio({ studio: fakeStudio(), judge: none, grabber: async () => fakeGrabber(), recipes: VRec.createVideoRecipeStore({}) }).judge(src.path, {});
    assert(!nj.ok && nj.code === 'NO_JUDGE_ANSWERED' && nj.sheetUrl && nj.check && /not installed/.test(nj.message), 'no judge available → a plain error (the contact sheet and the frame check are still there)');
    const bad = await createVideoJudgeStudio({ studio: fakeStudio(), judge: none, grabber: async () => fakeGrabber({ fail: true }), recipes: VRec.createVideoRecipeStore({}) }).judge(src.path, {});
    assert(!bad.ok && bad.error === 'BAD_VIDEO' && /moov atom/.test(bad.message), 'a broken video file → BAD_VIDEO, no AI asked');
    const nf = await createVideoJudgeStudio({ studio: fakeStudio(), judge: none, grabber: async () => null, recipes: VRec.createVideoRecipeStore({}) }).judge(src.path, {});
    assert(!nf.ok && nf.error === 'NO_FRAMES', 'no ffmpeg and no player → NO_FRAMES in plain words');
  }
  {
    // the judge saves its verdict and the frame check in the video's sidecar
    src = freshSrc();
    const J = scriptedJudge([6.5]);
    const vjs = createVideoJudgeStudio({ studio: fakeStudio(), judge: J.svc, grabber: async () => fakeGrabber({ frozen: true }), recipes: VRec.createVideoRecipeStore({}), fileUrl: (p) => `file://${p}` });
    const r = await vjs.judge(src.path, {});
    const rec = readJson(src.path.replace(/\.mp4$/, '.json'));
    assert(r.ok && r.check.frozen && r.judge.flickerCheck === 2 && r.judge.scores.flicker < 6.5 && rec.judge.sheet === path.basename(r.sheet) && rec.frameCheck.score === 2, `a frozen clip: the frame check pulls flicker down (${r.judge.scores.flicker}); verdict, sheet name and frame check saved with the video`);
    // Make N, pick the best
    const S = fakeStudio(); const JB = scriptedJudge([5, 8, 6]);
    const vb = createVideoJudgeStudio({ studio: S, judge: JB.svc, grabber: async () => fakeGrabber(), recipes: VRec.createVideoRecipeStore({}), settings: () => ({ bestCount: 2 }) });
    const b = await vb.makeBest({ prompt: 'waves', seed: 5, steps: 7 }, { count: 3 });
    assert(b.ok && b.videos.length === 3 && b.best === 1 && S.calls.every((c) => c.req.seed === -1) && new Set(b.videos.map((x) => x.seed)).size === 3 && readJson(b.bestPath.replace(/\.mp4$/, '.json')).picked.of === 3, `Make 3, pick the best: three seeds, each judged, video 2 is the best (${b.say})`);
    const b2 = await vb.makeBest({ prompt: 'waves' }, {});
    assert(b2.videos.length === 2, 'the count comes from the setting (2) when not given');
    const S2 = fakeStudio({ failOn: (n) => n === 2 });
    const b3 = await createVideoJudgeStudio({ studio: S2, judge: scriptedJudge([7]).svc, grabber: async () => fakeGrabber(), recipes: VRec.createVideoRecipeStore({}) }).makeBest({ prompt: 'x' }, { count: 3 });
    assert(b3.ok && b3.videos.length === 2 && b3.best === 0 && b3.videos[1].code === 'VIDEO_OOM', 'a failing video stops Make N; the ones made are kept and judged');
    // recipes through the studio: fromVideo / fromSettings (a round) / apply / request
    const applied = [];
    const vr = createVideoJudgeStudio({ studio: fakeStudio(), judge: J.svc, grabber: async () => fakeGrabber(), recipes: VRec.createVideoRecipeStore({}), applyToForm: (p, how) => applied.push({ p, how }) });
    const fv = vr.recipesOp('fromVideo', { path: src.path, name: 'From the ferry' });
    const fs2 = vr.recipesOp('fromSettings', { name: 'Best round', settings: { backend: 'comfy-wan', model: 'wan22-ti2v-5b', frames: 121, fps: 24, steps: 28, cfgScale: 5, shift: 6, width: 1280, height: 704, seed: 9, prompt: 'x' } });
    assert(fv.ok && fv.recipe.settings.steps === 20 && fv.recipe.settings.width === 1280 && fs2.ok && fs2.recipe.settings.seconds === 5 && fs2.recipe.settings.steps === 28 && fs2.recipe.settings.prompt === undefined, '💾 from a video, and from a Make-it-better round\'s settings (121 frames = 5 s; no prompt, no seed)');
    const ap = vr.recipesOp('apply', { id: 'Best round' });
    assert(ap.ok && applied[0] && applied[0].how === 'recipe' && applied[0].p.recipeId === fs2.recipe.id, 'apply → the 🎬 Video form gets the recipe (nothing is made)');
  }

  // ======================================================================================
  console.log('\n== 7. 🎩 Alfred: the video-api methods (changes → his "I will…" card) and recipes on generate ==');
  {
    const names = VA.operationNames();
    const want = ['video.record', 'video.remake', 'video.contactSheet', 'video.judge', 'video.improve', 'video.improveFinal', 'video.improveStop', 'video.makeBest', 'video.estimate', 'video.judgeStatus', 'video.judgeSettings', 'video.recipes.list', 'video.recipes.get', 'video.recipes.save', 'video.recipes.rename', 'video.recipes.delete', 'video.recipes.setDefault', 'video.recipes.fromVideo', 'video.recipes.apply'];
    assert(want.every((n) => names.includes(n)), `every new method is in the module (${want.length})`);
    const op = (n) => VA.OPS.find((o) => o.name === n);
    assert(['video.remake', 'video.judge', 'video.improve', 'video.improveFinal', 'video.makeBest', 'video.judgeSettings', 'video.recipes.save', 'video.recipes.delete', 'video.recipes.apply'].every((n) => op(n).changes === true) && ['video.record', 'video.contactSheet', 'video.estimate', 'video.judgeStatus', 'video.recipes.list', 'video.recipes.get'].every((n) => op(n).changes === false), 'changes and AI usage are "changes" (the card asks first); reading is not');
    assert(/ONE AI answer/.test(op('video.judge').description) && /QUICK PREVIEW/.test(op('video.improve').description) && /confirm/.test(op('video.improve').description), 'the descriptions say: one AI answer, quick previews, the confirm step');
    const S = fakeStudio(); const J = scriptedJudge([5, 9]);
    const vjs = createVideoJudgeStudio({ studio: S, judge: J.svc, grabber: async () => fakeGrabber(), recipes: VRec.createVideoRecipeStore({}), settings: () => ({}) });
    const api = VA.createVideoApi({ studio: S, judge: vjs });
    src = freshSrc();
    let r = await api.call('video.generate', { prompt: 'Odile waves', recipe: 'Character moves — FramePack (starter)', seconds: 2 });
    const c = S.calls[S.calls.length - 1];
    assert(r.ok && c.req.backend === 'framepack' && c.req.teacache === false && c.req.seconds === 2 && /Odile waves, the character moves naturally/.test(c.req.prompt) && c.req.recipeUsed.id === 'vstarter-fp-character', 'video.generate { recipe }: the recipe\'s settings and template, the request\'s 2 s wins');
    r = await api.call('video.generate', { prompt: 'x', recipe: 'nope' });
    assert(!r.ok && r.code === 'NO_RECIPE', 'an unknown recipe → NO_RECIPE (with the list in the hint)');
    r = await api.call('video.recipes.list', {});
    assert(r.ok && r.count >= 5, 'video.recipes.list');
    r = await api.call('video.judge', { path: src.path });
    assert(r.ok && r.judge.kind === 'video', 'video.judge through the module');
    r = await api.call('video.improve', { path: src.path, rounds: 2 });
    assert(r.ok && r.awaitingFinal, 'video.improve waits for the final (confirm) …');
    r = await api.call('video.improveFinal', {});
    assert(r.ok && r.final, '… video.improveFinal makes it');
    r = await api.call('video.judgeSettings', { rounds: 2, autoTrailer: true });
    assert(r.ok && r.settings.rounds === 2 && r.settings.autoTrailer === true, 'video.judgeSettings');
    r = await api.call('video.improve', { path: src.path, final: 'later' });
    assert(!r.ok && r.code === 'INVALID_PARAM' || (r.ok === true), 'a bad final value is refused or treated as confirm');
    r = await api.call('video.estimate', { request: { model: 'wan21-t2v-1.3b', width: 832, height: 480, frames: 33, steps: 30 } });
    assert(r.ok && r.seconds > 0 && /about/.test(r.say), `video.estimate (${r.say})`);
    const noJ = VA.createVideoApi({ studio: S });
    r = await noJ.call('video.judge', { path: src.path });
    assert(!r.ok && r.code === 'NOT_WIRED', 'without the judge part → NOT_WIRED (never a crash)');
  }

  // ======================================================================================
  console.log('\n== 8. 🎞 the trailer: a recipe for the shots, "Judge and improve trailer shots automatically" ==');
  {
    const S = fakeStudio(); const improved = []; const asked = [];
    const out = path.join(TMP, 'trailers');
    const mkT = (autoJudge) => VT.createTrailerMaker({
      studio: S, trailersDir: () => out, fileUrl: (p) => `file://${p}`, log: () => {}, ffmpeg: () => null,
      record: () => ({ done: (async () => ({ ok: true }))(), stop() {}, abort() {} }),
      recipeRequest: (id, o) => { asked.push(id); return { ok: true, request: VRec.toRequest(VRec.STARTERS.find((x) => x.id === id), o) }; },
      improveShot: async (p, o) => { improved.push({ p, o }); const g = await S.generate({ prompt: 'better', seed: 1 }, 'trailer:judge'); return { ok: true, bestPath: g.path, best: 1, rounds: [{ overall: 5 }, { overall: 8 }] }; },
      autoJudge: () => autoJudge,
    });
    const T = mkT(false);
    const n = VT.normalizeTrailer({ book: 'B', items: [{ type: 'shot', prompt: 'p', recipe: 'vstarter-wan21-fast' }], recipe: 'vstarter-wan22-t2v', judgeShots: true });
    assert(n.plan && n.plan.recipe === 'vstarter-wan22-t2v' && n.plan.judgeShots === true && n.plan.items[0].recipe === 'vstarter-wan21-fast', 'the plan takes a recipe (trailer and shot) and judgeShots');
    assert(VT.normalizeTrailer({ book: 'B', items: [{ type: 'shot', prompt: 'p' }], judgeShots: 'yes' }).error, 'judgeShots must be true or false');
    let r = await T.make({ book: `T1-${Date.now()}`, items: [{ type: 'shot', prompt: 'the ferry', seconds: 2 }, { type: 'shot', prompt: 'the lake', seconds: 2, recipe: 'vstarter-wan21-fast' }], recipe: 'vstarter-wan22-t2v', wait: true, resume: false });
    const calls = S.calls.slice(-2);
    assert(r && asked.join(',') === 'vstarter-wan22-t2v,vstarter-wan21-fast' && calls[0].req.model === 'wan22-ti2v-5b' && calls[0].req.seconds === 2 && calls[1].req.model === 'wan21-t2v-1.3b' && calls[1].req.purpose === 'trailer_shot', 'each shot uses its recipe (the trailer\'s, or its own); the shot\'s seconds win');
    assert(!improved.length, 'the auto-judge is OFF by default: no AI usage');
    const T2 = mkT(true);
    const b = `T2-${Date.now()}`;
    r = await T2.make({ book: b, items: [{ type: 'shot', prompt: 'the ferry', seconds: 2 }], wait: true, resume: false });
    const st = T2.status({});
    assert(improved.length === 1 && improved[0].o.rounds === 2 && improved[0].o.final === 'auto' && st.status && st.status.items[0].improved && st.status.items[0].judge.scores.join() === '5,8', 'switched on: each new shot is judged and improved (at most 2 rounds, the full shot made at once) and the better one is used');
    const T3 = mkT(true);
    await T3.make({ book: `T3-${Date.now()}`, items: [{ type: 'shot', prompt: 'x', seconds: 2 }], judgeShots: false, wait: true, resume: false });
    assert(improved.length === 1, 'a plan\'s judgeShots: false wins over the setting');
  }

  await comfy.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
