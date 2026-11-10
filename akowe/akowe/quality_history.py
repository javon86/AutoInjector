"""📈 Quality history and 🧠 lessons that carry forward (no AI).

**History.** Every finished book's report numbers are kept per author on the shelf (setting
``quality_history:<author>``; numbers and fixed codes only — never a title, a quote or the book's words): the overall
score, the whole-book median per dimension, the editor's average per category, the "sounds like a person" score,
the reading grade, the beta readers' average, the habit codes Akọwe counted (``triad``, ``word:went``, ``simile``,
``clock`` …) and the final improve pass (before → after, kept or not). ``trend`` turns it into plain words for Book
home and the report: "7.6/10 — down 0.4 from your last book", "Rule rigor is your weakest area for 3 books",
"Falling: Peril and uncertainty, Plot continuity".

**Lessons.** ``lessons`` reads the last books (and the newest report) and makes a short list of what keeps going
wrong — the author's recurring weak whole-book dimensions and editor categories and the recurring habits — each as
one instruction ("Every special rule needs scope, cost and limits", "Check all clock, tide and date arithmetic").
A ⚡ run copies them onto the new book at its start (``carry``: setting ``quality_lessons:<book>``); the planners
(premise, main plot, outline: ``planner_block``) and every chapter's writer (``brief_block``) get them. The chapter
block adds what THIS book's earlier chapters already show: the editor categories that scored low, an avoid-list of
the similes, phrases and plain-word tics already used (so chapter 2 does not reuse chapter 1's "like a hook"), the
tide and day facts stated so far and any clock contradiction, and the reading-level floor for the book's readers.
Each block has a hard size (``PLAN_BUDGET`` / ``BRIEF_BUDGET``); what does not fit is said in the ⚠️ "what was cut"
list (brief_cuts.py).
"""
from __future__ import annotations

import json
import logging
import re
import statistics
import threading
from collections import Counter
from datetime import datetime, timezone

log = logging.getLogger("akowe.quality_history")

KEY = "quality_history:{who}"
BOOK_KEY = "quality_lessons:{pid}"
MAX_BOOKS = 30
MAX_LESSONS = 6
LOOKBACK = 3            # lessons read the last 3 books
WEAK_DIM = 6.5          # a whole-book median at or below this is weak
WEAK_EDITOR = 6.5       # an editor category average below this is weak
FALL = 0.5              # a drop of this much (or more) between books is "falling"
BRIEF_BUDGET = 1400     # characters of JSON for the chapter brief's quality_lessons block
PLAN_BUDGET = 900       # characters of JSON for the planners' lessons
_LOCK = threading.RLock()

# whole-book dimensions (book_report.DIMENSIONS) -> the lesson the planner and the writer get
DIM_LESSONS = {
    "atmosphere": "Anchor every scene in one concrete sensory detail of this place before anything happens.",
    "premise": "Make the premise sharp: what does the main character risk that nobody else would?",
    "plot_continuity": "Every chapter opens from the last chapter's consequence; never drop a thread or a hazard.",
    "structure": "Give the book a clear turn at the middle and let the ending answer an image from the start.",
    "prose_clarity": "One action or observation per sentence in tense scenes; no stacked clauses.",
    "world_distinctiveness": "Let the world's work, money and institutions cause the obstacles.",
    "character_differentiation": "Every character talks and acts their own way (voice cards); no shared register.",
    "psychological_complexity": "Give each main character a contradiction: a false belief, a secret, a mixed motive "
                                "that drives their choices.",
    "realism": "Show work through real procedure and tools, in the right order.",
    "rule_rigor": "Every special rule (ghost, magic, curse, device) needs scope, cost and limits — stated early and "
                  "never broken.",
    "peril_uncertainty": "Keep something really at risk: let helpers refuse or lie, and let one obstacle cost "
                         "something permanent.",
    "subtext": "Never let characters announce their feelings; show them in what they do or avoid.",
    "ending": "Let the ending cost something and leave one question open.",
}
# editor categories (editor_rubric.DIMENSIONS) -> lesson
EDITOR_LESSONS = {
    "timeline": "Check all clock, tide and date arithmetic before writing a time on the page.",
    "prose_variety": "Vary sentences and gestures; no repeated phrases, similes or lists of three.",
    "trade_terms": "Use the right trade and period terms; never invent how a tool works.",
    "cause_effect": "Every event needs a cause on the page and the consequences it should have.",
    "subtext": "Leave the important things unsaid; show feelings through action.",
    "character_agency": "Every character pushes for their own goal, even against the main character.",
    "voice_distinction": "With the names hidden, a reader must still know who speaks.",
    "world_friction": "Let the world get in the way, and make progress cost something.",
    "theme_restraint": "Carry the theme with events and images, never state it.",
    "tension_stakes": "Keep the danger real; no reassurance that removes it.",
    "ending_openness": "Earn the ending; do not tie every thread too neatly.",
    "protected_mysteries": "Keep the protected mysteries unexplained until the plan says so.",
    "story_rules": "Use every story rule inside its scope and limits.",
    "scene_plan": "Deliver every planned scene's goal, obstacle and change.",
}
# habit codes (Akọwe's own counts) -> lesson
HABIT_LESSONS = {
    "triad": "Avoid lists of three; one precise detail or two.",
    "gesture": "Do not repeat a gesture (the same jaw, breath or stillness) across chapters.",
    "simile": "Never reuse a simile or an image from an earlier chapter.",
    "phrase": "Never reuse a distinctive phrase from an earlier chapter.",
    "not_parallel": "Avoid “Not X. Not Y.” patterns.",
    "moral_ending": "End paragraphs on an image or an action, not a moral.",
    "named_emotion": "Do not let dialogue name feelings outright.",
    "uniform_length": "Mix short and long sentences.",
    "same_opening": "Start sentences and chapters in different ways.",
    "clock": "Check all clock, tide and date arithmetic before writing a time on the page.",
    "simple": "Do not write too simply for adult readers: mix in longer, more complex sentences and precise words.",
    "guessed": "Hide the twist: plant clues fairly, add a believable second explanation, and never point at the answer "
               "in the first chapter.",
    "confused": "Open every scene with who is there, where we are and when.",
    "bored": "Give every chapter a new problem, a cost or a turn.",
}
# plain words that become tics when the writer leans on them (per 1 000 words, and at least MIN_TIC uses)
TIC_WORDS = {"went": 3.0, "looked": 3.5, "turned": 3.0, "felt": 3.0, "just": 3.5, "began": 2.0, "started": 2.0,
             "seemed": 2.5, "really": 2.0, "suddenly": 1.0, "slowly": 2.0, "nodded": 2.0, "smiled": 2.0,
             "sighed": 1.5, "shrugged": 1.5, "glanced": 2.0, "stared": 2.0, "something": 3.0, "almost": 2.5}
MIN_TIC = 6
READING_FLOOR = {"adult": 5.0, "young_adult": 4.0, "middle_grade": 3.0, "children": None}
_WORD = re.compile(r"[A-Za-z’']+")
_QUOTED = re.compile(r"“[^”]*”|\"[^\"\n]*\"")


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _num(v):
    return round(float(v), 1) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


# ====================================================================== the snapshot of one finished book
def word_tics(text: str) -> list[dict]:
    """Plain words leaned on too often (narration and dialogue): [{word, count, per_1000}] worst first."""
    words = [w.lower().replace("’", "'") for w in _WORD.findall(text or "")]
    n = len(words)
    if n < 300:
        return []
    c = Counter(words)
    out = []
    for w, thr in TIC_WORDS.items():
        k = c.get(w, 0)
        rate = 1000 * k / n
        if k >= MIN_TIC and rate >= thr:
            out.append({"word": w, "count": k, "per_1000": round(rate, 1)})
    out.sort(key=lambda x: -x["per_1000"] / TIC_WORDS[x["word"]])
    return out


def habit_codes(rep: dict, texts: list[str] | None = None) -> list[str]:
    """Fixed habit codes of a report (never book words): prose-audit checks, repeat kinds, plain-word tics, clock
    problems, a too-simple reading level and the beta readers' strong signals."""
    codes = []
    for f in (rep.get("patterns") or {}).get("findings") or []:
        if f.get("severity") in ("major", "minor") and f.get("check") in HABIT_LESSONS:
            codes.append(f["check"])
    for f in (rep.get("originality") or {}).get("repeats") or []:
        kind = f.get("kind")
        if kind == "phrase" and "simile" in str(f.get("label") or "").lower():
            codes.append("simile")
        elif kind in ("phrase", "gesture"):
            codes.append(kind)
    if texts:
        codes += [f"word:{t['word']}" for t in word_tics("\n".join(texts))[:4]]
        from . import clock_check  # noqa: PLC0415
        if clock_check.check_book([(str(i), t) for i, t in enumerate(texts)])["findings"]:
            codes.append("clock")
    rd = rep.get("readability") or {}
    floor = READING_FLOOR.get(((rd.get("audience") or {}).get("key")) or "adult")
    grade = (rd.get("totals") or {}).get("grade")
    if floor is not None and isinstance(grade, (int, float)) and grade < floor:
        codes.append("simple")
    for k in (rep.get("beta_signals") or []):
        if k in HABIT_LESSONS:
            codes.append(k)
    return sorted(set(codes))


def snapshot(rep: dict, *, book: str | None = None, run_id: str | None = None, texts: list[str] | None = None,
             beta: dict | None = None, improve: dict | None = None) -> dict:
    """The numbers of one finished book's report (no words of the book)."""
    agg = rep.get("aggregate") or {}
    dims = {d["dimension"]: _num(d.get("median")) for d in agg.get("dimensions") or [] if d.get("n")}
    ed = {d["dimension"]: _num(d.get("average")) for d in (rep.get("editor") or {}).get("dimensions") or []}
    og = rep.get("originality") or {}
    person = (og.get("person") or {}).get("score") if isinstance(og.get("person"), dict) else None
    rd = rep.get("readability") or {}
    signals = []
    for f in (beta or {}).get("fixes") or []:
        if f.get("strong") and f.get("kind") in HABIT_LESSONS:
            signals.append(f["kind"])
    if signals:
        rep = dict(rep, beta_signals=signals)
    out = {"at": _now(), "book": str(book or "")[:60], "run": str(run_id or "")[:40] or None,
           "overall": _num(agg.get("overall")), "reviewers": int(agg.get("reviewers") or 0), "dims": dims,
           "editor": {k: v for k, v in ed.items() if v is not None}, "person": _num(person),
           "grade": _num((rd.get("totals") or {}).get("grade")),
           "audience": ((rd.get("audience") or {}).get("key")) or None,
           "beta": _num((beta or {}).get("average")), "habits": habit_codes(rep, texts)}
    if improve:
        out["improve"] = {k: improve.get(k) for k in ("before", "after", "kept", "rounds") if k in improve}
    return out


# ====================================================================== storage (per author, shelf-level)
def _key(who: str) -> str:
    return KEY.format(who=who or "author")


def books(store, who: str) -> list[dict]:
    try:
        return list((store.get_setting(_key(who)) or {}).get("books") or [])
    except Exception:  # noqa: BLE001
        log.exception("could not read the quality history")
        return []


def record(store, who: str, entry: dict) -> dict:
    """Add (or replace: the same book again) one book's snapshot; the newest ``MAX_BOOKS`` are kept."""
    with _LOCK:
        cur = store.get_setting(_key(who)) or {}
        rows = [r for r in cur.get("books") or [] if not (entry.get("book") and r.get("book") == entry["book"])]
        rows.append(entry)
        store.set_setting(_key(who), {"version": int(cur.get("version") or 0) + 1, "books": rows[-MAX_BOOKS:]})
    try:
        with store.transaction() as tx:
            tx.insert_outbox(entry.get("book") or "", "main", "quality.history", {
                "overall": entry.get("overall"), "books": len(rows[-MAX_BOOKS:]),
                "habits": len(entry.get("habits") or [])})
    except Exception:  # noqa: BLE001 - an activity line never breaks the history
        log.debug("could not log the quality history")
    return entry


# ====================================================================== the trend in plain words
def _labels() -> dict:
    from .book_report import LABELS  # noqa: PLC0415
    return LABELS


def trend(store, who: str, *, book: str | None = None, current: dict | None = None) -> dict | None:
    """{line, text, weakest, falling, rising, points, books} for the newest book (or ``book``; or ``current``, a
    snapshot not recorded yet — it replaces the same book's entry) against the one before."""
    rows = [r for r in books(store, who) if r.get("overall") is not None]
    if current is not None:
        if current.get("overall") is None:
            return None
        rows = [r for r in rows if not (current.get("book") and r.get("book") == current["book"])] + [current]
        book = None
    if not rows:
        return None
    idx = next((i for i in range(len(rows) - 1, -1, -1) if book and rows[i].get("book") == book), len(rows) - 1)
    cur, before = rows[idx], rows[:idx]
    labels = _labels()
    prev = before[-1] if before else None
    if prev is None:
        line = f"{cur['overall']:g}/10 — your first book with a score; the next books are compared with it."
    else:
        d = round(cur["overall"] - prev["overall"], 1)
        line = (f"{cur['overall']:g}/10 — " + (f"up {d:g} from your last book" if d > 0 else
                                               f"down {abs(d):g} from your last book" if d < 0 else
                                               "the same as your last book") + f" ({prev['overall']:g})")
    recent = before[-(LOOKBACK - 1):] + [cur]
    weakest = None
    if cur.get("dims"):
        low = min(cur["dims"], key=lambda k: (cur["dims"][k], k))
        streak = 0
        for r in reversed(recent):
            ds = r.get("dims") or {}
            if low in ds and ds[low] <= min(ds.values()) + 0.5:
                streak += 1
            else:
                break
        weakest = {"dimension": low, "label": labels.get(low, low), "median": cur["dims"][low], "books": streak,
                   "line": (f"{labels.get(low, low)} is your weakest area for {streak} books" if streak >= 2 else
                            f"{labels.get(low, low)} is your weakest area in this book")
                   + f" ({cur['dims'][low]:g}/10)."}
    falling, rising = [], []
    if prev:
        for k, v in (cur.get("dims") or {}).items():
            pv = (prev.get("dims") or {}).get(k)
            if pv is None or v is None:
                continue
            if v <= pv - FALL:
                falling.append({"dimension": k, "label": labels.get(k, k), "from": pv, "to": v})
            elif v >= pv + FALL:
                rising.append({"dimension": k, "label": labels.get(k, k), "from": pv, "to": v})
    falling.sort(key=lambda x: x["to"] - x["from"])
    rising.sort(key=lambda x: x["from"] - x["to"])
    out = {"line": line, "overall": cur["overall"], "previous": prev["overall"] if prev else None,
           "change": round(cur["overall"] - prev["overall"], 1) if prev else None, "weakest": weakest,
           "falling": falling[:5], "rising": rising[:5], "books": len(rows),
           "points": [{"at": r.get("at"), "overall": r.get("overall")} for r in rows[-10:]]}
    if cur.get("improve"):
        out["improve"] = cur["improve"]
    parts = [line]
    if weakest:
        parts.append(weakest["line"])
    if falling:
        parts.append("Falling: " + ", ".join(f"{f['label']} {f['from']:g}→{f['to']:g}" for f in falling[:3]) + ".")
    out["text"] = " ".join(parts)
    return out


# ====================================================================== lessons for the next book
def lessons(store, who: str, *, limit: int = MAX_LESSONS) -> list[dict]:
    """[{code, text, books}] — what kept going wrong in the author's last books, most frequent first."""
    rows = books(store, who)[-LOOKBACK:]
    if not rows:
        return []
    score: Counter = Counter()
    text: dict[str, str] = {}
    for r in rows:
        for k, v in (r.get("dims") or {}).items():
            if v is not None and v <= WEAK_DIM and k in DIM_LESSONS:
                score[f"dim:{k}"] += 2 if v <= 5.5 else 1
                text[f"dim:{k}"] = DIM_LESSONS[k]
        for k, v in (r.get("editor") or {}).items():
            if v is not None and v < WEAK_EDITOR and k in EDITOR_LESSONS:
                score[f"ed:{k}"] += 2 if v <= 5.5 else 1
                text[f"ed:{k}"] = EDITOR_LESSONS[k]
        for c in r.get("habits") or []:
            if c.startswith("word:"):
                score["words"] += 1
                text["words"] = None  # filled below with the words
            elif c in HABIT_LESSONS:
                score[f"habit:{c}"] += 1
                text[f"habit:{c}"] = HABIT_LESSONS[c]
    newest = rows[-1]
    words = [c.split(":", 1)[1] for c in newest.get("habits") or [] if c.startswith("word:")]
    if words:
        text["words"] = "Lean less on plain words you overused last time: " + ", ".join(f"“{w}”" for w in words[:5]) \
                        + "."
    out, seen = [], set()
    for code, n in sorted(score.items(), key=lambda kv: (-kv[1], kv[0])):
        t = text.get(code)
        if not t or t in seen:
            continue
        seen.add(t)
        out.append({"code": code, "text": t, "books": sum(1 for r in rows if _has(r, code))})
        if len(out) >= limit:
            break
    return out


def _has(r: dict, code: str) -> bool:
    kind, _, k = code.partition(":")
    if kind == "dim":
        v = (r.get("dims") or {}).get(k)
        return v is not None and v <= WEAK_DIM
    if kind == "ed":
        v = (r.get("editor") or {}).get(k)
        return v is not None and v < WEAK_EDITOR
    if kind == "habit":
        return k in (r.get("habits") or [])
    if code == "words":
        return any(c.startswith("word:") for c in r.get("habits") or [])
    return False


def carry(store, who: str, pid: str) -> list[dict]:
    """A ⚡ run's start: the author's lessons so far are copied onto the new book (its planners and writer read them
    there). Never raises."""
    try:
        ls = lessons(store, who)
        store.set_setting(BOOK_KEY.format(pid=pid), {"lessons": ls, "at": _now()})
        return ls
    except Exception:  # noqa: BLE001
        log.exception("could not carry the lessons forward")
        return []


def of_book(store, pid: str) -> list[dict]:
    try:
        return list((store.get_setting(BOOK_KEY.format(pid=pid)) or {}).get("lessons") or [])
    except Exception:  # noqa: BLE001
        return []


PLAN_RULE = ("Lessons from the author's last books (context.lessons): plan so these do not happen again — every "
             "special rule gets scope, cost and limits in the plan; every clock, tide and date in the plan adds up.")
BRIEF_RULE = ("Lessons (context.writing_brief.quality_lessons): from_your_last_books and this_book_so_far are what "
              "readers and editors marked down before — do better on each; never reuse anything in avoid; keep every "
              "time and tide consistent with clock; must_fix are contradictions in the chapters before that this "
              "chapter must not repeat or build on; reading_level is the floor and the target for this book's readers "
              "— follow its mix of sentence lengths.")


def _bounded(block: dict, budget: int, order: tuple, cut: list | None, what: str) -> dict:
    size = lambda: len(json.dumps(block, ensure_ascii=False))  # noqa: E731
    dropped = []
    while size() > budget:
        key = next((k for k in order if isinstance(block.get(k), list) and block[k]), None)
        if key is None:
            key = next((k for k in order if k in block), None)
            if key is None:
                break
            dropped.append(str(block.pop(key))[:80])
            continue
        dropped.append(block[key].pop())
        if not block[key]:
            block.pop(key)
    if cut is not None and dropped:
        from . import brief_cuts  # noqa: PLC0415
        brief_cuts.note(cut, what, dropped)
    return block


def planner_block(store, pid: str, budget: int = PLAN_BUDGET) -> list[str]:
    """The lessons for the premise / main plot / outline prompt (≤ ``budget`` characters of JSON)."""
    items = [x["text"] for x in of_book(store, pid)]
    while items and len(json.dumps(items, ensure_ascii=False)) > budget:
        items.pop()
    return items


# ====================================================================== the chapter's block
def avoid_list(earlier: list[dict], limit: int = 8) -> list[str]:
    """What the chapters before already used and this one must not reuse: similes, distinctive phrases used twice or
    more (also inside one chapter) and plain-word tics. [] when nothing stands out."""
    if not earlier:
        return []
    from . import human_voice  # noqa: PLC0415
    out = []
    texts = [c["text"] for c in earlier]
    rep = human_voice.repeats(earlier)
    for f in rep.get("findings") or []:
        if f["kind"] == "phrase":
            out.append(f"“{f['what']}”")
    # similes and 5-word phrases of the chapters before, counted together (one chapter is enough)
    narr = _QUOTED.sub(" ", "\n".join(texts)).lower().replace("’", "'")
    from . import prose_audit  # noqa: PLC0415
    sims: Counter = Counter()
    for m in re.finditer(r"\blike (?:a|an|the) ([a-z'-]{3,})(?: ([a-z'-]{3,}))?", narr):
        two = m.group(2) and m.group(2) not in prose_audit.STOP and not m.group(2).endswith("ing")
        sims[m.group(0) if two else m.group(0)[: m.end(1) - m.start()]] += 1
    for s, _k in sims.most_common(4):
        if not any(s in x for x in out):
            out.append(f"“{s}”")
    toks = re.findall(r"[a-z']+", narr)
    grams = Counter(tuple(toks[i:i + 4]) for i in range(len(toks) - 3))
    kept: list[tuple] = []
    for g, k in sorted(grams.items(), key=lambda kv: -kv[1])[:400]:
        if k < 2 or sum(1 for t in g if t not in prose_audit.STOP and len(t) > 2) < 2:
            continue
        if any(len(set(g) & set(x)) >= 2 for x in kept):
            continue  # one line per repeated stretch, not every window of it
        kept.append(g)
        p = " ".join(g)
        if not any(p in x or x.strip("“”") in p for x in out):
            out.append(f"“{p}”")
        if len(out) >= limit:
            break
    tics = word_tics("\n".join(texts))
    if tics:
        out.append("overused words: " + ", ".join(f"{t['word']} ({t['count']}×)" for t in tics[:4]))
    return out[:limit + 1]


def _editor_lows(store, pid: str, branch: str, earlier: list[dict]) -> list[str]:
    """The editor categories that scored low in the chapters before (their approved versions)."""
    try:
        crafts = store.get_setting(f"craft_reviews:{pid}:{branch}") or {}
    except Exception:  # noqa: BLE001
        return []
    sums: dict[str, list] = {}
    for c in earlier:
        cr = crafts.get(c.get("key") or "")
        for d, v in ((cr or {}).get("scores") or {}).items():
            if isinstance(v, (int, float)):
                sums.setdefault(d, []).append(v)
    lows = sorted(((statistics.fmean(v), d) for d, v in sums.items() if v and statistics.fmean(v) < WEAK_EDITOR))
    return [EDITOR_LESSONS[d] for _a, d in lows if d in EDITOR_LESSONS][:3]


def reading_floor(store, pid: str) -> str | None:
    try:
        from . import readability  # noqa: PLC0415
        from .book_path import get_profile  # noqa: PLC0415
        prof = get_profile(store, pid) or {}
        aud = readability.audience_of(prof.get("audience"), prof.get("genre"))
        floor = READING_FLOOR.get(aud["key"])
    except Exception:  # noqa: BLE001
        return None
    if floor is None:
        return None
    # concrete (📏): a target grade, the mix of sentence lengths and one joined sentence as an example
    mx = int(aud.get("sentence_max") or 24)
    return (f"{aud['label']} readers: aim for a reading grade of at least {floor:g} (about {floor + 1:g}–"
            f"{floor + 3:g} is right). Mix sentence lengths: a few short ones for punch, most of 10–{mx - 4} words, "
            f"and a longer, precise sentence ({mx + 1}+ words) in most paragraphs. Join short sentences that belong "
            "together: not “He stopped. He listened. The mill was quiet.” but “He stopped at the mill door and "
            "listened, but the wheel had gone quiet.” Never write like a children's book.")


def brief_block(store, pid: str, branch: str, outline: dict | None, chapter_id: str, cut: list | None = None,
                budget: int = BRIEF_BUDGET) -> dict | None:
    """The chapter brief's ``quality_lessons`` block (≤ ``budget`` characters of JSON). Never raises."""
    try:
        from . import clock_check, human_voice  # noqa: PLC0415
        earlier = human_voice.earlier_chapters(store, pid, branch, outline, chapter_id) if outline else []
        block: dict = {}
        mine = [x["text"] for x in of_book(store, pid)]
        if mine:
            block["from_your_last_books"] = mine
        lows = _editor_lows(store, pid, branch, earlier)
        if lows:
            block["this_book_so_far"] = lows
        av = avoid_list(earlier)
        if av:
            block["avoid"] = av
        if earlier:
            book = clock_check.check_book(earlier)
            facts = clock_check.facts(book)
            if facts:
                block["clock"] = facts
            must = [f"{f['label']} (chapter {f['passages'][-1]['number']}): {f['detail']}" for f in book["findings"]
                    if f["severity"] == "major"][:3]
            if must:
                block["must_fix"] = must
        floor = reading_floor(store, pid)
        if floor:
            block["reading_level"] = floor
        if not block:
            return None
        # least important first: older avoid items, this book's editor lessons, the clock note, the author's lessons
        return _bounded(block, budget, ("avoid", "this_book_so_far", "from_your_last_books", "clock", "must_fix",
                                        "reading_level"), cut, "lessons")
    except Exception:  # noqa: BLE001 - a brief part is help, never a reason to fail the chapter
        log.exception("could not build the lessons block")
        return None


def home(store, who: str, pid: str, branch: str) -> dict | None:
    """📈 Book home: this book against the author's earlier books ({line, text, weakest, falling, …}); None before the
    book has a scored report. Never raises."""
    try:
        cur = next((r for r in books(store, who) if r.get("book") == pid), None)
        if cur is None:
            reps = (store.get_setting(f"book_reports:{pid}:{branch}") or {}).get("reports") or []
            rep = reps[-1] if reps else None
            if not rep or (rep.get("aggregate") or {}).get("overall") is None:
                return None
            cur = snapshot(rep, book=pid)
        return trend(store, who, current=cur)
    except Exception:  # noqa: BLE001
        log.exception("could not work out the trend for Book home")
        return None
