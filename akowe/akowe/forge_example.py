"""🗂 "Load the Moki Vey example": the author's own Character Forge sample as a finished-looking dossier.

``examples/moki_vey/dossier.json`` holds the sample's text parsed into the dossier's field keys (built once from the
sample with a script; the pictures were downscaled with Pillow at build time, so the app needs no image library).
Loading it makes a draft character "Moki Vey" (A01, made like a hand-written entry) when the book has none, then fills
its dossier: the supplied canon is the author's (supplied, protected), everything else is a proposal, as in the
sample. The portrait and the ten views become book assets. Loading again reuses the same character and dossier.

The example world (``examples/moki_vey/world.json``): one item (AR-001 the rescue baton), one place (PL-001 Nacre)
and one magic system (MG-001 the biofilament mutation) that fit the sample's world, so the example shows all four
kinds linked to each other (``load_world``). Their supplied canon is supplied and protected, the rest proposals; the
sigil is a small JPEG drawn once with Pillow when the example was made.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from . import characters as chars_mod
from . import forge
from .errors import AkoweError

log = logging.getLogger("akowe.forge_example")
EXAMPLE_DIR = Path(__file__).resolve().parent / "examples" / "moki_vey"


def example() -> dict:
    try:
        return json.loads((EXAMPLE_DIR / "dossier.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise AkoweError("NOT_FOUND", "/example", "the Moki Vey example is missing from this Akọwe folder",
                             status="REJECTED") from exc


def _picture(name: str) -> bytes | None:
    p = (EXAMPLE_DIR / name).resolve()
    if EXAMPLE_DIR not in p.parents:
        return None
    try:
        return p.read_bytes()
    except OSError:
        return None


def load(app, principal: str, pid: str, branch: str, body: dict) -> dict:
    ex = example()
    name = ex["name"]
    store = app.store
    me = next((c for c in chars_mod.canon_characters(store, pid, branch) if c["name"].lower() == name.lower()), None)
    created = False
    if me is None:
        from .book_path import BookPath  # noqa: PLC0415
        bp = BookPath(app.engine, principal, pid, branch)
        cand = {"concept": name, "attributes": {}, "linked_refs": [], "protected_fact_flags": [],
                "facts": [{"subject_id": "moki_vey", "predicate": "entity.name", "value": name,
                           "assertion_type": "FACT", "effective_from": None, "effective_to": None, "source_refs": []}]}
        try:
            ref, _r = bp.create("A01", {"concept": name}, manual_candidate=cand)
        except Exception as exc:  # noqa: BLE001 - say it plainly
            log.warning("example character could not be made: %s", type(exc).__name__)
            raise AkoweError("INVALID_INPUT", "/example", "the example character could not be added to this book "
                                 "(is the book's canon locked?)", status="REJECTED") from None
        rid = ref["record_id"]
        created = True
    else:
        rid = me["record_id"]
    existing = forge.raw_entry(store, pid, branch, rid)
    if existing.get("history") and not created:
        world = load_world(app, principal, pid, branch)
        return {"ok": True, "record_id": rid, "created": False, "message": "The Moki Vey example is already here.",
                "dossier": forge.public(store, pid, branch, rid), "world": world}
    assets: dict = {"views": {}}
    art = ex.get("art") or {}
    for slot, fname in [("portrait", art.get("portrait"))] + list((art.get("views") or {}).items()):
        data = _picture(fname) if isinstance(fname, str) else None
        if not data:
            continue
        try:
            a = forge.store_picture(store, principal, pid, branch, data, "image/jpeg", f"{name} — {slot}")
        except AkoweError:
            log.warning("example picture %s was not stored", slot)
            continue
        a["source"] = "example"
        if slot == "portrait":
            assets["portrait"] = a
        else:
            assets["views"][slot] = a

    def fn(entry, fields, canon):
        changed = set()
        for key, rec in (ex.get("fields") or {}).items():
            if key not in forge.FIELDS or not isinstance(rec, dict):
                continue
            d = fields[key]
            if d.get("readonly") or d["text"]:
                continue  # never over anything the book already has
            d["text"] = forge.clip(rec.get("text"))
            d["status"] = rec.get("status") if rec.get("status") in forge.STATUSES else "proposed"
            d["protected"] = bool(rec.get("protected"))
            d["letters"] = forge.clean_letters(rec.get("letters"), forge.FIELDS[key]["letters"])
            if forge.TITLED.match(key):
                d["title"] = forge.clip(rec.get("title"), forge.TITLE_MAX)
            d["by"] = {"kind": "example"}
            d["sync"] = d.get("sync") if d.get("sync") is not None else ""
            changed.add(key)
        if not entry.get("tagline"):
            entry["tagline"] = forge.clip(ex.get("tagline"), forge.TAGLINE_MAX)
        if not entry.get("summary"):
            entry["summary"] = [forge.clip(x, forge.SUMMARY_MAX) for x in ex.get("summary") or []][:3]
        a = entry.setdefault("art", {"portrait": None, "views": {}, "sheet": None})
        if assets.get("portrait") and not a.get("portrait"):
            a["portrait"] = assets["portrait"]
        for v, x in assets["views"].items():
            if not (a.get("views") or {}).get(v):
                a.setdefault("views", {})[v] = x
        return changed, {}
    out = forge.mutate(store, pid, branch, rid, fn, what="example", by="example", bump=False, write=False)
    world = load_world(app, principal, pid, branch)
    return {"ok": True, "record_id": rid, "created": created, "dossier": out, "world": world,
            "message": "The Moki Vey example is loaded: a draft character with a full dossier of proposals, a "
                       "portrait and ten reference views, plus his rescue baton, the city of Nacre and his "
                       "mutation as linked dossiers."}


def load_world(app, principal: str, pid: str, branch: str) -> list[dict]:
    """The example item, place and magic system (once each, by name): [{kind, record_id, code, name, created}]."""
    from . import forge_kinds  # noqa: PLC0415
    try:
        world = json.loads((EXAMPLE_DIR / "world.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        log.warning("the example world is missing")
        return []
    store = app.store
    out = []
    for ex in world.get("dossiers") or []:
        kind = ex.get("kind")
        if kind not in forge_kinds.SPECS or not ex.get("name"):
            continue
        have = next((x for x in forge_kinds.list_dossiers(store, pid, branch, kind)
                     if x["name"].lower() == ex["name"].lower()), None)
        if have:
            out.append({"kind": kind, "record_id": have["record_id"], "code": have["code"], "name": have["name"],
                        "created": False})
            continue
        made = forge_kinds.create(store, pid, branch, kind, {"name": ex["name"], "aliases": ex.get("aliases") or []})
        rid = made["record_id"]
        sp = forge_kinds.SPECS[kind]
        pics = {}
        for slot, fname in (ex.get("art") or {}).items():
            data = _picture(fname) if isinstance(fname, str) and slot in sp["slots"] else None
            if not data:
                continue
            try:
                a = forge.store_picture(store, principal, pid, branch, data, "image/jpeg", f"{ex['name']} — {slot}")
            except AkoweError:
                continue
            a["source"] = "example"
            pics[slot] = a

        def fn(entry, fields, ex=ex, sp=sp, pics=pics):
            changed = set()
            for key, rec in (ex.get("fields") or {}).items():
                if key not in sp["fields"] or not isinstance(rec, dict) or fields[key]["text"]:
                    continue
                d = fields[key]
                d["text"] = forge.clip(rec.get("text"))
                d["status"] = rec.get("status") if rec.get("status") in forge.STATUSES else "proposed"
                d["protected"] = bool(rec.get("protected"))
                d["by"] = {"kind": "example"}
                changed.add(key)
            entry["tagline"] = entry.get("tagline") or forge.clip(ex.get("tagline"), forge.TAGLINE_MAX)
            entry["summary"] = entry.get("summary") or [forge.clip(x, forge.SUMMARY_MAX)
                                                        for x in ex.get("summary") or []][:3]
            art = entry.setdefault("art", {sp["art"]["hero"]: None, "views": {}})
            for slot, a in pics.items():
                if slot == sp["art"]["hero"]:
                    art[slot] = a
                else:
                    art.setdefault("views", {})[slot] = a
            return changed, {}
        d = forge_kinds.mutate(store, pid, branch, kind, rid, fn, what="example", by="example", bump=False)
        out.append({"kind": kind, "record_id": rid, "code": d["code"], "name": d["name"], "created": True})
    return out
