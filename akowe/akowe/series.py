"""📚 Series progression: the same characters through book 1, book 2, book 3…

A character has two layers:

* **Fixed across the series** (``FIXED_ATTRS`` of the A01 canon — who they are (identity, name), their traits
  (personality) and their background / origin — and their voice card). A sequel never overwrites them: the sequel's
  canon gets them copied from the first book they appear in, an AI fix of the character in a later book gets them
  put back word for word (``protect_fixed``, called by ``review._run_fix``), and an AI save of the character sheet
  keeps the voice card (``characters.save_entry`` with the entry's ``series_fixed`` mark).
* **Changeable per book** (``CATS``): appearance (scars, hair, age, clothes, body), items / tools gained and lost,
  abilities gained and lost, relationships, and status (alive, injured, a title…). Each book stores only its
  **changes** (a delta per character, with the chapter when known). ``state_as_of(series, key, n, "start"|"end")``
  applies the deltas in book order.

Where the data lives (settings, like every other companion list):

* ``series:<series_id>`` — the series: its name, its books in order (``number`` → project), the characters (a series
  key per person with the record ID in each book, the fixed layer and the first look), the approved changes per book,
  the AI's proposals waiting for the author, and the portraits made per book. The key never holds a project ID, so
  deleting one book never deletes the series (the other books keep their history).
* ``series_of:<project_id>`` — which series a book belongs to and its number (deleted with the book).

A book that is not in a series is a series of one: every read works on a virtual series (``of_book``) and nothing is
stored until the author does something (find what changed, start a sequel).

Change capture (``find_changes``): the AI reads the book's chapters and proposes each character's changes in THIS
book. Proposals are never used until the author approves them; an approved change (or the author's own edit) is never
replaced by a later proposal (approving merges, it never removes what is there); the proposal form has no fixed-layer
fields at all, so the AI cannot touch personality, voice, name or origin.

Start a sequel (``start_sequel``): the book bible of this book, changed to the END of this book (fixed layers copied
and protected, appearance / relationships at their end state, a new premise / plot / outline), started as a ⚡ Make a
book run with the sequel hook as the idea. The run registers the new book as the next number of the series and links
its characters to the series keys.

Per-book portraits (``make_portraits``): a character whose appearance changed in book N gets a new portrait for book
N — made through AutoInjector with the SAME 🔒 character lock (the character's fixed name), prompt = the fixed look +
book N's appearance changes. Earlier portraits are kept. Picture maker down → the portrait waits on the to-make list
(the Book Bible's 🖼 Make the rest of the pictures makes it too).
"""
from __future__ import annotations

import copy
import logging
import re
import threading
import uuid

from . import series_world as world
from .errors import AkoweError
from .jobs import now_iso

log = logging.getLogger("akowe.series")

SERIES_KEY = "series:{sid}"
MEMBER_KEY = "series_of:{pid}"
FIXED_ATTRS = ("identity", "traits", "background")
FIXED_LABELS = {"name": "Name", "identity": "Who they are", "traits": "Personality", "background": "Background and "
                "origin", "voice": "Speaking voice (voice card)"}
# (key, plain label, ⓘ help) — the ONE place where the changeable layer is named
CATS = (
    ("appearance", "Appearance", "What changed in how they look: a scar, a lost eye, new hair, older, other clothes, "
                                 "a changed body."),
    ("items_gained", "Gained (items, tools)", "Things they now carry or own."),
    ("items_lost", "Lost (items, tools)", "Things they lost, gave away or broke."),
    ("abilities_gained", "Can now", "New abilities or skills."),
    ("abilities_lost", "Can no longer", "Abilities or skills they lost."),
    ("relationships", "Relationships", "Who is now an ally, an enemy, a friend, a lover… (one line per person)."),
    ("status", "Status", "Alive or dead, injured, a new title or job, where they are now."),
)
CAT_KEYS = tuple(k for k, _l, _h in CATS)
TEXT_MAX = 300
WITH_MAX = 120
CHAPTER_MAX = 40
PER_CAT = 12
APPEARANCE_MAX = 1500
BRIEF_BUDGET = 2400
CHANGE_TEXT_BUDGET = 48000
_LOCK = threading.RLock()


def _err(code: str, path: str, message: str) -> AkoweError:
    return AkoweError(code, path, message, status="REJECTED")


def _clip(v, n: int) -> str:
    return " ".join(str(v or "").split())[:n] if isinstance(v, (str, int, float)) and not isinstance(v, bool) else ""


def norm(name) -> str:
    return " ".join(re.sub(r"[^\w\s]", " ", str(name or "").casefold()).split())


# ====================================================================== the change of one book (a delta)
def _entry(raw, rel: bool = False) -> dict | None:
    if isinstance(raw, str):
        raw = {"text": raw}
    if not isinstance(raw, dict):
        return None
    text = _clip(raw.get("text") or raw.get("change") or raw.get("now"), TEXT_MAX)
    if not text:
        return None
    out = {"text": text, "chapter": _clip(raw.get("chapter"), CHAPTER_MAX) or None}
    if rel:
        w = _clip(raw.get("with") or raw.get("who"), WITH_MAX)
        if not w:
            return None
        out["with"] = w
    return out


def clean_delta(raw) -> dict:
    """A delta read from the AI or the author: every category a list of {text, chapter} ({with, text, chapter} for
    relationships), at most ``PER_CAT`` each; anything else (a fixed-layer field) is dropped."""
    raw = raw if isinstance(raw, dict) else {}
    out = {}
    for k in CAT_KEYS:
        v = raw.get(k)
        if isinstance(v, (str, dict)):
            v = [v]
        items = []
        seen = set()
        for x in v if isinstance(v, list) else []:
            e = _entry(x, rel=k == "relationships")
            if e is None:
                continue
            sig = (norm(e.get("with")), norm(e["text"]))
            if sig in seen:
                continue
            seen.add(sig)
            items.append(e)
            if len(items) >= PER_CAT:
                break
        out[k] = items
    return out


def delta_empty(d) -> bool:
    return not any((d or {}).get(k) for k in CAT_KEYS)


def merge_delta(old: dict, new: dict) -> dict:
    """``old`` plus the entries of ``new`` it does not have yet (never removes anything)."""
    out = clean_delta(old)
    for k in CAT_KEYS:
        have = {(norm(e.get("with")), norm(e["text"])) for e in out[k]}
        for e in clean_delta(new)[k]:
            sig = (norm(e.get("with")), norm(e["text"]))
            if sig not in have and len(out[k]) < PER_CAT:
                out[k].append(e)
                have.add(sig)
    return out


def delta_words(d: dict) -> str:
    """One plain line: "Appearance: lost his left eye · Gained: the Resonance Key · Can now: hear the city"."""
    d = clean_delta(d)
    short = {"appearance": "Appearance", "items_gained": "Gained", "items_lost": "Lost", "abilities_gained": "Can now",
             "abilities_lost": "Can no longer", "relationships": "Relationships", "status": "Status"}
    parts = []
    for k in CAT_KEYS:
        if d[k]:
            vals = [(f"{e['with']}: {e['text']}" if e.get("with") else e["text"]) for e in d[k]]
            parts.append(f"{short[k]}: " + "; ".join(vals))
    return " · ".join(parts)


# ====================================================================== storage
def member(store, pid: str) -> dict | None:
    m = store.get_setting(MEMBER_KEY.format(pid=pid))
    return m if isinstance(m, dict) and isinstance(m.get("series_id"), str) else None


def get(store, sid: str | None) -> dict | None:
    if not isinstance(sid, str) or not sid:
        return None
    s = store.get_setting(SERIES_KEY.format(sid=sid))
    if not isinstance(s, dict) or not isinstance(s.get("books"), list):
        return None
    for k in ("characters", "changes", "proposals", "portraits", "portrait_waiting"):
        if not isinstance(s.get(k), dict):
            s[k] = {}
    s.setdefault("portraits_old", [])
    return world.defaults(s)


def _save(store, s: dict) -> dict:
    s["updated_at"] = now_iso()
    store.set_setting(SERIES_KEY.format(sid=s["id"]), s)
    return s


def _book_title(store, pid: str) -> str:
    from .book_path import get_profile  # noqa: PLC0415
    p = store.project(pid)
    return str((get_profile(store, pid) or {}).get("title") or (p["name"] if p else "") or "Untitled book")[:200]


def _exists(store, pid) -> bool:
    try:
        return bool(pid) and store.project(pid) is not None
    except Exception:  # noqa: BLE001
        return False


def _virtual(store, pid: str, branch: str, problem: str | None = None) -> dict:
    from .book_path import get_profile  # noqa: PLC0415
    prof = get_profile(store, pid) or {}
    n = prof.get("series_number") if isinstance(prof.get("series_number"), int) else 1
    return world.defaults({"id": None, "virtual": True, "problem": problem,
                           "name": str(prof.get("series") or prof.get("title") or "")[:200],
                           "books": [{"number": n, "project_id": pid, "branch_id": branch,
                                      "title": _book_title(store, pid)}],
                           "characters": {}, "changes": {}, "proposals": {}, "portraits": {}, "portrait_waiting": {},
                           "portraits_old": []})


def of_book(store, pid: str, branch: str = "main") -> dict:
    """The series of a book (a virtual series of one when it is in none). A broken link (the series record is
    missing or unreadable) reads as a book on its own, with ``problem`` saying so — nothing is changed."""
    m = member(store, pid)
    if m is None:
        return _virtual(store, pid, branch)
    s = get(store, m["series_id"])
    if s is None:
        return _virtual(store, pid, branch, "This book's series record is missing, so it is shown as a book on its "
                                            "own. Nothing in the book was changed; finding its changes or starting a "
                                            "sequel makes the series again.")
    return s


def book_of(s: dict, pid: str) -> dict | None:
    return next((b for b in s.get("books") or [] if b.get("project_id") == pid), None)


def number_of(s: dict, pid: str) -> int:
    b = book_of(s, pid)
    return int(b["number"]) if b else 1


def books(s: dict) -> list[dict]:
    return sorted([b for b in s.get("books") or [] if isinstance(b, dict) and isinstance(b.get("number"), int)],
                  key=lambda b: b["number"])


def ensure(store, pid: str, branch: str = "main") -> dict:
    """The stored series of a book, made now when it has none (a single book becomes book 1 of its series; a broken
    link is repaired by a new series that holds this book)."""
    from .book_path import get_profile, save_profile  # noqa: PLC0415
    with _LOCK:
        m = member(store, pid)
        s = get(store, m["series_id"]) if m else None
        if s is not None and book_of(s, pid):
            return s
        prof = get_profile(store, pid) or {}
        n = prof.get("series_number") if isinstance(prof.get("series_number"), int) else 1
        if s is None:
            sid = f"ser-{uuid.uuid4().hex[:12]}"
            s = {"id": sid, "name": str(prof.get("series") or prof.get("title") or "My series")[:200],
                 "created_at": now_iso(), "books": [], "characters": {}, "changes": {}, "proposals": {},
                 "portraits": {}, "portrait_waiting": {}, "portraits_old": []}
            world.defaults(s)
        s["books"] = [b for b in s["books"] if b.get("number") != n or not _exists(store, b.get("project_id"))]
        s["books"].append({"number": n, "project_id": pid, "branch_id": branch, "title": _book_title(store, pid)})
        _link_book(store, s, pid, branch, n)
        _save(store, s)
        store.set_setting(MEMBER_KEY.format(pid=pid), {"series_id": s["id"], "number": n})
        upd = {}
        if not prof.get("series"):
            upd["series"] = s["name"][:200]
        if not isinstance(prof.get("series_number"), int):
            upd["series_number"] = n
        if upd:
            try:
                save_profile(store, pid, upd)
            except AkoweError:
                log.info("series: the book profile of %s was not updated", pid)
        return s


# ====================================================================== characters across the books
def _book_chars(store, pid: str, branch: str) -> list[dict]:
    from . import characters as chars_mod  # noqa: PLC0415
    try:
        cs = chars_mod.canon_characters(store, pid, branch)
    except Exception:  # noqa: BLE001
        return []
    entries = chars_mod.all_entries(store, pid, branch)
    out = []
    for c in cs:
        e = entries.get(c["record_id"]) or {}
        out.append(dict(c, voice=e.get("voice") or {}, sheet=e.get("sheet") or {}))
    return out


def _fixed_of(c: dict) -> dict:
    a = c.get("attributes") or {}
    return {"name": c.get("name") or "", **{k: str(a.get(k) or "") for k in FIXED_ATTRS},
            "voice": copy.deepcopy(c.get("voice") or {})}


def _base_of(c: dict) -> dict:
    a = c.get("attributes") or {}
    rels = []
    for r in (c.get("sheet") or {}).get("relationships") or []:
        if isinstance(r, dict) and r.get("with"):
            rels.append({"with": _clip(r["with"], WITH_MAX), "text": _clip(r.get("tension") or r.get("history"),
                                                                           TEXT_MAX)})
    return {"appearance": str(a.get("appearance") or "")[:APPEARANCE_MAX], "relationships": rels[:12]}


def _key_for(s: dict, pid: str, c: dict) -> str | None:
    for k, ch in s["characters"].items():
        if (ch.get("records") or {}).get(pid) == c["record_id"]:
            return k
    n = norm(c.get("name"))
    if not n:
        return None
    for k, ch in s["characters"].items():
        if pid in (ch.get("records") or {}):
            continue
        if n == norm(ch.get("name")) or n in {norm(a) for a in ch.get("aliases") or []}:
            return k
    return None


def _link_book(store, s: dict, pid: str, branch: str, number: int, chars: list[dict] | None = None) -> None:
    """Every character of one book gets its series key (same record, same name, or a new person of this book). The
    fixed layer and the first look come from the first book the character is in (re-read while that book exists, so
    the author's later edits there count)."""
    for c in chars if chars is not None else _book_chars(store, pid, branch):
        k = _key_for(s, pid, c)
        if k is None:
            k = f"c{len(s['characters']) + 1}"
            while k in s["characters"]:
                k = f"c{uuid.uuid4().hex[:6]}"
            s["characters"][k] = {"name": c["name"], "aliases": [], "first_book": number, "records": {},
                                  "fixed": _fixed_of(c), "base": _base_of(c)}
        ch = s["characters"][k]
        ch.setdefault("records", {})[pid] = c["record_id"]
        if number < int(ch.get("first_book") or number):
            ch["first_book"] = number
        if number == int(ch.get("first_book") or number):
            ch["fixed"], ch["base"] = _fixed_of(c), _base_of(c)
            ch["name"] = c["name"]
        elif norm(c["name"]) != norm(ch.get("name")) and c["name"] not in ch.get("aliases", []):
            ch.setdefault("aliases", []).append(c["name"][:120])
    try:  # 📚 the places, items and groups of the book too (series_world.py)
        world.link_things(store, s, pid, branch, number)
    except Exception:  # noqa: BLE001 - the characters never fail over the world
        log.exception("series: linking the places / items / groups of %s", pid)


def linked(store, s: dict) -> dict:
    """A copy of the series with the characters of every book still in this Akọwe linked (reads never store)."""
    if s.get("virtual"):
        s = copy.deepcopy(s)
        b = s["books"][0]
        _link_book(store, s, b["project_id"], b.get("branch_id") or "main", b["number"])
        return s
    s = copy.deepcopy(s)
    for b in books(s):
        if _exists(store, b.get("project_id")):
            _link_book(store, s, b["project_id"], b.get("branch_id") or "main", b["number"])
    return s


def key_of_record(s: dict, pid: str, rid: str) -> str | None:
    for k, ch in (s.get("characters") or {}).items():
        if (ch.get("records") or {}).get(pid) == rid:
            return k
    return None


# ====================================================================== state "as of book N"
def _approved(s: dict, number: int, key: str) -> dict | None:
    e = ((s.get("changes") or {}).get(str(number)) or {}).get(key)
    return clean_delta(e.get("delta")) if isinstance(e, dict) else None


_ARTICLES = re.compile(r"^(?:the|a|an|his|her|their|its|my) ")


def _same(a: str, b: str) -> bool:
    """The same thing ("the lantern" = "a lantern" = "his old lantern"? — the first two, and containment)."""
    a, b = _ARTICLES.sub("", norm(a)), _ARTICLES.sub("", norm(b))
    return bool(a and b) and (a == b or (len(a) > 3 and a in b) or (len(b) > 3 and b in a))


def state_as_of(s: dict, key: str, number: int, when: str = "end") -> dict:
    """The changeable layer of a character at the start or the end of book ``number`` (the first look plus every
    approved change of the books before it — and of this book, for "end")."""
    ch = (s.get("characters") or {}).get(key) or {}
    base = ch.get("base") or {}
    first = int(ch.get("first_book") or 1)
    last = number - 1 if when == "start" else number
    st = {"appearance": base.get("appearance") or "", "appearance_changes": [], "items": [], "items_lost": [],
          "abilities": [], "abilities_lost": [],
          "relationships": [dict(r, book=first, base=True) for r in base.get("relationships") or []], "status": None,
          "as_of": {"book": number, "when": when}, "changed": False}
    for n in range(first, last + 1):
        d = _approved(s, n, key)
        if not d or delta_empty(d):
            continue
        st["changed"] = True
        for e in d["appearance"]:
            st["appearance_changes"].append(dict(e, book=n))
        for gained, lost, have, gone in (("items_gained", "items_lost", "items", "items_lost"),
                                         ("abilities_gained", "abilities_lost", "abilities", "abilities_lost")):
            for e in d[lost]:
                before = len(st[have])
                st[have] = [x for x in st[have] if not _same(x["text"], e["text"])]
                st[gone].append(dict(e, book=n, had=len(st[have]) < before))
            for e in d[gained]:
                if not any(_same(x["text"], e["text"]) for x in st[have]):
                    st[have].append(dict(e, book=n))
                st[gone] = [x for x in st[gone] if not _same(x["text"], e["text"])]
        for e in d["relationships"]:
            st["relationships"] = [r for r in st["relationships"] if norm(r.get("with")) != norm(e["with"])]
            st["relationships"].append(dict(e, book=n))
        if d["status"]:
            st["status"] = dict(d["status"][-1], book=n)
    return st


def appearance_text(st: dict) -> str:
    """The look as one text (the sequel's A01 appearance): the first look, then what changed since."""
    base = (st.get("appearance") or "").strip()
    ch = [e["text"].rstrip(".") for e in st.get("appearance_changes") or []]
    if not ch:
        return base[:APPEARANCE_MAX]
    tail = "Now: " + "; ".join(ch) + "."
    if len(base) + len(tail) + 1 > APPEARANCE_MAX:
        base = base[:max(0, APPEARANCE_MAX - len(tail) - 2)].rstrip() + "…"
    return (base + " " + tail).strip()[:APPEARANCE_MAX]


def state_words(st: dict) -> dict:
    """The state as short plain texts (the binder and the writer's brief)."""
    out = {"looks": appearance_text(st)}
    if st.get("items"):
        out["carries"] = "; ".join(e["text"] for e in st["items"])
    if st.get("abilities"):
        out["can"] = "; ".join(e["text"] for e in st["abilities"])
    lost = [e["text"] for e in st.get("items_lost") or []] + [e["text"] for e in st.get("abilities_lost") or []]
    if lost:
        out["lost"] = "; ".join(lost)
    if st.get("status"):
        out["status"] = st["status"]["text"]
    rels = [f"{r['with']}: {r['text']}" for r in st.get("relationships") or [] if r.get("text")]
    if rels:
        out["relationships"] = "; ".join(rels)
    return out


# ====================================================================== the fixed layer is protected
def fixed_for_record(store, pid: str, rid: str) -> dict | None:
    """The fixed layer a character of a LATER book of a series must keep (None: not in a series, or this is the
    book the character comes from)."""
    m = member(store, pid)
    s = get(store, m["series_id"]) if m else None
    if s is None:
        return None
    k = key_of_record(s, pid, rid)
    if k is None:
        return None
    ch = s["characters"][k]
    if number_of(s, pid) <= int(ch.get("first_book") or 1):
        return None
    return ch.get("fixed") or None


def fixed_problems(old_attrs: dict, new_attrs: dict, fixed: dict) -> list[str]:
    """Plain words for every fixed-layer attribute a new version changes."""
    out = []
    for k in FIXED_ATTRS:
        want = str((fixed or {}).get(k) or "")
        if want and str((new_attrs or {}).get(k) or "") != want:
            out.append(f"{FIXED_LABELS[k]} is fixed for the whole series and was put back")
    return out


def protect_fixed(store, pid: str, branch: str, rec: dict, payload: dict) -> list[str]:
    """An AI's new version of a character in a later book of a series: the fixed attributes are put back word for
    word (in place). Returns the plain notes (empty: nothing to protect / nothing changed)."""
    if not isinstance(rec, dict) or rec.get("module_id") != "A01" or not isinstance(payload, dict):
        return []
    try:
        fixed = fixed_for_record(store, pid, rec.get("record_id"))
    except Exception:  # noqa: BLE001 - never stop a fix over the series
        log.exception("series: fixed layer of %s", rec.get("record_id"))
        return []
    if not fixed:
        return []
    attrs = payload.get("attributes") if isinstance(payload.get("attributes"), dict) else {}
    notes = fixed_problems((rec.get("data") or {}).get("attributes") or {}, attrs, fixed)
    if notes:
        attrs = dict(attrs)
        for k in FIXED_ATTRS:
            if fixed.get(k):
                attrs[k] = fixed[k]
        payload["attributes"] = attrs
    return notes


# ====================================================================== ✨ find what changed in this book (AI)
CHANGE_TASK = (
    "You read the chapters of one book of a series (context.chapters) and say, for each character in "
    "context.characters, what CHANGED for them during THIS book — only changes the chapters really show. "
    "Categories: appearance (a scar, a lost eye, new hair, older, other clothes, a changed body), items_gained / "
    "items_lost (things they now carry or lost), abilities_gained / abilities_lost, relationships (one line per "
    "person: who is now an ally, an enemy, a friend…; 'with' is that person's name) and status (alive or dead, "
    "injured, a new title or job, where they are). Each entry is one short plain sentence with the chapter_id it "
    "happens in when you know it. context.characters[].at_start says how they were when this book began: do not "
    "repeat it. Personality, the way they talk, their name and their origin NEVER change in a series: never put them "
    "in any category. A character with no change gets empty lists. Use the names exactly as context.characters gives "
    "them." + world.TASK)
_ENTRY = {"type": "object", "additionalProperties": False, "required": ["text", "chapter"],
          "properties": {"text": {"type": "string"}, "chapter": {"type": "string"}}}
_REL = {"type": "object", "additionalProperties": False, "required": ["with", "text", "chapter"],
        "properties": {"with": {"type": "string"}, "text": {"type": "string"}, "chapter": {"type": "string"}}}
CHANGE_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["character_changes", "thing_changes"],
    "properties": {"thing_changes": world.SCHEMA, "character_changes": {"type": "array", "maxItems": 40, "items": {
        "type": "object", "additionalProperties": False, "required": ["name"] + list(CAT_KEYS),
        "properties": dict({"name": {"type": "string"}},
                           **{k: {"type": "array", "maxItems": PER_CAT, "items": _REL if k == "relationships" else _ENTRY}
                              for k in CAT_KEYS})}}},
}


def _chapters(app, pid: str, branch: str) -> list[dict]:
    from . import binder  # noqa: PLC0415
    try:
        return [c for c in binder.Book(app, pid, branch).chapters if c.get("text")]
    except Exception:  # noqa: BLE001
        log.exception("series: chapters of %s", pid)
        return []


def change_context(app, pid: str, branch: str) -> tuple[dict, dict]:
    """(the AI's context, the linked series) for finding this book's changes."""
    store = app.store
    s = linked(store, of_book(store, pid, branch))
    n = number_of(s, pid)
    chs = _chapters(app, pid, branch)
    if not chs:
        raise _err("MISSING_INPUT", "/chapters", "this book has no written chapters yet, so there is nothing to read "
                                                 "for changes — write the chapters first")
    per = max(1500, CHANGE_TEXT_BUDGET // max(1, len(chs)))
    chapters = []
    for c in chs:
        text = c["text"]
        if len(text) > per:
            text = text[:per // 2] + "\n[…]\n" + text[-per // 2:]
        chapters.append({"chapter_id": c["chapter_id"], "number": c["number"], "summary": _clip(c.get("summary"), 400),
                         "text": text})
    people = []
    for k, ch in s["characters"].items():
        if pid not in (ch.get("records") or {}):
            continue
        st = state_as_of(s, k, n, "start")
        people.append({"name": ch["name"], "fixed_never_changes": {x: _clip(ch.get("fixed", {}).get(x), 300)
                                                                   for x in FIXED_ATTRS},
                       "at_start": state_words(st)})
    things = world.context_things(s, pid, n)
    if not people and not things:
        raise _err("MISSING_INPUT", "/characters", "this book has no characters, places, items or groups yet")
    return {"book": {"title": _book_title(store, pid), "number_in_series": n, "series": s.get("name")},
            "characters": people[:40], "things": things, "chapters": chapters}, s


def save_proposals(store, pid: str, branch: str, raw, *, by: str = "ai", slot: str | None = None) -> dict:
    """The AI's answer -> proposals of this book (one per character with a change). A proposal never replaces an
    approved change; a character the book does not have is named in ``unknown``."""
    items = (raw or {}).get("character_changes") if isinstance(raw, dict) else None
    items = items if isinstance(items, list) else []
    with _LOCK:
        s = ensure(store, pid, branch)
        _link_book(store, s, pid, branch, number_of(s, pid))
        n = str(number_of(s, pid))
        props = s["proposals"].setdefault(n, {})
        made, unknown, same = [], [], 0
        for it in items:
            if not isinstance(it, dict):
                continue
            name = _clip(it.get("name"), 120)
            key = next((k for k, ch in s["characters"].items() if pid in (ch.get("records") or {}) and
                        (norm(name) == norm(ch["name"]) or norm(name) in {norm(a) for a in ch.get("aliases") or []})),
                       None)
            if key is None:
                if name:
                    unknown.append(name)
                continue
            d = clean_delta(it)
            have = _approved(s, int(n), key)
            if have:  # only what the approved change does not say yet
                merged = merge_delta(have, d)
                d = {k: [e for e in merged[k] if e not in have[k]] for k in CAT_KEYS}
            if delta_empty(d):
                same += 1
                continue
            props[key] = {"delta": d, "by": by, "slot": slot, "at": now_iso()}
            made.append(key)
        tw = world.save_proposals(s, pid, int(n), (raw or {}).get("thing_changes") if isinstance(raw, dict) else None,
                                  by=by, slot=slot)
        _save(store, s)
    return {"proposed": len(made), "keys": made, "unknown": unknown[:10], "unchanged": same,
            "things_proposed": tw["proposed"], "thing_keys": tw["keys"], "things_unknown": tw["unknown"]}


def find_changes(app, job, pid: str, branch: str, assist=None) -> dict:
    """The AI reads the book and proposes each character's changes (nothing is used until the author approves)."""
    ctx, _s = change_context(app, pid, branch)
    job.phase = "The AI is reading the book for what changed for each character"
    raw = (assist or app.assist)._call_ai(job, op_for_roles="A01", task=CHANGE_TASK, schema=CHANGE_SCHEMA,
                                          context=ctx, protected=[])
    return save_proposals(app.store, pid, branch, raw, by="ai", slot=getattr(job, "slot", None))


def start_find(app, principal: str, pid: str, branch: str) -> dict:
    from .review import ReviewJob  # noqa: PLC0415
    change_context(app, pid, branch)  # a book with nothing to read is refused now, not in the job

    def fn(job):
        out = find_changes(app, job, pid, branch)
        parts = ([f"{out['proposed']} character(s)"] if out["proposed"] else []) + \
            ([f"{out['things_proposed']} place(s), item(s) or group(s)"] if out.get("things_proposed") else [])
        msg = (f"The AI proposed changes for {' and '.join(parts)}. Read them and ✔ approve the ones that are right "
               "(nothing is used before you approve)." if parts else
               "The AI found no new changes for the characters, places, items or groups in this book.")
        gone = list(out["unknown"]) + list(out.get("things_unknown") or [])
        if gone:
            msg += " Not in this book, so not kept: " + ", ".join(gone) + "."
        job.done = 1
        job.results.append({"ok": True, "message": msg, **out})
    job = ReviewJob("series_changes", principal, pid, branch, [pid], None)
    return app.review._start(job, fn)  # noqa: SLF001


def _book_number_arg(s: dict, pid: str, body: dict) -> int:
    n = body.get("book")
    if n in (None, ""):
        return number_of(s, pid)
    if not isinstance(n, int) or isinstance(n, bool) or not any(b["number"] == n for b in books(s)):
        raise _err("INVALID_INPUT", "/book", "book: the number of a book in this series")
    return n


def _key_arg(s: dict, body: dict) -> str:
    k = body.get("key")
    if not isinstance(k, str) or k not in s["characters"]:
        raise _err("NOT_FOUND", "/key", "this character is not in the series")
    return k


def _is_thing(s: dict, body: dict) -> bool:
    k = body.get("key")
    return isinstance(k, str) and k in (s.get("things") or {}) and k not in s["characters"]


def approve(store, pid: str, branch: str, body) -> dict:
    """✔ Approve the AI's proposal for one character (merged into what is approved; nothing is removed)."""
    body = body if isinstance(body, dict) else {}
    with _LOCK:
        s = ensure(store, pid, branch)
        n = _book_number_arg(s, pid, body)
        if _is_thing(s, body):  # 📚 a place, an item or a group (series_world.py)
            out = world.approve(s, n, body["key"])
            if not out:
                raise _err("NOT_FOUND", "/key", "there is no proposal for this place, item or group any more (it was "
                                                "approved or dismissed already)")
            _save(store, s)
            return out
        k = _key_arg(s, body)
        p = (s["proposals"].get(str(n)) or {}).get(k)
        if not p:
            raise _err("NOT_FOUND", "/key", "there is no proposal for this character any more (it was approved or "
                                            "dismissed already)")
        before = _approved(s, n, k) or clean_delta({})
        merged = merge_delta(before, p["delta"])
        s["changes"].setdefault(str(n), {})[k] = {"delta": merged, "by": "author", "approved_from": p.get("by"),
                                                  "at": now_iso()}
        s["proposals"][str(n)].pop(k, None)
        new_look = len(merged["appearance"]) > len(before["appearance"])
        if new_look:
            _mark_portrait(s, n, k, "NEW_LOOK", "the look changed in this book")
        items = _link_items(s, n, k, before, merged)
        _save(store, s)
    msg = f"Approved: {delta_words(merged)}"
    if items:
        msg += " · The holder of " + ", ".join(f"“{x}”" for x in items) + " changed in this book too."
    return {"ok": True, "key": k, "book": n, "delta": merged, "portrait_needed": new_look, "linked_items": items,
            "message": msg}


def _link_items(s: dict, n: int, k: str, before: dict, after: dict) -> list[str]:
    """A character's NEW items gained / lost: the item's own page gets the holder change (series_world.link_items)."""
    added = {c: [e for e in after.get(c) or [] if e not in (before.get(c) or [])] for c in ("items_gained",
                                                                                          "items_lost")}
    try:
        return world.link_items(s, n, k, added)
    except Exception:  # noqa: BLE001 - the character's change is kept whatever happens to the item
        log.exception("series: linking the items of %s", k)
        return []


def dismiss(store, pid: str, branch: str, body) -> dict:
    body = body if isinstance(body, dict) else {}
    with _LOCK:
        s = ensure(store, pid, branch)
        n = _book_number_arg(s, pid, body)
        if _is_thing(s, body):
            out = world.dismiss(s, n, body["key"])
            _save(store, s)
            return out
        k = _key_arg(s, body)
        gone = (s["proposals"].get(str(n)) or {}).pop(k, None)
        _save(store, s)
    return {"ok": True, "key": k, "book": n, "dismissed": bool(gone)}


def edit(store, pid: str, branch: str, body) -> dict:
    """✏ The author writes a character's changes in one book themselves (their text, approved as it is)."""
    body = body if isinstance(body, dict) else {}
    if not isinstance(body.get("delta"), dict):
        raise _err("INVALID_INPUT", "/delta", "delta: the changes, e.g. {appearance: [{text: 'lost his left eye'}]}")
    with _LOCK:
        s = ensure(store, pid, branch)
        if _is_thing(s, body):  # 📚 a place, an item or a group
            th = s["things"][body["key"]]
            bad = world.bad_edit_keys(th["kind"], body["delta"])
            if bad:
                raise _err("INVALID_INPUT", f"/delta/{bad[0]}", f"“{bad[0]}” cannot change in a series — only "
                           + ", ".join(world.cat_keys(th["kind"])) + " (the name, core description, origin and a "
                           "group's symbol are fixed for the whole series)")
            n = _book_number_arg(s, pid, body)
            out = world.edit(s, n, body["key"], body["delta"])
            _save(store, s)
            return out
    for k in body["delta"]:
        if k not in CAT_KEYS:
            raise _err("INVALID_INPUT", f"/delta/{k}", f"“{k}” cannot change in a series — only "
                                                       + ", ".join(CAT_KEYS) + " (personality, voice, name and origin "
                                                       "are fixed for the whole series)")
    d = clean_delta(body["delta"])
    with _LOCK:
        s = ensure(store, pid, branch)
        n = _book_number_arg(s, pid, body)
        k = _key_arg(s, body)
        before = _approved(s, n, k) or clean_delta({})
        s["changes"].setdefault(str(n), {})[k] = {"delta": d, "by": "author", "at": now_iso()}
        new_look = [e["text"] for e in d["appearance"]] != [e["text"] for e in before["appearance"]] and \
            bool(d["appearance"])
        if new_look:
            _mark_portrait(s, n, k, "NEW_LOOK", "the look changed in this book")
        items = _link_items(s, n, k, before, d)
        _save(store, s)
    return {"ok": True, "key": k, "book": n, "delta": d, "portrait_needed": new_look, "linked_items": items}


def rename(store, pid: str, branch: str, body) -> dict:
    body = body if isinstance(body, dict) else {}
    name = _clip(body.get("name"), 200)
    if not name:
        raise _err("INVALID_INPUT", "/name", "name: the series name")
    with _LOCK:
        s = ensure(store, pid, branch)
        s["name"] = name
        _save(store, s)
    return {"ok": True, "name": name}


# ====================================================================== 📚 start a sequel from this book
def _sequel_hook(app, pid: str, branch: str) -> str:
    from . import binder  # noqa: PLC0415
    try:
        b = binder.Book(app, pid, branch)
        f = binder.a_sequel_hook(binder.Page(b, "10", "", ""))
        return str((f or {}).get("value") or "")[:1500] if isinstance(f, dict) else str(f or "")[:1500]
    except Exception:  # noqa: BLE001
        log.exception("series: sequel hook of %s", pid)
        return ""


def sequel_bible(app, pid: str, branch: str, body=None) -> tuple[dict, dict]:
    """(the new book's bible, the sequel settings): this book's bible at the END of this book — fixed layers from the
    series, appearance and relationships at their end state, no plan (the sequel gets a new premise, plot and outline)."""
    from . import book_bible  # noqa: PLC0415
    body = body if isinstance(body, dict) else {}
    store = app.store
    if not _exists(store, pid):
        raise _err("NOT_FOUND", "/project_id", "the book to continue does not exist any more")
    with _LOCK:
        s = ensure(store, pid, branch)
        _link_book(store, s, pid, branch, number_of(s, pid))
        _save(store, s)
    n = number_of(s, pid)
    nxt = n + 1
    taken = next((b for b in books(s) if b["number"] == nxt and _exists(store, b.get("project_id"))), None)
    if taken and not body.get("allow_second"):
        raise _err("VERSION_CONFLICT", "/book", f"book {nxt} of this series already exists (“{taken.get('title')}”). "
                                                f"Open that book to continue the series, or start the sequel from the "
                                                f"last book")
    try:
        raw = book_bible.build(app, pid, branch)
        import json  # noqa: PLC0415
        bible = book_bible.clean(json.loads(json.dumps(raw)))
    except book_bible.BibleProblem as exc:
        raise _err(exc.code, "/from_bible", f"this book cannot be continued yet: {exc.message}") from None
    keys = {}
    for c in bible.get("characters") or []:
        k = key_of_record(s, pid, c.get("record_id"))
        if k is None:
            continue
        keys[c["record_id"]] = k
        ch = s["characters"][k]
        st = state_as_of(s, k, n, "end")
        data = c.setdefault("data", {})
        attrs = dict(data.get("attributes") or {})
        for a in FIXED_ATTRS:  # fixed: copied from the series, never from this book's (maybe AI-changed) text
            if (ch.get("fixed") or {}).get(a):
                attrs[a] = ch["fixed"][a]
        look = appearance_text(st)
        if look:
            attrs["appearance"] = look
        data["attributes"] = attrs
        if (ch.get("fixed") or {}).get("voice"):
            c["voice"] = copy.deepcopy(ch["fixed"]["voice"])
        if c.get("sheet") and st["relationships"]:
            rels = [dict(r) for r in c["sheet"].get("relationships") or [] if isinstance(r, dict)]
            for r in st["relationships"]:
                if r.get("base") or not r.get("text"):
                    continue
                old = next((x for x in rels if norm(x.get("with")) == norm(r["with"])), None)
                if old:
                    old["tension"] = r["text"][:400]
                else:
                    rels.append({"with": r["with"], "tension": r["text"][:400], "history": f"since book {r['book']}"})
            c["sheet"] = dict(c["sheet"], relationships=rels[:8])
    prof = dict(bible.get("profile") or {})
    old_title = prof.get("title") or _book_title(store, pid)
    title = _clip(body.get("title"), 200) or f"{s.get('name') or old_title}: Book {nxt}"[:200]
    hook = _clip(body.get("idea"), 4000) or _sequel_hook(app, pid, branch)
    idea = (hook + " " if hook else "") + f"This is book {nxt} of the series “{s.get('name') or old_title}”: it " \
        f"continues the story of “{old_title}”. The characters start exactly as they were at the end of that book."
    prof.update(title=title, idea=idea[:4000], series=str(s.get("name") or old_title)[:200], series_number=nxt)
    bible["profile"] = prof
    bible["plan"] = {}
    bible["scene_cards"] = []
    bible["source"] = dict(bible.get("source") or {}, name=f"{old_title} (end of book {n})"[:200])
    sequel = {"series_id": s["id"], "number": nxt, "previous": pid, "previous_branch": branch,
              "previous_number": n, "previous_title": old_title[:200], "title": title, "keys": keys,
              "hook": bool(hook)}
    return bible, sequel


def start_sequel(app, principal: str, pid: str, branch: str, body=None) -> dict:
    """📚 Start a sequel: a ⚡ Make a book run from this book's bible at its end (see ``sequel_bible``)."""
    body = body if isinstance(body, dict) else {}
    if body.get("author_confirms") is not True:
        raise _err("APPROVAL_REQUIRED", "/author_confirms", "pressing 📚 Start a sequel is your consent for the new "
                                                            "book's run; send author_confirms: true")
    bible, sequel = sequel_bible(app, pid, branch, body)
    bid = app.opener.stash(bible)
    run_body = {"author_confirms": True, "from_bible": {"bible_id": bid}, "reuse_plan": False, "sequel": sequel}
    for k in ("length", "slot_id", "pipeline", "pictures"):
        if body.get(k) not in (None, ""):
            run_body[k] = body[k]
    run = app.autobook.start(principal, run_body)
    return {"run": run, "sequel": {k: sequel[k] for k in ("series_id", "number", "previous", "title",
                                                          "previous_title", "hook")},
            "message": f"📚 Book {sequel['number']} has started: “{sequel['title']}”. Its characters start as they were "
                       f"at the end of “{sequel['previous_title']}”."}


def sequel_status(app, pid: str, branch: str, s: dict | None = None) -> dict:
    """Can 📚 Start a sequel from this book be pressed now? -> {possible, why (plain words when not), number,
    next_number, next_book, proposals_here, series_name}. Never raises (a problem reads as "not possible")."""
    store = app.store
    try:
        if not _exists(store, pid):
            return {"possible": False, "why": "This book does not exist any more.", "number": 1, "next_number": 2,
                    "next_book": None, "proposals_here": 0, "series_name": ""}
        s = s if s is not None else of_book(store, pid, branch)
        n = number_of(s, pid)
        taken = next((b for b in books(s) if b["number"] == n + 1 and _exists(store, b.get("project_id"))), None)
        try:
            ai = bool(app.autobook._ai_configured())  # noqa: SLF001
        except Exception:  # noqa: BLE001
            ai = True  # cannot tell: let the press try (the run says it in plain words)
        why = None
        if taken:
            why = (f"Book {n + 1} of this series already exists (“{taken.get('title') or ''}”). Open that book to "
                   "continue the series, or start the sequel from the last book.")
        elif not ai:
            why = ("No AI is connected. A sequel is written by ⚡ Make a book, which needs an AI: connect one in "
                   "Settings, then press 📚 Start a sequel again.")
        props = len((s.get("proposals") or {}).get(str(n)) or {}) + len((s.get("thing_proposals") or {}).get(str(n))
                                                                         or {})
        return {"possible": why is None, "why": why, "number": n, "next_number": n + 1,
                "next_book": {"number": taken["number"], "title": taken.get("title"),
                              "project_id": taken.get("project_id")} if taken else None,
                "proposals_here": props, "series_name": s.get("name") or "", "in_series": not s.get("virtual")}
    except Exception:  # noqa: BLE001
        log.exception("series: sequel status of %s", pid)
        return {"possible": False, "why": "The series of this book could not be read, so a sequel cannot be started "
                                          "right now. Try again in a moment.", "number": 1, "next_number": 2,
                "next_book": None, "proposals_here": 0, "series_name": ""}


def clean_sequel_setting(store, raw) -> dict | None:
    """The ``sequel`` of a run body (made by start_sequel) checked against the store."""
    if raw in (None, ""):
        return None
    if not isinstance(raw, dict) or get(store, raw.get("series_id")) is None:
        raise _err("INVALID_INPUT", "/sequel", "this sequel's series does not exist")
    n = raw.get("number")
    if not isinstance(n, int) or isinstance(n, bool) or not 1 < n < 1000:
        raise _err("INVALID_INPUT", "/sequel/number", "sequel number: 2 to 999")
    keys = raw.get("keys") if isinstance(raw.get("keys"), dict) else {}
    return {"series_id": raw["series_id"], "number": n, "previous": str(raw.get("previous") or "")[:80],
            "previous_number": raw.get("previous_number") if isinstance(raw.get("previous_number"), int) else n - 1,
            "previous_title": _clip(raw.get("previous_title"), 200), "title": _clip(raw.get("title"), 200),
            "keys": {str(k)[:120]: str(v)[:40] for k, v in list(keys.items())[:200]}, "hook": bool(raw.get("hook"))}


def register_sequel(store, sequel: dict, pid: str, branch: str = "main") -> None:
    """The run made the sequel's book: it becomes book N of the series."""
    with _LOCK:
        s = get(store, sequel.get("series_id"))
        if s is None:
            log.warning("series: the series of a sequel is gone; book %s stays on its own", pid)
            return
        n = int(sequel["number"])
        if book_of(s, pid) is None:
            s["books"] = [b for b in s["books"] if b.get("number") != n or not _exists(store, b.get("project_id"))]
            s["books"].append({"number": n, "project_id": pid, "branch_id": branch, "title": sequel.get("title") or
                               _book_title(store, pid), "previous": sequel.get("previous")})
        _save(store, s)
        store.set_setting(MEMBER_KEY.format(pid=pid), {"series_id": s["id"], "number": n})


def link_sequel(store, sequel: dict, pid: str, branch: str, bible_map: dict) -> int:
    """After the sequel's canon is seeded: its characters take their series keys (old record -> new record) and their
    voice cards are marked fixed. Returns the number linked."""
    from . import characters as chars_mod  # noqa: PLC0415
    with _LOCK:
        s = get(store, sequel.get("series_id"))
        if s is None:
            return 0
        n = 0
        rids = []
        for old, new in (bible_map or {}).items():
            k = (sequel.get("keys") or {}).get(old)
            if k and k in s["characters"]:
                s["characters"][k].setdefault("records", {})[pid] = new
                rids.append(new)
                n += 1
        try:  # 📚 the places, items and groups: the same series keys (they start at the end of the book before)
            world.link_things(store, s, pid, branch, int(sequel.get("number") or 2))
        except Exception:  # noqa: BLE001
            log.exception("series: linking the sequel's places / items / groups")
        _save(store, s)
    if rids:
        chars_mod.mark_series_fixed(store, pid, branch, rids)
    return n


# ====================================================================== the writer's brief (as at the start of this book)
def writer_brief(store, pid: str, branch: str, present_ids=()) -> tuple[list, int]:
    """([{name, as_of, looks, carries, can, lost, status, relationships}], book number) for the characters present —
    only for a later book of a series (book 1 has its own canon)."""
    m = member(store, pid)
    s = get(store, m["series_id"]) if m else None
    if s is None:
        return [], 1
    n = number_of(s, pid)
    if n <= 1:
        return [], n
    out, size = [], 0
    ids = set(present_ids or ())
    for k, ch in s["characters"].items():
        rid = (ch.get("records") or {}).get(pid)
        if not rid or (ids and rid not in ids):
            continue
        if int(ch.get("first_book") or n) >= n:
            continue
        w = state_words(state_as_of(s, k, n, "start"))
        item = {"name": ch.get("name"), "as_of": f"start of book {n}", **{x: v[:400] for x, v in w.items()}}
        import json  # noqa: PLC0415
        cost = len(json.dumps(item, ensure_ascii=False))
        if size + cost > BRIEF_BUDGET:
            break
        size += cost
        out.append(item)
    return out, n


def world_brief(store, pid: str, branch: str) -> list[dict]:
    """📚 The places / items / groups of a later book of a series as the previous book left them (series_world)."""
    m = member(store, pid)
    s = get(store, m["series_id"]) if m else None
    if s is None:
        return []
    n = number_of(s, pid)
    return world.writer_brief(s, pid, n) if n > 1 else []


WORLD_RULE = world.BRIEF_RULE
BRIEF_RULE = ("Series (context.writing_brief.series_state): this is a later book of a series. Each character starts "
              "this book exactly as the previous book left them — keep their looks (scars, missing parts, age, "
              "clothes), what they carry, what they can and cannot do, their relationships and their status. Their "
              "personality and the way they talk never change.")


# ====================================================================== 🖼 a portrait per book
def _mark_portrait(s: dict, n: int, key: str, code: str, why: str):
    if key in (s.get("things") or {}) and key not in (s.get("characters") or {}):  # 📚 a place's picture
        world.mark_picture(s, n, key, code, why)
        return
    s["portrait_waiting"].setdefault(str(n), {})[key] = {"code": code, "why": why[:300], "at": now_iso()}


def portrait_of(store, s: dict, key: str, number: int) -> dict | None:
    """The portrait to show for a character in book ``number``: the one made for that book, else that book's own
    dossier portrait, else None."""
    from . import forge  # noqa: PLC0415
    p = ((s.get("portraits") or {}).get(str(number)) or {}).get(key)
    if isinstance(p, dict) and p.get("asset_id") and _exists(store, p.get("project_id")):
        pub = forge._art_public(p["project_id"], p.get("branch_id") or "main", p)  # noqa: SLF001
        if pub:
            return {"url": pub["url"], "alt": f"{(s['characters'].get(key) or {}).get('name', '')} in book {number}",
                    "book": number, "made_for_book": True}
    b = next((x for x in books(s) if x["number"] == number), None)
    rid = ((s["characters"].get(key) or {}).get("records") or {}).get((b or {}).get("project_id"))
    if b and rid and _exists(store, b["project_id"]):
        try:
            art = (forge.raw_entry(store, b["project_id"], b.get("branch_id") or "main", rid) or {}).get("art") or {}
        except Exception:  # noqa: BLE001
            art = {}
        pub = forge._art_public(b["project_id"], b.get("branch_id") or "main", art.get("portrait"))  # noqa: SLF001
        if pub:
            return {"url": pub["url"], "alt": f"{(s['characters'].get(key) or {}).get('name', '')} in book {number}",
                    "book": number, "made_for_book": False}
    return None


def portrait_plan(store, s: dict, number: int | None = None) -> list[tuple[int, str, str]]:
    """[(book, key, name)] — the per-book portraits still to make (waiting, and not made since)."""
    out = []
    for n, ws in sorted((s.get("portrait_waiting") or {}).items(), key=lambda x: int(x[0])):
        if number is not None and int(n) != number:
            continue
        for k in ws:
            if k in s["characters"]:
                out.append((int(n), k, s["characters"][k].get("name") or k))
    return out + world.picture_plan(s, number)  # 📚 a place whose look changed: its picture for that book


def _source_record(store, s: dict, key: str, number: int) -> tuple[str, str, str] | None:
    """(pid, branch, rid) of the character in book ``number``, else in the latest earlier book still here."""
    ch = s["characters"].get(key) or {}
    for b in sorted(books(s), key=lambda b: (b["number"] != number, -b["number"])):
        if b["number"] > number:
            continue
        rid = (ch.get("records") or {}).get(b["project_id"])
        if rid and _exists(store, b["project_id"]):
            return b["project_id"], b.get("branch_id") or "main", rid
    return None


def portrait_prompt(store, s: dict, key: str, number: int) -> str:
    from . import forge  # noqa: PLC0415
    ch = s["characters"][key]
    src = _source_record(store, s, key, number)
    base = ""
    if src:
        try:
            base = forge.art_prompt(forge.public(store, *src), "portrait")
        except Exception:  # noqa: BLE001
            base = ""
    if not base:
        base = ". ".join(x for x in (ch.get("fixed", {}).get("name") or ch.get("name"), (ch.get("base") or {}).get(
            "appearance"), "full-body character portrait in their world, cinematic lighting, detailed concept art") if x)
    st = state_as_of(s, key, number, "end")
    changes = [e["text"].rstrip(".") for e in st["appearance_changes"]]
    if changes:
        base += f". How they look by the end of book {number}: " + "; ".join(changes)
    return base[:1800]


def make_one_portrait(app, principal: str, s: dict, number: int, key: str, engine: str) -> dict:
    """One per-book portrait with the character's 🔒 lock (its fixed name). Raises forge.ArtProblem / AkoweError."""
    from . import forge  # noqa: PLC0415
    store = app.store
    ch = s["characters"][key]
    lock = (ch.get("fixed") or {}).get("name") or ch.get("name")
    b = next((x for x in books(s) if x["number"] == number and _exists(store, x.get("project_id"))), None)
    src = _source_record(store, s, key, number)
    target = (b["project_id"], b.get("branch_id") or "main") if b else (src[0], src[1]) if src else None
    if target is None:
        raise AkoweError("NOT_FOUND", "/book", f"book {number} is not in this Akọwe any more, so its portrait cannot "
                                               "be stored", status="REJECTED")
    body = {"engine": engine, "prompt": portrait_prompt(store, s, key, number), "characterLock": lock,
            "book": s.get("name") or None, "from": "akowe-series", "returnImage": True, "purpose": "portrait"}
    body = {k: v for k, v in body.items() if v is not None}
    no_lock = False
    try:
        resp = forge.request_image(app, body)
    except forge.ArtProblem as exc:
        if exc.code != "NO_LOCK":
            raise
        no_lock = True
        body.pop("characterLock", None)
        resp = forge.request_image(app, body)
    data, seed = forge.first_picture(resp)
    asset = forge.store_picture(store, principal, target[0], target[1], data, "image/png",
                                f"{ch.get('name')} — portrait for book {number}")
    asset.update(project_id=target[0], branch_id=target[1], book=number, seed=seed if seed is not None else
                 resp.get("seed"), engine=resp.get("engine"), lock=None if no_lock else lock, fresh=True)
    rid = (ch.get("records") or {}).get(target[0])
    if rid:  # the book's own dossier shows it too when it has no portrait yet (never replaces one)
        try:
            art = (forge.raw_entry(store, target[0], target[1], rid) or {}).get("art") or {}
            if not (art.get("portrait") or {}).get("asset_id"):
                forge.set_art(store, target[0], target[1], rid, "portrait",
                              {k: asset[k] for k in ("asset_id", "version", "mime", "at", "seed", "engine")
                               if asset.get(k) is not None})
        except Exception:  # noqa: BLE001
            log.exception("series: dossier portrait of %s", rid)
    with _LOCK:
        cur = get(store, s["id"]) or s
        old = (cur["portraits"].get(str(number)) or {}).get(key)
        if old:
            cur["portraits_old"] = (cur.get("portraits_old") or []) + [dict(old, key=key, replaced_at=now_iso())]
            cur["portraits_old"] = cur["portraits_old"][-100:]
        cur["portraits"].setdefault(str(number), {})[key] = {k: v for k, v in asset.items() if v is not None}
        (cur["portrait_waiting"].get(str(number)) or {}).pop(key, None)
        _save(store, cur)
        s.update(cur)
    return asset


def _make_thing_picture(app, principal: str, s: dict, number: int, key: str, engine: str) -> dict:
    """📚 A place's establishing picture for one book (series_world.make_one_picture); stored in the series."""
    store = app.store

    def save(k, n, asset):
        with _LOCK:
            cur = get(store, s["id"]) or s
            old = (cur["thing_pictures"].get(str(n)) or {}).get(k)
            if old:
                cur["portraits_old"] = ((cur.get("portraits_old") or []) + [dict(old, key=k, replaced_at=now_iso())])[-100:]
            cur["thing_pictures"].setdefault(str(n), {})[k] = asset
            (cur["thing_picture_waiting"].get(str(n)) or {}).pop(k, None)
            _save(store, cur)
            s.update(cur)
    return world.make_one_picture(app, principal, s, number, key, engine, books=books(s),
                                  exists=lambda p: _exists(store, p), save=save)


def make_portraits(app, principal: str, pid: str, branch: str, *, number: int | None = None, check=None,
                   on_phase=None) -> dict:
    """Every per-book portrait waiting (of one book, or all). Picture maker down -> they stay waiting.
    -> {made, failed, code, message, down}."""
    from . import book_pictures, forge  # noqa: PLC0415
    store = app.store
    s = of_book(store, pid, branch)
    out = {"made": 0, "failed": 0, "code": "", "message": "", "down": False}
    if s.get("virtual"):
        return out
    plan = portrait_plan(store, s, number)
    if not plan:
        return out
    engine = book_pictures.settings(store)["engine"]
    ok, code, why = book_pictures.probe(app, engine)
    if not ok:
        with _LOCK:
            cur = get(store, s["id"]) or s
            for n, k, _name in plan:
                _mark_portrait(cur, n, k, code, why)
            _save(store, cur)
        out.update(failed=len(plan), code=code, message=why, down=True)
        return out
    for n, k, name in plan:
        if check:
            check()
        thing = k in (s.get("things") or {}) and k not in s["characters"]
        if on_phase:
            on_phase(f"Making the book {n} {'picture' if thing else 'portrait'} of “{name}”")
        try:
            if thing:
                _make_thing_picture(app, principal, s, n, k, engine)
            else:
                make_one_portrait(app, principal, s, n, k, engine)
            out["made"] += 1
        except forge.ArtProblem as exc:
            out["failed"] += 1
            out["code"], out["message"] = exc.code, exc.message or exc.code
            with _LOCK:
                cur = get(store, s["id"]) or s
                _mark_portrait(cur, n, k, exc.code, exc.message or exc.code)
                _save(store, cur)
                s.update(cur)
            if exc.code in book_pictures.ENGINE_DOWN:
                out["down"] = True
                out["failed"] += len(plan) - out["made"] - out["failed"]
                break
        except AkoweError as exc:
            out["failed"] += 1
            out["code"] = exc.code
            out["message"] = exc.errors[0].get("message") if exc.errors else exc.code
    return out


def start_portraits(app, principal: str, pid: str, branch: str, body=None) -> dict:
    from .review import ReviewJob  # noqa: PLC0415
    body = body if isinstance(body, dict) else {}
    s = of_book(app.store, pid, branch)
    n = body.get("book")
    if n is not None and (not isinstance(n, int) or isinstance(n, bool)):
        raise _err("INVALID_INPUT", "/book", "book: a book number")
    plan = [] if s.get("virtual") else portrait_plan(app.store, s, n)

    def fn(job):
        if not plan:
            job.results.append({"ok": True, "message": "No new portraits are waiting for this series."})
            return
        res = make_portraits(app, principal, pid, branch, number=n, check=job.check,
                             on_phase=lambda p: setattr(job, "phase", p))
        job.done = len(job.record_ids)
        msg = f"{res['made']} new picture(s) made (portraits with the same 🔒 character lock)." if res["made"] else \
            "No pictures were made."
        if res["failed"]:
            msg += f" {res['failed']} still waiting ({res['message'] or res['code']}): they stay on the to-make list; " \
                   "start Stable Diffusion in AutoInjector and press the button again."
        job.results.append({"ok": not res["failed"], "message": msg, **res})
    job = ReviewJob("series_portraits", principal, pid, branch, [k for _n, k, _x in plan] or [pid], None)
    return app.review._start(job, fn)  # noqa: SLF001


# ====================================================================== the view (the Book Bible's 📚 panel, the strip)
def strip(store, s: dict, key: str) -> list[dict]:
    """"Through the series": one box per book from the character's first book — the portrait of that book and what
    changed in it."""
    ch = s["characters"].get(key) or {}
    first = int(ch.get("first_book") or 1)
    out = []
    for b in books(s):
        if b["number"] < first:
            continue
        n = b["number"]
        d = _approved(s, n, key)
        prop = ((s.get("proposals") or {}).get(str(n)) or {}).get(key)
        out.append({"number": n, "title": b.get("title") or f"Book {n}", "project_id": b.get("project_id"),
                    "exists": _exists(store, b.get("project_id")),
                    "in_book": b.get("project_id") in (ch.get("records") or {}),
                    "portrait": portrait_of(store, s, key, n), "changes": d if d and not delta_empty(d) else None,
                    "words": delta_words(d) if d else "", "proposal": clean_delta(prop["delta"]) if prop else None,
                    "proposal_words": delta_words(prop["delta"]) if prop else "",
                    "portrait_waiting": key in ((s.get("portrait_waiting") or {}).get(str(n)) or {})})
    return out


def view(app, pid: str, branch: str) -> dict:
    """Everything the 📚 Series panel shows."""
    store = app.store
    raw = of_book(store, pid, branch)
    s = linked(store, raw)
    n = number_of(s, pid)
    bl = []
    for b in books(s):
        bl.append({"number": b["number"], "title": b.get("title") or f"Book {b['number']}",
                   "project_id": b.get("project_id"), "exists": _exists(store, b.get("project_id")),
                   "current": b.get("project_id") == pid})
    chars = []
    for k, ch in s["characters"].items():
        if pid not in (ch.get("records") or {}) and not any(
                ((s["changes"].get(str(b["number"])) or {}).get(k)) for b in books(s)):
            continue
        chars.append({"key": k, "name": ch.get("name"), "record_id": (ch.get("records") or {}).get(pid),
                      "first_book": ch.get("first_book"),
                      "fixed": {x: _clip((ch.get("fixed") or {}).get(x), 400) for x in ("name",) + FIXED_ATTRS},
                      "has_voice": bool((ch.get("fixed") or {}).get("voice")),
                      "start": state_words(state_as_of(s, k, n, "start")),
                      "end": state_words(state_as_of(s, k, n, "end")),
                      "strip": strip(store, s, k)})
    props = sum(len(v) for v in (s.get("proposals") or {}).values()) + \
        sum(len(v) for v in (s.get("thing_proposals") or {}).values())
    nxt = next((b for b in bl if b["number"] == n + 1 and b["exists"]), None)
    try:
        things = world.view_things(store, s, pid, n, lambda p: _exists(store, p))
    except Exception:  # noqa: BLE001 - the panel never fails over the world
        log.exception("series: the places / items / groups of the panel")
        things = []
    return {"in_series": not s.get("virtual"), "series_id": s.get("id"), "name": s.get("name") or "",
            "number": n, "books": bl, "characters": chars, "things": things, "proposals": props,
            "proposals_here": len((s.get("proposals") or {}).get(str(n)) or {}) +
            len((s.get("thing_proposals") or {}).get(str(n)) or {}),
            "sequel": sequel_status(app, pid, branch, s),
            "thing_categories": {k: [{"key": c, "label": lab, "help": hlp} for c, lab, hlp, _m in v["cats"]]
                                 for k, v in world.KINDS.items()},
            "portraits_waiting": len(portrait_plan(store, s)) if not s.get("virtual") else 0,
            "next_book": nxt, "problem": raw.get("problem"),
            "categories": [{"key": k, "label": label, "help": hlp} for k, label, hlp in CATS],
            "fixed_labels": FIXED_LABELS}


# ====================================================================== 📖 the binder "as of book N"
PIC_IDS = {"5": "5.1.1"}


def _overlay_page(store, s: dict, page: dict, pid: str, number: int, overlay: bool = True) -> None:
    if page.get("template") != "5" or not page.get("entry_id"):
        return
    k = key_of_record(s, pid, page["entry_id"])
    if k is None:
        return
    st = state_as_of(s, k, number, "end")
    page["series"] = {"key": k, "as_of": number, "strip": strip(store, s, k), "state": state_words(st),
                      "changed": st["changed"]}
    if not st["changed"] or not overlay:
        return
    secs = page.get("sections") or {}

    def put(code, fid, value):
        f = ((secs.get(code) or {}).get("fields") or {}).get(fid)
        if f is None or not value:
            return
        f.update(value=value, status="auto", source=f"series:as_of_book_{number}", series=True)
        f.pop("edit", None)
    w = state_words(st)
    if st["appearance_changes"]:
        put("5.6", "5.6.1", w["looks"])
    if st["items"] or st["items_lost"]:
        put("5.10", "5.10.3", "; ".join(e["text"] for e in st["items"]) or "(nothing — lost: " + w.get("lost", "") + ")")
    if st["abilities"]:
        put("5.9", "5.9.5", w.get("can", ""))
    pic = portrait_of(store, s, k, number)
    if pic:
        page.setdefault("pics", {})["5.1.1"] = {"url": pic["url"], "alt": pic["alt"]}
        f = ((secs.get("5.1") or {}).get("fields") or {}).get("5.1.1")
        if f is not None:
            f.update(value=pic["url"], status="supplied", source=f"series:portrait_book_{number}")


def _strip_edits(obj):
    if isinstance(obj, dict):
        obj.pop("edit", None)
        for v in obj.values():
            _strip_edits(v)
    elif isinstance(obj, list):
        for v in obj:
            _strip_edits(v)


def binder_block(app, data: dict, pid: str, branch: str, as_of: int | None = None) -> dict:
    """Adds ``series`` to a binder document (and, for a book in a series, each character page's "Through the series"
    strip and its state as of the chosen book). A single book only gets the small top-level block."""
    store = app.store
    raw = of_book(store, pid, branch)
    n = number_of(raw, pid)
    block = {"in_series": not raw.get("virtual"), "name": raw.get("name") or "", "number": n, "as_of": as_of or n,
             "books": [{"number": b["number"], "title": b.get("title") or f"Book {b['number']}",
                        "exists": _exists(store, b.get("project_id")), "current": b.get("project_id") == pid}
                       for b in books(raw)], "problem": raw.get("problem")}
    data["series"] = block
    if raw.get("virtual"):
        return data
    s = linked(store, raw)
    for p in data.get("pages") or []:
        _overlay_page(store, s, p, pid, as_of or n, overlay=as_of is not None)
        if p.get("template") in world.TEMPLATE_KIND:  # 📚 a place, an item or a group (series_world.py)
            try:
                world.overlay_page(store, s, p, pid, as_of or n, lambda x: _exists(store, x), overlay=as_of is not None)
            except Exception:  # noqa: BLE001 - the binder never fails over the series
                log.exception("series: the binder page %s", p.get("page_id"))
    # the cast list's portraits as of that book
    for p in data.get("pages") or []:
        if p.get("template") != "4":
            continue
        for sec in (p.get("sections") or {}).values():
            for i, r in enumerate(sec.get("rows") or []):
                rid = ((r or {}).get("_meta") or {}).get("entry_id")
                k = key_of_record(s, pid, rid) if rid else None
                pic = portrait_of(store, s, k, as_of) if k and as_of is not None else None
                if pic and isinstance(r.get("4.2.1"), dict):
                    r["4.2.1"].update(value=pic["url"], status="supplied", source="series:portrait")
                    p.setdefault("pics", {})[f"4.2.1#{i + 1}"] = {"url": pic["url"], "alt": pic["alt"]}
    return data


def build_as_of(app, pid: str, branch: str, look: str | None, as_of: int) -> dict:
    """The whole binder as of book ``as_of``: that book's own pages (when it is still in this Akọwe), each character
    at the END of that book. Another book's pages are read-only here (no edit buttons)."""
    from . import binder  # noqa: PLC0415
    store = app.store
    raw = of_book(store, pid, branch)
    if not isinstance(as_of, int) or isinstance(as_of, bool):
        raise _err("INVALID_INPUT", "/as_of", "as_of: a book number")
    target = next((b for b in books(raw) if b["number"] == as_of), None)
    if target is None:
        raise _err("NOT_FOUND", "/as_of", f"this series has no book {as_of}"
                   + (" (this book is not in a series yet)" if raw.get("virtual") else ""))
    note = None
    if target.get("project_id") == pid:
        data = binder._build(app, pid, branch, look=look)
    elif _exists(store, target.get("project_id")):
        data = binder._build(app, target["project_id"], target.get("branch_id") or "main", look=look)
        _strip_edits(data.get("pages"))
        note = f"You are looking at book {as_of} (“{target.get('title')}”) — read only here; open that book to change it."
    else:
        data = binder._build(app, pid, branch, look=look)
        _strip_edits(data.get("pages"))
        note = (f"Book {as_of} (“{target.get('title')}”) is not in this Akọwe any more: these are this book's pages "
                f"with each character as at the end of book {as_of}.")
    view_pid = target["project_id"] if target.get("project_id") != pid and _exists(store, target.get("project_id")) \
        else pid
    view_branch = target.get("branch_id") or "main" if view_pid != pid else branch
    if view_pid != pid:
        # the overlay reads the series from the viewed book's side (its records), the numbers from the series
        binder_block(app, data, view_pid, view_branch, as_of)
        data["series"]["number"] = number_of(raw, pid)
        for b in data["series"]["books"]:
            b["current"] = next((x for x in books(raw) if x["number"] == b["number"]), {}).get("project_id") == pid
    else:
        binder_block(app, data, pid, branch, as_of)
    data["series"].update(as_of=as_of, viewing={"number": as_of, "title": target.get("title"),
                                                "read_only": view_pid != pid or note is not None}, note=note)
    if note:
        data["read_only"] = True
    return data


def same_series(store, a: str, b: str) -> bool:
    ma, mb = member(store, a), member(store, b)
    return bool(ma and mb and ma["series_id"] == mb["series_id"])


# ====================================================================== the book bible
def bible_block(store, pid: str, branch: str) -> dict | None:
    """The series part of a book bible (names, numbers and changes; no record IDs of other books)."""
    raw = of_book(store, pid, branch)
    if raw.get("virtual"):
        return None
    s = linked(store, raw)
    chars = {}
    for k, ch in s["characters"].items():
        changes = {str(b["number"]): _approved(s, b["number"], k) for b in books(s)
                   if _approved(s, b["number"], k) and not delta_empty(_approved(s, b["number"], k))}
        chars[ch.get("name") or k] = {"first_book": ch.get("first_book"),
                                      "fixed": {x: (ch.get("fixed") or {}).get(x) for x in ("name",) + FIXED_ATTRS},
                                      "first_look": (ch.get("base") or {}).get("appearance"), "changes": changes}
    return {"name": s.get("name"), "number": number_of(s, pid),
            "books": [{"number": b["number"], "title": b.get("title")} for b in books(s)], "characters": chars,
            "things": world.bible_block(s, books(s))}


def bible_markdown(block: dict | None) -> list[str]:
    if not block:
        return []
    out = [f"## 📚 Series — {block.get('name') or ''} (this is book {block.get('number')})", ""]
    out += [f"- Book {b['number']}: {b.get('title') or ''}" for b in block.get("books") or []]
    out.append("")
    for name, c in (block.get("characters") or {}).items():
        if not c.get("changes"):
            continue
        out.append(f"### {name} — through the series")
        for n, d in sorted(c["changes"].items(), key=lambda x: int(x[0])):
            out.append(f"- **Book {n}:** {delta_words(d)}")
        out.append("")
    return out + world.bible_markdown(block.get("things"))
