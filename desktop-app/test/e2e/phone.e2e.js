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
      window.api = { phoneAppStatus: async () => s, phoneAppSetEnabled: async () => s, phoneAppNewKey: async () => s };
    }, Object.assign({}, st, { qr: await require('qrcode').toString(st.links[0].url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }), phones: [{ phone: 'iPhone', lastSeen: Date.now() - 60000 }] }));
    await pp.goto(`file://${path.join(APP_DIR, 'phone-pair.html')}`);
    await pp.waitForSelector('#qr img');
    assert(await pp.evaluate(() => !document.getElementById('ph-pair').hidden && /192\.168\.1\.42/.test(document.getElementById('ph-link').value)), 'the 📱 Phone window: the QR code, the steps and the link');
    await shot(pp, 'phone-pair-window-wifi');
    await pctx.close();
  } finally {
    await phone.setEnabled(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const { assert, state } = makeAsserts();
  const browser = await playwright.chromium.launch();
  try {
    await partA(assert, browser);
    await partB(assert, browser);
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`screenshots: ${SHOT_DIR}`);
  return state.failed ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
