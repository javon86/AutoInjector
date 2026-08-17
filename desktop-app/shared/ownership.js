'use strict';
/*
 * shared/ownership.js — SCS-013-PG: Task Ownership & Collision Prevention.
 *
 * Records who owns each task so two models cannot independently perform the same
 * work. "Done when": a second assignment attempt on an owned task is rejected
 * with a clear reason. Error handling: ownership carries a lease/timeout so a
 * crashed model does not hold a task forever — an expired lease releases with a
 * logged OWNER_LEASE_EXPIRED and the task returns to the queue.
 */

function nowMs(fn) { return typeof fn === 'function' ? fn() : Date.now(); }
function iso(ms) { return new Date(ms).toISOString(); }

class TaskOwnership {
  constructor(db, opts = {}) {
    this.db = db;
    this.now = opts.now || Date.now;                       // injectable clock
    this.leaseMs = opts.leaseMs == null ? 5 * 60 * 1000 : opts.leaseMs;
    this._get = db.prepare('SELECT * FROM task_ownership WHERE project_id = ? AND task_id = ?');
    this._upsert = db.prepare(
      'INSERT INTO task_ownership (project_id, task_id, owner, lease_expires_at, claimed_at) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(project_id, task_id) DO UPDATE SET owner = excluded.owner, lease_expires_at = excluded.lease_expires_at, claimed_at = excluded.claimed_at'
    );
    this._del = db.prepare('DELETE FROM task_ownership WHERE project_id = ? AND task_id = ?');
    this._expired = db.prepare("SELECT * FROM task_ownership WHERE lease_expires_at IS NOT NULL AND lease_expires_at <= ?");
    this._log = db.prepare('INSERT INTO system_log (project_id, level, code, message, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  }

  _isExpired(row, now) { return row.lease_expires_at && Date.parse(row.lease_expires_at) <= now; }

  /**
   * Claim a task for `owner`. Grants if unowned, already yours (renew), or the
   * current lease has expired; otherwise refuses with a clear reason.
   * @returns {{granted:boolean, owner?:string, reason?:string, currentOwner?:string,
   *            renewed?:boolean, tookOverFrom?:string}}
   */
  claim(projectId, taskId, owner, opts = {}) {
    projectId = String(projectId); taskId = String(taskId); owner = String(owner);
    const now = nowMs(this.now);
    const leaseMs = opts.leaseMs == null ? this.leaseMs : opts.leaseMs;
    const until = iso(now + leaseMs);
    const cur = this._get.get(projectId, taskId);

    if (cur && cur.owner === owner) {
      this._upsert.run(projectId, taskId, owner, until, iso(now));
      return { granted: true, renewed: true, owner };
    }
    if (cur && !this._isExpired(cur, now)) {
      return { granted: false, currentOwner: cur.owner,
        reason: `task ${taskId} is already owned by ${cur.owner}` };
    }
    if (cur) {
      // Lease expired — the previous owner is presumed crashed; reclaim.
      this._log.run(projectId, 'WARN', 'OWNER_LEASE_EXPIRED',
        `lease held by ${cur.owner} on ${taskId} expired; task returned to the queue`, taskId, iso(now));
    }
    this._upsert.run(projectId, taskId, owner, until, iso(now));
    return cur ? { granted: true, owner, tookOverFrom: cur.owner } : { granted: true, owner };
  }

  /** Release a task you own. A non-owner release is refused. */
  release(projectId, taskId, owner) {
    const cur = this._get.get(String(projectId), String(taskId));
    if (!cur) return { released: false, reason: 'not owned' };
    if (cur.owner !== String(owner)) return { released: false, reason: `owned by ${cur.owner}, not ${owner}` };
    this._del.run(String(projectId), String(taskId));
    return { released: true };
  }

  /** The current owner, treating an expired lease as unowned. */
  owner(projectId, taskId) {
    const cur = this._get.get(String(projectId), String(taskId));
    if (!cur) return null;
    if (this._isExpired(cur, nowMs(this.now))) return null;
    return cur.owner;
  }

  /** Release every expired lease and log each. Returns the released task ids. */
  sweepExpired() {
    const now = nowMs(this.now);
    const rows = this._expired.all(iso(now));
    for (const r of rows) {
      this._log.run(r.project_id, 'WARN', 'OWNER_LEASE_EXPIRED',
        `lease held by ${r.owner} on ${r.task_id} expired; task returned to the queue`, r.task_id, iso(now));
      this._del.run(r.project_id, r.task_id);
    }
    return rows.map((r) => r.task_id);
  }
}

module.exports = { TaskOwnership };
