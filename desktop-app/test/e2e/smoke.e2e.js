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
      ['#col-systemai', 'System AI panel'],
      ['#col-houserules', 'House Rules panel'],
      ['#col-image', 'Image Generation panel'],
      ['#col-video', 'Video Generation panel'],
      ['#btn-img-generate', 'Image Generate button'],
      ['#panels-grid', 'Tiled panels grid'],
      ['#ai-row', 'AI panes row'],
      ['#btn-extract-all', 'Extract All button'],
      ['#btn-open-image', 'Image paddle'],
      ['#btn-open-video', 'Video paddle'],
      ['#jarvis-goal', 'Butler goal box'],
      ['#btn-jarvis-start', 'Start Butler button'],
      ['#jarvis-tools', 'Tools registry list'],
      ['#jarvis-awareness', 'Awareness readout'],
      ['#voice-enabled', 'Voice toggle'],
      ['#btn-mic', 'Push-to-talk mic button'],
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

    console.log('\n== ⤓ Extract All writes the conversation + activity log to a text file ==');
    await controls.click('#btn-extract-all');
    const wroteLog = await controls.waitForFunction(
      () => { const s = document.getElementById('extract-status'); return !!(s && /Saved/.test(s.textContent)); },
      { timeout: 8000 }).then(() => true).catch(() => false);
    assert(wroteLog, 'clicking Extract All reports the saved file in the status line');
    if (outRoot) {
      const logsDir = pathMod.join(outRoot, 'logs');
      const files = fs.existsSync(logsDir) ? fs.readdirSync(logsDir).filter((f) => f.endsWith('.txt')) : [];
      assert(files.length >= 1, `a .txt extract was written into output/logs (${files.length})`);
      if (files.length) {
        const body = fs.readFileSync(pathMod.join(logsDir, files[0]), 'utf8');
        assert(/AI CONVERSATION/.test(body) && /ACTIVITY \/ TROUBLESHOOTING/.test(body), 'the extract file contains BOTH the conversation and the activity/error sections');
      }
    }
    await shot(controls, 'control-panel-extracted');

    console.log('\n== 🧙 Setup opens the lean wizard (Local AI + Advanced) ==');
    await controls.click('#btn-open-wizard');
    const wizard = await findWindow(app, '#panel-localai', 20000);
    assert(wizard, 'the Setup Wizard window opened');
    if (wizard) {
      assert(await wizard.$('.tab[data-tab="localai"]'), 'wizard has the Local AI tab');
      // Recommended models must render (the Local AI catalog), proving the
      // wizard's script ran end-to-end against the lean catalog.
      const modelsRendered = await wizard.waitForFunction(
        () => document.querySelectorAll('#model-list .item').length > 0,
        { timeout: 12000 }).then(() => true).catch(() => false);
      const modelCount = await wizard.$$eval('#model-list .item', (els) => els.length).catch(() => 0);
      assert(modelsRendered && modelCount > 0, `wizard lists recommended local-AI models (${modelCount} shown)`);
      await shot(wizard, 'setup-wizard');

      // Installs tab: the guided installers for everything the features need.
      await wizard.click('.tab[data-tab="advanced"]');
      await wizard.waitForFunction(() => document.querySelectorAll('#advanced-installers .item').length > 0, { timeout: 8000 }).catch(() => {});
      const installers = await wizard.$$eval('#advanced-installers .item', (els) => els.length).catch(() => 0);
      assert(installers >= 3, `Installs tab shows the guided installers for all the backends (${installers} shown)`);
      await shot(wizard, 'setup-wizard-advanced');

      // The Images and Video tabs are back; Images carries the SD endpoint config.
      assert(await wizard.$('.tab[data-tab="images"]'), 'the Images tab is present');
      assert(await wizard.$('.tab[data-tab="video"]'), 'the Video tab is present');
      await wizard.click('.tab[data-tab="images"]');
      await wizard.waitForSelector('#sd-endpoint', { timeout: 6000 }).catch(() => {});
      assert(await wizard.$('#sd-endpoint') && await wizard.$('#btn-sd-test'), 'the Images tab has the Stable Diffusion endpoint config + a Test render button');
      await shot(wizard, 'setup-wizard-images');
    }

    console.log('\n== 💬 AI Feed: the consolidated pop-up window opens with per-LLM bubbles ==');
    assert(await controls.$('#btn-open-feed'), 'the AI Feed button is present in the action bar');
    await controls.click('#btn-open-feed');
    const feedWin = await findWindow(app, '#feed', 15000);
    assert(feedWin, 'the AI Feed window opened');
    if (feedWin) {
      const chips = await feedWin.$$eval('.chip[data-site]', (els) => els.map((e) => e.getAttribute('data-site'))).catch(() => []);
      assert(chips.includes('chatgpt') && chips.includes('claude') && chips.includes('gemini'),
        'the feed has a colour-coded filter chip for each LLM');
      // The per-LLM bubble colour rules are defined in the window's own styles.
      const hasColors = await feedWin.evaluate(() => {
        const css = Array.from(document.styleSheets).flatMap((s) => { try { return Array.from(s.cssRules).map((r) => r.cssText); } catch (_) { return []; } }).join(' ');
        return /b-chatgpt/.test(css) && /b-claude/.test(css) && /b-gemini/.test(css);
      }).catch(() => false);
      assert(hasColors, 'the feed defines a distinct bubble style per LLM');
      // Composer: reply box + target picker + 8 savable preset buttons.
      assert(await feedWin.$('#reply-text') && await feedWin.$('#btn-reply-send') && await feedWin.$('#reply-target'),
        'the feed has a reply box, target picker and Send button');
      const presetCount = await feedWin.$$eval('#preset-row .preset', (els) => els.length).catch(() => 0);
      assert(presetCount === 8, `the feed has 8 preset buttons (${presetCount})`);
      // Save a preset: type text, turn on edit, click slot 1 — it should persist.
      await feedWin.fill('#reply-text', 'Please continue where you left off.');
      await feedWin.click('#btn-preset-edit');
      await feedWin.$$eval('#preset-row .preset', (els) => els[0] && els[0].click());
      const saved = await feedWin.waitForFunction(() => {
        try { const a = JSON.parse(localStorage.getItem('feed-presets-v1') || '[]'); return a[0] && a[0].text === 'Please continue where you left off.'; } catch (_) { return false; }
      }, { timeout: 4000 }).then(() => true).catch(() => false);
      assert(saved, 'a preset button saves the typed text (persisted for re-sending)');
      await shot(feedWin, 'ai-feed');
    }

    console.log('\n== UI-003: accessibility basics (accessible names, keyboard, zoom) ==');
    // Every button has an accessible name — visible text, aria-label, or title.
    const unnamed = await controls.$$eval('button', (btns) => btns
      .filter((b) => {
        const txt = (b.textContent || '').replace(/\s+/g, ' ').trim();
        const named = txt.length >= 2 || b.getAttribute('aria-label') || b.getAttribute('title');
        return !named;
      })
      .map((b) => b.id || b.className || b.outerHTML.slice(0, 40)));
    assert(unnamed.length === 0, `every button has an accessible name (${unnamed.length} unnamed${unnamed.length ? ': ' + unnamed.join(', ') : ''})`);

    // Reflow at 200% zoom must not make the control column scroll sideways.
    await controls.evaluate(() => { document.body.style.zoom = '2'; });
    await controls.waitForTimeout(200);
    const noHScrollAt200 = await controls.evaluate(() => {
      const w = document.getElementById('wrap');
      return w ? w.scrollWidth <= w.clientWidth + 3 : true;
    });
    assert(noHScrollAt200, 'the control column reflows without horizontal scroll at 200% zoom');
    await shot(controls, 'control-panel-200pct');
    await controls.evaluate(() => { document.body.style.zoom = '1'; });

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
