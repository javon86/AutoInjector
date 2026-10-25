'use strict';
// fake-sd.js — tiny fake Stable Diffusion servers for the tests:
//   fakeA1111({ flavor, noApi, oom, slow })  — /sdapi/v1/* like A1111 / Forge / SD.Next
//   fakeComfy({ slow })                      — /system_stats, /object_info, /prompt, /history, /view, /queue, /interrupt
// Each resolves { server, port, base, seen, state, close() }.
const http = require('http');

// A real (valid) 1x1 PNG, built here so its chunks and CRCs are right.
function makePng() {
  const zlib = require('zlib');
  const { crc32 } = require('../../sd-images');
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const t = Buffer.from(type, 'latin1'); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 200, 30, 30]))), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = makePng();
const PNG_B64 = PNG.toString('base64');

function send(res, code, body, type) {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(code, { 'Content-Type': type || (isBuf ? 'image/png' : typeof body === 'string' ? 'text/html' : 'application/json') });
  res.end(isBuf || typeof body === 'string' ? body : JSON.stringify(body));
}
function readBody(req) { return new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { try { r(b ? JSON.parse(b) : {}); } catch { r({ __raw: b }); } }); }); }
function listen(server, port) { return new Promise((r) => server.listen(port || 0, '127.0.0.1', () => r(server.address().port))); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fakeA1111(opts = {}) {
  const seen = [];
  const state = { interrupted: false, running: false, lastTxt2img: null };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const body = req.method === 'POST' ? await readBody(req) : null;
    seen.push({ method: req.method, path: u.pathname, body });
    if (u.pathname === '/') return send(res, 200, `<!doctype html><html><head><title>${opts.title || 'Stable Diffusion'}</title><script>window.gradio_config = {"version":"3.41.2"};</script></head><body>gradio</body></html>`);
    if (u.pathname.startsWith('/sdapi/') && opts.noApi) return send(res, 404, { detail: 'Not Found' });
    switch (u.pathname) {
      case '/sdapi/v1/sd-models': return send(res, 200, [
        { title: 'dreamshaper_8.safetensors [879db523c3]', model_name: 'dreamshaper_8', hash: '879db523c3', filename: opts.ckptFile || '/models/Stable-diffusion/dreamshaper_8.safetensors' },
        { title: 'juggernautXL_v9.safetensors [c9e3e68f89]', model_name: 'juggernautXL_v9', hash: 'c9e3e68f89', filename: '/models/Stable-diffusion/juggernautXL_v9.safetensors' },
      ]);
      case '/sdapi/v1/options': return send(res, 200, Object.assign({ sd_model_checkpoint: 'dreamshaper_8.safetensors [879db523c3]', sd_vae: 'Automatic' }, opts.flavor === 'forge' ? { forge_preset: 'sd', forge_additional_modules: [] } : {}));
      case '/sdapi/v1/cmd-flags': return send(res, 200, { api: true, listen: false });
      case '/sdapi/v1/version': return opts.flavor === 'sdnext' ? send(res, 200, { app: 'sd.next', updated: '2025-01-01' }) : send(res, 404, { detail: 'Not Found' });
      case '/sdapi/v1/loras': return send(res, 200, [
        { name: 'odile_face', alias: 'odile_face', path: opts.loraFile || '/models/Lora/odile_face.safetensors', metadata: { ss_base_model_version: 'sd_v1' } },
        { name: 'xl_ink', alias: 'xl_ink', path: '/models/Lora/xl_ink.safetensors', metadata: { ss_base_model_version: 'sdxl_base_v1-0' } },
      ]);
      case '/sdapi/v1/samplers': return send(res, 200, [{ name: 'Euler a', aliases: [] }, { name: 'DPM++ 2M', aliases: [] }]);
      case '/sdapi/v1/schedulers': return send(res, 200, [{ name: 'automatic', label: 'Automatic' }, { name: 'karras', label: 'Karras' }]);
      case '/sdapi/v1/sd-vae': return send(res, 200, [{ model_name: 'vae-ft-mse-840000', filename: '/models/VAE/vae-ft-mse-840000.safetensors' }]);
      case '/sdapi/v1/embeddings': return send(res, 200, { loaded: { easynegative: { step: null } }, skipped: {} });
      case '/sdapi/v1/progress': return send(res, 200, state.running ? { progress: 0.5, eta_relative: 3.2, state: { job: 'txt2img', job_count: 1, sampling_step: 10, sampling_steps: 20 }, current_image: null, textinfo: null } : { progress: 0, eta_relative: 0, state: { job: '', sampling_step: 0, sampling_steps: 0 } });
      case '/sdapi/v1/interrupt': state.interrupted = true; return send(res, 200, {});
      case '/sdapi/v1/txt2img':
      case '/sdapi/v1/img2img': {
        state.lastTxt2img = body;
        if (opts.oom) return send(res, 500, { error: 'OutOfMemoryError', detail: 'CUDA out of memory. Tried to allocate 2.00 GiB', body: '', errors: '' });
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

async function fakeComfy(opts = {}) {
  const seen = [];
  const state = { prompts: {}, polls: 0, interrupted: false, deleted: [], lastGraph: null };
  const CKPTS = ['sd15/dreamshaper_8.safetensors', 'juggernautXL_v9.safetensors'];
  const LORAS = ['Characters\\odile_face.safetensors', 'ink_style.safetensors'];
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const body = req.method === 'POST' ? await readBody(req) : null;
    seen.push({ method: req.method, path: u.pathname, body, query: u.search });
    if (u.pathname === '/') return send(res, 200, '<!doctype html><html><head><title>ComfyUI</title></head><body></body></html>');
    if (u.pathname === '/system_stats') return send(res, 200, { system: { os: 'nt', comfyui_version: '0.3.10', python_version: '3.11' }, devices: [{ name: 'cuda:0 NVIDIA GeForce RTX 4070', type: 'cuda' }] });
    if (u.pathname === '/object_info/CheckpointLoaderSimple') return send(res, 200, { CheckpointLoaderSimple: { input: { required: { ckpt_name: [CKPTS, { tooltip: 'x' }] } } } });
    if (u.pathname === '/object_info/LoraLoader') return send(res, 200, { LoraLoader: { input: { required: { model: ['MODEL'], clip: ['CLIP'], lora_name: ['COMBO', { options: LORAS }], strength_model: ['FLOAT', {}], strength_clip: ['FLOAT', {}] } } } });
    if (u.pathname === '/object_info/VAELoader') return send(res, 200, { VAELoader: { input: { required: { vae_name: [['vae-ft-mse-840000.safetensors'], {}] } } } });
    if (u.pathname === '/object_info/KSampler') return send(res, 200, { KSampler: { input: { required: { sampler_name: [['euler', 'euler_ancestral', 'dpmpp_2m'], {}], scheduler: [['normal', 'karras', 'simple'], {}] } } } });
    if (u.pathname === '/embeddings') return send(res, 200, ['easynegative']);
    if (u.pathname === '/prompt' && req.method === 'POST') {
      const g = body.prompt || {};
      state.lastGraph = g;
      for (const [id, n] of Object.entries(g)) {
        if (n.class_type === 'CheckpointLoaderSimple' && !CKPTS.includes(n.inputs.ckpt_name)) {
          return send(res, 400, { error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '' }, node_errors: { [id]: { class_type: 'CheckpointLoaderSimple', errors: [{ type: 'value_not_in_list', message: 'Value not in list', details: `ckpt_name: '${n.inputs.ckpt_name}' not in ${JSON.stringify(CKPTS)}` }] } } });
        }
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
      if (opts.failWith) return send(res, 200, { [id]: { outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_error', { node_type: 'KSampler', exception_message: opts.failWith }]] } } });
      if (opts.slow ? true : p.polls < 2) return send(res, 200, {});
      const batch = (Object.values(p.graph).find((n) => n.class_type === 'EmptyLatentImage') || { inputs: { batch_size: 1 } }).inputs.batch_size;
      return send(res, 200, { [id]: { outputs: { 9: { images: Array.from({ length: batch }, (_, i) => ({ filename: `AutoInjector_0000${i + 1}_.png`, subfolder: '', type: 'output' })) } }, status: { status_str: 'success', completed: true, messages: [] } } });
    }
    if (u.pathname === '/view') return send(res, 200, PNG);
    if (u.pathname === '/queue' && req.method === 'GET') { const ids = Object.keys(state.prompts); return send(res, 200, { queue_running: ids.length && !state.interrupted ? [[0, ids[ids.length - 1], {}, {}, ['9']]] : [], queue_pending: [] }); }
    if (u.pathname === '/queue' && req.method === 'POST') { state.deleted.push(...((body && body.delete) || [])); return send(res, 200, {}); }
    if (u.pathname === '/interrupt') { state.interrupted = true; return send(res, 200, {}); }
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

module.exports = { fakeA1111, fakeComfy, fakeOther, freePort, PNG_B64, PNG };
