'use strict';
// trailer.e2e.js — 🎞 book trailers in the REAL app: the canvas + MediaRecorder join in a real (hidden, offscreen)
// Electron window. A fake ComfyUI serves two real, tiny clips; the 🎬 Video tab's 🎞 Trailer section is filled in
// (2 shots of 1 s + 1 title card of 1 s), Make trailer renders both shots through the video engine and joins them
// → a playable trailer.webm whose length is 3 s ± 0.5 (read from the file's frames AND by the <video> player),
// and trailer.mp4 when ffmpeg is on this PC. The two clips are made by ffmpeg when it is here, else by the app's
// own recorder (a title-card-only trailer). Screenshot: ../shots/video-trailer.png (TRAILER_SHOT_DIR to change).
//   xvfb-run -a node test/e2e/trailer.e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { findWindow, makeAsserts, APP_DIR } = require('./helpers');
const { fakeComfy } = require('../fixtures/fake-sd');
const W = require('../../webm-tools');
const VT = require('../../video-trailer');

let electron;
try { electron = require('playwright')._electron; } catch (_) { console.error('needs playwright'); process.exit(2); }

async function main() {
  const { assert, state } = makeAsserts();
  const shotDir = process.env.TRAILER_SHOT_DIR || path.join(APP_DIR, '..', 'shots');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trailer-e2e-'));
  const ffmpeg = VT.findFfmpeg({ roots: [] }); // AUTOINJECTOR_FFMPEG=none runs the no-ffmpeg path (clips by the app, .webm only)
  // two real clips (1 s each): ffmpeg's test patterns, or (no ffmpeg) recorded by the app itself below
  const clips = [];
  if (ffmpeg) {
    for (const [i, src] of [['a', 'testsrc=size=320x180:rate=24'], ['b', 'testsrc2=size=320x180:rate=24']]) {
      const out = path.join(tmp, `${i}.webm`);
      childProcess.execFileSync(ffmpeg, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', src, '-t', '1', '-c:v', 'libvpx', '-b:v', '400k', out]);
      clips.push(fs.readFileSync(out));
    }
  }
  const comfy = await fakeComfy({ videoPolls: 2, noSaveVideo: true, clip: (n) => clips[(n - 1) % 2] || null });
  const userData = path.join(tmp, 'userdata');
  const book = `E2E Trailer ${Date.now().toString(36)}`;
  const made = []; // folders to remove afterwards
  const t0 = Date.now() - 1000;
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', `--user-data-dir=${userData}`],
    cwd: APP_DIR,
    env: Object.assign({}, process.env, { AUTOINJECTOR_AKOWE_SERVER: '0', AUTOINJECTOR_SD_HOME: path.join(tmp, 'sdhome'), AUTOINJECTOR_SD_AUTOSTART: '0', AUTOINJECTOR_VIDEO_AUTOSTART: '0', AUTOINJECTOR_VIDEO_POLL_MS: '150' }),
  });
  let videosDir = null;
  try {
    const c = await findWindow(app, '#tab-app-video', 40000);
    assert(!!c, 'the control panel shows the 🎬 Video tab');
    if (!c) throw new Error('no window');
    const s = await c.evaluate((base) => window.api.video.settings({ comfyUrl: base }), comfy.base);
    assert(s && s.ok, 'the (fake) ComfyUI address is saved');
    if (!clips.length) {
      // no ffmpeg here: two clips recorded by the app's own recorder (title cards only, no video engine needed)
      for (const t of ['A', 'B']) {
        const r = await c.evaluate((b) => window.api.video.trailerMake(b), { book: `${book} clip ${t}`, items: [{ type: 'card', text: `Clip ${t}`, seconds: 1 }], fade: 0, width: 320, height: 180, mp4: false });
        let st = null;
        for (let i = 0; i < 120 && r.ok; i++) { st = await c.evaluate(() => window.api.video.trailerStatus()); if (st && st.status && !st.status.busy) break; await new Promise((x) => setTimeout(x, 250)); }
        assert(st && st.result && st.result.ok, `clip ${t} recorded by the app (no ffmpeg on this PC)`);
        clips.push(fs.readFileSync(st.result.path));
        made.push(path.dirname(st.result.path));
      }
    }

    await c.click('#tab-app-video');
    await c.waitForSelector('#video-tab:not([hidden])', { timeout: 10000 });
    await c.click('#vd-sub-trailer');
    await c.waitForSelector('#vd-view-trailer:not([hidden])', { timeout: 10000 });
    await c.waitForFunction(() => document.querySelectorAll('#vd-tr-items .vd-tr-item').length === 5, null, { timeout: 10000 }).catch(() => {});
    assert((await c.$$('#vd-tr-items .vd-tr-item')).length === 5 && !(await c.$eval('#vd-view-make', (e) => !e.hidden)), 'the 🎞 Trailer section opens with a starting plan (title card, 3 shots, closing card)');
    // the plan: shot, shot, card — 1 s each
    await c.fill('#vd-tr-book', book);
    await c.click('#vd-tr-items .vd-tr-item:nth-child(1) .vd-tr-remove'); // the opening card
    await c.click('#vd-tr-items .vd-tr-item:nth-child(3) .vd-tr-remove'); // the third shot
    assert((await c.$$('#vd-tr-items .vd-tr-item')).length === 3 && (await c.$$eval('#vd-tr-items .vd-tr-item', (els) => els.map((e) => e.dataset.type).join(','))) === 'shot,shot,card', 'removing parts: shot, shot, card');
    const prompts = await c.$$('#vd-tr-items .vd-tr-prompt');
    await prompts[0].fill('a ferry leaves the harbour at dawn');
    await prompts[1].fill('waves break over the bow');
    await c.fill('#vd-tr-items .vd-tr-item:nth-child(3) .vd-tr-text', book);
    await c.fill('#vd-tr-items .vd-tr-item:nth-child(3) .vd-tr-subtitle', 'Coming soon');
    for (const sec of await c.$$('#vd-tr-items .vd-tr-seconds')) await sec.fill('1');
    // move the card up and back down (reorder)
    await c.click('#vd-tr-items .vd-tr-item:nth-child(3) button[title="Move up"]');
    assert((await c.$$eval('#vd-tr-items .vd-tr-item', (els) => els.map((e) => e.dataset.type).join(','))) === 'shot,card,shot', 'reorder: ↑ moves the card up');
    await c.click('#vd-tr-items .vd-tr-item:nth-child(2) button[title="Move down"]');
    assert(/2 shot\(s\), 1 card\(s\) · 3 s in all/.test(await c.textContent('#vd-tr-total')), `the plan adds up: "${await c.textContent('#vd-tr-total')}"`);
    await c.selectOption('#vd-tr-size', '854x480');
    await c.fill('#vd-tr-fade', '0.2');
    const g0 = comfy.state.videoGraphs.length;
    await c.click('#btn-vd-tr-make');
    await c.waitForFunction(() => !document.getElementById('btn-vd-tr-stop').disabled, null, { timeout: 10000 }).catch(() => {});
    assert(!(await c.$eval('#btn-vd-tr-stop', (b) => b.disabled)) && /Making the trailer/.test(await c.textContent('#btn-vd-tr-make')), 'while it runs: Stop is enabled');
    await c.waitForFunction(() => /Trailer saved/.test(document.getElementById('vd-tr-msg').textContent) || !document.getElementById('vd-tr-error').hidden, null, { timeout: 90000 }).catch(() => {});
    const msg = await c.textContent('#vd-tr-msg');
    assert(/✔ Trailer saved: \d/.test(msg), `done: "${msg.split('\n')[0]}"${(await c.$eval('#vd-tr-error', (e) => e.hidden)) ? '' : ` — error: ${await c.textContent('#vd-tr-error')}`}`);
    assert(comfy.state.videoGraphs.length === g0 + 2 && /a ferry leaves the harbour/.test(JSON.stringify(comfy.state.videoGraphs[g0])) && /waves break/.test(JSON.stringify(comfy.state.videoGraphs[g0 + 1])), 'both shots went through the video engine (two Wan graphs, in order)');
    assert(await c.$$eval('#vd-tr-items .vd-tr-item', (els) => els.filter((e) => e.dataset.type === 'shot').every((e) => e.dataset.status === 'done')), 'each shot shows ✔ made');
    // the file
    const src = await c.getAttribute('#vd-tr-player', 'src');
    const file = decodeURIComponent(new URL(src).pathname).replace(/^\/([A-Za-z]:)/, '$1');
    made.push(path.dirname(file));
    videosDir = path.dirname(path.dirname(path.dirname(file)));
    assert(fs.existsSync(file) && path.basename(file) === 'trailer.webm' && path.basename(path.dirname(file)) === book && path.basename(path.dirname(path.dirname(file))) === 'trailers', 'saved as videos/trailers/<book>/trailer.webm');
    const buf = fs.readFileSync(file);
    const pr = W.probeWebm(buf);
    assert(pr.ok && pr.tracks.some((t) => t.type === 'video' && /V_VP[89]/.test(t.codec)), `a WebM with a VP9/VP8 video track (${pr.tracks.map((t) => t.codec).join(', ')})`);
    assert(pr.durationMs != null && Math.abs(pr.durationMs - 3000) <= 500, `its header says ${pr.durationMs} ms (3 s ± 0.5)`);
    assert(Math.abs(pr.lastMs - 3000) <= 500 && pr.blocks >= 40, `its frames run to ${pr.lastMs} ms (${pr.blocks} frames) — 3 s ± 0.5`);
    // the player plays it and knows its length
    const pl = await c.evaluate(() => new Promise((resolve) => {
      const v = document.getElementById('vd-tr-player');
      const done = () => resolve({ duration: v.duration, w: v.videoWidth, h: v.videoHeight, ready: v.readyState });
      if (v.readyState >= 1) done(); else { v.addEventListener('loadedmetadata', done, { once: true }); v.addEventListener('error', () => resolve({ error: v.error && v.error.code }), { once: true }); }
      setTimeout(() => resolve({ timeout: true, duration: v.duration }), 8000);
    }));
    assert(pl && Number.isFinite(pl.duration) && Math.abs(pl.duration - 3) <= 0.5 && pl.w === 854 && pl.h === 480, `the <video> player loads it: ${pl && pl.duration} s, ${pl && pl.w}×${pl && pl.h}`);
    const frames = await c.evaluate(() => new Promise((resolve) => {
      const v = document.getElementById('vd-tr-player'); v.muted = true;
      const cv = document.createElement('canvas'); cv.width = 64; cv.height = 36; const g = cv.getContext('2d');
      const at = [0.5, 1.5, 2.5]; const out = [];
      const next = () => {
        if (!at.length) { resolve(out); return; }
        const t = at.shift();
        v.addEventListener('seeked', () => { g.drawImage(v, 0, 0, 64, 36); const d = g.getImageData(0, 0, 64, 36).data; let sum = 0; let sat = 0; for (let i = 0; i < d.length; i += 4) { sum += d[i] + d[i + 1] + d[i + 2]; sat += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]); } out.push({ t, mean: sum / (d.length / 4) / 3, sat: sat / (d.length / 4) }); next(); }, { once: true });
        v.currentTime = t;
      };
      next();
      setTimeout(() => resolve(out), 8000);
    }));
    if (ffmpeg) assert(frames.length === 3 && frames[0].sat > 40 && frames[1].sat > 40 && frames[2].sat < 15 && frames[2].mean < 60, `the frames: two colourful clips, then the dark title card (${frames.map((f) => `${f.t}s mean ${Math.round(f.mean)} sat ${Math.round(f.sat)}`).join('; ')})`);
    else assert(frames.length === 3, 'the player seeks through it (clip, clip, card)');
    const mp4 = path.join(path.dirname(file), 'trailer.mp4');
    if (ffmpeg) {
      assert(fs.existsSync(mp4) && /\.mp4/.test(msg), 'ffmpeg is on this PC → trailer.mp4 too');
      const probe = childProcess.spawnSync(ffmpeg, ['-hide_banner', '-i', mp4], { encoding: 'utf8' }).stderr || '';
      const m = probe.match(/Duration: (\d+):(\d+):([\d.]+)/);
      const secs = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : -1;
      assert(/Video: h264/.test(probe) && Math.abs(secs - 3) <= 0.5, `trailer.mp4 is H.264, ${secs} s`);
    } else assert(!fs.existsSync(mp4) && /No ffmpeg/.test(msg), 'no ffmpeg → only the .webm, and the message says so');
    assert(fs.existsSync(path.join(path.dirname(file), 'trailer.json')) && fs.readdirSync(path.join(path.dirname(file), 'shots')).filter((x) => /\.(webm|mp4)$/.test(x)).length === 2, 'trailer.json and the two shots are kept with it');
    await c.waitForFunction((b) => [...document.querySelectorAll('#vd-tr-list .vd-tr-saved')].some((e) => e.textContent.includes(b)), book, { timeout: 5000 }).catch(() => {});
    assert(await c.evaluate((b) => [...document.querySelectorAll('#vd-tr-list .vd-tr-saved')].some((e) => e.textContent.includes(b)), book), 'it is listed under Saved trailers');
    try { fs.mkdirSync(shotDir, { recursive: true }); await c.evaluate(() => { const v = document.getElementById('vd-tr-player'); v.currentTime = 2.5; }); await new Promise((r) => setTimeout(r, 400)); await c.screenshot({ path: path.join(shotDir, 'video-trailer.png') }); } catch (_) {}
    // resume: make it again → nothing is rendered again
    await c.click('#btn-vd-tr-make');
    await c.waitForFunction(() => /Trailer saved/.test(document.getElementById('vd-tr-msg').textContent) && !document.getElementById('btn-vd-tr-make').disabled, null, { timeout: 60000 }).catch(() => {});
    assert(/2 shot\(s\) kept from before/.test(await c.textContent('#vd-tr-msg')) && comfy.state.videoGraphs.length === g0 + 2, 'Make trailer again: both shots are kept from before (nothing re-rendered)');
  } finally {
    await app.close().catch(() => {});
    await comfy.close();
    for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
    // the shots this run made in videos/ (the content folder is the app's own)
    if (videosDir) { try { for (const n of fs.readdirSync(videosDir)) { const p = path.join(videosDir, n); if (/^trailer-shot-.*\.(mp4|webm|png|json)$/.test(n) && fs.statSync(p).mtimeMs >= t0) fs.unlinkSync(p); } } catch (_) {} }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  process.exit(state.failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
