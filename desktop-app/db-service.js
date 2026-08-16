'use strict';
/*
 * db-service.js — the app-facing bridge to the shared SQLite backend
 * (shared/db.js + shared/message-log.js). It records the live conversation into
 * the database and exposes it to the UI.
 *
 * Everything here is defensive: if Node's built-in SQLite is unavailable in this
 * runtime, or anything fails, the service reports unavailable and every method
 * no-ops. It can never throw into main.js or block the app from launching — the
 * same graceful-degradation contract the ATELIER bridge uses.
 */
const path = require('path');

const PROJECT_ID = 'default';
let _db = null;
let _log = null;
let _memory = null, _search = null, _artifacts = null, _readpos = null, _baselines = null;
let _status = { available: false, reason: 'not initialized' };

/** Open the shared database and prepare the message log. Safe to call once at startup. */
function init(userDataDir) {
  try {
    const { openDatabase } = require('./shared/db');
    const { MessageLog } = require('./shared/message-log');
    const file = path.join(userDataDir || __dirname, 'autoinjector-shared.db');
    _db = openDatabase(file);
    _log = new MessageLog(_db);
    _log.ensureProject(PROJECT_ID, 'AutoInjector session');
    // The rest of the shared stores, all on the same database.
    const { MemoryStore, Search } = require('./shared/memory');
    const { ArtifactStore } = require('./shared/artifacts');
    const { ReadPositions, Baselines } = require('./shared/sync');
    _memory = new MemoryStore(_db);
    _search = new Search(_db);
    _artifacts = new ArtifactStore(_db);
    _readpos = new ReadPositions(_db);
    _baselines = new Baselines(_db);
    _status = { available: true, file, count: _safeCount() };
  } catch (e) {
    _db = null; _log = null; _memory = null; _search = null; _artifacts = null; _readpos = null; _baselines = null;
    _status = { available: false, reason: String((e && e.message) || e) };
  }
  return _status;
}

// ---- Structured memory + search (memory.js / entities.js) ------------------
function memorySummary() {
  if (!_memory) return { available: false, counts: {}, total: 0 };
  try {
    const { TYPES } = require('./shared/entities');
    const counts = {}; let total = 0;
    for (const t of TYPES) { const n = _memory.list(t, PROJECT_ID).length; counts[t] = n; total += n; }
    return { available: true, counts, total };
  } catch (_) { return { available: false, counts: {}, total: 0 }; }
}

function memoryCreate(type, data) {
  if (!_memory) return { ok: false, error: 'database off' };
  try { const row = _memory.create(type, PROJECT_ID, data || {}); return { ok: true, id: row.id }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

function memorySearch(query) {
  if (!_search) return { available: false, results: [] };
  const q = (query || '').trim();
  if (!q) return { available: true, degraded: false, results: [] };
  try {
    if (_search.ensureIndex) _search.ensureIndex();
    const r = _search.search(PROJECT_ID, q);
    const { fieldNames } = require('./shared/entities');
    const results = r.results.map((x) => {
      let title = '';
      try { const e = _memory.get(x.type, PROJECT_ID, x.id); if (e) title = e[fieldNames(x.type)[0]] || ''; } catch (_) {}
      return { type: x.type, id: x.id, title };
    });
    return { available: true, degraded: r.degraded, results };
  } catch (e) { return { available: false, results: [], error: String(e) }; }
}

// ---- Project state: sync + ownership + artifacts ---------------------------
function projectState() {
  if (!_db) return { available: false };
  try {
    return {
      available: true,
      readPositions: _readpos ? _readpos.all(PROJECT_ID) : [],
      baseline: _baselines ? _baselines.current(PROJECT_ID) : null,
      artifacts: _db.prepare('SELECT path, current_version FROM artifacts WHERE project_id = ? ORDER BY path').all(PROJECT_ID),
      ownedTasks: _db.prepare('SELECT task_id, owner, lease_expires_at FROM task_ownership WHERE project_id = ? ORDER BY task_id').all(PROJECT_ID),
    };
  } catch (e) { return { available: false, error: String(e) }; }
}

function _safeCount() {
  try { return _log ? _log.read(PROJECT_ID).length : 0; } catch (_) { return 0; }
}

function status() {
  return _log ? Object.assign({}, _status, { count: _safeCount() }) : _status;
}

/** Record a captured AI reply (a transcript turn) into the message log. */
function recordTurn(turn) {
  if (!_log || !turn) return null;
  try {
    const body = (turn.text || '').trim();
    if (!body) return null;
    return _log.append({ projectId: PROJECT_ID, from: turn.site || 'system', to: '', body, status: 'CAPTURED' });
  } catch (_) { return null; }
}

/** Record an outgoing user message. */
function recordUserMessage(text, targets) {
  if (!_log) return null;
  try {
    const body = (text || '').trim();
    if (!body) return null;
    return _log.append({ projectId: PROJECT_ID, from: 'user', to: (targets || []).join(','), body, status: 'SENT' });
  } catch (_) { return null; }
}

/** The most recent messages (oldest-first within the window), for the UI panel. */
function recent(limit = 100) {
  if (!_log) return [];
  try {
    const all = _log.read(PROJECT_ID);
    return all.slice(-limit);
  } catch (_) { return []; }
}

module.exports = {
  init, status, recordTurn, recordUserMessage, recent, PROJECT_ID,
  memorySummary, memoryCreate, memorySearch, projectState,
};
