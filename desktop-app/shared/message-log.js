'use strict';
/*
 * shared/message-log.js
 *
 * SCS-001-PG — Shared Ordered Message Log: one `messages` table holding every
 *   user, ChatGPT, Claude, Gemini, local-AI and system message in a single
 *   chronological conversation. Reading a project in `seq` order reproduces the
 *   whole conversation with no gaps. A write that fails is retried, then parked
 *   in `messages_deadletter` with its raw payload — never dropped, never
 *   partially committed (each append is one transaction).
 *
 * SCS-002-PG — Automatic Message ID Numbering: AutoInjector alone assigns the
 *   next number. No model, human, or external process may choose one — append()
 *   rejects a caller-supplied seq/msg_id. Numbering runs inside a transaction
 *   with a UNIQUE constraint on (project_id, seq); on collision it retries
 *   against the current max, and after 5 failed attempts the message is parked
 *   and the failure surfaced.
 */

const SOURCES = ['user', 'chatgpt', 'claude', 'gemini', 'local', 'system'];

class AppendParked extends Error {
  constructor(message, deadletterId) { super(message); this.name = 'AppendParked'; this.deadletterId = deadletterId; }
}

function isSeqCollision(err) {
  const m = String(err && err.message || '');
  return /UNIQUE/i.test(m) && /\bseq\b/i.test(m);
}
function isBusy(err) {
  const m = String(err && err.message || '');
  return /SQLITE_BUSY|database is locked/i.test(m);
}

function nowIso() { return new Date().toISOString(); }

// Zero-padded display id, e.g. 124 -> "MSG-000124".
function formatMsgId(seq) { return 'MSG-' + String(seq).padStart(6, '0'); }

class MessageLog {
  /**
   * @param {import('node:sqlite').DatabaseSync} db  an open, migrated database
   * @param {{retryWrites?:number, retrySeq?:number}} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.retryWrites = opts.retryWrites == null ? 3 : opts.retryWrites; // SCS-001 transient-failure retries
    this.retrySeq = opts.retrySeq == null ? 5 : opts.retrySeq;          // SCS-002 seq-collision retries

    this._maxSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE project_id = ?');
    this._insert = db.prepare(
      'INSERT INTO messages (msg_id, project_id, seq, "from", "to", reply_to, body, created_at, status) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    this._readAll = db.prepare('SELECT * FROM messages WHERE project_id = ? ORDER BY seq ASC');
    this._park = db.prepare(
      'INSERT INTO messages_deadletter (project_id, payload, error, attempts, parked_at) VALUES (?, ?, ?, ?, ?)'
    );
    this._upsertProject = db.prepare(
      'INSERT INTO projects (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(project_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at'
    );
  }

  /** Create or update a project row. Required before appending its messages. */
  ensureProject(projectId, name) {
    const t = nowIso();
    this._upsertProject.run(String(projectId), String(name || projectId), t, t);
    return projectId;
  }

  /**
   * Append one message. AutoInjector assigns msg_id and seq — a caller that
   * tries to supply either is rejected (SCS-002).
   * @param {{projectId:string, from:string, to?:string, replyTo?:string,
   *          body:string, status?:string, seq?:number, msgId?:string}} msg
   * @returns {{msgId:string, seq:number, projectId:string, from:string,
   *            to:string, replyTo:string, body:string, createdAt:string, status:string}}
   */
  append(msg) {
    if (!msg || typeof msg !== 'object') throw new Error('append: a message object is required');
    if (msg.seq != null || msg.msgId != null) {
      throw new Error('SCS-002: message numbers are assigned by AutoInjector only — do not supply seq or msgId');
    }
    const projectId = String(msg.projectId || '').trim();
    const from = String(msg.from || '').trim().toLowerCase();
    const body = msg.body == null ? '' : String(msg.body);
    if (!projectId) throw new Error('append: projectId is required');
    if (!from) throw new Error('append: from (source) is required');
    if (!body) throw new Error('append: body is required');

    const record = {
      projectId,
      from,
      to: msg.to == null ? '' : String(msg.to).toLowerCase(),
      replyTo: msg.replyTo == null ? '' : String(msg.replyTo),
      body,
      status: msg.status == null ? 'CREATED' : String(msg.status),
    };

    let attempts = 0;
    const maxAttempts = Math.max(this.retrySeq, this.retryWrites) + 1;
    let lastErr = null;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        return this._appendOnce(record);
      } catch (e) {
        lastErr = e;
        if (isSeqCollision(e) && attempts <= this.retrySeq) continue;   // recompute max, try again
        if (isBusy(e) && attempts <= this.retryWrites) { this._backoff(attempts); continue; }
        break; // non-retryable, or attempts exhausted -> park below
      }
    }

    // Never dropped: park the raw payload for later inspection/replay.
    const parked = this._park.run(
      record.projectId,
      JSON.stringify(record),
      String(lastErr && lastErr.message || 'unknown error'),
      attempts,
      nowIso()
    );
    throw new AppendParked(
      `append failed after ${attempts} attempt(s); parked to messages_deadletter (${lastErr && lastErr.message})`,
      Number(parked.lastInsertRowid)
    );
  }

  // One atomic attempt: allocate the next seq and insert, all in a single
  // transaction so a failure leaves nothing half-written.
  _appendOnce(record) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const seq = this._maxSeq.get(record.projectId).m + 1;
      const msgId = formatMsgId(seq);
      const createdAt = nowIso();
      this._insert.run(msgId, record.projectId, seq, record.from, record.to,
        record.replyTo, record.body, createdAt, record.status);
      this.db.exec('COMMIT');
      return { msgId, seq, projectId: record.projectId, from: record.from, to: record.to,
        replyTo: record.replyTo, body: record.body, createdAt, status: record.status };
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
  }

  // Small synchronous backoff between transient-failure retries.
  _backoff(attempt) {
    const ms = Math.min(50 * attempt, 250);
    const end = Date.now() + ms;
    while (Date.now() < end) { /* brief spin; node:sqlite is synchronous */ }
  }

  /** All messages for a project, in seq order. */
  read(projectId) {
    return this._readAll.all(String(projectId)).map((r) => ({
      msgId: r.msg_id, projectId: r.project_id, seq: r.seq,
      from: r.from, to: r.to, replyTo: r.reply_to,
      body: r.body, createdAt: r.created_at, status: r.status,
    }));
  }

  /**
   * Verify the log for a project is contiguous: seqs are exactly 1..N with no
   * gaps and no duplicates. Returns { ok, count, gaps, duplicates }.
   */
  verifyContiguous(projectId) {
    const rows = this._readAll.all(String(projectId));
    const seqs = rows.map((r) => r.seq);
    const seen = new Set();
    const duplicates = [];
    for (const s of seqs) { if (seen.has(s)) duplicates.push(s); seen.add(s); }
    const gaps = [];
    for (let i = 1; i <= seqs.length; i++) { if (!seen.has(i)) gaps.push(i); }
    return { ok: gaps.length === 0 && duplicates.length === 0, count: seqs.length, gaps, duplicates };
  }

  /** Rows parked in the dead-letter table (optionally for one project). */
  deadletters(projectId) {
    if (projectId) return this.db.prepare('SELECT * FROM messages_deadletter WHERE project_id = ?').all(String(projectId));
    return this.db.prepare('SELECT * FROM messages_deadletter').all();
  }
}

module.exports = { MessageLog, AppendParked, SOURCES, formatMsgId };
