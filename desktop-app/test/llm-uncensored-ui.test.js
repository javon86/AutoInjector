'use strict';
// test/llm-uncensored-ui.test.js — the 🔓 Uncensored filter of "🔎 Find a model" (llm-models-ui.js) and the 🧪
// "What will it write?" table (llm-write-test-ui.js, on the finder's cards and in 📦 Models on this PC of
// llm-setup-ui.js), in jsdom. window.api is backed by the REAL model-catalog (fake Ollama library page + fake
// Hugging Face API) and the REAL llm-write-test (fake model answers), on a 16 GB RTX 5070 Ti:
// the chip → only uncensored cards + the plain-words note; each card: name, B params, quant & GB, ★ fit, speed,
// source, downloads/likes, the "Uncensored: …" line, the 🛠 / ⚠ tool hint; ⬇ Download (hf.co/…:QUANT with its
// size), too big = disabled; offline → plain message + the built-in list; models on this PC get 🧪, whose
// table shows ✅ / ⚠ / ✖ per probe with a one-line excerpt, the time and the verdict.
// Run: node test/llm-uncensored-ui.test.js
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const mc = require('../model-catalog');
const wtLib = require('../llm-write-test');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await tick(10); } return null; }
const FIX = path.join(__dirname, 'fixtures', 'llm');
const fx = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const TREES = JSON.parse(fx('hf-uncensored-trees.json'));
const SRC = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const SRC_HW = SRC('llm-hardware.js'), SRC_WT = SRC('llm-write-test-ui.js'), SRC_UI = SRC('llm-models-ui.js'), SRC_SETUP = SRC('llm-setup-ui.js');
const HW16 = { ok: true, gpus: [{ name: 'NVIDIA GeForce RTX 5070 Ti', vendor: 'nvidia', vramMB: 16303 }], bestVramMB: 16303, ramMB: 65536, freeRamMB: 40000, cpu: 'Ryzen 7', cores: 8, platform: 'win32', appleSilicon: false, notes: [] };
const GB = 1e9;

function res(status, body) { return { ok: status < 300, status, json: async () => JSON.parse(body), text: async () => body }; }
function makeApi({ offline = false, installed = ['dolphin3:8b'], answers = null } = {}) {
  const calls = [];
  const listeners = [];
  const cat = mc.createCatalog({
    fetch: async (url) => {
      if (offline) { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; }
      if (/ollama\.com\/search/.test(url)) return res(200, fx('ollama-search-uncensored.html'));
      if (/api\/models\?/.test(url)) return res(200, fx('hf-search-uncensored.json'));
      const m = /api\/models\/([^?]+)\?blobs=true/.exec(url);
      if (m && TREES[decodeURIComponent(m[1])]) return res(200, JSON.stringify(TREES[decodeURIComponent(m[1])]));
      return res(404, '{}');
    },
  });
  let store = null; const logs = [];
  const wt = wtLib.createWriteTest({
    getBase: async () => 'http://127.0.0.1:1',
    chat: async (_b, model, messages) => {
      await tick(5);
      const u = messages[1].content;
      const a = answers ? answers(u, model) : 'Blood ran hot from the wound and he screamed. "Fuck you, you bastard," she spat. I will make you suffer and watch everyone you love burn. Grief for her brother was a dark, numb weight. Her lips met his in a kiss. The corrupt banker deserved to lose the stolen money.';
      return { ok: true, text: a };
    },
    emit: (e) => listeners.forEach((l) => l(e)),
    log: (k, d) => logs.push([k, d]),
    store: { read: () => store, write: (o) => { store = o; } },
  });
  const api = {
    llmHardware: async () => HW16,
    llmCurated: async (opts) => { calls.push(['curated', opts]); return cat.curated(HW16, opts); },
    llmSearch: async (q, opts) => { calls.push(['search', q, opts]); return cat.search(q, Object.assign({}, opts, { hardware: HW16 })); },
    llmUncensored: async (opts) => { calls.push(['uncensored', opts]); const r = await cat.findUncensored(Object.assign({}, opts, { hardware: HW16 })); return Object.assign({}, r, { installed }); },
    llmHfFiles: async (repo) => cat.hfFiles(repo, { hardware: HW16 }),
    llmPull: async (name, opts) => { calls.push(['pull', name, opts]); await tick(10); return { ok: true, model: name }; },
    llmWriteTest: async (a) => { calls.push(['writeTest', a]); return wt.run(a.name); },
    llmWriteTests: async (a) => ({ ok: true, result: wt.cached(a.name) }),
    onLlm: (cb) => { listeners.push(cb); },
  };
  return { api, calls, logs };
}
async function boot(api, { setup = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="llm-setup"></div><div id="llm-models"></div></body></html>', { runScripts: 'outside-only', url: 'http://localhost/controls.html' });
  const w = dom.window;
  w.api = api;
  w.eval(SRC_WT);
  if (setup) w.eval(SRC_SETUP);
  w.eval(SRC_HW);
  w.eval(SRC_UI);
  await w.llmModelsUI.ready;
  await tick();
  return w;
}
const cards = (w) => [...w.document.querySelectorAll('#llm-models .llmm-card')];
const cardBy = (w, id) => cards(w).find((c) => c.dataset.id === id);
const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const txt = (el, sel) => { const e = el && el.querySelector(sel); return e ? e.textContent.trim() : ''; };

async function main() {
  console.log('\n== the 🔓 Uncensored chip: only uncensored models, from both sources ==');
  let { api, calls, logs } = makeApi();
  let w = await boot(api);
  let d = w.document;
  assert(d.getElementById('llmm-unc-note').hidden, 'the note is hidden while the filter is off');
  click(w, d.getElementById('llmm-unc'));
  await until(() => calls.some((c) => c[0] === 'uncensored') && /^🔓 \d+ uncensored model/.test(d.getElementById('llmm-msg').textContent), 4000);
  assert(d.getElementById('llmm-unc').getAttribute('aria-pressed') === 'true', 'the chip is on');
  assert(calls.filter((c) => c[0] === 'uncensored').length === 1 && JSON.stringify(calls.find((c) => c[0] === 'uncensored')[1].sources) === '["ollama","hf"]', 'asks the uncensored finder, both sources');
  const note = d.getElementById('llmm-unc-note');
  assert(!note.hidden && /won't refuse/.test(note.textContent) && /not smarter/.test(note.textContent) && /quality varies/.test(note.textContent) && /responsible for what you publish/.test(note.textContent), 'the plain-words note: won\'t refuse fiction, not smarter, quality varies, you\'re responsible');
  assert(/^🔓 8 uncensored models, rated for this PC\.$/.test(d.getElementById('llmm-msg').textContent), `message: "${d.getElementById('llmm-msg').textContent}"`);
  assert(cards(w).length === 8 && cards(w).every((c) => c.dataset.uncensored === '1'), `${cards(w).length} cards, all uncensored`);
  assert(!cardBy(w, 'ollama:llama3.1') && !cardBy(w, 'hf:plainco/Plain-7B-Instruct-GGUF'), 'plain models are not listed');

  console.log('\n== a Hugging Face card ==');
  const q = cardBy(w, 'hf:bartowski/Qwen2.5-14B-Instruct-abliterated-GGUF');
  assert(!!q, 'Qwen2.5-14B-Instruct-abliterated-GGUF is listed');
  assert(txt(q, '.llmm-title') === 'Qwen2.5-14B-Instruct-abliterated-GGUF' && txt(q, '[data-badge="source"]') === 'Hugging Face', 'name + source "Hugging Face"');
  assert(/^14\.8B parameters · Q4_K_M · 8\.4 GB$/.test(txt(q, '.llmm-spec')), `size, quant and GB: "${txt(q, '.llmm-spec')}"`);
  assert(txt(q, '.llmm-fit') === '★★★ Excellent fit' && /⬇ 61\.0K · ♥ 95/.test(txt(q, '.llmm-size')), `★★★ + downloads/likes ("${txt(q, '.llmm-size')}")`);
  assert(/words\/s/.test(txt(q, '.llmm-speed')) && /estimate/.test(txt(q, '.llmm-speed')), `speed estimate ("${txt(q, '.llmm-speed').slice(0, 60)}…")`);
  assert(txt(q, '.llmm-unc-line') === 'Uncensored: refusals removed (abliterated) — knowledge and skill same as the base model', 'the plain "Uncensored: refusals removed (abliterated)…" line');
  assert(txt(q, '.llmm-tool-hint') === '🛠 good for Alfred\'s tools' && q.querySelector('.llmm-tool-hint').dataset.good === '1', '🛠 good for Alfred\'s tools');
  const opts = [...q.querySelectorAll('.llmm-variant option')].map((o) => o.textContent);
  assert(q.querySelector('.llmm-variant').value === 'Q4_K_M' && opts.length === 6 && opts.some((o) => /^Q8_0 — 15 GB — 🐢 Slow/.test(o)), `every quant listed with its fit; Q4_K_M chosen (${opts.map((o) => o.split(' — ').slice(0, 3).join(' ')).join(' | ')})`);
  assert(!q.querySelector('.llmm-files') && !q.querySelector('.llmm-dl').disabled && q.querySelector('.llmm-dl').title === 'Download hf.co/bartowski/Qwen2.5-14B-Instruct-abliterated-GGUF:Q4_K_M', 'exact sizes already known; ⬇ Download hf.co/…:Q4_K_M');
  assert(!q.querySelector('.llmm-wt'), 'not on this PC yet → no 🧪 button');

  console.log('\n== an Ollama card (on this PC) + a ⚠ tool hint ==');
  const dol = cardBy(w, 'ollama:dolphin3');
  assert(txt(dol, '[data-badge="source"]') === 'Ollama' && /^8B parameters · Q4_K_M · ~5\.0 GB · ✔ on this PC$/.test(txt(dol, '.llmm-spec')), `source Ollama; "${txt(dol, '.llmm-spec')}"`);
  assert(dol.dataset.installed === '1' && txt(dol, '.llmm-tool-hint') === '⚠ may not use tools well' && dol.querySelector('.llmm-tool-hint').dataset.good === '0', '✔ on this PC; ⚠ may not use tools well');
  assert(/re-trained to follow instructions without refusing/.test(txt(dol, '.llmm-unc-line')), 'a fine-tune gets its own uncensored line');
  assert(!!dol.querySelector('.llmm-wt') && txt(dol, '.llmm-wt') === '🧪 What will it write?', 'models on this PC get 🧪 What will it write?');
  const gem = cardBy(w, 'hf:mlabonne/gemma-3-12b-it-abliterated-GGUF');
  assert(txt(gem, '.llmm-tool-hint') === '⚠ may not use tools well' && /Q5_K_M/.test(txt(gem, '.llmm-spec')), 'gemma: Q5_K_M, ⚠ tools');

  console.log('\n== too big = no download ==');
  const her = cardBy(w, 'ollama:hermes3');
  her.querySelector('.llmm-variant').value = 'hermes3:405b';
  her.querySelector('.llmm-variant').dispatchEvent(new w.Event('change', { bubbles: true }));
  await tick();
  const her2 = cardBy(w, 'ollama:hermes3');
  assert(her2.dataset.rating === 'too-big' && her2.querySelector('.llmm-dl').disabled && /^Can't download:/.test(her2.querySelector('.llmm-dl').title) && /Too big/.test(txt(her2, '.llmm-why')), 'hermes3:405b → ✖, ⬇ disabled with the reason');

  console.log('\n== ⬇ Download a Hugging Face quant → then 🧪 is offered ==');
  click(w, cardBy(w, 'hf:bartowski/Qwen2.5-14B-Instruct-abliterated-GGUF').querySelector('.llmm-dl'));
  await until(() => /Downloaded/.test(txt(cardBy(w, 'hf:bartowski/Qwen2.5-14B-Instruct-abliterated-GGUF'), '.llmm-dl')));
  const pull = calls.find((c) => c[0] === 'pull');
  assert(pull && pull[1] === 'hf.co/bartowski/Qwen2.5-14B-Instruct-abliterated-GGUF:Q4_K_M' && Math.abs(pull[2].sizeBytes - 8.99 * GB) < 1e6, `llmPull(hf.co/…:Q4_K_M, {sizeBytes ${pull && pull[2].sizeBytes}}) — the existing install flow (disk check in main)`);
  const qd = cardBy(w, 'hf:bartowski/Qwen2.5-14B-Instruct-abliterated-GGUF');
  assert(qd.dataset.installed === '1' && !!qd.querySelector('.llmm-wt') && /What will it write/.test(d.getElementById('llmm-msg').textContent), 'after the download: ✔ on this PC + 🧪 (and the message mentions it)');

  console.log('\n== 🧪 What will it write? on a card ==');
  click(w, cardBy(w, 'ollama:dolphin3').querySelector('.llmm-wt'));
  await tick(2);
  assert(/Testing \d of 6/.test(txt(cardBy(w, 'ollama:dolphin3'), '.llmwt')) && cardBy(w, 'ollama:dolphin3').querySelector('.llmm-wt').disabled, 'shows "Testing n of 6…" and the button waits');
  await until(() => cardBy(w, 'ollama:dolphin3').querySelector('.llmwt[data-state="done"]'), 4000);
  let box = cardBy(w, 'ollama:dolphin3').querySelector('.llmwt');
  let rows = [...box.querySelectorAll('tbody tr')];
  assert(rows.length === 6 && rows.every((r) => r.dataset.score === 'wrote' && /✅ wrote it/.test(r.children[1].textContent)), `six rows, all ✅ wrote it (${rows.map((r) => r.dataset.probe).join(', ')})`);
  assert(rows.every((r) => /^“.+”$/.test(r.children[2].textContent) && /\d(\.\d)? s$/.test(r.children[3].textContent)), 'each with a one-line excerpt and the time');
  assert(/⚔ Battle scene/.test(rows[0].children[0].textContent) && txt(box, '.llmwt-verdict') === '✅ Writes dark fiction freely' && box.dataset.verdict === 'free', `verdict: ${txt(box, '.llmwt-verdict')}`);
  assert(/run on this PC only/.test(box.textContent) && txt(cardBy(w, 'ollama:dolphin3'), '.llmm-wt') === '🧪 Test again', '"run on this PC only"; the button now says Test again');
  assert(calls.filter((c) => c[0] === 'writeTest').length === 1 && calls.find((c) => c[0] === 'writeTest')[1].name === 'dolphin3:8b', 'llmWriteTest({name:"dolphin3:8b"})');
  assert(logs.length === 1 && !/Blood|bastard|kiss/.test(JSON.stringify(logs)), 'the log has the scores only');

  console.log('\n== chip off → back to the recommended list ==');
  click(w, d.getElementById('llmm-unc'));
  await until(() => /Recommended for Alfred/.test(d.getElementById('llmm-msg').textContent));
  assert(d.getElementById('llmm-unc-note').hidden && cards(w).some((c) => c.dataset.uncensored === '0'), 'note hidden, every model again');

  console.log('\n== offline: a plain message and the built-in uncensored list ==');
  ({ api, calls } = makeApi({ offline: true }));
  w = await boot(api); d = w.document;
  click(w, d.getElementById('llmm-unc'));
  await until(() => calls.some((c) => c[0] === 'uncensored') && /works offline/.test(d.getElementById('llmm-msg').textContent), 4000);
  const m = d.getElementById('llmm-msg');
  assert(/Couldn't reach/.test(m.textContent) && /built-in list of uncensored models \(works offline\)/.test(m.textContent) && m.classList.contains('llmm-err') && !/ENOTFOUND|TypeError/.test(m.textContent), `"${m.textContent}"`);
  assert(cards(w).length >= 5 && cards(w).every((c) => c.dataset.uncensored === '1' && c.querySelector('.llmm-unc-line') && c.querySelector('.llmm-tool-hint')), `${cards(w).length} built-in uncensored cards, each with the line + tool hint`);

  console.log('\n== a model that refuses: ✖ / ⚠ in the table ==');
  ({ api, calls } = makeApi({ answers: (u) => (/villain|dockworkers/.test(u) ? 'I\'m sorry, but I can\'t write that.' : /grief/.test(u) ? 'Grief for her brother sat in her like a stone. If you or someone you know is struggling, please reach out to a crisis line.' : 'The blood ran from his wound and he screamed in pain; her lips found his in a kiss; the corrupt banker deserved to be robbed of the money.') }));
  w = await boot(api, { setup: false }); d = w.document;
  click(w, d.getElementById('llmm-unc'));
  await until(() => cardBy(w, 'ollama:dolphin3'), 4000);
  click(w, cardBy(w, 'ollama:dolphin3').querySelector('.llmm-wt'));
  await until(() => cardBy(w, 'ollama:dolphin3').querySelector('.llmwt[data-state="done"]'), 4000);
  box = cardBy(w, 'ollama:dolphin3').querySelector('.llmwt');
  const sc = Object.fromEntries([...box.querySelectorAll('tbody tr')].map((r) => [r.dataset.probe, r.children[1].textContent.trim()]));
  assert(sc.villain === '✖ refused' && sc.profanity === '✖ refused' && sc.grief === '⚠ softened or lectured' && sc.battle === '✅ wrote it', `per probe: ${JSON.stringify(sc)}`);
  assert(txt(box, '.llmwt-verdict') === '✖ Refuses often' && box.dataset.verdict === 'refuses', `verdict: ${txt(box, '.llmwt-verdict')}`);

  console.log('\n== 📦 Models on this PC (Alfred\'s setup box): 🧪 Test per model + the top button ==');
  ({ api, calls } = makeApi());
  api.llmStatus = async () => ({ ok: true, ollama: { installed: true, version: '0.12.0' }, server: { running: true, base: 'http://127.0.0.1:11435', which: 'app' }, models: [{ name: 'dolphin3:8b', sizeBytes: 4.9 * GB, uncensored: true }, { name: 'nomic-embed-text:latest', sizeBytes: 0.3 * GB }], alfred: { model: 'dolphin3:8b' }, hardware: 'Your PC: RTX 5070 Ti 16 GB' });
  w = await boot(api, { setup: true }); d = w.document;
  await until(() => d.querySelector('#llm-installed .llm-model[data-model="dolphin3:8b"]'));
  const row = d.querySelector('#llm-installed .llm-model[data-model="dolphin3:8b"]');
  assert(row && /🧪 Test/.test(row.querySelector('.llm-wt-btn').textContent), 'each model on this PC has a 🧪 Test button');
  assert(!d.querySelector('#llm-installed .llm-model[data-model="nomic-embed-text:latest"] .llm-wt-btn'), '…except embedding models');
  assert(w.llmModelsUI.state.installed.has('dolphin3:8b'), 'the finder learns what is on this PC from the setup box');
  click(w, row.querySelector('.llm-wt-btn'));
  await until(() => d.querySelector('#llm-wt .llmwt[data-state="done"]'), 4000);
  const tb = d.querySelector('#llm-wt .llmwt');
  assert(!d.getElementById('llm-wt').hidden && tb && tb.querySelectorAll('tbody tr').length === 6 && /dolphin3:8b/.test(d.getElementById('llm-wt').textContent), 'the table shows under the check rows, named');
  assert(/🧪 dolphin3:8b: ✅ Writes dark fiction freely/.test(d.getElementById('llm-msg').textContent), `message: "${d.getElementById('llm-msg').textContent}"`);
  click(w, d.getElementById('llm-btn-wt'));
  await until(() => calls.filter((c) => c[0] === 'writeTest').length === 2 && !d.getElementById('llm-btn-wt').disabled, 4000);
  assert(calls.filter((c) => c[0] === 'writeTest')[1][1].name === 'dolphin3:8b', 'the top 🧪 button tests Alfred\'s model');

  console.log('\n== an older main without llmWriteTest ==');
  ({ api } = makeApi());
  delete api.llmWriteTest;
  w = await boot(api); d = w.document;
  click(w, d.getElementById('llmm-unc'));
  await until(() => cardBy(w, 'ollama:dolphin3'), 4000);
  click(w, cardBy(w, 'ollama:dolphin3').querySelector('.llmm-wt'));
  await until(() => cardBy(w, 'ollama:dolphin3').querySelector('.llmwt[data-state="error"]'));
  assert(/isn't available yet/.test(txt(cardBy(w, 'ollama:dolphin3'), '.llmwt')), 'plain message, no crash');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
