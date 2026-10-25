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
// loras: [{ name, weight }], initImage (A1111 img2img), denoise.
// The caller (main.js) saves the PNGs and records them — this module stays pure.
const { URL } = require('url');
const sd = require('./sd-backends');

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
  return {
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
    initImage: opts.initImage || null, denoise: opts.denoise,
  };
}

async function generate(prompt, opts = {}) {
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const p = resolveParams(prompt, opts);
  if (!p.prompt) return { ok: false, error: 'NEED_PROMPT', message: sd.explain('NEED_PROMPT') };
  if (!settings.enabled) return { ok: false, error: 'IMAGE_DISABLED', message: sd.explain('IMAGE_DISABLED') };
  if (!settings.endpoint) return { ok: false, error: 'NO_ENDPOINT', message: sd.explain('NO_ENDPOINT') };
  try { new URL(settings.endpoint); } catch { return { ok: false, error: 'BAD_ENDPOINT', message: sd.explain('BAD_URL') }; }
  if (job) return { ok: false, error: 'BUSY', message: 'A picture is already being made — wait for it or press Stop.' };
  const backend = backendOf();
  const base = baseUrl();
  const myJob = { backend, base, startedAt: Date.now(), steps: p.steps };
  job = myJob;
  onEvent({ type: 'image-start', content: p.prompt });
  let r;
  try {
    if (backend === 'comfy') r = await sd.comfyGenerate(base, p, { job: myJob, timeoutMs: settings.timeoutMs, pollMs: opts.pollMs });
    else r = await sd.a1111Generate(base, p, { endpoint: settings.endpoint, timeoutMs: settings.timeoutMs });
  } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  finally { if (job === myJob) job = null; }
  if (myJob.cancelled) r = { ok: false, error: 'CANCELLED', message: sd.explain('CANCELLED') };
  if (!r || !r.ok) {
    const out = Object.assign({ ok: false, backend }, r || { error: 'FAILED' });
    if (!out.message) out.message = sd.explain(out, { base });
    return out;
  }
  onEvent({ type: 'image', content: `${r.images.length} image(s), ${r.images[0].length} base64 chars` });
  const used = Object.assign({}, p, { seed: r.seed != null ? r.seed : p.seed, initImage: undefined });
  if (backend === 'comfy' && r.info) { used.checkpoint = r.info.checkpoint || used.checkpoint; used.loras = r.info.loras || used.loras; used.prompt = r.info.prompt != null ? r.info.prompt : used.prompt; }
  if (backend === 'a1111' && r.info && r.info.sd_model_name && !used.checkpoint) used.checkpoint = r.info.sd_model_name;
  return { ok: true, imageBase64: r.images[0], images: r.images, info: r.rawInfo != null ? r.rawInfo : (r.info || ''), infoObj: r.info || {}, seed: used.seed, seeds: r.seeds, backend, label: settings.label, params: used, missingLoras: r.missingLoras || [] };
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

module.exports = { getSettings, setSettings, status, generate, connect, lists, progress, cancel, testRender, backendOf, resolveParams, explain: sd.explain };
