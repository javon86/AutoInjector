"""🖋 The AI editor: craft review (P4) and targeted rewrites of only the flagged passages (P5).

Craft review (after the consistency review of review.py): one draft — a chapter (C02, full rubric) or a planning draft
(B01/B03/B11, a lighter rubric) — goes to an AI EDITOR together with the book profile, the approved characters and
places, the protected facts, the plan for this part and the deterministic pattern report of prose_audit.py (P6).
The editor is chosen like the AI reviewer (ReviewService.plan_reviewer, P3.1): never the AI that wrote the draft
when another AI works (⚠️ "not independent" otherwise). It answers strict JSON

    {"scores": {dimension: 1-10}, "findings": [{"id", "dimension", "severity": "minor"|"major", "passage", "why",
     "suggestion", "keep_nearby": [...]}], "keep": [...], "verdict": "PASS"|"REVISE"}

(the rubric lives in editor_rubric.py). BookForge decides PASS / REVISE itself from the scores and findings with the
author's strictness (Settings › Editor: gentle / normal / strict); the AI's own verdict is kept as ``ai_verdict``.

Storage: like the AI reviewer's verdicts the editor's opinion is ADVICE, stored in the settings key
``craft_reviews:<project>:<branch>`` keyed ``<record_id>:<version>`` (it only ever applies to that exact version).
Set F (editing) records were considered and not used: an F record is an anchored patch PROPOSAL that becomes a draft
in the author's approval queue, needs an approval reference before it may carry patches and must be accepted
through C; a scored opinion with "keep" notes has no field there, and a rewrite the author (or the run) accepts is
stored the normal way — a C02 UPDATE, which re-runs every canon check of C. Prompts and replies are never logged;
activity events (``editor.craft_review``, ``editor.rewrite``, ``editor.rewrite_rejected``) carry numbers and codes,
never text. Only the stored findings hold short quotes (≤ 200 characters) of the author's own book.

P36 calibration (calibration.py): the editor must quote its weakest passages, name at least 3 problems and prove every
9/10 with a quote. A near-perfect review without that is asked again once (stricter prompt, same AI); still unproven
-> flagged ⚠️, those scores count as 7 and, when nothing is left to rewrite, BookForge's own pattern notes are added so
the rewrite loop can still run. When a second AI works that is neither the writer nor the first editor, it reviews
too and the LOWER score per dimension counts (Settings › Editor › two reviewers, on by default; an AI the author
picked for this review stays the only one). Each AI's leniency is kept over time (settings ``reviewer_leniency``) and
a lenient AI's scores are lowered before they are merged.

Targeted rewrite: the WRITER slot (the AI that wrote the chapter, never the editor when another AI works) gets the
chapter, the findings, the keep list, the protected facts and the characters, and returns
``{"replacements": [{"finding_id", "original", "replacement"}]}``. ``apply_replacements`` applies them
deterministically: an ``original`` must occur exactly once in the chapter, overlap the flagged passage and not drop
a "keep" quote — otherwise that finding is marked unresolved (never guessed). The new text is saved through the
normal UPDATE path as a new DRAFT version. Make-a-book runs then check it again (autobook.py: pattern checker,
consistency review, craft review) and keep the rewrite only if nothing got worse.
"""
from __future__ import annotations

import copy
import json
import logging
import re
from datetime import datetime, timezone

from . import ai_check, calibration
from . import chapter_brief
from . import characters as chars_mod
from . import editor_rubric as rubric
from . import prose_audit
from . import providers as providers_mod
from .assist import Cancelled, book_profile_brief, canon_context
from .book_path import BookPath
from .errors import BookforgeError
from .fact_checks import editor_context as fact_checks_context  # P26/P30/P31 (Section 7a)
from .fact_checks import protected_keep as protected_repeats

log = logging.getLogger("bookforge.editor")

EDITABLE = ("C02", "B01", "B03", "B11")
REWRITABLE = ("C02",)
MAX_FINDINGS = 12
MAX_KEEP = 10
PASSAGE_MAX = 200
MAX_ORIGINAL = 1200
MAX_TEXT_CHARS = 120000
DEFAULTS = {"enabled": True, "rounds": 2, "strictness": "normal", "two_reviewers": True}
NOT_INDEPENDENT = "Reviews are not independent — the same AI wrote and reviewed this"


def _schema(dims: list[str]) -> dict:
    return {
        "type": "object", "additionalProperties": False, "required": ["scores", "findings", "keep", "verdict"],
        "properties": {
            "scores": {"type": "object", "additionalProperties": False, "required": list(dims),
                       "properties": {d: {"type": "integer", "minimum": 1, "maximum": 10} for d in dims}},
            "findings": {"type": "array", "maxItems": MAX_FINDINGS, "items": {
                "type": "object", "additionalProperties": False,
                "required": ["id", "dimension", "severity", "passage", "why", "suggestion", "keep_nearby"],
                "properties": {"id": {"type": "string"}, "dimension": {"type": "string", "enum": list(dims)},
                               "severity": {"type": "string", "enum": ["minor", "major"]},
                               "passage": {"type": "string", "maxLength": PASSAGE_MAX},
                               "why": {"type": "string"}, "suggestion": {"type": "string"},
                               "keep_nearby": {"type": "array", "items": {"type": "string"}, "maxItems": 3}}}},
            "keep": {"type": "array", "items": {"type": "string"}, "maxItems": MAX_KEEP},
            "verdict": {"type": "string", "enum": ["PASS", "REVISE"]},
            # P36 (optional so older answers stay valid; the prompt asks for both): the weakest passages and a
            # quoted proof for every score of 9 or 10
            "weakest": {"type": "array", "maxItems": 5, "items": {
                "type": "object", "additionalProperties": False, "required": ["passage"],
                "properties": {"passage": {"type": "string", "maxLength": PASSAGE_MAX}, "why": {"type": "string"}}}},
            "score_evidence": {"type": "array", "maxItems": len(dims), "items": {
                "type": "object", "additionalProperties": False, "required": ["dimension", "quote"],
                "properties": {"dimension": {"type": "string", "enum": list(dims)},
                               "quote": {"type": "string", "maxLength": PASSAGE_MAX}, "why": {"type": "string"}}}},
        },
    }


REWRITE_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["replacements"],
    "properties": {"replacements": {"type": "array", "maxItems": MAX_FINDINGS, "items": {
        "type": "object", "additionalProperties": False, "required": ["finding_id", "original", "replacement"],
        "properties": {"finding_id": {"type": "string"}, "original": {"type": "string"},
                       "replacement": {"type": "string"}}}}},
}

UNRESOLVED_WORDS = {
    "NOT_FOUND": "the AI's “original” is not in the chapter word for word, so nothing was changed there",
    "AMBIGUOUS": "the AI's “original” appears more than once in the chapter, so BookForge did not guess which",
    "NOT_AT_PASSAGE": "the AI changed text that is not where the editor pointed",
    "TOO_LONG": "the AI tried to replace much more than the flagged passage",
    "KEEP_LOST": "the change would remove a passage the editor said to keep",
    "NO_CHANGE": "the AI returned the same text",
    "NO_REPLACEMENT": "the AI gave no replacement for this note",
    "NOT_ASKED": "the AI changed a passage nobody asked it to change",
    "REJECTED_BY_AUTHOR": "you chose not to use this change",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _rkey(rid: str, version: int) -> str:
    return f"{rid}:{version}"


def _clip(v, n: int) -> str:
    return " ".join(str(v or "").split())[:n]


def _find_passage(text: str, passage: str) -> tuple[int, int] | None:
    """Where a quoted passage is in the text: exact first, then with whitespace normalised (for showing only)."""
    if not passage:
        return None
    i = text.find(passage)
    if i >= 0:
        return i, i + len(passage)
    words = [re.escape(w) for w in passage.split()]
    if not words:
        return None
    m = re.search(r"\s+".join(words), text)
    return (m.start(), m.end()) if m else None


# ====================================================================== pure helpers (unit-tested)
def decide(scores: dict, findings: list, strictness: str, relax: dict | None = None) -> tuple[str, list[str]]:
    """BookForge's own PASS / REVISE from the editor's scores and findings (Settings › Editor › strictness).
    ``relax``: per-dimension change of the minimum score from the author's story choices (P12, e.g. "explain the
    mysteries" lowers the bar of protected_mysteries by 2)."""
    thr = rubric.STRICTNESS.get(strictness) or rubric.STRICTNESS["normal"]
    relax = relax or {}
    why = []
    low = sorted(d for d, v in scores.items() if isinstance(v, int) and v < thr["min_score"] + int(relax.get(d, 0)))
    if low:
        why.append("score below " + str(thr["min_score"]) + ": " + ", ".join(f"{rubric.LABELS.get(d, d)} {scores[d]}"
                                                                          for d in low))
    major = sum(1 for f in findings if f.get("severity") == "major")
    minor = sum(1 for f in findings if f.get("severity") == "minor")
    if major > thr["max_major"]:
        why.append(f"{major} major finding(s)")
    if minor > thr["max_minor"]:
        why.append(f"{minor} minor finding(s)")
    return ("REVISE" if why else "PASS"), why


def clean_craft(raw, dims: list[str], text: str, strictness: str, relax: dict | None = None) -> dict:
    """Validate and normalise the editor's answer; raise INTERNAL_ERROR when it is not a usable review."""
    if not isinstance(raw, dict) or not isinstance(raw.get("scores"), dict):
        raise BookforgeError("INTERNAL_ERROR", "/scores", "the editor's answer was not a valid craft review (no "
                             "scores); nothing was changed")
    scores = {}
    for d in dims:
        v = raw["scores"].get(d)
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            continue
        scores[d] = int(min(10, max(1, round(v))))
    if not scores:
        raise BookforgeError("INTERNAL_ERROR", "/scores", "the editor gave no usable scores; nothing was changed")
    findings, seen = [], set()
    for i, f in enumerate(raw.get("findings") or []):
        if not isinstance(f, dict) or len(findings) >= MAX_FINDINGS:
            continue
        passage = str(f.get("passage") or "").strip()[:PASSAGE_MAX]
        why = _clip(f.get("why"), 500)
        if not passage and not why:
            continue
        fid = re.sub(r"[^A-Za-z0-9_-]", "", str(f.get("id") or ""))[:20] or f"f{i + 1}"
        while fid in seen:
            fid += "x"
        seen.add(fid)
        dim = f.get("dimension") if f.get("dimension") in rubric.LABELS else "other"
        loc = _find_passage(text, passage) if text else None
        findings.append({
            "id": fid, "dimension": dim, "label": rubric.LABELS.get(dim, "Other"),
            "severity": "major" if f.get("severity") == "major" else "minor", "passage": passage, "why": why,
            "suggestion": _clip(f.get("suggestion"), 500),
            "keep_nearby": [str(k).strip()[:PASSAGE_MAX] for k in (f.get("keep_nearby") or [])
                            if isinstance(k, str) and k.strip()][:3],
            "found": bool(loc) and text.find(passage) >= 0, "located": bool(loc)})
    keep = [str(k).strip()[:PASSAGE_MAX] for k in (raw.get("keep") or []) if isinstance(k, str) and k.strip()]
    out = summarise(scores, findings, keep[:MAX_KEEP], dims, text, strictness, relax)
    out["ai_verdict"] = raw.get("verdict") if raw.get("verdict") in ("PASS", "REVISE") else None
    return out


def summarise(scores: dict, findings: list, keep: list, dims: list[str], text: str, strictness: str,
              relax: dict | None = None, distrust: str | None = None) -> dict:
    """The verdict and the numbers of a craft review from its (maybe merged, capped) scores and findings.
    ``distrust``: why the editor's review was not trusted (P36) — then a PASS with notes to work on becomes REVISE."""
    verdict, why = decide(scores, findings, strictness, relax)
    if distrust:
        if verdict == "PASS" and findings:
            verdict = "REVISE"
        why = why + [f"the editor's review was too clean to trust ({distrust})"]
    vals = list(scores.values())
    return {"verdict": verdict, "verdict_why": why,
            "scores": scores, "dimensions": list(dims), "missing_scores": [d for d in dims if d not in scores],
            "findings": findings, "keep": keep, "keep_quotes": [k for k in keep if text and k in text],
            "min_score": min(vals), "avg_score": round(sum(vals) / len(vals), 1),
            "counts": {"major": sum(1 for f in findings if f["severity"] == "major"),
                       "minor": sum(1 for f in findings if f["severity"] == "minor")},
            "strictness": strictness}


def keep_quotes_of(craft: dict, text: str, finding_ids=None) -> list[str]:
    """The exact quotes a rewrite must not lose: the keep list and the keep_nearby of the targeted findings, when
    they are in the text word for word (plain notes such as "the ending's image" cannot be checked by BookForge)."""
    out = [k for k in craft.get("keep") or [] if k and k in text]
    for f in craft.get("findings") or []:
        if finding_ids is None or f["id"] in finding_ids:
            out += [k for k in f.get("keep_nearby") or [] if k and k in text]
    return list(dict.fromkeys(out))


def apply_replacements(text: str, replacements: list, findings: list, keep: list[str]) -> dict:
    """Apply the writer's replacements exactly; never guess. Returns {text, applied, unresolved}.

    A replacement is used only when its ``original`` occurs exactly once in the (current) text, overlaps the flagged
    passage of its finding (when that passage is in the text), is not far longer than the passage, changes something
    and keeps every keep quote it contains. Each targeted finding without a usable replacement is unresolved."""
    out = text
    by_id = {f["id"]: f for f in findings}
    applied, unresolved, done = [], [], set()
    for r in replacements or []:
        if not isinstance(r, dict):
            continue
        fid = str(r.get("finding_id") or "")
        orig = r.get("original") if isinstance(r.get("original"), str) else ""
        repl = r.get("replacement") if isinstance(r.get("replacement"), str) else None
        f = by_id.get(fid)
        reason = None
        if f is None:
            reason = "NOT_ASKED"
        elif fid in done:
            reason = "AMBIGUOUS"
        elif repl is None:
            reason = "NO_REPLACEMENT"
        elif not orig or out.find(orig) < 0:
            reason = "NOT_FOUND"
        elif out.count(orig) > 1:
            reason = "AMBIGUOUS"
        elif repl.strip() == orig.strip():
            reason = "NO_CHANGE"
        else:
            o0 = out.find(orig)
            o1 = o0 + len(orig)
            p = f.get("passage") or ""
            pi = out.find(p) if p else -1
            limit = max(len(p) * 3, len(p) + 400) if pi >= 0 else 600
            if len(orig) > min(MAX_ORIGINAL, limit):
                reason = "TOO_LONG"
            elif pi >= 0 and not (o0 < pi + len(p) and pi < o1):
                reason = "NOT_AT_PASSAGE"
            elif any(k in orig and k not in repl for k in keep):
                reason = "KEEP_LOST"
        if reason:
            if f is not None and fid not in done:
                unresolved.append({"finding_id": fid, "reason": reason, "message": UNRESOLVED_WORDS[reason]})
            continue
        out = out.replace(orig, repl, 1)
        done.add(fid)
        applied.append({"finding_id": fid, "original": orig, "replacement": repl})
    unresolved = [u for u in unresolved if u["finding_id"] not in done]
    seen = {u["finding_id"] for u in unresolved}
    for f in findings:
        if f["id"] not in done and f["id"] not in seen:
            unresolved.append({"finding_id": f["id"], "reason": "NO_REPLACEMENT",
                               "message": UNRESOLVED_WORDS["NO_REPLACEMENT"]})
    return {"text": out, "applied": applied, "unresolved": unresolved}


def lost_keeps(old_text: str, new_text: str, keep: list[str]) -> list[str]:
    return [k for k in keep if k in old_text and k not in new_text]


def judge_rewrite(old: dict, new: dict | None, *, consistency: str | None, checks_ok: bool, keep_lost: list,
                  applied: list, new_text: str) -> tuple[bool, str, str]:
    """Keep a rewrite only if nothing got worse: (keep?, code, plain reason). Scores may move by AI noise: the
    average must not drop and no single dimension may drop by more than 1 point."""
    if not checks_ok:
        return False, "CHECKS_REFUSED", "BookForge's checks refused the rewritten chapter"
    if consistency != "APPROVE":
        return False, "CONSISTENCY", f"the consistency reviewer said {consistency or 'nothing'} for the rewrite"
    if keep_lost:
        return False, "KEEP_LOST", f"the rewrite lost {len(keep_lost)} passage(s) the editor said to keep"
    if new is None:
        return False, "EDITOR_FAILED", "the editor could not check the rewrite"
    drops = [d for d, v in (old.get("scores") or {}).items() if d in new["scores"] and new["scores"][d] < v - 1]
    if drops or new.get("avg_score", 0) < old.get("avg_score", 0):
        what = ", ".join(rubric.LABELS.get(d, d) for d in drops) or "the average score"
        return False, "SCORE_DROP", f"the editor scored the rewrite lower ({what})"
    still = [a["finding_id"] for a in applied if a.get("passage") and a["passage"] in new_text]
    if still:
        return False, "NOT_RESOLVED", "a flagged passage is still there after the rewrite"
    if new["counts"]["major"] > old["counts"]["major"]:
        return False, "NEW_PROBLEMS", "the rewrite has more major findings than before"
    return True, "KEPT", "the rewrite fixed the flagged passages and nothing got worse"


# ====================================================================== service
class EditorService:
    """Craft review, rewrite proposals and applying them (one per ReviewService: same engine, AIs and jobs)."""

    def __init__(self, review):
        self.review = review
        self.engine, self.store, self.contracts = review.engine, review.store, review.contracts
        self.assist = review.assist

    # ------------------------------------------------------------------ settings (Settings › Editor)
    def settings(self) -> dict:
        cur = self.store.get_setting("editor_settings") or {}
        cur = cur if isinstance(cur, dict) else {}
        out = dict(DEFAULTS)
        if isinstance(cur.get("enabled"), bool):
            out["enabled"] = cur["enabled"]
        if isinstance(cur.get("rounds"), int) and not isinstance(cur.get("rounds"), bool) and 0 <= cur["rounds"] <= 3:
            out["rounds"] = cur["rounds"]
        if cur.get("strictness") in rubric.STRICTNESS:
            out["strictness"] = cur["strictness"]
        if isinstance(cur.get("two_reviewers"), bool):
            out["two_reviewers"] = cur["two_reviewers"]
        out["calibration"] = calibration.RULES["about"]
        out["strictness_choices"] = {k: v["about"] for k, v in rubric.STRICTNESS.items()}
        out["dimensions"] = [{"key": k, "label": label} for k, label, _q in rubric.DIMENSIONS]
        return out

    def save_settings(self, body) -> dict:
        body = body if isinstance(body, dict) else {}
        cur = {k: v for k, v in self.settings().items() if k in DEFAULTS}
        if "enabled" in body:
            if not isinstance(body["enabled"], bool):
                raise BookforgeError("INVALID_INPUT", "/enabled", "Editor: on (true) or off (false)", status="REJECTED")
            cur["enabled"] = body["enabled"]
        if "rounds" in body:
            r = body["rounds"]
            if isinstance(r, str) and r.strip().isdigit():
                r = int(r)
            if isinstance(r, bool) or not isinstance(r, int) or not 0 <= r <= 3:
                raise BookforgeError("INVALID_INPUT", "/rounds", "Editor rounds: a whole number from 0 to 3",
                                     status="REJECTED")
            cur["rounds"] = r
        if "strictness" in body:
            if body["strictness"] not in rubric.STRICTNESS:
                raise BookforgeError("INVALID_INPUT", "/strictness", "Strictness: gentle, normal or strict",
                                     status="REJECTED")
            cur["strictness"] = body["strictness"]
        if "two_reviewers" in body:
            if not isinstance(body["two_reviewers"], bool):
                raise BookforgeError("INVALID_INPUT", "/two_reviewers", "Two reviewers: on (true) or off (false)",
                                     status="REJECTED")
            cur["two_reviewers"] = body["two_reviewers"]
        cur["at"] = _now_iso()
        self.store.set_setting("editor_settings", cur)
        return self.settings()

    # ------------------------------------------------------------------ stored advice
    def crafts(self, pid, branch) -> dict:
        return self.store.get_setting(f"craft_reviews:{pid}:{branch}") or {}

    def proposals(self, pid, branch) -> dict:
        return self.store.get_setting(f"editor_proposals:{pid}:{branch}") or {}

    def rewrites(self, pid, branch) -> dict:
        return self.store.get_setting(f"editor_rewrites:{pid}:{branch}") or {}

    @staticmethod
    def summary(craft: dict | None) -> dict | None:
        """The few numbers the review queue shows for a craft review (no text)."""
        if not craft:
            return None
        out = {k: craft.get(k) for k in ("verdict", "min_score", "avg_score", "counts", "at", "reviewer",
                                         "independent", "round", "strictness")}
        out["flagged"] = bool((craft.get("calibration") or {}).get("flagged"))
        out["reviewers"] = len(craft.get("reviewers") or []) or 1
        return out

    # ------------------------------------------------------------------ context
    def chapter_info(self, pid, branch, rec, principal="author") -> dict:
        """Which outline chapter a C02 record is: {chapter_id, number, of, last, objective, previous, next}."""
        try:
            bp = BookPath(self.engine, principal, pid, branch)
            outline = bp.outline()
            chs = bp.outline_chapters(outline) if outline else []
            for i, c in enumerate(chs):
                _ctx, latest, appr = bp.chapter_prose(outline, c["chapter_id"])
                if any(r and r["record_id"] == rec["record_id"] for r in (latest, appr)):
                    return {"chapter_id": c["chapter_id"], "number": i + 1, "of": len(chs), "last": i == len(chs) - 1,
                            "objective": c.get("objective"),
                            "previous": chs[i - 1].get("objective") if i else None,
                            "next": chs[i + 1].get("objective") if i + 1 < len(chs) else None}
        except Exception:  # noqa: BLE001 - context is best effort
            log.exception("could not place record %s in the outline", rec.get("record_id"))
        return {"chapter_id": None, "number": None, "of": None, "last": False}

    def names(self, pid, branch) -> list[str]:
        approved, drafts, _p = canon_context(self.engine, pid, branch, max_approved=60, max_drafts=60)
        out = []
        for r in approved + drafts:
            out += [n for n in r.get("names") or [] if isinstance(n, str)]
            if r.get("concept"):
                out.append(str(r["concept"])[:60])
        return out

    def pattern(self, pid, branch, rec, strictness=None) -> dict | None:
        """The P6 pattern report for a chapter draft (None for other drafts), with the voice check (P17) against the
        characters' voice cards."""
        if rec["module_id"] != "C02":
            return None
        text = (rec.get("data") or {}).get("text") or ""
        st = strictness or self.settings()["strictness"]
        try:
            voices = chars_mod.voice_words(self.store, pid, branch)
        except Exception:  # noqa: BLE001 - the voice words are a hint
            log.exception("could not read the voice cards")
            voices = {}
        try:  # P10: count how often each world-texture detail is on the page
            from . import texture as texture_mod  # noqa: PLC0415
            tex = texture_mod.items_of(texture_mod.get_entry(self.store, pid, branch))
        except Exception:  # noqa: BLE001
            tex = []
        return prose_audit.audit(text, chapter=None, settings={"strictness": st, "voices": voices, "texture": tex},
                                 names=self.names(pid, branch))

    def brief(self, pid, branch, info, principal="author") -> dict | None:
        """The chapter's writing brief (voice cards of the characters present, scene cards) for the editor."""
        if not info.get("chapter_id"):
            return None
        try:
            outline = BookPath(self.engine, principal, pid, branch).outline()
            brief, _meta = chapter_brief.build(self.store, pid, branch, outline, info["chapter_id"])
            return brief
        except Exception:  # noqa: BLE001 - context is best effort
            log.exception("could not build the chapter brief for the editor")
            return None

    def _voices(self, pid, branch) -> list[dict]:
        out = []
        for r in self.store.list_records(pid, branch):
            if r["module_id"] != "A01" or r["record_kind"] != "OUTPUT":
                continue
            rec = r
            if r.get("approved_version") and r["approved_version"] != r["version"]:
                rec = self.store.get_record(pid, branch, r["record_id"], r["approved_version"]) or r
            if rec["lifecycle"] not in ("APPROVED", "LOCKED") and not r.get("approved_version"):
                continue
            data = rec.get("data") or {}
            attrs = data.get("attributes") if isinstance(data.get("attributes"), dict) else {}
            entry = chars_mod.get_entry(self.store, pid, branch, r["record_id"]) or {}
            row = {"name": str(data.get("concept") or "")[:80],
                   "sheet": {k: _clip(v, 300) for k, v in list(attrs.items())[:12] if isinstance(v, str)}}
            if entry.get("voice"):
                row["voice_card"] = {k: v for k, v in entry["voice"].items() if v}
            if entry.get("sheet"):
                row["character_sheet"] = {k: entry["sheet"].get(k) for k in ("wants", "fear", "secret", "never_say",
                                                                             "stress") if entry["sheet"].get(k)}
            out.append(row)
            if len(out) >= 12:
                break
        return out

    def guidance(self, pid, branch, module_id, info) -> dict:
        """P9/P12: the story rules (editor view or plan brief) and the author's choices (never raises)."""
        out = {"choices": {}, "rules": None}
        try:
            from . import story_choices, story_rules  # noqa: PLC0415
            out["choices"] = story_choices.of_store(self.store, pid)
            if module_id == "C02":
                out["rules"] = story_rules.editor_view(self.store, pid, branch, last=bool(info.get("last")),
                                                       mystery_mode=story_choices.mystery_mode(out["choices"]))
            elif module_id in ("B03", "B11"):
                out["rules"] = story_rules.plan_brief(self.store, pid, branch)
        except Exception:  # noqa: BLE001 - guidance is best effort
            log.exception("could not read the story rules / choices for the editor")
        return out

    def _context(self, pid, branch, rec, report, info, brief=None, guide=None) -> tuple[dict, list]:
        approved, _d, protected = canon_context(self.engine, pid, branch, max_approved=40, max_drafts=0)
        ctx = {"book_profile": book_profile_brief(self.store, pid), "canon": {"approved_records": approved},
               "characters": self._voices(pid, branch), "protected_facts": protected[:40]}
        if (guide or {}).get("rules"):
            ctx["story_rules"] = guide["rules"]
        data = rec.get("data") or {}
        if rec["module_id"] == "C02":
            if brief and brief.get("world_texture"):
                ctx["world_texture"] = brief["world_texture"]
            if brief:
                ctx["voice_cards"] = {"cards": brief.get("voice_cards") or [],
                                      "others": brief.get("other_voices") or []}
                if brief.get("scene_cards"):
                    ctx["scene_cards"] = brief["scene_cards"]
                if brief.get("pov"):
                    ctx["pov"] = brief["pov"]
            ctx["chapter_text"] = str(data.get("text") or "")[:MAX_TEXT_CHARS]
            ctx["outline"] = {k: info.get(k) for k in ("chapter_id", "number", "of", "last", "objective", "previous",
                                                       "next")}
            ctx["pattern_report"] = prose_audit.brief(report) if report else None
        else:
            ctx["draft_json"] = json.dumps(data, ensure_ascii=False)[:60000]
            ctx["operation"] = (self.contracts.operation(rec["module_id"]) or {}).get("name")
        return ctx, protected

    # ------------------------------------------------------------------ craft review (P4)
    def craft_one(self, job, rid: str, *, round_no: int | None = None, chapter: dict | None = None,
                  prev: dict | None = None) -> dict:
        """Craft review of the head revision of ``rid`` (job: a review.ReviewJob). Stores and returns the review.
        ``prev``: the craft review of the version before a rewrite (P36: its reviewers and leniency discounts are
        reused so that the scores of the two versions stay comparable)."""
        rv = self.review
        pid, branch = job.project_id, job.branch_id
        rec = rv._head(pid, branch, rid)
        if rec is None:
            raise BookforgeError("NOT_FOUND", "/record_id", "this draft no longer exists", status="REJECTED")
        if rec["module_id"] not in EDITABLE:
            raise BookforgeError("INVALID_INPUT", "/record_id", "the editor reads chapters and the premise, main plot "
                                 "and chapter outline", status="REJECTED")
        st = self.settings()
        info = chapter or (self.chapter_info(pid, branch, rec, job.principal) if rec["module_id"] == "C02" else {})
        brief = self.brief(pid, branch, info, job.principal) if rec["module_id"] == "C02" else None
        guide = self.guidance(pid, branch, rec["module_id"], info)
        dims = rubric.dimensions_for(rec["module_id"], bool(info.get("last")), bool((brief or {}).get("scene_cards")),
                                     story_rules=bool(guide["rules"]))
        from . import story_choices  # noqa: PLC0415
        notes, relax = story_choices.editor_notes(guide["choices"]), story_choices.relax(guide["choices"])
        report = self.pattern(pid, branch, rec, st["strictness"])
        writer = rv.writer_of(pid, branch, rec)
        rv.plan_reviewer(job, writer)  # the editor is never the writer when another AI works (P3.1)
        from .review import safe_title  # noqa: PLC0415
        title = safe_title(self.contracts, rec)
        text = str((rec.get("data") or {}).get("text") or "") if rec["module_id"] == "C02" else \
            json.dumps(rec.get("data"), ensure_ascii=False)
        prev_disc = {r.get("family"): r.get("discount", 0) for r in (prev or {}).get("reviewers") or []
                     if r.get("family")}
        job.phase = f"The editor is reading “{title}”"
        tok = rv.work.begin(pid, rec["module_id"], f"The editor is reading {title}")
        second, second_note = None, None
        try:
            ctx, protected = self._context(pid, branch, rec, report, info, brief, guide)
            ctx.update(fact_checks_context(self.engine, job.principal, pid, branch, rec))  # P26/P30/P31 (never raises)
            task = rubric.task_text(rec["module_id"], dims, notes)
            ask = dict(rec=rec, task=task, dims=dims, ctx=ctx, protected=protected, text=text,
                       strictness=st["strictness"], relax=relax, report=report, prev_disc=prev_disc)
            first = self._ask(job, **ask)
            # P36: a second, independent opinion when another AI works (never instead of an AI the author picked)
            if st.get("two_reviewers", True) and not job.slot_pref:
                prefer = next((r.get("slot") for r in ((prev or {}).get("reviewers") or [])[1:2]), None)
                other = self._second_slot(job, writer, first["slot"], ctx, prefer=prefer)
                if other:
                    keep_slot = (job.slot, job.slot_label, job.model)
                    job.phase = f"A second editor is reading “{title}”"
                    try:
                        second = self._ask(job, slot=other, optional=True, **ask)
                    except BookforgeError as exc:
                        second_note = f"the second editor ({rv.slot_label(other)}) could not read it ({exc.code})"
                        log.info("second editor %s failed: %s", other, exc.code)
                    finally:
                        job.slot, job.slot_label, job.model = keep_slot
        finally:
            rv.work.end(tok)
        job.check()
        reviewers = [first] + ([second] if second else [])
        merged = calibration.merge([{"scores": r["adjusted"], "findings": r["craft"]["findings"],
                                     "keep": r["craft"]["keep"]} for r in reviewers], MAX_FINDINGS, MAX_KEEP)
        flagged = [r for r in reviewers if r["flagged"]]
        findings, added = merged["findings"], []
        if flagged and not findings and rec["module_id"] == "C02":
            added = calibration.audit_findings(report, text, dims)
            findings = added
        distrust = "; ".join(f"{r['name']}: {'; '.join(r['reasons'])}" for r in flagged) or None
        craft = summarise(merged["scores"], findings, merged["keep"], dims, text, st["strictness"], relax, distrust)
        craft["ai_verdict"] = first["craft"].get("ai_verdict")
        if relax:
            craft["relaxed"] = relax
        craft["reviewers"] = [self._reviewer_row(r) for r in reviewers]
        craft["calibration"] = {
            "flagged": bool(flagged), "reasked": sum(1 for r in reviewers if r["reasked"]),
            "two_reviewers": bool(second), "second_note": second_note, "pattern_notes_added": len(added),
            "notes": self._calibration_notes(reviewers, added, second_note), "rule": calibration.RULES["about"]}
        editor = rv._slot(first["slot"])
        same = bool(writer.get("slot")) and (first["slot"] == writer["slot"] or providers_mod.slot_family(editor)
                                             == providers_mod.slot_family(rv._slot(writer["slot"])))
        craft.update(slot=first["slot"], slot_label=first["slot_label"], model=first["model"], at=_now_iso(),
                     reviewer=" + ".join(r["name"] for r in reviewers),
                     writer_slot=writer.get("slot"), writer=writer.get("label"), independent=not same,
                     warning=NOT_INDEPENDENT if same else None, module_id=rec["module_id"], version=rec["version"],
                     record_id=rid, chapter_id=info.get("chapter_id"), last_chapter=bool(info.get("last")),
                     round=round_no, pattern=prose_audit.counts_only(report) if report else None)
        job.slot, job.slot_label, job.model = first["slot"], first["slot_label"], first["model"]
        self._track(reviewers)
        rv._put(f"craft_reviews:{pid}:{branch}", _rkey(rid, rec["version"]), craft)
        with self.store.transaction() as tx:
            tx.insert_outbox(pid, branch, "editor.craft_review", {
                "record_id": rid, "version": rec["version"], "module_id": rec["module_id"],
                "verdict": craft["verdict"], "scores": craft["scores"], "major": craft["counts"]["major"],
                "minor": craft["counts"]["minor"], "ai_slot": first["slot"], "writer_slot": writer.get("slot"),
                "independent": not same, "round": round_no, "chapter_id": info.get("chapter_id"),
                "reviewers": [r["slot"] for r in reviewers], "flagged": bool(flagged),
                "reasked": craft["calibration"]["reasked"]})
        return craft

    # ------------------------------------------------------------------ P36: one reviewer, trust check, second slot
    def _ask(self, job, *, rec, task, dims, ctx, protected, text, strictness, relax, report, prev_disc=None,
             slot: str | None = None, optional: bool = False) -> dict:
        """One editor's review with the trust check (calibration.assess). An untrusted answer is asked again ONCE
        (same AI, editor_rubric.STRICT_REASK); still untrusted -> flagged and its unproven scores capped. Then the
        AI's leniency discount is applied. ``slot``: this AI only; ``optional``: never wait and retry a busy or
        broken AI (the second editor is a bonus, it must not hold the book up)."""
        rv = self.review
        saved = (job.slot_pref, getattr(job, "retry_busy", None))
        if slot:
            job.slot_pref = slot
        try:
            if optional:
                job.retry_busy = False
            raw = self.assist._call_ai(job, op_for_roles=rec["module_id"], task=task, schema=_schema(dims),
                                       context=ctx, protected=protected)
            job.check()
            craft = clean_craft(raw, dims, text, strictness, relax)
            got = {"slot": job.slot, "slot_label": job.slot_label, "model": job.model}
            a = calibration.assess(raw, craft, text, report)
            reasked, reask_error, first_reasons = False, None, list(a["reasons"])
            if not a["trusted"] and got["slot"]:
                reasked = True
                job.slot_pref = got["slot"]
                job.retry_busy = False  # the first answer is kept when the AI cannot answer again right now
                try:
                    raw2 = self.assist._call_ai(job, op_for_roles=rec["module_id"],
                                                task=task + " " + rubric.STRICT_REASK.format(
                                                    reasons="; ".join(a["reasons"])),
                                                schema=_schema(dims), context=ctx, protected=protected)
                    job.check()
                    craft = clean_craft(raw2, dims, text, strictness, relax)
                    a = calibration.assess(raw2, craft, text, report)
                    got["model"] = job.model
                except Cancelled:
                    raise
                except BookforgeError as exc:
                    reask_error = exc.code
                    log.info("strict re-ask of the editor on %s failed: %s", got["slot"], exc.code)
        finally:
            job.slot_pref = saved[0]
            job.retry_busy = saved[1]
        sd = rv._slot(got["slot"])
        family = providers_mod.slot_family(sd) or got["slot"]
        name = (ai_check.ai_word(sd) if sd else got["slot"]) or "AI"
        flagged = not a["trusted"]
        scores, capped = (calibration.apply_caps(craft["scores"], a) if flagged else (dict(craft["scores"]), {}))
        disc = (prev_disc or {}).get(family)
        if disc is None:
            disc = calibration.discount_for(self.store, family)
        return dict(got, craft=craft, assessment=a, name=name, family=family, reasked=reasked,
                    reask_error=reask_error, first_reasons=first_reasons, flagged=flagged,
                    reasons=a["reasons"], capped=capped, discount=int(disc or 0),
                    raw_scores=dict(craft["scores"]), adjusted=calibration.discounted(scores, int(disc or 0)))

    def _second_slot(self, job, writer: dict, first_slot: str | None, ctx: dict, prefer: str | None = None):
        """A working AI for a second opinion: not the writer, not the first editor, and not the same AI (family) as
        either of them. None when there is none right now (never waits)."""
        rv = self.review
        try:
            prov = self.assist._providers(job)
            needed = len(json.dumps(ctx, ensure_ascii=False)) // 3 + 2000
            elig = prov.eligible(job.project_id, "text", needed, None)
        except Exception:  # noqa: BLE001 - the second opinion is a bonus
            log.exception("could not look for a second editor")
            return None
        wslot = writer.get("slot")
        bad = {providers_mod.slot_family(rv._slot(x)) for x in (wslot, first_slot) if x} - {None}
        cands = [s["slot_id"] for s in elig if s["slot_id"] not in (wslot, first_slot)
                 and providers_mod.slot_family(s) not in bad]
        if prefer in cands:
            return prefer
        return cands[0] if cands else None

    @staticmethod
    def _reviewer_row(r: dict) -> dict:
        a = r["assessment"]
        return {"slot": r["slot"], "slot_label": r["slot_label"], "reviewer": r["name"], "family": r["family"],
                "model": r["model"], "scores": r["raw_scores"], "adjusted": r["adjusted"], "trusted": a["trusted"],
                "flagged": r["flagged"], "reasked": r["reasked"], "reask_error": r["reask_error"],
                "first_reasons": r["first_reasons"], "reasons": r["reasons"], "capped": r["capped"],
                "discount": r["discount"], "findings": len(r["craft"]["findings"]),
                "avg_score": r["craft"]["avg_score"], "weakest": a["weakest"][:3], "evidence": a["evidence"],
                "audit_gap": a["audit_gap"]}

    @staticmethod
    def _calibration_notes(reviewers: list, added: list, second_note: str | None) -> list[str]:
        """Plain sentences for the author about how far each editor's scores were trusted."""
        out = []
        for r in reviewers:
            if r["reasked"]:
                out.append(f"{r['name']}'s first review was not accepted ({'; '.join(r['first_reasons'])}), so "
                           "BookForge asked once more with a stricter prompt"
                           + (f" — that failed ({r['reask_error']})" if r["reask_error"] else "") + ".")
            if r["flagged"]:
                out.append(f"⚠️ {r['name']}'s review is still not backed by quotes: "
                           + (", ".join(f"{rubric.LABELS.get(d, d)} {o}→{n}" for d, (o, n) in r["capped"].items())
                              or "no score changed") + f" (unproven scores count as {calibration.CAP}).")
            if r["discount"]:
                out.append(f"{r['name']} has been more generous than the other reviewers, so its scores were lowered "
                           f"by {r['discount']} point(s).")
        if len(reviewers) > 1:
            out.append(f"Two editors read it ({' and '.join(r['name'] for r in reviewers)}): the lower score counts "
                       "on each point and the notes of both are listed.")
        if added:
            out.append(f"{len(added)} note(s) from BookForge's own pattern check were added so the rewrite can work "
                       "on something.")
        if second_note:
            out.append(f"Only one editor this time: {second_note}.")
        return out

    def _track(self, reviewers: list):
        """P36 leniency over time: each editor vs the other one and vs BookForge's pattern check (numbers only)."""
        gap = calibration.pair_gap(reviewers[0]["raw_scores"], reviewers[1]["raw_scores"]) \
            if len(reviewers) > 1 else None
        for i, r in enumerate(reviewers):
            vs = None if gap is None else (gap if i == 0 else -gap)
            calibration.record(self.store, r["family"], r["name"], vs_other=vs,
                               vs_audit=r["assessment"]["audit_gap"], flagged=r["flagged"], reasked=r["reasked"])

    # ------------------------------------------------------------------ rewrite proposal (P5)
    def propose(self, job, rid: str, *, craft: dict | None = None, finding_ids=None) -> dict:
        """Ask the WRITER for replacements of the flagged passages; nothing is saved to the book here. Stores the
        proposal (with what would apply) under ``editor_proposals`` for exactly this version."""
        rv = self.review
        pid, branch = job.project_id, job.branch_id
        rec = rv._head(pid, branch, rid)
        if rec is None or rec["module_id"] not in REWRITABLE:
            raise BookforgeError("INVALID_INPUT", "/record_id", "the editor's fixes can be applied to chapters only",
                                 status="REJECTED")
        craft = craft or self.crafts(pid, branch).get(_rkey(rid, rec["version"]))
        if not craft:
            raise BookforgeError("INVALID_INPUT", "/record_id", "ask the editor to review this version first "
                                 "(🖋 Editor review)", status="REJECTED")
        findings = [f for f in craft.get("findings") or [] if finding_ids is None or f["id"] in finding_ids]
        if not findings:
            raise BookforgeError("INVALID_INPUT", "/finding_ids", "the editor has no notes to fix for this version",
                                 status="REJECTED")
        text = str((rec.get("data") or {}).get("text") or "")
        keep = keep_quotes_of(craft, text, {f["id"] for f in findings})
        # P30: voice and motif repeats are never cut by a rewrite (only BookForge's own trim of their excess)
        keep = list(dict.fromkeys(keep + protected_repeats(self.engine, job.principal, pid, branch, text,
                                                           except_keys=craft.get("except_keys") or ())))
        if not job.slot_pref:
            writer = rv.writer_of(pid, branch, rec)
            job.prefer_slots = [writer["slot"]] if writer.get("slot") else []
            job.avoid_slots = [craft["slot"]] if craft.get("slot") and craft.get("slot") != writer.get("slot") else []
        approved, _d, protected = canon_context(self.engine, pid, branch, max_approved=40, max_drafts=0)
        ctx = {"chapter_text": text[:MAX_TEXT_CHARS], "book_profile": book_profile_brief(self.store, pid),
               "findings": [{k: f.get(k) for k in ("id", "dimension", "severity", "passage", "why", "suggestion",
                                                   "keep_nearby")} for f in findings],
               "keep": craft.get("keep") or [], "voices": self._voices(pid, branch),
               "canon": {"approved_records": approved}, "protected_facts": protected[:40]}
        from .review import safe_title  # noqa: PLC0415
        title = safe_title(self.contracts, rec)
        job.phase = f"The writer is reworking the flagged passages of “{title}”"
        tok = rv.work.begin(pid, rec["module_id"], f"The writer is reworking {title}")
        try:
            raw = self.assist._call_ai(job, op_for_roles=rec["module_id"], task=rubric.REWRITE_TASK,
                                       schema=REWRITE_SCHEMA, context=ctx, protected=protected)
        finally:
            rv.work.end(tok)
        job.check()
        reps = raw.get("replacements") if isinstance(raw, dict) else None
        if not isinstance(reps, list):
            raise BookforgeError("INTERNAL_ERROR", "/replacements", "the writer's answer had no list of replacements; "
                                 "nothing was changed")
        res = apply_replacements(text, reps, findings, keep)
        byf = {f["id"]: f for f in findings}
        items = []
        for a in res["applied"]:
            f = byf.get(a["finding_id"]) or {}
            items.append(dict(a, ok=True, dimension=f.get("dimension"), severity=f.get("severity"),
                              passage=f.get("passage"), why=f.get("why")))
        for u in res["unresolved"]:
            f = byf.get(u["finding_id"]) or {}
            items.append(dict(u, ok=False, dimension=f.get("dimension"), severity=f.get("severity"),
                              passage=f.get("passage"), why=f.get("why")))
        prop = {"record_id": rid, "version": rec["version"], "items": items, "keep": keep, "slot": job.slot,
                "slot_label": job.slot_label, "writer": providers_mod.slot_name(rv._slot(job.slot)) if
                rv._slot(job.slot) else job.slot, "at": _now_iso(), "craft_at": craft.get("at"),
                "applied": len(res["applied"]), "unresolved": len(res["unresolved"])}
        rv._put(f"editor_proposals:{pid}:{branch}", _rkey(rid, rec["version"]), prop)
        return prop

    # ------------------------------------------------------------------ apply (deterministic) -> new draft version
    def apply(self, principal, pid, branch, rid, version, accept=None, *, proposal: dict | None = None,
              round_no: int | None = None, how: str = "author") -> dict:
        """Apply the accepted replacements of a stored proposal to exactly ``version`` and save the result as a new
        DRAFT through the normal UPDATE path. ``accept``: finding ids to use (None = every applicable one)."""
        rv = self.review
        rec = rv._head(pid, branch, rid)
        if rec is None:
            raise BookforgeError("NOT_FOUND", "/record_id", "this chapter no longer exists", status="REJECTED")
        if not isinstance(version, int) or isinstance(version, bool) or version != rec["version"]:
            raise BookforgeError("VERSION_CONFLICT", "/version", f"the chapter changed since the editor's fixes were "
                                 f"made (it is now version {rec['version']}); ask for the fixes again",
                                 status="REJECTED")
        prop = proposal or self.proposals(pid, branch).get(_rkey(rid, version))
        if not prop:
            raise BookforgeError("INVALID_INPUT", "/record_id", "there are no editor's fixes for this version; press "
                                 "✍ Get the editor's fixes first", status="REJECTED")
        craft = self.crafts(pid, branch).get(_rkey(rid, version)) or {}
        text = str((rec.get("data") or {}).get("text") or "")
        wanted = [i for i in prop.get("items") or [] if i.get("ok")]
        if accept is not None:
            if not isinstance(accept, list) or not all(isinstance(x, str) for x in accept):
                raise BookforgeError("INVALID_INPUT", "/accept", "accept: the list of note ids to use",
                                     status="REJECTED")
            wanted = [i for i in wanted if i["finding_id"] in accept]
        if not wanted:
            raise BookforgeError("INVALID_INPUT", "/accept", "no change was chosen, so nothing was changed",
                                 status="REJECTED")
        findings = [f for f in craft.get("findings") or [] if f["id"] in {i["finding_id"] for i in wanted}] or \
            [{"id": i["finding_id"], "passage": i.get("passage") or ""} for i in wanted]
        keep = keep_quotes_of(craft, text, {i["finding_id"] for i in wanted}) if craft else list(prop.get("keep") or [])
        res = apply_replacements(text, [{k: i[k] for k in ("finding_id", "original", "replacement")} for i in wanted],
                                 findings, keep)
        if not res["applied"]:
            raise BookforgeError("INVALID_INPUT", "/accept", "none of the chosen changes could be applied word for "
                                 "word, so nothing was changed", status="REJECTED")
        rejected = [{"finding_id": i["finding_id"], "reason": "REJECTED_BY_AUTHOR",
                     "message": UNRESOLVED_WORDS["REJECTED_BY_AUTHOR"]}
                    for i in prop.get("items") or [] if i.get("ok") and accept is not None
                    and i["finding_id"] not in accept]
        before = self.pattern(pid, branch, rec)
        payload = copy.deepcopy(rec.get("data") or {})
        payload["text"] = res["text"]
        bp = BookPath(self.engine, principal, pid, branch)
        resp = bp.dispatch(rec["module_id"], "UPDATE", base_ref=rec["ref"], payload=payload)
        if resp["status"] != "DRAFT" or not resp.get("output_refs"):
            from .book_path import problems  # noqa: PLC0415
            raise BookforgeError("INVALID_INPUT", "/payload", "the changed chapter did not pass BookForge's checks, so "
                                 "nothing was saved: " + "; ".join(problems(resp))[:400], status="REJECTED")
        new = resp["output_refs"][0]
        rv._put(f"ai_fixes:{pid}:{branch}", _rkey(rid, new["version"]),
                {"slot": prop.get("slot"), "from_version": version, "at": _now_iso(), "editor": True})
        info = {"from_version": version, "to_version": new["version"], "slot": prop.get("slot"), "at": _now_iso(),
                "applied": [a["finding_id"] for a in res["applied"]],
                "unresolved": res["unresolved"] + rejected, "how": how, "round": round_no}
        rv._put(f"editor_rewrites:{pid}:{branch}", _rkey(rid, new["version"]), info)
        with self.store.transaction() as tx:
            tx.insert_outbox(pid, branch, "editor.rewrite", {
                "record_id": rid, "from_version": version, "to_version": new["version"], "module_id": rec["module_id"],
                "applied": len(res["applied"]), "unresolved": len(res["unresolved"]) + len(rejected),
                "ai_slot": prop.get("slot"), "how": how, "round": round_no,
                "label": "Editor's fixes applied by the author (new draft, waits for approval)" if how == "author"
                else "Editor's fixes applied inside a Make-a-book run (checked again before approval)"})
        after_rec = rv._head(pid, branch, rid)
        after = self.pattern(pid, branch, after_rec) if after_rec else None
        return {"ok": True, "record_id": rid, "from_version": version, "version": new["version"], "ref": new,
                "applied": res["applied"], "unresolved": res["unresolved"] + rejected,
                "keep_lost": lost_keeps(text, res["text"], keep),
                "pattern_before": prose_audit.counts_only(before) if before else None,
                "pattern_after": prose_audit.counts_only(after) if after else None,
                "message": f"Saved as version {new['version']} with {len(res['applied'])} change(s). Read it and "
                           "approve it, or ask the editor to look again."}

    def restore(self, principal, pid, branch, rid, old: dict, why_code: str) -> dict:
        """Save the earlier (better) text again as the newest version (a rewrite that was not kept). Its reviews
        are copied: the content is exactly the one they were made for."""
        rv = self.review
        head = rv._head(pid, branch, rid)
        bp = BookPath(self.engine, principal, pid, branch)
        resp = bp.dispatch(head["module_id"], "UPDATE", base_ref=head["ref"], payload=copy.deepcopy(old["data"]))
        if resp["status"] != "DRAFT" or not resp.get("output_refs"):
            from .book_path import problems  # noqa: PLC0415
            raise BookforgeError("INVALID_INPUT", "/payload", "the earlier version could not be saved again: "
                                 + "; ".join(problems(resp))[:300], status="REJECTED")
        new = resp["output_refs"][0]
        at = _now_iso()
        writer = rv.writer_of(pid, branch, old)
        rv._put(f"ai_fixes:{pid}:{branch}", _rkey(rid, new["version"]),
                {"slot": writer.get("slot"), "from_version": head["version"], "restored_from": old["version"], "at": at})
        for key in (f"ai_reviews:{pid}:{branch}", f"craft_reviews:{pid}:{branch}", f"planned_checks:{pid}:{branch}"):
            prev = (self.store.get_setting(key) or {}).get(_rkey(rid, old["version"]))
            if prev:
                rv._put(key, _rkey(rid, new["version"]), dict(prev, version=new["version"],
                                                               copied_from_version=old["version"], at=at))
        with self.store.transaction() as tx:
            tx.insert_outbox(pid, branch, "editor.rewrite_rejected", {
                "record_id": rid, "rejected_version": head["version"], "restored_from": old["version"],
                "to_version": new["version"], "module_id": head["module_id"], "why": why_code,
                "label": "The editor's rewrite was not kept; the earlier text is the newest version again"})
        return new
