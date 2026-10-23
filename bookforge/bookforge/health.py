"""❤️ Health checks (R12): small, safe self-checks the top bar runs about every minute while the page is visible.

Each check answers {id, title, status: ok|warn|problem|info, detail, fix, action}. ``overall`` is the worst status
(info counts as ok). Checks are light: the database is read and a single settings row is written; the disk check
uses ``shutil.disk_usage``; the database check also runs SQLite's ``PRAGMA quick_check`` (page and b-tree
damage) at most every ``QUICK_CHECK_S`` unless forced; AI slot checks reuse ``ProviderRegistry.health_check`` (the AutoInjector bridge's
GET /v1/health) at most once per ``SLOT_TTL_S`` per slot; exported files are re-read and their SHA-256 compared
with the export descriptor; stuck jobs are live jobs whose state did not change for ``STUCK_S``.
Results never contain keys, tokens, prompts or book text.
"""
from __future__ import annotations

import importlib.util
import json
import shutil
import threading
import time
from datetime import datetime, timezone

from .jobs import LIVE, now_iso

CACHE_S = 30.0
SLOT_TTL_S = 120.0
STUCK_S = 15 * 60
LOW_DISK = 500 * 1024 * 1024
VERY_LOW_DISK = 100 * 1024 * 1024
BACKUP_WARN_DAYS = 7
QUICK_CHECK_S = 600.0  # SQLite's quick_check reads the whole file: at most every 10 minutes unless forced
RANK = {"ok": 0, "info": 0, "warn": 1, "problem": 2}


def _age_s(iso: str | None) -> float | None:
    if not iso:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            return time.time() - datetime.strptime(iso, fmt).replace(tzinfo=timezone.utc).timestamp()
        except ValueError:
            continue
    return None


def _human_bytes(n: int) -> str:
    for unit in ("bytes", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "bytes" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n} bytes"


class HealthService:
    def __init__(self, app):
        self.app = app
        self._lock = threading.Lock()
        self._last: dict | None = None
        self._at = 0.0
        self._slot_cache: dict[str, tuple[float, dict]] = {}
        self._qc: tuple[float, list] | None = None  # (monotonic time, quick_check rows)

    def run(self, force: bool = False) -> dict:
        with self._lock:
            if not force and self._last and time.monotonic() - self._at < CACHE_S:
                return self._last
        checks = []
        for fn in (self.c_database, self.c_disk, self.c_backups, self.c_slots, self.c_bridge, self.c_exports,
                   self.c_jobs):
            try:
                out = fn(force)
                checks.extend(out if isinstance(out, list) else [out])
            except Exception as exc:  # noqa: BLE001 - a broken check is itself a finding
                checks.append({"id": fn.__name__[2:], "title": fn.__name__[2:].title(), "status": "warn",
                               "detail": f"This check could not run ({type(exc).__name__}).",
                               "fix": "Press Run checks again. If it stays, use 📋 Copy diagnostics.",
                               "code": "INTERNAL_ERROR"})
        overall = max((c["status"] for c in checks), key=lambda s: RANK.get(s, 0), default="ok")
        res = {"overall": "ok" if overall == "info" else overall, "checked_at": now_iso(), "checks": checks,
               "counts": {k: sum(1 for c in checks if c["status"] == k) for k in ("ok", "info", "warn", "problem")}}
        with self._lock:
            self._last, self._at = res, time.monotonic()
        return res

    # ------------------------------------------------------------------ checks
    def c_database(self, force):
        st = self.app.store
        t0 = time.monotonic()
        try:
            st.query_one("SELECT COUNT(*) AS n FROM projects")
            st.set_setting("health:probe", {"at": now_iso()})
            ok = (st.get_setting("health:probe") or {}).get("at")
            qc = self._qc
            if force or qc is None or time.monotonic() - qc[0] > QUICK_CHECK_S:
                qc = (time.monotonic(), [str(r[0]) for r in st.query("PRAGMA quick_check")])
                self._qc = qc
        except Exception as exc:  # noqa: BLE001
            return {"id": "database", "title": "Your books' database", "status": "problem",
                    "detail": f"BookForge could not read or write its database ({type(exc).__name__}).",
                    "fix": "Close other programs that might use the BookForge data folder, make sure the disk is not "
                           "full, then restart BookForge. If it stays, restore the newest verified backup "
                           "(Settings → Backups).", "code": "INTERNAL_ERROR"}
        ms = int((time.monotonic() - t0) * 1000)
        if qc[1] != ["ok"]:
            return {"id": "database", "title": "Your books' database", "status": "problem", "code": "HASH_MISMATCH",
                    "detail": "SQLite found damage inside the BookForge database file (quick_check: "
                              f"{'; '.join(qc[1][:2])[:200]}).",
                    "fix": "Stop working in BookForge, then restore the newest verified backup made before the damage "
                           "(Settings → Backups). Backups of a damaged database are marked as not verified.",
                    "action": "settings"}
        return {"id": "database", "title": "Your books' database", "status": "ok" if ok else "problem",
                "detail": f"Readable, writable and undamaged ({ms} ms).", "fix": None}

    def c_disk(self, force):
        d = self.app.store.data_dir
        free = shutil.disk_usage(d).free
        status = "ok" if free >= LOW_DISK else "warn" if free >= VERY_LOW_DISK else "problem"
        return {"id": "disk", "title": "Free space for your books", "status": status,
                "detail": f"{_human_bytes(free)} free on the disk that holds your BookForge data.",
                "fix": None if status == "ok" else "Free some disk space (empty the recycle bin, delete large files you "
                "no longer need). BookForge needs room for exports and backups."}

    def c_backups(self, force):
        last = self.app.backups.latest()
        if not last and self.app.store.query_one("SELECT 1 FROM projects LIMIT 1") is None:
            # a fresh install: nothing to back up yet, so nothing is wrong (BF-14)
            return {"id": "backups", "title": "Backups", "status": "info",
                    "detail": "No backup yet: there is no book to back up. BookForge backs up automatically once "
                              "you start one.", "fix": None}
        if not last:
            return {"id": "backups", "title": "Backups", "status": "warn", "detail": "No backup yet.",
                    "fix": "Press 💾 Back up now (Settings → Backups). BookForge also backs up automatically each day "
                           "and before big steps.", "action": "backup"}
        age = _age_s(last.get("created_at"))
        days = (age or 0) / 86400
        status = "ok" if last.get("verified") is not False and days < BACKUP_WARN_DAYS else "warn"
        err = self.app.backups.last_error
        detail = (f"Newest backup: {last.get('created_at')} ({last.get('label')}); "
                  f"{len(self.app.backups.list())} kept.")
        if err:
            status = "warn"
            detail += " The last automatic backup failed."
        return {"id": "backups", "title": "Backups", "status": status, "detail": detail,
                "fix": None if status == "ok" else "Press 💾 Back up now. If it fails, check the free disk space.",
                "action": None if status == "ok" else "backup"}

    def _slot_health(self, s, force) -> dict:
        prov = self.app.engine.providers
        sid = s["slot_id"]
        cached = self._slot_cache.get(sid)
        if cached and time.monotonic() - cached[0] < SLOT_TTL_S and not (force and time.monotonic() - cached[0] > 10):
            return cached[1]
        h = prov.health_check(sid)
        self._slot_cache[sid] = (time.monotonic(), h)
        return h

    def c_slots(self, force):
        prov = self.app.engine.providers
        out = []
        configured = 0
        for s in prov.slots():
            ad = s["adapter_id"]
            base = {"id": f"slot-{s['slot_id']}", "title": f"AI slot {s['slot_id']}", "slot_id": s["slot_id"]}
            if ad == "none":
                continue
            configured += 1
            if ad == "manual":
                out.append(dict(base, status="info", detail="Manual: you write the creative steps yourself.", fix=None))
            elif ad == "anthropic":
                if prov.test_adapter is not None:
                    out.append(dict(base, status="ok", detail="Anthropic API (test adapter).", fix=None))
                elif importlib.util.find_spec("anthropic") is None:
                    out.append(dict(base, status="problem", detail="The 'anthropic' package is not installed.",
                                    fix="Run: python -m pip install anthropic, then restart BookForge.",
                                    code="CAPABILITY_UNAVAILABLE", action="settings"))
                elif not s.get("has_credentials"):
                    out.append(dict(base, status="problem", detail="No API key is saved for this slot.",
                                    fix="Open Settings and paste an API key into this slot.",
                                    code="CAPABILITY_UNAVAILABLE", action="settings"))
                else:
                    out.append(dict(base, status="ok", detail=f"Anthropic API · {s.get('model')} · key saved.",
                                    fix=None))
            elif ad == "autoinjector":
                site = {"claude": "Claude", "chatgpt": "ChatGPT", "gemini": "Gemini"}.get(s.get("site"), s.get("site"))
                if not s.get("has_credentials"):
                    out.append(dict(base, status="problem", detail=f"{site} through AutoInjector: no connection key.",
                                    fix="In AutoInjector press Connect (or paste the connection key in Settings).",
                                    code="CAPABILITY_UNAVAILABLE", action="settings"))
                    continue
                h = self._slot_health(s, force)
                if h.get("ok"):
                    busy = " (busy right now)" if h.get("site_busy") else ""
                    out.append(dict(base, status="ok", detail=f"{site} through AutoInjector: ready{busy}.", fix=None))
                else:
                    out.append(dict(base, status="problem", detail=f"{site} through AutoInjector: {h.get('message')}",
                                    code=h.get("error") or "UPSTREAM_UNAVAILABLE", action="settings",
                                    fix="Start the AutoInjector desktop app, open and log in to the site's pane, then "
                                        "press Test connection in Settings."))
        if not configured:
            # not set up is a choice, not a fault: you can write everything yourself (BF-14)
            out.append({"id": "slots", "title": "AI slots", "status": "info",
                        "detail": "No AI is set up: you write the creative steps yourself.",
                        "fix": "To let an AI help, open Settings: connect AutoInjector or add an Anthropic API key.",
                        "action": "settings"})
        return out

    def c_bridge(self, force):
        prov = self.app.engine.providers
        ai = [s for s in prov.slots() if s["adapter_id"] == "autoinjector" and s.get("has_credentials")]
        if not ai:
            return {"id": "bridge", "title": "AutoInjector link", "status": "info",
                    "detail": "Not connected (only needed for the AutoInjector web AIs).", "fix": None}
        pusher = self.app.pusher
        ok_slots = [s for s in ai if (self._slot_cache.get(s["slot_id"]) or (0, {}))[1].get("ok")]
        stopped = any(t.stopped for t in getattr(pusher, "_targets", {}).values())
        if stopped:
            return {"id": "bridge", "title": "AutoInjector link", "status": "warn",
                    "detail": "AutoInjector refused BookForge's connection key for status updates.",
                    "fix": "In AutoInjector press Connect again (it gives BookForge a new key).", "action": "settings",
                    "code": "PERMISSION_DENIED"}
        if not ok_slots:
            return {"id": "bridge", "title": "AutoInjector link", "status": "problem",
                    "detail": "The AutoInjector bridge does not answer.", "code": "UPSTREAM_UNAVAILABLE",
                    "fix": "Start the AutoInjector desktop app and switch its BookForge bridge on.", "action": "settings"}
        detail = "Bridge reachable."
        status = "ok"
        if pusher.sent:
            detail += f" Status updates sent: {pusher.sent}."
        elif pusher.last_error:
            detail += f" Status updates are not getting through yet ({pusher.last_error})."
            status = "warn"
        return {"id": "bridge", "title": "AutoInjector link", "status": status, "detail": detail,
                "fix": None if status == "ok" else "Keep AutoInjector open; BookForge retries on its own."}

    def c_exports(self, force):
        from .shelf import finished_books  # noqa: PLC0415
        books = finished_books(self.app, verify=True, limit=5)
        if not books:
            return {"id": "exports", "title": "Exported books", "status": "info",
                    "detail": "No exported book yet.", "fix": None}
        bad = [(b, f) for b in books for f in b["files"] if not f.get("verified")]
        if bad:
            b, f = bad[0]
            return {"id": "exports", "title": "Exported books", "status": "problem", "code": "HASH_MISMATCH",
                    "detail": f"The {f['format']} file of “{b['title']}” is missing or damaged.",
                    "fix": "Open the book's Make my book page and press 📦 Export my book again.",
                    "action": "book", "project_id": b["project_id"]}
        n = sum(len(b["files"]) for b in books)
        return {"id": "exports", "title": "Exported books", "status": "ok",
                "detail": f"The newest {len(books)} finished book(s): {n} file(s) present and unchanged.", "fix": None}

    def c_jobs(self, force):
        stuck, live, interrupted = [], 0, 0
        for j in self.app.jobstore.list(limit=200):
            if j.get("status") == "interrupted":
                interrupted += 1
            if j.get("status") not in LIVE:
                continue
            live += 1
            age = _age_s(j.get("updated_at"))
            if age is not None and age > STUCK_S and j.get("status") != "waiting":
                stuck.append(j)
        if stuck:
            return {"id": "jobs", "title": "Background work", "status": "warn", "code": "TIMEOUT",
                    "detail": f"{len(stuck)} job(s) did not move for more than {STUCK_S // 60} minutes.",
                    "fix": "Open the job (Make a book for me / Background work) and press Pause then Resume, or "
                           "Cancel it.", "action": "jobs"}
        if interrupted:
            return {"id": "jobs", "title": "Background work", "status": "warn",
                    "detail": f"{interrupted} job(s) were interrupted when BookForge stopped.",
                    "fix": "Open Background work and press ▶ Resume (or dismiss it).", "action": "jobs"}
        return {"id": "jobs", "title": "Background work", "status": "ok",
                "detail": f"{live} running, nothing stuck.", "fix": None}


def safe_check(c: dict) -> dict:
    """The fields of a check that are safe to copy into diagnostics."""
    return {k: c.get(k) for k in ("id", "title", "status", "detail", "code") if c.get(k) is not None}


def to_json(res: dict) -> str:
    return json.dumps(res, ensure_ascii=False)
