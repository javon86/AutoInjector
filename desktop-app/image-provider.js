'use strict';
// image-provider.js — the butler's image-generation capability. Like the manager
// and Open Interpreter, the image model is NOT bundled (it needs a GPU): it's a
// configurable local HTTP endpoint. This targets the Automatic1111 / Forge
// txt2img API (the easiest SD backend to run locally), returning base64 PNGs —
// exactly the shape STABLE_DIFFUSION_PLAN.md describes.
//
// Transport contract (small + tolerant):
//   POST <endpoint>  body { prompt, steps, width, height, negative_prompt }
//   response: { images: ["<base64 png>", ...], info?: "..." }   (A1111 shape)
// The endpoint is the full txt2img URL, e.g. http://127.0.0.1:7860/sdapi/v1/txt2img.
// The provider returns the raw base64; the caller (main.js) saves the PNG to the
// output folder and records it as a project image — so this module stays pure and
// unit-testable with no filesystem/db dependency.
const http = require('http');
const https = require('https');
const { URL } = require('url');

let settings = {
  enabled: false,
  endpoint: '',    // e.g. http://127.0.0.1:7860/sdapi/v1/txt2img  (A1111/Forge)
  model: '',       // informational; the checkpoint is selected on the SD side
  steps: 20,
  width: 512,
  height: 512,
  timeoutMs: 180000,
};

function getSettings() { return { ...settings }; }
function setSettings(patch) {
  if (!patch || typeof patch !== 'object') return getSettings();
  if ('enabled' in patch) settings.enabled = !!patch.enabled;
  for (const k of ['endpoint', 'model']) if (k in patch) settings[k] = String(patch[k] || '');
  for (const k of ['steps', 'width', 'height']) {
    if (k in patch) { const n = Number(patch[k]); if (Number.isFinite(n) && n > 0) settings[k] = Math.round(n); }
  }
  if ('timeoutMs' in patch) settings.timeoutMs = Math.max(5000, Number(patch.timeoutMs) || settings.timeoutMs);
  return getSettings();
}
function status() {
  return { configured: !!settings.endpoint, enabled: !!settings.enabled, endpoint: settings.endpoint, model: settings.model, steps: settings.steps, width: settings.width, height: settings.height };
}

// Strip a possible data-URI prefix so callers always get raw base64.
function _cleanBase64(s) { return String(s || '').replace(/^data:image\/\w+;base64,/, ''); }

// Generate one image from a prompt. Resolves { ok, imageBase64, info, error }.
function generate(prompt, opts = {}) {
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  return new Promise((resolve) => {
    const p = String(prompt || '').trim();
    if (!p) return resolve({ ok: false, error: 'NEED_PROMPT' });
    if (!settings.enabled) return resolve({ ok: false, error: 'IMAGE_DISABLED' });
    if (!settings.endpoint) return resolve({ ok: false, error: 'NO_ENDPOINT' });

    let url; try { url = new URL(settings.endpoint); } catch { return resolve({ ok: false, error: 'BAD_ENDPOINT' }); }
    const lib = url.protocol === 'https:' ? https : http;
    const payload = JSON.stringify({
      prompt: p,
      negative_prompt: String(opts.negativePrompt || ''),
      steps: settings.steps,
      width: settings.width,
      height: settings.height,
    });
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Accept: 'application/json' };
    onEvent({ type: 'image-start', content: p });

    let settled = false;
    const finish = (out) => { if (settled) return; settled = true; try { req.destroy(); } catch {} resolve(out); };
    const req = lib.request(
      { hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search, method: 'POST', headers, timeout: settings.timeoutMs },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) { res.resume(); return finish({ ok: false, error: `HTTP_${res.statusCode}` }); }
        let buf = ''; res.setEncoding('utf8');
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          let j; try { j = JSON.parse(buf || '{}'); } catch { return finish({ ok: false, error: 'BAD_JSON' }); }
          const img = Array.isArray(j.images) && j.images.length ? _cleanBase64(j.images[0]) : '';
          if (!img) return finish({ ok: false, error: 'NO_IMAGE' });
          onEvent({ type: 'image', content: `${img.length} base64 chars` });
          finish({ ok: true, imageBase64: img, info: j.info || '' });
        });
        res.on('error', (e) => finish({ ok: false, error: String((e && e.message) || e) }));
      }
    );
    req.on('error', (e) => finish({ ok: false, error: String((e && e.code) || (e && e.message) || e) }));
    req.on('timeout', () => finish({ ok: false, error: 'TIMEOUT' }));
    req.write(payload);
    req.end();
  });
}

module.exports = { getSettings, setSettings, status, generate };
