"""🕰️ Timeline checker (P26): ages, years and "N years ago" arithmetic, checked without any AI.

The second book needed its age arithmetic verified by hand ("she was twelve when the light failed, twenty years
ago" … "in 1867" … "now forty"). This module reads every chapter in order and collects:

* **ages** — "Mara was twelve years old", "the 40-year-old Odile", "Odile, aged forty", "Mara turned thirteen",
  "Odile, forty years old," — each tied to the character named in the same sentence (known names first);
  sentences about the past ("when she was eight", "as a girl", "years ago", "at the age of") are kept apart and
  never compared with present ages;
* **years** — four-digit years (1000-2099), birth years ("born in 1850"), the story's own year ("It was the winter
  of 1887", "The year was 1887") and relative statements ("twenty years ago, in 1867", "ten years since 1877");
* **canon ages** — ages written in the characters' canon records (attributes such as "a woman of forty").

From these it derives "now" estimates (the story year said outright, birth year + present age, an event year + "N
years ago") and checks, deterministically:

* ``age_conflict``   one character with two different present ages in the same chapter (major);
* ``age_backwards``  a character gets younger in a later chapter (major);
* ``age_gap``        "N years older/younger than X" does not match the two ages on the page (major);
* ``age_canon``      the page says a different age from the character's canon record (minor: the canon may be old);
* ``year_arithmetic`` two "now" estimates of one chapter disagree by more than a year (major) — e.g. born in 1850,
                     "now forty" and "It was 1887";
* ``time_backwards`` a later chapter's "now" is earlier than an earlier chapter's (major; flashback chapters that say
                     so — "years earlier", "back then" — are skipped).

Output: ``{"ages": {name: [...]}, "years": [...], "now": [...], "story_year", "findings": [...], "summary"}``; each
finding ``{id, check, label, severity, detail, advice, passages: [{chapter, excerpt}]}`` like the pattern checker's,
so the UI and the editor read them the same way. English only, heuristic: it never edits text; the findings go to the
author and into the AI editor's context (``fact_checks`` in editor.py), where the editor confirms or ignores them.
"""
from __future__ import annotations

import re

EXCERPT_MAX = 120
MAX_FINDINGS = 30
YEAR_MIN, YEAR_MAX = 1000, 2099
AGE_MAX = 120

LABELS = {
    "age_conflict": "Two different ages in one chapter",
    "age_backwards": "A character gets younger",
    "age_gap": "Age difference does not add up",
    "age_canon": "Age differs from the character's record",
    "year_arithmetic": "Years do not add up",
    "time_backwards": "Time runs backwards between chapters",
}
ADVICE = {
    "age_conflict": "Decide the character's age and use it everywhere in this chapter.",
    "age_backwards": "Check the ages across chapters (or mark the chapter clearly as a flashback).",
    "age_gap": "Make the stated age difference match the two ages, or change one of the ages.",
    "age_canon": "Change the age on the page or update the character's record so they agree.",
    "year_arithmetic": "Work out the years once (birth year + age = the story's year; event year + years ago = the "
                       "story's year) and correct the number that is off.",
    "time_backwards": "Check the order of events, or make clear that this chapter looks back in time.",
}

_ONES = ("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen "
         "seventeen eighteen nineteen").split()
_TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80,
         "ninety": 90}
NUM_WORD = (r"(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|"
            r"seven|eight|nine))?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|"
            r"fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|a hundred|one hundred|\d{1,3})")
_N = rf"(?P<n>{NUM_WORD})"
_YEAR = r"(?P<y>1\d{3}|20\d{2})"

PAST = re.compile(r"\b(?:when (?:he|she|they|i|we|[A-Z][a-z]+) (?:was|were)|as a (?:girl|boy|child|baby|lad|lass|"
                  r"youngster)|back then|years ago|years earlier|years before|at the age of|used to|in those days|"
                  r"had been|once,|long ago|by the time (?:he|she|they) (?:was|were))\b", re.I)
FLASHBACK = re.compile(r"\b(?:years earlier|years before|back then|long ago|in those days|that summer, (?:when|as))\b",
                       re.I)

AGE_PATTERNS = (
    # Mara was twelve years old / Odile is forty-two years of age
    re.compile(rf"\b(?:was|is|'s|turned|would be|will be|had turned|became)\s+(?:now\s+|just\s+|nearly\s+|almost\s+|"
               rf"barely\s+|only\s+|already\s+|about\s+|over\s+)?{_N}\s+years?(?:\s+old|\s+of\s+age)\b", re.I),
    # Odile, forty years old, / Odile, aged forty
    re.compile(rf",\s+(?:aged\s+{_N}|(?P<n2>{NUM_WORD})\s+years?\s+old)\b", re.I),
    # aged forty
    re.compile(rf"\baged\s+{_N}\b", re.I),
    # Mara turned thirteen (that spring)
    re.compile(rf"\bturned\s+{_N}(?=\s*(?:[.,;!?]|that|this|last|on|in|at|the|years?|$))", re.I),
)
AGE_BEFORE_NAME = re.compile(rf"\b{_N}-years?-old\s+(?P<name>[A-Z][\w'’-]+)", re.I)
AGE_ADJ = re.compile(rf"\b{_N}-years?-old\b", re.I)
GAP = re.compile(rf"\b{_N}\s+years?\s+(?P<dir>older|younger)\s+than\s+(?P<other>[A-Z][\w'’-]+)")
BORN = re.compile(rf"\bborn\b[^.!?]{{0,40}}?\b{_YEAR}\b", re.I)
STORY_YEAR = re.compile(rf"\b(?:it was|the year was|this was|the year of our lord|now,? in|year:)\s+(?:the\s+)?"
                        rf"(?:(?:spring|summer|autumn|fall|winter|january|february|march|april|may|june|july|"
                        rf"august|september|october|november|december)\s+(?:of\s+)?)?{_YEAR}\b", re.I)
AGO_IN = re.compile(rf"\b{_N}\s+years?\s+(?:ago|earlier|before)\b[^.!?]{{0,60}}?\b(?:in|of)\s+{_YEAR}\b|"
                    rf"\b(?:in|of)\s+(?P<y2>1\d{{3}}|20\d{{2}})\b[^.!?]{{0,60}}?\b(?P<n2>{NUM_WORD})\s+years?\s+"
                    rf"(?:ago|earlier|before)\b",
                    re.I)
SINCE = re.compile(rf"\b{_N}\s+years?\s+since\s+{_YEAR}\b", re.I)
YEAR_ANY = re.compile(r"\b(1\d{3}|20\d{2})\b")
_SENT = re.compile(r"[^.!?…]+(?:[.!?…]+[\"'”’)]*|$)", re.S)
_PARA = re.compile(r"\n\s*\n")
_CAP = re.compile(r"\b[A-Z][\w'’-]+")
_NOT_NAMES = {"The", "A", "An", "He", "She", "They", "It", "I", "We", "You", "His", "Her", "Their", "When", "Then",
              "But", "And", "In", "On", "At", "By", "Now", "That", "This", "There", "Old", "Young", "Mr", "Mrs",
              "Miss", "Ms", "Dr", "Captain", "Keeper", "As", "If", "So", "Yet", "Once", "After", "Before", "Even",
              "Still", "Her", "Him", "Its", "Our", "My", "Your", "Not", "No", "Yes", "Every", "Each", "One"}


def number(word: str) -> int | None:
    """'forty-two' / 'forty two' / '42' / 'a hundred' -> int (None when it is not a number word)."""
    w = (word or "").strip().lower().replace("–", "-")
    if not w:
        return None
    if w.isdigit():
        return int(w)
    if w in ("a hundred", "one hundred"):
        return 100
    if w in _ONES:
        return _ONES.index(w)
    parts = re.split(r"[- ]", w)
    if parts[0] in _TENS:
        if len(parts) == 1:
            return _TENS[parts[0]]
        if len(parts) == 2 and parts[1] in _ONES[1:10]:
            return _TENS[parts[0]] + _ONES.index(parts[1])
    return None


def _clip(s: str, n: int = EXCERPT_MAX) -> str:
    s = " ".join((s or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


def paragraphs(text: str) -> list[str]:
    out = []
    for p in _PARA.split(text or ""):
        p = p.strip()
        if p.startswith("#"):
            p = p.split("\n", 1)[1].strip() if "\n" in p else ""
        if p:
            out.append(" ".join(p.split()))
    return out


def sentences(text: str) -> list[str]:
    return [s.strip() for p in paragraphs(text) for s in _SENT.findall(p) if s.strip()]


def _name_parts(names) -> dict:
    """{token: display name} for the known names (full names and parts of at least 3 letters)."""
    out = {}
    for n in names or []:
        if not isinstance(n, str) or not n.strip():
            continue
        out.setdefault(n.strip(), n.strip())
        for p in n.split():
            if len(p) >= 3 and p[0].isupper():
                out.setdefault(p, n.strip())
    return out


def _subject(sent: str, pos: int, known: dict, *, after: bool = False) -> str | None:
    """The character a statement at ``pos`` is about: the nearest known name before it (or after it for "the
    40-year-old Odile"); else the nearest capitalised word that is not a sentence word ("Mara was ...")."""
    region = sent[pos:pos + 60] if after else sent[max(0, pos - 80):pos]
    caps = list(_CAP.finditer(region))
    if after:
        caps = caps[:2]
    else:
        caps = caps[::-1]
    for m in caps:
        tok = m.group(0).rstrip("'’s").rstrip("'’")
        if tok in known:
            return known[tok]
    if known:
        return None
    for m in caps:
        tok = m.group(0).rstrip("'’s").rstrip("'’")
        if tok not in _NOT_NAMES:
            return tok
    return None


# ====================================================================== extraction (one chapter)
def extract(text: str, *, chapter: str | None = None, names=()) -> dict:
    """Everything timeline-related in one text: {ages, gaps, births, story_years, ago, flashback}."""
    known = _name_parts(names)
    ages, gaps, births, story_years, ago = [], [], [], [], []
    flashback = bool(FLASHBACK.search(" ".join(paragraphs(text)[:2])))
    for sent in sentences(text):
        past = bool(PAST.search(sent))
        seen_spans = []
        for pat in AGE_PATTERNS:
            for m in pat.finditer(sent):
                if any(a <= m.start() < b for a, b in seen_spans):
                    continue
                gd = m.groupdict()
                n = number(gd.get("n") or gd.get("n2") or "")
                if n is None or n > AGE_MAX:
                    continue
                who = _subject(sent, m.start(), known)
                if who:
                    seen_spans.append((m.start(), m.end()))
                    ages.append({"name": who, "age": n, "past": past, "chapter": chapter, "excerpt": _clip(sent)})
        for m in AGE_BEFORE_NAME.finditer(sent):
            if any(a <= m.start() < b for a, b in seen_spans):
                continue
            n = number(m.group("n"))
            tok = m.group("name").rstrip("'’s")
            who = known.get(tok) if known else (tok if tok not in _NOT_NAMES else None)
            if n is not None and n <= AGE_MAX and who:
                seen_spans.append((m.start(), m.end()))
                ages.append({"name": who, "age": n, "past": past, "chapter": chapter, "excerpt": _clip(sent)})
        for m in GAP.finditer(sent):
            n = number(m.group("n"))
            who = _subject(sent, m.start(), known)
            other = known.get(m.group("other").rstrip("'’s"), None if known else m.group("other"))
            if n is not None and who and other and who != other:
                gaps.append({"name": who, "other": other, "years": n if m.group("dir") == "older" else -n,
                             "chapter": chapter, "excerpt": _clip(sent)})
        for m in BORN.finditer(sent):
            who = _subject(sent, m.start(), known)
            if who:
                births.append({"name": who, "year": int(m.group("y")), "chapter": chapter, "excerpt": _clip(sent)})
        if not past:
            for m in STORY_YEAR.finditer(sent):
                story_years.append({"year": int(m.group("y")), "chapter": chapter, "excerpt": _clip(sent)})
        for m in AGO_IN.finditer(sent):
            n = number(m.group("n") or m.group("n2") or "")
            y = m.group("y") or m.group("y2")
            if n is not None and y:
                ago.append({"years": n, "event_year": int(y), "now": int(y) + n, "chapter": chapter,
                            "excerpt": _clip(sent)})
        for m in SINCE.finditer(sent):
            n = number(m.group("n"))
            if n is not None:
                ago.append({"years": n, "event_year": int(m.group("y")), "now": int(m.group("y")) + n,
                            "chapter": chapter, "excerpt": _clip(sent)})
    return {"ages": ages, "gaps": gaps, "births": births, "story_years": story_years, "ago": ago,
            "flashback": flashback}


def canon_ages(characters) -> dict:
    """{name: (age, excerpt)} from the characters' canon records (attributes text and string fact values)."""
    out = {}
    for c in characters or []:
        name = c.get("name")
        if not name:
            continue
        bits = [str(v) for v in (c.get("attributes") or {}).values() if isinstance(v, str)]
        bits += [str(f.get("value")) for f in c.get("facts") or [] if isinstance(f, dict)
                 and isinstance(f.get("value"), str)]
        for b in bits:
            found = None
            for sent in _SENT.findall(b):
                if PAST.search(sent):
                    continue
                for pat in AGE_PATTERNS + (AGE_ADJ,):
                    m = pat.search(sent)
                    if m:
                        n = number(m.group("n"))
                        if n is not None and n <= AGE_MAX:
                            found = (n, _clip(sent))
                            break
                if found:
                    break
                m = re.search(rf"\b(?:a|an)\s+(?:man|woman|person|girl|boy|keeper|widow|widower)\s+of\s+{_N}\b", sent,
                              re.I)
                if m and number(m.group("n")) is not None:
                    found = (number(m.group("n")), _clip(sent))
                    break
            if found:
                out[name] = found
                break
    return out


# ====================================================================== the checks (whole book, in order)
def _finding(check, detail, passages, severity="major") -> dict:
    return {"check": check, "label": LABELS[check], "severity": severity, "detail": detail,
            "advice": ADVICE[check], "passages": passages[:4], "count": len(passages)}


def check_book(chapters, *, names=(), characters=(), story_year: int | None = None) -> dict:
    """``chapters``: [(chapter_id, text)] in book order. Never raises on odd text."""
    per = [(cid, extract(text or "", chapter=cid, names=names)) for cid, text in chapters]
    findings = []
    ages_by: dict[str, list] = {}
    for cid, ex in per:
        for a in ex["ages"]:
            ages_by.setdefault(a["name"], []).append(a)
    # 1. one chapter, two present ages for the same character
    for name, rows in ages_by.items():
        present = [r for r in rows if not r["past"]]
        for cid in dict.fromkeys(r["chapter"] for r in present):
            vals = {r["age"] for r in present if r["chapter"] == cid}
            if len(vals) > 1:
                findings.append(_finding("age_conflict", f"{name}: {', '.join(str(v) for v in sorted(vals))} in the "
                                         "same chapter", [{"chapter": cid, "excerpt": r["excerpt"]} for r in present
                                                          if r["chapter"] == cid]))
    # 2. younger in a later chapter (flashback chapters skipped)
    flash = {cid for cid, ex in per if ex["flashback"]}
    order = {cid: i for i, (cid, _t) in enumerate(chapters)}
    for name, rows in ages_by.items():
        present = sorted([r for r in rows if not r["past"] and r["chapter"] not in flash],
                         key=lambda r: order.get(r["chapter"], 0))
        best = None
        for r in present:
            if best and r["age"] < best["age"] and r["chapter"] != best["chapter"]:
                findings.append(_finding("age_backwards", f"{name} is {best['age']} in chapter {best['chapter']} but "
                                         f"{r['age']} in chapter {r['chapter']}",
                                         [{"chapter": best["chapter"], "excerpt": best["excerpt"]},
                                          {"chapter": r["chapter"], "excerpt": r["excerpt"]}]))
                break
            if best is None or r["age"] >= best["age"]:
                best = r
    # 3. "N years older than X"
    for cid, ex in per:
        for g in ex["gaps"]:
            a = _age_near(ages_by.get(g["name"]), cid, order)
            b = _age_near(ages_by.get(g["other"]), cid, order)
            if a and b and abs((a["age"] - b["age"]) - g["years"]) > 1:
                findings.append(_finding("age_gap", f"{g['name']} is said to be {abs(g['years'])} years "
                                         f"{'older' if g['years'] > 0 else 'younger'} than {g['other']}, but the "
                                         f"ages are {a['age']} and {b['age']}",
                                         [{"chapter": cid, "excerpt": g["excerpt"]},
                                          {"chapter": a["chapter"], "excerpt": a["excerpt"]},
                                          {"chapter": b["chapter"], "excerpt": b["excerpt"]}]))
    # 4. the canon record says another age (first present age on the page)
    for name, (age, ex_text) in canon_ages(characters).items():
        present = sorted([r for r in ages_by.get(name, []) if not r["past"]], key=lambda r: order.get(r["chapter"], 0))
        if present and abs(present[0]["age"] - age) > 1:
            findings.append(_finding("age_canon", f"{name} is {present[0]['age']} on the page but {age} in the "
                                     "character's record", [{"chapter": present[0]["chapter"],
                                                             "excerpt": present[0]["excerpt"]},
                                                            {"chapter": "record", "excerpt": ex_text}],
                                     severity="minor"))
    # 5. "now" estimates per chapter
    births = {}
    for _cid, ex in per:
        for b in ex["births"]:
            births.setdefault(b["name"], b)
    now = []
    if story_year:
        now.append({"year": int(story_year), "how": "the story year you set", "chapter": None, "excerpt": ""})
    for cid, ex in per:
        for s in ex["story_years"]:
            now.append({"year": s["year"], "how": "said in the text", "chapter": cid, "excerpt": s["excerpt"]})
        for a in ex["ago"]:
            now.append({"year": a["now"], "how": f"{a['event_year']} + {a['years']} years", "chapter": cid,
                        "excerpt": a["excerpt"]})
        for a in ex["ages"]:
            b = births.get(a["name"])
            if b and not a["past"]:
                now.append({"year": b["year"] + a["age"], "how": f"{a['name']} born {b['year']} + age {a['age']}",
                            "chapter": cid, "excerpt": a["excerpt"], "birth_excerpt": b["excerpt"]})
    for cid, _ex in per:
        mine = [n for n in now if n["chapter"] == cid or (n["chapter"] is None)]
        vals = sorted({n["year"] for n in mine})
        if len(vals) > 1 and vals[-1] - vals[0] > 1 and any(n["chapter"] == cid for n in mine):
            findings.append(_finding("year_arithmetic", "the years in this chapter point to different “now” years: "
                                     + "; ".join(f"{n['year']} ({n['how']})" for n in mine)[:300],
                                     [{"chapter": n["chapter"] or "setting", "excerpt": n["excerpt"] or n["how"]}
                                      for n in mine]))
    # 6. a later chapter's now earlier than an earlier chapter's
    last = None
    for cid, _t in chapters:
        if cid in flash:
            continue
        mine = [n for n in now if n["chapter"] == cid]
        if not mine:
            continue
        y = min(n["year"] for n in mine)
        if last and y < last["year"] - 1:
            findings.append(_finding("time_backwards", f"chapter {cid} points to {y}, chapter {last['chapter']} to "
                                     f"{last['year']}", [{"chapter": last["chapter"], "excerpt": last["excerpt"]},
                                                         {"chapter": cid, "excerpt": mine[0]["excerpt"]}]))
        last = {"year": max(n["year"] for n in mine), "chapter": cid, "excerpt": mine[-1]["excerpt"]}
    findings = findings[:MAX_FINDINGS]
    for i, f in enumerate(findings):
        f["id"] = f"tl{i + 1}"
    sy = story_year or _majority([s["year"] for _c, ex in per for s in ex["story_years"]])
    return {"ages": {n: [{k: r[k] for k in ("age", "past", "chapter", "excerpt")} for r in rows]
                     for n, rows in ages_by.items()},
            "births": [b for _c, ex in per for b in ex["births"]][:20],
            "now": now[:30], "story_year": sy, "findings": findings,
            "summary": {"major": sum(1 for f in findings if f["severity"] == "major"),
                        "minor": sum(1 for f in findings if f["severity"] == "minor"),
                        "ages": sum(len(v) for v in ages_by.values()), "years": len(now)}}


def _age_near(rows, cid, order):
    rows = [r for r in rows or [] if not r["past"]]
    if not rows:
        return None
    same = [r for r in rows if r["chapter"] == cid]
    if same:
        return same[0]
    return min(rows, key=lambda r: abs(order.get(r["chapter"], 0) - order.get(cid, 0)))


def _majority(vals):
    if not vals:
        return None
    return max(set(vals), key=lambda v: (vals.count(v), -vals.index(v)))


def for_chapter(book: dict, chapter_id: str) -> list[dict]:
    """The book findings that touch one chapter."""
    return [f for f in book.get("findings") or [] if any(p.get("chapter") == chapter_id for p in f["passages"])]


def brief(book: dict, chapter_id: str | None = None, limit: int = 8) -> dict:
    """For the AI editor: the ages and years Akọwe found and the findings (bounded)."""
    fs = for_chapter(book, chapter_id) if chapter_id else book.get("findings") or []
    return {"story_year": book.get("story_year"),
            "ages": {n: sorted({r["age"] for r in rows if not r["past"]}) for n, rows in
                     list((book.get("ages") or {}).items())[:12]},
            "findings": [{"check": f["check"], "severity": f["severity"], "detail": f["detail"][:240],
                          "passages": [p["excerpt"][:120] for p in f["passages"][:2]]} for f in fs[:limit]]}
