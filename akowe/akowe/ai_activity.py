"""⚡ What the AIs are doing right now (#116): a small, thread-safe, in-memory list of the AI work in flight.

Every AI call passes ONE place (``providers.ProviderRegistry._generate_on``); that place tells this registry when a
call starts and ends. The plain words for the work ("Writing chapter 7", "Reviewing chapter 7", "Writers' room:
pitching a twist") come from the code that asks: it wraps its work in ``doing("…")`` (a context variable, so it
follows the work through the engine and the services without any extra argument). Code that says nothing gets a
plain fallback from the kind of job.

One live row per worker thread (in practice one per AI): what that thread is having an AI do, which AI, for which
book, and its stage:

* ``queued``      – waiting for the AI (it is busy with other work)
* ``answering``   – the AI is answering
* ``checking``    – Akọwe is checking the answer
* ``busy_wait``   – waiting after a busy site (``retry_at`` says when it asks again)
* ``limit_wait``  – every AI is at its usage limit: waiting for one to reset (``wait_message`` says until when,
  in plain words; usage_limits.py)

When the work ends the row says ✔ done / ✖ failed / ⏳ timed out / ⚠ paused – needs you / ■ stopped for
``KEEP_S`` seconds, then disappears (sooner when that AI starts something new: one row per AI). Nothing here is saved, and no prompt or answer text is ever kept: titles only.
"""
from __future__ import annotations

import contextvars
import itertools
import threading
import time
from contextlib import contextmanager

KEEP_S = 6.0          # how long a finished row stays (✔ Done: …) before it disappears
MAX_DONE = 30

STAGE_WORDS = {
    "queued": "Waiting for the AI",
    "answering": "AI is answering",
    "checking": "Checking the answer",
    "busy_wait": "Waiting after a busy site",
    "limit_wait": "All AIs hit their usage limits — waiting",
}
OUTCOMES = {  # outcome -> (icon, words)
    "done": ("✔", "Done"),
    "failed": ("✖", "Failed"),
    "timeout": ("⏳", "Timed out"),
    "needs_you": ("⚠", "Paused – needs you"),
    "stopped": ("■", "Stopped"),
}

# Plain fallback words by job kind (the code that asks may say more with doing()).
JOB_WORDS = {
    "assist": "Filling in a form", "bible": "Character & place maker", "review": "Reviewing a draft",
    "fix": "Fixing a draft", "editor": "Editor reading a chapter", "editor_fix": "Reworking the editor's notes",
    "scenes": "Planning scenes", "scenes_check": "Checking scene plans", "characters": "Character sheet and voice",
    "continuity_track": "Updating the running notes", "planned_check": "Checking a chapter against its plan",
    "planned_fix": "Adding planned details to a chapter", "ending_check": "Checking the ending",
    "ending_fix": "Working the open promises into the ending", "checkpoint": "Continuity checkpoint",
    "writers_room": "Writers' room", "beta_read": "Beta reader", "book_review": "Book report: reading the book",
    "originality_read": "Originality check", "alongside": "Write alongside me", "binder_fill": "Book Bible: filling from the book",
    "bible_fill_all": "Filling the whole Book Bible", "bible_fill": "Filling the whole Book Bible",
    "launch_kit": "Launch kit", "compare": "Blind comparison", "style_card": "Learning your writing style",
    "profile": "Inventing the book", "world_rules": "Story rules", "world_texture": "World texture",
    "series_changes": "Finding what changed in this book", "story_shape": "Placing the story shape's beats",
    "story_kind": "Placing the stages of the kind of story",
    "terms": "Checking terms", "forge": "Character Forge", "cover_art": "Cover", "trailer": "Trailer",
}
OP_WORDS = {
    "A01": "Characters and places", "A03": "Story rules", "A04": "World texture", "B01": "Writing the premise",
    "B03": "Writing the main plot", "B11": "Writing the chapter outline", "C01": "Preparing a chapter",
    "C02": "Writing a chapter",
}

_ctx: contextvars.ContextVar[dict | None] = contextvars.ContextVar("akowe_ai_doing", default=None)
_scope_ids = itertools.count(1)


def current() -> dict:
    """What the code running now said it is doing (merged from every enclosing ``doing``)."""
    return dict(_ctx.get() or {})


def nice(label: str) -> str:
    """'chapter ch7' -> 'chapter 7' when we are inside chapter 7 (Akọwe's chapter ids are not for people)."""
    cur = _ctx.get() or {}
    cid, n = cur.get("chapter_id"), cur.get("chapter")
    if cid and n and isinstance(label, str):
        return label.replace(f"chapter {cid}", f"chapter {n}")
    return label


def outcome_of(exc: BaseException | None) -> str:
    """✔ / ✖ / ⏳ / ⚠ / ■ for how a piece of work ended (duck-typed: no imports of the services)."""
    if exc is None:
        return "done"
    names = {c.__name__ for c in type(exc).__mro__}
    if names & {"RunPaused", "RunCancelled", "Cancelled", "KeyboardInterrupt", "SystemExit"}:
        return "stopped"
    code = getattr(exc, "code", None) or (getattr(exc, "problem", None) or {}).get("code")
    if code == "TIMEOUT":
        return "timeout"
    if names & {"StepProblem", "ChecksRefused"}:
        return "needs_you"
    return "failed"


class Registry:
    """The live rows (one per worker thread) and the finished rows kept ``keep_s`` seconds. Thread-safe."""

    def __init__(self, keep_s: float = KEEP_S, clock=time.time):
        self.keep_s = keep_s
        self.clock = clock
        self._lock = threading.Lock()
        self._live: dict[int, dict] = {}
        self._done: list[dict] = []
        self._ids = itertools.count(1)

    # ------------------------------------------------------------------ helpers
    def _new(self, ctx: dict, slot_id: str | None, ai: str | None, fallback: str | None) -> dict:
        now = self.clock()
        task = ctx.get("task") or fallback or "Working with the AI"
        return {"id": f"a{next(self._ids)}", "scope": ctx.get("_scope"), "slot": slot_id, "ai": ai,
                "task": task, "done_text": ctx.get("done") or task,
                "book_id": ctx.get("book_id"), "branch_id": ctx.get("branch_id"), "book_title": ctx.get("book_title"),
                "run_id": ctx.get("run_id"), "link": ctx.get("link"), "kind": ctx.get("kind"),
                "step": ctx.get("step"), "steps": ctx.get("steps"), "step_title": ctx.get("step_title"),
                "chapter": ctx.get("chapter"), "chapters": ctx.get("chapters"),
                "stage": "answering", "started": now, "stage_since": now, "retry_at": None, "calls": 0,
                "last_error": None}

    def _finish_locked(self, key: int, outcome: str, quiet: bool = False):
        e = self._live.pop(key, None)
        if e is None or quiet:
            return
        e.update(outcome=outcome, finished=self.clock())
        self._done.append(e)
        if len(self._done) > MAX_DONE:
            del self._done[:-MAX_DONE]

    def _entry_for_call(self, key: int, ctx: dict, slot_id, ai, fallback, book_id=None, book_title=None) -> dict:
        e = self._live.get(key)
        scope = ctx.get("_scope")
        if e is not None and (e["scope"] != scope or e["scope"] is None):
            # this thread moved on to other work (an inner or a new piece): the old row goes quietly
            self._finish_locked(key, "done", quiet=True)
            e = None
        if e is None:
            e = self._live[key] = self._new(ctx, slot_id, ai, fallback)
        if book_id and not e["book_id"]:
            e["book_id"] = book_id
        if book_title and not e["book_title"]:
            e["book_title"] = book_title
        if slot_id:
            e["slot"], e["ai"] = slot_id, ai or e["ai"]
        return e

    # ------------------------------------------------------------------ events from the AI choke point
    def call_started(self, slot_id: str | None, ai: str | None, *, fallback: str | None = None,
                     book_id: str | None = None, branch_id: str | None = None, book_title: str | None = None) -> None:
        ctx = _ctx.get() or {}
        key = threading.get_ident()
        with self._lock:
            e = self._entry_for_call(key, ctx, slot_id, ai, fallback, book_id, book_title)
            if branch_id and not e["branch_id"]:
                e["branch_id"] = branch_id
            e.update(stage="answering", stage_since=self.clock(), retry_at=None, calls=e["calls"] + 1)

    def call_ended(self, exc: BaseException | None = None) -> None:
        key = threading.get_ident()
        with self._lock:
            e = self._live.get(key)
            if e is None:
                return
            if exc is None:
                e.update(stage="checking", stage_since=self.clock(), last_error=None)
            else:
                e["last_error"] = outcome_of(exc)
            if e["scope"] is None:  # nobody said what this is: the row is this one call
                if exc is not None and _busy(exc):
                    self._finish_locked(key, "done", quiet=True)  # it is asked again; the wait shows its own row
                else:
                    self._finish_locked(key, outcome_of(exc))

    def note_queued(self, slot_id: str | None, ai: str | None = None, *, fallback: str | None = None) -> None:
        """The work waits for a free AI (the one it needs is busy with other work)."""
        ctx = _ctx.get() or {}
        if not ctx.get("_scope"):
            return
        key = threading.get_ident()
        with self._lock:
            e = self._entry_for_call(key, ctx, slot_id, ai, fallback)
            if e["stage"] != "queued":
                e.update(stage="queued", stage_since=self.clock())

    def note_wait(self, info: dict | None, *, fallback: str | None = None) -> None:
        """wait_and_retry: a busy / unreachable site — Akọwe waits and asks again (``info`` None: asking again)."""
        ctx = _ctx.get() or {}
        key = threading.get_ident()
        with self._lock:
            e = self._live.get(key)
            if info is None:
                if e is not None and e["stage"] in ("busy_wait", "limit_wait"):
                    e.update(stage="queued", stage_since=self.clock(), retry_at=None, wait_message=None)
                return
            if not ctx.get("_scope"):
                return  # unnamed work has no row between its calls (nothing would end that row)
            if e is None or e["scope"] != ctx.get("_scope"):
                e = self._entry_for_call(key, ctx, None, None, fallback)
            try:
                secs = float(info.get("retry_in_s") or 0)
            except (TypeError, ValueError):
                secs = 0.0
            limit = info.get("kind") == "usage_limit"
            e.update(stage="limit_wait" if limit else "busy_wait", stage_since=self.clock(),
                     retry_at=self.clock() + secs, wait_message=str(info.get("message") or "")[:300] if limit else None)

    def scope_ended(self, scope: int, exc: BaseException | None) -> None:
        key = threading.get_ident()
        with self._lock:
            e = self._live.get(key)
            if e is None or e["scope"] != scope:
                return
            out = outcome_of(exc)
            if out == "done" and e.get("last_error") and e["stage"] != "checking":
                out = e["last_error"]  # the last AI call failed and nothing answered after it
            self._finish_locked(key, out)

    # ------------------------------------------------------------------ reading
    def snapshot(self) -> dict:
        now = self.clock()
        alive = {t.ident for t in threading.enumerate()}
        with self._lock:
            for key in [k for k in self._live if k not in alive]:  # a thread that died mid-work leaves no ghost row
                self._finish_locked(key, "done", quiet=True)
            self._done = [d for d in self._done if now - d["finished"] < self.keep_s]
            live = [dict(e) for e in self._live.values()]
            done = [dict(d) for d in self._done]
        rows = [_public(e, now) for e in sorted(live, key=lambda e: e["started"])]
        # one row per AI: a finished row shows only while that AI has nothing new, and only its newest one
        busy_slots = {e["slot"] for e in live}
        last: dict = {}
        for d in sorted(done, key=lambda d: d["finished"]):
            if d["slot"] is None or d["slot"] not in busy_slots:
                last[d["slot"] or d["id"]] = d
        rows += [_public(d, now, self.keep_s) for d in sorted(last.values(), key=lambda d: d["finished"])]
        return {"rows": rows, "busy": len(live), "now": _iso(now), "keep_s": self.keep_s}

    def clear(self) -> None:
        with self._lock:
            self._live.clear()
            self._done.clear()


def _busy(exc) -> bool:
    try:
        from .jobs import is_busy_error  # noqa: PLC0415
        return bool(is_busy_error(exc))
    except Exception:  # noqa: BLE001
        return False


def _iso(t: float | None) -> str | None:
    if t is None:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + f".{int((t % 1) * 1000):03d}Z"


def _public(e: dict, now: float, keep_s: float | None = None) -> dict:
    finished = e.get("finished")
    out = {k: e.get(k) for k in ("id", "slot", "ai", "task", "book_id", "branch_id", "book_title", "run_id", "link",
                                 "kind", "step", "steps", "step_title", "chapter", "chapters", "stage")}
    out["state"] = "done" if finished else "live"
    out["stage_words"] = STAGE_WORDS.get(e["stage"], e["stage"])
    out["started_at"] = _iso(e["started"])
    out["elapsed_s"] = round(((finished or now) - e["started"]), 1)
    out["retry_in_s"] = max(0, int(round(e["retry_at"] - now))) if e.get("retry_at") and not finished else None
    if e.get("wait_message") and not finished:
        out["wait_message"] = e["wait_message"]
    if finished:
        icon, words = OUTCOMES.get(e["outcome"], OUTCOMES["done"])
        out.update(outcome=e["outcome"], icon=icon, outcome_words=words, finished_at=_iso(finished),
                   done_text=(f"Done: {e['done_text']}" if e["outcome"] == "done" else f"{words}: {e['task']}"),
                   gone_in_s=max(0.0, round((keep_s or KEEP_S) - (now - finished), 1)))
    return out


REGISTRY = Registry()


@contextmanager
def doing(task: str | None = None, *, done: str | None = None, **fields):
    """Say what the code inside is having the AI do, in plain words ("Writing chapter 7"), and/or add details
    (book_id, book_title, run_id, step / steps, chapter / chapters, link…). Nested ``doing`` blocks add to the outer
    ones. A block with a ``task`` is one piece of work: its row ends (✔ / ✖ / ⏳ / ⚠) when the block ends."""
    parent = _ctx.get() or {}
    new = dict(parent)
    for k, v in fields.items():
        if v is not None:
            new[k] = v
    scope = None
    if task:
        scope = next(_scope_ids)
        new.update(task=str(task)[:160], done=str(done)[:160] if done else None, _scope=scope)
    token = _ctx.set(new)
    try:
        yield new
    except BaseException as exc:
        if scope is not None:
            _safe(REGISTRY.scope_ended, scope, exc)
        raise
    else:
        if scope is not None:
            _safe(REGISTRY.scope_ended, scope, None)
    finally:
        _ctx.reset(token)


def _safe(fn, *a, **kw):
    """The activity strip is a display: it must never break the work it shows."""
    try:
        fn(*a, **kw)
    except Exception:  # noqa: BLE001
        import logging  # noqa: PLC0415
        logging.getLogger(__name__).exception("AI activity")


def job_words(kind: str | None, op: str | None = None) -> str:
    """The plain fallback for a job that did not say what it does."""
    if kind and kind in JOB_WORDS:
        if kind == "assist" and op in OP_WORDS:
            return OP_WORDS[op]
        return JOB_WORDS[kind]
    if kind and kind.startswith("world_"):
        return JOB_WORDS.get(kind, "Story rules and world")
    if op in OP_WORDS:
        return OP_WORDS[op]
    return "Working with the AI"


def doing_if_unsaid(task: str, **fields):
    """``doing(task)`` only when no enclosing block said what this is (a service's own fallback words)."""
    cur = _ctx.get() or {}
    if cur.get("_scope"):
        return doing(None, **fields)
    return doing(task, **fields)


# small public API used by the server, the providers and the services
def call_started(*a, **kw):
    _safe(REGISTRY.call_started, *a, **kw)


def call_ended(exc: BaseException | None = None):
    _safe(REGISTRY.call_ended, exc)


def note_queued(*a, **kw):
    _safe(REGISTRY.note_queued, *a, **kw)


def note_wait(info, **kw):
    _safe(REGISTRY.note_wait, info, **kw)


def snapshot() -> dict:
    return REGISTRY.snapshot()


def carry(fn):
    """``fn`` to start in a new thread with what this thread said it is doing (book, run, step, chapter, words).
    The new thread gets its own rows: it never ends (or is ended by) this thread's piece of work."""
    ctx = contextvars.copy_context()

    def run(*a, **kw):
        def inner():
            cur = _ctx.get() or {}
            if cur.get("_scope"):
                _ctx.set({k: v for k, v in cur.items() if k != "_scope"})
            return fn(*a, **kw)
        return ctx.run(inner)
    return run
