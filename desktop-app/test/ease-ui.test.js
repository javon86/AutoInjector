'use strict';
// test/ease-ui.test.js — ease-ui.js in jsdom with a stub window.api: the ❓ Help button and its menu, the ✅ Setup
// checklist (grouped rows, ✅ / ❌ / ⚪ / ⏳, "don't show again", every kind of Fix it), 🩺 Something's wrong? (problems
// with their fix buttons, "nothing looks wrong", the support report), the guided tours (Skip / Next / Done, "seen"
// saved, not shown again, Replay tours), the first start (checklist, then the main tour), a tab's first opening
// starts its tour, the Help menu events from main, Esc, and the AI panes re-synced whenever a pop-up opens or closes.
// Run: node test/ease-ui.test.js
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'ease-ui.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'controls.html'), 'utf8');

const CHECKLIST = {
  ok: true, autoOpen: true, neededOk: false, neededBad: 1, summary: '1 thing needed for books needs fixing.',
  items: [
    { id: 'pane-chatgpt', group: 'needed', title: 'Signed in to ChatGPT', ok: false, text: 'ChatGPT is not signed in.', fix: { label: 'Open ChatGPT to sign in', action: 'pane-open', args: { site: 'chatgpt' } } },
    { id: 'pane-claude', group: 'needed', title: 'Signed in to Claude', ok: true, text: 'Claude is signed in and answering.' },
    { id: 'pane-gemini', group: 'needed', title: 'Signed in to Gemini', ok: null, text: 'Not checked yet.', fix: { label: 'Check now', action: 'pane-check', args: { site: 'gemini' } } },
    { id: 'akowe', group: 'needed', title: 'Akọwe is running', ok: false, text: 'Akọwe is not running.', fix: { label: '▶ Start Akọwe', action: 'akowe-start', args: {} } },
    { id: 'voice', group: 'optional', title: 'Voice engine', ok: false, text: 'Not installed.', fix: { label: '🧙 Install it', action: 'wizard', args: { tab: 'advanced' } } },
    { id: 'sd', group: 'optional', title: 'Stable Diffusion', ok: false, text: 'No Stable Diffusion found.', fix: { label: 'Open 🎨 Images', action: 'tab', args: { tab: 'images' } } },
  ],
};

function setup(over = {}) {
  const dom = new JSDOM(`<!doctype html><body data-app-tab="main">
    <div id="window-titlebar"><span class="wt-name">AutoInjector</span>
      <div id="app-tabs"><button id="tab-app-main">🤖</button><button id="tab-app-akowe">📖</button><button id="tab-app-images">🎨</button><button id="tab-app-video">🎬</button></div>
      <button id="btn-alfred-switch">🎩 Alfred: Off</button><button id="btn-ease-help" type="button">❓ Help</button></div>
    <div id="up-zone-compose">compose</div><div id="send-active-grid">send</div>
    <div id="ai-row"><div id="col-chatgpt">c</div><div id="col-claude">c</div><div id="col-gemini">g</div></div>
    <div id="video-tab" hidden><button id="vd-sub-setup">setup</button><textarea id="vd-prompt"></textarea><button id="btn-vd-generate">go</button><button id="vd-sub-trailer">t</button><button id="vd-sub-selftest">s</button></div>
  </body>`, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/controls.html' });
  const w = dom.window;
  // jsdom has no layout: give every shown element a box, hidden ones none
  w.Element.prototype.getBoundingClientRect = function () {
    if (this.closest('[hidden]') || !this.isConnected) return { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    return { x: 40, y: 60, left: 40, top: 60, width: 200, height: 40, right: 240, bottom: 100 };
  };
  w.Element.prototype.scrollIntoView = function () { this.__scrolled = true; };
  const calls = [];
  let showCb = null;
  const st = { prefs: Object.assign({ ok: true, auto: true, dontShowChecklist: false, checklistShownAt: null, toursSeen: {} }, over.prefs || {}), problems: over.problems || [] };
  w.__EASE_NO_AUTOSTART = true;
  w.eval(SRC);
  const api = {
    syncPanes: () => { calls.push(['syncPanes']); return Promise.resolve({ ok: true }); },
    uiLog: (a, d) => { calls.push(['uiLog', a, d]); return Promise.resolve(); },
    openWizard: async (tab) => { calls.push(['openWizard', tab]); return { ok: true }; },
    ease: {
      prefs: async () => Object.assign({}, st.prefs),
      setPrefs: async (p) => { calls.push(['setPrefs', p]); if (p.tourSeen) st.prefs.toursSeen[p.tourSeen] = true; if (p.resetTours) st.prefs.toursSeen = {}; if (typeof p.dontShowChecklist === 'boolean') st.prefs.dontShowChecklist = p.dontShowChecklist; return Object.assign({ ok: true }, st.prefs); },
      checklist: async () => { calls.push(['checklist']); return over.checklist || CHECKLIST; },
      problems: async () => { calls.push(['problems']); return { ok: true, problems: st.problems }; },
      report: async () => { calls.push(['report']); return { ok: true, file: 'C:\\AI\\stuff and thing\\logs\\support-report-1.txt' }; },
      fix: async (action, args) => { calls.push(['fix', action, args]); return { ok: true }; },
      guide: async () => { calls.push(['guide']); return { ok: true }; },
      onShow: (cb) => { showCb = cb; },
    },
  };
  w.api = api;
  const tabClicks = [];
  for (const id of ['tab-app-main', 'tab-app-akowe', 'tab-app-images', 'tab-app-video']) w.document.getElementById(id).addEventListener('click', () => tabClicks.push(id));
  const ui = w.createEaseUI(api, w.document);
  ui.state.prefs = JSON.parse(JSON.stringify(st.prefs)); // what boot() reads from main (the boot tests call boot() themselves)
  return { dom, w, d: w.document, ui, api, calls, st, tabClicks, show: (what) => showCb && showCb({ what }) };
}

async function main() {
  console.log('\n== controls.html carries the button and the script ==');
  assert(/<button id="btn-ease-help"[^>]*>❓ Help<\/button>/.test(HTML) && /<script src="ease-ui\.js"><\/script>/.test(HTML), 'controls.html: ❓ Help in the title bar + ease-ui.js');
  assert(HTML.indexOf('id="btn-ease-help"') > HTML.indexOf('id="btn-alfred-switch"') && HTML.indexOf('id="btn-ease-help"') < HTML.indexOf('id="btn-collapse-window"'), 'the button sits after the 🎩 switch (the 🎤 stays beside it)');

  console.log('\n== ❓ Help menu ==');
  let t = setup();
  const { d } = t;
  d.getElementById('btn-ease-help').click();
  const menu = d.querySelector('.ease-menu[role="menu"]');
  assert(menu && [...menu.querySelectorAll('button')].map((b) => b.textContent).join(' | ') === "✅ Setup checklist | 🩺 Something's wrong? | 📖 User guide | 🧭 Replay tours", 'four items');
  d.getElementById('ease-m-guide').click();
  await tick();
  assert(t.calls.some((c) => c[0] === 'guide') && !d.querySelector('.ease-menu'), '📖 User guide asks main to open the guide window; the menu closes');

  console.log('\n== ✅ checklist ==');
  d.getElementById('btn-ease-help').click();
  d.getElementById('ease-m-checklist').click();
  await tick(40);
  const ov = d.getElementById('ease-checklist');
  assert(ov && ov.getAttribute('role') === 'dialog' && ov.getAttribute('aria-modal') === 'true', 'opens as a dialog (so the AI panes step aside)');
  assert(t.calls.some((c) => c[0] === 'syncPanes'), 'the panes are re-synced when it opens');
  assert([...d.querySelectorAll('.ease-group')].map((g) => g.textContent).join('|') === 'Needed for books|Optional extras', 'two groups');
  const rows = [...d.querySelectorAll('.ease-row')];
  assert(rows.length === 6 && rows.map((r) => r.querySelector('.ease-ic').textContent).join('') === '❌✅⏳❌⚪⚪', `icons: ${rows.map((r) => r.querySelector('.ease-ic').textContent).join('')} (optional not set up = ⚪)`);
  assert(d.getElementById('ease-checklist-sum').textContent === CHECKLIST.summary, 'the summary line');
  assert(t.calls.some((c) => c[0] === 'setPrefs' && c[1].checklistShown), 'it remembers it was shown');
  const dont = d.getElementById('ease-dont-show');
  dont.checked = true; dont.dispatchEvent(new t.w.Event('change'));
  await tick();
  assert(t.st.prefs.dontShowChecklist === true, '"Don\'t show this by itself again" is saved');
  // Fix it: wizard (panel), main action, tab, pane-open
  d.querySelector('.ease-row[data-id="voice"] button').click(); await tick(30);
  assert(t.calls.some((c) => c[0] === 'openWizard' && c[1] === 'advanced'), 'voice: opens the Setup Wizard\'s Installs tab');
  d.querySelector('.ease-row[data-id="akowe"] button').click(); await tick(30);
  assert(t.calls.some((c) => c[0] === 'fix' && c[1] === 'akowe-start'), 'Akọwe: main runs ▶ Start Akọwe');
  assert(/Done\./.test(d.querySelector('.ease-row[data-id="akowe"] .ease-msg').textContent), 'the row says it was done');
  d.querySelector('.ease-row[data-id="pane-gemini"] button').click(); await tick(30);
  assert(t.calls.some((c) => c[0] === 'fix' && c[1] === 'pane-check' && c[2].site === 'gemini'), 'Gemini: Check now asks main for a check-in');
  d.querySelector('.ease-row[data-id="sd"] button').click(); await tick(30);
  assert(t.tabClicks.includes('tab-app-images') && !d.getElementById('ease-checklist'), 'Stable Diffusion: closes the checklist and opens 🎨 Images');
  t.ui.openChecklist(); await tick(30);
  d.querySelector('.ease-row[data-id="pane-chatgpt"] button').click(); await tick(30);
  assert(!d.getElementById('ease-checklist') && t.tabClicks.includes('tab-app-main') && d.getElementById('col-chatgpt').classList.contains('ease-flash') && d.getElementById('col-chatgpt').__scrolled, 'ChatGPT: closes, shows the AI panes and highlights ChatGPT');
  assert(!d.getElementById('ease-toast').hidden && /notices by itself/.test(d.getElementById('ease-toast').textContent), 'and says what to do in a short note');
  t.ui.openChecklist(); await tick(30);
  d.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape' }));
  assert(!d.getElementById('ease-checklist'), 'Esc closes it');
  const syncs = t.calls.filter((c) => c[0] === 'syncPanes').length;
  assert(syncs >= 6, `the panes are re-synced on every open and close (${syncs})`);

  console.log("\n== 🩺 Something's wrong? ==");
  t = setup({ problems: [
    { id: 'run', severity: 'urgent', text: 'Your book run is paused: “Mara” is paused.', fix: { label: 'Open 📖 Akọwe', action: 'tab', args: { tab: 'akowe' } } },
    { id: 'log-pictures', severity: 'warn', text: '🎨 Pictures: 5 errors in the last 24 hours (codes: sd-runner-error).', fix: null },
  ] });
  t.show('problems'); await tick(40);
  const prow = [...t.d.querySelectorAll('#ease-problems .ease-row')];
  assert(prow.length === 2 && /Needs you now/.test(prow[0].textContent) && /Worth a look/.test(prow[1].textContent) && prow[0].querySelector('button') && !prow[1].querySelector('button'), 'main\'s Help menu event opens it: two problems, the first with its fix button');
  assert(t.d.getElementById('ease-problems-sum').textContent === '2 things found', 'the count');
  t.d.getElementById('ease-report').click(); await tick(30);
  assert(t.calls.some((c) => c[0] === 'report') && /✔ Saved: .*support-report-1\.txt/.test(t.d.getElementById('ease-report-msg').textContent), 'Make a report for support: saved, with its path');
  prow[0].querySelector('button').click(); await tick(20);
  assert(t.tabClicks.includes('tab-app-akowe') && !t.d.getElementById('ease-problems'), 'the fix opens 📖 Akọwe');
  t.st.problems = [];
  t.ui.openProblems(); await tick(40);
  assert(t.d.getElementById('ease-nothing') && /Nothing looks wrong/.test(t.d.getElementById('ease-nothing').textContent), 'nothing wrong → it says so');
  t.ui.closeOverlay();

  console.log('\n== 🧭 tours ==');
  assert(t.ui.startTour('main'), 'the main tour starts');
  const tour = t.d.getElementById('ease-tour');
  assert(tour && tour.getAttribute('role') === 'dialog' && tour.dataset.tour === 'main', 'as a dialog');
  const texts = [];
  for (let i = 0; i < 8; i++) {
    texts.push(t.d.getElementById('ease-tip-text').textContent);
    const hole = t.d.querySelector('#ease-tour .ease-hole');
    if (i === 0) assert(hole.style.width === '208px' && t.d.querySelector('.ease-tip-n').textContent === 'AutoInjector · 1 of 5', 'a highlight around the target and "1 of 5"');
    if (t.d.getElementById('ease-tour-done')) { t.d.getElementById('ease-tour-done').click(); break; }
    assert(t.d.getElementById('ease-tour-skip'), `step ${i + 1}: Skip and Next`);
    t.d.getElementById('ease-tour-next').click();
  }
  assert(texts.length === 5 && /Compose|Type your message/.test(texts[0]) && /❓ Help/.test(texts[4]), `5 steps, one sentence each (${texts.length})`);
  assert(!t.d.getElementById('ease-tour') && t.calls.some((c) => c[0] === 'setPrefs' && c[1].tourSeen === 'main'), 'Done closes it and saves "seen"');
  assert(!t.ui.maybeTour('main'), 'it does not come back after Done');
  // a tab's first opening → its tour (hidden targets left out)
  t.d.getElementById('video-tab').hidden = false;
  t.d.body.dataset.appTab = 'video';
  await tick(900);
  assert(t.d.getElementById('ease-tour') && t.d.getElementById('ease-tour').dataset.tour === 'video', 'opening 🎬 Video the first time starts its tour');
  t.d.getElementById('ease-tour-skip').click();
  assert(!t.d.getElementById('ease-tour') && t.st.prefs.toursSeen.video, 'Skip also counts as seen');
  t.d.body.dataset.appTab = 'main'; await tick(50); t.d.body.dataset.appTab = 'video'; await tick(900);
  assert(!t.d.getElementById('ease-tour'), 'and it is not shown again');
  t.d.body.dataset.appTab = 'main'; await tick(800);
  // Replay tours
  t.show('tours'); await tick(40);
  assert(t.calls.some((c) => c[0] === 'setPrefs' && c[1].resetTours) && t.d.getElementById('ease-tour') && t.d.getElementById('ease-tour').dataset.tour === 'main', 'Replay tours resets them and plays this page\'s tour');
  t.d.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape' }));
  assert(!t.d.getElementById('ease-tour'), 'Esc closes a tour');
  assert(!t.ui.startTour('alfred'), 'a tour with nothing on the screen does not start');

  console.log('\n== the first start: the checklist, then the main tour ==');
  t = setup();
  await t.ui.boot(10);
  await tick(80);
  assert(t.d.getElementById('ease-checklist') && !t.d.getElementById('ease-tour'), 'the checklist opens by itself (main said autoOpen) — the tour waits');
  t.d.getElementById('ease-checklist-close').click();
  await tick(500);
  assert(t.d.getElementById('ease-tour') && t.d.getElementById('ease-tour').dataset.tour === 'main', 'closing it starts the main tour');
  t = setup({ checklist: Object.assign({}, CHECKLIST, { autoOpen: false }) });
  await t.ui.boot(10); await tick(80);
  assert(!t.d.getElementById('ease-checklist') && t.d.getElementById('ease-tour'), 'no checklist needed → straight to the main tour');
  t = setup({ prefs: { auto: false } });
  await t.ui.boot(10); await tick(80);
  assert(!t.d.getElementById('ease-checklist') && !t.d.getElementById('ease-tour') && !t.calls.some((c) => c[0] === 'checklist'), 'auto off (automation) → nothing opens by itself');
  t.d.body.dataset.appTab = 'video'; t.d.getElementById('video-tab').hidden = false; await tick(900);
  assert(!t.d.getElementById('ease-tour'), '…and no tour on a tab either');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
