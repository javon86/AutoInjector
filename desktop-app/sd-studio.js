'use strict';
/*
 * sd-studio.js — the 🎨 Images tab's brain, Electron-free so it is testable.
 * Glues image-provider (connect / generate / progress / cancel), sd-library
 * (models, LoRAs, collections, character locks) and sd-images (save with the
 * settings embedded) together, and implements the bridge contract Akọwe will
 * use to ask for a portrait or a cover with a character lock
 * (POST /image/request — see docs/SD_IMAGE_API.md).
 *
 * Also everything beyond txt2img (sd-control.js / sd-workflows.js): img2img,
 * inpaint, upscale, settings-menu options, ControlNet / ADetailer / styles /
 * scripts / upscalers lists, interrupt / skip / refresh / memory, the validated
 * pass-through schema, ComfyUI node types / queue / uploads, saved workflows.
 *
 * main.js passes: imageProvider, library, imagesDir(), recordImage(entry),
 * persist() (save settings), log(type, data), fileUrl(path), workflowsDir().
 */
const sdImages = require('./sd-images');
const sdBackends = require('./sd-backends');
const sdParams = require('./sd-params');
const control = require('./sd-control');
const sdWorkflows = require('./sd-workflows');
const sdErrors = require('./sd-errors');

const PURPOSES = ['portrait', 'cover', 'scene', 'illustration', 'test', 'free'];

// Width × height for a purpose on a model family (multiples of 64).
function sizeFor(purpose, base) {
  const big = ['SDXL', 'Pony', 'Illustrious', 'NoobAI', 'Flux', 'SD3'].includes(base);
  if (purpose === 'portrait' || purpose === 'cover') return big ? { width: 832, height: 1216 } : { width: 512, height: 768 };
  if (purpose === 'scene' || purpose === 'illustration') return big ? { width: 1216, height: 832 } : { width: 768, height: 512 };
  return big ? { width: 1024, height: 1024 } : { width: 512, height: 512 };
}

function createSdStudio(deps) {
  const ip = deps.imageProvider;
  const lib = deps.library;
  const log = deps.log || (() => {});
  const persist = deps.persist || (() => {});
  const fileUrl = deps.fileUrl || ((p) => p);
  const imagesDir = deps.imagesDir;
  const recordImage = deps.recordImage || (() => {});
  const wfStore = deps.workflowsDir ? sdWorkflows.createWorkflowStore({ dir: deps.workflowsDir() }) : null;
  let lastLists = null;

  function withUrls(item) { return item && item.preview ? Object.assign({}, item, { previewUrl: fileUrl(item.preview) }) : item; }

  async function detect(opts) { const r = await sdBackends.detect(opts || {}); log('sd-detect', { found: r.found.map((f) => `${f.label}:${f.port}`), problems: r.problems.map((f) => `${f.kind}:${f.port}`) }); return r; }

  async function connect(url, opts) {
    const r = await ip.connect(url, opts || {});
    log('sd-connect', { ok: r.ok, kind: r.kind, port: r.port, label: r.label });
    if (r.ok) {
      persist();
      const l = await lists();
      r.lists = l.ok ? { checkpoints: l.checkpoints.length, loras: l.loras.length, samplers: l.samplers.length } : null;
      if (l.ok && l.current && l.current.checkpoint) r.model = l.current.checkpoint;
    }
    r.status = ip.status();
    return r;
  }

  async function lists() {
    const l = await ip.lists();
    if (l && l.ok) { lastLists = l; try { lib && lib.mergeBackend(l); } catch (_) {} }
    return l;
  }

  function settings(patch) { const s = ip.setSettings(patch || {}); persist(); return Object.assign({ ok: true }, ip.status(), { settings: s }); }

  // Turn a UI / bridge request into generate() options (+ a character lock).
  function buildRequest(req) {
    const r = Object.assign({}, req || {});
    let prompt = String(r.prompt || '').trim();
    let opts = {
      negativePrompt: r.negativePrompt || r.negative || '', loras: Array.isArray(r.loras) ? r.loras : [],
      steps: r.steps, cfgScale: r.cfgScale, width: r.width, height: r.height, seed: r.seed, sampler: r.sampler, scheduler: r.scheduler,
      checkpoint: r.checkpoint, vae: r.vae, batchSize: r.batchSize || r.count, batchCount: r.batchCount || 1,
    };
    // Everything advanced (hires, refiner, img2img / inpaint, ControlNet, ADetailer, …) passes through as-is.
    for (const k of sdParams.ADV_KEYS) if (r[k] !== undefined && r[k] !== null && r[k] !== '') opts[k] = r[k];
    let lock = null;
    const lockKey = r.characterLock || r.lockId || r.character;
    if (lockKey && lib) {
      lock = lib.getLock(lockKey);
      if (!lock) return { error: 'NO_LOCK', message: `There's no character lock called “${lockKey}”. Make one in 🎨 Images → Library → Character locks.` };
      const a = lib.applyLock(lock, { prompt, negativePrompt: opts.negativePrompt, keepSeed: r.keepSeed });
      prompt = a.prompt;
      opts.negativePrompt = a.negativePrompt;
      const names = new Set(opts.loras.map((l) => String(l.name).toLowerCase()));
      opts.loras = [...a.loras.filter((l) => !names.has(String(l.name).toLowerCase())), ...opts.loras];
      for (const k of ['checkpoint', 'seed', 'width', 'height']) if (a[k] != null && (opts[k] == null || opts[k] === '')) opts[k] = a[k];
    }
    // Purpose → a sensible size when none was given.
    const purpose = PURPOSES.includes(r.purpose) ? r.purpose : 'free';
    if (!opts.width || !opts.height) {
      const ck = opts.checkpoint || ip.status().checkpoint || ip.status().model;
      const base = lib ? lib.checkLoras([], ck).checkpointBase : '';
      if (purpose !== 'free' || !ip.status().width) Object.assign(opts, sizeFor(purpose, base));
    }
    for (const k of Object.keys(opts)) if (opts[k] === undefined || opts[k] === '') delete opts[k];
    if (opts.negativePrompt === undefined) opts.negativePrompt = '';
    return { prompt, opts, lock, purpose };
  }

  // Generate + save + record. from = 'images-tab' | 'bridge:akowe' | …
  async function generate(req, from) {
    const b = buildRequest(req);
    if (b.error) return { ok: false, error: b.error, message: b.message };
    const warnings = [];
    if (lib && b.opts.loras && b.opts.loras.length) {
      const ck = b.opts.checkpoint || ip.status().checkpoint || ip.status().model || (lastLists && lastLists.current && lastLists.current.checkpoint) || '';
      try { warnings.push(...lib.checkLoras(b.opts.loras, ck).warnings); } catch (_) {}
    }
    // The chosen VAE against the library's header check (not a full VAE / wrong family).
    const vaeName = b.opts.vae != null ? b.opts.vae : ip.status().vae;
    let vaeInfo = null;
    if (lib && typeof lib.checkVae === 'function' && vaeName) {
      try {
        const ck = b.opts.checkpoint || ip.status().checkpoint || ip.status().model || (lastLists && lastLists.current && lastLists.current.checkpoint) || '';
        vaeInfo = lib.checkVae(vaeName, ck);
        if (vaeInfo && (vaeInfo.level === 'hard' || vaeInfo.level === 'soft')) warnings.push({ level: vaeInfo.level, name: vaeInfo.name, kind: 'vae', message: vaeInfo.message });
      } catch (_) { vaeInfo = null; }
    }
    const r = await ip.generate(b.prompt, b.opts);
    if (!r || !r.ok) {
      const out = Object.assign({ ok: false, warnings }, r || {}, { message: (r && r.message) || sdBackends.explain(r) });
      if (out.code === 'VAE_LOAD_FAILED') await explainVae(out, vaeName, vaeInfo);
      // Log the cause, never the prompt (the log is shared with the user).
      log('sd-generate', { ok: false, from, error: out.error, code: out.code || out.error, status: out.status, backend: out.backend, vae: vaeName || undefined });
      return out;
    }
    if (Array.isArray(r.warnings)) warnings.push(...r.warnings);
    if (r.missingLoras && r.missingLoras.length) warnings.push({ level: 'hard', name: r.missingLoras.join(', '), message: `ComfyUI doesn't have these LoRAs, so they were left out: ${r.missingLoras.join(', ')}` });
    const record = Object.assign({}, r.params, {
      backend: r.backend, label: r.label || ip.status().label, seeds: r.seeds, purpose: b.purpose, from: from || 'images-tab',
      characterLock: b.lock ? { id: b.lock.id, character: b.lock.character, book: b.lock.book } : undefined,
      book: req && req.book ? String(req.book).slice(0, 200) : undefined,
    });
    if (record.backend === 'a1111' && r.infoObj && r.infoObj.sd_model_name && !record.checkpoint) record.checkpoint = r.infoObj.sd_model_name;
    let saved;
    const prefix = b.purpose !== 'free' ? b.purpose : b.opts.mask ? 'inpaint' : b.opts.initImage ? 'img2img' : 'sd';
    try { saved = sdImages.saveGeneration(imagesDir(), r.images, record, { prefix }); }
    catch (e) { return { ok: false, error: 'SAVE_FAILED', message: `The picture was made but couldn't be saved: ${e.message || e}` }; }
    for (const s of saved) { try { recordImage({ path: s.path, prompt: s.record.prompt, seed: s.record.seed, model: s.record.checkpoint || '', from: from || 'images-tab', sha256: s.sha256 }); } catch (_) {} }
    log('sd-generate', { ok: true, from, count: saved.length, backend: r.backend, lock: b.lock ? b.lock.character : null });
    const out = {
      ok: true, backend: r.backend, seed: r.seed, warnings, settings: record,
      images: saved.map((s) => ({ path: s.path, url: fileUrl(s.path), json: s.json, seed: s.record.seed, sha256: s.sha256 })),
    };
    if (req && req.returnImage) out.images.forEach((im, i) => { im.imageBase64 = r.images[i]; });
    return out;
  }

  // A VAE that can't be loaded: name it (the form's choice, else the VAE A1111
  // itself is set to) and add what the library's header check found.
  async function explainVae(out, vaeName, vaeInfo) {
    try {
      let name = vaeName && !/^(automatic|none)$/i.test(vaeName) ? vaeName : '';
      const st = ip.status();
      if (!name && st.backend === 'a1111' && st.base) { const o = await control.options(st.base); if (o.ok && o.options.sd_vae && !/^(automatic|none)$/i.test(o.options.sd_vae)) name = o.options.sd_vae; }
      let info = vaeInfo;
      if (name && (!info || !info.known) && lib && typeof lib.checkVae === 'function') info = lib.checkVae(name, '');
      const ex = sdErrors.explainSdError(out, { vae: name, vaeInfo: info && info.problem ? { problem: info.problem } : null });
      if (ex.code === 'VAE_LOAD_FAILED') { out.message = ex.message; out.fix = ex.fix; out.actions = ex.actions; }
    } catch (_) { /* keep the first explanation */ }
  }

  // One-click fixes offered with a failure (result.actions). Applies the fix and
  // retries ONCE. 'vae-automatic': VAE → Automatic in the form defaults and in
  // A1111's own settings (sd_vae), then the same request again with vae Automatic.
  async function fixAndRetry(fix, req, from) {
    if (fix !== 'vae-automatic') return { ok: false, error: 'UNKNOWN_FIX', code: 'UNKNOWN_FIX', message: `There is no fix called “${fix}”.`, hint: 'Known fixes: vae-automatic' };
    const applied = [];
    try { ip.setSettings({ vae: '' }); persist(); applied.push('form'); } catch (_) {}
    const st = ip.status();
    if (st.backend === 'a1111' && st.base) {
      try { const o = await control.setOptions(st.base, { sd_vae: 'Automatic' }); if (o && o.ok) applied.push('sd_vae'); else log('sd-fix', { fix, step: 'sd_vae', ok: false, code: o && (o.code || o.error) }); }
      catch (e) { log('sd-fix', { fix, step: 'sd_vae', ok: false, error: String((e && e.message) || e) }); }
    }
    log('sd-fix', { fix, applied });
    const q = Object.assign({}, req || {}, { vae: 'Automatic' });
    const r = q.test ? await testRender({ vae: 'Automatic' }) : q.mask ? await inpaint(q, from || 'images-tab:fix') : q.initImage ? await img2img(q, from || 'images-tab:fix') : await generate(q, from || 'images-tab:fix');
    return Object.assign(r || { ok: false }, { fixed: fix, applied, retried: true });
  }

  // "🧪 Test: make a 512px image" (o: overrides, e.g. { vae: 'Automatic' } for the retry)
  function testRender(o) { return generate(Object.assign({ prompt: 'a red apple on a white table, studio photo, simple', width: 512, height: 512, steps: Math.min(ip.status().steps || 20, 20), batchSize: 1, seed: -1, purpose: 'test' }, o || {}), 'images-tab:test'); }

  // Save pictures that are not from generate() (upscale, workflows) the same way.
  function saveOther(r, record, prefix, from, req) {
    let saved;
    try { saved = sdImages.saveGeneration(imagesDir(), r.images, Object.assign({ backend: r.backend, label: r.label || ip.status().label, from }, record), { prefix }); }
    catch (e) { return { ok: false, error: 'SAVE_FAILED', message: `The picture was made but couldn't be saved: ${e.message || e}` }; }
    for (const s of saved) { try { recordImage({ path: s.path, prompt: s.record.prompt || `(${prefix})`, seed: s.record.seed, model: s.record.checkpoint || '', from, sha256: s.sha256 }); } catch (_) {} }
    log(`sd-${prefix}`, { ok: true, from, count: saved.length, backend: r.backend });
    const out = { ok: true, backend: r.backend, seed: r.seed, warnings: r.warnings || [], settings: saved[0] ? saved[0].record : record,
      images: saved.map((s) => ({ path: s.path, url: fileUrl(s.path), json: s.json, seed: s.record.seed, sha256: s.sha256 })) };
    if (req && req.returnImage) out.images.forEach((im, i) => { im.imageBase64 = r.images[i]; });
    return out;
  }

  // ---- img2img / inpaint / upscale
  async function img2img(req, from) {
    if (!req || !req.initImage) return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', field: 'initImage', message: 'img2img needs a start picture (initImage).' };
    return generate(req, from || 'images-tab:img2img');
  }
  async function inpaint(req, from) {
    if (!req || !req.initImage) return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', field: 'initImage', message: 'Inpaint needs the picture to repaint (initImage).' };
    if (!req.mask) return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', field: 'mask', message: 'Inpaint needs a mask (white = repaint, black = keep).' };
    return generate(req, from || 'images-tab:inpaint');
  }
  async function upscale(req, from) {
    const q = Object.assign({}, req || {});
    const src = typeof q.image === 'string' && q.image.length < 1024 && /\.(png|jpe?g|webp)$/i.test(q.image) ? q.image : undefined;
    const r = await ip.upscale(q);
    if (!r || !r.ok) { log('sd-upscale', { ok: false, error: r && r.error }); return Object.assign({ ok: false }, r || {}, { message: (r && r.message) || sdBackends.explain(r) }); }
    let prompt;
    if (src) { const rec = sdImages.readRecord(src); if (rec) prompt = rec.prompt; }
    return saveOther(r, Object.assign({}, r.params, { prompt, source: src }), 'upscale', from || 'images-tab', q);
  }

  // ---- connection helpers for the extra operations
  function conn() {
    const st = ip.status();
    if (!st.endpoint) return { error: { ok: false, error: 'NO_ENDPOINT', code: 'NO_ENDPOINT', message: sdBackends.explain('NO_ENDPOINT') } };
    return { backend: st.backend, base: st.base };
  }
  function only(backend, feature, hint) {
    const c = conn();
    if (c.error) return c;
    if (c.backend !== backend) return { error: control.unsupported(feature, c.backend, hint) };
    return c;
  }
  const A1111_HINT = 'This is an Automatic1111 / Forge feature. Connect to Forge or A1111 (started with --api) to use it.';
  const COMFY_HINT = 'This is a ComfyUI feature. Connect to ComfyUI (http://127.0.0.1:8188) to use it.';
  async function comfyLists() { const l = await ip.lists(); if (l && l.ok) lastLists = l; return l; }

  // ---- settings menu (A1111 /sdapi/v1/options)
  async function optionsGet(keys) {
    const c = only('a1111', 'The settings menu', 'ComfyUI has no settings menu; its behaviour is in the workflow.'); if (c.error) return c.error;
    const r = await control.options(c.base);
    if (!r.ok) return r;
    const want = Array.isArray(keys) ? keys : (typeof keys === 'string' && keys ? [keys] : null);
    if (!want) return r;
    const out = {}; const missing = [];
    for (const k of want) { if (k in r.options) out[k] = r.options[k]; else missing.push(k); }
    if (missing.length) { const s = sdParams.suggest(missing[0], Object.keys(r.options)); return { ok: false, error: 'UNKNOWN_OPTION', code: 'UNKNOWN_OPTION', field: missing[0], message: `There is no setting “${missing.join(', ')}” on this server.`, hint: s.length ? `Did you mean: ${s.join(', ')}?` : '' }; }
    return { ok: true, options: out, count: want.length };
  }
  async function optionsSet(patch) {
    const c = only('a1111', 'The settings menu', 'ComfyUI has no settings menu; its behaviour is in the workflow.'); if (c.error) return c.error;
    const r = await control.setOptions(c.base, patch || {});
    log('sd-options-set', { ok: r.ok, keys: Object.keys(patch || {}), error: r.ok ? undefined : r.code });
    if (r.ok && patch && patch.sd_model_checkpoint) { try { ip.setSettings({ model: patch.sd_model_checkpoint }); persist(); } catch (_) {} }
    return r;
  }
  async function optionsSchema() {
    const c = only('a1111', 'The settings menu'); if (c.error) return c.error;
    const r = await control.options(c.base);
    if (!r.ok) return r;
    const sch = (await control.optionsSchema(c.base)) || {};
    const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
    return { ok: true, options: Object.keys(r.options).map((k) => ({ key: k, type: (sch[k] && sdParams.propTypes(sch[k]).types[0]) || typeOf(r.options[k]), current: r.options[k], description: (sch[k] && (sch[k].description || sch[k].title)) || '' })) };
  }

  // ---- lists
  async function upscalers() {
    const c = conn(); if (c.error) return c.error;
    if (c.backend === 'comfy') { const l = await comfyLists(); return l.ok ? { ok: true, upscalers: (l.upscaleModels || []).map((n) => ({ name: n, model: n })), latent: l.upscalers.filter((u) => /^latent/i.test(u)), all: l.upscalers } : l; }
    return control.upscalers(c.base);
  }
  async function controlnetModels() {
    const c = conn(); if (c.error) return c.error;
    if (c.backend === 'comfy') { const l = await comfyLists(); return l.ok ? { ok: true, models: l.controlnets || [] } : l; }
    return control.controlnetModels(c.base);
  }
  async function controlnetModules() {
    const c = conn(); if (c.error) return c.error;
    if (c.backend === 'comfy') { const l = await comfyLists(); return l.ok ? { ok: true, modules: l.preprocessors || ['none'], note: (l.preprocessors || []).length > 1 ? '' : 'Only "none": install comfyui_controlnet_aux for preprocessors.' } : l; }
    return control.controlnetModules(c.base);
  }
  async function adetailerModels() { const c = only('a1111', 'ADetailer', 'On ComfyUI use a workflow with FaceDetailer (Impact Pack) — sd.workflows.run.'); if (c.error) return c.error; return control.adetailerModels(c.base); }
  async function styles() { const c = only('a1111', 'Prompt styles', 'On ComfyUI put the style words into the prompt.'); if (c.error) return c.error; return control.styles(c.base); }
  async function scripts() { const c = only('a1111', 'Scripts', 'On ComfyUI build the same thing as a workflow and run it with sd.workflows.run.'); if (c.error) return c.error; return control.scripts(c.base); }
  async function embeddings() {
    const c = conn(); if (c.error) return c.error;
    if (c.backend === 'comfy') { const l = await comfyLists(); return l.ok ? { ok: true, loaded: l.embeddings.map((e) => e.name), skipped: [], usage: 'embedding:<name> in the prompt' } : l; }
    return control.embeddings(c.base);
  }
  async function extraFields(kind) { const c = only('a1111', 'Extra txt2img/img2img fields', 'ComfyUI takes workflows: use sd.workflows.run with "<node id>.<input>" params.'); if (c.error) return c.error; return control.extraFields(c.base, kind === 'img2img' ? 'img2img' : 'txt2img'); }

  // ---- control
  async function interrupt() {
    const c = conn(); if (c.error) return c.error;
    if (ip.status().busy) { try { await ip.cancel(); } catch (_) {} }
    return c.backend === 'comfy' ? control.comfyInterruptAll(c.base) : control.interrupt(c.base);
  }
  async function skip() { const c = only('a1111', 'Skip (go to the next picture of a batch)', 'On ComfyUI use interrupt.'); if (c.error) return c.error; return control.skip(c.base); }
  async function refresh(what) {
    const c = conn(); if (c.error) return c.error;
    if (c.backend === 'comfy') { const l = await lists(); return l.ok ? { ok: true, refreshed: { lists: 'ok' }, note: 'ComfyUI rescans its model folders on every list request.' } : l; }
    const r = await control.refresh(c.base, what || 'all');
    if (r.ok) await lists();
    return r;
  }
  async function memory() { const c = conn(); if (c.error) return c.error; return c.backend === 'comfy' ? control.comfyMemory(c.base) : control.memory(c.base); }

  // ---- ComfyUI only
  async function objectInfo(node) { const c = only('comfy', 'ComfyUI node types', COMFY_HINT); if (c.error) return c.error; return control.comfyObjectInfo(c.base, node); }
  async function queue() { const c = only('comfy', 'The ComfyUI queue', 'On A1111/Forge use images.progress().'); if (c.error) return c.error; return control.comfyQueue(c.base); }
  async function uploadImage(image, name) { const c = only('comfy', 'Uploading a picture to ComfyUI', COMFY_HINT); if (c.error) return c.error; return control.comfyUploadImage(c.base, image, name); }
  async function free(o) { const c = only('comfy', 'Freeing ComfyUI memory', 'On A1111/Forge use sd.options.set or restart the WebUI.'); if (c.error) return c.error; return control.comfyFree(c.base, o || {}); }

  // ---- saved ComfyUI workflows
  function noStore() { return { ok: false, error: 'NOT_WIRED', code: 'NOT_WIRED', message: 'Saved workflows are not available in this build.' }; }
  function workflowsList() { return wfStore ? wfStore.list() : noStore(); }
  function workflowGet(id) { return wfStore ? wfStore.get(id) : noStore(); }
  function workflowSave(rec) { if (!wfStore) return noStore(); const r = wfStore.save(rec || {}); log('sd-workflow-save', { ok: r.ok, name: rec && rec.name }); return r; }
  function workflowDelete(id) { return wfStore ? wfStore.remove(id) : noStore(); }
  async function runWorkflow(req, from) {
    const q = req || {};
    let spec;
    if (q.workflow) spec = { workflow: q.workflow, bindings: q.bindings, name: q.name || '(inline workflow)' };
    else {
      if (!wfStore) return noStore();
      const g = wfStore.get(q.id || q.name);
      if (!g.ok) return g;
      spec = { workflow: g.workflow, bindings: Object.assign({}, g.bindings, q.bindings || {}), name: g.name };
    }
    const r = await ip.runWorkflow({ workflow: spec.workflow, bindings: spec.bindings, params: q.params || {} }, { pollMs: q.pollMs });
    if (!r || !r.ok) { log('sd-workflow', { ok: false, error: r && r.error }); return Object.assign({ ok: false }, r || {}, { message: (r && r.message) || sdBackends.explain(r) }); }
    const pub = {};
    for (const [k, v] of Object.entries(q.params || {})) pub[k] = typeof v === 'string' && v.length > 300 ? '[image]' : v;
    const promptP = r.applied.find((a) => (sdWorkflows.ALIASES[a.param] || a.param) === 'prompt');
    const out = saveOther(r, { kind: 'workflow', workflowName: spec.name, params: pub, applied: r.applied, prompt: promptP ? r.workflow[promptP.node].inputs[promptP.input] : '', seed: r.seed }, 'workflow', from || 'images-tab', q);
    if (out.ok) out.applied = r.applied;
    return out;
  }

  // ---- one call for the UI: every list the advanced sections need (failures → empty)
  async function extras() {
    const c = conn(); if (c.error) return c.error;
    const safe = async (fn) => { try { const r = await fn(); return r && r.ok ? r : null; } catch (_) { return null; } };
    const [ups, cnm, cnmod, ad, sty, scr, opts, wf] = await Promise.all([
      safe(upscalers), safe(controlnetModels), safe(controlnetModules),
      c.backend === 'a1111' ? safe(adetailerModels) : null, c.backend === 'a1111' ? safe(styles) : null, c.backend === 'a1111' ? safe(scripts) : null,
      c.backend === 'a1111' ? safe(() => control.options(c.base)) : null, Promise.resolve(workflowsList()),
    ]);
    return { ok: true, backend: c.backend,
      upscalers: ups ? ups.all : [], upscaleModels: ups ? ups.upscalers.map((u) => u.name) : [],
      controlnet: cnm ? { models: cnm.models, modules: cnmod ? cnmod.modules : ['none'] } : null,
      adetailer: ad ? { models: ad.models } : null, styles: sty ? sty.styles.map((s) => s.name) : [],
      scripts: scr ? { txt2img: scr.txt2img, img2img: scr.img2img } : null,
      optionKeys: opts ? Object.keys(opts.options) : [], workflows: wf && wf.ok ? wf.workflows : [] };
  }

  // What the connected app can do (drives capabilities()).
  async function features() {
    const c = conn();
    if (c.error) return { connected: false, backend: '' };
    if (c.backend === 'comfy') {
      const l = await comfyLists();
      const nodes = l && l.ok ? l.nodes : [];
      return { connected: true, backend: 'comfy', label: ip.status().label, nodes, upscaleModel: nodes.includes('UpscaleModelLoader'), controlnet: nodes.includes('ControlNetApplyAdvanced') && nodes.includes('ControlNetLoader'), preprocessors: nodes.includes('AIO_Preprocessor'), clipSkip: nodes.includes('CLIPSetLastLayer'), workflows: !!wfStore };
    }
    const f = await control.a1111Features(c.base);
    return Object.assign({ connected: true, backend: 'a1111', label: ip.status().label, workflows: !!wfStore }, f);
  }

  function gallery(limit) { return { ok: true, items: sdImages.listGallery(imagesDir(), { limit: limit || 60 }).map((g) => Object.assign(g, { url: fileUrl(g.path) })) }; }
  function record(p) { const rec = sdImages.readRecord(p); return rec ? { ok: true, record: rec } : { ok: false, error: 'NO_RECORD', message: 'No settings were recorded for that picture.' }; }

  // ---- library pass-throughs (with preview URLs)
  function libList(f) { const r = lib.list(f || {}); r.items = r.items.map(withUrls); r.folders = lib.folders(); return r; }
  function libScan() { const r = lib.scan(); return r; }

  // ---- the Akọwe contract (POST /image/request)
  async function request(body) {
    const b = body || {};
    if (!b.prompt && !b.characterLock && !b.character) return { ok: false, error: 'NEED_PROMPT', message: 'Send a prompt (what to draw) and/or a characterLock.' };
    const st = ip.status();
    if (!st.endpoint) return { ok: false, error: 'NO_ENDPOINT', message: sdBackends.explain('NO_ENDPOINT') };
    const r = await generate(Object.assign({}, b, { batchSize: Math.max(1, Math.min(4, Number(b.count) || 1)) }), `bridge:${String(b.from || 'akowe').slice(0, 40)}`);
    if (!r.ok) return r;
    return { ok: true, purpose: r.settings.purpose, backend: r.backend, seed: r.seed, warnings: r.warnings, settings: r.settings,
      images: r.images.map((im) => { const o = { path: im.path, seed: im.seed, sha256: im.sha256 }; if (im.imageBase64) o.imageBase64 = im.imageBase64; return o; }) };
  }
  function backendInfo() { const s = ip.status(); return { ok: true, connected: !!(s.enabled && s.endpoint), backend: s.backend, label: s.label, base: s.base, checkpoint: s.checkpoint || s.model, busy: s.busy }; }
  function locks() { return lib ? lib.listLocks() : { ok: true, locks: [] }; }

  return { detect, connect, lists, settings, buildRequest, generate, fixAndRetry, gallery, record, libList, libScan, request, backendInfo, locks,
    img2img, inpaint, upscale, optionsGet, optionsSet, optionsSchema, upscalers, controlnetModels, controlnetModules, adetailerModels, styles, scripts, embeddings, extraFields,
    interrupt, skip, refresh, memory, objectInfo, queue, uploadImage, free, workflowsList, workflowGet, workflowSave, workflowDelete, runWorkflow, extras, features,
    progress: () => ip.progress(), cancel: () => ip.cancel(), status: () => Object.assign({ ok: true }, ip.status()),
    test: () => testRender() };
}

module.exports = { createSdStudio, sizeFor, PURPOSES };
