"""🔁 PR #117 (F): a writing habit two or more of Akọwe's checks flag is a MUST-FIX for the editor.

Three checks look at a chapter's habits: the pattern check (prose_audit.py, no AI), the originality check
(originality.py, no AI — with its own thresholds, also for the pattern counts it borrows) and the AI editor's findings.
A habit (a "family" below — e.g. "Not X. Not Y." lines) that 2 or more of them flag used to survive the editor when the
editor itself did not pick it. Now:

* ``must_fix(text, report, findings)`` — the habits 2+ checks flag, each with how often it occurs, who flagged it and
  exact example sentences from the chapter;
* the editor gets them as required targets (``context.must_fix``); a habit it did not turn into a finding becomes a
  major finding from Akọwe's own example, so the writer's rewrite goes after it (editor.py ``craft_one``);
* ``remaining(text, families)`` — after the editor's rounds, how many of each are still in the chapter (the run's
  editor line and the report say "2 must-fix habits, 1 still there").
"""
from __future__ import annotations

import logging
import re

log = logging.getLogger("akowe.habits")

# family -> (plain label, pattern-check checks, originality checks, words that name it in an editor finding)
FAMILIES = {
    "not_x_not_y": ("“Not X. Not Y.” / “It wasn’t X. It was Y.” lines", ("not_parallel",),
                    ("not_parallel", "not_this_but_that"),
                    r"\bnot x\b|\bnot\b[^.]{0,30}\.\s*not\b|negative parallel|negation|it wasn.t|was not \w+[.,] it was|"
                    r"listing what it is not|what (?:it|something) is not|“not"),
    "triad": ("Lists of three", ("triad",), ("triad",), r"list(?:s)? of three|triad|rule of three|three (?:adjectives|"
                                                         r"items|things) in a row"),
    "moral_ending": ("Paragraphs ending on a big abstract line", ("moral_ending",), ("moral_ending",),
                     r"moral|aphoris|abstract (?:line|ending|statement)|sums? (?:it )?up|tells the reader what to feel"),
    "stock_phrase": ("Stock phrases and clichés", ("gesture",), ("ai_phrase", "cliche"),
                     r"clich|stock (?:phrase|gesture|image)|machine|ai-sounding|generic|overused (?:phrase|gesture)"),
    "same_opening": ("Sentences that start the same way", ("same_opening",), (),
                     r"same (?:word|opening)|start(?:s|ing)? (?:with )?the same|repetitive openings"),
    "dashes": ("Long dashes everywhere", (), ("em_dash",), r"\bdash(?:es)?\b"),
    "rhetorical": ("Paragraphs that open with a question", (), ("rhetorical_question",), r"rhetorical"),
    "rhythm": ("Sentences all the same length", ("uniform_length",), (), r"same length|monotonous|sentence rhythm|"
                                                                         r"rhythm is flat"),
}
FLAGGED = ("minor", "major")
MAX_EXAMPLES = 3

ASK = ("context.must_fix lists writing habits that two or more of Akọwe's checks flagged in this chapter (with how often "
       "and exact examples). They MUST be fixed: give at least one finding (severity major) for each, quoting its "
       "worst example exactly, with a suggestion that removes the habit, not just rewords it.")


def _sentences_with(text: str, rx: re.Pattern, limit: int = MAX_EXAMPLES) -> list[str]:
    out = []
    for m in re.finditer(r"[^.!?\n]+[.!?]+(?:\s+[^.!?\n]+[.!?]+)?", text or ""):
        s = m.group(0).strip()
        if rx.search(s) and s not in out and len(s) >= 8:
            out.append(s[:200])
            if len(out) >= limit:
                break
    return out


_NOT_X = re.compile(r"(?:^|[.!?]\s+)Not\b[^.!?]{0,60}[.!?]\s+(?:Not|Never|No)\b|\bwasn.t\b[^.!?]{0,60}[.!?]\s+(?:It|He|"
                    r"She|They) was\b|\bnot\b[^.;!?]{1,60}?,\s*(?:and\s+|but\s+)?not\b")


def _reports(text: str, report: dict | None) -> tuple[dict, dict]:
    from . import originality, prose_audit  # noqa: PLC0415
    pa = report if isinstance(report, dict) else prose_audit.audit(text or "")
    try:
        og = originality.check([(None, text or "")], borrowed=True)
    except Exception:  # noqa: BLE001 - a hint, never a reason to fail the editor
        log.exception("originality check failed for the must-fix list")
        og = {"checks": [], "findings": []}
    return pa, og


def must_fix(text: str, report: dict | None = None, findings: list | None = None) -> list[dict]:
    """The habits 2+ checks flag in this text: [{habit, label, count, flagged_by, examples}] (examples are exact
    sentences of the text). Never raises."""
    try:
        pa, og = _reports(text, report)
    except Exception:  # noqa: BLE001
        log.exception("could not build the must-fix list")
        return []
    pa_f = {f.get("check"): f for f in pa.get("findings") or []}
    og_c = {c.get("check"): c for c in og.get("checks") or []}
    out = []
    for fam, (label, pchecks, ochecks, ed_rx) in FAMILIES.items():
        by, count, examples = [], 0, []
        hits = [pa_f[c] for c in pchecks if c in pa_f and pa_f[c].get("severity") in FLAGGED]
        if hits:
            by.append("pattern check")
            count = max(count, max(int(h.get("count") or 0) for h in hits))
            for h in hits:
                for p in h.get("passages") or []:
                    ex = str(p.get("excerpt") or "").strip("…").strip()
                    if len(ex) >= 12 and ex in (text or "") and ex not in examples:
                        examples.append(ex)
        ohits = [og_c[c] for c in ochecks if c in og_c and og_c[c].get("severity") in FLAGGED]
        if ohits:
            by.append("originality check")
            count = max(count, max(int(h.get("count") or 0) for h in ohits))
            for f in og.get("findings") or []:
                q = str(f.get("quote") or "").strip()
                if f.get("check") in ochecks and len(q) >= 8 and q in (text or "") and q not in examples:
                    examples.append(q)
        rx = re.compile(ed_rx, re.I)
        if any(rx.search(" ".join(str(f.get(k) or "") for k in ("label", "why", "suggestion")))
               for f in findings or [] if isinstance(f, dict) and f.get("source") != "must_fix"):
            by.append("editor")
        if len(by) < 2:
            continue
        if fam == "not_x_not_y":
            examples = _sentences_with(text, _NOT_X) + [e for e in examples if e not in _sentences_with(text, _NOT_X)]
        out.append({"habit": fam, "label": label, "count": count, "flagged_by": by,
                    "examples": [e for e in examples if e in (text or "")][:MAX_EXAMPLES]})
    return out


def count_of(text: str, habit: str, report: dict | None = None) -> int:
    """How many times a habit is in the text now (the highest of the pattern and originality counts)."""
    try:
        pa, og = _reports(text, report)
    except Exception:  # noqa: BLE001
        return 0
    fam = FAMILIES.get(habit)
    if not fam:
        return 0
    _label, pchecks, ochecks, _rx = fam
    n = [int(f.get("count") or 0) for f in pa.get("findings") or [] if f.get("check") in pchecks]
    n += [int(c.get("count") or 0) for c in og.get("checks") or [] if c.get("check") in ochecks]
    return max(n, default=0)


def remaining(text: str, targets: list[dict]) -> dict:
    """After the editor: {targets, remained, items: [{habit, label, before, after, still}]} — a habit "still" there
    when 2+ checks still flag it (the must-fix test again on the new text)."""
    now = {m["habit"]: m for m in must_fix(text)}
    items = []
    for t in targets or []:
        after = count_of(text, t["habit"])
        items.append({"habit": t["habit"], "label": t.get("label"), "before": t.get("count"), "after": after,
                      "still": t["habit"] in now})
    return {"targets": len(items), "remained": sum(1 for i in items if i["still"]), "items": items}


def findings_for(must: list[dict], findings: list[dict], dims: list[str]) -> list[dict]:
    """Major findings (the editor's format) for every must-fix habit the editor's own findings do not cover, from
    Akọwe's exact example sentence (a habit with no exact example cannot be targeted and is skipped)."""
    out = []
    for m in must:
        rx = re.compile(FAMILIES[m["habit"]][3], re.I)
        covered = any(rx.search(" ".join(str(f.get(k) or "") for k in ("label", "why", "suggestion")))
                      or any(ex and ex in str(f.get("passage") or "") or str(f.get("passage") or "") in ex
                             for ex in m.get("examples") or [] if f.get("passage"))
                      for f in findings or [])
        if covered or not m.get("examples"):
            continue
        dim = "prose_variety" if "prose_variety" in dims else (dims[0] if dims else "other")
        out.append({"id": f"h{len(out) + 1}", "dimension": dim, "severity": "major", "passage": m["examples"][0][:200],
                    "why": f"Must fix: {m['label']} — {m['count']}× in this chapter, flagged by "
                           f"{' and '.join(m['flagged_by'])}."[:500],
                    "suggestion": "Remove the habit here: say what it is plainly, with one concrete detail.",
                    "keep_nearby": [], "found": True, "located": True, "source": "must_fix", "habit": m["habit"]})
    return out
