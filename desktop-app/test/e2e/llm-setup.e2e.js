'use strict';
// llm-setup.e2e.js — "🎩 Alfred's AI setup" in the 🤵 Butler section, in the REAL Electron app, against a
// fake Ollama (test/fixtures/fake-ollama.js) with one small model installed. No real network: the online
// model search (huggingface.co / ollama.com) must fail with a plain message while the offline ⭐ Recommended
// list still shows. A fake `ollama` program (prints a version) makes the app think Ollama is installed;
// a fake `nvidia-smi` (NVIDIA_SMI) gives this "PC" a 6 GB card so some models are too big.
//   1. 🩺 Check everything: ✔ / ⚠ / ✖ rows; the failing row's Fix button works.
//   2. 🔎 Find a model: the hardware line, fit ratings (stars + words + reason), 🔓 uncensored first,
//      a too-big model's ⬇ Download is disabled with the reason; the online search fails gracefully.
//   3. Download a model that fits (progress shows), it lands in 📦 Models on this PC, "Use" makes it
//      Alfred's model (alfredStatus().settings.local.model).
//   4. 🎩 personality: pick a preset, save, read it back; save a set-up, switch to it.
//   5. ⚡ Set up Alfred's AI (one button) runs to completion (and a second press is harmless).
//   6. Screenshot of the setup box → shots/alfred-ai-setup.png.
//   xvfb-run -a node test/e2e/llm-setup.e2e.js
// Env: SHOTS=<dir> (default: test/e2e/__screenshots__/llm-setup).
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { makeAsserts, APP_DIR } = require('./helpers');
const { fakeOllama } = require('../fixtures/fake-ollama');
const electron = require('playwright')._electron;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.SHOTS || path.join(__dirname, '__screenshots__', 'llm-setup');
const MB = 1024 * 1024;
function freePort() { return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
async function until(fn, ms, every = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(every); }
  return null;
}
/** Keep a feature screenshot in the repo's shots/ folder. */
function keep(name, as) { try { const src = path.join(SHOTS, `${name}.png`); if (fs.existsSync(src)) fs.copyFileSync(src, path.join(APP_DIR, '..', 'shots', as)); } catch (_) {} }
function script(file, body) { fs.writeFileSync(file, `#!/bin/sh\n${body}\n`); fs.chmodSync(file, 0o755); return file; }

async function main() {
  const { assert, state } = makeAsserts();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-e2e-home-'));
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
  // A fake Ollama program: `--version` prints a version; `serve` just exits (the fake HTTP server answers).
  const ollamaBin = script(path.join(bin, 'ollama'), 'if [ "$1" = "--version" ] || [ "$1" = "-v" ]; then echo "ollama version is 0.5.7"; fi\nexit 0');
  const smiBin = script(path.join(bin, 'nvidia-smi'), 'echo "NVIDIA GeForce RTX 3060, 6144"');
  const port = await freePort();
  const oll = fakeOllama(port);
  oll.st.models = [{ name: 'qwen2.5:0.5b', size: 398 * MB }];
  oll.st.pullSize = 64 * MB;
  oll.st.pullDelayMs = 250; // 8 steps → ~2 s, long enough to see the progress
  await oll.up();
  // Alfred's settings, pre-seeded: point him at the fake Ollama, with a model that is NOT installed.
  const userData = path.join(home, '.config', 'autoinjector-desktop');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'alfred-settings.json'), JSON.stringify({ local: { endpoint: `${oll.base}/v1`, model: 'llama3.1:8b' } }));
  const fake = 'file://' + path.join(APP_DIR, 'test', 'fixtures', 'fake-chat.html');
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], cwd: APP_DIR,
    env: Object.assign({}, process.env, {
      // no internet for the model finder, even where the machine has it (CI): a closed local port
      AUTOINJECTOR_OLLAMA_LIBRARY: 'http://127.0.0.1:9', AUTOINJECTOR_HF_BASE: 'http://127.0.0.1:9',
      HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), PATH: `${bin}:${process.env.PATH || ''}`,
      OLLAMA_BIN: ollamaBin, NVIDIA_SMI: smiBin, AUTOINJECTOR_OLLAMA_HOST: `127.0.0.1:${port}`,
      AUTOINJECTOR_AKOWE_SERVER: '0', AUTOINJECTOR_CHECKIN: '0', AUTOINJECTOR_BRIDGE: '0',
      AUTOINJECTOR_SD_AUTOSTART: '0', AUTOINJECTOR_SD_HOME: path.join(home, 'sdhome'), AUTOINJECTOR_SD_MODEL_DIRS: path.join(home, 'models'),
      AUTOINJECTOR_SITE_URL_CHATGPT: fake, AUTOINJECTOR_SITE_URL_CLAUDE: fake, AUTOINJECTOR_SITE_URL_GEMINI: fake,
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    }),
  });
  try {
    const controls = await until(async () => { for (const w of app.windows()) { if (await w.$('#llm-setup').catch(() => null)) return w; } return null; }, 40000, 400);
    assert(!!controls, 'the control panel appears with the 🎩 AI setup box');
    if (!controls) return 1;
    await controls.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
    const ud = await app.evaluate(({ app: a }) => a.getPath('userData'));
    assert(ud === userData, `the app uses the test's userData (${ud})`);
    const st0 = await controls.evaluate(() => window.api.alfredStatus());
    assert(st0 && st0.settings && st0.settings.local.endpoint === `${oll.base}/v1`, `Alfred is pointed at the fake Ollama (${st0 && st0.settings && st0.settings.local.endpoint})`);

    console.log('\n== the Butler section shows the setup box ==');
    if (!(await controls.isVisible('#llm-setup'))) { await controls.click('#btn-collapse-systemai').catch(() => {}); await sleep(300); }
    await controls.locator('#llm-setup').scrollIntoViewIfNeeded();
    assert(await controls.isVisible('#llm-btn-setup'), 'the "⚡ Set up Alfred\'s AI" button is visible');
    const cur = await until(async () => { const t = await controls.textContent('#llm-current'); return /running/.test(t) ? t : null; }, 20000);
    assert(!!cur, `the current line says Ollama is running (${cur || await controls.textContent('#llm-current')})`);

    console.log('\n== 🩺 Check everything ==');
    await controls.click('#llm-btn-check');
    const rowsOk = await until(async () => (await controls.$$('#llm-check-rows li.llm-row')).length >= 8 && !(await controls.isDisabled('#llm-btn-check')), 30000);
    assert(!!rowsOk, 'the check rows render');
    const rows = await controls.$$eval('#llm-check-rows li.llm-row', (ls) => ls.map((l) => ({ id: l.dataset.row, icon: l.querySelector('.llm-icon').textContent, text: l.textContent, fix: !!l.querySelector('.llm-fix') })));
    assert(rows.every((r) => ['✔', '⚠', '✖'].includes(r.icon)), `every row has ✔ / ⚠ / ✖ (${rows.map((r) => `${r.id}${r.icon}`).join(' ')})`);
    const byId = (id) => rows.find((r) => r.id === id) || {};
    assert(byId('installed').icon === '✔' && /0\.5\.7/.test(byId('installed').text), 'Ollama installed ✔ (the fake program\'s version)');
    assert(byId('server').icon === '✔', 'Ollama running ✔ (the fake server)');
    assert(byId('gpu').icon === '✔' && /RTX 3060/.test(byId('gpu').text), 'graphics card found ✔ (the fake nvidia-smi)');
    const failing = rows.filter((r) => r.icon === '✖');
    assert(failing.length >= 1 && byId('alfred-model').icon === '✖', `Alfred's model (llama3.1:8b, not installed) is ✖ (${failing.map((r) => r.id).join(', ')})`);
    assert(failing.every((r) => r.fix), 'every failing row has a Fix button');
    const fixBtn = controls.locator('#llm-check-rows li[data-row="alfred-model"] .llm-fix');
    const fixLabel = await fixBtn.textContent();
    assert(/Use qwen2\.5:0\.5b/.test(fixLabel), `its Fix offers the installed model ("${fixLabel}")`);
    await fixBtn.click();
    const fixed = await until(async () => {
      const ic = await controls.$eval('#llm-check-rows li[data-row="alfred-model"] .llm-icon', (e) => e.textContent).catch(() => null);
      return ic === '✔' && !(await controls.isDisabled('#llm-btn-check')) ? ic : null;
    }, 30000);
    assert(!!fixed, 'pressing Fix makes the row ✔');
    let s = await controls.evaluate(() => window.api.alfredStatus());
    assert(s.settings.local.model === 'qwen2.5:0.5b', `the fix pointed Alfred at qwen2.5:0.5b (${s.settings.local.model})`);

    console.log('\n== 🔎 Find a model: hardware + fit ratings (offline list) ==');
    await controls.locator('#llm-models').scrollIntoViewIfNeeded();
    const hwLine = await until(async () => { const t = await controls.textContent('#llmm-hw'); return /RTX 3060/.test(t) ? t : null; }, 20000);
    assert(!!hwLine && /6 GB/.test(hwLine) && /RAM/.test(hwLine), `the hardware line names the card and RAM ("${hwLine}")`);
    const cardsOk = await until(async () => (await controls.$$('#llmm-results .llmm-card')).length >= 5, 20000);
    assert(!!cardsOk, 'the recommended models render (offline)');
    const cards = () => controls.$$eval('#llmm-results .llmm-card', (cs) => cs.map((c) => ({
      id: c.dataset.id, rating: c.dataset.rating, unc: c.dataset.uncensored === '1', fit: c.querySelector('.llmm-fit').textContent,
      reason: c.querySelector('.llmm-reason').textContent, dl: c.querySelector('.llmm-dl').disabled, dlTitle: c.querySelector('.llmm-dl').title,
      why: (c.querySelector('.llmm-why') || {}).textContent || '', badge: !!c.querySelector('[data-badge="uncensored"]'),
    })));
    let list = await cards();
    assert(list.every((c) => /★|✖|\?/.test(c.fit) && /fit|slow|big|unknown/i.test(c.fit)), `every card has a fit rating with stars + words (${[...new Set(list.map((c) => c.fit))].join(' | ')})`);
    assert(list.some((c) => c.rating === 'great') && list.every((c) => c.reason.trim().length > 10), 'great fits exist and every card says why');
    const big = list.find((c) => c.rating === 'too-big');
    assert(!!big, `a too-big model is listed (${big && big.id})`);
    if (big) {
      assert(big.dl === true, `${big.id}: ⬇ Download is disabled`);
      assert(/^Can't download:/.test(big.dlTitle) && big.dlTitle.length > 20 && /Too big/i.test(big.why), `…with the reason ("${big.dlTitle.slice(0, 90)}…", "${big.why}")`);
    }
    assert(list.filter((c) => c.rating !== 'too-big').every((c) => !c.dl), 'models that fit can be downloaded');

    console.log('\n== 🔓 Uncensored filter ==');
    await controls.click('#llmm-unc');
    const uncOk = await until(async () => /uncensored first/.test(await controls.textContent('#llmm-msg')), 15000);
    assert(!!uncOk, 'the list reloads with "🔓 uncensored first"');
    list = await cards();
    const firstPlain = list.findIndex((c) => !c.unc);
    assert(list.length && list[0].unc && list[0].badge, `the first model is uncensored with a 🔓 badge (${list[0] && list[0].id})`);
    assert(firstPlain > 0 && list.slice(firstPlain).every((c) => !c.unc), `uncensored models are ranked first (${firstPlain} of ${list.length}), none hidden or mixed in`);
    assert(list.some((c) => !c.unc), 'the other models are still offered (not filtered out)');
    await controls.click('#llmm-unc');
    await until(async () => !/uncensored first/.test(await controls.textContent('#llmm-msg')) && (await controls.$$('#llmm-results .llmm-card')).length >= 5, 15000);

    console.log('\n== online search, no network: a plain message, the offline list still works ==');
    await controls.fill('#llmm-q', 'qwen');
    await controls.click('#llmm-go');
    const searchMsg = await until(async () => { const t = await controls.textContent('#llmm-msg'); return !(await controls.isDisabled('#llmm-go')) && /Couldn't reach|Recommended/.test(t) ? t : null; }, 60000, 400);
    assert(!!searchMsg && /Couldn't reach/.test(searchMsg) && /Recommended \(works offline\)/.test(searchMsg), `the search fails with a plain message ("${(searchMsg || await controls.textContent('#llmm-msg')).slice(0, 160)}")`);
    assert(!/Error:|ENOTFOUND|ECONN|fetch failed|TypeError/.test(searchMsg || ''), 'no raw error codes in it');
    await controls.click('#llmm-curated');
    const back = await until(async () => (await controls.$$('#llmm-results .llmm-card')).length >= 5 && /Recommended for Alfred/.test(await controls.textContent('#llmm-msg')), 15000);
    assert(!!back, '⭐ Recommended brings the offline list back');

    console.log('\n== download a model that fits ==');
    const card = controls.locator('#llmm-results .llmm-card[data-id="curated:qwen2.5"]');
    await card.locator('select.llmm-variant').selectOption('qwen2.5:1.5b');
    const vfit = await card.getAttribute('data-rating');
    assert(vfit === 'great' || vfit === 'good', `qwen2.5:1.5b fits this PC (${vfit})`);
    const pulls0 = oll.st.pulls.length;
    await card.locator('.llmm-dl').click();
    const prog = await until(async () => { const t = await card.locator('.llmm-prog').textContent().catch(() => ''); return /\d+%/.test(t) ? t : null; }, 15000, 100);
    assert(!!prog, `download progress shows ("${prog}")`);
    assert(await card.locator('.llmm-dl').isDisabled(), 'the button is disabled while it downloads');
    const done = await until(async () => /Downloaded/.test(await card.locator('.llmm-dl').textContent()), 30000);
    assert(!!done, 'the card says ✔ Downloaded');
    assert(oll.st.pulls.length === pulls0 + 1 && oll.st.pulls[pulls0] === 'qwen2.5:1.5b', `Ollama was asked to pull qwen2.5:1.5b (${oll.st.pulls.slice(pulls0).join(', ')})`);
    await controls.locator('#llm-setup').scrollIntoViewIfNeeded();
    await controls.evaluate(() => { document.getElementById('llm-installed-wrap').open = true; });
    const row = controls.locator('#llm-installed .llm-model[data-model="qwen2.5:1.5b"]');
    const listed = await until(() => row.count(), 10000);
    assert(!!listed, 'it is in 📦 Models on this PC');
    await row.locator('.llm-use').click();
    const used = await until(async () => { const x = await controls.evaluate(() => window.api.alfredStatus()); return x.settings.local.model === 'qwen2.5:1.5b' ? x : null; }, 15000);
    assert(!!used, '"Use" makes it Alfred\'s model (alfredStatus().settings.local.model)');
    const inUse = await until(async () => /in use/.test(await row.textContent()), 10000);
    assert(!!inUse, 'the list marks it "in use"');

    console.log('\n== 🎩 personality + saved set-ups ==');
    await controls.locator('#alfred-persona').scrollIntoViewIfNeeded();
    await until(async () => (await controls.$$('#ap-preset option')).length >= 5, 10000);
    await controls.selectOption('#ap-preset', 'witty');
    await controls.fill('#ap-tone', 'dry, unhurried');
    await controls.click('#ap-save');
    const saved = await until(async () => /Saved/.test(await controls.textContent('#ap-msg')), 10000);
    assert(!!saved, `saving says so ("${await controls.textContent('#ap-msg')}")`);
    let p = await controls.evaluate(() => window.api.alfredPersonality());
    assert(p.personality.preset === 'witty' && p.personality.tone === 'dry, unhurried', `alfredPersonality() reads it back (${p.personality.preset}, "${p.personality.tone}")`);
    assert(/PERSONALITY/.test(p.prompt) && /I will/.test(p.prompt), 'his prompt carries it, voice only (the "I will" rule stays)');
    await controls.fill('#ap-new-name', 'Witty local');
    await controls.click('#ap-new-save');
    const prof = await until(() => controls.locator('#ap-profiles li[data-name="Witty local"]').count(), 10000);
    assert(!!prof, 'the set-up "Witty local" is saved');
    await controls.selectOption('#ap-preset', 'brief');
    await controls.click('#ap-save');
    await until(async () => (await controls.evaluate(() => window.api.alfredPersonality())).personality.preset === 'brief', 10000);
    await controls.fill('#ap-new-name', 'Brief');
    await controls.click('#ap-new-save');
    await until(() => controls.locator('#ap-profiles li[data-name="Brief"]').count(), 10000);
    let pr = await controls.evaluate(() => window.api.alfredProfiles());
    assert(pr.profiles.length === 2 && pr.activeProfile === 'Brief', `two set-ups, "Brief" active (${pr.profiles.map((x) => x.name).join(', ')}; active ${pr.activeProfile})`);
    await controls.click('#ap-profiles li[data-name="Witty local"] .ap-use');
    const switched = await until(async () => { const x = await controls.evaluate(() => window.api.alfredProfiles()); return x.activeProfile === 'Witty local' ? x : null; }, 10000);
    assert(!!switched, 'switching to "Witty local" makes it the active set-up');
    p = await controls.evaluate(() => window.api.alfredPersonality());
    assert(p.personality.preset === 'witty', `…and brings its personality back (${p.personality.preset})`);
    const presetUi = await until(async () => ((await controls.inputValue('#ap-preset')) === 'witty' ? 'witty' : null), 5000);
    assert(!!presetUi, 'the personality box shows it');
    s = await controls.evaluate(() => window.api.alfredStatus());
    assert(s.settings.local.model === 'qwen2.5:1.5b', `the set-up kept his model (${s.settings.local.model})`);

    console.log('\n== ⚡ the one button ==');
    await controls.locator('#llm-setup').scrollIntoViewIfNeeded();
    for (const round of [1, 2]) {
      const n0 = oll.st.pulls.length;
      await controls.click('#llm-btn-setup');
      const fin = await until(async () => {
        if (await controls.isDisabled('#llm-btn-setup')) return null;
        const cls = await controls.getAttribute('#llm-msg', 'class');
        return /llm-good|llm-bad/.test(cls) ? cls : null;
      }, 90000, 300);
      await sleep(400); // let the last "check" event / final message land
      const m = await controls.textContent('#llm-msg');
      assert(fin && /llm-good/.test(fin) && /ready|All set/.test(m), `press ${round}: the setup runs to completion ("${m.slice(0, 120)}")`);
      const steps = await controls.$$eval('#llm-steps li', (ls) => ls.map((l) => l.textContent.slice(0, 1)));
      assert(steps.length >= 6 && steps.every((x) => x === '✔'), `press ${round}: every step is ✔ (${steps.join('')})`);
      if (round === 1) {
        const x = await controls.evaluate(() => window.api.alfredStatus());
        assert(/^qwen3:4b$/.test(x.settings.local.model), `press 1: picks the best fit that can use tools (≥3B) and makes it Alfred's (${x.settings.local.model}; pulled ${oll.st.pulls.slice(n0).join(', ') || 'nothing'})`);
      } else {
        assert(oll.st.pulls.length === n0, 'press 2: nothing downloaded again (idempotent)');
      }
    }
    const rowsAfter = await controls.$$eval('#llm-check-rows li.llm-row .llm-icon', (ls) => ls.map((l) => l.textContent));
    assert(rowsAfter.length >= 8 && !rowsAfter.includes('✖'), `after the setup the check has no ✖ (${rowsAfter.join('')})`);

    console.log('\n== screenshot ==');
    fs.mkdirSync(SHOTS, { recursive: true });
    await controls.evaluate(() => { const w = document.getElementById('llm-installed-wrap'); if (w) w.open = true; });
    const file = path.join(SHOTS, 'alfred-ai-setup.png');
    // The box is taller than the window, and the panel above it is sticky inside the page's scroller:
    // make the window tall enough for the whole page so nothing scrolls or floats over the box.
    const tall = await controls.evaluate(() => {
      let el = document.getElementById('llm-zone'); let sc = null;
      for (let e = el.parentElement; e; e = e.parentElement) { const o = getComputedStyle(e).overflowY; if ((o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight) { sc = e; break; } }
      const extra = sc ? sc.scrollHeight - sc.clientHeight : document.documentElement.scrollHeight - window.innerHeight;
      return Math.min(9000, window.innerHeight + Math.max(0, extra) + 40);
    });
    await controls.setViewportSize({ width: 1500, height: tall }).catch(() => {});
    await sleep(600);
    await controls.locator('#llm-zone').screenshot({ path: file });
    await controls.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
    assert(fs.existsSync(file) && fs.statSync(file).size > 10000, `screenshot of the setup box (${path.relative(APP_DIR, file)})`);
    keep('alfred-ai-setup', 'alfred-ai-setup.png');
  } finally {
    await app.close().catch(() => {});
    await oll.down();
  }
  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  return state.failed ? 1 : 0;
}
main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
