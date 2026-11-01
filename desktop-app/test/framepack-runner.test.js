'use strict';
// test/framepack-runner.test.js — the REAL FramePack runner (integrations/framepack/framepack_runner.py), with any
// Python 3 and WITHOUT torch / FramePack:
//   1. it compiles (py_compile — real syntax check);
//   2. its JSON / argument handling: test/fixtures/framepack_runner_check.py imports it and checks request clamping,
//      the section maths (demo_gradio.py), error words, the model check and the JSON-lines server with a fake engine;
//   3. as a process: `--check` answers one JSON line (missing models named), a folder that is not FramePack →
//      FRAMEPACK_NOT_FOUND, and the real server answers ready / pong / status over stdin/stdout.
// No Python on this computer → the checks are skipped (said so), not failed.
// Run: node test/framepack-runner.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const F = require('./fixtures/fake-framepack');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const RUNNER = path.join(__dirname, '..', 'integrations', 'framepack', 'framepack_runner.py');
const CHECK = path.join(__dirname, 'fixtures', 'framepack_runner_check.py');

function findPython() {
  for (const c of [process.env.PYTHON, 'python3', 'python'].filter(Boolean)) {
    const r = spawnSync(c, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0 && String(r.stdout).trim() === '3') return c;
  }
  return null;
}

async function main() {
  assert(fs.existsSync(RUNNER), 'the runner ships in integrations/framepack/');
  const src = fs.readFileSync(RUNNER, 'utf8');
  assert(/HF_HUB_OFFLINE'\] = '1'/.test(src) && !/^import torch/m.test(src) && /def setup_env/.test(src), 'it sets HF_HUB_OFFLINE=1 and imports torch only inside functions');
  assert(/sample_hunyuan\(/.test(src) && /soft_append_bcthw\(/.test(src) && /save_bcthw_as_mp4\(/.test(src) && /DynamicSwapInstaller\.install_model/.test(src) && /get_cuda_free_memory_gb\(gpu\)/.test(src) && /lllyasviel\/FramePackI2V_HY/.test(src), 'it mirrors demo_gradio.py: sample_hunyuan sections, soft_append, save_bcthw_as_mp4, the high/low-VRAM switch, the I2V model');
  const py = findPython();
  if (!py) { console.log('  skip - no Python 3 on this computer: the runner checks need one (the app uses FramePack\'s own Python)'); console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0); }
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-runner-'));
  try {
    // 1. compiles
    const comp = spawnSync(py, ['-B', '-c', 'import py_compile,sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)', RUNNER, path.join(TMP, 'r.pyc')], { encoding: 'utf8' });
    assert(comp.status === 0, `python -m py_compile: the runner compiles${comp.status ? ` — ${comp.stderr}` : ''}`);
    // 2. its logic, with a fake engine
    const hfOk = F.makeHfCache(path.join(TMP, 'hf-ok'));
    const hfPartial = F.makeHfCache(path.join(TMP, 'hf-partial'), { skip: ['hunyuanvideo-community/HunyuanVideo/vae', 'lllyasviel/FramePackI2V_HY'] });
    const r = spawnSync(py, ['-B', CHECK, RUNNER, hfOk, hfPartial, TMP], { encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { PYTHONDONTWRITEBYTECODE: '1' }) });
    const lines = String(r.stdout || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    for (const x of lines) if (x.name) assert(x.ok, `runner: ${x.name}`);
    assert(r.status === 0 && lines.some((x) => x.done), `the Python checks ran to the end${r.status ? ` — ${String(r.stderr).slice(-800)}` : ''}`);
    // 3. as a process
    const fpDir = F.makeFramePackDir(path.join(TMP, 'FramePack'));
    const ck = spawnSync(py, ['-B', RUNNER, '--framepack-dir', fpDir, '--hf-home', hfPartial, '--check'], { encoding: 'utf8', timeout: 30000 });
    const j = JSON.parse(String(ck.stdout).trim().split('\n').pop() || '{}');
    assert(ck.status === 0 && j.event === 'check' && j.ok === false && j.missing.includes('lllyasviel/FramePackI2V_HY'), '--check: one JSON line, the missing models named');
    const nf = spawnSync(py, ['-B', RUNNER, '--framepack-dir', path.join(TMP, 'nope'), '--check'], { encoding: 'utf8', timeout: 30000 });
    assert(nf.status === 2 && /FRAMEPACK_NOT_FOUND/.test(nf.stdout), 'a folder that is not FramePack → FRAMEPACK_NOT_FOUND');
    const got = await new Promise((resolve) => {
      const ch = spawn(py, ['-B', '-u', RUNNER, '--framepack-dir', fpDir, '--hf-home', hfOk], { cwd: fpDir });
      let buf = ''; const evs = [];
      const t = setTimeout(() => { try { ch.kill(); } catch (_) {} resolve(evs); }, 20000);
      ch.stdout.on('data', (d) => {
        buf += d; let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const l = buf.slice(0, i); buf = buf.slice(i + 1);
          let e = null; try { e = JSON.parse(l); } catch (_) { e = null; }
          if (!e) continue; evs.push(e);
          if (e.event === 'ready') { ch.stdin.write(`${JSON.stringify({ cmd: 'ping', id: 'x' })}\n`); ch.stdin.write(`${JSON.stringify({ cmd: 'status', id: 'y' })}\n`); }
          if (e.event === 'status') ch.stdin.write(`${JSON.stringify({ cmd: 'quit' })}\n`);
        }
      });
      ch.on('exit', () => { clearTimeout(t); resolve(evs); });
    });
    assert(got.some((e) => e.event === 'ready' && e.protocol === 1) && got.some((e) => e.event === 'pong' && e.id === 'x') && got.some((e) => e.event === 'status' && e.loaded === false && e.busy === false), 'the real server over stdin/stdout: ready → pong → status (not loaded) → quit');
    assert(got.every((e) => e && e.event), 'stdout carries only JSON lines');
    // native code writing straight to file descriptor 1 (CUDA, FFmpeg) and plain prints must not reach the JSON stdout
    const noisy = spawnSync(py, ['-B', '-c', [
      'import importlib.util, os, sys',
      'spec = importlib.util.spec_from_file_location("r", sys.argv[1]); R = importlib.util.module_from_spec(spec); spec.loader.exec_module(R)',
      'proto = R.protocol_stream()',
      'os.write(1, b"native noise\\n"); print("print noise"); sys.stdout.flush()',
      'proto.write("{\\"event\\": \\"x\\"}\\n"); proto.flush()',
    ].join('\n'), RUNNER], { encoding: 'utf8', timeout: 30000 });
    assert(noisy.status === 0 && noisy.stdout === '{"event": "x"}\n' && /native noise/.test(noisy.stderr) && /print noise/.test(noisy.stderr), `stdout keeps only JSON lines even when native code writes to it (got ${JSON.stringify(noisy.stdout)})`);

    // ---- the PC report: stuck at "starting PyTorch". A fake torch package (no GPU here) that is slow to import.
    const fakeTorch = path.join(TMP, 'fake-site'); fs.mkdirSync(path.join(fakeTorch, 'torch'), { recursive: true });
    fs.writeFileSync(path.join(fakeTorch, 'torch', '__init__.py'), [
      'import os, sys, time',
      'def _load_dll_libraries():',
      "    time.sleep(float(os.environ.get('FAKE_TORCH_IMPORT_S', '0')))",
      '_load_dll_libraries()',
      "print('torch: a warning on stderr', file=sys.stderr)",
      "__version__ = os.environ.get('FAKE_TORCH_VERSION', '2.6.0+cu126')",
      'class version:',
      "    cuda = None if __version__.endswith('+cpu') else '12.6'",
      'class cuda:',
      '    @staticmethod',
      "    def is_available(): return os.environ.get('FAKE_TORCH_CUDA', '1') == '1'",
      '    @staticmethod',
      "    def get_device_name(i): return 'Fake RTX 3060'",
      '    @staticmethod',
      '    def mem_get_info(): return (11 * 1024 ** 3, 12 * 1024 ** 3)',
      '',
    ].join('\n'));
    const envT = (o) => Object.assign({}, process.env, { PYTHONPATH: fakeTorch, PYTHONDONTWRITEBYTECODE: '1' }, o || {});
    const lastJson = (out, ev) => String(out).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter((e) => e && e.event === ev).pop();
    // --precheck: torch + CUDA in the main thread, one JSON line
    const pc1 = spawnSync(py, ['-B', '-u', RUNNER, '--precheck', '--framepack-dir', fpDir, '--hf-home', hfOk], { encoding: 'utf8', timeout: 30000, cwd: fpDir, env: envT() });
    const j1 = lastJson(pc1.stdout, 'precheck');
    assert(pc1.status === 0 && j1 && j1.ok === true && j1.torch === '2.6.0+cu126' && j1.cuda === true && j1.cuda_build === '12.6' && j1.device === 'Fake RTX 3060' && j1.free_gb === 11 && typeof j1.seconds === 'number', `--precheck: PyTorch version, CUDA, the card, free memory (${JSON.stringify(j1 && { torch: j1.torch, cuda: j1.cuda, device: j1.device })})`);
    assert(/torch: a warning on stderr/.test(pc1.stderr) && lastJson(pc1.stdout, 'precheck-start'), '--precheck: says it started first; what torch prints goes to stderr');
    const pc2 = spawnSync(py, ['-B', '-u', RUNNER, '--precheck', '--framepack-dir', fpDir], { encoding: 'utf8', timeout: 30000, cwd: fpDir, env: envT({ FAKE_TORCH_CUDA: '0' }) });
    const j2 = lastJson(pc2.stdout, 'precheck');
    assert(pc2.status === 1 && j2 && j2.ok === false && j2.cuda === false && j2.torch, '--precheck: no CUDA → ok false, cuda false (exit 1)');
    const pc3 = spawnSync(py, ['-B', '-u', RUNNER, '--precheck', '--framepack-dir', fpDir], { encoding: 'utf8', timeout: 30000, cwd: fpDir, env: Object.assign({}, process.env, { PYTHONPATH: '' }) });
    const j3 = lastJson(pc3.stdout, 'precheck');
    const noTorchHere = spawnSync(py, ['-c', 'import torch'], { encoding: 'utf8' }).status !== 0;
    if (noTorchHere) assert(pc3.status === 1 && j3 && j3.ok === false && /No module named 'torch'/.test(j3.error) && /Traceback|No module/.test(pc3.stderr), `--precheck without torch → the error in its words (${j3 && j3.error})`);
    const words = require('../framepack').explainPrecheck(j3 && j3.ok === false ? j3 : { ok: false, error: "ModuleNotFoundError: No module named 'torch'" });
    assert(words && words.cause === 'TORCH_MISSING' && /not installed/.test(words.message), `…which AutoInjector says in plain words: “${words && words.message}”`);
    // a slow import: the heartbeat says where it is, every few seconds
    const pc4 = spawnSync(py, ['-B', '-u', RUNNER, '--precheck', '--framepack-dir', fpDir], { encoding: 'utf8', timeout: 30000, cwd: fpDir, env: envT({ FAKE_TORCH_IMPORT_S: '0.8', AUTOINJECTOR_FRAMEPACK_HEARTBEAT_S: '0.15' }) });
    const beats = String(pc4.stdout).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter((e) => e && e.event === 'heartbeat');
    assert(beats.length >= 3 && beats.every((b) => /torch\/__init__\.py:\d+ _load_dll_libraries/.test(b.where)), `--precheck heartbeats while torch imports, naming where (${beats.length}: ${beats[0] && beats[0].where})`);

    // the real server: the load imports torch in a thread while the main thread waits for commands
    const runServer = (o, script) => new Promise((resolve) => {
      const ch = spawn(py, ['-B', '-u', RUNNER, '--framepack-dir', fpDir, '--hf-home', hfOk], { cwd: fpDir, env: envT(o) });
      let buf = ''; const evs = []; let stdinTarget = null;
      const t = setTimeout(() => { try { ch.kill('SIGKILL'); } catch (_) {} resolve({ evs, stdinTarget, timedOut: true }); }, 20000);
      ch.stdout.on('data', (d) => {
        buf += d; let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const l = buf.slice(0, i); buf = buf.slice(i + 1);
          let e = null; try { e = JSON.parse(l); } catch (_) { e = null; }
          if (!e) continue; evs.push(e);
          if (e.event === 'ready') { try { stdinTarget = fs.readlinkSync(`/proc/${ch.pid}/fd/0`); } catch (_) { stdinTarget = null; } }
          script(e, (m) => ch.stdin.write(`${JSON.stringify(m)}\n`), evs);
        }
      });
      ch.stderr.on('data', () => {});
      ch.on('exit', () => { clearTimeout(t); resolve({ evs, stdinTarget }); });
    });
    const s1 = await runServer({ FAKE_TORCH_IMPORT_S: '1', FAKE_TORCH_CUDA: '0', AUTOINJECTOR_FRAMEPACK_HEARTBEAT_S: '0.2' }, (e, sendCmd) => {
      if (e.event === 'ready') { sendCmd({ cmd: 'ping', id: 'p' }); sendCmd({ cmd: 'load', id: 'L' }); }
      if (e.event === 'error' && e.id === 'L') sendCmd({ cmd: 'quit' });
    });
    if (process.platform === 'linux') assert(s1.stdinTarget === '/dev/null', `the runner's own standard input is NUL (/dev/null) — commands come through a private copy, so a DLL starting up can't block on it (fd 0 → ${s1.stdinTarget})`);
    assert(s1.evs.some((e) => e.event === 'pong'), 'commands still arrive through the private copy of stdin (ping → pong)');
    const lo = s1.evs.filter((e) => e.event === 'loading').map((e) => e.stage);
    const hb = s1.evs.filter((e) => e.event === 'heartbeat' && e.job === 'load');
    assert(lo[0] === 'starting PyTorch' && lo.includes('checking the graphics card (CUDA)'), `the load says “starting PyTorch”, then “checking the graphics card (CUDA)” once torch is in (${lo.join(' → ')})`);
    assert(hb.length >= 2 && hb.some((b) => /torch\/__init__\.py:\d+ _load_dll_libraries/.test(b.where)), `while torch imports the runner sends heartbeats with where it is (${hb.length}: ${hb[0] && hb[0].where})`);
    const err = s1.evs.find((e) => e.event === 'error' && e.id === 'L');
    assert(err && err.cause === 'NO_GPU' && /NVIDIA graphics card/.test(err.message), `no CUDA → the load fails in words, it does not hang (${err && err.message})`);
    // Stop while torch is importing: the load stops right after the import (between stages)
    const s2 = await runServer({ FAKE_TORCH_IMPORT_S: '1' }, (e, sendCmd) => {
      if (e.event === 'loading' && e.stage === 'starting PyTorch') sendCmd({ cmd: 'cancel' });
      if (e.event === 'ready') sendCmd({ cmd: 'load', id: 'L2' });
      if (e.event === 'cancelled' || e.event === 'loaded' || (e.event === 'error' && e.id === 'L2')) sendCmd({ cmd: 'quit' });
    });
    assert(s2.evs.some((e) => e.event === 'cancelling') && s2.evs.some((e) => e.event === 'cancelled' && e.id === 'L2') && !s2.evs.some((e) => e.event === 'loading' && /CUDA|text encoder/.test(e.stage)), 'Stop during “starting PyTorch” → cancelled as soon as the import returns (no further stage)');
  } finally { fs.rmSync(TMP, { recursive: true, force: true }); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
