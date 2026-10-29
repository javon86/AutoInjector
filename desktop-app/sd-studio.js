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
 * Two image engines behind request(): Stable Diffusion (this file) and ChatGPT's
 * own image generation in its logged-in pane (chatgpt-image.js, passed in as
 * deps.chatgpt). engine "auto" = SD when an SD app is connected, else ChatGPT when
 * its pane is ready, else NO_IMAGE_ENGINE. Reference pictures for Akọwe's
 * Character Forge: purpose "view" (+ one of ten views) and "sheet" — the words
 * live in image-views.js.
 *
 * main.js passes: imageProvider, library, imagesDir(), recordImage(entry),
 * persist() (save settings), log(type, data), fileUrl(path), workflowsDir(),
 * chatgpt (the ChatGPT engine: generate(job) / status() / readiness()).
 */
const sdImages = require('./sd-images');
const sdBackends = require('./sd-backends');
const sdParams = require('./sd-params');
const control = require('./sd-control');
const sdWorkflows = require('./sd-workflows');
const sdErrors = require('./sd-errors');
const sdSanitize = require('./sd-sanitize');
const views = require('./image-views');
const fsMod = require('fs');
const pathMod = require('path');

const PURPOSES = ['portrait', 'cover', 'scene', 'illustration', 'map', 'test', 'free', 'view', 'sheet'];
const ENGINES = ['auto', 'sd', 'chatgpt'];

// Width × height for a purpose on a model family (multiples of 64).
function sizeFor(purpose, base) {
  if (purpose === 'view' || purpose === 'sheet') return views.sdSize(purpose, base);
  const big = ['SDXL', 'Pony', 'Illustrious', 'NoobAI', 'Flux', 'SD3'].includes(base);
  if (purpose === 'portrait' || purpose === 'cover') return big ? { width: 832, height: 1216 } : { width: 512, height: 768 };
  if (purpose === 'scene' || purpose === 'illustration') return big ? { width: 1216, height: 832 } : { width: 768, height: 512 };
  if (purpose === 'map') return big ? { width: 1344, height: 768 } : { width: 768, height: 448 };
  return big ? { width: 1024, height: 1024 } : { width: 512, height: 512 };
}
// A shape hint ({width, height} in any unit, e.g. a 6×9 in cover) → the purpose's pixel area in that shape, on a 64 grid.
function sizeForShape(purpose, base, shape) {
  const w0 = Number(shape && shape.width), h0 = Number(shape && shape.height);
  if (!(w0 > 0 && h0 > 0)) return null;
  const ref = sizeFor(purpose, base);
  const area = ref.width * ref.height;
  const r = Math.min(4, Math.max(0.25, w0 / h0));
  const snap = (v) => Math.max(256, Math.min(2048, Math.round(v / 64) * 64));
  return { width: snap(Math.sqrt(area * r)), height: snap(Math.sqrt(area / r)) };
}
// Map pictures: the words that make a picture a map (both engines), and what to keep out of it.
const MAP_WORDS = 'illustrated map seen from directly above, top-down cartography, clear coastlines, rivers, roads and landmarks, no text, no letters, no labels';
const MAP_NEGATIVE = 'text, letters, words, labels, watermark, signature, perspective view, people';

function createSdStudio(deps) {
  const ip = deps.imageProvider;
  const lib = deps.library;
  const log = deps.log || (() => {});
  const persist = deps.persist || (() => {});
  const fileUrl = deps.fileUrl || ((p) => p);
  const imagesDir = deps.imagesDir;
  const recordImage = deps.recordImage || (() => {});
  const wfStore = deps.workflowsDir ? sdWorkflows.createWorkflowStore({ dir: deps.workflowsDir() }) : null;
  const chatgpt = deps.chatgpt || null; // chatgpt-image.js engine (optional)
  let lastLists = null;
  let lastListsAt = 0;

  function withUrls(item) { return item && item.preview ? Object.assign({}, item, { previewUrl: fileUrl(item.preview) }) : item; }

  async function detect(opts) { const r = await sdBackends.detect(opts || {}); log('sd-detect', { found: r.found.map((f) => `${f.label}:${f.port}`), problems: r.problems.map((f) => `${f.kind}:${f.port}`) }); return r; }

  async function connect(url, opts) {
    const r = await ip.connect(url, opts || {});
    log('sd-connect', { ok: r.ok, kind: r.kind, port: r.port, label: r.label });
    if (r.ok) {
      persist();
      const l = await lists();
      r.lists = l.ok ? { checkpoints: l.checkpoints.length, loras: l.loras.length, samplers: l.samplers.length } : null;
      if (l.ok && l.current && l.current.checkpoint && l.checkpoints.length) r.model = l.current.checkpoint;
      // Connected, but no picture model: say so (PC test: "Connected ✓" while every picture failed).
      if (ip.status().noModels) {
        const h = modelHelp();
        Object.assign(r, { noModels: true, model: '', help: h, message: h.message, fix: h.fix });
        log('sd-no-models', { label: r.label, found: h.folders.length, files: h.files });
      }
    }
    r.status = ip.status();
    return r;
  }

  // ---- "Connected, but Forge has no picture model loaded": where the user's models are and how to point at them.
  // The library already scans Stability Matrix's shared Data/Models, AutoInjector's "stuff and thing"/models/image
  // and the user's folders — its checkpoints are grouped by folder (the folder to give Forge: --ckpt-dir).
  function modelFolders() {
    const by = new Map();
    let items = [];
    try { items = (lib && lib.list({ kind: 'checkpoint', limit: 5000 }).items) || []; } catch (_) { items = []; }
    for (const it of items) {
      if (!it || !it.file || it.onDisk === false) continue;
      const dir = it.folder || pathMod.dirname(it.file); // the scanned folder (Forge's --ckpt-dir looks in sub-folders too)
      const k = dir.toLowerCase();
      const cur = by.get(k) || { path: dir, count: 0, source: it.source || '', examples: [] };
      cur.count++;
      if (cur.examples.length < 3) cur.examples.push(pathMod.basename(it.file));
      by.set(k, cur);
    }
    if (!by.size && lib) { // not scanned yet: count the model files in the checkpoint folders (top level only, cheap)
      let folders = [];
      try { folders = lib.folders().filter((f) => f.exists && f.kind === 'checkpoint'); } catch (_) { folders = []; }
      for (const f of folders) {
        let names = [];
        try { names = fsMod.readdirSync(f.path).filter((n) => /\.(safetensors|ckpt|gguf)$/i.test(n)); } catch (_) { names = []; }
        if (names.length) by.set(f.path.toLowerCase(), { path: f.path, count: names.length, source: f.source || '', examples: names.slice(0, 3) });
      }
    }
    return [...by.values()].sort((a, b) => (b.count - a.count) || (/stability matrix/i.test(b.source) - /stability matrix/i.test(a.source)));
  }
  function modelHelp() {
    const st = ip.status();
    const label = st.label || (st.backend === 'comfy' ? 'ComfyUI' : 'Forge');
    const folders = modelFolders();
    const files = folders.reduce((n, f) => n + f.count, 0);
    const top = folders[0] || null;
    const canRestart = !!(top && typeof deps.canRestartWithModels === 'function' && (() => { try { return deps.canRestartWithModels(); } catch (_) { return false; } })());
    const message = `Connected, but ${label} has no picture model loaded — it can't make pictures yet.`;
    let fix;
    if (top) {
      const where = folders.length > 1 ? ` (and ${files - top.count} more in ${folders.length - 1} other folder${folders.length > 2 ? 's' : ''})` : '';
      fix = st.backend === 'comfy'
        ? `There ${top.count === 1 ? 'is 1 picture model' : `are ${top.count} picture models`} on this PC in ${top.path}${where}, but ComfyUI isn't using that folder. Put the files into ComfyUI's models/checkpoints folder (or add the folder to ComfyUI's extra_model_paths.yaml), restart ComfyUI and press Refresh.`
        : `There ${top.count === 1 ? 'is 1 picture model' : `are ${top.count} picture models`} on this PC in ${top.path}${where}, but ${label} isn't using that folder. Point ${label} at it: in Stability Matrix open ${label}'s ⚙ Launch Options and add  --ckpt-dir "${top.path}"  (or in Stability Matrix's Settings let the package use the shared model folders), relaunch ${label}, then press Refresh here.${canRestart ? ` Or press “↻ Restart ${label} with my models” and AutoInjector does it for you.` : ''}`;
    } else {
      fix = `No picture model files were found on this PC. Download one (🎨 Images → Setup → ⬇ starter model, SD 1.5 or SDXL), or put a .safetensors checkpoint into Stability Matrix's Data/Models/StableDiffusion folder (or the app's “stuff and thing”/models/image folder), then point ${label} at it and press Refresh.`;
    }
    const actions = canRestart && st.backend !== 'comfy' ? [{ id: 'restart-with-models', label: `↻ Restart ${label} with my models` }] : [];
    return { ok: true, noModels: !!st.noModels, label, backend: st.backend || '', folders, files, ckptDir: top ? top.path : '', launchArg: top ? `--ckpt-dir "${top.path}"` : '', canRestart, actions, message, fix };
  }
  /** Is a picture model loaded? Reads the connected app's Checkpoint list fresh. Used by 🧪 Test, 🩺 health and Check everything. */
  async function modelCheck() {
    const st = ip.status();
    if (!st.endpoint || st.enabled === false) return { ok: true, connected: false, noModels: false };
    let l = null;
    try { l = await lists(); } catch (_) { l = null; }
    const reachable = !!(l && l.ok);
    const none = reachable ? (l.checkpoints || []).length === 0 : !!ip.status().noModels;
    const out = { ok: true, connected: true, reachable, noModels: none, checkpoints: reachable ? l.checkpoints.length : null, label: st.label || '' };
    return none ? Object.assign(out, modelHelp(), { noModels: true }) : out;
  }

  async function lists() {
    const l = await ip.lists();
    if (l && l.ok) { lastLists = l; lastListsAt = Date.now(); try { lib && lib.mergeBackend(l); } catch (_) {} }
    return l;
  }

  // The live lists for "make it safe before sending" (sd-sanitize.js): the cached ones when
  // they belong to the connected backend, else fetched once. null = unknown → names are left alone.
  async function liveLists(fresh) {
    const st = ip.status();
    if (!st.endpoint) return null;
    if (fresh || !lastLists || lastLists.backend !== st.backend || Date.now() - lastListsAt > 10 * 60000) {
      try { await lists(); } catch (_) {}
    }
    return lastLists && lastLists.backend === st.backend ? lastLists : null;
  }
  function familyOf(ck) {
    const name = ck || ip.status().checkpoint || ip.status().model || (lastLists && lastLists.current && lastLists.current.checkpoint) || '';
    if (!name) return '';
    let fam = '';
    try { fam = lib ? lib.checkLoras([], name).checkpointBase || '' : ''; } catch (_) { fam = ''; }
    if (!fam && /sdxl|xl(?:[_\-\s.]|v?\d)|pony|illustrious|noob/i.test(String(name))) fam = 'SDXL';
    return fam;
  }
  // Names / numbers / model family checked against the connected app before anything is sent.
  async function makeSafe(opts) {
    const st = ip.status();
    const ctxFor = async (L) => {
      const ls = L ? { samplers: L.samplers, schedulers: L.schedulers, checkpoints: L.checkpoints, vaes: L.vaes, loras: L.loras, upscalers: L.upscalers } : {};
      if (opts.hires && opts.hires.upscaler && st.backend === 'a1111' && st.base) {
        try { const u = await control.upscalers(st.base); if (u && u.ok) ls.upscalers = u.all; } catch (_) {}
      }
      return { backend: st.backend, lists: ls, current: { sampler: st.sampler, scheduler: st.scheduler, checkpoint: st.checkpoint, vae: st.vae }, family: familyOf };
    };
    let L = await liveLists(false);
    let r = sdSanitize.sanitize(opts, await ctxFor(L));
    // a name we don't know may be a model added since the lists were read: read them again once
    if (r.unknown.some((f) => f !== 'hires.upscaler') && L && Date.now() - lastListsAt > 20000) { L = await liveLists(true); r = sdSanitize.sanitize(opts, await ctxFor(L)); }
    return r;
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
    const purpose = PURPOSES.includes(r.purpose) ? r.purpose : (views.isView(r.view) ? 'view' : 'free');
    // A reference view / a turnaround sheet: the framing words (after the lock's words) and a negative that keeps the body in frame.
    const view = purpose === 'view' && views.isView(r.view) ? r.view : undefined;
    if (purpose === 'view' || purpose === 'sheet') {
      const vp = views.sdPrompt({ prompt: [prompt, String(r.appearance || '').trim()].filter(Boolean).join(', '), purpose, view });
      prompt = vp.prompt;
      opts.negativePrompt = views.mergeNegative(opts.negativePrompt, vp.negative);
    }
    if (purpose === 'map') {
      prompt = [prompt, MAP_WORDS].filter(Boolean).join(', ');
      opts.negativePrompt = views.mergeNegative(opts.negativePrompt, MAP_NEGATIVE);
    }
    if (!opts.width || !opts.height) {
      const ck = opts.checkpoint || ip.status().checkpoint || ip.status().model;
      const base = lib ? lib.checkLoras([], ck).checkpointBase : '';
      const shaped = r.size ? sizeForShape(purpose, base, r.size) : null;
      if (shaped) Object.assign(opts, shaped);
      else if (purpose !== 'free' || !ip.status().width) Object.assign(opts, sizeFor(purpose, base));
    }
    for (const k of Object.keys(opts)) if (opts[k] === undefined || opts[k] === '') delete opts[k];
    if (opts.negativePrompt === undefined) opts.negativePrompt = '';
    return { prompt, opts, lock, purpose, view };
  }

  // Generate + save + record. from = 'images-tab' | 'bridge:akowe' | …
  // gopts: { noRetry } — fixAndRetry's own retry must not retry again.
  async function generate(req, from, gopts) {
    const b = buildRequest(req);
    if (b.error) return { ok: false, error: b.error, message: b.message };
    const warnings = [];
    // Make it safe before sending: real names, sane numbers, size vs model family (sd-sanitize.js).
    let safe = null;
    try { safe = await makeSafe(b.opts); } catch (_) { safe = null; }
    if (safe) { b.opts = safe.opts; warnings.push(...safe.warnings); }
    const corrected = safe && safe.fixes.length ? safe.fixes.map((f) => `${f.field}:${f.to === '' ? 'dropped' : 'fixed'}`).slice(0, 16) : undefined;
    const fixedNames = safe && safe.fixes.length ? safe.fixes.filter((f) => /^(sampler|scheduler|checkpoint|vae|lora|hires\.upscaler|refiner\.checkpoint|hires\.checkpoint)$/.test(f.field)).map((f) => `${f.field}: ${f.from} → ${f.to || '(dropped)'}`).slice(0, 12) : undefined;
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
    let r = await ip.generate(b.prompt, b.opts);
    let retried;
    // One safe retry (never more): unknown 500 → only the basics; OOM → smaller; a broken VAE → Automatic (not for the Images tab, which has its button).
    if ((!r || !r.ok) && !(gopts && gopts.noRetry)) {
      const st = ip.status();
      const plan = sdSanitize.retryPlan(r, b.opts, { interactive: !from || String(from).startsWith('images-tab'), family: safe ? safe.family : familyOf(b.opts.checkpoint), backend: st.backend, current: { sampler: st.sampler, scheduler: st.scheduler, checkpoint: st.checkpoint, vae: st.vae }, why: whyOf(r) });
      if (plan) {
        const r2 = await ip.generate(b.prompt, plan.opts);
        retried = { kind: plan.kind, after: r.code || r.error, ok: !!(r2 && r2.ok), code: r2 && !r2.ok ? (r2.code || r2.error) : undefined, left: plan.left };
        log('sd-generate', { retry: plan.kind, from, after: retried.after, ok: retried.ok, code: retried.code, left: plan.left, backend: r.backend });
        if (r2 && r2.ok) { r = r2; b.opts = plan.opts; warnings.push(plan.warning); }
        else warnings.push({ level: 'soft', kind: 'retry', message: `Tried once more (${plan.kind === 'basics' ? 'with only the basic settings' : plan.kind === 'smaller' ? 'at a smaller size' : 'with Automatic VAE'}) — that failed too${r2 && r2.code && r2.code !== retried.after ? ` (${r2.code})` : ''}.` });
      }
    }
    if (!r || !r.ok) {
      const out = Object.assign({ ok: false, warnings }, r || {}, { message: (r && r.message) || sdBackends.explain(r) });
      if (retried) out.retried = retried;
      // "Failed to find available model": in plain words, with where the user's models are and how to point at them
      if (out.code === 'NO_MODEL' || out.error === 'NO_CHECKPOINT') {
        const h = modelHelp();
        Object.assign(out, { code: 'NO_MODEL', message: sdErrors.NO_MODEL_MESSAGE({ label: h.label }), fix: h.fix, help: h, actions: h.actions });
      }
      if (out.code === 'VAE_LOAD_FAILED') await explainVae(out, vaeName, vaeInfo);
      // Log the cause, never the prompt (the log is shared with the user).
      // …plus the server's own first line (why) and the settings used, so a bare "HTTP 500" can be diagnosed from the log.
      const o = b.opts || {};
      const why = whyOf(out);
      const used = { w: o.width, h: o.height, steps: o.steps, cfg: o.cfgScale, sampler: o.sampler, scheduler: o.scheduler, checkpoint: o.checkpoint, loras: o.loras && o.loras.length ? o.loras.length : undefined, extra: o.extra && typeof o.extra === 'object' ? Object.keys(o.extra).slice(0, 12) : undefined, options: o.options && typeof o.options === 'object' ? Object.keys(o.options).slice(0, 12) : undefined };
      for (const k of Object.keys(used)) if (used[k] === undefined || used[k] === '') delete used[k];
      log('sd-generate', { ok: false, from, error: out.error, code: out.code || out.error, status: out.status, backend: out.backend, vae: vaeName || undefined, why, used: Object.keys(used).length ? used : undefined, corrected, names: fixedNames, retried: retried ? retried.kind : undefined });
      return out;
    }
    if (Array.isArray(r.warnings)) warnings.push(...r.warnings);
    if (r.missingLoras && r.missingLoras.length) warnings.push({ level: 'hard', name: r.missingLoras.join(', '), message: `ComfyUI doesn't have these LoRAs, so they were left out: ${r.missingLoras.join(', ')}` });
    const record = Object.assign({}, r.params, {
      backend: r.backend, label: r.label || ip.status().label, seeds: r.seeds, purpose: b.purpose, view: b.view, engine: 'sd', from: from || 'images-tab',
      characterLock: b.lock ? { id: b.lock.id, character: b.lock.character, book: b.lock.book } : undefined,
      book: req && req.book ? String(req.book).slice(0, 200) : undefined,
    });
    if (record.backend === 'a1111' && r.infoObj && r.infoObj.sd_model_name && !record.checkpoint) record.checkpoint = r.infoObj.sd_model_name;
    let saved;
    const prefix = b.view ? `view-${b.view}` : b.purpose !== 'free' ? b.purpose : b.opts.mask ? 'inpaint' : b.opts.initImage ? 'img2img' : 'sd';
    try { saved = sdImages.saveGeneration(imagesDir(), r.images, record, { prefix }); }
    catch (e) { return { ok: false, error: 'SAVE_FAILED', message: `The picture was made but couldn't be saved: ${e.message || e}` }; }
    for (const s of saved) { try { recordImage({ path: s.path, prompt: s.record.prompt, seed: s.record.seed, model: s.record.checkpoint || '', from: from || 'images-tab', sha256: s.sha256 }); } catch (_) {} }
    log('sd-generate', { ok: true, from, count: saved.length, backend: r.backend, lock: b.lock ? b.lock.character : null, corrected, names: fixedNames, retried: retried ? retried.kind : undefined });
    const out = {
      ok: true, engine: 'sd', backend: r.backend, seed: r.seed, warnings, settings: record,
      images: saved.map((s) => ({ path: s.path, url: fileUrl(s.path), json: s.json, seed: s.record.seed, sha256: s.sha256 })),
    };
    if (retried) out.retried = retried;
    if (req && req.returnImage) out.images.forEach((im, i) => { im.imageBase64 = r.images[i]; });
    return out;
  }
  // The server's own first line (no prompt): "KeyError: 'sd_xl_refiner'".
  function whyOf(r) { try { const t = sdErrors.serverText(r) || ''; return (t ? sdErrors.firstUsefulLine(t) : '').slice(0, 200) || undefined; } catch (_) { return undefined; } }

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
    const once = { noRetry: true }; // this IS the one retry
    const r = q.test ? await testRender({ vae: 'Automatic' }, once) : q.mask ? await inpaint(q, from || 'images-tab:fix', once) : q.initImage ? await img2img(q, from || 'images-tab:fix', once) : await generate(q, from || 'images-tab:fix', once);
    return Object.assign(r || { ok: false }, { fixed: fix, applied, retried: true });
  }

  // "🧪 Test: make a 512px image" (o: overrides, e.g. { vae: 'Automatic' } for the retry)
  function testRender(o, gopts) { return generate(Object.assign({ prompt: 'a red apple on a white table, studio photo, simple', width: 512, height: 512, steps: Math.min(ip.status().steps || 20, 20), batchSize: 1, seed: -1, purpose: 'test' }, o || {}), 'images-tab:test', gopts); }

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
  async function img2img(req, from, gopts) {
    if (!req || !req.initImage) return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', field: 'initImage', message: 'img2img needs a start picture (initImage).' };
    return generate(req, from || 'images-tab:img2img', gopts);
  }
  async function inpaint(req, from, gopts) {
    if (!req || !req.initImage) return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', field: 'initImage', message: 'Inpaint needs the picture to repaint (initImage).' };
    if (!req.mask) return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', field: 'mask', message: 'Inpaint needs a mask (white = repaint, black = keep).' };
    return generate(req, from || 'images-tab:inpaint', gopts);
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
  async function comfyLists() { const l = await ip.lists(); if (l && l.ok) { lastLists = l; lastListsAt = Date.now(); } return l; }

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

  // ---- the Akọwe contract (POST /image/request) — both engines
  function sdConnected() { const st = ip.status(); return !!(st.endpoint && st.enabled !== false); }
  function chatgptReadiness() {
    if (!chatgpt) return { ready: false, code: 'NOT_WIRED', why: 'this build has no ChatGPT image engine' };
    try {
      const r = typeof chatgpt.readiness === 'function' ? chatgpt.readiness() : chatgpt.status();
      return { ready: !!(r && r.ready), code: (r && r.code) || '', why: (r && r.why) || (r && r.ready ? '' : 'the ChatGPT pane is not ready') };
    } catch (e) { return { ready: false, code: 'ERROR', why: 'the ChatGPT pane could not be checked' }; }
  }
  const SD_ONLY = ['loras', 'steps', 'cfgScale', 'sampler', 'scheduler', 'checkpoint', 'vae', 'negativePrompt', 'seed', 'hires', 'refiner', 'controlnet', 'adetailer', 'initImage', 'mask'];
  // Check a request and pick the engine: { engine, purpose, view } | { error result }.
  function resolveEngine(b) {
    const engine = b.engine == null || b.engine === '' ? 'auto' : String(b.engine).toLowerCase();
    if (!ENGINES.includes(engine)) return { fail: { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', field: 'engine', message: `There is no image engine called “${b.engine}”.`, hint: 'engine is "auto" (default), "sd" or "chatgpt".' } };
    let purpose = b.purpose == null || b.purpose === '' ? (b.view ? 'view' : 'free') : String(b.purpose);
    if (!PURPOSES.includes(purpose)) return { fail: { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', field: 'purpose', message: `“${b.purpose}” is not a purpose.`, hint: `purpose is one of: ${PURPOSES.filter((p) => p !== 'test').join(', ')}.` } };
    if (purpose === 'view' && !views.isView(b.view)) return { fail: { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', field: 'view', message: b.view ? `“${b.view}” is not a reference view.` : 'purpose "view" needs a view.', hint: `view is one of: ${views.VIEW_IDS.join(', ')}.` } };
    if (!b.prompt && !b.characterLock && !b.character && !b.appearance) return { fail: { ok: false, error: 'NEED_PROMPT', message: 'Send a prompt (what to draw) and/or a characterLock.' } };
    const sdOn = sdConnected();
    const sdWhy = 'no Stable Diffusion app is connected';
    if (engine === 'sd') {
      if (!sdOn) return { fail: { ok: false, engine: 'sd', error: 'SD_NOT_CONNECTED', code: 'SD_NOT_CONNECTED', message: `No Stable Diffusion app is connected. ${sdBackends.explain('NO_ENDPOINT')}`, hint: 'Start Forge / A1111 / ComfyUI (🎨 Images → ▶ Start or 🔍 Find my SD app), or ask with engine "chatgpt" or "auto".' } };
      return { engine: 'sd', purpose };
    }
    const cg = chatgptReadiness();
    if (engine === 'chatgpt') {
      if (!cg.ready) return { fail: { ok: false, engine: 'chatgpt', error: 'CHATGPT_NOT_READY', code: 'CHATGPT_NOT_READY', message: `ChatGPT can't make pictures right now: ${cg.why}.`, hint: 'Open AutoInjector, make sure the ChatGPT pane is logged in and shows its message box, then try again (or use engine "sd").' } };
      return { engine: 'chatgpt', purpose };
    }
    // auto: an SD app with no picture model can't draw — ChatGPT does it when it can
    if (sdOn && !ip.status().noModels) return { engine: 'sd', purpose };
    if (cg.ready) return { engine: 'chatgpt', purpose };
    if (sdOn) return { engine: 'sd', purpose };
    return { fail: { ok: false, error: 'NO_IMAGE_ENGINE', code: 'NO_IMAGE_ENGINE', message: `No image engine is available: ${sdWhy}, and ChatGPT can't be used (${cg.why}).`, hint: 'Start a Stable Diffusion app (🎨 Images → ▶ Start), or open AutoInjector with ChatGPT logged in.' } };
  }
  // The contract's answer: today's shape + engine, view echoed, paths.
  function contractShape(r, engine, purpose, view, withUrl) {
    const images = (r.images || []).map((im) => { const o = { path: im.path, seed: im.seed, sha256: im.sha256 }; if (im.width) { o.width = im.width; o.height = im.height; } if (withUrl && im.url) o.url = im.url; if (im.imageBase64) o.imageBase64 = im.imageBase64; if (im.upscaled) { o.upscaled = im.upscaled; o.original = im.original; } return o; });
    const out = { ok: true, engine, purpose: (r.settings && r.settings.purpose) || purpose, backend: r.backend || engine, seed: r.seed == null ? null : r.seed, warnings: r.warnings || [], settings: r.settings, paths: images.map((im) => im.path), images };
    if (view) out.view = view;
    return out;
  }
  async function viaChatgpt(b, purpose, from) {
    let lock = null;
    const lockKey = b.characterLock || b.lockId || b.character;
    if (lockKey && lib) {
      lock = lib.getLock(lockKey);
      if (!lock && (b.characterLock || b.lockId)) return { ok: false, engine: 'chatgpt', error: 'NO_LOCK', message: `There's no character lock called “${lockKey}”. Make one in 🎨 Images → Library → Character locks.` };
    }
    const subject = views.describeSubject({ character: lock ? lock.character : (b.character || ''), looks: lock ? lock.prompt : '', appearance: b.appearance, prompt: b.prompt });
    const view = purpose === 'view' ? b.view : undefined;
    const text = views.chatgptPrompt({ subject, purpose, view });
    const warnings = [];
    if (Number(b.count) > 1) warnings.push({ level: 'soft', kind: 'engine', message: 'ChatGPT makes one picture per request — ask again for more.' });
    const ignored = SD_ONLY.filter((k) => b[k] !== undefined && b[k] !== null && b[k] !== '' && !(Array.isArray(b[k]) && !b[k].length) && !(k === 'seed' && Number(b[k]) === -1));
    if (ignored.length) warnings.push({ level: 'soft', kind: 'engine', message: `ChatGPT doesn't use these Stable Diffusion settings: ${ignored.join(', ')}.` });
    const series = b.series ? String(b.series).slice(0, 120) : purpose === 'view' ? `view:${lock ? lock.id : subject.slice(0, 80)}` : undefined;
    const record = {
      prompt: String(b.prompt || '').trim() || subject, appearance: b.appearance ? String(b.appearance).slice(0, 2000) : undefined,
      characterLock: lock ? { id: lock.id, character: lock.character, book: lock.book } : undefined,
      book: b.book ? String(b.book).slice(0, 200) : undefined, from,
    };
    log('chatgpt-image-request', { from, purpose, view, lock: lock ? lock.character : null });
    let r;
    try { r = await chatgpt.generate({ text, purpose, view, series, newChat: !!b.newChat, timeoutMs: b.timeoutMs, returnImage: !!b.returnImage, from, record }); }
    catch (e) { r = { ok: false, engine: 'chatgpt', error: 'INTERNAL', message: `Something went wrong: ${(e && e.message) || e}` }; }
    if (!r || !r.ok) return Object.assign({ ok: false, engine: 'chatgpt' }, r || {}, { warnings });
    return Object.assign(r, { warnings: (r.warnings || []).concat(warnings) });
  }
  // One request from any caller (the bridge, the Images tab, Alfred): from = 'bridge:akowe' | 'images-tab' | 'api:alfred' …
  async function requestFrom(body, from) {
    const b = Object.assign({}, body || {});
    // upscale: 2 | 4 after the picture is made (Stable Diffusion Extras); size: a shape hint {width, height}.
    let up = null;
    if (b.upscale != null && b.upscale !== false && b.upscale !== 1) {
      up = Number(b.upscale);
      if (![2, 4].includes(up)) return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', field: 'upscale', message: `upscale must be 2 or 4 (got “${b.upscale}”).`, hint: 'Leave it out for no upscaling.' };
    }
    delete b.upscale;
    if (b.size != null && !(b.size && Number(b.size.width) > 0 && Number(b.size.height) > 0)) return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', field: 'size', message: 'size must be {width, height} with two positive numbers (any unit — only the shape counts).' };
    const pick = resolveEngine(b);
    if (pick.fail) { log('image-request', { from, ok: false, error: pick.fail.error, engine: b.engine || 'auto' }); return pick.fail; }
    const view = pick.purpose === 'view' ? b.view : undefined;
    if (pick.engine === 'chatgpt') {
      if (pick.purpose === 'map') b.prompt = [String(b.prompt || '').trim(), MAP_WORDS].filter(Boolean).join(', ');
      if (b.size) { const ratio = Number(b.size.width) / Number(b.size.height); b.prompt = `${String(b.prompt || '').trim()}${b.prompt ? ', ' : ''}${ratio < 0.9 ? 'tall (portrait) format' : ratio > 1.1 ? 'wide (landscape) format' : 'square format'}`; }
      const r = await viaChatgpt(b, pick.purpose, from);
      if (r.ok && up) await upscaleAll(r, up, from);
      return r.ok ? contractShape(r, 'chatgpt', pick.purpose, view, !String(from).startsWith('bridge:')) : r;
    }
    const st = ip.status();
    if (!st.endpoint) return { ok: false, engine: 'sd', error: 'SD_NOT_CONNECTED', code: 'SD_NOT_CONNECTED', message: `No Stable Diffusion app is connected. ${sdBackends.explain('NO_ENDPOINT')}`, hint: 'Start Forge / A1111 / ComfyUI, or ask with engine "chatgpt".' };
    for (const k of ['engine', 'series', 'newChat', 'timeoutMs']) delete b[k];
    const r = await generate(Object.assign(b, { purpose: pick.purpose, batchSize: Math.max(1, Math.min(4, Number(b.count) || 1)) }), from);
    if (!r.ok) return Object.assign({ engine: 'sd' }, r);
    if (up) await upscaleAll(r, up, from);
    return contractShape(r, 'sd', pick.purpose, view, !String(from).startsWith('bridge:'));
  }
  // Upscale every picture of a result in place (the bigger file replaces the entry; the original stays on disk).
  // Needs a connected Stable Diffusion app (Extras / an upscale model); otherwise a soft warning, never a failure.
  async function upscaleAll(r, factor, from) {
    r.warnings = r.warnings || [];
    if (!ip.status().endpoint) { r.warnings.push({ level: 'soft', kind: 'upscale', message: `Not upscaled ×${factor}: upscaling needs a connected Stable Diffusion app.` }); return; }
    for (const im of r.images || []) {
      if (!im || !im.path) continue;
      let u;
      try { u = await upscale({ image: im.path, factor }, from); } catch (e) { u = { ok: false, message: String((e && e.message) || e) }; }
      const out = u && u.ok && u.images && u.images[0];
      if (!out || !out.path) { r.warnings.push({ level: 'soft', kind: 'upscale', message: `Not upscaled: ${(u && u.message) || 'the upscale failed'}.` }); continue; }
      const keepB64 = im.imageBase64 !== undefined;
      Object.assign(im, { path: out.path, url: out.url, sha256: out.sha256, width: out.width || im.width, height: out.height || im.height, upscaled: factor, original: im.path });
      if (keepB64) { try { im.imageBase64 = require('fs').readFileSync(out.path).toString('base64'); } catch (_) {} }
    }
  }
  function request(body) { return requestFrom(body, `bridge:${String((body && body.from) || 'akowe').slice(0, 40)}`); }
  function chatgptStatus() {
    if (!chatgpt) return { ok: true, engine: 'chatgpt', ready: false, why: 'this build has no ChatGPT image engine', busy: false };
    try { return Object.assign({ ok: true }, chatgpt.status()); } catch (e) { return { ok: false, error: 'INTERNAL', message: String((e && e.message) || e) }; }
  }
  function chatgptSettings(patch) {
    if (!chatgpt || typeof chatgpt.settings !== 'function') return { ok: false, error: 'NOT_WIRED', code: 'NOT_WIRED', message: 'This build has no ChatGPT image engine.' };
    const r = chatgpt.settings(patch || {});
    try { if (deps.persistChatgpt) deps.persistChatgpt({ freshChatPerSeries: !!r.freshChatPerSeries }); } catch (_) {}
    log('chatgpt-image-settings', { freshChatPerSeries: !!r.freshChatPerSeries });
    return Object.assign({ ok: true }, r);
  }
  function chatgptCancel() {
    if (!chatgpt || typeof chatgpt.cancel !== 'function') return { ok: true, cancelled: false };
    return chatgpt.cancel();
  }
  function backendInfo() {
    const s = ip.status();
    const cg = chatgptReadiness();
    let cgs = {};
    try { cgs = chatgpt && typeof chatgpt.status === 'function' ? chatgpt.status() || {} : {}; } catch (_) { cgs = {}; }
    const sd = { connected: !!(s.enabled && s.endpoint), backend: s.backend, label: s.label, base: s.base, checkpoint: s.checkpoint || s.model, busy: !!s.busy };
    if (s.noModels) { const h = modelHelp(); Object.assign(sd, { noModels: true, problem: h.message, fix: h.fix }); }
    const cgOut = { ready: cg.ready, busy: !!cgs.busy };
    if (!cg.ready) cgOut.why = cg.why;
    return Object.assign({ ok: true }, sd, { engines: { sd, chatgpt: cgOut } });
  }
  function locks() { return lib ? lib.listLocks() : { ok: true, locks: [] }; }

  return { detect, connect, lists, settings, buildRequest, generate, fixAndRetry, gallery, record, libList, libScan, request, requestFrom, chatgptStatus, chatgptSettings, chatgptCancel, backendInfo, locks,
    img2img, inpaint, upscale, optionsGet, optionsSet, optionsSchema, upscalers, controlnetModels, controlnetModules, adetailerModels, styles, scripts, embeddings, extraFields,
    interrupt, skip, refresh, memory, objectInfo, queue, uploadImage, free, workflowsList, workflowGet, workflowSave, workflowDelete, runWorkflow, extras, features,
    progress: () => ip.progress(), cancel: () => ip.cancel(), status: () => Object.assign({ ok: true }, ip.status()),
    test: () => testRender(), modelHelp, modelCheck };
}

module.exports = { createSdStudio, sizeFor, sizeForShape, PURPOSES, ENGINES, MAP_WORDS };
