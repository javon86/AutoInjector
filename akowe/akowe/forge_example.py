"""🗂 "Load the Moki Vey example": the author's own Character Forge sample as a finished-looking dossier.

``examples/moki_vey/dossier.json`` holds the sample's text parsed into the dossier's field keys (built once from the
sample with a script; the pictures were downscaled with Pillow at build time, so the app needs no image library).
Loading it makes a draft character "Moki Vey" (A01, made like a hand-written entry) when the book has none, then fills
its dossier: the supplied canon is the author's (supplied, protected), everything else is a proposal, as in the
sample. The portrait and the ten views become book assets. Loading again reuses the same character and dossier.
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
        return {"ok": True, "record_id": rid, "created": False, "message": "The Moki Vey example is already here.",
                "dossier": forge.public(store, pid, branch, rid)}
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
    return {"ok": True, "record_id": rid, "created": created, "dossier": out,
            "message": "The Moki Vey example is loaded: a draft character with a full dossier of proposals, a "
                       "portrait and ten reference views."}
