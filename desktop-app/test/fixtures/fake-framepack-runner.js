'use strict';
// test/fixtures/fake-framepack-runner.js — stands in for integrations/framepack/framepack_runner.py
// (same JSON-lines protocol on stdin/stdout, and its --precheck) so the FramePack engine is tested without a GPU,
// torch or FramePack. Started with node as the "python":
//   AUTOINJECTOR_FRAMEPACK_PYTHON=<node>  AUTOINJECTOR_FRAMEPACK_RUNNER=<this file>
// Behaviour (env):
//   FAKE_FP_MODE   ok (default) | oom (CUDA out of memory in sampling) | crash (exits mid-way) | noready (never says ready)
//                  | stuck (load sits at "starting PyTorch" for ever, ignores cancel, and has a child process of its own)
//                  | flood (writes ~2 MB to stderr while loading — more than any pipe holds)
//                  | failmodel (loading fails at "the FramePack video model" (the transformer) with Hugging Face's offline /
//                    metadata error, worded like the real runner: FRAMEPACK_MODEL_MISSING + "check … all three models")
//                  | failgen (loads fine, then generation fails with xFormers' "No operator found for
//                    `memory_efficient_attention_forward` … capability (12, 0) (too new)", worded like an older runner:
//                    FRAMEPACK_FAILED + "try again, or a shorter clip"). Read from FAKE_FP_CONTROL at EVERY generate,
//                    so the e2e can switch a loaded runner between failgen and ok.
//   FAKE_FP_PRECHECK  ok (default) | nocuda | cpu | dll | notorch | hang (never finishes) | flood (2 MB stderr, then ok)
//   FAKE_FP_STEP_MS  ms per sampling step (default 15) · FAKE_FP_LOAD_MS ms per loading stage (default 10)
//   FAKE_FP_LOG    a file: every command received (+ argv, cwd, HF env, PYTHON* env, PATH, pid) is appended as a JSON line
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// FAKE_FP_CONTROL: a JSON file { mode, precheck } read at start (wins over the env) — the e2e changes it mid-test
let CTL = {}; try { if (process.env.FAKE_FP_CONTROL) CTL = JSON.parse(fs.readFileSync(process.env.FAKE_FP_CONTROL, 'utf8')) || {}; } catch (_) { CTL = {}; }
const MODE = CTL.mode || process.env.FAKE_FP_MODE || 'ok';
const PRE = CTL.precheck || process.env.FAKE_FP_PRECHECK || 'ok';
const STEP_MS = Number(process.env.FAKE_FP_STEP_MS || 15);
const LOAD_MS = Number(process.env.FAKE_FP_LOAD_MS || 10);
const LOG = process.env.FAKE_FP_LOG || '';
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1'), Buffer.from([0, 0, 2, 0]), Buffer.from('isomiso2', 'latin1'), Buffer.from([0, 0, 0, 8]), Buffer.from('free', 'latin1')]);
const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : ''; };
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const note = (o) => { if (LOG) try { fs.appendFileSync(LOG, `${JSON.stringify(o)}\n`); } catch (_) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ~2 MB of warnings on stderr, written synchronously like torch does: if nobody reads the pipe, this blocks for ever.
function flood() { const line = `${'UserWarning: TypedStorage is deprecated. It will be removed in the future. '.repeat(3)}\n`; for (let i = 0; i < 9000; i++) fs.writeSync(2, line); }

const precheck = process.argv.includes('--precheck');
note({ start: true, precheck, mode: MODE, pre: PRE, pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), HF_HOME: process.env.HF_HOME, HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE, framepackDir: arg('--framepack-dir'), hfHome: arg('--hf-home'),
  PYTHONPATH: process.env.PYTHONPATH, PYTHONHOME: process.env.PYTHONHOME, PYTHONUNBUFFERED: process.env.PYTHONUNBUFFERED, PYTHONNOUSERSITE: process.env.PYTHONNOUSERSITE, PATH: process.env.PATH, VIRTUAL_ENV: process.env.VIRTUAL_ENV, stdinIsTTY: !!process.stdin.isTTY });

if (precheck) {
  emit({ event: 'precheck-start', python: 'fake', executable: process.execPath, pid: process.pid, cwd: process.cwd() });
  const facts = { event: 'precheck', python: 'fake', executable: process.execPath, cwd: process.cwd() };
  if (PRE === 'hang') { setInterval(() => emit({ event: 'heartbeat', job: 'precheck', seconds: 1, where: 'torch/__init__.py:262 _load_dll_libraries' }), 100); }
  else {
    if (PRE === 'flood') flood();
    if (PRE === 'ok' || PRE === 'flood') Object.assign(facts, { ok: true, torch: '2.6.0+cu126', cuda: true, cuda_build: '12.6', device: 'NVIDIA GeForce RTX 3060', free_gb: 11.2, total_gb: 12, import_seconds: 0.1, seconds: 0.1 });
    else if (PRE === 'nocuda') Object.assign(facts, { ok: false, torch: '2.6.0+cu126', cuda: false, cuda_build: '12.6', seconds: 0.1 });
    else if (PRE === 'cpu') Object.assign(facts, { ok: false, torch: '2.6.0+cpu', cuda: false, cuda_build: null, seconds: 0.1 });
    else if (PRE === 'dll') { process.stderr.write('Traceback (most recent call last):\nOSError: [WinError 126] The specified module could not be found. Error loading "C:\\FramePack\\venv\\lib\\site-packages\\torch\\lib\\cudnn_cnn64_9.dll" or one of its dependencies.\n'); Object.assign(facts, { ok: false, error_type: 'OSError', error: 'OSError: [WinError 126] The specified module could not be found. Error loading "C:\\FramePack\\venv\\lib\\site-packages\\torch\\lib\\cudnn_cnn64_9.dll" or one of its dependencies.', seconds: 0.1 }); }
    else if (PRE === 'notorch') Object.assign(facts, { ok: false, error_type: 'ModuleNotFoundError', error: "ModuleNotFoundError: No module named 'torch'", seconds: 0.1 });
    emit(facts);
    process.exitCode = facts.ok ? 0 : 1;
  }
} else {
  let loaded = false; let job = null; let cancel = false;

  async function load(id) {
    if (MODE === 'stuck') {
      // what the PC showed: step 0 "starting PyTorch", then nothing. It has a child of its own (like a venv launcher's python).
      const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      note({ grandchild: kid.pid });
      emit({ event: 'loading', stage: 'starting PyTorch', step: 0, steps: 7 });
      setInterval(() => emit({ event: 'heartbeat', job: 'load', seconds: 1, where: 'torch/__init__.py:262 _load_dll_libraries < torch/__init__.py:290 <module>' }), 100);
      await new Promise(() => {}); // never
    }
    const stages = ['the text encoder (Llama)', 'the VAE', 'the FramePack video model'];
    for (let i = 0; i < stages.length; i++) {
      emit({ event: 'loading', stage: stages[i], step: i + 1, steps: stages.length });
      if (MODE === 'flood' && i === 0) flood();
      await sleep(LOAD_MS);
      if (MODE === 'failmodel' && i === stages.length - 1) {
        const err = "OSError: We couldn't connect to 'https://huggingface.co' to load the files, and couldn't find them in the cached files. Check your internet connection or see how to run the library in offline mode at 'https://huggingface.co/docs/transformers/installation#offline-mode'.";
        process.stderr.write(`Traceback (most recent call last):\n  File "framepack_runner.py", line 300, in load_models\nhuggingface_hub.errors.LocalEntryNotFoundError: Cannot find the requested files in the disk cache and outgoing traffic has been disabled.\n${err}\n`);
        emit({ event: 'error', id, code: 'FRAMEPACK_MODEL_MISSING', message: `FramePack could not open one of its model files (${err.slice(0, 200)}).`,
          fix: 'Check the FramePack models folder ("stuff and thing"/models/video/framepack/hf/hub) has all three models. Nothing is downloaded by AutoInjector.',
          detail: `Traceback (most recent call last):\nhuggingface_hub.errors.LocalEntryNotFoundError: Cannot find the requested files in the disk cache and outgoing traffic has been disabled.\n${err}` });
        return false;
      }
    }
    loaded = true;
    emit({ event: 'loaded', vram_gb: 11.5, high_vram: false });
    return true;
  }

  const liveMode = () => { try { return (process.env.FAKE_FP_CONTROL && JSON.parse(fs.readFileSync(process.env.FAKE_FP_CONTROL, 'utf8')).mode) || MODE; } catch (_) { return MODE; } };
  const XFORMERS = 'NotImplementedError: No operator found for `memory_efficient_attention_forward` with inputs:\n     query       : shape=(1, 3200, 24, 128) (torch.bfloat16)\n`fa2F@2.5.7-pt` is not supported because:\n    requires device with capability <= (9, 0) but your GPU has capability (12, 0) (too new)\n`cutlassF-pt` is not supported because:\n    requires device with capability <= (9, 0) but your GPU has capability (12, 0) (too new)';
  async function generate(m) {
    const id = m.id;
    const gm = liveMode();
    if (!m.image || !fs.existsSync(m.image)) { emit({ event: 'error', id, code: 'BAD_REQUEST', message: `The picture "${m.image}" was not found.` }); return; }
    const seconds = Math.max(1, Math.min(10, Number(m.seconds) || 5));
    const sections = Math.max(1, Math.round((seconds * 30) / 36));
    const frames = (sections * 9 + 1) * 4 - 3;
    const steps = Math.max(1, Math.round(Number(m.steps) || 25));
    emit({ event: 'accepted', id, sections, frames, seconds: Math.round(frames / 30 * 100) / 100, seed: m.seed });
    if (!loaded && !(await load(id))) return;
    for (const ph of ['text', 'picture', 'vae-encode', 'vision']) emit({ event: 'progress', id, phase: ph, section: 0, sections, step: 0, steps, percent: 0 });
    if (gm === 'failgen') {
      process.stderr.write(`Traceback (most recent call last):\n  File "diffusers_helper/models/hunyuan_video_packed.py", line 120, in attn_varlen_func\n${XFORMERS}\n`);
      emit({ event: 'error', id, code: 'FRAMEPACK_FAILED', message: `FramePack could not make the video: ${XFORMERS.split('\n')[0].slice(0, 300)}`, fix: 'Look at the details below; try again, or a shorter clip.', detail: XFORMERS });
      return;
    }
    if (m.poster) { try { fs.copyFileSync(m.image, m.poster); } catch (_) {} }
    for (let s = 1; s <= sections; s++) {
      for (let k = 1; k <= steps; k++) {
        if (cancel) { cancel = false; emit({ event: 'cancelled', id }); return; }
        if (MODE === 'oom' && s === 1 && k === 2) { process.stderr.write('torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB\n'); emit({ event: 'error', id, code: 'FRAMEPACK_OOM', message: 'Your graphics card ran out of memory making this video.', fix: 'Raise "GPU memory to keep free" (e.g. to 8 or 10 GB), make a shorter clip, and close other programs that use the graphics card.', detail: 'OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB' }); return; }
        if (MODE === 'crash' && s === 1 && k === 2) { process.stderr.write('Fatal: something broke inside FramePack\n'); process.exit(3); }
        emit({ event: 'progress', id, phase: 'sampling', section: s, sections, step: k, steps, percent: Math.round(((s - 1) * steps + k) / (sections * steps) * 1e4) / 1e4, frames: (s - 1) * 36, video_seconds: (s - 1) * 1.2 });
        await sleep(STEP_MS);
      }
      emit({ event: 'progress', id, phase: 'decoding', section: s, sections, step: steps, steps, percent: s / sections });
    }
    fs.mkdirSync(path.dirname(m.out), { recursive: true });
    fs.writeFileSync(m.out, MP4);
    emit({ event: 'result', id, ok: true, path: m.out, frames, fps: 30, seconds: Math.round(frames / 30 * 100) / 100, width: 640, height: 480, sections, seed: m.seed, poster: m.poster || null });
  }

  if (MODE !== 'noready') emit({ event: 'ready', protocol: 1, pid: process.pid, python: 'fake' });
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch (_) { emit({ event: 'error', code: 'BAD_REQUEST', message: 'That line is not JSON.' }); continue; }
      note({ cmd: m });
      if (m.cmd === 'ping') emit({ event: 'pong', id: m.id });
      else if (m.cmd === 'status') emit({ event: 'status', id: m.id, busy: !!job, loaded });
      else if (m.cmd === 'quit') { if (MODE !== 'stuck') process.exit(0); }
      else if (m.cmd === 'cancel') { if (MODE === 'stuck') continue; if (job) { cancel = true; emit({ event: 'cancelling', id: m.id }); } else emit({ event: 'cancelled', id: m.id, idle: true }); }
      else if (m.cmd === 'load') { if (job) { emit({ event: 'error', id: m.id, code: 'FRAMEPACK_BUSY', message: 'busy' }); continue; } job = load(m.id).finally(() => { job = null; }); }
      else if (m.cmd === 'generate') { if (job) { emit({ event: 'error', id: m.id, code: 'FRAMEPACK_BUSY', message: 'FramePack is already busy.' }); continue; } job = generate(m).finally(() => { job = null; }); }
    }
  });
  process.stdin.on('end', () => { if (MODE !== 'stuck') process.exit(0); });
}
