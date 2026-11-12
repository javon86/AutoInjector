"""✨ Magic rules that are kept: structured abilities, a use ledger and a rule check per chapter (no extra AI).

The author asked: "if I add a magic system, the book must follow the rules of the system — teleportation could
require 2 anchor stones". The story-rules ledger (story_rules.py) already says what is law; this module makes the
rules of abilities, spells and devices ENFORCEABLE:

* **Structured rules** — a story rule may carry ``magic`` = {name, does, requires (lines such as "2 anchor stones",
  "line of sight", "at night only"), limits (lines such as "3 times a day", "cooldown 1 hour", "range: a mile"),
  price (the side effect / price paid), who (who can use it), exceptions (none by default), start (who holds what at
  the start, e.g. "Mara: 3 anchor stones"), words (the words that show a use; from the name when empty)}. The author
  types it in the Story rules form; the AI fills it in when it drafts the story rules (the existing step: no new
  call). An old free-text rule still works: ``parse_free`` reads "Teleportation requires two anchor stones; at most
  three times a day" into the same structure when it can (and leaves the rule alone when it cannot).
* **The use ledger** — per chapter, every use of an ability (who, what, the cost paid, where) and what people hold
  ("Mara found three anchor stones"): Akọwe's own reading of the text (``extract``), or — for an approved chapter —
  the uses the continuity tracker's AI already reported in its one call per chapter (``ability_uses``, no extra
  call). Costs are deducted; uses per day and the prices paid are counted. Shown on the Story rules page.
* **The rule check** — every use is checked against its rule: each quantified requirement present and paid (stated
  on the page or in the ledger), the time of day, uses per day, the cooldown inside a scene, who may use it. A broken
  rule is a MUST-FIX note for the editor and the reviewer before approval (like the clock / tide check), in plain
  words: "Mara uses Teleportation in chapter 3 with only one anchor stone; the rule needs 2." A rule-break the plan
  marks as a deliberate twist (the chapter's outline says "deliberate twist" / "breaks the rule" and names the
  ability, or the author lists it on the Story rules page) is allowed and counted as deliberate.
* **The writer's brief** — the rules of the abilities the chapter's plan mentions and the ledger before the chapter
  (bounded, ``BRIEF_BUDGET``).
* **The book report** — "✨ Magic rules kept: 7 uses, 0 broken".

Settings key ``magic:<project>:<branch>`` = {enabled (default on), allowed_breaks [{chapter, ability, why}],
tracked {chapter_id: {version, uses, gains}}, snapshot {at, chapters [{chapter_id, number, state_after, uses}]}}.
Switched off with ``enabled: false`` (Story rules page) or the pipeline's "rules" switch. Heuristic and English
only; it never edits text. Logs carry codes and counts only.
"""
from __future__ import annotations

import copy
import json
import logging
import re
import threading
from datetime import datetime, timezone

log = logging.getLogger("akowe.magic_rules")

FIELD_MAX = 300
LINE_MAX = 120
MAX_LINES = 8
MAX_ABILITIES = 12
MAX_PROBLEMS = 40
BRIEF_BUDGET = 1500      # characters of JSON for the magic part of one chapter brief
PAGE_USES = 60           # uses shown per page load
QUOTE_MAX = 200
_LOCK = threading.RLock()

FIELDS = (
    ("name", "Name", "What the ability, spell or device is called (e.g. “Teleportation”)."),
    ("does", "What it does", "One sentence: what happens when someone uses it."),
    ("requires", "What it needs (one per line)", "Each thing it needs, with a number when it is used up: “2 anchor "
                                                 "stones”, “line of sight”, “at night only”. Things with a number are "
                                                 "counted and taken from the ledger at every use."),
    ("limits", "Limits (one per line)", "How far, how often, how long between uses: “3 times a day”, “cooldown 1 "
                                        "hour”, “range: within a mile”."),
    ("price", "Side effect or price", "What using it costs the user (a nosebleed, a memory, a year of life)."),
    ("who", "Who can use it", "Names, or “anyone trained”. Leave empty when anyone can."),
    ("exceptions", "Exceptions", "Leave empty for none. Any exception the story uses must be written here."),
    ("start", "Who holds what at the start", "For counted things, e.g. “Mara: 3 anchor stones; Tom: 1 anchor "
                                             "stone”."),
    ("words", "Words that show a use", "Optional, comma-separated (e.g. “teleport, blink”). Empty: the name is used."),
)
FIELD_KEYS = tuple(k for k, _l, _h in FIELDS)


def field_list() -> list[dict]:
    return [{"key": k, "label": label, "help": hlp} for k, label, hlp in FIELDS]

_S = {"type": "string"}
AI_SCHEMA = {"type": "object", "additionalProperties": False,
             "required": ["name", "does", "requires", "limits", "price", "who", "exceptions", "start"],
             "properties": {"name": _S, "does": _S, "requires": {"type": "array", "items": _S, "maxItems": MAX_LINES},
                            "limits": {"type": "array", "items": _S, "maxItems": MAX_LINES}, "price": _S, "who": _S,
                            "exceptions": _S, "start": _S}}
AI_TASK = (" A rule about an ability, spell or magical device may carry magic: {name, does (one sentence), requires "
           "(each thing it needs as one short line, with a number and unit when it is used up, e.g. \"2 anchor "
           "stones\", \"line of sight\", \"at night only\"), limits (lines such as \"3 times a day\", \"cooldown 1 "
           "hour\", \"range: within a mile\"), price (the side effect the user pays), who (who can use it), "
           "exceptions (empty = none), start (who holds the counted things at the start, e.g. \"Mara: 3 anchor "
           "stones\")}. Fill it from the premise and the canon for every such ability; leave it out for other rules.")
TRACK_TASK = (" context.abilities lists the book's abilities, spells and devices: in ability_uses list EVERY use of "
              "one of them in this chapter (who, ability = its exact name, cost_paid such as \"2 anchor stones\", "
              "where, quote = the sentence word for word) and in ability_gains every time someone gets, finds, loses "
              "or is left with a counted thing (who, what such as \"3 anchor stones\", change gained | lost | has).")
TRACK_PROPS = {
    "ability_uses": {"type": "array", "maxItems": 20, "items": {
        "type": "object", "additionalProperties": False, "required": ["who", "ability", "cost_paid", "where", "quote"],
        "properties": {"who": _S, "ability": _S, "cost_paid": _S, "where": _S, "quote": _S}}},
    "ability_gains": {"type": "array", "maxItems": 20, "items": {
        "type": "object", "additionalProperties": False, "required": ["who", "what", "change"],
        "properties": {"who": _S, "what": _S, "change": {"type": "string", "enum": ["gained", "lost", "has"]}}}}}
WRITER_RULE = ("Magic rules (context.writing_brief.magic_rules): every use of an ability, spell or device follows its "
               "rule exactly — each thing it needs is there and paid (what is used up is gone afterwards: keep the "
               "counts in magic_rules.ledger), it stays inside its limits (range, uses per day, cooldown), its price "
               "is paid on the page, only those who may use it do, and there are no exceptions beyond the ones "
               "written. Never solve a problem by bending a rule.")
REVIEW_RULE = ("context.magic_rules gives the book's abilities with their requirements, limits and price, and the "
               "ledger before this chapter: a use that lacks a requirement, goes past a limit, skips the price or "
               "uses an unwritten exception is a major finding (quote the use and name the rule).")
CODES = {
    "needs_more": "Not enough of what it needs",
    "not_enough": "Not enough left in the ledger",
    "wrong_time": "Used at the wrong time",
    "too_many": "Used too often",
    "cooldown": "Used again too soon",
    "not_allowed": "Used by someone who cannot",
    "price_missing": "The price is not shown",
}

# ====================================================================== small text helpers
_NUMW = {"no": 0, "none": 0, "zero": 0, "a": 1, "an": 1, "one": 1, "single": 1, "lone": 1, "two": 2, "both": 2,
         "pair": 2, "couple": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
         "ten": 10, "eleven": 11, "twelve": 12, "once": 1, "twice": 2, "thrice": 3, "last": 1}
_NUM = r"(?:\d{1,3}|a pair of|a couple of|no|none|zero|an|a|one|single|lone|two|both|three|four|five|six|seven|" \
       r"eight|nine|ten|eleven|twelve|last)"
_WORDNUM = {v: k for k, v in _NUMW.items() if k in ("one", "two", "three", "four", "five", "six", "seven", "eight",
                                                     "nine", "ten", "eleven", "twelve")}
_WORDNUM[0] = "no"
SENT = re.compile(r"[^.!?…]+(?:[.!?…]+[\"'”’)]*|$)")
QUOTED = re.compile(r"[“\"][^”\"]{0,400}[”\"]")
SCENE_BREAK = re.compile(r"^\s*(?:\*\s*\*\s*\*|#{1,3}\s*$|-{3,}|~{3,}|•\s*•\s*•|§)\s*$", re.M)
NEXT_DAY = re.compile(r"\b(?:the next (?:morning|day|evening|night)|next morning|the following (?:morning|day|"
                      r"evening|night)|the morning after|the day after|days? later|a week later)\b", re.I)
TIME_SKIP = re.compile(r"\b(?:hours? later|an hour later|later that|after (?:an|a few|some|two|three) hours?|"
                       r"by (?:evening|nightfall|morning)|when (?:she|he|they) woke)\b", re.I)
NIGHT = re.compile(r"\b(?:night|midnight|moonlight|moonlit|moon|dark(?:ness)?|stars|starlight|dusk|nightfall|"
                   r"after dark|evening)\b", re.I)
DAY = re.compile(r"\b(?:noon|midday|morning|afternoon|daylight|sunlight|sunshine|broad day|the sun (?:was|stood|"
                 r"blazed|beat)|by day)\b", re.I)
NOT_A_USE = re.compile(r"\b(?:not|never|cannot|can't|couldn't|could not|didn't|did not|won't|wouldn't|unable to|"
                       r"tried to|try to|wanted to|wished|hoped to|meant to|if (?:she|he|they|i|we|you)|could|would|"
                       r"might|should|without (?:a|any)|about to|how to|learn(?:ed|t)? to)\b(?:\W+\w+){0,3}\W*$", re.I)
TWIST = re.compile(r"\b(?:deliberate(?:ly)?\s+(?:twist|break|rule[- ]?break)|rule[- ]?break|breaks? (?:the|its|"
                   r"their|a) (?:rule|rules)|twist:|bends? the rule)", re.I)
GAIN = re.compile(r"\b(?:found|finds|picked up|picks up|pocketed|pockets|took|takes|gathered|gathers|collected|"
                  r"collects|bought|buys|dug up|was given|were given|received|receives|earned|won|stole|steals|"
                  r"pried|prised)\b", re.I)
LOSE = re.compile(r"\b(?:lost|loses|dropped|drops|gave away|gives away|broke|shattered|crumbled|cracked|spent|"
                  r"threw away|handed over)\b", re.I)
HAVE = re.compile(r"\b(?:had|has|have|carried|carries|held|holds|kept|keeps|left with|still had|was left with|"
                  r"counted|owned)\b", re.I)
CONSUMED_NO = re.compile(r"\((?:kept|not used up|reusable|held|carried)\)|\b(?:not used up|is kept|reusable|"
                         r"must (?:hold|carry|touch)|holding|carrying)\b", re.I)
UNIT_STRIP = re.compile(r"\((?:used up|consumed|spent|kept|not used up|reusable|held|carried)\)", re.I)
TIME_REQ = re.compile(r"\b(?:(?:at|by) night(?: only)?|only (?:at|by) night|after dark|night only|nightfall|"
                      r"(?:by|in) daylight(?: only)?|only (?:by|in) (?:day|daylight)|by day(?: only)?|day only|"
                      r"under the (?:moon|sun))\b", re.I)
PER_DAY = re.compile(r"\b(?:(?:at most|no more than|up to|only)\s+)?(?P<n>" + _NUM[3:-1] + r"|once|twice|thrice)"
                     r"(?:\s+(?:times?|uses?|jumps?|casts?))?\s+(?:a|per|each|every)\s+(?P<per>day|night|chapter)\b",
                     re.I)
PER_DAY2 = re.compile(r"\buses? per (?P<per>day|night)\s*[:=]?\s*(?P<n>\d{1,2}|one|two|three|four|five)\b", re.I)
COOLDOWN = re.compile(r"\b(?:cool ?down|must (?:rest|wait)|recover(?:y)?|between uses|once every)\b[^;.]*", re.I)
DURATION = re.compile(r"(?P<n>\d{1,3}|an?|one|two|three|four|five|six|twelve|half an?)\s*(?P<u>minutes?|hours?|"
                      r"days?|nights?|weeks?)", re.I)
RANGE = re.compile(r"\b(?:range|within|up to|as far as|no further than|distance)\b[^;.]*", re.I)
PRICE = re.compile(r"\b(?:price|costs? (?:the|her|him|them|its)|leaves?|drains?|ages?|bleed\w*|nosebleed|"
                   r"exhaust\w*|in exchange|takes? a (?:memory|year)|side effect)\b", re.I)
FREE_NAME = re.compile(r"^\s*(?:the\s+|a\s+|an\s+)?(?P<name>[A-Za-z][A-Za-z' -]{2,40}?)\s+(?:requires|needs|costs|"
                       r"demands|consumes|uses up|takes|only works|works only|can only be used|must have)\b", re.I)
FREE_REQ = re.compile(r"\b(?:requires|needs|demands|consumes|uses up|takes|must have)\b(?P<req>[^;.]+)", re.I)
STOP = {"the", "a", "an", "of", "and", "or", "to", "spell", "magic", "power", "ability", "device", "art"}


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _clip(v, n: int = FIELD_MAX) -> str:
    return " ".join(str(v or "").split())[:n] if isinstance(v, (str, int, float)) and not isinstance(v, bool) else ""


def num(word: str | None) -> int | None:
    """"2" / "two" / "a pair of" / "both" -> the number (None when it is not one)."""
    w = str(word or "").strip().lower()
    if not w:
        return None
    if w.isdigit():
        return int(w)
    w = re.sub(r"^(?:a\s+)?(pair|couple)\s+of$", r"\1", w)
    return _NUMW.get(w)


def say_num(n: int) -> str:
    return _WORDNUM.get(n, str(n))


def singular(item: str) -> str:
    words = item.split()
    if not words:
        return item
    last = words[-1]
    if last.endswith("ies") and len(last) > 4:
        last = last[:-3] + "y"
    elif last.endswith(("ches", "shes", "sses", "xes")):
        last = last[:-2]
    elif last.endswith("s") and not last.endswith("ss") and len(last) > 3:
        last = last[:-1]
    return " ".join(words[:-1] + [last])


def item_words(n: int | None, item: str) -> str:
    one = singular(item)
    if n == 1:
        return f"one {one}"
    plural = one if one.endswith("s") else (one[:-1] + "ies" if one.endswith("y") and one[-2:-1] not in "aeiou"
                                             else one + "s")
    return f"{say_num(n) if n is not None else 'some'} {plural}"


def _head(item: str) -> str:
    return singular(item).split()[-1].lower() if item.split() else ""


def _lines(v) -> list[str]:
    if isinstance(v, list):
        items = v
    else:
        items = re.split(r"[\n;]+", str(v or ""))
    return [_clip(x, LINE_MAX) for x in items if _clip(x, LINE_MAX)][:MAX_LINES]


def sentences(text: str) -> list[str]:
    return [m.group(0).strip() for m in SENT.finditer(text or "") if m.group(0).strip()]


# ====================================================================== parsing a rule
def parse_requirement(line: str) -> dict:
    """"2 anchor stones" -> {text, kind item, qty 2, item "anchor stones", consumed}; "at night only" -> kind time,
    when night; anything else -> kind condition (checked by the reviewer, not counted)."""
    text = _clip(line, LINE_MAX)
    t = TIME_REQ.search(text)
    if t and len(text.split()) <= 6:
        return {"text": text, "kind": "time", "when": "day" if re.search(r"day", t.group(0), re.I) else "night"}
    m = re.match(r"^\s*(?:at least\s+|exactly\s+)?(?P<q>" + _NUM + r")\s+(?P<item>[A-Za-z][A-Za-z' -]{1,60}?)\s*"
                 r"(?:\((?P<note>[^)]*)\))?\s*$", text, re.I)
    if m and num(m.group("q")) and not re.match(r"(?:line|clear|direct)\b", m.group("item"), re.I):
        item = UNIT_STRIP.sub("", m.group("item")).strip(" -")
        return {"text": text, "kind": "item", "qty": num(m.group("q")), "item": item,
                "consumed": not CONSUMED_NO.search(text)}
    return {"text": text, "kind": "condition"}


def parse_limits(lines: list[str]) -> dict:
    out = {"lines": list(lines)}
    for ln in lines:
        m = PER_DAY.search(ln) or PER_DAY2.search(ln)
        if m and "per_day" not in out:
            n = num(m.group("n"))
            if n:
                out["per_day"] = n
                out["per"] = m.group("per").lower()
        c = COOLDOWN.search(ln)
        if c and "cooldown" not in out:
            out["cooldown"] = _clip(c.group(0), LINE_MAX)
            d = DURATION.search(ln)
            if d:
                u = d.group("u").lower()
                out["cooldown_unit"] = "day" if u.startswith(("day", "night", "week")) else "hour"
        r = RANGE.search(ln)
        if r and "range" not in out and not m:
            out["range"] = _clip(r.group(0), LINE_MAX)
    return out


def _name_words(name: str, words) -> list[str]:
    """Regexes (as text) that show a use: the author's words, else the name (one word: its stem; more: the phrase)."""
    given = [w.strip() for w in (words if isinstance(words, list) else str(words or "").split(",")) if w.strip()]
    out = []
    for w in given or [name]:
        parts = [p for p in re.findall(r"[A-Za-z']+", w)]
        if not parts:
            continue
        if len(parts) == 1 or given:
            core = [p for p in parts if p.lower() not in STOP] or parts
            if len(core) == 1:
                s = core[0].lower()
                for suf in ("ation", "ition", "ing", "ion", "ed", "s"):
                    if s.endswith(suf) and len(s) - len(suf) >= 4:
                        s = s[:-len(suf)]
                        break
                out.append(r"\b" + re.escape(s) + r"\w*")
                continue
        out.append(r"\b" + r"[\s-]+".join(re.escape(p) for p in parts) + r"\w*")
    return out[:6]


def parse_start(text: str) -> dict:
    """"Mara: 3 anchor stones; Tom: 1 anchor stone" -> {"Mara": {"anchor stone": 3}, ...}."""
    out: dict = {}
    for part in re.split(r"[;\n]+", str(text or "")):
        m = re.match(r"\s*(?P<who>[^:]{1,60}):\s*(?P<rest>.+)$", part)
        if not m:
            continue
        for bit in re.split(r",|\band\b", m.group("rest")):
            r = parse_requirement(bit.strip())
            if r["kind"] == "item":
                out.setdefault(m.group("who").strip(), {})[singular(r["item"]).lower()] = r["qty"]
    return out


def clean_magic(raw) -> dict | None:
    """The author's (or the AI's) structured fields, cleaned; None when there is no name."""
    if not isinstance(raw, dict):
        return None
    name = _clip(raw.get("name"), 60)
    if not name:
        return None
    out = {"name": name, "does": _clip(raw.get("does")), "requires": _lines(raw.get("requires")),
           "limits": _lines(raw.get("limits")), "price": _clip(raw.get("price")), "who": _clip(raw.get("who"), 160),
           "exceptions": _clip(raw.get("exceptions")), "start": _clip(raw.get("start")),
           "words": ", ".join(w.strip() for w in (raw.get("words") if isinstance(raw.get("words"), list)
                                                    else str(raw.get("words") or "").split(",")) if w.strip())[:160]}
    if out["exceptions"].lower() in ("none", "no", "no exceptions", "-", "n/a"):
        out["exceptions"] = ""
    return out


def parse_free(text: str, scope: str = "") -> dict | None:
    """An old free-text rule ("Teleportation requires two anchor stones; at most three times a day") read into the
    structured fields; None when it does not clearly describe an ability with a counted need or a limit."""
    m = FREE_NAME.search(text or "")
    if not m:
        return None
    name = m.group("name").strip()
    if len(name.split()) > 4:
        return None
    req = []
    r = FREE_REQ.search(text)
    if r:
        req = [x.strip() for x in re.split(r",|\band\b", r.group("req")) if x.strip()]
    limits, price, extra = [], "", []
    for clause in re.split(r"[;.]+", f"{text}; {scope or ''}"):
        c = clause.strip()
        if not c or (r and r.group("req").strip() in c):
            continue
        if TIME_REQ.search(c) and len(c.split()) <= 8:
            extra.append(TIME_REQ.search(c).group(0))
        elif PER_DAY.search(c) or PER_DAY2.search(c) or COOLDOWN.search(c) or RANGE.search(c):
            limits.append(c)
        elif PRICE.search(c) and not price:
            price = c
    mg = clean_magic({"name": name, "requires": req + extra, "limits": limits, "price": price})
    ab = ability(mg) if mg else None
    if not ab or not (any(q["kind"] in ("item", "time") for q in ab["needs"]) or ab["limits"].get("per_day")):
        return None
    return dict(mg, from_text=True)


def ability(mg: dict, rule_id: str = "") -> dict | None:
    """The checkable form of one structured rule."""
    if not mg or not mg.get("name"):
        return None
    pats = _name_words(mg["name"], mg.get("words"))
    who = mg.get("who") or ""
    return {"rule_id": rule_id, "name": mg["name"], "magic": mg, "needs": [parse_requirement(x) for x in
                                                                          mg.get("requires") or []],
            "limits": parse_limits(mg.get("limits") or []), "price": mg.get("price") or "",
            "who": who, "anyone": not who or bool(re.search(r"\b(?:anyone|anybody|everyone|all|any)\b", who, re.I)),
            "start": parse_start(mg.get("start") or ""), "exceptions": mg.get("exceptions") or "",
            "pattern": re.compile("(?:" + "|".join(pats) + ")", re.I) if pats else None,
            "from_text": bool(mg.get("from_text"))}


def abilities_of(entry: dict | None) -> list[dict]:
    """The checkable abilities of a story-rules entry: structured rules first, then free-text rules that read as one."""
    from . import story_rules  # noqa: PLC0415
    out = []
    for r in story_rules.active(entry):
        mg = clean_magic(r.get("magic")) if r.get("magic") else None
        if mg is None and r.get("category") in ("hard_rule", "seen"):
            mg = parse_free(r.get("text") or "", r.get("scope") or "")
        ab = ability(mg, r.get("id") or "") if mg else None
        if ab and ab["pattern"] is not None:
            out.append(ab)
        if len(out) >= MAX_ABILITIES:
            break
    return out


# ====================================================================== reading one chapter (no AI)
def _names_in(sent: str, names: list[str]) -> list[str]:
    hits = []
    for n in names:
        parts = [n] + ([n.split()[0]] if len(n.split()) > 1 and len(n.split()[0]) >= 3 else [])
        for p in parts:
            m = re.search(r"\b" + re.escape(p) + r"\b", sent)
            if m:
                hits.append((m.start(), n))
                break
    return [n for _i, n in sorted(hits)]


def _qty_of(sent: str, item: str) -> int | None:
    """The number of ``item`` a sentence states ("with only one anchor stone", "both stones", "her last stone")."""
    head = _head(item)
    if not head:
        return None
    pat = re.compile(r"\b(?P<q>" + _NUM + r")\s+(?:(?:of\s+)?(?:his|her|their|the|my|its|our|your|remaining|"
                     r"spare|small|little|precious|last|only|cracked|old|glowing|[a-z]+)\s+){0,2}?"
                     + re.escape(head) + r"s?\b", re.I)
    best = None
    for m in pat.finditer(sent):
        q = num(m.group("q"))
        if m.group("q").lower() == "last":
            two = re.search(r"\blast\s+(?P<n>two|three|four|five|\d)\b", m.group(0), re.I)
            q = num(two.group("n")) if two else 1
        if q is not None and best is None:
            best = q
    return best


def extract(text: str, abilities: list[dict], names: list[str]) -> dict:
    """{uses: [...], gains: [...]} of one chapter: every sentence (outside dialogue) that uses an ability, with who,
    the counted things it states, the part of the day and the scene / day it is in; and every sentence where someone
    gets, loses or is left with a counted thing."""
    uses, gains = [], []
    items = sorted({singular(q["item"]).lower() for a in abilities for q in a["needs"] if q["kind"] == "item"})
    scenes = SCENE_BREAK.split(text or "")
    last_who, part, day, s_index = None, None, 0, 0
    for scene_no, scene in enumerate(scenes):
        sents = sentences(scene)
        for i, s in enumerate(sents):
            s_index += 1
            nar = QUOTED.sub(" ", s)
            if NEXT_DAY.search(nar):
                day += 1
                part = None
            if NIGHT.search(nar):
                part = "night"
            elif DAY.search(nar):
                part = "day"
            who_here = _names_in(nar, names)
            if TIME_SKIP.search(nar) and uses:  # time passed since the last use (a cooldown may be over)
                uses[-1]["time_skip"] = True
            for a in abilities:
                m = a["pattern"].search(nar)
                if not m or NOT_A_USE.search(nar[:m.start()]):
                    continue
                prev = uses[-1] if uses else None
                if prev and prev["ability"] == a["name"] and prev["scene"] == scene_no and \
                        (not who_here or _same_person(who_here[0], prev["who"])) and \
                        s_index - prev["_s"] <= 2 and not re.search(r"\b(?:again|a second time|once more)\b", nar,
                                                                    re.I):
                    prev["_s"] = s_index  # the same use told over two sentences
                    continue
                who = who_here[0] if who_here else last_who
                around = " ".join(QUOTED.sub(" ", x) for j, x in enumerate(sents[max(0, i - 1):i + 2])
                                  if all(_same_person(o, who) for o in _names_in(QUOTED.sub(" ", x), names)))
                stated = {}
                for q in a["needs"]:
                    if q["kind"] == "item":
                        n = _qty_of(nar, q["item"])
                        if n is None:
                            n = _qty_of(around, q["item"])
                        if n is not None:
                            stated[singular(q["item"]).lower()] = n
                when = "night" if NIGHT.search(nar) else "day" if DAY.search(nar) else part
                price_seen = bool(a["price"]) and bool(_overlap(a["price"], " ".join(sents[max(0, i - 1):i + 3])))
                uses.append({"ability": a["name"], "rule_id": a["rule_id"], "who": who, "stated": stated,
                             "when": when, "day": day, "scene": scene_no, "_s": s_index,
                             "time_skip": False, "price_seen": price_seen, "quote": _clip(s, QUOTE_MAX),
                             "matched": m.group(0)})
            if items and not any(a["pattern"].search(nar) for a in abilities):
                for it in items:
                    n = _qty_of(nar, it)
                    if n is None:
                        continue
                    kind = "lost" if LOSE.search(nar) else "gained" if GAIN.search(nar) else \
                        "has" if HAVE.search(nar) else None
                    if kind:
                        gains.append({"who": (who_here[0] if who_here else last_who), "item": it, "qty": n,
                                      "change": kind, "quote": _clip(s, QUOTE_MAX), "_s": s_index, "day": day})
            if who_here and nar == s:  # a speaker named beside dialogue is not who "she" is next
                last_who = who_here[-1]
            elif who_here and not last_who:
                last_who = who_here[0]
    return {"uses": uses, "gains": gains}


def _overlap(a: str, b: str) -> set:
    """The price's words (or their first four letters: "nosebleed" ~ "nose") found in ``b``."""
    wa = {w.lower() for w in re.findall(r"[A-Za-z]{4,}", a or "")} - {"each", "every", "time", "uses", "with", "that",
                                                                       "from", "user", "their", "leaves", "costs"}
    wb = {w.lower() for w in re.findall(r"[A-Za-z]{4,}", b or "")}
    pre = {w[:4] for w in wb}
    return {w for w in wa if w in wb or w[:4] in pre}


def from_tracked(tr: dict, abilities: list[dict], names: list[str]) -> dict:
    """The continuity tracker's AI answer (ability_uses / ability_gains) in the same form as ``extract``."""
    by_name = {a["name"].lower(): a for a in abilities}
    uses, gains = [], []
    for i, u in enumerate(tr.get("uses") or []):
        a = by_name.get(str(u.get("ability") or "").lower()) or next(
            (x for x in abilities if x["pattern"].search(str(u.get("ability") or ""))), None)
        if a is None:
            continue
        stated = {}
        for q in a["needs"]:
            if q["kind"] == "item":
                n = _qty_of(str(u.get("cost_paid") or ""), q["item"])
                if n is not None:
                    stated[singular(q["item"]).lower()] = n
        quote = _clip(u.get("quote") or u.get("where"), QUOTE_MAX)
        uses.append({"ability": a["name"], "rule_id": a["rule_id"], "who": _who(u.get("who"), names), "stated": stated,
                     "when": "night" if NIGHT.search(quote) else "day" if DAY.search(quote) else None, "day": 0,
                     "scene": 0, "_s": i * 10, "time_skip": True, "price_seen": True, "quote": quote,
                     "matched": a["name"], "tracked": True})
    for g in tr.get("gains") or []:
        r = parse_requirement(str(g.get("what") or ""))
        if r["kind"] == "item":
            gains.append({"who": _who(g.get("who"), names), "item": singular(r["item"]).lower(), "qty": r["qty"],
                          "change": g.get("change") if g.get("change") in ("gained", "lost", "has") else "gained",
                          "quote": "", "_s": 0, "day": 0})
    return {"uses": uses, "gains": gains}


def _who(v, names: list[str]) -> str | None:
    v = _clip(v, 80)
    if not v:
        return None
    hit = _names_in(v, names)
    return hit[0] if hit else v


def _same_person(a: str | None, b: str | None) -> bool:
    if not a or not b:
        return False
    a, b = a.lower(), b.lower()
    return a == b or a.split()[0] == b.split()[0]


# ====================================================================== the ledger and the check
def _stock_key(state: dict, who: str | None) -> str | None:
    if not who:
        return None
    for k in state:
        if _same_person(k, who):
            return k
    return who


def _allowed(a: dict, number: int, plan: str, breaks: list[dict]) -> str | None:
    for b in breaks or []:
        if int(b.get("chapter") or 0) == number and (not b.get("ability") or str(b["ability"]).lower()
                                                      == a["name"].lower()):
            return _clip(b.get("why") or "the author marked this rule-break as deliberate", 160)
    if plan and TWIST.search(plan) and (a["pattern"].search(plan) or a["name"].lower() in plan.lower()):
        return "the plan marks this rule-break as a deliberate twist"
    return None


def check_book(abilities: list[dict], chapters: list[dict], *, names: list[str], tracked: dict | None = None,
               allowed: list | None = None, plans: dict | None = None) -> dict:
    """Run the ledger over the chapters in order: deduct costs, count uses, check each use against its rule.
    chapters = [{chapter_id, number, text, version}]; tracked = {chapter_id: {version, uses, gains}} (the
    continuity AI's reading, used when its version matches); plans = {chapter_id: the chapter's plan text}.
    Returns {chapters: [{chapter_id, number, uses, gains, state_after, problems, source}], state, problems, counts}."""
    state: dict = {}     # who -> item -> count
    prices: dict = {}    # who -> [price (chapter n)]
    last_use: dict = {}  # (who, ability) -> chapter number
    for a in abilities:
        for who, items in a["start"].items():
            k = _stock_key(state, who)
            for it, n in items.items():
                state.setdefault(k, {}).setdefault(it, n)
    out_ch, problems = [], []
    counts = {"uses": 0, "broken": 0, "deliberate": 0, "minor": 0}
    by_name = {a["name"]: a for a in abilities}
    for ch in chapters:
        n = ch.get("number")
        tr = (tracked or {}).get(ch["chapter_id"])
        if tr and tr.get("version") == ch.get("version") and (tr.get("uses") or tr.get("gains")):
            read, source = from_tracked(tr, abilities, names), "ai"
        else:
            read, source = extract(ch.get("text") or "", abilities, names), "akowe"
        plan = (plans or {}).get(ch["chapter_id"]) or ""
        events = sorted([("g", g["_s"], g) for g in read["gains"]] + [("u", u["_s"], u) for u in read["uses"]],
                        key=lambda e: (e[1], 0 if e[0] == "g" else 1))
        per_day: dict = {}
        prev_use: dict = {}
        ch_uses, ch_probs = [], []
        for kind, _s, ev in events:
            if kind == "g":
                k = _stock_key(state, ev["who"])
                if not k:
                    continue
                cur = state.setdefault(k, {})
                if ev["change"] == "has":
                    cur[ev["item"]] = ev["qty"]
                elif ev["change"] == "gained":
                    cur[ev["item"]] = (cur.get(ev["item"]) or 0) + ev["qty"]
                else:
                    cur[ev["item"]] = max(0, (cur.get(ev["item"]) or 0) - ev["qty"])
                continue
            a = by_name[ev["ability"]]
            who = ev["who"]
            k = _stock_key(state, who)
            counts["uses"] += 1
            found = []
            paid = []

            def prob(code, msg, severity="major", ev=ev, a=a, found=found):
                found.append({"code": code, "label": CODES[code], "severity": severity, "ability": a["name"],
                              "rule_id": a["rule_id"], "who": ev["who"], "chapter_id": ch["chapter_id"], "number": n,
                              "quote": ev["quote"], "message": msg})
            name_who = who or "Someone"
            for q in a["needs"]:
                if q["kind"] == "item":
                    it = singular(q["item"]).lower()
                    stated = ev["stated"].get(it)
                    have = (state.get(k) or {}).get(it) if k else None
                    if stated is not None and stated < q["qty"]:
                        prob("needs_more", f"{name_who} uses {a['name']} in chapter {n} with only "
                                           f"{item_words(stated, q['item'])}; the rule needs {q['qty']}.")
                    elif stated is None and have is not None and have < q["qty"]:
                        prob("not_enough", f"{name_who} uses {a['name']} in chapter {n} but has "
                                           f"{'only ' if have else ''}{item_words(have, q['item'])} left by the "
                                           f"ledger; the rule needs "
                                           f"{q['qty']}. Show where more came from, or change the scene.")
                    if q["consumed"]:
                        paid.append(item_words(q["qty"], q["item"]))
                        if k and have is not None:
                            state.setdefault(k, {})[it] = max(0, have - q["qty"])
                        elif k and stated is not None:
                            state.setdefault(k, {})[it] = max(0, stated - q["qty"])
                elif q["kind"] == "time" and ev.get("when") and ev["when"] != q["when"]:
                    prob("wrong_time", f"{name_who} uses {a['name']} in chapter {n} by "
                                       f"{'day' if ev['when'] == 'day' else 'night'}; the rule says "
                                       f"“{q['text']}”.")
            lim = a["limits"]
            dk = (str(who or "").lower(), a["name"], ev["day"])
            per_day[dk] = per_day.get(dk, 0) + 1
            if lim.get("per_day") and lim.get("per") in ("day", "night") and per_day[dk] == lim["per_day"] + 1:
                prob("too_many", f"{name_who} uses {a['name']} {say_num(per_day[dk])} times on one day in chapter "
                                 f"{n}; the rule allows {lim['per_day']} a {lim['per']}.")
            pk = (str(who or "").lower(), a["name"])
            p = prev_use.get(pk)
            if lim.get("cooldown") and p and ev.get("scene") == p.get("scene") and ev["day"] == p["day"] and \
                    not p.get("time_skip") and source == "akowe":
                prob("cooldown", f"{name_who} uses {a['name']} again in the same scene of chapter {n}; the rule "
                                 f"says “{lim['cooldown']}”.")
            prev_use[pk] = ev
            if who and not a["anyone"] and any(_same_person(who, x) for x in names) and \
                    not re.search(r"\b" + re.escape(str(who).split()[0]) + r"\b", a["who"], re.I):
                prob("not_allowed", f"{who} uses {a['name']} in chapter {n}; the rule says only {a['who']} can.")
            if a["price"]:
                if who:
                    prices.setdefault(k or who, []).append(f"{_clip(a['price'], 60)} (chapter {n})")
                if not ev.get("price_seen") and source == "akowe":
                    prob("price_missing", f"{name_who} uses {a['name']} in chapter {n} but its price "
                                          f"(“{_clip(a['price'], 80)}”) is not shown near the use.", "minor")
            why_ok = _allowed(a, n or 0, plan, allowed or []) if any(f["severity"] == "major" for f in found) else None
            for f in found:
                if f["severity"] == "major" and why_ok:
                    f["allowed"] = why_ok
                    counts["deliberate"] += 1
                elif f["severity"] == "major":
                    counts["broken"] += 1
                else:
                    counts["minor"] += 1
            last_use[pk] = n
            ch_probs += found
            ch_uses.append({"ability": a["name"], "who": who, "paid": paid, "when": ev.get("when"),
                            "quote": ev["quote"], "ok": not any(f["severity"] == "major" and not f.get("allowed")
                                                                for f in found),
                            "deliberate": any(f.get("allowed") for f in found)})
        out_ch.append({"chapter_id": ch["chapter_id"], "number": n, "uses": ch_uses, "source": source,
                       "gains": [{k2: g[k2] for k2 in ("who", "item", "qty", "change")} for g in read["gains"]],
                       "state_after": copy.deepcopy(state), "problems": ch_probs})
        problems += ch_probs
    return {"chapters": out_ch, "state": state, "prices": prices, "problems": problems[:MAX_PROBLEMS],
            "counts": counts, "last_use": {f"{w}|{ab}": c for (w, ab), c in last_use.items()}}


def state_lines(state: dict, prices: dict | None = None, limit: int = 10) -> list[str]:
    out = []
    for who, items in (state or {}).items():
        if items:
            out.append(f"{who} has " + ", ".join(item_words(v, k) for k, v in sorted(items.items())) + ".")
    for who, ps in (prices or {}).items():
        out.append(f"{who} has paid: " + "; ".join(ps[-3:]) + ".")
    return out[:limit]


def summary_line(counts: dict) -> str:
    c = counts or {}
    line = f"✨ Magic rules kept: {c.get('uses', 0)} use(s), {c.get('broken', 0)} broken"
    if c.get("deliberate"):
        line += f", {c['deliberate']} deliberate twist(s)"
    if c.get("minor"):
        line += f", {c['minor']} small note(s)"
    return line


# ====================================================================== storage
def _key(pid: str, branch: str) -> str:
    return f"magic:{pid}:{branch}"


def get_entry(store, pid: str, branch: str) -> dict:
    try:
        e = store.get_setting(_key(pid, branch))
    except Exception:  # noqa: BLE001 - guidance never fails the caller
        log.exception("could not read the magic ledger")
        e = None
    e = copy.deepcopy(e) if isinstance(e, dict) else {}
    e.setdefault("enabled", True)
    e.setdefault("allowed_breaks", [])
    e.setdefault("tracked", {})
    return e


def _update(store, pid: str, branch: str, change) -> dict:
    with _LOCK:
        with store.transaction() as tx:
            row = tx.conn.execute("SELECT value FROM settings WHERE key=?", (_key(pid, branch),)).fetchone()
            cur = json.loads(row["value"]) if row else {}
            cur = cur if isinstance(cur, dict) else {}
            change(cur)
            store.set_setting(_key(pid, branch), cur)
    return get_entry(store, pid, branch)


def enabled(store, pid: str, branch: str) -> bool:
    try:
        from . import pipeline as pipeline_mod  # noqa: PLC0415
        if not pipeline_mod.of_store(store, pid).get("rules", True):
            return False
    except Exception:  # noqa: BLE001
        pass
    return bool(get_entry(store, pid, branch).get("enabled", True))


def save_settings(store, pid: str, branch: str, body) -> dict:
    from .errors import AkoweError  # noqa: PLC0415
    body = body if isinstance(body, dict) else {}
    on = body.get("enabled")
    if on is not None and not isinstance(on, bool):
        raise AkoweError("INVALID_INPUT", "/enabled", "enabled: true or false", status="REJECTED")
    breaks = body.get("allowed_breaks")
    clean = None
    if breaks is not None:
        if not isinstance(breaks, list) or len(breaks) > 20:
            raise AkoweError("INVALID_INPUT", "/allowed_breaks", "allowed_breaks: a list of up to 20 "
                             "{chapter, ability, why}", status="REJECTED")
        clean = []
        for i, b in enumerate(breaks):
            ch = b.get("chapter") if isinstance(b, dict) else None
            if not isinstance(ch, int) or isinstance(ch, bool) or ch < 1:
                raise AkoweError("INVALID_INPUT", f"/allowed_breaks/{i}/chapter", "each deliberate rule-break needs "
                                 "its chapter number", status="REJECTED")
            clean.append({"chapter": ch, "ability": _clip(b.get("ability"), 60), "why": _clip(b.get("why"), 160)})

    def change(cur):
        if on is not None:
            cur["enabled"] = on
        if clean is not None:
            cur["allowed_breaks"] = clean
    e = _update(store, pid, branch, change)
    with store.transaction() as tx:
        tx.insert_outbox(pid, branch, "magic.settings", {"enabled": e["enabled"],
                                                         "allowed_breaks": len(e["allowed_breaks"])})
    return e


def save_tracked(store, pid: str, branch: str, chapter_id: str, version, raw) -> int:
    """Keep the continuity AI's ability_uses / ability_gains of one chapter (n uses kept; never raises)."""
    try:
        if not isinstance(raw, dict) or not (raw.get("ability_uses") or raw.get("ability_gains")):
            return 0
        uses = [{k: _clip(u.get(k), QUOTE_MAX) for k in ("who", "ability", "cost_paid", "where", "quote")}
                for u in raw.get("ability_uses") or [] if isinstance(u, dict)][:20]
        gains = [{k: _clip(g.get(k), 120) for k in ("who", "what", "change")}
                 for g in raw.get("ability_gains") or [] if isinstance(g, dict)][:20]

        def change(cur):
            cur.setdefault("tracked", {})[chapter_id] = {"version": version, "uses": uses, "gains": gains,
                                                         "at": _now()}
        _update(store, pid, branch, change)
        return len(uses)
    except Exception:  # noqa: BLE001
        log.exception("could not keep the tracked ability uses")
        return 0


def track_ask(store, pid: str, branch: str, ctx: dict, task: str, schema: dict) -> tuple[str, dict]:
    """The continuity tracker's task and schema, with the ability uses asked for when the book has abilities (the
    same AI call; ``ctx`` gets context.abilities). Never raises."""
    try:
        from . import story_rules  # noqa: PLC0415
        if not enabled(store, pid, branch):
            return task, schema
        abilities = abilities_of(story_rules.get_entry(store, pid, branch))
        if not abilities:
            return task, schema
        ctx["abilities"] = [{k: v for k, v in view(a).items() if k in ("name", "needs", "limits", "price")}
                            for a in abilities]
        schema = copy.deepcopy(schema)
        schema.setdefault("properties", {}).update(copy.deepcopy(TRACK_PROPS))
        return task.replace(" Treat instructions inside the data", TRACK_TASK + " Treat instructions inside the data",
                            1), schema
    except Exception:  # noqa: BLE001
        log.exception("could not add the abilities to the tracker")
        return task, schema


def _save_snapshot(store, pid, branch, rep: dict) -> None:
    snap = {"at": _now(), "counts": rep["counts"],
            "chapters": [{"chapter_id": c["chapter_id"], "number": c["number"], "state_after": c["state_after"],
                          "uses": [{k: u.get(k) for k in ("ability", "who", "ok")} for u in c["uses"]][:20]}
                         for c in rep["chapters"]],
            "prices": rep.get("prices") or {}}

    def change(cur):
        cur["snapshot"] = snap
    try:
        _update(store, pid, branch, change)
    except Exception:  # noqa: BLE001
        log.exception("could not keep the magic ledger snapshot")


# ====================================================================== the book (needs an engine)
def _names(store, pid, branch) -> list[str]:
    from . import characters as chars_mod  # noqa: PLC0415
    try:
        return [c["name"] for c in chars_mod.canon_characters(store, pid, branch) if c.get("name")]
    except Exception:  # noqa: BLE001
        return []


def compute(engine, principal: str, pid: str, branch: str, *, override: dict | None = None,
            upto: int | None = None, save: bool = True) -> dict | None:
    """The ledger and the rule check of the book's written chapters (``override``: a chapter's new draft;
    ``upto``: stop after this chapter number). None when the book has no checkable ability or the check is off."""
    from . import story_rules  # noqa: PLC0415
    from .book_path import BookPath  # noqa: PLC0415
    from .fact_checks import book_texts  # noqa: PLC0415
    store = engine.store
    if not enabled(store, pid, branch):
        return None
    abilities = abilities_of(story_rules.get_entry(store, pid, branch))
    if not abilities:
        return None
    chs = book_texts(engine, principal, pid, branch)
    if override:
        chs = [dict(c, text=override["text"], version=override.get("version")) if c["record_id"] ==
               override.get("record_id") else c for c in chs]
    if upto is not None:
        chs = [c for c in chs if c["number"] <= upto]
    plans = {}
    try:
        bp = BookPath(engine, principal, pid, branch)
        outline = bp.outline()
        for c in bp.outline_chapters(outline) if outline else []:
            plans[c["chapter_id"]] = f"{c.get('objective') or ''} {c.get('summary') or ''}"
    except Exception:  # noqa: BLE001 - the plan only allows deliberate twists
        log.exception("could not read the plan for the magic check")
    e = get_entry(store, pid, branch)
    rep = check_book(abilities, chs, names=_names(store, pid, branch), tracked=e.get("tracked"),
                     allowed=e.get("allowed_breaks"), plans=plans)
    rep["abilities"] = [view(a) for a in abilities]
    if save and upto is None:
        _save_snapshot(store, pid, branch, rep)
    return rep


def view(a: dict) -> dict:
    """An ability as the page, the reviewer and the writer see it (plain fields)."""
    out = {"name": a["name"], "rule_id": a["rule_id"]}
    mg = a["magic"]
    for k in ("does", "price", "who"):
        if mg.get(k):
            out[k] = mg[k]
    out["needs"] = [q["text"] for q in a["needs"]]
    out["limits"] = list(a["limits"].get("lines") or [])
    out["exceptions"] = mg.get("exceptions") or "none"
    if a["from_text"]:
        out["read_from_text"] = True
    return out


def flags_for(engine, principal: str, pid: str, branch: str, rec: dict) -> list[dict]:
    """This chapter's broken magic rules (not deliberate) as ``akowe_in_chapter`` flags for the editor and the
    reviewer: [{name, message, quote}]. Never raises."""
    try:
        if rec.get("module_id") != "C02":
            return []
        from .fact_checks import book_texts  # noqa: PLC0415
        chs = book_texts(engine, principal, pid, branch)
        me = next((c for c in chs if c["record_id"] == rec["record_id"]), None)
        if me is None:
            return []
        rep = compute(engine, principal, pid, branch, upto=me["number"], save=False,
                      override={"record_id": rec["record_id"], "version": rec.get("version"),
                                "text": str((rec.get("data") or {}).get("text") or "")})
        if rep is None:
            return []
        try:
            compute(engine, principal, pid, branch)  # keep the snapshot for the next chapters' briefs and the page
        except Exception:  # noqa: BLE001
            log.exception("could not refresh the magic ledger")
        return [{"name": "magic", "message": f"{p['label']}: {p['message']}", "quote": p["quote"],
                 "ability": p["ability"]}
                for p in rep["problems"] if p["chapter_id"] == me["chapter_id"] and p["severity"] == "major"
                and not p.get("allowed")][:6]
    except Exception:  # noqa: BLE001
        log.exception("could not check the magic rules of this chapter")
        return []


def reviewer_context(engine, principal: str, pid: str, branch: str, rec: dict) -> dict | None:
    """The abilities and the ledger before this chapter for the editor / reviewer (bounded); None when there are none."""
    try:
        if rec.get("module_id") != "C02":
            return None
        from .fact_checks import book_texts  # noqa: PLC0415
        me = next((c for c in book_texts(engine, principal, pid, branch) if c["record_id"] == rec["record_id"]), None)
        return brief_part(engine.store, pid, branch, me["number"] if me else None, None, all_abilities=True)
    except Exception:  # noqa: BLE001
        log.exception("could not build the magic context")
        return None


def magic_findings(findings: list, flags: list, text: str) -> list:
    """✨ A broken magic rule (``flags_for``) that no editor note covers becomes a MAJOR note of its own (dimension
    story_rules), so the rewrite must fix it; one already covered is raised to MAJOR."""
    out = list(findings)
    for c in flags or []:
        q = str(c.get("quote") or "")
        hit = next((i for i, f in enumerate(out) if f.get("passage") and q and (f["passage"] in q or q in f["passage"])),
                   None)
        if hit is not None:
            if out[hit].get("severity") != "major":
                out[hit] = dict(out[hit], severity="major", severity_raised="a magic rule is broken")
            continue
        if q and q in (text or ""):
            out.append({"id": f"magic{len(out) + 1}", "dimension": "story_rules", "severity": "major", "passage": q,
                        "why": str(c.get("message") or "")[:400],
                        "suggestion": "Make this use follow its rule: give it what it needs (and show it being used "
                                      "up), keep it inside its limits and show its price — or mark it in the plan as "
                                      "a deliberate twist.", "keep_nearby": [], "source": "akowe_magic"})
    return out


# ====================================================================== the writer's brief (store only)
def brief_part(store, pid: str, branch: str, number: int | None, plan_texts: list[str] | None, *,
               all_abilities: bool = False, budget: int = BRIEF_BUDGET) -> dict | None:
    """The abilities the chapter's plan mentions (or all, for a reviewer) with their rules, and the ledger before the
    chapter (from the last kept snapshot), bounded."""
    from . import story_rules  # noqa: PLC0415
    if not enabled(store, pid, branch):
        return None
    abilities = abilities_of(story_rules.get_entry(store, pid, branch))
    if not abilities:
        return None
    plan = " ".join(t for t in plan_texts or [] if t)
    snap = get_entry(store, pid, branch).get("snapshot") or {}
    before = [c for c in snap.get("chapters") or [] if number is None or (c.get("number") or 0) < number]
    used_before = {u.get("ability") for c in before for u in c.get("uses") or []}
    pick = abilities if all_abilities else [a for a in abilities if a["pattern"].search(plan)
                                            or a["name"].lower() in plan.lower()]
    if not pick and not all_abilities:
        pick = [a for a in abilities if a["name"] in used_before][:2]
    if not pick:
        return None
    state = before[-1]["state_after"] if before else {}
    if not before:
        for a in abilities:
            for who, items in a["start"].items():
                for it, n in items.items():
                    state.setdefault(who, {}).setdefault(it, n)
    out = {"abilities": [], "ledger": state_lines(state, None, 6)}
    if before:
        out["ledger_after_chapter"] = before[-1].get("number")
    for a in pick:
        v = view(a)
        v.pop("rule_id", None)
        v.pop("read_from_text", None)
        if len(json.dumps(out["abilities"] + [v], ensure_ascii=False)) > budget - 400:
            break
        out["abilities"].append(v)
    while len(json.dumps(out, ensure_ascii=False)) > budget and out["ledger"]:
        out["ledger"].pop()
    return out if out["abilities"] else None


# ====================================================================== the page and the report
def info(app, principal: str, pid: str, branch: str) -> dict:
    """GET /review/magic: the abilities, the ledger per chapter, the problems, the settings."""
    store = app.review.store
    e = get_entry(store, pid, branch)
    base = {"enabled": e["enabled"], "allowed_breaks": e["allowed_breaks"],
            "fields": [{"key": k, "label": label, "help": hlp} for k, label, hlp in FIELDS], "codes": CODES}
    if not e["enabled"]:
        return dict(base, abilities=[], chapters=[], problems=[], line="✨ The magic-rules check is switched off.")
    try:
        rep = compute(app.engine, principal, pid, branch)
    except Exception:  # noqa: BLE001
        log.exception("could not build the magic ledger")
        rep = None
    if rep is None:
        return dict(base, abilities=[], chapters=[], problems=[], line="")
    uses = sum(len(c["uses"]) for c in rep["chapters"])
    chapters = rep["chapters"]
    if uses > PAGE_USES:
        chapters = [dict(c, uses=c["uses"][:5]) for c in chapters]
    return dict(base, abilities=rep["abilities"], chapters=chapters, problems=rep["problems"],
                state=state_lines(rep["state"], rep.get("prices"), 20), counts=rep["counts"],
                line=summary_line(rep["counts"]))


def report_part(engine, principal: str, pid: str, branch: str) -> dict | None:
    """For the book report: {line, counts, problems (plain lines)} or None (no abilities)."""
    try:
        rep = compute(engine, principal, pid, branch)
    except Exception:  # noqa: BLE001
        log.exception("magic check failed in the report")
        return None
    if rep is None:
        return None
    return {"line": summary_line(rep["counts"]), "counts": rep["counts"],
            "problems": [p["message"] + (f" (deliberate: {p['allowed']})" if p.get("allowed") else "")
                         for p in rep["problems"] if p["severity"] == "major"][:10]}


def route(app, method: str, rest: list, body, principal: str, pid: str, branch: str):
    """rest = the path after ``/review/magic``. Returns (status, body) or None (not ours)."""
    app.review._access(principal, pid, branch)  # noqa: SLF001
    if rest == [] and method == "GET":
        return 200, info(app, principal, pid, branch)
    if rest == ["settings"] and method == "PUT":
        e = save_settings(app.review.store, pid, branch, body)
        return 200, {"ok": True, "enabled": e["enabled"], "allowed_breaks": e["allowed_breaks"],
                     "message": "Saved. " + ("The magic rules are checked in every chapter." if e["enabled"]
                                             else "The magic-rules check is off.")}
    return None
