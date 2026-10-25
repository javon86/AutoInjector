"""📏 P15 Book lengths: presets with word targets per book, per chapter and per scene, and the "long chapter" settings.

A preset is what the author picks as the book's length (book profile ``length``):

    short story ~3 000-5 000 words, 3-5 chapters · novelette ~10 000-15 000 words, 5-8 chapters ·
    novella ~20 000-40 000 words, 8-15 chapters · novel ~60 000-90 000 words, 20-35 chapters

Each preset has a target (the middle of its range), a default chapter count and a number of scenes per chapter. The
profile's ``chapters`` (when the author set it) wins over the default. ``chapter_plan`` turns that into what one
chapter needs: target words, the least that is still acceptable ("far under target" below ``under_share`` of the
target), scenes and words per scene, and whether the chapter is written in one AI call or scene by scene.

Where the targets go:

* B11 outline: ``target_length`` = the chapter count, and a sentence with the words per chapter (set_b);
* scene cards (P8): ``scene_hint`` = scenes per chapter, ``target_words`` and ``words_per_scene`` (scenes.py);
* chapter prompts (C02): ``length`` in the writing brief and one plain rule; the instruction names the words;
* the writer (set_c ChapterWriter): when a chapter's target is above ``per_call_words`` (default 2 500, the most a
  web AI reliably writes in one reply) the chapter is written scene by scene, one AI call per scene card, each with
  the end of the previous scene for continuity; a chapter that comes back far under its target gets at most
  ``expand_rounds`` continuation calls (default 1) that add story within the scene plan — never padding: an empty
  answer or one that repeats the text adds nothing, and the editor's checks still read the result.

Settings (``length_settings``, Settings › 📏 Long chapters, ``GET/PUT /api/settings/length``): per_call_words
(300-8 000), expand_rounds (0-3), under_share (0.3-0.9) and ``scale`` (0.001-1, a test mode that shrinks every word
target; not shown in the app). Pure functions plus two store reads; never calls an AI.
"""
from __future__ import annotations

import math

# key: (label, words min, words max, target words, chapters min, chapters max, default chapters, scenes per chapter)
PRESETS = {
    "short_story": {"label": "Short story", "words": (3000, 5000), "target": 4000, "chapters": (3, 5),
                    "default_chapters": 3, "scenes": 2},
    "novelette": {"label": "Novelette", "words": (10000, 15000), "target": 12000, "chapters": (5, 8),
                  "default_chapters": 6, "scenes": 3},
    "novella": {"label": "Novella", "words": (20000, 40000), "target": 30000, "chapters": (8, 15),
                "default_chapters": 12, "scenes": 3},
    "novel": {"label": "Novel", "words": (60000, 90000), "target": 75000, "chapters": (20, 35),
              "default_chapters": 25, "scenes": 4},
}
ORDER = ["short_story", "novelette", "novella", "novel"]
DEFAULT = "short_story"
MAX_SCENES = 5          # scene cards per chapter the writer is asked for (scenes.MAX_SCENES is the hard cap, 6)
DEFAULT_SETTINGS = {"per_call_words": 2500, "expand_rounds": 1, "under_share": 0.6, "scale": 1.0}
LIMITS = {"per_call_words": (300, 8000), "expand_rounds": (0, 3), "under_share": (0.3, 0.9), "scale": (0.001, 1.0)}
SETTINGS_KEY = "length_settings"

RULE = ("Length: this chapter should be about {target} words (context.length: the whole book is a {label} of about "
        "{book} words in {n} chapters{scenes}). Earn the length with story — more of each scene's goals, obstacles "
        "and consequences, concrete texture, dialogue that does work — never with padding, summary, repetition or "
        "restating what the reader already knows.")


def preset(length: str | None) -> dict:
    key = length if length in PRESETS else DEFAULT
    return dict(PRESETS[key], key=key)


def lengths_table() -> dict:
    """Labels and ranges for the UI and the API (GET /api/lengths)."""
    out = []
    for k in ORDER:
        p = PRESETS[k]
        wpc = int(round(p["target"] / p["default_chapters"]))
        out.append({"key": k, "label": p["label"], "words": list(p["words"]), "target": p["target"],
                    "chapters": list(p["chapters"]), "default_chapters": p["default_chapters"], "scenes": p["scenes"],
                    "words_per_chapter": wpc,
                    "about": f"about {p['words'][0]:,}–{p['words'][1]:,} words, {p['chapters'][0]}–{p['chapters'][1]} "
                             f"chapters (~{wpc:,} words each)"})
    return {"lengths": out, "default": DEFAULT, "settings": dict(DEFAULT_SETTINGS)}


def settings(store) -> dict:
    """The long-chapter settings (defaults filled in, values clipped to their limits; never raises)."""
    try:
        cur = store.get_setting(SETTINGS_KEY) or {}
    except Exception:  # noqa: BLE001 - defaults
        cur = {}
    out = dict(DEFAULT_SETTINGS)
    for k, (lo, hi) in LIMITS.items():
        v = cur.get(k) if isinstance(cur, dict) else None
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            out[k] = type(DEFAULT_SETTINGS[k])(min(hi, max(lo, v)))
    return out


def save_settings(store, body) -> dict:
    from .errors import BookforgeError  # noqa: PLC0415
    body = body if isinstance(body, dict) else {}
    cur = settings(store)
    for k, (lo, hi) in LIMITS.items():
        if k not in body:
            continue
        v = body[k]
        if not isinstance(v, (int, float)) or isinstance(v, bool) or not lo <= v <= hi:
            raise BookforgeError("INVALID_INPUT", f"/{k}", f"{k}: a number from {lo} to {hi}", status="REJECTED")
        if isinstance(DEFAULT_SETTINGS[k], int) and int(v) != v:
            raise BookforgeError("INVALID_INPUT", f"/{k}", f"{k}: a whole number", status="REJECTED")
        cur[k] = type(DEFAULT_SETTINGS[k])(v)
    store.set_setting(SETTINGS_KEY, cur)
    return settings(store)


def book_target(prof: dict, store=None) -> int:
    p = preset((prof or {}).get("length"))
    scale = settings(store)["scale"] if store is not None else 1.0
    return max(1, int(round(p["target"] * scale)))


def chapter_count(prof: dict) -> int:
    prof = prof or {}
    if isinstance(prof.get("chapters"), int) and not isinstance(prof.get("chapters"), bool) and prof["chapters"] > 0:
        return int(prof["chapters"])
    return preset(prof.get("length"))["default_chapters"]


def scenes_for(words_per_chapter: int, base: int) -> int:
    """Scenes per chapter: the preset's number, more for long chapters (about one scene per 1 000 words), max 5."""
    return max(1, min(MAX_SCENES, max(base, math.ceil(words_per_chapter / 1000.0))))


def chapter_plan(prof: dict, n_chapters: int | None = None, store=None, cfg: dict | None = None) -> dict:
    """What one chapter of this book needs (the same for every chapter: the book's words spread evenly)."""
    p = preset((prof or {}).get("length"))
    cfg = cfg or (settings(store) if store is not None else dict(DEFAULT_SETTINGS))
    n = int(n_chapters or chapter_count(prof)) or 1
    total = max(1, int(round(p["target"] * cfg["scale"])))
    target = max(1, int(round(total / n)))
    unscaled = max(1, int(round(p["target"] / n)))
    scenes = scenes_for(unscaled, p["scenes"])
    per_call = max(1, int(round(cfg["per_call_words"] * cfg["scale"]))) if cfg["scale"] < 1 else cfg["per_call_words"]
    return {"length": p["key"], "label": p["label"], "book_words": total, "chapters": n, "target_words": target,
            "min_words": int(math.floor(target * cfg["under_share"])), "scenes": scenes,
            "words_per_scene": max(1, int(round(target / scenes))), "per_call_words": per_call,
            "scene_by_scene": target > per_call, "expand_rounds": int(cfg["expand_rounds"])}


def rule(plan: dict) -> str:
    scenes = f", {plan['scenes']} scenes of about {plan['words_per_scene']} words each" if plan.get("scenes") else ""
    return RULE.format(target=f"{plan['target_words']:,}", label=plan["label"].lower(),
                       book=f"{plan['book_words']:,}", n=plan["chapters"], scenes=scenes)


def outline_rule(prof: dict, store=None) -> str:
    """One sentence for the B11 outline prompt (the chapter count is also in target_length)."""
    plan = chapter_plan(prof, None, store)
    return (f"Length: the book is a {plan['label'].lower()} of about {plan['book_words']:,} words: plan "
            f"{plan['chapters']} chapters of about {plan['target_words']:,} words each, every chapter with enough "
            f"story for that length (about {plan['scenes']} scenes: goals, obstacles, a change).")


def of_book(store, pid: str, n_chapters: int | None = None) -> dict:
    """chapter_plan for a stored book (never raises: the default short story when the profile cannot be read)."""
    try:
        from .book_path import get_profile  # noqa: PLC0415
        prof = get_profile(store, pid)
    except Exception:  # noqa: BLE001
        prof = {}
    return chapter_plan(prof, n_chapters, store)


def words(text) -> int:
    return len(str(text or "").split())
