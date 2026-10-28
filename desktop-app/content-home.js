'use strict';
/*
 * content-home.js — where the "stuff and thing" folder (downloads + everything the app makes) lives, so a NEW
 * copy of AutoInjector (a fresh clone or download in another folder) keeps using the downloads you already have
 * instead of starting empty and downloading everything again.
 *
 *  - The folder in use is remembered OUTSIDE the app folder (userData/content-home.json), so any copy finds it.
 *  - The first time (nothing remembered yet), other AutoInjector folders on this PC that already hold a
 *    "stuff and thing" with downloads are found (Documents, Desktop, the home folder, next to this copy …).
 *  - A copy whose own folder is still empty uses the one with your downloads by itself; when both have things,
 *    the app says so and lets you pick (content:use-root → remembered, then the app restarts).
 *
 * Electron-free; fs/paths injectable for the tests. Never throws.
 */
const nodeFs = require('fs');
const path = require('path');

const STUFF = 'stuff and thing';
const FILE = 'content-home.json';

function isDir(fs, p) { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } }

/** Roughly how much is in a folder (bytes, files) — capped so a huge folder can't stall startup. */
function folderSize(fs, dir, cap = 20000) {
  let bytes = 0, files = 0, seen = 0;
  const walk = (p, depth) => {
    if (seen > cap || depth > 8) return;
    let ents; try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (++seen > cap) return;
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile()) { files++; try { bytes += fs.statSync(full).size; } catch (_) {} }
    }
  };
  walk(dir, 0);
  return { bytes, files, partial: seen > cap };
}

/** What a "stuff and thing" folder holds that matters (not the READMEs the app seeds into every new one). */
function describe(fs, stuffDir) {
  const has = {};
  const sub = (rel) => path.join(stuffDir, rel);
  const nonEmpty = (p, test) => { try { return fs.readdirSync(p).some((n) => !/^readme/i.test(n) && (!test || test(n))); } catch (_) { return false; } };
  has.languageModels = isDir(fs, sub('models/llm/manifests')) && nonEmpty(sub('models/llm/manifests'));
  has.pictures = nonEmpty(sub('images'));
  has.videos = nonEmpty(sub('videos'));
  has.books = nonEmpty(sub('books'));
  has.otherModels = ['image', 'loras', 'video', 'voice', 'assets'].some((k) => nonEmpty(sub(path.join('models', k))));
  has.apps = nonEmpty(sub('apps')); // programs AutoInjector installed (ComfyUI …)
  const size = folderSize(fs, stuffDir);
  const what = [has.apps && 'installed programs (ComfyUI)', has.languageModels && 'AI models (Ollama)', has.otherModels && 'image / voice / video models', has.pictures && 'pictures', has.videos && 'videos', has.books && 'books'].filter(Boolean);
  return { has, what, bytes: size.bytes, files: size.files, worthUsing: what.length > 0 };
}

/** -> { root, how: 'auto' (the app noted it) | 'user' (you picked it) } | null */
// scanned: the other-copies scan already ran for this choice; others: what it found (root, dir, what, bytes)
function readRememberedInfo(userData, fs = nodeFs) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(userData, FILE), 'utf8'));
    if (!j || typeof j.root !== 'string' || !j.root) return null;
    const others = Array.isArray(j.others) ? j.others.filter((o) => o && typeof o.root === 'string' && typeof o.dir === 'string').slice(0, 20)
      .map((o) => ({ root: o.root, dir: o.dir, what: Array.isArray(o.what) ? o.what.map(String).slice(0, 10) : [], bytes: Number(o.bytes) || 0 })) : [];
    return { root: j.root, how: j.how === 'user' ? 'user' : 'auto', scanned: j.scanned === true, others };
  } catch (_) { return null; }
}
function readRemembered(userData, fs = nodeFs) { const r = readRememberedInfo(userData, fs); return r ? r.root : null; }
// extra.others (a scan's result) is stored with scanned:true, so later launches don't walk the disk again.
function remember(userData, root, fs = nodeFs, how = 'user', extra = null) {
  const rec = { root, how, savedAt: new Date().toISOString() };
  if (extra && Array.isArray(extra.others)) { rec.scanned = true; rec.others = extra.others.slice(0, 20).map((o) => ({ root: o.root, dir: o.dir, what: o.what || [], bytes: o.bytes || 0 })); }
  try { fs.mkdirSync(userData, { recursive: true }); fs.writeFileSync(path.join(userData, FILE), JSON.stringify(rec, null, 2)); return true; } catch (_) { return false; }
}

/** Other folders on this PC that hold a "stuff and thing" (a likely earlier copy of AutoInjector). */
function findOtherRoots({ home, appFolder, extra = [], fs = nodeFs, maxDepth = 3 } = {}) {
  const starts = new Set();
  const add = (p) => { if (p) starts.add(path.resolve(p)); };
  if (home) { add(home); add(path.join(home, 'Documents')); add(path.join(home, 'Desktop')); add(path.join(home, 'Downloads')); add(path.join(home, 'OneDrive', 'Documents')); add(path.join(home, 'OneDrive', 'Desktop')); add(path.join(home, 'source', 'repos')); }
  if (appFolder) { add(path.dirname(appFolder)); add(path.dirname(path.dirname(appFolder))); }
  for (const e of extra) add(e);
  const found = new Map();
  const skip = /^(node_modules|\.git|AppData|Library|\..+|Windows|Program Files.*|\$Recycle\.Bin)$/i;
  const visit = (dir, depth) => {
    const stuff = path.join(dir, STUFF);
    if (isDir(fs, stuff) && !found.has(path.resolve(dir))) found.set(path.resolve(dir), stuff);
    if (depth >= maxDepth) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    let n = 0;
    for (const e of ents) {
      if (!e.isDirectory() || skip.test(e.name) || e.name === STUFF) continue;
      if (++n > 200) break;
      visit(path.join(dir, e.name), depth + 1);
    }
  };
  for (const s of starts) if (isDir(fs, s)) visit(s, s === path.resolve(home || '') ? 1 : 0);
  const self = appFolder ? path.resolve(appFolder) : null;
  return [...found].filter(([root]) => root !== self).map(([root, stuff]) => Object.assign({ root, dir: stuff }, describe(fs, stuff))).filter((x) => x.worthUsing).sort((a, b) => b.bytes - a.bytes);
}

/**
 * The folder to keep "stuff and thing" in.
 *  1. the remembered one, if it still exists;
 *  2. else, when this copy's own folder has nothing worth keeping and another one on this PC does → that one;
 *  3. else this copy's folder (as before).
 * -> { root, reason: 'remembered'|'found-earlier'|'default', others }
 */
function chooseRoot({ appFolder, userData, home, fs = nodeFs, scan = true } = {}) {
  const rem = userData ? readRememberedInfo(userData, fs) : null;
  if (rem && isDir(fs, path.join(rem.root, STUFF))) {
    // a folder you picked yourself: stay quiet; one the app only noted: look for an earlier copy's downloads — once.
    // The scan walks the home folder, so it is not repeated on every launch: its result is remembered (the
    // 📁 folders panel's "look again" still scans afresh) and re-checked with a cheap "does it still exist".
    let others = [];
    if (scan && rem.how !== 'user') {
      if (rem.scanned) others = rem.others.filter((o) => path.resolve(o.root) !== path.resolve(rem.root) && isDir(fs, o.dir));
      else {
        others = findOtherRoots({ home, appFolder: rem.root, fs });
        if (userData) remember(userData, rem.root, fs, rem.how, { others });
      }
    }
    return { root: rem.root, reason: rem.how === 'user' ? 'chosen' : 'remembered', others };
  }
  const own = path.join(appFolder, STUFF);
  const ownInfo = isDir(fs, own) ? describe(fs, own) : { worthUsing: false };
  const others = scan ? findOtherRoots({ home, appFolder, fs }) : [];
  if (!ownInfo.worthUsing && others.length) return { root: others[0].root, reason: 'found-earlier', others };
  return { root: appFolder, reason: 'default', others };
}

module.exports = { STUFF, FILE, chooseRoot, findOtherRoots, describe, readRemembered, readRememberedInfo, remember, folderSize };
