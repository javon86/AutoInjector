'use strict';
// images-judge.e2e.js — 💾 recipes, 🧑‍⚖️ the AI judge and 🔁 Make it better in the REAL app (xvfb), with a fake Forge
// (test/fixtures/fake-sd.js), a fake `claude` CLI as the judge (test/fixtures/fake-claude-judge.js) and the Claude pane
// pointed at test/fixtures/fake-chat.html (it answers a judge question with JSON when a picture was uploaded).
//   generate → 🧑‍⚖️ Judge shows the scores (Claude Code) → 🔁 Make it better runs 2 rounds with a visible strip →
//   💾 Save these settings as a recipe → load the recipe into the form → ♻ Remake reproduces (same seed and prompt) →
//   the pane judge (Claude Code switched off): a fresh chat, the picture uploaded, the JSON read back.
// The window is 1280×720 (screenshots go to IMGJ_SHOTS, default test/e2e/__screenshots__). For 2× screenshots give the
// virtual screen room:  IMGJ_SCALE=2 xvfb-run -a -s "-screen 0 2700x1600x24" node test/e2e/images-judge.e2e.js
//   TMPDIR=/dev/shm xvfb-run -a node test/e2e/images-judge.e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeAsserts, APP_DIR } = require('./helpers');
const { fakeA1111 } = require('../fixtures/fake-sd');
const { makeFakeClaude } = require('../fixtures/fake-claude-judge');

let electron;
try { electron = require('playwright')._electron; } catch (_) { console.error('needs playwright'); process.exit(2); }
const SHOTS = process.env.IMGJ_SHOTS || path.join(__dirname, '__screenshots__');
const FIX = path.join(__dirname, '..', 'fixtures', 'fake-chat.html');
const url = (q) => `file://${FIX}?${q}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { assert, state } = makeAsserts();
  fs.mkdirSync(SHOTS, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imgj-e2e-'));
  const home = path.join(tmp, 'home'); fs.mkdirSync(home, { recursive: true });
  const userData = path.join(tmp, 'userdata');
  const claude = makeFakeClaude(path.join(tmp, 'fakeclaude'));
  const ccLog = path.join(tmp, 'fakeclaude', 'calls.jsonl');
  const forge = await fakeA1111({ flavor: 'forge' });
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', `--force-device-scale-factor=${process.env.IMGJ_SCALE || '1'}`, `--user-data-dir=${userData}`], cwd: APP_DIR,
    env: Object.assign({}, process.env, {
      HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), AUTOINJECTOR_AKOWE_SERVER: '0', AUTOINJECTOR_CHECKIN: '0', AUTOINJECTOR_BRIDGE: '0', AUTOINJECTOR_SD_AUTOSTART: '0',
      AUTOINJECTOR_VIDEO_AUTOSTART: '0', AUTOINJECTOR_CONTENT_SCAN: '0', AUTOINJECTOR_SD_HOME: path.join(home, 'sdhome'), AUTOINJECTOR_SD_MODEL_DIRS: path.join(tmp, 'nomodels'),
      AUTOINJECTOR_CLAUDE_PATH: claude, FAKE_CLAUDE_JUDGE_STATE: path.join(tmp, 'fakeclaude', 'n'), FAKE_CLAUDE_JUDGE_LOG: ccLog,
      AUTOINJECTOR_JUDGE_OLLAMA: 'http://127.0.0.1:9', AUTOINJECTOR_JUDGE_UPLOAD_MS: '600', AUTOINJECTOR_JUDGE_PANE_MS: '60000', AUTOINJECTOR_PROBE_DELAY_MS: '800',
      AUTOINJECTOR_SITE_URL_CHATGPT: url('site=chatgpt&quirks=none&speed=0.3'), AUTOINJECTOR_SITE_URL_CLAUDE: url('site=claude&quirks=none&speed=0.3'), AUTOINJECTOR_SITE_URL_GEMINI: url('site=gemini&quirks=none&speed=0.3'),
      AUTOINJECTOR_AKOWE_DIR: path.join(tmp, 'noakowe'), NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    }),
  });
  const shot = async (page, name) => { try { await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); } catch (_) {} };
  try {
    let c = null;
    for (let i = 0; i < 100 && !c; i++) { for (const w of app.windows()) { try { if (await w.$('#tab-app-images')) c = w; } catch (_) {} } if (!c) await sleep(400); }
    assert(!!c, 'the control panel appears');
    if (!c) return;
    const errors = []; c.on('pageerror', (e) => errors.push(String(e)));
    // a 1280×720 window (the panel must fit it with no sideways scrolling)
    await app.evaluate(({ BaseWindow }) => { for (const w of BaseWindow.getAllWindows()) { try { if (w.isVisible()) { if (w.isFullScreen()) w.setFullScreen(false); if (w.isMaximized()) w.unmaximize(); w.setContentSize(1280, 720); w.center(); } } catch (_) {} } });
    await sleep(800);
    await c.click('#tab-app-images');
    await c.waitForSelector('#images-tab:not([hidden])', { timeout: 10000 });
    await c.fill('#sd-url', forge.base);
    await c.click('#btn-sd-connect');
    await c.waitForFunction(() => /Connected to Forge/.test(document.getElementById('sd-status-text').textContent), null, { timeout: 15000 }).catch(() => {});
    await c.waitForFunction(() => document.getElementById('sd-recipe').options.length > 2, null, { timeout: 10000 }).catch(() => {});
    const recipeNames = await c.$$eval('#sd-recipe option', (o) => o.map((x) => x.textContent));
    assert(recipeNames.some((n) => /Realistic portrait — SDXL \(starter\)/.test(n)) && recipeNames.some((n) => /hires fix — SD1\.5 \(starter\)/.test(n)), `the Recipe picker lists the starter recipes (${recipeNames.length - 1})`);
    const wide = await c.evaluate(() => { const t = document.getElementById('images-tab'); return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, tab: t.scrollWidth - t.clientWidth, w: window.innerWidth }; });
    assert(wide.page <= 1 && wide.tab <= 1, `no sideways scrolling at ${wide.w} px wide (page ${wide.page}, tab ${wide.tab})`);

    console.log('\n== generate → 🧑‍⚖️ Judge ==');
    await c.fill('#sd-prompt', 'portrait of an old ferryman at dusk, lantern light');
    await c.click('#btn-sd-generate');
    await c.waitForFunction(() => /saved/.test(document.getElementById('sd-msg').textContent) && !document.getElementById('btn-sd-generate').disabled, null, { timeout: 20000 }).catch(() => {});
    const src = await c.getAttribute('#sd-preview', 'src');
    const first = decodeURIComponent(new URL(src).pathname);
    const rec0 = JSON.parse(fs.readFileSync(first.replace(/\.png$/, '.json'), 'utf8'));
    const firstTx = Object.assign({}, forge.state.lastTxt2img);
    assert(rec0.promptTyped === 'portrait of an old ferryman at dusk, lantern light' && rec0.seed === 1234 && rec0.askedBy.who === 'you' && rec0.engine === 'sd' && rec0.checkpointHash, 'the picture\'s sidecar holds what was typed, the real seed, who asked, the engine, the checkpoint hash');
    assert(await c.$eval('#btn-sd-judge', (b) => !b.disabled), '🧑‍⚖️ Judge is ready on the picture');
    await c.click('#btn-sd-judge');
    await c.waitForSelector('#sd-judge-box:not([hidden]) .sd-jbar', { timeout: 30000 }).catch(() => {});
    const jtext = await c.textContent('#sd-judge-box');
    assert(/\d(\.\d)?\/10/.test(jtext) && /judged by Claude Code/.test(jtext) && (await c.$$('#sd-judge-box .sd-jbar')).length === 5, `the judge box shows the scores and that Claude Code judged (“${jtext.slice(0, 60)}…”)`);
    const cc1 = fs.existsSync(ccLog) ? JSON.parse(fs.readFileSync(ccLog, 'utf8').trim().split('\n')[0]) : {};
    assert(cc1.sawPicture && cc1.argv && cc1.argv.includes('Read') && cc1.apiKey === false, 'Claude Code saw only the picture, with only the Read tool, on the person\'s plan');
    assert(JSON.parse(fs.readFileSync(first.replace(/\.png$/, '.json'), 'utf8')).judge.by === 'claude-code', 'the verdict is saved with the picture');
    await c.evaluate(() => { document.getElementById('sd-used').open = true; });
    await c.evaluate(() => document.getElementById('sd-judge-box').scrollIntoView({ block: 'start' }));
    await shot(c, 'images-judge-scores');

    console.log('\n== 🔁 Make it better (2 rounds) ==');
    await c.evaluate(() => { document.getElementById('sd-used').open = false; });
    await c.evaluate(() => window.api.sd.judgeSettings({ rounds: 2 }));
    await c.evaluate(() => { document.getElementById('sd-judge-rounds').value = '2'; });
    const optsBefore = JSON.stringify(await c.evaluate(() => window.api.sd.status().then((s) => ({ steps: s.steps, cfg: s.cfgScale, w: s.width, h: s.height, seed: s.seed }))));
    await c.click('#btn-sd-improve');
    await c.waitForFunction(() => document.querySelectorAll('#sd-improve-strip .sd-round').length >= 2 && !document.getElementById('sd-improve-actions').hidden, null, { timeout: 60000 }).catch(() => {});
    const cards = await c.$$eval('#sd-improve-strip .sd-round', (els) => els.map((e) => e.textContent));
    assert(cards.length === 2 && /Round 1: \d/.test(cards[0]) && /Round 2: \d/.test(cards[1]) && /changed: /.test(cards[1]), `the strip shows 2 rounds with scores and what changed (${cards.map((x) => x.slice(0, 40)).join(' | ')})`);
    assert(/★ best/.test(cards.join(' ')) && /Round|best/.test(await c.textContent('#sd-improve-msg')), 'the best round is marked and the result is said in plain words');
    const optsAfter = JSON.stringify(await c.evaluate(() => window.api.sd.status().then((s) => ({ steps: s.steps, cfg: s.cfgScale, w: s.width, h: s.height, seed: s.seed }))));
    assert(optsAfter === optsBefore, 'Make it better never changed the Images defaults');
    const r2Tx = forge.state.lastTxt2img;
    assert(r2Tx.steps === firstTx.steps + 6 && r2Tx.seed === 1234 && /sharp focus/.test(r2Tx.prompt), `round 2 used the judge's fixes (steps ${firstTx.steps} → ${r2Tx.steps}, "sharp focus" added) with the same seed`);
    await c.evaluate(() => document.getElementById('sd-improve-box').scrollIntoView({ block: 'start' }));
    await shot(c, 'images-improve-strip');

    console.log('\n== 💾 Save these settings as a recipe → load it → ♻ Remake ==');
    await c.click('#sd-improve-strip .sd-round:nth-child(2)');
    await c.click('#btn-sd-improve-recipe');
    await c.fill('#sd-recipe-name', 'Ferryman round 2');
    await c.click('#btn-sd-recipe-name-ok');
    await c.waitForFunction(() => /Saved the recipe “Ferryman round 2”/.test(document.getElementById('sd-recipe-note').textContent), null, { timeout: 10000 }).catch(() => {});
    assert(/Saved the recipe/.test(await c.textContent('#sd-recipe-note')), 'the recipe is saved (only when pressed)');
    const stored = JSON.parse(fs.readFileSync(path.join(userData, 'sd-recipes.json'), 'utf8'));
    const mine = stored.recipes.find((x) => x.name === 'Ferryman round 2');
    assert(mine && mine.settings.steps === r2Tx.steps && mine.from === 'picture', 'stored in AutoInjector\'s own sd-recipes.json with the round\'s settings');
    await c.evaluate(() => document.getElementById('sd-form').scrollTo(0, 0));
    await c.selectOption('#sd-recipe', 'starter-sdxl-cinematic');
    await c.waitForFunction(() => /Loaded “Cinematic scene/.test(document.getElementById('sd-recipe-note').textContent), null, { timeout: 8000 }).catch(() => {});
    assert(await c.inputValue('#sd-steps') === '30', 'a starter recipe loads into the form (30 steps)');
    await c.selectOption('#sd-recipe', mine.id);
    await c.waitForFunction(() => /Loaded “Ferryman round 2”/.test(document.getElementById('sd-recipe-note').textContent), null, { timeout: 8000 }).catch(() => {});
    assert(await c.inputValue('#sd-steps') === String(r2Tx.steps), `loading the saved recipe puts its settings into the form (steps ${r2Tx.steps})`);
    await shot(c, 'images-recipe-picker');
    // ♻ Remake the first picture: pick it in the gallery, Remake, Generate → the same seed and prompt reach Forge
    await c.evaluate((p) => { const im = [...document.querySelectorAll('#sd-gallery img')].find((x) => decodeURIComponent(new URL(x.src).pathname) === p); if (im) im.click(); }, first);
    await sleep(300);
    await c.selectOption('#sd-recipe', '');
    await c.click('#btn-sd-remake');
    await sleep(300);
    await c.click('#btn-sd-generate');
    await c.waitForFunction(() => /saved/.test(document.getElementById('sd-msg').textContent) && !document.getElementById('btn-sd-generate').disabled, null, { timeout: 20000 }).catch(() => {});
    const again = forge.state.lastTxt2img;
    assert(again.seed === rec0.seed && again.prompt === firstTx.prompt && again.negative_prompt === firstTx.negative_prompt && again.steps === firstTx.steps && again.cfg_scale === firstTx.cfg_scale && again.width === firstTx.width, `♻ Remake reproduces: seed ${again.seed}, the same prompt, negative, steps, CFG and size`);
    const exact = await c.evaluate((p) => window.api.sd.remake(p), first);
    assert(exact && exact.ok && forge.state.lastTxt2img.seed === 1234 && forge.state.lastTxt2img.prompt === firstTx.prompt, 'the exact remake (sd:remake, what Alfred uses) reproduces it too');

    console.log('\n== the pane judge (Claude Code off): a fresh chat, the picture uploaded ==');
    await c.evaluate(() => window.api.sd.judgeSettings({ enabled: { 'claude-code': false, local: false, pane: true }, paneSite: 'claude' }));
    let pj = null;
    for (let i = 0; i < 20 && !(pj && pj.ok); i++) { pj = await c.evaluate((p) => window.api.sd.judge(p), first); if (!(pj && pj.ok)) await sleep(1500); }
    assert(pj && pj.ok && pj.judge.by === 'pane' && pj.judge.good.includes('the pane saw the picture'), `the Claude pane judged it with the picture attached (${pj && (pj.ok ? pj.judge.byLabel : pj.message)})`);
    const att = await app.evaluate(async ({ webContents }) => { const wc = webContents.getAllWebContents().find((w) => /fake-chat\.html/.test(w.getURL()) && w.getURL().includes('site=claude')); return wc ? wc.executeJavaScript('({ judged: window.__fake.judged || 0, posted: window.__fake.posted.length })', true) : null; });
    assert(att && att.judged >= 1, `the fake Claude page got the judge question (${JSON.stringify(att)})`);
    assert(!errors.length, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
  } finally {
    await app.close().catch(() => {});
    await forge.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  process.exit(state.failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
