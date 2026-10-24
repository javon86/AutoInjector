"""🧪 P14 Pipeline switches: which parts of the writing pipeline a Make-a-book run (and its book) uses.

Five real switches, all on by default ("full pipeline"):

* ``editor``  — the AI editor's craft review and targeted rewrites after the consistency review (P4/P5);
* ``scenes``  — scene cards planned and checked before each chapter, and given to the writer (P8);
* ``voices``  — character sheets and voice cards: the run's "Character sheets and voices" step and the voice cards in
  every chapter prompt (P7/P17);
* ``rules``   — the story-rules ledger and the world-texture list: the run's "Story rules and world texture" step,
  the rules update after the outline, and the rules/texture in the outline and chapter prompts (P9/P10);
* ``planned`` — the planned-to-page check and its one fix round per chapter, the book-level step and the must-show
  details in the chapter prompt (P11).

Presets: ``full`` (everything on) and ``baseline`` (everything off: the writer gets the outline, the context, the POV
name and the author's ending/style choices only — the pipeline of the first automatic book). A run stores its switches
in ``run["settings"]["pipeline"]`` and, when it creates its book, in the book's settings key ``pipeline:<pid>`` so the
chapter brief (chapter_brief.py), the outline prompt (set_b), ✍ Write all chapters and the comparison page honour
them for that book. Books without the key use the full pipeline. Engine/store semantics are unchanged.
"""
from __future__ import annotations

FLAGS = ("editor", "scenes", "voices", "rules", "planned")
LABELS = {"editor": "AI editor (craft review and rewrites)", "scenes": "Scene cards before each chapter",
          "voices": "Character sheets and voice cards", "rules": "Story rules and world texture",
          "planned": "Planned-to-page check"}
HELP = {"editor": "After the AI reviewer, an editor scores the chapter's craft and the writer reworks flagged passages.",
        "scenes": "Before writing, the writer plans each scene (goals, an obstacle from the world, what stays unsaid) "
                  "and another AI checks the plan.",
        "voices": "What each character wants, fears and hides, and how each one talks — given to the writer.",
        "rules": "What is law in the world, what is only believed or must stay a mystery, and concrete details that "
                 "get in the way.",
        "planned": "Checks that the outline beats, scene goals and planned details reached the page, with one fix."}
PRESETS = {"full": {f: True for f in FLAGS}, "baseline": {f: False for f in FLAGS}}
PRESET_LABELS = {"full": "Full pipeline (everything on)",
                 "baseline": "Baseline (editor off, no scene cards, no voice cards, no rules, no planned check)",
                 "custom": "Custom"}
KEY = "pipeline:{pid}"


def clean(body) -> dict:
    """{preset, flags} from a request ({"preset": "full"|"baseline"} or {"flags": {...}} or both); unknown keys are
    refused, missing flags are on."""
    from .errors import BookforgeError  # noqa: PLC0415
    if body in (None, "", {}):
        return {"preset": "full", "flags": dict(PRESETS["full"])}
    if isinstance(body, str):
        body = {"preset": body}
    if not isinstance(body, dict):
        raise BookforgeError("INVALID_INPUT", "/pipeline", "pipeline: {preset: full|baseline} or {flags: {...}}",
                             status="REJECTED")
    pre = body.get("preset")
    if pre not in (None, "", "full", "baseline", "custom"):
        raise BookforgeError("INVALID_INPUT", "/pipeline/preset", "pipeline preset: full, baseline or custom",
                             status="REJECTED")
    flags = dict(PRESETS.get(pre or "full") or PRESETS["full"])
    raw = body.get("flags")
    if raw is not None:
        if not isinstance(raw, dict) or any(k not in FLAGS for k in raw) or \
                any(not isinstance(v, bool) for v in raw.values()):
            raise BookforgeError("INVALID_INPUT", "/pipeline/flags", "pipeline flags: editor, scenes, voices, rules, "
                                 "planned — each true or false", status="REJECTED")
        flags.update(raw)
    return {"preset": preset_of(flags), "flags": flags}


def preset_of(flags: dict) -> str:
    for name, p in PRESETS.items():
        if all(bool(flags.get(f, True)) == p[f] for f in FLAGS):
            return name
    return "custom"


def describe(p: dict | None) -> str:
    p = p or {"flags": PRESETS["full"]}
    flags = p.get("flags") or PRESETS["full"]
    name = preset_of(flags)
    if name != "custom":
        return PRESET_LABELS[name]
    off = [LABELS[f].split(" (")[0].lower() for f in FLAGS if not flags.get(f, True)]
    return "Custom: " + ("off — " + ", ".join(off) if off else "everything on")


def of_store(store, pid: str) -> dict:
    """The switches of a book (all on when the book has none; never raises)."""
    try:
        cur = store.get_setting(KEY.format(pid=pid)) if pid else None
    except Exception:  # noqa: BLE001
        cur = None
    flags = dict(PRESETS["full"])
    if isinstance(cur, dict) and isinstance(cur.get("flags"), dict):
        flags.update({k: bool(v) for k, v in cur["flags"].items() if k in FLAGS})
    return flags


def info_of(store, pid: str) -> dict | None:
    try:
        cur = store.get_setting(KEY.format(pid=pid))
    except Exception:  # noqa: BLE001
        return None
    return cur if isinstance(cur, dict) else None


def on(store, pid: str, flag: str) -> bool:
    return bool(of_store(store, pid).get(flag, True))


def save(store, pid: str, p: dict, **extra):
    store.set_setting(KEY.format(pid=pid), dict({"preset": preset_of(p["flags"]), "flags": dict(p["flags"])}, **extra))


def field_info() -> dict:
    return {"flags": [{"key": f, "label": LABELS[f], "help": HELP[f]} for f in FLAGS],
            "presets": {k: {"label": PRESET_LABELS[k], "flags": v} for k, v in PRESETS.items()}}
