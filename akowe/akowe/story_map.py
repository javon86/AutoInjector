"""🗺 The story map: a live, editable map of the Book Bible's connections that feeds the writing and the checks.

The author's design (2026-11-08): "it will have a visual aspect to it that will be placed in the book Bible, but it
will be updated as stories getting written like we have the other rules. Like once it's makes that rule, it gets set
in." So the map is DATA, not a drawing:

* **Nodes are the Book Bible's own entries**, referenced by the code-map kind letter and their existing ids — never
  copied: ``C:<A01 record id>`` a character, ``P:<id>`` a place, ``I:<id>`` an item, ``M:<id>`` a magic system (the
  binder's own entity ids, binder.py ``Book``), ``G:<record id>`` a group / belief / world entry, ``W:<rule id>`` a
  protected mystery of the story-rules ledger (a secret), ``S:<hash>`` a plot obligation of the main plot (a clue /
  promise that must pay off) or an unresolved thread of the outline (a subplot). Things the Bible has no entry for
  yet (a secret the chapter reveals, a clue the author adds, a person not in the Bible) are the map's own nodes
  ``X<n>``. A node whose entry was deleted keeps its links: they are shown "about a removed character" (the name
  snapshot on the link), never dropped and never a crash.
* **A link** = ``{id "L<n>", from, to, kind (LINK_KINDS), note, since (chapter number or None = from the start),
  ended, status draft | approved | locked, source ai | user, evidence [{chapter, chapter_id, quote}], history}``.
  Its code ``L12`` is what the checks, the brief and the conflicts name. The map is code ``N00`` of the code map
  (code_map.py: running notes, section 0).

Where the links come from — **no extra AI call**: the per-chapter continuity tracking call (continuity.py
``track_chapter``) already returns the chapter's 📒 story-ledger part (story_ledger.py); its ``links`` field (this
module's ``LINKS_SCHEMA``) lists the connections the chapter shows, and the ledger's own ``knowledge`` and
``relationships`` lines fill in what the AI left out (also for Akọwe's keyword reading when no AI was free).
``from_chapter`` merges them:

* a link the chapter shows ON THE PAGE (``on_page`` and a quote that really is in the chapter text, or a sentence that
  names both ends) becomes 🔒 **locked** — the app's rule for every detail already on the page: "anything already on
  the page is locked; never change it silently"; anything else arrives as a **draft** (dotted on the map);
* a chapter that changes, ends or contradicts an approved or locked link never changes it: it becomes a **conflict**
  (``K<n>``) the author resolves — keep the link, or accept the change with a reason (like the continuity conflicts);
* user-made links are never dropped or overwritten by the AI.

Both ways: the author adds, edits, approves (approve = it is a rule) or deletes links on the 🗺 Story map page
(``route``); a locked link has no silent edit — "change it" needs a reason and is kept in its history. Approved and
locked links reach the chapter writer (``brief``: only the links of the chapter's characters and places, in three
tiers, bounded), the chapter's consistency reviewer (``review_extra``) and the 🧭 checkpoints / 🔎 check-now
(``checkpoint_part``), which are told to name the link's code when a chapter contradicts the map.

Gap warnings (``gaps``, no AI): a subplot with no link activity for ``QUIET`` chapters; a clue / promise never paid
off by the end (or by its planned payoff chapter); a main character with no connections in the last ``QUIET``
chapters; a secret nobody learns; contradictory links (A is B's family and A doesn't know B); orphan entries; links
about removed entries; open conflicts. They show on the map ("only problems") and in 🏠 Book home's ⚠️ Needs a look
(attention.py ``story_map_lines``).

The binder export (binder.py page 6, binder_html.py / binder_docx.py) carries the map as a picture (SVG; a PNG with
numbered markers for Word) and a table of its links. A sequel carries the locked and approved links forward
(``carry_forward``, from series.link_sequel). A book package keeps the map (it is a book setting).

Storage (companion data like the story ledger): settings ``story_map:<project>:<branch>`` = ``{version, links {id:
link}, nodes {id: own node}, conflicts {id: conflict}, positions {node id: [x, y]}, next_link, next_node,
next_conflict, chapters {chapter_id: {number, at, added, locked, conflicts}}}``. Pure logic plus storage; never calls
an AI itself; activity is logged with numbers only (no names, no quotes, no prompts).
"""
from __future__ import annotations

import copy
import hashlib
import json
import logging
import math
import re
import struct
import threading
import types
import zlib
from datetime import datetime, timezone

from .errors import AkoweError

log = logging.getLogger("akowe.story_map")

KEY = "story_map:{pid}:{branch}"
CODE = "N00"                  # the map's code in the code map (code_map.py, running notes section 0)
QUIET = 5                     # chapters without activity before a subplot / main character is called quiet
HISTORY_KEEP = 12
EVIDENCE_KEEP = 5
MAX_LINKS = 600
MAX_OWN_NODES = 200
NOTE_MAX = 160
QUOTE_MAX = 240
NAME_MAX = 80
REASON_MAX = 300
BRIEF_BUDGET = 1400           # characters of JSON for the story-map part of a writing brief
REVIEW_BUDGET = 1600          # … for the chapter's reviewer
CHECK_BUDGET = 1800           # … for a checkpoint part
TRACK_BUDGET = 1500           # … of known links given to the tracker
_LOCK = threading.RLock()

# kind -> (plain label, icon, line colour, directed, plain phrase "A <phrase> B")
LINK_KINDS = {
    "family": ("Family", "👪", "#2e7d32", False, "is family of"),
    "loves": ("Loves", "♥", "#c2185b", True, "loves"),
    "hates": ("Hates", "💢", "#b71c1c", True, "hates"),
    "rivals": ("Rivals", "⚡", "#ef6c00", False, "is a rival of"),
    "ally": ("Friends / allies", "🤝", "#1565c0", False, "is a friend or ally of"),
    "enemy": ("Enemies", "⚔", "#8e0000", False, "is an enemy of"),
    "mentor": ("Mentor of", "🦉", "#6a1b9a", True, "teaches or guides"),
    "works_for": ("Works for", "💼", "#455a64", True, "works for"),
    "strangers": ("Doesn't know", "❔", "#9e9e9e", False, "does not know"),
    "knows_secret": ("Knows the secret", "🤫", "#ad1457", True, "knows the secret of"),
    "owns": ("Owns / carries", "🗝", "#e65100", True, "owns or carries"),
    "lives_at": ("Lives at / is at", "🏠", "#33691e", True, "lives at or is at"),
    "member_of": ("Member of", "🏛", "#00838f", True, "is a member of"),
    "clue_for": ("Clue for", "🔍", "#f9a825", True, "is a clue for"),
    "pays_off": ("Pays off", "🎯", "#558b2f", True, "pays off"),
    "thread": ("Subplot thread", "🧵", "#5d4037", True, "is part of the subplot"),
    "other": ("Other link", "🔗", "#757575", False, "is linked to"),
}
KIND_KEYS = tuple(LINK_KINDS)
# links that cannot both be true of the same pair
CONTRADICT = {frozenset(p) for p in (("family", "strangers"), ("ally", "enemy"), ("mentor", "strangers"),
                                     ("works_for", "strangers"), ("loves", "strangers"), ("knows_secret", "strangers"))}
# node kinds: (plain label, icon, colour)
NODE_KINDS = {
    "character": ("Character", "👤", "#1565c0"), "place": ("Place", "🏙", "#2e7d32"),
    "item": ("Item", "🗝", "#ef6c00"), "magic": ("Magic", "✨", "#6a1b9a"), "group": ("Group", "🏛", "#00838f"),
    "secret": ("Secret", "🤫", "#ad1457"), "clue": ("Clue / promise", "🔍", "#b8860b"),
    "thread": ("Subplot", "🧵", "#5d4037"), "other": ("Other", "🔗", "#757575"),
}
OWN_KINDS = ("secret", "clue", "thread", "character", "place", "item", "group", "other")
STATUSES = ("draft", "approved", "locked")
STATUS_WORDS = {"draft": "Draft — suggested, not yet a rule", "approved": "✔ Approved by you — a rule",
                "locked": "🔒 Locked — it is on the page"}
MAIN_ROLES = ("protagonist", "deuteragonist", "love_interest", "antagonist")
MINOR_ROLES = ("minor", "extra")
# the kind of node each link kind expects at its far end (for resolving the AI's names)
TARGET_KIND = {"knows_secret": "secret", "owns": "item", "lives_at": "place", "member_of": "group",
               "clue_for": None, "pays_off": "clue", "thread": "thread"}
SOURCE_KIND = {"clue_for": "clue"}
# the kind of the map's own node made for a far end the Book Bible has no entry for
OWN_TARGET = {"knows_secret": "secret", "clue_for": "secret", "pays_off": "clue", "thread": "thread", "owns": "item",
              "lives_at": "place", "member_of": "group"}

_S = {"type": "string"}
LINKS_SCHEMA = {"type": "array", "maxItems": 16, "items": {
    "type": "object", "additionalProperties": False,
    "required": ["from", "to", "kind", "note", "change", "on_page", "quote"],
    "properties": {"from": _S, "to": _S, "kind": {"type": "string", "enum": list(KIND_KEYS)}, "note": _S,
                   "change": {"type": "string", "enum": ["new", "same", "changed", "ended"]},
                   "on_page": {"type": "boolean"}, "quote": _S}}}

TASK = (
    " links — the 🗺 story map: every connection this chapter shows between characters, places, items, groups, "
    "secrets, clues and subplots (context.story_map lists the known links with their codes): from and to (exact "
    "names), kind (family, loves, hates, rivals, ally, enemy, mentor, works_for, strangers = they do not know each "
    "other, knows_secret = from knows the secret to, owns, lives_at, member_of, clue_for, pays_off = from pays off "
    "the clue to, thread = from is part of the subplot to, other), note (a few words: \"older brother\", \"the brass "
    "key\"), change (new, same, changed or ended, compared with context.story_map), on_page (true only when the text "
    "states or clearly shows it) and quote (one short sentence copied exactly from the text that shows it).")

RULE = ("Story map (context.writing_brief.story_map): these connections are fixed — 🔒 already on the page, ✔ "
        "approved by the author. Keep every one exactly (who is family, who loves or hates whom, who works for "
        "whom, who knows which secret, who owns what, who lives where, who belongs to which group); never contradict "
        "one. A connection changes only when this chapter's plan asks for it, and then the page must show the change.")

REVIEW_NOTE = ("context.story_map lists the book's approved (✔) and locked (🔒, already on the page) connections of "
               "this chapter's characters and places, each with its code (L12). A chapter that contradicts one is a "
               "real problem: say which link it breaks by its code (for example \"contradicts story-map link L12: "
               "Mara and Tom are siblings\") and keep it in any rewrite.")

CHECK_NOTE = (" context.story_map: the book's approved and locked connections (codes L1, L2…) of the people in these "
              "chapters. A chapter that contradicts one is a consistency problem: name the link's code in the "
              "finding (\"contradicts story-map link L12\").")

GAP_WORDS = {
    "CONFLICT": "a chapter changes a connection that is a rule",
    "THREAD_QUIET": "a subplot has not moved for a while",
    "CLUE_NO_PAYOFF": "a clue or promise is never paid off",
    "MAIN_ALONE": "a main character has no connections lately",
    "SECRET_UNLEARNED": "a secret nobody learns",
    "CONTRADICTION": "two connections that cannot both be true",
    "ORPHAN": "an entry with no connections",
    "REMOVED": "connections about a removed entry",
}


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _clip(v, n: int = NOTE_MAX) -> str:
    return " ".join(str(v or "").split())[:n] if isinstance(v, (str, int, float)) and not isinstance(v, bool) else ""


def _norm(s) -> str:
    s = str(s or "").lower().replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    return " ".join(re.sub(r"[^\w' ]+", " ", s).split())


def _bad(path: str, msg: str, code: str = "INVALID_INPUT") -> AkoweError:
    return AkoweError(code, path, msg, status="REJECTED")


def _int(v):
    return v if isinstance(v, int) and not isinstance(v, bool) else None


# ====================================================================== storage
def _key(pid: str, branch: str) -> str:
    return KEY.format(pid=pid, branch=branch)


def get(store, pid: str, branch: str) -> dict:
    """The stored map (defaults filled in). Never raises."""
    try:
        cur = store.get_setting(_key(pid, branch))
    except Exception:  # noqa: BLE001
        log.exception("could not read the story map")
        cur = None
    cur = copy.deepcopy(cur) if isinstance(cur, dict) else {}
    for k in ("links", "nodes", "conflicts", "positions", "chapters"):
        if not isinstance(cur.get(k), dict):
            cur[k] = {}
    for k in ("next_link", "next_node", "next_conflict", "version"):
        cur[k] = _int(cur.get(k)) or 0
    return cur


def _update(store, pid: str, branch: str, fn, *, base_version=None) -> dict:
    with _LOCK:
        with store.transaction():
            cur = get(store, pid, branch)
            if base_version is not None and base_version != cur["version"]:
                raise _bad("/version", "the story map was changed somewhere else since you opened it: reload the "
                                       "page and try again", "VERSION_CONFLICT")
            fn(cur)
            cur["version"] += 1
            cur["updated_at"] = _now()
            store.set_setting(_key(pid, branch), cur)
    return cur


def _hist(link: dict, what: str, by: str, **extra) -> None:
    h = list(link.get("history") or [])
    h.append(dict({"at": _now(), "by": by, "what": what}, **{k: v for k, v in extra.items() if v not in (None, "")}))
    link["history"] = h[-HISTORY_KEEP:]


def _new_link_id(cur: dict) -> str:
    cur["next_link"] += 1
    while f"L{cur['next_link']}" in cur["links"]:
        cur["next_link"] += 1
    return f"L{cur['next_link']}"


def _new_node_id(cur: dict) -> str:
    cur["next_node"] += 1
    while f"X{cur['next_node']}" in cur["nodes"]:
        cur["next_node"] += 1
    return f"X{cur['next_node']}"


def _new_conflict_id(cur: dict) -> str:
    cur["next_conflict"] += 1
    while f"K{cur['next_conflict']}" in cur["conflicts"]:
        cur["next_conflict"] += 1
    return f"K{cur['next_conflict']}"


# ====================================================================== the nodes: the Book Bible's own entries
def _book(store, pid: str, branch: str, app=None):
    """binder.Book (the binder's own reading of characters, places, items, magic and groups); store-only is enough."""
    from . import binder  # noqa: PLC0415
    shim = app if app is not None else types.SimpleNamespace(store=store, engine=None, principal_id="author")
    return binder.Book(shim, pid, branch)


def _plan_data(store, pid: str, branch: str, module: str) -> dict:
    try:
        heads = [r for r in store.list_records(pid, branch, module_id=module) if r.get("record_kind") == "OUTPUT"
                 and r.get("lifecycle") not in ("REJECTED", "SUPERSEDED")]
        heads.sort(key=lambda r: (bool(r.get("approved_version")), r.get("created_at") or ""))
        if not heads:
            return {}
        h = heads[-1]
        rec = store.get_record(pid, branch, h["record_id"], h.get("approved_version") or h["version"]) or h
        return rec.get("data") if isinstance(rec.get("data"), dict) else {}
    except Exception:  # noqa: BLE001
        log.exception("story map: the plan could not be read")
        return {}


def _hash(t: str) -> str:
    return hashlib.sha1(_norm(t).encode("utf-8")).hexdigest()[:10]


def catalog(store, pid: str, branch: str, app=None) -> dict:
    """{node id: {id, kind, name, aliases, role, protagonist, main, minor, page}} — the Book Bible's entries as map
    nodes (never stored: read fresh every time). Never raises."""
    out: dict = {}
    try:
        b = _book(store, pid, branch, app)
        cast = b.cast
        prot = cast.get("protagonist")
        for c in b.chars:
            role = (cast.get("by_id", {}).get(c["record_id"]) or {}).get("story_role") or "supporting"
            out[f"C:{c['record_id']}"] = {"kind": "character", "name": c["name"], "aliases": [], "role": role,
                                         "protagonist": c["record_id"] == prot, "main": role in MAIN_ROLES or
                                         c["record_id"] == prot, "minor": role in MINOR_ROLES,
                                         "page": f"character-{_slug(c['record_id'])}", "record_id": c["record_id"]}
        for coll, letter, kind, word in (("places", "P", "place", "place"), ("items", "I", "item", "item"),
                                         ("magic", "M", "magic", "magic")):
            for e in getattr(b, coll) or []:
                if e.get("name"):
                    out[f"{letter}:{e['id']}"] = {"kind": kind, "name": e["name"], "aliases": list(e.get("aliases")
                                                                                                    or [])[:6],
                                                  "page": f"{word}-{_slug(e['id'])}"}
        for o in b.others or []:
            if o.get("name"):
                out[f"G:{o['id']}"] = {"kind": "group", "name": o["name"], "aliases": [],
                                       "page": f"world-{_slug(o['id'])}"}
    except Exception:  # noqa: BLE001
        log.exception("story map: the Book Bible entries could not be read")
    try:  # 🤫 the protected mysteries of the story-rules ledger are the book's secrets
        from . import story_rules  # noqa: PLC0415
        for r in story_rules.active(story_rules.get_entry(store, pid, branch)):
            if r.get("category") == "mystery" and r.get("id"):
                out[f"W:{r['id']}"] = {"kind": "secret", "name": _clip(r.get("text"), NAME_MAX), "aliases": [],
                                       "page": "rules"}
    except Exception:  # noqa: BLE001
        log.exception("story map: the protected mysteries could not be read")
    try:  # 🔍 the main plot's obligations (promises / clues to pay off) and 🧵 the outline's open threads (subplots)
        from .ending_check import _text_of  # noqa: PLC0415
        for x in _plan_data(store, pid, branch, "B03").get("plot_obligations") or []:
            t = _clip(_text_of(x), NAME_MAX)
            if t:
                out[f"S:{_hash(t)}"] = {"kind": "clue", "name": t, "aliases": [], "page": "plan", "plan": True}
        for x in _plan_data(store, pid, branch, "B11").get("unresolved_threads") or []:
            t = _clip(_text_of(x), NAME_MAX)
            if t:
                out[f"S:{_hash(t)}"] = {"kind": "thread", "name": t, "aliases": [], "page": "plan", "plan": True}
    except Exception:  # noqa: BLE001
        log.exception("story map: the plan's promises could not be read")
    for nid, n in out.items():
        n["id"] = nid
    return out


def _slug(s) -> str:
    try:
        from .binder import slug  # noqa: PLC0415
        return slug(s)
    except Exception:  # noqa: BLE001
        return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")


def all_nodes(cur: dict, cat: dict) -> dict:
    """Catalog + the map's own nodes + placeholders for link ends that no longer exist (``missing``)."""
    nodes = {k: dict(v) for k, v in cat.items()}
    for nid, n in cur["nodes"].items():
        if isinstance(n, dict) and nid not in nodes:
            nodes[nid] = dict(n, id=nid, own=True)
    for lk in cur["links"].values():
        for end in ("from", "to"):
            nid = lk.get(end)
            if nid and nid not in nodes:
                kind = _kind_of_id(nid, lk.get(f"{end}_kind"))
                nodes[nid] = {"id": nid, "kind": kind, "name": lk.get(f"{end}_name") or "(no name)",
                              "missing": True, "aliases": []}
    return nodes


def _kind_of_id(nid: str, hint=None) -> str:
    if hint in NODE_KINDS:
        return hint
    return {"C": "character", "P": "place", "I": "item", "M": "magic", "G": "group", "W": "secret",
            "S": "clue"}.get(str(nid)[:1], "other")


def resolve(name, nodes: dict, want: str | None = None) -> str | None:
    """The node a name means (the ONE shared name matcher, names.py), preferring the kind ``want``."""
    from . import names  # noqa: PLC0415
    q = _clip(name, NAME_MAX)
    if not q:
        return None
    if q in nodes:
        return q
    pools = []
    if want:
        pools.append([n for n in nodes.values() if n.get("kind") == want])
    pools.append([n for n in nodes.values() if n.get("kind") == "character"])
    pools.append(list(nodes.values()))
    for pool in pools:
        exact = [n["id"] for n in pool if _norm(n.get("name")) == _norm(q) or any(_norm(a) == _norm(q)
                                                                              for a in n.get("aliases") or [])]
        if len(exact) == 1:
            return exact[0]
        if pool and (pool[0].get("kind") in ("character", "place", "item", "group", "magic")):
            hit = names.match(q, [(n["id"], [n.get("name") or ""] + list(n.get("aliases") or [])) for n in pool])
            if hit:
                return hit
    return None


# ====================================================================== cleaning (AI answers and the author's input)
def clean_links(raw) -> list[dict]:
    """The ``links`` part of a story-ledger answer, cleaned: anything unusable dropped, never raises."""
    out = []
    for x in raw if isinstance(raw, list) else []:
        if not isinstance(x, dict):
            continue
        a, b = _clip(x.get("from"), NAME_MAX), _clip(x.get("to"), NAME_MAX)
        if not a or not b or _norm(a) == _norm(b):
            continue
        kind = x.get("kind") if x.get("kind") in LINK_KINDS else _guess_kind(f"{x.get('kind') or ''} "
                                                                             f"{x.get('note') or ''}")
        change = x.get("change") if x.get("change") in ("new", "same", "changed", "ended") else "new"
        out.append({"from": a, "to": b, "kind": kind, "note": _clip(x.get("note")), "change": change,
                    "on_page": x.get("on_page") is True, "quote": _clip(x.get("quote"), QUOTE_MAX)})
    return out[:16]


_GUESS = (("strangers", r"stranger|never met|does ?n[o']t know|did ?n[o']t know each|unknown to"),
          ("family", r"famil|brother|sister|mother|father|parent|sibling|\bson\b|daughter|cousin|aunt|uncle|grand|"
                     r"wife|husband|spouse|twin|niece|nephew"),
          ("hates", r"\bhat(e|es|ed|red)\b|loath|despis"),
          ("loves", r"\blov(e|es|ed|er|ers)\b|romanc|crush|in love|kiss|sweetheart"),
          ("enemy", r"enem|foe|nemesis|betray"), ("rivals", r"rival|compet"),
          ("mentor", r"mentor|teach|student|apprentice|pupil|master of|trains?\b"),
          ("works_for", r"works? for|serves|servant|employ|boss|hired|in the pay of"),
          ("ally", r"all(y|ies)|friend|companion|trust|partner|team"),
          ("knows_secret", r"secret|knows that|learn(s|ed|t)"), ("owns", r"owns|carr(y|ies)|holds|has the|keeps"),
          ("lives_at", r"lives|lodg|stays at|home"), ("member_of", r"member|joins|belongs"))


def _guess_kind(text: str) -> str:
    t = str(text or "").lower()
    for kind, pat in _GUESS:
        if re.search(pat, t):
            return kind
    return "other"


def _directed(kind: str) -> bool:
    return LINK_KINDS.get(kind, LINK_KINDS["other"])[3]


def _same_key(lk: dict, a: str, b: str, kind: str) -> bool:
    if lk.get("kind") != kind:
        return False
    if _directed(kind):
        return lk.get("from") == a and lk.get("to") == b
    return {lk.get("from"), lk.get("to")} == {a, b}


def _pair(lk: dict) -> frozenset:
    return frozenset((lk.get("from"), lk.get("to")))


def _contradicts(k1: str, k2: str) -> bool:
    return frozenset((k1, k2)) in CONTRADICT


# ====================================================================== the page: quotes and evidence
def _sentences(text: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?…])[\"”’]?\s+|\n+", str(text or "")) if s.strip()]


def quote_on_page(quote: str, text: str) -> str | None:
    """The quote as it stands in the chapter (case and spacing forgiven), or None when it is not there."""
    q = _norm(quote)
    if len(q) < 12:
        return None
    t = _norm(text)
    if q in t:
        return _clip(quote, QUOTE_MAX)
    return None


def _first_name(name: str) -> str:
    from . import names  # noqa: PLC0415
    toks = names.tokens(name)
    return toks[0] if toks else _norm(name)


def _mentions(sent: str, name: str) -> bool:
    if not name:
        return False
    s = _norm(sent)
    full = _norm(name)
    if full and re.search(r"\b" + re.escape(full) + r"\b", s):
        return True
    f = _first_name(name)
    return bool(f and len(f) > 2 and re.search(r"\b" + re.escape(f) + r"\b", s))


def sentence_with(text: str, a: str, b: str, extra: str = "") -> str | None:
    """The first sentence of the chapter that names both ends (and, for a secret, some of its words)."""
    words = [w for w in _norm(extra).split() if len(w) > 3][:6]
    for s in _sentences(text):
        if _mentions(s, a) and (_mentions(s, b) or (words and sum(1 for w in words if w in _norm(s)) >= 2)):
            return _clip(s, QUOTE_MAX)
    return None


# ====================================================================== chapters written (store only)
def chapter_info(store, pid: str, branch: str) -> dict:
    """{written: the last chapter number tracked, numbers, planned: chapters in the outline, finished}. Never raises."""
    nums = []
    try:
        from . import story_ledger as sl_mod  # noqa: PLC0415
        nums = sorted({e.get("number") for e in sl_mod.get_all(store, pid, branch)["chapters"].values()
                       if isinstance(e, dict) and _int(e.get("number")) and not e.get("set_aside")})
    except Exception:  # noqa: BLE001
        log.exception("story map: chapters written")
    planned = 0
    try:
        ch = _plan_data(store, pid, branch, "B11").get("chapters")
        planned = len(ch) if isinstance(ch, list) else 0
    except Exception:  # noqa: BLE001
        planned = 0
    written = max(nums) if nums else 0
    return {"written": written, "numbers": nums, "planned": planned,
            "finished": bool(planned and written >= planned)}


# ====================================================================== merging a chapter's links
def _known_for_tracker(cur: dict, nodes: dict) -> list[str]:
    """The known links, compactly, for the tracker (context.story_map): rules first."""
    rows = []
    order = {"locked": 0, "approved": 1, "draft": 2}
    for lid, lk in sorted(cur["links"].items(), key=lambda kv: (order.get(kv[1].get("status"), 3), _num(kv[0]))):
        if not isinstance(lk, dict) or lk.get("ended"):
            continue
        rows.append(line(dict(lk, id=lid), nodes))
        if len(json.dumps(rows, ensure_ascii=False)) > TRACK_BUDGET:
            rows.pop()
            break
    return rows


def tracker_context(store, pid: str, branch: str) -> list[str]:
    try:
        cur = get(store, pid, branch)
        if not cur["links"]:
            return []
        return _known_for_tracker(cur, all_nodes(cur, catalog(store, pid, branch)))
    except Exception:  # noqa: BLE001
        log.exception("story map: tracker context")
        return []


def _num(lid) -> int:
    m = re.search(r"\d+", str(lid or ""))
    return int(m.group(0)) if m else 0


def _ensure_own(cur: dict, nodes: dict, name: str, kind: str, by: str) -> str | None:
    """An own node for something the Bible has no entry for yet (a secret, a clue, a subplot, a new name)."""
    hit = next((n["id"] for n in nodes.values() if n.get("own") and n.get("kind") == kind
                and _norm(n.get("name")) == _norm(name)), None)
    if hit:
        return hit
    if len(cur["nodes"]) >= MAX_OWN_NODES:
        return None
    nid = _new_node_id(cur)
    node = {"kind": kind, "name": _clip(name, NAME_MAX), "note": "", "made_by": by, "at": _now()}
    if kind == "character":
        node["not_in_bible"] = True
    cur["nodes"][nid] = node
    nodes[nid] = dict(node, id=nid, own=True, aliases=[])
    return nid


def _incoming(story: dict, text: str) -> list[dict]:
    """The chapter's links: the AI's ``links``, then the ledger's who-knows-what and relationship lines (only for pairs
    the AI did not cover)."""
    out = list(clean_links(story.get("links")))
    seen = {frozenset((_norm(x["from"]), _norm(x["to"]))) for x in out}
    for k in story.get("knowledge") or []:
        if not isinstance(k, dict) or not k.get("who") or not k.get("what"):
            continue
        if frozenset((_norm(k["who"]), _norm(k["what"]))) in seen:
            continue
        out.append({"from": _clip(k["who"], NAME_MAX), "to": _clip(k["what"], NAME_MAX), "kind": "knows_secret",
                    "note": "", "change": "new", "on_page": None, "quote": "", "derived": True, "secret": k["what"]})
    for r in story.get("relationships") or []:
        if not isinstance(r, dict) or not r.get("a") or not r.get("b"):
            continue
        if frozenset((_norm(r["a"]), _norm(r["b"]))) in seen:
            continue
        out.append({"from": _clip(r["a"], NAME_MAX), "to": _clip(r["b"], NAME_MAX),
                    "kind": _guess_kind(r.get("line")), "note": _clip(r.get("line")), "change": "new",
                    "on_page": None, "quote": "", "derived": True})
    return out


def from_chapter(store, pid: str, branch: str, chapter: dict, story: dict, *, weak: bool = False,
                 app=None) -> dict:
    """Merge the connections a written chapter shows into the map (see the module docstring). ``chapter`` = {chapter_id,
    number, text}; ``story`` = the chapter's cleaned story-ledger part. Returns {added, locked, updated, conflicts:
    [conflict], skipped}. Never raises."""
    res = {"added": 0, "locked": 0, "updated": 0, "conflicts": [], "skipped": 0}
    try:
        text = str(chapter.get("text") or "")
        num = _int(chapter.get("number"))
        cid = chapter.get("chapter_id")
        incoming = _incoming(story if isinstance(story, dict) else {}, text)
        if not incoming:
            return res
        cat = catalog(store, pid, branch, app)

        def fn(cur):
            nodes = all_nodes(cur, cat)
            for x in incoming:
                _merge_one(cur, nodes, x, text, num, cid, weak, res)
            if cid:
                cur["chapters"][cid] = {"number": num, "at": _now(), "added": res["added"], "locked": res["locked"],
                                        "conflicts": len(res["conflicts"]), "weak": bool(weak)}
        _update(store, pid, branch, fn)
        log.info("story map: chapter %s gave %d new link(s), %d locked, %d conflict(s)", num, res["added"],
                 res["locked"], len(res["conflicts"]))
    except Exception:  # noqa: BLE001 - the map is help, never a reason to fail the tracking
        log.exception("story map: could not merge the links of chapter %s", chapter.get("chapter_id"))
    return res


def _merge_one(cur: dict, nodes: dict, x: dict, text: str, num, cid, weak: bool, res: dict) -> None:
    kind = x["kind"]
    want_from = SOURCE_KIND.get(kind) or "character"
    want_to = TARGET_KIND.get(kind) if kind in TARGET_KIND else "character"
    a = resolve(x["from"], nodes, want_from)
    b = resolve(x["to"], nodes, want_to)
    if a is None:
        a = _ensure_own(cur, nodes, x["from"], want_from, "ai")
    if b is None:
        b = _ensure_own(cur, nodes, x["to"], OWN_TARGET.get(kind, "character"), "ai")
    if not a or not b or a == b:
        res["skipped"] += 1
        return
    # on the page? a real quote, or (for a line of the ledger) a sentence that names both ends
    quote = quote_on_page(x.get("quote") or "", text) if x.get("on_page") is not False else None
    if not quote and (x.get("derived") or x.get("on_page")):
        quote = sentence_with(text, nodes[a].get("name") or x["from"], nodes[b].get("name") or x["to"],
                              x.get("secret") or "")
    on_page = bool(quote) and not weak and x.get("on_page") is not False
    ev = {"chapter": num, "chapter_id": cid, "quote": quote or ""}
    same = next((lk for lk in cur["links"].values() if _same_key(lk, a, b, kind) and not lk.get("ended")), None)
    if same is not None:
        rule = same.get("status") in ("approved", "locked") or same.get("source") == "user"
        if x["change"] == "ended" or (x["change"] == "changed" and x.get("note")
                                      and _norm(x["note"]) != _norm(same.get("note"))):
            if rule:
                _conflict(cur, same, x, num, cid, quote, res)
            else:
                if x["change"] == "ended":
                    same["ended"] = num
                    _hist(same, f"ended in chapter {num}", "ai")
                else:
                    _hist(same, f"note changed in chapter {num}", "ai", before=same.get("note"))
                    same["note"] = x["note"]
                _add_ev(same, ev)
                res["updated"] += 1
            return
        _add_ev(same, ev)
        if on_page and same.get("status") != "locked":
            same["status"] = "locked"
            _hist(same, f"🔒 locked: it is on the page in chapter {num}", "ai")
            res["locked"] += 1
        if not same.get("note") and x.get("note"):
            same["note"] = x["note"]
        res["updated"] += 1
        return
    if x["change"] == "ended":
        res["skipped"] += 1  # an end of a link the map does not have: nothing to end
        return
    clash = next((lk for lk in cur["links"].values() if _pair(lk) == frozenset((a, b)) and not lk.get("ended")
                  and _contradicts(lk.get("kind"), kind)), None)
    if clash is not None and (clash.get("status") in ("approved", "locked") or clash.get("source") == "user"):
        _conflict(cur, clash, x, num, cid, quote, res, new_link={"from": a, "to": b, "kind": kind})
        return
    if len(cur["links"]) >= MAX_LINKS:
        res["skipped"] += 1
        return
    lid = _new_link_id(cur)
    lk = {"from": a, "to": b, "kind": kind, "note": x.get("note") or "", "since": num, "since_chapter_id": cid,
          "ended": None, "status": "locked" if on_page else "draft", "source": "ai", "evidence": [],
          "from_name": nodes[a].get("name"), "to_name": nodes[b].get("name"), "from_kind": nodes[a].get("kind"),
          "to_kind": nodes[b].get("kind"), "history": [], "created_at": _now()}
    _add_ev(lk, ev)
    _hist(lk, (f"🔒 found on the page in chapter {num}" if on_page else
               f"suggested from chapter {num}" + (" (quick reading: no AI was free)" if weak else "")), "ai")
    cur["links"][lid] = lk
    res["added"] += 1
    if on_page:
        res["locked"] += 1


def _add_ev(lk: dict, ev: dict) -> None:
    evs = [e for e in lk.get("evidence") or [] if isinstance(e, dict)]
    if not any(e.get("chapter_id") == ev.get("chapter_id") and e.get("quote") == ev.get("quote") for e in evs):
        evs.append(ev)
    lk["evidence"] = evs[-EVIDENCE_KEEP:]


def _conflict(cur: dict, link: dict, x: dict, num, cid, quote, res: dict, new_link: dict | None = None) -> None:
    lid = next((k for k, v in cur["links"].items() if v is link), None)
    if lid is None:
        return
    for c in cur["conflicts"].values():  # the same change from the same chapter is one conflict
        if c.get("link") == lid and c.get("chapter_id") == cid and c.get("status") == "open":
            return
    kid = _new_conflict_id(cur)
    c = {"link": lid, "chapter": num, "chapter_id": cid, "status": "open", "at": _now(),
         "proposed": {"kind": x["kind"], "note": x.get("note") or "", "change": x["change"], "quote": quote or "",
                      **({"new_link": new_link} if new_link else {})}}
    cur["conflicts"][kid] = c
    link["conflict"] = kid
    _hist(link, f"⚠️ chapter {num} seems to change it (conflict {kid}): waiting for you", "ai")
    res["conflicts"].append(dict(c, id=kid))


# ====================================================================== the author's edits
def _need_node(cur: dict, cat: dict, nid) -> str:
    nodes = all_nodes(cur, cat)
    if not isinstance(nid, str) or nid not in nodes:
        raise _bad("/from", "that entry is not in this book's map")
    return nid


def _clean_kind(v) -> str:
    if v not in LINK_KINDS:
        raise _bad("/kind", "kind: one of " + ", ".join(KIND_KEYS))
    return v


def _clean_since(v):
    if v in (None, ""):
        return None
    if not isinstance(v, int) or isinstance(v, bool) or not 0 < v < 10000:
        raise _bad("/since", "since: a chapter number (1, 2, 3…) or empty for “from the start”")
    return v


def add_link(store, pid: str, branch: str, body: dict, *, by: str = "author", app=None) -> dict:
    cat = catalog(store, pid, branch, app)
    out = {}

    def fn(cur):
        a = _need_node(cur, cat, body.get("from"))
        b = _need_node(cur, cat, body.get("to"))
        if a == b:
            raise _bad("/to", "a connection needs two different entries")
        kind = _clean_kind(body.get("kind"))
        if any(_same_key(lk, a, b, kind) and not lk.get("ended") for lk in cur["links"].values()):
            raise _bad("/kind", "this connection is on the map already: open it to edit it")
        if len(cur["links"]) >= MAX_LINKS:
            raise _bad("/links", f"the map is full ({MAX_LINKS} connections)")
        nodes = all_nodes(cur, cat)
        status = "draft" if body.get("status") == "draft" else "approved"
        lid = _new_link_id(cur)
        lk = {"from": a, "to": b, "kind": kind, "note": _clip(body.get("note")), "since": _clean_since(body.get("since")),
              "since_chapter_id": None, "ended": None, "status": status, "source": "user", "evidence": [],
              "from_name": nodes[a].get("name"), "to_name": nodes[b].get("name"), "from_kind": nodes[a].get("kind"),
              "to_kind": nodes[b].get("kind"), "history": [], "created_at": _now()}
        _hist(lk, "added by you" + (" (approved: it is a rule)" if status == "approved" else " as a draft"), by)
        cur["links"][lid] = lk
        out["id"] = lid
    cur = _update(store, pid, branch, fn, base_version=_int(body.get("version")))
    return dict(cur["links"][out["id"]], id=out["id"])


def _link_of(cur: dict, lid) -> dict:
    lk = cur["links"].get(lid) if isinstance(lid, str) else None
    if not isinstance(lk, dict):
        raise _bad("/link", "that connection is not on the map (it may have been deleted)", "NOT_FOUND")
    return lk


def edit_link(store, pid: str, branch: str, lid: str, body: dict, *, by: str = "author") -> dict:
    """Edit a draft or approved link. A 🔒 locked link has no silent edit: use ``change_locked`` with a reason."""
    def fn(cur):
        lk = _link_of(cur, lid)
        if lk.get("status") == "locked":
            raise _bad("/status", "this connection is 🔒 locked: it is already on the page. Use “Change it” and say "
                                  "why, so the change is never silent", "APPROVAL_REQUIRED")
        _apply_edit(lk, body, by, "edited by you")
    cur = _update(store, pid, branch, fn, base_version=_int(body.get("version")))
    return dict(cur["links"][lid], id=lid)


def _apply_edit(lk: dict, body: dict, by: str, what: str, reason: str | None = None) -> None:
    before = {k: lk.get(k) for k in ("kind", "note", "since")}
    if "kind" in body:
        lk["kind"] = _clean_kind(body["kind"])
    if "note" in body:
        lk["note"] = _clip(body.get("note"))
    if "since" in body:
        lk["since"] = _clean_since(body.get("since"))
    if "ended" in body:
        lk["ended"] = _clean_since(body.get("ended"))
    changed = {k: v for k, v in before.items() if v != lk.get(k)}
    _hist(lk, what, by, before=", ".join(f"{k}: {v}" for k, v in changed.items() if v not in (None, "")) or None,
          reason=reason)


def approve_link(store, pid: str, branch: str, lid: str, body: dict, *, by: str = "author") -> dict:
    if body.get("author_confirms") is not True:
        raise _bad("/author_confirms", "approving makes this connection a rule the writer must keep: confirm it "
                                       "(author_confirms: true)", "APPROVAL_REQUIRED")

    def fn(cur):
        lk = _link_of(cur, lid)
        if lk.get("status") == "draft":
            lk["status"] = "approved"
            _hist(lk, "✔ approved by you: it is a rule now", by)
    cur = _update(store, pid, branch, fn, base_version=_int(body.get("version")))
    return dict(cur["links"][lid], id=lid)


def _reason(body: dict) -> str:
    r = _clip(body.get("reason"), REASON_MAX)
    if len(r) < 3:
        raise _bad("/reason", "say in a few words why (it is kept with the connection's history)")
    return r


def change_locked(store, pid: str, branch: str, lid: str, body: dict, *, by: str = "author") -> dict:
    """“Change it”: the author changes a 🔒 locked link on purpose, with a reason (kept in its history)."""
    if body.get("author_confirms") is not True:
        raise _bad("/author_confirms", "changing a locked connection needs your confirmation (author_confirms: "
                                       "true)", "APPROVAL_REQUIRED")
    reason = _reason(body)

    def fn(cur):
        lk = _link_of(cur, lid)
        _apply_edit(lk, body, by, "changed by you", reason)
    cur = _update(store, pid, branch, fn, base_version=_int(body.get("version")))
    return dict(cur["links"][lid], id=lid)


def delete_link(store, pid: str, branch: str, lid: str, body: dict, *, by: str = "author") -> dict:
    def fn(cur):
        lk = _link_of(cur, lid)
        if lk.get("status") == "locked":
            if body.get("author_confirms") is not True:
                raise _bad("/author_confirms", "this connection is 🔒 on the page: deleting it needs your "
                                               "confirmation and a reason", "APPROVAL_REQUIRED")
            _reason(body)
        cur["links"].pop(lid, None)
        for c in cur["conflicts"].values():
            if c.get("link") == lid and c.get("status") == "open":
                c.update(status="closed", closed_why="the connection was deleted", at=_now())
        cur.setdefault("deleted", []).append({"id": lid, "kind": lk.get("kind"), "at": _now(), "by": by,
                                              "reason": _clip(body.get("reason"), REASON_MAX) or None})
        cur["deleted"] = cur["deleted"][-50:]
    _update(store, pid, branch, fn, base_version=_int(body.get("version")))
    return {"ok": True, "deleted": lid}


def resolve_conflict(store, pid: str, branch: str, kid: str, body: dict, *, by: str = "author") -> dict:
    """Keep the link as it is, or accept the chapter's change — always with a reason."""
    choice = body.get("choice")
    if choice not in ("keep", "accept"):
        raise _bad("/choice", "choice: keep (the connection stays as it is) or accept (take the chapter's change)")
    if body.get("author_confirms") is not True:
        raise _bad("/author_confirms", "deciding a conflict needs your confirmation (author_confirms: true)",
                   "APPROVAL_REQUIRED")
    reason = _reason(body)
    out = {}

    def fn(cur):
        c = cur["conflicts"].get(kid) if isinstance(kid, str) else None
        if not isinstance(c, dict):
            raise _bad("/conflict", "that conflict does not exist", "NOT_FOUND")
        if c.get("status") != "open":
            raise _bad("/conflict", "this conflict was decided already", "VERSION_CONFLICT")
        lk = cur["links"].get(c.get("link"))
        c.update(status="kept" if choice == "keep" else "accepted", reason=reason, decided_by=by, decided_at=_now())
        if lk is None:
            return
        lk.pop("conflict", None)
        p = c.get("proposed") or {}
        if choice == "keep":
            _hist(lk, f"kept as it is (chapter {c.get('chapter')} did not change it)", by, reason=reason)
            return
        if p.get("new_link"):
            lk["ended"] = c.get("chapter")
            _hist(lk, f"ended in chapter {c.get('chapter')}: the chapter's new connection was accepted", by,
                  reason=reason)
            nl = p["new_link"]
            lid = _new_link_id(cur)
            new = {"from": nl["from"], "to": nl["to"], "kind": nl["kind"], "note": p.get("note") or "",
                   "since": c.get("chapter"), "since_chapter_id": c.get("chapter_id"), "ended": None,
                   "status": "locked" if p.get("quote") else "approved", "source": "ai",
                   "evidence": [{"chapter": c.get("chapter"), "chapter_id": c.get("chapter_id"),
                                 "quote": p.get("quote") or ""}],
                   "from_name": lk.get("from_name") if nl["from"] == lk.get("from") else lk.get("to_name"),
                   "to_name": lk.get("to_name") if nl["to"] == lk.get("to") else lk.get("from_name"),
                   "history": [], "created_at": _now()}
            _hist(new, f"accepted by you from chapter {c.get('chapter')} (conflict {kid})", by, reason=reason)
            cur["links"][lid] = new
            out["new"] = lid
        elif p.get("change") == "ended":
            lk["ended"] = c.get("chapter")
            _hist(lk, f"ended in chapter {c.get('chapter')} (accepted by you)", by, reason=reason)
        else:
            _apply_edit(lk, {"note": p.get("note") or lk.get("note")}, by,
                        f"changed by chapter {c.get('chapter')} (accepted by you)", reason)
        if p.get("quote"):
            _add_ev(lk, {"chapter": c.get("chapter"), "chapter_id": c.get("chapter_id"), "quote": p["quote"]})
    cur = _update(store, pid, branch, fn, base_version=_int(body.get("version")))
    return {"ok": True, "conflict": dict(cur["conflicts"][kid], id=kid), "new_link": out.get("new")}


def add_node(store, pid: str, branch: str, body: dict, *, by: str = "author") -> dict:
    kind = body.get("kind")
    if kind not in OWN_KINDS:
        raise _bad("/kind", "kind: secret, clue, thread (a subplot), character, place, item, group or other")
    name = _clip(body.get("name"), NAME_MAX)
    if not name:
        raise _bad("/name", "give it a name")
    out = {}

    def fn(cur):
        if len(cur["nodes"]) >= MAX_OWN_NODES:
            raise _bad("/nodes", f"the map has {MAX_OWN_NODES} entries of its own already")
        nid = _new_node_id(cur)
        cur["nodes"][nid] = {"kind": kind, "name": name, "note": _clip(body.get("note")),
                             "payoff_chapter": _clean_since(body.get("payoff_chapter")), "made_by": by, "at": _now()}
        out["id"] = nid
    cur = _update(store, pid, branch, fn, base_version=_int(body.get("version")))
    return dict(cur["nodes"][out["id"]], id=out["id"])


def edit_node(store, pid: str, branch: str, nid: str, body: dict, *, by: str = "author") -> dict:
    """The map's own entries are edited freely; for the Book Bible's own entries only the planned payoff chapter (a
    clue) is kept here (``meta``) — the entry itself is edited on its Book Bible page."""
    def fn(cur):
        n = cur["nodes"].get(nid)
        if isinstance(n, dict):
            if "name" in body and _clip(body.get("name"), NAME_MAX):
                n["name"] = _clip(body["name"], NAME_MAX)
            if "note" in body:
                n["note"] = _clip(body.get("note"))
            if "payoff_chapter" in body:
                n["payoff_chapter"] = _clean_since(body.get("payoff_chapter"))
            if body.get("paid_off") in (True, False):
                n["paid_off"] = body["paid_off"]
            return
        meta = cur.setdefault("meta", {}).setdefault(nid, {})
        if "payoff_chapter" in body:
            meta["payoff_chapter"] = _clean_since(body.get("payoff_chapter"))
        if body.get("paid_off") in (True, False):
            meta["paid_off"] = body["paid_off"]
    cur = _update(store, pid, branch, fn, base_version=_int(body.get("version")))
    return dict(cur["nodes"].get(nid) or cur.get("meta", {}).get(nid) or {}, id=nid)


def delete_node(store, pid: str, branch: str, nid: str, body: dict, *, by: str = "author") -> dict:
    """Only the map's own entries can be deleted here; their links stay (shown as about a removed entry) unless the
    author deletes them too."""
    def fn(cur):
        n = cur["nodes"].get(nid)
        if not isinstance(n, dict):
            raise _bad("/node", "only the story map's own entries can be deleted here (a Book Bible entry is "
                                "deleted on its own page)", "NOT_FOUND")
        for lk in cur["links"].values():
            for end in ("from", "to"):
                if lk.get(end) == nid:
                    lk[f"{end}_name"] = n.get("name")
                    lk[f"{end}_kind"] = n.get("kind")
        cur["nodes"].pop(nid, None)
        cur["positions"].pop(nid, None)
    _update(store, pid, branch, fn, base_version=_int(body.get("version")))
    return {"ok": True, "deleted": nid}


def save_positions(store, pid: str, branch: str, body: dict) -> dict:
    pos = body.get("positions")
    if not isinstance(pos, dict) or len(pos) > 2000:
        raise _bad("/positions", "positions: {node id: [x, y]}")
    clean = {}
    for k, v in pos.items():
        if isinstance(k, str) and len(k) < 200 and isinstance(v, list) and len(v) == 2 and \
                all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in v):
            clean[k] = [round(max(-5000.0, min(5000.0, float(v[0]))), 1), round(max(-5000.0, min(5000.0,
                                                                                               float(v[1]))), 1)]

    def fn(cur):
        if body.get("reset") is True:
            cur["positions"] = {}
        cur["positions"].update(clean)
    cur = _update(store, pid, branch, fn)
    return {"ok": True, "saved": len(clean), "version": cur["version"]}


# ====================================================================== gap warnings (no AI)
def _active_at(lk: dict, n: int | None) -> bool:
    if n is None:
        return not lk.get("ended")
    since = _int(lk.get("since"))
    ended = _int(lk.get("ended"))
    return (since is None or since <= n) and (ended is None or ended > n)


def _activity(lk: dict) -> list[int]:
    out = [x for x in [_int(lk.get("since")), _int(lk.get("ended"))] if x]
    out += [e["chapter"] for e in lk.get("evidence") or [] if isinstance(e, dict) and _int(e.get("chapter"))]
    return out


def gaps(cur: dict, nodes: dict, info: dict) -> list[dict]:
    """The map's gap warnings: [{code, severity (warn | info), message, nodes, links, chapter}]. No AI."""
    out: list[dict] = []
    written = info.get("written") or 0
    finished = bool(info.get("finished"))
    links = {k: v for k, v in cur["links"].items() if isinstance(v, dict)}
    meta = cur.get("meta") or {}

    def nm(nid):
        return (nodes.get(nid) or {}).get("name") or "(no name)"

    def add(code, sev, msg, ns=(), ls=(), chapter=None):
        out.append({"code": code, "severity": sev, "message": msg, "nodes": list(ns), "links": list(ls),
                    "chapter": chapter, "about": GAP_WORDS[code]})
    for kid, c in cur["conflicts"].items():
        if c.get("status") == "open":
            lk = links.get(c.get("link")) or {}
            add("CONFLICT", "warn", f"Chapter {c.get('chapter')} seems to change story-map link {c.get('link')} "
                                    f"({nm(lk.get('from'))} — {nm(lk.get('to'))}: "
                                    f"{LINK_KINDS.get(lk.get('kind'), LINK_KINDS['other'])[0].lower()}). Keep it, or "
                                    "accept the change with a reason.", [lk.get("from"), lk.get("to")],
                [c.get("link")], c.get("chapter"))
    by_node: dict = {}
    for lid, lk in links.items():
        for end in ("from", "to"):
            by_node.setdefault(lk.get(end), []).append(lid)
    for nid, n in nodes.items():
        kind = n.get("kind")
        mine = [links[x] for x in by_node.get(nid, [])]
        act = sorted({c for lk in mine for c in _activity(lk)})
        last = act[-1] if act else None
        if n.get("missing"):
            add("REMOVED", "warn", f"{len(mine)} connection(s) are about “{n.get('name')}”, which is no longer in the "
                                   "Book Bible. Delete them, or link them to the right entry.", [nid],
                by_node.get(nid, []))
            continue
        if kind == "thread" and written >= QUIET:
            if not mine:
                add("THREAD_QUIET", "warn", f"The subplot “{n.get('name')}” has no connections yet after {written} "
                                            "chapter(s).", [nid])
            elif last is not None and written - last >= QUIET:
                add("THREAD_QUIET", "warn", f"The subplot “{n.get('name')}” has not moved for {written - last} "
                                            f"chapters (last in chapter {last}).", [nid], by_node.get(nid, []), last)
        if kind == "clue":
            planted = [lk for lk in mine if lk.get("kind") == "clue_for" and lk.get("from") == nid]
            paid = any(lk.get("kind") == "pays_off" and lk.get("to") == nid for lk in mine) or \
                n.get("paid_off") or (meta.get(nid) or {}).get("paid_off")
            due = _int(n.get("payoff_chapter")) or _int((meta.get(nid) or {}).get("payoff_chapter"))
            if not paid and (planted or n.get("plan")) and ((due and written >= due) or finished):
                when = f"by chapter {due}, as planned" if due and written >= due else "by the end of the book"
                add("CLUE_NO_PAYOFF", "warn", f"The clue or promise “{n.get('name')}” is never paid off {when}.",
                    [nid], [x for x in by_node.get(nid, [])])
        if kind == "secret" and (finished or written >= QUIET):
            if not any(lk.get("kind") == "knows_secret" and lk.get("to") == nid for lk in mine):
                add("SECRET_UNLEARNED", "warn" if finished else "info",
                    f"Nobody learns the secret “{n.get('name')}”" + (" by the end of the book." if finished else
                                                                     f" in the first {written} chapters."), [nid])
        if kind == "character" and n.get("main") and written >= QUIET:
            recent = [c for c in act if c > written - QUIET]
            if not recent:
                add("MAIN_ALONE", "warn", f"{n.get('name')}{' ★' if n.get('protagonist') else ''} has no new "
                                          f"connections in the last {QUIET} chapters" +
                    (f" (last in chapter {last})." if last else "."), [nid])
        if not mine and kind in ("character", "place", "item", "group", "magic") and not n.get("minor") \
                and (written >= 1 or links):
            add("ORPHAN", "info", f"“{n.get('name')}” ({NODE_KINDS[kind][0].lower()}) has no connections on the map.",
                [nid])
    seen = set()
    act_links = [(lid, lk) for lid, lk in links.items() if not lk.get("ended")]
    for i, (l1, a) in enumerate(act_links):
        for l2, b in act_links[i + 1:]:
            if _pair(a) == _pair(b) and _contradicts(a.get("kind"), b.get("kind")):
                key = frozenset((l1, l2))
                if key in seen:
                    continue
                seen.add(key)
                add("CONTRADICTION", "warn", f"{nm(a.get('from'))} and {nm(a.get('to'))}: "
                                             f"“{LINK_KINDS[a['kind']][0]}” ({l1}) and “{LINK_KINDS[b['kind']][0]}” "
                                             f"({l2}) cannot both be true. Delete or change one.",
                    [a.get("from"), a.get("to")], [l1, l2])
    sev = {"warn": 0, "info": 1}
    out.sort(key=lambda g: (sev.get(g["severity"], 2), list(GAP_WORDS).index(g["code"])))
    return out


# ====================================================================== lines for the writer and the checks
def line(lk: dict, nodes: dict) -> str:
    def nm(end):
        n = nodes.get(lk.get(end)) or {}
        name = n.get("name") or lk.get(f"{end}_name") or "(no name)"
        return name + (" (removed from the Book Bible)" if n.get("missing") else "")
    lab = LINK_KINDS.get(lk.get("kind"), LINK_KINDS["other"])
    mark = {"locked": "🔒", "approved": "✔", "draft": "draft"}.get(lk.get("status"), "")
    note = f" ({lk['note']})" if lk.get("note") else ""
    since = f", since chapter {lk['since']}" if _int(lk.get("since")) else ""
    return f"{lk.get('id') or ''} {mark} {nm('from')} {lab[4]} {nm('to')}{note}{since}".strip()


def _rule_links(cur: dict, before: int | None) -> list[dict]:
    out = []
    for lid, lk in cur["links"].items():
        if not isinstance(lk, dict) or lk.get("status") not in ("approved", "locked"):
            continue
        since, ended = _int(lk.get("since")), _int(lk.get("ended"))
        if before is not None and since is not None and since > before:
            continue  # it starts later in the book
        if lk.get("ended") and (before is None or ended is None or ended <= before):
            continue  # it is over by then
        out.append(dict(lk, id=lid))
    return out


def _present_ids(nodes: dict, present_names) -> set:
    ids = set()
    for name in present_names or []:
        nid = resolve(name, nodes)
        if nid:
            ids.add(nid)
    return ids


def relevant(store, pid: str, branch: str, present_names, number: int | None, budget: int,
             cut: list | None = None, texts=()) -> list[str]:
    """The rule links (approved / locked) about the people and places named, in three tiers — 1. both ends here,
    2. one end here and 🔒 on the page, 3. one end here and ✔ approved — bounded by ``budget``; what did not fit is
    said in ``cut`` (H13)."""
    cur = get(store, pid, branch)
    if not cur["links"]:
        return []
    nodes = all_nodes(cur, catalog(store, pid, branch))
    here = _present_ids(nodes, present_names)
    blob = "\n".join(t for t in texts or () if isinstance(t, str))
    if blob:  # places, items and groups the chapter's plan names
        here |= {nid for nid, n in nodes.items() if n.get("kind") in ("place", "item", "group", "magic")
                 and n.get("name") and _mentions(blob, n["name"])}
    if not here:
        return []
    tiers: list[list[str]] = [[], [], []]
    for lk in sorted(_rule_links(cur, number), key=lambda x: _num(x["id"])):
        ends = {lk.get("from"), lk.get("to")}
        if not ends & here:
            continue
        t = 0 if ends <= here else 1 if lk.get("status") == "locked" else 2
        tiers[t].append(line(lk, nodes))
    rows: list[str] = []
    left: list[str] = []
    for t in tiers:
        for r in t:
            if len(json.dumps(rows + [r], ensure_ascii=False)) <= budget:
                rows.append(r)
            else:
                left.append(r)
    if left and cut is not None:
        from . import brief_cuts  # noqa: PLC0415
        brief_cuts.note(cut, "story map — connections of the characters in this chapter", left)
    return rows


def brief(store, pid: str, branch: str, present_names, number: int | None, cut: list | None = None,
          texts=()) -> list[str]:
    """The story-map part of one chapter's writing brief (chapter_brief.py): the links of the characters present and
    of the places / items / groups its plan (``texts``) names. Never raises."""
    try:
        return relevant(store, pid, branch, present_names, number, BRIEF_BUDGET, cut, texts)
    except Exception:  # noqa: BLE001 - guidance, never a reason to fail a chapter
        log.exception("story map: brief")
        return []


def _chapter_of_record(store, pid: str, branch: str, rec: dict) -> tuple[str | None, int | None]:
    meta = store.get_state(pid, branch, "c_meta", rec["record_id"]) or {}
    cid = meta.get("chapter_id") or meta.get("unit_id") or (rec.get("data") or {}).get("chapter_id")
    ch = _plan_data(store, pid, branch, "B11").get("chapters") or []
    ids = [c.get("chapter_id") for c in ch if isinstance(c, dict)]
    return cid, (ids.index(cid) + 1 if cid in ids else None)


def review_extra(store, pid: str, branch: str, rec: dict) -> dict:
    """For the consistency reviewer of a chapter (review.py ``_context``): the rule links of the people it names."""
    try:
        if rec.get("module_id") != "C02":
            return {}
        cur = get(store, pid, branch)
        if not cur["links"]:
            return {}
        text = str((rec.get("data") or {}).get("text") or "")
        nodes = all_nodes(cur, catalog(store, pid, branch))
        names = [n["name"] for n in nodes.values() if n.get("kind") in ("character", "place", "item", "group")
                 and n.get("name") and _mentions(text, n["name"])]
        _cid, num = _chapter_of_record(store, pid, branch, rec)
        rows = relevant(store, pid, branch, names, num, REVIEW_BUDGET)
        return {"story_map": rows, "story_map_note": REVIEW_NOTE} if rows else {}
    except Exception:  # noqa: BLE001 - context is best effort
        log.exception("story map: review context")
        return {}


def checkpoint_part(store, pid: str, branch: str, texts: list[str], upto: int | None) -> list[str]:
    """For a 🧭 checkpoint / 🔎 check-now part: the rule links of the people these chapters name."""
    try:
        cur = get(store, pid, branch)
        if not cur["links"]:
            return []
        nodes = all_nodes(cur, catalog(store, pid, branch))
        blob = "\n".join(t for t in texts if t)
        names = [n["name"] for n in nodes.values() if n.get("kind") in ("character", "place", "item", "group")
                 and n.get("name") and _mentions(blob, n["name"])]
        return relevant(store, pid, branch, names, (upto + 1) if upto else None, CHECK_BUDGET)
    except Exception:  # noqa: BLE001
        log.exception("story map: checkpoint context")
        return []


def flags(store, pid: str, branch: str, chapter_id: str, number: int | None, text: str) -> list[dict]:
    """Akọwe's own quick check of one chapter against the map (no AI): two people a 🔒 / ✔ link says know each
    other (family, friends, lovers, mentor…) meeting "for the first time" in a later chapter. Flags carry the link's
    code. Never raises."""
    out = []
    try:
        cur = get(store, pid, branch)
        if not cur["links"]:
            return []
        nodes = all_nodes(cur, catalog(store, pid, branch))
        first = re.compile(r"\b(for the first time|never (?:met|seen) (?:him|her|them) before|had never met|a "
                           r"stranger to (?:him|her|them)|introduced (?:himself|herself|themselves))\b", re.I)
        sents = [s for s in _sentences(text) if first.search(s)]
        if not sents:
            return []
        for lk in _rule_links(cur, number):
            if lk.get("kind") not in ("family", "loves", "ally", "mentor", "works_for", "rivals", "enemy"):
                continue
            if _int(lk.get("since")) and number and lk["since"] >= number:
                continue
            a, b = (nodes.get(lk.get("from")) or {}).get("name"), (nodes.get(lk.get("to")) or {}).get("name")
            for s in sents:
                if a and b and _mentions(s, a) and _mentions(s, b):
                    out.append({"chapter_id": chapter_id, "number": number, "code": "STORY_MAP", "link": lk["id"],
                                "severity": "major", "quote": _clip(s, QUOTE_MAX),
                                "message": f"Chapter {number}: {a} and {b} meet as strangers, but story-map link "
                                           f"{lk['id']} says {a} {LINK_KINDS[lk['kind']][4]} {b} "
                                           f"({STATUS_WORDS[lk['status']].split(' — ')[0]})."})
                    break
    except Exception:  # noqa: BLE001
        log.exception("story map: quick check")
    return out


# ====================================================================== the page (GET) and 🏠 Book home
def view(store, pid: str, branch: str, app=None) -> dict:
    cur = get(store, pid, branch)
    cat = catalog(store, pid, branch, app)
    nodes = all_nodes(cur, cat)
    info = chapter_info(store, pid, branch)
    warn = gaps(cur, nodes, info)
    meta = cur.get("meta") or {}
    node_list = []
    for nid, n in nodes.items():
        node_list.append({"id": nid, "kind": n.get("kind"), "name": n.get("name") or "(no name)",
                          "role": n.get("role"), "protagonist": bool(n.get("protagonist")), "main": bool(n.get("main")),
                          "minor": bool(n.get("minor")), "own": bool(n.get("own")), "missing": bool(n.get("missing")),
                          "not_in_bible": bool(n.get("not_in_bible")), "page": n.get("page"),
                          "note": n.get("note") or "", "plan": bool(n.get("plan")),
                          "payoff_chapter": _int(n.get("payoff_chapter")) or _int((meta.get(nid) or {}).get(
                              "payoff_chapter")),
                          "paid_off": bool(n.get("paid_off") or (meta.get(nid) or {}).get("paid_off")),
                          "pos": cur["positions"].get(nid)})
    links = []
    for lid, lk in sorted(cur["links"].items(), key=lambda kv: _num(kv[0])):
        if not isinstance(lk, dict):
            continue
        links.append(dict({k: lk.get(k) for k in ("from", "to", "kind", "note", "since", "ended", "status", "source",
                                                  "evidence", "history", "conflict", "created_at")},
                          id=lid, line=line(dict(lk, id=lid), nodes),
                          about_removed=bool((nodes.get(lk.get("from")) or {}).get("missing")
                                             or (nodes.get(lk.get("to")) or {}).get("missing"))))
    return {"code": CODE, "version": cur["version"], "nodes": node_list, "links": links,
            "conflicts": [dict(c, id=k) for k, c in sorted(cur["conflicts"].items(), key=lambda kv: _num(kv[0]))
                          if isinstance(c, dict)],
            "gaps": warn, "chapters": info, "quiet": QUIET,
            "kinds": {k: {"label": v[0], "icon": v[1], "colour": v[2], "directed": v[3], "phrase": v[4]}
                      for k, v in LINK_KINDS.items()},
            "node_kinds": {k: {"label": v[0], "icon": v[1], "colour": v[2]} for k, v in NODE_KINDS.items()},
            "own_kinds": list(OWN_KINDS), "statuses": STATUS_WORDS,
            "counts": {"links": len(links), "locked": sum(1 for x in links if x["status"] == "locked"),
                       "approved": sum(1 for x in links if x["status"] == "approved"),
                       "draft": sum(1 for x in links if x["status"] == "draft"),
                       "conflicts": sum(1 for c in cur["conflicts"].values() if c.get("status") == "open"),
                       "warnings": sum(1 for g in warn if g["severity"] == "warn")}}


def attention_lines(store, pid: str, branch: str, limit: int = 5) -> list[str]:
    """🏠 Book home's ⚠️ Needs a look: open conflicts first, then the map's warnings (never the info ones)."""
    try:
        cur = get(store, pid, branch)
        if not cur["links"] and not cur["conflicts"]:
            return []
        nodes = all_nodes(cur, catalog(store, pid, branch))
        warn = [g for g in gaps(cur, nodes, chapter_info(store, pid, branch)) if g["severity"] == "warn"]
        out = [f"🗺 Story map: {g['message']}" for g in warn[:limit]]
        if len(warn) > limit:
            out.append(f"🗺 Story map: …and {len(warn) - limit} more (open 📖 Book Bible → 🗺 Story map).")
        return out
    except Exception:  # noqa: BLE001
        log.exception("story map: attention")
        return []


# ====================================================================== the picture (binder export)
def layout(nodes: list[dict], links: list[dict], w: float = 1000.0, h: float = 640.0) -> dict:
    """{node id: (x, y)}: the author's dragged positions where kept (stored in a 1000 × 640 space), else a radial
    layout — the ★ main character in the centre, its links on the first ring, the rest further out."""
    pos = {}
    for n in nodes:
        p = n.get("pos")
        if isinstance(p, list) and len(p) == 2:
            pos[n["id"]] = (float(p[0]), float(p[1]))
    centre = next((n["id"] for n in nodes if n.get("protagonist")), None)
    adj: dict = {}
    for lk in links:
        adj.setdefault(lk["from"], set()).add(lk["to"])
        adj.setdefault(lk["to"], set()).add(lk["from"])
    ring = {centre: 0} if centre else {}
    frontier = list(ring)
    while frontier:
        nxt = []
        for x in frontier:
            for y in adj.get(x, ()):
                if y not in ring:
                    ring[y] = ring[x] + 1
                    nxt.append(y)
        frontier = nxt
    far = max(ring.values(), default=0) + 1
    rings: dict = {}
    for n in nodes:
        rings.setdefault(ring.get(n["id"], far), []).append(n["id"])
    cx, cy = w / 2, h / 2
    max_r = min(w, h) / 2 - 40
    nr = max(rings) if rings else 1
    for r, ids in sorted(rings.items()):
        rad = 0 if r == 0 else max_r * r / max(1, nr)
        for i, nid in enumerate(ids):
            if nid in pos:
                continue
            a = 2 * math.pi * i / max(1, len(ids)) - math.pi / 2 + r * 0.4
            pos[nid] = (cx + rad * math.cos(a) * (w / h if r else 1) * 0.9, cy + rad * math.sin(a))
    return pos


def _esc(s) -> str:
    from html import escape  # noqa: PLC0415
    return escape(str(s or ""))


def svg(v: dict, *, w: int = 1000, h: int = 640, max_labels: int = 60) -> str:
    """The map as one self-contained SVG (binder_html.py): nodes coloured by kind, ★ for the main character, solid
    lines for approved / 🔒 locked links, dotted for drafts, red for a link in conflict."""
    nodes = [n for n in v.get("nodes") or [] if any(n["id"] in (lk["from"], lk["to"]) for lk in v.get("links") or [])
             or n.get("kind") == "character"]
    links = [lk for lk in v.get("links") or [] if not lk.get("ended")]
    pos = layout(nodes, links, w, h)
    nk = v.get("node_kinds") or {k: {"colour": c[2]} for k, c in NODE_KINDS.items()}
    kk = v.get("kinds") or {k: {"colour": c[2]} for k, c in LINK_KINDS.items()}
    out = [f'<svg class="story-map" viewBox="0 0 {w} {h}" xmlns="http://www.w3.org/2000/svg" role="img" '
           f'aria-label="Story map: {len(nodes)} entries, {len(links)} connections">']
    for lk in links:
        a, b = pos.get(lk["from"]), pos.get(lk["to"])
        if not a or not b:
            continue
        col = "#d32f2f" if lk.get("conflict") else (kk.get(lk["kind"]) or {}).get("colour", "#888")
        dash = ' stroke-dasharray="6 5"' if lk.get("status") == "draft" else ""
        out.append(f'<line x1="{a[0]:.0f}" y1="{a[1]:.0f}" x2="{b[0]:.0f}" y2="{b[1]:.0f}" stroke="{col}" '
                   f'stroke-width="{3 if lk.get("conflict") else 2}"{dash}/>')
        if lk.get("status") == "locked":
            mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
            out.append(f'<text x="{mx:.0f}" y="{my + 4:.0f}" text-anchor="middle" font-size="12">🔒</text>')
    by_deg = sorted(nodes, key=lambda n: -sum(1 for lk in links if n["id"] in (lk["from"], lk["to"])))
    labelled = {n["id"] for n in by_deg[:max_labels]} | {n["id"] for n in nodes if n.get("protagonist")}
    for n in nodes:
        x, y = pos[n["id"]]
        col = "#9e9e9e" if n.get("missing") else (nk.get(n.get("kind")) or {}).get("colour", "#757575")
        r = 18 if n.get("protagonist") else 12
        out.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{r}" fill="{col}" stroke="#fff" stroke-width="2"/>')
        if n.get("protagonist"):
            out.append(f'<text x="{x:.0f}" y="{y + 5:.0f}" text-anchor="middle" font-size="16" fill="#fff">★</text>')
        if n["id"] in labelled:
            name = (n.get("name") or "")[:28]
            out.append(f'<text x="{x:.0f}" y="{y + r + 14:.0f}" text-anchor="middle" font-size="12" '
                       f'fill="currentColor">{_esc(name)}</text>')
    out.append("</svg>")
    return "".join(out)


def table_rows(v: dict) -> list[dict]:
    names = {n["id"]: n["name"] for n in v.get("nodes") or []}
    out = []
    for lk in v.get("links") or []:
        ev = next((e for e in reversed(lk.get("evidence") or []) if e.get("quote")), None)
        out.append({"code": lk["id"], "from": names.get(lk["from"], "(removed)"), "to": names.get(lk["to"], "(removed)"),
                    "kind": (v.get("kinds") or {}).get(lk["kind"], {}).get("label") or lk["kind"],
                    "note": lk.get("note") or "", "since": lk.get("since"), "ended": lk.get("ended"),
                    "status": {"locked": "🔒 Locked", "approved": "✔ Approved", "draft": "Draft"}.get(lk["status"],
                                                                                                  lk["status"])
                    + (" · ⚠️ conflict" if lk.get("conflict") else ""),
                    "evidence": (f"Ch {ev.get('chapter')}: “{ev['quote']}”" if ev else "")})
    return out


def binder_part(book) -> dict | None:
    """The map for the binder's Relationship map page (binder.py): {svg, rows, warnings, counts, png_markers}. None
    when the map has no links yet."""
    try:
        v = view(book.store, book.pid, book.branch, getattr(book, "app", None))
        if not v["links"]:
            return None
        return {"svg": svg(v), "rows": table_rows(v), "counts": v["counts"],
                "warnings": [g["message"] for g in v["gaps"] if g["severity"] == "warn"][:12],
                "view": {"nodes": v["nodes"], "links": v["links"], "kinds": v["kinds"], "node_kinds": v["node_kinds"]}}
    except Exception:  # noqa: BLE001
        log.exception("story map: binder part")
        return None


# a 3 × 5 digit font for the numbered markers of the PNG (Word has no SVG)
_DIGITS = {"0": "111101101101111", "1": "010110010010111", "2": "111001111100111", "3": "111001111001111",
           "4": "101101111001001", "5": "111100111001111", "6": "111100111101111", "7": "111001001001001",
           "8": "111101111101111", "9": "111101111001111"}


def _hex(c: str) -> tuple[int, int, int]:
    c = c.lstrip("#")
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)


def png(v: dict, *, w: int = 900, h: int = 576) -> tuple[bytes, list[dict]]:
    """(PNG bytes, key rows [{n, name, kind}]) — the map drawn with numbered markers (pure Python, no font): the key
    under the picture names each number. Used by the Word binder."""
    nodes = [n for n in v.get("nodes") or [] if any(n["id"] in (lk["from"], lk["to"]) for lk in v.get("links") or [])]
    links = [lk for lk in v.get("links") or [] if not lk.get("ended")]
    pos = {k: (x * w / 1000.0, y * h / 640.0) for k, (x, y) in layout(nodes, links).items()}
    px = bytearray(b"\xff" * (w * h * 3))

    def dot(x, y, col):
        if 0 <= x < w and 0 <= y < h:
            i = (y * w + x) * 3
            px[i:i + 3] = bytes(col)

    def seg(a, b, col, dashed=False, width=2):
        (x0, y0), (x1, y1) = a, b
        n = int(max(abs(x1 - x0), abs(y1 - y0))) or 1
        for s in range(n + 1):
            if dashed and (s // 6) % 2:
                continue
            x, y = x0 + (x1 - x0) * s / n, y0 + (y1 - y0) * s / n
            for dx in range(-width // 2, width - width // 2):
                for dy in range(-width // 2, width - width // 2):
                    dot(int(x) + dx, int(y) + dy, col)

    def disc(cx, cy, r, col):
        for y in range(int(cy - r), int(cy + r) + 1):
            for x in range(int(cx - r), int(cx + r) + 1):
                if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                    dot(x, y, col)

    def number(cx, cy, s, col, scale=2):
        wd = len(s) * 4 * scale - scale
        x0, y0 = int(cx - wd / 2), int(cy - 5 * scale / 2)
        for k, ch in enumerate(s):
            bits = _DIGITS.get(ch)
            if not bits:
                continue
            for r in range(5):
                for c in range(3):
                    if bits[r * 3 + c] == "1":
                        for sx in range(scale):
                            for sy in range(scale):
                                dot(x0 + k * 4 * scale + c * scale + sx, y0 + r * scale + sy, col)
    for lk in links:
        a, b = pos.get(lk["from"]), pos.get(lk["to"])
        if a and b:
            col = _hex("#d32f2f") if lk.get("conflict") else _hex(LINK_KINDS.get(lk["kind"], LINK_KINDS["other"])[2])
            seg(a, b, col, dashed=lk.get("status") == "draft", width=3 if lk.get("conflict") else 2)
    key = []
    for i, n in enumerate(nodes):
        x, y = pos[n["id"]]
        col = _hex("#9e9e9e") if n.get("missing") else _hex(NODE_KINDS.get(n.get("kind"), NODE_KINDS["other"])[2])
        r = 16 if n.get("protagonist") else 13
        disc(x, y, r + 2, (255, 255, 255))
        disc(x, y, r, col)
        number(x, y, str(i + 1), (255, 255, 255))
        key.append({"n": i + 1, "name": ("★ " if n.get("protagonist") else "") + (n.get("name") or ""),
                    "kind": NODE_KINDS.get(n.get("kind"), NODE_KINDS["other"])[0]})
    raw = b"".join(b"\x00" + bytes(px[y * w * 3:(y + 1) * w * 3]) for y in range(h))

    def chunk(t, data):
        c = struct.pack(">I", len(data)) + t + data
        return c + struct.pack(">I", zlib.crc32(t + data) & 0xFFFFFFFF)
    data = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))
    return data, key


# ====================================================================== 📚 a sequel carries the rules forward
def carry_forward(store, old_pid: str, old_branch: str, new_pid: str, new_branch: str, rid_map: dict | None = None,
                  *, book_number: int | None = None) -> int:
    """Copy the 🔒 locked and ✔ approved links of the book before into its sequel (like the other series facts).
    Record ids are translated with ``rid_map`` (old -> new, the sequel's seeded canon); anything else is matched by
    name in the sequel's Book Bible, else kept as the map's own entry. Returns how many links were carried. Never
    raises."""
    try:
        old = get(store, old_pid, old_branch)
        rules = {lid: lk for lid, lk in old["links"].items() if isinstance(lk, dict)
                 and lk.get("status") in ("locked", "approved") and not lk.get("ended")}
        if not rules:
            return 0
        old_nodes = all_nodes(old, catalog(store, old_pid, old_branch))
        cat = catalog(store, new_pid, new_branch)
        rid_map = {str(k): str(v) for k, v in (rid_map or {}).items()}
        n_done = {"n": 0}

        def fn(cur):
            nodes = all_nodes(cur, cat)
            if cur.get("carried_from") == old_pid:
                return  # carried already (a resumed run)

            def map_id(nid):
                new = nid
                for o, nw in rid_map.items():
                    if o in new:
                        new = new.replace(o, nw)
                if new in nodes:
                    return new
                n = old_nodes.get(nid) or {}
                hit = resolve(n.get("name") or "", nodes, n.get("kind"))
                if hit:
                    return hit
                return _ensure_own(cur, nodes, n.get("name") or "(no name)", n.get("kind") if n.get("kind") in
                                   OWN_KINDS else "other", "series")
            for lid, lk in rules.items():
                a, b = map_id(lk["from"]), map_id(lk["to"])
                if not a or not b or a == b or any(_same_key(x, a, b, lk["kind"]) for x in cur["links"].values()):
                    continue
                nid = _new_link_id(cur)
                new = {"from": a, "to": b, "kind": lk["kind"], "note": lk.get("note") or "", "since": None,
                       "since_chapter_id": None, "ended": None, "status": lk["status"], "source": lk.get("source"),
                       "evidence": [dict(e, book=book_number) for e in (lk.get("evidence") or [])[-2:]],
                       "from_name": nodes[a].get("name"), "to_name": nodes[b].get("name"),
                       "from_kind": nodes[a].get("kind"), "to_kind": nodes[b].get("kind"), "history": [],
                       "carried": {"from_book": book_number, "link": lid}, "created_at": _now()}
                _hist(new, f"📚 carried over from book {book_number or 'before'} ({lid})", "series")
                cur["links"][nid] = new
                n_done["n"] += 1
            cur["carried_from"] = old_pid
        _update(store, new_pid, new_branch, fn)
        return n_done["n"]
    except Exception:  # noqa: BLE001
        log.exception("story map: carrying the links into the sequel")
        return 0


# ====================================================================== HTTP (server.py delegates …/storymap)
def route(app, method: str, rest: list, query: dict, body, principal: str, pid: str, branch: str):
    store = app.store
    body = body if isinstance(body, dict) else {}

    def changed(out):
        try:
            app.review._changed()  # noqa: SLF001 - the book's save state / pages refresh
        except Exception:  # noqa: BLE001
            pass
        return out
    if rest == [] and method == "GET":
        return 200, view(store, pid, branch, app)
    if rest == ["svg"] and method == "GET":
        return 200, ("__binary__", "image/svg+xml", svg(view(store, pid, branch, app)).encode("utf-8"),
                     "story-map.svg")
    if rest == ["links"] and method == "POST":
        lk = add_link(store, pid, branch, body, by=principal, app=app)
        return changed((201, {"ok": True, "link": lk, "message": f"Added {lk['id']}."}))
    if len(rest) == 2 and rest[0] == "links" and method == "PUT":
        return changed((200, {"ok": True, "link": edit_link(store, pid, branch, rest[1], body, by=principal),
                              "message": "Saved."}))
    if len(rest) == 3 and rest[0] == "links":
        lid, act = rest[1], rest[2]
        if act == "approve" and method == "POST":
            return changed((200, {"ok": True, "link": approve_link(store, pid, branch, lid, body, by=principal),
                                  "message": "✔ Approved: the writer keeps this connection from now on."}))
        if act == "change" and method == "POST":
            return changed((200, {"ok": True, "link": change_locked(store, pid, branch, lid, body, by=principal),
                                  "message": "Changed. The reason is kept with the connection."}))
        if act == "delete" and method == "POST":
            return changed((200, dict(delete_link(store, pid, branch, lid, body, by=principal),
                                      message="Deleted.")))
    if len(rest) == 3 and rest[0] == "conflicts" and rest[2] == "resolve" and method == "POST":
        out = resolve_conflict(store, pid, branch, rest[1], body, by=principal)
        return changed((200, dict(out, message="Kept as it is." if body.get("choice") == "keep" else
                                  "The chapter's change is accepted.")))
    if rest == ["nodes"] and method == "POST":
        return changed((201, {"ok": True, "node": add_node(store, pid, branch, body, by=principal)}))
    if len(rest) == 2 and rest[0] == "nodes" and method == "PUT":
        return changed((200, {"ok": True, "node": edit_node(store, pid, branch, rest[1], body, by=principal)}))
    if len(rest) == 3 and rest[0] == "nodes" and rest[2] == "delete" and method == "POST":
        return changed((200, delete_node(store, pid, branch, rest[1], body, by=principal)))
    if rest == ["positions"] and method == "PUT":
        return 200, save_positions(store, pid, branch, body)
    raise AkoweError("NOT_FOUND", "/" + "/".join(rest), "no such story-map page", status="REJECTED")
