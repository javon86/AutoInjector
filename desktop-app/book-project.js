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
const bookPdf = require('./book-pdf');

const PDF_DIR = 'pdfs';
// Friendly deliverable names for each workflow step (used for PDF naming + the
// completion gate). Mirrors the workflow's step labels.
const STEP_LABEL = {
  intake: 'Intake Questionnaire', requirements: 'User Requirements and Story Direction',
  outline: 'Master Chapter Outline', bible: 'Book Bible', roadmap: 'Chapter Roadmap',
  'story-review': 'Story Review', 'canon-review': 'Canon Review', 'writing-review': 'Writing Review',
  revise: 'Consolidated Revision', lock: 'Verify and Lock',
};

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
let _atelier = null; // injected ATELIER bridge { scaffold, assemble } — enables governed (V2) mode

// The STRICT MANUSCRIPT BOUNDARY (ATELIER): only text between these markers is
// part of the book. Governed chapters are written with them so the ATELIER
// assembler can build the final manuscript (BG-007).
const MANUSCRIPT_START = '}-----< Start >-----{';
const MANUSCRIPT_FINISH = '}-----< finish >-----{';

function init(booksDir) { _root = booksDir; ensureDir(_root); return _root; }
// BG-001: main injects the ATELIER bridge so New Book scaffolds the governed
// tree (v2). Left null in unit tests / when Python is absent → V1 flat mode.
function configure(opts) { _atelier = (opts && opts.atelier) || null; return governedAvailable(); }
function governedAvailable() { try { return !!(_atelier && _atelier.scaffold && _atelier.detect && _atelier.detect().available); } catch (_) { return false; } }
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
// BG-010: atomic write — temp sibling then rename, so a crash mid-write can't
// truncate the control file.
function _writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
function _write(dir, book) { book.updated = _now(); _writeJsonAtomic(_jsonPath(dir), book); return book; }
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

// BG-011: monotonic project id independent of folder count, so deleting a book
// never lets a later one reuse an old PRJ-###.
function _nextProjectId() {
  const f = path.join(_root, '.book-counter.json');
  let n = 0;
  try { n = JSON.parse(fs.readFileSync(f, 'utf8')).next || 0; } catch (_) { n = 0; }
  // Never collide with ids already on disk (e.g. counter file lost).
  let maxSeen = 0;
  for (const d of _projectDirs()) { const b = _read(d); const m = b && /PRJ-(\d+)/.exec(b.id || ''); if (m) maxSeen = Math.max(maxSeen, parseInt(m[1], 10)); }
  n = Math.max(n, maxSeen) + 1;
  try { _writeJsonAtomic(f, { next: n }); } catch (_) {}
  return `PRJ-${pad(n)}`;
}

/** Create a new book project. Governed (ATELIER v2) when available, else V1 flat. */
function create(title) {
  if (!_root) throw new Error('book-project not initialized');
  const clean = String(title || '').trim();
  if (!clean) return { ok: false, error: 'a book needs a title' };
  // Duplicate check by title across all existing books (governed dirs are
  // slugged, so a folder-name check alone is not enough).
  if (list().some((p) => (p.title || '').trim().toLowerCase() === clean.toLowerCase()))
    return { ok: false, error: 'a book with that title already exists' };

  let dir = _dirFor(clean);
  let governed = false, atelierRoot = null;
  // v2 overrides v1: scaffold the governed tree and make it the book's home.
  if (governedAvailable()) {
    const s = _atelier.scaffold(clean, _root, { chapters: 1 });
    if (s && s.ok && s.dir) { dir = s.dir; governed = true; atelierRoot = s.dir; }
    else if (s && /already exists/i.test(s.reason || '')) return { ok: false, error: 'a book with that title already exists' };
    // any other scaffold failure → fall through to V1 so New Book never breaks
  }
  if (fs.existsSync(_jsonPath(dir))) return { ok: false, error: 'a book with that title already exists' };
  ensureDir(dir); ensureDir(path.join(dir, 'chapters')); ensureDir(path.join(dir, 'records'));
  const book = {
    id: _nextProjectId(), title: clean, stage: 'setup',
    chapters: [], records: [], counters: {}, log: [], pdfs: [],
    workflow: { status: 'idle', step: 0 },
    governed, atelierRoot,
    created: _now(), updated: _now(),
  };
  book.log.push({ ts: _now(), text: `created ${governed ? 'governed (ATELIER v2)' : 'V1'} book "${clean}" (${book.id})` });
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
  if (!b.workflow) b.workflow = { status: 'idle', step: 0 }; // default for older books
  if (!b.pdfs) b.pdfs = [];
  return { ...b, dir, stages: STAGES, stageLabels: STAGE_LABELS, chapterStates: CHAPTER_STATES, recordTypes: RECORD_TYPES };
}

/** Update the persisted workflow runner state ({status, step}), with a log note. */
function setWorkflow(id, patch, note) {
  return _mutate(id, (b) => {
    b.workflow = Object.assign({ status: 'idle', step: 0 }, b.workflow, patch || {});
    if (note) b.log.push({ ts: _now(), text: note });
  });
}

/**
 * Save the AI's output for a completed workflow step to disk, so the book
 * actually HOLDS the file/information that step was supposed to produce. Every
 * step's reply is written under steps/NN-<stepid>.md and indexed in
 * workflow.outputs. The "write" step's output IS the chapter manuscript, so it's
 * also written into that chapter's file (and the chapter flipped to DRAFTING).
 * This is what lets the runner know a step is truly done — the artifact exists.
 */
function recordStepOutput(id, { index, stepId, target, label, text, chapterId }) {
  return _mutate(id, (b, dir) => {
    ensureDir(path.join(dir, 'steps'));
    const base = safeName(`${pad((index || 0) + 1)}-${stepId || 'step'}`, `step-${(index || 0) + 1}`);
    const rel = path.join('steps', `${base}.md`);
    const body = String(text || '').trim();
    fs.writeFileSync(path.join(dir, rel),
      `# Step ${(index || 0) + 1}: ${label || stepId || ''}\n\n_from ${target || '?'} · ${_now()}_\n\n${body}\n`);
    b.workflow = Object.assign({ status: 'running', step: index || 0 }, b.workflow);
    b.workflow.outputs = b.workflow.outputs || {};
    const outKey = stepId || `step-${(index || 0) + 1}`;
    b.workflow.outputs[outKey] = { file: rel, target: target || null, ts: _now(), chars: body.length };
    b.log.push({ ts: _now(), text: `✓ step ${(index || 0) + 1} (${label || stepId}) output saved from ${target || '?'} → ${rel}` });
    // Rule 36/37 — the filled-out content must ALSO exist as a downloadable PDF,
    // named per the protocol. That PDF is the completion signal: the runner only
    // advances once this file is confirmed on disk.
    let pdfRel = null;
    try {
      if (stepId === 'write' && chapterId) {
        const ch = b.chapters.find((c) => c.id === chapterId);
        const pdf = _writeDeliverablePdf(b, dir, {
          kind: 'chapter', number: _chNum(chapterId), chapterTitle: ch && ch.title,
          title: `${chapterId}${ch && ch.title ? ' — ' + ch.title : ''}`, name: `Chapter ${_chNum(chapterId)}`,
          text: body, source: 'generated',
        });
        if (ch) ch.pdf = pdf.rel; pdfRel = pdf.rel;
      } else {
        const nm = STEP_LABEL[stepId] || label || stepId || 'Document';
        const pdf = _writeDeliverablePdf(b, dir, { kind: 'template', name: nm, title: nm, text: body, source: 'generated' });
        b.workflow.outputs[outKey].pdf = pdf.rel; pdfRel = pdf.rel;
      }
    } catch (e) { b.log.push({ ts: _now(), text: `⚠ could not create PDF for step ${(index || 0) + 1}: ${String(e).slice(0, 120)}` }); }
    // The write step's output is the chapter's manuscript — file it there too,
    // unless the chapter is already LOCKED/COMPLETE (never silently overwrite
    // locked material; the steps/ copy still preserves the new draft).
    if (stepId === 'write' && chapterId) {
      const ch = b.chapters.find((c) => c.id === chapterId);
      if (ch && ch.status !== 'LOCKED' && ch.status !== 'COMPLETE') {
        ensureDir(path.dirname(path.join(dir, ch.file)));
        fs.writeFileSync(path.join(dir, ch.file), b.governed
          ? _governedSceneContent(ch.id, ch.title, body)
          : `# ${ch.id}${ch.title ? ' — ' + ch.title : ''}\n\n${body}\n`);
        if (ch.status === 'NOT STARTED' || ch.status === 'ACTIVE') ch.status = 'DRAFTING';
        b.log.push({ ts: _now(), text: `${chapterId} manuscript updated from the Write step (${body.length} chars)` });
      }
    }
    // Confirm the PDF is really on disk (the "check from the download" step).
    const pdfExists = !!(pdfRel && fs.existsSync(path.join(dir, pdfRel)));
    return { file: rel, pdf: pdfRel, pdfExists };
  });
}

// --- PDF Completion Gate (Rules of Conduct §36–39) --------------------------
// Every filled-out deliverable must exist as a real, downloadable PDF before it
// counts as complete. These write PDFs, find ones you downloaded yourself, and
// report the gate (which deliverables have a PDF and which are still waiting).
function _chNum(chId) { const m = /(\d+)/.exec(String(chId || '')); return m ? parseInt(m[1], 10) : 1; }

function _registerPdf(b, relFile, meta) {
  b.pdfs = b.pdfs || [];
  const e = b.pdfs.find((p) => p.file === relFile);
  if (e) Object.assign(e, meta, { file: relFile, ts: _now() });
  else b.pdfs.push(Object.assign({ file: relFile, ts: _now() }, meta));
}

// Write one deliverable PDF into pdfs/ and register it. Operates directly on
// (b, dir) — callable both from inside another _mutate and standalone.
function _writeDeliverablePdf(b, dir, spec) {
  const fileName = bookPdf.pdfFileName(b.title, spec);
  ensureDir(path.join(dir, PDF_DIR));
  const rel = path.join(PDF_DIR, fileName);
  fs.writeFileSync(path.join(dir, rel), bookPdf.renderTextPdf(spec.title || spec.name || fileName.replace(/\.pdf$/i, ''), spec.text || ''));
  _registerPdf(b, rel, { name: spec.name || 'Document', kind: spec.kind || 'template', source: spec.source || 'generated', chars: String(spec.text || '').length });
  return { rel, fileName };
}

/** Generate a PDF for a deliverable on demand (the "Make PDF" button). */
function generatePdf(id, spec) {
  return _mutate(id, (b, dir) => {
    const r = _writeDeliverablePdf(b, dir, spec || {});
    b.log.push({ ts: _now(), text: `📄 PDF created: ${r.fileName}` });
    return { file: r.rel, fileName: r.fileName };
  });
}

/**
 * (Re)generate PDFs for everything the book currently holds that should have one
 * — each chapter's manuscript and each completed workflow step's output. Used by
 * the "Make PDFs" button so a book always has its downloadable forms.
 */
function generateAllPdfs(id) {
  return _mutate(id, (b, dir) => {
    let made = 0;
    for (const ch of b.chapters) {
      try {
        const content = fs.readFileSync(path.join(dir, ch.file), 'utf8');
        const r = _writeDeliverablePdf(b, dir, { kind: 'chapter', number: _chNum(ch.id), chapterTitle: ch.title, title: `${ch.id}${ch.title ? ' — ' + ch.title : ''}`, name: `Chapter ${_chNum(ch.id)}`, text: content, source: 'generated' });
        ch.pdf = r.rel; made++;
      } catch (_) {}
    }
    const outs = (b.workflow && b.workflow.outputs) || {};
    for (const stepId of Object.keys(outs)) {
      if (stepId === 'write') continue;
      try {
        const o = outs[stepId];
        const content = o.file ? fs.readFileSync(path.join(dir, o.file), 'utf8') : '';
        const nm = STEP_LABEL[stepId] || stepId;
        const r = _writeDeliverablePdf(b, dir, { kind: 'template', name: nm, title: nm, text: content, source: 'generated' });
        o.pdf = r.rel; made++;
      } catch (_) {}
    }
    b.log.push({ ts: _now(), text: `📄 made ${made} PDF${made === 1 ? '' : 's'} for this book's deliverables` });
    return { made };
  });
}

/** Copy a PDF you downloaded into the book and register it (source: imported). */
function importPdf(id, absPath) {
  return _mutate(id, (b, dir) => {
    if (!absPath || !fs.existsSync(absPath)) throw new Error('file not found');
    ensureDir(path.join(dir, PDF_DIR));
    const base = bookPdf.cleanPart(path.basename(absPath).replace(/\.pdf$/i, ''), 'imported') + '.pdf';
    const rel = path.join(PDF_DIR, base);
    fs.copyFileSync(absPath, path.join(dir, rel));
    _registerPdf(b, rel, { name: base.replace(/\.pdf$/i, ''), kind: 'imported', source: 'imported' });
    b.log.push({ ts: _now(), text: `📄 imported PDF: ${base}` });
    return { file: rel };
  });
}

/**
 * Find PDFs you downloaded (from the AI) in the given folders and pull any that
 * belong to this book (filename contains the book title) into pdfs/. This is the
 * "make the program find this form" step. Returns what it found/imported.
 */
function scanPdfs(id, extraDirs) {
  const dir = _dirById(id); if (!dir) return { ok: false, error: 'no such book' };
  const b0 = _read(dir); if (!b0) return { ok: false, error: 'unreadable book' };
  const titleKey = bookPdf.cleanPart(b0.title, '').toLowerCase();
  const found = [], imported = [];
  for (const d of (extraDirs || [])) {
    if (!d || !fs.existsSync(d)) continue;
    let files = []; try { files = fs.readdirSync(d); } catch (_) { continue; }
    for (const f of files) {
      if (!/\.pdf$/i.test(f)) continue;
      found.push(f);
      if (titleKey && f.toLowerCase().indexOf(titleKey) !== -1) {
        const rel = path.join(PDF_DIR, f);
        if (!fs.existsSync(path.join(dir, rel))) {
          try { ensureDir(path.join(dir, PDF_DIR)); fs.copyFileSync(path.join(d, f), path.join(dir, rel)); imported.push(f); } catch (_) {}
        }
      }
    }
  }
  if (imported.length) {
    _mutate(id, (b) => {
      for (const f of imported) { _registerPdf(b, path.join(PDF_DIR, f), { name: f.replace(/\.pdf$/i, ''), kind: 'imported', source: 'found' }); }
      b.log.push({ ts: _now(), text: `📄 found & imported ${imported.length} downloaded PDF${imported.length === 1 ? '' : 's'}` });
    });
  }
  return { ok: true, found, imported };
}

/** All PDFs registered for a book, each flagged whether the file still exists. */
function listPdfs(id) {
  const dir = _dirById(id); if (!dir) return [];
  const b = _read(dir); if (!b) return [];
  const list = []; const seen = new Set();
  for (const p of (b.pdfs || [])) { list.push({ ...p, exists: fs.existsSync(path.join(dir, p.file)) }); seen.add(p.file); }
  // loose PDFs physically present in pdfs/ but not yet registered.
  const pdir = path.join(dir, PDF_DIR);
  if (fs.existsSync(pdir)) {
    for (const f of fs.readdirSync(pdir)) {
      if (!/\.pdf$/i.test(f)) continue;
      const rel = path.join(PDF_DIR, f);
      if (!seen.has(rel)) list.push({ file: rel, name: f.replace(/\.pdf$/i, ''), kind: 'found', source: 'found', exists: true });
    }
  }
  return list;
}

/**
 * The completion gate: for each expected deliverable (every chapter + every
 * completed workflow step), whether its PDF exists yet. This is how you (and the
 * runner) know a step is truly done — text alone is not COMPLETE (Rule 38).
 */
function pdfGate(id) {
  const b = get(id); if (!b) return { items: [], present: 0, total: 0 };
  const exists = (rel) => !!rel && fs.existsSync(path.join(b.dir, rel));
  const items = [];
  for (const ch of b.chapters) {
    items.push({ type: 'Chapter', label: `${ch.id}${ch.title ? ' — ' + ch.title : ''}`, file: ch.pdf || null, present: exists(ch.pdf) });
  }
  const outs = (b.workflow && b.workflow.outputs) || {};
  for (const stepId of Object.keys(outs)) {
    if (stepId === 'write') continue;
    items.push({ type: 'Template/Record', label: STEP_LABEL[stepId] || stepId, file: outs[stepId].pdf || null, present: exists(outs[stepId].pdf) });
  }
  return { items, present: items.filter((i) => i.present).length, total: items.length };
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

// The one authoritative manuscript body for a chapter. Governed books keep it in
// 04_CHAPTERS/<id>/scenes/s01.md between the strict boundary markers (so the
// ATELIER assembler builds the book); V1 books keep a flat chapters/<id>.md.
function _governedSceneContent(chId, title, body) {
  return `# ${chId}${title ? ' — ' + title : ''}\n\n_Working notes above the line are NOT part of the book._\n\n${MANUSCRIPT_START}\n${body || '(empty draft)'}\n${MANUSCRIPT_FINISH}\n`;
}
function _chapterRelFile(governed, chId) {
  return governed ? path.join('04_CHAPTERS', chId, 'scenes', 's01.md') : path.join('chapters', `${chId}.md`);
}

function addChapter(id, title) {
  return _mutate(id, (b, dir) => {
    b.counters.CH = (b.counters.CH || 0) + 1;
    const chId = `CH-${pad(b.counters.CH)}`;
    const governed = !!b.governed;
    const file = _chapterRelFile(governed, chId);
    ensureDir(path.dirname(path.join(dir, file)));
    fs.writeFileSync(path.join(dir, file), governed
      ? _governedSceneContent(chId, title, '')
      : `# ${chId} ${title ? '— ' + title : ''}\n\n(empty draft)\n`);
    b.chapters.push({ id: chId, title: String(title || '').trim(), status: 'NOT STARTED', file });
    b.log.push({ ts: _now(), text: `added chapter ${chId}${title ? ' — ' + title : ''}${governed ? ' (governed)' : ''}` });
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

/** BG-007: strict manuscript assembly for a governed book (07_BUILD/manuscript.md). */
function assembleManuscript(id) {
  const dir = _dirById(id); if (!dir) return { ok: false, error: 'no such book' };
  const b = _read(dir); if (!b) return { ok: false, error: 'unreadable book' };
  if (!b.governed) return { ok: false, error: 'strict assembly needs a governed (v2) book' };
  if (!_atelier || !_atelier.assemble) return { ok: false, error: 'the ATELIER assembler is unavailable (Python 3 not found)' };
  const r = _atelier.assemble(dir);
  _mutate(id, (bb) => { bb.log.push({ ts: _now(), text: r.ok ? '📖 assembled manuscript → 07_BUILD/manuscript.md' : `⚠ assembly failed: ${String(r.report || '').slice(0, 160)}` }); });
  return r.ok ? { ok: true, output: '07_BUILD/manuscript.md', report: r.report } : { ok: false, error: r.report || 'assembly failed' };
}

module.exports = {
  init, configure, governedAvailable, create, list, get, setStage, setWorkflow, recordStepOutput, addChapter, setChapterStatus,
  addRecord, listRecords, readRecord, appendLog, safeName, assembleManuscript,
  generatePdf, generateAllPdfs, importPdf, scanPdfs, listPdfs, pdfGate,
  STAGES, STAGE_LABELS, CHAPTER_STATES, RECORD_TYPES, PDF_DIR,
};
