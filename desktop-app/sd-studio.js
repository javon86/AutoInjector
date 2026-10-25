'use strict';
/*
 * sd-studio.js — the 🎨 Images tab's brain, Electron-free so it is testable.
 * Glues image-provider (connect / generate / progress / cancel), sd-library
 * (models, LoRAs, collections, character locks) and sd-images (save with the
 * settings embedded) together, and implements the bridge contract Akọwe will
 * use to ask for a portrait or a cover with a character lock
 * (POST /image/request — see docs/SD_IMAGE_API.md).
 *
 * main.js passes: imageProvider, library, imagesDir(), recordImage(entry),
 * persist() (save settings), log(type, data), fileUrl(path).
 */
const sdImages = require('./sd-images');
const sdBackends = require('./sd-backends');

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
      checkpoint: r.checkpoint, vae: r.vae, batchSize: r.batchSize || r.count, batchCount: r.batchCount || 1, initImage: r.initImage, denoise: r.denoise,
    };
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
    const r = await ip.generate(b.prompt, b.opts);
    if (!r || !r.ok) {
      log('sd-generate', { ok: false, from, error: r && r.error });
      return Object.assign({ ok: false, warnings }, r || {}, { message: (r && r.message) || sdBackends.explain(r) });
    }
    if (r.missingLoras && r.missingLoras.length) warnings.push({ level: 'hard', name: r.missingLoras.join(', '), message: `ComfyUI doesn't have these LoRAs, so they were left out: ${r.missingLoras.join(', ')}` });
    const record = Object.assign({}, r.params, {
      backend: r.backend, label: r.label || ip.status().label, seeds: r.seeds, purpose: b.purpose, from: from || 'images-tab',
      characterLock: b.lock ? { id: b.lock.id, character: b.lock.character, book: b.lock.book } : undefined,
      book: req && req.book ? String(req.book).slice(0, 200) : undefined,
    });
    if (record.backend === 'a1111' && r.infoObj && r.infoObj.sd_model_name && !record.checkpoint) record.checkpoint = r.infoObj.sd_model_name;
    let saved;
    try { saved = sdImages.saveGeneration(imagesDir(), r.images, record, { prefix: b.purpose === 'free' ? 'sd' : b.purpose }); }
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

  return { detect, connect, lists, settings, buildRequest, generate, gallery, record, libList, libScan, request, backendInfo, locks,
    progress: () => ip.progress(), cancel: () => ip.cancel(), status: () => Object.assign({ ok: true }, ip.status()),
    test: async () => generate({ prompt: 'a red apple on a white table, studio photo, simple', width: 512, height: 512, steps: Math.min(ip.status().steps || 20, 20), batchSize: 1, seed: -1, purpose: 'test' }, 'images-tab:test') };
}

module.exports = { createSdStudio, sizeFor, PURPOSES };
