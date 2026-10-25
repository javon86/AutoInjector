"""📂 Open a saved book / 🔁 rerun from the book bible (P21).

* ``folders()`` lists the book folders Akọwe can read in the books folder (only on the computer Akọwe runs
  on: the request must come from this computer, ``App.is_local``).
* ``open_folder(name)`` / ``upload(...)`` open a ``book.akowe`` package as a NEW book (book_package.import_package);
  an uploaded ``book-bible.json`` (or one in a folder) is checked (book_bible.clean) and kept for the 🔁 rerun dialog
  (settings ``bible_upload:<id>``, the newest ``KEEP_UPLOADS``).
* ``resolve_bible(spec)`` gives the bible a 🔁 rerun starts from: ``{project_id}`` (built from a book in this
  Akọwe), ``{folder}`` (its ``Book Bible/book-bible.json``) or ``{bible_id}`` (uploaded).
* ``opened(pid)``: what the book page offers for an opened book (an imported run that can be resumed, whether the
  book is finished).

Problems carry a problems.js code: OPEN_FAILED, OPEN_BAD_PACKAGE, OPEN_NEWER_VERSION, OPEN_TOO_LARGE, OPEN_NOT_LOCAL,
OPEN_NOT_FOUND, BIBLE_BAD.
"""
from __future__ import annotations

import email.parser
import email.policy
import json
import logging
import re
import uuid
from pathlib import Path

from . import book_bible
from . import book_package
from .book_save import package_in, problem_error, read_marker
from .errors import AkoweError
from .jobs import now_iso

log = logging.getLogger("akowe.book_open")

KEEP_UPLOADS = 5
MAX_FOLDERS = 500
FOLDER_RE = re.compile(r"^[^/\\:*?\"<>|\x00-\x1f]{1,180}$")
FIX = {
    "OPEN_BAD_PACKAGE": "Use the book.akowe file exactly as Akọwe saved it (copy the whole book folder again "
                        "from where it was saved), then try again.",
    "OPEN_NEWER_VERSION": "Update Akọwe on this computer to the newest version, then open the book again.",
    "OPEN_TOO_LARGE": "Copy the book's whole folder into your books folder (Settings › 📁 Where books are saved) and "
                      "open it from the list instead of uploading it.",
    "OPEN_NOT_LOCAL": "Do this on the computer Akọwe runs on, or upload the book.akowe file instead.",
    "OPEN_NOT_FOUND": "Press 🔄 Refresh: the folder may have been moved or renamed. Check Settings › 📁 Where books are "
                      "saved.",
    "OPEN_FAILED": "Press 📂 Open a saved book and try again. If it keeps failing, press 📋 Copy diagnostics.",
    "BIBLE_BAD": "Use a book-bible.json saved by Akọwe (Book Bible folder). If you edited it, check that it is "
                 "still valid JSON (a missing comma or quote breaks it).",
}


def _err(code: str, message: str, *, kernel: str = "INVALID_INPUT", path: str = "") -> AkoweError:
    exc = problem_error(code, message, kernel=kernel, path=path)
    exc.errors[0]["fix"] = FIX.get(code) or exc.errors[0].get("fix")
    return exc


def multipart_file(body: bytes, content_type: str) -> tuple[bytes, str]:
    """The first file part of a multipart/form-data body: (bytes, file name)."""
    msg = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(
        b"Content-Type: " + content_type.encode("latin-1") + b"\r\nMIME-Version: 1.0\r\n\r\n" + body)
    if not msg.is_multipart():
        raise _err("OPEN_BAD_PACKAGE", "the upload could not be read (no file in it)")
    for part in msg.iter_parts():
        name = part.get_filename()
        data = part.get_payload(decode=True)
        if data is not None and (name or part.get_param("name", header="content-disposition") == "file"):
            return data, str(name or "upload")
    raise _err("OPEN_BAD_PACKAGE", "the upload has no file in it")


class OpenService:
    def __init__(self, app):
        self.app = app
        self.store = app.store

    def _local(self):
        if not self.app.is_local():
            raise _err("OPEN_NOT_LOCAL", "the books folder can only be listed and opened on the computer Akọwe "
                       "runs on", kernel="PERMISSION_DENIED")

    def _folder(self, name) -> Path:
        if not isinstance(name, str) or not FOLDER_RE.match(name) or name in (".", "..") or name.strip() != name:
            raise _err("OPEN_NOT_FOUND", "that is not a folder name in your books folder", path="/folder")
        base = self.app.saver.base()
        f = base / name
        try:
            if f.resolve().parent != base.resolve() or not f.is_dir():
                raise _err("OPEN_NOT_FOUND", f"there is no folder “{name}” in your books folder", path="/folder")
        except OSError:
            raise _err("OPEN_NOT_FOUND", f"the folder “{name}” cannot be read", path="/folder") from None
        return f

    # ------------------------------------------------------------------ the books folder list
    def folders(self) -> dict:
        self._local()
        base = self.app.saver.base()
        out = []
        if base.is_dir():
            try:
                entries = sorted((p for p in base.iterdir() if p.is_dir()), key=lambda p: p.name.lower())
            except OSError as exc:
                raise _err("OPEN_FAILED", f"the books folder cannot be read ({type(exc).__name__})") from None
            for p in entries[:MAX_FOLDERS]:
                pkg = package_in(p)  # book.akowe, or the book.bookforge of a save made before the rename
                has_pkg = pkg.is_file()
                has_bible = (p / "Book Bible" / "book-bible.json").is_file()
                if not has_pkg and not has_bible:
                    continue
                mk = {}
                try:
                    mk = read_marker(p)
                except (OSError, ValueError):
                    mk = {}
                mk = mk if isinstance(mk, dict) else {}
                pid = mk.get("project_id") if isinstance(mk.get("project_id"), str) else None
                try:
                    size = pkg.stat().st_size if has_pkg else 0
                except OSError:
                    size = 0
                out.append({"name": p.name, "title": str(mk.get("title") or p.name)[:200],
                            "saved_at": mk.get("saved_at"), "finished": mk.get("finished"),
                            "chapters": mk.get("chapters"), "exports": mk.get("exports"),
                            "has_package": has_pkg, "has_bible": has_bible, "bytes": size,
                            "in_library": bool(pid and self.store.project(pid) is not None)})
        out.sort(key=lambda x: x.get("saved_at") or "", reverse=True)
        return {"path": str(base), "exists": base.is_dir(), "folders": out}

    def open_folder(self, principal: str, name) -> dict:
        self._local()
        f = self._folder(name)
        pkg = package_in(f)
        if not pkg.is_file():
            raise _err("OPEN_NOT_FOUND", f"the folder “{name}” has no book.akowe (only its book bible): use 🔁 "
                       "Rerun from the book bible instead", path="/folder")
        try:
            size = pkg.stat().st_size
            if size > book_package.MAX_PACKAGE_BYTES:
                raise _err("OPEN_TOO_LARGE", "this book package is larger than 512 MB")
            data = pkg.read_bytes()
        except OSError as exc:
            raise _err("OPEN_FAILED", f"book.akowe cannot be read ({type(exc).__name__})") from None
        return self.import_bytes(principal, data, source=f"folder “{name}”")

    def import_bytes(self, principal: str, data: bytes, source: str = "upload") -> dict:
        try:
            res = book_package.import_package(self.app, data, principal)
        except book_package.PackageProblem as exc:
            raise _err(exc.code, exc.message) from None
        except AkoweError:
            raise
        except Exception as exc:  # noqa: BLE001
            log.exception("opening a book package failed")
            raise _err("OPEN_FAILED", f"the book could not be opened ({type(exc).__name__})") from None
        self.app.changed()
        log.info("opened a saved book from %s as %s", source, res["project_id"])
        return dict(self.opened(res["project_id"], res["branch_id"]), kind="package", project_id=res["project_id"],
                    branch_id=res["branch_id"], name=res["name"], title=res["title"],
                    saved_at=res["manifest"].get("saved_at"),
                    message=f"“{res['name']}” is open as a new book (the saved book was not changed).")

    def opened(self, pid: str, branch: str = "main") -> dict:
        """For an opened book: is it finished, and is there an imported run that can be resumed?"""
        resumable = None
        for j in self.app.jobstore.list(project_id=pid, kind="autobook", limit=20):
            if j.get("status") in ("interrupted", "paused") and not self.app.autobook.alive(j["id"]):
                resumable = {"id": j["id"], "status": j.get("status"), "phase": j.get("phase")}
                break
        try:
            from .book_path import BookPath  # noqa: PLC0415
            st = BookPath(self.app.engine, self.app.principal_id, pid, branch).status()
            finished = st.get("next") is None
            nxt = next((s["title"] for s in st["steps"] if s["id"] == st.get("next")), None)
        except Exception:  # noqa: BLE001
            finished, nxt = None, None
        return {"finished": finished, "next_step": nxt, "resumable_run": resumable}

    # ------------------------------------------------------------------ uploads
    def upload(self, principal: str, body, headers) -> dict:
        ctype = (headers.get("Content-Type") or "application/octet-stream") if headers else "application/octet-stream"
        if isinstance(body, dict):  # a JSON body: a book-bible.json sent as application/json
            return self._bible_upload(body)
        if not isinstance(body, (bytes, bytearray)) or not body:
            raise _err("OPEN_BAD_PACKAGE", "nothing was uploaded", kernel="MISSING_INPUT", path="/body")
        data, name = bytes(body), str((headers.get("X-Filename") if headers else None) or "upload")
        if ctype.split(";")[0].strip().lower() == "multipart/form-data":
            data, name = multipart_file(data, ctype)
        if book_package.is_package(data):
            return self.import_bytes(principal, data, source=f"upload {name[:80]!r}")
        if data[:3] == b"\xef\xbb\xbf" or data.lstrip()[:1] == b"{":
            return self._bible_upload(data)
        raise _err("OPEN_BAD_PACKAGE", "this file is neither an Akọwe book (book.akowe) nor a book bible "
                   "(book-bible.json)")

    def _bible_upload(self, raw) -> dict:
        try:
            bible = book_bible.clean(raw)
        except book_bible.BibleProblem as exc:
            raise _err(exc.code, exc.message) from None
        bid = self.stash(bible)
        return {"kind": "bible", "bible_id": bid, "summary": book_bible.summary(bible),
                "message": "The book bible is ready: press 🔁 Make a new book from it."}

    def stash(self, bible: dict) -> str:
        bid = f"bible-{uuid.uuid4().hex[:12]}"
        self.store.set_setting(f"bible_upload:{bid}", {"at": now_iso(), "bible": bible})
        rows = self.store.query("SELECT key, updated_at FROM settings WHERE key LIKE 'bible_upload:%' ORDER BY "
                                "updated_at DESC")
        with self.store.transaction() as tx:
            for r in rows[KEEP_UPLOADS:]:
                tx.execute("DELETE FROM settings WHERE key=?", (r["key"],))
        return bid

    def folder_bible(self, name) -> dict:
        self._local()
        f = self._folder(name)
        p = f / "Book Bible" / "book-bible.json"
        try:
            raw = p.read_bytes()
        except OSError:
            raise _err("OPEN_NOT_FOUND", f"the folder “{name}” has no Book Bible/book-bible.json", path="/folder") \
                from None
        try:
            return book_bible.clean(raw)
        except book_bible.BibleProblem as exc:
            raise _err(exc.code, exc.message, path="/folder") from None

    # ------------------------------------------------------------------ 🔁 rerun
    def resolve_bible(self, principal: str, spec) -> tuple[dict, str]:
        """(cleaned bible, where it came from) for ``{project_id[, branch_id]}``, ``{folder}`` or ``{bible_id}``."""
        if not isinstance(spec, dict):
            raise AkoweError("INVALID_INPUT", "/from_bible", "from_bible: {project_id}, {folder} or {bible_id}",
                                 status="REJECTED")
        if spec.get("project_id"):
            pid = spec["project_id"]
            branch = spec.get("branch_id") or "main"
            if not isinstance(pid, str) or self.store.project(pid) is None or \
                    not self.store.has_project_access(principal, pid):
                raise AkoweError("NOT_FOUND", "/from_bible/project_id", "that book does not exist",
                                     status="REJECTED")
            raw = book_bible.build(self.app, pid, branch)
            try:
                return book_bible.clean(json.loads(json.dumps(raw))), f"the book “{raw['profile'].get('title')}”"
            except book_bible.BibleProblem as exc:
                raise _err(exc.code, f"this book cannot be made again yet: {exc.message}") from None
        if spec.get("folder"):
            b = self.folder_bible(spec["folder"])
            return b, f"the saved folder “{spec['folder']}”"
        if spec.get("bible_id"):
            bid = spec["bible_id"]
            v = self.store.get_setting(f"bible_upload:{bid}") if isinstance(bid, str) and len(bid) < 80 else None
            if not isinstance(v, dict) or not isinstance(v.get("bible"), dict):
                raise _err("OPEN_NOT_FOUND", "this uploaded book bible is not here any more: upload it again",
                           path="/from_bible/bible_id")
            return v["bible"], "an uploaded book bible"
        raise AkoweError("INVALID_INPUT", "/from_bible", "from_bible: {project_id}, {folder} or {bible_id}",
                             status="REJECTED")
