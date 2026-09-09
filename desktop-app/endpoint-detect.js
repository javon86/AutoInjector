'use strict';
/*
 * endpoint-detect.js — stop making the user guess the Stable Diffusion / video
 * endpoint URL. This does three things:
 *   1) presets(kind)  — a curated dropdown of the usual local backends + ports.
 *   2) detect(kind)   — probe those candidates on localhost and return the ones
 *                       that actually answer, so the app can fill it in for you.
 *   3) test(url)      — is a specific endpoint reachable right now? (health ping)
 *
 * Electron-free + injectable http so it's unit-testable. Probes are localhost,
 * short-timeout GETs to each backend's cheap "is it up" path.
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

// The common local backends. `endpoint` is the full generate URL the providers
// POST to; `health` is a cheap GET that returns 200 when the server is running.
const CANDIDATES = {
  image: [
    { label: 'Automatic1111 / Forge / SD.Next — port 7860', endpoint: 'http://127.0.0.1:7860/sdapi/v1/txt2img', health: 'http://127.0.0.1:7860/sdapi/v1/sd-models' },
    { label: 'Automatic1111 — port 7861', endpoint: 'http://127.0.0.1:7861/sdapi/v1/txt2img', health: 'http://127.0.0.1:7861/sdapi/v1/sd-models' },
    { label: 'ComfyUI — port 8188', endpoint: 'http://127.0.0.1:8188/prompt', health: 'http://127.0.0.1:8188/system_stats' },
  ],
  video: [
    { label: 'AnimateDiff via A1111 API — port 7860', endpoint: 'http://127.0.0.1:7860/sdapi/v1/txt2img', health: 'http://127.0.0.1:7860/sdapi/v1/sd-models' },
    { label: 'ComfyUI video workflow — port 8188', endpoint: 'http://127.0.0.1:8188/prompt', health: 'http://127.0.0.1:8188/system_stats' },
    { label: 'Stable Video Diffusion server — port 7862', endpoint: 'http://127.0.0.1:7862/generate', health: 'http://127.0.0.1:7862/' },
  ],
};

const deps = { http, https };
function configure(patch) {
  if (!patch) return;
  if (patch.http) deps.http = patch.http;
  if (patch.https) deps.https = patch.https;
}

function presets(kind) { return (CANDIDATES[kind] || []).map((c) => ({ label: c.label, endpoint: c.endpoint })); }

// GET a URL with a short timeout; resolve { ok } — ok means the server answered
// (any status < 500), i.e. something is listening and speaking HTTP there.
function probe(url, timeoutMs) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch { return resolve({ ok: false }); }
    const lib = u.protocol === 'https:' ? deps.https : deps.http;
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve({ ok }); } };
    let req;
    try {
      req = lib.get({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, timeout: Math.max(300, timeoutMs || 1500) }, (res) => {
        res.resume();
        finish(!!(res.statusCode && res.statusCode < 500));
      });
      req.on('error', () => finish(false));
      req.on('timeout', () => { try { req.destroy(); } catch {} finish(false); });
    } catch { finish(false); }
  });
}

// Probe every candidate for a kind; return the ones that answer, with the full
// generate endpoint to use. Runs the probes in parallel (all localhost).
async function detect(kind, opts = {}) {
  const list = CANDIDATES[kind] || [];
  const timeoutMs = opts.timeoutMs || 1500;
  const results = await Promise.all(list.map(async (c) => ({ c, up: (await probe(c.health, timeoutMs)).ok })));
  const reachable = results.filter((r) => r.up).map((r) => ({ label: r.c.label, endpoint: r.c.endpoint }));
  return { ok: true, reachable, checked: list.length };
}

// Is one specific endpoint reachable? Probes the base host (strip the API path)
// so it works whether they pasted the full generate URL or just the base.
async function test(url, opts = {}) {
  if (!url) return { reachable: false, error: 'NO_URL' };
  let base = url;
  try { const u = new URL(url); base = `${u.protocol}//${u.host}`; } catch { /* use as-is */ }
  const r = await probe(base, opts.timeoutMs || 1500);
  return { reachable: r.ok, base };
}

module.exports = { CANDIDATES, presets, detect, test, probe, configure };
