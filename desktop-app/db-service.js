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
    _status = { available: true, file, count: _safeCount() };
  } catch (e) {
    _db = null; _log = null;
    _status = { available: false, reason: String((e && e.message) || e) };
  }
  return _status;
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

module.exports = { init, status, recordTurn, recordUserMessage, recent, PROJECT_ID };
