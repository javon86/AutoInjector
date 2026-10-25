"""Round-2 review: on Windows a failed file flush (FlushFileBuffers) is let pass (the data was written and closed).
That must not be silent: it is logged as a WARNING, and a backup made while it happened says "flushed: best effort"
instead of implying it would survive a power cut. Everywhere else a flush error is still an error."""
from __future__ import annotations

import errno
import logging
import os

import pytest

import bookforge.store as store_mod
from bookforge.server import App

TOKEN = "flush-best-effort-token-0123456789"


class FlakyWinOS:
    """Windows whose disk refuses every file flush (a real I/O problem, not the read-only-handle case)."""
    name = "nt"
    O_BINARY = 0

    def __getattr__(self, name):
        if name == "O_NOFOLLOW":
            raise AttributeError(name)
        return getattr(os, name)

    def open(self, path, flags, mode=0o777, *a, **kw):
        if os.path.isdir(str(path)):
            raise PermissionError(errno.EACCES, "Permission denied", str(path))
        return os.open(path, flags, mode, *a, **kw)

    def fsync(self, fd):
        raise OSError(errno.EIO, "Input/output error")


@pytest.fixture
def app(tmp_path):
    a = App(tmp_path / "data", token=TOKEN)
    a.engine.providers.secret_path = tmp_path / "secrets.json"
    yield a
    a.store.close()


def test_normal_backup_is_flushed(app):
    b = app.backups.backup("manual")
    assert b["verified"] is True and b["flushed"] == "yes"


def test_windows_flush_failure_is_a_warning_and_the_backup_says_best_effort(app, monkeypatch, caplog):
    app.engine.bootstrap_project("author", "Flush book")
    fake = FlakyWinOS()
    monkeypatch.setattr(store_mod, "_os", fake)
    monkeypatch.setattr(store_mod, "os", fake)
    with caplog.at_level(logging.WARNING, logger="bookforge"):
        b = app.backups.backup("manual")
    assert b["verified"] is True and b["flushed"] == "best effort", b
    listed = next(x for x in app.backups.list() if x["name"] == b["name"])
    assert listed["flushed"] == "best effort"
    assert any("could not flush" in r.getMessage() and r.levelno == logging.WARNING for r in caplog.records)
    monkeypatch.undo()
    assert app.backups.backup("manual")["flushed"] == "yes"  # a later backup that flushes is not marked


def test_flush_failure_off_windows_is_still_an_error(tmp_path, monkeypatch):
    class Posix(FlakyWinOS):
        name = "posix"
    monkeypatch.setattr(store_mod, "_os", Posix())
    (tmp_path / "f").write_bytes(b"x")
    with pytest.raises(OSError):
        store_mod.fsync_file(tmp_path / "f")
