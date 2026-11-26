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
WORSE_BY = 1.0  # G-22-j: a second beta read this much lower (interest or overall score, out of 10) is "liked it less"


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
    # G-22-n: a Pause pressed during the last AI read is honoured here (the step runs again on ▶ Resume and its reads,
    # already made, are not asked again)
    runner.check(run)
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
                                               cp.get("finished_at"), _read_versions(bp, outline, cp))
        if not changed:
            mem["continuity_done"] = True
            return None
        cp["redo_of"] = {k: cp.get(k) for k in ("status", "summary", "counts", "finished_at")}
        cp.update(status="new", parts=None, problems=[], fixes={}, summary="", retried=False, counts={},
                  ending=None, checkers=None, redo_because=None, redo_parts=None,
                  reread_own={"numbers": sorted(changed), "at": checkpoints._now()},  # noqa: SLF001
                  paused_once=True,  # at the end of the run: what cannot be fixed waits in the report
                  wait_busy=True)  # G-22-c: no next checkpoint comes, so a busy AI / usage limit is waited for
        checkpoints._put(store, pid, branch, cp)  # noqa: SLF001
    elif status == "new" and cp.get("redo_because"):
        cp["paused_once"] = True  # a hand edit marked it: read it again now, without pausing the finished book
        cp["wait_busy"] = True
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


def _read_versions(bp, outline, cp) -> dict:
    """record id -> the version of it the final check read (noted per part since the check started noting it)."""
    by_cid = {}
    for p in cp.get("parts") or []:
        for cid, v in (p.get("versions") or {}).items():
            if isinstance(v, int) and not isinstance(v, bool):
                by_cid[cid] = v
    if not by_cid or not outline:
        return {}
    out = {}
    for c in bp.outline_chapters(outline):
        if c["chapter_id"] not in by_cid:
            continue
        _ctx, latest, appr = bp.chapter_prose(outline, c["chapter_id"])
        r = appr or latest
        if r:
            out[r["record_id"]] = by_cid[c["chapter_id"]]
    return out


# ---------------------------------------------------------------------- 📖 the beta readers, again
def _beta_again(runner, run, st, mem) -> str | None:
    s = run.get("settings") or {}
    if mem.get("beta_done") or not s.get("beta_reader"):
        return mem.get("beta_line")
    if not enabled(s, BETA_SETTING):
        return _beta_out_of_date(runner, run, mem)
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
        worse = _beta_worse(svc, pid, branch, first, now)
        if worse:  # G-22-j: the end rewrites made the book read worse — say so, and how to undo them
            mem["beta_worse"] = worse
            mem["beta_line"] += " · " + worse["line"]
            _check_later(run, worse["later"])
            _to_report(runner, run, worse["line"])
            runner.event(run, "note", worse["line"], step="reread", code="BETA_WORSE")
    else:
        run["beta"] = first
        mem["beta_line"] = "⚠️ The beta reader(s) could not read the final book again; the earlier read stays"
    mem["beta_done"] = True
    runner.event(run, "note", mem["beta_line"], step="reread", code="BETA_AGAIN")
    return mem["beta_line"]


def _read_numbers(svc, pid, branch, summary: dict) -> dict:
    """{interest, score, finish} of a beta read (one reader or a panel) from its run summary and stored record."""
    rec = (svc.get(pid, branch, summary.get("id")) if summary.get("id") else None) or {}
    if rec.get("kind") == "panel":
        ok = [r for r in rec.get("readers") or [] if r.get("status") == "done"]
        scores = [(r.get("overall") or {}).get("score") for r in ok]
        scores = [x for x in scores if isinstance(x, (int, float))]
        return {"interest": rec.get("average_interest"),
                "score": round(sum(scores) / len(scores), 1) if scores else None,
                "finish": sum(1 for r in ok if (r.get("stop") or {}).get("would_finish", True)), "of": len(ok)}
    ov = rec.get("overall") or {}
    stop = rec.get("stop") or {}
    return {"interest": rec.get("average_interest", summary.get("average_interest")), "score": ov.get("score"),
            "finish": 1 if stop.get("would_finish", True) else 0, "of": 1}


def _num(x) -> str:
    return f"{x:g}" if isinstance(x, (int, float)) else "?"


def _beta_worse(svc, pid, branch, first: dict, now: dict) -> dict | None:
    """G-22-j: did the beta reader(s) like the book less after the end rewrites (interest or the overall score down
    by a point or more, or fewer of them would finish it)? Returns {line, later, before, after} or None. Never raises."""
    try:
        a, b = _read_numbers(svc, pid, branch, first), _read_numbers(svc, pid, branch, now)
    except Exception:  # noqa: BLE001 - a comparison is a hint
        log.exception("could not compare the two beta reads")
        return None
    what = []
    for k, label in (("interest", "interest"), ("score", "overall score")):
        x, y = a.get(k), b.get(k)
        if isinstance(x, (int, float)) and isinstance(y, (int, float)) and x - y >= WORSE_BY:
            what.append(f"{label} fell from {_num(x)} to {_num(y)}/10")
    if a.get("of") and b.get("of") and b["finish"] < a["finish"] and b["finish"] < b["of"]:
        what.append("it would no longer finish the book" if b["of"] == 1 else
                    f"{b['finish']} of {b['of']} would finish it (was {a['finish']} of {a['of']})")
    if not what:
        return None
    line = ("⚠️ The beta reader liked the book less after Akọwe's end rewrites (" + "; ".join(what) + "). The earlier "
            "chapter texts are kept: to undo the end rewrites, open the rewritten chapter(s) and put the earlier "
            "version back")
    later = ("End rewrites (chapter 1 last / improve pass): the beta reader liked the book less afterwards ("
             + "; ".join(what) + ") — compare and, if you agree, put the earlier chapter text back")
    return {"line": line, "later": later, "before": a, "after": b}


def _beta_out_of_date(runner, run, mem) -> str | None:
    """G-22-l: re-reading is switched off but the book changed since the beta read — say the read is for the book
    before the end rewrites (the step line and the report). Never raises."""
    mem["beta_done"] = True
    try:
        if (run.get("beta") or {}).get("status") != "done":
            return None
        from . import beta_reader  # noqa: PLC0415
        from . import book_report as br  # noqa: PLC0415
        latest = beta_reader.service_of(runner.app).latest(run["project_id"], run["branch_id"])
        chapters = br.book_chapters(runner.bp(run))
        if not latest or not chapters or latest.get("version_key") == br.version_key(chapters):
            return None
    except Exception:  # noqa: BLE001 - a hint, never a reason to stop
        log.exception("could not check whether the beta read is out of date")
        return None
    mem["beta_line"] = ("📖 The beta read is for an earlier version of the book, before the end rewrites "
                        "(re-reading is switched off: ask a beta reader again on the 📊 report page)")
    _to_report(runner, run, mem["beta_line"])
    runner.event(run, "note", mem["beta_line"], step="reread", code="BETA_OUT_OF_DATE")
    return mem["beta_line"]


def _check_later(run, line: str) -> None:
    later = run.setdefault("check_later", [])
    if line not in later:
        later.append(line)


def _to_report(runner, run, line: str) -> None:
    """Add a line to the latest report's warnings (once). Never raises."""
    try:
        rp = getattr(runner.app, "reports", None)
        rep = rp.latest(run["project_id"], run["branch_id"]) if rp else None
        if rep is not None and line not in (rep.get("warnings") or []):
            rep.setdefault("warnings", []).append(line)
            rp._save(run["project_id"], run["branch_id"], rep)  # noqa: SLF001
        if line not in (run.setdefault("report", {}).setdefault("warnings", [])):
            run["report"]["warnings"].append(line)
    except Exception:  # noqa: BLE001 - a line in the report never breaks the run
        log.exception("could not add a line to the report")


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
        book, target, per = length_guard.book_numbers(runner.app.engine, runner.store, run["principal"],
                                                run["project_id"], run["branch_id"])
        chs = length_guard.chapter_words(runner.app.engine, run["principal"], run["project_id"], run["branch_id"])
        ln = length_guard.line(book, target, chs, per)  # 📏 the book and each chapter against its share
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
