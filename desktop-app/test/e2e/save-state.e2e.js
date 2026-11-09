'use strict';
// save-state.e2e.js — 💾 Save state / 📂 Load state in the REAL Electron app (xvfb). The three AI panes are the fake
// chat page (test/fixtures/fake-chat.html) served by a small local web server at chat-like addresses
// (/claude/chat/abc …), so a pane really navigates, gets a 404, or is redirected:
//   * 💾 Save state: type a name → one JSON file in AutoInjector's own data folder (HOME / XDG_CONFIG_HOME are a
//     temp folder here), with each pane's chat address, the backup of Claude's reply and the set-up
//   * 📂 Load state: the list shows the name with its date/time; Load → all three panes go back to their saved
//     chats at once, and the Compose box, the Active AIs, the pane sizes and the tab come back
//   * a chat that is gone (404), sent to a new chat, or to a sign-in page → said in plain words, and the saved
//     text is shown read-only
//   * a save with an address that is not a real AI chat → refused, the pane does not move
//   * ✎ Rename, 🗑 Delete; no sideways scrolling at 1280 px
// Screenshots go to SHOTS (default: a temp folder).
//   TMPDIR=/dev/shm xvfb-run -a node test/e2e/save-state.e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { makeAsserts } = require('./helpers');
const electron = require('playwright')._electron;

const SHOTS = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'save-state-shots-'));
const FAKE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'fake-chat.html'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SITES = ['chatgpt', 'claude', 'gemini'];

async function main() {
  const { assert, state } = makeAsserts();
  fs.mkdirSync(SHOTS, { recursive: true });
  // the fake sites: any /<site>/… address is the fake chat page; `rules` turns one into a 404 or a redirect
  const rules = {}; // pathname -> { code: 404 } | { to: '/x' }
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const rule = rules[u.pathname];
    if (rule && rule.to) { res.writeHead(302, { Location: rule.to }); res.end(); return; }
    res.writeHead(rule && rule.code ? rule.code : 200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(FAKE);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const at = (site, p) => `${base}/${site}${p}?site=${site}&quirks=none`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'save-state-home-'));
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], cwd: path.join(__dirname, '..', '..'),
    env: Object.assign({}, process.env, {
      HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), AUTOINJECTOR_BRIDGE: '0', AUTOINJECTOR_CHECKIN: '0', AUTOINJECTOR_CONTENT_SCAN: '0', AUTOINJECTOR_AKOWE_SERVER: '0',
      AUTOINJECTOR_SD_AUTOSTART: '0', AUTOINJECTOR_VIDEO_AUTOSTART: '0', AUTOINJECTOR_AKOWE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'save-state-nobf-')),
      AUTOINJECTOR_SAVESTATE_SETTLE_MS: '800',
      AUTOINJECTOR_SITE_URL_CHATGPT: at('chatgpt', '/'), AUTOINJECTOR_SITE_URL_CLAUDE: at('claude', '/new'), AUTOINJECTOR_SITE_URL_GEMINI: at('gemini', '/app'),
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost'
    }),
  });
  try {
    let controls = null;
    for (let i = 0; i < 100 && !controls; i++) {
      for (const w of app.windows()) { try { if (await w.$('#up-zone-compose')) controls = w; } catch (_) {} }
      if (!controls) await sleep(400);
    }
    assert(!!controls, 'control panel appears');
    if (!controls) return 1;
    await controls.setViewportSize({ width: 1280, height: 760 }).catch(() => {});
    const errors = [];
    controls.on('pageerror', (e) => errors.push(String(e)));
    const waitFor = async (fn, ms, step = 150) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = await fn(); if (r) return r; await sleep(step); } return null; };
    const paneUrls = () => app.evaluate(({ webContents }, b) => {
      const out = {};
      for (const w of webContents.getAllWebContents()) { const u = w.getURL(); for (const s of ['chatgpt', 'claude', 'gemini']) if (u.startsWith(`${b}/${s}/`)) out[s] = u; }
      return out;
    }, base);
    const goTo = (site, url) => app.evaluate(({ webContents }, a) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(`${a.base}/${a.site}/`));
      if (!wc) return false;
      wc.loadURL(a.url); return true;
    }, { site, url, base });
    const noSideways = (what) => controls.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth, bar: (() => { const b = document.getElementById('window-titlebar'); return b ? b.scrollWidth - b.clientWidth : 0; })(), sheet: (() => { const s = document.querySelector('#savestate-modal.on .sheet'); return s ? s.scrollWidth - s.clientWidth : 0; })() }))
      .then((m) => assert(m.doc <= m.win && m.bar <= 0 && m.sheet <= 0, `no sideways scrolling at 1280 px — ${what} (page ${m.doc}/${m.win}, title bar +${m.bar}, dialog +${m.sheet})`));
    const shot = (name) => controls.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {});
    await waitFor(async () => Object.keys(await paneUrls()).length === 3, 20000);
    const userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
    assert(userData.startsWith(home), `the app's data folder is the test's own (${userData})`);
    const saveDir = path.join(userData, 'saved-states');

    console.log('\n== the panes are on chats; Claude has said something ==');
    const CHAT = { chatgpt: at('chatgpt', '/c/abc'), claude: at('claude', '/chat/abc'), gemini: at('gemini', '/app/abc') };
    for (const s of SITES) await goTo(s, CHAT[s]);
    assert(await waitFor(async () => { const u = await paneUrls(); return SITES.every((s) => u[s] === CHAT[s]); }, 10000), 'all three panes are on a chat');
    await sleep(1500);
    await controls.evaluate(() => window.api.sendCompose('Hello Claude, this is chapter 12.', ['claude']));
    const reply = await waitFor(async () => { const r = await controls.evaluate(() => window.api.getState()); const t = (r && r.transcript || []).filter((x) => x.site === 'claude'); return t.length ? t[t.length - 1].text : null; }, 40000, 400);
    assert(!!reply, `Claude's reply was captured (${reply ? reply.length : 0} characters)`);

    console.log('\n== the set-up: Compose box, Gemini off, Claude reduced, the 🎬 Video tab ==');
    await controls.fill('#composer-text', 'Write chapter 12 — the keeper opens the door');
    await controls.click('#p-gemini');
    await controls.evaluate(() => setColumnState('claude', 'reduced'));
    await noSideways('the 🤖 AutoInjector tab with the 💾 / 📂 buttons');
    await controls.click('#tab-app-video');
    await sleep(300);

    console.log('\n== 💾 Save state ==');
    await controls.click('#btn-save-state');
    await controls.waitForSelector('#savestate-modal.on #savestate-name', { timeout: 5000 });
    await shot('ss_01_save_dialog');
    await noSideways('the 💾 Save dialog');
    await controls.fill('#savestate-name', 'Salt Keeper ch 12');
    await controls.click('#btn-savestate-do');
    const saved = await waitFor(async () => { try { return fs.readdirSync(saveDir).filter((f) => f.endsWith('.json')); } catch (_) { return null; } }, 8000);
    assert(saved && saved.length === 1, `one JSON file in the data folder (${saved && saved[0]})`);
    const file = path.join(saveDir, saved[0]);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(data.name === 'Salt Keeper ch 12' && data.data.panes.claude.url === CHAT.claude && data.data.panes.gemini.url === CHAT.gemini, 'it keeps the name and each pane\'s chat address');
    assert(data.data.backup.claude.length >= 1 && data.data.backup.claude[data.data.backup.claude.length - 1].text === reply, 'it keeps a copy of Claude\'s reply');
    assert(data.data.setup.ui.composer === 'Write chapter 12 — the keeper opens the door' && data.data.setup.enabled.gemini === false && data.data.setup.ui.columns.claude === 'reduced' && data.data.setup.ui.tab === 'video', 'it keeps the Compose box, Gemini off, Claude reduced and the 🎬 Video tab');
    assert(await controls.evaluate(() => !document.querySelector('#savestate-modal.on')) && /Saved as “Salt Keeper ch 12”/.test(await controls.textContent('#status')), 'the dialog closes and says it is saved');

    console.log('\n== everything changes ==');
    await controls.click('#tab-app-main');
    await controls.fill('#composer-text', '');
    await controls.click('#p-gemini');
    await controls.evaluate(() => setColumnState('claude', 'open'));
    for (const s of SITES) await goTo(s, at(s, s === 'claude' ? '/chat/other' : s === 'chatgpt' ? '/c/other' : '/app/other'));
    await waitFor(async () => (await paneUrls()).claude === at('claude', '/chat/other'), 8000);

    console.log('\n== 📂 Load state ==');
    await controls.click('#btn-load-state');
    await controls.waitForSelector('#savestate-list .ss-item', { timeout: 5000 });
    const item = await controls.evaluate(() => { const i = document.querySelector('#savestate-list .ss-item'); return { name: i.querySelector('.ss-name').textContent, meta: i.querySelector('.ss-meta').textContent, buttons: [...i.querySelectorAll('button')].map((b) => b.textContent) }; });
    assert(item.name === 'Salt Keeper ch 12' && /\d{4}/.test(item.meta) && /\d:\d\d/.test(item.meta) && /ChatGPT · Claude · Gemini/.test(item.meta), `the list shows the name, date and time ("${item.meta}")`);
    assert(['📂 Load', '✎ Rename', '📜 Saved text', '🗑 Delete'].every((b) => item.buttons.includes(b)), `Load / Rename / Saved text / Delete (${item.buttons.join(' | ')})`);
    await shot('ss_02_load_list');
    await noSideways('the 📂 Load list');
    await controls.click('#savestate-list .ss-load');
    await controls.waitForSelector('#savestate-result', { timeout: 30000 });
    const u1 = await waitFor(async () => { const u = await paneUrls(); return SITES.every((s) => u[s] === CHAT[s]) ? u : null; }, 10000);
    assert(!!u1, 'all three panes are back on their saved chats');
    const res1 = await controls.evaluate(() => [...document.querySelectorAll('#savestate-result li')].map((li) => ({ site: li.dataset.site, state: li.dataset.state, text: li.textContent })));
    assert(res1.length === 3 && res1.every((x) => x.state === 'ok'), `each pane: ok (${res1.map((x) => `${x.site}:${x.state}`).join(', ')})`);
    const back = await controls.evaluate(() => ({ composer: document.getElementById('composer-text').value, gemini: document.getElementById('p-gemini').checked, claude: document.getElementById('col-claude').className, tab: document.body.dataset.appTab }));
    assert(back.composer === 'Write chapter 12 — the keeper opens the door' && back.gemini === false && /state-reduced/.test(back.claude) && back.tab === 'video', `the Compose box, Gemini off, Claude reduced and the 🎬 Video tab are back (${JSON.stringify(back)})`);
    await shot('ss_03_loaded');
    await controls.click('#btn-savestate-close');
    await controls.click('#tab-app-main');

    console.log('\n== the chats are gone / moved / signed out ==');
    rules['/claude/chat/abc'] = { code: 404 };
    rules['/chatgpt/c/abc'] = { to: '/chatgpt/?site=chatgpt&quirks=none' };
    rules['/gemini/app/abc'] = { to: '/gemini/login?site=gemini&quirks=none' };
    for (const s of SITES) await goTo(s, at(s, s === 'claude' ? '/chat/other' : s === 'chatgpt' ? '/c/other' : '/app/other'));
    await sleep(800);
    await controls.click('#btn-load-state');
    await controls.waitForSelector('#savestate-list .ss-load', { timeout: 5000 });
    await controls.click('#savestate-list .ss-load');
    await controls.waitForSelector('#savestate-result', { timeout: 30000 });
    await controls.waitForSelector('.ss-viewer[data-site="claude"] .ss-text', { timeout: 8000 }).catch(() => {});
    const res2 = await controls.evaluate(() => Object.fromEntries([...document.querySelectorAll('#savestate-result li')].map((li) => [li.dataset.site, { state: li.dataset.state, text: li.textContent }])));
    assert(res2.claude && res2.claude.state === 'gone' && /Claude: that chat is gone/.test(res2.claude.text), `Claude (404): "${res2.claude && res2.claude.text}"`);
    assert(res2.chatgpt && res2.chatgpt.state === 'new-chat' && /ChatGPT opened a different page instead of the saved chat/.test(res2.chatgpt.text), `ChatGPT (sent to a new chat): "${res2.chatgpt && res2.chatgpt.text}"`);
    assert(res2.gemini && res2.gemini.state === 'login' && /Gemini is asking you to sign in/.test(res2.gemini.text), `Gemini (sign-in page): "${res2.gemini && res2.gemini.text}"`);
    const viewer = await controls.evaluate(() => { const v = document.querySelector('.ss-viewer[data-site="claude"]'); return v ? { title: v.querySelector('h4').textContent, texts: [...v.querySelectorAll('.ss-text')].map((x) => x.textContent), editable: [...v.querySelectorAll('textarea, input, [contenteditable="true"]')].length } : null; });
    assert(viewer && /saved copy \(read-only\)/.test(viewer.title) && viewer.texts.includes(reply) && viewer.editable === 0, 'Claude\'s saved text is shown, read-only');
    assert(await controls.evaluate(() => ['chatgpt', 'gemini'].every((s) => !!document.querySelector(`.ss-viewer[data-site="${s}"]`))), 'a saved-copy box for ChatGPT and Gemini too');
    await shot('ss_04_gone');
    await noSideways('the result with the saved copy');
    await controls.click('#btn-savestate-close');
    for (const k of Object.keys(rules)) delete rules[k];

    console.log('\n== a save with an address that is not a real AI chat ==');
    const evil = JSON.parse(fs.readFileSync(file, 'utf8'));
    const evilText = fs.readFileSync(file, 'utf8').replace(JSON.stringify(evil.name), JSON.stringify('Hand edited')).split(CHAT.claude).join('https://evil.example.com/chat/1');
    fs.writeFileSync(path.join(saveDir, 'hand-edited.json'), evilText);
    await goTo('claude', at('claude', '/chat/stay'));
    await waitFor(async () => (await paneUrls()).claude === at('claude', '/chat/stay'), 8000);
    await controls.click('#btn-load-state');
    await controls.waitForSelector('#savestate-list .ss-item[data-id="hand-edited"] .ss-load', { timeout: 5000 });
    await controls.click('#savestate-list .ss-item[data-id="hand-edited"] .ss-load');
    await controls.waitForSelector('#savestate-result', { timeout: 30000 });
    const res3 = await controls.evaluate(() => { const li = document.querySelector('#savestate-result li[data-site="claude"]'); return li ? { state: li.dataset.state, text: li.textContent } : null; });
    assert(res3 && res3.state === 'refused' && /isn't a Claude chat address/.test(res3.text), `refused in plain words ("${res3 && res3.text}")`);
    assert((await paneUrls()).claude === at('claude', '/chat/stay'), 'Claude\'s pane did not go anywhere');
    await controls.click('#btn-savestate-close');

    console.log('\n== ✎ Rename and 🗑 Delete ==');
    await controls.click('#btn-load-state');
    await controls.waitForSelector('#savestate-list .ss-item[data-id="hand-edited"] .ss-rename', { timeout: 5000 });
    await controls.click('#savestate-list .ss-item[data-id="hand-edited"] .ss-rename');
    await controls.fill('#savestate-list .ss-rename-input', 'Hand edited (do not use)');
    await controls.click('#savestate-list .ss-rename-ok');
    await waitFor(() => controls.evaluate(() => [...document.querySelectorAll('#savestate-list .ss-name')].some((n) => n.textContent === 'Hand edited (do not use)')), 5000);
    assert(JSON.parse(fs.readFileSync(path.join(saveDir, 'hand-edited.json'), 'utf8')).name === 'Hand edited (do not use)', 'renamed (in the list and in its file)');
    await controls.click('#savestate-list .ss-item[data-id="hand-edited"] .ss-delete');
    await controls.click('#savestate-list .ss-item[data-id="hand-edited"] .ss-delete-yes');
    await waitFor(() => controls.evaluate(() => !document.querySelector('#savestate-list .ss-item[data-id="hand-edited"]')), 5000);
    assert(!fs.existsSync(path.join(saveDir, 'hand-edited.json')) && fs.existsSync(file), 'deleted — the other save stays');
    await controls.keyboard.press('Escape');
    assert(await controls.evaluate(() => !document.querySelector('#savestate-modal.on')), 'Escape closes the dialog');

    assert(!errors.length, `no page errors (${errors.join(' | ').slice(0, 300)})`);
    console.log(`  screenshots: ${SHOTS}`);
  } finally {
    await app.close().catch(() => {});
    srv.close();
  }
  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  return state.failed ? 1 : 0;
}
main().then((c) => process.exit(c || 0), (e) => { console.error(e); process.exit(1); });
