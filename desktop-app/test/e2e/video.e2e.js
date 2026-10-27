'use strict';
// video.e2e.js — the REAL app's 🎬 Video tab against a fake ComfyUI that knows the Wan nodes:
// the tab opens on Setup (not set up yet), the ComfyUI address is saved, both models show as
// downloaded, text→video renders → the <video> player shows the clip with its poster and the
// gallery lists it; picture→video from a dropped picture; the red error box for a model the
// ComfyUI lacks. Screenshots go to SD_SHOT_DIR (or __screenshots__).
//   xvfb-run -a node test/e2e/video.e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findWindow, makeAsserts, APP_DIR, SHOT_DIR } = require('./helpers');
const { fakeComfy, PNG } = require('../fixtures/fake-sd');

let electron;
try { electron = require('playwright')._electron; } catch (_) { console.error('needs playwright'); process.exit(2); }

async function main() {
  const { assert, state } = makeAsserts();
  const shotDir = process.env.SD_SHOT_DIR || SHOT_DIR;
  fs.mkdirSync(shotDir, { recursive: true });
  const shot = async (page, name) => { try { await page.screenshot({ path: path.join(shotDir, `${name}.png`) }); } catch (_) {} };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'video-e2e-'));
  const comfy = await fakeComfy({ videoPolls: 12 });
  const small = await fakeComfy({ wanModels: ['wan2.1_t2v_1.3B_fp16.safetensors', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', 'wan_2.1_vae.safetensors'] });
  const userData = path.join(tmp, 'userdata');
  const made = [];
  const t0 = Date.now() - 1000;
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', `--user-data-dir=${userData}`],
    cwd: APP_DIR,
    env: Object.assign({}, process.env, { AUTOINJECTOR_AKOWE_SERVER: '0', AUTOINJECTOR_SD_HOME: path.join(tmp, 'sdhome'), AUTOINJECTOR_SD_AUTOSTART: '0', AUTOINJECTOR_VIDEO_AUTOSTART: '0', AUTOINJECTOR_VIDEO_POLL_MS: '200' }),
  });
  try {
    const c = await findWindow(app, '#tab-app-video', 40000);
    assert(!!c, 'the control panel shows the 🎬 Video tab');
    if (!c) throw new Error('no window');
    await c.click('#tab-app-video');
    await c.waitForSelector('#video-tab:not([hidden])', { timeout: 10000 });
    assert(await c.evaluate(() => document.body.dataset.appTab === 'video' && document.getElementById('images-tab').hidden), 'the Video tab opens (Images hidden)');
    await c.waitForSelector('#vd-view-setup:not([hidden])', { timeout: 15000 }).catch(() => {});
    assert(await c.evaluate(() => !document.getElementById('vd-view-setup').hidden), 'not set up yet → it opens on ⚙ Setup & models');
    await c.waitForFunction(() => document.querySelectorAll('.vd-model').length === 2, null, { timeout: 15000 }).catch(() => {});
    const setupText = await c.textContent('#vd-setup-comfy');
    assert(/No ComfyUI|not running|installed/.test(setupText) && (await c.$$('.vd-model')).length === 2, `Setup says what is missing: "${setupText.split('\n')[0]}"`);
    assert(/not set up|Install ComfyUI/i.test(await c.textContent('#vd-status-text')), 'the status bar says video is not set up');
    await shot(c, 'v01-video-setup');

    // connect to the (fake) ComfyUI by its address
    await c.fill('#vd-comfy-url', comfy.base);
    await c.click('#btn-vd-save-settings');
    await c.waitForFunction(() => /Ready/.test(document.getElementById('vd-status-text').textContent), null, { timeout: 15000 }).catch(() => {});
    assert(/✔ Ready: ComfyUI/.test(await c.textContent('#vd-status-text')), `status: "${await c.textContent('#vd-status-text')}"`);
    await c.click('#btn-vd-recheck');
    await c.waitForFunction(() => document.querySelectorAll('.vd-model[data-installed="true"]').length === 2, null, { timeout: 15000 }).catch(() => {});
    assert((await c.$$('.vd-model[data-installed="true"]')).length === 2, 'both models show as downloaded (ComfyUI lists their files)');

    // text → video
    await c.click('#vd-sub-make');
    await c.fill('#vd-prompt', 'a lighthouse at night, waves, slow camera push');
    await c.evaluate(() => { const s = document.getElementById('vd-seconds'); s.value = '2'; s.dispatchEvent(new Event('input')); });
    await c.selectOption('#vd-size-preset', '832x480');
    assert(/49 frames at 24 fps/.test(await c.textContent('#vd-frames-note')), `the frame note: "${await c.textContent('#vd-frames-note')}"`);
    await c.click('#btn-vd-generate');
    await c.waitForFunction(() => /Making your video/.test(document.getElementById('vd-msg').textContent), null, { timeout: 5000 }).catch(() => {});
    assert(/Making your video… \d+ s/.test(await c.textContent('#vd-msg')) && !(await c.$eval('#btn-vd-stop', (b) => b.disabled)), 'while it renders: seconds elapsed, Stop enabled');
    await shot(c, 'v02-video-rendering');
    await c.waitForFunction(() => /Video saved/.test(document.getElementById('vd-msg').textContent), null, { timeout: 30000 }).catch(() => {});
    assert(/✔ Video saved: .*\.mp4 \(2 s, 832×480, wan22-ti2v-5b\)/.test(await c.textContent('#vd-msg')), `done: "${(await c.textContent('#vd-msg')).split('\n')[0]}"`);
    const src = await c.getAttribute('#vd-player', 'src');
    const poster = await c.getAttribute('#vd-player', 'poster');
    assert(!(await c.$eval('#vd-player', (v) => v.hidden)) && /^file:.*\.mp4$/.test(src) && /\.png$/.test(poster), 'the <video> player shows the clip with its poster');
    const file = decodeURIComponent(new URL(src).pathname).replace(/^\/([A-Za-z]:)/, '$1');
    made.push(file);
    assert(fs.existsSync(file) && fs.existsSync(file.replace(/\.mp4$/, '.json')) && fs.existsSync(file.replace(/\.mp4$/, '.png')), 'the .mp4, its .json sidecar and the .png poster are in the videos/ folder');
    const g = comfy.state.videoGraphs[comfy.state.videoGraphs.length - 1];
    const lat = Object.values(g).find((n) => n.class_type === 'Wan22ImageToVideoLatent');
    assert(lat && lat.inputs.width === 832 && lat.inputs.height === 480 && lat.inputs.length === 49, 'ComfyUI got the Wan graph with the form\'s settings');
    await c.waitForFunction(() => document.querySelectorAll('#vd-gallery .vd-thumb').length > 0, null, { timeout: 5000 }).catch(() => {});
    assert((await c.$$('#vd-gallery .vd-thumb img')).length >= 1, 'the gallery shows it (poster thumbnail)');
    await shot(c, 'v03-video-result');

    // picture → video from a dropped picture
    await c.click('#btn-vd-mode-i2v');
    assert(!(await c.$eval('#vd-drop', (e) => e.hidden)), 'Picture → video shows the picture drop zone');
    const pic = path.join(tmp, 'portrait.png'); fs.writeFileSync(pic, PNG);
    await c.setInputFiles('#vd-file', pic);
    await c.waitForSelector('#vd-image-preview:not([hidden])', { timeout: 5000 }).catch(() => {});
    assert(/portrait\.png/.test(await c.textContent('#vd-image-note')), 'the picture is chosen and previewed');
    await c.fill('#vd-prompt', '');
    await c.evaluate(() => { const s = document.getElementById('vd-seconds'); s.value = '1'; s.dispatchEvent(new Event('input')); });
    const ups = comfy.state.uploads.length;
    await c.click('#btn-vd-generate');
    await c.waitForFunction(() => /Video saved/.test(document.getElementById('vd-msg').textContent) && !document.getElementById('btn-vd-generate').disabled, null, { timeout: 30000 }).catch(() => {});
    assert(/Video saved: animate-/.test(await c.textContent('#vd-msg')) && comfy.state.uploads.length === ups + 1, 'picture→video: uploaded to ComfyUI and saved');
    made.push(decodeURIComponent(new URL(await c.getAttribute('#vd-player', 'src')).pathname).replace(/^\/([A-Za-z]:)/, '$1'));
    await shot(c, 'v04-video-animate');

    // the red error box: a ComfyUI without the 5B model
    await c.click('#vd-sub-setup');
    await c.fill('#vd-comfy-url', small.base);
    await c.click('#btn-vd-save-settings');
    await c.waitForFunction(() => /Saved/.test(document.getElementById('vd-settings-msg').textContent), null, { timeout: 10000 }).catch(() => {});
    await c.click('#vd-sub-make');
    await c.click('#btn-vd-generate');
    await c.waitForSelector('#vd-error:not([hidden])', { timeout: 20000 }).catch(() => {});
    const err = await c.textContent('#vd-error-msg');
    assert(/doesn't have Wan 2.2 5B/.test(err) && /Download/.test(await c.textContent('#vd-error-fix')) && (await c.$$('#vd-error-actions button')).length === 1, `the red box: "${err}" + a Download button`);
    await shot(c, 'v05-video-error');

    // the Images tab and back
    await c.click('#tab-app-images');
    assert(await c.evaluate(() => document.getElementById('video-tab').hidden && !document.getElementById('images-tab').hidden), 'switching to 🎨 Images hides 🎬 Video');
    await c.click('#tab-app-main');
    assert(await c.evaluate(() => document.getElementById('video-tab').hidden && document.body.dataset.appTab === 'main'), 'and 🤖 AutoInjector hides both');
  } finally {
    await app.close().catch(() => {});
    await comfy.close(); await small.close();
    // remove the videos this run made (the content folder is the app's own)
    for (const f of made) { const dir = path.dirname(f); try { for (const n of fs.readdirSync(dir)) { const p = path.join(dir, n); if (/^(video|animate|test|clip)-.*\.(mp4|webm|png|json)$/.test(n) && fs.statSync(p).mtimeMs >= t0) fs.unlinkSync(p); } } catch (_) {} }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  process.exit(state.failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
