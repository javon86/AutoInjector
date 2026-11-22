"""🧭 Scope guards: each chapter keeps to the story it was planned with (no AI of its own).

Why (docs: "AI novel quality beyond eight", recommendation 7): scope problems are usually too much *story* per scene —
a new named character, a new place, a new thread or a new power that turns up late and that nothing set up. Akọwe's
length guard controls words, not story.

How it works, in a ⚡ Make-a-book run (run setting ``scope_guard``, default on):

1. **Before drafting** (``build``, once per outline revision, right after the outline step; deterministic): Akọwe
   stores where the late part of the book starts (``LATE_FRACTION`` — about 70%). From there on each chapter's writer
   brief gets a ``scope`` block (``writer_block``): the characters and places this chapter's plan uses (outline
   chapter, scene cards, viewpoint, the chapter's place) and the rule that NO new named character, place, plot
   thread, secret or magic / technology may start unless the plan has it (``WRITER_RULE``). Earlier chapters get
   their cast through the voice cards and scene cards already (and every brief byte counts).
2. **After drafting** (``new_names``; no AI): the proper names on the page of a LATE chapter that the book has never
   used — not in the canon, the plan, the scene cards, the story rules, the world texture, the story ledger's name
   list or any earlier chapter — are scope-creep candidates. story_guards.py has them confirmed (one bounded AI call
   per chapter, only when there is a candidate) and gives a confirmed one in an AI-made chapter one targeted fix
   through the P5 rewrite machinery; anything else is listed for the author and in the book report.

Stored with the outline (setting ``scope_guard:<project>:<branch>``, keyed by the outline's record and version).
Pure logic plus storage; never raises into the caller; logs carry counts only.
"""
from __future__ import annotations

import copy
import json
import logging
import math
import re
from datetime import datetime, timezone

log = logging.getLogger("akowe.scope_guard")

LATE_FRACTION = 0.7      # from about 70% of the book on, nothing new may start unless the plan has it
MAX_NAMES = 6            # new-name candidates per chapter
MAX_PLAN_NAMES = 12      # characters / places listed in one chapter's scope block
NAME_CHARS = 80

WRITER_RULE = (
    "Scope (context.writing_brief.scope): this chapter is in the last part of the book — start nothing new. Use the "
    "cast and places of its plan (plan_characters, plan_places, the outline, the scene cards) and of earlier "
    "chapters; no new named character, place, plot thread, secret or magic / technology the plan does not have; a "
    "passer-by stays unnamed.")

# capitalised words that are never a name on their own (besides story_ledger.STOP and the sentence starters)
COMMON = {"January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
          "November", "December", "Mister", "Miss", "Madam", "Master", "Mistress", "Aunt", "Uncle", "Mother", "Father",
          "Mama", "Papa", "Gran", "Granny", "Grandma", "Grandpa", "Sister", "Brother", "Ma", "Pa", "King", "Queen",
          "Prince", "Princess", "Saint", "Heaven", "Hell", "Okay", "Yes", "Oh", "Ah", "Hey", "Well", "Good", "Please",
          "Thank", "Thanks", "Sorry", "Look", "Listen", "Come", "Go", "Stop", "Wait", "Don't", "Didn't", "Can't",
          "Won't", "I'm", "I'd", "I'll", "It's", "That's", "There's", "What's", "Maybe", "Perhaps", "Never", "Always",
          "Everyone", "Anyone", "Nothing", "North", "South", "East", "West", "English", "Monday", "Tuesday"}
_CAP = re.compile(r"\b[A-Z][a-zà-ÿ'’-]+")
_SETTING_KEYS = ("scene_cards", "story_rules", "world_texture", "characters", "story_details", "forge",
                 "bible_fields", "promise_ledger", "knowledge_grid")


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _key(pid: str, branch: str) -> str:
    return f"scope_guard:{pid}:{branch}"


def stored(store, pid: str, branch: str) -> dict | None:
    try:
        v = store.get_setting(_key(pid, branch))
    except Exception:  # noqa: BLE001
        return None
    return v if isinstance(v, dict) else None


def forget(store, pid: str, branch: str) -> None:
    store.set_setting(_key(pid, branch), None)


def _chapters(outline: dict | None) -> list[dict]:
    from .book_path import BookPath  # noqa: PLC0415
    return BookPath.outline_chapters(None, outline) if outline else []


def late_from(n: int | None) -> int | None:
    """The first chapter (1-based) of the late part of a book of ``n`` chapters (None for fewer than 3)."""
    try:
        n = int(n)
    except (TypeError, ValueError):
        return None
    if n < 3:
        return None
    return max(2, min(n, math.ceil(LATE_FRACTION * n)))


# ====================================================================== before drafting
def build(store, pid: str, branch: str, outline: dict | None) -> dict | None:
    """Store the scope guard for this outline revision (deterministic). None for an outline it cannot use."""
    chs = _chapters(outline)
    if not outline or not chs:
        return None
    entry = {"outline": outline["record_id"], "version": outline["version"], "chapters": len(chs),
             "late_from": late_from(len(chs)), "at": _now()}
    store.set_setting(_key(pid, branch), entry)
    return copy.deepcopy(entry)


def current(store, pid: str, branch: str, outline: dict | None) -> dict | None:
    e = stored(store, pid, branch)
    if not e or not outline or e.get("outline") != outline.get("record_id") or e.get("version") != \
            outline.get("version") or e.get("chapters") != len(_chapters(outline)):
        return None
    return copy.deepcopy(e)


def _place_names(store, pid: str, branch: str) -> dict:
    """{subject id / record id: name} of the book's places (A04)."""
    from . import characters as chars_mod  # noqa: PLC0415
    out = {}
    try:
        for r in store.list_records(pid, branch, module_id="A04"):
            if r.get("record_kind") != "OUTPUT" or r["lifecycle"] in ("REJECTED", "SUPERSEDED"):
                continue
            rec = store.get_record(pid, branch, r["record_id"], r["approved_version"]) if r.get("approved_version") \
                else r
            name, subject = chars_mod._name_and_subject(rec or r)  # noqa: SLF001
            out[subject] = out[r["record_id"]] = name
    except Exception:  # noqa: BLE001
        log.debug("could not read the places", exc_info=True)
    return out


def chapter_scope(store, pid: str, branch: str, outline: dict, chapter_id: str) -> dict | None:
    """{number, of, characters: [names], places: [names]} — what this chapter's plan uses."""
    from . import planned as planned_mod  # noqa: PLC0415
    from . import scenes as scenes_mod  # noqa: PLC0415
    infos = planned_mod.chapters_info(planned_mod.shim(store, pid, branch), outline)
    me = next((c for c in infos if c["chapter_id"] == chapter_id), None)
    if me is None:
        return None
    names = [c["name"] for c in me.get("present") or []]
    places = []
    loc = next((f.get("value") for f in (me.get("item") or {}).get("facts") or [] if isinstance(f, dict)
                and f.get("predicate") == "plan.location_id" and f.get("subject_id") == chapter_id), None)
    if isinstance(loc, str) and loc:
        pn = _place_names(store, pid, branch).get(loc)
        if pn:
            places.append(pn)
    entry = scenes_mod.get_entry(store, pid, branch, outline["record_id"], chapter_id)
    if scenes_mod.usable(entry, outline):
        for card in entry.get("cards") or []:
            for n in card.get("characters") or []:
                if isinstance(n, str) and n.strip() and n.strip() not in names:
                    names.append(n.strip())
            p = str(card.get("place") or "").strip()
            if p and p not in places:
                places.append(p)
    clip = (lambda xs: [str(x)[:NAME_CHARS] for x in xs][:MAX_PLAN_NAMES])  # noqa: E731
    return {"number": me["number"], "of": me["of"], "characters": clip(names), "places": clip(places)}


def writer_block(store, pid: str, branch: str, outline: dict | None, chapter_id: str) -> dict | None:
    """The chapter brief's ``scope`` block for a chapter in the late part of the book, or None (an earlier chapter, no
    guard for this outline revision; never raises)."""
    try:
        e = current(store, pid, branch, outline)
        if not e:
            return None
        sc = chapter_scope(store, pid, branch, outline, chapter_id)
        if not sc:
            return None
        if not (e.get("late_from") and sc["number"] >= e["late_from"]):
            return None  # the early chapters' cast already comes with their voice cards and scene cards
        return {"plan_characters": sc["characters"], "plan_places": sc["places"], "late_in_book": True}
    except Exception:  # noqa: BLE001 - a brief part is help, never a reason to fail the chapter
        log.exception("scope guard of chapter %s", chapter_id)
        return None


# ====================================================================== after drafting (no AI)
def _caps(text: str) -> set[str]:
    return {re.sub(r"['’]s$", "", w).lower() for w in _CAP.findall(text or "")}


def known_words(store, pid: str, branch: str, earlier_texts=(), exclude_chapter: str | None = None) -> set[str]:
    """Every capitalised word the book already has (lower case): the canon and the plan (every record but the
    chapters), the companion data (scene cards, rules, texture, sheets, details …), the story ledger's names of the
    OTHER chapters (``exclude_chapter`` is the one being checked) and the chapters before this one."""
    from . import story_ledger  # noqa: PLC0415
    words: set[str] = set()
    try:
        for r in store.list_records(pid, branch):
            if r.get("module_id") == "C02" or r.get("record_kind") != "OUTPUT" or r["lifecycle"] in ("REJECTED",):
                continue
            rec = store.get_record(pid, branch, r["record_id"], r["approved_version"]) if r.get("approved_version") \
                else r
            words |= _caps(json.dumps((rec or r).get("data") or {}, ensure_ascii=False))
    except Exception:  # noqa: BLE001
        log.debug("could not read the records for the known names", exc_info=True)
    for k in _SETTING_KEYS:
        try:
            v = store.get_setting(f"{k}:{pid}:{branch}")
        except Exception:  # noqa: BLE001
            v = None
        if v:
            words |= _caps(json.dumps(v, ensure_ascii=False))
    try:
        for cid, e in (story_ledger.get_all(store, pid, branch).get("chapters") or {}).items():
            if cid != exclude_chapter and isinstance(e, dict):
                words |= _caps(json.dumps(e.get("names") or [], ensure_ascii=False))
    except Exception:  # noqa: BLE001
        log.debug("could not read the story ledger's names", exc_info=True)
    for t in earlier_texts or ():
        for n in story_ledger.found_names(t):
            words |= {w.lower() for w in re.split(r"\s+", n) if w}
    return words


def _common() -> set[str]:
    from . import story_ledger  # noqa: PLC0415
    return {w.lower() for w in story_ledger.STOP | story_ledger._STARTERS | COMMON}  # noqa: SLF001


def new_names(text: str, known: set[str]) -> list[str]:
    """Proper names on this page the book has never used: no word of the name (3+ letters) is known."""
    from . import story_ledger  # noqa: PLC0415
    common = _common()
    out = []
    for n in story_ledger.found_names(text):
        ws = [re.sub(r"['’]s$", "", w).lower() for w in re.split(r"\s+", n) if w]
        ws = [w for w in ws if len(w) >= 3 and w not in common]
        if not ws or any(w in known for w in ws):
            continue
        if any(n in o or o in n for o in out):
            continue
        out.append(n[:NAME_CHARS])
        if len(out) >= MAX_NAMES:
            break
    return out


def is_late(store, pid: str, branch: str, outline: dict | None, number: int) -> bool:
    e = current(store, pid, branch, outline)
    return bool(e and e.get("late_from") and number >= e["late_from"])
