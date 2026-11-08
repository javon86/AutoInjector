'use strict';
// ease.e2e.js — the REAL app's ease-of-use helpers, at 1280×720 (pictures at 2×):
//   * ✅ the Setup checklist opens by itself on the first start (fake AI sites, a fake Forge, Akọwe switched off)
//   * its Fix it buttons act: "Turn Gemini on", "🧙 Install it" opens the Setup Wizard, "Open 🎨 Images" opens the tab,
//     and a fake Forge connected afterwards turns its row ✅ on ↻ Check again
//   * 🧭 the 🎨 Images tour opens the first time that tab opens, steps through to Done and does not come back
//   * 🩺 Something's wrong? lists a problem planted in the activity log, with its fix, and makes a support report
//   * 📖 ❓ Help → User guide opens the guide in its own window
//   * after a restart: "don't show again" keeps the checklist closed, and a finished tour stays finished
// Pictures go to EASE_SHOT_DIR (or __screenshots__).   xvfb-run -a node test/e2e/ease.e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findWindow, makeAsserts, APP_DIR, SHOT_DIR } = require('./helpers');
const { fakeA1111 } = require('../fixtures/fake-sd');

let electron;
try { electron = require('playwright')._electron; } catch (_) { console.error('needs playwright'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { assert, state } = makeAsserts();
  const shotDir = process.env.EASE_SHOT_DIR || SHOT_DIR;
  fs.mkdirSync(shotDir, { recursive: true });
  // 2× pictures: the app runs at device scale 2 (--force-device-scale-factor=2) in a 1280×720 window
  const shot = async (page, name) => { try { await page.screenshot({ path: path.join(shotDir, `${name}.png`) }); } catch (_) {} };
  const size1280 = async (a) => { try { await a.evaluate(({ BaseWindow }) => { const w = BaseWindow.getAllWindows().find((x) => /Automation/.test(x.getTitle())) || BaseWindow.getAllWindows()[0]; w.setContentSize(1280, 720); }); } catch (_) {} await sleep(600); };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ease-e2e-'));
  const userData = path.join(tmp, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  // planted: Stable Diffusion failed 5 times an hour ago (the debug log the app reads for the last 24 hours)
  const now = Date.now();
  fs.writeFileSync(path.join(userData, 'autoinjector-debug.log'), Array.from({ length: 5 }, (_, i) => JSON.stringify({ ts: now - 3600e3 + i * 1000, kind: 'sd-runner-error', level: 'error', tag: 'images', detail: { error: 'EXITED' } })).join('\n') + '\n');
  const sd = await fakeA1111({ flavor: 'forge' });
  const fake = 'file://' + path.join(APP_DIR, 'test', 'fixtures', 'fake-chat.html');
  const launch = () => electron.launch({
    args: ['.', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--force-device-scale-factor=2', `--user-data-dir=${userData}`],
    cwd: APP_DIR,
    env: Object.assign({}, process.env, {
      HOME: tmp, AUTOINJECTOR_EASE_AUTO: '1', AUTOINJECTOR_AKOWE_SERVER: '0', AUTOINJECTOR_CHECKIN: '0', AUTOINJECTOR_BRIDGE: '0', AUTOINJECTOR_HEALTH: '0',
      AUTOINJECTOR_CONTENT_SCAN: '0', AUTOINJECTOR_SD_AUTOSTART: '0', AUTOINJECTOR_SD_HOME: path.join(tmp, 'sdhome'), AUTOINJECTOR_SD_MODEL_DIRS: path.join(tmp, 'models'),
      AUTOINJECTOR_SITE_URL_CHATGPT: fake, AUTOINJECTOR_SITE_URL_CLAUDE: fake, AUTOINJECTOR_SITE_URL_GEMINI: fake,
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    }),
  });
  let app = await launch();
  let reportFile = null;
  try {
    const c = await findWindow(app, '#up-zone-compose', 40000);
    assert(!!c, 'the control panel appears');
    if (!c) throw new Error('no window');
    await size1280(app);
    const row = (id) => c.$(`.ease-row[data-id="${id}"]`);
    const rowOk = (id) => c.$eval(`.ease-row[data-id="${id}"]`, (r) => r.dataset.ok).catch(() => null);
    const skipTour = async () => { if (await c.$('#ease-tour')) await c.click('#ease-tour-skip').catch(() => {}); };

    console.log('\n== ✅ the checklist opens by itself on the first start ==');
    await c.waitForSelector('#ease-checklist[role="dialog"]', { timeout: 25000 }).catch(() => {});
    assert(!!(await c.$('#ease-checklist')), 'the ✅ Setup checklist is open');
    await c.waitForSelector('.ease-row[data-id="disk"]', { timeout: 15000 }).catch(() => {});
    const groups = await c.$$eval('#ease-checklist .ease-group', (g) => g.map((x) => x.textContent));
    assert(groups.join('|') === 'Needed for books|Optional extras', `grouped: ${groups.join(' | ')}`);
    const ids = await c.$$eval('.ease-row', (r) => r.map((x) => x.dataset.id));
    assert(['pane-chatgpt', 'pane-claude', 'pane-gemini', 'akowe', 'content', 'disk', 'alfred-ai', 'voice', 'sd', 'video', 'claude-code'].every((id) => ids.includes(id)), `every row: ${ids.join(', ')}`);
    assert(await rowOk('akowe') === 'false' && /Turn it on/.test(await c.textContent('.ease-row[data-id="akowe"] button')), 'Akọwe is switched off here → ❌ with "Turn it on and start it"');
    assert(await rowOk('content') === 'true', 'the content folder → ✅');
    const fits = await c.evaluate(() => { const b = document.querySelector('#ease-checklist .ease-box').getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth; });
    assert(fits, 'it fits in 1280×720 (no sideways scrolling)');
    assert(await c.evaluate(() => { const b = document.querySelector('#btn-ease-help').getBoundingClientRect(); return b.right <= innerWidth && b.width > 30; }), 'the ❓ Help button fits in the title bar at 1280');
    await shot(c, 'ease-01-checklist-1280x720');

    console.log('\n== ✅ Fix it buttons act ==');
    await c.evaluate(() => window.api.setParticipant('gemini', false));
    await c.click('#ease-checklist-recheck');
    await c.waitForFunction(() => /Turn Gemini on/.test((document.querySelector('.ease-row[data-id="pane-gemini"] button') || {}).textContent || ''), null, { timeout: 10000 }).catch(() => {});
    assert(/switched off/.test(await c.textContent('.ease-row[data-id="pane-gemini"]')), 'Gemini unticked → "switched off" + Turn Gemini on');
    await c.click('.ease-row[data-id="pane-gemini"] button');
    await c.waitForFunction(() => !/Turn Gemini on/.test((document.querySelector('.ease-row[data-id="pane-gemini"]') || {}).textContent || 'Turn Gemini on'), null, { timeout: 10000 }).catch(() => {});
    assert(!/switched off/.test(await c.textContent('.ease-row[data-id="pane-gemini"]')) && await c.evaluate(() => document.getElementById('p-gemini') ? document.getElementById('p-gemini').checked : true), 'Turn Gemini on: Gemini is active again');
    await c.click('.ease-row[data-id="voice"] button');
    const wiz = await findWindow(app, '.tab[data-tab="advanced"]', 15000);
    assert(!!wiz, '"🧙 Install it" opens the Setup Wizard');
    if (wiz) await c.evaluate(() => window.api.closeWizard()).catch(() => {});
    await sleep(500);
    await c.check('#ease-dont-show');
    // the fake Forge: Check again turns Stable Diffusion ✅
    const sdBefore = await rowOk('sd');
    const con = await c.evaluate((u) => window.api.sd.connect(u), sd.base);
    await c.click('#ease-checklist-recheck');
    await c.waitForFunction(() => (document.querySelector('.ease-row[data-id="sd"]') || {}).dataset.ok === 'true', null, { timeout: 15000 }).catch(() => {});
    assert(sdBefore === 'false' && con && con.ok && await rowOk('sd') === 'true' && /Connected to/.test(await c.textContent('.ease-row[data-id="sd"]')), `Stable Diffusion: ⚪ before, ✅ "Connected to…" after the fake Forge answers (${sdBefore} → ${await rowOk('sd')})`);
    // a row with "Open 🎬 Video" closes the checklist and opens that tab
    await c.click('.ease-row[data-id="video"] button');
    await c.waitForFunction(() => document.body.dataset.appTab === 'video' && !document.getElementById('ease-checklist'), null, { timeout: 8000 }).catch(() => {});
    assert(await c.evaluate(() => document.body.dataset.appTab === 'video' && !document.getElementById('ease-checklist')), '"Open 🎬 Video" closes the checklist and shows the 🎬 Video tab');

    console.log('\n== 🧭 a tour the first time a page opens ==');
    await c.waitForSelector('#ease-tour[data-tour="video"]', { timeout: 8000 }).catch(() => {});
    assert(!!(await c.$('#ease-tour[data-tour="video"]')), 'the 🎬 Video tour opens the first time the tab opens');
    await shot(c, 'ease-03-tour-step-1280x720');
    const texts = [];
    for (let i = 0; i < 8; i++) {
      texts.push(await c.textContent('#ease-tip-text'));
      const inView = await c.evaluate(() => { const t = document.querySelector('#ease-tour .ease-tip').getBoundingClientRect(); return t.left >= 0 && t.right <= innerWidth && t.top >= 0 && t.bottom <= innerHeight; });
      assert(inView, `step ${i + 1}: the bubble is on the screen`);
      if (await c.$('#ease-tour-done')) { await c.click('#ease-tour-done'); break; }
      await c.click('#ease-tour-next');
    }
    assert(texts.length >= 3 && texts.length <= 5 && !(await c.$('#ease-tour')), `${texts.length} steps, then Done closes it`);
    await c.click('#tab-app-main');
    await sleep(1200); await skipTour();
    await c.click('#tab-app-video');
    await sleep(1500);
    assert(!(await c.$('#ease-tour')), 'opening 🎬 Video again: the tour does not come back');
    await c.click('#tab-app-main');
    await sleep(900); await skipTour();

    console.log("\n== 🩺 Something's wrong? ==");
    await c.click('#btn-ease-help');
    await c.click('#ease-m-problems');
    await c.waitForSelector('#ease-problems .ease-row, #ease-nothing', { timeout: 30000 }).catch(() => {});
    const probs = await c.$$eval('#ease-problems .ease-row', (r) => r.map((x) => x.textContent));
    const planted = probs.find((t) => /Pictures/.test(t) && /5 errors in the last 24 hours/.test(t) && /sd-runner-error/.test(t));
    assert(!!planted, `the planted problem is listed: "${(planted || probs.join(' / ')).slice(0, 160)}"`);
    assert(await c.$$eval('#ease-problems .ease-row', (r) => r.some((x) => /Pictures/.test(x.textContent) && x.querySelector('button'))), 'with its fix button (Open 🎨 Images)');
    await shot(c, 'ease-02-somethings-wrong-1280x720');
    await c.click('#ease-report');
    await c.waitForFunction(() => /Saved|could not/.test(document.getElementById('ease-report-msg').textContent), null, { timeout: 20000 }).catch(() => {});
    const msg = await c.textContent('#ease-report-msg');
    reportFile = (msg.match(/Saved: (.+?\.txt)/) || [])[1] || null;
    assert(reportFile && fs.existsSync(reportFile), `📄 Make a report for support: ${msg.slice(0, 120)}`);
    if (reportFile) {
      const text = fs.readFileSync(reportFile, 'utf8');
      assert(/the last 24 hours/.test(text) && /AI conversation:\s+not included/.test(text) && !/Everything — includes all conversations/.test(text), 'the report: last 24 hours, no conversation, never Everything');
    }
    await c.keyboard.press('Escape');
    assert(!(await c.$('#ease-problems')), 'Esc closes it');

    console.log('\n== 📖 ❓ Help → User guide ==');
    await c.click('#btn-ease-help');
    await c.click('#ease-m-guide');
    const titles = await (async () => { for (let i = 0; i < 25; i++) { const t = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().map((w) => w.getTitle())); if (t.includes('AutoInjector — User guide')) return t; await sleep(200); } return []; })();
    assert(titles.includes('AutoInjector — User guide'), `a "User guide" window opens (${titles.join(' | ')})`);
    let guideUrl = '';
    for (let i = 0; i < 25 && !/^data:text\/html/.test(guideUrl); i++) {
      guideUrl = await app.evaluate(({ BaseWindow }) => { const w = BaseWindow.getAllWindows().find((x) => x.getTitle() === 'AutoInjector — User guide'); const v = w && w.contentView.children[0]; return v ? v.webContents.getURL().slice(0, 40) : ''; }).catch(() => '');
      if (!/^data:text\/html/.test(guideUrl)) await sleep(200);
    }
    assert(/^data:text\/html/.test(guideUrl), 'it shows the rendered guide');
  } finally {
    await app.close().catch(() => {});
  }

  console.log('\n== after a restart ==');
  app = await launch();
  try {
    const c = await findWindow(app, '#up-zone-compose', 40000);
    await size1280(app);
    await sleep(6000);
    assert(!(await c.$('#ease-checklist')), '"Don\'t show this by itself again" → the checklist stays closed');
    assert(!(await c.$('#ease-tour')), 'the main tour (skipped) does not come back');
    await c.click('#tab-app-video'); await sleep(1500);
    assert(!(await c.$('#ease-tour')), 'nor the 🎬 Video tour (done)');
    await c.click('#btn-ease-help'); await c.click('#ease-m-checklist');
    await c.waitForSelector('.ease-row[data-id="disk"]', { timeout: 20000 }).catch(() => {});
    assert(!!(await c.$('#ease-checklist')), 'it still opens from ❓ Help → ✅ Setup checklist');
  } finally {
    await app.close().catch(() => {});
    await sd.close();
    if (reportFile) { try { fs.unlinkSync(reportFile); } catch (_) {} }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  process.exit(state.failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
