'use strict';
/*
 * atelier-store.js — on-disk persistence for the ATELIER engine's record set.
 * Storage engine is a non-goal of the spec; per the user's call we keep it as a
 * plain JSON file per book (atomic write), living beside the book's other files.
 */
const fs = require('fs');
const path = require('path');
const E = require('./atelier-engine');

const FILE = 'atelier-engine.json';
function _file(dir) { return path.join(dir, FILE); }

/** Load a book's engine store from disk, or a fresh one if none exists yet. */
function load(dir, bookId) {
  try {
    const p = _file(dir);
    if (fs.existsSync(p)) {
      const st = JSON.parse(fs.readFileSync(p, 'utf8'));
      // defensive defaults so an older/partial file still drives the engine
      for (const k of ['artifacts', 'jobs', 'responses', 'reviews', 'edges', 'events', 'overrides', 'mandatoryReqs']) if (!Array.isArray(st[k])) st[k] = [];
      if (!st.counters) st.counters = {};
      if (typeof st.chapterCount !== 'number') st.chapterCount = 0;
      if (!st.bookId) st.bookId = bookId || 'book';
      return st;
    }
  } catch (_) { /* fall through to a fresh store */ }
  return E.newStore(bookId);
}

/** Atomically persist the store (write temp + rename), never leaving a partial. */
function save(dir, store) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const p = _file(dir);
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch (_) { return false; }
}

module.exports = { load, save, FILE };
