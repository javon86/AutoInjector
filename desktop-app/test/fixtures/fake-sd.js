'use strict';
// fake-sd.js — tiny fake Stable Diffusion servers for the tests:
//   fakeA1111({ flavor, noApi, oom, slow, noOpenapi, noExtensions, badVae, failWith })
//       badVae: a VAE name (also listed by /sd-vae) that fails EVERY txt2img/img2img
//       with A1111's real 500 body ("Error(s) in loading state_dict for
//       AutoencoderKL: Missing key(s) …") while it is the effective VAE
//       (override_settings.sd_vae, else options.sd_vae) — so "Use Automatic VAE
//       and retry" really fixes it. failWith (or state.failWith at run time):
//       'vae' | 'oom' | 'nan' | 'ckpt' | 'lora' | 'html' | 'traceback' → that 500.
//       /sdapi/v1/* like A1111 / Forge / SD.Next — incl. /openapi.json (real field
//       names, test/fixtures/a1111-openapi.js), options get/set, upscalers, latent
//       modes, prompt-styles, scripts + script-info, extra-single-image, skip,
//       refresh-*, memory, and the ControlNet + ADetailer extension routes
//   fakeComfy({ slow, failWith, failNode, nodeErrors, aux })
//       nodeErrors: a node_errors object /prompt answers with (400), e.g. a VAELoader
//       that can't load its file; failNode: node_type of the failWith execution_error.
//       /system_stats, /object_info (all + per node; unknown → {}), /prompt (refuses
//       unknown node types, dangling links, missing uploads), /history, /view,
//       /queue, /interrupt, /upload/image (multipart), /free. aux: true adds
//       comfyui_controlnet_aux's AIO_Preprocessor.
// Each resolves { server, port, base, seen, state, close() }.
const http = require('http');
const { openapi: makeOpenapi } = require('./a1111-openapi');

// A real (valid) 1x1 PNG, built here so its chunks and CRCs are right.
function makePng() {
  const zlib = require('zlib');
  const { crc32 } = require('../../sd-images');
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const t = Buffer.from(type, 'latin1'); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 200, 30, 30]))), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = makePng();

// Real-shaped A1111 / Forge 500 bodies (modules/api/api.py: {error, detail, body, errors}).
const VAE_MISSING = 'Error(s) in loading state_dict for AutoencoderKL:\n\tMissing key(s) in state_dict: "encoder.conv_in.weight", "encoder.conv_in.bias", "encoder.down.0.block.0.norm1.weight", "encoder.down.0.block.0.norm1.bias", "encoder.down.0.block.0.conv1.weight", "encoder.down.0.block.0.conv1.bias", "encoder.down.0.block.0.norm2.weight", "encoder.down.0.block.0.norm2.bias", "encoder.down.0.block.0.conv2.weight", "encoder.down.0.block.0.conv2.bias", "encoder.mid.attn_1.q.weight", "quant_conv.weight", "quant_conv.bias".';
const A1111_ERRORS = {
  vae: { error: 'RuntimeError', detail: '', body: '', errors: VAE_MISSING },
  oom: { error: 'OutOfMemoryError', detail: '', body: '', errors: 'CUDA out of memory. Tried to allocate 2.00 GiB (GPU 0; 8.00 GiB total capacity; 6.10 GiB already allocated; 512.00 MiB free; 6.50 GiB reserved in total by PyTorch)' },
  nan: { error: 'NansException', detail: '', body: '', errors: 'A tensor with all NaNs was produced in VAE. This could be because there\'s not enough precision to represent the picture. Try adding --no-half-vae commandline argument to fix this. Use --disable-nan-check commandline argument to disable this check.' },
  ckpt: { error: 'SafetensorError', detail: '', body: '', errors: 'Error while deserializing header: MetadataIncompleteBuffer' },
  lora: { error: 'RuntimeError', detail: '', body: '', errors: "Couldn't find Lora with name missing_face" },
  traceback: { error: 'KeyError', detail: '', body: '', errors: "Traceback (most recent call last):\n  File \"modules/processing.py\", line 732, in process_images\nKeyError: 'sd_xl_refiner'" },
};
const PNG_B64 = PNG.toString('base64');

function send(res, code, body, type) {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(code, { 'Content-Type': type || (isBuf ? 'image/png' : typeof body === 'string' ? 'text/html' : 'application/json') });
  res.end(isBuf || typeof body === 'string' ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((r) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => { const buf = Buffer.concat(chunks); const b = buf.toString('utf8'); try { r(b ? JSON.parse(b) : {}); } catch { r({ __raw: buf.toString('latin1'), __buf: buf }); } });
  });
}
// Minimal multipart/form-data reader: { fields, file: { name, data } }.
function parseMultipart(raw, buf, contentType) {
  const m = String(contentType || '').match(/boundary=(.+)$/);
  const out = { fields: {}, file: null };
  if (!m) return out;
  const parts = raw.split(`--${m[1]}`);
  for (const part of parts) {
    const hm = part.match(/Content-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]+)")?/);
    if (!hm) continue;
    const idx = part.indexOf('\r\n\r\n');
    const body = part.slice(idx + 4).replace(/\r\n$/, '');
    if (hm[2]) out.file = { name: hm[2], size: Buffer.from(body, 'latin1').length, data: Buffer.from(body, 'latin1') };
    else out.fields[hm[1]] = body;
  }
  return out;
}
function listen(server, port) { return new Promise((r) => server.listen(port || 0, '127.0.0.1', () => r(server.address().port))); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fakeA1111(opts = {}) {
  const seen = [];
  const state = { interrupted: false, running: false, lastTxt2img: null, lastExtras: null, skipped: false, refreshed: [], optionsSet: [],
    options: Object.assign({ sd_model_checkpoint: 'dreamshaper_8.safetensors [879db523c3]', sd_vae: 'Automatic', CLIP_stop_at_last_layers: 1, samples_format: 'png', jpeg_quality: 80, enable_pnginfo: true, eta_noise_seed_delta: 0 }, opts.flavor === 'forge' ? { forge_preset: 'sd', forge_additional_modules: [] } : {}) };
  const ext = opts.noExtensions !== true;
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const body = req.method === 'POST' ? await readBody(req) : null;
    seen.push({ method: req.method, path: u.pathname, body, query: u.search });
    if (u.pathname === '/') return send(res, 200, `<!doctype html><html><head><title>${opts.title || 'Stable Diffusion'}</title><script>window.gradio_config = {"version":"3.41.2"};</script></head><body>gradio</body></html>`);
    if ((u.pathname.startsWith('/sdapi/') || u.pathname === '/openapi.json') && opts.noApi) return send(res, 404, { detail: 'Not Found' });
    if (u.pathname === '/openapi.json') return opts.noOpenapi ? send(res, 404, { detail: 'Not Found' }) : send(res, 200, makeOpenapi({ extensions: ext }));
    if (u.pathname === '/sdapi/v1/options' && req.method === 'POST') { state.optionsSet.push(body); Object.assign(state.options, body); return send(res, 200, null); }
    if (ext) {
      if (u.pathname === '/controlnet/model_list') return send(res, 200, { model_list: ['control_v11p_sd15_canny [d14c016b]', 'control_v11f1p_sd15_depth [cfd03158]'] });
      if (u.pathname === '/controlnet/module_list') return send(res, 200, { module_list: ['none', 'canny', 'depth_midas', 'openpose'], module_detail: {} });
      if (u.pathname === '/adetailer/v1/ad_model') return send(res, 200, { ad_model: ['face_yolov8n.pt', 'hand_yolov8n.pt', 'person_yolov8n-seg.pt'] });
    }
    switch (u.pathname) {
      case '/sdapi/v1/upscalers': return send(res, 200, [{ name: 'None', model_name: null, scale: 4 }, { name: 'Lanczos', model_name: null, scale: 4 }, { name: 'R-ESRGAN 4x+', model_name: 'RealESRGAN_x4plus', scale: 4 }, { name: '4x-UltraSharp', model_name: '4x-UltraSharp', scale: 4 }]);
      case '/sdapi/v1/latent-upscale-modes': return send(res, 200, [{ name: 'Latent' }, { name: 'Latent (antialiased)' }, { name: 'Latent (bicubic)' }, { name: 'Latent (nearest-exact)' }]);
      case '/sdapi/v1/prompt-styles': return send(res, 200, [{ name: 'Cinematic', prompt: 'cinematic still, {prompt}', negative_prompt: 'cartoon' }, { name: 'Oil painting', prompt: '{prompt}, oil on canvas', negative_prompt: '' }]);
      case '/sdapi/v1/scripts': return send(res, 200, { txt2img: ['prompt matrix', 'prompts from file or textbox', 'x/y/z plot', 'controlnet', 'adetailer'], img2img: ['img2img alternative test', 'loopback', 'sd upscale', 'x/y/z plot'] });
      case '/sdapi/v1/script-info': return send(res, 200, [{ name: 'x/y/z plot', is_alwayson: false, is_img2img: false, args: [{ label: 'X type', value: 'Nothing', minimum: null, maximum: null, step: null, choices: ['Nothing', 'Seed', 'Steps', 'CFG Scale'] }, { label: 'X values', value: '' }] }, { name: 'adetailer', is_alwayson: true, is_img2img: false, args: [] }]);
      case '/sdapi/v1/extra-single-image': state.lastExtras = body; return send(res, 200, { image: PNG_B64, html_info: '<p>Postprocess upscale by: 2</p>' });
      case '/sdapi/v1/skip': state.skipped = true; return send(res, 200, null);
      case '/sdapi/v1/refresh-checkpoints': case '/sdapi/v1/refresh-loras': case '/sdapi/v1/refresh-vae': case '/sdapi/v1/refresh-embeddings': state.refreshed.push(u.pathname.split('/').pop()); return send(res, 200, null);
      case '/sdapi/v1/memory': return send(res, 200, { ram: { free: 8e9, used: 8e9, total: 16e9 }, cuda: { system: { free: 6e9, used: 6e9, total: 12e9 }, active: {}, allocated: {} } });
      case '/sdapi/v1/sd-models': return send(res, 200, [
        { title: 'dreamshaper_8.safetensors [879db523c3]', model_name: 'dreamshaper_8', hash: '879db523c3', filename: opts.ckptFile || '/models/Stable-diffusion/dreamshaper_8.safetensors' },
        { title: 'juggernautXL_v9.safetensors [c9e3e68f89]', model_name: 'juggernautXL_v9', hash: 'c9e3e68f89', filename: '/models/Stable-diffusion/juggernautXL_v9.safetensors' },
      ]);
      case '/sdapi/v1/options': return send(res, 200, state.options);
      case '/sdapi/v1/cmd-flags': return send(res, 200, { api: true, listen: false });
      case '/sdapi/v1/version': return opts.flavor === 'sdnext' ? send(res, 200, { app: 'sd.next', updated: '2025-01-01' }) : send(res, 404, { detail: 'Not Found' });
      case '/sdapi/v1/loras': return send(res, 200, [
        { name: 'odile_face', alias: 'odile_face', path: opts.loraFile || '/models/Lora/odile_face.safetensors', metadata: { ss_base_model_version: 'sd_v1' } },
        { name: 'xl_ink', alias: 'xl_ink', path: '/models/Lora/xl_ink.safetensors', metadata: { ss_base_model_version: 'sdxl_base_v1-0' } },
      ]);
      case '/sdapi/v1/samplers': return send(res, 200, [{ name: 'Euler a', aliases: [] }, { name: 'DPM++ 2M', aliases: [] }]);
      case '/sdapi/v1/schedulers': return send(res, 200, [{ name: 'automatic', label: 'Automatic' }, { name: 'karras', label: 'Karras' }]);
      case '/sdapi/v1/sd-vae': return send(res, 200, [{ model_name: 'vae-ft-mse-840000', filename: '/models/VAE/vae-ft-mse-840000.safetensors' }].concat(opts.badVae ? [{ model_name: opts.badVae, filename: `/models/VAE/${opts.badVae}.safetensors` }] : []));
      case '/sdapi/v1/embeddings': return send(res, 200, { loaded: { easynegative: { step: null } }, skipped: {} });
      case '/sdapi/v1/progress': return send(res, 200, state.running ? { progress: 0.5, eta_relative: 3.2, state: { job: 'txt2img', job_count: 1, sampling_step: 10, sampling_steps: 20 }, current_image: null, textinfo: null } : { progress: 0, eta_relative: 0, state: { job: '', sampling_step: 0, sampling_steps: 0 } });
      case '/sdapi/v1/interrupt': state.interrupted = true; return send(res, 200, {});
      case '/sdapi/v1/txt2img':
      case '/sdapi/v1/img2img': {
        state.lastTxt2img = body; state.lastPath = u.pathname;
        if (opts.oom) return send(res, 500, { error: 'OutOfMemoryError', detail: 'CUDA out of memory. Tried to allocate 2.00 GiB', body: '', errors: '' });
        state.txt2imgCalls = (state.txt2imgCalls || 0) + 1;
        const effVae = (body.override_settings && body.override_settings.sd_vae) || state.options.sd_vae;
        if (opts.badVae && effVae === opts.badVae) return send(res, 500, A1111_ERRORS.vae);
        const fw = state.failWith || opts.failWith;
        if (fw === 'html') return send(res, 500, '<html><head><title>500 Internal Server Error</title></head><body><h1>Internal Server Error</h1></body></html>');
        if (fw && A1111_ERRORS[fw]) return send(res, 500, A1111_ERRORS[fw]);
        if (opts.slow) { state.running = true; const t0 = Date.now(); while (!state.interrupted && Date.now() - t0 < 5000) await sleep(40); state.running = false; }
        const n = (body.batch_size || 1) * (body.n_iter || 1);
        const seed = body.seed >= 0 ? body.seed : 1234;
        return send(res, 200, { images: Array.from({ length: n }, () => PNG_B64), parameters: body, info: JSON.stringify({ seed, all_seeds: Array.from({ length: n }, (_, i) => seed + i), sd_model_name: 'dreamshaper_8', infotexts: [] }) });
      }
      default: return send(res, 404, { detail: 'Not Found' });
    }
  });
  const port = await listen(server, opts.port);
  return { server, port, base: `http://127.0.0.1:${port}`, seen, state, close: () => new Promise((r) => server.close(r)) };
}

// The node types the fake ComfyUI knows (a slice of /object_info).
function comfyNodes(CKPTS, LORAS, opts) {
  const req = (o) => ({ input: { required: o }, output: [], category: 'x' });
  const n = {
    CheckpointLoaderSimple: req({ ckpt_name: [CKPTS, { tooltip: 'x' }] }),
    LoraLoader: req({ model: ['MODEL'], clip: ['CLIP'], lora_name: ['COMBO', { options: LORAS }], strength_model: ['FLOAT', {}], strength_clip: ['FLOAT', {}] }),
    VAELoader: req({ vae_name: [['vae-ft-mse-840000.safetensors'], {}] }),
    KSampler: req({ sampler_name: [['euler', 'euler_ancestral', 'dpmpp_2m'], {}], scheduler: [['normal', 'karras', 'simple'], {}] }),
    KSamplerAdvanced: req({ sampler_name: [['euler', 'euler_ancestral', 'dpmpp_2m'], {}], scheduler: [['normal', 'karras', 'simple'], {}] }),
    CLIPTextEncode: req({ text: ['STRING', {}], clip: ['CLIP'] }), CLIPSetLastLayer: req({ clip: ['CLIP'], stop_at_clip_layer: ['INT', {}] }),
    EmptyLatentImage: req({}), VAEDecode: req({}), VAEEncode: req({}), VAEEncodeForInpaint: req({}), SetLatentNoiseMask: req({}),
    SaveImage: Object.assign(req({}), { output_node: true }), PreviewImage: Object.assign(req({}), { output_node: true }),
    LoadImage: req({ image: [['example.png'], { image_upload: true }] }), LoadImageMask: req({ image: [['example.png'], {}], channel: [['alpha', 'red', 'green', 'blue'], {}] }),
    MaskToImage: req({}), ImageToMask: req({}), InvertMask: req({}), ImageScale: req({}), ImageScaleBy: req({}), LatentUpscale: req({}), LatentUpscaleBy: req({}), RepeatLatentBatch: req({}),
    UpscaleModelLoader: req({ model_name: [['4x-UltraSharp.pth', 'RealESRGAN_x2plus.pth'], {}] }), ImageUpscaleWithModel: req({}),
    ControlNetLoader: req({ control_net_name: [['control_v11p_sd15_canny.pth', 'control_v11f1p_sd15_depth.pth'], {}] }), ControlNetApplyAdvanced: req({}),
  };
  if (opts.aux) n.AIO_Preprocessor = req({ image: ['IMAGE'], preprocessor: [['none', 'CannyEdgePreprocessor', 'DepthAnythingPreprocessor', 'OpenposePreprocessor'], {}], resolution: ['INT', {}] });
  return n;
}

async function fakeComfy(opts = {}) {
  const seen = [];
  const state = { prompts: {}, polls: 0, interrupted: false, deleted: [], lastGraph: null, uploads: [], freed: null };
  const CKPTS = ['sd15/dreamshaper_8.safetensors', 'juggernautXL_v9.safetensors', 'sdxl_refiner_1.0.safetensors'];
  const LORAS = ['Characters\\odile_face.safetensors', 'ink_style.safetensors'];
  const NODES = comfyNodes(CKPTS, LORAS, opts);
  const reject = (res, id, cls, type, message, details) => send(res, 400, { error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '' }, node_errors: { [id]: { class_type: cls, errors: [{ type, message, details }] } } });
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const body = req.method === 'POST' ? await readBody(req) : null;
    seen.push({ method: req.method, path: u.pathname, body, query: u.search });
    if (u.pathname === '/') return send(res, 200, '<!doctype html><html><head><title>ComfyUI</title></head><body></body></html>');
    if (u.pathname === '/system_stats') return send(res, 200, { system: { os: 'nt', comfyui_version: '0.3.10', python_version: '3.11', ram_total: 32e9, ram_free: 20e9 }, devices: [{ name: 'cuda:0 NVIDIA GeForce RTX 4070', type: 'cuda', vram_total: 12e9, vram_free: 9e9 }] });
    if (u.pathname === '/object_info') return send(res, 200, NODES);
    if (u.pathname.startsWith('/object_info/')) { const nm = decodeURIComponent(u.pathname.slice('/object_info/'.length)); return send(res, 200, NODES[nm] ? { [nm]: NODES[nm] } : {}); }
    if (u.pathname === '/embeddings') return send(res, 200, ['easynegative']);
    if (u.pathname === '/upload/image' && req.method === 'POST') {
      const mp = parseMultipart(body.__raw || '', body.__buf, req.headers['content-type']);
      if (!mp.file || !mp.file.size) return send(res, 400, { error: 'no image' });
      state.uploads.push({ name: mp.file.name, size: mp.file.size, type: mp.fields.type, overwrite: mp.fields.overwrite, data: mp.file.data });
      return send(res, 200, { name: mp.file.name, subfolder: mp.fields.subfolder || '', type: mp.fields.type || 'input' });
    }
    if (u.pathname === '/prompt' && req.method === 'POST') {
      const g = body.prompt || {};
      state.lastGraph = g;
      if (opts.nodeErrors) return send(res, 400, { error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '' }, node_errors: opts.nodeErrors });
      for (const [id, n] of Object.entries(g)) {
        if (!NODES[n.class_type]) return send(res, 400, { error: { type: 'invalid_prompt', message: `Cannot execute because node ${n.class_type} does not exist.`, details: `Node ID '#${id}'` }, node_errors: {} });
        for (const [k, v] of Object.entries(n.inputs || {})) if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && Number.isInteger(v[1]) && !g[v[0]]) return reject(res, id, n.class_type, 'invalid_link', 'Linked node missing', `${k} -> ${v[0]}`);
        if (n.class_type === 'CheckpointLoaderSimple' && !CKPTS.includes(n.inputs.ckpt_name)) return reject(res, id, 'CheckpointLoaderSimple', 'value_not_in_list', 'Value not in list', `ckpt_name: '${n.inputs.ckpt_name}' not in ${JSON.stringify(CKPTS)}`);
        if ((n.class_type === 'LoadImage' || n.class_type === 'LoadImageMask') && n.inputs.image !== 'example.png' && !state.uploads.some((x) => x.name === n.inputs.image)) return reject(res, id, n.class_type, 'custom_validation_failed', 'Invalid image file', `image - Invalid image file: ${n.inputs.image}`);
      }
      const id = `p${Object.keys(state.prompts).length + 1}`;
      state.prompts[id] = { graph: g, polls: 0 };
      return send(res, 200, { prompt_id: id, number: 0, node_errors: {} });
    }
    if (u.pathname.startsWith('/history/')) {
      const id = decodeURIComponent(u.pathname.slice('/history/'.length));
      const p = state.prompts[id];
      if (!p) return send(res, 200, {});
      p.polls++;
      if (state.interrupted) return send(res, 200, { [id]: { outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_start', {}], ['execution_interrupted', { prompt_id: id }]] } } });
      if (opts.failWith) return send(res, 200, { [id]: { outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_error', { node_type: opts.failNode || 'KSampler', exception_type: opts.failType || 'RuntimeError', exception_message: opts.failWith }]] } } });
      if (opts.slow ? true : p.polls < 2) return send(res, 200, {});
      const nodes = Object.values(p.graph);
      const lat = nodes.find((n) => n.class_type === 'EmptyLatentImage');
      const rep = nodes.find((n) => n.class_type === 'RepeatLatentBatch');
      const batch = lat ? lat.inputs.batch_size : rep ? rep.inputs.amount : 1;
      const outId = (Object.entries(p.graph).find(([, n]) => n.class_type === 'SaveImage') || ['9'])[0];
      return send(res, 200, { [id]: { outputs: { [outId]: { images: Array.from({ length: batch }, (_, i) => ({ filename: `AutoInjector_0000${i + 1}_.png`, subfolder: '', type: 'output' })) } }, status: { status_str: 'success', completed: true, messages: [] } } });
    }
    if (u.pathname === '/view') return send(res, 200, PNG);
    if (u.pathname === '/queue' && req.method === 'GET') { const ids = Object.keys(state.prompts); return send(res, 200, { queue_running: ids.length && !state.interrupted ? [[0, ids[ids.length - 1], {}, {}, ['9']]] : [], queue_pending: [] }); }
    if (u.pathname === '/queue' && req.method === 'POST') { state.deleted.push(...((body && body.delete) || [])); return send(res, 200, {}); }
    if (u.pathname === '/interrupt') { state.interrupted = true; return send(res, 200, {}); }
    if (u.pathname === '/free' && req.method === 'POST') { state.freed = body; return send(res, 200, {}); }
    return send(res, 404, { error: 'not found' });
  });
  const port = await listen(server, opts.port);
  return { server, port, base: `http://127.0.0.1:${port}`, seen, state, close: () => new Promise((r) => server.close(r)) };
}

// A plain HTTP server that is not SD (to check "unknown") and one that refuses.
async function fakeOther(opts = {}) {
  const server = http.createServer((req, res) => send(res, 200, '<html><head><title>My Router</title></head></html>'));
  const port = await listen(server, opts.port);
  return { server, port, base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}
async function freePort() { const s = http.createServer(); const p = await listen(s); await new Promise((r) => s.close(r)); return p; }

module.exports = { fakeA1111, fakeComfy, fakeOther, freePort, PNG_B64, PNG, A1111_ERRORS, VAE_MISSING };
