// test/llm-models-ui.test.js — the "🔎 Find a model" browser (llm-models-ui.js) in
// jsdom, driven by a stub window.api whose llm* calls are backed by the REAL
// model-catalog + llm-hardware with the offline fixtures: hardware line, curated
// cards with fit ratings, too-big = Download disabled with the reason, 🔓 and 🛠
// filters, source chips, variant picker, Download + progress, Hugging Face
// exact files before download, the token field, errors, and a missing API.
// Run: node test/llm-models-ui.test.js
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const mc = require('../model-catalog');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const FIX = path.join(__dirname, 'fixtures', 'llm');
const fx = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const SRC_HW = fs.readFileSync(path.join(__dirname, '..', 'llm-hardware.js'), 'utf8');
const SRC_UI = fs.readFileSync(path.join(__dirname, '..', 'llm-models-ui.js'), 'utf8');

const HW = { ok: true, gpus: [{ name: 'NVIDIA GeForce RTX 3060', vendor: 'nvidia', vramMB: 12288 }], bestVramMB: 12288, ramMB: 32768, freeRamMB: 20480, cpu: 'Ryzen', cores: 8, platform: 'win32', appleSilicon: false, notes: [] };

function res(status, body) { return { ok: status < 300, status, json: async () => JSON.parse(body), text: async () => body }; }
function makeApi({ offline = false, pullFails = false } = {}) {
  const calls = [];
  let listener = null;
  const cat = mc.createCatalog({
    fetch: async (url) => {
      if (offline) { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; }
      if (/ollama\.com\/search/.test(url)) return res(200, fx('ollama-search.html'));
      if (/api\/models\?/.test(url)) return res(200, fx('hf-search.json'));
      if (/api\/models\/bartowski/.test(url)) return res(200, fx('hf-model-qwen.json'));
      return res(404, '{}');
    },
  });
  const api = {
    llmHardware: async () => { calls.push(['hardware']); return HW; },
    llmCurated: async (opts) => { calls.push(['curated', opts]); return cat.curated(HW, opts); },
    llmSearch: async (q, opts) => { calls.push(['search', q, opts]); return cat.search(q, Object.assign({}, opts, { hardware: HW })); },
    llmHfFiles: async (repo) => { calls.push(['hfFiles', repo]); return cat.hfFiles(repo, { hardware: HW }); },
    llmPull: async (name, opts) => {
      calls.push(['pull', name, opts]);
      await tick(10);
      if (listener) listener({ kind: 'pull', model: name, percent: 42, status: 'downloading', mbps: 25.5 });
      await tick(30);
      return pullFails ? { ok: false, error: 'Not enough disk space: needs 5 GB, 1 GB free.' } : { ok: true, model: name };
    },
    llmSetHfToken: async (t) => { calls.push(['token', t]); return { ok: true, connected: !!t }; },
    onLlm: (cb) => { listener = cb; return () => {}; },
  };
  return { api, calls };
}

async function boot(api, { withHw = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="llm-setup"></div><div id="llm-models"></div></body></html>', { runScripts: 'outside-only', url: 'http://localhost/controls.html' });
  const w = dom.window;
  w.api = api;
  if (withHw) w.eval(SRC_HW);
  w.eval(SRC_UI);
  await w.llmModelsUI.ready;
  await tick();
  return w;
}
const cards = (w) => [...w.document.querySelectorAll('#llm-models .llmm-card')];
const cardBy = (w, name) => cards(w).find((c) => c.dataset.id === name);
const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

async function main() {
  console.log('\n== boot: hardware line + recommended (offline-capable) list ==');
  let { api, calls } = makeApi();
  let w = await boot(api);
  const d = w.document;
  assert(d.querySelector('#llm-models h3').textContent.includes('Find a model'), 'renders "🔎 Find a model" into #llm-models');
  assert(d.getElementById('llmm-hw').textContent === 'Your PC: RTX 3060 12 GB · 32 GB RAM', `hardware line: "${d.getElementById('llmm-hw').textContent}"`);
  assert(calls.some((c) => c[0] === 'curated'), 'loads the recommended list on start');
  assert(cards(w).length >= 10, `${cards(w).length} recommended cards`);
  const q25 = cardBy(w, 'curated:qwen2.5');
  assert(q25 && /★★★ Great fit/.test(q25.querySelector('.llmm-fit').textContent), 'qwen2.5 shows ★★★ Great fit');
  assert(/graphics card has 12 GB/.test(q25.querySelector('.llmm-reason').textContent), 'with a plain-English reason');
  assert(q25.querySelector('.llmm-variant').value === 'qwen2.5:7b', 'the variant picker auto-picks the best that fits (7b)');
  assert(q25.querySelector('[data-badge="tools"]'), '🛠 badge on a tool-capable model');
  const big = cardBy(w, 'curated:llama3.3');
  const bigBtn = big.querySelector('.llmm-dl');
  assert(big.dataset.rating === 'too-big' && bigBtn.disabled, 'too-big model: ⬇ Download is DISABLED');
  assert(/Can't download/.test(bigBtn.title) && /Too big for this PC/.test(big.textContent), 'and says why');
  assert(d.getElementById('llmm-src-ollama').getAttribute('aria-pressed') === 'true' && d.getElementById('llmm-src-hf').getAttribute('aria-pressed') === 'true', 'both sources on by default');

  console.log('\n== 🔓 Uncensored: first-class, ranked first, never hidden ==');
  assert(cards(w).some((c) => c.dataset.uncensored === '1'), 'uncensored models are listed even with the filter off');
  click(w, d.getElementById('llmm-unc'));
  await tick(40);
  assert(d.getElementById('llmm-unc').getAttribute('aria-pressed') === 'true', 'the 🔓 chip toggles on');
  assert(calls.filter((c) => c[0] === 'curated').pop()[1].uncensored === true, 'the recommended list is reloaded with uncensored:true');
  const cs = cards(w);
  assert(cs[0].dataset.uncensored === '1' && cs[0].querySelector('[data-badge="uncensored"]'), 'an uncensored model with the 🔓 badge is first');
  assert(cs.some((c) => c.dataset.uncensored === '0'), 'the others are still shown');
  click(w, d.getElementById('llmm-unc'));
  await tick(40);

  console.log('\n== 🛠 Can use tools filter ==');
  click(w, d.getElementById('llmm-tools'));
  await tick();
  assert(!cardBy(w, 'curated:dolphin3') && cardBy(w, 'curated:qwen2.5'), 'models without known tool use are hidden; tool-capable ones stay');
  click(w, d.getElementById('llmm-tools'));
  await tick();
  assert(cardBy(w, 'curated:dolphin3'), 'turning it off brings them back');

  console.log('\n== variant picker re-rates; a too-big size disables Download ==');
  let q3 = cardBy(w, 'curated:qwen3');
  const sel = q3.querySelector('.llmm-variant');
  assert([...sel.options].some((o) => /Too big/.test(o.textContent)) || [...sel.options].length > 3, 'every size option shows its own fit');
  sel.value = 'qwen3:32b';
  sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  await tick();
  q3 = cardBy(w, 'curated:qwen3');
  assert(q3.querySelector('.llmm-variant').value === 'qwen3:32b', 'the choice sticks');
  assert(/Runs, slowly|Too big/.test(q3.querySelector('.llmm-fit').textContent), `the fit updates for 32b (${q3.querySelector('.llmm-fit').textContent})`);

  console.log('\n== search both sources ==');
  d.getElementById('llmm-q').value = 'qwen';
  click(w, d.getElementById('llmm-go'));
  await tick(60);
  const sc = calls.filter((c) => c[0] === 'search').pop();
  assert(sc && sc[1] === 'qwen' && sc[2].sources.join() === 'ollama,hf', 'llmSearch(query, {sources:[ollama,hf], …})');
  assert(cardBy(w, 'ollama:qwen3') && cardBy(w, 'hf:bartowski/Qwen2.5-7B-Instruct-GGUF'), 'Ollama and Hugging Face results shown');
  const gated = cardBy(w, 'hf:meta-llama/Llama-3.3-70B-Instruct-GGUF');
  assert(gated && gated.querySelector('[data-badge="gated"]'), 'gated HF model has the 🔒 badge');
  assert(/found/.test(d.getElementById('llmm-msg').textContent), `status: "${d.getElementById('llmm-msg').textContent}"`);
  click(w, d.getElementById('llmm-src-hf'));
  click(w, d.getElementById('llmm-go'));
  await tick(60);
  assert(calls.filter((c) => c[0] === 'search').pop()[2].sources.join() === 'ollama', 'turning Hugging Face off searches only the Ollama library');
  click(w, d.getElementById('llmm-src-ollama'));
  click(w, d.getElementById('llmm-go'));
  await tick(20);
  assert(/at least one place/.test(d.getElementById('llmm-msg').textContent), 'no sources → plain message, no call');
  click(w, d.getElementById('llmm-src-ollama')); click(w, d.getElementById('llmm-src-hf'));

  console.log('\n== ⬇ Download (Ollama) with progress ==');
  d.getElementById('llmm-q').value = 'qwen';
  click(w, d.getElementById('llmm-go'));
  await tick(60);
  let card = cardBy(w, 'ollama:qwen3');
  click(w, card.querySelector('.llmm-dl'));
  await tick(20);
  assert(calls.some((c) => c[0] === 'pull' && c[1] === 'qwen3:8b'), 'llmPull("qwen3:8b") — the picked size');
  card = cardBy(w, 'ollama:qwen3');
  assert(/42%/.test(card.querySelector('.llmm-prog').textContent) && /25\.5 MB\/s/.test(card.querySelector('.llmm-prog').textContent), `progress from onLlm: "${card.querySelector('.llmm-prog').textContent}"`);
  assert(card.querySelector('.llmm-dl').disabled, 'button disabled while downloading');
  await tick(60);
  card = cardBy(w, 'ollama:qwen3');
  assert(/Downloaded/.test(card.querySelector('.llmm-dl').textContent) && /✔ Downloaded qwen3:8b/.test(card.textContent), 'done → ✔ Downloaded');

  console.log('\n== ⬇ Download (Hugging Face): exact files first, then the best quant ==');
  card = cardBy(w, 'hf:bartowski/Qwen2.5-7B-Instruct-GGUF');
  assert(card.querySelector('.llmm-files'), 'an HF card offers "📂 Exact sizes"');
  click(w, card.querySelector('.llmm-dl'));
  await tick(120);
  assert(calls.some((c) => c[0] === 'hfFiles' && c[1] === 'bartowski/Qwen2.5-7B-Instruct-GGUF'), 'llmHfFiles(repo) is called before downloading');
  const pulled = calls.filter((c) => c[0] === 'pull').pop();
  assert(pulled[1] === 'hf.co/bartowski/Qwen2.5-7B-Instruct-GGUF:Q6_K', `pulls hf.co/<repo>:<best quant> (${pulled[1]})`);
  card = cardBy(w, 'hf:bartowski/Qwen2.5-7B-Instruct-GGUF');
  assert(card.querySelectorAll('.llmm-variant option').length === 6 && !card.querySelector('.llmm-files'), 'the real quant list replaces the estimate');

  console.log('\n== download failure is shown plainly ==');
  ({ api, calls } = makeApi({ pullFails: true }));
  w = await boot(api);
  click(w, cardBy(w, 'curated:qwen2.5').querySelector('.llmm-dl'));
  await tick(80);
  assert(/Not enough disk space/.test(cardBy(w, 'curated:qwen2.5').textContent), 'the error from main appears on the card');

  console.log('\n== Hugging Face token ==');
  const tokIn = w.document.getElementById('llmm-hf-token');
  click(w, w.document.getElementById('llmm-hf-save'));
  await tick();
  assert(/Paste your Hugging Face token/.test(w.document.getElementById('llmm-hf-msg').textContent) && !calls.some((c) => c[0] === 'token'), 'empty token → asks for it, no call');
  tokIn.value = 'hf_abcSECRET';
  click(w, w.document.getElementById('llmm-hf-save'));
  await tick();
  assert(calls.some((c) => c[0] === 'token' && c[1] === 'hf_abcSECRET'), 'llmSetHfToken(token)');
  assert(tokIn.value === '' && /connected/.test(w.document.getElementById('llmm-hf-msg').textContent) && !w.document.body.innerHTML.includes('SECRET'), 'field cleared, ✔ connected, token not left in the page');
  click(w, w.document.getElementById('llmm-hf-clear'));
  await tick();
  assert(calls.filter((c) => c[0] === 'token').pop()[1] === '', 'Disconnect → llmSetHfToken("")');

  console.log('\n== offline search keeps Recommended working ==');
  ({ api, calls } = makeApi({ offline: true }));
  w = await boot(api);
  assert(cards(w).length >= 10, 'recommended list shows offline');
  w.document.getElementById('llmm-q').value = 'llama';
  click(w, w.document.getElementById('llmm-go'));
  await tick(60);
  const m = w.document.getElementById('llmm-msg').textContent;
  assert(/internet/.test(m) && /Recommended/.test(m), `plain offline message pointing at Recommended: "${m}"`);

  console.log('\n== degrades when the API is missing ==');
  w = await boot({});
  assert(/isn't connected yet/.test(w.document.getElementById('llmm-msg').textContent), 'no window.api.llm* → plain message, no crash');
  assert(/can't check yet/.test(w.document.getElementById('llmm-hw').textContent), 'hardware line says it can\'t check');
  w = await boot({ llmCurated: async () => ({ ok: true, models: mc.createCatalog({ fetch: null }).curated(null, {}) }) }, { withHw: false });
  assert(cards(w).length >= 10, 'only llmCurated (returning {models}) → still lists models');
  assert(cards(w).every((c) => c.dataset.rating === 'unknown'), 'without hardware info every fit is "unknown", Download still allowed');
  click(w, cards(w)[0].querySelector('.llmm-dl'));
  await tick();
  assert(/isn't available yet/.test(w.document.getElementById('llmm-msg').textContent), 'no llmPull → plain message');
  const dom2 = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  dom2.window.api = {};
  let threw = false; try { dom2.window.eval(SRC_UI); } catch (_) { threw = true; }
  assert(!threw && !dom2.window.llmModelsUI, 'no #llm-models container → the script does nothing');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
