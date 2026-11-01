"""Story roles: every character has a title (★ Main character, Villain, Mentor, Extra…), and every book has exactly one
main character (the protagonist), identified by its A01 record ID — never re-derived from text once it is tagged.

Where the tag lives: the character's companion entry (settings ``characters:<project>:<branch>``, keyed by the A01
record ID; see ``characters.py``): ``story_role`` (one of ``KEYS``), ``story_role_by`` (``ai`` | ``author`` |
``resolved`` | ``inferred`` | ``legacy``) and ``story_role_at``; the character sheet carries the same ``story_role``
(and, for older readers, the legacy ``role`` main/side derived from it). The AI is asked for ``story_role`` whenever
it makes or edits a character (world sketch, Bible Builder item, the sheet-and-voice call, the protagonist re-make,
Make a book). A new A01 entry the Bible Builder makes also carries the title in its ``attributes.role`` text. The
companion tag is the source of truth: the author changes it on the character page without a new canon revision.

Back compatibility: an old sheet role ``main`` is the protagonist when it is the only (or the primary) main
character, else a ``deuteragonist``; ``side`` is ``supporting``; a character with no role gets one inferred (from the
words of its ``attributes.role``: villain, mentor, sister…), shown as a proposal (``proposed``) until the AI or the
author confirms it.

Exactly one protagonist (``cast``): an author-chosen ★ wins; else one AI/stored protagonist; else (none, or several)
the deterministic order: the person named in the book idea > the Bible Builder's main mark (old role ``main`` /
proposed protagonist) > the most POV chapters in the outline > the first created. The others who claimed ★ become
second leads. ``enforce`` writes the result (and returns what changed, so callers record a plain event).
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone

from . import names as names_mod

log = logging.getLogger("akowe.story_roles")

# (key, label, icon, one-line meaning, group) — the ONE place the roles are named
ROLES = (
    ("protagonist", "Main character", "★", "The one the book is about. Exactly one per book.", "main"),
    ("deuteragonist", "Second lead", "☆", "The second most important character, with a story of their own beside "
                                          "the main character's.", "leads"),
    ("love_interest", "Love interest", "♥", "The person the main character (or a lead) is drawn to.", "leads"),
    ("antagonist", "Villain", "🗡️", "The main opponent: works against the main character.", "villains"),
    ("henchman", "Henchman", "👊", "Works for the villain: a minion, enforcer or lackey.", "villains"),
    ("rival", "Rival", "⚡", "Competes with the main character without being the villain.", "villains"),
    ("mentor", "Mentor", "🦉", "Teaches, guides or protects the main character.", "supporting"),
    ("sidekick", "Sidekick", "🤝", "The main character's loyal companion.", "supporting"),
    ("ally", "Ally", "🛡️", "Helps the main character, for reasons of their own.", "supporting"),
    ("family", "Family", "🏠", "A relative of the main character or of a lead.", "supporting"),
    ("supporting", "Supporting character", "👤", "Matters to the story; none of the roles above fits.", "supporting"),
    ("minor", "Minor character", "•", "Appears now and then; a small part.", "minor"),
    ("extra", "Extra", "👥", "Background or walk-on: seen in a scene, hardly part of the story.", "minor"),
)
KEYS = tuple(r[0] for r in ROLES)
INFO = {r[0]: {"key": r[0], "label": r[1], "icon": r[2], "meaning": r[3], "group": r[4]} for r in ROLES}
GROUPS = (("main", "★ Main character"), ("leads", "Leads"), ("villains", "Villains"), ("supporting", "Supporting"),
          ("minor", "Minor & extras"))
GROUP_LABEL = dict(GROUPS)
PROTAGONIST = "protagonist"
DEFAULT = "supporting"
BY = ("ai", "author", "resolved", "inferred", "legacy")
PROPOSED_BY = ("inferred",)

SYNONYMS = {
    "protagonist": "protagonist", "main": "protagonist", "main character": "protagonist", "hero": "protagonist",
    "heroine": "protagonist", "lead": "protagonist", "narrator": "protagonist", "the main character": "protagonist",
    "deuteragonist": "deuteragonist", "second lead": "deuteragonist", "co lead": "deuteragonist",
    "co protagonist": "deuteragonist", "secondary lead": "deuteragonist",
    "love interest": "love_interest", "love": "love_interest", "romantic interest": "love_interest",
    "lover": "love_interest",
    "antagonist": "antagonist", "villain": "antagonist", "villainess": "antagonist", "big bad": "antagonist",
    "nemesis": "antagonist", "main villain": "antagonist",
    "henchman": "henchman", "henchwoman": "henchman", "henchperson": "henchman", "minion": "henchman",
    "lackey": "henchman", "enforcer": "henchman", "goon": "henchman", "thug": "henchman",
    "rival": "rival", "mentor": "mentor", "teacher": "mentor", "guide": "mentor",
    "sidekick": "sidekick", "companion": "sidekick", "ally": "ally", "friend": "ally", "helper": "ally",
    "family": "family", "relative": "family",
    "supporting": "supporting", "supporting character": "supporting", "side": "supporting",
    "side character": "supporting", "secondary": "supporting", "secondary character": "supporting",
    "minor": "minor", "minor character": "minor", "bit part": "minor",
    "extra": "extra", "background": "extra", "background character": "extra", "walk on": "extra", "cameo": "extra",
}
# Words of a free-text role (A01 attributes.role, a sketch's role line) -> a story role, in this order.
INFER = (
    ("protagonist", r"main character|protagonist|heroine|\bhero\b|narrator"),
    ("deuteragonist", r"deuteragonist|second lead|co-?protagonist"),
    ("henchman", r"hench(?:man|woman|men)|minion|lackey|enforcer|\bgoons?\b|\bthugs?\b"),
    ("antagonist", r"villain|antagonist|nemesis|big bad"),
    ("rival", r"\brival"),
    ("love_interest", r"love interest|\blover\b|sweetheart|romantic"),
    ("mentor", r"mentor|teacher|tutor|\bguide\b"),
    ("sidekick", r"sidekick|companion"),
    ("family", r"\b(?:mother|father|sister|brother|daughter|son|aunt|uncle|grand(?:mother|father)|cousin|wife|"
               r"husband|twin|niece|nephew|mum|dad)\b"),
    ("ally", r"\bally\b|\bfriend\b|helper"),
    ("extra", r"walk-on|background|cameo|\bextra\b"),
    ("minor", r"minor character|bit part"),
)


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def role_info() -> list[dict]:
    """The roles with label, icon, meaning and group (the UI and the prompts never hard-code them)."""
    return [dict(INFO[k], group_label=GROUP_LABEL[INFO[k]["group"]]) for k in KEYS]


def prompt_list() -> str:
    """The roles as one line for an AI prompt."""
    return "; ".join(f"{k} ({INFO[k]['label'].lower()}: {INFO[k]['meaning'].rstrip('.')})" for k in KEYS)


def normalize(value, default: str | None = DEFAULT) -> str | None:
    """A role key from an enum key, a label or a common word ("villain", "Main character", "walk-on", "side");
    anything unknown -> ``default`` (supporting)."""
    if not isinstance(value, str):
        return default
    v = re.sub(r"[^a-z]+", " ", value.casefold().replace("_", " ")).strip()
    if not v:
        return default
    k = v.replace(" ", "_")
    if k in INFO:
        return k
    for key in KEYS:
        if v == INFO[key]["label"].casefold():
            return key
    return SYNONYMS.get(v, default)


def infer(text) -> str | None:
    """A role guessed from free text (e.g. "the harbour-master's enforcer" -> henchman); None when nothing fits."""
    low = str(text or "").casefold()
    if not low.strip():
        return None
    for key, pat in INFER:
        if re.search(pat, low):
            return key
    return None


def legacy(role) -> str:
    """Old sheet role -> new: main -> protagonist (the caller demotes extra mains), side -> supporting."""
    return PROTAGONIST if role == "main" else DEFAULT if role == "side" else ""


def legacy_of(story_role) -> str:
    """New -> the old main/side the older readers know."""
    return "main" if story_role in (PROTAGONIST, "deuteragonist") else "side" if story_role in INFO else ""


def label(role) -> str:
    return INFO.get(role, {}).get("label", "")


def icon(role) -> str:
    return INFO.get(role, {}).get("icon", "")


def title(role) -> str:
    """"★ Main character" — the role as shown on a list or a card."""
    i = INFO.get(role)
    return f"{i['icon']} {i['label']}" if i else ""


def group_of(role) -> str:
    return INFO.get(role, {}).get("group", "minor")


# ====================================================================== stored tag of one character
def stored(entry: dict | None) -> tuple[str | None, str | None, str | None]:
    """(role, by, at) from a companion entry: the story_role tag, else the sheet's, else the legacy main/side
    (by "legacy", role "main" kept as the marker ``main`` until the cast decides protagonist or second lead)."""
    e = entry if isinstance(entry, dict) else {}
    sheet = e.get("sheet") if isinstance(e.get("sheet"), dict) else {}
    for src in (e, sheet):
        r = src.get("story_role")
        if r in INFO:
            by = e.get("story_role_by") if e.get("story_role_by") in BY else "ai"
            return r, by, e.get("story_role_at")
    old = sheet.get("role") or e.get("role")
    if old == "main":
        return "main", "legacy", None
    if old == "side":
        return DEFAULT, "legacy", None
    return None, None, None


def _alias_names(text: str) -> list[str]:
    m = re.search(r"(?:also called|aka|a\.k\.a\.|nicknames?|aliases?|known as)\s*:?\s*(.+)", text or "", re.I)
    if not m:
        return []
    return [p.strip(" .\"“”'") for p in re.split(r"[,;/]|\band\b|\bor\b", m.group(1)) if 1 < len(p.strip()) < 60][:6]


def aliases(store, pid: str, branch: str) -> dict:
    """{record_id: [aliases and nicknames]} from the Character Forge dossiers (best effort)."""
    out: dict = {}
    try:
        doc = store.get_setting(f"forge:{pid}:{branch}") or {}
        recs = ((doc.get("records") or {}).get("character") or {}) if isinstance(doc, dict) else {}
        for rid, e in recs.items():
            if not isinstance(e, dict):
                continue
            al = [str(a) for a in e.get("aliases") or [] if isinstance(a, str)]
            name_f = (e.get("fields") or {}).get("name")
            if isinstance(name_f, dict):
                al += _alias_names(str(name_f.get("text") or ""))
            if al:
                out[rid] = list(dict.fromkeys(al))
    except Exception:  # noqa: BLE001 - aliases are a help, never a reason to fail
        log.exception("could not read the dossier aliases")
    return out


def names_of(c: dict, extra=()) -> list[str]:
    """Every way to name a character: display name, subject ID and record ID as words, alias facts, dossier aliases."""
    out = [c.get("name") or ""] + names_mod.id_names(c.get("subject_id"))
    for f in c.get("facts") or []:
        p = str(f.get("predicate") or "")
        if ("alias" in p or "nickname" in p or p == "entity.name") and isinstance(f.get("value"), (str, list)):
            vals = f["value"] if isinstance(f["value"], list) else [f["value"]]
            out += [str(v) for v in vals if isinstance(v, str)]
    out += list(extra or ())
    return [n for n in dict.fromkeys(out) if n and n.strip()]


def find(chars: list[dict], name_or_id, *, alias_map: dict | None = None, exclude=()) -> dict | None:
    """The ONE character a name or ID means (exact IDs first, then the shared name matcher)."""
    if not name_or_id or not chars:
        return None
    s = str(name_or_id).strip()
    low = s.lower()
    hit = next((c for c in chars if low in (str(c.get("record_id") or "").lower(),
                                            str(c.get("subject_id") or "").lower())), None)
    if hit:
        return hit
    alias_map = alias_map or {}
    by_id = {c["record_id"]: c for c in chars}
    key = names_mod.match(s, [(c["record_id"], names_of(c, alias_map.get(c["record_id"]))) for c in chars],
                          exclude=exclude)
    return by_id.get(key) if key else None


# ====================================================================== the cast: everyone's role, one protagonist
def _idea(store, pid) -> str:
    try:
        from .book_path import get_profile  # noqa: PLC0415
        return str(get_profile(store, pid).get("idea") or "")
    except Exception:  # noqa: BLE001
        return ""


def outline_povs(store, pid: str, branch: str) -> list[str]:
    """POV values of the chapter outline (approved, else newest unrejected draft), one per chapter."""
    try:
        heads = [r for r in store.list_records(pid, branch, module_id="B11")
                 if r.get("record_kind", "OUTPUT") == "OUTPUT" and r["lifecycle"] not in ("REJECTED", "SUPERSEDED")
                 and not r.get("stale")]
    except Exception:  # noqa: BLE001
        return []
    if not heads:
        return []
    heads.sort(key=lambda r: (bool(r.get("approved_version")), r.get("created_at") or ""), reverse=True)
    h = heads[0]
    rec = store.get_record(pid, branch, h["record_id"], h.get("approved_version") or h["version"]) or h
    out = []
    for ch in (rec.get("data") or {}).get("chapters") or []:
        for f in (ch or {}).get("facts") or []:
            if isinstance(f, dict) and f.get("predicate") == "plan.pov_id" and isinstance(f.get("value"), str):
                out.append(f["value"])
    return out


def _place_names(store, pid, branch) -> list[str]:
    try:
        from .protagonist import record_names  # noqa: PLC0415
        out = []
        for r in store.list_records(pid, branch):
            if str(r.get("module_id") or "").startswith("A") and r["module_id"] != "A01" \
                    and r.get("record_kind", "OUTPUT") == "OUTPUT":
                out += record_names(r)
        return out
    except Exception:  # noqa: BLE001
        return []


def cast(store, pid: str, branch: str, *, chars: list[dict] | None = None, entries: dict | None = None,
         idea: str | None = None, povs: list[str] | None = None, approved_only: bool = False) -> dict:
    """Everyone's story role, with exactly one protagonist (when there are characters).
    {"characters": [{record_id, name, subject_id, approved, story_role, label, icon, title, group, by, proposed,
    claimed}], "protagonist": record_id | None, "reason": plain words}. Deterministic; never raises."""
    try:
        return _cast(store, pid, branch, chars, entries, idea, povs, approved_only)
    except Exception:  # noqa: BLE001 - a role must never break a page or a run
        log.exception("could not work out the story roles")
        return {"characters": [], "protagonist": None, "reason": ""}


def _cast(store, pid, branch, chars, entries, idea, povs, approved_only) -> dict:
    from . import characters as chars_mod  # noqa: PLC0415
    if chars is None:
        chars = chars_mod.canon_characters(store, pid, branch, approved_only=approved_only)
    if entries is None:
        entries = chars_mod.all_entries(store, pid, branch)
    if not chars:
        return {"characters": [], "protagonist": None, "reason": ""}
    idea = _idea(store, pid) if idea is None else idea
    alias_map = aliases(store, pid, branch)
    rows = []
    for i, c in enumerate(chars):
        role, by, at = stored(entries.get(c["record_id"]))
        guess = infer((c.get("attributes") or {}).get("role")) if role is None else None
        rows.append({"c": c, "i": i, "role": role, "by": by, "at": at or "", "guess": guess})
    # who is named in the idea (index of the name in the idea: the first named is the most likely lead)
    from .protagonist import names_in_idea  # noqa: PLC0415
    idea_rank: dict = {}
    for n_i, n in enumerate(names_in_idea(idea or "")):
        hit = find(chars, n, alias_map=alias_map)
        if hit and hit["record_id"] not in idea_rank:
            idea_rank[hit["record_id"]] = n_i
    pov_n: dict = {}
    for v in povs if povs is not None else outline_povs(store, pid, branch):
        hit = find(chars, v, alias_map=alias_map)
        if hit:
            pov_n[hit["record_id"]] = pov_n.get(hit["record_id"], 0) + 1

    def rank(r):
        rid = r["c"]["record_id"]
        marked = r["role"] in (PROTAGONIST, "main") or r["guess"] == PROTAGONIST
        return (idea_rank.get(rid, 99), 0 if marked else 1, -pov_n.get(rid, 0), r["i"])

    def why(r) -> str:
        rid = r["c"]["record_id"]
        if rid in idea_rank:
            return "named in the book idea"
        if r["role"] in (PROTAGONIST, "main") or r["guess"] == PROTAGONIST:
            return "proposed as the main character"
        if pov_n.get(rid):
            return f"the viewpoint of {pov_n[rid]} chapter(s)"
        return "the first character made"
    authored = [r for r in rows if r["role"] == PROTAGONIST and r["by"] == "author"]
    claimed = [r for r in rows if r["role"] == PROTAGONIST and r["by"] not in PROPOSED_BY]
    if authored:
        chosen = max(authored, key=lambda r: (r["at"], -r["i"]))
        reason = "chosen by you"
    elif len(claimed) == 1:
        chosen, reason = claimed[0], "tagged as the main character"
    else:
        pool = claimed or rows
        chosen = min(pool, key=rank)
        reason = why(chosen) + (f" (of {len(claimed)} marked as main)" if len(claimed) > 1 else "")
    out = []
    for r in rows:
        c = r["c"]
        role, by = r["role"], r["by"]
        if r is chosen:
            final = PROTAGONIST
            proposed = by in PROPOSED_BY or by is None
            by = by if role == PROTAGONIST and by not in PROPOSED_BY else ("resolved" if role else "inferred")
        elif role in (PROTAGONIST, "main"):
            final, proposed, by = "deuteragonist", True, "resolved" if role == PROTAGONIST else "legacy"
        elif role:
            final, proposed = role, by in PROPOSED_BY
        else:
            g = r["guess"]
            final = "deuteragonist" if g == PROTAGONIST else (g or DEFAULT)
            proposed, by = True, "inferred"
        i = INFO[final]
        out.append({"record_id": c["record_id"], "name": c["name"], "subject_id": c.get("subject_id"),
                    "approved": bool(c.get("approved")), "story_role": final, "label": i["label"], "icon": i["icon"],
                    "title": f"{i['icon']} {i['label']}", "meaning": i["meaning"], "group": i["group"],
                    "by": by, "proposed": bool(proposed), "claimed": role == PROTAGONIST,
                    "pov_chapters": pov_n.get(c["record_id"], 0)})
    return {"characters": out, "protagonist": chosen["c"]["record_id"], "reason": reason}


def story_role(store, pid: str, branch: str, rid: str) -> str | None:
    """The story role of one character (A01 record ID) as the cast decides it."""
    for c in cast(store, pid, branch)["characters"]:
        if c["record_id"] == rid:
            return c["story_role"]
    return None


def protagonist_of(store, pid: str, branch: str, *, approved_only: bool = False) -> dict | None:
    """The book's main character: {record_id, name, subject_id, approved, story_role, ..., reason} or None.
    The stored tag (by record ID) always wins, so a renamed or re-spelled protagonist is still found."""
    k = cast(store, pid, branch, approved_only=approved_only)
    c = next((x for x in k["characters"] if x["record_id"] == k["protagonist"]), None)
    return dict(c, reason=k["reason"]) if c else None


def tagged_protagonist(store, pid: str, branch: str) -> str | None:
    """The record ID that carries a stored (non-proposed) protagonist tag, newest author choice first; None when no
    character is tagged. Never looks at names or text."""
    from . import characters as chars_mod  # noqa: PLC0415
    try:  # only a character that is still in the book (not set aside, rejected or replaced)
        live = {r["record_id"] for r in store.list_records(pid, branch, module_id="A01")
                if r["lifecycle"] not in ("REJECTED", "SUPERSEDED") and (r.get("approved_version")
                                                                         or not r.get("stale"))}
    except Exception:  # noqa: BLE001
        live = None
    best = None
    for rid, e in chars_mod.all_entries(store, pid, branch).items():
        if live is not None and rid not in live:
            continue
        role, by, at = stored(e)
        if role == PROTAGONIST and by not in PROPOSED_BY:
            key = (by == "author", at or "")
            if best is None or key > best[0]:
                best = (key, rid)
    return best[1] if best else None


# ====================================================================== writing tags
def set_role(store, pid: str, branch: str, rid: str, role, *, by: str = "author", name: str | None = None,
             subject_id: str | None = None, move: bool = True) -> dict:
    """Store one character's story role. Choosing ``protagonist`` moves the ★ (``move``): the previous main character
    becomes a second lead. Returns {"record_id", "story_role", "previous_protagonist": record_id | None}."""
    from . import characters as chars_mod  # noqa: PLC0415
    role = normalize(role)
    by = by if by in BY else "author"
    moved = []
    with chars_mod._LOCK:  # noqa: SLF001 - the same lock as the sheets
        with store.transaction() as tx:
            cur = chars_mod.all_entries(store, pid, branch)
            if role == PROTAGONIST and move:
                for orid, e in cur.items():
                    if orid != rid and isinstance(e, dict) and stored(e)[0] in (PROTAGONIST, "main"):
                        _tag(e, "deuteragonist", "resolved" if by != "author" else "author")
                        moved.append(orid)
            e = cur.get(rid) if isinstance(cur.get(rid), dict) else {"record_id": rid, "version": 0}
            if name and not e.get("name"):
                e["name"] = name
            if subject_id and not e.get("subject_id"):
                e["subject_id"] = subject_id
            _tag(e, role, by)
            cur[rid] = e
            store.set_setting(chars_mod._key(pid, branch), cur)  # noqa: SLF001
            tx.insert_outbox(pid, branch, "characters.role_set", {"record_id": rid, "story_role": role, "by": by,
                                                                  "moved_from": moved[:4]})
    return {"record_id": rid, "story_role": role, "previous_protagonist": moved[0] if moved else None}


def _tag(e: dict, role: str, by: str):
    e["story_role"], e["story_role_by"], e["story_role_at"] = role, by, _now()
    if isinstance(e.get("sheet"), dict):
        e["sheet"]["story_role"] = role
        e["sheet"]["role"] = legacy_of(role)
    e["role"] = legacy_of(role)


def enforce(store, pid: str, branch: str, *, approved_only: bool = False, chars: list[dict] | None = None) -> dict:
    """Make the stored tags agree with ``cast``: exactly one stored protagonist, the extra claimants second leads,
    every character a stored role (inferred ones stay marked as proposals). Never overrides the author's own choice.
    Returns {"protagonist": record_id | None, "name", "reason", "changed": [record_id], "demoted": [record_id],
    "was_tagged": bool}."""
    from . import characters as chars_mod  # noqa: PLC0415
    k = cast(store, pid, branch, approved_only=approved_only, chars=chars)
    if not k["characters"]:
        return {"protagonist": None, "name": None, "reason": "", "changed": [], "demoted": [], "was_tagged": False}
    changed, demoted = [], []
    with chars_mod._LOCK:  # noqa: SLF001
        with store.transaction() as tx:
            cur = chars_mod.all_entries(store, pid, branch)
            was = any(stored(e)[0] == PROTAGONIST and stored(e)[1] not in PROPOSED_BY for e in cur.values()
                      if isinstance(e, dict))
            for c in k["characters"]:
                e = cur.get(c["record_id"]) if isinstance(cur.get(c["record_id"]), dict) else None
                role, by, _at = stored(e)
                if role == c["story_role"] and by not in ("legacy",) and (role != PROTAGONIST or by != "inferred"):
                    continue
                if e is None:
                    e = {"record_id": c["record_id"], "name": c["name"], "subject_id": c.get("subject_id"),
                         "version": 0}
                if role == PROTAGONIST and c["story_role"] != PROTAGONIST:
                    demoted.append(c["record_id"])
                new_by = "resolved" if c["story_role"] == PROTAGONIST or role in (PROTAGONIST, "main") else \
                    ("inferred" if c["proposed"] else (by or "inferred"))
                _tag(e, c["story_role"], new_by)
                cur[c["record_id"]] = e
                changed.append(c["record_id"])
            if changed:
                store.set_setting(chars_mod._key(pid, branch), cur)  # noqa: SLF001
                tx.insert_outbox(pid, branch, "characters.roles_resolved", {
                    "protagonist": k["protagonist"], "changed": len(changed), "demoted": len(demoted)})
    p = next(c for c in k["characters"] if c["record_id"] == k["protagonist"])
    return {"protagonist": k["protagonist"], "name": p["name"], "reason": k["reason"], "changed": changed,
            "demoted": demoted, "was_tagged": was}


def event_text(res: dict) -> str | None:
    """A plain event line for ``enforce``'s result (None when nothing worth saying changed)."""
    if not res.get("protagonist"):
        return None
    if res.get("demoted"):
        return (f"★ “{res['name']}” is the book's main character ({res['reason']}); {len(res['demoted'])} other "
                "character(s) marked as main became second leads (a book has exactly one main character)")
    if not res.get("was_tagged"):
        return f"★ “{res['name']}” is the book's main character ({res['reason']})"
    return None
