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
      ['#btn-ai-toggle', '🎩 Alfred On/Off (User Panel)'],
      ['#col-systemai', 'System AI panel'],
      ['#col-houserules', 'House Rules panel'],
      ['#col-gpu', 'GPU Usage panel'],
      ['#gpu-body', 'GPU readout'],
      ['#col-device', 'Butler Device panel'],
      ['#btn-selfcheck', 'System Check button'],
      ['#btn-install-missing', 'Install Missing button'],
      ['#btn-send-intro', 'Send Intro button'],
      ['#speaking-indicator', 'Who\'s-speaking indicator'],
      ['#jarvis-goal', 'Merged butler task box'],
      ['#btn-cap-run', 'Butler-panel Test-all-capabilities button'],
      ['#btn-butler-status', '🎩 Alfred status light'],
      ['#btn-butler-mode', '🧠 what Alfred thinks with'],
      ['#cap-reel', 'Capability live reel'],
      ['#cap-modal', 'Capability results modal'],
      ['#btn-device-ptt', 'Push-to-talk button'],
      ['#device-openmic', 'Open-mic toggle'],
      ['#voice-v-butler', 'Per-speaker voice (butler)'],
      ['#voice-mic', 'Microphone picker'],
      ['#voice-speaker', 'Speaker picker'],
      ['#panels-grid', 'Tiled panels grid'],
      ['#ai-row', 'AI panes row'],
      ['#btn-extract-all', 'Extract All button'],
      ['#btn-capability-test', 'User-Panel 🩺 Check Alfred button'],
      ['#log-filters', 'Unified-log tag filter bar'],
      ['#cb-errors-only', 'Errors-only log toggle'],
      ['#activity-log', 'Unified activity log'],
      ['#btn-silence', 'Stop AIs Talking button'],
      ['#btn-open-phone', 'Phone companion button'],
      ['#phone-panel', 'Phone connect panel'],
      ['#phone-lan-toggle', 'Phone LAN-access toggle'],
      ['#btn-open-image', '🎨 Images button (opens the Images tab)'],
      ['#btn-open-video', '🎬 Video button (opens the Video tab)'],
      ['#sd-adv-server', 'Images tab → ⚙ Start & install → Advanced: another server'],
      ['#sd-ep-preset', 'Images tab: common SD addresses dropdown'],
      ['#btn-sd-ep-detect', 'Images tab: SD address auto-detect button'],
      ['#btn-sd-ep-test', 'Images tab: SD address check button'],
      ['#vd-advanced', 'Video tab → ⚙ Setup & models → Advanced: other video server'],
      ['#vd-ep-preset', 'Video tab: common video server addresses dropdown'],
      ['#btn-vd-ep-detect', 'Video tab: video server auto-detect button'],
      ['#btn-vd-ep-test', 'Video tab: video server check button'],
      ['#jarvis-goal', 'Butler goal box'],
      ['#btn-jarvis-start', 'Start Butler button'],
      ['#lsi-pull-name', 'Pull-any-model field'],
      ['#lsi-uncensored', 'Prefer-uncensored-models toggle'],
      ['#lsi-approval', 'Approval-mode safeguard toggle'],
      ['#btn-approve', 'Approve-action button'],
      ['#cb-deep-check', 'Deep capability-test toggle'],
      ['#btn-open-models', 'Open-models-folder button'],
      ['#btn-ollama-migrate', 'Move-downloaded-models button'],
      ['#models-store-status', 'LLM storage status line'],
      ['#btn-download-logs', 'Download-all-logs button'],
      ['#jarvis-tools', 'Tools registry list'],
      ['#jarvis-awareness', 'Awareness readout'],
      ['#voice-enabled', 'Voice toggle'],
      ['#btn-mic', 'Push-to-talk mic button'],
      ['#btn-feature-test', '🔬 Feature Test button'],
      ['#term-output', 'Terminal output'],
      ['#term-input', 'Terminal command box'],
      ['#locker-list-claude', "Claude's locker file list"],
      ['#compose-attachments', 'Compose attachment chips'],
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

    await checkPaneRects(app, controls, assert);

    // The one "stuff and thing" folder is laid out INSIDE the app folder (one
    // level above desktop-app), same as main.js's contentBaseFolder().
    const fs = require('fs'), pathMod = require('path');
    const appFolder = pathMod.join(__dirname, '..', '..', '..');
    const outRoot = pathMod.join(appFolder, 'stuff and thing');
    assert(fs.existsSync(outRoot) && fs.existsSync(pathMod.join(outRoot, 'README.txt')),
      `the "stuff and thing" folder is created on launch with a README (${outRoot})`);

    // Downloads live in its models/ subfolder (with per-kind subfolders + a README).
    const modelsRoot = pathMod.join(outRoot, 'models');
    assert(fs.existsSync(modelsRoot) && fs.existsSync(pathMod.join(modelsRoot, 'llm')) && fs.existsSync(pathMod.join(modelsRoot, 'README.txt')),
      `models folder created inside it with subfolders + README (${modelsRoot})`);

    await shot(controls, 'control-panel');

    console.log('\n== ONE way to make pictures and clips: the old Image/Video panels are gone ==');
    const leftovers = await controls.evaluate(() => ['col-image', 'col-video', 'img-endpoint', 'vid-endpoint', 'btn-img-generate', 'btn-vid-generate'].filter((id) => document.getElementById(id)));
    assert(leftovers.length === 0, `no old Image/Video Generation panel is left (${leftovers.join(', ') || 'none'})`);
    {
      // The top area, for shots/control-panel-clean.png (the action bar with 🎨 Images / 🎬 Video).
      const fs = require('fs'), pathMod = require('path');
      const vp = await controls.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      const dir = pathMod.join(__dirname, '__screenshots__');
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
      const file = pathMod.join(dir, 'control-panel-clean.png');
      await controls.screenshot({ path: file, clip: { x: 0, y: 0, width: vp.w, height: Math.min(vp.h, 520) } });
      try { fs.copyFileSync(file, pathMod.join(__dirname, '..', '..', '..', 'shots', 'control-panel-clean.png')); } catch (_) {}
    }
    await controls.click('#btn-open-image');
    const imagesShown = await controls.waitForFunction(() => document.body.dataset.appTab === 'images' && !document.getElementById('images-tab').hidden, { timeout: 6000 }).then(() => true).catch(() => false);
    assert(imagesShown, '🎨 Images in the action bar opens the 🎨 Images tab');
    await controls.click('#sd-sub-setup');
    await controls.click('#sd-adv-server summary');
    const sdAdvOk = await controls.waitForFunction(() => { const s = document.getElementById('sd-ep-preset'); return !!(s && s.offsetParent && s.options.length >= 2); }, { timeout: 6000 }).then(() => true).catch(() => false);
    assert(sdAdvOk, '⚙ Start & install → Advanced: another server shows the common SD addresses (moved from the old panel)');
    await controls.click('#tab-app-main');
    await controls.click('#btn-open-video');
    const videoShown = await controls.waitForFunction(() => document.body.dataset.appTab === 'video' && !document.getElementById('video-tab').hidden, { timeout: 6000 }).then(() => true).catch(() => false);
    assert(videoShown, '🎬 Video in the action bar opens the 🎬 Video tab');
    await controls.click('#vd-sub-setup');
    await controls.click('#vd-advanced summary');
    const vdAdvOk = await controls.waitForFunction(() => { const s = document.getElementById('vd-ep-preset'); return !!(s && s.offsetParent && s.options.length >= 2 && document.getElementById('vd-ep-frames')); }, { timeout: 6000 }).then(() => true).catch(() => false);
    assert(vdAdvOk, '⚙ Setup & models → Advanced: other video server shows the common video servers + clip settings (moved from the old panel)');
    await controls.click('#tab-app-main');
    await controls.waitForFunction(() => document.body.dataset.appTab === 'main', { timeout: 4000 }).catch(() => {});

    console.log('\n== Activity trace: a real button click is logged as ui-click ==');
    await controls.click('#btn-extract-all');
    const loggedClick = await controls.waitForFunction(
      () => { const b = document.getElementById('activity-log'); return !!(b && /ui-click/.test(b.textContent) && /extract/i.test(b.textContent)); },
      { timeout: 6000 }).then(() => true).catch(() => false);
    assert(loggedClick, 'clicking a button writes a ui-click line into the Activity Log');
    // P16: the click opened the Extract dialog (nothing saved yet) — Cancel it.
    const dialogOpen = await controls.waitForFunction(
      () => { const m = document.getElementById('extract-modal'); const c = document.getElementById('ex-counts'); return !!(m && m.classList.contains('on') && c && /Will save:/.test(c.textContent)); },
      { timeout: 6000 }).then(() => true).catch(() => false);
    assert(dialogOpen, 'Extract All opens the Extract dialog with a preview (counts) first');
    assert(await controls.evaluate(() => !document.getElementById('ex-scope-all').checked), 'the dialog never defaults to Everything');
    await shot(controls, 'extract-dialog');
    await controls.click('#btn-extract-cancel');

    console.log('\n== ⤓ Extract All writes the conversation + activity log to a text file ==');
    await controls.click('#btn-extract-all');
    await controls.waitForFunction(() => { const c = document.getElementById('ex-counts'); return !!(c && /Will save:/.test(c.textContent)); }, { timeout: 6000 }).catch(() => {});
    await controls.click('#btn-extract-save'); // the safe default (no Akọwe book here: the last 24 hours)
    const wroteLog = await controls.waitForFunction(
      () => { const s = document.getElementById('extract-status'); return !!(s && /Saved/.test(s.textContent)); },
      { timeout: 8000 }).then(() => true).catch(() => false);
    assert(wroteLog, 'clicking Extract All reports the saved file in the status line');
    if (outRoot) {
      const logsDir = pathMod.join(outRoot, 'logs');
      const files = fs.existsSync(logsDir) ? fs.readdirSync(logsDir).filter((f) => /^AutoInjector log - last 24 h - .*\.txt$/.test(f)) : [];
      assert(files.length >= 1, `a .txt extract named by its scope was written into output/logs (${files.length})`);
      if (files.length) {
        const newest = files.map((f) => pathMod.join(logsDir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
        const body = fs.readFileSync(newest, 'utf8');
        assert(/AI CONVERSATION/.test(body) && /ACTIVITY \/ TROUBLESHOOTING/.test(body), 'the extract file contains BOTH the conversation and the activity/error sections');
        assert(/WHAT IS IN THIS FILE/.test(body) && /Scope: +Time range/.test(body), 'its header states the scope');
      }
    }
    await shot(controls, 'control-panel-extracted');

    console.log('\n== ⤓ Everything needs a second, explicit confirmation that names what is in it ==');
    await controls.click('#btn-extract-all');
    await controls.waitForFunction(() => { const c = document.getElementById('ex-counts'); return !!(c && /Will save:/.test(c.textContent)); }, { timeout: 6000 }).catch(() => {});
    await controls.click('#ex-scope-all');
    await controls.waitForFunction(() => document.getElementById('ex-scope-all-row').classList.contains('sel'), { timeout: 6000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    await controls.click('#btn-extract-save');
    const asked = await controls.waitForFunction(
      () => { const c = document.getElementById('ex-confirm-all'); const t = document.getElementById('ex-confirm-all-text'); return !!(c && !c.hidden && t && /messages? .*including older private conversations/.test(t.textContent)); },
      { timeout: 6000 }).then(() => true).catch(() => false);
    assert(asked, 'Save on Everything asks a second time, naming the messages and older private conversations');
    const noEverythingFile = !outRoot || !fs.existsSync(pathMod.join(outRoot, 'logs')) || !fs.readdirSync(pathMod.join(outRoot, 'logs')).some((f) => /everything/.test(f));
    assert(noEverythingFile, 'nothing is written before the confirmation');
    await controls.click('#btn-extract-confirm-back');
    await controls.click('#btn-extract-cancel');
    await controls.click('#btn-extract-all');
    await controls.waitForFunction(() => { const c = document.getElementById('ex-counts'); return !!(c && /Will save:/.test(c.textContent)); }, { timeout: 6000 }).catch(() => {});
    assert(await controls.evaluate(() => !document.getElementById('ex-scope-all').checked && document.getElementById('ex-scope-time').checked), 'reopening remembers the last saved choice, never Everything');
    await controls.click('#btn-extract-cancel');

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
      // Butler self-install: the one-button Auto-setup + the per-target list.
      assert(await wizard.$('#btn-setup-auto'), 'the Installs tab has the 🚀 Auto-setup button (butler self-install)');
      const setupTargets = await wizard.waitForFunction(() => document.querySelectorAll('#setup-targets .item').length > 0, { timeout: 8000 }).then(() => true).catch(() => false);
      const targetCount = await wizard.$$eval('#setup-targets .item', (els) => els.length).catch(() => 0);
      assert(setupTargets && targetCount >= 3, `the Installs tab lists the self-install targets (${targetCount} shown)`);
      await shot(wizard, 'setup-wizard-advanced');

      // The wizard's Images / Video tabs are short notes: pictures and videos are set up in the main window's tabs.
      assert(await wizard.$('.tab[data-tab="images"]') && await wizard.$('.tab[data-tab="video"]'), 'the wizard still has its Images and Video tabs (as notes)');
      await wizard.click('.tab[data-tab="video"]');
      assert(await wizard.$('#btn-wz-open-video') && !(await wizard.$('#vd-endpoint')), 'the Video note has “🎬 Open the Video tab” and no duplicate endpoint form');
      await wizard.click('.tab[data-tab="images"]');
      assert(await wizard.$('#btn-wz-open-images') && !(await wizard.$('#sd-endpoint')), 'the Images note has “🎨 Open the Images tab” and no duplicate endpoint form');
      await shot(wizard, 'setup-wizard-images');
      // The button closes the wizard (so click from inside the page) and shows the 🎨 Images tab in the main window.
      await wizard.evaluate(() => document.getElementById('btn-wz-open-images').click()).catch(() => {});
      const switched = await controls.waitForFunction(() => document.body.dataset.appTab === 'images' && !document.getElementById('images-tab').hidden, { timeout: 8000 }).then(() => true).catch(() => false);
      assert(switched, '“🎨 Open the Images tab” shows the 🎨 Images tab in the main window (wizard:open-app-tab)');
      const wizardGone = await (async () => { for (let i = 0; i < 20; i++) { if (!app.windows().some((w) => !w.isClosed() && /setup-wizard\.html/.test(w.url()))) return true; await new Promise((r) => setTimeout(r, 250)); } return false; })();
      assert(wizardGone, 'and the Setup Wizard closes');
      await controls.click('#tab-app-main');
      await controls.waitForFunction(() => document.body.dataset.appTab === 'main', { timeout: 4000 }).catch(() => {});
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
    await shutdown(app);
    process.exit(state.failed ? 1 : 0);
  } catch (e) {
    console.error('e2e crashed:', e && e.stack || e);
    await shutdown(app);
    process.exit(1);
  }
}

// The AI windows: each real web page (a native WebContentsView) must sit EXACTLY on
// its .pane-slot — clipped below the sticky User Panel and to the window bottom —
// at the common window sizes, after scrolling, and when a pane is reduced or
// minimized. The slots are 25% taller than the old 280px (350px).
const PANE_SITES = ['chatgpt', 'claude', 'gemini'];
async function paneViewBounds(app) {
  return app.evaluate(({ BaseWindow }, sites) => {
    const w = BaseWindow.getAllWindows().find((b) => b.contentView && b.contentView.children.length >= 4);
    const out = {};
    for (const v of (w ? w.contentView.children : [])) {
      let p = '';
      try { p = String(v.webContents.session.getStoragePath() || ''); } catch (_) {}
      const site = sites.find((s) => new RegExp(`[\\\\/]${s}$`).test(p));
      if (site) out[site] = v.getBounds();
    }
    return out;
  }, PANE_SITES);
}
// Where the page says each pane should be (the same clipping as main.js / pane-layout.js).
async function expectedPaneRects(controls) {
  return controls.evaluate((sites) => {
    const up = document.getElementById('col-userpanel').getBoundingClientRect();
    const top = Math.max(0, Math.round(up.bottom)), bottom = window.innerHeight;
    const out = {};
    for (const s of sites) {
      const e = document.getElementById('pane-slot-' + s);
      const r = e && e.getBoundingClientRect();
      if (!r) { out[s] = null; continue; }
      const x = Math.round(r.x), y = Math.round(r.y), w = Math.round(r.width), h = Math.round(r.height);
      const y1 = Math.max(y, top), y2 = Math.min(y + h, bottom);
      out[s] = { slotH: h, rect: (w < 4 || y2 - y1 < 40) ? null : { x, y: y1, width: w, height: y2 - y1 } };
    }
    return out;
  }, PANE_SITES);
}
async function panesMatch(app, controls) {
  // Ask main to place the panes now, then compare (a couple of tries: layout may still be settling).
  let last = '';
  for (let i = 0; i < 6; i++) {
    await controls.evaluate(() => window.api.syncPanes && window.api.syncPanes()).catch(() => {});
    const [exp, got] = [await expectedPaneRects(controls), await paneViewBounds(app)];
    const bad = [];
    for (const s of PANE_SITES) {
      const e = exp[s] && exp[s].rect, g = got[s];
      if (!g) { bad.push(`${s}: no view`); continue; }
      if (!e) { if (!(g.x <= -1000 || g.width === 0)) bad.push(`${s}: should be off-screen, is ${JSON.stringify(g)}`); continue; }
      const off = Math.max(Math.abs(e.x - g.x), Math.abs(e.y - g.y), Math.abs(e.width - g.width), Math.abs(e.height - g.height));
      if (off > 1) bad.push(`${s}: slot ${JSON.stringify(e)} vs view ${JSON.stringify(g)}`);
    }
    if (!bad.length) return { ok: true, exp };
    last = bad.join('; ');
    await new Promise((r) => setTimeout(r, 400));
  }
  return { ok: false, why: last };
}
async function checkPaneRects(app, controls, assert) {
  console.log('\n== AI windows: 25% taller, and each real page sits exactly on its slot ==');
  const before = await app.evaluate(({ BaseWindow }) => { const w = BaseWindow.getAllWindows().find((b) => b.contentView && b.contentView.children.length >= 4); return w ? w.getContentSize() : null; });
  const setSize = (W, H) => app.evaluate(({ BaseWindow }, [W, H]) => { const w = BaseWindow.getAllWindows().find((b) => b.contentView && b.contentView.children.length >= 4); if (w) w.setContentSize(W, H); }, [W, H]);
  const scrollTo = (y) => controls.evaluate((y) => { document.getElementById('wrap').scrollTop = y; }, y);
  for (const [W, H] of [[1280, 800], [1920, 1080]]) {
    await setSize(W, H);
    await controls.waitForFunction((w) => Math.abs(window.innerWidth - w) <= 2, W, { timeout: 5000 }).catch(() => {});
    await scrollTo(0);
    await new Promise((r) => setTimeout(r, 500));
    const exp = await expectedPaneRects(controls);
    const heights = PANE_SITES.map((s) => exp[s] && exp[s].slotH);
    assert(heights.every((h) => h >= 350), `${W}×${H}: every AI window is at least 350px tall — 25% more than the old 280px (${heights.join(', ')})`);
    const atTop = await controls.evaluate(() => { const a = document.getElementById('ai-row').getBoundingClientRect(); const u = document.getElementById('col-userpanel').getBoundingClientRect(); return a.top - u.bottom; });
    assert(atTop >= 0 && atTop <= 20, `${W}×${H}: the AI windows come right under the User Panel (gap ${Math.round(atTop)}px)`);
    let m = await panesMatch(app, controls);
    assert(m.ok, `${W}×${H}: the three AI pages sit exactly on their slots${m.ok ? '' : ` — ${m.why}`}`);
    await scrollTo(300);
    m = await panesMatch(app, controls);
    assert(m.ok, `${W}×${H}, scrolled 300px: the AI pages follow their slots and stay below the User Panel${m.ok ? '' : ` — ${m.why}`}`);
    await scrollTo(1e6);
    m = await panesMatch(app, controls);
    assert(m.ok, `${W}×${H}, scrolled to the bottom: AI pages scrolled out of view are moved off-screen${m.ok ? '' : ` — ${m.why}`}`);
    await scrollTo(0);
  }
  // Reduce / minimize Claude: its page leaves, the other two widen and stay on their slots.
  const cycle = () => controls.click('#col-claude .card-head .collapse-btn');
  await cycle();
  let m = await panesMatch(app, controls);
  assert(m.ok && await controls.evaluate(() => document.getElementById('col-claude').classList.contains('state-reduced')), `Claude reduced: its page is hidden, the others stay on their slots${m.ok ? '' : ` — ${m.why}`}`);
  await cycle();
  m = await panesMatch(app, controls);
  assert(m.ok && await controls.evaluate(() => document.getElementById('col-claude').classList.contains('state-min')), `Claude minimized: ChatGPT and Gemini widen and their pages follow${m.ok ? '' : ` — ${m.why}`}`);
  await controls.click('#col-claude');
  m = await panesMatch(app, controls);
  assert(m.ok && await controls.evaluate(() => document.getElementById('col-claude').classList.contains('state-open')), `Claude opened again: all three pages back on their slots${m.ok ? '' : ` — ${m.why}`}`);
  // The 🎩 Butler section (below the AI windows) folds in place to its one-line header and opens again.
  const wasFolded = await controls.evaluate(() => document.getElementById('col-systemai').classList.contains('hidden-collapsed'));
  if (!wasFolded) await controls.click('#btn-collapse-systemai');
  const folded = await controls.evaluate(() => { const p = document.getElementById('col-systemai'); const b = document.getElementById('systemai-body'); const r = p.getBoundingClientRect(); return { panel: p.offsetParent !== null && r.height > 20 && r.height < 80, body: b.offsetParent !== null, open: !!document.getElementById('tab-systemai') }; });
  assert(folded.panel && !folded.body && folded.open, `the 🎩 Butler section folds to one visible line with an ▸ Open button (${JSON.stringify(folded)})`);
  await controls.click('#tab-systemai');
  assert(await controls.isVisible('#llm-setup'), '▸ Open shows the Butler section again (his AI setup box)');
  if (wasFolded) await controls.click('#btn-collapse-systemai');
  if (before) await setSize(before[0], before[1]);
  await new Promise((r) => setTimeout(r, 400));
}

// Close the app, but never wait forever: CI runs used to sit until GitHub's
// 6-hour limit because app.close() (or a child process the app started) never
// returned. Give it 15s, then kill the whole Electron process tree.
async function shutdown(app) {
  const timedOut = await Promise.race([
    app.close().then(() => false, () => false),
    new Promise((r) => setTimeout(() => r(true), 15000)),
  ]);
  if (timedOut) console.error('app.close() did not finish in 15s — killing Electron');
  try {
    const proc = app.process && app.process();
    if (proc && proc.pid && proc.exitCode == null) {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch (_) {}
      try { proc.kill('SIGKILL'); } catch (_) {}
    }
  } catch (_) {}
}

// Hard backstop: whatever happens, this script ends within 12 minutes.
setTimeout(() => { console.error('e2e watchdog: still running after 12 minutes — exiting'); process.exit(1); }, 12 * 60 * 1000).unref();
main();
