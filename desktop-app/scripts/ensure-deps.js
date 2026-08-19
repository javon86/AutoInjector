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

  // Only `electron` has a heavy post-install step (it downloads and unpacks its
  // runtime). If electron is already present and only leaf packages like
  // systeminformation / jsdom are missing, install *just those by name* and skip
  // lifecycle scripts — that way npm never re-lays-down electron, so a running
  // copy holding electron's files (the classic Windows EBUSY lock) can't block
  // the install at all. If electron itself is missing (a fresh checkout), fall
  // back to a full install so its runtime gets unpacked.
  const needsFullInstall = missing.includes('electron') || missing.length === declared.length;
  const args = needsFullInstall
    ? ['install', '--no-audit', '--no-fund']
    : ['install', ...missing, '--no-audit', '--no-fund', '--ignore-scripts'];

  // Run through a shell. On Windows, `npm` is a `.cmd` batch file, and newer
  // Node versions refuse to spawn `.cmd`/`.bat` directly (they throw EINVAL
  // since the CVE-2024-27980 fix) unless a shell resolves it — so `shell: true`
  // is required there. On macOS/Linux a shell resolves `npm` on PATH just the
  // same. All args are fixed package names / flags, so there's nothing to inject.
  const res = spawnSync('npm', args, { cwd: appDir, stdio: 'inherit', shell: true });
  const installFailed = !!res.error || res.status !== 0;

  // Whether npm reported success or not, check what's actually on disk now.
  const stillMissing = declared.filter((n) => !isInstalled(n));

  if (installFailed || stillMissing.length) {
    console.error('');
    if (res.error) console.error(`Could not run npm: ${res.error.message}`);
    if (stillMissing.length) console.error(`Still missing after install: ${stillMissing.join(', ')}`);
    console.error('');
    console.error('If you saw a "EBUSY / resource busy or locked" error above, a running copy of');
    console.error('the app is holding its files. Close every AutoInjector window, then check');
    console.error('Task Manager for any leftover "electron" process and end it (or just reboot),');
    console.error('and run the launcher again.');
    return 1;
  }
  return 0;
}

process.exit(main());
