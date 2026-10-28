'use strict';
/*
 * folders.js — ONE tidy folder system. Everything AutoInjector installs or downloads lives inside
 * "stuff and thing" (whose place is remembered outside the app folder — content-home.js):
 *
 *   stuff and thing/
 *     apps/         programs AutoInjector installs for you
 *       comfyui/      ComfyUI (Stable Diffusion pictures + Wan video) — with its own models/ inside
 *       ollama/       Ollama, when AutoInjector installed it itself (Linux / no-admin installs)
 *     models/       models: llm/ (Ollama) image/ loras/ video/ voice/ assets/
 *     downloads/    installers and unfinished downloads (safe to empty when nothing is downloading)
 *     images/ videos/ books/ uploads/ ai-work/ logs/   what you make
 *
 * Settings stay where the system keeps program settings (they survive a reinstall); Ollama's own app and
 * Stability Matrix keep their own folders. map() lists every place, so nothing is a mystery.
 *
 * An existing ComfyUI from before (%LOCALAPPDATA%\AutoInjector\comfyui) keeps working where it is until you press
 * "Move into stuff and thing" (moveComfy): a rename on the same drive (instant), else a copy then delete.
 * Electron-free; fs injectable; never throws.
 */
const nodeFs = require('fs');
const path = require('path');

/** The layout under one "stuff and thing" folder. */
function layout(stuffDir) {
  const j = (...p) => path.join(stuffDir, ...p);
  return { stuff: stuffDir, apps: j('apps'), comfyHome: j('apps', 'comfyui'), ollamaApp: j('apps', 'ollama'), downloads: j('downloads'), models: j('models'), llm: j('models', 'llm') };
}

/** Is there a ComfyUI install in this folder (the Windows portable, or a plain ComfyUI checkout)? */
function hasComfy(dir, fs = nodeFs) {
  if (!dir || /\.partial$/i.test(String(dir))) return false;
  return hasComfyFiles(dir, fs);
}
function hasComfyFiles(dir, fs = nodeFs) {
  const at = (...p) => { try { return fs.existsSync(path.join(dir, ...p)); } catch (_) { return false; } };
  if (at('ComfyUI', 'main.py')) return true;
  let ents = []; try { ents = fs.readdirSync(dir); } catch (_) { return false; }
  // A half-finished copy ("<name>.partial") is never an install.
  return ents.some((n) => !/\.partial$/i.test(n) && at(n, 'ComfyUI', 'main.py'));
}

/**
 * Where ComfyUI lives: an explicit setting wins; else inside "stuff and thing" (apps/comfyui); an install made
 * before in the old place is kept working there until it is moved. Very long folder paths on Windows (the
 * portable's Python has deep folders; Windows' 260-character limit) fall back to the short old place.
 * -> { home, where: 'setting'|'stuff'|'legacy'|'legacy-long-path', legacy }
 */
function pickComfyHome({ stuffDir, legacyHome, envHome, platform = process.platform, fs = nodeFs } = {}) {
  if (envHome) return { home: envHome, where: 'setting', legacy: legacyHome };
  const L = layout(stuffDir);
  if (hasComfy(L.comfyHome, fs)) return { home: L.comfyHome, where: 'stuff', legacy: legacyHome };
  if (legacyHome && hasComfy(legacyHome, fs)) return { home: legacyHome, where: 'legacy', legacy: legacyHome };
  if (platform === 'win32' && L.comfyHome.length > 110) return { home: legacyHome, where: 'legacy-long-path', legacy: legacyHome };
  return { home: L.comfyHome, where: 'stuff', legacy: legacyHome };
}

function sizeOf(dir, fs = nodeFs, cap = 40000) {
  let bytes = 0, seen = 0;
  const walk = (p, depth) => {
    if (seen > cap || depth > 12) return;
    let ents; try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (++seen > cap) return;
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full, depth + 1); else if (e.isFile()) { try { bytes += fs.statSync(full).size; } catch (_) {} }
    }
  };
  walk(dir, 0);
  return { bytes, partial: seen > cap };
}

/**
 * Every place AutoInjector keeps something, in plain words.
 * places: { stuffDir, comfy:{home,where,legacy}, userData, ollamaStore, akoweData, stabilityMatrix }
 */
function map(places, { fs = nodeFs, sizes = true } = {}) {
  const L = layout(places.stuffDir);
  const rows = [];
  const exists = (p) => { try { return !!p && fs.existsSync(p); } catch (_) { return false; } };
  const add = (what, p, inStuff, note) => { if (!p) return; const r = { what, path: p, exists: exists(p), inStuff: !!inStuff, note: note || '' }; if (sizes && r.exists) r.bytes = sizeOf(p, fs).bytes; rows.push(r); };
  add('📁 "stuff and thing" — everything below lives here', L.stuff, true, 'Remembered by the app, so a new copy of AutoInjector keeps using it.');
  add('🤖 AI models (Ollama)', L.llm, true);
  for (const [k, label] of [['image', '🎨 Picture models'], ['loras', '🎨 LoRAs'], ['video', '🎬 Video models'], ['voice', '🔊 Voice models']]) add(label, path.join(L.models, k), true);
  const c = places.comfy || {};
  if (c.home) add('🧩 ComfyUI (pictures + video) and its models', c.home, c.where === 'stuff' || c.where === 'setting' && c.home.startsWith(L.stuff),
    c.where === 'legacy' ? 'Installed before the tidy-up, outside "stuff and thing" — press "Move into stuff and thing".' : c.where === 'legacy-long-path' ? 'Kept in the short system folder: this PC\'s path to "stuff and thing" is too long for ComfyUI on Windows.' : '');
  add('⬇ Installers and unfinished downloads', L.downloads, true, 'Safe to empty when nothing is downloading.');
  for (const [k, label] of [['images', '🖼 Your pictures'], ['videos', '🎬 Your videos'], ['books', '📚 Your books'], ['logs', '🧾 Logs and reports']]) add(label, path.join(L.stuff, k), true);
  add('⚙ Settings (the system\'s place for program settings — survives reinstalling)', places.userData, false);
  if (places.ollamaStore && exists(places.ollamaStore)) add('🤖 Models downloaded with Ollama\'s own app', places.ollamaStore, false, 'Ollama\'s own folder — AutoInjector can use these too (🔍 Find what\'s installed).');
  if (places.akoweData && exists(places.akoweData)) add('📖 Akọwe\'s book database', places.akoweData, false, 'Akọwe\'s working data; saved books go into "stuff and thing/books".');
  if (places.stabilityMatrix && exists(places.stabilityMatrix)) add('🎨 Stability Matrix (Forge etc.)', places.stabilityMatrix, false, 'Stability Matrix\'s own folder — its programs stay there.');
  return rows;
}

/**
 * Is ComfyUI busy, so its folder must not be moved? sd-runner's status() reports a `phase` (idle / starting /
 * running / restarting / waiting / failed / stopped); anything but idle/failed/stopped means its files may be open.
 * A running A1111/Forge (kind 'a1111') doesn't use the ComfyUI folder. The installer downloading / unpacking into
 * it counts too.
 */
const COMFY_ACTIVE = new Set(['starting', 'running', 'restarting', 'waiting']);
function comfyInUse(runner, installer) {
  const r = runner || {};
  const kind = String(r.kind || (r.target && r.target.kind) || '');
  const runBusy = (COMFY_ACTIVE.has(r.phase) || !!r.busy || !!r.ready) && !/a1111|forge|fooocus/i.test(kind);
  const inst = installer || {};
  const instBusy = !!inst.busy && (inst.phase === 'downloading' || inst.phase === 'extracting');
  return runBusy || instBusy;
}

/**
 * Move ComfyUI (with its models) into "stuff and thing/apps/comfyui". Not while it is running.
 * Same drive: a rename (instant). Another drive (EXDEV only): an asynchronous copy into "<to>.partial", renamed to
 * <to> once complete, then the old folder is deleted. EPERM/EBUSY mean something holds the files → "stop ComfyUI
 * first", never a copy (that would copy a live install and then delete files under it).
 */
async function moveComfy({ from, to, fs = nodeFs, onProgress } = {}) {
  try {
    if (!from || !hasComfy(from, fs)) return { ok: false, error: 'There is no ComfyUI to move there.' };
    if (hasComfy(to, fs)) return { ok: false, error: 'There is already a ComfyUI in "stuff and thing".' };
    if (path.resolve(from) === path.resolve(to)) return { ok: true, already: true, message: 'ComfyUI is already in "stuff and thing".' };
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const say = (m) => { try { if (onProgress) onProgress(m); } catch (_) {} };
    try {
      say('Moving ComfyUI (same drive — this is instant)…');
      if (fs.existsSync(to)) fs.rmdirSync(to); // an empty placeholder folder
      fs.renameSync(from, to);
      return { ok: true, how: 'rename', message: `✓ ComfyUI and its models are now in ${to}.` };
    } catch (e) {
      if (!e || e.code !== 'EXDEV') throw e;
    }
    say('Copying ComfyUI to the other drive — this takes a while for big models…');
    const partial = to + '.partial';
    const P = (fs.promises) || nodeFs.promises;
    await P.rm(partial, { recursive: true, force: true }); // a copy that was cut off before
    await P.cp(from, partial, { recursive: true, errorOnExist: false });
    if (!hasComfyFiles(partial, fs)) {
      try { await P.rm(partial, { recursive: true, force: true }); } catch (_) {}
      return { ok: false, error: 'The copy didn\'t finish — the original was left where it was.' };
    }
    if (fs.existsSync(to)) fs.rmdirSync(to);
    fs.renameSync(partial, to);
    if (!hasComfy(to, fs)) return { ok: false, error: 'The copy didn\'t finish — the original was left where it was.' };
    try { await P.rm(from, { recursive: true, force: true }); } catch (_) { return { ok: true, how: 'copy', leftBehind: from, message: `✓ Copied to ${to}. The old folder couldn't be deleted — delete ${from} yourself when convenient.` }; }
    return { ok: true, how: 'copy', message: `✓ ComfyUI and its models are now in ${to}.` };
  } catch (e) {
    const code = e && e.code;
    return { ok: false, error: code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' ? 'Something is still using ComfyUI\'s files — stop ComfyUI (and close its window), then try again.' : code === 'ENOSPC' ? 'The disk is full — free some space and try again. The original was left where it was.' : `The move didn't work (${String((e && e.message) || e).slice(0, 160)}). Nothing was deleted.` };
  }
}

module.exports = { layout, hasComfy, comfyInUse, pickComfyHome, map, moveComfy, sizeOf };
