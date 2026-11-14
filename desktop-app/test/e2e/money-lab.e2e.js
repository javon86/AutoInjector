'use strict';
// money-lab.e2e.js — 🧪 the Money lab in the REAL app: the 🧪 button in the title bar opens the lab window, the page
// loads with the real preload (no page errors), the form is filled with the defaults, and on a PC without Windows
// Sandbox (this Linux test machine) it says so and ▶ Start stays off. The title bar still fits at 1280 px.
//   TMPDIR=/dev/shm xvfb-run -a node test/e2e/money-lab.e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeAsserts, findWindow, shot, APP_DIR } = require('./helpers');
const electron = require('playwright')._electron;

async function main() {
  const { assert, state } = makeAsserts();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'money-lab-home-'));
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], cwd: APP_DIR,
    env: Object.assign({}, process.env, { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), AUTOINJECTOR_BRIDGE: '0', AUTOINJECTOR_CHECKIN: '0',
      AUTOINJECTOR_CONTENT_SCAN: '0', AUTOINJECTOR_AKOWE_SERVER: '0', AUTOINJECTOR_SD_AUTOSTART: '0', AUTOINJECTOR_VIDEO_AUTOSTART: '0',
      AUTOINJECTOR_AKOWE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'money-lab-nobf-')) }),
  });
  try {
    const controls = await findWindow(app, '#up-zone-compose', 40000);
    assert(!!controls, 'control panel appears');
    if (!controls) return 1;
    await controls.setViewportSize({ width: 1280, height: 760 }).catch(() => {});
    await controls.waitForTimeout(300);
    const bar = await controls.evaluate(() => {
      const b = document.getElementById('window-titlebar');
      const lab = document.getElementById('btn-lab').getBoundingClientRect();
      return { over: b.scrollWidth - b.clientWidth, labVisible: lab.width > 0 && lab.right <= window.innerWidth + 0.5 };
    });
    assert(bar.over <= 0 && bar.labVisible, `the 🧪 button is in the title bar and it still fits at 1280 px (over by ${bar.over})`);
    await controls.click('#btn-lab');
    const lab = await findWindow(app, '#lab-start', 20000);
    assert(!!lab, 'the 🧪 Money lab window opens');
    if (!lab) return 1;
    const errors = [];
    lab.on('pageerror', (e) => errors.push(String(e)));
    await lab.waitForFunction(() => document.getElementById('lab-mission').value.length > 20 && document.getElementById('lab-phase').textContent !== '…', null, { timeout: 15000 });
    const v = await lab.evaluate(() => ({
      mission: document.getElementById('lab-mission').value, claude: document.getElementById('lab-ai-claude').checked, codex: document.getElementById('lab-ai-codex').checked,
      hours: document.getElementById('lab-hours').value, phase: document.getElementById('lab-phase').textContent, availHidden: document.getElementById('lab-avail').hidden,
      availWords: document.getElementById('lab-avail-words').textContent, enableHidden: document.getElementById('lab-enable').hidden,
      startOff: document.getElementById('lab-start').disabled, hasApi: !!(window.api && window.api.labStatus),
      noScroll: document.documentElement.scrollWidth <= window.innerWidth + 1,
    }));
    assert(v.hasApi, 'the lab page has the app\'s API (the real preload)');
    assert(/honest, legal way to earn/.test(v.mission) && v.claude && v.codex && v.hours === '2', 'the form shows the default mission, both AIs, 2 hours');
    assert(v.phase === 'Closed', `the lab is shown as closed (${v.phase})`);
    assert(!v.availHidden && /only works on Windows/.test(v.availWords) && v.enableHidden && v.startOff, 'not Windows → it says so, no "turn on" button, ▶ Start off');
    await lab.setViewportSize({ width: 420, height: 800 }).catch(() => {});
    await lab.waitForTimeout(200);
    assert(await lab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'a narrow lab window does not scroll sideways');
    await lab.setViewportSize({ width: 1040, height: 860 }).catch(() => {});
    await shot(lab, 'money-lab-window');
    // 💾 Save writes the settings through the real IPC
    await lab.fill('#lab-hours', '5');
    await lab.click('#lab-save');
    await lab.waitForFunction(() => /Saved/.test(document.getElementById('lab-msg').textContent), null, { timeout: 10000 });
    const saved = await lab.evaluate(() => window.api.labStatus().then((s) => s.settings.hours));
    assert(saved === 5, 'Save keeps the settings (read back through lab:status)');
    assert(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  } finally {
    await app.close().catch(() => {});
  }
  return state.failed ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
