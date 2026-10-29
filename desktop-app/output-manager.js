'use strict';
/*
 * output-manager.js — ONE findable folder that holds everything the program
 * downloads or creates, each kind in its own subfolder. It lives right inside
 * the AutoInjector app folder so it sits next to the program:
 *
 *   <AutoInjector app folder>/stuff and thing/  <- the one place, easy to spot
 *     books/<book title>/     each bookmaking run gets its own titled folder
 *     images/                 generated images (Stable Diffusion, etc.)
 *     videos/                 generated videos
 *     uploads/                files you attach & send to the AIs
 *     ai-work/                files the AIs make that the app grabs
 *       chatgpt/  claude/  gemini/
 *     logs/                   Extract-All text dumps
 *     models/                 EVERYTHING downloaded, split by kind:
 *       llm/  image/  loras/  video/  voice/  assets/
 *
 * So creations sit at the top of "stuff and thing" and downloads sit under its
 * models/ subfolder — one folder to open, appropriate subfolders inside.
 *
 * Kept Electron-free (the root is passed into init) so it's unit-testable; main
 * passes app.getPath('documents'). All names are sanitized to a single safe
 * path segment, and writes never clobber an existing file (they add -1, -2, …).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// The single, deliberately-distinctive folder name the user picked so it stands
// out in their file list. Everything the app touches on disk lives under here.
const STUFF_FOLDER = 'stuff and thing';

let _root = null;       // <AutoInjector app folder>/stuff and thing  (creations)
let _modelsRoot = null; // <AutoInjector app folder>/stuff and thing/models (downloads)

const CATEGORIES = { books: 'books', images: 'images', videos: 'videos', uploads: 'uploads', aiwork: 'ai-work', workflows: 'workflows' };

// One findable home for ALL model assets, so a user never has to hunt for where
// models live: <stuff and thing>/models, split by kind. These folder names are FIXED
// (the Stability Matrix transfer and the ComfyUI / Forge settings use them). Each
// folder is seeded with a plain README: what goes here, and the matching Stability
// Matrix (Data\Models) folder name.
//   key → { rel: path under models/ ('/'-separated), label, sm: Stability Matrix folder(s), what }
const MODEL_FOLDERS = [
  { key: 'llm', rel: 'llm', label: '🤖 AI models (Ollama)', sm: '', what: 'Local language models for the System AI / Butler (Ollama). Set OLLAMA_MODELS to this folder so pulls land here.' },
  { key: 'image', rel: 'image', label: '🎨 Picture models (checkpoints)', sm: 'StableDiffusion', what: 'Stable Diffusion checkpoints (.safetensors / .ckpt): SD 1.5, SDXL, Pony, Flux… AutoInjector starts Forge / A1111 with this folder (--ckpt-dir) and ComfyUI reads it as "checkpoints".' },
  { key: 'loras', rel: 'loras', label: '🎨 LoRAs', sm: 'Lora', what: 'Image LoRAs (.safetensors). Forge / A1111 get --lora-dir; ComfyUI reads it as "loras" (sub-folders too).' },
  { key: 'lycoris', rel: 'loras/lycoris', label: '🎨 LyCORIS (LoCon / LoHa)', sm: 'LyCORIS', what: 'LyCORIS / LoCon / LoHa files. They work like LoRAs and are found from here (it is inside loras/).' },
  { key: 'vae', rel: 'vae', label: '🎨 VAEs', sm: 'VAE', what: 'VAE files (.safetensors / .pt) that fix colours. Forge / A1111 get --vae-dir; ComfyUI reads it as "vae".' },
  { key: 'vae_approx', rel: 'vae/approx', label: '🎨 Preview VAEs (approx / TAESD)', sm: 'ApproxVAE (A1111: VAE-approx, VAE-taesd)', what: 'The small preview decoders (model.pt, taesd_decoder.pth, taesdxl_decoder.pth). ComfyUI reads it as "vae_approx". Not full VAEs — never pick these as the VAE.' },
  { key: 'embeddings', rel: 'embeddings', label: '🎨 Embeddings (textual inversion)', sm: 'Embeddings', what: 'Embeddings / textual inversions (.pt / .safetensors), e.g. negative embeddings. Forge / A1111 get --embeddings-dir; ComfyUI reads it as "embeddings".' },
  { key: 'controlnet', rel: 'controlnet', label: '🎨 ControlNet models', sm: 'ControlNet (also T2IAdapter)', what: 'ControlNet / T2I-Adapter models. Forge gets --controlnet-dir; ComfyUI reads it as "controlnet".' },
  { key: 'upscale', rel: 'upscale', label: '🎨 Upscalers', sm: 'ESRGAN, RealESRGAN, SwinIR, ScuNET, BSRGAN, LDSR, upscale_models', what: 'Upscaler models (4x-UltraSharp, RealESRGAN, SwinIR…). Forge / A1111 get --esrgan-models-path; ComfyUI reads it as "upscale_models".' },
  { key: 'text_encoders', rel: 'text_encoders', label: '🎨 Text encoders (CLIP / T5 / Qwen)', sm: 'TextEncoders (A1111: text_encoder, SD.Next: CLIP; ComfyUI: clip)', what: 'Text encoders that newer models need (clip_l, t5xxl, qwen_2.5_vl…). Forge gets --text-encoder-dir; ComfyUI reads it as "text_encoders" and "clip".' },
  { key: 'diffusion_models', rel: 'diffusion_models', label: '🎨 Diffusion models (UNET only: Flux, Qwen Image Edit…)', sm: 'DiffusionModels / diffusion_models (SD.Next: UNET)', what: 'Model files that are only the diffusion part (no VAE / text encoder inside), e.g. Qwen Image Edit, Flux dev fp8. ComfyUI reads it as "diffusion_models" and "unet"; Forge Neo also lists them with the checkpoints.' },
  { key: 'clip_vision', rel: 'clip_vision', label: '🎨 CLIP vision', sm: 'ClipVision', what: 'CLIP vision encoders (for IP-Adapter, Redux…). ComfyUI reads it as "clip_vision".' },
  { key: 'ipadapter', rel: 'ipadapter', label: '🎨 IP-Adapters', sm: 'IpAdapter, IpAdapters15, IpAdaptersXl', what: 'IP-Adapter models ("use this face / style"). ComfyUI (IPAdapter plus) reads it as "ipadapter".' },
  { key: 'detectors', rel: 'detectors', label: '🎨 Detectors', sm: '', what: 'Face / hand / person finders used to fix faces after the picture is made (ADetailer, Impact Pack).' },
  { key: 'ultralytics', rel: 'detectors/ultralytics', label: '🎨 Detectors: YOLO (ultralytics)', sm: 'Ultralytics', what: 'YOLO detector models. Put box detectors in bbox/ and segment detectors in segm/.' },
  { key: 'ultralytics_bbox', rel: 'detectors/ultralytics/bbox', label: '🎨 Detectors: YOLO boxes', sm: 'Ultralytics\\bbox', what: 'Box detectors such as face_yolov8m.pt and hand_yolov8s.pt. ComfyUI (Impact Pack) reads it as "ultralytics_bbox".' },
  { key: 'ultralytics_segm', rel: 'detectors/ultralytics/segm', label: '🎨 Detectors: YOLO outlines', sm: 'Ultralytics\\segm', what: 'Segment detectors such as person_yolov8m-seg.pt. ComfyUI (Impact Pack) reads it as "ultralytics_segm".' },
  { key: 'sams', rel: 'detectors/sams', label: '🎨 Detectors: SAM', sm: 'Sams', what: 'Segment Anything models such as sam_vit_b_01ec64.pth. ComfyUI (Impact Pack) reads it as "sams".' },
  { key: 'faces', rel: 'faces', label: '🎨 Face tools (swap / restore)', sm: 'insightface, Codeformer, GFPGAN (and ReActor\'s models\\insightface)', what: 'Face swap and face restore models: inswapper_128.onnx (insightface), CodeFormer, GFPGAN. ComfyUI reads it as "insightface" and "facerestore_models"; Forge / A1111 get --codeformer-models-path / --gfpgan-models-path when those files are here.' },
  { key: 'video', rel: 'video', label: '🎬 Video models', sm: 'SVD (other video models)', what: 'Text-to-video / picture-to-video model files.' },
  { key: 'framepack', rel: 'video/framepack/hf', label: '🎬 FramePack models (HunyuanVideo)', sm: 'Packages\\FramePack\\hf_download (put its "hub" folder in here)', what: 'FramePack\'s Hugging Face download cache: the whole "hub" folder from Stability Matrix\'s Packages\\FramePack\\hf_download goes in here (hf/hub/models--…). 🎬 Video uses them for its FramePack engine (with your FramePack from Stability Matrix) — nothing is downloaded.' },
  { key: 'voice', rel: 'voice', label: '🔊 Voice models', sm: '', what: 'piper (TTS) and whisper (STT) model files. Point VOICE_TTS_MODEL / VOICE_STT_MODEL here.' },
  { key: 'assets', rel: 'assets', label: '📦 Other assets', sm: '', what: 'Any other generation assets.' },
];
const MODEL_CATEGORIES = Object.fromEntries(MODEL_FOLDERS.map((f) => [f.key, f.rel]));
// Files that count as a "model" when the app looks for what is in a folder.
const MODEL_FILE_RE = /\.(safetensors|ckpt|pt|pth|bin|gguf|onnx|sft)$/i;

/**
 * Point everything at <appFolder>/stuff and thing and create it. main.js passes
 * the AutoInjector app folder (path.join(__dirname, '..')), so the folder sits
 * right inside the program, e.g. …/GitHub/AutoInjector/stuff and thing.
 */
function init(appFolder) {
  const base = appFolder && String(appFolder).trim() ? appFolder : os.homedir();
  _root = path.join(base, STUFF_FOLDER);
  ensureDir(_root);
  // Downloads live in a models/ subfolder INSIDE the one findable folder.
  _modelsRoot = path.join(_root, 'models');
  ensureDir(_modelsRoot);
  for (const rel of Object.values(MODEL_CATEGORIES)) ensureDir(path.join(_modelsRoot, ...rel.split('/')));
  ensureDir(path.join(_root, CATEGORIES.workflows));
  seedModelsReadmes();
  return _root;
}
function root() { return _root; }
function modelsRoot() { return _modelsRoot; }
/** The folder for a model category (llm/image/loras/video/voice/assets), created on demand. */
function modelsDir(category) {
  if (!_modelsRoot) throw new Error('output-manager not initialized');
  const rel = MODEL_CATEGORIES[category];
  return ensureDir(rel ? path.join(_modelsRoot, ...rel.split('/')) : path.join(_modelsRoot, safeName(category, 'misc')));
}
/** The path of a model folder without creating it (null before init / for an unknown key). */
function modelsPath(category) {
  const rel = MODEL_CATEGORIES[category];
  return _modelsRoot && rel ? path.join(_modelsRoot, ...rel.split('/')) : null;
}
/** The folder for ComfyUI workflow .json files: <stuff and thing>/workflows. */
function workflowsDir() { return dir('workflows'); }

// A plain-language guide for the whole "stuff and thing" folder, written once at
// its root so anyone opening it understands the layout at a glance.
const STUFF_NOTE = [
  'AutoInjector — "stuff and thing"',
  '================================',
  'This is the ONE folder for everything the app downloads or creates. Open it',
  'from the app (System AI panel -> Downloads & creations -> Open folder). Layout:',
  '',
  '  CREATED BY THE APP (top level):',
  '    books/    finished books, one titled folder per run',
  '    images/   generated images (Stable Diffusion, etc.)',
  '    videos/   generated videos',
  '    uploads/  files you attached and sent to the AIs',
  '    ai-work/  files the AIs produced that the app grabbed',
  '    logs/     "Extract All" text dumps',
  '',
  '  PROGRAMS THE APP INSTALLS FOR YOU (inside apps/):',
  '    apps/comfyui/   ComfyUI (pictures + video) with its own models/ folder',
  '    apps/ollama/    Ollama, when the app installed it itself',
  '',
  '  INSTALLERS + UNFINISHED DOWNLOADS: downloads/ (safe to empty when nothing is downloading)',
  '',
  '  DOWNLOADED (inside models/) — the same kinds as Stability Matrix\'s Data\\Models:',
  ...MODEL_FOLDERS.map((f) => `    models/${f.rel}/`.padEnd(40) + f.label.replace(/^\S+\s/, '')),
  '',
  '  COMFYUI WORKFLOWS: workflows/  (.json files; the 🎨 Images tab lists them)',
  '',
  'See models/README.txt for how to point each backend (Ollama / A1111 /',
  'Stability Matrix / voice) at these folders.',
  '',
  'Where this folder is gets remembered outside the app folder, so a new copy of',
  'AutoInjector keeps using it (nothing has to be downloaded again). The app lists',
  'every place it uses under: More settings -> Downloads & creations -> Where everything is.',
].join('\n');

// Write a top-level guide plus a per-folder note, once (never clobber edits).
const MODEL_NOTES = {
  '': [
    'AutoInjector — Models & downloads',
    '=================================',
    'This is the one place all downloaded model assets live. Put files in the',
    'matching subfolder (or let the app download into it). The names match',
    'Stability Matrix\'s Data\\Models folders like this:',
    '',
    ...MODEL_FOLDERS.map((f) => `  ${(f.rel + '/').padEnd(30)}${f.sm ? `<- Stability Matrix: ${f.sm}` : f.label.replace(/^\S+\s/, '')}`),
    '',
    'How the programs use these folders:',
    '  • Forge / A1111 / SD.Next started by AutoInjector get these folders on their',
    '    command line (--ckpt-dir, --lora-dir, --vae-dir, --embeddings-dir…), only the',
    '    ones the program understands. Your own Launch Options always win.',
    '  • ComfyUI reads them through an "autoinjector_stuff:" section in its',
    '    extra_model_paths.yaml (AutoInjector adds it; your other sections are kept).',
    '  • llm/: make Ollama use it by setting OLLAMA_MODELS to this llm/ path, then',
    '    `ollama pull <model>` stores here.',
    '  • Or point A1111 here yourself with --ckpt-dir "<this image/ path>".',
    '  • voice/: set the voice shim env VOICE_TTS_MODEL / VOICE_STT_MODEL to files in here.',
    '',
    'The app reads this folder to show you what you have (More settings ->',
    'Downloads & creations -> 📦 Your models).',
  ].join('\n'),
};
for (const f of MODEL_FOLDERS) {
  MODEL_NOTES[f.key] = [`${f.label.replace(/^\S+\s/, '')} — models/${f.rel}/`, '', f.what, f.sm ? `\nThe matching Stability Matrix folder${/^Packages/.test(f.sm) ? '' : ' (in Data\\Models)'}: ${f.sm}` : ''].join('\n').trim() + '\n';
}
const WORKFLOWS_NOTE = 'ComfyUI workflows (.json). Put workflow files here (e.g. from Stability Matrix\'s Data\\Workflows). The 🎨 Images tab → ComfyUI workflow lists them; ones saved with ComfyUI\'s "Export (API)" can be run from AutoInjector, the others open in ComfyUI.\n';
function seedModelsReadmes() {
  try {
    // A guide for the whole "stuff and thing" folder at its root…
    const rootReadme = path.join(_root, 'README.txt');
    if (!fs.existsSync(rootReadme)) fs.writeFileSync(rootReadme, STUFF_NOTE);
    // …and one for the downloads (models/) subfolder.
    const top = path.join(_modelsRoot, 'README.txt');
    if (!fs.existsSync(top)) fs.writeFileSync(top, MODEL_NOTES['']);
    for (const [key, rel] of Object.entries(MODEL_CATEGORIES)) {
      const note = path.join(_modelsRoot, ...rel.split('/'), 'README.txt');
      if (!fs.existsSync(note)) fs.writeFileSync(note, MODEL_NOTES[key] || '');
    }
    const wf = path.join(_root, CATEGORIES.workflows, 'README.txt');
    if (!fs.existsSync(wf)) fs.writeFileSync(wf, WORKFLOWS_NOTE);
  } catch (_) { /* best effort — a missing README never blocks the app */ }
}

// Count the model files in one folder (sub-folders too, but not the ones that are their own
// model folder, e.g. loras/ does not count loras/lycoris/). Bounded, never throws.
function countModelFiles(dirPath, skipDirs, cap = 20000) {
  let files = 0, bytes = 0, seen = 0;
  const skip = new Set((skipDirs || []).map((p) => path.resolve(p).toLowerCase()));
  const walk = (p, depth) => {
    if (seen > cap || depth > 8) return;
    let ents; try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (++seen > cap) return;
      if (e.name === 'README.txt' || e.name.startsWith('.')) continue;
      const full = path.join(p, e.name);
      if (e.isDirectory()) { if (!skip.has(path.resolve(full).toLowerCase())) walk(full, depth + 1); continue; }
      if (!e.isFile()) continue;
      files++;
      try { bytes += fs.statSync(full).size; } catch (_) {}
    }
  };
  walk(dirPath, 0);
  return { files, bytes };
}
function childFolders(f) { return MODEL_FOLDERS.filter((o) => o !== f && o.rel.startsWith(f.rel + '/')).map((o) => path.join(_modelsRoot, ...o.rel.split('/'))); }

/**
 * A quick inventory of what's in the models tree (for the UI, Alfred and "📦 Your models"):
 * categories: { key: file count } (as before) and folders: [{ key, rel, label, sm, path, files, bytes }].
 */
function modelsInventory() {
  const out = { root: _modelsRoot, categories: {}, folders: [], workflows: 0 };
  if (!_modelsRoot) return out;
  for (const f of MODEL_FOLDERS) {
    const p = path.join(_modelsRoot, ...f.rel.split('/'));
    const c = f.key === 'llm'
      ? (() => { try { return { files: fs.readdirSync(p).filter((n) => n !== 'README.txt' && !n.startsWith('.')).length, bytes: 0 }; } catch (_) { return { files: 0, bytes: 0 }; } })()
      : countModelFiles(p, childFolders(f));
    out.categories[f.key] = c.files;
    out.folders.push({ key: f.key, rel: f.rel, label: f.label, sm: f.sm, path: p, files: c.files, bytes: c.bytes });
  }
  try { out.workflows = fs.readdirSync(path.join(_root, CATEGORIES.workflows)).filter((n) => /\.json$/i.test(n)).length; } catch (_) { out.workflows = 0; }
  return out;
}

/**
 * The model folders that hold at least one model file → { key: absolute path }. sd-runner passes
 * these to Forge / A1111 / SD.Next; an empty folder is never passed.
 */
function modelDirsWithFiles(keys) {
  const out = {};
  if (!_modelsRoot) return out;
  for (const f of MODEL_FOLDERS) {
    if (keys && !keys.includes(f.key)) continue;
    if (['llm', 'voice', 'assets', 'detectors', 'video'].includes(f.key)) continue;
    const p = path.join(_modelsRoot, ...f.rel.split('/'));
    if (hasModelFile(p, f.key === 'loras' ? childFolders(f) : [])) out[f.key] = p;
  }
  return out;
}
function hasModelFile(dirPath, skipDirs, depth = 0) {
  if (depth > 6) return false;
  const skip = new Set((skipDirs || []).map((p) => path.resolve(p).toLowerCase()));
  let ents; try { ents = fs.readdirSync(dirPath, { withFileTypes: true }); } catch (_) { return false; }
  for (const e of ents) if (e.isFile() && MODEL_FILE_RE.test(e.name)) return true;
  for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.') && !skip.has(path.resolve(path.join(dirPath, e.name)).toLowerCase()) && hasModelFile(path.join(dirPath, e.name), skipDirs, depth + 1)) return true;
  return false;
}

/** The folders the Model & LoRA library scans in "stuff and thing" ({ path, kind, source }). */
function libraryFolders() {
  if (!_modelsRoot) return [];
  const src = 'AutoInjector ("stuff and thing")';
  return [['image', 'checkpoint'], ['loras', 'lora'], ['vae', 'vae'], ['embeddings', 'embedding']]
    .map(([k, kind]) => ({ path: path.join(_modelsRoot, ...MODEL_CATEGORIES[k].split('/')), kind, source: src }));
}

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (_) {} return p; }

/** Reduce any string to one safe path segment (no separators, no traversal). */
function safeName(name, fallback) {
  let s = String(name == null ? '' : name);
  s = s.replace(/[\/\\]+/g, ' ')          // no path separators
       .replace(/\.{2,}/g, ' ')            // no ".." traversal
       .replace(/[\x00-\x1f<>:"|?*]+/g, '') // no control / illegal chars
       .replace(/\s+/g, ' ')
       .trim()
       .replace(/^\.+/, '')                // no leading dots (hidden / current dir)
       .slice(0, 120)
       .trim();
  return s || fallback || 'untitled';
}

/** The folder for a category (created on demand). */
function dir(category) {
  if (!_root) throw new Error('output-manager not initialized');
  const seg = CATEGORIES[category] || safeName(category, 'misc');
  return ensureDir(path.join(_root, seg));
}
function booksDir() { return dir('books'); }
function bookDir(title) { return ensureDir(path.join(dir('books'), safeName(title, 'untitled-book'))); }
function imagesDir() { return dir('images'); }
function videosDir() { return dir('videos'); }
function uploadsDir() { return dir('uploads'); }
function aiWorkDir(site) { return ensureDir(path.join(dir('aiwork'), safeName(site, 'unknown'))); }
/** The logs folder (output/logs) — where "Extract All" writes its text dumps. */
function logsDir() { return dir('logs'); }

/** A non-clobbering destination path inside destDir for `filename`. */
function uniquePath(destDir, filename) {
  const base = safeName(filename, 'file');
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length) || 'file';
  let candidate = path.join(destDir, base);
  let i = 1;
  while (fs.existsSync(candidate)) { candidate = path.join(destDir, `${stem}-${i}${ext}`); i += 1; }
  return candidate;
}

/** Write a Buffer/string into destDir under a safe, unique name. Returns the path. */
function saveBuffer(destDir, filename, data) {
  ensureDir(destDir);
  const dest = uniquePath(destDir, filename);
  fs.writeFileSync(dest, data);
  return dest;
}

/** Copy an existing file into destDir under a safe, unique name. Returns the path. */
function copyInto(destDir, srcPath, filename) {
  ensureDir(destDir);
  const dest = uniquePath(destDir, filename || path.basename(srcPath));
  fs.copyFileSync(srcPath, dest);
  return dest;
}

module.exports = {
  init, root, dir, safeName, uniquePath,
  booksDir, bookDir, imagesDir, videosDir, uploadsDir, aiWorkDir, logsDir,
  modelsRoot, modelsDir, modelsPath, modelsInventory, modelDirsWithFiles, libraryFolders, workflowsDir, countModelFiles,
  MODEL_FOLDERS, MODEL_CATEGORIES, MODEL_FILE_RE,
  saveBuffer, copyInto,
};
