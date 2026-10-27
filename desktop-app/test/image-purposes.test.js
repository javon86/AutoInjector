// test/image-purposes.test.js — /image/request additions for book covers, illustrations and maps
// (docs/SD_IMAGE_API.md): purpose "map", a size (shape) hint and upscale 2|4, on a fake Forge
// and with a stand-in ChatGPT engine.
// Run: node test/image-purposes.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const ip = require('../image-provider');
const L = require('../sd-library');
const { createSdStudio, sizeFor, sizeForShape, MAP_WORDS } = require('../sd-studio');
const { fakeA1111, PNG } = require('./fixtures/fake-sd');

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log(`  ok   - ${msg}`); } else { failed++; console.log(`  FAIL - ${msg}`); } return cond; }

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imgpurp-'));
  const lib = L.createLibrary({ storePath: path.join(tmp, 'lib.json'), env: {}, findStabilityMatrix: () => [] });
  const chatJobs = [];
  const fakeChatgpt = {
    readiness: () => ({ ready: true }), status: () => ({ ready: true, busy: false }),
    generate: async (o) => {
      chatJobs.push(o);
      const p = path.join(tmp, `cg-${chatJobs.length}.png`); fs.writeFileSync(p, PNG);
      return { ok: true, engine: 'chatgpt', images: [{ path: p, sha256: 'x', width: 512, height: 512 }], settings: { purpose: o.purpose } };
    },
  };
  const studio = createSdStudio({ imageProvider: ip, library: lib, imagesDir: () => path.join(tmp, 'images'), chatgpt: fakeChatgpt, recordImage: () => {}, persist: () => {}, log: () => {}, fileUrl: (p) => `file://${p}` });

  console.log('\n== sizes ==');
  assert(sizeFor('map', 'SD1.5').width > sizeFor('map', 'SD1.5').height && sizeFor('map', 'SDXL').width === 1344, 'map: wide (768×448 on SD 1.5, 1344×768 on SDXL)');
  const tall = sizeForShape('cover', 'SD1.5', { width: 6, height: 9 });
  assert(tall.height > tall.width && tall.width % 64 === 0 && tall.height % 64 === 0 && Math.abs(tall.width / tall.height - 6 / 9) < 0.1, `a 6×9 in cover shape → ${tall.width}×${tall.height} (tall, on the 64 grid, about the cover's pixel area)`);
  assert(sizeForShape('cover', 'SD1.5', { width: 0, height: 9 }) === null, 'a bad shape is ignored');

  console.log('\n== ChatGPT (no SD app connected) ==');
  let r = await studio.request({ purpose: 'map', prompt: 'the coastal city of Nacre and its harbour', engine: 'chatgpt', from: 'akowe' });
  assert(r.ok && /Create one wide map image/.test(chatJobs[0].text) && chatJobs[0].text.includes('no labels'), 'purpose "map" → a wide map request with the map words');
  r = await studio.request({ purpose: 'cover', prompt: 'a lighthouse at night', size: { width: 6, height: 9 }, engine: 'chatgpt' });
  assert(r.ok && /tall \(portrait\) format/.test(chatJobs[1].text), 'size {6×9} → "tall (portrait) format" for ChatGPT');
  r = await studio.request({ purpose: 'cover', prompt: 'x', upscale: 2, engine: 'chatgpt' });
  assert(r.ok && r.warnings.some((w) => w.kind === 'upscale' && /needs a connected Stable Diffusion/.test(w.message)), 'upscale with no SD app: the picture is made, with a soft warning');
  r = await studio.request({ purpose: 'cover', prompt: 'x', upscale: 3 });
  assert(!r.ok && r.error === 'INVALID_PARAM' && r.field === 'upscale', 'upscale 3 → INVALID_PARAM');
  r = await studio.request({ purpose: 'cover', prompt: 'x', size: { width: 'a' } });
  assert(!r.ok && r.field === 'size', 'a bad size → INVALID_PARAM');

  console.log('\n== Stable Diffusion (fake Forge) ==');
  const a = await fakeA1111({ flavor: 'forge' });
  const c = await studio.connect(a.base);
  assert(c.ok, 'connected to the fake Forge');
  r = await studio.request({ purpose: 'map', prompt: 'the coastal city of Nacre', engine: 'sd', from: 'akowe' });
  let body = a.state.lastTxt2img;
  assert(r.ok && body.prompt.includes(MAP_WORDS) && /text, letters/.test(body.negative_prompt) && body.width > body.height, `map on SD: map words + no-text negative, wide (${body.width}×${body.height})`);
  r = await studio.request({ purpose: 'cover', prompt: 'a lighthouse', size: { width: 5.5, height: 8.5 }, engine: 'sd' });
  body = a.state.lastTxt2img;
  assert(r.ok && body.height > body.width && Math.abs(body.width / body.height - 5.5 / 8.5) < 0.1, `cover with a 5.5×8.5 shape → ${body.width}×${body.height}`);
  r = await studio.request({ purpose: 'cover', prompt: 'a lighthouse', width: 640, height: 640, size: { width: 6, height: 9 }, engine: 'sd' });
  assert(r.ok && a.state.lastTxt2img.width === 640, 'an explicit width/height wins over the shape hint');
  a.state.lastExtras = null;
  r = await studio.request({ purpose: 'cover', prompt: 'a lighthouse', upscale: 2, engine: 'sd', returnImage: true });
  const im = r.images && r.images[0];
  assert(r.ok && a.state.lastExtras && im.upscaled === 2 && im.original && im.path !== im.original && fs.existsSync(im.path) && fs.existsSync(im.original) && r.paths[0] === im.path && im.imageBase64, 'upscale 2 on SD: Extras runs, the result points at the bigger file (base64 too), the original is kept');
  r = await studio.request({ purpose: 'map', prompt: 'x', upscale: 4, engine: 'chatgpt' });
  assert(r.ok && !r.warnings.some((w) => w.kind === 'upscale') && r.images[0].upscaled === 4, 'a ChatGPT picture is upscaled by the connected SD app too');
  await a.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
