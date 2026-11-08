"""⏳ "All AIs hit their usage limits" (hardening for long books, PR #122).

A 40-chapter book sends about a thousand messages to the web AIs. Their usage limits (Claude's 5-hour windows,
Gemini's daily cap, ChatGPT's model caps) WILL run out during such a run, often for all of them at once. Before,
the run waited at most ~10 minutes (the busy-retry budget), then paused, and nobody resumed it when the limits reset
hours later.

Now, when every AI that could take a call is held by a usage limit (bridge state ``needs_user`` with problem
``USAGE_LIMIT``, or the site's own usage-limit notice, 503 ``SITE_ERROR`` / ``rate-limit``), ``providers.generate``
notes it here (:func:`note`) and raises its usual busy error. ``jobs.wait_and_retry`` then sees that the busy error
is a usage-limit one (:func:`of_error`) and waits in a separate, much longer budget (setting ``ai_retry``:
``limit_wait_s``, default 6 hours, 0 = off; it checks again every ``limit_check_s``, default 5 minutes, or at the
reset time the bridge gave, whichever it knows). It shows plain words in the run window and the AI activity strip —
"All AIs hit their usage limits — waiting; resumes by itself at about 3:40 PM" — and goes on by itself as soon as
one AI works again. Only after the whole waiting time does the run pause (as before).

Process-wide and tiny: one record, cleared by the next successful AI answer. Never raises.
"""
from __future__ import annotations

import threading
import time
from datetime import datetime

DEFAULT_WAIT_S = 6 * 3600     # how long a run waits for the limits to reset before it pauses
DEFAULT_CHECK_S = 300         # how often it looks again when no reset time is known
FRESH_S = 900                 # a note older than this is not trusted (the state changed since)
LIMIT_PROBLEMS = ("USAGE_LIMIT", "SITE_RATE_LIMITED")

_LOCK = threading.Lock()
_STATE: dict = {}


_LISTENERS: list = []  # 📊 3e usage meter: fn(names, reset_at) on every note()


def on_note(fn) -> None:
    if fn not in _LISTENERS:
        _LISTENERS.append(fn)


def is_limit_problem(problem) -> bool:
    return isinstance(problem, str) and problem.upper() in LIMIT_PROBLEMS


def note(names: list[str], reset_at: float | None = None) -> None:
    """Every AI that could take a call is at its usage limit (``reset_at``: epoch seconds, when one resets)."""
    with _LOCK:
        _STATE.clear()
        _STATE.update(at=time.time(), names=[str(n) for n in names or []][:6],
                      reset_at=float(reset_at) if isinstance(reset_at, (int, float)) and reset_at > 0 else None)
    for fn in list(_LISTENERS):  # 📊 3e: the usage meter remembers the hit per AI
        try:
            fn(names, reset_at)
        except Exception:  # noqa: BLE001
            pass


def clear() -> None:
    with _LOCK:
        _STATE.clear()


def current(max_age_s: float = FRESH_S) -> dict | None:
    with _LOCK:
        if not _STATE or time.time() - _STATE.get("at", 0) > max_age_s:
            return None
        return dict(_STATE)


def of_error(exc) -> dict | None:
    """The usage-limit record when this busy error means "every AI is at its usage limit", else None. The error may
    carry it (``exc.usage_limited``), or it went through a dispatch (the engine keeps only code and message): then the
    fresh process-wide note decides."""
    if exc is None:
        return None
    if getattr(exc, "usage_limited", False):
        return {"names": list(getattr(exc, "limited_names", None) or []), "reset_at": getattr(exc, "reset_at", None)}
    if getattr(exc, "code", None) in ("UPSTREAM_UNAVAILABLE", "RATE_LIMITED"):
        return current()
    return None


def clock(epoch: float) -> str:
    """'3:40 PM' in this computer's local time (Akọwe runs on the author's own PC)."""
    t = datetime.fromtimestamp(epoch)
    return t.strftime("%I:%M %p").lstrip("0")


def message(next_at: float, *, reset_known: bool, until: float | None = None) -> str:
    when = clock(next_at)
    if reset_known:
        return f"All AIs hit their usage limits — waiting; resumes by itself at about {when}"
    tail = f" (it checks every few minutes, until about {clock(until)} at the latest)" if until else ""
    return f"All AIs hit their usage limits — waiting; resumes by itself as soon as one works again, next check at " \
           f"about {when}{tail}"
