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
  const xfs = Object.assign({}, fs, { renameSync: () => { const e = new Error('cross-device'); e.code = 'EXDEV'; throw e; } });
  m = await F.moveComfy({ from: legacy2, to: to2, fs: xfs });
  assert(m.ok && m.how === 'copy' && F.hasComfy(to2) && !fs.existsSync(legacy2), 'another drive: copied, checked, the old one deleted');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
