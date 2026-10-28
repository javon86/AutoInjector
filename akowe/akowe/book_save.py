"""💾 Save the book (P20): one folder per book in the author's books folder.

The books folder (Settings › 📁 Where books are saved, settings key ``books_folder`` = {path, auto_save}) defaults to
``Documents\\Akowe Books`` on Windows (``%USERPROFILE%\\Documents``) and ``~/Akowe Books`` elsewhere
(``AKOWE_BOOKS_DIR`` overrides the default; ``AKOWE_AUTOSAVE=0`` makes auto-save default to off — the test suite
uses both). Each book gets ONE folder, named once as ``<Book title> (<short id>)`` and remembered in the settings key
``book_folder:<pid>:<branch>``: later saves (and a new title) keep using it. Inside (see ``README_TEXT``):

    Book/          the latest exports (PDF, EPUB, DOCX) with readable names, copied from the verified stored files
    Chapters/      01 - <title>.md … (the approved text, or the newest draft marked DRAFT)
    Book Bible/    book-bible.json (book_bible.build) + book-bible.md
    Reports/       Book report.md/.pdf (latest), Editor summary.md, Planned to page.md, Continuity.md
    Character Forge/  <code> <name> - dossier.pdf/.json per saved dossier (characters, items, places, magic
                      systems) + its pictures and motion clip (B5)
    Pictures/      pictures.json + the chosen chapter / scene pictures (chNN … .png/.jpg) and map.svg/.png (B3)
    Trailer/       trailer.webm (+ trailer.mp4) and trailer.json, the book trailer and its plan (B2, trailer.py)
    Log/           Book journal.md (journal.py) + run-events.json (runs: steps, states, AI per step, times, problems)
    Progress/      progress.json (book steps, next step, the run's state)
    book.akowe the complete re-importable package (book_package.py)
    README.txt     what all this is, in plain words
    .akowe-folder.json   Akọwe's marker (which book, which files it wrote: only those are ever replaced)

Every file is written atomically (a temp file in the same folder, then renamed over the old one); a file whose bytes
did not change is not rewritten. A file Akọwe wrote earlier that is no longer part of the save (a renamed chapter)
is removed — nothing else in the folder is ever touched. Windows rules: names never hold ``<>:"/\\|?*``, control
characters, trailing dots/spaces or reserved names (CON, PRN, AUX, NUL, COM1-9, LPT1-9), titles are shortened so every
full path stays at most ``MAX_PATH`` (200) characters.

Saves never block or fail a run: ``auto()`` returns at once (the save runs in its own thread) and a failure is only a
⚠️ on the book page / run window (``book_save:<pid>:<branch>`` = the last save: at, ok, path, problem). Automatic
saves (on by default): after each step of a Make-a-book run and after chapter approvals at most once per
``interval_s`` (120 s; the last change is saved when the interval is over), and at once when a run finishes, pauses,
is cancelled or stops on a problem, and for runs found interrupted at start-up. And every ``PERIODIC_S`` (10 minutes)
a quiet check (``periodic_tick``) saves every book whose state changed since its last save (``fingerprint``: its
records, approvals, module state and its own settings — the dossiers, cover, pictures, profile), so work done by hand
(no run) is saved too; an unchanged book is not touched.

Nothing secret is written: keys and the access token are not in the database, and every text file is checked against
the saved secrets (``book_package.guard``); the journal and run events never hold prompts or AI replies.
"""
from __future__ import annotations

import errno
import hashlib
import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

from . import __version__, legacy
from . import book_bible
from . import book_package
from . import journal as journal_mod
from .book_path import EXPORT_FOR, BookPath, get_profile
from .errors import AkoweError
from .jobs import now_iso
from .store import _flush_failed, _windows, replace_file, tmp_name

log = logging.getLogger("akowe.book_save")

SETTINGS_KEY = "books_folder"
MAX_PATH = 200
INTERVAL_S = 120
PERIODIC_S = 600          # 💾 the quiet "every 10 minutes when the book changed" save
MARKER = ".akowe-folder.json"
PACKAGE = "book.akowe"
FOLDER_SCHEMA = 1
RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
BAD_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f\x7f]+')
EXT = {"PDF": "pdf", "EPUB": "epub", "DOCX": "docx"}
FIX = {
    "SAVE_FOLDER_NOT_WRITABLE": "Choose another folder in Settings › 📁 Where books are saved (for example your "
                                "Documents folder), or check that the folder still exists and is not read-only, then "
                                "press 💾 Save again.",
    "SAVE_DISK_FULL": "Free some space on the disk (empty the Recycle Bin, delete large files you do not need), or "
                      "choose a books folder on another disk in Settings, then press 💾 Save again.",
    "SAVE_PATH_TOO_LONG": "Choose a books folder with a shorter path in Settings › 📁 Where books are saved (for "
                          "example C:\\Books), then press 💾 Save again.",
    "SAVE_FAILED": "Press 💾 Save again. If it keeps failing, press 📋 Copy diagnostics and send it to the developer.",
    "OPEN_NOT_LOCAL": "Do this on the computer Akọwe runs on, or copy the folder path and open it there.",
}
README_TEXT = """\
This folder holds one book made with Akọwe: {title}
Saved: {saved} (UTC) by Akọwe {version}{state}

What is in here
---------------
Book/          The finished book: PDF (to print or read), EPUB (e-readers) and DOCX (Word, to edit).
               Only there once the book has been exported.
Chapters/      Every chapter as a text file you can open with any editor (Markdown).
               A chapter that is not approved yet says DRAFT at the top.
Book Bible/    Everything the book is built on: the book profile, ending and style choices,
               characters (with their character sheets and voice cards), places and world,
               premise, main plot, chapter outline, scene cards, story rules and world texture.
               book-bible.md is for reading; book-bible.json is what Akọwe reads back.
Reports/       The book report (scores, strengths, weaknesses) and the editor's and
               planned-to-page summaries, when they exist.
Character Forge/  Each dossier (characters, items, places, magic systems: PDF to read, JSON for Akọwe), its pictures
                  and motion clip.
Pictures/      The chapter and scene pictures and the map you chose (🖼 Pictures), with
               pictures.json (captions, alt text and where each one goes in the book).
Trailer/       The book trailer (🎞 Trailer): trailer.webm, trailer.mp4 when AutoInjector
               could make one, and trailer.json (its shots and title cards).
Log/           The book's journal (what happened, step by step, which AI did what) and
               run-events.json (every step of the Make-a-book run). No keys, no prompts.
Progress/      progress.json: what is done and what comes next (for an unfinished book).
book.akowe The whole book in one file (every version, every file, with checksums).

How to open it again
--------------------
In Akọwe press "📂 Open a saved book" and pick this folder (or upload book.akowe).
It opens as a NEW book; the book you had is never overwritten. An unfinished book
can be continued from where it stopped.

How to make the book again
--------------------------
Press "🔁 Rerun from the book bible": Akọwe makes a new book with the same
characters, world and plan, and writes new chapters.

Akọwe only replaces the files it wrote itself. Your own files in this folder are never touched.
"""


class SaveProblem(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message

    def as_dict(self) -> dict:
        return {"code": self.code, "message": self.message, "fix": FIX.get(self.code, FIX["SAVE_FAILED"])}


def problem_error(code: str, message: str, *, kernel: str = "INVALID_INPUT", path: str = "") -> AkoweError:
    """A refusal the API sends with a kernel error code plus the plain problems.js code and its fix."""
    exc = AkoweError(kernel, path, message, status="REJECTED")
    exc.errors[0]["problem"] = code
    exc.errors[0]["fix"] = FIX.get(code) or exc.errors[0].get("fix")
    return exc


# ====================================================================== names and paths
def package_in(folder: Path) -> Path:
    """The book package of a book folder: book.akowe, or book.bookforge when only that one exists (saved before the
    rename; the next save writes book.akowe and removes the old one)."""
    new = folder / PACKAGE
    if not new.is_file() and (folder / legacy.OLD_PACKAGE).is_file():
        return folder / legacy.OLD_PACKAGE
    return new


def read_marker(folder: Path):
    """The folder's marker (.akowe-folder.json, or the .bookforge-folder.json of a save made before the rename)."""
    for name in (MARKER, legacy.OLD_MARKER):
        try:
            return json.loads((folder / name).read_text(encoding="utf-8"))
        except FileNotFoundError:
            continue
    raise FileNotFoundError(str(folder / MARKER))


def default_folder(windows: bool | None = None) -> Path:
    env = legacy.env("BOOKS_DIR")
    if env:
        return Path(env)
    if (os.name == "nt") if windows is None else windows:
        up = os.environ.get("USERPROFILE")
        if up and (Path(up) / "Documents").is_dir():
            return legacy.default_books_folder(Path(up) / "Documents" / "Akowe Books")
    return legacy.default_books_folder(Path.home() / "Akowe Books")  # keeps an existing "BookForge Books" folder


def autosave_default() -> bool:
    return legacy.env("AUTOSAVE", "1") not in ("0", "false", "no", "off")


def safe_name(text, cap: int = 60, fallback: str = "Book") -> str:
    """A file or folder name every system accepts (Windows rules), at most ``cap`` characters."""
    t = BAD_CHARS.sub(" ", str(text or ""))
    t = " ".join(t.split()).strip(" .")
    if len(t) > cap:
        t = t[:cap].rstrip(" .")
    if not t:
        t = fallback
    if t.split(".", 1)[0].upper().strip() in RESERVED:
        t = "_" + t
    return t


def short_id(pid: str) -> str:
    tail = re.sub(r"[^A-Za-z0-9]", "", pid or "")[-6:]
    return tail.lower() or hashlib.sha256((pid or "").encode()).hexdigest()[:6]


def classify(exc: BaseException) -> SaveProblem:
    if isinstance(exc, SaveProblem):
        return exc
    if isinstance(exc, OSError):
        no = exc.errno
        win = getattr(exc, "winerror", None)
        if no in (errno.ENOSPC, getattr(errno, "EDQUOT", -1)) or win in (39, 112):
            return SaveProblem("SAVE_DISK_FULL", "the disk is full: the book could not be saved")
        if no == errno.ENAMETOOLONG or win == 206:
            return SaveProblem("SAVE_PATH_TOO_LONG", "a file name in the book's folder is too long for this computer")
        if no in (errno.EACCES, errno.EPERM, errno.EROFS, errno.ENOENT, errno.ENOTDIR) or win in (5, 3):
            return SaveProblem("SAVE_FOLDER_NOT_WRITABLE", f"Akọwe may not write into the books folder "
                               f"({type(exc).__name__})")
        return SaveProblem("SAVE_FAILED", f"the book could not be saved ({type(exc).__name__})")
    if isinstance(exc, AkoweError):
        return SaveProblem("SAVE_FAILED", f"the book could not be read for saving ({exc.code}: "
                           f"{(exc.errors[0].get('message') if exc.errors else '')[:160]})")
    return SaveProblem("SAVE_FAILED", f"the book could not be saved ({type(exc).__name__})")


def write_atomic(path: Path, data: bytes) -> bool:
    """Write ``data`` to ``path`` atomically (temp file in the same folder, flush, rename). False when the file already
    had exactly these bytes (nothing written)."""
    try:
        if path.is_file() and path.stat().st_size == len(data) and path.read_bytes() == data:
            return False
    except OSError:
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = tmp_name(path)
    try:
        with open(tmp, "xb") as fh:
            fh.write(data)
            fh.flush()
            try:
                os.fsync(fh.fileno())
            except OSError as exc:
                if not _windows():
                    raise
                _flush_failed(tmp, exc)
        replace_file(tmp, path)
    except BaseException:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    return True


def check_folder(path: Path) -> SaveProblem | None:
    """Can Akọwe write into this books folder (made when missing)? Also: is the path short enough?"""
    if not path.is_absolute():
        return SaveProblem("SAVE_FOLDER_NOT_WRITABLE", "the books folder must be a full path (for example "
                           "C:\\Users\\You\\Documents\\Akowe Books)")
    if len(str(path)) > MAX_PATH - 60:
        return SaveProblem("SAVE_PATH_TOO_LONG", f"the books folder's path is {len(str(path))} characters long; with "
                           f"the book's own folder and file names it would go over {MAX_PATH}")
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / f".akowe-write-test-{uuid.uuid4().hex[:8]}"
        probe.write_bytes(b"ok")
        probe.unlink()
    except OSError as exc:
        return classify(exc)
    return None


def name_of(mapped) -> str | None:
    return mapped.get("name") if isinstance(mapped, dict) else None


def launch(path: Path):
    """Show a folder in the computer's file manager (Explorer / Finder / the desktop's file manager)."""
    if os.name == "nt":
        os.startfile(str(path))  # type: ignore[attr-defined]  # noqa: S606 - a folder path Akọwe made
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)  # noqa: S603,S607
    else:
        subprocess.Popen(["xdg-open", str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)  # noqa: S603,S607


# ====================================================================== the service
class SaveService:
    def __init__(self, app):
        self.app = app
        self.store = app.store
        self.interval_s = INTERVAL_S
        self.periodic_s = PERIODIC_S
        self._ticker: threading.Thread | None = None
        self._stop_ticker = threading.Event()
        self._lock = threading.RLock()
        self._threads: dict[tuple, threading.Thread] = {}
        self._jobs: dict[tuple, dict] = {}
        self._timers: dict[tuple, threading.Timer] = {}
        self._last: dict[tuple, float] = {}
        self._again: dict[tuple, dict] = {}
        self.count: dict[tuple, int] = {}
        self.launch = launch  # tests replace it

    # ------------------------------------------------------------------ settings
    def settings(self) -> dict:
        cur = self.store.get_setting(SETTINGS_KEY) or {}
        cur = cur if isinstance(cur, dict) else {}
        dflt = default_folder()
        path = cur.get("path") or str(dflt)
        return {"path": path, "default_path": str(dflt), "custom": bool(cur.get("path")),
                "auto_save": bool(cur.get("auto_save", autosave_default())), "interval_s": self.interval_s,
                "periodic_s": self.periodic_s, "max_path": MAX_PATH}

    def base(self) -> Path:
        return Path(self.settings()["path"])

    def auto_on(self) -> bool:
        try:
            return self.settings()["auto_save"]
        except Exception:  # noqa: BLE001
            return False

    def save_settings(self, body) -> dict:
        body = body if isinstance(body, dict) else {}
        cur = self.store.get_setting(SETTINGS_KEY) or {}
        cur = dict(cur) if isinstance(cur, dict) else {}
        if "auto_save" in body:
            if not isinstance(body["auto_save"], bool):
                raise AkoweError("INVALID_INPUT", "/auto_save", "auto_save must be true or false",
                                     status="REJECTED")
            cur["auto_save"] = body["auto_save"]
        if "path" in body:
            p = body["path"]
            if p in (None, ""):
                cur.pop("path", None)  # back to the default folder
                target = default_folder()
            else:
                if not isinstance(p, str) or len(p) > 400:
                    raise AkoweError("INVALID_INPUT", "/path", "the folder must be a path (text)", status="REJECTED")
                target = Path(os.path.expandvars(os.path.expanduser(p.strip())))
            prob = check_folder(target)
            if prob:
                raise problem_error(prob.code, prob.message, path="/path")
            if p not in (None, ""):
                cur["path"] = str(target)
        self.store.set_setting(SETTINGS_KEY, cur)
        return dict(self.settings(), writable=True)

    def check(self) -> dict:
        """The settings plus whether the books folder can be written now (Settings card)."""
        out = self.settings()
        prob = check_folder(Path(out["path"]))
        out["writable"] = prob is None
        out["problem"] = prob.as_dict() if prob else None
        return out

    # ------------------------------------------------------------------ the book's folder
    def _map_key(self, pid, branch):
        return f"book_folder:{pid}:{branch}"

    def folder_name(self, pid: str, branch: str, title: str, cap: int = 60) -> str:
        tail = short_id(pid) + ("" if branch == "main" else f", {safe_name(branch, 20)}")
        return f"{safe_name(title, cap, 'Book')} ({tail})"

    def _owner_of(self, folder: Path) -> str | None:
        try:
            m = read_marker(folder)
            return m.get("project_id") if isinstance(m, dict) else None
        except (OSError, ValueError):
            return None

    def book_folder(self, pid: str, branch: str = "main", *, create: bool = False) -> Path:
        """The book's folder (named once, then kept: a new title does not move it)."""
        base = self.base()
        mapped = self.store.get_setting(self._map_key(pid, branch))
        name = mapped.get("name") if isinstance(mapped, dict) else None
        if name:
            f = base / name
            owner = self._owner_of(f) if f.exists() else None
            if owner in (None, pid):
                return f  # the folder it was given the first time (a new title does not move it)
        title = get_profile(self.store, pid).get("title") or (self.store.project(pid) or {"name": "Book"})["name"]
        cap = 60
        while True:
            name = self.folder_name(pid, branch, title, cap)
            if len(str(base / name)) + 1 + 60 <= MAX_PATH or cap <= 12:
                break
            cap -= 8
        cand, n = name, 2
        while (base / cand).exists() and self._owner_of(base / cand) not in (None, pid):
            cand = f"{name} {n}"
            n += 1
        if create and cand != name_of(mapped):
            self.store.set_setting(self._map_key(pid, branch), {"name": cand, "at": now_iso()})
        return base / cand

    # ------------------------------------------------------------------ what goes into the folder
    def _forge_files(self, pid: str, branch: str, files: dict, text) -> None:
        from . import forge  # noqa: PLC0415
        app, store = self.app, self.store
        for item in forge.list_dossiers(store, pid, branch):
            rid = item["record_id"]
            entry = forge.raw_entry(store, pid, branch, rid)
            if not entry.get("history"):
                continue  # never opened in the Character Forge
            data, _name = forge.pdf_bytes(app, pid, branch, rid)
            code = safe_name(item["code"], 12, "CH")
            room = 60 - len(f"Character Forge/{code}  - dossier.json")  # every path inside the book's folder ≤ 60
            base = f"{code} {safe_name(item['name'], max(room, 8), 'Character')} - dossier"
            files[f"Character Forge/{base}.pdf"] = data
            d = forge.public(store, pid, branch, rid)
            d.pop("history", None)
            text(f"Character Forge/{base}.json", json.dumps(d, ensure_ascii=False, indent=1))
            art = entry.get("art") or {}
            slots = [("portrait", art.get("portrait")), ("sheet", art.get("sheet"))] + \
                [(v, (art.get("views") or {}).get(v)) for v in forge.VIEW_KEYS]
            for slot, a in slots:
                pic = forge.picture_bytes(store, pid, branch, a)
                if pic:
                    ext = "jpg" if pic[:3] == b"\xff\xd8\xff" else "png"
                    files[f"Character Forge/{item['code']} pictures/{slot}.{ext}"] = pic
            clip = art.get("clip") if isinstance(art.get("clip"), dict) else None
            if clip:  # 🎬 the motion clip and its poster
                vid = forge.picture_bytes(store, pid, branch, clip)
                if vid:
                    ext = "webm" if forge.sniff_video(vid) == "video/webm" else "mp4"
                    files[f"Character Forge/{item['code']} pictures/motion clip.{ext}"] = vid
                pic = forge.picture_bytes(store, pid, branch, clip.get("poster"))
                if pic:
                    ext = "jpg" if pic[:3] == b"\xff\xd8\xff" else "png"
                    files[f"Character Forge/{item['code']} pictures/motion clip poster.{ext}"] = pic
        # 🗂 items (AR-), places (PL-) and magic systems (MG-): forge_kinds.py
        from . import forge_kinds  # noqa: PLC0415
        for kind, sp in forge_kinds.SPECS.items():
            for item in forge_kinds.list_dossiers(store, pid, branch, kind):
                rid = item["record_id"]
                data, _name = forge_kinds.pdf_bytes(app, pid, branch, kind, rid)
                code = safe_name(item["code"], 12, sp["prefix"])
                room = 60 - len(f"Character Forge/{code}  - dossier.json")
                base = f"{code} {safe_name(item['name'], max(room, 8), sp['Word'])} - dossier"
                files[f"Character Forge/{base}.pdf"] = data
                d = forge_kinds.attach_links(store, pid, branch, forge_kinds.public(store, pid, branch, kind, rid))
                d.pop("history", None)
                text(f"Character Forge/{base}.json", json.dumps(d, ensure_ascii=False, indent=1))
                art = forge_kinds.raw_entry(store, pid, branch, kind, rid).get("art") or {}
                for slot in sp["slots"]:
                    a = art.get(slot) if slot == sp["art"]["hero"] else (art.get("views") or {}).get(slot)
                    pic = forge.picture_bytes(store, pid, branch, a)
                    if pic:
                        ext = "jpg" if pic[:3] == b"\xff\xd8\xff" else "png"
                        files[f"Character Forge/{code} pictures/{slot}.{ext}"] = pic
                clip = art.get("clip") if isinstance(art.get("clip"), dict) else None
                if clip:  # 🎬 the motion clip (turntable / establishing pan / the effect in use) and its poster
                    vid = forge.picture_bytes(store, pid, branch, clip)
                    if vid:
                        ext = "webm" if forge.sniff_video(vid) == "video/webm" else "mp4"
                        files[f"Character Forge/{code} pictures/motion clip.{ext}"] = vid
                    pic = forge.picture_bytes(store, pid, branch, clip.get("poster"))
                    if pic:
                        ext = "jpg" if pic[:3] == b"\xff\xd8\xff" else "png"
                        files[f"Character Forge/{code} pictures/motion clip poster.{ext}"] = pic

    def collect(self, pid: str, branch: str, *, on_phase=None) -> tuple[dict, dict]:
        """{relative path: bytes} for everything that exists now, and info about it (read-only)."""
        app, store = self.app, self.store
        phase = on_phase or (lambda *_a: None)
        files: dict[str, bytes] = {}
        secrets = book_package.secrets_of(app)

        def text(rel, s):
            files[rel] = book_package.guard(s, secrets).encode("utf-8")
        bp = BookPath(app.engine, app.principal_id, pid, branch)
        status = bp.status()
        prof = get_profile(store, pid)
        title = prof.get("title") or (store.project(pid) or {"name": "Book"})["name"]
        stem = safe_name(title, 40)
        info = {"title": title, "exports": 0, "chapters": 0, "drafts": 0, "report": False}
        steps = {s["id"]: s for s in status["steps"]}
        # Book/ — the exported files, re-read and hash-checked by the store
        phase("Copying the finished book")
        for f in (steps.get("export") or {}).get("files") or []:
            if not f.get("record_id"):
                continue
            rec = store.get_record(pid, branch, f["record_id"], f["version"])
            data = store.read_binary(rec)
            if f.get("sha256") and hashlib.sha256(data).hexdigest() != f["sha256"]:
                raise SaveProblem("SAVE_FAILED", f"the {f['format']} file does not match its fingerprint; export the "
                                  "book again, then save")
            name = f"{stem}{' (older version)' if f.get('out_of_date') else ''}.{EXT.get(f['format'], 'bin')}"
            files[f"Book/{name}"] = data
            info["exports"] += 1
        # Chapters/
        phase("Writing the chapters")
        from .book_report import book_chapters  # noqa: PLC0415
        chapters = book_chapters(bp)
        total = len(chapters)
        for c in chapters:
            t = c["text"]
            first = t.lstrip().split("\n", 1)
            heading = first[0][2:].strip() if first and first[0].startswith("# ") else ""
            body = first[1].lstrip("\n") if heading and len(first) > 1 else (t if not heading else "")
            ctitle = c.get("title") or heading
            fname = f"{c['number']:02d} - {safe_name(ctitle, 40, 'Chapter')}.md" if ctitle else \
                f"{c['number']:02d} - Chapter {c['number']}.md"
            head = f"# Chapter {c['number']}" + (f": {ctitle}" if ctitle else "")
            state = (f"_Chapter {c['number']} of {total} · approved (version {c['version']}) · {c['words']:,} words_"
                     if c["approved"] else
                     f"> **DRAFT** — chapter {c['number']} of {total} is not approved yet (version {c['version']}, "
                     f"{c['words']:,} words). The approved book may still change.")
            text(f"Chapters/{fname}", f"{head}\n\n{state}\n\n{body.rstrip()}\n")
            info["chapters"] += 1
            info["drafts"] += 0 if c["approved"] else 1
        # Book Bible/
        phase("Writing the book bible")
        bible = book_bible.build(app, pid, branch)
        text("Book Bible/book-bible.json", json.dumps(bible, ensure_ascii=False, indent=2))
        text("Book Bible/book-bible.md", book_bible.render_markdown(bible))
        # Reports/
        phase("Writing the reports")
        rep = None
        try:
            rep = app.reports.latest(pid, branch) if getattr(app, "reports", None) else None
        except Exception:  # noqa: BLE001
            rep = None
        if rep:
            from . import book_report as br  # noqa: PLC0415
            text("Reports/Book report.md", br.render_markdown(rep))
            try:
                files["Reports/Book report.pdf"] = br.render_pdf(rep)
            except Exception:  # noqa: BLE001 - the Markdown is there
                log.exception("book report PDF for the save failed")
            info["report"] = True
        ed = self._editor_summary(pid, branch, chapters)
        if ed:
            text("Reports/Editor summary.md", ed)
        pl = self._planned_summary(pid, branch)
        if pl:
            text("Reports/Planned to page.md", pl)
        from . import continuity  # noqa: PLC0415 - Section 7: tracked state, two readings, version ledger
        co = continuity.render_markdown(app, pid, branch)
        if co:
            text("Reports/Continuity.md", co)
        # Character Forge/ (B5): the dossiers the author has worked on, their PDFs and pictures
        try:
            self._forge_files(pid, branch, files, text)
        except Exception:  # noqa: BLE001 - the rest of the save still happens
            log.exception("character forge files for the save failed")
        # Pictures/ (B3): the chosen chapter / scene pictures and the map, with pictures.json
        try:
            from . import pictures  # noqa: PLC0415
            pictures.save_files(app, pid, branch, files, text)
        except Exception:  # noqa: BLE001 - the rest of the save still happens
            log.exception("picture files for the save failed")
        # Trailer/ (B2): the book trailer (trailer.webm, trailer.mp4 when there is one) and its plan
        try:
            from . import trailer as trailer_mod  # noqa: PLC0415
            trailer_mod.save_files(app, pid, branch, files, text)
        except Exception:  # noqa: BLE001 - the rest of the save still happens
            log.exception("trailer files for the save failed")
        # Cover/ (B3): the cover design, the ebook and print covers, the art, the book files with the cover
        try:
            from . import cover as cover_mod  # noqa: PLC0415
            cover_mod.save_files(app, pid, branch, files, stem)
        except Exception:  # noqa: BLE001 - the rest of the save still happens
            log.exception("cover files for the save failed")
        # Log/
        phase("Writing the log")
        try:
            j = journal_mod.build(app, pid, branch)
            text("Log/Book journal.md", journal_mod.render_markdown(j))
        except Exception:  # noqa: BLE001 - the rest of the save still happens
            log.exception("journal for the save failed")
        runs = self._runs(pid, branch)
        text("Log/run-events.json", json.dumps({"schema_version": 1, "book": title, "saved_at": now_iso(),
                                                "note": "Steps, states, which AI did what, times and problems of the "
                                                        "book's runs. No keys, no prompts, no AI replies.",
                                                "runs": runs}, ensure_ascii=False, indent=2))
        # Progress/
        finished = status.get("next") is None
        live = next((r for r in runs if r["kind"] == "autobook"), None)
        progress = {"schema_version": 1, "book": title, "saved_at": now_iso(), "finished": finished,
                    "next_step": status.get("next"), "done": status.get("done_count"), "total": status.get("total"),
                    "words": status.get("words"),
                    "steps": [{"id": s["id"], "title": s["title"], "state": s["state"]} for s in status["steps"]],
                    "chapters": [{"number": c["number"], "chapter_id": c["chapter_id"], "title": c.get("title"),
                                  "approved": c["approved"], "words": c["words"]} for c in chapters],
                    "run": {k: live.get(k) for k in ("id", "status", "phase", "current", "steps")} if live else None}
        text("Progress/progress.json", json.dumps(progress, ensure_ascii=False, indent=2))
        info["finished"] = finished
        # book.akowe
        phase("Packing the whole book (book.akowe)")
        files[PACKAGE] = book_package.build(app, pid, bible=bible)
        state = "\nState: finished — every step is done." if finished else \
            f"\nState: not finished yet — next step: {(steps.get(status.get('next')) or {}).get('title') or '?'}."
        text("README.txt", README_TEXT.format(title=title, saved=now_iso()[:19].replace("T", " "), version=__version__,
                                              state=state).replace("\n", "\r\n" if os.name == "nt" else "\n"))
        return files, info

    def _editor_summary(self, pid, branch, chapters) -> str | None:
        crafts = self.store.get_setting(f"craft_reviews:{pid}:{branch}") or {}
        if not isinstance(crafts, dict) or not crafts:
            return None
        out = ["# 🖋 Editor summary", "", "| Chapter | Version | Editor | Average score | Notes |", "|---|---|---|---|---|"]
        for c in chapters:
            cr = crafts.get(f"{c['record_id']}:{c['version']}")
            if not isinstance(cr, dict):
                out.append(f"| {c['number']} | {c['version']} | not read | – | – |")
                continue
            scores = [v for v in (cr.get("scores") or {}).values() if isinstance(v, (int, float))]
            avg = round(sum(scores) / len(scores), 1) if scores else "–"
            out.append(f"| {c['number']} | {c['version']} | {cr.get('verdict') or '?'} | {avg} | "
                       f"{len(cr.get('findings') or [])} |")
        out.append("")
        return "\n".join(out)

    def _planned_summary(self, pid, branch) -> str | None:
        try:
            res = self.app.review.planned.book(self.app.principal_id, pid, branch)
        except Exception:  # noqa: BLE001
            return None
        if not res.get("chapters"):
            return None
        out = ["# ✅ Planned to page", "", f"Missing planned items in the whole book: {res['counts'].get('missing', 0)}",
               "", "| Chapter | On the page | Unclear | Missing |", "|---|---|---|---|"]
        for r in res["chapters"]:
            c = r.get("counts") or {}
            out.append(f"| {r.get('number')} | {c.get('on_page', '–')} | {c.get('unclear', '–')} | "
                       f"{c.get('missing', '–') if r.get('written') else 'not written'} |")
        if res.get("missing"):
            out += ["", "## Not on the page yet", ""] + [f"- Chapter {m.get('number')}: {m.get('label')}"
                                                          for m in res["missing"][:60]]
        out.append("")
        return "\n".join(out)

    def _runs(self, pid, branch) -> list[dict]:
        out = []
        for j in self.app.jobstore.list(project_id=pid, limit=100):
            if j.get("kind") not in ("autobook", "write_all") or j.get("branch_id", branch) != branch:
                continue
            j = (self.app.autobook if j["kind"] == "autobook" else self.app.write_all)._cache.get(j["id"], j)
            per_step: dict[str, set] = {}
            for e in j.get("events") or []:
                if e.get("slot"):
                    per_step.setdefault(e.get("step") or "?", set()).add(str(e["slot"]))
            steps = []
            for s in j.get("steps") or []:
                prob = s.get("problem") or {}
                steps.append({"id": s.get("id"), "title": s.get("title"), "state": s.get("state"),
                              "message": s.get("message"), "started_at": s.get("started_at"),
                              "finished_at": s.get("finished_at"), "review_note": s.get("review_note"),
                              "ai": sorted(per_step.get(s.get("id"), ())),
                              "problem": {"code": prob.get("code"), "message": prob.get("message")} if prob else None,
                              "items": [{k: i.get(k) for k in ("id", "label", "state", "words", "note")}
                                        for i in s.get("items") or []]})
            for i in j.get("items") or []:  # Write all chapters
                steps.append({"id": i.get("id"), "title": i.get("label"), "state": i.get("state"),
                              "message": i.get("note"), "ai": []})
            prob = j.get("problem") or {}
            out.append({"id": j.get("id"), "kind": j.get("kind"), "status": j.get("status"), "phase": j.get("phase"),
                        "current": j.get("current"), "created_at": j.get("created_at"),
                        "started_at": j.get("started_at"), "finished_at": j.get("finished_at"),
                        "settings": {k: (j.get("settings") or {}).get(k) for k in ("length", "genre", "slot_id",
                                                                                    "pipeline")},
                        "ais": [{k: a.get(k) for k in ("slot_id", "name", "state", "working")} for a in j.get("ais")
                                or []],
                        "timing": j.get("timing"), "review_summary": j.get("review_summary"),
                        "editor_summary": j.get("editor_summary"), "planned_summary": j.get("planned_summary"),
                        "report": j.get("report"),
                        "problem": {"code": prob.get("code"), "message": prob.get("message")} if prob else None,
                        "ai_per_step": {k: sorted(v) for k, v in per_step.items()}, "steps": steps,
                        "events": [{k: e.get(k) for k in ("at", "kind", "step", "message", "code", "slot", "verdict",
                                                          "approval", "record_id") if e.get(k) is not None}
                                   for e in j.get("events") or []]})
        return out

    # ------------------------------------------------------------------ one save
    def save_now(self, pid: str, branch: str = "main", *, kind: str = "manual", on_phase=None) -> dict:
        """Write the book's folder now (synchronous). Returns the result; raises SaveProblem."""
        if self.store.project(pid) is None:
            raise SaveProblem("SAVE_FAILED", "this book does not exist any more")
        base = self.base()
        prob = check_folder(base)
        if prob:
            raise prob
        folder = self.book_folder(pid, branch, create=True)
        files, info = self.collect(pid, branch, on_phase=on_phase)
        longest = max((len(str(folder / r)) for r in files), default=0)
        if longest > MAX_PATH:
            raise SaveProblem("SAVE_PATH_TOO_LONG", f"the longest path in the book's folder would be {longest} "
                              f"characters (at most {MAX_PATH})")
        if on_phase:
            on_phase("Writing the files")
        try:
            folder.mkdir(parents=True, exist_ok=True)
            old = []
            try:
                m = read_marker(folder)  # (an old .bookforge-folder.json lists book.bookforge: replaced below)
                old = [x for x in (m.get("files") or []) if isinstance(x, str)] if isinstance(m, dict) else []
            except (OSError, ValueError):
                old = []
            written = 0
            for rel, data in files.items():
                if write_atomic(folder / rel, data):
                    written += 1
            for rel in old:  # files Akọwe wrote earlier that are not part of this save (a renamed chapter)
                if rel not in files and ".." not in rel.split("/") and not rel.startswith("/"):
                    try:
                        (folder / rel).unlink()
                    except FileNotFoundError:
                        pass
            marker = {"app": "Akọwe", "schema_version": FOLDER_SCHEMA, "project_id": pid, "branch_id": branch,
                      "title": info["title"], "saved_at": now_iso(), "kind": kind, "finished": info.get("finished"),
                      "chapters": info["chapters"], "exports": info["exports"], "files": sorted(files)}
            write_atomic(folder / MARKER, json.dumps(marker, ensure_ascii=False, indent=2).encode("utf-8"))
            try:
                (folder / legacy.OLD_MARKER).unlink()  # the marker of a save made before the rename is replaced
            except FileNotFoundError:
                pass
        except OSError as exc:
            raise classify(exc) from None
        return {"ok": True, "path": str(folder), "folder": folder.name, "files": len(files), "written": written,
                "bytes": sum(len(d) for d in files.values()), "finished": info.get("finished"),
                "chapters": info["chapters"], "drafts": info["drafts"], "exports": info["exports"],
                "report": info["report"]}

    # ------------------------------------------------------------------ background saves
    def _status_key(self, pid, branch):
        return f"book_save:{pid}:{branch}"

    def last(self, pid: str, branch: str = "main") -> dict | None:
        v = self.store.get_setting(self._status_key(pid, branch))
        return v if isinstance(v, dict) else None

    def brief(self, pid: str | None, branch: str = "main") -> dict | None:
        """For the run window and the book page: the last save and a save that is running (never raises)."""
        if not pid:
            return None
        try:
            job = self._jobs.get((pid, branch))
            return {"last": self.last(pid, branch), "auto_save": self.auto_on(),
                    "job": dict(job) if job and job.get("state") == "running" else None}
        except Exception:  # noqa: BLE001
            return None

    def status(self, pid: str, branch: str = "main") -> dict:
        job = self._jobs.get((pid, branch))
        try:
            path = str(self.book_folder(pid, branch))
        except Exception:  # noqa: BLE001
            path = None
        return {"path": path, "books_folder": self.settings()["path"], "last": self.last(pid, branch),
                "job": dict(job) if job else None, "auto_save": self.auto_on(), "local": self.app.is_local()}

    def busy(self, key) -> bool:
        t = self._threads.get(key)
        return bool(t and t.is_alive())

    def start(self, pid: str, branch: str = "main", *, kind: str = "manual", reason: str = "") -> dict:
        """Start a save in the background (a running one is returned instead of starting a second)."""
        key = (pid, branch)
        with self._lock:
            if self.busy(key):
                if kind == "manual":
                    self._again[key] = {"kind": "manual", "force": True, "reason": "you pressed 💾 Save"}
                return dict(self._jobs[key])
            t = self._timers.pop(key, None)
            if t:
                t.cancel()
            job = {"id": f"save-{uuid.uuid4().hex[:10]}", "project_id": pid, "branch_id": branch, "kind": kind,
                   "reason": reason, "state": "running", "phase": "Starting", "started_at": now_iso(),
                   "finished_at": None, "path": None, "problem": None}
            self._jobs[key] = job
            self._last[key] = time.monotonic()
            th = threading.Thread(target=self._thread, args=(key, job), daemon=True, name=f"akowe-save-{pid[-6:]}")
            self._threads[key] = th
            th.start()
            return dict(job)

    def _thread(self, key, job):
        pid, branch = key
        try:
            fp = self.fingerprint(pid, branch)  # before collecting: a change made while saving is saved next time
            res = self.save_now(pid, branch, kind=job["kind"], on_phase=lambda p: job.update(phase=p))
            job.update(state="done", phase="Saved", path=res["path"], result=res, finished_at=now_iso())
            self._record(pid, branch, dict(res, at=now_iso(), kind=job["kind"], problem=None, fp=fp))
        except Exception as exc:  # noqa: BLE001 - a save never breaks anything else
            prob = classify(exc)
            if not isinstance(exc, (SaveProblem, OSError)):
                log.exception("saving book %s failed", pid)
            else:
                log.warning("saving book %s failed: %s (%s)", pid, prob.code, prob.message)
            job.update(state="failed", phase="Not saved", problem=prob.as_dict(), finished_at=now_iso())
            try:
                path = str(self.book_folder(pid, branch))
            except Exception:  # noqa: BLE001
                path = None
            self._record(pid, branch, {"ok": False, "at": now_iso(), "kind": job["kind"], "path": path,
                                       "problem": prob.as_dict()})
        finally:
            with self._lock:
                self.count[key] = self.count.get(key, 0) + 1
                again = self._again.pop(key, None)
                if self._threads.get(key) is threading.current_thread():
                    self._threads.pop(key, None)
            try:
                self.store.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                self.app.changed()
            except Exception:  # noqa: BLE001
                pass
            if again:
                self.auto(pid, branch, reason=again.get("reason") or "", force=again.get("force"),
                          kind=again.get("kind") or "auto", _check=False)

    def _record(self, pid, branch, rec: dict):
        try:
            if self.store.project(pid) is not None:
                self.store.set_setting(self._status_key(pid, branch), rec)
        except Exception:  # noqa: BLE001
            log.exception("could not note the save of %s", pid)

    def auto(self, pid: str | None, branch: str = "main", *, reason: str = "", force: bool = False,
             kind: str = "auto", _check: bool = True):
        """An automatic save (never raises, returns at once): now when ``force`` or the last save is older than
        ``interval_s``; else once when the interval is over (the newest state is saved then)."""
        try:
            if not pid or (_check and not self.auto_on() and kind == "auto"):
                return
            if self.store.project(pid) is None or self.app.is_test_project(pid):
                return
            key = (pid, branch)
            with self._lock:
                if self.busy(key):
                    prev = self._again.get(key) or {}
                    self._again[key] = {"kind": prev.get("kind") if prev.get("kind") == "manual" else kind,
                                        "force": bool(force or prev.get("force")), "reason": reason}
                    return
                last = self._last.get(key)
                now = time.monotonic()
                if force or last is None or now - last >= self.interval_s:
                    self.start(pid, branch, kind=kind, reason=reason)
                    return
                if key not in self._timers:
                    t = threading.Timer(max(0.05, self.interval_s - (now - last)), self._fire, (key, reason, kind))
                    t.daemon = True
                    self._timers[key] = t
                    t.start()
        except Exception:  # noqa: BLE001 - never break the caller (a run, an approval)
            log.exception("automatic save of %s could not start", pid)

    def _fire(self, key, reason, kind):
        me = threading.current_thread()
        try:
            self.auto(key[0], key[1], reason=reason, force=True, kind=kind)  # start() takes the timer off the list
        finally:
            with self._lock:
                if self._timers.get(key) is me:
                    self._timers.pop(key, None)

    def after_start(self):
        """Start-up: runs that were interrupted (Akọwe closed while they worked) get a progress save."""
        if not self.auto_on():
            return
        for j in self.app.jobstore.list(limit=60):
            if j.get("kind") in ("autobook", "write_all") and j.get("status") == "interrupted" and \
                    j.get("project_id") and not j.get("opened_from_package"):
                self.auto(j["project_id"], j.get("branch_id") or "main", reason="interrupted", force=True)

    # ------------------------------------------------------------------ 💾 every 10 minutes, when the book changed
    def fingerprint(self, pid: str, branch: str = "main") -> str | None:
        """A cheap summary of everything a save writes: changes whenever a record, an approval, module state, the
        project or one of the book's own settings (profile, dossiers, cover, pictures, …) changes. None on error."""
        try:
            q = self.store.query_one
            rec = q("SELECT COUNT(*) AS n, MAX(created_at) AS m FROM records WHERE project_id=? AND branch_id=?",
                    (pid, branch))
            life = q("SELECT COUNT(*) AS n, MAX(updated_at) AS m FROM lifecycle WHERE project_id=? AND branch_id=?",
                     (pid, branch))
            mod = q("SELECT COUNT(*) AS n, MAX(updated_at) AS m FROM module_state WHERE project_id=? AND "
                    "branch_id=?", (pid, branch))
            sets = q("SELECT COUNT(*) AS n, MAX(updated_at) AS m FROM settings WHERE instr(key, ?) > 0 AND "
                     "key NOT LIKE 'book_save:%' AND key NOT LIKE 'book_folder:%'", (pid,))
            proj = q("SELECT name, settings FROM projects WHERE project_id=?", (pid,))
            parts = [[r["n"], r["m"]] if r else None for r in (rec, life, mod, sets)]
            parts.append([proj["name"], proj["settings"]] if proj else None)
            return hashlib.sha256(json.dumps(parts, default=str).encode("utf-8")).hexdigest()[:24]
        except Exception:  # noqa: BLE001 - unknown: the caller saves
            log.warning("could not read the state of book %s", pid)
            return None

    def periodic_tick(self) -> list:
        """One quiet round: save (in the background) every book whose state changed since its last save. Returns the
        (pid, branch) pairs it started. Never raises."""
        started = []
        try:
            if not self.auto_on():
                return started
            for p in self.store.query("SELECT project_id FROM projects WHERE archived=0"):
                pid = p["project_id"]
                if self.app.is_test_project(pid):
                    continue
                for b in self.store.query("SELECT branch_id FROM branches WHERE project_id=?", (pid,)):
                    branch = b["branch_id"]
                    last = self.last(pid, branch)
                    fp = self.fingerprint(pid, branch)
                    if last is None:
                        has = self.store.query_one("SELECT 1 AS x FROM records WHERE project_id=? AND branch_id=? "
                                                   "LIMIT 1", (pid, branch)) or self.store.query_one(
                            "SELECT 1 AS x FROM settings WHERE instr(key, ?) > 0 AND key NOT LIKE 'book_save:%' AND "
                            "key NOT LIKE 'book_folder:%' LIMIT 1", (pid,))
                        if not has:
                            continue  # an empty book: nothing to save yet
                    elif fp is not None and last.get("fp") == fp and last.get("ok"):
                        continue  # unchanged since its last save: leave it alone
                    self.auto(pid, branch, reason="saved every 10 minutes (the book changed)", force=True)
                    started.append((pid, branch))
        except Exception:  # noqa: BLE001 - a background check never breaks anything
            log.exception("the 10-minute save check failed")
        return started

    def start_periodic(self):
        """The background ticker of ``periodic_tick`` (every ``periodic_s``); a second call does nothing."""
        if self._ticker and self._ticker.is_alive():
            return

        def loop():
            while not self._stop_ticker.wait(self.periodic_s):
                self.periodic_tick()
                try:
                    self.store.close()  # this thread's database connection
                except Exception:  # noqa: BLE001
                    pass
        self._stop_ticker.clear()
        self._ticker = threading.Thread(target=loop, name="akowe-save-every-10-min", daemon=True)
        self._ticker.start()

    def stop_periodic(self):
        self._stop_ticker.set()

    def wait_idle(self, timeout: float = 30.0, timers: bool = False) -> bool:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            with self._lock:
                busy = any(t.is_alive() for t in self._threads.values()) or bool(self._again) or \
                    (timers and bool(self._timers))
            if not busy:
                return True
            time.sleep(0.02)
        return False

    def stop_timers(self):
        with self._lock:
            for t in self._timers.values():
                t.cancel()
            self._timers.clear()

    def open_folder(self, pid: str | None = None, branch: str = "main") -> dict:
        """Show the books folder (or one book's folder) in the file manager of THIS computer."""
        if not self.app.is_local():
            raise problem_error("OPEN_NOT_LOCAL", "folders can only be opened on the computer Akọwe runs on",
                                kernel="PERMISSION_DENIED")
        path = self.book_folder(pid, branch) if pid else self.base()
        if not path.exists():
            path = self.base()
            prob = check_folder(path)
            if prob:
                raise problem_error(prob.code, prob.message, path="/path")
        try:
            self.launch(path)
        except Exception as exc:  # noqa: BLE001
            raise problem_error("SAVE_FAILED", f"the folder could not be shown ({type(exc).__name__}); open it "
                                f"yourself: {path}") from None
        return {"ok": True, "path": str(path)}
