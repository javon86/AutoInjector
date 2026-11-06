// test/sd-quality.test.js — PR #128 "the pictures aren't realistic at all": sd-quality.js on its own
// (model family, the family's own sizes, sampler/steps/CFG defaults only from what the backend lists,
// default negative + Style chips, prompt shortening that keeps the looks, LoRA metadata + base mismatch)
// and wired into sd-studio against a fake Forge: an SDXL checkpoint at 512 px from Alfred → its own size,
// "(default)" sampler → DPM++ 2M + Karras, empty negative → the default, Akọwe's 1,900-character
// portrait → a short prompt with the full description kept in the .json, "Book pictures use".
// Run: node test/sd-quality.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Q = require('../sd-quality');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

// An Akọwe-style character description (~1,900 characters: looks buried in the story)
const AKOWE = 'Portrait of Adaeze Okonkwo, a 42-year-old Igbo market trader and widow. She is tall and broad-shouldered with a stocky build, dark brown skin and deep-set amber eyes that miss nothing. Her hair is grey at the temples and braided into tight cornrows under a green headwrap. A thin pale scar runs across her left cheek from a knife fight in her youth. She has laugh lines around her mouth and calloused hands. She wears a faded indigo wrapper with gold thread, a white blouse, coral bead necklace and brass bangles on both wrists. Known for her sharp tongue and fierce loyalty, she raised three children alone after her husband died at sea. She loves her grandchildren and fears nothing but the river spirits. She remembers every debt owed to her. Her rivals in the market respect her and fear her temper. Her father was a fisherman and her mother a dyer of cloth, and she learned both trades as a girl. She speaks Igbo, English and some Hausa. She often hums old songs while she works, she never forgets a face or a slight, she bargains in proverbs that her own mother taught her long ago, and the younger traders come to her when the council of elders will not listen to them. Every market day she counts her takings twice and gives a tenth of them to the widows who sell beside her. She is standing in a crowded Onitsha market at dusk, behind her stall of yams and peppers, with lantern light catching her face and smoke from cooking fires drifting behind her. In the background are canvas awnings, bicycles and traders bargaining. Realistic photograph, 85mm lens, shallow depth of field, detailed skin texture, cinematic lighting. She carries a worn leather purse at her hip and a wooden walking stick she does not need. Her posture is proud, her chin raised, as if daring the world to cheat her again.';

async function main() {
  console.log('== model family ==');
  assert(Q.familyOf('sd_xl_base_1.0_0.9vae.safetensors [e6bb9ea85b]') === 'SDXL', 'the user\'s "sd_xl_base_1.0_0.9vae" → SDXL (from the name)');
  assert(Q.familyOf('juggernautXL_v9.safetensors') === 'SDXL' && Q.familyOf('ponyDiffusionV6XL.safetensors') === 'Pony' && Q.familyOf('flux1-dev-fp8.safetensors') === 'Flux', 'juggernautXL → SDXL, ponyDiffusionV6XL → Pony, flux1-dev → Flux');
  assert(Q.familyOf('v1-5-pruned-emaonly.safetensors') === 'SD1.5', 'v1-5-pruned → SD1.5');
  assert(Q.familyOf('dreamshaper_8.safetensors', { base: 'SD1.5' }) === 'SD1.5' && Q.familyOf('realisticVision.safetensors', { base: 'stable-diffusion-xl-v1-base' }) === 'SDXL', 'the library\'s header read wins over the name');
  assert(Q.familyOf('my_merge.safetensors', { size: 6.94e9 }) === 'SDXL' && Q.familyOf('my_merge.safetensors', { size: 2.13e9 }) === 'SD1.5' && Q.familyOf('my_merge.safetensors', { size: 11.9e9 }) === 'Flux', 'a name that says nothing → the file size (6.9 GB SDXL, 2.1 GB SD1.5, 11.9 GB Flux)');
  assert(Q.familyOf('my_merge.safetensors') === '', 'nothing to go on → unknown ("")');

  console.log('== sizes ==');
  assert(JSON.stringify(Q.sizeFor('SDXL', 'portrait')) === '{"width":832,"height":1216}' && JSON.stringify(Q.sizeFor('SDXL', 'square')) === '{"width":1024,"height":1024}' && JSON.stringify(Q.sizeFor('SDXL', 'landscape')) === '{"width":1216,"height":832}', 'SDXL: 832×1216 / 1024×1024 / 1216×832');
  assert(JSON.stringify(Q.sizeFor('SD1.5', 'portrait')) === '{"width":512,"height":768}' && JSON.stringify(Q.sizeFor('', 'square')) === '{"width":512,"height":512}', 'SD1.5 (and unknown): 512×768 / 512×512');
  assert(JSON.stringify(Q.sizeFor('Flux', 'portrait')) === '{"width":896,"height":1152}' && JSON.stringify(Q.sizeFor('Pony', 'portrait')) === '{"width":832,"height":1216}', 'Flux 896×1152; Pony uses the SDXL sizes');
  assert(Q.aspectOf(512, 768) === 'portrait' && Q.aspectOf(512, 512) === 'square' && Q.aspectOf(768, 512) === 'landscape', 'aspect from a size');
  assert(JSON.stringify(Q.nearestBucket('SDXL', 512, 768)) === '{"width":832,"height":1216}', 'SDXL at 512×768 → its own portrait size 832×1216');
  assert(/SDXL makes poor pictures this small/.test(Q.sizeWarning('SDXL', 512, 768)) && Q.sizeWarning('SDXL', 832, 1216) === '' && Q.sizeWarning('SD1.5', 512, 768) === '', 'the plain warning for SDXL below ~768 px (and none at its own size)');
  assert(/doubled/.test(Q.sizeWarning('SD1.5', 1024, 1024)), 'SD1.5 at 1024² → warned too');

  console.log('== sampler / steps / CFG ==');
  const d = Q.defaultsFor('SDXL');
  assert(d.steps >= 28 && d.steps <= 30 && d.cfgScale >= 5 && d.cfgScale <= 6 && d.sampler === 'DPM++ 2M' && d.scheduler === 'Karras', 'SDXL: DPM++ 2M + Karras, 28–30 steps, CFG 5–6');
  assert(Q.defaultsFor('SD1.5').cfgScale === 7 && Q.defaultsFor('Flux').cfgScale === 1 && Q.defaultsFor('Flux').distilledCfg === 3.5 && Q.defaultsFor('Flux').sampler === 'Euler' && Q.defaultsFor('Flux').scheduler === 'Simple', 'SD1.5 CFG 7; Flux Euler + Simple, CFG 1 / distilled 3.5');
  assert(JSON.stringify(Q.pickSampler('SDXL', { samplers: ['Euler a', 'DPM++ 2M'], schedulers: ['Automatic', 'Karras'] })) === '{"sampler":"DPM++ 2M","scheduler":"Karras"}', 'Forge lists DPM++ 2M + Karras → those exact names');
  assert(JSON.stringify(Q.pickSampler('SDXL', { samplers: ['Euler a', 'DPM++ 2M Karras'], schedulers: [] })) === '{"sampler":"DPM++ 2M Karras","scheduler":""}', 'old A1111 (no scheduler list) → "DPM++ 2M Karras"');
  assert(JSON.stringify(Q.pickSampler('SD1.5', { samplers: ['euler', 'dpmpp_2m'], schedulers: ['normal', 'karras'] })) === '{"sampler":"dpmpp_2m","scheduler":"karras"}', 'ComfyUI spelling → dpmpp_2m + karras');
  assert(Q.pickSampler('SDXL', { samplers: ['Euler a', 'DDIM'], schedulers: ['Karras'] }) === null && Q.pickSampler('SDXL', null) === null, 'not listed by the backend (or no lists) → nothing is set');
  assert(JSON.stringify(Q.pickSampler('Flux', { samplers: ['Euler', 'DPM++ 2M'], schedulers: ['Simple', 'Karras'] })) === '{"sampler":"Euler","scheduler":"Simple"}', 'Flux → Euler + Simple');

  console.log('== negative prompt + styles ==');
  const neg = Q.defaultNegative('SDXL', '');
  assert(/lowres/.test(neg) && /bad anatomy/.test(neg) && /extra fingers/.test(neg) && /watermark/.test(neg), `a sensible default negative ("${neg.slice(0, 50)}…")`);
  assert(/cartoon/.test(Q.defaultNegative('SDXL', 'photo')) && /3d render/.test(Q.defaultNegative('SDXL', 'photo')), 'Photo-real adds "cartoon, 3d render" to it');
  assert(Q.defaultNegative('Flux', 'photo') === '' && /^score_4/.test(Q.defaultNegative('Pony', '')), 'Flux: none (it ignores it); Pony: its score tags first');
  assert(Q.STYLE_IDS.join(',') === 'photo,cinematic,illustration,anime,painting', 'five styles: Photo-real · Cinematic · Illustration · Anime · Painting');
  const ps = Q.applyStyle('an old ferryman at dusk', 'photo', 'SDXL');
  assert(/^an old ferryman at dusk, RAW photo, photorealistic/.test(ps.prompt) && /cartoon/.test(ps.negative), 'Photo-real: the quality words go after the subject; its negative terms come back');
  assert(Q.applyStyle('RAW photo of a man', 'photo', 'SDXL').prompt.split('RAW photo').length === 2, 'words already there are not repeated');
  assert(Q.applyStyle('a knight', '', 'Pony').prompt.startsWith('score_9, score_8_up'), 'Pony gets its score tags');
  assert(Q.mergeTerms('blurry, text', 'Text, cartoon') === 'blurry, text, cartoon', 'mergeTerms keeps each term once');

  console.log('== prompt shortening (Akọwe\'s ~1,900-character portraits) ==');
  assert(AKOWE.length > 1800 && Q.estimateTokens(AKOWE) > 300, `the description is ${AKOWE.length} characters ≈ ${Q.estimateTokens(AKOWE)} tokens (CLIP reads 75 at a time)`);
  const c = Q.condensePrompt(AKOWE, { maxTokens: 150 });
  assert(c.condensed && c.tokensAfter <= 150 && c.full === AKOWE, `shortened to ≈${c.tokensAfter} tokens (cap 150 = 2 chunks); the full text is kept`);
  const p = c.prompt.toLowerCase();
  for (const k of ['42-year-old', 'amber eyes', 'grey', 'cornrows', 'scar', 'dark brown skin', 'stocky build', 'indigo wrapper', 'market', 'lantern light', 'photograph']) assert(p.includes(k), `keeps "${k}"`);
  for (const k of ['husband', 'grandchildren', 'hausa', 'debt', 'council']) assert(!p.includes(k), `drops the story ("${k}")`);
  assert(p.indexOf('adaeze') < p.indexOf('amber eyes') && p.indexOf('amber eyes') < p.indexOf('indigo') && p.indexOf('indigo') < p.indexOf('photograph'), 'most important first: subject → looks → clothing → … → style');
  const short = Q.condensePrompt('portrait of an old ferryman, lantern light');
  assert(!short.condensed && short.prompt === 'portrait of an old ferryman, lantern light', 'a normal prompt is left alone');
  const withLora = Q.condensePrompt(`${AKOWE} <lora:odile_face:0.8>`);
  assert(/<lora:odile_face:0\.8>$/.test(withLora.prompt), 'LoRA tags survive the shortening');

  console.log('== LoRA metadata ==');
  let li = Q.loraInfo({ ss_base_model_version: 'sdxl_base_v1-0', ss_tag_frequency: JSON.stringify({ '10_ink': { 'ink wash': 40, monochrome: 30, 'brush strokes': 12 } }) });
  assert(li.base === 'SDXL' && li.datasetTags.slice(0, 2).join() === 'ink wash,monochrome', 'kohya ss_base_model_version + ss_tag_frequency → SDXL, top tags first');
  li = Q.loraInfo({ 'modelspec.architecture': 'stable-diffusion-v1/lora', 'modelspec.trigger_phrase': 'odile woman' });
  assert(li.base === 'SD1.5' && li.triggers[0] === 'odile woman', 'modelspec.architecture + trigger_phrase → SD1.5, "odile woman"');
  li = Q.loraInfo({}, { baseModel: 'Pony', trainedWords: ['zxc style, glowing runes'] });
  assert(li.base === 'Pony' && li.triggers.join('|') === 'zxc style|glowing runes', 'a .civitai.info (baseModel + trainedWords) when the file says nothing');
  li = Q.loraInfo({ ss_base_model_version: 'sdxl_base_v1-0', ss_sd_model_name: 'ponyDiffusionV6XL' });
  assert(li.base === 'Pony', 'trained on Pony (ss_sd_model_name) beats a plain "sdxl" version');
  assert(Q.baseMatch('SD1.5', 'SDXL') === 'hard' && Q.baseMatch('SDXL', 'SDXL') === 'ok' && Q.baseMatch('Pony', 'SDXL') === 'soft' && Q.baseMatch('', 'SDXL') === 'unknown', 'base mismatch: an SD1.5 LoRA on SDXL is hard; Pony on SDXL soft; unknown stays unknown');
  assert(Q.loraTag('odile_face', 0.8) === '<lora:odile_face:0.8>', 'the A1111 tag');

  console.log('== wired into sd-studio (fake Forge) ==');
  const ip = require('../image-provider');
  const L = require('../sd-library');
  const { createSdStudio } = require('../sd-studio');
  const { fakeA1111 } = require('./fixtures/fake-sd');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdq-'));
  const forge = await fakeA1111({ flavor: 'forge' });
  const lib = L.createLibrary({ storePath: path.join(tmp, 'lib.json'), env: {}, findStabilityMatrix: () => [] });
  let persistedQ = null;
  const studio = createSdStudio({ imageProvider: ip, library: lib, imagesDir: () => path.join(tmp, 'images'), recordImage: () => {}, persist: () => {}, log: () => {}, fileUrl: (x) => x, persistQuality: (o) => { persistedQ = o; } });
  try {
    ip.setSettings({ steps: 20, cfgScale: 7, width: 512, height: 768, sampler: '', scheduler: '' });
    const con = await studio.connect(forge.base);
    assert(con.ok, 'connected to the fake Forge');
    const XL = 'juggernautXL_v9.safetensors [c9e3e68f89]';
    // Alfred (api:alfred): SDXL at 512×768, nothing else chosen — the user's case
    let g = await studio.generate({ prompt: 'portrait of a ferry captain', checkpoint: XL, width: 512, height: 768 }, 'api:alfred');
    let b = forge.state.lastTxt2img || {};
    assert(g.ok && b.width === 832 && b.height === 1216, `SDXL asked at 512×768 by Alfred → made at its own 832×1216 (got ${b.width}×${b.height})`);
    assert(g.warnings.some((w) => w.kind === 'quality' && /SDXL makes poor pictures at 512×768/.test(w.message)), 'and says so plainly');
    assert(b.sampler_name === 'DPM++ 2M' && b.scheduler === 'Karras' && b.steps === 28 && b.cfg_scale === 5.5, `"(default)" sampler → DPM++ 2M + Karras, 28 steps, CFG 5.5 (got ${b.sampler_name} ${b.scheduler} ${b.steps} ${b.cfg_scale})`);
    assert(/lowres/.test(b.negative_prompt) && /bad anatomy/.test(b.negative_prompt), 'no negative prompt → the default one');
    assert(g.settings.family === 'SDXL' && g.settings.quality && g.settings.quality.length, `the .json says what was applied (${(g.settings.quality || []).join('; ')})`);
    g = await studio.generate({ prompt: 'a lighthouse', checkpoint: XL }, 'api:alfred');
    b = forge.state.lastTxt2img;
    assert(g.ok && b.width === 832 && b.height === 1216, 'no size given → SDXL portrait 832×1216 (not the stored 512)');
    // the Images tab: its own size / steps / CFG stay exactly as sent; only "(default)" sampler + empty negative are filled
    g = await studio.generate({ prompt: 'a lighthouse', checkpoint: XL, width: 1024, height: 1024, steps: 30, cfgScale: 6, sampler: '', negativePrompt: 'blurry' }, 'images-tab');
    b = forge.state.lastTxt2img;
    assert(g.ok && b.width === 1024 && b.steps === 30 && b.cfg_scale === 6 && b.sampler_name === 'DPM++ 2M' && b.negative_prompt === 'blurry', 'Images tab: size / steps / CFG / negative as sent; "(default)" sampler → DPM++ 2M');
    g = await studio.generate({ prompt: 'a lighthouse', checkpoint: XL, width: 512, height: 512, sampler: 'Euler a' }, 'images-tab');
    b = forge.state.lastTxt2img;
    assert(g.ok && b.width === 512 && b.sampler_name === 'Euler a' && g.warnings.some((w) => /1024×1024/.test(w.message)), 'a sampler you chose is kept; a too-small SDXL size from the tab is warned about, not changed');
    // quality:false = exactly what was given
    g = await studio.generate({ prompt: 'x', checkpoint: XL, width: 512, height: 512, quality: false }, 'api:alfred');
    b = forge.state.lastTxt2img;
    assert(g.ok && b.width === 512 && !b.sampler_name && b.negative_prompt === '', 'quality:false → nothing added');
    // SD1.5 keeps 512×768
    g = await studio.generate({ prompt: 'x', checkpoint: 'dreamshaper_8.safetensors [879db523c3]', width: 512, height: 768 }, 'api:alfred');
    b = forge.state.lastTxt2img;
    assert(g.ok && b.width === 512 && b.height === 768 && b.cfg_scale === 7, 'SD1.5 at 512×768 stays (CFG 7)');
    // Akọwe's long portrait through the bridge
    g = await studio.request({ prompt: AKOWE, purpose: 'portrait', from: 'akowe-forge' });
    b = forge.state.lastTxt2img;
    assert(g.ok && Q.estimateTokens(b.prompt) <= 160 && /amber eyes/.test(b.prompt) && /scar/.test(b.prompt) && !/grandchildren/.test(b.prompt), `bridge:akowe-forge: the ~1,900-character description → a short prompt (≈${Q.estimateTokens(b.prompt)} tokens) with the looks`);
    const rec = JSON.parse(fs.readFileSync(g.images[0].path.replace(/\.png$/, '.json'), 'utf8'));
    assert(rec.fullPrompt === AKOWE && rec.from === 'bridge:akowe-forge', 'the saved .json keeps the full description (fullPrompt) and who asked');
    // Book pictures use: <checkpoint>
    assert(studio.quality().bookCheckpoint === '', '"Book pictures use" starts as whatever is loaded');
    studio.quality({ bookCheckpoint: XL });
    assert(persistedQ && persistedQ.bookCheckpoint === XL, 'the setting is saved');
    g = await studio.request({ prompt: 'portrait of an old fisherman', purpose: 'portrait', from: 'akowe-forge' });
    b = forge.state.lastTxt2img;
    assert(g.ok && b.override_settings && b.override_settings.sd_model_checkpoint === XL && b.width === 832 && b.height === 1216, 'a book portrait uses the chosen checkpoint, at its own portrait size');
    assert(g.settings.checkpoint === XL && g.settings.bookCheckpoint === true, 'the picture records which checkpoint made it');
    g = await studio.generate({ prompt: 'a lighthouse', width: 512, height: 512 }, 'images-tab');
    b = forge.state.lastTxt2img;
    assert(g.ok && !(b.override_settings && b.override_settings.sd_model_checkpoint), 'the Images tab is never switched by the book setting');
    g = await studio.request({ prompt: 'a dragon', purpose: 'portrait', checkpoint: 'dreamshaper_8.safetensors [879db523c3]', from: 'akowe-forge' });
    b = forge.state.lastTxt2img;
    assert(g.ok && b.override_settings.sd_model_checkpoint === 'dreamshaper_8.safetensors [879db523c3]', 'a checkpoint the request names still wins');
    studio.quality({ bookCheckpoint: '' });
  } finally {
    await forge.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
