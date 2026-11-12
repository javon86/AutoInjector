"""📏 Length guard for Akọwe's own rewrites (no AI; run setting ``length_guard``, on by default).

"The Tide Ledger" was asked for about 4,000 words and came out at 5,756 (144 %): every rewrite pass — the editor's
rewrites, the chapter polish, chapter 1 rewritten last, the final improve pass — tends to add a little explanation and
nothing ever took it out again. So every rewrite the writer is asked for through the editor's rewrite path
(editor.EditorService.propose) now carries a word budget, and is held to it:

* the brief says it (``context.word_budget`` and one sentence in the task): the chapter's words now, the most it may
  have after the rewrite, the book's words against its target, and "prefer cutting repeated explanation";
* a rewrite may grow a chapter by at most ``MAX_GROWTH`` (10 %, and never less than ``SLACK_WORDS`` so a small fix
  always fits; a chapter still under its own target length may grow up to it) and may never push the book past
  ``BOOK_CAP`` (115 %) of its target length;
* when the writer's replacements together grow the chapter too much, the ones that add the most words are left out
  (``trim``: they count as "not used: too long", like any replacement that did not fit) until the rest fits. A
  replacement that makes the chapter shorter or keeps its length is always fine.

The run window and the book report say the finished book's length against its target (``line``). Never raises.
Logs: numbers only.
"""
from __future__ import annotations

import logging
import math

log = logging.getLogger("akowe.length_guard")

SETTING = "length_guard"
MAX_GROWTH = 0.10     # a rewrite may grow a chapter by at most this share …
SLACK_WORDS = 25      # … but always by this many words (a small fix must fit)
BOOK_CAP = 1.15       # and never push the book past this share of its target length
TOO_LONG = "TOO_LONG_FOR_BUDGET"

WORDS = (" WORD BUDGET (context.word_budget): the book is already long enough. The reworked chapter must not have "
         "more than most_words words in all; prefer cutting repeated explanation, restated feelings and summaries of "
         "what the reader just saw over adding anything. A replacement may be shorter than the words it replaces, "
         "never much longer.")


def enabled(settings: dict | None) -> bool:
    return (settings or {}).get(SETTING) is not False


def words(text) -> int:
    return len(str(text or "").split())


def room(chapter_words: int, book_words: int | None = None, book_target: int | None = None,
         chapter_target: int | None = None) -> int:
    """How many words a rewrite may add to a chapter of ``chapter_words`` words (a chapter still under its own
    target length may grow up to it)."""
    r = max(SLACK_WORDS, int(math.floor(chapter_words * MAX_GROWTH)))
    if chapter_target:
        r = max(r, int(chapter_target) - chapter_words)
    if book_target and book_words is not None:
        r = min(r, max(0, int(math.floor(book_target * BOOK_CAP)) - int(book_words)))
    return r


def budget(chapter_words: int, book_words: int | None = None, book_target: int | None = None,
           chapter_target: int | None = None) -> dict:
    """The word budget of one rewrite (also what the writer is told)."""
    r = room(chapter_words, book_words, book_target, chapter_target)
    out = {"chapter_words": chapter_words, "most_words": chapter_words + r, "may_add": r,
           "rule": "Stay within most_words words; prefer cutting repeated explanation over adding."}
    if book_target:
        out.update(book_words=book_words, book_target=book_target,
                   book_share=f"{round(100 * (book_words or 0) / book_target)}%")
    return out


def check(old_text: str, new_text: str, book_words: int | None = None, book_target: int | None = None,
          chapter_target: int | None = None) -> str | None:
    """None when the rewrite fits; else "CHAPTER" (it grows the chapter too much) or "BOOK" (it pushes the book past
    its cap)."""
    a, b = words(old_text), words(new_text)
    if b <= a:
        return None
    if b - a > room(a, chapter_target=chapter_target):
        return "CHAPTER"
    if book_target and book_words is not None and book_words + (b - a) > book_target * BOOK_CAP:
        return "BOOK"
    return None


def trim(text: str, res: dict, findings: list, keep: list, may_add: int) -> tuple[dict, list[str]]:
    """Leave out the replacements that add the most words until the chapter grows by at most ``may_add`` words.
    Returns (the new apply_replacements result, the finding ids left out)."""
    from .editor import UNRESOLVED_WORDS, apply_replacements  # noqa: PLC0415
    applied = list(res.get("applied") or [])
    grow = words(res.get("text")) - words(text)
    dropped: list[str] = []
    if grow <= may_add or not applied:
        return res, dropped
    by_growth = sorted(applied, key=lambda a: words(a["replacement"]) - words(a["original"]), reverse=True)
    for a in by_growth:
        if grow <= may_add:
            break
        g = words(a["replacement"]) - words(a["original"])
        if g <= 0:
            break
        dropped.append(a["finding_id"])
        grow -= g
    keep_items = [a for a in applied if a["finding_id"] not in dropped]
    out = apply_replacements(text, keep_items, findings, keep)
    out["unresolved"] = [u for u in out["unresolved"] if u["finding_id"] not in dropped] + [
        {"finding_id": f, "reason": TOO_LONG, "message": UNRESOLVED_WORDS.get(TOO_LONG, "it made the chapter too "
                                                                                        "long for the book")}
        for f in dropped]
    return out, dropped


def book_numbers(engine, store, principal, pid: str, branch: str) -> tuple[int | None, int | None, int | None]:
    """(the book's words now, its target words, one chapter's target words); Nones when unknown. Never raises."""
    try:
        from . import lengths  # noqa: PLC0415
        from .fact_checks import book_texts  # noqa: PLC0415
        chs = book_texts(engine, principal, pid, branch)
        total = sum(words(c["text"]) for c in chs)
        plan = lengths.of_book(store, pid)
        per = int(round(plan["book_words"] / max(1, plan["chapters"])))
        return total, plan["book_words"], per
    except Exception:  # noqa: BLE001
        log.exception("could not count the book's words")
        return None, None, None


def line(book_words: int | None, target: int | None) -> str | None:
    """"📏 Length: 4,310 words (108% of the 4,000-word target)" — None when unknown."""
    if not book_words or not target:
        return None
    share = round(100 * book_words / target)
    warn = " ⚠️ longer than planned" if book_words > target * BOOK_CAP else (
        " ⚠️ shorter than planned" if book_words < target * 0.8 else "")
    return f"📏 Length: {book_words:,} words ({share}% of the {target:,}-word target){warn}"
