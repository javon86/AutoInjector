"""🔎 "Check consistency now" (PR #117): the author asks, at any time, for the same all-AI review a checkpoint makes.

What it checks (the author chooses): the last 5 chapters (default), chapters X to Y, or the whole book so far. Every
working AI reads those chapters in full on its own — consistency, drift, straying off the plan — and writes a review
of the stretch ("Chapters 3–7 review": pacing, arc, drift, what works and not, scores). Akọwe merges what they found
with the same agreement rules as the checkpoints (cross_check.merge): 2+ agree = confirmed; one AI only = its quote
must be in the chapter, fixed only when major, else listed. It is a checkpoint of kind ``now`` (checkpoints.py), so it
shows in the 🧭 continuity report, the book report and the run's step list.

* **During a ⚡ run** of this book the request is QUEUED (settings ``check_now:<project>:<branch>``): the run announces
  it in its journal at once and runs it at the next safe point between chapters (checkpoints.run_due), so it never
  fights the writer for an AI — the run waits for it. Its fixes go through the run's one fix pass and review loop,
  under the run consent. A run that ends (or pauses outside the chapters) before that point hands it over: the check
  then runs on its own, as below.
* **Outside a run** it runs as a background job. Nothing approved is ever changed by it: each safe small fix is a
  PROPOSAL; ✔ Use these fixes (``apply``) saves them as a new draft of that chapter, which waits for the author's
  approval like any other draft.
* One at a time per book: while one is queued or running the button is off, with the reason in plain words. A busy or
  broken AI is skipped with a note (the others' reading counts); the book never waits for it.
"""
from __future__ import annotations

import copy
import logging
import threading
import time
import uuid
from datetime import datetime, timezone

from .errors import AkoweError

log = logging.getLogger("akowe.check_now")

KEY = "check_now:{pid}:{branch}"
LAST = 5
RANGES = ("last5", "range", "all")
_LOCK = threading.RLock()
_THREADS: dict[tuple, threading.Thread] = {}
_ANNOUNCE: set = set()   # (pid, branch) with a queued request the run has not announced yet


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _key(pid, branch) -> str:
    return KEY.format(pid=pid, branch=branch)


def get(store, pid, branch) -> dict:
    try:
        cur = store.get_setting(_key(pid, branch))
    except Exception:  # noqa: BLE001
        cur = None
    return copy.deepcopy(cur) if isinstance(cur, dict) else {}


def _put(store, pid, branch, req: dict) -> None:
    req["updated_at"] = _now()
    store.set_setting(_key(pid, branch), req)


def pick_range(n: int, body) -> tuple[int, int, str]:
    """(from, to, label) from the author's choice; ``n`` = chapters written. Raises INVALID_INPUT in plain words."""
    body = body if isinstance(body, dict) else {}
    what = body.get("range") or "last5"
    if what not in RANGES:
        raise AkoweError("INVALID_INPUT", "/range", "what to check: last5, range or all", status="REJECTED")
    if n <= 0:
        raise AkoweError("INVALID_INPUT", "/range", "no chapter is written yet, so there is nothing to check",
                         status="REJECTED")
    if what == "all":
        a, b = 1, n
    elif what == "last5":
        a, b = max(1, n - LAST + 1), n
    else:
        a, b = body.get("from"), body.get("to")
        if not all(isinstance(x, int) and not isinstance(x, bool) for x in (a, b)) or not 1 <= a <= b <= n:
            raise AkoweError("INVALID_INPUT", "/from", f"chapters X to Y: whole numbers from 1 to {n}, X not after Y",
                             status="REJECTED")
    return a, b, (f"chapters {a}–{b}" if a != b else f"chapter {a}")


def _live_run(app, pid: str) -> dict | None:
    try:
        return next((r for r in app.autobook.active() if r.get("project_id") == pid), None)
    except Exception:  # noqa: BLE001
        return None


def _busy(app, pid, branch) -> str | None:
    """Why the button is off right now (plain words), or None."""
    req = get(app.store, pid, branch)
    st = req.get("status")
    t = _THREADS.get((pid, branch))
    if st == "running" and (t and t.is_alive() or req.get("in_run")):
        return f"A consistency check of {req.get('label')} is running now; wait for it to finish."
    if st == "queued":
        return (f"A consistency check of {req.get('label')} is queued: it runs after the chapter being written. "
                "Wait for it to finish.")
    return None


def status(app, principal, pid, branch) -> dict:
    from . import checkpoints  # noqa: PLC0415
    from .book_path import BookPath  # noqa: PLC0415
    from .continuity import chapters_of  # noqa: PLC0415
    _kick(app, principal, pid, branch)
    req = get(app.store, pid, branch)
    n = len(chapters_of(BookPath(app.engine, principal, pid, branch)))
    why = _busy(app, pid, branch)
    if not why and n == 0:
        why = "No chapter is written yet."
    latest = None
    if req.get("cp_id"):
        latest = next((c for c in checkpoints.report(app.store, pid, branch) if c["id"] == req["cp_id"]), None)
    return {"request": req, "state": req.get("status") or "idle", "can_start": not why, "why_not": why,
            "chapters": n, "in_run": bool(_live_run(app, pid)), "latest": latest, "last": LAST,
            "markdown": "\n".join(checkpoints.markdown([latest])) if latest else ""}


def start(app, principal, pid, branch, body) -> dict:
    from .book_path import BookPath  # noqa: PLC0415
    from .continuity import chapters_of  # noqa: PLC0415
    with _LOCK:
        _kick(app, principal, pid, branch)
        why = _busy(app, pid, branch)
        if why:
            raise AkoweError("VERSION_CONFLICT", "/check_now", why, status="REJECTED")
        n = len(chapters_of(BookPath(app.engine, principal, pid, branch)))
        a, b, label = pick_range(n, body)
        run = _live_run(app, pid)
        req = {"id": f"now-{uuid.uuid4().hex[:8]}", "from": a, "to": b, "label": label, "by": principal,
               "at": _now(), "range": (body or {}).get("range") or "last5"}
        if run:
            req.update(status="queued", run_id=run["id"], in_run=True)
            _put(app.store, pid, branch, req)
            _ANNOUNCE.add((pid, branch))
        else:
            req.update(status="running", in_run=False, started_at=_now())
            _put(app.store, pid, branch, req)
            _spawn(app, principal, pid, branch, req)
    return status(app, principal, pid, branch)


def _kick(app, principal, pid, branch) -> None:
    """A queued request whose run is no longer working runs on its own now; a "running" one whose job died (Akọwe
    was closed) is marked as stopped."""
    req = get(app.store, pid, branch)
    if req.get("status") == "queued" and not _live_run(app, pid):
        req.update(status="running", in_run=False, started_at=_now(), handed_over=True)
        _put(app.store, pid, branch, req)
        _spawn(app, req.get("by") or principal, pid, branch, req)
    elif req.get("status") == "running" and not req.get("in_run"):
        t = _THREADS.get((pid, branch))
        if not (t and t.is_alive()):
            req.update(status="failed", error="INTERRUPTED", finished_at=_now(),
                       message="The check stopped (Akọwe was closed); press 🔎 Check consistency now again.")
            _put(app.store, pid, branch, req)


# ====================================================================== on its own (outside a run)
class _Solo:
    """The few things a checkpoint needs from a ⚡ run (checkpoints._run_one), for a check outside a run."""

    def __init__(self, app, principal, pid, branch):
        from .book_path import BookPath  # noqa: PLC0415
        self.app, self.store, self._review = app, app.store, app.review
        self._bp = lambda: BookPath(app.engine, principal, pid, branch)
        self.principal, self.pid, self.branch = principal, pid, branch
        self.notes: list[str] = []

    def bp(self, run):
        return self._bp()

    def check(self, run):
        return None

    def save(self, run):
        return None

    def event(self, run, kind, message, **kw):
        self.notes.append(message)

    def _on(self, run, flag):
        return True

    def _sub_job(self, run, kind, rid, slot=None):
        from .review import ReviewJob  # noqa: PLC0415
        j = ReviewJob(kind, self.principal, self.pid, self.branch, [rid], slot)
        j.started, j.status, j.retry_busy = time.time(), "running", False
        return j


def _spawn(app, principal, pid, branch, req):
    t = threading.Thread(target=_solo, args=(app, principal, pid, branch, req["id"]), daemon=True,
                         name=f"check-now-{pid}")
    _THREADS[(pid, branch)] = t
    t.start()


def _solo(app, principal, pid, branch, req_id):
    from . import checkpoints  # noqa: PLC0415
    from .continuity import chapters_of  # noqa: PLC0415
    svc = _Solo(app, principal, pid, branch)
    req = get(app.store, pid, branch)
    try:
        chapters = [{"chapter_id": c["chapter_id"]} for c in chapters_of(svc.bp(None))]
        run = {"id": req_id, "project_id": pid, "branch_id": branch, "principal": principal,
               "settings": {"checkers": "all"}}
        cp = _new_cp(svc, run, req, chapters, propose=True)
        req["cp_id"] = cp["id"]
        _put(app.store, pid, branch, req)
        from . import ai_activity  # noqa: PLC0415 - ⚡ #116: the strip says which book this check is for
        with ai_activity.doing(None, book_id=pid, branch_id=branch, kind="check_now"):
            checkpoints._run_one(svc, run, {}, cp, chapters)  # noqa: SLF001
        req = get(app.store, pid, branch)
        req.update(status="done", finished_at=_now(), notes=svc.notes[-8:])
    except Exception as exc:  # noqa: BLE001 - a failed check is reported, never raised
        log.exception("check now failed")
        req = get(app.store, pid, branch)
        req.update(status="failed", error=getattr(exc, "code", type(exc).__name__), finished_at=_now(),
                   message="The check could not be finished; press 🔎 Check consistency now again.")
    _put(app.store, pid, branch, req)
    try:
        app.changed()
    except Exception:  # noqa: BLE001
        pass


def _new_cp(svc, run, req, chapters: list[dict], *, propose: bool) -> dict:
    from . import cross_check  # noqa: PLC0415
    order = [c["chapter_id"] for c in chapters]
    a, b = int(req["from"]), min(int(req["to"]), len(order))
    span = order[a - 1:b]
    allrun = dict(run, settings=dict(run.get("settings") or {}, checkers="all"))  # every working AI, always
    return {"id": req["id"], "kind": "now", "after": b, "from": a, "final": False, "act_end": False,
            "chapter_ids": span, "every": 0, "status": "new", "run_id": run["id"], "started_at": _now(),
            "parts": None, "problems": [], "fixes": {}, "summary": "", "paused_once": True, "propose": propose,
            "label": req.get("label"), "checkers": cross_check.checker_slots(svc, allrun)}


# ====================================================================== inside a run (checkpoints.run_due)
def notice(svc, run) -> None:
    """Called from the run's own thread: a newly queued request is said in the run's journal."""
    key = (run.get("project_id"), run.get("branch_id") or "main")
    if key not in _ANNOUNCE:
        return
    _ANNOUNCE.discard(key)
    req = get(svc.store, *key)
    if req.get("status") == "queued":
        svc.event(run, "note", f"🔎 Consistency check queued ({req.get('label')}): every working AI reads it after "
                  "the chapter being written; the book waits for it", step="chapters", code="CHECK_NOW_QUEUED")


def run_queued(svc, run: dict, st: dict, chapters: list[dict], upto: int) -> None:
    """At a safe point between chapters: run a queued check of this book (its fixes go through the run's review loop
    under the run consent). Raises only a pause / cancel; anything else is noted and the book goes on."""
    from . import checkpoints  # noqa: PLC0415
    from .assist import Cancelled  # noqa: PLC0415
    pid, branch = run["project_id"], run.get("branch_id") or "main"
    notice(svc, run)
    req = get(svc.store, pid, branch)
    if req.get("status") not in ("queued", "running") or not req.get("in_run"):
        return
    approved = chapters[:upto]
    if not approved:
        return
    req["to"] = min(int(req["to"]), len(approved))
    req["from"] = min(int(req["from"]), req["to"])
    svc.event(run, "note", f"🔎 Consistency check running ({req.get('label')})", step="chapters",
              code="CHECK_NOW_RUNNING")
    try:
        cp = checkpoints.get_all(svc.store, pid, branch)["items"].get(req["id"]) or _new_cp(
            svc, run, req, approved, propose=False)
        req.update(status="running", cp_id=cp["id"], started_at=req.get("started_at") or _now(), run_id=run["id"])
        _put(svc.store, pid, branch, req)
        checkpoints._run_one(svc, run, st, cp, chapters)  # noqa: SLF001
        req = get(svc.store, pid, branch)
        req.update(status="done", finished_at=_now())
        _put(svc.store, pid, branch, req)
        svc.event(run, "note", "🔎 Consistency check done: " + checkpoints.line(
            checkpoints.get_all(svc.store, pid, branch)["items"].get(cp["id"]) or cp), step="chapters",
            code="CHECK_NOW_DONE")
    except Cancelled:
        raise
    except Exception as exc:  # noqa: BLE001
        if getattr(exc, "control", False) or type(exc).__name__ in ("StepProblem", "RunPaused", "RunCancelled"):
            raise
        log.exception("queued consistency check failed")
        req = get(svc.store, pid, branch)
        req.update(status="failed", error=getattr(exc, "code", type(exc).__name__), finished_at=_now())
        _put(svc.store, pid, branch, req)
        svc.event(run, "note", "⚠️ The consistency check could not be finished; the book goes on",
                  step="chapters", code="CHECK_NOW_FAILED")


# ====================================================================== ✔ use the proposed fixes (outside a run)
def apply(app, principal, pid, branch, body) -> dict:
    """Save the proposed fixes of an on-demand check as a NEW DRAFT of each chapter (never approved here: the author
    approves it like any other draft). ``body``: {cp_id, problem_ids?}."""
    from . import checkpoints  # noqa: PLC0415
    from .continuity import chapters_of  # noqa: PLC0415
    from .book_path import BookPath  # noqa: PLC0415
    body = body if isinstance(body, dict) else {}
    cps = checkpoints.get_all(app.store, pid, branch)["items"]
    cp = cps.get(body.get("cp_id") or "")
    if not cp or cp.get("kind") != "now":
        raise AkoweError("NOT_FOUND", "/cp_id", "this consistency check is not known", status="REJECTED")
    want = body.get("problem_ids")
    probs = [p for p in cp.get("problems") or [] if p.get("status") == "proposed"
             and (want is None or p["id"] in (want or []))]
    if not probs:
        raise AkoweError("INVALID_INPUT", "/problem_ids", "there is no proposed fix to use", status="REJECTED")
    texts = {c["chapter_id"]: c for c in chapters_of(BookPath(app.engine, principal, pid, branch))}
    made = []
    by: dict[str, list] = {}
    for p in probs:
        by.setdefault(p["chapter_id"], []).append(p)
    for cid, ps in by.items():
        ch = texts.get(cid)
        rec = app.review._head(pid, branch, ch["record_id"]) if ch else None  # noqa: SLF001
        if rec is None:
            for p in ps:
                p.update(status="waiting", why="the chapter could not be found")
            continue
        prop = {"items": [{"finding_id": p["id"], "original": p["original"], "replacement": p["replacement"],
                           "ok": True, "passage": p["original"]} for p in ps], "slot": None, "keep": []}
        try:
            out = app.review.editor.apply(principal, pid, branch, rec["record_id"], rec["version"], None,
                                          proposal=prop, how="author")
        except AkoweError as exc:
            for p in ps:
                p.update(status="waiting", why=f"the words to change were not found exactly once ({exc.code})")
            continue
        done = {a["finding_id"] for a in out.get("applied") or []}
        for p in ps:
            if p["id"] in done:
                p.update(status="draft", why="saved as a new draft: read it and approve it")
            else:
                p.update(status="waiting", why="the words to change were not found exactly once in the chapter")
        made.append({"chapter_id": cid, "record_id": rec["record_id"], "version": out["version"], "fixes": len(done)})
    checkpoints._put(app.store, pid, branch, cp)  # noqa: SLF001
    return {"drafts": made, "message": f"{sum(m['fixes'] for m in made)} fix(es) saved as new draft(s) of "
                                       f"{len(made)} chapter(s): read them and approve them."}


def route(app, method, rest, body, principal, pid, branch):
    """/review/continuity/check-now[...]"""
    if rest == ["check-now"] and method == "GET":
        return 200, status(app, principal, pid, branch)
    if rest == ["check-now"] and method == "POST":
        return 202, start(app, principal, pid, branch, body)
    if rest == ["check-now", "apply"] and method == "POST":
        return 200, apply(app, principal, pid, branch, body)
    return None
