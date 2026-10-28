'use strict';
/*
 * video-trailer.js — 🎞 book trailers (plan item B2), Electron-free so it is testable.
 * A trailer = shots ({ prompt | image, seconds }) and title cards ({ text, subtitle, seconds }) in order, plus
 * optional music. make():
 *   1. renders each shot with the 🎬 video engine (video-studio.js: text→video, or picture→video with `image`),
 *      one after the other, with progress and Stop. Finished shots are kept in the trailer's folder (shots/) and
 *      reused next time (resume) when the same shot is asked for again;
 *   2. JOINS them — no new dependency: deps.record(joinPlan, out) is the hidden-window canvas + MediaRecorder
 *      recorder (trailer-recorder.js) → trailer.webm (VP9/VP8, the music mixed in, fades between shots);
 *   3. when an ffmpeg binary is found (AUTOINJECTOR_FFMPEG, PATH, the ComfyUI folders, imageio-ffmpeg inside
 *      ComfyUI's python_embeded) it also writes trailer.mp4 (H.264) — optional.
 * Everything lands in <videos>/trailers/<book>/: trailer-<stamp>.webm, trailer-<stamp>.mp4 (a new name each time —
 * Windows keeps a playing file locked), trailer.json (the plan, the shots,
 * the result) and shots/. One trailer at a time.
 *
 * deps: studio (video-studio: generate / animate / cancel / busy), record(plan, outPath, { onProgress }) →
 * { done, stop, abort }, trailersDir() (the trailers folder), fileUrl(p), log(type, data), ffmpeg() → path | null
 * (optional; default findFfmpeg({ roots: deps.comfyRoots() })), runFfmpeg(bin, args, ms) (optional), waitMs.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');

const LIMITS = { items: 24, shots: 16, shotSeconds: [1, 5], cardSeconds: [1, 10], text: 120, subtitle: 160, prompt: 4000, width: [320, 1920], height: [240, 1080], fps: [12, 30], fade: [0, 1] };
const DEFAULTS = { shotSeconds: 4, cardSeconds: 3, width: 1280, height: 720, fps: 24, fade: 0.4, musicVolume: 0.8 };
const MUSIC_EXT = /\.(mp3|ogg|oga|opus|wav|m4a|aac|flac|webm)$/i;
const SHOT_KEYS = ['type', 'prompt', 'image', 'seconds', 'characterLock', 'negativePrompt', 'seed', 'model'];
const CARD_KEYS = ['type', 'text', 'subtitle', 'seconds', 'at'];
const TOP_KEYS = ['book', 'title', 'items', 'shots', 'cards', 'music', 'musicVolume', 'width', 'height', 'fps', 'fade', 'model', 'resume', 'mp4', 'from', 'wait'];
const ERRORS = {
  TRAILER_JOIN_FAILED: 'The shots were made, but joining them into one video failed.',
  BUSY: 'A trailer is already being made.',
};

const isNum = (v) => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const bad = (field, message, hint) => ({ ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', field, message, hint: hint || '' });
function fail(code, message, fix, extra) { return Object.assign({ ok: false, error: code, code, message, fix: fix || '' }, extra || {}); }
// A folder name from a book title (Windows-safe).
function safeName(s, dflt) {
  const t = String(s || '').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 80);
  return t || dflt || 'trailer';
}

// ------------------------------------------------------------------ the plan
/**
 * The request → { plan, warnings } | { error }. Accepts items: [{ type:'shot'|'card', … }] in order, or
 * shots: [] + cards: [] (a card's `at`: "start" | "end" | n = after the n-th shot; default: the first card
 * opens, the others close).
 */
function normalizeTrailer(req) {
  const r = req && typeof req === 'object' ? req : {};
  const warnings = [];
  for (const k of Object.keys(r)) if (!TOP_KEYS.includes(k) && r[k] !== undefined) return { error: bad(k, `A trailer has no setting “${k}”.`, `Settings: ${TOP_KEYS.join(', ')}.`) };
  let raw = [];
  if (Array.isArray(r.items) && r.items.length) raw = r.items.map((x) => Object.assign({}, x));
  else {
    const shots = Array.isArray(r.shots) ? r.shots.map((x) => Object.assign({ type: 'shot' }, x)) : [];
    const cards = Array.isArray(r.cards) ? r.cards.map((x) => Object.assign({ type: 'card' }, x)) : [];
    const start = []; const end = []; const after = {};
    cards.forEach((c, i) => {
      const at = c.at == null || c.at === '' ? (i === 0 ? 'start' : 'end') : c.at;
      if (at === 'start') start.push(c); else if (at === 'end' || !isNum(at)) end.push(c); else (after[clamp(Math.round(Number(at)), 0, shots.length)] = after[clamp(Math.round(Number(at)), 0, shots.length)] || []).push(c);
    });
    raw = [...start, ...(after[0] || [])];
    shots.forEach((s, i) => { raw.push(s); raw.push(...(after[i + 1] || [])); });
    raw.push(...end);
  }
  if (!raw.length) return { error: bad('items', 'The trailer is empty: add at least one shot or title card.', 'items: [{ type:"shot", prompt:"…", seconds:4 }, { type:"card", text:"The Ferry", subtitle:"Coming soon" }]') };
  if (raw.length > LIMITS.items) return { error: bad('items', `A trailer has at most ${LIMITS.items} shots and cards (got ${raw.length}).`) };
  const items = [];
  for (let i = 0; i < raw.length; i++) {
    const x = raw[i] || {};
    const n = i + 1;
    const type = x.type || (x.text != null && x.prompt == null && x.image == null ? 'card' : 'shot');
    if (type !== 'shot' && type !== 'card') return { error: bad(`items[${i}].type`, `Item ${n}: type is "shot" or "card" (got “${x.type}”).`) };
    const keys = type === 'shot' ? SHOT_KEYS : CARD_KEYS;
    const unknown = Object.keys(x).find((k) => !keys.includes(k) && x[k] !== undefined && !(type === 'card' && k === 'at'));
    if (unknown) return { error: bad(`items[${i}].${unknown}`, `Item ${n} (${type}) has no setting “${unknown}”.`, `A ${type} has: ${keys.filter((k) => k !== 'type').join(', ')}.`) };
    if (x.seconds != null && x.seconds !== '' && !isNum(x.seconds)) return { error: bad(`items[${i}].seconds`, `Item ${n}: seconds must be a number (got “${String(x.seconds).slice(0, 30)}”).`) };
    if (type === 'card') {
      const text = typeof x.text === 'string' ? x.text.trim() : '';
      if (!text) return { error: bad(`items[${i}].text`, `Title card ${n} needs its text (e.g. the book's title).`) };
      if (x.subtitle != null && typeof x.subtitle !== 'string') return { error: bad(`items[${i}].subtitle`, `Title card ${n}: subtitle must be text.`) };
      const [lo, hi] = LIMITS.cardSeconds;
      const want = isNum(x.seconds) ? Number(x.seconds) : DEFAULTS.cardSeconds;
      const seconds = Math.round(clamp(want, lo, hi) * 10) / 10;
      if (seconds !== want) warnings.push({ level: 'soft', field: `items[${i}].seconds`, message: `Title card ${n}: ${want} s → ${seconds} s (cards are ${lo}–${hi} s).` });
      items.push({ type: 'card', text: text.slice(0, LIMITS.text), subtitle: x.subtitle ? String(x.subtitle).trim().slice(0, LIMITS.subtitle) : '', seconds });
      continue;
    }
    const prompt = typeof x.prompt === 'string' ? x.prompt.trim().slice(0, LIMITS.prompt) : '';
    const image = typeof x.image === 'string' && x.image.trim() ? x.image.trim() : '';
    if (x.prompt != null && typeof x.prompt !== 'string') return { error: bad(`items[${i}].prompt`, `Shot ${n}: prompt must be text.`) };
    if (x.image != null && x.image !== '' && typeof x.image !== 'string') return { error: bad(`items[${i}].image`, `Shot ${n}: image must be the path of a picture file (or base64).`) };
    if (!prompt && !image && !x.characterLock) return { error: bad(`items[${i}].prompt`, `Shot ${n} needs a description (prompt) or a picture (image).`) };
    const [lo, hi] = LIMITS.shotSeconds;
    const want = isNum(x.seconds) ? Number(x.seconds) : DEFAULTS.shotSeconds;
    const seconds = Math.round(clamp(want, lo, hi) * 10) / 10;
    if (seconds !== want) warnings.push({ level: 'soft', field: `items[${i}].seconds`, message: `Shot ${n}: ${want} s → ${seconds} s (a shot is ${lo}–${hi} s).` });
    const shot = { type: 'shot', prompt, image, seconds };
    for (const k of ['characterLock', 'negativePrompt', 'model']) if (x[k] != null && x[k] !== '') { if (typeof x[k] !== 'string') return { error: bad(`items[${i}].${k}`, `Shot ${n}: ${k} must be text.`) }; shot[k] = x[k].slice(0, k === 'negativePrompt' ? 4000 : 200); }
    if (isNum(x.seed) && Number(x.seed) >= 0) shot.seed = Math.floor(Number(x.seed));
    items.push(shot);
  }
  const shotCount = items.filter((x) => x.type === 'shot').length;
  if (shotCount > LIMITS.shots) return { error: bad('items', `A trailer has at most ${LIMITS.shots} shots (got ${shotCount}).`) };
  // the frame, music, the rest
  const num = (k, [lo, hi], dflt, step) => {
    if (r[k] != null && r[k] !== '' && !isNum(r[k])) return { error: bad(k, `${k} must be a number.`) };
    const want = isNum(r[k]) ? Number(r[k]) : dflt;
    let v = clamp(want, lo, hi); if (step) v = Math.round(v / step) * step;
    if (isNum(r[k]) && v !== want) warnings.push({ level: 'soft', field: k, message: `${k} ${want} → ${v} (${lo}–${hi}).` });
    return { v };
  };
  const W = num('width', LIMITS.width, DEFAULTS.width, 2); if (W.error) return W;
  const H = num('height', LIMITS.height, DEFAULTS.height, 2); if (H.error) return H;
  const F = num('fps', LIMITS.fps, DEFAULTS.fps, 1); if (F.error) return F;
  const FD = num('fade', LIMITS.fade, DEFAULTS.fade); if (FD.error) return FD;
  const MV = num('musicVolume', [0, 1], DEFAULTS.musicVolume); if (MV.error) return MV;
  let music = '';
  if (r.music != null && r.music !== '') {
    if (typeof r.music !== 'string') return { error: bad('music', 'music must be the path of a music file (.mp3, .ogg, .wav, .m4a …).') };
    let p = r.music.trim();
    if (/^file:\/\//i.test(p)) { try { p = require('url').fileURLToPath(p); } catch (_) {} }
    if (!MUSIC_EXT.test(p)) return { error: bad('music', `“${path.basename(p)}” is not a music file AutoInjector can mix in.`, 'Use .mp3, .ogg, .opus, .wav, .m4a, .aac, .flac or .webm.') };
    let st = null; try { st = fs.statSync(p); } catch (_) { st = null; }
    if (!st || !st.isFile()) return { error: bad('music', `The music file “${p}” was not found.`, 'Give the full path of the music file, or leave music out.') };
    music = p;
  }
  for (const k of ['book', 'title', 'model', 'from']) if (r[k] != null && typeof r[k] !== 'string') return { error: bad(k, `${k} must be text.`) };
  const book = String(r.book || r.title || '').trim().slice(0, 200);
  const plan = {
    book: book || 'Untitled', title: String(r.title || book || '').trim().slice(0, 200), folder: safeName(book, 'Untitled'),
    items, music, musicVolume: MV.v, width: W.v, height: H.v, fps: F.v, fade: Math.round(FD.v * 100) / 100,
    model: r.model ? String(r.model).slice(0, 80) : undefined, resume: r.resume !== false, mp4: r.mp4 !== false, from: r.from ? String(r.from).slice(0, 60) : '',
  };
  plan.total = Math.round(items.reduce((n, x) => n + x.seconds, 0) * 100) / 100;
  return { plan, warnings };
}

// The same shot asked for again → the same key (resume).
function shotKey(shot, model) {
  const img = shot.image ? (shot.image.length > 300 ? `b64:${crypto.createHash('sha1').update(shot.image).digest('hex')}` : shot.image) : '';
  const k = JSON.stringify([shot.prompt || '', img, shot.seconds, shot.characterLock || '', shot.negativePrompt || '', shot.model || model || '', shot.seed == null ? null : shot.seed]);
  return crypto.createHash('sha1').update(k).digest('hex').slice(0, 16);
}

/** The recorder's timeline: { width, height, fps, fade, total, items:[{ kind:'clip', src, start, seconds } | { kind:'card', text, subtitle, start, seconds }], music }. */
function joinPlan(plan, rendered, fileUrl) {
  const url = fileUrl || ((p) => require('url').pathToFileURL(p).href);
  let t = 0; let shotNo = 0;
  const items = plan.items.map((it, i) => {
    const start = Math.round(t * 1000) / 1000; t += it.seconds;
    if (it.type === 'card') return { kind: 'card', start, seconds: it.seconds, text: it.text, subtitle: it.subtitle || '' };
    shotNo++;
    const r = rendered[i];
    if (!r || !r.path) throw new Error(`shot ${shotNo} has no clip`);
    return { kind: 'clip', number: shotNo, start, seconds: it.seconds, src: url(r.path) };
  });
  return { width: plan.width, height: plan.height, fps: plan.fps, fade: plan.fade, total: Math.round(t * 1000) / 1000, items,
    music: plan.music ? { src: url(plan.music), volume: plan.musicVolume, fadeOut: Math.min(1.5, t / 3) } : null,
    videoBitsPerSecond: Math.round(plan.width * plan.height * plan.fps * 0.25) };
}

// ------------------------------------------------------------------ ffmpeg (optional)
function ffmpegCandidates(o = {}) {
  const env = o.env || process.env;
  const win = (o.platform || process.platform) === 'win32';
  const exe = win ? 'ffmpeg.exe' : 'ffmpeg';
  const out = [];
  if (env.AUTOINJECTOR_FFMPEG && env.AUTOINJECTOR_FFMPEG !== 'none') out.push(env.AUTOINJECTOR_FFMPEG);
  for (const d of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) out.push(path.join(d, exe));
  const roots = [];
  for (const r of o.roots || []) if (r) { roots.push(r); roots.push(path.dirname(r)); }
  const ls = (d) => { try { return fs.readdirSync(d); } catch (_) { return []; } };
  const imageio = (site) => { const b = path.join(site, 'imageio_ffmpeg', 'binaries'); for (const f of ls(b)) if (/^ffmpeg/i.test(f) && !/\.(txt|md|py)$/i.test(f)) out.push(path.join(b, f)); };
  for (const r of [...new Set(roots)]) {
    out.push(path.join(r, exe), path.join(r, 'ffmpeg', 'bin', exe), path.join(r, 'bin', exe));
    for (const py of ['python_embeded', 'python_embedded', 'venv', '.venv']) {
      imageio(path.join(r, py, 'Lib', 'site-packages'));
      for (const lib of ['lib', 'lib64']) for (const v of ls(path.join(r, py, lib)).filter((x) => /^python3/.test(x))) imageio(path.join(r, py, lib, v, 'site-packages'));
    }
  }
  return [...new Set(out)];
}
function findFfmpeg(o = {}) {
  if (((o.env || process.env).AUTOINJECTOR_FFMPEG || '') === 'none') return null; // "never use ffmpeg" (tests, or by choice)
  for (const p of ffmpegCandidates(o)) { try { if (fs.statSync(p).isFile()) return p; } catch (_) {} }
  return null;
}
function mp4Args(webm, mp4, hasAudio) {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20', '-movflags', '+faststart',
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', '160k'] : ['-an']), mp4];
}
function runFfmpegDefault(bin, args, ms) {
  return new Promise((resolve) => {
    childProcess.execFile(bin, args, { timeout: ms || 600000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, _so, se) => {
      resolve(err ? { ok: false, error: err.killed ? 'TIMEOUT' : (err.code || 'FAILED'), detail: String(se || err.message || '').slice(0, 1000) } : { ok: true });
    });
  });
}

// ------------------------------------------------------------------ the maker
function createTrailerMaker(deps = {}) {
  const studio = deps.studio;
  const log = deps.log || (() => {});
  const fileUrl = deps.fileUrl || ((p) => require('url').pathToFileURL(p).href);
  const runFfmpeg = deps.runFfmpeg || runFfmpegDefault;
  const ffmpeg = deps.ffmpeg || (() => findFfmpeg({ roots: deps.comfyRoots ? deps.comfyRoots() : [] }));
  const waitMs = deps.waitMs || 1000;
  let job = null; // the running trailer
  let last = null; // the last finished one

  function trailersDir() { const d = deps.trailersDir(); fs.mkdirSync(d, { recursive: true }); return d; }
  // trailer-<time>-<id>.webm / .mp4 (older versions: trailer.webm / trailer.mp4)
  const TRAILER_FILE = /^trailer(?:-[A-Za-z0-9-]+)?\.(webm|mp4)$/;
  function trailerStem(id) { return `trailer-${Date.now().toString(36)}-${String(id || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'x'}`; }
  // The trailer a folder holds now: the one trailer.json names, else the newest trailer file there.
  function currentFiles(dir, st) {
    const inDir = (p) => !!p && path.dirname(path.resolve(String(p))) === path.resolve(dir) && fs.existsSync(p);
    const lastOk = st && st.last && st.last.ok ? st.last : null;
    if (lastOk && inDir(lastOk.path)) return { webm: lastOk.path, mp4: inDir(lastOk.mp4) ? lastOk.mp4 : null };
    let names = []; try { names = fs.readdirSync(dir).filter((n) => TRAILER_FILE.test(n)); } catch (_) { names = []; }
    const newest = (ext) => names.filter((n) => n.endsWith(ext)).map((n) => { const p = path.join(dir, n); let m = 0; try { m = fs.statSync(p).mtimeMs; } catch (_) {} return { p, m }; }).sort((a, b) => b.m - a.m)[0];
    const w = newest('.webm'); const m4 = newest('.mp4');
    return { webm: w ? w.p : null, mp4: m4 ? m4.p : null };
  }
  // Delete the older trailer files of a folder (best effort: one still open in a player stays until next time).
  function dropOlder(dir, keep) {
    const k = new Set((keep || []).filter(Boolean).map((p) => path.resolve(p)));
    let names = []; try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const n of names) {
      if (!TRAILER_FILE.test(n) && !/^trailer(?:-[A-Za-z0-9-]+)?\.part\.webm$/.test(n)) continue;
      const p = path.resolve(path.join(dir, n));
      if (k.has(p)) continue;
      try { fs.unlinkSync(p); } catch (_) {}
    }
  }
  function readState(dir) { try { const j = JSON.parse(fs.readFileSync(path.join(dir, 'trailer.json'), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch (_) { return {}; } }
  function writeState(dir, st) { try { fs.writeFileSync(path.join(dir, 'trailer.json'), JSON.stringify(st, null, 2)); } catch (_) {} }

  function publicJob(j) {
    if (!j) return null;
    const shots = j.items.filter((x) => x.type === 'shot');
    const doneShots = shots.filter((x) => x.status === 'done' || x.status === 'reused').length;
    let pct = shots.length ? doneShots / shots.length * 0.85 : 0.85;
    if (j.phase === 'joining') pct = 0.85 + 0.13 * (j.joinPct || 0);
    if (j.phase === 'mp4') pct = 0.98;
    if (j.phase === 'done') pct = 1;
    return {
      id: j.id, book: j.plan.book, phase: j.phase, busy: !j.finished, seconds: Math.round((Date.now() - j.startedAt) / 1000), pct: Math.round(pct * 1000) / 1000,
      shot: j.shotNo || 0, shots: shots.length, shotsDone: doneShots, total: j.plan.total, message: j.message || '',
      items: j.items.map((x) => ({ type: x.type, status: x.status, label: x.label, seconds: x.seconds, path: x.path || null, url: x.path ? fileUrl(x.path) : null, poster: x.poster || null, error: x.error || null })),
      shotProgress: j.shotProgress || null,
    };
  }

  async function waitStudioFree(j) {
    const t0 = Date.now();
    while (studio && typeof studio.busy === 'function' && studio.busy()) {
      if (j.cancelled) return false;
      j.message = 'Waiting for the video being made in 🎬 Make video to finish…';
      if (Date.now() - t0 > (deps.busyWaitMs || 6 * 3600000)) return false;
      await new Promise((r) => setTimeout(r, waitMs));
    }
    return true;
  }

  async function renderShot(j, it, i) {
    const shot = j.plan.items[i];
    const key = shotKey(shot, j.plan.model);
    const cache = j.state.shots || (j.state.shots = {});
    const c = cache[key];
    if (j.plan.resume && c && c.file && fs.existsSync(path.join(j.dir, 'shots', c.file))) {
      it.status = 'reused'; it.path = path.join(j.dir, 'shots', c.file); it.poster = c.poster ? path.join(j.dir, 'shots', c.poster) : null; it.key = key;
      return { ok: true, path: it.path };
    }
    if (!(await waitStudioFree(j))) return j.cancelled ? fail('VIDEO_CANCELLED', 'Stopped.') : fail('BUSY', 'Another video is still being made.', 'Wait for it (🎬 Video), then press Make trailer again.');
    it.status = 'rendering';
    j.message = `Making shot ${j.shotNo} of ${j.items.filter((x) => x.type === 'shot').length} (${shot.seconds} s)… the first one loads the video model.`;
    const req = { prompt: shot.prompt || undefined, seconds: shot.seconds, purpose: 'trailer_shot', book: j.plan.book, from: `trailer${j.plan.from ? `:${j.plan.from}` : ''}`.slice(0, 60) };
    for (const k of ['characterLock', 'negativePrompt', 'seed']) if (shot[k] != null) req[k] = shot[k];
    if (shot.model || j.plan.model) req.model = shot.model || j.plan.model;
    let r;
    if (shot.image) { req.image = shot.image; r = await studio.animate(req, 'trailer'); } else r = await studio.generate(req, 'trailer');
    if (!r || !r.ok) return r || fail('VIDEO_FAILED', 'The shot could not be made.');
    if (!r.path) return fail('VIDEO_FAILED', 'The video engine answered with an address, not a file — a trailer needs the clip on this computer.', 'Use ComfyUI + Wan in 🎬 Video → Setup.');
    // keep a copy with the trailer (resume, and so deleting it from videos/ doesn't break the trailer)
    const sd = path.join(j.dir, 'shots'); fs.mkdirSync(sd, { recursive: true });
    const file = `shot-${key}${path.extname(r.path) || '.mp4'}`;
    try { fs.copyFileSync(r.path, path.join(sd, file)); } catch (e) { return fail('VIDEO_FAILED', `The shot was made but couldn't be copied into the trailer folder (${e.code || e.message}).`); }
    let poster = null;
    if (r.poster) { try { poster = `shot-${key}.png`; fs.copyFileSync(r.poster, path.join(sd, poster)); } catch (_) { poster = null; } }
    cache[key] = { file, poster, seconds: r.seconds, model: r.model, seed: r.seed, source: r.path, at: new Date().toISOString(), prompt: (shot.prompt || '').slice(0, 300) };
    writeState(j.dir, j.state);
    it.status = 'done'; it.path = path.join(sd, file); it.poster = poster ? path.join(sd, poster) : null; it.key = key; it.model = r.model; it.seed = r.seed;
    return { ok: true, path: it.path };
  }

  async function run(j) {
    const plan = j.plan;
    // 1. the shots
    j.phase = 'shots';
    for (let i = 0; i < plan.items.length; i++) {
      const it = j.items[i];
      if (it.type !== 'shot') continue;
      j.shotNo = (j.shotNo || 0) + 1;
      if (j.cancelled) return fail('VIDEO_CANCELLED', 'Stopped.', 'Press Make trailer again: the shots already made are kept and reused.');
      const r = await renderShot(j, it, i);
      if (!r.ok) {
        it.status = j.cancelled || r.error === 'VIDEO_CANCELLED' ? 'stopped' : 'failed'; it.error = { code: r.code || r.error, message: r.message };
        if (j.cancelled || r.error === 'VIDEO_CANCELLED') return fail('VIDEO_CANCELLED', 'Stopped.', 'Press Make trailer again: the shots already made are kept and reused.', { shot: j.shotNo });
        const kept = j.items.filter((x) => x.status === 'done' || x.status === 'reused').length;
        return Object.assign({}, r, { ok: false, shot: j.shotNo, message: `Shot ${j.shotNo} could not be made: ${r.message || r.error}`, fix: [r.fix || r.hint, kept ? `The ${kept} shot(s) already made are kept: pressing Make trailer again continues from shot ${j.shotNo}.` : ''].filter(Boolean).join(' ') });
      }
    }
    if (j.cancelled) return fail('VIDEO_CANCELLED', 'Stopped.', 'Press Make trailer again: the shots already made are kept and reused.');
    // 2. the join
    j.phase = 'joining';
    j.message = `Joining ${j.items.length} part(s) into one ${plan.total}-second trailer (it plays once, in real time)…`;
    let timeline;
    try { timeline = joinPlan(plan, j.items, fileUrl); } catch (e) { return fail('TRAILER_JOIN_FAILED', `${ERRORS.TRAILER_JOIN_FAILED} (${e.message})`); }
    if (!deps.record) return fail('NOT_WIRED', 'Joining videos is not available in this build.');
    // A new name each time: on Windows the Trailer panel's <video> keeps the last trailer open, so replacing
    // trailer.webm would fail (EPERM/EBUSY) after a minutes-long recording. Older ones are deleted afterwards
    // (best effort, see dropOlder); trailer.json and the result point at this one.
    const stem = trailerStem(j.id);
    const webm = path.join(j.dir, `${stem}.webm`);
    const part = path.join(j.dir, `${stem}.part.webm`);
    j.rec = deps.record(timeline, part, { onProgress: (p) => { j.joinPct = p && p.total ? clamp(p.t / p.total, 0, 1) : 0; } });
    const rr = await j.rec.done;
    j.rec = null;
    if (j.cancelled) { try { fs.unlinkSync(part); } catch (_) {} return fail('VIDEO_CANCELLED', 'Stopped.', 'Press Make trailer again: the shots already made are kept and reused.'); }
    if (!rr || !rr.ok) return fail('TRAILER_JOIN_FAILED', `${ERRORS.TRAILER_JOIN_FAILED} ${(rr && rr.message) || ''}`.trim(), 'Press Make trailer again (the shots are kept). If it repeats, look at the log (📜) and send it.', { cause: rr && rr.code });
    try { fs.renameSync(part, webm); } catch (e) { try { fs.copyFileSync(part, webm); fs.unlinkSync(part); } catch (e2) { return fail('TRAILER_JOIN_FAILED', `The trailer was recorded but could not be saved (${e2.code || e2.message}).`); } }
    // 3. the optional .mp4
    const warnings = j.warnings.slice();
    let mp4 = null;
    const mp4Path = path.join(j.dir, `${stem}.mp4`);
    if (plan.mp4) {
      const bin = ffmpeg();
      if (bin) {
        j.phase = 'mp4'; j.message = 'Making the .mp4 copy (H.264) with ffmpeg…';
        const hasAudio = (rr.tracks || []).some((t) => t.type === 'audio');
        const fr = await runFfmpeg(bin, mp4Args(webm, mp4Path, hasAudio), Math.max(120000, plan.total * 20000));
        if (fr.ok && fs.existsSync(mp4Path)) mp4 = mp4Path;
        else warnings.push({ level: 'soft', field: 'mp4', message: `ffmpeg (${bin}) could not make the .mp4 copy${fr.detail ? `: ${String(fr.detail).split('\n').filter(Boolean).slice(-1)[0]}` : ''}. The .webm is fine.` });
      } else warnings.push({ level: 'soft', field: 'mp4', message: 'No ffmpeg was found, so there is only the .webm (it plays in browsers, VLC and most players). Install ffmpeg (or set AUTOINJECTOR_FFMPEG) for an .mp4 copy too.' });
    }
    const out = {
      ok: true, id: j.id, book: plan.book, title: plan.title, dir: j.dir, path: webm, url: fileUrl(webm), mp4, mp4Url: mp4 ? fileUrl(mp4) : null,
      seconds: rr.seconds, planned: plan.total, width: plan.width, height: plan.height, fps: plan.fps, mime: rr.mime, bytes: rr.bytes, music: plan.music || null,
      shots: j.items.filter((x) => x.type === 'shot').map((x) => ({ path: x.path, poster: x.poster, seconds: x.seconds, reused: x.status === 'reused', label: x.label })),
      cards: plan.items.filter((x) => x.type === 'card').map((x) => ({ text: x.text, subtitle: x.subtitle, seconds: x.seconds })),
      reused: j.items.filter((x) => x.status === 'reused').length, warnings, json: path.join(j.dir, 'trailer.json'),
    };
    return out;
  }

  // Start a trailer. Returns at once ({ ok, started, id, status }) unless o.wait: then the final result.
  async function make(req) {
    if (job && !job.finished) return fail('BUSY', `${ERRORS.BUSY} (${publicJob(job).phase}, ${Math.round((Date.now() - job.startedAt) / 1000)} s so far)`, 'Wait for it (trailer.status) or stop it (trailer.cancel).');
    if (!studio) return fail('NOT_WIRED', 'Video is not available in this build.');
    const nz = normalizeTrailer(req);
    if (nz.error) return nz.error;
    const plan = nz.plan;
    let dir;
    try { dir = path.join(trailersDir(), plan.folder); fs.mkdirSync(path.join(dir, 'shots'), { recursive: true }); } catch (e) { return fail('VIDEO_FAILED', `The trailer folder could not be made (${e.code || e.message}).`, 'Check the output folder is writable.'); }
    let shotNo = 0;
    const j = {
      id: crypto.randomUUID(), plan, dir, startedAt: Date.now(), phase: 'starting', cancelled: false, finished: false, warnings: nz.warnings, state: readState(dir),
      items: plan.items.map((x) => ({ type: x.type, status: 'waiting', seconds: x.seconds, label: x.type === 'card' ? `Card: ${x.text}` : `Shot ${++shotNo}: ${(x.prompt || (x.image ? `picture ${path.basename(x.image.length < 300 ? x.image : 'picture')}` : x.characterLock || '')).slice(0, 80)}` })),
    };
    for (const it of j.items) if (it.type === 'card') it.status = 'ready';
    job = j;
    log('trailer-start', { id: j.id, shots: shotNo, cards: plan.items.length - shotNo, seconds: plan.total, music: !!plan.music, from: plan.from || 'video-tab' });
    const p = (async () => {
      let out;
      try { out = await run(j); } catch (e) { out = fail('VIDEO_FAILED', `Something went wrong: ${(e && e.message) || e}`); }
      j.finished = true; j.phase = out.ok ? 'done' : out.error === 'VIDEO_CANCELLED' ? 'cancelled' : 'failed';
      j.message = out.ok ? `✔ Trailer saved (${out.seconds} s).` : out.message;
      j.result = out;
      j.state.plan = { book: plan.book, title: plan.title, items: plan.items, music: plan.music || null, musicVolume: plan.musicVolume, width: plan.width, height: plan.height, fps: plan.fps, fade: plan.fade, model: plan.model || null };
      j.state.last = out.ok ? { ok: true, at: new Date().toISOString(), path: out.path, mp4: out.mp4, seconds: out.seconds, bytes: out.bytes, warnings: out.warnings } : { ok: false, at: new Date().toISOString(), error: out.error, message: out.message, shot: out.shot };
      writeState(dir, j.state);
      if (out.ok) dropOlder(dir, [out.path, out.mp4]);
      last = Object.assign({ at: Date.now() }, out, { status: publicJob(j) });
      log('trailer-done', { id: j.id, ok: !!out.ok, error: out.ok ? undefined : out.error, shot: out.shot, seconds: Math.round((Date.now() - j.startedAt) / 1000), reused: out.reused });
      if (deps.onDone) { try { deps.onDone(out); } catch (_) {} }
      return out;
    })();
    if (req && req.wait) return p;
    return { ok: true, started: true, id: j.id, book: plan.book, dir, seconds: plan.total, warnings: nz.warnings, status: publicJob(j) };
  }

  function status(o = {}) {
    const id = o && o.id;
    if (job && (!id || job.id === id)) {
      const out = { ok: true, busy: !job.finished, id: job.id, status: publicJob(job) };
      if (job.finished) out.result = job.result;
      return out;
    }
    if (id) return fail('NOT_FOUND', 'That trailer is not known (AutoInjector may have restarted).', 'Make the trailer again: finished shots are reused.');
    return { ok: true, busy: false, status: null, result: last };
  }
  async function cancel() {
    const j = job;
    if (!j || j.finished) return { ok: true, cancelled: false, message: 'No trailer is being made.' };
    j.cancelled = true;
    j.message = 'Stopping…';
    if (j.rec) { try { j.rec.abort(); } catch (_) {} }
    if (j.items.some((x) => x.status === 'rendering') && studio && typeof studio.cancel === 'function') { try { await studio.cancel(); } catch (_) {} }
    log('trailer-cancel', { id: j.id, phase: j.phase });
    return { ok: true, cancelled: true };
  }
  function list(o = {}) {
    let root; try { root = trailersDir(); } catch (_) { return { ok: true, items: [] }; }
    const want = o && o.book ? safeName(o.book) : null;
    const items = [];
    let names = []; try { names = fs.readdirSync(root); } catch (_) { names = []; }
    for (const name of names) {
      if (want && name !== want) continue;
      const dir = path.join(root, name);
      const st = readState(dir);
      const f = currentFiles(dir, st);
      if (!f.webm) continue;
      const webm = f.webm, mp4 = f.mp4;
      let mtime = 0; try { mtime = fs.statSync(webm).mtimeMs; } catch (_) {}
      items.push({ book: (st.plan && st.plan.book) || name, dir, path: webm, url: fileUrl(webm), mp4, mp4Url: mp4 ? fileUrl(mp4) : null, seconds: st.last && st.last.seconds, mtime, plan: st.plan || null });
    }
    items.sort((a, b) => b.mtime - a.mtime);
    return { ok: true, items, dir: root };
  }
  // The saved plan of a book's trailer (to edit it again).
  function plan(o = {}) {
    const book = o && o.book;
    if (!book) return bad('book', 'Which book? (book: its title)');
    let root; try { root = trailersDir(); } catch (_) { return { ok: true, plan: null }; }
    const st = readState(path.join(root, safeName(book)));
    return { ok: true, plan: st.plan || null, last: st.last || null };
  }

  return { make, status, cancel, list, plan, busy: () => !!(job && !job.finished) };
}

module.exports = { createTrailerMaker, normalizeTrailer, joinPlan, shotKey, findFfmpeg, ffmpegCandidates, mp4Args, safeName, LIMITS, DEFAULTS };
