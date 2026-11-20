// test/no-money-lab.test.js — 🚫 the owner's standing rule: the Money lab never goes into AutoInjector.
// It lives only in its own repository (javon86/money-lab). This fails if any of its files or its wiring shows up here,
// so a pull request that would bring it into main goes red. See CLAUDE.md. Never weaken, skip or delete this check.
// Run with: node test/no-money-lab.test.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DESK = path.join(__dirname, '..');
let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); } else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}

// every file in the repository (not node_modules / .git / build output)
const SKIP = new Set(['node_modules', '.git', 'dist', '__pycache__', '.venv', 'venv', '__screenshots__']);
function walk(dir, out) {
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of list) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(path.relative(ROOT, p).split(path.sep).join('/'));
  }
  return out;
}
const files = walk(ROOT, []);
const SELF = 'desktop-app/test/no-money-lab.test.js'; // this check itself
const labFiles = files.filter((f) => f !== SELF && (/money[-_ ]?lab/i.test(f) || /^desktop-app\/lab\.(html|js)$/.test(f) || /lab-kit\//.test(f) || /\.wsb$/i.test(f)));
assert(labFiles.length === 0, labFiles.length ? `no Money lab files — FOUND: ${labFiles.slice(0, 10).join(', ')}` : 'no Money lab files in the repository');

const read = (f) => { try { return fs.readFileSync(path.join(DESK, f), 'utf8'); } catch (_) { return ''; } };
const wiring = [
  ['main.js', /ipcMain\.handle\("lab:|createMoneyLab|money-lab-main|openLabWindow/],
  ['preload.js', /labOpenWindow|labStart|ipcRenderer\.invoke\("lab:/],
  ['controls.html', /id="btn-lab"|🧪 Money lab/],
  ['controls.js', /labOpenWindow/],
  ['package.json', /(?<!no-)money-lab|"lab\.html"|"lab\.js"/],
  ['alfred-app-actions.js', /'lab:(start|answer|window)'/],
];
for (const [f, re] of wiring) assert(!re.test(read(f)), `${f}: no Money lab wiring`);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log('\n🚫 The Money lab must never be merged into AutoInjector — it lives in javon86/money-lab (see CLAUDE.md).');
process.exit(failed ? 1 : 0);
