// test/sd-addons.test.js — 🧩 Add-ons (sd-addons.js) with a temp fake Forge folder (as Stability Matrix
// lays it out), a fake git (test/fixtures/fake-git.js behind a shell wrapper), an injected zip download,
// and fake Forge / ComfyUI servers for the app's own lists.
// Run: node test/sd-addons.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../sd-addons');
const sdBackends = require('../sd-backends');
const { fakeA1111, fakeComfy } = require('./fixtures/fake-sd');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-addons-'));
const mk = (p, txt) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt || ''); };
function fakeForge(root) {
  const d = path.join(root, 'StabilityMatrix', 'Data', 'Packages', 'stable-diffusion-webui-forge');
  mk(path.join(d, 'launch.py'), '# forge'); mk(path.join(d, 'modules', 'cmd_args.py'));
  fs.mkdirSync(path.join(d, 'modules_forge'), { recursive: true });
  fs.mkdirSync(path.join(d, 'extensions'), { recursive: true });
  for (const b of ['sd_forge_controlnet', 'sd_forge_multidiffusion', 'Lora']) fs.mkdirSync(path.join(d, 'extensions-builtin', b), { recursive: true });
  return d;
}
function fakeA1111Dir(root) {
  const d = path.join(root, 'webui', 'stable-diffusion-webui');
  mk(path.join(d, 'launch.py')); fs.mkdirSync(path.join(d, 'modules'), { recursive: true }); fs.mkdirSync(path.join(d, 'extensions'), { recursive: true });
  fs.mkdirSync(path.join(d, 'extensions-builtin', 'Lora'), { recursive: true });
  return d;
}
function fakeComfyDir(root) {
  const d = path.join(root, 'ComfyUI_windows_portable');
  mk(path.join(d, 'ComfyUI', 'main.py')); fs.mkdirSync(path.join(d, 'ComfyUI', 'comfy'), { recursive: true }); fs.mkdirSync(path.join(d, 'ComfyUI', 'custom_nodes'), { recursive: true });
  return d;
}
const gitLog = path.join(tmp, 'git-log.jsonl');
const gitWrapper = path.join(tmp, 'git');
fs.writeFileSync(gitWrapper, `#!/bin/sh\nexec "${process.execPath}" "${path.join(__dirname, 'fixtures', 'fake-git.js')}" "$@"\n`);
fs.chmodSync(gitWrapper, 0o755);
process.env.FAKE_GIT_LOG = gitLog;
const gitCalls = () => { try { return fs.readFileSync(gitLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

(async () => {
  console.log('== links (validateRepoUrl) ==');
  const g = A.validateRepoUrl('https://github.com/Bing-su/adetailer');
  assert(g.ok && g.url === 'https://github.com/Bing-su/adetailer.git' && g.name === 'adetailer' && g.owner === 'Bing-su', 'a GitHub page → its clone link and folder name');
  assert(A.validateRepoUrl(' https://www.github.com/hako-mikan/sd-webui-regional-prompter/tree/main/scripts ').url === 'https://github.com/hako-mikan/sd-webui-regional-prompter.git', 'a browser link (www., /tree/main/…) is reduced to the repository');
  assert(A.validateRepoUrl('https://github.com/a/b.git').name === 'b', '…/b.git works too');
  const gl = A.validateRepoUrl('https://gitlab.com/group/sub/addon/-/tree/main');
  assert(gl.ok && gl.owner === 'group/sub' && gl.repo === 'addon', 'GitLab (with a subgroup) is accepted');
  for (const [bad, why] of [['', 'empty'], ['http://github.com/a/b', 'http'], ['git@github.com:a/b.git', 'ssh'], ['https://example.com/a/b', 'another site'], ['https://user:pw@github.com/a/b', 'a password'], ['https://github.com:8443/a/b', 'a port'], ['https://github.com/onlyowner', 'no repo'], ['https://github.com/a/..', 'dots'], ['javascript:alert(1)', 'javascript:'], ['file:///C:/x', 'file:'], ['https://github.com/orgs/x', 'a GitHub page that is not a repo'], ['https://github.com/a/b;rm -rf', 'odd characters']]) {
    const r = A.validateRepoUrl(bad);
    assert(!r.ok && r.error === 'BAD_LINK' && r.message && r.hint, `refused: ${why} (“${r.message}”)`);
  }
  assert(A.zipUrlFor('https://github.com/Bing-su/adetailer') === 'https://codeload.github.com/Bing-su/adetailer/zip/HEAD' && /gitlab\.com\/group\/sub\/addon\/-\/archive\/HEAD\/addon-HEAD\.zip$/.test(A.zipUrlFor('https://gitlab.com/group/sub/addon')), 'the zip download link for GitHub / GitLab');

  console.log('== finding the app\'s folder ==');
  const forge = fakeForge(tmp);
  const smData = path.join(tmp, 'StabilityMatrix', 'Data');
  let f = A.inspectFolder(forge);
  assert(f.ok && f.kind === 'forge' && f.label === 'Forge' && f.extDir === path.join(forge, 'extensions'), 'the Forge package folder → Forge, extensions/');
  assert(A.inspectFolder(path.join(forge, 'extensions')).dir === forge, 'picking its extensions folder works too');
  assert(A.inspectFolder(smData).dir === forge && A.inspectFolder(path.join(smData, 'Packages')).dir === forge, 'picking Stability Matrix\'s Data (or Packages) folder finds Forge inside');
  const comfyRoot = fakeComfyDir(tmp);
  const cf = A.inspectFolder(comfyRoot);
  assert(cf.ok && cf.kind === 'comfy' && cf.extDir === path.join(comfyRoot, 'ComfyUI', 'custom_nodes'), 'the ComfyUI portable root → ComfyUI/custom_nodes');
  const nf = A.inspectFolder(tmp + '/nothing-here'); mk(path.join(tmp, 'random', 'a.txt'));
  const rf = A.inspectFolder(path.join(tmp, 'random'));
  assert(!nf.ok && nf.error === 'NO_FOLDER' && !rf.ok && rf.error === 'NOT_SD_FOLDER' && /launch\.py/.test(rf.message + rf.hint), 'a folder that isn\'t an SD app → a plain "choose the one with launch.py"');

  let r = A.resolveInstall({ targets: [], connected: { backend: 'a1111', label: 'Forge', base: 'http://127.0.0.1:7860' } });
  assert(!r.ok && r.error === 'NO_PATH' && /doesn't know where Forge is installed/.test(r.message) && /Choose the folder/.test(r.fix) && /Data\\Packages\\stable-diffusion-webui-forge/.test(r.fix) && /remembers/.test(r.fix), 'nothing found → how to point AutoInjector at Forge\'s folder (folder picker, remembered)');
  const targets = [{ id: 'sm:forge', kind: 'forge', label: 'SD WebUI Forge', source: 'Stability Matrix', supported: true, dir: forge }, { id: 'portable:comfyui', kind: 'comfy', source: 'AutoInjector', supported: true, portable: true, dir: comfyRoot }];
  r = A.resolveInstall({ targets, connected: { backend: 'a1111', label: 'Forge' } });
  assert(r.ok && r.dir === forge && r.source === 'Stability Matrix', 'connected to Forge → the Stability Matrix Forge package (like the runner finds it)');
  r = A.resolveInstall({ targets, connected: { backend: 'comfy', label: 'ComfyUI' } });
  assert(r.ok && r.kind === 'comfy' && r.dir === path.join(comfyRoot, 'ComfyUI'), 'connected to ComfyUI → ComfyUI\'s folder');
  const a1 = fakeA1111Dir(tmp);
  r = A.resolveInstall({ chosen: a1, targets, connected: { backend: 'a1111', label: 'Automatic1111' } });
  assert(r.ok && r.dir === a1 && r.chosen && r.kind === 'a1111' && r.others.some((o) => o.dir === forge), 'the folder the person chose wins (the others are listed)');
  r = A.resolveInstall({ chosen: path.join(tmp, 'random'), targets, connected: { backend: 'a1111' } });
  assert(r.ok && r.dir === forge, 'a remembered folder that is no longer an SD app → the one found on this PC');
  r = A.resolveInstall({ runner: { phase: 'running', target: targets[0] }, targets: [], connected: {} });
  assert(r.ok && r.source === 'started by AutoInjector', 'the package AutoInjector started is found too');

  console.log('== the list (no SD app running) ==');
  const inst = A.inspectFolder(forge);
  let ov = await A.overview({ install: inst });
  const row = (o, id) => o.catalog.find((c) => c.id === id);
  assert(ov.ok && ov.kind === 'forge' && ov.app === 'Forge' && ov.install && ov.install.extDir === inst.extDir, 'overview knows the app and its folder');
  assert(row(ov, 'controlnet').state === 'builtin' && /built into Forge/.test(row(ov, 'controlnet').note), `ControlNet on Forge → "built in" (${row(ov, 'controlnet').note})`);
  assert(row(ov, 'tiled-diffusion').state === 'builtin', 'Tiled Diffusion on Forge → its own built-in one');
  assert(row(ov, 'adetailer').state === 'missing' && row(ov, 'reactor').consent && /said yes/.test(row(ov, 'reactor').what), 'ADetailer not installed yet; ReActor carries the consent note');
  assert(['adetailer', 'controlnet', 'regional-prompter', 'dynamic-prompts', 'tiled-diffusion', 'ultimate-upscale', 'reactor'].every((id) => row(ov, id)), 'the curated list has all seven add-ons');
  const ova = await A.overview({ install: A.inspectFolder(a1) });
  assert(row(ova, 'controlnet').state === 'missing', 'on Automatic1111, ControlNet can be installed');
  const ovc = await A.overview({ install: cf });
  assert(ovc.kind === 'comfy' && row(ovc, 'comfyui-manager') && row(ovc, 'impact-pack'), 'ComfyUI gets its own list (ComfyUI-Manager, Impact Pack, …)');
  const ovn = await A.overview({ install: A.resolveInstall({ targets: [], connected: { backend: 'a1111', label: 'Forge' } }), backend: 'a1111', label: 'Forge' });
  assert(ovn.ok && !ovn.install && ovn.help && ovn.help.error === 'NO_PATH' && /Choose the folder/.test(ovn.help.fix), 'no folder → the list still shows, with the folder help');

  console.log('== install with git ==');
  const progress = [];
  let res = await A.install(inst, { id: 'adetailer' }, { git: gitWrapper, onProgress: (p) => progress.push(p) });
  const ad = path.join(forge, 'extensions', 'adetailer');
  assert(res.ok && res.via === 'git' && fs.existsSync(path.join(ad, 'scripts', 'adetailer.py')) && /Restart Forge/.test(res.message) && res.restartNeeded, `ADetailer → git clone into extensions/adetailer (“${res.message}”)`);
  const clone = gitCalls().find((c) => c.args.includes('clone'));
  assert(clone && clone.args.includes('--depth') && clone.args[clone.args.indexOf('--depth') + 1] === '1' && clone.args.includes('https://github.com/Bing-su/adetailer') && clone.args[clone.args.indexOf('--') + 1] === 'https://github.com/Bing-su/adetailer' && clone.prompt === '0', 'git clone --depth 1 -- <url> (never asks for a password)');
  assert(!fs.existsSync(path.join(ad, 'RAN_INSTALL_PY')), 'the add-on\'s own code (install.py) was NOT run — files are only placed');
  assert(progress.some((p) => p.step === 'Downloading' && p.pct === 0.5) && progress.some((p) => p.step === 'Done'), 'progress from git\'s "Receiving objects: 50%"');
  assert(!fs.existsSync(path.join(forge, '_removed', '.incoming')), 'the temporary folder is gone');
  ov = await A.overview({ install: inst });
  assert(row(ov, 'adetailer').state === 'installed' && ov.installed.some((x) => x.name === 'adetailer' && x.git && /Bing-su\/adetailer/.test(x.url) && x.canUpdate && x.canRemove), 'listed as installed (from the folder), with Update / Remove');
  res = await A.install(inst, { id: 'adetailer' }, { git: gitWrapper });
  assert(!res.ok && res.error === 'ALREADY_INSTALLED', 'installing it twice → "already installed"');
  res = await A.install(inst, { url: 'https://github.com/Bing-su/adetailer.git' }, { git: gitWrapper });
  assert(!res.ok && res.error === 'ALREADY_INSTALLED', '…also by its link');
  res = await A.install(inst, { id: 'controlnet' }, { git: gitWrapper });
  assert(!res.ok && res.error === 'BUILT_IN' && /built into Forge/.test(res.message), 'ControlNet on Forge → "built in", nothing cloned');
  const nGit = gitCalls().length;
  res = await A.install(inst, { url: 'https://evil.example.com/x/y' }, { git: gitWrapper });
  assert(!res.ok && res.error === 'BAD_LINK' && gitCalls().length === nGit, 'a non-GitHub link is refused before git runs');
  res = await A.install(inst, { url: 'https://github.com/someone/missing-addon' }, { git: gitWrapper });
  assert(!res.ok && res.error === 'NOT_FOUND' && /doesn't exist/.test(res.message) && !fs.existsSync(path.join(forge, 'extensions', 'missing-addon')), `a link to nothing → plain "doesn't exist", no folder left (“${res.message}”)`);
  res = await A.install(inst, { url: 'https://github.com/someone/offline-addon' }, { git: gitWrapper });
  assert(!res.ok && res.error === 'NO_INTERNET' && /internet/.test(res.message), 'no internet → a plain message');
  res = await A.install(inst, { url: 'https://github.com/hako-mikan/sd-webui-regional-prompter/tree/main' }, { git: gitWrapper });
  assert(res.ok && fs.existsSync(path.join(forge, 'extensions', 'sd-webui-regional-prompter', '.git', 'config')), 'a custom link (validated) installs into extensions/<repo>');

  console.log('== install without git (zip from GitHub) ==');
  const dl = [];
  const zipDeps = {
    git: null,
    download: async (url, dest) => { dl.push(url); mk(dest, 'PK fake'); return { ok: true, file: dest }; },
    extract: async (zip, into) => { mk(path.join(into, 'sd-dynamic-prompts-main', 'scripts', 'dynamic_prompting.py'), '#'); return { ok: true }; },
  };
  res = await A.install(inst, { id: 'dynamic-prompts' }, zipDeps);
  const dp = path.join(forge, 'extensions', 'sd-dynamic-prompts');
  assert(res.ok && res.via === 'zip' && dl[0] === 'https://codeload.github.com/adieyal/sd-dynamic-prompts/zip/HEAD' && fs.existsSync(path.join(dp, 'scripts', 'dynamic_prompting.py')), 'no git → the repo\'s zip is downloaded and unpacked into extensions/sd-dynamic-prompts');
  assert(JSON.parse(fs.readFileSync(path.join(dp, A.META), 'utf8')).url === 'https://github.com/adieyal/sd-dynamic-prompts', 'where it came from is noted (so Update works later)');
  res = await A.install(inst, { id: 'ultimate-upscale' }, Object.assign({}, zipDeps, { git: path.join(tmp, 'no-such-git') }));
  assert(res.ok && res.via === 'zip', 'a git that can\'t be started → the zip instead');
  res = await A.install(inst, { id: 'reactor' }, { git: null, download: async () => ({ ok: false, error: 'HTTP_404', message: 'The download server said 404.' }) });
  assert(!res.ok && /couldn't be downloaded/.test(res.message) && !fs.existsSync(path.join(forge, 'extensions', 'sd-webui-reactor-sfw')), 'a failed download → plain message, nothing left behind');

  console.log('== update ==');
  res = await A.update(inst, 'adetailer', { git: gitWrapper });
  assert(res.ok && res.updated && fs.existsSync(path.join(ad, 'UPDATED')) && gitCalls().some((c) => c.args.includes('pull') && c.args.includes('--ff-only')), 'Update → git pull --ff-only');
  mk(path.join(ad, '.git', 'UPTODATE'));
  res = await A.update(inst, 'adetailer', { git: gitWrapper });
  assert(res.ok && !res.updated && /already the newest/.test(res.message), 'already new → says so');
  mk(path.join(ad, 'LOCAL'));
  res = await A.update(inst, 'adetailer', { git: gitWrapper });
  assert(!res.ok && res.error === 'LOCAL_CHANGES' && /Remove it/.test(res.message), 'changed on this PC → plain "remove and install again"');
  fs.unlinkSync(path.join(ad, 'LOCAL'));
  res = await A.update(inst, 'sd-dynamic-prompts', Object.assign({}, zipDeps, { now: new Date(2026, 10, 5, 9, 30, 0).getTime() }));
  assert(res.ok && res.updated && fs.existsSync(path.join(forge, '_removed', 'sd-dynamic-prompts-20261105-093000', 'scripts')) && fs.existsSync(path.join(dp, 'scripts', 'dynamic_prompting.py')), 'a zip install updates with a fresh zip; the old copy is kept in _removed');
  res = await A.update(inst, '../escape', { git: gitWrapper });
  assert(!res.ok && res.error === 'NOT_INSTALLED', 'a name with ../ is refused');

  console.log('== remove ==');
  res = await A.remove(inst, 'sd-webui-regional-prompter', { now: new Date(2026, 10, 5, 10, 0, 0).getTime() });
  const moved = path.join(forge, '_removed', 'sd-webui-regional-prompter-20261105-100000');
  assert(res.ok && !fs.existsSync(path.join(forge, 'extensions', 'sd-webui-regional-prompter')) && fs.existsSync(path.join(moved, '.git', 'config')) && /nothing was deleted/.test(res.message), 'Remove → moved to <Forge>/_removed (outside extensions, nothing deleted)');
  ov = await A.overview({ install: inst });
  assert(row(ov, 'regional-prompter').state === 'missing' && !ov.installed.some((x) => x.name === '_removed'), 'no longer listed (and _removed is not an add-on)');
  res = await A.remove(inst, 'not-there');
  assert(!res.ok && res.error === 'NOT_INSTALLED', 'removing something that isn\'t there → plain message');
  res = await A.install(A.resolveInstall({ targets: [] }), { id: 'adetailer' }, { git: gitWrapper });
  assert(!res.ok && res.error === 'NO_PATH' && /Choose the folder/.test(res.fix), 'no folder known → install says how to choose it');

  console.log('== the app\'s own list (fake Forge / ComfyUI servers) ==');
  const forgeSrv = await fakeA1111({ flavor: 'forge', extensions: [{ name: 'Lora', enabled: true }, { name: 'sd_forge_controlnet', enabled: true }, { name: 'adetailer', remote: 'https://github.com/Bing-su/adetailer.git', enabled: true }, { name: 'sd-webui-civbrowser', remote: 'https://github.com/x/sd-webui-civbrowser', enabled: true }] });
  try {
    ov = await A.overview({ install: inst, base: forgeSrv.base, backend: 'a1111', label: 'Forge', getJson: sdBackends.getJson });
    assert(ov.apiVia === 'extensions' && forgeSrv.seen.some((s) => s.path === '/sdapi/v1/extensions'), 'Forge\'s /sdapi/v1/extensions is read');
    const adi = ov.installed.find((x) => x.name === 'adetailer');
    assert(adi && adi.state === 'on' && adi.onDisk && adi.inApp, 'ADetailer: on disk and loaded by Forge → ✔');
    const dpi = ov.installed.find((x) => x.name === 'sd-dynamic-prompts');
    assert(dpi && dpi.state === 'restart' && ov.restartNeeded && row(ov, 'dynamic-prompts').state === 'restart', 'installed but Forge hasn\'t loaded it yet → "restart Forge to turn it on"');
    assert(ov.installed.some((x) => x.name === 'sd-webui-civbrowser' && !x.onDisk && !x.canRemove) && !ov.installed.some((x) => /^(Lora|sd_forge_controlnet)$/.test(x.name)), 'what only Forge lists is shown too; its built-in parts are not');
    // no folder known, no extensions list: the scripts list still tells what's there
    const old = await fakeA1111({ flavor: 'a1111', noExtensionsList: true });
    try {
      const ov2 = await A.overview({ install: null, base: old.base, backend: 'a1111', label: 'Automatic1111', getJson: sdBackends.getJson });
      assert(ov2.apiVia === 'scripts' && row(ov2, 'adetailer').state === 'installed' && row(ov2, 'controlnet').state === 'installed' && row(ov2, 'regional-prompter').state === 'missing' && ov2.help, 'an older WebUI (no /extensions) → found by its scripts list; folder help shown');
    } finally { await old.close(); }
  } finally { await forgeSrv.close(); }
  const comfySrv = await fakeComfy({ manager: true });
  try {
    comfySrv.state.customNodes = { 'ComfyUI-Manager': { enabled: true }, 'ComfyUI-Impact-Pack': { enabled: true } };
    const ov3 = await A.overview({ install: cf, base: comfySrv.base, backend: 'comfy', label: 'ComfyUI', getJson: sdBackends.getJson });
    assert(ov3.apiVia === 'manager' && row(ov3, 'comfyui-manager').state === 'installed' && row(ov3, 'impact-pack').state === 'installed' && row(ov3, 'reactor').state === 'missing', 'ComfyUI with ComfyUI-Manager → its installed list');
  } finally { await comfySrv.close(); }

  console.log('== git on this PC ==');
  const ex = (set) => (p) => set.includes(p);
  const smGit = path.join('D:\\SM\\Data', 'PortableGit', 'bin', 'git.exe');
  assert(A.findGit({ env: { AUTOINJECTOR_GIT: '/x/git' }, exists: ex(['/x/git']) }) === '/x/git', 'AUTOINJECTOR_GIT first');
  assert(A.findGit({ env: { PATH: '' }, platform: 'win32', libraries: [{ library: 'D:\\SM\\Data' }], exists: ex([smGit]) }) === smGit, 'Stability Matrix\'s own PortableGit');
  assert(A.findGit({ env: { PATH: ['/usr/local/bin', '/usr/bin'].join(path.delimiter) }, platform: 'linux', exists: ex(['/usr/bin/git']) }) === '/usr/bin/git' && A.findGit({ env: { PATH: '' }, exists: () => false }) === null, 'else git on the PATH; none → null (the zip is used)');

  console.log('== one job at a time ==');
  const events = [];
  let release;
  const mgr = A.createAddonManager({ resolve: () => inst, connection: {}, git: null, onProgress: (p) => events.push(p), log: () => {},
    download: () => new Promise((r) => { release = () => r({ ok: false, error: 'CANCELLED', message: 'stopped' }); }) });
  const first = mgr.install({ url: 'https://github.com/x/slow-addon' });
  await new Promise((r) => setTimeout(r, 300));
  const second = await mgr.install({ id: 'ultimate-upscale' });
  assert(!second.ok && second.error === 'BUSY' && /wait/.test(second.message), 'a second install while one runs → "wait for it to finish"');
  if (release) release();
  await first;
  assert(events[0].phase === 'working' && events.some((e) => e.phase === 'done' || e.phase === 'failed'), 'progress: working → done');
  const badLink = await mgr.install({ url: 'ftp://x' });
  assert(!badLink.ok && badLink.error === 'BAD_LINK', 'the manager checks the link before anything else');
  assert(Object.keys(A.FOR_FIELD).every((k) => A.CATALOG.some((c) => c.id === A.FOR_FIELD[k])), 'every "was left out" field (ADetailer, ControlNet) points to an add-on in the list');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
