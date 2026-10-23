"""CI-style run of every storage path under a Windows simulation (the author runs BookForge on Windows).

``WinOS`` stands in for the ``os`` module the durable-write helpers in bookforge.store use, with the Windows
behaviour that matters for them:
- os.fsync() is FlushFileBuffers: it needs a descriptor opened with WRITE access (EBADF otherwise);
- a directory cannot be opened at all (PermissionError), so it cannot be fsynced;
- opening a read-only file for writing fails (PermissionError);
- os.replace() onto a file another program holds open (antivirus, the search indexer) fails with PermissionError
  until that program lets go;
- there is no O_NOFOLLOW, and there is O_BINARY; chmod only toggles the read-only flag.
Every storage path (secret / token files, uploads, backups, verify, restore with its safety backup and asset
repair, the safety backup before deleting a book) must work there.
"""
from __future__ import annotations

import errno
import os
import stat

import pytest

import bookforge.store as store_mod
from bookforge.backups import BackupManager
from bookforge.server import App
from bookforge.store import Store, durable_copy, fsync_file, replace_file, write_private

TOKEN = "windows-sim-token-0123456789"
CONFIRM = {"author_confirms": True, "confirm": "RESTORE"}
O_BINARY = 0x8000


class WinOS:
    name = "nt"
    O_BINARY = O_BINARY

    def __init__(self):
        self._writable: dict[int, bool] = {}
        self.busy: dict[str, int] = {}  # path -> how many more os.replace() calls onto it fail
        self.fsyncs = 0
        self.failed_fsyncs = 0

    def __getattr__(self, name):
        if name == "O_NOFOLLOW":
            raise AttributeError(name)  # not on Windows
        return getattr(os, name)

    def open(self, path, flags, mode=0o777, *a, **kw):
        path = str(path)
        if os.path.isdir(path):
            raise PermissionError(errno.EACCES, "Permission denied", path)
        wants_write = (flags & 3) != os.O_RDONLY
        if wants_write and os.path.exists(path) and not os.stat(path).st_mode & stat.S_IWRITE:
            raise PermissionError(errno.EACCES, "Permission denied", path)  # read-only attribute
        fd = os.open(path, flags & ~O_BINARY, mode, *a, **kw)
        self._writable[fd] = wants_write
        return fd

    def fsync(self, fd):
        self.fsyncs += 1
        if not self._writable.get(fd, True):
            self.failed_fsyncs += 1
            raise OSError(errno.EBADF, "Bad file descriptor")
        return os.fsync(fd)

    def close(self, fd):
        self._writable.pop(fd, None)
        return os.close(fd)

    def replace(self, src, dst):
        left = self.busy.get(str(dst), 0)
        if left:
            self.busy[str(dst)] = left - 1
            raise PermissionError(errno.EACCES, "The process cannot access the file because it is being used by "
                                                "another process", str(dst))
        return os.replace(src, dst)

    def chmod(self, path, mode, *a, **kw):  # Windows: only the read-only flag
        cur = os.stat(path).st_mode
        new = (cur | stat.S_IWRITE) if mode & stat.S_IWRITE else (cur & ~stat.S_IWRITE)
        return os.chmod(path, stat.S_IMODE(new), *a, **kw)


@pytest.fixture
def winos(monkeypatch):
    fake = WinOS()
    monkeypatch.setattr(store_mod, "_os", fake)
    monkeypatch.setattr(store_mod, "os", fake)  # os.replace in the helpers (the fault-injection hook)
    monkeypatch.setattr(store_mod, "REPLACE_RETRY_DELAYS", (0.0,) * len(store_mod.REPLACE_RETRY_DELAYS))
    return fake


@pytest.fixture
def app(tmp_path, winos):
    a = App(tmp_path / "data", token=TOKEN)  # (the token file itself is covered below)
    a.engine.providers.secret_path = tmp_path / "secrets.json"
    yield a
    a.store.close()


def _book(app, name="Windows book", data=b"\x89PNG windows picture" * 300):
    pid = app.engine.bootstrap_project("author", name)
    up = app.upload("author", pid, "main", data, {"Content-Type": "image/png"})
    return pid, up


# ---------------------------------------------------------------------------------------------- helpers
def test_fsync_file_opens_for_write_so_windows_can_flush(tmp_path, winos):
    (tmp_path / "f").write_bytes(b"x")
    fsync_file(tmp_path / "f")
    assert winos.fsyncs == 1 and winos.failed_fsyncs == 0


def test_fsync_of_a_read_only_file_is_best_effort_on_windows(tmp_path, winos):
    f = tmp_path / "ro"
    f.write_bytes(b"x")
    f.chmod(0o444)
    try:
        fsync_file(f)  # opened read-only -> FlushFileBuffers fails -> logged, not an error
    finally:
        f.chmod(0o644)
    assert winos.failed_fsyncs == 1


def test_fsync_dir_is_skipped_on_windows(tmp_path, winos):
    store_mod.fsync_dir(tmp_path)
    assert winos.fsyncs == 0


def test_fsync_errors_still_raise_off_windows(tmp_path, monkeypatch):
    class PosixIOError(WinOS):
        name = "posix"

        def fsync(self, fd):
            raise OSError(errno.EIO, "Input/output error")
    monkeypatch.setattr(store_mod, "_os", PosixIOError())
    (tmp_path / "f").write_bytes(b"x")
    with pytest.raises(OSError):
        fsync_file(tmp_path / "f")
    with pytest.raises(OSError):
        write_private(tmp_path / "secret", b"tok")
    assert not [p for p in tmp_path.iterdir() if ".tmp-" in p.name]


def test_replace_retries_while_another_program_holds_the_file(tmp_path, winos):
    (tmp_path / "a").write_bytes(b"new")
    (tmp_path / "b").write_bytes(b"old")
    winos.busy[str(tmp_path / "b")] = 3  # e.g. the virus scanner looks at it for a moment
    replace_file(tmp_path / "a", tmp_path / "b")
    assert (tmp_path / "b").read_bytes() == b"new"


def test_replace_gives_up_with_a_permission_error_when_it_stays_busy(tmp_path, winos):
    (tmp_path / "a").write_bytes(b"new")
    (tmp_path / "b").write_bytes(b"old")
    winos.busy[str(tmp_path / "b")] = 10 ** 6
    with pytest.raises(PermissionError):
        durable_copy(tmp_path / "a", tmp_path / "b")
    assert (tmp_path / "b").read_bytes() == b"old"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["a", "b"]  # no temp file left behind


def test_replace_permission_error_is_not_retried_off_windows(tmp_path, monkeypatch):
    calls = []

    class Posix(WinOS):
        name = "posix"

        def replace(self, src, dst):
            calls.append(dst)
            raise PermissionError(errno.EACCES, "Permission denied")
    fake = Posix()
    monkeypatch.setattr(store_mod, "_os", fake)
    monkeypatch.setattr(store_mod, "os", fake)
    (tmp_path / "a").write_bytes(b"x")
    with pytest.raises(PermissionError):
        replace_file(tmp_path / "a", tmp_path / "b")
    assert len(calls) == 1


def test_write_private_and_durable_copy(tmp_path, winos):
    write_private(tmp_path / "secret", b"tok")
    winos.busy[str(tmp_path / "secret")] = 2
    write_private(tmp_path / "secret", b"tok2")
    assert (tmp_path / "secret").read_bytes() == b"tok2"
    (tmp_path / "a").write_bytes(b"x")
    durable_copy(tmp_path / "a", tmp_path / "b")
    assert (tmp_path / "b").read_bytes() == b"x"
    assert not [p for p in tmp_path.iterdir() if ".tmp-" in p.name]


# ---------------------------------------------------------------------------------------------- whole app
def test_access_token_and_api_key_files(tmp_path, winos):
    a = App(tmp_path / "data")  # creates data/local_token with write_private
    try:
        assert (tmp_path / "data" / "local_token").read_text().strip() == a.token
        a.engine.providers.secret_path = tmp_path / "s" / "secrets.json"
        a.engine.providers._store_api_key("AI-1", "sk-win-1")
        winos.busy[str(tmp_path / "s" / "secrets.json")] = 2  # Windows Search indexes the file just then
        a.engine.providers._store_api_key("AI-2", "sk-win-2")
        assert a.engine.providers._api_key("AI-1") == "sk-win-1"
        assert a.engine.providers._api_key("AI-2") == "sk-win-2"
    finally:
        a.store.close()


def test_upload_and_read_back(app):
    pid, up = _book(app)
    assert (app.store.asset_dir / f"{up['ref']['content_hash']}.bin").is_file()
    assert not [p for p in app.store.asset_dir.iterdir() if ".tmp-" in p.name]


def test_store_backup_and_verify(app, tmp_path):
    _book(app)
    manifest = app.store.backup(tmp_path / "bk")
    assert manifest["assets"] and Store.verify_backup(tmp_path / "bk") == []


def test_backup_manager_backup_rotate_and_list(app):
    _book(app)
    app.backups.set_keep(2)
    for _ in range(4):
        assert app.backups.backup("before-export")["verified"] is True
    assert BackupManager(app.store).backup("manual")["verified"] is True
    autos = [b for b in app.backups.list() if not b["pinned"]]
    assert len(autos) == 2


def test_restore_with_safety_backup_and_asset_repair(app):
    pid, up = _book(app)
    good = app.backups.backup("manual")
    asset = app.store.asset_dir / f"{up['ref']['content_hash']}.bin"
    asset.write_bytes(b"damaged")  # a bad sector: restore puts the verified bytes back (durable_copy)
    out = app.backups.restore(good["name"], CONFIRM)
    assert out["assets_repaired"] == 1 and out["safety_backup"]
    assert asset.read_bytes() == b"\x89PNG windows picture" * 300


def test_delete_book_makes_its_safety_backup(app):
    pid, _ = _book(app, "Gone on Windows")
    st, out = app.route("POST", f"/api/projects/{pid}/delete", {}, {"author_confirms": True,
                                                                     "confirm": "Gone on Windows"}, "author", {})
    assert st == 200 and out["safety_backup"]
    assert {b["name"]: b for b in app.backups.list()}[out["safety_backup"]]["verified"] is True
