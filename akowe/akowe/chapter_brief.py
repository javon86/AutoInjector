"""The writing brief of one chapter: what the C02 writer (and the editor) get besides the outline and the C01 context.

* ``pov``: the narrator / point-of-view character — name, who they are, their planned backstory (A01 identity,
  background, role and FACT facts) and the instruction that the name and at least one planned detail reach the page
  (P11-lite: in the first book the narrator's planned name and backstory never appeared).
* ``voice_cards`` / ``other_voices``: the voice cards (P17) and the sheet essentials (P7) of the characters present in
  this chapter (POV, the scene cards' characters, names the outline chapter mentions; all characters when none can be
  told), bounded by ``characters.voice_brief`` (full cards for at most 4, one line each for the rest, a hard size).
* ``scene_cards``: the chapter's scene cards (P8) when they were made for this outline revision.
* ``planned_details``: outline facts of this chapter that concern a character (planned names and details).
* ``story_rules`` (P9): the story-rules ledger entries this chapter needs (hard rules and protected mysteries first,
  then beliefs / things seen to happen its plan mentions), bounded by ``story_rules.chapter_rules``.
* ``world_texture`` (P10): a few world details (the ones its scene cards use first), each with what it can cause.
* ``must_show`` (P11): "must reach the page" details of the character sheets assigned to this chapter.
* ``story_choices`` (P12): the author's style choices (and the ending-state matrix in the last chapter).
* ``length`` (P15): the chapter's word target, scenes and words per scene, and whether it is written scene by scene.
* ``narrator_style`` (P25): the author's own style card (style_card.py) when the book writes in the author's style.
* ``character_details`` (B5): accepted Character Forge dossier fields with only the letters the chapter needs (E; A on
  a character's first appearance; F / M when the plan reads like a fight / powers), ≤ 2 500 characters
  (``forge.chapter_brief``).

P14: a book made with parts of the pipeline switched off (pipeline.py: scenes / voices / rules / planned) gets no
scene cards / voice cards / story rules and texture / must-show details here, even when such data exists.
* ``rules``: how to use all of this, in plain sentences.
* Section 7 (continuity.py): ``physical_state`` (P32), ``character_state`` (P35) at the end of the earlier chapters
  (approved tracked state only), ``two_readings`` of the protected mysteries (P33) and ``version_changes`` of a rerun /
  variant (P34); bounded to about 3 500 characters, one rule each. Off when the pipeline's scenes switch is off.

Prompt budget of the brief (characters of JSON): voice cards ≤ 7 000, scene cards ≤ 6 × ~1 500, story rules ≤ 2 500,
world texture ≤ 1 200, must-show ≤ 5 × 160, story choices ≤ 1 600, length ≤ 400 — about 22 000 at most, typically
6 000–10 000.

Pure reads of the store (records and companion settings); never calls an AI, never raises (a missing brief must never
stop a chapter from being written).
"""
from __future__ import annotations

import json
import logging

from . import characters as chars_mod
from . import scenes as scenes_mod

log = logging.getLogger("akowe.chapter_brief")

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
    "story_rules": ("Story rules (context.writing_brief.story_rules): never break a hard rule and keep every rule "
                    "inside its scope and limits — an exception the story uses must stay within the stated limits; a "
                    "belief stays what a character believes (the narrator never confirms it as fact, even when a later "
                    "scene needs it); something seen to happen is shown, its cause is not explained; a protected "
                    "mystery stays unexplained (nobody explains it, not even the narrator)."),
    "must_show": ("These details must reach the page in this chapter (context.writing_brief.must_show): show each one "
                  "through action, dialogue or memory — a name must be written on the page."),
    "character_details": ("Character details (context.writing_brief.character_details) are the author's approved "
                          "Character Forge facts this chapter needs (appearance on a first appearance, fighting, "
                          "powers and their limits, essential on-page details): keep every one exactly; show them "
                          "through action and description, never as a list."),
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


def _forge_details(store, pid, branch, outline, chapter_id, present, cs, texts) -> list:
    """🗂 B5: the Character Forge letters each present character needs here — E always, A on their first appearance
    (no earlier outline chapter mentions them), F / M when the chapter's plan reads like a fight / powers. Only
    accepted dossier fields; the voice card and sheet parts (V, P) are already in voice_cards. Never raises."""
    try:
        from . import forge  # noqa: PLC0415
        from .book_path import BookPath  # noqa: PLC0415
        order = [c["chapter_id"] for c in BookPath.outline_chapters(None, outline)]
        earlier = order[:order.index(chapter_id)] if chapter_id in order else []
        seen = set()
        for cid in earlier:
            it = _chapter_item(outline, cid) or {}
            facts = [f for f in it.get("facts") or [] if isinstance(f, dict)]
            t = [str(it.get("summary") or "")] + [str(f.get("value")) for f in facts if isinstance(f.get("value"), str)]
            ids = [f.get("subject_id") for f in facts] + [f.get("value") for f in facts if isinstance(f.get("value"), str)]
            seen |= {c["record_id"] for c in chars_mod.present_in(cs, *t, ids=ids)}
        letters = {c["record_id"]: forge.letters_for(texts, c["record_id"] not in seen) for c in present}
        return forge.chapter_brief(store, pid, branch, present, letters)
    except Exception:  # noqa: BLE001 - a brief is best effort
        log.exception("character details for the brief failed")
        return []


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
        from . import pipeline as pipeline_mod  # noqa: PLC0415
        flags = pipeline_mod.of_store(store, pid)  # P14: a book made with parts of the pipeline switched off
        item = _chapter_item(outline, chapter_id) or {}
        facts = [f for f in item.get("facts") or [] if isinstance(f, dict)]
        fv = {f.get("predicate"): f.get("value") for f in facts if f.get("subject_id") == chapter_id}
        cs = chars_mod.canon_characters(store, pid, branch, approved_only=True) or \
            chars_mod.canon_characters(store, pid, branch)
        pov_id = fv.get("plan.pov_id")
        pov = next((c for c in cs if pov_id and pov_id in (c["subject_id"], c["record_id"])), None)
        entry = scenes_mod.get_entry(store, pid, branch, outline["record_id"], chapter_id)
        cards = scenes_mod.brief_cards(entry) if scenes_mod.usable(entry, outline) and flags["scenes"] else []
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
        vb = chars_mod.voice_brief(store, pid, branch, present, first=pov["record_id"] if pov else None) \
            if flags["voices"] else {"cards": [], "others": [], "summarized": False}
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
        details = _forge_details(store, pid, branch, outline, chapter_id, present, cs, texts) if flags["voices"] \
            else []
        if details:  # 🗂 B5: approved dossier fields with only the letters this chapter needs (≤ 2 500 chars)
            brief["character_details"] = details
        extra = _section4(store, pid, branch, outline, chapter_id, cards, texts)
        if not flags["rules"]:
            extra.pop("story_rules", None)
            extra.pop("world_texture", None)
        if not flags["planned"]:
            extra.pop("must_show", None)
        brief.update({k: v for k, v in extra.items() if v})
        length = _length(store, pid, outline)
        if length:
            brief["length"] = length
        rules = []
        if cards:
            rules.append(RULES["scenes"])
        if vb["cards"] or vb["others"]:
            rules.append(RULES["voices"])
        if pov:
            rules.append(RULES["pov"])
        if planned:
            rules.append(RULES["planned"])
        if brief.get("story_rules"):
            rules.append(RULES["story_rules"])
        if brief.get("world_texture"):
            from .texture import RULE as TEXTURE_RULE  # noqa: PLC0415
            rules.append(TEXTURE_RULE)
        if brief.get("must_show"):
            rules.append(RULES["must_show"])
        if brief.get("character_details"):
            rules.append(RULES["character_details"])
        trade = _trade_terms(store, pid, branch, texts + [json.dumps(cards, ensure_ascii=False)])  # P31
        if trade:
            from .terms import RULE as TERMS_RULE  # noqa: PLC0415
            brief["trade_terms"] = trade
            rules.append(TERMS_RULE)
        rules += extra.get("choice_rules") or []
        # Section 7 (P32-P35): continuity tracked from the earlier chapters (continuity.py; never raises)
        if flags["scenes"]:
            from . import continuity  # noqa: PLC0415
            from .book_path import BookPath  # noqa: PLC0415
            cont = continuity.section(store, pid, branch, [c["chapter_id"] for c in BookPath.outline_chapters(
                None, outline)], chapter_id, [c["name"] for c in present])
            rules += cont.pop("continuity_rules", [])
            brief.update(cont)
        if length:
            from . import lengths as lengths_mod  # noqa: PLC0415
            rules.append(lengths_mod.rule(length))
        brief.pop("choice_rules", None)
        style = _narrator_style(store, pid)  # P25 (Section 7c): the author's own narrating style, when chosen
        if style:
            from .style_card import RULE as STYLE_RULE  # noqa: PLC0415
            brief["narrator_style"] = style
            rules.append(STYLE_RULE)
        brief["rules"] = rules
        if not (cards or vb["cards"] or vb["others"] or pov or planned or extra.get("story_rules")
                or extra.get("world_texture") or extra.get("story_choices") or length or style
                or brief.get("character_details")
                or any(k in brief for k in ("physical_state", "character_state", "two_readings", "version_changes"))):
            return None, meta
        meta.update(characters=[c["record_id"] for c in present], voice_cards=len(vb["cards"]),
                    other_voices=len(vb["others"]), summarized=vb["summarized"],
                    scene_cards={"version": entry["version"], "status": entry.get("status"), "scenes": len(cards)}
                    if cards else None, pov=pov["record_id"] if pov else None,
                    story_rules=len(brief.get("story_rules") or []), texture=len(brief.get("world_texture") or []),
                    must_show=len(brief.get("must_show") or []), choices=bool(brief.get("story_choices")),
                    length={k: length[k] for k in ("target_words", "scenes", "scene_by_scene")} if length else None,
                    pipeline=None if all(flags.values()) else {k: v for k, v in flags.items()},
                    continuity=[k for k in ("physical_state", "character_state", "two_readings", "version_changes")
                                if k in brief] or None,
                    narrator_style=bool(style),
                    chars=len(json.dumps(brief, ensure_ascii=False)))
        return brief, meta
    except Exception:  # noqa: BLE001 - a brief is help for the writer, never a reason to fail the chapter
        log.exception("could not build the writing brief of chapter %s", chapter_id)
        return None, meta


def _narrator_style(store, pid: str) -> dict | None:
    """P25 (Section 7c): the style card of a book that writes in the author's own style (never raises)."""
    try:
        from . import style_card  # noqa: PLC0415
        return style_card.brief_for(store, pid)
    except Exception:  # noqa: BLE001
        log.exception("could not add the narrator style to the brief")
        return None


def _length(store, pid: str, outline: dict) -> dict | None:
    """P15: the chapter's word target, scenes and words per scene (from the book's length preset and the number of
    chapters in this outline). Never raises."""
    try:
        from . import lengths as lengths_mod  # noqa: PLC0415
        proj = store.project(pid)
        st = json.loads(proj["settings"] or "{}") if proj else {}
        if isinstance(st, dict) and (st.get("selftest") or st.get("workflow_test")):
            return None  # 🧪 Test everything / the workflow test: one call per chapter, as before (a smoke test)
        n = len((outline.get("data") or {}).get("chapters") or []) or None
        return lengths_mod.of_book(store, pid, n)
    except Exception:  # noqa: BLE001
        log.exception("could not add the length to the brief")
        return None


def _trade_terms(store, pid: str, branch: str, texts: list) -> list:
    """P31: verified trade terms (with notes), terms marked wrong (with what to write) and research-needed terms the
    plan mentions. Never raises."""
    try:
        from . import terms as terms_mod  # noqa: PLC0415
        return terms_mod.chapter_brief(terms_mod.get_entry(store, pid, branch), " ".join(t for t in texts if t))
    except Exception:  # noqa: BLE001 - guidance, never a reason to fail the chapter
        log.exception("could not add the trade terms to the brief")
        return []


def _section4(store, pid: str, branch: str, outline: dict, chapter_id: str, cards: list, texts: list) -> dict:
    """Story rules (P9), world texture (P10), must-show details (P11) and story choices (P12) for one chapter; each
    part is optional and never raises."""
    out = {}
    try:
        from . import story_choices, story_rules  # noqa: PLC0415
        from . import texture as texture_mod  # noqa: PLC0415
        from .book_path import BookPath  # noqa: PLC0415
        order = [c["chapter_id"] for c in BookPath.outline_chapters(None, outline)]
        last = bool(order) and order[-1] == chapter_id
        choices = story_choices.of_store(store, pid)
        card_text = " ".join(json.dumps(c, ensure_ascii=False) for c in cards or [])
        out["story_rules"] = story_rules.chapter_rules(story_rules.get_entry(store, pid, branch), *texts, card_text,
                                                       mystery_mode=story_choices.mystery_mode(choices), last=last)
        out["world_texture"] = texture_mod.chapter_brief(texture_mod.get_entry(store, pid, branch), cards, *texts)
        out["story_choices"] = story_choices.brief(choices, ending=last)
        out["choice_rules"] = story_choices.rules(choices, ending=last)
    except Exception:  # noqa: BLE001 - guidance, never a reason to fail the chapter
        log.exception("could not add the story rules / texture / choices to the brief")
    try:
        from . import planned as planned_mod  # noqa: PLC0415
        shim = planned_mod.shim(store, pid, branch)
        assigned = planned_mod._must_show_assignment(store, pid, branch, planned_mod.chapters_info(shim, outline))
        out["must_show"] = [f"{who}: {it}" for who, it in assigned.get(chapter_id, [])][:planned_mod.MUST_SHOW_BRIEF]
    except Exception:  # noqa: BLE001
        log.exception("could not add the must-show details to the brief")
    return out
