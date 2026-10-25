'use strict';
/*
 * sd-backends.js — talk to whatever Stable Diffusion app the user runs.
 *
 * Two families of local servers are supported:
 *   • "a1111" — Automatic1111 and everything that kept its API: SD WebUI Forge,
 *     reForge, SD.Next. JSON over /sdapi/v1/* (txt2img, img2img, sd-models,
 *     loras, samplers, schedulers, sd-vae, embeddings, options, progress,
 *     interrupt). Only there when the WebUI was started with --api.
 *   • "comfy" — ComfyUI. No txt2img endpoint: we POST a small workflow graph to
 *     /prompt (checkpoint → [LoRA…] → CLIP text encode ± → KSampler → VAE
 *     decode → SaveImage), poll /history/<id>, then fetch each picture from
 *     /view. Lists come from /object_info/<Node>; progress from /queue (and the
 *     /ws socket when the runtime has a WebSocket); cancel = /interrupt plus
 *     removing the job from /queue.
 *
 * Also: detect() probes the usual localhost ports and says WHICH app answers —
 * including the classic mistake of a WebUI started without --api, with the exact
 * fix for Stability Matrix and for webui-user.bat.
 *
 * Electron-free; every network call takes a base URL, so the unit tests drive
 * it against fake A1111 / ComfyUI servers.
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const sdParams = require('./sd-params');

const deps = { http, https };
function configure(patch) { if (patch && patch.http) deps.http = patch.http; if (patch && patch.https) deps.https = patch.https; }

// ---------------------------------------------------------------- HTTP helper
// Resolves (never rejects) { ok, status, json, text, buffer, error }.
// error: REFUSED | TIMEOUT | BAD_URL | HTTP_<code> | <node error code>.
function request(method, url, opts = {}) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch { return resolve({ ok: false, error: 'BAD_URL' }); }
    const lib = u.protocol === 'https:' ? deps.https : deps.http;
    const ms = Math.max(200, opts.timeoutMs || 15000);
    const payload = opts.body === undefined ? null : (Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)));
    const headers = { Accept: opts.binary ? '*/*' : 'application/json' };
    if (payload) { headers['Content-Type'] = opts.contentType || 'application/json'; headers['Content-Length'] = payload.length; }
    const maxBytes = opts.maxBytes || 256 * 1024 * 1024;
    let done = false, req = null;
    const timer = setTimeout(() => { try { req && req.destroy(); } catch {} finish({ ok: false, error: 'TIMEOUT' }); }, ms);
    function finish(r) { if (done) return; done = true; clearTimeout(timer); resolve(r); }
    try {
      req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method, headers, agent: false }, (res) => {
        const chunks = []; let size = 0;
        res.on('data', (c) => { size += c.length; if (size <= maxBytes) chunks.push(c); });
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const status = res.statusCode || 0;
          const out = { ok: status >= 200 && status < 300, status, headers: res.headers, buffer };
          if (!opts.binary) {
            out.text = buffer.toString('utf8');
            try { out.json = JSON.parse(out.text); } catch { out.json = undefined; }
          }
          if (!out.ok) out.error = `HTTP_${status}`;
          finish(out);
        });
        res.on('error', (e) => finish({ ok: false, error: String((e && e.code) || e) }));
      });
      req.on('error', (e) => finish({ ok: false, error: e && e.code === 'ECONNREFUSED' ? 'REFUSED' : String((e && (e.code || e.message)) || e) }));
      if (payload) req.write(payload);
      req.end();
    } catch (e) { finish({ ok: false, error: String((e && e.message) || e) }); }
  });
}
const getJson = (url, ms) => request('GET', url, { timeoutMs: ms });
const postJson = (url, body, ms) => request('POST', url, { body, timeoutMs: ms });

function baseOf(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try { const u = new URL(/^\w+:\/\//.test(s) ? s : `http://${s}`); return `${u.protocol}//${u.host}`; } catch { return ''; }
}
function portOf(base) { try { const u = new URL(base); return Number(u.port) || (u.protocol === 'https:' ? 443 : 80); } catch { return 0; } }

// Short, safe reason out of an error body (JSON {error|detail|message} or text).
function errDetail(r) {
  if (!r) return '';
  const j = r.json;
  if (j && typeof j === 'object') {
    const pick = (v) => (v && typeof v === 'object' ? (v.message || v.msg || JSON.stringify(v)) : v);
    const parts = [pick(j.error), pick(j.detail), pick(j.message), pick(j.msg), pick(j.errors)].filter((x) => x && String(x).trim());
    const uniq = parts.filter((x, i) => parts.indexOf(x) === i);
    if (uniq.length) return uniq.slice(0, 2).join(': ').replace(/\s+/g, ' ').trim().slice(0, 400);
  }
  const s = String(r.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return s.slice(0, 400);
}

// ------------------------------------------------------------- plain English
const NO_API_HINT = {
  stabilityMatrix: 'In Stability Matrix: stop the package, click the ⚙ (gear) next to its Launch button → Launch Options → tick “API” (or type --api in “Extra launch arguments”) → Save → Launch again.',
  standalone: 'Standalone install: open webui-user.bat in Notepad, change the line to  set COMMANDLINE_ARGS=--api  (keep anything already on that line, e.g. --api --xformers), save, and start webui-user.bat again.',
};
function noApiMessage(port) {
  return `A Stable Diffusion WebUI is running on port ${port}, but its API is switched off, so AutoInjector can't send it prompts. ${NO_API_HINT.stabilityMatrix} ${NO_API_HINT.standalone}`;
}

// Turn a low-level failure into one sentence the user can act on.
function explain(err, ctx = {}) {
  const e = String((err && err.error) || err || '');
  const where = ctx.base ? ` at ${ctx.base}` : '';
  const detail = (err && err.detail) || '';
  if (/out of memory|CUDA out of memory|OutOfMemory|allocat/i.test(detail)) return 'Your graphics card ran out of memory. Try a smaller size (512×512 for SD1.5, 1024×1024 for SDXL), batch 1, or fewer LoRAs. In A1111 add --medvram to the launch options (Forge manages memory by itself).';
  if (e === 'REFUSED') return `Nothing is answering${where}. Start your Stable Diffusion app (Stability Matrix → Launch, or webui-user.bat / ComfyUI), wait until it says it is running, then press Connect again.`;
  if (e === 'ECONNRESET' || e === 'EPIPE' || /socket hang up/i.test(e)) return `The image server${where} closed the connection — it may have crashed or been closed. Look at its window (or Stability Matrix) for an error, start it again, then press Connect.`;
  if (e === 'TIMEOUT') return `The image server${where} took too long to answer. The first picture after starting can take a few minutes while the model loads — try again, or raise the time limit.`;
  if (e === 'BAD_URL') return 'That address doesn\'t look right. It should look like http://127.0.0.1:7860 (Forge/A1111) or http://127.0.0.1:8188 (ComfyUI).';
  if (e === 'NO_API') return noApiMessage(ctx.port || portOf(ctx.base) || 7860);
  if (e === 'NEED_PROMPT') return 'Type a prompt first.';
  if (e === 'IMAGE_DISABLED') return 'Image generation is switched off. Press Connect (or tick “Enable image generation”) first.';
  if (e === 'NO_ENDPOINT') return 'No Stable Diffusion app is connected yet. Press Find my SD app, or type its address and press Connect.';
  if (e === 'CANCELLED') return 'Stopped.';
  if (e === 'COMFY_ERROR' || e === 'COMFY_REJECTED') return `ComfyUI couldn't run the picture: ${detail || 'unknown error'}`;
  if (e === 'NO_CHECKPOINT') return 'ComfyUI has no checkpoint (model) to use. Put a .safetensors model into its models/checkpoints folder (Stability Matrix: Data/Models/StableDiffusion), press Refresh, and pick it.';
  if (e === 'NO_IMAGE') return (err && err.message) || 'The image server answered, but sent no picture back.';
  if (/^HTTP_404/.test(e)) return `The image server${where} doesn't know that request (404). If it's a WebUI, it may have been started without --api. ${NO_API_HINT.stabilityMatrix}`;
  if (/^HTTP_5/.test(e)) return `The image server reported an error${detail ? `: ${detail}` : ` (${e})`}.`;
  if (/^HTTP_/.test(e)) return `The image server said no (${e})${detail ? `: ${detail}` : ''}.`;
  return e ? `Image generation failed: ${e}${detail ? ` — ${detail}` : ''}` : 'Image generation failed.';
}

// ---------------------------------------------------------- identify / detect
const DETECT_PORTS = [7860, 7861, 7862, 7863, 7864, 7865, 8188, 8000, 8888, 9090];

function _title(html) {
  const s = String(html || '');
  const m = s.match(/<title>([^<]{1,120})<\/title>/i) || s.match(/"title"\s*:\s*"([^"]{1,120})"/);
  return m ? m[1].trim() : '';
}

// Which A1111-family app is this? Best effort, from options/cmd-flags/version.
async function _a1111Flavor(base, ms) {
  const [ver, opts, flags] = await Promise.all([
    getJson(`${base}/sdapi/v1/version`, ms),
    getJson(`${base}/sdapi/v1/options`, ms),
    getJson(`${base}/sdapi/v1/cmd-flags`, ms),
  ]);
  const o = (opts.ok && opts.json && typeof opts.json === 'object') ? opts.json : {};
  const f = (flags.ok && flags.json && typeof flags.json === 'object') ? flags.json : {};
  let flavor = 'Automatic1111';
  const vapp = ver.ok && ver.json && (ver.json.app || ver.json.name);
  if (vapp && /next|vlad/i.test(String(vapp))) flavor = 'SD.Next';
  else if (Object.keys(o).some((k) => /^forge_/.test(k)) || Object.keys(f).some((k) => /forge|cuda_malloc|pin_shared_memory|always_offload_from_vram/i.test(k))) {
    flavor = Object.keys(f).some((k) => /reforge/i.test(k)) || /reforge/i.test(JSON.stringify(o.forge_preset || '')) ? 'reForge' : 'Forge';
  }
  return { flavor, model: o.sd_model_checkpoint || '', vae: o.sd_vae || '' };
}

// Identify what (if anything) answers at one base URL.
// → { base, port, kind: 'a1111'|'comfy'|'webui-no-api'|'fooocus'|'fooocus-api'|'unknown'|'none', label, model, usable, message }
async function identify(rawBase, opts = {}) {
  const base = baseOf(rawBase);
  const ms = opts.timeoutMs || 2000;
  const port = portOf(base);
  if (!base) return { base: String(rawBase || ''), port: 0, kind: 'none', usable: false, error: 'BAD_URL', message: explain('BAD_URL') };
  const [models, comfy] = await Promise.all([getJson(`${base}/sdapi/v1/sd-models`, ms), getJson(`${base}/system_stats`, ms)]);
  if (models.ok && Array.isArray(models.json)) {
    const fl = await _a1111Flavor(base, ms);
    const model = fl.model || (models.json[0] && (models.json[0].title || models.json[0].model_name)) || '';
    return { base, port, kind: 'a1111', flavor: fl.flavor, label: fl.flavor, model, vae: fl.vae, models: models.json.length, usable: true,
      message: `Connected to ${fl.flavor} on :${port}${model ? ` — model ${model}` : ''}` };
  }
  if (comfy.ok && comfy.json && typeof comfy.json === 'object' && (comfy.json.system || comfy.json.devices)) {
    const sys = comfy.json.system || {};
    const dev = Array.isArray(comfy.json.devices) && comfy.json.devices[0] ? comfy.json.devices[0].name : '';
    return { base, port, kind: 'comfy', flavor: 'ComfyUI', label: 'ComfyUI', version: sys.comfyui_version || '', device: dev || '', usable: true,
      message: `Connected to ComfyUI on :${port}${sys.comfyui_version ? ` (v${sys.comfyui_version})` : ''}` };
  }
  if (models.error === 'REFUSED' && comfy.error === 'REFUSED') return { base, port, kind: 'none', usable: false, error: 'REFUSED', message: explain('REFUSED', { base }) };
  if (models.error === 'TIMEOUT' && comfy.error === 'TIMEOUT') return { base, port, kind: 'none', usable: false, error: 'TIMEOUT', message: explain('TIMEOUT', { base }) };
  // Something answers HTTP. Fooocus-API? A WebUI without --api? Fooocus itself?
  const [root, ping] = await Promise.all([request('GET', `${base}/`, { timeoutMs: ms }), getJson(`${base}/ping`, ms)]);
  if (ping.ok && /pong/i.test(String(ping.text || ''))) {
    return { base, port, kind: 'fooocus-api', label: 'Fooocus-API', usable: false, message: `Fooocus-API answers on :${port}, but AutoInjector can't drive Fooocus yet. In Stability Matrix add “SD WebUI Forge” or “ComfyUI” as a package and launch that instead (they share the same models).` };
  }
  const html = root.text || '';
  const title = _title(html);
  if (/fooocus/i.test(title) || /fooocus/i.test(html.slice(0, 20000))) {
    return { base, port, kind: 'fooocus', label: 'Fooocus', usable: false, message: `Fooocus is running on :${port}. Fooocus has no image API that AutoInjector can use. In Stability Matrix add “SD WebUI Forge” or “ComfyUI” as a package (they share the same models) and launch that.` };
  }
  const looksWebui = /gradio|stable diffusion|stable-diffusion|webui|forge|sd\.next/i.test(title + ' ' + html.slice(0, 20000));
  if ((root.ok || root.status) && looksWebui && (models.status === 404 || models.status === 405)) {
    return { base, port, kind: 'webui-no-api', label: title || 'Stable Diffusion WebUI', usable: false, error: 'NO_API', fix: NO_API_HINT, message: noApiMessage(port) };
  }
  if (root.ok || root.status) return { base, port, kind: 'unknown', label: title || 'unknown web app', usable: false, message: `Something answers on :${port}${title ? ` (“${title}”)` : ''}, but it isn't a Stable Diffusion API AutoInjector knows.` };
  return { base, port, kind: 'none', usable: false, error: models.error || comfy.error || 'ERROR', message: explain(models.error || 'REFUSED', { base }) };
}

// Probe the usual localhost ports in parallel. Usable backends first.
async function detect(opts = {}) {
  const host = opts.host || '127.0.0.1';
  const ports = Array.isArray(opts.ports) && opts.ports.length ? opts.ports : DETECT_PORTS;
  const all = await Promise.all(ports.map((p) => identify(`http://${host}:${p}`, { timeoutMs: opts.timeoutMs || 1500 }).catch(() => null)));
  const seen = all.filter((r) => r && r.kind !== 'none' && r.kind !== 'unknown');
  const rank = { a1111: 0, comfy: 1, 'webui-no-api': 2, fooocus: 3, 'fooocus-api': 4 };
  seen.sort((a, b) => (rank[a.kind] - rank[b.kind]) || (a.port - b.port));
  const found = seen.filter((r) => r.usable);
  const problems = seen.filter((r) => !r.usable);
  let message;
  if (found.length) message = found[0].message;
  else if (problems.length) message = problems[0].message;
  else message = 'No Stable Diffusion app found on this PC (checked ports ' + ports.join(', ') + '). Start Forge, A1111 or ComfyUI (e.g. from Stability Matrix) and press Find again — or type its address.';
  return { ok: true, found, problems, best: found[0] || null, message, checked: ports.length };
}

// ------------------------------------------------------------------- prompts
// <lora:name:weight> tags in a prompt → [{name, weight}] and the prompt without them.
const LORA_RE = /<lora:([^:>]+)(?::(-?[\d.]+))?(?::[^>]*)?>/gi;
function parseLoraTags(prompt) {
  const loras = [];
  const clean = String(prompt || '').replace(LORA_RE, (_m, name, w) => { loras.push({ name: name.trim(), weight: w == null || w === '' ? 1 : Number(w) }); return ' '; })
    .replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').trim();
  return { prompt: clean, loras };
}
function _fmtW(w) { const n = Number(w); return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '1'; }
function loraTag(name, weight) { return `<lora:${String(name).replace(/[<>:]/g, '')}:${_fmtW(weight == null ? 1 : weight)}>`; }
function _stem(name) { return String(name || '').replace(/\\/g, '/').split('/').pop().replace(/\.(safetensors|ckpt|pt|pth|bin)$/i, ''); }

// A1111: add a <lora:…> tag per selected LoRA that isn't already in the prompt.
function a1111Prompt(prompt, loras) {
  let p = String(prompt || '').trim();
  const have = new Set(parseLoraTags(p).loras.map((l) => _stem(l.name).toLowerCase()));
  for (const l of loras || []) {
    if (!l || !l.name) continue;
    const st = _stem(l.name);
    if (have.has(st.toLowerCase())) continue;
    p = `${p}${p ? ' ' : ''}${loraTag(st, l.weight)}`;
    have.add(st.toLowerCase());
  }
  return p;
}

// A1111 sampler label ↔ ComfyUI sampler + scheduler.
const SAMPLER_MAP = {
  'euler a': 'euler_ancestral', euler: 'euler', lms: 'lms', heun: 'heun', dpm2: 'dpm_2', 'dpm2 a': 'dpm_2_ancestral',
  'dpm++ 2s a': 'dpmpp_2s_ancestral', 'dpm++ 2m': 'dpmpp_2m', 'dpm++ sde': 'dpmpp_sde', 'dpm++ 2m sde': 'dpmpp_2m_sde',
  'dpm++ 3m sde': 'dpmpp_3m_sde', 'dpm fast': 'dpm_fast', 'dpm adaptive': 'dpm_adaptive', ddim: 'ddim', unipc: 'uni_pc', lcm: 'lcm',
  'dpm++ 2m sde gpu': 'dpmpp_2m_sde_gpu', 'dpm++ 3m sde gpu': 'dpmpp_3m_sde_gpu', 'euler cfg++': 'euler_cfg_pp', 'ddpm': 'ddpm',
};
const SCHED_MAP = { automatic: 'normal', normal: 'normal', karras: 'karras', exponential: 'exponential', 'sgm uniform': 'sgm_uniform', simple: 'simple', 'ddim uniform': 'ddim_uniform', beta: 'beta', uniform: 'normal' };
function toComfySampler(sampler, scheduler) {
  let s = String(sampler || '').trim();
  let sch = String(scheduler || '').trim().toLowerCase();
  const m = s.match(/\s+(karras|exponential|sgm uniform)$/i);
  if (m) { if (!sch || sch === 'automatic') sch = m[1].toLowerCase(); s = s.slice(0, m.index); }
  const key = s.toLowerCase();
  const sampler_name = SAMPLER_MAP[key] || (/^[a-z0-9_]+$/.test(s) ? s : 'euler');
  const schedulerOut = SCHED_MAP[sch] || (/^[a-z0-9_]+$/.test(sch) ? sch : 'normal');
  return { sampler_name, scheduler: schedulerOut };
}

function randomSeed() { return crypto.randomBytes(4).readUInt32LE(0); }

// ------------------------------------------------------------------- A1111
function _arr(r) { return r && r.ok && Array.isArray(r.json) ? r.json : []; }
async function a1111Lists(base, ms = 8000) {
  const [models, loras, samplers, schedulers, vaes, emb, opts] = await Promise.all([
    getJson(`${base}/sdapi/v1/sd-models`, ms), getJson(`${base}/sdapi/v1/loras`, ms), getJson(`${base}/sdapi/v1/samplers`, ms),
    getJson(`${base}/sdapi/v1/schedulers`, ms), getJson(`${base}/sdapi/v1/sd-vae`, ms), getJson(`${base}/sdapi/v1/embeddings`, ms),
    getJson(`${base}/sdapi/v1/options`, ms),
  ]);
  if (!models.ok) return { ok: false, error: models.status === 404 ? 'NO_API' : models.error, message: explain(models.status === 404 ? 'NO_API' : models.error, { base }) };
  const o = opts.ok && opts.json ? opts.json : {};
  const embLoaded = emb.ok && emb.json && emb.json.loaded ? Object.keys(emb.json.loaded) : [];
  return {
    ok: true, backend: 'a1111',
    checkpoints: _arr(models).map((m) => ({ name: m.title || m.model_name, title: m.title || m.model_name, model_name: m.model_name || '', file: m.filename || '', hash: m.hash || '' })),
    loras: _arr(loras).map((l) => ({ name: l.name, alias: l.alias || l.name, file: l.path || '', metadata: l.metadata && typeof l.metadata === 'object' ? l.metadata : {} })),
    samplers: _arr(samplers).map((s) => s.name).filter(Boolean),
    schedulers: _arr(schedulers).map((s) => s.label || s.name).filter(Boolean),
    vaes: ['Automatic', 'None'].concat(_arr(vaes).map((v) => v.model_name).filter(Boolean)),
    embeddings: embLoaded.map((n) => ({ name: n })),
    current: { checkpoint: o.sd_model_checkpoint || '', vae: o.sd_vae || '' },
  };
}

function _parseInfo(info) {
  if (!info) return {};
  if (typeof info === 'object') return info;
  try { return JSON.parse(info); } catch { return { text: String(info) }; }
}

function a1111Payload(p) {
  const body = {
    prompt: a1111Prompt(p.prompt, p.loras),
    negative_prompt: String(p.negativePrompt || ''),
    steps: p.steps, cfg_scale: p.cfgScale, width: p.width, height: p.height,
    seed: p.seed == null ? -1 : p.seed,
    batch_size: p.batchSize || 1,
    n_iter: p.batchCount || 1,
    send_images: true, save_images: false,
  };
  if (p.sampler) body.sampler_name = p.sampler;
  if (p.scheduler) body.scheduler = p.scheduler;
  const ov = {};
  if (p.checkpoint) ov.sd_model_checkpoint = p.checkpoint;
  if (p.vae) ov.sd_vae = p.vae;
  if (Object.keys(ov).length) { body.override_settings = ov; body.override_settings_restore_afterwards = true; }
  // initImage may still be a data: URL when a caller built p by hand.
  const q = p.initImage && /^data:/.test(String(p.initImage)) ? Object.assign({}, p, { initImage: String(p.initImage).replace(/^data:image\/[\w.+-]+;base64,/, '') }) : p;
  // Hires fix, refiner, img2img / inpaint, ControlNet, ADetailer, styles, scripts,
  // clip skip, override settings and validated extra fields (sd-params.js).
  return sdParams.a1111Apply(body, q);
}

async function a1111Generate(base, p, opts = {}) {
  const body = a1111Payload(p);
  const path = p.initImage ? '/sdapi/v1/img2img' : '/sdapi/v1/txt2img';
  const url = opts.endpoint && !p.initImage ? opts.endpoint : `${base}${path}`;
  const r = await postJson(url, body, opts.timeoutMs || 180000);
  if (!r.ok) {
    const out = { ok: false, error: r.status === 404 ? 'NO_API' : (r.error || 'ERROR'), detail: errDetail(r), status: r.status };
    if (r.status && r.status >= 400 && r.status !== 404) out.error = `HTTP_${r.status}`;
    out.message = explain(out, { base });
    return out;
  }
  if (!r.json || typeof r.json !== 'object') return { ok: false, error: 'BAD_JSON', message: 'The image server sent back something that isn\'t JSON.' };
  const imgs = Array.isArray(r.json.images) ? r.json.images.map((s) => String(s || '').replace(/^data:image\/\w+;base64,/, '')).filter(Boolean) : [];
  if (!imgs.length) {
    if (r.json.prompt_id) return { ok: false, error: 'NO_IMAGE', shape: 'comfy-queue', message: "ComfyUI only queued the job and didn't send an image back over this address. Choose ComfyUI as the backend (press Connect on http://127.0.0.1:8188) so AutoInjector runs its own workflow and fetches the picture." };
    return { ok: false, error: 'NO_IMAGE', message: "The image server answered, but its reply had no image in it. Check that the address is a txt2img API (e.g. http://127.0.0.1:7860/sdapi/v1/txt2img)." };
  }
  const info = _parseInfo(r.json.info);
  return { ok: true, images: imgs, info, rawInfo: r.json.info || '', seed: info.seed != null ? info.seed : p.seed, seeds: Array.isArray(info.all_seeds) ? info.all_seeds : undefined, payload: body };
}

async function a1111Progress(base) {
  const r = await getJson(`${base}/sdapi/v1/progress?skip_current_image=true`, 4000);
  if (!r.ok || !r.json) return { ok: false, error: r.error };
  const st = r.json.state || {};
  return { ok: true, progress: Number(r.json.progress) || 0, etaSeconds: Number(r.json.eta_relative) || 0, step: st.sampling_step || 0, steps: st.sampling_steps || 0, job: st.job || '', jobCount: st.job_count || 0, text: r.json.textinfo || '' };
}
async function a1111Interrupt(base) { const r = await postJson(`${base}/sdapi/v1/interrupt`, {}, 5000); return { ok: r.ok, error: r.ok ? null : r.error }; }

// ------------------------------------------------------------------- ComfyUI
// /object_info input spec → list of choices. Old shape [[...], {...}]; new
// shape ["COMBO", {options:[...]}].
function comboOptions(spec) {
  if (!Array.isArray(spec)) return [];
  if (Array.isArray(spec[0])) return spec[0].map(String);
  if (spec[0] === 'COMBO' && spec[1] && Array.isArray(spec[1].options)) return spec[1].options.map(String);
  return [];
}
function _input(info, node, name) {
  const n = info && info[node];
  const req = n && n.input && (n.input.required || {});
  const opt = n && n.input && (n.input.optional || {});
  return comboOptions((req && req[name]) || (opt && opt[name]));
}
// Optional nodes whose presence decides what the built-in graph can do.
const COMFY_FEATURE_NODES = ['UpscaleModelLoader', 'ControlNetLoader', 'ControlNetApplyAdvanced', 'CLIPSetLastLayer', 'AIO_Preprocessor', 'KSamplerAdvanced', 'VAEEncodeForInpaint', 'LoadImageMask'];
async function comfyLists(base, ms = 8000) {
  const nodes = ['CheckpointLoaderSimple', 'LoraLoader', 'VAELoader', 'KSampler', ...COMFY_FEATURE_NODES];
  const rs = await Promise.all(nodes.map((n) => getJson(`${base}/object_info/${n}`, ms)));
  if (!rs[0].ok) return { ok: false, error: rs[0].error, message: explain(rs[0], { base }) };
  const info = Object.assign({}, ...rs.map((r) => (r.ok && r.json && typeof r.json === 'object' ? r.json : {})));
  const emb = await getJson(`${base}/embeddings`, ms);
  const preprocessors = _input(info, 'AIO_Preprocessor', 'preprocessor');
  return {
    ok: true, backend: 'comfy',
    checkpoints: _input(info, 'CheckpointLoaderSimple', 'ckpt_name').map((n) => ({ name: n, title: n })),
    loras: _input(info, 'LoraLoader', 'lora_name').map((n) => ({ name: n, alias: _stem(n), file: '' })),
    vaes: ['Automatic'].concat(_input(info, 'VAELoader', 'vae_name')),
    samplers: _input(info, 'KSampler', 'sampler_name'),
    schedulers: _input(info, 'KSampler', 'scheduler'),
    embeddings: (emb.ok && Array.isArray(emb.json) ? emb.json : []).map((n) => ({ name: String(n) })),
    upscalers: ['Latent', 'Latent (bilinear)', 'Latent (bicubic)', 'Latent (area)'].concat(_input(info, 'UpscaleModelLoader', 'model_name')),
    upscaleModels: _input(info, 'UpscaleModelLoader', 'model_name'),
    controlnets: _input(info, 'ControlNetLoader', 'control_net_name'),
    preprocessors: preprocessors.length ? ['none', ...preprocessors] : ['none'],
    nodes: nodes.filter((n) => info[n]),
    current: { checkpoint: '', vae: '' },
  };
}

// Pick ComfyUI's own spelling for a name (it wants the path relative to the
// models folder, e.g. "Styles\\ink.safetensors"); match on the bare stem too.
function resolveName(list, name) {
  if (!name) return '';
  const arr = (list || []).map((x) => (typeof x === 'string' ? x : x.name));
  if (arr.includes(name)) return name;
  const want = _stem(name).toLowerCase();
  const hit = arr.find((x) => _stem(x).toLowerCase() === want);
  return hit || (arr.length ? '' : name);
}

// The built-in graph (API format): checkpoint → LoRA chain → [CLIP skip] → CLIP
// text encode ± → [ControlNet] → empty latent | encoded init picture (+ mask)
// → KSampler (or base + refiner KSamplerAdvanced) → [hires fix] → VAE decode →
// SaveImage. Plain txt2img keeps the classic node ids (4, 6, 7, 5, 3, 8, 9).
function buildComfyWorkflow(p) { return sdParams.buildComfyGraph(p, toComfySampler); }

// ComfyUI's 400 body → one plain sentence.
function comfyRejectReason(json) {
  if (!json || typeof json !== 'object') return '';
  const parts = [];
  const ne = json.node_errors || {};
  for (const k of Object.keys(ne)) {
    for (const e of (ne[k] && ne[k].errors) || []) {
      const det = String(e.details || e.message || '');
      const m = det.match(/^(\w+):\s*'([^']*)'\s*not in/);
      if (e.type === 'value_not_in_list' || m) parts.push(`ComfyUI doesn't have “${m ? m[2] : det}” (${(ne[k].class_type || 'node')}${m ? `, ${m[1]}` : ''}) — press Refresh and pick one from the list`);
      else parts.push(`${ne[k].class_type || 'node'}: ${e.message || ''}${det ? ` (${det})` : ''}`);
    }
  }
  if (!parts.length && json.error) parts.push(typeof json.error === 'object' ? (json.error.message || json.error.type || '') + (json.error.details ? ` (${json.error.details})` : '') : String(json.error));
  return parts.join('; ').slice(0, 500);
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Upload a picture into ComfyUI's input folder (POST /upload/image, multipart).
// → { ok, name } where name is what LoadImage wants ("sub/file.png").
async function comfyUpload(base, b64, filename, opts = {}) {
  const boundary = `----AutoInjector${crypto.randomBytes(8).toString('hex')}`;
  const safe = String(filename || 'image.png').replace(/[^\w.-]+/g, '_').slice(0, 120) || 'image.png';
  const parts = [];
  const field = (name, value) => parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${safe}"\r\nContent-Type: image/png\r\n\r\n`));
  parts.push(Buffer.from(String(b64 || ''), 'base64'));
  parts.push(Buffer.from('\r\n'));
  field('type', opts.type || 'input');
  field('overwrite', 'true');
  if (opts.subfolder) field('subfolder', opts.subfolder);
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const r = await request('POST', `${base}/upload/image`, { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}`, timeoutMs: opts.timeoutMs || 60000 });
  if (!r.ok || !r.json || !r.json.name) return { ok: false, error: r.error || 'UPLOAD_FAILED', detail: errDetail(r), message: `ComfyUI didn't accept the picture upload${errDetail(r) ? `: ${errDetail(r)}` : ''}.` };
  return { ok: true, name: r.json.subfolder ? `${r.json.subfolder}/${r.json.name}` : r.json.name, type: r.json.type || 'input' };
}

// Queue any API-format graph, wait for it, download every output picture.
// → { ok, images[], promptId, outputs } | { ok:false, error, message }
async function comfyRunGraph(base, graph, opts = {}) {
  const job = opts.job || {};
  const timeoutMs = opts.timeoutMs || 180000;
  const pollMs = opts.pollMs || 600;
  const clientId = job.clientId || crypto.randomUUID();
  job.clientId = clientId;
  _comfySocket(base, clientId, job);
  const q = await postJson(`${base}/prompt`, { prompt: graph, client_id: clientId }, 20000);
  if (!q.ok || !q.json || !q.json.prompt_id) {
    job.closeWs && job.closeWs();
    const detail = comfyRejectReason(q.json) || errDetail(q);
    const out = { ok: false, error: q.status === 400 ? 'COMFY_REJECTED' : (q.error || 'COMFY_ERROR'), detail };
    out.message = explain(out, { base });
    return out;
  }
  const promptId = q.json.prompt_id;
  job.promptId = promptId;
  const t0 = Date.now();
  try {
    while (Date.now() - t0 < timeoutMs) {
      if (job.cancelled) return { ok: false, error: 'CANCELLED', message: explain('CANCELLED') };
      const h = await getJson(`${base}/history/${encodeURIComponent(promptId)}`, 10000);
      const entry = h.ok && h.json && h.json[promptId];
      if (entry) {
        const st = entry.status || {};
        if (st.status_str === 'error') {
          const msg = (st.messages || []).find((m) => m && m[0] === 'execution_error');
          const d = msg && msg[1] ? `${msg[1].node_type || ''}: ${msg[1].exception_message || ''}`.trim() : 'the workflow failed';
          if (/interrupt/i.test(d) || (st.messages || []).some((m) => m && m[0] === 'execution_interrupted')) return { ok: false, error: 'CANCELLED', message: explain('CANCELLED') };
          const out = { ok: false, error: 'COMFY_ERROR', detail: d };
          out.message = explain(out, { base });
          return out;
        }
        if ((st.messages || []).some((m) => m && m[0] === 'execution_interrupted')) return { ok: false, error: 'CANCELLED', message: explain('CANCELLED') };
        const outputs = entry.outputs || {};
        const files = [];
        for (const nid of Object.keys(outputs)) for (const im of outputs[nid].images || []) if (im && im.type !== 'temp') files.push(im);
        if (!files.length) for (const nid of Object.keys(outputs)) for (const im of outputs[nid].images || []) files.push(im);
        if (files.length || st.completed) {
          const images = [];
          for (const f of files) {
            const qs = `filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder || '')}&type=${encodeURIComponent(f.type || 'output')}`;
            const v = await request('GET', `${base}/view?${qs}`, { binary: true, timeoutMs: 30000 });
            if (v.ok && v.buffer && v.buffer.length) images.push(v.buffer.toString('base64'));
          }
          if (!images.length) return { ok: false, error: 'NO_IMAGE', message: opts.allowNoImage ? 'The workflow ran but made no picture.' : 'ComfyUI finished but AutoInjector could not download the picture from it (/view).', promptId, outputs };
          return { ok: true, images, promptId, outputs };
        }
      }
      await _sleep(pollMs);
    }
    return { ok: false, error: 'TIMEOUT', message: explain('TIMEOUT', { base }) };
  } finally { job.closeWs && job.closeWs(); }
}

// Resolve names, upload pictures, refuse what ComfyUI can't do → the graph.
// → { ok, graph, params, missing, seed } | { ok:false, … }
async function comfyPrepare(base, p, opts = {}) {
  const tagged = parseLoraTags(p.prompt);
  const lists = opts.lists || await comfyLists(base);
  if (!lists.ok) return { ok: false, error: lists.error, message: lists.message };
  const nodes = Array.isArray(lists.nodes) ? new Set([...lists.nodes, 'CheckpointLoaderSimple', 'LoraLoader', 'VAELoader', 'KSampler']) : null;
  const unsup = sdParams.unsupportedOn('comfy', p, { nodes });
  if (unsup) return unsup;
  const loras = [];
  const missing = [];
  for (const l of [...tagged.loras, ...(p.loras || [])]) {
    const nm = resolveName(lists.loras, l.name);
    if (!nm) { missing.push(l.name); continue; }
    if (!loras.some((x) => x.name === nm)) loras.push({ name: nm, weight: l.weight });
  }
  let ckpt = p.checkpoint ? resolveName(lists.checkpoints, p.checkpoint) : '';
  if (!ckpt) ckpt = (lists.checkpoints[0] && lists.checkpoints[0].name) || '';
  if (!ckpt) return { ok: false, error: 'NO_CHECKPOINT', message: explain('NO_CHECKPOINT') };
  const vae = p.vae ? resolveName(lists.vaes, p.vae) : '';
  const seed = p.seed == null || Number(p.seed) < 0 ? randomSeed() : Math.floor(Number(p.seed));
  const params = Object.assign({}, p, { prompt: tagged.prompt, loras, checkpoint: ckpt, vae, seed });
  const bad = (field, value, list) => ({ ok: false, error: 'UNKNOWN_VALUE', code: 'UNKNOWN_VALUE', field, message: `ComfyUI doesn't have ${field} “${value}”.`, hint: list && list.length ? `Choose one of: ${list.slice(0, 12).join(', ')}` : 'Put the file into the matching ComfyUI models folder and press Refresh.' });
  if (p.refiner && p.refiner.checkpoint) {
    const r = resolveName(lists.checkpoints, p.refiner.checkpoint);
    if (!r || (lists.checkpoints.length && !lists.checkpoints.some((c) => c.name === r))) return bad('refiner.checkpoint', p.refiner.checkpoint, lists.checkpoints.map((c) => c.name));
    params.refiner = Object.assign({}, p.refiner, { checkpoint: r });
  }
  if (p.hires) {
    params.hires = Object.assign({}, p.hires);
    const up = p.hires.upscaler;
    if (up && !sdParams.latentMethod(up)) {
      const m = resolveName(lists.upscaleModels || [], up);
      if (!m || !(lists.upscaleModels || []).includes(m)) return bad('hires.upscaler', up, lists.upscalers);
      params.hires.upscalerModel = m;
    }
  }
  if (p.controlnet) {
    params.controlnet = [];
    for (let i = 0; i < p.controlnet.length; i++) {
      const u = Object.assign({}, p.controlnet[i]);
      const m = resolveName(lists.controlnets || [], u.model);
      if (!u.model || !m || !(lists.controlnets || []).includes(m)) return bad(`controlnet[${i}].model`, u.model || '(none)', lists.controlnets);
      u.model = m;
      if (u.module && !/^none$/i.test(u.module) && Array.isArray(lists.preprocessors) && lists.preprocessors.length > 1 && !lists.preprocessors.includes(u.module)) return bad(`controlnet[${i}].module`, u.module, lists.preprocessors);
      params.controlnet.push(u);
    }
  }
  // Pictures go into ComfyUI's input folder first.
  const stamp = Date.now().toString(36);
  const up = async (b64, name) => { const r = await comfyUpload(base, b64, name); if (!r.ok) throw Object.assign(new Error(r.message), { result: r }); return r.name; };
  try {
    if (p.initImage) params.initImageName = await up(p.initImage, `autoinjector-init-${stamp}.png`);
    if (p.mask) params.maskName = await up(p.mask, `autoinjector-mask-${stamp}.png`);
    if (params.controlnet) for (let i = 0; i < params.controlnet.length; i++) if (params.controlnet[i].image) params.controlnet[i].imageName = await up(params.controlnet[i].image, `autoinjector-cn${i}-${stamp}.png`);
  } catch (e) { return e.result || { ok: false, error: 'UPLOAD_FAILED', message: String(e.message || e) }; }
  return { ok: true, graph: buildComfyWorkflow(params), params, missing, seed, lists };
}

async function comfyGenerate(base, p, opts = {}) {
  const prep = await comfyPrepare(base, p, opts);
  if (!prep.ok) return prep;
  const r = await comfyRunGraph(base, prep.graph, opts);
  if (!r.ok) return r;
  const pp = prep.params;
  return { ok: true, images: r.images, seed: prep.seed, promptId: r.promptId, info: { seed: prep.seed, prompt: pp.prompt, checkpoint: pp.checkpoint, loras: pp.loras }, missingLoras: prep.missing, workflow: prep.graph };
}

// Live step progress from ComfyUI's websocket, when this runtime has one.
function _comfySocket(base, clientId, job) {
  try {
    if (typeof globalThis.WebSocket !== 'function' || job.noWs) return;
    const ws = new globalThis.WebSocket(`${base.replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`);
    job.closeWs = () => { try { ws.close(); } catch {} };
    ws.onmessage = (ev) => {
      try {
        if (typeof ev.data !== 'string') return;
        const m = JSON.parse(ev.data);
        if (m.type === 'progress' && m.data && (!job.promptId || !m.data.prompt_id || m.data.prompt_id === job.promptId)) {
          job.step = m.data.value; job.steps = m.data.max;
        }
      } catch {}
    };
    ws.onerror = () => {};
  } catch { /* progress just falls back to /queue */ }
}

async function comfyProgress(base, job) {
  const out = { ok: true, progress: 0, step: (job && job.step) || 0, steps: (job && job.steps) || 0, job: '' };
  if (out.steps) out.progress = Math.min(1, out.step / out.steps);
  const q = await getJson(`${base}/queue`, 4000);
  if (q.ok && q.json) {
    const id = job && job.promptId;
    const running = (q.json.queue_running || []).some((e) => Array.isArray(e) && e[1] === id);
    const pendingIdx = (q.json.queue_pending || []).findIndex((e) => Array.isArray(e) && e[1] === id);
    out.job = running ? 'running' : pendingIdx >= 0 ? `queued (${pendingIdx} ahead)` : '';
    out.queueRunning = (q.json.queue_running || []).length;
    out.queuePending = (q.json.queue_pending || []).length;
  }
  return out;
}
async function comfyInterrupt(base, job) {
  const id = job && job.promptId;
  const [a, b] = await Promise.all([
    postJson(`${base}/interrupt`, id ? { prompt_id: id } : {}, 5000),
    id ? postJson(`${base}/queue`, { delete: [id] }, 5000) : Promise.resolve({ ok: true }),
  ]);
  return { ok: !!(a.ok || b.ok), error: a.ok ? null : a.error };
}

module.exports = {
  configure, request, baseOf, portOf, errDetail, explain, noApiMessage, NO_API_HINT,
  identify, detect, DETECT_PORTS,
  parseLoraTags, loraTag, a1111Prompt, toComfySampler, randomSeed,
  a1111Lists, a1111Payload, a1111Generate, a1111Progress, a1111Interrupt,
  comboOptions, comfyLists, resolveName, buildComfyWorkflow, comfyRejectReason, comfyGenerate, comfyProgress, comfyInterrupt,
  comfyUpload, comfyRunGraph, comfyPrepare, COMFY_FEATURE_NODES, getJson, postJson,
};
