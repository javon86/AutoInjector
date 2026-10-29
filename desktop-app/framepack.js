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
 *
 * The runner is integrations/framepack/framepack_runner.py, started with FramePack's OWN python
 * (its venv) in the FramePack folder, with HF_HOME = the model folder and HF_HUB_OFFLINE=1. It speaks
 * JSON lines on stdin/stdout (see that file). Tests point AUTOINJECTOR_FRAMEPACK_PYTHON /
 * AUTOINJECTOR_FRAMEPACK_RUNNER at a fake runner (test/fixtures/fake-framepack-runner.js).
 *
 * Error codes: FRAMEPACK_NOT_FOUND · FRAMEPACK_PYTHON_MISSING · FRAMEPACK_MODEL_MISSING (+ missing) ·
 * FRAMEPACK_OOM · FRAMEPACK_BUSY · FRAMEPACK_CANCELLED · FRAMEPACK_FAILED — each with a plain message + fix.
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
  return fail('FRAMEPACK_FAILED', `FramePack stopped unexpectedly${code != null ? ` (exit code ${code})` : signal ? ` (${signal})` : ''}.`, 'Try again. If it keeps happening, look at the details (what FramePack printed).', { engine: 'framepack', serverError: lastLines(tail) });
}
function lastLines(tail) { return tail.slice(-25).join('\n').slice(-3000); }
function fromRunner(ev) {
  const code = String(ev.code || 'FRAMEPACK_FAILED');
  const out = fail(code === 'BAD_REQUEST' ? 'FRAMEPACK_FAILED' : code, ev.message || 'FramePack could not make the video.', ev.fix || '', { engine: 'framepack' });
  if (ev.missing) out.missing = ev.missing;
  if (ev.detail) out.serverError = String(ev.detail).slice(0, 3000);
  if (ev.cause) out.cause = ev.cause;
  if (code === 'FRAMEPACK_OOM' && !out.fix) out.fix = 'Raise “GPU memory to keep free”, or make a shorter clip.';
  return out;
}

// ------------------------------------------------------------------ the runner process
function createFramePack(deps = {}) {
  const log = deps.log || (() => {});
  const onEvent = deps.onEvent || (() => {});
  const spawn = deps.spawn || nodeSpawn;
  const readyTimeoutMs = deps.readyTimeoutMs || 120000;
  const cancelKillMs = deps.cancelKillMs || 30000;
  let cache = null; // { at, info }
  let proc = null; // { child, dir, hfHome, ready: Promise, buf, tail: [] }
  let loaded = false; let loading = null; // loading: { stage, step, steps, startedAt }
  let loadWait = null; // Promise of the running load
  let job = null; // { id, resolve, onProgress, cancelled, killTimer }
  let vramGB = null; let highVram = null; let lastError = null; let gpu = null;
  const waiters = new Map(); // id -> resolve (load / status)

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

  function status(o = {}) {
    const f = find(!!o.fresh);
    return Object.assign({}, f, {
      models: f.models, running: !!proc, loaded, loading: loading ? Object.assign({}, loading) : null, busy: !!job || !!loadWait,
      job: job ? { id: job.id, phase: job.phase || 'starting' } : null, vramGB, highVram, gpu: gpu ? { name: gpu.name || '', vramMB: gpu.vramMB || null, vendor: gpu.vendor || '' } : null,
      vramHint: vramHint(), lastError, minVramGB: MIN_VRAM_GB, fps: FPS,
    });
  }

  function send(obj) {
    if (!proc || !proc.child || !proc.child.stdin || proc.child.stdin.destroyed || proc.child.stdin.writableEnded) return false;
    try { proc.child.stdin.write(`${JSON.stringify(obj)}\n`); return true; } catch (_) { return false; }
  }

  function handle(ev) {
    if (!ev || typeof ev !== 'object') return;
    const p = proc;
    if (ev.event === 'ready') { if (p && p.onReady) p.onReady(ev); return; }
    if (ev.event === 'loading') { loading = { stage: ev.stage || '', step: ev.step || 0, steps: ev.steps || 0, startedAt: (loading && loading.startedAt) || Date.now() }; if (job) { job.phase = 'loading'; try { job.onProgress && job.onProgress({ phase: 'loading', stage: ev.stage, step: ev.step, steps: ev.steps }); } catch (_) {} } onEvent({ type: 'loading', stage: ev.stage, step: ev.step, steps: ev.steps }); return; }
    if (ev.event === 'loaded') { loaded = true; loading = null; if (ev.vram_gb != null) vramGB = ev.vram_gb; if (ev.high_vram != null) highVram = !!ev.high_vram; onEvent({ type: 'loaded', vramGB, highVram }); const w = waiters.get('load'); if (w) { waiters.delete('load'); w({ ok: true, loaded: true, vramGB, highVram, already: !!ev.already }); } return; }
    if (ev.event === 'status' || ev.event === 'pong') { const w = waiters.get(ev.event); if (w) { waiters.delete(ev.event); w(ev); } return; }
    if (job && ev.id === job.id) {
      if (ev.event === 'accepted') { job.sections = ev.sections; job.frames = ev.frames; return; }
      if (ev.event === 'progress') { job.phase = ev.phase || 'sampling'; try { job.onProgress && job.onProgress(ev); } catch (_) {} return; }
      if (ev.event === 'result') return finish(Object.assign({ ok: true, engine: 'framepack' }, pick(ev, ['path', 'poster', 'frames', 'fps', 'seconds', 'width', 'height', 'sections', 'seed'])));
      if (ev.event === 'cancelled') return finish(fail('FRAMEPACK_CANCELLED', 'Stopped.', '', { engine: 'framepack' }));
      if (ev.event === 'error') { const r = fromRunner(ev); lastError = { code: r.code, message: r.message, at: Date.now() }; if (r.code === 'FRAMEPACK_OOM') loaded = false; return finish(r); }
    }
    if (ev.event === 'error') {
      const w = waiters.get('load');
      const r = fromRunner(ev);
      lastError = { code: r.code, message: r.message, at: Date.now() };
      loading = null;
      if (w) { waiters.delete('load'); w(r); }
      onEvent({ type: 'error', code: r.code, message: r.message });
    }
  }
  function pick(o, keys) { const out = {}; for (const k of keys) if (o[k] !== undefined) out[k] = o[k]; return out; }
  function finish(r) {
    const j = job; if (!j) return;
    job = null;
    if (j.killTimer) clearTimeout(j.killTimer);
    j.resolve(r);
  }

  // Start the runner (once). → null | a FRAMEPACK_* failure
  function ensure() {
    if (proc) return proc.ready;
    const f = find(true);
    const nr = notReady(f);
    if (nr) return Promise.resolve(nr);
    const runnerIsJs = /\.m?js$/i.test(f.runner);
    const args = [...(runnerIsJs ? [] : ['-u']), f.runner, '--framepack-dir', f.dir, '--hf-home', f.hfHome];
    const env = Object.assign({}, process.env, deps.env || {}, {
      HF_HOME: f.hfHome, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1',
      PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1', AUTOINJECTOR_FRAMEPACK_DIR: f.dir,
    });
    let child;
    try { child = spawn(f.python, args, { cwd: f.dir, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch (e) { return Promise.resolve(fail('FRAMEPACK_PYTHON_MISSING', `FramePack's Python could not be started (${e.code || e.message}).`, 'Start FramePack once from Stability Matrix, or reinstall it there.', { engine: 'framepack' })); }
    const p = { child, dir: f.dir, hfHome: f.hfHome, buf: '', tail: [], started: Date.now() };
    if (child.stdin) child.stdin.on('error', () => {}); // the runner went away (EPIPE): its exit says why
    proc = p;
    log('framepack-start', { dir: f.dir, hf: f.hfSource, pid: child.pid });
    p.ready = new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => { if (done) return; done = true; resolve(Object.assign(explainExit(p.tail, null, null), { message: 'FramePack did not start in time.' })); stop(); }, readyTimeoutMs);
      p.onReady = () => { if (done) return; done = true; clearTimeout(t); resolve(null); };
      p.onFail = (r) => { if (done) return; done = true; clearTimeout(t); resolve(r); };
    });
    child.stdout.on('data', (d) => {
      p.buf += d.toString('utf8');
      let i;
      while ((i = p.buf.indexOf('\n')) >= 0) {
        const line = p.buf.slice(0, i).trim(); p.buf = p.buf.slice(i + 1);
        if (!line) continue;
        let ev = null; try { ev = JSON.parse(line); } catch (_) { ev = null; }
        if (ev) handle(ev); else pushTail(p, line);
      }
    });
    child.stderr.on('data', (d) => { for (const line of d.toString('utf8').split(/\r?\n/)) if (line.trim()) pushTail(p, line); });
    child.on('error', (e) => {
      const r = e && e.code === 'ENOENT' ? fail('FRAMEPACK_PYTHON_MISSING', `FramePack's Python was not found (${f.python}).`, 'Start FramePack once from Stability Matrix (it makes its venv), or reinstall it there.', { engine: 'framepack' })
        : fail('FRAMEPACK_FAILED', `FramePack could not be started (${(e && (e.code || e.message)) || 'error'}).`, '', { engine: 'framepack' });
      gone(p, r);
    });
    child.on('exit', (code, signal) => gone(p, explainExit(p.tail, code, signal)));
    return p.ready;
  }
  function pushTail(p, line) { p.tail.push(String(line).slice(0, 2000)); if (p.tail.length > 80) p.tail.shift(); }
  function gone(p, r) {
    if (proc !== p) return;
    proc = null; loaded = false; loading = null;
    const wasStopping = !!p.stopping;
    log('framepack-exit', { code: r.code, stopping: wasStopping });
    if (p.onFail) p.onFail(r);
    const w = waiters.get('load'); if (w) { waiters.delete('load'); w(r); }
    for (const k of ['status', 'pong']) { const x = waiters.get(k); if (x) { waiters.delete(k); x(null); } }
    if (job) { const cancelled = job.cancelled; if (!cancelled && !wasStopping) lastError = { code: r.code, message: r.message, at: Date.now() }; finish(cancelled ? fail('FRAMEPACK_CANCELLED', 'Stopped.', '', { engine: 'framepack' }) : r); }
    onEvent({ type: 'exit', code: r.code });
  }

  function load() {
    if (loaded && proc) return Promise.resolve({ ok: true, loaded: true, already: true, vramGB, highVram });
    if (loadWait) return loadWait;
    loadWait = (async () => {
      const bad = await ensure();
      if (bad) { lastError = { code: bad.code, message: bad.message, at: Date.now() }; return bad; }
      if (loaded) return { ok: true, loaded: true, already: true, vramGB, highVram };
      loading = { stage: 'starting', step: 0, steps: 0, startedAt: Date.now() };
      const r = await new Promise((resolve) => { waiters.set('load', resolve); if (!send({ cmd: 'load', id: `load-${Date.now()}` })) { waiters.delete('load'); resolve(fail('FRAMEPACK_FAILED', 'FramePack is not running.', '')); } });
      log('framepack-load', { ok: !!(r && r.ok), code: r && r.code, vramGB });
      return r;
    })().finally(() => { loadWait = null; });
    return loadWait;
  }

  /** req: { image, prompt, negative, seconds, seed, steps, cfg, gs, rs, use_teacache, mp4_crf, gpu_memory_preservation, out, poster, id } */
  async function generate(req, onProgress, o = {}) {
    if (job) return fail('FRAMEPACK_BUSY', 'FramePack is already making a video.', 'Wait for it, or press ⏹ Stop.', { engine: 'framepack' });
    const id = String((req && req.id) || crypto.randomUUID());
    const j = { id, resolve: null, onProgress, cancelled: false, phase: 'starting' };
    job = j; // claimed before anything async: a second generate is BUSY
    const promise = new Promise((resolve) => { j.resolve = resolve; });
    (async () => {
      if (loadWait) { onProgress && onProgress({ phase: 'loading', stage: (loading && loading.stage) || '' }); await loadWait; }
      if (j.cancelled) return finish(fail('FRAMEPACK_CANCELLED', 'Stopped.', '', { engine: 'framepack' }));
      const bad = await ensure();
      if (bad) { lastError = { code: bad.code, message: bad.message, at: Date.now() }; return finish(bad); }
      if (j.cancelled) return finish(fail('FRAMEPACK_CANCELLED', 'Stopped.', '', { engine: 'framepack' }));
      if (!loaded) j.phase = 'loading';
      if (!send(Object.assign({}, req, { cmd: 'generate', id }))) finish(fail('FRAMEPACK_FAILED', 'FramePack is not running.', 'Try again.', { engine: 'framepack' }));
    })().catch((e) => finish(fail('FRAMEPACK_FAILED', `Something went wrong: ${(e && e.message) || e}`, '', { engine: 'framepack' })));
    let timer = null;
    if (o.timeoutMs) timer = setTimeout(() => { if (job === j) { cancel(); j.timedOut = true; } }, o.timeoutMs);
    const r = await promise;
    if (timer) clearTimeout(timer);
    if (j.timedOut && !r.ok) return fail('FRAMEPACK_TIMEOUT', 'FramePack did not finish in time.', 'Make a shorter clip, or raise the time limit (🎬 Video → Setup → Settings).', { engine: 'framepack' });
    log('framepack-generate', { ok: !!r.ok, code: r.code, seconds: r.seconds, frames: r.frames });
    return r;
  }

  function cancel() {
    const j = job;
    if (!j) return { ok: true, cancelled: false };
    j.cancelled = true;
    send({ cmd: 'cancel', id: j.id });
    // FramePack checks for Stop between sampling steps; if it doesn't answer, the process is stopped (it frees the card).
    j.killTimer = setTimeout(() => { if (job === j && proc) { log('framepack-kill', { reason: 'cancel not answered' }); kill(); } }, cancelKillMs);
    if (j.killTimer.unref) j.killTimer.unref();
    return { ok: true, cancelled: true };
  }
  function kill() { const p = proc; if (!p) return; p.stopping = true; try { p.child.kill(); } catch (_) {} }
  function stop() {
    const p = proc; if (!p) return { ok: true, stopped: false };
    if (p.stopping) return { ok: true, stopped: true };
    p.stopping = true;
    send({ cmd: 'quit' });
    try { p.child.stdin.end(); } catch (_) {}
    const t = setTimeout(() => { try { p.child.kill(); } catch (_) {} }, 3000); if (t.unref) t.unref();
    loaded = false;
    return { ok: true, stopped: true };
  }

  return { status, load, generate, cancel, stop, refresh, refreshGpu, find, busy: () => !!job || !!loadWait, isLoaded: () => loaded };
}

module.exports = { createFramePack, findFramePack, checkModels, isFramePackDir, venvPython, testPicture, notReady, explainExit, hasAnyModel, NEEDED, FPS, MIN_VRAM_GB, RUNNER };
