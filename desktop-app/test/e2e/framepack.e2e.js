'use strict';
// framepack.e2e.js — the REAL app's 🎬 Video tab with FramePack as the engine, no GPU: a fake FramePack folder
// (demo_gradio.py, diffusers_helper/, a venv) with its models in its own hf_download, and the fake runner
// (test/fixtures/fake-framepack-runner.js, the same JSON-lines protocol as integrations/framepack/framepack_runner.py).
// FramePack is found (AUTOINJECTOR_FRAMEPACK) and Wan isn't installed → Auto uses FramePack: the status bar says so,
// ⚙ Setup's FramePack card shows the folder + models ✔ + ▶ Load / 🧪 Test / 📂 Choose; the Make tab shows FramePack's
// own settings (seconds, steps, TeaCache, GPU memory to keep free) instead of Wan's; picture→video renders with
// progress (part i of n, step) → the <video> player + the gallery; ⏹ Stop; ♻ Remake puts FramePack's settings back;
// the 🧪 2-second test. Screenshots go to SD_SHOT_DIR (or __screenshots__).
//   xvfb-run -a node test/e2e/framepack.e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findWindow, makeAsserts, APP_DIR, SHOT_DIR } = require('./helpers');
const { PNG } = require('../fixtures/fake-sd');
const FF = require('../fixtures/fake-framepack');

let electron;
try { electron = require('playwright')._electron; } catch (_) { console.error('needs playwright'); process.exit(2); }

async function main() {
  const { assert, state } = makeAsserts();
  const shotDir = process.env.SD_SHOT_DIR || SHOT_DIR;
  fs.mkdirSync(shotDir, { recursive: true });
  const shot = async (page, name) => { try { await page.screenshot({ path: path.join(shotDir, `${name}.png`) }); } catch (_) {} };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'framepack-e2e-'));
  const fpDir = FF.makeFramePackDir(path.join(tmp, 'StabilityMatrix', 'Data', 'Packages', 'FramePack'));
  FF.makeHfCache(path.join(fpDir, 'hf_download'));
  const runLog = path.join(tmp, 'runner.log');
  const userData = path.join(tmp, 'userdata');
  const made = [];
  const t0 = Date.now() - 1000;
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', `--user-data-dir=${userData}`],
    cwd: APP_DIR,
    env: Object.assign({}, process.env, FF.runnerEnv({ log: runLog, stepMs: 60 }), {
      AUTOINJECTOR_FRAMEPACK: fpDir, AUTOINJECTOR_AKOWE_SERVER: '0', AUTOINJECTOR_SD_HOME: path.join(tmp, 'sdhome'), AUTOINJECTOR_SD_AUTOSTART: '0',
      AUTOINJECTOR_VIDEO_AUTOSTART: '0', AUTOINJECTOR_SD_GPU_CHECK: '0', AUTOINJECTOR_CONTENT_SCAN: '0',
    }),
  });
  try {
    const c = await findWindow(app, '#tab-app-video', 40000);
    assert(!!c, 'the control panel shows the 🎬 Video tab');
    if (!c) throw new Error('no window');
    await c.click('#tab-app-video');
    await c.waitForSelector('#video-tab:not([hidden])', { timeout: 10000 });
    await c.waitForFunction(() => /FramePack/.test(document.getElementById('vd-status-text').textContent), null, { timeout: 20000 }).catch(() => {});
    assert(/✔ Ready: FramePack/.test(await c.textContent('#vd-status-text')), `FramePack found, no Wan → Auto uses FramePack: "${await c.textContent('#vd-status-text')}"`);
    assert(await c.evaluate(() => !document.getElementById('vd-view-make').hidden), 'ready → it opens on 🎬 Make video');
    assert(await c.evaluate(() => !document.getElementById('vd-fp-settings').hidden && document.getElementById('vd-wan-settings').hidden), 'the Make tab shows FramePack\'s settings, not Wan\'s');
    assert(/Auto \(FramePack\)/.test(await c.evaluate(() => document.querySelector('#vd-engine option[value="auto"]').textContent)), 'the engine picker says Auto = FramePack');

    // ⚙ Setup: the FramePack card
    await c.click('#vd-sub-setup');
    await c.waitForFunction(() => /FramePack found/.test(document.getElementById('vd-fp-state').textContent), null, { timeout: 15000 }).catch(() => {});
    const card = await c.textContent('#vd-fp-state');
    assert(/✔ FramePack found/.test(card) && card.includes(fpDir) && /✔ Its own Python/.test(card) && /✔ All its models are there/.test(card), `the FramePack card: found, its folder, Python, models ✔ (${card.split('\n')[0]})`);
    assert((await c.$$('#vd-fp-models li[data-ok="true"]')).length === 3, 'the three models are listed ✔');
    assert(/NVIDIA|graphics/.test(await c.textContent('#vd-fp-vram')), 'a graphics-memory hint');
    assert(!(await c.$eval('#btn-vd-fp-load', (b) => b.disabled)) && !(await c.$eval('#btn-vd-fp-test', (b) => b.disabled)) && await c.isVisible('#btn-vd-fp-choose'), '▶ Load, 🧪 Test and 📂 Choose FramePack folder are there');
    assert(/FramePack only/.test(await c.textContent('#vd-backend')), 'Settings: the engine list has "FramePack only"');
    await c.click('#btn-vd-fp-load');
    await c.waitForFunction(() => /FramePack is loaded/.test(document.getElementById('vd-fp-msg').textContent), null, { timeout: 20000 }).catch(() => {});
    assert(/✔ FramePack is loaded/.test(await c.textContent('#vd-fp-msg')), `▶ Load FramePack: "${await c.textContent('#vd-fp-msg')}"`);
    await c.waitForFunction(() => /Loaded and ready/.test(document.getElementById('vd-fp-state').textContent), null, { timeout: 10000 }).catch(() => {});
    assert(/Loaded and ready/.test(await c.textContent('#vd-fp-state')), 'the card says it is loaded');
    await shot(c, 'fp01-framepack-setup');

    // picture → video with FramePack
    await c.click('#vd-sub-make');
    await c.click('#btn-vd-mode-i2v');
    const pic = path.join(tmp, 'portrait.png'); fs.writeFileSync(pic, PNG);
    await c.setInputFiles('#vd-file', pic);
    await c.waitForSelector('#vd-image-preview:not([hidden])', { timeout: 5000 }).catch(() => {});
    await c.fill('#vd-prompt', 'she turns her head and smiles');
    await c.evaluate(() => { const s = document.getElementById('vd-fp-seconds'); s.value = '2'; s.dispatchEvent(new Event('input')); const t = document.getElementById('vd-fp-steps'); t.value = '6'; t.dispatchEvent(new Event('input')); });
    assert(/73 frames at 30 fps/.test(await c.textContent('#vd-frames-note')), `the note: "${await c.textContent('#vd-frames-note')}"`);
    await c.click('#btn-vd-generate');
    await c.waitForFunction(() => /part \d of 2/.test(document.getElementById('vd-msg').textContent), null, { timeout: 15000 }).catch(() => {});
    assert(/Making your video… \d+ s · making the frames · part \d of 2 · step \d+ of 12/.test(await c.textContent('#vd-msg')), `while it renders: "${(await c.textContent('#vd-msg')).split('\n')[0]}"`);
    await shot(c, 'fp02-framepack-rendering');
    await c.waitForFunction(() => /Video saved/.test(document.getElementById('vd-msg').textContent), null, { timeout: 30000 }).catch(() => {});
    assert(/✔ Video saved: animate-.*\.mp4 \(2\.43 s, 640×480, framepack-i2v-hy\)/.test(await c.textContent('#vd-msg')), `done: "${(await c.textContent('#vd-msg')).split('\n')[0]}"`);
    const src = await c.getAttribute('#vd-player', 'src');
    const file = decodeURIComponent(new URL(src).pathname).replace(/^\/([A-Za-z]:)/, '$1');
    made.push(file);
    assert(fs.existsSync(file) && fs.existsSync(file.replace(/\.mp4$/, '.json')) && fs.existsSync(file.replace(/\.mp4$/, '.png')) && /videos$/.test(path.dirname(file)), 'the .mp4 + sidecar + poster are in "stuff and thing"/videos like the others');
    const rec = JSON.parse(fs.readFileSync(file.replace(/\.mp4$/, '.json'), 'utf8'));
    assert(rec.engine === 'framepack' && rec.steps === 6 && rec.teacache === true, 'the sidecar says FramePack, with its settings');
    const sent = fs.readFileSync(runLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((x) => x.cmd).filter((x) => x && x.cmd === 'generate').pop();
    assert(sent && sent.prompt === 'she turns her head and smiles' && sent.seconds === 2 && sent.steps === 6 && sent.use_teacache === true && sent.gpu_memory_preservation === 6, 'FramePack got the form\'s settings');
    await c.waitForFunction(() => document.querySelectorAll('#vd-gallery .vd-thumb img').length > 0, null, { timeout: 5000 }).catch(() => {});
    assert((await c.$$('#vd-gallery .vd-thumb img')).length >= 1, 'the gallery shows it');
    await shot(c, 'fp03-framepack-result');

    // ⏹ Stop
    await c.evaluate(() => { const s = document.getElementById('vd-fp-seconds'); s.value = '10'; s.dispatchEvent(new Event('input')); const t = document.getElementById('vd-fp-steps'); t.value = '60'; t.dispatchEvent(new Event('input')); });
    await c.click('#btn-vd-generate');
    await c.waitForFunction(() => /step \d+ of/.test(document.getElementById('vd-msg').textContent), null, { timeout: 15000 }).catch(() => {});
    await c.click('#btn-vd-stop');
    await c.waitForSelector('#vd-error:not([hidden])', { timeout: 20000 }).catch(() => {});
    assert(/Stopped/.test(await c.textContent('#vd-error-msg')) && !(await c.$eval('#btn-vd-generate', (b) => b.disabled)), '⏹ Stop → "Stopped." and Make is ready again');

    // ♻ Remake
    await c.click('#vd-gallery .vd-thumb');
    await c.click('#btn-vd-remake');
    assert(await c.evaluate(() => document.getElementById('vd-engine').value === 'framepack' && document.getElementById('vd-fp-steps').value === '6' && document.getElementById('vd-seed').value !== '-1'), '♻ Remake puts FramePack and its settings (steps, seed) back');

    // 🧪 the 2-second test from a test picture
    await c.click('#vd-sub-setup');
    await c.click('#btn-vd-fp-test');
    await c.waitForFunction(() => /FramePack test video saved/.test(document.getElementById('vd-msg').textContent), null, { timeout: 30000 }).catch(() => {});
    assert(/✔ FramePack test video saved: test-.*\.mp4 \(2\.43 s/.test(await c.textContent('#vd-msg')), `🧪 Test: "${(await c.textContent('#vd-msg')).split('\n')[0]}"`);
    made.push(decodeURIComponent(new URL(await c.getAttribute('#vd-player', 'src')).pathname).replace(/^\/([A-Za-z]:)/, '$1'));
    await shot(c, 'fp04-framepack-test');
  } finally {
    await app.close().catch(() => {});
    for (const f of made) { const dir = path.dirname(f); try { for (const n of fs.readdirSync(dir)) { const p = path.join(dir, n); if (/^(video|animate|test|clip)-.*\.(mp4|webm|png|json)$/.test(n) && fs.statSync(p).mtimeMs >= t0) fs.unlinkSync(p); } } catch (_) {} }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  process.exit(state.failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
