"""📊 Whole-book budgets for the AI's habits, and keeping its own tics out of what it rereads (no AI).

Why (docs: "AI novel quality beyond eight", recommendation 11): the Hachette *Shy Girl* novel was caught through
whole-book counts ("sharp" 159 times in about 214 pages), not through any one sentence; Claude overuses "any literary
device one might associate with good writing once it appears in the context window"; autonovel's quality dropped after
chapter 6 until the rules found so far were added to the writer's instructions; and "instructions alone are not
enough, you have to prune the slop" from what the model rereads. Caps work better than bans.

What already existed and is NOT repeated here: the chapter brief's ``quality_lessons.avoid`` (quality_history.py:
phrases and similes the chapters before already used, the plain-word tics of ``TIC_WORDS``) and ``human_voice``'s own
repeat offenders. This module adds what they do not have — *budgets* with caps, counted over the WHOLE book:

* per chapter: at most ``CAPS["not_but"]`` "not X but Y" constructions, ``CAPS["triad"]`` lists of three in the
  narration, ``EXPLAIN_SHARE`` of the narration sentences spent explaining what the scene already showed (a feeling
  named, "because", "which meant", "she realized" …) and about one simile per ``SIMILE_WORDS`` words;
* per book: a simile used in ``SIMILE_REPEAT`` or more chapters; a content word used more than ``WORD_RATE`` times per
  1 000 words across the book and at least ``WORD_MIN`` times (the book's names and the plan's own words — its
  places, objects, plot — are left out: a lighthouse book may say "lighthouse"); two chapters in a row ending with
  the same move (human_voice.closing_kind).

How it works in a ⚡ Make-a-book run (run setting ``book_budgets``, on by default; no AI calls at all):

1. **Measure** (``record``): after each chapter is approved its counts are stored (setting
   ``book_budgets:<project>:<branch>``, per chapter: numbers, the similes and the most used content words — never a
   sentence of the book).
2. **Feed forward** (``writer_block`` → chapter brief ``book_budgets`` + ``BRIEF_RULE``): what is over budget in the
   chapters before is told to the writer of the next chapters ("at most 1 'not X but Y' (chapter 3 had 4)"; "similes
   already used twice — do not reuse"; "words this book leans on — allowed, but at most twice here").
3. **Cut targets** (``cut_targets``): the exact sentences of a fresh chapter that are over a budget go to the ✂ cut
   pass (cut_pass.py) as preferred cuts.
4. **Reread filter** (``reread_filter``): the over-used similes are taken out of the narration of
   ``previous_chapter_end`` and ``story_so_far`` before the writer rereads them (the dialogue is never touched), so the
   AI's own tic is not fed back to it; the brief says so (``REREAD_RULE``).
5. **Report** (``report_info`` / ``report_md``): the book's counts against the budgets, chapter by chapter.

Never raises from the brief, the report or the run hooks; logs carry numbers only.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
from collections import Counter
from datetime import datetime, timezone

from . import dialogue

log = logging.getLogger("akowe.book_budgets")

SETTING = "book_budgets"            # run setting (on unless switched off)
CAPS = {"not_but": 1, "triad": 2}   # per chapter
EXPLAIN_SHARE = 0.12                # explaining sentences per narration sentence, per chapter
EXPLAIN_MIN = 3                     # … and at least this many before it counts
SIMILE_WORDS = 450                  # about one simile per this many words of a chapter (at least SIMILE_MIN)
SIMILE_MIN = 3
SIMILE_REPEAT = 2                   # the same simile in this many chapters is over budget
WORD_RATE = 1.5                     # a content word used more than this per 1 000 words of the book …
WORD_MIN = 12                       # … and at least this many times
WORDS_SHOWN = 6
VOCAB_KEPT = 80                     # content words stored per chapter (the most used ones)
RECENT = 3                          # per-chapter budgets: the last N chapters before this one are read
BRIEF_MAX = 900                     # characters of JSON for the brief's book_budgets block
TARGETS_MAX = 8                     # cut targets per chapter

BRIEF_RULE = ("Book budgets (context.writing_brief.book_budgets): Akọwe counts these habits over the whole book and "
              "they are over budget in the chapters before. Stay within every cap in this chapter. These are caps, "
              "not bans: a word or device may still appear where it is the precise choice — just not by habit.")
REREAD_RULE = ("Akọwe took this book's over-used similes out of the narration of previous_chapter_end and "
               "story_so_far before you read them; do not bring them back.")

LABELS = {"not_but": "“Not X but Y” sentences", "triad": "Lists of three", "explain": "Explaining what the scene "
          "showed", "simile": "Similes", "simile_repeat": "A simile used in several chapters",
          "word": "A word the book leans on", "ending": "Chapters ending the same way"}

_NOT_PAR = re.compile(r"\bnot\b[^.;!?]{1,60}?,\s*(?:and\s+|but\s+)?not\b|\bnot\b[^.;!?,]{1,40}?\bbut\b", re.I)
_TRIAD = re.compile(r"\b([\w'’-]+(?: [\w'’-]+){0,2}), ([\w'’-]+(?: [\w'’-]+){0,2}),? (?:and|or) ([\w'’-]+(?: [\w'’-]+){0,2})\b")
_SIMILE = re.compile(r"\b(?:like|as if|as though) (?:a|an|the|some) ([a-z'-]{3,})(?: ([a-z'-]{3,}))?", re.I)
_EXPLAIN = re.compile(r"\b(?:because|which meant|that meant|it meant|meaning that|reali[sz]ed|understood that|"
                      r"knew then|knew that|it was clear|in other words|the truth was|(?:she|he|they|i|we) felt|"
                      r"felt (?:a|an|the) (?:wave|surge|pang|rush|flicker|stab|sense)|a sense of|could not help but|"
                      r"couldn't help but|for the first time)\b", re.I)
_SENT = re.compile(r"[^.!?…\n]+[.!?…]+[\"'”’)]*", re.S)
_WORD = re.compile(r"[a-z][a-z'’-]{3,}")
_LOCK = threading.RLock()
_CACHE: dict = {}
_CACHE_MAX = 64


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _key(pid: str, branch: str) -> str:
    return f"book_budgets:{pid}:{branch}"


def enabled(settings: dict | None) -> bool:
    return (settings or {}).get(SETTING) is not False


# ====================================================================== measuring one chapter (pure)
def _similes(narr: str) -> Counter:
    from .prose_audit import STOP  # noqa: PLC0415
    out: Counter = Counter()
    for m in _SIMILE.finditer(narr):
        two = m.group(2) and m.group(2).lower() not in STOP and not m.group(2).lower().endswith("ing")
        s = m.group(0) if two else m.group(0)[: m.end(1) - m.start()]
        out[" ".join(s.lower().split())] += 1
    return out


def measure(text: str, skip_words=()) -> dict:
    """The budget counts of one chapter (numbers, its similes and its most used content words; no sentences).
    ``skip_words``: lower-case words never counted as content words (names, the plan's own words)."""
    text = str(text or "")
    h = hashlib.sha1((text + "\0" + " ".join(sorted(skip_words))).encode("utf-8")).hexdigest()
    with _LOCK:
        hit = _CACHE.get(h)
    if hit is not None:
        return json.loads(hit)
    from .prose_audit import STOP  # noqa: PLC0415
    narr = dialogue.narration(text)
    sents = [s for s in _SENT.findall(narr) if len(s.split()) >= 3]
    skip = {w.lower() for w in skip_words}
    vocab = Counter(w.replace("’", "'") for w in _WORD.findall(text.lower()))
    vocab = Counter({w: k for w, k in vocab.items() if w not in STOP and w not in skip and k >= 2})
    last = ""
    try:
        from .human_voice import _first_last, closing_kind  # noqa: PLC0415
        last = closing_kind(_first_last(text)[1]) or ""
    except Exception:  # noqa: BLE001
        log.exception("closing kind")
    out = {"words": len(text.split()), "not_but": len(_NOT_PAR.findall(narr)), "triad": len(_TRIAD.findall(narr)),
           "explain": sum(1 for s in sents if _EXPLAIN.search(s)), "sentences": len(sents),
           "simile": dict(_similes(narr)), "ending": last, "vocab": dict(vocab.most_common(VOCAB_KEPT))}
    with _LOCK:
        if len(_CACHE) >= _CACHE_MAX:
            _CACHE.clear()
        _CACHE[h] = json.dumps(out)
    return out


def simile_cap(words: int) -> int:
    return max(SIMILE_MIN, int(words or 0) // SIMILE_WORDS)


def chapter_over(m: dict) -> list[dict]:
    """The per-chapter budgets one chapter's counts are over: [{code, count, cap}]."""
    out = []
    for code, cap in CAPS.items():
        if int(m.get(code) or 0) > cap:
            out.append({"code": code, "count": int(m[code]), "cap": cap})
    n_s, n_e = int(m.get("sentences") or 0), int(m.get("explain") or 0)
    if n_s and n_e >= EXPLAIN_MIN and n_e / n_s > EXPLAIN_SHARE:
        out.append({"code": "explain", "count": round(100 * n_e / n_s), "cap": round(100 * EXPLAIN_SHARE)})
    sim = sum((m.get("simile") or {}).values())
    if sim > simile_cap(m.get("words") or 0):
        out.append({"code": "simile", "count": sim, "cap": simile_cap(m.get("words") or 0)})
    return out


def book_over(entries: list[dict]) -> dict:
    """The whole-book budgets of the measured chapters (in book order): {similes: [(simile, chapters)], words:
    [(word, count, per_1000)], ending: (kind, [n1, n2]) | None}."""
    sim_ch: Counter = Counter()
    for e in entries:
        for s in (e.get("simile") or {}):
            sim_ch[s] += 1
    similes = [(s, k) for s, k in sim_ch.most_common() if k >= SIMILE_REPEAT][:WORDS_SHOWN]
    total = sum(int(e.get("words") or 0) for e in entries)
    vocab: Counter = Counter()
    for e in entries:
        vocab.update(e.get("vocab") or {})
    from .quality_history import TIC_WORDS  # noqa: PLC0415 - those plain-word tics are quality_history's own list
    words = []
    if total >= 300:
        for w, k in vocab.most_common(40):
            rate = 1000 * k / total
            if k >= WORD_MIN and rate > WORD_RATE and w not in TIC_WORDS:
                words.append((w, k, round(rate, 1)))
    ending = None
    if len(entries) >= 2:
        a, b = entries[-2], entries[-1]
        if a.get("ending") and a.get("ending") == b.get("ending"):
            ending = (a["ending"], [a.get("number"), b.get("number")])
    return {"similes": similes, "words": words[:WORDS_SHOWN], "ending": ending, "total_words": total}


# ====================================================================== storage
def stored(store, pid: str, branch: str) -> dict:
    v = store.get_setting(_key(pid, branch))
    return v if isinstance(v, dict) and isinstance(v.get("chapters"), dict) else {"chapters": {}}


def skip_words(store, pid: str, branch: str, outline: dict | None) -> list[str]:
    """Names and the plan's own words: never counted as a word the book leans on. Never raises."""
    out: set = set()
    try:
        from . import characters as chars_mod  # noqa: PLC0415
        for c in chars_mod.canon_characters(store, pid, branch):
            out |= {p.lower() for p in re.findall(r"[A-Za-z'’-]+", c.get("name") or "")}
    except Exception:  # noqa: BLE001
        log.exception("names for the budgets")
    try:
        from .book_path import BookPath  # noqa: PLC0415
        for c in BookPath.outline_chapters(None, outline) if outline else []:
            out |= set(_WORD.findall(f"{c.get('objective') or ''} {c.get('summary') or ''}".lower()))
    except Exception:  # noqa: BLE001
        log.exception("plan words for the budgets")
    return sorted(out)


def record(store, pid: str, branch: str, outline: dict | None, chapter_id: str, number: int, rec: dict | None) -> dict | None:
    """⚡ After a chapter is approved: store its counts. Returns the entry (None when nothing could be measured)."""
    try:
        text = str(((rec or {}).get("data") or {}).get("text") or "")
        if not text.strip():
            return None
        m = measure(text, skip_words(store, pid, branch, outline))
        e = dict(m, chapter_id=chapter_id, number=number, record_id=(rec or {}).get("record_id"),
                 version=(rec or {}).get("version"), at=_now())
        with _LOCK:
            cur = stored(store, pid, branch)
            cur["chapters"][chapter_id] = e
            cur["outline"] = (outline or {}).get("record_id")
            cur["updated_at"] = _now()
            store.set_setting(_key(pid, branch), cur)
        log.info("book budgets: chapter %s measured (%s over)", number, len(chapter_over(e)))
        return e
    except Exception:  # noqa: BLE001 - a count is help, never a reason to stop the book
        log.exception("could not measure the chapter for the book budgets")
        return None


def after_chapter(svc, run: dict, outline: dict | None, chapter_id: str, number: int, rec: dict | None) -> None:
    """⚡ The run hook after a chapter is approved: the run's switch, then the counts of the chapter, and a ⚠️ note
    (codes and numbers only) when it is over a budget. Never raises."""
    try:
        pid, branch = run["project_id"], run["branch_id"]
        on = enabled(run.get("settings"))
        set_off(svc.store, pid, branch, not on)
        if not on:
            return
        e = record(svc.store, pid, branch, outline, chapter_id, number, rec)
        over = chapter_over(e) if e else []
        bs = run.setdefault("book_budgets", {"measured": 0, "over": 0})
        bs["measured"] = int(bs.get("measured") or 0) + (1 if e else 0)
        if over:
            bs["over"] = int(bs.get("over") or 0) + 1
            svc.event(run, "note", f"📊 Chapter {number} is over the book budgets: "
                      + ", ".join(f"{LABELS[o['code']]} {o['count']}{pc} (cap {o['cap']}{pc})" for o in over
                                 for pc in ["%" if o["code"] == "explain" else ""])
                      + " — the next chapters are told", code="BUDGET_OVER", chapter_id=chapter_id,
                      over=[o["code"] for o in over])
    except Exception:  # noqa: BLE001 - a count is help, never a reason to stop the book
        log.exception("book budgets after the chapter")


def _order(outline: dict | None) -> list[str]:
    from .book_path import BookPath  # noqa: PLC0415
    return [c["chapter_id"] for c in BookPath.outline_chapters(None, outline)] if outline else []


def before(store, pid: str, branch: str, outline: dict | None, chapter_id: str | None) -> list[dict]:
    """The measured chapters before ``chapter_id`` (all measured ones when None), in book order."""
    order = _order(outline)
    chs = stored(store, pid, branch)["chapters"]
    upto = order.index(chapter_id) if chapter_id in order else len(order)
    out = []
    for i, cid in enumerate(order[:upto]):
        e = chs.get(cid)
        if isinstance(e, dict):
            out.append(dict(e, number=i + 1))
    return out


# ====================================================================== 2. the writer's brief
def _ch_word(nums: list) -> str:
    nums = [n for n in nums if isinstance(n, int)]
    return ("chapter " if len(nums) == 1 else "chapters ") + ", ".join(str(n) for n in nums)


def lines_for(earlier: list[dict]) -> list[str]:
    """What is over budget in the chapters before, as plain lines for the writer."""
    out = []
    recent = earlier[-RECENT:]
    for code in ("not_but", "triad", "explain", "simile"):
        hits = [(e.get("number"), o) for e in recent for o in chapter_over(e) if o["code"] == code]
        if not hits:
            continue
        worst = max(hits, key=lambda h: h[1]["count"])
        cap = worst[1]["cap"]
        if code == "not_but":
            out.append(f"At most {cap} “not X but Y” sentence in this chapter ({_ch_word([worst[0]])} had "
                       f"{worst[1]['count']}): say what a thing is.")
        elif code == "triad":
            out.append(f"At most {cap} lists of three in the narration ({_ch_word([worst[0]])} had {worst[1]['count']}):"
                       " one precise detail or two.")
        elif code == "explain":
            out.append(f"Explaining: at most {cap}% of the narration may explain a feeling or what something meant "
                       f"({_ch_word([worst[0]])}: {worst[1]['count']}%) — show it and trust the reader.")
        else:
            out.append(f"Similes: about one per {SIMILE_WORDS} words ({_ch_word([worst[0]])} had "
                       f"{worst[1]['count']}).")
    bo = book_over(earlier)
    if bo["similes"]:
        out.append("Similes already used in several chapters — do not use them again: "
                   + ", ".join(f"“{s}” ({k} chapters)" for s, k in bo["similes"]))
    if bo["words"]:
        out.append("Words this book leans on (allowed, but at most twice in this chapter): "
                   + ", ".join(f"{w} ({k}×)" for w, k, _r in bo["words"]))
    if bo["ending"]:
        from .human_voice import CLOSE_WORDS  # noqa: PLC0415
        kind, nums = bo["ending"]
        out.append(f"{_ch_word(nums).capitalize()} both end on {CLOSE_WORDS.get(kind, kind)}: end this chapter "
                   "on a different move.")
    return out


def writer_block(store, pid: str, branch: str, outline: dict | None, chapter_id: str,
                 cut: list | None = None) -> list[str]:
    """The chapter brief's ``book_budgets`` lines (≤ ``BRIEF_MAX`` characters of JSON; [] when nothing is over
    budget or the run switched the budgets off). Never raises."""
    try:
        cur = stored(store, pid, branch)
        if cur.get("off"):
            return []
        lines = lines_for(before(store, pid, branch, outline, chapter_id))
        dropped = []
        while lines and len(json.dumps(lines, ensure_ascii=False)) > BRIEF_MAX:
            dropped.append(lines.pop())
        if dropped and cut is not None:
            from . import brief_cuts  # noqa: PLC0415
            brief_cuts.note(cut, "book budgets — the last lines", [d[:60] for d in dropped])
        return lines
    except Exception:  # noqa: BLE001
        log.exception("could not build the book budgets of the brief")
        return []


def set_off(store, pid: str, branch: str, off: bool) -> None:
    """The run's switch: an off run leaves no budget lines in the brief (and measures nothing)."""
    try:
        with _LOCK:
            cur = stored(store, pid, branch)
            if bool(cur.get("off")) != bool(off):
                cur["off"] = bool(off)
                store.set_setting(_key(pid, branch), cur)
    except Exception:  # noqa: BLE001
        log.exception("could not switch the book budgets")


# ====================================================================== 3. cut targets for the cut pass
def cut_targets(store, pid: str, branch: str, outline: dict | None, chapter_id: str, text: str) -> list[dict]:
    """The exact sentences of this (fresh) chapter that are over a budget: [{quote, code}] (≤ ``TARGETS_MAX``):
    the "not X but Y" and list-of-three sentences beyond their caps, sentences with a simile the book already used
    in several chapters, sentences that explain, when the chapter explains too much. Never raises."""
    try:
        if stored(store, pid, branch).get("off"):
            return []
        text = str(text or "")
        m = measure(text, skip_words(store, pid, branch, outline))
        over = {o["code"] for o in chapter_over(m)}
        earlier = before(store, pid, branch, outline, chapter_id)
        old_sim = {s for e in earlier for s in (e.get("simile") or {})}
        bad_sim = {s for s, _k in book_over(earlier + [m])["similes"]} | {s for s in m["simile"] if s in old_sim}
        spans = dialogue.spans(text)
        out, seen = [], set()
        counts = Counter()
        for s in _SENT.findall(text):
            q = s.strip()
            if len(q) < 20 or q in seen or text.count(q) != 1:
                continue
            i = text.find(q)
            if any(a < i + len(q) and i < b for a, b in spans):
                continue  # dialogue is never a budget target
            seen.add(q)
            low = " ".join(q.lower().split())
            code = None
            if _NOT_PAR.search(q):
                counts["not_but"] += 1
                code = "not_but" if "not_but" in over and counts["not_but"] > CAPS["not_but"] else None
            if code is None and _TRIAD.search(q):
                counts["triad"] += 1
                code = "triad" if "triad" in over and counts["triad"] > CAPS["triad"] else None
            if code is None and any(sim in low for sim in bad_sim):
                code = "simile_repeat"
            if code is None and "explain" in over and _EXPLAIN.search(q):
                code = "explain"
            if code:
                out.append({"quote": q[:400], "code": code})
            if len(out) >= TARGETS_MAX:
                break
        return out
    except Exception:  # noqa: BLE001
        log.exception("could not find the budget cut targets")
        return []


# ====================================================================== 4. the reread filter
def _strip_similes(s: str, similes: list[str]) -> tuple[str, int]:
    """``s`` with the over-used similes taken out of its narration (", like a restless ghost" → ""). Dialogue stays
    exactly as it is."""
    if not s or not similes:
        return s, 0
    spans = dialogue.spans(s)
    n = 0
    out = s
    for sim in similes:
        rx = re.compile(r",?\s*\b" + r"\s+".join(re.escape(w) for w in sim.split()) + r"\b",
                        re.I)
        while True:
            m = next((m for m in rx.finditer(out) if not any(a < m.end() and m.start() < b for a, b in spans)), None)
            if m is None:
                break
            out = out[:m.start()] + out[m.end():]
            spans = dialogue.spans(out)
            n += 1
            if n > 40:
                return out, n
    return out, n


def reread_filter(brief: dict, store, pid: str, branch: str, outline: dict | None, chapter_id: str) -> int:
    """Take the book's over-used similes out of the narration of ``previous_chapter_end`` and ``story_so_far`` in the
    brief (in place). Returns how many were taken out (0 when the budgets are off or nothing is over). Never
    raises."""
    try:
        if not brief or stored(store, pid, branch).get("off"):
            return 0
        if not (brief.get("previous_chapter_end") or brief.get("story_so_far")):
            return 0
        sims = [s for s, _k in book_over(before(store, pid, branch, outline, chapter_id))["similes"]]
        if not sims:
            return 0
        n = 0
        if isinstance(brief.get("previous_chapter_end"), str):
            brief["previous_chapter_end"], k = _strip_similes(brief["previous_chapter_end"], sims)
            n += k
        if isinstance(brief.get("story_so_far"), list):
            new = []
            for line in brief["story_so_far"]:
                t, k = _strip_similes(line, sims) if isinstance(line, str) else (line, 0)
                new.append(t)
                n += k
            brief["story_so_far"] = new
        return n
    except Exception:  # noqa: BLE001
        log.exception("could not filter what the writer rereads")
        return 0


# ====================================================================== 5. the report
def report_info(store, pid: str, branch: str) -> dict | None:
    """For the book report: {line, chapters: [{number, over: [codes]}], similes, words, over_chapters} or None
    when nothing was measured. Never raises."""
    try:
        from .needs_list import _outline_of  # noqa: PLC0415
        outline = _outline_of(store, pid, branch)
        entries = before(store, pid, branch, outline, None)
        if not entries or stored(store, pid, branch).get("off"):
            return None
        rows = [{"number": e["number"], "over": [o["code"] for o in chapter_over(e)],
                 "words": int(e.get("words") or 0)} for e in entries]
        bo = book_over(entries)
        endings = Counter(e.get("ending") for e in entries if e.get("ending"))
        n_over = sum(1 for r in rows if r["over"])
        totals = {c: sum(int(e.get(c) or 0) for e in entries) for c in ("not_but", "triad")}
        line = (f"📊 Book budgets: {len(rows) - n_over} of {len(rows)} chapter(s) within every budget"
                + (f", {n_over} over at least one" if n_over else "") + f" · “not X but Y” {totals['not_but']}× · "
                f"lists of three {totals['triad']}×"
                + (f" · {len(bo['similes'])} simile(s) reused across chapters" if bo["similes"] else "")
                + (f" · {len(bo['words'])} word(s) the book leans on" if bo["words"] else "") + ".")
        return {"line": line, "chapters": rows, "similes": [{"simile": s, "chapters": k} for s, k in bo["similes"]],
                "words": [{"word": w, "count": k, "per_1000": r} for w, k, r in bo["words"]],
                "endings": dict(endings.most_common(4)), "over_chapters": n_over}
    except Exception:  # noqa: BLE001
        log.exception("book budgets for the report")
        return None


def report_md(info: dict | None) -> list[str]:
    if not info:
        return []
    L = ["## Book budgets (no AI)", "", info["line"], ""]
    for r in info.get("chapters") or []:
        if r["over"]:
            L.append(f"- Chapter {r['number']}: over budget — " + ", ".join(LABELS.get(c, c) for c in r["over"]))
    if info.get("similes"):
        L.append("- Similes used in several chapters: " + ", ".join(f"“{x['simile']}” ({x['chapters']} chapters)"
                                                                     for x in info["similes"]))
    if info.get("words"):
        L.append("- Words the book leans on: " + ", ".join(f"{x['word']} ({x['count']}×, {x['per_1000']} per 1 000 "
                                                           "words)" for x in info["words"]))
    return L + [""]
