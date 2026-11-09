"""🔁 The review / fix loop: when it goes round in circles, ONE clear decision for the author instead.

Why (the Ansel case, Nov 2026): the AI reviewer rightly flagged a contradiction in a character record ("eight at his
father's wake" vs "about ten when his mother died"), the writer fixed it correctly, and the reviewer then refused the
fix twice because it "changed the character sheet" — the notes the AI had written together with the EARLIER draft.
The run stopped with "needs your decision", waited half an hour, and moved on with the record never approved.

Two things fix that:

* ``review.py`` judges a revision against approved canon only (the previous draft and the AI's own notes are labelled
  NOT canon; the reviewer gets its earlier findings and is told to accept a change that resolves them).
* This module is the safety net in ``autobook._review_until_approved``: when the same finding comes back REVISE in two
  reviews in a row with a fix in between (``same_finding``), or the reviewer says only an APPROVED or LOCKED fact
  elsewhere could fix it (``canon_change``), the run stops the loop and asks ONE specific question
  (``decision``): what changed (before → after, from the two versions themselves), why, and three choices —
  accept the change, keep the original, or edit it yourself. The record stays unapproved until the author chooses.

Everything here is plain text work: no AI call. Book text stays in the run (the author's own book, shown to the
author); logs and outbox events get codes and numbers only.
"""
from __future__ import annotations

import re

STOP = frozenset("""
about above after again against also among another because been before being below between both could
does doing done down during each either else even every from further have having here into itself just like
made make many more most much must need needs never only other ought over same should since some such than
that their them then there these they this those through under until upon very want were what when where which
while whom whose will with within without would your yours draft record reviewer review story book character
characters change changes changed changing keep keeps kept detail details established supplied sheet approval
approved explicit specific properly clearly currently instead still remain remains preserve preserving
""".split())
NEG = re.compile(r"\b(contradict|conflict|inconsisten|mismatch|missing|omit|lacks?|not |never|incorrect|wrong|must|"
                 r"should|needs?|reconcil|restore|resolve|replace|fix|problem|error|cannot|can't|doesn't|does not)",
                 re.I)
SENT = re.compile(r"(?<=[.!?…])\s+")
CLIP = 170


def clip(text, n: int = CLIP) -> str:
    """Plain text cut at a word boundary with … (never mid-word)."""
    x = " ".join(str(text or "").split())
    if len(x) <= n:
        return x
    cut = x[:n - 1]
    sp = cut.rfind(" ")
    return (cut[:sp] if sp > n * 0.5 else cut).rstrip(" ,;:.-–—") + "…"


def tokens(text, ignore=()) -> set[str]:
    out = set()
    for w in re.findall(r"[a-zà-ÿ][a-zà-ÿ'’-]+", str(text or "").lower()):
        w = re.sub(r"['’]s$", "", w).strip("'’-")
        if len(w) > 4 and w.endswith("s") and not w.endswith("ss"):
            w = w[:-1]
        if len(w) >= 4 and w not in STOP and w not in ignore:
            out.add(w)
    return out


def findings(review: dict | None) -> list[str]:
    """What the reviewer asked to change: its suggested changes, plus the reasons that name a problem."""
    r = review or {}
    out = [str(x) for x in r.get("suggested_changes") or [] if str(x).strip()]
    out += [str(x) for x in r.get("reasons") or [] if NEG.search(str(x))]
    return out[:16]


def flatten(data, prefix: str = "", out: dict | None = None, depth: int = 0) -> dict[str, str]:
    """{path: text} for the text fields of a record (references and ids left out)."""
    out = {} if out is None else out
    if depth > 5:
        return out
    if isinstance(data, dict):
        if {"record_id", "version"} <= set(data):  # a reference object
            return out
        for k, v in data.items():
            if k in ("record_id", "subject_id", "chapter_id", "content_hash", "id"):
                continue
            flatten(v, f"{prefix}.{k}" if prefix else str(k), out, depth + 1)
    elif isinstance(data, list):
        for i, v in enumerate(data[:40]):
            flatten(v, f"{prefix}[{i}]", out, depth + 1)
    elif isinstance(data, str) and len(data.strip()) > 3:
        out[prefix] = data
    return out


def changed_fields(prev: dict | None, cur: dict | None) -> dict[str, tuple[str, str]]:
    a, b = flatten(prev or {}), flatten(cur or {})
    return {k: (a.get(k, ""), b.get(k, "")) for k in set(a) | set(b) if a.get(k, "") != b.get(k, "")}


def _overlap(a: set, b: set) -> tuple[int, float]:
    if not a or not b:
        return 0, 0.0
    n = len(a & b)
    return n, n / min(len(a), len(b))


def same_finding(prev_review: dict | None, cur_review: dict | None, prev_data=None, cur_data=None,
                 ignore=()) -> dict | None:
    """The finding of ``cur_review`` that is the same as one of ``prev_review`` (the review the fix in between was
    meant to answer), or None. Same = the same words (≥3 shared, at least half of the shorter one), or ≥3 shared
    words about the same field that the fix changed (the reviewer words it differently the second time)."""
    ign = set(ignore)
    pf, cf = findings(prev_review), findings(cur_review)
    if not pf or not cf:
        return None
    fields = changed_fields(prev_data, cur_data)
    ftok = {k: tokens(old + " " + new, ign) for k, (old, new) in fields.items()}
    best = None
    for a in pf:
        ta = tokens(a, ign)
        for b in cf:
            tb = tokens(b, ign)
            n, ratio = _overlap(ta, tb)
            if n < 3:
                continue
            field = None
            for k, tf in ftok.items():
                if len(ta & tf) >= 3 and len(tb & tf) >= 3:
                    field = k
                    break
            if ratio >= 0.5 or field:
                score = n + ratio + (1 if field else 0)
                if best is None or score > best["score"]:
                    best = {"score": score, "first": a, "again": b, "field": field}
    return best


def best_reason(review: dict | None, hint: str) -> str:
    """The reviewer's reason (a problem it names) closest to ``hint`` — the plain "what is wrong"."""
    ht = tokens(hint)
    reasons = [str(x) for x in (review or {}).get("reasons") or [] if NEG.search(str(x))]
    if not reasons:
        return ""
    best = max(reasons, key=lambda r: len(tokens(r) & ht))
    return best if len(tokens(best) & ht) >= 2 else ""


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in SENT.split(str(text or "")) if s.strip()]


def change_of(prev_data, cur_data, hint: str = "", field: str | None = None, ignore=()) -> dict | None:
    """What the fix changed, in the author's words: {field, before, after} — the sentence the fix took out and the one
    it put in (the pair closest to ``hint``, the finding), from the two versions themselves. None: nothing changed."""
    fields = changed_fields(prev_data, cur_data)
    if not fields:
        return None
    ht = tokens(hint, set(ignore))
    order = sorted(fields, key=lambda k: (k != field, -len(tokens(" ".join(fields[k]), set(ignore)) & ht)))
    k = order[0]
    old, new = fields[k]
    so, sn = _sentences(old), _sentences(new)
    gone = [s for s in so if s not in sn] or so
    came = [s for s in sn if s not in so] or sn
    before = max(gone, key=lambda s: len(tokens(s) & ht), default="")
    bt = tokens(before) | ht
    after = max(came, key=lambda s: len(tokens(s) & bt), default="")
    return {"field": field_label(k), "path": k, "before": clip(before), "after": clip(after)}


def field_label(path: str) -> str:
    """'attributes.background' -> 'background'; 'text' -> 'text'; 'facts[3].value' -> 'facts'."""
    last = re.sub(r"\[\d+\]", "", str(path or "")).split(".")
    word = next((p for p in reversed(last) if p not in ("value", "text", "summary") and p), last[-1] if last else "")
    return word.replace("_", " ") or "text"


def decision(*, kind: str, subject: str, review: dict, prev_review: dict | None, match: dict | None,
             prev_data=None, cur_data=None, can_keep: bool, ignore=()) -> dict:
    """The one decision for the author (the fields of the run's problem): what, before → after, why, the choices.
    ``kind``: ``loop`` (the same finding came back after a fix) | ``canon`` (an approved / locked fact would change)."""
    cc = review.get("canon_change") or {}
    hint = " ".join(x for x in ((match or {}).get("first"), (match or {}).get("again"), cc.get("before"),
                                cc.get("after")) if x)
    ch = change_of(prev_data, cur_data, hint, (match or {}).get("field"), ignore) if prev_data is not None else None
    if not ch and cc:
        ch = {"field": cc.get("field") or "detail", "path": None, "before": clip(cc.get("before")),
              "after": clip(cc.get("after"))}
    first = (match or {}).get("first") or next(iter(findings(prev_review)), "") or next(iter(findings(review)), "")
    problem = best_reason(prev_review, first) or best_reason(review, first) or first
    wrong = clip(problem, 220)
    why = clip(cc.get("approved_fact") or problem, 220)
    if kind == "canon":
        stop = "This would change an approved fact, so only you can decide."
    else:
        stop = "The reviewer and the writer disagreed twice about the same thing, so it needs you."
    options = ["accept_change"] + (["keep_original"] if can_keep else []) + ["edit"]
    return {"kind": kind, "subject": subject, "change": ch, "why": why, "wrong": wrong, "stop": stop,
            "options": options, "still_unapproved": True}


CHOICE_WORDS = {"accept_change": "✔ Accept change", "keep_original": "↩ Keep the original",
                "edit": "✏️ Let me edit", "approve_anyway": "✔ Approve anyway", "retry": "🔁 Try again"}
