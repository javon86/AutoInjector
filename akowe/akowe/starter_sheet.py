"""📋 6c Paste starter sheet: read the "AKỌWE STARTER SHEET" an AI wrote and fill the ⚡ Make-a-book screen from it.

The author plans a book with a master prompt in a chat AI; its answer ends in a sheet with these headings:
1. YOUR IDEA, 2. GENRE, 3. LENGTH, 4. ENDING, 5. HOW MUCH IS EXPLAINED, 6. DARKNESS AND PERIL, 7. DIALOGUE, 8. PACE,
9. HUMOR, 10. HOW THE STORY TREATS THE CHARACTERS, 11. STORY SHAPE, 12. KIND OF STORY, 13. RUN OPTIONS, 14. LOCK LIST.

``parse(text)`` is tolerant, because AIs decorate: headings with or without numbers, ▶ / ► markers, emoji, markdown
(``#``, ``**bold**``), the heading's answer on the same line or the lines below, the whole option list echoed with the
chosen one marked, "On/Off" written as Yes / ✅ / enabled …, code fences, and chatty lines before and after the sheet.
It returns what it understood in the Make-a-book screen's own values (``story_choices``, ``story_shape``,
``story_kind``, ``character_mode``, the run options) plus, in plain words, what was filled, what was not understood
and what is too long (the idea's 2 000 and the genre's 120 characters) — the page shows that before anything is
applied.

The LOCK LIST (facts that must stay true) becomes the run setting ``locks``: the run tells the AI that invents the
book about them, and puts each one into the book's story-rules ledger as a hard rule from the author (📏 Story rules
— the place where the book's fixed facts live and that the planners, the writer's brief, the editor and the
consistency checks read; ``seed_locks``). Nothing here is logged.
"""
from __future__ import annotations

import logging
import re
import unicodedata

log = logging.getLogger("akowe.starter_sheet")

IDEA_MAX = 2000
GENRE_MAX = 120
LOCKS_MAX = 20
LOCK_MAX = 300
LOCK_SOURCE = "Your starter sheet (lock list)"

# (key, label, aliases that are ALWAYS a heading, short aliases that count only when numbered / in capitals)
HEADINGS = (
    ("idea", "Your idea", ("YOUR IDEA", "THE IDEA", "BOOK IDEA", "STORY IDEA"), ("IDEA",)),
    ("genre", "Genre", ("GENRE",), ()),
    ("length", "Length", ("LENGTH", "BOOK LENGTH"), ()),
    ("ending", "Ending", ("ENDING", "THE ENDING"), ()),
    ("explain", "How much is explained", ("HOW MUCH IS EXPLAINED",), ("EXPLAINED", "EXPLANATION")),
    ("darkness", "Darkness and peril", ("DARKNESS AND PERIL", "DARKNESS PERIL"), ("DARKNESS", "PERIL")),
    ("dialogue", "Dialogue", ("DIALOGUE", "DIALOG"), ()),
    ("pace", "Pace", ("PACE", "PACING"), ()),
    ("humor", "Humor", ("HUMOR", "HUMOUR"), ()),
    ("characters", "How the story treats the characters", ("HOW THE STORY TREATS THE CHARACTERS",
                                                           "HOW THE STORY TREATS CHARACTERS"), ("CHARACTERS",)),
    ("shape", "Story shape", ("STORY SHAPE", "STORY STRUCTURE"), ("SHAPE", "STRUCTURE")),
    ("kind", "Kind of story", ("KIND OF STORY", "BASIC PLOT", "TYPE OF STORY"), ("KIND",)),
    ("run", "Run options", ("RUN OPTIONS", "RUN SETTINGS"), ("OPTIONS", "SETTINGS")),
    ("locks", "Lock list", ("LOCK LIST", "LOCKED FACTS", "LOCKS LIST"), ("LOCKS", "LOCKED")),
)
LABEL = {k: label for k, label, *_ in HEADINGS}

AI = ("let the ai choose", "let the ai decide", "ai chooses", "ai decides", "ai choose", "ai decide",
      "you choose", "you decide", "any", "no preference", "none — let the ai decide")
# key -> ((value, plain label, (patterns…)), …); value "" = let the AI choose / decide
OPTIONS = {
    "length": (("short_story", "Short story", (r"short[\s-]*story", r"\bshort\b")),
               ("novelette", "Novelette", (r"novelette",)),
               ("novella", "Novella", (r"novella",)),
               ("novel", "Novel", (r"\bnovel\b(?!la|ette)",))),
    "ending": (("neat", "Neat", (r"\bneat\b",)), ("bittersweet", "Bittersweet", (r"bitter[\s-]*sweet",)),
               ("open", "Open", (r"\bopen\b",)), ("dark", "Dark", (r"\bdark\b",))),
    "explain": (("explain", "Explain everything", (r"explain(s|ed)?\s+everything", r"\bexplain\b")),
                ("hint", "Hint", (r"\bhints?\b",)),
                ("leave", "Leave mysteries", (r"leave\s+(the\s+)?myster", r"\bleave\b", r"myster(y|ies)\s+stay"))),
    "darkness": (("gentle", "Gentle", (r"\bgentle\b",)), ("some", "Some danger", (r"some\s+danger", r"\bsome\b")),
                 ("real", "Real danger", (r"real\s+danger", r"\breal\b"))),
    "dialogue": (("little", "Little", (r"\blittle\b",)), ("some", "Some", (r"\bsome\b",)),
                 ("lots", "Lots", (r"\blots\b", r"\ba\s+lot\b"))),
    "pace": (("slow", "Slow", (r"\bslow\b",)), ("medium", "Medium", (r"\bmedium\b",)), ("fast", "Fast", (r"\bfast\b",))),
    "humor": (("none", "None", (r"\bnone\b", r"\bno\s+humou?r\b")), ("some", "Some", (r"\bsome\b",))),
    "characters": (("character_led", "Character-led", (r"character[\s-]*led",)),
                   ("balanced", "Balanced", (r"\bbalanced\b",)),
                   ("plot_led", "Plot-led", (r"plot[\s-]*led",))),
    "shape": (("three_acts", "Three acts", (r"(three|3)[\s-]*acts?\b",)),
              ("save_the_cat", "Save the Cat", (r"save\s+the\s+cat",)),
              ("heros_journey", "Hero's Journey", (r"hero'?’?s?\s+journey",)),
              ("seven_point", "Seven-point", (r"(seven|7)[\s-]*point",))),
    "kind": (("monster", "Overcoming the Monster", (r"overcoming\s+the\s+monster", r"\bmonster\b")),
             ("rags_to_riches", "Rags to Riches", (r"rags\s+to\s+riches",)),
             ("quest", "The Quest", (r"\bquest\b",)),
             ("voyage_return", "Voyage and Return", (r"voyage\s+(and|&)\s+return",)),
             ("comedy", "Comedy", (r"\bcomedy\b",)), ("tragedy", "Tragedy", (r"\btragedy\b",)),
             ("rebirth", "Rebirth", (r"\brebirth\b",))),
}
AI_ALLOWED = {"ending", "shape", "kind", "explain", "darkness", "dialogue", "pace", "humor"}
MARK = re.compile(r"(▶|►|➤|➜|→|=>|✅|✔|☑|\[x\]|\(x\)|⬅|←|<-+|👉|\*\*)", re.I)
ON = re.compile(r"^\W*(on|yes|y|true|enabled?|✅|✔|☑|use it|include)\b", re.I)
OFF = re.compile(r"^\W*(off|no|n|false|disabled?|❌|✖|✗|skip|none)\b", re.I)
COMMENT = re.compile(r"^\s*(\(|note\b|notes\b|why\b|reason\b|because\b|comment\b|tip\b|i\s+(chose|picked|went)\b|"
                     r"this\s+(gives|keeps|makes|means)\b)", re.I)
CHAT_END = re.compile(r"^\s*(let me know|hope this|feel free|happy writing|good luck|if you('d)? like|would you like|"
                      r"want me to|shall i|you can (now )?paste|enjoy|i can also)", re.I)
RULE = re.compile(r"^\s*([-*_=]\s*){3,}$")
FENCE = re.compile(r"^\s*(```|~~~)")
BULLET = re.compile(r"^\s*(?:[-*•·▪◦‣⁃]|\d{1,2}[.)]|[a-z][.)]|\[[ x]\])\s+", re.I)
RUN_KEYS = (  # run option -> how to recognise it in a line
    ("pictures", re.compile(r"(character\s+)?pictures?|portraits?|images?", re.I)),
    ("fill_bible", re.compile(r"(fill\s+(the\s+)?(whole\s+)?)?book\s+bible|whole\s+bible", re.I)),
    ("checkers", re.compile(r"(ais?\s+)?check(ing|ers?)?(\s+for\s+mistakes)?|mistakes", re.I)),
    ("writers_room", re.compile(r"writers?['’]?\s*room", re.I)),
    ("beta_readers", re.compile(r"beta[\s-]*readers?", re.I)),
    ("single_ai", re.compile(r"when\s+only\s+one\s+ai(\s+works)?|only\s+one\s+ai|single\s+ai|one\s+ai\s+works", re.I)),
)
RUN_LABEL = {"pictures": "Character pictures", "fill_bible": "Fill the whole Book Bible",
             "checkers": "AIs checking for mistakes", "writers_room": "Writers' room", "beta_readers": "Beta readers",
             "single_ai": "When only one AI works"}
SHEET = re.compile(r"ak[oọ]̣?we\s+starter\s+sheet", re.I)


# ====================================================================== cleaning helpers
def _strip_marks(s: str) -> str:
    """Drop emoji, markdown decoration and markers, keep words."""
    s = unicodedata.normalize("NFC", s or "")
    s = re.sub(r"[`*_#>]+", " ", s)
    s = re.sub(r"[▶►➤➜→⬅←👉✅✔☑❌✖✗•·▪◦‣⁃]", " ", s)
    s = "".join(ch for ch in s if not (unicodedata.category(ch) == "So" or 0x1F000 <= ord(ch) <= 0x1FFFF
                                       or 0xFE00 <= ord(ch) <= 0xFE0F or ord(ch) == 0x200D))
    return re.sub(r"\s+", " ", s).strip()


def _norm(s: str) -> str:
    return re.sub(r"[^A-Z ]+", " ", _strip_marks(s).upper().replace("’", "'").replace("'", "")).strip()


def _heading(line: str):
    """(key, rest of the line) when this line is a sheet heading, else None."""
    raw = line.strip()
    if not raw or len(raw) > 2000:
        return None
    md = bool(re.match(r"^\s*(#{1,6}\s|\*\*|__)", raw))
    s = _strip_marks(raw)
    m = re.match(r"^(?:step\s+)?(\d{1,2})\s*[.):\-–—]?\s+(.*)$", s, re.I)
    numbered = bool(m and 1 <= int(m.group(1)) <= 14)
    body = m.group(2) if m and numbered else s
    head, rest = body, ""
    sp = re.match(r"^(.{2,60}?)\s*(?::|—|–|\s-\s|=)\s*(.*)$", body)
    if sp:
        head, rest = sp.group(1), sp.group(2)
    letters = re.sub(r"[^A-Za-z]", "", head)
    caps = bool(letters) and letters.upper() == letters
    name = _norm(head)
    if sp:  # the answer on the heading's line, from the raw line (keeps the "·" between run options)
        m2 = re.search(r"(?::|—|–|\s-\s|=)\s*(.*)$", raw)
        if m2:
            rest = re.sub(r"^[*_\s]+", "", m2.group(1))
    for key, _label, full, short in HEADINGS:
        if name in full and (numbered or caps or md or sp is not None):
            return key, rest.strip()
        if name in short and (numbered or caps):
            return key, rest.strip()
    return None


def _clean_value_line(s: str) -> str:
    s = re.sub(r"^\s*(answer|your (choice|answer|pick)|choice|value)\s*[:\-–—]\s*", "", s, flags=re.I)
    s = re.sub(r"\*\*|__|`", "", s)
    s = re.sub(r"^[\s▶►➤➜→👉>\-*•]+", "", s)
    return s.strip().strip('"“”').strip()


def _sections(text: str) -> tuple[dict, bool]:
    """{heading key: [value lines]} and whether the sheet's title was found."""
    lines = (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    start, found = 0, False
    for i, ln in enumerate(lines):
        if SHEET.search(_strip_marks(ln)) or SHEET.search(ln):
            start, found = i + 1, True  # the LAST title wins (the prompt may quote it before the answer)
    out: dict[str, list] = {}
    cur = None
    for ln in lines[start:]:
        if FENCE.match(ln):
            continue
        if RULE.match(ln) and cur:
            if cur == "locks":
                cur = None
            continue
        h = _heading(ln)
        if h:
            cur = h[0]
            out.setdefault(cur, [])
            if h[1]:
                out[cur].append(h[1])
            continue
        if cur is None:
            continue
        if CHAT_END.match(_strip_marks(ln)):
            cur = None
            continue
        out[cur].append(ln.rstrip())
    return out, found


# ====================================================================== one choice
def _option(key: str, lines: list[str]):
    """(value, plain label) | ("?", text) when not understood | None when empty."""
    vals = [ln for ln in (_clean_value_line(x) for x in lines) if ln]
    if not vals:
        return None
    opts = OPTIONS[key]

    def hits(s):
        low = s.lower()
        found = []
        for v, label, pats in opts:
            for p in pats:
                m = re.search(p, low)
                if m:
                    found.append((m.start(), v, label))
                    break
        if key in AI_ALLOWED and any(a in low for a in AI[:8] + (("none",) if key in ("shape",) else ())):
            if not (key == "humor" and re.search(r"\bnone\b", low)):
                pos = min([low.find(a) for a in AI[:8] if a in low] or [0])
                found.append((pos, "", "Let the AI choose" if key not in ("shape", "kind") else "Let the AI decide"))
        return sorted(found)

    raw = [x for x in lines if x.strip()]
    # 1. a marked option (▶ Bittersweet, ✅ Neat, **Open**, [x] Dark)
    for ln in raw:
        if MARK.search(ln):
            seg = ln
            m = re.search(r"(?:▶|►|➤|➜|→|=>|✅|✔|☑|\[x\]|\(x\)|👉)\s*([^/|·,;▶►]+)", ln, re.I) or \
                re.search(r"\*\*([^*]+)\*\*", ln)
            if m:
                seg = m.group(1)
            h = hits(seg)
            if len({v for _p, v, _l in h}) == 1:
                return h[0][1], h[0][2]
    # 2. the first line that names exactly one option (commentary lines are skipped)
    for s in vals:
        if COMMENT.match(s):
            continue
        main = re.split(r"\s[\(\[—–-]\s?|\s\(|:\s", s, maxsplit=1)[0] or s
        h = hits(main)
        distinct = {v for _p, v, _l in h}
        if len(distinct) == 1:
            return h[0][1], h[0][2]
        if len(distinct) > 1:
            if len(distinct) >= 3 or re.search(r"[/|·]", main):  # the whole option list, nothing marked
                continue
            return h[0][1], h[0][2]  # "Bittersweet, almost dark" -> the first named
    return "?", " ".join(vals)[:200]


# ====================================================================== run options
def _run_options(lines: list[str]) -> tuple[dict, list]:
    out, bad = {}, []
    segs = []
    for ln in lines:
        for seg in re.split(r"\s[·|]\s|·|;|\|", ln):
            seg = _clean_value_line(seg)
            if seg and not COMMENT.match(seg):
                segs.append(seg)
    for seg in segs:
        for key, pat in RUN_KEYS:
            m = pat.search(seg)
            if not m:
                continue
            val = seg[m.end():]
            val = re.sub(r"^\s*(works)?\s*[:=\-–—]?\s*", "", val)
            got = _run_value(key, val, seg)
            if got is None:
                bad.append({"label": RUN_LABEL[key], "text": seg[:160]})
            else:
                out[key] = got
            break
    return out, bad


def _run_value(key: str, val: str, seg: str):
    marked = re.search(r"(?:▶|►|➤|→|✅|✔|☑|\[x\]|👉)\s*(\w[\w ]*)", seg, re.I)
    v = (marked.group(1) if marked else val).strip()
    low = _strip_marks(v).lower()
    if key in ("pictures", "fill_bible", "writers_room"):
        if re.search(r"\bon\b", low) and re.search(r"\boff\b", low) and not marked:
            return None  # "On/Off" echoed, nothing chosen
        if re.match(r"^\W*[✅✔☑]", v) and not re.search(r"\boff\b", low):
            return True
        if re.match(r"^\W*[❌✖✗]", v):
            return False
        if ON.match(low) or ON.match(v):
            return True
        if OFF.match(low) or OFF.match(v):
            return False
        return None
    if key == "checkers":
        for word, out in (("all", "all"), ("three", "all"), ("3", "all"), ("two", "two"), ("2", "two"),
                          ("one", "one"), ("1", "one")):
            if re.match(rf"^\W*{word}\b", low):
                return out
        return None
    if key == "beta_readers":
        if OFF.match(low):
            return 0
        m = re.match(r"^\W*(\d|one|two|three)\b", low)
        if m:
            return {"one": 1, "two": 2, "three": 3}.get(m.group(1), None) or min(3, max(0, int(m.group(1))))
        if ON.match(low):
            return 1
        return None
    if key == "single_ai":
        if re.match(r"^\W*(continue|keep going|carry on|go on)", low):
            return "continue"
        if re.match(r"^\W*wait", low):
            return "wait"
        if re.match(r"^\W*(ask|stop)", low):
            return "ask"
        return None
    return None


# ====================================================================== the lock list
def _locks(lines: list[str]) -> list[str]:
    raw = [ln for ln in lines if ln.strip()]
    bullets = [ln for ln in raw if BULLET.match(ln) or re.match(r"^\s*[▶►🔒]", ln)]
    items = []
    for ln in (bullets or raw):
        s = BULLET.sub("", ln, count=1)
        s = _clean_value_line(re.sub(r"^\s*[🔒▶►]\s*", "", s))
        s = re.sub(r"\s+", " ", s).strip()
        if not s or re.fullmatch(r"(none|nothing|n/?a|-+|\(none\)|no locks?)\.?", s, re.I):
            continue
        items.append(s[:LOCK_MAX])
        if len(items) >= LOCKS_MAX:
            break
    return items


def _trim(text: str, n: int) -> str:
    """Cut at the last sentence end before ``n`` characters (else the last space)."""
    if len(text) <= n:
        return text
    cut = text[:n]
    m = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "), cut.rfind(".\n"))
    if m >= n * 0.6:
        return cut[:m + 1].rstrip()
    sp = cut.rfind(" ")
    return (cut[:sp] if sp > n * 0.6 else cut).rstrip()


# ====================================================================== the whole sheet
def parse(text) -> dict:
    """Read a pasted starter sheet. Never raises on odd text: what it cannot read is listed, in plain words."""
    text = str(text or "")[:60000]
    secs, found = _sections(text)
    fields: dict = {"idea": None, "genre": None, "length": None, "choices": {}, "run": {}, "locks": []}
    filled, bad, missing, long_ = [], [], [], []
    # the idea and the genre: free text
    for key, mx in (("idea", IDEA_MAX), ("genre", GENRE_MAX)):
        lines = [_clean_value_line(x) for x in secs.get(key) or []]
        val = "\n".join(x for x in lines if x and not (key == "genre" and COMMENT.match(x))).strip()
        if key == "genre":
            val = val.split("\n")[0].strip()
        if not val:
            if key in secs:
                bad.append({"key": key, "label": LABEL[key], "text": "(empty)"})
            else:
                missing.append(LABEL[key])
            continue
        fields[key] = val
        filled.append({"key": key, "label": LABEL[key], "value": val if len(val) <= 140 else val[:137] + "…"})
        if len(val) > mx:
            long_.append({"key": key, "label": LABEL[key], "length": len(val), "max": mx, "trimmed": _trim(val, mx)})
    # the choices
    for key in ("length", "ending", "explain", "darkness", "dialogue", "pace", "humor", "characters", "shape", "kind"):
        if key not in secs:
            missing.append(LABEL[key])
            continue
        got = _option(key, secs[key])
        if got is None:
            bad.append({"key": key, "label": LABEL[key], "text": "(empty)"})
        elif got[0] == "?":
            bad.append({"key": key, "label": LABEL[key], "text": got[1]})
        else:
            if key == "length":
                fields["length"] = got[0]
            else:
                fields["choices"][key] = got[0]
            filled.append({"key": key, "label": LABEL[key], "value": got[1]})
    # run options
    if "run" in secs:
        run, rbad = _run_options(secs["run"])
        fields["run"] = run
        for k, v in run.items():
            word = {True: "On", False: "Off"}.get(v, v) if not isinstance(v, int) or isinstance(v, bool) else \
                ("Off" if v == 0 else str(v))
            word = {"all": "All", "two": "Two", "one": "One", "continue": "Continue", "wait": "Wait",
                    "ask": "Ask me"}.get(word, word)
            filled.append({"key": f"run.{k}", "label": RUN_LABEL[k], "value": str(word)})
        bad += [dict(b, key="run") for b in rbad]
        for k, lab in RUN_LABEL.items():
            if k not in run and not any(b["label"] == lab for b in rbad):
                missing.append(lab)
    else:
        missing.append(LABEL["run"])
    # the lock list
    if "locks" in secs:
        fields["locks"] = _locks(secs["locks"])
        if fields["locks"]:
            filled.append({"key": "locks", "label": LABEL["locks"],
                           "value": f"{len(fields['locks'])} fact(s) that must stay true"})
    else:
        missing.append(LABEL["locks"])
    understood = bool(filled)
    return {"ok": understood, "found_sheet": found, "fields": fields, "filled": filled, "not_understood": bad,
            "missing": missing, "too_long": long_,
            "message": ("" if understood else "Akọwe could not find a starter sheet in what you pasted. Paste the "
                        "AI's whole answer, including the part that starts with “AKỌWE STARTER SHEET”."),
            "locks_where": ("The lock list goes into the book's 📏 Story rules as rules from you (a fact that must "
                            "stay true). The AI that invents the book is told about them, and the planners, the "
                            "writer, the editor and the consistency checks all read the story rules.")}


# ====================================================================== the run setting and the ledger
def clean_locks(raw) -> list[str]:
    """The run setting ``locks``: a list of up to 20 short facts (REJECTED INVALID_INPUT otherwise)."""
    from .errors import AkoweError  # noqa: PLC0415
    if raw in (None, "", []):
        return []
    if not isinstance(raw, list) or len(raw) > LOCKS_MAX or not all(isinstance(x, str) for x in raw):
        raise AkoweError("INVALID_INPUT", "/locks", f"the lock list: up to {LOCKS_MAX} short facts",
                         status="REJECTED")
    out = []
    for x in raw:
        s = re.sub(r"\s+", " ", x).strip()
        if len(s) > LOCK_MAX:
            raise AkoweError("INVALID_INPUT", "/locks", f"each fact of the lock list: up to {LOCK_MAX} characters",
                             status="REJECTED")
        if s and s not in out:
            out.append(s)
    return out


def seed_locks(store, pid: str, branch: str, locks: list[str]) -> int:
    """Put the lock list into the book's story-rules ledger as hard rules from the author (once each). Returns how
    many were added."""
    from . import story_rules  # noqa: PLC0415
    if not locks:
        return 0
    entry = story_rules.get_entry(store, pid, branch)
    rules = [dict(r) for r in (entry or {}).get("rules") or []]
    have = {str(r.get("text") or "").strip().lower() for r in rules}
    add = [x for x in locks if x.strip().lower() not in have]
    if not add:
        return 0
    ids = {r.get("id") for r in rules}
    for text in add:
        n = len(rules) + 1
        while f"lock{n}" in ids:
            n += 1
        ids.add(f"lock{n}")
        rules.append({"id": f"lock{n}", "category": "hard_rule", "text": text[:LOCK_MAX], "scope": "",
                      "source": LOCK_SOURCE, "stated_by": "the author", "status": "active"})
    if len(rules) > story_rules.MAX_RULES:  # the ledger is full: the author's locks stay, the AI's last rules go
        mine = [r for r in rules if r.get("source") == LOCK_SOURCE]
        rest = [r for r in rules if r.get("source") != LOCK_SOURCE][:max(0, story_rules.MAX_RULES - len(mine))]
        keep = {id(r) for r in mine + rest}
        rules = [r for r in rules if id(r) in keep]
    rules = story_rules.clean_rules(rules, limit=story_rules.MAX_RULES)
    story_rules.save(store, pid, branch, rules, by="author", how="starter_sheet", keep_proposals=True)
    return len(add)
