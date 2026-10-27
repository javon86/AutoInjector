'use strict';
// alfred.e2e.js — 🎩 Alfred inside the REAL Electron app: the switch starts Off (no drawer), turning him
// On opens his FLOATING side panel — its own window, a child of the main window, drawn over the whole app
// (proved from the screen's own pixels, over the AI panes and over the native Akọwe view); Ctrl+Shift+A
// shows / hides it from the control panel and from the panel itself. In that panel, with a fake OpenAI-compatible model (like Ollama /v1) that returns tool
// calls he answers "what's the status of my book?" from the REAL Akọwe server AutoInjector starts,
// and "make an image of a lighthouse" goes through the "I will" card -> ✔ Do it -> the image path
// (the 🎨 Images module, sd-api.js, against a fake Forge server) -> a saved PNG. Then ⚙ "Docked (beside)" closes
// the window and brings back the drawer exactly as before (room made beside it, works over the 📖 Akọwe tab).
//   xvfb-run -a node test/e2e/alfred.e2e.js
// Env: AKOWE_E2E_PYTHON (default python3); SHOTS=<dir> (default: test/e2e/__screenshots__/alfred).
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');
const { makeAsserts, APP_DIR } = require('./helpers');
const { fakeLlm, toolCall, lastMsg, lastUser } = require('../alfred-fakes');
const { fakeA1111 } = require('../fixtures/fake-sd');
const electron = require('playwright')._electron;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.SHOTS || path.join(__dirname, '__screenshots__', 'alfred');
function freePort() { return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
async function until(fn, ms, every = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(every); }
  return null;
}
async function shot(page, name) {
  try { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); console.log(`  (screenshot ${name}.png)`); } catch (e) { console.log(`  (no screenshot ${name}: ${String(e.message || e).slice(0, 80)})`); }
}
function screen(name) { // the whole screen, incl. the native Akọwe view over the tab
  if (!process.env.DISPLAY) return;
  try { fs.mkdirSync(SHOTS, { recursive: true }); execFileSync('import', ['-window', 'root', path.join(SHOTS, `${name}.png`)], { timeout: 15000 }); console.log(`  (screenshot ${name}.png)`); }
  catch (e) { console.log(`  (no screen shot: ${String(e.message || e).slice(0, 80)})`); }
}

/**
 * Proof the panel window is drawn on top: grab the whole X screen and the panel's own page, and
 * compare a few patches at the same spots. They match only when nothing covers the panel.
 */
async function overProof(page, b, tag) {
  if (!process.env.DISPLAY) return { ok: true, detail: 'no display — skipped' };
  try {
    fs.mkdirSync(SHOTS, { recursive: true });
    const scr = path.join(SHOTS, `_screen-${tag}.png`); const own = path.join(SHOTS, `_panel-${tag}.png`);
    await page.screenshot({ path: own });
    execFileSync('import', ['-window', 'root', scr], { timeout: 15000 });
    const mean = (file, x, y) => execFileSync('convert', [file, '-crop', `16x16+${x}+${y}`, '+repage', '-resize', '1x1!', '-format', '%[fx:int(255*r)],%[fx:int(255*g)],%[fx:int(255*b)]', 'info:'], { timeout: 10000 }).toString().split(',').map(Number);
    const spots = [[8, 8], [Math.round(b.width / 2), 60], [20, Math.round(b.height / 2)], [b.width - 40, b.height - 30]];
    let worst = 0; const seen = [];
    for (const [x, y] of spots) {
      const a = mean(scr, b.x + x, b.y + y); const c = mean(own, x, y);
      const d = Math.max(...a.map((v, i) => Math.abs(v - c[i])));
      worst = Math.max(worst, d); seen.push(`${a.join('/')}≈${c.join('/')}`);
    }
    try { fs.unlinkSync(scr); fs.unlinkSync(own); } catch (_) {}
    return { ok: worst <= 24, detail: `max colour difference ${worst} at ${spots.length} spots (${seen.slice(0, 2).join(', ')})` };
  } catch (e) { return { ok: true, detail: `could not grab the screen (${String(e.message || e).slice(0, 60)}) — skipped` }; }
}
/** Keep a feature screenshot in the repo's shots/ folder. */
function keep(name, as) { try { const src = path.join(SHOTS, `${name}.png`); if (fs.existsSync(src)) fs.copyFileSync(src, path.join(APP_DIR, '..', 'shots', as)); } catch (_) {} }

/** The fake model: call book_status / generate_image for the two questions, then answer from the result. */
function script(body) {
  const last = lastMsg(body);
  if (last.role === 'tool') {
    let r = {}; try { r = JSON.parse(last.content); } catch (_) {}
    if (last.name === 'book_status') {
      const d = r.data || {};
      const books = (d.books || []).map((b) => `“${b.title}”`).join(', ') || 'no books yet';
      const steps = d.checklist ? d.checklist.steps.map((s) => `${s.title}: ${s.state}`).slice(0, 3).join('; ') : 'no checklist';
      return { content: `📖 Your books: ${books}. ${d.run ? `Run: ${d.run.status}.` : 'No “Make a book for me” run is going.'} Checklist — ${steps}.` };
    }
    if (last.name === 'generate_image') return { content: r.ok ? `Here is your lighthouse: ${r.data && r.data.path}` : `The image failed: ${r.message}` };
    return { content: 'Done.' };
  }
  const u = String((lastUser(body) || {}).content || '').toLowerCase();
  if (/status/.test(u)) return toolCall('book_status', {});
  if (/image|picture/.test(u)) return toolCall('generate_image', { prompt: 'a lighthouse on a cliff at dusk, warm light' });
  return { content: 'Good day.' };
}

async function main() {
  const { assert, state } = makeAsserts();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-e2e-home-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-e2e-akowe-'));
  const fake = 'file://' + path.join(APP_DIR, 'test', 'fixtures', 'fake-chat.html');
  const madeFiles = []; // the picture this test makes (removed afterwards)
  const llm = await fakeLlm(script);
  const sd = await fakeA1111({ flavor: 'forge' });
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], cwd: APP_DIR,
    env: Object.assign({}, process.env, {
      HOME: home, AKOWE_DATA: data, AUTOINJECTOR_AKOWE_SERVER: '1', AUTOINJECTOR_AKOWE_PYTHON: process.env.AKOWE_E2E_PYTHON || 'python3',
      AUTOINJECTOR_AKOWE_PORT: String(await freePort()), AUTOINJECTOR_CHECKIN: '0', AUTOINJECTOR_BRIDGE: '0',
      AUTOINJECTOR_SD_AUTOSTART: '0', AUTOINJECTOR_SD_HOME: path.join(home, 'sdhome'), AUTOINJECTOR_SD_MODEL_DIRS: path.join(home, 'models'),
      AUTOINJECTOR_SITE_URL_CHATGPT: fake, AUTOINJECTOR_SITE_URL_CLAUDE: fake, AUTOINJECTOR_SITE_URL_GEMINI: fake,
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    }),
  });
  try {
    const controls = await until(async () => { for (const w of app.windows()) { if (await w.$('#btn-alfred-switch').catch(() => null)) return w; } return null; }, 40000, 400);
    assert(!!controls, 'the control panel appears with the 🎩 switch');
    if (!controls) return 1;
    await controls.setViewportSize({ width: 1500, height: 950 }).catch(() => {});

    console.log('\n== Off by default: only the switch ==');
    const sw = await controls.textContent('#btn-alfred-switch');
    assert(sw === '🎩 Alfred: Off', `the switch reads "${sw}"`);
    assert(!(await controls.$('#alfred-drawer')) && !(await controls.evaluate(() => document.body.classList.contains('alfred-open'))), 'no drawer and no layout change while Off');
    assert(llm.requests.length === 0, 'no AI call while Off');
    await shot(controls, '01-off-only-the-switch');

    console.log('\n== the real Akọwe runs; it has one book ==');
    const st = await until(async () => { const s = await controls.evaluate(() => window.api.akoweServerStatus()); return s && (s.phase === 'running' || s.phase === 'failed') ? s : null; }, 120000, 400);
    assert(st && st.phase === 'running', `Akọwe is running (${st && st.phase}${st && st.message ? ': ' + st.message : ''})`);
    if (!st || st.phase !== 'running') return 1;
    await controls.click('#tab-app-akowe');
    const akPage = await until(async () => app.windows().find((w) => { try { return w.url().startsWith(`http://127.0.0.1:${st.port}/`); } catch (_) { return false; } }), 30000, 300);
    assert(!!akPage, 'the Akọwe page loads in the tab');
    if (!akPage) return 1;
    await akPage.waitForSelector('h1', { timeout: 30000 }).catch(() => {});
    const made = await until(() => akPage.evaluate(async () => {
      const tok = sessionStorage.getItem('bf_token') || localStorage.getItem('bf_token');
      if (!tok) return null;
      const r = await fetch('/api/projects', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'The Lighthouse Keeper' }) });
      return r.status;
    }), 15000, 500);
    assert(made === 201, `a book "The Lighthouse Keeper" exists in Akọwe (${made})`);
    await controls.click('#tab-app-main');

    console.log('\n== turn him On: his floating side panel opens OVER the app ==');
    const con = await controls.evaluate((u) => window.api.sd.connect(u), sd.base);
    assert(con && con.ok !== false, `Stable Diffusion (fake Forge) connected through the 🎨 Images module (${con && (con.label || con.message || con.error)})`);
    await controls.click('#btn-alfred-switch');
    const on = await until(async () => (await controls.textContent('#btn-alfred-switch')) === '🎩 Alfred: On', 5000, 150);
    assert(!!on, 'the switch reads On');
    const panel = await until(async () => { for (const w of app.windows()) { try { if (/alfred-window\.html/.test(w.url()) && await w.$('#alfred-input')) return w; } catch (_) {} } return null; }, 15000, 200);
    assert(!!panel, 'his floating panel window opens (alfred-window.html, the same chat UI)');
    if (!panel) return 1;
    assert(!(await controls.$('#alfred-drawer')) && !(await controls.evaluate(() => document.body.classList.contains('alfred-open'))), 'Floating is the default: no drawer, the control panel keeps its full width');
    const geo = () => app.evaluate(({ BaseWindow, BrowserWindow, screen }) => {
      const p = BrowserWindow.getAllWindows().find((w) => /alfred-window\.html/.test(w.webContents.getURL()));
      const m = BaseWindow.getAllWindows().find((w) => /Automation/.test(w.getTitle()));
      if (!p || !m) return null;
      const par = p.getParentWindow();
      return { visible: p.isVisible(), parented: !!par && par.id === m.id, onTop: p.isAlwaysOnTop(), b: p.getBounds(), m: m.getContentBounds(), d: screen.getDisplayMatching(p.getBounds()).workArea, focusedPanel: p.isFocused() };
    });
    let g = await geo();
    assert(!!g && g.visible && g.parented, 'it is a child window of the main window — it stays above the app and moves with it');
    const rightEdge = g && Math.min(g.m.x + g.m.width - 12, g.d.x + g.d.width);
    assert(!!g && g.b.x >= g.m.x && g.b.x + g.b.width <= g.m.x + g.m.width && Math.abs((g.b.x + g.b.width) - rightEdge) <= 2 && g.b.y >= g.m.y, `it sits against the main window's right edge (kept on the screen), over the app (${g && JSON.stringify({ panel: g.b, main: g.m, screen: g.d })})`);
    assert(!!g && !g.focusedPanel, 'appearing on its own, it did not take the keyboard from the app');
    await controls.evaluate((base) => window.api.alfredSettings({ brain: 'local', local: { endpoint: base, model: 'fake-model' } }), llm.base);
    const quick = await panel.$$eval('#alfred-quick button', (els) => els.map((e) => e.textContent));
    assert(quick.join('|') === '📊 Status|🩺 Check his AI|🎨 Make a picture|📖 My book|⚙ Set up his AI', `the quick buttons are there (${quick.join(' · ')})`);
    // Proof it is drawn OVER the app (incl. the native AI panes): the screen shows the panel's own pixels there.
    await sleep(600);
    const over = await overProof(panel, g.b, 'f1');
    assert(over.ok, `the screen shows the panel's own pixels where it is (over the app): ${over.detail}`);
    screen('06-floating-panel-over-the-app-fullscreen');

    console.log('\n== "what\'s the status of my book?" — in the floating panel ==');
    await panel.fill('#alfred-input', "what's the status of my book?");
    await panel.click('#alfred-send');
    const ans = await until(async () => { const t = await panel.$$eval('#alfred-chat .al-alfred', (els) => els.map((e) => e.textContent)); return t.find((x) => /Your books/.test(x)); }, 30000, 300);
    assert(!!ans && /The Lighthouse Keeper/.test(ans), `Alfred answers from Akọwe: "${ans && ans.slice(0, 140)}"`);
    const toolMsg = llm.requests.map((r) => r.body.messages.find((m) => m.role === 'tool' && m.name === 'book_status')).find(Boolean);
    assert(!!toolMsg && /The Lighthouse Keeper/.test(toolMsg.content), 'the book_status tool read the real Akọwe (with the token AutoInjector holds)');
    assert(!(await panel.isVisible('#alfred-card')), 'no card for a read-only question');
    await sleep(300);
    await shot(panel, '02-status-of-my-book');

    console.log('\n== "make an image of a lighthouse" -> I will card -> Do it (in the floating panel) ==');
    await panel.fill('#alfred-input', 'make an image of a lighthouse');
    await panel.click('#alfred-send');
    const card = await until(() => panel.isVisible('#alfred-card'), 20000, 200);
    assert(!!card, 'an "I will" card appears');
    const cardText = await panel.textContent('#alfred-card');
    assert(/I will/.test(cardText) && /a lighthouse on a cliff at dusk/.test(cardText) && /Do it/.test(cardText), 'it says exactly what will happen, with ✔ Do it / ✖ No');
    assert(!sd.state.lastTxt2img, 'nothing was generated before ✔ Do it');
    await panel.keyboard.press('Escape');
    await sleep(300);
    g = await geo();
    assert(g.visible && await panel.isVisible('#alfred-card'), 'Escape never closes the panel while the card waits');
    await shot(panel, '03-i-will-card');
    await panel.click('#alfred-do-it');
    const done = await until(async () => { const t = await panel.$$eval('#alfred-chat .al-alfred', (els) => els.map((e) => e.textContent)); return t.find((x) => /Here is your lighthouse/.test(x)); }, 30000, 300);
    assert(!!done, `Alfred reports the image: "${done && done.slice(0, 120)}"`);
    assert(!!sd.state.lastTxt2img && /lighthouse/.test(sd.state.lastTxt2img.prompt), 'the image went through the 🎨 Images module (sd-api) to Stable Diffusion txt2img');
    const p = done && done.replace(/^.*Here is your lighthouse: /, '').trim();
    assert(!!p && fs.existsSync(p) && fs.statSync(p).size > 0, `the PNG was saved (${p})`);
    madeFiles.push(p, String(p).replace(/\.png$/, '.json'));
    const did = await panel.textContent('#alfred-did-list');
    assert(/Make an image of/.test(did), '"What Alfred did" lists it');
    await panel.evaluate(() => { document.getElementById('alfred-did').open = true; });
    await sleep(400);
    await shot(panel, '04-image-done');

    console.log('\n== records: activity log has codes/titles only ==');
    const logs = await controls.evaluate(() => window.api.getState().then((s) => (s.log || []).filter((e) => /^alfred-/.test(e.kind))));
    assert(logs.some((e) => e.kind === 'alfred-tool' && e.detail.tool === 'generate_image' && e.detail.ok) && logs.some((e) => e.kind === 'alfred-tool' && e.detail.tool === 'book_status'), 'both actions are in the activity log');
    assert(!JSON.stringify(logs).includes('lighthouse') && !JSON.stringify(logs).includes('status of my book'), 'no prompts or prose in the log');

    console.log('\n== Ctrl+Shift+A shows / hides it from anywhere in the app ==');
    // A real key press as the OS delivers it (webContents.sendInputEvent goes through before-input-event,
    // like a keyboard does) — into the control panel, into an AI pane, into the panel itself.
    const press = (urlRe) => app.evaluate(({ webContents }, re) => {
      const wc = webContents.getAllWebContents().find((w) => new RegExp(re).test(w.getURL()));
      if (!wc) return false;
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control', 'shift'] });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control', 'shift'] });
      return true;
    }, urlRe);
    const vis = (want) => until(async () => { const x = await geo(); return x && x.visible === want; }, 4000, 100);
    assert(await press('controls\\.html') && !!(await vis(false)), 'Ctrl+Shift+A in the control panel hides the panel');
    assert(await controls.textContent('#btn-alfred-switch') === '🎩 Alfred: On', '… and Alfred stays on');
    assert(await press('controls\\.html') && !!(await vis(true)), 'Ctrl+Shift+A again brings it back');
    const kept = await panel.$$eval('#alfred-chat .al-alfred', (els) => els.length);
    assert(kept >= 2, `the conversation is still there (${kept} replies)`);
    assert(await press('fake-chat\\.html') && !!(await vis(false)), 'Ctrl+Shift+A inside an AI pane (a native view) hides it too');
    assert(await press('fake-chat\\.html') && !!(await vis(true)), '… and shows it');
    assert(await press('alfred-window\\.html') && !!(await vis(false)), 'the shortcut works inside the panel itself');
    await controls.click('#btn-alfred-drawer');
    assert(!!(await vis(true)), 'the title-bar "🗗 Panel" button brings it back');
    await panel.keyboard.press('Control+Shift+A');
    assert(!!(await vis(false)), 'a key that reaches the page (synthetic input) still toggles it');
    await controls.keyboard.press('Control+Shift+A');
    assert(!!(await vis(true)), '… from the control panel too');

    console.log('\n== over the 📖 Akọwe tab (a native view) ==');
    await controls.click('#tab-app-akowe');
    const shown = await until(async () => { const s = await controls.evaluate(() => window.api.akoweServerStatus()); return s.view && s.view.shown; }, 8000, 200);
    assert(!!shown, 'the Akọwe page is shown in its tab');
    await sleep(800);
    g = await geo();
    const overAk = await overProof(panel, g.b, 'f2');
    assert(g.visible && overAk.ok, `the floating panel stays over the Akọwe page: ${overAk.detail}`);
    screen('07-floating-over-akowe-fullscreen');
    keep('07-floating-over-akowe-fullscreen', 'alfred-floating-over-akowe.png');
    keep('06-floating-panel-over-the-app-fullscreen', 'alfred-floating-panel.png');
    await controls.click('#tab-app-main');

    console.log('\n== Docked (beside): the drawer, exactly as before ==');
    await panel.click('#alfred-btn-settings');
    assert(await panel.inputValue('#alfred-set-mode') === 'floating', '⚙ shows "His panel: Floating (over everything)"');
    await panel.selectOption('#alfred-set-mode', 'docked');
    await panel.click('#alfred-set-save');
    const gone = await until(async () => (await geo()) === null, 6000, 150);
    assert(!!gone, 'choosing Docked closes the floating window');
    const drawer = await until(() => controls.isVisible('#alfred-drawer'), 5000, 150);
    assert(!!drawer, 'and the drawer opens in the control panel');
    const room = await controls.evaluate(() => { const w = document.getElementById('wrap').getBoundingClientRect(); const d = document.getElementById('alfred-drawer').getBoundingClientRect(); return w.right <= d.left + 1; });
    assert(room, 'the page makes room for the drawer (the AI panes are laid out beside it, not under it)');
    const dchat = await controls.$$eval('#alfred-chat .al-alfred', (els) => els.map((e) => e.textContent));
    assert(dchat.some((x) => /Here is your lighthouse/.test(x)), 'the drawer shows the same conversation (one source of truth in main)');
    await controls.fill('#alfred-input', "what's the status of my book?");
    await controls.click('#alfred-send');
    const n0 = dchat.length;
    const dans = await until(async () => { const t = await controls.$$eval('#alfred-chat .al-alfred', (els) => els.map((e) => e.textContent)); return t.length > n0 && /Your books/.test(t[t.length - 1]) ? t[t.length - 1] : null; }, 30000, 300);
    assert(!!dans, 'chat works in the drawer too');
    await press('fake-chat\\.html');
    assert(!!(await until(async () => !(await controls.isVisible('#alfred-drawer')), 4000, 100)), 'Docked: Ctrl+Shift+A (here from an AI pane) hides the drawer');
    await press('controls\\.html');
    assert(!!(await until(() => controls.isVisible('#alfred-drawer'), 4000, 100)), '… and shows it');
    await shot(controls, '01-docked-drawer');
    await controls.click('#tab-app-akowe');
    const shown2 = await until(async () => { const s = await controls.evaluate(() => window.api.akoweServerStatus()); return s.view && s.view.shown; }, 8000, 200);
    assert(!!shown2 && await controls.isVisible('#alfred-drawer'), 'the drawer stays available over the Akọwe tab');
    const beside = await controls.evaluate(() => document.getElementById('akowe-slot').getBoundingClientRect().right <= document.getElementById('alfred-drawer').getBoundingClientRect().left + 1);
    assert(beside, 'the Akọwe page is laid out beside the drawer');
    await sleep(800);
    screen('05-over-akowe-tab-fullscreen');
    await shot(controls, '05-over-akowe-tab');
    await controls.click('#tab-app-main');

    console.log('\n== Off again ==');
    await controls.click('#btn-alfred-switch');
    const off = await until(async () => (await controls.textContent('#btn-alfred-switch')) === '🎩 Alfred: Off' && !(await controls.$('#alfred-drawer')), 5000, 150);
    assert(!!off, 'switching Off removes the drawer');
    await controls.evaluate(() => window.api.alfredPanel({ mode: 'floating' }));
    await sleep(500);
    assert((await geo()) === null, 'and no floating window while he is Off');
    const n = llm.requests.length;
    await sleep(500);
    assert(llm.requests.length === n, 'and no more AI calls');
  } finally {
    await app.close().catch(() => {});
    await llm.close(); await sd.close();
    for (const f of madeFiles) { try { fs.unlinkSync(f); } catch (_) {} }
  }
  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  return state.failed ? 1 : 0;
}
main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
