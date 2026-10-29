'use strict';
/*
 * video-api.js — ONE module API for 🎬 video, shaped like sd-api.js, for the rest of
 * AutoInjector (🎩 Alfred's video_call tool, the bridge, the butler). main.js builds it
 * once and registers it; callers in the main process do:
 *
 *   const videoApi = require('./video-api').get();     // null until main registered it
 *   await videoApi.capabilities();                      // every operation + JSON schema + changes + available
 *   await videoApi.call('video.generate', { prompt: 'waves at dusk', seconds: 4 });
 *   await videoApi.video.animate({ image: 'C:/portrait.png', seconds: 4, purpose: 'clip' });
 *
 *   video.status() · video.capabilities() · video.models() · video.progress() · video.cancel()
 *   video.gallery({ limit }) · video.generate(params) · video.animate(params) · video.test()
 *   video.settings({ backend, model, comfyUrl, timeoutMs, framepackDir, framepackGpuMemory })
 *   video.framepack.status() · video.framepack.load() · video.framepack.unload() · video.framepack.test() — FramePack (framepack.js)
 *   video.install.check() · video.install.downloadModel({ id }) · video.install.installAll({ id }) · video.install.cancel()
 *   🎞 trailer.make({ book, items | shots + cards, music, … }) · trailer.status({ id }) · trailer.cancel() · trailer.list({ book })
 *   · trailer.plan({ book }) — book trailers: shots rendered one by one, joined with title cards (video-trailer.js)
 * generate / animate params: prompt, negativePrompt, image (animate: a path or base64), width, height,
 *   seconds | frames, fps, model, steps, cfgScale, seed, sampler, scheduler, shift, characterLock,
 *   purpose (clip | trailer_shot | free), from, book, returnPoster, backend | engine (auto | wan | framepack | endpoint), timeoutMs,
 *   FramePack: teacache, gpuMemoryPreservation, distilledCfg
 *   → { ok, engine: "comfy-wan"|"framepack"|"endpoint", model, path, poster, seconds, frames, fps, width, height, seed, warnings }
 *   | { ok:false, error, code, message, fix } — VIDEO_NOT_SET_UP · VIDEO_MODEL_MISSING (+ model) · VIDEO_OOM ·
 *     VIDEO_TIMEOUT · VIDEO_CANCELLED · VIDEO_FAILED · UNSUPPORTED_ON_BACKEND · INVALID_PARAM · BUSY · NO_LOCK
 * Every call resolves (never throws). See docs/VIDEO_API.md.
 */
const VI = require('./video-installer');
const VS = require('./video-studio');
const P = require('./sd-params');

let registered = null;

function wrap(fn) {
  return async (...a) => {
    try { return await fn(...a); }
    catch (e) { return { ok: false, error: 'INTERNAL', code: 'INTERNAL', message: `Something went wrong: ${(e && e.message) || e}` }; }
  };
}
function notWired(name) { return { ok: false, error: 'NOT_WIRED', code: 'NOT_WIRED', message: `${name} is not available in this build.` }; }

const O = (props, required) => ({ type: 'object', properties: props || {}, required: required || [], additionalProperties: false });
const MODEL_IDS = Object.keys(VI.MODELS);
const GEN_PROPS = {
  prompt: { type: 'string', maxLength: 4000, description: 'What happens in the video (for animate: the motion; optional)' },
  negativePrompt: { type: 'string', maxLength: 4000, description: 'What to avoid (a sensible default is used when left out)' },
  width: { type: 'integer', minimum: 256, maximum: 1280, description: 'Wan 2.2 5B: multiple of 32 (default 1280); Wan 2.1 1.3B: multiple of 16 (default 832). Clamped to the model.' },
  height: { type: 'integer', minimum: 256, maximum: 1280, description: 'Default 704 (5B) / 480 (1.3B). For animate the picture\'s shape is kept when left out.' },
  seconds: { type: 'number', exclusiveMinimum: 0, maximum: 10, description: 'Length in seconds (5B: up to 5 s at 24 fps; 1.3B: up to 5 s at 16 fps; FramePack: 1–10 s at 30 fps)' },
  frames: { type: 'integer', minimum: 5, maximum: 121, description: 'Instead of seconds: frame count, snapped to 4n+1' },
  fps: { type: 'integer', minimum: 1, maximum: 60, description: 'Frames per second (default 24 for 5B, 16 for 1.3B)' },
  model: { type: 'string', enum: [...MODEL_IDS, VS.FRAMEPACK_MODEL], description: `Default ${VI.DEFAULT_MODEL} (${VS.FRAMEPACK_MODEL} = FramePack)` },
  steps: { type: 'integer', minimum: 1, maximum: 100, description: 'Sampling steps (default 20 / 30)' },
  cfgScale: { type: 'number', minimum: 1, maximum: 20, description: 'Prompt strength (default 5 / 6)' },
  seed: { type: 'integer', description: '-1 = random' },
  sampler: { type: 'string', description: 'ComfyUI sampler (default uni_pc)' },
  scheduler: { type: 'string', description: 'ComfyUI scheduler (default simple)' },
  shift: { type: 'number', minimum: 0, maximum: 20, description: 'ModelSamplingSD3 shift (default 8)' },
  characterLock: { type: 'string', maxLength: 200, description: 'A character lock (🎨 Images) by id or name: its looks are added to the prompt' },
  purpose: { type: 'string', enum: ['clip', 'trailer_shot', 'free'], description: 'clip = a 4 s character clip; trailer_shot = a 5 s 16:9 shot; free (default)' },
  from: { type: 'string', maxLength: 60, description: 'Who asks (logged), e.g. "akowe-forge"' },
  book: { type: 'string', maxLength: 200, description: 'The book this is for (recorded in the sidecar)' },
  returnPoster: { type: 'boolean', description: 'Also return the poster PNG as base64 (posterBase64)' },
  backend: { type: 'string', enum: VS.BACKENDS, description: 'auto (default), comfy-wan, framepack or endpoint' },
  engine: { type: 'string', enum: ['auto', 'wan', 'framepack', 'endpoint'], description: 'The same in plain words: wan = ComfyUI + Wan, framepack = FramePack (picture → video; text → video makes a picture first with 🎨 Images)' },
  teacache: { type: 'boolean', description: 'FramePack: TeaCache (default true — faster, very slightly softer)' },
  gpuMemoryPreservation: { type: 'number', minimum: 6, maximum: 128, description: 'FramePack: graphics memory (GB) to keep free (default 6; raise it when the card runs out of memory)' },
  distilledCfg: { type: 'number', minimum: 1, maximum: 32, description: 'FramePack: distilled CFG (default 10)' },
  timeoutMs: { type: 'integer', minimum: 10000, maximum: 21600000, description: 'Give up after this long (default 45 min)' },
};
const SHOT_ITEM = { type: 'object', additionalProperties: false, properties: {
  type: { type: 'string', enum: ['shot', 'card'], description: 'shot (a video made from prompt / image) or card (a title card: text + subtitle)' },
  prompt: { type: 'string', maxLength: 4000, description: 'Shot: what happens' }, image: { type: 'string', description: 'Shot: a picture to animate (file path)' },
  seconds: { type: 'number', minimum: 1, maximum: 10, description: 'Shot 1–5 s (default 4); card 1–10 s (default 3)' },
  characterLock: { type: 'string', maxLength: 200 }, negativePrompt: { type: 'string', maxLength: 4000 }, seed: { type: 'integer' }, model: { type: 'string', enum: Object.keys(VI.MODELS) },
  text: { type: 'string', maxLength: 120, description: 'Card: the big line (e.g. the title)' }, subtitle: { type: 'string', maxLength: 160, description: 'Card: the small line (e.g. "Coming soon")' },
  at: { description: 'Card in shots+cards form: "start", "end" or after the n-th shot' },
} };
const TRAILER_PROPS = {
  book: { type: 'string', maxLength: 200, description: 'The book (its folder under videos/trailers/)' },
  title: { type: 'string', maxLength: 200 },
  items: { type: 'array', maxItems: 24, items: SHOT_ITEM, description: 'Shots and title cards in order' },
  shots: { type: 'array', maxItems: 16, items: SHOT_ITEM, description: 'Instead of items: the shots ({prompt | image, seconds})' },
  cards: { type: 'array', maxItems: 8, items: SHOT_ITEM, description: 'With shots: title cards ({text, subtitle, seconds, at}); default the first opens, the rest close' },
  music: { type: 'string', description: 'Optional music file path (.mp3/.ogg/.wav/.m4a…), mixed in and faded out' },
  musicVolume: { type: 'number', minimum: 0, maximum: 1 },
  width: { type: 'integer', minimum: 320, maximum: 1920, description: 'Trailer frame (default 1280×720)' }, height: { type: 'integer', minimum: 240, maximum: 1080 },
  fps: { type: 'integer', minimum: 12, maximum: 30 }, fade: { type: 'number', minimum: 0, maximum: 1, description: 'Fade through black between parts, seconds (default 0.4)' },
  model: { type: 'string', enum: Object.keys(VI.MODELS), description: 'Video model for every shot' },
  engine: { type: 'string', enum: ['auto', 'wan', 'framepack', 'endpoint'], description: 'The video engine for every shot (default: the one picked in 🎬 Video → Settings). framepack = FramePack (a shot from text gets its picture made first)' },
  resume: { type: 'boolean', description: 'Reuse shots already made for this trailer (default true)' },
  mp4: { type: 'boolean', description: 'Also make an .mp4 copy when ffmpeg is found (default true)' },
  from: { type: 'string', maxLength: 60 }, wait: { type: 'boolean', description: 'Wait for the finished trailer instead of returning at once' },
};
const ANIMATE_PROPS = Object.assign({}, GEN_PROPS, { image: { type: 'string', format: 'image', description: 'The picture to animate: a file path, or base64 / a data: URL (PNG, JPEG, WEBP)' } });

// args: positional names, or 'object' = the params object is the one argument.
// changes: false = read-only (runs without a confirm card). needs: 'comfy' | 'ready' | 'i2v' (drives available + hint).
const OPS = [
  { name: 'capabilities', description: 'Every video operation with its parameter schema, whether it changes anything, and whether it is available now', params: O(), args: [], changes: false },
  { name: 'call', description: 'Call any video operation by name with a params object', params: O({ name: { type: 'string' }, params: { type: 'object', additionalProperties: true } }, ['name']), args: ['name', 'params'], changes: true },
  { name: 'video.status', description: 'Is video set up: ComfyUI connected, which video models are downloaded, which backend would be used, is a video being made', params: O(), args: [], changes: false },
  { name: 'video.capabilities', description: 'The same as capabilities()', params: O(), args: [], changes: false },
  { name: 'video.models', description: 'The video models (Wan 2.2 5B, Wan 2.1 1.3B): installed or missing, files, sizes, graphics memory needed, where they go', params: O(), args: [], changes: false },
  { name: 'video.progress', description: 'Progress of the video being made (phase, step of steps, seconds so far)', params: O(), args: [], changes: false },
  { name: 'video.gallery', description: 'Recent saved videos with posters and their settings', params: O({ limit: { type: 'integer', minimum: 1, maximum: 500 } }), args: 'object', changes: false },
  { name: 'video.cancel', description: 'Stop the video being made', params: O(), args: [], changes: true },
  { name: 'video.generate', description: 'Make a video from text (text→video). Saved to videos/ as .mp4 (or .webm) with a .json sidecar and a .png poster. Takes minutes.', params: O(GEN_PROPS, ['prompt']), args: 'object', changes: true, needs: 'ready' },
  { name: 'video.animate', description: 'Make a video from a picture (picture→video: Wan 2.2 5B, or FramePack). The picture\'s shape is kept. Takes minutes.', params: O(ANIMATE_PROPS, ['image']), args: 'object', changes: true, needs: 'i2v' },
  { name: 'video.test', description: 'Make a tiny 1-second test video to prove video works', params: O(), args: [], changes: true, needs: 'ready' },
  { name: 'video.settings', description: 'Video settings: backend (auto / comfy-wan / framepack / endpoint), default model, a ComfyUI address, the time limit, the FramePack folder (empty = find it by itself) and the graphics memory FramePack keeps free', params: O({ backend: { type: 'string', enum: VS.BACKENDS }, model: { type: 'string', enum: MODEL_IDS }, comfyUrl: { type: 'string', maxLength: 300 }, timeoutMs: { type: 'integer', minimum: 60000, maximum: 21600000 }, framepackDir: { type: 'string', maxLength: 1000 }, framepackGpuMemory: { type: 'number', minimum: 6, maximum: 128 } }), args: 'object', changes: true },
  { name: 'video.framepack.status', description: 'FramePack (picture → video, already on this PC — nothing is downloaded): found where, its Python, which of its models are there or missing, loaded or not, graphics memory', params: O(), args: [], changes: false },
  { name: 'video.framepack.load', description: 'Start FramePack and load its models now (a warm-up: the next FramePack video starts straight away). Takes a few minutes the first time.', params: O(), args: [], changes: true },
  { name: 'video.framepack.unload', description: 'Unload FramePack (frees the graphics memory)', params: O(), args: [], changes: true },
  { name: 'video.framepack.test', description: 'Make a 2-second FramePack clip from a built-in test picture, to prove FramePack works', params: O(), args: [], changes: true, needs: 'framepack' },
  { name: 'video.install.check', description: 'What the video install has and is missing: ComfyUI found where, each model\'s files, free disk space', params: O(), args: [], changes: false },
  { name: 'video.install.downloadModel', description: 'Download a video model into ComfyUI\'s model folders (big: 2.8–18 GB; resumes where it stopped)', params: O({ id: { type: 'string', enum: MODEL_IDS } }), args: 'object', changes: true, needs: 'comfyInstalled' },
  { name: 'video.install.installAll', description: 'One click: install ComfyUI (when there is none) and then the video model', params: O({ id: { type: 'string', enum: MODEL_IDS } }), args: 'object', changes: true },
  { name: 'video.install.cancel', description: 'Stop / pause the video download (it continues where it stopped next time)', params: O(), args: [], changes: true },
  { name: 'trailer.make', description: 'Make a book trailer: each shot is rendered (text→video, or a picture brought to life) one after the other, then joined with title cards (fades, optional music) into a .webm (+ an .mp4 when ffmpeg is found) in videos/trailers/<book>/ — the result path and mp4 name the files. Shots already made are reused. Starts in the background (trailer.status) unless wait:true. Takes minutes per shot.', params: O(TRAILER_PROPS), args: 'object', changes: true, needs: 'ready' },
  { name: 'trailer.status', description: 'The trailer being made: phase (shots / joining / mp4 / done), which shot, each part\'s state; the result when finished', params: O({ id: { type: 'string', maxLength: 80 } }), args: 'object', changes: false },
  { name: 'trailer.cancel', description: 'Stop the trailer being made (the shots already made are kept for next time)', params: O(), args: [], changes: true },
  { name: 'trailer.list', description: 'The saved trailers (one per book) with their .webm / .mp4', params: O({ book: { type: 'string', maxLength: 200 } }), args: 'object', changes: false },
  { name: 'trailer.plan', description: 'The saved plan (shots, cards, music) of a book\'s trailer, to change and make again', params: O({ book: { type: 'string', maxLength: 200 } }, ['book']), args: 'object', changes: false },
];

function _get(obj, p) { return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }

function createVideoApi(d = {}) {
  const studio = d.studio;
  const trailer = d.trailer || null;
  const T = (name, ...a) => { const fn = trailer && trailer[name]; return typeof fn === 'function' ? fn(...a) : notWired(`trailer.${name}`); };
  const S = (name, ...a) => { const fn = name.split('.').reduce((o, k) => (o == null ? undefined : o[k]), studio); return typeof fn === 'function' ? fn(...a) : notWired(name); };
  const from = (o) => `api:${String((o && o.from) || 'alfred').slice(0, 40)}`;
  const strip = (o) => { const q = Object.assign({}, o || {}); return q; };
  const api = {
    video: {
      status: wrap(() => S('status')),
      capabilities: wrap(() => api.capabilities()),
      models: wrap(() => S('models')),
      progress: wrap(() => S('progress')),
      gallery: wrap((o) => S('gallery', o && typeof o === 'object' ? o.limit : o)),
      cancel: wrap(() => S('cancel')),
      generate: wrap((o) => checkKeys('video.generate', o, GEN_PROPS) || S('generate', strip(o), from(o))),
      animate: wrap((o) => checkKeys('video.animate', o, ANIMATE_PROPS) || S('animate', strip(o), from(o))),
      test: wrap(() => S('test')),
      settings: wrap((o) => S('settings', o || {})),
      framepack: {
        status: wrap(() => S('framepack.status', { gpu: true })),
        load: wrap(() => S('framepack.load')),
        unload: wrap(() => S('framepack.unload')),
        test: wrap(() => S('framepack.test')),
      },
      install: {
        check: wrap(() => S('install.check')),
        downloadModel: wrap((o) => S('install.downloadModel', o && typeof o === 'object' ? o.id : o)),
        installAll: wrap((o) => S('install.installAll', o && typeof o === 'object' ? o.id : o)),
        cancel: wrap(() => S('install.cancel')),
      },
    },
    trailer: {
      make: wrap((o) => checkKeys('trailer.make', o, TRAILER_PROPS) || T('make', Object.assign({}, o || {}, { from: (o && o.from) || 'alfred' }))),
      status: wrap((o) => T('status', o && typeof o === 'object' ? o : {})),
      cancel: wrap(() => T('cancel')),
      list: wrap((o) => T('list', o && typeof o === 'object' ? o : {})),
      plan: wrap((o) => T('plan', o && typeof o === 'object' ? o : { book: o })),
    },
  };

  api.capabilities = wrap(async () => {
    let st = null;
    try { st = await S('status'); } catch (_) { st = null; }
    const ok = st && st.ok;
    const installed = (ok && st.installed) || [];
    const comfyInstalled = !!(ok && (st.comfy && (st.comfy.connected || st.comfy.installed)));
    const operations = OPS.map((op) => {
      let available = true; let hint = '';
      if (op.needs === 'ready' && !(ok && st.ready)) { available = false; hint = (ok && st.message) || 'Video is not set up yet (video.install.installAll).'; }
      if (op.needs === 'i2v') {
        if (!(ok && st.ready)) { available = false; hint = (ok && st.message) || 'Video is not set up yet.'; }
        else if (st.backend === 'endpoint') { available = false; hint = 'The other video server (endpoint) makes video from text only. Picture→video needs ComfyUI with Wan 2.2 5B, or FramePack.'; }
        else if (st.backend === 'framepack') { /* FramePack is picture → video */ }
        else if (!installed.some((id) => VI.MODELS[id] && VI.MODELS[id].modes.includes('i2v'))) { available = false; hint = `Picture→video needs ${VI.MODELS[VI.DEFAULT_MODEL].short} (video.install.downloadModel { id: "${VI.DEFAULT_MODEL}" }).`; }
      }
      if (op.needs === 'framepack' && !(ok && st.framepack && st.framepack.ready)) { available = false; hint = (ok && st.framepack && st.framepack.message) || 'FramePack was not found (🎬 Video → Setup → 📂 Choose FramePack folder).'; }
      if (op.needs === 'comfyInstalled' && !comfyInstalled && !(ok && st.comfy && st.comfy.connected)) { available = false; hint = 'No ComfyUI was found yet: use video.install.installAll (installs ComfyUI and the model).'; }
      const o = { name: op.name, description: op.description, params: op.params, args: op.args, changes: op.changes, available, hint };
      if (!available) o.code = op.needs === 'i2v' && ok && st.backend === 'endpoint' ? 'UNSUPPORTED_ON_BACKEND' : op.needs === 'framepack' ? 'FRAMEPACK_NOT_FOUND' : 'VIDEO_NOT_SET_UP';
      return o;
    });
    return {
      ok: true, version: 1, ready: !!(ok && st.ready), backend: (ok && st.backend) || '', message: (ok && st.message) || '', installed, defaultModel: VI.DEFAULT_MODEL,
      models: Object.values(VI.MODELS).map((m) => ({ id: m.id, label: m.label, modes: m.modes, vramGB: m.vramGB, bytes: VI.modelBytes(m), defaults: m.defaults, limits: m.limits, installed: installed.includes(m.id) })),
      errors: ['VIDEO_NOT_SET_UP', 'VIDEO_MODEL_MISSING', 'VIDEO_OOM', 'VIDEO_TIMEOUT', 'VIDEO_CANCELLED', 'VIDEO_FAILED', 'UNSUPPORTED_ON_BACKEND', 'INVALID_PARAM', 'BUSY', 'NO_LOCK', 'TRAILER_JOIN_FAILED',
        'FRAMEPACK_NOT_FOUND', 'FRAMEPACK_PYTHON_MISSING', 'FRAMEPACK_MODEL_MISSING', 'FRAMEPACK_OOM', 'FRAMEPACK_PICTURE_FAILED', 'FRAMEPACK_TIMEOUT', 'FRAMEPACK_FAILED'],
      framepack: ok && st.framepack ? { found: st.framepack.found, ready: st.framepack.ready, loaded: st.framepack.loaded, dir: st.framepack.dir, missing: st.framepack.models ? st.framepack.models.missing : [], message: st.framepack.message } : null,
      operations,
    };
  });

  api.call = wrap(async (name, params) => {
    const op = OPS.find((o) => o.name === name);
    const fn = op && op.name !== 'call' ? (op.name === 'capabilities' ? api.capabilities : _get(api, op.name)) : null;
    if (!op || typeof fn !== 'function') return { ok: false, error: 'UNKNOWN_OPERATION', code: 'UNKNOWN_OPERATION', message: `There is no video operation “${name}”.`, hint: `Known: ${OPS.map((o) => o.name).filter((n) => n !== 'call').join(', ')}` };
    const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
    const sch = op.params;
    if (sch && sch.properties && sch.additionalProperties === false) {
      const unknown = Object.keys(p).filter((k) => !sch.properties[k] && p[k] !== undefined);
      if (unknown.length) { const s = P.suggest(unknown[0], Object.keys(sch.properties)); return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', field: unknown[0], message: `${name} has no parameter “${unknown[0]}”.`, hint: s.length ? `Did you mean: ${s.join(', ')}?` : `Parameters: ${Object.keys(sch.properties).join(', ') || '(none)'}` }; }
    }
    for (const r of (sch && sch.required) || []) {
      // animate may take its prompt from the picture alone; generate's prompt may come from a characterLock.
      if (name === 'video.generate' && r === 'prompt' && p.characterLock) continue;
      if (p[r] === undefined || p[r] === null || p[r] === '') return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', field: r, message: `${name} needs “${r}”.` };
    }
    if (op.args === 'object') return fn(p);
    return fn(...op.args.map((a) => p[a]));
  });
  return api;
}

// Unknown top-level keys → INVALID_PARAM with a suggestion (also for direct calls).
function checkKeys(name, o, props) {
  for (const k of Object.keys(o || {})) {
    if (props[k] || o[k] === undefined) continue;
    const s = P.suggest(k, Object.keys(props));
    return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', field: k, message: `${name} has no parameter “${k}”.`, hint: s.length ? `Did you mean: ${s.join(', ')}?` : 'capabilities() lists every parameter.' };
  }
  return null;
}

function register(api) { registered = api; return api; }
function get() { return registered; }
function operationNames() { return OPS.map((o) => o.name); }

module.exports = { createVideoApi, register, get, operationNames, OPS, GEN_PROPS, ANIMATE_PROPS, TRAILER_PROPS };
