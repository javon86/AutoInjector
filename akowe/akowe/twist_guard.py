"""🤫 Hide the twist better — planning rules only (no AI call of its own).

In one book all three beta readers guessed the twist in chapter 1: the clues pointed one way only and the writer
signalled the secret from the start. These rules go into prompts Akọwe already sends:

* the planners (main plot B03, mystery / reveal plan B08 and the chapter outline B11; ``planner_rule``): every clue
  to a secret or twist also has a believable innocent explanation; at least one fair red herring (a clue that points
  somewhere else, honestly explained later); and the earliest chapter where a reader may work the twist out — never
  before about two-thirds of the book (``FRACTION``), named as "chapter K of N" when the chapter count is known;
* the writer of every chapter BEFORE that point (chapter_brief.py: ``twist_guard`` + one rule; ``writer_block``):
  "do not confirm or over-signal <secret>; keep its clues ambiguous". The secrets are the book's protected mysteries
  (story-rules ledger, category ``mystery``); without any, the rule speaks of "the secret or twist the plan hides".

Setting ``twist_guard`` ({"enabled": bool}, default on) switches it off. Pure reads; never raises.
"""
from __future__ import annotations

import logging
import math

log = logging.getLogger("akowe.twist_guard")

SETTING = "twist_guard"
FRACTION = 0.65          # a twist may be worked out from about 65% of the book on (not before)
MAX_SECRETS = 4
SECRET_CHARS = 160
GENERIC = "the secret or twist the plan hides"


def settings(store) -> dict:
    try:
        cur = store.get_setting(SETTING) if store is not None else None
    except Exception:  # noqa: BLE001
        cur = None
    on = cur.get("enabled") if isinstance(cur, dict) else None
    return {"enabled": True if on is None else bool(on)}


def save_settings(store, body) -> dict:
    from .errors import AkoweError  # noqa: PLC0415
    if not isinstance(body, dict) or not isinstance(body.get("enabled"), bool):
        raise AkoweError("INVALID_INPUT", "/enabled", "enabled must be true or false", status="REJECTED")
    store.set_setting(SETTING, {"enabled": body["enabled"]})
    return settings(store)


def earliest_chapter(n: int | None) -> int | None:
    """The earliest chapter (1-based) where a reader may work the twist out: about 65% of the way through."""
    try:
        n = int(n)
    except (TypeError, ValueError):
        return None
    if n <= 0:
        return None
    if n <= 2:
        return n
    return max(2, min(n, math.ceil(FRACTION * n)))


def planner_rule(n: int | None = None) -> str:
    """The planning rule for the plot (B03), the reveal plan (B08) and the outline (B11)."""
    k = earliest_chapter(n) if n else None
    when = (f"chapter {k} of {n}" if k and n else "about two-thirds of the way through the book (not before)")
    return ("Hide every secret and twist fairly: (1) every clue that points to a secret or twist must also have a "
            "believable innocent explanation a reader would accept at the time; (2) plant at least one fair red "
            "herring — a clue that points somewhere else and is honestly explained later; (3) the earliest point where "
            f"an attentive reader may work out the twist is {when}: the plan places its clues so that it cannot be "
            "worked out before then, and no earlier chapter confirms it or leans on it.")


def secrets(store, pid: str, branch: str) -> list[str]:
    """The book's secrets: its protected mysteries (story-rules ledger), short."""
    try:
        from . import story_rules  # noqa: PLC0415
        rules = story_rules.active(story_rules.get_entry(store, pid, branch))
        out = [str(r.get("text") or "").strip()[:SECRET_CHARS] for r in rules if r.get("category") == "mystery"]
        return [s for s in out if s][:MAX_SECRETS]
    except Exception:  # noqa: BLE001
        log.debug("could not read the protected mysteries", exc_info=True)
        return []


def writer_block(store, pid: str, branch: str, number: int | None, total: int | None) -> dict | None:
    """The chapter brief's ``twist_guard`` block for chapter ``number`` of ``total`` — only BEFORE the earliest chapter
    a reader may work the twist out. None when switched off, unknown, or at / after that point."""
    try:
        if not settings(store)["enabled"] or not number or not total:
            return None
        k = earliest_chapter(total)
        if not k or int(number) >= k:
            return None
        secs = secrets(store, pid, branch)
        names = secs or [GENERIC]
        return {"secrets": names, "may_be_worked_out_from_chapter": k,
                "rule": "; ".join(f"do not confirm or over-signal “{s}”; keep its clues ambiguous" for s in names)}
    except Exception:  # noqa: BLE001
        log.debug("could not build the twist guard", exc_info=True)
        return None


WRITER_RULE = ("Twist guard (context.writing_brief.twist_guard): this chapter comes before the point where a reader "
               "may work out the secret(s). Do not confirm or over-signal them; keep their clues ambiguous — every "
               "clue you show must also have a believable innocent explanation, no knowing looks, no narrator hints, "
               "no character thinking the answer.")
