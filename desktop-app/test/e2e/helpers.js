'use strict';
// helpers.js — shared plumbing for the Playwright/Electron end-to-end tests.
// Launches the REAL app (via the electron in node_modules) and hands back the
// control-panel window. Needs a display; in CI/sandbox run under `xvfb-run`.
const path = require('path');
// Playwright is intentionally NOT a dependency (keeps end-user installs light).
// Install it just for e2e: `npm install --no-save playwright`.
let electron;
try { electron = require('playwright')._electron; }
catch (_) {
  console.error('These GUI tests need Playwright (not a project dependency).');
  console.error('Install it first:  npm install --no-save playwright');
  console.error('Then on Linux run under a virtual display:  xvfb-run -a npm run test:e2e');
  process.exit(2);
}

const APP_DIR = path.join(__dirname, '..', '..');
const SHOT_DIR = path.join(__dirname, '__screenshots__');

/** Launch the app and return { app, controls } — controls is the control panel page. */
async function launchApp() {
  // --no-sandbox / --disable-dev-shm-usage are needed to run Chromium/Electron
  // inside CI containers and this sandbox; harmless on a normal desktop.
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    cwd: APP_DIR,
  });
  const controls = await findWindow(app, '#up-zone-compose', 40000);
  if (!controls) { await app.close().catch(() => {}); throw new Error('control panel window never appeared'); }
  await controls.waitForSelector('#up-zone-compose', { timeout: 10000 });
  return { app, controls };
}

/** Poll all app windows until one contains `selector`. */
async function findWindow(app, selector, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        if (await w.$(selector)) return w;
      } catch (_) { /* window may be mid-navigation */ }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

/** Save a screenshot under __screenshots__/. */
async function shot(page, name) {
  const fs = require('fs');
  try { fs.mkdirSync(SHOT_DIR, { recursive: true }); } catch (_) {}
  const file = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

// A tiny assert + summary harness matching the other test files.
function makeAsserts() {
  const state = { passed: 0, failed: 0 };
  const assert = (cond, msg) => {
    if (cond) { state.passed++; console.log(`  ok   - ${msg}`); }
    else { state.failed++; console.log(`  FAIL - ${msg}`); }
    return cond;
  };
  return { assert, state };
}

module.exports = { launchApp, findWindow, shot, makeAsserts, APP_DIR, SHOT_DIR };
