"""🧑 ⚖ 🗺 "How the story treats the characters" — a per-book setting (stored in the book profile's ``choices`` under
``characters``, so the 🚀 wizard, the profile dialog, ⚡ Make a book, variants, reruns from a book bible and 📚 sequels
carry it like the other ending and style choices; a sequel starts with the previous book's setting).

* **character_led** 🧑 Character-led — who the characters are (personality, voice, wants, fears) is fixed; the planner
  builds the events OUT OF the characters' traits, fears and false beliefs; the reviewers flag every plot beat where a
  character acts against their core without a reason shown on the page (strict).
* **balanced** ⚖ Balanced (the default) — the core is fixed, details are free and decided just in time; a character
  may change only within their "How far they can change" (change_limits) and only when the story shows why.
* **plot_led** 🗺 Plot-led — the story comes first; characters may adapt more (change_limits are a guide, not a wall);
  the reviewers only flag big, unexplained personality breaks.

Where it goes: the premise / main plot / outline prompts (set_b), the chapter writing brief (chapter_brief:
``character_mode`` plus one rule), the AI reviewer of drafts (review.py) and the AI editor (editor.py: notes on
``character_agency`` and ``voice_distinction`` and a stricter / more lenient minimum score). Never raises on read: a
broken stored value is read as the default.
"""
from __future__ import annotations

from .errors import AkoweError

KEY = "characters"          # the key inside the book profile's ``choices``
DEFAULT = "balanced"
# (value, icon, plain label, what it means for the author, what the AI is told)
MODES = (
    ("character_led", "🧑", "Character-led",
     "The characters come first: who they are never bends; the story is built out of their wants, fears and "
     "mistaken beliefs, and the reviewers are strict when someone acts out of character.",
     "CHARACTER-LED: the characters' core (personality, voice, wants, needs, fears, false beliefs) is fixed and drives "
     "the story. Build every major event out of a character's trait, fear or false belief (a choice they make, a "
     "mistake their false belief causes, a fear that stops them); never move a character only because the plot needs "
     "it."),
    ("balanced", "⚖", "Balanced",
     "The core of each character is fixed; small details are decided when the story needs them; a character changes "
     "only as far as their sheet allows and only when the story shows why.",
     "BALANCED: the characters' core (personality, voice, wants, fears) is fixed; details may be decided as the story "
     "needs them. A character changes only within their change_limits (\"How far they can change\") and only when "
     "the story shows why."),
    ("plot_led", "🗺", "Plot-led",
     "The story comes first: characters may adapt more to what the plot needs; only big, unexplained personality "
     "breaks are flagged.",
     "PLOT-LED: the story comes first. Characters may adapt to what the plot needs (their change_limits are a guide, "
     "not a wall), but keep their voice recognisable and never break a personality without any reason."),
)
VALUES = tuple(m[0] for m in MODES)
ICON = {m[0]: m[1] for m in MODES}
LABEL = {m[0]: m[2] for m in MODES}
ABOUT = {m[0]: m[3] for m in MODES}
AI_WORDS = {m[0]: m[4] for m in MODES}
TITLE = "How the story treats the characters"
HELP = ("Whether the story is built from the characters or the characters bend to the story. Balanced (the default) "
        "suits most books.")


def info() -> dict:
    """Labels and ⓘ help for the forms (the page never hard-codes them)."""
    return {"key": KEY, "label": TITLE, "help": HELP, "default": DEFAULT,
            "options": [{"value": v, "icon": i, "label": label, "about": a} for v, i, label, a, _w in MODES]}


def clean(v) -> str | None:
    """None / "" = not chosen (the default applies). REJECTED INVALID_INPUT on an unknown value."""
    if v in (None, ""):
        return None
    if v not in VALUES:
        raise AkoweError("INVALID_INPUT", f"/choices/{KEY}", f"{KEY}: one of {', '.join(VALUES)}",
                         status="REJECTED")
    return v


def of_choices(choices) -> str:
    v = (choices or {}).get(KEY) if isinstance(choices, dict) else None
    return v if v in VALUES else DEFAULT


def of_profile(prof) -> str:
    return of_choices((prof or {}).get("choices") if isinstance(prof, dict) else None)


def of_store(store, pid: str) -> str:
    try:
        from .book_path import get_profile  # noqa: PLC0415
        return of_profile(get_profile(store, pid))
    except Exception:  # noqa: BLE001 - guidance, never a reason to fail
        return DEFAULT


def word(mode: str) -> str:
    mode = mode if mode in VALUES else DEFAULT
    return f"{ICON[mode]} {LABEL[mode]}"


def summary_line(mode: str) -> str:
    return f"{TITLE}: {word(mode)}"


# ---------------------------------------------------------------------------------------------- where it goes
def planner_rule(mode: str, op: str) -> str:
    """For the premise (B01), main plot (B03) and chapter outline (B11) prompts."""
    mode = mode if mode in VALUES else DEFAULT
    out = f"How the story treats the characters (context.character_mode): {AI_WORDS[mode]}"
    if mode == "character_led":
        out += (" Use the character sheets (wants, fear, false_belief, stress) of context.canon / context.cast: "
                + ("the premise grows out of the main character's want against their fear." if op == "B01" else
                   "every turning point names whose trait, fear or false belief causes it."))
    elif mode == "plot_led" and op != "B01":
        out += " Plan the events the story needs first; give each character a plausible reason to go along."
    return out


def brief(mode: str) -> dict:
    """``character_mode`` in the chapter writing brief."""
    mode = mode if mode in VALUES else DEFAULT
    return {"mode": mode, "label": LABEL[mode], "meaning": AI_WORDS[mode]}


def writer_rule(mode: str) -> str:
    mode = mode if mode in VALUES else DEFAULT
    if mode == "character_led":
        return ("Characters (context.writing_brief.character_mode, character-led): every choice a character makes in "
                "this chapter comes from their own sheet (want, fear, false belief, how they act under pressure); "
                "nobody acts out of character for the plot's convenience.")
    if mode == "plot_led":
        return ("Characters (context.writing_brief.character_mode, plot-led): follow the plan; a character may bend to "
                "it, but keep their voice and give a reason on the page for any big change of behaviour.")
    return ("Characters (context.writing_brief.character_mode, balanced): keep each character's core (personality, "
            "voice, wants, fears); any change stays within their change_limits and the page shows why it happens.")


def reviewer_rule(mode: str) -> str:
    """Appended to the AI reviewer's task for plans and chapters."""
    mode = mode if mode in VALUES else DEFAULT
    if mode == "character_led":
        return (" The author chose a CHARACTER-LED book (strict): in reasons, flag every plot beat or action where a "
                "character acts against their core (personality, wants, fears, false belief) without a reason shown "
                "in the draft, and every event that happens to the characters instead of growing out of them; such a "
                "beat means REVISE.")
    if mode == "plot_led":
        return (" The author chose a PLOT-LED book: characters may adapt to the plot; only flag a big, unexplained "
                "break of a character's personality.")
    return (" The author chose a BALANCED book: flag a character who changes beyond their change_limits or without "
            "the draft showing why.")


def editor_notes(mode: str) -> dict:
    """Extra expectations per editor dimension (appended to the rubric question)."""
    mode = mode if mode in VALUES else DEFAULT
    if mode == "character_led":
        return {"character_agency": "The author chose a character-led book (strict): every event must grow out of a "
                                    "character's want, fear or false belief; quote every beat where someone acts "
                                    "against their core without a shown reason as a major finding.",
                "voice_distinction": "Character-led (strict): a line that does not sound like this character's voice "
                                     "card is a major finding."}
    if mode == "plot_led":
        return {"character_agency": "The author chose a plot-led book: characters may bend to the plot; only a big, "
                                    "unexplained personality break is a major finding.",
                "voice_distinction": "Plot-led: flag only lines that clearly break a character's voice."}
    return {"character_agency": "Balanced book: a change of behaviour beyond the character's change_limits, or "
                                "without the page showing why, is a finding."}


def relax(mode: str) -> dict:
    """Per-dimension change of the minimum score (positive = stricter)."""
    if mode == "character_led":
        return {"character_agency": 1, "voice_distinction": 1}
    if mode == "plot_led":
        return {"character_agency": -1, "voice_distinction": -1}
    return {}


def change_limits_word(mode: str) -> str:
    """How the essentials step / just-in-time details describe the change limits to the AI."""
    if mode == "character_led":
        return "change_limits are a hard wall"
    if mode == "plot_led":
        return "change_limits are a loose guide"
    return "change only within change_limits, and only when the story shows why"
