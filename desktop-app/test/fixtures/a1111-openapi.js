'use strict';
// a1111-openapi.js — an /openapi.json shaped like Automatic1111 1.10 / Forge's
// (pydantic models StableDiffusionProcessingTxt2Img / Img2Img with their real
// field names and types), used by the fake A1111 server and the coverage test.
const S = (type, extra) => Object.assign({ type }, extra || {});
const COMMON = {
  prompt: S('string', { default: '' }), negative_prompt: S('string', { default: '' }), styles: S('array', { items: { type: 'string' } }),
  seed: S('integer', { default: -1 }), subseed: S('integer', { default: -1 }), subseed_strength: S('number', { default: 0 }),
  seed_resize_from_h: S('integer', { default: -1 }), seed_resize_from_w: S('integer', { default: -1 }),
  sampler_name: S('string'), scheduler: S('string'), batch_size: S('integer', { default: 1 }), n_iter: S('integer', { default: 1 }),
  steps: S('integer', { default: 50 }), cfg_scale: S('number', { default: 7 }), distilled_cfg_scale: S('number', { default: 3.5 }),
  width: S('integer', { default: 512 }), height: S('integer', { default: 512 }),
  restore_faces: S('boolean'), tiling: S('boolean'), do_not_save_samples: S('boolean', { default: false }), do_not_save_grid: S('boolean', { default: false }),
  eta: S('number'), denoising_strength: S('number'), s_min_uncond: S('number'), s_churn: S('number'), s_tmax: S('number'), s_tmin: S('number'), s_noise: S('number'),
  override_settings: S('object'), override_settings_restore_afterwards: S('boolean', { default: true }),
  refiner_checkpoint: S('string'), refiner_switch_at: S('number'), disable_extra_networks: S('boolean', { default: false }),
  firstpass_image: S('string'), comments: S('object'),
  force_task_id: S('string'), sampler_index: S('string', { default: 'Euler' }), script_name: S('string'), script_args: S('array', { items: {} }),
  send_images: S('boolean', { default: true }), save_images: S('boolean', { default: false }), alwayson_scripts: S('object'), infotext: S('string'),
};
const TXT2IMG = Object.assign({}, COMMON, {
  enable_hr: S('boolean', { default: false }), firstphase_width: S('integer', { default: 0 }), firstphase_height: S('integer', { default: 0 }),
  hr_scale: S('number', { default: 2 }), hr_upscaler: S('string'), hr_second_pass_steps: S('integer', { default: 0 }),
  hr_resize_x: S('integer', { default: 0 }), hr_resize_y: S('integer', { default: 0 }), hr_checkpoint_name: S('string'),
  hr_sampler_name: S('string'), hr_scheduler: S('string'), hr_prompt: S('string', { default: '' }), hr_negative_prompt: S('string', { default: '' }),
  hr_cfg: S('number', { default: 1 }), hr_distilled_cfg: S('number', { default: 3.5 }),
});
const IMG2IMG = Object.assign({}, COMMON, {
  init_images: S('array', { items: {} }), resize_mode: S('integer', { default: 0 }), image_cfg_scale: S('number'),
  mask: S('string'), mask_blur_x: S('integer', { default: 4 }), mask_blur_y: S('integer', { default: 4 }), mask_blur: S('integer'), mask_round: S('boolean', { default: true }),
  inpainting_fill: S('integer', { default: 0 }), inpaint_full_res: S('boolean', { default: true }), inpaint_full_res_padding: S('integer', { default: 0 }),
  inpainting_mask_invert: S('integer', { default: 0 }), initial_noise_multiplier: S('number'), latent_mask: S('string'), include_init_images: S('boolean', { default: false }),
});
// A tiny slice of the dynamic Options model.
const OPTIONS = { sd_model_checkpoint: S('string'), sd_vae: S('string'), CLIP_stop_at_last_layers: S('integer'), samples_format: S('string'), jpeg_quality: S('number'), enable_pnginfo: S('boolean'), eta_noise_seed_delta: S('integer') };

function openapi(opts = {}) {
  const post = (ref) => ({ post: { requestBody: { required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } } }, responses: { 200: { description: 'ok' } } } });
  const get = () => ({ get: { responses: { 200: { description: 'ok' } } } });
  const paths = {
    '/sdapi/v1/txt2img': post('StableDiffusionProcessingTxt2Img'), '/sdapi/v1/img2img': post('StableDiffusionProcessingImg2Img'),
    '/sdapi/v1/extra-single-image': post('ExtrasSingleImageRequest'), '/sdapi/v1/options': Object.assign(get(), post('Options')),
    '/sdapi/v1/upscalers': get(), '/sdapi/v1/latent-upscale-modes': get(), '/sdapi/v1/prompt-styles': get(), '/sdapi/v1/scripts': get(), '/sdapi/v1/script-info': get(),
    '/sdapi/v1/embeddings': get(), '/sdapi/v1/memory': get(), '/sdapi/v1/skip': { post: {} }, '/sdapi/v1/interrupt': { post: {} },
    '/sdapi/v1/refresh-checkpoints': { post: {} }, '/sdapi/v1/refresh-loras': { post: {} }, '/sdapi/v1/refresh-vae': { post: {} }, '/sdapi/v1/refresh-embeddings': { post: {} },
  };
  if (opts.extensions !== false) { paths['/controlnet/model_list'] = get(); paths['/controlnet/module_list'] = get(); paths['/adetailer/v1/ad_model'] = get(); }
  return {
    openapi: '3.1.0', info: { title: 'FastAPI', version: '0.1.0' }, paths,
    components: { schemas: {
      StableDiffusionProcessingTxt2Img: { title: 'StableDiffusionProcessingTxt2Img', type: 'object', properties: TXT2IMG },
      StableDiffusionProcessingImg2Img: { title: 'StableDiffusionProcessingImg2Img', type: 'object', properties: IMG2IMG },
      ExtrasSingleImageRequest: { title: 'ExtrasSingleImageRequest', type: 'object', properties: { image: S('string'), upscaler_1: S('string'), upscaling_resize: S('number') } },
      Options: { title: 'Options', type: 'object', properties: OPTIONS },
    } },
  };
}

module.exports = { openapi, TXT2IMG, IMG2IMG, OPTIONS };
