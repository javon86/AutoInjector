'use strict';
/*
 * video-frames.js — 🧑‍⚖️ the video judge's eyes. AIs can't watch a video, so the judge looks at ONE picture: a contact
 * sheet of about 8 frames taken evenly across the clip, tiled in time order, each labelled with its frame number and
 * time (and, for picture → video, the starting picture as the first tile, labelled START). Next to it, a check that needs
 * no AI: frame-to-frame differences of up to 32 frames sampled across the clip flag a frozen video, sudden jumps and
 * flicker (brightness going up and down).
 *
 * Two ways to read frames, the same result (raw RGB frames of one size):
 *   • ffmpeg — when one is on this PC (found the way the 🎞 trailer finds it: video-trailer.js findFfmpeg). One run with a
 *     select filter → raw RGB on stdout. Quick and exact.
 *   • the app's own player — no ffmpeg: a hidden offscreen window (media-probe.html, no preload, no node) seeks a <video>
 *     to each time and draws it on a canvas (createElectronGrabber). The same way media-probe.js checks a clip plays.
 * The tiling, the labels (a tiny built-in pixel font) and the PNG are plain Node (zlib) — no new dependency.
 *
 *   planFrames({ frames, fps, seconds }, n)          → [{ index, time }] evenly across the clip
 *   createFfmpegGrabber({ bin, run })                → { grab(file, plan, w, h), picture(file, w, h) }
 *   createElectronGrabber({ electron, dir })         → the same, with the app's player
 *   motionCheck(frames, w, h)                        → { score 1-10, frozen, jumps:[…], flicker, diffs, words:[…] }
 *   buildSheet(frames, { w, h, cols, start })        → { png (Buffer), width, height, tiles }
 *   makeContactSheet({ file, record, out, grabber, startPicture }) → { ok, sheet, check, frames, how } | { ok:false, error, message }
 *   encodePng(rgb, w, h) · decodePng(buf) (8-bit RGB/RGBA/grey, for tests and for a PNG start picture)
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const childProcess = require('child_process');

const SHEET_FRAMES = 8;
const CHECK_FRAMES = 32;
const TILE_W = 320;

// ---------------------------------------------------------------- PNG (encode / decode)
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); }
function encodePng(rgb, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}
/** 8-bit, non-interlaced PNG (grey, RGB, grey+alpha, RGBA) → { rgb, w, h } | null */
function decodePng(buf) {
  try {
    if (!buf || buf.readUInt32BE(0) !== 0x89504e47) return null;
    let off = 8; let w = 0; let h = 0; let depth = 0; let ct = 0; let inter = 0; const idat = [];
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off); const type = buf.toString('latin1', off + 4, off + 8); const data = buf.slice(off + 8, off + 8 + len);
      if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ct = data[9]; inter = data[12]; }
      else if (type === 'IDAT') idat.push(data);
      else if (type === 'IEND') break;
      off += 12 + len;
    }
    const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
    if (depth !== 8 || !ch || inter) return null;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = w * ch; const out = Buffer.alloc(w * h * 3); const prev = Buffer.alloc(stride); const cur = Buffer.alloc(stride);
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)];
      raw.copy(cur, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
      for (let x = 0; x < stride; x++) {
        const a = x >= ch ? cur[x - ch] : 0; const b = prev[x]; const c = x >= ch ? prev[x - ch] : 0;
        let v = cur[x];
        if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
        else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        cur[x] = v & 0xff;
      }
      for (let x = 0; x < w; x++) { const s = x * ch; const d = (y * w + x) * 3; if (ch < 3) { out[d] = out[d + 1] = out[d + 2] = cur[s]; } else { out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]; } }
      cur.copy(prev);
    }
    return { rgb: out, w, h };
  } catch (_) { return null; }
}
function resizeRgb(rgb, w, h, W, H) { // nearest neighbour (enough for tiles and the check)
  const out = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) { const sy = Math.min(h - 1, Math.floor((y + 0.5) * h / H)); for (let x = 0; x < W; x++) { const sx = Math.min(w - 1, Math.floor((x + 0.5) * w / W)); const s = (sy * w + sx) * 3; const d = (y * W + x) * 3; out[d] = rgb[s]; out[d + 1] = rgb[s + 1]; out[d + 2] = rgb[s + 2]; } }
  return out;
}

// ---------------------------------------------------------------- which frames
function planFrames(info, n) {
  const fps = Number(info && info.fps) > 0 ? Number(info.fps) : 24;
  let total = Number(info && info.frames) > 0 ? Math.round(Number(info.frames)) : 0;
  if (!total && Number(info && info.seconds) > 0) total = Math.max(1, Math.round(Number(info.seconds) * fps));
  if (!total) total = Math.round(2 * fps);
  const k = Math.max(1, Math.min(n, total));
  const out = [];
  for (let i = 0; i < k; i++) { const index = k === 1 ? 0 : Math.round(i * (total - 1) / (k - 1)); if (!out.some((x) => x.index === index)) out.push({ index, time: Math.round(index / fps * 100) / 100 }); }
  return { fps, total, frames: out };
}
function tileSize(vw, vh) {
  const w = TILE_W; const ar = vw > 0 && vh > 0 ? vh / vw : 9 / 16;
  return { w, h: Math.max(64, Math.min(560, Math.round(w * ar / 2) * 2)) };
}

// ---------------------------------------------------------------- ffmpeg
function runDefault(bin, args, ms) {
  return new Promise((resolve) => {
    let child; try { child = childProcess.spawn(bin, args, { windowsHide: true }); } catch (e) { resolve({ ok: false, error: (e && e.code) || 'SPAWN' }); return; }
    const out = []; let outLen = 0; let err = '';
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve({ ok: false, error: 'TIMEOUT' }); }, ms || 120000);
    child.stdout.on('data', (d) => { out.push(d); outLen += d.length; if (outLen > 400 * 1024 * 1024) { try { child.kill('SIGKILL'); } catch (_) {} } });
    child.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    child.on('error', (e) => { clearTimeout(t); resolve({ ok: false, error: (e && e.code) || 'SPAWN' }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ ok: code === 0, code, stdout: Buffer.concat(out), stderr: err }); });
  });
}
function parseProbe(stderr) {
  const s = String(stderr || '');
  const d = s.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const v = s.match(/Stream[^\n]*Video:[^\n]*?(\d{2,5})x(\d{2,5})/);
  const f = s.match(/(\d+(?:\.\d+)?)\s*fps/);
  return { seconds: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0, width: v ? Number(v[1]) : 0, height: v ? Number(v[2]) : 0, fps: f ? Number(f[1]) : 0 };
}
function createFfmpegGrabber(o) {
  const bin = o.bin; const run = o.run || runDefault;
  async function probe(file) { const r = await run(bin, ['-hide_banner', '-i', file], 30000); return parseProbe(r.stderr); }
  async function grab(file, indices, w, h) {
    const sel = indices.map((i) => `eq(n\\,${i})`).join('+');
    const r = await run(bin, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `select='${sel}',scale=${w}:${h}`, '-vsync', 'vfr', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], 180000);
    if (!r.ok && !(r.stdout && r.stdout.length)) return { ok: false, error: r.error === 'TIMEOUT' ? 'FRAMES_TIMEOUT' : 'BAD_VIDEO', detail: String(r.stderr || r.error || '').split('\n').filter(Boolean).slice(-1)[0] || '' };
    const size = w * h * 3; const n = Math.floor(r.stdout.length / size);
    if (!n) return { ok: false, error: 'BAD_VIDEO', detail: String(r.stderr || '').split('\n').filter(Boolean).slice(-1)[0] || 'no frames came out' };
    const frames = []; for (let i = 0; i < n; i++) frames.push(r.stdout.slice(i * size, (i + 1) * size));
    return { ok: true, frames };
  }
  async function picture(file, w, h) {
    const r = await run(bin, ['-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', '1', '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], 30000);
    return r.stdout && r.stdout.length >= w * h * 3 ? r.stdout.slice(0, w * h * 3) : null;
  }
  return { how: 'ffmpeg', probe, grab, picture };
}

// ---------------------------------------------------------------- the app's own player (no ffmpeg)
function electronPageScript(url, times, w, h, ms) {
  return `new Promise((resolve) => {
    const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
    const c = document.createElement('canvas'); c.width = ${w}; c.height = ${h}; const g = c.getContext('2d', { willReadFrequently: true });
    const times = ${JSON.stringify(times)}; const out = []; let done = false;
    const end = (r) => { if (done) return; done = true; try { v.removeAttribute('src'); v.load(); } catch (_) {} resolve(r); };
    const t = setTimeout(() => end({ ok: false, error: 'FRAMES_TIMEOUT', frames: out }), ${ms});
    const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
    const next = () => {
      if (out.length >= times.length) { clearTimeout(t); end({ ok: true, frames: out, duration: v.duration, width: v.videoWidth, height: v.videoHeight }); return; }
      const want = Math.min(Math.max(0, times[out.length]), Math.max(0, (v.duration || 0) - 0.01));
      v.currentTime = want;
    };
    v.addEventListener('seeked', () => {
      try { g.drawImage(v, 0, 0, ${w}, ${h}); const d = g.getImageData(0, 0, ${w}, ${h}).data; const rgb = new Uint8Array(${w * h * 3}); for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { rgb[j] = d[i]; rgb[j + 1] = d[i + 1]; rgb[j + 2] = d[i + 2]; } out.push(b64(rgb)); }
      catch (e) { clearTimeout(t); end({ ok: false, error: 'BAD_VIDEO', detail: String(e && e.message || e) }); return; }
      next();
    });
    v.addEventListener('loadeddata', () => next(), { once: true });
    v.addEventListener('error', () => { clearTimeout(t); const e = v.error; end({ ok: false, error: 'BAD_VIDEO', detail: e ? ('media error ' + e.code) : 'the player could not read it' }); });
    v.src = ${JSON.stringify(url)}; document.body.appendChild(v);
  })`;
}
function electronPictureScript(url, w, h) {
  return `new Promise((resolve) => { const im = new Image(); im.onload = () => { const c = document.createElement('canvas'); c.width = ${w}; c.height = ${h}; const g = c.getContext('2d'); g.drawImage(im, 0, 0, ${w}, ${h}); const d = g.getImageData(0, 0, ${w}, ${h}).data; const rgb = new Uint8Array(${w * h * 3}); for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { rgb[j] = d[i]; rgb[j + 1] = d[i + 1]; rgb[j + 2] = d[i + 2]; } let s = ''; for (let i = 0; i < rgb.length; i += 0x8000) s += String.fromCharCode.apply(null, rgb.subarray(i, i + 0x8000)); resolve(btoa(s)); }; im.onerror = () => resolve(null); im.src = ${JSON.stringify(url)}; })`;
}
function createElectronGrabber(o) {
  const electron = o.electron; const dir = o.dir || __dirname; const limitMs = o.limitMs || 60000;
  const { pathToFileURL } = require('url');
  async function withWindow(fn) {
    if (!electron || !electron.BrowserWindow) return { ok: false, error: 'NO_PLAYER' };
    let win = null;
    try {
      win = new electron.BrowserWindow({ show: false, width: 400, height: 300, skipTaskbar: true, focusable: false, paintWhenInitiallyHidden: true,
        webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false } });
      await win.loadFile(path.join(dir, 'media-probe.html'));
      return await fn(win);
    } catch (e) { return { ok: false, error: 'BAD_VIDEO', detail: String((e && e.message) || e).slice(0, 200) }; }
    finally { try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {} }
  }
  async function grab(file, indices, w, h, fps) {
    const times = indices.map((i) => (i + 0.5) / (fps || 24));
    return withWindow(async (win) => {
      let timer = null;
      const r = await Promise.race([win.webContents.executeJavaScript(electronPageScript(pathToFileURL(file).href, times, w, h, limitMs), true), new Promise((res) => { timer = setTimeout(() => res({ ok: false, error: 'FRAMES_TIMEOUT' }), limitMs + 5000); })]);
      clearTimeout(timer);
      if (!r || !r.frames || !r.frames.length) return { ok: false, error: (r && r.error) || 'BAD_VIDEO', detail: (r && r.detail) || '' };
      return { ok: true, frames: r.frames.map((b) => Buffer.from(b, 'base64')) };
    });
  }
  async function picture(file, w, h) {
    const r = await withWindow(async (win) => ({ ok: true, b: await win.webContents.executeJavaScript(electronPictureScript(pathToFileURL(file).href, w, h), true) }));
    return r && r.ok && r.b ? Buffer.from(r.b, 'base64') : null;
  }
  async function probe(file) {
    const r = await withWindow(async (win) => win.webContents.executeJavaScript(require('./media-probe').pageScript(pathToFileURL(file).href, 20000), true));
    return r && r.ok ? { seconds: r.duration || 0, width: r.width || 0, height: r.height || 0, fps: 0 } : { seconds: 0, width: 0, height: 0, fps: 0, error: (r && r.error) || 'BAD_VIDEO' };
  }
  return { how: 'player', probe, grab, picture };
}

// ---------------------------------------------------------------- the no-AI motion check
function luma(rgb, w, h, W, H) { // a small grey picture (box average) for the comparison
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0; let n = 0;
    const y0 = Math.floor(y * h / H); const y1 = Math.max(y0 + 1, Math.floor((y + 1) * h / H)); const x0 = Math.floor(x * w / W); const x1 = Math.max(x0 + 1, Math.floor((x + 1) * w / W));
    for (let yy = y0; yy < y1; yy += 2) for (let xx = x0; xx < x1; xx += 2) { const i = (yy * w + xx) * 3; s += 0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2]; n++; }
    out[y * W + x] = n ? s / n : 0;
  }
  return out;
}
function median(a) { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; }
/** frames: [Buffer rgb] in time order (sampled evenly), indices: their frame numbers. */
function motionCheck(frames, w, h, indices) {
  const W = 32; const H = Math.max(8, Math.round(32 * h / w));
  const g = frames.map((f) => luma(f, w, h, W, H));
  const idx = indices || frames.map((_, i) => i);
  const diffs = []; const bright = g.map((p) => p.reduce((a, b) => a + b, 0) / p.length);
  for (let i = 1; i < g.length; i++) { let s = 0; for (let k = 0; k < g[i].length; k++) s += Math.abs(g[i][k] - g[i - 1][k]); diffs.push(Math.round(s / g[i].length * 100) / 100); }
  const words = [];
  if (g.length < 3) return { score: null, frozen: false, jumps: [], flicker: 0, diffs, words: ['too few frames to check'], sampled: g.length };
  const med = median(diffs); const max = Math.max(...diffs);
  const frozen = max < 0.6;
  const jumps = [];
  diffs.forEach((d, i) => { if (d > Math.max(14, med * 3.5)) jumps.push({ from: idx[i], to: idx[i + 1], diff: d }); });
  let flicker = 0;
  for (let i = 1; i < bright.length - 1; i++) { const a = bright[i] - bright[i - 1]; const b = bright[i + 1] - bright[i]; if (a * b < 0 && Math.abs(a) > 4 && Math.abs(b) > 4) flicker++; }
  let score = 10;
  if (frozen) { score = 2; words.push('the video hardly moves (frozen)'); }
  if (jumps.length) { score -= Math.min(6, 2 * jumps.length); words.push(`${jumps.length === 1 ? 'a sudden jump' : `${jumps.length} sudden jumps`} (${jumps.slice(0, 3).map((j) => `frames ${j.from}→${j.to}`).join(', ')})`); }
  if (flicker) { score -= Math.min(4, flicker); words.push(`the brightness flickers (${flicker} time${flicker === 1 ? '' : 's'})`); }
  if (!words.length) words.push('smooth: no jumps, no flicker, not frozen');
  return { score: Math.max(1, Math.min(10, score)), frozen, jumps, flicker, diffs, median: Math.round(med * 100) / 100, max: Math.round(max * 100) / 100, words, sampled: g.length };
}

// ---------------------------------------------------------------- the sheet
// A 5×7 pixel font for the labels (digits, a few letters and signs).
const FONT = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'], 1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'], 2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'], 4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'], 5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'], 7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'], 8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'], '#': ['01010', '01010', '11111', '01010', '11111', '01010', '01010'], '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  s: ['00000', '00000', '01110', '10000', '01110', '00001', '11110'], S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'], T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'], R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'], ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};
function drawText(rgb, W, x0, y0, text, scale, color) {
  let x = x0;
  for (const ch of String(text)) {
    const g = FONT[ch] || FONT[' '];
    for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if (g[r][c] === '1') for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) { const px = x + c * scale + dx; const py = y0 + r * scale + dy; const i = (py * W + px) * 3; if (i >= 0 && i + 2 < rgb.length && px < W) { rgb[i] = color[0]; rgb[i + 1] = color[1]; rgb[i + 2] = color[2]; } }
    x += 6 * scale;
  }
  return x;
}
/** frames: [{ rgb, label }] (tile size w×h). start: { rgb } (the same size) → the sheet as a PNG. */
function buildSheet(frames, o) {
  const w = o.w; const h = o.h; const gap = 4;
  const tiles = [...(o.start ? [{ rgb: o.start.rgb, label: 'START', start: true }] : []), ...frames];
  const cols = Math.min(o.cols || 4, tiles.length); const rows = Math.ceil(tiles.length / cols);
  const W = cols * w + (cols + 1) * gap; const H = rows * h + (rows + 1) * gap;
  const rgb = Buffer.alloc(W * H * 3, 24);
  tiles.forEach((t, k) => {
    const cx = gap + (k % cols) * (w + gap); const cy = gap + Math.floor(k / cols) * (h + gap);
    for (let y = 0; y < h; y++) t.rgb.copy(rgb, ((cy + y) * W + cx) * 3, y * w * 3, (y + 1) * w * 3);
    const scale = 2; const lw = String(t.label).length * 6 * scale + 6; const lh = 7 * scale + 6;
    for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) { const i = ((cy + y) * W + cx + x) * 3; rgb[i] = t.start ? 120 : 0; rgb[i + 1] = t.start ? 60 : 0; rgb[i + 2] = t.start ? 20 : 0; }
    drawText(rgb, W, cx + 3, cy + 3, t.label, scale, [255, 255, 255]);
  });
  return { png: encodePng(rgb, W, H), width: W, height: H, tiles: tiles.length, cols, rows };
}

/**
 * The contact sheet + the motion check for one video.
 * o: { file, record (its sidecar: frames, fps, seconds, width, height, mode, startPicture), out (the .png to write), grabber, startPicture (a path) }
 */
async function makeContactSheet(o) {
  const file = o.file; const rec = o.record || {};
  let st = null; try { st = fs.statSync(file); } catch (_) { st = null; }
  if (!st || !st.isFile()) return { ok: false, error: 'BAD_VIDEO', message: 'That video file could not be opened (moved or deleted?).' };
  if (st.size < 64) return { ok: false, error: 'BAD_VIDEO', message: 'That video file is empty or broken.' };
  const g = o.grabber;
  if (!g) return { ok: false, error: 'NO_FRAMES', message: 'This build cannot read video frames (no ffmpeg and no player).' };
  let info = { frames: rec.frames, fps: rec.fps, seconds: rec.seconds, width: rec.width, height: rec.height };
  if (!(info.frames > 0) || !(info.width > 0)) { const p = await g.probe(file).catch(() => null); if (p) info = { frames: info.frames || (p.seconds && (info.fps || p.fps) ? Math.round(p.seconds * (info.fps || p.fps)) : 0), fps: info.fps || p.fps || 24, seconds: info.seconds || p.seconds, width: info.width || p.width, height: info.height || p.height }; }
  const plan = planFrames(info, CHECK_FRAMES);
  const ts = tileSize(info.width, info.height);
  const r = await g.grab(file, plan.frames.map((x) => x.index), ts.w, ts.h, plan.fps);
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'BAD_VIDEO', message: r && r.error === 'FRAMES_TIMEOUT' ? 'Reading the video\'s frames took too long.' : `The video's frames could not be read — the file may be broken${r && r.detail ? ` (${String(r.detail).slice(0, 120)})` : ''}.` };
  const got = plan.frames.slice(0, r.frames.length);
  const check = motionCheck(r.frames, ts.w, ts.h, got.map((x) => x.index));
  // about 8 for the sheet, evenly from the sampled ones
  const k = Math.min(SHEET_FRAMES, got.length); const pick = [];
  for (let i = 0; i < k; i++) { const j = k === 1 ? 0 : Math.round(i * (got.length - 1) / (k - 1)); if (!pick.includes(j)) pick.push(j); }
  const frames = pick.map((j) => ({ rgb: r.frames[j], label: `#${got[j].index} ${got[j].time.toFixed(1)}s`, index: got[j].index, time: got[j].time }));
  let start = null;
  const sp = o.startPicture || (rec.startPicture && rec.startPicture.path) || '';
  if (sp && fs.existsSync(sp)) {
    let rgb = null;
    try { const d = decodePng(fs.readFileSync(sp)); if (d) rgb = resizeRgb(d.rgb, d.w, d.h, ts.w, ts.h); } catch (_) { rgb = null; }
    if (!rgb && g.picture) { try { rgb = await g.picture(sp, ts.w, ts.h); } catch (_) { rgb = null; } }
    if (rgb) start = { rgb };
  }
  const sheet = buildSheet(frames, { w: ts.w, h: ts.h, cols: 4, start });
  if (o.out) { try { fs.mkdirSync(path.dirname(o.out), { recursive: true }); fs.writeFileSync(o.out, sheet.png); } catch (e) { return { ok: false, error: 'SAVE_FAILED', message: `The contact sheet could not be saved (${e.code || e.message}).` }; } }
  return { ok: true, sheet: o.out || null, png: o.out ? undefined : sheet.png, width: sheet.width, height: sheet.height, tiles: sheet.tiles, hasStart: !!start, frames: frames.map((f) => ({ index: f.index, time: f.time })), total: plan.total, check, how: g.how };
}

module.exports = { planFrames, tileSize, createFfmpegGrabber, createElectronGrabber, electronPageScript, motionCheck, buildSheet, makeContactSheet, encodePng, decodePng, resizeRgb, parseProbe, SHEET_FRAMES, CHECK_FRAMES };
