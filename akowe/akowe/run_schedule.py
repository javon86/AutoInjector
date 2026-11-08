"""⏰ 3e Start later: a ⚡ Make-a-book run that starts at a time the author picks ("Start at 11 pm").

* **Scheduling** (``create``): the start body is checked now exactly as a start would check it
  (``AutoBookService._clean_settings``: the same field errors), then kept with the time in the setting
  ``autobook_schedule`` — one schedule at a time. The body holds the author's own settings (genre, idea, choices …);
  it is stored like every other book setting and is never logged.
* **Waiting** (``tick``, every ``TICK_S`` seconds in a daemon thread, and on every read): at the time the run starts
  through the usual ``AutoBookService.start`` (backup, consent, AI choice — all as if the author pressed Start). If it
  cannot start (a run already works, no AI is connected …) the schedule says why in plain words (state ``failed``).
* **Restarts**: the schedule is in the database, so it survives Akọwe closing. On the next start it waits again; if
  its time passed MORE than ``LATE_ASK_S`` (2 hours) ago, it does not start by itself: it asks (state ``ask``: ▶ Start
  now / ✖ Cancel), because a book the author meant for the night should not start at lunch without a word.
* **Keep the PC awake**: while a schedule waits, Akọwe's status push to AutoInjector reports it as a waiting run
  (``status_push.build_summary``), and AutoInjector's run guard keeps the PC awake for a waiting run (run-guard.js:
  ``waiting`` is a live state) — so the computer does not fall asleep before 11 pm.
* **Cancel** any time; **Start now** starts it at once.

States: ``waiting`` · ``ask`` · ``started`` (run_id) · ``failed`` (message) · ``cancelled``.
"""
from __future__ import annotations

import logging
import threading
import time
import uuid
from datetime import datetime, timezone

from .errors import AkoweError

log = logging.getLogger("akowe.run_schedule")

SETTING = "autobook_schedule"
TICK_S = 15.0
LATE_ASK_S = 2 * 3600          # later than this after its time: ask instead of starting
MAX_AHEAD_S = 7 * 24 * 3600    # at most a week ahead
MIN_AHEAD_S = 60               # at least a minute ahead (sooner: just press Start)
OPEN = ("waiting", "ask", "failed")


def _iso(t: float | None) -> str | None:
    if not t:
        return None
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(v) -> float | None:
    """An ISO time with a zone ("2026-11-08T23:00:00Z", "…+01:00") or epoch seconds -> epoch seconds."""
    if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0:
        return float(v)
    if not isinstance(v, str) or len(v) > 40:
        return None
    s = v.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:  # a local time without a zone: this computer's local time
        return dt.timestamp()
    return dt.timestamp()


class RunScheduler:
    def __init__(self, app, clock=time.time):
        self.app = app
        self.clock = clock
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread = None

    # ------------------------------------------------------------------ storage
    def get(self) -> dict | None:
        try:
            s = self.app.store.get_setting(SETTING)
        except Exception:  # noqa: BLE001
            return None
        return s if isinstance(s, dict) and s.get("id") else None

    def _put(self, s: dict | None) -> None:
        self.app.store.set_setting(SETTING, s)
        try:
            self.app.changed()  # the status push to AutoInjector (keep-awake) and the top bar
        except Exception:  # noqa: BLE001
            pass

    def active(self) -> bool:
        """A schedule is waiting for its time (counts as a working run for keep-awake)."""
        s = self.get()
        return bool(s and s.get("state") == "waiting")

    # ------------------------------------------------------------------ what the author does
    def create(self, principal: str, body) -> dict:
        body = body if isinstance(body, dict) else {}
        at = parse_time(body.get("at"))
        if at is None:
            raise AkoweError("INVALID_INPUT", "/at", "when to start: a time like 23:00", status="REJECTED")
        now = self.clock()
        if at < now + MIN_AHEAD_S:
            raise AkoweError("INVALID_INPUT", "/at", "that time has passed (or is less than a minute away) — pick a "
                             "later time, or just press Start", status="REJECTED")
        if at > now + MAX_AHEAD_S:
            raise AkoweError("INVALID_INPUT", "/at", "pick a time within the next 7 days", status="REJECTED")
        start = body.get("body")
        if not isinstance(start, dict):
            raise AkoweError("INVALID_INPUT", "/body", "the book's settings are missing", status="REJECTED")
        if start.get("author_confirms") is not True:
            raise AkoweError("APPROVAL_REQUIRED", "/author_confirms", "scheduling the run is your consent for it; it "
                             "must be sent as author_confirms: true", status="REJECTED")
        ab = self.app.autobook
        ab._clean_settings(start)  # the same checks as Start: a wrong setting is said now, not at 11 pm
        if not ab._ai_configured():
            raise AkoweError("CAPABILITY_UNAVAILABLE", "/slot_id", "no AI is connected — Make a book for me needs an "
                             "AI", status="REJECTED")
        with self._lock:
            cur = self.get()
            if cur and cur.get("state") in ("waiting", "ask"):
                raise AkoweError("VERSION_CONFLICT", "/at", "a book is already scheduled — cancel it first",
                                 status="REJECTED")
            s = {"id": f"sch-{uuid.uuid4().hex[:10]}", "state": "waiting", "at": at, "at_iso": _iso(at),
                 "principal": principal, "created_at": _iso(now), "body": start, "run_id": None, "message": None}
            self._put(s)
        log.info("a Make-a-book run is scheduled for %s", _iso(at))
        return self.public(s)

    def cancel(self, principal: str) -> dict:
        with self._lock:
            s = self.get()
            if not s or s.get("principal") not in (None, principal):
                return {"state": "none"}
            if s.get("state") in OPEN:
                s.update(state="cancelled", message="Cancelled.")
                self._put(s)
            return self.public(s)

    def dismiss(self, principal: str) -> dict:
        """Forget a finished / cancelled / failed schedule (the Make-a-book window stops showing it)."""
        with self._lock:
            s = self.get()
            if s and s.get("principal") in (None, principal) and s.get("state") not in ("waiting", "ask"):
                self._put(None)
            return {"state": "none"}

    def start_now(self, principal: str) -> dict:
        with self._lock:
            s = self.get()
            if not s or s.get("principal") not in (None, principal) or s.get("state") not in OPEN:
                raise AkoweError("NOT_FOUND", "/schedule", "no book is waiting to start", status="REJECTED")
            self._launch(s)
            return self.public(s)

    # ------------------------------------------------------------------ the clock
    def tick(self, now: float | None = None) -> dict | None:
        """Start the scheduled run when its time came (or ask, when it is more than 2 hours late)."""
        now = self.clock() if now is None else now
        with self._lock:
            s = self.get()
            if not s or s.get("state") != "waiting" or now < float(s.get("at") or 0):
                return s
            if now - float(s["at"]) > LATE_ASK_S:
                s.update(state="ask", message="It was meant to start at its time, but Akọwe was not running then. "
                                              "Start it now, or cancel it?")
                self._put(s)
                log.info("a scheduled Make-a-book run is more than 2 hours late: asking the author")
                return s
            if getattr(self.app, "_exclusive", None):  # a restore runs right now: start at the next tick
                return s
            self._launch(s)
            return s

    def _launch(self, s: dict) -> None:
        try:
            run = self.app.autobook.start(s.get("principal") or self.app.principal_id, dict(s["body"]))
            s.update(state="started", run_id=run.get("id"), message="Started.", started_at=_iso(self.clock()))
            log.info("the scheduled Make-a-book run started (%s)", run.get("id"))
        except AkoweError as exc:
            why = (exc.errors[0].get("message") if exc.errors else None) or exc.code
            s.update(state="failed", message=f"It could not start: {why}")
            log.info("the scheduled Make-a-book run could not start: %s", exc.code)
        except Exception as exc:  # noqa: BLE001 - say it in plain words, keep the schedule to retry by hand
            s.update(state="failed", message="It could not start because of an unexpected problem. Press ▶ Start "
                                             "now to try again.")
            log.exception("the scheduled Make-a-book run failed to start: %s", type(exc).__name__)
        self._put(s)

    # ------------------------------------------------------------------ the thread
    def start(self, interval: float = TICK_S) -> None:
        if self._thread and self._thread.is_alive():
            return

        def loop():
            while not self._stop.wait(interval):
                try:
                    self.tick()
                except Exception:  # noqa: BLE001 - try again at the next tick
                    log.debug("schedule tick failed", exc_info=True)
            try:
                self.app.store.close()
            except Exception:  # noqa: BLE001
                pass
        self.tick()  # on start: a schedule whose time passed while Akọwe was closed starts or asks now
        self._thread = threading.Thread(target=loop, name="akowe-run-schedule", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    # ------------------------------------------------------------------ for the page and the status push
    def public(self, s: dict | None = None, now: float | None = None) -> dict:
        s = self.get() if s is None else s
        if not s:
            return {"state": "none"}
        now = self.clock() if now is None else now
        b = s.get("body") or {}
        what = {"length": b.get("length") or "short_story", "genre": str(b.get("genre") or "")[:120]}
        return {"id": s["id"], "state": s.get("state"), "at": s.get("at_iso"), "at_epoch": s.get("at"),
                "seconds_left": max(0, int(round(float(s.get("at") or 0) - now))), "late_s":
                max(0, int(round(now - float(s.get("at") or 0)))), "run_id": s.get("run_id"),
                "message": s.get("message"), "created_at": s.get("created_at"), "what": what}

    def as_run(self) -> dict | None:
        """The waiting schedule as a run for AutoInjector's status (its run guard keeps the PC awake for it)."""
        s = self.get()
        if not s or s.get("state") not in ("waiting", "ask"):
            return None
        from . import usage_limits  # noqa: PLC0415
        when = usage_limits.clock(float(s["at"]))
        if s["state"] == "ask":
            return {"id": s["id"], "title": "Scheduled book", "state": "paused", "status": "paused",
                    "state_words": "The scheduled book did not start (Akọwe was closed at its time): open Akọwe to "
                                   "start it or cancel it.", "needs_you": True, "needs_decision": True,
                    "steps_done": 0, "steps_total": 0, "phase": "", "problem": None, "updated_at": s.get("created_at"),
                    "finished_at": None}
        return {"id": s["id"], "title": "Scheduled book", "state": "waiting", "status": "waiting",
                "state_words": f"Scheduled: the book starts at {when}. Keep AutoInjector and Akọwe running.",
                "needs_you": False, "needs_decision": False, "steps_done": 0, "steps_total": 0,
                "phase": f"Starts at {when}", "problem": None, "updated_at": s.get("created_at"), "finished_at": None}
