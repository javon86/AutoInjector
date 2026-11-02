'use strict';
// test/media-selftest.test.js — the 🩺 "Test pictures & video" self-test (media-selftest.js) with fakes:
//   1. the REAL 🎨 Images code (image-provider + sd-library + sd-studio) against a fake Forge (fake-sd.js), and the
//      REAL FramePack engine (framepack.js) with the fake runner (fake-framepack-runner.js): Quick renders nothing;
//      Full makes the tiny picture (512×512, 6 steps), loads FramePack (stage times, the attention kernel), unloads
//      it and checks no runner process is left.
//   2. a failing step (Forge out of memory) is reported with the error and what to try — and the run goes on.
//   3. a step that never answers hits its time limit (the step's own cancel is called) — the run goes on.
//   4. ⏹ Stop mid-step: the running step is stopped at once, the rest are skipped, the report is still written.
//   5. the report: Markdown + JSON saved, private paths redacted, the summary line; plan of Quick vs Full.
// Run: node test/media-selftest.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const MS = require('../media-selftest');
const ip = require('../image-provider');
const L = require('../sd-library');
const { createSdStudio } = require('../sd-studio');
const FP = require('../framepack');
const F = require('./fixtures/fake-framepack');
const { fakeA1111 } = require('./fixtures/fake-sd');
const logExtract = require('../log-extract');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'media-selftest-'));
const byId = (rep, id) => rep.steps.find((s) => s.id === id) || {};

function writeSafetensors(file, metadata) {
  const json = Buffer.from(JSON.stringify({ __metadata__: metadata, w: { dtype: 'F16', shape: [2], data_offsets: [0, 4] } }));
  const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(json.length));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([len, json, Buffer.from([1, 2, 3, 4])]));
}

// Everything that is not the subject of a test: quiet fakes that pass.
function fakeVideo(o = {}) {
  const calls = [];
  let loaded = false; let running = false;
  const v = {
    calls,
    status: async () => ({ ready: true, backend: 'framepack' }),
    fpStatus: async () => ({ available: true, found: true, source: 'Stability Matrix', dir: '/x/FramePack', pythonOk: true, models: { ok: true, missing: [] }, running, loaded, pid: null,
      attention: loaded ? { using: 'pytorch-sdpa', disabled: ['xformers'] } : null, loadTimes: loaded ? { seconds: 3, stages: [{ stage: 'the VAE', seconds: 1 }] } : null,
      precheck: loaded ? { ok: true, torch: '2.7.0+cu128', device: 'NVIDIA GeForce RTX 5070 Ti', cuda_build: '12.8' } : null }),
    fpLoad: async () => { calls.push('load'); if (o.loadHang) return new Promise(() => {}); loaded = true; running = true; return { ok: true, vramGB: 14.2 }; },
    fpUnload: async () => { calls.push('unload'); loaded = false; running = false; return { ok: true }; },
    animate: async (req) => {
      calls.push(`animate:${req.seconds}s:${req.steps}`);
      if (o.clipHang) return new Promise(() => {});
      const p = path.join(TMP, `clip-${calls.length}.mp4`); fs.writeFileSync(p, 'mp4'); fs.writeFileSync(p.replace(/\.mp4$/, '.json'), '{}'); fs.writeFileSync(p.replace(/\.mp4$/, '.png'), 'png');
      if (o.cancellable) { await sleep(200); if (v.cancelled) return { ok: false, code: 'VIDEO_CANCELLED', message: 'Stopped.' }; }
      if (calls.filter((c) => c.startsWith('animate')).length === 2) { // the ⏹ Stop test: wait for the cancel
        for (let i = 0; i < 120 && !v.cancelled; i++) await sleep(50);
        if (v.cancelled) return { ok: false, code: 'VIDEO_CANCELLED', message: 'Stopped.' };
      }
      return { ok: true, path: p, json: p.replace(/\.mp4$/, '.json'), poster: p.replace(/\.mp4$/, '.png'), seconds: 1.07, width: 640, height: 480 };
    },
    cancel: async () => { calls.push('cancel'); v.cancelled = true; return { ok: true, cancelled: true }; },
  };
  return v;
}
function baseDeps(extra = {}) {
  const saved = [];
  const d = Object.assign({
    sd: { status: () => ({ endpoint: 'http://127.0.0.1:7860', enabled: true, backend: 'a1111', label: 'Forge' }), lists: async () => ({ ok: true, checkpoints: ['a.safetensors'], loras: ['x'], current: { checkpoint: 'a.safetensors' } }),
      generate: async () => { const p = path.join(TMP, 'pic.png'); fs.writeFileSync(p, 'x'); fs.writeFileSync(path.join(TMP, 'pic.json'), '{}'); return { ok: true, images: [{ path: p, json: path.join(TMP, 'pic.json'), seed: 5 }] }; },
      cancel: () => {}, locks: () => ({ ok: true, locks: [] }), chatgptStatus: () => ({ ok: true, ready: false, why: 'not signed in' }) },
    video: fakeVideo(),
    testPicture: () => FP.testPicture(320, 256), tmpDir: () => TMP,
    probeMedia: async () => ({ ok: true, duration: 1.07, width: 640, height: 480 }),
    gpu: { read: async () => ({ available: true, gpus: [{ name: 'NVIDIA GeForce RTX 5070 Ti', memUsed: 9000, memTotal: 16303 }] }) },
    trailer: { dir: () => path.join(TMP, 'trailers'), record: (tl, out) => { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, 'webm'); return { done: Promise.resolve({ ok: true }), abort() {} }; }, ffmpeg: () => null, fileUrl: (p) => `file://${p}` },
    alfred: { testAi: async () => ({ ok: true, kind: 'local', message: 'My AI answers (Ollama, model qwen2.5:7b).' }), check: async () => ({ rows: [{ id: 'answers', ok: true, detail: 'Answered "OK" in 0.4 s.' }] }), toolsDry: async () => ({ picture: { ok: true }, video: { ok: true } }) },
    bridge: { info: () => ({ port: 8765 }), http: async (m, p) => (m === 'GET' ? { status: 200, json: { ok: true } } : { status: 400, json: { ok: false, error: 'NEED_PROMPT' } }) },
    saveReport: (stamp, md, json) => { saved.push({ stamp, md, json }); return { md: path.join(TMP, `media-selftest-${stamp}.md`), json: path.join(TMP, `media-selftest-${stamp}.json`) }; },
    processAlive: () => false,
  }, extra);
  return { d, saved };
}

async function main() {
  // =====================================================================
  console.log('\n== 1. the real 🎨 Images code against a fake Forge + the real FramePack with the fake runner ==');
  const models = path.join(TMP, 'Models');
  writeSafetensors(path.join(models, 'StableDiffusion', 'dreamshaper_8.safetensors'), { 'modelspec.architecture': 'stable-diffusion-v1' });
  const imagesDir = path.join(TMP, 'stuff and thing', 'images');
  const lib = L.createLibrary({ storePath: path.join(TMP, 'sd-library.json'), env: {}, findStabilityMatrix: () => [{ models }] });
  lib.scan();
  const studio = createSdStudio({ imageProvider: ip, library: lib, imagesDir: () => imagesDir, recordImage: () => {}, persist: () => {}, log: () => {}, fileUrl: (p) => `file://${p}` });
  const forge = await fakeA1111({ flavor: 'forge' });
  await studio.connect(forge.base);
  // FramePack: a fake folder + its models + the fake runner (no GPU, no torch)
  const fpDir = F.makeFramePackDir(path.join(TMP, 'SM', 'Data', 'Packages', 'FramePack'));
  F.makeHfCache(path.join(fpDir, 'hf_download'));
  Object.assign(process.env, F.runnerEnv({ stepMs: 5, loadMs: 30 }));
  const fp = FP.createFramePack({ find: () => FP.findFramePack({ dir: fpDir, smPackages: () => [] }) });
  const realSd = { status: () => studio.status(), lists: () => studio.lists(), modelCheck: () => studio.modelCheck(), generate: (r) => studio.generate(r, 'media-selftest'), cancel: () => studio.cancel(), locks: () => lib.listLocks(), chatgptStatus: () => studio.chatgptStatus() };
  const realVideo = { fpStatus: async () => Object.assign({ available: true }, fp.status()), fpLoad: () => fp.load(), fpUnload: async () => fp.stop(), animate: async () => ({ ok: false, code: 'NOT_IN_THIS_TEST' }), cancel: async () => fp.cancel() };
  {
    const { d, saved } = baseDeps({ sd: realSd, video: realVideo, imagesDir: () => imagesDir });
    const t = MS.createMediaSelfTest(d);
    const before = forge.seen ? forge.seen.length : 0;
    const q = await t.run({ mode: 'quick' });
    assert(q.ok && q.mode === 'quick' && q.counts.fail === 0, `Quick: no ❌ (${MS.summaryOf(q)})`);
    assert(byId(q, 'forge').status === 'pass' && /Forge/.test(byId(q, 'forge').detail), `Forge reachable: “${byId(q, 'forge').detail}”`);
    assert(byId(q, 'checkpoints').status === 'pass' && /picture model/.test(byId(q, 'checkpoints').detail), `checkpoints listed: “${byId(q, 'checkpoints').detail}”`);
    assert(byId(q, 'fp-found').status === 'pass' && byId(q, 'fp-python').status === 'pass' && /model files/.test(byId(q, 'fp-python').detail), `FramePack found, its Python + models: “${byId(q, 'fp-python').detail}”`);
    assert(byId(q, 'attention').status === 'skip' && /Full/.test(byId(q, 'attention').detail), 'Quick: the attention kernel is only known after loading (skipped, says Full)');
    assert(!q.steps.some((s) => ['picture', 'fp-load', 'clip', 'trailer', 'stop-works', 'unload'].includes(s.id)), 'Quick renders nothing (no picture / load / clip / trailer steps)');
    assert(!(forge.state.lastTxt2img), 'Quick: Forge was never asked to draw');
    assert(!fp.status().running, 'Quick: FramePack was not started');
    assert(saved.length === 1 && /^\d{8}-\d{6}$/.test(saved[0].stamp) && /# 🩺 AutoInjector — pictures & video self-test \(Quick\)/.test(saved[0].md) && JSON.parse(saved[0].json).kind === 'media-selftest', 'the report is saved as Markdown + JSON (media-selftest-<stamp>)');
    void before;

    const f = await t.run({ mode: 'full' });
    const pic = byId(f, 'picture');
    assert(pic.status === 'pass' && /stuff and thing\/images/.test(pic.detail) && /settings file/.test(pic.detail), `Full: one tiny picture saved with its settings file: “${pic.detail}”`);
    const tx = forge.state.lastTxt2img || {};
    assert(tx.width === 512 && tx.height === 512 && tx.steps === 6 && (tx.batch_size || 1) === 1, `the picture is the tiny one: ${tx.width}×${tx.height}, ${tx.steps} steps`);
    assert(fs.existsSync(pic.data.path) && fs.existsSync(pic.data.json) && pic.data.path.startsWith(imagesDir), 'the picture and its .json sidecar are on disk in the images folder');
    const ld = byId(f, 'fp-load');
    assert(ld.status === 'pass' && /Stages: .*text encoder.* s/.test(ld.detail) && /PyTorch 2\.6\.0\+cu126 on NVIDIA GeForce RTX 3060/.test(ld.detail), `FramePack loads, with each stage's time and the PyTorch check: “${ld.detail}”`);
    assert(Array.isArray(ld.data.stages) && ld.data.stages.length >= 3 && ld.data.stages.every((s) => typeof s.seconds === 'number'), `stage times kept in the JSON (${ld.data.stages.length} stages)`);
    const at = byId(f, 'attention');
    assert(at.status === 'pass' && /Uses pytorch-sdpa/.test(at.detail) && /xformers/.test(at.detail), `the attention kernel (new 'attention' event → status.attention): “${at.detail}”`);
    assert(byId(f, 'clip').status === 'fail' && /NOT_IN_THIS_TEST/.test(byId(f, 'clip').error), 'a failing clip is reported with its exact error…');
    assert(byId(f, 'playable').status === 'skip' && /needs/.test(byId(f, 'playable').detail) && byId(f, 'trailer').status === 'skip', '…the steps that need the clip are skipped with the reason…');
    assert(byId(f, 'alfred-ai').status === 'pass' && byId(f, 'image-routes').status === 'pass', '…and the run goes on to Alfred and Akọwe');
    const ul = byId(f, 'unload');
    assert(ul.status === 'pass' && /no FramePack Python left running/.test(ul.detail) && !fp.status().running, `cleanup: FramePack unloaded, no runner left: “${ul.detail}”`);
    assert(f.steps.map((s) => s.id).join(',') === t._plan('full', { unload: true }).map((s) => s.id).join(','), 'every step of the Full plan is in the report, in order');
  }
  forge.close && forge.close();

  // =====================================================================
  console.log('\n== 2. a failing step is reported and the run goes on ==');
  {
    const { d } = baseDeps();
    d.sd.generate = async () => ({ ok: false, error: 'SD_OOM', code: 'SD_OOM', message: 'Your graphics card ran out of memory.', fix: 'Use a smaller size.' });
    const t = MS.createMediaSelfTest(d);
    const r = await t.run({ mode: 'full' });
    const p = byId(r, 'picture');
    assert(p.status === 'fail' && p.error === 'SD_OOM: Your graphics card ran out of memory.' && p.fix === 'Use a smaller size.', `❌ picture with the exact error + what to try (${p.error} → ${p.fix})`);
    assert(r.steps.length === t._plan('full', { unload: true }).length && r.steps.filter((s) => s.status === 'pass').length >= 15, `every later step still ran (${r.counts.pass} passed after the failure)`);
    assert(byId(r, 'clip').status === 'pass' && byId(r, 'playable').status === 'pass' && byId(r, 'trailer').status === 'pass' && byId(r, 'trailer-plays').status === 'pass', 'the clip, its player check and the trailer ran after the failed picture');
    assert(byId(r, 'stop-works').status === 'pass' && /Stopped .* after ⏹ Stop/.test(byId(r, 'stop-works').detail), `⏹ Stop works mid-clip: “${byId(r, 'stop-works').detail}”`);
    assert(d.video.calls.filter((c) => c.startsWith('animate')).every((c) => c === 'animate:1s:6'), `the clips are the tiny ones: 1 s, 6 steps (${d.video.calls.join(' ')})`);
    const g = byId(r, 'gpu-peak');
    assert(g.status === 'pass' && /Peak 8\.8 GB of 15\.9 GB/.test(g.detail), `graphics memory peak: “${g.detail}”`);
    assert(/## What to try/.test(r.markdown) && /### ❌ One tiny picture/.test(r.markdown) && /Exact error: `SD_OOM: Your graphics card ran out of memory.`/.test(r.markdown) && /What to try: Use a smaller size\./.test(r.markdown), 'the Markdown report has the ❌ with its exact error and what to try');
    assert(/\| ❌ \| 🎨 Pictures — One tiny picture/.test(r.markdown) && /\| ✅ \| 🎬 Video \(FramePack\) — The clip really plays/.test(r.markdown), 'the table: icon, group, step, result, time');
    assert(/1 ❌/.test(r.summary) && /Full/.test(r.summary), `summary line: ${r.summary}`);
  }

  // =====================================================================
  console.log('\n== 3. a step that never answers hits its time limit ==');
  {
    const { d } = baseDeps({ video: fakeVideo({ loadHang: true }), timeouts: { 'fp-load': 300 } });
    const t = MS.createMediaSelfTest(d);
    const t0 = Date.now();
    const r = await t.run({ mode: 'full' });
    const l = byId(r, 'fp-load');
    assert(l.status === 'fail' && l.error === 'STEP_TIMEOUT' && /No answer within/.test(l.detail), `a hung load → ❌ STEP_TIMEOUT (“${l.detail}”)`);
    assert(d.video.calls.includes('cancel'), 'the hung step\'s own stop (video cancel) was called');
    assert(byId(r, 'clip').status === 'skip' && byId(r, 'bridge').status === 'pass' && Date.now() - t0 < 15000, 'the run did not hang: dependent steps skipped, the rest ran');
  }

  // =====================================================================
  console.log('\n== 4. ⏹ Stop in the middle of a step ==');
  {
    const { d, saved } = baseDeps({ video: fakeVideo({ clipHang: true }) });
    const t = MS.createMediaSelfTest(d);
    const states = []; d.onProgress = (s) => states.push(s);
    const t2 = MS.createMediaSelfTest(d);
    const p = t2.run({ mode: 'full' });
    for (let i = 0; i < 100 && !(t2.status().current && t2.status().current.id === 'clip'); i++) await sleep(20);
    assert(t2.status().running && t2.status().current.id === 'clip', 'running: the clip step is the current one');
    const c0 = Date.now();
    const st = t2.cancel();
    const r = await p;
    assert(st.ok && st.cancelled && Date.now() - c0 < 1500, `⏹ Stop ends the run at once (${Date.now() - c0} ms)`);
    assert(byId(r, 'clip').status === 'skip' && /Stopped by you during this step/.test(byId(r, 'clip').detail), 'the running step: ⏭ stopped by you');
    assert(d.video.calls.includes('cancel'), 'the clip itself was told to stop (video cancel)');
    assert(r.stopped && r.steps.slice(r.steps.findIndex((s) => s.id === 'clip') + 1).every((s) => s.status === 'skip' && /Stop/.test(s.detail)), 'every later step: not run — you pressed Stop');
    assert(saved.length === 1 && /stopped by you/.test(saved[0].md), 'the report is still written, and says it was stopped');
    assert(!t2.status().running && t2.cancel().cancelled === false, 'not running afterwards; Stop again does nothing');
    assert(states.some((s) => s.running && s.current) && states.some((s) => s.stopping), 'progress was told (steps, current step, stopping)');
    void t;
  }

  // =====================================================================
  console.log('\n== 5. the report: redaction, busy, options ==');
  {
    const home = os.homedir();
    const { d, saved } = baseDeps();
    d.sd.lists = async () => ({ ok: false, error: 'ECONNREFUSED', message: `could not read ${path.join(home, 'secret-project', 'forge.log')}` });
    d.redact = (text) => logExtract.redact(text, { home, appDirs: [] }).text;
    d.bridge.info = () => null;
    d.alfred.testAi = async () => ({ ok: false, error: 'OFF' });
    const t = MS.createMediaSelfTest(d);
    const p = t.run({ mode: 'quick' });
    const busy = await t.run({ mode: 'quick' });
    assert(busy.ok === false && busy.error === 'BUSY', 'a second run while one is going → BUSY');
    const r = await p;
    assert(byId(r, 'forge').status === 'fail' && /did not answer/.test(byId(r, 'forge').detail) && /ECONNREFUSED/.test(byId(r, 'forge').error), 'Forge set but not answering → ❌ with the exact error');
    assert(byId(r, 'checkpoints').status === 'skip' && byId(r, 'loras').status === 'skip', 'the steps that need Forge are skipped with the reason');
    assert(!saved[0].md.includes(home) && !saved[0].json.includes(home) && /secret-project/.test(saved[0].md) === false, 'no private paths in the saved report (redacted like 📋 Extract)');
    assert(byId(r, 'bridge').status === 'warn' && byId(r, 'image-routes').status === 'skip', 'the bridge switched off → ⚠️, its routes skipped');
    assert(byId(r, 'alfred-ai').status === 'warn' && /switched off/.test(byId(r, 'alfred-ai').detail), 'Alfred off → ⚠️ in plain words');
    const plan = t._plan('full', { chatgptPicture: true, unload: false }).map((s) => s.id);
    assert(plan.includes('chatgpt-picture') && !plan.includes('unload') && !t._plan('full', { unload: true }).map((s) => s.id).includes('chatgpt-picture'), 'a ChatGPT picture only when ticked; unloading can be turned off');
    // a step that throws is a ❌, not a crash
    const { d: d2 } = baseDeps();
    d2.sd.locks = () => { throw new Error('boom'); };
    const r2 = await MS.createMediaSelfTest(d2).run({ mode: 'quick' });
    assert(byId(r2, 'locks').status === 'fail' && byId(r2, 'locks').error === 'boom' && byId(r2, 'chatgpt').status === 'warn', 'a check that throws → ❌ with the error, the next step still runs');
    // the routes: missing → ❌ says which
    const { d: d3 } = baseDeps();
    d3.bridge.http = async (m, pth) => (m === 'GET' ? { status: 200 } : pth === '/image/locks' ? { status: 404, json: { error: 'NOT_FOUND' } } : { status: 400, json: { error: 'NEED_PROMPT' } });
    const r3 = await MS.createMediaSelfTest(d3).run({ mode: 'quick' });
    assert(byId(r3, 'image-routes').status === 'fail' && /POST \/image\/request: ✔ answers/.test(byId(r3, 'image-routes').detail) && /POST \/image\/locks: ✖ missing \(HTTP 404\)/.test(byId(r3, 'image-routes').detail), `Akọwe routes: “${byId(r3, 'image-routes').detail}”`);
    // 📋 Extract carries the latest self-test summary (redacted like the rest of the extract)
    const ex = logExtract.buildExtract({ scope: 'time', preset: 'day', transcript: [], log: [], redaction: { home, appDirs: [] },
      appendix: [{ title: 'LATEST 🩺 PICTURES & VIDEO SELF-TEST', text: `${r.summary}\n  Full report: ${path.join(home, 'x', 'media-selftest.md')}` }] });
    assert(/LATEST 🩺 PICTURES & VIDEO SELF-TEST/.test(ex.text) && ex.text.includes(r.summary) && !ex.text.includes(home), '📋 Extract includes the latest self-test summary, with private paths hidden');
    // no deps at all: everything is "not part of this build", nothing throws
    const r4 = await MS.createMediaSelfTest({}).run({ mode: 'full' });
    assert(r4.ok && r4.counts.fail === 0 && r4.steps.every((s) => s.status === 'skip'), 'no services wired: every step is skipped, nothing breaks');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
