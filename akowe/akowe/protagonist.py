"""Is the book's main character approved canon? (the first real book's "lost protagonist")

The book profile's idea names the main character ("Odile Marsh is the last lamplighter…"), the Bible Builder marks
one proposed character as main (character sheet role "main"), and a chapter outline Akọwe refused names the
viewpoint characters it needed. When one of those has no approved A01 entry, every later step suffers: the outline
has no POV ID for them, the writer drifts, the editor complains. ``missing`` finds them (deterministic, no AI); the
Make-a-book run makes them before the outline, and the guided path shows a ⚠️ with a one-click "make it".

Never logs or stores prose: only names (which are already shown on the page) and Akọwe's own check messages.
"""
from __future__ import annotations

import re

# Words that start a sentence or a title, not a name ("When Odile…", "Captain Odile Marsh").
LEAD_WORDS = frozenset("""the a an when after before in on at as but and if while once every only until since then now
there here this that with without from for by during one two three she he they her his their its it we i you so yet
years young old meanwhile soon later each all no not what why how where who captain lady lord sir dr doctor mr mrs
ms miss madam aunt uncle father mother sister brother professor inspector detective king queen prince princess saint
st apprentice master keeper chief sergeant officer agent""".split())
# A word that marks a place, building, group or thing (and is rarely a family name).
PLACE_WORDS = frozenset("""harbor harbour street bay reef island isle islands isles city port river mount mountain
mountains sea ocean kingdom empire lighthouse ferry station road lane bridge castle tower forest valley coast academy
school college university company guild council church abbey market square gate quay docks canal cove village county
republic federation society inn tavern hotel museum library point house hall district quarter province state
university line railway avenue""".split())
PARTICLES = frozenset({"de", "van", "von", "del", "da", "di", "du", "le", "la", "der", "den", "ter"})
MAX_NAMES = 3
MAIN_WHY = "proposed as the main character"
IDEA_WHY = "named in the book idea"
POV_WHY = "a viewpoint character the chapter outline needs"
POV_RE = re.compile(r"plan\.pov_id '([a-z0-9][a-z0-9_-]*)' is not declared")


def _tokens(name: str) -> list[str]:
    return [t for t in re.findall(r"[^\W_]+", str(name or "").lower().replace("’s", "").replace("'s", ""))
            if len(t) > 1]


def slug(name: str) -> str:
    return "-".join(_tokens(name))


def same_person(a: str, b: str) -> bool:
    """"Odile Marsh" and "Odile" are the same person; "Odile Marsh" and "Tamsin Reed" are not."""
    ta, tb = set(_tokens(a)), set(_tokens(b))
    return bool(ta and tb) and (ta <= tb or tb <= ta)


def names_in_idea(idea: str, limit: int = MAX_NAMES) -> list[str]:
    """People named in the book idea: runs of two or more capitalised words inside one clause, without a leading
    "When"/"The"/title word and without a place word ("Vell Harbour", "The Last Ferry")."""
    out: list[str] = []
    for chunk in re.split(r"[.,;:!?()\[\]\"“”—–\n]+|\s-\s", str(idea or "")):
        run: list[str] = []
        for word in chunk.split() + [""]:
            w = word.strip("'’")
            if w and w[0].isupper() and not any(ch.isdigit() for ch in w):
                run.append(w)
                continue
            if w.lower() in PARTICLES and run:
                run.append(w.lower())
                continue
            while run and (run[0].lower() in LEAD_WORDS or run[0].lower() in PARTICLES):
                run.pop(0)
            while run and run[-1].lower() in PARTICLES:
                run.pop()
            if run and run[-1].endswith(("'s", "’s")):
                run[-1] = run[-1][:-2]
            if len([x for x in run if x.lower() not in PARTICLES]) >= 2 and \
                    not any(x.lower() in PLACE_WORDS for x in run):
                name = " ".join(run)
                if not any(same_person(name, o) for o in out):
                    out.append(name)
            run = []
    return out[:limit]


def record_names(rec: dict) -> list[str]:
    data = (rec or {}).get("data") or {}
    names = [str(f.get("value")) for f in data.get("facts") or [] if isinstance(f, dict)
             and f.get("predicate") == "entity.name" and isinstance(f.get("value"), str) and f["value"].strip()]
    if isinstance(data.get("concept"), str) and data["concept"].strip():
        names.append(data["concept"].strip())
    return names


def _subjects(rec: dict) -> set:
    return {f.get("subject_id") for f in ((rec or {}).get("data") or {}).get("facts") or [] if isinstance(f, dict)}


def _pov_needs(bp) -> list[str]:
    """Viewpoint subject IDs a chapter outline Akọwe refused could not find in the canon (CANON_UNRESOLVED)."""
    out = []
    for r in bp.heads("B11"):
        if r.get("approved_version"):
            continue
        for f in r.get("findings") or []:
            for sid in POV_RE.findall(str(f.get("message") or "")):
                if sid not in out:
                    out.append(sid)
    return out


def missing(bp, *, main_names=(), store=None) -> list[dict]:
    """The main characters with no approved A01 entry: [{name, why, draft (an unapproved A01 draft of them, or
    None), refused (Akọwe's last refusal of a set-aside entry of them, or [])}]. Deterministic; never raises."""
    try:
        return _missing(bp, main_names, store)
    except Exception:  # noqa: BLE001 - a check must never break the page or the run
        import logging  # noqa: PLC0415
        logging.getLogger("akowe.protagonist").exception("could not check the main characters")
        return []


def _missing(bp, main_names, store) -> list[dict]:
    approved = bp.approved("A01")
    known = [(record_names(r), _subjects(r)) for r in approved]
    a01_heads = bp.heads("A01")
    others = [n for r in bp.records() if r["module_id"].startswith("A") and r["module_id"] != "A01"
              and r.get("record_kind", "OUTPUT") == "OUTPUT" for n in record_names(r)]
    cands: list[tuple[str, str]] = [(n, IDEA_WHY) for n in names_in_idea((bp.profile or {}).get("idea") or "")]
    cands += [(str(n), MAIN_WHY) for n in main_names or () if str(n or "").strip()]
    if store is not None:  # the Bible Builder's own mark: a character sheet with role "main" on a character not approved
        from . import characters as chars_mod  # noqa: PLC0415
        ok_ids = {r["record_id"] for r in approved}
        live = {r["record_id"] for r in a01_heads if r["lifecycle"] not in ("REJECTED", "SUPERSEDED")}
        for rid, e in chars_mod.all_entries(store, bp.pid, bp.branch).items():
            if rid in live and rid not in ok_ids and (e.get("role") or (e.get("sheet") or {}).get("role")) == "main" \
                    and e.get("name"):
                cands.append((str(e["name"]), MAIN_WHY))
    for sid in _pov_needs(bp):
        cands.append((" ".join(w.capitalize() for w in re.split(r"[-_]+", sid) if w), POV_WHY))
    out: list[dict] = []
    for name, why in cands:
        if any(same_person(name, o["name"]) for o in out):
            continue
        sl = slug(name)
        if any(any(same_person(name, n) for n in names) or sl in subs for names, subs in known):
            continue  # approved canon
        if why == IDEA_WHY and any(same_person(name, n) for n in others):
            continue  # a place, group or thing of the canon, not a person
        draft = refused = None
        for r in sorted(a01_heads, key=lambda x: x.get("created_at") or "", reverse=True):
            if not any(same_person(name, n) for n in record_names(r)) and sl not in _subjects(r):
                continue
            if r.get("stale") or r["lifecycle"] in ("REJECTED", "SUPERSEDED"):
                refused = refused or [f"{f.get('rule_id')}: {f.get('message')}" for f in r.get("findings") or []
                                      if f.get("severity") == "BLOCKING"][:6]
            elif draft is None and r["lifecycle"] in ("DRAFT", "VALIDATED"):
                draft = r
        out.append({"name": name[:120], "why": why, "draft": draft["ref"] if draft else None,
                    "draft_title": (record_names(draft) or [name])[0] if draft else None,
                    "draft_lifecycle": draft["lifecycle"] if draft else None,
                    "refused": refused or []})
    return out[:MAX_NAMES + 1]


def main_note(name: str, why: str) -> str:
    return (f"This is the book's main character, “{name}” ({why}): keep exactly this name; in character_sheet the role "
            "is main.")


def make_for_book(assist, bp, name, *, max_fixes: int = 2) -> dict:
    """(c) The guided path's one-click "✨ Make <name>": the AI makes the A01 entry of a main character the canon is
    missing, under exactly that name (Bible Builder item: sheet and voice card included), as a DRAFT the author
    approves. A proposal Akọwe's checks refuse is made again with the exact problems (at most ``max_fixes``)."""
    from .assist import BibleSession, book_profile_brief  # noqa: PLC0415
    from .errors import AkoweError  # noqa: PLC0415
    from .jobs import BUSY_CODES  # noqa: PLC0415
    if not isinstance(name, str) or not name.strip() or len(name) > 120:
        raise AkoweError("INVALID_INPUT", "/name", "the character's name: 1 to 120 characters", status="REJECTED")
    name = name.strip()
    gap = next((m for m in missing(bp, store=bp.store) if same_person(name, m["name"])), None)
    if gap is None:
        return {"ok": True, "message": f"“{name}” is already one of the book's characters (or not a missing main "
                                       "character): nothing was made."}
    if gap.get("draft"):
        return {"ok": True, "existing": True, "created": gap["draft"],
                "message": f"“{gap['draft_title'] or name}” is already drafted and waits for you: read it and approve "
                           "it in Characters and places."}
    if not bp.ai_ready():
        return {"ok": False, "needs_manual": True, "op": "A01", "payload": {"concept": name},
                "message": f"No AI can write it ({bp.no_ai_reason()}), so the character form is ready for "
                           f"“{name}”: fill it in and press Create."}
    prof = book_profile_brief(bp.store, bp.pid)
    slot = bp.ai_slot if bp.ai_slot in ("AI-1", "AI-2", "AI-3") else None
    sess = BibleSession(assist, bp.principal, bp.pid, bp.branch, prof.get("idea") or prof.get("title") or name, slot)
    key = sess.add_named("A01", name)
    it = sess.items[key]
    base = main_note(name, gap["why"])
    if gap.get("refused"):
        base += " Akọwe's checks refused the earlier entry: " + "; ".join(gap["refused"][:6]) + ". Fix exactly these."
    note, probs = base, []
    for _n in range(max_fixes + 1):
        sess._generate_item(it, slot, note)
        err = it.get("error") or {}
        if it["status"] == "error" and (err.get("code") in ("TIMEOUT", "CAPABILITY_UNAVAILABLE", "CANCELLED")
                                        or err.get("code") in BUSY_CODES):
            return {"ok": False, "code": err.get("code"), "message": f"The AI could not make “{name}” "
                    f"({err.get('code')}): {err.get('message') or ''}".strip(), "problems": []}
        probs = sess.refusals(it) or ([f"{err.get('code')}: {err.get('message')}"] if it["status"] == "error" else [])
        if not probs:
            out = sess.create([key], {})
            if out["created"]:
                return {"ok": True, "created": out["created"][0]["ref"],
                        "message": f"Your AI made the character “{name}”. Read it, then approve it in Characters and "
                                   "places — the chapter outline can then give them their chapters."}
            e = (out["errors"] or [{}])[0]
            probs = [f"{e.get('code')}: {e.get('message')}"]
        note = (base + " Akọwe's checks refused your previous proposal of this entry: " + "; ".join(probs[:8])
                + ". Return a corrected complete entry that fixes exactly these problems.")
    return {"ok": False, "code": "PROTAGONIST_MISSING", "problems": probs[:6],
            "message": f"Akọwe's checks refused the AI's entry for “{name}” {max_fixes + 1} times. Press the "
                       "button again, or write the character yourself (Characters and places → ✍️ Write one myself)."}
