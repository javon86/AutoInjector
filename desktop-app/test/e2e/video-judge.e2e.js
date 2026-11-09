'use strict';
// video-judge.e2e.js — 🎬 💾 video recipes, 🧑‍⚖️ the video judge (a contact sheet of the frames) and 🔁 Make it better with
// quick previews in the REAL app (xvfb), with the fake ComfyUI (test/fixtures/fake-sd.js — it hands back a real clip made
// by ffmpeg's test pattern) and the fake `claude` CLI as the judge (test/fixtures/fake-claude-judge.js: video scores).
//   make a clip → 🧑‍⚖️ Judge shows the video scores and the contact sheet → 🔁 Make it better: 2 quick previews (short,
//   small) + the full video after the OK, with a visible strip → 💾 Save these settings as a recipe → load it →
//   ♻ Remake reproduces the seed and settings.
// The app gets its own HOME and XDG_CONFIG_HOME (like voice.e2e.js) and a teardown that force-kills (like ease.e2e.js).
// The window is 1280×720. Screenshots: VJ_SHOTS (default test/e2e/__screenshots__); 2× screenshots:
//   VJ_SCALE=2 TMPDIR=/dev/shm xvfb-run -a -s "-screen 0 2700x1600x24" node test/e2e/video-judge.e2e.js
// No ffmpeg (AUTOINJECTOR_FFMPEG=none): the contact sheet comes from the app's own player instead.
//   TMPDIR=/dev/shm xvfb-run -a node test/e2e/video-judge.e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeAsserts, APP_DIR } = require('./helpers');
const { fakeComfy } = require('../fixtures/fake-sd');
const { makeFakeClaude } = require('../fixtures/fake-claude-judge');
const VT = require('../../video-trailer');

let electron;
try { electron = require('playwright')._electron; } catch (_) { console.error('needs playwright'); process.exit(2); }
const SHOTS = process.env.VJ_SHOTS || path.join(__dirname, '__screenshots__');
const FIX = path.join(__dirname, '..', 'fixtures', 'fake-chat.html');
const url = (q) => `file://${FIX}?${q}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function teardown(app) {
  let t = null;
  const done = await Promise.race([app.close().then(() => true, () => true), new Promise((r) => { t = setTimeout(() => r(false), 20000); })]);
  clearTimeout(t);
  if (!done) { console.log('  (teardown: the app did not quit in 20 s — force-killed)'); try { const pr = app.process && app.process(); if (pr && pr.pid) process.kill(pr.pid, 'SIGKILL'); } catch (_) {} }
}

async function main() {
  const { assert, state } = makeAsserts();
  fs.mkdirSync(SHOTS, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vj-e2e-'));
  const home = path.join(tmp, 'home'); fs.mkdirSync(home, { recursive: true });
  const userData = path.join(tmp, 'userdata');
  const claude = makeFakeClaude(path.join(tmp, 'fakeclaude'));
  const ccLog = path.join(tmp, 'fakeclaude', 'calls.jsonl');
  // a real 2-second clip (ffmpeg's test pattern, kept in test/fixtures so it is there even on a PC/CI box with no ffmpeg)
  // for the fake ComfyUI to hand back. AUTOINJECTOR_FFMPEG=none tells the app not to use ffmpeg (its own player reads it).
  const ffmpeg = VT.findFfmpeg({ roots: [], env: Object.assign({}, process.env, { AUTOINJECTOR_FFMPEG: '' }) });
  const appFfmpeg = process.env.AUTOINJECTOR_FFMPEG !== 'none' && ffmpeg;
  const clip = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'test-clip-2s.webm'));
  const comfy = await fakeComfy({ videoPolls: 2, noSaveVideo: !!clip, clip: () => clip });
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', `--force-device-scale-factor=${process.env.VJ_SCALE || '1'}`, `--user-data-dir=${userData}`], cwd: APP_DIR,
    env: Object.assign({}, process.env, {
      HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), AUTOINJECTOR_AKOWE_SERVER: '0', AUTOINJECTOR_CHECKIN: '0', AUTOINJECTOR_BRIDGE: '0', AUTOINJECTOR_SD_AUTOSTART: '0',
      AUTOINJECTOR_VIDEO_AUTOSTART: '0', AUTOINJECTOR_VIDEO_POLL_MS: '150', AUTOINJECTOR_CONTENT_SCAN: '0', AUTOINJECTOR_SD_HOME: path.join(home, 'sdhome'), AUTOINJECTOR_SD_MODEL_DIRS: path.join(tmp, 'nomodels'),
      AUTOINJECTOR_CLAUDE_PATH: claude, FAKE_CLAUDE_JUDGE_STATE: path.join(tmp, 'fakeclaude', 'n'), FAKE_CLAUDE_JUDGE_LOG: ccLog,
      AUTOINJECTOR_JUDGE_OLLAMA: 'http://127.0.0.1:9', AUTOINJECTOR_PROBE_DELAY_MS: '800',
      AUTOINJECTOR_SITE_URL_CHATGPT: url('site=chatgpt&quirks=none&speed=0.3'), AUTOINJECTOR_SITE_URL_CLAUDE: url('site=claude&quirks=none&speed=0.3'), AUTOINJECTOR_SITE_URL_GEMINI: url('site=gemini&quirks=none&speed=0.3'),
      AUTOINJECTOR_AKOWE_DIR: path.join(tmp, 'noakowe'), NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    }),
  });
  const shot = async (page, name) => { try { await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); } catch (_) {} };
  const t0 = Date.now() - 1000; let videosDir = null;
  const fileOf = (u) => decodeURIComponent(new URL(u).pathname).replace(/^\/([A-Za-z]:)/, '$1');
  try {
    let c = null;
    for (let i = 0; i < 100 && !c; i++) { for (const w of app.windows()) { try { if (await w.$('#tab-app-video')) c = w; } catch (_) {} } if (!c) await sleep(400); }
    assert(!!c, 'the control panel appears');
    if (!c) return;
    const errors = []; c.on('pageerror', (e) => errors.push(String(e)));
    await app.evaluate(({ BaseWindow }) => { for (const w of BaseWindow.getAllWindows()) { try { if (w.isVisible()) { if (w.isFullScreen()) w.setFullScreen(false); if (w.isMaximized()) w.unmaximize(); w.setContentSize(1280, 720); w.center(); } } catch (_) {} } });
    await sleep(800);
    await c.click('#tab-app-video');
    await c.waitForSelector('#video-tab:not([hidden])', { timeout: 10000 });
    await c.click('#vd-sub-setup');
    await c.fill('#vd-comfy-url', comfy.base);
    await c.click('#btn-vd-save-settings');
    await c.waitForFunction(() => /Ready/.test(document.getElementById('vd-status-text').textContent), null, { timeout: 15000 }).catch(() => {});
    assert(/✔ Ready: ComfyUI/.test(await c.textContent('#vd-status-text')), `video is ready on the fake ComfyUI (${(await c.textContent('#vd-status-text')).slice(0, 60)})`);
    await c.click('#vd-sub-make');
    videosDir = (await c.evaluate(() => window.api.video.gallery(1))).dir || null;

    console.log('\n== 💾 the recipe picker ==');
    await c.waitForFunction(() => document.getElementById('vd-recipe').options.length > 4, null, { timeout: 10000 }).catch(() => {});
    const names = await c.$$eval('#vd-recipe option', (o) => o.map((x) => x.textContent));
    assert(['Text → video — Wan 2.2 5B (starter)', 'Picture → video — Wan 2.2 5B (starter)', 'Quick and light — Wan 2.1 1.3B (starter)', 'Picture → video — FramePack (starter)', 'Character moves — FramePack (starter)'].every((n) => names.includes(n)), `the starters are listed (${names.length - 1})`);
    await c.selectOption('#vd-recipe', 'vstarter-wan21-fast');
    await c.waitForFunction(() => /Loaded/.test(document.getElementById('vd-recipe-note').textContent), null, { timeout: 5000 }).catch(() => {});
    const formNow = await c.evaluate(() => ({ model: document.getElementById('vd-model').value, w: document.getElementById('vd-width').value, steps: document.getElementById('vd-steps').value, fps: document.getElementById('vd-fps').value }));
    assert(formNow.model === 'wan21-t2v-1.3b' && formNow.w === '832' && formNow.steps === '30' && formNow.fps === '16', `loading a recipe fills the form (${JSON.stringify(formNow)})`);
    const wide = await c.evaluate(() => { const t = document.getElementById('video-tab'); return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, tab: t.scrollWidth - t.clientWidth, w: innerWidth }; });
    assert(wide.page <= 1 && wide.tab <= 1, `no sideways scrolling at ${wide.w} px wide (page ${wide.page}, tab ${wide.tab})`);
    const row = await c.evaluate(() => { const r = document.getElementById('vd-recipe-row').getBoundingClientRect(); const b = document.getElementById('btn-vd-recipe-default').getBoundingClientRect(); return { h: Math.round(r.height), right: Math.round(b.right), card: Math.round(document.getElementById('vd-recipe-row').parentElement.getBoundingClientRect().right) }; });
    assert(row.h <= 34 && row.right <= row.card, `the recipe row is one compact line (${row.h}px high, its buttons inside the card)`);
    await shot(c, 'vj01-recipe-picker');

    console.log('\n== make a clip → 🧑‍⚖️ Judge (a contact sheet of the frames) ==');
    await c.selectOption('#vd-recipe', '');
    await c.selectOption('#vd-model', 'wan22-ti2v-5b');
    await c.fill('#vd-prompt', 'an old ferry crosses a misty lake at dawn, slow camera push');
    await c.evaluate(() => { for (const [id, v] of [['vd-seconds', '2'], ['vd-width', '1280'], ['vd-height', '704'], ['vd-steps', '20'], ['vd-cfg', '5'], ['vd-shift', '8'], ['vd-fps', '24']]) { const s = document.getElementById(id); s.value = v; s.dispatchEvent(new Event('input')); } });
    await c.click('#btn-vd-generate');
    await c.waitForFunction(() => /Video saved/.test(document.getElementById('vd-msg').textContent) && !document.getElementById('btn-vd-generate').disabled, null, { timeout: 40000 }).catch(() => {});
    const first = fileOf(await c.getAttribute('#vd-player', 'src'));
    const rec0 = JSON.parse(fs.readFileSync(first.replace(/\.[^.]+$/, '.json'), 'utf8'));
    const g0 = comfy.state.videoGraphs[comfy.state.videoGraphs.length - 1];
    assert(rec0.promptTyped && rec0.seed >= 0 && rec0.askedBy.who === 'you' && rec0.modelFiles && rec0.modelFiles.diffusion && rec0.workflow && rec0.appVersion && rec0.renderSeconds != null && rec0.comfyGraph, 'the video\'s sidecar holds everything (typed prompt, the real seed, who asked, model files, workflow, app version, time)');
    await c.waitForFunction(() => !document.getElementById('btn-vd-judge').disabled, null, { timeout: 8000 }).catch(() => {});
    await c.click('#vd-used summary');
    const used = await c.$$eval('#vd-used-list dt', (d) => d.map((x) => x.textContent));
    assert(['What you asked for', 'Made by', 'Model files', 'Length', 'Size', 'Steps', 'Seed (the number that makes this exact video)', 'Asked by', 'App version'].every((l) => used.includes(l)), `"Settings used" in plain words (${used.length} rows)`);
    await c.click('#vd-used summary');
    await c.click('#btn-vd-judge');
    await c.waitForSelector('#vd-judge-box:not([hidden]) .sd-jbar', { timeout: 60000 }).catch(() => {});
    const jtext = await c.textContent('#vd-judge-box');
    const bars = (await c.$$('#vd-judge-box .sd-jbar')).length;
    assert(/\d(\.\d)?\/10/.test(jtext) && /judged by Claude Code/.test(jtext) && /contact sheet/.test(jtext) && /one AI answer/.test(jtext) && bars === 5, `the judge box: video scores (${bars} bars — text → video has no "faithful"), Claude Code, from a contact sheet, one AI answer`);
    assert(/Stays the same across frames/.test(jtext) && /Natural motion/.test(jtext) && /Frame check \(no AI\)/.test(jtext), 'video scores and the no-AI frame check are shown');
    const sheet = await c.$eval('#vd-judge-sheet', (im) => ({ w: im.naturalWidth, src: im.src })).catch(() => ({ w: 0 }));
    assert(sheet.w > 600 && /\.sheet\.png$/.test(sheet.src) && fs.existsSync(fileOf(sheet.src)), `the contact sheet the judge looked at is shown (${sheet.w}px wide, ${appFfmpeg ? 'via ffmpeg' : 'via the app\'s player'})`);
    const cc1 = fs.existsSync(ccLog) ? JSON.parse(fs.readFileSync(ccLog, 'utf8').trim().split('\n').pop()) : {};
    assert(cc1.sawPicture && cc1.cwdFiles && cc1.cwdFiles.length === 1, 'Claude Code saw only the contact sheet (one file in an empty folder)');
    const rj = JSON.parse(fs.readFileSync(first.replace(/\.[^.]+$/, '.json'), 'utf8'));
    assert(rj.judge && rj.judge.kind === 'video' && rj.frameCheck && rj.frameCheck.score != null, 'the verdict and the frame check are saved with the video');
    await c.evaluate(() => document.getElementById('vd-judge-box').scrollIntoView({ block: 'center' }));
    await shot(c, 'vj02-judge-contact-sheet');

    console.log('\n== 🔁 Make it better: 2 quick previews + the full video ==');
    await c.click('#vd-judge-set summary');
    await c.fill('#vd-judge-rounds', '2');
    await c.dispatchEvent('#vd-judge-rounds', 'change');
    await c.click('#vd-judge-set summary');
    const nGraphs = comfy.state.videoGraphs.length;
    await c.click('#btn-vd-improve');
    await c.waitForSelector('#vd-improve-box:not([hidden])', { timeout: 5000 }).catch(() => {});
    await c.waitForSelector('#vd-final-row:not([hidden])', { timeout: 90000 }).catch(() => {});
    const cards = await c.$$eval('#vd-improve-strip .vd-round .sd-rs', (d) => d.map((x) => x.textContent));
    const finalMsg = await c.textContent('#vd-final-msg');
    assert(cards.length === 3 && /Your video/.test(cards[0]) && /Preview 1/.test(cards[1]) && /Preview 2/.test(cards[2]), `the strip: your video + 2 previews (${cards.join(' | ')})`);
    assert(/takes about/.test(finalMsg), `before the full video: the time it takes (“${finalMsg.slice(0, 90)}”)`);
    const previews = comfy.state.videoGraphs.slice(nGraphs);
    const lat = (g) => (Object.values(g || {}).find((n) => /LatentVideo|ImageToVideoLatent/.test(n.class_type)) || { inputs: {} }).inputs;
    const ks = (g) => (Object.values(g || {}).find((n) => n.class_type === 'KSampler') || { inputs: {} }).inputs;
    assert(previews.length === 2 && previews.every((g) => lat(g).width === 832 && lat(g).height === 480 && lat(g).length === 37) && ks(previews[0]).seed === rec0.seed, `the previews are short (37 frames) and small (832×480) with the same seed (${previews.map((g) => `${lat(g).width}×${lat(g).height}/${lat(g).length}`).join(', ')})`);
    assert(ks(previews[0]).steps === 24 && ks(previews[1]).steps === 28, `the judge's fixes are carried forward (steps ${ks(previews[0]).steps} → ${ks(previews[1]).steps})`);
    assert(await c.$$eval('#vd-improve-strip .vd-round video', (v) => v.length === 3 && v.every((x) => /^file:/.test(x.src))), 'each round has a small playable preview');
    await c.evaluate(() => document.getElementById('vd-improve-box').scrollIntoView({ block: 'end' }));
    await shot(c, 'vj03-improve-strip');
    await c.click('#btn-vd-final');
    await c.waitForFunction(() => document.querySelectorAll('#vd-improve-strip .vd-round').length === 4 && /full video is made/.test(document.getElementById('vd-improve-msg').textContent), null, { timeout: 90000 }).catch(() => {});
    const fin = comfy.state.videoGraphs[comfy.state.videoGraphs.length - 1];
    assert(comfy.state.videoGraphs.length === nGraphs + 3 && lat(fin).width === 1280 && lat(fin).height === 704 && lat(fin).length === lat(g0).length && ks(fin).steps === 28 && ks(fin).seed === rec0.seed, `the full video: full length and size (${lat(fin).width}×${lat(fin).height}/${lat(fin).length}), the best settings (steps ${ks(fin).steps}), the same seed`);
    const finalCard = await c.textContent('#vd-improve-strip .vd-round:last-child .sd-rs');
    assert(/Final/.test(finalCard) && /\/10/.test(finalCard), `the final is in the strip with its score (${finalCard})`);
    const finalFile = fileOf(await c.getAttribute('#vd-player', 'src'));
    const recF = JSON.parse(fs.readFileSync(finalFile.replace(/\.[^.]+$/, '.json'), 'utf8'));
    assert(recF.improve && recF.improve.final && recF.askedBy.who === 'Make it better' && recF.steps === 28, 'the final\'s sidecar: Make it better, final render, steps 28');
    const st = await c.evaluate(() => window.api.video.status());
    assert(st.settings && !st.settings.steps && st.settings.model === 'wan22-ti2v-5b', 'the 🎬 Video defaults were not changed');
    await c.evaluate(() => document.getElementById('vd-improve-box').scrollIntoView({ block: 'end' }));
    await shot(c, 'vj04-improve-final');

    console.log('\n== 💾 Save these settings as a recipe → load it → ♻ Remake ==');
    await c.click('#btn-vd-improve-recipe');
    await c.waitForSelector('#vd-recipe-name-row:not([hidden])', { timeout: 3000 }).catch(() => {});
    await c.fill('#vd-recipe-name', 'Misty ferry — better');
    await c.click('#btn-vd-recipe-name-ok');
    await c.waitForFunction(() => /Saved the recipe/.test(document.getElementById('vd-recipe-note').textContent), null, { timeout: 5000 }).catch(() => {});
    const sel = await c.$eval('#vd-recipe', (s) => s.options[s.selectedIndex] && s.options[s.selectedIndex].textContent);
    assert(sel === 'Misty ferry — better', `the round's settings are a recipe now, picked in the list (${sel})`);
    await c.selectOption('#vd-recipe', '');
    await c.evaluate(() => { const s = document.getElementById('vd-steps'); s.value = '9'; s.dispatchEvent(new Event('input')); });
    const rid = await c.$$eval('#vd-recipe option', (o) => (o.find((x) => x.textContent === 'Misty ferry — better') || {}).value);
    await c.selectOption('#vd-recipe', rid);
    await c.waitForFunction(() => document.getElementById('vd-steps').value === '28', null, { timeout: 5000 }).catch(() => {});
    assert(await c.evaluate(() => document.getElementById('vd-steps').value === '28' && document.getElementById('vd-width').value === '1280' && document.getElementById('vd-shift').value === '4'), 'loading it puts the better settings back into the form (steps 28, shift 4)');
    const before = comfy.state.videoGraphs.length;
    await c.click('#btn-vd-remake');
    await c.waitForFunction(() => /Remade/.test(document.getElementById('vd-msg').textContent), null, { timeout: 40000 }).catch(() => {});
    const rm = comfy.state.videoGraphs[comfy.state.videoGraphs.length - 1];
    const same = (a, b) => JSON.stringify([ks(a).seed, ks(a).steps, ks(a).cfg, ks(a).sampler_name, lat(a).width, lat(a).height, lat(a).length]) === JSON.stringify([ks(b).seed, ks(b).steps, ks(b).cfg, ks(b).sampler_name, lat(b).width, lat(b).height, lat(b).length]);
    assert(comfy.state.videoGraphs.length === before + 1 && same(rm, fin) && /the same seed/.test(await c.textContent('#vd-msg')), `♻ Remake reproduces the final: seed ${ks(rm).seed}, steps ${ks(rm).steps}, ${lat(rm).width}×${lat(rm).height}, ${lat(rm).length} frames`);
    assert(!errors.length, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);

    console.log('\n== 🎞 the trailer: a recipe for the shots and the auto-judge switch ==');
    await c.click('#vd-sub-trailer');
    const trOpts = await c.$$eval('#vd-tr-recipe option', (o) => o.map((x) => x.textContent));
    assert(trOpts.some((x) => /Misty ferry — better/.test(x)) && trOpts.some((x) => /Wan 2\.1 1\.3B/.test(x)), 'the trailer\'s "Recipe for the shots" lists the video recipes');
    assert(!(await c.$eval('#vd-tr-judge', (b) => b.checked)), '"Judge and improve trailer shots automatically" is OFF by default');
    await c.click('#vd-tr-judge');
    await sleep(400);
    const js = await c.evaluate(() => window.api.video.judgeSettings());
    assert(js.ok && js.settings.autoTrailer === true, 'switching it on is saved');
    await c.click('#vd-tr-judge');
    await c.click('#vd-sub-make');
  } finally {
    await teardown(app);
    // the clips this test made (the app's videos/ folder is shared with the person's own videos: only files made since the start)
    if (videosDir) { try { for (const n of fs.readdirSync(videosDir)) { const p = path.join(videosDir, n); try { const s = fs.statSync(p); if (s.isFile() && s.mtimeMs >= t0 && /^(video|animate)-/.test(n)) fs.unlinkSync(p); } catch (_) {} } } catch (_) {} }
    await comfy.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  process.exit(state.failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
