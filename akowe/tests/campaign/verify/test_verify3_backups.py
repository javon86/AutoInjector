"""verify3: backup rotation / upgrade path / delete with shared assets."""
from __future__ import annotations

import pytest

from akowe.server import App

TOKEN = "verify3-token-0123456789"


@pytest.fixture
def app(tmp_path):
    a = App(tmp_path / "data", token=TOKEN)
    a.engine.providers.secret_path = tmp_path / "secrets.json"
    yield a
    a.store.close()


def test_unverified_automatic_backups_are_bounded(app):
    """Once one asset file is missing (or the DB is damaged), EVERY new backup is unverified. Rotation is skipped
    for an unverified backup and, even when it runs, keeps every unverified automatic backup that is newer than the
    `keep` good ones. Each Make-a-book run / export makes automatic backups, so they pile up without limit until
    the disk is full (the very thing that then also breaks saving)."""
    pid = app.engine.bootstrap_project("author", "Book")
    up = app.upload("author", pid, "main", b"picture bytes" * 1000, {"Content-Type": "image/png"})
    app.backups.set_keep(2)
    (app.store.asset_dir / f"{up['ref']['content_hash']}.bin").unlink()  # e.g. antivirus quarantine / bad sector
    for _ in range(12):
        b = app.backups.backup("before-export")
        assert b["verified"] is False
    autos = [b for b in app.backups.list() if not b["pinned"]]
    assert len(autos) <= 2 * 2, f"{len(autos)} automatic backups kept with keep=2"


def test_delete_keeps_an_image_another_book_shares(app):
    shared = b"\x89PNG same art" * 200
    a = app.engine.bootstrap_project("author", "Keep me")
    b = app.engine.bootstrap_project("author", "Delete me")
    ua = app.upload("author", a, "main", shared, {"Content-Type": "image/png"})
    app.upload("author", b, "main", shared, {"Content-Type": "image/png"})
    app.route("POST", f"/api/projects/{b}/delete", {}, {"author_confirms": True, "confirm": "Delete me"}, "author", {})
    rid = ua["ref"]["record_id"]
    st, payload = app.route("GET", f"/api/projects/{a}/branches/main/assets/{rid}/1", {}, None, "author", {})
    assert st == 200 and payload[2] == shared
    assert app.backups.backup("manual")["verified"] is True
