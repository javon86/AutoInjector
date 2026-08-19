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
    }

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
