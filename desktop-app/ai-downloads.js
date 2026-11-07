'use strict';
/*
 * ai-downloads.js — files an AI gives you to download in its pane ("a packet": a .zip, a .docx, a .pdf…).
 *
 * The user's problem (2026-11): "if they give me a packet that I need to download, our program won't let it go."
 * What went wrong before this file:
 *   - nothing showed that a download was happening, how far it was, or where the file went (it was saved silently
 *     into stuff and thing/ai-work/<ai>/ — nobody knew to look there);
 *   - closing the window (or File > Quit) while a file was still coming in quit the app at once, which cancels every
 *     unfinished download — the file never arrived;
 *   - the app's own automatic reloads / fresh chats (self-repair, Akọwe's fresh chat, the ChatGPT picture job) could
 *     reload the pane in the second after the user clicked "Download", which cancels a download that has not started
 *     yet;
 *   - a download that broke off (the connection dropped) was simply lost — Chromium can resume those, nobody asked it to;
 *   - the listener was added to the pane's session again each time the window was re-made (macOS: closed, reopened
 *     from the Dock), so one download was handled twice (two names chosen, two log lines);
 *   - two files with the same name arriving at once could be given the same save path; a file with no name
 *     (blob:/data: downloads) was saved as just "file" with no extension.
 *
 * What it does now (main.js calls attach(session, site) once per AI session):
 *   - chooses the save path SYNCHRONOUSLY in will-download (no Save dialog, never cancelled for lack of a path):
 *     <stuff and thing>/ai-work/<ai>/<the file's own name>, made safe for Windows, never overwriting a file (-1, -2…);
 *   - tracks each download: progress (throttled) and every state change go to emit() -> the panel shows
 *     "⬇ Claude: report.zip — 45% · 3 MB of 7 MB", then a notice with the folder and 📂 Open folder / Open file;
 *   - an interrupted download that Chromium can resume is resumed (a few tries), otherwise it says plainly why not;
 *   - active() / busyWhy() / waitIdle() let main.js keep the app open and hold its own reloads until files are in.
 *
 * Electron-free and pure (main.js passes the folder, the log and the emit functions); unit-tested in
 * test/ai-downloads.test.js. Logs carry the AI, the state, the size and the file NAME only — never the full path.
 */
const fs = require('fs');
const path = require('path');

const MIME_EXT = {
  'application/zip': '.zip', 'application/x-zip-compressed': '.zip', 'application/x-zip': '.zip',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'text/markdown': '.md', 'text/csv': '.csv', 'text/html': '.html',
  'application/json': '.json', 'application/epub+zip': '.epub', 'application/rtf': '.rtf', 'text/rtf': '.rtf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.oasis.opendocument.text': '.odt',
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'video/mp4': '.mp4', 'application/x-7z-compressed': '.7z',
  'application/x-tar': '.tar', 'application/gzip': '.gz'
};
// "Open file" only for plain documents, pictures, sounds, videos and archives — an allowlist (a blocklist always misses
// some program or script type). A program / script an AI hands over can still be found with 📂 Open folder.
const SAFE_OPEN = new Set(['zip', 'pdf', 'txt', 'md', 'csv', 'json', 'html', 'htm', 'rtf', 'doc', 'docx', 'odt', 'xlsx', 'pptx', 'epub',
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'mp3', 'wav', 'ogg', 'mp4', 'webm']);
function canOpen(name) { const m = /\.([a-z0-9]+)$/i.exec(path.basename(String(name || ''))); return !!m && SAFE_OPEN.has(m[1].toLowerCase()); }
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const MAX_NAME = 120;

/** A safe single file name (Windows rules), keeping the extension when it has to be shortened. */
function cleanName(raw, mime) {
  let s = String(raw == null ? '' : raw);
  s = s.replace(/[\/\\]+/g, ' ').replace(/[\x00-\x1f<>:"|?*]+/g, '').replace(/\.{2,}/g, '.').replace(/\s+/g, ' ').trim();
  s = s.replace(/^\.+/, '').replace(/[. ]+$/, ''); // no hidden-file dot, no trailing dot/space (Windows drops them)
  let ext = path.extname(s);
  if (ext.length > 12 || /\s/.test(ext)) ext = '';
  let stem = ext ? s.slice(0, -ext.length) : s;
  // a nameless download (blob: / data:) — Chromium names it after the blob id or "download"
  const guidish = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stem);
  if (!stem || guidish) stem = 'download';
  if (!ext) ext = MIME_EXT[String(mime || '').split(';')[0].trim().toLowerCase()] || '';
  if (WIN_RESERVED.test(stem)) stem = `${stem}_`;
  if (stem.length + ext.length > MAX_NAME) stem = stem.slice(0, MAX_NAME - ext.length).trim() || 'download';
  return stem + ext;
}

function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} bytes`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  if (b < 1024 * 1024 * 1024) { const m = b / (1024 * 1024); return `${m < 10 ? m.toFixed(1).replace(/\.0$/, '') : Math.round(m)} MB`; }
  return `${(b / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, '')} GB`;
}

function createAiDownloads(opts = {}) {
  const dirFor = typeof opts.dirFor === 'function' ? opts.dirFor : () => { throw new Error('no folder'); };
  const fallbackDir = typeof opts.fallbackDir === 'function' ? opts.fallbackDir : () => '';
  const label = typeof opts.label === 'function' ? opts.label : (s) => s;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
  const onPopup = typeof opts.onPopup === 'function' ? opts.onPopup : null; // (webContents, phase 'start'|'done')
  const isPane = typeof opts.isPane === 'function' ? opts.isPane : () => true;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const later = typeof opts.setTimeout === 'function' ? opts.setTimeout : setTimeout;
  const fsx = opts.fs || fs;
  const maxResumes = Number(opts.maxResumes) >= 0 ? Number(opts.maxResumes) : 3;
  const resumeDelayMs = Number(opts.resumeDelayMs) >= 0 ? Number(opts.resumeDelayMs) : 2000;
  const progressMs = Number(opts.progressMs) >= 0 ? Number(opts.progressMs) : 500;
  const keepRecent = 20;

  const sessions = new WeakSet();          // a session gets ONE listener, however often its pane is re-made
  const reserved = new Set();              // save paths given to downloads still coming in
  const items = new Map();                 // id -> entry
  const recent = [];                       // finished entries, newest last (for the panel after a reload)
  const waiters = [];                      // waitIdle() callbacks, run when a download ends
  let nextId = 1;

  function exists(p) { try { return fsx.existsSync(p); } catch (_) { return false; } }
  function uniqueIn(dir, name) {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length) || 'download';
    let cand = path.join(dir, name);
    for (let i = 1; reserved.has(cand) || exists(cand) || exists(`${cand}.crdownload`); i++) cand = path.join(dir, `${stem}-${i}${ext}`);
    return cand;
  }
  function folderFor(site) {
    try { const d = dirFor(site); if (d) return { dir: d, fallback: false }; } catch (_) {}
    const f = fallbackDir();
    try { if (f) fsx.mkdirSync(f, { recursive: true }); } catch (_) {}
    return { dir: f, fallback: true };
  }

  function view(e) {
    const total = e.total > 0 ? e.total : 0;
    const pct = total ? Math.min(100, Math.floor((e.received / total) * 100)) : null;
    return {
      id: e.id, site: e.site, label: label(e.site), name: e.name, file: e.file, folder: e.folder,
      state: e.state, received: e.received, total, percent: pct, resumes: e.resumes, startedAt: e.startedAt,
      endedAt: e.endedAt || null, reason: e.reason || null, fallback: !!e.fallback, canOpen: canOpen(e.name),
      text: describe(e)
    };
  }
  /** The plain-words line the panel shows. */
  function describe(e) {
    const L = label(e.site);
    const sizes = e.total > 0 ? `${fmtBytes(e.received)} of ${fmtBytes(e.total)}` : fmtBytes(e.received);
    const pct = e.total > 0 ? `${Math.min(100, Math.floor((e.received / e.total) * 100))}% · ` : '';
    switch (e.state) {
      case 'progressing': return `⬇ ${L}: ${e.name} — ${pct}${sizes}`;
      case 'paused': return `⏸ ${L}: ${e.name} — paused at ${pct}${sizes}`;
      case 'resuming': return `⟳ ${L}: ${e.name} — the download broke off; trying again (${e.resumes} of ${maxResumes})…`;
      case 'completed': return `✅ ${L} gave you ${e.name} (${fmtBytes(e.received || e.total)}). It is saved in ${e.folder}`;
      case 'cancelled': return `✖ ${L}: ${e.name} — the download was cancelled before it finished.`;
      default: return `⚠ ${L}: ${e.name} — ${e.reason || 'the download did not finish.'}`;
    }
  }
  function send(e) { try { emit(view(e)); } catch (_) {} }
  function logLine(kind, e, extra) {
    try { log(kind, Object.assign({ site: e.site, state: e.state, name: e.name, bytes: e.received, total: e.total || undefined }, extra || {})); } catch (_) {}
  }

  function failReason(e) {
    let writable = true;
    try { fsx.accessSync(e.folder, (fsx.constants || fs.constants).W_OK); } catch (_) { writable = false; }
    if (!writable) return `AutoInjector could not write into the folder ${e.folder}. Check that the folder exists and is not read-only, then click the download in ${label(e.site)}'s pane again.`;
    if (e.resumes >= maxResumes && maxResumes > 0) return `the download kept breaking off (tried ${e.resumes} more times). Check your internet connection, then click the download in ${label(e.site)}'s pane again.`;
    return `the download stopped before it finished (the connection dropped or the site stopped sending it). Click the download in ${label(e.site)}'s pane again.`;
  }

  function finish(e, state) {
    e.state = state;
    e.endedAt = now();
    reserved.delete(e.file);
    items.delete(e.id);
    if (state === 'completed') {
      let size = e.received;
      try { size = fsx.statSync(e.file).size; } catch (_) {}
      if (size) e.received = size;
      if (!e.total) e.total = e.received;
    }
    if (state === 'failed') e.reason = failReason(e);
    recent.push(e);
    while (recent.length > keepRecent) recent.shift();
    logLine(state === 'completed' ? 'ai-download' : 'ai-download-error', e, {
      resumes: e.resumes || undefined, popup: e.popup || undefined, fallback: e.fallback || undefined,
      severity: state === 'completed' ? undefined : 'warn',
      note: state === 'completed' ? `${label(e.site)}'s file ${e.name} is saved (${fmtBytes(e.received)})` : describe(e).replace(/^\S+\s/, '')
    });
    send(e);
    if (e.popupWc && onPopup) { try { onPopup(e.popupWc, 'done'); } catch (_) {} }
    for (const fn of waiters.splice(0)) { try { fn(); } catch (_) {} }
  }

  function tryResume(e, item) {
    let can = false;
    try { can = typeof item.canResume === 'function' && item.canResume(); } catch (_) { can = false; }
    if (!can || e.resumes >= maxResumes) return false;
    e.resumes++;
    e.state = 'resuming';
    logLine('ai-download-resume', e, { attempt: e.resumes, severity: 'warn', note: `${label(e.site)}'s download ${e.name} broke off — trying again (${e.resumes} of ${maxResumes})` });
    send(e);
    later(() => { try { if (items.has(e.id)) item.resume(); } catch (_) {} }, resumeDelayMs);
    return true;
  }

  /** The will-download handler body. Everything up to setSavePath runs synchronously. */
  function handle(site, item, wc) {
    let name = 'download';
    try { name = cleanName(item.getFilename && item.getFilename(), item.getMimeType && item.getMimeType()); } catch (_) {}
    const where = folderFor(site);
    if (!where.dir) { log('ai-download-error', { site, name, error: 'NO_FOLDER', severity: 'error' }); return null; }
    const file = uniqueIn(where.dir, name);
    try { item.setSavePath(file); } catch (err) { log('ai-download-error', { site, name, error: String(err && err.message || err).slice(0, 200), severity: 'error' }); return null; }
    reserved.add(file);
    const e = {
      id: nextId++, site, name: path.basename(file), file, folder: where.dir, fallback: where.fallback, state: 'progressing',
      received: 0, total: 0, resumes: 0, startedAt: now(), lastEmit: 0, popup: false, popupWc: null
    };
    try { e.total = Number(item.getTotalBytes()) || 0; } catch (_) {}
    items.set(e.id, e);
    // a download from a window the pane opened (window.open / target=_blank): same session, same folder; an empty
    // window that only existed for the download is tidied away by main.js (onPopup)
    try { if (wc && !isPane(site, wc)) { e.popup = true; e.popupWc = wc; if (onPopup) onPopup(wc, 'start'); } } catch (_) {}
    logLine('ai-download-start', e, { popup: e.popup || undefined, fallback: e.fallback || undefined, note: `${label(e.site)} is giving you ${e.name} — it goes into ${label(e.site)}'s downloads folder` });
    send(e);

    const on = (evt, fn) => { try { item.on(evt, fn); } catch (_) {} };
    on('updated', (_ev, st) => {
      if (!items.has(e.id)) return;
      try { e.received = Number(item.getReceivedBytes()) || 0; } catch (_) {}
      try { const t = Number(item.getTotalBytes()) || 0; if (t) e.total = t; } catch (_) {}
      if (st === 'interrupted') { if (e.state !== 'resuming') tryResume(e, item); return; }
      let paused = false;
      try { paused = typeof item.isPaused === 'function' && item.isPaused(); } catch (_) {}
      const was = e.state;
      e.state = paused ? 'paused' : 'progressing';
      if (paused && was !== 'paused') { // nothing in AutoInjector pauses a download: carry it on
        later(() => { try { if (items.has(e.id) && item.isPaused()) item.resume(); } catch (_) {} }, resumeDelayMs);
      }
      if (was !== e.state || now() - e.lastEmit >= progressMs) { e.lastEmit = now(); send(e); }
    });
    on('done', (_ev, st) => {
      if (!items.has(e.id)) return;
      try { e.received = Number(item.getReceivedBytes()) || e.received; } catch (_) {}
      if (st === 'completed') return finish(e, 'completed');
      if (st === 'cancelled') return finish(e, 'cancelled');
      if (tryResume(e, item)) return; // 'interrupted' but Chromium can still pick it up
      finish(e, 'failed');
    });
    return view(e);
  }

  /** Listen on one AI's session (once — a re-made pane reuses the same session). */
  function attach(session, site) {
    if (!session || typeof session.on !== 'function') return false;
    if (sessions.has(session)) return false;
    sessions.add(session);
    session.on('will-download', (_event, item, wc) => { try { handle(site, item, wc); } catch (err) { log('ai-download-error', { site, error: String(err && err.message || err).slice(0, 200), severity: 'error' }); } });
    return true;
  }

  function active(site) { return Array.from(items.values()).filter((e) => !site || e.site === site).map(view); }
  /** Plain words for the "keep it running?" question / keep-awake ("a download is still coming in (Claude: report.zip)"). */
  function busyWhy() {
    const a = Array.from(items.values());
    if (!a.length) return [];
    const names = a.slice(0, 2).map((e) => `${label(e.site)}: ${e.name}`).join(', ') + (a.length > 2 ? ` and ${a.length - 2} more` : '');
    return [`a download is still coming in (${names})`];
  }
  /** Resolves when `site` (or every AI) has no download coming in, or after maxMs. -> { waited, still } */
  function waitIdle(site, maxMs) {
    const t0 = now();
    const left = () => Array.from(items.values()).filter((e) => !site || e.site === site).length;
    if (!left()) return Promise.resolve({ waited: 0, still: 0 });
    return new Promise((resolve) => {
      let done = false;
      const end = () => { if (done) return; done = true; resolve({ waited: now() - t0, still: left() }); };
      const check = () => { if (done) return; if (!left()) end(); else waiters.push(check); };
      waiters.push(check);
      later(end, Math.max(0, Number(maxMs) || 0));
    });
  }
  function list() { return { active: active(), recent: recent.slice(-10).map(view) }; }
  /** A finished or active download by id (main.js opens only files it knows, never a path from the page). */
  function byId(id) {
    const n = Number(id);
    const e = items.get(n) || recent.find((x) => x.id === n);
    return e ? view(e) : null;
  }
  return { attach, handle, active, busyWhy, waitIdle, list, byId, describe: (v) => describe(v) };
}

module.exports = { createAiDownloads, cleanName, fmtBytes, canOpen, MIME_EXT, SAFE_OPEN };
