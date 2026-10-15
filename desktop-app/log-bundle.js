'use strict';
/*
 * log-bundle.js — gather every diagnostic file the app writes, from everywhere,
 * into ONE timestamped folder the user can grab or zip in a single go.
 *
 * The app scatters logs across a few places: an on-disk rolling event log, the
 * persisted state file, the shared SQLite database, plus in-memory activity the
 * renderer never persists. "Download all logs" copies the on-disk files and
 * writes the in-memory blobs side by side, so a bug report is one folder.
 *
 * Pure + injectable (fs, clock) so it is unit-testable with no Electron and no
 * real app data. main.js supplies the real paths + generated text.
 */
const fs = require('fs');
const path = require('path');

/** A filesystem-safe timestamp like 2026-09-13_11-20-05. */
function stamp(now) {
  const d = now instanceof Date ? now : new Date();
  return d.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

/**
 * Build the bundle folder.
 * @param {{
 *   logsDir: string,                 // where to create the bundle folder (…/stuff and thing/logs)
 *   files?: string[],                // absolute paths of on-disk files to copy in (missing ones are noted, never fatal)
 *   blobs?: {name:string, content:any}[], // generated text files to write alongside
 *   fs?: object, now?: Date,
 * }} opts
 * @returns {{ok:boolean, folder?:string, entries?:{name:string,bytes:number}[], missing?:string[], error?:string}}
 */
function bundle(opts = {}) {
  const f = opts.fs || fs;
  if (!opts.logsDir) return { ok: false, error: 'no logs folder available' };
  const folder = path.join(opts.logsDir, `autoinjector-logs-${stamp(opts.now)}`);
  try { f.mkdirSync(folder, { recursive: true }); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }

  const entries = [];
  const missing = [];
  const sizeOf = (p) => { try { return f.statSync(p).size; } catch (_) { return 0; } };

  for (const src of (opts.files || [])) {
    if (!src) continue;
    try {
      if (!f.existsSync(src)) { missing.push(path.basename(src)); continue; }
      // Avoid name collisions (two files with the same basename) by prefixing.
      let name = path.basename(src);
      if (entries.some((e) => e.name === name)) name = `${path.basename(path.dirname(src))}-${name}`;
      const dest = path.join(folder, name);
      f.copyFileSync(src, dest);
      entries.push({ name, bytes: sizeOf(dest) });
    } catch (e) { missing.push(`${path.basename(src)} (${(e && e.message) || e})`); }
  }

  for (const b of (opts.blobs || [])) {
    if (!b || !b.name) continue;
    try {
      const dest = path.join(folder, b.name);
      f.writeFileSync(dest, b.content == null ? '' : String(b.content));
      entries.push({ name: b.name, bytes: sizeOf(dest) });
    } catch (_) { /* a single blob failing must not sink the bundle */ }
  }

  return { ok: true, folder, entries, missing };
}

module.exports = { bundle, stamp };
