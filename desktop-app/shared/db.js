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

  // v5 — the `image` entity type (Stable Diffusion renders as searchable
  // project records). Fresh databases already get this from v3; this backfills
  // databases created before the type existed.
  `
  ${entities.createTableSql('image')}
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
    try { fs.copyFileSync(snap, resolved); } catch (_) { continue; }
    // Verify the restored copy really is clean before accepting it. A snapshot that is itself damaged can fail
    // at connect time (not a database): try the next one instead of giving up.
    let ok = false;
    try { const db = _connect(resolved); ok = _integrityOk(db); db.close(); } catch (_) { ok = false; }
    if (ok) return snap;
  }
  return null;
}

const KEEP_DAMAGED = 2;      // damaged copies kept beside the database (newest first), for a later rescue
const KEEP_DAILY = 3;        // daily snapshots kept
const DAILY_MS = 24 * 3600 * 1000;

function _stamp(now) {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
}

/** Move a damaged database (and its WAL/SHM sidecars) aside as <file>.damaged-<stamp>; keep the newest few. */
function setAsideDamaged(file, now = Date.now()) {
  const resolved = path.resolve(file);
  const dest = `${resolved}.damaged-${_stamp(now)}`;
  try { fs.renameSync(resolved, dest); } catch (_) {
    try { fs.copyFileSync(resolved, dest); fs.unlinkSync(resolved); } catch (_) { return null; }
  }
  for (const side of ['-wal', '-shm']) {
    try { fs.renameSync(resolved + side, dest + side); } catch (_) { try { fs.unlinkSync(resolved + side); } catch (_) {} }
  }
  const dir = path.dirname(resolved);
  const base = path.basename(resolved) + '.damaged-';
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.startsWith(base) && !/-(wal|shm)$/.test(n)); } catch (_) {}
  names.sort().reverse();
  for (const n of names.slice(KEEP_DAMAGED)) {
    for (const side of ['', '-wal', '-shm']) { try { fs.unlinkSync(path.join(dir, n + side)); } catch (_) {} }
  }
  return dest;
}

/** The ordinary tables of an open database (no SQLite internals, no full-text index tables: those are rebuilt). */
function _plainTables(db, schema = 'main') {
  const rows = db.prepare(`SELECT name, sql FROM ${schema}.sqlite_master WHERE type = 'table'`).all();
  const virt = rows.filter((r) => /^CREATE VIRTUAL TABLE/i.test(r.sql || '')).map((r) => r.name);
  return rows.map((r) => r.name).filter((n) => !n.startsWith('sqlite_') && !virt.includes(n)
    && !virt.some((v) => n.startsWith(v + '_')));
}

function _cols(db, schema, table) {
  return db.prepare(`PRAGMA ${schema}.table_info("${table.replace(/"/g, '""')}")`).all().map((c) => c.name);
}

/**
 * Copy every row that can still be read from a damaged database into a fresh, migrated one (same table names,
 * the columns both have). A table that cannot be read whole is copied row by row, skipping the unreadable rows.
 * Never throws. Returns {tables, rows, skipped}.
 */
function salvageInto(db, damagedFile) {
  const out = { tables: 0, rows: 0, skipped: 0 };
  let attached = false;
  try {
    db.exec('PRAGMA foreign_keys=OFF');
    db.prepare('ATTACH DATABASE ? AS old').run(damagedFile);
    attached = true;
    let oldTables = [];
    try { oldTables = _plainTables(db, 'old'); } catch (_) { return out; }
    for (const t of _plainTables(db, 'main')) {
      if (!oldTables.includes(t)) continue;
      let cols = [];
      try { const have = _cols(db, 'old', t); cols = _cols(db, 'main', t).filter((c) => have.includes(c)); } catch (_) { continue; }
      if (!cols.length) continue;
      const q = (n) => `"${n.replace(/"/g, '""')}"`;
      const list = cols.map(q).join(', ');
      const before = db.prepare(`SELECT COUNT(*) AS n FROM main.${q(t)}`).get().n;
      try {
        db.exec(`INSERT OR IGNORE INTO main.${q(t)} (${list}) SELECT ${list} FROM old.${q(t)}`);
      } catch (_) {
        // The table can't be read in one go: row by row, by rowid, skipping what can't be read
        let ids = [];
        try { ids = db.prepare(`SELECT rowid AS id FROM old.${q(t)}`).all().map((r) => r.id); } catch (_) { ids = []; }
        const ins = db.prepare(`INSERT OR IGNORE INTO main.${q(t)} (${list}) SELECT ${list} FROM old.${q(t)} WHERE rowid = ?`);
        for (const id of ids) { try { ins.run(id); } catch (_) { out.skipped += 1; } }
      }
      const after = db.prepare(`SELECT COUNT(*) AS n FROM main.${q(t)}`).get().n;
      if (after > before) { out.tables += 1; out.rows += after - before; }
    }
  } catch (_) {
    // nothing could be read: the fresh database stays empty
  } finally {
    if (attached) { try { db.exec('DETACH DATABASE old'); } catch (_) {} }
    try { db.exec('PRAGMA foreign_keys=ON'); } catch (_) {}
  }
  return out;
}

/** At most one snapshot a day (VACUUM INTO, safe while in use); keeps the newest KEEP_DAILY. Never throws. */
function dailySnapshot(db, file, now = Date.now()) {
  try {
    const resolved = path.resolve(file);
    const daily = listSnapshots(resolved).filter((s) => /\.snap-daily-/.test(s));
    if (daily.length && now - fs.statSync(daily[0]).mtimeMs < DAILY_MS) return null;
    const dest = snapshot(db, snapshotPathFor(resolved, `daily-${_stamp(now)}`));
    for (const old of listSnapshots(resolved).filter((s) => /\.snap-daily-/.test(s)).slice(KEEP_DAILY)) {
      try { fs.unlinkSync(old); } catch (_) {}
    }
    return dest;
  } catch (_) { return null; }
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
 * On corruption it never runs on the damaged data: the damaged file is moved aside (<file>.damaged-<stamp>, kept),
 * then the newest good snapshot is restored; with none, a fresh database is made and every row that can still be
 * read from the damaged copy is copied into it. What happened goes into opts.report ({repaired, how, ...}).
 * @param {string} file  path to the .db file
 * @param {{migrations?:string[], report?:object, now?:number, daily?:boolean}} [opts]
 * @returns {import('node:sqlite').DatabaseSync}
 */
function openDatabase(file, opts = {}) {
  ensureParent(file);
  const existed = fs.existsSync(file);
  const report = opts.report || {};
  const migrations = opts.migrations || MIGRATIONS;
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
    report.repaired = true;
    report.problem = String((e && e.message) || e).slice(0, 120);
    const damaged = setAsideDamaged(file, opts.now);
    report.damagedCopy = damaged ? path.basename(damaged) : null;
    const restored = restoreLatestSnapshot(file);
    if (restored) {
      report.how = 'snapshot';
      report.snapshot = path.basename(restored);
      db = _connect(file);
      // …plus what is newer in the damaged copy and can still be read (the snapshot's own rows win)
      migrate(db, migrations, null);
      const got = damaged ? salvageInto(db, damaged) : { tables: 0, rows: 0, skipped: 0 };
      report.salvagedRows = got.rows;
      report.skippedRows = got.skipped;
    } else {
      // No good snapshot: a fresh database, with every row that can still be read from the damaged copy
      for (const side of ['', '-wal', '-shm']) { try { fs.unlinkSync(path.resolve(file) + side); } catch (_) {} }
      db = _connect(file);
      migrate(db, migrations, null);
      const got = damaged ? salvageInto(db, damaged) : { tables: 0, rows: 0, skipped: 0 };
      report.how = 'fresh';
      report.salvagedRows = got.rows;
      report.salvagedTables = got.tables;
      report.skippedRows = got.skipped;
    }
  }

  migrate(db, migrations, file);
  if (opts.daily !== false) dailySnapshot(db, file, opts.now);
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
  setAsideDamaged,
  salvageInto,
  dailySnapshot,
  schemaVersion: _userVersion,
};
