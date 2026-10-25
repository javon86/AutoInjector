// test/sd-library.test.js — the Model & LoRA library, on small synthetic
// .safetensors files (8-byte length + JSON header + a few bytes) and the sidecar
// files Stability Matrix / Civitai Helper / A1111 write. Checks: header-only
// metadata parsing (base model, trigger words, dataset tags), sidecars,
// preview pictures, Stability Matrix folder discovery, user tags / collections /
// locks persisting, base-model mismatch warnings — and that model files are
// NEVER modified. Run: node test/sd-library.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const L = require('../sd-library');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

function writeSafetensors(file, metadata, tensors, tail) {
  const header = Object.assign({}, tensors || { 'w.weight': { dtype: 'F16', shape: [2], data_offsets: [0, 4] } });
  if (metadata) header.__metadata__ = metadata;
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(json.length));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([len, json, tail || Buffer.from([1, 2, 3, 4])]));
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlib-'));
  // A fake Stability Matrix portable install: <SM>/Data/.sm-portable + Data/Models/{StableDiffusion,Lora,LyCORIS,VAE,Embeddings}
  const smData = path.join(tmp, 'home', 'StabilityMatrix', 'Data');
  const M = path.join(smData, 'Models');
  fs.mkdirSync(smData, { recursive: true }); fs.writeFileSync(path.join(smData, '.sm-portable'), '');
  // Checkpoints
  writeSafetensors(path.join(M, 'StableDiffusion', 'dreamshaper_8.safetensors'), { 'modelspec.architecture': 'stable-diffusion-v1', 'modelspec.title': 'DreamShaper 8' });
  writeSafetensors(path.join(M, 'StableDiffusion', 'juggernautXL_v9.safetensors'), null, { 'conditioner.embedders.1.model.ln_final.weight': { dtype: 'F16', shape: [2], data_offsets: [0, 4] } });
  writeSafetensors(path.join(M, 'StableDiffusion', 'ponyDiffusionV6XL.safetensors'), {}, null);
  fs.writeFileSync(path.join(M, 'StableDiffusion', 'ponyDiffusionV6XL.cm-info.json'), JSON.stringify({ ModelId: 257749, ModelName: 'Pony Diffusion V6 XL', VersionName: 'V6', BaseModel: 'Pony', TrainedWords: ['score_9, score_8_up'], Hashes: { SHA256: 'ABC' } }));
  // LoRAs: kohya metadata, Civitai Helper sidecar, A1111 .json, .txt, previews
  writeSafetensors(path.join(M, 'Lora', 'Characters', 'odile_face.safetensors'), {
    ss_base_model_version: 'sd_v1', ss_sd_model_name: 'v1-5-pruned-emaonly.safetensors', ss_output_name: 'odile_face', ss_network_dim: '32',
    ss_tag_frequency: JSON.stringify({ '10_odile': { 'odile woman': 40, 'silver hair': 22, 'green eyes': 18, '1girl': 40 } }),
  }, { 'lora_unet_down_blocks_0_attentions_0_proj_in.lora_down.weight': { dtype: 'F16', shape: [2], data_offsets: [0, 4] } });
  fs.writeFileSync(path.join(M, 'Lora', 'Characters', 'odile_face.civitai.info'), JSON.stringify({ id: 99, modelId: 77, name: 'v1.0', baseModel: 'SD 1.5', trainedWords: ['odile woman'], model: { name: 'Odile', type: 'LORA' } }));
  fs.writeFileSync(path.join(M, 'Lora', 'Characters', 'odile_face.preview.png'), Buffer.from('fakepng'));
  writeSafetensors(path.join(M, 'Lora', 'xl_ink.safetensors'), { 'modelspec.architecture': 'stable-diffusion-xl-v1-base/lora', 'modelspec.trigger_phrase': 'inkwash style' }, { 'lora_te2_text_model_encoder_layers_0_mlp_fc1.lora_up.weight': { dtype: 'F16', shape: [2], data_offsets: [0, 4] } });
  fs.writeFileSync(path.join(M, 'Lora', 'xl_ink.json'), JSON.stringify({ description: 'ink wash', 'sd version': 'SDXL', 'activation text': 'inkwash style, sumi-e', 'preferred weight': 0.6, notes: 'from A1111' }));
  fs.writeFileSync(path.join(M, 'Lora', 'xl_ink.jpg'), Buffer.from('fakejpg'));
  writeSafetensors(path.join(M, 'Lora', 'mystery.safetensors'), null, { 'lora_unet_x.lora_down.weight': { dtype: 'F16', shape: [2], data_offsets: [0, 4] } });
  fs.writeFileSync(path.join(M, 'Lora', 'mystery.txt'), 'blue lantern, glowing\n');
  writeSafetensors(path.join(M, 'LyCORIS', 'flux_detail.safetensors'), { ss_base_model_version: 'flux1' });
  fs.writeFileSync(path.join(M, 'Lora', 'broken.safetensors'), Buffer.from([255, 255, 255, 255, 255, 255, 255, 127, 1, 2])); // absurd header length
  fs.writeFileSync(path.join(M, 'Lora', 'old_style.ckpt'), Buffer.alloc(16));
  writeSafetensors(path.join(M, 'VAE', 'vae-ft-mse-840000.safetensors'), null, { 'decoder.conv_in.weight': { dtype: 'F16', shape: [2], data_offsets: [0, 4] } });
  writeSafetensors(path.join(M, 'Embeddings', 'easynegative.safetensors'), null, { emb_params: { dtype: 'F32', shape: [8, 768], data_offsets: [0, 4] } });
  // A user folder (standalone A1111 layout) added later
  const a1111 = path.join(tmp, 'stable-diffusion-webui');
  writeSafetensors(path.join(a1111, 'models', 'Lora', 'lantern_glow.safetensors'), { ss_base_model_version: 'sdxl_base_v1-0' });
  writeSafetensors(path.join(a1111, 'embeddings', 'bad_hands.safetensors'), null, { clip_g: { dtype: 'F32', shape: [2, 1280], data_offsets: [0, 4] }, clip_l: { dtype: 'F32', shape: [2, 768], data_offsets: [0, 4] } });

  const allModelFiles = [];
  (function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) w(p); else allModelFiles.push(p); } })(tmp);
  const before = new Map(allModelFiles.map((f) => [f, { sha: sha(f), mtime: fs.statSync(f).mtimeMs }]));

  console.log('\n== safetensors header: read only the header ==');
  const h = L.readSafetensorsHeader(path.join(M, 'Lora', 'Characters', 'odile_face.safetensors'));
  assert(h && h.metadata.ss_base_model_version === 'sd_v1' && h.tensorCount === 1, 'header + __metadata__ parsed from 8-byte length + JSON');
  assert(L.readSafetensorsHeader(path.join(M, 'Lora', 'broken.safetensors')) === null, 'an absurd header length is refused (no giant allocation)');
  let readBytes = 0; const realRead = fs.readSync;
  fs.readSync = function (...a) { const n = realRead.apply(fs, a); readBytes += n; return n; };
  const big = path.join(tmp, 'big.safetensors');
  writeSafetensors(big, { ss_base_model_version: 'sd_v1' }, null, Buffer.alloc(3 * 1024 * 1024, 7));
  readBytes = 0; L.readSafetensorsHeader(big);
  fs.readSync = realRead;
  assert(readBytes < 4096, `only the header bytes are read from a 3 MB file (${readBytes} bytes)`);
  fs.unlinkSync(big);

  console.log('\n== base model + trigger words from header and sidecars ==');
  const pm = L.parseHeaderMeta(h.metadata);
  assert(pm.base === 'SD1.5' && pm.baseSource === 'ss_base_model_version', 'ss_base_model_version sd_v1 → SD1.5');
  assert(pm.datasetTags[0] === 'odile woman' || pm.datasetTags[0] === '1girl', 'ss_tag_frequency → most frequent dataset tags');
  assert(pm.datasetTags.includes('silver hair'), 'dataset tags include the rest, by count');
  assert(L.normalizeBase('SDXL 1.0') === 'SDXL' && L.normalizeBase('Pony') === 'Pony' && L.normalizeBase('Illustrious') === 'Illustrious' && L.normalizeBase('Flux.1 D') === 'Flux' && L.normalizeBase('SD 1.5') === 'SD1.5' && L.normalizeBase('sdxl_base_v1-0') === 'SDXL' && L.normalizeBase('stable-diffusion-v1/lora') === 'SD1.5' && L.normalizeBase('SD 3.5') === 'SD3' && L.normalizeBase('sd_v2') === 'SD2', 'normalizeBase understands Civitai, kohya and modelspec labels');
  assert(L.normalizeBase('pixel art') === '', 'normalizeBase does not see "xl" inside ordinary words');
  const sc = L.readSidecars(path.join(M, 'Lora', 'Characters', 'odile_face.safetensors'));
  assert(sc.base === 'SD1.5' && sc.triggers.includes('odile woman') && sc.civitai.modelId === 77 && /odile_face\.preview\.png$/.test(sc.preview), '.civitai.info → base, trigger words, Civitai ids; .preview.png found');
  const xi = L.describeFile(path.join(M, 'Lora', 'xl_ink.safetensors'), 'lora', path.join(M, 'Lora'));
  assert(xi.base === 'SDXL' && xi.triggerWords.includes('inkwash style') && xi.triggerWords.includes('sumi-e') && xi.preferredWeight === 0.6 && /xl_ink\.jpg$/.test(xi.preview), 'A1111 .json: sd version, activation text, preferred weight; modelspec.trigger_phrase merged; .jpg preview');
  const my = L.describeFile(path.join(M, 'Lora', 'mystery.safetensors'), 'lora', path.join(M, 'Lora'));
  assert(my.triggerWords.includes('blue lantern') && my.triggerWords.includes('glowing'), '.txt sidecar → trigger words');
  const pony = L.describeFile(path.join(M, 'StableDiffusion', 'ponyDiffusionV6XL.safetensors'), 'checkpoint', path.join(M, 'StableDiffusion'));
  assert(pony.base === 'Pony' && pony.baseSource === 'cm-info' && pony.triggerWords.includes('score_9') && pony.civitai.sha256 === 'ABC', 'Stability Matrix .cm-info.json → Pony base, trained words, hash');
  const jug = L.describeFile(path.join(M, 'StableDiffusion', 'juggernautXL_v9.safetensors'), 'checkpoint');
  assert(jug.base === 'SDXL' && jug.baseSource === 'tensors', 'no metadata → SDXL guessed from tensor names (conditioner.embedders.1)');
  assert(L.describeFile(path.join(M, 'Lora', 'old_style.ckpt'), 'lora').base === '', '.ckpt files are listed but never unpickled (base unknown)');

  console.log('\n== Stability Matrix discovery + scan ==');
  const env = { APPDATA: path.join(tmp, 'appdata') };
  const smFound = L.findStabilityMatrix({ env, home: path.join(tmp, 'home'), drives: [] });
  assert(smFound.length === 1 && smFound[0].models === M, 'portable Stability Matrix (…/StabilityMatrix/Data/Models) is found under the home folder');
  const lib2dir = path.join(tmp, 'Library2');
  fs.mkdirSync(path.join(lib2dir, 'Models', 'Lora'), { recursive: true });
  fs.mkdirSync(path.join(env.APPDATA, 'StabilityMatrix'), { recursive: true });
  fs.writeFileSync(path.join(env.APPDATA, 'StabilityMatrix', 'library.json'), JSON.stringify({ LibraryPath: lib2dir }));
  const smFound2 = L.findStabilityMatrix({ env, home: path.join(tmp, 'home'), drives: [] });
  assert(smFound2.some((x) => x.models === path.join(lib2dir, 'Models') && x.how === 'library.json'), 'an installed Stability Matrix is found through %APPDATA%\\StabilityMatrix\\library.json');
  fs.writeFileSync(path.join(lib2dir, 'settings.json'), JSON.stringify({ ModelDirectoryOverride: M }));
  assert(L.findStabilityMatrix({ env, home: path.join(tmp, 'nohome'), drives: [] }).some((x) => x.models === M), 'settings.json ModelDirectoryOverride is honoured');
  const ex = L.expandFolder(a1111);
  assert(ex.some((f) => f.kind === 'lora' && f.path === path.join(a1111, 'models', 'Lora')) && ex.some((f) => f.kind === 'embedding'), 'a standalone WebUI folder expands into models/Lora + embeddings');

  const store = path.join(tmp, 'userdata', 'sd-library.json');
  const mk = () => L.createLibrary({ storePath: store, env: {}, findStabilityMatrix: () => [{ models: M }], defaultFolders: [] });
  let lib = mk();
  const scan = lib.scan();
  assert(scan.ok && scan.count >= 10, `scan finds the models (${scan.count})`);
  let all = lib.list({}).items;
  const byName = (n) => all.find((x) => x.name === n);
  assert(byName('odile_face').kind === 'lora' && byName('odile_face').base === 'SD1.5' && byName('odile_face').relPath === path.join('Characters', 'odile_face.safetensors'), 'LoRA in a sub-folder: kind, base, relative path');
  assert(byName('flux_detail').kind === 'lora' && byName('flux_detail').base === 'Flux', 'LyCORIS folder counts as LoRAs; flux1 → Flux');
  assert(byName('vae-ft-mse-840000').kind === 'vae' && byName('easynegative').kind === 'embedding' && byName('dreamshaper_8').kind === 'checkpoint', 'VAE / Embeddings / StableDiffusion folders give the right kinds');
  assert(byName('odile_face').defaultWeight === 0.8 && byName('xl_ink').defaultWeight === 0.6, 'default weight: 0.8, or the sidecar\'s preferred weight');
  assert(!all.some((x) => /preview|civitai/.test(x.file)), 'preview / sidecar files are not listed as models');
  assert(lib.list({ q: 'silver hair' }).items.map((x) => x.name).join() === 'odile_face', 'search matches dataset tags');
  assert(lib.list({ kind: 'lora', base: 'SDXL' }).items.map((x) => x.name).sort().join() === 'xl_ink', 'filter by kind + base');
  assert(lib.list({ q: 'inkwash' }).items[0].name === 'xl_ink', 'search matches trigger words');

  console.log('\n== base-model mismatch warnings ==');
  assert(L.compat('SD1.5', 'SDXL', 'odile_face').level === 'hard' && /won't work/.test(L.compat('SD1.5', 'SDXL', 'odile_face').message), 'SD1.5 LoRA on an SDXL checkpoint → hard warning');
  assert(L.compat('Pony', 'SDXL').level === 'soft' && L.compat('SDXL', 'SDXL').level === 'ok' && L.compat('', 'SDXL').level === 'unknown', 'Pony on SDXL → soft; same → ok; unknown base → no warning');
  const chk = lib.checkLoras([{ name: 'odile_face', weight: 0.8 }, { name: 'xl_ink', weight: 0.6 }], 'juggernautXL_v9.safetensors [c9e3e68f89]');
  assert(chk.checkpointBase === 'SDXL' && chk.warnings.length === 1 && chk.warnings[0].name === 'odile_face' && chk.warnings[0].level === 'hard', 'checkLoras: the SD1.5 LoRA is flagged against the SDXL checkpoint (A1111 title with [hash] understood)');
  const chk2 = lib.checkLoras([{ name: 'xl_ink' }], 'ponyDiffusionV6XL');
  assert(chk2.warnings.length === 1 && chk2.warnings[0].level === 'soft', 'an SDXL LoRA on Pony → a soft warning');
  const lc = lib.list({ kind: 'lora', checkpoint: 'dreamshaper_8' });
  assert(lc.checkpointBase === 'SD1.5' && lc.items.find((x) => x.name === 'xl_ink').compat.level === 'hard' && lc.items.find((x) => x.name === 'odile_face').compat.level === 'ok', 'list({checkpoint}) marks every LoRA ok / wrong-base');

  console.log('\n== your tags, collections, favourites, notes, locks persist ==');
  let u = lib.update('lora:odile_face', { tags: 'face, character', collections: ['Characters', "Odile's look"], favorite: true, defaultWeight: 0.7, notes: 'use with dreamshaper', triggerWords: 'odile woman, silver hair', userBase: '' });
  assert(u.ok && u.item.favorite && u.item.tags.join() === 'face,character' && u.item.collections.includes("Odile's look"), 'update() stores tags / collections / favourite');
  assert(lib.list({}).collections.includes("Odile's look"), 'a new collection name is added to the collection list');
  lib.update('lora:mystery', { userBase: 'SDXL 1.0' });
  lib.addCollection('Lighting'); lib.addCollection('Night');
  lib.renameCollection('Night', 'Night scenes');
  const lk = lib.saveLock({ character: 'Odile', book: "The Lamplighter's Last Ferry", loras: [{ name: 'odile_face', weight: 0.75 }], triggerWords: 'odile woman', prompt: 'short silver hair, green eyes, navy wool coat', negative: 'smiling', checkpoint: 'dreamshaper_8', seed: 1234, width: 512, height: 768 });
  assert(lk.ok && lk.lock.id && lk.lock.loras[0].weight === 0.75 && lk.lock.triggerWords[0] === 'odile woman', 'saveLock() stores a character lock');
  assert(!lib.saveLock({ character: '  ' }).ok, 'a lock needs a character name');
  lib = mk(); // reload from disk
  all = lib.list({}).items; // cached items come back even before a rescan
  const od = all.find((x) => x.name === 'odile_face');
  assert(od && od.favorite && od.defaultWeight === 0.7 && od.notes === 'use with dreamshaper' && od.triggerWords.join() === 'odile woman,silver hair', 'after a restart: favourite, weight, notes, edited trigger words are back');
  assert(od.detectedTriggers.includes('odile woman'), 'the detected trigger words are kept alongside the edited ones');
  assert(all.find((x) => x.name === 'mystery').base === 'SDXL', 'a base-model override persists');
  assert(lib.list({ collection: "Odile's look" }).items.map((x) => x.name).join() === 'odile_face' && lib.list({ favorite: true }).items.length === 1 && lib.list({ tag: 'face' }).items.length === 1, 'filter by collection / favourite / tag after the restart');
  assert(lib.list({}).collections.includes('Night scenes') && !lib.list({}).collections.includes('Night'), 'renamed collection persisted');
  const lock = lib.getLock('odile');
  assert(lock && lock.book === "The Lamplighter's Last Ferry" && lib.getLock(lock.id).character === 'Odile', 'the lock is found by character name (any case) or id after the restart');
  const ap = lib.applyLock(lock, { prompt: 'standing on the ferry at dusk', negativePrompt: 'blurry' });
  assert(ap.prompt === 'odile woman, short silver hair, green eyes, navy wool coat, standing on the ferry at dusk' && ap.negativePrompt === 'smiling, blurry', 'applyLock: trigger words + fixed bits + the scene, negatives merged');
  assert(ap.loras[0].name === 'odile_face' && ap.seed === 1234 && ap.checkpoint === 'dreamshaper_8' && ap.width === 512 && ap.height === 768, 'applyLock carries the LoRA, seed, checkpoint and size');
  lib.deleteCollection('Characters');
  assert(!lib.get('lora:odile_face').collections.includes('Characters'), 'deleting a collection removes it from items');
  assert(lib.deleteLock(lock.id).removed === 1 && !lib.getLock('Odile'), 'deleteLock()');
  assert(!lib.update('nonsense', { favorite: true }).ok, 'update() refuses an id that is not kind:name');

  console.log('\n== user folders + backend lists ==');
  assert(!lib.addFolder(path.join(tmp, 'nope')).ok, 'adding a missing folder is refused with a message');
  assert(lib.addFolder(a1111).ok, 'add a standalone WebUI folder');
  lib.scan();
  all = lib.list({}).items;
  assert(all.some((x) => x.name === 'lantern_glow' && x.kind === 'lora' && x.base === 'SDXL'), 'its models/Lora is scanned');
  assert(all.some((x) => x.name === 'bad_hands' && x.kind === 'embedding' && x.base === 'SDXL'), 'its embeddings/ folder is scanned (clip_g/clip_l → SDXL embedding)');
  assert(lib.folders().some((f) => f.source === 'added by you'), 'folders() shows where each folder came from');
  lib.mergeBackend({ ok: true, checkpoints: [{ name: 'dreamshaper_8.safetensors [879db523c3]', model_name: 'dreamshaper_8', file: path.join(M, 'StableDiffusion', 'dreamshaper_8.safetensors') }], loras: [{ name: 'odile_face', file: '' }, { name: 'only_in_comfy', file: '' }], vaes: ['Automatic'], embeddings: [] });
  all = lib.list({}).items;
  assert(all.find((x) => x.name === 'odile_face').inBackend && !all.find((x) => x.name === 'xl_ink').inBackend, 'items the SD app reports are marked inBackend');
  assert(all.some((x) => x.name === 'only_in_comfy' && !x.onDisk && x.inBackend), 'a LoRA only the SD app knows (e.g. on another drive) is still listed');
  assert(lib.removeFolder(a1111).removed === 1, 'removeFolder()');
  const rescan = lib.scan();
  assert(rescan.reread === 0 || rescan.reread < rescan.count, `a rescan re-reads only changed files (re-read ${rescan.reread} of ${rescan.count})`);

  console.log('\n== model files were never modified ==');
  let untouched = true;
  for (const [f, b] of before) { if (!fs.existsSync(f)) { untouched = false; break; } if (sha(f) !== b.sha || fs.statSync(f).mtimeMs !== b.mtime) { untouched = false; console.log('    changed:', f); } }
  assert(untouched, 'every model file and sidecar is byte-for-byte unchanged (same hash and mtime)');
  const created = [];
  (function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) w(p); else if (!before.has(p)) created.push(p); } })(tmp);
  assert(created.every((p) => p.startsWith(path.join(tmp, 'userdata')) || p.startsWith(lib2dir) || p.startsWith(env.APPDATA)), 'nothing new was written next to the models — only AutoInjector\'s own sd-library.json');
  assert(JSON.parse(fs.readFileSync(store, 'utf8')).version === 1, 'the library is one JSON file in AutoInjector\'s data folder');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
