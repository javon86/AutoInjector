"""📚 "My finished books" (S22): every exported book across the author's projects, newest first.

A finished book is a project/branch whose guided book path recorded exports (``book_path:<pid>:<branch>``
settings key, written by ``BookPath.a_export``). Each file is re-read from the asset store and its SHA-256 is
compared with the export descriptor (``read_binary`` refuses bytes that do not match their content hash), so a
missing or changed file shows as not verified. Test books (self-test / workflow test) are left out. Archived
books are included with ``archived: true`` when asked (the Shelf lists them under "Archived": their downloads
live there, and archiving only hides a book from the book list).
"""
from __future__ import annotations

import hashlib
import json

from .book_path import EXPORT_FOR, get_profile

FORMAT_EXT = {"PDF": "pdf", "EPUB": "epub", "DOCX": "docx"}


def _is_test(settings_json: str) -> bool:
    try:
        s = json.loads(settings_json or "{}")
    except ValueError:
        return False
    return isinstance(s, dict) and bool(s.get("workflow_test") or s.get("selftest"))


def finished_books(app, *, verify: bool = True, limit: int | None = 200, principal: str | None = None,
                   include_archived: bool = False) -> list[dict]:
    store = app.store
    rows = store.query("SELECT key, value, updated_at FROM settings WHERE key LIKE 'book_path:%'")
    out = []
    for r in rows:
        try:
            mem = json.loads(r["value"])
        except ValueError:
            continue
        exports = (mem or {}).get("exports") or {}
        if not exports:
            continue
        _, pid, branch = r["key"].split(":", 2)
        proj = store.project(pid)
        if proj is None or (proj["archived"] and not include_archived) or _is_test(proj["settings"]):
            continue
        if principal and not store.has_project_access(principal, pid):
            continue
        prof = get_profile(store, pid)
        files, newest = [], ""
        for prof_type, e in exports.items():
            if prof_type not in EXPORT_FOR:
                continue
            op, fmt, mime = EXPORT_FOR[prof_type]
            d = (e or {}).get("descriptor") or {}
            try:
                desc = store.get_record(pid, branch, d.get("record_id"), d.get("version")) if d else None
            except Exception:  # noqa: BLE001
                desc = None
            art = ((desc or {}).get("data") or {}).get("artifact_ref") if desc else None
            item = {"format": fmt, "profile": prof_type, "op": op, "mime_type": mime, "record_id": None,
                    "version": None, "sha256": ((desc or {}).get("data") or {}).get("sha256"), "bytes": None,
                    "created_at": (desc or {}).get("created_at"), "verified": False, "ext": FORMAT_EXT.get(fmt)}
            if art:
                item.update(record_id=art["record_id"], version=art["version"])
                if verify:
                    try:
                        rec = store.get_record(pid, branch, art["record_id"], art["version"])
                        data = store.read_binary(rec)
                        digest = hashlib.sha256(data).hexdigest()
                        item["bytes"] = len(data)
                        item["verified"] = not item["sha256"] or item["sha256"] == digest
                    except Exception:  # noqa: BLE001 - missing/changed file: shown as not verified
                        item["verified"] = False
                else:
                    item["verified"] = None
            newest = max(newest, item["created_at"] or "")
            files.append(item)
        if not files:
            continue
        files.sort(key=lambda f: ["PDF", "EPUB", "DOCX"].index(f["format"]) if f["format"] in FORMAT_EXT else 9)
        out.append({"project_id": pid, "branch_id": branch, "title": prof.get("title") or proj["name"],
                    "author": prof.get("author") or "", "genre": prof.get("genre") or "", "exported_at": newest,
                    "files": files, "all_verified": all(f.get("verified") for f in files),
                    "made_by_run": (json.loads(proj["settings"] or "{}") or {}).get("made_by_run"),
                    "archived": bool(proj["archived"])})
    out.sort(key=lambda b: b["exported_at"] or "", reverse=True)
    return out[:limit]


def shelf(app, *, principal: str | None = None, limit: int = 200) -> dict:
    """The Shelf page: finished books, and separately the archived ones (still downloadable). Each list keeps its own
    newest ``limit`` books, so many archived books never push a finished one off the Shelf."""
    books = finished_books(app, verify=True, principal=principal, include_archived=True, limit=None)
    return {"books": [b for b in books if not b["archived"]][:limit],
            "archived": [b for b in books if b["archived"]][:limit]}
