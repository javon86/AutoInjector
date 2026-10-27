'use strict';
/*
 * sd-installer.js — "⬇ Install Stable Diffusion" for people who have nothing yet.
 * Downloads the OFFICIAL ComfyUI portable build for Windows into AutoInjector's
 * own data folder (%LOCALAPPDATA%\AutoInjector\comfyui), then optionally one
 * starter checkpoint into its models\checkpoints. Pure Node, everything
 * injectable, so the tests use a fake HTTP server and a tiny fake archive.
 *
 * Steps (each one reports progress through onProgress):
 *   1. gpu()      — which build fits: nvidia-smi first, then WMI (PowerShell
 *                   Win32_VideoController). NVIDIA 20xx+ → nvidia build; GTX 10xx and
 *                   older → nvidia_cu126; AMD → amd build (works on recent Radeons,
 *                   slower); Intel Arc → intel build; nothing → it still runs on
 *                   the CPU, but a picture takes minutes — said plainly.
 *   2. space      — free disk space (fs.statfs) ≥ the need (archive + unpacked + a model).
 *   3. download   — resumable (.part + HTTP Range), cancellable, follows redirects,
 *                   SHA-256 + size checked against GitHub's release info when published.
 *                   A dropped / stalled connection or a 5xx is retried by itself (Range resume,
 *                   backoff, up to 8 tries in a row without progress ≈ 10 min); this download()
 *                   is shared with video-installer.js (the 🎬 Video models).
 *   4. extract    — 7-Zip if installed, else Windows' own tar.exe (bsdtar reads .7z on
 *                   recent Windows 10/11). Plain error + "install 7-Zip" if neither works;
 *                   the download is kept so Install continues where it stopped.
 *   5. model      — optional starter checkpoint (SD1.5 or SDXL, size shown first).
 * Never deletes user files: an existing install is reused, never overwritten; only
 * our own .part file of a failed download may be replaced.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const child_process = require('child_process');

const GITHUB_API = 'https://api.github.com/repos/comfyanonymous/ComfyUI/releases/latest';
const DOWNLOAD_BASE = 'https://github.com/comfyanonymous/ComfyUI/releases/latest/download/';
const BUILDS = {
  nvidia: { asset: 'ComfyUI_windows_portable_nvidia.7z', label: 'NVIDIA (GeForce RTX 20xx and newer)', approxBytes: 2.0e9 },
  nvidia_cu126: { asset: 'ComfyUI_windows_portable_nvidia_cu126.7z', label: 'NVIDIA (GeForce GTX 10xx and older)', approxBytes: 1.8e9 },
  amd: { asset: 'ComfyUI_windows_portable_amd.7z', label: 'AMD Radeon', approxBytes: 2.0e9 },
  intel: { asset: 'ComfyUI_windows_portable_intel.7z', label: 'Intel Arc', approxBytes: 1.5e9 },
};
const STARTER_MODELS = {
  sd15: { id: 'sd15', label: 'DreamShaper 8 (SD 1.5) — 2.1 GB, quick, works on 4–6 GB graphics cards', file: 'DreamShaper_8_pruned.safetensors', url: 'https://huggingface.co/Lykon/DreamShaper/resolve/main/DreamShaper_8_pruned.safetensors', approxBytes: 2.13e9, base: 'SD1.5' },
  sdxl: { id: 'sdxl', label: 'Stable Diffusion XL base 1.0 — 6.9 GB, better pictures, needs an 8 GB+ graphics card', file: 'sd_xl_base_1.0.safetensors', url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors', approxBytes: 6.94e9, base: 'SDXL' },
};
const GB = 1024 * 1024 * 1024;

function defaultHome(platform, env) {
  const e = env || process.env;
  if ((platform || process.platform) === 'win32') return path.win32.join(e.LOCALAPPDATA || path.win32.join(e.USERPROFILE || os.homedir(), 'AppData', 'Local'), 'AutoInjector', 'comfyui');
  return path.join(os.homedir(), '.local', 'share', 'AutoInjector', 'comfyui');
}

function fmtBytes(n) { if (!Number.isFinite(n)) return '?'; if (n >= GB) return `${(n / GB).toFixed(1)} GB`; return `${Math.round(n / (1024 * 1024))} MB`; }

// ------------------------------------------------------------------ GPU
function _run(cmd, args, timeoutMs, execFile) {
  return new Promise((resolve) => {
    try {
      (execFile || child_process.execFile)(cmd, args, { timeout: timeoutMs || 8000, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout || '')));
    } catch { resolve(null); }
  });
}
// → { vendor: nvidia|amd|intel|none, name, vramMB, build, message }
async function detectGpu(opts = {}) {
  const run = opts.run || ((c, a, t) => _run(c, a, t, opts.execFile));
  const smi = await run(process.env.NVIDIA_SMI || 'nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], 8000);
  let name = '', vram = null, vendor = 'none';
  if (smi && smi.trim()) {
    const [n, m] = smi.trim().split(/\r?\n/)[0].split(',').map((s) => s.trim());
    name = n; vram = Number(m) || null; vendor = 'nvidia';
  } else if ((opts.platform || process.platform) === 'win32') {
    const wmi = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name + "|" + $_.AdapterRAM }'], 12000);
    const lines = String(wmi || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const pick = lines.find((l) => /nvidia|geforce|rtx|quadro/i.test(l)) || lines.find((l) => /radeon|amd/i.test(l)) || lines.find((l) => /arc/i.test(l) && /intel/i.test(l)) || '';
    if (pick) { const [n, ram] = pick.split('|'); name = n; vram = Number(ram) ? Math.round(Number(ram) / 1048576) : null; vendor = /nvidia|geforce|rtx|quadro/i.test(n) ? 'nvidia' : /radeon|amd/i.test(n) ? 'amd' : 'intel'; }
  }
  return Object.assign({ vendor, name, vramMB: vram }, chooseBuild(vendor, name, vram));
}
function chooseBuild(vendor, name, vramMB) {
  const vram = vramMB ? ` (${Math.round(vramMB / 1024)} GB)` : '';
  if (vendor === 'nvidia') {
    const old = /GTX\s*(9\d\d|10\d\d|16\d\d)|\bTITAN X\b|Quadro P/i.test(name || '') && !/RTX/i.test(name || '');
    // GTX 16xx is Turing (works with the main build); 9xx/10xx need cu126.
    const build = old && !/GTX\s*16\d\d/i.test(name) ? 'nvidia_cu126' : 'nvidia';
    const low = vramMB && vramMB < 6000 ? ' Your card has little memory: start with the SD 1.5 model and 512×512 pictures.' : '';
    return { build, ok: true, message: `${name || 'NVIDIA graphics card'}${vram} found — AutoInjector will install ComfyUI's ${BUILDS[build].label} build.${low}` };
  }
  if (vendor === 'amd') return { build: 'amd', ok: true, caution: true, message: `${name}${vram} found. ComfyUI has an AMD build for Windows; it works on recent Radeon cards but is slower and less tested than NVIDIA. If it fails, ComfyUI can still run on the CPU (very slow).` };
  if (vendor === 'intel') return { build: 'intel', ok: true, caution: true, message: `${name} found. ComfyUI has an Intel Arc build; it is newer and slower than NVIDIA.` };
  return { build: 'nvidia', ok: false, cpuOnly: true, message: 'No NVIDIA, AMD or Intel Arc graphics card was found. Stable Diffusion can still run on the processor (CPU), but one picture takes several minutes. You can install it anyway (it will start in CPU mode), or use a PC with an NVIDIA card.' };
}

// ------------------------------------------------------------------ disk space
function freeBytes(dir) {
  try {
    let d = dir;
    while (d && !fs.existsSync(d)) { const up = path.dirname(d); if (up === d) break; d = up; }
    const s = fs.statfsSync(d);
    return Number(s.bavail) * Number(s.bsize);
  } catch { return null; }
}

// ------------------------------------------------------------------ HTTP download
// Retries: a long download (a 10 GB model over an hour) meets network hiccups. A dropped connection,
// a timeout, a stall (no bytes for stallMs), a cut-short body or a 5xx/429 answer is retried by
// itself with an HTTP Range resume from the bytes already in the .part file, with a growing pause.
// The try counter starts over whenever bytes arrive, so only a connection that stays down for good
// (8 tries ≈ 10 minutes) gives up — with a plain message; the .part is kept and the next
// Download / Resume continues from it.
const RETRY_DELAYS_MS = [5000, 10000, 20000, 40000, 80000, 120000, 180000]; // between tries 1→2 … 7→8 (≈ 7.5 min + the tries)
const MAX_TRIES = 8;
const STALL_MS = 60000;
const RETRYABLE = new Set(['ECONNRESET', 'ETIMEDOUT', 'TIMEOUT', 'ESOCKETTIMEDOUT', 'ABORTED', 'STALLED', 'EPIPE', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'ECONNABORTED', 'ERR_STREAM_PREMATURE_CLOSE', 'CUT_SHORT', 'NETWORK', 'HTTP_408', 'HTTP_425', 'HTTP_429']);
function isRetryable(code) { return RETRYABLE.has(code) || /^HTTP_5\d\d$/.test(String(code || '')); }
function _errCode(e) {
  if (!e) return 'NETWORK';
  if (e.code) return e.code;
  if (/socket hang up|aborted/i.test(String(e.message || ''))) return 'ECONNRESET';
  return 'NETWORK';
}
function _get(url, headers, deps, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch { return reject(Object.assign(new Error('BAD_URL'), { code: 'BAD_URL' })); }
    const lib = u.protocol === 'http:' ? (deps.http || http) : (deps.https || https);
    const req = lib.get({ hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers: Object.assign({ 'User-Agent': 'AutoInjector' }, headers || {}), agent: false }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects > 8) return reject(Object.assign(new Error('TOO_MANY_REDIRECTS'), { code: 'TOO_MANY_REDIRECTS' }));
        return resolve(_get(new URL(res.headers.location, url).toString(), headers, deps, redirects + 1));
      }
      resolve({ res, req, url });
    });
    req.on('error', reject);
    req.setTimeout(deps.socketTimeoutMs || 60000, () => req.destroy(Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' })));
  });
}
async function _json(url, deps) {
  try {
    const { res } = await _get(url, { Accept: 'application/vnd.github+json' }, deps);
    if (res.statusCode !== 200) { res.resume(); return null; }
    const chunks = []; for await (const c of res) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { return null; }
}
async function _hashFile(file) {
  const h = crypto.createHash('sha256');
  await new Promise((resolve, reject) => { fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', resolve).on('error', reject); });
  return h;
}

// One try: url → dest.part (resuming from what is already there), renamed to dest when complete.
// → { ok, file, bytes, sha256, resumed } | { ok:false, error, retryable, message, partial }
async function _downloadOnce(url, dest, opts) {
  const deps = opts.deps || {};
  const onProgress = opts.onProgress || (() => {});
  const job = opts.job;
  const again = opts.againText || 'Press Install again';
  const part = `${dest}.part`;
  const paused = () => ({ ok: false, error: 'CANCELLED', message: `Download paused. ${again} to continue where it stopped.`, partial: part });
  let have = 0; try { have = fs.statSync(part).size; } catch {}
  if (opts.expectedSize && have > opts.expectedSize) { fs.unlinkSync(part); have = 0; } // our own broken partial
  const hash = opts.expectedSha256 && have ? await _hashFile(part) : (opts.expectedSha256 ? crypto.createHash('sha256') : null);
  let got;
  try { got = await _get(url, have ? { Range: `bytes=${have}-` } : {}, deps); }
  catch (e) { const code = _errCode(e); return { ok: false, error: code, retryable: isRetryable(code), message: `The download could not start (${code}). Check the internet connection and ${again.toLowerCase()} — it continues where it stopped.`, partial: have ? part : undefined }; }
  const { res, req } = got;
  job.cancel = () => { job.cancelled = true; try { req.destroy(); } catch {} };
  if (job.cancelled) { try { req.destroy(); } catch {} return paused(); }
  if (res.statusCode === 416 && opts.expectedSize && have === opts.expectedSize) { res.resume(); }
  else if (res.statusCode === 200 && have) { have = 0; if (hash) hash.__reset = true; }
  else if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); const code = `HTTP_${res.statusCode}`; return { ok: false, error: code, retryable: isRetryable(code), message: `The download server said ${res.statusCode}. Try again later.`, partial: have ? part : undefined }; }
  const total = res.statusCode === 206 ? have + Number(res.headers['content-length'] || 0) : Number(res.headers['content-length'] || opts.expectedSize || 0);
  const resumed = res.statusCode === 206 && have > 0;
  const h = hash && hash.__reset ? crypto.createHash('sha256') : hash;
  if (res.statusCode !== 416) {
    const out = fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' });
    let done = have, last = 0, stall = null, stalled = false;
    const stallMs = opts.stallMs || STALL_MS;
    const kick = () => { clearTimeout(stall); stall = setTimeout(() => { stalled = true; try { req.destroy(Object.assign(new Error('STALLED'), { code: 'STALLED' })); } catch {} }, stallMs); };
    try {
      await new Promise((resolve, reject) => {
        kick();
        res.on('data', (c) => {
          kick();
          if (h) h.update(c);
          done += c.length;
          if (!out.write(c)) { res.pause(); out.once('drain', () => res.resume()); }
          const t = Date.now(); if (t - last > 250) { last = t; onProgress({ step: 'download', done, total, pct: total ? done / total : 0 }); }
        });
        res.on('end', resolve);
        res.on('error', reject);
        res.on('aborted', () => reject(Object.assign(new Error('ABORTED'), { code: 'ABORTED' })));
        res.on('close', () => { if (!res.complete) reject(Object.assign(new Error('ABORTED'), { code: 'ABORTED' })); });
        req.on('error', reject);
        out.on('error', reject);
      });
    } catch (e) {
      clearTimeout(stall);
      await new Promise((r) => { if (out.destroyed || out.closed) r(); else out.end(r); });
      if (job.cancelled) return paused();
      const code = stalled ? 'STALLED' : _errCode(e);
      if (['ENOSPC', 'EACCES', 'EPERM', 'EROFS'].includes(code)) return { ok: false, error: code, retryable: false, message: code === 'ENOSPC' ? 'The disk is full — the download could not be saved. Free some space, then continue (nothing already downloaded is lost).' : `The download could not be saved (${code}: no permission to write ${dest}).`, partial: part };
      return { ok: false, error: code, retryable: isRetryable(code), message: `The download was interrupted (${code === 'STALLED' ? 'no data arrived for a while' : code}). ${again} — it continues where it stopped.`, partial: part };
    }
    clearTimeout(stall);
    await new Promise((r) => out.end(r));
    if (job.cancelled) return paused();
    onProgress({ step: 'download', done, total, pct: 1 });
  }
  const size = fs.statSync(part).size;
  if (opts.expectedSize && size !== opts.expectedSize) {
    // Fewer bytes than the server announced = the connection was cut short (worth another try);
    // a server whose file has another size is not fixed by trying again.
    const cut = size < opts.expectedSize && (!total || total === opts.expectedSize);
    return { ok: false, error: 'SIZE_MISMATCH', retryable: cut, message: `The download is incomplete (${fmtBytes(size)} of ${fmtBytes(opts.expectedSize)}). ${again} to continue.`, partial: part };
  }
  const sha = h ? h.digest('hex') : null;
  if (opts.expectedSha256 && sha && sha.toLowerCase() !== String(opts.expectedSha256).toLowerCase()) {
    fs.renameSync(part, `${dest}.bad`);
    return { ok: false, error: 'HASH_MISMATCH', message: `The downloaded file is damaged (its checksum does not match the published one). It was set aside as .bad — ${again.toLowerCase()} to download it again.` };
  }
  fs.renameSync(part, dest);
  return { ok: true, file: dest, bytes: size, sha256: sha, resumed };
}

// A pause between tries that Cancel ends at once.
function _pause(ms, job) {
  return new Promise((resolve) => {
    let t = null;
    const done = () => { clearTimeout(t); resolve(); };
    t = setTimeout(done, ms);
    job.cancel = () => { job.cancelled = true; done(); };
  });
}

// Download url → dest with resume and automatic retries. job: { cancelled, cancel() } set by the caller.
// opts: expectedSize, expectedSha256, onProgress({done,total,pct}), onRetry({attempt,max,error,delayMs,done,total}),
//       maxTries (8), retryDelaysMs, stallMs (60 s), againText ('Press Install again'), deps.
// → { ok, file, bytes, sha256, resumed, tries } | { ok:false, error, message, partial, partialBytes, canResume, gaveUp }
async function download(url, dest, opts = {}) {
  const job = opts.job || {};
  const part = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    const sz = fs.statSync(dest).size;
    if (!opts.expectedSize || sz === opts.expectedSize) return { ok: true, file: dest, bytes: sz, already: true };
    return { ok: false, error: 'EXISTS', message: `A different file is already at ${dest}. AutoInjector won't overwrite it — move or rename it, then try again.` };
  }
  const maxTries = Math.max(1, opts.maxTries || MAX_TRIES);
  const delays = Array.isArray(opts.retryDelaysMs) && opts.retryDelaysMs.length ? opts.retryDelaysMs : RETRY_DELAYS_MS;
  const partSize = () => { try { return fs.statSync(part).size; } catch { return 0; } };
  const finish = (r, tries) => { const o = Object.assign({}, r, { tries }); delete o.retryable; const pb = r.ok ? 0 : partSize(); if (!r.ok && pb > 0) { o.partial = part; o.partialBytes = pb; o.canResume = true; } return o; };
  let fails = 0, tries = 0;
  for (;;) {
    const before = partSize();
    tries++;
    const r = await _downloadOnce(url, dest, Object.assign({}, opts, { job }));
    if (r.ok || job.cancelled || r.error === 'CANCELLED' || !r.retryable) return finish(job.cancelled && !r.ok ? Object.assign({}, r, { error: 'CANCELLED', message: `Download paused. ${opts.againText || 'Press Install again'} to continue where it stopped.` }) : r, tries);
    const after = partSize();
    if (after > before) fails = 0; // bytes arrived: the connection works, the count starts over
    fails++;
    if (fails >= maxTries && maxTries === 1) return finish(r, tries); // retries turned off: the try's own message
    if (fails >= maxTries) {
      const total = opts.expectedSize || null;
      const again = opts.resumeText || opts.againText || 'Press Install again';
      return finish(Object.assign({}, r, { gaveUp: true, message: `The internet connection kept dropping (${r.error}) and did not come back after ${maxTries} tries, so the download stopped at ${fmtBytes(after)}${total ? ` of ${fmtBytes(total)}` : ''}. Nothing is lost: ${again.charAt(0).toLowerCase()}${again.slice(1)} — it continues from there, not from the start.` }), tries);
    }
    const delayMs = delays[Math.min(fails - 1, delays.length - 1)];
    try { if (opts.onRetry) opts.onRetry({ attempt: fails + 1, max: maxTries, error: r.error, delayMs, done: after, total: opts.expectedSize || null }); } catch {}
    await _pause(delayMs, job);
    if (job.cancelled) return finish({ ok: false, error: 'CANCELLED', message: `Download paused. ${opts.againText || 'Press Install again'} to continue where it stopped.` }, tries);
  }
}

// ------------------------------------------------------------------ extract
function find7z(env, exists) {
  const e = env || process.env; const ex = exists || fs.existsSync;
  const c = [e.SEVENZIP, e.ProgramFiles && path.join(e.ProgramFiles, '7-Zip', '7z.exe'), e['ProgramFiles(x86)'] && path.join(e['ProgramFiles(x86)'], '7-Zip', '7z.exe'), 'C:\\Program Files\\7-Zip\\7z.exe'].filter(Boolean);
  return c.find((p) => { try { return ex(p); } catch { return false; } }) || null;
}
function _spawnWait(cmd, args, opts) {
  return new Promise((resolve) => {
    let out = '';
    let c;
    try { c = (opts.spawn || child_process.spawn)(cmd, args, { cwd: opts.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ ok: false, code: null, out: String(e.code || e.message) }); }
    const add = (b) => { out = (out + b.toString('utf8')).slice(-4000); };
    if (c.stdout) c.stdout.on('data', add); if (c.stderr) c.stderr.on('data', add);
    c.on('error', (e) => resolve({ ok: false, code: null, out: String(e.code || e.message) }));
    c.on('close', (code) => resolve({ ok: code === 0, code, out }));
  });
}
async function extract(archive, destDir, opts = {}) {
  fs.mkdirSync(destDir, { recursive: true });
  const tries = [];
  const sz = opts.sevenZip !== undefined ? opts.sevenZip : find7z(opts.env);
  if (sz) tries.push([sz, ['x', '-y', `-o${destDir}`, archive], '7-Zip']);
  tries.push([opts.tar || (process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'), ['-xf', archive, '-C', destDir], 'tar']);
  const errs = [];
  for (const [cmd, args, name] of tries) {
    if (opts.onProgress) opts.onProgress({ step: 'extract', tool: name });
    const r = await _spawnWait(cmd, args, opts);
    if (r.ok) return { ok: true, tool: name };
    errs.push(`${name}: ${String(r.out || r.code).trim().split(/\r?\n/).slice(-2).join(' ')}`.slice(0, 300));
  }
  return { ok: false, error: 'EXTRACT_FAILED', detail: errs.join(' | '), message: 'The download is complete, but Windows could not unpack the .7z file. Install 7-Zip (free, from 7-zip.org), then press Install again — the download is kept, nothing is downloaded twice.' };
}

// Find the unpacked portable folder (…/ComfyUI_windows_portable with python_embeded + ComfyUI/main.py).
function findPortable(home) {
  const cands = [home, path.join(home, 'ComfyUI_windows_portable')];
  try { for (const e of fs.readdirSync(home, { withFileTypes: true })) if (e.isDirectory()) cands.push(path.join(home, e.name)); } catch {}
  for (const d of cands) {
    if (fs.existsSync(path.join(d, 'ComfyUI', 'main.py'))) {
      const py = ['python_embeded', 'python_embedded'].map((p) => path.join(d, p, process.platform === 'win32' || fs.existsSync(path.join(d, p, 'python.exe')) ? 'python.exe' : 'python')).find((p) => fs.existsSync(p)) || null;
      return { root: d, comfy: path.join(d, 'ComfyUI'), python: py, models: path.join(d, 'ComfyUI', 'models') };
    }
  }
  return null;
}

// ------------------------------------------------------------------ the installer
function createInstaller(opts = {}) {
  const home = opts.home || defaultHome(opts.platform, opts.env);
  const deps = opts.deps || {};
  const log = opts.log || (() => {});
  const platform = opts.platform || process.platform;
  const urls = Object.assign({ githubApi: GITHUB_API, downloadBase: DOWNLOAD_BASE }, opts.urls || {});
  const models = Object.assign({}, STARTER_MODELS, opts.models || {});
  const retry = opts.retry || {}; // { maxTries, retryDelaysMs, stallMs } — the tests make these short
  let st = { phase: 'idle', step: null, pct: 0, done: 0, total: 0, message: '', error: null };
  let job = null;
  const onChange = opts.onChange || (() => {});
  function set(p) { st = Object.assign({}, st, p); try { onChange(status()); } catch {} }
  function status() { return Object.assign({ home, installed: !!findPortable(home), busy: !!job }, st); }

  async function check() {
    const gpu = await detectGpu({ run: opts.run, platform });
    const archiveBytes = BUILDS[gpu.build].approxBytes;
    const need = archiveBytes * 3.5 + 2.2 * GB; // archive + unpacked (~2.5×) + a small model
    const free = freeBytes(home);
    const portable = findPortable(home);
    return {
      ok: true, platform, supported: platform === 'win32' || !!opts.allowAnyPlatform, gpu, home, installed: !!portable, portable,
      freeBytes: free, needBytes: need, enoughSpace: free == null ? null : free >= need,
      spaceMessage: free == null ? 'Could not check the free disk space.' : `Needs about ${fmtBytes(need)} free (about 4 GB for ComfyUI plus 2–7 GB per model); this drive has ${fmtBytes(free)} free.`,
      models: Object.values(models).map((m) => ({ id: m.id, label: m.label, file: m.file, approxBytes: m.approxBytes, base: m.base })),
    };
  }

  async function install(o = {}) {
    if (job) return { ok: false, error: 'BUSY', code: 'BUSY', alreadyRunning: true, message: 'Already installing — this press was ignored. Wait for it, or press Cancel.' };
    // Claimed before the first await, so a second press while the GPU / space check runs is refused too.
    const checking = { cancelled: false }; job = checking;
    let c;
    try { c = await check(); } finally { if (job === checking) job = null; }
    if (checking.cancelled) return { ok: false, error: 'CANCELLED', message: 'Install cancelled.' };
    if (!c.supported) return { ok: false, error: 'NOT_WINDOWS', message: 'The one-click install is for Windows. On this computer install ComfyUI or Forge yourself (see docs/STABLE_DIFFUSION_SETUP.md); AutoInjector will find and drive it.' };
    if (c.installed) { set({ phase: 'installed', message: 'ComfyUI is already installed.' }); return { ok: true, already: true, portable: c.portable }; }
    if (c.enoughSpace === false && !o.ignoreSpace) return { ok: false, error: 'NO_SPACE', message: `Not enough free disk space. ${c.spaceMessage}` };
    const build = o.build && BUILDS[o.build] ? o.build : c.gpu.build;
    const asset = BUILDS[build].asset;
    job = { cancelled: false };
    const myJob = job;
    try {
      set({ phase: 'downloading', step: 'download', pct: 0, error: null, retry: null, message: `Downloading ComfyUI (${BUILDS[build].label})…` });
      log('sd-install-start', { build, home });
      // Size + SHA-256 from GitHub when it publishes them (never fatal if not).
      let expectedSize = null, expectedSha256 = null;
      const rel = await _json(urls.githubApi, deps);
      const a = rel && Array.isArray(rel.assets) ? rel.assets.find((x) => x.name === asset) : null;
      if (a) { expectedSize = Number(a.size) || null; const m = String(a.digest || '').match(/^sha256:([0-9a-f]{64})$/i); if (m) expectedSha256 = m[1]; }
      const archive = path.join(home, asset);
      const d = await download(a && a.browser_download_url ? a.browser_download_url : urls.downloadBase + asset, archive, {
        deps, job: myJob, expectedSize, expectedSha256, maxTries: retry.maxTries, retryDelaysMs: retry.retryDelaysMs, stallMs: retry.stallMs,
        onProgress: (p) => set({ step: 'download', pct: p.pct, done: p.done, total: p.total, retry: null, message: `Downloading ComfyUI… ${fmtBytes(p.done)}${p.total ? ` of ${fmtBytes(p.total)}` : ''}` }),
        onRetry: (r) => { set({ retry: { attempt: r.attempt, max: r.max }, message: `Connection dropped — resuming (try ${r.attempt} of ${r.max})…` }); log('sd-install-download-retry', { error: r.error, attempt: r.attempt, max: r.max }); },
      });
      if (!d.ok) { set({ phase: d.error === 'CANCELLED' ? 'paused' : 'failed', error: d.error, message: d.message }); log('sd-install-download-failed', { error: d.error }); return d; }
      set({ phase: 'extracting', step: 'extract', pct: 0, message: 'Unpacking ComfyUI… (a few minutes)' });
      const x = await extract(archive, home, { spawn: deps.spawn, sevenZip: opts.sevenZip, tar: opts.tar, env: opts.env });
      if (!x.ok) { set({ phase: 'failed', error: x.error, message: x.message }); log('sd-install-extract-failed', { detail: x.detail }); return x; }
      const portable = findPortable(home);
      if (!portable) { const r = { ok: false, error: 'NOT_FOUND_AFTER_EXTRACT', message: 'ComfyUI was unpacked, but its main.py was not found where expected. Open the folder and check, or press Install again.' }; set({ phase: 'failed', error: r.error, message: r.message }); return r; }
      // The archive is our own download; it is safe to remove now that it is unpacked.
      try { fs.unlinkSync(archive); } catch {}
      log('sd-install-done', { tool: x.tool, sha256: d.sha256 ? 'checked' : 'not published' });
      set({ phase: 'installed', step: null, pct: 1, message: `✔ ComfyUI is installed in ${portable.root}.`, verified: !!d.sha256 });
      return { ok: true, portable, verified: !!d.sha256, build, cpuOnly: !!c.gpu.cpuOnly };
    } finally { if (job === myJob) job = null; }
  }

  async function downloadModel(id) {
    const m = models[id];
    if (!m) return { ok: false, error: 'BAD_MODEL', message: 'Unknown starter model.' };
    const portable = findPortable(home);
    if (!portable) return { ok: false, error: 'NOT_INSTALLED', message: 'Install ComfyUI first.' };
    if (job) return { ok: false, error: 'BUSY', code: 'BUSY', alreadyRunning: true, message: 'Already downloading — this press was ignored. Wait for it, or press Cancel.' };
    const free = freeBytes(portable.models);
    if (free != null && free < m.approxBytes * 1.05) return { ok: false, error: 'NO_SPACE', message: `Not enough free disk space for ${m.file} (${fmtBytes(m.approxBytes)}); this drive has ${fmtBytes(free)} free.` };
    job = { cancelled: false }; const myJob = job;
    try {
      set({ phase: 'downloading-model', step: 'model', pct: 0, error: null, retry: null, message: `Downloading ${m.file}…` });
      const d = await download(m.url, path.join(portable.models, 'checkpoints', m.file), {
        deps, job: myJob, expectedSize: m.expectedSize || null, expectedSha256: m.sha256 || null, maxTries: retry.maxTries, retryDelaysMs: retry.retryDelaysMs, stallMs: retry.stallMs,
        onProgress: (p) => set({ step: 'model', pct: p.pct, done: p.done, total: p.total, retry: null, message: `Downloading ${m.file}… ${fmtBytes(p.done)}${p.total ? ` of ${fmtBytes(p.total)}` : ''}` }),
        onRetry: (r) => { set({ retry: { attempt: r.attempt, max: r.max }, message: `Connection dropped — resuming (try ${r.attempt} of ${r.max})…` }); log('sd-model-download-retry', { model: m.id, error: r.error, attempt: r.attempt, max: r.max }); },
        againText: 'Press Download again',
      });
      if (!d.ok) { set({ phase: d.error === 'CANCELLED' ? 'paused' : 'failed', error: d.error, message: d.message }); return d; }
      set({ phase: 'installed', step: null, pct: 1, message: `✔ ${m.file} is ready in ComfyUI's models\\checkpoints.` });
      log('sd-model-downloaded', { model: m.id });
      return { ok: true, file: d.file, model: m.id, base: m.base };
    } finally { if (job === myJob) job = null; }
  }

  function cancel() { if (job && job.cancel) job.cancel(); else if (job) job.cancelled = true; return { ok: true }; }
  return { status, check, install, downloadModel, cancel, home, portable: () => findPortable(home) };
}

module.exports = { createInstaller, detectGpu, chooseBuild, download, isRetryable, RETRY_DELAYS_MS, MAX_TRIES, STALL_MS, extract, find7z, findPortable, freeBytes, defaultHome, fmtBytes, BUILDS, STARTER_MODELS, GITHUB_API, DOWNLOAD_BASE };
