"""🔁 Read the final book again: the last step of a ⚡ Make-a-book run, after Akọwe's own rewrites at the end.

In "The Tide Ledger" the final whole-book continuity check was made BEFORE chapter 1 was rewritten last
(opening_pass.py) and before the improve pass (improve_pass.py), and was then shown as "to be read again (chapter 1
was changed by hand)" — Akọwe's own rewrite had been taken for a hand edit — and never read again. The beta readers
too had read an earlier version ("This read is for an earlier version of the book: a chapter changed since").

Two fixes:

* Akọwe's own approvals in a run (a rewrite, a polish, a fix, an earlier text put back) are registered
  (continuity.note_own, from autobook._approve) BEFORE they are approved, so the hand-edit check
  (continuity.check_edits) never takes them for the author's edits: no "changed by hand", no redo marks;
* this step, once at the end, reads the book again where it changed since the last reading:

  1. 🧭 the final whole-book continuity check (checkpoints.py, id "final") is read again when a chapter it read was
     changed after it finished (Akọwe's own rewrites: continuity.own_changes_since; a hand edit already marked it
     "to be read again") — run setting ``reread_after_rewrites``, on by default. It may make small fixes like any
     checkpoint; it never pauses the run at this point (what it cannot fix waits in the report);
  2. 📖 the beta reader(s) read the book again when the run had them and the book changed since their read (the
     book's version key, book_report.version_key) — run setting ``beta_reread``, on by default. They read before the
     opening / improve passes on purpose: those passes use their notes. The new read is the one the report shows.

Nothing happens when nothing changed. Never holds up the book: a problem is a ⚠️ note; only the run's pause / cancel
stop it. The AI answers are counted in the run forecast (run_forecast.py ``reread``). The run window also gets the
book's length against its target (length_guard.line). Logs: codes and numbers only.
"""
from __future__ import annotations

import logging

log = logging.getLogger("akowe.final_reads")

SETTING = "reread_after_rewrites"
BETA_SETTING = "beta_reread"


def enabled(settings: dict | None, key: str = SETTING) -> bool:
    return (settings or {}).get(key) is not False


def run_step(runner, run: dict, st: dict) -> None:
    mem = run.setdefault("final_reads", {})
    lines = []
    for fn in (_continuity_again, _beta_again):
        try:
            ln = fn(runner, run, st, mem)
        except Exception as exc:  # noqa: BLE001 - a second read is help, never a reason to stop the book
            if getattr(exc, "control", False) or type(exc).__name__ in ("RunPaused", "RunCancelled", "Cancelled"):
                raise
            code = getattr(exc, "code", None) or type(exc).__name__
            log.warning("final reads of run %s stopped: %s", run.get("id"), code)
            ln = f"⚠️ A second read could not be finished ({code})"
            runner.event(run, "note", ln, step="reread", code="REREAD_FAILED")
        if ln:
            lines.append(ln)
    ln = _length(runner, run)
    if ln:
        lines.append(ln)
    _keep_doctor(runner, run)
    st["message"] = " · ".join(lines) if lines else "Nothing changed since the last reads"
    runner.save(run)


# ---------------------------------------------------------------------- 🧭 the final whole-book check, again
def _continuity_again(runner, run, st, mem) -> str | None:
    if mem.get("continuity_done"):
        return mem.get("continuity_line")
    if not enabled(run.get("settings")):
        return None
    from . import checkpoints, continuity  # noqa: PLC0415
    pid, branch = run["project_id"], run["branch_id"]
    store = runner.store
    cp = checkpoints.get_all(store, pid, branch)["items"].get("final")
    if not cp or not cp.get("final"):
        mem["continuity_done"] = True
        return None
    bp = runner.bp(run)
    outline = bp.outline()
    chapters = bp.outline_chapters(outline) if outline else []
    status = cp.get("status")
    if status in ("done", "incomplete"):
        changed = continuity.own_changes_since(store, pid, branch, _record_ids(bp, outline, cp),
                                               cp.get("finished_at"))
        if not changed:
            mem["continuity_done"] = True
            return None
        cp["redo_of"] = {k: cp.get(k) for k in ("status", "summary", "counts", "finished_at")}
        cp.update(status="new", parts=None, problems=[], fixes={}, summary="", retried=False, counts={},
                  ending=None, checkers=None, redo_because=None, redo_parts=None,
                  reread_own={"numbers": sorted(changed), "at": checkpoints._now()},  # noqa: SLF001
                  paused_once=True)  # at the end of the run: what cannot be fixed waits in the report
        checkpoints._put(store, pid, branch, cp)  # noqa: SLF001
    elif status == "new" and cp.get("redo_because"):
        cp["paused_once"] = True  # a hand edit marked it: read it again now, without pausing the finished book
    elif status not in ("new", "reading", "waiting"):
        mem["continuity_done"] = True
        return None
    st["message"] = "The final whole-book check reads the book again after Akọwe's own rewrites"
    run["phase"] = st["message"]
    runner.save(run)
    checkpoints._run_one(runner, run, st, cp, chapters)  # noqa: SLF001
    cp = checkpoints.get_all(store, pid, branch)["items"].get("final") or cp
    mem.update(continuity_done=True, continuity_line=checkpoints.line(cp))
    runner.event(run, "note", mem["continuity_line"], step="reread", code="FINAL_CHECK_AGAIN")
    runner.save(run)
    return mem["continuity_line"]


def _record_ids(bp, outline, cp) -> dict:
    """chapter number -> record id of the chapters the final check read."""
    out = {}
    if not outline:
        return out
    ids = set(cp.get("chapter_ids") or [])
    for i, c in enumerate(bp.outline_chapters(outline)):
        if ids and c["chapter_id"] not in ids:
            continue
        _ctx, latest, appr = bp.chapter_prose(outline, c["chapter_id"])
        r = appr or latest
        if r:
            out[i + 1] = r["record_id"]
    return out


# ---------------------------------------------------------------------- 📖 the beta readers, again
def _beta_again(runner, run, st, mem) -> str | None:
    s = run.get("settings") or {}
    if mem.get("beta_done") or not s.get("beta_reader") or not enabled(s, BETA_SETTING):
        return mem.get("beta_line")
    beta = run.get("beta") or {}
    if beta.get("status") != "done":
        mem["beta_done"] = True
        return None
    from . import beta_reader  # noqa: PLC0415
    from . import book_report as br  # noqa: PLC0415
    from .autobook import RunCancelled, RunPaused  # noqa: PLC0415
    pid, branch = run["project_id"], run["branch_id"]
    svc = beta_reader.service_of(runner.app)
    latest = svc.latest(pid, branch)
    chapters = br.book_chapters(runner.bp(run))
    key = br.version_key(chapters) if chapters else None
    if not latest or not key or latest.get("version_key") == key:
        mem["beta_done"] = True
        return None
    first = dict(beta)
    beta_reader.run_step(runner, run, st, control=(RunPaused, RunCancelled))
    now = run.get("beta") or {}
    if now.get("status") == "done":
        run["beta_first"] = first  # what the readers said before the end rewrites (they used it)
        mem["beta_line"] = "📖 The beta reader(s) read the final book again: " + str(st.get("message") or "done")
    else:
        run["beta"] = first
        mem["beta_line"] = "⚠️ The beta reader(s) could not read the final book again; the earlier read stays"
    mem["beta_done"] = True
    runner.event(run, "note", mem["beta_line"], step="reread", code="BETA_AGAIN")
    return mem["beta_line"]


# ---------------------------------------------------------------------- 🩺 the plan check's line stays
def _keep_doctor(runner, run) -> None:
    """A report remade by the end rewrites (chapter 1 last, the improve pass) keeps the story doctor's line and notes
    (story_doctor.to_report). Never raises."""
    try:
        if not (run.get("story_doctor") or {}).get("line"):
            return
        rp = getattr(runner.app, "reports", None)
        rep = rp.latest(run["project_id"], run["branch_id"]) if rp else None
        if rep and not rep.get("doctor"):
            from . import story_doctor  # noqa: PLC0415
            story_doctor.to_report(runner, run, rep)
    except Exception:  # noqa: BLE001 - a line in the report never breaks the run
        log.exception("could not keep the story doctor's line in the report")


# ---------------------------------------------------------------------- 📏 the finished book's length
def _length(runner, run) -> str | None:
    try:
        from . import length_guard  # noqa: PLC0415
        book, target, _per = length_guard.book_numbers(runner.app.engine, runner.store, run["principal"],
                                                 run["project_id"], run["branch_id"])
        ln = length_guard.line(book, target)
    except Exception:  # noqa: BLE001
        log.exception("could not measure the book's length")
        return None
    if ln:
        run.setdefault("report", {})["length"] = ln
        try:
            rp = getattr(runner.app, "reports", None)
            rep = rp.latest(run["project_id"], run["branch_id"]) if rp else None
            if rep:
                rep["length"] = ln
                rp._save(run["project_id"], run["branch_id"], rep)  # noqa: SLF001
        except Exception:  # noqa: BLE001 - a line in the report never breaks the run
            log.exception("could not add the length line to the report")
    return ln
