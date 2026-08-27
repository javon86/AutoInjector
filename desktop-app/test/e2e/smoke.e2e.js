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
    assert(await controls.$('#atelier-cockpit') && await controls.$('#btn-ax-start') && await controls.$('#ax-req'),
      'the ATELIER v3 engine cockpit (Start / Requirements / derived state) is present');
    // Unique title per run — books persist to disk, so a fixed title would clash.
    const bookTitle = 'E2E Book ' + Date.now();
    await controls.fill('#book-new-title', bookTitle);
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

    // Start Making Book -> workflow enters "running", the banner shows step 1,
    // and Pause/Continue appear. (The intake prompt is sent to the ChatGPT pane;
    // in the sandbox the pane isn't logged in, which is expected.)
    await controls.click('#btn-book-start');
    const running = await controls.waitForFunction(() => {
      const s = document.getElementById('book-workflow-status');
      const pause = document.getElementById('btn-book-pause');
      return s && /Step 1\//.test(s.textContent) && pause && pause.style.display !== 'none';
    }, { timeout: 6000 }).then(() => true).catch(() => false);
    assert(running, 'Start Making Book launches the workflow at step 1 (Pause/Continue appear)');
    // The persistent bottom-bar tally shows where the workflow is, always visible.
    const tallyShown = await controls.waitForFunction(() => {
      const t = document.getElementById('book-tally');
      return t && /Section 1\/\d/.test(t.textContent);
    }, { timeout: 5000 }).then(() => true).catch(() => false);
    assert(tallyShown, 'the persistent bottom-bar tally shows "Section 1/N"');
    // UI-001: the single guided readiness line reflects step + a clear next action.
    const readiness = await controls.evaluate(() => {
      const step = document.getElementById('rd-step');
      const next = document.getElementById('rd-next');
      return { step: step && step.textContent, next: next && next.textContent };
    });
    assert(readiness.step && /1\//.test(readiness.step), `readiness line shows the current step ("${readiness.step}")`);
    assert(readiness.next && /Continue|answer/i.test(readiness.next), `readiness line names the one next action ("${(readiness.next || '').slice(0, 50)}")`);
    // Step 1 is the intake questionnaire — an "ask-user" step, so the runner
    // waits for the human (it must NOT auto-advance). The Continue button says
    // so, and the status names the intake questions.
    const asksUser = await controls.evaluate(() => {
      const c = document.getElementById('btn-book-continue');
      const s = document.getElementById('book-workflow-status');
      return !!c && /answered/i.test(c.textContent) && !!s && /intake/i.test(s.textContent);
    });
    assert(asksUser, 'the first step waits for you (intake questionnaire, "I\'ve answered — Continue")');
    // The AI-readiness line reports on the three panes ("make sure AI is up").
    await controls.click('#btn-book-check-ai');
    const aiLine = await controls.waitForFunction(() => {
      const e = document.getElementById('book-ai-status');
      return e && /ChatGPT/.test(e.textContent) && /Gemini/.test(e.textContent);
    }, { timeout: 6000 }).then(() => true).catch(() => false);
    assert(aiLine, 'the AI-readiness line reports on the ChatGPT / Claude / Gemini panes');
    // The Rules of Conduct ("bible") button is present and, when pressed, is
    // logged into the book's activity log (the send itself is best-effort in the
    // sandbox where panes aren't logged in, but the log entry is local).
    assert(await controls.$('#btn-book-send-rules'), 'the "Send Rules" (bible) button is present');
    await controls.click('#btn-book-send-rules');
    const ruleLogged = await controls.waitForFunction(() => {
      const box = document.getElementById('book-log');
      return box && /Rules of Conduct/i.test(box.textContent);
    }, { timeout: 6000 }).then(() => true).catch(() => false);
    assert(ruleLogged, 'sending the Rules of Conduct is recorded in the activity log');

    // PDF completion gate: the panel is present and lists the chapter as a
    // deliverable; "Make PDFs" produces a real PDF and the gate flips to ✓.
    assert(await controls.$('#book-pdf-gate'), 'the PDF completion-gate panel is present');
    const gateHasChapter = await controls.waitForFunction(() => {
      const box = document.getElementById('book-pdf-gate');
      return box && /Chapter/.test(box.textContent) && /⏳/.test(box.textContent);
    }, { timeout: 4000 }).then(() => true).catch(() => false);
    assert(gateHasChapter, 'the gate lists the chapter as a deliverable, waiting on its PDF (⏳)');
    await controls.click('#btn-book-make-pdfs');
    const gateChecked = await controls.waitForFunction(() => {
      const box = document.getElementById('book-pdf-gate');
      const cnt = document.getElementById('book-pdf-count');
      return box && /✓/.test(box.textContent) && cnt && /have a PDF/.test(cnt.textContent);
    }, { timeout: 8000 }).then(() => true).catch(() => false);
    assert(gateChecked, 'Make PDFs creates the PDFs and the gate marks the deliverable complete (✓)');
    // A real .pdf file exists on disk under some book's pdfs/ folder, and it's a
    // valid PDF (starts with the header). (docs/fs/pathMod resolved above.)
    let pdfPath = null;
    try {
      const booksRoot = docs ? pathMod.join(docs, 'AutoInjector', 'output', 'books') : null;
      if (booksRoot && fs.existsSync(booksRoot)) {
        for (const d of fs.readdirSync(booksRoot)) {
          const pdir = pathMod.join(booksRoot, d, 'pdfs');
          if (fs.existsSync(pdir)) { const hit = fs.readdirSync(pdir).find((f) => f.toLowerCase().endsWith('.pdf')); if (hit) { pdfPath = pathMod.join(pdir, hit); break; } }
        }
      }
    } catch (_) {}
    assert(pdfPath, `a real .pdf file was written into a book's pdfs/ folder (${pdfPath || 'none found'})`);
    if (pdfPath) assert(fs.readFileSync(pdfPath).slice(0, 5).toString() === '%PDF-', 'that file is a valid PDF (starts with %PDF-)');

    // Pause -> Resume controls swap in.
    await controls.click('#btn-book-pause');
    const paused = await controls.waitForFunction(() => {
      const r = document.getElementById('btn-book-resume');
      return r && r.style.display !== 'none';
    }, { timeout: 5000 }).then(() => true).catch(() => false);
    assert(paused, 'Pause shows the Resume control (workflow is pausable)');
    await shot(controls, 'book-studio');

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
    // The Book Studio real round-trip Test button is present (not clicked here —
    // it waits on live replies the sandbox panes can't give).
    assert(await controls.$('#btn-book-test'), 'the Book Studio "Test AIs" round-trip button is present');

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

    // Keyboard-only: a new book can be created without the mouse.
    const kbTitle = 'KB Book ' + Date.now();
    await controls.focus('#book-new-title');
    await controls.keyboard.type(kbTitle);
    await controls.focus('#btn-book-new');
    await controls.keyboard.press('Enter');
    const kbCreated = await controls.waitForFunction((t) => {
      const sel = document.getElementById('book-select');
      return sel && Array.from(sel.options).some((o) => o.textContent.includes(t));
    }, kbTitle, { timeout: 6000 }).then(() => true).catch(() => false);
    assert(kbCreated, 'a book can be created with the keyboard only (focus + type + Enter)');

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
