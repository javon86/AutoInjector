"""I-owned storage kernel: immutable records, heads, receipts, audit, outbox, approvals.

Every mutating action commits in ONE SQLite transaction: record revision(s), head
comparison, provenance, audit, idempotency receipt and outbox events (Shared Contract
section 5). Lifecycle/approval/validation projections are kept apart from the hashed
content bytes (section 10), so ACCEPT/LOCK never change a record's content hash.
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator

from . import CONTRACT_VERSION
from .canonical import canonical_bytes, make_reference, sha256_bytes
from .errors import BookforgeError

SCHEMA_VERSION = 1

LIFECYCLE = ("DRAFT", "VALIDATED", "APPROVED", "LOCKED", "SUPERSEDED", "REJECTED")

DDL = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS principals (
    principal_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, token_sha256 TEXT,
    created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS grants (
    principal_id TEXT NOT NULL, project_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    scope TEXT NOT NULL, granted_at TEXT NOT NULL,
    PRIMARY KEY (principal_id, project_id, branch_id, scope));
CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL,
    settings TEXT NOT NULL, story_time_unit TEXT NOT NULL DEFAULT 'seconds',
    currency TEXT NOT NULL DEFAULT 'USD', created_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS branches (
    project_id TEXT NOT NULL, branch_id TEXT NOT NULL, parent_branch_id TEXT,
    created_at TEXT NOT NULL, PRIMARY KEY (project_id, branch_id));
CREATE TABLE IF NOT EXISTS feature_manifests (
    project_id TEXT NOT NULL, branch_id TEXT NOT NULL, revision INTEGER NOT NULL,
    manifest TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, branch_id, revision));
CREATE TABLE IF NOT EXISTS records (
    project_id TEXT NOT NULL, branch_id TEXT NOT NULL, record_id TEXT NOT NULL,
    version INTEGER NOT NULL, owner TEXT NOT NULL, module_id TEXT NOT NULL,
    representation TEXT NOT NULL, record_kind TEXT NOT NULL,
    contract_version TEXT NOT NULL, content BLOB NOT NULL, content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL, principal_id TEXT NOT NULL, request_id TEXT,
    provenance_id TEXT, evidence_origin TEXT NOT NULL DEFAULT 'AUTHORITATIVE',
    PRIMARY KEY (project_id, branch_id, record_id, version));
CREATE INDEX IF NOT EXISTS records_module ON records(project_id, branch_id, module_id);
CREATE TABLE IF NOT EXISTS binaries (
    project_id TEXT NOT NULL, branch_id TEXT NOT NULL, record_id TEXT NOT NULL,
    version INTEGER NOT NULL, mime_type TEXT NOT NULL, byte_length INTEGER NOT NULL,
    storage_uri TEXT NOT NULL, content_hash TEXT NOT NULL,
    PRIMARY KEY (project_id, branch_id, record_id, version));
CREATE TABLE IF NOT EXISTS lifecycle (
    project_id TEXT NOT NULL, branch_id TEXT NOT NULL, record_id TEXT NOT NULL,
    version INTEGER NOT NULL, state TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0,
    stale_reason TEXT, findings TEXT NOT NULL DEFAULT '[]', validation_audit_id TEXT,
    approval_ids TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, branch_id, record_id, version));
CREATE TABLE IF NOT EXISTS heads (
    project_id TEXT NOT NULL, branch_id TEXT NOT NULL, record_id TEXT NOT NULL,
    module_id TEXT NOT NULL, latest_version INTEGER NOT NULL, approved_version INTEGER,
    PRIMARY KEY (project_id, branch_id, record_id));
CREATE TABLE IF NOT EXISTS receipts (
    project_id TEXT NOT NULL, branch_id TEXT NOT NULL, target_operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, response TEXT NOT NULL,
    receipt_id TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, branch_id, target_operation, idempotency_key));
CREATE TABLE IF NOT EXISTS audit (
    audit_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    request_id TEXT NOT NULL, attempt_id TEXT NOT NULL, operation_id TEXT NOT NULL,
    action TEXT NOT NULL, principal_id TEXT NOT NULL, input_refs TEXT NOT NULL,
    output_refs TEXT NOT NULL, outcome TEXT NOT NULL, evidence_type TEXT NOT NULL,
    schema_version TEXT NOT NULL, evidence_origin TEXT NOT NULL, recorded_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS audit_project ON audit(project_id, branch_id, recorded_at);
CREATE TABLE IF NOT EXISTS provenance (
    provenance_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    record_id TEXT NOT NULL, version INTEGER NOT NULL, content_hash TEXT NOT NULL,
    operation_id TEXT NOT NULL, request_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
    principal_id TEXT NOT NULL, input_refs TEXT NOT NULL, transform TEXT NOT NULL,
    resource TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (
    event_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    event_type TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL,
    created_at TEXT NOT NULL, delivered_at TEXT);
CREATE TABLE IF NOT EXISTS consumed_events (
    consumer TEXT NOT NULL, event_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
    consumed_at TEXT NOT NULL, PRIMARY KEY (consumer, event_id));
CREATE TABLE IF NOT EXISTS approvals (
    approval_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    subject_ref TEXT NOT NULL, action_hash TEXT NOT NULL, approver_id TEXT NOT NULL,
    scopes TEXT NOT NULL, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0, decision TEXT NOT NULL, evidence_origin TEXT NOT NULL,
    body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS dependency_edges (
    edge_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    producer_record_id TEXT NOT NULL, producer_version INTEGER NOT NULL,
    producer_module TEXT NOT NULL, consumer_operation TEXT NOT NULL,
    consumer_record_id TEXT NOT NULL, consumer_version INTEGER NOT NULL,
    paths TEXT NOT NULL, kind TEXT NOT NULL, stage TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS edges_producer ON dependency_edges(project_id, branch_id, producer_record_id);
CREATE TABLE IF NOT EXISTS checkpoints (
    checkpoint_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    request_id TEXT NOT NULL, operation_id TEXT NOT NULL, stage TEXT NOT NULL,
    state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS module_state (
    project_id TEXT NOT NULL, branch_id TEXT NOT NULL, namespace TEXT NOT NULL,
    key TEXT NOT NULL, value TEXT NOT NULL, revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL, PRIMARY KEY (project_id, branch_id, namespace, key));
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
"""


def utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:20]}"


class CrashInjected(RuntimeError):
    """Raised by fault-injection hooks in tests to simulate a crash mid-commit."""


class Store:
    def __init__(self, data_dir: str | os.PathLike):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.asset_dir = self.data_dir / "assets"
        self.asset_dir.mkdir(exist_ok=True)
        self.db_path = self.data_dir / "bookforge.sqlite3"
        self._local = threading.local()
        self.fault_hook: Callable[[str], None] | None = None
        with self.connection() as conn:
            conn.executescript(DDL)
            conn.execute("INSERT OR IGNORE INTO meta(key,value) VALUES('schema_version',?)", (str(SCHEMA_VERSION),))
            conn.commit()

    # ------------------------------------------------------------------ connections
    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.db_path, timeout=30, isolation_level=None, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=FULL")
            conn.execute("PRAGMA foreign_keys=ON")
            self._local.conn = conn
        yield conn

    @contextmanager
    def transaction(self) -> Iterator["Tx"]:
        """BEGIN IMMEDIATE ... COMMIT; any exception rolls back everything (no partial history)."""
        with self.connection() as conn:
            if conn.in_transaction:
                # Nested use joins the outer transaction.
                yield Tx(self, conn)
                return
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield Tx(self, conn)
                self._fault("before_commit")
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
        self._fault("after_commit")

    def _fault(self, point: str):
        if self.fault_hook:
            self.fault_hook(point)

    def close(self):
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
            self._local.conn = None

    # ------------------------------------------------------------------ reads
    def query(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        with self.connection() as conn:
            return list(conn.execute(sql, args))

    def query_one(self, sql: str, args: tuple = ()) -> sqlite3.Row | None:
        rows = self.query(sql, args)
        return rows[0] if rows else None

    def get_record(self, project_id: str, branch_id: str, record_id: str, version: int | None = None) -> dict | None:
        if version is None:
            head = self.query_one("SELECT latest_version FROM heads WHERE project_id=? AND branch_id=? AND record_id=?",
                                  (project_id, branch_id, record_id))
            if not head:
                return None
            version = head["latest_version"]
        row = self.query_one(
            "SELECT * FROM records WHERE project_id=? AND branch_id=? AND record_id=? AND version=?",
            (project_id, branch_id, record_id, int(version)))
        return self._row_to_record(row) if row else None

    def _row_to_record(self, row: sqlite3.Row) -> dict:
        body = json.loads(row["content"].decode("utf-8")) if row["representation"] == "JSON_RECORD" else None
        rec = {
            "project_id": row["project_id"], "branch_id": row["branch_id"], "record_id": row["record_id"],
            "version": row["version"], "owner": row["owner"], "module_id": row["module_id"],
            "representation": row["representation"], "record_kind": row["record_kind"],
            "contract_version": row["contract_version"], "content_hash": row["content_hash"],
            "created_at": row["created_at"], "principal_id": row["principal_id"],
            "request_id": row["request_id"], "provenance_id": row["provenance_id"],
            "evidence_origin": row["evidence_origin"],
            "data": body["data"] if body else None,
            "source_refs": body["source_refs"] if body else json.loads(row["content"].decode("utf-8")).get("source_refs", []),
        }
        if row["representation"] == "BINARY_ARTIFACT":
            rec["binary"] = json.loads(row["content"].decode("utf-8"))
        lc = self.query_one("SELECT * FROM lifecycle WHERE project_id=? AND branch_id=? AND record_id=? AND version=?",
                            (row["project_id"], row["branch_id"], row["record_id"], row["version"]))
        head = self.query_one("SELECT * FROM heads WHERE project_id=? AND branch_id=? AND record_id=?",
                              (row["project_id"], row["branch_id"], row["record_id"]))
        rec["lifecycle"] = lc["state"] if lc else "DRAFT"
        rec["stale"] = bool(lc["stale"]) if lc else False
        rec["stale_reason"] = lc["stale_reason"] if lc else None
        rec["findings"] = json.loads(lc["findings"]) if lc else []
        rec["approval_ids"] = json.loads(lc["approval_ids"]) if lc else []
        rec["latest_version"] = head["latest_version"] if head else row["version"]
        rec["approved_version"] = head["approved_version"] if head else None
        rec["ref"] = make_reference(row["project_id"], row["branch_id"], row["module_id"], row["record_id"],
                                    row["version"], row["content_hash"])
        return rec

    def read_binary(self, rec: dict) -> bytes:
        meta = rec.get("binary") or {}
        path = self.asset_dir / meta["storage_uri"].split("/")[-1]
        data = path.read_bytes()
        if sha256_bytes(data) != rec["content_hash"]:
            raise BookforgeError("HASH_MISMATCH", "/content_hash", "stored artifact bytes do not match their hash")
        return data

    def list_records(self, project_id: str, branch_id: str, module_id: str | None = None,
                     record_kind: str | None = None, heads_only: bool = True) -> list[dict]:
        sql = ("SELECT r.* FROM records r JOIN heads h ON h.project_id=r.project_id AND h.branch_id=r.branch_id "
               "AND h.record_id=r.record_id WHERE r.project_id=? AND r.branch_id=?")
        args: list = [project_id, branch_id]
        if heads_only:
            sql += " AND r.version=h.latest_version"
        if module_id:
            sql += " AND r.module_id=?"
            args.append(module_id)
        if record_kind:
            sql += " AND r.record_kind=?"
            args.append(record_kind)
        sql += " ORDER BY r.created_at, r.record_id, r.version"
        return [self._row_to_record(r) for r in self.query(sql, tuple(args))]

    def history(self, project_id: str, branch_id: str, record_id: str) -> list[dict]:
        rows = self.query("SELECT * FROM records WHERE project_id=? AND branch_id=? AND record_id=? ORDER BY version",
                          (project_id, branch_id, record_id))
        return [self._row_to_record(r) for r in rows]

    def receipt(self, project_id, branch_id, target_operation, idempotency_key) -> sqlite3.Row | None:
        return self.query_one("SELECT * FROM receipts WHERE project_id=? AND branch_id=? AND target_operation=? "
                              "AND idempotency_key=?", (project_id, branch_id, target_operation, idempotency_key))

    # ------------------------------------------------------------------ projects / auth
    def project(self, project_id: str) -> sqlite3.Row | None:
        return self.query_one("SELECT * FROM projects WHERE project_id=?", (project_id,))

    def branch_exists(self, project_id: str, branch_id: str) -> bool:
        return self.query_one("SELECT 1 FROM branches WHERE project_id=? AND branch_id=?", (project_id, branch_id)) is not None

    def scopes_for(self, principal_id: str, project_id: str, branch_id: str) -> set[str]:
        rows = self.query("SELECT scope FROM grants WHERE principal_id=? AND project_id IN (?, '*') "
                          "AND branch_id IN (?, '*')", (principal_id, project_id, branch_id))
        return {r["scope"] for r in rows}

    def has_scope(self, principal_id: str, project_id: str, branch_id: str, scope: str) -> bool:
        scopes = self.scopes_for(principal_id, project_id, branch_id)
        op = scope.split(":")[0]
        return bool(scopes & {scope, f"{op}:*", f"{op[0]}*:*", "*"})

    def has_project_access(self, principal_id: str, project_id: str, branch_id: str | None = None) -> bool:
        if branch_id is None:
            return self.query_one("SELECT 1 FROM grants WHERE principal_id=? AND project_id IN (?, '*')",
                                  (principal_id, project_id)) is not None
        return bool(self.scopes_for(principal_id, project_id, branch_id))

    def projects_for(self, principal_id: str) -> list[sqlite3.Row]:
        return self.query("SELECT DISTINCT p.* FROM projects p JOIN grants g ON g.project_id IN (p.project_id,'*') "
                          "WHERE g.principal_id=? AND p.archived=0 ORDER BY p.created_at", (principal_id,))

    def feature_manifest(self, project_id: str, branch_id: str) -> dict | None:
        row = self.query_one("SELECT manifest FROM feature_manifests WHERE project_id=? AND branch_id=? "
                             "ORDER BY revision DESC LIMIT 1", (project_id, branch_id))
        return json.loads(row["manifest"]) if row else None

    # ------------------------------------------------------------------ settings / module state
    def get_setting(self, key: str, default=None):
        row = self.query_one("SELECT value FROM settings WHERE key=?", (key,))
        return json.loads(row["value"]) if row else default

    def set_setting(self, key: str, value):
        with self.transaction() as tx:
            tx.conn.execute("INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE "
                            "SET value=excluded.value, updated_at=excluded.updated_at",
                            (key, json.dumps(value), utcnow()))

    def get_state(self, project_id, branch_id, namespace, key, default=None):
        row = self.query_one("SELECT value, revision FROM module_state WHERE project_id=? AND branch_id=? AND "
                             "namespace=? AND key=?", (project_id, branch_id, namespace, key))
        return json.loads(row["value"]) if row else default

    def list_state(self, project_id, branch_id, namespace) -> dict:
        rows = self.query("SELECT key, value FROM module_state WHERE project_id=? AND branch_id=? AND namespace=? "
                          "ORDER BY key", (project_id, branch_id, namespace))
        return {r["key"]: json.loads(r["value"]) for r in rows}

    # ------------------------------------------------------------------ backup / restore
    def backup(self, dest_dir: str | os.PathLike) -> dict:
        """Transaction-consistent snapshot of DB + asset bytes with a SHA-256 manifest.

        Credentials live in the secret store (outside the DB) and are excluded.
        """
        dest = Path(dest_dir)
        dest.mkdir(parents=True, exist_ok=True)
        with self.connection() as conn:
            target = sqlite3.connect(dest / "bookforge.sqlite3")
            conn.backup(target)
            target.close()
        (dest / "assets").mkdir(exist_ok=True)
        files = {}
        for f in sorted(self.asset_dir.iterdir()):
            shutil.copy2(f, dest / "assets" / f.name)
            files[f.name] = sha256_bytes(f.read_bytes())
        manifest = {"schema_version": SCHEMA_VERSION, "created_at": utcnow(),
                    "db_sha256": sha256_bytes((dest / "bookforge.sqlite3").read_bytes()), "assets": files}
        (dest / "manifest.json").write_text(json.dumps(manifest, indent=2))
        return manifest

    @staticmethod
    def verify_backup(src_dir: str | os.PathLike) -> list[str]:
        """Verify a snapshot before promotion: DB hash, every asset hash, revision links, refs."""
        src = Path(src_dir)
        problems = []
        try:
            manifest = json.loads((src / "manifest.json").read_text())
        except (OSError, ValueError) as exc:
            return [f"manifest unreadable: {exc}"]
        db = src / "bookforge.sqlite3"
        if not db.exists() or sha256_bytes(db.read_bytes()) != manifest.get("db_sha256"):
            problems.append("database hash mismatch")
        for name, digest in manifest.get("assets", {}).items():
            p = src / "assets" / name
            if not p.exists():
                problems.append(f"missing asset {name}")
            elif sha256_bytes(p.read_bytes()) != digest:
                problems.append(f"asset hash mismatch {name}")
        if not problems:
            conn = sqlite3.connect(db)
            conn.row_factory = sqlite3.Row
            for row in conn.execute("SELECT * FROM records"):
                if row["representation"] == "JSON_RECORD" and sha256_bytes(row["content"]) != row["content_hash"]:
                    problems.append(f"record hash mismatch {row['record_id']}@{row['version']}")
                if row["version"] > 1 and not conn.execute(
                        "SELECT 1 FROM records WHERE project_id=? AND branch_id=? AND record_id=? AND version=?",
                        (row["project_id"], row["branch_id"], row["record_id"], row["version"] - 1)).fetchone():
                    problems.append(f"broken revision chain {row['record_id']}@{row['version']}")
            for row in conn.execute("SELECT * FROM binaries"):
                name = row["storage_uri"].split("/")[-1]
                if name not in manifest.get("assets", {}):
                    problems.append(f"binary {row['record_id']} not in snapshot")
            conn.close()
        return problems

    @classmethod
    def restore(cls, src_dir: str | os.PathLike, new_data_dir: str | os.PathLike) -> "Store":
        """Restore into a NEW isolated root; refuse promotion when verification fails."""
        problems = cls.verify_backup(src_dir)
        if problems:
            raise BookforgeError("HASH_MISMATCH", "", "restore verification failed: " + "; ".join(problems[:5]))
        src, dst = Path(src_dir), Path(new_data_dir)
        if dst.exists() and any(dst.iterdir()):
            raise BookforgeError("INVALID_INPUT", "", "restore target must be a new empty directory")
        dst.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src / "bookforge.sqlite3", dst / "bookforge.sqlite3")
        shutil.copytree(src / "assets", dst / "assets")
        return cls(dst)


class Tx:
    """Write helpers usable only inside Store.transaction()."""

    def __init__(self, store: Store, conn: sqlite3.Connection):
        self.store = store
        self.conn = conn

    def execute(self, sql: str, args: tuple = ()):
        return self.conn.execute(sql, args)

    # -- projects / principals
    def ensure_principal(self, principal_id: str, display_name: str | None = None, token_sha256: str | None = None):
        self.conn.execute("INSERT OR IGNORE INTO principals(principal_id, display_name, token_sha256, created_at) "
                          "VALUES(?,?,?,?)", (principal_id, display_name or principal_id, token_sha256, utcnow()))
        if token_sha256:
            self.conn.execute("UPDATE principals SET token_sha256=? WHERE principal_id=?", (token_sha256, principal_id))

    def grant(self, principal_id: str, project_id: str, branch_id: str, scope: str):
        self.conn.execute("INSERT OR IGNORE INTO grants VALUES(?,?,?,?,?)",
                          (principal_id, project_id, branch_id, scope, utcnow()))

    def revoke(self, principal_id: str, project_id: str, branch_id: str, scope: str):
        self.conn.execute("DELETE FROM grants WHERE principal_id=? AND project_id=? AND branch_id=? AND scope=?",
                          (principal_id, project_id, branch_id, scope))

    def create_project(self, project_id: str, name: str, owner_id: str, settings: dict,
                       story_time_unit: str = "seconds", currency: str = "USD"):
        self.conn.execute("INSERT INTO projects(project_id,name,owner_id,settings,story_time_unit,currency,created_at) "
                          "VALUES(?,?,?,?,?,?,?)", (project_id, name, owner_id, json.dumps(settings),
                                                    story_time_unit, currency, utcnow()))
        self.conn.execute("INSERT INTO branches VALUES(?,?,?,?)", (project_id, "main", None, utcnow()))

    def create_branch(self, project_id: str, branch_id: str, parent_branch_id: str | None):
        self.conn.execute("INSERT INTO branches VALUES(?,?,?,?)", (project_id, branch_id, parent_branch_id, utcnow()))

    def put_feature_manifest(self, manifest: dict) -> dict:
        row = self.conn.execute("SELECT MAX(revision) AS r FROM feature_manifests WHERE project_id=? AND branch_id=?",
                                (manifest["project_id"], manifest["branch_id"])).fetchone()
        manifest = dict(manifest, revision=(row["r"] or 0) + 1)
        self.conn.execute("INSERT INTO feature_manifests VALUES(?,?,?,?,?,?)",
                          (manifest["project_id"], manifest["branch_id"], manifest["revision"],
                           json.dumps(manifest), sha256_bytes(canonical_bytes(manifest)), utcnow()))
        return manifest

    # -- records
    def insert_json_record(self, *, project_id: str, branch_id: str, module_id: str, record_id: str,
                           version: int, data: Any, source_refs: list, principal_id: str,
                           record_kind: str = "OUTPUT", request_id: str | None = None,
                           provenance_id: str | None = None, evidence_origin: str = "AUTHORITATIVE",
                           expected_latest: int | None = None, state: str = "DRAFT",
                           findings: list | None = None) -> dict:
        """Append an immutable JSON revision. expected_latest enforces CAS on the head."""
        self._check_head(project_id, branch_id, record_id, module_id, version, expected_latest)
        body = {"project_id": project_id, "branch_id": branch_id, "owner": module_id[0], "module_id": module_id,
                "record_id": record_id, "version": version, "contract_version": CONTRACT_VERSION,
                "data": data, "source_refs": source_refs}
        content = canonical_bytes(body)
        content_hash = sha256_bytes(content)
        self.conn.execute(
            "INSERT INTO records(project_id,branch_id,record_id,version,owner,module_id,representation,record_kind,"
            "contract_version,content,content_hash,created_at,principal_id,request_id,provenance_id,evidence_origin) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (project_id, branch_id, record_id, version, module_id[0], module_id, "JSON_RECORD", record_kind,
             CONTRACT_VERSION, content, content_hash, utcnow(), principal_id, request_id, provenance_id,
             evidence_origin))
        self._advance_head(project_id, branch_id, record_id, module_id, version, state, findings)
        return make_reference(project_id, branch_id, module_id, record_id, version, content_hash)

    def insert_binary_record(self, *, project_id: str, branch_id: str, module_id: str, record_id: str,
                             version: int, data: bytes, mime_type: str, source_refs: list,
                             principal_id: str, record_kind: str = "BINARY", request_id: str | None = None,
                             provenance_id: str | None = None, evidence_origin: str = "AUTHORITATIVE",
                             expected_latest: int | None = None) -> dict:
        self._check_head(project_id, branch_id, record_id, module_id, version, expected_latest)
        content_hash = sha256_bytes(data)
        fname = f"{content_hash}.bin"
        path = self.store.asset_dir / fname
        if not path.exists():
            tmp = path.with_suffix(".tmp-" + uuid.uuid4().hex[:8])
            tmp.write_bytes(data)
            os.replace(tmp, path)
        storage_uri = f"bookforge-asset://{project_id}/{branch_id}/{fname}"
        meta = {"record_id": record_id, "project_id": project_id, "branch_id": branch_id, "owner": module_id[0],
                "module_id": module_id, "version": version, "mime_type": mime_type, "byte_length": len(data),
                "storage_uri": storage_uri, "content_hash": content_hash, "source_refs": source_refs}
        self.conn.execute(
            "INSERT INTO records(project_id,branch_id,record_id,version,owner,module_id,representation,record_kind,"
            "contract_version,content,content_hash,created_at,principal_id,request_id,provenance_id,evidence_origin) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (project_id, branch_id, record_id, version, module_id[0], module_id, "BINARY_ARTIFACT", record_kind,
             CONTRACT_VERSION, canonical_bytes(meta), content_hash, utcnow(), principal_id, request_id,
             provenance_id, evidence_origin))
        self.conn.execute("INSERT INTO binaries VALUES(?,?,?,?,?,?,?,?)",
                          (project_id, branch_id, record_id, version, mime_type, len(data), storage_uri, content_hash))
        self._advance_head(project_id, branch_id, record_id, module_id, version, "DRAFT", None)
        return make_reference(project_id, branch_id, module_id, record_id, version, content_hash)

    def _check_head(self, project_id, branch_id, record_id, module_id, version, expected_latest):
        head = self.conn.execute("SELECT * FROM heads WHERE project_id=? AND branch_id=? AND record_id=?",
                                 (project_id, branch_id, record_id)).fetchone()
        if version == 1:
            if head is not None:
                raise BookforgeError("VERSION_CONFLICT", "/base_ref", "record already exists", status="REJECTED")
        else:
            if head is None:
                raise BookforgeError("NOT_FOUND", "/base_ref", "record not found")
            if head["module_id"] != module_id:
                raise BookforgeError("INVALID_INPUT", "/base_ref/module_id", "ownership mismatch")
            latest = head["latest_version"]
            if expected_latest is not None and latest != expected_latest:
                raise BookforgeError("VERSION_CONFLICT", "/base_ref/version",
                                     f"stale base version {expected_latest}; head is {latest}", status="REJECTED")
            if version != latest + 1:
                raise BookforgeError("VERSION_CONFLICT", "/base_ref/version", "revisions increase by exactly one",
                                     status="REJECTED")

    def _advance_head(self, project_id, branch_id, record_id, module_id, version, state, findings):
        self.conn.execute(
            "INSERT INTO heads(project_id,branch_id,record_id,module_id,latest_version,approved_version) "
            "VALUES(?,?,?,?,?,NULL) ON CONFLICT(project_id,branch_id,record_id) DO UPDATE SET "
            "latest_version=excluded.latest_version", (project_id, branch_id, record_id, module_id, version))
        self.conn.execute("INSERT INTO lifecycle(project_id,branch_id,record_id,version,state,findings,updated_at) "
                          "VALUES(?,?,?,?,?,?,?)", (project_id, branch_id, record_id, version, state,
                                                    json.dumps(findings or []), utcnow()))

    def set_lifecycle(self, ref: dict, state: str, findings: list | None = None, validation_audit_id: str | None = None,
                      approval_id: str | None = None):
        if state not in LIFECYCLE:
            raise ValueError(state)
        key = (ref["project_id"], ref["branch_id"], ref["record_id"], ref["version"])
        row = self.conn.execute("SELECT approval_ids FROM lifecycle WHERE project_id=? AND branch_id=? AND "
                                "record_id=? AND version=?", key).fetchone()
        approvals = json.loads(row["approval_ids"]) if row else []
        if approval_id:
            approvals.append(approval_id)
        sets = ["state=?", "updated_at=?", "approval_ids=?"]
        args: list = [state, utcnow(), json.dumps(approvals)]
        if findings is not None:
            sets.append("findings=?")
            args.append(json.dumps(findings))
        if validation_audit_id:
            sets.append("validation_audit_id=?")
            args.append(validation_audit_id)
        if state in ("APPROVED", "LOCKED"):
            sets.append("stale=0")
            sets.append("stale_reason=NULL")
        self.conn.execute(f"UPDATE lifecycle SET {', '.join(sets)} WHERE project_id=? AND branch_id=? AND "
                          f"record_id=? AND version=?", tuple(args) + key)

    def set_approved_head(self, ref: dict):
        prev = self.conn.execute("SELECT approved_version FROM heads WHERE project_id=? AND branch_id=? AND record_id=?",
                                 (ref["project_id"], ref["branch_id"], ref["record_id"])).fetchone()
        if prev and prev["approved_version"] and prev["approved_version"] != ref["version"]:
            self.conn.execute("UPDATE lifecycle SET state='SUPERSEDED', updated_at=? WHERE project_id=? AND "
                              "branch_id=? AND record_id=? AND version=?",
                              (utcnow(), ref["project_id"], ref["branch_id"], ref["record_id"], prev["approved_version"]))
        self.conn.execute("UPDATE heads SET approved_version=? WHERE project_id=? AND branch_id=? AND record_id=?",
                          (ref["version"], ref["project_id"], ref["branch_id"], ref["record_id"]))
        return prev["approved_version"] if prev else None

    def mark_stale(self, project_id, branch_id, record_id, version, reason: str):
        self.conn.execute("UPDATE lifecycle SET stale=1, stale_reason=?, updated_at=? WHERE project_id=? AND "
                          "branch_id=? AND record_id=? AND version=?",
                          (reason, utcnow(), project_id, branch_id, record_id, version))

    # -- evidence
    def insert_audit(self, *, project_id, branch_id, request_id, attempt_id, operation_id, action, principal_id,
                     input_refs, output_refs, outcome, evidence_type, evidence_origin="AUTHORITATIVE") -> str:
        audit_id = new_id("audit")
        self.conn.execute("INSERT INTO audit VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                          (audit_id, project_id, branch_id, request_id, attempt_id, operation_id, action, principal_id,
                           json.dumps(input_refs), json.dumps(output_refs), outcome, evidence_type,
                           CONTRACT_VERSION, evidence_origin, utcnow()))
        return audit_id

    def insert_provenance(self, *, provenance_id, ref, operation_id, request_id, attempt_id, principal_id,
                          input_refs, transform, resource=None):
        self.conn.execute("INSERT INTO provenance VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                          (provenance_id, ref["project_id"], ref["branch_id"], ref["record_id"], ref["version"],
                           ref["content_hash"], operation_id, request_id, attempt_id, principal_id,
                           json.dumps(input_refs), transform, json.dumps(resource) if resource else None, utcnow()))

    def insert_outbox(self, project_id, branch_id, event_type: str, payload: dict, event_id: str | None = None) -> str:
        event_id = event_id or new_id("evt")
        payload_hash = sha256_bytes(canonical_bytes(payload))
        existing = self.conn.execute("SELECT payload_hash FROM outbox WHERE event_id=?", (event_id,)).fetchone()
        if existing:
            if existing["payload_hash"] != payload_hash:
                raise BookforgeError("EVENT_CONFLICT", "/event_id", "event_id reused with different content")
            return event_id
        self.conn.execute("INSERT INTO outbox VALUES(?,?,?,?,?,?,?,NULL)",
                          (event_id, project_id, branch_id, event_type, json.dumps(payload), payload_hash, utcnow()))
        return event_id

    def insert_receipt(self, project_id, branch_id, target_operation, idempotency_key, request_hash, response) -> str:
        receipt_id = new_id("rcpt")
        self.conn.execute("INSERT INTO receipts VALUES(?,?,?,?,?,?,?,?)",
                          (project_id, branch_id, target_operation, idempotency_key, request_hash,
                           json.dumps(response), receipt_id, utcnow()))
        return receipt_id

    def insert_approval(self, body: dict, project_id: str, branch_id: str):
        self.conn.execute("INSERT INTO approvals VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                          (body["approval_id"], project_id, branch_id, json.dumps(body["subject_ref"]),
                           body["action_hash"], body["approver_id"], json.dumps(body["scopes"]), body["issued_at"],
                           body["expires_at"], int(body["revoked"]), body["decision"], body["evidence_origin"],
                           json.dumps(body)))

    def insert_edge(self, *, project_id, branch_id, producer_ref, consumer_operation, consumer_ref, paths, kind, stage):
        self.conn.execute("INSERT INTO dependency_edges VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                          (new_id("edge"), project_id, branch_id, producer_ref["record_id"], producer_ref["version"],
                           producer_ref["module_id"], consumer_operation, consumer_ref["record_id"],
                           consumer_ref["version"], json.dumps(paths), kind, stage, utcnow()))

    def put_checkpoint(self, checkpoint_id, project_id, branch_id, request_id, operation_id, stage, state: dict):
        now = utcnow()
        self.conn.execute("INSERT INTO checkpoints VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(checkpoint_id) DO UPDATE SET "
                          "stage=excluded.stage, state=excluded.state, updated_at=excluded.updated_at",
                          (checkpoint_id, project_id, branch_id, request_id, operation_id, stage, json.dumps(state),
                           now, now))

    def put_state(self, project_id, branch_id, namespace, key, value, expected_revision: int | None = None) -> int:
        """Module-private durable state with optional compare-and-set on revision."""
        row = self.conn.execute("SELECT revision FROM module_state WHERE project_id=? AND branch_id=? AND namespace=? "
                                "AND key=?", (project_id, branch_id, namespace, key)).fetchone()
        current = row["revision"] if row else 0
        if expected_revision is not None and expected_revision != current:
            raise BookforgeError("VERSION_CONFLICT", "", f"state {namespace}/{key} changed concurrently",
                                 status="REJECTED")
        self.conn.execute("INSERT INTO module_state VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,branch_id,namespace,key) "
                          "DO UPDATE SET value=excluded.value, revision=excluded.revision, updated_at=excluded.updated_at",
                          (project_id, branch_id, namespace, key, json.dumps(value), current + 1, utcnow()))
        return current + 1
