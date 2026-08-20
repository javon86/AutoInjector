'use strict';
// smoke.e2e.js — launch the REAL Electron app and verify the control panel and
// the Setup Wizard actually render and respond. This is the test that catches
// the visual/layout things unit tests can't. Run under a display:
//   xvfb-run -a node test/e2e/smoke.e2e.js
const { launchApp, findWindow, shot, makeAsserts } = require('./helpers');

async function main() {
  const { assert, state } = makeAsserts();
  const { app, controls } = await launchApp();
  try {
    console.log('\n== Control panel renders with the expected controls ==');
    // The User Panel and its buttons (the ones we added this session).
    for (const [sel, label] of [
      ['#up-zone-compose', 'Compose box'],
      ['#btn-open-wizard', '🧙 Setup button'],
      ['#btn-new-chat-all', 'Start New Chat button'],
      ['#btn-ai-toggle', 'System AI toggle'],
      ['#btn-run-test', 'Test button'],
      ['#col-systemai', 'System AI panel'],
      ['#col-system', 'System Monitor panel'],
      ['#ai-row', 'AI panes row'],
    ]) {
      assert(await controls.$(sel), `${label} is present (${sel})`);
    }

    // Layout sanity: the page must not scroll sideways (a recurring bug class).
    const overflowsX = await controls.evaluate(() => {
      const w = document.getElementById('wrap');
      return w ? w.scrollWidth > w.clientWidth + 2 : false;
    });
    assert(!overflowsX, 'the control column does not overflow horizontally');

    // The three AI panes exist and keep their fixed order.
    const order = await controls.evaluate(() => {
      const row = document.getElementById('expanded-strip') || document.getElementById('ai-row');
      return row ? Array.from(row.querySelectorAll('.ai-col')).map((c) => c.id) : [];
    });
    assert(
      order.length === 0 || (order[0] === 'col-chatgpt' && order[order.length - 1] === 'col-gemini'),
      `AI panes are in fixed order (${order.join(', ') || 'not yet built'})`
    );

    // The output folder is laid out under Documents on startup.
    const docs = await app.evaluate(({ app: a }) => a.getPath('documents')).catch(() => null);
    const fs = require('fs'), pathMod = require('path');
    const outRoot = docs ? pathMod.join(docs, 'AutoInjector', 'output') : null;
    assert(outRoot && fs.existsSync(outRoot), `output folder created on launch (${outRoot})`);

    await shot(controls, 'control-panel');

    console.log('\n== 🧙 Setup opens the wizard, which scans and lists downloads ==');
    await controls.click('#btn-open-wizard');
    const wizard = await findWindow(app, '#tray-list', 20000);
    assert(wizard, 'the Setup Wizard window opened');
    if (wizard) {
      assert(await wizard.$('.tab[data-tab="localai"]'), 'wizard has the Local AI tab');
      // The scan line must actually finish (not stay on "Scanning…") — this is
      // what catches a wizard script that died on load.
      const scanned = await wizard.waitForFunction(() => {
        const s = document.getElementById('scan');
        return s && s.textContent && !/Scanning your machine/.test(s.textContent);
      }, { timeout: 15000 }).then(() => true).catch(() => false);
      assert(scanned, 'wizard hardware scan completed (not stuck on "Scanning…")');
      const scanText = await wizard.$eval('#scan', (e) => e.textContent).catch(() => '');
      assert(/machine|GPU|RAM|run|install/i.test(scanText), `scan line shows real info ("${scanText.slice(0, 60)}")`);
      // Recommended models must render (the Local AI catalog), proving the
      // wizard's script ran end-to-end.
      const modelCount = await wizard.$$eval('#model-list .item', (els) => els.length).catch(() => 0);
      assert(modelCount > 0, `wizard lists recommended models (${modelCount} shown)`);
      await shot(wizard, 'setup-wizard');

      // Images tab: switch to it and confirm the SD engine + checkpoint cards render.
      await wizard.click('.tab[data-tab="images"]');
      await wizard.waitForFunction(() => {
        const p = document.getElementById('panel-images');
        return p && p.classList.contains('active') && document.querySelectorAll('#sd-model-list .item').length > 0;
      }, { timeout: 8000 }).catch(() => {});
      const engine = await wizard.$('#sd-engine .item');
      const sdModels = await wizard.$$eval('#sd-model-list .item', (els) => els.length).catch(() => 0);
      assert(engine, 'Images tab shows the Forge engine card');
      assert(sdModels > 0, `Images tab lists SD checkpoints (${sdModels} shown)`);
      await shot(wizard, 'setup-wizard-images');

      // Video tab: ComfyUI engine + video model cards.
      await wizard.click('.tab[data-tab="video"]');
      await wizard.waitForFunction(() => document.querySelectorAll('#video-model-list .item').length > 0, { timeout: 8000 }).catch(() => {});
      assert(await wizard.$('#video-engine .item'), 'Video tab shows the ComfyUI engine card');
      const vidModels = await wizard.$$eval('#video-model-list .item', (els) => els.length).catch(() => 0);
      assert(vidModels > 0, `Video tab lists video models (${vidModels} shown)`);

      // Advanced tab: guided installer cards (Ollama, Python).
      await wizard.click('.tab[data-tab="advanced"]');
      await wizard.waitForFunction(() => document.querySelectorAll('#advanced-installers .item').length > 0, { timeout: 8000 }).catch(() => {});
      const installers = await wizard.$$eval('#advanced-installers .item', (els) => els.length).catch(() => 0);
      assert(installers >= 2, `Advanced tab shows guided installers (${installers} shown)`);
      await shot(wizard, 'setup-wizard-video-advanced');
    }

    console.log('\n== Book Studio: create a book, stages/tasks/records render ==');
    assert(await controls.$('#col-bookstudio'), 'Book Studio panel is present');
    await controls.fill('#book-new-title', 'E2E Test Novel');
    await controls.click('#btn-book-new');
    // The new book becomes the selected project and renders its stage tracker.
    const created = await controls.waitForFunction(() => {
      const sel = document.getElementById('book-select');
      return sel && sel.value && document.querySelectorAll('#book-stages button').length >= 8;
    }, { timeout: 8000 }).then(() => true).catch(() => false);
    assert(created, 'creating a book selects it and renders the 8 stage steps');
    const taskBtns = await controls.$$eval('#book-tasks button', (els) => els.length).catch(() => 0);
    assert(taskBtns >= 10, `task buttons render (${taskBtns})`);
    // Add a chapter and confirm it appears with a status control.
    await controls.click('#btn-book-add-chapter');
    const hasChapter = await controls.waitForFunction(() => document.querySelectorAll('#book-chapters select').length > 0, { timeout: 6000 }).then(() => true).catch(() => false);
    assert(hasChapter, 'adding a chapter shows it with a status dropdown');
    await shot(controls, 'book-studio');

    console.log(`\n${state.passed} passed, ${state.failed} failed`);
    await app.close();
    process.exit(state.failed ? 1 : 0);
  } catch (e) {
    console.error('e2e crashed:', e && e.stack || e);
    await app.close().catch(() => {});
    process.exit(1);
  }
}
main();
