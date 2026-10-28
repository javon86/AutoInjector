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
* **A saved book that is already on this computer** (the package's project id is a book in Your books): without a
  ``mode`` nothing is opened and the answer is ``{needs_choice: true, existing, saved}`` — the page asks "⟳ Update the
  one I have" (``mode: "update"``: the book is replaced by the saved one, keeping its id, its books-folder mapping
  and its last-save note; refused while a run works on it) or "📄 Open as a copy" (``mode: "copy"``: a new book, as
  before). The update first opens the package as a checked copy, so a bad package never touches the book you have.
* **Books larger than the upload limit** (``MAX_BODY``, 64 MB) open straight from their place on this computer:
  ``open_path(path)`` takes the book's folder or its ``book.akowe`` (this computer only, up to 512 MB); the path can
  be typed, or chosen in AutoInjector's folder picker (``choose_path``: AutoInjector ``POST /dialog/choose-path``).

Problems carry a problems.js code: OPEN_FAILED, OPEN_BAD_PACKAGE, OPEN_NEWER_VERSION, OPEN_TOO_LARGE, OPEN_NOT_LOCAL,
OPEN_NOT_FOUND, BIBLE_BAD.
"""
from __future__ import annotations

import email.parser
import email.policy
import json
import logging
import os
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


MODES = ("update", "copy")


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
        from .server import MAX_BODY  # noqa: PLC0415
        return {"path": str(base), "exists": base.is_dir(), "folders": out, "max_upload": MAX_BODY}

    def open_folder(self, principal: str, name, mode=None) -> dict:
        self._local()
        f = self._folder(name)
        return self._open_package_file(principal, package_in(f), f"folder “{name}”", mode, label=name)

    def _open_package_file(self, principal: str, pkg: Path, source: str, mode, *, label: str) -> dict:
        name = label
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
        return self.import_bytes(principal, data, source=source, mode=mode)

    # ------------------------------------------------------------------ 📂 straight from a path on this computer
    def open_path(self, principal: str, path, mode=None) -> dict:
        """Open a book from its folder (or its book.akowe) on THIS computer: no upload, so no upload size limit."""
        self._local()
        if not isinstance(path, str) or not path.strip() or len(path) > 1000:
            raise _err("OPEN_NOT_FOUND", "type the full path of the book's folder (or of its book.akowe file)",
                       kernel="MISSING_INPUT", path="/path")
        p = Path(os.path.expandvars(os.path.expanduser(path.strip().strip('"'))))
        try:
            if p.is_dir():
                pkg = package_in(p)
                if not pkg.is_file():
                    has_bible = (p / "Book Bible" / "book-bible.json").is_file()
                    raise _err("OPEN_NOT_FOUND", f"the folder “{p.name}” has no book.akowe"
                               + (" (only its book bible: copy the folder into your books folder and use 🔁 Rerun)"
                                  if has_bible else ""), path="/path")
            elif p.is_file() and p.suffix.lower() in (".akowe", ".bookforge"):
                pkg = p
            else:
                raise _err("OPEN_NOT_FOUND", f"there is no book folder or book.akowe file at “{path.strip()[:200]}”",
                           path="/path")
        except OSError:
            raise _err("OPEN_NOT_FOUND", f"“{path.strip()[:200]}” cannot be read", path="/path") from None
        return self._open_package_file(principal, pkg, f"path “{p.name}”", mode, label=p.name)

    def choose_path(self) -> dict:
        """AutoInjector's folder picker (its window, on this computer) → {path} (or {cancelled: true})."""
        from . import forge  # noqa: PLC0415
        self._local()
        last = None
        for url, token in forge.bridge_targets(self.app):
            try:
                out = forge._post(url, token, {"kind": "book", "title": "Choose the saved book's folder"},  # noqa: SLF001
                                  600.0, route="/dialog/choose-path")
                if out.get("cancelled") or not out.get("path"):
                    return {"cancelled": True}
                return {"path": str(out["path"])[:1000]}
            except forge.ArtProblem as exc:
                last = exc
                if exc.code not in ("IMAGE_BRIDGE_UNREACHABLE", "IMAGE_NOT_WIRED"):
                    break
        if last is not None and last.code == "CANCELLED":
            return {"cancelled": True}
        raise _err("OPEN_FAILED", "AutoInjector's folder picker is not available (AutoInjector is not running or is "
                   "too old): type the folder's path instead", kernel="CAPABILITY_UNAVAILABLE", path="/path")

    # ------------------------------------------------------------------ open a package (new, copy or update)
    def _existing(self, pkg: dict) -> dict | None:
        """The book on this computer the package was saved from, or None."""
        pid = pkg["manifest"].get("project_id")
        row = self.store.project(pid) if isinstance(pid, str) else None
        if row is None:
            return None
        last = self.app.saver.last(pid, "main") or {}
        return {"project_id": pid, "name": row["name"], "saved_at": last.get("at") if last.get("ok") else None,
                "updated_at": self._updated_at(pid)}

    def _updated_at(self, pid: str) -> str | None:
        try:
            r = self.store.query_one("SELECT MAX(created_at) AS m FROM records WHERE project_id=?", (pid,))
            return r["m"] if r else None
        except Exception:  # noqa: BLE001
            return None

    def import_bytes(self, principal: str, data: bytes, source: str = "upload", mode=None) -> dict:
        if mode is not None and mode not in MODES:
            raise AkoweError("INVALID_INPUT", "/mode", "mode: update (replace the book you have) or copy (open as a "
                             "new book)", status="REJECTED")
        try:
            pkg = book_package.read(data)
            existing = self._existing(pkg)
            if existing and mode is None:  # ask first: update the one I have, or open as a copy?
                return {"kind": "choice", "needs_choice": True, "existing": existing,
                        "saved": {"title": pkg["manifest"].get("title") or pkg["manifest"].get("name"),
                                  "saved_at": pkg["manifest"].get("saved_at")},
                        "message": f"“{existing['name']}” is already in Your books on this computer: update it to "
                                   "the saved one, or open the saved one as a copy?"}
            if existing and mode == "update":
                return self._update(principal, data, pkg, existing, source)
            res = book_package.import_package(self.app, data, principal, pkg=pkg)
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
                    saved_at=res["manifest"].get("saved_at"), mode="copy" if existing else "new",
                    message=f"“{res['name']}” is open as a new book (the saved book was not changed).")

    def _update(self, principal: str, data: bytes, pkg: dict, existing: dict, source: str) -> dict:
        """⟳ Update the one I have: the book is replaced by the saved one and keeps its id (so its folder, links and
        the last-save note stay). The package is first opened as a checked copy: a bad package changes nothing."""
        pid = existing["project_id"]
        if not self.store.has_project_access(principal, pid):
            raise AkoweError("PERMISSION_DENIED", "/mode", "you cannot change that book", status="REJECTED")
        for j in self.app.jobstore.list(project_id=pid, limit=50):
            if j.get("status") in ("running", "queued", "waiting", "pausing") or \
                    (j.get("kind") == "autobook" and self.app.autobook.alive(j["id"])):
                raise _err("OPEN_FAILED", f"“{existing['name']}” is being worked on right now (a run or a job): stop "
                           "it first, or open the saved book as a copy", path="/mode")
        if self.app.saver.busy((pid, "main")):
            self.app.saver.wait_idle(30.0)
        trial = book_package.import_package(self.app, data, principal, pkg=pkg, name=f"{existing['name']} (checking)")
        keep = [r for r in self.store.query("SELECT key, value FROM settings WHERE key LIKE 'book_folder:%' OR key "
                                            "LIKE 'book_save:%'") if pid in r["key"]]
        try:
            self.store.delete_project(pid)
            res = book_package.import_package(self.app, data, principal, pkg=book_package.read(data), as_pid=pid,
                                              name=existing["name"])
        except Exception as exc:  # the book you had is gone, the checked copy stays as your book
            log.exception("updating book %s from a saved package failed", pid)
            try:
                with self.store.transaction() as tx:
                    tx.conn.execute("UPDATE projects SET name=? WHERE project_id=?", (existing["name"],
                                                                                    trial["project_id"]))
            except Exception:  # noqa: BLE001
                pass
            raise _err("OPEN_FAILED", "the book could not be updated in place; the saved book is open as a new "
                       f"book instead ({type(exc).__name__})") from None
        with self.store.transaction() as tx:
            for r in keep:
                tx.conn.execute("INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE "
                                "SET value=excluded.value", (r["key"], r["value"], now_iso()))
        try:
            self.store.delete_project(trial["project_id"])
        except Exception:  # noqa: BLE001
            log.exception("could not remove the checked copy %s", trial["project_id"])
        self.app.changed()
        log.info("updated book %s from a saved book (%s)", pid, source)
        return dict(self.opened(pid, res["branch_id"]), kind="package", project_id=pid, branch_id=res["branch_id"],
                    name=res["name"], title=res["title"], saved_at=res["manifest"].get("saved_at"), mode="update",
                    message=f"“{res['name']}” is updated to the saved book (the same book, now as it was saved).")

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
    def upload(self, principal: str, body, headers, mode=None) -> dict:
        ctype = (headers.get("Content-Type") or "application/octet-stream") if headers else "application/octet-stream"
        if isinstance(body, dict):  # a JSON body: a book-bible.json sent as application/json
            return self._bible_upload(body)
        if not isinstance(body, (bytes, bytearray)) or not body:
            raise _err("OPEN_BAD_PACKAGE", "nothing was uploaded", kernel="MISSING_INPUT", path="/body")
        data, name = bytes(body), str((headers.get("X-Filename") if headers else None) or "upload")
        if ctype.split(";")[0].strip().lower() == "multipart/form-data":
            data, name = multipart_file(data, ctype)
        if book_package.is_package(data):
            return self.import_bytes(principal, data, source=f"upload {name[:80]!r}", mode=mode)
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
