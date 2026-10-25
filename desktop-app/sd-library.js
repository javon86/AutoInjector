'use strict';
/*
 * sd-library.js — the Model & LoRA library ("organize lores").
 *
 * Finds the user's Stable Diffusion files (Stability Matrix's shared
 * Data/Models folders, a standalone A1111/Forge/ComfyUI install, AutoInjector's
 * own models/ folder, folders the backend reports, folders the user adds) and,
 * for every checkpoint / LoRA / VAE / embedding, works out:
 *   name, file, size, base model (SD1.5 / SD2 / SDXL / Pony / Illustrious /
 *   NoobAI / SD3 / Flux), trigger words, dataset tags, preview picture —
 * from the safetensors HEADER ONLY (8-byte length + JSON; the weights are never
 * read) and from the sidecar files Stability Matrix, Civitai Helper and A1111
 * write next to the model (.cm-info.json, .civitai.info, .json, .txt,
 * .preview.png/.jpg…).
 *
 * On top the user keeps their own organisation — tags, collections
 * ("Characters", "Styles", "Odile's look"…), favourite, default weight, notes,
 * base-model override — and "character locks": a LoRA + trigger words + fixed
 * prompt bits tied to a book character, for the same face every time (used by
 * the bridge's /image/request so Akọwe can ask for portraits and covers).
 *
 * Everything is stored in ONE JSON file in AutoInjector's own data folder.
 * Model files are only ever opened read-only; nothing is written next to them.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODEL_EXT = new Set(['.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf']);
const PREVIEW_EXT = ['.preview.png', '.preview.jpg', '.preview.jpeg', '.preview.webp', '.png', '.jpg', '.jpeg', '.webp'];
const KINDS = ['checkpoint', 'lora', 'vae', 'embedding'];
const MAX_HEADER = 64 * 1024 * 1024; // a sane safetensors header is a few hundred KB
const MAX_SIDECAR = 4 * 1024 * 1024;
const MAX_FILES = 20000;

// Folder name → what lives in it (Stability Matrix, A1111/Forge, ComfyUI, ours).
const FOLDER_KINDS = {
  stablediffusion: 'checkpoint', 'stable-diffusion': 'checkpoint', checkpoints: 'checkpoint', ckpt: 'checkpoint', image: 'checkpoint',
  lora: 'lora', loras: 'lora', lycoris: 'lora', locon: 'lora',
  vae: 'vae',
  embeddings: 'embedding', textualinversion: 'embedding', embedding: 'embedding',
};
function kindForFolderName(name) { return FOLDER_KINDS[String(name || '').toLowerCase()] || null; }

// ------------------------------------------------------------ header reading
// Read just the safetensors header. Returns { metadata, tensors(names→{shape,dtype}), tensorCount } or null.
function readSafetensorsHeader(file, opts = {}) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd);
    if (st.size < 8) return null;
    const lenBuf = Buffer.alloc(8);
    if (fs.readSync(fd, lenBuf, 0, 8, 0) !== 8) return null;
    const n = Number(lenBuf.readBigUInt64LE(0));
    const cap = opts.maxHeader || MAX_HEADER;
    if (!Number.isFinite(n) || n <= 1 || n > cap || n > st.size - 8) return null;
    const buf = Buffer.alloc(n);
    let off = 0;
    while (off < n) { const got = fs.readSync(fd, buf, off, n - off, 8 + off); if (got <= 0) break; off += got; }
    if (off !== n) return null;
    const j = JSON.parse(buf.toString('utf8').replace(/\s+$/, ''));
    if (!j || typeof j !== 'object') return null;
    const metadata = j.__metadata__ && typeof j.__metadata__ === 'object' ? j.__metadata__ : {};
    delete j.__metadata__;
    const names = Object.keys(j);
    return { metadata, tensors: j, tensorNames: names, tensorCount: names.length };
  } catch { return null; }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }
}

function _readText(file) {
  try { const st = fs.statSync(file); if (!st.isFile() || st.size > MAX_SIDECAR) return null; return fs.readFileSync(file, 'utf8'); } catch { return null; }
}
function _readJson(file) { const t = _readText(file); if (t == null) return null; try { return JSON.parse(t.replace(/^﻿/, '')); } catch { return null; } }

// ------------------------------------------------------------- base models
// Any label (Civitai "SDXL 1.0", "Pony", kohya "sdxl_base_v1-0", modelspec
// "stable-diffusion-xl-v1-base/lora", A1111 "SD1") → one short family name.
function normalizeBase(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (!s) return '';
  if (/pony/.test(s)) return 'Pony';
  if (/illustrious/.test(s)) return 'Illustrious';
  if (/noob/.test(s)) return 'NoobAI';
  if (/flux/.test(s)) return 'Flux';
  if (/sd[\s_-]?3|stable-diffusion-3|sd3\.5/.test(s)) return 'SD3';
  if (/sdxl|stable-diffusion-xl|xl(?![a-z])/.test(s)) return 'SDXL';
  if (/sd[\s_-]?v?2|stable-diffusion-v2|\b2\.[01]\b/.test(s)) return 'SD2';
  if (/sd[\s_-]?v?1|stable-diffusion-v1|\b1\.[45]\b|^sd1$/.test(s)) return 'SD1.5';
  return '';
}
const ARCH = { 'SD1.5': 'sd1', SD2: 'sd2', SDXL: 'sdxl', Pony: 'sdxl', Illustrious: 'sdxl', NoobAI: 'sdxl', SD3: 'sd3', Flux: 'flux' };
function archOf(base) { return ARCH[base] || ''; }

// Does a LoRA (or embedding) fit the checkpoint? → { level: ok|soft|hard|unknown, message }
function compat(itemBase, ckptBase, itemName) {
  const a = archOf(itemBase), b = archOf(ckptBase);
  const nm = itemName ? `“${itemName}” ` : 'This LoRA ';
  if (!a || !b) return { level: 'unknown', message: '' };
  if (a !== b) return { level: 'hard', message: `${nm}was made for ${itemBase}, but the checkpoint is ${ckptBase} — it won't work (no effect, garbage, or an error). Pick a ${itemBase} checkpoint or a ${ckptBase} LoRA.` };
  if (itemBase !== ckptBase) return { level: 'soft', message: `${nm}was made for ${itemBase}; on a ${ckptBase} checkpoint it usually works but can look off.` };
  return { level: 'ok', message: '' };
}

// Guess from tensor names when the metadata says nothing.
function baseFromTensors(names, kind) {
  const n = names || [];
  const has = (re) => n.some((k) => re.test(k));
  if (has(/double_blocks|single_blocks|single_transformer_blocks|transformer_blocks\.\d+\.attn\.add_q_proj/)) return 'Flux';
  if (has(/joint_blocks/)) return 'SD3';
  if (kind === 'lora') {
    if (has(/^lora_te2_|^lora_te_2|text_encoder_2|lora_unet_input_blocks_\d+_1_transformer_blocks_[2-9]/)) return 'SDXL';
    if (has(/^lora_te_text_model|^lora_unet_down_blocks|^lora_te1_/) && !has(/^lora_te2_/)) return 'SD1.5';
    return '';
  }
  if (kind === 'embedding') {
    if (has(/^clip_g$|^clip_l$/)) return 'SDXL';
    return '';
  }
  if (has(/^conditioner\.embedders\.1\./)) return 'SDXL';
  if (has(/^cond_stage_model\.model\./)) return 'SD2';
  if (has(/^cond_stage_model\.transformer\./)) return 'SD1.5';
  return '';
}
function baseFromName(name) {
  const s = String(name || '').toLowerCase();
  if (/pony/.test(s)) return 'Pony';
  if (/illustrious|\bill?xl/.test(s)) return 'Illustrious';
  if (/noob/.test(s)) return 'NoobAI';
  if (/flux/.test(s)) return 'Flux';
  if (/sd3/.test(s)) return 'SD3';
  if (/sdxl|xl(?![a-z])/.test(s)) return 'SDXL';
  if (/sd15|sd1\.5|sd_1\.5|v1-5/.test(s)) return 'SD1.5';
  return '';
}
// Guess kind from tensors (for user folders whose name says nothing).
function kindFromTensors(names, size) {
  const n = names || [];
  if (n.some((k) => /lora_down|lora_up|lora_A|lora_B|\.alpha$|hada_w1|lokr_w1|oft_/.test(k))) return 'lora';
  if (n.length && n.length <= 4 && size < 2 * 1024 * 1024) return 'embedding';
  if (n.some((k) => /^(decoder|encoder)\.(conv_in|mid)/.test(k)) && !n.some((k) => /diffusion_model|double_blocks/.test(k))) return 'vae';
  return 'checkpoint';
}

function _splitWords(s) {
  return String(s || '').split(/[,\n]/).map((x) => x.trim()).filter((x) => x && x.length <= 120);
}
function _uniq(arr) { const seen = new Set(); const out = []; for (const x of arr) { const k = String(x).toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(x); } } return out; }

// Header metadata → facts.
function parseHeaderMeta(meta) {
  const m = meta || {};
  const out = { base: '', baseSource: '', triggers: [], datasetTags: [], title: '', facts: {} };
  const baseCands = [
    [m['modelspec.architecture'], 'modelspec'],
    [`${m.ss_base_model_version || ''} ${m.ss_sd_model_name || ''}`.trim(), 'ss_base_model_version'],
    [m.ss_v2 === 'True' ? 'sd_v2' : '', 'ss_v2'],
  ];
  // A Pony / Illustrious model name beats a plain "sdxl" version string.
  const fam = normalizeBase(m.ss_sd_model_name);
  if (fam && ['Pony', 'Illustrious', 'NoobAI'].includes(fam)) { out.base = fam; out.baseSource = 'ss_sd_model_name'; }
  for (const [v, src] of baseCands) { if (out.base) break; const b = normalizeBase(v); if (b) { out.base = b; out.baseSource = src; } }
  if (m['modelspec.trigger_phrase']) out.triggers.push(..._splitWords(m['modelspec.trigger_phrase']));
  if (m.ss_tag_frequency) {
    try {
      const tf = typeof m.ss_tag_frequency === 'string' ? JSON.parse(m.ss_tag_frequency) : m.ss_tag_frequency;
      const counts = {};
      for (const ds of Object.values(tf || {})) for (const [tag, c] of Object.entries(ds || {})) { const t = tag.trim(); if (t) counts[t] = (counts[t] || 0) + (Number(c) || 0); }
      out.datasetTags = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t]) => t);
    } catch { /* malformed — ignore */ }
  }
  out.title = m['modelspec.title'] || m.ss_output_name || '';
  for (const k of ['ss_network_dim', 'ss_network_alpha', 'ss_resolution', 'ss_num_epochs', 'modelspec.author', 'modelspec.description', 'modelspec.resolution', 'ss_sd_model_name']) if (m[k]) out.facts[k] = String(m[k]).slice(0, 300);
  return out;
}

// Sidecar files next to a model (Stability Matrix, Civitai Helper, A1111).
function readSidecars(file) {
  const dir = path.dirname(file);
  const ext = path.extname(file);
  const stem = path.basename(file, ext);
  const p = (suffix) => path.join(dir, stem + suffix);
  const out = { base: '', baseSource: '', triggers: [], title: '', civitai: null, preferredWeight: null, notes: '', preview: null, sources: [], negative: '' };
  const cm = _readJson(p('.cm-info.json'));
  if (cm) {
    out.sources.push('cm-info');
    const b = normalizeBase(cm.BaseModel); if (b && !out.base) { out.base = b; out.baseSource = 'cm-info'; }
    if (Array.isArray(cm.TrainedWords)) out.triggers.push(...cm.TrainedWords.flatMap(_splitWords));
    out.title = [cm.ModelName, cm.VersionName].filter(Boolean).join(' — ');
    out.civitai = { modelId: cm.ModelId || null, versionId: cm.VersionId || null, sha256: (cm.Hashes && cm.Hashes.SHA256) || '' };
  }
  const ci = _readJson(p('.civitai.info'));
  if (ci) {
    out.sources.push('civitai.info');
    const b = normalizeBase(ci.baseModel); if (b && !out.base) { out.base = b; out.baseSource = 'civitai.info'; }
    if (Array.isArray(ci.trainedWords)) out.triggers.push(...ci.trainedWords.flatMap(_splitWords));
    if (!out.title) out.title = [ci.model && ci.model.name, ci.name].filter(Boolean).join(' — ');
    if (!out.civitai) out.civitai = { modelId: ci.modelId || (ci.model && ci.model.id) || null, versionId: ci.id || null, sha256: '' };
  }
  const a1 = _readJson(p('.json'));
  if (a1 && typeof a1 === 'object' && !Array.isArray(a1)) {
    out.sources.push('json');
    const b = normalizeBase(a1['sd version'] || a1.sd_version || a1.baseModel); if (b && !out.base) { out.base = b; out.baseSource = 'json'; }
    if (a1['activation text']) out.triggers.push(..._splitWords(a1['activation text']));
    if (Array.isArray(a1.trainedWords)) out.triggers.push(...a1.trainedWords.flatMap(_splitWords));
    const w = Number(a1['preferred weight']); if (Number.isFinite(w) && w !== 0) out.preferredWeight = w;
    if (a1.notes) out.notes = String(a1.notes).slice(0, 2000);
    if (a1['negative text']) out.negative = String(a1['negative text']).slice(0, 1000);
    if (!out.title && a1.description) out.title = String(a1.description).slice(0, 120);
  }
  const txt = _readText(p('.txt'));
  if (txt && txt.trim()) { out.sources.push('txt'); out.triggers.push(..._splitWords(txt.slice(0, 1000))); }
  for (const pe of PREVIEW_EXT) { const f = p(pe); try { if (fs.statSync(f).isFile()) { out.preview = f; break; } } catch {} }
  out.triggers = _uniq(out.triggers);
  return out;
}

// One model file → a library item (no user data yet).
function describeFile(file, kindHint, folderRoot) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  const ext = path.extname(file).toLowerCase();
  const stem = path.basename(file, path.extname(file));
  const hdr = ext === '.safetensors' ? readSafetensorsHeader(file) : null;
  const kind = kindHint || (hdr ? kindFromTensors(hdr.tensorNames, st.size) : (st.size < 2 * 1024 * 1024 ? 'embedding' : 'checkpoint'));
  const hm = hdr ? parseHeaderMeta(hdr.metadata) : { base: '', baseSource: '', triggers: [], datasetTags: [], title: '', facts: {} };
  const sc = readSidecars(file);
  let base = sc.base, baseSource = sc.baseSource;
  if (!base && hm.base) { base = hm.base; baseSource = hm.baseSource; }
  if (!base && hdr) { const b = baseFromTensors(hdr.tensorNames, kind); if (b) { base = b; baseSource = 'tensors'; } }
  if (!base) { const b = baseFromName(stem); if (b) { base = b; baseSource = 'filename'; } }
  const rel = folderRoot ? path.relative(folderRoot, file) : path.basename(file);
  return {
    id: itemId(kind, stem), kind, name: stem, file, relPath: rel, folder: folderRoot || path.dirname(file), ext, size: st.size, mtime: Math.round(st.mtimeMs),
    base, baseSource, triggerWords: _uniq([...sc.triggers, ...hm.triggers]), datasetTags: hm.datasetTags, title: sc.title || hm.title || '',
    civitai: sc.civitai, preferredWeight: sc.preferredWeight, sidecarNotes: sc.notes, suggestedNegative: sc.negative, preview: sc.preview,
    metaSources: [...(hdr ? ['header'] : []), ...sc.sources], facts: hm.facts, headerOk: !!hdr, onDisk: true, inBackend: false,
  };
}
function itemId(kind, name) { return `${kind}:${String(name || '').replace(/\\/g, '/').split('/').pop().replace(/\.(safetensors|ckpt|pt|pth|bin|gguf)$/i, '').toLowerCase()}`; }

// Walk one folder (bounded depth / count) → [{file, kind}].
function walk(root, kind, opts = {}) {
  const out = [];
  const maxDepth = opts.maxDepth == null ? 5 : opts.maxDepth;
  const stack = [[root, 0]];
  while (stack.length && out.length < MAX_FILES) {
    const [dir, depth] = stack.pop();
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < maxDepth && !e.name.startsWith('.')) stack.push([full, depth + 1]); continue; }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!MODEL_EXT.has(ext)) continue;
      if (/\.(preview|civitai)\./i.test(e.name)) continue;
      out.push({ file: full, kind });
    }
  }
  return out;
}

// A folder the user points at may be a typed folder (…/Lora), a Models root
// (Stability Matrix Data/Models), or a whole WebUI / ComfyUI install. Expand it
// into typed folders.
function expandFolder(p, kind) {
  const out = [];
  if (!p) return out;
  if (kind && kind !== 'auto') return [{ path: p, kind }];
  const own = kindForFolderName(path.basename(p));
  if (own) return [{ path: p, kind: own }];
  const tryRoots = [p, path.join(p, 'models'), path.join(p, 'Models'), path.join(p, 'Data', 'Models')];
  const seen = new Set();
  for (const r of tryRoots) {
    let ents; try { ents = fs.readdirSync(r, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const k = kindForFolderName(e.name);
      const full = path.join(r, e.name);
      if (k && !seen.has(full.toLowerCase())) { seen.add(full.toLowerCase()); out.push({ path: full, kind: k }); }
    }
  }
  // A1111 keeps embeddings at the install root.
  const emb = path.join(p, 'embeddings');
  try { if (fs.statSync(emb).isDirectory() && !seen.has(emb.toLowerCase())) out.push({ path: emb, kind: 'embedding' }); } catch {}
  return out.length ? out : [{ path: p, kind: 'auto' }];
}

// --------------------------------------------------- Stability Matrix finder
// Where Stability Matrix keeps its shared models on this PC (portable "Data"
// next to the exe, or the library dir recorded in %APPDATA%\StabilityMatrix\library.json;
// settings.json can override the Models folder).
function findStabilityMatrix(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const libs = [];
  const addLib = (p, how) => { if (p && !libs.some((l) => l.path.toLowerCase() === String(p).toLowerCase())) libs.push({ path: p, how }); };
  const appDataHomes = [];
  if (env.APPDATA) appDataHomes.push(path.join(env.APPDATA, 'StabilityMatrix'));
  appDataHomes.push(path.join(home, '.config', 'StabilityMatrix'), path.join(home, 'Library', 'Application Support', 'StabilityMatrix'));
  for (const h of appDataHomes) {
    const lj = _readJson(path.join(h, 'library.json'));
    if (lj && lj.LibraryPath) addLib(lj.LibraryPath, 'library.json');
  }
  const drives = opts.drives || (process.platform === 'win32' ? ['C:', 'D:', 'E:', 'F:'] : []);
  const portable = [
    path.join(home, 'StabilityMatrix', 'Data'), path.join(home, 'Downloads', 'StabilityMatrix', 'Data'), path.join(home, 'Desktop', 'StabilityMatrix', 'Data'),
    path.join(home, 'Documents', 'StabilityMatrix', 'Data'), path.join(home, 'Downloads', 'StabilityMatrix-win-x64', 'Data'),
    ...drives.flatMap((d) => [path.join(d + path.sep, 'StabilityMatrix', 'Data'), path.join(d + path.sep, 'AI', 'StabilityMatrix', 'Data'), path.join(d + path.sep, 'StabilityMatrix')]),
    ...appDataHomes, env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'StabilityMatrix') : null,
  ].filter(Boolean);
  for (const p of portable) addLib(p, 'common place');
  const found = [];
  for (const l of libs) {
    const settings = _readJson(path.join(l.path, 'settings.json')) || {};
    const models = settings.ModelDirectoryOverride || path.join(l.path, 'Models');
    try { if (fs.statSync(models).isDirectory()) found.push({ library: l.path, models, how: l.how }); } catch {}
  }
  return found;
}

// ------------------------------------------------------------- the library
function createLibrary(opts = {}) {
  const storePath = opts.storePath;
  const env = opts.env || process.env;
  const defaultFolders = typeof opts.defaultFolders === 'function' ? opts.defaultFolders : () => (opts.defaultFolders || []);
  let db = null;
  let items = new Map(); // id → item (scan result)
  let lastScan = null;
  let backendFolders = []; // folders learned from the backend (A1111 reports full paths)
  let backendNames = { checkpoint: [], lora: [], vae: [], embedding: [] };

  function blank() { return { version: 1, folders: [], collections: ['Characters', 'Styles', 'Lighting'], user: {}, locks: [], cache: {} }; }
  function load() {
    if (db) return db;
    db = blank();
    if (storePath) {
      const j = _readJson(storePath);
      if (j && typeof j === 'object') db = Object.assign(blank(), j);
    }
    for (const k of ['folders', 'collections', 'locks']) if (!Array.isArray(db[k])) db[k] = blank()[k];
    if (!db.user || typeof db.user !== 'object') db.user = {};
    if (!db.cache || typeof db.cache !== 'object') db.cache = {};
    // Rebuild items from the cache so the list shows instantly at start.
    for (const c of Object.values(db.cache)) if (c && c.item && c.item.id) items.set(c.item.id + '|' + c.item.file, c.item);
    return db;
  }
  function save() {
    if (!storePath) return;
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const tmp = `${storePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
      fs.renameSync(tmp, storePath);
    } catch (e) { if (opts.log) opts.log('sd-library-save-failed', { error: String(e) }); }
  }

  // All folders to scan: Stability Matrix + defaults + backend-reported + the user's.
  function folders() {
    load();
    const out = [];
    const add = (p, kind, source) => {
      if (!p) return;
      for (const f of expandFolder(p, kind)) {
        if (!out.some((o) => o.path.toLowerCase() === f.path.toLowerCase())) out.push({ path: f.path, kind: f.kind, source, exists: fs.existsSync(f.path) });
      }
    };
    for (const sm of (opts.findStabilityMatrix || findStabilityMatrix)({ env })) add(sm.models, 'auto', 'Stability Matrix');
    if (env.AUTOINJECTOR_SD_MODEL_DIRS) for (const p of String(env.AUTOINJECTOR_SD_MODEL_DIRS).split(path.delimiter)) add(p.trim(), 'auto', 'environment');
    for (const d of defaultFolders()) add(d.path, d.kind || 'auto', d.source || 'AutoInjector');
    for (const d of backendFolders) add(d.path, d.kind, 'your SD app');
    for (const d of db.folders) add(d.path, d.kind || 'auto', 'added by you');
    return out;
  }
  function addFolder(p, kind) {
    load();
    const clean = String(p || '').trim();
    if (!clean) return { ok: false, error: 'NO_PATH', message: 'Choose a folder first.' };
    let isDir = false; try { isDir = fs.statSync(clean).isDirectory(); } catch {}
    if (!isDir) return { ok: false, error: 'NOT_A_FOLDER', message: `That folder doesn't exist: ${clean}` };
    if (!db.folders.some((f) => f.path.toLowerCase() === clean.toLowerCase())) db.folders.push({ path: clean, kind: KINDS.includes(kind) ? kind : 'auto' });
    save();
    return { ok: true, folders: folders() };
  }
  function removeFolder(p) {
    load();
    const before = db.folders.length;
    db.folders = db.folders.filter((f) => f.path.toLowerCase() !== String(p || '').toLowerCase());
    save();
    return { ok: true, removed: before - db.folders.length, folders: folders() };
  }

  // Scan every folder. Cached by file+size+mtime so a rescan only re-reads new
  // or changed headers.
  function scan() {
    load();
    const t0 = Date.now();
    const fresh = new Map();
    const newCache = {};
    let reread = 0;
    for (const f of folders()) {
      if (!f.exists) continue;
      for (const w of walk(f.path, f.kind === 'auto' ? null : f.kind)) {
        let st; try { st = fs.statSync(w.file); } catch { continue; }
        const key = w.file;
        const c = db.cache[key];
        let it;
        if (c && c.size === st.size && c.mtime === Math.round(st.mtimeMs) && c.item && c.sideStamp === _sideStamp(w.file)) it = c.item;
        else { it = describeFile(w.file, w.kind, f.path); reread++; }
        if (!it) continue;
        it.source = f.source;
        newCache[key] = { size: st.size, mtime: Math.round(st.mtimeMs), sideStamp: _sideStamp(w.file), item: it };
        fresh.set(it.id + '|' + it.file, it);
      }
    }
    items = fresh;
    db.cache = newCache;
    lastScan = { at: Date.now(), ms: Date.now() - t0, count: fresh.size, reread };
    db.lastScan = lastScan;
    save();
    return Object.assign({ ok: true }, lastScan, { folders: folders() });
  }
  // Sidecars change when Stability Matrix fetches Civitai info — fold their mtimes into the cache key.
  function _sideStamp(file) {
    const dir = path.dirname(file); const stem = path.basename(file, path.extname(file));
    let s = 0;
    for (const suf of ['.cm-info.json', '.civitai.info', '.json', '.txt', ...PREVIEW_EXT]) { try { s += Math.round(fs.statSync(path.join(dir, stem + suf)).mtimeMs) % 1e9; } catch {} }
    return s;
  }

  // What the connected backend says it has (names), plus folders it reveals.
  function mergeBackend(lists) {
    if (!lists || !lists.ok) return;
    backendNames = {
      checkpoint: (lists.checkpoints || []).map((c) => c.model_name || c.name),
      lora: (lists.loras || []).map((l) => l.name),
      vae: (lists.vaes || []).filter((v) => !/^(automatic|none)$/i.test(v)),
      embedding: (lists.embeddings || []).map((e) => e.name),
    };
    const dirs = [];
    const roots = (arr, kind) => { for (const x of arr || []) if (x && x.file) { const d = path.dirname(x.file); if (!dirs.some((o) => o.path === d)) dirs.push({ path: d, kind }); } };
    roots(lists.checkpoints, 'checkpoint'); roots(lists.loras, 'lora');
    // Keep only the top-most folder per kind (sub-folders are walked anyway).
    backendFolders = dirs.filter((d) => !dirs.some((o) => o !== d && o.kind === d.kind && d.path.toLowerCase().startsWith(o.path.toLowerCase() + path.sep)));
    // Seed A1111's own LoRA metadata into items (it already parsed the headers).
    for (const l of lists.loras || []) {
      const it = [...items.values()].find((x) => x.kind === 'lora' && x.id === itemId('lora', l.name));
      if (it && !it.base && l.metadata) { const hm = parseHeaderMeta(l.metadata); if (hm.base) { it.base = hm.base; it.baseSource = 'backend'; } }
    }
  }

  function _user(id) { load(); return db.user[id] || {}; }
  function decorate(it) {
    const u = _user(it.id);
    const base = u.userBase || it.base || '';
    const names = backendNames[it.kind] || [];
    const inBackend = names.some((n) => itemId(it.kind, n) === it.id);
    return Object.assign({}, it, {
      base, baseDetected: it.base || '', arch: archOf(base), inBackend: inBackend || !!it.inBackend,
      tags: u.tags || [], collections: u.collections || [], favorite: !!u.favorite, notes: u.notes || '',
      defaultWeight: u.defaultWeight != null ? u.defaultWeight : (it.preferredWeight != null ? it.preferredWeight : (it.kind === 'lora' ? 0.8 : null)),
      triggerWords: u.userTriggers && u.userTriggers.length ? u.userTriggers : (it.triggerWords || []),
      detectedTriggers: it.triggerWords || [], userBase: u.userBase || '',
    });
  }
  // Items the backend lists that we never found on disk (e.g. ComfyUI on another drive).
  function backendOnly() {
    const out = [];
    for (const kind of KINDS) for (const n of backendNames[kind] || []) {
      const id = itemId(kind, n);
      if ([...items.values()].some((x) => x.id === id) || out.some((x) => x.id === id)) continue;
      const stem = String(n).replace(/\\/g, '/').split('/').pop().replace(/\.(safetensors|ckpt|pt|pth|bin|gguf)$/i, '').replace(/\s*\[[0-9a-f]{6,}\]$/i, '');
      out.push({ id: itemId(kind, stem), kind, name: stem, file: '', relPath: n, size: 0, base: baseFromName(stem), baseSource: baseFromName(stem) ? 'filename' : '', triggerWords: [], datasetTags: [], title: '', preview: null, onDisk: false, inBackend: true, metaSources: ['backend'] });
    }
    return out;
  }

  // Search + filter. q matches name/title/tags/triggers/collections/notes.
  function list(f = {}) {
    load();
    let all = [...items.values(), ...backendOnly()].map(decorate);
    if (f.kind) all = all.filter((x) => x.kind === f.kind);
    if (f.base) all = all.filter((x) => (f.base === 'unknown' ? !x.base : x.base === f.base));
    if (f.collection) all = all.filter((x) => x.collections.includes(f.collection));
    if (f.tag) all = all.filter((x) => x.tags.includes(f.tag));
    if (f.favorite) all = all.filter((x) => x.favorite);
    if (f.q) {
      const words = String(f.q).toLowerCase().split(/\s+/).filter(Boolean);
      all = all.filter((x) => {
        const hay = [x.name, x.title, x.base, x.relPath, ...x.tags, ...x.collections, ...x.triggerWords, ...(x.datasetTags || []), x.notes].join(' ').toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    let compatWith = null;
    if (f.checkpoint) {
      const ck = findItem('checkpoint', f.checkpoint);
      compatWith = (ck && ck.base) || baseFromName(f.checkpoint) || '';
    }
    for (const x of all) x.compat = compatWith && x.kind !== 'checkpoint' && x.kind !== 'vae' ? compat(x.base, compatWith, x.name) : { level: 'unknown', message: '' };
    all.sort((a, b) => (b.favorite - a.favorite) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const limit = f.limit || 2000;
    return { ok: true, items: all.slice(0, limit), total: all.length, collections: db.collections.slice(), tags: allTags(), lastScan: lastScan || db.lastScan || null, checkpointBase: compatWith || '' };
  }
  function allTags() { const s = new Set(); for (const u of Object.values(db.user)) for (const t of (u && u.tags) || []) s.add(t); return [...s].sort(); }
  function findItem(kind, nameOrId) {
    if (!nameOrId) return null;
    const raw = String(nameOrId).replace(/\s*\[[0-9a-f]{6,}\]$/i, '');
    const id = raw.includes(':') && KINDS.includes(raw.split(':')[0]) ? raw.toLowerCase() : itemId(kind, raw);
    const it = [...items.values()].find((x) => x.id === id) || backendOnly().find((x) => x.id === id);
    return it ? decorate(it) : null;
  }
  function get(id) { const k = String(id || '').split(':')[0]; return findItem(KINDS.includes(k) ? k : 'lora', id); }

  // The user's own fields. Never touches the model file.
  function update(id, patch) {
    load();
    if (!id || !KINDS.includes(String(id).split(':')[0])) return { ok: false, error: 'BAD_ID' };
    const u = Object.assign({}, db.user[id] || {});
    const p = patch || {};
    const strList = (v) => _uniq((Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean)).slice(0, 50);
    if ('tags' in p) u.tags = strList(p.tags);
    if ('collections' in p) { u.collections = strList(p.collections); for (const c of u.collections) if (!db.collections.includes(c)) db.collections.push(c); }
    if ('favorite' in p) u.favorite = !!p.favorite;
    if ('notes' in p) u.notes = String(p.notes || '').slice(0, 4000);
    if ('defaultWeight' in p) { const n = Number(p.defaultWeight); u.defaultWeight = p.defaultWeight === null || p.defaultWeight === '' || !Number.isFinite(n) ? undefined : Math.max(-5, Math.min(5, n)); }
    if ('userBase' in p) u.userBase = normalizeBase(p.userBase) || '';
    if ('triggerWords' in p) u.userTriggers = strList(p.triggerWords);
    db.user[id] = u;
    save();
    return { ok: true, item: get(id) || Object.assign({ id }, u) };
  }

  function addCollection(name) { load(); const n = String(name || '').trim().slice(0, 60); if (!n) return { ok: false, error: 'NO_NAME' }; if (!db.collections.includes(n)) db.collections.push(n); save(); return { ok: true, collections: db.collections.slice() }; }
  function renameCollection(from, to) {
    load(); const t = String(to || '').trim().slice(0, 60); if (!t) return { ok: false, error: 'NO_NAME' };
    db.collections = _uniq(db.collections.map((c) => (c === from ? t : c)));
    for (const u of Object.values(db.user)) if (u && u.collections) u.collections = _uniq(u.collections.map((c) => (c === from ? t : c)));
    save(); return { ok: true, collections: db.collections.slice() };
  }
  function deleteCollection(name) {
    load(); db.collections = db.collections.filter((c) => c !== name);
    for (const u of Object.values(db.user)) if (u && u.collections) u.collections = u.collections.filter((c) => c !== name);
    save(); return { ok: true, collections: db.collections.slice() };
  }

  // ---- character locks
  function listLocks() { load(); return { ok: true, locks: db.locks.map((l) => Object.assign({}, l)) }; }
  function getLock(idOrName) {
    load();
    const k = String(idOrName || '').trim().toLowerCase();
    if (!k) return null;
    return db.locks.find((l) => l.id === idOrName) || db.locks.find((l) => String(l.character || '').toLowerCase() === k || String(l.name || '').toLowerCase() === k) || null;
  }
  function saveLock(lock) {
    load();
    const l = lock || {};
    const character = String(l.character || l.name || '').trim().slice(0, 120);
    if (!character) return { ok: false, error: 'NO_NAME', message: 'Give the character a name.' };
    const id = l.id && db.locks.some((x) => x.id === l.id) ? l.id : `lock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const clean = {
      id, character, book: String(l.book || '').slice(0, 200),
      loras: (Array.isArray(l.loras) ? l.loras : []).filter((x) => x && x.name).slice(0, 8).map((x) => ({ name: String(x.name), weight: Number.isFinite(Number(x.weight)) ? Number(x.weight) : 0.8 })),
      triggerWords: (Array.isArray(l.triggerWords) ? l.triggerWords : _splitWords(l.triggerWords)).map(String).slice(0, 30),
      prompt: String(l.prompt || '').slice(0, 2000), negative: String(l.negative || '').slice(0, 2000),
      checkpoint: String(l.checkpoint || ''), seed: Number.isFinite(Number(l.seed)) ? Math.round(Number(l.seed)) : -1,
      width: Number(l.width) > 0 ? Math.round(Number(l.width)) : null, height: Number(l.height) > 0 ? Math.round(Number(l.height)) : null,
      notes: String(l.notes || '').slice(0, 2000), updatedAt: Date.now(),
    };
    const i = db.locks.findIndex((x) => x.id === id);
    if (i >= 0) db.locks[i] = clean; else db.locks.push(clean);
    save();
    return { ok: true, lock: clean };
  }
  function deleteLock(id) { load(); const n = db.locks.length; db.locks = db.locks.filter((l) => l.id !== id); save(); return { ok: true, removed: n - db.locks.length }; }

  // A character lock + a scene description → generate() options.
  function applyLock(lockOrId, scene = {}) {
    const lock = typeof lockOrId === 'object' && lockOrId ? lockOrId : getLock(lockOrId);
    if (!lock) return null;
    const bits = [...(lock.triggerWords || []), lock.prompt, scene.prompt].map((s) => String(s || '').trim()).filter(Boolean);
    const out = {
      prompt: bits.join(', '),
      negativePrompt: [lock.negative, scene.negativePrompt].filter(Boolean).join(', '),
      loras: lock.loras || [],
    };
    if (lock.checkpoint) out.checkpoint = lock.checkpoint;
    if (lock.seed != null && lock.seed >= 0 && scene.keepSeed !== false) out.seed = lock.seed;
    if (lock.width) out.width = lock.width;
    if (lock.height) out.height = lock.height;
    return out;
  }

  // Base-model check for a set of LoRAs against a checkpoint.
  function checkLoras(loras, checkpoint) {
    const ck = findItem('checkpoint', checkpoint);
    const ckBase = (ck && ck.base) || baseFromName(checkpoint || '');
    const warnings = [];
    for (const l of loras || []) {
      const it = findItem('lora', l.name);
      if (!it) continue;
      const c = compat(it.base, ckBase, it.name);
      if (c.level === 'hard' || c.level === 'soft') warnings.push({ name: it.name, level: c.level, message: c.message });
    }
    return { checkpointBase: ckBase || '', warnings };
  }

  // A small preview picture (for the renderer), read only if it is an image file and not huge.
  function previewPath(id) { const it = get(id); return it && it.preview ? it.preview : null; }

  return { load, save, folders, addFolder, removeFolder, scan, mergeBackend, list, get, findItem, update, addCollection, renameCollection, deleteCollection, listLocks, getLock, saveLock, deleteLock, applyLock, checkLoras, previewPath, _db: () => db };
}

module.exports = {
  createLibrary, readSafetensorsHeader, parseHeaderMeta, readSidecars, describeFile, normalizeBase, archOf, compat, baseFromTensors, baseFromName,
  kindForFolderName, kindFromTensors, expandFolder, walk, findStabilityMatrix, itemId, KINDS,
};
