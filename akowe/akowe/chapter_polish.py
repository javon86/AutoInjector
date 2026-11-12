"""📏 Chapter polish: one cheap line-level polish of a chapter draft, right after it is written (run setting
``chapter_polish``, on by default).

The last books read at about grade 3 (adult books usually sit at 3-12; Akọwe's own floor for adult readers is 5) and
the same phrases came back chapter after chapter. The writer's brief asks for both (chapter_brief ``quality_lessons``)
and the final improve pass fixes them, but the improve pass keeps its changes only when the whole-book score goes
up. So each chapter is checked as soon as its draft exists, with Akọwe's own checks (no AI):

* the reading grade (readability.chapter) against the floor for the book's readers (quality_history.READING_FLOOR);
* phrases, similes and gestures this chapter repeats from the chapters before it (human_voice.repeats, the earlier
  chapters read as one block so only repeats INTO this chapter count) and plain-word tics (quality_history.word_tics).

* 📏 its length against its share of the book (book target ÷ chapters — the writer's brief asked for that ±10 %):
  more than 15 % over (length_guard.CHAPTER_OVER) and the longest narration paragraphs are flagged for cutting
  (repeated explanation, restated feelings, summary — never dialogue or a plot beat); run setting ``chapter_trim``
  (on by default) switches this off. A trim that makes the chapter at least ``TRIM_GAIN`` shorter counts as a gain.

When the chapter is under the floor, repeats at least ``MIN_REPEATS`` phrases / tics or is too long, its writer gets
ONE targeted request through the editor's rewrite path (EditorService.propose with ``craft["polish"]``): exact passages only,
the keep list, protected repeats, the voices, the protected facts and the approved canon. It may join short
sentences into longer precise ones and say repeated phrases in a new way, and nothing else. The polished text is
kept only if the same checks improved and nothing got worse (grade, repeats, tics, AI-sounding phrases) and nothing
protected changed: every line of dialogue, every name and every number stay exactly as they were, the length stays
within ``MAX_LENGTH_CHANGE``, and Akọwe's canon checks accept the saved version (else the draft comes back). Then the
chapter goes through its usual review and approval. At most one polish per chapter; an AI problem only leaves the
draft as it was (a ⚠️ note). Logs: codes and numbers only.
"""
from __future__ import annotations

import logging
import re
from collections import Counter

from . import dialogue

log = logging.getLogger("akowe.chapter_polish")

SETTING = "chapter_polish"
MIN_REPEATS = 2          # repeated phrases + plain-word tics that call for a polish
GRADE_GAIN = 0.3         # a polish for the reading level must raise the grade at least this much
MAX_FINDINGS = 8
READING_STRETCHES = 3    # stretches of short sentences sent for joining
STRETCH_MAX = 450        # characters per stretch
MAX_LENGTH_CHANGE = 0.2  # the polished chapter may shrink by at most 20 % …
MAX_GROWTH = 0.1         # … and grow by at most 10 % (📏 length_guard.MAX_GROWTH; ±20 % with the guard off)
REPEAT_KINDS = ("phrase", "gesture")
SLACK_WORDS = 25         # … though a few words more are always fine (length_guard.SLACK_WORDS)
TRIADS_PER_1000 = 3.0    # ✂ lists of three in the narration per 1 000 words that call for a polish …
MIN_TRIADS = 3           # … and at least this many
TRIAD_FINDINGS = 4       # lists of three sent for breaking up (the most crowded sentences first)
TRIAD_SETTING = "polish_triads"
TRIM_SETTING = "chapter_trim"   # 📏 a draft far over its share of the book is trimmed in the same polish (on)
TRIM_PARAGRAPHS = 3             # the longest narration paragraphs sent for cutting …
TRIM_PARA_CHARS = 1100          # … each at most this many characters (whole sentences; editor.MAX_ORIGINAL)
TRIM_GAIN = 0.03                # a trim must make the chapter at least 3 % shorter to count as a gain

POLISH_WORDS = (" This is a LINE-LEVEL POLISH of a fresh draft (context.polish_rules): change only the flagged "
                "passages. Where a passage is a string of short sentences, join some of them into longer, precise "
                "sentences (keep a few short ones for punch); where a phrase repeats an earlier chapter, say it in a "
                "fresh, specific way only this moment could have; where a sentence is flagged for a list of three, "
                "break up that list: keep the two items that matter (or one exact detail), or turn it into a longer "
                "sentence with a different rhythm; where a passage is flagged as too long for the chapter's share of the book, "
                "cut it down: drop repeated explanation, restated feelings and summary of what the reader already "
                "saw — never a line of dialogue or a plot beat. Never change what happens, any fact, name, number, line of "
                "dialogue or approved detail, and never make the chapter longer than context.word_budget allows.")
POLISH_RULES = ["Change only the flagged passages, and only their wording.",
                "Keep every line of dialogue word for word, every name, every number and every fact.",
                "Join short sentences that belong together into one longer, precise sentence; keep some short ones.",
                "Replace a phrase or simile used in an earlier chapter with a fresh, specific one.",
                "Break up a flagged list of three (“cold, wet, and tired”): two items (“cold and wet”), one exact "
                "detail (“her socks squelched”) or a longer sentence — never a list of three inside dialogue.",
                "Do not make the chapter longer: prefer cutting repeated explanation.",
                "Where a passage is flagged as too long, cut it: repeated explanation, restated feelings and summary "
                "go first; every plot beat, fact and line of dialogue stays.",
                "Never add events, people, places or details that are not already there."]

_QUOTED = dialogue.FINDER   # 💬 every dialogue style (dialogue.py)
_NUM_WORDS = ("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen "
              "seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand "
              "million first second third fourth fifth sixth seventh eighth ninth tenth").split()
_NUM = re.compile(r"\b(?:\d+(?:[.:,]\d+)*|" + "|".join(_NUM_WORDS) + r")\b", re.I)
_SENT_END = re.compile(r"[.!?][”\"’)]?\s+")


def enabled(settings: dict | None) -> bool:
    return (settings or {}).get(SETTING) is not False


# ====================================================================== the forecast
EXPECTED_SHARE = 0.25   # share of chapters expected to need a polish when the author's last book did not


def expected_share(store, who: str | None) -> float:
    """⏱ The share of chapters a polish is expected for: all of them when the author's last book read under the floor
    or repeated phrases / leaned on plain words (quality_history habit codes), else ``EXPECTED_SHARE``."""
    try:
        from . import quality_history  # noqa: PLC0415
        hist = quality_history.books(store, who or "author") if store is not None else []
    except Exception:  # noqa: BLE001
        return EXPECTED_SHARE
    habits = set((hist[-1] if hist else {}).get("habits") or [])
    if habits & {"simple", "phrase", "simile", "gesture"} or any(h.startswith("word:") for h in habits):
        return 1.0
    return EXPECTED_SHARE


# ====================================================================== the checks (no AI)
def audience(store, pid: str) -> tuple[float | None, float | None]:
    """(reading floor, top of the usual grade range) for the book's readers; (None, None) when unknown."""
    try:
        from . import quality_history, readability  # noqa: PLC0415
        from .book_path import get_profile  # noqa: PLC0415
        prof = get_profile(store, pid) or {}
        aud = readability.audience_of(prof.get("audience"), prof.get("genre"))
        return quality_history.READING_FLOOR.get(aud["key"]), aud["grade"][1]
    except Exception:  # noqa: BLE001
        log.exception("could not read the book's readers")
        return None, None


def repeats_into(text: str, earlier: list[str]) -> list[dict]:
    """The phrases, similes and gestures ``text`` repeats from the chapters before (read as one block, so repeats
    among the earlier chapters themselves never count)."""
    if not earlier or not (text or "").strip():
        return []
    from . import human_voice  # noqa: PLC0415
    rep = human_voice.repeats([("before", "\n\n".join(earlier)), ("this", text)], focus={2})
    return [f for f in rep.get("findings") or [] if f.get("kind") in REPEAT_KINDS and 2 in (f.get("chapters") or [])]


def measure(text: str, earlier: list[str]) -> dict:
    """The no-AI numbers of one chapter: {grade, words, repeats (phrases + tics), phrases, tics, ai}."""
    from . import originality, quality_history, readability  # noqa: PLC0415
    rd = readability.chapter(text or "")
    phrases = repeats_into(text, earlier)
    tics = quality_history.word_tics(text or "")
    tri = triads(text or "")
    return {"grade": rd.get("grade"), "words": rd.get("words") or 0, "plain_words": len((text or "").split()),
            "phrases": phrases, "tics": tics,
            "repeats": len(phrases) + len(tics), "tic_uses": sum(t["count"] for t in tics),
            "ai": originality.counts(text or ""), "triads": len(tri), "triad_spots": tri}


def triads(text: str) -> list[str]:
    """✂ The lists of three in the narration (dialogue never counts: dialogue.py): one entry per list, the exact
    sentence that holds it, the most crowded sentences first (the pattern of the originality / pattern check,
    prose_audit._TRIAD)."""
    from .prose_audit import _SENT, _TRIAD, paragraphs  # noqa: PLC0415
    rows: list[tuple[int, int, str]] = []
    for par in paragraphs(text or ""):
        nar = dialogue.mask(par)
        for sm in _SENT.finditer(par):
            sent = sm.group(0).strip()
            if not sent or dialogue.has_dialogue(sent):
                continue
            n = sum(1 for m in _TRIAD.finditer(nar[sm.start():sm.end()])
                    if sum(len(g.split()) for g in m.groups()) <= 9)
            rows += [(-n, len(rows), sent)] * n
    rows.sort()
    return [r[2] for r in rows]


def _too_many_triads(m: dict) -> bool:
    t = m.get("triads", 0) or 0
    return t >= MIN_TRIADS and t * 1000 / max(m.get("words") or 1, 1) > TRIADS_PER_1000


def too_long(m: dict, target: int | None) -> bool:
    """📏 Is the chapter more than length_guard.CHAPTER_OVER (15 %) over its share of the book (``target`` words)?"""
    from .length_guard import CHAPTER_OVER  # noqa: PLC0415
    return bool(target) and (m.get("plain_words") or 0) > int(target) * (1 + CHAPTER_OVER)


def needs(m: dict, floor: float | None, settings: dict | None = None, target: int | None = None) -> list[str]:
    """Why this chapter needs a polish ([] = it does not): "reading", "repeats", "triads" (✂ more lists of
    three than ``TRIADS_PER_1000`` per 1 000 words; run setting ``polish_triads``, on by default) and/or "long" (📏 more
    than 15 % over its ``target`` share of the book; run setting ``chapter_trim``, on by default)."""
    out = []
    if (settings or {}).get(TRIM_SETTING) is not False and too_long(m, target):
        out.append("long")
    if floor is not None and isinstance(m.get("grade"), (int, float)) and m["grade"] < floor:
        out.append("reading")
    if m.get("repeats", 0) >= MIN_REPEATS:
        out.append("repeats")
    if (settings or {}).get(TRIAD_SETTING) is not False and _too_many_triads(m):
        out.append("triads")
    return out


def _stretches(text: str, limit: int = READING_STRETCHES) -> list[str]:
    """Exact stretches (≤ STRETCH_MAX characters, whole sentences) of narration made of the shortest sentences."""
    from .prose_audit import paragraphs, sentences, words  # noqa: PLC0415
    rows = []
    for par in paragraphs(text):
        if _QUOTED.search(par) or "“" in par:
            continue  # dialogue stays as it is
        sents = sentences(par)
        if len(sents) < 3:
            continue
        cut = par
        if len(cut) > STRETCH_MAX:
            ends = [m.end() for m in _SENT_END.finditer(par) if m.end() <= STRETCH_MAX]
            if not ends:
                continue
            cut = par[:ends[-1]]
        cut = cut.strip()
        if cut not in text:
            continue
        lens = [len(words(s)) for s in sentences(cut)]
        if len(lens) < 3:
            continue
        rows.append((sum(lens) / len(lens), cut))
    rows.sort(key=lambda r: r[0])
    return [c for _avg, c in rows[:limit]]


def long_paragraphs(text: str, limit: int = TRIM_PARAGRAPHS) -> list[str]:
    """📏 The longest paragraphs of pure narration (no dialogue), each cut to ≤ TRIM_PARA_CHARS characters at a
    sentence end: where a too-long chapter's repeated explanation and summary usually sit."""
    from .prose_audit import paragraphs  # noqa: PLC0415
    rows = []
    for par in paragraphs(text or ""):
        if _QUOTED.search(par) or "“" in par or dialogue.has_dialogue(par):
            continue  # dialogue is never cut
        cut = par
        if len(cut) > TRIM_PARA_CHARS:
            ends = [m.end() for m in _SENT_END.finditer(par) if m.end() <= TRIM_PARA_CHARS]
            if not ends:
                continue
            cut = par[:ends[-1]]
        cut = cut.strip()
        if len(cut.split()) < 25 or cut not in text:
            continue
        rows.append((-len(cut.split()), len(rows), cut))
    rows.sort()
    return [r[2] for r in rows[:limit]]


def findings(text: str, m: dict, floor: float | None, why: list[str], target: int | None = None) -> list[dict]:
    """The polish's findings (the editor's finding shape): every passage is in the text word for word."""
    out: list[dict] = []

    def add(dim, passage, msg, sug):
        if not passage or passage not in text or any(f["passage"] == passage for f in out):
            return
        out.append({"id": f"p{len(out) + 1}", "dimension": dim, "severity": "major", "passage": passage,
                    "why": msg, "suggestion": sug})
    if "long" in why and target:  # 📏 first: the chapter is far over its share of the book
        w = m.get("plain_words") or 0
        over = max(0, w - int(target))
        for q in long_paragraphs(text):
            add("length", q, f"This chapter has {w:,} words, {round(100 * w / int(target))}% of its "
                f"{int(target):,}-word share of the book.",
                f"Cut this passage down (the chapter should lose about {over:,} words across the flagged passages): "
                "drop repeated explanation, restated feelings and summary of what the reader already saw. Keep every "
                "plot beat, fact and name.")
    for f in m.get("phrases") or []:
        for ex in f.get("examples") or []:
            if ex.get("chapter") == 2:
                add("prose_variety", str(ex.get("quote") or "").strip(),
                    f"“{f['what']}” was already used in an earlier chapter.",
                    "Say it in a fresh, specific way only this moment could have; keep what happens.")
    for t in (m.get("tics") or [])[:2]:
        rx = re.compile(rf"[^.!?\n]*\b{re.escape(t['word'])}\b[^.!?\n]*[.!?]", re.I)
        for hit in rx.findall(text)[:2]:
            q = hit.strip()
            if not _QUOTED.search(q):
                add("prose_variety", q, f"“{t['word']}” is used {t['count']}× in this chapter.",
                    "Use the precise verb or detail for this moment instead.")
    if "triads" in why:
        rate = round((m.get("triads") or 0) * 1000 / max(m.get("words") or 1, 1), 1)
        for q in list(dict.fromkeys(m.get("triad_spots") or []))[:TRIAD_FINDINGS]:
            add("prose_variety", q, f"A list of three; this chapter has {m.get('triads')} ({rate:g} per 1,000 words).",
                "Break up the list: keep two items or one exact detail, or make it one longer sentence with a "
                "different rhythm. Keep what happens and every fact.")
    if "reading" in why:
        g = m.get("grade")
        for s in _stretches(text):
            add("reading_level", s, f"Reading grade {g:g} is under {floor:g} for these readers: a string of short "
                "sentences.", "Join some of these sentences into one or two longer, precise sentences; keep the "
                "facts and the order.")
    return out[:MAX_FINDINGS]


def protected_change(old: str, new: str, names=(), growth: float | None = MAX_GROWTH,
                     shrink: float = MAX_LENGTH_CHANGE) -> str | None:
    """None when nothing protected changed; else a code: DIALOGUE (a line of dialogue changed, in any quoting style),
    NAMES (a name was lost or added), NUMBERS (a number changed) or LENGTH (the chapter grew by more than ``growth``
    — 📏 the length guard; ``None`` = the old ±``MAX_LENGTH_CHANGE`` — or shrank by more than ``shrink``, by default
    MAX_LENGTH_CHANGE; a too-long chapter may shrink down to its share, ``trim_shrink``)."""
    if not dialogue.same_dialogue(old, new):   # 💬 "…", “…”, '…', ‘…’ and dash dialogue alike
        return "DIALOGUE"
    for nm in {str(n).strip() for n in names or [] if str(n or "").strip() and len(str(n).strip()) >= 3}:
        rx = re.compile(rf"\b{re.escape(nm)}\b")
        if bool(rx.search(old)) != bool(rx.search(new)):
            return "NAMES"
    if Counter(x.lower() for x in _NUM.findall(old)) != Counter(x.lower() for x in _NUM.findall(new)):
        return "NUMBERS"
    a, b = len(old.split()), len(new.split())
    if a and (b - a) / a > MAX_LENGTH_CHANGE or a and (a - b) / a > max(shrink, MAX_LENGTH_CHANGE):
        return "LENGTH"
    if a and growth is not None and b - a > max(SLACK_WORDS, a * growth):
        return "LENGTH"
    return None


WHY = {"DIALOGUE": "a line of dialogue changed", "NAMES": "a name was lost or added",
       "NUMBERS": "a number changed", "LENGTH": "the chapter's length changed too much",
       "MORE_REPEATS": "it repeats more than before", "MORE_TICS": "it leans on plain words more than before",
       "MORE_AI": "it sounds more machine-written", "GRADE_DOWN": "it reads more simply than before",
       "MORE_TRIADS": "it has more lists of three than before",
       "TOO_HARD": "it reads harder than these readers usually expect", "NO_GAIN": "the checks did not improve",
       "KEPT": "the checks improved and nothing protected changed"}


def judge(before: dict, after: dict, floor: float | None, top: float | None = None,
          long: bool = False) -> tuple[bool, str]:
    """(keep?, code): keep only when a check improved and none got worse (📏 ``long``: a chapter far over its share
    that got at least TRIM_GAIN shorter counts as improved)."""
    gb, ga = before.get("grade"), after.get("grade")
    if after["repeats"] > before["repeats"]:
        return False, "MORE_REPEATS"
    if after.get("tic_uses", 0) > before.get("tic_uses", 0):
        return False, "MORE_TICS"
    if after.get("ai", 0) > before.get("ai", 0):
        return False, "MORE_AI"
    if after.get("triads", 0) > before.get("triads", 0) and _too_many_triads(after):
        return False, "MORE_TRIADS"
    if isinstance(gb, (int, float)) and isinstance(ga, (int, float)):
        if ga < gb - 0.1 and ((floor is None and not long) or (floor is not None and (ga < floor or gb < floor))):
            return False, "GRADE_DOWN"   # 📏 a trim may drop the grade a little, never under the readers' floor
        if top is not None and ga > top and ga > gb:
            return False, "TOO_HARD"
    better_grade = (floor is not None and isinstance(gb, (int, float)) and gb < floor
                    and isinstance(ga, (int, float)) and ga >= gb + GRADE_GAIN)
    shorter = long and (after.get("plain_words") or 0) <= (before.get("plain_words") or 0) * (1 - TRIM_GAIN)
    if not better_grade and not shorter and after["repeats"] >= before["repeats"] and after.get("tic_uses", 0) >= \
            before.get("tic_uses", 0) and after.get("triads", 0) >= before.get("triads", 0):
        return False, "NO_GAIN"
    return True, "KEPT"


def released_motifs(engine, principal, pid, branch, phrases) -> list[str]:
    """Repeat keys whose rewrite protection is lifted for a polish of ``phrases`` (the phrases the repeat check
    flagged): only repeats Akọwe ITSELF guessed to be motifs because they come back in several chapters — never one
    the author labelled, a phrase from a voice card, a line only one character says or a world detail by design.
    Never raises ([] when unsure, so everything stays protected)."""
    want = [w for w in (" ".join(str(p or "").lower().replace("’", "'").split()) for p in phrases or []) if w]
    if not want:
        return []
    try:
        from . import fact_checks as fc  # noqa: PLC0415
        chs = fc.book_texts(engine, principal, pid, branch)
        if not chs:
            return []
        _tl, reps = fc._run_all(chs, fc._context(engine.store, pid, branch))  # noqa: SLF001
    except Exception:  # noqa: BLE001
        log.exception("could not read the book's repeats")
        return []
    out = []
    for r in reps.get("repeats") or []:
        if r.get("class") != "motif" or r.get("source") != "auto" or \
                not str(r.get("why") or "").startswith("comes back in"):
            continue
        k = str(r.get("key") or "")
        if k and any(k in w or w in k for w in want):
            out.append(k)
    return out


def _nums(m: dict) -> dict:
    return {"grade": m.get("grade"), "repeats": m.get("repeats"), "phrases": len(m.get("phrases") or []),
            "tics": len(m.get("tics") or []), "words": m.get("words"), "triads": m.get("triads", 0),
            "plain_words": m.get("plain_words")}


def trim_shrink(words: int, target: int | None) -> float:
    """📏 How much a too-long chapter may shrink in its polish: down to the bottom of its range (90 % of its share),
    never less than the usual MAX_LENGTH_CHANGE."""
    from .lengths import TARGET_BAND  # noqa: PLC0415
    if not target or not words:
        return MAX_LENGTH_CHANGE
    return max(MAX_LENGTH_CHANGE, 1 - int(target) * (1 - TARGET_BAND) / words)


def chapter_target(store, pid: str, outline: dict | None) -> int | None:
    """📏 The chapter's share of the book in words (book target ÷ chapters), as its writer was told; None in the
    self-tests or when unknown."""
    try:
        from .chapter_brief import _length  # noqa: PLC0415 - the same numbers the writer's brief gives
        plan = _length(store, pid, outline or {})
        return int(plan["target_words"]) if plan else None
    except Exception:  # noqa: BLE001
        return None


# ====================================================================== the run hook
def after_draft(runner, run: dict, st: dict, outline: dict, cid: str, number: int, rid: str,
                item: dict | None = None) -> dict | None:
    """📏 Check the fresh draft of chapter ``cid`` and polish it once when it needs it. Returns the chapter's polish
    row (stored in ``run["polish"]["chapters"][cid]``) or None (off, done before, not the AI's text). Raises only the
    run's pause / cancel."""
    if not enabled(run.get("settings")):
        return None
    mem = run.setdefault("polish", {"chapters": {}})
    if cid in mem["chapters"]:
        return None  # at most one polish per chapter (also after a pause or a redo)
    from .assist import Cancelled  # noqa: PLC0415
    from .autobook import RunCancelled, RunPaused  # noqa: PLC0415
    try:
        return _after_draft(runner, run, st, mem, outline, cid, number, rid, item)
    except (RunPaused, RunCancelled, Cancelled):
        raise
    except Exception as exc:  # noqa: BLE001 - a polish is help, never a reason to stop the book
        if getattr(exc, "control", False):
            raise
        code = getattr(exc, "code", None) or type(exc).__name__
        log.warning("chapter polish of run %s stopped: %s", run.get("id"), code)
        row = mem["chapters"].setdefault(cid, {"number": number})
        row.update(state="failed", kept=False, code=code)
        runner.event(run, "note", f"⚠️ Chapter {number}: the polish could not finish ({code}); the draft stays as "
                     "it was", step="chapters", code="CHAPTER_POLISH_FAILED", chapter_id=cid)
        runner.save(run)
        return row


def _after_draft(runner, run, st, mem, outline, cid, number, rid, item):
    from . import ai_activity, human_voice  # noqa: PLC0415
    from .editor import apply_replacements  # noqa: PLC0415
    from .errors import AkoweError  # noqa: PLC0415
    app = runner.app
    pid, branch = run["project_id"], run["branch_id"]
    bp = runner.bp(run)
    head = bp.rec(rid)
    if head is None or head.get("module_id") != "C02" or not runner._ai_made(run, head):  # noqa: SLF001
        return None  # never the author's own text
    text = str((head.get("data") or {}).get("text") or "")
    earlier = [c["text"] for c in human_voice.earlier_chapters(app.store, pid, branch, outline, cid)]
    floor, top = audience(app.store, pid)
    before = measure(text, earlier)
    target = chapter_target(app.store, pid, outline)
    why = needs(before, floor, run.get("settings"), target)
    row = {"number": number, "before": _nums(before), "floor": floor, "why": why, "target": target}
    mem["chapters"][cid] = row
    if not why:
        row.update(state="not_needed", kept=False)
        runner.save(run)
        return row
    fs = findings(text, before, floor, why, target)
    if not fs:
        row.update(state="nothing_to_point_at", kept=False)
        runner.save(run)
        return row
    row.update(state="asking", findings=len(fs))
    runner.save(run)
    ed = runner._review.editor  # noqa: SLF001
    craft = {"findings": fs, "keep": [], "slot": None, "version": head["version"], "polish": True,
             "except_keys": released_motifs(app.engine, run["principal"], pid, branch,
                                            [f["what"] for f in before["phrases"]])}
    try:
        with ai_activity.doing(f"Polishing chapter {number}'s sentences", done=f"Polished chapter {number}'s "
                               "sentences", chapter=number):
            prop = ed.propose(runner._sub_job(run, "polish", rid, run["settings"].get("slot_id")), rid,  # noqa: SLF001
                              craft=craft)
    except AkoweError as exc:
        if getattr(exc, "control", False):
            raise
        row.update(state="failed", kept=False, code=exc.code)
        runner.event(run, "note", f"⚠️ Chapter {number}: the polish could not be asked for ({exc.code}); the draft "
                     "stays as it was", step="chapters", code="CHAPTER_POLISH_FAILED", chapter_id=cid)
        runner.save(run)
        return row
    ok = [i for i in prop.get("items") or [] if i.get("ok")]
    res = apply_replacements(text, [{k: i[k] for k in ("finding_id", "original", "replacement")} for i in ok], fs,
                             list(prop.get("keep") or [])) if ok else {"applied": [], "text": text}
    if not res["applied"]:
        return _not_kept(runner, run, row, cid, number, "UNRESOLVED", "the writer's changes did not match the text "
                         "word for word")
    new = res["text"]
    try:
        names = ed.names(pid, branch)
    except Exception:  # noqa: BLE001
        names = []
    from . import length_guard  # noqa: PLC0415 - 📏 a polish may not make the chapter much longer
    bad = protected_change(text, new, names, MAX_GROWTH if length_guard.enabled(run.get("settings")) else None,
                           trim_shrink(before.get("plain_words") or 0, target) if "long" in why else MAX_LENGTH_CHANGE)
    after = measure(new, earlier)
    row["after"] = _nums(after)
    if bad:
        return _not_kept(runner, run, row, cid, number, bad, WHY[bad])
    keep, code = judge(before, after, floor, top, long="long" in why)
    if not keep:
        return _not_kept(runner, run, row, cid, number, code, WHY[code])
    accept = [a["finding_id"] for a in res["applied"]]
    try:
        out = ed.apply(run["principal"], pid, branch, rid, head["version"], accept, proposal=prop, how="run")
    except AkoweError as exc:
        return _not_kept(runner, run, row, cid, number, exc.code, "Akọwe's checks refused the polished text")
    runner._made(run, out["ref"])  # noqa: SLF001
    # the saved version must pass Akọwe's checks like the draft did; else the draft comes back
    if not _validates(runner, run, rid):
        try:
            back = ed.restore(run["principal"], pid, branch, rid, head, "POLISH_CHECKS")
            runner._made(run, back)  # noqa: SLF001
        except AkoweError:
            log.warning("chapter polish: the draft could not be put back for run %s", run.get("id"))
        return _not_kept(runner, run, row, cid, number, "CHECKS_REFUSED", "Akọwe's checks refused the polished text")
    row.update(state="kept", kept=True, changed=len(res["applied"]), version=out["version"])
    msg = f"📏 Chapter {number} polished: " + _change_words(row) + " (kept)"
    runner.event(run, "note", msg, step="chapters", code="CHAPTER_POLISH_KEPT", chapter_id=cid, record_id=rid)
    if item is not None:
        item["polish"] = {"kept": True, "before": row["before"]["grade"], "after": row["after"]["grade"]}
    runner.save(run)
    return row


def _validates(runner, run, rid) -> bool:
    try:
        from .requests import candidate_payload  # noqa: PLC0415
        bp = runner.bp(run)
        h = bp.rec(rid)
        v = bp.dispatch(h["module_id"], "VALIDATE", base_ref=h["ref"], payload=candidate_payload(h["ref"], None))
        return v.get("status") in ("VALIDATED", "APPROVED")
    except Exception:  # noqa: BLE001 - when in doubt, the draft comes back
        log.exception("chapter polish: could not validate the polished text")
        return False


def _change_words(row: dict) -> str:
    b, a = row.get("before") or {}, row.get("after") or {}
    parts = []
    if b.get("grade") is not None and a.get("grade") is not None:
        parts.append(f"reading level {b['grade']:g} → {a['grade']:g}")
    if b.get("repeats") or a.get("repeats"):
        parts.append(f"repeats from earlier chapters {b.get('repeats') or 0} → {a.get('repeats') or 0}")
    if b.get("triads") and b.get("triads") != a.get("triads"):
        parts.append(f"lists of three {b.get('triads')} → {a.get('triads') or 0}")
    if "long" in (row.get("why") or []) and b.get("plain_words") and a.get("plain_words"):
        parts.append(f"length {b['plain_words']:,} → {a['plain_words']:,} words (share {row.get('target') or 0:,})")
    return ", ".join(parts) or "nothing measurable"


def _not_kept(runner, run, row, cid, number, code, why):
    row.update(state="not_kept", kept=False, code=code, reason=why)
    runner.event(run, "note", f"📏 Chapter {number}: the polish was not kept ({why}); the draft stays as it was",
                 step="chapters", code="CHAPTER_POLISH_NOT_KEPT", chapter_id=cid)
    runner.save(run)
    return row


# ====================================================================== the run's line
def line(run: dict) -> str | None:
    """The run's line, e.g. "📏 Reading level 2.9 → 5.4 after polish in chapters 1, 3 · repeats … 5 → 1" (the kept
    chapters, word-weighted), or what happened when none was kept; None when no chapter needed a polish."""
    rows = sorted(((run.get("polish") or {}).get("chapters") or {}).values(), key=lambda r: r.get("number") or 0)
    tried = [r for r in rows if r.get("state") in ("kept", "not_kept", "failed")]
    if not tried:
        return None
    kept = [r for r in tried if r.get("kept")]
    if not kept:
        return ("📏 Chapter polish tried in chapter(s) " + ", ".join(str(r["number"]) for r in tried)
                + ": not kept, the drafts stayed as they were")

    def avg(which):
        pts = [((r.get(which) or {}).get("grade"), (r.get("before") or {}).get("words") or 1) for r in kept]
        pts = [(g, w) for g, w in pts if isinstance(g, (int, float))]
        return round(sum(g * w for g, w in pts) / sum(w for _g, w in pts), 1) if pts else None
    b, a = avg("before"), avg("after")
    nums = ", ".join(str(r["number"]) for r in kept)
    out = f"📏 Reading level {b:g} → {a:g} after polish in chapter{'s' if len(kept) > 1 else ''} {nums}" if \
        b is not None and a is not None else f"📏 Polished chapter(s) {nums}"
    rb = sum((r.get("before") or {}).get("repeats") or 0 for r in kept)
    ra = sum((r.get("after") or {}).get("repeats") or 0 for r in kept)
    if rb or ra:
        out += f" · repeats from earlier chapters {rb} → {ra}"
    if len(tried) > len(kept):
        out += f" · not kept in {len(tried) - len(kept)} chapter(s)"
    return out


def to_report(runner, run: dict, rep: dict | None = None) -> str | None:
    """Put the run's polish line in the run window's report box and (when given) the saved book report."""
    ln = line(run)
    if not ln:
        return None
    run.setdefault("report", {})["polish"] = ln
    if rep is not None:
        try:
            rep["polish"] = ln
            rp = getattr(runner.app, "reports", None)
            if rp:
                rp._save(run["project_id"], run["branch_id"], rep)  # noqa: SLF001
        except Exception:  # noqa: BLE001 - a line in the report never breaks the run
            log.exception("could not add the polish line to the report")
    return ln
