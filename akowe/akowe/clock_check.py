"""🕰️🌊 Clock, tide and day arithmetic (no AI): stated times that cannot all be true.

The book "The Salt Organ" scored 5/10 on the editor's "Time, ages and order": high water was 18:06, yet the tide was
"going out" at 14:30 (before high water the tide comes IN), and Friday's high water at about 20:00 did not fit a
Saturday-morning ebb. ``timeline_check`` does ages and years; this module does the clock:

* **times** — "14:30", "18.06" after a tide word, "half past two", "quarter to five", "ten past three", "four
  o'clock", "2 pm", "eight in the evening"; a 12-hour time without a part of the day keeps BOTH readings (2:00 and
  14:00) and is only called wrong when both readings are wrong;
* **days** — weekday names ("Friday", "on Saturday morning") and day changes in the narration ("the next morning",
  "the following day", "the day after"); a time belongs to the day the narration is on;
* **tides** — high water / high tide / low water / low tide with a time (an anchor), and the tide's direction
  ("going out", "on the ebb", "ebbing", "falling" / "coming in", "on the flood", "rising"), with the time in the same
  sentence or the scene's latest time (or a part of the day such as "Saturday morning").

Checks (each finding quotes the passage word for word, so the editor and the reviewer can act on it):

* ``tide_direction`` — the tide runs the wrong way for the high water the book stated (the tide rises for about
  6 h 12 min before high water and falls for about 6 h 12 min after it; a turn of the tide ±40 min is never flagged)
  (major);
* ``tide_times`` — two high (or low) waters that cannot both be true: they come about 12 h 25 min apart, so the
  next day's is about 50 minutes later (±60 min allowed; only within two days) (major);
* ``clock_back`` — inside one chapter the clock runs backwards on the same day with no day change or flashback
  between (both times unambiguous; more than 90 minutes) (minor).

Heuristic and English only; it never edits text. Used by the editor and the chapter reviewer (``flags_for``: this
chapter's contradictions are must-fix), the writer's brief (``facts``: the tide and day facts so far) and the final
improve pass (improve_pass.py).
"""
from __future__ import annotations

import logging
import re

from . import dialogue

log = logging.getLogger("akowe.clock_check")

PERIOD = 745          # minutes between two high waters (12 h 25 min)
HALF = PERIOD // 2    # 372: high water -> low water
SLACK = 40            # minutes around a turn of the tide that are never flagged
ANCHOR_TOL = 60       # two high waters may be this far off the 12 h 25 min rhythm
ANCHOR_DAYS = 2       # anchors further apart than this are not compared (the rhythm drifts)
BACK_MIN = 90         # minutes the clock must run backwards before it is flagged
EXCERPT_MAX = 200
MAX_FINDINGS = 20
DAY = 1440

LABELS = {"tide_direction": "The tide runs the wrong way", "tide_times": "Tide times do not fit together",
          "clock_back": "The clock runs backwards", "weekday_jump": "The days of the week do not add up",
          "weekday_date": "A date and its weekday do not fit"}
ADVICE = {
    "tide_direction": "Before high water the tide comes in (rises); for about six hours after it, it goes out "
                      "(falls). Change the time or the direction so they agree.",
    "tide_times": "High waters come about 12 hours 25 minutes apart (about 50 minutes later each day). Change one of "
                  "the times so they fit.",
    "clock_back": "Check the order of the times in this chapter, or make the day change (or the flashback) clear.",
    "weekday_jump": "Count the days again: change the weekday, the date or the number of days so they agree.",
    "weekday_date": "Two dates in the book fall on weekdays that cannot both be true: change the date or the weekday.",
}
WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
_NUMS = {w: i for i, w in enumerate("zero one two three four five six seven eight nine ten eleven twelve".split())}
_NUM = r"(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)"
_MINW = {"quarter": 15, "half": 30, "five": 5, "ten": 10, "twenty": 20, "twenty-five": 25, "twenty five": 25}
_PART = r"(?:in the (?P<part>morning|afternoon|evening|night)|at night|(?P<ap>a\.?m\.?|p\.?m\.?))"

DIGITAL = re.compile(r"(?<![\d:.])(?P<h>[01]?\d|2[0-3])[:.](?P<m>[0-5]\d)(?![\d:])(?:\s*" + _PART + r")?", re.I)
PAST_TO = re.compile(r"\b(?P<mw>quarter|half|five|ten|twenty(?:[- ]five)?)\s+(?P<rel>past|to)\s+(?P<h>" + _NUM
                     + r")\b(?:\s*" + _PART + r")?", re.I)
OCLOCK = re.compile(r"\b(?P<h>" + _NUM + r")\s+o['’]clock\b(?:\s*" + _PART + r")?", re.I)
AMPM = re.compile(r"\b(?P<h>\d{1,2})(?::(?P<m>[0-5]\d))?\s*(?P<ap>a\.?m\.?|p\.?m\.?)(?!\w)", re.I)
INPART = re.compile(r"\b(?:at|by|after|before|until|till|around|about|nearly|gone)\s+(?P<h>" + _NUM
                    + r")\s+(?:in the (?P<part>morning|afternoon|evening)|at night)\b", re.I)
PART_OF_DAY = re.compile(r"\b(?P<part>dawn|daybreak|sunrise|morning|forenoon|noon|midday|afternoon|dusk|sunset|"
                         r"evening|night|midnight)\b", re.I)
PART_WINDOWS = {"dawn": (300, 420), "daybreak": (300, 420), "sunrise": (300, 450), "morning": (360, 690),
                "forenoon": (480, 690), "noon": (690, 750), "midday": (690, 750), "afternoon": (720, 1050),
                "dusk": (1020, 1260), "sunset": (1020, 1260), "evening": (1020, 1320), "night": (1260, 1680),
                "midnight": (1410, 1470)}
NEXT_DAY = re.compile(r"\b(?:the next (?:morning|day|evening|night)|next morning|the following (?:morning|day|"
                      r"evening)|the morning after|the day after)\b", re.I)
WEEKDAY = re.compile(r"\b(?P<d>Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)(?:['’]s)?\b")
HIGH = re.compile(r"\b(?:high water|high tide|full tide|top of the tide|tide (?:was|would be|is) (?:full|high|at "
                  r"its height)|the flood (?:peaked|was full))\b", re.I)
LOW = re.compile(r"\b(?:low water|low tide|dead low|bottom of the tide|tide (?:was|would be|is) (?:low|out|at its "
                 r"lowest)|slack low)\b", re.I)
EBB = re.compile(r"\b(?:(?:tide|water|sea)\s+(?:was\s+|is\s+|had\s+been\s+|still\s+|already\s+)*(?:going out|running "
                 r"out|ebbing|falling|dropping|draining|receding|on the ebb|turning to ebb)|on the ebb|the ebb (?:was "
                 r")?(?:running|pulling|setting)|ebb tide|ebbing tide|falling tide|outgoing tide|tide went out|tide "
                 r"had turned and was going out)\b", re.I)
FLOOD = re.compile(r"\b(?:(?:tide|water|sea)\s+(?:was\s+|is\s+|had\s+been\s+|still\s+|already\s+)*(?:coming in|"
                   r"running in|rising|flooding|making|creeping in|on the flood)|on the flood|the flood (?:was )?"
                   r"(?:running|setting|making)|flood tide|rising tide|incoming tide|tide came in)\b", re.I)
FLASHBACK = re.compile(r"\b(?:years (?:earlier|before|ago)|back then|long ago|that (?:summer|winter|night) (?:when|"
                       r"as)|had been|remembered|used to)\b", re.I)
_PARA = re.compile(r"\n\s*\n")
_SENT = re.compile(r"[^.!?…]+(?:[.!?…]+[\"'”’)]*|$)", re.S)
_QUOTED = dialogue.FINDER   # 💬 every dialogue style (dialogue.py)


def _clip(s: str, n: int = EXCERPT_MAX) -> str:
    s = " ".join((s or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


def _num(w: str) -> int | None:
    w = (w or "").lower()
    if w.isdigit():
        return int(w)
    return _NUMS.get(w)


def hhmm(minutes: int) -> str:
    m = int(minutes) % DAY
    return f"{m // 60:02d}:{m % 60:02d}"


def _with_part(h: int, m: int, part: str | None, ap: str | None) -> list[int]:
    """Minutes after midnight for an hour/minute and an optional part of the day; [] when impossible. A 12-hour time
    without a part of the day keeps both readings."""
    if h > 24 or m > 59:
        return []
    ap = (ap or "").lower().replace(".", "")
    part = (part or "").lower()
    if ap or part:
        if h > 12:
            return [h * 60 + m] if h < 24 else []
        pm = ap == "pm" or part in ("afternoon", "evening") or (part == "night" and h != 12 and h >= 6)
        if ap == "am" or part == "morning":
            pm = False
        hh = (h % 12) + (12 if pm else 0)
        if part == "night" and h < 6:
            hh = h % 12
        return [hh * 60 + m]
    if h >= 13 or h == 0:
        return [h * 60 + m]
    return sorted({(h % 12) * 60 + m, ((h % 12) + 12) * 60 + m})


def times_in(sentence: str, *, tide: bool = False) -> list[dict]:
    """Every clock time in a sentence: [{at (position), minutes: [one or two readings], text}]."""
    out, used = [], []

    def add(m, mins):
        if not mins or any(a <= m.start() < b for a, b in used):
            return
        used.append((m.start(), m.end()))
        out.append({"at": m.start(), "minutes": mins, "text": m.group(0)})
    for m in DIGITAL.finditer(sentence):
        if m.group(0)[len(m.group("h"))] == "." and not tide:
            continue  # "18.06" only counts next to a tide word (else it may be a number)
        mins = _with_part(int(m.group("h")), int(m.group("m")), m.group("part"), m.group("ap"))
        if m.group("h").startswith("0") and not (m.group("part") or m.group("ap")):
            mins = [int(m.group("h")) * 60 + int(m.group("m"))]  # "07:10" is a 24-hour time
        add(m, mins)
    for m in AMPM.finditer(sentence):
        add(m, _with_part(int(m.group("h")), int(m.group("m") or 0), None, m.group("ap")))
    for m in PAST_TO.finditer(sentence):
        h = _num(m.group("h"))
        mw = _MINW.get(m.group("mw").lower().replace("-", " "), _MINW.get(m.group("mw").lower()))
        if h is None or mw is None:
            continue
        if m.group("rel").lower() == "to":
            h, mw = (h - 1) % 12 or 12, 60 - mw
        add(m, _with_part(h, mw, m.group("part"), m.group("ap")))
    for m in OCLOCK.finditer(sentence):
        h = _num(m.group("h"))
        if h is not None:
            add(m, _with_part(h, 0, m.group("part"), m.group("ap")))
    for m in INPART.finditer(sentence):
        h = _num(m.group("h"))
        if h is not None:
            add(m, _with_part(h, 0, m.group("part") or "night", None))
    out.sort(key=lambda t: t["at"])
    return out


def _paragraphs(text: str) -> list[str]:
    out = []
    for p in _PARA.split(text or ""):
        p = p.strip()
        if p.startswith("#"):
            p = p.split("\n", 1)[1].strip() if "\n" in p else ""
        if p:
            out.append(" ".join(p.split()))
    return out


def _chapters(chapters) -> list[dict]:
    out = []
    for i, c in enumerate(chapters or []):
        if isinstance(c, dict):
            out.append({"chapter_id": c.get("chapter_id") or str(i + 1), "number": c.get("number") or i + 1,
                        "text": str(c.get("text") or "")})
        else:
            cid, text = c
            out.append({"chapter_id": cid, "number": i + 1, "text": str(text or "")})
    return out


def extract(chapters) -> dict:
    """The day/time line of the book: ``events`` [{kind: anchor_high | anchor_low | ebb | flood | time, day,
    minutes (readings) or window, chapter_id, number, sentence, part}], in reading order."""
    events = []
    day, weekday = 0, None
    for c in _chapters(chapters):
        last_times: list[int] | None = None
        last_part = None
        for par in _paragraphs(c["text"]):
            masked = dialogue.mask(par)  # 💬 a speech over several sentences ('…. …,' she said) is dialogue too
            for sm in _SENT.finditer(par):
                sent = sm.group(0).strip()
                if not sent:
                    continue
                nar = masked[sm.start():sm.end()]
                if NEXT_DAY.search(nar):
                    day += 1
                    last_times, last_part = None, None
                wd = WEEKDAY.search(nar)
                if wd:
                    w = WEEKDAYS.index(wd.group("d").lower())
                    if weekday is None:
                        weekday = w
                    else:
                        ahead = (w - weekday) % 7
                        if ahead:
                            day += ahead
                            weekday = w
                            last_times, last_part = None, None
                tide_here = bool(HIGH.search(sent) or LOW.search(sent) or EBB.search(sent) or FLOOD.search(sent))
                ts = times_in(sent, tide=tide_here)
                pm = PART_OF_DAY.search(nar)
                if pm:
                    last_part = pm.group("part").lower()
                base = {"chapter_id": c["chapter_id"], "number": c["number"], "sentence": sent, "day": day,
                        "weekday": WEEKDAYS[weekday] if weekday is not None else None,
                        "flashback": bool(FLASHBACK.search(nar)), "dialogue": nar.strip() != sm.group(0).strip()}
                hi, lo = HIGH.search(sent), LOW.search(sent)
                if (hi or lo) and ts:
                    # the time nearest the tide word belongs to it ("high water at 18:06")
                    pos = (hi or lo).start()
                    t = min(ts, key=lambda x: abs(x["at"] - pos))
                    events.append(dict(base, kind="anchor_high" if hi and (not lo or hi.start() <= lo.start())
                                       else "anchor_low", minutes=t["minutes"], time_text=t["text"]))
                for rx, kind in ((EBB, "ebb"), (FLOOD, "flood")):
                    m = rx.search(sent)
                    if not m:
                        continue
                    if ts:
                        events.append(dict(base, kind=kind, minutes=ts[0]["minutes"] if len(ts) == 1 else min(
                            ts, key=lambda x: abs(x["at"] - m.start()))["minutes"], words=m.group(0)))
                    elif last_times:
                        events.append(dict(base, kind=kind, minutes=last_times, words=m.group(0), inferred=True))
                    elif last_part and last_part in PART_WINDOWS:
                        a, b = PART_WINDOWS[last_part]
                        events.append(dict(base, kind=kind, window=[a, b], part=last_part, words=m.group(0)))
                if ts and not (hi or lo):
                    for t in ts:
                        events.append(dict(base, kind="time", minutes=t["minutes"], time_text=t["text"]))
                if ts and not (hi or lo):  # a tide-table time is not the time of the scene
                    last_times = ts[-1]["minutes"]
    return {"events": events, "days": day + 1}


def _phase(at: int, anchor: int) -> int:
    return (at - anchor) % PERIOD


def _direction_ok(kind: str, at: int, high: int) -> bool:
    ph = _phase(at, high)
    if min(ph, abs(ph - HALF), PERIOD - ph) <= SLACK:
        return True  # a turn of the tide: either word is fine
    return (ph < HALF) == (kind == "ebb")


def _finding(check, detail, passages, severity="major") -> dict:
    return {"check": check, "label": LABELS[check], "severity": severity, "detail": detail, "advice": ADVICE[check],
            "passages": passages}


def _passage(e: dict) -> dict:
    return {"chapter": e["chapter_id"], "number": e["number"], "excerpt": _clip(e["sentence"]), "quote": e["sentence"]}


def check_book(chapters) -> dict:
    """{events, anchors, findings, summary} for the chapters in book order ([{chapter_id, number, text}] or
    [(chapter_id, text)]). Never raises."""
    try:
        return _check(chapters)
    except Exception:  # noqa: BLE001 - a hint, never a reason to fail
        log.exception("clock check failed")
        return {"events": [], "anchors": [], "findings": [], "summary": ""}


def _anchor_highs(e: dict) -> list[int]:
    shift = 0 if e["kind"] == "anchor_high" else HALF
    return [e["day"] * DAY + m + shift for m in e["minutes"]]


def _check(chapters) -> dict:
    ex = extract(chapters)
    events = ex["events"]
    anchors = [e for e in events if e["kind"] in ("anchor_high", "anchor_low") and not e["flashback"]]
    findings = []
    # -- two anchors that cannot both be true
    for i, a in enumerate(anchors):
        for b in anchors[i + 1:]:
            if abs(b["day"] - a["day"]) > ANCHOR_DAYS:
                continue
            ok = any(min(_phase(y, x), PERIOD - _phase(y, x)) <= ANCHOR_TOL
                     for x in _anchor_highs(a) for y in _anchor_highs(b))
            if not ok:
                findings.append(_finding(
                    "tide_times", f"{_what(a)} and {_what(b)} cannot both be true: high waters come about 12 h 25 min "
                    "apart.", [_passage(a), _passage(b)]))
    # -- the direction of the tide against the latest anchor before it (else the first one after it)
    for e in events:
        if e["kind"] not in ("ebb", "flood") or e["flashback"]:
            continue
        prior = [a for a in anchors if a is not e and abs(a["day"] - e["day"]) <= ANCHOR_DAYS
                 and events.index(a) < events.index(e)]
        ref = prior[-1] if prior else next((a for a in anchors if abs(a["day"] - e["day"]) <= ANCHOR_DAYS), None)
        if ref is None:
            continue
        highs = _anchor_highs(ref)
        if e.get("window"):
            a0, b0 = e["window"]
            samples = [e["day"] * DAY + t for t in range(a0, b0 + 1, 15)]
        else:
            samples = [e["day"] * DAY + m for m in e["minutes"]]
        if any(_direction_ok(e["kind"], s, h) for s in samples for h in highs):
            continue
        when = (f"{e['weekday'].title()} " if e.get("weekday") else "") + (
            e["part"] if e.get("window") else " or ".join(hhmm(m) for m in e["minutes"]))
        right = "coming in" if e["kind"] == "ebb" else "going out"
        findings.append(_finding(
            "tide_direction", f"The tide is {'going out' if e['kind'] == 'ebb' else 'coming in'} at {when.strip()}, "
            f"but with {_what(ref)} it should be {right} then.", [_passage(ref), _passage(e)] if ref is not e
            else [_passage(e)]))
    # -- the clock running backwards inside one chapter (same day, both times unambiguous)
    prev = None
    for e in events:
        if e["kind"] != "time" or not e.get("minutes"):
            continue
        if len(e["minutes"]) != 1 or e["dialogue"] or e["flashback"]:
            prev = None if e["flashback"] else prev
            continue
        if prev and prev["chapter_id"] == e["chapter_id"] and prev["day"] == e["day"] \
                and prev["minutes"][0] - e["minutes"][0] > BACK_MIN:
            findings.append(_finding(
                "clock_back", f"In chapter {e['number']} it is {hhmm(prev['minutes'][0])}, then "
                f"{hhmm(e['minutes'][0])} on the same day, with no day change between.", [_passage(prev), _passage(e)],
                severity="minor"))
        prev = e
    findings += calendar_findings(chapters)  # 📅 weekdays, dates and "N days later" (calendar_findings)
    seen, out = set(), []
    for f in findings:
        key = (f["check"], tuple(p["quote"] for p in f["passages"]))
        if key in seen:
            continue
        seen.add(key)
        out.append(f)
    out = out[:MAX_FINDINGS]
    for i, f in enumerate(out):
        f["id"] = f"ck{i + 1}"
    summary = (f"🕰️ Clock, days and tide: {len(out)} problem(s) — " + "; ".join(f["detail"] for f in out[:2])) if out else ""
    return {"events": events, "anchors": [{k: a.get(k) for k in ("kind", "day", "weekday", "minutes", "number")}
                                          for a in anchors], "findings": out, "summary": summary}


def _what(a: dict) -> str:
    word = "high water" if a["kind"] == "anchor_high" else "low water"
    day = f"{a['weekday'].title()} " if a.get("weekday") else ""
    return f"{word} {day}at {' or '.join(hhmm(m) for m in a['minutes'])} (chapter {a['number']})"


def for_chapter(book: dict, chapter_id: str) -> list[dict]:
    """The findings whose LAST passage is in this chapter (the chapter that has to change)."""
    return [f for f in book.get("findings") or [] if f["passages"] and f["passages"][-1]["chapter"] == chapter_id]


def facts(book: dict, limit: int = 4) -> list[str]:
    """Short lines for the writer's brief: the tide anchors stated so far and how the tide runs from them."""
    out = []
    for a in (book.get("anchors") or [])[-limit:]:
        word = "High water" if a["kind"] == "anchor_high" else "Low water"
        day = f"{str(a.get('weekday') or '').title()} " if a.get("weekday") else ""
        out.append(f"{word} {day}at {' or '.join(hhmm(m) for m in a['minutes'])} (chapter {a['number']}).")
    if out:
        out.append("The tide rises for about 6 h before high water and falls for about 6 h after it; the next high "
                   "water is about 12 h 25 min later (about 50 min later each day). Keep every time and tide on the "
                   "page consistent with these.")
    return out


def flags_for(engine, principal: str, pid: str, branch: str, rec: dict) -> list[dict]:
    """This chapter's clock/tide contradictions (with the chapters before it) as ``akowe_in_chapter`` flags for the
    editor and the reviewer: [{name, message, quote}] (quote = this chapter's sentence, word for word). Never raises."""
    try:
        if rec.get("module_id") != "C02":
            return []
        from .fact_checks import book_texts  # noqa: PLC0415
        chs = book_texts(engine, principal, pid, branch)
        me = next((c for c in chs if c["record_id"] == rec["record_id"]), None)
        if me is None:
            return []
        text = str((rec.get("data") or {}).get("text") or "")
        upto = [dict(c, text=text) if c is me else c for c in chs if c["number"] <= me["number"]]
        book = check_book(upto)
        return [{"name": "time", "message": f"{f['label']}: {f['detail']} {f['advice']}",
                 "quote": f["passages"][-1]["quote"]} for f in for_chapter(book, me["chapter_id"])][:6]
    except Exception:  # noqa: BLE001
        log.exception("could not check the clock of this chapter")
        return []


# ====================================================================== 📅 weekdays, dates and "N days later"
# The book "The Tide Ledger" had a Friday "four days later" that was not four days later, a "Sunday … the next
# morning … Saturday" and "the second Saturday" six days after the first. Akọwe follows the stated weekdays and dates
# and the explicit day jumps ("the next morning", "four days later", "a week later") through the narration (never the
# dialogue, never a flashback) and flags a weekday or date stated right after a jump (in that sentence or the next
# two) that the jump cannot reach, and two dates whose weekdays cannot both be true. A vague jump ("a few days
# later", "weeks passed") forgets what day it is, so nothing after it is called wrong.
MONTHS = ("january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
          "november", "december")
_MONTH_DAYS = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
_MONTH_START = [sum(_MONTH_DAYS[:i]) for i in range(12)]
_WD = r"(?P<d>Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)"
_MON = r"(?P<m>January|February|March|April|May|June|July|August|September|October|November|December)"
_ORD_WORDS = {w: i + 1 for i, w in enumerate((
    "first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth "
    "fifteenth sixteenth seventeenth eighteenth nineteenth twentieth twenty-first twenty-second twenty-third "
    "twenty-fourth twenty-fifth twenty-sixth twenty-seventh twenty-eighth twenty-ninth thirtieth thirty-first").split())}
_ORD = r"(?:\d{1,2}(?:st|nd|rd|th)?|" + "|".join(sorted(_ORD_WORDS, key=len, reverse=True)) + r")"
_COUNT = {w: i for i, w in enumerate("zero one two three four five six seven eight nine ten eleven twelve thirteen "
                                     "fourteen fifteen sixteen seventeen eighteen nineteen twenty".split())}
_COUNT.update({"a": 1, "an": 1, "a couple of": 2, "twenty-one": 21, "thirty": 30})
_CNT = r"(?P<n>\d{1,2}|a couple of|twenty-one|thirty|" + "|".join(sorted((w for w in _COUNT if " " not in w and
                                                                           "-" not in w), key=len, reverse=True)) + r")"
JUMP_NEXT = re.compile(r"\b(?:the next (?:morning|day|evening|night|afternoon)|next morning|the following (?:morning|"
                       r"day|evening|night|afternoon)|the morning after|the day after(?! tomorrow)|by morning)\b", re.I)
JUMP_DAYS = re.compile(r"\b" + _CNT + r"\s+(?P<u>days?|weeks?|fortnights?)\s+(?:later|afterwards?|after that|on|had "
                       r"passed|passed|went by)\b", re.I)
JUMP_VAGUE = re.compile(r"\b(?:(?:a few|several|some|many|few|the|those|countless)\s+(?:days|weeks|months|years)\b|"
                        r"(?:days|weeks|months|years)\s+(?:later|passed|went by|had passed)|a (?:month|year) later|"
                        r"months? later|the (?:week|month) (?:passed|went by)|in the days that followed|over the "
                        r"(?:next|following) (?:days|weeks))", re.I)
DAY_WORD = re.compile(r"\b" + _WD + r"\b(?!s\b)(?:['’]s)?")
NOT_TODAY = re.compile(r"(?:\b(?:last|next|every|each|until|till|since|before|by|from|coming|on a|that coming|"
                       r"the previous|the last|the next|this coming)\s+(?:the\s+)?)$", re.I)
ORD_WD = re.compile(r"\bthe (?P<o>first|second|third|fourth|last) " + _WD + r"(?: (?:of|in) " + _MON + r")?\b", re.I)
DATE_DM = re.compile(r"\b(?:the )?(?P<n>" + _ORD + r")(?: of)? " + _MON + r"\b", re.I)
DATE_MD = re.compile(r"\b" + _MON + r" (?:the )?(?P<n>" + _ORD + r")\b", re.I)
DATE_D = re.compile(r"\bthe (?P<n>\d{1,2}(?:st|nd|rd|th)|" + "|".join(
    sorted((w for w in _ORD_WORDS if _ORD_WORDS[w] > 4), key=len, reverse=True)) + r")\b(?! (?:of|in) (?:the|a|his|"
    r"her|their|its|my|our|your)\b)(?! (?:time|day|week|month|year|chapter|floor|step|man|woman|one|of|in|to|"
    r"and|or|night|morning|letter|page|bell|ring|knock|try|attempt|round|lap)\b)", re.I)
JUMP_WINDOW = 3   # sentences (the jump's own and the next two) a stated weekday or date is checked against the jump


def _ord(w: str) -> int | None:
    w = (w or "").lower()
    m = re.match(r"(\d{1,2})", w)
    if m:
        n = int(m.group(1))
        return n if 1 <= n <= 31 else None
    return _ORD_WORDS.get(w)


def _doy(month: int, dom: int) -> int | None:
    if not 0 <= month < 12 or not 1 <= dom <= _MONTH_DAYS[month] + (1 if month == 1 else 0):
        return None
    return _MONTH_START[month] + dom - 1


def _month_of(doy: int) -> int:
    doy %= 365
    return max(i for i in range(12) if _MONTH_START[i] <= doy)


def _mentions(nar: str, cur_month: int | None) -> list[dict]:
    """The weekdays and dates a narration segment states as the current day: [{at, wd, doys, text}]."""
    out, used = [], []

    def add(m, wd=None, doys=None):
        if any(a <= m.start() < b or m.start() <= a < m.end() for a, b in used):
            return
        used.append((m.start(), m.end()))
        out.append({"at": m.start(), "wd": wd, "doys": doys, "text": m.group(0)})
    for m in ORD_WD.finditer(nar):
        if NOT_TODAY.search(nar[:m.start()]):
            continue
        wd = WEEKDAYS.index(m.group("d").lower())
        mon = MONTHS.index(m.group("m").lower()) if m.group("m") else cur_month
        o = m.group("o").lower()
        doys = None
        if mon is not None:
            if o == "last":
                last = _MONTH_DAYS[mon]
                doys = {_doy(mon, d) for d in range(last - 6, last + 1)}
            else:
                k = ("first", "second", "third", "fourth").index(o)
                doys = {_doy(mon, d) for d in range(7 * k + 1, 7 * k + 8)}
            doys.discard(None)
        add(m, wd, doys or None)
    for rx in (DATE_DM, DATE_MD):
        for m in rx.finditer(nar):
            n = _ord(m.group("n"))
            d = _doy(MONTHS.index(m.group("m").lower()), n) if n else None
            if d is not None:
                add(m, None, {d})
    if cur_month is not None:
        for m in DATE_D.finditer(nar):
            n = _ord(m.group("n"))
            d = _doy(cur_month, n) if n else None
            if d is not None:
                add(m, None, {d})
    for m in DAY_WORD.finditer(nar):
        if NOT_TODAY.search(nar[:m.start()]):
            continue
        add(m, WEEKDAYS.index(m.group("d").lower()))
    out.sort(key=lambda x: x["at"])
    # a weekday next to a date is one day ("Friday, 9 January", "Friday the 9th")
    merged: list[dict] = []
    for x in out:
        if merged and x["at"] - (merged[-1]["at"] + len(merged[-1]["text"])) <= 6 and \
                (merged[-1]["wd"] is None) != (x["wd"] is None) and (merged[-1]["doys"] is None) != (x["doys"] is None):
            y = merged[-1]
            y.update(wd=y["wd"] if y["wd"] is not None else x["wd"], doys=y["doys"] or x["doys"],
                     text=nar[y["at"]:x["at"] + len(x["text"])])
            continue
        merged.append(dict(x))
    return merged


def _jumps(nar: str) -> list[tuple[int, int | None, str]]:
    """The day jumps of a narration segment: [(position, days or None for a vague jump, words)]."""
    out = []
    for m in JUMP_VAGUE.finditer(nar):
        out.append((m.start(), None, m.group(0)))
    for m in JUMP_DAYS.finditer(nar):
        n = m.group("n").lower()
        k = int(n) if n.isdigit() else _COUNT.get(n)
        if k is None:
            continue
        u = m.group("u").lower()
        k *= 14 if u.startswith("fortnight") else 7 if u.startswith("week") else 1
        out = [j for j in out if not (j[1] is None and m.start() <= j[0] < m.end())]
        out.append((m.start(), k, m.group(0)))
    for m in JUMP_NEXT.finditer(nar):
        out.append((m.start(), 1, m.group(0)))
    out.sort()
    return out


def _shift(doys: set | None, n: int) -> set | None:
    return {(d + n) % 365 for d in doys} if doys else None


def _pair_ok(a: dict, b: dict) -> bool:
    """Can both (dates, weekday) pairs be true in the same year (or the next one)?"""
    for d1 in a["doys"]:
        for d2 in b["doys"]:
            gap = d2 - d1 if d2 >= d1 else d2 + 365 - d1
            for g in (gap, gap + 1):  # a leap year may add a day
                if (a["wd"] + g) % 7 == b["wd"]:
                    return True
    return False


def _day_words(wd: int | None, doys: set | None) -> str:
    bits = []
    if wd is not None:
        bits.append(WEEKDAYS[wd].title())
    if doys and len(doys) == 1:
        d = next(iter(doys))
        mo = _month_of(d)
        bits.append(f"{d - _MONTH_START[mo] + 1} {MONTHS[mo].title()}")
    return " ".join(bits) or "that day"


def calendar_findings(chapters) -> list[dict]:
    """📅 Weekday / date contradictions in book order (findings like the clock's; no AI). Never raises."""
    try:
        return _calendar(chapters)
    except Exception:  # noqa: BLE001
        log.exception("calendar check failed")
        return []


def _calendar(chapters) -> list[dict]:
    findings: list[dict] = []
    wd: int | None = None            # the weekday of the narration's current day (stated or counted)
    doys: set | None = None          # its possible days of the year
    anchor = None                    # the sentence that stated the day last
    pending = None                   # an explicit jump still waiting for a stated day: {n, left, sentence, chain}
    pairs: list[dict] = []           # stated (dates, weekday) pairs
    for c in _chapters(chapters):
        for par in _paragraphs(c["text"]):
            masked = dialogue.mask(par)
            for sm in _SENT.finditer(par):
                sent = sm.group(0).strip()
                nar = masked[sm.start():sm.end()]
                if not sent or not nar.strip():
                    continue
                if FLASHBACK.search(nar):
                    if pending:
                        pending["left"] -= 1
                    continue
                here = {"chapter_id": c["chapter_id"], "number": c["number"], "sentence": sent}
                cuts = [(p, n, w) for p, n, w in _jumps(nar)]
                bounds = [0] + [p for p, _n, _w in cuts] + [len(nar)]
                for k in range(len(bounds) - 1):
                    if k > 0:
                        _p, n, words = cuts[k - 1]
                        if n is None:
                            wd, doys, pending = None, None, None
                        else:
                            wd = (wd + n) % 7 if wd is not None else None
                            doys = _shift(doys, n)
                            if wd is not None or doys:
                                if pending is None:
                                    pending = {"n": 0, "from": anchor, "words": []}
                                pending.update(n=pending["n"] + n, left=JUMP_WINDOW)
                                pending["words"].append(words)
                    seg = nar[bounds[k]:bounds[k + 1]]
                    mon = _month_of(min(doys)) if doys else None
                    for x in _mentions(seg, mon):
                        if pending and pending.get("from"):
                            was = pending["from"]
                            if x["wd"] is not None and wd is not None and x["wd"] != wd:
                                findings.append(_finding(
                                    "weekday_jump", f"{_day_words(was['wd'], None)} (chapter {was['number']}) and "
                                    f"then {' and '.join(w.lower() for w in pending['words'])} makes it {WEEKDAYS[wd].title()}, but the "
                                    f"book says {WEEKDAYS[x['wd']].title()} (chapter {c['number']}).",
                                    [_passage(was), _passage(here)]))
                            elif x["doys"] and doys and not (x["doys"] & doys):
                                findings.append(_finding(
                                    "weekday_jump", f"{_day_words(None, was['doys'])} (chapter {was['number']}) and "
                                    f"then {' and '.join(w.lower() for w in pending['words'])} makes it {_day_words(None, doys)}, but "
                                    f"the book says {x['text']} (chapter {c['number']}).",
                                    [_passage(was), _passage(here)]))
                        if x["wd"] is not None and x["doys"]:
                            pair = {"wd": x["wd"], "doys": x["doys"], **here}
                            prev = pairs[-1] if pairs else None
                            if prev and not _pair_ok(prev, pair):
                                findings.append(_finding(
                                    "weekday_date", f"{prev['text']} (chapter {prev['number']}) and {x['text']} "
                                    f"(chapter {c['number']}) cannot both be true: the days between them do not fit "
                                    "the weekdays.", [_passage(prev), _passage(here)]))
                            pair["text"] = x["text"]
                            pairs.append(pair)
                        implicit = x["wd"] is not None and wd is not None and x["wd"] != wd and not pending
                        if x["wd"] is not None:
                            wd = x["wd"]
                        if x["doys"]:
                            doys = set(x["doys"])
                        elif implicit:
                            doys = None  # the narration skipped some days without saying how many
                        anchor = {"wd": wd, "doys": doys, **here}
                        pending = None
                if pending:
                    pending["left"] = pending.get("left", JUMP_WINDOW) - 1
                    if pending["left"] <= 0:
                        pending = None
    return findings
