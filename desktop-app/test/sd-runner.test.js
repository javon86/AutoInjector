// test/sd-runner.test.js — Stable Diffusion that installs and runs from inside
// AutoInjector: Stability Matrix package discovery, launch commands (--api,
// --port, the package's own launch options), the managed process (health wait,
// reuse, crash → restart with backoff, stop), log redaction, the GPU check, and
// the ComfyUI portable installer (disk check, resumable download with size +
// SHA-256 check, cancel, extract, never overwriting user files, starter model) —
// all against fake processes and a fake download server. Nothing real is
// downloaded. Run: node test/sd-runner.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const R = require('../sd-runner');
const I = require('../sd-installer');
const { freePort, fakeA1111 } = require('./fixtures/fake-sd');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAKE = path.join(__dirname, 'fixtures', 'fake-sd-proc.js');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdrun-'));

  console.log('\n== Stability Matrix packages ==');
  const lib = path.join(tmp, 'SM', 'Data');
  const mkPkg = (folder, files) => { const d = path.join(lib, 'Packages', folder); for (const f of files) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), ''); } return d; };
  const forgeDir = mkPkg('Stable Diffusion WebUI Forge', ['launch.py', 'modules_forge/x.py', 'venv/bin/python', 'venv/Scripts/python.exe']);
  const comfyDir = mkPkg('ComfyUI', ['main.py', 'comfy/x.py', 'venv/bin/python']);
  mkPkg('Fooocus', ['entry_with_update.py']);
  mkPkg('mystery-webui', ['launch.py', 'modules/x.py']);
  fs.mkdirSync(path.join(lib, 'Models'), { recursive: true });
  fs.writeFileSync(path.join(lib, 'settings.json'), JSON.stringify({ InstalledPackages: [
    { Id: 'aaa', DisplayName: 'Forge', PackageName: 'stable-diffusion-webui-forge', LibraryPath: 'Packages\\Stable Diffusion WebUI Forge'.replace(/\\/g, path.sep), LaunchCommand: 'launch.py', LaunchArgs: [{ Name: '--xformers', Type: 'Bool', OptionValue: true }, { Name: '--api', OptionValue: true }, { Name: '--port', OptionValue: '9999' }, { Name: '--device-id', OptionValue: '1' }, { Name: '--medvram', OptionValue: false }] },
    { Id: 'bbb', DisplayName: 'ComfyUI', PackageName: 'ComfyUI', LibraryPath: 'Packages' + path.sep + 'ComfyUI', LaunchCommand: 'main.py', LaunchArgs: [] },
  ] }));
  const pk = R.findSmPackages({ findStabilityMatrix: () => [{ library: lib, models: path.join(lib, 'Models') }], platform: 'linux' });
  const byKind = (k) => pk.find((p) => p.kind === k);
  assert(pk.length === 4, `four packages found (settings.json + the Packages folder) (${pk.map((p) => p.kind).join(',')})`);
  assert(byKind('forge').displayName === 'Forge' && byKind('forge').python === path.join(forgeDir, 'venv', 'bin', 'python') && byKind('forge').supported, 'Forge: name, its own venv Python, supported');
  assert(byKind('forge').extraArgs.join(' ') === '--xformers --device-id 1', 'Stability Matrix launch options are kept (--port/--api/false flags dropped — AutoInjector sets those)');
  assert(byKind('comfy').launchCommand === 'main.py' && byKind('fooocus').supported === false, 'ComfyUI → main.py; Fooocus listed but not supported');
  assert(byKind('a1111') && byKind('a1111').displayName === 'mystery-webui', 'an unlisted folder with launch.py + modules/ is recognised as an A1111-type WebUI');
  const spec = R.launchSpec(byKind('forge'), 7861);
  assert(spec.cmd === byKind('forge').python && spec.args.join(' ') === 'launch.py --xformers --device-id 1 --api --port 7861' && spec.cwd === forgeDir, 'Forge is launched as: venv python launch.py <its options> --api --port N');
  const cspec = R.launchSpec(byKind('comfy'), 8188);
  assert(cspec.args.join(' ') === 'main.py --port 8188' && !cspec.args.includes('--api'), 'ComfyUI is launched as: venv python main.py --port 8188 (no --api needed)');
  const pspec = R.launchSpec({ supported: true, portable: true, kind: 'comfy', python: 'C:\\x\\python_embeded\\python.exe', launchCommand: 'ComfyUI\\main.py', dir: 'C:\\x' }, 8188, { cpu: true });
  assert(pspec.args.join(' ') === '-s ComfyUI\\main.py --windows-standalone-build --port 8188 --cpu', 'the ComfyUI portable runs like its run_*.bat (--windows-standalone-build), --cpu without a GPU');
  assert(R.launchSpec(byKind('fooocus'), 1) === null, 'no launch for unsupported packages');
  assert(R.redact('url?token=abc123 Bearer xyz.987 hf_abcdefghijklmnop --api-auth user:pass') === 'url?token=*** Bearer *** hf_*** --api-auth ***', 'log lines are scrubbed of tokens and passwords');

  console.log('\n== "stuff and thing" model folders on the command line (only the options each package knows) ==');
  {
    const src = (dir, files) => { for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), body); } return dir; };
    const argsPy = (names) => names.map((n) => `parser.add_argument("${n}", type=str, default=None)`).join('\n') + '\n';
    // A1111 (modules/cmd_args.py + built-in Lora / ScuNET extension preloads), as on GitHub
    const a1 = src(path.join(tmp, 'pk-a1111'), { 'modules/cmd_args.py': argsPy(['--ckpt-dir', '--vae-dir', '--embeddings-dir', '--esrgan-models-path', '--codeformer-models-path', '--gfpgan-models-path']),
      'extensions-builtin/Lora/preload.py': 'def preload(parser):\n    parser.add_argument("--lora-dir", type=str)\n    parser.add_argument(\n        "--lyco-dir-backcompat", type=str)\n',
      'extensions/sd-webui-controlnet/preload.py': 'def preload(parser):\n    parser.add_argument("--controlnet-dir", type=str)\n' });
    // Forge Neo: --ckpt-dirs / --lora-dirs / --vae-dirs / --text-encoder-dirs (append), no --lyco-dir; modules_forge/shared.py
    // adds --controlnet-dir(s) to a PRE-parser only — never passed.
    const neo = src(path.join(tmp, 'pk-neo'), { 'modules/cmd_args.py': argsPy(['--ckpt-dirs', '--lora-dirs', '--vae-dirs', '--text-encoder-dirs', '--embeddings-dir', '--esrgan-models-path']),
      'modules_forge/shared.py': 'parser.add_argument(\n    "--controlnet-dir",\n)\nparser.add_argument("--controlnet-dirs", action="append")\n' });
    const sdn = src(path.join(tmp, 'pk-sdnext'), { 'modules/cmd_args.py': "    p.add_argument(\"--models-dir\", type=str)\n    p.add_argument(\"--lora-dir\", type=str)\n    p.add_argument('--vae-dir', type=str)\n    p.add_argument(\"--embeddings-dir\", type=str)\n" });
    assert(R.acceptedArgs(a1).has('--lyco-dir-backcompat') && R.acceptedArgs(a1).has('--controlnet-dir') && R.acceptedArgs(path.join(tmp, 'nothing-here')) === null, 'acceptedArgs reads cmd_args.py + extension preloads (multi-line too); no source → null');
    fs.writeFileSync(path.join(a1, 'config.json'), JSON.stringify({ disabled_extensions: ['sd-webui-controlnet'] }));
    assert(!R.acceptedArgs(a1).has('--controlnet-dir'), 'a disabled extension\'s options are not counted (A1111 would refuse them)');
    fs.unlinkSync(path.join(a1, 'config.json'));
    assert(!R.acceptedArgs(neo).has('--controlnet-dir'), 'Forge Neo: modules_forge/shared.py is not read (its --controlnet-dir is not on the strict parser)');
    const M = path.join(tmp, 'stuff and thing', 'models');
    const dirs = { image: path.join(M, 'image'), diffusion_models: path.join(M, 'diffusion_models'), loras: path.join(M, 'loras'), lycoris: path.join(M, 'loras', 'lycoris'), vae: path.join(M, 'vae'), embeddings: path.join(M, 'embeddings'), controlnet: path.join(M, 'controlnet'), text_encoders: path.join(M, 'text_encoders'), upscale: path.join(M, 'upscale'), faces: path.join(M, 'faces'), ultralytics_bbox: path.join(M, 'detectors', 'ultralytics', 'bbox') };
    fs.mkdirSync(dirs.faces, { recursive: true }); fs.writeFileSync(path.join(dirs.faces, 'inswapper_128.onnx'), 'x'); fs.writeFileSync(path.join(dirs.faces, 'codeformer-v0.1.0.pth'), 'x');
    const T = (kind, dir, extraArgs) => ({ id: 'x', kind, label: kind, supported: true, python: '/py', launchCommand: 'launch.py', dir, extraArgs: extraArgs || [] });
    const pairs = (args) => { const o = {}; for (let i = 0; i < args.length; i++) if (/^--/.test(args[i]) && args[i + 1] && !/^--/.test(args[i + 1])) (o[args[i]] = o[args[i]] || []).push(args[i + 1]); return o; };
    let p = pairs(R.launchSpec(T('a1111', a1), 7860, { modelDirs: dirs }).args);
    assert(p['--ckpt-dir'][0] === dirs.image && p['--lora-dir'][0] === dirs.loras && p['--vae-dir'][0] === dirs.vae && p['--embeddings-dir'][0] === dirs.embeddings && p['--controlnet-dir'][0] === dirs.controlnet && p['--esrgan-models-path'][0] === dirs.upscale && p['--codeformer-models-path'][0] === dirs.faces, `A1111: ${Object.keys(p).join(' ')}`);
    assert(!p['--lyco-dir-backcompat'] && !p['--gfpgan-models-path'] && !p['--text-encoder-dir'] && !p['--ckpt-dirs'] && p['--ckpt-dir'].length === 1, 'A1111: no option it lacks (text encoders), LyCORIS found inside --lora-dir, GFPGAN only when such a file is there, the diffusion_models folder is not crammed into --ckpt-dir');
    p = pairs(R.launchSpec(T('a1111', a1), 7860, { modelDirs: { lycoris: dirs.lycoris } }).args);
    assert(p['--lyco-dir-backcompat'] && p['--lyco-dir-backcompat'][0] === dirs.lycoris, 'A1111: LyCORIS alone (no LoRAs) → --lyco-dir-backcompat');
    p = pairs(R.launchSpec(T('forge', neo), 7860, { modelDirs: dirs }).args);
    assert(p['--ckpt-dirs'].join('|') === `${dirs.image}|${dirs.diffusion_models}` && p['--lora-dirs'][0] === dirs.loras && p['--vae-dirs'][0] === dirs.vae && p['--text-encoder-dirs'][0] === dirs.text_encoders && p['--embeddings-dir'][0] === dirs.embeddings && p['--esrgan-models-path'][0] === dirs.upscale, `Forge Neo: ${Object.keys(p).join(' ')}`);
    assert(!p['--ckpt-dir'] && !p['--lora-dir'] && !p['--controlnet-dir'] && !p['--controlnet-dirs'] && !p['--codeformer-models-path'], 'Forge Neo: only its own (…-dirs) names — never one it would refuse');
    p = pairs(R.launchSpec(T('sdnext', sdn), 7860, { modelDirs: dirs }).args);
    assert(p['--lora-dir'] && p['--vae-dir'] && p['--embeddings-dir'] && !p['--ckpt-dir'] && !p['--models-dir'], 'SD.Next: LoRA / VAE / embeddings folders; it has no checkpoint-folder option, so none is passed');
    const own = R.launchSpec(T('forge', neo, ['--ckpt-dirs', 'D:\\mine', '--xformers']), 7860, { modelDirs: dirs }).args;
    assert(own.filter((a) => a === '--ckpt-dirs').length === 1 && own.includes('D:\\mine') && own.includes('--lora-dirs'), 'the user\'s own --ckpt-dirs wins (stuff and thing checkpoints are left out), the rest is still added');
    assert(R.launchSpec(T('comfy', a1), 8188, { modelDirs: dirs }).args.join(' ') === 'launch.py --port 8188', 'ComfyUI gets no command-line folders (it reads extra_model_paths.yaml)');
    p = pairs(R.launchSpec(T('forge', path.join(tmp, 'pk-unreadable')), 7860, { modelDirs: dirs }).args);
    assert(Object.keys(p).sort().join(' ') === '--ckpt-dir --embeddings-dir --lora-dir --port --vae-dir', `source unreadable → only the long-standing options (${Object.keys(p).join(' ')})`);
    p = pairs(R.launchSpec(T('forge', neo), 7860, { modelDirs: { loras: dirs.loras }, ckptDir: 'C:\\SM\\Data\\Models\\StableDiffusion' }).args);
    assert(p['--ckpt-dirs'][0] === 'C:\\SM\\Data\\Models\\StableDiffusion', 'no checkpoints in "stuff and thing": the library\'s folder (ckptDir) is used, under the package\'s own name');
  }

  console.log('\n== ComfyUI: the "autoinjector_stuff:" section in extra_model_paths.yaml ==');
  {
    const cdir = path.join(tmp, 'SMComfy'); fs.mkdirSync(cdir, { recursive: true });
    const yf = path.join(cdir, 'extra_model_paths.yaml');
    const theirs = 'stability_matrix:\n  base_path: C:/SM/Data/Models\n  checkpoints: StableDiffusion\n  loras: |\n    Lora\n    LyCORIS\n\n# my own folders\nmine:\n  base_path: D:/models\n  checkpoints: ckpt/\n';
    fs.writeFileSync(yf, theirs);
    const stuffM = 'C:\\Users\\javon\\AutoInjector\\stuff and thing\\models';
    let w = I.writeExtraModelPaths(cdir, stuffM);
    let y = fs.readFileSync(yf, 'utf8');
    assert(w.ok && w.changed && y.startsWith(theirs.trimEnd()) && /\nautoinjector_stuff:\n  base_path: "C:\/Users\/javon\/AutoInjector\/stuff and thing\/models"\n/.test(y), 'merged: the user\'s sections (Stability Matrix + their own + the comment) kept word for word, ours added');
    for (const [k, v] of [['checkpoints', 'image/'], ['loras', 'loras/'], ['vae', 'vae/'], ['embeddings', 'embeddings/'], ['controlnet', 'controlnet/'], ['upscale_models', 'upscale/'], ['text_encoders', 'text_encoders/'], ['clip', 'text_encoders/'], ['diffusion_models', 'diffusion_models/'], ['unet', 'diffusion_models/'], ['clip_vision', 'clip_vision/'], ['ipadapter', 'ipadapter/'], ['ultralytics_bbox', 'detectors/ultralytics/bbox/'], ['ultralytics_segm', 'detectors/ultralytics/segm/'], ['sams', 'detectors/sams/'], ['insightface', 'faces/']]) assert(new RegExp(`\\n  ${k}: ${v.replace(/\//g, '\\/')}\\n`).test(y.slice(y.indexOf('autoinjector_stuff:'))), `autoinjector_stuff maps ${k} → ${v}`);
    assert(fs.readFileSync(yf + '.autoinjector-backup', 'utf8') === theirs, 'the original file is backed up once');
    w = I.writeExtraModelPaths(cdir, stuffM);
    assert(w.ok && !w.changed && fs.readFileSync(yf, 'utf8') === y, 'written again: nothing changes (no second section)');
    w = I.writeExtraModelPaths(cdir, 'E:\\moved\\stuff and thing\\models');
    y = fs.readFileSync(yf, 'utf8');
    assert(w.changed && (y.match(/autoinjector_stuff:/g) || []).length === 1 && /E:\/moved/.test(y) && !/C:\/Users\/javon/.test(y) && y.startsWith(theirs.trimEnd()), 'the folder moved: our ONE section is updated in place, theirs untouched');
    const fresh = path.join(tmp, 'FreshComfy'); fs.mkdirSync(fresh, { recursive: true });
    w = I.writeExtraModelPaths(fresh, stuffM);
    assert(w.ok && w.created && /^# Written by AutoInjector/.test(fs.readFileSync(path.join(fresh, 'extra_model_paths.yaml'), 'utf8')), 'no file yet → created with only our section');
    assert(!I.writeExtraModelPaths(path.join(tmp, 'no-comfy'), stuffM).ok, 'a missing ComfyUI folder → a plain error, nothing written');
    // a section of ours in the MIDDLE (e.g. the user moved it) is replaced without eating the next section
    fs.writeFileSync(yf, `a:\n  base_path: x\n\n${I.stuffSection('/old')}\nb:\n  base_path: y\n`);
    I.writeExtraModelPaths(cdir, '/new');
    y = fs.readFileSync(yf, 'utf8');
    assert(/^a:\n  base_path: x\n/.test(y) && /\nb:\n  base_path: y\n/.test(y) && (y.match(/autoinjector_stuff:/g) || []).length === 1 && /"\/new"/.test(y) && !/"\/old"/.test(y), 'our section in the middle: replaced, the sections around it kept');
  }

  console.log('\n== the managed process ==');
  const logFile = path.join(tmp, 'logs', 'sd.log');
  const events = []; const changes = [];
  const port = await freePort();
  const target = { id: 'test', label: 'SD WebUI Forge', kind: 'forge', supported: true, source: 'test', python: process.execPath, launchCommand: FAKE, extraArgs: ['--delay', '300'], dir: tmp };
  const r = R.createSdRunner({ logFile, logger: (k, d) => events.push([k, d]), onChange: (s) => changes.push(s.phase), healthPollMs: 100, healthTimeoutMs: 15000, backoffMs: [200, 200, 200], maxRestarts: 2, stopGraceMs: 2000 });
  let s = await r.start(target, { port });
  assert(s.phase === 'running' && s.owned && s.port === port && s.kind === 'a1111', 'start(): spawned, waited until the SD API answered, phase running (owned)');
  assert(/✔ SD WebUI Forge running on :\d+ \(managed\)/.test(s.message), `status says "${s.message}"`);
  assert(changes.includes('starting') && changes.includes('running'), 'onChange saw starting → running');
  await sleep(100);
  const log = fs.readFileSync(logFile, 'utf8');
  assert(/--api --port/.test(log) && /Running on local URL/.test(log) && !/SECRET123/.test(log) && /token=\*\*\*/.test(log), 'the log has the command and the app output, with the token hidden');
  assert(events.some(([k]) => k === 'sd-runner-start') && events.some(([k]) => k === 'sd-runner-ready'), 'short start/ready events for the app log');
  s = await r.stop();
  assert(s.phase === 'stopped' && !r.isOwnedAlive(), 'stop() ends our process');
  await sleep(200);
  assert(!(await R.portFree(port)) === false, 'the port is free again after stop');

  console.log('\n== reuse an SD app already running ==');
  const ext = await fakeA1111({ port: await freePort(), flavor: 'forge' });
  const r2 = R.createSdRunner({ healthPollMs: 100 });
  s = await r2.start(target, { port: ext.port });
  assert(s.phase === 'running' && !s.owned && /already running/.test(s.message), 'an SD app already answering on the port is used, not started twice');
  s = await r2.stop();
  const still = await fetchOk(`${ext.base}/sdapi/v1/sd-models`);
  assert(still, 'stop() leaves an SD app AutoInjector did not start running');
  await ext.close();

  console.log('\n== crash → restart with backoff → give up ==');
  const p3 = await freePort();
  const crashy = Object.assign({}, target, { extraArgs: ['--crash-after', '300'] });
  const ev3 = [];
  const r3 = R.createSdRunner({ logger: (k, d) => ev3.push([k, d]), healthPollMs: 80, healthTimeoutMs: 10000, backoffMs: [150, 150, 150], maxRestarts: 2 });
  s = await r3.start(crashy, { port: p3 });
  assert(s.phase === 'running', 'the crashy one starts');
  const t0 = Date.now();
  while (Date.now() - t0 < 12000 && r3.status().phase !== 'failed') await sleep(100);
  s = r3.status();
  assert(ev3.filter(([k]) => k === 'sd-runner-crash').length === 3 && ev3.filter(([k]) => k === 'sd-runner-start').length === 3, 'it was restarted after each crash (3 starts, 3 crashes)');
  assert(s.phase === 'failed' && s.error === 'CRASHED' && /stopped restarting/.test(s.message), 'after maxRestarts it stops trying and says so');

  console.log('\n== problems in plain words ==');
  const r4 = R.createSdRunner({});
  s = await r4.start(Object.assign({}, target, { python: path.join(tmp, 'nope', 'python') }), { port: await freePort() });
  assert(s.phase === 'failed' && s.error === 'NO_PYTHON' && /Stability Matrix/.test(s.message), 'missing venv Python → "start it once from Stability Matrix"');
  s = await R.createSdRunner({}).start(null);
  assert(s.error === 'NO_TARGET', 'nothing to start → NO_TARGET with the install hint');
  s = await R.createSdRunner({}).start({ label: 'Fooocus', supported: false });
  assert(s.error === 'UNSUPPORTED' && /Forge/.test(s.message), 'Fooocus → "add Forge or ComfyUI in Stability Matrix"');
  const r5 = R.createSdRunner({ healthPollMs: 80, healthTimeoutMs: 1200 });
  s = await r5.start(Object.assign({}, target, { extraArgs: ['--delay', '5000'] }), { port: await freePort() });
  assert(s.phase === 'failed' && s.error === 'HEALTH_TIMEOUT' && !r5.isOwnedAlive(), 'never answers → HEALTH_TIMEOUT and the process is stopped');

  console.log('\n== ComfyUI crashes on start (0xC0000005): why, safer retry, what to try ==');
  const E = require('../sd-errors');
  const { EventEmitter } = require('events');
  // A fake spawn: each start prints `lines` then exits with `code` (or stays up when code is null).
  function fakeSpawn(plan) {
    const calls = [];
    const fn = (cmd, args) => {
      const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.pid = 4000 + calls.length;
      c.kill = () => { setTimeout(() => c.emit('exit', 0, null), 5); return true; };
      const step = typeof plan === 'function' ? plan(calls.length, args) : plan;
      calls.push({ cmd, args: args.slice() });
      setTimeout(() => { for (const l of step.lines || []) c.stderr.emit('data', Buffer.from(l + '\n')); if (step.code !== null && step.code !== undefined) setTimeout(() => c.emit('exit', step.code, null), step.after || 15); }, 5);
      return c;
    };
    fn.calls = calls;
    return fn;
  }
  const HOME = 'C:\\Users\\Ada'; // a Windows home folder, as in the user's log
  const wjoin = (...a) => a.join('\\');
  const portableT = { id: 'portable:comfyui', label: 'ComfyUI', kind: 'comfy', supported: true, portable: true, source: 'AutoInjector', python: process.execPath, launchCommand: path.join('ComfyUI', 'main.py'), extraArgs: [], dir: tmp };
  const noise = Array.from({ length: 50 }, (_, i) => `loading custom node ${i} from ${wjoin(HOME, 'AppData', 'Local', 'AutoInjector', 'comfyui', 'ComfyUI', 'custom_nodes', `n${i}`)}`);
  const avLines = [...noise, `Total VRAM 12227 MB, total RAM 32535 MB  token=SECRET999`, ' 45%|████▌     | 9/20 [00:01<00:02]', 'Using pytorch attention', `Set vram state to: NORMAL_VRAM ${wjoin(HOME, 'models')}`];
  const evC = [];
  const sp = fakeSpawn({ lines: avLines, code: 3221225477 });
  const rc = R.createSdRunner({ spawn: sp, identify: async () => null, logger: (k, d) => evC.push([k, d]), healthPollMs: 10, backoffMs: [10, 10, 10], maxRestarts: 3,
    redaction: () => ({ home: HOME, appDirs: [wjoin(HOME, 'AppData', 'Local', 'AutoInjector')] }), gpu: () => ({ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 5070' }), otherBuild: () => ({ build: 'nvidia_cu126', label: 'NVIDIA (GeForce GTX 10xx and older)' }) });
  s = await rc.start(portableT, { port: await freePort() });
  const crashEv = evC.filter(([k]) => k === 'sd-runner-crash').map(([, d]) => d);
  assert(sp.calls.length === 3 && crashEv.length === 3, `crash, crash, then ONE safer restart — 3 starts, not an endless loop (${sp.calls.length} starts)`);
  assert(!sp.calls[0].args.includes('--disable-cuda-malloc') && !sp.calls[1].args.includes('--disable-cuda-malloc') && sp.calls[2].args.includes('--disable-cuda-malloc'), 'after the 2nd identical 0xC0000005 it restarts with --disable-cuda-malloc');
  assert(evC.some(([k, d]) => k === 'sd-runner-safe-mode' && d.flags.includes('--disable-cuda-malloc') && d.after === 2), 'the safer restart is logged (sd-runner-safe-mode, after crash 2)');
  assert(evC.some(([k, d]) => k === 'sd-runner-start' && d.attempt === 3 && d.flags && d.flags.includes('--disable-cuda-malloc')), 'the 3rd start logs its flags');
  const c0 = crashEv[0];
  assert(c0.code === 3221225477 && c0.hex === '0xC0000005' && c0.cause === 'ACCESS_VIOLATION', `sd-runner-crash says code + hex + cause (${c0.hex} ${c0.cause})`);
  assert(typeof c0.tail === 'string' && c0.tail.length > 0 && c0.tail.length <= 600 && /Using pytorch attention/.test(c0.tail) && /Total VRAM/.test(c0.tail), `…and the last useful lines it printed (${c0.tail.length} chars ≤ 600)`);
  assert(!c0.tail.includes('Ada') && /~\\AppData\\Local\\AutoInjector\\comfyui/.test(c0.tail) && /\[private path\]/.test(c0.tail) && !/SECRET999/.test(c0.tail) && !/45%\|/.test(c0.tail), 'the tail hides the home folder like the app\'s logs (~\\AppData\\Local\\AutoInjector…, other private paths), tokens, and drops progress bars');
  s = rc.status();
  assert(s.phase === 'failed' && s.error === 'CRASHED' && s.cause === 'ACCESS_VIOLATION' && /0xC0000005/.test(s.message) && /access violation/.test(s.message) && /safer settings/.test(s.message), `status explains it in plain words: "${s.message.slice(0, 110)}…"`);
  assert(/graphics driver/.test(s.fix) && /RTX 50/.test(s.fix) && /cu128/.test(s.fix) && /Visual C\+\+/.test(s.fix) && /processor/.test(s.fix), 'the fix: update the driver, RTX 50 needs the cu128 build, VC++ runtime, or the processor');
  assert(s.actions.some((a) => a.id === 'sd-start-cpu') && s.actions.some((a) => a.id === 'sd-other-build' && /GTX 10xx/.test(a.label)), 'it OFFERS “Start on the processor” and “Use the other ComfyUI build”…');
  assert(!sp.calls.some((x) => x.args.includes('--cpu')), '…but does not run --cpu by itself');
  assert(s.crash && /^Set vram state to: NORMAL_VRAM \[private path\]$/.test(s.crash.line) && s.message.includes(s.crash.line), `the important line is in the status (“${s.crash && s.crash.line}”)`);
  assert(s.lastOutput && s.lastOutput.length <= 600 && s.tried.length === 1, 'status carries the redacted last output and what was tried');
  // Start on the processor: --cpu, works.
  const spCpu = fakeSpawn({ code: null });
  let up = false;
  const rcpu = R.createSdRunner({ spawn: spCpu, identify: async () => (up ? { usable: true, kind: 'comfy', base: 'x', label: 'ComfyUI' } : null), healthPollMs: 10 });
  setTimeout(() => { up = true; }, 80);
  s = await rcpu.start(portableT, { port: await freePort(), cpu: true });
  assert(s.phase === 'running' && spCpu.calls.length === 1 && spCpu.calls[0].args.includes('--cpu') && s.mode === 'cpu' && /processor/.test(s.message), 'start(t, {cpu:true}) runs ComfyUI with --cpu and says so');
  await rcpu.stop();

  console.log('\n== other crashes: the 4-start cap, Python errors, the user\'s own flags ==');
  const ev4 = [];
  const sp4 = fakeSpawn({ lines: ['Traceback (most recent call last):', '  File "main.py", line 1', 'RuntimeError: CUDA error: no kernel image is available for execution on the device'], code: 1 });
  const r4b = R.createSdRunner({ spawn: sp4, identify: async () => null, logger: (k, d) => ev4.push([k, d]), healthPollMs: 10, backoffMs: [5, 5, 5], maxRestarts: 3 });
  s = await r4b.start(portableT, { port: await freePort() });
  assert(sp4.calls.length === 4 && s.phase === 'failed' && s.error === 'CRASHED' && !sp4.calls.some((x) => x.args.includes('--disable-cuda-malloc')), 'a non-access-violation crash: 4 starts at most, no safer-flags retry');
  assert(s.cause === 'WRONG_BUILD' && /no kernel image/.test(s.message) && /build/.test(s.fix), `exit 1 + "no kernel image" → the wrong ComfyUI build for this card ("${s.message.slice(0, 80)}…")`);
  const own = Object.assign({}, portableT, { extraArgs: ['--disable-cuda-malloc', '--lowvram'] });
  assert(R.safeFlagsFor(own).length === 0 && R.launchSpec(own, 8188, { safe: true }).args.join(' ') === `-s ${own.launchCommand} --windows-standalone-build --port 8188 --disable-cuda-malloc --lowvram`, 'the user\'s own launch options are kept and never doubled');
  const sp5 = fakeSpawn({ code: 3221225477 });
  const r5b = R.createSdRunner({ spawn: sp5, identify: async () => null, healthPollMs: 10, backoffMs: [5, 5, 5], maxRestarts: 3 });
  s = await r5b.start(own, { port: await freePort() });
  assert(sp5.calls.length === 4 && sp5.calls.every((x) => x.args.filter((a) => a === '--disable-cuda-malloc').length === 1), 'already on --disable-cuda-malloc: no extra retry mode, the 4-start cap holds');
  assert(R.launchSpec(Object.assign({}, portableT, { kind: 'forge', portable: false, launchCommand: 'launch.py' }), 7860, { safe: true }).args.join(' ') === 'launch.py --api --port 7860', 'safer ComfyUI flags are never given to Forge');
  // Plain-English Windows exit codes.
  let x = E.explainExit(3221225781, { label: 'ComfyUI' });
  assert(x.code === 'DLL_NOT_FOUND' && x.hex === '0xC0000135' && /Visual C\+\+ Redistributable/.test(x.fix) && /vc_redist/.test(x.fix), '0xC0000135 → a missing DLL → install the VC++ redistributable');
  x = E.explainExit(3221226505, { label: 'ComfyUI', kind: 'comfy' });
  assert(x.code === 'STACK_BUFFER_OVERRUN' && x.hex === '0xC0000409' && x.actions.some((a) => a.id === 'sd-start-cpu'), '3221226505 = 0xC0000409 → a Windows safety check (DLL / driver mismatch), offers the processor');
  x = E.explainExit(-1073741819, { label: 'ComfyUI', gpu: { vendor: 'amd', name: 'AMD Radeon RX 6600' } });
  assert(x.code === 'ACCESS_VIOLATION' && /AMD build/.test(x.fix) && /DirectML/.test(x.fix), 'a signed 0xC0000005 is read too; on an AMD card the fix names the AMD / DirectML build');
  x = E.explainExit(1, { label: 'ComfyUI', tail: 'Traceback (most recent call last):\n  File "x.py"\nModuleNotFoundError: No module named \'torchsde\'' });
  assert(x.code === 'MISSING_MODULE' && /torchsde/.test(x.message), 'exit 1 shows the Python error line (“No module named …”)');
  x = E.explainExit(1, { label: 'ComfyUI', tail: 'ValueError: something odd' });
  assert(x.code === 'PYTHON_ERROR' && /ValueError: something odd/.test(x.message), 'an unknown Python error: the line itself, plainly');
  assert(R.usefulTail(Object.assign(Array.from({ length: 40 }, (_, i) => 'x'.repeat(50) + i), { __partial: '' })).length <= 600, 'the tail never exceeds 600 chars');
  const buf = []; for (let i = 0; i < 100; i++) R.pushTail(buf, `line ${i}\n`);
  assert(buf.length === 40 && buf[39] === 'line 99', 'only the last 40 lines are kept in memory');

  console.log('\n== pressing Start again while it starts / before the install finished ==');
  const evB = [];
  const spB = fakeSpawn({ code: null });
  let upB = false;
  const rB = R.createSdRunner({ spawn: spB, identify: async () => (upB ? { usable: true, kind: 'comfy', base: 'x', label: 'ComfyUI' } : null), logger: (k, d) => evB.push([k, d]), healthPollMs: 10 });
  const pB = await freePort();
  const q1 = rB.start(portableT, { port: pB });
  await sleep(30);
  assert(rB.isBusy() && rB.status().busy, 'while starting, the runner says it is busy (the buttons show “Starting…”)');
  const q2 = rB.start(portableT, { port: pB });
  const q3 = rB.start(portableT, { port: pB });
  setTimeout(() => { upB = true; }, 60);
  const [s1, s2, s3] = await Promise.all([q1, q2, q3]);
  assert(spB.calls.length === 1 && s1.phase === 'running' && s2.phase === 'running' && s3.phase === 'running' && s2.alreadyStarting && !s1.alreadyStarting, 'Start pressed 3 times → ONE start; the extra presses get the same result ("already starting")');
  assert(evB.filter(([k]) => k === 'sd-runner-already-starting').length === 2 && evB.filter(([k]) => k === 'sd-runner-start').length === 1, 'logged as sd-runner-already-starting, not a new start');
  await rB.stop();
  // NO_PYTHON while the install is still running → waits, then starts by itself.
  const pyLater = path.join(tmp, 'later', 'python_embeded', 'python');
  const notYet = Object.assign({}, portableT, { python: pyLater });
  let installingNow = true;
  const evW = [];
  const spW = fakeSpawn({ code: null });
  let upW = false;
  const rW = R.createSdRunner({ spawn: spW, identify: async () => (upW ? { usable: true, kind: 'comfy', base: 'x', label: 'ComfyUI' } : null), logger: (k, d) => evW.push([k, d]), healthPollMs: 10,
    installing: () => installingNow, refreshTarget: (old) => Object.assign({}, old, { python: pyLater }) });
  s = await rW.start(notYet, { port: await freePort() });
  assert(s.phase === 'waiting' && s.error === 'INSTALLING' && s.message === 'ComfyUI is still being installed — it starts by itself when the install finishes.' && spW.calls.length === 0, `Start during the install: "${s.message}"`);
  s = await rW.start(notYet);
  assert(s.alreadyStarting && s.phase === 'waiting' && spW.calls.length === 0 && rW.isBusy(), 'pressing it again just says it is already waiting');
  fs.mkdirSync(path.dirname(pyLater), { recursive: true }); fs.writeFileSync(pyLater, '');
  installingNow = false;
  setTimeout(() => { upW = true; }, 50);
  s = await rW.installFinished(true);
  assert(s.phase === 'running' && spW.calls.length === 1 && evW.some(([k]) => k === 'sd-runner-wait-install') && evW.some(([k]) => k === 'sd-runner-install-done-start'), 'the install finished → it started by itself');
  await rW.stop();
  const rW2 = R.createSdRunner({ spawn: fakeSpawn({ code: null }), identify: async () => null, installing: () => true });
  await rW2.start(Object.assign({}, portableT, { python: path.join(tmp, 'nope2', 'python') }));
  s = await rW2.installFinished(false);
  assert(s.phase === 'failed' && s.error === 'INSTALL_NOT_FINISHED' && /Install/.test(s.message), 'the install stopped instead → a plain message, nothing started');
  s = await R.createSdRunner({ installing: () => false }).start(Object.assign({}, portableT, { python: path.join(tmp, 'nope3', 'python') }), { port: await freePort() });
  assert(s.error === 'NO_PYTHON' && /Install Stable Diffusion/.test(s.message) && !/Stability Matrix/.test(s.message), 'NO_PYTHON for AutoInjector\'s own ComfyUI points at ⬇ Install (not Stability Matrix)');

  console.log('\n== GPU check ==');
  let g = await I.detectGpu({ run: async (cmd) => (/nvidia-smi/.test(cmd) ? 'NVIDIA GeForce RTX 4070, 12282\n' : null) });
  assert(g.vendor === 'nvidia' && g.build === 'nvidia' && g.vramMB === 12282 && /RTX 4070/.test(g.message), 'nvidia-smi: RTX 4070 → the NVIDIA build');
  g = await I.detectGpu({ run: async (cmd) => (/nvidia-smi/.test(cmd) ? 'NVIDIA GeForce GTX 1060 6GB, 6144' : null) });
  assert(g.build === 'nvidia_cu126', 'GTX 1060 → the cu126 build for older cards');
  g = await I.detectGpu({ platform: 'win32', run: async (cmd) => (/powershell/.test(cmd) ? 'Microsoft Basic Display Adapter|0\nAMD Radeon RX 7800 XT|4293918720\n' : null) });
  assert(g.vendor === 'amd' && g.build === 'amd' && g.caution && /slower/.test(g.message), 'WMI: AMD Radeon → the AMD build, with a plain caution');
  g = await I.detectGpu({ platform: 'win32', run: async () => null });
  assert(g.vendor === 'none' && g.cpuOnly && /several minutes/.test(g.message), 'no GPU → explains CPU mode is very slow');
  assert(I.chooseBuild('nvidia', 'NVIDIA GeForce GTX 1650', 4096).build === 'nvidia' && /SD 1\.5/.test(I.chooseBuild('nvidia', 'NVIDIA GeForce GTX 1650', 4096).message), 'GTX 16xx uses the main build; low memory → start with SD 1.5');

  console.log('\n== the installer (fake download server) ==');
  // A tiny "portable" archive (tar named .7z — the real one is 7z; tar/bsdtar reads both).
  const stage = path.join(tmp, 'stage', 'ComfyUI_windows_portable');
  fs.mkdirSync(path.join(stage, 'ComfyUI', 'models', 'checkpoints'), { recursive: true });
  fs.mkdirSync(path.join(stage, 'python_embeded'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'ComfyUI', 'main.py'), 'print("comfy")');
  fs.writeFileSync(path.join(stage, 'python_embeded', 'python'), '');
  fs.writeFileSync(path.join(stage, 'README_VERY_IMPORTANT.txt'), 'x'.repeat(200000));
  const archivePath = path.join(tmp, 'stage', 'portable.tar');
  execFileSync('tar', ['-cf', archivePath, '-C', path.join(tmp, 'stage'), 'ComfyUI_windows_portable']);
  const ARCH = fs.readFileSync(archivePath);
  const ARCH_SHA = crypto.createHash('sha256').update(ARCH).digest('hex');
  const MODEL = Buffer.alloc(50000, 9);
  let hits = { archive: 0, ranges: [], dropFirst: true, badHash: false };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/latest') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ tag_name: 'v0.42.1', assets: [{ name: 'ComfyUI_windows_portable_nvidia.7z', size: ARCH.length, digest: `sha256:${hits.badHash ? '0'.repeat(64) : ARCH_SHA}`, browser_download_url: `http://127.0.0.1:${srv.address().port}/redirect` }] })); }
    if (u.pathname === '/redirect') { res.writeHead(302, { Location: '/files/portable.7z' }); return res.end(); }
    if (u.pathname.startsWith('/files/') || u.pathname === '/model.safetensors') {
      const buf = u.pathname === '/model.safetensors' ? MODEL : ARCH;
      if (u.pathname !== '/model.safetensors') hits.archive++;
      const m = /bytes=(\d+)-/.exec(req.headers.range || '');
      const start = m ? Number(m[1]) : 0;
      hits.ranges.push(start);
      const body = buf.subarray(start);
      res.writeHead(m ? 206 : 200, { 'Content-Length': body.length, 'Content-Type': 'application/octet-stream' });
      if (hits.dropFirst && u.pathname !== '/model.safetensors') { hits.dropFirst = false; res.write(body.subarray(0, 100000)); return setTimeout(() => res.destroy(), 50); }
      return res.end(body);
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const B = `http://127.0.0.1:${srv.address().port}`;
  const home = path.join(tmp, 'LocalAppData', 'AutoInjector', 'comfyui');
  const progress = [];
  const inst = I.createInstaller({ home, allowAnyPlatform: true, sevenZip: null, tar: 'tar', run: async (cmd) => (/nvidia-smi/.test(cmd) ? 'NVIDIA GeForce RTX 3060, 12288' : null),
    urls: { githubApi: `${B}/api/latest`, downloadBase: `${B}/files/` }, models: { sd15: { id: 'sd15', label: 'test model', file: 'tiny.safetensors', url: `${B}/model.safetensors`, approxBytes: 50000, base: 'SD1.5' } },
    onChange: (st) => progress.push(st), retry: { maxTries: 1 } }); // automatic retries off here: this checks the press-Install-again resume (video.test.js checks the automatic one)
  const chk = await inst.check();
  assert(chk.ok && chk.gpu.build === 'nvidia' && !chk.installed && chk.needBytes > 4 * 1024 ** 3 && typeof chk.freeBytes === 'number' && /4 GB for ComfyUI plus 2–7 GB per model/.test(chk.spaceMessage), 'check(): GPU, free space vs. what is needed (in plain words), not installed yet');
  const noWin = await I.createInstaller({ home, platform: 'linux' }).install();
  assert(!noWin.ok && noWin.error === 'NOT_WINDOWS', 'the one-click install is Windows-only; elsewhere it explains what to do');
  // 1st try: the connection drops mid-way → partial kept.
  let res1 = await inst.install({ ignoreSpace: true });
  assert(!res1.ok && fs.existsSync(path.join(home, 'ComfyUI_windows_portable_nvidia.7z.part')), 'a dropped download keeps its .part file');
  assert(/continues where it stopped|incomplete/.test(res1.message), `…and says Install continues where it stopped ("${res1.message}")`);
  const partSize = fs.statSync(path.join(home, 'ComfyUI_windows_portable_nvidia.7z.part')).size;
  // 2nd try: resumes with a Range request, verifies size + SHA-256, extracts.
  const res2 = await inst.install({ ignoreSpace: true });
  assert(res2.ok && res2.verified && hits.ranges.includes(partSize), `resumed from byte ${partSize} (HTTP Range) and the SHA-256 matched GitHub's`);
  assert(res2.portable && fs.existsSync(path.join(res2.portable.comfy, 'main.py')) && res2.portable.models === path.join(home, 'ComfyUI_windows_portable', 'ComfyUI', 'models'), 'unpacked: ComfyUI/main.py and its models folder are found');
  assert(!fs.existsSync(path.join(home, 'ComfyUI_windows_portable_nvidia.7z')) && !fs.existsSync(path.join(home, 'ComfyUI_windows_portable_nvidia.7z.part')), 'our own downloaded archive is removed after unpacking');
  assert(progress.some((p) => p.phase === 'downloading' && p.total === ARCH.length) && progress.some((p) => p.phase === 'extracting'), 'progress reported: downloading (with total size) → extracting');
  const res3 = await inst.install();
  assert(res3.ok && res3.already && hits.archive === 2, 'installing again reuses the existing install (nothing downloaded or overwritten)');
  const userFile = path.join(res2.portable.comfy, 'models', 'checkpoints', 'my_own.safetensors');
  fs.writeFileSync(userFile, 'mine');
  const m1 = await inst.downloadModel('sd15');
  assert(m1.ok && fs.readFileSync(m1.file).length === 50000 && /checkpoints/.test(m1.file), 'starter checkpoint downloaded into ComfyUI/models/checkpoints');
  assert(fs.readFileSync(userFile, 'utf8') === 'mine', 'the user\'s own model file is untouched');
  const tgs = R.targets({ findStabilityMatrix: () => [], portableHome: home });
  assert(tgs.length === 1 && tgs[0].portable && tgs[0].kind === 'comfy' && tgs[0].models === res2.portable.models, 'the installed portable shows up as a startable target (and its models folder for the library)');
  assert(I.readBuilds(home).active === 'nvidia' && inst.currentBuild() === 'nvidia' && /NVIDIA \(GeForce RTX 20xx and newer\) build/.test(tgs[0].displayName), 'the install remembers which build it is (shown in “What to start”)');

  console.log('\n== “Use the other ComfyUI build” ==');
  let ob = inst.otherBuild();
  assert(ob && ob.build === 'nvidia_cu126' && !ob.installed, 'the NVIDIA build → the other one to try is cu126 (not installed yet)');
  const firstModels = res2.portable.models;
  const sw = await inst.useOtherBuild({ ignoreSpace: true });
  const altRoot = path.join(home, 'build-nvidia_cu126', 'ComfyUI_windows_portable');
  assert(sw.ok && sw.build === 'nvidia_cu126' && fs.existsSync(path.join(altRoot, 'ComfyUI', 'main.py')), 'it is downloaded next to the first one (build-nvidia_cu126), the first install is untouched');
  assert(fs.existsSync(path.join(firstModels, 'checkpoints', 'my_own.safetensors')), 'the user\'s models in the first install are still there');
  const yaml = fs.readFileSync(path.join(altRoot, 'ComfyUI', 'extra_model_paths.yaml'), 'utf8');
  assert(yaml.includes(firstModels.replace(/\\/g, '/')) && /checkpoints: checkpoints\//.test(yaml) && /loras: loras\//.test(yaml), 'the new ComfyUI reads the first one\'s models (extra_model_paths.yaml) — nothing is downloaded twice');
  let pnow = inst.portable();
  assert(pnow.root === altRoot && pnow.build === 'nvidia_cu126' && pnow.models === firstModels, 'the other build is now the one that starts; models still go to the first folder');
  const tgs2 = R.targets({ findStabilityMatrix: () => [], portableHome: home });
  assert(tgs2.length === 1 && tgs2[0].dir === altRoot && /GTX 10xx/.test(tgs2[0].displayName), 'the runner\'s target is the other build');
  ob = inst.otherBuild();
  assert(ob && ob.build === 'nvidia' && ob.installed, 'and back again needs no download');
  const back = await inst.useOtherBuild();
  assert(back.ok && back.switched && inst.portable().root === res2.portable.root && hits.archive === 3, 'switching back is instant (no third download)');
  assert(I.createInstaller({ home: path.join(tmp, 'none') }).otherBuild() === null, 'nothing installed → no other build offered');
  const amdInst = I.createInstaller({ home, platform: 'win32', allowAnyPlatform: true, run: async (cmd) => (/powershell/.test(cmd) ? 'AMD Radeon RX 6600|4293918720' : null) });
  await amdInst.check();
  assert(amdInst.otherBuild() && amdInst.otherBuild().build === 'amd', 'an NVIDIA build on an AMD card → the AMD build is the one to try');



  console.log('\n== download edge cases ==');
  const dest = path.join(tmp, 'dl', 'x.bin');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, 'someone else\'s file');
  let d = await I.download(`${B}/model.safetensors`, dest, { expectedSize: 50000 });
  assert(!d.ok && d.error === 'EXISTS' && fs.readFileSync(dest, 'utf8') === 'someone else\'s file', 'a different file already at the target is never overwritten');
  hits.badHash = true;
  const home2 = path.join(tmp, 'h2');
  const inst2 = I.createInstaller({ home: home2, allowAnyPlatform: true, sevenZip: null, tar: 'tar', run: async () => 'NVIDIA GeForce RTX 3060, 12288', urls: { githubApi: `${B}/api/latest`, downloadBase: `${B}/files/` } });
  d = await inst2.install({ ignoreSpace: true });
  assert(!d.ok && d.error === 'HASH_MISMATCH' && fs.existsSync(path.join(home2, 'ComfyUI_windows_portable_nvidia.7z.bad')), 'a checksum mismatch is caught; the bad file is set aside, not used');
  hits.badHash = false;
  // Cancel: a slow server, cancel mid-way → paused, .part kept.
  const slowSrv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Length': 1000000 }); let n = 0; const iv = setInterval(() => { if (n++ > 200) { clearInterval(iv); return res.end(); } res.write(Buffer.alloc(4000)); }, 20); res.on('close', () => clearInterval(iv)); });
  await new Promise((r) => slowSrv.listen(0, '127.0.0.1', r));
  const job = {};
  const pd = I.download(`http://127.0.0.1:${slowSrv.address().port}/big`, path.join(tmp, 'dl', 'big.bin'), { job });
  await sleep(250); job.cancel();
  d = await pd;
  assert(!d.ok && d.error === 'CANCELLED' && fs.existsSync(path.join(tmp, 'dl', 'big.bin.part')) && /continue/.test(d.message), 'cancel pauses the download and keeps the .part to resume');
  fs.writeFileSync(path.join(tmp, 'dl', 'garbage.7z'), crypto.randomBytes(5000));
  const badX = await I.extract(path.join(tmp, 'dl', 'garbage.7z'), path.join(tmp, 'x-out'), { sevenZip: null, tar: 'tar' });
  assert(!badX.ok && badX.error === 'EXTRACT_FAILED' && /7-Zip/.test(badX.message), 'an archive that can\'t be unpacked → "install 7-Zip, the download is kept"');
  assert(I.defaultHome('win32', { LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local' }) === 'C:\\Users\\Ada\\AppData\\Local\\AutoInjector\\comfyui', 'installs into %LOCALAPPDATA%\\AutoInjector\\comfyui');
  assert(I.find7z({ ProgramFiles: 'C:\\Program Files' }, (p) => p === path.join('C:\\Program Files', '7-Zip', '7z.exe')) !== null, '7-Zip is found in Program Files when installed');

  { // a .part that is already complete, with no expected size: the server answers 416 → it is finished, not an error forever
    const full = Buffer.alloc(3000, 7);
    const s416 = http.createServer((req, res) => { const m = /bytes=(\d+)-/.exec(req.headers.range || ''); const st = m ? Number(m[1]) : 0; if (st >= full.length) { res.writeHead(416, { 'Content-Range': `bytes */${full.length}` }); return res.end(); } const b = full.subarray(st); res.writeHead(m ? 206 : 200, { 'Content-Length': b.length }); res.end(b); });
    await new Promise((r) => s416.listen(0, '127.0.0.1', r));
    const d416 = path.join(tmp, 'dl', 'done-already.bin');
    fs.writeFileSync(d416 + '.part', full);
    const r416 = await I.download(`http://127.0.0.1:${s416.address().port}/f`, d416, { maxTries: 1 });
    assert(r416.ok && fs.existsSync(d416) && !fs.existsSync(d416 + '.part') && fs.statSync(d416).size === full.length, 'a complete .part with no known size: 416 → renamed and done (not HTTP_416 forever)');
    s416.close();
  }

  console.log('\n== a cut-off unpack is not "installed" ==');
  { // the app was closed while unpacking: ComfyUI/main.py is there, its Python is not, and the download is kept
    const home3 = path.join(tmp, 'h3');
    fs.mkdirSync(path.join(home3, 'ComfyUI_windows_portable', 'ComfyUI'), { recursive: true });
    fs.writeFileSync(path.join(home3, 'ComfyUI_windows_portable', 'ComfyUI', 'main.py'), 'print("half")');
    fs.writeFileSync(path.join(home3, 'ComfyUI_windows_portable_nvidia.7z'), ARCH);
    const inst3 = I.createInstaller({ home: home3, allowAnyPlatform: true, sevenZip: null, tar: 'tar', run: async () => 'NVIDIA GeForce RTX 3060, 12288', urls: { githubApi: `${B}/api/latest`, downloadBase: `${B}/files/` } });
    const c3 = await inst3.check();
    assert(!c3.installed && c3.unfinished && !inst3.status().installed && !I.isInstalled(home3), 'main.py without its Python (and no "unpacked" marker) is not counted as installed');
    const before = hits.archive;
    const r3 = await inst3.install({ ignoreSpace: true });
    assert(r3.ok && !r3.already && hits.archive === before && r3.portable && r3.portable.python && fs.existsSync(path.join(r3.portable.root, I.UNPACKED_MARKER)), 'Install unpacks it again from the kept download (nothing downloaded) and writes the "unpacked" marker');
    assert(inst3.status().installed && I.isInstalled(home3), 'afterwards it counts as installed');
    // an install from before the marker existed (python_embeded is there) still counts as installed
    const home4 = path.join(tmp, 'h4');
    fs.mkdirSync(path.join(home4, 'ComfyUI_windows_portable', 'ComfyUI'), { recursive: true });
    fs.mkdirSync(path.join(home4, 'ComfyUI_windows_portable', 'python_embeded'), { recursive: true });
    fs.writeFileSync(path.join(home4, 'ComfyUI_windows_portable', 'ComfyUI', 'main.py'), '');
    fs.writeFileSync(path.join(home4, 'ComfyUI_windows_portable', 'python_embeded', process.platform === 'win32' ? 'python.exe' : 'python'), '');
    assert(I.isInstalled(home4) && !fs.existsSync(path.join(home4, 'ComfyUI_windows_portable', I.UNPACKED_MARKER)), 'an older install without the marker but with python_embeded still counts as installed');
  }

  srv.close(); slowSrv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
function fetchOk(url) { return new Promise((r) => { http.get(url, (res) => { res.resume(); r(res.statusCode === 200); }).on('error', () => r(false)); }); }
main().catch((e) => { console.error(e); process.exit(1); });
