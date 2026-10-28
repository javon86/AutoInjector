'use strict';
// alfred.e2e.js — 🎩 Alfred inside the REAL Electron app, docked: the switch starts Off (no drawer); turning
// him On opens his SIDE PANEL — docked on the right, it moves the app over on every tab (🤖 main, 📖 Akọwe,
// 🎨 Images, 🎬 Video), never covers anything, and there is no separate window any more. With a fake
// OpenAI-compatible model (like Ollama /v1) that returns tool calls: 📖 My book answers from the REAL Akọwe
// server AutoInjector starts; 🎨 Make a picture goes through the "I will" card -> ✔ Do it -> the 🎨 Images
// module (sd-api.js, against a fake Forge server) -> a saved PNG; 🧑 Make a character goes to the Character
// Forge in the real Akọwe. ❓ Everything I can do is searchable and ▶ Try it fills his box; "what can you
// do?" opens it too. The User Panel's "→ 🎩 Alfred" sends there, its light shows his state. Ctrl+Shift+A
// shows / hides the drawer from the control panel and from inside an AI pane.
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

/** Keep a feature screenshot in the repo's shots/ folder. */
function keep(name, as) { try { const src = path.join(SHOTS, `${name}.png`); if (fs.existsSync(src)) fs.copyFileSync(src, path.join(APP_DIR, '..', 'shots', as)); } catch (_) {} }

/** The fake model: book_status / generate_image / forge_character for the requests, then answer from the result. */
function script(body) {
  const last = lastMsg(body);
  if (last.role === 'tool') {
    let r = {}; try { r = JSON.parse(last.content); } catch (_) {}
    if (last.name === 'forge_character') return { content: r.ok ? `🧑 ${r.message}` : `🧑 About that character: ${r.message || r.error}` };
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
  if (/make a character/.test(u)) return toolCall('forge_character', { character: 'Mara' });
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

    console.log('\n== turn him On: his side panel, docked beside the app on every tab ==');
    const con = await controls.evaluate((u) => window.api.sd.connect(u), sd.base);
    assert(con && con.ok !== false, `Stable Diffusion (fake Forge) connected through the 🎨 Images module (${con && (con.label || con.message || con.error)})`);
    await controls.evaluate((base) => window.api.alfredSettings({ brain: 'local', local: { endpoint: base, model: 'fake-model' } }), llm.base);
    const lightOff = await controls.textContent('#btn-butler-status');
    assert(/Alfred off/.test(lightOff), `the User Panel light is Alfred's: "${lightOff.trim()}"`);
    const windowsBefore = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length);
    await controls.click('#btn-alfred-switch');
    const on = await until(async () => (await controls.textContent('#btn-alfred-switch')) === '🎩 Alfred: On', 5000, 150);
    assert(!!on, 'the switch reads On');
    const side = await until(() => controls.isVisible('#alfred-drawer'), 8000, 150);
    assert(!!side && await controls.evaluate(() => document.body.classList.contains('alfred-open')), 'his side panel opens (docked) and the page makes room');
    for (const t of ['main', 'akowe', 'images', 'video']) {
      await controls.click(`#tab-app-${t}`); await sleep(250);
      const ok = await controls.evaluate((id) => { const e = document.getElementById(id); const d = document.getElementById('alfred-drawer'); return !!(e && d && !d.hidden && e.getBoundingClientRect().right <= d.getBoundingClientRect().left + 1); }, t === 'main' ? 'wrap' : `${t}-tab`);
      assert(ok, `on the ${t} tab the side panel stays and the page is laid out beside it`);
    }
    await controls.click('#tab-app-main');
    const windowsAfter = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length);
    assert(windowsAfter === windowsBefore && !(await controls.$('#alfred-set-mode')), `no separate window (${windowsAfter} app window(s), as before) and no "separate window" choice in ⚙`);
    assert(/Alfred idle/.test(await controls.textContent('#btn-butler-status')) && (await controls.textContent('#btn-ai-toggle')) === '🎩 Alfred: On', 'the User Panel light and On/Off follow him (idle, On)');
    const big = await controls.$$eval('#alfred-actions button', (els) => els.map((e) => e.textContent));
    assert(big.join('|') === '🧑Make a character|🎨Make a picture|🎬Make a video|🖼Design a cover|📖My book|✍Continue / make my book|🩺Check everything|❓Everything I can do', `the 8 big buttons are there (${big.join(' · ')})`);
    await controls.evaluate(() => { document.getElementById('alfred-did').open = false; });
    await sleep(400);
    await shot(controls, '02-side-panel-buttons');
    keep('02-side-panel-buttons', 'alfred-side-panel.png');

    console.log('\n== 📖 My book — from the real Akọwe ==');
    await controls.click('#alfred-a-book');
    const ans = await until(async () => { const t = await controls.$$eval('#alfred-chat .al-alfred', (els) => els.map((e) => e.textContent)); return t.find((x) => /Your books/.test(x)); }, 30000, 300);
    assert(!!ans && /The Lighthouse Keeper/.test(ans), `Alfred answers from Akọwe: "${ans && ans.slice(0, 140)}"`);
    const toolMsg = llm.requests.map((r) => r.body.messages.find((m) => m.role === 'tool' && m.name === 'book_status')).find(Boolean);
    assert(!!toolMsg && /The Lighthouse Keeper/.test(toolMsg.content), 'the book_status tool read the real Akọwe (with the token AutoInjector holds)');
    assert(!(await controls.isVisible('#alfred-card')), 'no card for a read-only question');

    console.log('\n== 🎨 Make a picture -> a tiny form -> I will card -> Do it ==');
    await until(async () => !(await controls.isDisabled('#alfred-a-picture')), 10000, 150);
    await controls.click('#alfred-a-picture');
    await controls.fill('#alfred-f-what', 'a lighthouse');
    await controls.click('#alfred-f-go');
    const card = await until(() => controls.isVisible('#alfred-card'), 20000, 200);
    assert(!!card, 'an "I will" card appears');
    const cardText = await controls.textContent('#alfred-card');
    assert(/I will/.test(cardText) && /a lighthouse on a cliff at dusk/.test(cardText) && /Do it/.test(cardText), 'it says exactly what will happen, with ✔ Do it / ✖ No');
    assert(!sd.state.lastTxt2img, 'nothing was generated before ✔ Do it');
    assert(/needs you/.test(await controls.textContent('#btn-butler-status')), 'the User Panel light says Alfred needs you (a card is waiting)');
    assert(await controls.isDisabled('#alfred-a-video') && !(await controls.isDisabled('#alfred-a-catalog')), 'while the card waits, the buttons that ask him wait too (❓ still works)');
    await shot(controls, '03-i-will-card');
    await controls.click('#alfred-do-it');
    const done = await until(async () => { const t = await controls.$$eval('#alfred-chat .al-alfred', (els) => els.map((e) => e.textContent)); return t.find((x) => /Here is your lighthouse/.test(x)); }, 30000, 300);
    assert(!!done, `Alfred reports the image: "${done && done.slice(0, 120)}"`);
    assert(!!sd.state.lastTxt2img && /lighthouse/.test(sd.state.lastTxt2img.prompt), 'the image went through the 🎨 Images module (sd-api) to Stable Diffusion txt2img');
    const p = done && done.replace(/^.*Here is your lighthouse: /, '').trim();
    assert(!!p && fs.existsSync(p) && fs.statSync(p).size > 0, `the PNG was saved (${p})`);
    madeFiles.push(p, String(p).replace(/\.png$/, '.json'));
    const did = await controls.textContent('#alfred-did-list');
    assert(/Make an image of/.test(did), '"What Alfred did" lists it');
    await shot(controls, '04-image-done');

    console.log('\n== 🧑 Make a character -> the Character Forge in the real Akọwe ==');
    await until(async () => !(await controls.isDisabled('#alfred-a-character')), 10000, 150);
    await controls.click('#alfred-a-character');
    const form = await until(() => controls.isVisible('#alfred-f-name'), 8000, 150);
    assert(!!form, 'the book exists, so a tiny form asks for the name and a line about them');
    await controls.fill('#alfred-f-name', 'Mara');
    await controls.fill('#alfred-f-about', 'the keeper who hates the sea');
    await controls.click('#alfred-f-go');
    const ccard = await until(() => controls.isVisible('#alfred-card'), 20000, 200);
    assert(!!ccard && /Mara/.test(await controls.textContent('#alfred-card')), 'Alfred asks first: the card names Mara\'s dossier');
    await controls.click('#alfred-do-it');
    const cans = await until(async () => { const t = await controls.$$eval('#alfred-chat .al-alfred', (els) => els.map((e) => e.textContent)); return t.find((x) => /^🧑/.test(x)); }, 30000, 300);
    const forgeMsg = llm.requests.map((r) => r.body.messages.find((m) => m.role === 'tool' && m.name === 'forge_character')).find(Boolean);
    assert(!!forgeMsg && /Mara/.test(forgeMsg.content), `forge_character went to the real Akọwe (${forgeMsg && forgeMsg.content.slice(0, 160)})`);
    assert(!!cans && /Mara/.test(cans), `and he answers in plain words: "${cans && cans.slice(0, 160)}"`);
    const umsg = llm.requests.map((r) => lastUser(r.body)).filter(Boolean).map((m) => m.content).find((t) => /Make a character for my book: “Mara” — the keeper who hates the sea/.test(t));
    assert(!!umsg, 'the request carried the name and the line about them');

    console.log('\n== ❓ Everything I can do (searchable) and "what can you do?" ==');
    await controls.click('#alfred-a-catalog');
    const catOpen = await until(async () => (await controls.$$eval('#alfred-catalog-list .al-cat-item', (els) => els.length)) > 100, 8000, 150);
    assert(!!catOpen && await controls.isVisible('#alfred-catalog'), 'the list opens inside the side panel, with every capability');
    const groups = await controls.$$eval('#alfred-catalog-list h4', (els) => els.map((e) => e.textContent.replace(/ \(\d+\)$/, '')));
    assert(groups[0] === '📖 Books' && groups.includes('🧑 Characters & world') && groups.includes('🎨 Pictures & covers') && groups.includes('🧠 His AI & setup'), `grouped (${groups.join(' · ')})`);
    await controls.fill('#alfred-catalog-search', 'cover');
    const hits = await controls.$$eval('#alfred-catalog-list .al-cat-item', (els) => els.map((e) => e.dataset.id));
    assert(hits.includes('design_cover') && hits.includes('make_cover_art') && hits.length < 15, `searching "cover" narrows it (${hits.join(', ')})`);
    await sleep(200);
    await shot(controls, '05-everything-i-can-do');
    await controls.click('#alfred-catalog-list .al-cat-item[data-id="make_cover_art"] button.al-try');
    const tried = await controls.inputValue('#alfred-input');
    assert(tried === 'Make the cover art: a lighthouse in a storm.' && !(await controls.isVisible('#alfred-catalog')), `▶ Try it puts the example in his box ("${tried}")`);
    await controls.fill('#alfred-input', 'what can you do?');
    const nReq = llm.requests.length;
    await controls.click('#alfred-send');
    assert(!!(await until(() => controls.isVisible('#alfred-catalog'), 3000, 100)) && llm.requests.length === nReq, 'typing "what can you do?" opens the list (no AI call)');
    await controls.click('#alfred-catalog-close');

    console.log('\n== the User Panel: "→ 🎩 Alfred" sends the composed message to him ==');
    await controls.fill('#composer-text', 'hello Alfred');
    await controls.click('#btn-send-butler');
    const hi = await until(async () => { const t = await controls.$$eval('#alfred-chat .al-you', (els) => els.map((e) => e.textContent)); return t.includes('hello Alfred'); }, 10000, 200);
    assert(!!hi, '"→ 🎩 Alfred" put the message in his chat');
    assert(!!(await until(async () => { const t = await controls.$$eval('#alfred-chat .al-alfred', (els) => els.map((e) => e.textContent)); return t[t.length - 1] === 'Good day.'; }, 20000, 200)), 'and he answered there');

    console.log('\n== records: activity log has codes/titles only ==');
    const logs = await controls.evaluate(() => window.api.getState().then((s) => (s.log || []).filter((e) => /^alfred-/.test(e.kind))));
    assert(logs.some((e) => e.kind === 'alfred-tool' && e.detail.tool === 'generate_image' && e.detail.ok) && logs.some((e) => e.kind === 'alfred-tool' && e.detail.tool === 'book_status'), 'the actions are in the activity log');
    assert(!JSON.stringify(logs).includes('lighthouse') && !JSON.stringify(logs).includes('status of my book') && !JSON.stringify(logs).includes('hates the sea'), 'no prompts or prose in the log');

    console.log('\n== Ctrl+Shift+A shows / hides the side panel from anywhere in the app ==');
    // A real key press as the OS delivers it (webContents.sendInputEvent goes through before-input-event,
    // like a keyboard does) — into the control panel and into an AI pane (a native view).
    const press = (urlRe) => app.evaluate(({ webContents }, re) => {
      const wc = webContents.getAllWebContents().find((w) => new RegExp(re).test(w.getURL()));
      if (!wc) return false;
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control', 'shift'] });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control', 'shift'] });
      return true;
    }, urlRe);
    const shown = (want) => until(async () => (await controls.isVisible('#alfred-drawer')) === want, 4000, 100);
    assert(await press('controls\\.html') && !!(await shown(false)), 'Ctrl+Shift+A in the control panel hides the side panel');
    assert(!(await controls.evaluate(() => document.body.classList.contains('alfred-open'))) && await controls.textContent('#btn-alfred-switch') === '🎩 Alfred: On', '… gives the room back, and Alfred stays on');
    assert(await press('controls\\.html') && !!(await shown(true)), 'Ctrl+Shift+A again brings it back');
    const kept = await controls.$$eval('#alfred-chat .al-alfred', (els) => els.length);
    assert(kept >= 3, `the conversation is still there (${kept} replies)`);
    assert(await press('fake-chat\\.html') && !!(await shown(false)), 'Ctrl+Shift+A inside an AI pane (a native view) hides it too');
    assert(await press('fake-chat\\.html') && !!(await shown(true)), '… and shows it');
    await controls.click('#btn-alfred-drawer');
    assert(!!(await shown(false)), 'the title-bar "▸ Panel" button hides it');
    await controls.keyboard.press('Control+Shift+A');
    assert(!!(await shown(true)), 'a key that reaches the page (synthetic input) still toggles it');
    await controls.click('#btn-butler-status');
    assert(!!(await shown(true)), 'the User Panel light opens his panel');

    console.log('\n== over the 📖 Akọwe tab (a native view): laid out beside it ==');
    await controls.click('#tab-app-akowe');
    const shown2 = await until(async () => { const s = await controls.evaluate(() => window.api.akoweServerStatus()); return s.view && s.view.shown; }, 8000, 200);
    assert(!!shown2 && await controls.isVisible('#alfred-drawer'), 'the side panel stays available over the Akọwe tab');
    const beside = await controls.evaluate(() => document.getElementById('akowe-slot').getBoundingClientRect().right <= document.getElementById('alfred-drawer').getBoundingClientRect().left + 1);
    assert(beside, 'the Akọwe page is laid out beside the drawer');
    await sleep(800);
    screen('06-over-akowe-tab-fullscreen');
    await controls.click('#tab-app-main');

    console.log('\n== Off again ==');
    await controls.click('#btn-alfred-switch');
    const off = await until(async () => (await controls.textContent('#btn-alfred-switch')) === '🎩 Alfred: Off' && !(await controls.$('#alfred-drawer')), 5000, 150);
    assert(!!off, 'switching Off removes the side panel');
    assert(!!(await until(async () => /Alfred off/.test(await controls.textContent('#btn-butler-status')), 3000, 100)), 'the User Panel light says Alfred off');
    const n = llm.requests.length;
    await press('controls\\.html');
    await sleep(500);
    assert(!(await controls.$('#alfred-drawer')) && llm.requests.length === n, 'Ctrl+Shift+A does nothing while he is off, and no more AI calls');
  } finally {
    await app.close().catch(() => {});
    await llm.close(); await sd.close();
    for (const f of madeFiles) { try { fs.unlinkSync(f); } catch (_) {} }
  }
  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  return state.failed ? 1 : 0;
}
main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
