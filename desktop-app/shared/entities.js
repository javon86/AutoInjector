'use strict';
/*
 * shared/entities.js — the typed-entity registry for MDC-002 (Structured Shared
 * Memory). One place defines every entity type: its stable ID prefix and its
 * field schema. Both the schema migration (db.js) and the store (memory.js) are
 * generated from this, so a table and its validation can never drift apart.
 *
 * Every entity, whatever its type, carries the same envelope: a prefixed id, a
 * project_id foreign key, a per-project seq, and created/updated timestamps.
 * (messages are already their own table from SCS-001; artifacts get richer
 * version/hash handling in MDC-008 and are not generic entities here.)
 */

const ENTITIES = {
  task:      { prefix: 'TASK', fields: { title: { required: true }, status: {}, owner: {}, depends_on: {} } },
  character: { prefix: 'CHAR', fields: { name: { required: true }, role: {}, notes: {} } },
  decision:  { prefix: 'DEC',  fields: { summary: { required: true }, ruling: {}, status: {} } },
  timeline:  { prefix: 'TL',   fields: { label: { required: true }, when: {}, notes: {} } },
  fact:      { prefix: 'FACT', fields: { statement: { required: true }, value: {}, source: {} } },
  status:    { prefix: 'STAT', fields: { label: { required: true }, state: {} } },
  image:     { prefix: 'IMG',  fields: { prompt: { required: true }, seed: {}, model: {}, path: {}, from: {}, sha256: {} } },
};

const TYPES = Object.keys(ENTITIES);

function isType(type) { return Object.prototype.hasOwnProperty.call(ENTITIES, type); }
function tableName(type) { return 'mem_' + type; }
function fieldNames(type) { return Object.keys(ENTITIES[type].fields); }
function formatId(type, seq) { return `${ENTITIES[type].prefix}-${String(seq).padStart(6, '0')}`; }

function createTableSql(type) {
  const cols = fieldNames(type).map((c) => `    "${c}" TEXT`).join(',\n');
  return `CREATE TABLE IF NOT EXISTS ${tableName(type)} (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL,
    seq         INTEGER NOT NULL,
${cols},
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE(project_id, seq),
    FOREIGN KEY(project_id) REFERENCES projects(project_id)
  );`;
}

/** SQL that creates every entity table (used by the v3 migration). */
function allEntityTablesSql() {
  return TYPES.map(createTableSql).join('\n\n');
}

module.exports = { ENTITIES, TYPES, isType, tableName, fieldNames, formatId, createTableSql, allEntityTablesSql };
