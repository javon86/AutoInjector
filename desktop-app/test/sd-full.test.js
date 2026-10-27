// test/sd-full.test.js — "can AutoInjector control ALL of Stable Diffusion?"
// Every new parameter path, checked in what the fake servers actually receive:
//   A1111/Forge: hires fix, refiner, img2img (file path input), inpaint (mask +
//   all options), ControlNet units, ADetailer, styles, scripts, alwayson_scripts,
//   clip skip / restore faces / tiling / variation, override settings + options
//   get/set validation, the validated pass-through (`extra`, checked against
//   /openapi.json), upscalers + Extras upscale, lists, interrupt/skip/refresh/memory.
//   ComfyUI: hires (latent + model), clip skip, img2img / inpaint uploads + graph,
//   refiner, ControlNet (+ preprocessors with comfyui_controlnet_aux), upscale,
//   saved workflows with parameter substitution, object_info / queue / free /
//   memory, UNSUPPORTED_ON_BACKEND for what ComfyUI can't do.
//   sd-api: capabilities() completeness, call(), every new method.
//   Coverage: every field of the server's txt2img/img2img OpenAPI schema is
//   reachable through a structured param or the validated pass-through.
// Run: node test/sd-full.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const ip = require('../image-provider');
const P = require('../sd-params');
const control = require('../sd-control');
const W = require('../sd-workflows');
const sdApi = require('../sd-api');
const { createSdStudio } = require('../sd-studio');
const { fakeA1111, fakeComfy, PNG, PNG_B64 } = require('./fixtures/fake-sd');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdfull-'));
  const imagesDir = path.join(tmp, 'images');
  const pic = path.join(tmp, 'start.png'); fs.writeFileSync(pic, PNG);
  const maskFile = path.join(tmp, 'mask.png'); fs.writeFileSync(maskFile, PNG);
  const studio = createSdStudio({ imageProvider: ip, library: null, imagesDir: () => imagesDir, workflowsDir: () => path.join(tmp, 'workflows'), fileUrl: (p) => `file://${p}` });
  const api = sdApi.createImagesApi({ studio, library: { list: () => ({ items: [] }), get: () => null, getLock: () => null, listLocks: () => ({ locks: [] }), scan: () => ({ ok: true }) } });

  console.log('\n== not connected ==');
  ip.setSettings({ enabled: false, endpoint: '', backend: '' });
  let r = await api.sd.options.get();
  assert(!r.ok && r.code === 'NO_ENDPOINT', 'options.get with nothing connected → NO_ENDPOINT');
  let caps = await api.capabilities();
  assert(caps.ok && caps.connected === false && caps.operations.find((o) => o.name === 'sd.options.set').supported === false && caps.operations.find((o) => o.name === 'sd.connect').supported, 'capabilities() unconnected: backend ops unsupported (with a hint), connect/detect supported');

  const forge = await fakeA1111({ flavor: 'forge' });
  await studio.connect(forge.base);
  const last = () => forge.state.lastTxt2img;

  console.log('\n== A1111: hires fix, refiner, clip skip, restore faces, tiling, styles, variation ==');
  r = await api.images.generate({ prompt: 'a lighthouse', steps: 20, width: 512, height: 512, seed: 7,
    hires: { scale: 1.5, upscaler: 'R-ESRGAN 4x+', secondPassSteps: 12, denoise: 0.35, resizeX: 0, resizeY: 0, sampler: 'Euler a', scheduler: 'Karras', checkpoint: 'juggernautXL_v9', prompt: 'detailed', negativePrompt: 'blurry', cfgScale: 5 },
    refiner: { checkpoint: 'juggernautXL_v9.safetensors [c9e3e68f89]', switchAt: 0.7 }, clipSkip: 2, restoreFaces: true, tiling: true, styles: ['Cinematic'],
    variation: { subseed: 99, strength: 0.25, resizeFromW: 512, resizeFromH: 512 } });
  let b = last();
  assert(r.ok && forge.state.lastPath === '/sdapi/v1/txt2img', 'generate with every txt2img extra succeeds');
  assert(b.enable_hr === true && b.hr_scale === 1.5 && b.hr_upscaler === 'R-ESRGAN 4x+' && b.hr_second_pass_steps === 12 && b.denoising_strength === 0.35, 'hires: enable_hr, hr_scale, hr_upscaler, hr_second_pass_steps, denoising_strength');
  assert(b.hr_sampler_name === 'Euler a' && b.hr_scheduler === 'Karras' && b.hr_checkpoint_name === 'juggernautXL_v9' && b.hr_prompt === 'detailed' && b.hr_negative_prompt === 'blurry' && b.hr_cfg === 5 && !('hr_resize_x' in b), 'hires: sampler, scheduler, checkpoint, prompt, negative, cfg (resize 0 = use scale)');
  assert(b.refiner_checkpoint === 'juggernautXL_v9.safetensors [c9e3e68f89]' && b.refiner_switch_at === 0.7, 'refiner: refiner_checkpoint + refiner_switch_at');
  assert(b.override_settings.CLIP_stop_at_last_layers === 2 && b.restore_faces === true && b.tiling === true && b.styles[0] === 'Cinematic', 'clip skip (override_settings), restore_faces, tiling, styles');
  assert(b.subseed === 99 && b.subseed_strength === 0.25 && b.seed_resize_from_w === 512 && b.seed_resize_from_h === 512, 'variation: subseed, subseed_strength, seed_resize_from_w/h');
  const rec = JSON.parse(fs.readFileSync(r.images[0].json, 'utf8'));
  assert(rec.hires.scale === 1.5 && rec.refiner.switchAt === 0.7 && rec.clipSkip === 2, 'the advanced settings are recorded with the picture (remake works)');
  r = await api.images.generate({ prompt: 'x', hires: { resizeX: 1024, resizeY: 768 } });
  assert(r.ok && last().hr_resize_x === 1024 && last().hr_resize_y === 768 && last().hr_upscaler === 'Latent' && last().hr_scale === 2, 'hires resize-to (hr_resize_x/y); defaults Latent ×2');

  console.log('\n== A1111: img2img (file path input) + inpaint ==');
  r = await api.images.img2img({ prompt: 'make it night', initImage: pic, denoise: 0.45, resizeMode: 'crop and resize', imageCfgScale: 1.5 });
  b = last();
  assert(r.ok && forge.state.lastPath === '/sdapi/v1/img2img' && b.init_images[0] === PNG_B64 && b.denoising_strength === 0.45 && b.resize_mode === 1 && b.image_cfg_scale === 1.5, 'img2img: a picture FILE becomes init_images; denoise, resize_mode, image_cfg_scale');
  assert(/img2img-/.test(path.basename(r.images[0].path)) && JSON.parse(fs.readFileSync(r.images[0].json, 'utf8')).initImage === '[image]', 'saved as img2img-…png; the record keeps "[image]", not the base64');
  r = await api.images.inpaint({ prompt: 'a red door', initImage: 'data:image/png;base64,' + PNG_B64, mask: maskFile, denoise: 0.8, inpaint: { maskBlur: 8, fill: 'latent noise', onlyMasked: true, padding: 48, invertMask: true } });
  b = last();
  assert(r.ok && b.mask === PNG_B64 && b.mask_blur === 8 && b.inpainting_fill === 2 && b.inpaint_full_res === true && b.inpaint_full_res_padding === 48 && b.inpainting_mask_invert === 1 && b.denoising_strength === 0.8, 'inpaint: mask, mask_blur, inpainting_fill, inpaint_full_res (only masked), padding, invert');
  assert(!(await api.images.inpaint({ prompt: 'x', initImage: pic })).ok && (await api.images.inpaint({ prompt: 'x', mask: pic })).code === 'INVALID_PARAM', 'inpaint without a mask / without a picture is refused');
  r = await api.images.img2img({ prompt: 'x', initImage: path.join(tmp, 'nope.png') });
  assert(!r.ok && r.code === 'INVALID_PARAM' && /no picture file/.test(r.message), 'a missing picture file → INVALID_PARAM in plain words');

  console.log('\n== A1111: ControlNet, ADetailer, scripts, alwayson_scripts ==');
  r = await api.images.generate({ prompt: 'a dancer', controlnet: [{ image: pic, module: 'openpose', model: 'control_v11p_sd15_canny [d14c016b]', weight: 0.8, guidanceStart: 0.1, guidanceEnd: 0.9, controlMode: 'ControlNet is more important', pixelPerfect: true, resizeMode: 'Resize and Fill', processorRes: 768, thresholdA: 100, thresholdB: 200 }],
    adetailer: [{ model: 'face_yolov8n.pt', prompt: 'pretty face', negativePrompt: 'ugly', confidence: 0.4, denoise: 0.35, maskBlur: 6, inpaintOnlyMasked: true, inpaintPadding: 40, steps: 30 }],
    alwaysonScripts: { 'dynamic prompts': { args: [true] } } });
  b = last();
  const cn = b.alwayson_scripts.controlnet.args[0];
  assert(r.ok && cn.enabled === true && cn.image === PNG_B64 && cn.module === 'openpose' && cn.model === 'control_v11p_sd15_canny [d14c016b]' && cn.weight === 0.8 && cn.guidance_start === 0.1 && cn.guidance_end === 0.9, 'ControlNet unit: image, module, model, weight, guidance start/end');
  assert(cn.control_mode === 'ControlNet is more important' && cn.pixel_perfect === true && cn.resize_mode === 'Resize and Fill' && cn.processor_res === 768 && cn.threshold_a === 100 && cn.threshold_b === 200, 'ControlNet unit: control mode, pixel perfect, resize mode, processor res, thresholds');
  const ad = b.alwayson_scripts.ADetailer.args;
  assert(ad[0] === true && ad[1] === false && ad[2].ad_model === 'face_yolov8n.pt' && ad[2].ad_prompt === 'pretty face' && ad[2].ad_negative_prompt === 'ugly' && ad[2].ad_confidence === 0.4 && ad[2].ad_denoising_strength === 0.35 && ad[2].ad_mask_blur === 6 && ad[2].ad_inpaint_only_masked === true && ad[2].ad_inpaint_only_masked_padding === 40 && ad[2].ad_use_steps === true && ad[2].ad_steps === 30, 'ADetailer: [enable, skip_img2img, {ad_model, ad_prompt, ad_confidence, ad_denoising_strength, …}]');
  assert(b.alwayson_scripts['dynamic prompts'].args[0] === true, 'raw alwayson_scripts for any other extension are merged in');
  r = await api.images.generate({ prompt: 'x', controlnet: [{ image: pic, model: 'control_nope', module: 'canny' }] });
  assert(!r.ok && r.code === 'UNKNOWN_VALUE' && r.field === 'controlnet[0].model' && /control_v11p_sd15_canny/.test(r.hint), 'an unknown ControlNet model is refused before sending (hint lists the real ones)');
  r = await api.images.generate({ prompt: 'x', controlnet: [{ image: pic, model: 'control_v11p_sd15_canny [d14c016b]', module: 'scribble_magic' }] });
  assert(!r.ok && r.field === 'controlnet[0].module', 'an unknown preprocessor is refused');
  r = await api.images.generate({ prompt: 'x', controlnet: [{ model: 'control_v11p_sd15_canny [d14c016b]' }] });
  assert(!r.ok && r.code === 'INVALID_PARAM' && /control image/.test(r.message), 'a txt2img ControlNet unit without an image is refused');
  r = await api.images.generate({ prompt: 'x', adetailer: [{ model: 'eyes_v9.pt' }] });
  assert(!r.ok && r.code === 'UNKNOWN_VALUE' && /face_yolov8n/.test(r.hint), 'an unknown ADetailer model is refused');
  r = await api.images.generate({ prompt: 'x', script: { name: 'X/Y/Z plot', args: [1, '10,20', 0] } });
  assert(r.ok && last().script_name === 'X/Y/Z plot' && last().script_args[1] === '10,20', 'script_name + script_args');
  r = await api.images.generate({ prompt: 'x', script: { name: 'loopback' } });
  assert(!r.ok && r.code === 'UNKNOWN_VALUE' && /x\/y\/z plot/.test(r.hint), 'an img2img-only script is refused for txt2img (hint lists txt2img scripts)');
  r = await api.images.generate({ prompt: 'x', styles: ['Vaporwave'] });
  assert(!r.ok && r.field === 'styles' && /Cinematic/.test(r.hint), 'an unknown style is refused');
  r = await api.images.generate({ prompt: 'x', hires: { upscaler: 'Magic 8x' } });
  assert(r.ok && last().hr_upscaler === 'Latent' && r.warnings.some((w) => w.field === 'hires.upscaler' && /no upscaler called “Magic 8x”/.test(w.message)), 'an unknown hires upscaler is left out (the app\'s default) with a plain warning — never sent');
  r = await api.images.generate({ prompt: 'x', hirez: { scale: 2 } });
  assert(!r.ok && r.code === 'INVALID_PARAM' && r.field === 'hirez' && /hires/.test(r.hint), 'a misspelt top-level parameter is refused with a suggestion (not silently ignored)');
  r = await api.images.generate({ prompt: 'x', hires: { scale: 'big' } });
  assert(!r.ok && r.code === 'INVALID_PARAM' && r.field === 'hires.scale', 'a wrong type is refused (INVALID_PARAM with the field)');
  r = await api.images.generate({ prompt: 'x', hires: { scael: 2 } });
  assert(!r.ok && r.field === 'hires.scael' && /scale/.test(r.message), 'a misspelt nested setting is refused and the known ones listed');
  r = await api.images.generate({ prompt: 'x', inpaint: { fill: 'magic' } });
  assert(!r.ok && /fill, original, latent noise, latent nothing/.test(r.message), 'enums are checked');

  console.log('\n== A1111: override settings + the validated pass-through ==');
  r = await api.images.generate({ prompt: 'x', overrideSettings: { eta_noise_seed_delta: 31337, samples_format: 'jpg' }, extra: { eta: 0.67, s_churn: 0.5, do_not_save_grid: true, firstphase_width: 0 } });
  b = last();
  assert(r.ok && b.override_settings.eta_noise_seed_delta === 31337 && b.override_settings.samples_format === 'jpg' && b.override_settings_restore_afterwards === true, 'overrideSettings: any option for one picture (restored afterwards)');
  assert(b.eta === 0.67 && b.s_churn === 0.5 && b.do_not_save_grid === true && b.firstphase_width === 0, 'extra: any OpenAPI field reaches the payload');
  r = await api.images.generate({ prompt: 'x', extra: { etaa: 0.5 } });
  assert(!r.ok && r.code === 'UNKNOWN_FIELD' && /eta/.test(r.hint) && forge.state.lastTxt2img.etaa === undefined, 'extra: an unknown field is refused with a suggestion (nothing sent)');
  r = await api.images.generate({ prompt: 'x', extra: { s_churn: 'lots' } });
  assert(!r.ok && r.code === 'BAD_TYPE' && /number/.test(r.message), 'extra: a wrong type is refused');
  r = await api.images.generate({ prompt: 'x', initImage: pic, extra: { mask_round: false, initial_noise_multiplier: 1.05 } });
  assert(r.ok && last().mask_round === false && last().initial_noise_multiplier === 1.05, 'extra on img2img is checked against the img2img schema');
  r = await api.images.generate({ prompt: 'x', extra: { mask_round: false } });
  assert(!r.ok && r.code === 'UNKNOWN_FIELD', '…and an img2img-only field is refused for txt2img');
  r = await api.images.generate({ prompt: 'x', overrideSettings: { CLIP_stop: 2 } });
  assert(!r.ok && r.code === 'UNKNOWN_OPTION' && /CLIP_stop_at_last_layers/.test(r.hint) && r.field === 'overrideSettings.CLIP_stop', 'overrideSettings: an unknown option is refused with a suggestion');
  const noOa = await fakeA1111({ noOpenapi: true, noExtensions: true });
  await studio.connect(noOa.base);
  r = await api.images.generate({ prompt: 'x', extra: { eta: 0.3 } });
  assert(r.ok && noOa.state.lastTxt2img.eta === 0.3 && r.warnings.some((w) => /without checking/.test(w.message)), 'no /openapi.json → extra fields are still sent, with a warning');
  r = await api.images.generate({ prompt: 'x', controlnet: [{ image: pic, model: 'x' }] });
  assert(!r.ok && r.code === 'UNSUPPORTED_ON_BACKEND' && /controlnet extension/i.test(r.hint), 'ControlNet on a WebUI without the extension → UNSUPPORTED_ON_BACKEND + how to install');
  r = await api.images.generate({ prompt: 'x', adetailer: [{}] });
  assert(!r.ok && r.code === 'UNSUPPORTED_ON_BACKEND' && /ADetailer/.test(r.hint), 'ADetailer without the extension → UNSUPPORTED_ON_BACKEND');
  r = await api.sd.extraFields();
  assert(!r.ok && r.code === 'NO_SCHEMA', 'extraFields() without /openapi.json says so');
  await studio.connect(forge.base);

  console.log('\n== A1111: settings menu (options get / set, validated) ==');
  r = await api.sd.options.get();
  assert(r.ok && r.options.sd_model_checkpoint && r.count >= 7, `options.get() reads every option (${r.count})`);
  r = await api.sd.options.get(['CLIP_stop_at_last_layers', 'jpeg_quality']);
  assert(r.ok && r.options.CLIP_stop_at_last_layers === 1 && r.options.jpeg_quality === 80 && Object.keys(r.options).length === 2, 'options.get(keys) reads just those');
  r = await api.sd.options.get(['jpeg_qualty']);
  assert(!r.ok && r.code === 'UNKNOWN_OPTION' && /jpeg_quality/.test(r.hint), 'options.get of a misspelt key → suggestion');
  r = await api.sd.options.set({ CLIP_stop_at_last_layers: 2, jpeg_quality: 95, sd_vae: 'vae-ft-mse-840000' });
  assert(r.ok && forge.state.options.CLIP_stop_at_last_layers === 2 && forge.state.options.jpeg_quality === 95 && forge.state.options.sd_vae === 'vae-ft-mse-840000', 'options.set() changes any option on the server');
  r = await api.sd.options.set({ sd_model_checkpoint: 'juggernautXL_v9' });
  assert(r.ok && forge.state.options.sd_model_checkpoint === 'juggernautXL_v9', 'options.set() switches the checkpoint (by name without the hash)');
  const before = forge.state.optionsSet.length;
  r = await api.sd.options.set({ jpeg_quality: 'high' });
  assert(!r.ok && r.code === 'BAD_TYPE' && forge.state.optionsSet.length === before, 'options.set: a wrong type is refused and nothing is sent');
  r = await api.sd.options.set({ CLIP_stop_at_last_layer: 2 });
  assert(!r.ok && r.code === 'UNKNOWN_OPTION' && /CLIP_stop_at_last_layers/.test(r.hint), 'options.set: an unknown key → UNKNOWN_OPTION + suggestion');
  r = await api.sd.options.set({ sd_model_checkpoint: 'not_a_model' });
  assert(!r.ok && r.code === 'BAD_VALUE' && /dreamshaper_8/.test(r.hint), 'options.set: a checkpoint the server doesn\'t have is refused');
  r = await api.sd.options.set({ CLIP_stop_at_last_layers: 13 });
  assert(!r.ok && r.code === 'BAD_VALUE', 'options.set: CLIP skip outside 1–12 is refused');
  r = await api.sd.options.set({ enable_pnginfo: 'yes' });
  assert(!r.ok && r.code === 'BAD_TYPE', 'options.set: the server\'s Options schema types are enforced');
  r = await api.sd.options.schema();
  assert(r.ok && r.options.find((o) => o.key === 'CLIP_stop_at_last_layers').type === 'integer', 'options.schema(): key, type, current value');

  console.log('\n== A1111: lists, upscale, control ==');
  r = await api.sd.upscalers();
  assert(r.ok && r.all.includes('Latent') && r.all.includes('R-ESRGAN 4x+') && r.upscalers.some((u) => u.scale === 4), 'upscalers(): models + latent modes');
  r = await api.sd.styles();
  assert(r.ok && r.styles[0].name === 'Cinematic' && r.styles[0].negativePrompt === 'cartoon', 'styles()');
  r = await api.sd.scripts();
  assert(r.ok && r.txt2img.includes('x/y/z plot') && r.img2img.includes('loopback') && r.info[0].args[0].label === 'X type', 'scripts(): txt2img / img2img lists + their args');
  r = await api.sd.embeddings();
  assert(r.ok && r.loaded.includes('easynegative'), 'embeddings()');
  r = await api.sd.controlnet.models();
  const r2 = await api.sd.controlnet.modules();
  assert(r.ok && r.models.length === 2 && r2.ok && r2.modules.includes('canny'), 'controlnet.models() / modules()');
  r = await api.sd.adetailer.models();
  assert(r.ok && r.models.includes('hand_yolov8n.pt'), 'adetailer.models()');
  r = await api.sd.memory();
  assert(r.ok && r.vram.total === 12e9 && r.ram.total === 16e9, 'memory(): RAM + VRAM');
  r = await api.sd.skip();
  assert(r.ok && forge.state.skipped, 'skip()');
  r = await api.sd.interrupt();
  assert(r.ok && forge.state.interrupted, 'interrupt()');
  forge.state.interrupted = false;
  r = await api.sd.refresh();
  assert(r.ok && ['refresh-checkpoints', 'refresh-loras', 'refresh-vae', 'refresh-embeddings'].every((x) => forge.state.refreshed.includes(x)), 'refresh(): checkpoints, LoRAs, VAEs, embeddings');
  r = await api.sd.refresh('loras');
  assert(r.ok && Object.keys(r.refreshed).length === 1, 'refresh("loras") only');
  assert((await api.sd.refresh('everything')).code === 'INVALID_PARAM', 'refresh(<unknown>) is refused');
  r = await api.images.upscale({ image: pic, upscaler: '4x-UltraSharp', factor: 3, upscaler2: 'Lanczos', upscaler2Visibility: 0.3, gfpgan: 0.5, codeformer: 0.2, codeformerWeight: 0.7 });
  const ex = forge.state.lastExtras;
  assert(r.ok && ex.image === PNG_B64 && ex.upscaler_1 === '4x-UltraSharp' && ex.upscaling_resize === 3 && ex.resize_mode === 0 && ex.upscaler_2 === 'Lanczos' && ex.extras_upscaler_2_visibility === 0.3 && ex.gfpgan_visibility === 0.5 && ex.codeformer_visibility === 0.2 && ex.codeformer_weight === 0.7, 'upscale → /extra-single-image with upscaler, factor, 2nd upscaler, GFPGAN, CodeFormer');
  assert(fs.existsSync(r.images[0].path) && /upscale-/.test(path.basename(r.images[0].path)), 'the upscaled picture is saved (upscale-…png)');
  r = await api.images.upscale({ image: pic, width: 1024, height: 1536, crop: true });
  assert(r.ok && forge.state.lastExtras.resize_mode === 1 && forge.state.lastExtras.upscaling_resize_w === 1024 && forge.state.lastExtras.upscaling_crop === true, 'upscale to a size (resize_mode 1, w/h, crop)');
  r = await api.images.upscale({ image: pic, upscaler: 'Nope' });
  assert(!r.ok && r.code === 'UNKNOWN_VALUE' && /R-ESRGAN/.test(r.hint), 'an unknown upscaler is refused');
  r = await api.sd.extraFields('img2img');
  assert(r.ok && r.fields.find((f) => f.name === 'inpainting_fill').structured === 'inpaint' && r.fields.find((f) => f.name === 's_churn').structured === null, 'extraFields(): every server field, with the structured param that covers it');
  for (const [name, call] of [['comfy.objectInfo', () => api.sd.comfy.objectInfo()], ['comfy.queue', () => api.sd.comfy.queue()], ['workflows.run', () => api.sd.workflows.run({ workflow: { 1: { class_type: 'SaveImage', inputs: {} } } })], ['comfy.free', () => api.sd.comfy.free()]]) {
    r = await call();
    assert(!r.ok && r.code === 'UNSUPPORTED_ON_BACKEND' && r.hint, `${name} on A1111 → UNSUPPORTED_ON_BACKEND with a hint`);
  }

  console.log('\n== coverage: every txt2img / img2img OpenAPI field is reachable ==');
  const fieldMap = P.a1111FieldMap();
  for (const kind of ['txt2img', 'img2img']) {
    const sch = await control.payloadSchema(forge.base, kind);
    const missing = []; let structured = 0; let pass = 0;
    const sample = (spec) => { const t = P.propTypes(spec).types[0]; return t === 'integer' ? 3 : t === 'number' ? 0.5 : t === 'boolean' ? true : t === 'array' ? [] : t === 'object' ? {} : 'x'; };
    for (const [f, spec] of Object.entries(sch.properties)) {
      if (fieldMap[f]) { structured++; continue; }
      const v = sample(spec);
      const ok = P.validateFields(sch.properties, { [f]: v }, kind).ok;
      const body = P.a1111Apply({}, { extra: { [f]: v } });
      if (ok && body[f] === v) pass++; else missing.push(f);
    }
    // And the structured ones really land in the payload (spot-check every one the map claims).
    const full = P.a1111Apply({ prompt: 'x' }, P.normalize({ hires: { scale: 2, upscaler: 'Latent', secondPassSteps: 5, denoise: 0.4, resizeX: 640, resizeY: 640, sampler: 's', scheduler: 'k', checkpoint: 'c', prompt: 'p', negativePrompt: 'n', cfgScale: 3 }, refiner: { checkpoint: 'r', switchAt: 0.5 }, restoreFaces: true, tiling: true, styles: ['s'], variation: { subseed: 1, strength: 0.1, resizeFromW: 1, resizeFromH: 1 }, script: { name: 'n', args: [] }, alwaysonScripts: { a: { args: [] } }, overrideSettings: { k: 1 } }).adv);
    const fullI = P.a1111Apply({ prompt: 'x' }, P.normalize({ initImage: PNG_B64, denoise: 0.5, resizeMode: 'just resize', imageCfgScale: 1, mask: PNG_B64, inpaint: { maskBlur: 1, fill: 'fill', onlyMasked: true, padding: 1, invertMask: true } }).adv);
    const baseBody = require('../sd-backends').a1111Payload({ prompt: 'x', steps: 1, cfgScale: 1, width: 64, height: 64, seed: 1, sampler: 's', scheduler: 'k', batchSize: 1, batchCount: 1 });
    const structuredMissing = Object.keys(sch.properties).filter((f) => fieldMap[f] && fieldMap[f] !== '(set by AutoInjector)' && !(f in full) && !(f in fullI) && !(f in baseBody) && f !== 'sampler_index' && !(kind === 'txt2img' && ['init_images', 'resize_mode', 'image_cfg_scale', 'mask', 'mask_blur', 'inpainting_fill', 'inpaint_full_res', 'inpaint_full_res_padding', 'inpainting_mask_invert'].includes(f)));
    assert(missing.length === 0, `${kind}: ${Object.keys(sch.properties).length} fields — ${structured} via structured params, ${pass} via the validated pass-through, ${missing.length} unreachable${missing.length ? ` (${missing.join(', ')})` : ''}`);
    assert(structuredMissing.length === 0, `${kind}: every structured mapping really lands in the payload${structuredMissing.length ? ` (missing: ${structuredMissing.join(', ')})` : ''}`);
  }
  assert(Object.keys(fieldMap).length >= 45, `${Object.keys(fieldMap).length} A1111 payload fields have a structured parameter`);

  console.log('\n== ComfyUI: hires fix, clip skip, img2img, inpaint, refiner, ControlNet ==');
  const comfy = await fakeComfy();
  await studio.connect(comfy.base);
  const G = () => comfy.state.lastGraph;
  const byType = (t, g = G()) => Object.entries(g).filter(([, n]) => n.class_type === t);
  const one = (t, g) => (byType(t, g)[0] || [null, null]);
  r = await api.images.generate({ prompt: 'castle', width: 512, height: 768, steps: 20, seed: 5, hires: { scale: 2, upscaler: 'Latent (bicubic)', secondPassSteps: 10, denoise: 0.45 }, clipSkip: 2, pollMs: 20 });
  let ks = byType('KSampler');
  const lu = one('LatentUpscale')[1];
  assert(r.ok && lu && lu.inputs.width === 1024 && lu.inputs.height === 1536 && lu.inputs.upscale_method === 'bicubic' && lu.inputs.samples[0] === '3', 'hires (latent): LatentUpscale ×2 of the first KSampler, method from the upscaler name');
  const k2 = ks.find(([id]) => id !== '3')[1];
  assert(ks.length === 2 && k2.inputs.denoise === 0.45 && k2.inputs.steps === 10 && k2.inputs.latent_image[0] === one('LatentUpscale')[0] && G()['8'].inputs.samples[0] === ks.find(([id]) => id !== '3')[0], 'hires: second KSampler (denoise, steps) → VAEDecode');
  const csl = one('CLIPSetLastLayer');
  assert(csl[1] && csl[1].inputs.stop_at_clip_layer === -2 && G()['6'].inputs.clip[0] === csl[0] && G()['7'].inputs.clip[0] === csl[0], 'clip skip 2 → CLIPSetLastLayer(-2) feeding both text encoders');
  r = await api.images.generate({ prompt: 'castle', width: 512, height: 512, hires: { scale: 2, upscaler: '4x-UltraSharp' }, pollMs: 20 });
  assert(r.ok && one('UpscaleModelLoader')[1].inputs.model_name === '4x-UltraSharp.pth' && one('ImageUpscaleWithModel')[1] && one('ImageScale')[1].inputs.width === 1024 && byType('VAEEncode').length === 1 && byType('KSampler').length === 2, 'hires (model): VAEDecode → UpscaleModelLoader + ImageUpscaleWithModel → ImageScale 1024 → VAEEncode → KSampler');
  r = await api.images.generate({ prompt: 'x', hires: { upscaler: 'Magic' }, pollMs: 20 });
  assert(r.ok && !one('UpscaleModelLoader')[1] && r.warnings.some((w) => /no upscaler called “Magic”/.test(w.message)), 'an upscaler ComfyUI doesn\'t have is left out with a plain warning (no upscale-model node)');
  const upBefore = comfy.state.uploads.length;
  r = await api.images.img2img({ prompt: 'night', initImage: pic, denoise: 0.45, width: 512, height: 512, resizeMode: 'crop and resize', batchSize: 2, pollMs: 20 });
  const li = one('LoadImage')[1];
  assert(r.ok && comfy.state.uploads.length === upBefore + 1 && li && li.inputs.image === comfy.state.uploads[comfy.state.uploads.length - 1].name && comfy.state.uploads[comfy.state.uploads.length - 1].data.equals(PNG), 'img2img: the picture is uploaded (/upload/image, bytes intact) and LoadImage uses its name');
  assert(!byType('EmptyLatentImage').length && one('ImageScale')[1].inputs.crop === 'center' && one('VAEEncode')[1] && G()['3'].inputs.denoise === 0.45 && one('RepeatLatentBatch')[1].inputs.amount === 2 && r.images.length === 2, 'img2img: ImageScale (crop) → VAEEncode → RepeatLatentBatch → KSampler(denoise 0.45)');
  r = await api.images.inpaint({ prompt: 'red door', initImage: pic, mask: maskFile, denoise: 0.7, inpaint: { fill: 'original', invertMask: true }, pollMs: 20 });
  const lm = one('LoadImageMask')[1];
  assert(r.ok && lm && lm.inputs.channel === 'red' && comfy.state.uploads.some((u) => u.name === lm.inputs.image && /mask/.test(u.name)), 'inpaint: the mask is uploaded and loaded with LoadImageMask');
  assert(one('InvertMask')[1] && one('SetLatentNoiseMask')[1] && one('SetLatentNoiseMask')[1].inputs.mask[0] === one('InvertMask')[0] && G()['3'].inputs.denoise === 0.7, 'inpaint fill "original": VAEEncode → SetLatentNoiseMask (inverted mask), denoise kept');
  r = await api.images.inpaint({ prompt: 'red door', initImage: pic, mask: maskFile, inpaint: { fill: 'latent nothing', maskBlur: 10 }, pollMs: 20 });
  assert(r.ok && one('VAEEncodeForInpaint')[1].inputs.grow_mask_by === 10 && G()['3'].inputs.denoise === 1, 'inpaint fill "latent nothing": VAEEncodeForInpaint (mask blur → grow_mask_by), denoise 1');
  r = await api.images.generate({ prompt: 'x', steps: 30, seed: 3, checkpoint: 'juggernautXL_v9', refiner: { checkpoint: 'sdxl_refiner_1.0', switchAt: 0.8 }, pollMs: 20 });
  const kas = byType('KSamplerAdvanced');
  assert(r.ok && kas.length === 2 && G()['3'].inputs.end_at_step === 24 && G()['3'].inputs.return_with_leftover_noise === 'enable' && G()['43'].inputs.start_at_step === 24 && G()['43'].inputs.add_noise === 'disable' && G()['40'].inputs.ckpt_name === 'sdxl_refiner_1.0.safetensors' && G()['43'].inputs.model[0] === '40', 'refiner: base KSamplerAdvanced steps 0–24, refiner checkpoint continues 24–30');
  assert(G()['41'].inputs.clip[0] === '40' && G()['8'].inputs.samples[0] === '43', 'refiner: own text encoders; its output is decoded');
  r = await api.images.generate({ prompt: 'x', refiner: { checkpoint: 'ghost_refiner' }, pollMs: 20 });
  assert(r.ok && !byType('KSamplerAdvanced').length && r.warnings.some((w) => w.field === 'refiner' && /“ghost_refiner”/.test(w.message)), 'an unknown refiner checkpoint → made without the refiner, with a plain warning');
  r = await api.images.generate({ prompt: 'dancer', controlnet: [{ image: pic, model: 'control_v11p_sd15_canny', module: 'none', weight: 0.7, guidanceStart: 0.1, guidanceEnd: 0.8 }], pollMs: 20 });
  const cna = one('ControlNetApplyAdvanced');
  assert(r.ok && one('ControlNetLoader')[1].inputs.control_net_name === 'control_v11p_sd15_canny.pth' && cna[1].inputs.strength === 0.7 && cna[1].inputs.start_percent === 0.1 && cna[1].inputs.end_percent === 0.8, 'ControlNet: ControlNetLoader + ControlNetApplyAdvanced (strength, start, end)');
  assert(G()['3'].inputs.positive[0] === cna[0] && G()['3'].inputs.positive[1] === 0 && G()['3'].inputs.negative[1] === 1 && cna[1].inputs.positive[0] === '6', 'ControlNet: the conditioning is routed through it into the KSampler');
  r = await api.images.generate({ prompt: 'x', controlnet: [{ image: pic, model: 'control_v11p_sd15_canny', module: 'canny' }], pollMs: 20 });
  assert(!r.ok && r.code === 'UNSUPPORTED_ON_BACKEND' && /comfyui_controlnet_aux/.test(r.hint), 'a preprocessor without comfyui_controlnet_aux → UNSUPPORTED_ON_BACKEND + what to install');
  r = await api.images.generate({ prompt: 'x', controlnet: [{ image: pic, model: 'control_v11p_sd15_canny', controlMode: 'My prompt is more important' }], pollMs: 20 });
  assert(!r.ok && r.code === 'UNSUPPORTED_ON_BACKEND' && r.field === 'controlnet[0].controlMode', 'ControlNet control mode → UNSUPPORTED_ON_BACKEND on ComfyUI');
  r = await api.images.generate({ prompt: 'x', controlnet: [{ image: pic, model: 'nope' }], pollMs: 20 });
  assert(!r.ok && r.code === 'UNKNOWN_VALUE' && /control_v11p_sd15_canny\.pth/.test(r.hint), 'an unknown ControlNet model is refused');
  const aux = await fakeComfy({ aux: true });
  await studio.connect(aux.base);
  r = await api.images.generate({ prompt: 'x', width: 640, height: 512, controlnet: [{ image: pic, model: 'control_v11p_sd15_canny', module: 'CannyEdgePreprocessor', pixelPerfect: true }], pollMs: 20 });
  const pre = one('AIO_Preprocessor', aux.state.lastGraph);
  assert(r.ok && pre[1] && pre[1].inputs.preprocessor === 'CannyEdgePreprocessor' && pre[1].inputs.resolution === 512 && one('ControlNetApplyAdvanced', aux.state.lastGraph)[1].inputs.image[0] === pre[0], 'with comfyui_controlnet_aux: AIO_Preprocessor (pixel perfect → resolution from the size) feeds the ControlNet');
  r = await api.sd.controlnet.modules();
  assert(r.ok && r.modules.includes('DepthAnythingPreprocessor'), 'controlnet.modules() on ComfyUI lists the aux preprocessors');
  await studio.connect(comfy.base);
  for (const [field, req] of [['adetailer', { adetailer: [{}] }], ['restoreFaces', { restoreFaces: true }], ['tiling', { tiling: true }], ['styles', { styles: ['Cinematic'] }], ['extra', { extra: { eta: 1 } }], ['variation', { variation: { subseed: 2 } }], ['overrideSettings', { overrideSettings: { x: 1 } }], ['script', { script: { name: 'x' } }], ['inpaint.onlyMasked', { initImage: pic, mask: maskFile, inpaint: { onlyMasked: true } }], ['hires.checkpoint/prompt/cfgScale', { hires: { prompt: 'p' } }]]) {
    r = await api.images.generate(Object.assign({ prompt: 'x', pollMs: 20 }, req));
    assert(!r.ok && r.code === 'UNSUPPORTED_ON_BACKEND' && r.field === field && r.hint, `ComfyUI: ${field} → UNSUPPORTED_ON_BACKEND (“${String(r.hint).slice(0, 60)}…”)`);
  }

  console.log('\n== ComfyUI: upscale, node types, queue, memory, uploads ==');
  r = await api.images.upscale({ image: pic, upscaler: '4x-UltraSharp', factor: 2, pollMs: 20 });
  assert(r.ok && one('UpscaleModelLoader')[1].inputs.model_name === '4x-UltraSharp.pth' && one('ImageUpscaleWithModel')[1] && one('ImageScaleBy')[1].inputs.scale_by === 0.5 && fs.existsSync(r.images[0].path), 'upscale: LoadImage → upscale model (4×) → ImageScaleBy 0.5 = ×2 overall → saved');
  r = await api.images.upscale({ image: pic, upscaler: 'lanczos', factor: 1.5, pollMs: 20 });
  assert(r.ok && !byType('UpscaleModelLoader').length && one('ImageScaleBy')[1].inputs.scale_by === 1.5, 'upscale with plain lanczos');
  r = await api.images.upscale({ image: pic, gfpgan: 0.5 });
  assert(!r.ok && r.code === 'UNSUPPORTED_ON_BACKEND', 'upscale extras (GFPGAN…) on ComfyUI → UNSUPPORTED_ON_BACKEND');
  r = await api.sd.comfy.objectInfo();
  assert(r.ok && r.count > 20 && r.nodes.some((n) => n.name === 'KSampler'), `comfy.objectInfo(): ${r.count} node types`);
  r = await api.sd.comfy.objectInfo('LoadImageMask');
  assert(r.ok && r.node.input.required.channel, 'comfy.objectInfo(node): its inputs');
  assert((await api.sd.comfy.objectInfo('FaceDetailer')).code === 'UNKNOWN_VALUE', 'comfy.objectInfo(<missing node>) says so');
  r = await api.sd.comfy.queue();
  assert(r.ok && typeof r.running === 'number' && typeof r.pending === 'number', 'comfy.queue()');
  r = await api.sd.comfy.upload(pic, 'my pose.png');
  assert(r.ok && r.name === 'my_pose.png' && comfy.state.uploads.some((u) => u.name === 'my_pose.png'), 'comfy.upload(image, name) → the LoadImage name');
  r = await api.sd.comfy.free();
  assert(r.ok && comfy.state.freed.unload_models === true, 'comfy.free()');
  r = await api.sd.memory();
  assert(r.ok && r.vram.total === 12e9 && /4070/.test(r.device), 'memory() on ComfyUI (from /system_stats)');
  r = await api.sd.upscalers();
  assert(r.ok && r.all.includes('4x-UltraSharp.pth') && r.all.includes('Latent'), 'upscalers() on ComfyUI: latent modes + upscale models');
  r = await api.sd.interrupt();
  assert(r.ok && comfy.state.interrupted, 'interrupt() on ComfyUI');
  comfy.state.interrupted = false;
  for (const [name, call] of [['options.get', () => api.sd.options.get()], ['options.set', () => api.sd.options.set({ a: 1 })], ['styles', () => api.sd.styles()], ['scripts', () => api.sd.scripts()], ['adetailer.models', () => api.sd.adetailer.models()], ['skip', () => api.sd.skip()], ['extraFields', () => api.sd.extraFields()]]) {
    r = await call();
    assert(!r.ok && r.code === 'UNSUPPORTED_ON_BACKEND' && r.hint, `${name} on ComfyUI → UNSUPPORTED_ON_BACKEND with a hint`);
  }

  console.log('\n== ComfyUI: saved workflows with parameter substitution ==');
  const WF = {
    3: { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd15/dreamshaper_8.safetensors' } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['4', 1] } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['8', 0] } },
  };
  r = await api.sd.workflows.save({ name: 'UI save', workflow: { nodes: [], links: [] } });
  assert(!r.ok && r.code === 'UI_FORMAT' && /API/.test(r.hint), 'a normal (UI) ComfyUI save is refused with how to export the API format');
  r = await api.sd.workflows.save({ name: 'Broken', workflow: { 1: { class_type: 'X', inputs: { a: ['99', 0] } } } });
  assert(!r.ok && r.code === 'BAD_WORKFLOW', 'a workflow linking to a missing node is refused');
  r = await api.sd.workflows.save({ name: 'Basic txt2img', description: 'test', workflow: WF });
  assert(r.ok && r.workflow.id === 'basic-txt2img', 'save a workflow');
  r = await api.sd.workflows.list();
  const wl = r.workflows.find((w) => w.id === 'basic-txt2img');
  assert(r.ok && wl && ['prompt', 'negativePrompt', 'seed', 'steps', 'cfgScale', 'sampler', 'scheduler', 'denoise', 'width', 'height', 'batchSize', 'checkpoint'].every((p) => wl.params.includes(p)), `list() shows the auto-detected parameters (${wl && wl.params.join(', ')})`);
  r = await api.sd.workflows.run({ id: 'Basic txt2img', params: { prompt: 'a dragon', negativePrompt: 'text', seed: 42, steps: 12, cfgScale: 5, sampler: 'DPM++ 2M', width: 640, batchSize: 2, checkpoint: 'juggernautXL_v9.safetensors', '7.text': 'lowres' }, pollMs: 20 });
  let g = G();
  assert(r.ok && g['6'].inputs.text === 'a dragon' && g['3'].inputs.seed === 42 && g['3'].inputs.steps === 12 && g['3'].inputs.cfg === 5 && g['3'].inputs.sampler_name === 'dpmpp_2m' && g['5'].inputs.width === 640 && g['5'].inputs.batch_size === 2 && g['4'].inputs.ckpt_name === 'juggernautXL_v9.safetensors', 'run by name: prompt, seed, steps, cfg, sampler (mapped), width, batch, checkpoint substituted');
  assert(g['7'].inputs.text === 'lowres' && r.applied.some((a) => a.param === '7.text' && a.via === 'node.input'), '"<node>.<input>" params override anything (negative → lowres)');
  assert(r.images.length === 2 && fs.existsSync(r.images[0].path) && JSON.parse(fs.readFileSync(r.images[0].json, 'utf8')).workflowName === 'Basic txt2img' && r.seed === 42, 'the results are saved with the workflow name, params and seed');
  r = await api.sd.workflows.run({ id: 'basic-txt2img', params: { promt: 'x' }, pollMs: 20 });
  assert(!r.ok && r.code === 'UNKNOWN_PARAM' && /prompt/.test(r.hint), 'an unknown parameter is refused with the list this workflow has');
  r = await api.sd.workflows.run({ id: 'basic-txt2img', params: { seed: -1 }, pollMs: 20 });
  assert(r.ok && Number.isInteger(G()['3'].inputs.seed) && G()['3'].inputs.seed >= 0 && r.seed === G()['3'].inputs.seed, 'seed -1 → a real random seed, reported back');
  const WF2 = JSON.parse(JSON.stringify(WF));
  WF2['6'].inputs.text = '{{subject}}, {{style}} style';
  WF2['10'] = { class_type: 'LoadImage', inputs: { image: 'example.png' } };
  r = await api.sd.workflows.save({ name: 'Templated', workflow: WF2, bindings: { strength: [{ node: '3', input: 'denoise' }] } });
  assert(r.ok && r.workflow.params.includes('subject') && r.workflow.params.includes('strength') && r.workflow.params.includes('image'), 'placeholders ({{subject}}) and explicit bindings show up as parameters');
  r = await api.sd.workflows.run({ id: 'templated', params: { subject: 'a fox', style: 'ukiyo-e', strength: 0.6, image: pic }, pollMs: 20 });
  g = G();
  const lastUp = comfy.state.uploads[comfy.state.uploads.length - 1];
  assert(r.ok && g['6'].inputs.text === 'a fox, ukiyo-e style' && g['3'].inputs.denoise === 0.6, '{{placeholders}} filled; explicit binding (strength → 3.denoise)');
  assert(g['10'].inputs.image === lastUp.name && /image/.test(lastUp.name), 'a picture param bound to LoadImage is uploaded first and its name substituted');
  r = await api.sd.workflows.run({ id: 'templated', params: { subject: 'a fox' }, pollMs: 20 });
  assert(!r.ok && r.code === 'MISSING_PARAM' && /style/.test(r.message), 'a placeholder left empty → MISSING_PARAM');
  r = await api.sd.workflows.run({ workflow: WF, params: { prompt: 'inline' }, pollMs: 20 });
  assert(r.ok && G()['6'].inputs.text === 'inline', 'an inline (unsaved) workflow runs too');
  r = await api.sd.workflows.run({ workflow: { 1: { class_type: 'FaceDetailer', inputs: {} } }, pollMs: 20 });
  assert(!r.ok && r.error === 'COMFY_REJECTED' && /FaceDetailer/.test(r.message), 'a workflow needing a missing custom node → ComfyUI\'s reason in plain words');
  r = await api.sd.workflows.get('templated');
  assert(r.ok && r.bindings.strength[0].node === '3', 'workflows.get()');
  r = await api.sd.workflows.delete('templated');
  assert(r.ok && !(await api.sd.workflows.list()).workflows.some((w) => w.id === 'templated'), 'workflows.delete()');
  // Pure substitution helpers.
  const det = W.detectBindings({ 1: { class_type: 'KSamplerAdvanced', inputs: { noise_seed: 1, steps: 9, cfg: 7, sampler_name: 'euler', scheduler: 'normal', positive: ['2', 0], negative: ['3', 1], model: ['9', 0], latent_image: ['9', 0] } }, 2: { class_type: 'CLIPTextEncode', inputs: { text: 'p', clip: ['9', 1] } }, 3: { class_type: 'ControlNetApplyAdvanced', inputs: { positive: ['2', 0], negative: ['4', 0] } }, 4: { class_type: 'CLIPTextEncode', inputs: { text: 'n', clip: ['9', 1] } }, 9: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a' } } });
  assert(det.seed[0].input === 'noise_seed' && det.prompt[0].node === '2' && det.negativePrompt[0].node === '4', 'detectBindings follows conditioning through ControlNet nodes and knows KSamplerAdvanced noise_seed');

  console.log('\n== sd-api: capabilities() completeness + call() ==');
  await studio.connect(forge.base);
  caps = await api.capabilities();
  const leaves = [];
  (function walk(o, pre) { for (const [k, v] of Object.entries(o)) { const n = pre ? `${pre}.${k}` : k; if (typeof v === 'function') leaves.push(n); else if (v && typeof v === 'object') walk(v, n); } })(api, '');
  const opNames = caps.operations.map((o) => o.name);
  const notListed = leaves.filter((n) => !opNames.includes(n));
  assert(notListed.length === 0, `every one of the ${leaves.length} API methods is in capabilities()${notListed.length ? ` — missing: ${notListed.join(', ')}` : ''}`);
  assert(opNames.every((n) => leaves.includes(n)), 'and capabilities() lists nothing that doesn\'t exist');
  assert(caps.operations.every((o) => o.params && o.params.type === 'object' && o.params.properties && typeof o.description === 'string' && o.description.length > 5), 'every operation has a description and an object parameter schema');
  for (const n of ['images.generate', 'images.img2img', 'images.inpaint', 'images.upscale', 'sd.options.get', 'sd.options.set', 'sd.controlnet.models', 'sd.controlnet.modules', 'sd.styles', 'sd.scripts', 'sd.workflows.list', 'sd.workflows.save', 'sd.workflows.run', 'capabilities']) assert(opNames.includes(n), `capabilities() lists ${n}`);
  const gen = caps.operations.find((o) => o.name === 'images.generate');
  assert(caps.backend === 'a1111' && caps.features.controlnet && caps.features.adetailer && gen.supported && Object.keys(gen.params.properties).length === Object.keys(P.GENERATE_SCHEMA.properties).length && gen.params.properties.hires.properties.upscaler, 'A1111: generate\'s full parameter schema (hires.upscaler …), ControlNet + ADetailer detected');
  assert(caps.operations.find((o) => o.name === 'sd.workflows.run').supported === false && caps.operations.find((o) => o.name === 'sd.workflows.run').code === 'UNSUPPORTED_ON_BACKEND' && caps.operations.find((o) => o.name === 'sd.options.set').supported, 'A1111: options supported, workflow running marked UNSUPPORTED_ON_BACKEND');
  assert(caps.extraFields && caps.extraFields.validated && caps.extraFields.txt2img.includes('s_churn') && caps.extraFields.img2img.includes('mask_round'), 'A1111: capabilities() includes every pass-through field from /openapi.json');
  assert(caps.operations.find((o) => o.name === 'images.inpaint').params.required.join() === 'initImage,mask', 'inpaint\'s schema requires initImage + mask');
  r = await api.call('sd.options.set', { options: { jpeg_quality: 70 } });
  assert(r.ok && forge.state.options.jpeg_quality === 70, 'call("sd.options.set", { options }) dispatches');
  r = await api.call('images.generate', { prompt: 'via call', hires: { scale: 2 } });
  assert(r.ok && last().prompt === 'via call' && last().enable_hr === true, 'call("images.generate", {…}) with advanced params');
  r = await api.call('library.find', { query: 'x', kind: 'lora' });
  assert(Array.isArray(r), 'call() maps positional arguments (library.find(query, {kind}))');
  r = await api.call('sd.nonsense', {});
  assert(!r.ok && r.code === 'UNKNOWN_OPERATION' && /images\.generate/.test(r.hint), 'call() of an unknown operation lists the real ones');
  r = await api.call('sd.refresh', { wat: 'loras' });
  assert(!r.ok && r.code === 'INVALID_PARAM' && /what/.test(r.hint), 'call() refuses unknown parameters with a suggestion');
  r = await api.call('sd.workflows.get', {});
  assert(!r.ok && r.field === 'id', 'call() enforces required parameters');
  await studio.connect(comfy.base);
  caps = await api.capabilities();
  const cg = caps.operations.find((o) => o.name === 'images.generate');
  assert(caps.backend === 'comfy' && cg.params.properties.adetailer['x-supported'] === 'no' && cg.params.properties.hires['x-supported'] === 'partial' && cg.params.properties.clipSkip['x-supported'] === 'yes', 'ComfyUI: per-parameter support (adetailer no, hires partial, clip skip yes)');
  assert(caps.operations.find((o) => o.name === 'sd.workflows.run').supported && !caps.operations.find((o) => o.name === 'sd.options.get').supported && caps.operations.find((o) => o.name === 'sd.options.get').hint, 'ComfyUI: workflows supported; options unsupported with a hint');
  assert(caps.generateParams.find((p) => p.name === 'controlnet').note.includes('ControlNetApplyAdvanced'), 'generateParams carry the ComfyUI mapping note');
  const ex2 = await studio.extras();
  assert(ex2.ok && ex2.backend === 'comfy' && ex2.controlnet.models.length === 2 && ex2.upscalers.includes('4x-UltraSharp.pth') && ex2.workflows.some((w) => w.id === 'basic-txt2img'), 'extras() gives the UI every list in one call');

  for (const s of [forge, noOa, comfy, aux]) await s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
