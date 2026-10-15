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
  steps: 20,       // slider: sampling steps
  cfgScale: 7,     // slider: CFG scale (prompt adherence)
  width: 512,      // slider
  height: 512,     // slider
  batchCount: 1,   // slider: how many images per Generate (n_iter)
  seed: -1,        // -1 = random each time
  timeoutMs: 180000,
};

// E07: a saved endpoint of a bare host (http://127.0.0.1:7860) returns 405 —
// A1111 needs the full txt2img path. Normalize the common shapes so a reachable
// host that isn't the generate URL becomes one, instead of failing at render
// time. A non-A1111 path the user set on purpose (ComfyUI, a custom route) is
// left alone: we only fill in a MISSING or root path.
function _normalizeEndpoint(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch { return s; } // not a URL — hand it back untouched
  const path = u.pathname.replace(/\/+$/, '');
  if (path === '' || path === '/api/v1' || path === '/sdapi/v1') {
    u.pathname = '/sdapi/v1/txt2img';
    return u.toString();
  }
  return s;
}

function getSettings() { return { ...settings }; }
function setSettings(patch) {
  if (!patch || typeof patch !== 'object') return getSettings();
  if ('enabled' in patch) settings.enabled = !!patch.enabled;
  if ('endpoint' in patch) settings.endpoint = _normalizeEndpoint(patch.endpoint);
  if ('model' in patch) settings.model = String(patch.model || '');
  for (const k of ['steps', 'width', 'height', 'batchCount']) {
    if (k in patch) { const n = Number(patch[k]); if (Number.isFinite(n) && n > 0) settings[k] = Math.round(n); }
  }
  if ('cfgScale' in patch) { const n = Number(patch.cfgScale); if (Number.isFinite(n) && n > 0) settings.cfgScale = n; }
  if ('seed' in patch) { const n = Number(patch.seed); if (Number.isFinite(n)) settings.seed = Math.round(n); } // -1 allowed (random)
  if ('timeoutMs' in patch) settings.timeoutMs = Math.max(5000, Number(patch.timeoutMs) || settings.timeoutMs);
  return getSettings();
}
function status() {
  return { configured: !!settings.endpoint, enabled: !!settings.enabled, endpoint: settings.endpoint, model: settings.model, steps: settings.steps, cfgScale: settings.cfgScale, width: settings.width, height: settings.height, batchCount: settings.batchCount, seed: settings.seed };
}

// Strip a possible data-URI prefix so callers always get raw base64.
function _cleanBase64(s) { return String(s || '').replace(/^data:image\/\w+;base64,/, ''); }

// E09: an HTTP>=400 body carries the REAL reason (e.g. the xFormers
// NotImplementedError behind a 500). Pull a short, safe message out of it —
// JSON {error|detail|message} first, else stripped/truncated text — so the
// caller can show it instead of a bare "HTTP_500".
function _errDetail(buf) {
  const s = String(buf || '').slice(0, 4000);
  if (!s.trim()) return '';
  try {
    const j = JSON.parse(s);
    const m = j.error || j.detail || j.message || j.msg || (j.errors && JSON.stringify(j.errors));
    if (m) return String(m).replace(/\s+/g, ' ').trim().slice(0, 400);
  } catch { /* not JSON — fall through to text */ }
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
}

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
      cfg_scale: settings.cfgScale,
      width: settings.width,
      height: settings.height,
      n_iter: settings.batchCount,
      seed: settings.seed,
    });
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Accept: 'application/json' };
    onEvent({ type: 'image-start', content: p });

    let settled = false;
    const finish = (out) => { if (settled) return; settled = true; try { req.destroy(); } catch {} resolve(out); };
    const req = lib.request(
      { hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search, method: 'POST', headers, timeout: settings.timeoutMs },
      (res) => {
        // On an error status, read only a bounded slice of the body (for the
        // reason); on success, read the whole thing — a base64 image is large.
        const isErr = !!(res.statusCode && res.statusCode >= 400);
        let buf = ''; res.setEncoding('utf8');
        res.on('data', (c) => { if (!isErr || buf.length < 65536) buf += c; else res.resume(); });
        res.on('end', () => {
          if (isErr) return finish({ ok: false, error: `HTTP_${res.statusCode}`, detail: _errDetail(buf) });
          let j; try { j = JSON.parse(buf || '{}'); } catch { return finish({ ok: false, error: 'BAD_JSON' }); }
          // E09: keep EVERY image the batch produced, not just the first. imageBase64
          // stays the first one for back-compat; images[] carries the whole batch.
          const imgs = Array.isArray(j.images) ? j.images.map(_cleanBase64).filter(Boolean) : [];
          if (!imgs.length) return finish({ ok: false, error: 'NO_IMAGE' });
          onEvent({ type: 'image', content: `${imgs.length} image(s), ${imgs[0].length} base64 chars` });
          finish({ ok: true, imageBase64: imgs[0], images: imgs, info: j.info || '' });
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
