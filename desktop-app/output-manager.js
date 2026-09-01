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

let _root = null; // <documents>/AutoInjector/output

const CATEGORIES = { books: 'books', images: 'images', videos: 'videos', uploads: 'uploads', aiwork: 'ai-work' };

/** Point the output folder at <documentsDir>/AutoInjector/output and create it. */
function init(documentsDir) {
  const base = documentsDir && String(documentsDir).trim() ? documentsDir : os.homedir();
  _root = path.join(base, 'AutoInjector', 'output');
  ensureDir(_root);
  return _root;
}
function root() { return _root; }

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
  saveBuffer, copyInto,
};
