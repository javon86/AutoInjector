'use strict';
/*
 * media-selftest.js — the one-press "🩺 Test pictures & video" self-test. Electron-free (every outside thing is
 * injected), so it is unit-tested with fakes. One run checks pictures (Forge), video (FramePack), the trailer
 * join, 🎩 Alfred's link to them and Akọwe's image routes, and writes ONE report — so one session on the real PC
 * gives all the answers.
 *
 *   const t = createMediaSelfTest(deps);
 *   const report = await t.run({ mode: 'quick' | 'full', chatgptPicture: false, unload: true });
 *   t.cancel();  t.status();  t.last();
 *
 * Every step: ✅ pass / ⚠️ warn / ❌ fail / ⏭ skip, the time it took, the exact error and "what to try" in plain
 * words. A failing step never stops the run (the next steps go on; a step that needs an earlier result is
 * skipped with the reason). Each step has its own time limit (it can never hang), and ⏹ Stop ends the step that
 * is running at once (its own cancel is called too: Stable Diffusion's interrupt, the video's stop, the
 * recorder's abort) and skips the rest. Nothing is ever downloaded.
 *
 * Quick (~10 s): reachability and setup only, nothing is rendered. Full: also ONE tiny picture (512×512, 6 steps),
 * FramePack load (stage times, attention kernel), ONE tiny clip (1 s, 6 steps) from a built-in test picture, the
 * clip really plays (a hidden <video>), graphics-memory peak, a tiny trailer (title card + that clip, nothing new
 * rendered) that plays, Alfred's model answers, ⏹ Stop works mid-clip, and FramePack is unloaded afterwards.
 *
 * deps (each optional — a missing one makes its steps "skip: not part of this build"):
 *   sd: { status(), lists(), modelCheck(), generate(req), cancel(), locks(), chatgptStatus(), chatgptPicture(req) }
 *   imagesDir()
 *   video: { status(), fpStatus(), fpLoad(), fpUnload(), animate(req), cancel() }
 *   testPicture() → Buffer (PNG)   tmpDir() → folder for the test picture
 *   probeMedia(path) → { ok, duration, width, height, error }
 *   gpu: { read() → { available, gpus: [{ name, memUsed, memTotal }] } }
 *   trailer: { record(timeline, outPath) → { done: Promise<{ok,…}>, abort() }, dir(), ffmpeg() → bin | null,
 *              runFfmpeg(bin, args, ms) → { ok, detail }, mp4Args(webm, mp4), fileUrl(p) }
 *   alfred: { testAi(), check() → llm:check rows, toolsDry() → { picture: {ok,error}, video: {ok,error} } }
 *   bridge: { info() → { port, token } | null, http(method, path, body) → { status, json } }
 *   processAlive(pid) → bool
 *   saveReport(stamp, md, jsonText) → { md, json } (paths)    redact(text) → text
 *   log(kind, data), onProgress(state), now(), sleep(ms), fileExists(p), fileSize(p), timeouts: { [stepId]: ms }
 */

const STATUS_ICON = { pass: '✅', warn: '⚠️', fail: '❌', skip: '⏭' };
const GROUPS = { pictures: '🎨 Pictures', video: '🎬 Video (FramePack)', trailer: '🎞 Trailer', alfred: '🎩 Alfred', akowe: '📖 Akọwe link', cleanup: '🧹 Cleanup' };
// Per-step time limits (ms). Loading FramePack the first time on Windows is slow (antivirus scans PyTorch), so its
// limit is long — but it is still a limit: the run never hangs.
const TIMEOUTS = {
  forge: 15000, checkpoints: 15000, picture: 240000, loras: 15000, locks: 10000, chatgpt: 10000, 'chatgpt-picture': 300000,
  'fp-found': 15000, 'fp-python': 15000, 'fp-load': 20 * 60000, attention: 5000, clip: 20 * 60000, playable: 30000, 'gpu-peak': 5000,
  trailer: 120000, 'trailer-plays': 40000,
  'alfred-ai': 120000, 'alfred-tools': 15000,
  bridge: 8000, 'image-routes': 12000,
  'stop-works': 120000, unload: 30000,
};
const TEST_PROMPT = 'a red apple on a white table, simple test picture';
const CLIP_PROMPT = 'the clouds drift slowly, the water ripples, gentle camera push';

function stampOf(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function secs(ms) { return Math.round(ms / 100) / 10; }
function dur(s) { const n = Math.round(s); return n < 60 ? `${n} s` : `${Math.floor(n / 60)} min ${n % 60} s`; }
function gb(mb) { return mb == null ? '?' : `${(mb / 1024).toFixed(1)} GB`; }
function errText(e) { return String((e && (e.message || e.error)) || e || 'unknown error').slice(0, 600); }
function msgOf(r, dflt) { return String((r && (r.message || r.error || r.code)) || dflt || 'it did not work').slice(0, 600); }
function codeOf(r) { return r && (r.code || r.error) ? String(r.code || r.error).slice(0, 60) : ''; }

function createMediaSelfTest(deps = {}) {
  const d = Object.assign({
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: () => {},
    onProgress: () => {},
    redact: (t) => t,
    fileExists: (p) => { try { return require('fs').statSync(p).isFile(); } catch (_) { return false; } },
    fileSize: (p) => { try { return require('fs').statSync(p).size; } catch (_) { return 0; } },
    processAlive: (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } },
  }, deps);
  const limits = Object.assign({}, TIMEOUTS, d.timeouts || {});
  let running = null; // the run in progress: { mode, steps, current, cancelled, stopAt, cancelHook, … }
  let lastReport = null;

  function publicState() {
    const r = running;
    if (!r) return { running: false, last: lastReport ? summaryOf(lastReport) : null };
    return { running: true, mode: r.mode, startedAt: r.startedAt, index: r.steps.length, total: r.plan.length, stopping: !!r.cancelled,
      current: r.current ? { id: r.current.id, group: r.current.group, name: r.current.name, seconds: Math.round((d.now() - r.current.t0) / 1000), note: r.current.note || '' } : null,
      steps: r.steps.map(stepPublic) };
  }
  function stepPublic(s) { return { id: s.id, group: s.group, name: s.name, status: s.status, icon: STATUS_ICON[s.status], seconds: s.seconds, detail: s.detail, error: s.error || '', fix: s.fix || '' }; }
  function emit() { try { d.onProgress(publicState()); } catch (_) {} }

  // ---- the plan: every step, in order. needs: the steps whose result it uses (skipped when one of them didn't pass).
  function plan(mode, o) {
    const full = mode === 'full';
    const P = [];
    const S = (id, group, name, fn, x) => P.push(Object.assign({ id, group, name, fn }, x || {}));
    S('forge', 'pictures', 'Forge (Stable Diffusion) is reachable', stepForge);
    S('checkpoints', 'pictures', 'Picture models (checkpoints) are listed', stepCheckpoints, { needs: ['forge'] });
    if (full) S('picture', 'pictures', 'One tiny picture (512×512, 6 steps) is made and saved with its settings', stepPicture, { needs: ['checkpoints'] });
    S('loras', 'pictures', 'LoRA list is readable', stepLoras, { needs: ['forge'] });
    S('locks', 'pictures', 'Character-lock list is readable', stepLocks);
    S('chatgpt', 'pictures', 'ChatGPT picture engine (its pane) is ready', stepChatgpt);
    if (full && o.chatgptPicture) S('chatgpt-picture', 'pictures', 'One picture with ChatGPT (you ticked it)', stepChatgptPicture, { needs: ['chatgpt'] });
    S('fp-found', 'video', 'FramePack is found', stepFpFound);
    S('fp-python', 'video', 'FramePack\'s Python, PyTorch and model files', stepFpPython, { needs: ['fp-found'] });
    if (full) S('fp-load', 'video', 'FramePack loads (with the time of each stage)', stepFpLoad, { needs: ['fp-python'] });
    S('attention', 'video', 'Which attention kernel FramePack uses', stepAttention, { needs: full ? ['fp-load'] : ['fp-found'] });
    if (full) {
      S('clip', 'video', 'One tiny clip (1 s, 6 steps) from the built-in test picture: file, settings and poster saved', stepClip, { needs: ['fp-load'], warnOk: true });
      S('playable', 'video', 'The clip really plays (loaded in a hidden video player)', stepPlayable, { needs: ['clip'] });
      S('gpu-peak', 'video', 'Graphics memory peak while loading and making the clip', stepGpuPeak);
      S('trailer', 'trailer', 'A tiny trailer (title card + that clip, nothing new rendered)', stepTrailer, { needs: ['clip'] });
      S('trailer-plays', 'trailer', 'The trailer .webm (and .mp4 when ffmpeg is here) plays', stepTrailerPlays, { needs: ['trailer'] });
    }
    S('alfred-ai', 'alfred', full ? 'Alfred\'s AI answers one short question' : 'Alfred\'s AI is reachable', stepAlfredAi);
    S('alfred-tools', 'alfred', 'Alfred\'s picture and video tools are reachable (checked, nothing rendered)', stepAlfredTools);
    S('bridge', 'akowe', 'The bridge Akọwe uses is reachable', stepBridge);
    S('image-routes', 'akowe', 'Akọwe\'s picture routes answer (POST /image/request, POST /image/locks — a check-only call)', stepImageRoutes, { needs: ['bridge'] });
    if (full) {
      S('stop-works', 'cleanup', '⏹ Stop works in the middle of a clip', stepStopWorks, { needs: ['clip'] });
      if (o.unload !== false) S('unload', 'cleanup', 'FramePack is unloaded: no Python left running, graphics memory freed', stepUnload, { needs: ['fp-found'] });
    }
    return P;
  }

  // ---- shared bits
  const ctx = {}; // results the later steps use
  const has = (o, k) => !!(o && typeof o[k] === 'function');
  const notWired = (what) => ({ status: 'skip', detail: `${what} is not part of this build.` });
  // Watch the graphics memory while something heavy runs.
  function gpuWatch() {
    if (!has(d.gpu, 'read')) return { stop: async () => null };
    let stop = false; let peak = null; let total = null; let name = ''; let first = null;
    const loop = (async () => {
      while (!stop) {
        try {
          const g = await d.gpu.read();
          const x = g && g.available && g.gpus && g.gpus[0];
          if (x && x.memUsed != null) { if (first == null) first = x.memUsed; if (peak == null || x.memUsed > peak) peak = x.memUsed; total = x.memTotal; name = x.name || name; }
        } catch (_) {}
        for (let i = 0; i < 10 && !stop; i++) await d.sleep(200);
      }
    })();
    return { stop: async () => { stop = true; await loop.catch(() => {}); return peak == null ? null : { peakMB: peak, totalMB: total, startMB: first, name }; } };
  }
  function addPeak(p) {
    if (!p) return;
    const c = ctx.gpu || (ctx.gpu = { peakMB: null, totalMB: null, startMB: null, name: '' });
    if (c.startMB == null) c.startMB = p.startMB;
    if (c.peakMB == null || p.peakMB > c.peakMB) c.peakMB = p.peakMB;
    c.totalMB = p.totalMB || c.totalMB; c.name = p.name || c.name;
  }

  // ---- 🎨 pictures
  async function stepForge() {
    if (!has(d.sd, 'status')) return notWired('🎨 Images');
    const st = (await d.sd.status()) || {};
    const label = st.label || (st.backend === 'comfy' ? 'ComfyUI' : 'Forge');
    if (!st.endpoint || st.enabled === false) return { status: 'fail', detail: 'No picture app is connected.', error: 'NOT_CONNECTED', fix: 'Start Forge (or Stability Matrix → Forge), then 🎨 Images → ⚙ Setup → Connect (or press 🔍 Find it). Then run this test again.' };
    const l = has(d.sd, 'lists') ? await d.sd.lists() : null;
    if (!l || l.ok === false) return { status: 'fail', detail: `${label} is set (${st.base || st.endpoint}) but did not answer.`, error: `${codeOf(l) || 'NO_ANSWER'}: ${msgOf(l, 'no answer')}`, fix: `Make sure ${label} is running (its window says "Running on local URL"), then press Refresh in 🎨 Images.` };
    ctx.lists = l; ctx.sdLabel = label;
    return { status: 'pass', detail: `Connected to ${label} (${st.base || st.endpoint}).`, data: { backend: st.backend || '', label } };
  }
  async function stepCheckpoints() {
    const l = ctx.lists || {};
    const n = (l.checkpoints || []).length;
    const cur = (l.current && l.current.checkpoint) || '';
    if (n === 0) {
      let fix = 'Point Forge at a folder with a .safetensors picture model, then press Refresh.';
      if (has(d.sd, 'modelCheck')) { try { const m = await d.sd.modelCheck(); if (m && m.fix) fix = m.fix; } catch (_) {} }
      return { status: 'fail', detail: `${ctx.sdLabel || 'Forge'} lists no picture model, so it cannot make pictures.`, error: 'NO_CHECKPOINT', fix };
    }
    return { status: 'pass', detail: `${n} picture model${n === 1 ? '' : 's'}${cur ? `; loaded now: ${cur}` : ''}.`, data: { count: n, current: cur } };
  }
  async function stepPicture(step) {
    if (!has(d.sd, 'generate')) return notWired('Making pictures');
    step.cancel = () => { try { if (has(d.sd, 'cancel')) d.sd.cancel(); } catch (_) {} };
    const w = gpuWatch();
    let r;
    try { r = await d.sd.generate({ prompt: TEST_PROMPT, width: 512, height: 512, steps: 6, batchSize: 1, seed: -1, purpose: 'test' }); } finally { addPeak(await w.stop()); }
    if (!r || !r.ok) return { status: 'fail', detail: 'The test picture was not made.', error: `${codeOf(r) || 'FAILED'}: ${msgOf(r)}`, fix: (r && (r.fix || r.hint)) || 'Look at Forge\'s own window for the error; try 🎨 Images → 🧪 Test. Out of memory → close other programs that use the graphics card.' };
    const im = (r.images || [])[0] || {};
    if (!im.path || !d.fileExists(im.path)) return { status: 'fail', detail: 'Forge answered, but the picture file is not on disk.', error: 'NO_FILE', fix: 'Check that the "stuff and thing" folder can be written to (free disk space, not read-only).' };
    const dir = has(d, 'imagesDir') ? String(d.imagesDir() || '') : '';
    const inDir = !dir || String(im.path).toLowerCase().startsWith(dir.toLowerCase());
    const sidecar = im.json && d.fileExists(im.json);
    ctx.picture = im.path;
    const kb = Math.round(d.fileSize(im.path) / 1024);
    if (!sidecar) return { status: 'warn', detail: `Picture saved (${kb} KB), but its settings file (.json) is missing.`, error: 'NO_SIDECAR', fix: 'The picture is fine; the settings file is what ♻ Remake uses. Check the images folder can be written to.', data: { path: im.path } };
    if (!inDir) return { status: 'warn', detail: `Picture saved (${kb} KB) with its settings, but outside "stuff and thing/images".`, fix: 'Check ⚙ Folders: the images folder should be inside "stuff and thing".', data: { path: im.path } };
    return { status: 'pass', detail: `Saved in "stuff and thing/images" with its settings file (${kb} KB, seed ${im.seed != null ? im.seed : r.seed}).`, data: { path: im.path, json: im.json } };
  }
  async function stepLoras() {
    const l = ctx.lists || {};
    if (!Array.isArray(l.loras)) return { status: 'warn', detail: 'The picture app did not send a LoRA list.', fix: 'Fine if you do not use LoRAs. Otherwise press Refresh in 🎨 Images.' };
    const n = l.loras.length;
    return n ? { status: 'pass', detail: `${n} LoRA${n === 1 ? '' : 's'} listed.`, data: { count: n } } : { status: 'warn', detail: 'The list is readable but empty (no LoRAs).', fix: 'Fine if you do not use LoRAs; otherwise put them in the Lora models folder and press Refresh.' };
  }
  async function stepLocks() {
    if (!has(d.sd, 'locks')) return notWired('Character locks');
    const r = await d.sd.locks();
    if (!r || r.ok === false || !Array.isArray(r.locks)) return { status: 'fail', detail: 'The character-lock list could not be read.', error: msgOf(r), fix: 'Restart AutoInjector; if it repeats, send the report.' };
    return { status: 'pass', detail: `${r.locks.length} character lock${r.locks.length === 1 ? '' : 's'}.`, data: { count: r.locks.length } };
  }
  async function stepChatgpt() {
    if (!has(d.sd, 'chatgptStatus')) return notWired('The ChatGPT picture engine');
    const r = (await d.sd.chatgptStatus()) || {};
    if (r.ok === false) return { status: 'fail', detail: 'The ChatGPT engine did not answer.', error: msgOf(r), fix: 'Open the ChatGPT pane once, then run the test again.' };
    if (r.ready) return { status: 'pass', detail: `Ready${r.busy ? ' (busy drawing right now)' : ''}. No picture was made — tick "Also make one ChatGPT picture" to test that too.` };
    return { status: 'warn', detail: `Not ready: ${String(r.why || 'the ChatGPT pane is not signed in').slice(0, 300)}.`, fix: 'Only needed for ChatGPT pictures: sign in to ChatGPT in its pane.' };
  }
  async function stepChatgptPicture(step) {
    if (!has(d.sd, 'chatgptPicture')) return notWired('ChatGPT pictures');
    step.cancel = () => { try { if (has(d.sd, 'chatgptCancel')) d.sd.chatgptCancel(); } catch (_) {} };
    const r = await d.sd.chatgptPicture({ prompt: TEST_PROMPT, engine: 'chatgpt', purpose: 'free', from: 'media-selftest' });
    if (!r || !r.ok) return { status: 'fail', detail: 'ChatGPT did not make the picture.', error: `${codeOf(r) || 'FAILED'}: ${msgOf(r)}`, fix: (r && r.fix) || 'Look at the ChatGPT pane: a limit, a sign-in or a refusal shows there.' };
    const p = ((r.images || [])[0] || {}).path;
    return p && d.fileExists(p) ? { status: 'pass', detail: 'ChatGPT made the picture and it was saved.' } : { status: 'fail', detail: 'ChatGPT answered, but no picture file was saved.', error: 'NO_FILE' };
  }

  // ---- 🎬 video (FramePack)
  async function fpStatus() { if (!has(d.video, 'fpStatus')) return null; try { return await d.video.fpStatus(); } catch (_) { return null; } }
  async function stepFpFound() {
    if (!has(d.video, 'fpStatus')) return notWired('FramePack');
    const s = await fpStatus();
    if (!s || s.available === false) return { status: 'skip', detail: 'FramePack is not part of this build.' };
    if (!s.found) {
      let other = null; if (has(d.video, 'status')) { try { other = await d.video.status(); } catch (_) {} }
      const via = other && other.ready && other.backend && other.backend !== 'framepack' ? other.backend : '';
      return { status: via ? 'warn' : 'fail', detail: via ? `FramePack was not found; video uses ${via === 'comfy-wan' ? 'ComfyUI + Wan' : via} instead.` : 'FramePack was not found on this PC.', error: 'FRAMEPACK_NOT_FOUND', fix: s.message || '🎬 Video → ⚙ Setup & models → 📂 Choose FramePack folder (Stability Matrix keeps it in Data\\Packages\\FramePack).' };
    }
    ctx.fp = s;
    return { status: 'pass', detail: `Found (${s.source || 'its folder'}).`, data: { source: s.source || '', dir: s.dir || '' } };
  }
  async function stepFpPython() {
    const s = ctx.fp || (await fpStatus()) || {};
    const bits = []; let bad = null;
    if (!s.pythonOk) bad = { error: 'FRAMEPACK_PYTHON_MISSING', what: 'FramePack\'s own Python (its venv) is missing.', fix: 'Reinstall FramePack in Stability Matrix (or run its own install), so it has its venv folder.' };
    else bits.push('its Python is there');
    if (!bad && !(s.models && s.models.ok)) bad = { error: 'FRAMEPACK_MODEL_MISSING', what: `Model files are missing: ${((s.models && s.models.missing) || []).slice(0, 4).join(', ') || 'unknown'}.`, fix: 'Put the FramePack models in "stuff and thing"/models/video/framepack/hf (or let FramePack download them once in its own app). AutoInjector never downloads them.' };
    else if (!bad) bits.push('all three model files are there');
    const pc = s.precheck;
    if (pc) {
      if (pc.ok) bits.push(`PyTorch ${pc.torch || '?'} sees ${pc.device || 'the graphics card'}${pc.cuda_build ? ` (CUDA ${pc.cuda_build})` : ''}`);
      else if (!bad) bad = { error: 'FRAMEPACK_TORCH_FAILED', what: `PyTorch could not start: ${String(pc.error || (pc.cuda === false ? 'it does not see a CUDA graphics card' : 'unknown')).slice(0, 300)}.`, fix: 'Reinstall FramePack\'s PyTorch with CUDA (a CPU-only PyTorch cannot make video); an RTX 50xx card needs PyTorch built for CUDA 12.8 or newer.' };
    } else bits.push(running && running.mode === 'full' ? 'PyTorch is checked while loading (next step)' : 'PyTorch is checked when FramePack loads (Full test)');
    if (bad) return { status: 'fail', detail: bad.what, error: bad.error, fix: bad.fix };
    return { status: 'pass', detail: `${bits.join('; ')}.`, data: { precheck: pc || null } };
  }
  // Poll FramePack's status while it loads / makes the clip: the stage, its time, "seems stuck".
  function fpWatch(step) {
    let stop = false; let lastStage = '';
    const loop = (async () => {
      while (!stop) {
        const s = await fpStatus();
        if (s && s.loading) { lastStage = s.loading.text || s.loading.stage || lastStage; step.note = `${lastStage} (${s.loading.stageSeconds || 0} s)${s.loading.stuck ? ' — seems stuck' : ''}`; emit(); }
        for (let i = 0; i < 5 && !stop; i++) await d.sleep(200);
      }
    })();
    return { stop: async () => { stop = true; await loop.catch(() => {}); } };
  }
  async function stepFpLoad(step) {
    if (!has(d.video, 'fpLoad')) return notWired('Loading FramePack');
    step.cancel = () => { try { if (has(d.video, 'cancel')) d.video.cancel(); } catch (_) {} };
    const w = gpuWatch(); const fw = fpWatch(step);
    let r;
    try { r = await d.video.fpLoad(); } finally { await fw.stop(); addPeak(await w.stop()); }
    const s = (await fpStatus()) || {};
    ctx.fp = s;
    const times = s.loadTimes && Array.isArray(s.loadTimes.stages) ? s.loadTimes.stages : [];
    const timesText = times.length ? times.map((x) => `${x.stage || x.phase} ${x.seconds} s`).join(' · ') : '';
    const pc = s.precheck;
    const torch = pc && pc.ok ? ` PyTorch ${pc.torch || '?'} on ${pc.device || 'the graphics card'}.` : '';
    if (!r || !r.ok) return { status: 'fail', detail: `FramePack did not load.${timesText ? ` Stages: ${timesText}.` : ''}`, error: `${codeOf(r) || 'FAILED'}: ${msgOf(r)}`, fix: (r && r.fix) || 'Look at 🎬 Video → ⚙ Setup → FramePack for the stage it stopped at; send this report.', data: { stages: times, precheck: pc || null, stderr: (s.stderrTail || []).slice(-15) } };
    return { status: 'pass', detail: `Loaded${s.loadTimes && s.loadTimes.seconds != null ? ` in ${s.loadTimes.seconds} s` : ''}${r.vramGB != null ? `, ${r.vramGB} GB graphics memory free` : ''}.${torch}${timesText ? ` Stages: ${timesText}.` : ''}`, data: { stages: times, seconds: s.loadTimes ? s.loadTimes.seconds : null, vramGB: r.vramGB == null ? null : r.vramGB, precheck: pc || null } };
  }
  async function stepAttention() {
    const s = (await fpStatus()) || ctx.fp || {};
    const a = s.attention;
    if (!a || !a.using) {
      if (!s.loaded) return { status: 'skip', detail: 'Only known after FramePack loads (run the Full test).' };
      return { status: 'warn', detail: 'FramePack is loaded but did not say which attention it uses.', fix: 'Update AutoInjector (the FramePack runner reports it since this version).' };
    }
    const off = (a.disabled || []).length ? ` Turned off (cannot run on this card): ${a.disabled.join(', ')}.` : '';
    return { status: 'pass', detail: `Uses ${a.using}.${off}`, data: a };
  }
  async function writeTestPicture() {
    if (!has(d, 'testPicture') || !has(d, 'tmpDir')) return null;
    const fs = require('fs'); const path = require('path');
    const p = path.join(d.tmpDir(), 'autoinjector-media-selftest.png');
    fs.writeFileSync(p, d.testPicture());
    return p;
  }
  function clipRequest(pic) { return { image: pic, prompt: CLIP_PROMPT, seconds: 1, steps: 6, purpose: 'test', backend: 'framepack', teacache: true, from: 'media-selftest' }; }
  async function stepClip(step) {
    if (!has(d.video, 'animate')) return notWired('Making video');
    const pic = await writeTestPicture();
    if (!pic) return { status: 'fail', detail: 'The built-in test picture could not be written.', error: 'NO_TEST_PICTURE', fix: 'Check the temp folder has space.' };
    step.cancel = () => { try { if (has(d.video, 'cancel')) d.video.cancel(); } catch (_) {} };
    const w = gpuWatch(); const fw = fpWatch(step);
    const t0 = d.now();
    let r;
    try { r = await d.video.animate(clipRequest(pic)); } finally { await fw.stop(); addPeak(await w.stop()); }
    if (!r || !r.ok) return { status: 'fail', detail: 'The test clip was not made.', error: `${codeOf(r) || 'FAILED'}: ${msgOf(r)}`, fix: (r && r.fix) || 'See the error; send this report.' };
    if (!r.path || !d.fileExists(r.path)) return { status: 'fail', detail: 'FramePack finished, but the clip file is not there.', error: 'NO_FILE', fix: 'Check the videos folder can be written to.' };
    ctx.clip = r;
    const missing = [];
    if (!(r.json && d.fileExists(r.json))) missing.push('settings file (.json)');
    if (!(r.poster && d.fileExists(r.poster))) missing.push('poster picture (.png)');
    const kb = Math.round(d.fileSize(r.path) / 1024);
    const what = `${r.seconds != null ? `${r.seconds} s` : 'clip'}${r.width ? `, ${r.width}×${r.height}` : ''}, ${kb} KB, made in ${dur((d.now() - t0) / 1000)}`;
    if (missing.length) return { status: 'warn', detail: `Clip saved (${what}), but its ${missing.join(' and ')} is missing.`, fix: 'The clip is fine; the missing file is what the gallery and ♻ Remake use.', data: { path: r.path } };
    return { status: 'pass', detail: `Saved with its settings file and poster (${what}).`, data: { path: r.path, seconds: r.seconds, width: r.width, height: r.height } };
  }
  async function probe(p) {
    if (!has(d, 'probeMedia')) return { ok: false, skip: true, error: 'the player check is not part of this build' };
    try { return (await d.probeMedia(p)) || { ok: false, error: 'no answer' }; } catch (e) { return { ok: false, error: errText(e) }; }
  }
  async function stepPlayable() {
    const r = await probe(ctx.clip.path);
    if (r.skip) return { status: 'skip', detail: r.error };
    if (!r.ok || !(r.duration > 0)) return { status: 'fail', detail: 'The clip file does not play.', error: String(r.error || 'no length').slice(0, 300), fix: 'The file is damaged or in a format the player cannot read. Send this report (and the clip) — FramePack\'s video writer may have failed.' };
    return { status: 'pass', detail: `Plays: ${r.duration.toFixed(2)} s, ${r.width}×${r.height}.`, data: r };
  }
  async function stepGpuPeak() {
    if (!has(d.gpu, 'read')) return notWired('The graphics-memory reader');
    const g = ctx.gpu;
    if (!g || g.peakMB == null) { const r = await d.gpu.read().catch(() => null); return { status: 'skip', detail: r && r.available ? 'Nothing heavy ran, so there is no peak.' : `Not available here (${(r && r.reason) || 'no NVIDIA tool'}).` }; }
    const pct = g.totalMB ? Math.round(g.peakMB / g.totalMB * 100) : null;
    const tight = pct != null && pct >= 97;
    return { status: tight ? 'warn' : 'pass', detail: `Peak ${gb(g.peakMB)} of ${gb(g.totalMB)}${pct != null ? ` (${pct}%)` : ''}${g.name ? ` on ${g.name}` : ''}; before: ${gb(g.startMB)}.`, fix: tight ? 'Very close to full: raise "GPU memory to keep free" in 🎬 Video, and close other programs that use the graphics card.' : '', data: g };
  }

  // ---- 🎞 trailer
  async function stepTrailer(step) {
    const t = d.trailer;
    if (!has(t, 'record') || !has(t, 'dir')) return notWired('The trailer maker');
    const path = require('path'); const fs = require('fs');
    const dir = t.dir();
    fs.mkdirSync(dir, { recursive: true });
    const stem = `selftest-trailer-${stampOf(new Date(d.now()))}`;
    const webm = path.join(dir, `${stem}.webm`);
    const url = has(t, 'fileUrl') ? t.fileUrl(ctx.clip.path) : require('url').pathToFileURL(ctx.clip.path).href;
    const timeline = { width: 640, height: 360, fps: 24, fade: 0.2, total: 2, music: null, videoBitsPerSecond: 1500000,
      items: [{ kind: 'card', start: 0, seconds: 1, text: 'Media self-test', subtitle: 'AutoInjector' }, { kind: 'clip', number: 1, start: 1, seconds: 1, src: url }] };
    const job = t.record(timeline, webm);
    step.cancel = () => { try { if (job && job.abort) job.abort(); } catch (_) {} };
    const rr = await job.done;
    if (!rr || !rr.ok || !d.fileExists(webm)) return { status: 'fail', detail: 'The trailer could not be joined.', error: `${codeOf(rr) || 'FAILED'}: ${msgOf(rr)}`, fix: 'Send this report; the clip may not be readable by the trailer maker.' };
    ctx.trailer = { webm, mp4: null };
    let extra = ' No ffmpeg on this PC, so only the .webm (fine).';
    const bin = has(t, 'ffmpeg') ? t.ffmpeg() : null;
    if (bin && has(t, 'runFfmpeg') && has(t, 'mp4Args')) {
      const mp4 = path.join(dir, `${stem}.mp4`);
      const fr = await t.runFfmpeg(bin, t.mp4Args(webm, mp4, false), 60000);
      if (fr && fr.ok && d.fileExists(mp4)) { ctx.trailer.mp4 = mp4; extra = ' The .mp4 copy was made with ffmpeg too.'; }
      else extra = ` ffmpeg could not make the .mp4 (${String((fr && (fr.detail || fr.error)) || 'failed').split('\n').filter(Boolean).slice(-1)[0]}); the .webm is fine.`;
    }
    return { status: 'pass', detail: `Joined (${Math.round(d.fileSize(webm) / 1024)} KB .webm in videos/trailers/media-selftest).${extra}`, data: ctx.trailer };
  }
  async function stepTrailerPlays() {
    const out = []; let bad = null;
    for (const [k, p] of [['webm', ctx.trailer.webm], ['mp4', ctx.trailer.mp4]]) {
      if (!p) continue;
      const r = await probe(p);
      if (r.skip) return { status: 'skip', detail: r.error };
      if (!r.ok || !(r.duration > 0)) { bad = bad || { k, error: r.error || 'no length' }; out.push(`.${k} ✖`); } else out.push(`.${k} ${r.duration.toFixed(1)} s ${r.width}×${r.height}`);
    }
    if (bad) return { status: 'fail', detail: `The trailer does not play: ${out.join(', ')}.`, error: String(bad.error).slice(0, 300), fix: 'Send this report and the trailer file.' };
    return { status: 'pass', detail: `Plays: ${out.join(', ')}.` };
  }

  // ---- 🎩 Alfred
  async function stepAlfredAi() {
    const a = d.alfred;
    if (!has(a, 'testAi')) return notWired('Alfred');
    const t = (await a.testAi()) || {};
    if (!t.ok) {
      if (t.error === 'OFF') return { status: 'warn', detail: 'Alfred is switched off.', fix: 'Turn Alfred on (🎩 in the top bar) to let him make pictures and videos for you.' };
      return { status: 'fail', detail: 'Alfred\'s AI is not answering.', error: String(t.message || t.error || 'no answer').slice(0, 400), fix: '🎩 Alfred → 🩺 Check everything shows what to fix (start Ollama, pick a downloaded model).' };
    }
    if (!(running && running.mode === 'full') || !has(a, 'check') || t.kind !== 'local') return { status: 'pass', detail: String(t.message || 'His AI answers.').slice(0, 300) };
    const c = await a.check();
    const row = c && Array.isArray(c.rows) ? c.rows.find((x) => x.id === 'answers') : null;
    if (!row || row.ok == null) return { status: 'warn', detail: `${String(t.message || 'Reachable').slice(0, 200)} — the one-question test was skipped (${(row && row.detail) || 'no answer'}).`, fix: '🎩 Alfred → 🩺 Check everything.' };
    if (!row.ok) return { status: 'fail', detail: 'His model did not answer the short question.', error: String(row.detail || '').slice(0, 300), fix: '🎩 Alfred → 🩺 Check everything → Fix.' };
    return { status: 'pass', detail: `${row.detail}` };
  }
  async function stepAlfredTools() {
    const a = d.alfred;
    if (!has(a, 'toolsDry')) return notWired('Alfred\'s tools');
    const r = (await a.toolsDry()) || {};
    const parts = []; const bad = [];
    for (const [k, label] of [['picture', 'make a picture (generate_image)'], ['video', 'make a video (video_call video.animate)']]) {
      const x = r[k];
      if (x && x.ok) parts.push(`✔ ${label}`); else { bad.push(`${label}: ${String((x && x.error) || 'not reachable').slice(0, 200)}`); parts.push(`✖ ${label}`); }
    }
    if (bad.length) return { status: 'fail', detail: parts.join(' · '), error: bad.join(' | '), fix: 'Update AutoInjector; if it repeats, send this report.' };
    return { status: 'pass', detail: `${parts.join(' · ')} — the requests were checked, nothing was rendered.` };
  }

  // ---- 📖 Akọwe link (the service bridge Akọwe calls for pictures)
  async function stepBridge() {
    const b = d.bridge;
    if (!has(b, 'info') || !has(b, 'http')) return notWired('The bridge');
    const i = b.info();
    if (!i || !i.port) return { status: 'warn', detail: 'The bridge is switched off, so Akọwe cannot ask for pictures.', fix: 'Restart AutoInjector (the bridge starts with it). If port 8765 is taken by another program, close it.' };
    const r = await b.http('GET', '/health');
    if (!r || r.status !== 200) return { status: 'fail', detail: `The bridge on port ${i.port} did not answer.`, error: `HTTP ${r ? r.status : 'none'}${r && r.error ? `: ${r.error}` : ''}`, fix: 'Restart AutoInjector. Another program may use port 8765.' };
    return { status: 'pass', detail: `Answering on port ${i.port}.` };
  }
  async function stepImageRoutes() {
    const b = d.bridge;
    // An empty request is refused by the route's own check (NEED_PROMPT) — the route is there and answers, nothing is drawn or saved.
    const req = await b.http('POST', '/image/request', {});
    const locks = await b.http('POST', '/image/locks', {});
    const judge = (r) => (r && r.status === 400 && r.json && r.json.error === 'NEED_PROMPT' ? 'ok' : r && (r.status === 404 || r.status === 501) ? 'missing' : 'odd');
    const a1 = judge(req); const a2 = judge(locks);
    const say = (name, j, r) => `${name}: ${j === 'ok' ? '✔ answers' : j === 'missing' ? `✖ missing (HTTP ${r.status})` : `✖ unexpected answer (HTTP ${r ? r.status : 'none'}${r && r.json && r.json.error ? ` ${r.json.error}` : ''})`}`;
    const detail = `${say('POST /image/request', a1, req)} · ${say('POST /image/locks', a2, locks)} (a check-only call; nothing was made).`;
    if (a1 === 'ok' && a2 === 'ok') return { status: 'pass', detail };
    return { status: 'fail', detail, error: a1 !== 'ok' ? 'IMAGE_REQUEST_ROUTE' : 'IMAGE_LOCKS_ROUTE', fix: 'Update AutoInjector (both routes are in this version); if they still fail, send this report.' };
  }

  // ---- 🧹 cleanup
  async function stepStopWorks(step) {
    if (!has(d.video, 'animate') || !has(d.video, 'cancel')) return notWired('⏹ Stop');
    const pic = await writeTestPicture();
    let settled = null;
    const p = Promise.resolve(d.video.animate(clipRequest(pic))).then((r) => { settled = { r, at: d.now() }; return r; }, (e) => { settled = { r: { ok: false, error: errText(e) }, at: d.now() }; return settled.r; });
    step.cancel = () => { try { d.video.cancel(); } catch (_) {} };
    // let it really start (a progress step or ~3 s), then press ⏹ Stop
    for (let i = 0; i < 15 && !settled; i++) await d.sleep(200);
    if (settled) return { status: 'warn', detail: 'The clip finished before ⏹ Stop could be pressed (it was too quick to test).', data: { error: codeOf(settled.r) } };
    const t0 = d.now();
    await d.video.cancel();
    for (let i = 0; i < 300 && !settled; i++) await d.sleep(200); // up to 60 s
    if (!settled) return { status: 'fail', detail: '⏹ Stop was pressed but the clip did not stop within 60 s.', error: 'STOP_TIMEOUT', fix: 'Send this report. Closing AutoInjector stops FramePack completely.' };
    await p;
    const s = secs(settled.at - t0);
    const r = settled.r || {};
    if (r.ok) return { status: 'warn', detail: `The clip finished anyway (${s} s after ⏹ Stop).`, fix: 'Stop acts between steps; a very short clip may finish first.' };
    if (/CANCEL/i.test(codeOf(r))) return { status: 'pass', detail: `Stopped ${s} s after ⏹ Stop; nothing was saved.` };
    return { status: 'warn', detail: `It ended ${s} s after ⏹ Stop, but with an error instead of "Stopped".`, error: `${codeOf(r)}: ${msgOf(r)}` };
  }
  async function stepUnload() {
    if (!has(d.video, 'fpUnload')) return notWired('Unloading FramePack');
    const before = (await fpStatus()) || {};
    const pid = before.pid || null;
    const r = await d.video.fpUnload();
    if (r && r.ok === false) return { status: 'fail', detail: 'FramePack could not be unloaded.', error: `${codeOf(r)}: ${msgOf(r)}`, fix: r.fix || 'Close AutoInjector: that stops FramePack completely.' };
    let s = null;
    for (let i = 0; i < 75; i++) { s = await fpStatus(); if (!s || !s.running) break; await d.sleep(200); }
    let alive = false;
    if (pid) for (let i = 0; i < 25; i++) { alive = d.processAlive(pid); if (!alive) break; await d.sleep(200); }
    let mem = '';
    if (has(d.gpu, 'read')) { try { const g = await d.gpu.read(); const x = g && g.available && g.gpus && g.gpus[0]; if (x) mem = ` Graphics memory in use now: ${gb(x.memUsed)} of ${gb(x.memTotal)}.`; } catch (_) {} }
    if ((s && s.running) || alive) return { status: 'fail', detail: `FramePack's Python is still running after unloading${pid ? ` (process ${pid})` : ''}.${mem}`, error: 'PROCESS_LEFT', fix: 'Close AutoInjector, then check Task Manager for a leftover python.exe and end it. Send this report.' };
    return { status: 'pass', detail: `${before.running ? 'Unloaded' : 'It was not running'} — no FramePack Python left running.${mem}` };
  }

  // ---- the run
  async function runStep(st, run) {
    const t0 = d.now();
    st.t0 = t0; st.note = '';
    run.current = st; emit();
    // a needed step must have passed (⚠️ counts only for a step marked warnOk: e.g. a clip saved without its poster still plays)
    const unmet = (st.needs || []).find((n) => { const x = run.byId[n]; return !x || !(x.status === 'pass' || (x.status === 'warn' && x.warnOk)); });
    let out;
    if (unmet) {
      const x = run.byId[unmet];
      out = { status: 'skip', detail: `Skipped — it needs "${x ? x.name : unmet}", which ${x ? (x.status === 'skip' ? 'was skipped' : 'did not pass') : 'did not run'}.` };
    } else {
      const ms = limits[st.id] || 60000;
      let timer = null;
      const timeout = new Promise((res) => { timer = setTimeout(() => res({ __timeout: true }), ms); });
      const cancelled = new Promise((res) => { run.cancelHook = () => res({ __cancelled: true }); });
      let r;
      try {
        r = await Promise.race([Promise.resolve().then(() => st.fn(st)).catch((e) => ({ status: 'fail', detail: 'The check itself went wrong.', error: errText(e), fix: 'Send this report.' })), timeout, cancelled]);
      } finally { clearTimeout(timer); run.cancelHook = null; }
      if (r && (r.__timeout || r.__cancelled)) { try { if (st.cancel) st.cancel(); } catch (_) {} }
      if (r && r.__timeout) out = { status: 'fail', detail: `No answer within ${dur(ms / 1000)} — stopped waiting.`, error: 'STEP_TIMEOUT', fix: 'Something is stuck or very slow. Look at the program it waited for; send this report.' };
      else if (r && r.__cancelled) out = { status: 'skip', detail: '⏹ Stopped by you during this step.' };
      else out = r || { status: 'fail', detail: 'No result.', error: 'NO_RESULT' };
    }
    const rec = { id: st.id, group: st.group, name: st.name, status: out.status, seconds: secs(d.now() - t0), detail: String(out.detail || ''), error: out.error ? String(out.error) : '', fix: out.fix ? String(out.fix) : '', data: out.data || null };
    run.steps.push(rec); run.byId[st.id] = Object.assign({ warnOk: !!st.warnOk }, rec);
    try { d.log('media-selftest-step', { id: rec.id, status: rec.status, seconds: rec.seconds, error: rec.error || undefined }); } catch (_) {}
    run.current = null; emit();
    return rec;
  }

  async function run(opts = {}) {
    if (running) return { ok: false, error: 'BUSY', message: 'The self-test is already running.' };
    const mode = opts.mode === 'full' ? 'full' : 'quick';
    const o = { chatgptPicture: !!opts.chatgptPicture, unload: opts.unload !== false };
    for (const k of Object.keys(ctx)) delete ctx[k];
    const r = running = { mode, plan: plan(mode, o), steps: [], byId: {}, startedAt: d.now(), cancelled: false, cancelHook: null, current: null, opts: o };
    try { d.log('media-selftest-start', { mode, steps: r.plan.length }); } catch (_) {}
    emit();
    try {
      for (const st of r.plan) {
        if (r.cancelled) { const rec = { id: st.id, group: st.group, name: st.name, status: 'skip', seconds: 0, detail: '⏹ Not run — you pressed Stop.', error: '', fix: '', data: null }; r.steps.push(rec); r.byId[st.id] = rec; continue; }
        await runStep(st, r);
      }
    } catch (e) { try { d.log('media-selftest-error', { error: errText(e) }); } catch (_) {} }
    const report = buildReport(r);
    let files = null;
    if (has(d, 'saveReport')) { try { files = await d.saveReport(stampOf(new Date(r.startedAt)), report.markdown, report.jsonText); } catch (e) { report.saveError = errText(e); } }
    report.files = files;
    lastReport = report;
    running = null;
    try { d.log('media-selftest-done', { mode, counts: report.counts, seconds: report.seconds, stopped: report.stopped }); } catch (_) {}
    emit();
    return Object.assign({ ok: true }, publicReport(report));
  }
  function cancel() {
    const r = running;
    if (!r) return { ok: true, cancelled: false, message: 'The self-test is not running.' };
    if (!r.cancelled) { r.cancelled = true; r.stopAt = d.now(); }
    try { if (r.cancelHook) r.cancelHook(); } catch (_) {}
    emit();
    return { ok: true, cancelled: true };
  }

  // ---- the report
  function buildReport(r) {
    const finished = d.now();
    const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
    for (const s of r.steps) counts[s.status] = (counts[s.status] || 0) + 1;
    const stopped = !!r.cancelled;
    const verdict = counts.fail ? 'problems' : counts.warn ? 'mostly-ok' : 'ok';
    const base = {
      kind: 'media-selftest', version: 1, app: 'AutoInjector', mode: r.mode, startedAt: new Date(r.startedAt).toISOString(), finishedAt: new Date(finished).toISOString(),
      seconds: secs(finished - r.startedAt), stopped, stopSeconds: stopped && r.stopAt ? secs(finished - r.stopAt) : null, verdict, counts, options: r.opts,
      steps: r.steps.map((s) => Object.assign({ icon: STATUS_ICON[s.status] }, s)),
      system: has(d, 'systemInfo') ? (() => { try { return d.systemInfo(); } catch (_) { return null; } })() : null,
    };
    const markdown = d.redact(formatMarkdown(base));
    let jsonText = d.redact(JSON.stringify(base, null, 2));
    let json = base; try { json = JSON.parse(jsonText); } catch (_) { jsonText = JSON.stringify(base, null, 2); }
    return Object.assign({}, json, { markdown, jsonText, summary: summaryOf(json) });
  }
  function publicReport(rep) { const o = Object.assign({}, rep); delete o.jsonText; return o; }

  return { run, cancel, status: publicState, last: () => (lastReport ? publicReport(lastReport) : null), busy: () => !!running, _plan: plan };
}

function summaryOf(rep) {
  if (!rep) return '';
  const c = rep.counts || {};
  const tail = rep.stopped ? ' (stopped early)' : '';
  return `🩺 Pictures & video self-test (${rep.mode === 'full' ? 'Full' : 'Quick'}, ${rep.finishedAt ? new Date(rep.finishedAt).toLocaleString() : ''}): ${c.pass || 0} ✅ · ${c.warn || 0} ⚠️ · ${c.fail || 0} ❌ · ${c.skip || 0} ⏭ in ${dur(rep.seconds || 0)}${tail}`;
}

function formatMarkdown(rep) {
  const L = [];
  L.push(`# 🩺 AutoInjector — pictures & video self-test (${rep.mode === 'full' ? 'Full' : 'Quick'})`, '');
  L.push(`- When: ${new Date(rep.startedAt).toLocaleString()} — took ${dur(rep.seconds)}${rep.stopped ? ` — ⏹ stopped by you (the run ended ${rep.stopSeconds} s after Stop)` : ''}`);
  const c = rep.counts;
  L.push(`- Result: **${c.pass} ✅ passed · ${c.warn} ⚠️ to look at · ${c.fail} ❌ failed · ${c.skip} ⏭ skipped**`);
  if (rep.system) {
    const s = rep.system;
    const bits = [s.app ? `AutoInjector ${s.app}` : '', s.platform || '', s.gpu || ''].filter(Boolean);
    if (bits.length) L.push(`- This PC: ${bits.join(' · ')}`);
  }
  L.push('');
  L.push('| | Step | Result | Time |', '|---|---|---|---|');
  for (const s of rep.steps) L.push(`| ${STATUS_ICON[s.status]} | ${GROUPS[s.group] || s.group} — ${esc(s.name)} | ${esc(s.detail)} | ${s.seconds} s |`);
  const probs = rep.steps.filter((s) => s.status === 'fail' || s.status === 'warn');
  if (probs.length) {
    L.push('', '## What to try', '');
    for (const s of probs) {
      L.push(`### ${STATUS_ICON[s.status]} ${s.name}`, '');
      L.push(`- What happened: ${s.detail}`);
      if (s.error) L.push(`- Exact error: \`${String(s.error).replace(/`/g, "'")}\``);
      if (s.fix) L.push(`- What to try: ${s.fix}`);
      if (s.data && Array.isArray(s.data.stderr) && s.data.stderr.length) L.push('- Last lines FramePack printed:', '```', ...s.data.stderr.map((x) => String(x).replace(/```/g, "'''")), '```');
      L.push('');
    }
  } else L.push('', 'Everything that was checked works. 🎉');
  L.push('', '_Made by 🩺 Test pictures & video. Private folders are hidden (your home folder is shown as ~)._');
  return L.join('\n');
}
function esc(s) { return String(s || '').replace(/\|/g, '/').replace(/\r?\n/g, ' '); }

module.exports = { createMediaSelfTest, formatMarkdown, summaryOf, stampOf, TIMEOUTS, GROUPS, STATUS_ICON, TEST_PROMPT };
