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
  await comfy.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
