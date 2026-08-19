#!/usr/bin/env node
'use strict';
/*
 * ensure-deps.js — make sure every declared dependency is actually present
 * before the app (or the tests) start.
 *
 * Why not just check `node_modules` exists, or compare timestamps? Because both
 * lie: a partial or interrupted `npm install` leaves a `node_modules` folder
 * (with a fresh timestamp) that is still missing packages. The only reliable
 * signal is to look for each declared package on disk. If any is missing, we
 * run `npm install` — which is safe to run repeatedly and a no-op once
 * everything is in place.
 *
 * Exit code 0 = dependencies are ready (or were just installed).
 * Exit code non-zero = install was needed but failed.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const appDir = path.join(__dirname, '..');
const pkgPath = path.join(appDir, 'package.json');
const nodeModules = path.join(appDir, 'node_modules');

function declaredPackages() {
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); }
  catch (e) { console.error(`Could not read package.json: ${e.message}`); return []; }
  const names = new Set();
  for (const field of ['dependencies', 'devDependencies']) {
    for (const name of Object.keys(pkg[field] || {})) names.add(name);
  }
  return [...names];
}

// A package is "present" if its own package.json exists under node_modules.
// (Cheap, and handles scoped names like @scope/name via path.join.)
function isInstalled(name) {
  return fs.existsSync(path.join(nodeModules, name, 'package.json'));
}

function main() {
  const declared = declaredPackages();
  const missing = declared.filter((n) => !isInstalled(n));

  if (declared.length && missing.length === 0) {
    // Everything already present — nothing to do, start fast.
    return 0;
  }

  if (missing.length) {
    console.log(`Installing/updating dependencies (${missing.length} missing: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''})`);
    console.log('This can take a minute…');
  } else {
    console.log('Installing dependencies, this can take a minute…');
  }

  // Run through a shell. On Windows, `npm` is a `.cmd` batch file, and newer
  // Node versions refuse to spawn `.cmd`/`.bat` directly (they throw EINVAL
  // since the CVE-2024-27980 fix) unless a shell resolves it — so `shell: true`
  // is required there. On macOS/Linux a shell resolves `npm` on PATH just the
  // same. Args here are fixed literals ("install"), so there's nothing to inject.
  const res = spawnSync('npm', ['install'], { cwd: appDir, stdio: 'inherit', shell: true });
  if (res.error) { console.error(`Could not run npm: ${res.error.message}`); return 1; }
  if (res.status !== 0) return res.status || 1;

  // Verify the install actually resolved what was missing (e.g. an EBUSY lock
  // can make npm exit 0-ish but leave a package unwritten). Report clearly.
  const stillMissing = declared.filter((n) => !isInstalled(n));
  if (stillMissing.length) {
    console.error('');
    console.error(`Some dependencies are still missing after install: ${stillMissing.join(', ')}`);
    console.error('If you are on Windows, make sure every AutoInjector window is fully closed');
    console.error('(check the system tray and Task Manager for electron.exe), then try again —');
    console.error('a running copy locks files and blocks the update.');
    return 1;
  }
  return 0;
}

process.exit(main());
