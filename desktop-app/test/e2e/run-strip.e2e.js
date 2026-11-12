'use strict';
// run-strip.e2e.js — ⏳ the book run's progress in the REAL title bar (run-strip-ui.js), at real widths:
//   * at 1600 px the whole line shows (title, step, time left against the start estimate, finish time)
//   * at 1280 px it shrinks to the short line ("⏳ 1 h 40 m left · ~11:05 · 12/19"; 💾 / 📂 show their icons only),
//     at 1024 px to the tiny one ("⏳ 1 h 40 m") — the title bar never scrolls sideways, and 💾 / 📂 / ❓ Help stay
//     whole and visible
//   * waiting for the user / finished lines fit too; a long book title only ellipsizes
// Screenshots: __screenshots__/run-strip-*.png
//   TMPDIR=/dev/shm xvfb-run -a node test/e2e/run-strip.e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeAsserts, findWindow, shot, APP_DIR } = require('./helpers');
const electron = require('playwright')._electron;

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

async function main() {
  const { assert, state } = makeAsserts();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'run-strip-home-'));
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], cwd: APP_DIR,
    env: Object.assign({}, process.env, { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), AUTOINJECTOR_BRIDGE: '0', AUTOINJECTOR_CHECKIN: '0',
      AUTOINJECTOR_CONTENT_SCAN: '0', AUTOINJECTOR_AKOWE_SERVER: '0', AUTOINJECTOR_SD_AUTOSTART: '0', AUTOINJECTOR_VIDEO_AUTOSTART: '0',
      AUTOINJECTOR_AKOWE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'run-strip-nobf-')) }),
  });
  try {
    const controls = await findWindow(app, '#up-zone-compose', 40000);
    assert(!!controls, 'control panel appears');
    if (!controls) return 1;
    const errors = [];
    controls.on('pageerror', (e) => errors.push(String(e)));
    await controls.waitForFunction(() => window.runStripUi && typeof window.akoweRenderRunStrip === 'function', null, { timeout: 15000 });
    const now = Date.now();
    const run = (extra) => Object.assign({ id: 'run-1', status: 'running', state: 'working', title: 'The Very Long Title of the Lantern Keeper and the Salt Road Across the Northern Sea',
      steps_done: 11, steps_total: 22, step_index: 12, step_total: 19, step_label: 'Writing chapter 2 of 10', left_s: 6000, total_estimate_s: 15000, percent: 40,
      finish_at: iso(now + 6000e3), started_at: iso(now - 3600e3), updated_at: iso(now) }, extra || {});
    // the 4-second status refresh would put back what main knows (no run here): hold the line we show
    const show = (r) => controls.evaluate((rr) => {
      window.akoweRenderRunStrip = () => {};
      const sum = rr ? Object.assign({}, rr) : null;
      window.runStripUi.render(document.getElementById('btn-run-strip'), sum, { base: 'http://127.0.0.1:8780/' });
    }, r);
    const measure = () => controls.evaluate(() => {
      const bar = document.getElementById('window-titlebar');
      const b = document.getElementById('btn-run-strip');
      const vis = (id) => { const n = document.getElementById(id); if (!n) return false; const r = n.getBoundingClientRect(); return r.width > 0 && r.right <= window.innerWidth + 0.5; };
      const lng = b.querySelector('.rsx-long'), sht = b.querySelector('.rsx-short'), tny = b.querySelector('.rsx-tiny');
      const shown = [lng, sht, tny].filter((n) => getComputedStyle(n).display !== 'none');
      return { over: bar.scrollWidth - bar.clientWidth, doc: document.documentElement.scrollWidth - window.innerWidth, w: b.getBoundingClientRect().width,
        which: shown.map((n) => n.className).join(','), text: shown.map((n) => n.textContent).join(' | '), clipped: shown.some((n) => n.scrollWidth > n.clientWidth + 1),
        help: vis('btn-ease-help'), save: vis('btn-save-state'), load: vis('btn-load-state'), collapse: vis('btn-collapse-window') };
    });
    // akowe-run.js shapes the summary in main; here the same shape by hand (progress + state words)
    const sumOf = (r) => ({ id: r.id, title: r.title, state: r.state === 'working' ? 'writing' : r.state, total: r.steps_total, done: r.steps_done,
      progress: { total_estimate_s: r.total_estimate_s, left_s: r.left_s, percent: r.percent, step_index: r.step_index, step_total: r.step_total, step_label: r.step_label,
        finish_at: r.finish_at, started_at: r.started_at, waiting_since: r.waiting_since || null, actual_s: r.actual_s || null, finished_at: r.finished_at || null, run_url: null } });
    for (const [width, want] of [[1600, 'rsx-long'], [1280, 'rsx-short'], [1024, 'rsx-tiny']]) {
      await controls.setViewportSize({ width, height: 760 }).catch(() => {});
      await show(sumOf(run()));
      await controls.waitForTimeout(150);
      let m = await measure();
      assert(m.w > 40 && m.which === want, `${width} px: the ${want} line shows (“${m.text}”)`);
      if (want !== 'rsx-long') assert(!m.clipped, `${width} px: the ${want} line is not cut off`);
      assert(m.over <= 0 && m.doc <= 0, `${width} px: no sideways scrolling (title bar +${m.over}, page +${m.doc})`);
      assert(m.help && m.save && m.load && m.collapse, `${width} px: 💾 / 📂 / ❓ Help / ⌄ stay visible`);
      if (want === 'rsx-long') assert(/Step 12 of 19 — Writing chapter 2 of 10 · ⏳ 1 h 40 m left \(estimate at start: 4 h 10 m\) · ends ~/.test(m.text), 'the whole line: step, time left, estimate, finish');
      else if (want === 'rsx-short') assert(/^⏳ 1 h 40 m left · ~.+ · 12\/19$/.test(m.text), 'the short line: time left, finish, step');
      else assert(m.text === '⏳ 1 h 40 m', 'the tiny line: time left');
      await shot(controls, `run-strip-${width}`);
      await show(sumOf(run({ state: 'needs_you', status: 'paused', waiting_since: iso(now - 600e3), finish_at: null })));
      m = await measure();
      assert(m.over <= 0 && !(want !== 'rsx-long' && m.clipped) && /aiting for you|the clock is paused|Needs you/.test(m.text), `${width} px: waiting for you fits (“${m.text}”)`);
      await show(sumOf(run({ state: 'finished', status: 'done', actual_s: 18120, finished_at: iso(now - 60e3) })));
      m = await measure();
      assert(m.over <= 0 && !(want !== 'rsx-long' && m.clipped) && /[Ff]inished/.test(m.text), `${width} px: finished fits (“${m.text}”)`);
    }
    assert(!errors.length, `no page errors (${errors.join(' | ').slice(0, 300)})`);
  } finally {
    await app.close().catch(() => {});
  }
  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  return state.failed ? 1 : 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
