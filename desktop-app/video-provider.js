'use strict';
// video-provider.js — the butler's text-to-video capability. Same shape as
// image-provider: the model isn't bundled (it needs a GPU), it's a configurable
// local HTTP endpoint. Local txt2vid backends aren't standardized, so the
// transport is deliberately tolerant of the common response shapes:
//   POST <endpoint>  body { prompt, negative_prompt, frames, fps, width, height, steps }
//   response, any of:
//     { videos: ["<base64 mp4/webm>", ...] }   (A1111/ComfyUI-style array)
//     { video: "<base64>" }                    (single)
//     { url: "http://…/out.mp4" } | { output: "…" } | { data: "data:video/…" }
// The provider returns raw base64 (video) or a URL; the caller (main.js) saves a
// base64 clip into the videos/ output folder, so this module stays pure and
// unit-testable with no filesystem dependency.
const http = require('http');
const https = require('https');
const { URL } = require('url');

let settings = {
  enabled: false,
  endpoint: '',    // full txt2vid URL, e.g. http://127.0.0.1:7860/... or a ComfyUI/AnimateDiff API
  model: '',       // informational; the checkpoint is selected on the backend side
  frames: 16,
  fps: 8,
  width: 512,
  height: 512,
  steps: 20,
  timeoutMs: 600000, // video renders are slow
};

function getSettings() { return { ...settings }; }
function setSettings(patch) {
  if (!patch || typeof patch !== 'object') return getSettings();
  if ('enabled' in patch) settings.enabled = !!patch.enabled;
  for (const k of ['endpoint', 'model']) if (k in patch) settings[k] = String(patch[k] || '');
  for (const k of ['frames', 'fps', 'width', 'height', 'steps']) {
    if (k in patch) { const n = Number(patch[k]); if (Number.isFinite(n) && n > 0) settings[k] = Math.round(n); }
  }
  if ('timeoutMs' in patch) settings.timeoutMs = Math.max(5000, Number(patch.timeoutMs) || settings.timeoutMs);
  return getSettings();
}
function status() {
  return { configured: !!settings.endpoint, enabled: !!settings.enabled, endpoint: settings.endpoint, model: settings.model, frames: settings.frames, fps: settings.fps, width: settings.width, height: settings.height, steps: settings.steps };
}

function _cleanBase64(s) { return String(s || '').replace(/^data:video\/\w+;base64,/, ''); }

// Pull a video out of whatever shape the backend returned.
function _extract(j) {
  if (!j || typeof j !== 'object') return {};
  if (Array.isArray(j.videos) && j.videos.length) return { videoBase64: _cleanBase64(j.videos[0]) };
  if (typeof j.video === 'string' && j.video) return { videoBase64: _cleanBase64(j.video) };
  const url = j.url || j.output || j.data || j.path;
  if (typeof url === 'string' && url) {
    if (/^data:video\//.test(url)) return { videoBase64: _cleanBase64(url) };
    return { videoUrl: url };
  }
  return {};
}

// Generate one clip from a prompt. Resolves { ok, videoBase64?|videoUrl?, info, error }.
function generate(prompt, opts = {}) {
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  return new Promise((resolve) => {
    const p = String(prompt || '').trim();
    if (!p) return resolve({ ok: false, error: 'NEED_PROMPT' });
    if (!settings.enabled) return resolve({ ok: false, error: 'VIDEO_DISABLED' });
    if (!settings.endpoint) return resolve({ ok: false, error: 'NO_ENDPOINT' });

    let url; try { url = new URL(settings.endpoint); } catch { return resolve({ ok: false, error: 'BAD_ENDPOINT' }); }
    const lib = url.protocol === 'https:' ? https : http;
    const payload = JSON.stringify({
      prompt: p,
      negative_prompt: String(opts.negativePrompt || ''),
      frames: settings.frames,
      fps: settings.fps,
      width: settings.width,
      height: settings.height,
      steps: settings.steps,
    });
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Accept: 'application/json' };
    onEvent({ type: 'video-start', content: p });

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
          const got = _extract(j);
          if (!got.videoBase64 && !got.videoUrl) return finish({ ok: false, error: 'NO_VIDEO' });
          onEvent({ type: 'video', content: got.videoUrl || `${got.videoBase64.length} base64 chars` });
          finish({ ok: true, ...got, info: j.info || '' });
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

module.exports = { getSettings, setSettings, status, generate, _extract };
