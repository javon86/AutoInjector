'use strict';
/*
 * video-recipes.js — saved 🎬 VIDEO settings ("recipes"), the twin of the picture recipes (sd-recipes.js).
 *
 * The SAME store (sd-recipes.js createRecipeStore: list / get / save / rename / delete / hide a starter / ⭐ default,
 * a {subject} prompt template), with video settings and its own file (video-recipes.json next to sd-recipes.json).
 * Why a separate list and not `kind: "video"` in the picture file: a video recipe has nothing a picture can use (engine,
 * seconds, fps, shift, FramePack's TeaCache …) and the other way round, the two pickers live on different tabs, and
 * an old AutoInjector that reads sd-recipes.json must not meet settings it doesn't know. One store, two files.
 *
 * A recipe holds every setting that decides how a video looks EXCEPT the words of one video: engine (comfy-wan |
 * framepack), model, seconds, fps, size, steps, CFG, shift, sampler, scheduler, the negative prompt (or "the automatic
 * one"), FramePack's distilled CFG / TeaCache / GPU memory — and, optionally, a prompt template with {subject}.
 * A few honest starters are built in, from the engines' own defaults (video-installer.js, video-studio.js FP_DEFAULTS).
 *
 *   createVideoRecipeStore({ file, log }) → the sd-recipes store (list · get · save · rename · remove · setDefault · defaultRecipe)
 *   cleanSettings(s) · fromRecord(videoRecord, name) · fromForm(form, name) · toRequest(recipe, { subject, request }) · STARTERS
 */
const SR = require('./sd-recipes');

const ENGINES = ['comfy-wan', 'framepack'];
const MODELS = ['wan22-ti2v-5b', 'wan21-t2v-1.3b'];

function starter(id, name, o) { return Object.freeze({ id, name, starter: true, family: o.family, mode: o.mode, description: o.description, promptTemplate: o.promptTemplate || '', settings: Object.freeze(Object.assign({ negativeMode: 'auto' }, o.settings)) }); }
// From the engines' own defaults: Wan 2.2 5B (ComfyUI's template: 1280×704, 24 fps, 20 steps, CFG 5, uni_pc / simple, shift 8),
// Wan 2.1 1.3B (832×480, 16 fps, 30 steps, CFG 6), FramePack (30 fps, 25 steps, distilled CFG 10, TeaCache, 6 GB kept free).
const STARTERS = [
  starter('vstarter-wan22-t2v', 'Text → video — Wan 2.2 5B (starter)', { family: 'Wan 2.2 5B', mode: 't2v',
    description: 'A 5-second clip from words with Wan 2.2 5B on ComfyUI: 1280×704, 24 fps, 20 steps, CFG 5, shift 8, uni_pc / simple. About 12 GB of graphics memory.',
    settings: { engine: 'comfy-wan', model: 'wan22-ti2v-5b', seconds: 5, fps: 24, width: 1280, height: 704, steps: 20, cfgScale: 5, shift: 8, sampler: 'uni_pc', scheduler: 'simple' } }),
  starter('vstarter-wan22-i2v', 'Picture → video — Wan 2.2 5B (starter)', { family: 'Wan 2.2 5B', mode: 'i2v',
    description: 'Brings a picture to life with Wan 2.2 5B: 4 s at 24 fps, the picture\'s shape kept, 20 steps, CFG 5, shift 8. Calm, steady camera.',
    promptTemplate: '{subject}, smooth natural motion, steady camera',
    settings: { engine: 'comfy-wan', model: 'wan22-ti2v-5b', seconds: 4, fps: 24, steps: 20, cfgScale: 5, shift: 8, sampler: 'uni_pc', scheduler: 'simple' } }),
  starter('vstarter-wan21-fast', 'Quick and light — Wan 2.1 1.3B (starter)', { family: 'Wan 2.1 1.3B', mode: 't2v',
    description: 'Small and fast (about 8 GB of graphics memory): text → video at 832×480, 16 fps, 3 s, 30 steps, CFG 6. Good for trying ideas.',
    settings: { engine: 'comfy-wan', model: 'wan21-t2v-1.3b', seconds: 3, fps: 16, width: 832, height: 480, steps: 30, cfgScale: 6, shift: 8, sampler: 'uni_pc', scheduler: 'simple' } }),
  starter('vstarter-fp-i2v', 'Picture → video — FramePack (starter)', { family: 'FramePack', mode: 'i2v',
    description: 'FramePack brings a picture to life: 5 s at 30 fps, 25 steps, distilled CFG 10, Faster (TeaCache) on, 6 GB of graphics memory kept free.',
    settings: { engine: 'framepack', seconds: 5, steps: 25, distilledCfg: 10, teacache: true, gpuMemoryPreservation: 6 } }),
  starter('vstarter-fp-character', 'Character moves — FramePack (starter)', { family: 'FramePack', mode: 'i2v',
    description: 'A character portrait that moves (breathing, a small expression): FramePack, 4 s, 25 steps, distilled CFG 10, TeaCache off for sharper faces (slower).',
    promptTemplate: '{subject}, the character moves naturally, breathing, subtle facial expression, steady camera',
    settings: { engine: 'framepack', seconds: 4, steps: 25, distilledCfg: 10, teacache: false, gpuMemoryPreservation: 6 } }),
];

const num = (v, lo, hi) => { const n = Number(v); return v === undefined || v === null || v === '' || !Number.isFinite(n) ? undefined : Math.min(hi, Math.max(lo, n)); };
function cleanSettings(s0) {
  const s = s0 && typeof s0 === 'object' ? s0 : {};
  const o = {};
  if (ENGINES.includes(s.engine)) o.engine = s.engine; else if (s.engine === 'wan' || s.engine === 'comfy') o.engine = 'comfy-wan';
  if (MODELS.includes(s.model)) o.model = s.model;
  if (o.engine === 'framepack') delete o.model;
  const sec = num(s.seconds, 1, 10); if (sec !== undefined) o.seconds = Math.round(sec * 2) / 2;
  const fps = num(s.fps, 1, 60); if (fps !== undefined && o.engine !== 'framepack') o.fps = Math.round(fps);
  for (const k of ['width', 'height']) { const v = num(s[k], 256, 1280); if (v !== undefined && o.engine !== 'framepack') o[k] = Math.round(v / 16) * 16; }
  const st = num(s.steps, 1, 100); if (st !== undefined) o.steps = Math.round(st);
  const cfg = num(s.cfgScale, 1, 20); if (cfg !== undefined && o.engine !== 'framepack') o.cfgScale = cfg;
  const sh = num(s.shift, 0, 20); if (sh !== undefined && o.engine !== 'framepack') o.shift = sh;
  for (const k of ['sampler', 'scheduler']) if (s[k] && typeof s[k] === 'string' && o.engine !== 'framepack') o[k] = s[k].slice(0, 60);
  if (o.engine === 'framepack' || s.engine === undefined) {
    const d = num(s.distilledCfg, 1, 32); if (d !== undefined) o.distilledCfg = d;
    if (typeof s.teacache === 'boolean') o.teacache = s.teacache;
    const g = num(s.gpuMemoryPreservation, 6, 128); if (g !== undefined) o.gpuMemoryPreservation = g;
  }
  if (['auto', 'replace'].includes(s.negativeMode)) o.negativeMode = s.negativeMode;
  if (s.negativePrompt != null && String(s.negativePrompt).trim()) { o.negativePrompt = String(s.negativePrompt).slice(0, 2000); if (!o.negativeMode) o.negativeMode = 'replace'; }
  return o;
}
function summary(s) {
  const fp = s.engine === 'framepack';
  return [fp ? 'FramePack' : s.model === 'wan21-t2v-1.3b' ? 'Wan 2.1 1.3B' : s.model ? 'Wan 2.2 5B' : '', s.seconds ? `${s.seconds} s` : '', !fp && s.width && s.height ? `${s.width}×${s.height}` : '', !fp && s.fps ? `${s.fps} fps` : '',
    s.steps ? `${s.steps} steps` : '', !fp && s.cfgScale != null ? `CFG ${s.cfgScale}` : '', fp && s.distilledCfg != null ? `distilled CFG ${s.distilledCfg}` : '', fp && s.teacache === false ? 'TeaCache off' : ''].filter(Boolean).join(' · ');
}
function family(s) { return s.engine === 'framepack' ? 'FramePack' : s.model === 'wan21-t2v-1.3b' ? 'Wan 2.1 1.3B' : s.model === 'wan22-ti2v-5b' ? 'Wan 2.2 5B' : ''; }
const VIDEO_KIND = { starters: STARTERS, clean: cleanSettings, summary, family, tag: 'video-recipes', what: 'video' };

function createVideoRecipeStore(opts) { return SR.createRecipeStore(Object.assign({}, opts || {}, { kind: VIDEO_KIND })); }

/** A video's sidecar → recipe settings ("use these settings again"). The prompt is left out. */
function fromRecord(rec, name) {
  const r = rec || {};
  const fp = r.engine === 'framepack' || r.model === 'framepack-i2v-hy';
  const f = r.framepack || {};
  const s = fp ? { engine: 'framepack', seconds: f.wantSeconds != null ? f.wantSeconds : r.seconds, steps: f.steps != null ? f.steps : r.steps, distilledCfg: f.distilledCfg != null ? f.distilledCfg : r.distilledCfg, teacache: (f.teacache != null ? f.teacache : r.teacache) !== false, gpuMemoryPreservation: f.gpuMemoryPreservation != null ? f.gpuMemoryPreservation : r.gpuMemoryPreservation }
    : { engine: 'comfy-wan', model: r.model, seconds: r.seconds, fps: r.fps, width: r.mode === 'i2v' ? undefined : r.width, height: r.mode === 'i2v' ? undefined : r.height, steps: r.steps, cfgScale: r.cfgScale, shift: r.shift, sampler: r.sampler, scheduler: r.scheduler };
  if (r.negativeAuto) s.negativeMode = 'auto'; else if (r.negativePrompt) { s.negativePrompt = r.negativePrompt; s.negativeMode = 'replace'; }
  const settings = cleanSettings(s);
  const nm = name || `${family(settings) || 'Video'} — ${r.mode === 'i2v' ? 'picture → video' : 'text → video'} (${String(r.createdAt || new Date().toISOString()).slice(0, 10)})`;
  return { name: nm, settings, family: family(settings), mode: r.mode === 'i2v' ? 'i2v' : 't2v', from: 'video', description: `Saved from a video${r.file ? ` (${r.file})` : ''}.` };
}
/** The 🎬 Video form → recipe settings. */
function fromForm(form, name) {
  const f = form || {};
  const s = cleanSettings(Object.assign({}, f, { engine: f.backend === 'framepack' || f.engine === 'framepack' ? 'framepack' : 'comfy-wan', negativeMode: f.negativePrompt ? 'replace' : 'auto' }));
  return { name: name || 'My video settings', settings: s, family: family(s), mode: f.image ? 'i2v' : 't2v', from: 'form' };
}
/** A recipe + the video's own words → a video request (video-studio generate / animate). Request fields win. */
function toRequest(recipe, ctx) {
  const rc = recipe || {};
  const c = ctx || {};
  const s = cleanSettings(rc.settings);
  const req = {};
  for (const [k, v] of Object.entries(s)) if (k !== 'negativeMode' && k !== 'engine') req[k] = v;
  if (s.engine) req.backend = s.engine;
  if (s.negativeMode === 'auto') delete req.negativePrompt;
  const subject = String(c.subject != null ? c.subject : '').trim();
  const tpl = String(rc.promptTemplate || '');
  const out = Object.assign(req, Object.assign({}, c.request || {}));
  if (subject && tpl) { out.prompt = tpl.replace(/\{subject\}/g, subject); out.promptTyped = subject; } else if (subject && !out.prompt) out.prompt = subject;
  out.recipeUsed = { id: rc.id, name: rc.name };
  return out;
}

module.exports = { createVideoRecipeStore, cleanSettings, fromRecord, fromForm, toRequest, summary, STARTERS, VIDEO_KIND };
