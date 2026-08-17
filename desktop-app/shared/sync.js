'use strict';
/*
 * shared/sync.js — synchronization state built on the shared database.
 *
 * SCS-004  ReadPositions  — how far each model has actually read (per project).
 *                           Advances only on CONFIRMED delivery; a stored
 *                           position ahead of the log is clamped and flagged.
 * SCS-006  Deliveries     — per-recipient delivery state with exponential
 *                           backoff (5s/15s/45s), max 3 retries, then
 *                           FAILED_PERMANENT. Retries reuse the same MSG ID, so
 *                           a retry can never create a second message. No row
 *                           sits in PENDING past its timeout.
 * SCS-012  Baselines      — the authoritative baseline: exactly one CURRENT per
 *                           project, append-only with previous-hash linkage; a
 *                           mismatched/unverifiable hash refuses promotion and
 *                           keeps the prior baseline CURRENT.
 */

function nowMs(fn) { return typeof fn === 'function' ? fn() : Date.now(); }
function iso(ms) { return new Date(ms).toISOString(); }

// ---- SCS-004 ---------------------------------------------------------------
class ReadPositions {
  constructor(db) {
    this.db = db;
    this._get = db.prepare('SELECT position FROM read_positions WHERE project_id = ? AND model = ?');
    this._upsert = db.prepare(
      'INSERT INTO read_positions (project_id, model, position, updated_at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(project_id, model) DO UPDATE SET position = excluded.position, updated_at = excluded.updated_at'
    );
    this._maxSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE project_id = ?');
    this._log = db.prepare('INSERT INTO system_log (project_id, level, code, message, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    this._allModels = db.prepare('SELECT model, position FROM read_positions WHERE project_id = ? ORDER BY model');
  }

  /** Record that `model` has CONFIRMED reading up to `seq`. Advance-only. */
  confirm(projectId, model, seq) {
    const cur = this.position(projectId, model);
    const next = Math.max(cur, Number(seq) || 0);
    this._upsert.run(String(projectId), String(model), next, iso(Date.now()));
    return next;
  }

  position(projectId, model) {
    const row = this._get.get(String(projectId), String(model));
    return row ? row.position : 0;
  }

  maxSeq(projectId) { return this._maxSeq.get(String(projectId)).m; }

  /** Lag in message count. Clamps and flags a position that is ahead of the log. */
  lag(projectId, model) {
    const max = this.maxSeq(projectId);
    let pos = this.position(projectId, model);
    if (pos > max) {
      this._log.run(String(projectId), 'WARN', 'READ_POSITION_CLAMPED',
        `${model} position ${pos} > log max ${max}; clamped for resync`, String(model), iso(Date.now()));
      pos = max;
      this._upsert.run(String(projectId), String(model), pos, iso(Date.now()));
    }
    return max - pos;
  }

  /** Every tracked model's exact position and lag for the dashboard. */
  all(projectId) {
    const max = this.maxSeq(projectId);
    return this._allModels.all(String(projectId)).map((r) => ({
      model: r.model, position: r.position, lag: Math.max(0, max - r.position),
    }));
  }
}

// ---- SCS-006 ---------------------------------------------------------------
const BACKOFF_MS = [5000, 15000, 45000]; // retry 1, 2, 3
const MAX_RETRIES = 3;
const TERMINAL = new Set(['DELIVERED', 'FAILED_PERMANENT']);

class Deliveries {
  constructor(db, opts = {}) {
    this.db = db;
    this.now = opts.now || Date.now;                 // injectable clock for tests
    this.timeoutMs = opts.timeoutMs == null ? 30000 : opts.timeoutMs;
    this._upsert = db.prepare(
      'INSERT INTO deliveries (project_id, msg_id, recipient, state, attempts, next_attempt_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, 0, ?, ?) ' +
      'ON CONFLICT(project_id, msg_id, recipient) DO NOTHING'
    );
    this._byMsg = db.prepare('SELECT * FROM deliveries WHERE project_id = ? AND msg_id = ? ORDER BY recipient');
    this._one = db.prepare('SELECT * FROM deliveries WHERE project_id = ? AND msg_id = ? AND recipient = ?');
    this._setState = db.prepare('UPDATE deliveries SET state = ?, attempts = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?');
    this._due = db.prepare(
      "SELECT * FROM deliveries WHERE state NOT IN ('DELIVERED','FAILED_PERMANENT') AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?"
    );
    this._log = db.prepare('INSERT INTO system_log (project_id, level, code, message, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  }

  /** Start tracking delivery of msgId to each recipient (PENDING, with a deadline). */
  queue(projectId, msgId, recipients) {
    const t = nowMs(this.now);
    const deadline = iso(t + this.timeoutMs);
    for (const r of recipients) {
      this._upsert.run(String(projectId), String(msgId), String(r).toLowerCase(), 'PENDING', deadline, iso(t));
    }
    return this.state(projectId, msgId);
  }

  markDelivered(projectId, msgId, recipient) {
    const row = this._one.get(String(projectId), String(msgId), String(recipient).toLowerCase());
    if (!row) return null;
    this._setState.run('DELIVERED', row.attempts, null, iso(nowMs(this.now)), row.id);
    return 'DELIVERED';
  }

  // A delivery attempt failed or timed out: back off and retry, or give up.
  _fail(row, reason) {
    const attempts = row.attempts + 1;
    const t = nowMs(this.now);
    if (attempts > MAX_RETRIES) {
      this._setState.run('FAILED_PERMANENT', attempts, null, iso(t), row.id);
      this._log.run(row.project_id, 'ERROR', 'FAILED_PERMANENT',
        `delivery of ${row.msg_id} to ${row.recipient} gave up after ${MAX_RETRIES} retries (${reason})`, row.msg_id, iso(t));
      return 'FAILED_PERMANENT';
    }
    const nextAt = iso(t + BACKOFF_MS[attempts - 1]);
    this._setState.run('RETRY', attempts, nextAt, iso(t), row.id);
    this._log.run(row.project_id, 'WARN', 'DELIVERY_RETRY',
      `retry ${attempts} for ${row.msg_id} to ${row.recipient} (${reason})`, row.msg_id, iso(t));
    return 'RETRY';
  }

  /** Explicitly report a failed send for one recipient (schedules a retry). */
  markFailed(projectId, msgId, recipient, reason = 'send failed') {
    const row = this._one.get(String(projectId), String(msgId), String(recipient).toLowerCase());
    if (!row) return null;
    if (TERMINAL.has(row.state)) return row.state;
    return this._fail(row, reason);
  }

  /**
   * Move every non-terminal delivery whose deadline/retry time has arrived out
   * of PENDING/RETRY — the guarantee that nothing sits in PENDING past its
   * timeout. Returns the number of rows advanced.
   */
  sweep() {
    const t = nowMs(this.now);
    const due = this._due.all(iso(t));
    for (const row of due) this._fail(row, row.state === 'PENDING' ? 'timeout' : 'retry-due');
    return due.length;
  }

  /** Per-recipient state for a message. */
  state(projectId, msgId) {
    return this._byMsg.all(String(projectId), String(msgId)).map((r) => ({
      recipient: r.recipient, state: r.state, attempts: r.attempts, nextAttemptAt: r.next_attempt_at,
    }));
  }

  /** True once every recipient of a message has reached a terminal state. */
  allTerminal(projectId, msgId) {
    const rows = this._byMsg.all(String(projectId), String(msgId));
    return rows.length > 0 && rows.every((r) => TERMINAL.has(r.state));
  }
}

// ---- SCS-012 ---------------------------------------------------------------
class Baselines {
  constructor(db) {
    this.db = db;
    this._current = db.prepare('SELECT * FROM baselines WHERE project_id = ? AND is_current = 1');
    this._history = db.prepare('SELECT * FROM baselines WHERE project_id = ? ORDER BY id');
    this._insert = db.prepare(
      'INSERT INTO baselines (project_id, hash, prev_hash, stage, task_state, is_current, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
    );
    this._clearCurrent = db.prepare('UPDATE baselines SET is_current = 0 WHERE project_id = ? AND is_current = 1');
    this._log = db.prepare('INSERT INTO system_log (project_id, level, code, message, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  }

  current(projectId) { return this._current.get(String(projectId)) || null; }
  history(projectId) { return this._history.all(String(projectId)); }

  /**
   * Promote a new baseline. The caller must present the current baseline's hash
   * as `prevHash`; if it does not match, promotion is refused and the prior
   * baseline stays CURRENT (append-only, previous-hash linked).
   * @returns {{promoted:boolean, reason?:string, baseline?:object}}
   */
  promote(projectId, hash, opts = {}) {
    projectId = String(projectId);
    if (!hash || !String(hash).trim()) {
      this._log.run(projectId, 'WARN', 'BASELINE_REFUSED', 'empty/unverifiable hash', null, iso(Date.now()));
      return { promoted: false, reason: 'empty or unverifiable hash' };
    }
    const cur = this.current(projectId);
    if (cur && String(opts.prevHash || '') !== String(cur.hash)) {
      this._log.run(projectId, 'WARN', 'BASELINE_REFUSED',
        `prev_hash mismatch: expected ${cur.hash}, got ${opts.prevHash || '(none)'}`, String(hash), iso(Date.now()));
      return { promoted: false, reason: `prev_hash mismatch (current is ${cur.hash})` };
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (cur) this._clearCurrent.run(projectId);
      this._insert.run(projectId, String(hash), cur ? cur.hash : null,
        opts.stage || null, opts.taskState || null, iso(Date.now()));
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
    return { promoted: true, baseline: this.current(projectId) };
  }
}

module.exports = { ReadPositions, Deliveries, Baselines, BACKOFF_MS, MAX_RETRIES };
