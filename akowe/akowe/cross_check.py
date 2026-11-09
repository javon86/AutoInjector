"""🔎 How many AIs check for mistakes (PR #117): every working AI checks the book for consistency and drift.

Before, one AI read each continuity checkpoint and the ending check (often the writer itself), and one AI reviewed
each chapter. Now, with the run setting ``checkers`` ("How many AIs check for mistakes" on the Make-a-book screen):

* ``all`` (default) — every working AI (up to three, one per AI: two slots on the same website are the same AI);
* ``two`` — two of them;
* ``one`` — the old way: one AI.

Who checks what:

* **Continuity checkpoints** (checkpoints.py) and **the final ending check** (ending_check.py): each chosen AI reads
  the same brief independently, one after another (a busy, missing or timed-out AI is skipped with a note — the book
  never waits for it). Akọwe merges what they found (``merge``):

  - a problem two or more AIs report (same chapter, overlapping quote or problem words) is **confirmed** and fixed;
  - a problem only one AI reports must carry a quote that Akọwe finds in that chapter word for word, else it is
    **dropped** with a note; a verified one-AI problem is fixed only when that AI marked it major or blocker, else it
    is **listed for the author**;
  - one combined fix pass (not one per AI); the report shows who found what and how many agreed.

* **Each chapter's review** (autobook.py ``_review_until_approved``): the two AIs that did NOT write the chapter review
  it independently (``second_review``). "Changes needed" from either one sends it back through the usual fix loop
  (the same number of rounds); it is approved only when neither objects. With only one AI besides the writer working,
  one reviewer reads it as before (said in the run).

Cost (plain): per chapter one more review answer per review round; per checkpoint part and for the ending check, one
answer per checking AI (×2 or ×3). "One (old way)" costs what it did before.
"""
from __future__ import annotations

import copy
import logging
import re

from . import providers as providers_mod

log = logging.getLogger("akowe.cross_check")

CHOICES = ("all", "two", "one")
DEFAULT = "all"
LIMIT = {"all": 3, "two": 2, "one": 1}
WORDS = {"all": "All working AIs (recommended)", "two": "Two AIs", "one": "One AI (the old way)"}
HELP = ("How many AIs look for mistakes, contradictions and drift (characters changing, a healed injury coming back, "
        "names, dates, tone) in each chapter, at each checkpoint and at the end. More AIs catch more, and a problem "
        "two AIs agree on is fixed with more confidence — but every extra AI costs more AI time: about one more AI "
        "answer per chapter, and one more per checkpoint for each AI.")
SEVERITIES = ("minor", "major", "blocker")


def clean(v):
    """The run setting: ``all`` / ``two`` / ``one``; None or "" = the default. False when not valid."""
    if v in (None, ""):
        return None
    return v if v in CHOICES else False


def setting_of(run: dict | None) -> str:
    v = ((run or {}).get("settings") or {}).get("checkers")
    return v if v in CHOICES else DEFAULT


def _base(prov):
    return getattr(prov, "_base", prov)


def _slot(prov, sid):
    return next((s for s in prov.slots() if s["slot_id"] == sid), None) if sid else None


def name_of(prov, sid) -> str:
    """The AI's everyday name ("Claude", "ChatGPT"), or the slot id."""
    from .approval_trust import ai_word  # noqa: PLC0415
    s = _slot(prov, sid)
    return ai_word(s) if s else str(sid or "the AI")


def working(svc, run: dict, *, needed: int = 4000) -> list[dict]:
    """The AIs that can take a check right now (healthy, connected, not being repaired, not busy), one slot per AI
    family, in the registry's own order. Never raises."""
    try:
        prov = _base(svc.app.engine.providers)
        elig = prov.eligible(run["project_id"], "text", needed, None)
    except Exception:  # noqa: BLE001 - who checks is a choice; never break the book over it
        log.exception("could not list the working AIs")
        return []
    out, fams = [], set()
    for s in elig:
        fam = providers_mod.slot_family(s) or s["slot_id"]
        if fam in fams:
            continue
        fams.add(fam)
        out.append(s)
    return out


def policy_of(svc, run: dict | None) -> dict:
    """🔢 The checker order setting of this run (checker_order.py): the run's own, else Settings › AI."""
    from . import checker_order  # noqa: PLC0415
    try:
        return checker_order.of_run(run, getattr(svc, "store", None))
    except Exception:  # noqa: BLE001
        return dict(checker_order.DEFAULT)


def checker_slots(svc, run: dict, *, writer: str | None = None, needed: int = 4000) -> list[str]:
    """The AIs that check (slot ids), the writer's AI last. ``[]`` means "the old way": the setting is One, or fewer
    than two AIs work right now (the caller then uses its one AI exactly as before). 🔢 In the order the checker order
    setting asks for (best track record first / the author's own order); an AI switched off for checks never checks."""
    from . import checker_order  # noqa: PLC0415
    n = LIMIT.get(setting_of(run), 3)
    if n < 2:
        return []
    pol = policy_of(svc, run)
    try:
        prov = _base(svc.app.engine.providers)
        wfam = providers_mod.slot_family(_slot(prov, writer)) if writer else None
    except Exception:  # noqa: BLE001
        wfam = None
    ws = working(svc, run, needed=needed)
    allowed = [s for s in ws if not checker_order.is_off(pol, providers_mod.slot_family(s) or s["slot_id"])]
    if len(allowed) < len(ws):
        note_shortfall(svc, run, ws, pol, wfam, n)
    if len(allowed) < 2:
        return []
    others, _how = checker_order.order_slots(getattr(svc, "store", None), pol, [s for s in allowed
                                                             if providers_mod.slot_family(s) != wfam])
    ordered = others + [s for s in allowed if wfam and providers_mod.slot_family(s) == wfam]
    return [s["slot_id"] for s in ordered[:n]]


def note_reviewers(svc, run: dict, review: dict, two: bool) -> None:
    """🔢 After a record's review in a run: when AIs switched off for checks leave fewer reviewers than wanted (two for a
    chapter with "All"/"Two", else one besides the writer), say so once in plain words. Never raises."""
    try:
        pol = policy_of(svc, run)
        if not pol.get("off"):
            return
        prov = _base(svc.app.engine.providers)
        wfam = providers_mod.slot_family(_slot(prov, review.get("writer_slot"))) if review.get("writer_slot") else None
        note_shortfall(svc, run, working(svc, run), pol, wfam, 3 if two else 2)
    except Exception:  # noqa: BLE001
        log.debug("could not check the reviewers against the checker order", exc_info=True)


def note_shortfall(svc, run: dict | None, ws: list[dict], pol: dict, wfam: str | None, want: int) -> None:
    """🔢 Say once per run, in plain words, when switching AIs off for checks leaves fewer checkers than wanted."""
    from . import checker_order  # noqa: PLC0415
    if not run:
        return
    try:
        prov = _base(svc.app.engine.providers)
        fams_work = [providers_mod.slot_family(s) or s["slot_id"] for s in ws]
        fams_all = list(dict.fromkeys(providers_mod.slot_family(s) or s["slot_id"] for s in prov.ai_slots()))
        can = [f for f in fams_work if f != wfam and not checker_order.is_off(pol, f)]
        off = [f for f in pol.get("off") or [] if f in fams_all]
        down = [f for f in fams_all if f not in fams_work and f != wfam and not checker_order.is_off(pol, f)]
        line = checker_order.shortfall_line(can=can, off=off, writer=wfam, down=down, want=max(1, want - 1))
    except Exception:  # noqa: BLE001
        log.debug("could not word the checker shortfall", exc_info=True)
        return
    if not line:
        return
    said = run.setdefault("checker_notes", [])
    if line in said:
        return
    said.append(line)
    run["checker_shortfall"] = line
    try:
        svc.event(run, "note", "🔢 " + line, code="CHECKERS_SHORT")
    except Exception:  # noqa: BLE001
        log.debug("could not note the checker shortfall", exc_info=True)


# ====================================================================== merging what the AIs found (no AI)
def _norm(s) -> str:
    from .calibration import norm  # noqa: PLC0415
    return norm(s)


_STOP = {"the", "and", "that", "this", "with", "from", "they", "their", "there", "was", "were", "has", "have", "had",
         "her", "his", "she", "him", "but", "not", "are", "for", "into", "than", "then", "when", "what", "which",
         "chapter", "later", "earlier", "again", "still", "says", "said"}


def _words(s: str) -> set[str]:
    return {w for w in re.findall(r"[a-zà-ÿ']+", _norm(s)) if len(w) > 3 and w not in _STOP}


def quote_in(quote: str, text: str) -> bool:
    """Is the quote in the text word for word (curly quotes, dashes and spacing ignored; "…" may join parts)?"""
    from .book_report import verify_quote  # noqa: PLC0415
    return bool(quote) and verify_quote(quote, _norm(text))


def same_problem(a: dict, b: dict) -> bool:
    """Do two AIs report the same problem? Same chapter, and their quotes overlap (one inside the other, or five
    words in a row in common), or their problem sentences share most of their meaningful words."""
    if a.get("chapter_id") != b.get("chapter_id"):
        return False
    qa, qb = _norm(a.get("quote")).strip(' ."'), _norm(b.get("quote")).strip(' ."')
    if len(qa) >= 8 and len(qb) >= 8:
        if qa in qb or qb in qa:
            return True
        wa, wb = qa.split(), qb.split()
        grams = {tuple(wa[i:i + 5]) for i in range(len(wa) - 4)}
        if any(tuple(wb[i:i + 5]) in grams for i in range(len(wb) - 4)):
            return True
    pa, pb = _words(a.get("problem")), _words(b.get("problem"))
    if pa and pb:
        common = len(pa & pb)
        if common >= 3 and common / min(len(pa), len(pb)) >= 0.5:
            return True
    return False


def merge(per_ai: list[dict], texts: dict) -> list[dict]:
    """Merge the problems several AIs reported for the same chapters. ``per_ai``: [{slot, name, problems: [{chapter_id,
    number, quote, problem, original, replacement, severity?}]}] in checking order; ``texts``: chapter_id -> its
    current text. Returns the merged problems, each with ``found_by`` (names), ``slots``, ``agree`` (how many AIs),
    ``of`` (how many AIs read it), ``agreement`` (confirmed | one_ai), ``verified`` (the quote is in the chapter) and
    ``plan``: fix (confirmed, or one AI + verified + major/blocker) | listed (one AI, verified, minor: for the author)
    | dropped (one AI, quote not in the chapter)."""
    groups: list[dict] = []
    of = len(per_ai)
    for ai in per_ai:
        for p in ai.get("problems") or []:
            g = next((g for g in groups if ai["slot"] not in g["slots"] and same_problem(g["first"], p)), None)
            if g is None:
                g = {"first": p, "items": [], "slots": [], "found_by": []}
                groups.append(g)
            g["items"].append(dict(p, by=ai["name"], slot=ai["slot"]))
            g["slots"].append(ai["slot"])
            g["found_by"].append(ai["name"])
    out = []
    for g in groups:
        items = g["items"]
        base = copy.deepcopy(g["first"])
        text = texts.get(base.get("chapter_id")) or ""
        # the fix: the first one whose words are in the chapter exactly once
        fix = next((x for x in items if (x.get("original") or "").strip() and (x.get("replacement") or "").strip()
                    and text.count(x["original"]) == 1), None) or next(
            (x for x in items if (x.get("original") or "").strip() and (x.get("replacement") or "").strip()), None)
        if fix:
            base["original"], base["replacement"] = fix["original"], fix["replacement"]
        quote = next((x["quote"] for x in items if x.get("quote") and quote_in(x["quote"], text)), None)
        if quote:
            base["quote"] = quote
        sev = max((SEVERITIES.index(x.get("severity")) for x in items if x.get("severity") in SEVERITIES), default=0)
        base["severity"] = SEVERITIES[sev]
        verified = bool(quote)
        agree = len(set(g["slots"]))
        if agree >= 2:
            plan, why = "fix", ""
        elif not verified:
            plan = "dropped"
            why = (f"only {g['found_by'][0]} reported this and its quote is not in the chapter word for word, so "
                   "Akọwe did not use it")
        elif SEVERITIES[sev] in ("major", "blocker"):
            plan, why = "fix", ""
        else:
            plan = "listed"
            why = f"only {g['found_by'][0]} found this (a small problem): listed for you, not changed"
        base.update(found_by=list(dict.fromkeys(g["found_by"])), slots=list(dict.fromkeys(g["slots"])), agree=agree,
                    of=of, agreement="confirmed" if agree >= 2 else "one_ai", verified=verified, plan=plan)
        if why:
            base["plan_why"] = why
        base.pop("by", None)
        base.pop("slot", None)
        out.append(base)
    return out


def who_line(p: dict) -> str:
    """"found by Claude and Gemini (2 of 3 agree)" / "found by ChatGPT only" — for the report."""
    names = p.get("found_by") or []
    if not names:
        return ""
    if len(names) == 1:
        return f"found by {names[0]} only" + (f" (of {p['of']} AIs that read it)" if (p.get("of") or 0) > 1 else "")
    return f"found by {' and '.join(names)} ({len(names)} of {p.get('of') or len(names)} agree)"


def agreement_line(problems: list[dict], checkers: list[str]) -> str:
    """One plain line about who checked and how far they agreed."""
    if len(checkers) < 2:
        return ""
    conf = sum(1 for p in problems if p.get("agreement") == "confirmed")
    one = sum(1 for p in problems if p.get("agreement") == "one_ai")
    drop = sum(1 for p in problems if p.get("plan") == "dropped")
    return (f"Checked by {', '.join(checkers[:-1])} and {checkers[-1]}: {conf} problem(s) confirmed by 2 or more, "
            f"{one} found by one AI only" + (f" ({drop} dropped: quote not in the book)" if drop else "") + ".")


# ====================================================================== two reviewers per chapter
def _row(rv: dict, name: str) -> dict:
    return {"slot": rv.get("slot"), "name": name, "verdict": rv.get("verdict"),
            "confidence": rv.get("confidence"), "reasons": list(rv.get("reasons") or [])[:4]}


def combine(first: dict, second: dict, n1: str, n2: str) -> dict:
    """One review from two: "changes needed" from either is changes needed (the stricter verdict), with both
    reviewers' reasons; both APPROVE -> APPROVE (with the higher confidence: two independent yeses)."""
    order = {"APPROVE": 0, "REVISE": 1, "REJECT": 2}
    out = copy.deepcopy(first)
    v1, v2 = first.get("verdict"), second.get("verdict")
    worst = v1 if order.get(v1, 0) >= order.get(v2, 0) else v2
    out["verdict"] = worst

    def tag(name, xs):
        return [f"{name}: {x}" for x in xs or []]
    if worst == "APPROVE":
        out["reasons"] = (list(first.get("reasons") or []) + tag(n2, second.get("reasons")))[:8]
        cs = [c for c in (first.get("confidence"), second.get("confidence")) if isinstance(c, (int, float))]
        out["confidence"] = max(cs) if cs else first.get("confidence")
    else:
        objecting = [(n, r) for n, r in ((n1, first), (n2, second)) if r.get("verdict") != "APPROVE"]
        rs, sc = [], []
        for n, r in objecting:
            rs += tag(n, r.get("reasons"))
            sc += tag(n, r.get("suggested_changes"))
        out["reasons"] = rs[:8]
        out["suggested_changes"] = sc[:8]
        cs = [r.get("confidence") for _n, r in objecting if isinstance(r.get("confidence"), (int, float))]
        out["confidence"] = max(cs) if cs else first.get("confidence")
    if second.get("content_limits_breach") and not out.get("content_limits_breach"):
        out["content_limits_breach"] = second["content_limits_breach"]
    out["reviewers"] = [_row(first, n1), _row(second, n2)]
    out["reviewer"] = f"{first.get('reviewer') or n1} + {second.get('reviewer') or n2}"
    out["independent"] = bool(first.get("independent", True)) and bool(second.get("independent", True))
    out["two_reviewers"] = True
    return out


def second_slot(svc, run: dict, first: dict) -> str | None:
    """A working AI that neither wrote the chapter nor gave the first review (another AI family). None when there is
    none right now (never waits)."""
    if setting_of(run) == "one" or first.get("independent") is False:
        return None
    from . import checker_order  # noqa: PLC0415
    try:
        prov = _base(svc.app.engine.providers)
        bad = {providers_mod.slot_family(_slot(prov, x)) for x in (first.get("writer_slot"), first.get("slot")) if x}
        bad.discard(None)
        pol = policy_of(svc, run)
        cand = [s for s in working(svc, run)
                if s["slot_id"] not in (first.get("writer_slot"), first.get("slot"))
                and providers_mod.slot_family(s) not in bad]
        ordered, _how = checker_order.order_slots(getattr(svc, "store", None), pol, cand)  # 🔢 switched-off AIs never check
        if ordered:
            return ordered[0]["slot_id"]
    except Exception:  # noqa: BLE001
        log.exception("could not look for a second reviewer")
    return None


def second_review(svc, run: dict, rj, rid: str, res: dict, label: str, *, auto: bool) -> dict:
    """After the first review of a chapter: the second AI that did not write it reviews it too (its own call) and the
    two verdicts are combined and stored as the review of this version. ``auto``: whether the author's standing
    auto-approve may approve it now (only when the run has no editor step next). Never raises for an AI problem
    (one reviewer is kept, with a note); a pause / cancel still stops."""
    from .errors import AkoweError  # noqa: PLC0415
    from .review import ReviewJob, _rkey  # noqa: PLC0415
    review = svc._review  # noqa: SLF001
    first = res.get("review") or {}
    pid, branch = run["project_id"], run["branch_id"]
    other = second_slot(svc, run, first) if first.get("verdict") in ("APPROVE", "REVISE", "REJECT") else None
    if other is None:
        if setting_of(run) != "one" and first.get("independent") is not False and not run.get("one_reviewer_noted"):
            run["one_reviewer_noted"] = True
            svc.event(run, "note", f"Only one AI other than the writer works right now, so one AI reviews the "
                      f"{label} (two review it when another AI works)", code="ONE_REVIEWER")
        return _auto(review, run, rid, res, first) if auto else res
    job = ReviewJob("review", run["principal"], pid, branch, [rid], other)
    for k in ("started", "status", "check", "on_wait"):
        setattr(job, k, getattr(rj, k))
    job.retry_busy, job.cross_pin = False, True
    try:
        from . import ai_activity  # noqa: PLC0415 - ⚡ #116 the AI activity strip
        what = ai_activity.nice(label)
        with ai_activity.doing(f"Second review of {what}", done=f"Second review of {what}: done"):
            res2 = review.review_one(job, rid, auto=False)
    except AkoweError as exc:
        if getattr(exc, "control", False):
            raise
        name = name_of(svc.app.engine.providers, other)
        svc.event(run, "note", f"⚠️ The second reviewer ({name}) could not read the {label} ({exc.code}); the first "
                  "reviewer's verdict counts", code="SECOND_REVIEW_FAILED")
        try:  # the first review stays the stored one for this version
            rec = review._head(pid, branch, rid)  # noqa: SLF001
            review._put(f"ai_reviews:{pid}:{branch}", _rkey(rid, rec["version"]), first)  # noqa: SLF001
        except Exception:  # noqa: BLE001
            log.exception("could not keep the first review")
        return _auto(review, run, rid, res, first) if auto else res
    second = res2.get("review") or {}
    prov = svc.app.engine.providers
    n1, n2 = name_of(prov, first.get("slot")), name_of(prov, second.get("slot"))
    svc.event(run, "review", f"Second AI review of the {label}: {second.get('verdict')} ({n2})",
              verdict=second.get("verdict"), slot=second.get("slot"), record_id=rid, code="SECOND_REVIEW")
    both = combine(first, second, n1, n2)
    from . import approval_trust  # noqa: PLC0415
    trust = approval_trust.problem(both, "chapter", both.get("writer_ai"))
    both.pop("trust_problem", None)
    if trust:
        both["trust_problem"] = trust
    rec = review._head(pid, branch, rid)  # noqa: SLF001
    review._put(f"ai_reviews:{pid}:{branch}", _rkey(rid, rec["version"]), both)  # noqa: SLF001
    out = dict(res, review=both, auto_approved=False)
    return _auto(review, run, rid, out, both) if auto else out


def _auto(review, run, rid, res: dict, rv: dict) -> dict:
    """The author's standing auto-approve, after the review(s) (review.maybe_auto_approve: APPROVE only)."""
    pid, branch = run["project_id"], run["branch_id"]
    rec = review._head(pid, branch, rid)  # noqa: SLF001
    if rec is None:
        return res
    a = review.maybe_auto_approve(run["principal"], pid, branch, rec, rv)
    if a is not None:
        res = dict(res, auto_approved=bool(a.get("ok")), auto_approve=a)
    return res
