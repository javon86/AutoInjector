"""✍ Rewrite chapter 1 last: the opening pass of a ⚡ Make-a-book run (run setting ``opening_pass``, on by default).

Chapter 1 is written before the rest of the book exists. In the author's last book all three beta readers called it
the worst chapter, guessed the twist there, and two of three got lost in it. So once the whole book is written,
approved, reported on and (when asked) read by the beta readers — and BEFORE the final 🔁 improve pass
(improve_pass.py) — chapter 1 gets ONE rewrite with the whole book in view.

What the writer gets (``brief``, no AI; ``context.opening_brief``):

* a short summary of the whole book (premise, main plot, one line per chapter) and the ending (the last chapter's plan
  and its last lines);
* the setups chapter 1 must plant so the later payoffs feel fair (the main plot's obligations and open threads,
  ending_check.promises) and the book's question;
* where the twist must stay hidden: the protected mysteries (story_rules.py) and what the beta readers guessed too
  early in chapter 1;
* the notes about chapter 1, when there are some: the beta readers' fixes, the whole-book reviewers' weaknesses that
  quote chapter 1, and the editor's major notes on it;
* the rules: make it clear who is there, where we are and what just happened; open on a concrete moment; keep every
  approved fact, every name, the plot and the main character.

How it is rewritten and judged (the improve pass's machinery): the writer reworks chapter 1 through the editor's
rewrite path (exact passages only: the opening stretch, plus one stretch per setup / note; the keep list, the voices,
the protected facts and the approved canon). Nothing is saved yet: the SAME whole-book reviewers re-read the book with
the new chapter 1 (book_report.rescore).

The keep rule (simple and explainable):

1. the re-read must be comparable — the same reviewers scored it and no dimension dropped by more than
   improve_pass.DROP_MARGIN; otherwise the original chapter 1 stays;
2. the overall score went UP → the new chapter 1 is kept;
3. the overall score is the SAME → the new chapter 1 is kept only if the reviewers' notes on chapter 1 went down
   (``chapter_notes``: their weaknesses that quote chapter 1 or name it / its opening); otherwise the original stays;
4. the overall score went DOWN → the original stays.

A kept chapter 1 goes through the usual review and approval (the reviewer judges it against approved canon); when it
does not pass, its approved text is put back unchanged. The report is saved with the re-read scores and the book is
put together and exported again. Never touches a chapter the author wrote. The run window, the run's report box and
the book report say "✍ Chapter 1 rewritten with the whole book in view: kept (7.6 → 7.8/10)" (or not kept, and why).

Never blocks the book: an AI problem is a ⚠️ note (only the run's pause / cancel stop it). AI calls go through the
usual request plumbing (assist._call_ai, usage limits, failover): about 1 rewrite + the reviewers' re-read + 1 chapter
review, counted in the run forecast (run_forecast.py ``opening``). Logs: codes and numbers only.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone

from . import improve_pass

log = logging.getLogger("akowe.opening_pass")

RESCORE_KEY = "opening_rescore:{pid}:{branch}"
MAX_FINDINGS = 8
MAX_SETUPS = 3
OPENING_MIN, OPENING_MAX = 400, 900   # characters of the opening stretch the writer reworks (≤ editor.MAX_ORIGINAL)
SUMMARY_MAX = 1800
ENDING_TAIL = 600

OPENING_WORDS = (" This is the book's OPENING PASS (context.opening_brief): the whole book is written, so chapter 1 is "
                 "reworked last with all of it in view. In the opening stretch make it clear who is there, where we "
                 "are and what just happened, and open on a concrete moment. Plant the setups in opening_brief.setups "
                 "so their later payoffs feel fair, and keep the twist hidden (opening_brief.keep_hidden): plant clues "
                 "fairly, never point at the answer. Follow opening_brief.rules. A finding with no passage is advice "
                 "for the whole chapter: apply it to the one stretch (at most 600 characters) where it helps most.")
OPENING_RULES = ["Make it clear who is there, where we are and what just happened.",
                 "Open on a concrete moment (an action, a detail, a line of dialogue), not a summary.",
                 "Keep every approved fact, every name, the plot and the main character exactly as they are.",
                 "Keep every locked detail and story rule; never reveal what the book reveals later."]


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _clip(v, n: int) -> str:
    return " ".join(str(v or "").split())[:n]


def enabled(run: dict) -> bool:
    """On unless the run switched it off (a run saved before this setting existed: off, as it was)."""
    return (run.get("settings") or {}).get("opening_pass") is True


# ====================================================================== the opening stretch and the brief (no AI)
def opening_stretch(text: str) -> str:
    """The first paragraphs of the chapter (after a '# title' line), OPENING_MIN–OPENING_MAX characters, cut at a
    sentence end — always a substring of the text."""
    t = text or ""
    start = 0
    head = re.match(r"\s*#[^\n]*\n+", t)
    if head:
        start = head.end()
    while start < len(t) and t[start].isspace():
        start += 1
    end = start
    for m in re.finditer(r"\n\s*\n", t[start:]):
        end = start + m.start()
        if end - start >= OPENING_MIN:
            break
    else:
        end = len(t.rstrip())
    if end - start < OPENING_MIN:
        end = len(t.rstrip())
    if end - start > OPENING_MAX:
        cut = t[start:start + OPENING_MAX]
        ends = [m.end() for m in re.finditer(r"[.!?…][”\"’']?(?=\s)", cut)]
        end = start + (ends[-1] if ends else OPENING_MAX)
    return t[start:end].strip()


def _approved_data(bp, op: str) -> dict:
    for h in bp.heads(op):
        if h.get("approved_version") and not h.get("stale"):
            r = bp.rec(h["record_id"], h["approved_version"])
            if r:
                return r.get("data") or {}
    return {}


def _text_of(x) -> str:
    if isinstance(x, str):
        return x
    if isinstance(x, dict):
        for k in ("summary", "description", "text", "obligation", "premise", "name"):
            if isinstance(x.get(k), str) and x[k].strip():
                return x[k]
    return ""


def chapter_notes(reviews: list, ch1_text: str) -> int:
    """How many of the whole-book reviewers' weaknesses are about chapter 1: a quote found in chapter 1, or a point
    that names chapter 1 / the opening / the first chapter. (The tie-break of the keep rule.)"""
    from .book_report import _norm  # noqa: PLC0415
    t = _norm(ch1_text or "")
    n = 0
    for r in reviews or []:
        if r.get("status") != "done":
            continue
        for w in r.get("weaknesses") or []:
            q = _norm(str(w.get("quote") or ""))
            p = str(w.get("point") or "")
            if (q and len(q) >= 12 and q in t) or re.search(r"\b(chapter (1|one)|first chapter|the opening|opening "
                                                            r"(chapter|page|pages|scene))\b", p, re.I):
                n += 1
    return n


def brief(app, bp, chapters: list[dict], rep: dict | None, beta: dict | None, crafts: dict | None) -> dict:
    """What the writer gets: summary, ending, setups, what must stay hidden, the notes about chapter 1, the rules."""
    from . import ending_check, story_roles, story_rules  # noqa: PLC0415
    ch1 = chapters[0]
    last = chapters[-1]
    premise, plot = _approved_data(bp, "B01"), _approved_data(bp, "B03")
    lines = [x for x in (_clip(_text_of(premise.get("premise")) or premise.get("concept_summary"), 400),
                         _clip(_text_of(plot.get("main_plot")), 600)) if x]
    lines += [f"Chapter {c['number']}: {_clip(c.get('objective'), 160)}" for c in chapters if c.get("objective")]
    summary = "\n".join(lines)[:SUMMARY_MAX]
    tail = (last.get("text") or "")[-ENDING_TAIL:]
    ending = {"chapter": last["number"], "plan": _clip(last.get("objective"), 300),
              "last_lines": " ".join(tail.split()[1:]) if len(tail) >= ENDING_TAIL else " ".join(tail.split())}
    setups = []
    try:
        pr = ending_check.promises(bp, chapters, final=True)
        setups = [i["label"] for i in pr.get("items") or [] if i.get("kind") in ("setup", "thread", "kind")][:5]
        question = pr.get("question")
    except Exception:  # noqa: BLE001 - a brief part, never a reason to stop
        log.exception("opening pass: could not read the book's setups")
        question = None
    hidden = []
    try:
        hidden = [f"Protected mystery: {r['text']}" for r in story_rules.active(
            story_rules.get_entry(app.store, bp.pid, bp.branch)) if r.get("category") == "mystery"][:4]
    except Exception:  # noqa: BLE001
        log.exception("opening pass: could not read the protected mysteries")
    notes = []
    for f in (beta or {}).get("fixes") or []:
        if f.get("chapter") == 1:
            notes.append({"from": "beta readers", "text": _clip(f.get("text"), 300),
                          "quote": f.get("quote") if f.get("quote_verified", True) else ""})
            if "guess" in str(f.get("kind") or ""):
                hidden.append("Beta readers guessed the twist in chapter 1: " + _clip(f.get("text"), 240))
    from .book_report import _norm  # noqa: PLC0415
    t1 = _norm(ch1["text"])
    for r in (rep or {}).get("reviews") or []:
        if r.get("status") != "done":
            continue
        for w in r.get("weaknesses") or []:
            q = str(w.get("quote") or "")
            if q and _norm(q) in t1:
                notes.append({"from": "book reviewers", "text": _clip(w.get("point"), 300), "quote": q})
    cr = (crafts or {}).get(f"{ch1['record_id']}:{ch1['version']}") or {}
    for f in cr.get("findings") or []:
        if f.get("severity") == "major":
            notes.append({"from": "editor", "text": _clip(f.get("why"), 300), "quote": str(f.get("passage") or "")})
    main = None
    try:
        p = story_roles.protagonist_of(app.store, bp.pid, bp.branch)
        main = p.get("name") if p else None
    except Exception:  # noqa: BLE001
        log.exception("opening pass: could not read the main character")
    return {"summary": summary, "ending": ending, "setups": setups, "question": question,
            "keep_hidden": hidden[:6], "chapter_1_notes": notes[:8], "main_character": main, "rules": OPENING_RULES}


def findings(ch1: dict, br: dict) -> list[dict]:
    """The rewrite's findings: the opening stretch first, then one per setup, the hidden twist and the notes."""
    text = ch1["text"]
    out = []

    def add(dim, passage, why, suggestion=""):
        p = passage if passage and passage in text else ""
        if any(f["passage"] == p and f["why"] == why for f in out):
            return
        out.append({"id": f"o{len(out) + 1}", "dimension": dim, "severity": "major", "passage": p,
                    "why": _clip(why, 500), "suggestion": _clip(suggestion, 300), "keep_nearby": []})
    add("opening", opening_stretch(text), "The first page: a reader must know at once who is there, where we are and "
        "what just happened.", "Open on a concrete moment and anchor who, where and what just happened in the first "
        "lines; keep every name and fact.")
    for s in (br.get("setups") or [])[:MAX_SETUPS]:
        add("setup", "", f"Plant this setup so its later payoff feels fair: {s}", "One small, natural detail or line; "
            "do not explain it.")
    for h in (br.get("keep_hidden") or [])[:2]:
        add("keep_hidden", "", f"Keep the twist hidden: {h}", "Plant clues fairly and give a believable second "
            "explanation; never point at the answer.")
    for n in br.get("chapter_1_notes") or []:
        add(f"note_{n['from'].split()[0]}", n.get("quote") or "", f"{n['from'].capitalize()}: {n['text']}")
    return out[:MAX_FINDINGS]


# ====================================================================== keep or not
def decide(before: dict, after: dict, notes_before: int, notes_after: int) -> dict:
    """The keep rule (module docstring): comparable and higher → keep; same score → keep only if the reviewers'
    chapter-1 notes went down; else the original stays."""
    res = improve_pass.compare(before, after)
    res["notes_before"], res["notes_after"] = notes_before, notes_after
    if res["keep"]:
        res["why"] = "the overall score went up and nothing dropped"
        return res
    a, b = res.get("after"), res.get("before")
    if a is None or b is None or res["drops"] or \
            int((after or {}).get("reviewers") or 0) < int((before or {}).get("reviewers") or 0):
        return res  # not comparable, or a dimension dropped: compare's reason
    if a >= b:  # the same score: the tie-break
        if notes_after < notes_before:
            res.update(keep=True, why=f"the same score, and the reviewers' notes on chapter 1 went down "
                                      f"({notes_before} → {notes_after})")
        else:
            res.update(keep=False, why="the same score, and the reviewers' notes on chapter 1 did not go down")
        return res
    res.update(keep=False, why="the overall score went down")
    return res


def line(res: dict) -> str:
    head = "✍ Chapter 1 rewritten with the whole book in view"
    if res.get("before") is None or res.get("after") is None:
        return f"{head}: not kept, the original chapter 1 stays ({res.get('why') or 'nothing was changed'})"
    if res.get("keep"):
        return f"{head}: kept ({res['before']:g} → {res['after']:g}/10)"
    return f"{head}: not kept, the original chapter 1 stays ({res['before']:g} → {res['after']:g}/10: {res.get('why')})"


# ====================================================================== the run step
def run_step(runner, run: dict, st: dict) -> None:
    """The ⚡ run's "Rewrite chapter 1 last" step. Raises only the run's pause / cancel (and a decision the reviewer
    leaves to the author, like every other approval of the run)."""
    from .assist import Cancelled  # noqa: PLC0415
    from .autobook import RunCancelled, RunPaused, StepProblem  # noqa: PLC0415
    mem = run.setdefault("opening", {})
    try:
        _run(runner, run, st, mem)
    except (RunPaused, RunCancelled, Cancelled, StepProblem):
        raise
    except Exception as exc:  # noqa: BLE001 - the book is made; this pass never stops it
        if getattr(exc, "control", False):
            raise
        code = getattr(exc, "code", None) or type(exc).__name__
        log.warning("opening pass of run %s stopped: %s", run.get("id"), code)
        st["message"] = f"⚠️ Chapter 1 could not be rewritten ({code}); the book stays as it was made"
        runner.event(run, "note", st["message"], step="opening", code="OPENING_FAILED")
        mem["error"] = code
    runner.save(run)


def _skip(runner, run, st, mem, code: str, message: str):
    st["message"] = message
    mem["skipped"] = code
    runner.event(run, "note", f"✍ Chapter 1 last: {message}", step="opening", code="OPENING_SKIPPED")


def _run(runner, run, st, mem):
    from . import ai_activity  # noqa: PLC0415
    from . import book_report as br_mod  # noqa: PLC0415
    from .book_path import BookPath  # noqa: PLC0415
    from .editor import apply_replacements  # noqa: PLC0415
    from .errors import AkoweError  # noqa: PLC0415
    app = runner.app
    pid, branch = run["project_id"], run["branch_id"]
    if mem.get("approving"):  # resumed while the new chapter 1 waited for its review
        _approve(runner, run, st, mem)
        return _finish(runner, run, st, mem)
    if mem.get("result") or mem.get("skipped"):
        return _finish(runner, run, st, mem)
    es = runner._editor_settings(run)  # noqa: SLF001
    if not es.get("enabled") or not int(es.get("rounds") or 0) or not runner._on(run, "editor"):  # noqa: SLF001
        return _skip(runner, run, st, mem, "EDITOR_OFF", "Not run: the editor's rewrites are switched off "
                     "(Settings › Editor, or this run's pipeline)")
    rp = getattr(app, "reports", None)
    rep = rp.latest(pid, branch) if rp else None
    agg = (rep or {}).get("aggregate") or {}
    slots = [r["slot"] for r in (rep or {}).get("reviews") or [] if r.get("status") == "done" and r.get("slot")]
    if not rep or not agg.get("reviewers") or not slots:
        return _skip(runner, run, st, mem, "NO_REVIEW", "Not run: no AI reviewer scored the book, so a new chapter 1 "
                     "could not be judged")
    bp = BookPath(app.engine, run["principal"], pid, branch)
    chapters = br_mod.book_chapters(bp)
    if len(chapters) < 2:
        return _skip(runner, run, st, mem, "ONE_CHAPTER", "Not needed: the book has one chapter")
    ch1 = chapters[0]
    rec = bp.rec(ch1["record_id"], ch1["version"])
    made = getattr(runner, "_ai_made", None)
    if rec is None or (made is not None and not made(run, rec)):
        return _skip(runner, run, st, mem, "AUTHOR_CHAPTER", "Not run: you wrote chapter 1 yourself, so it stays "
                     "exactly as you wrote it")
    if not ch1.get("approved"):
        return _skip(runner, run, st, mem, "NOT_APPROVED", "Not run: chapter 1 is not approved")
    runner.check(run)
    beta = improve_pass._latest_beta(app, pid, branch)  # noqa: SLF001
    crafts = runner._review.editor.crafts(pid, branch)  # noqa: SLF001
    b = brief(app, bp, chapters, rep, beta, crafts)
    todo = findings(ch1, b)
    st["message"] = "The writer reworks chapter 1 with the whole book in view"
    run["phase"] = st["message"]
    st["items"] = [{"id": "ch1", "label": "Chapter 1", "state": "running", "notes": len(todo)}]
    runner.save(run)
    # the editor's keep list for this version (its best lines) holds here too: the same list the save checks
    keep = list((crafts.get(f"{ch1['record_id']}:{ch1['version']}") or {}).get("keep") or [])
    craft = {"findings": todo, "keep": keep, "slot": None, "version": ch1["version"], "opening": b}
    ed = runner._review.editor  # noqa: SLF001
    try:
        with ai_activity.doing("Rewriting chapter 1 with the whole book in view", done="Reworked chapter 1",
                               chapter=1, chapters=len(chapters)):
            prop = ed.propose(runner._sub_job(run, "opening", ch1["record_id"],  # noqa: SLF001
                                              run["settings"].get("slot_id")), ch1["record_id"], craft=craft)
    except AkoweError as exc:
        if getattr(exc, "control", False):
            raise
        mem["result"] = {"keep": False, "before": agg.get("overall"), "after": None,
                         "why": f"the writer could not rework it ({exc.code})"}
        runner.event(run, "note", f"⚠️ Chapter 1 could not be reworked ({exc.code}); it stays as it was",
                     step="opening", code="OPENING_PROPOSE_FAILED")
        return _finish(runner, run, st, mem)
    ok = [i for i in prop.get("items") or [] if i.get("ok")]
    res_t = apply_replacements(ch1["text"], [{k: i[k] for k in ("finding_id", "original", "replacement")} for i in ok],
                               todo, list(prop.get("keep") or [])) if ok else {"applied": []}
    if not res_t["applied"]:
        mem["result"] = {"keep": False, "before": agg.get("overall"), "after": None,
                         "why": "the writer's changes did not match the text word for word"}
        runner.event(run, "note", "✍ Chapter 1 last: the writer's changes could not be applied; chapter 1 stays as it "
                     "was", step="opening", code="OPENING_UNRESOLVED")
        return _finish(runner, run, st, mem)
    new_text = res_t["text"]
    st["message"] = "The same reviewers re-read the book with the new chapter 1"
    run["phase"] = st["message"]
    runner.save(run)
    try:
        again = rp.rescore(run["principal"], pid, branch, assist=runner._assist, review=runner._review,  # noqa: SLF001
                           overrides={ch1["chapter_id"]: new_text}, slots=slots, check=lambda: runner.check(run))
    except Exception as exc:  # noqa: BLE001
        if getattr(exc, "control", False):
            raise
        from .assist import Cancelled  # noqa: PLC0415
        if isinstance(exc, Cancelled):
            raise
        again = {"aggregate": {}, "reviews": [], "error": getattr(exc, "code", type(exc).__name__)}
    res = decide(agg, again.get("aggregate") or {}, chapter_notes(rep.get("reviews") or [], ch1["text"]),
                 chapter_notes(again.get("reviews") or [], new_text))
    mem["result"] = {k: res.get(k) for k in ("keep", "before", "after", "why", "drops", "notes_before", "notes_after")}
    mem["result"]["changed"] = len(res_t["applied"])
    for it in st.get("items") or []:
        it["state"] = "done" if res["keep"] else "skipped"
    runner.event(run, "opening", line(res), step="opening", code="OPENING_KEPT" if res["keep"] else "OPENING_NOT_KEPT")
    if res["keep"]:
        app.store.set_setting(RESCORE_KEY.format(pid=pid, branch=branch), {"reviews": again.get("reviews") or [],
                                                                           "at": _now()})
        mem["approving"] = {k: ch1[k] for k in ("chapter_id", "number", "record_id", "version")}
        runner.save(run)
        _approve(runner, run, st, mem)
    _finish(runner, run, st, mem)


def _approve(runner, run, st, mem):
    """The new chapter 1 becomes a new draft and goes through the usual review and approval; when the reviewer does
    not pass it, the approved text comes back unchanged. Then the report is saved with the re-read scores and the
    book is exported again (as in improve_pass._approve_kept)."""
    from . import continuity  # noqa: PLC0415
    from .autobook import ChecksRefused, StepProblem  # noqa: PLC0415
    from .errors import AkoweError  # noqa: PLC0415
    app = runner.app
    pid, branch = run["project_id"], run["branch_id"]
    c = mem.get("approving") or {}
    ed = runner._review.editor  # noqa: SLF001
    bp = runner.bp(run)
    head = bp.rec(c["record_id"])
    old = bp.rec(c["record_id"], c["version"])
    passed, why_not = False, "the new chapter 1 could not be saved"
    if head is not None and old is not None:
        try:
            if head["version"] == c["version"]:
                ed.apply(run["principal"], pid, branch, c["record_id"], c["version"], None, how="run")
                runner._made(run, runner.bp(run).rec(c["record_id"])["ref"])  # noqa: SLF001
                runner.save(run)
            rec = runner._review_until_approved(run, st, c["record_id"], f"chapter {c['chapter_id']}",  # noqa: SLF001
                                                chapter_id=c["chapter_id"])
            if rec:
                continuity.after_chapter(runner, run, c["chapter_id"], rec, None)
                continuity.note_written(app.store, pid, branch, c["chapter_id"], rec, c["number"])
            passed = True
        except AkoweError as exc:
            log.warning("opening pass: the new chapter 1 could not be saved: %s", exc.code)
            runner.event(run, "note", f"⚠️ The new chapter 1 could not be saved ({exc.code}); it stays as it was",
                         step="opening", code="OPENING_APPLY_FAILED")
        except (ChecksRefused, StepProblem) as exc:
            if isinstance(exc, StepProblem) and not isinstance(exc, ChecksRefused) and \
                    (exc.problem or {}).get("code") not in ("REVIEW_NOT_PASSED", "REVIEW_DECISION"):
                raise
            try:  # the reviewer did not pass the new chapter 1: its approved text comes back (never half-done)
                ref = ed.restore(run["principal"], pid, branch, c["record_id"], old, "OPENING_NOT_APPROVED")
                runner._approve(run, ref, why="the opening pass's new chapter 1 was not approved by the reviewer: "  # noqa: SLF001
                                              "the approved text is put back (unchanged)")
            except AkoweError as exc2:
                raise StepProblem(exc2.code, "The new chapter 1 was not approved and the earlier text could not be "
                                  "put back.", "Press 🔁 Try again.", record_id=c["record_id"],
                                  chapter_id=c["chapter_id"]) from None
            why_not = "the reviewer did not approve the new chapter 1"
            runner.event(run, "note", "⚠️ The reviewer did not pass the new chapter 1; its approved text is back",
                         step="opening", code="OPENING_NOT_APPROVED")
    r = mem.setdefault("result", {})
    if not passed:
        r.update(keep=False, why=why_not)
    else:
        rp = getattr(app, "reports", None)
        rows = (app.store.get_setting(RESCORE_KEY.format(pid=pid, branch=branch)) or {}).get("reviews") or []
        if rp and rows:
            try:
                rep = rp.make(run["principal"], pid, branch, assist=runner._assist, review=runner._review,  # noqa: SLF001
                              ai=False, made_by="run", run_id=run["id"], reviews=rows,
                              note="✍ These scores are the reviewers' re-read in the opening pass (chapter 1 "
                                   "rewritten with the whole book in view).")
                agg = rep.get("aggregate") or {}
                run.setdefault("report", {}).update(id=rep["id"], overall=agg.get("overall"),
                                                    reviewers=agg.get("reviewers"), independent=agg.get("independent"),
                                                    disagreements=agg.get("disagreements") or [])
            except Exception as exc:  # noqa: BLE001 - a report must never stop the book
                if getattr(exc, "control", False):
                    raise
                log.warning("opening pass: the report could not be saved: %s", getattr(exc, "code",
                                                                                      type(exc).__name__))
        improve_pass._export_again(runner, run)  # noqa: SLF001
    mem.pop("approving", None)
    runner.save(run)


def _finish(runner, run, st, mem):
    r = mem.get("result")
    if not r:
        return
    mem["line"] = line(r)
    mem["kept"] = bool(r.get("keep"))
    st["message"] = mem["line"]
    run.setdefault("report", {})["opening"] = mem["line"]
    try:  # the book report says it too
        rp = getattr(runner.app, "reports", None)
        rep = rp.latest(run["project_id"], run["branch_id"]) if rp else None
        if rep:
            rep["opening"] = mem["line"]
            rp._save(run["project_id"], run["branch_id"], rep)  # noqa: SLF001
    except Exception:  # noqa: BLE001 - a line in the report never breaks the run
        log.exception("could not add the opening line to the report")
