"""Regression tests for the storage / backup / restore fixes that the pinned fault tests do not fully cover:
BF-05 rotation rules, NEW-fault-12 rotation after a bad backup, NEW-fault-16 the writer gate, NEW-fault-19 for
automatic backups, BF-10 private secret files, BF-24 fsync, BF-19 archive / delete, NEW-fault-4 HEAD."""
from __future__ import annotations

import json
import os
import stat
import sys
import threading
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer

import pytest

import akowe.store as store_mod
from akowe.errors import AkoweError
from akowe.providers import ProviderRegistry
from akowe.server import ApiError, App, make_handler
from akowe.store import Store

from fault_helpers import TOKEN, call, check_store

CONFIRM = {"author_confirms": True, "confirm": "RESTORE"}
POSIX = sys.platform != "win32"


@pytest.fixture
def app(tmp_path):
    a = App(tmp_path / "data", token=TOKEN)
    a.engine.providers.secret_path = tmp_path / "secrets.json"
    a.engine.bootstrap_project("author", "Fix book")
    yield a
    a.store.close()


def _names(app):
    return [b["name"] for b in app.backups.list()]


# ---------------------------------------------------------------------------------------------- BF-05 / fault-19
def test_rotation_only_removes_automatic_backups(app):
    app.backups.set_keep(2)
    manual = app.backups.backup("manual")["name"]
    autos = [app.backups.backup("daily")["name"] for _ in range(4)]
    names = _names(app)
    assert manual in names and autos[-2:] == [n for n in names if n in autos][::-1]
    assert not set(autos[:2]) & set(names)


def test_restore_source_is_never_rotated_away(app):
    app.backups.set_keep(2)
    autos = [app.backups.backup("before-export")["name"] for _ in range(2)]
    oldest = autos[0]  # the next automatic backup would normally push this one out
    out = app.backups.restore(oldest, CONFIRM)
    assert oldest in _names(app) and out["safety_backup"] in _names(app)


def test_automatic_rotation_follows_the_sequence_not_the_clock(app, monkeypatch):
    app.backups.set_keep(2)
    first = [app.backups.backup("daily")["name"] for _ in range(2)]
    back = lambda: (datetime.now(timezone.utc) - timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")  # noqa: E731
    monkeypatch.setattr(store_mod, "utcnow", back)
    newest = app.backups.backup("daily")["name"]
    names = _names(app)
    assert names[0] == newest and newest in names and first[0] not in names and first[1] in names


def test_a_damaged_new_backup_never_rotates_good_ones_away(app, monkeypatch):
    app.backups.set_keep(2)
    good = [app.backups.backup("daily")["name"] for _ in range(2)]
    monkeypatch.setattr(Store, "verify_backup", staticmethod(lambda src: ["database integrity check failed"]))
    bad = app.backups.backup("daily")
    assert bad["verified"] is False and app.backups.last_error
    monkeypatch.undo()
    assert set(good) <= set(_names(app))
    health = {c["id"]: c for c in app.health.run(force=True)["checks"]}
    assert health["backups"]["status"] == "warn"
    # once enough newer good ones exist, the damaged one and the old ones rotate out normally
    newer = [app.backups.backup("daily")["name"] for _ in range(2)]
    assert [n for n in _names(app) if not n.endswith("-manual")] == newer[::-1]


def test_legacy_backup_names_sort_before_numbered_ones(app):
    legacy = app.backups.dir / "auto-20990101T000000000000Z-daily"
    app.store.backup(legacy)
    (legacy / "akowe-backup.json").write_text(json.dumps({"reason": "daily", "label": "x", "verified": True}))
    new = app.backups.backup("manual")["name"]
    assert _names(app)[0] == new


# ---------------------------------------------------------------------------------------------- fault-16 gate
def test_restore_waits_for_a_request_that_is_writing_and_writers_wait_for_restore(app):
    b = app.backups.backup("manual")
    with app.writer():
        with pytest.raises(AkoweError) as ei:
            app.backups.restore(b["name"], CONFIRM)
        assert ei.value.code == "VERSION_CONFLICT"
    with app.exclusive():
        with pytest.raises(ApiError) as ei:
            app.route("POST", "/api/projects", {}, {"name": "During restore"}, "author", {})
        assert ei.value.status == 409
    app.backups.restore(b["name"], CONFIRM)  # nothing running any more


# ---------------------------------------------------------------------------------------------- BF-10 secrets
@pytest.mark.skipif(not POSIX, reason="POSIX file modes")
def test_secret_and_token_files_are_private_from_the_first_byte(tmp_path, monkeypatch):
    modes = []
    real_open = store_mod._os.open

    def spy(path, flags, mode=0o777, *a):
        if flags & os.O_CREAT:
            modes.append(mode)
        return real_open(path, flags, mode, *a)
    monkeypatch.setattr(store_mod._os, "open", spy)
    a = App(tmp_path / "data")
    a.engine.providers.secret_path = tmp_path / "s" / "secrets.json"
    a.engine.providers._store_api_key("AI-1", "sk-test-1")
    monkeypatch.undo()
    assert modes and all(m == 0o600 for m in modes)
    for p in (tmp_path / "data" / "local_token", tmp_path / "s" / "secrets.json"):
        assert stat.S_IMODE(p.stat().st_mode) == 0o600
    assert not [p for p in (tmp_path / "s").iterdir() if p.name != "secrets.json"]  # no temp file left
    a.store.close()


def test_parallel_secret_saves_lose_nothing(tmp_path):
    st = Store(tmp_path / "d")
    regs = [ProviderRegistry(st, secret_path=tmp_path / "secrets.json") for _ in range(3)]
    ts = [threading.Thread(target=lambda r=r, i=i: [r._store_api_key(f"AI-{i + 1}", f"key-{i}-{n}")
                                                     for n in range(20)]) for i, r in enumerate(regs)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    saved = json.loads((tmp_path / "secrets.json").read_text())
    assert {k: v["api_key"] for k, v in saved.items()} == {"AI-1": "key-0-19", "AI-2": "key-1-19", "AI-3": "key-2-19"}
    st.close()


# ---------------------------------------------------------------------------------------------- BF-24 fsync
def test_assets_and_backups_are_fsynced(app, monkeypatch):
    synced = []
    real = store_mod._os.fsync

    def spy(fd):
        try:
            synced.append(os.readlink(f"/proc/self/fd/{fd}"))
        except OSError:
            synced.append(str(fd))
        return real(fd)
    monkeypatch.setattr(store_mod._os, "fsync", spy)
    pid = app.store.query_one("SELECT project_id FROM projects")["project_id"]
    up = app.upload("author", pid, "main", b"durable bytes" * 10, {"Content-Type": "image/png"})
    b = app.backups.backup("manual")
    if not os.path.exists("/proc/self/fd"):
        assert len(synced) >= 6
        return
    h = up["ref"]["content_hash"]
    assert any(".tmp-" in s and h in s for s in synced)  # the asset bytes before the rename
    assert any(s.endswith("/assets") and b["name"] not in s for s in synced)  # the assets folder after it
    assert any(b["name"] in s and s.endswith(f"{h}.bin") for s in synced)
    assert any(b["name"] in s and s.endswith("akowe.sqlite3") for s in synced)
    assert any(s.endswith("/" + b["name"]) for s in synced)


def test_partial_upload_files_are_swept_at_start_and_never_backed_up(tmp_path):
    st = Store(tmp_path / "d")
    (st.asset_dir / "abc.bin.tmp-1234abcd").write_bytes(b"half")
    m = st.backup(tmp_path / "bk")
    assert m["assets"] == {}
    st.close()
    st = Store(tmp_path / "d")
    assert list(st.asset_dir.iterdir()) == []
    st.close()


# ---------------------------------------------------------------------------------------------- BF-19 archive / delete
def test_archive_hides_a_book_and_unarchive_brings_it_back(app):
    pid = app.store.query_one("SELECT project_id FROM projects")["project_id"]
    out = app.route("POST", f"/api/projects/{pid}/archive", {}, {}, "author", {})[1]
    assert out["archived"] is True
    assert app.route("GET", "/api/projects", {}, None, "author", {})[1] == []
    arch = app.route("GET", "/api/projects", {"archived": ["1"]}, None, "author", {})[1]
    assert [p["project_id"] for p in arch] == [pid]
    b = app.backups.backup("manual")
    assert app.backups.dir.joinpath(b["name"], "akowe.sqlite3").exists()  # archived books stay in backups
    app.route("POST", f"/api/projects/{pid}/archive", {}, {"archived": False}, "author", {})
    assert [p["project_id"] for p in app.route("GET", "/api/projects", {}, None, "author", {})[1]] == [pid]


def test_delete_needs_the_typed_name_and_removes_everything_of_that_book_only(app):
    keep_pid = app.store.query_one("SELECT project_id FROM projects")["project_id"]
    shared = b"shared image bytes" * 50
    app.upload("author", keep_pid, "main", shared, {"Content-Type": "image/png"})
    pid = app.engine.bootstrap_project("author", "Doomed book")
    app.upload("author", pid, "main", shared, {"Content-Type": "image/png"})
    own = app.upload("author", pid, "main", b"only in the doomed book" * 50, {"Content-Type": "image/png"})
    app.jobstore.save({"id": "job-doomed", "kind": "assist", "project_id": pid, "status": "done"})
    with pytest.raises(ApiError) as ei:
        app.route("POST", f"/api/projects/{pid}/delete", {}, {"author_confirms": True, "confirm": "Doomed"},
                  "author", {})
    assert ei.value.status == 400 and app.store.project(pid) is not None
    out = app.route("POST", f"/api/projects/{pid}/delete", {}, {"author_confirms": True, "confirm": "Doomed book"},
                    "author", {})[1]
    assert out["deleted"] == pid and out["safety_backup"] in _names(app) and out["assets_removed"] == 1
    for table in Store.PROJECT_TABLES:
        assert app.store.query_one(f"SELECT COUNT(*) n FROM {table} WHERE project_id=?", (pid,))["n"] == 0, table
    assert app.jobstore.get("job-doomed") is None
    assert not (app.store.asset_dir / f"{own['ref']['content_hash']}.bin").exists()
    assert app.store.project(keep_pid) is not None and check_store(app.store.data_dir) == []
    # the safety backup brings it back
    app.backups.restore(out["safety_backup"], CONFIRM)
    assert app.store.project(pid) is not None and check_store(app.store.data_dir) == []


def test_delete_is_refused_while_something_is_working(app):
    pid = app.store.query_one("SELECT project_id FROM projects")["project_id"]
    tok = app.work.begin(pid, "G11", "Exporting the book")
    try:
        with pytest.raises(ApiError) as ei:
            app.route("POST", f"/api/projects/{pid}/delete", {}, {"author_confirms": True, "confirm": "Fix book"},
                      "author", {})
        assert ei.value.status == 409
    finally:
        app.work.end(tok)
    assert app.store.project(pid) is not None


def test_selftest_books_archive_earlier_ones(app):
    from akowe.selftest import SelfTest
    for _ in range(2):
        t = SelfTest(app.store, base_providers=app.engine.providers, principal_id="author")
        t.p_project()
    rows = app.store.query("SELECT archived FROM projects WHERE settings LIKE '%selftest%' ORDER BY created_at")
    assert [r["archived"] for r in rows] == [1, 0]


# ---------------------------------------------------------------------------------------------- HTTP odds and ends
def test_head_and_wrong_types_answer_cleanly(tmp_path):
    a = App(tmp_path / "data", token=TOKEN)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(a))
    threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()
    port = httpd.server_address[1]
    try:
        assert call(port, "HEAD", "/api/projects")[0] == 405
        st, out = call(port, "POST", "/api/projects", {"name": "x", "settings": [1]})
        assert st == 400 and out["errors"][0]["path"] == "/settings"
        st, out = call(port, "POST", "/api/projects", raw=b'{"name": "x", "s": "[[[[" }')  # brackets inside text
        assert st == 201
    finally:
        httpd.shutdown()
        httpd.server_close()
        a.store.close()
