"""🎨 The Book format page's interior design: choose a theme and a trim size, and see a print preview.

``GET  /api/projects/:pid/branches/:b/interior`` → {options, chosen, preview} (``?theme=&trim=&font=`` previews a choice
before it is saved; ``?render=svg`` forces the browser-drawn preview);
``PUT  /api/projects/:pid/branches/:b/interior`` {interior_theme, trim_size, interior_font} saves the choice in the book
profile ("" = the default: the genre's look, 6 x 9 in, the theme's font).

The design itself lives in ``exporters/interior.py``; the PDF/EPUB/Word files use it from the next "put the book
together" (a new trim size also makes the book format again: the page size is part of it).
"""
from __future__ import annotations

from .book_path import BookPath, get_profile, save_profile
from .errors import AkoweError
from .exporters import interior

_REJ = {"status": "REJECTED"}


def _first_chapter(app, principal: str, pid: str, branch: str) -> str | None:
    """The book's first approved (else newest) chapter text, for a preview with the author's own words."""
    try:
        bp = BookPath(app.engine, principal, pid, branch)
        outline = bp.outline()
        if not outline:
            return None
        for ch in bp.outline_chapters(outline)[:1]:
            _ctx, latest, appr = bp.chapter_prose(outline, ch["chapter_id"])
            rec = appr or latest
            text = ((rec or {}).get("data") or {}).get("text")
            if isinstance(text, str) and len(text.split()) > 60:
                return text
    except Exception:  # noqa: BLE001 - a preview falls back to the sample text
        return None
    return None


def _q(query: dict, key: str) -> str | None:
    v = (query.get(key) or [None])[0]
    return v if v not in (None, "") else None


def state(app, principal: str, pid: str, branch: str, query: dict | None = None) -> dict:
    query = query or {}
    prof = get_profile(app.store, pid)
    c = interior.chosen(prof)
    theme = _q(query, "theme") or c["theme"]
    trim = _q(query, "trim") or c["trim"]
    font = _q(query, "font") or (c["font_stored"] if theme == c["theme"] else None)
    if theme not in interior.THEMES or trim not in interior.TRIMS or (font and font not in interior.FONTS):
        raise AkoweError("INVALID_INPUT", "/interior", "theme, trim or font is not one of the choices", **_REJ)
    render = _q(query, "render") or "auto"
    title = prof.get("title") or (app.store.project(pid) or {"name": "Your book"})["name"] or "Your book"
    meta = {"title": title, "author": prof.get("author") or "", "language": "en"}
    text = _first_chapter(app, principal, pid, branch)
    try:
        pv = interior.preview(theme, trim, meta, text, font=font, render=render)
        pv["source"] = "your first chapter" if text else "a sample page (your first chapter is used once it exists)"
    except Exception as exc:  # noqa: BLE001 - the choice still works without a picture
        pv = {"kind": "none", "spreads": [], "honest": f"The preview could not be drawn ({type(exc).__name__})."}
    return {"options": interior.options(), "chosen": c, "preview": pv,
            "showing": {"theme": theme, "trim": trim, "font": font or interior.THEMES[theme]["body"]}}


def save(app, pid: str, body) -> dict:
    if not isinstance(body, dict):
        raise AkoweError("INVALID_INPUT", "", "send {interior_theme, trim_size, interior_font}", **_REJ)
    clean = {k: body[k] for k in ("interior_theme", "trim_size", "interior_font") if k in body}
    prof = save_profile(app.store, pid, clean)
    return {"ok": True, "chosen": interior.chosen(prof),
            "message": "Saved. The new design is used the next time the book is put together (a new page size also "
                       "makes the book format again)."}


def route(app, method: str, rest: list, query: dict, body, principal: str, pid: str, branch: str):
    if rest == [] and method == "GET":
        return 200, state(app, principal, pid, branch, query)
    if rest == [] and method == "PUT":
        return 200, save(app, pid, body)
    raise AkoweError("NOT_FOUND", "/interior", "unknown interior design request", **_REJ)
