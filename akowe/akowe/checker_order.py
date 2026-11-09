"""🔢 Which AI checks first, and which AIs never check (the checker order setting).

Three parts, one setting (``checker_order``: Settings › AI, and per ⚡ run in the start body as ``checker_order``):

* ``mode`` — ``auto`` (default): "Automatic: best track record first". Once at least two AIs have enough checks behind
  them (checker_record.MIN_SAMPLE), the one whose corrections held up best checks first; until then Akọwe keeps its
  usual order (the Settings "Reviewer AI" choice first, then the AIs in slot order). ``manual``: the author's own
  order, e.g. ChatGPT → Claude → Gemini (``order``: the AI families, first = checks first).
* ``off`` — AIs that never check ("don't use for checks"), e.g. ``["gemini"]``. They can still write.

The hard rules stay: the AI that wrote a draft never reviews it while any other AI can (review.plan_reviewer; it is
the last resort only when NO other AI may check, and then the run's "when only one AI works" setting applies and the
draft is listed for you), an AI switched off for checks is never asked to check, and when switching AIs off leaves
fewer checkers than "How many AIs check for mistakes" asks for, the run says so in plain words once
(``shortfall_line``: "Only ChatGPT can check right now because Gemini is switched off for checks and Claude is the
writer").

Where the order is used: each record's review (Book Bible records and chapters: review.plan_reviewer), the second
chapter reviewer (cross_check.second_slot), the all-AI chapter checks, the continuity checkpoints and the end-of-book
ending check (cross_check.checker_slots), and the 🧑‍⚖️ stand-in decider (stand_in.py).
"""
from __future__ import annotations

import copy
import logging

from .errors import AkoweError

log = logging.getLogger("akowe.checker_order")

SETTING = "checker_order"
MODES = ("auto", "manual")
DEFAULT = {"mode": "auto", "order": [], "off": []}
FAMILIES = ("chatgpt", "claude", "gemini")
MODE_WORDS = {"auto": "Automatic: best track record first", "manual": "My own order"}
_FAM_MAX = 8


def _fam_list(v, path: str) -> list[str]:
    if v in (None, ""):
        return []
    if not isinstance(v, list) or len(v) > _FAM_MAX or not all(isinstance(x, str) and 0 < len(x) <= 40 for x in v):
        raise AkoweError("INVALID_INPUT", path, "a list of AIs, e.g. [\"chatgpt\", \"claude\", \"gemini\"]",
                         status="REJECTED")
    return list(dict.fromkeys(x.strip().lower() if x.strip().lower() in FAMILIES else x.strip() for x in v))


def clean(v) -> dict | None:
    """The setting from a request body (``{"mode", "order", "off"}``). None: not given. Raises on a bad value."""
    if v in (None, "", {}):
        return None
    if not isinstance(v, dict):
        raise AkoweError("INVALID_INPUT", "/checker_order", "checker_order: {mode, order, off}", status="REJECTED")
    mode = v.get("mode") or "auto"
    if mode not in MODES:
        raise AkoweError("INVALID_INPUT", "/checker_order/mode", "checker order: auto or manual", status="REJECTED")
    order = _fam_list(v.get("order"), "/checker_order/order")
    off = _fam_list(v.get("off"), "/checker_order/off")
    return {"mode": mode, "order": order, "off": off}


def settings(store) -> dict:
    try:
        cur = store.get_setting(SETTING)
    except Exception:  # noqa: BLE001
        cur = None
    if not isinstance(cur, dict):
        return copy.deepcopy(DEFAULT)
    try:
        return clean(cur) or copy.deepcopy(DEFAULT)
    except AkoweError:
        return copy.deepcopy(DEFAULT)


def save_settings(store, body) -> dict:
    v = clean(body if isinstance(body, dict) else None) or copy.deepcopy(DEFAULT)
    store.set_setting(SETTING, v)
    return v


def of_run(run: dict | None, store) -> dict:
    """The run's own setting (from its start body), else Settings › AI."""
    v = ((run or {}).get("settings") or {}).get("checker_order")
    if isinstance(v, dict):
        try:
            return clean(v) or settings(store)
        except AkoweError:
            pass
    return settings(store)


def is_off(policy: dict | None, fam: str | None) -> bool:
    return bool(fam) and fam in set((policy or {}).get("off") or [])


def order_families(store, policy: dict | None, fams: list[str]) -> tuple[list[str], str]:
    """``fams`` (the usual order) in the order the setting asks for; AIs switched off for checks left out.
    Returns (families, how): how = manual | track_record | usual."""
    policy = policy or DEFAULT
    fams = [f for f in dict.fromkeys(fams) if f and not is_off(policy, f)]
    if policy.get("mode") == "manual" and policy.get("order"):
        pos = {f: i for i, f in enumerate(policy["order"])}
        return sorted(fams, key=lambda f: (pos.get(f, len(pos)), fams.index(f))), "manual"
    from . import checker_record  # noqa: PLC0415
    rank = checker_record.ranking(store, fams)
    if rank:
        return rank, "track_record"
    return fams, "usual"


def order_slots(store, policy: dict | None, slots: list[dict]) -> tuple[list[dict], str]:
    """Slot dicts in checking order (one family's slots keep their own order), switched-off families left out."""
    from . import providers as providers_mod  # noqa: PLC0415
    fams = [providers_mod.slot_family(s) or s["slot_id"] for s in slots]
    order, how = order_families(store, policy, fams)
    pos = {f: i for i, f in enumerate(order)}
    keep = [s for s, f in zip(slots, fams) if f in pos]
    return sorted(keep, key=lambda s: (pos[providers_mod.slot_family(s) or s["slot_id"]], slots.index(s))), how


def _names(fams) -> str:
    from .checker_record import name_of  # noqa: PLC0415
    xs = [name_of(f) for f in fams]
    return xs[0] if len(xs) == 1 else ", ".join(xs[:-1]) + " and " + xs[-1] if xs else ""


def shortfall_line(*, can: list[str], off: list[str], writer: str | None, down: list[str], want: int) -> str | None:
    """Plain words when fewer AIs can check than the setting wants (None when there are enough).
    ``can``: the families that can check now; ``off``: switched off for checks; ``writer``: the writer's family;
    ``down``: not working right now."""
    if len(can) >= want:
        return None
    why = []
    if off:
        why.append(f"{_names(off)} {'is' if len(off) == 1 else 'are'} switched off for checks")
    if writer and writer not in off:
        from .checker_record import name_of  # noqa: PLC0415
        why.append(f"{name_of(writer)} is the writer")
    if down:
        why.append(f"{_names(down)} {'is' if len(down) == 1 else 'are'} not working right now")
    because = (" because " + (", ".join(why[:-1]) + " and " + why[-1] if len(why) > 1 else why[0])) if why else ""
    if not can:
        return (f"No AI can check right now{because}. The writer checks its own work as a last resort, and Akọwe "
                "lists those drafts for you to check.")
    verb = "can" if len(can) > 1 else "can"
    return f"Only {_names(can)} {verb} check right now{because}."


def preview(app, store, policy: dict | None = None, writer_slot: str | None = None, want: int = 2) -> dict:
    """For the Make-a-book screen and Settings: the order now (names), who is off, and the shortfall line."""
    from . import providers as providers_mod  # noqa: PLC0415
    from .checker_record import name_of  # noqa: PLC0415
    policy = policy or settings(store)
    try:
        prov = getattr(app.engine.providers, "_base", app.engine.providers)
        slots = [s for s in prov.ai_slots()]
    except Exception:  # noqa: BLE001
        slots = []
    fams_all = list(dict.fromkeys(providers_mod.slot_family(s) or s["slot_id"] for s in slots))
    order, how = order_families(store, policy, fams_all or list(FAMILIES))
    wfam = None
    if writer_slot:
        s = next((x for x in slots if x["slot_id"] == writer_slot), None)
        wfam = providers_mod.slot_family(s) if s else None
    working = set()
    for s in slots:
        try:
            if s.get("healthy", True) and prov.available(s):
                working.add(providers_mod.slot_family(s) or s["slot_id"])
        except Exception:  # noqa: BLE001
            continue
    can = [f for f in order if f in working and f != wfam]
    down = [f for f in fams_all if f not in working and not is_off(policy, f) and f != wfam]
    off = [f for f in policy.get("off") or []]
    line = shortfall_line(can=can, off=[f for f in off if f in fams_all], writer=wfam, down=down, want=want) \
        if slots else None
    return {"policy": policy, "how": how, "order": order, "order_words": " → ".join(name_of(f) for f in order),
            "off_words": _names(off), "mode_words": MODE_WORDS.get(policy.get("mode"), ""), "shortfall": line,
            "families": [{"family": f, "name": name_of(f)} for f in dict.fromkeys(list(FAMILIES) + fams_all)]}
