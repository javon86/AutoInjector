// test/llm-setup-ui.test.js — the 🎩 Alfred's AI box in the 🤵 Butler section (llm-setup-ui.js) in jsdom with a
// stub window.api.llm*: the containers + script tags in controls.html, the one button (with 🔓), progress + steps
// from "llm" events, the check rows (✔ / ⚠ / ✖) and their Fix buttons, Start/Stop, the models list (Use / Remove),
// Cancel, and that it degrades when the API is missing. Run: node test/llm-setup-ui.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'llm-setup-ui.js'), 'utf8');

function makeApi(over = {}) {
  const calls = [];
  let listener = null;
  let status = { ok: true, ollama: { installed: true, version: '0.5.7' }, server: { running: true, base: 'http://127.0.0.1:11435', which: 'app' }, models: [{ name: 'qwen2.5:7b', sizeBytes: 4.7 * 1024 ** 3, sizeText: '4.7 GB', params: '7.6B', fit: { rating: 'great', label: '★★★ Great fit', reason: 'plenty of room' } }, { name: 'dolphin3:8b', sizeBytes: 4.9 * 1024 ** 3, sizeText: '4.9 GB', uncensored: true, fit: { rating: 'good', label: '★★ Good fit', reason: 'fits' } }], alfred: { model: 'qwen2.5:7b' }, hardware: 'Your PC: RTX 3060 12 GB · 32 GB RAM', busy: null };
  const checkResult = { ok: false, summary: '1 thing needs attention: it can use alfred\'s tools.', hardware: 'Your PC: RTX 3060 12 GB · 32 GB RAM', rows: [
    { id: 'installed', label: 'Ollama installed', ok: true, detail: 'Ollama 0.5.7', fix: null },
    { id: 'tools', label: 'It can use Alfred\'s tools', ok: false, detail: 'It did not call the test tool.', fix: { action: 'download-recommended', label: '⬇ Download qwen2.5:7b' } },
    { id: 'gpu', label: 'Graphics card found', ok: null, detail: 'No graphics card', fix: null },
  ] };
  const api = {
    llmStatus: async () => { calls.push(['status']); return status; },
    llmCheck: async (o) => { calls.push(['check', o]); return checkResult; },
    llmFix: async (f) => { calls.push(['fix', f]); return { ok: true, message: '✓ Fixed.' }; },
    llmSetupAll: async (o) => {
      calls.push(['setupAll', o]);
      listener({ type: 'step', task: 'setup', step: 'hardware', label: 'Look at this PC', state: 'done', message: 'Your PC: RTX 3060' });
      listener({ type: 'progress', task: 'pull', percent: 42, message: 'qwen2.5:7b: downloading — 42%' });
      await tick(30);
      if (over.setupFail) return { ok: false, error: 'I couldn\'t install Ollama: no internet.', fix: { action: 'install', label: '⬇ Try installing Ollama again' }, steps: [] };
      return { ok: true, model: 'qwen2.5:7b', summary: '✓ Alfred\'s AI is ready: qwen2.5:7b.', check: Object.assign({}, checkResult, { ok: true, rows: checkResult.rows.slice(0, 1), summary: '✓ All set' }) };
    },
    llmStart: async () => { calls.push(['start']); return { ok: true, message: 'Ollama is running.' }; },
    llmStartAlfred: async () => { calls.push(['startAlfred']); listener({ type: 'step', task: 'start-alfred', message: 'Loading qwen3:14b into memory…' }); await tick(20); if (over.noModels) return { ok: false, needSetup: true, error: 'No models are downloaded on this PC yet. Press ⚡ Set up once.', fix: { action: 'setup', label: '⚡ Set up (once)' } }; return { ok: true, model: 'qwen3:14b', message: '✓ Alfred is ready with qwen3:14b.' }; },
    alfredStatus: async () => ({ settings: { autoStart: !!over.autoStart } }),
    llmScan: async () => { calls.push(['scan']); return { ok: true, summary: 'Ollama 0.5.7 is installed · 1 model ready in Ollama · 1 other model folder with models · 1 model file (.gguf) Ollama can take in.', ollama: { installed: true, version: '0.5.7', bin: '/usr/bin/ollama' }, alfredModel: 'qwen3:14b', servers: [{ base: 'http://127.0.0.1:11435', which: 'app', where: "AutoInjector's own Ollama", models: [{ name: 'qwen3:14b', sizeBytes: 9e9 }, { name: 'mistral-nemo:12b', sizeBytes: 7e9 }] }], stores: [{ dir: '/home/me/.ollama/models', label: "Ollama's usual folder", hasModels: true, inUse: false }], ggufs: [{ path: '/home/me/.lmstudio/models/x/Nemo-Q4.gguf', file: 'Nemo-Q4.gguf', sizeBytes: 7e9, from: 'LM Studio', suggestedName: 'nemo-q4' }] }; },
    llmUseStore: async (dir) => { calls.push(['useStore', dir]); return { ok: true, message: '✓ now uses that folder (nothing downloaded).' }; },
    llmImportGguf: async (file, name) => { calls.push(['import', file, name]); return { ok: true, message: '✓ nemo-q4 is now in Ollama.' }; },
    alfredSettings: async (p) => { calls.push(['alfredSettings', p]); return { ok: true }; },
    llmStop: async () => { calls.push(['stop']); status = Object.assign({}, status, { server: { running: false } }); return { ok: true, stopped: true, message: 'Stopped AutoInjector\'s Ollama.' }; },
    llmUse: async (a) => { calls.push(['use', a]); return { ok: true, message: `Alfred now uses ${a.name}.` }; },
    llmRemove: async (n) => { calls.push(['remove', n]); return { ok: true, message: `Removed ${n}.` }; },
    llmCancel: async () => { calls.push(['cancel']); return { ok: true, cancelled: true }; },
    onLlm: (cb) => { listener = cb; },
  };
  return { api, calls, emit: (e) => listener && listener(e), setStatus: (s) => { status = s; } };
}
function load(api, opts = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="butler-controls"><div id="llm-zone"><div id="llm-setup"></div><div id="llm-models"></div></div></div></body>', { runScripts: 'outside-only', url: 'http://localhost/controls.html' });
  const w = dom.window;
  w.api = api;
  w.confirm = () => (opts.confirm !== undefined ? opts.confirm : true);
  w.eval(SRC);
  return w;
}

(async () => {
  console.log('\n== controls.html: the containers sit at the top of the Butler controls, with the three scripts ==');
  const html = fs.readFileSync(path.join(__dirname, '..', 'controls.html'), 'utf8');
  const dom = new JSDOM(html);
  const d = dom.window.document;
  const bc = d.getElementById('butler-controls');
  assert(bc && bc.firstElementChild && bc.firstElementChild.id === 'llm-zone', '#llm-zone is the first thing in #butler-controls');
  assert(['llm-setup', 'llm-models'].every((id) => d.getElementById(id) && d.getElementById(id).parentElement.id === 'llm-zone'), '#llm-setup, then #llm-models');
  const order = [...d.getElementById('llm-zone').children].map((e) => e.id || e.className).join(',');
  assert(order === 'llm-setup,llm-models,llm-pair', `in that order, then the pair row (${order})`);
  const pair = [...d.querySelector('#llm-zone .llm-pair').children].map((e) => e.id || e.className).join(',');
  const right = [...d.querySelector('#llm-zone .llm-right').children].map((e) => e.id).join(',');
  assert(pair === 'alfred-persona,llm-right' && right === 'butler-more,butler-chat', `personality (half) beside ⚙ More settings + the activity log (${pair} | ${right})`);
  const legacy = d.getElementById('butler-legacy');
  assert(legacy && legacy.hidden && legacy.contains(d.getElementById('jarvis-goal')) && legacy.contains(d.getElementById('lsi-model')) && legacy.contains(d.getElementById('col-device')), 'the old Butler controls are out of sight (still wired)');
  const scripts = [...d.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'));
  assert(['llm-setup-ui.js', 'llm-models-ui.js', 'alfred-persona-ui.js'].every((s) => scripts.includes(s)) && scripts.indexOf('llm-setup-ui.js') > scripts.indexOf('controls.js'), 'the three <script> tags, after controls.js');
  assert(scripts.includes('llm-hardware.js') && scripts.indexOf('llm-hardware.js') < scripts.indexOf('llm-models-ui.js'), 'llm-hardware.js loads before llm-models-ui.js');
  assert(['lsi-endpoint', 'lsi-model', 'btn-lsi-save', 'col-device', 'jarvis-goal', 'col-systemai'].every((id) => d.getElementById(id)), 'every existing Butler id still there');

  console.log('\n== renders: the one button, 🔓, check, start/stop, current model, models on this PC ==');
  let s = makeApi();
  let w = load(s.api);
  await tick(40);
  const $ = (id) => w.document.getElementById(id);
  assert($('llm-btn-go') && /Start Alfred/.test($('llm-btn-go').textContent) && $('llm-btn-go').classList.contains('primary'), '▶ Start Alfred is the main button');
  assert($('llm-btn-setup') && /Set up \(first time\)/.test($('llm-btn-setup').textContent), '⚡ Set up (first time) beside it');
  assert($('llm-autostart') && $('llm-autostart').type === 'checkbox', '"Start him when the app opens" box');
  assert($('llm-btn-check') && /Check everything/.test($('llm-btn-check').textContent), '🩺 Check everything');
  assert($('llm-uncensored') && $('llm-uncensored').type === 'checkbox', '🔓 Prefer uncensored');
  assert(/qwen2\.5:7b/.test($('llm-current').textContent) && /0\.5\.7 running/.test($('llm-current').textContent), `current model + Ollama state (${$('llm-current').textContent})`);
  assert($('llm-btn-start').hidden && !$('llm-btn-stop').hidden, 'running → shows Stop, hides Start');
  assert(/RTX 3060/.test($('llm-hw').textContent), 'the hardware line');
  const rows = w.document.querySelectorAll('#llm-installed .llm-model');
  assert(rows.length === 2 && /★★★ Great fit/.test(rows[0].textContent) && /4\.7 GB/.test(rows[0].textContent), 'installed models with size + fit');
  assert(/in use/.test(rows[0].textContent) && !rows[0].querySelector('.llm-use') && rows[1].querySelector('.llm-use') && /🔓/.test(rows[1].textContent), 'the current one says "in use"; others have Use; uncensored ones a 🔓');

  console.log('\n== ▶ Start Alfred: what is already downloaded, no download ==');
  $('llm-btn-go').click();
  await tick(5);
  assert($('llm-btn-go').disabled && /Loading qwen3:14b/.test($('llm-msg').textContent), 'busy while it starts; says what it is doing');
  await tick(60);
  assert(s.calls.some((c) => c[0] === 'startAlfred') && !s.calls.some((c) => c[0] === 'setupAll') && /ready with qwen3:14b/.test($('llm-msg').textContent) && !$('llm-btn-go').disabled, 'calls llmStartAlfred (never setupAll) and shows "ready"');
  $('llm-autostart').checked = true; $('llm-autostart').dispatchEvent(new w.Event('change')); await tick(5);
  assert(s.calls.some((c) => c[0] === 'alfredSettings' && c[1].autoStart === true) && /start by himself/.test($('llm-msg').textContent), 'ticking "Start him when the app opens" saves autoStart');

  console.log('\n== 🔍 Find what\'s installed: lists it, each with a button to use it ==');
  $('llm-btn-scan').click(); await tick(30);
  const scanBox = $('llm-scan');
  assert(!scanBox.hidden && /Already on this PC/.test(scanBox.textContent) && /1 model file/.test(scanBox.textContent), 'shows what it found');
  const rowsS = scanBox.querySelectorAll('[data-scan-model]');
  assert(rowsS.length === 2 && /in use/.test(rowsS[0].textContent) && rowsS[1].querySelector('.llm-use'), 'models: the one in use, a Use button on the other');
  scanBox.querySelector('[data-scan-store] button').click(); await tick(30);
  assert(s.calls.some((c) => c[0] === 'useStore' && c[1] === '/home/me/.ollama/models'), '"Use this folder" → llmUseStore(dir)');
  scanBox.querySelector('[data-scan-gguf] button') && scanBox.querySelector('[data-scan-gguf] button').click(); await tick(30);
  assert(s.calls.some((c) => c[0] === 'import' && /Nemo-Q4\.gguf$/.test(c[1]) && c[2] === 'nemo-q4'), '"➕ Add to Ollama" → llmImportGguf(file, name)');

  console.log('\n== the one button: sends 🔓, shows steps + progress, then the rows and the summary ==');
  $('llm-uncensored').checked = true; $('llm-uncensored').dispatchEvent(new w.Event('change'));
  $('llm-btn-setup').click();
  await tick(10);
  assert($('llm-btn-setup').disabled && !$('llm-btn-cancel').hidden, 'busy: buttons disabled, Cancel shown');
  assert(/42%/.test($('llm-progress-text').textContent) && $('llm-progress-fill').style.width === '42%' && !$('llm-progress').hidden, 'progress bar follows the "llm" events');
  assert(/Look at this PC/.test($('llm-steps').textContent), 'step list');
  await tick(80);
  const setupCall = s.calls.find((c) => c[0] === 'setupAll');
  assert(setupCall && setupCall[1].uncensored === true, 'setupAll({uncensored:true})');
  assert(/ready: qwen2\.5:7b/.test($('llm-msg').textContent) && !$('llm-btn-setup').disabled && $('llm-btn-cancel').hidden, 'done: summary shown, buttons back');
  assert(w.document.querySelectorAll('.llm-row').length === 1, 'the check rows from the result');

  console.log('\n== 🩺 check: ✔ / ✖ / ⚠ rows; Fix runs the fix, then re-checks ==');
  $('llm-btn-check').click();
  await tick(40);
  const r = [...w.document.querySelectorAll('.llm-row')];
  assert(r.length === 3 && /✔/.test(r[0].textContent) && /✖/.test(r[1].textContent) && /⚠/.test(r[2].textContent), '✔ / ✖ / ⚠ icons');
  const fixBtn = r[1].querySelector('.llm-fix');
  assert(fixBtn && /Download qwen2\.5:7b/.test(fixBtn.textContent) && !r[0].querySelector('.llm-fix'), 'a Fix button only on rows that have one');
  assert(/needs attention/.test($('llm-msg').textContent), 'the summary');
  const before = s.calls.filter((c) => c[0] === 'check').length;
  fixBtn.click();
  await tick(60);
  const fixCall = s.calls.find((c) => c[0] === 'fix');
  assert(fixCall && fixCall[1].action === 'download-recommended', 'Fix → llmFix({action})');
  assert(s.calls.filter((c) => c[0] === 'check').length === before + 1, 'and checks again');

  console.log('\n== Use / Remove / Stop / Cancel ==');
  w.document.querySelectorAll('#llm-installed .llm-model')[1].querySelector('.llm-use').click();
  await tick(30);
  assert(s.calls.some((c) => c[0] === 'use' && c[1].name === 'dolphin3:8b') && /dolphin3:8b/.test($('llm-msg').textContent), 'Use → llmUse({name})');
  w.document.querySelectorAll('#llm-installed .llm-model')[1].querySelector('.llm-remove').click();
  await tick(30);
  assert(s.calls.some((c) => c[0] === 'remove' && c[1] === 'dolphin3:8b'), 'Remove (after confirming) → llmRemove(name)');
  const s2 = makeApi();
  const w2 = load(s2.api, { confirm: false });
  await tick(40);
  w2.document.querySelector('.llm-remove').click();
  await tick(20);
  assert(!s2.calls.some((c) => c[0] === 'remove'), 'Remove asks first — "No" removes nothing');
  $('llm-btn-stop').click();
  await tick(40);
  assert(s.calls.some((c) => c[0] === 'stop') && !$('llm-btn-start').hidden, 'Stop → llmStop, then Start comes back');
  $('llm-btn-cancel').click();
  await tick(10);
  assert(s.calls.some((c) => c[0] === 'cancel'), 'Cancel → llmCancel');
  s.emit({ type: 'log', level: 'warn', message: 'retrying (2 of 3)…' });
  assert(/retrying/.test($('llm-log').textContent), 'log lines from the "llm" events');

  console.log('\n== a failing setup shows the plain message + its fix button ==');
  s = makeApi({ setupFail: true });
  w = load(s.api);
  await tick(30);
  w.document.getElementById('llm-btn-setup').click();
  await tick(80);
  const m = w.document.getElementById('llm-msg');
  assert(/no internet/.test(m.textContent) && m.querySelector('.llm-fix') && /Try installing/.test(m.querySelector('.llm-fix').textContent), 'error + "Try installing Ollama again"');

  console.log('\n== degrades: no window.api.llm* (an older build) ==');
  const w3 = load({});
  await tick(10);
  assert(/isn't available in this build/.test(w3.document.getElementById('llm-setup').textContent) && !w3.document.getElementById('llm-btn-setup'), 'a plain note instead of dead buttons');
  const w4 = load({ llmStatus: async () => { throw new Error('boom'); } });
  await tick(20);
  assert(w4.document.getElementById('llm-btn-setup') && /unavailable|wrong/i.test(w4.document.getElementById('llm-current').textContent), 'a failing status call doesn\'t break the page');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
