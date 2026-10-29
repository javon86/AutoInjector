'use strict';
// test/fixtures/fake-framepack-runner.js — stands in for integrations/framepack/framepack_runner.py
// (same JSON-lines protocol on stdin/stdout) so the FramePack engine is tested without a GPU,
// torch or FramePack. Started with node as the "python":
//   AUTOINJECTOR_FRAMEPACK_PYTHON=<node>  AUTOINJECTOR_FRAMEPACK_RUNNER=<this file>
// Behaviour (env):
//   FAKE_FP_MODE   ok (default) | oom (CUDA out of memory in sampling) | crash (exits mid-way) | noready (never says ready)
//   FAKE_FP_STEP_MS  ms per sampling step (default 15) · FAKE_FP_LOAD_MS ms per loading stage (default 10)
//   FAKE_FP_LOG    a file: every command received (+ argv, cwd, HF env) is appended as a JSON line
const fs = require('fs');
const path = require('path');

const MODE = process.env.FAKE_FP_MODE || 'ok';
const STEP_MS = Number(process.env.FAKE_FP_STEP_MS || 15);
const LOAD_MS = Number(process.env.FAKE_FP_LOAD_MS || 10);
const LOG = process.env.FAKE_FP_LOG || '';
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1'), Buffer.from([0, 0, 2, 0]), Buffer.from('isomiso2', 'latin1'), Buffer.from([0, 0, 0, 8]), Buffer.from('free', 'latin1')]);
const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : ''; };
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const note = (o) => { if (LOG) try { fs.appendFileSync(LOG, `${JSON.stringify(o)}\n`); } catch (_) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

note({ start: true, argv: process.argv.slice(2), cwd: process.cwd(), HF_HOME: process.env.HF_HOME, HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE, framepackDir: arg('--framepack-dir'), hfHome: arg('--hf-home') });
let loaded = false; let job = null; let cancel = false;

async function load() {
  const stages = ['the text encoder (Llama)', 'the VAE', 'the FramePack video model'];
  for (let i = 0; i < stages.length; i++) { emit({ event: 'loading', stage: stages[i], step: i + 1, steps: stages.length }); await sleep(LOAD_MS); }
  loaded = true;
  emit({ event: 'loaded', vram_gb: 11.5, high_vram: false });
}

async function generate(m) {
  const id = m.id;
  if (!m.image || !fs.existsSync(m.image)) { emit({ event: 'error', id, code: 'BAD_REQUEST', message: `The picture "${m.image}" was not found.` }); return; }
  const seconds = Math.max(1, Math.min(10, Number(m.seconds) || 5));
  const sections = Math.max(1, Math.round((seconds * 30) / 36));
  const frames = (sections * 9 + 1) * 4 - 3;
  const steps = Math.max(1, Math.round(Number(m.steps) || 25));
  emit({ event: 'accepted', id, sections, frames, seconds: Math.round(frames / 30 * 100) / 100, seed: m.seed });
  if (!loaded) await load();
  for (const ph of ['text', 'picture', 'vae-encode', 'vision']) emit({ event: 'progress', id, phase: ph, section: 0, sections, step: 0, steps, percent: 0 });
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
    else if (m.cmd === 'quit') process.exit(0);
    else if (m.cmd === 'cancel') { if (job) { cancel = true; emit({ event: 'cancelling', id: m.id }); } else emit({ event: 'cancelled', id: m.id, idle: true }); }
    else if (m.cmd === 'load') { if (job) { emit({ event: 'error', id: m.id, code: 'FRAMEPACK_BUSY', message: 'busy' }); continue; } job = load().finally(() => { job = null; }); }
    else if (m.cmd === 'generate') { if (job) { emit({ event: 'error', id: m.id, code: 'FRAMEPACK_BUSY', message: 'FramePack is already busy.' }); continue; } job = generate(m).finally(() => { job = null; }); }
  }
});
process.stdin.on('end', () => process.exit(0));
