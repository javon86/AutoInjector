'use strict';
/*
 * transcript-store.js — keeps the app's memory and its saved-state file small during a 20–50 hour book run.
 *
 * Before: every Akọwe reply (a whole chapter as JSON, about 25,000 characters) was kept in full in the conversation
 * list, and the WHOLE state (20–40 MB by the end of a long book) was turned into text and written to disk on the main
 * thread after every reply — the window stuttered and memory kept growing.
 *
 * Now:
 *   - an Akọwe-owned reply is kept SHORT in the conversation list (its first 2,000 characters plus
 *     "… (full answer handed to Akọwe)"); Akọwe already has the full answer and saves it in the book;
 *   - the list keeps the newest MAX turns; older ones move to a rotating archive file on disk
 *     (autoinjector-transcript-archive.jsonl, then .1 — about 20 MB each) instead of being kept in memory;
 *   - the state file is written at most every few seconds, in the background (async), to a temp file that is then
 *     renamed over the real one (a crash mid-write never leaves a broken file); on quit it is written once more.
 *
 * Electron-free, unit-tested in test/transcript-store.test.js.
 */
const fsMod = require('fs');

const OWNED_KEEP_CHARS = 2000;
const OWNED_NOTE = '… (full answer handed to Akọwe)';

/** The short copy of an Akọwe-owned reply for the conversation list. -> { text, fullChars, trimmed } */
function trimOwnedText(text, keep = OWNED_KEEP_CHARS) {
  const t = String(text == null ? '' : text);
  if (t.length <= keep + OWNED_NOTE.length + 20) return { text: t, fullChars: t.length, trimmed: false };
  return { text: `${t.slice(0, keep)}\n${OWNED_NOTE} — ${t.length.toLocaleString('en-US')} characters in all`, fullChars: t.length, trimmed: true };
}

/** An append-only archive of old conversation turns, one JSON line each, rotated at maxBytes (keeps one .1 file). */
function createArchive({ file, maxBytes = 20 * 1024 * 1024, fs = fsMod, onError } = {}) {
  function append(turns) {
    const list = (Array.isArray(turns) ? turns : []).filter(Boolean);
    if (!file || !list.length) return false;
    try {
      let size = 0;
      try { size = fs.statSync(file).size; } catch (_) { size = 0; }
      if (size >= maxBytes) {
        try { fs.rmSync(`${file}.1`, { force: true }); } catch (_) {}
        try { fs.renameSync(file, `${file}.1`); } catch (_) {}
      }
      fs.appendFileSync(file, list.map((t) => JSON.stringify(t)).join('\n') + '\n');
      return true;
    } catch (e) { if (onError) onError(e); return false; }
  }
  return { append, file };
}

/** Keep the newest `max` turns in `arr` (in place); the older ones go to archive.append(). -> how many moved out */
function capTurns(arr, max, archive) {
  if (!Array.isArray(arr) || arr.length <= max) return 0;
  const old = arr.splice(0, arr.length - max);
  if (archive && typeof archive.append === 'function') archive.append(old);
  return old.length;
}

/**
 * The state file writer: schedule() after each change; it writes after delayMs of quiet, but never more often than
 * minGapMs, asynchronously (temp file + rename). flushSync() writes right now (on quit).
 *   serialize() -> string (called at write time, so the newest state is written)
 */
function createStateWriter({ file, serialize, delayMs = 500, minGapMs = 4000, fs = fsMod, onError, now = Date.now } = {}) {
  let timer = null;
  let writing = false;
  let dirty = false;
  let lastWriteAt = -Infinity;
  let seq = 0;            // each write's number
  let landed = 0;         // the newest write that reached the real file
  let writes = 0;
  const tmpName = (n) => `${file}.${process.pid}.${n}.tmp`;

  function schedule() {
    dirty = true;
    if (writing) return; // the write in progress re-schedules when it is done
    clearTimeout(timer);
    const gapLeft = Math.max(0, lastWriteAt + minGapMs - now());
    timer = setTimeout(() => { timer = null; writeAsync(); }, Math.max(delayMs, gapLeft));
  }
  async function writeAsync() {
    if (!dirty) return;
    dirty = false;
    writing = true;
    const n = ++seq;
    const tmp = tmpName(n);
    try {
      const text = serialize();
      lastWriteAt = now();
      await fs.promises.writeFile(tmp, text);
      if (n > landed) { await fs.promises.rename(tmp, file); landed = n; writes++; }
      else await fs.promises.rm(tmp, { force: true });
    } catch (e) {
      try { await fs.promises.rm(tmp, { force: true }); } catch (_) {}
      if (onError) onError(e);
    } finally {
      writing = false;
      if (dirty) schedule();
    }
  }
  function flushSync() {
    clearTimeout(timer); timer = null;
    const n = ++seq;
    const tmp = tmpName(n);
    try {
      fs.writeFileSync(tmp, serialize());
      fs.renameSync(tmp, file);
      landed = n; writes++; dirty = false; lastWriteAt = now();
      return true;
    } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch (_) {} if (onError) onError(e); return false; }
  }
  /** Wait for any scheduled / running write (tests). */
  async function idle() {
    for (let i = 0; i < 400 && (timer || writing); i++) await new Promise((r) => setTimeout(r, 10));
  }
  return { schedule, flushSync, idle, stats: () => ({ writes, pending: !!timer || writing, dirty }) };
}

module.exports = { trimOwnedText, createArchive, capTurns, createStateWriter, OWNED_KEEP_CHARS, OWNED_NOTE };
