"""✂️ What was cut from a chapter's instructions because they were too long (hole H13, docs/HOLES_2026-11.md).

The writer's instructions are bounded in several places (the chapter brief: story rules, must-show details, voice
cards, planned details, continuity; the C01 context package: optional facts to fit the AI's context). Before, the
cut was silent ("the newest story rule dropped first"). Now:

* each place cuts the LEAST important first (retired story rules before new ones, must-shows kept before scene
  goals and planned details, …) and says exactly what it cut — the chapter brief's meta ``cut`` (stored with the
  chapter in ``c_meta``) and the C01 finding ``OPTIONAL_OMITTED`` (its message lists the facts);
* ``record`` keeps the latest list per chapter (settings ``brief_cuts:<project>:<branch>``);
* the Make-a-book run says it with ⚠️ (autobook.py), the chapter page shows it (planned.quick ``instructions_cut``)
  and 🏠 Book home lists it (attention.py).
"""
from __future__ import annotations

import copy
import logging
from datetime import datetime, timezone

log = logging.getLogger("akowe.brief_cuts")

MAX_SHOWN = 12


def _key(pid: str, branch: str) -> str:
    return f"brief_cuts:{pid}:{branch}"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _clip(v, n: int = 90) -> str:
    s = " ".join(str(v or "").split())
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def note(cut: list, what: str, items) -> None:
    """Add "what: item; item" to ``cut`` (a list of plain strings) when anything was cut."""
    items = [_clip(i) for i in items or [] if str(i or "").strip()]
    if items:
        cut.append(f"{what}: " + "; ".join(items[:6]) + (f" (+{len(items) - 6} more)" if len(items) > 6 else ""))


def from_context(rec: dict | None) -> list[str]:
    """The optional facts the C01 context package left out to fit the AI's context (its OPTIONAL_OMITTED finding)."""
    out = []
    for f in (rec or {}).get("findings") or []:
        if f.get("rule_id") == "OPTIONAL_OMITTED" and f.get("message"):
            msg = str(f["message"])
            out.append("facts left out to fit the AI's context — " + _clip(msg.split(": ", 1)[-1] if ": " in msg
                                                                          else msg, 300))
    return out


def line(number, cut: list) -> str:
    who = f"Chapter {number}" if number else "A chapter"
    return f"⚠️ {who}: the instructions were too long, so Akọwe left out — " + " · ".join(cut[:MAX_SHOWN])


def record(store, pid: str, branch: str, chapter_id: str, number, cut: list) -> dict | None:
    """Keep what was cut from this chapter's newest instructions (an empty list clears it). Never raises."""
    try:
        cur = store.get_setting(_key(pid, branch)) or {}
        cur = copy.deepcopy(cur) if isinstance(cur, dict) else {}
        if not cut:
            if chapter_id in cur:
                cur.pop(chapter_id)
                store.set_setting(_key(pid, branch), cur)
            return None
        e = {"chapter_id": chapter_id, "number": number, "cut": list(cut)[:MAX_SHOWN], "at": _now()}
        cur[chapter_id] = e
        store.set_setting(_key(pid, branch), cur)
        return e
    except Exception:  # noqa: BLE001
        log.exception("could not record the instruction cuts")
        return None


def of_chapter(store, pid: str, branch: str, chapter_id: str) -> dict | None:
    try:
        e = (store.get_setting(_key(pid, branch)) or {}).get(chapter_id)
    except Exception:  # noqa: BLE001
        return None
    return dict(e, line=line(e.get("number") or chapter_id, e.get("cut") or [])) if isinstance(e, dict) else None


def listing(store, pid: str, branch: str) -> list[dict]:
    try:
        cur = store.get_setting(_key(pid, branch)) or {}
    except Exception:  # noqa: BLE001
        return []
    out = [dict(e, line=line(e.get("number") or cid, e.get("cut") or [])) for cid, e in cur.items()
           if isinstance(e, dict) and e.get("cut")]
    return sorted(out, key=lambda e: (e.get("number") if isinstance(e.get("number"), int) else 999, e["chapter_id"]))


def after_write(store, pid: str, branch: str, chapter_id: str, number, chapter_rid: str | None,
                context_ref: dict | None) -> dict | None:
    """A chapter was just written: keep (and return) what its instructions left out. Never raises."""
    try:
        cut = of_chapter_record(store, pid, branch, chapter_rid) if chapter_rid else []
        if context_ref:
            ctx = store.get_record(pid, branch, context_ref["record_id"], context_ref["version"])
            cut += from_context(ctx)
        e = record(store, pid, branch, chapter_id, number, cut)
        return dict(e, line=line(number or chapter_id, e["cut"])) if e else None
    except Exception:  # noqa: BLE001
        log.exception("could not read the instruction cuts")
        return None


def of_chapter_record(store, pid: str, branch: str, rid: str) -> list[str]:
    """The cut list stored with a written chapter (c_meta of its first version: the chapter brief's meta)."""
    try:
        hist = store.history(pid, branch, rid)
        first = hist[0] if hist else None
        meta = store.get_state(pid, branch, "c_meta", (first or {}).get("record_id") or rid) or {}
        return list(((meta.get("brief") or {}).get("cut")) or [])
    except Exception:  # noqa: BLE001
        return []
