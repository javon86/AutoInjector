"""✔ When may an AI's APPROVE approve a draft without the author? (holes H6 and H14, docs/HOLES_2026-11.md)

H6 — no self-approval. An AI review approves a draft automatically (standing auto-approve, or inside a Make-a-book
run) only when ALL of these hold:

* the reviewer is a different AI from the writer (``independent``: another slot of another family — two slots on
  the same web site are the same AI);
* it gives at least one reason;
* its confidence is at least ``MIN_CONFIDENCE``.

Otherwise the draft waits for the author with one plain decision ("Only ChatGPT is working, so nobody else checked
this chapter — approve it yourself, or wait for another AI").

H14 — approved without checks. "Approve anyway", a standing auto-approve and "approve it yourself" skip (part of)
Akọwe's checks. Each such approval is written down here (settings ``approved_unchecked:<project>:<branch>``) with
what was skipped; the editor and the plan check then still run as notes (autobook.py) and their outcome is stored
next to it. The book report and the Book home list these chapters.
"""
from __future__ import annotations

import copy
import logging
from datetime import datetime, timezone

log = logging.getLogger("akowe.approval_trust")

MIN_CONFIDENCE = 0.6
SITE_WORDS = {"claude": "Claude", "chatgpt": "ChatGPT", "gemini": "Gemini"}

FIX_WORDS = ("Decide: ✔ Approve it yourself (read it first), or 🔁 Try again when another AI is connected "
             "(Settings › AI) — it will check it then.")


def ai_word(slot: dict | None) -> str:
    """The AI's everyday name: "ChatGPT", "Claude", or the slot id."""
    if not slot:
        return "the AI"
    if slot.get("adapter_id") == "autoinjector" and slot.get("site"):
        return SITE_WORDS.get(slot["site"], str(slot["site"]))
    if slot.get("adapter_id") == "anthropic":
        return "Claude"
    return str(slot.get("slot_id") or "the AI")


def what_word(label: str | None) -> str:
    """"chapter ch3" -> "chapter ch3"; empty -> "draft"."""
    return (label or "draft").strip() or "draft"


def problem(review: dict | None, label: str | None = None, ai_name: str | None = None) -> dict | None:
    """None when this APPROVE may approve on its own; else {code, message, fix} in plain words."""
    review = review or {}
    if review.get("verdict") != "APPROVE":
        return None
    what = what_word(label)
    if review.get("independent") is False:
        who = ai_name or "one AI"
        return {"code": "NO_SECOND_AI",
                "message": f"Only {who} is working, so nobody else checked this {what} — approve it yourself, or "
                           "wait for another AI.",
                "fix": FIX_WORDS}
    if not [r for r in review.get("reasons") or [] if str(r).strip()]:
        return {"code": "NO_REASON",
                "message": f"The AI reviewer said APPROVE for the {what} but gave no reason — read it and approve it "
                           "yourself, or let the AI check it again.",
                "fix": FIX_WORDS}
    conf = review.get("confidence")
    if not isinstance(conf, (int, float)) or isinstance(conf, bool) or conf < MIN_CONFIDENCE:
        how = f"{round(float(conf) * 100)}%" if isinstance(conf, (int, float)) and not isinstance(conf, bool) \
            else "no confidence given"
        return {"code": "LOW_CONFIDENCE",
                "message": f"The AI reviewer was not sure about the {what} ({how}; it needs at least "
                           f"{round(MIN_CONFIDENCE * 100)}%) — read it and approve it yourself, or let the AI check it "
                           "again.",
                "fix": FIX_WORDS}
    return None


# ====================================================================== H14: approved without checks
def _key(pid: str, branch: str) -> str:
    return f"approved_unchecked:{pid}:{branch}"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


SKIPPED_WORDS = {"approve_anyway": "you approved it anyway (the AI reviewer had not approved it)",
                 "auto_approve": "approved by your standing auto-approve (no editor or plan check before)",
                 "self_review": "only the AI that wrote it checked it (no second AI)",
                 # PR #122: the run kept going with the one working AI (run setting "when only one AI works")
                 "self_review_later": "only the AI that wrote it checked it (no second AI was working) — needs your "
                                      "check later"}


def note(store, pid: str, branch: str, rec: dict, *, how: str, label: str | None = None,
         chapter_id: str | None = None, by: str | None = None) -> dict:
    """Write down that this exact revision was approved without (all) checks. Never raises."""
    try:
        cur = store.get_setting(_key(pid, branch)) or {}
        cur = copy.deepcopy(cur) if isinstance(cur, dict) else {}
        e = {"record_id": rec.get("record_id"), "version": rec.get("version"), "module_id": rec.get("module_id"),
             "label": label, "chapter_id": chapter_id, "how": how, "why": SKIPPED_WORDS.get(how, how), "by": by,
             "at": _now(), "notes": {}, "notes_done": False}
        cur[str(rec.get("record_id"))] = e
        store.set_setting(_key(pid, branch), cur)
        return e
    except Exception:  # noqa: BLE001 - a record of it, never a reason to fail the approval
        log.exception("could not note an approval without checks")
        return {}


def add_notes(store, pid: str, branch: str, rid: str, notes: dict) -> None:
    try:
        cur = store.get_setting(_key(pid, branch)) or {}
        if not isinstance(cur, dict) or rid not in cur:
            return
        cur = copy.deepcopy(cur)
        cur[rid].setdefault("notes", {}).update(notes)
        cur[rid]["notes_done"] = True
        store.set_setting(_key(pid, branch), cur)
    except Exception:  # noqa: BLE001
        log.exception("could not store the after-approval notes")


def entries(store, pid: str, branch: str, *, current_only: bool = True) -> list[dict]:
    """The approvals without checks, oldest first. ``current_only``: only those whose revision is still the
    approved one (a chapter approved again later after a full check drops off)."""
    try:
        cur = store.get_setting(_key(pid, branch)) or {}
    except Exception:  # noqa: BLE001
        return []
    out = []
    for rid, e in (cur.items() if isinstance(cur, dict) else []):
        if not isinstance(e, dict):
            continue
        if current_only:
            try:
                head = store.query("SELECT approved_version FROM heads WHERE project_id=? AND branch_id=? AND "
                                   "record_id=?", (pid, branch, rid))
            except Exception:  # noqa: BLE001
                head = []
            if head and head[0]["approved_version"] not in (None, e.get("version")):
                continue
        out.append(dict(e, line=line(e)))
    return sorted(out, key=lambda e: e.get("at") or "")


def line(e: dict) -> str:
    what = e.get("label") or e.get("module_id") or "draft"
    s = f"{what}: approved without checks — {e.get('why') or e.get('how')}"
    n = e.get("notes") or {}
    bits = []
    if n.get("editor"):
        bits.append(f"editor afterwards: {n['editor']}")
    if n.get("planned"):
        bits.append(f"plan check afterwards: {n['planned']}")
    return s + (f" ({'; '.join(bits)})" if bits else "")


def forget(store, pid: str, branch: str, rid: str) -> None:
    """The draft was fully checked and approved again: it is no longer 'approved without checks'."""
    try:
        cur = store.get_setting(_key(pid, branch)) or {}
        if isinstance(cur, dict) and rid in cur:
            cur = copy.deepcopy(cur)
            cur.pop(rid)
            store.set_setting(_key(pid, branch), cur)
    except Exception:  # noqa: BLE001
        log.exception("could not update the approvals without checks")
