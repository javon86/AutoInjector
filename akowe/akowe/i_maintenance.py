"""Set I infrastructure procedures: snapshot retention, verified restore and migration rehearsal.

These are storage-kernel duties (Set I rules), distinct from I09 creative completion:
 * retention_plan: daily snapshots for 7 days + weekly for 4 weeks (policy is a parameter);
 * verify_restore: counts, revision links, every file hash, dangling references and
   representative allowed/denied ACL decisions on a restored ISOLATED root;
 * replay_outbox: idempotent redelivery of pending outbox events (consumer dedupe by event_id);
 * rehearse_migration: back up + verify, migrate an isolated copy, validate invariants,
   record schema version + migration ID with audit, and promote by an atomic pointer switch.
A failure at any step leaves the original environment active and untouched.
"""
from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable

from .canonical import iter_references, sha256_bytes
from . import legacy
from .errors import AkoweError
from .store import SCHEMA_VERSION, Store, new_id, utcnow

COUNT_TABLES = ("records", "heads", "lifecycle", "receipts", "audit", "provenance", "outbox", "approvals",
                "dependency_edges", "grants", "module_state", "binaries", "checkpoints")


def retention_plan(snapshots: list[tuple[str, datetime]], now: datetime, daily: int = 7,
                   weekly: int = 4) -> set[str]:
    """IDs to keep: newest snapshot per day for `daily` days, newest per ISO week for `weekly` weeks."""
    keep, days, weeks = set(), {}, {}
    for sid, at in sorted(snapshots, key=lambda s: s[1], reverse=True):
        age = now - at
        if age <= timedelta(days=daily):
            days.setdefault(at.date(), sid)
        if age <= timedelta(weeks=weekly):
            weeks.setdefault(at.isocalendar()[:2], sid)
    return set(days.values()) | set(weeks.values())


def table_counts(db_path: str | os.PathLike) -> dict[str, int]:
    conn = sqlite3.connect(db_path)
    try:
        return {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in COUNT_TABLES}
    finally:
        conn.close()


def verify_restore(restored: Store, expected_counts: dict[str, int] | None = None,
                   acl_checks: list[tuple[str, str, str, str, bool]] | None = None) -> list[str]:
    """Return problems found in a restored root (empty list = promotable)."""
    problems = []
    if expected_counts is not None:
        got = table_counts(restored.db_path)
        for t, n in expected_counts.items():
            if got.get(t) != n:
                problems.append(f"count mismatch {t}: expected {n}, got {got.get(t)}")
    keys = {(r["project_id"], r["branch_id"], r["record_id"], r["version"]): r["content_hash"]
            for r in restored.query("SELECT project_id, branch_id, record_id, version, content_hash FROM records")}
    for row in restored.query("SELECT * FROM records"):
        if row["representation"] == "JSON_RECORD":
            if sha256_bytes(row["content"]) != row["content_hash"]:
                problems.append(f"record hash mismatch {row['record_id']}@{row['version']}")
            body = json.loads(row["content"].decode("utf-8"))
            for _, ref in iter_references({"d": body.get("data"), "s": body.get("source_refs")}):
                k = (ref["project_id"], ref["branch_id"], ref["record_id"], ref["version"])
                if keys.get(k) != ref["content_hash"]:
                    problems.append(f"dangling reference {row['record_id']}@{row['version']} -> "
                                    f"{ref['record_id']}@{ref['version']}")
        if row["version"] > 1 and (row["project_id"], row["branch_id"], row["record_id"], row["version"] - 1) \
                not in keys:
            problems.append(f"broken revision chain {row['record_id']}@{row['version']}")
    for row in restored.query("SELECT * FROM binaries"):
        p = restored.asset_dir / row["storage_uri"].split("/")[-1]
        if not p.exists() or sha256_bytes(p.read_bytes()) != row["content_hash"]:
            problems.append(f"asset missing or corrupt {row['record_id']}@{row['version']}")
    for principal, project, branch, scope, allowed in acl_checks or []:
        if restored.has_scope(principal, project, branch, scope) != allowed:
            problems.append(f"ACL decision changed for {principal} {project}/{branch} {scope}")
    return problems


def backup_and_restore(store: Store, backup_dir, restore_dir, acl_checks=None) -> tuple[Store, dict]:
    """Snapshot, verify, restore into a NEW isolated root and verify it before promotion."""
    manifest = store.backup(backup_dir)
    expected = table_counts(legacy.db_in(backup_dir))
    restored = Store.restore(backup_dir, restore_dir)  # verifies DB + every asset hash first
    problems = verify_restore(restored, expected, acl_checks)
    if problems:
        restored.close()
        raise AkoweError("HASH_MISMATCH", "", "restore verification failed: " + "; ".join(problems[:5]))
    return restored, {"manifest": manifest, "counts": expected}


def replay_outbox(store: Store, consumer: str, deliver: Callable[[dict], None]) -> int:
    """Deliver undelivered outbox events at least once; consumers dedupe by event_id + hash."""
    n = 0
    for row in store.query("SELECT * FROM outbox WHERE delivered_at IS NULL ORDER BY created_at, event_id"):
        seen = store.query_one("SELECT payload_hash FROM consumed_events WHERE consumer=? AND event_id=?",
                               (consumer, row["event_id"]))
        if seen is not None:
            if seen["payload_hash"] != row["payload_hash"]:
                raise AkoweError("EVENT_CONFLICT", "/event_id", f"event {row['event_id']} content changed")
        else:
            deliver({"event_id": row["event_id"], "event_type": row["event_type"],
                     "payload": json.loads(row["payload"])})
            n += 1
        with store.transaction() as tx:
            tx.execute("INSERT OR IGNORE INTO consumed_events VALUES(?,?,?,?)",
                       (consumer, row["event_id"], row["payload_hash"], utcnow()))
            tx.execute("UPDATE outbox SET delivered_at=? WHERE event_id=?", (utcnow(), row["event_id"]))
    return n


def promote(pointer_file: str | os.PathLike, new_root: str | os.PathLike) -> None:
    """Atomically switch the active storage root pointer (os.replace)."""
    pointer = Path(pointer_file)
    tmp = pointer.with_suffix(".tmp")
    tmp.write_text(json.dumps({"data_dir": str(new_root), "switched_at": utcnow()}))
    os.replace(tmp, pointer)


def rehearse_migration(store: Store, work_dir, *, migration_id: str, from_version: int, to_version: int,
                       migrate: Callable[[sqlite3.Connection], None], principal_id: str,
                       pointer_file=None, acl_checks=None) -> dict:
    """Migration rehearsal on an isolated copy; the original store is never modified."""
    work = Path(work_dir)
    current = int(store.query_one("SELECT value FROM meta WHERE key='schema_version'")["value"])
    if current != from_version or to_version <= from_version:
        raise AkoweError("UNSUPPORTED_CONTRACT", "/schema_version",
                             f"unsupported migration {from_version}->{to_version} (store is at {current})")
    copy_store, info = backup_and_restore(store, work / "snapshot", work / "migrated", acl_checks)
    before = info["counts"]
    with copy_store.transaction() as tx:
        migrate(tx.conn)
        tx.execute("UPDATE meta SET value=? WHERE key='schema_version'", (str(to_version),))
        tx.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('migration_id',?)", (migration_id,))
        for p in {r["project_id"] for r in tx.execute("SELECT project_id FROM projects").fetchall()}:
            tx.insert_audit(project_id=p, branch_id="main", request_id=new_id("migration"),
                            attempt_id=new_id("attempt"), operation_id="I02", action="MIGRATE",
                            principal_id=principal_id, input_refs=[], output_refs=[], outcome="SUCCESS",
                            evidence_type="MIGRATION", evidence_origin="AUTHORITATIVE")
    after = table_counts(copy_store.db_path)
    problems = verify_restore(copy_store, None, acl_checks)
    for t in ("records", "heads", "receipts", "approvals", "grants", "binaries"):
        if after[t] != before[t]:
            problems.append(f"migration changed {t} count {before[t]} -> {after[t]}")
    report = {"migration_id": migration_id, "from": from_version, "to": to_version, "problems": problems,
              "root": str(copy_store.data_dir), "counts_before": before, "counts_after": after,
              "promoted": False, "kernel_schema_version": SCHEMA_VERSION}
    copy_store.close()
    if not problems and pointer_file is not None:
        promote(pointer_file, copy_store.data_dir)
        report["promoted"] = True
    return report
