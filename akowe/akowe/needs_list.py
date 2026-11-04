"""🧠 Smart memory: each chapter's **needs list** (the author's design, "smart memory with chapter needs lists").

Everything stays stored locally (the Forge dossiers, the Book Bible's 🆕 values, the story ledger, the chapters). When
the planner makes a chapter's scene cards (scenes.py ``make``), the same AI answer also carries a **needs list**: per
named thing (a character, place, item, magic system, group, the world or the book) the WHOLE Book Bible sections the
chapter needs, written with the code map's section codes (code_map.py: the digit doubled, ``C11`` = all of Looks),
plus the earlier chapters whose moments it builds on and the running-notes (ledger) sections it needs::

    Chapter 7 needs: Mara C11, C44, C55(Tom) · Tom C33, C77 · Harbour tower P33, P55 · Brass key I22 ·
    Fog-spell M22 · Notes N11(Mara), N44(betrayal) · Earlier: chapter 3 (Tom gives Mara the key)

Single-field codes (``C1c``) are for checks and corrections only: in a needs list they are upgraded to their whole
section (``C11``) with a note; unknown codes, codes of the wrong kind (a ``P`` code for a character) and things the
book does not have are dropped with a note (``clean``). The list is stored with the chapter's scene cards
(``entry["needs"]``) and shown on the chapter page and the Book Bible's chapter page (``page_info``).

The writer then gets exactly those sections (``brief_parts``, used by chapter_brief.py): the accepted values of every
field of each listed section of each listed record (``code_map.expand``), short quoted passages of the named earlier
chapters (``find_passage``: the sentences that best match the moment), and only the ledger sections asked for
(``filter_ledger``). Everything not asked for is left out. The always-on essentials stay (voice cards of the
characters in the scene, the story so far and the end of the previous chapter, the hard story rules, the content
limits / point of view / tense, the scene cards, the length). A listed section still empty is filled just in time,
exactly that section (``jit_subjects``, story_details.before_chapter). Chapters without a needs list (older books,
plans made before this) keep the keyword guessing (forge.letters_for / story_details.needs_letters).

After the chapter: ``after_chapter`` notices what the text used that the list did not plan ("chapter 7 also used Tom
Reed (not planned)") — logged, kept per chapter, given to the next scene plan (``learned``) and listed by the
checkpoints. The per-chapter reviewer and the checkpoints get the list (``review_extra`` / ``checkpoint_part``) and
Akọwe's own check names the exact single-field code when a listed detail does not match the page ("Mara Vell C1c
(eyes)", ``mismatches``). ``book_metric``: how much smaller the writer's instructions were than the old way
("🧠 Smart memory saved ~N% of instruction size").

Storage: the needs list in the scene-card entry; settings ``needs_list:<project>:<branch>`` = ``{"chapters": {cid:
{number, chars, old_chars, saved_pct, at}}, "unplanned": {cid: {number, items: [plain], at}}}``. Pure logic and
reads/writes of the store; never calls an AI; never raises into the caller.
"""
from __future__ import annotations

import copy
import json
import logging
import re
import threading
from datetime import datetime, timezone

from . import code_map

log = logging.getLogger("akowe.needs_list")

KEY = "needs_list:{pid}:{branch}"
MAX_THINGS = 16
MAX_SECTIONS = 8
MAX_EARLIER = 3
MAX_NOTES = 8
PASSAGE_CHARS = 420
VALUE_CHARS = 260
DETAILS_BUDGET = 5200      # characters of JSON for the needed sections in a writing brief
REVIEW_BUDGET = 2600       # … for the reviewer
SECTION_JIT_KEYS = 10      # at most this many fields asked for one empty section
_LOCK = threading.RLock()

KINDS = {"character": "C", "place": "P", "item": "I", "magic": "M", "group": "G", "world": "W", "book": "B"}
LETTERS_OF = {"character": ("C",), "place": ("P",), "item": ("I",), "magic": ("M",), "group": ("G",),
              "world": ("W",), "book": ("B", "S", "H")}
KIND_OF_LETTER = {"C": "character", "P": "place", "I": "item", "M": "magic", "G": "group", "W": "world",
                  "B": "book", "S": "book", "H": "book"}
TOKEN = re.compile(r"^\s*([A-Z])(\d)([\da-z])?\s*(?:\(\s*([^()]{1,60}?)\s*\))?\s*$")
# the ledger keys of the writing brief's story_ledger that each N section stands for (N99 is always on)
LEDGER_KEYS = {"N11": ("people",), "N22": ("people",), "N33": ("people",), "N44": ("who_knows",),
               "N55": ("relationships",), "N66": ("time", "travel"), "N77": ("numbers",), "N88": ("names",),
               "N99": ()}
# W sections that stand for a part of the writing brief (W22 story rules and the rest stay always on)
WORLD_PARTS = {"W55": "world_texture"}

_S = {"type": "string"}
SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["things", "earlier", "notes"],
    "properties": {
        "things": {"type": "array", "maxItems": MAX_THINGS, "items": {
            "type": "object", "additionalProperties": False, "required": ["thing", "kind", "sections", "note"],
            "properties": {"thing": _S, "kind": {"type": "string", "enum": list(KINDS)},
                           "sections": {"type": "array", "maxItems": MAX_SECTIONS, "items": _S}, "note": _S}}},
        "earlier": {"type": "array", "maxItems": MAX_EARLIER, "items": {
            "type": "object", "additionalProperties": False, "required": ["chapter", "moment"],
            "properties": {"chapter": {"type": "integer"}, "moment": _S}}},
        "notes": {"type": "array", "maxItems": MAX_NOTES, "items": _S}}}

PLAN_TASK = (
    "Needs list: also return needs — what the writer of this chapter must be given from the Book Bible, nothing "
    "missing and nothing extra. things: one entry per named character, place, item, magic system, group (or 'world' / "
    "'book') the chapter uses — thing (its exact name from context.characters or context.bible_records), kind, "
    "sections (WHOLE-section codes from context.code_sections: the section digit written twice, e.g. C11 = all of a "
    "character's looks, C33 = voice, P33 = a place's layout, I22 = an item's powers and limits; add the other person "
    "in brackets when it is about them, e.g. C55(Tom)) and note (why, a few words). Never single-field codes like C1c. "
    "earlier: the earlier chapters (number) whose moments this chapter builds on, with the moment in a few words. "
    "notes: the running-notes sections it needs (N11 injuries, N22 what people carry, N33 alive / where, N44 who knows "
    "which secret, N55 relationships, N66 time and travel, N77 money and counts, N88 names), with the person or topic "
    "in brackets, e.g. N11(Mara). Ask only for what the scenes really use; context.needs_learned lists what earlier "
    "chapters used without planning it.")

RULE = ("Needed details (context.writing_brief.needed_details) are exactly the Book Bible sections this chapter's "
        "plan asked for (each line starts with its code, e.g. 'C1c Eyes'): keep every one exactly and show them "
        "through action and description, never as a list. A code in 'fixed' ('all': every one given) was already "
        "used on the page earlier: it must match. Do not invent details for these people, places and things that contradict them.")
EARLIER_RULE = ("Earlier moments (context.writing_brief.earlier_moments) are short passages of earlier chapters this "
                "chapter builds on: keep what they say (who did what, the words used) consistent; do not repeat them.")
REVIEW_NOTE = ("context.needs_list is what this chapter's plan said it needs from the Book Bible (codes and the "
               "values): check that every listed section is consistent on the page; when a detail does not match, name "
               "the exact single-field code and the person, e.g. “Mara Vell C1c (eyes): the page says green, the Book "
               "Bible says storm-grey”. context.needs_list.akowe_flags are mismatches Akọwe's own reading found.")
CHECK_NOTE = (" context.needs_lists: what each chapter's plan said it needs from the Book Bible (whole-section codes) "
              "and the single-field mismatches Akọwe found: check each listed section is consistent on the page, and "
              "when a detail does not match, say its exact code in the problem (e.g. “Mara Vell C1c (eyes)”).")


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _clip(v, n: int = 200) -> str:
    s = " ".join(str(v or "").split())
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def _norm(t: str) -> str:
    return re.sub(r"^(the|a|an)\s+", "", " ".join(str(t or "").lower().split()))


def _words(t: str) -> set:
    return {w for w in re.findall(r"[a-z']{3,}", str(t or "").lower()) if w not in STOP}


STOP = {"the", "and", "for", "with", "her", "his", "their", "she", "him", "they", "them", "that", "this", "from",
        "into", "onto", "was", "were", "has", "had", "have", "but", "not", "who", "what", "when", "where", "then",
        "than", "its", "our", "your", "you", "are", "out", "off", "all", "one", "old", "new"}


def _stem(w: str) -> str:
    for suf in ("ings", "ing", "ies", "es", "ed", "s"):
        if len(w) > len(suf) + 2 and w.endswith(suf):
            return w[: -len(suf)]
    return w


# ====================================================================== the code map side
def sections_brief() -> dict:
    """{kind: "C00 Identity · C11 Looks · …"} — the whole-section codes the planner may use (compact)."""
    out: dict = {}
    for code, s in code_map.sections().items():
        if code[0] in ("S", "H"):
            continue  # the story plan and the chapter are the plan itself
        kind = "notes" if code[0] == "N" else KIND_OF_LETTER[code[0]]
        out.setdefault(kind, []).append(f"{code} {s['label']}")
    return {k: " · ".join(v) for k, v in out.items()}


def parse_token(tok, allowed: tuple) -> tuple[str | None, str | None, str]:
    """(whole-section code or None, about or None, plain note) of one token of a needs list. A field code is upgraded
    to its section; an unknown code or one of another kind gives (None, None, why)."""
    s = str(tok or "")
    m = TOKEN.match(s)
    if not m:
        return None, None, f"“{_clip(s, 30)}” is not a Book Bible code — left out"
    letter, digit, rest, about = m.group(1), m.group(2), m.group(3), m.group(4)
    raw = f"{letter}{digit}{rest or ''}"
    if not code_map.is_code(raw):
        return None, None, f"“{raw}” is not a code the Book Bible has — left out"
    p = code_map.parse(raw)
    if letter not in allowed:
        return None, None, f"“{raw}” is a {code_map.KINDS[letter][0].lower()} code, not for this — left out"
    note = ""
    if not p["whole"]:
        note = f"“{raw}” is one detail; the whole section {p['section']} was asked instead"
    return p["section"], (_clip(about, 60) if about else None), note


# ====================================================================== the records the list names
def _chars(store, pid, branch) -> list[dict]:
    from . import characters as chars_mod  # noqa: PLC0415
    try:
        return chars_mod.canon_characters(store, pid, branch, approved_only=True) or \
            chars_mod.canon_characters(store, pid, branch)
    except Exception:  # noqa: BLE001
        return []


def _dossiers(store, pid, branch, kind) -> list[dict]:
    try:
        from . import forge_kinds  # noqa: PLC0415
        return forge_kinds.list_dossiers(store, pid, branch, kind)
    except Exception:  # noqa: BLE001
        return []


def find_record(store, pid, branch, kind: str, name: str, cache: dict | None = None) -> dict | None:
    """{record_id, name} of the character / place / item / magic system a needs list names, or None."""
    cache = cache if cache is not None else {}
    if kind == "character":
        cs = cache.setdefault("character", _chars(store, pid, branch))
        from . import story_roles  # noqa: PLC0415
        c = story_roles.find(cs, name)
        if c is None:
            n = _norm(name)
            c = next((x for x in cs if _norm(x["name"]).split()[:1] == n.split()[:1] and n), None)
        return {"record_id": c["record_id"], "name": c["name"]} if c else None
    if kind in ("place", "item", "magic"):
        ds = cache.setdefault(kind, _dossiers(store, pid, branch, kind))
        n = _norm(name)
        hit = next((d for d in ds if _norm(d["name"]) == n), None)
        if hit is None:
            w = _words(name)
            hit = next((d for d in ds if w and (_words(d["name"]) <= w or w <= _words(d["name"]))
                        and _words(d["name"])), None)
        if hit is None and kind == "magic" and ds:
            hit = ds[0]  # a named ability ("Fog-spell") lives on the book's magic system
        return {"record_id": hit["record_id"], "name": hit["name"]} if hit else None
    return None


# ====================================================================== 1. clean what the planner returned
def clean(raw, store=None, pid: str | None = None, branch: str | None = None) -> dict | None:
    """The validated needs list, or None when the answer had none. Never raises."""
    try:
        return _clean(raw, store, pid, branch)
    except Exception:  # noqa: BLE001
        log.exception("could not read the needs list")
        return None


def _clean(raw, store, pid, branch) -> dict | None:
    if not isinstance(raw, dict):
        return None
    notes: list[str] = []
    things: list[dict] = []
    cache: dict = {}
    for t in (raw.get("things") or [])[:MAX_THINGS * 2]:
        if not isinstance(t, dict):
            continue
        name = _clip(t.get("thing"), 80)
        toks = [x for x in (t.get("sections") or []) if isinstance(x, str)][:MAX_SECTIONS * 2]
        kind = str(t.get("kind") or "").strip().lower()
        if kind not in KINDS:  # no / an unknown kind: the codes say it
            letters = [x.strip()[:1] for x in toks if x.strip()[:1] in KIND_OF_LETTER]
            kind = KIND_OF_LETTER.get(letters[0]) if letters else ""
        if not name or kind not in KINDS:
            if name or toks:
                notes.append(f"“{name or '?'}”: not a character, place, item, magic, group, world or book — left out")
            continue
        rec = None
        if store is not None and kind in ("character", "place", "item", "magic"):
            rec = find_record(store, pid, branch, kind, name, cache)
            if rec is None and kind == "character":
                notes.append(f"“{name}” is not one of the book's characters — left out")
                continue
        secs: list[dict] = []
        for tok in toks:
            code, about, why = parse_token(tok, LETTERS_OF[kind])
            if why:
                notes.append(f"{name}: {why}")
            if code and not any(s["code"] == code and s.get("about") == about for s in secs):
                secs.append({"code": code, **({"about": about} if about else {})})
        if not secs:
            notes.append(f"{name}: no usable section — left out")
            continue
        same = next((x for x in things if x["kind"] == kind and (x.get("record_id") and rec and x["record_id"]
                                                                   == rec["record_id"] or _norm(x["thing"])
                                                                   == _norm(name))), None)
        if same:  # one thing named twice: one entry
            for s in secs:
                if s not in same["sections"]:
                    same["sections"].append(s)
            continue
        things.append({"thing": name, "kind": kind, **({"record_id": rec["record_id"], "name": rec["name"]}
                                                       if rec else {}),
                       "sections": secs[:MAX_SECTIONS], "note": _clip(t.get("note"), 120)})
    earlier = []
    for e in (raw.get("earlier") or [])[:MAX_EARLIER * 2]:
        if not isinstance(e, dict):
            continue
        try:
            n = int(e.get("chapter"))
        except (TypeError, ValueError):
            notes.append("an earlier chapter without a number — left out")
            continue
        moment = _clip(e.get("moment"), 160)
        if n >= 1 and moment and not any(x["chapter"] == n and x["moment"] == moment for x in earlier):
            earlier.append({"chapter": n, "moment": moment})
    ledger = []
    for tok in (raw.get("notes") or [])[:MAX_NOTES * 2]:
        code, about, why = parse_token(tok, ("N",))
        if why:
            notes.append(f"notes: {why}")
        if code and not any(x["code"] == code and x.get("about") == about for x in ledger):
            ledger.append({"code": code, **({"about": about} if about else {})})
    if not (things or earlier or ledger):
        return None if not notes else {"things": [], "earlier": [], "notes": [], "dropped": notes[:12],
                                       "at": _now()}
    return {"things": things[:MAX_THINGS], "earlier": earlier[:MAX_EARLIER], "notes": ledger[:MAX_NOTES],
            "dropped": notes[:12], "at": _now()}


def has_any(needs: dict | None) -> bool:
    return bool(needs and (needs.get("things") or needs.get("earlier") or needs.get("notes")))


def _sec_text(s: dict) -> str:
    return s["code"] + (f"({s['about']})" if s.get("about") else "")


def _short(t: dict) -> str:
    n = t.get("name") or t["thing"]
    return n.split()[0] if t["kind"] == "character" and n.split() else n


def line(needs: dict | None, number=None) -> str:
    """"Chapter 7 needs: Mara C11, C44 · Harbour tower P33 · Notes N11(Mara) · Earlier: chapter 3 (…)"."""
    if not has_any(needs):
        return ""
    bits = [f"{_short(t)} " + ", ".join(_sec_text(s) for s in t["sections"]) for t in needs.get("things") or []]
    if needs.get("notes"):
        bits.append("Notes " + ", ".join(_sec_text(s) for s in needs["notes"]))
    if needs.get("earlier"):
        bits.append("Earlier: " + "; ".join(f"chapter {e['chapter']} ({e['moment']})" for e in needs["earlier"]))
    return (f"Chapter {number} needs: " if number else "Needs: ") + " · ".join(bits)


def view(needs: dict | None, number=None) -> dict | None:
    """The needs list for a page: the readable line plus every code with its plain label and its fields."""
    if not has_any(needs):
        return None
    secs = code_map.sections()

    def sec(s):
        e = secs.get(s["code"]) or {}
        return {"code": s["code"], "about": s.get("about"), "label": e.get("label") or "",
                "fields": [[c, code_map.fields()[c]["label"]] for c in e.get("fields") or []]}
    return {"line": line(needs, number), "things": [{"thing": t.get("name") or t["thing"], "short": _short(t),
                                                     "kind": t["kind"], "note": t.get("note") or "",
                                                     "sections": [sec(s) for s in t["sections"]]}
                                                    for t in needs.get("things") or []],
            "notes": [sec(s) for s in needs.get("notes") or []], "earlier": list(needs.get("earlier") or []),
            "dropped": list(needs.get("dropped") or [])}


# ====================================================================== where it is kept (with the scene cards)
def of_chapter(store, pid: str, branch: str, outline: dict | None, chapter_id: str) -> dict | None:
    """The chapter's needs list (from its scene cards of THIS outline revision), or None. Never raises."""
    try:
        if not outline:
            return None
        from . import scenes as scenes_mod  # noqa: PLC0415
        e = scenes_mod.get_entry(store, pid, branch, outline["record_id"], chapter_id)
        if not scenes_mod.usable(e, outline):
            return None
        n = (e or {}).get("needs")
        return copy.deepcopy(n) if has_any(n) else None
    except Exception:  # noqa: BLE001
        log.exception("needs list of %s", chapter_id)
        return None


def _key(pid, branch) -> str:
    return KEY.format(pid=pid, branch=branch)


def get_all(store, pid: str, branch: str) -> dict:
    try:
        d = store.get_setting(_key(pid, branch)) or {}
    except Exception:  # noqa: BLE001
        d = {}
    d = copy.deepcopy(d) if isinstance(d, dict) else {}
    for k in ("chapters", "unplanned"):
        if not isinstance(d.get(k), dict):
            d[k] = {}
    return d


def _update(store, pid, branch, fn) -> None:
    try:
        with _LOCK:
            d = get_all(store, pid, branch)
            fn(d)
            store.set_setting(_key(pid, branch), d)
    except Exception:  # noqa: BLE001
        log.exception("could not save the smart-memory notes")


# ====================================================================== 2. the writer gets exactly that
def _bible_vals(store, pid, branch, kind, rid) -> dict:
    if kind != "character":
        return {}
    try:
        from . import binder_fields  # noqa: PLC0415
        return binder_fields.values(store, pid, branch, f"character:{rid}")
    except Exception:  # noqa: BLE001
        return {}


def _fields(store, pid, branch, kind, rid) -> dict:
    from . import story_details  # noqa: PLC0415
    return story_details._dossier_fields(store, pid, branch, kind, rid)  # noqa: SLF001


def expand_record(store, pid, branch, kind: str, rid: str, sections: list[dict], *, limit: int = VALUE_CHARS,
                  fields: dict | None = None) -> tuple[dict, list[str], list[str]]:
    """({"C1c Eyes": text}, forge keys used, empty section codes) — the accepted values of every field of the listed
    sections of one record (only "supplied" / "approved": never a waiting proposal)."""
    fields = fields if fields is not None else _fields(store, pid, branch, kind, rid)
    bible = _bible_vals(store, pid, branch, kind, rid)
    out: dict = {}
    used: list[str] = []
    empty: list[str] = []
    for s in sections:
        about = s.get("about")
        got = 0
        for code in code_map.expand(s["code"]):
            e = code_map.fields()[code]
            val = None
            for fk in e["forge"]:
                fkind, _, key = fk.partition(":")
                f = fields.get(key) if fkind == kind else None
                if f and f.get("text") and f.get("status") in ("supplied", "approved"):
                    val = f["text"]
                    if key not in used:
                        used.append(key)
                    break
            if val is None:
                for bk in e["bible"]:
                    bkind, _, key = bk.partition(":")
                    b = bible.get(key) if bkind == kind else None
                    if b and b.get("value") not in (None, "", []) and b.get("status") in ("supplied", "approved"):
                        val = b["value"] if isinstance(b["value"], str) else json.dumps(b["value"], ensure_ascii=False)
                        break
            if val is None:
                continue
            if about and s["code"].endswith("55") and about.split()[0].lower() not in str(val).lower():
                continue  # C55(Tom): only the lines about Tom
            out[f"{code} {e['label']}"] = _clip(val, limit)
            got += 1
        if not got:
            empty.append(s["code"])
    return out, used, empty


def _locked_codes(store, pid, branch, kind, rid) -> list[str]:
    try:
        from . import story_details  # noqa: PLC0415
        lk = story_details.ledger(store, pid, branch)["locked"].get(f"{kind}:{rid}") or {}
        return [c for c in (code_map.code_of_field(kind, k) for k in lk) if c]
    except Exception:  # noqa: BLE001
        return []


def _texts_of(store, pid, branch) -> dict:
    """{chapter number: (chapter id, approved text)} of the chapters written so far (story ledger, then the record
    the book went on from). Never raises."""
    out: dict = {}
    try:
        from . import story_ledger as sl  # noqa: PLC0415
        for cid, e in (sl.get_all(store, pid, branch).get("chapters") or {}).items():
            if isinstance(e, dict) and e.get("record_id") and isinstance(e.get("number"), int):
                out[e["number"]] = (cid, e["record_id"], e.get("text_version"))
    except Exception:  # noqa: BLE001
        pass
    try:
        from . import continuity  # noqa: PLC0415
        for cid, s in (continuity._recheck_all(store, pid, branch).get("seen") or {}).items():  # noqa: SLF001
            if isinstance(s, dict) and s.get("record_id") and isinstance(s.get("number"), int):
                out.setdefault(s["number"], (cid, s["record_id"], s.get("version")))
    except Exception:  # noqa: BLE001
        pass
    return out


def chapter_text(store, pid, branch, number: int, order: list[str] | None = None) -> str:
    ref = _texts_of(store, pid, branch).get(number)
    if not ref:
        return ""
    try:
        rec = store.get_record(pid, branch, ref[1], ref[2])
        return str(((rec or {}).get("data") or {}).get("text") or "")
    except Exception:  # noqa: BLE001
        return ""


def _sentences(text: str) -> list[str]:
    body = re.sub(r"^#.*\n", "", str(text or ""))
    return [s.strip() for s in re.split(r"(?<=[.!?\"”’])\s+|\n+", body) if s.strip()]


def find_passage(text: str, moment: str, cap: int = PASSAGE_CHARS) -> str:
    """The sentences of ``text`` that best match ``moment`` (word overlap, stems), up to ``cap`` characters; "" when
    nothing matches."""
    sents = _sentences(text)
    want = {_stem(w) for w in _words(moment)}
    if not sents or not want:
        return ""
    scored = []
    for i, s in enumerate(sents):
        got = {_stem(w) for w in _words(s)}
        sc = len(want & got) + 0.01 * len(got & want) / max(1, len(got))
        scored.append((sc, i))
    best, idx = max(scored)
    if best < 1:
        return ""
    out = sents[idx]
    j = idx + 1
    # the next sentence too when it also matches (a moment often spans two)
    if j < len(sents) and {_stem(w) for w in _words(sents[j])} & want and len(out) + len(sents[j]) < cap:
        out += " " + sents[j]
    return _clip(out, cap)


def brief_parts(store, pid: str, branch: str, needs: dict, *, number: int | None = None,
                cut: list | None = None) -> dict:
    """{"details": [...], "earlier": [...], "refs": {ref: [forge keys]}, "empty": [...], "line": str} — the
    writer's needed sections of the listed records. Bounded (DETAILS_BUDGET); a cut is said (brief_cuts)."""
    details, refs, empty = [], {}, []
    cache: dict = {}
    for t in needs.get("things") or []:
        kind = t["kind"]
        if kind not in ("character", "place", "item", "magic"):
            continue  # group / world / book sections are always-on parts or the plan itself
        rec = {"record_id": t["record_id"], "name": t.get("name") or t["thing"]} if t.get("record_id") else \
            find_record(store, pid, branch, kind, t["thing"], cache)
        if not rec:
            empty += [f"{t['thing']} {s['code']}" for s in t["sections"]]
            continue
        vals, used, emp = expand_record(store, pid, branch, kind, rec["record_id"], t["sections"])
        empty += [f"{rec['name']} {c}" for c in emp]
        if used:
            refs[f"{kind}:{rec['record_id']}"] = used
        if vals:
            item = {"kind": kind, "name": rec["name"], "sections": ", ".join(_sec_text(s) for s in t["sections"]),
                    "details": vals}
            fixed = [c for c in _locked_codes(store, pid, branch, kind, rec["record_id"])
                     if any(f"{c} " in k or k.startswith(c + " ") for k in vals)]
            if fixed:  # 🔒 used on the page already: must match ("all" when every value given is fixed)
                item["fixed"] = "all" if len(fixed) == len(vals) else fixed
            details.append(item)
    dropped = []
    while details and len(json.dumps(details, ensure_ascii=False)) > DETAILS_BUDGET:
        last = details[-1]
        if len(last["details"]) > 1:
            k = list(last["details"])[-1]
            dropped.append(f"{last['name']} {k.split()[0]}")
            last["details"].pop(k)
        else:
            dropped.append(f"{last['name']} {last['sections']}")
            details.pop()
    if cut is not None and dropped:
        from . import brief_cuts  # noqa: PLC0415
        brief_cuts.note(cut, "needed Book Bible details", list(reversed(dropped)))
    earlier = []
    for e in needs.get("earlier") or []:
        if number is not None and e["chapter"] >= number:
            continue
        text = chapter_text(store, pid, branch, e["chapter"])
        q = find_passage(text, e["moment"]) if text else ""
        if q:
            earlier.append({"chapter": e["chapter"], "moment": e["moment"], "passage": q})
    return {"details": details, "earlier": earlier, "refs": refs, "empty": empty, "line": line(needs, number)}


def filter_ledger(brief: dict, needs: dict) -> list[str]:
    """Keep only the ledger parts the needs list asked for (the story so far and the end of the previous chapter stay
    always). Returns the parts left out (plain words)."""
    led = brief.get("story_ledger")
    if not isinstance(led, dict):
        return []
    want: set = set()
    people_about: list[str] = []
    people_any = False
    for n in needs.get("notes") or []:
        want |= set(LEDGER_KEYS.get(n["code"], ()))
        if n["code"] in ("N11", "N22", "N33"):
            if n.get("about"):
                people_about.append(n["about"].split()[0].lower())
            else:
                people_any = True
    left = [k for k in list(led) if k not in want and k != "left_out"]
    for k in left:
        led.pop(k, None)
    if led.get("people") and people_about and not people_any:
        keep = [p for p in led["people"] if p.split(":", 1)[0].split()[0].lower() in people_about
                or any(a in p.split(":", 1)[0].lower() for a in people_about)]
        led["people"] = keep or led["people"]
    if not [k for k in led if k != "left_out"]:
        brief.pop("story_ledger", None)
    return left


def world_wanted(needs: dict, part: str) -> bool:
    codes = {s["code"] for t in needs.get("things") or [] for s in t["sections"]}
    return any(WORLD_PARTS.get(c) == part for c in codes)


# ====================================================================== 2b. just in time: exactly the empty sections
def jit_subjects(store, pid: str, branch: str, needs: dict) -> list[dict]:
    """story_details subjects for the listed sections that are still EMPTY (each section's open fields, at most
    SECTION_JIT_KEYS). A listed place or item without a dossier gets one first. Never raises."""
    out: dict = {}
    try:
        from . import story_details as sd  # noqa: PLC0415
        led = sd.ledger(store, pid, branch)
        cache: dict = {}
        for t in needs.get("things") or []:
            kind = t["kind"]
            if kind not in ("character", "place", "item", "magic"):
                continue
            rec = find_record(store, pid, branch, kind, t["thing"], cache) if not t.get("record_id") else \
                {"record_id": t["record_id"], "name": t.get("name") or t["thing"]}
            if rec is None and kind in ("place", "item"):
                rid = sd._ensure(store, pid, branch, kind, t["thing"])  # noqa: SLF001
                cache.pop(kind, None)
                rec = {"record_id": rid, "name": t["thing"]} if rid else None
            if rec is None:
                continue
            fields = _fields(store, pid, branch, kind, rec["record_id"])
            _vals, _used, empty = expand_record(store, pid, branch, kind, rec["record_id"], t["sections"],
                                                fields=fields)
            ref = f"{kind}:{rec['record_id']}"
            decided = set((led["decided"].get(ref) or {}).keys())
            for code in empty:
                keys = []
                for c in code_map.expand(code):
                    for fk in code_map.fields()[c]["forge"]:
                        fkind, _, key = fk.partition(":")
                        if fkind == kind and key not in keys:
                            keys.append(key)
                keys = [k for k in sd._open(fields, keys) if k not in decided][:SECTION_JIT_KEYS]  # noqa: SLF001
                if not keys:
                    continue
                s = out.setdefault(ref, {"kind": kind, "rid": rec["record_id"], "ref": ref, "name": rec["name"],
                                         "keys": [], "optional": [], "why": [], "known": sd._known(fields)})  # noqa: SLF001
                s["keys"] += [k for k in keys if k not in s["keys"]]
                label = (code_map.sections().get(code) or {}).get("label", code).lower()
                w = f"{label} ({code})"
                if w not in s["why"]:
                    s["why"].append(w)
        # what an earlier chapter could not get (AI down): asked again now, as before
        for ref, keys in (led.get("later") or {}).items():
            kind, _, rid = ref.partition(":")
            if kind not in ("character", "place", "item", "magic"):
                continue
            fields = _fields(store, pid, branch, kind, rid)
            open_ = sd._open(fields, keys)  # noqa: SLF001
            if not open_:
                continue
            name = next((f.get("name") for f in fields.values() if f.get("name")), "") or rid
            s = out.setdefault(ref, {"kind": kind, "rid": rid, "ref": ref, "name": name, "keys": [], "optional": [],
                                     "why": [], "known": sd._known(fields)})  # noqa: SLF001
            s["keys"] += [k for k in open_ if k not in s["keys"]]
            if "details left for later" not in s["why"]:
                s["why"].append("details left for later")
    except Exception:  # noqa: BLE001
        log.exception("just-in-time subjects of a needs list")
    return list(out.values())[:8]


# ====================================================================== 3. unplanned uses (after the chapter)
def unplanned(store, pid: str, branch: str, needs: dict, text: str) -> list[str]:
    """What the chapter's text used that its needs list did not plan, in plain words. Deterministic."""
    out: list[str] = []
    if not text:
        return out
    try:
        from . import characters as chars_mod  # noqa: PLC0415
        from . import story_details as sd  # noqa: PLC0415
        cs = _chars(store, pid, branch)
        listed = {t.get("record_id") for t in needs.get("things") or [] if t.get("record_id")}
        listed_names = {_norm(t["thing"]) for t in needs.get("things") or []}
        sents = _sentences(text)
        for c in chars_mod.present_in(cs, text):
            if c["record_id"] not in listed and _norm(c["name"]) not in listed_names:
                out.append(f"{c['name']} (not planned)")
        for kind in ("place", "item"):
            for d in _dossiers(store, pid, branch, kind):
                n = _norm(d["name"])
                if n and len(n) > 3 and n in text.lower() and d["record_id"] not in listed and n not in listed_names:
                    out.append(f"{d['name']} (not planned)")
        # sections of planned characters the page used without the plan asking for them
        checks = (("C11", sd._COLOUR_RE, ("eyes", "hair")), ("C66", sd.NEEDS["fighting"][3], ()),  # noqa: SLF001
                  ("C66", sd.NEEDS["powers"][3], ()), ("C77", sd.NEEDS["skills"][3], ()))
        for t in needs.get("things") or []:
            if t["kind"] != "character":
                continue
            have = {s["code"] for s in t["sections"]}
            first = (t.get("name") or t["thing"]).split()[0]
            mine = [s for s in sents if re.search(r"\b%s\b" % re.escape(first), s)]
            for code, rx, nouns in checks:
                if code in have:
                    continue
                hit = any(rx.search(s) and (not nouns or any(re.search(r"\b%s\b" % n, s, re.I) for n in nouns))
                          for s in mine)
                if hit:
                    w = f"{t.get('name') or t['thing']} {code} ({code_map.sections()[code]['label'].lower()}) " \
                        "(not planned)"
                    if w not in out:
                        out.append(w)
    except Exception:  # noqa: BLE001
        log.exception("unplanned uses")
    return out[:12]


def after_chapter(svc, run, outline: dict, cid: str, number, text: str) -> list[str]:
    """After an approved chapter: log "chapter 7 also used X (not planned)" and keep it (the next plan and the
    checkpoints read it). Never raises."""
    try:
        store, pid, branch = svc.store, run["project_id"], run["branch_id"]
        needs = of_chapter(store, pid, branch, outline, cid)
        if not needs:
            return []
        found = unplanned(store, pid, branch, needs, text)

        def fn(d):
            if found:
                d["unplanned"][cid] = {"number": number, "items": found, "at": _now()}
            else:
                d["unplanned"].pop(cid, None)
        _update(store, pid, branch, fn)
        if found:
            svc.event(run, "note", f"🧠 Chapter {number or cid} also used " + "; ".join(found[:6])
                      + (f" (+{len(found) - 6} more)" if len(found) > 6 else "") + " — the next plans learn from it",
                      step="chapters", chapter_id=cid, code="NEEDS_UNPLANNED")
        return found
    except Exception:  # noqa: BLE001
        log.exception("unplanned uses of %s", cid)
        return []


def learned(store, pid: str, branch: str, before_number: int | None = None, limit: int = 6) -> list[str]:
    """"Chapter 3 also used Tom Reed (not planned)" lines of the chapters before (for the next scene plan)."""
    rows = []
    for cid, e in get_all(store, pid, branch)["unplanned"].items():
        n = e.get("number")
        if before_number is not None and isinstance(n, int) and n >= before_number:
            continue
        for it in e.get("items") or []:
            rows.append((n if isinstance(n, int) else 0, f"Chapter {n or cid} also used {it}"))
    rows.sort()
    return [r[1] for r in rows][-limit:]


def unplanned_of(store, pid: str, branch: str, cids: list[str]) -> list[dict]:
    d = get_all(store, pid, branch)["unplanned"]
    return [dict(d[c], chapter_id=c) for c in cids if c in d]


# ====================================================================== 4. checks (reviewer, checkpoints)
def mismatches(store, pid: str, branch: str, needs: dict, text: str, number=None, cid: str | None = None) -> list[dict]:
    """Listed details the page says otherwise (eye / hair colour of a listed character's looks), each naming the
    exact single-field code: "Chapter 7: Mara Vell C1c (eyes) doesn't match …". Deterministic, never raises."""
    out = []
    try:
        from . import story_details as sd  # noqa: PLC0415
        sents = _sentences(text)
        where = f"Chapter {number}" if number else "This chapter"
        for t in needs.get("things") or []:
            if t["kind"] != "character" or not t.get("record_id"):
                continue
            if not any(s["code"] == "C11" for s in t["sections"]):
                continue
            fields = _fields(store, pid, branch, "character", t["record_id"])
            name = t.get("name") or t["thing"]
            first = name.split()[0]
            mine = [s for s in sents if re.search(r"\b%s\b" % re.escape(first), s)]
            for key, noun in (("eyes", "eyes"), ("hair", "hair")):
                f = fields.get(key) or {}
                if not (f.get("text") and f.get("status") in ("supplied", "approved")):
                    continue
                want = sd._colours(f["text"])  # noqa: SLF001
                for s in mine:
                    got = sd._colours(sd._near(s, noun))  # noqa: SLF001
                    if want and got and not (got & want):
                        code = code_map.code_of_field("character", key)
                        out.append({"chapter_id": cid, "number": number, "code": "NEEDS_MISMATCH",
                                    "field_code": code, "name": name, "quote": _clip(s, 200),
                                    "message": f"{where}: {name} {code} ({key}) doesn't match — the Book Bible says "
                                               f"“{_clip(f['text'], 80)}”, the page says “{' '.join(sorted(got))} "
                                               f"{noun}”"})
                        break
    except Exception:  # noqa: BLE001
        log.exception("needs-list mismatches")
    return out


def _outline_of(store, pid, branch) -> dict | None:
    try:
        heads = [r for r in store.list_records(pid, branch) if r["module_id"] == "B11" and r.get("approved_version")]
        return store.get_record(pid, branch, heads[-1]["record_id"], heads[-1]["approved_version"]) if heads else None
    except Exception:  # noqa: BLE001
        return None


def _review_details(store, pid, branch, needs) -> list[dict]:
    out = []
    for t in needs.get("things") or []:
        if t["kind"] not in ("character", "place", "item", "magic") or not t.get("record_id"):
            continue
        vals, _u, _e = expand_record(store, pid, branch, t["kind"], t["record_id"], t["sections"], limit=160)
        if vals:
            out.append({"name": t.get("name") or t["thing"], "details": vals})
    while out and len(json.dumps(out, ensure_ascii=False)) > REVIEW_BUDGET:
        last = out[-1]
        if len(last["details"]) > 1:
            last["details"].pop(list(last["details"])[-1])
        else:
            out.pop()
    return out


def review_extra(store, pid: str, branch: str, rec: dict) -> dict:
    """For the per-chapter reviewer: {"needs_list": {line, details, akowe_flags}, "needs_note"} or {}."""
    try:
        if rec.get("module_id") != "C02":
            return {}
        meta = store.get_state(pid, branch, "c_meta", rec["record_id"]) or {}
        cid = meta.get("chapter_id") or meta.get("unit_id") or (rec.get("data") or {}).get("chapter_id")
        outline = _outline_of(store, pid, branch)
        if not cid or not outline:
            return {}
        from .book_path import BookPath  # noqa: PLC0415
        order = [c["chapter_id"] for c in BookPath.outline_chapters(None, outline)]
        number = order.index(cid) + 1 if cid in order else None
        needs = of_chapter(store, pid, branch, outline, cid)
        if not needs:
            return {}
        text = str((rec.get("data") or {}).get("text") or "")
        flags = mismatches(store, pid, branch, needs, text, number, cid)
        return {"needs_list": {"line": line(needs, number), "details": _review_details(store, pid, branch, needs),
                               "akowe_flags": [f["message"] for f in flags]}, "needs_note": REVIEW_NOTE}
    except Exception:  # noqa: BLE001
        log.exception("needs list for the review")
        return {}


def checkpoint_part(store, pid: str, branch: str, outline: dict | None, cids: list[str], order: list[str],
                    texts: dict) -> tuple[list[dict], list[dict]]:
    """(needs_lists for the checkpoint's context, mismatch flags) of these chapters. Never raises."""
    rows, flags = [], []
    try:
        unpl = {u["chapter_id"]: u for u in unplanned_of(store, pid, branch, cids)}
        for cid in cids:
            needs = of_chapter(store, pid, branch, outline, cid)
            n = order.index(cid) + 1 if cid in order else None
            if not needs:
                continue
            fl = mismatches(store, pid, branch, needs, (texts.get(cid) or {}).get("text") or "", n, cid)
            flags += fl
            rows.append({"chapter": n, "needs": line(needs, n),
                         **({"mismatches": [f["message"] for f in fl]} if fl else {}),
                         **({"not_planned": unpl[cid]["items"]} if cid in unpl else {})})
    except Exception:  # noqa: BLE001
        log.exception("needs lists for a checkpoint")
    return rows, flags


# ====================================================================== 5. measure
def record_metric(store, pid: str, branch: str, cid: str, number, sm: dict | None) -> None:
    if not sm:
        return

    def fn(d):
        d["chapters"][cid] = dict(sm, number=number, at=_now())
    _update(store, pid, branch, fn)


def metric_of_record(store, pid: str, branch: str, rid: str) -> dict | None:
    """The smart-memory numbers stored with a written chapter (c_meta of its first version: the brief's meta)."""
    try:
        hist = store.history(pid, branch, rid)
        first = hist[0] if hist else None
        meta = store.get_state(pid, branch, "c_meta", (first or {}).get("record_id") or rid) or {}
        sm = (meta.get("brief") or {}).get("smart_memory")
        return dict(sm) if isinstance(sm, dict) else None
    except Exception:  # noqa: BLE001
        return None


def saved_line(pct) -> str:
    return f"🧠 Smart memory saved ~{pct}% of instruction size" if isinstance(pct, (int, float)) and pct > 0 else \
        "🧠 Smart memory: the needs lists asked for about as much as the old way"


def book_metric(store, pid: str, branch: str) -> dict | None:
    """{chapters, chars, old_chars, saved_pct, line} over the chapters written with a needs list, or None."""
    rows = [e for e in get_all(store, pid, branch)["chapters"].values()
            if isinstance(e, dict) and e.get("old_chars")]
    if not rows:
        return None
    new = sum(int(e.get("chars") or 0) for e in rows)
    old = sum(int(e.get("old_chars") or 0) for e in rows)
    pct = round(100 * (old - new) / old) if old else 0
    return {"chapters": len(rows), "chars": new, "old_chars": old, "saved_pct": pct, "line": saved_line(pct),
            "per_chapter": sorted([{"number": e.get("number"), "chars": e.get("chars"), "old_chars": e.get("old_chars"),
                                    "saved_pct": e.get("saved_pct")} for e in rows],
                                  key=lambda r: r["number"] if isinstance(r["number"], int) else 999)}


def page_info(store, pid: str, branch: str, outline: dict | None, cid: str, number=None) -> dict | None:
    """The chapter page's 🧠 box: the needs list (line, codes with labels), what was not planned, the size saved."""
    needs = of_chapter(store, pid, branch, outline, cid)
    v = view(needs, number)
    d = get_all(store, pid, branch)
    sm = d["chapters"].get(cid)
    un = (d["unplanned"].get(cid) or {}).get("items") or []
    if not v and not sm:
        return None
    return {"number": number, "needs": v, "smart_memory": dict(sm, line=saved_line(sm.get("saved_pct"))) if sm else None,
            "not_planned": un}
