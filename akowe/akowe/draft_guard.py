"""🧹 Junk refused early: a chapter draft the AI just wrote is checked BEFORE it goes to review.

Three things no reviewer should have to catch at the end of the book:

* **the same text again** — the draft repeats an approved chapter (word for word once case, spacing and a "# "
  title line are ignored, or most of its paragraphs are another chapter's): the draft is set aside and the writer
  writes the chapter again, told not to repeat that chapter (``SAME_ASKS`` times); still the same → the run pauses
  with a clear message (the draft is set aside, so 🔁 Try again writes it fresh). The final content check (H06)
  would refuse such a book anyway, after every chapter was approved;
* **far too short** — a sentence or two instead of a chapter: under ``SHORT_WORDS`` words AND under ``SHORT`` of the
  words the writer was asked for (after its own continuation rounds, long_chapter.py): asked again once, told the
  length; still that short → the run pauses (a chapter that is merely short is the length guard's and the editor's
  business, not this one's);
* **far too long** — over ``LONG`` × its target: sent back once to be written at its length; still over ``HARD_LONG``
  × → the run pauses; otherwise a ⚠️ note.

Only drafts the AI wrote in this run are checked (``after_write`` is called right after the writer's CREATE); the
author's own text is never set aside. The note for the writer travels in the chapter's instruction
(``with_note``). Never holds up the book by itself failing: an unexpected error is logged (codes only) and the draft
goes on as before. Journal / log lines carry numbers and chapter numbers only, never book text.
"""
from __future__ import annotations

import logging
import re

log = logging.getLogger("akowe.draft_guard")

SAME_ASKS = 2        # the same text: written again this many times, then the run pauses
LENGTH_ASKS = 1      # far too short / long: written again once
SHORT = 0.25         # under a quarter of the words asked for …
SHORT_WORDS = 20     # … and under 20 words (a sentence or two): far too short — not a chapter at all
LONG = 3.0           # over three times the words asked for: far too long
HARD_LONG = 10.0     # still over ten times after asking again: the run pauses
SAME_SHARE = 0.8     # this share of the draft's paragraph text found in another chapter: the same text
PARA_MIN = 40        # paragraphs shorter than this are not compared (dialogue lines, scene breaks)
NOTE_MAX = 400

_TITLE = re.compile(r"^\s*#[^\n]*\n")
_PUNCT = re.compile(r"[^\w\s]+")


# ====================================================================== the pure part
def _norm(text: str) -> str:
    return " ".join(_PUNCT.sub(" ", str(text or "").casefold()).split())


def body(text: str) -> str:
    """The chapter text without its "# " title line."""
    return _TITLE.sub("", str(text or ""), count=1)


def _paras(text: str) -> list[str]:
    out = []
    for p in re.split(r"\n\s*\n", body(text)):
        n = _norm(p)
        if len(n) >= PARA_MIN:
            out.append(n)
    return out


def same_text(new: str, old: str) -> bool:
    """True when ``new`` is ``old`` again: the same words once case, punctuation, spacing and the title line are
    ignored, or at least ``SAME_SHARE`` of its paragraph text is paragraphs of ``old``."""
    a, b = _norm(body(new)), _norm(body(old))
    if not a or not b:
        return False
    if a == b:
        return True
    pa = _paras(new)
    if not pa:
        return False
    have = set(_paras(old))
    shared = sum(len(p) for p in pa if p in have)
    return shared >= SAME_SHARE * sum(len(p) for p in pa)


def words(text: str) -> int:
    return len(str(text or "").split())


def length_kind(n: int, target: int | None) -> str | None:
    """"short" / "long" when ``n`` words are far from ``target`` (None: fine, or no target)."""
    if not target or target <= 0:
        return None
    r = n / target
    if r < SHORT and n < SHORT_WORDS:
        return "short"
    if r > LONG:
        return "long"
    return None


def too_far(n: int, target: int, kind: str) -> bool:
    """Still so far from the target after asking again that the book should not go on with it."""
    return kind == "short" or n / max(1, target) > HARD_LONG


# ====================================================================== the run part
def with_note(run: dict, cid: str, payload: dict) -> dict:
    """The C02 payload with the writer's note for this chapter (why its last draft was set aside) in front of the
    instruction (the instruction stays within its 2 000 characters)."""
    note = ((run.get("draft_guard") or {}).get(cid) or {}).get("note")
    if not note or not isinstance(payload, dict) or not isinstance(payload.get("instruction"), str):
        return payload
    note = note[:NOTE_MAX]
    return dict(payload, instruction=(note + " " + payload["instruction"])[:2000])


def _target(svc, run, rec: dict, n_chapters: int) -> int | None:
    """The words the writer was asked for: what this draft was written with (c_meta), else the book's plan."""
    try:
        meta = svc.store.get_state(run["project_id"], run["branch_id"], "c_meta", rec["record_id"]) or {}
        t = (meta.get("length") or {}).get("target_words")
        if isinstance(t, (int, float)) and t > 0:
            return int(t)
        from . import lengths  # noqa: PLC0415
        from .book_path import get_profile  # noqa: PLC0415
        prof = get_profile(svc.store, run["project_id"])
        if not prof.get("length"):
            return None
        return int(lengths.chapter_plan(prof, n_chapters, svc.store)["target_words"]) or None
    except Exception:  # noqa: BLE001 - no target: no length check
        log.exception("draft guard: no chapter target for run %s", run.get("id"))
        return None


def _same_as(bp, outline, chapters, cid: str, text: str) -> int | None:
    """The number of an approved chapter (other than ``cid``) whose text the draft repeats, else None."""
    for i, ch in enumerate(chapters):
        if ch["chapter_id"] == cid:
            continue
        _ctx, _latest, appr = bp.chapter_prose(outline, ch["chapter_id"])
        if appr and same_text(text, (appr.get("data") or {}).get("text") or ""):
            return i + 1
    return None


def after_write(svc, run, st, outline, chapters, cid: str, idx: int, rid: str, item: dict) -> bool:
    """Check the draft the AI just wrote for chapter ``cid`` (number ``idx + 1``). True: it was set aside and the
    caller writes the chapter again. False: it goes on to review. Raises StepProblem to pause the run (the draft set
    aside); the run's pause / cancel propagate."""
    from .autobook import StepProblem  # noqa: PLC0415
    try:
        return _after_write(svc, run, st, outline, chapters, cid, idx, rid, item)
    except StepProblem:
        raise
    except Exception as exc:  # noqa: BLE001 - this check never stops the book by itself failing
        if getattr(exc, "control", False) or type(exc).__name__ in ("RunPaused", "RunCancelled", "Cancelled"):
            raise
        log.exception("draft guard: chapter check failed in run %s", run.get("id"))
        return False


def _after_write(svc, run, st, outline, chapters, cid, idx, rid, item) -> bool:
    from .autobook import StepProblem  # noqa: PLC0415
    bp = svc.bp(run)
    rec = bp.rec(rid)
    if rec is None or rec.get("stale"):
        return False
    text = str((rec.get("data") or {}).get("text") or "")
    number = idx + 1
    mem_all = run.setdefault("draft_guard", {})
    mem = mem_all.setdefault(cid, {})
    item.pop("length_warning", None)
    other = _same_as(bp, outline, chapters, cid, text)
    n, target = words(text), None
    if other is not None:
        kind = "same"
    else:
        target = _target(svc, run, rec, len(chapters))
        kind = length_kind(n, target)
    if kind is None:
        mem_all.pop(cid, None)
        return False
    asks = SAME_ASKS if kind == "same" else LENGTH_ASKS
    tries = int(mem.get(kind) or 0)
    if kind == "same":
        why = f"its text was the same as chapter {other}'s"
        note = (f"Your last draft of this chapter repeated chapter {other} word for word: write chapter {number} as "
                f"new text that follows its own objective, never chapter {other}'s.")
    elif kind == "short":
        why = f"it was far too short ({n:,} of about {target:,} words)"
        note = (f"Your last draft of this chapter had only {n:,} words: write the WHOLE chapter, about {target:,} "
                "words, with every planned scene.")
    else:
        why = f"it was far too long ({n:,} of about {target:,} words)"
        note = (f"Your last draft of this chapter had {n:,} words: write it at about {target:,} words, only what "
                "this chapter's objective needs, never repeating passages.")
    if tries < asks:
        mem.update({kind: tries + 1, "note": note})
        bp.set_aside(rec, f"chapter {number}: {why}; the AI writes it again")
        svc.event(run, "fix", f"Chapter {number}'s draft was set aside before its review: {why}; the AI writes it "
                  f"again ({tries + 1} of {asks})", step="chapters", code="DRAFT_REFUSED_EARLY", chapter_id=cid,
                  record_id=rid)
        st["message"] = f"The AI is writing chapter {number} again ({why})"
        run["phase"] = st["message"]
        svc.save(run)
        return True
    if kind == "same" or too_far(n, target, kind):
        bp.set_aside(rec, f"chapter {number}: {why}, also after asking again")
        mem_all.pop(cid, None)  # 🔁 Try again starts fresh
        svc.event(run, "problem", f"Chapter {number}'s draft was set aside: {why}, also after asking the AI again",
                  step="chapters", code="CHECKS_REFUSED", chapter_id=cid, record_id=rid)
        svc.save(run)
        if kind == "same":
            raise StepProblem("CHECKS_REFUSED", f"The AI wrote chapter {number} {asks + 1} times, and each time its "
                              f"text was the same as chapter {other}'s.",
                              f"Press 🔁 Try again: the AI writes chapter {number} again, told not to repeat chapter "
                              f"{other}. If it keeps happening, let another AI write (Settings).",
                              chapter_id=cid)
        raise StepProblem("CHECKS_REFUSED", f"The AI wrote chapter {number} {asks + 1} times, and each time "
                          f"{'far too short' if kind == 'short' else 'far too long'} (last: {n:,} words; about "
                          f"{target:,} were asked for).",
                          f"Press 🔁 Try again: the AI writes chapter {number} again. If it keeps happening, let "
                          "another AI write (Settings).", chapter_id=cid)
    # still far from its length, but a usable chapter: it goes on, marked for the author
    warn = f"far too {'short' if kind == 'short' else 'long'} ({n:,} of about {target:,} words)"
    item["length_warning"] = warn
    mem_all.pop(cid, None)
    svc.event(run, "note", f"⚠️ Chapter {number} is {warn}, also after asking the AI again; it goes on to its "
              "review — you can extend or shorten it in the chapter's page", step="chapters",
              code="CHAPTER_TOO_SHORT" if kind == "short" else "CHAPTER_TOO_LONG", chapter_id=cid, record_id=rid)
    return False
