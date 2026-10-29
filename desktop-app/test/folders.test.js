'use strict';
// test/folders.test.js — one tidy folder system: ComfyUI inside "stuff and thing/apps/comfyui" (an older install
// keeps working where it is until it is moved), the "where everything is" list, and moving ComfyUI.
// Run: node test/folders.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('../folders');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const mk = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data == null ? 'x' : data); };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'folders-'));
  const stuff = path.join(tmp, 'AutoInjector', 'stuff and thing');
  const legacy = path.join(tmp, 'AppData', 'Local', 'AutoInjector', 'comfyui');
  const L = F.layout(stuff);
  assert(L.comfyHome === path.join(stuff, 'apps', 'comfyui') && L.downloads === path.join(stuff, 'downloads') && L.llm === path.join(stuff, 'models', 'llm'), 'the layout: apps/comfyui, downloads/, models/llm');

  console.log('\n== where ComfyUI lives ==');
  let c = F.pickComfyHome({ stuffDir: stuff, legacyHome: legacy, platform: 'linux' });
  assert(c.where === 'stuff' && c.home === L.comfyHome, 'a new install goes into "stuff and thing/apps/comfyui"');
  mk(path.join(legacy, 'ComfyUI_windows_portable', 'ComfyUI', 'main.py'));
  mk(path.join(legacy, 'ComfyUI_windows_portable', 'ComfyUI', 'models', 'checkpoints', 'sdxl.safetensors'), Buffer.alloc(4096));
  assert(F.hasComfy(legacy), 'hasComfy finds the Windows portable');
  c = F.pickComfyHome({ stuffDir: stuff, legacyHome: legacy, platform: 'win32' });
  assert(c.where === 'legacy' && c.home === legacy, 'an install from before the tidy-up keeps working where it is');
  assert(F.pickComfyHome({ stuffDir: stuff, legacyHome: legacy, envHome: '/x/comfy' }).where === 'setting', 'an explicit setting wins');
  const longStuff = path.join(tmp, 'a'.repeat(120), 'stuff and thing');
  assert(F.pickComfyHome({ stuffDir: longStuff, legacyHome: path.join(tmp, 'none'), platform: 'win32' }).where === 'legacy-long-path', 'a very long path on Windows falls back to the short system folder');

  console.log('\n== where everything is ==');
  mk(path.join(stuff, 'images', 'a.png'));
  const rows = F.map({ stuffDir: stuff, comfy: c, userData: path.join(tmp, 'AppData', 'Roaming', 'autoinjector-desktop'), ollamaStore: path.join(tmp, 'nope') });
  const comfyRow = rows.find((r) => /ComfyUI/.test(r.what));
  assert(rows[0].path === stuff && rows[0].inStuff, 'first: "stuff and thing"');
  assert(comfyRow && !comfyRow.inStuff && /Move into stuff and thing/.test(comfyRow.note) && comfyRow.bytes >= 4096, 'the older ComfyUI is marked as outside, with how to move it and its size');
  assert(rows.some((r) => /Settings/.test(r.what) && !r.inStuff) && !rows.some((r) => /Ollama's own app/.test(r.what)), 'settings listed (outside, on purpose); a missing Ollama folder is not');
  assert(L.workflows === path.join(stuff, 'workflows') && L.modelDirs.ultralytics_segm === path.join(stuff, 'models', 'detectors', 'ultralytics', 'segm') && L.modelDirs.framepack === path.join(stuff, 'models', 'video', 'framepack', 'hf') && L.modelDirs.lycoris === path.join(stuff, 'models', 'loras', 'lycoris'), 'the layout knows every model folder + workflows/');
  for (const rel of ['image', 'loras/lycoris', 'vae/approx', 'embeddings', 'controlnet', 'upscale', 'text_encoders', 'diffusion_models', 'clip_vision', 'ipadapter', 'detectors/ultralytics/bbox', 'detectors/ultralytics/segm', 'detectors/sams', 'faces', 'video/framepack/hf']) {
    const r = rows.find((x) => x.path === path.join(stuff, 'models', ...rel.split('/')));
    assert(r && r.inStuff && r.what.includes(`models/${rel}`), `"Where everything is" lists models/${rel}${r && r.note ? ` (${r.note})` : ''}`);
  }
  assert(rows.some((r) => r.path === path.join(stuff, 'workflows') && /workflow/i.test(r.what)), '"Where everything is" lists the ComfyUI workflows folder');

  console.log('\n== moving ComfyUI into "stuff and thing" ==');
  let m = await F.moveComfy({ from: legacy, to: L.comfyHome });
  assert(m.ok && m.how === 'rename' && F.hasComfy(L.comfyHome) && !fs.existsSync(legacy) && fs.existsSync(path.join(L.comfyHome, 'ComfyUI_windows_portable', 'ComfyUI', 'models', 'checkpoints', 'sdxl.safetensors')), `moved with its models (${m.message})`);
  assert(F.pickComfyHome({ stuffDir: stuff, legacyHome: legacy }).where === 'stuff', 'afterwards it is found in "stuff and thing"');
  m = await F.moveComfy({ from: legacy, to: L.comfyHome });
  assert(!m.ok && /no ComfyUI/.test(m.error), 'moving again: nothing to move (plain words)');
  // a cross-drive move (EXDEV) copies, checks, then deletes the old one
  const legacy2 = path.join(tmp, 'other-drive', 'comfyui');
  mk(path.join(legacy2, 'ComfyUI', 'main.py'));
  const to2 = path.join(tmp, 'stuff2', 'apps', 'comfyui');
  const xfs = Object.assign({}, fs, { promises: fs.promises, renameSync: (a, b) => { if (path.resolve(a) === path.resolve(legacy2)) { const e = new Error('cross-device'); e.code = 'EXDEV'; throw e; } return fs.renameSync(a, b); } });
  let syncCopies = 0; xfs.cpSync = (...a) => { syncCopies++; return fs.cpSync(...a); };
  m = await F.moveComfy({ from: legacy2, to: to2, fs: xfs });
  assert(m.ok && m.how === 'copy' && F.hasComfy(to2) && !fs.existsSync(legacy2), 'another drive: copied, checked, the old one deleted');
  assert(syncCopies === 0 && !fs.existsSync(to2 + '.partial'), 'the cross-drive copy is asynchronous (no cpSync on the main thread) and its .partial folder is renamed into place');

  console.log('\n== a locked / running ComfyUI is never copied ==');
  for (const code of ['EPERM', 'EBUSY']) {
    const legacy3 = path.join(tmp, 'locked-' + code, 'comfyui');
    mk(path.join(legacy3, 'ComfyUI', 'main.py'));
    const to3 = path.join(tmp, 'stuff-' + code, 'apps', 'comfyui');
    let copied = 0;
    const lfs = Object.assign({}, fs, { renameSync: () => { const e = new Error('locked'); e.code = code; throw e; }, cpSync: () => { copied++; }, promises: Object.assign({}, fs.promises, { cp: async () => { copied++; } }) });
    m = await F.moveComfy({ from: legacy3, to: to3, fs: lfs });
    assert(!m.ok && /stop ComfyUI/i.test(m.error) && copied === 0 && F.hasComfy(legacy3), `${code} on rename → "stop ComfyUI first", nothing copied, nothing deleted`);
  }
  // a half-finished copy left by a killed app never wins pickComfyHome
  const stuff4 = path.join(tmp, 'stuff4');
  const L4 = F.layout(stuff4);
  mk(path.join(L4.comfyHome + '.partial', 'ComfyUI', 'main.py'));
  mk(path.join(L4.comfyHome, 'x.partial', 'ComfyUI', 'main.py'));
  const legacy4 = path.join(tmp, 'legacy4');
  mk(path.join(legacy4, 'ComfyUI', 'main.py'));
  assert(!F.hasComfy(L4.comfyHome + '.partial') && !F.hasComfy(L4.comfyHome), 'hasComfy ignores ".partial" folders');
  assert(F.pickComfyHome({ stuffDir: stuff4, legacyHome: legacy4, platform: 'linux' }).where === 'legacy', 'a cut-off .partial copy does not replace the working install');

  console.log('\n== "is ComfyUI running?" uses sd-runner\'s real status (phase) ==');
  for (const ph of ['starting', 'running', 'restarting', 'waiting']) assert(F.comfyInUse({ phase: ph, kind: ph === 'waiting' ? null : 'comfy' }) === true, `phase ${ph} → in use`);
  for (const ph of ['idle', 'stopped', 'failed']) assert(F.comfyInUse({ phase: ph, kind: 'comfy', ready: false, busy: false }) === false, `phase ${ph} → free`);
  assert(F.comfyInUse({ phase: 'running', ready: true, kind: 'a1111' }) === false, 'a running A1111/Forge does not lock the ComfyUI folder');
  assert(F.comfyInUse({ phase: 'idle' }, { busy: true, phase: 'extracting' }) === true, 'the installer unpacking into it counts as in use');
  assert(!/st\.running \|\| st\.starting/.test(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')) && /foldersMod\.comfyInUse\(sdRunner\(\)\.status\(\)/.test(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')), 'main.js guards the move with comfyInUse(sdRunner().status(), …)');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
