'use strict';
/*
 * shared/artifacts.js — MDC-008-PG: Artifact Version & Hash Tracking.
 *
 * Every artifact write is a new immutable version with a SHA-256 hash, so a
 * model always receives the authoritative copy and any tampering is caught.
 * "Done when": any delivered file can be verified against its recorded hash,
 * and version history is complete. On a hash mismatch, delivery is blocked with
 * ARTIFACT_INTEGRITY_FAIL and the previous verified version is offered instead
 * of serving a possibly-corrupted file.
 */
const crypto = require('crypto');

function sha256(s) { return crypto.createHash('sha256').update(s == null ? '' : String(s)).digest('hex'); }
function nowIso() { return new Date().toISOString(); }

class ArtifactStore {
  constructor(db) {
    this.db = db;
    this._artByPath = db.prepare('SELECT * FROM artifacts WHERE project_id = ? AND path = ?');
    this._maxSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM artifacts WHERE project_id = ?');
    this._insertArt = db.prepare('INSERT INTO artifacts (id, project_id, seq, path, title, current_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)');
    this._bumpArt = db.prepare('UPDATE artifacts SET current_version = ?, title = COALESCE(?, title), updated_at = ? WHERE id = ?');
    this._insertVer = db.prepare('INSERT INTO artifact_versions (project_id, artifact_id, path, version, sha256, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this._verAt = db.prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?');
    this._history = db.prepare('SELECT version, sha256, created_at FROM artifact_versions WHERE artifact_id = ? ORDER BY version');
    this._log = db.prepare('INSERT INTO system_log (project_id, level, code, message, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  }

  /** Store a new version of an artifact at `path`. Returns the version metadata. */
  put(projectId, path, body, opts = {}) {
    projectId = String(projectId); path = String(path);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let art = this._artByPath.get(projectId, path);
      if (!art) {
        const seq = this._maxSeq.get(projectId).m + 1;
        const id = `ART-${String(seq).padStart(6, '0')}`;
        this._insertArt.run(id, projectId, seq, path, opts.title || null, nowIso(), nowIso());
        art = this._artByPath.get(projectId, path);
      }
      const version = art.current_version + 1;
      const hash = sha256(body);
      this._insertVer.run(projectId, art.id, path, version, hash, body == null ? '' : String(body), nowIso());
      this._bumpArt.run(version, opts.title || null, nowIso(), art.id);
      this.db.exec('COMMIT');
      return { artifactId: art.id, path, version, sha256: hash };
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
  }

  _artifact(projectId, path) { return this._artByPath.get(String(projectId), String(path)); }

  /**
   * Fetch the authoritative current version, verified against its recorded hash.
   * On mismatch: block with ARTIFACT_INTEGRITY_FAIL and offer the previous
   * verified version instead of serving possibly-corrupted bytes.
   * @returns {{ok:boolean, path:string, version?:number, body?:string,
   *            sha256?:string, error?:string, offered?:object}}
   */
  get(projectId, path) {
    const art = this._artifact(projectId, path);
    if (!art || art.current_version === 0) return { ok: false, path: String(path), error: 'FILE_NOT_FOUND' };
    const row = this._verAt.get(art.id, art.current_version);
    if (sha256(row.body) === row.sha256) {
      return { ok: true, path: row.path, version: row.version, body: row.body, sha256: row.sha256 };
    }
    // Integrity failure — do not deliver. Offer the newest version that verifies.
    this._log.run(String(projectId), 'ERROR', 'ARTIFACT_INTEGRITY_FAIL',
      `hash mismatch on ${path} v${row.version}`, art.id, nowIso());
    let offered = null;
    for (let v = art.current_version - 1; v >= 1; v--) {
      const prev = this._verAt.get(art.id, v);
      if (prev && sha256(prev.body) === prev.sha256) { offered = { version: prev.version, body: prev.body, sha256: prev.sha256 }; break; }
    }
    return { ok: false, path: String(path), error: 'ARTIFACT_INTEGRITY_FAIL', offered };
  }

  /** Verify a specific version (or the current one) against its recorded hash. */
  verify(projectId, path, version) {
    const art = this._artifact(projectId, path);
    if (!art) return false;
    const v = version || art.current_version;
    const row = this._verAt.get(art.id, v);
    return !!row && sha256(row.body) === row.sha256;
  }

  /** Complete version history (version, hash, timestamp) for an artifact. */
  history(projectId, path) {
    const art = this._artifact(projectId, path);
    return art ? this._history.all(art.id) : [];
  }
}

module.exports = { ArtifactStore, sha256 };
