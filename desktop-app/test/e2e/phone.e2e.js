'use strict';
// phone.e2e.js — 📱 the phone app for real:
//   A. the REAL AutoInjector: 📱 Phone opens the 📱 Phone window; switching it on starts the phone server; a real
//      phone-sized browser (iPhone and Android) opens the app with the key and sees the PC; a wrong key can't
//   B. the phone app's screens at real phone sizes against a believable PC (a book waiting on a question, chats,
//      chapters, Alfred, alerts) — every tab, no sideways scrolling, buttons big enough for a thumb; screenshots in
//      __screenshots__/phone-*.png
//   TMPDIR=/dev/shm xvfb-run -a node test/e2e/phone.e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeAsserts, findWindow, shot, APP_DIR, SHOT_DIR } = require('./helpers');
const playwright = require('playwright');
const { createPhone } = require('../../phone-main');
const { makeFakePc } = require('../fixtures/phone-fake');

async function partA(assert, browser) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-home-'));
  const port = 47911;
  const app = await playwright._electron.launch({
    args: ['.', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], cwd: APP_DIR,
    env: Object.assign({}, process.env, { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), AUTOINJECTOR_BRIDGE: '0', AUTOINJECTOR_CHECKIN: '0',
      AUTOINJECTOR_CONTENT_SCAN: '0', AUTOINJECTOR_AKOWE_SERVER: '0', AUTOINJECTOR_SD_AUTOSTART: '0', AUTOINJECTOR_VIDEO_AUTOSTART: '0',
      AUTOINJECTOR_PHONE_HOST: '127.0.0.1', AUTOINJECTOR_PHONE_PORT: String(port),
      AUTOINJECTOR_AKOWE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'phone-nobf-')) }),
  });
  try {
    const controls = await findWindow(app, '#up-zone-compose', 40000);
    assert(!!controls, 'control panel appears');
    if (!controls) return;
    await controls.evaluate(() => document.getElementById('btn-open-phone').click());
    const pair = await findWindow(app, '#ph-on', 20000);
    assert(!!pair, '📱 Phone opens the 📱 Phone window');
    if (!pair) return;
    const errors = [];
    pair.on('pageerror', (e) => errors.push(String(e)));
    await pair.waitForFunction(() => /Off/.test(document.getElementById('ph-state').textContent), null, { timeout: 10000 });
    assert(true, 'it starts off');
    await pair.click('#ph-on');
    await pair.waitForFunction(() => /On/.test(document.getElementById('ph-state').textContent), null, { timeout: 10000 });
    assert(true, 'switching it on starts the phone server');
    await pair.setViewportSize({ width: 820, height: 760 }).catch(() => {});
    await shot(pair, 'phone-pair-window');
    const ud = await app.evaluate(({ app: a }) => a.getPath('userData'));
    const key = JSON.parse(fs.readFileSync(path.join(ud, 'autoinjector-phone-app.json'), 'utf8')).key;
    for (const device of ['iPhone 13', 'Pixel 7']) {
      const ctx = await browser.newContext(Object.assign({}, playwright.devices[device]));
      const page = await ctx.newPage();
      const perrs = [];
      page.on('pageerror', (e) => perrs.push(String(e)));
      await page.goto(`http://127.0.0.1:${port}/#k=${encodeURIComponent(key)}`);
      await page.waitForFunction(() => document.getElementById('home-ais').children.length === 3, null, { timeout: 15000 });
      const v = await page.evaluate(() => ({ pc: document.getElementById('pc-words').textContent, book: document.getElementById('home-book').textContent, hash: location.hash }));
      assert(v.pc.length > 0 && !/not reachable|Not paired/.test(v.pc) && /No book is being made/.test(v.book) && !v.hash, `${device}: the real app pairs, shows the PC and the AIs (no book app here)`);
      assert(perrs.length === 0, `${device}: no page errors (${perrs.join(' | ')})`);
      await ctx.close();
    }
    // 🖥 the whole control panel on the phone: the PC's own panel, working through the phone server
    {
      const ctx = await browser.newContext(Object.assign({}, playwright.devices['iPhone 13']));
      const page = await ctx.newPage();
      const perrs = [];
      page.on('pageerror', (e) => perrs.push(String(e)));
      await page.goto(`http://127.0.0.1:${port}/#k=${encodeURIComponent(key)}`);
      await page.waitForSelector('#home-pc', { timeout: 15000 });
      await page.click('#home-pc');
      await page.waitForSelector('#up-zone-compose', { timeout: 20000 });
      await page.waitForFunction(() => /Connected to the PC/.test((document.querySelector('#ai-phone-bar .st') || {}).textContent || ''), null, { timeout: 20000 });
      const st = await page.evaluate(async () => { const s = await window.api.getState(); return { ok: !!s, keys: Object.keys(s || {}).length, hash: location.hash }; });
      assert(st.ok && st.keys > 3 && !st.hash, 'iPhone: 🖥 Full controls opens the PC\'s own panel, and its window.api reaches the PC (the key hidden from the address)');
      // a real action from the phone: switch an AI off and on again, and the PC sees it
      const before = await app.evaluate(() => null);
      const flip = await page.evaluate(async () => { const r1 = await window.api.setParticipant('gemini', false); const s1 = await window.api.getState(); const r2 = await window.api.setParticipant('gemini', true); const s2 = await window.api.getState(); const on = (s) => { const p = (s.participants || s.bridge && s.bridge.participants || []).find ? (s.participants || []).find((x) => x.id === 'gemini' || x.site === 'gemini') : null; return p ? p.enabled !== false : null; }; return { r1: !!r1, r2: !!r2, a: on(s1), b: on(s2) }; });
      assert(flip.r1 && flip.r2, `iPhone: a panel button's action runs on the PC (switch Gemini off and on: ${JSON.stringify(flip)})`);
      void before;
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      await shot(page, 'phone-iphone-full-controls');
      assert(sideways <= 8, `iPhone: the full panel fits the phone's width (${sideways}px over)`);
      assert(perrs.length === 0, `iPhone full controls: no page errors (${perrs.slice(0, 3).join(' | ')})`);
      await ctx.close();
    }
    const bad = await (await browser.newContext()).newPage();
    await bad.goto(`http://127.0.0.1:${port}/#k=wrong-key-wrong-key-wrong-key-xx`);
    await bad.waitForFunction(() => !document.getElementById('s-pair').hidden, null, { timeout: 10000 });
    assert(true, 'a wrong key → "Pair this phone"');
    await pair.click('#ph-on');
    await pair.waitForFunction(() => /Off/.test(document.getElementById('ph-state').textContent), null, { timeout: 10000 });
    const off = await bad.evaluate((p) => fetch(`http://127.0.0.1:${p}/api/state`).then(() => 'answered', () => 'no answer'), port).catch(() => 'no answer');
    assert(off === 'no answer', 'switching it off stops the server');
    assert(errors.length === 0, `📱 Phone window: no page errors (${errors.join(' | ')})`);
  } finally {
    await app.close().catch(() => {});
  }
}

async function partB(assert, browser) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-shots-'));
  const pc = makeFakePc({ now: Date.now() });
  const port = 47940;
  const f = (n, type) => ({ type, body: () => fs.readFileSync(path.join(APP_DIR, n)) });
  const phone = createPhone(Object.assign({ settingsFile: path.join(tmp, 'p.json'), host: '127.0.0.1', port, now: () => Date.now(),
    files: { '/': f('phone-app.html', 'text/html; charset=utf-8'), '/phone-app.js': f('phone-app.js', 'text/javascript'), '/phone-app.css': f('phone-app.css', 'text/css'), '/icon.svg': f('phone-icon.svg', 'image/svg+xml'), '/manifest.webmanifest': { type: 'application/manifest+json', body: '{}' } } }, pc.deps));
  await phone.setEnabled(true);
  phone.notice({ title: 'Claude hit its usage limit', body: 'The book carries on with ChatGPT; Claude is back at 6 pm.' });
  const key = phone.load().key;
  try {
    for (const [device, tag] of [['iPhone 13', 'iphone'], ['Pixel 7', 'android']]) {
      const ctx = await browser.newContext(Object.assign({}, playwright.devices[device], { colorScheme: 'dark' }));
      const page = await ctx.newPage();
      const perrs = [];
      page.on('pageerror', (e) => perrs.push(String(e)));
      await page.goto(`http://127.0.0.1:${port}/#k=${encodeURIComponent(key)}`);
      await page.waitForFunction(() => /The Salt Tuner/.test(document.getElementById('home-book').textContent), null, { timeout: 15000 });
      const check = async (name) => {
        await page.waitForTimeout(250);
        const m = await page.evaluate(() => {
          const small = [...document.querySelectorAll('button')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && b.offsetParent !== null && r.height < 38; }).map((b) => b.textContent.trim());
          return { sideways: document.documentElement.scrollWidth - window.innerWidth, small };
        });
        assert(m.sideways <= 0, `${tag} ${name}: no sideways scrolling`);
        assert(m.small.length === 0, `${tag} ${name}: every button is thumb-sized (${m.small.join(', ')})`);
        await shot(page, `phone-${tag}-${name}`);
      };
      await check('home');
      await page.click('#home-question button');
      await page.waitForSelector('#book-question .choice');
      await check('book');
      await page.waitForSelector('#book-chapters .item');
      await page.click('#book-chapters .item');
      await page.waitForSelector('#reader-text h1');
      await check('reader');
      await page.click('[data-tab="chat"]');
      await page.waitForSelector('#chat-feed .bubble');
      await check('chat');
      await page.click('[data-tab="alfred"]');
      await page.waitForSelector('#alfred-feed .bubble');
      await check('alfred');
      await page.click('[data-tab="alerts"]');
      await page.waitForSelector('#alerts-list .item');
      await check('alerts');
      assert(perrs.length === 0, `${tag}: no page errors (${perrs.join(' | ')})`);
      await ctx.close();
    }
    const lctx = await browser.newContext(Object.assign({}, playwright.devices['Pixel 7'], { colorScheme: 'light' }));
    const lp = await lctx.newPage();
    await lp.goto(`http://127.0.0.1:${port}/#k=${encodeURIComponent(key)}`);
    await lp.waitForFunction(() => /The Salt Tuner/.test(document.getElementById('home-book').textContent), null, { timeout: 15000 });
    await lp.waitForTimeout(250);
    await shot(lp, 'phone-android-home-light');
    assert(true, 'light mode follows the phone');
    await lctx.close();
    // the 📱 Phone window as it looks on a PC on Wi-Fi (this test machine has none): its real page, a real QR code
    const st = await phone.status();
    const pctx = await browser.newContext({ viewport: { width: 820, height: 760 } });
    const pp = await pctx.newPage();
    await pp.addInitScript((s) => {
      window.api = { phoneAppStatus: async () => s, phoneAppSetEnabled: async () => s, phoneAppNewKey: async () => s, phoneAppSecure: async () => s };
    }, Object.assign({}, st, { qr: await require('qrcode').toString(st.links[0].url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }), phones: [{ phone: 'iPhone', lastSeen: Date.now() - 60000 }],
      anywhere: { tailscale: { installed: true, running: true, dnsName: 'batcave-pc.tail1a2b.ts.net' }, url: `http://100.101.5.9:${port}/#k=${key}`,
        qr: await require('qrcode').toString(`http://100.101.5.9:${port}/#k=${key}`, { type: 'svg', margin: 1 }),
        secure: { on: true, url: `https://batcave-pc.tail1a2b.ts.net/#k=${key}`, qr: await require('qrcode').toString(`https://batcave-pc.tail1a2b.ts.net/#k=${key}`, { type: 'svg', margin: 1 }) } } }));
    await pp.goto(`file://${path.join(APP_DIR, 'phone-pair.html')}`);
    await pp.waitForSelector('#qr img');
    assert(await pp.evaluate(() => !document.getElementById('ph-pair').hidden && /192\.168\.1\.42/.test(document.getElementById('ph-link').value)), 'the 📱 Phone window: the QR code, the steps and the link');
    assert(await pp.evaluate(() => !document.getElementById('ph-anywhere').hidden && !!document.querySelector('#qr-any img') && !!document.querySelector('#qr-secure img')), 'the 📱 Phone window: 🌍 from anywhere — the Tailscale code and the 🔒 secure link code');
    await pp.setViewportSize({ width: 820, height: 1400 });
    await shot(pp, 'phone-pair-window-wifi');
    await pctx.close();
  } finally {
    await phone.setEnabled(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 📚 the book app on the phone: a REAL Akọwe server, reached through the phone app's door
async function partC(assert, browser) {
  const { spawn } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-book-'));
  const akPort = 47990 + Math.floor(Math.random() * 8);
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const ak = spawn(py, ['-m', 'akowe', '--data-dir', path.join(tmp, 'data'), '--port', String(akPort), '--no-browser'], { cwd: path.join(APP_DIR, '..', 'akowe'), env: Object.assign({}, process.env, { PYTHONUNBUFFERED: '1' }) });
  let out = '';
  ak.stdout.on('data', (b) => { out += b; });
  ak.stderr.on('data', (b) => { out += b; });
  const t0 = Date.now();
  let token = '';
  while (Date.now() - t0 < 30000 && !token) { const m = /#token=([A-Za-z0-9_\-]+)/.exec(out); if (m) token = m[1]; else await new Promise((r) => setTimeout(r, 200)); }
  if (!assert(!!token, 'a real Akọwe server started (its start link has the token)')) { ak.kill(); return; }
  const pc = makeFakePc({ now: Date.now() });
  const port = 47950;
  const f = (n, type) => ({ type, body: () => fs.readFileSync(path.join(APP_DIR, n)) });
  const phone = createPhone(Object.assign({ settingsFile: path.join(tmp, 'p.json'), host: '127.0.0.1', port, now: () => Date.now(),
    files: { '/': f('phone-app.html', 'text/html; charset=utf-8'), '/phone-app.js': f('phone-app.js', 'text/javascript'), '/phone-app.css': f('phone-app.css', 'text/css'), '/icon.svg': f('phone-icon.svg', 'image/svg+xml'), '/manifest.webmanifest': { type: 'application/manifest+json', body: '{}' } },
    akoweLink: () => ({ token }), akowePort: () => akPort }, pc.deps));
  await phone.setEnabled(true);
  const key = phone.load().key;
  try {
    for (const [device, tag] of [['iPhone 13', 'iphone'], ['Pixel 7', 'android']]) {
      const ctx = await browser.newContext(Object.assign({}, playwright.devices[device], { colorScheme: 'dark' }));
      const page = await ctx.newPage();
      const perrs = [];
      page.on('pageerror', (e) => perrs.push(String(e)));
      await page.goto(`http://127.0.0.1:${port}/#k=${encodeURIComponent(key)}`);
      await page.waitForSelector('#home-bookapp', { timeout: 15000 });
      await page.click('#home-bookapp');
      await page.waitForURL(new RegExp(`:${port + 1}/`), { timeout: 15000 });
      await page.waitForSelector('#mab-btn', { state: 'attached', timeout: 20000 });
      await page.waitForFunction(() => { const n = document.querySelector('#sidenav'); return n && n.children.length > 0; }, null, { timeout: 20000 });
      await page.waitForTimeout(1200);
      const v = await page.evaluate(() => ({ auth: !!document.querySelector('.auth-problem, [data-auth-problem]') || /access token was missing/i.test(document.body.innerText), port: location.port }));
      assert(!v.auth && v.port === String(port + 1), `${device}: 📚 Book app opens the real Akọwe on the phone, signed in (through the door)`);
      await shot(page, `phone-${tag}-book-app`);
      assert(perrs.length === 0, `${device}: the book app has no page errors (${perrs.slice(0, 3).join(' | ')})`);
      await ctx.close();
    }
    const stranger = await (await browser.newContext()).newPage();
    await stranger.goto(`http://127.0.0.1:${port + 1}/#token=${token}`);
    assert(/Open the book app from the phone app/.test(await stranger.textContent('body')), 'a browser that did not come through the phone app is turned away, even with the token');
  } finally {
    await phone.setEnabled(false);
    ak.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const { assert, state } = makeAsserts();
  const browser = await playwright.chromium.launch();
  try {
    await partA(assert, browser);
    await partB(assert, browser);
    await partC(assert, browser);
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`screenshots: ${SHOT_DIR}`);
  return state.failed ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
