"""Automatic backups (S9): before big steps, daily on first start, with rotation, listing and a guarded restore.

Every backup is the storage kernel's own transaction-consistent snapshot (``Store.backup``: database + asset
bytes + a SHA-256 manifest, fsynced; credentials live outside the database and are never included), verified right
after it is written (``Store.verify_backup``: hashes, SQLite integrity_check, every asset against the hash its record
promises). Backups live in ``<data_dir>/backups/<name>`` named ``bk-<sequence>-<UTC stamp>-<reason>``. The sequence
number, not the wall clock, says which backup is newer, so a clock that jumps back or forward cannot reorder them.

Rotation (``backup_keep``, default 10) only ever removes AUTOMATIC backups (daily, before a run / assembling /
exporting / deleting a book), and only once that many newer automatic backups VERIFIED: a damaged new backup never
pushes a good old one out. Backups you made with "Back up now" and the safety copies made before a restore are
pinned (never rotated), and the backup being restored from is never rotated.

Restore never writes into a backup or trusts an unverified one: ``Store.restore`` first copies the verified
snapshot into a NEW folder (it refuses on any hash problem or a newer schema version), a fresh safety backup of the
current state is made, and only then the restored database is copied into the live database with SQLite's
online-backup API (so open connections see the restored content) and every asset file that is missing or damaged
is replaced (assets are content-addressed). Restore is exclusive: it is refused while any other writer (a run, a
book step, an AI job, a request) is active, and new writers are refused while it runs. It needs the author's
explicit confirmation (``author_confirms: true`` and the word RESTORE).
"""
from __future__ import annotations

import json
import logging
import re
import shutil
import sqlite3
import threading
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .canonical import sha256_bytes
from .errors import BookforgeError
from .store import Store, durable_copy, fsync_dir, fsync_file

log = logging.getLogger("bookforge.backups")

DEFAULT_KEEP = 10
NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
SEQ_RE = re.compile(r"^bk-(\d{1,12})-")
REASONS = {"daily": "Daily backup (first start of the day)", "manual": "You pressed Back up now",
           "before-run": "Before a Make-a-book-for-me run", "before-assemble": "Before putting a book together",
           "before-export": "Before exporting a book", "before-restore": "Safety copy before a restore",
           "before-delete": "Before a book was deleted"}
AUTOMATIC = {"daily", "before-run", "before-assemble", "before-export", "before-delete"}  # rotated
PINNED = {"manual", "before-restore"}  # never rotated
DISK_MESSAGE = "the backup could not be written (is the disk full or the data folder read-only?)"


def _stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")


def _seq(name: str) -> int:
    m = SEQ_RE.match(name)
    return int(m.group(1)) if m else 0  # older names (auto-<stamp>-...) sort before every numbered backup


class BackupManager:
    def __init__(self, store: Store, busy=None, exclusive=None, after_restore=None):
        self.store = store
        # callable(name): runs after a successful restore (e.g. work that was live in the backup becomes interrupted)
        self.after_restore = after_restore
        self.dir = Path(store.data_dir) / "backups"
        self._lock = threading.RLock()
        self.busy = busy  # callable -> str|None: why a restore must wait (e.g. a run is active)
        self.exclusive = exclusive  # context manager factory: no new writer may start while it is held
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
    def _next_seq(self) -> int:
        try:
            return max((_seq(d.name) for d in self.dir.iterdir()), default=0) + 1
        except OSError:
            return 1

    def backup(self, reason: str = "manual", protect: tuple = ()) -> dict:
        reason = reason if reason in REASONS else "manual"
        with self._lock:
            dest = None
            try:
                self.dir.mkdir(parents=True, exist_ok=True)
                dest = self.dir / f"bk-{self._next_seq():06d}-{_stamp()}-{reason}"
                manifest = self.store.backup(dest)
                problems = Store.verify_backup(dest)
                info = {"reason": reason, "label": REASONS[reason], "verified": not problems,
                        "problems": problems[:5]}
                (dest / "bookforge-backup.json").write_text(json.dumps(info), encoding="utf-8")
                fsync_file(dest / "bookforge-backup.json")
                fsync_dir(dest)
            except (OSError, sqlite3.Error) as exc:
                self.last_error = f"{type(exc).__name__}: {exc}"[:300]
                log.error("backup failed: %s", self.last_error)
                if dest is not None:
                    shutil.rmtree(dest, ignore_errors=True)
                raise BookforgeError("INTERNAL_ERROR", "/backup", DISK_MESSAGE) from exc
            if problems:
                # Keep the damaged backup for inspection, but never let it push a good one out of rotation.
                self.last_error = f"backup {dest.name} did not verify: {'; '.join(problems[:2])}"[:300]
                log.error("%s", self.last_error)
            else:
                self.last_error = None
                self.rotate(protect=tuple(protect) + (dest.name,))
        return dict(self._describe(dest), created_at=manifest.get("created_at"), problems=problems[:5])

    def try_backup(self, reason: str) -> dict | None:
        """Best effort (used before big steps): never raises."""
        try:
            return self.backup(reason)
        except Exception as exc:  # noqa: BLE001
            if not self.last_error:
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
        except (OSError, ValueError, AttributeError):
            pass
        reason = info.get("reason")
        return {"name": d.name, "created_at": created, "reason": reason, "label": info.get("label"),
                "verified": info.get("verified"), "bytes": size, "pinned": reason not in AUTOMATIC,
                "seq": _seq(d.name)}

    def list(self) -> list[dict]:
        """Newest first, by sequence number (then the manifest's time for backups made before numbering)."""
        try:
            dirs = [d for d in self.dir.iterdir() if d.is_dir() and (d / "manifest.json").exists()]
        except OSError:
            return []
        out = [self._describe(d) for d in dirs]
        out.sort(key=lambda x: (x["seq"], x.get("created_at") or "", x["name"]), reverse=True)
        return out

    def latest(self) -> dict | None:
        items = self.list()
        return items[0] if items else None

    def rotate(self, protect: tuple = ()):
        """Remove automatic backups beyond the newest ``keep`` verified ones; pinned ones and ``protect`` stay."""
        keep = self.keep()
        good = 0
        with self._lock:
            for b in self.list():
                if b["pinned"]:
                    continue
                if good < keep:
                    if b["verified"]:
                        good += 1
                    continue  # an unverified backup newer than the kept good ones stays (for inspection)
                if b["name"] in protect:
                    continue  # e.g. the backup that is being restored from
                shutil.rmtree(self.dir / b["name"], ignore_errors=True)

    def daily_if_needed(self) -> dict | None:
        last = self.latest()
        if last and last.get("created_at"):
            try:
                t = datetime.strptime(last["created_at"][:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
                age = datetime.now(timezone.utc) - t
                # A backup stamped in the future (the clock went back since) says nothing about today: back up.
                if timedelta(0) <= age < timedelta(hours=20):
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
        src = self.dir / name
        schema = Store.schema_problem(src)
        if schema:
            raise BookforgeError("UNSUPPORTED_CONTRACT", "/name", schema, status="REJECTED")
        with (self.exclusive() if self.exclusive else nullcontext()):
            why = self.busy() if self.busy else None
            if why:
                raise BookforgeError("VERSION_CONFLICT", "/name", f"wait until {why} is finished (or pause it), then "
                                     "restore", status="REJECTED")
            problems = Store.verify_backup(src)
            if problems:
                raise BookforgeError("HASH_MISMATCH", "/name", "this backup is damaged and was not restored: "
                                     + "; ".join(problems[:3]), status="REJECTED")
            with self._lock:
                return self._restore_locked(name, src)

    def _restore_locked(self, name: str, src: Path) -> dict:
        staging = Path(self.store.data_dir) / f"restore-staging-{_stamp()}"
        live_touched = False
        try:
            restored = Store.restore(src, staging)  # verifies again and copies into a NEW empty folder
            restored.close()
            safety = self.backup("before-restore", protect=(name,))
            digests = json.loads((src / "manifest.json").read_text()).get("assets") or {}
            rconn = sqlite3.connect(staging / "bookforge.sqlite3")
            live_touched = True
            try:
                with self.store.connection() as live:
                    rconn.backup(live)
            finally:
                rconn.close()
            repaired = 0
            for f in sorted((staging / "assets").iterdir()):
                dst = Path(self.store.asset_dir) / f.name
                want = digests.get(f.name)
                try:
                    if dst.is_file() and want and sha256_bytes(dst.read_bytes()) == want:
                        continue
                except OSError:
                    pass
                durable_copy(f, dst)  # missing or damaged: put the verified bytes back
                repaired += 1
        except (OSError, sqlite3.Error) as exc:
            self.last_error = f"{type(exc).__name__}: {exc}"[:300]
            log.error("restore of %s failed: %s", name, self.last_error)
            if not live_touched:
                raise BookforgeError("INTERNAL_ERROR", "/name", "the restore could not start (is the disk full or the "
                                     "data folder read-only?); nothing was changed") from exc
            raise BookforgeError("INTERNAL_ERROR", "/name", "the restore could not finish (is the disk full or the "
                                 "data folder read-only?); your books may be partly restored: restore again, or "
                                 "restore the safety copy") from exc
        finally:
            shutil.rmtree(staging, ignore_errors=True)
        log.info("restored backup %s (safety copy %s, %d asset files put back)", name, safety.get("name"), repaired)
        if self.after_restore:
            try:
                self.after_restore(name)
            except Exception:  # noqa: BLE001 - the restore itself is done; never report it as failed
                log.exception("after restoring %s: follow-up failed", name)
        return {"restored": name, "safety_backup": safety.get("name"), "assets_repaired": repaired,
                "message": f"Your books were restored from the backup of {self._describe(src).get('created_at')}. "
                           f"A safety copy of how things were just before is kept as {safety.get('name')}."}
