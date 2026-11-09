'use strict';
/*
 * sd-recipes.js — saved picture settings ("recipes"), so the same look can be used again.
 *
 * A recipe holds every setting that decides how a picture looks EXCEPT the words of one picture:
 * checkpoint, VAE, sampler, scheduler, steps, CFG, size, CLIP skip, style chip, negative prompt (or "the
 * automatic one"), LoRAs with their weights, hires fix, refiner, ADetailer — and, optionally, a prompt
 * template with {subject} ("{subject}, head and shoulders portrait, soft window light").
 *
 * Stored as JSON in AutoInjector's own data folder (sd-recipes.json next to sd-library.json). A few honest
 * "starter" recipes are built in (from sd-quality.js's model-family defaults); they can be used, copied and
 * hidden, not changed. Electron-free; unit-tested in test/images-judge.test.js.
 *
 *   createRecipeStore({ file, log, kind }) → {
 *     list({ families }) · get(idOrName) · save(recipe) · rename(id, name) · remove(id) · setDefault(id|'') · defaultRecipe()
 *     fromRecord(record, name) · fromForm(form, name) · toRequest(recipe, { subject, request }) · exportAll()
 *   }
 *   kind (optional, default = pictures): { starters, clean(settings), summary(recipe) → short words, family(settings),
 *   tag (the log type), what ('picture' | 'video') } — 🎬 video recipes (video-recipes.js) use the same store with
 *   their own starters and settings, in their own file (video-recipes.json).
 */
const fs = require('fs');
const path = require('path');
const Q = require('./sd-quality');
const { SETTING_KEYS } = require('./sd-record');

const MAX_RECIPES = 200;
const STYLE_IDS = Object.keys(Q.STYLES);

function starter(id, name, family, extra) {
  const d = Q.defaultsFor(family);
  const aspect = extra.aspect || 'portrait';
  const sz = Q.sizeFor(family, aspect);
  const settings = Object.assign({ steps: d.steps, cfgScale: d.cfgScale, sampler: d.sampler, scheduler: d.scheduler, width: sz.width, height: sz.height, negativeMode: 'auto' }, extra.settings || {});
  return Object.freeze({ id, name, starter: true, family, description: extra.description, promptTemplate: extra.promptTemplate || '', onlyIfFamily: extra.onlyIfFamily || '', settings: Object.freeze(settings) });
}
// Starter recipes: a good beginning for the usual models — labelled "starter", built from the family defaults.
const STARTERS = [
  starter('starter-sdxl-portrait', 'Realistic portrait — SDXL (starter)', 'SDXL', {
    description: 'A realistic head-and-shoulders portrait on an SDXL checkpoint (Juggernaut XL, RealVis XL …). 832×1216, DPM++ 2M Karras, 28 steps, CFG 5.5, Photo-real style.',
    promptTemplate: '{subject}, head and shoulders portrait, detailed face, soft natural light', settings: { style: 'photo' } }),
  starter('starter-sdxl-cinematic', 'Cinematic scene — SDXL (starter)', 'SDXL', {
    description: 'A wide film-still scene on an SDXL checkpoint. 1216×832, DPM++ 2M Karras, 30 steps, CFG 5.5, Cinematic style.',
    aspect: 'landscape', promptTemplate: '{subject}, wide shot, cinematic composition', settings: { style: 'cinematic', steps: 30 } }),
  starter('starter-sd15-hires', 'Portrait with hires fix — SD1.5 (starter)', 'SD1.5', {
    description: 'An SD1.5 portrait made at 512×768, then made 1.5× bigger with added detail (hires fix). DPM++ 2M Karras, 28 steps, CFG 7.',
    promptTemplate: '{subject}, portrait, detailed face', settings: { style: 'photo', hires: { scale: 1.5, upscaler: 'Latent', denoise: 0.45, secondPassSteps: 14 } } }),
  starter('starter-book-portrait', 'Book character portrait — SDXL (starter)', 'SDXL', {
    description: 'For Akọwe\'s character pictures: one person, plain background, so the face is easy to reuse. 832×1216, Photo-real.',
    promptTemplate: '{subject}, one person, head and shoulders portrait, plain light grey background, looking at the viewer', settings: { style: 'photo' } }),
  starter('starter-flux', 'Natural picture — Flux (starter)', 'Flux', {
    description: 'Flux checkpoints: 896×1152, Euler Simple, 20 steps, CFG 1 (Flux needs no negative prompt). Shown when a Flux model is installed.',
    onlyIfFamily: 'Flux', settings: { negativeMode: 'none' } }),
];

function slug(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'recipe'; }
function clampNum(v, lo, hi) { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined; }
function str(v, n) { return v == null ? undefined : String(v).slice(0, n || 300); }

/** Keep only known settings, with sane values. Unknown keys are dropped (never an error: a recipe from an old version still loads). */
function cleanSettings(s0) {
  const s = s0 && typeof s0 === 'object' ? s0 : {};
  const o = {};
  for (const k of ['checkpoint', 'vae', 'sampler', 'scheduler']) if (s[k] != null && s[k] !== '') o[k] = str(s[k], 300);
  if (s.steps != null) o.steps = Math.round(clampNum(s.steps, 1, 150) || 20);
  if (s.cfgScale != null) o.cfgScale = clampNum(s.cfgScale, 0, 30);
  for (const k of ['width', 'height']) if (s[k] != null) o[k] = Math.round((clampNum(s[k], 64, 4096) || 512) / 8) * 8;
  if (s.clipSkip != null && Number(s.clipSkip) > 1) o.clipSkip = Math.round(clampNum(s.clipSkip, 1, 12));
  if (STYLE_IDS.includes(s.style)) o.style = s.style;
  if (['auto', 'replace', 'add', 'none'].includes(s.negativeMode)) o.negativeMode = s.negativeMode;
  if (s.negativePrompt != null && String(s.negativePrompt).trim()) { o.negativePrompt = str(s.negativePrompt, 2000); if (!o.negativeMode) o.negativeMode = 'replace'; }
  if (Array.isArray(s.loras)) o.loras = s.loras.filter((l) => l && l.name).slice(0, 12).map((l) => ({ name: str(l.name, 200), weight: clampNum(l.weight, -5, 5) != null ? Math.round(clampNum(l.weight, -5, 5) * 100) / 100 : 0.8 }));
  if (s.hires && typeof s.hires === 'object') {
    o.hires = {};
    if (s.hires.scale != null) o.hires.scale = clampNum(s.hires.scale, 1, 4);
    if (s.hires.upscaler) o.hires.upscaler = str(s.hires.upscaler, 120);
    if (s.hires.denoise != null) o.hires.denoise = clampNum(s.hires.denoise, 0, 1);
    if (s.hires.secondPassSteps != null) o.hires.secondPassSteps = Math.round(clampNum(s.hires.secondPassSteps, 0, 150));
  }
  if (s.refiner && s.refiner.checkpoint) o.refiner = { checkpoint: str(s.refiner.checkpoint, 300), switchAt: clampNum(s.refiner.switchAt != null ? s.refiner.switchAt : 0.8, 0.01, 1) };
  if (Array.isArray(s.adetailer) && s.adetailer.length) o.adetailer = s.adetailer.slice(0, 4).map((u) => { const x = {}; if (u.model) x.model = str(u.model, 120); if (u.prompt) x.prompt = str(u.prompt, 1000); if (u.confidence != null) x.confidence = clampNum(u.confidence, 0, 1); if (u.denoise != null) x.denoise = clampNum(u.denoise, 0, 1); return x; });
  if (s.restoreFaces) o.restoreFaces = true;
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

function pictureSummary(s) {
  return [s.width && s.height ? `${s.width}×${s.height}` : '', s.sampler ? `${s.sampler}${s.scheduler ? ` ${s.scheduler}` : ''}` : '', s.steps ? `${s.steps} steps` : '', s.cfgScale != null ? `CFG ${s.cfgScale}` : '', s.loras && s.loras.length ? `${s.loras.length} LoRA${s.loras.length > 1 ? 's' : ''}` : '', s.hires ? 'hires fix' : ''].filter(Boolean).join(' · ');
}
const PICTURE_KIND = { starters: STARTERS, clean: cleanSettings, summary: pictureSummary, family: (s) => Q.familyOf((s && s.checkpoint) || '') || '', tag: 'sd-recipes', what: 'picture' };

function createRecipeStore(opts) {
  const o = opts || {};
  const file = o.file || null;
  const log0 = o.log || (() => {});
  const K = Object.assign({}, PICTURE_KIND, o.kind || {});
  const STARTERS = K.starters; const cleanSettings = K.clean; // eslint-disable-line no-shadow
  const log = (t, d) => log0(t === 'sd-recipes' ? K.tag : t, d);
  let data = { version: 1, defaultId: '', recipes: [], hiddenStarters: [] };
  function load() {
    if (!file) return;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && Array.isArray(j.recipes)) data = { version: 1, defaultId: String(j.defaultId || ''), recipes: j.recipes.filter((r) => r && r.id && r.name).map((r) => Object.assign({}, r, { settings: cleanSettings(r.settings) })), hiddenStarters: Array.isArray(j.hiddenStarters) ? j.hiddenStarters.map(String) : [] };
    } catch (e) { if (e && e.code !== 'ENOENT') log('sd-recipes', { load: 'unreadable', error: e.code || 'PARSE' }); }
  }
  function persist() {
    if (!file) return true;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(data, null, 1)); fs.renameSync(tmp, file); return true; }
    catch (e) { log('sd-recipes', { save: 'failed', error: (e && e.code) || 'WRITE' }); return false; }
  }
  load();

  function all() { return [...data.recipes, ...STARTERS.filter((s) => !data.hiddenStarters.includes(s.id))]; }
  function find(key) {
    const k = String(key || '').trim(); if (!k) return null;
    const lk = k.toLowerCase();
    return all().find((r) => r.id === k) || all().find((r) => r.name.toLowerCase() === lk) || all().find((r) => r.name.toLowerCase().replace(/\s*\(starter\)\s*$/, '') === lk) || null;
  }
  function summary(r) {
    const s = r.settings || {};
    return { id: r.id, name: r.name, starter: !!r.starter, family: r.family || K.family(s) || '', checkpoint: s.checkpoint || '', isDefault: data.defaultId === r.id, short: K.summary(s), description: r.description || '', hasTemplate: !!r.promptTemplate, updatedAt: r.updatedAt || null, engine: s.engine || undefined, mode: r.mode || undefined };
  }
  function list(ctx) {
    const fams = new Set((ctx && ctx.families) || []);
    const items = all().filter((r) => !r.onlyIfFamily || fams.has(r.onlyIfFamily)).map(summary);
    return { ok: true, recipes: items, defaultId: data.defaultId || '', count: items.length };
  }
  function get(key) {
    const r = find(key);
    if (!r) return { ok: false, error: 'NO_RECIPE', code: 'NO_RECIPE', message: `There's no recipe called “${String(key || '').slice(0, 80)}”.`, hint: `Recipes: ${all().map((x) => x.name).slice(0, 12).join(', ')}` };
    return { ok: true, recipe: JSON.parse(JSON.stringify(r)), isDefault: data.defaultId === r.id };
  }
  function save(rec) {
    const r = rec || {};
    const name = String(r.name || '').trim().slice(0, 120);
    if (!name) return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', field: 'name', message: K.what === 'video' ? 'Give the recipe a name, e.g. “Calm character clip — Wan 2.2”.' : 'Give the recipe a name, e.g. “Realistic portrait — SDXL”.' };
    if (r.id && STARTERS.some((s) => s.id === r.id)) return { ok: false, error: 'STARTER', code: 'STARTER', message: 'Starter recipes can\'t be changed — save it under a new name instead.' };
    const prev = r.id ? data.recipes.find((x) => x.id === r.id) : data.recipes.find((x) => x.name.toLowerCase() === name.toLowerCase());
    // updating: the given settings are added to the recipe's (Alfred changes one thing); replace: true = exactly these (the form)
    const settings = cleanSettings(prev && !r.replace ? Object.assign({}, prev.settings, r.settings || {}) : r.settings);
    if (!Object.keys(settings).length) return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', field: 'settings', message: 'That recipe has no settings to save.' };
    const promptTemplate = r.promptTemplate !== undefined && r.promptTemplate !== null ? String(r.promptTemplate).slice(0, 2000) : (prev && !r.replace ? prev.promptTemplate || '' : '');
    if (promptTemplate && !/\{subject\}/.test(promptTemplate)) return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', field: 'promptTemplate', message: `A prompt template needs {subject} where the ${K.what}'s own words go, e.g. “{subject}, soft window light”.` };
    const now = new Date().toISOString();
    let cur = r.id ? data.recipes.find((x) => x.id === r.id) : data.recipes.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!cur && data.recipes.length >= MAX_RECIPES) return { ok: false, error: 'TOO_MANY', code: 'TOO_MANY', message: `There are already ${MAX_RECIPES} recipes — delete some first.` };
    const clash = data.recipes.find((x) => x.name.toLowerCase() === name.toLowerCase() && (!cur || x.id !== cur.id));
    if (clash) return { ok: false, error: 'NAME_TAKEN', code: 'NAME_TAKEN', message: `There is already a recipe called “${name}”.` };
    const created = !cur;
    if (!cur) {
      let id = `r-${slug(name)}`; let i = 2;
      while (all().some((x) => x.id === id)) id = `r-${slug(name)}-${i++}`;
      cur = { id, createdAt: now };
      data.recipes.push(cur);
    }
    Object.assign(cur, { name, settings, promptTemplate, description: r.description ? String(r.description).slice(0, 600) : (cur.description || ''), family: r.family || K.family(settings) || cur.family || '', from: String(r.from || cur.from || 'form').slice(0, 40), updatedAt: now });
    if (r.mode || cur.mode) cur.mode = String(r.mode || cur.mode).slice(0, 10);
    if (r.makeDefault) data.defaultId = cur.id;
    if (!persist()) return { ok: false, error: 'SAVE_FAILED', code: 'SAVE_FAILED', message: 'The recipe couldn\'t be saved (the data folder is not writable).' };
    log('sd-recipes', { op: created ? 'add' : 'update', id: cur.id, keys: Object.keys(settings).length, template: !!promptTemplate });
    return { ok: true, created, recipe: JSON.parse(JSON.stringify(cur)) };
  }
  function rename(id, name) {
    const cur = data.recipes.find((x) => x.id === id) || (find(id) && data.recipes.find((x) => x.id === find(id).id));
    if (!cur) return find(id) && find(id).starter ? { ok: false, error: 'STARTER', code: 'STARTER', message: 'Starter recipes can\'t be renamed — save a copy under the new name.' } : get(id);
    return save(Object.assign({}, cur, { name }));
  }
  function remove(id) {
    const r = find(id);
    if (!r) return get(id);
    if (r.starter) { if (!data.hiddenStarters.includes(r.id)) data.hiddenStarters.push(r.id); }
    else data.recipes = data.recipes.filter((x) => x.id !== r.id);
    if (data.defaultId === r.id) data.defaultId = '';
    persist();
    log('sd-recipes', { op: r.starter ? 'hide-starter' : 'delete', id: r.id });
    return { ok: true, deleted: r.id, starterHidden: !!r.starter };
  }
  function setDefault(id) {
    if (!id) { data.defaultId = ''; persist(); return { ok: true, defaultId: '' }; }
    const r = find(id); if (!r) return get(id);
    data.defaultId = r.id; persist();
    log('sd-recipes', { op: 'default', id: r.id });
    return { ok: true, defaultId: r.id, name: r.name };
  }
  function defaultRecipe() { return data.defaultId ? find(data.defaultId) : null; }

  return { list, get, save, rename, remove, setDefault, defaultRecipe, fromRecord, fromForm, toRequest, exportAll: () => JSON.parse(JSON.stringify({ defaultId: data.defaultId, recipes: data.recipes })), STARTERS };
}

/** A picture's sidecar → recipe settings ("use these settings again"). The prompt is left out; the typed words become nothing,
 *  the automatic negative stays automatic. */
function fromRecord(rec, name) {
  const r = rec || {};
  const s = {};
  for (const k of SETTING_KEYS) if (r[k] !== undefined && r[k] !== null && r[k] !== '') s[k] = r[k];
  if (r.negativeAuto) { delete s.negativePrompt; s.negativeMode = 'auto'; }
  else if (s.negativePrompt) s.negativeMode = 'replace';
  if (r.checkpoint) s.checkpoint = r.checkpoint;
  const fam = r.family || Q.familyOf(r.checkpoint || '');
  const nm = name || `${fam ? `${fam} — ` : ''}${r.style && Q.STYLES[r.style] ? Q.STYLES[r.style].label : 'my settings'} (${String(r.createdAt || new Date().toISOString()).slice(0, 10)})`;
  return { name: nm, settings: cleanSettings(s), family: fam, from: 'picture', description: `Saved from a picture${r.file ? ` (${r.file})` : ''}.` };
}
/** The Images tab form (formRequest() + advanced) → recipe settings. */
function fromForm(form, name) {
  const f = form || {};
  const s = cleanSettings(Object.assign({}, f, { negativeMode: f.negativeTyped ? 'replace' : 'auto', negativePrompt: f.negativeTyped || undefined }));
  return { name: name || 'My settings', settings: s, family: Q.familyOf(f.checkpoint || ''), from: 'form' };
}
/** A recipe + the picture's own words → an images.generate request. Request fields win over the recipe's. */
function toRequest(recipe, ctx) {
  const rc = recipe || {};
  const c = ctx || {};
  const s = cleanSettings(rc.settings);
  const req = {};
  for (const [k, v] of Object.entries(s)) if (k !== 'negativeMode') req[k] = JSON.parse(JSON.stringify(v));
  if (s.negativeMode === 'auto' || s.negativeMode === 'none') delete req.negativePrompt; // the family's own default is added later (none: Flux)
  const subject = String(c.subject != null ? c.subject : '').trim();
  const tpl = String(rc.promptTemplate || '');
  if (tpl && subject) req.prompt = tpl.replace(/\{subject\}/g, subject);
  else if (subject) req.prompt = subject;
  const out = Object.assign(req, Object.assign({}, c.request || {}));
  if (subject && tpl) { out.prompt = tpl.replace(/\{subject\}/g, subject); out.promptTyped = subject; }
  if (c.request && c.request.negativePrompt && s.negativeMode === 'add' && s.negativePrompt) out.negativePrompt = Q.mergeTerms(c.request.negativePrompt, s.negativePrompt);
  return out; // LoRAs given with the request replace the recipe's (an empty list = none)
}

module.exports = { createRecipeStore, cleanSettings, fromRecord, fromForm, toRequest, STARTERS, PICTURE_KIND };
