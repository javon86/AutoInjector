'use strict';
/*
 * framepack.js — FramePack (lllyasviel's HunyuanVideo-based picture→video) as a 🎬 Video engine.
 * Electron-free and testable. Nothing is ever downloaded: AutoInjector uses the FramePack the
 * person already has (Stability Matrix's Packages/FramePack, or a folder they choose) and the
 * model files they already have ("stuff and thing"/models/video/framepack/hf first, else
 * FramePack's own hf_download).
 *
 *   findFramePack({ dir, env, smPackages, modelsDir, platform, python, runner })
 *     → { found, dir, source, python, pythonOk, hfHome, hfSource, models: { ok, missing, repos }, candidates, message }
 *   checkModels(hfHome) → { ok, missing: ['hunyuanvideo-community/HunyuanVideo/vae', …], repos: [...] }
 *   createFramePack({ find, spawn, log, onEvent, runner, gpu, readyTimeoutMs, cancelKillMs })
 *     .status()                 → what was found + the runner's state (running, loaded, loading, busy, vram …)
 *     .load()                   → start the runner and load the models once (they stay loaded)
 *     .generate(req, onProgress)→ { ok, path, poster, frames, fps: 30, seconds, width, height, sections, seed }
 *                                 | { ok:false, error, code, message, fix } (FRAMEPACK_* codes)
 *     .cancel() · .stop() (unloads, frees the graphics card) · .refresh() (look again)
 *   buildEnv(f) → the environment FramePack runs in (like Stability Matrix: venv python, venv Scripts + torch\lib first
 *     on PATH, PYTHONUNBUFFERED / PYTHONNOUSERSITE, no inherited PYTHONPATH / PYTHONHOME)
 *   explainPrecheck(info) → why PyTorch can't start, in plain words (no CUDA, CPU-only PyTorch, a DLL, torch missing)
 *
 * Loading: first a PyTorch pre-check (`framepack_runner.py --precheck`: import torch + ask CUDA in the main thread,
 * once per python, up to 10 min — the first start on Windows is slow while antivirus scans torch's DLLs), then the
 * runner. Every stage is timed (status().loading: stage, stageSeconds, and stuck + stuckMessage / stuckFix after a
 * per-stage limit), logged (framepack-stage / -still-loading / -stuck / -loaded / -load-failed), and ⏹ Stop stops the
 * whole process tree (Windows: taskkill /T /F) after a short grace. The last 50 stderr lines: status().stderrTail.
 *
 * The runner is integrations/framepack/framepack_runner.py, started with FramePack's OWN python
 * (its venv) in the FramePack folder, with HF_HOME = the model folder and HF_HUB_OFFLINE=1. It speaks
 * JSON lines on stdin/stdout (see that file). Tests point AUTOINJECTOR_FRAMEPACK_PYTHON /
 * AUTOINJECTOR_FRAMEPACK_RUNNER at a fake runner (test/fixtures/fake-framepack-runner.js).
 *
 * Error codes: FRAMEPACK_NOT_FOUND · FRAMEPACK_PYTHON_MISSING · FRAMEPACK_MODEL_MISSING (+ missing) ·
 * FRAMEPACK_TORCH_FAILED (+ cause) · FRAMEPACK_OOM · FRAMEPACK_BUSY · FRAMEPACK_CANCELLED · FRAMEPACK_FAILED — each with a plain message + fix.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn: nodeSpawn } = require('child_process');

const FPS = 30;
const MIN_VRAM_GB = 6;
// What FramePack's picture→video (demo_gradio.py, the original I2V model) loads from the Hugging Face cache.
const NEEDED = [
  { repo: 'hunyuanvideo-community/HunyuanVideo', label: 'HunyuanVideo text encoders, tokenizers and VAE', subs: ['text_encoder', 'text_encoder_2', 'tokenizer', 'tokenizer_2', 'vae'] },
  { repo: 'lllyasviel/flux_redux_bfl', label: 'the picture encoder (flux_redux_bfl)', subs: ['image_encoder', 'feature_extractor'] },
  { repo: 'lllyasviel/FramePackI2V_HY', label: 'the FramePack video model (FramePackI2V_HY)', subs: [''] },
];
const OOM_RE = /out of memory|OutOfMemoryError|not enough memory|DefaultCPUAllocator|Tried to allocate/i;
const RUNNER = path.join(__dirname, 'integrations', 'framepack', 'framepack_runner.py').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

// ------------------------------------------------------------------ finding it
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch (_) { return false; } }
/** A FramePack folder has FramePack's helpers and one of its demo scripts. */
function isFramePackDir(dir) {
  if (!dir || !isDir(dir)) return false;
  return isDir(path.join(dir, 'diffusers_helper')) && ['demo_gradio.py', 'demo_gradio_f1.py'].some((f) => isFile(path.join(dir, f)));
}
function venvPython(dir, platform) {
  const win = (platform || process.platform) === 'win32';
  const c = win ? [['venv', 'Scripts', 'python.exe'], ['.venv', 'Scripts', 'python.exe'], ['system', 'python', 'python.exe'], ['python_embeded', 'python.exe']]
    : [['venv', 'bin', 'python'], ['venv', 'bin', 'python3'], ['.venv', 'bin', 'python']];
  for (const parts of c) { const p = path.join(dir, ...parts); if (isFile(p)) return p; }
  return null;
}

function snapshotOf(repoDir) {
  const snaps = path.join(repoDir, 'snapshots');
  try { const rev = fs.readFileSync(path.join(repoDir, 'refs', 'main'), 'utf8').trim(); if (rev && isDir(path.join(snaps, rev))) return path.join(snaps, rev); } catch (_) {}
  let names = []; try { names = fs.readdirSync(snaps).filter((n) => isDir(path.join(snaps, n))); } catch (_) { return null; }
  if (!names.length) return null;
  names.sort((a, b) => { try { return fs.statSync(path.join(snaps, b)).mtimeMs - fs.statSync(path.join(snaps, a)).mtimeMs; } catch (_) { return 0; } });
  return path.join(snaps, names[0]);
}
// A model folder is there when it has files, and every part a *.safetensors.index.json names exists.
function folderProblem(folder) {
  let names; try { names = fs.readdirSync(folder).filter((n) => !n.startsWith('.')); } catch (_) { return 'missing'; }
  if (!names.length) return 'empty';
  for (const idx of names.filter((n) => /\.safetensors\.index\.json$/i.test(n))) {
    let j = null; try { j = JSON.parse(fs.readFileSync(path.join(folder, idx), 'utf8')); } catch (_) { j = null; }
    const parts = j && j.weight_map ? [...new Set(Object.values(j.weight_map))] : [];
    const gone = parts.filter((p) => !fs.existsSync(path.join(folder, p)));
    if (gone.length) return `missing ${gone.length} of ${parts.length} parts (${gone[0]}${gone.length > 1 ? ', …' : ''})`;
  }
  return null;
}
/** What FramePack needs from the HF cache in hfHome (…/hf with hub/ in it). */
function checkModels(hfHome) {
  const hub = hfHome ? path.join(hfHome, 'hub') : '';
  const missing = []; const repos = [];
  for (const n of NEEDED) {
    const rd = hub ? path.join(hub, `models--${n.repo.replace(/\//g, '--')}`) : '';
    const snap = rd && isDir(rd) ? snapshotOf(rd) : null;
    const miss = [];
    for (const sub of n.subs) {
      const label = sub ? `${n.repo}/${sub}` : n.repo;
      const why = snap ? folderProblem(sub ? path.join(snap, sub) : snap) : 'missing';
      if (why) miss.push(why === 'missing' || why === 'empty' ? label : `${label} (${why})`);
    }
    missing.push(...miss);
    repos.push({ repo: n.repo, label: n.label, ok: !miss.length, present: !!snap, missing: miss });
  }
  return { ok: !missing.length, missing, repos, hub };
}
function hasAnyModel(hfHome) { const c = checkModels(hfHome); return c.repos.some((r) => r.present); }

/**
 * Look for FramePack: the chosen folder (settings), AUTOINJECTOR_FRAMEPACK, Stability Matrix's packages.
 * o: { dir, env, smPackages: () => [{ dir, displayName, packageName }], modelsDir, platform, python, runner }
 */
function findFramePack(o = {}) {
  const env = o.env || process.env;
  const cands = [];
  const add = (dir, source) => { if (dir && !cands.some((c) => path.resolve(c.dir).toLowerCase() === path.resolve(dir).toLowerCase())) cands.push({ dir, source }); };
  if (o.dir) add(o.dir, 'chosen folder');
  if (env.AUTOINJECTOR_FRAMEPACK) add(env.AUTOINJECTOR_FRAMEPACK, 'AUTOINJECTOR_FRAMEPACK');
  let pk = [];
  try { pk = typeof o.smPackages === 'function' ? (o.smPackages() || []) : []; } catch (_) { pk = []; }
  for (const p of pk) if (p && p.dir && (/framepack/i.test(`${p.packageName || ''} ${p.displayName || ''} ${path.basename(p.dir)}`) || isFramePackDir(p.dir))) add(p.dir, 'Stability Matrix');
  for (const d of o.extraDirs || []) add(d, 'found');
  const chosenMissing = !!(o.dir && !isFramePackDir(o.dir));
  const hit = cands.find((c) => isFramePackDir(c.dir));
  const modelsDir = o.modelsDir || '';
  const out = { found: !!hit, dir: hit ? hit.dir : '', source: hit ? hit.source : '', candidates: cands.map((c) => ({ dir: c.dir, source: c.source, ok: isFramePackDir(c.dir) })), chosenMissing, chosenDir: o.dir || '' };
  // python: FramePack's own venv (tests: AUTOINJECTOR_FRAMEPACK_PYTHON)
  const pyOverride = o.python || env.AUTOINJECTOR_FRAMEPACK_PYTHON || '';
  out.python = pyOverride || (hit ? venvPython(hit.dir, o.platform) : null) || '';
  out.pythonOk = !!(out.python && isFile(out.python));
  out.runner = o.runner || env.AUTOINJECTOR_FRAMEPACK_RUNNER || RUNNER;
  // models: "stuff and thing" first, else FramePack's own hf_download
  const homes = [];
  if (modelsDir) homes.push({ dir: modelsDir, source: '"stuff and thing" models folder' });
  if (hit) homes.push({ dir: path.join(hit.dir, 'hf_download'), source: 'FramePack\'s own hf_download' });
  let pick = null;
  for (const h of homes) { const c = checkModels(h.dir); h.check = c; if (c.ok) { pick = h; break; } }
  if (!pick) pick = homes.find((h) => h.check && h.check.repos.some((r) => r.present)) || homes[0] || null;
  out.hfHome = pick ? pick.dir : '';
  out.hfSource = pick ? pick.source : '';
  out.models = pick ? pick.check : checkModels('');
  out.ready = !!(out.found && out.pythonOk && out.models.ok);
  out.message = describe(out);
  return out;
}
function describe(f) {
  if (!f.found) return f.chosenMissing ? `There is no FramePack in the chosen folder (${f.chosenDir}) — it needs demo_gradio.py and the diffusers_helper folder.` : 'FramePack was not found. If you have it (Stability Matrix → Packages → FramePack), press “📂 Choose FramePack folder”.';
  if (!f.pythonOk) return `FramePack is in ${f.dir}, but its Python (venv) is missing. Open it once in Stability Matrix (or reinstall it there) so its venv is made.`;
  if (!f.models.ok) return `FramePack is in ${f.dir}, but ${f.models.missing.length} model part${f.models.missing.length === 1 ? ' is' : 's are'} missing: ${f.models.missing.slice(0, 4).join(', ')}${f.models.missing.length > 4 ? ', …' : ''}.`;
  return `✔ FramePack is ready (${f.source}: ${f.dir}) with all its models (${f.hfSource}).${f.chosenMissing ? ` The chosen folder (${f.chosenDir}) has no FramePack, so this one is used.` : ''}`;
}

// ------------------------------------------------------------------ a test picture (no files needed)
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
/** A 640×480 PNG: sky, a sun, hills and a lake — something FramePack can bring to life. */
function testPicture(w = 640, h = 480) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3;
      const hill = h * 0.62 + Math.sin(x / 70) * 22 + Math.sin(x / 23) * 6;
      let r; let g; let b;
      if (y < hill) { const t = y / hill; r = 70 + 120 * t; g = 120 + 90 * t; b = 210 + 30 * t; } // sky
      else if (y < h * 0.8) { r = 40; g = 110 + ((x * 7 + y * 3) % 23); b = 50; } // hills
      else { const t = (y - h * 0.8) / (h * 0.2); r = 30 + 20 * t; g = 80 + 30 * t; b = 150 + 40 * t; } // water
      const dx = x - w * 0.72; const dy = y - h * 0.25; const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 46) { r = 255; g = 220; b = 120; } else if (d < 70 && y < hill) { const k = (70 - d) / 24; r += (255 - r) * k * 0.5; g += (230 - g) * k * 0.5; b += (160 - b) * k * 0.3; }
      raw[i] = Math.max(0, Math.min(255, r | 0)); raw[i + 1] = Math.max(0, Math.min(255, g | 0)); raw[i + 2] = Math.max(0, Math.min(255, b | 0));
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ------------------------------------------------------------------ plain words for what went wrong
function fail(code, message, fix, extra) { return Object.assign({ ok: false, error: code, code, message, fix: fix || '' }, extra || {}); }
function notReady(f) {
  if (!f || !f.found) return fail('FRAMEPACK_NOT_FOUND', f && f.chosenMissing ? `There is no FramePack in the chosen folder (${f.chosenDir}).` : 'FramePack was not found on this PC.',
    'Open 🎬 Video → Setup and press “📂 Choose FramePack folder” (Stability Matrix keeps it in Data\\Packages\\FramePack).', { engine: 'framepack' });
  if (!f.pythonOk) return fail('FRAMEPACK_PYTHON_MISSING', `FramePack is in ${f.dir}, but its own Python (the venv folder) is missing.`,
    'Start FramePack once from Stability Matrix (it makes the venv), or reinstall the FramePack package there. AutoInjector does not install Python for it.', { engine: 'framepack', dir: f.dir });
  if (!f.models.ok) return fail('FRAMEPACK_MODEL_MISSING', `FramePack's model files are not all there — missing: ${f.models.missing.join(', ')}.`,
    `Put FramePack's “hub” folder (from Packages\\FramePack\\hf_download) into “stuff and thing”/models/video/framepack/hf. Nothing is downloaded by AutoInjector.`, { engine: 'framepack', missing: f.models.missing.slice(), hfHome: f.hfHome });
  return null;
}
function explainExit(tail, code, signal) {
  const t = tail.join('\n');
  if (OOM_RE.test(t)) return fail('FRAMEPACK_OOM', 'Your graphics card ran out of memory and FramePack stopped.', 'Raise “GPU memory to keep free” (e.g. 8–10 GB), make a shorter clip, and close other programs that use the graphics card.', { engine: 'framepack', serverError: lastLines(tail) });
  if (/No module named/i.test(t)) { const m = t.match(/No module named '?([\w.]+)'?/i); return fail('FRAMEPACK_FAILED', `FramePack's Python is missing a part (${m ? m[1] : 'a module'}), so it could not start.`, 'Update or repair the FramePack package in Stability Matrix, then try again.', { engine: 'framepack', serverError: lastLines(tail) }); }
  const why = explainLoadError(t);
  if (why) return fail('FRAMEPACK_FAILED', why.message, why.fix, { engine: 'framepack', cause: why.cause, serverError: lastLines(tail) });
  return fail('FRAMEPACK_FAILED', `FramePack stopped unexpectedly${code != null ? ` (exit code ${code})` : signal ? ` (${signal})` : ''}.`, 'Try again. If it keeps happening, look at the details (what FramePack printed).', { engine: 'framepack', serverError: lastLines(tail) });
}
function lastLines(tail) { return tail.slice(-25).join('\n').slice(-3000); }
// Why loading failed, from the error text itself — so the words (and what to try) match what really happened, not a
// generic "check the models are there" (the file check can say "all found" and loading can still fail).
// → { cause, message, fix } | null
const HF_OFFLINE_RE = /offline mode|OfflineModeIsEnabled|outgoing traffic has been disabled|HF_HUB_OFFLINE|LocalEntryNotFoundError|couldn'?t connect to ['"]?https?:\/\/huggingface\.co|cannot find the requested files in the (?:local|disk) cache|get_hf_file_metadata|huggingface_hub[\w.]*errors/i;
function explainLoadError(text) {
  const t = String(text || '');
  if (!t.trim() || OOM_RE.test(t)) return null; // out of memory has its own words already
  if (HF_OFFLINE_RE.test(t)) {
    return { cause: 'hf-offline', message: 'FramePack tried to ask Hugging Face (online) about one of its model files while it runs offline, and did not find what it asked for in the local copy.',
      fix: 'The model files are on this PC — this is not a missing-model problem. Loading asked Hugging Face for a file\'s details (its metadata); AutoInjector runs FramePack offline and downloads nothing. Update AutoInjector and ↻ Try again; if it keeps happening, open FramePack once in Stability Matrix (online) so its own cache is complete, then try again. The exact error is in the details.' };
  }
  const m = t.match(/does not appear to have a file named ([^\s,]+)/i) || t.match(/No such file or directory:? '([^']+)'/i) || t.match(/Error while deserializing header|SafetensorError|incomplete metadata/i);
  if (m) {
    const name = m[1] ? String(m[1]).replace(/[.'"]+$/, '').split(/[\\/]/).slice(-2).join('/') : '';
    return { cause: 'file-bad', message: `A model file FramePack needs is missing or damaged${name ? ` (${name})` : ''}.`,
      fix: 'The file check only looks for the files by name — a half-copied or damaged file fails here. Copy that model again (from FramePack\'s hf_download into "stuff and thing"/models/video/framepack/hf), then ↻ Try again.' };
  }
  return null;
}
function fromRunner(ev) {
  const code = String(ev.code || 'FRAMEPACK_FAILED');
  const out = fail(code === 'BAD_REQUEST' ? 'FRAMEPACK_FAILED' : code, ev.message || 'FramePack could not make the video.', ev.fix || '', { engine: 'framepack' });
  if (ev.missing) out.missing = ev.missing;
  if (ev.detail) out.serverError = String(ev.detail).slice(0, 3000);
  if (ev.cause) out.cause = ev.cause;
  const why = code !== 'FRAMEPACK_OOM' && code !== 'BAD_REQUEST' ? explainLoadError(`${ev.message || ''}\n${ev.detail || ''}`) : null;
  if (why) {
    // what FramePack said stays (first in the details); the words and the fix fit what really happened
    if (ev.message && !(out.serverError || '').includes(ev.message)) out.serverError = `${ev.message}${out.serverError ? `\n\n${out.serverError}` : ''}`.slice(0, 3000);
    out.message = why.message; out.fix = why.fix; out.cause = why.cause;
  }
  if (code === 'FRAMEPACK_OOM' && !out.fix) out.fix = 'Raise “GPU memory to keep free”, or make a shorter clip.';
  return out;
}

// ------------------------------------------------------------------ the environment FramePack runs in
// Like Stability Matrix starts FramePack: its venv's python, the FramePack folder as the working folder, the venv's
// Scripts (bin) and torch\lib first on PATH, unbuffered, no user site-packages, and NOTHING inherited that could
// make that python load another Python's files (PYTHONPATH, PYTHONHOME, PYTHONSTARTUP, a different VIRTUAL_ENV …).
const DROP_ENV = ['PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONUSERBASE', 'PYTHONEXECUTABLE', 'PYTHONSAFEPATH', 'PYTHONINSPECT', 'PYTHONBREAKPOINT', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'CONDA_DEFAULT_ENV', 'CONDA_SHLVL', 'CONDA_PYTHON_EXE', '__PYVENV_LAUNCHER__'];
function venvRootOf(python) {
  if (!python) return '';
  const bin = path.dirname(python);
  return /^(Scripts|bin)$/i.test(path.basename(bin)) ? path.dirname(bin) : bin;
}
/** f: what findFramePack found → { env, path: [the folders put first on PATH], venv, dropped: [names removed] } */
function buildEnv(f, o = {}) {
  const win = (o.platform || process.platform) === 'win32';
  const env = {}; const dropped = [];
  const src = Object.assign({}, o.base || process.env, o.extra || {});
  let oldPath = '';
  for (const [k, v] of Object.entries(src)) {
    if (v == null) continue;
    const K = k.toUpperCase();
    if (K === 'PATH') { if (!oldPath) oldPath = String(v); continue; } // Windows has "Path": one PATH only
    if (DROP_ENV.includes(K)) { dropped.push(k); continue; }
    env[k] = String(v);
  }
  const root = venvRootOf(f.python);
  const isVenv = !!(root && (isFile(path.join(root, 'pyvenv.cfg')) || /^(Scripts|bin)$/i.test(path.basename(path.dirname(f.python || '')))));
  const first = [];
  if (f.python) first.push(path.dirname(f.python));
  if (root && win) {
    for (const d of [path.join(root, 'Lib', 'site-packages', 'torch', 'lib'), path.join(root, 'Library', 'bin')]) if (isDir(d)) first.push(d);
  }
  const sep = win ? ';' : ':';
  const seen = new Set(); const parts = [];
  for (const d of [...first, ...String(oldPath).split(sep)]) { if (!d) continue; const key = win ? d.toLowerCase() : d; if (seen.has(key)) continue; seen.add(key); parts.push(d); }
  env.PATH = parts.join(sep);
  if (isVenv && root && isFile(path.join(root, 'pyvenv.cfg'))) env.VIRTUAL_ENV = root;
  Object.assign(env, {
    HF_HOME: f.hfHome || '', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1',
    PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', AUTOINJECTOR_FRAMEPACK_DIR: f.dir || '',
  });
  if (!env.HF_HOME) delete env.HF_HOME;
  return { env, path: first, venv: isVenv ? root : '', dropped };
}

// ------------------------------------------------------------------ the PyTorch pre-check in plain words
/** The runner's --precheck facts → null (fine) | a FRAMEPACK_TORCH_FAILED failure with the reason in plain words. */
function explainPrecheck(info, o = {}) {
  const tail = o.tail || [];
  const extra = (cause) => ({ engine: 'framepack', cause, serverError: lastLines(tail), precheck: info || null });
  if (o.cancelled) return fail('FRAMEPACK_CANCELLED', 'Stopped.', '', { engine: 'framepack' });
  if (o.timedOut) return fail('FRAMEPACK_TORCH_FAILED', `PyTorch (in FramePack's Python) did not start within ${clock(o.seconds || 0)}.`,
    'Restart the PC (an old FramePack can still hold the graphics card), add the FramePack folder to your antivirus exclusions (it scans every PyTorch file on the first start), check FramePack starts in Stability Matrix, then press ↻ Try again.', extra('TORCH_TIMEOUT'));
  if (!info) {
    const t = tail.join('\n');
    if (/No module named '?torch'?/i.test(t)) return fail('FRAMEPACK_TORCH_FAILED', 'PyTorch is not installed in FramePack\'s Python.', 'Repair or reinstall the FramePack package in Stability Matrix (it installs PyTorch), then try again.', extra('TORCH_MISSING'));
    return fail('FRAMEPACK_TORCH_FAILED', `FramePack's Python stopped before it could check PyTorch${o.exitCode != null ? ` (exit code ${o.exitCode})` : ''}.`, 'Start FramePack once from Stability Matrix to see that it works, then try again. The details show what Python printed.', extra('PYTHON_FAILED'));
  }
  if (info.ok) return null;
  const err = String(info.error || '');
  if (err) {
    if (/No module named '?torch'?/i.test(err)) return fail('FRAMEPACK_TORCH_FAILED', 'PyTorch is not installed in FramePack\'s Python.', 'Repair or reinstall the FramePack package in Stability Matrix (it installs PyTorch), then try again.', extra('TORCH_MISSING'));
    if (/DLL load failed|WinError 126|WinError 127|WinError 1114|\.dll|cannot open shared object|OSError/i.test(err)) {
      const dll = (err.match(/"([^"]+\.dll)"|'([^']+\.dll)'|([\w.-]+\.dll)/i) || []).slice(1).find(Boolean);
      return fail('FRAMEPACK_TORCH_FAILED', `PyTorch could not load one of its files${dll ? ` (${dll})` : ''}: ${err.slice(0, 300)}`,
        'Install the latest "Microsoft Visual C++ Redistributable (x64)" and the NVIDIA graphics driver, restart the PC, then try again. If it still fails, repair the FramePack package in Stability Matrix.', extra('TORCH_DLL'));
    }
    if (/No module named/i.test(err)) { const m = err.match(/No module named '?([\w.]+)'?/i); return fail('FRAMEPACK_TORCH_FAILED', `FramePack's Python is missing a part (${m ? m[1] : 'a module'}) that PyTorch needs.`, 'Repair or update the FramePack package in Stability Matrix, then try again.', extra('TORCH_BROKEN')); }
    return fail('FRAMEPACK_TORCH_FAILED', `PyTorch did not start in FramePack's Python: ${err.slice(0, 300)}`, 'Repair the FramePack package in Stability Matrix, restart the PC, then try again.', extra('TORCH_BROKEN'));
  }
  if (info.cuda === false) {
    if (!info.cuda_build || /\+cpu/i.test(String(info.torch || ''))) return fail('FRAMEPACK_TORCH_FAILED', `FramePack's PyTorch (${info.torch || '?'}) is the processor-only version — it cannot use the graphics card.`, 'Reinstall the FramePack package in Stability Matrix with the NVIDIA (CUDA) option.', extra('TORCH_CPU_ONLY'));
    return fail('FRAMEPACK_TORCH_FAILED', `PyTorch ${info.torch || ''} (built for CUDA ${info.cuda_build}) does not see an NVIDIA graphics card.`, 'Install or update the NVIDIA graphics driver and restart the PC. FramePack needs an NVIDIA card; it does not run on the processor.', extra('NO_GPU'));
  }
  if (info.device_error) return fail('FRAMEPACK_TORCH_FAILED', `PyTorch sees the graphics card but could not use it: ${String(info.device_error).slice(0, 300)}`, 'Close other programs that use the graphics card (or an old FramePack still running), update the NVIDIA driver, restart the PC, then try again.', extra('GPU_BUSY'));
  return fail('FRAMEPACK_TORCH_FAILED', 'PyTorch did not say it can use the graphics card.', 'Try again; the details show what it printed.', extra('TORCH_UNKNOWN'));
}
function clock(secs) { const s = Math.max(0, Math.round(secs)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

// How long a loading stage may take before AutoInjector says it seems stuck (it does not stop it by itself).
const STAGE_LIMITS = { precheck: 5 * 60000, start: 2 * 60000, torch: 5 * 60000, cuda: 3 * 60000, model: 15 * 60000, gpu: 10 * 60000 };
function stageKind(stage, phase) {
  if (phase === 'precheck') return 'precheck';
  if (phase === 'starting') return 'start';
  if (/PyTorch/i.test(stage || '')) return 'torch';
  if (/CUDA/i.test(stage || '')) return 'cuda';
  if (/preparing the graphics card/i.test(stage || '')) return 'gpu';
  return 'model';
}
// A saved last-load record (from the settings file) → the same shape, or null.
function cleanLastLoad(x) {
  if (!x || typeof x !== 'object' || !Number.isFinite(Number(x.at))) return null;
  const s = (v, n) => String(v == null ? '' : v).slice(0, n);
  if (x.ok) return { ok: true, at: Number(x.at), tested: !!x.tested, testedAt: Number.isFinite(Number(x.testedAt)) && x.testedAt ? Number(x.testedAt) : null };
  return { ok: false, at: Number(x.at), code: s(x.code, 60) || 'FRAMEPACK_FAILED', reason: s(x.reason, 600), fix: s(x.fix, 1200), cause: s(x.cause, 40), stage: s(x.stage, 120), detail: s(x.detail, 1500) };
}
function stuckWords(kind, stage, secs, where) {
  const t = clock(secs);
  const at = where ? ` (it is in ${where.split(' < ')[0]})` : '';
  if (kind === 'precheck' || kind === 'torch') return { message: `PyTorch has been starting for ${t}${at}. The first start on Windows can take several minutes while antivirus scans its files, but this is longer than usual — it seems stuck.`,
    fix: 'Wait a little longer, or press ⏹ Stop and then ↻ Try again. If it happens every time: add the FramePack folder to your antivirus exclusions, restart the PC (an old FramePack can still hold the graphics card), and check FramePack starts in Stability Matrix.' };
  if (kind === 'start') return { message: `FramePack's Python has not answered for ${t} — it seems stuck.`, fix: 'Press ⏹ Stop and ↻ Try again. If it keeps happening, restart the PC and check FramePack starts in Stability Matrix.' };
  if (kind === 'cuda') return { message: `Checking the graphics card has taken ${t}${at} — it seems stuck.`, fix: 'Press ⏹ Stop, close other programs that use the graphics card, update the NVIDIA driver, restart the PC, then ↻ Try again.' };
  if (kind === 'gpu') return { message: `Preparing the graphics card has taken ${t}${at} — it seems stuck.`, fix: 'Press ⏹ Stop and ↻ Try again. Close other programs that use the graphics card; raise "GPU memory to keep free" if the card is small.' };
  return { message: `Loading ${stage || 'the models'} has taken ${t}${at} — longer than usual, it may be stuck.`, fix: 'Model files on a slow, external or network drive load slowly. Wait a little longer, or press ⏹ Stop and ↻ Try again. The models folder is best on a local SSD.' };
}

// Stop a process and everything it started (Windows: a venv's python.exe is a launcher with the real python under it).
function killTree(child) {
  if (!child) return;
  const pid = child.pid;
  if (process.platform === 'win32' && pid) {
    let k = null;
    try { k = nodeSpawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) { k = null; }
    if (k) { k.on('error', () => { try { child.kill(); } catch (_) {} }); k.on('exit', () => { try { child.kill(); } catch (_) {} }); } else { try { child.kill(); } catch (_) {} }
    return;
  }
  if (pid && child._fpGroup) { try { process.kill(-pid, 'SIGKILL'); return; } catch (_) {} }
  try { child.kill('SIGKILL'); } catch (_) {}
}

// ------------------------------------------------------------------ the runner process
function createFramePack(deps = {}) {
  const log = deps.log || (() => {});
  const onEvent = deps.onEvent || (() => {});
  const spawn = deps.spawn || nodeSpawn;
  const kill = deps.killTree || killTree;
  const readyTimeoutMs = deps.readyTimeoutMs || 120000;
  const cancelKillMs = deps.cancelKillMs || 15000; // a video that does not answer ⏹ Stop between steps
  const cancelGraceMs = deps.cancelGraceMs != null ? deps.cancelGraceMs : 1500; // loading can't stop inside an import
  const precheckTimeoutMs = deps.precheckTimeoutMs || 10 * 60000;
  const precheckOn = deps.precheck !== false;
  const limits = Object.assign({}, STAGE_LIMITS, deps.stageLimitsMs || {});
  const envLimit = Number(process.env.AUTOINJECTOR_FRAMEPACK_STAGE_LIMIT_MS || 0); // tests (the e2e): every stage's limit
  if (envLimit > 0) for (const k of Object.keys(limits)) limits[k] = envLimit;
  const watchMs = deps.watchMs || 1000;
  const stillLogMs = deps.stillLogMs || 60000;
  const group = process.platform !== 'win32'; // posix: own process group, so Stop takes its children too
  let cache = null; // { at, info }
  let proc = null; // { child, dir, hfHome, ready: Promise, buf, tail: [] }
  let attention = null; // which attention FramePack uses on this card (the runner turns off kernels that can't run)
  let loaded = false;
  // loading: { phase: precheck|starting|loading, stage, step, steps, startedAt, stageStartedAt, stuck, where, heartbeatAt, stages: [] }
  let loading = null;
  let loadWait = null; // Promise of the running load
  let loadCancel = null; // { at } while a Stop of the load is going on
  let pre = null; // { ok, python, info, at } — the last PyTorch pre-check
  let preProc = null; // the pre-check process while it runs
  let job = null; // { id, resolve, onProgress, cancelled, killTimer }
  let vramGB = null; let highVram = null; let lastError = null; let gpu = null;
  let stopping = null; // { at } between ⏹ Stop and the runner being gone
  let lastTail = []; // what the last runner / pre-check printed (stderr), kept after it is gone
  let watch = null;
  const waiters = new Map(); // id -> resolve (load / status)
  // The last REAL load of the models (▶ Load, 🧪 Test or a video) — separate from "the model files are found":
  // { ok, at, tested, testedAt } or { ok: false, at, code, reason, fix, cause, stage, detail }. Saved by the app (deps.onLastLoad).
  let lastLoad = cleanLastLoad(deps.lastLoad);

  function noteLoad(rec) {
    const prev = lastLoad; const now = Date.now();
    const keepTest = !!(prev && prev.ok && prev.tested);
    lastLoad = rec.ok ? { ok: true, at: now, tested: !!rec.tested || keepTest, testedAt: rec.tested ? now : keepTest ? prev.testedAt || prev.at : null }
      : { ok: false, at: now, code: rec.code || 'FRAMEPACK_FAILED', reason: rec.reason || 'FramePack could not be loaded.', fix: rec.fix || '', cause: rec.cause || '', stage: rec.stage || '', detail: String(rec.detail || '').slice(-1500) };
    log('framepack-last-load', Object.assign({}, lastLoad, { detail: undefined }));
    try { if (deps.onLastLoad) deps.onLastLoad(Object.assign({}, lastLoad)); } catch (_) {}
  }
  // A failure: lastError (the screen's "last problem"); while loading it is also the last load's result (with the stage).
  function setError(r, isLoad, stage) {
    const st = stage || (loading ? loading.stage : '');
    lastError = { code: r.code, message: r.message, fix: r.fix, at: Date.now(), detail: r.serverError || '', load: !!isLoad, stage: isLoad ? st : undefined, cause: r.cause || undefined };
    if (isLoad) noteLoad({ ok: false, code: r.code, reason: r.message, fix: r.fix, cause: r.cause, stage: st, detail: r.serverError || '' });
  }

  function find(fresh) {
    if (!fresh && cache && Date.now() - cache.at < 5000) return cache.info;
    let info;
    try { info = deps.find ? deps.find() : findFramePack(); } catch (e) { info = { found: false, message: String((e && e.message) || e), models: checkModels('') }; }
    cache = { at: Date.now(), info };
    return info;
  }
  function refresh() {
    cache = null;
    const f = find(true);
    // a different folder or model place than the running runner: stop it (the next job starts the right one)
    if (proc && (proc.dir !== f.dir || proc.hfHome !== f.hfHome)) stop();
    if (pre && pre.python !== f.python) pre = null;
    return status();
  }
  async function refreshGpu() {
    if (!deps.gpu) return gpu;
    try { const g = await deps.gpu(); if (g) gpu = g; } catch (_) {}
    return gpu;
  }
  function vramHint() {
    const g = gpu;
    if (vramGB != null) return `FramePack sees ${vramGB} GB of free graphics memory${highVram ? ' (it keeps every model on the card)' : ' (it swaps the models in and out — slower, but works from 6 GB)'}.`;
    if (!g || !g.name) return `FramePack needs an NVIDIA graphics card with at least ${MIN_VRAM_GB} GB of memory.`;
    const gb = g.vramMB ? Math.round(g.vramMB / 1024) : null;
    if (g.vendor && g.vendor !== 'nvidia') return `Your graphics card (${g.name}) is not NVIDIA — FramePack needs an NVIDIA card (CUDA).`;
    if (gb != null && gb < MIN_VRAM_GB) return `Your graphics card (${g.name}, ${gb} GB) has less than the ${MIN_VRAM_GB} GB FramePack needs — it may not work.`;
    return `Your graphics card: ${g.name}${gb ? ` (${gb} GB)` : ''}. FramePack works from ${MIN_VRAM_GB} GB; with less than 60 GB free it swaps the models in and out (slower, but fine).`;
  }

  // ---- loading stages: elapsed time, timings in the log, "seems stuck"
  function loadingPublic() {
    if (!loading) return null;
    const now = Date.now();
    const kind = stageKind(loading.stage, loading.phase);
    const words = loading.stuck ? stuckWords(kind, loading.stage, (now - loading.stageStartedAt) / 1000, loading.where) : null;
    return { phase: loading.phase, stage: loading.stage, step: loading.step, steps: loading.steps, startedAt: loading.startedAt, stageStartedAt: loading.stageStartedAt,
      seconds: Math.round((now - loading.startedAt) / 1000), stageSeconds: Math.round((now - loading.stageStartedAt) / 1000), limitSeconds: Math.round((limits[kind] || 0) / 1000),
      stuck: !!loading.stuck, stuckMessage: words ? words.message : '', stuckFix: words ? words.fix : '', where: loading.where || '', stopping: !!loadCancel,
      text: stageText(loading) };
  }
  function stageText(l) {
    if (!l) return '';
    if (l.phase === 'precheck') return 'PyTorch is starting (the first time on Windows can take several minutes — antivirus scans its files)';
    if (l.phase === 'starting') return 'starting FramePack\'s Python';
    if (/^starting PyTorch$/i.test(l.stage)) return 'starting PyTorch';
    return `loading ${l.stage}`;
  }
  function beginLoading(phase, stage) {
    const now = Date.now();
    // a new try: the old problem is not "now" any more (a Stop then goes back to idle, not red); the card keeps the last load result
    if (!loading) { loading = { phase, stage, step: 0, steps: 0, startedAt: now, stageStartedAt: now, stuck: false, where: '', stages: [], lastStillLog: now }; lastError = null; }
    else setStage(stage, 0, loading.steps, phase);
    if (!watch) { watch = setInterval(tickWatch, watchMs); if (watch.unref) watch.unref(); }
    onEvent({ type: 'loading', phase, stage, step: 0, steps: loading.steps, text: stageText(loading) });
  }
  function setStage(stage, step, steps, phase) {
    const now = Date.now();
    if (!loading) { beginLoading(phase || 'loading', stage); loading.step = step || 0; loading.steps = steps || 0; return; }
    const prev = { stage: loading.stage, phase: loading.phase, seconds: Math.round((now - loading.stageStartedAt) / 100) / 10 };
    if (loading.stage !== stage || loading.phase !== (phase || loading.phase)) {
      loading.stages.push(prev);
      log('framepack-stage', { stage, step: step || 0, steps: steps || 0, after: prev.stage, afterSeconds: prev.seconds, totalSeconds: Math.round((now - loading.startedAt) / 100) / 10 });
      loading.stageStartedAt = now; loading.stuck = false; loading.where = ''; loading.lastStillLog = now;
    }
    loading.stage = stage; loading.step = step || 0; if (steps) loading.steps = steps; loading.phase = phase || loading.phase;
  }
  function endLoading(how, extra) {
    const l = loading; if (!l) return;
    loading = null;
    if (watch) { clearInterval(watch); watch = null; }
    if (how !== 'loaded') pre = null; // stuck / stopped / failed: the next try checks PyTorch again (fresh words for what is wrong)
    if (how === 'loaded') noteLoad({ ok: true });
    const secs = Math.round((Date.now() - l.startedAt) / 100) / 10;
    const stages = [...l.stages, { stage: l.stage, phase: l.phase, seconds: Math.round((Date.now() - l.stageStartedAt) / 100) / 10 }];
    log(how === 'loaded' ? 'framepack-loaded' : how === 'cancelled' ? 'framepack-load-stopped' : 'framepack-load-failed',
      Object.assign({ seconds: secs, stage: l.stage, stages, severity: how === 'failed' ? 'error' : undefined }, extra || {}));
  }
  function tickWatch() {
    if (!loading) { if (watch) { clearInterval(watch); watch = null; } return; }
    const now = Date.now();
    const kind = stageKind(loading.stage, loading.phase);
    const secs = (now - loading.stageStartedAt) / 1000;
    if (!loading.stuck && limits[kind] && now - loading.stageStartedAt >= limits[kind]) {
      loading.stuck = true;
      const w = stuckWords(kind, loading.stage, secs, loading.where);
      log('framepack-stuck', { stage: loading.stage, phase: loading.phase, seconds: Math.round(secs), where: loading.where || '', message: w.message, stderr: tailNow().slice(-50), severity: 'warn' });
      onEvent({ type: 'stuck', stage: loading.stage, seconds: Math.round(secs), message: w.message, fix: w.fix });
    }
    if (now - loading.lastStillLog >= stillLogMs) {
      loading.lastStillLog = now;
      const t = tailNow();
      log('framepack-still-loading', { stage: loading.stage, phase: loading.phase, stageSeconds: Math.round(secs), totalSeconds: Math.round((now - loading.startedAt) / 1000), where: loading.where || '', lastOutput: t.length ? t[t.length - 1] : '' });
      onEvent({ type: 'tick', stage: loading.stage, seconds: Math.round(secs) });
    }
  }
  function tailNow() { return (proc && proc.tail.length ? proc.tail : preProc && preProc._fpTail ? preProc._fpTail : lastTail).slice(-50); }

  function status(o = {}) {
    const f = find(!!o.fresh);
    return Object.assign({}, f, {
      models: f.models, running: !!proc, loaded, loading: loadingPublic(), busy: !!job || !!loadWait,
      job: job ? { id: job.id, phase: job.phase || 'starting' } : null, vramGB, highVram, attention, gpu: gpu ? { name: gpu.name || '', vramMB: gpu.vramMB || null, vendor: gpu.vendor || '' } : null,
      vramHint: vramHint(), lastError, lastLoad: lastLoad ? Object.assign({}, lastLoad) : null, minVramGB: MIN_VRAM_GB, fps: FPS, stopping: !!stopping || !!loadCancel,
      stderrTail: tailNow(), precheck: pre ? Object.assign({ ok: pre.ok, at: pre.at }, pick(pre.info || {}, ['torch', 'cuda', 'cuda_build', 'device', 'free_gb', 'total_gb', 'seconds', 'import_seconds', 'error'])) : null,
    });
  }

  function send(obj) {
    if (!proc || !proc.child || !proc.child.stdin || proc.child.stdin.destroyed || proc.child.stdin.writableEnded) return false;
    try { proc.child.stdin.write(`${JSON.stringify(obj)}\n`); return true; } catch (_) { return false; }
  }
  function withTail(r, tail) {
    if (!r || r.ok) return r;
    const t = lastLines(tail || tailNow());
    if (t && !(r.serverError || '').includes(t)) r.serverError = r.serverError ? `${r.serverError}\n\n— what FramePack printed last —\n${t}` : t;
    return r;
  }

  function handle(ev) {
    if (!ev || typeof ev !== 'object') return;
    const p = proc;
    if (ev.event === 'ready') { if (p && p.onReady) p.onReady(ev); return; }
    if (ev.event === 'heartbeat') { if (loading) { loading.where = ev.where || loading.where; loading.heartbeatAt = Date.now(); } if (p) p.heartbeatAt = Date.now(); return; }
    if (ev.event === 'attention') { attention = { using: ev.using || '', disabled: Array.isArray(ev.disabled) ? ev.disabled : [], reasons: Array.isArray(ev.reasons) ? ev.reasons.map((r) => String(r).slice(0, 200)) : [] }; log('framepack-attention', attention); return; }
    if (ev.event === 'loading') {
      setStage(ev.stage || '', ev.step || 0, ev.steps || 0, 'loading');
      if (job) { job.phase = 'loading'; try { job.onProgress && job.onProgress({ phase: 'loading', stage: ev.stage, step: ev.step, steps: ev.steps }); } catch (_) {} }
      onEvent({ type: 'loading', phase: 'loading', stage: ev.stage, step: ev.step, steps: ev.steps, text: stageText(loading) });
      return;
    }
    if (ev.event === 'loaded') {
      loaded = true; if (ev.vram_gb != null) vramGB = ev.vram_gb; if (ev.high_vram != null) highVram = !!ev.high_vram;
      endLoading('loaded', { vramGB, highVram, already: !!ev.already });
      lastError = null;
      onEvent({ type: 'loaded', vramGB, highVram });
      const w = waiters.get('load'); if (w) { waiters.delete('load'); w({ ok: true, loaded: true, vramGB, highVram, already: !!ev.already }); }
      return;
    }
    if (ev.event === 'status' || ev.event === 'pong') { const w = waiters.get(ev.event); if (w) { waiters.delete(ev.event); w(ev); } return; }
    if (job && ev.id === job.id) {
      if (ev.event === 'accepted') { job.sections = ev.sections; job.frames = ev.frames; return; }
      if (ev.event === 'progress') { if (loading) endLoading('loaded'); job.phase = ev.phase || 'sampling'; try { job.onProgress && job.onProgress(ev); } catch (_) {} return; }
      if (ev.event === 'result') { noteLoad({ ok: true, tested: true }); return finish(Object.assign({ ok: true, engine: 'framepack' }, pick(ev, ['path', 'poster', 'frames', 'fps', 'seconds', 'width', 'height', 'sections', 'seed']))); }
      if (ev.event === 'cancelled') { if (loading) endLoading('cancelled'); return finish(fail('FRAMEPACK_CANCELLED', 'Stopped.', '', { engine: 'framepack' })); }
      if (ev.event === 'error') {
        // a video (or the 🧪 test) that failed — while loading too: the screen hears about it (light, header, card)
        const r = withTail(fromRunner(ev)); const wasLoading = !!loading;
        setError(r, wasLoading);
        if (loading) endLoading('failed', { code: r.code, message: r.message, stderr: tailNow() });
        if (r.code === 'FRAMEPACK_OOM') loaded = false;
        finish(r);
        onEvent({ type: 'error', code: r.code, message: r.message, fix: r.fix, load: wasLoading, job: true });
        return;
      }
    }
    if (ev.event === 'cancelled' && waiters.get('load')) {
      const w = waiters.get('load'); waiters.delete('load'); endLoading('cancelled'); w(fail('FRAMEPACK_CANCELLED', 'Stopped.', '', { engine: 'framepack' })); return;
    }
    if (ev.event === 'error') {
      const w = waiters.get('load');
      const r = withTail(fromRunner(ev));
      setError(r, !!loading || !!w);
      if (loading) endLoading('failed', { code: r.code, message: r.message, stderr: tailNow() });
      if (w) { waiters.delete('load'); w(r); }
      onEvent({ type: 'error', code: r.code, message: r.message, fix: r.fix });
    }
  }
  function pick(o, keys) { const out = {}; for (const k of keys) if (o[k] !== undefined) out[k] = o[k]; return out; }
  function finish(r) {
    const j = job; if (!j) return;
    job = null;
    if (j.killTimer) clearTimeout(j.killTimer);
    j.resolve(r);
  }
  function lineSplitter(onLine) {
    let buf = '';
    return (d) => {
      buf += d.toString('utf8');
      const parts = buf.split(/\r\n|\n|\r/);
      buf = parts.pop();
      if (buf.length > 8000) { onLine(buf.slice(0, 8000)); buf = ''; }
      for (const l of parts) onLine(l);
    };
  }

  // ---- the PyTorch pre-check: FramePack's python imports torch and asks CUDA (once per python), before the runner
  function runPrecheck(f) {
    const runnerIsJs = /\.m?js$/i.test(f.runner);
    const args = [...(runnerIsJs ? [] : ['-u']), f.runner, '--precheck', '--framepack-dir', f.dir, '--hf-home', f.hfHome];
    const be = buildEnv(f, { extra: deps.env });
    beginLoading('precheck', 'checking PyTorch');
    log('framepack-precheck-start', { python: f.python, cwd: f.dir, venv: be.venv, pathFirst: be.path, removed: be.dropped });
    return new Promise((resolve) => {
      const t0 = Date.now();
      let child;
      try { child = spawn(f.python, args, { cwd: f.dir, env: be.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: group }); }
      catch (e) { resolve(fail('FRAMEPACK_PYTHON_MISSING', `FramePack's Python could not be started (${e.code || e.message}).`, 'Start FramePack once from Stability Matrix, or reinstall it there.', { engine: 'framepack' })); return; }
      child._fpGroup = group; child._fpTail = [];
      preProc = child;
      let info = null; let done = false; let timedOut = false;
      const end = (r) => {
        if (done) return; done = true; clearTimeout(timer);
        if (preProc === child) preProc = null;
        lastTail = child._fpTail.slice(-50);
        resolve(r);
      };
      const timer = setTimeout(() => { timedOut = true; log('framepack-precheck-timeout', { seconds: Math.round((Date.now() - t0) / 1000), where: loading && loading.where, stderr: child._fpTail.slice(-50), severity: 'error' }); kill(child); }, precheckTimeoutMs);
      child.stdout.on('data', lineSplitter((line) => {
        const s = line.trim(); if (!s) return;
        let ev = null; try { ev = JSON.parse(s); } catch (_) { ev = null; }
        if (!ev || typeof ev !== 'object') { child._fpTail.push(s.slice(0, 2000)); if (child._fpTail.length > 80) child._fpTail.shift(); return; }
        if (ev.event === 'precheck-start') { if (loading) setStage('importing PyTorch', 0, 0, 'precheck'); log('framepack-precheck-python', { python: ev.python, executable: ev.executable, cwd: ev.cwd, pid: ev.pid, seconds: Math.round((Date.now() - t0) / 100) / 10 }); }
        else if (ev.event === 'heartbeat') { if (loading) { loading.where = ev.where || ''; loading.heartbeatAt = Date.now(); } }
        else if (ev.event === 'precheck') info = ev;
      }));
      child.stderr.on('data', lineSplitter((line) => { if (line.trim()) { child._fpTail.push(line.slice(0, 2000)); if (child._fpTail.length > 80) child._fpTail.shift(); } }));
      child.on('error', (e) => end(e && e.code === 'ENOENT' ? fail('FRAMEPACK_PYTHON_MISSING', `FramePack's Python was not found (${f.python}).`, 'Start FramePack once from Stability Matrix (it makes its venv), or reinstall it there.', { engine: 'framepack' })
        : fail('FRAMEPACK_FAILED', `FramePack's Python could not be started (${(e && (e.code || e.message)) || 'error'}).`, '', { engine: 'framepack' })));
      child.on('close', (code) => {
        const secs = Math.round((Date.now() - t0) / 100) / 10;
        const r = explainPrecheck(info, { tail: child._fpTail, timedOut, seconds: secs, exitCode: code, cancelled: !!loadCancel && !timedOut });
        pre = { ok: !r, python: f.python, info: info || null, at: Date.now() };
        if (loadCancel && !proc && stopping) { log('framepack-stopped', { seconds: Math.round((Date.now() - stopping.at) / 100) / 10, while: 'PyTorch check' }); stopping = null; onEvent({ type: 'stopped' }); }
        log('framepack-precheck', Object.assign({ ok: !r, seconds: secs, code: r ? r.code : undefined, cause: r ? r.cause : undefined, message: r ? r.message : undefined },
          info ? { torch: info.torch, cuda: info.cuda, cudaBuild: info.cuda_build, device: info.device, freeGB: info.free_gb, importSeconds: info.import_seconds, error: info.error } : { exitCode: code },
          r && r.code !== 'FRAMEPACK_CANCELLED' ? { stderr: child._fpTail.slice(-50), severity: 'error' } : {}));
        end(r);
      });
    });
  }

  // Start the runner (once). → null | a FRAMEPACK_* failure
  function ensure() {
    if (proc) return proc.ready;
    const f = find(true);
    const nr = notReady(f);
    if (nr) return Promise.resolve(nr);
    const runnerIsJs = /\.m?js$/i.test(f.runner);
    const args = [...(runnerIsJs ? [] : ['-u']), f.runner, '--framepack-dir', f.dir, '--hf-home', f.hfHome];
    const be = buildEnv(f, { extra: deps.env });
    let child;
    try { child = spawn(f.python, args, { cwd: f.dir, env: be.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: group }); }
    catch (e) { return Promise.resolve(fail('FRAMEPACK_PYTHON_MISSING', `FramePack's Python could not be started (${e.code || e.message}).`, 'Start FramePack once from Stability Matrix, or reinstall it there.', { engine: 'framepack' })); }
    child._fpGroup = group;
    const p = { child, dir: f.dir, hfHome: f.hfHome, tail: [], started: Date.now() };
    if (child.stdin) child.stdin.on('error', () => {}); // the runner went away (EPIPE): its exit says why
    proc = p;
    if (loading && loading.phase !== 'loading') setStage('starting FramePack\'s Python', 0, 0, 'starting');
    log('framepack-start', { dir: f.dir, hf: f.hfSource, hfHome: f.hfHome, pid: child.pid, python: f.python, venv: be.venv, pathFirst: be.path, removed: be.dropped });
    p.ready = new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => { if (done) return; done = true; resolve(withTail(Object.assign(explainExit(p.tail, null, null), { message: 'FramePack did not start in time.' }), p.tail)); stop(); }, readyTimeoutMs);
      p.onReady = (ev) => { if (done) return; done = true; clearTimeout(t); log('framepack-ready', { seconds: Math.round((Date.now() - p.started) / 100) / 10, python: ev && ev.python }); resolve(null); };
      p.onFail = (r) => { if (done) return; done = true; clearTimeout(t); resolve(r); };
    });
    // Both pipes are always read to the end (a full stderr pipe would stop the runner mid-print).
    child.stdout.on('data', lineSplitter((line) => {
      const s = line.trim(); if (!s) return;
      let ev = null; try { ev = JSON.parse(s); } catch (_) { ev = null; }
      if (ev && typeof ev === 'object') handle(ev); else pushTail(p, s);
    }));
    child.stderr.on('data', lineSplitter((line) => { if (line.trim()) pushTail(p, line); }));
    child.on('error', (e) => {
      const r = e && e.code === 'ENOENT' ? fail('FRAMEPACK_PYTHON_MISSING', `FramePack's Python was not found (${f.python}).`, 'Start FramePack once from Stability Matrix (it makes its venv), or reinstall it there.', { engine: 'framepack' })
        : fail('FRAMEPACK_FAILED', `FramePack could not be started (${(e && (e.code || e.message)) || 'error'}).`, '', { engine: 'framepack' });
      gone(p, r);
    });
    child.on('exit', (code, signal) => gone(p, explainExit(p.tail, code, signal)));
    return p.ready;
  }
  function pushTail(p, line) { p.tail.push(String(line).slice(0, 2000)); if (p.tail.length > 80) p.tail.shift(); }
  function gone(p, r0) {
    if (proc !== p) return;
    proc = null; loaded = false;
    lastTail = p.tail.slice(-50);
    const wasStopping = !!p.stopping;
    const cancelledLoad = !!loadCancel;
    const r = wasStopping || cancelledLoad ? fail('FRAMEPACK_CANCELLED', 'Stopped.', '', { engine: 'framepack' }) : r0;
    const hadLoading = !!loading; const hadStage = loading ? loading.stage : '';
    if (loading) endLoading(cancelledLoad || wasStopping ? 'cancelled' : 'failed', cancelledLoad || wasStopping ? {} : { code: r.code, message: r.message, stderr: lastTail });
    log('framepack-exit', { code: r0.code, stopping: wasStopping, cancelledLoad, seconds: Math.round((Date.now() - p.started) / 1000), stopSeconds: p.stopAt ? Math.round((Date.now() - p.stopAt) / 100) / 10 : undefined });
    if (p.onFail) p.onFail(r);
    const w = waiters.get('load'); if (w) { waiters.delete('load'); w(r); }
    for (const k of ['status', 'pong']) { const x = waiters.get(k); if (x) { waiters.delete(k); x(null); } }
    if (job) { const cancelled = job.cancelled; if (!cancelled && !wasStopping) setError(r, hadLoading, hadStage); finish(cancelled ? fail('FRAMEPACK_CANCELLED', 'Stopped.', '', { engine: 'framepack' }) : r); }
    else if (!wasStopping && !cancelledLoad && r.code !== 'FRAMEPACK_CANCELLED' && (hadLoading || !lastError)) setError(r, hadLoading, hadStage);
    if (wasStopping || cancelledLoad || stopping) { const why = (stopping && stopping.why) || (cancelledLoad ? 'loading' : 'stop'); stopping = null; onEvent({ type: 'stopped', while: why }); log('framepack-stopped', { while: why, seconds: p.stopAt ? Math.round((Date.now() - p.stopAt) / 100) / 10 : null }); }
    onEvent({ type: 'exit', code: r.code });
  }

  // The pre-check (once per python, unless it failed) and then the runner.
  async function prepare() {
    const f = find(true);
    const nr = notReady(f);
    if (nr) return nr;
    if (!proc && precheckOn && !(pre && pre.ok && pre.python === f.python)) {
      const r = await runPrecheck(f);
      if (r) return r;
      if (loadCancel) return fail('FRAMEPACK_CANCELLED', 'Stopped.', '', { engine: 'framepack' });
    }
    if (!proc && !loading) beginLoading('starting', 'starting FramePack\'s Python');
    else if (!proc && loading) setStage('starting FramePack\'s Python', 0, 0, 'starting');
    return ensure();
  }

  function load() {
    if (loaded && proc) return Promise.resolve({ ok: true, loaded: true, already: true, vramGB, highVram });
    if (loadWait) return loadWait;
    loadCancel = null;
    log('framepack-load-start', {});
    loadWait = (async () => {
      if (!loading) beginLoading(precheckOn && !(pre && pre.ok) && !proc ? 'precheck' : 'starting', precheckOn && !(pre && pre.ok) && !proc ? 'checking PyTorch' : 'starting FramePack\'s Python');
      const bad = await prepare();
      if (bad) {
        // (not ready = the file check said no: that is not a load that was tried)
        if (bad.code !== 'FRAMEPACK_CANCELLED') setError(withTail(Object.assign({}, bad)), !notReady(find()));
        if (loading) endLoading(bad.code === 'FRAMEPACK_CANCELLED' ? 'cancelled' : 'failed', { code: bad.code, message: bad.message, stderr: bad.code === 'FRAMEPACK_CANCELLED' ? undefined : tailNow() });
        if (bad.code !== 'FRAMEPACK_CANCELLED') onEvent({ type: 'error', code: bad.code, message: bad.message, fix: bad.fix, load: true });
        return withTail(bad);
      }
      if (loadCancel) { if (loading) endLoading('cancelled'); return fail('FRAMEPACK_CANCELLED', 'Stopped.', '', { engine: 'framepack' }); }
      if (loaded) { if (loading) endLoading('loaded'); return { ok: true, loaded: true, already: true, vramGB, highVram }; }
      const r = await new Promise((resolve) => { waiters.set('load', resolve); if (!send({ cmd: 'load', id: `load-${Date.now()}` })) { waiters.delete('load'); resolve(fail('FRAMEPACK_FAILED', 'FramePack is not running.', '')); } });
      if (loading && !(r && r.ok)) endLoading(r && r.code === 'FRAMEPACK_CANCELLED' ? 'cancelled' : 'failed', { code: r && r.code });
      log('framepack-load', { ok: !!(r && r.ok), code: r && r.code, vramGB });
      return r;
    })().finally(() => { loadWait = null; loadCancel = null; });
    return loadWait;
  }

  /** req: { image, prompt, negative, seconds, seed, steps, cfg, gs, rs, use_teacache, mp4_crf, gpu_memory_preservation, out, poster, id } */
  async function generate(req, onProgress, o = {}) {
    if (job) return fail('FRAMEPACK_BUSY', 'FramePack is already making a video.', 'Wait for it, or press ⏹ Stop.', { engine: 'framepack' });
    const id = String((req && req.id) || crypto.randomUUID());
    const j = { id, resolve: null, onProgress, cancelled: false, phase: 'starting' };
    job = j; // claimed before anything async: a second generate is BUSY
    const promise = new Promise((resolve) => { j.resolve = resolve; });
    const cancelled = () => fail('FRAMEPACK_CANCELLED', 'Stopped.', '', { engine: 'framepack' });
    (async () => {
      if (loadWait) { onProgress && onProgress({ phase: 'loading', stage: (loading && loading.stage) || '' }); await loadWait; }
      if (j.cancelled) return finish(cancelled());
      if (!loaded || !proc) {
        j.phase = 'loading';
        loadCancel = null;
        if (!loading) beginLoading(precheckOn && !(pre && pre.ok) && !proc ? 'precheck' : 'starting', precheckOn && !(pre && pre.ok) && !proc ? 'checking PyTorch' : 'starting FramePack\'s Python');
        try { onProgress && onProgress({ phase: 'loading', stage: loading ? stageText(loading) : '' }); } catch (_) {}
      }
      const bad = await prepare();
      if (bad) {
        const failedLoad = bad.code !== 'FRAMEPACK_CANCELLED' && !j.cancelled;
        if (failedLoad) setError(withTail(Object.assign({}, bad)), !notReady(find()));
        if (loading) endLoading(j.cancelled || bad.code === 'FRAMEPACK_CANCELLED' ? 'cancelled' : 'failed', { code: bad.code, message: bad.message });
        loadCancel = null;
        finish(j.cancelled ? cancelled() : withTail(bad));
        if (failedLoad) onEvent({ type: 'error', code: bad.code, message: bad.message, fix: bad.fix, load: true, job: true });
        return;
      }
      loadCancel = null;
      if (j.cancelled) { if (loading) endLoading('cancelled'); return finish(cancelled()); }
      if (loaded && loading) endLoading('loaded');
      if (!send(Object.assign({}, req, { cmd: 'generate', id }))) finish(fail('FRAMEPACK_FAILED', 'FramePack is not running.', 'Try again.', { engine: 'framepack' }));
    })().catch((e) => finish(fail('FRAMEPACK_FAILED', `Something went wrong: ${(e && e.message) || e}`, '', { engine: 'framepack' })));
    let timer = null;
    if (o.timeoutMs) timer = setTimeout(() => { if (job === j) { cancel(); j.timedOut = true; } }, o.timeoutMs);
    const r = await promise;
    if (timer) clearTimeout(timer);
    // a ⏹ Stop while this video's load ran: that Stop is over now (else status() would say "Stopping…" for ever)
    if (!loadWait && !preProc && !(loading && proc)) loadCancel = null;
    if (j.timedOut && !r.ok) return fail('FRAMEPACK_TIMEOUT', 'FramePack did not finish in time.', 'Make a shorter clip, or raise the time limit (🎬 Video → Setup → Settings).', { engine: 'framepack' });
    log('framepack-generate', { ok: !!r.ok, code: r.code, seconds: r.seconds, frames: r.frames });
    return r;
  }

  // ⏹ Stop. While loading (pre-check, start, models): the runner can't stop inside an import, so after a short grace
  // the whole process tree is stopped. While a video renders: FramePack stops between steps; if it doesn't answer,
  // the process tree is stopped too (that frees the graphics card).
  function cancel() {
    const j = job;
    const isLoading = !!loading || !!preProc || (!!loadWait && !loaded);
    if (!j && !isLoading) return { ok: true, cancelled: false };
    const now = Date.now();
    if (j) j.cancelled = true;
    if (isLoading) {
      if (!loadCancel) loadCancel = { at: now };
      stopping = stopping || { at: now };
      log('framepack-stop-requested', { while: 'loading', stage: loading && loading.stage, stageSeconds: loading ? Math.round((now - loading.stageStartedAt) / 1000) : null });
      onEvent({ type: 'stopping', while: 'loading' });
      if (preProc) { log('framepack-kill', { reason: 'Stop while PyTorch was starting', pid: preProc.pid }); kill(preProc); }
      const p = proc;
      if (p) {
        p.stopAt = p.stopAt || now;
        send({ cmd: 'cancel', id: j ? j.id : undefined });
        const t = setTimeout(() => { if (proc === p) { log('framepack-kill', { reason: 'Stop while loading', pid: p.child.pid, stage: loading && loading.stage }); p.stopping = true; kill(p.child); } }, cancelGraceMs);
        if (t.unref) t.unref();
      }
      return { ok: true, cancelled: true, stopping: true };
    }
    send({ cmd: 'cancel', id: j.id });
    log('framepack-stop-requested', { while: 'making a video', phase: j.phase });
    onEvent({ type: 'stopping', while: 'video' });
    j.killTimer = setTimeout(() => { if (job === j && proc) { log('framepack-kill', { reason: 'Stop not answered', pid: proc.child.pid }); stopping = { at: Date.now() }; proc.stopping = true; proc.stopAt = Date.now(); kill(proc.child); } }, cancelKillMs);
    if (j.killTimer.unref) j.killTimer.unref();
    return { ok: true, cancelled: true };
  }
  function stop() {
    if (preProc) { loadCancel = loadCancel || { at: Date.now() }; kill(preProc); }
    const p = proc; if (!p) return { ok: true, stopped: false };
    if (p.stopping) return { ok: true, stopped: true };
    p.stopping = true; p.stopAt = Date.now();
    stopping = { at: Date.now(), why: 'unload' };
    onEvent({ type: 'stopping', while: 'unload' });
    send({ cmd: 'quit' });
    try { p.child.stdin.end(); } catch (_) {}
    const t = setTimeout(() => { if (proc === p) { log('framepack-kill', { reason: 'did not quit', pid: p.child.pid }); kill(p.child); } }, 3000); if (t.unref) t.unref();
    loaded = false;
    return { ok: true, stopped: true };
  }

  return { status, load, generate, cancel, stop, refresh, refreshGpu, find, busy: () => !!job || !!loadWait, isLoaded: () => loaded, isLoading: () => !!loading || !!preProc };
}

module.exports = { createFramePack, findFramePack, checkModels, isFramePackDir, venvPython, testPicture, notReady, explainExit, explainLoadError, explainPrecheck, buildEnv, killTree, stuckWords, stageKind, hasAnyModel, NEEDED, FPS, MIN_VRAM_GB, RUNNER, STAGE_LIMITS };
