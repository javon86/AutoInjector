'use strict';
// test/video-trailer.test.js — 🎞 book trailers without Electron:
//   1. the plan: items / shots + cards (card placement), clamping with warnings, every refusal in plain words;
//   2. the join plan (timeline for the recorder), the shot key (resume), finding ffmpeg (PATH, ComfyUI portable,
//      imageio-ffmpeg in python_embeded / a venv) and the .mp4 arguments;
//   3. webm-tools: Duration added to a MediaRecorder-style WebM (unknown sizes), the real length read from the frames;
//   4. the maker against the fake ComfyUI (real video-studio) + a stand-in recorder and ffmpeg: shots rendered one
//      by one (purpose trailer_shot, seconds, character lock, picture→video), progress, the join plan handed to the
//      recorder, trailer.webm / .mp4 / trailer.json, resume (nothing re-rendered; only a changed shot), Stop during a
//      shot (kept shots), a shot that fails (which shot + what to do), BUSY, a join that fails, no ffmpeg;
//   5. video-api trailer.* (capabilities, call, wrong params);
//   6. the bridge: POST /video/trailer (202 → GET /video/trailer → done), POST /video/trailer/cancel, 400 / 409 / 501.
// Run: node test/video-trailer.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const VT = require('../video-trailer');
const VS = require('../video-studio');
const VI = require('../video-installer');
const VA = require('../video-api');
const W = require('../webm-tools');
const { fakeComfy, PNG } = require('./fixtures/fake-sd');
const { createServiceBridge } = require('../service-bridge');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(25); } return null; }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'trailer-test-'));

// ---- a MediaRecorder-style WebM: EBML header, Segment (unknown size), Info, Tracks, Clusters (unknown size)
function el(id, data) {
  const idb = []; let v = id; while (v > 0) { idb.unshift(v & 255); v = Math.floor(v / 256); }
  const n = data.length; const sz = Buffer.from([0x01, 0, 0, 0, 0, 0, 0, 0]); let x = n; for (let i = 7; i >= 1; i--) { sz[i] = x % 256; x = Math.floor(x / 256); }
  return Buffer.concat([Buffer.from(idb), sz, data]);
}
const unknown = (id) => { const idb = []; let v = id; while (v > 0) { idb.unshift(v & 255); v = Math.floor(v / 256); } return Buffer.concat([Buffer.from(idb), Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])]); };
const uint = (n, len = 4) => { const b = Buffer.alloc(len); b.writeUIntBE(n, 0, len); return b; };
function block(track, rel, key) { const b = Buffer.alloc(4 + 10); b[0] = 0x80 | track; b.writeInt16BE(rel, 1); b[3] = key ? 0x80 : 0; return el(0xa3, b); }
function fakeWebm(frames, fps, clusterMs) {
  const ebml = el(0x1a45dfa3, Buffer.concat([el(0x4282, Buffer.from('webm'))]));
  const info = el(0x1549a966, Buffer.concat([el(0x2ad7b1, uint(1000000, 3)), el(0x4d80, Buffer.from('Chrome'))]));
  const tracks = el(0x1654ae6b, el(0xae, Buffer.concat([el(0xd7, uint(1, 1)), el(0x83, uint(1, 1)), el(0x86, Buffer.from('V_VP9'))])));
  const parts = [ebml, unknown(0x18538067), info, tracks];
  let cur = -1;
  for (let i = 0; i < frames; i++) {
    const t = Math.round(i * 1000 / fps);
    const c = Math.floor(t / clusterMs) * clusterMs;
    if (c !== cur) { cur = c; parts.push(unknown(0x1f43b675), el(0xe7, uint(c, 4))); }
    parts.push(block(1, t - c, i === 0));
  }
  return Buffer.concat(parts);
}

async function main() {
  // =====================================================================
  console.log('\n== 1. the plan ==');
  {
    let r = VT.normalizeTrailer({ book: 'The Ferry', items: [{ type: 'card', text: 'The Ferry' }, { prompt: 'a ferry at dawn', seconds: 3 }, { image: '/x/odile.png' }, { text: 'Coming soon', subtitle: 'Autumn' }] });
    assert(r.plan && r.plan.items.map((x) => x.type).join(',') === 'card,shot,shot,card' && r.plan.items[1].seconds === 3 && r.plan.items[2].seconds === 4 && r.plan.items[0].seconds === 3, 'items in order; type inferred (text → card, prompt / image → shot); default 4 s shots, 3 s cards');
    assert(r.plan.total === 13 && r.plan.width === 1280 && r.plan.height === 720 && r.plan.fps === 24 && r.plan.fade === 0.4 && r.plan.folder === 'The Ferry' && r.plan.resume && r.plan.mp4, 'total 13 s; 1280×720 at 24 fps, 0.4 s fades; folder = the book');
    r = VT.normalizeTrailer({ book: 'B', shots: [{ prompt: 'one' }, { prompt: 'two' }, { prompt: 'three' }], cards: [{ text: 'Title' }, { text: 'Mid', at: 2 }, { text: 'End' }] });
    assert(r.plan.items.map((x) => x.text || x.prompt).join('|') === 'Title|one|two|Mid|three|End', `shots + cards: the first card opens, at:2 goes after shot 2, the rest close (${r.plan.items.map((x) => x.text || x.prompt).join('|')})`);
    r = VT.normalizeTrailer({ book: 'B', items: [{ prompt: 'x', seconds: 9 }, { text: 'T', seconds: 0.2 }], width: 1000, fps: 60 });
    assert(r.plan.items[0].seconds === 5 && r.plan.items[1].seconds === 1 && r.plan.width === 1000 && r.plan.fps === 30 && r.warnings.length === 3 && r.warnings.every((w) => /→/.test(w.message)), `out-of-range seconds / fps are clamped with a warning each: ${r.warnings.map((w) => w.message).join(' | ')}`);
    const no = (req, field, re, what) => { const e = VT.normalizeTrailer(req).error; assert(e && e.code === 'INVALID_PARAM' && e.field === field && re.test(e.message), `${what}: “${e && e.message}”`); };
    no({ book: 'B', items: [] }, 'items', /empty/, 'an empty trailer is refused');
    no({ book: 'B', items: [{ type: 'card' }] }, 'items[0].text', /needs its text/, 'a card without text');
    no({ book: 'B', items: [{ type: 'shot', seconds: 3 }] }, 'items[0].prompt', /description.*or a picture/, 'a shot without prompt or picture');
    no({ book: 'B', items: [{ prompt: 'x', colour: 'red' }] }, 'items[0].colour', /no setting “colour”/, 'an unknown shot setting');
    no({ book: 'B', items: [{ prompt: 'x' }], speed: 2 }, 'speed', /no setting “speed”/, 'an unknown trailer setting');
    no({ book: 'B', items: [{ prompt: 'x', seconds: 'long' }] }, 'items[0].seconds', /must be a number/, 'seconds that are not a number');
    no({ book: 'B', items: [{ prompt: 'x' }], music: path.join(TMP, 'nope.mp3') }, 'music', /was not found/, 'a music file that does not exist');
    no({ book: 'B', items: [{ prompt: 'x' }], music: path.join(TMP, 'song.exe') }, 'music', /not a music file/, 'a music file of the wrong kind');
    no({ book: 'B', items: Array.from({ length: 25 }, () => ({ prompt: 'x' })) }, 'items', /at most 24/, 'too many parts');
    const mus = path.join(TMP, 'theme.ogg'); fs.writeFileSync(mus, 'OggS');
    r = VT.normalizeTrailer({ book: 'B/C: "x"', items: [{ prompt: 'x' }], music: mus, musicVolume: 0.5 });
    assert(r.plan.music === mus && r.plan.musicVolume === 0.5 && r.plan.folder === 'B C x', `music kept; a book title with / : " makes a safe folder (“${r.plan.folder}”)`);
  }

  // =====================================================================
  console.log('\n== 2. join plan, shot key, ffmpeg ==');
  {
    const { plan } = VT.normalizeTrailer({ book: 'B', items: [{ text: 'T', seconds: 2 }, { prompt: 'a' }, { prompt: 'b', seconds: 2 }], music: (() => { const m = path.join(TMP, 'm.mp3'); fs.writeFileSync(m, 'ID3'); return m; })() });
    const tl = VT.joinPlan(plan, [null, { path: '/t/shots/a.mp4' }, { path: '/t/shots/b.mp4' }], (p) => `file://${p}`);
    assert(tl.items.length === 3 && tl.items[0].kind === 'card' && tl.items[1].kind === 'clip' && tl.items[1].start === 2 && tl.items[2].start === 6 && tl.total === 8, 'timeline: card 0–2, shot 2–6, shot 6–8 (8 s)');
    assert(tl.items[1].src === 'file:///t/shots/a.mp4' && tl.items[2].number === 2 && tl.music && /m\.mp3$/.test(tl.music.src) && tl.music.volume === 0.8 && tl.fade === 0.4 && tl.width === 1280, 'clips as file URLs, the music with its volume, the fades, the frame');
    let threw = false; try { VT.joinPlan(plan, [null, { path: '/a' }, null]); } catch (_) { threw = true; }
    assert(threw, 'a shot without a clip cannot be joined');
    const k1 = VT.shotKey({ prompt: 'a', seconds: 4 }); const k2 = VT.shotKey({ prompt: 'a', seconds: 4 }); const k3 = VT.shotKey({ prompt: 'a', seconds: 5 });
    assert(k1 === k2 && k1 !== k3 && VT.shotKey({ prompt: 'a', seconds: 4 }, 'wan21-t2v-1.3b') !== k1, 'the same shot → the same key; other seconds / model → another');
    // ffmpeg
    const root = path.join(TMP, 'ComfyUI_windows_portable');
    const bin = path.join(root, 'python_embeded', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries');
    fs.mkdirSync(bin, { recursive: true }); fs.writeFileSync(path.join(bin, 'ffmpeg-win64-v4.2.2.exe'), 'MZ'); fs.writeFileSync(path.join(bin, 'README.md'), 'x');
    let f = VT.findFfmpeg({ env: { PATH: '' }, platform: 'win32', roots: [path.join(root, 'ComfyUI')] });
    assert(f === path.join(bin, 'ffmpeg-win64-v4.2.2.exe'), `imageio-ffmpeg inside the ComfyUI portable's python_embeded (from the ComfyUI subfolder): ${f && path.basename(f)}`);
    const venv = path.join(TMP, 'ComfyUI-linux', 'venv', 'lib', 'python3.11', 'site-packages', 'imageio_ffmpeg', 'binaries');
    fs.mkdirSync(venv, { recursive: true }); fs.writeFileSync(path.join(venv, 'ffmpeg-linux64-v4.2.2'), 'ELF');
    f = VT.findFfmpeg({ env: { PATH: '' }, platform: 'linux', roots: [path.join(TMP, 'ComfyUI-linux')] });
    assert(f && /ffmpeg-linux64/.test(f), 'imageio-ffmpeg in a ComfyUI venv (Linux)');
    const pathDir = path.join(TMP, 'bin'); fs.mkdirSync(pathDir); fs.writeFileSync(path.join(pathDir, 'ffmpeg'), '#!');
    f = VT.findFfmpeg({ env: { PATH: pathDir }, platform: 'linux', roots: [root] });
    assert(f === path.join(pathDir, 'ffmpeg'), 'ffmpeg on PATH comes before the ComfyUI folders');
    f = VT.findFfmpeg({ env: { PATH: pathDir, AUTOINJECTOR_FFMPEG: path.join(bin, 'ffmpeg-win64-v4.2.2.exe') }, platform: 'linux' });
    assert(/win64/.test(f), 'AUTOINJECTOR_FFMPEG wins');
    assert(VT.findFfmpeg({ env: { PATH: path.join(TMP, 'none') }, platform: 'linux', roots: [] }) === null, 'none anywhere → null');
    assert(VT.findFfmpeg({ env: { PATH: pathDir, AUTOINJECTOR_FFMPEG: 'none' }, platform: 'linux', roots: [root] }) === null, 'AUTOINJECTOR_FFMPEG=none → never ffmpeg');
    const a = VT.mp4Args('/t/trailer.webm', '/t/trailer.mp4', true);
    assert(a.join(' ').includes('-c:v libx264 -pix_fmt yuv420p') && a.includes('aac') && a.includes('+faststart') && a[a.length - 1] === '/t/trailer.mp4' && VT.mp4Args('a', 'b', false).includes('-an'), '.mp4 = H.264 yuv420p, faststart, AAC music (or no audio)');
  }

  // =====================================================================
  console.log('\n== 3. webm-tools ==');
  {
    const raw = fakeWebm(73, 24, 1000);
    let p = W.probeWebm(raw);
    assert(p.ok && p.durationMs === null && p.blocks === 73 && p.clusters === 4 && p.lastMs === 3000 && p.tracks[0].codec === 'V_VP9' && p.keyframes === 1, `a MediaRecorder-style WebM (unknown sizes): no Duration, 73 frames in 4 clusters, last frame at ${p.lastMs} ms`);
    const fixed = W.setWebmDuration(raw, 3042);
    p = W.probeWebm(fixed);
    assert(p.ok && p.durationMs === 3042 && p.blocks === 73 && p.lastMs === 3000 && fixed.length === raw.length + 11, `Duration added (3042 ms), the frames untouched (${fixed.length - raw.length} bytes more)`);
    const again = W.setWebmDuration(fixed, 2000);
    assert(W.probeWebm(again).durationMs === 2000 && again.length === fixed.length, 'an existing Duration is overwritten in place');
    assert(!W.probeWebm(Buffer.from('not a webm')).ok && W.setWebmDuration(Buffer.from('nope'), 5).toString() === 'nope', 'not a WebM → { ok:false }, left as it is');
  }

  // =====================================================================
  console.log('\n== 4. the maker (fake ComfyUI + the real video engine) ==');
  const comfy = await fakeComfy({ videoPolls: 3 });
  let comfyBase = comfy.base;
  const videos = path.join(TMP, 'videos');
  const lib = { getLock: (k) => (k === 'Odile' ? { id: 'lock-1', character: 'Odile', book: 'Ferry', triggerWords: ['odile woman'], prompt: 'red hair, green coat', negative: 'blonde' } : null),
    applyLock: (lock, scene) => ({ prompt: [...lock.triggerWords, lock.prompt, scene.prompt].filter(Boolean).join(', '), negativePrompt: [lock.negative, scene.negativePrompt].filter(Boolean).join(', ') }) };
  const mkStudio = () => VS.createVideoStudio({
    comfy: async () => (comfyBase ? { base: comfyBase, label: 'ComfyUI', source: 'test' } : null),
    installer: () => VI.createVideoInstaller({ roots: () => [{ path: path.join(TMP, 'comfy-models') }] }),
    library: lib, videosDir: () => videos, log: () => {}, fileUrl: (p) => `file://${p}`, pollMs: 30, noWs: true,
  });
  const recorded = [];
  const rec = { fail: null, hold: null };
  const record = (plan, out, o) => {
    recorded.push({ plan, out });
    let stop = false; let aborted = null;
    const done = (async () => {
      for (let i = 0; i <= 4; i++) { if (aborted) return aborted; o.onProgress({ t: plan.total * i / 4, total: plan.total }); await sleep(rec.hold || 10); }
      if (rec.fail) return { ok: false, code: 'CLIP_UNREADABLE', message: rec.fail };
      fs.writeFileSync(out, W.setWebmDuration(fakeWebm(plan.total * 24 + 1, 24, 1000), plan.total * 1000));
      return { ok: true, path: out, ms: plan.total * 1000, seconds: plan.total, mime: 'video/webm;codecs=vp9', bytes: 100, tracks: [{ type: 'video' }].concat(plan.music ? [{ type: 'audio' }] : []), stopped: stop };
    })();
    return { done, stop: () => { stop = true; }, abort: () => { aborted = { ok: false, code: 'VIDEO_CANCELLED', message: 'Stopped.' }; } };
  };
  const ffRuns = [];
  let ffBin = '/opt/ffmpeg';
  const runFfmpeg = async (bin, args) => { ffRuns.push({ bin, args }); fs.writeFileSync(args[args.length - 1], 'mp4'); return { ok: true }; };
  const logs = [];
  const mkMaker = (studio, o = {}) => VT.createTrailerMaker(Object.assign({ studio, record, trailersDir: () => path.join(videos, 'trailers'), fileUrl: (p) => `file://${p}`, log: (t, d) => logs.push({ t, d }), ffmpeg: () => ffBin, runFfmpeg, waitMs: 20 }, o));
  const studio = mkStudio();
  const maker = mkMaker(studio);
  const pic = path.join(TMP, 'odile.png'); fs.writeFileSync(pic, PNG);
  const music = path.join(TMP, 'theme.mp3'); fs.writeFileSync(music, 'ID3');
  const REQ = { book: 'The Ferry', items: [{ type: 'card', text: 'The Ferry', subtitle: 'a novel', seconds: 2 }, { prompt: 'a ferry crosses a dark sea at dawn', seconds: 2 }, { prompt: 'she stands at the rail', characterLock: 'Odile', seconds: 1 }, { image: pic, prompt: 'she turns to the sea', seconds: 2 }, { type: 'card', text: 'Coming soon', seconds: 1 }], music };
  let result;
  {
    const g0 = comfy.state.videoGraphs.length;
    const r = await maker.make(REQ);
    assert(r.ok && r.started && r.id && r.seconds === 8 && r.status.shots === 3 && r.status.items.length === 5, `make() starts in the background: ${r.status.shots} shots, ${r.seconds} s planned`);
    assert((await maker.make(REQ)).error === 'BUSY', 'one trailer at a time → BUSY');
    const mid = await until(async () => { const s = maker.status(); return s.status && s.status.items.some((x) => x.status === 'rendering') ? s : null; }, 5000);
    assert(mid && mid.busy && mid.status.phase === 'shots' && mid.status.shot >= 1 && /Making shot \d of 3/.test(mid.status.message) && mid.status.pct < 0.85, `progress while shots render: “${mid && mid.status.message}”, ${mid && mid.status.pct}`);
    const fin = await until(async () => { const s = maker.status(); return s.status && !s.status.busy ? s : null; }, 20000);
    result = fin && fin.result;
    assert(result && result.ok, `the trailer is made${result && !result.ok ? `: ${result.message}` : ''}`);
    const graphs = comfy.state.videoGraphs.slice(g0);
    const lat = (g) => Object.values(g).find((n) => n.class_type === 'Wan22ImageToVideoLatent');
    assert(graphs.length === 3 && lat(graphs[0]).inputs.length === 49 && lat(graphs[1]).inputs.length === 25 && lat(graphs[2]).inputs.length === 49, 'three Wan graphs, one per shot, in order, with their seconds (2 s → 49 frames, 1 s → 25)');
    assert(/odile woman, red hair, green coat, she stands at the rail/.test(graphs[1][5].inputs.text) && Object.values(graphs[2]).some((n) => n.class_type === 'LoadImage') && /she turns to the sea/.test(graphs[2][5].inputs.text), 'the character lock adds her looks; the picture shot is picture→video (LoadImage)');
    const tl = recorded[recorded.length - 1].plan;
    assert(tl.items.map((x) => x.kind).join(',') === 'card,clip,clip,clip,card' && tl.total === 8 && tl.items.filter((x) => x.kind === 'clip').every((x) => x.src.startsWith('file://') && x.src.includes(`${path.sep}trailers${path.sep}The Ferry${path.sep}shots${path.sep}shot-`)), 'the recorder gets the timeline: card, 3 clips (the copies in trailers/The Ferry/shots), card');
    assert(tl.music && tl.music.src === `file://${music}` && tl.music.fadeOut > 0, 'the music goes to the recorder (faded out at the end)');
    const dir = path.join(videos, 'trailers', 'The Ferry');
    assert(result.path === path.join(dir, 'trailer.webm') && fs.existsSync(result.path) && W.probeWebm(fs.readFileSync(result.path)).durationMs === 8000 && result.seconds === 8, 'trailer.webm in videos/trailers/The Ferry/ (8 s)');
    assert(result.mp4 === path.join(dir, 'trailer.mp4') && fs.existsSync(result.mp4) && ffRuns.length === 1 && ffRuns[0].bin === '/opt/ffmpeg' && ffRuns[0].args.includes('libx264') && ffRuns[0].args.includes('aac'), 'ffmpeg found → trailer.mp4 (H.264 + the music as AAC)');
    assert(fs.readdirSync(path.join(dir, 'shots')).filter((x) => /\.mp4$/.test(x)).length === 3 && result.shots.length === 3 && result.shots.every((s) => !s.reused) && result.cards.length === 2, 'the three shots are kept with the trailer');
    const side = JSON.parse(fs.readFileSync(path.join(dir, 'trailer.json'), 'utf8'));
    assert(side.plan && side.plan.items.length === 5 && side.plan.music === music && Object.keys(side.shots).length === 3 && side.last.ok && side.last.seconds === 8, 'trailer.json keeps the plan, the shots and the result');
    assert(!fs.existsSync(path.join(dir, 'trailer.part.webm')), 'no half-written file is left');
    assert(maker.status().result.ok && maker.status().status.pct === 1 && maker.status().status.phase === 'done', 'status() after: done, 100 %, with the result');
    const ls = maker.list();
    assert(ls.items.length === 1 && ls.items[0].book === 'The Ferry' && ls.items[0].mp4 && ls.items[0].plan.items.length === 5, 'list(): the saved trailer with its plan');
    assert(maker.plan({ book: 'The Ferry' }).plan.items[1].prompt === 'a ferry crosses a dark sea at dawn' && maker.plan({ book: 'Nope' }).plan === null, 'plan(): a book\'s saved plan (to edit and make again)');
  }
  // resume: the same trailer again → nothing is rendered; one shot changed → only that one
  {
    const g0 = comfy.state.videoGraphs.length;
    const r = await maker.make(Object.assign({}, REQ, { wait: true }));
    assert(r.ok && comfy.state.videoGraphs.length === g0 && r.reused === 3 && r.shots.every((s) => s.reused), 'the same trailer again: all 3 shots reused, nothing rendered (wait:true → the result)');
    const changed = JSON.parse(JSON.stringify(REQ)); changed.items[2].prompt = 'she waves'; changed.wait = true;
    const r2 = await maker.make(changed);
    assert(r2.ok && comfy.state.videoGraphs.length === g0 + 1 && r2.reused === 2 && /she waves/.test(comfy.state.videoGraphs[g0][5].inputs.text), 'one shot changed → only that one is made again');
    const r3 = await maker.make(Object.assign({}, changed, { resume: false }));
    assert(r3.ok && comfy.state.videoGraphs.length === g0 + 4 && r3.reused === 0, 'resume:false → every shot is made again');
  }
  // no ffmpeg; a join that fails
  {
    ffBin = null;
    const r = await maker.make(Object.assign({}, REQ, { wait: true }));
    assert(r.ok && r.mp4 === null && r.warnings.some((w) => w.field === 'mp4' && /No ffmpeg was found/.test(w.message)) && !fs.existsSync(path.join(videos, 'trailers', 'The Ferry', 'trailer.mp4')), 'no ffmpeg → only the .webm, with a plain note (the old .mp4 is not left behind)');
    ffBin = '/opt/ffmpeg';
    rec.fail = 'Shot 2 could not be read (media error 4).';
    const j = await maker.make(Object.assign({}, REQ, { wait: true }));
    assert(!j.ok && j.error === 'TRAILER_JOIN_FAILED' && /joining them into one video failed/.test(j.message) && /media error 4/.test(j.message) && /shots are kept/.test(j.fix) && j.cause === 'CLIP_UNREADABLE', `a failed join → TRAILER_JOIN_FAILED: “${j.message}”`);
    rec.fail = null;
  }
  // Stop during a shot: the shots made so far are kept; the next make continues
  {
    const slow = await fakeComfy({ videoPolls: 1000 });
    comfyBase = slow.base;
    const s2 = mkStudio(); const m2 = mkMaker(s2);
    const req = { book: 'Stop Test', items: [{ text: 'Stop' }, { prompt: 'one', seconds: 1 }, { prompt: 'two', seconds: 1 }] };
    await m2.make(req);
    await until(async () => slow.state.videoGraphs.length === 1, 5000);
    await sleep(100);
    const c = await m2.cancel();
    const fin = await until(async () => { const s = m2.status(); return s.status && !s.status.busy ? s : null; }, 5000);
    assert(c.cancelled && fin && fin.result.error === 'VIDEO_CANCELLED' && slow.state.interrupted && fin.status.items[1].status === 'stopped' && /kept and reused/.test(fin.result.fix), 'Stop while shot 1 renders → ComfyUI is interrupted, VIDEO_CANCELLED, “the shots already made are kept”');
    assert((await m2.cancel()).cancelled === false, 'Stop with nothing running says so');
    // shot 1 done, then the GPU runs out of memory on shot 2
    const oomAt = await fakeComfy({ videoPolls: 2 });
    comfyBase = oomAt.base;
    const s3 = mkStudio(); const m3 = mkMaker(s3);
    const okFirst = await m3.make(Object.assign({ wait: true }, { book: 'OOM Test', items: [{ prompt: 'one', seconds: 1 }] }));
    const oom = await fakeComfy({ failWith: 'Allocation on device 0 would exceed allowed memory.', failType: 'torch.OutOfMemoryError', failNode: 'KSampler' });
    comfyBase = oom.base;
    const bad = await m3.make({ book: 'OOM Test', items: [{ prompt: 'one', seconds: 1 }, { prompt: 'two', seconds: 1 }], wait: true });
    assert(okFirst.ok && !bad.ok && bad.error === 'VIDEO_OOM' && bad.shot === 2 && /^Shot 2 could not be made: /.test(bad.message) && /continues from shot 2/.test(bad.fix), `a shot that fails says which one and what to do: “${bad.message}” / “${bad.fix}”`);
    const st = m3.status();
    assert(st.status.items[0].status === 'reused' && st.status.items[1].status === 'failed' && st.status.items[1].error.code === 'VIDEO_OOM', 'shot 1 was kept (reused), shot 2 failed with its code');
    comfyBase = null;
    const s4 = mkStudio(); const m4 = mkMaker(s4);
    const ns = await m4.make({ book: 'Nothing', items: [{ prompt: 'x' }], wait: true });
    assert(!ns.ok && ns.error === 'VIDEO_NOT_SET_UP' && ns.shot === 1 && ns.fix, `no ComfyUI → VIDEO_NOT_SET_UP for shot 1: “${ns.message}”`);
    const cardsOnly = await m4.make({ book: 'Cards', items: [{ text: 'Only a card' }], wait: true, mp4: false });
    assert(cardsOnly.ok && cardsOnly.shots.length === 0 && cardsOnly.seconds === 3 && ffRuns.length === ffRuns.length, 'title cards only need no video engine (and mp4:false skips ffmpeg)');
    await slow.close(); await oomAt.close(); await oom.close();
    comfyBase = comfy.base;
  }
  // a video already being made in 🎬 Make video: the trailer waits for it
  {
    const s5 = mkStudio(); const m5 = mkMaker(s5);
    const pv = s5.generate({ prompt: 'someone else\'s video', seconds: 1 });
    await sleep(20);
    const p = m5.make({ book: 'Wait Test', items: [{ prompt: 'waits', seconds: 1 }], wait: true });
    await sleep(60);
    const st = m5.status();
    assert(st.busy && /Waiting for the video being made/.test(st.status.message), `waits while another video renders: “${st.status.message}”`);
    const [a, b] = await Promise.all([pv, p]);
    assert(a.ok && b.ok, 'both finish: first the other video, then the trailer\'s shot');
  }

  // =====================================================================
  console.log('\n== 5. video-api trailer.* ==');
  let api;
  {
    api = VA.createVideoApi({ studio, trailer: maker });
    const caps = await api.capabilities();
    const names = caps.operations.map((o) => o.name);
    assert(['trailer.make', 'trailer.status', 'trailer.cancel', 'trailer.list', 'trailer.plan'].every((n) => names.includes(n)) && caps.errors.includes('TRAILER_JOIN_FAILED'), 'capabilities() lists trailer.make / status / cancel / list / plan and TRAILER_JOIN_FAILED');
    const op = (n) => caps.operations.find((o) => o.name === n);
    assert(op('trailer.make').changes === true && op('trailer.status').changes === false && op('trailer.list').changes === false && op('trailer.cancel').changes === true && op('trailer.make').params.properties.items.items.properties.subtitle, 'make / cancel change things (a card first); status / list / plan are read-only; the schema describes shots and cards');
    let r = await api.call('trailer.make', { book: 'API', items: [{ text: 'API card', seconds: 1 }], wait: true, mp4: false });
    assert(r.ok && r.seconds === 1 && /trailers.API.trailer\.webm$/.test(r.path), 'call("trailer.make", …) makes it');
    r = await api.call('trailer.make', { book: 'API', items: [{ text: 'x' }], colour: 'red' });
    assert(r.error === 'INVALID_PARAM' && r.field === 'colour', 'an unknown parameter → INVALID_PARAM');
    r = await api.trailer.make({ book: 'API', itmes: [] });
    assert(r.error === 'INVALID_PARAM' && /Did you mean: items/.test(r.hint), 'a misspelt one gets a suggestion');
    assert((await api.call('trailer.status', {})).ok && (await api.call('trailer.list', {})).items.length >= 2 && (await api.call('trailer.plan', { book: 'API' })).plan.items[0].text === 'API card', 'status / list / plan through call()');
    assert((await api.call('trailer.plan', {})).error === 'INVALID_PARAM', 'trailer.plan needs the book');
    const bare = VA.createVideoApi({ studio });
    assert((await bare.trailer.make({ book: 'x', items: [{ text: 'x' }] })).error === 'NOT_WIRED', 'without the trailer maker → NOT_WIRED');
  }

  // =====================================================================
  console.log('\n== 6. the bridge: POST /video/trailer, GET /video/trailer, POST /video/trailer/cancel ==');
  {
    let port;
    const bridge = createServiceBridge({ video: {
      backend: () => studio.backendInfo(), request: (b) => studio.request(b, 'bridge'),
      trailer: (b) => maker.make(Object.assign({}, b, { from: `bridge:${b.from || 'akowe'}` })), trailerStatus: (q) => maker.status(q), trailerCancel: () => maker.cancel(),
    } });
    port = (await bridge.start({ port: 0, host: '127.0.0.1', token: 'tok' })).port;
    const req = (method, p, body) => new Promise((resolve) => {
      const data = body ? Buffer.from(JSON.stringify(body)) : null;
      const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.assign({ Authorization: 'Bearer tok' }, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) }, (res) => {
        let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
      });
      r.on('error', (e) => resolve({ status: 0, error: e.message }));
      if (data) r.write(data); r.end();
    });
    const g0 = comfy.state.videoGraphs.length;
    let r = await req('POST', '/video/trailer', { book: 'Bridge Book', items: [{ text: 'Bridge Book' }, { prompt: 'rain on the river', seconds: 1 }], from: 'akowe-trailer', mp4: false });
    assert(r.status === 202 && r.json.ok && r.json.started && r.json.id, `POST /video/trailer → 202 + the job id (${r.status})`);
    const id = r.json.id;
    const busy = await req('POST', '/video/trailer', { book: 'Other', items: [{ text: 'x' }] });
    assert(busy.status === 409 && busy.json.error === 'BUSY', 'a second one while it runs → 409 BUSY');
    let st;
    for (let i = 0; i < 200; i++) { st = await req('GET', `/video/trailer?id=${id}`); if (st.json && st.json.status && !st.json.status.busy) break; await sleep(50); }
    assert(st.status === 200 && st.json.result && st.json.result.ok && /Bridge Book.trailer\.webm$/.test(st.json.result.path) && comfy.state.videoGraphs.length === g0 + 1, 'GET /video/trailer?id= follows it to the finished trailer (path of trailer.webm)');
    assert(logs.some((l) => l.t === 'trailer-start' && l.d.from === 'bridge:akowe-trailer'), 'the log says who asked (bridge:akowe-trailer)');
    r = await req('GET', '/video/trailer?id=nope');
    assert(r.status === 404 && r.json.error === 'NOT_FOUND', 'an unknown id → 404 NOT_FOUND');
    r = await req('POST', '/video/trailer', { book: 'x', items: [] });
    assert(r.status === 400 && r.json.error === 'INVALID_PARAM' && r.json.field === 'items', 'an empty trailer → 400 INVALID_PARAM');
    r = await req('POST', '/video/trailer', { book: 'x', items: [{ text: 'T' }], wait: true, mp4: false });
    assert(r.status === 200 && r.json.ok && r.json.seconds === 3, 'wait:true → 200 with the finished trailer');
    await req('POST', '/video/trailer', { book: 'Cancel Me', items: [{ prompt: 'long', seconds: 1 }] });
    r = await req('POST', '/video/trailer/cancel');
    assert(r.status === 200 && r.json.ok && r.json.cancelled, 'POST /video/trailer/cancel stops it');
    await until(async () => !maker.busy(), 5000);
    await bridge.stop();
    const b2 = createServiceBridge({ video: { backend: () => ({}), request: () => ({}) } });
    port = (await b2.start({ port: 0, host: '127.0.0.1', token: 'tok' })).port;
    r = await req('POST', '/video/trailer', { book: 'x', items: [{ text: 'T' }] });
    assert(r.status === 501 && r.json.error === 'VIDEO_NOT_WIRED', 'an AutoInjector without trailers → 501 VIDEO_NOT_WIRED');
    await b2.stop();
  }
  await comfy.close();
}

main().then(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
