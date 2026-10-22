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
  frames: 16,      // slider: clip length in frames
  fps: 8,          // slider: playback frames per second
  steps: 20,       // slider: sampling steps
  cfgScale: 7,     // slider: CFG scale (prompt adherence)
  motion: 1,       // slider: motion strength (how much movement)
  width: 512,
  height: 512,
  seed: -1,        // -1 = random
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
  for (const k of ['cfgScale', 'motion']) { if (k in patch) { const n = Number(patch[k]); if (Number.isFinite(n) && n >= 0) settings[k] = n; } }
  if ('seed' in patch) { const n = Number(patch.seed); if (Number.isFinite(n)) settings.seed = Math.round(n); }
  if ('timeoutMs' in patch) settings.timeoutMs = Math.max(5000, Number(patch.timeoutMs) || settings.timeoutMs);
  return getSettings();
}
function status() {
  return { configured: !!settings.endpoint, enabled: !!settings.enabled, endpoint: settings.endpoint, model: settings.model, frames: settings.frames, fps: settings.fps, steps: settings.steps, cfgScale: settings.cfgScale, motion: settings.motion, width: settings.width, height: settings.height, seed: settings.seed };
}

function _cleanBase64(s) { return String(s || '').replace(/^data:video\/\w+;base64,/, ''); }

// E09: surface the real backend reason from an HTTP>=400 body instead of a bare
// "HTTP_500". JSON {error|detail|message} first, else stripped/truncated text.
function _errDetail(buf) {
  const s = String(buf || '').slice(0, 4000);
  if (!s.trim()) return '';
  try {
    const j = JSON.parse(s);
    const m = j.error || j.detail || j.message || j.msg || (j.errors && JSON.stringify(j.errors));
    if (m) return String(m).replace(/\s+/g, ' ').trim().slice(0, 400);
  } catch { /* not JSON */ }
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
}

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

// OP-13: when a 200 reply carries no clip, say what it looked like instead —
// the usual cause is an address that points at something that isn't a
// text-to-video backend (an image server, or ComfyUI's job queue).
function _shapeOf(j) {
  if (!j || typeof j !== 'object') return 'empty';
  if (Array.isArray(j.images)) return 'images';           // A1111/Forge txt2img (stills)
  if (j.prompt_id || j.node_errors) return 'comfy-queue'; // ComfyUI /prompt only queues
  return Object.keys(j).length ? 'unknown' : 'empty';
}

// ---- plain-language errors (OP-13) ------------------------------------------
// `error` keeps the short machine code (NO_VIDEO, ECONNREFUSED, ...); `message`
// says in plain words what is wrong and how to fix it.
const WHERE_SETTINGS = 'Setup Wizard → Video (or the Video panel\'s ⚙️ Connection)';
const NO_BACKEND = 'Video needs a separate text-to-video backend running on your PC (for example AnimateDiff or Stable Video Diffusion) whose API sends the finished clip back.';
function explainError(r, endpoint) {
  const code = String((r && r.error) || 'UNKNOWN');
  const ep = endpoint != null ? String(endpoint) : settings.endpoint;
  const at = ep ? ` at ${ep}` : '';
  if (code === 'NEED_PROMPT') return 'Type a prompt first.';
  if (code === 'VIDEO_DISABLED') return `Video generation is turned off. Tick "Enable video generation" in ${WHERE_SETTINGS} and press Save.`;
  if (code === 'NO_ENDPOINT') return `No video backend is set up yet. ${NO_BACKEND} Start one with its API turned on, then enter its address in ${WHERE_SETTINGS}, press Save and Check connection.`;
  if (code === 'BAD_ENDPOINT') return `The video address "${ep}" isn't a valid web address. Enter the backend's full generate URL (for example http://127.0.0.1:7860/...) in ${WHERE_SETTINGS}.`;
  if (code === 'NO_VIDEO') {
    const shape = r && r.shape;
    const why = shape === 'images'
      ? ' It sent back still images, so that address looks like an image (Stable Diffusion) server rather than a video one — if you use AnimateDiff in Automatic1111/Forge, make sure the AnimateDiff extension is installed and turned on.'
      : shape === 'comfy-queue'
        ? ' It looks like ComfyUI, which only queues the job and doesn\'t send the clip back in its reply — this app needs a backend that returns the clip directly.'
        : '';
    return `The server${at} answered, but it didn't send back a video, so no working video backend is configured yet.${why} ${NO_BACKEND} Set one up, then enter its address in ${WHERE_SETTINGS} and use Test render.`;
  }
  if (code === 'ECONNREFUSED') return `Nothing is running${at}, so no video backend is available. Start your video backend with its API turned on, or fix the address in ${WHERE_SETTINGS}.`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `The video address${at} names a computer that can't be found. Check the address in ${WHERE_SETTINGS}.`;
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EADDRNOTAVAIL') return `The video address${at} can't be reached from this computer. Check the address in ${WHERE_SETTINGS}.`;
  if (code === 'TIMEOUT' || code === 'ETIMEDOUT') return `The video backend${at} didn't finish within ${Math.round(settings.timeoutMs / 60000)} minute(s). Try fewer frames or steps, or check that the backend isn't stuck.`;
  if (code === 'ECONNRESET' || code === 'EPIPE') return `The video backend${at} dropped the connection — it may have crashed or run out of memory. Check its window, then try again.`;
  if (code === 'BAD_JSON') return `The server${at} answered with something that isn't a video API reply. Check that the address in ${WHERE_SETTINGS} is the backend's generate URL.`;
  if (code === 'HTTP_404' || code === 'HTTP_405') return `Something is running${at}, but that address isn't a text-to-video generate URL (${code.replace('_', ' ')}). Check the full address in ${WHERE_SETTINGS}.`;
  if (/^HTTP_\d+$/.test(code)) return `The video backend${at} reported an error (${code.replace('_', ' ')}${r && r.detail ? `: ${r.detail}` : ''}). Check its window for details.`;
  if (/^SAVE_FAILED/.test(code)) return `The clip was made but couldn't be saved into the videos/ folder (${code.replace(/^SAVE_FAILED:\s*/, '')}).`;
  return `Video generation failed${at}: ${code}.`;
}
// Attach the plain-language message to a failed result (success passes through).
function _withMessage(r) { return r && r.ok === false ? { ...r, message: explainError(r) } : r; }

// Generate one clip from a prompt. Resolves { ok, videoBase64?|videoUrl?, info, error, message? }.
function generate(prompt, opts = {}) {
  return _generate(prompt, opts).then(_withMessage);
}
function _generate(prompt, opts) {
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
      steps: settings.steps,
      cfg_scale: settings.cfgScale,
      motion: settings.motion,
      width: settings.width,
      height: settings.height,
      seed: settings.seed,
    });
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Accept: 'application/json' };
    onEvent({ type: 'video-start', content: p });

    let settled = false;
    const finish = (out) => { if (settled) return; settled = true; try { req.destroy(); } catch {} resolve(out); };
    const req = lib.request(
      { hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search, method: 'POST', headers, timeout: settings.timeoutMs },
      (res) => {
        // Bound the buffer only on an error status; a successful clip's base64 is
        // large and must be read in full.
        const isErr = !!(res.statusCode && res.statusCode >= 400);
        let buf = ''; res.setEncoding('utf8');
        res.on('data', (c) => { if (!isErr || buf.length < 65536) buf += c; else res.resume(); });
        res.on('end', () => {
          if (isErr) return finish({ ok: false, error: `HTTP_${res.statusCode}`, detail: _errDetail(buf) });
          let j; try { j = JSON.parse(buf || '{}'); } catch { return finish({ ok: false, error: 'BAD_JSON' }); }
          const got = _extract(j);
          if (!got.videoBase64 && !got.videoUrl) return finish({ ok: false, error: 'NO_VIDEO', shape: _shapeOf(j) });
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

module.exports = { getSettings, setSettings, status, generate, explainError, _extract };
