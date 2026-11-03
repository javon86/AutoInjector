'use strict';
// media-selftest.e2e.js — the REAL app's 🩺 "Test pictures & video" (🎬 Video → 🩺 Test, and the button in
// 🎨 Images), no GPU: a fake Forge (fake-sd.js), a fake FramePack folder + the fake runner (it hands back a real,
// playable clip made with ffmpeg when ffmpeg is here), the real bridge on a free port.
//   1. ▶ Quick: every step listed with ✅/⚠️/❌/⏭; nothing is drawn; the report is saved (Markdown + JSON in logs).
//   2. ▶ Full with Forge failing (out of memory): the picture step is ❌ with its error + what to try, the run goes on —
//      FramePack loads (stage times, attention kernel), the tiny clip is made and plays in a hidden <video>, the tiny
//      trailer is joined and plays, ⏹ Stop works mid-clip, FramePack is unloaded; 📋 Copy report fills the clipboard;
//      📋 Extract carries the summary.
//   3. ▶ Full again and ⏹ Stop during the clip: the run ends, the rest is skipped, the report says so.
//   xvfb-run -a node test/e2e/media-selftest.e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const childProcess = require('child_process');
const { findWindow, makeAsserts, APP_DIR, SHOT_DIR } = require('./helpers');
const { fakeA1111 } = require('../fixtures/fake-sd');
const FF = require('../fixtures/fake-framepack');
const VT = require('../../video-trailer');

let electron;
try { electron = require('playwright')._electron; } catch (_) { console.error('needs playwright'); process.exit(2); }
function freePort() { return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }

async function main() {
  const { assert, state } = makeAsserts();
  const shotDir = process.env.SD_SHOT_DIR || SHOT_DIR;
  fs.mkdirSync(shotDir, { recursive: true });
  const shot = async (page, name) => { try { await page.screenshot({ path: path.join(shotDir, `${name}.png`) }); } catch (_) {} };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'media-selftest-e2e-'));
  const fpDir = FF.makeFramePackDir(path.join(tmp, 'StabilityMatrix', 'Data', 'Packages', 'FramePack'));
  FF.makeHfCache(path.join(fpDir, 'hf_download'));
  // a real 1-second clip for the fake runner to hand back (so the player check and the trailer can really play it)
  const ffmpeg = VT.findFfmpeg({ roots: [] });
  let clip = null;
  if (ffmpeg) {
    clip = path.join(tmp, 'clip.mp4');
    try { childProcess.execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip], { timeout: 60000 }); } catch (e) { clip = null; console.log(`  (ffmpeg could not make the test clip: ${e.message})`); }
  }
  const models = path.join(tmp, 'Models');
  const forge = await fakeA1111({ flavor: 'forge' });
  const bridgePort = await freePort();
  const userData = path.join(tmp, 'userdata');
  const t0 = Date.now() - 1000;
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', `--user-data-dir=${userData}`],
    cwd: APP_DIR,
    env: Object.assign({}, process.env, FF.runnerEnv({ stepMs: 700, loadMs: 150 }), clip ? { FAKE_FP_VIDEO: clip } : {}, {
      AUTOINJECTOR_FRAMEPACK: fpDir, AUTOINJECTOR_AKOWE_SERVER: '0', AUTOINJECTOR_SD_HOME: path.join(tmp, 'sdhome'), AUTOINJECTOR_SD_AUTOSTART: '0',
      AUTOINJECTOR_SD_MODEL_DIRS: models, AUTOINJECTOR_VIDEO_AUTOSTART: '0', AUTOINJECTOR_SD_GPU_CHECK: '0', AUTOINJECTOR_CONTENT_SCAN: '0',
      AUTOINJECTOR_BRIDGE_PORT: String(bridgePort), NVIDIA_SMI: path.join(tmp, 'no-nvidia-smi'),
    }),
  });
  let reportFiles = [];
  try {
    const c = await findWindow(app, '#tab-app-images', 40000);
    assert(!!c, 'the control panel is up');
    if (!c) throw new Error('no window');
    // connect the fake Forge (as a person would, in 🎨 Images)
    await c.click('#tab-app-images');
    await c.fill('#sd-url', forge.base);
    await c.click('#btn-sd-connect');
    await c.waitForFunction(() => /Connected to Forge/.test(document.getElementById('sd-status-text').textContent), null, { timeout: 15000 }).catch(() => {});
    assert(/Connected to Forge/.test(await c.textContent('#sd-status-text')), 'Forge (fake) is connected');
    assert(await c.isVisible('#btn-sd-mediatest'), '🎨 Images has the 🩺 Test pictures & video button');
    await c.click('#btn-sd-mediatest');
    await c.waitForSelector('#vd-view-selftest:not([hidden])', { timeout: 10000 }).catch(() => {});
    assert(await c.evaluate(() => !document.getElementById('video-tab').hidden && !document.getElementById('vd-view-selftest').hidden), '…it opens 🎬 Video → 🩺 Test pictures & video');
    await c.click('#vd-sub-make'); await c.click('#vd-sub-selftest');
    assert(await c.evaluate(() => !document.getElementById('vd-view-selftest').hidden && document.getElementById('vd-view-make').hidden), 'the 🩺 Test pictures & video tab button in 🎬 Video opens it too (sweep 2026-11: it did nothing)');

    // ---- 1. Quick
    console.log('\n== 1. ▶ Quick ==');
    const tq = Date.now();
    await c.click('#btn-mt-quick');
    await c.waitForFunction(() => /self-test \(Quick/.test(document.getElementById('mt-summary').textContent), null, { timeout: 60000 }).catch(() => {});
    const qSummary = await c.textContent('#mt-summary');
    assert(/Pictures & video self-test \(Quick/.test(qSummary) && Date.now() - tq < 40000, `Quick finished in ${Math.round((Date.now() - tq) / 1000)} s: ${qSummary}`);
    const qSteps = await c.$$eval('#mt-steps li', (l) => l.map((x) => ({ id: x.dataset.id, status: x.dataset.status, text: x.textContent })));
    const qs = (id) => qSteps.find((s) => s.id === id) || {};
    assert(qSteps.length >= 12 && qSteps.every((s) => ['pass', 'warn', 'fail', 'skip'].includes(s.status)), `every step has ✅/⚠️/❌/⏭ (${qSteps.length} steps)`);
    assert(qs('forge').status === 'pass' && qs('checkpoints').status === 'pass' && qs('locks').status === 'pass', 'Forge reachable, checkpoints and character locks listed');
    assert(qs('fp-found').status === 'pass' && qs('fp-python').status === 'pass', 'FramePack found, its Python and model files');
    assert(qs('bridge').status === 'pass' && qs('image-routes').status === 'pass', `Akọwe link: bridge + POST /image/request + POST /image/locks answer (${qs('image-routes').text.slice(0, 160)})`);
    assert(qs('alfred-tools').status === 'pass', `Alfred's picture/video tools are reachable (${qs('alfred-tools').text.slice(0, 160)})`);
    assert(qs('alfred-ai').status === 'warn' && /switched off/.test(qs('alfred-ai').text), 'Alfred off → ⚠️ in plain words');
    assert(!qSteps.some((s) => ['picture', 'clip', 'trailer'].includes(s.id)) && !forge.state.lastTxt2img, 'Quick: nothing was drawn');
    const st1 = await c.evaluate(() => window.api.mediaTest.status());
    reportFiles.push(st1.last.files.md, st1.last.files.json);
    assert(st1.last && /media-selftest-\d{8}-\d{6}\.md$/.test(st1.last.files.md) && fs.existsSync(st1.last.files.md) && fs.existsSync(st1.last.files.json), `the report is saved: ${path.basename(st1.last.files.md)} + .json`);
    assert(path.basename(path.dirname(st1.last.files.md)) === 'logs' && /stuff and thing/.test(st1.last.files.md), 'in "stuff and thing/logs"');
    const qJson = JSON.parse(fs.readFileSync(st1.last.files.json, 'utf8'));
    assert(qJson.kind === 'media-selftest' && qJson.mode === 'quick' && Array.isArray(qJson.steps) && qJson.steps.length === qSteps.length, 'the JSON report has every step');
    assert(!fs.readFileSync(st1.last.files.md, 'utf8').includes(os.homedir() + path.sep) || os.homedir() === '/', 'no private home paths in the report');
    await new Promise((r) => setTimeout(r, 800));
    const after = await c.evaluate(() => ({ quick: document.getElementById('btn-mt-quick').disabled, stop: document.getElementById('btn-mt-stop').disabled, prog: document.getElementById('mt-progress').textContent }));
    assert(!after.quick && after.stop && !/Running|Step \d/.test(after.prog), `after Quick: ▶ usable again, ⏹ off, no stale "Running…" (sweep 2026-11: “${after.prog}”)`);
    await shot(c, 'mediatest01-quick');

    // ---- 2. Full, with Forge failing
    console.log('\n== 2. ▶ Full (Forge out of memory) ==');
    forge.state.failWith = 'oom';
    const tf = Date.now();
    await c.click('#btn-mt-full');
    await c.waitForFunction(() => document.querySelector('#mt-steps li') && !document.getElementById('btn-mt-stop').disabled, null, { timeout: 10000 }).catch(() => {});
    assert(!(await c.$eval('#btn-mt-stop', (b) => b.disabled)) && await c.$eval('#btn-mt-full', (b) => b.disabled), 'while it runs: ⏹ Stop is on, ▶ is off');
    await c.waitForFunction(() => /self-test \(Full/.test(document.getElementById('mt-summary').textContent), null, { timeout: 240000 }).catch(() => {});
    const fSteps = await c.$$eval('#mt-steps li', (l) => l.map((x) => ({ id: x.dataset.id, status: x.dataset.status, text: x.textContent })));
    const fs_ = (id) => fSteps.find((s) => s.id === id) || {};
    console.log(`  (Full took ${Math.round((Date.now() - tf) / 1000)} s: ${await c.textContent('#mt-summary')})`);
    assert(fs_('picture').status === 'fail' && /Exact error: .*out of memory/i.test(fs_('picture').text) && /What to try:/.test(fs_('picture').text), `❌ the picture: its exact error and what to try (${fs_('picture').text.slice(0, 220)})`);
    assert(fs_('fp-load').status === 'pass' && /Stages: /.test(fs_('fp-load').text), `…and the run went on: FramePack loads, with stage times (${fs_('fp-load').text.slice(0, 200)})`);
    assert(fs_('attention').status === 'pass' && /Uses pytorch-sdpa/.test(fs_('attention').text), 'the attention kernel it uses');
    assert(fs_('clip').status === 'pass' && /settings file and poster/.test(fs_('clip').text), `the tiny clip: file + settings + poster (${fs_('clip').text.slice(0, 200)})`);
    if (clip) {
      assert(fs_('playable').status === 'pass' && /Plays: 1\.\d+ s, 320×240/.test(fs_('playable').text), `the clip really plays in a hidden <video> (${fs_('playable').text.slice(0, 120)})`);
      assert(fs_('trailer').status === 'pass' && fs_('trailer-plays').status === 'pass' && /\.webm \d/.test(fs_('trailer-plays').text), `the tiny trailer is joined and plays (${fs_('trailer-plays').text.slice(0, 160)})`);
      assert(/\.mp4 \d/.test(fs_('trailer-plays').text), 'ffmpeg is here → the trailer .mp4 plays too');
    } else console.log('  (no ffmpeg: the clip stub does not play — the player and trailer checks are not judged)');
    assert(fs_('gpu-peak').status === 'skip', 'no nvidia-smi here → the graphics-memory peak is skipped, said so');
    assert(fs_('stop-works').status === 'pass' && /Stopped .* after ⏹ Stop/.test(fs_('stop-works').text), `⏹ Stop works mid-clip (${fs_('stop-works').text.slice(0, 160)})`);
    assert(fs_('unload').status === 'pass' && /no FramePack Python left running/.test(fs_('unload').text), 'FramePack unloaded, no Python left running');
    const fpst = await c.evaluate(() => window.api.video.framepackStatus(false));
    assert(fpst && !fpst.running && !fpst.loaded, 'FramePack is really not running afterwards');
    const st2 = await c.evaluate(() => window.api.mediaTest.status());
    reportFiles.push(st2.last.files.md, st2.last.files.json);
    const md = fs.readFileSync(st2.last.files.md, 'utf8');
    assert(/## What to try/.test(md) && /❌ One tiny picture/.test(md), 'the saved Markdown has the ❌ with what to try');
    await c.click('#btn-mt-copy');
    await c.waitForFunction(() => /Copied/.test(document.getElementById('mt-msg').textContent), null, { timeout: 5000 }).catch(() => {});
    const clipText = await app.evaluate(({ clipboard }) => clipboard.readText());
    assert(/# 🩺 AutoInjector — pictures & video self-test \(Full\)/.test(clipText) && /What to try/.test(clipText), '📋 Copy report → the whole report is on the clipboard');
    const ex = await c.evaluate(() => window.api.extractPreview({ scope: 'time', preset: 'day', include: { conversation: false, relay: false, activity: false } }));
    const exText = ex && ex.ok ? ex.preview : '';
    const full = await c.evaluate(() => window.api.extractAllLogs({ scope: 'time', preset: 'day' }));
    let exFile = '';
    try { exFile = fs.readFileSync(full.file, 'utf8'); reportFiles.push(full.file); } catch (_) {}
    assert(/LATEST 🩺 PICTURES & VIDEO SELF-TEST/.test(exFile) && /self-test \(Full/.test(exFile) && /One tiny picture/.test(exFile), '📋 Extract (last 24 h) carries the latest self-test summary and its ❌ steps');
    void exText;
    await shot(c, 'mediatest02-full');

    // ---- 3. ⏹ Stop in the middle
    console.log('\n== 3. ⏹ Stop mid-run ==');
    forge.state.failWith = null;
    await c.click('#btn-mt-full');
    await c.waitForFunction(() => [...document.querySelectorAll('#mt-steps li')].some((x) => x.dataset.id === 'clip' && x.dataset.status === 'running'), null, { timeout: 120000 }).catch(() => {});
    const ts = Date.now();
    await c.click('#btn-mt-stop');
    await c.waitForFunction(() => /stopped early/.test(document.getElementById('mt-summary').textContent), null, { timeout: 30000 }).catch(() => {});
    const sSteps = await c.$$eval('#mt-steps li', (l) => l.map((x) => ({ id: x.dataset.id, status: x.dataset.status, text: x.textContent })));
    const ss = (id) => sSteps.find((s) => s.id === id) || {};
    assert(/stopped early/.test(await c.textContent('#mt-summary')) && Date.now() - ts < 20000, `⏹ Stop ends the run quickly (${Math.round((Date.now() - ts) / 1000)} s)`);
    console.log(`  (after Stop: ${sSteps.map((x) => `${x.id}:${x.status}`).join(' ')})`);
    // the step that was running when ⏹ Stop was pressed (the clip, unless the click landed just as it ended)
    const at = sSteps.findIndex((x) => x.status === 'skip' && /Stopped by you during this step/.test(x.text));
    assert(at >= 0 && ['clip', 'playable', 'gpu-peak', 'trailer'].includes(sSteps[at].id) && sSteps.slice(at + 1).every((x) => x.status === 'skip' && /pressed Stop/.test(x.text)) && ss('bridge').status === 'skip', `the running step (${at >= 0 ? sSteps[at].id : 'none'}): stopped by you; the later steps: not run`);
    assert(ss('picture').status === 'pass', 'the steps before the Stop kept their results (the picture, Forge working again)');
    const st3 = await c.evaluate(() => window.api.mediaTest.status());
    reportFiles.push(st3.last.files.md, st3.last.files.json);
    assert(st3.last.stopped && fs.existsSync(st3.last.files.md) && /stopped by you/.test(fs.readFileSync(st3.last.files.md, 'utf8')), 'the report is still saved and says it was stopped');
    await capped('wait until video is idle', c.waitForFunction(async () => { const s = await window.api.video.progress(); return !s.busy; }, null, { timeout: 30000, polling: 500 }), 35000);
    await capped('unload FramePack', c.evaluate(() => window.api.video.framepackUnload()), 15000);
    await capped('screenshot', shot(c, 'mediatest03-stopped'), 15000);
  } finally {
    // A CI run hung here for 10 minutes after the last check (PR #105); every teardown step is capped and named,
    // and the app is force-killed if it won't quit, so a hang fails fast and says where.
    const ok = await capped('close the app', app.close(), 20000);
    if (!ok) { try { const pr = app.process && app.process(); if (pr && pr.pid) process.kill(pr.pid, 'SIGKILL'); } catch (_) {} }
    try { forge.close && forge.close(); } catch (_) {}
    // what the test made in "stuff and thing": its reports, the picture, the clips and the self-test trailer
    for (const f of reportFiles) { try { if (f && fs.statSync(f).mtimeMs >= t0) fs.unlinkSync(f); } catch (_) {} }
    const stuff = path.join(APP_DIR, '..', 'stuff and thing');
    for (const sub of ['images', 'videos', path.join('videos', 'trailers', 'media-selftest')]) {
      const dir = path.join(stuff, sub);
      try { for (const n of fs.readdirSync(dir)) { const p = path.join(dir, n); try { if (fs.statSync(p).isFile() && fs.statSync(p).mtimeMs >= t0 && /^(sd-|img-|test-|animate-|video-|selftest-trailer-)|\.(png|json|mp4|webm)$/.test(n)) fs.unlinkSync(p); } catch (_) {} } } catch (_) {}
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  process.exit(state.failed ? 1 : 0);
}
async function capped(what, p, ms) {
  let t = null;
  const r = await Promise.race([Promise.resolve(p).then(() => true, () => true), new Promise((res) => { t = setTimeout(() => res(false), ms); })]);
  clearTimeout(t);
  if (!r) console.log(`  (teardown: "${what}" did not finish in ${Math.round(ms / 1000)} s — carried on)`);
  return r;
}
// whole-test watchdog: never eat the CI job's time limit silently
setTimeout(() => { console.error('media-selftest e2e: still running after 6 minutes — exiting'); process.exit(1); }, 6 * 60000).unref();
main().catch((e) => { console.error(e); process.exit(1); });
