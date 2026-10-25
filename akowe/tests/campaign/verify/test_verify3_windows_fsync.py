"""verify3: Windows semantics for the durable-write helpers (store.py fsync_file / durable_copy / write_private).

On Windows os.fsync() is _commit() -> FlushFileBuffers(), which needs a handle with WRITE access: fsync on a
descriptor opened O_RDONLY fails with EBADF. Directories cannot be opened at all (PermissionError). The fix round
handles the directory case (fsync_dir is best effort) but fsync_file() opens the file O_RDONLY and is NOT best
effort, so every backup (and the asset repair of a restore) fails on Windows with "is the disk full?".
"""
from __future__ import annotations

import errno
import os

import pytest

import bookforge.store as store_mod
from bookforge.backups import BackupManager
from bookforge.store import Store, durable_copy, write_private


class WindowsLikeOS:
    """os stand-in: directories cannot be opened; fsync needs a descriptor opened with write access."""

    name = "nt"  # the durable-write helpers switch to Windows behaviour (best-effort flushes, rename retries)

    def __init__(self):
        self._writable: dict[int, bool] = {}

    def __getattr__(self, name):
        return getattr(os, name)

    def open(self, path, flags, mode=0o777, *a, **kw):
        if os.path.isdir(path):
            raise PermissionError(errno.EACCES, "Permission denied", str(path))
        fd = os.open(path, flags, mode, *a, **kw)
        self._writable[fd] = (flags & 3) != os.O_RDONLY
        return fd

    def fsync(self, fd):
        if not self._writable.get(fd, True):
            raise OSError(errno.EBADF, "Bad file descriptor")
        return os.fsync(fd)

    def close(self, fd):
        self._writable.pop(fd, None)
        return os.close(fd)


@pytest.fixture
def winos(monkeypatch):
    fake = WindowsLikeOS()
    monkeypatch.setattr(store_mod, "_os", fake)
    return fake


def test_write_private_works_on_windows(tmp_path, winos):
    write_private(tmp_path / "secret", b"tok")
    assert (tmp_path / "secret").read_bytes() == b"tok"


def test_durable_copy_works_on_windows(tmp_path, winos):
    (tmp_path / "a").write_bytes(b"x")
    durable_copy(tmp_path / "a", tmp_path / "b")  # used by restore to put damaged/missing assets back
    assert (tmp_path / "b").read_bytes() == b"x"


def test_store_backup_works_on_windows(tmp_path, winos):
    st = Store(tmp_path / "data")
    try:
        st.backup(tmp_path / "bk")
    finally:
        st.close()


def test_backup_manager_backup_works_on_windows(tmp_path, winos):
    st = Store(tmp_path / "data")
    try:
        b = BackupManager(st).backup("manual")
        assert b["verified"] is True
    finally:
        st.close()
