"""🫀 P35 character state variables per scene.

For every character present in a scene, at the END of the scene:

* ``values`` — the book's state variables on a 0–10 scale (default: duty, guilt, fear of exposure, desire for contact;
  the author can choose up to 8 per book);
* ``observes`` — what they can actually see or know at this point (no mind reading);
* ``assumes`` — what they wrongly believe (a false assumption the story can use);
* ``own_action`` / ``serves`` — one thing they DO in the scene and whether it serves their own goal (``own_goal``) or
  only the book's theme / the main character (``theme``). The second book's feedback: side characters existed to
  help, inform or absolve; every main character needs at least one action that serves their own goal.

Pure logic (cleaning, the deterministic checks, the state the next chapter starts from). Storage, the AI extraction and
the routes are in continuity.py (companion data ``character_state:<project>:<branch>``). There is no deterministic
extraction: these values need a reader (the AI, or the author by hand).
"""
from __future__ import annotations

import re

TEXT_MAX = 200
NAME_MAX = 80
MAX_SCENES = 8
MAX_PEOPLE = 8
MAX_VARIABLES = 8
JUMP = 5            # a change of this much between two scenes in a row needs a visible cause
SERVES = ("own_goal", "theme", "")
DEFAULT_VARIABLES = ("duty", "guilt", "fear_of_exposure", "desire_for_contact")

LINT_WORDS = {
    "BIG_JUMP": "changes a lot between two scenes — make sure the page shows why",
    "NO_OWN_ACTION": "does nothing in this chapter that serves their own goal (only the theme or the main character)",
    "NEVER_OWN_ACTION": "never does anything that serves their own goal in the tracked chapters",
}

RULE = ("Character state (context.writing_brief.character_state): each character starts this chapter where the last "
        "one left them — the values (0-10) are how strongly each pull acts on them now; change them only through "
        "what happens on the page; a character acts only on what they can observe (observes) and keeps their false "
        "assumption (assumes) until the page corrects it; every main character present does at least one thing that "
        "serves their OWN goal, not the theme or the main character.")

_S = {"type": "string"}


def _clip(v, n: int = TEXT_MAX) -> str:
    return " ".join(str(v or "").split())[:n] if isinstance(v, (str, int, float)) and not isinstance(v, bool) else ""


def label(var: str) -> str:
    return str(var or "").replace("_", " ")


def clean_variables(raw) -> list[str]:
    """Slug names (``fear of exposure`` → ``fear_of_exposure``), unique, at most 8; empty → the defaults."""
    items = raw if isinstance(raw, list) else (str(raw).split(",") if isinstance(raw, str) else [])
    out = []
    for x in items:
        if not isinstance(x, str):
            continue
        slug = re.sub(r"[^a-z0-9]+", "_", x.strip().lower()).strip("_")[:32]
        if slug and slug not in out:
            out.append(slug)
        if len(out) >= MAX_VARIABLES:
            break
    return out or list(DEFAULT_VARIABLES)


def person_schema() -> dict:
    return {"type": "object", "additionalProperties": False,
            "required": ["name", "values", "observes", "assumes", "own_action", "serves"],
            "properties": {"name": _S,
                           "values": {"type": "array", "maxItems": MAX_VARIABLES, "items": {
                               "type": "object", "additionalProperties": False, "required": ["variable", "value"],
                               "properties": {"variable": _S, "value": {"type": "integer", "minimum": 0,
                                                                        "maximum": 10}}}},
                           "observes": _S, "assumes": _S, "own_action": _S,
                           "serves": {"type": "string", "enum": list(SERVES)}}}


def _value(v) -> int | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return max(0, min(10, int(round(v))))
    if isinstance(v, str) and re.fullmatch(r"\s*\d{1,2}\s*", v):
        return max(0, min(10, int(v)))
    return None


def clean_person(raw, variables: list[str]) -> dict | None:
    if not isinstance(raw, dict):
        return None
    name = _clip(raw.get("name"), NAME_MAX)
    if not name:
        return None
    vals = {}
    src = raw.get("values")
    pairs = src.items() if isinstance(src, dict) else (
        [(x.get("variable"), x.get("value")) for x in src if isinstance(x, dict)] if isinstance(src, list) else [])
    for k, v in pairs:
        slug = re.sub(r"[^a-z0-9]+", "_", str(k or "").strip().lower()).strip("_")
        n = _value(v)
        if slug in variables and n is not None:
            vals[slug] = n
    serves = raw.get("serves") if raw.get("serves") in SERVES else ""
    p = {"name": name, "values": vals, "observes": _clip(raw.get("observes")), "assumes": _clip(raw.get("assumes")),
         "own_action": _clip(raw.get("own_action")), "serves": serves}
    if not vals and not any(p[k] for k in ("observes", "assumes", "own_action")):
        return None
    return p


def clean_scenes(raw, variables: list[str]) -> list[dict]:
    items = raw.get("scenes") if isinstance(raw, dict) else raw
    out = []
    for r in items if isinstance(items, list) else []:
        if not isinstance(r, dict):
            continue
        people = []
        for x in r.get("characters") or r.get("people") or []:
            p = clean_person(x, variables)
            if p and p["name"].lower() not in {q["name"].lower() for q in people}:
                people.append(p)
            if len(people) >= MAX_PEOPLE:
                break
        if people:
            out.append({"scene": len(out) + 1, "characters": people})
        if len(out) >= MAX_SCENES:
            break
    return out


def _same(a: str, b: str) -> bool:
    a, b = a.lower().strip(), b.lower().strip()
    return a == b or (bool(a) and bool(b) and (a in b.split() or b in a.split() or a.split()[0] == b.split()[0]))


def lint(chapters: list[dict], mains: list[str]) -> list[dict]:
    """chapters: [{number, chapter_id, scenes}] in book order; mains: names of the main characters. Returns
    [{chapter_id, number, scene, name, code, severity, message}] (all minor)."""
    out = []
    last: dict[str, tuple] = {}          # name -> (values, chapter number, scene)
    ever_own: dict[str, bool] = {}
    tracked_any: dict[str, bool] = {}
    for ch in chapters:
        n, cid = ch.get("number"), ch.get("chapter_id")
        present, own = set(), set()
        for s in ch.get("scenes") or []:
            for p in s.get("characters") or []:
                key = next((m for m in mains if _same(m, p["name"])), p["name"])
                present.add(key)
                if p.get("own_action") and p.get("serves") == "own_goal":
                    own.add(key)
                prev = last.get(key)
                if prev:
                    for var, v in p.get("values", {}).items():
                        if var in prev[0] and abs(v - prev[0][var]) >= JUMP:
                            out.append({"chapter_id": cid, "number": n, "scene": s["scene"], "name": p["name"],
                                        "code": "BIG_JUMP", "severity": "minor",
                                        "message": f"{p['name']}: {label(var)} {prev[0][var]} → {v} "
                                                   f"{LINT_WORDS['BIG_JUMP']}"})
                vals = dict(prev[0]) if prev else {}
                vals.update(p.get("values") or {})
                last[key] = (vals, n, s["scene"])
        for m in mains:
            if m in present:
                tracked_any[m] = True
                ever_own[m] = ever_own.get(m, False) or m in own
                if m not in own:
                    out.append({"chapter_id": cid, "number": n, "scene": None, "name": m, "code": "NO_OWN_ACTION",
                                "severity": "minor", "message": f"{m} {LINT_WORDS['NO_OWN_ACTION']}"})
    for m in mains:
        if tracked_any.get(m) and not ever_own.get(m):
            out.append({"chapter_id": None, "number": None, "scene": None, "name": m, "code": "NEVER_OWN_ACTION",
                        "severity": "major", "message": f"{m} {LINT_WORDS['NEVER_OWN_ACTION']}"})
    return out


def latest(chapters: list[dict]) -> dict:
    """name -> {values, observes, assumes, chapter} at the end of the last of ``chapters`` (book order)."""
    out: dict[str, dict] = {}
    for ch in chapters:
        for s in ch.get("scenes") or []:
            for p in s.get("characters") or []:
                key = p["name"]
                cur = out.get(key) or {"name": key, "values": {}}
                cur["values"] = dict(cur["values"], **(p.get("values") or {}))
                for k in ("observes", "assumes"):
                    if p.get(k):
                        cur[k] = p[k]
                cur["chapter"] = ch.get("number")
                out[key] = cur
    return out


def brief(state: dict, present: list[str] | None = None, limit: int = 6) -> list[dict]:
    """The bounded character-state brief: the characters present first (by name match), at most ``limit``."""
    people = list(state.values())
    if present:
        pres = [p for p in people if any(_same(p["name"], n) for n in present)]
        people = pres + [p for p in people if p not in pres]
    out = []
    for p in people[:limit]:
        item = {"name": p["name"], "values": {label(k): v for k, v in (p.get("values") or {}).items()}}
        for k in ("observes", "assumes"):
            if p.get(k):
                item[k] = p[k]
        item["as_of_chapter"] = p.get("chapter")
        out.append(item)
    return out
