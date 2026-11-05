"""📒 The story ledger: what really happened, chapter by chapter (holes H1, H2, H4, H8, H9, H19, H20, H21).

After every approved chapter (inside the continuity tracking call, continuity.py ``track_chapter``) the AI also
returns a short ``story`` part for the chapter; Akọwe keeps it per chapter (setting
``story_ledger:<project>:<branch>``):

* ``summary`` — two to four lines of what actually happened (the running "story so far");
* ``end`` — the last ~1 500 characters of the approved text (the next chapter's writer continues from it);
* ``people`` — per character at the END of the chapter: ``status`` alive / dead, ``where``, ``injuries`` (what, new /
  healing / healed), ``items_gained`` / ``items_lost`` / ``carrying`` (the field names of series.py ``CATS``) and
  ``magic_cost`` (an after-effect of using a power that lingers: a nosebleed, numb hands, exhaustion);
* ``names`` — new proper names (people, places, things) and their kind: the book's name list;
* ``time`` — story day, date, season and the time since the previous chapter; ``trips`` — a journey and how long it
  takes (the travel-time table);
* ``knowledge`` — who learns a secret, or is surprised by one; ``relationships`` — one line per pair that changed;
* ``numbers`` — money, prices, distances and counts that matter.

When no AI is free (busy, or the AI's answer has no story part) Akọwe's own keyword reading (``extract``) is kept and
the chapter's entry is marked ``weak`` — visibly (run events, the continuity page) — and read again by an AI later
(``retrack_weak``: before the next chapter is tracked and at every 🧭 checkpoint).

``check`` compares a chapter with everything before it and returns plain flags: a limping character running with no
time to heal, a lost item drawn again, a dead character speaking, a near-miss spelling of a known name (forge_check's
rule: same first letter, one letter different), a three-day ride arriving the next morning, snow then blossom a week
later, a character surprised by a secret they already know, a distance or price that changed.

``brief`` is what the next chapter's writer, its reviewer and the editor's rewrites get: the end of the previous
chapter, the story so far (a few lines per chapter, older chapters compressed — a 🧭 checkpoint's summary replaces
the lines of the chapters it covers), the state of the characters IN this chapter first (chosen by who is in it, not
by a fixed number; the least relevant are cut first when space is short), the names, time, travel, who-knows-what,
relationships and numbers.

Pure logic plus storage; never calls an AI itself, never raises into the caller.
"""
from __future__ import annotations

import copy
import json
import logging
import re
import threading
from datetime import datetime, timezone

log = logging.getLogger("akowe.story_ledger")

KEY = "story_ledger:{pid}:{branch}"
END_CHARS = 1500
TEXT_MAX = 200
LIST_MAX = 24
SUMMARY_LINES = 4
SO_FAR_BUDGET = 2200          # the story so far: this many characters …
SO_FAR_PER_CHAPTER = 120      # … plus this many per chapter written (PR #122) …
SO_FAR_MAX = 8000             # … at most (the C02 prompt has the room: ~22 000 characters of brief, 32k-token web chats)
MID_RECENT = 7                # the chapters before the last FULL_RECENT keep their first line in full
GROUP = 5                     # oldest chapters merged into stretches of this many when space is short
LEDGER_BUDGET = 2600
FULL_RECENT = 3          # the last chapters before this one keep all their summary lines
_LOCK = threading.RLock()

_S = {"type": "string"}


def _arr(items: dict, n: int = LIST_MAX) -> dict:
    return {"type": "array", "maxItems": n, "items": items}


def _obj(props: dict) -> dict:
    return {"type": "object", "additionalProperties": False, "required": list(props), "properties": props}


PERSON = _obj({"name": _S, "status": {"type": "string", "enum": ["alive", "dead", ""]}, "where": _S,
               "injuries": _arr(_obj({"what": _S, "status": {"type": "string", "enum": ["new", "healing", "healed"]}}),
                                8),
               "items_gained": _arr(_S, 8), "items_lost": _arr(_S, 8), "carrying": _arr(_S, 8), "magic_cost": _S})
STORY_SCHEMA = _obj({
    "summary": _arr(_S, SUMMARY_LINES), "people": _arr(PERSON),
    "names": _arr(_obj({"name": _S, "kind": {"type": "string", "enum": ["person", "place", "thing"]}}), 40),
    "time": _obj({"day": _S, "date": _S, "season": _S, "since_previous": _S}),
    "trips": _arr(_obj({"from": _S, "to": _S, "takes": _S}), 6),
    "knowledge": _arr(_obj({"who": _S, "what": _S, "how": {"type": "string", "enum": ["learns", "surprised"]}}), 12),
    "relationships": _arr(_obj({"a": _S, "b": _S, "line": _S}), 12),
    "numbers": _arr(_obj({"what": _S, "value": _S, "kind": {"type": "string",
                                                             "enum": ["money", "price", "distance", "count"]}}), 12)})

TASK = (
    " Also return ``story`` for the WHOLE chapter: summary — two to four short lines of what actually happened (events, "
    "not themes); people — for every character on the page, at the END of the chapter: status (alive or dead), where "
    "they are, injuries (what, and new / healing / healed), items_gained, items_lost, carrying (what they have on them "
    "now), magic_cost (an after-effect of using a power that lingers, e.g. a nosebleed, numb hands; empty if none); "
    "names — every proper name of a person, place or thing that appears (exact spelling on the page); time — the story "
    "day (\"day 3\"), date, season and the time since the previous chapter ended (\"the next morning\", \"three days\"); "
    "trips — a journey the text describes and how long it takes; knowledge — a character who learns a secret, or is "
    "surprised by one (how: learns / surprised); relationships — one line for each pair whose relationship is shown "
    "or changes; numbers — money, prices, distances and counts that matter. context.story_before is what was true "
    "before this chapter: continue from it. Only what the text shows.")

RULE = ("Story so far (context.writing_brief.previous_chapter_end, story_so_far, story_ledger): this chapter starts "
        "right after previous_chapter_end — continue from where and when it ends (never restart the scene, never "
        "introduce a character twice); keep every injury, item, death, place, date, season, travel time, secret "
        "someone already knows, relationship and number in story_ledger exactly as it stands unless this chapter "
        "shows it change (an injury heals only with time; a lost item stays lost until the page shows it found; the "
        "dead stay dead; a character never learns again what they already know); spell every name exactly as in "
        "story_ledger.names.")

FLAG_WORDS = {
    "INJURY_IGNORED": "runs, but was hurt and no time to heal has passed",
    "IN_CHAPTER_STATE": "is hurt earlier in this same chapter, then acts as if nothing happened",
    "LOST_ITEM_BACK": "uses an item they lost, and the page never shows it found again",
    "DEAD_ACTS": "speaks or acts, but died earlier",
    "NAME_SPELLING": "looks like a misspelling of a name the book already uses",
    "TRAVEL_TOO_FAST": "arrives far sooner than the journey takes",
    "SEASON_JUMP": "the season changes far too fast",
    "DAY_BACKWARDS": "the story day goes backwards",
    "ALREADY_KNEW": "is surprised by something they already knew",
    "NUMBER_CHANGED": "a distance or price changed",
}


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _clip(v, n: int = TEXT_MAX) -> str:
    return " ".join(str(v or "").split())[:n] if isinstance(v, (str, int, float)) and not isinstance(v, bool) else ""


def _strs(v, n: int = 8) -> list[str]:
    out = []
    for x in v if isinstance(v, list) else []:
        s = _clip(x, 120)
        if s and s.lower() not in [o.lower() for o in out]:
            out.append(s)
    return out[:n]


# ====================================================================== cleaning
def clean(raw) -> dict:
    """A stored ``story`` part from an AI answer (anything unusable dropped)."""
    raw = raw if isinstance(raw, dict) else {}
    out: dict = {"summary": _strs(raw.get("summary"), SUMMARY_LINES)}
    people = []
    for p in raw.get("people") if isinstance(raw.get("people"), list) else []:
        if not isinstance(p, dict) or not _clip(p.get("name"), 80):
            continue
        inj = [{"what": _clip(i.get("what"), 120), "status": i.get("status") if i.get("status") in
                ("new", "healing", "healed") else "new"} for i in p.get("injuries") or [] if isinstance(i, dict)
               and _clip(i.get("what"))]
        people.append({"name": _clip(p["name"], 80), "status": p.get("status") if p.get("status") in ("alive", "dead")
                       else "", "where": _clip(p.get("where"), 120), "injuries": inj[:8],
                       **{k: _strs(p.get(k)) for k in ("items_gained", "items_lost", "carrying")},
                       "magic_cost": _clip(p.get("magic_cost"), 120)})
    out["people"] = people[:LIST_MAX]
    out["names"] = [{"name": _clip(n.get("name"), 80), "kind": n.get("kind") if n.get("kind") in
                     ("person", "place", "thing") else "thing"} for n in raw.get("names") or []
                    if isinstance(n, dict) and _clip(n.get("name"), 80)][:40]
    t = raw.get("time") if isinstance(raw.get("time"), dict) else {}
    out["time"] = {k: _clip(t.get(k), 80) for k in ("day", "date", "season", "since_previous")}
    out["trips"] = [{k: _clip(x.get(k), 80) for k in ("from", "to", "takes")} for x in raw.get("trips") or []
                    if isinstance(x, dict) and _clip(x.get("to")) and _clip(x.get("takes"))][:6]
    out["knowledge"] = [{"who": _clip(x.get("who"), 80), "what": _clip(x.get("what")),
                         "how": x.get("how") if x.get("how") in ("learns", "surprised") else "learns"}
                        for x in raw.get("knowledge") or [] if isinstance(x, dict) and _clip(x.get("who"))
                        and _clip(x.get("what"))][:12]
    out["relationships"] = [{k: _clip(x.get(k), 120 if k == "line" else 80) for k in ("a", "b", "line")}
                            for x in raw.get("relationships") or [] if isinstance(x, dict) and _clip(x.get("a"))
                            and _clip(x.get("b")) and _clip(x.get("line"))][:12]
    out["numbers"] = [{"what": _clip(x.get("what"), 80), "value": _clip(x.get("value"), 60),
                       "kind": x.get("kind") if x.get("kind") in ("money", "price", "distance", "count") else "count"}
                      for x in raw.get("numbers") or [] if isinstance(x, dict) and _clip(x.get("what"))
                      and _clip(x.get("value"))][:12]
    return out


def empty(story: dict | None) -> bool:
    s = story or {}
    return not any(s.get(k) for k in ("summary", "people", "names", "trips", "knowledge", "relationships", "numbers")) \
        and not any((s.get("time") or {}).values())


# ====================================================================== Akọwe's own keyword reading (weak)
_SENT = re.compile(r"[^.!?\n]+[.!?]+[\"”’]?|[^.!?\n]+$")
STOP = {"The", "A", "An", "He", "She", "It", "They", "We", "I", "You", "His", "Her", "Their", "Its", "Our", "My",
        "Your", "But", "And", "Or", "So", "Then", "When", "While", "If", "In", "On", "At", "By", "For", "From", "To",
        "Of", "With", "As", "No", "Not", "Yes", "This", "That", "These", "Those", "There", "Here", "What", "Who",
        "Why", "How", "Where", "Only", "Even", "Still", "Now", "Once", "After", "Before", "Down", "Up", "Out", "All",
        "Every", "Some", "Far", "Mind", "Chapter", "Part", "Scene", "One", "Two", "Three", "Night", "Day", "Talk",
        "Fair", "Nobody", "Somebody", "Someone", "Something", "Nothing", "Everyone", "Everything", "Just", "Over",
        "Under", "Behind", "Inside", "Outside", "Across", "Through", "Beyond", "Above", "Below", "Near", "Let",
        "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "Christmas", "God", "Lord",
        "Lady", "Sir", "Mr", "Mrs", "Ms", "Dr", "Captain", "Old", "Young", "Winter", "Spring", "Summer", "Autumn"}
CAP_NAME = re.compile(r"\b[A-Z][a-zà-ÿ'’]+(?:\s+(?:of\s+|the\s+)?[A-Z][a-zà-ÿ'’]+)*")
LEG = r"(?:ankle|leg|knee|foot|feet|hip|thigh)"
INJURY_RE = re.compile(rf"\b(limp\w*|twist\w* (?:his|her|their|an?) {LEG}|(?:broke|broken|sprain\w*|hurt|injur\w*|"
                       rf"wound\w*|gash\w*) (?:his|her|their|an?|the)? ?{LEG}|{LEG} (?:was|is)? ?(?:broken|swollen|"
                       r"sprained)|wounded|bleeding|stabbed|broke (?:his|her|their) (?:arm|wrist|hand|ribs?))", re.I)
HEALED_RE = re.compile(r"\b(heal\w*|mended|no longer limp\w*|walk\w* (?:easily|freely) again|good as new)\b", re.I)
LEG_RE = re.compile(rf"\b(limp\w*|{LEG})\b", re.I)
RUN_RE = re.compile(r"\b(ran|run|runs|running|sprint\w*|raced|races|dash\w*|bound(?:ed|s)|leap[ts]?|leapt|"
                    r"jump(?:ed|s)?|hurdl\w*)\b", re.I)
LOST_RE = re.compile(r"\b(?:lost|dropped|drops|loses|gave away|threw away|broke|snapped|left behind)\s+"
                     r"(?:his|her|their|the|a|an|its)\s+((?:[a-z]+\s+)?[a-z]+)", re.I)
GAINED_RE = re.compile(r"\b(?:picked up|found|finds|took|was given|bought|recovered|got back|fished out)\s+"
                       r"(?:his|her|their|the|a|an|its)\s+((?:[a-z]+\s+)?[a-z]+)", re.I)
USE_RE = re.compile(r"\b(drew|draws|drawn|held|holds|gripped|grips|raised|raises|pulled out|took out|swung|"
                    r"swings|unsheathed|brandished|clutched|used|uses|lifted)\b", re.I)
DEAD_RE = re.compile(r"\b(died|dies|was killed|were killed|lay dead|lies dead|is dead|was dead|drowned|"
                     r"breathed (?:his|her|their) last)\b", re.I)
SPEAK_RE = re.compile(r"\b(said|says|asked|asks|replied|shouted|whispered|smiled|nodded|laughed|walked|ran|"
                      r"answered|called out|spoke)\b", re.I)
MEMORY_RE = re.compile(r"\b(remember\w*|memor\w*|ghost|dream\w*|grave|had said|used to|once said|portrait|"
                       r"funeral|mourn\w*|corpse|body of)\b", re.I)
MAGIC_COST_RE = re.compile(r"\b(nosebleed|nose bled|numb (?:hands|fingers)|exhaust\w*|shaking hands|"
                           r"(?:hands|fingers) (?:were|went) numb)\b", re.I)
SEASONS = {"winter": ("winter", "snow", "frost", "icicle", "sleet", "frozen"),
           "spring": ("spring", "blossom", "bud", "lambing", "thaw"),
           "summer": ("summer", "heatwave", "midsummer", "harvest moon"),
           "autumn": ("autumn", "fall leaves", "falling leaves", "harvest")}
SEASON_ORDER = ["winter", "spring", "summer", "autumn"]
LEARN_RE = re.compile(r"\b(learn(?:ed|s|t)|discover(?:ed|s)|found out|finds out|realis(?:ed|es)|realiz(?:ed|es)|"
                      r"was told|is told)\s+(?:that\s+)?(.{8,140}?)[.!?]", re.I)
SURPRISE_RE = re.compile(r"\b(?:was|is|looked|looks|stood)\s+(?:surprised|shocked|stunned|astonished)\s+"
                         r"(?:to (?:learn|hear|find|see)\s+)?(?:that\s+)?(.{0,140}?)[.!?]", re.I)
NUM_WORDS = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
             "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "twenty": 20, "thirty": 30,
             "a hundred": 100, "half a": 0.5, "a few": 3, "several": 4}
NUM = r"(\d+(?:\.\d+)?|half a|a few|several|a hundred|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|" \
      r"twelve|twenty|thirty)"
MONEY_RE = re.compile(NUM + r"\s+((?:gold|silver|copper|brass)\s+)?(coins?|crowns?|marks?|pennies|pence|shillings?|"
                      r"pounds?|dollars?|florins?|ducats?)\b", re.I)
DIST_RE = re.compile(NUM + r"\s+(miles?|leagues?|kilomet(?:er|re)s?|km)\b", re.I)
SINCE_RE = re.compile(NUM + r"\s+(hours?|days?|nights?|weeks?|months?|years?)\s+later\b|\b(the next (?:morning|day|"
                      r"evening|night)|next morning|that (?:night|evening|afternoon)|the following (?:day|morning|"
                      r"week)|a week later|a month later|the same (?:day|night))\b", re.I)
TRIP_RE = re.compile(NUM + r"\s+(hours?|days?|nights?|weeks?)'?s?\s+(?:ride|walk|march|sail|journey|travel|drive)\s+"
                     r"(?:from\s+(?P<a>[A-Z][\w'’]+(?:\s+[A-Z][\w'’]+)*)\s+)?to\s+(?:the\s+)?"
                     r"(?P<b>[A-Z][\w'’]+(?:\s+[A-Z][\w'’]+)*)")
DAY_RE = re.compile(r"\bday\s+(\d{1,4})\b", re.I)


_PREP = {"in", "on", "at", "into", "to", "from", "with", "and", "as", "over", "under", "off", "by", "near", "of",
         "onto", "behind", "beside", "when", "while", "for", "again", "too", "there", "here"}


def _item_phrase(s: str) -> str:
    out = []
    for w in str(s or "").lower().split():
        if w in _PREP:
            break
        out.append(w)
    return " ".join(out[:2])


def sentences(text: str) -> list[str]:
    body = "\n".join(x for x in str(text or "").splitlines() if not x.lstrip().startswith("#"))
    return [s.strip() for s in _SENT.findall(body) if s.strip() and s.strip() != "***"]


def _first(name: str) -> str:
    w = [x for x in re.split(r"\s+", str(name or "")) if x]
    return w[0] if w else ""


def mentions(sent: str, name: str) -> bool:
    """The sentence names this character (full name or first name, whole words)."""
    if not name:
        return False
    for n in {name, _first(name)}:
        if len(n) >= 3 and re.search(r"(?<![\w])" + re.escape(n) + r"(?![\w])", sent):
            return True
    return False


def found_names(text: str, known: list[str] | None = None) -> list[str]:
    """Proper names in a text: capitalised words that are not the first word of a sentence (or appear more than
    once), multi-word names first."""
    counts: dict[str, int] = {}
    mid: set[str] = set()
    for s in sentences(text):
        for m in CAP_NAME.finditer(s):
            words = m.group(0).split()
            lead = 0
            while words and words[0] in STOP:  # "The Old Light" -> "Old Light"; "She" -> nothing
                words.pop(0)
                lead += 1
            while words and words[-1] in ("of", "the"):
                words.pop()
            if not words:
                continue
            tok = re.sub(r"['’]s$", "", " ".join(words))
            if len(tok) < 3 or tok in STOP:
                continue
            counts[tok] = counts.get(tok, 0) + 1
            # not the sentence's first word, or a name of two capitalised words ("Bram Hollis rowed…")
            if m.start() > 0 or lead or len([w for w in words if w[:1].isupper()]) >= 2:
                mid.add(tok)
    out = [t for t in counts if t in mid or counts[t] > 1]
    known_l = {k.lower() for k in known or []}
    out.sort(key=lambda t: (-len(t.split()), t.lower() not in known_l))
    return out[:60]


def _to_days(n: str, unit: str) -> float | None:
    k = n.lower()
    v = NUM_WORDS.get(k)
    if v is None:
        try:
            v = float(n)
        except ValueError:
            return None
    u = unit.lower().rstrip("s")
    return v * {"hour": 1 / 24, "day": 1, "night": 1, "week": 7, "month": 30, "year": 365}.get(u, 1)


def days_of(words: str) -> float | None:
    """Days in a plain phrase ("three days", "the next morning", "a week later"); None when it says nothing."""
    w = str(words or "").lower()
    if not w.strip():
        return None
    if re.search(r"\b(same (?:day|night)|that (?:night|evening|afternoon)|minutes?|an hour|hours? later|moments?)\b",
                 w):
        return 0.2
    if re.search(r"\b(next (?:morning|day|evening|night)|following (?:day|morning)|overnight|dawn|a night)\b", w):
        return 1
    if re.search(r"\b(following week)\b", w):
        return 7
    m = re.search(NUM + r"\s+(hours?|days?|nights?|weeks?|months?|years?)", w)
    if m:
        return _to_days(m.group(1), m.group(2))
    m = re.search(r"\b(a|one)\s+(hour|day|night|week|month|year)\b", w)
    if m:
        return _to_days("one", m.group(2))
    return None


def season_of(text: str) -> str:
    """The season a chapter's words point to (the last one mentioned), or ''."""
    best, pos = "", -1
    low = str(text or "").lower()
    for season, words in SEASONS.items():
        for w in words:
            for m in re.finditer(r"\b" + re.escape(w) + r"\w*", low):
                if m.start() > pos:
                    best, pos = season, m.start()
    return best


def extract(text: str, known_people: list[str] | None = None) -> dict:
    """Akọwe's own keyword reading of one chapter (English only): the weak ledger when no AI could read it."""
    sents = sentences(text)
    people_names = list(dict.fromkeys([p for p in known_people or [] if p]))
    names = found_names(text, people_names)
    out = {"summary": [s[:TEXT_MAX] for s in sents[:1] + ([sents[-1]] if len(sents) > 1 else [])],
           "people": [], "names": [{"name": n, "kind": "person" if any(n == p or n == _first(p) for p in people_names)
                                    else "thing"} for n in names][:40],
           "time": {"day": "", "date": "", "season": season_of(text), "since_previous": ""},
           "trips": [], "knowledge": [], "relationships": [], "numbers": []}
    m = SINCE_RE.search(" ".join(sents[:4]))
    if m:
        out["time"]["since_previous"] = _clip(m.group(0), 60)
    dm = DAY_RE.findall(text or "")
    if dm:
        out["time"]["day"] = f"day {dm[-1]}"
    for s in sents:
        for tm in TRIP_RE.finditer(s):
            out["trips"].append({"from": _clip(tm.group("a") or "", 80), "to": _clip(tm.group("b"), 80),
                                 "takes": f"{tm.group(1)} {tm.group(2)}"})
        for mm in MONEY_RE.finditer(s):
            out["numbers"].append({"what": (mm.group(2) or "").strip().lower() + " " + mm.group(3).lower().rstrip("s"),
                                   "value": mm.group(1), "kind": "money"})
        for dm2 in DIST_RE.finditer(s):
            out["numbers"].append({"what": f"distance in {dm2.group(2).lower()}", "value": dm2.group(1),
                                   "kind": "distance"})
    out["trips"] = out["trips"][:6]
    out["numbers"] = out["numbers"][:12]
    candidates = people_names + [n for n in names if n not in people_names]
    for name in candidates:
        mine = [s for s in sents if mentions(s, name)]
        if not mine:
            continue
        p = {"name": name, "status": "", "where": "", "injuries": [], "items_gained": [], "items_lost": [],
             "carrying": [], "magic_cost": ""}
        for i, s in enumerate(sents):
            # a sentence about the character: it names them, or follows one that does and starts with a pronoun
            about = mentions(s, name) or (i > 0 and mentions(sents[i - 1], name)
                                          and re.match(r"\s*(She|He|They)\b", s) is not None)
            if not about:
                continue
            im = INJURY_RE.search(s)
            if im:
                p["injuries"].append({"what": _clip(im.group(0), 80), "status": "new"})
            if HEALED_RE.search(s) and p["injuries"]:
                p["injuries"][-1]["status"] = "healed"
            elif HEALED_RE.search(s):
                p["injuries"].append({"what": _clip(HEALED_RE.search(s).group(0), 80), "status": "healed"})
            for lm in LOST_RE.finditer(s):
                p["items_lost"].append(_item_phrase(lm.group(1)))
            for gm in GAINED_RE.finditer(s):
                p["items_gained"].append(_item_phrase(gm.group(1)))
            if DEAD_RE.search(s) and mentions(s, name):
                p["status"] = "dead"
            mc = MAGIC_COST_RE.search(s)
            if mc:
                p["magic_cost"] = _clip(mc.group(0), 80)
            for lr in LEARN_RE.finditer(s):
                if mentions(s, name):
                    out["knowledge"].append({"who": name, "what": _clip(lr.group(2)), "how": "learns"})
            for sr in SURPRISE_RE.finditer(s):
                if mentions(s, name) and sr.group(1).strip():
                    out["knowledge"].append({"who": name, "what": _clip(sr.group(1)), "how": "surprised"})
        p["items_lost"] = _strs(p["items_lost"])
        p["items_gained"] = _strs(p["items_gained"])
        p["injuries"] = p["injuries"][:8]
        if any(p[k] for k in ("status", "injuries", "items_gained", "items_lost", "magic_cost")) or \
                name in people_names:
            out["people"].append(p)
    out["people"] = out["people"][:LIST_MAX]
    out["knowledge"] = out["knowledge"][:12]
    return out


# ====================================================================== storage
def _key(pid: str, branch: str) -> str:
    return KEY.format(pid=pid, branch=branch)


def get_all(store, pid: str, branch: str) -> dict:
    try:
        cur = store.get_setting(_key(pid, branch))
    except Exception:  # noqa: BLE001
        log.exception("could not read the story ledger")
        cur = None
    cur = copy.deepcopy(cur) if isinstance(cur, dict) else {}
    cur.setdefault("chapters", {})
    return cur


def get_chapter(store, pid: str, branch: str, cid: str) -> dict | None:
    e = get_all(store, pid, branch)["chapters"].get(cid)
    return e if isinstance(e, dict) else None


def save_chapter(store, pid: str, branch: str, chapter: dict, story: dict, *, made_by: str, slot: str | None = None,
                 weak: bool = False, weak_why: str | None = None, flags: list | None = None) -> dict:
    cid = chapter["chapter_id"]
    text = str(chapter.get("text") or "")
    with _LOCK:
        with store.transaction():
            cur = get_all(store, pid, branch)
            old = cur["chapters"].get(cid) or {}
            e = dict(story, chapter_id=cid, number=chapter.get("number"), record_id=chapter.get("record_id"),
                     text_version=chapter.get("version"), end=_tail(text, END_CHARS),
                     made_by={"kind": made_by, "slot": slot, "at": _now()}, weak=bool(weak),
                     weak_why=weak_why if weak else None, flags=list(flags or []),
                     version=int(old.get("version") or 0) + 1, updated_at=_now())
            cur["chapters"][cid] = e
            cur["version"] = int(cur.get("version") or 0) + 1
            store.set_setting(_key(pid, branch), cur)
    return copy.deepcopy(e)


def _tail(text: str, n: int) -> str:
    text = str(text or "").strip()
    if len(text) <= n:
        return text
    cut = text[-n:]
    sp = cut.find(" ")
    return cut[sp + 1:] if 0 <= sp < 80 else cut


def ordered(store, pid: str, branch: str, order: list[str], *, set_aside: bool = False) -> list[dict]:
    """The ledger entries in book order. An entry set aside by a hand edit (``invalidate_from``) is left out unless
    ``set_aside``: what was read from an old text never reaches a writer, reviewer or checkpoint."""
    allc = get_all(store, pid, branch)["chapters"]
    out = []
    for i, cid in enumerate(order):
        e = allc.get(cid)
        if isinstance(e, dict) and (set_aside or not e.get("set_aside")):
            out.append(dict(e, number=e.get("number") or i + 1))
    return out


def weak_chapters(store, pid: str, branch: str, order: list[str], *, why=("busy", "changed")) -> list[str]:
    """Chapters to read again: a weak reading (no AI was free) or an entry set aside by a hand edit ("changed")."""
    return [e["chapter_id"] for e in ordered(store, pid, branch, order, set_aside=True) if e.get("weak")
            and (why is None or e.get("weak_why") in why)]


def invalidate_from(store, pid: str, branch: str, chapter_id: str, number: int | None) -> list[str]:
    """H5 hook (continuity.INVALIDATE_HOOKS): chapter ``chapter_id`` (number ``number``) changed by hand. Its ledger
    entry and those of every later chapter (they were read on top of the old text) are set aside — out of the story
    so far, the ledger brief and the checks — and marked to be read again (``weak_why`` "changed": retrack_weak, before
    the next chapter is tracked and at every 🧭 checkpoint). A new reading replaces the entry. Returns the chapter
    ids set aside. Never raises."""
    out: list[str] = []
    try:
        with _LOCK:
            with store.transaction():
                cur = get_all(store, pid, branch)
                me = cur["chapters"].get(chapter_id) or {}
                n = number if isinstance(number, int) else me.get("number")
                for cid, e in cur["chapters"].items():
                    if not isinstance(e, dict) or e.get("set_aside"):
                        continue
                    if cid != chapter_id and not (isinstance(n, int) and isinstance(e.get("number"), int)
                                                  and e["number"] > n):
                        continue
                    e["set_aside"] = {"because": chapter_id, "because_number": n, "at": _now(),
                                      "was_weak": e.get("weak_why") if e.get("weak") else None}
                    e["weak"], e["weak_why"] = True, "changed"
                    out.append(cid)
                if out:
                    cur["version"] = int(cur.get("version") or 0) + 1
                    store.set_setting(_key(pid, branch), cur)
    except Exception:  # noqa: BLE001
        log.exception("could not set the story ledger aside")
    return out


# ====================================================================== the state before a chapter
def _norm(s: str) -> str:
    return " ".join(re.sub(r"[^\w\s]", " ", str(s or "").lower()).split())


def _item_key(s: str) -> str:
    """The head noun of an item ("her old knife" -> "knife")."""
    w = [x for x in _norm(s).split() if x not in ("the", "a", "an", "his", "her", "their", "its", "my", "old", "new")]
    return w[-1] if w else ""


def _same_name(a: str, b: str) -> bool:
    a, b = _norm(a), _norm(b)
    return bool(a) and bool(b) and (a == b or a.split()[0] == b.split()[0] and min(len(a.split()), len(b.split())) == 1)


def state_before(entries: list[dict]) -> dict:
    """Everything the ledger knows at the end of ``entries`` (book order)."""
    people: dict[str, dict] = {}
    names: dict[str, dict] = {}
    travel: dict[tuple, dict] = {}
    knows: dict[str, list] = {}
    rel: dict[tuple, dict] = {}
    nums: dict[str, dict] = {}
    time = {"day": "", "date": "", "season": "", "elapsed_days": 0.0, "chapter": None, "season_since": 0.0}
    for e in entries:
        n = e.get("number")
        t = e.get("time") or {}
        d = days_of(t.get("since_previous"))
        time["elapsed_days"] += d if d is not None else 0
        for k in ("day", "date"):
            if t.get(k):
                time[k] = t[k]
        if t.get("season"):
            s = _norm(t["season"]).split()[0] if _norm(t["season"]) else ""
            if s and s != time["season"]:
                time["season"], time["season_since"] = s, time["elapsed_days"]
                time["season_chapter"] = n
        time["chapter"] = n
        for p in e.get("people") or []:
            key = next((k for k in people if _same_name(k, p["name"])), p["name"])
            cur = people.setdefault(key, {"name": key, "status": "alive", "where": "", "injuries": {}, "carrying": [],
                                          "lost": {}, "magic_cost": "", "chapter": n})
            cur["chapter"] = n
            if p.get("status"):
                cur["status"] = p["status"]
                if p["status"] == "dead":
                    cur["died_in"] = cur.get("died_in") or n
            if p.get("where"):
                cur["where"] = p["where"]
            for inj in p.get("injuries") or []:
                ik = _norm(inj["what"])[:60]
                if inj["status"] == "healed":
                    hw = set(ik.split()) | ({"leg"} if LEG_RE.search(ik) else set())
                    keep = {k: v for k, v in cur["injuries"].items()
                            if not (set(k.split()) | ({"leg"} if LEG_RE.search(k) else set())) & hw}
                    cur["injuries"] = keep if len(keep) < len(cur["injuries"]) else {}
                else:
                    cur["injuries"][ik] = {"what": inj["what"], "status": inj["status"], "since_chapter":
                                           (cur["injuries"].get(ik) or {}).get("since_chapter") or n,
                                           "since_day": (cur["injuries"].get(ik) or {}).get("since_day",
                                                                                           time["elapsed_days"])}
            for it in p.get("items_lost") or []:
                cur["lost"][_item_key(it)] = {"what": it, "chapter": n}
                cur["carrying"] = [c for c in cur["carrying"] if _item_key(c) != _item_key(it)]
            for it in p.get("items_gained") or []:
                cur["lost"].pop(_item_key(it), None)
                if _item_key(it) not in [_item_key(c) for c in cur["carrying"]]:
                    cur["carrying"].append(it)
            if p.get("carrying"):
                cur["carrying"] = list(p["carrying"])
                for it in p["carrying"]:
                    cur["lost"].pop(_item_key(it), None)
            cur["magic_cost"] = p.get("magic_cost") or ""
            cur["magic_chapter"] = n if p.get("magic_cost") else cur.get("magic_chapter")
        for nm in e.get("names") or []:
            names.setdefault(nm["name"].lower(), {"name": nm["name"], "kind": nm.get("kind") or "thing", "chapter": n})
        for tr in e.get("trips") or []:
            k = tuple(sorted([_norm(tr.get("from")), _norm(tr.get("to"))]))
            if k not in travel and days_of(tr.get("takes")) is not None:
                travel[k] = {"from": tr.get("from"), "to": tr.get("to"), "takes": tr["takes"], "chapter": n,
                             "days": days_of(tr["takes"])}
        for kn in e.get("knowledge") or []:
            knows.setdefault(kn["who"], []).append({"what": kn["what"], "chapter": n, "how": kn.get("how")})
        for r in e.get("relationships") or []:
            rel[tuple(sorted([r["a"], r["b"]]))] = {"a": r["a"], "b": r["b"], "line": r["line"], "chapter": n}
        for x in e.get("numbers") or []:
            nums[_norm(x["what"])] = {"what": x["what"], "value": x["value"], "kind": x.get("kind"), "chapter": n}
    return {"people": people, "names": names, "travel": travel, "knows": knows, "relationships": rel,
            "numbers": nums, "time": time, "after_chapter": entries[-1].get("number") if entries else None}


# ====================================================================== the checks
def _words(s: str) -> set[str]:
    return {w for w in _norm(s).split() if len(w) > 3 and w not in ("that", "this", "with", "from", "they", "were",
                                                                     "there", "their", "about", "what", "when")}


# 🔢 the running-notes code (code_map.py "N…") of the note each flag is about
FLAG_FIELDS = {"INJURY_IGNORED": "N1a", "IN_CHAPTER_STATE": "N1a", "LOST_ITEM_BACK": "N2c", "DEAD_ACTS": "N3a", "NAME_SPELLING": "N8a",
               "TRAVEL_TOO_FAST": "N6e", "SEASON_JUMP": "N6c", "DAY_BACKWARDS": "N6a", "ALREADY_KNEW": "N4a",
               "NUMBER_CHANGED": "N77"}


def _flag(code: str, e: dict, name: str, message: str, quote: str = "", fix: tuple | None = None) -> dict:
    fc = FLAG_FIELDS.get(code)
    out = {"code": code, "chapter_id": e.get("chapter_id"), "number": e.get("number"), "name": name,
           "message": f"{message} ({fc})" if fc else message, "field_code": fc,
           "quote": _clip(quote, 300), "severity": "major" if code in (
               "INJURY_IGNORED", "LOST_ITEM_BACK", "DEAD_ACTS", "ALREADY_KNEW", "TRAVEL_TOO_FAST") else "minor"}
    if fix:
        out["original"], out["replacement"] = fix
    return out


def _dist1(a: str, b: str) -> bool:
    if a == b or abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        return sum(1 for x, y in zip(a, b) if x != y) == 1
    if len(a) > len(b):
        a, b = b, a
    return any(b[:i] + b[i + 1:] == a for i in range(len(b)))


# ====================================================================== 🦵 PR #117 (B): physical state INSIDE one chapter
_PART = r"(?:ankle|leg|knee|kneecap|foot|feet|hip|thigh|shin|arm|wrist|hand|shoulder|ribs?|elbow)"
_LEGS = {"ankle", "leg", "knee", "kneecap", "foot", "feet", "hip", "thigh", "shin"}
HURT_IN_RE = re.compile(
    r"\b(?:crack\w*|bang\w*|bash\w*|smash\w*|bruis\w*|twist\w*|wrench\w*|sprain\w*|broke|broken|hurt|injur\w*|"
    r"wound\w*|gash\w*|cut|split|slash\w*|scrap\w*|tore|torn|burn\w*|stabb\w*|dislocat\w*|jarr\w*|struck|hit)\s+"
    r"(?:his|her|their|my|your|an?|the)\s+(?:left\s+|right\s+|bad\s+)?(" + _PART + r")\b"
    r"|\b(?:his|her|their|my)\s+(?:left\s+|right\s+)?(" + _PART + r")\s+(?:cracked|buckled|gave way|gave out|twisted|"
    r"snapped|broke|was broken|was bleeding|bled|split open|was cut|swelled)", re.I)
LEG_ACT_RE = re.compile(
    r"\b(ran|run|runs|running|sprint\w*|raced|dash\w*|leap\w*|leapt|jump\w*|climb\w*|clamber\w*|descend\w*|"
    r"kn(?:elt|eel\w*)|crouch\w*|squat\w*|kick\w*|bounded|vault\w*|stairs two at a time|"
    r"(?:went|came|hurried|walked|stepped|took|jogged|started)\s+(?:back\s+)?(?:down|up)\s+(?:the\s+)?(?:stairs|steps|"
    r"ladder|stair)|took the (?:stairs|steps))\b", re.I)
ARM_ACT_RE = re.compile(r"\b(climb\w*|haul\w*|lift\w*|heav\w*|hoist\w*|swung|swing\w*|punch\w*|threw|throw\w*|"
                        r"carried|carry\w*|gripp\w*|wrench\w* open|pulled (?:herself|himself|themselves) up)\b", re.I)
ACK_RE = re.compile(r"\b(limp\w*|winc\w*|hobbl\w*|favou?r\w*|pain\w*|ache\w*|aching|throb\w*|sore|hurt\w*|stiff\w*|"
                    r"gingerly|bandag\w*|injur\w*|wound\w*|bruis\w*|swollen|sting\w*|lame|careful of|bad " + _PART +
                    r"|" + _PART + r")\b", re.I)
_STARTERS = {"Later", "Then", "Soon", "Afterwards", "Afterward", "Meanwhile", "Outside", "Downstairs", "Upstairs",
             "Below", "Above", "Again", "Finally", "Slowly", "Quickly", "Carefully", "Somewhere", "Tonight", "Today",
             "Yesterday", "Tomorrow", "Morning", "Evening", "When", "While", "Because", "Though", "Although", "If",
             "Without", "With", "Into", "Onto", "From", "Back", "Instead", "Still", "Yet", "And", "But", "So"}
_PRONOUN = re.compile(r"\b(he|she|they|I)\b")


def in_chapter(text: str, names=(), chapter_id: str | None = None, number: int | None = None) -> list[dict]:
    """Akọwe's own reading (no AI) of ONE chapter: a character hurt early in the chapter (a cracked knee, a cut hand)
    who later in the SAME chapter runs, climbs, takes the stairs or kneels — or hauls and lifts with the hurt arm —
    with no sign of it (no limp, wince, pain, or the body part named again in between). Each is a major flag
    (``IN_CHAPTER_STATE``) for the reviewers and the checkpoints: a physical change inside a chapter must persist.
    English only; it catches the clear case, not every one."""
    out: list[dict] = []
    try:
        sents = sentences(text)
        known = [n for n in (names or []) if isinstance(n, str) and n.strip()]
        last_named = None
        hurt: dict[str, dict] = {}
        for i, s in enumerate(sents):
            here = [n for n in known if mentions(s, n)]
            if not here and not known:  # no cast given: a capitalised word that is not a common one
                here = [m.group(0) for m in re.finditer(r"\b[A-Z][a-z]{2,}\b", s) if m.group(0) not in STOP
                        and m.group(0) not in _STARTERS][:1]
            pron = bool(_PRONOUN.search(s))
            who = here[0] if here else (last_named if pron else None)
            m = HURT_IN_RE.search(s)
            if m and who and who not in hurt:
                part = (m.group(1) or m.group(2) or "").lower()
                hurt[who] = {"part": part, "legs": part in _LEGS, "quote": s, "acked": False, "at": i}
            else:
                for name, h in list(hurt.items()):
                    if h.get("done"):
                        continue
                    about = (who == name) or any(_same_name(name, x) for x in here)
                    if not about:
                        continue
                    if HEALED_RE.search(s):
                        h["done"] = True
                        continue
                    act = (LEG_ACT_RE if h["legs"] else ARM_ACT_RE).search(s)
                    if ACK_RE.search(s):
                        h["acked"] = True
                        continue
                    if act and not h["acked"]:
                        h["done"] = True
                        out.append({"code": "IN_CHAPTER_STATE", "chapter_id": chapter_id, "number": number,
                                    "name": name, "field_code": FLAG_FIELDS["IN_CHAPTER_STATE"], "severity": "major",
                                    "quote": _clip(s, 300),
                                    "message": f"{name} {FLAG_WORDS['IN_CHAPTER_STATE']}: hurt their {h['part']} "
                                               f"(“{_clip(h['quote'], 120)}”), then “{act.group(0)}” with no sign of "
                                               "it"})
            if here:
                last_named = here[-1]
    except Exception:  # noqa: BLE001 - a hint, never a reason to fail a check
        return out
    return out


def check(before: list[dict], entry: dict, text: str) -> list[dict]:
    """Contradictions between this chapter (its ledger entry and its text) and everything before it."""
    out: list[dict] = []
    try:
        st = state_before(before)
        sents = sentences(text)
        n = entry.get("number")
        here = {p["name"]: p for p in entry.get("people") or []}
        t = entry.get("time") or {}
        gap = days_of(t.get("since_previous"))
        for key, p in st["people"].items():
            cur_here = next((v for k, v in here.items() if _same_name(k, key)), {})
            healed_here = any(i.get("status") == "healed" for i in cur_here.get("injuries") or [])
            # 🦵 a leg injury, then running with no time to heal
            legs = [i for i in p["injuries"].values() if LEG_RE.search(i["what"])]
            if legs and not healed_here and (gap is None or gap < 14):
                for s in sents:
                    if mentions(s, key) and RUN_RE.search(s) and not LEG_RE.search(s) and not HEALED_RE.search(s):
                        rm = RUN_RE.search(s)
                        out.append(_flag("INJURY_IGNORED", entry, key, f"{key} {FLAG_WORDS['INJURY_IGNORED']} "
                                         f"(“{legs[0]['what']}” in chapter {legs[0]['since_chapter']})", s,
                                         (s, s[:rm.start()] + "limped" + s[rm.end():]) if rm.group(0).lower() in
                                         ("ran", "raced", "dashed", "sprinted") else None))
                        break
            # 🗡 a lost item used again
            gained_here = {_item_key(x) for x in (cur_here.get("items_gained") or []) + (cur_here.get("carrying") or [])}
            for ik, lost in p["lost"].items():
                if not ik or ik in gained_here:
                    continue
                for s in sents:
                    low = s.lower()
                    if re.search(r"\b" + re.escape(ik) + r"s?\b", low) and USE_RE.search(s) and (
                            mentions(s, key) or re.search(r"\b(his|her|their)\s+(?:\w+\s+)?" + re.escape(ik), low)) \
                            and not re.search(r"\b(lost|no longer|without|missing|gone|empty)\b", low):
                        out.append(_flag("LOST_ITEM_BACK", entry, key, f"{key} {FLAG_WORDS['LOST_ITEM_BACK']} "
                                         f"(“{lost['what']}”, lost in chapter {lost['chapter']})", s))
                        break
            # ⚰ the dead speak or act
            if p["status"] == "dead":
                for s in sents:
                    if mentions(s, key) and SPEAK_RE.search(s) and not MEMORY_RE.search(s):
                        out.append(_flag("DEAD_ACTS", entry, key, f"{key} {FLAG_WORDS['DEAD_ACTS']} (chapter "
                                         f"{p.get('died_in')})", s))
                        break
        # 🔤 near-miss spellings of known names
        known = [v["name"] for v in st["names"].values()] + list(st["people"])
        tokens_known = {w for k in known for w in re.findall(r"[A-Z][\w'’]+", k)}
        squashed = {re.sub(r"\s+", "", k).lower(): k for k in known if " " in k}
        flagged = set()
        for s in sents:
            for m in re.finditer(r"\b[A-Z][a-zà-ÿ'’]{3,}\b", s):
                tok = m.group(0)
                if tok in tokens_known or tok in STOP or tok in flagged:
                    continue
                want = next((w for w in sorted(tokens_known) if len(w) >= 4 and w[0] == tok[0] and _dist1(tok, w)
                             and tok.lower() not in (x.lower() for x in tokens_known)), None)
                if want and not any(tok in other for other in known):
                    flagged.add(tok)
                    out.append(_flag("NAME_SPELLING", entry, want, f"“{tok}” {FLAG_WORDS['NAME_SPELLING']} "
                                     f"(“{want}”)", s, (s, s.replace(tok, want))))
            for sq, full in squashed.items():
                for m in re.finditer(r"\b[A-Z][a-z]{5,}\b", s):
                    if m.group(0).lower() == sq and m.group(0) not in flagged:
                        flagged.add(m.group(0))
                        out.append(_flag("NAME_SPELLING", entry, full, f"“{m.group(0)}” "
                                         f"{FLAG_WORDS['NAME_SPELLING']} (“{full}”)", s,
                                         (s, s.replace(m.group(0), full))))
        for nm in entry.get("names") or []:
            sq = re.sub(r"\s+", "", nm["name"]).lower()
            for k in known:
                if k != nm["name"] and re.sub(r"\s+", "", k).lower() == sq and nm["name"] not in flagged:
                    flagged.add(nm["name"])
                    q = next((s for s in sents if nm["name"] in s), "")
                    out.append(_flag("NAME_SPELLING", entry, k, f"“{nm['name']}” {FLAG_WORDS['NAME_SPELLING']} "
                                     f"(“{k}”)", q, (q, q.replace(nm["name"], k)) if q else None))
        # 🐎 travel faster than the table
        for tr in entry.get("trips") or []:
            k = tuple(sorted([_norm(tr.get("from")), _norm(tr.get("to"))]))
            known_t = st["travel"].get(k) or next((v for kk, v in st["travel"].items()
                                                   if _norm(tr.get("to")) and _norm(tr.get("to")) in kk), None)
            got = days_of(tr.get("takes"))
            if known_t and got is not None and known_t["days"] and got < known_t["days"] / 2:
                out.append(_flag("TRAVEL_TOO_FAST", entry, tr.get("to") or "", f"{tr.get('from') or '?'} → "
                                 f"{tr.get('to')}: “{tr['takes']}” here, but chapter {known_t['chapter']} says it "
                                 f"takes {known_t['takes']}", next((s for s in sents if (tr.get("to") or "~~") in s), "")))
        if gap is not None and st["travel"] and (entry.get("people") or []):
            for p in entry.get("people") or []:
                prev = next((v for k, v in st["people"].items() if _same_name(k, p["name"])), None)
                if not prev or not prev.get("where") or not p.get("where"):
                    continue
                k = tuple(sorted([_norm(prev["where"]), _norm(p["where"])]))
                tt = next((v for kk, v in st["travel"].items() if kk == k or (k[0] in kk and k[1] in kk)), None)
                if tt and tt["days"] and gap < tt["days"] / 2 and k[0] != k[1]:
                    out.append(_flag("TRAVEL_TOO_FAST", entry, p["name"], f"{p['name']} goes from {prev['where']} to "
                                     f"{p['where']} in {t.get('since_previous')}, but chapter {tt['chapter']} says the "
                                     f"journey takes {tt['takes']}", next((s for s in sents if mentions(s, p["name"])),
                                                                          "")))
        # ❄️🌸 seasons and days
        ts = st["time"]
        new_season = _norm(t.get("season")).split()[0] if _norm(t.get("season")) else ""
        if ts.get("season") and new_season and new_season in SEASON_ORDER and ts["season"] in SEASON_ORDER and \
                new_season != ts["season"]:
            elapsed = ts["elapsed_days"] - ts.get("season_since", 0) + (gap or 0)
            steps = (SEASON_ORDER.index(new_season) - SEASON_ORDER.index(ts["season"])) % 4
            if elapsed < 21 * steps:
                out.append(_flag("SEASON_JUMP", entry, "", f"{ts['season']} (chapter {ts.get('season_chapter')}) → "
                                 f"{new_season} after about {max(1, round(elapsed))} day(s): "
                                 f"{FLAG_WORDS['SEASON_JUMP']}", next((s for s in sents if season_of(s) == new_season),
                                                                      "")))
        dm = re.search(r"\d+", t.get("day") or "")
        pm = re.search(r"\d+", ts.get("day") or "")
        if dm and pm and int(dm.group(0)) < int(pm.group(0)) and not re.search(r"\b(flashback|remember\w*|years? "
                                                                                  r"(?:ago|before|earlier))\b",
                                                                                  text or "", re.I):
            out.append(_flag("DAY_BACKWARDS", entry, "", f"day {dm.group(0)} after day {pm.group(0)}: "
                             f"{FLAG_WORDS['DAY_BACKWARDS']}"))
        # 🤫 surprised by what they already know
        for kn in entry.get("knowledge") or []:
            for who, items in st["knows"].items():
                if not _same_name(who, kn["who"]):
                    continue
                w = _words(kn["what"])
                for it in items:
                    iw = _words(it["what"])
                    if w and iw and len(w & iw) >= max(1, min(len(w), len(iw)) // 2):
                        out.append(_flag("ALREADY_KNEW", entry, kn["who"], f"{kn['who']} "
                                         f"{FLAG_WORDS['ALREADY_KNEW']}: “{it['what']}” (chapter {it['chapter']})",
                                         next((s for s in sents if mentions(s, kn["who"]) and _words(s) & w), "")))
                        break
        # 🔢 distances and prices that changed
        for x in entry.get("numbers") or []:
            old = st["numbers"].get(_norm(x["what"]))
            if old and x.get("kind") in ("distance", "price") and _norm(old["value"]) != _norm(x["value"]):
                out.append(_flag("NUMBER_CHANGED", entry, x["what"], f"{x['what']}: {old['value']} (chapter "
                                 f"{old['chapter']}) → {x['value']} — {FLAG_WORDS['NUMBER_CHANGED']}"))
    except Exception:  # noqa: BLE001 - a check is help, never a reason to fail
        log.exception("story ledger check failed")
    seen, uniq = set(), []
    for f in out:
        k = (f["code"], f["name"], f["quote"])
        if k not in seen:
            seen.add(k)
            uniq.append(f)
    return uniq


# ====================================================================== the brief (writer, reviewer, editor)
LEDGER_WORDS = {"people": "characters' state", "names": "names", "travel": "travel times",
                "who_knows": "who knows what", "relationships": "relationships", "numbers": "money, prices and "
                "distances"}


def _person_line(p: dict, n_next: int | None) -> str:
    bits = []
    if p.get("status") == "dead":
        bits.append(f"DEAD (chapter {p.get('died_in')})")
    for i in p.get("injuries", {}).values():
        bits.append(f"hurt: {i['what']} ({i['status']}, since chapter {i['since_chapter']})")
    if p.get("carrying"):
        bits.append("carrying: " + ", ".join(p["carrying"][:6]))
    if p.get("lost"):
        bits.append("lost: " + ", ".join(f"{v['what']} (chapter {v['chapter']})" for v in list(p["lost"].values())[:6]))
    if p.get("where"):
        bits.append(f"at: {p['where']}")
    if p.get("magic_cost") and (n_next is None or (p.get("magic_chapter") or 0) >= (n_next or 0) - 1):
        bits.append(f"still feels: {p['magic_cost']}")
    return f"{p['name']}: " + ("; ".join(bits) if bits else "no change tracked") + f" (as of chapter {p.get('chapter')})"


def so_far_budget(n_chapters: int) -> int:
    """PR #122: the story so far grows with the book (2 200 characters + 120 per chapter written, at most
    ``SO_FAR_MAX``): by chapter 45 it used to hold ~50 characters per chapter, and the long book lost its memory."""
    return min(SO_FAR_MAX, SO_FAR_BUDGET + SO_FAR_PER_CHAPTER * max(0, int(n_chapters or 0)))


def _span(nums: list) -> str:
    nums = [n for n in nums if isinstance(n, int)]
    if not nums:
        return "Chapters"
    return f"Chapters {min(nums)}–{max(nums)}" if min(nums) != max(nums) else f"Chapter {nums[0]}"


def _size(lines: list[str]) -> int:
    return len(json.dumps(lines, ensure_ascii=False))


def story_so_far(entries: list[dict], checkpoint_summaries: list[dict] | None = None,
                 budget: int | None = None, cut: list | None = None) -> list[str]:
    """The story so far, in tiers (PR #122), within ``budget`` characters (default: grows with the book,
    ``so_far_budget``):

    * the last ``FULL_RECENT`` chapters: every summary line (detailed);
    * the ``MID_RECENT`` chapters before them: their first line;
    * older chapters: a checkpoint's summary replaces the chapters it covers (one line per stretch / act, as the
      checkpoints run at act ends and every N chapters), the rest a short first line each.

    When it is still too long, the oldest tier is compressed step by step — shorter lines, then stretches of
    ``GROUP`` chapters merged into one line ("Chapters 6–10: … · … · …") — so EVERY chapter stays in the memory;
    only as the very last resort are the two oldest lines merged and cut. ``cut``: gets a plain line when the oldest
    chapters had to be shortened for space (H13)."""
    if not entries:
        return []
    budget = so_far_budget(len(entries)) if budget is None else budget
    recent = entries[-FULL_RECENT:]
    before = entries[:-FULL_RECENT]
    covered: set = set()
    old_rows: list[dict] = []   # {"nums": [...], "text": str, "stretch": bool}
    for cp in checkpoint_summaries or []:
        ids = set(cp.get("chapter_ids") or [])
        nums = [e.get("number") for e in before if e.get("chapter_id") in ids]
        if nums and cp.get("summary"):
            old_rows.append({"nums": nums, "text": " ".join(str(cp["summary"]).split()), "stretch": True})
            covered |= ids
    rest = [e for e in before if e.get("chapter_id") not in covered]
    mid = rest[-MID_RECENT:] if MID_RECENT else []
    older = rest[:len(rest) - len(mid)]
    for e in older:
        first = (e.get("summary") or [""])[0]
        if first:
            old_rows.append({"nums": [e.get("number")], "text": " ".join(str(first).split()), "stretch": False})
    old_rows.sort(key=lambda r: min([n for n in r["nums"] if isinstance(n, int)] or [0]))
    mid_lines = [f"Chapter {e.get('number')}: {_clip((e.get('summary') or [''])[0], 200)}"
                 for e in mid if (e.get("summary") or [""])[0]]
    recent_lines = [f"Chapter {e.get('number')}: " + " ".join(_clip(x, 200) for x in e.get("summary") or [])
                    for e in recent if e.get("summary")]

    def render(rows, old_n, stretch_n):
        return [f"{_span(r['nums'])}: {_clip(r['text'], stretch_n if r['stretch'] else old_n)}" for r in rows]

    def fits(rows, old_n, stretch_n):
        return _size(render(rows, old_n, stretch_n) + mid_lines + recent_lines) <= budget

    shortened = False
    rows, old_n, stretch_n = old_rows, 160, 400
    for o_n, s_n in ((160, 400), (110, 300), (80, 220)):
        old_n, stretch_n = o_n, s_n
        if fits(rows, old_n, stretch_n):
            break
        shortened = True
    while not fits(rows, old_n, stretch_n):
        # merge the oldest run of single chapters into one stretch line ("Chapters 1–5: a · b · c")
        singles = [i for i, r in enumerate(rows) if not r["stretch"]]
        if len(singles) < 2:
            break
        i = singles[0]
        j = i
        while j + 1 < len(rows) and not rows[j + 1]["stretch"] and j + 1 - i < GROUP:
            j += 1
        if j == i:
            rows[i] = dict(rows[i], stretch=True)
            continue
        grp = rows[i:j + 1]
        rows[i:j + 1] = [{"nums": [n for r in grp for n in r["nums"]], "stretch": True,
                          "text": " · ".join(_clip(r["text"], max(40, 220 // len(grp))) for r in grp)}]
        shortened = True
    lines = render(rows, old_n, stretch_n) + mid_lines + recent_lines
    if _size(lines) > budget:
        shortened = True
        mid_lines = [_clip(x, 120) for x in mid_lines]
        lines = render(rows, old_n, stretch_n) + mid_lines + recent_lines
    while lines and _size(lines) > budget:  # the last resort (a tiny budget): merge the two oldest lines
        if len(lines) > 2:
            a, b = lines[0], lines[1]
            lines[0:2] = [_clip(a, 120) + " … " + _clip(b.split(": ", 1)[-1], 100)]
            if len(lines[0]) <= 230 and len(lines) <= 2:
                break
        else:
            lines = [_clip(x, 300) for x in lines]
            break
    if cut is not None and shortened:
        cut.append("story so far: the oldest chapters' lines shortened to fit")
    return lines


def brief(store, pid: str, branch: str, order: list[str], chapter_id: str, present: list[str] | None = None,
          checkpoint_summaries: list[dict] | None = None, cut: list | None = None) -> dict:
    """The ledger part of one chapter's brief (writer, reviewer, editor). Never raises. ``cut``: a list that gets
    what was left out for space, in plain words (H13, brief_cuts.py)."""
    out: dict = {}
    try:
        idx = order.index(chapter_id) if chapter_id in order else len(order)
        entries = ordered(store, pid, branch, order[:idx])
        if not entries:
            return {}
        prev = entries[-1]
        if prev.get("end") and order[idx - 1:idx] == [prev.get("chapter_id")]:
            out["previous_chapter_end"] = prev["end"]
        so_far = story_so_far(entries, checkpoint_summaries, cut=cut)
        if so_far:
            out["story_so_far"] = so_far
        st = state_before(entries)
        n_next = (prev.get("number") or 0) + 1
        present = [p for p in present or [] if p]
        people = list(st["people"].values())
        rel_present = [p for p in people if any(_same_name(p["name"], x) or _first(p["name"]) == _first(x)
                                                for x in present)]
        rest = [p for p in people if p not in rel_present]
        led: dict = {}
        lines_present = [_person_line(p, n_next) for p in rel_present]
        lines_rest = [_person_line(p, n_next) for p in rest if p.get("status") == "dead" or p.get("injuries")
                      or p.get("lost")]
        if lines_present or lines_rest:
            led["people"] = lines_present + lines_rest
        if st["names"]:
            led["names"] = [f"{v['name']} ({v['kind']})" for v in st["names"].values()]
        ts = st["time"]
        tbits = [x for x in (ts.get("day"), ts.get("date"), ts.get("season")) if x]
        if tbits:
            led["time"] = f"End of chapter {ts.get('chapter')}: " + ", ".join(tbits) + \
                f" (about {round(ts['elapsed_days'])} day(s) since chapter 1)"
        if st["travel"]:
            led["travel"] = [f"{v['from'] or '?'} → {v['to']}: {v['takes']} (chapter {v['chapter']})"
                             for v in st["travel"].values()]
        kn = [(who, it) for who, items in st["knows"].items() for it in items]
        if kn:
            kn.sort(key=lambda x: 0 if any(_same_name(x[0], p) for p in present) else 1)
            led["who_knows"] = [f"{who} knows: {it['what']} (chapter {it['chapter']})" for who, it in kn]
        if st["relationships"]:
            rl = list(st["relationships"].values())
            rl.sort(key=lambda r: 0 if any(_same_name(r["a"], p) or _same_name(r["b"], p) for p in present) else 1)
            led["relationships"] = [f"{r['a']} – {r['b']}: {r['line']} (chapter {r['chapter']})" for r in rl]
        if st["numbers"]:
            led["numbers"] = [f"{v['what']}: {v['value']} (chapter {v['chapter']})" for v in st["numbers"].values()]
        # keep it bounded: cut the least relevant first (people not in this chapter, then old lists from the end)
        n_present = len(lines_present)
        dropped: dict = {}
        for key in ("numbers", "relationships", "who_knows", "travel", "names", "people"):
            while led.get(key) and len(json.dumps(led, ensure_ascii=False)) > LEDGER_BUDGET:
                if key == "people" and len(led["people"]) <= max(1, n_present):
                    break
                dropped.setdefault(key, []).append(led[key].pop())
                if not led[key]:
                    led.pop(key)
        while led.get("people") and len(json.dumps(led, ensure_ascii=False)) > LEDGER_BUDGET:
            dropped.setdefault("people", []).append(led["people"].pop())
            if not led["people"]:
                led.pop("people")
        n_cut = sum(len(v) for v in dropped.values())
        if cut is not None and dropped:
            from . import brief_cuts  # noqa: PLC0415
            for key in ("people", "names", "travel", "who_knows", "relationships", "numbers"):
                brief_cuts.note(cut, f"story ledger — {LEDGER_WORDS[key]}", list(reversed(dropped.get(key) or [])))
        if led:
            if n_cut:
                led["left_out"] = f"{n_cut} older or less relevant line(s) left out for space"
            out["story_ledger"] = led
        weak = [e.get("number") for e in entries if e.get("weak")]
        if weak:
            out["weak_reading"] = (f"Chapter(s) {', '.join(str(x) for x in weak[-6:])} were read without an AI "
                                   "(Akọwe's quick keyword reading): treat their ledger lines as rough.")
    except Exception:  # noqa: BLE001 - guidance, never a reason to fail a chapter
        log.exception("could not add the story ledger to the brief")
        return {}
    return out


# ====================================================================== the page and the book folder
def page_info(store, pid: str, branch: str, order: list[str]) -> dict:
    shown = ordered(store, pid, branch, order, set_aside=True)
    entries = [e for e in shown if not e.get("set_aside")]
    flags = [dict(f, chapter_id=e["chapter_id"]) for e in entries for f in e.get("flags") or []]
    st = state_before(entries)
    return {"chapters": [{k: e.get(k) for k in ("chapter_id", "number", "summary", "people", "names", "time", "trips",
                                                "knowledge", "relationships", "numbers", "weak", "weak_why", "made_by",
                                                "flags", "version", "set_aside")} for e in shown],
            "set_aside": [e.get("number") for e in shown if e.get("set_aside")],
            "flags": flags, "weak": [e.get("number") for e in entries if e.get("weak")],
            "weak_busy": [e.get("number") for e in entries if e.get("weak") and e.get("weak_why") == "busy"],
            "people": [_person_line(p, None) for p in st["people"].values()],
            "names": [v["name"] for v in st["names"].values()],
            "travel": [f"{v['from'] or '?'} → {v['to']}: {v['takes']}" for v in st["travel"].values()]}


def markdown(info: dict) -> list[str]:
    if not info.get("chapters"):
        return []
    out = ["## 📒 Story ledger", ""]
    for c in info["chapters"]:
        out.append(f"### Chapter {c['number']}" + ((" (⚠️ quick reading by Akọwe: no AI was free; it is read again "
                                                     "later)" if c.get("weak_why") == "busy" else
                                                     " (⚠️ set aside: chapter "
                                                     f"{(c.get('set_aside') or {}).get('because_number')} was changed "
                                                     "by hand; it is read again later)" if c.get("weak_why") == "changed"
                                                     else " (quick reading by Akọwe)") if c.get("weak") else ""))
        for s in c.get("summary") or []:
            out.append(f"- {s}")
        t = c.get("time") or {}
        tb = [f"{k.replace('_', ' ')}: {v}" for k, v in t.items() if v]
        if tb:
            out.append("- Time: " + "; ".join(tb))
        for f in c.get("flags") or []:
            out.append(f"- ⚠️ {f['message']}" + (f" — “{f['quote']}”" if f.get("quote") else ""))
        out.append("")
    if info.get("people"):
        out += ["### Where everyone stands now", ""] + [f"- {x}" for x in info["people"]] + [""]
    if info.get("names"):
        out += ["### Names in the book", "", ", ".join(info["names"]), ""]
    if info.get("travel"):
        out += ["### Travel times", ""] + [f"- {x}" for x in info["travel"]] + [""]
    return out
