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
    if (u.pathname === '/files/portable.7z' || u.pathname === '/model.safetensors') {
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
    onChange: (st) => progress.push(st) });
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

  srv.close(); slowSrv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
function fetchOk(url) { return new Promise((r) => { http.get(url, (res) => { res.resume(); r(res.statusCode === 200); }).on('error', () => r(false)); }); }
main().catch((e) => { console.error(e); process.exit(1); });
