'use strict';
/*
 * shared/memory.js
 *
 * MDC-002-PG — Structured Shared Memory: typed CRUD over the entity tables
 *   generated from shared/entities.js. Every entity gets a stable prefixed id,
 *   created/updated timestamps and a project_id foreign key; a write is
 *   validated against the type schema and rejected with a specific field-level
 *   reason, and an orphaned row (unknown project) is rejected at write time.
 *
 * MDC-003-PG — Full-Text Project Search: SQLite FTS5 exact word/phrase search
 *   across every entity type, kept in sync as entities are written. If the index
 *   is missing/empty it rebuilds; if FTS fails entirely, search falls back to a
 *   slower LIKE scan flagged DEGRADED rather than returning nothing.
 */
const { ENTITIES, TYPES, isType, tableName, fieldNames, formatId } = require('./entities');

function nowIso() { return new Date().toISOString(); }
function ftsText(type, data) {
  return fieldNames(type).map((f) => data[f]).filter((v) => v != null && v !== '').join(' ');
}

class MemoryStore {
  constructor(db) {
    this.db = db;
    this._stmt = {}; // per-type prepared statements, built lazily
    this._maxSeq = {};
    this._ftsDelete = db.prepare('DELETE FROM mem_fts WHERE entity_id = ?');
    this._ftsInsert = db.prepare('INSERT INTO mem_fts (entity_type, entity_id, project_id, text) VALUES (?, ?, ?, ?)');
  }

  _s(type) {
    if (this._stmt[type]) return this._stmt[type];
    const cols = fieldNames(type);
    const colList = cols.map((c) => `"${c}"`).join(', ');
    const placeholders = cols.map(() => '?').join(', ');
    this._stmt[type] = {
      insert: this.db.prepare(`INSERT INTO ${tableName(type)} (id, project_id, seq, ${colList}, created_at, updated_at) VALUES (?, ?, ?, ${placeholders}, ?, ?)`),
      get: this.db.prepare(`SELECT * FROM ${tableName(type)} WHERE project_id = ? AND id = ?`),
      list: this.db.prepare(`SELECT * FROM ${tableName(type)} WHERE project_id = ? ORDER BY seq`),
      maxSeq: this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM ${tableName(type)} WHERE project_id = ?`),
    };
    return this._stmt[type];
  }

  // Validate a write against the type schema, with a specific field-level reason.
  _validate(type, data, partial) {
    if (!isType(type)) throw new Error(`unknown entity type "${type}"`);
    const fields = ENTITIES[type].fields;
    for (const k of Object.keys(data)) {
      if (!fields[k]) throw new Error(`${type}.${k}: unknown field`);
    }
    if (!partial) {
      for (const [k, spec] of Object.entries(fields)) {
        if (spec.required && (data[k] == null || String(data[k]).trim() === '')) {
          throw new Error(`${type}.${k} is required`);
        }
      }
    }
  }

  /** Create a typed entity. Returns the stored row (with its assigned id). */
  create(type, projectId, data = {}) {
    this._validate(type, data, false);
    const s = this._s(type);
    const cols = fieldNames(type);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const seq = s.maxSeq.get(String(projectId)).m + 1;
      const id = formatId(type, seq);
      const t = nowIso();
      const values = cols.map((c) => (data[c] == null ? null : String(data[c])));
      s.insert.run(id, String(projectId), seq, ...values, t, t); // FK rejects an unknown project here
      this._reindex(type, id, projectId, data);
      this.db.exec('COMMIT');
      return this.get(type, projectId, id);
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
  }

  get(type, projectId, id) {
    if (!isType(type)) throw new Error(`unknown entity type "${type}"`);
    const row = this._s(type).get.get(String(projectId), String(id));
    return row || null;
  }

  list(type, projectId) {
    if (!isType(type)) throw new Error(`unknown entity type "${type}"`);
    return this._s(type).list.all(String(projectId));
  }

  /** Patch an entity's fields (validated). Refreshes the search index. */
  update(type, projectId, id, patch = {}) {
    this._validate(type, patch, true);
    const existing = this.get(type, projectId, id);
    if (!existing) throw new Error(`${type} ${id} not found`);
    const cols = Object.keys(patch);
    if (!cols.length) return existing;
    const set = cols.map((c) => `"${c}" = ?`).join(', ');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`UPDATE ${tableName(type)} SET ${set}, updated_at = ? WHERE project_id = ? AND id = ?`)
        .run(...cols.map((c) => (patch[c] == null ? null : String(patch[c]))), nowIso(), String(projectId), String(id));
      const merged = Object.assign({}, existing, patch);
      this._reindex(type, id, projectId, merged);
      this.db.exec('COMMIT');
      return this.get(type, projectId, id);
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
  }

  _reindex(type, id, projectId, data) {
    this._ftsDelete.run(String(id));
    this._ftsInsert.run(type, String(id), String(projectId), ftsText(type, data));
  }
}

class Search {
  constructor(db) {
    this.db = db;
    this._match = db.prepare('SELECT entity_type, entity_id FROM mem_fts WHERE project_id = ? AND text MATCH ?');
    this._count = db.prepare('SELECT COUNT(*) AS c FROM mem_fts');
  }

  /** Rebuild the FTS index from the entity tables (startup / staleness repair). */
  reindex() {
    this.db.exec('DELETE FROM mem_fts');
    const ins = this.db.prepare('INSERT INTO mem_fts (entity_type, entity_id, project_id, text) VALUES (?, ?, ?, ?)');
    for (const type of TYPES) {
      const rows = this.db.prepare(`SELECT * FROM ${tableName(type)}`).all();
      for (const r of rows) ins.run(type, r.id, r.project_id, ftsText(type, r));
    }
  }

  ensureIndex() {
    // If the index is empty but entities exist, it is stale — rebuild it.
    if (this._count.get().c > 0) return;
    const anyEntities = TYPES.some((t) => this.db.prepare(`SELECT 1 FROM ${tableName(t)} LIMIT 1`).get());
    if (anyEntities) this.reindex();
  }

  /**
   * Exact word/phrase search across every entity type.
   * @returns {{degraded:boolean, results:Array<{type:string,id:string}>}}
   */
  search(projectId, query) {
    try {
      const rows = this._match.all(String(projectId), String(query));
      return { degraded: false, results: rows.map((r) => ({ type: r.entity_type, id: r.entity_id })) };
    } catch (_) {
      return this._likeFallback(projectId, query);
    }
  }

  // Slower LIKE scan across all entity tables when FTS is unavailable.
  _likeFallback(projectId, query) {
    const needle = `%${String(query).replace(/[%_]/g, '')}%`;
    const results = [];
    for (const type of TYPES) {
      const cols = fieldNames(type);
      const where = cols.map((c) => `"${c}" LIKE ?`).join(' OR ');
      const rows = this.db.prepare(`SELECT id FROM ${tableName(type)} WHERE project_id = ? AND (${where})`)
        .all(String(projectId), ...cols.map(() => needle));
      for (const r of rows) results.push({ type, id: r.id });
    }
    return { degraded: true, results };
  }
}

module.exports = { MemoryStore, Search };
