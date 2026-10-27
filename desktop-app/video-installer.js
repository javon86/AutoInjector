'use strict';
/*
 * video-installer.js — the 🎬 Video models: what they are, where their files go,
 * what is installed / missing, and the in-app download (with progress, resume,
 * a size check and cancel). Reuses sd-installer.js (its download() and its
 * one-click ComfyUI portable install) — nothing is duplicated here.
 *
 * Models (docs/VIDEO_API.md has the sources):
 *   wan22-ti2v-5b   Wan 2.2 TI2V 5B — text→video AND picture→video, 24 fps, 1280×704,
 *                   about 12 GB of graphics memory (runs on 8 GB with ComfyUI's offloading, slowly)
 *   wan21-t2v-1.3b  Wan 2.1 T2V 1.3B — text→video only, 16 fps, 832×480, about 8 GB
 * Every file comes from Comfy-Org's repackaged repos on Hugging Face (the files the
 * official ComfyUI templates load) and goes into the ComfyUI models folders:
 *   diffusion_models/, text_encoders/, vae/
 * Stability Matrix keeps ComfyUI's shared models in Data/Models with its own names
 * (DiffusionModels, TextEncoders → ComfyUI's clip, VAE); those are used when the
 * ComfyUI is a Stability Matrix package. The text encoder is shared by both models.
 *
 *   const vi = createVideoInstaller({ sdInstaller: () => inst, roots: () => [...], log, onChange });
 *   vi.check()                → { ok, roots, target, comfyInstalled, models:[{ id, installed, missing, files }] }
 *   vi.downloadModel(id)      → { ok, model, files } | { ok:false, error, message }
 *   vi.installAll(id)         → ComfyUI portable (if none) + the model
 *   vi.cancel() / vi.status()
 * Pure Node, everything injectable (the tests use a fake HTTP file server).
 */
const fs = require('fs');
const path = require('path');
const sdInstaller = require('./sd-installer');

const HF22 = 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files';
const HF21 = 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files';
const GB = 1024 * 1024 * 1024;

// Sizes are the exact byte sizes Hugging Face lists for these files (checked 2026-10-27).
const UMT5 = { kind: 'text_encoders', name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', url: `${HF22}/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors`, bytes: 6735906897 };
const MODELS = {
  'wan22-ti2v-5b': {
    id: 'wan22-ti2v-5b', label: 'Wan 2.2 TI2V 5B — text→video and picture→video (recommended)', short: 'Wan 2.2 5B',
    family: 'wan22', modes: ['t2v', 'i2v'], vramGB: 12,
    vramNote: 'About 12 GB of graphics memory for 1280×704. 8 GB cards work with ComfyUI\'s automatic offloading at 832×480, slowly.',
    files: [
      { kind: 'diffusion_models', name: 'wan2.2_ti2v_5B_fp16.safetensors', url: `${HF22}/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors`, bytes: 9999658848 },
      UMT5,
      { kind: 'vae', name: 'wan2.2_vae.safetensors', url: `${HF22}/vae/wan2.2_vae.safetensors`, bytes: 1409400960 },
    ],
    // ComfyUI's own template (video_wan2_2_5B_ti2v): 1280×704, 121 frames, 24 fps, 20 steps, cfg 5, uni_pc / simple, shift 8.
    defaults: { width: 1280, height: 704, fps: 24, frames: 121, steps: 20, cfgScale: 5, sampler: 'uni_pc', scheduler: 'simple', shift: 8 },
    limits: { sizeStep: 32, minSide: 256, maxSide: 1280, maxFrames: 121, minFps: 1, maxFps: 60 },
  },
  'wan21-t2v-1.3b': {
    id: 'wan21-t2v-1.3b', label: 'Wan 2.1 T2V 1.3B — small and quick, text→video only', short: 'Wan 2.1 1.3B',
    family: 'wan21', modes: ['t2v'], vramGB: 8,
    vramNote: 'About 8 GB of graphics memory at 832×480.',
    files: [
      { kind: 'diffusion_models', name: 'wan2.1_t2v_1.3B_fp16.safetensors', url: `${HF21}/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors`, bytes: 2838303560 },
      UMT5,
      { kind: 'vae', name: 'wan_2.1_vae.safetensors', url: `${HF21}/vae/wan_2.1_vae.safetensors`, bytes: 253815318 },
    ],
    // ComfyUI's own template (text_to_video_wan): 832×480, 33 frames, 16 fps, 30 steps, cfg 6, uni_pc / simple, shift 8.
    defaults: { width: 832, height: 480, fps: 16, frames: 33, steps: 30, cfgScale: 6, sampler: 'uni_pc', scheduler: 'simple', shift: 8 },
    limits: { sizeStep: 16, minSide: 256, maxSide: 1024, maxFrames: 81, minFps: 1, maxFps: 60 },
  },
};
const DEFAULT_MODEL = 'wan22-ti2v-5b';
function modelBytes(m) { return m.files.reduce((s, f) => s + f.bytes, 0); }

// ComfyUI's folder names, and Stability Matrix's (Data/Models) for the same kind.
const FOLDERS = {
  comfy: { diffusion_models: ['diffusion_models', 'unet'], text_encoders: ['text_encoders', 'clip'], vae: ['vae'] },
  sm: { diffusion_models: ['DiffusionModels', 'diffusion_models', 'Unet'], text_encoders: ['TextEncoders', 'CLIP', 'text_encoders'], vae: ['VAE', 'vae'] },
};
function folderFor(root, kind) {
  const names = FOLDERS[root.layout === 'sm' ? 'sm' : 'comfy'][kind];
  // An existing folder wins (case differs between systems); else the first name.
  for (const n of names) { try { if (fs.statSync(path.join(root.path, n)).isDirectory()) return path.join(root.path, n); } catch {} }
  return path.join(root.path, names[0]);
}
// Where a catalog file is on disk (any root, any of its folder names) → { path, bytes, complete, partial }.
function findFile(file, roots) {
  let partial = null;
  for (const r of roots) {
    for (const n of new Set([...FOLDERS.comfy[file.kind], ...FOLDERS.sm[file.kind]])) {
      const p = path.join(r.path, n, file.name);
      try {
        const st = fs.statSync(p);
        if (st.isFile()) return { path: p, bytes: st.size, complete: st.size === file.bytes, root: r.path };
      } catch {}
      try { const st = fs.statSync(`${p}.part`); if (st.isFile() && (!partial || st.size > partial.bytes)) partial = { path: `${p}.part`, bytes: st.size }; } catch {}
    }
  }
  return partial ? { partial } : null;
}

function createVideoInstaller(opts = {}) {
  const log = opts.log || (() => {});
  const onChange = opts.onChange || (() => {});
  const deps = opts.deps || {};
  const models = Object.assign({}, MODELS, opts.models || {});
  const inst = () => { try { return opts.sdInstaller ? opts.sdInstaller() : null; } catch { return null; } };
  const freeBytes = opts.freeBytes || sdInstaller.freeBytes;
  let st = { phase: 'idle', model: null, file: null, pct: 0, done: 0, total: 0, message: '', error: null };
  let job = null;
  function set(p) { st = Object.assign({}, st, p); try { onChange(status()); } catch {} }
  function status() { return Object.assign({ busy: !!job }, st); }

  // Every models folder video can use. [{ path, layout: 'comfy'|'sm', source }]
  function roots() {
    const out = [];
    const add = (p, layout, source) => { if (p && !out.some((r) => path.resolve(r.path).toLowerCase() === path.resolve(p).toLowerCase())) out.push({ path: p, layout, source }); };
    try { const extra = opts.roots ? opts.roots() : []; for (const r of extra || []) if (r && r.path) add(r.path, r.layout || 'comfy', r.source || 'ComfyUI'); } catch {}
    try { const pt = inst() && inst().portable(); if (pt) add(pt.models, 'comfy', 'ComfyUI (installed by AutoInjector)'); } catch {}
    return out;
  }
  // Where downloads go: the root of the ComfyUI being used (opts.preferredRoot), else the first one.
  function target() {
    const all = roots();
    let pref = null; try { pref = opts.preferredRoot ? opts.preferredRoot() : null; } catch {}
    if (pref && pref.path) return all.find((r) => path.resolve(r.path).toLowerCase() === path.resolve(pref.path).toLowerCase()) || Object.assign({ layout: 'comfy', source: 'ComfyUI' }, pref);
    return all[0] || null;
  }
  // Names the connected ComfyUI lists (optional; { diffusion_models:[], text_encoders:[], vae:[] }).
  function modelState(m, rs, listed) {
    const files = m.files.map((f) => {
      const hit = findFile(f, rs);
      const inComfy = !!(listed && Array.isArray(listed[f.kind]) && listed[f.kind].some((x) => String(x).replace(/\\/g, '/').split('/').pop() === f.name));
      // When the connected ComfyUI's own list is known, that decides: a file in some OTHER ComfyUI's folder
      // (e.g. Stability Matrix's while the portable one runs) is not usable by this one.
      const known = !!(listed && Array.isArray(listed[f.kind]));
      const present = known ? inComfy : !!(hit && hit.complete);
      return { kind: f.kind, name: f.name, bytes: f.bytes, url: f.url, present, inComfy, path: hit && hit.path ? hit.path : null,
        wrongSize: !!(hit && hit.path && !hit.complete), partialBytes: hit && hit.partial ? hit.partial.bytes : 0 };
    });
    const missing = files.filter((f) => !f.present);
    return { id: m.id, label: m.label, short: m.short, modes: m.modes.slice(), vramGB: m.vramGB, vramNote: m.vramNote, approxBytes: modelBytes(m),
      sizeText: sdInstaller.fmtBytes(modelBytes(m)), installed: !missing.length, missing: missing.map((f) => f.name),
      missingBytes: missing.reduce((s, f) => s + Math.max(0, f.bytes - f.partialBytes), 0), files, defaults: Object.assign({}, m.defaults), default: m.id === DEFAULT_MODEL };
  }
  function check(listed) {
    const rs = roots();
    const t = target();
    const i = inst();
    let comfyInstalled = false; try { comfyInstalled = !!(i && i.portable()); } catch {}
    const ms = Object.values(models).map((m) => modelState(m, rs, listed));
    const free = t ? freeBytes(t.path) : null;
    return { ok: true, roots: rs, target: t, comfyInstalled, anyComfy: rs.length > 0, models: ms, defaultModel: DEFAULT_MODEL, freeBytes: free,
      installed: ms.filter((m) => m.installed).map((m) => m.id), message: !rs.length ? 'No ComfyUI was found on this PC yet. Press “Install ComfyUI + video model”, or install ComfyUI in Stability Matrix.' : ms.some((m) => m.installed) ? `Video model ready: ${ms.filter((m) => m.installed).map((m) => m.short).join(', ')}.` : `ComfyUI found (${rs[0].source}), but no video model is downloaded yet.`,
      status: status() };
  }

  async function downloadModel(id, o = {}) {
    const m = models[id || DEFAULT_MODEL];
    if (!m) return { ok: false, error: 'BAD_MODEL', code: 'INVALID_PARAM', field: 'id', message: `There is no video model “${id}”.`, hint: `Models: ${Object.keys(models).join(', ')}` };
    if (job) return { ok: false, error: 'BUSY', code: 'BUSY', message: 'A download is already running. Wait for it, or press Cancel.' };
    const t = o.root ? Object.assign({ layout: 'comfy' }, o.root) : target();
    if (!t) return { ok: false, error: 'NO_COMFYUI', code: 'VIDEO_NOT_SET_UP', message: 'No ComfyUI was found to put the video model into.', fix: 'Press “Install ComfyUI + video model”, or install ComfyUI in Stability Matrix (or start your own ComfyUI), then try again.' };
    // Only files already in the TARGET ComfyUI (or listed by the running one) count as done: a copy in another
    // ComfyUI's folder isn't visible to this one, so "already downloaded" would be a dead end.
    const listed = o.listed || null;
    const todo = m.files.filter((f) => {
      if (listed && Array.isArray(listed[f.kind]) && listed[f.kind].some((x) => String(x).replace(/\\/g, '/').split('/').pop() === f.name)) return false;
      const h = findFile(f, [t]); return !(h && h.complete);
    });
    if (!todo.length) { set({ phase: 'installed', model: m.id, file: null, pct: 1, error: null, message: `✔ ${m.short} is already downloaded.` }); return { ok: true, already: true, model: m.id, files: m.files.map((f) => f.name) }; }
    const need = todo.reduce((s, f) => s + f.bytes, 0);
    const free = freeBytes(t.path);
    if (free != null && free < need * 1.02 && !o.ignoreSpace) return { ok: false, error: 'NO_SPACE', code: 'NO_SPACE', message: `Not enough free disk space for ${m.short}: it needs ${sdInstaller.fmtBytes(need)}, this drive has ${sdInstaller.fmtBytes(free)} free.`, fix: 'Free some space (or move ComfyUI to a bigger drive), then press Download again.' };
    job = { cancelled: false }; const myJob = job;
    const total = need; let before = 0;
    try {
      log('video-model-download-start', { model: m.id, files: todo.length, bytes: need });
      for (const f of todo) {
        if (myJob.cancelled) break;
        const dest = path.join(folderFor(t, f.kind), f.name);
        set({ phase: 'downloading', model: m.id, file: f.name, error: null, message: `Downloading ${f.name}…` });
        const d = await sdInstaller.download(f.url, dest, {
          deps, job: myJob, expectedSize: f.bytes,
          onProgress: (p) => { const done = before + (p.done || 0); set({ pct: total ? Math.min(1, done / total) : 0, done, total, message: `Downloading ${m.short}: ${f.name} — ${sdInstaller.fmtBytes(done)} of ${sdInstaller.fmtBytes(total)}` }); },
        });
        if (!d.ok) {
          const paused = d.error === 'CANCELLED';
          const msg = d.error === 'SIZE_MISMATCH' ? `${f.name} did not download completely (${d.message}). Press Download again — it continues where it stopped.` : d.message;
          set({ phase: paused ? 'paused' : 'failed', error: d.error, message: paused ? 'Download paused. Press Download again to continue where it stopped.' : msg });
          log('video-model-download-failed', { model: m.id, file: f.name, error: d.error });
          return { ok: false, error: d.error, code: paused ? 'CANCELLED' : d.error, model: m.id, file: f.name, message: paused ? 'Download paused. Press Download again to continue where it stopped.' : msg, partial: d.partial };
        }
        before += f.bytes;
      }
      if (myJob.cancelled) { set({ phase: 'paused', error: 'CANCELLED', message: 'Download paused. Press Download again to continue where it stopped.' }); return { ok: false, error: 'CANCELLED', code: 'CANCELLED', model: m.id, message: 'Download paused.' }; }
      set({ phase: 'installed', model: m.id, file: null, pct: 1, done: total, total, error: null, message: `✔ ${m.short} is downloaded into ${t.path}.` });
      log('video-model-downloaded', { model: m.id });
      return { ok: true, model: m.id, root: t.path, files: m.files.map((f) => f.name) };
    } catch (e) {
      set({ phase: 'failed', error: 'INTERNAL', message: `The download stopped: ${(e && e.message) || e}` });
      return { ok: false, error: 'INTERNAL', message: `The download stopped: ${(e && e.message) || e}` };
    } finally { if (job === myJob) job = null; }
  }

  // "Install ComfyUI + video model": the official ComfyUI portable (sd-installer) when
  // no ComfyUI is on this PC yet, then the model into it.
  async function installAll(id, o = {}) {
    const i = inst();
    let haveComfy = roots().length > 0;
    if (!haveComfy) {
      if (!i) return { ok: false, error: 'NOT_WIRED', message: 'The ComfyUI installer is not available in this build.' };
      if (job) return { ok: false, error: 'BUSY', code: 'BUSY', message: 'A download is already running.' };
      job = { cancelled: false, cancel: () => { try { i.cancel(); } catch {} } }; const myJob = job;
      try {
        set({ phase: 'installing-comfyui', model: id || DEFAULT_MODEL, error: null, message: 'Installing ComfyUI first (about 2 GB)…' });
        const r = await i.install({ ignoreSpace: !!o.ignoreSpace, build: o.build });
        if (!r || !r.ok) { set({ phase: r && r.error === 'CANCELLED' ? 'paused' : 'failed', error: (r && r.error) || 'FAILED', message: (r && r.message) || 'ComfyUI could not be installed.' }); return Object.assign({ ok: false, step: 'comfyui' }, r || {}); }
      } finally { if (job === myJob) job = null; }
      haveComfy = true;
    }
    const d = await downloadModel(id || DEFAULT_MODEL, o);
    return Object.assign({ comfyInstalled: haveComfy }, d);
  }

  function cancel() {
    const j = job;
    if (j) { j.cancelled = true; try { if (j.cancel) j.cancel(); } catch {} }
    return { ok: true, cancelled: !!j };
  }
  return { status, check, roots, target, downloadModel, installAll, cancel, models: () => Object.values(models) };
}

module.exports = { createVideoInstaller, MODELS, DEFAULT_MODEL, FOLDERS, folderFor, findFile, modelBytes, GB };
