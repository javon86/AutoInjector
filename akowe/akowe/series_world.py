"""📚 Series progression for PLACES, ITEMS and GROUPS (the world changes book by book too).

The same two layers as a character (series.py):

* **Fixed across the series** (``FIXED``): the name / identity, the core description and the origin — and, for a
  group, its symbol. A later book never changes them (the proposal and edit forms have no such fields).
* **Changeable per book** (``KINDS[kind]["cats"]``):
  - a place: how it looks, its state / condition, its ruler or owner, its danger level, who lives there, damage and
    rebuilding;
  - an item: its owner / holder, its condition, the powers it gained and lost, where it is;
  - a group (any 🌍 world page: a group, an organisation, a belief, a culture…): its leader, its members (joined,
    left), its allies, its enemies, its status.

Each book stores only its **changes** (``thing_changes[book][key]`` = a delta, with the chapter when known), and
``state_as_of(s, key, n, "start"|"end")`` applies them in book order: a "latest" category (ruler, holder, leader,
condition, location, danger, status) is what the last change says; a "list" category (who lives there, members,
allies, enemies, damage, how it looks) gathers every change; "gain"/"lose" (an item's powers) work like a
character's belongings.

Where it lives: in the series record (``series:<id>``) next to the characters — ``things`` (a series key per place /
item / group, with the entity in each book, the fixed layer and the first state), ``thing_changes`` (approved),
``thing_proposals`` (the AI's, waiting for the author), ``thing_pictures`` / ``thing_picture_waiting`` (a place's
establishing picture per book, when its look changed).

Proposals come from the same ✨ Find what changed in this book call as the characters' (``thing_changes`` in the AI's
answer) and are never used before the author approves them. When the author approves a character's change that says
they gained (or lost) an item that has its own page, the item's holder changes in that book too (``link_items``).
"""
from __future__ import annotations

import logging
import re
import types
import uuid

from .jobs import now_iso

log = logging.getLogger("akowe.series_world")

TEXT_MAX = 300
CHAPTER_MAX = 40
PER_CAT = 12
FIXED_MAX = 600
BRIEF_BUDGET = 1600

# kind -> plain words, the binder template, the key prefix and the changeable categories
# (key, plain label, ⓘ help, mode: latest | list | gain:<lost key> | lose)
KINDS = {
    "place": {"label": "Place", "plural": "places", "icon": "🏙", "template": "7", "prefix": "p", "cats": (
        ("look", "How it looks", "What changed in how it looks: burned, overgrown, new walls, snow all year…", "list"),
        ("condition", "State and condition", "Its state now: thriving, abandoned, under siege, flooded…", "latest"),
        ("ruler", "Ruler or owner", "Who rules or owns it now.", "latest"),
        ("danger", "Danger level", "How dangerous it is now (safe, risky, deadly…).", "latest"),
        ("residents", "Who lives there", "Who moved in or left (one line each).", "list"),
        ("damage", "Damaged or rebuilt", "What was damaged, destroyed or rebuilt.", "list"))},
    "item": {"label": "Item", "plural": "items", "icon": "🗡", "template": "8B", "prefix": "i", "cats": (
        ("holder", "Owner or holder", "Who has it now.", "latest"),
        ("condition", "Condition", "Its condition now: cracked, repaired, glowing, rusted…", "latest"),
        ("powers_gained", "Powers gained", "New powers or uses it gained.", "gain:powers_lost"),
        ("powers_lost", "Powers lost", "Powers or uses it lost.", "lose"),
        ("location", "Where it is", "Where it is now.", "latest"))},
    "group": {"label": "Group", "plural": "groups", "icon": "🌍", "template": "8C", "prefix": "g", "cats": (
        ("leader", "Leader", "Who leads it now.", "latest"),
        ("members", "Members", "Who joined or left (one line each).", "list"),
        ("allies", "Allies", "New allies (one line each).", "list"),
        ("enemies", "Enemies", "New enemies (one line each).", "list"),
        ("status", "Status", "Its status now: rising, outlawed, broken, in hiding…", "latest"))},
}
TEMPLATE_KIND = {v["template"]: k for k, v in KINDS.items()}
FIXED = ("name", "description", "origin", "symbol")
FIXED_LABELS = {"name": "Name", "description": "Core description", "origin": "Origin", "symbol": "Symbol"}
# the binder fields a book's state is shown in ("as of book N"): cat -> [(field id, append?)]
OVERLAY = {
    "place": {"look": [("7.10.3", True)], "condition": [("7.10.10", False)], "ruler": [("7.2.6", False),
              ("7.7.3", False)], "danger": [("7.2.7", False)], "residents": [("7.7.1", True)],
              "damage": [("7.6.5", True)]},
    "item": {"holder": [("8B.2.4", False), ("8B.7.1", False)], "condition": [("8B.2.5", False), ("8B.8.7", False)],
             "powers_gained": [("8B.4.1", True)], "location": [("8B.8.6", False)]},
    "group": {"leader": [("8C.3.3", False)], "members": [("8C.5.1", True)], "allies": [("8C.5.2", True)],
              "enemies": [("8C.5.3", True)]},
}
PIC_FIELD = {"place": "7.1.1"}
PIC_CATS = ("look", "damage")   # a place whose look changed (or was damaged / rebuilt) gets a picture for that book


def cats(kind: str) -> tuple:
    return KINDS[kind]["cats"] if kind in KINDS else ()


def cat_keys(kind: str) -> tuple:
    return tuple(c[0] for c in cats(kind))


def mode(kind: str, cat: str) -> str:
    return next((c[3] for c in cats(kind) if c[0] == cat), "list")


def label(kind: str, cat: str) -> str:
    return next((c[1] for c in cats(kind) if c[0] == cat), cat)


def single_cats(kind: str) -> set:
    return {c[0] for c in cats(kind) if c[3] == "latest"}


def _clip(v, n: int) -> str:
    return " ".join(str(v or "").split())[:n] if isinstance(v, (str, int, float)) and not isinstance(v, bool) else ""


def norm(name) -> str:
    return " ".join(re.sub(r"[^\w\s]", " ", str(name or "").casefold()).split())


_ARTICLES = re.compile(r"^(?:the|a|an|his|her|their|its|my) ")


def same(a: str, b: str) -> bool:
    a, b = _ARTICLES.sub("", norm(a)), _ARTICLES.sub("", norm(b))
    return bool(a and b) and (a == b or (len(a) > 3 and a in b) or (len(b) > 3 and b in a))


# ====================================================================== a delta (the changes of one book)
def clean_delta(kind: str, raw) -> dict:
    """Every category of the kind a list of {text, chapter} (at most ``PER_CAT``); anything else (a fixed-layer field,
    another kind's category) is dropped."""
    raw = raw if isinstance(raw, dict) else {}
    out = {}
    for k in cat_keys(kind):
        v = raw.get(k)
        if isinstance(v, (str, dict)):
            v = [v]
        items, seen = [], set()
        for x in v if isinstance(v, list) else []:
            if isinstance(x, str):
                x = {"text": x}
            if not isinstance(x, dict):
                continue
            text = _clip(x.get("text") or x.get("change") or x.get("now"), TEXT_MAX)
            if not text or norm(text) in seen:
                continue
            seen.add(norm(text))
            e = {"text": text, "chapter": _clip(x.get("chapter"), CHAPTER_MAX) or None}
            if isinstance(x.get("linked_from"), str):
                e["linked_from"] = x["linked_from"][:40]
            items.append(e)
            if len(items) >= PER_CAT:
                break
        out[k] = items
    return out


def delta_empty(d) -> bool:
    return not any(v for v in (d or {}).values() if isinstance(v, list))


def merge_delta(kind: str, old, new) -> dict:
    """``old`` plus the entries of ``new`` it does not have yet (never removes anything)."""
    out = clean_delta(kind, old)
    for k, items in clean_delta(kind, new).items():
        have = {norm(e["text"]) for e in out[k]}
        for e in items:
            if norm(e["text"]) not in have and len(out[k]) < PER_CAT:
                out[k].append(e)
                have.add(norm(e["text"]))
    return out


def delta_words(kind: str, d) -> str:
    """One plain line: "Ruler or owner: the Salt Guild · Damaged or rebuilt: the north wall burned"."""
    d = clean_delta(kind, d)
    return " · ".join(f"{label(kind, k)}: " + "; ".join(e["text"] for e in d[k]) for k in cat_keys(kind) if d[k])


# ====================================================================== the places / items / groups of one book
def _shim(store):
    return types.SimpleNamespace(store=store, principal_id="author")


def _dfield(d: dict | None, key: str) -> str:
    for sec in (d or {}).get("sections") or []:
        for f in sec.get("fields") or []:
            if f.get("key") == key and f.get("text"):
                return str(f["text"])
    return ""


def _attrs(rec) -> dict:
    a = ((rec or {}).get("data") or {}).get("attributes")
    return a if isinstance(a, dict) else {}


def _concept(rec) -> str:
    c = ((rec or {}).get("data") or {}).get("concept")
    return c if isinstance(c, str) else ""


def _first(*vals) -> str:
    for v in vals:
        t = _clip(v, FIXED_MAX)
        if t:
            return t
    return ""


def _new_value(store, pid, branch, target: str, key: str) -> str:
    try:
        from . import binder_fields as bf  # noqa: PLC0415
        v = (bf.values(store, pid, branch, target).get(key) or {}).get("value")
        return _clip(v, FIXED_MAX) if v not in (None, "") else ""
    except Exception:  # noqa: BLE001
        return ""


def book_things(store, pid: str, branch: str) -> list[dict]:
    """[{kind, id, rid, name, aliases, fixed, base}] — the places (A04 / place dossiers), items (A12 / item dossiers)
    and 🌍 world pages (other Set A entries) of one book, read the way the binder reads them. Never raises."""
    from . import binder  # noqa: PLC0415
    try:
        b = binder.Book(_shim(store), pid, branch)
        places, items, others = b.places, b.items, b.others
    except Exception:  # noqa: BLE001
        log.exception("series: the places / items / groups of %s", pid)
        return []
    out = []
    for e in places:
        d, rec = e.get("dossier") or {}, e.get("canon")
        a = _attrs(rec)
        out.append({"kind": "place", "id": e["id"], "rid": d.get("record_id") or (rec or {}).get("record_id"),
                    "name": e["name"], "aliases": list(e.get("aliases") or [])[:6],
                    "fixed": {"name": e["name"], "description": _first(_dfield(d, "one_line"), a.get("description"),
                                                                        _concept(rec)),
                              "origin": _first(_dfield(d, "founding"), a.get("history"), a.get("origin"))},
                    "base": {k: v for k, v in {
                        "look": _first(_dfield(d, "first_impression"), _dfield(d, "sights"), a.get("description")),
                        "ruler": _first(_dfield(d, "rulers"), a.get("rulers"), a.get("ruler")),
                        "residents": _first(_dfield(d, "population"), a.get("population")),
                        "danger": _new_value(store, pid, branch, f"place:{e['id']}", "danger_level")}.items() if v}})
    for e in items:
        d, rec = e.get("dossier") or {}, e.get("canon")
        a = _attrs(rec)
        out.append({"kind": "item", "id": e["id"], "rid": d.get("record_id") or (rec or {}).get("record_id"),
                    "name": e["name"], "aliases": list(e.get("aliases") or [])[:6],
                    "fixed": {"name": e["name"], "description": _first(_dfield(d, "one_line"), a.get("description"),
                                                                        a.get("concept"), _concept(rec)),
                              "origin": _first(_dfield(d, "origin"), a.get("origin"))},
                    "base": {k: v for k, v in {
                        "holder": _first(_dfield(d, "current_holder"), _dfield(d, "owner"), a.get("owner")),
                        "condition": _first(_dfield(d, "status_now"), a.get("condition")),
                        "location": _first(a.get("location"))}.items() if v}})
    for o in others:
        rec = o.get("rec")
        a = _attrs(rec)
        out.append({"kind": "group", "id": o["id"], "rid": o["id"], "name": o["name"], "aliases": [],
                    "fixed": {"name": o["name"], "description": _first(a.get("description"), a.get("concept"),
                                                                        _concept(rec)),
                              "origin": _first(a.get("history"), a.get("origin"), a.get("founded")),
                              "symbol": _new_value(store, pid, branch, f"group:{o['id']}", "symbol_colours")},
                    "base": {k: v for k, v in {"leader": _first(a.get("leaders"), a.get("leader"), a.get("hierarchy")),
                                               "status": _first(a.get("status"))}.items() if v}})
    return out


def _key_for(s: dict, pid: str, t: dict) -> str | None:
    things = s.get("things") or {}
    for k, th in things.items():
        if th.get("kind") == t["kind"] and (th.get("records") or {}).get(pid) == t["id"]:
            return k
    n = norm(t.get("name"))
    if not n:
        return None
    for k, th in things.items():
        if th.get("kind") != t["kind"] or pid in (th.get("records") or {}):
            continue
        if n == norm(th.get("name")) or n in {norm(a) for a in th.get("aliases") or []}:
            return k
    return None


def link_things(store, s: dict, pid: str, branch: str, number: int, things: list | None = None) -> None:
    """Every place / item / group of one book gets its series key (same entity, same name, or a new one of this
    book). The fixed layer and the first state come from the first book it is in (in place)."""
    s.setdefault("things", {})
    for t in things if things is not None else book_things(store, pid, branch):
        k = _key_for(s, pid, t)
        if k is None:
            pre = KINDS[t["kind"]]["prefix"]
            k = f"{pre}{sum(1 for x in s['things'] if x.startswith(pre)) + 1}"
            while k in s["things"] or k in (s.get("characters") or {}):
                k = f"{pre}{uuid.uuid4().hex[:6]}"
            s["things"][k] = {"kind": t["kind"], "name": t["name"], "aliases": [], "first_book": number,
                              "records": {}, "rids": {}, "fixed": t["fixed"], "base": t["base"]}
        th = s["things"][k]
        th.setdefault("records", {})[pid] = t["id"]
        if t.get("rid"):
            th.setdefault("rids", {})[pid] = t["rid"]
        if number < int(th.get("first_book") or number):
            th["first_book"] = number
        if number == int(th.get("first_book") or number):
            th["fixed"], th["base"], th["name"] = t["fixed"], t["base"], t["name"]
        elif norm(t["name"]) != norm(th.get("name")) and t["name"] not in th.get("aliases", []):
            th.setdefault("aliases", []).append(t["name"][:120])


def key_of_page(s: dict, pid: str, page: dict) -> str | None:
    """The series key of a binder page of a place (7), an item (8B) or a world entry (8C)."""
    kind = TEMPLATE_KIND.get(page.get("template"))
    if kind is None:
        return None
    eid, target, title = page.get("entry_id"), str(page.get("target") or ""), norm(page.get("title"))
    tid = target.split(":", 1)[1] if ":" in target else None
    for k, th in (s.get("things") or {}).items():
        if th.get("kind") != kind:
            continue
        if (tid and (th.get("records") or {}).get(pid) == tid) or (eid and (th.get("rids") or {}).get(pid) == eid):
            return k
    for k, th in (s.get("things") or {}).items():
        if th.get("kind") == kind and pid in (th.get("records") or {}) and title and title == norm(th.get("name")):
            return k
    return None


# ====================================================================== state "as of book N"
def approved(s: dict, number: int, key: str) -> dict | None:
    th = (s.get("things") or {}).get(key) or {}
    e = ((s.get("thing_changes") or {}).get(str(number)) or {}).get(key)
    return clean_delta(th.get("kind"), e.get("delta")) if isinstance(e, dict) else None


def state_as_of(s: dict, key: str, number: int, when: str = "end") -> dict:
    th = (s.get("things") or {}).get(key) or {}
    kind = th.get("kind")
    base = th.get("base") or {}
    first = int(th.get("first_book") or 1)
    last = number - 1 if when == "start" else number
    st = {"kind": kind, "now": {}, "lists": {}, "powers": [], "powers_lost": [], "as_of": {"book": number,
                                                                                            "when": when},
          "changed": False}
    for c, _l, _h, m in cats(kind):
        if m == "latest":
            st["now"][c] = {"text": base[c], "book": first, "base": True} if base.get(c) else None
        elif m == "list":
            st["lists"][c] = []
    for n in range(first, last + 1):
        d = approved(s, n, key)
        if not d or delta_empty(d):
            continue
        st["changed"] = True
        for c, _l, _h, m in cats(kind):
            if m == "latest" and d[c]:
                st["now"][c] = dict(d[c][-1], book=n)
            elif m == "list":
                st["lists"][c] += [dict(e, book=n) for e in d[c]]
        for e in d.get("powers_lost") or []:
            st["powers"] = [x for x in st["powers"] if not same(x["text"], e["text"])]
            st["powers_lost"].append(dict(e, book=n))
        for e in d.get("powers_gained") or []:
            if not any(same(x["text"], e["text"]) for x in st["powers"]):
                st["powers"].append(dict(e, book=n))
            st["powers_lost"] = [x for x in st["powers_lost"] if not same(x["text"], e["text"])]
    return st


def state_words(st: dict) -> dict:
    """{plain label: text} of a state (the binder strip, the brief, the exports)."""
    kind = st.get("kind")
    out = {}
    for c, lab, _h, m in cats(kind):
        if m == "latest" and st["now"].get(c):
            out[lab] = st["now"][c]["text"]
        elif m == "list" and st["lists"].get(c):
            out[lab] = "; ".join(e["text"] for e in st["lists"][c])
        elif m.startswith("gain") and st.get("powers"):
            out[lab] = "; ".join(e["text"] for e in st["powers"])
        elif m == "lose" and st.get("powers_lost"):
            out[lab] = "; ".join(e["text"] for e in st["powers_lost"])
    return out


def cat_words(st: dict) -> dict:
    """{cat key: text} of a state (the binder field overlay)."""
    kind = st.get("kind")
    out = {}
    for c, _lab, _h, m in cats(kind):
        if m == "latest" and st["now"].get(c) and not st["now"][c].get("base"):
            out[c] = st["now"][c]["text"]
        elif m == "list" and st["lists"].get(c):
            out[c] = "; ".join(e["text"] for e in st["lists"][c])
        elif m.startswith("gain") and st.get("powers"):
            out[c] = "; ".join(e["text"] for e in st["powers"])
        elif m == "lose" and st.get("powers_lost"):
            out[c] = "; ".join(e["text"] for e in st["powers_lost"])
    return out


# ====================================================================== ✨ the AI's part of "find what changed"
TASK = (
    " Also say, for each place, item and group in context.things, what CHANGED for it during THIS book "
    "(thing_changes: one entry per thing with a change; 'kind' and 'name' exactly as context.things gives them; each "
    "change has a 'category' from that thing's context.things[].categories, one short plain sentence and the "
    "chapter_id). Its name, its core description, its origin and a group's symbol NEVER change in a series: never put "
    "them in a change. context.things[].at_start says how it was when this book began: do not repeat it.")
SCHEMA = {"type": "array", "maxItems": 60, "items": {
    "type": "object", "additionalProperties": False, "required": ["name", "kind", "changes"],
    "properties": {"name": {"type": "string"}, "kind": {"type": "string", "enum": list(KINDS)},
                   "changes": {"type": "array", "maxItems": 24, "items": {
                       "type": "object", "additionalProperties": False, "required": ["category", "text", "chapter"],
                       "properties": {"category": {"type": "string"}, "text": {"type": "string"},
                                      "chapter": {"type": "string"}}}}}}}


def context_things(s: dict, pid: str, number: int) -> list[dict]:
    out = []
    for k, th in (s.get("things") or {}).items():
        if pid not in (th.get("records") or {}):
            continue
        out.append({"name": th.get("name"), "kind": th.get("kind"),
                    "fixed_never_changes": {x: _clip((th.get("fixed") or {}).get(x), 300) for x in FIXED
                                            if (th.get("fixed") or {}).get(x)},
                    "at_start": state_words(state_as_of(s, k, number, "start")),
                    "categories": list(cat_keys(th.get("kind")))})
    return out[:40]


def _find_key(s: dict, pid: str, kind, name) -> str | None:
    n = norm(name)
    for k, th in (s.get("things") or {}).items():
        if (kind in KINDS and th.get("kind") != kind) or pid not in (th.get("records") or {}):
            continue
        if n and (n == norm(th.get("name")) or n in {norm(a) for a in th.get("aliases") or []}):
            return k
    return None


def save_proposals(s: dict, pid: str, number: int, raw, *, by: str = "ai", slot=None) -> dict:
    """The AI's ``thing_changes`` -> proposals of this book (in place). A proposal never replaces an approved change
    (only what the approved one does not say yet is proposed)."""
    items = raw if isinstance(raw, list) else []
    props = s.setdefault("thing_proposals", {}).setdefault(str(number), {})
    made, unknown, same_n = [], [], 0
    for it in items:
        if not isinstance(it, dict):
            continue
        name = _clip(it.get("name"), 120)
        key = _find_key(s, pid, it.get("kind"), name)
        if key is None:
            if name:
                unknown.append(name)
            continue
        kind = s["things"][key]["kind"]
        raw_d = {}
        for ch in it.get("changes") if isinstance(it.get("changes"), list) else []:
            if isinstance(ch, dict) and ch.get("category") in cat_keys(kind):
                raw_d.setdefault(ch["category"], []).append({"text": ch.get("text"), "chapter": ch.get("chapter")})
        for c in cat_keys(kind):  # also accepted: the categories as keys ({"ruler": [...]})
            if isinstance(it.get(c), (list, str, dict)):
                raw_d.setdefault(c, [])
                raw_d[c] += it[c] if isinstance(it[c], list) else [it[c]]
        d = clean_delta(kind, raw_d)
        have = approved(s, number, key)
        if have:
            merged = merge_delta(kind, have, d)
            d = {c: [e for e in merged[c] if e not in have[c]] for c in cat_keys(kind)}
        if delta_empty(d):
            same_n += 1
            continue
        props[key] = {"delta": d, "by": by, "slot": slot, "at": now_iso()}
        made.append(key)
    return {"proposed": len(made), "keys": made, "unknown": unknown[:10], "unchanged": same_n}


def mark_picture(s: dict, n: int, key: str, code: str, why: str) -> None:
    s.setdefault("thing_picture_waiting", {}).setdefault(str(n), {})[key] = {"code": code, "why": why[:300],
                                                                            "at": now_iso()}


def _look_grew(kind: str, before: dict, after: dict) -> bool:
    return kind == "place" and any(len(after.get(c) or []) > len(before.get(c) or []) or
                                   ([e["text"] for e in after.get(c) or []] != [e["text"] for e in before.get(c) or []]
                                    and after.get(c)) for c in PIC_CATS)


def approve(s: dict, n: int, key: str) -> dict:
    """✔ Approve the AI's proposal for one place / item / group (merged; nothing removed). In place."""
    th = s["things"][key]
    p = ((s.get("thing_proposals") or {}).get(str(n)) or {}).get(key)
    if not p:
        return {}
    before = approved(s, n, key) or clean_delta(th["kind"], {})
    merged = merge_delta(th["kind"], before, p["delta"])
    s.setdefault("thing_changes", {}).setdefault(str(n), {})[key] = {"delta": merged, "by": "author",
                                                                    "approved_from": p.get("by"), "at": now_iso()}
    s["thing_proposals"][str(n)].pop(key, None)
    pic = _look_grew(th["kind"], before, merged)
    if pic:
        mark_picture(s, n, key, "NEW_LOOK", "its look changed in this book")
    return {"ok": True, "key": key, "kind": th["kind"], "book": n, "delta": merged, "portrait_needed": pic,
            "message": f"Approved: {delta_words(th['kind'], merged)}"}


def dismiss(s: dict, n: int, key: str) -> dict:
    gone = ((s.get("thing_proposals") or {}).get(str(n)) or {}).pop(key, None)
    return {"ok": True, "key": key, "book": n, "dismissed": bool(gone)}


def bad_edit_keys(kind: str, delta: dict) -> list[str]:
    return [k for k in delta if k not in cat_keys(kind)]


def edit(s: dict, n: int, key: str, raw_delta: dict) -> dict:
    """✏ The author's own changes of one place / item / group in one book (approved as written). In place."""
    th = s["things"][key]
    d = clean_delta(th["kind"], raw_delta)
    before = approved(s, n, key) or clean_delta(th["kind"], {})
    s.setdefault("thing_changes", {}).setdefault(str(n), {})[key] = {"delta": d, "by": "author", "at": now_iso()}
    pic = _look_grew(th["kind"], before, d)
    if pic:
        mark_picture(s, n, key, "NEW_LOOK", "its look changed in this book")
    return {"ok": True, "key": key, "kind": th["kind"], "book": n, "delta": d, "portrait_needed": pic}


def link_items(s: dict, n: int, char_key: str, added: dict) -> list[str]:
    """A character's newly approved items gained / lost in book ``n``: the item's own page (when it has one) gets the
    holder change in that book too. Returns the item names changed (in place)."""
    ch = (s.get("characters") or {}).get(char_key) or {}
    who = ch.get("name") or ""
    if not who:
        return []
    done = []
    for cat, word in (("items_gained", None), ("items_lost", "no longer with ")):
        for e in (added or {}).get(cat) or []:
            key = next((k for k, th in (s.get("things") or {}).items() if th.get("kind") == "item" and
                        any(same(e.get("text"), x) for x in [th.get("name")] + list(th.get("aliases") or []))), None)
            if key is None:
                continue
            text = f"{word}{who}" if word else who
            cur = approved(s, n, key) or clean_delta("item", {})
            if any(norm(x["text"]) == norm(text) for x in cur["holder"]):
                continue
            new = merge_delta("item", cur, {"holder": [{"text": text, "chapter": e.get("chapter"),
                                                        "linked_from": char_key}]})
            old = ((s.get("thing_changes") or {}).get(str(n)) or {}).get(key) or {}
            s.setdefault("thing_changes", {}).setdefault(str(n), {})[key] = {
                "delta": new, "by": old.get("by") or "author", "linked_from": char_key, "at": now_iso()}
            done.append(s["things"][key]["name"])
    return done


# ====================================================================== 🖼 a place's picture per book
def picture_plan(s: dict, number: int | None = None) -> list[tuple[int, str, str]]:
    out = []
    for n, ws in sorted((s.get("thing_picture_waiting") or {}).items(), key=lambda x: int(x[0])):
        if number is not None and int(n) != number:
            continue
        for k in ws:
            if k in (s.get("things") or {}):
                out.append((int(n), k, s["things"][k].get("name") or k))
    return out


def picture_prompt(s: dict, key: str, number: int) -> str:
    th = s["things"][key]
    f = th.get("fixed") or {}
    st = state_as_of(s, key, number, "end")
    parts = [f.get("name") or th.get("name"), f.get("description") or (th.get("base") or {}).get("look")]
    changes = [e["text"].rstrip(".") for c in PIC_CATS for e in st["lists"].get(c) or []]
    now = state_words(st)
    if changes:
        parts.append(f"How it looks by the end of book {number}: " + "; ".join(changes))
    if now.get("State and condition"):
        parts.append(f"Now: {now['State and condition']}")
    parts.append("wide establishing shot of this place, cinematic composition, detailed environment concept art, "
                 "no text")
    return ". ".join(p for p in parts if p)[:1800]


def make_one_picture(app, principal: str, s: dict, number: int, key: str, engine: str, *, books, exists,
                     save) -> dict:
    """One establishing picture of a place for book ``number``. Raises forge.ArtProblem / AkoweError."""
    from . import forge  # noqa: PLC0415
    from .errors import AkoweError  # noqa: PLC0415
    store = app.store
    th = s["things"][key]
    b = next((x for x in books if x["number"] == number and exists(x.get("project_id"))), None)
    if b is None:
        b = next((x for x in sorted(books, key=lambda x: -x["number"]) if x["number"] <= number and
                  x.get("project_id") in (th.get("records") or {}) and exists(x.get("project_id"))), None)
    if b is None:
        raise AkoweError("NOT_FOUND", "/book", f"book {number} is not in this Akọwe any more, so its picture cannot "
                                               "be stored", status="REJECTED")
    body = {"engine": engine, "prompt": picture_prompt(s, key, number), "book": s.get("name") or None,
            "from": "akowe-series", "returnImage": True, "purpose": "scene"}
    resp = forge.request_image(app, {k: v for k, v in body.items() if v is not None})
    data, seed = forge.first_picture(resp)
    target = (b["project_id"], b.get("branch_id") or "main")
    asset = forge.store_picture(store, principal, target[0], target[1], data, "image/png",
                                f"{th.get('name')} — picture for book {number}")
    asset.update(project_id=target[0], branch_id=target[1], book=number,
                 seed=seed if seed is not None else resp.get("seed"), engine=resp.get("engine"), fresh=True)
    save(key, number, {k: v for k, v in asset.items() if v is not None})
    return asset


def picture_of(store, s: dict, key: str, number: int, exists) -> dict | None:
    """The picture to show for a place in book ``number``: the one made for that book, else that book's own
    establishing picture (an item: its portrait), else None."""
    from . import forge, forge_kinds  # noqa: PLC0415
    th = (s.get("things") or {}).get(key) or {}
    p = ((s.get("thing_pictures") or {}).get(str(number)) or {}).get(key)
    if isinstance(p, dict) and p.get("asset_id") and exists(p.get("project_id")):
        pub = forge._art_public(p["project_id"], p.get("branch_id") or "main", p)  # noqa: SLF001
        if pub:
            return {"url": pub["url"], "alt": f"{th.get('name', '')} in book {number}", "book": number,
                    "made_for_book": True}
    hero = {"place": "establishing", "item": "portrait"}.get(th.get("kind"))
    b = next((x for x in s.get("books") or [] if x.get("number") == number), None)
    rid = ((th.get("rids") or {}).get((b or {}).get("project_id")))
    if hero and b and rid and exists(b.get("project_id")):
        try:
            entry = forge_kinds._get(store, b["project_id"], b.get("branch_id") or "main", th["kind"], rid)  # noqa: SLF001
            a = ((entry or {}).get("art") or {}).get(hero)
            pub = forge._art_public(b["project_id"], b.get("branch_id") or "main", a) if a else None  # noqa: SLF001
        except Exception:  # noqa: BLE001
            pub = None
        if pub:
            return {"url": pub["url"], "alt": f"{th.get('name', '')} in book {number}", "book": number,
                    "made_for_book": False}
    return None


# ====================================================================== the view, the strip, the binder overlay
def strip(store, s: dict, key: str, exists) -> list[dict]:
    th = (s.get("things") or {}).get(key) or {}
    kind = th.get("kind")
    first = int(th.get("first_book") or 1)
    out = []
    for b in sorted([x for x in s.get("books") or [] if isinstance(x.get("number"), int)], key=lambda x: x["number"]):
        n = b["number"]
        if n < first:
            continue
        d = approved(s, n, key)
        prop = ((s.get("thing_proposals") or {}).get(str(n)) or {}).get(key)
        out.append({"number": n, "title": b.get("title") or f"Book {n}", "project_id": b.get("project_id"),
                    "exists": exists(b.get("project_id")), "in_book": b.get("project_id") in (th.get("records") or {}),
                    "portrait": picture_of(store, s, key, n, exists),
                    "changes": d if d and not delta_empty(d) else None, "words": delta_words(kind, d) if d else "",
                    "proposal": clean_delta(kind, prop["delta"]) if prop else None,
                    "proposal_words": delta_words(kind, prop["delta"]) if prop else "",
                    "portrait_waiting": key in ((s.get("thing_picture_waiting") or {}).get(str(n)) or {})})
    return out


def view_things(store, s: dict, pid: str, number: int, exists) -> list[dict]:
    out = []
    for k, th in (s.get("things") or {}).items():
        if pid not in (th.get("records") or {}) and not any(
                (((s.get("thing_changes") or {}).get(str(b.get("number"))) or {}).get(k)) for b in s.get("books") or []):
            continue
        kind = th.get("kind")
        out.append({"key": k, "kind": kind, "kind_label": KINDS.get(kind, {}).get("label", kind),
                    "icon": KINDS.get(kind, {}).get("icon", ""), "name": th.get("name"),
                    "first_book": th.get("first_book"),
                    "fixed": {x: _clip((th.get("fixed") or {}).get(x), 400) for x in FIXED
                              if (th.get("fixed") or {}).get(x)},
                    "start": state_words(state_as_of(s, k, number, "start")),
                    "end": state_words(state_as_of(s, k, number, "end")),
                    "strip": strip(store, s, k, exists)})
    return out


def overlay_page(store, s: dict, page: dict, pid: str, number: int, exists, overlay: bool = True) -> None:
    """A place / item / group page: its "Through the series" strip and its state as of book ``number``; with
    ``overlay`` (📖 As of book N) the fields that hold that state show it (read only)."""
    k = key_of_page(s, pid, page)
    if k is None:
        return
    th = s["things"][k]
    kind = th["kind"]
    st = state_as_of(s, k, number, "end")
    page["series"] = {"key": k, "kind": kind, "as_of": number, "strip": strip(store, s, k, exists),
                      "state": state_words(st), "changed": st["changed"]}
    if not st["changed"] or not overlay:
        return
    secs = page.get("sections") or {}
    words = cat_words(st)
    for cat, fids in OVERLAY.get(kind, {}).items():
        text = words.get(cat)
        if not text:
            continue
        for fid, append in fids:
            sec = secs.get(fid.rsplit(".", 1)[0]) or {}
            f = (sec.get("fields") or {}).get(fid)
            if f is None:
                continue
            old = str(f.get("value") or "").strip()
            value = f"{old} · Through the series: {text}" if append and old and text not in old else text
            f.update(value=value, status="auto", source=f"series:as_of_book_{number}", series=True)
            f.pop("edit", None)
    fid = PIC_FIELD.get(kind)
    p = ((s.get("thing_pictures") or {}).get(str(number)) or {}).get(k)
    pic = picture_of(store, s, k, number, exists) if fid and p else None
    if pic:
        page.setdefault("pics", {})[fid] = {"url": pic["url"], "alt": pic["alt"]}
        f = ((secs.get(fid.rsplit(".", 1)[0]) or {}).get("fields") or {}).get(fid)
        if f is not None:
            f.update(value=pic["url"], status="supplied", source=f"series:picture_book_{number}")


# ====================================================================== the writer's brief, the book bible
def writer_brief(s: dict, pid: str, number: int) -> list[dict]:
    """[{name, kind, as_of, <label>: text}] — the places / items / groups of this book that changed in earlier books
    of the series, as the previous book left them."""
    import json  # noqa: PLC0415
    out, size = [], 0
    for k, th in (s.get("things") or {}).items():
        if pid not in (th.get("records") or {}) or int(th.get("first_book") or number) >= number:
            continue
        st = state_as_of(s, k, number, "start")
        if not st["changed"]:
            continue
        item = {"name": th.get("name"), "kind": th.get("kind"), "as_of": f"start of book {number}",
                **{lab: v[:300] for lab, v in state_words(st).items()}}
        cost = len(json.dumps(item, ensure_ascii=False))
        if size + cost > BRIEF_BUDGET:
            break
        size += cost
        out.append(item)
    return out


BRIEF_RULE = ("Series (context.writing_brief.series_world): the places, items and groups listed start this book "
              "exactly as the previous book left them — keep who rules or holds them, their condition, danger, "
              "members, allies and enemies, and how they look now. Their names, core descriptions and origins never "
              "change.")


def bible_block(s: dict, books: list) -> dict:
    out = {}
    for k, th in (s.get("things") or {}).items():
        changes = {}
        for b in books:
            d = approved(s, b["number"], k)
            if d and not delta_empty(d):
                changes[str(b["number"])] = d
        out[f"{th.get('name') or k} ({th.get('kind')})"] = {
            "kind": th.get("kind"), "name": th.get("name"), "first_book": th.get("first_book"),
            "fixed": {x: (th.get("fixed") or {}).get(x) for x in FIXED if (th.get("fixed") or {}).get(x)},
            "changes": changes}
    return out


def bible_markdown(things: dict) -> list[str]:
    out = []
    for name, t in (things or {}).items():
        if not t.get("changes"):
            continue
        out.append(f"### {t.get('name') or name} ({KINDS.get(t.get('kind'), {}).get('label', '')}) — through the "
                   "series")
        for n, d in sorted(t["changes"].items(), key=lambda x: int(x[0])):
            out.append(f"- **Book {n}:** {delta_words(t.get('kind'), d)}")
        out.append("")
    return out


def defaults(s: dict) -> dict:
    for k in ("things", "thing_changes", "thing_proposals", "thing_pictures", "thing_picture_waiting"):
        if not isinstance(s.get(k), dict):
            s[k] = {}
    return s

