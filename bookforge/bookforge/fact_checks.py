"""🔎 Fact checks for the editor (Section 7a): the timeline checker and terminology check (P26), the trade-facts lane
(P31) and the repetition sorter (P30), put together for one chapter, the whole book, the AI editor, the rewrite
machinery, Make-a-book runs and the HTTP API.

The three checks live in their own modules (``timeline_check``, ``terms``, ``repetition``); this module only reads
the book (the newest text of every outline chapter, in order), runs them and hands the results on:

* **chapter page / book page** — ``FactChecker.chapter`` / ``.book`` (deterministic, no AI, a few ms per chapter);
* **the AI editor** — ``editor_context`` adds ``fact_checks`` (the timeline's ages/years and findings, the term
  findings, the repetition classes with "never cut voice or motif repeats") to the editor's context, and
  ``protected_keep`` adds the exact words of voice/motif repeats to every rewrite's keep list (editor.propose), so a
  rewrite that cuts them is refused (KEEP_LOST);
* **✨ Fix with AI** — ``propose_fix(kind="terms" | "repeats")`` turns wrong/conflicting terms or the trimmable
  repeats of one chapter into anchored findings (dimension ``terminology`` / ``repetition``) for ``editor.propose``;
  the author applies the chosen changes through ``/review/editor/apply`` as usual (a new draft version);
* **AI help for the trade facts** — ``terms.ai_find`` (one call per chapter: which terms to check) and
  ``terms.ai_research`` (one call: answers as advice, never a verification);
* **runs** — ``run_book_check`` (after the planned-to-page book check): adds the terms it finds as "research needed",
  counts timeline problems, terms still unverified and accidental repeats → ⚠️ notes, never blocks the book.

Everything here is advice: nothing is changed in the book without the author (or a run's consent for rewrites the
editor already makes).
"""
from __future__ import annotations

import logging

from . import repetition as rep_mod
from . import terms as terms_mod
from . import timeline_check as tl_mod
from .errors import BookforgeError

log = logging.getLogger("bookforge.fact_checks")

MAX_FIX_FINDINGS = 12
EDITOR_BUDGET = 3000     # characters of JSON for fact_checks in the editor's context (approximate)
RUN_SCAN_CHAPTERS = 60

EDITOR_NOTE = ("BookForge's own checks (no AI) of this chapter. timeline: ages and years it found and where they do "
               "not add up — confirm or ignore each in your findings (dimension continuity or the closest one). "
               "terms: equipment and period words that are wrong, do not fit (a wick on a gas lamp) or are not "
               "verified yet — never invent how equipment works. repeats: voice and motif repeats are deliberate — "
               "never ask to cut them; only accidental repeats (and the excess of others, listed as trim) may be cut.")


def _now():
    from .story_rules import _now as now  # noqa: PLC0415
    return now()


# ====================================================================== reading the book
def book_texts(engine, principal, pid, branch) -> list[dict]:
    """[{chapter_id, number, record_id, version, text, approved}] — the newest version of every outline chapter, in
    order (unwritten chapters are left out)."""
    from .book_path import BookPath  # noqa: PLC0415
    bp = BookPath(engine, principal, pid, branch)
    outline = bp.outline()
    if not outline:
        return []
    out = []
    for i, c in enumerate(bp.outline_chapters(outline)):
        _ctx, latest, appr = bp.chapter_prose(outline, c["chapter_id"])
        rec = latest or appr
        if not rec:
            continue
        out.append({"chapter_id": c["chapter_id"], "number": i + 1, "record_id": rec["record_id"],
                    "version": rec["version"], "text": str((rec.get("data") or {}).get("text") or ""),
                    "approved": bool(appr and appr["version"] == rec["version"])})
    return out


def _context(store, pid, branch) -> dict:
    """Names, characters, voices, motifs, labels, the trade-facts entry and the story year (never raises)."""
    from . import characters as chars_mod  # noqa: PLC0415
    from . import texture as texture_mod  # noqa: PLC0415
    out = {"names": [], "characters": [], "voices": {}, "motifs": [], "labels": {}, "labels_version": 0,
           "terms": None, "work_words": []}
    try:
        cs = chars_mod.canon_characters(store, pid, branch)
        out["characters"] = cs
        out["names"] = [c["name"] for c in cs if c.get("name")]
    except Exception:  # noqa: BLE001
        log.exception("could not read the characters")
    try:
        out["voices"] = chars_mod.voice_words(store, pid, branch)
    except Exception:  # noqa: BLE001
        log.exception("could not read the voice cards")
    try:
        tex = texture_mod.items_of(texture_mod.get_entry(store, pid, branch))
        out["motifs"] = [w for i in tex for w in i.get("words") or []]
        out["work_words"] = [w for i in tex if i.get("kind") == "work" for w in i.get("words") or []]
    except Exception:  # noqa: BLE001
        log.exception("could not read the world texture")
    lab = rep_mod.get_labels(store, pid, branch)
    out["labels"], out["labels_version"] = lab.get("labels") or {}, int(lab.get("version") or 0)
    out["terms"] = terms_mod.get_entry(store, pid, branch)
    return out


def story_year_of(ctx: dict, timeline: dict | None = None):
    return (ctx.get("terms") or {}).get("story_year") or (timeline or {}).get("story_year")


def _run_all(chs: list[dict], ctx: dict) -> tuple[dict, dict]:
    pairs = [(c["chapter_id"], c["text"]) for c in chs]
    timeline = tl_mod.check_book(pairs, names=ctx["names"], characters=ctx["characters"],
                                 story_year=(ctx.get("terms") or {}).get("story_year"))
    reps = rep_mod.sort_repeats(pairs, names=ctx["names"], voices=ctx["voices"], motifs=ctx["motifs"],
                                labels=ctx["labels"])
    return timeline, reps


def protected_keep(engine, principal, pid, branch, text: str, *, except_keys=()) -> list[str]:
    """Exact words of voice/motif repeats in ``text`` — added to a rewrite's keep list (never raises)."""
    try:
        chs = book_texts(engine, principal, pid, branch)
        if not chs:
            return []
        ctx = _context(engine.store, pid, branch)
        _tl, reps = _run_all(chs, ctx)
        return rep_mod.protected_in(reps, text, except_keys=except_keys)
    except Exception:  # noqa: BLE001 - protection is help, never a reason to fail a rewrite
        log.exception("could not work out the protected repeats")
        return []


def editor_context(engine, principal, pid, branch, rec) -> dict:
    """``{"fact_checks": {...}}`` for the AI editor's context of a chapter, or {} (never raises)."""
    try:
        if rec.get("module_id") != "C02":
            return {}
        chs = book_texts(engine, principal, pid, branch)
        me = next((c for c in chs if c["record_id"] == rec["record_id"]), None)
        if me is None:
            return {}
        text = str((rec.get("data") or {}).get("text") or "")
        chs = [dict(c, text=text) if c is me else c for c in chs]
        ctx = _context(engine.store, pid, branch)
        timeline, reps = _run_all(chs, ctx)
        year = story_year_of(ctx, timeline)
        tc = terms_mod.check_text(text, terms_mod.items_of(ctx["terms"]), chapter=me["chapter_id"], story_year=year)
        here = rep_mod.for_chapter(reps, me["chapter_id"])
        out = {"note": EDITOR_NOTE, "timeline": tl_mod.brief(timeline, me["chapter_id"]),
               "terms": [{"check": f["check"], "severity": f["severity"], "detail": f["detail"][:200],
                          "where": f["passages"][0]["sentence"][:160] if f["passages"] else ""}
                         for f in tc["findings"]][:10],
               "repeats": {"keep": [{"phrase": r["phrase"][:60], "class": r["class"], "why": r["why"][:80]}
                                    for r in here["repeats"] if r["class"] in ("voice", "motif")][:10],
                           "may_trim": [{"phrase": r["phrase"][:60], "class": r["class"], "uses_to_trim": r["trim_here"]}
                                        for r in here["repeats"] if r["trim_here"]][:10]}}
        return {"fact_checks": out}
    except Exception:  # noqa: BLE001 - context is best effort
        log.exception("could not add the fact checks to the editor's context")
        return {}


# ====================================================================== the service
class FactChecker:
    """Chapter and book views, the AI jobs and the fixes, with this ReviewService's AIs."""

    def __init__(self, review):
        self.review = review
        self.engine, self.store = review.engine, review.store

    # ------------------------------------------------------------------ views
    def _chapter_rec(self, principal, pid, branch, rid):
        rec = self.review._head(pid, branch, rid)
        if rec is None or rec["module_id"] != "C02":
            raise BookforgeError("NOT_FOUND", "/record_id", "this chapter does not exist", status="REJECTED")
        chs = book_texts(self.engine, principal, pid, branch)
        me = next((c for c in chs if c["record_id"] == rid), None)
        if me is None:
            raise BookforgeError("INVALID_INPUT", "/record_id", "this chapter is not part of the approved outline",
                                 status="REJECTED")
        return rec, chs, me

    def chapter(self, principal, pid, branch, rid) -> dict:
        rec, chs, me = self._chapter_rec(principal, pid, branch, rid)
        ctx = _context(self.store, pid, branch)
        timeline, reps = _run_all(chs, ctx)
        year = story_year_of(ctx, timeline)
        items = terms_mod.items_of(ctx["terms"])
        tc = terms_mod.check_text(me["text"], items, chapter=me["chapter_id"], story_year=year)
        cands = terms_mod.scan(me["text"], items, story_year=year, texture_words=ctx["work_words"])
        here = rep_mod.for_chapter(reps, me["chapter_id"])
        fixable_terms = [f for f in tc["findings"] if f["check"] in ("term_wrong", "term_conflict")]
        return {"record_id": rid, "version": rec["version"], "chapter_id": me["chapter_id"], "number": me["number"],
                "story_year": year, "story_year_set": bool((ctx["terms"] or {}).get("story_year")),
                "timeline": {"findings": tl_mod.for_chapter(timeline, me["chapter_id"]),
                             "ages": {n: [r for r in rows if r["chapter"] == me["chapter_id"]]
                                      for n, rows in timeline["ages"].items()
                                      if any(r["chapter"] == me["chapter_id"] for r in rows)}},
                "terms": dict(tc, candidates=cands, version=int((ctx["terms"] or {}).get("version") or 0)),
                "repetition": dict(here, labels_version=ctx["labels_version"]),
                "fix": {"terms": len(fixable_terms), "repeats": here["counts"]["trim"]},
                "class_words": rep_mod.CLASS_WORDS, "status_words": terms_mod.STATUS_WORDS}

    def book(self, principal, pid, branch) -> dict:
        chs = book_texts(self.engine, principal, pid, branch)
        ctx = _context(self.store, pid, branch)
        timeline, reps = _run_all(chs, ctx) if chs else (tl_mod.check_book([]), rep_mod.sort_repeats([]))
        year = story_year_of(ctx, timeline)
        items = terms_mod.items_of(ctx["terms"])
        usage = {i["id"]: {"count": 0, "chapters": []} for i in items}
        flagged = []
        for c in chs:
            tc = terms_mod.check_text(c["text"], items, chapter=c["chapter_id"], story_year=year)
            for tid, n in tc["uses"].items():
                if n and tid in usage:
                    usage[tid]["count"] += n
                    usage[tid]["chapters"].append(c["number"])
            for f in tc["findings"]:
                if f["check"] != "term_unverified":
                    flagged.append({"chapter_id": c["chapter_id"], "number": c["number"], "record_id": c["record_id"],
                                    "check": f["check"], "severity": f["severity"], "detail": f["detail"][:200]})
        rows = [dict(i, uses=usage.get(i["id"], {}).get("count", 0), in_chapters=usage.get(i["id"], {}).get("chapters",
                                                                                                          []))
                for i in items]
        by_ch = {c["chapter_id"]: c for c in chs}
        repeats = []
        for r in reps["repeats"]:
            repeats.append(dict(r, occurrences=[dict(o, number=(by_ch.get(o["chapter"]) or {}).get("number"),
                                                     record_id=(by_ch.get(o["chapter"]) or {}).get("record_id"))
                                                for o in r["occurrences"][:6]]))
        for f in timeline["findings"]:
            for p in f["passages"]:
                c = by_ch.get(p.get("chapter"))
                if c:
                    p["number"], p["record_id"] = c["number"], c["record_id"]
        return {"chapters": len(chs), "story_year": year, "story_year_set": bool((ctx["terms"] or {}).get("story_year")),
                "timeline": timeline,
                "terms": {"items": rows, "version": int((ctx["terms"] or {}).get("version") or 0),
                          "counts": {s: sum(1 for i in items if i["status"] == s) for s in terms_mod.STATUSES},
                          "flagged": flagged[:40]},
                "repetition": {"repeats": repeats, "counts": reps["counts"], "labels": ctx["labels"],
                               "labels_version": ctx["labels_version"]},
                "fields": dict(terms_mod.field_info(), classes=[{"key": k, "label": rep_mod.CLASS_WORDS[k]}
                                                                for k in rep_mod.CLASSES])}

    # ------------------------------------------------------------------ author actions (no AI)
    def scan_terms(self, principal, pid, branch, rid=None) -> dict:
        """Add the terms BookForge finds (one chapter, or every chapter) as "research needed"."""
        chs = book_texts(self.engine, principal, pid, branch)
        if rid:
            chs = [c for c in chs if c["record_id"] == rid]
            if not chs:
                raise BookforgeError("NOT_FOUND", "/record_id", "this chapter is not part of the approved outline",
                                     status="REJECTED")
        ctx = _context(self.store, pid, branch)
        year = story_year_of(ctx)
        new, items = [], terms_mod.items_of(ctx["terms"])
        for c in chs[:RUN_SCAN_CHAPTERS]:
            for t in terms_mod.scan(c["text"], items + [{"term": n["term"]} for n in new], story_year=year,
                                    texture_words=ctx["work_words"]):
                new.append(t)
        e, added = terms_mod.add_terms(self.store, pid, branch, new, by="author", how="scan")
        return {"added": added, "entry": e}

    # ------------------------------------------------------------------ AI jobs
    def ai_find(self, job, rid) -> dict:
        pid, branch = job.project_id, job.branch_id
        rec, _chs, me = self._chapter_rec(job.principal, pid, branch, rid)
        rv = self.review
        rv.plan_reviewer(job, rv.writer_of(pid, branch, rec))  # another pair of eyes than the writer when possible
        ctx = _context(self.store, pid, branch)
        tok = rv.work.begin(pid, "C02", f"Listing the trade facts of chapter {me['number']}")
        try:
            new = terms_mod.ai_find(rv.assist, job, me["text"], ctx["terms"], story_year=story_year_of(ctx))
        finally:
            rv.work.end(tok)
        e, added = terms_mod.add_terms(self.store, pid, branch, new, by="ai", slot=job.slot, how="ai")
        return {"added": added, "found": len(new), "entry": e}

    def ai_research(self, job, ids=None) -> dict:
        pid, branch = job.project_id, job.branch_id
        entry = terms_mod.get_entry(self.store, pid, branch)
        chs = book_texts(self.engine, job.principal, pid, branch)
        where = {}
        for it in terms_mod.items_of(entry):
            rx = terms_mod._term_re(it.get("words"))
            for c in chs:
                for par in terms_mod.paragraphs(c["text"]):
                    m = rx.search(par) if rx else None
                    if m:
                        where[it["id"]] = terms_mod._sentence_at(par, m.start())
                        break
                if it["id"] in where:
                    break
        rv = self.review
        tok = rv.work.begin(pid, "C02", "Researching the trade facts")
        try:
            notes = terms_mod.ai_research(rv.assist, job, entry, ids, where=where)
        finally:
            rv.work.end(tok)
        from . import providers as providers_mod  # noqa: PLC0415
        slot = rv._slot(job.slot)
        e = terms_mod.set_ai_notes(self.store, pid, branch, notes, slot=job.slot,
                                   reviewer=providers_mod.slot_name(slot) if slot else job.slot)
        return {"answered": len(notes), "entry": e}

    # ------------------------------------------------------------------ ✨ fixes through the P5 rewrite machinery
    def pseudo_craft(self, principal, pid, branch, rid, kind: str) -> dict:
        rec, chs, me = self._chapter_rec(principal, pid, branch, rid)
        text = me["text"]
        ctx = _context(self.store, pid, branch)
        keys = set()
        if kind == "terms":
            timeline = tl_mod.check_book([(c["chapter_id"], c["text"]) for c in chs], names=ctx["names"])
            tc = terms_mod.check_text(text, terms_mod.items_of(ctx["terms"]), chapter=me["chapter_id"],
                                      story_year=story_year_of(ctx, timeline))
            findings, used = [], set()
            for f in tc["findings"]:
                if f["check"] not in ("term_wrong", "term_conflict", "term_anachronism"):
                    continue
                for p in f["passages"]:
                    s = p["sentence"][:300]
                    if not s or s in used or text.count(s) != 1 or len(findings) >= MAX_FIX_FINDINGS:
                        continue
                    used.add(s)
                    inst = f.get("use_instead") or ""
                    findings.append({"id": f"term{len(findings) + 1}", "dimension": "terminology", "severity": f["severity"],
                                     "label": f["label"], "passage": s, "why": f["detail"],
                                     "suggestion": f"Replace “{p['match']}” in this sentence"
                                                   + (f" (use: {inst})" if inst else "")
                                                   + "; keep the sentence's meaning and voice; never invent how "
                                                     "equipment works.", "keep_nearby": [], "found": True,
                                     "located": True})
        elif kind == "repeats":
            _tl, reps = _run_all(chs, ctx)
            findings, keys = rep_mod.findings_for(text, rep_mod.for_chapter(reps, me["chapter_id"]), MAX_FIX_FINDINGS)
        else:
            raise BookforgeError("INVALID_INPUT", "/kind", "kind: terms or repeats", status="REJECTED")
        return {"findings": findings, "keep": [], "version": rec["version"], "fact_fix": kind,
                "except_keys": sorted(keys)}

    def propose_fix(self, job, rid, kind: str) -> dict:
        pid, branch = job.project_id, job.branch_id
        craft = self.pseudo_craft(job.principal, pid, branch, rid, kind)
        if not craft["findings"]:
            raise BookforgeError("INVALID_INPUT", "/record_id", "nothing to fix in this version: no wrong terms"
                                 if kind == "terms" else "nothing to fix in this version: no accidental repeats to "
                                 "trim", status="REJECTED")
        return self.review.editor.propose(job, rid, craft=craft)


# ====================================================================== Make-a-book: the book-level report
def run_book_check(review, principal, pid, branch) -> dict:
    """After the chapters: add the terms found as research needed (never verified by a run), then count what is
    left to look at. Returns {timeline, terms_added, research_needed, wrong_used, conflicts, accidental, trim,
    notes: [(code, message)]}. Raises nothing the caller must handle except programming errors (caller catches)."""
    fc = FactChecker(review)
    chs = book_texts(review.engine, principal, pid, branch)
    if not chs:
        return {"chapters": 0, "notes": []}
    ctx = _context(review.store, pid, branch)
    year = story_year_of(ctx)
    new, items = [], terms_mod.items_of(ctx["terms"])
    for c in chs[:RUN_SCAN_CHAPTERS]:
        new += terms_mod.scan(c["text"], items + [{"term": n["term"]} for n in new], story_year=year,
                              texture_words=ctx["work_words"])
    _e, added = terms_mod.add_terms(review.store, pid, branch, [dict(n, added_by="run") for n in new], by="run",
                                    how="run")
    bk = fc.book(principal, pid, branch)
    tl = bk["timeline"]["summary"]
    flagged = bk["terms"]["flagged"]
    research = [i for i in bk["terms"]["items"] if i["status"] == "research_needed" and i["uses"]]
    rc = bk["repetition"]["counts"]
    out = {"chapters": len(chs), "timeline": {"major": tl["major"], "minor": tl["minor"]}, "terms_added": added,
           "research_needed": len(research), "wrong_used": sum(1 for f in flagged if f["check"] == "term_wrong"),
           "conflicts": sum(1 for f in flagged if f["check"] in ("term_conflict", "term_anachronism")),
           "accidental": rc.get("accident", 0), "trim": rc.get("trim", 0), "voice": rc.get("voice", 0),
           "motif": rc.get("motif", 0), "at": _now(), "notes": []}
    if tl["major"]:
        out["notes"].append(("TIMELINE_PROBLEMS", f"⚠️ Timeline: {tl['major']} place(s) where ages or years do not add "
                             "up — see 🔎 Fact checks on the book page"))
    if out["wrong_used"] or out["conflicts"]:
        out["notes"].append(("TERMS_WRONG", f"⚠️ Trade facts: {out['wrong_used'] + out['conflicts']} use(s) of a wrong "
                             "or out-of-place term (e.g. a wick on a gas lamp)"))
    if research:
        out["notes"].append(("TERMS_RESEARCH_NEEDED", f"⚠️ Trade facts: {len(research)} term(s) still need research "
                             "before you rely on them: " + ", ".join(i["term"] for i in research[:6])
                             + (" …" if len(research) > 6 else "")))
    if out["trim"]:
        out["notes"].append(("REPEATS_TO_TRIM", f"Repeats: {out['trim']} accidental or excess repeat(s) could be "
                             f"trimmed; {out['voice']} voice and {out['motif']} motif repeat(s) are kept"))
    return out


# ====================================================================== HTTP (under /review/facts …)
def route(rv, principal, pid, branch, rest: list, method: str, body: dict):
    """None when the path is not ours, else (status, payload)."""
    if not rest or rest[0] != "facts":
        return None
    rv._access(principal, pid, branch)
    fc = rv.facts
    sub = rest[1:]
    if sub == [] and method == "GET":
        return 200, fc.book(principal, pid, branch)
    if sub == ["terms"] and method == "PUT":
        items = terms_mod.clean_items(body.get("items"))
        year = terms_mod.clean_year(body.get("story_year")) if "story_year" in body else "keep"
        v = body.get("version")
        if v is not None and (not isinstance(v, int) or isinstance(v, bool)):
            raise BookforgeError("INVALID_INPUT", "/version", "version: the list version you edited",
                                 status="REJECTED")
        e = terms_mod.save(rv.store, pid, branch, items, by="author", base_version=v, story_year=year)
        return 200, {"ok": True, "entry": e}
    if sub == ["terms", "scan"] and method == "POST":
        return 200, fc.scan_terms(principal, pid, branch, body.get("record_id"))
    if sub == ["terms", "verify"] and method == "POST":
        e = terms_mod.decide(rv.store, pid, branch, ids=body.get("ids"), status=body.get("status"),
                             note=body.get("note") or "", use_instead=body.get("use_instead") or "",
                             version=body.get("version"), author_confirms=body.get("author_confirms"))
        return 200, {"ok": True, "entry": e}
    if sub == ["terms", "ai"] and method == "POST":
        return 202, rv.start_facts_job(principal, pid, branch, "facts_research", body.get("record_id"), body)
    if sub == ["repeats"] and method == "PUT":
        v = body.get("version")
        e = rep_mod.save_labels(rv.store, pid, branch, body.get("labels"),
                                base_version=v if isinstance(v, int) and not isinstance(v, bool) else None)
        return 200, {"ok": True, "entry": e}
    if len(sub) == 1 and method == "GET":
        return 200, fc.chapter(principal, pid, branch, sub[0])
    if len(sub) == 2 and sub[1] == "find" and method == "POST":
        return 202, rv.start_facts_job(principal, pid, branch, "facts_find", sub[0], body)
    if len(sub) == 2 and sub[1] == "fix" and method == "POST":
        kind = body.get("kind")
        if kind not in ("terms", "repeats"):
            raise BookforgeError("INVALID_INPUT", "/kind", "kind: terms or repeats", status="REJECTED")
        return 202, rv.start_facts_job(principal, pid, branch, f"facts_fix_{kind}", sub[0], body)
    return None
