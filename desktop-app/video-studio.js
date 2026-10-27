'use strict';
/*
 * video-studio.js — the 🎬 Video engine, Electron-free so it is testable.
 * Two backends:
 *   • "comfy-wan" — the ComfyUI AutoInjector already installs / starts / connects for
 *     pictures (sd-installer / sd-runner / sd-backends). Video is a graph of core
 *     ComfyUI nodes with a Wan model (docs/VIDEO_API.md):
 *       UNETLoader → ModelSamplingSD3(shift) ┐
 *       CLIPLoader(type wan) → CLIPTextEncode ± ├→ KSampler → VAEDecode → CreateVideo(fps) → SaveVideo (mp4)
 *       Wan22ImageToVideoLatent(vae, size, frames, start_image?) | EmptyHunyuanLatentVideo ┘
 *                                                        VAEDecode → ImageFromBatch(0) → SaveImage (the poster)
 *     A ComfyUI without SaveVideo saves .webm with SaveWEBM instead.
 *   • "endpoint" — the old generic text-to-video URL (video-provider.js), kept as a fallback.
 * text→video = generate(), picture→video = animate() (the picture is uploaded to ComfyUI).
 * The clip lands in videos/ with a .json sidecar (every setting) and a .png poster.
 * One video at a time; progress() / cancel() work while it renders.
 *
 * main.js passes: comfy(o) → Promise<{ base, label, source } | null> (o.start: start the
 * managed ComfyUI when none answers), installer (video-installer.js), library (character
 * locks), videoProvider, videosDir(), fileUrl(p), log(type, data), persist(settings),
 * settings (saved), toPng(buf) (optional: any picture → PNG), recordVideo(entry) (optional).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sdBackends = require('./sd-backends');
const VI = require('./video-installer');
const VE = require('./video-errors');
const { fmtBytes } = require('./sd-installer');

const PURPOSES = ['clip', 'trailer_shot', 'free', 'test'];
const BACKENDS = ['auto', 'comfy-wan', 'endpoint'];
const DEFAULT_NEGATIVE = 'static, still picture, frozen, blurry, low quality, jpeg artifacts, distorted, deformed face, deformed hands, extra fingers, watermark, text, subtitles, oversaturated, overexposed';
const IDLE_PROMPT = 'subtle natural motion, breathing, slight movement of hair and cloth, camera still';
const BASE_NODES = ['UNETLoader', 'CLIPLoader', 'VAELoader', 'ModelSamplingSD3', 'CLIPTextEncode', 'KSampler', 'VAEDecode'];
const FAMILY_NODES = { wan22: ['Wan22ImageToVideoLatent'], wan21: ['EmptyHunyuanLatentVideo'] };
const SAVE_NODES = ['CreateVideo', 'SaveVideo', 'SaveWEBM'];
const POSTER_NODES = ['ImageFromBatch', 'SaveImage'];
const ALL_NODES = [...new Set([...BASE_NODES, ...FAMILY_NODES.wan22, ...FAMILY_NODES.wan21, 'LoadImage', ...SAVE_NODES, ...POSTER_NODES])];
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const DEFAULT_SETTINGS = { backend: 'auto', model: VI.DEFAULT_MODEL, comfyUrl: '', timeoutMs: 45 * 60 * 1000 };

// --------------------------------------------------------------- small helpers
const isNum = (v) => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const bad = (field, message, hint) => ({ ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', field, message, hint: hint || '' });
function fail(code, message, fix, extra) { return Object.assign({ ok: false, error: code, code, message, fix: fix || '' }, extra || {}); }
function snapFrames(n, maxFrames) { const k = Math.max(1, Math.round((Number(n) - 1) / 4)); return clamp(4 * k + 1, 5, maxFrames); }
function snapSide(n, step, lo, hi) { return clamp(Math.round(Number(n) / step) * step, lo, Math.floor(hi / step) * step); }

// Width × height of a PNG / JPEG / WEBP / GIF from its bytes (null when unknown).
function imageSize(buf) {
  try {
    if (!buf || buf.length < 24) return null;
    if (buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), type: 'png' };
    if (buf.slice(0, 6).toString('latin1') === 'GIF89a' || buf.slice(0, 6).toString('latin1') === 'GIF87a') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), type: 'gif' };
    if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') {
      const kind = buf.slice(12, 16).toString('latin1');
      if (kind === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3), type: 'webp' };
      if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, type: 'webp' };
      if (kind === 'VP8L') { const b = buf.readUInt32LE(21); return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff), type: 'webp' }; }
      return { width: 0, height: 0, type: 'webp' };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), type: 'jpeg' };
        i += 2 + len;
      }
      return { width: 0, height: 0, type: 'jpeg' };
    }
  } catch (_) {}
  return null;
}

// A picture given as a file path, a data: URL or plain base64 → { buf, type, width, height, sourcePath }.
function readImage(img) {
  if (img == null || img === '') return { error: bad('image', 'Picture→video needs a picture (image: a file path or base64).') };
  if (typeof img !== 'string') return { error: bad('image', 'image must be a file path or a base64 string.') };
  const s = img.trim();
  let buf = null; let sourcePath = null;
  const dataUrl = s.match(/^data:image\/[\w.+-]+;base64,(.*)$/s);
  if (dataUrl) buf = Buffer.from(dataUrl[1], 'base64');
  else if (s.length < 2048 && (/[\\/]/.test(s) || /\.(png|jpe?g|webp|gif)$/i.test(s))) {
    let p = s;
    if (/^file:\/\//i.test(p)) { try { p = require('url').fileURLToPath(p); } catch (_) {} }
    let st; try { st = fs.statSync(p); } catch (_) { return { error: bad('image', `The picture “${s}” was not found.`, 'Give the full path of a .png / .jpg / .webp file, or the picture as base64.') }; }
    if (!st.isFile()) return { error: bad('image', `“${s}” is not a file.`) };
    if (st.size > MAX_IMAGE_BYTES) return { error: bad('image', 'The picture is too big (over 25 MB).') };
    try { buf = fs.readFileSync(p); sourcePath = p; } catch (e) { return { error: bad('image', `The picture could not be read (${e.code || e.message}).`) }; }
  } else if (/^[A-Za-z0-9+/=\s]+$/.test(s) && s.length > 32) buf = Buffer.from(s.replace(/\s+/g, ''), 'base64');
  else return { error: bad('image', 'image is neither a picture file path nor base64.') };
  if (!buf || !buf.length) return { error: bad('image', 'The picture is empty.') };
  if (buf.length > MAX_IMAGE_BYTES) return { error: bad('image', 'The picture is too big (over 25 MB).') };
  const size = imageSize(buf);
  if (!size) return { error: bad('image', 'That is not a picture AutoInjector can read (use PNG, JPEG or WEBP).') };
  return { buf, type: size.type, width: size.width, height: size.height, sourcePath };
}

// Fit a picture's shape into the model's pixel budget (its default size's area), on the model's grid.
function fitSize(w, h, model) {
  const d = model.defaults; const L = model.limits;
  if (!(w > 0 && h > 0)) return { width: d.width, height: d.height };
  const area = d.width * d.height;
  const k = Math.sqrt(area / (w * h));
  let W = snapSide(w * k, L.sizeStep, L.minSide, L.maxSide); let H = snapSide(h * k, L.sizeStep, L.minSide, L.maxSide);
  // Clamping one side may have pushed the other past the budget: shrink to keep the shape.
  if (W * H > area * 1.08) { const s = Math.sqrt(area / (W * H)); W = snapSide(W * s, L.sizeStep, L.minSide, L.maxSide); H = snapSide(H * s, L.sizeStep, L.minSide, L.maxSide); }
  return { width: W, height: H };
}

// Every param checked and clamped to the model → { params, warnings } | { error }.
// mode: 't2v' | 'i2v'. ctx: { settings, models, imageInfo }
const PARAM_KEYS = ['prompt', 'negativePrompt', 'image', 'width', 'height', 'seconds', 'frames', 'fps', 'model', 'steps', 'cfgScale', 'seed', 'sampler', 'scheduler', 'shift', 'characterLock', 'purpose', 'from', 'book', 'returnPoster', 'backend', 'timeoutMs'];
function normalize(mode, req, ctx = {}) {
  const r = req || {};
  const models = ctx.models || VI.MODELS;
  const warnings = [];
  const warn = (field, message) => warnings.push({ level: 'soft', field, message });
  // model
  let modelId = r.model != null && r.model !== '' ? String(r.model) : ((ctx.settings && ctx.settings.model) || VI.DEFAULT_MODEL);
  if (!models[modelId]) return { error: bad('model', `There is no video model “${r.model}”.`, `model is one of: ${Object.keys(models).join(', ')}.`) };
  if (mode === 'i2v' && !models[modelId].modes.includes('i2v')) {
    if (r.model != null && r.model !== '') return { error: bad('model', `${models[modelId].short} makes video from text only — it can't animate a picture.`, `Use model "${VI.DEFAULT_MODEL}" for picture→video.`) };
    modelId = VI.DEFAULT_MODEL;
  }
  const M = models[modelId]; const d = M.defaults; const L = M.limits;
  // purpose
  const purpose = r.purpose == null || r.purpose === '' ? 'free' : String(r.purpose);
  if (!PURPOSES.includes(purpose)) return { error: bad('purpose', `“${r.purpose}” is not a purpose.`, 'purpose is "clip", "trailer_shot" or "free".') };
  // numbers
  for (const k of ['width', 'height', 'seconds', 'frames', 'fps', 'steps', 'cfgScale', 'seed', 'shift']) {
    if (r[k] !== undefined && r[k] !== null && r[k] !== '' && !isNum(r[k])) return { error: bad(k, `${k} must be a number (got “${r[k]}”).`) };
  }
  for (const k of ['prompt', 'negativePrompt', 'sampler', 'scheduler', 'characterLock', 'from', 'book']) {
    if (r[k] !== undefined && r[k] !== null && typeof r[k] !== 'string') return { error: bad(k, `${k} must be text.`) };
  }
  const fps = clamp(Math.round(isNum(r.fps) ? Number(r.fps) : d.fps), L.minFps, L.maxFps);
  if (isNum(r.fps) && fps !== Number(r.fps)) warn('fps', `fps ${r.fps} → ${fps} (${L.minFps}–${L.maxFps}).`);
  let want;
  if (isNum(r.frames)) want = Number(r.frames);
  else if (isNum(r.seconds)) { if (Number(r.seconds) <= 0) return { error: bad('seconds', 'seconds must be more than 0.') }; want = Number(r.seconds) * fps + 1; }
  else if (purpose === 'clip') want = 4 * fps + 1;
  else if (purpose === 'trailer_shot') want = 5 * fps + 1;
  else if (purpose === 'test') want = fps + 1;
  else want = d.frames;
  const frames = snapFrames(want, L.maxFrames);
  if ((isNum(r.frames) || isNum(r.seconds)) && Math.abs(frames - want) > 2) warn(isNum(r.frames) ? 'frames' : 'seconds', `${M.short} makes ${frames} frames (${(frames / fps).toFixed(1)} s at ${fps} fps) — frames must be 4n+1, at most ${L.maxFrames}.`);
  // size
  let width; let height;
  if (isNum(r.width) || isNum(r.height)) {
    const w0 = isNum(r.width) ? Number(r.width) : (isNum(r.height) && ctx.imageInfo && ctx.imageInfo.height ? Number(r.height) * ctx.imageInfo.width / ctx.imageInfo.height : d.width);
    const h0 = isNum(r.height) ? Number(r.height) : (ctx.imageInfo && ctx.imageInfo.width ? w0 * ctx.imageInfo.height / ctx.imageInfo.width : d.height);
    width = snapSide(w0, L.sizeStep, L.minSide, L.maxSide); height = snapSide(h0, L.sizeStep, L.minSide, L.maxSide);
    if ((isNum(r.width) && width !== Number(r.width)) || (isNum(r.height) && height !== Number(r.height))) warn('size', `Size → ${width}×${height} (${M.short} needs multiples of ${L.sizeStep}, ${L.minSide}–${L.maxSide} px).`);
  } else if (mode === 'i2v' && ctx.imageInfo && ctx.imageInfo.width) ({ width, height } = fitSize(ctx.imageInfo.width, ctx.imageInfo.height, M));
  else if (purpose === 'test') { width = snapSide(d.width / 2, L.sizeStep, L.minSide, L.maxSide); height = snapSide(d.height / 2, L.sizeStep, L.minSide, L.maxSide); }
  else { width = d.width; height = d.height; }
  const steps = clamp(Math.round(isNum(r.steps) ? Number(r.steps) : (purpose === 'test' ? Math.min(8, d.steps) : d.steps)), 1, 100);
  if (isNum(r.steps) && steps !== Number(r.steps)) warn('steps', `steps → ${steps} (1–100).`);
  const cfgScale = clamp(isNum(r.cfgScale) ? Number(r.cfgScale) : d.cfgScale, 1, 20);
  if (isNum(r.cfgScale) && cfgScale !== Number(r.cfgScale)) warn('cfgScale', `cfgScale → ${cfgScale} (1–20).`);
  const shift = clamp(isNum(r.shift) ? Number(r.shift) : d.shift, 0, 20);
  const seed = !isNum(r.seed) || Number(r.seed) < 0 ? sdBackends.randomSeed() : Math.min(Math.floor(Number(r.seed)), Number.MAX_SAFE_INTEGER);
  const prompt = String(r.prompt || '').trim().slice(0, 4000);
  const negativePrompt = r.negativePrompt == null ? DEFAULT_NEGATIVE : String(r.negativePrompt).slice(0, 4000);
  const params = {
    mode, model: modelId, prompt, negativePrompt, width, height, frames, fps, seconds: Math.round((frames - 1) / fps * 100) / 100,
    steps, cfgScale, shift, seed, sampler: String(r.sampler || d.sampler), scheduler: String(r.scheduler || d.scheduler), purpose,
    characterLock: r.characterLock ? String(r.characterLock).slice(0, 200) : undefined, from: r.from ? String(r.from).slice(0, 60) : undefined, book: r.book ? String(r.book).slice(0, 200) : undefined,
  };
  return { params, warnings };
}

// -------------------------------------------------------------- the Wan graph
// p: normalized params + imageName (uploaded) for i2v. o: { save: 'SaveVideo'|'SaveWEBM', poster: bool, clipDevice: bool, prefix }
function buildWanGraph(p, model, o = {}) {
  const M = typeof model === 'string' ? VI.MODELS[model] : model;
  const file = (kind) => (o.names && o.names[kind]) || M.files.find((f) => f.kind === kind).name;
  const prefix = o.prefix || 'video/AutoInjector';
  const clip = { clip_name: file('text_encoders'), type: 'wan' };
  if (o.clipDevice !== false) clip.device = 'default';
  const g = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: file('diffusion_models'), weight_dtype: 'default' }, _meta: { title: 'Load Wan model' } },
    2: { class_type: 'CLIPLoader', inputs: clip, _meta: { title: 'Load text encoder (umt5)' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: file('vae') }, _meta: { title: 'Load VAE' } },
    4: { class_type: 'ModelSamplingSD3', inputs: { model: ['1', 0], shift: p.shift } },
    5: { class_type: 'CLIPTextEncode', inputs: { text: p.prompt, clip: ['2', 0] }, _meta: { title: 'Positive' } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: p.negativePrompt || '', clip: ['2', 0] }, _meta: { title: 'Negative' } },
  };
  if (M.family === 'wan22') {
    g[7] = { class_type: 'Wan22ImageToVideoLatent', inputs: { vae: ['3', 0], width: p.width, height: p.height, length: p.frames, batch_size: 1 } };
    if (p.mode === 'i2v') { g[8] = { class_type: 'LoadImage', inputs: { image: p.imageName } }; g[7].inputs.start_image = ['8', 0]; }
  } else {
    g[7] = { class_type: 'EmptyHunyuanLatentVideo', inputs: { width: p.width, height: p.height, length: p.frames, batch_size: 1 } };
  }
  g[9] = { class_type: 'KSampler', inputs: { model: ['4', 0], positive: ['5', 0], negative: ['6', 0], latent_image: ['7', 0], seed: p.seed, steps: p.steps, cfg: p.cfgScale, sampler_name: p.sampler, scheduler: p.scheduler, denoise: 1 } };
  g[10] = { class_type: 'VAEDecode', inputs: { samples: ['9', 0], vae: ['3', 0] } };
  if ((o.save || 'SaveVideo') === 'SaveWEBM') g[12] = { class_type: 'SaveWEBM', inputs: { images: ['10', 0], filename_prefix: prefix, codec: 'vp9', fps: p.fps, crf: 32 } };
  else {
    g[11] = { class_type: 'CreateVideo', inputs: { images: ['10', 0], fps: p.fps } };
    g[12] = { class_type: 'SaveVideo', inputs: { video: ['11', 0], filename_prefix: prefix, format: 'auto', codec: 'auto' } };
  }
  if (o.poster !== false) {
    g[13] = { class_type: 'ImageFromBatch', inputs: { image: ['10', 0], batch_index: 0, length: 1 } };
    g[14] = { class_type: 'SaveImage', inputs: { images: ['13', 0], filename_prefix: `${prefix}-poster` } };
  }
  const out = {};
  for (const k of Object.keys(g)) out[String(k)] = g[k];
  return out;
}

// -------------------------------------------------------------- ComfyUI facts
// What the connected ComfyUI has: nodes, model names, samplers. → { ok, nodes:Set, unets, clips, vaes, samplers, schedulers, clipDevice, clipTypes }
async function comfyFacts(base, ms = 8000) {
  const rs = await Promise.all(ALL_NODES.map((n) => sdBackends.getJson(`${base}/object_info/${n}`, ms)));
  const first = rs[0];
  if (!first.ok && (first.error === 'REFUSED' || first.error === 'TIMEOUT')) return { ok: false, error: first.error };
  const info = Object.assign({}, ...rs.map((r) => (r.ok && r.json && typeof r.json === 'object' ? r.json : {})));
  const opt = (node, name) => { const n = info[node]; const i = n && n.input ? Object.assign({}, n.input.required || {}, n.input.optional || {}) : {}; return sdBackends.comboOptions(i[name]); };
  const has = (node, name) => { const n = info[node]; return !!(n && n.input && ((n.input.required && n.input.required[name]) || (n.input.optional && n.input.optional[name]))); };
  return {
    ok: true, nodes: new Set(Object.keys(info)),
    unets: opt('UNETLoader', 'unet_name'), clips: opt('CLIPLoader', 'clip_name'), vaes: opt('VAELoader', 'vae_name'),
    samplers: opt('KSampler', 'sampler_name'), schedulers: opt('KSampler', 'scheduler'),
    clipTypes: opt('CLIPLoader', 'type'), clipDevice: has('CLIPLoader', 'device'),
  };
}
// ComfyUI's spelling of a file (it may sit in a subfolder: "wan/x.safetensors").
function comfyName(list, file) {
  if (!Array.isArray(list) || !list.length) return null;
  return list.find((x) => x === file) || list.find((x) => String(x).replace(/\\/g, '/').split('/').pop() === file) || null;
}

// --------------------------------------------------------------- the studio
function createVideoStudio(deps = {}) {
  const log = deps.log || (() => {});
  const fileUrl = deps.fileUrl || ((p) => p);
  const lib = deps.library || null;
  const vp = deps.videoProvider || null;
  const installer = () => (typeof deps.installer === 'function' ? deps.installer() : deps.installer) || null;
  const comfyOf = deps.comfy || (async () => null);
  const persist = deps.persist || (() => {});
  const pollMs = deps.pollMs || 1000;
  let settings = Object.assign({}, DEFAULT_SETTINGS, deps.settings || {});
  let current = null; // the running job
  let last = null; // the last result (short)
  let factsCache = null; // { base, at, facts }

  function videosDir() { const d = deps.videosDir(); fs.mkdirSync(d, { recursive: true }); return d; }
  const models = () => VI.MODELS;

  async function facts(base, fresh) {
    if (!fresh && factsCache && factsCache.base === base && Date.now() - factsCache.at < 15000) return factsCache.facts;
    const f = await comfyFacts(base);
    if (f.ok) factsCache = { base, at: Date.now(), facts: f };
    return f;
  }
  async function connection(start) {
    try { const c = await comfyOf({ start: !!start, url: settings.comfyUrl }); return c && c.base ? c : null; }
    catch (_) { return null; }
  }
  function endpointState() {
    try { const s = vp ? vp.status() : null; return s ? { configured: !!s.configured, enabled: !!s.enabled, endpoint: s.endpoint || '' } : { configured: false, enabled: false, endpoint: '' }; }
    catch (_) { return { configured: false, enabled: false, endpoint: '' }; }
  }
  const endpointReady = () => { const e = endpointState(); return e.configured && e.enabled; };

  // Which model files the connected ComfyUI lists (for the installer's check).
  function listedOf(f) { return f && f.ok ? { diffusion_models: f.unets, text_encoders: f.clips, vae: f.vaes } : null; }
  function installCheck(f) { const i = installer(); if (!i) return { ok: false, error: 'NOT_WIRED', models: [], installed: [] }; try { return i.check(listedOf(f)); } catch (e) { return { ok: false, error: 'INTERNAL', message: String((e && e.message) || e), models: [], installed: [] }; } }

  // ---- status: what is set up, what is missing, which backend video would use now
  async function status(o = {}) {
    const c = await connection(false);
    const f = c ? await facts(c.base, !!o.fresh) : null;
    const chk = installCheck(f && f.ok ? f : null);
    const ep = endpointState();
    const installed = chk.installed || [];
    const missingNodes = f && f.ok ? [...BASE_NODES, ...FAMILY_NODES.wan22].filter((n) => !f.nodes.has(n)) : [];
    const canSave = f && f.ok ? (f.nodes.has('SaveVideo') && f.nodes.has('CreateVideo')) || f.nodes.has('SaveWEBM') : false;
    const comfyReady = !!(c && f && f.ok && installed.length && !missingNodes.length && canSave);
    let backend = '';
    if (settings.backend === 'endpoint') backend = ep.configured && ep.enabled ? 'endpoint' : '';
    else if (settings.backend === 'comfy-wan') backend = comfyReady ? 'comfy-wan' : '';
    else backend = comfyReady ? 'comfy-wan' : ep.configured && ep.enabled ? 'endpoint' : '';
    let message;
    if (backend === 'comfy-wan') message = `✔ Ready: ComfyUI on ${c.base} with ${installed.map((id) => VI.MODELS[id].short).join(' + ')}.`;
    else if (backend === 'endpoint') message = `✔ Ready: the video server at ${ep.endpoint} (Advanced: other video server).`;
    else if (c && f && f.ok && missingNodes.length) message = `ComfyUI on ${c.base} is too old for Wan video (missing ${missingNodes.join(', ')}). Update ComfyUI.`;
    else if (c && f && f.ok && !installed.length) message = `ComfyUI is connected (${c.base}), but no video model is downloaded yet. Download ${VI.MODELS[VI.DEFAULT_MODEL].short} in 🎬 Video → Setup.`;
    else if (!c && chk.anyComfy) message = `ComfyUI is installed (${chk.roots[0].source}) but not running. Press “▶ Start ComfyUI”${installed.length ? '' : ', then download a video model'}.`;
    else message = 'Video is not set up yet. Press “Install ComfyUI + video model” in 🎬 Video (one click), or start your own ComfyUI.';
    const i = installer();
    return {
      ok: true, ready: !!backend, backend, message, busy: !!current,
      job: current ? { mode: current.mode, model: current.model, seconds: Math.round((Date.now() - current.startedAt) / 1000), phase: current.phase } : null,
      comfy: c ? { connected: !!(f && f.ok), base: c.base, label: c.label || 'ComfyUI', source: c.source || '', missingNodes, canSave, saveFormat: f && f.ok ? (f.nodes.has('SaveVideo') ? 'mp4' : f.nodes.has('SaveWEBM') ? 'webm' : '') : '' } : { connected: false, installed: !!chk.anyComfy },
      endpoint: ep, models: (chk.models || []).map((m) => ({ id: m.id, label: m.label, short: m.short, installed: m.installed, missing: m.missing, modes: m.modes, vramGB: m.vramGB, sizeText: m.sizeText, default: m.default })),
      installed, defaultModel: VI.DEFAULT_MODEL, settings: Object.assign({}, settings), install: i ? i.status() : null, last,
    };
  }
  // The short answer for GET /video/backend.
  async function backendInfo() {
    const s = await status();
    return { ok: true, ready: s.ready, backend: s.backend, message: s.message, busy: s.busy, comfy: s.comfy, endpoint: { configured: s.endpoint.configured, enabled: s.endpoint.enabled }, installed: s.installed, defaultModel: s.defaultModel,
      models: s.models.map((m) => ({ id: m.id, installed: m.installed, modes: m.modes, vramGB: m.vramGB })) };
  }
  async function modelsInfo() {
    const c = await connection(false);
    const f = c ? await facts(c.base, true) : null;
    const chk = installCheck(f && f.ok ? f : null);
    return Object.assign({}, chk, { ok: chk.ok !== false, comfy: c ? { base: c.base, connected: !!(f && f.ok) } : null });
  }

  function setSettings(patch) {
    const p = patch || {};
    const next = Object.assign({}, settings);
    if (p.backend !== undefined) { if (!BACKENDS.includes(p.backend)) return bad('backend', `“${p.backend}” is not a video backend.`, 'backend is "auto", "comfy-wan" or "endpoint".'); next.backend = p.backend; }
    if (p.model !== undefined) { if (!VI.MODELS[p.model]) return bad('model', `There is no video model “${p.model}”.`, `model is one of: ${Object.keys(VI.MODELS).join(', ')}.`); next.model = p.model; }
    if (p.comfyUrl !== undefined) { const b = p.comfyUrl ? sdBackends.baseOf(p.comfyUrl) : ''; if (p.comfyUrl && !b) return bad('comfyUrl', 'That address doesn\'t look right (e.g. http://127.0.0.1:8188).'); next.comfyUrl = b; }
    if (p.timeoutMs !== undefined) { if (!isNum(p.timeoutMs)) return bad('timeoutMs', 'timeoutMs must be a number.'); next.timeoutMs = clamp(Math.round(Number(p.timeoutMs)), 60000, 6 * 3600000); }
    settings = next; factsCache = null;
    try { persist(Object.assign({}, settings)); } catch (_) {}
    log('video-settings', { backend: settings.backend, model: settings.model, comfyUrl: !!settings.comfyUrl });
    return { ok: true, settings: Object.assign({}, settings) };
  }

  // ---- making a video
  function lockApply(n) {
    if (!n.characterLock) return null;
    if (!lib || typeof lib.getLock !== 'function') return { error: fail('NO_LOCK', 'Character locks are not available in this build.') };
    const lock = lib.getLock(n.characterLock);
    if (!lock) return { error: fail('NO_LOCK', `There's no character lock called “${n.characterLock}”.`, 'Make one in 🎨 Images → Character locks, or leave characterLock out.') };
    const a = typeof lib.applyLock === 'function' ? lib.applyLock(lock, { prompt: n.prompt, negativePrompt: n.negativePrompt }) : null;
    const looks = [...(lock.triggerWords || []), lock.prompt].map((s) => String(s || '').trim()).filter(Boolean);
    return { lock, prompt: a ? a.prompt : [...looks, n.prompt].filter(Boolean).join(', '), negativePrompt: a ? a.negativePrompt : [lock.negative, n.negativePrompt].filter(Boolean).join(', ') };
  }

  async function make(mode, req, from) {
    const r = Object.assign({}, req || {});
    if (current) return fail('BUSY', `A video is already being made (${Math.round((Date.now() - current.startedAt) / 1000)} s so far).`, 'Wait for it (video.progress) or stop it (video.cancel).');
    // picture first (its shape decides the size)
    let image = null;
    if (mode === 'i2v') { image = readImage(r.image); if (image.error) return image.error; }
    else if (r.image != null && r.image !== '') return bad('image', 'video.generate is text→video; use video.animate for a picture.');
    const nz = normalize(mode, r, { settings, imageInfo: image ? { width: image.width, height: image.height } : null });
    if (nz.error) return nz.error;
    const p = nz.params; const warnings = nz.warnings;
    const lk = lockApply(p);
    if (lk && lk.error) return lk.error;
    if (lk) { p.prompt = lk.prompt; p.negativePrompt = lk.negativePrompt; p.lock = { id: lk.lock.id, character: lk.lock.character, book: lk.lock.book }; }
    if (!p.prompt) { if (mode === 'i2v') p.prompt = IDLE_PROMPT; else return fail('NEED_PROMPT', 'Describe the video first (prompt), or give a characterLock.', '', { error: 'NEED_PROMPT' }); }
    // which backend
    const want = r.backend && BACKENDS.includes(r.backend) ? r.backend : settings.backend;
    const job = { id: crypto.randomUUID(), mode, model: p.model, startedAt: Date.now(), phase: 'starting', cancelled: false, from: from || 'video-tab', noWs: !!deps.noWs };
    current = job;
    try {
      let out;
      if (want === 'endpoint') out = await viaEndpoint(p, job);
      else {
        const c = await connection(true);
        if (!c) {
          if (want === 'auto' && endpointReady()) out = await viaEndpoint(p, job);
          else { const chk = installCheck(null); out = fail('VIDEO_NOT_SET_UP', chk.anyComfy ? 'ComfyUI is installed but not running, and AutoInjector could not start it.' : 'Video is not set up: there is no ComfyUI to make it.', chk.anyComfy ? 'Open 🎬 Video and press “▶ Start ComfyUI”, then try again.' : 'Open 🎬 Video and press “Install ComfyUI + video model” (one click), or start your own ComfyUI.', { engine: 'comfy-wan' }); }
        } else {
          const f = await facts(c.base, true);
          const comfyReady = f.ok && !!comfyName(f.unets, VI.MODELS[p.model].files[0].name);
          if (want === 'auto' && !comfyReady && endpointReady() && f.ok && !Object.keys(VI.MODELS).some((id) => comfyName(f.unets, VI.MODELS[id].files[0].name))) out = await viaEndpoint(p, job);
          else out = await viaComfy(c, f, p, image, job, warnings, r);
        }
      }
      if (out.ok) out.warnings = warnings.concat(out.warnings || []);
      last = out.ok ? { ok: true, path: out.path, poster: out.poster, engine: out.engine, model: out.model, seconds: out.seconds, at: Date.now() } : { ok: false, error: out.error, message: out.message, at: Date.now() };
      log('video-generate', { ok: out.ok, from: job.from, mode, engine: out.engine, model: p.model, error: out.ok ? undefined : out.error, seconds: Math.round((Date.now() - job.startedAt) / 1000), frames: p.frames, size: `${p.width}x${p.height}` });
      return out;
    } catch (e) {
      log('video-generate', { ok: false, from: job.from, error: 'INTERNAL', detail: String((e && e.message) || e).slice(0, 200) });
      return fail('VIDEO_FAILED', `Something went wrong: ${(e && e.message) || e}`);
    } finally { if (current === job) current = null; }
  }

  function explain(r, base, model, engine) {
    const ex = VE.explainVideoError(r, { base, model, models: Object.values(VI.MODELS) });
    const out = { ok: false, engine, error: ex.code, code: ex.code, message: ex.message, fix: ex.fix };
    if (ex.model) out.model = ex.model;
    if (ex.cause) out.cause = ex.cause;
    if (ex.details) out.serverError = ex.details;
    return out;
  }

  async function viaComfy(c, f, p, image, job, warnings, req) {
    const base = c.base; const M = VI.MODELS[p.model];
    if (!f.ok) return explain({ error: f.error || 'REFUSED' }, base, p.model, 'comfy-wan');
    job.base = base;
    // nodes this ComfyUI must have
    const need = [...BASE_NODES, ...FAMILY_NODES[M.family], ...(p.mode === 'i2v' ? ['LoadImage'] : [])];
    const missingNode = need.find((n) => !f.nodes.has(n));
    const save = f.nodes.has('SaveVideo') && f.nodes.has('CreateVideo') ? 'SaveVideo' : f.nodes.has('SaveWEBM') ? 'SaveWEBM' : null;
    if (missingNode || !save) return explain({ error: 'COMFY_REJECTED', detail: `Cannot execute because node ${missingNode || 'SaveVideo'} does not exist.` }, base, p.model, 'comfy-wan');
    // model files this ComfyUI must have
    const names = {};
    for (const file of M.files) {
      const list = file.kind === 'diffusion_models' ? f.unets : file.kind === 'text_encoders' ? f.clips : f.vaes;
      const nm = comfyName(list, file.name);
      if (!nm) return Object.assign(fail('VIDEO_MODEL_MISSING', `ComfyUI doesn't have ${M.short} yet (missing ${file.name}).`, `Download it in 🎬 Video → Setup (model ${M.id}, ${fmtBytes(VI.modelBytes(M))}).`), { engine: 'comfy-wan', model: M.id, missing: file.name });
      names[file.kind] = nm;
    }
    if (f.clipTypes.length && !f.clipTypes.includes('wan')) return explain({ error: 'COMFY_REJECTED', detail: 'Cannot execute because node CLIPLoader type wan does not exist.' }, base, p.model, 'comfy-wan');
    if (f.samplers.length && !f.samplers.includes(p.sampler)) return bad('sampler', `ComfyUI has no sampler “${p.sampler}”.`, `Choose one of: ${f.samplers.slice(0, 16).join(', ')}`);
    if (f.schedulers.length && !f.schedulers.includes(p.scheduler)) return bad('scheduler', `ComfyUI has no scheduler “${p.scheduler}”.`, `Choose one of: ${f.schedulers.join(', ')}`);
    // the picture goes into ComfyUI's input folder
    if (p.mode === 'i2v') {
      job.phase = 'uploading';
      const up = await sdBackends.comfyUpload(base, image.buf.toString('base64'), `autoinjector-video-${Date.now().toString(36)}.${image.type === 'jpeg' ? 'jpg' : image.type}`);
      if (!up.ok) return Object.assign(explain({ error: up.error, detail: up.detail, message: up.message }, base, p.model, 'comfy-wan'), { message: up.message });
      p.imageName = up.name;
    }
    const poster = f.nodes.has('ImageFromBatch') && f.nodes.has('SaveImage');
    const timeoutMs = isNum(req.timeoutMs) ? clamp(Number(req.timeoutMs), 10000, 6 * 3600000) : settings.timeoutMs;
    let graph = buildWanGraph(p, M, { save, poster, clipDevice: f.clipDevice, names });
    let run = await runGraph(base, graph, job, timeoutMs);
    // A ComfyUI whose SaveVideo wants different inputs: once more with SaveWEBM.
    if (!run.ok && run.error === 'COMFY_REJECTED' && save === 'SaveVideo' && f.nodes.has('SaveWEBM') && /SaveVideo|CreateVideo|\b1[12]\b/.test(String(run.detail || '') + String(run.raw || '')) && !job.cancelled) {
      warnings.push({ level: 'soft', field: 'format', message: 'This ComfyUI could not save .mp4, so the video is .webm.' });
      graph = buildWanGraph(p, M, { save: 'SaveWEBM', poster, clipDevice: f.clipDevice, names });
      run = await runGraph(base, graph, job, timeoutMs);
    }
    if (!run.ok) return explain(run, base, p.model, 'comfy-wan');
    // the files
    job.phase = 'saving';
    const vids = run.files.filter((x) => /\.(mp4|webm|mkv|mov)$/i.test(x.filename));
    vids.sort((a, b) => (/\.mp4$/i.test(b.filename) ? 1 : 0) - (/\.mp4$/i.test(a.filename) ? 1 : 0));
    if (!vids.length) return fail('VIDEO_FAILED', 'ComfyUI finished but sent no video file back.', 'Look at ComfyUI\'s window; update ComfyUI if SaveVideo / SaveWEBM failed.', { engine: 'comfy-wan' });
    const vbuf = await fetchView(base, vids[0]);
    if (!vbuf) return fail('VIDEO_FAILED', 'ComfyUI made the video, but AutoInjector could not download it (/view).', 'Try again; the file is also in ComfyUI\'s output/video folder.', { engine: 'comfy-wan' });
    const pngs = run.files.filter((x) => /\.png$/i.test(x.filename));
    let pbuf = pngs.length ? await fetchView(base, pngs[0]) : null;
    if (!pbuf && image) pbuf = image.type === 'png' ? image.buf : (deps.toPng ? safeToPng(image.buf) : null);
    if (!pbuf) warnings.push({ level: 'soft', field: 'poster', message: 'No poster (first frame) could be made: this ComfyUI lacks ImageFromBatch / SaveImage.' });
    const ext = path.extname(vids[0].filename).toLowerCase() || '.mp4';
    return save1({ engine: 'comfy-wan', p, vbuf, ext, pbuf, image, extra: { promptId: run.promptId, server: base, comfyFile: `${vids[0].subfolder ? `${vids[0].subfolder}/` : ''}${vids[0].filename}`, imageName: p.imageName }, req });
  }
  function safeToPng(buf) { try { return deps.toPng(buf) || null; } catch (_) { return null; } }

  async function fetchView(base, f) {
    const qs = `filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder || '')}&type=${encodeURIComponent(f.type || 'output')}`;
    const v = await sdBackends.request('GET', `${base}/view?${qs}`, { binary: true, timeoutMs: 300000, maxBytes: 2 * 1024 * 1024 * 1024 });
    return v.ok && v.buffer && v.buffer.length ? v.buffer : null;
  }

  // Queue a graph, follow it, return the output files. Never throws.
  async function runGraph(base, graph, job, timeoutMs) {
    const clientId = crypto.randomUUID();
    job.clientId = clientId; job.step = 0; job.steps = 0; job.phase = 'queued';
    try { sdBackends.comfySocket(base, clientId, job); } catch (_) {}
    const q = await sdBackends.postJson(`${base}/prompt`, { prompt: graph, client_id: clientId }, 30000);
    if (!q.ok || !q.json || !q.json.prompt_id) {
      try { job.closeWs && job.closeWs(); } catch (_) {}
      return { ok: false, error: q.status === 400 ? 'COMFY_REJECTED' : (q.error || 'COMFY_ERROR'), status: q.status, detail: sdBackends.comfyRejectReason(q.json) || sdBackends.errDetail(q), raw: String(q.text || '').slice(0, 4000) };
    }
    job.promptId = q.json.prompt_id;
    const t0 = Date.now();
    try {
      while (Date.now() - t0 < timeoutMs) {
        if (job.cancelled) return { ok: false, error: 'CANCELLED' };
        const h = await sdBackends.getJson(`${base}/history/${encodeURIComponent(job.promptId)}`, 10000);
        if (!h.ok && h.error === 'REFUSED') return { ok: false, error: 'ECONNRESET', detail: 'ComfyUI stopped answering while making the video.' };
        const entry = h.ok && h.json && h.json[job.promptId];
        if (entry) {
          const st = entry.status || {};
          const msgs = st.messages || [];
          if (msgs.some((m) => m && m[0] === 'execution_interrupted')) return { ok: false, error: 'CANCELLED' };
          if (st.status_str === 'error') {
            const m = msgs.find((x) => x && x[0] === 'execution_error');
            const m1 = (m && m[1]) || {};
            return { ok: false, error: 'COMFY_ERROR', detail: `${m1.node_type || ''}: ${m1.exception_message || 'the workflow failed'}`.trim(), raw: JSON.stringify({ node_type: m1.node_type || '', exception_type: m1.exception_type || '', exception_message: String(m1.exception_message || '').slice(0, 3000) }) };
          }
          const outputs = entry.outputs || {};
          const files = [];
          for (const nid of Object.keys(outputs)) {
            const o = outputs[nid] || {};
            for (const key of ['images', 'videos', 'gifs', 'video', 'animated']) for (const x of Array.isArray(o[key]) ? o[key] : []) if (x && typeof x === 'object' && x.filename) files.push(Object.assign({ node: nid }, x));
          }
          if (files.some((x) => /\.(mp4|webm|mkv|mov)$/i.test(x.filename)) || st.completed) return { ok: true, promptId: job.promptId, files, outputs };
        }
        if (job.steps && job.step >= job.steps) job.phase = 'decoding';
        else if (job.steps) job.phase = 'sampling';
        await new Promise((r) => setTimeout(r, pollMs));
      }
      return { ok: false, error: 'TIMEOUT' };
    } finally { try { job.closeWs && job.closeWs(); } catch (_) {} }
  }

  // The endpoint backend (video-provider.js): text→video only.
  async function viaEndpoint(p, job) {
    if (p.mode === 'i2v') return fail('UNSUPPORTED_ON_BACKEND', 'The other video server (Advanced) can only make video from text.', 'Use ComfyUI with Wan 2.2 5B for picture→video (🎬 Video → Setup).', { engine: 'endpoint' });
    if (!vp) return fail('VIDEO_NOT_SET_UP', 'No video server is set up.', 'Open 🎬 Video → Setup.', { engine: 'endpoint' });
    job.phase = 'rendering';
    const r = await vp.generate(p.prompt, { negativePrompt: p.negativePrompt });
    if (job.cancelled) return fail('VIDEO_CANCELLED', 'Stopped.', '', { engine: 'endpoint' });
    if (!r || !r.ok) {
      const e = (r && r.error) || 'FAILED';
      const code = e === 'VIDEO_DISABLED' || e === 'NO_ENDPOINT' || e === 'BAD_ENDPOINT' || e === 'ECONNREFUSED' ? 'VIDEO_NOT_SET_UP' : e === 'TIMEOUT' || e === 'ETIMEDOUT' ? 'VIDEO_TIMEOUT' : 'VIDEO_FAILED';
      let message = r && r.message;
      if (!message && typeof vp.explainError === 'function') { try { message = vp.explainError({ error: e, shape: r && r.shape, detail: r && r.detail }); } catch (_) { message = ''; } }
      // providerError: video-provider's own code (NO_ENDPOINT, NO_VIDEO, …) for the legacy video:generate answer.
      return fail(code, message || 'The video server could not make the video.', '', { engine: 'endpoint', providerError: e, serverError: r && r.detail ? String(r.detail).slice(0, 600) : undefined });
    }
    if (r.videoUrl && !r.videoBase64) return { ok: true, engine: 'endpoint', model: 'endpoint', path: null, url: r.videoUrl, poster: null, seconds: null, frames: null, fps: null, width: null, height: null, seed: null, warnings: [{ level: 'soft', message: 'The video server answered with an address, not a file; it was not saved locally.' }] };
    const vbuf = Buffer.from(String(r.videoBase64), 'base64');
    const ext = vbuf.length > 4 && vbuf.readUInt32BE(0) === 0x1a45dfa3 ? '.webm' : '.mp4';
    const ss = vp.getSettings ? vp.getSettings() : {};
    const q = Object.assign({}, p, { model: 'endpoint', frames: ss.frames || null, fps: ss.fps || null, width: ss.width || null, height: ss.height || null, seed: ss.seed != null && ss.seed >= 0 ? ss.seed : null, steps: ss.steps, cfgScale: ss.cfgScale });
    q.seconds = q.frames && q.fps ? Math.round(q.frames / q.fps * 100) / 100 : null;
    return save1({ engine: 'endpoint', p: q, vbuf, ext, pbuf: null, image: null, extra: { endpoint: endpointState().endpoint }, req: {} });
  }

  // Save the video + poster + sidecar → the contract's result.
  function save1({ engine, p, vbuf, ext, pbuf, image, extra, req }) {
    const dir = videosDir();
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
    const tag = p.purpose && p.purpose !== 'free' ? p.purpose.replace(/_/g, '-') : p.mode === 'i2v' ? 'animate' : 'video';
    let stem = `${tag}-${stamp}${p.seed != null ? `-${p.seed}` : ''}`;
    for (let i = 2; fs.existsSync(path.join(dir, stem + ext)); i++) stem = `${tag}-${stamp}-${i}`;
    const file = path.join(dir, stem + ext);
    try { fs.writeFileSync(file, vbuf); } catch (e) { return fail('VIDEO_FAILED', `The video was made but couldn't be saved into videos/ (${e.code || e.message}).`, 'Check the output folder is writable and has space.', { engine }); }
    let poster = null;
    if (pbuf) { try { poster = path.join(dir, `${stem}.png`); fs.writeFileSync(poster, pbuf); } catch (_) { poster = null; } }
    const record = {
      kind: 'video', engine, model: p.model, mode: p.mode, prompt: p.prompt, negativePrompt: p.negativePrompt, seed: p.seed, steps: p.steps, cfgScale: p.cfgScale,
      sampler: p.sampler, scheduler: p.scheduler, shift: p.shift, width: p.width, height: p.height, frames: p.frames, fps: p.fps, seconds: p.seconds,
      purpose: p.purpose, from: p.from, book: p.book, characterLock: p.lock, sourceImage: image && image.sourcePath ? image.sourcePath : (image ? '(base64 picture)' : undefined),
      poster: poster ? path.basename(poster) : null, file: path.basename(file), bytes: vbuf.length, createdAt: new Date().toISOString(), app: 'AutoInjector',
    };
    Object.assign(record, extra || {});
    const json = path.join(dir, `${stem}.json`);
    try { fs.writeFileSync(json, JSON.stringify(record, null, 2)); } catch (_) {}
    try { if (deps.recordVideo) deps.recordVideo({ path: file, prompt: p.prompt, seed: p.seed, model: p.model, from: p.from }); } catch (_) {}
    const out = { ok: true, engine, model: p.model, path: file, poster, seconds: p.seconds, frames: p.frames, fps: p.fps, width: p.width, height: p.height, seed: p.seed,
      mode: p.mode, url: fileUrl(file), posterUrl: poster ? fileUrl(poster) : null, json, warnings: [] };
    if (req && req.returnPoster && pbuf) out.posterBase64 = pbuf.toString('base64');
    return out;
  }

  // ---- progress / cancel / gallery
  async function progress() {
    const j = current;
    if (!j) return { ok: true, busy: false, last };
    const out = { ok: true, busy: true, mode: j.mode, model: j.model, phase: j.phase, seconds: Math.round((Date.now() - j.startedAt) / 1000), step: j.step || 0, steps: j.steps || 0, from: j.from };
    out.pct = out.steps ? Math.min(1, out.step / out.steps) : 0;
    if (j.base && j.promptId) {
      try { const p = await sdBackends.comfyProgress(j.base, j); if (p && p.ok) { out.queue = p.job; if (p.steps) { out.step = p.step; out.steps = p.steps; out.pct = p.progress; } if (/queued/.test(p.job || '')) out.phase = 'queued'; } } catch (_) {}
    }
    return out;
  }
  async function cancel() {
    const j = current;
    if (!j) return { ok: true, cancelled: false, message: 'No video is being made.' };
    j.cancelled = true;
    if (j.base) { try { await sdBackends.comfyInterrupt(j.base, j); } catch (_) {} }
    log('video-cancel', { mode: j.mode, seconds: Math.round((Date.now() - j.startedAt) / 1000) });
    return { ok: true, cancelled: true };
  }
  function gallery(limit) {
    const n = clamp(Math.round(Number(limit) || 40), 1, 500);
    let dir; try { dir = videosDir(); } catch (_) { return { ok: true, items: [] }; }
    let names = []; try { names = fs.readdirSync(dir).filter((x) => /\.(mp4|webm|mkv|mov)$/i.test(x)); } catch (_) { names = []; }
    const items = names.map((name) => {
      const p = path.join(dir, name); const stem = name.replace(/\.[^.]+$/, '');
      let mtime = 0; try { mtime = fs.statSync(p).mtimeMs; } catch (_) {}
      let rec = null; try { rec = JSON.parse(fs.readFileSync(path.join(dir, `${stem}.json`), 'utf8')); } catch (_) {}
      const poster = fs.existsSync(path.join(dir, `${stem}.png`)) ? path.join(dir, `${stem}.png`) : null;
      return { path: p, url: fileUrl(p), poster, posterUrl: poster ? fileUrl(poster) : null, mtime, record: rec,
        prompt: rec ? rec.prompt : '', model: rec ? rec.model : '', seconds: rec ? rec.seconds : null, width: rec ? rec.width : null, height: rec ? rec.height : null };
    }).sort((a, b) => b.mtime - a.mtime).slice(0, n);
    return { ok: true, items, dir };
  }

  // A 1-second test clip at a small size, with the smallest installed model.
  async function test(o = {}) {
    const st = await status();
    if (!st.ready) return fail('VIDEO_NOT_SET_UP', st.message, 'Open 🎬 Video → Setup.');
    const model = st.backend === 'comfy-wan' ? (st.installed.includes('wan21-t2v-1.3b') ? 'wan21-t2v-1.3b' : st.installed[0]) : undefined;
    return make('t2v', Object.assign({ prompt: 'a red ball bouncing on a white floor, simple test clip', purpose: 'test', seconds: 1, model }, o), 'video-test');
  }

  return {
    status, backendInfo, models: modelsInfo, settings: setSettings, getSettings: () => Object.assign({}, settings),
    generate: (req, from) => make('t2v', req, from),
    animate: (req, from) => make('i2v', req, from),
    request: (req, from) => make(req && req.image != null && req.image !== '' ? 'i2v' : 't2v', req, from),
    progress, cancel, gallery, test, busy: () => !!current,
    install: {
      check: async () => { const s = await modelsInfo(); return s; },
      downloadModel: async (id) => { const i = installer(); if (!i) return fail('NOT_WIRED', 'The video model downloader is not available in this build.'); const r = await i.downloadModel(id || settings.model || VI.DEFAULT_MODEL); factsCache = null; return r; },
      installAll: async (id) => { const i = installer(); if (!i) return fail('NOT_WIRED', 'The installer is not available in this build.'); const r = await i.installAll(id || settings.model || VI.DEFAULT_MODEL); factsCache = null; return r; },
      cancel: async () => { const i = installer(); return i ? i.cancel() : { ok: true, cancelled: false }; },
    },
  };
}

module.exports = { createVideoStudio, buildWanGraph, normalize, comfyFacts, comfyName, imageSize, readImage, fitSize, snapFrames, snapSide, PARAM_KEYS, PURPOSES, BACKENDS, DEFAULT_NEGATIVE, DEFAULT_SETTINGS, IDLE_PROMPT, ALL_NODES };
