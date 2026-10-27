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
 *   video.settings({ backend, model, comfyUrl, timeoutMs })
 *   video.install.check() · video.install.downloadModel({ id }) · video.install.installAll({ id }) · video.install.cancel()
 * generate / animate params: prompt, negativePrompt, image (animate: a path or base64), width, height,
 *   seconds | frames, fps, model, steps, cfgScale, seed, sampler, scheduler, shift, characterLock,
 *   purpose (clip | trailer_shot | free), from, book, returnPoster, backend, timeoutMs
 *   → { ok, engine: "comfy-wan"|"endpoint", model, path, poster, seconds, frames, fps, width, height, seed, warnings }
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
  seconds: { type: 'number', exclusiveMinimum: 0, maximum: 10, description: 'Length in seconds (5B: up to 5 s at 24 fps; 1.3B: up to 5 s at 16 fps)' },
  frames: { type: 'integer', minimum: 5, maximum: 121, description: 'Instead of seconds: frame count, snapped to 4n+1' },
  fps: { type: 'integer', minimum: 1, maximum: 60, description: 'Frames per second (default 24 for 5B, 16 for 1.3B)' },
  model: { type: 'string', enum: MODEL_IDS, description: `Default ${VI.DEFAULT_MODEL}` },
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
  backend: { type: 'string', enum: VS.BACKENDS, description: 'auto (default), comfy-wan or endpoint' },
  timeoutMs: { type: 'integer', minimum: 10000, maximum: 21600000, description: 'Give up after this long (default 45 min)' },
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
  { name: 'video.animate', description: 'Make a video from a picture (picture→video, Wan 2.2 5B). The picture\'s shape is kept. Takes minutes.', params: O(ANIMATE_PROPS, ['image']), args: 'object', changes: true, needs: 'i2v' },
  { name: 'video.test', description: 'Make a tiny 1-second test video to prove video works', params: O(), args: [], changes: true, needs: 'ready' },
  { name: 'video.settings', description: 'Video settings: backend (auto / comfy-wan / endpoint), default model, a ComfyUI address, the time limit', params: O({ backend: { type: 'string', enum: VS.BACKENDS }, model: { type: 'string', enum: MODEL_IDS }, comfyUrl: { type: 'string', maxLength: 300 }, timeoutMs: { type: 'integer', minimum: 60000, maximum: 21600000 } }), args: 'object', changes: true },
  { name: 'video.install.check', description: 'What the video install has and is missing: ComfyUI found where, each model\'s files, free disk space', params: O(), args: [], changes: false },
  { name: 'video.install.downloadModel', description: 'Download a video model into ComfyUI\'s model folders (big: 2.8–18 GB; resumes where it stopped)', params: O({ id: { type: 'string', enum: MODEL_IDS } }), args: 'object', changes: true, needs: 'comfyInstalled' },
  { name: 'video.install.installAll', description: 'One click: install ComfyUI (when there is none) and then the video model', params: O({ id: { type: 'string', enum: MODEL_IDS } }), args: 'object', changes: true },
  { name: 'video.install.cancel', description: 'Stop / pause the video download (it continues where it stopped next time)', params: O(), args: [], changes: true },
];

function _get(obj, p) { return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }

function createVideoApi(d = {}) {
  const studio = d.studio;
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
      install: {
        check: wrap(() => S('install.check')),
        downloadModel: wrap((o) => S('install.downloadModel', o && typeof o === 'object' ? o.id : o)),
        installAll: wrap((o) => S('install.installAll', o && typeof o === 'object' ? o.id : o)),
        cancel: wrap(() => S('install.cancel')),
      },
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
        else if (st.backend === 'endpoint') { available = false; hint = 'The other video server (endpoint) makes video from text only. Picture→video needs ComfyUI with Wan 2.2 5B.'; }
        else if (!installed.some((id) => VI.MODELS[id] && VI.MODELS[id].modes.includes('i2v'))) { available = false; hint = `Picture→video needs ${VI.MODELS[VI.DEFAULT_MODEL].short} (video.install.downloadModel { id: "${VI.DEFAULT_MODEL}" }).`; }
      }
      if (op.needs === 'comfyInstalled' && !comfyInstalled && !(ok && st.comfy && st.comfy.connected)) { available = false; hint = 'No ComfyUI was found yet: use video.install.installAll (installs ComfyUI and the model).'; }
      const o = { name: op.name, description: op.description, params: op.params, args: op.args, changes: op.changes, available, hint };
      if (!available) o.code = op.needs === 'i2v' && ok && st.backend === 'endpoint' ? 'UNSUPPORTED_ON_BACKEND' : 'VIDEO_NOT_SET_UP';
      return o;
    });
    return {
      ok: true, version: 1, ready: !!(ok && st.ready), backend: (ok && st.backend) || '', message: (ok && st.message) || '', installed, defaultModel: VI.DEFAULT_MODEL,
      models: Object.values(VI.MODELS).map((m) => ({ id: m.id, label: m.label, modes: m.modes, vramGB: m.vramGB, bytes: VI.modelBytes(m), defaults: m.defaults, limits: m.limits, installed: installed.includes(m.id) })),
      errors: ['VIDEO_NOT_SET_UP', 'VIDEO_MODEL_MISSING', 'VIDEO_OOM', 'VIDEO_TIMEOUT', 'VIDEO_CANCELLED', 'VIDEO_FAILED', 'UNSUPPORTED_ON_BACKEND', 'INVALID_PARAM', 'BUSY', 'NO_LOCK'],
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

module.exports = { createVideoApi, register, get, operationNames, OPS, GEN_PROPS, ANIMATE_PROPS };
