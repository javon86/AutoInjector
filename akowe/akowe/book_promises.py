"""📜 What the author promised the reader — content limits, themes, the central question, point of view and tense
(holes H3 and H10, docs/HOLES_2026-11.md).

H3. The book profile's ``content_limits`` ("no graphic violence"), ``themes`` and ``central_question`` used to stop
at the Book Bible. Now they reach:

* every AI that gets the book profile (assist.book_profile_brief → ``brief``) — the writer, the reviewer, the
  editor, the planners;
* the chapter instruction itself (book_path.prepare_chapter → ``instruction``), so a writer that skims the context
  still reads them;
* the AI reviewer (``REVIEW_RULE`` + the review schema's optional ``content_limits_breach``): a draft that shows what
  the author ruled out is a REVISE, never APPROVE, and never auto-approved (``enforce_review``);
* the editor's rubric dimension ``content_limits`` ("respects the author's content limits"): any finding there makes
  the editor's verdict REVISE whatever the strictness (editor.decide).

H10. Point of view and tense are decided when the book is invented (``decide``: the profile's ``pov`` / ``tense``,
else a default from the genre), written into every brief and checked on every chapter with a cheap count
(style_card.stats: pronouns and verbs outside dialogue). A chapter that clearly switches (first person in a
third-person book, present tense in a past-tense one) is a REVISE (``pov_tense_problem``).
"""
from __future__ import annotations

import re

POV = {"first": "first person (“I”), told by the main character",
       "third": "third person (“she”, “he”, “they”), close to the viewpoint character of each chapter"}
TENSE = {"past": "past tense (“she walked”)", "present": "present tense (“she walks”)"}
POV_WORDS = {"first": "first person", "third": "third person"}
# Genres whose readers most often expect first person (else third person); tense is past unless the author says so.
FIRST_PERSON_GENRES = ("young adult", "ya", "new adult", "romance", "memoir", "chick lit", "diary")
MIN_EVIDENCE = 8          # pronoun / verb hits outside dialogue before a chapter can be called "switched"

REVIEW_RULE = (
    " When context.book_profile.content_limits is given, it lists what the author will NOT have in the book: a draft "
    "that shows any of it is a REVISE (never APPROVE) — say which limit in reasons (start that reason with "
    "\"Content limits:\") and set content_limits_breach to a short description of what crosses the line (empty when "
    "nothing does). When context.book_profile.point_of_view / tense are given, a chapter told in another person or "
    "tense is a REVISE as well.")

def _clean_text(v, n: int) -> str:
    return " ".join(str(v or "").split())[:n]


def clean(key: str, value):
    """Profile values ``pov`` / ``tense``: one of the choices, or "" (let Akọwe choose from the genre)."""
    v = str(value or "").strip().lower()
    v = {"first person": "first", "1st": "first", "third person": "third", "3rd": "third"}.get(v, v)
    choices = POV if key == "pov" else TENSE
    if v and v not in choices:
        from .errors import AkoweError  # noqa: PLC0415
        raise AkoweError("INVALID_INPUT", f"/{key}", f"{key}: " + " or ".join(choices) + " (or empty: Akọwe chooses)",
                         status="REJECTED")
    return v


def default_pov(genre: str | None) -> str:
    g = (genre or "").lower()
    return "first" if any(re.search(rf"\b{re.escape(k)}\b", g) for k in FIRST_PERSON_GENRES) else "third"


def decide(profile: dict | None) -> dict:
    """{pov, tense, from}: the author's choice, else the genre's default (third person / past for most books)."""
    p = profile or {}
    pov = p.get("pov") if p.get("pov") in POV else None
    tense = p.get("tense") if p.get("tense") in TENSE else None
    return {"pov": pov or default_pov(p.get("genre")), "tense": tense or "past",
            "from": "you" if pov and tense else "the genre" if not pov and not tense else "you and the genre"}


def brief(profile: dict | None) -> dict:
    """The promises for an AI's book_profile context (only what is set)."""
    p = profile or {}
    out = {}
    if _clean_text(p.get("content_limits"), 1000):
        out["content_limits"] = _clean_text(p["content_limits"], 1000)
    themes = [_clean_text(t, 120) for t in (p.get("themes") or []) if _clean_text(t, 120)] \
        if isinstance(p.get("themes"), list) else []
    if themes:
        out["themes"] = themes[:3]
    if _clean_text(p.get("central_question"), 300):
        out["central_question"] = _clean_text(p["central_question"], 300)
    d = decide(p)
    out["point_of_view"] = POV[d["pov"]]
    out["tense"] = TENSE[d["tense"]]
    return out


def instruction(profile: dict | None) -> str:
    """The part of the chapter instruction (book_path.prepare_chapter) that the writer must not miss."""
    b = brief(profile)
    bits = [f"Point of view: {POV_WORDS[decide(profile)['pov']]}, {decide(profile)['tense']} tense (keep it in every "
            "chapter)"]
    if b.get("content_limits"):
        bits.append(f"Content limits (never show this): {b['content_limits']}")
    if b.get("themes"):
        bits.append("Themes: " + "; ".join(b["themes"]))
    if b.get("central_question"):
        bits.append(f"The book's central question: {b['central_question']}")
    return ". ".join(bits)


# ====================================================================== the reviewer: a breach is a REVISE
def enforce_review(verdict: dict, profile: dict | None) -> dict:
    """The reviewer said a content limit was crossed (``content_limits_breach`` or a reason starting "Content
    limits:"): the verdict is REVISE whatever the AI's verdict said. Returns the (maybe changed) verdict."""
    if not (profile or {}).get("content_limits"):
        return verdict
    breach = _clean_text(verdict.get("content_limits_breach"), 300)
    said = [r for r in verdict.get("reasons") or [] if str(r).lower().startswith("content limit")]
    if breach or said:
        v = dict(verdict)
        if v.get("verdict") == "APPROVE":
            v["verdict"] = "REVISE"
            v["verdict_changed"] = "APPROVE → REVISE: a content limit is crossed"
        if breach and not said:
            v["reasons"] = [f"Content limits: {breach}"] + list(v.get("reasons") or [])[:7]
        v["content_limits_breach"] = breach or said[0]
        if not v.get("suggested_changes"):
            v["suggested_changes"] = ["Rewrite the passage so it stays inside the author's content limits."]
        return v
    return verdict


# ====================================================================== H10: a cheap point-of-view / tense check
def pov_tense_of(text: str) -> dict:
    from .style_card import _QUOTED, words  # noqa: PLC0415
    narration = _QUOTED.sub(" ", text or "")
    nw = [w.lower() for w in words(narration)]
    first = sum(1 for w in nw if w in ("i", "me", "my", "mine", "myself"))
    third = sum(1 for w in nw if w in ("he", "she", "him", "her", "his", "hers", "they", "them", "their"))
    past = sum(1 for w in nw if w in ("was", "were", "had", "did", "said") or (len(w) > 4 and w.endswith("ed")))
    present = sum(1 for w in nw if w in ("is", "are", "am", "has", "does", "says"))
    return {"first": first, "third": third, "past": past, "present": present,
            "pov": "first" if first >= max(MIN_EVIDENCE // 2, third * 0.5) and first else "third",
            "tense": "present" if present > past * 1.2 and present >= MIN_EVIDENCE // 2 else "past"}


def pov_tense_problem(text: str, profile: dict | None) -> str | None:
    """A plain problem when the chapter clearly switches person or tense, else None."""
    want = decide(profile)
    got = pov_tense_of(text)
    out = []
    if want["pov"] == "third" and got["first"] >= MIN_EVIDENCE and got["first"] > got["third"]:
        out.append(f"it is told in the first person (“I”: {got['first']} times outside dialogue) but the book is in "
                   "the third person")
    elif want["pov"] == "first" and got["first"] < 2 and got["third"] >= MIN_EVIDENCE:
        out.append("it is told in the third person but the book is in the first person (“I”)")
    if want["tense"] == "past" and got["present"] >= MIN_EVIDENCE and got["present"] > got["past"] * 1.2:
        out.append(f"it is in the present tense ({got['present']} present verbs to {got['past']} past) but the book "
                   "is in the past tense")
    elif want["tense"] == "present" and got["past"] >= MIN_EVIDENCE and got["past"] > got["present"] * 1.5:
        out.append("it is in the past tense but the book is in the present tense")
    if not out:
        return None
    return "Point of view / tense: " + "; ".join(out) + \
        f". Keep the book's {POV_WORDS[want['pov']]}, {want['tense']} tense."
