'use strict';
// sd-images.e2e.js — the REAL app's 🎨 Images tab against a fake Forge (A1111 API)
// server and a folder of tiny synthetic .safetensors files: connect, status line,
// LoRA picker, Generate → picture saved with its settings, gallery, Library scan +
// edit, Start & install view. Screenshots go to SD_SHOT_DIR (or __screenshots__).
//   xvfb-run -a node test/e2e/sd-images.e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findWindow, makeAsserts, APP_DIR, SHOT_DIR } = require('./helpers');
const { fakeA1111 } = require('../fixtures/fake-sd');

let electron;
try { electron = require('playwright')._electron; } catch (_) { console.error('needs playwright'); process.exit(2); }

function writeSafetensors(file, metadata) {
  const json = Buffer.from(JSON.stringify({ __metadata__: metadata, w: { dtype: 'F16', shape: [2], data_offsets: [0, 4] } }));
  const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(json.length));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([len, json, Buffer.from([1, 2, 3, 4])]));
}

async function main() {
  const { assert, state } = makeAsserts();
  const shotDir = process.env.SD_SHOT_DIR || SHOT_DIR;
  fs.mkdirSync(shotDir, { recursive: true });
  const shot = async (page, name) => { try { await page.screenshot({ path: path.join(shotDir, `${name}.png`) }); } catch (_) {} };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-e2e-'));
  const models = path.join(tmp, 'StabilityMatrix', 'Data', 'Models');
  writeSafetensors(path.join(models, 'Lora', 'odile_face.safetensors'), { ss_base_model_version: 'sd_v1', 'modelspec.trigger_phrase': 'odile woman' });
  writeSafetensors(path.join(models, 'Lora', 'xl_inkwash.safetensors'), { ss_base_model_version: 'sdxl_base_v1-0' });
  writeSafetensors(path.join(models, 'StableDiffusion', 'dreamshaper_8.safetensors'), { 'modelspec.architecture': 'stable-diffusion-v1' });
  const forge = await fakeA1111({ flavor: 'forge', loraFile: path.join(models, 'Lora', 'odile_face.safetensors') });
  const userData = path.join(tmp, 'userdata');
  let file = null; // the picture the test makes (removed afterwards)
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', `--user-data-dir=${userData}`],
    cwd: APP_DIR,
    env: Object.assign({}, process.env, { AUTOINJECTOR_AKOWE_SERVER: '0', AUTOINJECTOR_SD_MODEL_DIRS: models, AUTOINJECTOR_SD_HOME: path.join(tmp, 'sdhome'), AUTOINJECTOR_SD_AUTOSTART: '0' }),
  });
  try {
    const c = await findWindow(app, '#tab-app-images', 40000);
    assert(!!c, 'the control panel shows the 🎨 Images tab');
    if (!c) throw new Error('no window');
    await c.click('#tab-app-images');
    await c.waitForSelector('#images-tab:not([hidden])', { timeout: 10000 });
    assert(await c.evaluate(() => document.body.dataset.appTab === 'images'), 'the Images tab opens');
    await c.waitForFunction(() => /Not connected yet/.test(document.getElementById('sd-hint').textContent), null, { timeout: 10000 }).catch(() => {});
    await shot(c, '01-images-not-connected');

    await c.fill('#sd-url', forge.base);
    await c.click('#btn-sd-connect');
    await c.waitForFunction(() => /Connected to Forge/.test(document.getElementById('sd-status-text').textContent), null, { timeout: 15000 }).catch(() => {});
    const statusText = await c.textContent('#sd-status-text');
    assert(/✔ Connected to Forge on :\d+ — model dreamshaper_8/.test(statusText), `status line: "${statusText}"`);
    await c.waitForFunction(() => document.getElementById('sd-checkpoint').options.length > 1, null, { timeout: 10000 }).catch(() => {});
    assert((await c.$$eval('#sd-checkpoint option', (o) => o.length)) === 3, 'checkpoints listed from the SD app');

    await c.fill('#sd-prompt', 'portrait of a ferry captain, lantern light');
    await c.fill('#sd-lora-search', 'odile');
    await c.waitForSelector('.sd-sugg', { timeout: 10000 }).catch(() => {});
    const sug = await c.$('.sd-sugg');
    assert(!!sug, 'the LoRA picker suggests odile_face');
    if (sug) await sug.dispatchEvent('mousedown');
    await c.waitForSelector('.sd-chip', { timeout: 5000 }).catch(() => {});
    assert((await c.$$('.sd-chip')).length === 1, 'a LoRA chip was added');
    await shot(c, '02-images-generate-form');
    await c.click('#btn-sd-generate');
    await c.waitForFunction(() => /saved/.test(document.getElementById('sd-msg').textContent), null, { timeout: 20000 }).catch(() => {});
    const msg = await c.textContent('#sd-msg');
    assert(/1 picture saved/.test(msg), `Generate → "${msg.split('\n')[0]}"`);
    assert(/<lora:odile_face:0\.8>/.test(forge.state.lastTxt2img && forge.state.lastTxt2img.prompt), 'the WebUI received the prompt with <lora:odile_face:0.8>');
    const src = await c.getAttribute('#sd-preview', 'src');
    file = decodeURIComponent(new URL(src).pathname).replace(/^\/([A-Za-z]:)/, '$1');
    assert(fs.existsSync(file) && fs.existsSync(file.replace(/\.png$/, '.json')), 'the PNG and its settings sidecar are in the images/ folder');
    const rec = JSON.parse(fs.readFileSync(file.replace(/\.png$/, '.json'), 'utf8'));
    assert(rec.prompt.startsWith('portrait of a ferry captain') && rec.loras[0].name === 'odile_face' && rec.backend === 'a1111', 'the recorded settings let the picture be remade');
    await c.waitForFunction(() => document.querySelectorAll('#sd-gallery img').length > 0, null, { timeout: 5000 }).catch(() => {});
    assert((await c.$$('#sd-gallery img')).length >= 1, 'the gallery shows it');
    await shot(c, '03-images-result');

    await c.click('#sd-sub-library');
    await c.click('#btn-sd-lib-scan');
    await c.waitForFunction(() => document.querySelectorAll('.sd-libcard').length >= 3, null, { timeout: 15000 }).catch(() => {});
    const names = await c.$$eval('.sd-libcard .sd-nm', (els) => els.map((e) => e.textContent));
    assert(names.some((n) => /odile_face/.test(n)) && names.some((n) => /xl_inkwash/.test(n)) && names.some((n) => /dreamshaper_8/.test(n)), `the library lists the synthetic models (${names.length})`);
    const xlCard = await c.$('.sd-libcard[data-compat="hard"]');
    assert(!!xlCard, 'the SDXL LoRA is flagged as the wrong base for the SD1.5 checkpoint');
    await c.click('.sd-libcard[data-id="lora:odile_face"]');
    await c.waitForSelector('#sd-lib-editor:not([hidden])', { timeout: 5000 }).catch(() => {});
    await c.fill('#sd-ed-tags', 'face, heroine');
    await c.click('#btn-sd-ed-save');
    await c.waitForFunction(() => /Saved/.test(document.getElementById('sd-ed-msg').textContent), null, { timeout: 5000 }).catch(() => {});
    assert(/Saved/.test(await c.textContent('#sd-ed-msg')), 'tags saved in the library');
    const libJson = JSON.parse(fs.readFileSync(path.join(userData, 'sd-library.json'), 'utf8'));
    assert(libJson.user['lora:odile_face'] && libJson.user['lora:odile_face'].tags.includes('heroine'), 'stored in AutoInjector\'s own sd-library.json');
    await shot(c, '04-images-library');

    await c.click('#sd-sub-locks');
    await c.fill('#sd-lk-character', 'Odile');
    await c.fill('#sd-lk-loras', 'odile_face:0.75');
    await c.fill('#sd-lk-prompt', 'short silver hair, navy wool coat');
    await c.click('#btn-sd-lk-save');
    await c.waitForSelector('.sd-lockitem', { timeout: 5000 }).catch(() => {});
    assert((await c.$$('.sd-lockitem')).length === 1, 'a character lock was saved');
    await shot(c, '05-images-locks');

    await c.click('#sd-sub-setup');
    await c.waitForFunction(() => document.getElementById('sd-install-check').textContent.length > 10, null, { timeout: 15000 }).catch(() => {});
    assert(/free/.test(await c.textContent('#sd-install-check')), 'Start & install shows the disk-space check');
    await shot(c, '06-images-setup');
  } finally {
    await app.close().catch(() => {});
    await forge.close();
    if (file) for (const f of [file, file.replace(/\.png$/, '.json')]) { try { fs.unlinkSync(f); } catch (_) {} }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  process.exit(state.failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
