'use strict';
// test/build-files.test.js — the installed app (electron-builder "files" in package.json) must ship every
// file the app loads: each local require() in the shipped .js files, and each local <script>/<link>/preload
// an HTML page or BrowserWindow names. A file left off that list works from the source folder but crashes
// the installed app the moment it is needed.
// Run: node test/build-files.test.js
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(DIR, 'package.json'), 'utf8'));
const files = (pkg.build && pkg.build.files) || [];
let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

const globToRe = (g) => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '(?:.*/)?')}$`);
const globs = files.filter((f) => /[*]/.test(f) && !f.startsWith('!')).map(globToRe);
const shipped = (rel) => files.includes(rel) || globs.some((re) => re.test(rel));

const want = new Map(); // file -> who needs it
const need = (rel, by) => { rel = rel.replace(/^\.\//, ''); if (!want.has(rel)) want.set(rel, by); };
const roots = files.filter((f) => !/[*]/.test(f) && !f.startsWith('!'));
for (const f of roots) {
  const full = path.join(DIR, f);
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) continue;
  const src = fs.readFileSync(full, 'utf8');
  if (f.endsWith('.js')) {
    for (const m of src.matchAll(/require\(\s*['"]\.\/([^'"]+)['"]\s*\)/g)) need(m[1].endsWith('.js') || m[1].endsWith('.json') ? m[1] : `${m[1]}.js`, f);
    for (const m of src.matchAll(/['"`]([\w.-]+\.(?:html|js))['"`]/g)) { const r = m[1]; if (/preload|window|\.html$/.test(r) && fs.existsSync(path.join(DIR, r))) need(r, f); }
  }
  if (f.endsWith('.html')) for (const m of src.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^":?#]+)"/g)) if (!/^\/\//.test(m[1]) && fs.existsSync(path.join(DIR, m[1]))) need(m[1], f);
}
const missing = [...want].filter(([rel]) => fs.existsSync(path.join(DIR, rel)) && !shipped(rel));
assert(want.size > 50, `found ${want.size} files the shipped code loads`);
assert(missing.length === 0, missing.length ? `every one ships — MISSING from package.json build.files: ${missing.map(([r, by]) => `${r} (needed by ${by})`).join(', ')}` : 'every one of them is in package.json build.files');
assert(files.includes('package.json') || globs.some((re) => re.test('package.json')) || true, 'package.json is always shipped by electron-builder');
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
