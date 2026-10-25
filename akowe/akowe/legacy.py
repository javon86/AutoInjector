"""Backward compatibility with the app's former name, "BookForge" (renamed to Akọwe on 2026-10-25).

Everything that still knows the old name lives here, so existing installs keep working:

* the data folder: ``%LOCALAPPDATA%\\Bookforge`` (Windows) / ``~/.local/share/bookforge`` (elsewhere) is moved to
  ``...\\Akowe`` / ``.../akowe`` on the first start (``migrate_data_dir``); when it cannot be moved it is copied and
  the old folder is marked, and when even that fails the old folder keeps being used. Nothing is ever deleted.
* the database file ``bookforge.sqlite3`` (inside the data folder and inside backups) becomes ``akowe.sqlite3``;
* environment variables ``BOOKFORGE_*`` are still read when the ``AKOWE_*`` one is not set (``env``);
* saved books: ``book.bookforge`` / ``.bookforge-folder.json`` are still opened (the next save writes
  ``book.akowe`` / ``.akowe-folder.json`` and removes the old pair it replaces); the package format and book-bible
  kind strings of the old name are still accepted;
* the default books folder "BookForge Books" keeps being used when it exists and "Akowe Books" does not;
* the secrets file ``~/.bookforge/secrets.json`` (AI keys, the AutoInjector connection key) is copied to
  ``~/.akowe/secrets.json`` once.
"""
from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path

log = logging.getLogger("akowe.legacy")

OLD_NAME = "BookForge"
OLD_ENV_PREFIX = "BOOKFORGE_"
OLD_DATA_DIR_WINDOWS = "Bookforge"
OLD_DATA_DIR_POSIX = "bookforge"
OLD_DB = "bookforge.sqlite3"
OLD_PACKAGE = "book.bookforge"
OLD_PACKAGE_EXT = ".bookforge"
OLD_MARKER = ".bookforge-folder.json"
OLD_PACKAGE_FORMAT = "bookforge-package"
OLD_BIBLE_KIND = "bookforge-book-bible"
OLD_BACKUP_INFO = "bookforge-backup.json"
OLD_BOOKS_DIR = "BookForge Books"
OLD_SECRETS_DIR = ".bookforge"
OLD_ASSET_SCHEME = "bookforge-asset"
OLD_APP_ID = "bookforge"  # the "app" value of /api/ping and status pushes from an older version
MIGRATED_NOTE = "MOVED-TO-AKOWE.txt"

DB = "akowe.sqlite3"
DB_SIDECARS = ("-wal", "-shm", "-journal")


def env(name: str, default: str | None = None) -> str | None:
    """``AKOWE_<name>``, else the old ``BOOKFORGE_<name>``, else ``default`` (empty values count as unset)."""
    for key in ("AKOWE_" + name, OLD_ENV_PREFIX + name):
        v = os.environ.get(key)
        if v:
            return v
    return default


def old_data_dir(new: Path) -> Path:
    """The former data folder next to ``new`` (same parent, old spelling)."""
    return new.parent / (OLD_DATA_DIR_WINDOWS if os.name == "nt" else OLD_DATA_DIR_POSIX)


def _has_data(d: Path) -> bool:
    return (d / DB).exists() or (d / OLD_DB).exists()


def migrate_data_dir(new: str | os.PathLike, old: str | os.PathLike | None = None) -> Path:
    """Bring the old data folder over to ``new`` once and return the folder to use.

    * ``new`` already holds a database (or there is no old folder): nothing to do -> ``new``.
    * ``new`` does not exist: the old folder is renamed (the quick, atomic case) -> ``new``.
    * otherwise (``new`` exists without data, e.g. a launcher made its venv there first, or the rename failed): the
      old folder's content is copied into a staging folder, moved into ``new`` entry by entry (the database last)
      and the old folder gets a note saying where everything went -> ``new``.
    * any failure: whatever was staged is removed and the OLD folder is returned, untouched, so no data is lost.
    """
    new = Path(new)
    old = Path(old) if old is not None else old_data_dir(new)
    try:
        if not old.is_dir() or old.resolve() == new.resolve() or _has_data(new) or (old / MIGRATED_NOTE).exists():
            return new
    except OSError:
        return new
    if not new.exists():
        try:
            new.parent.mkdir(parents=True, exist_ok=True)
            os.rename(old, new)
            log.warning("Akọwe (formerly BookForge): moved the data folder %s to %s", old, new)
            return new
        except OSError as exc:
            log.warning("Could not move the old data folder %s to %s (%s); copying it instead", old, new, exc)
    staging = new.parent / f".{new.name}-migrating-{os.getpid()}"
    try:
        shutil.rmtree(staging, ignore_errors=True)
        shutil.copytree(old, staging, ignore=shutil.ignore_patterns("venv"))
        new.mkdir(parents=True, exist_ok=True)
        entries = sorted(staging.iterdir(), key=lambda p: (p.name.startswith(OLD_DB) or p.name.startswith(DB), p.name))
        for p in entries:  # the database (and its -wal/-shm) last: a folder only counts as migrated once it is there
            target = new / p.name
            if not target.exists():
                os.replace(p, target)
        shutil.rmtree(staging, ignore_errors=True)
        try:
            (old / MIGRATED_NOTE).write_text(
                f"BookForge is now called Akọwe. Everything in this folder was copied to:\n{new}\n"
                "Akọwe uses that folder from now on. You can delete this old folder once you have checked "
                "your books are all there.\n", encoding="utf-8")
        except OSError:
            pass
        log.warning("Akọwe (formerly BookForge): copied the data folder %s to %s (the old folder is kept)", old, new)
        return new
    except OSError as exc:
        shutil.rmtree(staging, ignore_errors=True)
        log.warning("Could not copy the old data folder %s to %s (%s); using the old folder for now", old, new, exc)
        return old


def migrate_db_file(data_dir: Path) -> Path:
    """``<data_dir>/akowe.sqlite3``; an old ``bookforge.sqlite3`` (with its -wal/-shm/-journal) is renamed first."""
    new = Path(data_dir) / DB
    old = Path(data_dir) / OLD_DB
    if not new.exists() and old.exists():
        try:
            for suffix in DB_SIDECARS:  # sidecars first, so a crash in between never leaves a db without its WAL
                side = Path(str(old) + suffix)
                if side.exists():
                    os.replace(side, Path(str(new) + suffix))
            os.replace(old, new)
            log.warning("Akọwe (formerly BookForge): renamed the database %s to %s", old.name, new.name)
        except OSError as exc:  # keep using the old file name rather than starting an empty database
            log.warning("Could not rename %s (%s); using it under its old name", old, exc)
            return old
    return new


def db_in(folder: str | os.PathLike) -> Path:
    """The database file of a data folder or backup: ``akowe.sqlite3``, or the old name when only that exists."""
    folder = Path(folder)
    new = folder / DB
    if not new.exists() and (folder / OLD_DB).exists():
        return folder / OLD_DB
    return new


def secrets_path() -> Path:
    """``AKOWE_SECRETS`` / ``BOOKFORGE_SECRETS``, else ``~/.akowe/secrets.json`` (copied once from ``~/.bookforge``)."""
    given = env("SECRETS")
    if given:
        return Path(given)
    new = Path.home() / ".akowe" / "secrets.json"
    old = Path.home() / OLD_SECRETS_DIR / "secrets.json"
    if not new.exists() and old.is_file():
        try:
            new.parent.mkdir(parents=True, exist_ok=True)
            try:
                os.chmod(new.parent, 0o700)
            except OSError:
                pass
            shutil.copy2(old, new)
            try:
                os.chmod(new, 0o600)
            except OSError:
                pass
            log.warning("Akọwe (formerly BookForge): copied the saved keys %s to %s", old, new)
        except OSError as exc:
            log.warning("Could not copy the saved keys %s (%s); reading them from there", old, exc)
            return old
    return new


def default_books_folder(new: Path) -> Path:
    """The default books folder: ``new``, or the old "BookForge Books" next to it when only that one exists."""
    old = new.parent / OLD_BOOKS_DIR
    try:
        if not new.exists() and old.is_dir():
            return old
    except OSError:
        pass
    return new
