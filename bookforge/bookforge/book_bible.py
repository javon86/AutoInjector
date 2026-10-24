"""📖 The book bible (P20 / P21): everything needed to make a book again, in one versioned JSON document.

``build(app, pid, branch)`` collects, read-only, from the book:

* the book profile (title, author, genre, audience, tone, idea, length, chapters) with the ending and style choices
  (P12), the pipeline switches (P14) and the length targets (P15);
* the canon of Set A: every character (A01 data + the character sheet and voice card, P7/P17), the places (A04), the
  world (A03) and any other Set A entry (systems, beliefs, organisations…) — the approved version when there is one,
  else the newest draft (``approved: false``); the protected facts are listed separately too;
* the plan: premise (B01), main plot (B03) and chapter outline (B11) — their OUTPUT data;
* the scene cards of the current outline (P8), the story-rules ledger (P9) and the world-texture list (P10).

``render_markdown`` is the same content for people. ``clean(raw)`` checks a bible read from a file (hand-edited, from
another computer): it refuses a newer ``schema_version`` (``OPEN_NEWER_VERSION``) and anything that is not a book
bible (``BIBLE_BAD``), and cleans every part with the cleaners the book itself uses — nothing in it is trusted.

The bible never holds keys, tokens, prompts or AI replies other than the book's own content (the canon, the plan and
the companion lists are the book). Record references are kept as they are (a rerun maps them by record ID).
"""
from __future__ import annotations

import copy
import json
import logging

from . import __version__
from . import characters as chars_mod
from . import lengths as lengths_mod
from . import pipeline as pipeline_mod
from . import scenes as scenes_mod
from . import story_choices
from . import story_rules
from . import texture as texture_mod
from .book_path import BookPath, clean_profile, get_profile
from .canonical import iter_references

log = logging.getLogger("bookforge.book_bible")

SCHEMA_VERSION = 1
KIND = "bookforge-book-bible"
MAX_BYTES = 8 * 1024 * 1024        # a bible file larger than this is refused (a real one is far smaller)
MAX_CANON = 200
PLAN_OPS = {"B01": "premise", "B03": "main_plot", "B11": "outline"}
PLAN_LABELS = {"premise": "Premise", "main_plot": "Main plot", "outline": "Chapter outline"}
PROFILE_KEYS = ("title", "author", "genre", "audience", "tone", "idea", "length", "chapters")


class BibleProblem(Exception):
    """A bible that cannot be used: ``code`` is a problems.js code (OPEN_NEWER_VERSION, BIBLE_BAD)."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _now() -> str:
    from .jobs import now_iso  # noqa: PLC0415
    return now_iso()


def _entry_name(rec: dict) -> str:
    try:
        return chars_mod._name_and_subject(rec)[0]  # noqa: SLF001 - the one place that knows how canon is named
    except Exception:  # noqa: BLE001
        return rec.get("record_id") or "?"


def _current(store, pid, branch, head: dict) -> dict:
    """The approved revision when there is one (not out of date), else the newest one."""
    if head.get("approved_version"):
        a = store.get_record(pid, branch, head["record_id"], head["approved_version"])
        if a:
            return a
    return head


# ====================================================================== build (from a book in this BookForge)
def build(app, pid: str, branch: str = "main") -> dict:
    store = app.store
    prof = get_profile(store, pid)
    proj = store.project(pid)
    profile = {k: prof.get(k) for k in PROFILE_KEYS if prof.get(k) not in (None, "")}
    choices = story_choices.clean(prof.get("choices")) if isinstance(prof.get("choices"), dict) else {}
    pinfo = pipeline_mod.info_of(store, pid)
    pipe = {"preset": pinfo.get("preset"), "flags": dict(pinfo.get("flags") or {})} if pinfo else None
    try:
        length = lengths_mod.of_book(store, pid)
    except Exception:  # noqa: BLE001 - a hint
        length = None
    sheets = chars_mod.all_entries(store, pid, branch)
    characters, canon, protected = [], [], []
    heads = [r for r in store.list_records(pid, branch) if r["module_id"].startswith("A")
             and r.get("record_kind") == "OUTPUT" and r["lifecycle"] not in ("REJECTED",)]
    heads.sort(key=lambda r: (r.get("created_at") or "", r["record_id"]))
    for h in heads[:MAX_CANON]:
        if h.get("stale") and not h.get("approved_version"):
            continue  # set aside (e.g. refused and redone): not part of the book
        rec = _current(store, pid, branch, h)
        if rec["lifecycle"] in ("REJECTED", "SUPERSEDED") and not h.get("approved_version"):
            continue
        name = _entry_name(rec)
        item = {"record_id": h["record_id"], "module_id": h["module_id"], "name": name,
                "approved": bool(h.get("approved_version")) and rec["version"] == h.get("approved_version"),
                "version": rec["version"], "data": copy.deepcopy(rec.get("data") or {})}
        flags = [f for f in (item["data"].get("protected_fact_flags") or []) if isinstance(f, str)]
        if flags:
            protected.append({"record_id": h["record_id"], "name": name, "module_id": h["module_id"], "flags": flags})
        if h["module_id"] == "A01":
            e = sheets.get(h["record_id"]) or {}
            item["sheet"] = copy.deepcopy(e.get("sheet")) if e.get("sheet") else None
            item["voice"] = copy.deepcopy(e.get("voice")) if e.get("voice") else None
            characters.append(item)
        else:
            try:
                item["kind"] = app.engine.contracts.operation(h["module_id"])["name"]
            except Exception:  # noqa: BLE001
                item["kind"] = h["module_id"]
            canon.append(item)
    bp = BookPath(app.engine, app.principal_id, pid, branch)
    plan = {}
    for op, key in PLAN_OPS.items():
        appr = bp.approved(op)
        rec = appr[0] if appr else None
        if rec is None:
            drafts = sorted(bp.drafts(op), key=lambda r: r.get("created_at") or "", reverse=True)
            rec = drafts[0] if drafts else None
        if rec is not None:
            plan[key] = {"record_id": rec["record_id"], "version": rec["version"], "approved": bool(appr),
                         "data": copy.deepcopy(rec.get("data") or {})}
    scene_cards = []
    outline = bp.outline()
    if outline:
        entries = scenes_mod.all_entries(store, pid, branch)
        for ch in bp.outline_chapters(outline):
            e = entries.get(scenes_mod.ekey(outline["record_id"], ch["chapter_id"]))
            if e and scenes_mod.usable(e, outline):
                scene_cards.append({"chapter_id": ch["chapter_id"], "cards": copy.deepcopy(e.get("cards") or []),
                                    "status": e.get("status")})
    rules = story_rules.get_entry(store, pid, branch) or {}
    tex = texture_mod.get_entry(store, pid, branch) or {}
    return {
        "schema_version": SCHEMA_VERSION, "kind": KIND, "app": "BookForge", "app_version": __version__,
        "saved_at": _now(),
        "source": {"project_id": pid, "branch_id": branch, "name": proj["name"] if proj else None},
        "profile": profile, "choices": choices, "pipeline": pipe,
        "length": {k: length.get(k) for k in ("length", "label", "book_words", "chapters", "target_words")
                   if k in (length or {})} if isinstance(length, dict) else None,
        "characters": characters, "canon": canon, "protected_facts": protected, "plan": plan,
        "scene_cards": scene_cards, "story_rules": copy.deepcopy(rules.get("rules") or []),
        "world_texture": copy.deepcopy(tex.get("items") or []),
    }


# ====================================================================== read one from a file (P21)
def _canon_item(raw, idx: int, *, character: bool) -> dict:
    if not isinstance(raw, dict):
        raise BibleProblem("BIBLE_BAD", f"entry {idx + 1} of the {'characters' if character else 'canon'} is not "
                                        "an object")
    op = raw.get("module_id") or ("A01" if character else None)
    if not isinstance(op, str) or len(op) != 3 or not op.startswith("A") or not op[1:].isdigit():
        raise BibleProblem("BIBLE_BAD", f"entry {idx + 1}: module_id must be a Set A step like A04")
    if character and op != "A01":
        raise BibleProblem("BIBLE_BAD", f"character {idx + 1} must be an A01 entry")
    data = raw.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("concept"), (str, type(None))):
        raise BibleProblem("BIBLE_BAD", f"entry {idx + 1} has no data (its concept, attributes and facts)")
    rid = raw.get("record_id")
    out = {"record_id": rid if isinstance(rid, str) and 0 < len(rid) <= 120 else f"bible-{op}-{idx + 1}",
           "module_id": op, "name": str(raw.get("name") or data.get("concept") or f"Entry {idx + 1}")[:120],
           "approved": bool(raw.get("approved", True)), "data": copy.deepcopy(data)}
    if character:
        out["sheet"] = chars_mod.clean_sheet(raw["sheet"]) if isinstance(raw.get("sheet"), dict) else None
        out["voice"] = chars_mod.clean_voice(raw["voice"]) if isinstance(raw.get("voice"), dict) else None
    else:
        out["kind"] = str(raw.get("kind") or op)[:80]
    return out


def clean(raw) -> dict:
    """A bible read from a file, checked and cleaned (raises BibleProblem)."""
    if isinstance(raw, (bytes, bytearray)):
        if len(raw) > MAX_BYTES:
            raise BibleProblem("BIBLE_BAD", "this book bible is too large (more than 8 MB)")
        try:
            raw = json.loads(bytes(raw).decode("utf-8-sig"))
        except (UnicodeDecodeError, ValueError, RecursionError):
            raise BibleProblem("BIBLE_BAD", "this file is not readable JSON (was it changed in a word processor?)") \
                from None
    if not isinstance(raw, dict) or raw.get("kind") != KIND:
        raise BibleProblem("BIBLE_BAD", "this is not a BookForge book bible (book-bible.json)")
    sv = raw.get("schema_version")
    if not isinstance(sv, int) or isinstance(sv, bool) or sv < 1:
        raise BibleProblem("BIBLE_BAD", "the book bible has no valid schema_version")
    if sv > SCHEMA_VERSION:
        raise BibleProblem("OPEN_NEWER_VERSION", f"this book bible was saved by a newer BookForge (format "
                                                 f"{sv}; this BookForge reads format {SCHEMA_VERSION} and older)")
    prof_raw = raw.get("profile") if isinstance(raw.get("profile"), dict) else {}
    try:
        profile = clean_profile({k: prof_raw.get(k) for k in PROFILE_KEYS if prof_raw.get(k) not in (None, "")})
    except Exception as exc:  # noqa: BLE001 - BookforgeError: a field out of range
        raise BibleProblem("BIBLE_BAD", f"the book profile in the bible is not usable: {exc}") from None
    if not profile.get("title"):
        raise BibleProblem("BIBLE_BAD", "the book bible has no title (profile.title)")
    try:
        choices = story_choices.clean(raw.get("choices") or {})
    except Exception:  # noqa: BLE001
        choices = {}
    pipe = None
    if isinstance(raw.get("pipeline"), dict):
        try:
            pipe = pipeline_mod.clean({"flags": raw["pipeline"].get("flags") or {}})
        except Exception:  # noqa: BLE001
            pipe = None
    chars_raw = raw.get("characters") if isinstance(raw.get("characters"), list) else []
    canon_raw = raw.get("canon") if isinstance(raw.get("canon"), list) else []
    if len(chars_raw) + len(canon_raw) > MAX_CANON:
        raise BibleProblem("BIBLE_BAD", f"the book bible has more than {MAX_CANON} characters and places")
    characters = [_canon_item(c, i, character=True) for i, c in enumerate(chars_raw)]
    canon = [_canon_item(c, i, character=False) for i, c in enumerate(canon_raw)]
    plan = {}
    for key in PLAN_OPS.values():
        p = (raw.get("plan") or {}).get(key) if isinstance(raw.get("plan"), dict) else None
        if isinstance(p, dict) and isinstance(p.get("data"), dict):
            plan[key] = {"record_id": str(p.get("record_id") or key)[:120], "approved": bool(p.get("approved", True)),
                         "data": copy.deepcopy(p["data"])}
    scene_cards = []
    for s in raw.get("scene_cards") or []:
        if isinstance(s, dict) and isinstance(s.get("chapter_id"), str):
            cards = scenes_mod.clean_cards(s.get("cards"))
            if cards:
                scene_cards.append({"chapter_id": s["chapter_id"][:80], "cards": cards})
    rules = story_rules.clean_rules(raw.get("story_rules") or [])
    tex = texture_mod.clean_items(raw.get("world_texture") or [])
    return {"schema_version": SCHEMA_VERSION, "kind": KIND, "app_version": str(raw.get("app_version") or "")[:20],
            "saved_at": str(raw.get("saved_at") or "")[:40],
            "source": {k: str(v)[:200] for k, v in (raw.get("source") or {}).items()
                       if k in ("project_id", "branch_id", "name") and isinstance(v, str)}
            if isinstance(raw.get("source"), dict) else {},
            "profile": profile, "choices": choices, "pipeline": pipe, "length": None,
            "characters": characters, "canon": canon, "protected_facts": [], "plan": plan,
            "scene_cards": scene_cards, "story_rules": rules, "world_texture": tex}


def summary(b: dict) -> dict:
    """Numbers and names only (the rerun dialog and the folder list)."""
    prof = b.get("profile") or {}
    outline = ((b.get("plan") or {}).get("outline") or {}).get("data") or {}
    return {"title": prof.get("title") or "", "author": prof.get("author") or "", "genre": prof.get("genre") or "",
            "length": prof.get("length") or "", "characters": [c.get("name") for c in b.get("characters") or []][:20],
            "places": sum(1 for c in b.get("canon") or [] if c.get("module_id") == "A04"),
            "canon": len(b.get("canon") or []), "sheets": sum(1 for c in b.get("characters") or [] if c.get("sheet")),
            "plan": [k for k in ("premise", "main_plot", "outline") if k in (b.get("plan") or {})],
            "chapters": len(outline.get("chapters") or []),
            "scene_cards": len(b.get("scene_cards") or []), "story_rules": len(b.get("story_rules") or []),
            "world_texture": len(b.get("world_texture") or []), "saved_at": b.get("saved_at")}


def remap_refs(data, refs_by_rid: dict):
    """A copy of ``data`` whose References point at the new book's records (by the old record ID); a reference to
    something the new book does not have is dropped from lists (and set to None elsewhere)."""
    data = copy.deepcopy(data)
    paths = list(iter_references(data))
    for path, ref in reversed(paths):  # reversed: list deletions keep the earlier indexes valid
        new = refs_by_rid.get(ref.get("record_id"))
        parent = data
        for p in path[:-1]:
            parent = parent[p]
        if new is not None:
            parent[path[-1]] = copy.deepcopy(new)
        elif isinstance(parent, list):
            del parent[path[-1]]
        else:
            parent[path[-1]] = None
    return data


# ====================================================================== for people
def _md_value(v, indent: str = "") -> list[str]:
    out = []
    if isinstance(v, dict):
        for k, x in v.items():
            if isinstance(x, (dict, list)):
                if x:
                    out.append(f"{indent}- **{str(k).replace('_', ' ')}:**")
                    out += _md_value(x, indent + "  ")
            elif x not in (None, ""):
                out.append(f"{indent}- **{str(k).replace('_', ' ')}:** {x}")
    elif isinstance(v, list):
        for x in v:
            if isinstance(x, (dict, list)):
                out.append(f"{indent}-")
                out += _md_value(x, indent + "  ")
            elif x not in (None, ""):
                out.append(f"{indent}- {x}")
    elif v not in (None, ""):
        out.append(f"{indent}{v}")
    return out


def _facts(data: dict) -> list[str]:
    out = []
    for f in data.get("facts") or []:
        if isinstance(f, dict) and f.get("predicate") and f.get("value") not in (None, "", []):
            out.append(f"  - {f.get('predicate')}: {f.get('value')}"
                       + (f" ({str(f.get('assertion_type')).lower()})" if f.get("assertion_type") not in
                          (None, "FACT") else ""))
    return out


def render_markdown(b: dict) -> str:
    prof = b.get("profile") or {}
    out = [f"# 📖 Book bible — {prof.get('title') or 'Untitled book'}", "",
           f"Saved by BookForge {b.get('app_version') or ''} on {(b.get('saved_at') or '')[:19].replace('T', ' ')} "
           "(UTC). The same content as `book-bible.json` (that file is the one BookForge reads back).", "",
           "## The book", ""]
    for k in PROFILE_KEYS:
        if prof.get(k) not in (None, ""):
            out.append(f"- **{k.capitalize()}:** {prof[k]}")
    ch = b.get("choices") or {}
    if ch:
        out += ["", "**Ending and style choices:**"] + [f"- {x}" for x in story_choices.summary(ch)]
    if b.get("pipeline"):
        out += ["", f"**Made with:** {pipeline_mod.describe(b['pipeline'])}"]
    if b.get("length"):
        ln = b["length"]
        out += [f"**Length:** {ln.get('label') or prof.get('length') or ''} — about {ln.get('book_words') or '?'} words"]
    out += ["", f"## Characters ({len(b.get('characters') or [])})", ""]
    for c in b.get("characters") or []:
        data = c.get("data") or {}
        out.append(f"### {c.get('name')}" + ("" if c.get("approved") else " (draft — not approved yet)"))
        out += _md_value(data.get("attributes") or {})
        f = _facts(data)
        if f:
            out += ["- **Facts:**"] + f
        if c.get("sheet"):
            out += ["", "**Character sheet**"] + _md_value(c["sheet"])
        if c.get("voice"):
            out += ["", "**Voice card** (how they talk)"] + _md_value(c["voice"])
        out.append("")
    out += [f"## Places, world and other canon ({len(b.get('canon') or [])})", ""]
    for c in b.get("canon") or []:
        data = c.get("data") or {}
        out.append(f"### {c.get('name')} — {c.get('kind') or c.get('module_id')}"
                   + ("" if c.get("approved") else " (draft)"))
        out += _md_value(data.get("attributes") or {})
        f = _facts(data)
        if f:
            out += ["- **Facts:**"] + f
        out.append("")
    if b.get("protected_facts"):
        out += ["## Protected facts", ""]
        for p in b["protected_facts"]:
            out.append(f"- **{p.get('name')}:** " + ", ".join(p.get("flags") or []))
        out.append("")
    plan = b.get("plan") or {}
    out += ["## The plan", ""]
    if not plan:
        out += ["No premise, plot or outline yet.", ""]
    for key in ("premise", "main_plot", "outline"):
        p = plan.get(key)
        if not p:
            continue
        out.append(f"### {PLAN_LABELS[key]}" + ("" if p.get("approved") else " (draft)"))
        data = p.get("data") or {}
        if key == "outline":
            for i, chap in enumerate(data.get("chapters") or []):
                out.append(f"{i + 1}. {chap.get('summary') or ''}")
        else:
            out += _md_value({k: v for k, v in data.items() if not isinstance(v, dict) or "record_id" not in v})
        out.append("")
    if b.get("scene_cards"):
        out += ["## Scene cards", ""]
        for s in b["scene_cards"]:
            out.append(f"### Chapter {s.get('chapter_id')}")
            for i, card in enumerate(s.get("cards") or []):
                out.append(f"{i + 1}. " + "; ".join(f"{k.replace('_', ' ')}: {v}" for k, v in card.items()
                                                     if v not in (None, "", [])))
            out.append("")
    out += [f"## Story rules ({len(b.get('story_rules') or [])})", ""]
    for r in b.get("story_rules") or []:
        out.append(f"- **{story_rules.CATEGORY_LABELS.get(r.get('category'), r.get('category'))}:** {r.get('text')}"
                   + (f" — limits: {r['scope']}" if r.get("scope") else "")
                   + (" (retired)" if r.get("status") == "retired" else ""))
    out += ["", f"## World texture ({len(b.get('world_texture') or [])})", ""]
    for t in b.get("world_texture") or []:
        out.append(f"- **{t.get('kind')}:** {t.get('detail')}" + (f" — {t['effect']}" if t.get("effect") else ""))
    out.append("")
    return "\n".join(out)
