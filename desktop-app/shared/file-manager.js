'use strict';
/*
 * shared/file-manager.js
 *
 * MDC-009-PG — Shared Project File Manager: the single gateway for project file
 *   access. It decides which model may read/write each path, writes atomically
 *   (temp file + rename) with a per-path lock so concurrent writes are
 *   serialized, leaves the previous version untouched on failure, and records
 *   every version through the artifact store (MDC-008).
 *
 * MDC-007-PG — AI File Request System: a model asks for a file by name; the
 *   manager returns the authoritative current version and logs the request
 *   (requester, file, version, result). Unknown file → FILE_NOT_FOUND plus the
 *   closest matching names; denied → ACCESS_DENIED (never an empty response).
 */
const fs = require('fs');
const path = require('path');
const { ArtifactStore } = require('./artifacts');

// Native role→path write policy (mirrors the ATELIER authority matrix, no
// Python needed). Deny by default; `human` may write anywhere.
const WRITE_POLICY = {
  chatgpt: ['01_DESIGN/', '00_CONTROL/', '02_BIBLE/'],
  claude: ['04_CHAPTERS/', '02_BIBLE/', '03_MEMORY/', '07_BUILD/'],
  gemini: ['06_AUDIT/', '06_AUDITS/', '99_ARCHIVE/auditor-submissions/'],
  human: [''],
};
const KNOWN_ROLES = new Set([...Object.keys(WRITE_POLICY), 'user', 'system']);

function nowIso() { return new Date().toISOString(); }

// Reject absolute paths and traversal escapes; return a normalized relative path.
function safeRel(relPath) {
  const raw = String(relPath).replace(/\\/g, '/');
  if (!raw || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return null;
  const norm = path.posix.normalize(raw);
  if (norm === '..' || norm.startsWith('../') || norm.includes('/../')) return null;
  return norm.replace(/^\.\//, '');
}

function canWrite(role, rel) {
  const pats = WRITE_POLICY[String(role).toLowerCase()];
  if (!pats) return false;
  return pats.some((p) => p === '' || rel === p.replace(/\/$/, '') || rel.startsWith(p));
}

// Cheap "closest names" for a not-found request: rank by shared basename prefix.
function closestNames(target, candidates, n = 3) {
  const base = path.posix.basename(String(target)).toLowerCase();
  const score = (c) => {
    const cb = path.posix.basename(c).toLowerCase();
    let i = 0; while (i < base.length && i < cb.length && base[i] === cb[i]) i++;
    return i + (cb.includes(base) || base.includes(cb) ? 2 : 0);
  };
  return candidates.map((c) => [score(c), c]).filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0]).slice(0, n).map(([, c]) => c);
}

class FileManager {
  /**
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {string} projectRoot  directory on disk holding this project's files
   * @param {{projectId?:string}} [opts]
   */
  constructor(db, projectRoot, opts = {}) {
    this.db = db;
    this.root = path.resolve(projectRoot);
    this.projectId = opts.projectId || 'book';
    this.artifacts = new ArtifactStore(db);
    this._locks = new Set(); // per-path write locks
    this._log = db.prepare('INSERT INTO system_log (project_id, level, code, message, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    this._logRequest = db.prepare('INSERT INTO file_requests (project_id, requester, path, version, result, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  }

  _abs(rel) { return path.join(this.root, rel); }

  /** List known project files (relative paths), for suggestions/audits. */
  list() {
    const out = [];
    const walk = (dir, base) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        const rel = base ? `${base}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), rel);
        else out.push(rel);
      }
    };
    walk(this.root, '');
    return out;
  }

  /**
   * Write a file through the gateway. Enforces policy, writes atomically under a
   * per-path lock, records a version, and never corrupts the previous copy.
   * @returns {{ok:boolean, path?:string, version?:number, error?:string, reason?:string}}
   */
  write(role, relPath, body) {
    const rel = safeRel(relPath);
    if (!rel) return { ok: false, error: 'BAD_PATH', reason: `unsafe path ${relPath}` };
    if (!KNOWN_ROLES.has(String(role).toLowerCase())) return { ok: false, error: 'ACCESS_DENIED', reason: `unknown role ${role}` };
    if (!canWrite(role, rel)) {
      this._log.run(this.projectId, 'WARN', 'ACCESS_DENIED', `${role} may not write ${rel}`, rel, nowIso());
      return { ok: false, error: 'ACCESS_DENIED', reason: `${role} may not write ${rel}` };
    }
    if (this._locks.has(rel)) return { ok: false, error: 'LOCKED', reason: `a write to ${rel} is already in progress` };

    this._locks.add(rel);
    const abs = this._abs(rel);
    const tmp = `${abs}.tmp-${process.pid}-${this.artifacts ? '' : ''}${Date.now()}`;
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      // Atomic replace: write a temp file, then rename over the target. A crash
      // mid-write leaves the previous version intact.
      fs.writeFileSync(tmp, body == null ? '' : String(body));
      fs.renameSync(tmp, abs);
      const ver = this.artifacts.put(this.projectId, rel, body);
      return { ok: true, path: rel, version: ver.version, sha256: ver.sha256 };
    } catch (e) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
      this._log.run(this.projectId, 'ERROR', 'FILE_WRITE_FAILED', `${rel}: ${e.message}`, rel, nowIso());
      return { ok: false, error: 'FILE_WRITE_FAILED', reason: e.message };
    } finally {
      this._locks.delete(rel);
    }
  }

  /**
   * Read a file through the gateway.
   * @returns {{ok:boolean, path:string, body?:string, version?:number,
   *            error?:string, suggestions?:string[]}}
   */
  read(role, relPath) {
    const rel = safeRel(relPath);
    if (!rel) return { ok: false, path: String(relPath), error: 'BAD_PATH' };
    if (!KNOWN_ROLES.has(String(role).toLowerCase())) return { ok: false, path: rel, error: 'ACCESS_DENIED' };
    const abs = this._abs(rel);
    if (!fs.existsSync(abs)) {
      return { ok: false, path: rel, error: 'FILE_NOT_FOUND', suggestions: closestNames(rel, this.list()) };
    }
    const body = fs.readFileSync(abs, 'utf8');
    const art = this.artifacts._artifact(this.projectId, rel);
    return { ok: true, path: rel, body, version: art ? art.current_version : null };
  }

  /**
   * MDC-007 — a model's structured file request. Routes through read(), logs the
   * request with requester/file/version/result, and never returns an empty body
   * a model could misread as "file is blank".
   */
  request(role, relPath) {
    const res = this.read(role, relPath);
    const version = res.ok ? res.version : null;
    const result = res.ok ? 'OK' : res.error;
    this._logRequest.run(this.projectId, String(role), safeRel(relPath) || String(relPath), version, result, nowIso());
    return res;
  }

  /** The request audit trail (optionally for one requester). */
  requests(requester) {
    if (requester) return this.db.prepare('SELECT * FROM file_requests WHERE requester = ? ORDER BY id').all(String(requester));
    return this.db.prepare('SELECT * FROM file_requests ORDER BY id').all();
  }
}

module.exports = { FileManager, WRITE_POLICY, safeRel, canWrite, closestNames };
