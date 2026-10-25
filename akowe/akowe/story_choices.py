"""Ending and style choices of a book (P12): stored in the book profile, all optional ("let the AI choose").

The author picks in plain words (the 🚀 wizard, the profile card/dialog, ⚡ Make a book's quick settings):

* **ending**: neat / bittersweet / open / dark
* **explain** (how much is explained): explain / hint / leave (leave the mysteries)
* **darkness** (peril): gentle / some (some danger) / real (real danger)
* style knobs: **dialogue** little / some / lots, **pace** slow / medium / fast, **humor** none / some

Empty ("") means "let the AI choose" — nothing is said to the AI about it, and nothing changes in BookForge's checks.

The ending choice is represented internally by an **ending-state matrix** (from the review of the first book): one row
per thing an ending settles — the external plot (complete / incomplete), the main decision (made / deferred /
reversed), relationships (reconciled / damaged / ambiguous), guilt (resolved / reduced / persistent / displaced),
social consequences (settled / pending), the mystery (explained / bounded / protected) and the main character's
future identity (known / uncertain). Each simple choice maps to matrix values (``PRESETS``); the "how much is
explained" choice sets the mystery row; an author may change single rows ("More ending options" on the profile page),
stored as ``matrix`` overrides. ``resolve()`` gives the effective matrix.

Where it goes: premise/plot/outline prompts (set_b), scene cards (scenes.py: darkness → obstacles and peril), chapter
prompts (chapter_brief.py: style always, the ending matrix for the last chapter), the editor (editor.py: the ending and
mystery expectations are added to the rubric questions and ``relax()`` adjusts the score thresholds) and the story
rules ledger (story_rules.py: "leave" marks every mystery protected, "explain" lets mysteries be explained at the
end). The brief is small (≤ ``BRIEF_MAX`` characters).
"""
from __future__ import annotations

import json

from .errors import BookforgeError

BRIEF_MAX = 1600

# (key, label, ⓘ help, ((value, plain label, what it means for the AI), ...)) — the ONE place the choices are named
CHOICES = (
    ("ending", "Ending", "How the story ends. “Let the AI choose” leaves it to the story.", (
        ("neat", "Neat", "the main problems are solved and the threads are tied up"),
        ("bittersweet", "Bittersweet", "the goal is reached but something is lost; some relationships stay damaged"),
        ("open", "Open", "the story stops with the main question still open; the reader decides"),
        ("dark", "Dark", "the cost is high: the main character pays, guilt stays, the future is uncertain"))),
    ("explain", "How much is explained", "Whether the book's mysteries are explained by the end.", (
        ("explain", "Explain everything", "the mysteries are explained by the end (not earlier than the plan says)"),
        ("hint", "Hint", "the reader gets enough hints to guess; nothing is spelled out"),
        ("leave", "Leave mysteries", "the mysteries stay unexplained; nobody explains them, not even the narrator"))),
    ("darkness", "Darkness and peril", "How much real danger the characters face.", (
        ("gentle", "Gentle", "little danger; obstacles cost time, money, pride or a relationship, never a life"),
        ("some", "Some danger", "real risks: injury, loss of work or home; danger is present but rarely deadly"),
        ("real", "Real danger", "lives are at risk; obstacles can wound or kill, and a reassurance never removes the "
                                "danger"))),
    ("dialogue", "Dialogue", "How much of the book is dialogue.", (
        ("little", "Little", "mostly narration and action; short exchanges"),
        ("some", "Some", "a balance of dialogue and narration"),
        ("lots", "Lots", "scenes are carried by dialogue"))),
    ("pace", "Pace", "How fast the story moves.", (
        ("slow", "Slow", "room for atmosphere, work and small moments"),
        ("medium", "Medium", "steady: every scene moves the story"),
        ("fast", "Fast", "short scenes, quick turns, little description"))),
    ("humor", "Humor", "Whether there is humor.", (
        ("none", "None", "no jokes; the tone stays serious"),
        ("some", "Some", "dry, character-based humor now and then"))),
)
KEYS = tuple(k for k, *_ in CHOICES)
VALUES = {k: tuple(v for v, _l, _d in opts) for k, _l, _h, opts in CHOICES}
MEANING = {k: {v: d for v, _l, d in opts} for k, _l, _h, opts in CHOICES}

# The ending-state matrix: (row key, label, ⓘ help, values)
MATRIX = (
    ("external_plot", "External plot", "Is the outer story (the job, the search, the danger) finished?",
     ("complete", "incomplete")),
    ("decision", "The main decision", "What happens to the main character's big decision.",
     ("made", "deferred", "reversed")),
    ("relationships", "Relationships", "How the important relationships end.",
     ("reconciled", "damaged", "ambiguous")),
    ("guilt", "Guilt", "What happens to the guilt someone carries.",
     ("resolved", "reduced", "persistent", "displaced")),
    ("social", "Social consequences", "Whether the consequences in the community are settled.",
     ("settled", "pending")),
    ("mystery", "The mystery", "Whether the central mystery is explained, bounded (limits known) or protected.",
     ("explained", "bounded", "protected")),
    ("identity", "Future identity", "Whether we know who the main character will be after the story.",
     ("known", "uncertain")),
)
ROWS = tuple(r for r, *_ in MATRIX)
ROW_VALUES = {r: v for r, _l, _h, v in MATRIX}
PRESETS = {
    "neat": {"external_plot": "complete", "decision": "made", "relationships": "reconciled", "guilt": "resolved",
             "social": "settled", "mystery": "explained", "identity": "known"},
    "bittersweet": {"external_plot": "complete", "decision": "made", "relationships": "damaged", "guilt": "reduced",
                    "social": "pending", "mystery": "bounded", "identity": "known"},
    "open": {"external_plot": "incomplete", "decision": "deferred", "relationships": "ambiguous",
             "guilt": "persistent", "social": "pending", "mystery": "protected", "identity": "uncertain"},
    "dark": {"external_plot": "complete", "decision": "made", "relationships": "damaged", "guilt": "persistent",
             "social": "pending", "mystery": "bounded", "identity": "uncertain"},
}
EXPLAIN_TO_MYSTERY = {"explain": "explained", "hint": "bounded", "leave": "protected"}


def field_info() -> dict:
    """Labels, ⓘ help and the matrix for the wizard / profile / Make-a-book forms (the UI never hard-codes them)."""
    return {"choices": [{"key": k, "label": label, "help": hlp,
                         "options": [{"value": v, "label": vl, "about": d} for v, vl, d in opts]}
                        for k, label, hlp, opts in CHOICES],
            "matrix": [{"key": r, "label": label, "help": hlp, "values": list(vals)} for r, label, hlp, vals in MATRIX],
            "presets": PRESETS, "explain_to_mystery": EXPLAIN_TO_MYSTERY}


def clean(raw) -> dict:
    """Validate the author's choices (REJECTED INVALID_INPUT with the field path on a wrong value). "" = AI chooses."""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise BookforgeError("INVALID_INPUT", "/choices", "ending and style choices must be an object",
                             status="REJECTED")
    out = {}
    for k in KEYS:
        v = raw.get(k)
        if v in (None, "", "ai"):
            continue
        if v not in VALUES[k]:
            raise BookforgeError("INVALID_INPUT", f"/choices/{k}", f"{k}: one of {', '.join(VALUES[k])} (or empty to "
                                 "let the AI choose)", status="REJECTED")
        out[k] = v
    m = raw.get("matrix")
    if m not in (None, {}):
        if not isinstance(m, dict):
            raise BookforgeError("INVALID_INPUT", "/choices/matrix", "ending options must be an object of rows",
                                 status="REJECTED")
        mm = {}
        for r, v in m.items():
            if v in (None, ""):
                continue
            if r not in ROW_VALUES:
                raise BookforgeError("INVALID_INPUT", f"/choices/matrix/{r}", f"unknown ending option {r!r}",
                                     status="REJECTED")
            if v not in ROW_VALUES[r]:
                raise BookforgeError("INVALID_INPUT", f"/choices/matrix/{r}", f"{r}: one of "
                                     f"{', '.join(ROW_VALUES[r])}", status="REJECTED")
            mm[r] = v
        if mm:
            out["matrix"] = mm
    return out


def of_profile(prof: dict | None) -> dict:
    """The (cleaned) choices stored in a book profile; a broken stored value is ignored, never raised."""
    try:
        return clean((prof or {}).get("choices"))
    except BookforgeError:
        return {}


def of_store(store, pid: str) -> dict:
    from .book_path import get_profile  # noqa: PLC0415
    try:
        return of_profile(get_profile(store, pid))
    except Exception:  # noqa: BLE001 - choices are guidance, never a reason to fail
        return {}


def matrix(choices: dict) -> dict:
    """The effective ending-state matrix: the ending preset, the "explained" choice on the mystery row, then the
    author's row overrides. Empty when nothing was chosen (the AI chooses)."""
    out = dict(PRESETS.get(choices.get("ending") or "", {}))
    if choices.get("explain"):
        out["mystery"] = EXPLAIN_TO_MYSTERY[choices["explain"]]
    out.update(choices.get("matrix") or {})
    return {r: out[r] for r in ROWS if r in out}


def mystery_mode(choices: dict) -> str | None:
    """protected | bounded | explained | None (AI chooses): what may happen to the book's mysteries."""
    return matrix(choices).get("mystery")


def brief(choices: dict, *, ending: bool = True) -> dict | None:
    """What the AI is told (≤ BRIEF_MAX characters): only the choices that were made, in plain words."""
    if not choices:
        return None
    out = {}
    for k in KEYS:
        if choices.get(k):
            out[k] = f"{choices[k]}: {MEANING[k][choices[k]]}"
    mx = matrix(choices)
    if ending and mx:
        out["ending_matrix"] = mx
    if not out:
        return None
    text = json.dumps(out, ensure_ascii=False)
    while len(text) > BRIEF_MAX and out:
        out.pop(next(iter(out)))
        text = json.dumps(out, ensure_ascii=False)
    return out or None


def rules(choices: dict, *, ending: bool = True) -> list[str]:
    """Plain instructions for the writer / planner (appended to the task)."""
    out = []
    if not choices:
        return out
    style = [f"{k} {choices[k]}" for k in ("dialogue", "pace", "humor") if choices.get(k)]
    if style:
        out.append("The author chose the style (context.story_choices): " + ", ".join(style) + " — follow it.")
    if choices.get("darkness"):
        out.append(f"Peril level {choices['darkness']}: {MEANING['darkness'][choices['darkness']]}.")
    mx = matrix(choices)
    if ending and mx:
        out.append("The ending must reach this ending-state (context.story_choices.ending_matrix): "
                   + ", ".join(f"{r.replace('_', ' ')} {v}" for r, v in mx.items())
                   + ". Never tie up more than it says (no absolution the author did not choose).")
    mode = mx.get("mystery")
    if mode == "protected":
        out.append("Mysteries stay unexplained: no character or narrator explains them, even at the end.")
    elif mode == "explained":
        out.append("The author wants the mysteries explained by the end — not earlier than the plan says.")
    elif mode == "bounded":
        out.append("Mysteries are bounded, not explained: the reader learns their limits, never the full answer.")
    return out


def scene_rules(choices: dict) -> list[str]:
    """For the scene planner: the peril level shapes the obstacles."""
    out = []
    d = choices.get("darkness") if choices else None
    if d == "gentle":
        out.append("Peril level gentle: obstacles cost time, money, pride or a relationship — no deadly danger.")
    elif d == "some":
        out.append("Peril level some danger: at least one obstacle per chapter risks injury, work or home.")
    elif d == "real":
        out.append("Peril level real danger: obstacles can wound or kill; never remove the danger with a "
                   "reassurance or a convenient helper.")
    if choices and choices.get("pace") == "fast":
        out.append("Pace fast: 1-3 short scenes.")
    elif choices and choices.get("pace") == "slow":
        out.append("Pace slow: scenes may linger on work and place, but each still has its obstacle.")
    return out


def editor_notes(choices: dict) -> dict:
    """Extra expectations per editor dimension (appended to the rubric question)."""
    out = {}
    mx = matrix(choices)
    if mx:
        out["ending_openness"] = ("The author chose this ending-state (context.story_choices.ending_matrix): "
                                  + ", ".join(f"{r.replace('_', ' ')} {v}" for r, v in mx.items())
                                  + ". Score how well the ending matches it; an ending that settles MORE than this "
                                  "(e.g. reconciles, absolves or explains what should stay open) scores low.")
    mode = mx.get("mystery")
    if mode == "explained":
        out["protected_mysteries"] = ("The author wants the mysteries explained by the end: explaining them in the "
                                      "last chapter is fine; only flag a reveal earlier than the plan or a "
                                      "contradiction.")
    elif mode == "protected":
        out["protected_mysteries"] = ("The author wants the mysteries left unexplained: any explanation, even a "
                                      "narrator's guess presented as fact, is a major finding.")
    if choices.get("darkness") == "gentle":
        out["tension_stakes"] = ("The author chose a gentle book: stakes are social, emotional or practical; do not "
                                 "ask for deadly danger.")
    elif choices.get("darkness") == "real":
        out["tension_stakes"] = ("The author chose real danger: lives must be at risk; a reassurance that removes "
                                 "the danger is a major finding.")
    if choices.get("dialogue"):
        out["voice_distinction"] = f"The author chose {choices['dialogue']} dialogue."
    return out


def relax(choices: dict) -> dict:
    """Per-dimension change of the minimum score BookForge uses to decide PASS/REVISE (negative = more lenient)."""
    out = {}
    mode = matrix(choices).get("mystery") if choices else None
    if mode == "explained":
        out["protected_mysteries"] = -2   # explaining is wanted: a low score here is not a reason to rewrite
    elif mode == "protected":
        out["protected_mysteries"] = 1    # strict: an explained mystery must be fixed
    if choices and choices.get("darkness") == "gentle":
        out["tension_stakes"] = -1
    if choices and choices.get("ending") == "open":
        out["ending_openness"] = 1        # an open ending must really stay open
    return out


def summary(choices: dict) -> list[str]:
    """Plain lines for the profile card / book page ("Ending: bittersweet", …); empty = all AI chosen."""
    labels = {k: label for k, label, _h, _o in CHOICES}
    vl = {k: {v: label for v, label, _d in opts} for k, _l, _h, opts in CHOICES}
    out = [f"{labels[k]}: {vl[k][choices[k]]}" for k in KEYS if choices.get(k)]
    if choices.get("matrix"):
        out.append("Ending options changed: " + ", ".join(f"{r.replace('_', ' ')} {v}"
                                                          for r, v in choices["matrix"].items()))
    return out
