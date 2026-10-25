"""BookForge -> Akọwe (2026-10-25): an existing install keeps all its data, keys, books and settings.

legacy.py holds every old name; these tests pin the migrations: the data folder, the database file, backups made
before the rename, the AKOWE_* / BOOKFORGE_* environment variables, the secrets file, the default books folder,
saved book folders (book.bookforge + .bookforge-folder.json), old book bibles and old asset URIs.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path

import pytest

from akowe import book_bible, book_package, book_save, d_assets, legacy, server
from akowe.store import Store

from test_section6 import _rewrite_zip, autosave_on, new_app, no_provider_sleep, route, run_book  # noqa: F401


# ============================================================================================ environment variables
def test_env_prefers_the_new_name_and_falls_back_to_the_old_one(monkeypatch):
    monkeypatch.delenv("AKOWE_PORT", raising=False)
    monkeypatch.delenv("BOOKFORGE_PORT", raising=False)
    assert legacy.env("PORT") is None and legacy.env("PORT", "8780") == "8780"
    monkeypatch.setenv("BOOKFORGE_PORT", "8791")
    assert legacy.env("PORT") == "8791"
    monkeypatch.setenv("AKOWE_PORT", "8792")
    assert legacy.env("PORT") == "8792"
    monkeypatch.setenv("AKOWE_PORT", "")  # empty = not set
    assert legacy.env("PORT") == "8791"


def test_old_env_vars_still_steer_the_app(monkeypatch, tmp_path):
    for n in ("BOOKS_DIR", "AUTOSAVE", "DATA"):
        monkeypatch.delenv("AKOWE_" + n, raising=False)
    monkeypatch.setenv("BOOKFORGE_BOOKS_DIR", str(tmp_path / "old-books"))
    assert book_save.default_folder() == tmp_path / "old-books"
    monkeypatch.setenv("BOOKFORGE_AUTOSAVE", "0")
    assert book_save.autosave_default() is False
    monkeypatch.setenv("BOOKFORGE_DATA", str(tmp_path / "old-data"))
    assert server.resolve_data_dir(None) == str(tmp_path / "old-data")
    assert server.resolve_data_dir(str(tmp_path / "given")) == str(tmp_path / "given")


# ============================================================================================ the data folder
def _old_install(root: Path) -> Path:
    """An old BookForge data folder with a real database, an asset and a venv."""
    old = root / ("Bookforge" if os.name == "nt" else "bookforge")
    st = Store(old)
    st.set_setting("books_folder", {"path": "C:\\Users\\You\\Documents\\BookForge Books"})
    st.close()
    os.replace(old / legacy.DB, old / legacy.OLD_DB)
    (old / "assets" / "abc.bin").write_bytes(b"picture")
    (old / "venv").mkdir()
    (old / "venv" / "pyvenv.cfg").write_text("home = x")
    return old


def test_data_folder_is_moved_on_the_first_start(tmp_path, caplog):
    old = _old_install(tmp_path)
    new = tmp_path / "akowe"
    with caplog.at_level(logging.WARNING, logger="akowe.legacy"):
        assert legacy.migrate_data_dir(new, old) == new
    assert not old.exists() and (new / "venv" / "pyvenv.cfg").exists() and (new / "assets" / "abc.bin").exists()
    assert sum("moved the data folder" in r.getMessage() for r in caplog.records) == 1
    st = Store(new)  # the old database file name is taken over, with its content
    try:
        assert st.db_path.name == "akowe.sqlite3" and not (new / legacy.OLD_DB).exists()
        assert st.get_setting("books_folder")["path"].endswith("BookForge Books")  # the user's books stay put
    finally:
        st.close()
    caplog.clear()
    with caplog.at_level(logging.WARNING, logger="akowe.legacy"):  # the second start: nothing to do, nothing logged
        assert legacy.migrate_data_dir(new, old) == new
    assert not caplog.records


def test_data_folder_is_copied_when_a_launcher_already_made_the_new_one(tmp_path):
    old = _old_install(tmp_path)
    new = tmp_path / "akowe"
    (new / "venv").mkdir(parents=True)  # run-akowe.sh made its venv first
    assert legacy.migrate_data_dir(new, old) == new
    assert (new / legacy.OLD_DB).exists() and (new / "assets" / "abc.bin").read_bytes() == b"picture"
    assert not (new / "venv" / "pyvenv.cfg").exists()  # the old venv is not copied over the new one
    assert (old / legacy.OLD_DB).exists() and (old / legacy.MIGRATED_NOTE).exists()  # copied, then marked: kept
    assert not list(tmp_path.glob(".akowe-migrating-*"))
    assert legacy.migrate_data_dir(new, old) == new  # once only


def test_data_folder_that_cannot_be_moved_or_copied_keeps_being_used(tmp_path, monkeypatch):
    old = _old_install(tmp_path)
    new = tmp_path / "akowe"

    def no(*a, **k):
        raise PermissionError("in use")
    monkeypatch.setattr(legacy.os, "rename", no)
    monkeypatch.setattr(legacy.shutil, "copytree", no)
    assert legacy.migrate_data_dir(new, old) == old
    assert (old / legacy.OLD_DB).exists() and not (old / legacy.MIGRATED_NOTE).exists()
    st = Store(old)  # still opens the old database
    try:
        assert st.get_setting("books_folder")["path"].endswith("BookForge Books")
    finally:
        st.close()


def test_no_old_folder_or_already_migrated_is_left_alone(tmp_path):
    new = tmp_path / "akowe"
    assert legacy.migrate_data_dir(new, tmp_path / "bookforge") == new and not new.exists()
    old = _old_install(tmp_path)
    Store(new).close()
    assert legacy.migrate_data_dir(new, old) == new and (old / legacy.OLD_DB).exists()


def test_default_data_dir_takes_over_the_old_one(tmp_path, monkeypatch):
    if os.name == "nt":
        monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    else:
        monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    monkeypatch.delenv("AKOWE_DATA", raising=False)
    monkeypatch.delenv("BOOKFORGE_DATA", raising=False)
    _old_install(tmp_path)
    got = Path(server.resolve_data_dir(None))
    assert got == server.default_data_dir() and got.name.lower() == "akowe" and (got / legacy.OLD_DB).exists()


def test_old_database_name_with_its_wal_is_renamed_together(tmp_path):
    for suffix in ("", "-wal", "-shm"):
        (tmp_path / (legacy.OLD_DB + suffix)).write_bytes(b"x" + suffix.encode())
    assert legacy.migrate_db_file(tmp_path) == tmp_path / "akowe.sqlite3"
    for suffix in ("", "-wal", "-shm"):
        assert (tmp_path / ("akowe.sqlite3" + suffix)).read_bytes() == b"x" + suffix.encode()
        assert not (tmp_path / (legacy.OLD_DB + suffix)).exists()


def test_a_backup_made_before_the_rename_verifies_and_restores(tmp_path):
    st = Store(tmp_path / "data")
    st.set_setting("x", {"y": 1})
    st.backup(tmp_path / "bk")
    st.close()
    os.replace(tmp_path / "bk" / legacy.DB, tmp_path / "bk" / legacy.OLD_DB)
    assert Store.verify_backup(tmp_path / "bk") == []
    restored = Store.restore(tmp_path / "bk", tmp_path / "restored")
    try:
        assert restored.get_setting("x") == {"y": 1} and restored.db_path.name == "akowe.sqlite3"
    finally:
        restored.close()


def test_backup_list_reads_old_backup_info(tmp_path):
    app, _fake = new_app(tmp_path)
    b = app.backups.backup("manual")
    d = app.backups.dir / b["name"]
    os.replace(d / "akowe-backup.json", d / legacy.OLD_BACKUP_INFO)
    os.replace(d / legacy.DB, d / legacy.OLD_DB)
    row = app.backups._describe(d)
    assert row["verified"] is True and row["label"]


# ============================================================================================ keys
def test_saved_keys_are_copied_from_the_old_secrets_folder(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.delenv("AKOWE_SECRETS", raising=False)
    monkeypatch.delenv("BOOKFORGE_SECRETS", raising=False)
    (tmp_path / ".bookforge").mkdir()
    (tmp_path / ".bookforge" / "secrets.json").write_text('{"AI-1": {"token": "paired-key"}}')
    p = legacy.secrets_path()
    assert p == tmp_path / ".akowe" / "secrets.json" and json.loads(p.read_text())["AI-1"]["token"] == "paired-key"
    assert (tmp_path / ".bookforge" / "secrets.json").exists()  # copied, never moved away
    monkeypatch.setenv("BOOKFORGE_SECRETS", str(tmp_path / "s.json"))
    assert legacy.secrets_path() == tmp_path / "s.json"


# ============================================================================================ books
def test_default_books_folder_keeps_an_existing_bookforge_books_folder(tmp_path, monkeypatch):
    monkeypatch.delenv("AKOWE_BOOKS_DIR", raising=False)
    monkeypatch.delenv("BOOKFORGE_BOOKS_DIR", raising=False)
    (tmp_path / "Documents").mkdir()
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    assert book_save.default_folder(windows=True) == tmp_path / "Documents" / "Akowe Books"  # a new install
    (tmp_path / "Documents" / "BookForge Books").mkdir()
    assert book_save.default_folder(windows=True) == tmp_path / "Documents" / "BookForge Books"  # an old one
    (tmp_path / "Documents" / "Akowe Books").mkdir()
    assert book_save.default_folder(windows=True) == tmp_path / "Documents" / "Akowe Books"


def _make_old_folder(folder: Path) -> bytes:
    """Turn a saved book folder into what BookForge wrote: book.bookforge, .bookforge-folder.json, old kinds."""
    data = (folder / "book.akowe").read_bytes()

    def old_format(items):
        man = json.loads(items["manifest.json"])
        man["format"], man["app"] = legacy.OLD_PACKAGE_FORMAT, "BookForge"
        items["manifest.json"] = json.dumps(man).encode()
    old = _rewrite_zip(data, old_format)
    (folder / "book.akowe").unlink()
    (folder / legacy.OLD_PACKAGE).write_bytes(old)
    marker = json.loads((folder / ".akowe-folder.json").read_text())
    marker["app"] = "BookForge"
    marker["files"] = [legacy.OLD_PACKAGE if f == "book.akowe" else f for f in marker["files"]]
    (folder / ".akowe-folder.json").unlink()
    (folder / legacy.OLD_MARKER).write_text(json.dumps(marker))
    bible = folder / "Book Bible" / "book-bible.json"
    b = json.loads(bible.read_text())
    b["kind"] = legacy.OLD_BIBLE_KIND
    bible.write_text(json.dumps(b))
    return old


def test_a_book_folder_saved_by_bookforge_opens_and_is_taken_over_by_the_next_save(tmp_path):
    app, _fake = new_app(tmp_path)
    run = run_book(app)
    pid = run["project_id"]
    folder = Path(app.saver.last(pid)["path"])
    old_pkg = _make_old_folder(folder)
    assert book_package.read(old_pkg)["manifest"]["format"] == legacy.OLD_PACKAGE_FORMAT
    # the books folder list and 📂 Open see the old package
    row = next(r for r in route(app, "GET", "/api/books-folder")[1]["folders"] if r["name"] == folder.name)
    assert row["has_package"] and row["bytes"] == len(old_pkg) and row["in_library"]
    st, res = route(app, "POST", "/api/books-folder/open", {"folder": folder.name})
    assert st == 201 and res["kind"] == "package" and res["project_id"] != pid
    # an uploaded book.bookforge and an old book bible open too
    assert app.opener.import_bytes("author", old_pkg)["kind"] == "package"
    old_bible = (folder / "Book Bible" / "book-bible.json").read_bytes()
    assert book_bible.clean(old_bible)["kind"] == book_bible.KIND
    # the next save of the same book uses the same folder and replaces the old pair
    assert app.saver.book_folder(pid, "main") == folder
    app.saver.save_now(pid, "main")
    assert (folder / "book.akowe").is_file() and (folder / ".akowe-folder.json").is_file()
    assert not (folder / legacy.OLD_PACKAGE).exists() and not (folder / legacy.OLD_MARKER).exists()
    assert json.loads((folder / ".akowe-folder.json").read_text())["project_id"] == pid


def test_old_asset_uris_still_parse():
    sha = "a" * 64
    new = d_assets.parse_asset_uri(f"akowe-asset://p1/main/{sha}.bin#bin-1@v2")
    old = d_assets.parse_asset_uri(f"bookforge-asset://p1/main/{sha}.bin#bin-1@v2")
    assert new == old and old["record_id"] == "bin-1" and old["version"] == 2
    assert d_assets.parse_asset_uri(f"other-asset://p1/main/{sha}.bin#bin-1@v2") is None


def test_ping_of_an_older_bookforge_still_counts_as_running(monkeypatch):
    seen = {}

    class Resp:
        status = 200

        def __init__(self, app_id):
            self.app_id = app_id

        def read(self, n):
            return json.dumps({"app": self.app_id, "proof": server.ping_proof("tok", seen["c"])}).encode()

    class Conn:
        def __init__(self, *a, **k):
            pass

        def request(self, method, url, headers=None):
            seen["c"] = url.split("challenge=")[1]

        def getresponse(self):
            return Resp(seen["app"])

        def close(self):
            pass
    import http.client  # noqa: PLC0415
    monkeypatch.setattr(http.client, "HTTPConnection", Conn)
    for app_id, ok in (("akowe", True), ("bookforge", True), ("other", False)):
        seen["app"] = app_id
        assert server.already_running("127.0.0.1", 1, "tok") is ok
