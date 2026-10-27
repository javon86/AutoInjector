'use strict';
/*
 * sd-sanitize.js — "make it safe before sending": every Stable Diffusion request
 * (🎨 Images tab, 🎩 Alfred's images.generate, Akọwe's /image/request) is
 * checked against what the connected SD app really has, so a caller's guess
 * ("euler a", "dpm++ 2m karras", a checkpoint name without its hash, a LoRA
 * that isn't installed, 3000 px wide) doesn't come back as a bare HTTP 500.
 *
 * The real case: two of Alfred's images.generate calls on Forge (Stability
 * Matrix) answered HTTP_500 SD_ERROR because of settings Forge couldn't take.
 *
 *   sanitize(opts, ctx) → { opts, warnings, fixes, unknown }
 *     opts: generate() options (sd-studio buildRequest().opts), never changed in place.
 *     ctx: { backend: 'a1111' | 'comfy',
 *            lists: { samplers, schedulers, checkpoints, vaes, loras, upscalers } (the
 *                   studio's live lists; an empty / missing list = unknown → left alone),
 *            current: { sampler, scheduler, checkpoint, vae } (the app's saved choices),
 *            family(checkpointName) → 'SD1.5' | 'SDXL' | 'Pony' | … | '' }
 *     1. names: matched case- and punctuation-insensitively to the server's own
 *        spelling ("euler a" → "Euler a"; "dpm++ 2m karras" → sampler "DPM++ 2M" +
 *        scheduler "Karras" when the scheduler is separate; a checkpoint by its file
 *        name without folder / extension / hash). A name the server doesn't list is
 *        dropped (the app's current one is used) with a plain warning. A name is never
 *        sent when the list is known and doesn't have it.
 *     2. numbers: width / height → multiples of 8 in 64..2048, steps 1..150, cfg 1..30,
 *        batch size 1..8, batch count 1..10, denoise 0..1, seed an integer or -1.
 *     3. model family: an SDXL-class checkpoint below 768 px, or SD1.5 at 1024 px+ → a
 *        soft warning (never blocked).
 *     fixes: [{ field, from, to }] for the log (names only, never the prompt).
 *
 *   retryPlan(result, opts, ctx) → { kind, opts, warning, left } | null — the ONE safe
 *     retry after a failure (ctx: { interactive, family, current, backend, why }):
 *       VAE_LOAD_FAILED → the same request with VAE Automatic (callers that can't click
 *                         the Images tab's "Use Automatic VAE and retry"; interactive = no);
 *       OOM             → a smaller size (512 SD1.5 / 768–1024 SDXL), batch 1, no hires fix;
 *       SD_ERROR        → an unknown 500 with non-basic settings → only the basics
 *                         (prompt, negative, size, steps, cfg, seed, current checkpoint,
 *                         Automatic VAE; img2img / inpaint keep their pictures).
 *     Everything else (cancelled, refused, checkpoint / LoRA / NaN …) → null.
 *
 * Pure and Electron-free (the studio does the talking).
 */
const sdBackends = require('./sd-backends');

const MAX_SIDE = 2048;
const MIN_SIDE = 64;
const BIG = ['SDXL', 'Pony', 'Illustrious', 'NoobAI', 'Flux', 'SD3'];
const AUTO_RE = /^(auto|automatic|default)$/i;

// "DPM++ 2M Karras", "dreamshaper_8.safetensors [879db523c3]", "sd15\\dreamshaper_8.safetensors" → a comparable key.
function norm(v) {
  return String(v == null ? '' : v).replace(/\\/g, '/').split('/').pop()
    .replace(/\s*\[[0-9a-f]{6,}\]\s*$/i, '').replace(/\.(safetensors|ckpt|pt|pth|bin|sft|gguf)$/i, '')
    .toLowerCase().replace(/[^a-z0-9+]/g, '');
}
const _q = (s) => `“${String(s).slice(0, 80)}”`;
const _str = (x) => (typeof x === 'string' ? x : (x && (x.title || x.name)) || '');
// Find `name` in a list of strings or {name,title,model_name,alias,file}; returns the server's own spelling.
function findName(list, name, keepExact = true) {
  if (name == null || name === '' || !Array.isArray(list) || !list.length) return null;
  const s = String(name).trim();
  const keys = (x) => (typeof x === 'string' ? [x] : [x.title, x.name, x.model_name, x.alias, x.file].filter(Boolean).map(String));
  for (const x of list) if (keys(x).includes(s)) return keepExact ? s : _str(x); // already one of the server's own spellings (title, model_name, alias …)
  const lo = s.toLowerCase();
  for (const x of list) if (keys(x).some((k) => k.toLowerCase() === lo)) return _str(x);
  const n = norm(s);
  if (!n) return null;
  for (const x of list) if (keys(x).some((k) => norm(k) === n)) return _str(x);
  return null;
}
const known = (l) => Array.isArray(l) && l.length > 0;

// ---------------------------------------------------------------- samplers / schedulers
function resolveSampler(sampler, scheduler, lists, backend) {
  const samplers = lists.samplers || []; const schedulers = lists.schedulers || [];
  const out = { sampler: null, scheduler: null };
  const s = String(sampler).trim();
  const hit = findName(samplers, s);
  if (hit) { out.sampler = hit; return out; }
  // "dpm++ 2m karras" → "DPM++ 2M" + "Karras" (A1111 ≥ 1.9 / Forge / ComfyUI keep the schedule separate)
  const ns = norm(s);
  const scheds = schedulers.map(String).filter((x) => norm(x) && !/^automatic$/i.test(x)).sort((a, b) => norm(b).length - norm(a).length);
  for (const sch of scheds) {
    const k = norm(sch);
    if (ns.length > k.length && ns.endsWith(k)) {
      const rest = ns.slice(0, -k.length);
      let sm = samplers.find((x) => norm(x) === rest);
      if (!sm && backend === 'comfy') { const key = Object.keys(sdBackends.SAMPLER_MAP).find((x) => norm(x) === rest); if (key && samplers.includes(sdBackends.SAMPLER_MAP[key])) sm = sdBackends.SAMPLER_MAP[key]; }
      if (sm) { out.sampler = sm; out.splitScheduler = sch; return out; }
    }
  }
  // the other family's spelling: "Euler a" on ComfyUI → euler_ancestral; "euler_ancestral" on A1111 → "Euler a"
  const map = sdBackends.SAMPLER_MAP;
  if (backend === 'comfy') {
    const key = Object.keys(map).find((x) => norm(x) === ns);
    if (key && samplers.includes(map[key])) { out.sampler = map[key]; return out; }
  } else {
    const key = Object.keys(map).find((x) => map[x] === s.toLowerCase());
    const back = key ? samplers.find((x) => norm(x) === norm(key)) : null;
    if (back) { out.sampler = back; return out; }
  }
  return out;
}
function resolveScheduler(sch, lists, backend) {
  const schedulers = lists.schedulers || [];
  const hit = findName(schedulers, sch);
  if (hit) return hit;
  if (backend === 'comfy') { const m = sdBackends.SCHED_MAP[String(sch).trim().toLowerCase()]; if (m && schedulers.includes(m)) return m; }
  return null;
}

// ---------------------------------------------------------------- numbers
function _int(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : NaN; }
function clampNum(v, lo, hi) { const n = Number(v); if (!Number.isFinite(n)) return NaN; return Math.min(hi, Math.max(lo, n)); }
function side(v) { const n = Number(v); if (!Number.isFinite(n) || n <= 0) return NaN; return Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.round(n / 8) * 8)); }

function sanitize(opts, ctx = {}) {
  const o = Object.assign({}, opts || {});
  const lists = (ctx && ctx.lists) || {};
  const backend = ctx.backend === 'comfy' ? 'comfy' : 'a1111';
  const cur = ctx.current || {};
  const warnings = []; const fixes = []; const unknown = [];
  const warn = (field, message) => warnings.push({ level: 'soft', kind: 'safe', field, message });
  const fix = (field, from, to) => { if (String(from) !== String(to)) fixes.push({ field, from: String(from).slice(0, 80), to: String(to).slice(0, 80) }); };
  const given = (v) => v !== undefined && v !== null && v !== '';

  // ---- sampler (+ a schedule written into it) and scheduler
  if (known(lists.samplers)) {
    const fromCaller = given(o.sampler);
    const want = fromCaller ? o.sampler : cur.sampler;
    if (given(want)) {
      const r = resolveSampler(want, o.scheduler, lists, backend);
      if (r.sampler) {
        if (fromCaller || r.sampler !== want) { fix('sampler', want, r.sampler); o.sampler = r.sampler; }
        if (r.splitScheduler && (!given(o.scheduler) || AUTO_RE.test(String(o.scheduler)))) { fix('scheduler', o.scheduler || '', r.splitScheduler); o.scheduler = r.splitScheduler; }
      } else {
        const curOk = fromCaller && given(cur.sampler) ? resolveSampler(cur.sampler, '', lists, backend).sampler : null;
        const dflt = backend === 'comfy' ? lists.samplers.find((x) => x === 'euler') : lists.samplers.find((x) => x === 'Euler a');
        const fb = curOk || dflt || lists.samplers[0];
        unknown.push('sampler'); fix('sampler', want, fb); o.sampler = fb;
        warn('sampler', `There's no sampler called ${_q(want)}${fromCaller ? '' : ' (your saved setting)'} — used ${fb}.`);
      }
    }
  }
  if (known(lists.schedulers)) {
    const fromCaller = given(o.scheduler);
    const want = fromCaller ? o.scheduler : cur.scheduler;
    if (given(want)) {
      const hit = resolveScheduler(want, lists, backend);
      if (hit) { if (fromCaller || hit !== want) { fix('scheduler', want, hit); o.scheduler = hit; } }
      else {
        const curOk = fromCaller && given(cur.scheduler) ? resolveScheduler(cur.scheduler, lists, backend) : null;
        const fb = curOk || lists.schedulers.find((x) => /^(automatic|normal)$/i.test(x)) || '';
        unknown.push('scheduler'); fix('scheduler', want, fb); o.scheduler = fb;
        warn('scheduler', `There's no schedule type called ${_q(want)}${fromCaller ? '' : ' (your saved setting)'} — used ${fb || 'your SD app\'s default'}.`);
      }
    }
  }

  // the hires pass's own sampler / schedule (default: the same as the main pass)
  if (o.hires && typeof o.hires === 'object') {
    for (const [k, list] of [['sampler', lists.samplers], ['scheduler', lists.schedulers]]) {
      if (!given(o.hires[k]) || !known(list)) continue;
      const hit = k === 'sampler' ? resolveSampler(o.hires[k], '', lists, backend).sampler : resolveScheduler(o.hires[k], lists, backend);
      o.hires = Object.assign({}, o.hires);
      if (hit) { fix(`hires.${k}`, o.hires[k], hit); o.hires[k] = hit; }
      else { unknown.push(`hires.${k}`); fix(`hires.${k}`, o.hires[k], ''); warn(`hires.${k}`, `There's no ${k === 'sampler' ? 'sampler' : 'schedule type'} called ${_q(o.hires[k])} for the hires pass — used the same as the main pass.`); delete o.hires[k]; }
    }
  }

  // ---- checkpoint, refiner / hires checkpoint
  const exact = backend !== 'comfy'; // A1111 takes a title or a model_name as given; ComfyUI wants its own path
  const ckOf = (v) => findName(lists.checkpoints, v, exact);
  if (known(lists.checkpoints)) {
    for (const [field, fromCaller] of [['checkpoint', given(o.checkpoint)]]) {
      const want = fromCaller ? o.checkpoint : cur.checkpoint;
      if (!given(want)) continue;
      const hit = ckOf(want);
      if (hit) { if (fromCaller || hit !== want) { fix(field, want, hit); o.checkpoint = hit; } continue; }
      const curOk = fromCaller && given(cur.checkpoint) ? ckOf(cur.checkpoint) : null;
      unknown.push(field); fix(field, want, curOk || '');
      o.checkpoint = curOk || '';
      warn(field, `There's no checkpoint called ${_q(want)}${fromCaller ? '' : ' (your saved setting)'} — used ${curOk ? _q(curOk) : 'the one your SD app has loaded'}.`);
    }
    if (o.refiner && typeof o.refiner === 'object' && given(o.refiner.checkpoint)) {
      const hit = ckOf(o.refiner.checkpoint);
      if (hit) { fix('refiner.checkpoint', o.refiner.checkpoint, hit); o.refiner = Object.assign({}, o.refiner, { checkpoint: hit }); }
      else { unknown.push('refiner.checkpoint'); fix('refiner.checkpoint', o.refiner.checkpoint, ''); warn('refiner', `There's no checkpoint called ${_q(o.refiner.checkpoint)} for the refiner — made it without a refiner.`); delete o.refiner; }
    }
    if (o.hires && typeof o.hires === 'object' && given(o.hires.checkpoint)) {
      const hit = ckOf(o.hires.checkpoint);
      o.hires = Object.assign({}, o.hires);
      if (hit) { fix('hires.checkpoint', o.hires.checkpoint, hit); o.hires.checkpoint = hit; }
      else { unknown.push('hires.checkpoint'); fix('hires.checkpoint', o.hires.checkpoint, ''); warn('hires.checkpoint', `There's no checkpoint called ${_q(o.hires.checkpoint)} for the hires pass — used the same checkpoint.`); delete o.hires.checkpoint; }
    }
  }

  // ---- VAE
  if (known(lists.vaes)) {
    const fromCaller = given(o.vae);
    const want = fromCaller ? o.vae : cur.vae;
    if (given(want)) {
      const s = String(want).trim();
      let hit;
      if (AUTO_RE.test(s)) hit = lists.vaes.find((x) => /^automatic$/i.test(x)) || 'Automatic';
      else if (/^none$/i.test(s)) hit = lists.vaes.find((x) => /^none$/i.test(x)) || lists.vaes.find((x) => /^automatic$/i.test(x)) || 'Automatic';
      else hit = findName(lists.vaes, s);
      if (hit) { if (fromCaller || hit !== want) { fix('vae', want, hit); o.vae = hit; } }
      else {
        unknown.push('vae'); fix('vae', want, 'Automatic'); o.vae = 'Automatic';
        warn('vae', `There's no VAE called ${_q(want)}${fromCaller ? '' : ' (your saved setting)'} — used Automatic.`);
      }
    }
  }

  // ---- LoRAs
  if (known(lists.loras) && Array.isArray(o.loras) && o.loras.length) {
    const keep = []; const gone = [];
    for (const l of o.loras) {
      if (!l || !given(l.name)) continue;
      const hit = findName(lists.loras, l.name, exact);
      if (hit) { if (hit !== l.name) fix('lora', l.name, hit); keep.push(Object.assign({}, l, { name: hit })); }
      else { gone.push(String(l.name)); fix('lora', l.name, ''); }
    }
    if (gone.length) { unknown.push('loras'); warn('loras', `There's no LoRA called ${gone.map(_q).join(', ')} in your SD app — left ${gone.length > 1 ? 'them' : 'it'} out.`); }
    o.loras = keep;
  }

  // ---- hires upscaler
  if (o.hires && typeof o.hires === 'object' && given(o.hires.upscaler) && known(lists.upscalers)) {
    const hit = findName(lists.upscalers, o.hires.upscaler);
    o.hires = Object.assign({}, o.hires);
    if (hit) { fix('hires.upscaler', o.hires.upscaler, hit); o.hires.upscaler = hit; }
    else {
      unknown.push('hires.upscaler'); fix('hires.upscaler', o.hires.upscaler, '');
      warn('hires.upscaler', `There's no upscaler called ${_q(o.hires.upscaler)} — the hires fix used your SD app's default.`);
      delete o.hires.upscaler;
    }
  }

  // ---- numbers
  const sizeWas = [o.width, o.height];
  let sized = false;
  for (const k of ['width', 'height']) {
    if (!given(o[k])) continue;
    const v = side(o[k]);
    if (Number.isNaN(v)) { fix(k, o[k], ''); delete o[k]; sized = true; continue; }
    if (v !== Number(o[k])) sized = true;
    if (v !== o[k]) { fix(k, o[k], v); o[k] = v; }
  }
  if (sized) warn('size', `The size ${sizeWas.map((x) => (given(x) ? x : '?')).join('×')} isn't one Stable Diffusion can make — used ${o.width || '(default)'}×${o.height || '(default)'} (multiples of 8, ${MIN_SIDE}–${MAX_SIDE} px).`);
  const num = (k, lo, hi, isInt, label) => {
    if (!given(o[k])) return;
    let v = isInt ? _int(o[k]) : Number(o[k]);
    if (!Number.isFinite(v)) { fix(k, o[k], ''); warn(k, `${label} “${String(o[k]).slice(0, 20)}” isn't a number — used the default.`); delete o[k]; return; }
    const c = clampNum(v, lo, hi);
    if (c !== Number(o[k])) { if (c !== v || !isInt) warn(k, `${label} ${o[k]} is out of range — used ${c} (${lo}–${hi}).`); }
    if (c !== o[k]) { fix(k, o[k], c); o[k] = c; }
  };
  num('steps', 1, 150, true, 'Steps');
  num('cfgScale', 1, 30, false, 'CFG scale');
  num('batchSize', 1, 8, true, 'Batch size');
  num('batchCount', 1, 10, true, 'Batch count');
  num('denoise', 0, 1, false, 'Denoise');
  if (o.hires && typeof o.hires === 'object' && given(o.hires.denoise)) {
    const d = clampNum(o.hires.denoise, 0, 1);
    if (d !== Number(o.hires.denoise)) { warn('hires.denoise', `Hires denoise ${o.hires.denoise} is out of range — used ${Number.isNaN(d) ? 'the default' : d} (0–1).`); fix('hires.denoise', o.hires.denoise, Number.isNaN(d) ? '' : d); o.hires = Object.assign({}, o.hires); if (Number.isNaN(d)) delete o.hires.denoise; else o.hires.denoise = d; }
  }
  if (given(o.seed)) {
    const n = Number(o.seed);
    let s = !Number.isFinite(n) || n < 0 ? -1 : Math.round(n);
    if (s > 4294967295) s %= 4294967296;
    if (s !== n) { fix('seed', o.seed, s); if (!Number.isFinite(n) || (n < 0 && n !== -1)) warn('seed', `Seed “${String(o.seed).slice(0, 20)}” isn't a whole number ≥ 0 — used a random seed.`); o.seed = s; }
  }

  // ---- model family vs size (warn only)
  const ck = given(o.checkpoint) ? o.checkpoint : cur.checkpoint;
  let fam = '';
  try { fam = ctx.family ? ctx.family(ck) || '' : ''; } catch (_) { fam = ''; }
  const w = Number(o.width), h = Number(o.height);
  if (fam && w > 0 && h > 0) {
    const long = Math.max(w, h);
    if (BIG.includes(fam) && fam !== 'Flux' && fam !== 'SD3' && long < 768) warn('size', `${fam} checkpoints are made for about 1024×1024 — at ${w}×${h} the picture may come out garbled. Try 1024×1024 (or 832×1216).`);
    if (fam === 'SD1.5' && Math.min(w, h) >= 1024) warn('size', `SD1.5 checkpoints are made for 512–768 px — at ${w}×${h} you may get doubled people or heads. Try 512×768 and the hires fix.`);
  }
  return { opts: o, warnings, fixes, unknown, family: fam };
}

// ---------------------------------------------------------------- the one safe retry
const NON_BASIC = ['sampler', 'scheduler', 'checkpoint', 'vae', 'loras', 'hires', 'refiner', 'extra', 'overrideSettings', 'options', 'workflow', 'controlnet', 'adetailer', 'script', 'alwaysonScripts', 'styles', 'clipSkip', 'variation', 'restoreFaces', 'tiling'];
const KEEP_BASIC = ['negativePrompt', 'width', 'height', 'steps', 'cfgScale', 'seed', 'batchSize', 'batchCount', 'initImage', 'mask', 'denoise', 'inpaint', 'resizeMode', 'imageCfgScale'];
function nonBasic(opts, cur) {
  const o = opts || {}; const c = cur || {};
  const set = (v) => v !== undefined && v !== null && v !== '' && v !== false && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
  const out = [];
  for (const k of NON_BASIC) {
    let v = o[k];
    if (v === undefined && ['sampler', 'scheduler', 'checkpoint', 'vae'].includes(k)) v = c[k];
    if (k === 'vae' && typeof v === 'string' && /^(automatic|none)$/i.test(v.trim())) continue;
    if (k === 'scheduler' && typeof v === 'string' && /^automatic$/i.test(v.trim())) continue;
    if (set(v)) out.push(k);
  }
  return out;
}
function basics(opts, ctx) {
  const o = {};
  for (const k of KEEP_BASIC) if (opts[k] !== undefined) o[k] = opts[k];
  // '' = don't send it → the app's own sampler / schedule / loaded checkpoint
  o.sampler = ''; o.scheduler = ''; o.loras = []; o.vae = 'Automatic';
  o.checkpoint = ctx.backend === 'comfy' && ctx.current && ctx.current.checkpoint ? ctx.current.checkpoint : '';
  return o;
}
function retryPlan(result, opts, ctx = {}) {
  if (!result || result.ok) return null;
  const code = result.code || result.error;
  const o = opts || {};
  const cur = ctx.current || {};
  if (code === 'VAE_LOAD_FAILED') {
    if (ctx.interactive) return null; // the Images tab offers "Use Automatic VAE and retry" itself
    if (typeof o.vae === 'string' && /^automatic$/i.test(o.vae.trim())) return null;
    const was = o.vae || cur.vae;
    return { kind: 'vae-automatic', opts: Object.assign({}, o, { vae: 'Automatic' }), left: ['vae'],
      warning: { level: 'soft', kind: 'retry', message: `The VAE${was && !/^(automatic|none)$/i.test(was) ? ` ${_q(was)}` : ' your SD app is set to'} can't be loaded — made it with Automatic VAE instead.` } };
  }
  if (code === 'OOM') {
    const w = Number(o.width) || 512, h = Number(o.height) || 512;
    const big = BIG.includes(ctx.family || '');
    const long = Math.max(w, h);
    const target = big ? (long > 1024 ? 1024 : 768) : 512;
    const k = Math.min(1, target / long);
    const nw = Math.max(MIN_SIDE, Math.round((w * k) / 64) * 64), nh = Math.max(MIN_SIDE, Math.round((h * k) / 64) * 64);
    const batchy = (Number(o.batchSize) || 1) > 1 || (Number(o.batchCount) || 1) > 1;
    if (nw === w && nh === h && !batchy && !o.hires && !o.refiner) return null; // nothing smaller to try
    const r = Object.assign({}, o, { width: nw, height: nh, batchSize: 1, batchCount: 1 });
    delete r.hires; delete r.refiner;
    return { kind: 'smaller', opts: r, left: ['size', 'batch'],
      warning: { level: 'soft', kind: 'retry', message: `Your graphics card ran out of memory at ${w}×${h}${batchy ? ` (batch ${(Number(o.batchSize) || 1) * (Number(o.batchCount) || 1)})` : ''} — made one picture at ${nw}×${nh} instead${o.hires ? ', without the hires fix' : ''}.` } };
  }
  if (code === 'SD_ERROR') {
    const extra = nonBasic(o, cur);
    if (!extra.length) return null;
    const why = ctx.why ? String(ctx.why).slice(0, 160) : 'HTTP 500';
    return { kind: 'basics', opts: basics(o, ctx), left: extra,
      warning: { level: 'soft', kind: 'retry', message: `Your SD app refused some of the settings (${why}); made it with the basics instead (left out: ${extra.join(', ')}).` } };
  }
  return null;
}

module.exports = { sanitize, retryPlan, nonBasic, findName, norm, MAX_SIDE, MIN_SIDE };
