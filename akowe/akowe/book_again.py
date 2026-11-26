"""🔁 The run goes back: the last book steps of a ⚡ Make-a-book run (format → assemble → export → check) are made
again inside the run whenever something they are made from changed after they were made.

Before, each of these steps only did its own work and refused when an EARLIER one had become out of date: a book
renamed after its format was made, a page size changed, a chapter edited and approved after the book was put together,
a chapter set aside near the end, or a book put together again by hand. The run stopped with “Approve every chapter
and the book format first.” / “Put the book together and approve it first.”, and ▶ Resume started again at the same
step and refused the same way, for ever.

Now:

* ``before(runner, run, sid)`` — at the start of assemble / export / check, every earlier book step that is no longer
  done in the book's checklist is made again first, in order (deterministic, no AI call; a chapter that lost its
  approval is written again by the chapters step), and the journal says so (``BOOK_AGAIN``);
* ``export(runner, run, st)`` — the export step: a stored file that does not read back (damaged on disk, or a writer
  that returned a broken file once) is made again once before the run stops; the stop says it in plain words;
* ``finish(runner, run)`` — before a run is marked done, the checklist is read once more: anything that changed while
  the last steps ran is put together, exported and checked again, and a newer chapter draft that is not approved is
  named (the files carry the approved text);
* ``nearly_empty(runner, run)`` — after the book is put together, a chapter far below its planned length is named;
* ``check_message(...)`` — the content check's answer in plain words (the first problem, the chapters by number), and
  an unreadable answer is a plain stop instead of an unexpected error.

Journal notes carry codes and numbers only (never book text); optional notes never stop the book.
"""
from __future__ import annotations

import hashlib
import logging
import re

log = logging.getLogger("akowe.book_again")

BOOK_STEPS = ("format", "assemble", "export", "check")
# what must be done (in the book's checklist) before each book step can be made
PRE = {"format": (), "assemble": ("chapters", "format"), "export": ("chapters", "format", "assemble"),
       "check": ("chapters", "format", "assemble", "export")}
WORDS = {"format": "the book format was made again", "assemble": "the book was put together again",
         "export": "the files were made again", "check": "the book was checked again"}
NO_AI_STEPS = frozenset(BOOK_STEPS)


def _steps(runner, run) -> dict:
    return {s["id"]: s for s in runner.bp(run).status()["steps"]}


def _unapproved(step: dict) -> list[int]:
    """The numbers (1-based) of the outline chapters that have no approved text now."""
    return [i + 1 for i, c in enumerate(step.get("chapters") or []) if not c.get("approved")]


def _done(sid: str, steps: dict) -> bool:
    s = steps.get(sid) or {}
    if sid == "chapters":
        return bool(s.get("chapters")) and not _unapproved(s)
    return s.get("state") == "done"


def _numbers(nums: list[int]) -> str:
    return ", ".join(str(n) for n in nums[:12]) + (" …" if len(nums) > 12 else "")


def _why(sid: str, steps: dict) -> str:
    """Why an earlier book step is made again, in plain words (no book text)."""
    s = steps.get(sid) or {}
    if sid == "chapters":
        nums = _unapproved(s)
        return (f"Chapter{'s' if len(nums) > 1 else ''} {_numbers(nums)} {'are' if len(nums) > 1 else 'is'} no longer "
                "approved (set aside or deleted since it was written): Akọwe writes "
                f"{'them' if len(nums) > 1 else 'it'} again before the book is put together")
    if sid == "format":
        if s.get("out_of_date"):
            return "The title, author or page size changed after the book format was made: " + WORDS[sid]
        if s.get("state") == "needs_you":
            return "The book format was waiting for approval: it was approved"
        return "The book format was missing or could not be read: " + WORDS[sid]
    if sid == "assemble":
        if s.get("state") == "needs_you":
            return "The book was put together again outside this run: that assembly was approved"
        if s.get("out_of_date"):
            return "Something the book is made from changed after it was put together: " + WORDS[sid]
        return "The book's assembly was missing or could not be read: " + WORDS[sid]
    if sid == "export":
        return "The book changed after the files were made: " + WORDS[sid]
    return "The book changed after it was checked: " + WORDS[sid]


def before(runner, run, sid: str) -> list[str]:
    """Make every earlier book step that is no longer done again, in order, before ``sid`` (one of BOOK_STEPS).
    Returns the step ids that were made again. A step that still cannot be made raises its own plain stop."""
    again = []
    for pre in PRE.get(sid, ()):
        steps = _steps(runner, run)
        if _done(pre, steps):
            continue
        if pre == "chapters" and not (steps.get("chapters") or {}).get("chapters"):
            continue  # no outline chapters at all: the step's own refusal says so
        why = _why(pre, steps)
        runner.event(run, "note", f"🔁 {why}.", step=sid, code="BOOK_AGAIN", made=pre)
        log.info("make-a-book run %s: %s made again before %s", run.get("id"), pre, sid)
        getattr(runner, f"_s_{pre}")(run, runner._step(run, pre))  # noqa: SLF001
        again.append(pre)
    return again


# ------------------------------------------------------------------------------------------------ export
def _reread(runner, run, s: dict) -> tuple[list, list]:
    """Read every exported file back with Akọwe's independent checkers: (files, problems). A problem's ``kind`` is
    "saved" (the stored file is missing or damaged) or "made" (the file was saved as made but does not read back)."""
    from .autobook import verify_file  # noqa: PLC0415 - autobook imports this module lazily
    from .errors import AkoweError  # noqa: PLC0415
    files, bad = [], []
    for f in s.get("files") or []:
        fmt = f.get("format") or "?"
        try:
            rec = runner.store.get_record(run["project_id"], run["branch_id"], f["record_id"], f["version"])
            if rec is None:
                bad.append({"format": fmt, "code": "NOT_FOUND", "kind": "saved", "why": "the saved file is missing"})
                continue
            data = runner.store.read_binary(rec)
        except AkoweError as exc:
            if getattr(exc, "control", False):
                raise
            code = exc.code or "NOT_FOUND"
            bad.append({"format": fmt, "code": code, "kind": "saved",
                        "why": "the saved file is damaged" if code == "HASH_MISMATCH" else "the saved file is missing"})
            continue
        except OSError as exc:
            bad.append({"format": fmt, "code": "NOT_FOUND", "kind": "saved",
                        "why": f"the saved file could not be read (error {exc.errno})"})
            continue
        ok, why = verify_file(fmt, data)
        if not ok:
            bad.append({"format": fmt, "code": "HASH_MISMATCH", "kind": "made", "why": why or "it does not read back"})
            continue
        files.append(dict(f, bytes=len(data), sha256=hashlib.sha256(data).hexdigest()))
    return files, bad


DISK_WORDS = re.compile(r"disk|no space|space left|ENOSPC|errno 28", re.I)


def _export_once(runner, run):
    """Make the files (backup first); a refusal is a plain stop (the disk-full words when the disk is full)."""
    from .autobook import StepProblem  # noqa: PLC0415
    b = runner.app.backups.try_backup("before-export")
    if b:
        runner.event(run, "backup", f"Backup before exporting ({b['name']})")
    out = runner._export_under_consent(run, runner.bp(run))  # noqa: SLF001
    if not out.get("ok") or out.get("problems"):
        probs = [str(p) for p in out.get("problems") or []]
        full = [p.split(":", 1)[0] for p in probs if DISK_WORDS.search(p)]
        if full:
            raise StepProblem("INVALID_INPUT", f"The disk is full: the {', '.join(dict.fromkeys(full))} file could "
                              "not be saved.", "Free some space on the disk, then press 🔁 Try again.",
                              details=probs[:6], step="export")
        from . import stop_words  # noqa: PLC0415
        msg = (out.get("message") or "Some files could not be made.").rstrip(".")
        msg = f"{msg}: {probs[0]}" if probs else msg + "."  # 🗣 what went wrong, in the module's plain words
        raise StepProblem("INVALID_INPUT", msg, stop_words.fix_for(msg) or "Press 🔁 Try again.",
                          details=probs[:6], step="export")


def export(runner, run, st):
    """The export step: make the files when they are not current, then read each one back. A file that does not
    read back is made again once (a damaged saved file, or a writer that returned a broken file); only when the
    new one fails too does the run stop, in plain words."""
    from .autobook import StepProblem  # noqa: PLC0415
    before(runner, run, "export")
    s = _steps(runner, run)["export"]
    if s["state"] != "done":
        _export_once(runner, run)
        s = _steps(runner, run)["export"]
    files, bad = _reread(runner, run, s)
    if bad:
        fmts = ", ".join(dict.fromkeys(b["format"] for b in bad))
        runner.event(run, "note", f"🔁 The {fmts} file did not read back ({bad[0]['why']}): Akọwe made the files "
                                  "again", step="export", code="EXPORT_REMADE", problem=bad[0]["code"], files=len(bad))
        log.warning("make-a-book run %s: %d exported file(s) did not read back (%s); made again", run.get("id"),
                    len(bad), bad[0]["code"])
        _export_once(runner, run)
        s = _steps(runner, run)["export"]
        files, bad = _reread(runner, run, s)
    if bad:
        b = bad[0]
        if b["kind"] == "made":
            msg = f"The {b['format']} file Akọwe made does not read back correctly, even when made again: {b['why']}"
            fix = "Press 🔁 Try again. If it fails again, use 📋 Copy diagnostics."
        else:
            msg = f"The {b['format']} file could not be saved correctly ({b['why']}), even when made again."
            fix = "Check the disk (free space, errors), then press 🔁 Try again."
        raise StepProblem("HASH_MISMATCH", msg[:400], fix, details=[f"{x['format']}: {x['why']}" for x in bad][:6],
                          step="export")
    for f in files:
        runner.event(run, "export", f"{f['format']} file made and re-read ({f['bytes']} bytes)")
    run["files"] = files
    st["message"] = "Made and re-read: " + ", ".join(f["format"] for f in files)


# ------------------------------------------------------------------------------------------------ check
def _chapter_no(asm: dict) -> dict:
    """record id of each assembled chapter -> its number in the book (1-based)."""
    out = {}
    for i, x in enumerate(asm.get("chapters") or [] if isinstance(asm, dict) else []):
        if isinstance(x, str) and ":" in x:
            out.setdefault(x.rsplit(":", 1)[0], i + 1)
    return out


def _nums_in(text: str, nums: dict) -> list[int]:
    return sorted({n for rid, n in nums.items() if rid and rid in text})


PLAIN = {
    "DUPLICATE_CHAPTER_TEXT": ("Chapters {} have the same text", "Two chapters have the same text"),
    "EMPTY_CHAPTER": ("Chapter {} is empty", "A chapter is empty"),
    "MISSING_CHAPTER": ("Chapter {} is missing from the book", "A chapter is missing from the book"),
    "DUPLICATE_SECTION": ("Chapter {} is in the book twice", "A chapter is in the book twice"),
    "REPEATED_BLOCK": ("A paragraph is repeated in chapter {}", "A paragraph is repeated in a chapter"),
}


def check_message(result, asm: dict) -> dict:
    """The content check's answer (H05 ``result``) for the author: {ok, message, problems}. A result Akọwe cannot
    read (not an object, no status, findings that are not a list) is a plain refusal, never an unexpected error."""
    res = result if isinstance(result, dict) else {}
    status = res.get("status")
    raw = res.get("findings")
    findings = [f for f in raw if isinstance(f, dict)] if isinstance(raw, list) else []
    if not isinstance(status, str) or not status or (raw is not None and not isinstance(raw, list)):
        return {"ok": False, "message": "The content check gave an answer Akọwe could not read.",
                "problems": [], "unreadable": True}
    if status == "PASS":
        return {"ok": True, "message": "Content check: PASS.", "problems": []}
    fails = [f for f in findings if f.get("decision") == "FAIL"]
    nums = _chapter_no(asm)
    first = ""
    for f in fails:
        rule = str(f.get("rule_id") or "")
        if rule in PLAIN:
            which = _nums_in(str(f.get("message") or ""), nums)
            first = PLAIN[rule][0].format(" and ".join(str(n) for n in which)) if which else PLAIN[rule][1]
            break
    if not first:
        first = "Not every chapter is in the book once and in order"
    return {"ok": False, "message": f"Content check: {first}.",
            "problems": [str(f.get("message") or "")[:300] for f in fails][:8]}


# ------------------------------------------------------------------------------------------------ notes
def nearly_empty(runner, run) -> list[int]:
    """⚠️ A chapter far below its planned length (under a tenth of the chapter target, or a few words) is named
    after the book is put together. Never stops the book."""
    try:
        from . import lengths  # noqa: PLC0415
        chs = (_steps(runner, run).get("chapters") or {}).get("chapters") or []
        target = int(lengths.of_book(runner.store, run["project_id"], len(chs) or None).get("target_words") or 0)
        bp = runner.bp(run)
        low = max(3, min(target // 10, 60)) if target else 3
        nums = []
        for i, c in enumerate(chs):
            a = c.get("approved") or {}
            rec = bp.rec(a.get("record_id"), a.get("version")) if a.get("record_id") else None
            text = ((rec or {}).get("data") or {}).get("text") if isinstance((rec or {}).get("data"), dict) else None
            if rec is not None and len(str(text or "").split()) < low:
                nums.append(i + 1)
        if nums:
            many = len(nums) > 1
            runner.event(run, "note", f"⚠️ Chapter{'s' if many else ''} {_numbers(nums)} {'are' if many else 'is'} "
                         f"almost empty (fewer than {low} words) but approved: the book was put together with "
                         f"{'them' if many else 'it'} as {'they are' if many else 'it is'}. Write more and approve it, "
                         "then put the book together and export it again.", step="assemble",
                         code="CHAPTER_NEARLY_EMPTY", chapters=nums[:12])
        return nums
    except Exception as exc:  # noqa: BLE001 - a note must never stop the book
        if getattr(exc, "control", False):
            raise
        log.warning("make-a-book run %s: no nearly-empty chapter check (%s)", run.get("id"), type(exc).__name__)
        return []


def finish(runner, run):
    """Before the run is marked done: the book's checklist is read once more. Anything that changed while the last
    steps ran (an edited or set-aside chapter, a new title, the book put together again by hand) is made again —
    put together, exported and checked — so the run never says done next to a book that is not. Then a newer
    chapter draft that is not approved is named (the files carry the approved text)."""
    steps = _steps(runner, run)
    behind = [sid for sid in ("chapters",) + BOOK_STEPS if not _done(sid, steps)]
    if behind:
        runner.event(run, "note", "🔁 The book changed while its last steps ran: Akọwe put it together, exported and "
                                  "checked it again before finishing", step="check", code="BOOK_AGAIN",
                     made=",".join(behind))
        log.info("make-a-book run %s: book steps behind at the end (%s): made again", run.get("id"), ",".join(behind))
        runner._s_check(run, runner._step(run, "check"))  # noqa: SLF001 - makes the earlier ones first
    waiting(runner, run)


def waiting(runner, run) -> list[int]:
    """📝 Name the chapters whose newest draft is not approved (the files carry the approved text). Never raises."""
    try:
        chs = (_steps(runner, run).get("chapters") or {}).get("chapters") or []
        nums = [i + 1 for i, c in enumerate(chs) if c.get("revision_waiting")]
        if nums:
            many = len(nums) > 1
            runner.event(run, "note", f"📝 Chapter{'s' if many else ''} {_numbers(nums)} {'have' if many else 'has'} a "
                         "newer draft that is not approved: the files carry the approved text. Approve the newer "
                         "draft in the book if you want it, then put the book together and export it again.",
                         step="check", code="DRAFT_WAITING", chapters=nums[:12])
        return nums
    except Exception as exc:  # noqa: BLE001 - a note must never stop the book
        if getattr(exc, "control", False):
            raise
        log.warning("make-a-book run %s: no waiting-draft check (%s)", run.get("id"), type(exc).__name__)
        return []
