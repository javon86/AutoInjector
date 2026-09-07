'use strict';
/*
 * output-manager.js — one tidy place on disk for everything the program
 * produces or handles: Documents/AutoInjector/output, broken up by what it is.
 *
 *   output/
 *     books/<book title>/     each bookmaking run gets its own titled folder
 *     images/                 generated images (Stable Diffusion, etc.)
 *     videos/                 generated videos
 *     uploads/                files you attach & send to the AIs
 *     ai-work/                files the AIs make that the app grabs
 *       chatgpt/  claude/  gemini/
 *
 * Kept Electron-free (the root is passed into init) so it's unit-testable; main
 * passes app.getPath('documents'). All names are sanitized to a single safe
 * path segment, and writes never clobber an existing file (they add -1, -2, …).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let _root = null;       // <documents>/AutoInjector/output
let _modelsRoot = null; // <documents>/AutoInjector/models

const CATEGORIES = { books: 'books', images: 'images', videos: 'videos', uploads: 'uploads', aiwork: 'ai-work' };

// One findable home for ALL model assets, so a user never has to hunt for where
// models live: <documents>/AutoInjector/models, split by kind. Each subfolder is
// seeded with a plain README saying what goes there and how to point the matching
// backend at it (Ollama / Stable Diffusion / voice).
const MODEL_CATEGORIES = {
  llm: 'llm',        // local language models (Ollama)
  image: 'image',    // Stable Diffusion checkpoints
  loras: 'loras',    // image LoRAs / embeddings
  video: 'video',    // text-to-video model files (when supported)
  voice: 'voice',    // piper (TTS) + whisper (STT) model files
  assets: 'assets',  // anything else that supports generation
};

/** Point the output folder at <documentsDir>/AutoInjector/output and create it. */
function init(documentsDir) {
  const base = documentsDir && String(documentsDir).trim() ? documentsDir : os.homedir();
  _root = path.join(base, 'AutoInjector', 'output');
  ensureDir(_root);
  _modelsRoot = path.join(base, 'AutoInjector', 'models');
  ensureDir(_modelsRoot);
  for (const seg of Object.values(MODEL_CATEGORIES)) ensureDir(path.join(_modelsRoot, seg));
  seedModelsReadmes();
  return _root;
}
function root() { return _root; }
function modelsRoot() { return _modelsRoot; }
/** The folder for a model category (llm/image/loras/video/voice/assets), created on demand. */
function modelsDir(category) {
  if (!_modelsRoot) throw new Error('output-manager not initialized');
  const seg = MODEL_CATEGORIES[category] || safeName(category, 'misc');
  return ensureDir(path.join(_modelsRoot, seg));
}

// Write a top-level guide plus a per-folder note, once (never clobber edits).
const MODEL_NOTES = {
  '': [
    'AutoInjector — Models & Assets',
    '==============================',
    'This is the one place all model assets live. Put files in the matching',
    'subfolder (or let the app download into it), and point each backend here:',
    '',
    '  llm/     Local language models for the System AI / Butler (Ollama).',
    '           Make Ollama use this folder by setting the environment variable',
    '           OLLAMA_MODELS to this llm/ path (in the Ollama app settings, or',
    '           your shell), then `ollama pull <model>` stores here.',
    '  image/   Stable Diffusion checkpoints (.safetensors). Easiest: install',
    '           Stability Matrix (https://github.com/LykosAI/StabilityMatrix) —',
    '           it installs A1111/ComfyUI + downloads models; set its shared',
    '           Models folder to this models/ folder. Or point A1111 here with',
    '           --ckpt-dir "<this image/ path>".',
    '  loras/   Image LoRAs / embeddings.  A1111:  --lora-dir "<this loras/ path>"',
    '  video/   Text-to-video model files (when supported).',
    '  voice/   piper (TTS .onnx) + whisper (STT) model files. Set the voice',
    '           shim env VOICE_TTS_MODEL / VOICE_STT_MODEL to files in here.',
    '  assets/  Anything else that helps generation.',
    '',
    'The app reads this folder to show you what you have installed.',
  ].join('\n'),
  llm: 'Local language models (Ollama). Set OLLAMA_MODELS to this folder so pulls land here.',
  image: 'Stable Diffusion checkpoints (.safetensors). Easiest: install Stability Matrix (github.com/LykosAI/StabilityMatrix) and point its shared Models folder here; or point A1111 here with --ckpt-dir.',
  loras: 'Image LoRAs / embeddings. Point A1111 here with --lora-dir.',
  video: 'Text-to-video model files (when video generation is supported).',
  voice: 'piper (TTS) and whisper (STT) model files. Point VOICE_TTS_MODEL / VOICE_STT_MODEL here.',
  assets: 'Any other generation assets.',
};
function seedModelsReadmes() {
  try {
    const top = path.join(_modelsRoot, 'README.txt');
    if (!fs.existsSync(top)) fs.writeFileSync(top, MODEL_NOTES['']);
    for (const [key, seg] of Object.entries(MODEL_CATEGORIES)) {
      const note = path.join(_modelsRoot, seg, 'README.txt');
      if (!fs.existsSync(note)) fs.writeFileSync(note, MODEL_NOTES[key] || '');
    }
  } catch (_) { /* best effort — a missing README never blocks the app */ }
}

/** A quick inventory of what's in the models tree (for the UI). */
function modelsInventory() {
  const out = { root: _modelsRoot, categories: {} };
  if (!_modelsRoot) return out;
  for (const [key, seg] of Object.entries(MODEL_CATEGORIES)) {
    try {
      const files = fs.readdirSync(path.join(_modelsRoot, seg)).filter((f) => f !== 'README.txt' && !f.startsWith('.'));
      out.categories[key] = files.length;
    } catch (_) { out.categories[key] = 0; }
  }
  return out;
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
  modelsRoot, modelsDir, modelsInventory,
  saveBuffer, copyInto,
};
