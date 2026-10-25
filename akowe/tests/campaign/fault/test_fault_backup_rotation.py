"""Backup rotation with unverified backups, the pinned safety copy made before deleting a book, and the health
check's cached database check after a restore."""
from __future__ import annotations

import time

import pytest

from bookforge.server import App

TOKEN = "rotation-token-0123456789"
CONFIRM = {"author_confirms": True, "confirm": "RESTORE"}


@pytest.fixture
def app(tmp_path):
    a = App(tmp_path / "data", token=TOKEN)
    a.engine.providers.secret_path = tmp_path / "secrets.json"
    yield a
    a.store.close()


def _book_with_asset(app, name="Rotation book"):
    pid = app.engine.bootstrap_project("author", name)
    up = app.upload("author", pid, "main", b"picture bytes" * 500, {"Content-Type": "image/png"})
    return pid, app.store.asset_dir / f"{up['ref']['content_hash']}.bin"


def test_unverified_backups_are_capped_oldest_first_and_the_newest_good_one_stays(app):
    _, asset = _book_with_asset(app)
    app.backups.set_keep(2)
    good = [app.backups.backup("before-export")["name"] for _ in range(3)]
    data = asset.read_bytes()
    asset.unlink()
    bad = [app.backups.backup("before-run")["name"] for _ in range(6)]
    autos = [b for b in app.backups.list() if not b["pinned"]]
    names = [b["name"] for b in autos]
    assert [b["name"] for b in autos if not b["verified"]] == bad[::-1][:2]  # the two newest unverified ones
    assert [b["name"] for b in autos if b["verified"]] == good[::-1][:2]  # good ones are never pushed out
    assert good[-1] in names
    asset.write_bytes(data)
    newest = app.backups.backup("before-export")["name"]
    names = [b["name"] for b in app.backups.list() if not b["pinned"]]
    # keep=2 good + at most 2 unverified ones newer than them; the older unverified one and old good ones go
    assert names == [newest, bad[-1], bad[-2], good[-1]]


def test_a_manual_backup_and_the_before_delete_copy_never_rotate(app):
    pid, _ = _book_with_asset(app, "Doomed")
    st, out = app.route("POST", f"/api/projects/{pid}/delete", {}, {"author_confirms": True, "confirm": "Doomed"},
                        "author", {})
    assert st == 200
    app.engine.bootstrap_project("author", "Another")
    app.backups.set_keep(1)
    for _ in range(4):
        app.backups.backup("before-export")
    by_name = {b["name"]: b for b in app.backups.list()}
    assert out["safety_backup"] in by_name and by_name[out["safety_backup"]]["pinned"] is True
    assert "kept" in out["message"] and "rotate it out" not in out["message"]
    assert sum(1 for b in by_name.values() if not b["pinned"]) == 1


def test_restore_drops_the_cached_database_check(app):
    _book_with_asset(app)
    good = app.backups.backup("manual")
    app.health.run(force=True)
    app.health._qc = (time.monotonic(), ["*** in database main ***", "Page 4: btree damaged"])  # damage seen earlier
    app.health._last = None
    assert {c["id"]: c for c in app.health.run()["checks"]}["database"]["status"] == "problem"
    app.backups.restore(good["name"], CONFIRM)
    # Without force: the restored database is checked afresh instead of reusing the damage found before.
    assert {c["id"]: c for c in app.health.run()["checks"]}["database"]["status"] == "ok"
