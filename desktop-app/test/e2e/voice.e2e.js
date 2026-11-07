'use strict';
// voice.e2e.js — 🎤 talk to the AIs + 🔊 read their replies, in the REAL Electron app with fake AI sites
// (test/fixtures/fake-chat.html) and a fake voice shim the app starts itself (test/fixtures/fake-voice-shim.js via
// AUTOINJECTOR_VOICE_SPAWN): the 🎤 + "who hears it" in the title bar, a 🎤 in every pane header and ◀ 🔊 ▶ "n / m"
// beside 💬 Last reply; three captured Claude replies -> "3 / 3", ◀ -> "2 / 3"; 🔊 reads the selected reply with
// this PC's voices (speechSynthesis, stubbed in the page to record what is said) — a different voice for ChatGPT
// and Claude — and ⏹ stops it at once; the mic records (Chromium's fake microphone), the words go to the voice
// shim and are sent to every ticked AI, or only to one AI from its pane header. Nothing wraps or is cut off at
// 1280×720 and 1920×1080 (screenshots at 2× in SHOTS).
//   TMPDIR=/dev/shm xvfb-run -a -s "-screen 0 3840x2200x24" node test/e2e/voice.e2e.js
// Env: SHOTS=<dir> (default test/e2e/__screenshots__/voice).
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');
const { makeAsserts, APP_DIR } = require('./helpers');
const electron = require('playwright')._electron;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.SHOTS || path.join(__dirname, '__screenshots__', 'voice');
function freePort() { return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
async function until(fn, ms, every = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(every); }
  return null;
}
function screen(name, w, h) { // the whole window incl. the native AI panes, at 2×
  if (!process.env.DISPLAY) return;
  try { fs.mkdirSync(SHOTS, { recursive: true }); execFileSync('import', ['-window', 'root', '-crop', `${w * 2}x${h * 2}+0+0`, path.join(SHOTS, `${name}.png`)], { timeout: 20000 }); console.log(`  (screenshot ${name}.png)`); }
  catch (e) { console.log(`  (no screenshot ${name}: ${String(e.message || e).slice(0, 80)})`); }
}

const LONG = Array.from({ length: 14 }, (_, i) => `This is sentence ${i + 1} of a long answer that is read in short pieces.`).join(' ');

async function main() {
  const { assert, state } = makeAsserts();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-e2e-home-'));
  const fake = 'file://' + path.join(APP_DIR, 'test', 'fixtures', 'fake-chat.html');
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--force-device-scale-factor=2', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    cwd: APP_DIR,
    env: Object.assign({}, process.env, {
      HOME: home, AUTOINJECTOR_AKOWE_SERVER: '0', AUTOINJECTOR_CHECKIN: '0', AUTOINJECTOR_BRIDGE: '0', AUTOINJECTOR_SD_AUTOSTART: '0',
      AUTOINJECTOR_VIDEO_AUTOSTART: '0', AUTOINJECTOR_CONTENT_SCAN: '0', AUTOINJECTOR_SD_HOME: path.join(home, 'sdhome'),
      AUTOINJECTOR_SITE_URL_CHATGPT: `${fake}?site=chatgpt&quirks=none`, AUTOINJECTOR_SITE_URL_CLAUDE: `${fake}?site=claude&quirks=none`, AUTOINJECTOR_SITE_URL_GEMINI: `${fake}?site=gemini&quirks=none`,
      AUTOINJECTOR_VOICE_SPAWN: process.execPath, AUTOINJECTOR_VOICE_SHIM: path.join(APP_DIR, 'test', 'fixtures', 'fake-voice-shim.js'),
      AUTOINJECTOR_VOICE_PORT: String(await freePort()), ELECTRON_RUN_AS_NODE: '', FAKE_VOICE_TEXT: 'what do you think of chapter two',
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    }),
  });
  try {
    const controls = await until(async () => { for (const w of app.windows()) { if (await w.$('#btn-voice-mic').catch(() => null)) return w; } return null; }, 40000, 400);
    assert(!!controls, 'the control panel appears with the 🎤 in the title bar');
    if (!controls) return 1;
    const size = async (w, h) => { await app.evaluate(({ BaseWindow }, [w, h]) => { const b = BaseWindow.getAllWindows()[0]; b.setSize(w, h); b.setPosition(0, 0); }, [w, h]); await sleep(1200); };
    await size(1280, 720);
    const pane = async (site) => until(() => app.windows().find((w) => { try { return w.url().includes(`site=${site}`); } catch (_) { return false; } }), 20000, 300);
    const pages = { chatgpt: await pane('chatgpt'), claude: await pane('claude'), gemini: await pane('gemini') };
    assert(Object.values(pages).every(Boolean), 'the three fake AI pages are up');
    // every fake reply is addressed to the user ([TO: USER]) so nothing is relayed between the AIs
    for (const [site, p] of Object.entries(pages)) {
      await p.waitForFunction(() => window.__fake && window.__fake.posted, null, { timeout: 15000 }).catch(() => {});
      await p.evaluate((long) => { let k = 0; window.__fakeHook = async () => { k++; return { lines: [k === 1 ? long : `Reply number ${k} for the read-aloud test.`], to: 'USER' }; }; }, LONG);
      void site;
    }

    console.log('\n== the buttons are there ==');
    for (const sel of ['#btn-voice-mic', '#voice-mic-target']) assert(!!(await controls.$(`#window-titlebar ${sel}`)), `title bar: ${sel}`);
    const order = await controls.evaluate(() => [...document.getElementById('window-titlebar').children].map((e) => e.id || e.className));
    assert(order.indexOf('voice-bar') >= 0 && order.indexOf('voice-bar') === order.indexOf('btn-alfred-switch') - 1, `the 🎤 sits next to the 🎩 switch (${order.join(' · ')})`);
    for (const s of ['chatgpt', 'claude', 'gemini']) {
      assert(!!(await controls.$(`#col-${s} .card-head #voice-mic-${s}`)), `${s}: 🎤 in the pane header`);
      assert(!!(await controls.$(`#col-${s} .locker-tabs #voice-prev-${s}`)) && !!(await controls.$(`#voice-play-${s}`)) && !!(await controls.$(`#voice-next-${s}`)), `${s}: ◀ 🔊 ▶`);
    }
    const opts = await controls.$$eval('#voice-mic-target option', (os) => os.map((o) => o.textContent));
    assert(opts.join(',') === 'All,ChatGPT,Claude,Gemini', `who hears it: ${opts.join(' · ')}`);

    console.log('\n== three Claude replies, one ChatGPT reply -> the counters ==');
    for (let i = 1; i <= 3; i++) {
      await controls.evaluate((i) => window.api.sendCompose(`Claude, question ${i}`, ['claude']), i);
      const got = await until(() => controls.evaluate((n) => document.getElementById('voice-count-claude').textContent === `${n} / ${n}`, i), 30000, 300);
      assert(!!got, `Claude reply ${i} captured -> "${i} / ${i}"`);
    }
    await controls.evaluate(() => window.api.sendCompose('ChatGPT, one question', ['chatgpt']));
    assert(!!(await until(() => controls.evaluate(() => document.getElementById('voice-count-chatgpt').textContent === '1 / 1'), 30000, 300)), 'ChatGPT: "1 / 1"');
    await controls.click('#voice-prev-claude');
    const c2 = await controls.textContent('#voice-count-claude');
    assert(c2 === '2 / 3', `◀ -> "${c2}"`);
    const tip = await controls.getAttribute('#voice-play-claude', 'title');
    assert(/reply 2 of 3: “Reply number 2/.test(tip), `the 🔊 tooltip names the reply ("${tip}")`);

    console.log('\n== 🔊 reads with this PC\'s voices (stubbed), ⏹ stops ==');
    await controls.evaluate(() => {
      const said = window.__said = [];
      const voices = [{ name: 'Microsoft David', lang: 'en-US', localService: true }, { name: 'Microsoft Zira', lang: 'en-US', localService: true }, { name: 'Microsoft Mark', lang: 'en-US', localService: true }, { name: 'Microsoft George', lang: 'en-GB', localService: true }];
      let timers = [];
      window.__cancels = 0;
      const fake = {
        getVoices: () => voices, addEventListener() {},
        speak(u) { said.push({ text: u.text, voice: u.voice && u.voice.name, at: Date.now() }); const t = setTimeout(() => { if (u.onend) u.onend({}); }, 250); timers.push(t); },
        cancel() { window.__cancels++; timers.forEach(clearTimeout); timers = []; },
      };
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: fake });
      window.SpeechSynthesisUtterance = function (text) { this.text = text; };
    });
    await controls.click('#voice-play-claude');
    await until(() => controls.evaluate(() => window.__said.length > 0), 5000, 50);
    const playing = await controls.textContent('#voice-play-claude');
    assert(playing === '⏹', `while reading the button shows ⏹ ("${playing}")`);
    await until(() => controls.evaluate(() => document.getElementById('voice-play-claude').textContent === '🔊'), 8000, 100);
    let said = await controls.evaluate(() => window.__said);
    assert(said.length === 1 && /Reply number 2 for the read-aloud test\./.test(said[0].text) && !/\[TO|\[FROM/.test(said[0].text), `read reply 2 of 3 through speechSynthesis ("${said[0] && said[0].text}")`);
    const claudeVoice = said[0] && said[0].voice;
    // ChatGPT's first reply is long: several pieces; stop after the first
    await controls.evaluate(() => { window.__said.length = 0; });
    await controls.click('#voice-play-chatgpt');
    await until(() => controls.evaluate(() => window.__said.length >= 1), 5000, 50);
    await shotState(controls, 'reading');
    await sleep(100);
    await controls.click('#voice-play-chatgpt');
    const n1 = await controls.evaluate(() => window.__said.length);
    await sleep(900);
    said = await controls.evaluate(() => window.__said);
    assert(n1 >= 1 && said.length === n1 && (await controls.evaluate(() => window.__cancels)) > 0, `⏹ stopped it after ${n1} of many pieces`);
    assert((await controls.textContent('#voice-play-chatgpt')) === '🔊', 'and the button is 🔊 again');
    assert(said[0].voice && claudeVoice && said[0].voice !== claudeVoice, `ChatGPT and Claude have different voices (${said[0].voice} / ${claudeVoice})`);
    const synthCalls = await (async () => { const st = await controls.evaluate(() => window.api.voiceStatus()); return st; })();
    assert(synthCalls && synthCalls.managed, 'the app started the voice shim itself (managed)');

    console.log('\n== 🎤 title bar -> every ticked AI ==');
    const posted = async () => { const o = {}; for (const [s, p] of Object.entries(pages)) o[s] = await p.evaluate(() => window.__fake.posted.map((x) => x.text)); return o; };
    const before = await posted();
    const gum = await controls.evaluate(async () => { try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); return 'ok'; } catch (e) { return e.name; } });
    if (gum !== 'ok') {
      console.log(`  (no fake microphone here: ${gum} — using a stub recorder)`);
      await controls.evaluate(() => {
        navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() {} }] });
        window.MediaRecorder = class { constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; } static isTypeSupported() { return true; } start() { this.state = 'recording'; } stop() { this.state = 'inactive'; setTimeout(() => { this.ondataavailable({ data: new Blob([new Uint8Array(4000)], { type: 'audio/webm' }) }); this.onstop(); }, 10); } };
      });
    }
    assert(true, `microphone: ${gum === 'ok' ? 'Chromium\'s fake microphone, allowed by the control panel\'s permission handler' : 'stub'}`);
    await controls.click('#btn-voice-mic');
    await sleep(1300);
    const recTxt = await controls.textContent('#btn-voice-mic');
    assert(/^⏺ 0:0[1-9]$/.test(recTxt) && await controls.evaluate(() => document.getElementById('btn-voice-mic').classList.contains('rec')), `recording: red with a timer ("${recTxt}")`);
    await shotState(controls, 'recording');
    await controls.click('#btn-voice-mic');
    const heard = await until(async () => { const t = await controls.textContent('#voice-heard'); return /sent to/.test(t) ? t : null; }, 20000, 200);
    assert(heard && /Heard: “what do you think of chapter two” → sent to ChatGPT, Claude, Gemini/.test(heard), `the heard line: "${heard}"`);
    const got = await until(async () => { const o = await posted(); return ['chatgpt', 'claude', 'gemini'].every((s) => o[s].length > before[s].length && /what do you think of chapter two/.test(o[s][o[s].length - 1])) ? o : null; }, 20000, 300);
    assert(!!got, 'all three AI pages received the spoken words (through the normal send)');
    await shotState(controls, 'heard');

    console.log('\n== 🎤 in Claude\'s header -> Claude only ==');
    const b2 = await posted();
    await controls.click('#voice-mic-claude');
    await sleep(1100);
    assert(await controls.evaluate(() => document.getElementById('voice-mic-claude').classList.contains('rec')), 'Claude\'s 🎤 is red while recording');
    await controls.click('#voice-mic-claude');
    const heard2 = await until(async () => { const t = await controls.textContent('#voice-heard'); return /sent to Claude/.test(t) && !/ChatGPT/.test(t) ? t : null; }, 20000, 200);
    assert(!!heard2, `"${heard2}"`);
    await sleep(2500);
    const a2 = await posted();
    assert(a2.claude.length === b2.claude.length + 1 && a2.chatgpt.length === b2.chatgpt.length && a2.gemini.length === b2.gemini.length, 'only Claude received it');

    console.log('\n== Esc stops a recording without sending ==');
    const b3 = await posted();
    await controls.click('#btn-voice-mic');
    await sleep(700);
    await controls.keyboard.press('Escape');
    await sleep(1500);
    const a3 = await posted();
    assert(/nothing was sent/.test(await controls.textContent('#voice-heard')) && ['chatgpt', 'claude', 'gemini'].every((s) => a3[s].length === b3[s].length), 'Esc: "Stopped — nothing was sent."');

    console.log('\n== layout: nothing wraps or is cut off ==');
    for (const [w, h] of [[1280, 720], [1920, 1080]]) {
      await size(w, h);
      await controls.evaluate(() => window.VoiceUI.say('🎤 Heard: “what do you think of chapter two, and could you also look at the ending” → sent to ChatGPT, Claude, Gemini', {}));
      const m = await controls.evaluate(() => {
        const tb = document.getElementById('window-titlebar');
        const r = (e) => e.getBoundingClientRect();
        const out = { tbOverflow: tb.scrollWidth > tb.clientWidth + 1, tbH: r(tb).height, panes: {} };
        out.tallButtons = [...tb.querySelectorAll('button, select')].filter((e) => e.offsetParent !== null && r(e).height > 30).map((e) => e.id || e.textContent.trim());
        const ht = document.querySelector('#voice-heard .vh-text');
        out.heardEllipsis = !!ht && ht.scrollWidth > ht.clientWidth;
        const bar = document.getElementById('voice-bar');
        out.barInside = r(bar).right <= r(document.getElementById('btn-alfred-switch')).left + 1;
        for (const s of ['chatgpt', 'claude', 'gemini']) {
          const head = document.querySelector(`#col-${s} .card-head`);
          const tabs = document.querySelector(`#col-${s} .locker-tabs`);
          const kids = [...head.children].filter((e) => e.offsetParent !== null);
          const tops = new Set([...head.querySelectorAll('button')].filter((e) => e.offsetParent !== null).map((e) => Math.round(r(e).top)));
          const ttops = new Set([...tabs.children].filter((e) => e.offsetParent !== null).map((e) => Math.round(r(e).top + r(e).height / 2)));
          out.panes[s] = { headOverflow: head.scrollWidth > head.clientWidth + 1, headRows: tops.size, tabsOverflow: tabs.scrollWidth > tabs.clientWidth + 1, tabsRows: ttops.size, lastInside: r(kids[kids.length - 1]).right <= r(head).right + 1 };
        }
        return out;
      });
      assert(!m.tbOverflow && m.tbH <= 40 && m.barInside && m.tallButtons.length === 0, `${w}×${h}: the title bar fits on one line, no button wraps (height ${m.tbH}; wrapped: ${m.tallButtons.join(', ') || 'none'})`);
      if (w === 1280) assert(m.heardEllipsis, '1280×720: a long heard line is shortened with … instead of squeezing the tabs');
      for (const [s, p] of Object.entries(m.panes)) assert(!p.headOverflow && p.headRows === 1 && p.lastInside && !p.tabsOverflow && p.tabsRows === 1, `${w}×${h}: ${s}'s header and ◀ 🔊 ▶ row fit on one line each (${JSON.stringify(p)})`);
      await sleep(400); // let the window repaint before the screen grab
      screen(`voice-${w}x${h}`, w, h);
    }

    console.log('\n== 🎩 Alfred on (his side panel takes room): nothing is cut off; he is a 🎤 target ==');
    await size(1280, 720);
    await controls.evaluate(() => window.api.alfredSetEnabled(true));
    await until(() => controls.evaluate(() => document.body.classList.contains('alfred-open')), 10000, 200);
    await sleep(1200);
    const opts2 = await controls.$$eval('#voice-mic-target option', (os) => os.map((o) => o.value));
    assert(opts2.includes('butler'), `the picker now offers 🎩 Alfred (${opts2.join(' · ')})`);
    const cut = await controls.evaluate(() => {
      const r = (e) => e.getBoundingClientRect();
      const tb = document.getElementById('window-titlebar');
      const bad = [];
      if (tb.scrollWidth > tb.clientWidth + 1) bad.push('title bar');
      for (const e of tb.querySelectorAll('button, select')) if (e.offsetParent !== null && r(e).height > 30) bad.push(`title bar ${e.id || e.textContent.trim()} (wraps)`);
      for (const s of ['chatgpt', 'claude', 'gemini']) {
        for (const sel of ['.card-head', '.locker-tabs']) {
          const box = document.querySelector(`#col-${s} ${sel}`);
          const br = r(box);
          for (const e of box.querySelectorAll('button, .vr-count')) { if (e.offsetParent === null) continue; const er = r(e); if (er.right > br.right + 1 || er.left < br.left - 1) bad.push(`${s} ${e.id || e.textContent.trim()} (cut off)`); if (er.height > 30) bad.push(`${s} ${e.id || e.textContent.trim()} (wraps)`); }
        }
      }
      return bad;
    });
    assert(cut.length === 0, `no button is cut off or wraps with his panel open (${cut.join(', ') || 'none'})`);
    await sleep(300);
    screen('voice-1280x720-alfred-on', 1280, 720);
  } finally {
    await app.close().catch(() => {});
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  return state.failed ? 1 : 0;

  async function shotState(_c, name) { screen(`state-${name}`, 1280, 720); }
}

const backstop = setTimeout(() => { console.error('voice e2e: timed out'); process.exit(1); }, 8 * 60 * 1000);
main().then((code) => { clearTimeout(backstop); process.exit(code); }).catch((e) => { console.error(e); process.exit(1); });
