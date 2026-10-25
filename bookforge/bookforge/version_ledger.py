"""🧾 P34 version delta ledger for reruns and variants.

A 🔁 rerun (from a book bible) or a 🧪 variant is a NEW version of an earlier book. When the author changes something
on purpose (a character's secret, a place, a rule, a chapter's goal), the checkers must never "correct" it back to the
old story. So the new book keeps a ledger of what changed against the earlier version, fact by fact:

* **retained** — the same in both versions;
* **replaced** — different now (old → new), or new in this version;
* **removed** — in the earlier version, not in this one;
* **unresolved** — a replaced / removed fact nobody has decided about yet (each change starts unresolved; the author
  marks it ``deliberate`` — "keep the new version" — or ``restore`` — "bring the old version back").

Facts compared (deterministic, no AI): the book profile (title, genre, audience, tone, idea), the ending and style
choices, every character (role, identity, background, goals and the sheet's wants / needs / fear / secret / false
belief), every other canon entry (concept and attributes), the story rules and world texture (by id), the premise and
each chapter's objective. A removed or replaced NAME that still appears in this book's chapters is listed as
``old_on_page`` (the old story leaking back).

Where the earlier version comes from: a rerun keeps the source book bible (settings ``rerun_bible:<project>``); a
variant names its source book (project setting ``variant_of``), whose bible is built live. Companion data
``version_ledger:<project>:<branch>`` = {version, source {kind, title, project_id}, items, decisions {fact id:
{status, by, how, at}}, built_at, counts}. The writer's brief (``version_changes``) and the consistency review get the
deliberate changes, the ones to restore and the unresolved ones, so nobody reverts a deliberate change.
"""
from __future__ import annotations

import copy
import json
import logging
import re
from datetime import datetime, timezone

from . import story_rules
from .errors import BookforgeError

log = logging.getLogger("bookforge.version_ledger")

VALUE_MAX = 240
DECISIONS = ("unresolved", "deliberate", "restore")
PROFILE_KEYS = ("title", "genre", "audience", "tone", "idea")
CHAR_ATTRS = ("role", "identity", "background", "goals")
SHEET_KEYS = ("wants", "needs", "fear", "secret", "false_belief")
BRIEF_MAX = 12
RULE = ("Version changes (context.writing_brief.version_changes): this book is a new version of an earlier book. "
        "Items under 'deliberate' are the story NOW — never change them back to the earlier version, even when "
        "something seems to point to the old one; items under 'restore' must go back to the earlier version; for "
        "'unresolved' items follow this book's bible, not the earlier book.")


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _clip(v, n: int = VALUE_MAX) -> str:
    if isinstance(v, (dict, list)):
        v = json.dumps(v, ensure_ascii=False, sort_keys=True)
    return " ".join(str(v or "").split())[:n] if v not in (None, "") and not isinstance(v, bool) else ""


def _key(pid: str, branch: str) -> str:
    return f"version_ledger:{pid}:{branch}"


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(s or "").lower()).strip("-")[:60] or "x"


# ====================================================================== facts of one version
def facts(bible: dict) -> list[dict]:
    """[{id, area, name, label, value}] of one book version (a book bible dict)."""
    out = []

    def add(fid, area, name, label, value):
        v = _clip(value)
        if v:
            out.append({"id": fid, "area": area, "name": name, "label": label, "value": v})
    prof = bible.get("profile") or {}
    for k in PROFILE_KEYS:
        add(f"profile:{k}", "profile", k, f"Book {k}", prof.get(k))
    for k, v in sorted((bible.get("choices") or {}).items()):
        if not isinstance(v, (dict, list)):
            add(f"choice:{k}", "choices", k, f"Choice: {k.replace('_', ' ')}", v)
    for c in bible.get("characters") or []:
        name = str(c.get("name") or "")
        if not name:
            continue
        s = _slug(name)
        add(f"char:{s}", "characters", name, f"{name} (character)", name)
        attrs = (c.get("data") or {}).get("attributes") or {}
        for k in CHAR_ATTRS:
            if isinstance(attrs.get(k), str):
                add(f"char:{s}:{k}", "characters", name, f"{name}: {k}", attrs[k])
        sheet = c.get("sheet") or {}
        for k in SHEET_KEYS:
            add(f"char:{s}:sheet:{k}", "characters", name, f"{name}: {k.replace('_', ' ')}", sheet.get(k))
    for c in bible.get("canon") or []:
        name = str(c.get("name") or "")
        if not name:
            continue
        s = f"{c.get('module_id')}:{_slug(name)}"
        data = c.get("data") or {}
        add(f"canon:{s}", "canon", name, f"{name} ({c.get('kind') or c.get('module_id')})", name)
        add(f"canon:{s}:concept", "canon", name, f"{name}: what it is", data.get("concept") if
            data.get("concept") != name else "")
        attrs = data.get("attributes") or {}
        if isinstance(attrs, dict) and attrs:
            add(f"canon:{s}:attributes", "canon", name, f"{name}: details",
                {k: v for k, v in attrs.items() if isinstance(v, (str, int, float))})
    for r in bible.get("story_rules") or []:
        if isinstance(r, dict) and r.get("id") and r.get("status", "active") == "active":
            add(f"rule:{r['id']}", "rules", r["id"], f"Story rule ({r.get('category')})",
                f"{r.get('text')}" + (f" — limits: {r['scope']}" if r.get("scope") else ""))
    for t in bible.get("world_texture") or []:
        if isinstance(t, dict) and t.get("id"):
            add(f"texture:{t['id']}", "texture", t["id"], "World detail", t.get("detail"))
    plan = bible.get("plan") or {}
    prem = ((plan.get("premise") or {}).get("data") or {})
    add("plan:premise", "plan", "premise", "Premise", prem.get("premise"))
    outline = ((plan.get("outline") or {}).get("data") or {})
    for i, it in enumerate(outline.get("chapters") or []):
        fv = {f.get("predicate"): f.get("value") for f in it.get("facts") or [] if isinstance(f, dict)}
        cid = fv.get("plan.item_id") or f"ch{i + 1}"
        add(f"plan:{cid}:objective", "plan", cid, f"Chapter {i + 1} goal", fv.get("plan.objective") or it.get("summary"))
    return out


def diff(old: list[dict], new: list[dict]) -> list[dict]:
    """[{id, area, name, label, kind retained|replaced|removed|added, old, new}] (book order of the new version,
    removed ones last)."""
    o = {f["id"]: f for f in old}
    n = {f["id"]: f for f in new}
    out = []
    for fid, f in n.items():
        if fid in o:
            kind = "retained" if o[fid]["value"] == f["value"] else "replaced"
            out.append({"id": fid, "area": f["area"], "name": f["name"], "label": f["label"], "kind": kind,
                        "old": o[fid]["value"], "new": f["value"]})
        else:
            out.append({"id": fid, "area": f["area"], "name": f["name"], "label": f["label"], "kind": "added",
                        "old": "", "new": f["value"]})
    for fid, f in o.items():
        if fid not in n:
            # the same fact under a new id (a rule or detail renumbered): retained, not removed + added
            twin = next((x for x in out if x["kind"] == "added" and x["area"] == f["area"] and x["new"] == f["value"]),
                        None)
            if twin is not None:
                twin.update(kind="retained", old=f["value"])
                continue
            out.append({"id": fid, "area": f["area"], "name": f["name"], "label": f["label"], "kind": "removed",
                        "old": f["value"], "new": ""})
    return out


def _is_name(fid: str) -> bool:
    """The fact that a character or canon entry exists (its name), not one of its details."""
    return (fid.startswith("char:") and fid.count(":") == 1) or (fid.startswith("canon:") and fid.count(":") == 2)


def old_on_page(items: list[dict], chapters: list[dict]) -> list[dict]:
    """Removed / renamed characters and canon entries whose OLD name still appears in this book's chapters."""
    out = []
    names = [i for i in items if i["kind"] == "removed" and _is_name(i["id"])]
    for i in names:
        name = i["old"]
        if len(name) < 3:
            continue
        rx = re.compile(rf"\b{re.escape(name)}\b", re.I)
        hits = [c["number"] for c in chapters if rx.search(str(c.get("text") or ""))]
        if hits:
            out.append({"id": i["id"], "name": name, "chapters": hits[:10]})
    return out


# ====================================================================== the source (earlier version)
def source_of(app, pid: str) -> tuple[dict | None, dict | None]:
    """(earlier version's bible, {kind, title, project_id}) or (None, None) when this book is not a new version."""
    store = app.store
    try:
        b = store.get_setting(f"rerun_bible:{pid}")
    except Exception:  # noqa: BLE001
        b = None
    if isinstance(b, dict) and b.get("profile") is not None:
        src = b.get("source") or {}
        return b, {"kind": "rerun", "title": str((b.get("profile") or {}).get("title") or "")[:200],
                   "project_id": src.get("project_id")}
    proj = store.project(pid)
    try:
        st = json.loads(proj["settings"] or "{}") if proj else {}
    except ValueError:
        st = {}
    vo = st.get("variant_of") if isinstance(st, dict) else None
    if isinstance(vo, str) and vo and store.project(vo) is not None:
        from . import book_bible  # noqa: PLC0415
        try:
            sb = book_bible.build(app, vo, "main")
        except Exception:  # noqa: BLE001 - the source book may be half made
            log.exception("could not read the source book of a variant")
            return None, None
        return sb, {"kind": "variant", "title": str((sb.get("profile") or {}).get("title") or "")[:200],
                    "project_id": vo}
    return None, None


# ====================================================================== storage
def get_entry(store, pid: str, branch: str) -> dict | None:
    try:
        e = store.get_setting(_key(pid, branch))
    except Exception:  # noqa: BLE001
        return None
    return copy.deepcopy(e) if isinstance(e, dict) and e.get("version") else None


def counts(items: list[dict], decisions: dict) -> dict:
    c = {"retained": 0, "replaced": 0, "removed": 0, "unresolved": 0, "restore": 0}
    for i in items:
        if i["kind"] == "retained":
            c["retained"] += 1
            continue
        st = (decisions.get(i["id"]) or {}).get("status") or "unresolved"
        if st == "unresolved":
            c["unresolved"] += 1
        elif st == "restore":
            c["restore"] += 1
        elif i["kind"] == "removed":
            c["removed"] += 1
        else:
            c["replaced"] += 1
    return c


def build(app, pid: str, branch: str = "main", *, chapters: list[dict] | None = None) -> dict | None:
    """Compare this book with its earlier version and store the ledger (decisions are kept by fact id). None when
    the book is not a rerun or variant."""
    src_bible, src = source_of(app, pid)
    if src_bible is None:
        return None
    from . import book_bible  # noqa: PLC0415
    cur = book_bible.build(app, pid, branch)
    items = diff(facts(src_bible), facts(cur))
    leaks = old_on_page(items, chapters or [])

    def change(old):
        old = old or {}
        dec = {k: v for k, v in (old.get("decisions") or {}).items() if any(i["id"] == k for i in items)}
        return {"version": int(old.get("version") or 0) + 1, "source": src, "items": items, "decisions": dec,
                "old_on_page": leaks, "built_at": _now(), "counts": counts(items, dec)}
    return story_rules.update_single(app.store, _key(pid, branch), pid, branch, change, (
        "ledger.built", lambda e: dict(e["counts"], source=src["kind"], version=e["version"])))


def decide(store, pid: str, branch: str, decisions: dict, *, by: str, how: str = "author",
           run_id: str | None = None, base_version: int | None = None) -> dict:
    """decisions: {fact id: unresolved|deliberate|restore}."""
    if not isinstance(decisions, dict) or not decisions:
        raise BookforgeError("INVALID_INPUT", "/decisions", "decisions: {fact id: deliberate | restore | "
                             "unresolved}", status="REJECTED")
    for k, v in decisions.items():
        if v not in DECISIONS:
            raise BookforgeError("INVALID_INPUT", f"/decisions/{k}", "each decision is deliberate, restore or "
                                 "unresolved", status="REJECTED")

    def change(old):
        if not old:
            raise BookforgeError("NOT_FOUND", "/ledger", "this book has no version ledger (it is not a rerun or a "
                                 "variant)", status="REJECTED")
        if base_version is not None and old.get("version") != base_version:
            raise story_rules.conflict("version ledger", old.get("version"))
        ids = {i["id"] for i in old.get("items") or [] if i["kind"] != "retained"}
        dec = dict(old.get("decisions") or {})
        for k, v in decisions.items():
            if k not in ids:
                continue
            if v == "unresolved":
                dec.pop(k, None)
            else:
                dec[k] = {"status": v, "by": by, "how": how, "run_id": run_id, "at": _now()}
        old["decisions"] = dec
        old["counts"] = counts(old.get("items") or [], dec)
        return old
    return story_rules.update_single(store, _key(pid, branch), pid, branch, change, (
        "ledger.decided", lambda e: dict(e["counts"], how=how, run_id=run_id, decided=len(decisions))))


# ====================================================================== what the writer and the checkers get
def _line(i: dict) -> str:
    if i["kind"] == "removed":
        return f"{i['label']}: removed (was: {i['old'][:120]})"
    if i["kind"] == "added":
        return f"{i['label']}: new — {i['new'][:140]}"
    return f"{i['label']}: now {i['new'][:120]} (was: {i['old'][:100]})"


def brief(entry: dict | None, limit: int = BRIEF_MAX) -> dict | None:
    if not entry or not entry.get("items"):
        return None
    dec = entry.get("decisions") or {}
    groups = {"deliberate": [], "restore": [], "unresolved": []}
    for i in entry["items"]:
        if i["kind"] == "retained" or (i["kind"] == "added" and _is_name(i["id"])):
            continue  # a new entry's own name line adds nothing to its detail lines
        st = (dec.get(i["id"]) or {}).get("status") or "unresolved"
        groups[st].append(_line(i))
    out = {"earlier_version": f"{(entry.get('source') or {}).get('kind', 'earlier')} of “"
                              f"{(entry.get('source') or {}).get('title') or '?'}”"}
    for k, v in groups.items():
        if v:
            out[k] = v[:limit]
    if entry.get("old_on_page"):
        out["old_names_still_on_page"] = [f"{x['name']} (chapter {', '.join(map(str, x['chapters']))})"
                                          for x in entry["old_on_page"]][:6]
    return out if len(out) > 1 else None
