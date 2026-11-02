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
  const control = path.join(tmp, 'control.json'); // the fake runner reads { mode, precheck } from here at each start
  const setFake = (o) => fs.writeFileSync(control, JSON.stringify(o));
  setFake({ mode: 'ok', precheck: 'ok' });
  const userData = path.join(tmp, 'userdata');
  const made = [];
  const t0 = Date.now() - 1000;
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', `--user-data-dir=${userData}`],
    cwd: APP_DIR,
    env: Object.assign({}, process.env, FF.runnerEnv({ log: runLog, stepMs: 60, control }), { AUTOINJECTOR_FRAMEPACK_STAGE_LIMIT_MS: '2500',
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
    assert(/✔ FramePack found/.test(card) && card.includes(fpDir) && /✔ Its own Python/.test(card) && /✔ Model files found — all three/.test(card) && !/All its models are there/.test(card), `the FramePack card: found, its folder, Python, model files found ✔ (${card.split('\n')[0]})`);
    assert((await c.$$('#vd-fp-models li[data-ok="true"]')).length === 3, 'the three models are listed ✔');
    assert(await c.getAttribute('#vd-fp-lastload', 'data-state') === 'untested' && /Not yet tested/.test(await c.textContent('#vd-fp-lastload')), `files found ≠ loads: never loaded yet → “${await c.textContent('#vd-fp-lastload')}”`);
    assert(/NVIDIA|graphics/.test(await c.textContent('#vd-fp-vram')), 'a graphics-memory hint');
    assert(!(await c.$eval('#btn-vd-fp-load', (b) => b.disabled)) && !(await c.$eval('#btn-vd-fp-test', (b) => b.disabled)) && await c.isVisible('#btn-vd-fp-choose'), '▶ Load, 🧪 Test and 📂 Choose FramePack folder are there');
    assert(/FramePack only/.test(await c.textContent('#vd-backend')), 'Settings: the engine list has "FramePack only"');
    assert(await c.getAttribute('#vd-dot', 'data-tone') === 'standby', `before ▶ Load the light is a green ring (ready, not loaded): ${await c.getAttribute('#vd-dot', 'data-tone')}`);
    await c.click('#btn-vd-fp-load');
    await c.waitForFunction(() => /FramePack is loaded/.test(document.getElementById('vd-fp-msg').textContent), null, { timeout: 20000 }).catch(() => {});
    assert(/✔ FramePack is loaded/.test(await c.textContent('#vd-fp-msg')), `▶ Load FramePack: "${await c.textContent('#vd-fp-msg')}"`);
    await c.waitForFunction(() => /Loaded and ready/.test(document.getElementById('vd-fp-state').textContent), null, { timeout: 10000 }).catch(() => {});
    assert(/Loaded and ready/.test(await c.textContent('#vd-fp-state')), 'the card says it is loaded');
    await c.waitForFunction(() => document.getElementById('vd-dot').dataset.tone === 'ok', null, { timeout: 8000 }).catch(() => {});
    assert(await c.getAttribute('#vd-dot', 'data-tone') === 'ok', 'loaded → the light is green');
    assert(/✔ PyTorch 2\.6\.0\+cu126 sees NVIDIA GeForce RTX 3060/.test(await c.textContent('#vd-fp-state')), 'the card shows what the PyTorch check found (version, the card)');
    assert(await c.getAttribute('#vd-fp-lastload', 'data-state') === 'loaded' && /not yet tested with a clip/.test(await c.textContent('#vd-fp-lastload')), `the last load: loaded, not yet tested (“${await c.textContent('#vd-fp-lastload')}”)`);
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
    await c.click('#vd-sub-setup');
    await c.waitForFunction(() => document.getElementById('vd-fp-lastload').dataset.state === 'tested', null, { timeout: 8000 }).catch(() => {});
    assert(/✔ Loaded and tested/.test(await c.textContent('#vd-fp-lastload')), `after a clip: “${await c.textContent('#vd-fp-lastload')}”`);

    // ---- the PC report: stuck at step 0 "starting PyTorch", the light stayed green, Stop was slow
    await c.click('#vd-sub-setup');
    await c.click('#btn-vd-fp-unload');
    await c.waitForFunction(() => !document.getElementById('btn-vd-fp-load').disabled, null, { timeout: 10000 }).catch(() => {});
    setFake({ mode: 'stuck', precheck: 'ok' });
    await c.click('#btn-vd-fp-load');
    await c.waitForFunction(() => /starting PyTorch — 0:0[1-9]/.test(document.getElementById('vd-fp-msg').textContent), null, { timeout: 15000 }).catch(() => {});
    assert(/starting PyTorch — 0:0[1-9]/.test(await c.textContent('#vd-fp-msg')), `while it loads the card counts the seconds in the stage: "${await c.textContent('#vd-fp-msg')}"`);
    await c.waitForFunction(() => document.getElementById('vd-dot').dataset.tone === 'busy', null, { timeout: 8000 }).catch(() => {});
    assert(await c.getAttribute('#vd-dot', 'data-tone') === 'busy' && /Loading FramePack… starting PyTorch/.test(await c.textContent('#vd-status-text')), `the light is amber “Loading…” while it loads, not green: ${await c.getAttribute('#vd-dot', 'data-tone')} — "${await c.textContent('#vd-status-text')}"`);
    assert(await c.isVisible('#btn-vd-fp-stop') && await c.$eval('#btn-vd-fp-load', (b) => b.disabled), '⏹ Stop is there while it loads (▶ Load is not)');
    await c.waitForSelector('#vd-fp-stuck:not([hidden])', { timeout: 15000 }).catch(() => {});
    const stuckText = await c.textContent('#vd-fp-stuck');
    assert(/PyTorch has been starting for 0:0\d/.test(stuckText) && /seems stuck/.test(stuckText) && /What to try:.*Stop.*Try again/s.test(stuckText), `after the limit it says it seems stuck, with what to try: "${stuckText.split('\n')[0].slice(0, 120)}…"`);
    assert(await c.isVisible('#btn-vd-fp-retry') && await c.isVisible('#btn-vd-fp-stop'), '⏹ Stop and ↻ Try again are offered');
    await c.waitForFunction(() => !document.getElementById('vd-fp-details').hidden, null, { timeout: 8000 }).catch(() => {});
    assert(!(await c.$eval('#vd-fp-details', (d) => d.hidden)) && /Where FramePack is: torch\/__init__\.py/.test(await c.$eval('#vd-fp-raw', (e) => e.textContent)), 'Technical details: where FramePack is (from its heartbeat)');
    await c.waitForFunction(() => document.getElementById('vd-dot').dataset.tone === 'warn', null, { timeout: 8000 }).catch(() => {});
    assert(await c.getAttribute('#vd-dot', 'data-tone') === 'warn' && /seems stuck/.test(await c.textContent('#vd-status-text')), 'the light says it seems stuck too');
    await shot(c, 'fp05-framepack-stuck');
    const runs = fs.readFileSync(runLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const runnerPid = (runs.filter((x) => x.start && !x.precheck && x.mode === 'stuck').pop() || {}).pid;
    const kidPid = (runs.filter((x) => x.grandchild).pop() || {}).grandchild;
    const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (_) { return false; } };
    assert(alive(runnerPid) && alive(kidPid), `the stuck runner (${runnerPid}) and its child (${kidPid}) run`);
    const ts = Date.now();
    await c.click('#btn-vd-fp-stop');
    assert(/Stopping/.test(await c.textContent('#vd-fp-msg')), `⏹ Stop → at once “${await c.textContent('#vd-fp-msg')}”`);
    await c.waitForFunction(() => /Stopped/.test(document.getElementById('vd-fp-msg').textContent), null, { timeout: 10000 }).catch(() => {});
    const took = Date.now() - ts;
    assert(/⏹ Stopped/.test(await c.textContent('#vd-fp-msg')) && took < 6000, `then “Stopped.” (${took} ms)`);
    let gone = false; for (let i = 0; i < 40 && !gone; i++) { gone = !alive(runnerPid) && !alive(kidPid); if (!gone) await c.waitForTimeout(100); }
    assert(gone, 'the stuck runner and its child process are gone');
    await c.waitForFunction(() => document.getElementById('btn-vd-fp-stop').hidden && document.getElementById('vd-fp-stuck').hidden, null, { timeout: 8000 }).catch(() => {});
    assert(await c.$eval('#btn-vd-fp-stop', (b) => b.hidden) && await c.$eval('#vd-fp-stuck', (b) => b.hidden) && !(await c.$eval('#btn-vd-fp-load', (b) => b.disabled)), 'afterwards ⏹ Stop and the warning are gone, ▶ Load is back');
    await c.waitForFunction(() => document.getElementById('vd-dot').dataset.tone === 'standby', null, { timeout: 8000 }).catch(() => {});
    assert(await c.getAttribute('#vd-dot', 'data-tone') === 'standby', `the light is back to “ready, not loaded” (${await c.getAttribute('#vd-dot', 'data-tone')})`);

    // the PyTorch check fails → the reason in plain words on the card, the light red, ↻ Try again
    setFake({ mode: 'ok', precheck: 'nocuda' });
    await c.click('#btn-vd-fp-load');
    await c.waitForFunction(() => /✖/.test(document.getElementById('vd-fp-msg').textContent), null, { timeout: 15000 }).catch(() => {});
    const failText = await c.textContent('#vd-fp-msg');
    assert(/✖ PyTorch 2\.6\.0\+cu126 \(built for CUDA 12\.6\) does not see an NVIDIA graphics card/.test(failText) && /How to fix: .*NVIDIA graphics driver/.test(failText), `pre-check failure in plain words: "${failText.replace(/\n/g, ' / ')}"`);
    await c.waitForFunction(() => document.getElementById('vd-dot').dataset.tone === 'error', null, { timeout: 8000 }).catch(() => {});
    assert(await c.getAttribute('#vd-dot', 'data-tone') === 'error' && /✖ FramePack couldn't load — see the details/.test(await c.textContent('#vd-status-text')), `a failed load → the light is red (${await c.getAttribute('#vd-dot', 'data-tone')}: "${await c.textContent('#vd-status-text')}")`);
    assert(await c.isVisible('#btn-vd-fp-retry'), '↻ Try again is offered');
    await shot(c, 'fp06-framepack-precheck-failed');
    setFake({ mode: 'ok', precheck: 'ok' });
    await c.click('#btn-vd-fp-retry');
    await c.waitForFunction(() => /FramePack is loaded/.test(document.getElementById('vd-fp-msg').textContent), null, { timeout: 20000 }).catch(() => {});
    await c.waitForFunction(() => document.getElementById('vd-dot').dataset.tone === 'ok', null, { timeout: 8000 }).catch(() => {});
    assert(/✔ FramePack is loaded/.test(await c.textContent('#vd-fp-msg')) && await c.getAttribute('#vd-dot', 'data-tone') === 'ok', '↻ Try again (fixed) → loaded, the light green');

    // ---- the PC rerun: 🧪 Test fails while loading "the FramePack video model" (Hugging Face offline / metadata error).
    // Before: the job ended but the header stayed "Loading FramePack… loading the FramePack video model · 0:00" (yellow).
    await c.click('#btn-vd-fp-unload');
    await c.waitForFunction(() => !document.getElementById('btn-vd-fp-load').disabled, null, { timeout: 10000 }).catch(() => {});
    setFake({ mode: 'failmodel', precheck: 'ok' });
    await c.click('#btn-vd-fp-test');
    await c.waitForSelector('#vd-error:not([hidden])', { timeout: 20000 }).catch(() => {});
    const errText = await c.textContent('#vd-error');
    assert(/Hugging Face/.test(errText) && /not a missing-model problem/.test(errText) && !/all three models/.test(errText), `the red error: the reason from the error itself (“${errText.replace(/\s+/g, ' ').slice(0, 140)}…”)`);
    assert(!(await c.$eval('#btn-vd-generate', (b) => b.disabled)) && await c.$eval('#btn-vd-stop', (b) => b.disabled), 'the job ended: Make video on, Stop off');
    await c.waitForFunction(() => document.getElementById('vd-dot').dataset.tone === 'error', null, { timeout: 8000 }).catch(() => {});
    const hdr = await c.textContent('#vd-status-text');
    assert(await c.getAttribute('#vd-dot', 'data-tone') === 'error' && /✖ FramePack couldn't load — see the details/.test(hdr) && !/Loading FramePack/.test(hdr), `the header goes red, not “Loading…”: "${hdr}"`);
    await c.waitForTimeout(2200);
    const hdr2 = await c.textContent('#vd-status-text');
    assert(hdr2 === hdr && !/\d:\d\d/.test(hdr2) && await c.getAttribute('#vd-dot', 'data-tone') === 'error', `…and stays that way, the clock stopped (no “0:00”): "${hdr2}"`);
    await shot(c, 'fp07-framepack-test-failed-header');
    await c.click('#vd-sub-setup');
    await c.waitForFunction(() => document.getElementById('vd-fp-lastload').dataset.state === 'failed', null, { timeout: 8000 }).catch(() => {});
    const lastTxt = await c.textContent('#vd-fp-lastload');
    assert(/✖ Failed to load \(.*while loading the FramePack video model\): FramePack tried to ask Hugging Face/.test(lastTxt) && /What to try: The model files are on this PC/.test(lastTxt), `the card: failed to load ✖ (when, the stage, the reason, what to try): “${lastTxt.split('\n')[0].slice(0, 120)}…”`);
    assert(/✔ Model files found/.test(await c.textContent('#vd-fp-state')), 'the file check still says the files are found (true) — the load result is a separate line');
    await shot(c, 'fp08-framepack-card-last-load-failed');

    // the same test again at once (FramePack's runner is still running and fails again, fast): red again, never left "Loading…"
    await c.click('#btn-vd-fp-test');
    await c.waitForFunction(() => !document.getElementById('btn-vd-generate').disabled && !document.getElementById('vd-error').hidden, null, { timeout: 20000 }).catch(() => {});
    await c.waitForTimeout(1500);
    assert(await c.getAttribute('#vd-dot', 'data-tone') === 'error' && /couldn't load/.test(await c.textContent('#vd-status-text')), `a second failed test → still red: "${await c.textContent('#vd-status-text')}"`);

    // a 🧪 Test stopped while it loads → back to idle (not red, no clock)
    await c.click('#vd-sub-setup');
    await c.click('#btn-vd-fp-unload');
    await c.waitForFunction(() => document.getElementById('btn-vd-fp-unload').disabled, null, { timeout: 10000 }).catch(() => {});
    setFake({ mode: 'stuck', precheck: 'ok' });
    await c.click('#btn-vd-fp-test');
    await c.waitForFunction(() => document.getElementById('vd-dot').dataset.tone === 'busy' && /Loading FramePack/.test(document.getElementById('vd-status-text').textContent), null, { timeout: 15000 }).catch(() => {});
    assert(/Loading FramePack… .* · 0:0\d/.test(await c.textContent('#vd-status-text')), `a new test loads: "${await c.textContent('#vd-status-text')}"`);
    await c.click('#btn-vd-stop');
    await c.waitForFunction(() => !document.getElementById('vd-error').hidden && /Stopped/.test(document.getElementById('vd-error-msg').textContent), null, { timeout: 15000 }).catch(() => {});
    await c.waitForFunction(() => document.getElementById('vd-dot').dataset.tone === 'standby', null, { timeout: 10000 }).catch(() => {});
    const idle = await c.textContent('#vd-status-text');
    assert(await c.getAttribute('#vd-dot', 'data-tone') === 'standby' && !/Loading|couldn't load|\d:\d\d/.test(idle), `⏹ Stop → idle again ("${idle}", ${await c.getAttribute('#vd-dot', 'data-tone')})`);
    await c.waitForTimeout(1500);
    assert(await c.textContent('#vd-status-text') === idle, 'and nothing keeps counting');

    // ---- the PC test (RTX 5070 Ti): loading works, then the 🧪 test fails in generation — xFormers has no kernels for the
    // card ("No operator found for memory_efficient_attention_forward … capability (12, 0) (too new)"). Before: the Setup
    // footer kept "⏳ loading … (step n of n)…", the header went green "Ready", and the fix said "or a shorter clip".
    setFake({ mode: 'failgen', precheck: 'ok' });
    await c.click('#vd-sub-setup');
    await c.click('#btn-vd-fp-test');
    await c.waitForFunction(() => !document.getElementById('vd-error').hidden && /xFormers/.test(document.getElementById('vd-error').textContent), null, { timeout: 20000 }).catch(() => {});
    const attnErr = await c.textContent('#vd-error');
    assert(/FramePack's speed-up part \(xFormers\) has no version for your new graphics card yet/.test(attnErr) && /switches to PyTorch's built-in attention automatically — update AutoInjector and try again/.test(attnErr), `the attention error in plain words: “${attnErr.replace(/\s+/g, ' ').slice(0, 160)}…”`);
    assert(!/shorter clip/i.test(attnErr.replace(/Technical details[\s\S]*$/, '')) && !/shorter clip/i.test(await c.textContent('#vd-error-fix')), 'no “shorter clip” advice for an error that is not about memory');
    await c.waitForFunction(() => document.getElementById('vd-dot').dataset.tone === 'warn', null, { timeout: 8000 }).catch(() => {});
    const amber = await c.textContent('#vd-status-text');
    assert(await c.getAttribute('#vd-dot', 'data-tone') === 'warn' && /✔ FramePack is loaded — ⚠ the last test clip failed \(see below\)/.test(amber) && !/Ready/.test(amber), `loaded but the clip failed → amber, both visible: "${amber}" (${await c.getAttribute('#vd-dot', 'data-tone')})`);
    await c.waitForTimeout(1200);
    assert(await c.getAttribute('#vd-dot', 'data-tone') === 'warn', '…and it stays amber (not green “Ready”)');
    await shot(c, 'fp09-framepack-clip-failed-header');
    await c.click('#vd-sub-setup');
    await c.waitForFunction(() => document.getElementById('vd-fp-lastload').dataset.state === 'jobfailed', null, { timeout: 8000 }).catch(() => {});
    const llTxt = await c.textContent('#vd-fp-lastload');
    assert(/⚠ Loaded — the test clip failed \(.+\): FramePack's speed-up part \(xFormers\)/.test(llTxt), `the card: “${llTxt.split('\n')[0]}”`);
    const foot = await c.textContent('#vd-fp-msg');
    assert(!/⏳|step \d+ of \d+|loading/i.test(foot) && /✔ FramePack is loaded — ⚠ the last test clip failed: FramePack's speed-up part/.test(foot), `the Setup footer is not a stale loading line after the job ended: “${foot}”`);
    assert(/Loaded and ready/.test(await c.textContent('#vd-fp-state')), 'the card still says it is loaded');
    await shot(c, 'fp10-framepack-card-clip-failed');

    // the next clip works → green again, the card “loaded and tested”, the footer plain
    setFake({ mode: 'ok', precheck: 'ok' });
    await c.click('#btn-vd-fp-test');
    await c.waitForFunction(() => /FramePack test video saved/.test(document.getElementById('vd-msg').textContent), null, { timeout: 30000 }).catch(() => {});
    made.push(decodeURIComponent(new URL(await c.getAttribute('#vd-player', 'src')).pathname).replace(/^\/([A-Za-z]:)/, '$1'));
    await c.waitForFunction(() => document.getElementById('vd-dot').dataset.tone === 'ok', null, { timeout: 8000 }).catch(() => {});
    assert(await c.getAttribute('#vd-dot', 'data-tone') === 'ok' && !/failed/.test(await c.textContent('#vd-status-text')), `a clip that works → green again: "${await c.textContent('#vd-status-text')}"`);
    await c.click('#vd-sub-setup');
    await c.waitForFunction(() => document.getElementById('vd-fp-lastload').dataset.state === 'tested', null, { timeout: 8000 }).catch(() => {});
    assert(/✔ Loaded and tested/.test(await c.textContent('#vd-fp-lastload')), `the card after a clip that works: “${await c.textContent('#vd-fp-lastload')}”`);
    assert(!/failed|⏳/.test(await c.textContent('#vd-fp-msg')), `the footer: “${await c.textContent('#vd-fp-msg')}”`);

    // failed again, then ✕ Dismiss → the header is green, the error box gone
    setFake({ mode: 'failgen', precheck: 'ok' });
    await c.click('#btn-vd-fp-test');
    await c.waitForFunction(() => document.getElementById('vd-dot').dataset.tone === 'warn' && !document.getElementById('vd-error').hidden, null, { timeout: 20000 }).catch(() => {});
    assert(await c.getAttribute('#vd-dot', 'data-tone') === 'warn', 'a failed clip → amber again');
    await c.click('#btn-vd-error-dismiss');
    await c.waitForFunction(() => document.getElementById('vd-dot').dataset.tone === 'ok', null, { timeout: 8000 }).catch(() => {});
    assert(await c.getAttribute('#vd-dot', 'data-tone') === 'ok' && await c.$eval('#vd-error', (e) => e.hidden), '✕ Dismiss → the error box goes and the header is green');
    await c.waitForTimeout(1200);
    assert(await c.getAttribute('#vd-dot', 'data-tone') === 'ok', '…and stays green');
  } finally {
    await app.close().catch(() => {});
    for (const f of made) { const dir = path.dirname(f); try { for (const n of fs.readdirSync(dir)) { const p = path.join(dir, n); if (/^(video|animate|test|clip)-.*\.(mp4|webm|png|json)$/.test(n) && fs.statSync(p).mtimeMs >= t0) fs.unlinkSync(p); } } catch (_) {} }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  process.exit(state.failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
