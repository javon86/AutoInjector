"""Automatic backups (S9): before big steps, daily on first start, with rotation, listing and a guarded restore.

Every backup is the storage kernel's own transaction-consistent snapshot (``Store.backup``: database + asset
bytes + a SHA-256 manifest; credentials live outside the database and are never included), verified right after
it is written (``Store.verify_backup``). Backups live in ``<data_dir>/backups/<name>``; automatic ones are named
``auto-<UTC stamp>-<reason>``. Only the newest ``backup_keep`` (default 10) backups are kept.

Restore never writes into a backup or trusts an unverified one: ``Store.restore`` first copies the verified
snapshot into a NEW folder (it refuses on any hash problem), a fresh safety backup of the current state is made,
and only then the restored database is copied into the live database with SQLite's online-backup API (so open
connections see the restored content) and any missing asset files are added (assets are content-addressed).
Restore is refused while a Make-a-book run or another writer is active; it needs the author's explicit
confirmation (``author_confirms: true`` and the word RESTORE).
"""
from __future__ import annotations

import json
import logging
import re
import shutil
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .errors import BookforgeError
from .store import Store

log = logging.getLogger("bookforge.backups")

DEFAULT_KEEP = 10
NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
REASONS = {"daily": "Daily backup (first start of the day)", "manual": "You pressed Back up now",
           "before-run": "Before a Make-a-book-for-me run", "before-assemble": "Before putting a book together",
           "before-export": "Before exporting a book", "before-restore": "Safety copy before a restore"}


def _stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")


class BackupManager:
    def __init__(self, store: Store, busy=None):
        self.store = store
        self.dir = Path(store.data_dir) / "backups"
        self._lock = threading.Lock()
        self.busy = busy  # callable -> str|None: why a restore must wait (e.g. a run is active)
        self.last_error: str | None = None

    # ------------------------------------------------------------------ settings
    def keep(self) -> int:
        try:
            k = self.store.get_setting("backup_keep")
        except Exception:  # noqa: BLE001
            k = None
        return k if isinstance(k, int) and not isinstance(k, bool) and 1 <= k <= 100 else DEFAULT_KEEP

    def set_keep(self, n) -> int:
        if not isinstance(n, int) or isinstance(n, bool) or not 1 <= n <= 100:
            raise BookforgeError("INVALID_INPUT", "/keep", "keep 1 to 100 backups", status="REJECTED")
        self.store.set_setting("backup_keep", n)
        self.rotate()
        return n

    # ------------------------------------------------------------------ make / list / rotate
    def backup(self, reason: str = "manual") -> dict:
        reason = reason if reason in REASONS else "manual"
        with self._lock:
            self.dir.mkdir(parents=True, exist_ok=True)
            name = f"auto-{_stamp()}-{reason}"
            dest = self.dir / name
            try:
                manifest = self.store.backup(dest)
                problems = Store.verify_backup(dest)
                info = {"reason": reason, "label": REASONS[reason], "verified": not problems,
                        "problems": problems[:5]}
                (dest / "bookforge-backup.json").write_text(json.dumps(info), encoding="utf-8")
                self.last_error = None
            except OSError as exc:
                self.last_error = f"{type(exc).__name__}: {exc}"[:300]
                log.error("backup failed: %s", self.last_error)
                shutil.rmtree(dest, ignore_errors=True)
                raise BookforgeError("INTERNAL_ERROR", "/backup", "the backup could not be written (is the disk full "
                                     "or the data folder read-only?)") from exc
            self.rotate()
        return dict(self._describe(dest), created_at=manifest.get("created_at"))

    def try_backup(self, reason: str) -> dict | None:
        """Best effort (used before big steps): never raises."""
        try:
            return self.backup(reason)
        except Exception as exc:  # noqa: BLE001
            self.last_error = f"{type(exc).__name__}"
            log.warning("automatic backup (%s) failed: %s", reason, type(exc).__name__)
            return None

    def _describe(self, d: Path) -> dict:
        info = {}
        try:
            info = json.loads((d / "bookforge-backup.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            info = {"reason": "manual", "label": "Backup", "verified": None}
        created = None
        size = 0
        try:
            created = json.loads((d / "manifest.json").read_text()).get("created_at")
            size = sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
        except (OSError, ValueError):
            pass
        return {"name": d.name, "created_at": created, "reason": info.get("reason"), "label": info.get("label"),
                "verified": info.get("verified"), "bytes": size}

    def list(self) -> list[dict]:
        if not self.dir.exists():
            return []
        out = [self._describe(d) for d in self.dir.iterdir() if d.is_dir() and (d / "manifest.json").exists()]
        out.sort(key=lambda x: x.get("created_at") or "", reverse=True)
        return out

    def latest(self) -> dict | None:
        items = self.list()
        return items[0] if items else None

    def rotate(self):
        keep = self.keep()
        items = self.list()
        for old in items[keep:]:
            shutil.rmtree(self.dir / old["name"], ignore_errors=True)

    def daily_if_needed(self) -> dict | None:
        last = self.latest()
        if last and last.get("created_at"):
            try:
                t = datetime.strptime(last["created_at"][:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
                if datetime.now(timezone.utc) - t < timedelta(hours=20):
                    return None
            except ValueError:
                pass
        if not self.store.query_one("SELECT 1 FROM projects LIMIT 1"):
            return None  # nothing to protect yet
        return self.try_backup("daily")

    # ------------------------------------------------------------------ restore
    def restore(self, name, body) -> dict:
        body = body if isinstance(body, dict) else {}
        if body.get("author_confirms") is not True or str(body.get("confirm") or "").strip().upper() != "RESTORE":
            raise BookforgeError("APPROVAL_REQUIRED", "/confirm", "restoring replaces ALL your books with this backup: "
                                 "type RESTORE and confirm (author_confirms: true)", status="REJECTED")
        if not isinstance(name, str) or not NAME_RE.fullmatch(name) or not (self.dir / name / "manifest.json").exists():
            raise BookforgeError("NOT_FOUND", "/name", "that backup does not exist", status="REJECTED")
        why = self.busy() if self.busy else None
        if why:
            raise BookforgeError("VERSION_CONFLICT", "/name", f"wait until {why} is finished (or pause it), then "
                                 "restore", status="REJECTED")
        src = self.dir / name
        problems = Store.verify_backup(src)
        if problems:
            raise BookforgeError("HASH_MISMATCH", "/name", "this backup is damaged and was not restored: "
                                 + "; ".join(problems[:3]), status="REJECTED")
        with self._lock:
            staging = Path(self.store.data_dir) / f"restore-staging-{_stamp()}"
            restored = Store.restore(src, staging)  # verifies again and copies into a NEW empty folder
            restored.close()
        safety = self.backup("before-restore")
        try:
            with self._lock:
                rconn = sqlite3.connect(staging / "bookforge.sqlite3")
                try:
                    with self.store.connection() as live:
                        rconn.backup(live)
                finally:
                    rconn.close()
                for f in (staging / "assets").iterdir():
                    dst = Path(self.store.asset_dir) / f.name
                    if not dst.exists():
                        shutil.copy2(f, dst)
        finally:
            shutil.rmtree(staging, ignore_errors=True)
        log.info("restored backup %s (safety copy %s)", name, safety.get("name"))
        return {"restored": name, "safety_backup": safety.get("name"),
                "message": f"Your books were restored from the backup of {self._describe(src).get('created_at')}. "
                           f"A safety copy of how things were just before is kept as {safety.get('name')}."}
