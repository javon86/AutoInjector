'use strict';
/*
 * sd-record.js — everything that is saved with a picture, in one place. Shared by the main process
 * (require: sd-studio.js, sd-recipes.js, image-judge.js) and the 🎨 Images tab (a <script> tag → window.sdRecord).
 * No Electron, no DOM, no fs: plain functions, unit-tested in test/images-judge.test.js.
 *
 * Every picture's sidecar (<name>.json, also inside the PNG as the "autoinjector" text chunk) holds:
 *   promptTyped        what the person (or Alfred / Akọwe) typed, before style words / shortening
 *   prompt             what was actually sent to the SD app (shortened + style words; <lora:…> tags are in `loras`)
 *   fullPrompt         the full description when the sent prompt was shortened
 *   negativePrompt     the negative prompt that was sent; negativeAuto = true when it was the automatic default
 *   style              the style chip (photo / cinematic / …)
 *   checkpoint, checkpointHash, family, vae, sampler, scheduler, steps, cfgScale, seed (the real one), width, height
 *   index              which picture of the batch (0 = first)
 *   hires {upscaler, scale, denoise, secondPassSteps}, refiner {checkpoint, switchAt}
 *   loras [{name, weight, hash?}], triggers [the trigger words that were added to the prompt]
 *   adetailer [...], controlnet [...] (pictures as "[image]"), initImage "[image]" + source (a file path) + denoise, mask
 *   clipSkip, engine ('sd' | 'chatgpt'), backend ('a1111' | 'comfy' | 'chatgpt'), label (Forge / ComfyUI …),
 *   workflowName (ComfyUI: a saved workflow, else "built-in graph"), appVersion
 *   askedBy {who: 'you' | 'Alfred' | 'Akọwe' | …, from, book?, character?}
 *   recipe {id, name} when a saved recipe was used
 *   judge {...} the latest AI judge verdict (image-judge.js) and judges [...] the earlier ones
 *
 *   enrich(rec, ctx)        → the record with the fields above filled in where they can be known
 *   askedByOf(from, rec)    → {who, from, book?, character?}
 *   settingsUsed(rec)       → [{ label, value }] in plain words (the "Settings used" panel)
 *   remakeRequest(rec)      → { engine, request, note } — the exact request that makes the same picture again
 *   SETTING_KEYS            → the generation settings a recipe can hold (no prompt text)
 */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.sdRecord = m;
})(typeof self !== 'undefined' ? self : this, function () {
  // The settings that change how a picture looks, apart from the prompt text itself.
  const SETTING_KEYS = ['checkpoint', 'vae', 'sampler', 'scheduler', 'steps', 'cfgScale', 'width', 'height', 'clipSkip', 'style',
    'negativePrompt', 'loras', 'hires', 'refiner', 'adetailer', 'restoreFaces', 'tiling', 'styles', 'variation', 'overrideSettings', 'extra'];
  const IMG = '[image]';

  function hashOfName(name) {
    const m = String(name || '').match(/\[([0-9a-f]{8,12})\]\s*$/i);
    return m ? m[1].toLowerCase() : '';
  }
  function cleanName(name) { return String(name || '').replace(/\s*\[[0-9a-f]{6,}\]\s*$/i, '').trim(); }
  function shortPath(p) { const s = String(p || ''); return s.length < 1024 && /\.(png|jpe?g|webp)$/i.test(s) && !/^data:/i.test(s) ? s : ''; }

  // "Lora hashes: \"odile_face: 1a2b3c4d5e6f, ink: …\"" (A1111 / Forge's infotext) → { name: hash }
  function parseLoraHashes(v) {
    const out = {};
    const s = String(v || '').replace(/^"|"$/g, '');
    for (const part of s.split(',')) { const m = part.match(/^\s*([^:]+):\s*([0-9a-f]{6,})\s*$/i); if (m) out[m[1].trim().toLowerCase()] = m[2].toLowerCase(); }
    return out;
  }

  function askedByOf(from, rec) {
    const f = String(from || 'images-tab');
    const r = rec || {};
    let who = 'you';
    if (/^api:alfred|^alfred/i.test(f)) who = 'Alfred';
    else if (/^bridge:/i.test(f) || r.book) who = /akowe|bookforge/i.test(f) || r.book ? 'Akọwe' : f.replace(/^bridge:/, '');
    else if (/^api:/i.test(f)) who = f.replace(/^api:/, '');
    else if (/judge|improve|best/i.test(f)) who = 'Make it better';
    const out = { who, from: f.slice(0, 60) };
    if (r.book) out.book = String(r.book).slice(0, 200);
    const lock = r.characterLock;
    if (lock && (lock.character || lock.id)) out.character = String(lock.character || lock.id).slice(0, 120);
    else if (r.character) out.character = String(r.character).slice(0, 120);
    return out;
  }

  /**
   * ctx: { from, promptTyped, negativeAuto, triggers, appVersion, infoObj (A1111 info), library: { loraHash(name) },
   *        workflowName, source, recipe }
   */
  function enrich(rec, ctx) {
    const r = Object.assign({}, rec || {});
    const c = ctx || {};
    if (c.promptTyped != null && String(c.promptTyped).trim() && r.promptTyped == null) r.promptTyped = String(c.promptTyped).slice(0, 20000);
    if (r.promptTyped == null) r.promptTyped = r.fullPrompt || r.prompt || '';
    if (c.negativeAuto) r.negativeAuto = true;
    if (Array.isArray(c.triggers) && c.triggers.length) r.triggers = c.triggers.slice(0, 40).map((t) => String(t).slice(0, 120));
    const info = c.infoObj && typeof c.infoObj === 'object' ? c.infoObj : {};
    if (!r.checkpoint && info.sd_model_name) r.checkpoint = info.sd_model_name;
    if (!r.checkpointHash) r.checkpointHash = info.sd_model_hash || hashOfName(r.checkpoint) || undefined;
    if (!r.sampler && info.sampler_name) r.samplerUsed = info.sampler_name;
    if (!r.scheduler && info.extra_generation_params && info.extra_generation_params['Schedule type']) r.schedulerUsed = info.extra_generation_params['Schedule type'];
    if ((!r.vae || /^automatic$/i.test(r.vae)) && info.sd_vae_name) r.vaeUsed = info.sd_vae_name;
    if (info.clip_skip && !r.clipSkip && Number(info.clip_skip) > 1) r.clipSkip = Number(info.clip_skip);
    const hashes = parseLoraHashes(info.extra_generation_params && info.extra_generation_params['Lora hashes']);
    if (Array.isArray(r.loras)) {
      r.loras = r.loras.map((l) => {
        const o = Object.assign({}, l);
        const key = String(o.name || '').toLowerCase();
        if (!o.hash && hashes[key]) o.hash = hashes[key];
        if (!o.hash && c.library && typeof c.library.loraHash === 'function') { try { const h = c.library.loraHash(o.name); if (h) o.hash = h; } catch (_) {} }
        return o;
      });
    }
    if (c.source && !r.source) { const s = shortPath(c.source); if (s) r.source = s; }
    if (!r.engine) r.engine = r.backend === 'chatgpt' ? 'chatgpt' : 'sd';
    if (r.backend === 'comfy' && !r.workflowName) r.workflowName = c.workflowName || 'built-in graph (AutoInjector)';
    if (c.workflowName && !r.workflowName) r.workflowName = c.workflowName;
    if (c.appVersion && !r.appVersion) r.appVersion = String(c.appVersion).slice(0, 40);
    r.askedBy = r.askedBy || askedByOf(c.from || r.from, r);
    if (c.recipe && c.recipe.id) r.recipe = { id: String(c.recipe.id), name: String(c.recipe.name || c.recipe.id).slice(0, 120) };
    for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k];
    return r;
  }

  const ENGINE_WORDS = { a1111: 'Forge / Automatic1111', comfy: 'ComfyUI', chatgpt: 'ChatGPT (its own pictures, in its pane)' };
  const STYLE_WORDS = { photo: 'Photo-real', cinematic: 'Cinematic', illustration: 'Illustration', anime: 'Anime', painting: 'Painting' };
  function num(v) { return v == null || v === '' ? '' : String(v); }

  /** The "Settings used" panel: every setting in plain words. Empty values are left out. */
  function settingsUsed(rec) {
    const r = rec || {};
    const out = [];
    const add = (label, value) => { if (value != null && String(value).trim() !== '') out.push({ label, value: String(value) }); };
    const typed = r.promptTyped || r.fullPrompt || r.prompt || '';
    add('What you asked for', typed);
    if (r.prompt && r.prompt !== typed) add('What was sent to the picture maker', r.prompt);
    if (r.fullPrompt && r.fullPrompt !== typed) add('The full description (kept, not sent)', r.fullPrompt);
    add('Things to avoid (negative prompt)', r.negativePrompt ? `${r.negativePrompt}${r.negativeAuto ? '  (the automatic default)' : ''}` : '');
    add('Style', STYLE_WORDS[r.style] || r.style || '');
    add('Made by', r.engine === 'chatgpt' || r.backend === 'chatgpt' ? ENGINE_WORDS.chatgpt : `${r.label || ENGINE_WORDS[r.backend] || r.backend || 'Stable Diffusion'}${r.workflowName ? ` — workflow: ${r.workflowName}` : ''}`);
    add('Model (checkpoint)', r.checkpoint ? `${cleanName(r.checkpoint)}${r.family ? ` (${r.family})` : ''}${r.checkpointHash ? ` · hash ${r.checkpointHash}` : ''}` : (r.engine === 'chatgpt' ? '' : 'whatever was loaded'));
    add('VAE (colour decoder)', r.vae && !/^automatic$/i.test(r.vae) ? r.vae : (r.vaeUsed ? `${r.vaeUsed} (automatic)` : (r.engine === 'chatgpt' ? '' : 'automatic')));
    add('Sampler', r.sampler || r.samplerUsed ? `${r.sampler || r.samplerUsed}${r.scheduler || r.schedulerUsed ? ` · ${r.scheduler || r.schedulerUsed}` : ''}` : '');
    add('Steps', num(r.steps));
    add('CFG (how strictly it follows the words)', num(r.cfgScale));
    add('Seed (the number that makes this exact picture)', r.seed != null && Number(r.seed) >= 0 ? `${r.seed}${r.index ? ` (picture ${Number(r.index) + 1} of the batch)` : ''}` : (r.engine === 'chatgpt' ? 'none — ChatGPT has no seed' : ''));
    add('Size', r.width && r.height ? `${r.width} × ${r.height}` : '');
    if (r.hires) add('Hires fix (make bigger, add detail)', `×${r.hires.scale || 2}, ${r.hires.upscaler || 'Latent'}, denoise ${r.hires.denoise != null ? r.hires.denoise : 0.5}${r.hires.secondPassSteps ? `, ${r.hires.secondPassSteps} steps` : ''}`);
    if (r.refiner && r.refiner.checkpoint) add('Refiner', `${cleanName(r.refiner.checkpoint)} from ${Math.round((r.refiner.switchAt != null ? r.refiner.switchAt : 0.8) * 100)}%`);
    if (Array.isArray(r.loras) && r.loras.length) add('LoRAs (add-on styles / faces)', r.loras.map((l) => `${l.name} at ${l.weight}${l.hash ? ` (hash ${String(l.hash).slice(0, 10)})` : ''}`).join(', '));
    if (Array.isArray(r.triggers) && r.triggers.length) add('Trigger words added', r.triggers.join(', '));
    if (Array.isArray(r.adetailer) && r.adetailer.length) add('ADetailer (fix faces / hands)', r.adetailer.map((u) => `${u.model || 'face'}${u.denoise != null ? ` denoise ${u.denoise}` : ''}`).join(', '));
    if (Array.isArray(r.controlnet) && r.controlnet.length) add('ControlNet', r.controlnet.map((u) => `${u.module || 'none'} → ${u.model || '?'} weight ${u.weight != null ? u.weight : 1}`).join('; '));
    if (r.initImage || r.source) add(r.mask ? 'Repainted part of a picture (inpaint)' : 'Changed from a picture (img2img)', `${r.source || 'a picture'}${r.denoise != null ? `, change ${r.denoise}` : ''}`);
    if (r.clipSkip > 1) add('CLIP skip', num(r.clipSkip));
    if (r.restoreFaces) add('Restore faces', 'on');
    if (r.kind === 'upscale') add('Upscaled', `×${r.factor || 2} ${r.upscaler || ''}`.trim());
    if (r.recipe) add('Recipe', r.recipe.name || r.recipe.id);
    if (r.characterLock && r.characterLock.character) add('Character lock', r.characterLock.character);
    const a = r.askedBy || askedByOf(r.from, r);
    add('Asked by', `${a.who}${a.book ? ` — book “${a.book}”` : ''}${a.character ? ` — ${a.character}` : ''}`);
    if (r.judge) add('AI judge', `${r.judge.verdict || '?'} · ${r.judge.overall != null ? `${r.judge.overall}/10` : ''} · by ${r.judge.byLabel || r.judge.by || '?'}`);
    if (r.improve && r.improve.round) add('Make it better', `round ${r.improve.round}${r.improve.changed && r.improve.changed.length ? ` — changed: ${r.improve.changed.join('; ')}` : ''}`);
    add('Made on', r.createdAt ? String(r.createdAt).replace('T', ' ').slice(0, 19) : '');
    add('App version', r.appVersion || '');
    return out;
  }

  const DROP = new Set(['seeds', 'index', 'createdAt', 'app', 'file', 'sha256', 'json', 'askedBy', 'judge', 'judges', 'improve', 'quality', 'family', 'label',
    'promptTyped', 'fullPrompt', 'negativeAuto', 'triggers', 'checkpointHash', 'samplerUsed', 'schedulerUsed', 'vaeUsed', 'appVersion', 'recipe', 'bookCheckpoint',
    'characterLock', 'style', 'backend', 'engine', 'workflowName', 'from', 'purpose', 'view', 'source', 'book', 'infotext', 'kind', 'chatgptPrompt', 'seconds']);

  /** The exact request that makes the same picture again (same prompt as sent, same seed, every setting, no automatic changes). */
  function remakeRequest(rec) {
    const r = rec || {};
    if (r.engine === 'chatgpt' || r.backend === 'chatgpt') {
      return { engine: 'chatgpt', request: { engine: 'chatgpt', prompt: r.promptTyped || r.prompt || '' }, note: 'ChatGPT has no seed, so it draws a new picture from the same words.' };
    }
    if (r.kind === 'workflow') return { engine: 'workflow', request: { name: r.workflowName, params: Object.assign({}, r.params || {}, r.seed != null ? { seed: r.seed } : {}) }, note: '' };
    if (r.kind === 'upscale') return { engine: 'upscale', request: { image: r.source, factor: r.factor, upscaler: r.upscaler }, note: '' };
    const q = {};
    for (const [k, v] of Object.entries(r)) { if (DROP.has(k) || v === undefined || v === null) continue; q[k] = v; }
    if (r.initImage === IMG || q.initImage === IMG) { delete q.initImage; if (r.source) q.initImage = r.source; }
    if (q.mask === IMG) delete q.mask; // the brushed mask is not kept as a file
    if (Array.isArray(q.controlnet)) q.controlnet = q.controlnet.filter((u) => u && u.image !== IMG);
    if (Array.isArray(q.controlnet) && !q.controlnet.length) delete q.controlnet;
    q.seed = r.seed != null ? Number(r.seed) : -1;
    q.batchSize = 1; q.batchCount = 1;
    q.quality = false; // the prompt / negative / size already hold what the automatic defaults added
    delete q.count;
    let note = '';
    if (r.mask && !q.mask) note = 'The brushed mask was not kept, so this repaints the whole picture.';
    return { engine: 'sd', request: q, note };
  }

  return { SETTING_KEYS, enrich, askedByOf, settingsUsed, remakeRequest, parseLoraHashes, hashOfName, cleanName };
});
