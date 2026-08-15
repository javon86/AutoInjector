'use strict';
/*
 * shared/db.js — MDC-001-PG: Local SQLite Project Database.
 *
 * The central local database every other upgrade subtask writes into. Built on
 * Node's built-in `node:sqlite` (DatabaseSync) so it adds NO new dependency and
 * needs no native rebuild for Electron — consistent with AutoInjector shipping
 * as a double-click app.
 *
 * MDC-001 "Done when": schema is created, migrations are versioned, and the
 * database survives a service restart with all data intact.
 * MDC-001 error handling: WAL mode on; a pre-migration snapshot is taken before
 * any schema change; on corruption detection the service refuses to open a
 * dirty database and restores the last good snapshot rather than continuing on
 * damaged data.
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const entities = require('./entities');

// Ordered, append-only list. Index i in this array corresponds to schema
// version i+1. Never edit a shipped migration — add a new one.
const MIGRATIONS = [
  // v1 — projects, the shared message log, and its dead-letter park.
  `
  CREATE TABLE IF NOT EXISTS projects (
    project_id  TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    rowid       INTEGER PRIMARY KEY AUTOINCREMENT,
    msg_id      TEXT NOT NULL,          -- e.g. MSG-000124 (assigned by AutoInjector)
    project_id  TEXT NOT NULL,
    seq         INTEGER NOT NULL,       -- per-project monotonic counter
    "from"      TEXT NOT NULL,          -- user | chatgpt | claude | gemini | local | system
    "to"        TEXT,
    reply_to    TEXT,
    body        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'CREATED',
    UNIQUE(project_id, seq),
    UNIQUE(project_id, msg_id),
    FOREIGN KEY(project_id) REFERENCES projects(project_id)
  );
  CREATE INDEX IF NOT EXISTS idx_messages_project_seq ON messages(project_id, seq);

  CREATE TABLE IF NOT EXISTS messages_deadletter (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  TEXT,
    payload     TEXT NOT NULL,          -- raw JSON of the attempted message
    error       TEXT,
    attempts    INTEGER,
    parked_at   TEXT NOT NULL
  );
  `,

  // v2 — threading, read positions, delivery tracking, dedup, baselines, and a
  // shared system log (the "nothing fails silently" sink from the spec's global
  // rule). Covers SCS-003, SCS-004, SCS-006, SCS-007, SCS-012.
  `
  ALTER TABLE messages ADD COLUMN content_hash   TEXT;
  ALTER TABLE messages ADD COLUMN routing_status TEXT NOT NULL DEFAULT 'RESOLVED';
  CREATE INDEX IF NOT EXISTS idx_messages_hash ON messages(project_id, content_hash);

  -- SCS-004: how far each model has actually read, per project.
  CREATE TABLE IF NOT EXISTS read_positions (
    project_id  TEXT NOT NULL,
    model       TEXT NOT NULL,
    position    INTEGER NOT NULL DEFAULT 0,   -- last CONFIRMED seq read
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (project_id, model)
  );

  -- SCS-006: per-recipient delivery state for a message.
  CREATE TABLE IF NOT EXISTS deliveries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT NOT NULL,
    msg_id          TEXT NOT NULL,
    recipient       TEXT NOT NULL,
    state           TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|DELIVERED|FAILED|TIMEOUT|RETRY|FAILED_PERMANENT
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    updated_at      TEXT NOT NULL,
    UNIQUE(project_id, msg_id, recipient)
  );

  -- SCS-007: audit of dropped duplicates (kept, not lost).
  CREATE TABLE IF NOT EXISTS message_drops (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT,
    original_msg_id TEXT,
    reason          TEXT NOT NULL,
    content_hash    TEXT,
    dropped_at      TEXT NOT NULL
  );

  -- SCS-012: authoritative baseline, append-only with previous-hash linkage.
  CREATE TABLE IF NOT EXISTS baselines (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  TEXT NOT NULL,
    hash        TEXT NOT NULL,
    prev_hash   TEXT,
    stage       TEXT,
    task_state  TEXT,
    is_current  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_one_current_baseline
    ON baselines(project_id) WHERE is_current = 1;

  -- Global rule: nothing fails silently — every anomaly writes a row here.
  CREATE TABLE IF NOT EXISTS system_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  TEXT,
    level       TEXT NOT NULL DEFAULT 'INFO',   -- INFO | WARN | ERROR
    code        TEXT NOT NULL,                  -- machine code, e.g. DROP_DUPLICATE
    message     TEXT,
    ref_id      TEXT,                           -- affected MSG/JOB/TASK id
    created_at  TEXT NOT NULL
  );
  `,

  // v3 — structured shared memory (MDC-002), artifact version/hash tracking
  // (MDC-008), and a full-text index (MDC-003).
  `
  ${entities.allEntityTablesSql()}

  -- MDC-008: artifacts and their full version/hash history.
  CREATE TABLE IF NOT EXISTS artifacts (
    id              TEXT PRIMARY KEY,           -- ART-000001
    project_id      TEXT NOT NULL,
    seq             INTEGER NOT NULL,
    path            TEXT NOT NULL,
    title           TEXT,
    current_version INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE(project_id, seq),
    UNIQUE(project_id, path),
    FOREIGN KEY(project_id) REFERENCES projects(project_id)
  );
  CREATE TABLE IF NOT EXISTS artifact_versions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    path        TEXT NOT NULL,
    version     INTEGER NOT NULL,
    sha256      TEXT NOT NULL,
    body        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    UNIQUE(artifact_id, version),
    FOREIGN KEY(artifact_id) REFERENCES artifacts(id)
  );

  -- MDC-003: one full-text index across every structured entity type.
  CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
    entity_type UNINDEXED, entity_id UNINDEXED, project_id UNINDEXED, text
  );
  `,

  // v4 — task ownership with leases (SCS-013) and the file-request audit log
  // (MDC-007). The shared file manager (MDC-009) writes to disk and reuses the
  // artifact tables from v3 for versioning.
  `
  CREATE TABLE IF NOT EXISTS task_ownership (
    project_id       TEXT NOT NULL,
    task_id          TEXT NOT NULL,
    owner            TEXT NOT NULL,
    lease_expires_at TEXT,
    claimed_at       TEXT NOT NULL,
    PRIMARY KEY (project_id, task_id)
  );

  CREATE TABLE IF NOT EXISTS file_requests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  TEXT,
    requester   TEXT,
    path        TEXT,
    version     INTEGER,
    result      TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
  `,
];

const PRAGMAS = 'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;';

function ensureParent(file) {
  const dir = path.dirname(path.resolve(file));
  fs.mkdirSync(dir, { recursive: true });
}

function _connect(file) {
  const db = new DatabaseSync(file);
  db.exec(PRAGMAS);
  return db;
}

function _integrityOk(db) {
  try { return db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok'; }
  catch (_) { return false; }
}

function snapshotPathFor(file, tag) {
  return `${path.resolve(file)}.snap-${tag}`;
}

/** Take a consistent snapshot of the open database (safe while in use). */
function snapshot(db, destPath) {
  // VACUUM INTO writes a clean, fully-checkpointed copy atomically.
  db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  return destPath;
}

/** List snapshot files for a database, newest first. */
function listSnapshots(file) {
  const resolved = path.resolve(file);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved) + '.snap-';
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  return names
    .filter((n) => n.startsWith(base))
    .map((n) => path.join(dir, n))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

/** Replace the (closed) database file with the most recent good snapshot. */
function restoreLatestSnapshot(file) {
  const resolved = path.resolve(file);
  for (const snap of listSnapshots(resolved)) {
    // Sidecar WAL/SHM files would otherwise shadow the restored copy.
    for (const side of ['-wal', '-shm']) { try { fs.unlinkSync(resolved + side); } catch (_) {} }
    fs.copyFileSync(snap, resolved);
    // Verify the restored copy really is clean before accepting it.
    const db = _connect(resolved);
    const ok = _integrityOk(db);
    db.close();
    if (ok) return snap;
  }
  return null;
}

function _userVersion(db) {
  return db.prepare('PRAGMA user_version').get().user_version;
}

/**
 * Apply any pending migrations. Versioned via PRAGMA user_version. A
 * pre-migration snapshot is taken first; if a migration throws, the database is
 * restored from that snapshot rather than left half-migrated.
 * @returns {number} the schema version after migrating
 */
function migrate(db, migrations, file) {
  migrations = migrations || MIGRATIONS;
  let v = _userVersion(db);
  if (v >= migrations.length) return v;

  let preSnap = null;
  if (file) {
    try { preSnap = snapshot(db, snapshotPathFor(file, `premig-v${v}-${Date.now()}`)); } catch (_) { preSnap = null; }
  }

  try {
    for (let i = v; i < migrations.length; i++) {
      db.exec('BEGIN');
      db.exec(migrations[i]);
      db.exec(`PRAGMA user_version = ${i + 1};`);
      db.exec('COMMIT');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    if (preSnap) {
      db.close();
      restoreLatestSnapshot(file);
    }
    const err = new Error(`migration failed at version ${v + 1}: ${e.message}`);
    err.cause = e;
    throw err;
  }
  return _userVersion(db);
}

/**
 * Open (creating if needed), self-heal on corruption, and migrate the database.
 * @param {string} file  path to the .db file
 * @param {{migrations?:string[]}} [opts]
 * @returns {import('node:sqlite').DatabaseSync}
 */
function openDatabase(file, opts = {}) {
  ensureParent(file);
  const existed = fs.existsSync(file);
  let db = null;

  try {
    // A damaged file can fail either at connect time (SQLITE_NOTADB thrown) or
    // pass connect but fail the integrity check — treat both as corruption.
    db = _connect(file);
    if (existed && !_integrityOk(db)) { db.close(); db = null; throw new Error('integrity_check failed'); }
  } catch (e) {
    try { if (db) db.close(); } catch (_) {}
    db = null;
    // A brand-new file that cannot open is a genuine error, not corruption.
    if (!existed) throw e;
    // Refuse to run on damaged data. Try the last good snapshot; if there is
    // none, fail loudly instead of silently corrupting further.
    const restored = restoreLatestSnapshot(file);
    if (!restored) {
      throw new Error(`database at ${file} is corrupt and no snapshot is available — refusing to start dirty`);
    }
    db = _connect(file);
    if (!_integrityOk(db)) {
      db.close();
      throw new Error(`database at ${file} is corrupt and the restored snapshot is also damaged`);
    }
  }

  migrate(db, opts.migrations || MIGRATIONS, file);
  return db;
}

module.exports = {
  MIGRATIONS,
  openDatabase,
  migrate,
  snapshot,
  snapshotPathFor,
  listSnapshots,
  restoreLatestSnapshot,
  schemaVersion: _userVersion,
};
