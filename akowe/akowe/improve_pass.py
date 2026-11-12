"""🔁 Improve until better: the final pass of a ⚡ Make-a-book run (run setting ``improve_pass``, on by default, at
most ``improve_rounds`` rounds, default 2).

After the book report and the beta readers, Akọwe gathers what they said needs fixing and what nothing used before:

* the editor's MAJOR notes on the approved chapters, and the notes queued when the author pressed **✔ Approve anyway**
  on a chapter the reviewer had not passed (``queue``; kept per book in ``improve_queue:<book>:<branch>``);
* Akọwe's own no-AI checks: clock / tide / day contradictions (clock_check.py), phrases and similes repeated across
  chapters and plain-word tics (human_voice.repeats, quality_history.word_tics), chapters written too simply for the
  book's readers (readability floor);
* the beta readers' top fixes (where they got lost, guessed the twist, called it the worst chapter);
* the whole-book reviewers' "What to try next" and their lowest dimensions.

The chapters with the most to fix (at most ``MAX_CHAPTERS`` per round; never a chapter the author wrote) get ONE
targeted rewrite each by their writer (the editor's rewrite machinery: exact passages only, the keep list, the
voices, the protected facts and the approved canon; the improve rules: never change what happens, the ending's
outcome, names, the main character, locked details or approved facts). Nothing is saved yet: the SAME whole-book
reviewers re-read the book with the rewritten chapters (book_report.rescore). The rewrite is **kept only if** the
overall score went up and no dimension dropped by more than ``DROP_MARGIN``; then each rewritten chapter goes through
the usual review and approval (the reviewer judges it against approved canon; a chapter it does not pass gets its
earlier text back), the book is put together and exported again and the report is saved with the new scores.
Otherwise the original book stays exactly as it was. Both numbers are said in the run window, the journal and the
report ("🔁 Improve pass: 7.6 → 8.1, kept"). A round that does not improve ends the pass.

📏 A round that is not kept still keeps its phrase-repeat fixes alone when they are safe (``repeat_only``; run setting
``chapter_polish``): only the replacements that answered a repeated phrase or a plain-word tic, applied to the
chapter as it is, kept when the whole book then repeats less and nothing else got worse or changed (Akọwe's own
checks, no AI); those chapters then go through the usual review and approval like a kept round's chapters.

Never blocks the book: an AI problem is a ⚠️ note (only the run's pause / cancel stop it). AI calls go through the
usual request plumbing (assist._call_ai, usage limits, failover). Logs: codes and numbers only.
"""
from __future__ import annotations

import logging
import re
import threading
from datetime import datetime, timezone

log = logging.getLogger("akowe.improve_pass")

KEY = "improve_queue:{pid}:{branch}"
RESCORE_KEY = "improve_rescore:{pid}:{branch}"
MAX_CHAPTERS = 3
MAX_FINDINGS = 8
DROP_MARGIN = 1.0
MIN_GAIN = 0.1
ROUNDS_DEFAULT = 2
ROUNDS_MAX = 3
_LOCK = threading.RLock()

IMPROVE_WORDS = (" This is the book's final improve pass (context.improve_rules): fix each finding inside the chapter "
                 "as it is — never change what happens, the ending's outcome, who lives or dies, names, the main "
                 "character, a 🔒 locked detail, an approved fact or the story rules. A finding with no passage is "
                 "advice for the whole chapter: apply it to the one stretch (at most 600 characters) where it helps "
                 "most.")
IMPROVE_RULES = ["Keep the plot, the ending's outcome, every name and the main character exactly as they are.",
                 "Keep every locked detail, approved fact and story rule.",
                 "Fix clock and tide times so they agree with the times stated earlier.",
                 "Never reuse a simile or phrase from another chapter; vary plain words.",
                 "For adult readers, prefer some longer, more complex sentences over strings of short ones."]
WEIGHT = {"queued": 4, "editor": 3, "clock": 3, "beta_strong": 3, "beta": 2, "repeat": 1, "tic": 1, "reading": 1,
          "reviewers": 1}


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _clip(v, n: int) -> str:
    return " ".join(str(v or "").split())[:n]


# ====================================================================== ✔ Approve anyway: the notes are kept
def _key(pid: str, branch: str) -> str:
    return KEY.format(pid=pid, branch=branch)


def queue(store, pid: str, branch: str, chapter_id: str, rec: dict, findings: list[dict], why: str) -> int:
    """Keep a chapter's notes for the final improve pass (an approval the reviewer had not given). Returns how many
    notes wait for that chapter."""
    items = []
    for f in findings or []:
        items.append({"id": _clip(f.get("id") or f"q{len(items) + 1}", 24), "dimension": _clip(f.get("dimension"), 40),
                      "severity": "major", "passage": str(f.get("passage") or "")[:600],
                      "why": _clip(f.get("why"), 400), "suggestion": _clip(f.get("suggestion"), 300)})
    with _LOCK:
        cur = store.get_setting(_key(pid, branch)) or {}
        row = cur.get(chapter_id) or {}
        have = {(x.get("passage"), x.get("why")) for x in row.get("findings") or []}
        merged = list(row.get("findings") or []) + [x for x in items if (x["passage"], x["why"]) not in have]
        cur[chapter_id] = {"record_id": rec.get("record_id"), "version": rec.get("version"), "why": why,
                           "findings": merged[:MAX_FINDINGS * 2], "at": _now()}
        store.set_setting(_key(pid, branch), cur)
    return len(cur[chapter_id]["findings"])


def queued(store, pid: str, branch: str) -> dict:
    try:
        return dict(store.get_setting(_key(pid, branch)) or {})
    except Exception:  # noqa: BLE001
        return {}


def clear(store, pid: str, branch: str, chapter_ids) -> None:
    with _LOCK:
        cur = store.get_setting(_key(pid, branch)) or {}
        for c in chapter_ids:
            cur.pop(c, None)
        store.set_setting(_key(pid, branch), cur)


# ====================================================================== what to fix, per chapter (no AI)
def _add(out: dict, ch: dict, src: str, f: dict):
    row = out.setdefault(ch["number"], {"chapter_id": ch["chapter_id"], "number": ch["number"],
                                        "record_id": ch["record_id"], "version": ch["version"], "text": ch["text"],
                                        "findings": [], "sources": {}, "weight": 0})
    passage = str(f.get("passage") or "")
    if passage and passage not in ch["text"]:
        passage = ""  # never point at words that are not on the page
    key = (passage, _clip(f.get("why"), 120))
    if any((x["passage"], _clip(x["why"], 120)) == key for x in row["findings"]):
        return
    row["findings"].append({"id": f"i{ch['number']}-{len(row['findings']) + 1}", "dimension": f.get("dimension")
                            or "improve", "severity": "major", "passage": passage, "why": _clip(f.get("why"), 500),
                            "suggestion": _clip(f.get("suggestion"), 300), "source": src})
    row["sources"][src] = row["sources"].get(src, 0) + 1
    row["weight"] += WEIGHT.get(src, 1)


def targets(store, pid: str, branch: str, chapters: list[dict], rep: dict | None, beta: dict | None,
            crafts: dict | None = None, skip: set | None = None) -> list[dict]:
    """The chapters to rewrite, most to fix first (≤ MAX_CHAPTERS), each with ≤ MAX_FINDINGS findings."""
    from . import clock_check, human_voice, quality_history  # noqa: PLC0415
    out: dict[int, dict] = {}
    by_id = {c["chapter_id"]: c for c in chapters}
    by_num = {c["number"]: c for c in chapters}
    skip = skip or set()
    # 1. notes queued by "Approve anyway" (for the version still on the page) and the editor's major notes
    for cid, row in queued(store, pid, branch).items():
        ch = by_id.get(cid)
        if ch and row.get("record_id") == ch["record_id"]:
            for f in row.get("findings") or []:
                _add(out, ch, "queued", f)
    for ch in chapters:
        cr = (crafts or {}).get(f"{ch['record_id']}:{ch['version']}") or {}
        for f in cr.get("findings") or []:
            if f.get("severity") == "major":
                _add(out, ch, "editor", f)
    # 2. clock / tide contradictions (the chapter of the later passage changes)
    for f in clock_check.check_book(chapters)["findings"]:
        ch = by_id.get(f["passages"][-1]["chapter"])
        if ch:
            _add(out, ch, "clock", {"dimension": "timeline", "passage": f["passages"][-1]["quote"],
                                    "why": f"{f['label']}: {f['detail']}", "suggestion": f["advice"]})
    # 3. phrases / similes repeated across chapters: every use after the first
    for f in human_voice.repeats(chapters).get("findings") or []:
        if f["kind"] not in ("phrase", "gesture"):
            continue
        first = min(f["chapters"]) if f.get("chapters") else None
        for ex in f.get("examples") or []:
            ch = by_num.get(ex.get("chapter"))
            if ch and ex.get("chapter") != first:
                q = str(ex.get("quote") or "").strip("“”\"")
                _add(out, ch, "repeat", {"dimension": "prose_variety", "passage": q if q in ch["text"] else "",
                                         "why": f"{f['label']}: {f['message']}", "suggestion": "Say it in a new way "
                                         "only this moment could have."})
                row = out.get(ch["number"])
                if row is not None and f.get("what") and f["what"] not in row.setdefault("phrases", []):
                    row["phrases"].append(f["what"])
    # 4. plain-word tics: to the chapter that leans on them most
    allt = "\n".join(c["text"] for c in chapters)
    for t in quality_history.word_tics(allt)[:3]:
        rx = re.compile(rf"\b{re.escape(t['word'])}\b", re.I)
        ch = max(chapters, key=lambda c: len(rx.findall(c["text"])))
        _add(out, ch, "tic", {"dimension": "prose_variety", "passage": "", "why": f"“{t['word']}” is used {t['count']}"
                              f"× in the book ({t['per_1000']} per 1 000 words)", "suggestion": "Replace most uses "
                              "with the precise verb for each moment."})
    # 5. reading level under the floor for the book's readers
    rd = (rep or {}).get("readability") or {}
    floor = quality_history.READING_FLOOR.get(((rd.get("audience") or {}).get("key")) or "adult")
    if floor is not None:
        for r in rd.get("chapters") or []:
            g = r.get("grade")
            ch = by_num.get(r.get("number"))
            if ch and isinstance(g, (int, float)) and g < floor:
                _add(out, ch, "reading", {"dimension": "prose_variety", "passage": "", "why": f"Reading grade {g:g} "
                                          f"is under {floor:g} for these readers: the sentences are too simple.",
                                          "suggestion": "Join some short sentences into longer, more complex ones "
                                          "with precise words."})
    # 6. the beta readers' top fixes
    for f in (beta or {}).get("fixes") or []:
        ch = by_num.get(f.get("chapter"))
        if ch:
            q = f.get("quote") if f.get("quote_verified", True) else ""
            _add(out, ch, "beta_strong" if f.get("strong") else "beta",
                 {"dimension": "beta_" + str(f.get("kind") or "reader"), "passage": q or "", "why": f.get("text"),
                  "suggestion": ""})
    # 7. the reviewers' "What to try next" and lowest dimensions: advice for the chapters already chosen (or ch. 1)
    advice = [t["text"] for t in (rep or {}).get("try_next") or [] if t.get("from") not in ("planned", "words")][:4]
    picked = sorted(out.values(), key=lambda r: -r["weight"])[:MAX_CHAPTERS] or ([{"number": chapters[0]["number"]}]
                                                                              if chapters else [])
    for i, a in enumerate(advice):
        num = picked[i % len(picked)]["number"] if picked else None
        ch = by_num.get(num)
        if ch:
            _add(out, ch, "reviewers", {"dimension": "reviewers", "passage": "", "why": a, "suggestion": ""})
    rows = [r for r in out.values() if r["number"] not in skip]
    rows.sort(key=lambda r: (-r["weight"], r["number"]))
    for r in rows:
        r["findings"].sort(key=lambda f: (-WEIGHT.get(f["source"], 1), not f["passage"]))
        r["findings"] = r["findings"][:MAX_FINDINGS]
    return rows[:MAX_CHAPTERS]


# ====================================================================== keep or not
def compare(before: dict, after: dict) -> dict:
    """{keep, before, after, gain, drops: [{dimension, label, from, to}], why}: keep only when the overall went up by
    at least MIN_GAIN, no dimension dropped by more than DROP_MARGIN and the same reviewers read both."""
    b, a = (before or {}).get("overall"), (after or {}).get("overall")
    out = {"before": b, "after": a, "gain": round(a - b, 1) if a is not None and b is not None else None, "drops": []}
    bd = {d["dimension"]: d for d in (before or {}).get("dimensions") or [] if d.get("n")}
    for d in (after or {}).get("dimensions") or []:
        o = bd.get(d["dimension"])
        if o and d.get("n") and d["median"] < o["median"] - DROP_MARGIN:
            out["drops"].append({"dimension": d["dimension"], "label": d.get("label"), "from": o["median"],
                                 "to": d["median"]})
    if a is None or b is None:
        out.update(keep=False, why="the reviewers could not score the rewritten book")
    elif int((after or {}).get("reviewers") or 0) < int((before or {}).get("reviewers") or 0):
        out.update(keep=False, why="not every reviewer could read the rewritten book, so the scores do not compare")
    elif out["drops"]:
        out.update(keep=False, why="; ".join(f"{d['label']} dropped {d['from']:g}→{d['to']:g}" for d in out["drops"]))
    elif a < b + MIN_GAIN:
        out.update(keep=False, why="the overall score did not go up")
    else:
        out.update(keep=True, why="the overall score went up and nothing dropped")
    return out


def line(res: dict) -> str:
    if res.get("before") is None:
        return "🔁 Improve pass: nothing was changed"
    if res.get("after") is None:
        return f"🔁 Improve pass: {res['before']:g}/10 — {res.get('why') or 'nothing was changed'}"
    word = "kept" if res.get("keep") else "not kept, the original book stays"
    return f"🔁 Improve pass: {res['before']:g} → {res['after']:g}/10 ({word}" + (
        "" if res.get("keep") else f": {res.get('why')}") + ")"


# ====================================================================== the run step
def rounds_of(settings: dict) -> int:
    n = (settings or {}).get("improve_rounds", ROUNDS_DEFAULT)
    return n if isinstance(n, int) and not isinstance(n, bool) and 1 <= n <= ROUNDS_MAX else ROUNDS_DEFAULT


def _latest_beta(app, pid, branch) -> dict | None:
    try:
        from . import beta_reader  # noqa: PLC0415
        reads = beta_reader.service_of(app).reads(pid, branch)
    except Exception:  # noqa: BLE001
        return None
    for r in reversed(reads or []):
        if r.get("status") != "done":
            continue
        if r.get("kind") == "panel":
            cmp_ = r.get("comparison") or {}
            return {"fixes": cmp_.get("fixes") or [], "average": (cmp_.get("totals") or {}).get("average_score")}
        fixes = []
        for f in r.get("findings") or []:
            if f.get("severity") in ("major", "minor"):
                for c in f.get("chapters") or []:
                    fixes.append({"kind": f.get("id"), "chapter": c, "strong": f.get("severity") == "major",
                                  "text": f"Chapter {c}: {f.get('label')} — {f.get('advice')}", "quote": ""})
        return {"fixes": fixes, "average": (r.get("overall") or {}).get("score")}
    return None


def run_step(runner, run: dict, st: dict) -> None:
    """The ⚡ run's "Improve until better" step. Raises only the run's pause / cancel (and a chapter decision the
    reviewer leaves to the author, like every other approval of the run)."""
    from .assist import Cancelled  # noqa: PLC0415
    from .autobook import RunCancelled, RunPaused  # noqa: PLC0415
    mem = run.setdefault("improve", {"rounds": [], "done": 0})
    try:
        _run(runner, run, st, mem)
    except (RunPaused, RunCancelled, Cancelled):
        raise
    except Exception as exc:  # noqa: BLE001 - the book is made; this pass never stops it
        if getattr(exc, "control", False):
            raise
        from .autobook import StepProblem  # noqa: PLC0415
        if isinstance(exc, StepProblem):
            raise
        code = getattr(exc, "code", None) or type(exc).__name__
        log.warning("improve pass of run %s stopped: %s", run.get("id"), code)
        st["message"] = f"⚠️ The improve pass could not finish ({code}); the book stays as it was made"
        runner.event(run, "note", st["message"], step="improve", code="IMPROVE_FAILED")
        mem["error"] = code
    runner.save(run)


def _run(runner, run, st, mem):
    from . import book_report as br  # noqa: PLC0415
    from .book_path import BookPath  # noqa: PLC0415
    app = runner.app
    pid, branch = run["project_id"], run["branch_id"]
    rp = getattr(app, "reports", None)
    rounds = rounds_of(run.get("settings") or {})
    es = runner._editor_settings(run)  # noqa: SLF001
    if not mem.get("approving") and (not es.get("enabled") or not int(es.get("rounds") or 0)
                                     or not runner._on(run, "editor")):  # noqa: SLF001
        # the pass uses the editor's rewrite machinery: with the editor (or its rewrites) off it changes nothing
        st["message"] = "Not run: the editor's rewrites are switched off (Settings › Editor, or this run's pipeline)"
        runner.event(run, "note", f"🔁 Improve pass: {st['message']}", step="improve", code="IMPROVE_SKIPPED")
        mem["skipped"] = "EDITOR_OFF"
        return
    if mem.get("approving"):  # resumed while kept chapters waited for their review
        _approve_kept(runner, run, st, mem)
    while int(mem.get("done") or 0) < rounds and not mem.get("stop"):
        runner.check(run)
        rep = rp.latest(pid, branch) if rp else None
        agg = (rep or {}).get("aggregate") or {}
        slots = [r["slot"] for r in (rep or {}).get("reviews") or [] if r.get("status") == "done" and r.get("slot")]
        if not rep or not agg.get("reviewers") or not slots:
            st["message"] = ("Not run: no AI reviewer scored the book, so a rewrite could not be judged (📨 Ask the "
                             "other AIs on the report page, then make a new book or improve it by hand)")
            runner.event(run, "note", f"🔁 Improve pass: {st['message']}", step="improve", code="IMPROVE_SKIPPED")
            mem["skipped"] = "NO_REVIEW"
            return
        bp = BookPath(app.engine, run["principal"], pid, branch)
        chapters = br.book_chapters(bp)
        skip = set()
        made = getattr(runner, "_ai_made", None)
        for c in chapters:  # never a chapter the author wrote
            rec = bp.rec(c["record_id"], c["version"])
            if rec is None or (made is not None and not made(run, rec)):
                skip.add(c["number"])
        crafts = runner._review.editor.crafts(pid, branch)
        beta = _latest_beta(app, pid, branch)
        todo = targets(app.store, pid, branch, chapters, rep, beta, crafts, skip)
        n = int(mem.get("done") or 0) + 1
        if not todo:
            st["message"] = "Nothing left to fix" if n > 1 else "Nothing to fix: the reviewers, the editor and " \
                                                                "Akọwe's checks found nothing concrete"
            runner.event(run, "note", f"🔁 Improve pass: {st['message']}", step="improve", code="IMPROVE_NOTHING")
            return
        st["message"] = f"Round {n} of {rounds}: the writer reworks chapter(s) " + ", ".join(
            str(t["number"]) for t in todo)
        run["phase"] = st["message"]
        st["items"] = [{"id": f"r{n}c{t['number']}", "label": f"Round {n}: chapter {t['number']}", "state": "running",
                        "notes": len(t["findings"])} for t in todo]
        runner.save(run)
        cands = within_budget(chapters, _propose(runner, run, todo, n, rounds, len(chapters)), app.store, pid,
                              run.get("settings"))  # 📏 the reworked chapters together keep the book's length
        if not cands:
            mem["done"] = n
            mem["rounds"].append({"round": n, "chapters": [t["number"] for t in todo], "changed": 0,
                                  "before": agg.get("overall"), "after": None, "keep": False,
                                  "why": "the writer's changes did not match the text word for word"})
            runner.event(run, "note", f"🔁 Improve pass round {n}: the writer's changes could not be applied; the "
                         "book stays as it was", step="improve", code="IMPROVE_UNRESOLVED")
            break
        st["message"] = f"Round {n} of {rounds}: the same reviewers re-read the book with the reworked chapter(s)"
        run["phase"] = st["message"]
        runner.save(run)
        try:
            again = rp.rescore(run["principal"], pid, branch, assist=runner._assist, review=runner._review,
                               overrides={c["chapter_id"]: c["text"] for c in cands}, slots=slots,
                               check=lambda: runner.check(run))
        except Exception as exc:  # noqa: BLE001
            if getattr(exc, "control", False):
                raise
            from .assist import Cancelled  # noqa: PLC0415
            if isinstance(exc, Cancelled):
                raise
            again = {"aggregate": {}, "reviews": [], "error": getattr(exc, "code", type(exc).__name__)}
        res = compare(agg, again.get("aggregate") or {})
        mem["done"] = n
        row = {"round": n, "chapters": [c["number"] for c in cands], "changed": sum(c["applied"] for c in cands),
               "before": res["before"], "after": res["after"], "keep": res["keep"], "why": res["why"],
               "drops": res["drops"]}
        mem["rounds"].append(row)
        mem.setdefault("first", res["before"])
        for it in st.get("items") or []:
            it["state"] = "done" if res["keep"] else "skipped"
        runner.event(run, "improve", line(res) + f" — round {n}, chapter(s) {', '.join(map(str, row['chapters']))}",
                     step="improve", code="IMPROVE_KEPT" if res["keep"] else "IMPROVE_NOT_KEPT")
        if not res["keep"]:
            _repeat_fixes(runner, run, st, mem, chapters, cands, n)
            break
        # what to approve is kept for a resume: numbers in the run, the reviewers' re-read with the book's data
        app.store.set_setting(RESCORE_KEY.format(pid=pid, branch=branch), {"reviews": again.get("reviews") or [],
                                                                          "round": n, "at": _now()})
        mem["approving"] = {"chapters": [{k: c[k] for k in ("chapter_id", "number", "record_id", "version")}
                                         for c in cands], "round": n}
        runner.save(run)
        _approve_kept(runner, run, st, mem)
    _finish(runner, run, st, mem)


def _propose(runner, run, todo, n, rounds, total) -> list[dict]:
    """One targeted rewrite per chapter by its writer (nothing saved): [{chapter_id, number, record_id, version,
    text (the rewritten chapter), applied}] — the proposal itself is stored by the editor for exactly that version."""
    from . import ai_activity  # noqa: PLC0415
    from .editor import apply_replacements  # noqa: PLC0415
    from .errors import AkoweError  # noqa: PLC0415
    out = []
    ed = runner._review.editor
    for t in todo:
        runner.check(run)
        craft = {"findings": t["findings"], "keep": [], "slot": None, "version": t["version"], "improve": True}
        if t.get("phrases"):  # 📏 a repeat Akọwe only guessed to be a motif may be said anew (never the author's)
            from .chapter_polish import released_motifs  # noqa: PLC0415
            craft["except_keys"] = released_motifs(runner.app.engine, run["principal"], run["project_id"],
                                                   run["branch_id"], t["phrases"])
        try:
            with ai_activity.doing(f"Improve pass: reworking chapter {t['number']}",
                                   done=f"Improve pass: reworked chapter {t['number']}", chapter=t["number"],
                                   chapters=total):
                prop = ed.propose(runner._sub_job(run, "improve", t["record_id"], run["settings"].get("slot_id")),
                                  t["record_id"], craft=craft)
        except AkoweError as exc:
            if getattr(exc, "control", False):
                raise
            runner.event(run, "note", f"⚠️ Improve pass: chapter {t['number']} could not be reworked ({exc.code})",
                         step="improve", code="IMPROVE_PROPOSE_FAILED")
            continue
        ok = [i for i in prop.get("items") or [] if i.get("ok")]
        if not ok:
            continue
        res = apply_replacements(t["text"], [{k: i[k] for k in ("finding_id", "original", "replacement")} for i in ok],
                                 t["findings"], list(prop.get("keep") or []))
        if not res["applied"]:
            continue
        by_f = {f["id"]: f for f in t["findings"]}
        out.append({"chapter_id": t["chapter_id"], "number": t["number"], "record_id": t["record_id"],
                    "version": t["version"], "text": res["text"], "applied": len(res["applied"]),
                    "fixes": [dict(a, source=(by_f.get(a["finding_id"]) or {}).get("source"),
                                   passage=(by_f.get(a["finding_id"]) or {}).get("passage") or "")
                              for a in res["applied"]]})
    return out


def within_budget(chapters: list[dict], cands: list[dict], store, pid: str, settings: dict | None) -> list[dict]:
    """📏 The length guard over a whole round (length_guard.py; each rewrite was already held to its own budget):
    the reworked chapters that grow the book past its cap are left out, the ones that add the most words first."""
    from . import length_guard, lengths  # noqa: PLC0415
    if not cands or not length_guard.enabled(settings):
        return cands
    try:
        target = lengths.of_book(store, pid)["book_words"]
    except Exception:  # noqa: BLE001
        return cands
    old = {c["chapter_id"]: length_guard.words(c["text"]) for c in chapters}
    total = sum(old.values())
    keep = list(cands)

    def grow(c):
        return length_guard.words(c["text"]) - old.get(c["chapter_id"], length_guard.words(c["text"]))
    while keep and sum(grow(c) for c in keep) > 0 and \
            total + sum(grow(c) for c in keep) > target * length_guard.BOOK_CAP:
        keep.remove(max(keep, key=grow))
    return keep


# ====================================================================== 📏 a round not kept: its repeat fixes alone
REPEAT_SOURCES = ("repeat", "tic")
REPEAT_ORIGINAL_MAX = 400   # a phrase-level change, never a rewritten scene


def _book_repeats(chs: list[dict]) -> tuple[int, int]:
    """(phrases / similes / gestures repeated across chapters, uses of plain-word tics) of the whole book."""
    from . import human_voice, quality_history  # noqa: PLC0415
    f = [x for x in human_voice.repeats(chs).get("findings") or [] if x.get("kind") in ("phrase", "gesture")]
    return len(f), sum(t["count"] for t in quality_history.word_tics("\n".join(c["text"] for c in chs)))


def repeat_only(chapters: list[dict], cands: list[dict], names=(), keeps: dict | None = None) -> list[dict]:
    """The safe rule for a round that was NOT kept (no AI): from each rewritten chapter take only the replacements
    that answered a repeated phrase or a plain-word tic (each ≤ REPEAT_ORIGINAL_MAX characters) and apply them alone
    to the chapter as it is. They are kept only if the book then repeats fewer phrases or leans less on plain words,
    and nothing else got worse or changed: no new repeat, the chapter's reading grade not lower, no more AI-sounding
    phrases, every line of dialogue, name and number as before (chapter_polish.protected_change). The whole-book
    score was never measured for this smaller change, so it is not claimed: the chapters then go through the usual
    review and approval. ``keeps``: chapter id -> the quotes the editor said to keep (never changed). Returns
    [{chapter_id, number, record_id, version, accept, text, before, after}]."""
    from . import originality, readability  # noqa: PLC0415
    from .chapter_polish import protected_change  # noqa: PLC0415
    from .editor import apply_replacements  # noqa: PLC0415
    work = [dict(c) for c in chapters]
    idx = {c["chapter_id"]: i for i, c in enumerate(work)}
    base = _book_repeats(work)
    out = []
    for c in cands:
        fixes = [a for a in c.get("fixes") or [] if a.get("source") in REPEAT_SOURCES
                 and len(a.get("original") or "") <= REPEAT_ORIGINAL_MAX]
        i = idx.get(c["chapter_id"])
        if not fixes or i is None or work[i].get("version") != c.get("version"):
            continue
        old = work[i]["text"]
        res = apply_replacements(old, [{k: a[k] for k in ("finding_id", "original", "replacement")} for a in fixes],
                                 [{"id": a["finding_id"], "passage": a.get("passage") or ""} for a in fixes],
                                 list((keeps or {}).get(c["chapter_id"]) or []))
        if not res["applied"]:
            continue
        new = res["text"]
        if protected_change(old, new, names) or originality.counts(new) > originality.counts(old):
            continue
        g0, g1 = readability.chapter(old).get("grade"), readability.chapter(new).get("grade")
        if g0 is not None and g1 is not None and g1 < g0 - 0.1:
            continue
        trial = list(work)
        trial[i] = dict(work[i], text=new)
        now = _book_repeats(trial)
        if now[0] > base[0] or now[1] > base[1] or now == base:
            continue
        out.append({"chapter_id": c["chapter_id"], "number": c["number"], "record_id": c["record_id"],
                    "version": c["version"], "accept": [a["finding_id"] for a in res["applied"]], "text": new,
                    "before": base[0] + base[1], "after": now[0] + now[1]})
        work, base = trial, now
    return out


def repeat_line(mem: dict) -> str:
    rf = mem.get("repeat_fixes") or {}
    if not rf.get("chapters"):
        return ""
    return (f" · repeated phrases fixed alone in chapter(s) {', '.join(map(str, rf['chapters']))} (repeats "
            f"{rf.get('before')} → {rf.get('after')})")


def _repeat_fixes(runner, run, st, mem, chapters, cands, n):
    """A round was not kept: keep its repeat fixes alone when repeat_only says they are safe (run setting
    ``chapter_polish``, the same switch as the chapter polish). No AI call of its own: the chapters go through the
    usual review and approval like a kept round's (a chapter the reviewer does not pass gets its text back)."""
    from . import chapter_polish  # noqa: PLC0415
    if not chapter_polish.enabled(run.get("settings")):
        return
    pid, branch = run["project_id"], run["branch_id"]
    try:
        names = runner._review.editor.names(pid, branch)  # noqa: SLF001
    except Exception:  # noqa: BLE001
        names = []
    from .editor import _rkey, keep_quotes_of  # noqa: PLC0415
    crafts = runner._review.editor.crafts(pid, branch) or {}  # noqa: SLF001
    keeps = {c["chapter_id"]: keep_quotes_of(crafts.get(_rkey(c["record_id"], c["version"])) or {}, c["text"])
             for c in chapters}
    picked = repeat_only(chapters, cands, names, keeps)
    if not picked:
        return
    mem["stop"] = True  # this ends the pass, also after a resume
    mem["repeat_fixes"] = {"round": n, "before": picked[0]["before"], "after": picked[-1]["after"],
                           "chapters": [p["number"] for p in picked]}
    runner.app.store.set_setting(RESCORE_KEY.format(pid=pid, branch=branch), {"reviews": [], "round": n,
                                                                             "at": _now()})
    mem["approving"] = {"chapters": [{k: p[k] for k in ("chapter_id", "number", "record_id", "version", "accept")}
                                     for p in picked], "round": n, "repeat_only": True}
    runner.event(run, "improve", "🔁 Improve pass: the repeated-phrase fixes alone are kept in chapter(s) "
                 f"{', '.join(str(p['number']) for p in picked)} (repeats {picked[0]['before']} → "
                 f"{picked[-1]['after']}); they go through the usual review", step="improve",
                 code="IMPROVE_REPEATS_KEPT")
    runner.save(run)
    _approve_kept(runner, run, st, mem)


def _approve_kept(runner, run, st, mem):
    """The kept rewrites become new drafts and go through the usual review and approval; a chapter the reviewer does
    not pass gets its earlier text back. Then the report is saved with the new scores and the book is exported
    again."""
    from . import continuity  # noqa: PLC0415
    from .autobook import ChecksRefused, StepProblem  # noqa: PLC0415
    from .errors import AkoweError  # noqa: PLC0415
    app = runner.app
    pid, branch = run["project_id"], run["branch_id"]
    ap = mem.get("approving") or {}
    ed = runner._review.editor
    back = []
    for c in ap.get("chapters") or []:
        if c.get("state") == "done":
            continue
        runner.check(run)
        bp = runner.bp(run)
        head = bp.rec(c["record_id"])
        old = bp.rec(c["record_id"], c["version"])
        if head is None or old is None:
            c["state"] = "done"
            continue
        if head["version"] == c["version"]:
            try:
                ed.apply(run["principal"], pid, branch, c["record_id"], c["version"], c.get("accept"), how="run")
            except AkoweError as exc:
                runner.event(run, "note", f"⚠️ Improve pass: chapter {c['number']}'s rewrite could not be saved "
                             f"({exc.code}); its text stays as it was", step="improve", code="IMPROVE_APPLY_FAILED")
                c["state"] = "done"
                back.append(c["number"])
                continue
            runner._made(run, runner.bp(run).rec(c["record_id"])["ref"])
            runner.save(run)
        label = f"chapter {c['chapter_id']}"
        try:
            rec = runner._review_until_approved(run, st, c["record_id"], label, chapter_id=c["chapter_id"])
            if rec:
                continuity.after_chapter(runner, run, c["chapter_id"], rec, None)
                continuity.note_written(app.store, pid, branch, c["chapter_id"], rec, c["number"])
        except (ChecksRefused, StepProblem) as exc:
            if isinstance(exc, StepProblem) and not isinstance(exc, ChecksRefused) and \
                    (exc.problem or {}).get("code") not in ("REVIEW_NOT_PASSED", "REVIEW_DECISION"):
                raise
            # the reviewer did not pass the reworked chapter: its approved text comes back (never left half-done)
            try:
                ref = ed.restore(run["principal"], pid, branch, c["record_id"], old, "IMPROVE_NOT_APPROVED")
                runner._made(run, ref)  # noqa: SLF001 - Akọwe's own text put back, not a hand edit
                runner._approve(run, ref, why="the improve pass's rewrite was not approved by the reviewer: the "
                                              "approved text is put back (unchanged)")
            except AkoweError as exc2:
                raise StepProblem(exc2.code, f"The improve pass's rewrite of chapter {c['number']} was not approved "
                                  "and the earlier text could not be put back.", "Press 🔁 Try again.",
                                  record_id=c["record_id"], chapter_id=c["chapter_id"]) from None
            back.append(c["number"])
            runner.event(run, "note", f"⚠️ Improve pass: the reviewer did not pass the reworked chapter {c['number']}; "
                         "its approved text is back", step="improve", code="IMPROVE_NOT_APPROVED")
        c["state"] = "done"
        runner.save(run)
    clear(app.store, pid, branch, [c["chapter_id"] for c in ap.get("chapters") or [] if c["number"] not in back
                                   and not c.get("accept")])  # repeat fixes alone leave the other notes waiting
    rp = getattr(app, "reports", None)
    rows = (app.store.get_setting(RESCORE_KEY.format(pid=pid, branch=branch)) or {}).get("reviews") or []
    if rp and rows and len(back) < len(ap.get("chapters") or []):
        try:
            rep = rp.make(run["principal"], pid, branch, assist=runner._assist, review=runner._review, ai=False,
                          made_by="run", run_id=run["id"], reviews=rows,
                          note="🔁 These scores are the reviewers' re-read in the final improve pass (before the "
                               "reworked chapters' last check).")
            agg = rep.get("aggregate") or {}
            run.setdefault("report", {}).update(id=rep["id"], overall=agg.get("overall"),
                                                reviewers=agg.get("reviewers"), independent=agg.get("independent"),
                                                disagreements=agg.get("disagreements") or [])
        except Exception as exc:  # noqa: BLE001 - a report must never stop the book
            if getattr(exc, "control", False):
                raise
            log.warning("improve pass: the report could not be saved: %s", getattr(exc, "code", type(exc).__name__))
    if ap.get("repeat_only"):  # 🔁 only the phrase-repeat fixes of a round that was not kept
        rf = mem.setdefault("repeat_fixes", {})
        rf["chapters"] = [c["number"] for c in ap.get("chapters") or [] if c["number"] not in back]
        rf["back"] = back
    else:
        mem["kept"] = int(mem.get("kept") or 0) + 1
    mem.pop("approving", None)
    _export_again(runner, run)
    runner.save(run)


def _export_again(runner, run):
    """The chapters changed: the book is put together, exported and checked again (the files carry the new text)."""
    for sid in ("assemble", "export", "check"):
        getattr(runner, f"_s_{sid}")(run, runner._step(run, sid))


def _finish(runner, run, st, mem):
    rs = mem.get("rounds") or []
    if not rs:
        return
    first = rs[0]["before"]
    kept = [r for r in rs if r.get("keep")]
    final = kept[-1]["after"] if kept else first
    mem.update(before=first, after=final, kept=bool(kept), last_try=rs[-1].get("after"))
    res = {"before": first, "after": final if kept else rs[-1].get("after"), "keep": bool(kept),
           "why": rs[-1].get("why")}
    mem["line"] = line(res) + (f" · {len(rs)} round(s)" if len(rs) > 1 else "") + repeat_line(mem)
    st["message"] = mem["line"]
    run.setdefault("report", {})["improve"] = mem["line"]
    try:  # the report says both numbers too
        rp = getattr(runner.app, "reports", None)
        rep = rp.latest(run["project_id"], run["branch_id"]) if rp else None
        if rep:
            rep["improve"] = mem["line"]
            if (run.get("report") or {}).get("polish"):  # 📏 a remade report keeps the chapter polish's line
                rep["polish"] = run["report"]["polish"]
            rp._save(run["project_id"], run["branch_id"], rep)  # noqa: SLF001
    except Exception:  # noqa: BLE001 - a line in the report never breaks the run
        log.exception("could not add the improve line to the report")
