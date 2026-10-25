"""🌊 P32 physical state tracker: per scene, the state of the physical world at the END of the scene.

What is tracked (the second book's lessons: the 32–41 lamp count, the clock, the gauge reading; a hazard set up early
that later scenes forget):

* ``where`` / ``time`` / ``light`` / ``tide`` / ``weather`` / ``footing`` — short plain words ("before dawn",
  "lantern light", "low tide", "fog", "slippery steps");
* ``hazards`` — [{what, status open|resolved, effect}]: a danger in the scene (gas, a cracked lens, rotten boards); an
  OPEN hazard must change what people do later (they step around it, it costs time, it gets worse) until it is
  resolved on the page;
* ``counts`` — [{name, value, running}]: numbers the reader can follow (lamps lit, steps climbed, the gauge reading,
  the clock). A *running* count only goes one way (lamp 32 → 41); going back is flagged.

This module is pure logic: cleaning, a deterministic extraction from the chapter text (no AI: keyword and number
patterns, English only), the deterministic checks and the bounded brief for the next chapter's writer. Storage, the AI
extraction and the routes are in continuity.py (companion data ``physical_state:<project>:<branch>``).
"""
from __future__ import annotations

import re

TEXT_MAX = 160
NAME_MAX = 60
MAX_SCENES = 8
MAX_HAZARDS = 8
MAX_COUNTS = 10
HAZARD_STATUSES = ("open", "resolved")

# (key, plain label, ⓘ help) — the ONE place the fields are named
FIELDS = (
    ("where", "Where", "The place at the end of the scene."),
    ("time", "Time", "Clock time or time of day at the end of the scene (\"nine o'clock\", \"before dawn\")."),
    ("light", "Light", "How much can be seen and by what light (lantern, moonlight, dark)."),
    ("tide", "Tide / water", "Tide or water level when it matters (low tide, the tide turning)."),
    ("weather", "Weather", "Fog, rain, wind, storm… as it is at the end of the scene."),
    ("footing", "Footing", "What the ground is like underfoot (slippery steps, loose shingle)."),
)
FIELD_KEYS = tuple(k for k, _l, _h in FIELDS)

_S = {"type": "string"}
HAZARD_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["what", "status", "effect"],
                 "properties": {"what": _S, "status": {"type": "string", "enum": list(HAZARD_STATUSES)},
                                "effect": _S}}
COUNT_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["name", "value", "running"],
                "properties": {"name": _S, "value": _S, "running": {"type": "boolean"}}}
SCENE_PROPS = {k: _S for k in FIELD_KEYS}
SCENE_PROPS.update(hazards={"type": "array", "maxItems": MAX_HAZARDS, "items": HAZARD_SCHEMA},
                   counts={"type": "array", "maxItems": MAX_COUNTS, "items": COUNT_SCHEMA})

LINT_WORDS = {
    "COUNT_BACKWARDS": "a running count goes backwards",
    "TIME_BACKWARDS": "the clock goes backwards inside the chapter",
    "HAZARD_DROPPED": "a hazard is set up and then never matters again",
    "HAZARD_NOT_IN_LATER": "an open hazard from an earlier chapter is not mentioned here",
}

RULE = ("Physical state (context.writing_brief.physical_state): this chapter starts from where the last one ended — "
        "keep the time, light, tide, weather and footing consistent unless the page shows them changing; every open "
        "hazard still exists and must change what people do (they work around it, it costs time or gets worse) until "
        "the page resolves it; running counts continue from their last value (never restart or go back).")


def _clip(v, n: int = TEXT_MAX) -> str:
    return " ".join(str(v or "").split())[:n] if isinstance(v, (str, int, float)) and not isinstance(v, bool) else ""


def field_info() -> dict:
    return {"fields": [{"key": k, "label": label, "help": hlp} for k, label, hlp in FIELDS],
            "hazard_statuses": list(HAZARD_STATUSES)}


# ====================================================================== numbers in words
_UNITS = {w: i for i, w in enumerate("zero one two three four five six seven eight nine ten eleven twelve thirteen "
                                     "fourteen fifteen sixteen seventeen eighteen nineteen".split())}
_TENS = {w: (i + 2) * 10 for i, w in enumerate("twenty thirty forty fifty sixty seventy eighty ninety".split())}
_ORD_UNITS = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6, "seventh": 7, "eighth": 8,
              "ninth": 9, "tenth": 10, "eleventh": 11, "twelfth": 12, "thirteenth": 13, "fourteenth": 14,
              "fifteenth": 15, "sixteenth": 16, "seventeenth": 17, "eighteenth": 18, "nineteenth": 19}
_ORD_TENS = {w[:-1] + "ieth": v for w, v in _TENS.items()}
NUMBER_WORD = (r"(?:(?:(?:a|one|two|three|four|five|six|seven|eight|nine)\s+)?hundred(?:\s+and)?\s+)?"
               r"(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|"
               r"seven|eight|nine|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth))?|"
               r"zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|"
               r"sixteen|seventeen|eighteen|nineteen|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|"
               r"eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|"
               r"twentieth|thirtieth|fortieth|fiftieth|sixtieth|seventieth|eightieth|ninetieth|hundred|hundredth)")


def parse_number(text: str) -> tuple[int | None, bool]:
    """(value, is_ordinal) for "32", "32nd", "thirty-two", "thirty-second", "a hundred and twelve"; (None, False)."""
    t = str(text or "").strip().lower().replace("-", " ")
    m = re.fullmatch(r"(\d{1,6})(st|nd|rd|th)?", t)
    if m:
        return int(m.group(1)), bool(m.group(2))
    total, cur, ordinal, seen = 0, 0, False, False
    for w in t.split():
        if w in ("and", "a"):
            continue
        if w in _UNITS:
            cur += _UNITS[w]
        elif w in _TENS:
            cur += _TENS[w]
        elif w in _ORD_UNITS:
            cur += _ORD_UNITS[w]
            ordinal = True
        elif w in _ORD_TENS:
            cur += _ORD_TENS[w]
            ordinal = True
        elif w in ("hundred", "hundredth"):
            cur = max(cur, 1) * 100
            ordinal = ordinal or w == "hundredth"
        else:
            return None, False
        seen = True
    total += cur
    return (total, ordinal) if seen else (None, False)


def number_of(value) -> float | None:
    """The number inside a count value ("32", "41 lamps", "40 psi", "thirty-two") or None."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    s = str(value or "")
    m = re.search(r"-?\d+(?:\.\d+)?", s)
    if m:
        return float(m.group(0))
    m = re.search(NUMBER_WORD, s.lower())
    if m:
        n, _o = parse_number(m.group(0))
        return float(n) if n is not None else None
    return None


# ====================================================================== cleaning
def clean_hazard(raw) -> dict | None:
    if isinstance(raw, str):
        raw = {"what": raw}
    if not isinstance(raw, dict):
        return None
    what = _clip(raw.get("what"), NAME_MAX)
    if not what:
        return None
    st = raw.get("status") if raw.get("status") in HAZARD_STATUSES else "open"
    return {"what": what, "status": st, "effect": _clip(raw.get("effect"))}


def clean_count(raw) -> dict | None:
    if not isinstance(raw, dict):
        return None
    name, value = _clip(raw.get("name"), NAME_MAX), _clip(raw.get("value"), NAME_MAX)
    if not name or not value:
        return None
    return {"name": name, "value": value, "running": raw.get("running") is True}


def clean_scene(raw, n: int) -> dict | None:
    if not isinstance(raw, dict):
        return None
    s = {"scene": n}
    s.update({k: _clip(raw.get(k)) for k in FIELD_KEYS})
    hz, cn = [], []
    for h in raw.get("hazards") or []:
        x = clean_hazard(h)
        if x and x["what"].lower() not in {y["what"].lower() for y in hz}:
            hz.append(x)
    for c in raw.get("counts") or []:
        x = clean_count(c)
        if x and x["name"].lower() not in {y["name"].lower() for y in cn}:
            cn.append(x)
    s["hazards"], s["counts"] = hz[:MAX_HAZARDS], cn[:MAX_COUNTS]
    if not any(s[k] for k in FIELD_KEYS) and not s["hazards"] and not s["counts"]:
        return None
    return s


def clean_scenes(raw) -> list[dict]:
    items = raw.get("scenes") if isinstance(raw, dict) else raw
    out = []
    for r in items if isinstance(items, list) else []:
        s = clean_scene(r, len(out) + 1)
        if s:
            out.append(s)
        if len(out) >= MAX_SCENES:
            break
    return out


# ====================================================================== deterministic extraction (no AI)
SCENE_BREAK = re.compile(r"^\s*(?:\*\s*\*\s*\*|#{1,3}\s*$|-{3,}|~{3,}|•\s*•\s*•|§)\s*$", re.M)
_SENT = re.compile(r"[^.!?\n]+[.!?]?")
_TIME = re.compile(
    r"\b(?:(?:half|quarter)\s+(?:past|to)\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)|"
    r"(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})\s+o'?clock|"
    r"\d{1,2}[:.]\d{2}(?:\s*[ap]\.?m\.?)?|before dawn|at dawn|first light|daybreak|sunrise|sunset|dusk|twilight|"
    r"midnight|noon|midday|morning|afternoon|evening|nightfall|that night|the night|tonight)\b", re.I)
_LIGHT = re.compile(
    r"\b(pitch[- ]black|pitch[- ]dark|darkness|dark|dim|gloom|moonlight|starlight|sunlight|daylight|lamplight|"
    r"lantern(?: light)?|candlelight|torchlight|firelight|grey light|gray light|first light|half-light|"
    r"the (?:great )?lamp (?:blazed|burned|was lit|went out|went dark))\b", re.I)
_TIDE = re.compile(
    r"\b(low tide|high tide|ebb tide|flood tide|slack water|neap tide|spring tide|"
    r"(?:the )?tide (?:was |is )?(?:coming in|going out|turning|turned|rising|falling|rose|fell|came in|went out|"
    r"out|in))\b", re.I)
_WEATHER = re.compile(r"\b(fog|mist|rain|drizzle|storm|gale|wind|snow|sleet|hail|thunder|lightning|frost|clear sky|"
                      r"sunshine|heat)\b", re.I)
_FOOTING = re.compile(r"\b(slippery|slick|wet|icy|muddy|loose|steep|narrow|rotten|uneven|crumbling|sodden|weed-covered|"
                      r"worn)\s+(steps?|stairs?|stones?|rocks?|boards?|planks?|ground|path|deck|floor|ladder|rungs?|"
                      r"shingle|sand|ice|ledge)\b", re.I)
HAZARD_WORDS = {
    "gas": "gas", "leak": "leak", "leaking": "leak", "fire": "fire", "flames": "fire", "smoke": "smoke",
    "flood": "flooding", "flooding": "flooding", "crack": "crack", "cracked": "crack", "broken": "broken",
    "collapse": "collapse", "collapsed": "collapse", "rotten": "rot", "rot": "rot", "icy": "ice", "wound": "wound",
    "wounded": "wound", "bleeding": "bleeding", "injured": "injury", "sprained": "sprain", "limp": "limp",
    "limping": "limp", "explosion": "explosion", "spark": "spark", "sparks": "spark", "undertow": "undertow",
    "current": "current", "reef": "reef", "cliff": "cliff", "pressure": "pressure", "fumes": "fumes",
}
_HAZARD = re.compile(r"\b(" + "|".join(sorted(HAZARD_WORDS, key=len, reverse=True)) + r")\b", re.I)
_RESOLVED = re.compile(r"\b(fixed|sealed|put out|extinguished|mended|shut off|turned off|closed off|repaired|safe now|"
                       r"bandaged|patched|stopped the leak|cleared)\b", re.I)
RUNNING_NOUNS = {"lamp", "light", "step", "stair", "bell", "stroke", "round", "lap", "floor", "flight", "mile",
                 "match", "cartridge", "shot", "night", "day", "post", "buoy", "rung"}
COUNT_NOUNS = RUNNING_NOUNS | {"bullet", "coin", "candle", "barrel", "boat", "body", "key", "letter", "fathom",
                               "minute", "hour", "pound", "shilling", "crown", "sack", "crate", "can", "gallon"}
_COUNT = re.compile(r"\b(\d{1,4}(?:st|nd|rd|th)?|" + NUMBER_WORD + r")\s+([a-z]+)\b", re.I)
_NUMBERED = re.compile(r"\b(lamp|light|post|buoy|bay|berth|cell|room|gate|pier|lock)\s+(?:no\.?\s*|number\s+|#)?"
                       r"(\d{1,4})\b", re.I)
_GAUGE = re.compile(r"\b(gauge|dial|meter|barometer|needle|clock)\s+(?:read|reads|showed|shows|said|says|stood at|"
                    r"was at|pointed to|pointed at|struck)\s+(\w[\w.:]*(?:\s+(?:psi|pounds|inches|degrees|bar|o'clock|"
                    r"feet|fathoms))?)", re.I)


def _singular(w: str) -> str:
    w = w.lower()
    if w.endswith("ies") and len(w) > 4:
        return w[:-3] + "y"
    if w.endswith("ches") or w.endswith("shes") or w.endswith("sses"):
        return w[:-2]
    if w.endswith("s") and not w.endswith("ss") and len(w) > 3:
        return w[:-1]
    return w


def split_scenes(text: str) -> list[str]:
    body = "\n".join(x for x in str(text or "").splitlines() if not x.lstrip().startswith("# "))
    parts = [p.strip() for p in SCENE_BREAK.split(body)]
    return [p for p in parts if p][:MAX_SCENES] or ([body.strip()] if body.strip() else [])


def _last(rx, text: str) -> str:
    found = [m.group(0) for m in rx.finditer(text)]
    return _clip(found[-1].lower(), 60) if found else ""


def extract(text: str) -> list[dict]:
    """Deterministic state per scene (scene breaks: ``* * *``, ``---``, ``#``…; none → one scene)."""
    out = []
    for i, scene in enumerate(split_scenes(text)):
        s = {"scene": i + 1, "where": "", "time": _last(_TIME, scene), "light": _last(_LIGHT, scene),
             "tide": _last(_TIDE, scene), "weather": _last(_WEATHER, scene)}
        foot = [f"{m.group(1).lower()} {m.group(2).lower()}" for m in _FOOTING.finditer(scene)]
        s["footing"] = ", ".join(dict.fromkeys(foot))[:TEXT_MAX]
        hz: dict[str, dict] = {}
        for sent in _SENT.findall(scene):
            for m in _HAZARD.finditer(sent):
                name = HAZARD_WORDS[m.group(1).lower()]
                hz[name] = {"what": name, "status": "resolved" if _RESOLVED.search(sent) else "open",
                            "effect": _clip(sent, TEXT_MAX)}
        s["hazards"] = list(hz.values())[:MAX_HAZARDS]
        counts: dict[str, dict] = {}
        for m in _COUNT.finditer(scene):
            noun = _singular(m.group(2))
            if noun not in COUNT_NOUNS:
                continue
            n, ordinal = parse_number(m.group(1))
            if n is None:
                continue
            counts[noun] = {"name": noun, "value": str(n), "running": ordinal or noun in RUNNING_NOUNS}
        for m in _NUMBERED.finditer(scene):
            noun = m.group(1).lower()
            counts[noun] = {"name": noun, "value": m.group(2), "running": noun in RUNNING_NOUNS}
        for m in _GAUGE.finditer(scene):
            counts[m.group(1).lower()] = {"name": m.group(1).lower(), "value": _clip(m.group(2), NAME_MAX),
                                          "running": False}
        s["counts"] = list(counts.values())[:MAX_COUNTS]
        cleaned = clean_scene(s, i + 1)
        if cleaned:
            out.append(cleaned)
    return out


def merge(ai_scenes: list[dict], found: list[dict]) -> list[dict]:
    """The AI's scenes, with empty fields filled from the deterministic extraction of the same scene number and its
    counts / hazards added when the AI missed them. No AI scenes → the deterministic ones."""
    if not ai_scenes:
        return found
    by_n = {s["scene"]: s for s in found}
    out = []
    for s in ai_scenes:
        d = by_n.get(s["scene"]) or {}
        m = dict(s)
        for k in FIELD_KEYS:
            if not m.get(k) and d.get(k):
                m[k] = d[k]
        have = {h["what"].lower() for h in m["hazards"]}
        m["hazards"] = (m["hazards"] + [h for h in d.get("hazards") or [] if h["what"].lower() not in have])[
            :MAX_HAZARDS]
        have = {c["name"].lower() for c in m["counts"]}
        m["counts"] = (m["counts"] + [c for c in d.get("counts") or [] if c["name"].lower() not in have])[:MAX_COUNTS]
        out.append(m)
    return out


# ====================================================================== deterministic checks
_HOUR_WORDS = {w: i + 1 for i, w in enumerate("one two three four five six seven eight nine ten eleven twelve".split())}
_DAY_JUMP = re.compile(r"\b(next (?:day|morning|night|evening)|tomorrow|the following|days? later|weeks? later|"
                       r"years? (?:later|ago|before)|remembered|memory|flashback|once,? long ago)\b", re.I)


def hour_of(time_text: str) -> float | None:
    t = str(time_text or "").lower()
    m = re.search(r"(\d{1,2})[:.](\d{2})", t)
    if m:
        h = int(m.group(1)) % 24
        if "pm" in t.replace(".", "") and h < 12:
            h += 12
        return h + int(m.group(2)) / 60
    m = re.search(r"(\w+)\s+o'?clock", t)
    if m:
        h = _HOUR_WORDS.get(m.group(1)) or (int(m.group(1)) if m.group(1).isdigit() else None)
        return float(h) if h else None
    m = re.search(r"(half|quarter) (past|to) (\w+)", t)
    if m and m.group(3) in _HOUR_WORDS:
        h = _HOUR_WORDS[m.group(3)]
        return h + (0.5 if m.group(1) == "half" else 0.25) * (1 if m.group(2) == "past" else -1)
    return None


def _hazard_key(what: str) -> str:
    w = str(what or "").lower()
    for k, v in HAZARD_WORDS.items():
        if re.search(rf"\b{re.escape(k)}\b", w):
            return v
    return w.split()[-1] if w.split() else w


def lint(chapters: list[dict]) -> list[dict]:
    """chapters: [{number, chapter_id, scenes, text}] in book order. Returns [{chapter_id, number, scene, code,
    severity, message}] (all minor: they are questions for the author, never a block)."""
    out = []
    running: dict[str, tuple] = {}      # count name -> (value, chapter number, scene)
    open_hz: dict[str, dict] = {}       # hazard key -> {what, number, chapter_id, scene, seen_later}
    for ch in chapters:
        n, cid = ch.get("number"), ch.get("chapter_id")
        text_low = str(ch.get("text") or "").lower()
        # earlier open hazards: do they show up again in this chapter's text?
        for key, hz in open_hz.items():
            if hz["number"] != n and (key in text_low or hz["what"].lower() in text_low):
                hz["seen_later"] = True
        last_hour = None
        for s in ch.get("scenes") or []:
            for c in s.get("counts") or []:
                v = number_of(c.get("value"))
                key = c["name"].lower()
                if v is None:
                    continue
                if c.get("running") and key in running and v < running[key][0]:
                    pv, pn, ps = running[key]
                    out.append({"chapter_id": cid, "number": n, "scene": s["scene"], "code": "COUNT_BACKWARDS",
                                "severity": "minor",
                                "message": f"{c['name']}: {_fmt(pv)} (chapter {pn}, scene {ps}) → {_fmt(v)} — "
                                           f"{LINT_WORDS['COUNT_BACKWARDS']}; on purpose?"})
                if c.get("running") or key in running:
                    running[key] = (v, n, s["scene"])
            h = hour_of(s.get("time"))
            if h is not None:
                if last_hour is not None and h < last_hour[0] and not _DAY_JUMP.search(
                        " ".join(str(x) for x in (s.get("time"), ch.get("scene_texts", {}).get(s["scene"], "")))):
                    out.append({"chapter_id": cid, "number": n, "scene": s["scene"], "code": "TIME_BACKWARDS",
                                "severity": "minor",
                                "message": f"{last_hour[1]} (scene {last_hour[2]}) → {s.get('time')} — "
                                           f"{LINT_WORDS['TIME_BACKWARDS']} (a flashback? say so on the page)"})
                last_hour = (h, s.get("time"), s["scene"])
            for hz in s.get("hazards") or []:
                key = _hazard_key(hz["what"])
                if hz.get("status") == "resolved":
                    open_hz.pop(key, None)
                elif key not in open_hz:
                    open_hz[key] = {"what": hz["what"], "number": n, "chapter_id": cid, "scene": s["scene"],
                                    "seen_later": False}
    last_n = chapters[-1].get("number") if chapters else None
    for key, hz in open_hz.items():
        if hz["number"] != last_n and not hz["seen_later"]:
            out.append({"chapter_id": hz["chapter_id"], "number": hz["number"], "scene": hz["scene"],
                        "code": "HAZARD_DROPPED", "severity": "minor",
                        "message": f"{hz['what']} (chapter {hz['number']}, scene {hz['scene']}) — "
                                   f"{LINT_WORDS['HAZARD_DROPPED']}: let it change a later action or resolve it"})
    return out


def _fmt(v: float) -> str:
    return str(int(v)) if float(v).is_integer() else str(v)


# ====================================================================== the state the next chapter starts from
def end_state(chapters: list[dict]) -> dict | None:
    """The state at the end of the last of ``chapters`` (book order, each {number, scenes}): the last scene's
    fields, the hazards still open across all of them and the last value of every count."""
    state = {k: "" for k in FIELD_KEYS}
    hazards: dict[str, dict] = {}
    counts: dict[str, dict] = {}
    after = None
    for ch in chapters:
        for s in ch.get("scenes") or []:
            after = ch.get("number")
            for k in FIELD_KEYS:
                if s.get(k):
                    state[k] = s[k]
            for hz in s.get("hazards") or []:
                key = _hazard_key(hz["what"])
                if hz.get("status") == "resolved":
                    hazards.pop(key, None)
                else:
                    hazards[key] = {"what": hz["what"], "since_chapter": ch.get("number"),
                                    **({"effect": hz["effect"]} if hz.get("effect") else {})}
            for c in s.get("counts") or []:
                counts[c["name"].lower()] = {"name": c["name"], "value": c["value"], "running": c.get("running"),
                                             "chapter": ch.get("number")}
    if after is None:
        return None
    out = {"after_chapter": after}
    out.update({k: v for k, v in state.items() if v})
    if hazards:
        out["open_hazards"] = list(hazards.values())[-MAX_HAZARDS:]
    if counts:
        out["counts"] = [{"name": c["name"], "last_value": c["value"], **({"running": True} if c["running"] else {})}
                         for c in counts.values()][-MAX_COUNTS:]
    return out
