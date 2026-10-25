"""Persisted background work (S11) and the AI retry queue (S10).

JobStore keeps a small JSON summary of every long-running piece of AI work in the existing ``settings`` table
(key ``job:<id>``) - Make-a-book runs, "Write all chapters", assist ("Fill with AI") jobs, AI review/fix jobs and
Bible Builder runs - so that a BookForge restart can show them again: finished work keeps its outcome, work that
was running when BookForge stopped is shown as ``interrupted`` with a Resume button (``mark_interrupted`` runs once
at start-up). No new table and no change to store.py: only ``Store.get_setting/set_setting`` and a read query.
Entries never hold API keys, connection keys or AI replies; a resumable job may keep the author's own request
(for example the Fill-with-AI prompt) because it is needed to run it again - it is never logged, never written
to reports, the journal or diagnostics.

RetryPolicy / wait_and_retry: when an AI call answers UPSTREAM_UNAVAILABLE, RATE_LIMITED or "site busy", a job
does not fail at once; it waits (default 15 s, 30 s, 60 s, 120 s, 120 s ... up to about 10 minutes in total,
configurable in the ``ai_retry`` setting) and tries again, showing "waiting for Claude (busy) - retrying in 30 s".
TIMEOUT is never retried automatically: an ambiguous generation is the author's decision (contract rule).
"""
from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime, timezone

from .errors import BookforgeError

log = logging.getLogger("bookforge.jobs")

PREFIX = "job:"
MAX_KEPT = 300
KEEP_FINISHED_S = 14 * 24 * 3600
LIVE = ("queued", "running", "waiting", "pausing")
BUSY_CODES = ("UPSTREAM_UNAVAILABLE", "RATE_LIMITED")
# After a 504 for a prompt it already typed, the AutoInjector bridge keeps that site reserved for the late answer
# for at most this long (bookforge-bridge.js LATE_WINDOW_MAX_MS); meanwhile other requests to the site get
# 409 SITE_BUSY (-> RATE_LIMITED here). The default busy-retry budget is twice that, so they still get their turn.
BRIDGE_LATE_WINDOW_S = 300
DEFAULT_RETRY = {"enabled": True, "delays_s": [15, 30, 60, 120], "max_total_s": 2 * BRIDGE_LATE_WINDOW_S}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def is_busy_error(exc) -> bool:
    """An AI answer that means "try again later": unreachable/overloaded/rate limited/site busy (never TIMEOUT)."""
    if not isinstance(exc, BookforgeError):
        return False
    if exc.code in BUSY_CODES:
        return True
    msg = " ".join(str(e.get("message") or "") for e in exc.errors)
    return "SITE_BUSY" in msg or "site is busy" in msg.lower()


def busy_code(errors: list) -> str | None:
    """The busy code in a dispatch response's error list (or None)."""
    for e in errors or []:
        if e.get("code") in BUSY_CODES or "SITE_BUSY" in str(e.get("message") or ""):
            return e.get("code") or "RATE_LIMITED"
    return None


class RetryPolicy:
    def __init__(self, delays_s=None, max_total_s=None, enabled=True, sleep=None):
        d = list(delays_s if delays_s is not None else DEFAULT_RETRY["delays_s"])
        self.delays_s = [max(0.0, float(x)) for x in d if isinstance(x, (int, float)) and not isinstance(x, bool)]
        self.max_total_s = float(max_total_s if max_total_s is not None else DEFAULT_RETRY["max_total_s"])
        self.enabled = bool(enabled) and bool(self.delays_s)
        self.sleep = sleep or time.sleep

    @classmethod
    def from_store(cls, store) -> "RetryPolicy":
        try:
            s = store.get_setting("ai_retry") or {}
        except Exception:  # noqa: BLE001 - settings are optional
            s = {}
        cfg = dict(DEFAULT_RETRY, **{k: v for k, v in s.items() if k in DEFAULT_RETRY}) if isinstance(s, dict) else \
            dict(DEFAULT_RETRY)
        return cls(cfg.get("delays_s"), cfg.get("max_total_s"), cfg.get("enabled", True))

    def delay(self, attempt: int) -> float:
        """Delay before retry number ``attempt`` (1-based); the last delay repeats."""
        if not self.delays_s:
            return 0.0
        return self.delays_s[min(attempt - 1, len(self.delays_s) - 1)]


def clean_retry_settings(body) -> dict:
    if not isinstance(body, dict):
        raise BookforgeError("INVALID_INPUT", "", "the retry settings must be a JSON object", status="REJECTED")
    out = dict(DEFAULT_RETRY)
    if "enabled" in body:
        if not isinstance(body["enabled"], bool):
            raise BookforgeError("INVALID_INPUT", "/enabled", "enabled must be true or false", status="REJECTED")
        out["enabled"] = body["enabled"]
    if "delays_s" in body:
        d = body["delays_s"]
        if (not isinstance(d, list) or not 1 <= len(d) <= 10 or
                not all(isinstance(x, int) and not isinstance(x, bool) and 1 <= x <= 900 for x in d)):
            raise BookforgeError("INVALID_INPUT", "/delays_s", "waiting times: 1 to 10 whole numbers of seconds "
                                 "(1-900 each)", status="REJECTED")
        out["delays_s"] = d
    if "max_total_s" in body:
        m = body["max_total_s"]
        if not isinstance(m, int) or isinstance(m, bool) or not 10 <= m <= 3600:
            raise BookforgeError("INVALID_INPUT", "/max_total_s", "the total waiting time is 10 to 3600 seconds",
                                 status="REJECTED")
        out["max_total_s"] = m
    return out


def slot_word(slot_label: str | None, site: str | None = None) -> str:
    if site:
        return {"claude": "Claude", "chatgpt": "ChatGPT", "gemini": "Gemini"}.get(site, site)
    if slot_label:
        return slot_label.split(" (")[0].replace(" through AutoInjector", "")
    return "the AI"


def wait_and_retry(fn, *, policy: RetryPolicy, check=None, on_wait=None, who: str = "the AI"):
    """Run fn(); on a busy answer wait per policy and run it again. TIMEOUT and other errors are raised at once.

    check(): called about every 0.5 s while waiting (raise to stop: cancel/pause).
    on_wait(info): called with {"code", "attempt", "retry_in_s", "retry_at", "message"} before each wait and with
    None when the call is tried again."""
    waited = 0.0
    attempt = 0
    while True:
        try:
            return fn()
        except BookforgeError as exc:
            if not policy.enabled or not is_busy_error(exc):
                raise
            attempt += 1
            delay = policy.delay(attempt)
            if waited + delay > policy.max_total_s:
                raise BookforgeError(exc.code, exc.errors[0].get("path") or "",
                                     f"{who() if callable(who) else who} stayed busy or unreachable for {int(waited)} s, so BookForge stopped "
                                     f"waiting ({exc.errors[0].get('message')})", status=exc.status) from exc
            word = "busy" if exc.code == "RATE_LIMITED" else "not reachable"
            name = who() if callable(who) else who
            info = {"code": exc.code, "attempt": attempt, "retry_in_s": int(delay),
                    "retry_at": datetime.fromtimestamp(time.time() + delay, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "message": f"Waiting for {name} ({word}) — retrying in {int(delay)} s"}
            log.info("AI busy (%s), retry %s in %.0fs", exc.code, attempt, delay)
            if on_wait:
                on_wait(info)
            remaining = delay
            while remaining > 0:
                if check:
                    check()
                chunk = min(0.5, remaining)
                policy.sleep(chunk)
                remaining -= chunk
            if check:
                check()
            waited += delay
            if on_wait:
                on_wait(None)


class JobStore:
    """Small JSON summaries of background work, in the settings table (key ``job:<id>``)."""

    def __init__(self, store):
        self.store = store
        self._lock = threading.RLock()

    def save(self, job: dict) -> dict:
        if not isinstance(job, dict) or not job.get("id"):
            raise ValueError("job needs an id")
        job = dict(job, updated_at=now_iso())
        with self._lock:
            try:
                self.store.set_setting(PREFIX + job["id"], job)
            except Exception:  # noqa: BLE001 - persistence must never break the work itself
                log.exception("could not save job %s", job.get("id"))
        return job

    def get(self, job_id: str) -> dict | None:
        if not isinstance(job_id, str) or not job_id:
            return None
        v = self.store.get_setting(PREFIX + job_id)
        return v if isinstance(v, dict) else None

    def delete(self, job_id: str):
        with self.store.transaction() as tx:
            tx.execute("DELETE FROM settings WHERE key=?", (PREFIX + job_id,))

    def list(self, kind: str | None = None, project_id: str | None = None, limit: int = 100) -> list[dict]:
        rows = self.store.query("SELECT value FROM settings WHERE key LIKE ? ORDER BY updated_at DESC", (PREFIX + "%",))
        out = []
        for r in rows:
            try:
                v = json.loads(r["value"])
            except ValueError:
                continue
            if not isinstance(v, dict):
                continue
            if kind and v.get("kind") != kind:
                continue
            if project_id and v.get("project_id") != project_id:
                continue
            out.append(v)
            if len(out) >= limit:
                break
        return out

    def mark_interrupted(self, phase: str | None = None, keep=frozenset()) -> int:
        """Start-up (and after a restore): work stored as live becomes 'interrupted' (resumable). ``keep``: ids of
        jobs that really are running in this process."""
        n = 0
        for j in self.list(limit=MAX_KEPT):
            if j.get("status") in LIVE and j.get("id") not in keep:
                j["status"] = "interrupted"
                j["phase"] = phase or ("Interrupted — BookForge was closed or restarted while this was running. "
                                       "Press Resume.")
                j["interrupted_at"] = now_iso()
                j["waiting"] = None
                self.save(j)
                n += 1
        self.prune()
        return n

    def prune(self):
        jobs = self.list(limit=10000)
        cutoff = time.time() - KEEP_FINISHED_S
        drop = []
        for i, j in enumerate(jobs):
            if j.get("status") in LIVE or j.get("status") == "interrupted" or j.get("status") == "paused":
                continue
            try:
                t = datetime.strptime(j.get("updated_at") or "", "%Y-%m-%dT%H:%M:%SZ").replace(
                    tzinfo=timezone.utc).timestamp()
            except ValueError:
                t = 0
            if i >= MAX_KEPT or t < cutoff:
                drop.append(j["id"])
        for jid in drop:
            try:
                self.delete(jid)
            except Exception:  # noqa: BLE001
                pass
