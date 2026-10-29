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
  } finally { fs.rmSync(TMP, { recursive: true, force: true }); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
