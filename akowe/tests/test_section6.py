"""Section 6: 💾 P20 save the book (one folder per book: finished book, chapters, book bible, reports, log, progress,
book.akowe; automatic and debounced progress saves; atomic writes; Windows-safe names; no secrets) and 📂 P21 open
a saved book (package round trip as a NEW book, continue an unfinished one, refuse damaged / newer packages, a
book-bible.json alone) and 🔁 rerun from the book bible (same characters, world and plan; new chapters), plus the
localhost-only folder routes."""
from __future__ import annotations

import errno
import hashlib
import io
import json
import time
import types
import zipfile
from collections import Counter
from pathlib import Path

import pytest

from akowe import book_bible, book_package, book_save
from akowe import providers as prov_mod
from akowe.book_path import BookPath, save_profile
from akowe.book_report import book_chapters
from akowe.errors import AkoweError

from autobook_fake import BookFakeAI
from test_autobook import make_app
from test_server import TOKEN, call, server  # noqa: F401


@pytest.fixture(autouse=True)
def no_provider_sleep(monkeypatch):
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))


@pytest.fixture(autouse=True)
def autosave_on(monkeypatch):
    monkeypatch.setenv("AKOWE_AUTOSAVE", "1")


def route(app, method, path, body=None, query=None, headers=None):
    return app.route(method, path, query or {}, body, "author", headers or {})


def new_app(tmp_path, name="data", fake=None, books="books"):
    fake = fake or BookFakeAI()
    app = make_app(tmp_path, name=name, fake=fake)
    route(app, "PUT", "/api/settings/books-folder", {"path": str(tmp_path / books)})
    app.saver.launch = lambda p: None  # never open a real file manager in tests
    return app, fake


def run_book(app, body=None, timeout=240):
    r = app.autobook.start("author", dict({"author_confirms": True}, **(body or {})))
    app.autobook.wait_for(r["id"], timeout)
    assert app.saver.wait_idle(60)
    return app.autobook.public(app.autobook.get(r["id"]))


def files_of(folder: Path) -> dict:
    return {p.relative_to(folder).as_posix(): p.read_bytes() for p in folder.rglob("*") if p.is_file()}


def chapters(app, pid):
    return [(c["chapter_id"], c["text"], c["approved"]) for c in book_chapters(BookPath(app.engine, "author", pid,
                                                                                        "main"))]


def export_hashes(app, pid):
    st = {s["id"]: s for s in BookPath(app.engine, "author", pid, "main").status()["steps"]}
    return sorted((f["format"], f["sha256"], f["out_of_date"]) for f in st["export"]["files"])


def problem_of(exc):
    e = exc.errors[0]
    return e.get("problem") or e["code"]


# ============================================================================================ P20 the folder
def test_folder_layout_and_contents_after_a_finished_run(tmp_path):
    app, fake = new_app(tmp_path)
    run = run_book(app)
    assert run["status"] == "done", run.get("problem")
    pid = run["project_id"]
    last = app.saver.last(pid)
    assert last["ok"] and last["finished"] and last["kind"] == "auto", last
    # debounced while the run worked (one progress save, the rest waited), then one full save when it finished
    assert app.saver.count[(pid, "main")] == 2 and not app.saver._timers
    folder = Path(last["path"])
    title = BookPath(app.engine, "author", pid, "main").profile["title"]
    assert folder.parent == tmp_path / "books" and folder.name == f"{title} ({book_save.short_id(pid)})"
    f = files_of(folder)
    # Book/: the three exports, byte for byte the stored (verified) files
    stems = sorted(k for k in f if k.startswith("Book/"))
    assert stems == sorted(f"Book/{title}.{e}" for e in ("pdf", "epub", "docx"))
    by_fmt = {x["format"]: x["sha256"] for x in run["files"]}
    for fmt, ext in (("PDF", "pdf"), ("EPUB", "epub"), ("DOCX", "docx")):
        assert hashlib.sha256(f[f"Book/{title}.{ext}"]).hexdigest() == by_fmt[fmt]
    # Chapters/: one file per chapter, approved text, "01 - …" names
    chs = chapters(app, pid)
    cfiles = sorted(k for k in f if k.startswith("Chapters/"))
    assert len(cfiles) == len(chs) and cfiles[0].startswith("Chapters/01 - ") and cfiles[0].endswith(".md")
    for (cid, text, approved), name in zip(chs, cfiles):
        body = f[name].decode("utf-8")
        assert approved and "approved (version" in body and "DRAFT" not in body
        assert text.strip().splitlines()[-1] in body
    # Book Bible/
    bible = json.loads(f["Book Bible/book-bible.json"])
    assert bible["schema_version"] == 1 and bible["kind"] == "akowe-book-bible" and bible["app_version"]
    assert bible["saved_at"] and bible["profile"]["title"] == title and bible["pipeline"]["preset"] == "full"
    assert bible["characters"] and all(c["module_id"] == "A01" and c["sheet"] and c["voice"] and c["approved"]
                                       for c in bible["characters"])
    assert any(c["module_id"] == "A04" for c in bible["canon"])
    assert set(bible["plan"]) == {"premise", "main_plot", "outline"}
    assert bible["plan"]["outline"]["data"]["chapters"] and bible["scene_cards"]
    assert bible["story_rules"] and bible["world_texture"]
    md = f["Book Bible/book-bible.md"].decode("utf-8")
    assert "## Characters" in md and bible["characters"][0]["name"] in md and "Voice card" in md and "## Story rules" in md
    # Reports/, Log/, Progress/, package, README, marker
    assert f["Reports/Book report.md"].startswith(b"#") and f["Reports/Book report.pdf"].startswith(b"%PDF")
    assert "Planned to page" in f["Reports/Planned to page.md"].decode() and b"Editor summary" in f["Reports/Editor summary.md"]
    assert "Book journal" in f["Log/Book journal.md"].decode("utf-8")
    ev = json.loads(f["Log/run-events.json"])
    r0 = ev["runs"][0]
    assert r0["id"] == run["id"] and r0["status"] == "done" and r0["steps"][0]["id"] == "backup"
    assert r0["ai_per_step"].get("chapters") and any(s["ai"] for s in r0["steps"])
    assert all(s["started_at"] for s in r0["steps"] if s["state"] == "done")
    prog = json.loads(f["Progress/progress.json"])
    assert prog["finished"] is True and prog["next_step"] is None and prog["run"]["status"] == "done"
    assert zipfile.ZipFile(io.BytesIO(f["book.akowe"])).read("manifest.json")
    readme = f["README.txt"].decode("utf-8")
    assert "Book Bible/" in readme and "Open a saved book" in readme and "Rerun" in readme and title in readme
    marker = json.loads(f[".akowe-folder.json"])
    assert marker["project_id"] == pid and set(marker["files"]) == set(f) - {".akowe-folder.json"}
    # the run window carries the save; the book page's status says where
    assert app.autobook.public(app.autobook.get(run["id"]))["save"]["last"]["path"] == str(folder)
    st = route(app, "GET", f"/api/projects/{pid}/branches/main/save")[1]
    assert st["path"] == str(folder) and st["last"]["ok"] and st["opened"]["finished"] is True
    # nothing Akọwe did not write is touched, and every full path is short enough for Windows
    (folder / "my notes.txt").write_text("mine")
    app.saver.save_now(pid, "main")
    assert (folder / "my notes.txt").read_text() == "mine"
    assert max(len(str(p)) for p in folder.rglob("*")) <= book_save.MAX_PATH


def test_no_keys_tokens_or_prompts_in_any_saved_file(tmp_path):
    app, fake = new_app(tmp_path)
    secret = "sk-ant-api03-TOPSECRET-0123456789abcdef"
    app.engine.providers.configure_slot("AI-2", {"adapter_id": "anthropic", "api_key": secret})
    run = run_book(app)
    assert run["status"] == "done", run.get("problem")
    folder = Path(app.saver.last(run["project_id"])["path"])
    texts = []
    for rel, data in files_of(folder).items():
        texts.append((rel, data))
        if rel.endswith(".akowe"):
            z = zipfile.ZipFile(io.BytesIO(data))
            texts += [(f"{rel}!{n}", z.read(n)) for n in z.namelist()]
    prompts = {s for kind in fake.prompts.values() for s, _ctx in kind}
    assert prompts
    for rel, data in texts:
        assert secret.encode() not in data, rel
        assert TOKEN.encode() not in data, rel
        assert app.token.encode() not in data, rel
        for p in prompts:  # no system prompt / task text was stored anywhere
            assert p[:80].encode("utf-8") not in data, (rel, p[:80])
    # the guard itself: a secret that reached a text is replaced
    assert book_package.guard(f"x {secret} y", [secret]) == "x [redacted] y"


def test_progress_saves_are_debounced_and_forced_on_pause(tmp_path):
    import threading
    app, fake = new_app(tmp_path)
    run = run_book(app)
    pid = run["project_id"]
    key = (pid, "main")
    sv = app.saver
    n0 = sv.count[key]
    sv.interval_s = 30
    sv._last[key] = time.monotonic()  # a save just happened
    for _ in range(5):
        sv.auto(pid, "main", reason="chapter approved")
    assert sv.wait_idle(10)
    assert sv.count[key] == n0 and key in sv._timers  # nothing now: one save waits for the end of the interval
    sv.auto(pid, "main", reason="run paused", force=True)  # a pause/cancel/finish saves at once
    assert sv.wait_idle(30) and sv.count[key] == n0 + 1 and key not in sv._timers
    sv.interval_s = 0.3
    sv._last[key] = time.monotonic()
    sv.auto(pid, "main", reason="approval")
    assert sv.wait_idle(10, timers=True) and sv.count[key] == n0 + 2  # the timer saved the newest state
    # auto-save off: nothing; a manual save still works
    route(app, "PUT", "/api/settings/books-folder", {"auto_save": False})
    sv.auto(pid, "main", reason="x", force=True)
    assert sv.wait_idle(10) and sv.count[key] == n0 + 2
    assert route(app, "POST", f"/api/projects/{pid}/branches/main/save")[0] == 202
    assert sv.wait_idle(30) and sv.count[key] == n0 + 3
    route(app, "PUT", "/api/settings/books-folder", {"auto_save": True})
    # a run that is paused: its progress is saved (unfinished, the run's state in Progress/)
    fake.gate = threading.Event()
    r = app.autobook.start("author", {"author_confirms": True})
    assert fake.waiting.wait(30)
    app.autobook.pause("author", r["id"])
    fake.gate.set()
    app.autobook.wait_for(r["id"], 60)
    assert app.saver.wait_idle(60)
    paused = app.autobook.get(r["id"])
    assert paused["status"] == "paused"
    if paused.get("project_id"):
        last = app.saver.last(paused["project_id"])
        assert last["ok"] and last["finished"] is False
        prog = json.loads((Path(last["path"]) / "Progress" / "progress.json").read_text())
        assert prog["finished"] is False and prog["run"]["status"] == "paused" and prog["next_step"]
    fake.gate = None


def test_writes_are_atomic_and_a_full_disk_is_a_plain_problem(tmp_path, monkeypatch):
    app, fake = new_app(tmp_path)
    run = run_book(app)
    pid = run["project_id"]
    folder = Path(app.saver.last(pid)["path"])
    before = files_of(folder)
    save_profile(app.store, pid, {"tone": "Somebody Else"})  # the bible changes -> files must be rewritten
    real = book_save.replace_file
    calls = {"n": 0}

    def flaky(src, dst):
        calls["n"] += 1
        if calls["n"] == 2:
            raise OSError(errno.ENOSPC, "No space left on device")
        return real(src, dst)
    monkeypatch.setattr(book_save, "replace_file", flaky)
    with pytest.raises(book_save.SaveProblem) as x:
        app.saver.save_now(pid, "main")
    assert x.value.code == "SAVE_DISK_FULL"
    after = files_of(folder)
    assert not [k for k in after if ".tmp-" in k]  # no half-written temp file stays behind
    assert set(after) == set(before)
    for k, v in after.items():  # every file is complete: the old version or the whole new one
        if k.endswith(".json"):
            json.loads(v)
    zipfile.ZipFile(io.BytesIO(after["book.akowe"])).testzip()
    # the background save records the problem (never raises), the next save works again
    calls["n"] = 1
    app.saver.start(pid, "main", kind="manual")
    assert app.saver.wait_idle(30)
    last = app.saver.last(pid)
    assert last["ok"] is False and last["problem"]["code"] == "SAVE_DISK_FULL" and "space" in last["problem"]["fix"]
    monkeypatch.setattr(book_save, "replace_file", real)
    assert app.saver.save_now(pid, "main")["ok"]
    assert b"Somebody Else" in (folder / "Book Bible" / "book-bible.json").read_bytes()
    # classify maps the other system errors to plain codes
    assert book_save.classify(OSError(errno.EACCES, "denied")).code == "SAVE_FOLDER_NOT_WRITABLE"
    assert book_save.classify(OSError(errno.ENAMETOOLONG, "long")).code == "SAVE_PATH_TOO_LONG"
    assert book_save.classify(ValueError("x")).code == "SAVE_FAILED"


def test_a_new_title_keeps_the_folder(tmp_path):
    app, fake = new_app(tmp_path)
    run = run_book(app)
    pid = run["project_id"]
    first = Path(app.saver.last(pid)["path"])
    save_profile(app.store, pid, {"title": "A Completely New Title"})
    res = app.saver.save_now(pid, "main")
    assert res["path"] == str(first) and first.is_dir()
    marker = json.loads((first / book_save.MARKER).read_text())
    assert marker["title"] == "A Completely New Title"
    names = sorted(p.name for p in (first / "Book").iterdir())
    # the files were made with the old title: kept as "(older version)" under the new name; the old names are gone
    assert names and all(n.startswith("A Completely New Title") and "(older version)" in n for n in names)
    assert len(list((tmp_path / "books").iterdir())) == 1


def test_windows_unsafe_titles_and_long_paths(tmp_path):
    assert book_save.safe_name("CON") == "_CON" and book_save.safe_name("lpt1.txt") == "_lpt1.txt"
    assert book_save.safe_name('a<b>:c"d/e\\f|g?h*i') == "a b c d e f g h i"
    assert book_save.safe_name("Trailing dots. . .") == "Trailing dots"
    assert book_save.safe_name("   ") == "Book" and book_save.safe_name("x\x00\x1fy") == "x y"
    assert len(book_save.safe_name("W" * 300, 60)) == 60
    app, fake = new_app(tmp_path)
    pid = app.engine.bootstrap_project("author", "CON")
    save_profile(app.store, pid, {"title": 'CON'})
    assert app.saver.book_folder(pid).name == f"_CON ({book_save.short_id(pid)})"
    save_profile(app.store, pid, {"title": "Ünïcödé: “The <Best>” Book?. "})
    pid2 = app.engine.bootstrap_project("author", "x")
    save_profile(app.store, pid2, {"title": "Ünïcödé: “The <Best>” Book?. "})
    name = app.saver.book_folder(pid2).name
    assert not set('<>:"/\\|?*') & set(name) and not name.endswith((" ", "."))
    res = app.saver.save_now(pid2, "main")  # an unfinished, empty book saves too (bible, progress, package)
    folder = Path(res["path"])
    assert (folder / "Book Bible" / "book-bible.json").is_file() and (folder / "book.akowe").is_file()
    assert json.loads((folder / "Progress" / "progress.json").read_text())["finished"] is False
    # a books folder whose path leaves no room for the book's own names is refused in plain words
    deep = tmp_path / ("d" * 70) / ("e" * 70)
    with pytest.raises(AkoweError) as x:
        route(app, "PUT", "/api/settings/books-folder", {"path": str(deep)})
    assert problem_of(x.value) == "SAVE_PATH_TOO_LONG"
    with pytest.raises(AkoweError) as x:
        route(app, "PUT", "/api/settings/books-folder", {"path": "relative/folder"})
    assert problem_of(x.value) == "SAVE_FOLDER_NOT_WRITABLE"
    (tmp_path / "afile").write_text("x")
    with pytest.raises(AkoweError) as x:
        route(app, "PUT", "/api/settings/books-folder", {"path": str(tmp_path / "afile" / "sub")})
    assert problem_of(x.value) == "SAVE_FOLDER_NOT_WRITABLE"
    with pytest.raises(AkoweError):
        route(app, "PUT", "/api/settings/books-folder", {"auto_save": "yes"})
    out = route(app, "GET", "/api/settings/books-folder")[1]
    assert out["path"] == str(tmp_path / "books") and out["writable"] and out["auto_save"] and out["local"]
    route(app, "PUT", "/api/settings/books-folder", {"path": ""})  # back to the default
    assert route(app, "GET", "/api/settings/books-folder")[1]["custom"] is False


def test_default_books_folder(monkeypatch, tmp_path):
    monkeypatch.delenv("AKOWE_BOOKS_DIR", raising=False)
    (tmp_path / "Documents").mkdir()
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    assert book_save.default_folder(windows=True) == tmp_path / "Documents" / "Akowe Books"
    assert book_save.default_folder(windows=False) == Path.home() / "Akowe Books"
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "nobody"))  # no Documents folder: the home folder
    assert book_save.default_folder(windows=True) == Path.home() / "Akowe Books"
    monkeypatch.setenv("AKOWE_AUTOSAVE", "0")
    assert book_save.autosave_default() is False


# ============================================================================================ P21 open
def test_package_round_trip_opens_a_new_identical_book(tmp_path):
    app, fake = new_app(tmp_path)
    run = run_book(app)
    pid = run["project_id"]
    folder = Path(app.saver.last(pid)["path"])
    data = (folder / "book.akowe").read_bytes()
    man = json.loads(zipfile.ZipFile(io.BytesIO(data)).read("manifest.json"))
    assert man["format"] == "akowe-package" and man["schema_version"] == 1 and man["project_id"] == pid
    assert man["counts"]["records"] > 10 and man["counts"]["assets"] >= 3
    before = {"chapters": chapters(app, pid), "exports": export_hashes(app, pid),
              "bible": book_bible.build(app, pid, "main")}
    # open from the books folder list (same computer: a NEW book, "(opened)" because the title exists)
    lst = route(app, "GET", "/api/books-folder")[1]
    row = next(r for r in lst["folders"] if r["name"] == folder.name)
    assert row["has_package"] and row["has_bible"] and row["finished"] and row["in_library"]
    st, res = route(app, "POST", "/api/books-folder/open", {"folder": folder.name})
    # the book is already on this computer: nothing is opened yet, the page asks "update / open as a copy"
    assert st == 200 and res["needs_choice"] and res["existing"]["project_id"] == pid and "project_id" not in res
    st, res = route(app, "POST", "/api/books-folder/open", {"folder": folder.name, "mode": "copy"})
    assert st == 201 and res["kind"] == "package" and res["project_id"] != pid and res["finished"] is True
    new = res["project_id"]
    assert res["name"].endswith("(opened)") and app.store.project(new)["name"] == res["name"]
    assert chapters(app, new) == before["chapters"]
    assert export_hashes(app, new) == before["exports"] and all(not x[2] for x in before["exports"])
    b2 = book_bible.build(app, new, "main")
    for k in ("profile", "choices", "pipeline", "story_rules", "world_texture", "scene_cards"):
        assert b2[k] == before["bible"][k], k
    assert [c["data"]["concept"] for c in b2["characters"]] == [c["data"]["concept"] for c in before["bible"]["characters"]]
    assert [c["sheet"] for c in b2["characters"]] == [c["sheet"] for c in before["bible"]["characters"]]
    assert b2["plan"]["outline"]["data"] == before["bible"]["plan"]["outline"]["data"]
    assert book_package.verify(app.store, new) == []
    status = BookPath(app.engine, "author", new, "main").status()
    assert status["next"] is None and all(s["state"] == "done" for s in status["steps"])
    # the shelf lists it with verified files; the original is untouched; the run was copied (done, not resumable)
    shelf = route(app, "GET", "/api/shelf")[1]
    assert any(b["project_id"] == new and b["all_verified"] for b in shelf["books"])
    assert chapters(app, pid) == before["chapters"]
    runs = app.jobstore.list(project_id=new, kind="autobook")
    assert len(runs) == 1 and runs[0]["status"] == "done" and runs[0]["id"] != run["id"]
    j = route(app, "GET", f"/api/projects/{new}/branches/main/journal")[1]
    assert j["count"] > 10
    # opening the same package again gives yet another new book; another computer gets the plain title
    again = app.opener.import_bytes("author", data, mode="copy")
    assert again["project_id"] not in (pid, new) and again["name"].endswith("(opened 2)")
    other, _ = new_app(tmp_path, name="data2", books="books2")
    res2 = other.opener.import_bytes("author", data)
    assert res2["name"] == app.store.project(pid)["name"]
    assert chapters(other, res2["project_id"]) == before["chapters"]
    assert export_hashes(other, res2["project_id"]) == before["exports"]
    assert route(other, "GET", "/api/shelf")[1]["books"][0]["all_verified"]


def test_continue_an_unfinished_opened_book(tmp_path):
    app, fake = new_app(tmp_path)
    fake.fail_kind("C02", AkoweError("TIMEOUT", "", "timed out"))
    run = run_book(app)
    assert run["status"] == "paused" and run["problem"]["code"] == "TIMEOUT"
    pid = run["project_id"]
    last = app.saver.last(pid)
    assert last["ok"] and last["finished"] is False
    data = (Path(last["path"]) / "book.akowe").read_bytes()
    # another computer: open it, continue it with a new run (the steps already done are skipped)
    fake2 = BookFakeAI()
    other, _ = new_app(tmp_path, name="data2", fake=fake2, books="books2")
    res = other.opener.import_bytes("author", data)
    new = res["project_id"]
    assert res["finished"] is False and res["resumable_run"] and res["resumable_run"]["status"] == "interrupted"
    st = route(other, "GET", f"/api/projects/{new}/branches/main/save")[1]
    assert st["opened"]["resumable_run"]["id"] == res["resumable_run"]["id"]
    st, r = route(other, "POST", "/api/autobook", {"author_confirms": True, "continue_project": new})
    assert st == 202 and r["project_id"] == new and r["settings"]["continue"]["project_id"] == new
    other.autobook.wait_for(r["id"], 240)
    assert other.saver.wait_idle(60)
    done = other.autobook.get(r["id"])
    assert done["status"] == "done", done.get("problem")
    k = Counter(fake2.kinds)
    assert not {"profile", "B01", "B03", "B11"} & set(k), k  # nothing made again before the chapters
    assert k["C02"] >= 1
    assert all(a for _c, _t, a in chapters(other, new))
    assert other.saver.last(new)["finished"] is True
    # the imported run itself can be resumed too (a second copy of the package)
    res3 = other.opener.import_bytes("author", data)
    rid = res3["resumable_run"]["id"]
    other.autobook.resume("author", rid)
    other.autobook.wait_for(rid, 240)
    assert other.autobook.get(rid)["status"] == "done"
    assert all(a for _c, _t, a in chapters(other, res3["project_id"]))
    with pytest.raises(AkoweError):
        route(other, "POST", "/api/autobook", {"author_confirms": True, "continue_project": "proj-nope"})


def _rewrite_zip(data: bytes, change) -> bytes:
    z = zipfile.ZipFile(io.BytesIO(data))
    items = {n: z.read(n) for n in z.namelist()}
    change(items)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as out:
        for n, b in items.items():
            out.writestr(n, b)
    return buf.getvalue()


def test_damaged_newer_and_foreign_packages_are_refused(tmp_path):
    app, fake = new_app(tmp_path)
    run = run_book(app)
    data = (Path(app.saver.last(run["project_id"])["path"]) / "book.akowe").read_bytes()
    n_books = len(app.store.query("SELECT 1 FROM projects"))

    def refused(blob, code):
        with pytest.raises(AkoweError) as x:
            route(app, "POST", "/api/books/open", blob, headers={"Content-Type": "application/octet-stream"})
        assert problem_of(x.value) == code, x.value.errors
        assert x.value.errors[0].get("fix")

    def flip(items):
        t = bytearray(items["book/tables.json"])
        t[100] = ord("x") if t[100] != ord("x") else ord("y")
        items["book/tables.json"] = bytes(t)
    refused(_rewrite_zip(data, flip), "OPEN_BAD_PACKAGE")  # a checksum does not match

    def newer(items):
        m = json.loads(items["manifest.json"])
        m["schema_version"] = 99
        items["manifest.json"] = json.dumps(m).encode()
    refused(_rewrite_zip(data, newer), "OPEN_NEWER_VERSION")

    def tamper_record(items):  # the record changed AND the checksum was recomputed: the record hash still catches it
        t = json.loads(items["book/tables.json"])
        rec = next(r for r in t["tables"]["records"] if r["representation"] == "JSON_RECORD")
        rec["content"]["$blob"] = rec["content"]["$blob"].replace('"version":', '"version": ', 1)
        items["book/tables.json"] = json.dumps(t).encode()
        m = json.loads(items["manifest.json"])
        m["files"]["book/tables.json"] = hashlib.sha256(items["book/tables.json"]).hexdigest()
        items["manifest.json"] = json.dumps(m).encode()
    refused(_rewrite_zip(data, tamper_record), "OPEN_BAD_PACKAGE")

    def drop_asset(items):
        name = next(n for n in items if n.startswith("assets/"))
        del items[name]
    refused(_rewrite_zip(data, drop_asset), "OPEN_BAD_PACKAGE")
    refused(data[: len(data) // 2], "OPEN_BAD_PACKAGE")  # a half-copied file
    refused(b"%PDF-1.4 not a package", "OPEN_BAD_PACKAGE")
    refused(_rewrite_zip(data, lambda items: items.update({"../evil": b"x"})), "OPEN_BAD_PACKAGE")
    assert len(app.store.query("SELECT 1 FROM projects")) == n_books  # nothing was created


def test_store_export_and_import_rows_never_overwrite(tmp_path):
    app, fake = new_app(tmp_path)
    pid = app.engine.bootstrap_project("author", "Rows")
    rows = app.store.export_project_rows(pid)
    assert rows["tables"]["projects"][0]["project_id"] == pid and rows["tables"]["feature_manifests"]
    with pytest.raises(AkoweError) as x:
        app.store.import_project_rows(rows["tables"], [], principal_id="author")
    assert x.value.code == "VERSION_CONFLICT"
    bad = dict(rows["tables"], projects=[dict(rows["tables"]["projects"][0], project_id="proj-other")])
    with pytest.raises(AkoweError):
        app.store.import_project_rows(bad, [], principal_id="author")
    assert app.store.project("proj-other") is None
    with pytest.raises(AkoweError):
        app.store.write_asset(b"bytes", "0" * 64)


# ============================================================================================ P21 rerun
def test_rerun_from_the_book_bible_makes_a_new_book_with_the_same_canon(tmp_path):
    app, fake = new_app(tmp_path)
    run = run_book(app)
    pid = run["project_id"]
    src = book_bible.build(app, pid, "main")
    k0 = len(fake.kinds)
    st, r = route(app, "POST", "/api/autobook", {"author_confirms": True, "from_bible": {"project_id": pid},
                                                 "reuse_plan": True})
    assert st == 202 and r["settings"]["bible"]["reuse_plan"] and r["settings"]["bible"]["key"]
    app.autobook.wait_for(r["id"], 240)
    assert app.saver.wait_idle(60)
    run2 = app.autobook.get(r["id"])
    assert run2["status"] == "done", run2.get("problem")
    new = run2["project_id"]
    assert new != pid and app.store.project(new)["name"].endswith("(rerun)")
    k = Counter(fake.kinds[k0:])
    assert "texture" not in k and k.get("rules", 0) <= 1, k  # the lists came from the bible (one update for the plan)
    assert not {"A01", "A04", "A03", "profile", "B01", "B03", "B11"} & set(k), k  # canon and plan came from the bible
    assert k["C02"] >= 1  # the chapters were written new
    b2 = book_bible.build(app, new, "main")
    assert [c["name"] for c in b2["characters"]] == [c["name"] for c in src["characters"]]
    assert [c["sheet"] for c in b2["characters"]] == [c["sheet"] for c in src["characters"]]
    assert [c["voice"] for c in b2["characters"]] == [c["voice"] for c in src["characters"]]
    assert all(c["approved"] for c in b2["characters"] + b2["canon"])
    assert sorted(c["name"] for c in b2["canon"]) == sorted(c["name"] for c in src["canon"])
    assert [t["detail"] for t in b2["world_texture"]] == [t["detail"] for t in src["world_texture"]]
    assert b2["plan"]["outline"]["data"]["chapters"] == src["plan"]["outline"]["data"]["chapters"]
    assert b2["profile"]["title"] == src["profile"]["title"]
    old_ids = {c[0] for c in chapters(app, pid)}
    new_recs = {c["record_id"] for c in book_chapters(BookPath(app.engine, "author", new, "main"))}
    assert old_ids == {c[0] for c in chapters(app, new)} and new_recs  # same chapter plan, new records
    assert not new_recs & {c["record_id"] for c in book_chapters(BookPath(app.engine, "author", pid, "main"))}
    ev = [e for e in run2["events"] if e.get("kind") in ("bible", "note")]
    assert any(e.get("code") == "BIBLE_RERUN" and "consent" in e["message"] for e in ev)
    assert any("taken from the book bible" in e["message"] for e in ev)
    appr = [json.loads(x["payload"]) for x in app.store.query(
        "SELECT payload FROM outbox WHERE project_id=? AND event_type='autobook.approved_under_consent'", (new,))]
    assert any(a["module_id"] == "A01" for a in appr) and any(a["module_id"] == "B11" for a in appr)
    # the source book is not changed; the new book is saved in its own folder
    assert chapters(app, pid) and app.saver.last(new)["path"] != app.saver.last(pid)["path"]
    # a new plan: the AI writes premise, plot and outline again (same characters)
    k1 = len(fake.kinds)
    r3 = app.autobook.start("author", {"author_confirms": True, "from_bible": {"project_id": pid}, "reuse_plan": False})
    app.autobook.wait_for(r3["id"], 240)
    run3 = app.autobook.get(r3["id"])
    assert run3["status"] == "done", run3.get("problem")
    k3 = Counter(fake.kinds[k1:])
    assert k3["B01"] == 1 and k3["B03"] == 1 and k3["B11"] == 1 and "A01" not in k3


def test_a_book_bible_alone_starts_a_new_book(tmp_path):
    app, fake = new_app(tmp_path)
    run = run_book(app)
    folder = Path(app.saver.last(run["project_id"])["path"])
    raw = json.loads((folder / "Book Bible" / "book-bible.json").read_text())
    raw["characters"][0]["data"]["concept"] = "Hand-edited Mara"
    raw["profile"]["title"] = "The Edited Keeper"
    blob = json.dumps(raw).encode()
    # multipart upload, as the browser sends it
    boundary = "----bf6"
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"book-bible.json\"\r\n"
            f"Content-Type: application/json\r\n\r\n").encode() + blob + f"\r\n--{boundary}--\r\n".encode()
    st, res = route(app, "POST", "/api/books/open", body,
                    headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    assert st == 201 and res["kind"] == "bible" and res["summary"]["title"] == "The Edited Keeper"
    assert route(app, "GET", f"/api/books/bible/{res['bible_id']}")[1]["summary"]["characters"]
    r = app.autobook.start("author", {"author_confirms": True, "from_bible": {"bible_id": res["bible_id"]}})
    app.autobook.wait_for(r["id"], 240)
    done = app.autobook.get(r["id"])
    assert done["status"] == "done", done.get("problem")
    b2 = book_bible.build(app, done["project_id"], "main")
    assert b2["profile"]["title"] == "The Edited Keeper"
    assert b2["characters"][0]["data"]["concept"] == "Hand-edited Mara"
    # the folder's bible also works directly (🔁 Rerun in the folder list)
    assert route(app, "GET", "/api/books-folder/bible", query={"folder": [folder.name]})[1]["summary"]["title"]
    # refused: not a bible, a newer one, broken JSON, no title
    for blob, code in ((b'{"kind": "something"}', "BIBLE_BAD"), (b"{not json", "BIBLE_BAD"),
                       (json.dumps(dict(raw, schema_version=7)).encode(), "OPEN_NEWER_VERSION"),
                       (json.dumps(dict(raw, profile={"title": ""})).encode(), "BIBLE_BAD")):
        with pytest.raises(AkoweError) as x:
            route(app, "POST", "/api/books/open", blob, headers={"Content-Type": "application/octet-stream"})
        assert problem_of(x.value) == code
    with pytest.raises(AkoweError) as x:
        app.autobook.start("author", {"author_confirms": True, "from_bible": {"bible_id": "bible-gone"}})
    assert problem_of(x.value) == "OPEN_NOT_FOUND"


# ============================================================================================ localhost only
def test_folder_routes_are_for_this_computer_only(server, tmp_path):  # noqa: F811
    app, port = server
    shown = []
    app.saver.launch = shown.append
    route(app, "PUT", "/api/settings/books-folder", {"path": str(tmp_path / "books")})
    status, body, _ = call(port, "GET", "/api/books-folder")  # a real request from 127.0.0.1
    assert status == 200 and body["path"] == str(tmp_path / "books")
    status, body, _ = call(port, "POST", "/api/books-folder/show", {})
    assert status == 200 and shown == [tmp_path / "books"]
    status, body, _ = call(port, "GET", "/api/settings/books-folder")
    assert body["local"] is True
    app.set_client("192.168.1.20")  # the same requests from another device
    try:
        for method, path, b, q in (("GET", "/api/books-folder", None, None), ("POST", "/api/books-folder/show", {}, None),
                                   ("POST", "/api/books-folder/open", {"folder": "x"}, None),
                                   ("GET", "/api/books-folder/bible", None, {"folder": ["x"]})):
            with pytest.raises(AkoweError) as x:
                route(app, method, path, b, q)
            assert x.value.code == "PERMISSION_DENIED" and problem_of(x.value) == "OPEN_NOT_LOCAL"
        assert route(app, "GET", "/api/settings/books-folder")[1]["local"] is False
    finally:
        app.set_client(None)
    assert len(shown) == 1
    # folder names are names, never paths
    for bad in ("../etc", "a/b", "..", "C:\\x", ""):
        with pytest.raises(AkoweError) as x:
            route(app, "POST", "/api/books-folder/open", {"folder": bad})
        assert problem_of(x.value) == "OPEN_NOT_FOUND"
