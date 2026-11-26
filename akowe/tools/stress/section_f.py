"""Section F — Putting the book together: part 14 format (I01, ``_s_format``), part 15 assemble (G01…G08,
``_s_assemble``), part 16 export (G11 PDF / G12 EPUB / G13 Word and the re-read, ``_s_export``) and part 17 the content
check (H05, ``_s_check``).

None of these four parts makes an AI call: they are Akọwe's own deterministic work. So the standard stresses a–f are
mapped to the closest real failures of that work (each scenario says so in its notes):

* a (AI times out)      → the part's own work is slow (a 3 s stall: slow disk, antivirus scan, a big book) once and on
                          every attempt;
* b (busy, recovers)    → the database is busy: another program holds a real SQLite write lock for 3 s, then frees it;
* c (usage limit)       → the disk is full while the part writes (SQLite “database or disk is full” / ENOSPC for the
                          exported file), then space is freed;
* d (garbage answer)    → garbage where the part reads its input (the remembered format / assembly in the path memory,
                          the PDF writer's bytes, the content check's own result);
* e (empty answer)      → empty input (no title, an emptied chapter, an empty PDF, an empty check result);
* f (AI refuses)        → the part's module refuses every time (BLOCKED), until the cause is removed;
* g, h, i               → the shared generic ones (own code raises; the program stops right after the part's work;
                          pause / cancel at the part).

Helpers live here (core.py is shared and not edited). This module also moves the harness's temp folder to
``/dev/shm/stF-<pid>`` (one folder per process, removed at the end of a run).
"""
from __future__ import annotations

import io
import os
import re
import shutil
import sqlite3
import threading
import time
import zipfile
from pathlib import Path

from akowe import store as store_mod
from akowe.autobook import AutoBookService, verify_file
from akowe.book_path import BookPath, get_profile, save_profile

from . import core
from .core import (LIKELY, UNLIKELY, Harness, Outcome, Rule, Section, SimulatedCrash, Target, replace,
                   scrub)

# ----------------------------------------------------------------------------------------- temp folder of this run
_OLD_TMP = core.TMP_BASE
_NEW_TMP = Path("/dev/shm" if os.path.isdir("/dev/shm") else core.tempfile.gettempdir()) / f"stF-{os.getpid()}"
if core.TMP_BASE != _NEW_TMP:
    core.TMP_BASE = _NEW_TMP
    _NEW_TMP.mkdir(parents=True, exist_ok=True)
    if os.environ.get("AKOWE_BOOKS_DIR", "").startswith(str(_OLD_TMP)):
        os.environ["AKOWE_BOOKS_DIR"] = str(_NEW_TMP / "books")
    try:
        _OLD_TMP.rmdir()  # empty: made by core at import, never used
    except OSError:
        pass

SEC = Section("F", "Putting the book together", "putting-the-book-together")
SEC.part("14", "format", "The book format (I01 records): page size, font, contents style and the PDF / EPUB / Word "
         "settings are made from the book profile and approved — no AI call.", step="format")
SEC.part("15", "assemble", "The approved chapters are put together (G02 order, G01 manuscript, G05 typography and "
         "font coverage, G06/G08 title page and headings, G04 pages, G07 contents) and approved — no AI call.",
         step="assemble")
SEC.part("16", "export", "The PDF (G11), EPUB (G12) and Word (G13) files are made from the assembled book, stored, "
         "and each one is read back and checked — no AI call.", step="export")
SEC.part("17", "check (content check)", "H05 checks that every chapter is in the assembled book once and in order "
         "— no AI call.", step="check")

NO_AI = ("This part makes no AI call; the stress is mapped to the closest real failure of the part's own work: {}.")
BR = "main"


# ============================================================================================== helpers
def _bp(h: Harness, run: dict | None = None) -> BookPath:
    run = run or h.raw()
    return BookPath(h.app.engine, "author", run["project_id"], run.get("branch_id") or BR)


def _chapters(h: Harness, run: dict | None = None) -> list[tuple]:
    """[(chapter id, approved record, latest record)] in outline order."""
    bp = _bp(h, run)
    outline = bp.outline()
    out = []
    for c in bp.outline_chapters(outline) if outline else []:
        _ctx, latest, appr = bp.chapter_prose(outline, c["chapter_id"])
        out.append((c["chapter_id"], appr, latest))
    return out


def _hand_edit(h: Harness, rid: str, new_text: str, approve: bool = True) -> dict:
    """The author edits a chapter by hand (a new C02 version) and, when ``approve``, approves it (as tests do)."""
    run = h.raw()
    bp = _bp(h, run)
    head = bp.rec(rid)
    resp = bp.dispatch("C02", "UPDATE", base_ref=head["ref"], payload=dict(head["data"], text=new_text))
    out = {"status": resp["status"], "errors": [e.get("code") for e in resp.get("errors") or []]}
    if approve and resp["status"] == "DRAFT":
        res = h.app.review.approve("author", run["project_id"], run.get("branch_id") or BR,
                                   {"record_ids": [rid], "author_confirms": True, "how": "one"})
        out["approved"] = bool((res.get("results") or [{}])[0].get("ok"))
    return out


def _wrap(h: Harness, cls, name: str, fn):
    """Monkeypatch ``cls.name`` with ``fn(orig, self, *a, **k)`` (undone by h.fix())."""
    orig = getattr(cls, name)

    def wrapped(self, *a, **k):
        return fn(orig, self, *a, **k)
    h.patch(cls, name, wrapped)


def _on_dispatch(h: Harness, ops, fn, *, action: str = "CREATE", step: str | None = None, times: int | None = None):
    """Intercept BookPath.dispatch for module ``ops`` (and ``action``) while the run is in ``step``: ``fn(orig, bp, op,
    action, kw)`` returns a response (or raises); None = let the real call through."""
    ops = {ops} if isinstance(ops, str) else set(ops)
    orig = BookPath.dispatch
    cnt = {"n": 0}

    def wrapped(self, op, act, **kw):
        if op in ops and act == action and (step is None or h.current_step() == step) and \
                (times is None or cnt["n"] < times):
            cnt["n"] += 1
            r = fn(orig, self, op, act, kw)
            if r is not None:
                return r
        return orig(self, op, act, **kw)
    h.patch(BookPath, "dispatch", wrapped)
    return cnt


def _blocked(code: str = "CAPABILITY_UNAVAILABLE", message: str = "stress: the module refuses (BLOCKED)") -> dict:
    return {"status": "BLOCKED", "errors": [{"code": code, "message": message, "path": "/payload"}],
            "findings": [], "output_refs": []}


ACTION = {"format": "a_setup_format", "assemble": "a_assemble", "export": "a_export", "check": "a_check"}
OPS = {"format": ("I01",), "assemble": ("G02", "G01", "G05", "G06", "G08", "G04", "G07"),
       "export": ("G11", "G12", "G13"), "check": ("H05",)}


def _final_check(h: Harness, run: dict) -> list[str]:
    """After a finished run: the book's own checklist agrees (format, assembly, export, check done, no file out of
    date) and every exported file reads back."""
    bad = []
    if run.get("status") != "done":
        return bad
    try:
        st = {s["id"]: s for s in _bp(h, run).status()["steps"]}
    except Exception as exc:  # noqa: BLE001
        return [f"the book's checklist cannot be read ({type(exc).__name__})"]
    for sid in ("format", "assemble", "export", "check"):
        if st[sid]["state"] != "done":
            bad.append(f"the finished run left the book's “{st[sid]['title']}” step {st[sid]['state']}"
                       + (" (out of date)" if st[sid].get("out_of_date") else ""))
    for f in st["export"].get("files") or []:
        if f.get("out_of_date"):
            bad.append(f"the {f['format']} file is marked out of date")
    for f in run.get("files") or []:
        try:
            rec = h.app.store.get_record(run["project_id"], run.get("branch_id") or BR, f["record_id"], f["version"])
            ok, why = verify_file(f["format"], h.app.store.read_binary(rec))
            if not ok:
                bad.append(f"the {f['format']} file does not read back ({why[:80]})")
        except Exception as exc:  # noqa: BLE001
            bad.append(f"the {f['format']} file cannot be read ({type(exc).__name__})")
    return bad


def _final(h: Harness, run: dict) -> tuple[list, list]:
    return _final_check(h, run), []


def _file_bytes(h: Harness, run: dict, fmt: str) -> bytes | None:
    for f in run.get("files") or []:
        if f["format"] == fmt:
            rec = h.app.store.get_record(run["project_id"], run.get("branch_id") or BR, f["record_id"], f["version"])
            return h.app.store.read_binary(rec)
    return None


def _zip_text(data: bytes | None) -> str:
    """All the text inside an EPUB / DOCX (the XML parts, joined)."""
    if not data:
        return ""
    z = zipfile.ZipFile(io.BytesIO(data))
    return "\n".join(z.read(n).decode("utf-8", "replace") for n in z.namelist()
                     if n.endswith((".xhtml", ".html", ".xml", ".opf", ".ncx")))


def _stall(h: Harness, step: str, seconds: float, times: int | None = 1, seen: dict | None = None):
    """The part's own work (BookPath.a_<action>) takes ``seconds`` longer (``times`` calls; None = every call); the
    author's view (phase / activity) is sampled during the stall."""
    cnt = {"n": 0}

    def fn(orig, self, *a, **k):
        if times is None or cnt["n"] < times:
            cnt["n"] += 1
            t = threading.Thread(target=lambda: (time.sleep(seconds / 2), seen is not None and seen.setdefault(
                "phase", scrub((h.raw() or {}).get("phase")))), daemon=True)
            t.start()
            time.sleep(seconds)
        return orig(self, *a, **k)
    _wrap(h, BookPath, ACTION[step], fn)
    return cnt


def _db_lock(h: Harness, step: str, seconds: float, info: dict):
    """Another program holds a real SQLite write lock on the data base for ``seconds`` when the part starts."""
    def before(run):
        ready = threading.Event()

        def hold():
            conn = sqlite3.connect(h.app.store.db_path, timeout=5, isolation_level=None)
            try:
                conn.execute("BEGIN EXCLUSIVE")
                info["locked"] = True
                ready.set()
                time.sleep(seconds)
                conn.execute("ROLLBACK")
            except sqlite3.Error as exc:
                info["lock_error"] = type(exc).__name__
                ready.set()
            finally:
                conn.close()
        threading.Thread(target=hold, daemon=True, name="stress-db-lock").start()
        ready.wait(10)
        info["t0"] = time.monotonic()

    def after(run):
        info["waited"] = round(time.monotonic() - info.get("t0", time.monotonic()), 1)
    h.at_step(step, before=before, after=after)


def _disk_full_db(h: Harness, step: str, times: int | None = None):
    """The disk is full while the part writes its records: SQLite answers “database or disk is full” inside the
    engine (where a real write fails; the engine's own handler turns it into a response)."""
    from akowe.engine import Engine  # noqa: PLC0415
    orig = Engine._dispatch  # noqa: SLF001
    ops = set(OPS[step])
    cnt = {"n": 0}

    def wrapped(self, request, *a, **k):
        if isinstance(request, dict) and request.get("target_operation") in ops and \
                request.get("action") == "CREATE" and h.current_step() == step and \
                (times is None or cnt["n"] < times):
            cnt["n"] += 1
            raise sqlite3.OperationalError("database or disk is full")
        return orig(self, request, *a, **k)
    h.patch(Engine, "_dispatch", wrapped)
    return cnt


def _module_refuses(h: Harness, step: str, ops=None):
    def fn(orig, bp, op, act, kw):
        return _blocked()
    return _on_dispatch(h, ops or OPS[step], fn, step=step)


def _boom(step: str, exc=KeyError):
    def own(h: Harness):
        def fn(orig, self, *a, **k):
            raise exc("stress: injected failure inside the part's own code")
        _wrap(h, BookPath, ACTION[step], fn)
    return own


def _note(o: Outcome, what: str) -> Outcome:
    o.notes.insert(0, NO_AI.format(what))
    return o


def _std_a(step: str):
    def fn(h: Harness) -> Outcome:
        h.make_app()
        seen: dict = {}
        _stall(h, step, 3.0, times=1, seen=seen)
        o = _run(h, label="Once 3 s slower: ", check=_final)
        with Harness(h.id, h.section, h.part, h.stress, h.title, seed=h.seed, time_limit=h.time_limit) as h2:
            h2.make_app()
            seen2: dict = {}
            n = _stall(h2, step, 3.0, times=None, seen=seen2)
            o2 = _run(h2, label="Every call 3 s slower: ", check=_final)
            o2.notes.append(f"The part's work was called {n['n']} time(s) in the run.")
        out = o.worst(o2)
        if seen.get("phase"):
            out.notes.append(f"During the stall the run window said: “{seen['phase']}”.")
        return _note(out, "the part's own work is slow (a slow disk, an antivirus scan, a big book)")
    return fn


def _std_b(step: str):
    def fn(h: Harness) -> Outcome:
        h.make_app()
        info: dict = {}
        _db_lock(h, step, 3.0, info)
        o = _run(h, label="Another program holds a write lock on the database for 3 s: ", check=_final)
        o.notes.append(f"Lock taken: {bool(info.get('locked'))}; the part waited and finished after "
                       f"{info.get('waited')} s." + (f" ({info['lock_error']})" if info.get("lock_error") else ""))
        return _note(o, "the database is busy (a real SQLite write lock held by another program), then frees it")
    return fn


def _std_c(step: str):
    def fn(h: Harness) -> Outcome:
        h.make_app()
        _disk_full_db(h, step)
        o = _run(h, label="Disk full (“database or disk is full”) while the part writes, then space freed: ",
                       check=_final)
        return _note(o, "the disk is full while the part writes, then space is freed")
    return fn


def _std_f(step: str, ops=None):
    def fn(h: Harness) -> Outcome:
        h.make_app()
        _module_refuses(h, step, ops)
        o = _run(h, label="The part's module refuses (BLOCKED) every time until the cause is removed: ",
                       check=_final)
        return _note(o, "the part's module refuses its work (BLOCKED) repeatedly")
    return fn


def _register_std(part: str, step: str, own, ops=None):
    SEC.std(part, Target(step=step, kinds=(), own=own, crash_after=True), letters="ghi")
    SEC.stress(part, "a", "the AI times out → no AI here: the part's own work is slow (once; and every time)")(
        _std_a(step))
    SEC.stress(part, "b", "the AI is busy → no AI here: the database is busy (a write lock), then frees it")(
        _std_b(step))
    SEC.stress(part, "c", "every AI at its usage limit → no AI here: the disk is full while the part writes, then "
                          "space is freed")(_std_c(step))
    SEC.stress(part, "f", "the AI refuses repeatedly → no AI here: the part's module refuses (BLOCKED) every time")(
        _std_f(step, ops))


EXPECTED_TB = ("storage unavailable",)   # the engine logs a storage failure with its traceback on purpose


def _redo(o: Outcome) -> Outcome:
    """Recompute the result after issues / risks were changed (the same rule as core.Harness.finish_outcome)."""
    o.issues = list(dict.fromkeys(o.issues))
    o.risks = list(dict.fromkeys(o.risks))
    if o.issues:
        o.result = core.PROBLEM
    elif o.risks:
        o.result = core.RISKY
    elif o.final_status == "done" and o.status != "done":
        o.result = core.SAFE
    elif o.status == "done":
        o.result = core.HANDLED
    else:
        o.result = core.PROBLEM
    return o


def _stop_review(o: Outcome) -> Outcome:
    """Section F's own look at a stop: these parts make no AI call, so an “AI problem” alert blames the wrong thing,
    and a module code (“I01 could not be created (BLOCKED).”) is not plain words."""
    kept = []
    for i in o.issues:
        if i.startswith("unexpected traceback in the log") and all(
                x in EXPECTED_TB for x in [w.strip() for w in i.split(":", 1)[1].split(";")]):
            o.notes.append("The engine logged the storage failure with its traceback (ERROR “storage unavailable”, "
                           "on purpose; no book text).")
            continue
        kept.append(i)
    o.issues = kept
    if o.problem_code and o.problem_code != "NO_SECOND_AI":
        if o.alert.get("category") == "ai" and not any("Akọwe's own code an “AI problem”" in r for r in o.risks):
            o.risks.append("the alert calls it an “AI problem” (“" + o.alert.get("why", "") + "”) although this part "
                           "makes no AI call")
        if re.match(r"^[A-Z]\d\d could not be created \(", o.problem_message or ""):
            o.risks.append(f"the message is a module code (“{o.problem_message}”), not what went wrong in plain words")
    return _redo(o)


def _run(h: Harness, **kw) -> Outcome:
    return _stop_review(h.standard(**kw))


def _set_mem(h: Harness, key: str, value):
    _bp(h).remember(lambda m: m.__setitem__(key, value))


# ---------------------------------------------------------------------------------------------- a 60-chapter book
_SIXTY: dict = {}


def _sixty_outline(h: Harness):
    from akowe.practice_ai import plan_item  # noqa: PLC0415

    def sixty(c):
        pov, loc = h.chaos._canon_ids(c.ctx)  # noqa: SLF001
        objs = h.chaos._objectives()  # noqa: SLF001
        return dict(c.out, chapters=[plan_item(f"ch{i + 1}", i, objs[i % len(objs)], pov, loc) for i in range(60)])
    h.chaos.max_chapters = 60
    h.at_step("outline", before=lambda run: save_profile(h.app.store, run["project_id"], {"chapters": 60}))
    del sixty


def _time_steps(h: Harness, times: dict):
    for sid in ("format", "assemble", "export", "check"):
        orig = getattr(AutoBookService, f"_s_{sid}")

        def timed(svc, run, st, orig=orig, sid=sid):
            t0 = time.monotonic()
            try:
                return orig(svc, run, st)
            finally:
                times[sid] = round(times.get(sid, 0.0) + time.monotonic() - t0, 2)
        h.patch(AutoBookService, f"_s_{sid}", timed)


def _sixty_run(h: Harness) -> Outcome:
    """One 60-chapter book (cached per process: parts 15, 16 and 17 read the same run)."""
    if "outcome" in _SIXTY:
        return _SIXTY["outcome"]
    h.make_app()
    _sixty_outline(h)
    times: dict = {}
    _time_steps(h, times)
    t0 = time.monotonic()

    def check(hh, run):
        iss = _final_check(hh, run)
        chs = _chapters(hh, run) if run.get("project_id") else []
        _SIXTY["chapters"] = len(chs)
        epub = _zip_text(_file_bytes(hh, run, "EPUB")) if run.get("status") == "done" else ""
        _SIXTY["epub_ch60"] = "night 60 of the search" in epub
        if len(chs) != 60:
            iss.append(f"the book has {len(chs)} chapters, not 60")
        elif run.get("status") == "done" and not _SIXTY["epub_ch60"]:
            iss.append("chapter 60's text is not in the EPUB")
        return iss, []
    o = _run(h, label="A 60-chapter book: ", check=check)
    _SIXTY.update(times=times, total=round(time.monotonic() - t0, 1), outcome=o)
    o.notes.append(f"Whole run {_SIXTY['total']} s; format {times.get('format')} s, assemble {times.get('assemble')} s, "
                   f"export {times.get('export')} s, content check {times.get('check')} s (seconds of Akọwe's own "
                   f"work; {len(h.chaos.trace)} Practice-AI calls).")
    return o


def _sixty_for(part: str):
    def fn(h: Harness) -> Outcome:
        o = _sixty_run(h)
        out = core.copy.deepcopy(o)
        t = _SIXTY.get("times") or {}
        key = {"15": "assemble", "16": "export", "17": "check"}[part]
        if (t.get(key) or 0) > 60:
            out.risks.append(f"the {key} step alone took {t.get(key)} s for 60 chapters with no progress shown")
            out = h.finish_outcome(out) if out.result != core.PROBLEM else out
        return out
    return fn


# ============================================================================================== part 14: format
_register_std("14", "format", _boom("format"))


@SEC.stress("14", "d", "garbage answer → no AI here: the remembered book format is garbage (wrong types in the "
                       "book's path memory, e.g. from an older version or a hand-edited settings file)")
def f14_d(h: Harness) -> Outcome:
    h.make_app()
    garbage = {"font": "garbage", "page": 12, "font_file": ["x"], "toc_style": {"record_id": 5},
               "metadata": None, "language": 7}
    h.at_step("format", before=lambda run: _set_mem(h, "format", dict(garbage)))
    o = _run(h, label="Garbage in the remembered format: ", check=_final)
    return _note(o, "garbage input (the remembered format record references are wrong types)")


@SEC.stress("14", "e", "empty answer → no AI here: the book's title is empty when the format is made (the author "
                       "cleared it)")
def f14_e(h: Harness) -> Outcome:
    h.make_app()
    keep: dict = {}

    def clear(run):
        pid = run["project_id"]
        p = get_profile(h.app.store, pid)
        keep["title"] = p.get("title")
        try:  # the profile form refuses an empty title …
            save_profile(h.app.store, pid, {"title": ""})
            keep["api"] = "accepted"
        except Exception as exc:  # noqa: BLE001
            keep["api"] = f"refused ({getattr(exc, 'code', type(exc).__name__)})"
        # … so the empty title comes from stored data (an older version, an import, a restored backup)
        h.app.store.set_setting(f"book_profile:{pid}", dict(p, title=""))
    h.at_step("format", before=clear)
    h.on_fix(lambda: save_profile(h.app.store, h.raw()["project_id"], {"title": keep.get("title") or "Restored"}))
    o = _run(h, label="Stored title empty when the format step starts (restored as the fix): ", check=_final)
    o.notes.append(f"Saving an empty title through the profile form: {keep.get('api')}.")
    return _note(o, "empty input (no title for the format's title page and metadata)")


@SEC.stress("14", "j", "the most likely real-life problem: the author renames the book (and changes the page size) "
                       "right after the format was made, before the book is put together", likely=LIKELY)
def f14_j(h: Harness) -> Outcome:
    def one(hh: Harness, change: dict, label: str) -> Outcome:
        hh.make_app()
        hh.at_step("format", after=lambda run: save_profile(hh.app.store, run["project_id"], dict(change)))

        def check(h3, run):
            iss = _final_check(h3, run)
            if run.get("status") == "done":
                epub = _zip_text(_file_bytes(h3, run, "EPUB"))
                if change.get("title") and change["title"] not in epub:
                    iss.append("the exported EPUB does not carry the new title")
                if any(f.get("title") != change.get("title", f.get("title")) for f in run.get("files") or []):
                    iss.append("the files are named after the old title")
            return iss, []
        return _run(hh, label=label, check=check)
    o = one(h, {"title": "A Brand New Title"}, "Renamed after the format: ")
    with Harness(h.id, h.section, h.part, h.stress, h.title, seed=h.seed, time_limit=h.time_limit) as h2:
        o2 = one(h2, {"trim_size": "5x8"}, "Page size changed to 5 × 8 in after the format: ")
    return o.worst(o2)


@SEC.stress("14", "k", "a 3,000-character title and author name with control characters and a NUL byte",
            likely=UNLIKELY)
def f14_k(h: Harness) -> Outcome:
    h.make_app()
    long_title = ("The Very Long Title " * 150)[:3000]
    api: dict = {}

    def set_it(run):
        pid = run["project_id"]
        for k, v in (("title", long_title), ("author", "Ann\x00e \x1b[31mBell\x07")):
            try:
                save_profile(h.app.store, pid, {k: v})
                api[k] = "accepted"
            except Exception as exc:  # noqa: BLE001
                api[k] = f"refused ({getattr(exc, 'code', type(exc).__name__)}: {scrub(getattr(exc, 'message', exc))[:60]})"
        # as stored data (an import / an older version), whatever the form says
        p = get_profile(h.app.store, pid)
        h.app.store.set_setting(f"book_profile:{pid}", dict(p, title=long_title, author="Ann\x00e \x1b[31mBell\x07"))
    h.at_step("format", before=set_it)

    def check(hh, run):
        iss = _final_check(hh, run)
        risk = []
        if run.get("status") == "done":
            for fmt in ("EPUB", "DOCX"):
                t = _zip_text(_file_bytes(hh, run, fmt))
                if "\x00" in t or "\x1b" in t:
                    iss.append(f"a NUL / ESC control character is written into the {fmt} file")
            files = run.get("files") or []
            if any(len(str(f.get("title") or "")) > 300 for f in files):
                risk.append("the 3,000-character title is used unshortened for the files (file names, metadata)")
        return iss, risk
    o = _run(h, label="Stored 3,000-character title, author “Ann⧵0e ESC[31mBell BEL”: ", check=check)
    o.notes.append(f"Through the profile form: title {api.get('title')}; author {api.get('author')}.")
    return o


@SEC.stress("14", "l", "the author already made and approved a format by hand (another page size) before the run "
                       "reaches it", likely=LIKELY)
def f14_l(h: Harness) -> Outcome:
    h.make_app()
    seen: dict = {}

    def by_hand(run):
        pid = run["project_id"]
        save_profile(h.app.store, pid, {"trim_size": "a5"})
        bp = _bp(h, run)
        bp.a_setup_format({})
        st = {s["id"]: s for s in bp.status()["steps"]}["format"]
        for i in st.get("approve") or []:
            rec = bp.rec(i["record_id"])
            bp.approve_ref(rec["ref"])
        seen["page"] = (_bp(h, run).mem.get("format") or {}).get("page")

    h.at_step("format", before=by_hand)

    def check(hh, run):
        iss = _final_check(hh, run)
        page = (_bp(hh, run).mem.get("format") or {}).get("page")
        if seen.get("page") and page and page.get("record_id") != seen["page"].get("record_id"):
            iss.append("the run replaced the format the author had made and approved")
        return iss, []
    return _run(h, label="Format made and approved by hand (A5 pages) just before the step: ", check=check)


@SEC.stress("14", "m", "the book's language is not English (Yorùbá, then Arabic) when the format is made",
            likely=LIKELY)
def f14_m(h: Harness) -> Outcome:
    def one(hh, lang, label):
        hh.make_app()
        hh.at_step("format", before=lambda run: save_profile(hh.app.store, run["project_id"], {"language": lang}))

        def check(h3, run):
            iss = _final_check(h3, run)
            fmt = (_bp(h3, run).mem.get("format") or {}) if run.get("project_id") else {}
            if run.get("status") == "done" and fmt.get("language") not in (lang, lang.split("-")[0]):
                iss.append(f"the format was made for language “{fmt.get('language')}”, not “{lang}”")
            return iss, []
        return _run(hh, label=label, check=check)
    o = one(h, "yo", "Language Yorùbá (yo): ")
    with Harness(h.id, h.section, h.part, h.stress, h.title, seed=h.seed, time_limit=h.time_limit) as h2:
        o2 = one(h2, "ar", "Language Arabic (ar), English text: ")
    return o.worst(o2)


# ============================================================================================== part 15: assemble
_register_std("15", "assemble", _boom("assemble"), ops=("G05",))


@SEC.stress("15", "d", "garbage answer → no AI here: the remembered assembly is garbage (wrong types in the book's "
                       "path memory)")
def f15_d(h: Harness) -> Outcome:
    h.make_app()
    h.at_step("assemble", before=lambda run: _set_mem(h, "assembly", {"G01": "x", "G07": 3, "chapters": 5,
                                                                       "title_page": "?"}))
    o = _run(h, label="Garbage in the remembered assembly: ", check=_final)
    return _note(o, "garbage input (the remembered assembly is wrong types)")


@SEC.stress("15", "e", "empty answer → no AI here: the author empties a chapter (one space) and approves it just "
                       "before the book is put together")
def f15_e(h: Harness) -> Outcome:
    h.make_app()
    info: dict = {}

    def empty(run):
        cid, appr, _latest = _chapters(h, run)[1]
        info["rid"], info["text"] = appr["record_id"], appr["data"]["text"]
        info["edit"] = _hand_edit(h, appr["record_id"], " ")
        if info["edit"]["status"] != "DRAFT":  # an empty chapter is refused: the shortest the author can save
            info["edit_dot"] = _hand_edit(h, appr["record_id"], ".")
    h.at_step("assemble", before=empty)

    def check(hh, run):
        iss, risk = _final_check(hh, run), []
        if run.get("status") == "done":
            ch = [c for c in _chapters(hh, run) if c[1] and c[1]["record_id"] == info.get("rid")]
            t = (ch[0][1]["data"].get("text") or "").strip() if ch else "?"
            if len(t) < 2:
                risk.append(f"a book whose chapter 2 is “{t}” (empty / one character) was put together, exported "
                            "and passed the content check; only the general “much shorter than planned” note is "
                            "shown, nothing names the empty chapter")
        return iss, risk
    o = _run(h, label="The author empties chapter 2 (one space; refused → a single “.”) and approves it: ",
             check=check)
    o.notes.append(f"Saving a chapter of one space: {info.get('edit')}; a chapter of “.”: {info.get('edit_dot')}.")
    return _note(o, "empty input (an empty approved chapter)")


@SEC.stress("15", "j", "the most likely real-life problem: a chapter holds characters the PDF fonts cannot print "
                       "(an emoji written by the AI; a stray byte-order mark from pasted text)", likely=LIKELY)
def f15_j(h: Harness) -> Outcome:
    def one(hh: Harness, how: str, label: str) -> Outcome:
        hh.make_app()
        info: dict = {}
        if how == "emoji":
            hh.chaos.add(Rule(replace(lambda c: dict(c.out, text=c.out["text"].replace(". ", ". The sea was calm 🌊. ",
                                                                                       1))),
                              kinds="C02", times=1, name="emoji"))
        else:
            def bom(run):
                cid, appr, _l = _chapters(hh, run)[1]
                info["rid"], info["text"] = appr["record_id"], appr["data"]["text"]
                _hand_edit(hh, appr["record_id"], "﻿" + appr["data"]["text"])
            hh.at_step("assemble", before=bom)

        def fix():  # what the author can do: take the characters out of the chapter, approve, press Resume
            for cid, appr, latest in _chapters(hh):
                rec = latest or appr
                t = (rec or {}).get("data", {}).get("text") or ""
                if "🌊" in t or "﻿" in t:
                    _hand_edit(hh, rec["record_id"], t.replace(" The sea was calm 🌊.", "").replace("﻿", ""))
        hh.on_fix(fix)

        def check(h3, run):
            iss, risk = _final_check(h3, run), []
            p = h3.first_problem or {}
            msg = str(p.get("message") or "") + " " + str(p.get("fix") or "")
            if p and "G05" in msg and "chapter" not in msg.lower():
                risk.append("the stop names the module “G05”, not the chapter or the characters to change")
            if p:
                risk.append("one unprintable character in one chapter stops the WHOLE book at “Put the book "
                            "together”: the EPUB and Word files (which could print it) are not made either")
            return iss, risk
        o = _run(hh, label=label, check=check)
        if o.alert.get("category") == "ai" and not any("Akọwe's own code an “AI problem”" in r for r in o.risks):
            o.risks.append("the alert files it as an “AI problem”")
            o = hh.finish_outcome(o)
        return o
    o = one(h, "emoji", "The AI writes an emoji into chapter 1: ")
    with Harness(h.id, h.section, h.part, h.stress, h.title, seed=h.seed, time_limit=h.time_limit) as h2:
        o2 = one(h2, "bom", "A byte-order mark (U+FEFF, invisible) pasted at the start of chapter 2: ")
    return o.worst(o2)


@SEC.stress("15", "k", "A-2-u confirmed and extended: an Arabic (or emoji) title stops the book at assemble; the "
                       "author renames it and presses Resume / Try again", likely=LIKELY)
def f15_k(h: Harness) -> Outcome:
    def one(hh: Harness, title: str, label: str) -> Outcome:
        hh.make_app()
        hh.chaos.add(Rule(replace(lambda c: dict(c.out, title=title)), kinds="profile", step="profile"))
        o = hh.outcome()
        hh.start()
        hh.wait()
        hh.settle()
        r = hh.run()
        p = r.get("problem") or {}
        o.status = r.get("status")
        o.problem_code = str(p.get("code") or "")
        o.problem_message = scrub(p.get("message"))
        o.problem_fix = scrub(p.get("fix"))
        al = r.get("alert") or {}
        o.alert = {k: scrub(al.get(k)) for k in ("category", "label", "why", "next") if al.get(k)}
        if r.get("status") == "done":
            o.final_status = "done"
            o.problem_code = o.problem_message = o.problem_fix = ""
            o.alert = {}
            o.happened = f"{label}the book finished (assembled, exported and checked) with nothing lost."
            return hh.finish_outcome(o)
        words = [f"{label}stopped at “{p.get('step') or r.get('current')}” with {o.problem_code}: "
                 f"“{o.problem_message}” (alert category “{al.get('category')}”)."]
        o.issues.append(f"the book stops at “{p.get('step')}” because of the title")
        if "G05" in o.problem_message and "title" not in o.problem_message.lower():
            o.issues.append("the message names “G05”, not the title")
        if al.get("category") == "ai":
            o.risks.append("the alert calls it an AI problem")
        # 1) 🔁 Try again without changing anything
        if "retry" in (p.get("options") or []):
            hh.app.autobook.decide("author", hh.run_id, {"action": "retry"})
        else:
            hh.app.autobook.resume("author", hh.run_id)
        hh.wait()
        r1 = hh.run()
        words.append(f"Try again: {r1.get('status')} {(r1.get('problem') or {}).get('code')}.")
        # 2) rename the book to a plain title, then ▶ Resume (what A-2-u saw fail)
        pid = r1["project_id"]
        save_profile(hh.app.store, pid, {"title": "The Sea Book"})
        st = {s["id"]: s for s in _bp(hh, r1).status()["steps"]}
        hh.app.autobook.resume("author", hh.run_id)
        hh.wait()
        hh.settle()
        r2 = hh.run()
        p2 = r2.get("problem") or {}
        words.append(f"Renamed to a Latin title (book checklist: format “{st['format']['state']}”"
                     f"{' out of date' if st['format'].get('out_of_date') else ''}), ▶ Resume: {r2.get('status')} "
                     f"{p2.get('code') or ''} “{scrub(p2.get('message'))}”.")
        if r2.get("status") != "done":
            o.issues.append(f"after renaming, Resume still cannot finish ({p2.get('code')}: “{scrub(p2.get('message'))}”)"
                            " — the run does not go back to remake the format")
            # 3) the way out: make the format again by hand (Book format page), then Resume
            bp = _bp(hh, r2)
            try:
                bp.a_setup_format({})
                stf = {s["id"]: s for s in bp.status()["steps"]}["format"]
                for i in stf.get("approve") or []:
                    bp.approve_ref(bp.rec(i["record_id"])["ref"])
            except Exception as exc:  # noqa: BLE001
                words.append(f"Making the format again by hand failed ({type(exc).__name__}).")
            hh.app.autobook.resume("author", hh.run_id)
            hh.wait()
            hh.settle()
            r3 = hh.run()
            words.append(f"After the author made and approved the format again by hand, ▶ Resume: {r3.get('status')} "
                         f"{(r3.get('problem') or {}).get('code') or ''}.")
            o.final_status = r3.get("status")
        else:
            o.final_status = "done"
        o.happened = " ".join(words)
        return hh.finish_outcome(o)
    o = one(h, "كتاب البحر", "Arabic title: ")
    with Harness(h.id, h.section, h.part, h.stress, h.title, seed=h.seed, time_limit=h.time_limit) as h2:
        o2 = one(h2, "The Sea 🌊 Book", "Emoji title: ")
    with Harness(h.id, h.section, h.part, h.stress, h.title, seed=h.seed, time_limit=h.time_limit) as h3:
        o3 = one(h3, "Ọkọ̀ Ojú Omi — Москва, Ἀθῆναι", "Yorùbá + Cyrillic + Greek title (fonts can print it): ")
    out = o.worst(o2).worst(o3)
    from akowe.exporters.unifont import uncovered  # noqa: PLC0415
    from akowe.exporters.unifont import printable  # noqa: PLC0415
    cover = {n: ("□ in the PDF only (never stops the book)" if uncovered(s) else
                 "left out (invisible)" if s and not printable(s) else "prints") for n, s in (
        ("Yorùbá ọ ẹ ṣ with tone marks", "Ọkọ̀ ẹ̀ ṣ"), ("Greek", "Ἀθῆναι"), ("Cyrillic", "Москва"),
        ("Vietnamese", "Tiếng Việt"), ("Arabic", "كتاب"), ("Hebrew", "ספר"), ("Chinese / Japanese", "海の本"),
        ("Hindi (Devanagari)", "हिन्दी"), ("emoji", "🌊"), ("byte-order mark U+FEFF", "﻿"),
        ("NUL", "\x00"), ("zero-width space / joiner", "​‍"), ("right-to-left override", "‮"))}
    out.notes.append("What the PDF fonts can print (exporters.unifont.uncovered / printable): "
                     + "; ".join(f"{k}: {v}" for k, v in cover.items()) + ".")
    return out


@SEC.stress("15", "l", "characters the PDF fonts cannot print in the chapter text, typed by the author (Chinese, "
                       "Hebrew, Hindi); and a NUL byte", likely=LIKELY)
def f15_l(h: Harness) -> Outcome:
    def one(hh: Harness, add: str, label: str) -> Outcome:
        hh.make_app()
        info: dict = {}

        def edit(run):
            cid, appr, _l = _chapters(hh, run)[0]
            info["rid"], info["text"] = appr["record_id"], appr["data"]["text"]
            info["edit"] = _hand_edit(hh, appr["record_id"], appr["data"]["text"] + add)
        hh.at_step("assemble", before=edit)
        hh.on_fix(lambda: _hand_edit(hh, info["rid"], info["text"]))

        def check(h3, run):
            iss, risk = _final_check(h3, run), []
            p = h3.first_problem or {}
            if p and not any(w in str(p.get("message") or "") for w in ("chapter", "Chapter")):
                risk.append("the stop does not say which chapter holds the characters")
            return iss, risk
        o = _run(hh, label=label, check=check)
        o.notes.append(f"The author's edit: {info.get('edit')}.")
        return o
    o = one(h, " She wrote 海の本, ספר and हिन्दी on the wall.", "Chinese + Hebrew + Hindi words added to chapter 1: ")
    with Harness(h.id, h.section, h.part, h.stress, h.title, seed=h.seed, time_limit=h.time_limit) as h2:
        o2 = one(h2, " A NUL\x00 byte.", "A NUL byte added to chapter 1: ")
    return o.worst(o2)


@SEC.stress("15", "m", "a 60-chapter book through format, assemble, export and the content check (timings)",
            likely=LIKELY, time_limit=900.0)
def f15_m(h: Harness) -> Outcome:
    return _sixty_for("15")(h)


@SEC.stress("15", "n", "a chapter of about 1 MB (the author pastes a whole manuscript into chapter 2)",
            likely=UNLIKELY, time_limit=600.0)
def f15_n(h: Harness) -> Outcome:
    h.make_app()
    times: dict = {}
    _time_steps(h, times)
    info: dict = {}
    para = "The tide rose over the harbor wall and the gulls cried as night {} came down on the town. "
    big = "\n\n".join("".join(para.format(i * 10 + j) for j in range(10)) for i in range(1150))

    def edit(run):
        cid, appr, _l = _chapters(h, run)[1]
        info["edit"] = _hand_edit(h, appr["record_id"], big)
    h.at_step("format", before=edit)
    o = _run(h, label=f"Chapter 2 replaced by {len(big) // 1024} KB of text and approved: ", check=_final)
    o.notes.append(f"The edit: {info.get('edit')}. Akọwe's own work: format {times.get('format')} s, assemble "
                   f"{times.get('assemble')} s, export {times.get('export')} s, content check {times.get('check')} s.")
    slow = {k: v for k, v in times.items() if v and v > 60}
    if slow:
        o.risks.append("slow with a 1 MB chapter: " + ", ".join(f"{k} {v} s" for k, v in slow.items()))
        o = h.finish_outcome(o)
    return o


@SEC.stress("15", "o", "the author saves a new (unapproved) draft of chapter 1 while the book is being put together",
            likely=LIKELY)
def f15_o(h: Harness) -> Outcome:
    h.make_app()
    info: dict = {}
    h.markers.append("QZXDRAFTEDIT")

    def draft(orig, self, *a, **k):
        if not info.get("done"):
            info["done"] = True
            cid, appr, _l = _chapters(h)[0]
            info["rid"] = appr["record_id"]
            info["edit"] = _hand_edit(h, appr["record_id"], appr["data"]["text"] + " QZXDRAFTEDIT", approve=False)
        return orig(self, *a, **k)
    _wrap(h, BookPath, "a_assemble", draft)

    def check(hh, run):
        iss, risk = _final_check(hh, run), []
        if run.get("status") == "done":
            latest = next((c[2] for c in _chapters(hh, run) if c[2] and c[2]["record_id"] == info.get("rid")), None)
            epub = _zip_text(_file_bytes(hh, run, "EPUB"))
            if "QZXDRAFTEDIT" in epub:
                iss.append("the unapproved draft went into the exported book")
            if latest and latest.get("lifecycle") not in ("APPROVED",):
                risk.append(f"the run finished while the author's newer draft of chapter 1 is still waiting "
                            f"({latest.get('lifecycle')}); the files carry the older approved text and the finished "
                            "run does not mention the waiting draft")
        return iss, risk
    return _run(h, label="A new draft of chapter 1 saved during assembly (not approved): ", check=check)


# ============================================================================================== part 16: export
def _pdf_writer(h: Harness, fn):
    """Replace the PDF writer used by G11 (akowe.modules.set_g.render_pdf) with ``fn(orig, *a, **k)``."""
    from akowe.modules import set_g  # noqa: PLC0415
    orig = set_g.render_pdf

    def w(*a, **k):
        return fn(orig, *a, **k)
    h.patch(set_g, "render_pdf", w)


_register_std("16", "export", _boom("export"))


@SEC.stress("16", "a", "the AI times out → no AI here: the PDF writer is slow (3 s once; every file 3 s), and the "
                       "PDF writer stuck until removed")
def f16_a(h: Harness) -> Outcome:
    out = _std_a("export")(h)
    with Harness(h.id, h.section, h.part, h.stress, h.title, seed=h.seed, time_limit=12.0) as h2:
        h2.make_app()
        ev = threading.Event()
        state: dict = {}

        def stuck(orig, *a, **k):
            state["in"] = True
            ev.wait(120)
            return orig(*a, **k)
        _pdf_writer(h2, stuck)
        h2.on_fix(ev.set)
        o = h2.outcome()
        h2.start()
        done = h2.wait(limit=12.0)
        words = []
        if not done:
            # what the author can do while it hangs: ⏸ Pause, then ✖ Cancel
            r = h2.raw()
            h2.pause()
            time.sleep(2)
            r_p = h2.raw()
            words.append(f"PDF writer stuck: after 12 s the run still said “{scrub(r.get('phase'))}” (status "
                         f"{r.get('status')}); ⏸ Pause → status {r_p.get('status')} (“{scrub(r_p.get('phase'))}”) "
                         f"while the writer stays stuck.")
            if r_p.get("status") in ("running", "pausing"):
                o.risks.append("a stuck PDF writer has no time limit: the run keeps working forever; ⏸ Pause only "
                               "says “" + scrub(r_p.get("phase")) + "” (there is no AI answer in this step) and takes "
                               "effect only when the writer returns")
            h2.fix()
            h2.wait(limit=30)
            r2 = h2.run()
            words.append(f"When the writer came back the run ended as {r2.get('status')}.")
            if r2.get("status") == "paused":
                ok = h2.resume()
                r2 = h2.run()
                words.append(f"▶ Resume: {r2.get('status')}.")
            o.status = "hang"
            o.final_status = r2.get("status") or ""
            o.issues += _final_check(h2, r2)
        else:
            o.status = o.final_status = h2.run().get("status")
        o.happened = " ".join(words)
        stuck_o = h2.finish_outcome(o)
    return out.worst(stuck_o)


@SEC.stress("16", "c", "every AI at its usage limit → no AI here: the disk is full while the PDF is written "
                       "(ENOSPC), then space is freed")
def f16_c(h: Harness) -> Outcome:
    h.make_app()
    real = store_mod.replace_file
    cnt = {"n": 0}

    def full(tmp, path, *a, **k):
        if h.current_step() == "export":
            cnt["n"] += 1
            raise OSError(28, "No space left on device")
        return real(tmp, path, *a, **k)
    h.patch(store_mod, "replace_file", full)
    o = _run(h, label="Disk full (ENOSPC) for every exported file, then space freed: ", check=_final)
    o.notes.append(f"{cnt['n']} file write(s) failed.")
    leftovers = [p.name for p in (h.tmp / "data" / "assets").glob("*") if ".tmp" in p.name or p.name.startswith(".")]
    if leftovers:
        o.risks.append(f"{len(leftovers)} temp file(s) left in the assets folder after the failed writes")
        o = h.finish_outcome(o)
    return _note(o, "the disk is full while the exported file is written")


@SEC.stress("16", "d", "garbage answer → no AI here: the PDF writer returns garbage bytes (not a PDF); and a "
                       "broken Word file (truncated zip)")
def f16_d(h: Harness) -> Outcome:
    h.make_app()
    _pdf_writer(h, lambda orig, *a, **k: b"<html>not a pdf at all</html>")
    o = _run(h, label="PDF writer returns garbage: ", check=_final)
    with Harness(h.id, h.section, h.part, h.stress, h.title, seed=h.seed, time_limit=h.time_limit) as h2:
        h2.make_app()
        from akowe.modules import set_g  # noqa: PLC0415
        orig = set_g.build_docx
        h2.patch(set_g, "build_docx", lambda *a, **k: orig(*a, **k)[:200])
        o2 = _run(h2, label="Word writer returns a truncated zip (200 bytes): ", check=_final)
    return _note(o.worst(o2), "garbage output of the file writers")


@SEC.stress("16", "e", "empty answer → no AI here: the PDF writer returns 0 bytes")
def f16_e(h: Harness) -> Outcome:
    h.make_app()
    _pdf_writer(h, lambda orig, *a, **k: b"")
    o = _run(h, label="PDF writer returns 0 bytes: ", check=_final)
    return _note(o, "empty output of the PDF writer")


@SEC.stress("16", "j", "the most likely real-life problem: the disk fills up while the PDF is being written (the "
                       "PDF fails, EPUB and Word were fine); space is freed, ▶ Resume", likely=LIKELY)
def f16_j(h: Harness) -> Outcome:
    h.make_app()
    real = store_mod.replace_file
    cnt = {"n": 0}
    from akowe.modules import set_g  # noqa: PLC0415
    flag = {"pdf": False}
    orig_pdf = set_g.render_pdf

    def mark(*a, **k):
        flag["pdf"] = True
        return orig_pdf(*a, **k)
    h.patch(set_g, "render_pdf", mark)

    def full(tmp, path, *a, **k):
        if flag["pdf"] and h.current_step() == "export" and cnt["n"] < 1:
            cnt["n"] += 1
            flag["pdf"] = False
            raise OSError(28, "No space left on device")
        return real(tmp, path, *a, **k)
    h.patch(store_mod, "replace_file", full)

    def check(hh, run):
        iss, risk = _final_check(hh, run), []
        p = hh.first_problem or {}
        msg = (str(p.get("message") or "") + " " + " ".join(map(str, p.get("details") or [])) + " " +
               str(p.get("fix") or "")).lower()
        if p and "disk" not in msg and "space" not in msg:
            risk.append("the stop does not say the disk is full (it says “" + scrub(p.get("message")) + "” / fix “"
                        + scrub(p.get("fix")) + "”)")
        return iss, risk
    o = _run(h, label="Disk full while the PDF is written: ", check=check)
    o.notes.append(f"Failed writes: {cnt['n']}. First problem details: "
                   f"{scrub('; '.join(map(str, (h.first_problem or {}).get('details') or [])))}")
    return o


@SEC.stress("16", "k", "the author edits and re-approves a chapter between assemble and export", likely=LIKELY)
def f16_k(h: Harness) -> Outcome:
    h.make_app()
    h.markers.append("QZXNEWTEXT")
    info: dict = {}

    def edit(run):
        cid, appr, _l = _chapters(h, run)[0]
        info["edit"] = _hand_edit(h, appr["record_id"], appr["data"]["text"] + " QZXNEWTEXT")
    h.at_step("export", before=edit)

    def check(hh, run):
        iss = _final_check(hh, run)
        if run.get("status") == "done":
            epub = _zip_text(_file_bytes(hh, run, "EPUB"))
            docx = _zip_text(_file_bytes(hh, run, "DOCX"))
            if "QZXNEWTEXT" not in epub or "QZXNEWTEXT" not in docx:
                iss.append("the exported files do NOT carry the author's approved edit of chapter 1 (they were made "
                           "from the older assembly) and the run says done")
        return iss, []
    o = _run(h, label="Chapter 1 edited and approved after the book was put together: ", check=check)
    o.notes.append(f"The edit: {info.get('edit')}.")
    return o


@SEC.stress("16", "l", "a stored file is damaged between writing and the re-read (bytes flipped; then truncated)",
            likely=UNLIKELY)
def f16_l(h: Harness) -> Outcome:
    def one(hh: Harness, fmt: str, how: str, label: str) -> Outcome:
        hh.make_app()
        state = {"n": 0}
        # damage the asset file on disk right after export wrote it, before the re-read
        orig_export = BookPath.a_export

        def export_then_damage(self, body):
            out = orig_export(self, body)
            st = {s["id"]: s for s in self.status()["steps"]}["export"]
            for f in st.get("files") or []:
                if f["format"] == fmt and state["n"] == 0:
                    state["n"] += 1
                    rec = self.store.get_record(self.pid, self.branch, f["record_id"], f["version"])
                    path = self.store.asset_dir / rec["binary"]["storage_uri"].split("/")[-1]
                    data = path.read_bytes()
                    path.write_bytes(data[: len(data) // 2] if how == "truncate" else
                                     data[:100] + bytes(b ^ 0xFF for b in data[100:140]) + data[140:])
                    state["path"], state["data"] = path, data
            return out
        hh.patch(BookPath, "a_export", export_then_damage)
        if how != "truncate":
            hh.on_fix(lambda: state.get("path") and state["path"].write_bytes(state["data"]) and None)
        o = _run(hh, label=label, check=_final)
        return o
    o = one(h, "EPUB", "flip", "The stored EPUB gets 40 bytes flipped before the re-read: ")
    with Harness(h.id, h.section, h.part, h.stress, h.title, seed=h.seed, time_limit=h.time_limit) as h2:
        o2 = one(h2, "DOCX", "truncate", "The stored Word file is cut in half before the re-read (fix: not restored, "
                                         "the author just presses Resume): ")
    return o.worst(o2)


@SEC.stress("16", "m", "the books folder (where the finished files are copied, auto-save on) is read-only / the disk "
                       "is full when the files are copied", likely=LIKELY)
def f16_m(h: Harness) -> Outcome:
    from akowe import book_save  # noqa: PLC0415
    os.environ["AKOWE_AUTOSAVE"] = "1"
    try:
        h.make_app()
        cnt = {"n": 0}
        real = os.replace

        def ro(src, dst, *a, **k):
            if str(os.environ.get("AKOWE_BOOKS_DIR", "")) in str(dst):
                cnt["n"] += 1
                raise OSError(30, "Read-only file system")
            return real(src, dst, *a, **k)
        h.patch(book_save.os, "replace", ro)

        def check(hh, run):
            iss, risk = _final_check(hh, run), []
            try:
                hh.app.saver.wait_idle(20, timers=False)
            except Exception:  # noqa: BLE001
                pass
            last = hh.app.store.get_setting(f"book_save:{run['project_id']}:{run.get('branch_id') or BR}") or {}
            pub = hh.run()
            told = "save" in (str(pub.get("save") or "") + str(pub.get("alert") or "")).lower() or \
                bool((pub.get("save") or {}).get("problem"))
            hh.save_info = {"ok": last.get("ok"), "problem": scrub(str(last.get("problem"))), "writes": cnt["n"],
                            "run_save": scrub(str(pub.get("save")))[:200]}
            if cnt["n"] and last.get("ok"):
                iss.append("the save is recorded as OK although no file could be written")
            if cnt["n"] and not told:
                risk.append("the finished run does not tell the author the files could not be copied to the books "
                            "folder")
            return iss, risk
        o = _run(h, label="Books folder read-only (EROFS on every copy): ", check=check)
        o.notes.append(f"Save result: {getattr(h, 'save_info', {})}.")
        return o
    finally:
        os.environ["AKOWE_AUTOSAVE"] = "0"


@SEC.stress("16", "n", "the AutoInjector render bridge (it prints the Book Bible PDF for the books folder) is missing, "
                       "then hangs", likely=LIKELY, time_limit=120.0)
def f16_n(h: Harness) -> Outcome:
    from akowe import forge, render  # noqa: PLC0415
    os.environ["AKOWE_AUTOSAVE"] = "1"
    try:
        h.make_app()
        calls = {"n": 0}

        def hangs(app, html, **k):
            calls["n"] += 1
            time.sleep(8)
            raise forge.ArtProblem("RENDER_TIMEOUT")
        h.patch(render, "render_pdf", hangs)
        t0 = time.monotonic()
        o = _run(h, label="Render bridge answers only after 8 s with a timeout: ", check=_final)
        o.notes.append(f"Render calls: {calls['n']}; run + resume took {round(time.monotonic() - t0, 1)} s; the book "
                       "PDF itself never uses the render bridge (Akọwe's own PDF writer). With no bridge at all "
                       "(the harness default, 127.0.0.1:9) every other scenario finishes.")
        return o
    finally:
        os.environ["AKOWE_AUTOSAVE"] = "0"


@SEC.stress("16", "o", "a 60-chapter book through export (timings; same run as F-15-m)", likely=LIKELY,
            time_limit=900.0)
def f16_o(h: Harness) -> Outcome:
    return _sixty_for("16")(h)


# ============================================================================================== part 17: check
_register_std("17", "check", _boom("check"))


@SEC.stress("17", "d", "garbage answer → no AI here: the content check's own result is malformed (findings is a "
                       "string, no status)")
def f17_d(h: Harness) -> Outcome:
    h.make_app()

    def garbage(orig, bp, op, act, kw):
        r = orig(bp, op, act, **kw)
        return dict(r, result={"findings": "garbage", "status": None})
    _on_dispatch(h, "H05", garbage, step="check")
    o = _run(h, label="H05 answers with a malformed result: ", check=_final)
    return _note(o, "a malformed result of the content check")


@SEC.stress("17", "e", "empty answer → no AI here: the content check's result is empty ({})")
def f17_e(h: Harness) -> Outcome:
    h.make_app()

    def empty(orig, bp, op, act, kw):
        r = orig(bp, op, act, **kw)
        return dict(r, result={})
    _on_dispatch(h, "H05", empty, step="check")
    o = _run(h, label="H05 answers with an empty result: ", check=_final)
    if "None" in (o.problem_message or ""):
        o.risks.append(f"the stop says “{o.problem_message}” — no words for the author")
        o = _redo(o)
    return _note(o, "an empty result of the content check")


@SEC.stress("17", "j", "the most likely real-life problem: the author deletes (archives) a chapter's approved text "
                       "while the book is being checked", likely=LIKELY)
def f17_j(h: Harness) -> Outcome:
    h.make_app()
    info: dict = {}

    def delete(run):
        cid, appr, _l = _chapters(h, run)[1]
        info["rid"] = appr["record_id"]
        try:
            res = h.app.engine.store  # noqa: F841 - the store exists
            bp = _bp(h, run)
            r = bp.dispatch("C02", "ARCHIVE", base_ref=appr["ref"], payload={})
            info["archive"] = r.get("status"), [e.get("code") for e in r.get("errors") or []]
        except Exception as exc:  # noqa: BLE001
            info["archive"] = type(exc).__name__
    h.at_step("check", before=delete)

    def check(hh, run):
        iss = _final_check(hh, run)
        return iss, []
    o = _run(h, label="The author deletes (archives) chapter 2's approved text just before the content check: ",
             check=check)
    a = info.get("archive")
    o.happened = (f"The delete was refused ({a[0]} {', '.join(a[1])}): an approved chapter cannot be archived, so the "
                  "check runs on the intact book. " if isinstance(a, tuple) and a[0] != "DRAFT" else
                  f"Archive answer: {a}. ") + o.happened
    return o


@SEC.stress("17", "k", "the author edits and re-approves a chapter after the export, before the content check",
            likely=LIKELY)
def f17_k(h: Harness) -> Outcome:
    h.make_app()
    h.markers.append("QZXLATEEDIT")
    info: dict = {}

    def edit(run):
        cid, appr, _l = _chapters(h, run)[2]
        info["edit"] = _hand_edit(h, appr["record_id"], appr["data"]["text"] + " QZXLATEEDIT")
    h.at_step("check", before=edit)

    def check(hh, run):
        iss = _final_check(hh, run)
        if run.get("status") == "done":
            epub = _zip_text(_file_bytes(hh, run, "EPUB"))
            if "QZXLATEEDIT" not in epub:
                iss.append("the run says done but the files do not carry the author's approved edit of chapter 3")
        return iss, []
    o = _run(h, label="Chapter 3 edited and approved after the export: ", check=check)
    o.notes.append(f"The edit: {info.get('edit')}.")
    return o


@SEC.stress("17", "l", "two chapters with the same text (the AI wrote chapter 2 twice)", likely=LIKELY)
def f17_l(h: Harness) -> Outcome:
    h.make_app()
    first: dict = {}

    def same(c):
        cid = ((c.ctx.get("request_payload") or {}).get("chapter_id"))
        if cid == "ch1":
            first["text"] = c.out["text"]
        if cid == "ch2" and first.get("text"):
            return dict(c.out, text=first["text"])
        return c.out
    h.chaos.add(Rule(replace(same), kinds="C02", name="same-text"))

    def author_fix():  # what the author does after the stop: rewrite chapter 2 by hand and approve it
        chs = _chapters(h)
        if len(chs) > 1 and chs[1][1]:
            first["edit"] = _hand_edit(h, chs[1][1]["record_id"], "Chapter two, rewritten by the author. The fog "
                                       "lifted at noon and the bells rang twice over the empty quay.")
    h.on_fix(author_fix)

    def check(hh, run):
        iss, risk = _final_check(hh, run), []
        if run.get("status") == "done":
            chs = _chapters(hh, run)
            texts = [(c[1] or {}).get("data", {}).get("text") for c in chs]
            if len(texts) > 1 and texts[0] == texts[1]:
                risk.append("a book whose chapters 1 and 2 have the same text passed the content check and was "
                            "exported")
        return iss, risk
    o = _run(h, label="Chapter 2 written with chapter 1's text (the author rewrites chapter 2 as the fix): ",
             check=check)
    o.notes.append(f"The author's rewrite: {first.get('edit')}.")
    p = (o.problem_message or "")
    if p.strip() == "Content check: FAIL.":
        o.risks.append("the stop says only “Content check: FAIL.” — not which chapters are duplicated")
    return _redo(o)


@SEC.stress("17", "m", "a second run / the author puts the book together again by hand while the check runs (two "
                       "runs touching the same book)", likely=UNLIKELY)
def f17_m(h: Harness) -> Outcome:
    h.make_app()
    info: dict = {}

    def again(orig, self, *a, **k):
        if not info.get("done"):
            info["done"] = True
            try:
                bp2 = BookPath(h.app.engine, "author", self.pid, self.branch)
                info["assemble"] = bp2.a_assemble({}).get("ok")
            except Exception as exc:  # noqa: BLE001
                info["assemble"] = type(exc).__name__ + ": " + scrub(getattr(exc, "message", "") or exc)[:120]
        return orig(self, *a, **k)
    _wrap(h, BookPath, "a_check", again)
    o = _run(h, label="The book is put together again by hand at the moment the content check starts: ",
                   check=_final)
    o.notes.append(f"The second assembly: {info.get('assemble')}.")
    return o


@SEC.stress("17", "n", "a 60-chapter book through the content check (same run as F-15-m)", likely=LIKELY,
            time_limit=900.0)
def f17_n(h: Harness) -> Outcome:
    return _sixty_for("17")(h)


@SEC.stress("17", "o", "the program stops in the middle of the content check, after H05 was stored but before the "
                       "step was marked done; then Resume", likely=UNLIKELY)
def f17_o(h: Harness) -> Outcome:
    def arm(hh):
        def stop(orig, self, *a, **k):
            orig(self, *a, **k)
            raise SimulatedCrash("stopped after H05 was stored")
        _wrap(hh, BookPath, "a_check", stop)
    return h.crash_restart(arm, label="Stopped after H05 was stored: ", check=_final)


# ============================================================================================== analysed findings
# (filled in after the runs; see the report)
_ALERT_WHERE = ("akowe/akowe/alerts.py `category_of` (line ~83-106): the steps format / assemble / export / check are not "
                "in `STEP_CAT` (line ~53) and INTERNAL_ERROR / UPSTREAM_UNAVAILABLE / CAPABILITY_UNAVAILABLE are in "
                "`AI_CODES` (line ~57), so every stop here falls through to “ai”; the message comes from "
                "akowe/akowe/book_path.py `StepError` (line ~1256: “<op> could not be created (<status>).”) via "
                "akowe/akowe/autobook.py `_run` (line ~1495)")
_ALERT_CAUSE = ("Section F's parts make no AI call, but the alert's category is chosen from the problem code and the "
                "step; neither knows these steps, so the author reads “AI problem — The AI could not do this step (a "
                "usage limit, the connection or an error)” and “connect or switch an AI first”. A refusal of a module "
                "is shown as its code (“G05 could not be created (BLOCKED).”) while the plain reason sits only in the "
                "problem's details.")
_ALERT_FIX = ("Add format / assemble / export / check to `STEP_CAT` as a “book” category (“Putting the book "
              "together”), and build the message from the first error of the refusal (e.g. “The disk is full”, “These "
              "letters cannot be printed: …”) instead of the module code.")


def _alert_finding(rid: str, what: str, likely: str = UNLIKELY, extra: str = ""):
    SEC.finding(rid, where=_ALERT_WHERE, cause=_ALERT_CAUSE + extra, fix=_ALERT_FIX, severity="confusing message",
                likely=likely, what=what)


_alert_finding("F-14-c", "Disk full while the format is made: the stop says “I01 could not be created (BLOCKED).” "
               "and calls it an AI problem; nothing says the disk is full (Resume finishes once space is free)",
               extra=" The engine's own words (“storage unavailable: database or disk is full”) are only in the "
                     "details.")
_alert_finding("F-14-e", "An empty stored title stops the format with the right words (“Fill in the book profile (at "
               "least the title) first.”) but the alert calls it an AI problem")
_alert_finding("F-14-f", "The format module refusing is shown as “I01 could not be created (BLOCKED).”, called an AI "
               "problem")
_alert_finding("F-15-c", "Disk full while the book is put together: “G02 could not be created (BLOCKED).”, called an "
               "AI problem", likely=LIKELY)
_alert_finding("F-15-f", "An assembly module refusing (G05) is shown as “G05 could not be created (BLOCKED).”, called "
               "an AI problem")
_alert_finding("F-16-c", "Disk full for every exported file: “Some files could not be made.”, called an AI problem; "
               "Resume finishes once space is free", likely=LIKELY)
_alert_finding("F-16-f", "Every export module refusing: “Some files could not be made.”, called an AI problem")
_alert_finding("F-16-l", "A stored file damaged before the re-read stops with “stored artifact bytes do not match "
               "their hash” (programmer's words), called an AI problem")
_alert_finding("F-17-c", "Disk full while the content check is stored: “H05 could not be created (BLOCKED).”, called "
               "an AI problem")
_alert_finding("F-17-f", "The content check refusing: “H05 could not be created (BLOCKED).”, called an AI problem")
_alert_finding("F-17-e", "An empty content-check result stops with “Content check: None.” (no words for the author), "
               "called an AI problem", extra=" `a_check` (book_path.py line ~1247) formats the raw status into the "
                                             "message, so a missing status reads “None”.")
_G_WHERE = ("akowe/akowe/autobook.py `_run` (line ~1510: any exception → INTERNAL_ERROR “Akọwe hit an unexpected "
            "problem”) and akowe/akowe/alerts.py `category_of` (INTERNAL_ERROR in `AI_CODES`)")
for _rid in ("F-14-g", "F-15-g", "F-16-g", "F-17-g"):
    SEC.finding(_rid, where=_G_WHERE, cause="As A-2-g: a bug in Akọwe's own code is filed under “AI problem”. The stop "
                "itself is correct (no traceback in the problem, Resume finishes once the fault is gone).",
                fix="Give “Akọwe hit an unexpected problem” its own category (“Akọwe problem — please send 📋 Copy "
                    "diagnostics”).", severity="confusing message", likely=UNLIKELY,
                what="A bug in the part's own code is shown as an “AI problem”")

_BACK_WHERE = ("akowe/akowe/autobook.py `_s_assemble` / `_s_export` / `_s_check` (lines ~4463-4500, ~4665): each one "
               "only does its own step; akowe/akowe/book_path.py `a_assemble` (line ~1141 “Approve every chapter and "
               "the book format first.”), `a_export` (line ~1199) and `a_check` (line ~1244 “Put the book together and "
               "approve it first.”) refuse when an EARLIER step became out of date; the run resumes at its current "
               "step (autobook.py `_run`, line ~1371) and never goes back")
_BACK_FIX = ("When an earlier book step is no longer done, make it again inside the current step, as "
             "improve_pass._export_again already does (format → assemble → export → check, deterministic, no AI), "
             "and say so in a note (“Chapter 1 changed: the book was put together again”).")
SEC.finding("F-14-j", where=_BACK_WHERE + "; the out-of-date test is `BookPath.format_out_of_date` (line ~462)",
            cause="Renaming the book (or changing the page size) after the format was made marks the format out of "
                  "date (title / author / trim in the I01 records differ from the profile). `_s_assemble` calls "
                  "`a_assemble`, which refuses; 🔁 Try again and ▶ Resume start again at assemble and refuse the same "
                  "way, for ever. This is the root cause of the second half of A-2-u.",
            fix=_BACK_FIX, severity="blocks the book needlessly", likely=LIKELY,
            what="Renaming the book or changing the page size after the format step makes the run stop at assemble "
                 "with “Approve every chapter and the book format first.”, and Resume can never finish it")
SEC.finding("F-15-k", where="akowe/akowe/modules/set_g.py G05 `build` (line ~687-691: `uncovered(...)` → "
            "CAPABILITY_UNAVAILABLE BLOCKED); akowe/akowe/book_path.py `StepError` message (“G05 could not be created "
            "(BLOCKED).”); akowe/akowe/autobook.py `_s_profile` (takes any title); then the same no-going-back as "
            "F-14-j (`a_assemble` line ~1141)",
            cause="A-2-u CONFIRMED and narrowed down. (1) The Arabic / emoji title stops the book at assemble: G05 "
                  "checks the WHOLE manuscript, title page included, against the PDF fonts; one letter blocks all "
                  "three files. (2) 🔁 Try again repeats the same refusal. (3) After renaming to a Latin title, ▶ "
                  "Resume stops with “Approve every chapter and the book format first.” because the format (made "
                  "with the old title) is now out of date and the run does not go back to remake it (F-14-j). (4) "
                  "NEW: the way out exists — make the book format again by hand on the Book format page, approve it, "
                  "press ▶ Resume: the book then finishes with nothing lost; but nothing tells the author to do that. "
                  "(5) NEW: Yorùbá with tone marks, Greek, Cyrillic and Vietnamese titles print fine; Arabic, Hebrew, "
                  "Chinese / Japanese, Hindi, emoji, a byte-order mark and NUL block (see the note).",
            fix="Check the title with `exporters.unifont.uncovered` when the profile is made / saved and say it then; "
                "at G05 name the characters and where they are (“the title”); after a rename, remake the format "
                "inside the assemble step (F-14-j's fix).",
            severity="blocks the book needlessly", likely=LIKELY,
            what="A-2-u confirmed: an Arabic or emoji title stops the book at assemble (“G05 could not be created "
                 "(BLOCKED)”, called an AI problem); Try again repeats it; renaming then Resume fails because the "
                 "format is out of date; only remaking the format by hand gets the book out")
SEC.finding("F-15-j", where="akowe/akowe/modules/set_g.py G05 `build` (line ~687-691) blocks the whole assembly; "
            "the warning at approval (akowe/akowe/book_path.py `letters_warning`, line ~98) is only returned to a "
            "hand approval, not to the run",
            cause="One character the PDF fonts cannot print (an emoji the AI wrote; an invisible byte-order mark "
                  "pasted from Notepad / Word) anywhere in one chapter blocks G05, so nothing is assembled and NO "
                  "file is made — also the EPUB and Word files that could carry it. The stop names “G05”, not the "
                  "chapter or the character; the alert says “AI problem”.",
            fix="Strip U+FEFF / zero-width / control characters from chapter text when it is saved; in the run, check "
                "`letters_warning` right after each chapter is approved and ask the writer to rewrite the sentence; "
                "let EPUB / Word be made even when only the PDF cannot print a letter.",
            severity="blocks the book needlessly", likely=LIKELY,
            what="An emoji written by the AI, or an invisible byte-order mark in pasted text, stops the whole book at "
                 "assemble with “G05 could not be created (BLOCKED)”")
SEC.finding("F-15-l", where="as F-15-j (set_g.py G05 `build` line ~687-691)",
            cause="Chinese, Hebrew or Hindi words (or a NUL byte) in a chapter block G05 the same way; the stop does "
                  "not say which chapter. After the author removed them and approved, ▶ Resume finished the book.",
            fix="As F-15-j: name the chapter and the letters in the stop; warn at approval in the run too.",
            severity="confusing message", likely=LIKELY,
            what="Foreign-script words typed into a chapter stop the book at assemble without saying which chapter")
SEC.finding("F-15-e", where="akowe/akowe/book_path.py `a_assemble` (line ~1136) and the H05 content check (set_h.py) "
            "accept any approved chapter text",
            cause="A chapter of one character (“.”) can be saved and approved (only whitespace-only text is refused); "
                  "it is assembled, exported and passes H05. The only sign is the general BOOK_TOO_SHORT note.",
            fix="In `_s_assemble` (or H05) warn about a chapter far below its planned length (e.g. under 10 % of the "
                "chapter target), naming it.", severity="cosmetic", likely=UNLIKELY,
            what="A practically empty chapter goes into the finished book without a word about that chapter")
SEC.finding("F-15-o", where="akowe/akowe/autobook.py `_s_assemble` / `_s_export` use the APPROVED versions "
            "(book_path.py `a_assemble` line ~1143); nothing looks for newer unapproved drafts",
            cause="The author's newer draft of chapter 1 (saved during the run, not approved) is left waiting: the "
                  "files carry the older approved text (correct) but the finished run does not mention the waiting "
                  "draft, so the author may think the book contains it.",
            fix="At the end of the run, list chapters whose newest draft is not approved (“Chapter 1 has a newer "
                "draft you have not approved: the files carry the approved text”).",
            severity="confusing message", likely=LIKELY,
            what="A newer, unapproved draft saved during the run is silently left out of the files")
SEC.finding("F-14-d", where="akowe/akowe/book_path.py `ref_ok` (line ~340-343: `ref[\"record_id\"]` on a non-dict) "
            "called from `status()` (line ~665); `_s_format` (autobook.py line ~4455)",
            cause="A wrong-typed entry in the book's path memory (`book_path:<pid>:<branch>` setting: e.g. a list "
                  "where a record reference should be) raises TypeError inside `status()`. The run stops with "
                  "“unexpected problem (TypeError)” (an “AI problem”), and Resume repeats it for ever. `status()` is "
                  "also the book page's checklist, so the book page breaks the same way.",
            fix="In `ref_ok` return None for anything that is not a dict with record_id / version (and log it once): "
                "the step then makes the format again.", severity="blocks the book needlessly", likely=UNLIKELY,
            what="A damaged remembered format (wrong types) stops the run with an unexpected TypeError that Resume "
                 "can never get past")
SEC.finding("F-15-d", where="as F-14-d (`ref_ok` line ~343, via `status()` line ~679)",
            cause="As F-14-d for the remembered assembly.", fix="As F-14-d.",
            severity="blocks the book needlessly", likely=UNLIKELY,
            what="A damaged remembered assembly stops the run with an unexpected TypeError that Resume can never get "
                 "past")
SEC.finding("F-16-d", where="akowe/akowe/autobook.py `_s_export` (line ~4480: `if s[\"state\"] != \"done\"` — when "
            "the files exist the step only re-reads them, line ~4490-4496)",
            cause="A bad file that was stored once (here: the PDF writer returned garbage; the Word writer a "
                  "truncated zip) makes the checklist's export step “done”, so every 🔁 Try again / ▶ Resume only "
                  "re-reads the same stored bad file and stops again with HASH_MISMATCH “The PDF file does not read "
                  "back…”. The files are never made again, even after the cause is gone.",
            fix="When the re-read fails, make that file again once (call `_export_under_consent`) before stopping; "
                "never store a file that `verify_file` refuses.", severity="blocks the book needlessly",
            likely=UNLIKELY,
            what="A file that failed its re-read once is never made again: Try again / Resume loop on the same bad "
                 "file for ever")
SEC.finding("F-16-e", where="as F-16-d", cause="As F-16-d with an empty (0-byte) PDF.", fix="As F-16-d.",
            severity="blocks the book needlessly", likely=UNLIKELY,
            what="An empty PDF that was stored once is never made again; Resume loops on it")
SEC.finding("F-16-j", where="akowe/akowe/store.py `insert_binary_record` (line ~944-958, a good plain message “Akọwe "
            "could not save the file (is the disk full…”) → akowe/akowe/book_path.py `a_export` (line ~1233: "
            "`problems_.append(f\"{name}: {exc.message}\")` keeps the module's refusal text) → autobook.py "
            "`_s_export` (line ~4485: “Some files could not be made.” / “Press 🔁 Try again.”)",
            cause="The disk-full words from the store are lost on the way: G11's refusal reaches the run as a "
                  "module error, the stop says only “Some files could not be made.” and the fix only “Press 🔁 Try "
                  "again.”; the alert says “AI problem”. After space was freed, Resume made the files and finished.",
            fix="Carry the store's message into the problem (“The disk is full: free some space, then press 🔁 Try "
                "again”), category “book”.", severity="confusing message", likely=LIKELY,
            what="Disk full while the PDF is written: the stop says only “Some files could not be made.”, not that the "
                 "disk is full")
SEC.finding("F-16-k", where=_BACK_WHERE, cause="The author approved a new version of chapter 1 after the book was put "
            "together: the assembly is out of date, `a_export` refuses (“Put the book together and approve it "
            "first.”), and Resume starts again at export and refuses again — the run never puts the book together "
            "again by itself.", fix=_BACK_FIX, severity="blocks the book needlessly", likely=LIKELY,
            what="Editing and approving a chapter between assemble and export stops the run at export, and Resume can "
                 "never finish it")
SEC.finding("F-17-k", where=_BACK_WHERE, cause="As F-16-k one step later: a chapter approved after the export makes "
            "the assembly out of date; `a_check` refuses and Resume repeats it.", fix=_BACK_FIX,
            severity="blocks the book needlessly", likely=LIKELY,
            what="Editing and approving a chapter after the export stops the run at the content check, and Resume can "
                 "never finish it")
SEC.finding("F-17-l", where=_BACK_WHERE + "; the H05 FAIL message is built in `a_check` (line ~1247-1249)",
            cause="H05 correctly refuses a book whose chapters 1 and 2 have the same text, but the stop says only "
                  "“Content check: FAIL.” (the duplicate is in the details). The author does what the fix says — "
                  "rewrites chapter 2 and approves it — and ▶ Resume then stops with “Put the book together and approve "
                  "it first.” for ever (the F-16-k root cause). Also the duplicate passed every chapter review and "
                  "was only caught at the very end.",
            fix=_BACK_FIX + " Put the first H05 finding in the message (“Chapter 2 has the same text as chapter 1”).",
            severity="blocks the book needlessly", likely=LIKELY,
            what="A duplicated chapter is caught only at the content check (“Content check: FAIL.”), and after the "
                 "author rewrites it Resume can never finish")
SEC.finding("F-17-d", where="akowe/akowe/book_path.py `a_check` (line ~1249: `f.get(...)` over `findings`)",
            cause="A malformed H05 result (findings not a list of objects) raises AttributeError in `a_check`: "
                  "“unexpected problem (AttributeError)”, called an AI problem. Resume finishes once H05 answers "
                  "normally.", fix="Read the H05 result defensively (non-dict findings → “the content check's answer "
                                   "could not be read”).", severity="confusing message", likely=UNLIKELY,
            what="A malformed content-check result is an unexpected AttributeError")
SEC.finding("F-17-m", where="akowe/akowe/autobook.py `_s_check` / `_run` (the step is marked done from the run's own "
            "view, line ~1430) and akowe/akowe/book_path.py `a_assemble` (line ~1136, no lock against a running run)",
            cause="Putting the book together again by hand (or a second run) while the run's content check works "
                  "replaces the remembered assembly with an unapproved one. The run still finishes as “done” with "
                  "the files of the older assembly, while the book's own checklist now says “Put the book together: "
                  "needs you”, export and check blocked — the two disagree and the author is not told.",
            fix="Refuse a hand assembly / export while a Make-a-book run of the same book is working (the run's "
                "book lock), or re-check the checklist before marking the run done.",
            severity="confusing message", likely=UNLIKELY,
            what="A second assembly during the content check leaves a run that says done next to a book whose "
                 "checklist says the book must be put together again")
SEC.finding("F-16-a", where="akowe/akowe/autobook.py `_s_export` → akowe/akowe/modules/set_g.py G11 `render_pdf` "
            "(no time limit around Akọwe's own PDF writer); the pause words at autobook.py line ~931",
            cause="The book PDF is written in-process (no AutoInjector); when the writer is stuck nothing times out. ⏸ "
                  "Pause shows “Pausing after the current answer…” although no AI answer is awaited, and takes "
                  "effect only when the writer returns (then Resume finished).",
            fix="Say “Pausing after this step…” in steps without AI calls; consider a generous time limit for the "
                "file writers with a plain stop (“Making the PDF took too long”).",
            severity="confusing message", likely=UNLIKELY,
            what="A stuck PDF writer keeps the run working with no time limit; Pause talks about an AI answer")
SEC.finding("F-14-k", where="akowe/akowe/book_path.py `title_author` / `metadata` (line ~436-450): no length limit "
            "outside the profile form (which refuses titles over 200 characters)",
            cause="A 3,000-character title from stored data (an import, an older version) goes unshortened into the "
                  "files' metadata and file records; control characters in the author are dropped by the writers "
                  "(“Ann⧵0e ESC[31mBell” becomes “Anne [31mBell”).", fix="Clip and clean title / author in "
                  "`metadata()` the same way the profile form does.", severity="cosmetic", likely=UNLIKELY,
            what="A very long stored title is used unshortened in the exported files")
SEC.finding("F-16-l", where="akowe/akowe/store.py `read_binary` (line ~454-471: HASH_MISMATCH “stored artifact bytes "
            "do not match their hash”) reached through akowe/akowe/autobook.py `_s_export` (line ~4490) and the "
            "no-remake path of F-16-d (line ~4480)",
            cause="The re-read rightly catches a damaged stored file, but (1) the stop is in programmer's words and "
                  "called an AI problem, and (2) when the damaged file is not restored (a disk error, a cleaned-up "
                  "assets folder), Resume only re-reads the same damaged file: the step is “done” in the checklist, "
                  "so the file is never made again (as F-16-d). When the bytes were restored, Resume finished.",
            fix="On HASH_MISMATCH / NOT_FOUND of an exported file, make that file again once before stopping; say "
                "“The saved PDF file is damaged — Akọwe made it again” or, if that fails, “check the disk”.",
            severity="blocks the book needlessly", likely=UNLIKELY,
            what="A damaged stored export is never made again: Resume loops on the same HASH_MISMATCH")
