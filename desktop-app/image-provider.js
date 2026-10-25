'use strict';
// image-provider.js — the butler's image-generation capability. Like the manager
// and Open Interpreter, the image model is NOT bundled (it needs a GPU): it's a
// local Stable Diffusion app the user runs (Forge / A1111 / reForge / SD.Next /
// ComfyUI — e.g. launched from Stability Matrix). The wire details live in
// sd-backends.js; this module owns the settings, the "which backend" choice,
// the current job (progress / cancel) and the plain-English errors.
//
// Settings keep the old shape (endpoint = the full A1111 txt2img URL) so saved
// configs keep working. New: backend ('a1111' | 'comfy' | '' = work it out from
// the address), checkpoint, vae, sampler, scheduler, batchSize.
//
// generate(prompt, opts) → { ok, imageBase64, images[], info, seed, backend, params }
// opts may override any setting for one call (steps, width, height, cfgScale,
// seed, sampler, scheduler, checkpoint, vae, batchSize, batchCount) and add
// loras: [{ name, weight }] plus every advanced setting of sd-params.js
// (hires, refiner, initImage/denoise/mask/inpaint, controlnet, adetailer,
// clipSkip, restoreFaces, tiling, styles, variation, script, alwaysonScripts,
// overrideSettings, extra) — checked against the server before sending.
// Also: upscale(o) (A1111 Extras / ComfyUI upscale model) and runWorkflow()
// (any ComfyUI API-format workflow with named parameters).
// The caller (main.js) saves the PNGs and records them — this module stays pure.
const fs = require('fs');
const { URL } = require('url');
const sd = require('./sd-backends');
const sdParams = require('./sd-params');
const control = require('./sd-control');
const workflows = require('./sd-workflows');

let settings = {
  enabled: false,
  endpoint: '',    // e.g. http://127.0.0.1:7860/sdapi/v1/txt2img  (A1111/Forge) or http://127.0.0.1:8188 (ComfyUI)
  backend: '',     // 'a1111' | 'comfy' | '' (inferred from the address)
  label: '',       // what Connect found: "Forge", "ComfyUI", …
  model: '',       // the checkpoint the server reported / the user picked (informational)
  checkpoint: '',  // checkpoint to use ('' = whatever the server has loaded / ComfyUI's first)
  vae: '',
  sampler: '',
  scheduler: '',
  steps: 20,       // slider: sampling steps
  cfgScale: 7,     // slider: CFG scale (prompt adherence)
  width: 512,      // slider
  height: 512,     // slider
  batchCount: 1,   // slider: how many images per Generate (n_iter)
  batchSize: 1,    // images per pass (batch_size)
  seed: -1,        // -1 = random each time
  timeoutMs: 180000,
};

// E07: a saved endpoint of a bare host (http://127.0.0.1:7860) returns 405 —
// A1111 needs the full txt2img path. Normalize the common shapes so a reachable
// host that isn't the generate URL becomes one. ComfyUI addresses (backend
// 'comfy', or a /prompt path) are left alone.
function _normalizeEndpoint(raw, backend) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch { return s; } // not a URL — hand it back untouched
  if (backend === 'comfy') return `${u.protocol}//${u.host}`;
  const path = u.pathname.replace(/\/+$/, '');
  if (path === '' || path === '/api/v1' || path === '/sdapi/v1') {
    u.pathname = '/sdapi/v1/txt2img';
    return u.toString();
  }
  return s;
}

// Which family is the configured address?
function backendOf(s = settings) {
  if (s.backend === 'a1111' || s.backend === 'comfy') return s.backend;
  try { const u = new URL(s.endpoint); if (/\/prompt\/?$/.test(u.pathname) || u.port === '8188') return 'comfy'; } catch {}
  return 'a1111';
}
function baseUrl() { return sd.baseOf(settings.endpoint); }

function getSettings() { return { ...settings }; }
function setSettings(patch) {
  if (!patch || typeof patch !== 'object') return getSettings();
  if ('enabled' in patch) settings.enabled = !!patch.enabled;
  if ('backend' in patch) settings.backend = patch.backend === 'comfy' || patch.backend === 'a1111' ? patch.backend : '';
  if ('endpoint' in patch) settings.endpoint = _normalizeEndpoint(patch.endpoint, settings.backend);
  for (const k of ['model', 'label', 'checkpoint', 'vae', 'sampler', 'scheduler']) if (k in patch) settings[k] = String(patch[k] == null ? '' : patch[k]);
  for (const k of ['steps', 'width', 'height', 'batchCount', 'batchSize']) {
    if (k in patch) { const n = Number(patch[k]); if (Number.isFinite(n) && n > 0) settings[k] = Math.round(n); }
  }
  if ('cfgScale' in patch) { const n = Number(patch.cfgScale); if (Number.isFinite(n) && n > 0) settings.cfgScale = n; }
  if ('seed' in patch) { const n = Number(patch.seed); if (Number.isFinite(n)) settings.seed = Math.round(n); } // -1 allowed (random)
  if ('timeoutMs' in patch) settings.timeoutMs = Math.max(5000, Number(patch.timeoutMs) || settings.timeoutMs);
  return getSettings();
}
function status() {
  return {
    configured: !!settings.endpoint, enabled: !!settings.enabled, endpoint: settings.endpoint, model: settings.model,
    backend: settings.endpoint ? backendOf() : '', base: baseUrl(), label: settings.label, checkpoint: settings.checkpoint, vae: settings.vae,
    sampler: settings.sampler, scheduler: settings.scheduler,
    steps: settings.steps, cfgScale: settings.cfgScale, width: settings.width, height: settings.height, batchCount: settings.batchCount, batchSize: settings.batchSize, seed: settings.seed,
    timeoutMs: settings.timeoutMs, busy: !!job,
  };
}

// ---------------------------------------------------------------- connect
// Identify a URL (or, with no URL, scan localhost) and, when it's usable, make
// it the configured backend. Never throws.
async function connect(url, opts = {}) {
  let found;
  if (url && String(url).trim()) found = await sd.identify(url, { timeoutMs: opts.timeoutMs || 3000 });
  else {
    const d = await sd.detect({ ports: opts.ports, timeoutMs: opts.timeoutMs });
    found = d.best || d.problems[0] || { kind: 'none', usable: false, message: d.message };
    found.detect = { found: d.found, problems: d.problems };
  }
  if (found && found.usable) {
    const backend = found.kind === 'comfy' ? 'comfy' : 'a1111';
    setSettings({ enabled: true, backend, endpoint: backend === 'comfy' ? found.base : `${found.base}/sdapi/v1/txt2img`, label: found.label || '', model: found.model || settings.model });
  }
  return Object.assign({ ok: !!(found && found.usable) }, found);
}

async function lists() {
  if (!settings.endpoint) return { ok: false, error: 'NO_ENDPOINT', message: sd.explain('NO_ENDPOINT') };
  const base = baseUrl();
  try { return backendOf() === 'comfy' ? await sd.comfyLists(base) : await sd.a1111Lists(base); }
  catch (e) { return { ok: false, error: String(e), message: sd.explain(String(e)) }; }
}

// ---------------------------------------------------------------- generate
let job = null; // { backend, base, startedAt, promptId?, cancelled? }

function _num(v, d) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; }
function resolveParams(prompt, opts = {}) {
  const s = settings;
  const seedRaw = opts.seed != null && opts.seed !== '' ? Number(opts.seed) : s.seed;
  const base = {
    prompt: String(prompt || '').trim(),
    negativePrompt: String(opts.negativePrompt != null ? opts.negativePrompt : ''),
    steps: Math.round(_num(opts.steps, s.steps)), cfgScale: _num(opts.cfgScale, s.cfgScale),
    width: Math.round(_num(opts.width, s.width)), height: Math.round(_num(opts.height, s.height)),
    seed: Number.isFinite(seedRaw) ? Math.round(seedRaw) : -1,
    sampler: opts.sampler != null ? String(opts.sampler) : s.sampler,
    scheduler: opts.scheduler != null ? String(opts.scheduler) : s.scheduler,
    checkpoint: opts.checkpoint != null ? String(opts.checkpoint) : s.checkpoint,
    vae: opts.vae != null ? String(opts.vae) : s.vae,
    batchSize: Math.round(_num(opts.batchSize, s.batchSize)),
    batchCount: Math.round(_num(opts.batchCount, s.batchCount)),
    loras: Array.isArray(opts.loras) ? opts.loras.filter((l) => l && l.name).map((l) => ({ name: String(l.name), weight: Number.isFinite(Number(l.weight)) ? Number(l.weight) : 1 })) : [],
  };
  // Hires fix, refiner, img2img / inpaint, ControlNet, ADetailer, … (validated; images loaded).
  const n = sdParams.normalize(opts);
  const p = Object.assign(base, n.adv);
  Object.defineProperty(p, '_errors', { value: n.errors, enumerable: false });
  return p;
}
// The settings to record with a picture: no big base64 blobs.
function publicParams(p) {
  const u = Object.assign({}, p);
  for (const k of ['initImage', 'mask']) if (u[k]) u[k] = '[image]';
  if (Array.isArray(u.controlnet)) u.controlnet = u.controlnet.map((c) => Object.assign({}, c, c.image ? { image: '[image]' } : {}, c.mask ? { mask: '[image]' } : {}));
  if (u.extra) { u.extra = Object.assign({}, u.extra); for (const [k, v] of Object.entries(u.extra)) if (typeof v === 'string' && v.length > 2000) u.extra[k] = '[data]'; }
  return u;
}
function _firstError(errors) { const e = errors[0]; return Object.assign({ ok: false, error: e.code, code: e.code, hint: e.hint || '' }, e, { message: errors.map((x) => x.message).join(' ') }); }

// Common checks + the one-job-at-a-time slot for any render (generate / upscale / workflow).
function _preflight() {
  if (!settings.enabled) return { ok: false, error: 'IMAGE_DISABLED', message: sd.explain('IMAGE_DISABLED') };
  if (!settings.endpoint) return { ok: false, error: 'NO_ENDPOINT', message: sd.explain('NO_ENDPOINT') };
  try { new URL(settings.endpoint); } catch { return { ok: false, error: 'BAD_ENDPOINT', message: sd.explain('BAD_URL') }; }
  if (job) return { ok: false, error: 'BUSY', message: 'A picture is already being made — wait for it or press Stop.' };
  return null;
}
async function _withJob(steps, fn) {
  const backend = backendOf();
  const base = baseUrl();
  const myJob = { backend, base, startedAt: Date.now(), steps };
  job = myJob;
  let r;
  try { r = await fn(myJob, backend, base); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  finally { if (job === myJob) job = null; }
  if (myJob.cancelled) r = { ok: false, error: 'CANCELLED', message: sd.explain('CANCELLED') };
  if (!r || !r.ok) {
    const out = Object.assign({ ok: false, backend }, r || { error: 'FAILED' });
    if (!out.message) out.message = sd.explain(out, { base });
    return out;
  }
  return Object.assign(r, { backend });
}

async function generate(prompt, opts = {}) {
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const p = resolveParams(prompt, opts);
  if (!p.prompt && !p.initImage) return { ok: false, error: 'NEED_PROMPT', message: sd.explain('NEED_PROMPT') };
  if (p._errors.length) return _firstError(p._errors);
  const pre = _preflight();
  if (pre) return pre;
  onEvent({ type: 'image-start', content: p.prompt });
  let warnings = [];
  const r = await _withJob(p.steps, async (myJob, backend, base) => {
    if (backend === 'comfy') return sd.comfyGenerate(base, p, { job: myJob, timeoutMs: settings.timeoutMs, pollMs: opts.pollMs });
    const chk = await control.a1111Check(base, p, p.initImage ? 'img2img' : 'txt2img');
    if (!chk.ok) return chk;
    warnings = chk.warnings || [];
    return sd.a1111Generate(base, p, { endpoint: settings.endpoint, timeoutMs: settings.timeoutMs });
  });
  if (!r.ok) return r;
  const backend = r.backend;
  onEvent({ type: 'image', content: `${r.images.length} image(s), ${r.images[0].length} base64 chars` });
  const used = publicParams(Object.assign({}, p, { seed: r.seed != null ? r.seed : p.seed }));
  if (backend === 'comfy' && r.info) { used.checkpoint = r.info.checkpoint || used.checkpoint; used.loras = r.info.loras || used.loras; used.prompt = r.info.prompt != null ? r.info.prompt : used.prompt; }
  if (backend === 'a1111' && r.info && r.info.sd_model_name && !used.checkpoint) used.checkpoint = r.info.sd_model_name;
  return { ok: true, imageBase64: r.images[0], images: r.images, info: r.rawInfo != null ? r.rawInfo : (r.info || ''), infoObj: r.info || {}, seed: used.seed, seeds: r.seeds, backend, label: settings.label, params: used, missingLoras: r.missingLoras || [], warnings, payload: r.payload ? publicParams(r.payload) : undefined, workflow: r.workflow };
}

// Upscale one picture: A1111 Extras (/extra-single-image) or a ComfyUI upscale-model graph.
async function upscale(o = {}) {
  const errors = [];
  const q = sdParams.checkValue(sdParams.UPSCALE_SCHEMA, Object.assign({}, o, { image: undefined, from: undefined, pollMs: undefined, returnImage: undefined }), 'upscale', errors);
  if (errors.length) return _firstError(errors);
  if (!o.image) return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', field: 'image', message: 'Give the picture to upscale (image).' };
  const pre = _preflight();
  if (pre) return pre;
  const args = Object.assign({}, q, { image: o.image });
  const r = await _withJob(1, (myJob, backend, base) => (backend === 'comfy' ? control.comfyUpscale(base, args, { job: myJob, timeoutMs: settings.timeoutMs, pollMs: o.pollMs }) : control.a1111Upscale(base, args, { timeoutMs: settings.timeoutMs })));
  if (!r.ok) return r;
  return Object.assign(r, { label: settings.label, params: Object.assign({ kind: 'upscale' }, q, { upscaler: r.upscaler || q.upscaler || '' }) });
}

// Run any ComfyUI API-format workflow with named params (see sd-workflows.js).
// spec: { workflow, bindings?, params? } → { ok, images, applied, workflow }
const IMG_EXT = /\.(png|jpe?g|webp|bmp)$/i;
async function runWorkflow(spec = {}, opts = {}) {
  if (backendOf() !== 'comfy' || !settings.endpoint) {
    if (!settings.endpoint) return { ok: false, error: 'NO_ENDPOINT', message: sd.explain('NO_ENDPOINT') };
    return control.unsupported('Running a ComfyUI workflow', 'a1111', 'Workflows are ComfyUI graphs. Connect to ComfyUI (http://127.0.0.1:8188) to run them; on Forge/A1111 use images.generate with hires / controlnet / extra fields.');
  }
  const chk = workflows.checkWorkflow(spec.workflow);
  if (!chk.ok) return chk;
  const pre = _preflight();
  if (pre) return pre;
  const params = Object.assign({}, spec.params || {});
  const r = await _withJob(Number(params.steps) || 20, async (myJob, backend, base) => {
    // Pictures bound to LoadImage / LoadImageMask inputs are uploaded first.
    for (const [name, v] of Object.entries(params)) {
      const targets = workflows.resolveTargets(chk.workflow, name, spec.bindings);
      if (!targets.some((t) => /^LoadImage/.test((chk.workflow[t.node] || {}).class_type || '') && t.input === 'image')) continue;
      if (typeof v === 'string' && IMG_EXT.test(v) && !/[\\/]/.test(v) && !fs.existsSync(v)) continue; // already a file in ComfyUI's input folder
      const img = sdParams.loadImage(v, name);
      if (img.error) return Object.assign({ ok: false, error: img.error.code }, img.error);
      const up = await sd.comfyUpload(base, img.b64, `autoinjector-${name.replace(/[^\w]/g, '_')}-${Date.now().toString(36)}.png`);
      if (!up.ok) return up;
      params[name] = up.name;
    }
    let seed;
    const sub = workflows.substitute(chk.workflow, params, spec.bindings, { randomSeed: () => (seed = sd.randomSeed()), mapSampler: (x) => sd.toComfySampler(x).sampler_name });
    if (!sub.ok) return sub;
    const run = await sd.comfyRunGraph(base, sub.workflow, { job: myJob, timeoutMs: settings.timeoutMs, pollMs: opts.pollMs });
    if (!run.ok) return run;
    const sp = sub.applied.find((a) => (workflows.ALIASES[a.param] || a.param) === 'seed');
    return { ok: true, images: run.images, applied: sub.applied, workflow: sub.workflow, promptId: run.promptId, seed: sp ? sub.workflow[sp.node].inputs[sp.input] : seed };
  });
  if (!r.ok) return r;
  return Object.assign(r, { label: settings.label });
}

async function progress() {
  const j = job;
  if (!j) return { ok: true, busy: false, progress: 0 };
  const elapsed = (Date.now() - j.startedAt) / 1000;
  try {
    const r = j.backend === 'comfy' ? await sd.comfyProgress(j.base, j) : await sd.a1111Progress(j.base);
    return Object.assign({ busy: true, elapsed }, r, { ok: true });
  } catch (e) { return { ok: true, busy: true, elapsed, progress: 0 }; }
}

async function cancel() {
  const j = job;
  if (!j) return { ok: true, idle: true };
  j.cancelled = true;
  try { return j.backend === 'comfy' ? await sd.comfyInterrupt(j.base, j) : await sd.a1111Interrupt(j.base); }
  catch (e) { return { ok: false, error: String(e) }; }
}

// "Test: make a 512px image"
function testRender(opts = {}) {
  return generate(opts.prompt || 'a red apple on a white table, studio photo, simple', Object.assign({ width: 512, height: 512, steps: Math.min(settings.steps || 20, 20), batchSize: 1, batchCount: 1, seed: -1 }, opts));
}

module.exports = { getSettings, setSettings, status, generate, upscale, runWorkflow, connect, lists, progress, cancel, testRender, backendOf, baseUrl, resolveParams, publicParams, explain: sd.explain };
