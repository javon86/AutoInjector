"""📋 Copy diagnostics (S8): one safe report to paste into a message when something is wrong.

It contains: BookForge and contract versions, operating system, Python and SQLite versions, the port, the health
check results, recent errors (code, API path, short message), background job states (kind, status, step, error
code), and the AI slots (adapter, site or model, whether a key is saved - never the key). It never contains API
keys, connection keys, the access token, prompts, AI replies, book titles or book text: only whitelisted fields
are copied, error messages are shortened and quoted values are removed, and as a last guard every saved secret
and the access token are searched for and replaced before the report leaves the server.
"""
from __future__ import annotations

import json
import platform
import re
import sqlite3
import sys
import threading
import time
from collections import deque

from . import CLOSURE_REVISION, CONTRACT_VERSION, __version__
from .health import safe_check
from .jobs import now_iso

MAX_ERRORS = 50
QUOTED = re.compile(r"(['\"“‘])(?:(?!\1).){12,}?\1")
LONG_TOKEN = re.compile(r"[A-Za-z0-9_\-]{32,}")


def scrub_text(text, limit: int = 200) -> str:
    """Short, quote-free version of a message (quoted values may be book text)."""
    t = str(text or "")
    t = QUOTED.sub(r"\1…\1", t)
    t = LONG_TOKEN.sub("[long value removed]", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t[:limit]


class ErrorLog:
    """Recent API/job errors (code, path, short message) kept in memory for diagnostics."""

    def __init__(self):
        self._lock = threading.Lock()
        self._items: deque = deque(maxlen=MAX_ERRORS)

    def add(self, status: int, method: str, path: str, errors: list):
        api_path = re.sub(r"/(proj|run|wall|assist|review|fix|bible|req|job)-[A-Za-z0-9_-]+", r"/\1-…", path or "")
        with self._lock:
            for e in (errors or [])[:3]:
                self._items.append({"at": now_iso(), "status": status, "method": method, "api": api_path[:120],
                                    "code": e.get("code"), "path": str(e.get("path") or "")[:120],
                                    "message": scrub_text(e.get("message"))})

    def recent(self) -> list[dict]:
        with self._lock:
            return list(self._items)


def _secrets(app) -> list[str]:
    out = [app.token] if getattr(app, "token", None) else []
    try:
        for v in app.engine.providers._secrets().values():
            k = (v or {}).get("api_key")
            if k:
                out.append(k)
    except Exception:  # noqa: BLE001
        pass
    return [s for s in out if isinstance(s, str) and len(s) >= 6]


def build(app, client: dict | None = None) -> dict:
    prov = app.engine.providers
    slots = []
    for s in prov.slots():
        item = {"slot_id": s["slot_id"], "adapter": s["adapter_id"], "key_saved": bool(s.get("has_credentials")),
                "healthy": bool(s.get("healthy")), "busy_jobs": s.get("active_jobs"), "roles": list(s.get("roles") or [])}
        if s["adapter_id"] == "autoinjector":
            item.update(site=s.get("site"), bridge_url=s.get("bridge_url"))
        elif s["adapter_id"] == "anthropic":
            item.update(model=s.get("model"))
        slots.append(item)
    try:
        health = app.health.run(force=False)
        health_out = {"overall": health["overall"], "checked_at": health["checked_at"],
                      "checks": [safe_check(c) for c in health["checks"]]}
        for c in health_out["checks"]:
            c["detail"] = scrub_text(c.get("detail"), 160)
    except Exception as exc:  # noqa: BLE001
        health_out = {"overall": "unknown", "error": type(exc).__name__}
    jobs = []
    for j in app.jobstore.list(limit=30):
        cur = j.get("current")
        err = j.get("problem") or j.get("error") or {}
        jobs.append({"id": j.get("id"), "kind": j.get("kind"), "status": j.get("status"), "step": cur,
                     "updated_at": j.get("updated_at"), "error_code": err.get("code") if isinstance(err, dict) else None,
                     "steps_done": sum(1 for s in j.get("steps") or [] if s.get("state") == "done") or None})
    projects = app.store.query_one("SELECT COUNT(*) AS n FROM projects WHERE archived=0")
    rep = {
        "report": "bookforge-diagnostics", "generated_at": now_iso(),
        "app": {"version": __version__, "contract": CONTRACT_VERSION, "closure": CLOSURE_REVISION,
                "port": getattr(app, "port", None), "uptime_s": int(time.monotonic() - getattr(app, "started", time.monotonic()))},
        "system": {"os": f"{platform.system()} {platform.release()}", "machine": platform.machine(),
                   "python": sys.version.split()[0], "sqlite": sqlite3.sqlite_version},
        "health": health_out,
        "recent_errors": app.errors.recent()[-25:],
        "jobs": jobs,
        "ai_slots": slots,
        "status_push": {"sent": getattr(app.pusher, "sent", 0), "last_error": getattr(app.pusher, "last_error", None)},
        "books": {"count": projects["n"] if projects else 0},
        "backups": {"count": len(app.backups.list()), "newest": (app.backups.latest() or {}).get("created_at")},
        "note": "No keys, tokens, prompts, AI replies, book titles or book text are included.",
    }
    if isinstance(client, dict):
        rep["browser"] = {k: scrub_text(client.get(k), 160) for k in ("user_agent", "screen", "page") if client.get(k)}
        errs = client.get("errors") if isinstance(client.get("errors"), list) else []
        rep["browser_errors"] = [{"at": scrub_text(e.get("at"), 30), "code": scrub_text(e.get("code"), 40),
                                  "where": scrub_text(e.get("where"), 80), "message": scrub_text(e.get("message"))}
                                 for e in errs[-15:] if isinstance(e, dict)]
    return guard(app, rep)


def _book_words(app) -> list[str]:
    """Book titles, author names and project names: never part of diagnostics (they are the author's text)."""
    out = set()
    try:
        for r in app.store.query("SELECT name FROM projects"):
            out.add(r["name"])
        for r in app.store.query("SELECT value FROM settings WHERE key LIKE 'book_profile:%'"):
            try:
                prof = json.loads(r["value"])
            except ValueError:
                continue
            for k in ("title", "author"):
                if isinstance(prof, dict) and isinstance(prof.get(k), str):
                    out.add(prof[k])
    except Exception:  # noqa: BLE001
        pass
    return sorted((w for w in out if isinstance(w, str) and len(w.strip()) >= 4), key=len, reverse=True)


def guard(app, rep: dict) -> dict:
    """Last line of defence: no saved secret, the access token or a book title may appear in any value."""
    secrets = _secrets(app)
    words = _book_words(app)

    def clean(v):
        if isinstance(v, str):
            for s in secrets:
                v = v.replace(s, "[redacted]")
            for w in words:
                v = v.replace(w, "[book]")
            return v
        if isinstance(v, dict):
            return {k: clean(x) for k, x in v.items()}
        if isinstance(v, list):
            return [clean(x) for x in v]
        return v
    return clean(rep)


def render_text(rep: dict) -> str:
    lines = ["BookForge diagnostics (safe to share: no keys, prompts or book text)",
             f"Generated: {rep['generated_at']}",
             f"BookForge {rep['app']['version']} · contract {rep['app']['contract']} · port {rep['app']['port']}",
             f"System: {rep['system']['os']} ({rep['system']['machine']}) · Python {rep['system']['python']} · "
             f"SQLite {rep['system']['sqlite']}",
             f"Health: {rep['health'].get('overall')}"]
    for c in rep["health"].get("checks") or []:
        mark = {"ok": "OK", "info": "--", "warn": "!!", "problem": "XX"}.get(c.get("status"), "??")
        lines.append(f"  [{mark}] {c.get('title')}: {c.get('detail') or ''}" + (f" ({c['code']})" if c.get("code") else ""))
    lines.append("AI slots:")
    for s in rep["ai_slots"]:
        lines.append(f"  {s['slot_id']}: {s['adapter']}" + (f" {s.get('site')}" if s.get("site") else "")
                     + (f" {s.get('model')}" if s.get("model") else "") + f" · key saved: {s['key_saved']}")
    lines.append(f"Books: {rep['books']['count']} · backups: {rep['backups']['count']} (newest {rep['backups']['newest']})")
    lines.append("Background work:")
    for j in rep["jobs"][:15]:
        lines.append(f"  {j['kind']} {j['id']}: {j['status']}" + (f" at {j['step']}" if j.get("step") else "")
                     + (f" ⚠ {j['error_code']}" if j.get("error_code") else ""))
    lines.append("Recent errors:")
    for e in rep["recent_errors"][-15:] or [{"code": "none"}]:
        if e.get("code") == "none":
            lines.append("  none")
            break
        lines.append(f"  {e['at']} {e['status']} {e['method']} {e['api']} {e['code']} {e['path']} {e['message']}")
    for e in rep.get("browser_errors") or []:
        lines.append(f"  browser {e.get('at')} {e.get('code')} {e.get('where')} {e.get('message')}")
    return "\n".join(lines) + "\n"
