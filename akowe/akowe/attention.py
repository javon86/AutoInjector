"""⚠️ What in this book needs a look — one list for 🏠 Book home (book_path.status ``attention``).

Gathers, in plain words, without any AI call:

* H14 — drafts approved without (all) checks (approval_trust.py);
* H5 — later chapters to re-check after an earlier chapter was changed by hand (continuity.py ``rechecks``);
* H13 — what was cut from a chapter's instructions because they were too long (brief_cuts.py);
* H11 / H12 — promises the ending did not keep (ending_check.py: setups without a payoff, vanished characters,
  the main character's change, the book's question);
* 🗺 the story map's open conflicts and gap warnings (story_map.py ``attention_lines``).

Never raises: a part that cannot be read is left out.
"""
from __future__ import annotations

import logging

log = logging.getLogger("akowe.attention")


def of_book(store, pid: str, branch: str) -> dict:
    out = {"unchecked": [], "rechecks": [], "cuts": [], "ending": [], "story_map": [], "lines": []}
    try:
        from . import approval_trust  # noqa: PLC0415
        out["unchecked"] = [{k: e.get(k) for k in ("record_id", "label", "chapter_id", "how", "why", "notes", "line")}
                            for e in approval_trust.entries(store, pid, branch)]
    except Exception:  # noqa: BLE001
        log.exception("attention: approvals without checks")
    try:
        from . import continuity  # noqa: PLC0415
        continuity.check_edits(store, pid, branch)  # a chapter approved again after a hand edit (cheap, no AI)
        out["rechecks"] = continuity.rechecks(store, pid, branch)
    except Exception:  # noqa: BLE001
        log.exception("attention: rechecks")
    try:
        from . import brief_cuts  # noqa: PLC0415
        out["cuts"] = brief_cuts.listing(store, pid, branch)
    except Exception:  # noqa: BLE001
        log.exception("attention: instruction cuts")
    try:
        from . import ending_check  # noqa: PLC0415
        out["ending"] = ending_check.open_items(store, pid, branch)
    except Exception:  # noqa: BLE001
        log.exception("attention: ending check")
    try:
        from . import story_map  # noqa: PLC0415
        out["story_map"] = story_map.attention_lines(store, pid, branch)
    except Exception:  # noqa: BLE001
        log.exception("attention: story map")
    try:  # 🧑‍⚖️ decisions a stand-in made while you were away (each with ↩ Undo on Book home)
        from . import stand_in  # noqa: PLC0415
        out["stand_in"] = stand_in.book_notes(store, pid, branch)
    except Exception:  # noqa: BLE001
        log.exception("attention: stand-in decisions")
        out["stand_in"] = []
    lines = [f"⚠️ {e['line']}" for e in out["unchecked"] if e.get("line")]
    lines += [r["message"] for r in out["rechecks"] if r.get("message")]
    lines += [c["line"] for c in out["cuts"] if c.get("line")]
    lines += [f"⚠️ {e['line']}" for e in out["ending"] if e.get("line")]
    lines += out["story_map"]
    out["lines"] = lines
    return out
