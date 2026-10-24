"""The writing brief of one chapter: what the C02 writer (and the editor) get besides the outline and the C01 context.

* ``pov``: the narrator / point-of-view character — name, who they are, their planned backstory (A01 identity,
  background, role and FACT facts) and the instruction that the name and at least one planned detail reach the page
  (P11-lite: in the first book the narrator's planned name and backstory never appeared).
* ``voice_cards`` / ``other_voices``: the voice cards (P17) and the sheet essentials (P7) of the characters present in
  this chapter (POV, the scene cards' characters, names the outline chapter mentions; all characters when none can be
  told), bounded by ``characters.voice_brief`` (full cards for at most 4, one line each for the rest, a hard size).
* ``scene_cards``: the chapter's scene cards (P8) when they were made for this outline revision.
* ``planned_details``: outline facts of this chapter that concern a character (planned names and details).
* ``rules``: how to use all of this, in plain sentences.

Pure reads of the store (records and companion settings); never calls an AI, never raises (a missing brief must never
stop a chapter from being written).
"""
from __future__ import annotations

import json
import logging

from . import characters as chars_mod
from . import scenes as scenes_mod

log = logging.getLogger("bookforge.chapter_brief")

MAX_PLANNED = 10
RULES = {
    "scenes": ("Write the chapter scene by scene from context.writing_brief.scene_cards, in order: show each scene's "
               "place and time; every character present pushes for their own goal (the hidden agenda stays hidden — "
               "show it in what they do, avoid or bargain for); the obstacle from the world really gets in the way and "
               "costs something; the change happens; the 'unsaid' stays unsaid (never stated by a character or the "
               "narrator)."),
    "voices": ("Dialogue: every character talks as their voice card says (context.writing_brief.voice_cards: rhythm, "
               "register, vocabulary, favourite phrases, habits, how they talk under pressure, what they talk around); "
               "never give two characters the same calm, explaining register; nobody uses their never_words; nobody "
               "announces their feelings. With the names hidden, a reader should still know who speaks."),
    "pov": ("The point-of-view character is context.writing_brief.pov: use their name on the page (in dialogue or "
            "narration) and let at least one planned detail of their backstory (pov.backstory) show in this chapter "
            "when it fits — through action or memory, not a summary."),
    "planned": ("Planned details in context.writing_brief.planned_details belong in this chapter: make them reach "
                "the page."),
}


def _clip(v, n: int = 300) -> str:
    return " ".join(str(v or "").split())[:n]


def _chapter_item(outline: dict, chapter_id: str) -> dict | None:
    for it in (outline.get("data") or {}).get("chapters") or []:
        for f in it.get("facts") or []:
            if isinstance(f, dict) and f.get("predicate") == "plan.item_id" and f.get("value") == chapter_id \
                    and f.get("subject_id") == chapter_id:
                return it
    return None


def _pov_view(c: dict) -> dict:
    attrs = c.get("attributes") or {}
    backstory = [_clip(attrs[k]) for k in ("background", "identity", "goals") if isinstance(attrs.get(k), str)
                 and attrs[k].strip()]
    backstory += [f"{f.get('predicate')}: {_clip(f.get('value'), 160)}" for f in c.get("facts") or []
                  if f.get("assertion_type") == "FACT" and f.get("predicate") != "entity.name"
                  and f.get("subject_id") == c["subject_id"]][:6]
    return {"name": c["name"], "id": c["subject_id"], "role": _clip(attrs.get("role"), 200),
            "backstory": backstory[:8]}


def build(store, pid: str, branch: str, outline: dict | None, chapter_id: str) -> tuple[dict | None, dict]:
    """(brief or None, meta) for one outline chapter. meta = numbers and IDs only (stored with the chapter)."""
    meta = {"characters": [], "voice_cards": 0, "summarized": False, "scene_cards": None, "pov": None, "chars": 0}
    try:
        if not outline or not isinstance(outline.get("data"), dict):
            return None, meta
        item = _chapter_item(outline, chapter_id) or {}
        facts = [f for f in item.get("facts") or [] if isinstance(f, dict)]
        fv = {f.get("predicate"): f.get("value") for f in facts if f.get("subject_id") == chapter_id}
        cs = chars_mod.canon_characters(store, pid, branch, approved_only=True) or \
            chars_mod.canon_characters(store, pid, branch)
        pov_id = fv.get("plan.pov_id")
        pov = next((c for c in cs if pov_id and pov_id in (c["subject_id"], c["record_id"])), None)
        entry = scenes_mod.get_entry(store, pid, branch, outline["record_id"], chapter_id)
        cards = scenes_mod.brief_cards(entry) if scenes_mod.usable(entry, outline) else []
        names = [n for c in cards for n in (c.get("characters") or [])] + \
            [g.get("character") for c in cards for g in (c.get("goals") or [])]
        texts = [str(fv.get("plan.objective") or ""), str(item.get("summary") or "")] + \
            [str(f.get("value")) for f in facts if isinstance(f.get("value"), str)]
        ids = [pov_id] + [f.get("subject_id") for f in facts] + \
            [v for f in facts for v in (f.get("value") if isinstance(f.get("value"), list) else [f.get("value")])
             if isinstance(v, str)]
        present = chars_mod.present_in(cs, *texts, *[n for n in names if n], ids=ids)
        if pov and pov not in present:
            present.insert(0, pov)
        if not present:
            present = list(cs)
        vb = chars_mod.voice_brief(store, pid, branch, present, first=pov["record_id"] if pov else None)
        char_ids = {c["subject_id"] for c in cs} | {c["record_id"] for c in cs}
        planned = []
        for f in facts:
            if f.get("subject_id") == chapter_id and str(f.get("predicate") or "").startswith("plan."):
                continue
            if f.get("subject_id") in char_ids or str(f.get("predicate") or "").startswith("entity."):
                planned.append(f"{f.get('subject_id')} {f.get('predicate')}: {_clip(f.get('value'), 200)}")
            if len(planned) >= MAX_PLANNED:
                break
        brief = {"pov": _pov_view(pov) if pov else None, "voice_cards": vb["cards"], "other_voices": vb["others"],
                 "scene_cards": cards, "planned_details": planned}
        rules = []
        if cards:
            rules.append(RULES["scenes"])
        if vb["cards"] or vb["others"]:
            rules.append(RULES["voices"])
        if pov:
            rules.append(RULES["pov"])
        if planned:
            rules.append(RULES["planned"])
        brief["rules"] = rules
        if not (cards or vb["cards"] or vb["others"] or pov or planned):
            return None, meta
        meta.update(characters=[c["record_id"] for c in present], voice_cards=len(vb["cards"]),
                    other_voices=len(vb["others"]), summarized=vb["summarized"],
                    scene_cards={"version": entry["version"], "status": entry.get("status"), "scenes": len(cards)}
                    if cards else None, pov=pov["record_id"] if pov else None,
                    chars=len(json.dumps(brief, ensure_ascii=False)))
        return brief, meta
    except Exception:  # noqa: BLE001 - a brief is help for the writer, never a reason to fail the chapter
        log.exception("could not build the writing brief of chapter %s", chapter_id)
        return None, meta
