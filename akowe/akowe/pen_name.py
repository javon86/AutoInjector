"""✒️ The author's pen name: only ever what the author typed, never a name an AI invented.

The pen name printed on a book's title page, cover and metadata is the book profile's ``author``. Where it comes from:

* what the author typed — the Book profile's "Author or pen name" field, or the ⚡ Make-a-book "Pen name" field
  (``pen_name`` in the start body);
* else the author's **saved pen name** (``author_profile`` setting): the last pen name the author typed into a book
  profile (``remember``), used for every new book;
* else nothing (empty): Akọwe never asks an AI to invent one. (Before this, the ⚡ "invent the book" step asked the
  AI for "an invented pen name"; a web AI whose chat still held the author's other book answered with that book's
  main character, which then went onto the title page.)

``clash`` / ``warning``: a pen name that is also the name of a character — in this book or in another book on the
shelf — is almost certainly a mix-up; the ⚡ plan check (the estimate before Start), the run and the profile page warn.
Deterministic, no AI; never raises (a warning is a help, never a reason to fail).
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone

log = logging.getLogger("akowe.pen_name")

SETTING = "author_profile"
MAX = 200


def clean(v) -> str:
    """One line of at most MAX characters ('' for anything that is not text)."""
    if not isinstance(v, str):
        return ""
    return " ".join(v.split())[:MAX]


def saved(store) -> str:
    """The author's saved pen name ('' when none)."""
    try:
        cur = store.get_setting(SETTING) or {}
    except Exception:  # noqa: BLE001
        return ""
    return clean(cur.get("pen_name")) if isinstance(cur, dict) else ""


def remember(store, name) -> None:
    """Keep the pen name the author typed as their saved pen name (an empty name changes nothing)."""
    name = clean(name)
    if not name:
        return
    try:
        store.set_setting(SETTING, {"pen_name": name, "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
    except Exception:  # noqa: BLE001 - a convenience, never a reason to fail a save
        log.exception("could not save the pen name")


def for_new_book(store, typed=None) -> tuple[str, str]:
    """(pen name, where it came from: 'typed' | 'saved' | '') for a new book."""
    t = clean(typed)
    if t:
        return t, "typed"
    s = saved(store)
    return (s, "saved") if s else ("", "")


def _norm(s) -> str:
    return " ".join(re.sub(r"[^\w\s'-]", " ", str(s or "").lower()).replace("_", " ").split())


def _books(store):
    try:
        rows = store.query("SELECT DISTINCT h.project_id, h.branch_id FROM heads h")
    except Exception:  # noqa: BLE001
        log.exception("could not list the books")
        return []
    return [(r["project_id"], r["branch_id"]) for r in rows]


def _names(store, pid, branch) -> list[str]:
    from . import characters as chars_mod  # noqa: PLC0415
    from . import story_roles  # noqa: PLC0415
    out = []
    for c in chars_mod.canon_characters(store, pid, branch):
        nm = c.get("name") or ""
        out += [nm] if nm else []
        out += [n for n in story_roles.names_of(c) if n != nm]
    return out


def _same(pen: str, name: str) -> bool:
    a, b = _norm(pen), _norm(name)
    if not a or not b or len(b) < 3:
        return False
    if a == b:
        return True
    # "Odile Harrow" vs a character named "Odile Harrow-Vance" / "Captain Odile Harrow": the full name inside it
    wa, wb = a.split(), b.split()
    if len(wa) >= 2 and len(wb) >= 2:
        short, long_ = (wa, wb) if len(wa) <= len(wb) else (wb, wa)
        return any(long_[i:i + len(short)] == short for i in range(len(long_) - len(short) + 1))
    return False


def clash(store, pid, name) -> dict | None:
    """The character whose name the pen name is ({character, title, project_id, same_book}), this book first."""
    pen = clean(name)
    if not pen:
        return None
    try:
        from .book_path import get_profile  # noqa: PLC0415
        books = _books(store)
        books.sort(key=lambda b: b[0] != pid)  # this book first
        for bpid, branch in books:
            for n in _names(store, bpid, branch):
                if _same(pen, n):
                    proj = store.project(bpid) or {}
                    title = get_profile(store, bpid).get("title") or (proj["name"] if proj else "") or "a book"
                    return {"character": n, "title": title, "project_id": bpid, "same_book": bpid == pid}
    except Exception:  # noqa: BLE001 - a warning is a help, never a reason to fail
        log.exception("could not compare the pen name with the characters")
    return None


def warning(store, pid, name) -> str | None:
    """Plain words when the pen name is also a character's name, else None."""
    c = clash(store, pid, name)
    if not c:
        return None
    where = "this book" if c["same_book"] else f"your other book “{c['title']}”"
    return (f"⚠️ The pen name “{clean(name)}” is also the name of a character in {where} ({c['character']}). A pen "
            "name is the author's name printed on the title page and cover: type your own pen name (Book profile → "
            "Author or pen name).")
