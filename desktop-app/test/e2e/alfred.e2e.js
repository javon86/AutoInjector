'use strict';
// alfred.e2e.js — 🎩 Alfred inside the REAL Electron app: the switch starts Off (no drawer), turning him
// On shows the drawer, and with a fake OpenAI-compatible model (like Ollama /v1) that returns tool
// calls he answers "what's the status of my book?" from the REAL Akọwe server AutoInjector starts,
// and "make an image of a lighthouse" goes through the "I will" card -> ✔ Do it -> the image path
// (the 🎨 Images module, sd-api.js, against a fake Forge server) -> a saved PNG. The drawer also works over the 📖 Akọwe tab.
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

    console.log('\n== turn him On ==');
    const con = await controls.evaluate((u) => window.api.sd.connect(u), sd.base);
    assert(con && con.ok !== false, `Stable Diffusion (fake Forge) connected through the 🎨 Images module (${con && (con.label || con.message || con.error)})`);
    await controls.click('#btn-alfred-switch');
    const on = await until(async () => (await controls.textContent('#btn-alfred-switch')) === '🎩 Alfred: On' && await controls.isVisible('#alfred-drawer'), 5000, 150);
    assert(!!on, 'the switch reads On and the drawer opens');
    await controls.evaluate((base) => window.api.alfredSettings({ brain: 'local', local: { endpoint: base, model: 'fake-model' } }), llm.base);
    const room = await controls.evaluate(() => { const w = document.getElementById('wrap').getBoundingClientRect(); const d = document.getElementById('alfred-drawer').getBoundingClientRect(); return w.right <= d.left + 1; });
    assert(room, 'the page makes room for the drawer (the AI panes are laid out beside it, not under it)');

    console.log('\n== "what\'s the status of my book?" ==');
    await controls.fill('#alfred-input', "what's the status of my book?");
    await controls.click('#alfred-send');
    const ans = await until(async () => { const t = await controls.$$eval('#alfred-chat .al-alfred', (els) => els.map((e) => e.textContent)); return t.find((x) => /Your books/.test(x)); }, 30000, 300);
    assert(!!ans && /The Lighthouse Keeper/.test(ans), `Alfred answers from Akọwe: "${ans && ans.slice(0, 140)}"`);
    const toolMsg = llm.requests.map((r) => r.body.messages.find((m) => m.role === 'tool' && m.name === 'book_status')).find(Boolean);
    assert(!!toolMsg && /The Lighthouse Keeper/.test(toolMsg.content), 'the book_status tool read the real Akọwe (with the token AutoInjector holds)');
    assert(!(await controls.isVisible('#alfred-card')), 'no card for a read-only question');
    await sleep(300);
    await shot(controls, '02-status-of-my-book');

    console.log('\n== "make an image of a lighthouse" -> I will card -> Do it ==');
    await controls.fill('#alfred-input', 'make an image of a lighthouse');
    await controls.click('#alfred-send');
    const card = await until(() => controls.isVisible('#alfred-card'), 20000, 200);
    assert(!!card, 'an "I will" card appears');
    const cardText = await controls.textContent('#alfred-card');
    assert(/I will/.test(cardText) && /a lighthouse on a cliff at dusk/.test(cardText) && /Do it/.test(cardText), 'it says exactly what will happen, with ✔ Do it / ✖ No');
    assert(!sd.state.lastTxt2img, 'nothing was generated before ✔ Do it');
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
    await controls.evaluate(() => { document.getElementById('alfred-did').open = true; });
    await sleep(400);
    await shot(controls, '04-image-done');

    console.log('\n== records: activity log has codes/titles only ==');
    const logs = await controls.evaluate(() => window.api.getState().then((s) => (s.log || []).filter((e) => /^alfred-/.test(e.kind))));
    assert(logs.some((e) => e.kind === 'alfred-tool' && e.detail.tool === 'generate_image' && e.detail.ok) && logs.some((e) => e.kind === 'alfred-tool' && e.detail.tool === 'book_status'), 'both actions are in the activity log');
    assert(!JSON.stringify(logs).includes('lighthouse') && !JSON.stringify(logs).includes('status of my book'), 'no prompts or prose in the log');

    console.log('\n== over the 📖 Akọwe tab ==');
    await controls.click('#tab-app-akowe');
    const shown = await until(async () => { const s = await controls.evaluate(() => window.api.akoweServerStatus()); return s.view && s.view.shown; }, 8000, 200);
    assert(!!shown && await controls.isVisible('#alfred-drawer'), 'the drawer stays available over the Akọwe tab');
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
