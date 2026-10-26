'use strict';
/*
 * sd-params.js — every Stable Diffusion setting AutoInjector can send, in ONE place.
 *
 *   • GENERATE_SCHEMA — the structured parameters of images.generate / img2img /
 *     inpaint (JSON-schema). Each property says how it reaches the server:
 *     `x-a1111` = the /sdapi/v1 payload field(s), `x-comfy` = 'yes' | 'partial' |
 *     'no' (+ `x-comfy-note`). capabilities() and the docs' coverage table are
 *     generated from it, so nothing is listed that isn't wired and vice versa.
 *   • normalize(opts)        → { adv, errors } (types, ranges, enums; images
 *                              loaded from base64 / data: URL / a local file path)
 *   • a1111Apply(body, p)    → adds hires fix, refiner, img2img/inpaint, ControlNet,
 *                              ADetailer, styles, scripts, clip skip, … to a payload
 *   • unsupportedOn(backend, p, ctx) → the first setting the backend can't do,
 *                              as { code:'UNSUPPORTED_ON_BACKEND', field, hint }
 *   • buildComfyGraph(p, ctx) → the built-in ComfyUI graph incl. LoRAs, clip skip,
 *                              img2img / inpaint, ControlNet, refiner, hires fix
 *   • validateFields(props, extra) / validateOptions(current, patch, ctx) — the
 *                              pass-through checks against the server's own schema
 *   • openapiRequestSchema(openapi, path) — the payload schema out of /openapi.json
 *
 * Pure (no network); sd-backends.js / sd-control.js do the talking.
 */
const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------------ helpers
const T = {
  str: (d, extra) => Object.assign({ type: 'string', description: d }, extra || {}),
  int: (d, min, max, extra) => Object.assign({ type: 'integer', description: d }, min != null ? { minimum: min } : {}, max != null ? { maximum: max } : {}, extra || {}),
  num: (d, min, max, extra) => Object.assign({ type: 'number', description: d }, min != null ? { minimum: min } : {}, max != null ? { maximum: max } : {}, extra || {}),
  bool: (d, extra) => Object.assign({ type: 'boolean', description: d }, extra || {}),
  obj: (d, props, extra) => Object.assign({ type: 'object', description: d, properties: props || {}, additionalProperties: false }, extra || {}),
  arr: (d, items, extra) => Object.assign({ type: 'array', description: d, items }, extra || {}),
  img: (d) => ({ type: 'string', format: 'image', description: `${d} — base64 PNG/JPEG, a data: URL, or the path of a picture file on this PC (e.g. one from the gallery)` }),
};

const RESIZE_MODES = ['just resize', 'crop and resize', 'resize and fill', 'just resize (latent upscale)'];
const INPAINT_FILL = ['fill', 'original', 'latent noise', 'latent nothing'];
const CN_CONTROL_MODES = ['Balanced', 'My prompt is more important', 'ControlNet is more important'];
const CN_RESIZE_MODES = ['Just Resize', 'Crop and Resize', 'Resize and Fill'];
const PURPOSES = ['portrait', 'cover', 'scene', 'illustration', 'test', 'free', 'view', 'sheet'];
const ENGINES = ['auto', 'sd', 'chatgpt'];
const VIEWS = ['front', 'three_quarter_front', 'side', 'three_quarter_back', 'back', 'idle', 'draw', 'attack', 'dash', 'defend'];

// ------------------------------------------------------------------ the schema
const LORA = T.obj('A LoRA to apply', { name: T.str('LoRA name (as listed by the SD app / library)'), weight: T.num('Strength, usually 0.3–1', -5, 5) });
const CN_UNIT = T.obj('One ControlNet unit', {
  enabled: T.bool('Default true'),
  image: T.img('Control image (omit in img2img to use the init image)'),
  mask: T.img('Optional mask for this unit (A1111 only)'),
  module: T.str('Preprocessor, e.g. "canny", "depth_midas", "openpose", "none" (list: sd.controlnet.modules())'),
  model: T.str('ControlNet model (list: sd.controlnet.models())'),
  weight: T.num('Control weight', 0, 2),
  guidanceStart: T.num('Starting control step (0–1)', 0, 1),
  guidanceEnd: T.num('Ending control step (0–1)', 0, 1),
  controlMode: T.str('Control mode', { enum: CN_CONTROL_MODES }),
  pixelPerfect: T.bool('Pick the preprocessor resolution from the picture size'),
  resizeMode: T.str('How the control image is fitted', { enum: CN_RESIZE_MODES }),
  processorRes: T.int('Preprocessor resolution', 64, 4096),
  thresholdA: T.num('Preprocessor threshold A (e.g. canny low)'),
  thresholdB: T.num('Preprocessor threshold B (e.g. canny high)'),
  lowvram: T.bool('Low VRAM mode for this unit'),
});
const AD_UNIT = T.obj('One ADetailer pass (face / hand / person fix after the picture is made)', {
  enabled: T.bool('Default true'),
  model: T.str('Detector, e.g. "face_yolov8n.pt", "hand_yolov8n.pt" (list: sd.adetailer.models())'),
  prompt: T.str('Prompt for the detected area ("" = the main prompt)'),
  negativePrompt: T.str('Negative prompt for the detected area'),
  confidence: T.num('Detection confidence threshold', 0, 1),
  denoise: T.num('Inpaint denoising strength', 0, 1),
  maskBlur: T.int('Mask blur', 0, 64),
  inpaintOnlyMasked: T.bool('Inpaint only the masked area'),
  inpaintPadding: T.int('Padding around it (px)', 0, 256),
  steps: T.int('Separate steps for the fix (0 = same as main)', 0, 150),
  cfgScale: T.num('Separate CFG for the fix', 0, 30),
});

const GENERATE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    prompt: Object.assign(T.str('What to draw. <lora:name:w> tags work on both backends'), { 'x-a1111': ['prompt'], 'x-comfy': 'yes' }),
    negativePrompt: Object.assign(T.str('What to avoid'), { 'x-a1111': ['negative_prompt'], 'x-comfy': 'yes' }),
    characterLock: Object.assign(T.str('A character lock id or name (same face every time)'), { 'x-a1111': [], 'x-comfy': 'yes' }),
    keepSeed: Object.assign(T.bool('false = ignore the character lock\'s seed'), { 'x-a1111': [], 'x-comfy': 'yes' }),
    purpose: Object.assign(T.str('Picks a size when none is given; "view" = one full-body reference view (needs view), "sheet" = one turnaround sheet with all ten views', { enum: PURPOSES }), { 'x-a1111': [], 'x-comfy': 'yes' }),
    engine: Object.assign(T.str('"sd" = Stable Diffusion, "chatgpt" = ChatGPT\'s own image generation in its logged-in pane, "auto" = SD when connected, else ChatGPT', { enum: ENGINES }), { 'x-a1111': [], 'x-comfy': 'yes' }),
    view: Object.assign(T.str('Which reference view (with purpose "view"); AutoInjector adds the framing words', { enum: VIEWS }), { 'x-a1111': [], 'x-comfy': 'yes' }),
    appearance: Object.assign(T.str('What the character looks like, in words (instead of / besides a character lock)'), { 'x-a1111': [], 'x-comfy': 'yes' }),
    newChat: Object.assign(T.bool('ChatGPT engine: start a fresh ChatGPT chat for this picture'), { 'x-a1111': [], 'x-comfy': 'yes' }),
    series: Object.assign(T.str('ChatGPT engine: a name for a view series (with the "fresh chat per series" setting, a new series opens a new chat)'), { 'x-a1111': [], 'x-comfy': 'yes' }),
    loras: Object.assign(T.arr('LoRAs', LORA), { 'x-a1111': ['prompt'], 'x-comfy': 'yes', 'x-comfy-note': 'LoraLoader chain' }),
    checkpoint: Object.assign(T.str('Checkpoint (model) for this picture'), { 'x-a1111': ['override_settings.sd_model_checkpoint'], 'x-comfy': 'yes' }),
    vae: Object.assign(T.str('VAE ("Automatic" = the model\'s own)'), { 'x-a1111': ['override_settings.sd_vae'], 'x-comfy': 'yes', 'x-comfy-note': 'VAELoader' }),
    sampler: Object.assign(T.str('Sampler, e.g. "DPM++ 2M", "Euler a"'), { 'x-a1111': ['sampler_name', 'sampler_index'], 'x-comfy': 'yes', 'x-comfy-note': 'mapped to ComfyUI names' }),
    scheduler: Object.assign(T.str('Schedule type, e.g. "Karras"'), { 'x-a1111': ['scheduler'], 'x-comfy': 'yes' }),
    steps: Object.assign(T.int('Sampling steps', 1, 150), { 'x-a1111': ['steps'], 'x-comfy': 'yes' }),
    cfgScale: Object.assign(T.num('CFG scale (prompt adherence)', 0, 30), { 'x-a1111': ['cfg_scale'], 'x-comfy': 'yes' }),
    width: Object.assign(T.int('Width in px (multiple of 8)', 64, 4096), { 'x-a1111': ['width'], 'x-comfy': 'yes' }),
    height: Object.assign(T.int('Height in px (multiple of 8)', 64, 4096), { 'x-a1111': ['height'], 'x-comfy': 'yes' }),
    seed: Object.assign(T.int('Seed; -1 = random', -1), { 'x-a1111': ['seed'], 'x-comfy': 'yes' }),
    count: Object.assign(T.int('Pictures per pass (alias of batchSize)', 1, 8), { 'x-a1111': ['batch_size'], 'x-comfy': 'yes' }),
    batchSize: Object.assign(T.int('Pictures per pass', 1, 8), { 'x-a1111': ['batch_size'], 'x-comfy': 'yes' }),
    batchCount: Object.assign(T.int('How many passes', 1, 100), { 'x-a1111': ['n_iter'], 'x-comfy': 'no', 'x-comfy-note': 'use batchSize' }),
    variation: Object.assign(T.obj('Variation seed', { subseed: T.int('Variation seed (-1 = random)', -1), strength: T.num('Variation strength', 0, 1), resizeFromW: T.int('Resize seed from width', 0, 4096), resizeFromH: T.int('Resize seed from height', 0, 4096) }),
      { 'x-a1111': ['subseed', 'subseed_strength', 'seed_resize_from_w', 'seed_resize_from_h'], 'x-comfy': 'no' }),
    clipSkip: Object.assign(T.int('CLIP skip (1 = off, 2 = common for anime models)', 1, 12), { 'x-a1111': ['override_settings.CLIP_stop_at_last_layers'], 'x-comfy': 'yes', 'x-comfy-note': 'CLIPSetLastLayer' }),
    restoreFaces: Object.assign(T.bool('Restore faces (GFPGAN/CodeFormer)'), { 'x-a1111': ['restore_faces'], 'x-comfy': 'no', 'x-comfy-note': 'use a workflow with a face-restore node' }),
    tiling: Object.assign(T.bool('Seamless tiling'), { 'x-a1111': ['tiling'], 'x-comfy': 'no' }),
    styles: Object.assign(T.arr('Saved prompt styles (list: sd.styles())', T.str('style name')), { 'x-a1111': ['styles'], 'x-comfy': 'no' }),
    hires: Object.assign(T.obj('Hires fix: render small, upscale, then refine', {
      enable: T.bool('Default true when hires is given'),
      scale: T.num('Upscale by', 1, 4), upscaler: T.str('Upscaler, e.g. "Latent", "R-ESRGAN 4x+", "4x-UltraSharp" (list: sd.upscalers())'),
      secondPassSteps: T.int('Hires steps (0 = same as steps)', 0, 150), denoise: T.num('Denoising strength', 0, 1),
      resizeX: T.int('Resize width to (0 = use scale)', 0, 8192), resizeY: T.int('Resize height to (0 = use scale)', 0, 8192),
      sampler: T.str('Hires sampler (default: same)'), scheduler: T.str('Hires schedule type (default: same)'),
      checkpoint: T.str('Hires checkpoint (A1111/Forge only)'), prompt: T.str('Hires prompt (A1111 only)'), negativePrompt: T.str('Hires negative prompt (A1111 only)'),
      cfgScale: T.num('Hires CFG (Forge only)', 0, 30),
    }), { 'x-a1111': ['enable_hr', 'hr_scale', 'hr_upscaler', 'hr_second_pass_steps', 'denoising_strength', 'hr_resize_x', 'hr_resize_y', 'hr_sampler_name', 'hr_scheduler', 'hr_checkpoint_name', 'hr_prompt', 'hr_negative_prompt', 'hr_cfg'],
      'x-comfy': 'partial', 'x-comfy-note': 'LatentUpscale or UpscaleModelLoader + 2nd KSampler; no hires checkpoint/prompt' }),
    refiner: Object.assign(T.obj('SDXL refiner', { checkpoint: T.str('Refiner checkpoint'), switchAt: T.num('Switch at (fraction of steps)', 0.01, 1) }),
      { 'x-a1111': ['refiner_checkpoint', 'refiner_switch_at'], 'x-comfy': 'yes', 'x-comfy-note': 'two KSamplerAdvanced' }),
    initImage: Object.assign(T.img('img2img start picture'), { 'x-a1111': ['init_images'], 'x-comfy': 'yes', 'x-comfy-note': 'uploaded, LoadImage → VAEEncode' }),
    denoise: Object.assign(T.num('img2img denoising strength (how much changes)', 0, 1), { 'x-a1111': ['denoising_strength'], 'x-comfy': 'yes' }),
    resizeMode: Object.assign(T.str('How the init picture is fitted', { enum: RESIZE_MODES }), { 'x-a1111': ['resize_mode'], 'x-comfy': 'partial', 'x-comfy-note': '"crop and resize" crops; others stretch' }),
    imageCfgScale: Object.assign(T.num('Image CFG (instruct-pix2pix models)', 0, 30), { 'x-a1111': ['image_cfg_scale'], 'x-comfy': 'no' }),
    mask: Object.assign(T.img('Inpaint mask: white = repaint, black = keep'), { 'x-a1111': ['mask'], 'x-comfy': 'yes', 'x-comfy-note': 'LoadImageMask' }),
    inpaint: Object.assign(T.obj('Inpaint options (with mask)', {
      maskBlur: T.int('Mask blur', 0, 64), fill: T.str('Masked content', { enum: INPAINT_FILL }),
      onlyMasked: T.bool('Inpaint area: only masked (full-res)'), padding: T.int('Only-masked padding (px)', 0, 256),
      invertMask: T.bool('Repaint what is NOT masked'),
    }), { 'x-a1111': ['mask_blur', 'inpainting_fill', 'inpaint_full_res', 'inpaint_full_res_padding', 'inpainting_mask_invert'],
      'x-comfy': 'partial', 'x-comfy-note': 'fill original → SetLatentNoiseMask, else VAEEncodeForInpaint (maskBlur → grow_mask_by); invert → InvertMask; no only-masked' }),
    controlnet: Object.assign(T.arr('ControlNet units', CN_UNIT), { 'x-a1111': ['alwayson_scripts.controlnet'], 'x-comfy': 'partial', 'x-comfy-note': 'ControlNetLoader + ControlNetApplyAdvanced; preprocessors need comfyui_controlnet_aux (AIO_Preprocessor); control mode not available' }),
    adetailer: Object.assign(T.arr('ADetailer passes (needs the ADetailer extension)', AD_UNIT), { 'x-a1111': ['alwayson_scripts.ADetailer'], 'x-comfy': 'no', 'x-comfy-note': 'use a saved workflow with FaceDetailer (Impact Pack)' }),
    script: Object.assign(T.obj('Run a script (list: sd.scripts())', { name: T.str('Script name, e.g. "X/Y/Z plot"'), args: T.arr('Its arguments, in the order the script expects (sd.scripts() shows them)', {}) }),
      { 'x-a1111': ['script_name', 'script_args'], 'x-comfy': 'no' }),
    alwaysonScripts: Object.assign({ type: 'object', description: 'Raw alwayson_scripts for any extension: { "<extension>": { "args": [...] } }', additionalProperties: true }, { 'x-a1111': ['alwayson_scripts'], 'x-comfy': 'no' }),
    overrideSettings: Object.assign({ type: 'object', description: 'Any settings-menu option, for this picture only (keys: sd.options.get())', additionalProperties: true }, { 'x-a1111': ['override_settings', 'override_settings_restore_afterwards'], 'x-comfy': 'no' }),
    extra: Object.assign({ type: 'object', description: 'Any other txt2img/img2img payload field, checked against the server\'s /openapi.json (list: sd.extraFields())', additionalProperties: true }, { 'x-a1111': ['*'], 'x-comfy': 'no', 'x-comfy-note': 'run a workflow instead (sd.workflows.run)' }),
    book: Object.assign(T.str('Book title, recorded with the picture'), { 'x-a1111': [], 'x-comfy': 'yes' }),
    from: Object.assign(T.str('Who asked (recorded)'), { 'x-a1111': [], 'x-comfy': 'yes' }),
    returnImage: Object.assign(T.bool('Also return base64'), { 'x-a1111': [], 'x-comfy': 'yes' }),
  },
};
// Payload fields the app always sets itself (still overridable via `extra`).
const A1111_INTERNAL = ['send_images', 'save_images'];

const UPSCALE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['image'],
  properties: {
    image: T.img('Picture to upscale'),
    upscaler: T.str('Upscaler (list: sd.upscalers()); A1111 e.g. "R-ESRGAN 4x+", ComfyUI an upscale model file'),
    factor: T.num('Upscale by (default 2)', 1, 8),
    width: T.int('Target width instead of factor (A1111)', 64, 8192), height: T.int('Target height (A1111)', 64, 8192), crop: T.bool('Crop to fit (A1111)'),
    upscaler2: T.str('Second upscaler (A1111)'), upscaler2Visibility: T.num('Second upscaler visibility (A1111)', 0, 1),
    gfpgan: T.num('GFPGAN face restore visibility (A1111)', 0, 1), codeformer: T.num('CodeFormer visibility (A1111)', 0, 1), codeformerWeight: T.num('CodeFormer weight (A1111)', 0, 1),
    from: T.str('Who asked (recorded)'),
  },
};

// ------------------------------------------------------------------ images
const IMG_EXT = /\.(png|jpe?g|webp|bmp)$/i;
// base64 | data: URL | file:// URL | local path → { b64 } | { error }
function loadImage(v, field) {
  if (v == null || v === '') return { b64: null };
  if (typeof v !== 'string') return { error: { code: 'INVALID_PARAM', field, message: `${field} must be a picture: base64, a data: URL or a file path.` } };
  let s = v.trim();
  const m = s.match(/^data:image\/[\w.+-]+;base64,(.*)$/s);
  if (m) return { b64: m[1].replace(/\s+/g, '') };
  if (/^file:\/\//i.test(s)) { try { s = decodeURIComponent(new URL(s).pathname).replace(/^\/([A-Za-z]:)/, '$1'); } catch { /* fall through */ } }
  if (s.length < 1024 && IMG_EXT.test(s)) { // base64 never contains a dot, so this is a file path
    try {
      const st = fs.statSync(s);
      if (!st.isFile()) throw new Error('not a file');
      if (st.size > 64 * 1024 * 1024) return { error: { code: 'INVALID_PARAM', field, message: `${field}: that picture is too big (over 64 MB).` } };
      return { b64: fs.readFileSync(s).toString('base64'), file: path.resolve(s) };
    } catch { return { error: { code: 'INVALID_PARAM', field, message: `${field}: there is no picture file at “${s}”.` } }; }
  }
  const clean = s.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+=*$/.test(clean) || clean.length < 16) return { error: { code: 'INVALID_PARAM', field, message: `${field} must be a picture: base64, a data: URL or the path of a .png/.jpg/.webp file.` } };
  return { b64: clean };
}

// ------------------------------------------------------------------ normalize
function _isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function _checkType(spec, v) {
  if (v === undefined) return true;
  switch (spec.type) {
    case 'integer': return Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'string': return typeof v === 'string';
    case 'array': return Array.isArray(v);
    case 'object': return _isObj(v);
    default: return true;
  }
}
function _coerce(spec, v) {
  if (v === undefined || v === null || v === '') return undefined;
  if ((spec.type === 'integer' || spec.type === 'number') && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) v = Number(v);
  if (spec.type === 'integer' && typeof v === 'number' && Number.isFinite(v) && !Number.isInteger(v)) v = Math.round(v);
  if (spec.type === 'boolean' && (v === 'true' || v === 'false')) v = v === 'true';
  return v;
}
// Validate a value against a (small) schema; returns [value, errors].
function checkValue(spec, v, field, errors) {
  v = _coerce(spec, v);
  if (v === undefined) return undefined;
  if (!_checkType(spec, v)) { errors.push({ code: 'INVALID_PARAM', field, message: `${field} must be ${spec.type === 'integer' ? 'a whole number' : `a ${spec.type}`}.` }); return undefined; }
  if (spec.enum) {
    const hit = spec.enum.find((e) => String(e).toLowerCase() === String(v).toLowerCase());
    if (hit == null) { errors.push({ code: 'INVALID_PARAM', field, message: `${field} must be one of: ${spec.enum.join(', ')}.` }); return undefined; }
    v = hit;
  }
  if (typeof v === 'number') {
    if (spec.minimum != null && v < spec.minimum) { errors.push({ code: 'INVALID_PARAM', field, message: `${field} must be at least ${spec.minimum}.` }); return undefined; }
    if (spec.maximum != null && v > spec.maximum) { errors.push({ code: 'INVALID_PARAM', field, message: `${field} must be at most ${spec.maximum}.` }); return undefined; }
  }
  if (spec.type === 'object' && spec.properties && spec.additionalProperties === false) {
    const out = {};
    for (const k of Object.keys(v)) {
      if (v[k] === undefined) continue;
      if (!spec.properties[k]) { errors.push({ code: 'INVALID_PARAM', field: `${field}.${k}`, message: `${field} has no setting “${k}”. Known: ${Object.keys(spec.properties).join(', ')}.` }); continue; }
      const r = spec.properties[k].format === 'image' ? v[k] : checkValue(spec.properties[k], v[k], `${field}.${k}`, errors);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  if (spec.type === 'array' && spec.items && spec.items.type) return v.map((x, i) => checkValue(spec.items, x, `${field}[${i}]`, errors)).filter((x) => x !== undefined);
  return v;
}

const ADV_KEYS = ['variation', 'clipSkip', 'restoreFaces', 'tiling', 'styles', 'hires', 'refiner', 'initImage', 'denoise', 'resizeMode', 'imageCfgScale', 'mask', 'inpaint', 'controlnet', 'adetailer', 'script', 'alwaysonScripts', 'overrideSettings', 'extra'];

// The advanced part of a request → { adv, errors }. Images are loaded to base64.
function normalize(opts) {
  const o = opts || {};
  const errors = [];
  const adv = {};
  for (const k of ADV_KEYS) {
    if (o[k] === undefined || o[k] === null || o[k] === '') continue;
    const spec = GENERATE_SCHEMA.properties[k];
    if (spec.format === 'image') {
      const r = loadImage(o[k], k);
      if (r.error) errors.push(r.error); else if (r.b64) adv[k] = r.b64;
      continue;
    }
    if (k === 'alwaysonScripts' || k === 'overrideSettings' || k === 'extra') {
      if (!_isObj(o[k])) { errors.push({ code: 'INVALID_PARAM', field: k, message: `${k} must be an object ({ "field": value }).` }); continue; }
      if (Object.keys(o[k]).length) adv[k] = Object.assign({}, o[k]);
      continue;
    }
    const v = checkValue(spec, o[k], k, errors);
    if (v !== undefined) adv[k] = v;
  }
  // Images inside ControlNet units.
  if (Array.isArray(adv.controlnet)) {
    adv.controlnet = adv.controlnet.map((u, i) => {
      const out = Object.assign({}, u);
      for (const f of ['image', 'mask']) {
        if (u[f] == null || u[f] === '') { delete out[f]; continue; }
        const r = loadImage(u[f], `controlnet[${i}].${f}`);
        if (r.error) errors.push(r.error); else out[f] = r.b64;
      }
      return out;
    }).filter((u) => u.enabled !== false);
    if (!adv.controlnet.length) delete adv.controlnet;
  }
  if (Array.isArray(adv.adetailer)) { adv.adetailer = adv.adetailer.filter((u) => u.enabled !== false); if (!adv.adetailer.length) delete adv.adetailer; }
  if (adv.hires && adv.hires.enable === false) delete adv.hires;
  if (adv.refiner && !adv.refiner.checkpoint) delete adv.refiner;
  if (adv.styles && !adv.styles.length) delete adv.styles;
  if (adv.script && !adv.script.name) delete adv.script;
  if (adv.mask && !adv.initImage) errors.push({ code: 'INVALID_PARAM', field: 'mask', message: 'A mask needs an initImage (the picture to repaint).' });
  if (Array.isArray(adv.controlnet)) adv.controlnet.forEach((u, i) => { if (!u.image && !adv.initImage) errors.push({ code: 'INVALID_PARAM', field: `controlnet[${i}].image`, message: `ControlNet unit ${i + 1} needs a control image.` }); });
  return { adv, errors };
}

// ------------------------------------------------------------------ A1111 payload
function _round8(n) { return Math.max(8, Math.round(Number(n) / 8) * 8); }
function cnUnitA1111(u) {
  const x = { enabled: true, module: u.module || 'none', model: u.model || 'None', weight: u.weight != null ? u.weight : 1,
    guidance_start: u.guidanceStart != null ? u.guidanceStart : 0, guidance_end: u.guidanceEnd != null ? u.guidanceEnd : 1,
    control_mode: u.controlMode || 'Balanced', pixel_perfect: !!u.pixelPerfect, resize_mode: u.resizeMode || 'Crop and Resize' };
  if (u.image) x.image = u.image;
  if (u.mask) x.mask = u.mask;
  if (u.processorRes != null) x.processor_res = u.processorRes;
  if (u.thresholdA != null) x.threshold_a = u.thresholdA;
  if (u.thresholdB != null) x.threshold_b = u.thresholdB;
  if (u.lowvram != null) x.lowvram = !!u.lowvram;
  return x;
}
function adUnitA1111(u) {
  const x = { ad_model: u.model || 'face_yolov8n.pt' };
  const map = { prompt: 'ad_prompt', negativePrompt: 'ad_negative_prompt', confidence: 'ad_confidence', denoise: 'ad_denoising_strength', maskBlur: 'ad_mask_blur', inpaintOnlyMasked: 'ad_inpaint_only_masked', inpaintPadding: 'ad_inpaint_only_masked_padding' };
  for (const [k, f] of Object.entries(map)) if (u[k] != null) x[f] = u[k];
  if (u.steps) { x.ad_use_steps = true; x.ad_steps = u.steps; }
  if (u.cfgScale) { x.ad_use_cfg_scale = true; x.ad_cfg_scale = u.cfgScale; }
  return x;
}
// Add every advanced setting of p to an A1111 txt2img/img2img body (mutates + returns it).
function a1111Apply(body, p) {
  const ov = Object.assign({}, body.override_settings || {});
  if (p.variation) {
    const v = p.variation;
    if (v.subseed != null) body.subseed = v.subseed;
    if (v.strength != null) body.subseed_strength = v.strength;
    if (v.resizeFromW != null) body.seed_resize_from_w = v.resizeFromW;
    if (v.resizeFromH != null) body.seed_resize_from_h = v.resizeFromH;
  }
  if (p.clipSkip != null) ov.CLIP_stop_at_last_layers = p.clipSkip;
  if (p.restoreFaces != null) body.restore_faces = !!p.restoreFaces;
  if (p.tiling != null) body.tiling = !!p.tiling;
  if (p.styles) body.styles = p.styles.slice();
  if (p.hires && !p.initImage) {
    const h = p.hires;
    body.enable_hr = true;
    body.hr_scale = h.scale != null ? h.scale : 2;
    body.hr_upscaler = h.upscaler || 'Latent';
    body.hr_second_pass_steps = h.secondPassSteps != null ? h.secondPassSteps : 0;
    body.denoising_strength = h.denoise != null ? h.denoise : 0.5;
    if (h.resizeX) body.hr_resize_x = h.resizeX;
    if (h.resizeY) body.hr_resize_y = h.resizeY;
    if (h.sampler) body.hr_sampler_name = h.sampler;
    if (h.scheduler) body.hr_scheduler = h.scheduler;
    if (h.checkpoint) body.hr_checkpoint_name = h.checkpoint;
    if (h.prompt != null) body.hr_prompt = h.prompt;
    if (h.negativePrompt != null) body.hr_negative_prompt = h.negativePrompt;
    if (h.cfgScale != null) body.hr_cfg = h.cfgScale;
  }
  if (p.refiner && p.refiner.checkpoint) { body.refiner_checkpoint = p.refiner.checkpoint; body.refiner_switch_at = p.refiner.switchAt != null ? p.refiner.switchAt : 0.8; }
  if (p.initImage) {
    body.init_images = [p.initImage];
    body.denoising_strength = p.denoise != null ? p.denoise : 0.6;
    if (p.resizeMode) body.resize_mode = RESIZE_MODES.indexOf(p.resizeMode);
    if (p.imageCfgScale != null) body.image_cfg_scale = p.imageCfgScale;
    if (p.mask) {
      const ip = p.inpaint || {};
      body.mask = p.mask;
      body.mask_blur = ip.maskBlur != null ? ip.maskBlur : 4;
      body.inpainting_fill = INPAINT_FILL.indexOf(ip.fill || 'original');
      body.inpaint_full_res = !!ip.onlyMasked;
      body.inpaint_full_res_padding = ip.padding != null ? ip.padding : 32;
      body.inpainting_mask_invert = ip.invertMask ? 1 : 0;
    }
  }
  if (p.script) { body.script_name = p.script.name; body.script_args = Array.isArray(p.script.args) ? p.script.args : []; }
  const ao = Object.assign({}, body.alwayson_scripts || {}, p.alwaysonScripts || {});
  if (p.controlnet && p.controlnet.length) ao.controlnet = { args: p.controlnet.map(cnUnitA1111) };
  if (p.adetailer && p.adetailer.length) ao.ADetailer = { args: [true, false, ...p.adetailer.map(adUnitA1111)] };
  if (Object.keys(ao).length) body.alwayson_scripts = ao;
  if (p.overrideSettings) Object.assign(ov, p.overrideSettings);
  if (Object.keys(ov).length) { body.override_settings = ov; if (body.override_settings_restore_afterwards == null) body.override_settings_restore_afterwards = true; }
  if (p.extra) Object.assign(body, p.extra);
  return body;
}

// ------------------------------------------------------------------ backend support
function _unsup(field, backend, hint) {
  const name = backend === 'comfy' ? 'ComfyUI' : 'this WebUI';
  return { ok: false, error: 'UNSUPPORTED_ON_BACKEND', code: 'UNSUPPORTED_ON_BACKEND', field, backend,
    message: `“${field}” isn't available on ${name}.`, hint };
}
const COMFY_WF_HINT = 'Build it in ComfyUI, export it with “Save (API Format)”, then run it with sd.workflows.run (🎨 Images → ComfyUI workflow).';
// ctx (comfy): { nodes: Set of node class names from /object_info } (optional)
function unsupportedOn(backend, p, ctx = {}) {
  if (backend === 'comfy') {
    const has = (n) => !ctx.nodes || ctx.nodes.has(n);
    if (p.variation) return _unsup('variation', backend, `Variation seeds need A1111/Forge. ${COMFY_WF_HINT}`);
    if (p.restoreFaces) return _unsup('restoreFaces', backend, `Face restore needs A1111/Forge, or a workflow with a face-restore node. ${COMFY_WF_HINT}`);
    if (p.tiling) return _unsup('tiling', backend, `Seamless tiling needs A1111/Forge. ${COMFY_WF_HINT}`);
    if (p.styles) return _unsup('styles', backend, 'Prompt styles are stored in A1111/Forge; on ComfyUI put the style words into the prompt.');
    if (p.script) return _unsup('script', backend, `Scripts are an A1111/Forge feature. ${COMFY_WF_HINT}`);
    if (p.alwaysonScripts) return _unsup('alwaysonScripts', backend, `Extensions are A1111/Forge features. ${COMFY_WF_HINT}`);
    if (p.overrideSettings) return _unsup('overrideSettings', backend, 'ComfyUI has no settings menu to override.');
    if (p.extra) return _unsup('extra', backend, `ComfyUI takes a workflow, not txt2img fields. ${COMFY_WF_HINT}`);
    if (p.adetailer) return _unsup('adetailer', backend, `ADetailer is an A1111/Forge extension; on ComfyUI use a workflow with FaceDetailer (Impact Pack). ${COMFY_WF_HINT}`);
    if (p.imageCfgScale != null) return _unsup('imageCfgScale', backend, 'Image CFG (instruct-pix2pix) needs A1111/Forge.');
    if (p.batchCount && p.batchCount > 1) return _unsup('batchCount', backend, 'Use batchSize (pictures per pass) on ComfyUI.');
    if (p.hires && (p.hires.checkpoint || p.hires.prompt != null || p.hires.negativePrompt != null || p.hires.cfgScale != null)) return _unsup('hires.checkpoint/prompt/cfgScale', backend, `The built-in ComfyUI graph refines with the same model and prompt. ${COMFY_WF_HINT}`);
    if (p.inpaint && (p.inpaint.onlyMasked || p.inpaint.padding != null)) return _unsup('inpaint.onlyMasked', backend, `“Only masked” inpainting needs A1111/Forge (or a crop-and-stitch workflow). ${COMFY_WF_HINT}`);
    if (p.controlnet) {
      for (let i = 0; i < p.controlnet.length; i++) {
        const u = p.controlnet[i];
        if (u.controlMode && u.controlMode !== 'Balanced') return _unsup(`controlnet[${i}].controlMode`, backend, 'ComfyUI\'s ControlNet nodes have no control mode; leave it on Balanced.');
        if (u.mask) return _unsup(`controlnet[${i}].mask`, backend, 'Per-unit ControlNet masks need A1111/Forge.');
        if (u.module && !/^none$/i.test(u.module) && !has('AIO_Preprocessor')) return _unsup(`controlnet[${i}].module`, backend, `ComfyUI has no built-in preprocessors. Install “comfyui_controlnet_aux” (ComfyUI Manager), or pass an already-processed control image with module "none".`);
      }
      if (!has('ControlNetApplyAdvanced')) return _unsup('controlnet', backend, 'This ComfyUI has no ControlNetApplyAdvanced node (update ComfyUI).');
    }
    if (p.hires && p.hires.upscaler && !/^latent/i.test(p.hires.upscaler) && !has('UpscaleModelLoader')) return _unsup('hires.upscaler', backend, 'This ComfyUI has no UpscaleModelLoader node; use upscaler "Latent".');
    if (p.clipSkip > 1 && !has('CLIPSetLastLayer')) return _unsup('clipSkip', backend, 'This ComfyUI has no CLIPSetLastLayer node.');
  }
  return null;
}

// ------------------------------------------------------------------ ComfyUI graph
const LATENT_METHODS = { latent: 'nearest-exact', 'latent (nearest)': 'nearest-exact', 'latent (nearest-exact)': 'nearest-exact', 'latent (bilinear)': 'bilinear', 'latent (bicubic)': 'bicubic', 'latent (area)': 'area', 'latent (bislerp)': 'bislerp', 'latent (antialiased)': 'bilinear', 'latent (bicubic antialiased)': 'bicubic' };
function latentMethod(name) { return LATENT_METHODS[String(name || 'latent').toLowerCase()] || null; }
function modelScaleOf(name) { const m = String(name || '').match(/(?:^|[^0-9])([1-8])x|x([1-8])(?:[^0-9]|$)/i); return m ? Number(m[1] || m[2]) : 4; }

// p: resolved params (checkpoint/lora/vae names already in ComfyUI's spelling,
//    seed a real number). Uploaded files: p.initImageName, p.maskName,
//    p.controlnet[i].imageName. p.hires.upscalerModel = a model file (else latent).
// toComfySampler: (sampler, scheduler) → { sampler_name, scheduler }.
function buildComfyGraph(p, toComfySampler) {
  const g = {};
  let nid = 200;
  const add = (node) => { const id = String(nid++); g[id] = node; return id; };
  g['4'] = { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: p.checkpoint } };
  let modelRef = ['4', 0], clipRef = ['4', 1];
  let lid = 100;
  for (const l of p.loras || []) {
    const id = String(lid++);
    const w = Number(l.weight); const ww = Number.isFinite(w) ? w : 1;
    g[id] = { class_type: 'LoraLoader', inputs: { lora_name: l.name, strength_model: ww, strength_clip: ww, model: modelRef, clip: clipRef } };
    modelRef = [id, 0]; clipRef = [id, 1];
  }
  if (p.clipSkip > 1) { g['30'] = { class_type: 'CLIPSetLastLayer', inputs: { stop_at_clip_layer: -p.clipSkip, clip: clipRef } }; clipRef = ['30', 0]; }
  g['6'] = { class_type: 'CLIPTextEncode', inputs: { text: String(p.prompt || ''), clip: clipRef } };
  g['7'] = { class_type: 'CLIPTextEncode', inputs: { text: String(p.negativePrompt || ''), clip: clipRef } };
  let pos = ['6', 0], neg = ['7', 0];
  let vaeRef = ['4', 2];
  if (p.vae && !/^(automatic|none|)$/i.test(p.vae)) { g['20'] = { class_type: 'VAELoader', inputs: { vae_name: p.vae } }; vaeRef = ['20', 0]; }
  const W = p.width, H = p.height;
  // ControlNet units → chained ControlNetApplyAdvanced on the conditioning.
  for (const u of p.controlnet || []) {
    let img;
    if (u.imageName) img = [add({ class_type: 'LoadImage', inputs: { image: u.imageName } }), 0];
    else if (p.initImageName) img = [add({ class_type: 'LoadImage', inputs: { image: p.initImageName } }), 0];
    if (u.module && !/^none$/i.test(u.module)) img = [add({ class_type: 'AIO_Preprocessor', inputs: { image: img, preprocessor: u.module, resolution: u.pixelPerfect ? Math.min(W, H) : (u.processorRes || 512) } }), 0];
    const loader = add({ class_type: 'ControlNetLoader', inputs: { control_net_name: u.model } });
    const apply = add({ class_type: 'ControlNetApplyAdvanced', inputs: { positive: pos, negative: neg, control_net: [loader, 0], image: img, strength: u.weight != null ? u.weight : 1, start_percent: u.guidanceStart != null ? u.guidanceStart : 0, end_percent: u.guidanceEnd != null ? u.guidanceEnd : 1 } });
    pos = [apply, 0]; neg = [apply, 1];
  }
  // Starting latent: empty (txt2img) or the encoded init picture (img2img / inpaint).
  let latent;
  let denoise = 1;
  if (p.initImageName) {
    let pix = [add({ class_type: 'LoadImage', inputs: { image: p.initImageName } }), 0];
    pix = [add({ class_type: 'ImageScale', inputs: { image: pix, upscale_method: 'lanczos', width: W, height: H, crop: p.resizeMode === 'crop and resize' ? 'center' : 'disabled' } }), 0];
    if (p.maskName) {
      const ip = p.inpaint || {};
      let mask = [add({ class_type: 'LoadImageMask', inputs: { image: p.maskName, channel: 'red' } }), 0];
      const mi = add({ class_type: 'MaskToImage', inputs: { mask } });
      const ms = add({ class_type: 'ImageScale', inputs: { image: [mi, 0], upscale_method: 'bilinear', width: W, height: H, crop: p.resizeMode === 'crop and resize' ? 'center' : 'disabled' } });
      mask = [add({ class_type: 'ImageToMask', inputs: { image: [ms, 0], channel: 'red' } }), 0];
      if (ip.invertMask) mask = [add({ class_type: 'InvertMask', inputs: { mask } }), 0];
      if ((ip.fill || 'original') === 'original') {
        const enc = add({ class_type: 'VAEEncode', inputs: { pixels: pix, vae: vaeRef } });
        latent = [add({ class_type: 'SetLatentNoiseMask', inputs: { samples: [enc, 0], mask } }), 0];
        denoise = p.denoise != null ? p.denoise : 0.6;
      } else {
        latent = [add({ class_type: 'VAEEncodeForInpaint', inputs: { pixels: pix, vae: vaeRef, mask, grow_mask_by: ip.maskBlur != null ? ip.maskBlur : 6 } }), 0];
        denoise = p.denoise != null ? p.denoise : 1;
      }
    } else {
      latent = [add({ class_type: 'VAEEncode', inputs: { pixels: pix, vae: vaeRef } }), 0];
      denoise = p.denoise != null ? p.denoise : 0.6;
    }
    if ((p.batchSize || 1) > 1) latent = [add({ class_type: 'RepeatLatentBatch', inputs: { samples: latent, amount: p.batchSize } }), 0];
  } else {
    g['5'] = { class_type: 'EmptyLatentImage', inputs: { width: W, height: H, batch_size: p.batchSize || 1 } };
    latent = ['5', 0];
  }
  const smp = toComfySampler(p.sampler, p.scheduler);
  // First pass (with the SDXL refiner: two KSamplerAdvanced split at switchAt).
  if (p.refiner && p.refiner.checkpoint) {
    const steps = p.steps;
    const start = p.initImageName ? Math.round(steps * (1 - denoise)) : 0;
    const sw = Math.max(start + 1, Math.min(steps, Math.round(steps * (p.refiner.switchAt != null ? p.refiner.switchAt : 0.8))));
    g['3'] = { class_type: 'KSamplerAdvanced', inputs: { add_noise: 'enable', noise_seed: p.seed, steps, cfg: p.cfgScale, sampler_name: smp.sampler_name, scheduler: smp.scheduler, start_at_step: start, end_at_step: sw, return_with_leftover_noise: 'enable', model: modelRef, positive: pos, negative: neg, latent_image: latent } };
    g['40'] = { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: p.refiner.checkpoint } };
    g['41'] = { class_type: 'CLIPTextEncode', inputs: { text: String(p.prompt || ''), clip: ['40', 1] } };
    g['42'] = { class_type: 'CLIPTextEncode', inputs: { text: String(p.negativePrompt || ''), clip: ['40', 1] } };
    g['43'] = { class_type: 'KSamplerAdvanced', inputs: { add_noise: 'disable', noise_seed: p.seed, steps, cfg: p.cfgScale, sampler_name: smp.sampler_name, scheduler: smp.scheduler, start_at_step: sw, end_at_step: 10000, return_with_leftover_noise: 'disable', model: ['40', 0], positive: ['41', 0], negative: ['42', 0], latent_image: ['3', 0] } };
    latent = ['43', 0];
  } else {
    g['3'] = { class_type: 'KSampler', inputs: { seed: p.seed, steps: p.steps, cfg: p.cfgScale, sampler_name: smp.sampler_name, scheduler: smp.scheduler, denoise, model: modelRef, positive: pos, negative: neg, latent_image: latent } };
    latent = ['3', 0];
  }
  // Hires fix: upscale (latent or with an upscale model) + a second KSampler.
  if (p.hires && !p.initImageName) {
    const h = p.hires;
    const scale = h.scale != null ? h.scale : 2;
    let tw = h.resizeX || 0, th = h.resizeY || 0;
    if (tw && !th) th = _round8(H * tw / W);
    if (th && !tw) tw = _round8(W * th / H);
    if (!tw) { tw = _round8(W * scale); th = _round8(H * scale); }
    let up;
    if (h.upscalerModel) {
      const dec = add({ class_type: 'VAEDecode', inputs: { samples: latent, vae: vaeRef } });
      const ml = add({ class_type: 'UpscaleModelLoader', inputs: { model_name: h.upscalerModel } });
      const um = add({ class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: [ml, 0], image: [dec, 0] } });
      const sc = add({ class_type: 'ImageScale', inputs: { image: [um, 0], upscale_method: 'lanczos', width: tw, height: th, crop: 'disabled' } });
      up = add({ class_type: 'VAEEncode', inputs: { pixels: [sc, 0], vae: vaeRef } });
    } else {
      up = add({ class_type: 'LatentUpscale', inputs: { samples: latent, upscale_method: latentMethod(h.upscaler) || 'nearest-exact', width: tw, height: th, crop: 'disabled' } });
    }
    const hs = toComfySampler(h.sampler || p.sampler, h.scheduler || p.scheduler);
    const k2 = add({ class_type: 'KSampler', inputs: { seed: p.seed, steps: h.secondPassSteps || p.steps, cfg: p.cfgScale, sampler_name: hs.sampler_name, scheduler: hs.scheduler, denoise: h.denoise != null ? h.denoise : 0.5, model: modelRef, positive: pos, negative: neg, latent_image: [up, 0] } });
    latent = [k2, 0];
  }
  if (p.refiner && p.refiner.checkpoint && !(p.vae && !/^(automatic|none|)$/i.test(p.vae)) && !p.hires) vaeRef = ['40', 2];
  g['8'] = { class_type: 'VAEDecode', inputs: { samples: latent, vae: vaeRef } };
  g['9'] = { class_type: 'SaveImage', inputs: { filename_prefix: 'AutoInjector', images: ['8', 0] } };
  return g;
}

// Standalone upscale graph (ComfyUI): LoadImage → [UpscaleModelLoader + ImageUpscaleWithModel] → [ImageScaleBy] → SaveImage
function buildComfyUpscaleGraph(o) {
  const g = { 1: { class_type: 'LoadImage', inputs: { image: o.imageName } } };
  let img = ['1', 0];
  const factor = o.factor || 2;
  if (o.upscalerModel) {
    g['2'] = { class_type: 'UpscaleModelLoader', inputs: { model_name: o.upscalerModel } };
    g['3'] = { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['2', 0], image: img } };
    img = ['3', 0];
    const ms = modelScaleOf(o.upscalerModel);
    if (Math.abs(factor - ms) > 1e-6) { g['4'] = { class_type: 'ImageScaleBy', inputs: { image: img, upscale_method: 'lanczos', scale_by: Math.round((factor / ms) * 10000) / 10000 } }; img = ['4', 0]; }
  } else {
    g['4'] = { class_type: 'ImageScaleBy', inputs: { image: img, upscale_method: o.method || 'lanczos', scale_by: factor } };
    img = ['4', 0];
  }
  g['9'] = { class_type: 'SaveImage', inputs: { filename_prefix: 'AutoInjector-upscale', images: img } };
  return g;
}

// ------------------------------------------------------------------ server schema checks
function _resolveRef(openapi, s) {
  let cur = s; let guard = 0;
  while (cur && cur.$ref && guard++ < 10) {
    const parts = String(cur.$ref).replace(/^#\//, '').split('/');
    let x = openapi; for (const p of parts) x = x && x[p];
    cur = x;
  }
  if (cur && Array.isArray(cur.allOf) && cur.allOf.length === 1) return _resolveRef(openapi, cur.allOf[0]);
  return cur;
}
// The JSON body schema of POST <path> → { name, properties } | null
function openapiRequestSchema(openapi, p) {
  try {
    const op = openapi && openapi.paths && openapi.paths[p] && openapi.paths[p].post;
    const sch = op && op.requestBody && op.requestBody.content && op.requestBody.content['application/json'] && op.requestBody.content['application/json'].schema;
    const ref = sch && sch.$ref ? String(sch.$ref).split('/').pop() : '';
    const r = _resolveRef(openapi, sch);
    if (!r || !r.properties) return null;
    const props = {};
    for (const [k, v] of Object.entries(r.properties)) props[k] = _resolveRef(openapi, v) || {};
    return { name: ref || r.title || p, properties: props, required: r.required || [] };
  } catch { return null; }
}
// Simplify an OpenAPI property → { types:[…], enum?, nullable, items? }
function propTypes(spec) {
  const s = spec || {};
  const types = new Set();
  let nullable = !!s.nullable;
  const visit = (x) => {
    if (!x) return;
    if (Array.isArray(x.type)) x.type.forEach((t) => (t === 'null' ? (nullable = true) : types.add(t)));
    else if (x.type) { if (x.type === 'null') nullable = true; else types.add(x.type); }
    for (const k of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(x[k])) x[k].forEach(visit);
    if (x.$ref) types.add('object');
  };
  visit(s);
  return { types: [...types], enum: s.enum, nullable };
}
function _typeOk(types, v) {
  if (!types.length) return true;
  return types.some((t) => {
    if (t === 'integer') return Number.isInteger(v);
    if (t === 'number') return typeof v === 'number' && Number.isFinite(v);
    if (t === 'boolean') return typeof v === 'boolean';
    if (t === 'string') return typeof v === 'string';
    if (t === 'array') return Array.isArray(v);
    if (t === 'object') return _isObj(v);
    return true;
  });
}
function _lev(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function suggest(name, names, n = 3) {
  const s = String(name || '').toLowerCase();
  if (!s) return [];
  const scored = names.map((x) => {
    const l = String(x).toLowerCase();
    if (l.includes(s) || s.includes(l)) return { x, d: Math.abs(l.length - s.length) / 100, near: true };
    const d = _lev(s, l);
    return { x, d, near: d <= Math.max(2, Math.ceil(s.length * 0.4)) };
  });
  return scored.filter((e) => e.near).sort((a, b) => a.d - b.d).slice(0, n).map((e) => e.x);
}
// Validate pass-through fields against the server's property map.
// → { ok:true } | { ok:false, error, code, field, message, hint, errors }
function validateFields(props, extra, what = 'txt2img') {
  const errors = [];
  const names = Object.keys(props || {});
  for (const [k, v] of Object.entries(extra || {})) {
    if (!props[k]) { const s = suggest(k, names); errors.push({ code: 'UNKNOWN_FIELD', field: k, message: `The server's ${what} has no field “${k}”.`, hint: s.length ? `Did you mean: ${s.join(', ')}?` : 'See sd.extraFields() for the full list.' }); continue; }
    const t = propTypes(props[k]);
    if (v === null) { if (!t.nullable && t.types.length) errors.push({ code: 'BAD_TYPE', field: k, message: `${k} can't be null.`, hint: `Expected ${t.types.join(' or ')}.` }); continue; }
    if (!_typeOk(t.types, v)) { errors.push({ code: 'BAD_TYPE', field: k, message: `${k} must be ${t.types.join(' or ')} (got ${Array.isArray(v) ? 'array' : typeof v}).`, hint: props[k].description || props[k].title || '' }); continue; }
    if (Array.isArray(t.enum) && !t.enum.includes(v)) errors.push({ code: 'BAD_VALUE', field: k, message: `${k} must be one of: ${t.enum.join(', ')}.`, hint: '' });
  }
  if (!errors.length) return { ok: true };
  return { ok: false, error: errors[0].code, code: errors[0].code, field: errors[0].field, message: errors.map((e) => e.message).join(' '), hint: errors[0].hint, errors };
}

function _jsType(v) { return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v; }
// Settings-menu options: key must exist on the server, the value must have the
// same type as the current one; a few choice options are checked against lists.
// ctx: { schema: {key: openapiProp} (optional), lists: { checkpoints, vaes, samplers, schedulers, upscalers } }
function validateOptions(current, patch, ctx = {}) {
  const errors = [];
  const keys = Object.keys(current || {});
  if (!_isObj(patch) || !Object.keys(patch).length) return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', message: 'Give at least one option: { "key": value }.', hint: 'sd.options.get() lists every key.' };
  const L = ctx.lists || {};
  const names = (arr, f) => (arr || []).map((x) => (typeof x === 'string' ? x : (x && (x[f] || x.name || x.title)) || '')).filter(Boolean);
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in (current || {})) && !(ctx.schema && ctx.schema[k])) { const s = suggest(k, keys); errors.push({ code: 'UNKNOWN_OPTION', field: k, message: `There is no setting “${k}” on this server.`, hint: s.length ? `Did you mean: ${s.join(', ')}?` : 'sd.options.get() lists every key.' }); continue; }
    const sp = ctx.schema && ctx.schema[k];
    if (sp && propTypes(sp).types.length) {
      const t = propTypes(sp);
      if (!(v === null && t.nullable) && !_typeOk(t.types, v)) { errors.push({ code: 'BAD_TYPE', field: k, message: `${k} must be ${t.types.join(' or ')}.`, hint: sp.description || sp.title || '' }); continue; }
    } else if (k in current && current[k] !== null && v !== null) {
      const want = _jsType(current[k]); const got = _jsType(v);
      const numOk = want === 'number' && got === 'number';
      if (!numOk && want !== got) { errors.push({ code: 'BAD_TYPE', field: k, message: `${k} must be a ${want} (it is ${JSON.stringify(current[k]).slice(0, 60)} now).`, hint: '' }); continue; }
    }
    const bare = (x) => String(x).replace(/\s*\[[0-9a-f]+\]$/i, '');
    const choose = (list, label) => { if (list.length && typeof v === 'string' && !list.some((x) => x === v || bare(x) === v || bare(x).replace(/\.(safetensors|ckpt|pt)$/i, '') === v)) errors.push({ code: 'BAD_VALUE', field: k, message: `${label} “${v}” isn't on this server.`, hint: `Choose one of: ${list.slice(0, 12).join(', ')}${list.length > 12 ? ', …' : ''}` }); };
    if (k === 'sd_model_checkpoint') choose(names(L.checkpoints, 'title'), 'Checkpoint');
    else if (k === 'sd_vae') choose(['Automatic', 'None', ...names(L.vaes, 'name')], 'VAE');
    else if (k === 'CLIP_stop_at_last_layers' && (!Number.isInteger(v) || v < 1 || v > 12)) errors.push({ code: 'BAD_VALUE', field: k, message: 'CLIP skip must be a whole number from 1 to 12.', hint: '' });
  }
  if (!errors.length) return { ok: true };
  return { ok: false, error: errors[0].code, code: errors[0].code, field: errors[0].field, message: errors.map((e) => e.message).join(' '), hint: errors[0].hint, errors };
}

// Which A1111 payload fields are covered by a structured parameter → { field: 'param' }
function a1111FieldMap() {
  const out = {};
  for (const [k, v] of Object.entries(GENERATE_SCHEMA.properties)) for (const f of v['x-a1111'] || []) if (f !== '*' && !f.includes('.')) out[f] = out[f] || k;
  for (const f of A1111_INTERNAL) out[f] = out[f] || '(set by AutoInjector)';
  return out;
}
function isA1111Internal(f) { return A1111_INTERNAL.includes(f); }

module.exports = {
  GENERATE_SCHEMA, UPSCALE_SCHEMA, ADV_KEYS, RESIZE_MODES, INPAINT_FILL, CN_CONTROL_MODES, CN_RESIZE_MODES, PURPOSES, ENGINES, VIEWS, A1111_INTERNAL,
  loadImage, checkValue, normalize, a1111Apply, cnUnitA1111, adUnitA1111, unsupportedOn,
  buildComfyGraph, buildComfyUpscaleGraph, latentMethod, modelScaleOf,
  openapiRequestSchema, propTypes, validateFields, validateOptions, suggest, a1111FieldMap, isA1111Internal,
};
