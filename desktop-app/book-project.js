'use strict';
/*
 * book-project.js — a book project on disk under output/books/<title>/, run by
 * the Book Studio. Each project keeps everything the ATELIER V2 workflow needs
 * in one findable folder:
 *
 *   output/books/<title>/
 *     book.json            the control sheet: stage, chapters, records, log, counters
 *     chapters/CH-001.md   chapter manuscripts (each has a status)
 *     records/REQ-001.md   every other governed record (REQ/CHR/PLC/… )
 *
 * Kept Electron-free (the books dir is passed to init) so it's unit-testable.
 */
const fs = require('fs');
const path = require('path');

// The user-facing production stages (condensed from the V2 14-step flow).
const STAGES = ['setup', 'planning', 'roadmap', 'drafting', 'review', 'revision', 'locking', 'assembly'];
const STAGE_LABELS = {
  setup: 'Setup', planning: 'Planning', roadmap: 'Roadmap', drafting: 'Drafting',
  review: 'Review', revision: 'Revise', locking: 'Lock', assembly: 'Export',
};
// Chapter status values (CHG-004 / workflow §3).
const CHAPTER_STATES = ['NOT STARTED', 'ACTIVE', 'DRAFTING', 'IN REVIEW', 'REOPENED', 'BLOCKED', 'LOCKED', 'COMPLETE'];
// Governed record types (workflow §4). CH is handled as a chapter, not here.
const RECORD_TYPES = ['REQ', 'CHR', 'PLC', 'ART', 'SEC', 'TWT', 'STP', 'ARC', 'EVT', 'CCR', 'CNF', 'REV'];

let _root = null; // <documents>/AutoInjector/output/books

function init(booksDir) { _root = booksDir; ensureDir(_root); return _root; }
function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (_) {} return p; }
function _now() { return new Date().toISOString(); }

function safeName(name, fallback) {
  let s = String(name == null ? '' : name)
    .replace(/[\/\\]+/g, ' ').replace(/\.{2,}/g, ' ').replace(/[\x00-\x1f<>:"|?*]+/g, '')
    .replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 100).trim();
  return s || fallback || 'untitled';
}
function pad(n) { return String(n).padStart(3, '0'); }

function _dirFor(title) { return path.join(_root, safeName(title, 'untitled-book')); }
function _jsonPath(dir) { return path.join(dir, 'book.json'); }
function _read(dir) { try { return JSON.parse(fs.readFileSync(_jsonPath(dir), 'utf8')); } catch (_) { return null; } }
function _write(dir, book) { book.updated = _now(); fs.writeFileSync(_jsonPath(dir), JSON.stringify(book, null, 2)); return book; }
function _dirById(id) {
  for (const d of _projectDirs()) { const b = _read(d); if (b && b.id === id) return d; }
  return null;
}
function _projectDirs() {
  if (!_root || !fs.existsSync(_root)) return [];
  return fs.readdirSync(_root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(_root, e.name))
    .filter((d) => fs.existsSync(_jsonPath(d)));
}

/** Create a new book project folder + control sheet. */
function create(title) {
  if (!_root) throw new Error('book-project not initialized');
  const clean = String(title || '').trim();
  if (!clean) return { ok: false, error: 'a book needs a title' };
  const dir = _dirFor(clean);
  if (fs.existsSync(_jsonPath(dir))) return { ok: false, error: 'a book with that title already exists' };
  ensureDir(dir); ensureDir(path.join(dir, 'chapters')); ensureDir(path.join(dir, 'records'));
  const n = _projectDirs().length + 1;
  const book = {
    id: `PRJ-${pad(n)}`, title: clean, stage: 'setup',
    chapters: [], records: [], counters: {}, log: [],
    created: _now(), updated: _now(),
  };
  book.log.push({ ts: _now(), text: `created book "${clean}" (${book.id})` });
  _write(dir, book);
  return { ok: true, project: summary(book, dir) };
}

function summary(book, dir) {
  return {
    id: book.id, title: book.title, stage: book.stage, dir,
    chapters: book.chapters.length, records: book.records.length, updated: book.updated,
  };
}

/** All projects (lightweight). */
function list() { return _projectDirs().map((d) => { const b = _read(d); return b ? summary(b, d) : null; }).filter(Boolean); }

/** Full project state for the UI. */
function get(id) {
  const dir = _dirById(id); if (!dir) return null;
  const b = _read(dir); if (!b) return null;
  return { ...b, dir, stages: STAGES, stageLabels: STAGE_LABELS, chapterStates: CHAPTER_STATES, recordTypes: RECORD_TYPES };
}

function _mutate(id, fn) {
  const dir = _dirById(id); if (!dir) return { ok: false, error: 'no such book' };
  const b = _read(dir); if (!b) return { ok: false, error: 'unreadable book' };
  const r = fn(b, dir) || {};
  _write(dir, b);
  return { ok: true, ...r };
}

function setStage(id, stage) {
  if (!STAGES.includes(stage)) return { ok: false, error: 'unknown stage' };
  return _mutate(id, (b) => { b.stage = stage; b.log.push({ ts: _now(), text: `stage → ${STAGE_LABELS[stage]}` }); });
}

function addChapter(id, title) {
  return _mutate(id, (b, dir) => {
    b.counters.CH = (b.counters.CH || 0) + 1;
    const chId = `CH-${pad(b.counters.CH)}`;
    const file = path.join('chapters', `${chId}.md`);
    fs.writeFileSync(path.join(dir, file), `# ${chId} ${title ? '— ' + title : ''}\n\n(empty draft)\n`);
    b.chapters.push({ id: chId, title: String(title || '').trim(), status: 'NOT STARTED', file });
    b.log.push({ ts: _now(), text: `added chapter ${chId}${title ? ' — ' + title : ''}` });
    return { chapterId: chId };
  });
}

function setChapterStatus(id, chId, status) {
  if (!CHAPTER_STATES.includes(status)) return { ok: false, error: 'unknown status' };
  return _mutate(id, (b) => {
    const ch = b.chapters.find((c) => c.id === chId); if (!ch) throw new Error('no such chapter');
    ch.status = status; b.log.push({ ts: _now(), text: `${chId} → ${status}` });
  });
}

function addRecord(id, type, name, content) {
  const t = String(type || '').toUpperCase();
  if (!RECORD_TYPES.includes(t)) return { ok: false, error: `unknown record type: ${type}` };
  return _mutate(id, (b, dir) => {
    b.counters[t] = (b.counters[t] || 0) + 1;
    const recId = `${t}-${pad(b.counters[t])}`;
    const file = path.join('records', `${recId}.md`);
    fs.writeFileSync(path.join(dir, file), `# ${recId} — ${String(name || '').trim()}\n\n${String(content || '').trim()}\n`);
    b.records.push({ id: recId, type: t, name: String(name || '').trim(), file });
    b.log.push({ ts: _now(), text: `added ${recId}${name ? ' — ' + name : ''}` });
    return { recordId: recId };
  });
}

function listRecords(id) { const b = get(id); return b ? b.records : []; }

/** Read a record or chapter's file content by its ID. */
function readRecord(id, recordId) {
  const dir = _dirById(id); if (!dir) return { ok: false, error: 'no such book' };
  const b = _read(dir); if (!b) return { ok: false, error: 'unreadable book' };
  const item = [...b.records, ...b.chapters].find((r) => r.id === recordId);
  if (!item) return { ok: false, error: 'no such record' };
  try { return { ok: true, id: recordId, name: item.name || item.title || '', content: fs.readFileSync(path.join(dir, item.file), 'utf8') }; }
  catch (e) { return { ok: false, error: String(e) }; }
}

function appendLog(id, text) {
  return _mutate(id, (b) => { b.log.push({ ts: _now(), text: String(text || '').slice(0, 300) }); });
}

module.exports = {
  init, create, list, get, setStage, addChapter, setChapterStatus,
  addRecord, listRecords, readRecord, appendLog, safeName,
  STAGES, STAGE_LABELS, CHAPTER_STATES, RECORD_TYPES,
};
