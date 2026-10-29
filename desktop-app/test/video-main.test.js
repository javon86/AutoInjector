'use strict';
// test/video-main.test.js — the REAL main.js (mock Electron) with the 🎬 video engine:
// the legacy channels (video:status keeps its old fields; video:generate now goes through
// video-studio and keeps its old answer shape), the Video tab's channels against a fake
// ComfyUI, the video-api registration, the setup wizard catalog and the capability test's
// "Video generation" step (not set up → ⚪ with the reason; set up → a real 1-second clip).
// Run: node test/video-main.test.js
process.env.AUTOINJECTOR_BRIDGE = '0';
process.env.AUTOINJECTOR_CHECKIN = '0';
process.env.AUTOINJECTOR_AKOWE_SERVER = '0';
process.env.AUTOINJECTOR_SD_AUTOSTART = '0';
process.env.AUTOINJECTOR_VIDEO_AUTOSTART = '0';
process.env.AUTOINJECTOR_VIDEO_POLL_MS = '40';
process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS = '30';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Module = require('module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'video-main-'));
process.env.AUTOINJECTOR_SD_HOME = path.join(TMP, 'sdhome');
process.env.AUTOINJECTOR_AKOWE_PORT = String(20000 + Math.floor(Math.random() * 20000));
const mockPath = path.join(__dirname, 'mock-electron.js');
const origLoad = Module._load;
Module._load = function (request) { if (request === 'electron') return require(mockPath); return origLoad.apply(this, arguments); };
const mock = require(mockPath);
const opened = [];
mock.shell = { openPath: async (p) => { opened.push(p); return ''; }, openExternal: async () => {}, showItemInFolder: (p) => { opened.push(p); } };
mock.Menu = { buildFromTemplate: () => ({}), setApplicationMenu: () => {} };
const { fakeComfy, MP4, PNG } = require('./fixtures/fake-sd');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  require('../main.js');
  await sleep(300);
  const outputManager = require('../output-manager');
  outputManager.init(path.join(TMP, 'content'));
  const H = mock.__ipcHandlers;
  const call = (ch, payload) => H[ch]({}, payload);
  // The capability test would also ping the three (mock) AI panes and wait for replies: not what this test is about.
  for (const site of ['chatgpt', 'claude', 'gemini']) await call('participants:set', { site, enabled: false });

  console.log('\n== nothing set up ==');
  let s = await call('video:status');
  assert(s.ok && s.enabled === false && s.configured === false && s.engine && s.engine.ready === false, 'video:status (legacy) keeps the old fields and adds the engine\'s');
  let r = await call('video:generate', { prompt: 'waves' });
  assert(r && r.ok === false && r.error === 'VIDEO_NOT_SET_UP' && /ComfyUI/.test(r.message + r.fix), `video:generate (legacy) → VIDEO_NOT_SET_UP in plain words (${r.message})`);
  const fsT = await call('video:full-status', {});
  assert(fsT.ok && !fsT.ready && /not set up/i.test(fsT.message) && fsT.models.length === 2, 'video:full-status says what is missing');
  assert(fsT.localModels && fsT.localModels.framepack === false && !fsT.localModels.note, 'no FramePack files in "stuff and thing" → no FramePack note');
  const fpFile = path.join(outputManager.modelsDir('framepack'), 'hub', 'models--lllyasviel--FramePackI2V_HY', 'snapshots', '86c', 'diffusion_pytorch_model-00001-of-00003.safetensors');
  fs.mkdirSync(path.dirname(fpFile), { recursive: true }); fs.writeFileSync(fpFile, 'x');
  const fsT2 = await call('video:full-status', {});
  assert(fsT2.localModels.framepack && /FramePack models found/.test(fsT2.localModels.note) && /Setup & models → FramePack/.test(fsT2.localModels.note) && /video\/framepack\/hf/.test(fsT2.localModels.note), `video/framepack/hf has files (FramePack itself not found yet) → the Video tab says so (${fsT2.localModels.note})`);
  assert(fsT2.framepack && fsT2.framepack.available && !fsT2.framepack.found && !fsT2.ready, 'FramePack not found → not ready (the files alone are not enough)');

  console.log('\n== ComfyUI uses "stuff and thing" (extra_model_paths.yaml) ==');
  let cu = await call('sd:comfy-use-stuff', {});
  assert(!cu.ok && /No ComfyUI was found/.test(cu.message), 'no ComfyUI anywhere → said plainly');
  const pc = path.join(TMP, 'sdhome', 'ComfyUI_windows_portable');
  fs.mkdirSync(path.join(pc, 'ComfyUI'), { recursive: true }); fs.writeFileSync(path.join(pc, 'ComfyUI', 'main.py'), '');
  fs.mkdirSync(path.join(pc, 'python_embeded'), { recursive: true }); fs.writeFileSync(path.join(pc, 'python_embeded', process.platform === 'win32' ? 'python.exe' : 'python'), '');
  fs.writeFileSync(path.join(pc, 'ComfyUI', 'extra_model_paths.yaml'), 'mine:\n  base_path: D:/x\n  loras: l/\n');
  cu = await call('sd:comfy-use-stuff', {});
  const yml = fs.readFileSync(path.join(pc, 'ComfyUI', 'extra_model_paths.yaml'), 'utf8');
  assert(cu.ok && /now uses the models in "stuff and thing"/.test(cu.message) && /^mine:\n  base_path: D:\/x\n  loras: l\/\n/.test(yml) && yml.includes(`base_path: ${JSON.stringify(outputManager.modelsRoot().replace(/\\/g, '/'))}`) && /\n  checkpoints: image\/\n/.test(yml), 'the app\'s own ComfyUI gets the autoinjector_stuff section; the user\'s section is kept');
  fs.rmSync(pc, { recursive: true, force: true }); // the rest of this test needs "no ComfyUI yet"
  const wo = await call('sd:open-workflows-folder', {});
  assert(wo.ok && opened.includes(path.join(outputManager.root(), 'workflows')), '📂 Open workflows folder opens "stuff and thing"/workflows');
  const mi = await call('models:info');
  assert(mi.ok && Array.isArray(mi.folders) && mi.folders.find((f) => f.key === 'framepack').files === 1 && mi.folders.some((f) => f.key === 'ultralytics_bbox'), 'models:info (📦 Your models, Alfred) has the count per folder');
  const cat = await call('wizard:catalog');
  assert(cat.ok && cat.installers.video && cat.installers.video.inApp && cat.installers.video.models.length === 2, 'the setup wizard catalog lists 🎬 Video (in the app, two models)');
  const mods = await call('video:models');
  assert(mods.ok && mods.models.every((m) => !m.installed) && mods.models.find((m) => m.id === 'wan22-ti2v-5b').approxBytes > 18e9, 'video:models: both missing, with sizes');
  assert((await call('video:install-model', { id: 'wan22-ti2v-5b' })).code === 'VIDEO_NOT_SET_UP', 'downloading without a ComfyUI → VIDEO_NOT_SET_UP (never throws)');
  let cap = await call('butler:capability-test');
  let step = cap && (cap.checks || []).find((c) => c.name === 'Video generation');
  assert(step && step.ok === null && /not set up/.test(step.detail) && !/configured but turned off/.test(step.detail), `capability test: ⚪ not set up — "${step && step.detail}"`);

  console.log('\n== the old endpoint, through the engine ==');
  const ep = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ videos: [MP4.toString('base64')] })); }); });
  await new Promise((rr) => ep.listen(0, '127.0.0.1', rr));
  await call('video:configure', { enabled: true, endpoint: `http://127.0.0.1:${ep.address().port}/gen` });
  r = await call('video:generate', { prompt: 'a cube spins' });
  assert(r.ok && r.engine === 'endpoint' && r.path && fs.existsSync(r.path) && /^file:/.test(r.preview) && fs.existsSync(r.path.replace(/\.mp4$/, '.json')), 'video:generate (legacy) with the old endpoint: saved in videos/ with a sidecar, preview URL kept');
  assert((await call('video:animate', { image: PNG.toString('base64') })).error === 'UNSUPPORTED_ON_BACKEND', 'picture→video on the endpoint → UNSUPPORTED_ON_BACKEND');
  await call('video:configure', { enabled: false });
  await new Promise((rr) => ep.close(rr));

  console.log('\n== ComfyUI with Wan (the Video tab\'s channels) ==');
  const comfy = await fakeComfy({ videoPolls: 2 });
  r = await call('video:settings', { patch: { comfyUrl: comfy.base } });
  assert(r.ok && r.settings.comfyUrl === comfy.base, 'video:settings: the ComfyUI address');
  s = await call('video:full-status', { fresh: true });
  assert(s.ready && s.backend === 'comfy-wan' && s.comfy.base === comfy.base && s.installed.length === 2, `ready: ${s.message}`);
  r = await call('video:generate-t2v', { prompt: 'a lighthouse at night', seconds: 1, model: 'wan21-t2v-1.3b' });
  assert(r.ok && r.engine === 'comfy-wan' && r.model === 'wan21-t2v-1.3b' && r.fps === 16 && fs.existsSync(r.path) && fs.existsSync(r.poster) && r.path.startsWith(outputManager.videosDir()), 'video:generate-t2v → an .mp4 + poster in the videos/ output folder');
  r = await call('video:animate', { image: `data:image/png;base64,${PNG.toString('base64')}`, seconds: 1 });
  assert(r.ok && r.mode === 'i2v' && comfy.state.uploads.length === 1, 'video:animate uploads the picture and makes a clip');
  r = await call('video:generate', { prompt: 'legacy on comfy' });
  assert(r.ok && r.engine === 'comfy-wan' && r.preview && r.path, 'video:generate (legacy) now renders with Wan on ComfyUI');
  const g = await call('video:gallery', { limit: 10 });
  assert(g.ok && g.items.length >= 4 && g.items.some((x) => x.posterUrl), 'video:gallery lists them with posters');
  assert((await call('video:progress')).busy === false && (await call('video:cancel')).ok, 'video:progress / video:cancel answer');
  const ic = await call('video:install-check');
  assert(ic.ok && ic.installed.length === 2, 'video:install-check counts the models ComfyUI lists');
  assert((await call('video:install-cancel')).ok, 'video:install-cancel answers');
  const caps = await call('video:capabilities');
  assert(caps.ok && caps.ready && caps.operations.length > 10, 'video:capabilities');
  const api = require('../video-api').get();
  assert(api && typeof api.call === 'function' && (await api.call('video.status')).ready, 'main registered the video-api (video-api.get())');
  r = await call('video:status');
  assert(r.ok && r.engine.ready && r.engine.backend === 'comfy-wan', 'video:status (legacy) shows the engine is ready');
  assert((await call('video:open-folder')).ok && opened.includes(outputManager.videosDir()), 'video:open-folder');
  assert((await call('video:show-file', { path: 'x.mp4' })).ok, 'video:show-file');
  assert((await call('video:settings', { patch: { backend: 'nope' } })).error === 'INVALID_PARAM', 'bad settings → INVALID_PARAM (no throw)');
  cap = await call('butler:capability-test');
  step = cap && (cap.checks || []).find((c) => c.name === 'Video generation');
  assert(step && step.ok === true && /1-second test clip/.test(step.detail), `capability test: ✅ ${step && step.detail}`);
  const t = comfy.state.videoGraphs[comfy.state.videoGraphs.length - 1];
  assert(Object.values(t).some((n) => n.class_type === 'EmptyHunyuanLatentVideo' && n.inputs.length === 17), 'the capability test rendered a 1-second clip (17 frames at 16 fps, the small model)');
  // persisted
  await sleep(200);
  const saved = JSON.parse(fs.readFileSync(path.join(mock.app.getPath('userData'), 'autoinjector-state.json'), 'utf8'));
  assert(saved.videoStudio && saved.videoStudio.comfyUrl === comfy.base, 'the video settings are saved with the app state');

  console.log('\n== 🎞 FramePack (a fake FramePack folder + the fake runner, no GPU) ==');
  const FF = require('./fixtures/fake-framepack');
  Object.assign(process.env, FF.runnerEnv({ stepMs: 5 }));
  const fpDir = FF.makeFramePackDir(path.join(TMP, 'SM', 'Packages', 'FramePack'));
  FF.makeHfCache(outputManager.modelsDir('framepack'));
  r = await call('video:settings', { patch: { framepackDir: fpDir } });
  assert(r.ok && r.settings.framepackDir === fpDir, 'video:settings: the FramePack folder');
  let fp = await call('video:framepack-status', { gpu: false });
  assert(fp.ok && fp.found && fp.ready && fp.dir === fpDir && fp.models.ok && /stuff and thing/.test(fp.hfSource) && !fp.loaded, `video:framepack-status: found, its models in "stuff and thing" (${fp.message})`);
  s = await call('video:full-status', { fresh: true });
  assert(s.ready && s.backend === 'comfy-wan' && s.framepack.ready && !s.localModels.note, 'auto with Wan ready → still ComfyUI + Wan; FramePack is ready too (no "models found" note any more)');
  r = await call('video:settings', { patch: { backend: 'framepack' } });
  s = await call('video:full-status', { fresh: true });
  assert(r.ok && s.ready && s.backend === 'framepack' && /Ready: FramePack/.test(s.message), `engine FramePack: ${s.message}`);
  r = await call('video:framepack-load', {});
  assert(r.ok && r.loaded && /FramePack is loaded/.test(r.message), `video:framepack-load (▶ Load FramePack): ${r.message}`);
  const vgBefore = comfy.state.videoGraphs.length;
  r = await call('video:animate', { image: `data:image/png;base64,${PNG.toString('base64')}`, seconds: 1, steps: 3 });
  assert(r.ok && r.engine === 'framepack' && r.model === 'framepack-i2v-hy' && r.fps === 30 && r.path.startsWith(outputManager.videosDir()) && fs.existsSync(r.path) && comfy.state.videoGraphs.length === vgBefore, 'video:animate with FramePack → an .mp4 in videos/ (ComfyUI not used)');
  r = await call('video:generate-t2v', { prompt: 'a lighthouse', seconds: 1 });
  assert(!r.ok && r.code === 'FRAMEPACK_PICTURE_FAILED' && /makes a picture first/.test(r.message), `text→video with FramePack asks 🎨 Images for the picture first (none here: “${r.message}”)`);
  r = await call('video:framepack-test', {});
  assert(r.ok && r.engine === 'framepack' && /^test-/.test(path.basename(r.path)), 'video:framepack-test: a 2-second clip from the test picture');
  const hs = await call('health:status', { fresh: true });
  assert(hs.ok && (hs.info || []).some((x) => x.check === 'framepack' && x.ok && /FramePack: ✔ ready/.test(x.text)), '🩺 health: a ✔ FramePack row');
  cap = await call('butler:capability-test');
  step = cap && (cap.checks || []).find((c) => c.name === 'Video generation');
  assert(step && step.ok === true && /with FramePack/.test(step.detail), `capability test with FramePack: ✅ ${step && step.detail}`);
  r = await call('video:framepack-unload', {});
  assert(r.ok && /graphics memory is free/.test(r.message), 'video:framepack-unload');
  await call('video:settings', { patch: { backend: 'auto' } });
  await sleep(300);
  await comfy.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
