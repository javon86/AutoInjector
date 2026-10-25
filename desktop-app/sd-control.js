'use strict';
/*
 * sd-control.js — the rest of Stable Diffusion, beyond "make a picture":
 *
 * A1111 / Forge / reForge / SD.Next (/sdapi/v1/*):
 *   options get / set (every settings-menu key; validated against what the server
 *   returns + its /openapi.json), upscalers + latent modes, Extras upscale
 *   (/extra-single-image), prompt styles, embeddings, scripts + their args,
 *   ControlNet models / modules (/controlnet/*), ADetailer models, interrupt,
 *   skip, refresh checkpoints / LoRAs / VAEs / embeddings, memory (RAM / VRAM),
 *   the txt2img / img2img payload schema from /openapi.json (for the validated
 *   pass-through) and check(): validate every name in a request BEFORE sending it.
 * ComfyUI:
 *   /object_info (all node types or one), /queue, /interrupt, /free,
 *   /system_stats memory, picture upload, upscale-with-model graph.
 *
 * Everything resolves (never throws). Unknown names come back as
 * { ok:false, code:'UNKNOWN_VALUE', field, hint }; things the connected app can't
 * do as { ok:false, code:'UNSUPPORTED_ON_BACKEND', hint }.
 */
const sd = require('./sd-backends');
const P = require('./sd-params');

const TTL = 5 * 60 * 1000;
const cache = new Map();
async function cached(key, fn, ttl = TTL) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < ttl) return c.v;
  const v = await fn();
  if (v != null) cache.set(key, { t: Date.now(), v });
  return v;
}
function clearCache(base) { for (const k of [...cache.keys()]) if (!base || k.startsWith(`${base}|`)) cache.delete(k); }

function err(code, message, extra) { return Object.assign({ ok: false, error: code, code, message }, extra || {}); }
function unsupported(feature, backend, hint) {
  const name = backend === 'comfy' ? 'ComfyUI' : backend === 'a1111' ? 'this WebUI' : 'the connected app';
  return err('UNSUPPORTED_ON_BACKEND', `${feature} isn't available on ${name}.`, { backend, feature, hint: hint || '' });
}
function httpFail(r, base, what) {
  if (r && r.status === 404) return null; // caller decides (usually "extension not installed")
  return err(r.error || 'ERROR', `${what}: ${sd.explain(r, { base })}`, { detail: sd.errDetail(r) });
}
const names = (arr, f = 'name') => (arr || []).map((x) => (typeof x === 'string' ? x : x && (x[f] || x.name || x.title))).filter(Boolean);

// ================================================================ A1111
async function openapi(base) {
  return cached(`${base}|openapi`, async () => { const r = await sd.getJson(`${base}/openapi.json`, 8000); return r.ok && r.json && r.json.paths ? r.json : null; });
}
async function payloadSchema(base, kind = 'txt2img') {
  const oa = await openapi(base);
  if (!oa) return err('NO_SCHEMA', 'The server has no /openapi.json, so extra fields can\'t be checked.', { hint: 'Extra fields are still sent; check the WebUI console if one is ignored.' });
  const s = P.openapiRequestSchema(oa, `/sdapi/v1/${kind === 'img2img' ? 'img2img' : 'txt2img'}`);
  if (!s) return err('NO_SCHEMA', `The server's /openapi.json has no ${kind} schema.`);
  return Object.assign({ ok: true, kind }, s);
}
// Every payload field the server accepts, and which structured param covers it.
async function extraFields(base, kind = 'txt2img') {
  const s = await payloadSchema(base, kind);
  if (!s.ok) return s;
  const map = P.a1111FieldMap();
  const fields = Object.entries(s.properties).map(([name, spec]) => {
    const t = P.propTypes(spec);
    return { name, types: t.types, nullable: t.nullable, enum: t.enum, description: spec.description || spec.title || '', default: spec.default, structured: map[name] || null };
  });
  return { ok: true, kind, schema: s.name, count: fields.length, fields };
}
async function options(base) {
  const r = await sd.getJson(`${base}/sdapi/v1/options`, 10000);
  if (!r.ok || !r.json || typeof r.json !== 'object') return httpFail(r, base, 'Reading the settings failed') || err('NO_API', sd.explain('NO_API', { base }));
  return { ok: true, options: r.json, count: Object.keys(r.json).length };
}
async function optionsSchema(base) {
  const oa = await openapi(base);
  const s = oa && oa.components && oa.components.schemas && oa.components.schemas.Options;
  return s && s.properties ? s.properties : null;
}
async function a1111ListsFor(base, keys) {
  const L = {};
  if (keys.includes('sd_model_checkpoint')) { const r = await sd.getJson(`${base}/sdapi/v1/sd-models`, 8000); L.checkpoints = r.ok && Array.isArray(r.json) ? r.json : []; }
  if (keys.includes('sd_vae')) { const r = await sd.getJson(`${base}/sdapi/v1/sd-vae`, 8000); L.vaes = r.ok && Array.isArray(r.json) ? r.json.map((v) => v.model_name) : []; }
  return L;
}
async function setOptions(base, patch) {
  const cur = await options(base);
  if (!cur.ok) return cur;
  const keys = Object.keys(patch || {});
  const v = P.validateOptions(cur.options, patch, { schema: await optionsSchema(base), lists: await a1111ListsFor(base, keys) });
  if (!v.ok) return v;
  const r = await sd.postJson(`${base}/sdapi/v1/options`, patch, 300000); // a checkpoint switch can take minutes
  if (!r.ok) return err(r.error || 'ERROR', `The server refused the setting: ${sd.errDetail(r) || sd.explain(r, { base })}`, { detail: sd.errDetail(r) });
  return { ok: true, set: keys, values: patch };
}
async function upscalers(base) {
  const [u, l] = await Promise.all([sd.getJson(`${base}/sdapi/v1/upscalers`, 8000), sd.getJson(`${base}/sdapi/v1/latent-upscale-modes`, 8000)]);
  if (!u.ok) return httpFail(u, base, 'Listing upscalers failed') || err('NO_API', sd.explain('NO_API', { base }));
  const ups = (Array.isArray(u.json) ? u.json : []).map((x) => ({ name: x.name, model: x.model_name || '', path: x.model_path || '', scale: x.scale || null }));
  const latent = l.ok && Array.isArray(l.json) ? names(l.json) : [];
  return { ok: true, upscalers: ups, latent, all: [...latent, ...ups.map((x) => x.name)] };
}
async function styles(base) {
  const r = await sd.getJson(`${base}/sdapi/v1/prompt-styles`, 8000);
  if (!r.ok) return httpFail(r, base, 'Listing styles failed') || unsupported('Prompt styles', 'a1111');
  return { ok: true, styles: (Array.isArray(r.json) ? r.json : []).map((s) => ({ name: s.name, prompt: s.prompt || '', negativePrompt: s.negative_prompt || '' })) };
}
async function embeddings(base) {
  const r = await sd.getJson(`${base}/sdapi/v1/embeddings`, 8000);
  if (!r.ok) return httpFail(r, base, 'Listing embeddings failed') || unsupported('Embeddings', 'a1111');
  return { ok: true, loaded: Object.keys((r.json && r.json.loaded) || {}), skipped: Object.keys((r.json && r.json.skipped) || {}) };
}
async function scripts(base) {
  const [s, i] = await Promise.all([sd.getJson(`${base}/sdapi/v1/scripts`, 8000), sd.getJson(`${base}/sdapi/v1/script-info`, 8000)]);
  if (!s.ok) return httpFail(s, base, 'Listing scripts failed') || unsupported('Scripts', 'a1111');
  const info = (i.ok && Array.isArray(i.json) ? i.json : []).map((x) => ({ name: x.name, img2img: !!x.is_img2img, alwayson: !!x.is_alwayson,
    args: (x.args || []).map((a) => ({ label: a.label, value: a.value, minimum: a.minimum, maximum: a.maximum, step: a.step, choices: a.choices })) }));
  return { ok: true, txt2img: (s.json && s.json.txt2img) || [], img2img: (s.json && s.json.img2img) || [], info };
}
async function controlnetModels(base) {
  const r = await sd.getJson(`${base}/controlnet/model_list?update=true`, 10000);
  if (!r.ok) return httpFail(r, base, 'Listing ControlNet models failed') || unsupported('ControlNet', 'a1111', 'Install the sd-webui-controlnet extension (Forge has ControlNet built in) and restart the WebUI with --api.');
  return { ok: true, models: (r.json && r.json.model_list) || [] };
}
async function controlnetModules(base) {
  const r = await sd.getJson(`${base}/controlnet/module_list?alias_names=false`, 10000);
  if (!r.ok) return httpFail(r, base, 'Listing ControlNet preprocessors failed') || unsupported('ControlNet', 'a1111', 'Install the sd-webui-controlnet extension (Forge has ControlNet built in) and restart the WebUI with --api.');
  return { ok: true, modules: (r.json && r.json.module_list) || [], details: (r.json && r.json.module_detail) || {} };
}
async function adetailerModels(base) {
  const r = await sd.getJson(`${base}/adetailer/v1/ad_model`, 8000);
  if (!r.ok) return httpFail(r, base, 'Listing ADetailer models failed') || unsupported('ADetailer', 'a1111', 'Install the ADetailer extension (Extensions → Available → ADetailer) and restart the WebUI.');
  return { ok: true, models: (r.json && r.json.ad_model) || [] };
}
async function interrupt(base) { const r = await sd.postJson(`${base}/sdapi/v1/interrupt`, {}, 5000); return r.ok ? { ok: true } : err(r.error, sd.explain(r, { base })); }
async function skip(base) { const r = await sd.postJson(`${base}/sdapi/v1/skip`, {}, 5000); return r.ok ? { ok: true } : err(r.error, sd.explain(r, { base })); }
const REFRESH = { checkpoints: '/sdapi/v1/refresh-checkpoints', loras: '/sdapi/v1/refresh-loras', vae: '/sdapi/v1/refresh-vae', embeddings: '/sdapi/v1/refresh-embeddings' };
async function refresh(base, what = 'all') {
  const list = what === 'all' ? Object.keys(REFRESH) : [what];
  if (list.some((w) => !REFRESH[w])) return err('INVALID_PARAM', `Refresh what? One of: all, ${Object.keys(REFRESH).join(', ')}.`);
  const out = {};
  for (const w of list) { const r = await sd.postJson(`${base}${REFRESH[w]}`, {}, 120000); out[w] = r.ok ? 'ok' : (r.status === 404 ? 'not available' : r.error); }
  clearCache(base);
  const okAny = Object.values(out).some((v) => v === 'ok');
  return okAny ? { ok: true, refreshed: out } : err('REFRESH_FAILED', 'Nothing could be refreshed.', { refreshed: out });
}
async function memory(base) {
  const r = await sd.getJson(`${base}/sdapi/v1/memory`, 8000);
  if (!r.ok || !r.json) return httpFail(r, base, 'Reading memory failed') || unsupported('Memory info', 'a1111');
  const cuda = r.json.cuda && r.json.cuda.system ? r.json.cuda.system : null;
  return { ok: true, ram: r.json.ram || null, vram: cuda ? { free: cuda.free, used: cuda.used, total: cuda.total } : null, raw: r.json };
}
// Extras tab: upscale one picture (POST /sdapi/v1/extra-single-image).
async function a1111Upscale(base, o, opts = {}) {
  const img = P.loadImage(o.image, 'image');
  if (img.error) return Object.assign({ ok: false, error: img.error.code }, img.error);
  if (!img.b64) return err('INVALID_PARAM', 'Give the picture to upscale (image).');
  const body = { image: img.b64, upscaler_1: o.upscaler || 'R-ESRGAN 4x+', resize_mode: o.width || o.height ? 1 : 0, upscaling_resize: o.factor || 2, show_extras_results: true };
  if (o.width) body.upscaling_resize_w = o.width;
  if (o.height) body.upscaling_resize_h = o.height;
  if (o.crop != null) body.upscaling_crop = !!o.crop;
  if (o.upscaler2) { body.upscaler_2 = o.upscaler2; body.extras_upscaler_2_visibility = o.upscaler2Visibility != null ? o.upscaler2Visibility : 0.5; }
  if (o.gfpgan != null) body.gfpgan_visibility = o.gfpgan;
  if (o.codeformer != null) body.codeformer_visibility = o.codeformer;
  if (o.codeformerWeight != null) body.codeformer_weight = o.codeformerWeight;
  if (!opts.skipCheck) {
    const ups = await upscalers(base);
    if (ups.ok && ups.upscalers.length) {
      for (const [f, v] of [['upscaler', body.upscaler_1], ['upscaler2', body.upscaler_2]]) {
        if (v && !ups.upscalers.some((u) => u.name.toLowerCase() === String(v).toLowerCase())) return err('UNKNOWN_VALUE', `There is no upscaler “${v}” on this server.`, { field: f, hint: `Choose one of: ${ups.upscalers.map((u) => u.name).join(', ')}` });
      }
    }
  }
  const r = await sd.postJson(`${base}/sdapi/v1/extra-single-image`, body, opts.timeoutMs || 300000);
  if (!r.ok) { const out = { ok: false, error: r.status === 404 ? 'NO_API' : (r.error || 'ERROR'), detail: sd.errDetail(r) }; out.message = sd.explain(out, { base }); return out; }
  const out = r.json && r.json.image ? String(r.json.image).replace(/^data:image\/\w+;base64,/, '') : '';
  if (!out) return err('NO_IMAGE', 'The server answered but sent no upscaled picture.');
  return { ok: true, images: [out], info: (r.json && r.json.html_info) || '', payload: Object.assign({}, body, { image: '[image]' }) };
}

// What this WebUI has: ControlNet / ADetailer extensions, schema, …
async function a1111Features(base) {
  const oa = await openapi(base);
  const has = (p) => !!(oa && oa.paths && oa.paths[p]);
  let controlnet = has('/controlnet/model_list'); let adetailer = has('/adetailer/v1/ad_model');
  if (!oa) {
    const [c, a] = await Promise.all([sd.getJson(`${base}/controlnet/model_list`, 4000), sd.getJson(`${base}/adetailer/v1/ad_model`, 4000)]);
    controlnet = c.ok; adetailer = a.ok;
  }
  return { openapi: !!oa, controlnet, adetailer, extras: oa ? has('/sdapi/v1/extra-single-image') : true, skip: oa ? has('/sdapi/v1/skip') : true, memory: oa ? has('/sdapi/v1/memory') : true, styles: oa ? has('/sdapi/v1/prompt-styles') : true, scripts: oa ? has('/sdapi/v1/scripts') : true };
}

// Check every name / field of a request against the server BEFORE sending it.
// → { ok:true, warnings } | { ok:false, code, field, message, hint }
async function a1111Check(base, p, kind = 'txt2img') {
  const warnings = [];
  const ci = (list, v) => list.some((x) => String(x).toLowerCase() === String(v).toLowerCase() || String(x).replace(/\s*\[[0-9a-f]+\]$/i, '').toLowerCase() === String(v).toLowerCase());
  const bad = (field, v, list, what) => err('UNKNOWN_VALUE', `There is no ${what} “${v}” on this server.`, { field, hint: list.length ? `Choose one of: ${list.slice(0, 15).join(', ')}${list.length > 15 ? ', …' : ''}` : '' });
  if (p.extra) {
    const s = await payloadSchema(base, kind);
    if (s.ok) { const v = P.validateFields(s.properties, p.extra, kind); if (!v.ok) return v; }
    else warnings.push({ level: 'soft', message: 'Extra fields were sent without checking (the server has no /openapi.json).' });
  }
  if (p.overrideSettings) {
    const cur = await options(base);
    if (cur.ok) { const v = P.validateOptions(cur.options, p.overrideSettings, { schema: await optionsSchema(base), lists: await a1111ListsFor(base, Object.keys(p.overrideSettings)) }); if (!v.ok) return Object.assign(v, { field: `overrideSettings.${v.field}` }); }
  }
  if (p.hires && p.hires.upscaler) { const u = await upscalers(base); if (u.ok && u.all.length && !ci(u.all, p.hires.upscaler)) return bad('hires.upscaler', p.hires.upscaler, u.all, 'upscaler'); }
  if ((p.refiner && p.refiner.checkpoint) || (p.hires && p.hires.checkpoint)) {
    const r = await sd.getJson(`${base}/sdapi/v1/sd-models`, 8000);
    const list = r.ok && Array.isArray(r.json) ? r.json.flatMap((m) => [m.title, m.model_name]).filter(Boolean) : [];
    if (list.length && p.refiner && p.refiner.checkpoint && !ci(list, p.refiner.checkpoint)) return bad('refiner.checkpoint', p.refiner.checkpoint, list, 'checkpoint');
    if (list.length && p.hires && p.hires.checkpoint && !ci(list, p.hires.checkpoint)) return bad('hires.checkpoint', p.hires.checkpoint, list, 'checkpoint');
  }
  if (p.styles) { const s = await styles(base); if (s.ok) { const l = s.styles.map((x) => x.name); for (const st of p.styles) if (!l.includes(st)) return bad('styles', st, l, 'style'); } }
  if (p.script) {
    const s = await scripts(base);
    if (s.ok) { const l = kind === 'img2img' ? s.img2img : s.txt2img; if (!ci(l, p.script.name)) return bad('script.name', p.script.name, l, `${kind} script`); }
  }
  if (p.controlnet) {
    const [m, mo] = await Promise.all([controlnetModels(base), controlnetModules(base)]);
    if (!m.ok) return m.code === 'UNSUPPORTED_ON_BACKEND' ? Object.assign(m, { field: 'controlnet' }) : m;
    for (let i = 0; i < p.controlnet.length; i++) {
      const u = p.controlnet[i];
      if (u.model && !/^none$/i.test(u.model) && m.models.length && !ci(m.models, u.model)) return bad(`controlnet[${i}].model`, u.model, m.models, 'ControlNet model');
      if (u.module && mo.ok && mo.modules.length && !ci(mo.modules, u.module)) return bad(`controlnet[${i}].module`, u.module, mo.modules, 'ControlNet preprocessor');
    }
  }
  if (p.adetailer) {
    const m = await adetailerModels(base);
    if (!m.ok) return m.code === 'UNSUPPORTED_ON_BACKEND' ? Object.assign(m, { field: 'adetailer' }) : m;
    for (let i = 0; i < p.adetailer.length; i++) if (p.adetailer[i].model && m.models.length && !ci(m.models, p.adetailer[i].model)) return bad(`adetailer[${i}].model`, p.adetailer[i].model, m.models, 'ADetailer model');
  }
  return { ok: true, warnings };
}

// ================================================================ ComfyUI
async function comfyObjectInfo(base, node) {
  const r = await sd.getJson(`${base}/object_info${node ? `/${encodeURIComponent(node)}` : ''}`, 30000);
  if (!r.ok || !r.json || typeof r.json !== 'object') return err(r.error || 'ERROR', sd.explain(r, { base }));
  if (node) { const n = r.json[node]; return n ? { ok: true, name: node, node: n } : err('UNKNOWN_VALUE', `ComfyUI has no node type “${node}”.`, { hint: 'sd.comfy.objectInfo() lists them all; custom nodes need ComfyUI Manager.' }); }
  const nodes = Object.entries(r.json).map(([name, n]) => ({ name, display: (n && n.display_name) || name, category: (n && n.category) || '', output: (n && n.output_node) ? 'output' : '' }));
  return { ok: true, count: nodes.length, nodes };
}
async function comfyQueue(base) {
  const r = await sd.getJson(`${base}/queue`, 5000);
  if (!r.ok || !r.json) return err(r.error || 'ERROR', sd.explain(r, { base }));
  const ids = (a) => (a || []).map((e) => (Array.isArray(e) ? e[1] : null)).filter(Boolean);
  return { ok: true, running: (r.json.queue_running || []).length, pending: (r.json.queue_pending || []).length, runningIds: ids(r.json.queue_running), pendingIds: ids(r.json.queue_pending) };
}
async function comfyInterruptAll(base) { const r = await sd.postJson(`${base}/interrupt`, {}, 5000); return r.ok ? { ok: true } : err(r.error, sd.explain(r, { base })); }
async function comfyFree(base, o = {}) { const r = await sd.postJson(`${base}/free`, { unload_models: o.unloadModels !== false, free_memory: o.freeMemory !== false }, 10000); return r.ok ? { ok: true } : err(r.error, sd.explain(r, { base })); }
async function comfyMemory(base) {
  const r = await sd.getJson(`${base}/system_stats`, 5000);
  if (!r.ok || !r.json) return err(r.error || 'ERROR', sd.explain(r, { base }));
  const d = (r.json.devices || [])[0] || {};
  return { ok: true, ram: r.json.system ? { total: r.json.system.ram_total, free: r.json.system.ram_free } : null, vram: d.vram_total != null ? { total: d.vram_total, free: d.vram_free } : null, device: d.name || '', raw: r.json };
}
async function comfyUploadImage(base, image, name) {
  const img = P.loadImage(image, 'image');
  if (img.error) return Object.assign({ ok: false, error: img.error.code }, img.error);
  if (!img.b64) return err('INVALID_PARAM', 'Give the picture to upload (image).');
  return sd.comfyUpload(base, img.b64, name || `autoinjector-${Date.now().toString(36)}.png`);
}
async function comfyUpscale(base, o, opts = {}) {
  const img = P.loadImage(o.image, 'image');
  if (img.error) return Object.assign({ ok: false, error: img.error.code }, img.error);
  if (!img.b64) return err('INVALID_PARAM', 'Give the picture to upscale (image).');
  for (const k of ['width', 'height', 'crop', 'upscaler2', 'upscaler2Visibility', 'gfpgan', 'codeformer', 'codeformerWeight']) {
    if (o[k] != null) return unsupported(`upscale.${k}`, 'comfy', 'The built-in ComfyUI upscale takes an upscaler and a factor. For more, run a saved workflow.');
  }
  const lists = opts.lists || await sd.comfyLists(base);
  if (!lists.ok) return lists;
  let model = '';
  let method = 'lanczos';
  if (o.upscaler && /^(lanczos|bicubic|bilinear|nearest-exact|area)$/i.test(o.upscaler)) method = o.upscaler.toLowerCase();
  else if (o.upscaler) {
    model = sd.resolveName(lists.upscaleModels || [], o.upscaler);
    if (!model || !(lists.upscaleModels || []).includes(model)) return err('UNKNOWN_VALUE', `ComfyUI has no upscale model “${o.upscaler}”.`, { field: 'upscaler', hint: (lists.upscaleModels || []).length ? `Choose one of: ${lists.upscaleModels.join(', ')} (or lanczos / bicubic)` : 'Put an upscale model (e.g. 4x-UltraSharp.pth) into ComfyUI/models/upscale_models, or use "lanczos".' });
  } else if ((lists.upscaleModels || []).length) model = lists.upscaleModels[0];
  const up = await sd.comfyUpload(base, img.b64, `autoinjector-upscale-${Date.now().toString(36)}.png`);
  if (!up.ok) return up;
  const graph = P.buildComfyUpscaleGraph({ imageName: up.name, upscalerModel: model, factor: o.factor || 2, method });
  const r = await sd.comfyRunGraph(base, graph, opts);
  if (!r.ok) return r;
  return { ok: true, images: r.images, workflow: graph, upscaler: model || method };
}

module.exports = {
  clearCache, unsupported, err,
  openapi, payloadSchema, extraFields, options, optionsSchema, setOptions, upscalers, styles, embeddings, scripts,
  controlnetModels, controlnetModules, adetailerModels, interrupt, skip, refresh, memory, a1111Upscale, a1111Features, a1111Check,
  comfyObjectInfo, comfyQueue, comfyInterruptAll, comfyFree, comfyMemory, comfyUploadImage, comfyUpscale,
};
