'use strict';
// test/content-home.test.js — a NEW copy of AutoInjector keeps using your downloads: the "stuff and thing"
// folder is remembered outside the app folder, an earlier copy's folder is found and used while this copy's is
// still empty, and offered (not forced) when both have things. Plus the 🩺 health "content-elsewhere" notice.
// Run: node test/content-home.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const ch = require('../content-home');
const { createHealthWatch } = require('../health-watch');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const mk = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data == null ? 'x' : data); };

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'content-home-'));
  const userData = path.join(home, 'AppData', 'Roaming', 'autoinjector-desktop');
  const oldCopy = path.join(home, 'Documents', 'git', 'AutoInjector');
  const newCopy = path.join(home, 'Documents', 'GitHub', 'AutoInjector');
  // the earlier copy: an Ollama model + pictures; the app's seeded READMEs everywhere
  mk(path.join(oldCopy, 'stuff and thing', 'models', 'llm', 'manifests', 'registry.ollama.ai', 'library', 'qwen3', '14b'), '{}');
  mk(path.join(oldCopy, 'stuff and thing', 'models', 'llm', 'blobs', 'sha256-abc'), Buffer.alloc(4096));
  mk(path.join(oldCopy, 'stuff and thing', 'images', 'lighthouse.png'), Buffer.alloc(2048));
  mk(path.join(oldCopy, 'stuff and thing', 'README.txt'));
  // the new copy: only what a fresh start seeds
  mk(path.join(newCopy, 'stuff and thing', 'README.txt'));
  mk(path.join(newCopy, 'stuff and thing', 'models', 'README.txt'));
  fs.mkdirSync(path.join(newCopy, 'stuff and thing', 'models', 'llm'), { recursive: true });
  // a folder with "stuff and thing" that holds nothing worth keeping
  mk(path.join(home, 'Desktop', 'test-copy', 'stuff and thing', 'README.txt'));

  console.log('\n== what a folder holds ==');
  const d = ch.describe(fs, path.join(oldCopy, 'stuff and thing'));
  assert(d.worthUsing && d.has.languageModels && d.has.pictures && d.what.includes('AI models (Ollama)') && d.bytes >= 6144, `the earlier copy: ${d.what.join(', ')} (${d.bytes} bytes)`);
  assert(!ch.describe(fs, path.join(newCopy, 'stuff and thing')).worthUsing, 'a fresh copy (only READMEs and empty folders) has nothing worth keeping');

  console.log('\n== finding earlier copies ==');
  const others = ch.findOtherRoots({ home, appFolder: newCopy });
  assert(others.length === 1 && others[0].root === oldCopy, `finds the earlier copy in Documents (${others.map((o) => o.root).join(', ')}) and skips the empty test copy and itself`);

  console.log('\n== choosing the folder ==');
  let c = ch.chooseRoot({ appFolder: newCopy, userData, home });
  assert(c.root === oldCopy && c.reason === 'found-earlier', 'a new, empty copy uses the earlier copy\'s folder by itself — nothing downloaded again');
  mk(path.join(newCopy, 'stuff and thing', 'images', 'new.png'));
  c = ch.chooseRoot({ appFolder: newCopy, userData, home });
  assert(c.root === newCopy && c.reason === 'default' && c.others.length === 1, 'when the new copy already has things, it stays — and the earlier copy is offered');
  assert(ch.remember(userData, newCopy, fs, 'auto') && ch.readRememberedInfo(userData).how === 'auto', 'the folder is remembered outside the app folder (noted by the app)');
  const third = path.join(home, 'Desktop', 'AutoInjector-v2');
  fs.mkdirSync(third, { recursive: true });
  c = ch.chooseRoot({ appFolder: third, userData, home });
  assert(c.root === newCopy && c.reason === 'remembered' && c.others.some((o) => o.root === oldCopy), 'a third copy uses the remembered folder (and still offers the other one, since you never picked)');
  { // the scan of the home folder runs once, not on every launch
    let walks = 0;
    const cfs = Object.assign({}, fs, { readdirSync: (...a) => { walks++; return fs.readdirSync(...a); } });
    assert(ch.readRememberedInfo(userData).scanned === true, 'after that scan, the remembered choice notes it was done (and what it found)');
    walks = 0;
    c = ch.chooseRoot({ appFolder: third, userData, home, fs: cfs });
    assert(c.reason === 'remembered' && c.others.some((o) => o.root === oldCopy) && walks === 0, `the next launch does not walk the disk again (${walks} folder reads) and still offers the earlier copy`);
    ch.remember(userData, newCopy, fs, 'auto', { others: c.others });
    assert(ch.readRememberedInfo(userData).scanned && ch.readRememberedInfo(userData).others.length === 1, 'main.js remembering with this launch\'s others → marked as scanned');
    ch.remember(userData, newCopy, fs, 'auto'); // an older record (no scan noted) → scanned once more, then remembered
    walks = 0; c = ch.chooseRoot({ appFolder: third, userData, home, fs: cfs });
    const w1 = walks; walks = 0; ch.chooseRoot({ appFolder: third, userData, home, fs: cfs });
    assert(w1 > 0 && walks === 0, `an older record scans once (${w1} folder reads), then never again (${walks})`);
    assert(/contentHome\.remember\(userDataDir\(\), contentBaseFolder\(\), undefined, "auto", \{ others: c\.others \|\| \[\] \}\)/.test(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')), 'main.js remembers the first launch\'s scan result with the folder');
  }
  ch.remember(userData, oldCopy, fs, 'user');
  c = ch.chooseRoot({ appFolder: third, userData, home });
  assert(c.root === oldCopy && c.reason === 'chosen' && c.others.length === 0, 'after you pick one: that folder, and no more offers');
  fs.rmSync(path.join(oldCopy, 'stuff and thing'), { recursive: true, force: true });
  c = ch.chooseRoot({ appFolder: third, userData, home });
  assert(c.root !== oldCopy, 'a remembered folder that was deleted is not used');

  console.log('\n== 🩺 health: "your downloads are in another folder" ==');
  const mkWatch = (info) => createHealthWatch({ contentRoots: () => info, log: () => {}, notify: () => {} });
  let hw = mkWatch({ ok: true, reason: 'default', current: newCopy, others: [{ root: oldCopy, dir: path.join(oldCopy, 'stuff and thing'), what: ['AI models (Ollama)', 'pictures'], bytes: 9 * 1024 ** 3 }] });
  let st = await hw.runOnce({ only: ['content'] });
  const p = (st.problems || []).find((x) => x.code === 'content-elsewhere');
  assert(p && /earlier downloads/.test(p.text) && /AI models/.test(p.text) && p.fix && /Use that folder/.test(p.fix.label), `warns with a one-click fix (${p && p.text.slice(0, 90)}…)`);
  hw = mkWatch({ ok: true, reason: 'chosen', current: oldCopy, others: [] });
  st = await hw.runOnce({ only: ['content'] });
  assert(!(st.problems || []).some((x) => x.code === 'content-elsewhere'), 'quiet once you picked a folder');
  fs.rmSync(home, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
