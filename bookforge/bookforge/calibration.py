"""🎯 P36 A tougher, calibrated AI editor: distrust near-perfect reviews, two reviewers, and each AI's leniency.

Why: in the second book Gemini, as the editor, passed every chapter and gave 10/10 on most points while ChatGPT's own
review gave 7-8 and found real flaws, so the editor's rewrite loop never ran. This module holds the pure rules that
editor.py applies to every craft review (all deterministic, unit-tested, no AI calls here):

* **Is this review trustworthy?** (``assess``) A score of 9 or 10 counts only with evidence: a ``score_evidence``
  item for that dimension whose quote is in the draft (whitespace and quote marks normalised). A review is "too clean"
  when its average is near-perfect (``NEAR_PERFECT_AVG`` 8.5 or more) and it has fewer than ``MIN_FINDINGS`` (3)
  findings that quote the draft, or no weakest passage that quotes the draft. Either makes the review untrusted.
* **What BookForge does with an untrusted review** (editor.py): it asks the same AI ONCE more with the stricter
  ``editor_rubric.STRICT_REASK``. Still untrusted -> the review is flagged ⚠️ and ``apply_caps`` counts every
  unproven 9/10 as ``CAP`` (7); a too-clean review has ALL its scores capped at 7. When the flagged review has nothing
  to rewrite, BookForge adds up to 3 notes from its own pattern check (``audit_findings``) and the verdict is REVISE
  whenever there is at least one note to work on — so the rewrite loop can still run.
* **Two reviewers** (``merge``): when a second AI works that is neither the writer nor the first reviewer, both read
  the draft; BookForge takes the LOWER score per dimension and the notes of both (duplicates by passage removed).
* **Leniency over time** (settings key ``reviewer_leniency``, companion data like the editor's notes): per AI family
  (ChatGPT / Claude / Gemini / an API slot) BookForge keeps how far its scores sit above (+) or below (−) the other
  reviewer of the same draft, and how far they sit above the ceiling that BookForge's own pattern check allows
  (``AUDIT_DIMS``: a major pattern finding caps that dimension at 6, a minor one at 8). ``leniency`` is the mean of
  those gaps. After ``MIN_OBS`` (3) observations an AI whose leniency is ``LENIENT_AT`` (1.0) or more gets its scores
  lowered by ``discount`` = floor(leniency), at most ``MAX_DISCOUNT`` (2), before they are merged.

Only numbers and dimension keys are stored for leniency, never text.
"""
from __future__ import annotations

import logging
import re
import threading
from datetime import datetime, timezone

log = logging.getLogger("bookforge.calibration")

HIGH = 9                  # a score this high needs a quoted piece of evidence
NEAR_PERFECT_AVG = 8.5    # an average at or above this with too few findings is "too clean"
MIN_FINDINGS = 3          # the editor must name at least this many concrete, quoted problems
CAP = 7                   # what an unproven 9/10 (or every score of a too-clean review) counts as
MIN_OBS = 3               # leniency observations before an AI's scores are discounted
LENIENT_AT = 1.0          # leniency (points) from which an AI is discounted
MAX_DISCOUNT = 2          # never lower a lenient AI's scores by more than this
MAX_RECENT = 20
MAX_AUDIT_NOTES = 3
KEY = "reviewer_leniency"

# P6 pattern checks -> the editor dimension they bound (a major finding: at most 6; a minor one: at most 8)
AUDIT_DIMS = {"gesture": "prose_variety", "not_parallel": "prose_variety", "triad": "prose_variety",
              "said_bookism": "prose_variety", "uniform_length": "prose_variety", "same_opening": "prose_variety",
              "overused_word": "prose_variety", "watch_word": "prose_variety", "moral_ending": "theme_restraint",
              "named_emotion": "subtext", "reassurance": "tension_stakes", "voice_sameness": "voice_distinction",
              "voice_never_word": "voice_distinction"}
AUDIT_CEILING = {"major": 6, "minor": 8}

_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def norm(s) -> str:
    """Text for quote matching: curly quotes and dashes made plain, whitespace collapsed, lower case."""
    s = str(s or "")
    for a, b in (("“", '"'), ("”", '"'), ("‘", "'"), ("’", "'"), ("—", "-"), ("–", "-"), ("…", "...")):
        s = s.replace(a, b)
    return re.sub(r"\s+", " ", s).strip().lower()


def quoted(quote, text_norm: str) -> bool:
    """Is ``quote`` (at least 8 characters, ellipses and outer quote marks removed) in the normalised draft?"""
    q = norm(quote).strip(" \"'.")
    parts = [p.strip(" \"'") for p in q.split("...") if len(p.strip(" \"'")) >= 8]
    return bool(parts) and all(p in text_norm for p in parts)


# ====================================================================== one review: trustworthy?
def evidence_of(raw, dims, text_norm: str) -> dict:
    """{dimension: quote} for every score_evidence item whose quote is really in the draft."""
    out = {}
    for e in (raw.get("score_evidence") if isinstance(raw, dict) else None) or []:
        if not isinstance(e, dict) or e.get("dimension") not in dims or e["dimension"] in out:
            continue
        if quoted(e.get("quote"), text_norm):
            out[e["dimension"]] = " ".join(str(e.get("quote") or "").split())[:200]
    return out


def weakest_of(raw, text_norm: str) -> list[dict]:
    """The weakest passages the editor named: [{passage, why, found}] (at most 5)."""
    out = []
    for w in (raw.get("weakest") if isinstance(raw, dict) else None) or []:
        if isinstance(w, str):
            w = {"passage": w}
        if not isinstance(w, dict) or not str(w.get("passage") or "").strip():
            continue
        p = " ".join(str(w["passage"]).split())[:200]
        out.append({"passage": p, "why": " ".join(str(w.get("why") or "").split())[:300],
                    "found": quoted(p, text_norm)})
        if len(out) >= 5:
            break
    return out


def audit_ceilings(report: dict | None) -> dict:
    """{editor dimension: highest believable score} from BookForge's own pattern report (P6)."""
    out: dict = {}
    for f in (report or {}).get("findings") or []:
        dim = AUDIT_DIMS.get(f.get("check"))
        ceil = AUDIT_CEILING.get(f.get("severity"))
        if dim and ceil:
            out[dim] = min(out.get(dim, 10), ceil)
    return out


def audit_gap(scores: dict, ceilings: dict) -> tuple[float | None, list[str]]:
    """How far the scores sit above the pattern check's ceilings (mean over the bounded dimensions; None: none)."""
    gaps, over = [], []
    for d, c in ceilings.items():
        if isinstance(scores.get(d), int):
            g = max(0, scores[d] - c)
            gaps.append(g)
            if g:
                over.append(d)
    return (round(sum(gaps) / len(gaps), 2) if gaps else None), sorted(over)


def assess(raw, craft: dict, text: str, report: dict | None = None) -> dict:
    """Trust check of one cleaned craft review (editor.clean_craft) against its raw answer and the draft."""
    tn = norm(text)
    scores = craft.get("scores") or {}
    dims = craft.get("dimensions") or list(scores)
    high = sorted(d for d, v in scores.items() if v >= HIGH)
    ev = evidence_of(raw, dims, tn)
    unjustified = [d for d in high if d not in ev]
    findings_quoted = sum(1 for f in craft.get("findings") or [] if f.get("located"))
    weakest = weakest_of(raw, tn)
    near_perfect = float(craft.get("avg_score") or 0) >= NEAR_PERFECT_AVG
    too_clean = near_perfect and (findings_quoted < MIN_FINDINGS or not any(w["found"] for w in weakest))
    gap, over = audit_gap(scores, audit_ceilings(report))
    reasons = []
    if unjustified:
        some = ", ".join(unjustified[:3]) + (f" and {len(unjustified) - 3} more" if len(unjustified) > 3 else "")
        reasons.append(f"{len(unjustified)} score(s) of 9-10 without a quoted proof ({some})")
    if too_clean:
        reasons.append(f"an average of {craft.get('avg_score')} with only {findings_quoted} quoted problem(s) (at "
                       f"least {MIN_FINDINGS} are required)" + ("" if any(w["found"] for w in weakest) else
                                                                 " and no quoted weakest passage"))
    return {"trusted": not reasons, "reasons": reasons, "unjustified": unjustified, "too_clean": too_clean,
            "high": high, "evidence": ev, "weakest": weakest, "findings_quoted": findings_quoted,
            "audit_gap": gap, "audit_over": over}


def apply_caps(scores: dict, assessment: dict) -> tuple[dict, dict]:
    """The scores of a flagged review: unproven 9/10 -> CAP; a too-clean review: every score at most CAP.
    Returns (new scores, {dimension: [old, new]} of what changed)."""
    out, changed = dict(scores), {}
    for d, v in scores.items():
        if d in (assessment.get("unjustified") or []) or assessment.get("too_clean"):
            if v > CAP:
                out[d] = CAP
                changed[d] = [v, CAP]
    return out, changed


def discounted(scores: dict, d: int) -> dict:
    return {k: max(1, v - d) for k, v in scores.items()} if d > 0 else dict(scores)


def pair_gap(a: dict, b: dict) -> float | None:
    """Mean score of ``a`` minus mean score of ``b`` over the dimensions both scored (None: none in common)."""
    common = [d for d in a if d in b]
    if not common:
        return None
    return round(sum(a[d] for d in common) / len(common) - sum(b[d] for d in common) / len(common), 2)


def merge(reviews: list[dict], max_findings: int = 12, max_keep: int = 10) -> dict:
    """Two (or more) cleaned reviews -> {scores (lower per dimension), findings (both, duplicates by passage
    removed, ids unique), keep}. ``reviews`` items: {"scores", "findings", "keep"}; the first one leads."""
    scores: dict = {}
    for r in reviews:
        for d, v in (r.get("scores") or {}).items():
            scores[d] = min(scores.get(d, v), v)
    findings, seen_p, seen_id = [], {}, set()
    for i, r in enumerate(reviews):
        for f in r.get("findings") or []:
            key = norm(f.get("passage")) or f"{i}:{f.get('id')}"
            if key in seen_p:  # the same passage from both editors: one note, the more severe one
                j = seen_p[key]
                if f.get("severity") == "major" and findings[j].get("severity") != "major":
                    findings[j] = dict(f, id=findings[j]["id"])
                continue
            seen_p[key] = len(findings)
            f = dict(f)
            fid = str(f.get("id") or f"f{len(findings) + 1}")
            if i and fid in seen_id:
                fid = f"r{i + 1}{fid}"
            while fid in seen_id:
                fid += "x"
            seen_id.add(fid)
            f["id"] = fid
            findings.append(f)
    findings.sort(key=lambda f: 0 if f.get("severity") == "major" else 1)  # stable: major first
    keep = list(dict.fromkeys(k for r in reviews for k in r.get("keep") or []))
    return {"scores": scores, "findings": findings[:max_findings], "keep": keep[:max_keep]}


def audit_findings(report: dict | None, text: str, dims: list, limit: int = MAX_AUDIT_NOTES) -> list[dict]:
    """Up to ``limit`` notes from BookForge's own pattern check, in the editor's finding format, for a flagged
    review that has nothing to rewrite. Only passages that are in the chapter word for word are used."""
    out = []
    order = {"major": 0, "minor": 1}
    for f in sorted((report or {}).get("findings") or [], key=lambda x: order.get(x.get("severity"), 9)):
        if f.get("severity") not in order:
            continue
        for p in f.get("passages") or []:
            ex = str(p.get("excerpt") or "").strip("…").strip()
            if len(ex) < 12 or ex not in text:
                continue
            dim = AUDIT_DIMS.get(f.get("check"))
            out.append({"id": f"p{len(out) + 1}", "dimension": dim if dim in dims else "other",
                        "severity": f["severity"], "passage": ex[:200],
                        "why": f"BookForge's pattern check: {f.get('label')} ({f.get('detail') or str(f.get('count')) + '×'})."[:500],
                        "suggestion": str(f.get("advice") or "")[:500], "keep_nearby": [], "found": True,
                        "located": True, "source": "pattern_check"})
            break
        if len(out) >= limit:
            break
    return out


# ====================================================================== leniency over time (settings: reviewer_leniency)
def _entry(cur: dict, family: str, name: str) -> dict:
    e = cur.get(family)
    if not isinstance(e, dict):
        e = {"name": name, "reviews": 0, "flagged": 0, "reasked": 0, "other_n": 0, "other_sum": 0.0, "audit_n": 0,
             "audit_sum": 0.0, "recent": []}
        cur[family] = e
    e["name"] = name or e.get("name") or family
    return e


def leniency(e: dict) -> float | None:
    n = int(e.get("other_n") or 0) + int(e.get("audit_n") or 0)
    if not n:
        return None
    return round((float(e.get("other_sum") or 0) + float(e.get("audit_sum") or 0)) / n, 2)


def discount_of(e: dict | None) -> int:
    """How many points a lenient AI's scores are lowered (0 until MIN_OBS observations; at most MAX_DISCOUNT)."""
    if not e:
        return 0
    n = int(e.get("other_n") or 0) + int(e.get("audit_n") or 0)
    lv = leniency(e)
    if n < MIN_OBS or lv is None or lv < LENIENT_AT:
        return 0
    return min(MAX_DISCOUNT, int(lv))


def discount_for(store, family: str | None) -> int:
    if not family:
        return 0
    try:
        cur = store.get_setting(KEY) or {}
        return discount_of(cur.get(family) if isinstance(cur, dict) else None)
    except Exception:  # noqa: BLE001 - leniency is a hint; never break a review
        log.exception("could not read the reviewer leniency")
        return 0


def record(store, family: str | None, name: str, *, vs_other: float | None = None, vs_audit: float | None = None,
           flagged: bool = False, reasked: bool = False, where: str = "editor") -> None:
    """Add one review's observations for an AI (numbers only). Never raises."""
    if not family:
        return
    try:
        with _lock:
            cur = store.get_setting(KEY) or {}
            cur = cur if isinstance(cur, dict) else {}
            e = _entry(cur, family, name)
            e["reviews"] = int(e.get("reviews") or 0) + 1
            e["flagged"] = int(e.get("flagged") or 0) + (1 if flagged else 0)
            e["reasked"] = int(e.get("reasked") or 0) + (1 if reasked else 0)
            if vs_other is not None:
                e["other_n"] = int(e.get("other_n") or 0) + 1
                e["other_sum"] = round(float(e.get("other_sum") or 0) + float(vs_other), 3)
            if vs_audit is not None:
                e["audit_n"] = int(e.get("audit_n") or 0) + 1
                e["audit_sum"] = round(float(e.get("audit_sum") or 0) + float(vs_audit), 3)
            e["recent"] = (list(e.get("recent") or []) + [{"at": _now(), "where": where, "vs_other": vs_other,
                                                            "vs_audit": vs_audit, "flagged": bool(flagged)}])[-MAX_RECENT:]
            e["updated_at"] = _now()
            store.set_setting(KEY, cur)
    except Exception:  # noqa: BLE001 - leniency is a hint; never break a review
        log.exception("could not record the reviewer leniency")


def words(lv: float | None, n: int) -> str:
    if lv is None or n < MIN_OBS:
        return "not enough reviews yet to tell"
    if lv >= 2:
        return "much too generous"
    if lv >= LENIENT_AT:
        return "too generous"
    if lv <= -1:
        return "stricter than the others"
    return "about right"


def table(store) -> list[dict]:
    """Every AI's leniency for the UI: [{family, name, reviews, leniency, vs_other, vs_audit, flagged, reasked,
    discount, words}], most lenient first."""
    try:
        cur = store.get_setting(KEY) or {}
    except Exception:  # noqa: BLE001
        cur = {}
    out = []
    for fam, e in (cur.items() if isinstance(cur, dict) else []):
        if not isinstance(e, dict):
            continue
        n = int(e.get("other_n") or 0) + int(e.get("audit_n") or 0)
        lv = leniency(e)
        out.append({"family": fam, "name": e.get("name") or fam, "reviews": int(e.get("reviews") or 0),
                    "observations": n, "leniency": lv,
                    "vs_other": round(e["other_sum"] / e["other_n"], 2) if e.get("other_n") else None,
                    "vs_audit": round(e["audit_sum"] / e["audit_n"], 2) if e.get("audit_n") else None,
                    "flagged": int(e.get("flagged") or 0), "reasked": int(e.get("reasked") or 0),
                    "discount": discount_of(e), "words": words(lv, n), "updated_at": e.get("updated_at")})
    out.sort(key=lambda r: -(r["leniency"] if r["leniency"] is not None else -99))
    return out


RULES = {"high": HIGH, "near_perfect_avg": NEAR_PERFECT_AVG, "min_findings": MIN_FINDINGS, "cap": CAP,
         "min_obs": MIN_OBS, "lenient_at": LENIENT_AT, "max_discount": MAX_DISCOUNT,
         "about": "A 9 or 10 needs a quoted proof; a near-perfect review (average 8.5+) needs at least 3 quoted "
                  "problems. Otherwise BookForge asks once more, then counts unproven scores as 7. Two reviewers: the "
                  "lower score per point. An AI that scores 1+ points above the others (3+ reviews) is lowered by "
                  "up to 2 points."}
