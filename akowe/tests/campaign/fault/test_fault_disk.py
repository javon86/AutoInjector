"""Disk problems (fault campaign): disk full / unwritable targets during backups and uploads, truncated / deleted /
corrupted asset files, a corrupted database, tampered backups and backups from another schema version."""
from __future__ import annotations

import errno
import json
import os
import shutil
import sqlite3
import types
from pathlib import Path

import pytest

import akowe.store as store_mod
from akowe.canonical import sha256_bytes
from akowe.errors import AkoweError
from akowe.requests import build_request
from akowe.server import App
from akowe.store import Store

from fault_helpers import TOKEN, check_store

CONFIRM = {"author_confirms": True, "confirm": "RESTORE"}


@pytest.fixture
def app(tmp_path):
    a = App(tmp_path / "data", token=TOKEN)
    a.engine.providers.secret_path = tmp_path / "secrets.json"
    yield a
    a.store.close()


def _book(app, n_assets=1):
    pid = app.engine.bootstrap_project("author", "Disk book")
    ups = [app.upload("author", pid, "main", f"asset-bytes-{i}-".encode() * 200, {"Content-Type": "image/png"})
           for i in range(n_assets)]
    return pid, ups


def _asset_path(app, up):
    return app.store.asset_dir / f"{up['ref']['content_hash']}.bin"


def _route(app, method, path, body=None):
    return app.route(method, path, {}, body, "author", {})


# ---------------------------------------------------------------------------------------------- asset damage
def test_backup_of_a_truncated_asset_is_not_verified(app):
    pid, (up,) = _book(app)
    p = _asset_path(app, up)
    p.write_bytes(p.read_bytes()[:10])
    b = app.backups.backup("manual")
    assert b["verified"] is False


def test_restore_from_a_good_backup_repairs_a_damaged_asset(app):
    pid, (up,) = _book(app)
    good = app.backups.backup("manual")
    assert good["verified"]
    p = _asset_path(app, up)
    p.write_bytes(b"garbage")
    app.backups.restore(good["name"], CONFIRM)
    rec = app.store.get_record(pid, "main", up["ref"]["record_id"])
    assert app.store.read_binary(rec) == f"asset-bytes-0-".encode() * 200


def test_truncated_asset_download_is_a_clean_hash_mismatch(app):
    pid, (up,) = _book(app)
    p = _asset_path(app, up)
    p.write_bytes(p.read_bytes()[:10])
    with pytest.raises(AkoweError) as ei:
        _route(app, "GET", f"/api/projects/{pid}/branches/main/assets/{up['ref']['record_id']}/1")
    assert ei.value.code == "HASH_MISMATCH"


def test_deleted_asset_download_is_a_clean_error(app):
    pid, (up,) = _book(app)
    _asset_path(app, up).unlink()
    with pytest.raises(AkoweError):
        _route(app, "GET", f"/api/projects/{pid}/branches/main/assets/{up['ref']['record_id']}/1")


def test_deleted_asset_makes_backups_unverified_and_restore_brings_it_back(app):
    pid, (up,) = _book(app)
    good = app.backups.backup("manual")
    _asset_path(app, up).unlink()
    bad = app.backups.backup("manual")
    assert good["verified"] is True and bad["verified"] is False
    with pytest.raises(AkoweError) as ei:
        app.backups.restore(bad["name"], CONFIRM)
    assert ei.value.code == "HASH_MISMATCH"
    app.backups.restore(good["name"], CONFIRM)
    assert check_store(app.store.data_dir) == []


# ---------------------------------------------------------------------------------------------- disk full / unwritable
def test_backup_disk_full_while_copying_assets_is_clean_and_leaves_nothing(app, monkeypatch):
    pid, ups = _book(app, 3)
    calls = {"n": 0}
    real = shutil.copy2

    def copy2(src, dst, *a, **k):
        calls["n"] += 1
        if calls["n"] == 2:
            raise OSError(errno.ENOSPC, "No space left on device")
        return real(src, dst, *a, **k)
    monkeypatch.setattr(store_mod.shutil, "copy2", copy2)
    with pytest.raises(AkoweError) as ei:
        _route(app, "POST", "/api/backups")
    assert "disk" in ei.value.errors[0]["message"]
    assert app.backups.last_error and "No space" in app.backups.last_error
    assert list((app.store.data_dir / "backups").iterdir()) == []
    monkeypatch.setattr(store_mod.shutil, "copy2", real)
    assert app.backups.backup("manual")["verified"]


def test_backup_sqlite_disk_full_is_clean_and_leaves_nothing(app, monkeypatch):
    _book(app)
    real = sqlite3.connect

    def connect(path, *a, **k):
        if "backups" in str(path):
            raise sqlite3.OperationalError("database or disk is full")
        return real(path, *a, **k)
    monkeypatch.setattr(store_mod, "sqlite3", types.SimpleNamespace(connect=connect, Row=sqlite3.Row))
    with pytest.raises(AkoweError):
        app.backups.backup("manual")
    assert list((app.store.data_dir / "backups").iterdir()) == []
    assert app.backups.last_error


def test_backup_into_an_unwritable_backups_folder_is_a_clean_error(app):
    _book(app)
    (app.store.data_dir / "backups").write_text("not a folder")  # mkdir fails like a read-only target
    with pytest.raises(AkoweError) as ei:
        app.backups.backup("manual")
    assert ei.value.code == "INTERNAL_ERROR" and "disk" in ei.value.errors[0]["message"]
    assert app.backups.try_backup("before-export") is None and app.backups.last_error
    health = {c["id"]: c for c in app.health.run(force=True)["checks"]}
    assert health["backups"]["status"] != "ok"


def test_upload_disk_full_is_clean_and_leaves_no_partial_file(app, monkeypatch):
    pid, _ = _book(app)
    before = sorted(p.name for p in app.store.asset_dir.iterdir())

    def replace(*a):
        raise OSError(errno.ENOSPC, "No space left on device")
    monkeypatch.setattr(store_mod, "os", types.SimpleNamespace(replace=replace, PathLike=os.PathLike))
    with pytest.raises(AkoweError):
        app.upload("author", pid, "main", b"new asset" * 100, {"Content-Type": "image/png"})
    assert sorted(p.name for p in app.store.asset_dir.iterdir()) == before


def test_upload_disk_full_commits_no_record(app, monkeypatch):
    pid, _ = _book(app)
    n = app.store.query_one("SELECT COUNT(*) n FROM records")["n"]

    def replace(*a):
        raise OSError(errno.ENOSPC, "No space left on device")
    monkeypatch.setattr(store_mod, "os", types.SimpleNamespace(replace=replace, PathLike=os.PathLike))
    with pytest.raises(AkoweError):  # a clean "is the disk full?" error since NEW-fault-11 (was a raw OSError)
        app.upload("author", pid, "main", b"new asset" * 100, {"Content-Type": "image/png"})
    assert app.store.query_one("SELECT COUNT(*) n FROM records")["n"] == n
    assert check_store(app.store.data_dir) == []


# ---------------------------------------------------------------------------------------------- corrupted database
def _corrupt_index_page(db: Path, index: str):
    conn = sqlite3.connect(db)
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    page = conn.execute("SELECT rootpage FROM sqlite_master WHERE name=?", (index,)).fetchone()[0]
    psize = conn.execute("PRAGMA page_size").fetchone()[0]
    conn.close()
    with open(db, "r+b") as f:
        f.seek((page - 1) * psize)
        f.write(bytes([0x0a, 0, 0, 0, 0x7f, 0x0f, 0xff, 0, 0, 0, 0, 0]))  # nonsense b-tree header


def test_corrupted_database_is_detected_by_health_and_backups(tmp_path):
    a = App(tmp_path / "data", token=TOKEN)
    pid = a.engine.bootstrap_project("author", "B")
    for i in range(300):
        a.store.set_setting(f"filler:{i}", {"i": i})
    with a.store.transaction() as tx:
        for i in range(400):
            tx.insert_audit(project_id=pid, branch_id="main", request_id=f"r{i}", attempt_id="a", operation_id="A01",
                            action="READ", principal_id="author", input_refs=[], output_refs=[], outcome="SUCCESS",
                            evidence_type="READ")
    a.store.close()
    db = tmp_path / "data" / "akowe.sqlite3"
    _corrupt_index_page(db, "audit_project")
    conn = sqlite3.connect(db)
    assert conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok"
    conn.close()
    a = App(tmp_path / "data", token=TOKEN)  # still starts
    try:
        checks = {c["id"]: c for c in a.health.run(force=True)["checks"]}
        b = a.backups.backup("manual")
        assert checks["database"]["status"] != "ok" or b["verified"] is False, (checks["database"], b)
        assert checks["database"]["status"] != "ok"
        assert b["verified"] is False
    finally:
        a.store.close()


def test_garbage_database_file_refuses_to_start_without_touching_it(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    junk = b"this is not a database" * 100
    (data / "akowe.sqlite3").write_bytes(junk)
    with pytest.raises(sqlite3.DatabaseError):
        App(data, token=TOKEN)
    assert (data / "akowe.sqlite3").read_bytes() == junk


# ---------------------------------------------------------------------------------------------- tampered backups
def _good_backup(app):
    pid, _ = _book(app, 2)
    r = app.engine.dispatch(build_request(project_id=pid, branch_id="main", op_id="A01", action="CREATE",
                                          principal_id="author", payload={"concept": "Disk keeper"}), "author")
    assert r["status"] == "DRAFT", r
    return app.backups.backup("manual")


@pytest.mark.parametrize("damage", ["db_byte", "manifest_json", "manifest_gone", "asset_gone", "asset_byte",
                                    "record_content"])
def test_damaged_backup_is_never_restored(app, damage):
    b = _good_backup(app)
    src = app.backups.dir / b["name"]
    live_before = (app.store.data_dir / "akowe.sqlite3").stat().st_size
    projects_before = app.store.query("SELECT project_id FROM projects")
    if damage == "db_byte":
        raw = bytearray((src / "akowe.sqlite3").read_bytes())
        raw[len(raw) // 2] ^= 0xFF
        (src / "akowe.sqlite3").write_bytes(bytes(raw))
    elif damage == "manifest_json":
        (src / "manifest.json").write_text("{not json")
    elif damage == "manifest_gone":
        (src / "manifest.json").unlink()
    elif damage == "asset_gone":
        next((src / "assets").iterdir()).unlink()
    elif damage == "asset_byte":
        f = next((src / "assets").iterdir())
        f.write_bytes(f.read_bytes() + b"x")
    elif damage == "record_content":
        conn = sqlite3.connect(src / "akowe.sqlite3")
        conn.execute("UPDATE records SET content=CAST(REPLACE(CAST(content AS TEXT), 'Disk', 'Dusk') AS BLOB)")
        conn.commit()
        conn.close()
        m = json.loads((src / "manifest.json").read_text())
        m["db_sha256"] = sha256_bytes((src / "akowe.sqlite3").read_bytes())
        (src / "manifest.json").write_text(json.dumps(m))
    with pytest.raises(AkoweError) as ei:
        app.backups.restore(b["name"], CONFIRM)
    assert ei.value.code in ("HASH_MISMATCH", "NOT_FOUND")
    assert app.store.query("SELECT project_id FROM projects") == projects_before
    assert not list(app.store.data_dir.glob("restore-staging-*"))
    assert (app.store.data_dir / "akowe.sqlite3").stat().st_size >= live_before


def test_backup_from_a_newer_schema_version_is_refused(app):
    b = _good_backup(app)
    src = app.backups.dir / b["name"]
    conn = sqlite3.connect(src / "akowe.sqlite3")
    conn.execute("UPDATE meta SET value='99' WHERE key='schema_version'")
    conn.commit()
    conn.close()
    m = json.loads((src / "manifest.json").read_text())
    m["schema_version"] = 99
    m["db_sha256"] = sha256_bytes((src / "akowe.sqlite3").read_bytes())
    (src / "manifest.json").write_text(json.dumps(m))
    assert Store.verify_backup(src) != []
    with pytest.raises(AkoweError):
        app.backups.restore(b["name"], CONFIRM)


def test_store_refuses_a_database_from_a_newer_schema(tmp_path):
    s = Store(tmp_path / "d")
    with s.transaction() as tx:
        tx.execute("UPDATE meta SET value='99' WHERE key='schema_version'")
    s.close()
    with pytest.raises(Exception):
        Store(tmp_path / "d")
