"""Regression tests for the fixes of the independent review (1080): the trailer's shot pictures in a stable,
content-addressed folder; the 10-minute save one book at a time; superseded videos / cover JPGs left out of
book.akowe and a plain warning when it is still too big to reopen; a failed section or a locked file never deletes
or aborts the rest of a save; the cleanup stays inside the book's folder; ⟳ update waits for (and stops) this book's
saves; a status check that times out is a miss; the map's Word copy goes to the same map; a moved music file is left
out of a new plan; an MP4 trailer is saved as .mp4; a double-click makes one dossier / character."""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from pathlib import Path

import pytest

from akowe import book_open, book_package, book_save, cover, forge, forge_kinds, pictures, trailer
from akowe.book_path import save_profile
from akowe.errors import AkoweError

from test_failover_review import SlotFake, make_app
from test_trailer import MP4, WEBM, bk, made, make, png, shots_of  # noqa: F401

BR = "main"


# ====================================================================== shared: a bare book with a books folder
@pytest.fixture
def sv(tmp_path):
    app = make_app(tmp_path, SlotFake(), slots=("AI-1",))
    app.route("PUT", "/api/settings/books-folder", {}, {"path": str(tmp_path / "books"), "auto_save": True},
              "author", {})
    app.saver.launch = lambda p: None
    pid = app.engine.bootstrap_project("author", "Salt book")
    save_profile(app.store, pid, {"title": "The Salt Road", "author": "Mara Vell"})
    yield app, pid
    app.saver.stop_periodic()
    app.saver.stop_timers()


def store_video(app, pid, data, label, mime="video/webm"):
    return forge._store_asset(app.store, "author", pid, BR, data, mime, label)  # noqa: SLF001


def set_trailer(app, pid, webm_asset, mp4_asset=None):
    d = trailer._empty()  # noqa: SLF001
    d["trailer"] = {"webm": webm_asset, "mp4": mp4_asset, "seconds": 3.0, "at": "2026-10-28T00:00:00Z"}
    app.store.set_setting(trailer._key(pid, BR), d)  # noqa: SLF001


def marker_files(folder: Path) -> list:
    return json.loads((folder / book_save.MARKER).read_text(encoding="utf-8"))["files"]


# ====================================================================== 1. trailer pictures: stable, by their bytes
def _chosen_picture(app, pid, data):
    chs = pictures.chapters(app, "author", pid, BR)
    pic_id = pictures.ensure_picture(app.store, pid, BR, "chapter", chs[0]["chapter_id"], None)
    asset = forge.store_picture(app.store, "author", pid, BR, data, "", "ch1")
    pictures.add_candidate(app.store, pid, BR, pic_id, dict(asset, source="upload"), choose=True)
    return pic_id


def test_trailer_pictures_keep_their_path_between_makes_and_are_tidied_only_after_storing(bk):  # noqa: F811
    app, pid, b = bk
    pic_id = _chosen_picture(app, pid, png(40, 30, (200, 40, 40)))
    trailer.save_plan(app, pid, BR, {"items": [{"type": "shot", "prompt": "a", "picture": {"kind": "chapter",
                                                                                            "id": pic_id}}]})
    j, _ = make(app, pid)
    assert j["status"] == "done", j
    j, _ = make(app, pid)
    assert j["status"] == "done", j
    first, second = (shots_of(r["items"])[0]["image"] for r in b.requests[:2])
    assert first == second and os.path.isfile(first)  # the same picture -> the same file: AutoInjector reuses its shot
    assert os.path.basename(first).split(".")[0] == hashlib.sha256(
        open(first, "rb").read()).hexdigest()
    # a new picture: a failed Make keeps every picture (AutoInjector may still be making that shot)
    _chosen_picture(app, pid, png(40, 30, (10, 200, 10)))
    b.results[3] = {"ok": False, "error": "VIDEO_FAILED", "shot": 1, "message": "Shot 1: no"}
    j, _ = make(app, pid)
    assert j["status"] == "error"
    third = shots_of(b.requests[2]["items"])[0]["image"]
    assert third != first and os.path.isfile(third) and os.path.isfile(first)
    # stored: the pictures this Make did not use are removed, its own stay for the next one
    j, _ = make(app, pid)
    assert j["status"] == "done", j
    assert shots_of(b.requests[3]["items"])[0]["image"] == third
    assert os.path.isfile(third) and not os.path.exists(first)


# ====================================================================== 7. a status check that times out is a miss
def test_a_status_check_that_times_out_is_a_miss_not_the_end(bk, monkeypatch):  # noqa: F811
    app, pid, b = bk
    trailer.save_plan(app, pid, BR, {"items": [{"type": "shot", "prompt": "a"}]})
    real = trailer._call  # noqa: SLF001
    n = {"timeouts": 0}

    def flaky(app_, targets, method, route, body=None, timeout_s=30.0):
        if method == "GET" and n["timeouts"] < 3:
            n["timeouts"] += 1
            raise forge.ArtProblem("VIDEO_TIMEOUT", "timed out")
        return real(app_, targets, method, route, body, timeout_s)
    monkeypatch.setattr(trailer, "_call", flaky)
    j, _ = make(app, pid)
    assert j["status"] == "done", j
    assert n["timeouts"] == 3
    # bounded: one that never answers still ends the job, in plain words
    n["timeouts"] = -10_000
    j, _ = make(app, pid)
    assert j["status"] == "error" and j["error"]["code"] == "VIDEO_TIMEOUT"


# ====================================================================== 9. "Plan a trailer": a moved music file
def test_plan_again_drops_a_music_file_that_was_moved(bk, tmp_path):  # noqa: F811
    app, pid, _b = bk
    song = tmp_path / "theme.ogg"
    song.write_bytes(b"OggS")
    trailer.save_plan(app, pid, BR, {"items": [{"type": "card", "text": "T"}], "music": str(song)})
    st, out = trailer.route(app, "POST", ["plan"], {}, None, "author", pid, BR, {})
    assert st == 200 and out["plan"]["music"] == str(song)  # still there: carried over
    song.unlink()
    st, out = trailer.route(app, "POST", ["plan"], {}, None, "author", pid, BR, {})
    assert st == 200 and out["plan"]["music"] is None
    assert any("was not found" in n for n in out["notes"])


# ====================================================================== 11. an MP4 main file is saved as .mp4
def test_an_mp4_trailer_is_saved_as_mp4_and_an_unreadable_one_is_kept(sv):
    app, pid = sv
    a = store_video(app, pid, MP4, "Book trailer", "video/mp4")
    set_trailer(app, pid, a)
    files, info = app.saver.collect(pid, BR)
    assert files["Trailer/trailer.mp4"] == MP4 and "Trailer/trailer.webm" not in files
    assert json.loads(files["Trailer/trailer.json"])["trailer"]["webm"] == "trailer.mp4"
    keep: set = set()
    set_trailer(app, pid, dict(a, asset_id="I01-gone"))
    f2: dict = {}
    trailer.save_files(app, pid, BR, f2, lambda rel, s: f2.__setitem__(rel, s.encode()), keep)
    assert keep == {"Trailer/trailer.mp4"} and "Trailer/trailer.mp4" not in f2


# ====================================================================== 4. a failed section keeps its old files
def test_a_failed_section_keeps_the_files_saved_before(sv, monkeypatch):
    app, pid = sv
    set_trailer(app, pid, store_video(app, pid, WEBM, "Book trailer"))
    cover.save(app, pid, BR, {"template": "thriller"})
    res = app.saver.save_now(pid, BR)
    folder = Path(res["path"])
    assert (folder / "Trailer" / "trailer.webm").is_file() and (folder / "Cover" / "cover-design.json").is_file()

    def boom(*a, **k):
        raise RuntimeError("broken")
    monkeypatch.setattr(trailer, "save_files", boom)
    monkeypatch.setattr(cover, "save_files", boom)
    assert app.saver.save_now(pid, BR)["ok"]
    assert (folder / "Trailer" / "trailer.webm").read_bytes() == WEBM
    assert (folder / "Cover" / "cover-design.json").is_file()
    assert "Trailer/trailer.webm" in marker_files(folder)  # still Akọwe's: a later good save may replace it
    monkeypatch.undo()
    # the trailer asset cannot be read (picture_bytes None): its file stays too
    real = forge.picture_bytes
    monkeypatch.setattr(forge, "picture_bytes", lambda s, p, b, a: None if (a or {}).get("mime", "").startswith(
        "video/") else real(s, p, b, a))
    assert app.saver.save_now(pid, BR)["ok"]
    assert (folder / "Trailer" / "trailer.webm").read_bytes() == WEBM


# ====================================================================== 5. a locked file does not abort the save
def test_a_file_open_in_another_program_is_skipped_not_fatal(sv, monkeypatch):
    app, pid = sv
    res = app.saver.save_now(pid, BR)
    folder = Path(res["path"])
    save_profile(app.store, pid, {"title": "The Salt Road", "author": "Somebody Else"})  # the bible changes
    real = book_save.write_atomic

    def locked(path, data):
        if path.name == "book-bible.md":
            raise PermissionError(13, "The process cannot access the file because it is being used by another process")
        return real(path, data)
    monkeypatch.setattr(book_save, "write_atomic", locked)
    out = app.saver.save_now(pid, BR)
    assert out["ok"] and out["skipped"] == ["Book Bible/book-bible.md"]
    assert out["warning"].startswith("Saved, except Book Bible/book-bible.md (open in another program")
    assert b"Somebody Else" in (folder / "Book Bible" / "book-bible.json").read_bytes()  # the rest was saved
    assert "Book Bible/book-bible.md" in marker_files(folder) and (folder / "Book Bible" / "book-bible.md").is_file()
    # the background save records the warning, not a problem
    app.saver.start(pid, BR, kind="manual")
    assert app.saver.wait_idle(30)
    last = app.saver.last(pid, BR)
    assert last["ok"] and last["problem"] is None and "Saved, except" in last["warning"]
    # a folder that cannot be written at all is still a plain problem
    monkeypatch.setattr(book_save, "write_atomic", lambda p, d: (_ for _ in ()).throw(PermissionError(13, "denied")))
    with pytest.raises(book_save.SaveProblem) as e:
        app.saver.save_now(pid, BR)
    assert e.value.code == "SAVE_FOLDER_NOT_WRITABLE"


# ====================================================================== 10. the cleanup stays inside the book's folder
def test_the_cleanup_never_leaves_the_books_folder(sv, tmp_path):
    app, pid = sv
    folder = Path(app.saver.save_now(pid, BR)["path"])
    outside = tmp_path / "precious.txt"
    outside.write_text("mine")
    (folder / "linked").symlink_to(tmp_path, target_is_directory=True)
    m = json.loads((folder / book_save.MARKER).read_text(encoding="utf-8"))
    m["files"] += ["../../precious.txt", str(outside), "linked/precious.txt", "Chapters/..\\..\\..\\precious.txt"]
    (folder / book_save.MARKER).write_text(json.dumps(m), encoding="utf-8")
    assert app.saver.save_now(pid, BR)["ok"]
    assert outside.read_text() == "mine"
    assert not book_save.inside(folder, "../x") and not book_save.inside(folder, "linked/precious.txt")
    assert book_save.inside(folder, "Chapters/01 - One.md") and not book_save.inside(folder, ".")


# ====================================================================== 2. the 10-minute save: one book at a time
def test_the_ten_minute_save_saves_one_book_at_a_time(sv, monkeypatch):
    app, pid = sv
    others = []
    for name in ("Two", "Three"):
        p = app.engine.bootstrap_project("author", f"{name} book")
        save_profile(app.store, p, {"title": f"The {name}"})
        others.append(p)
    real = app.saver.save_now
    now, peak, order = [0], [0], []
    lock = threading.Lock()

    def slow(pid_, branch="main", **kw):
        with lock:
            now[0] += 1
            peak[0] = max(peak[0], now[0])
            order.append(pid_)
        try:
            time.sleep(0.15)
            return real(pid_, branch, **kw)
        finally:
            with lock:
                now[0] -= 1
    monkeypatch.setattr(app.saver, "save_now", slow)
    queued = app.saver.periodic_tick()
    assert {(p, BR) for p in [pid, *others]} <= set(queued)
    assert app.saver.wait_idle(30)
    assert peak[0] == 1 and set(order) >= {pid, *others}  # every changed book saved, never two at once
    assert app.saver.periodic_tick() == []


# ====================================================================== 3. superseded videos / cover JPGs
def test_superseded_videos_and_cover_jpgs_are_left_out_of_the_package(sv):
    app, pid = sv
    old = store_video(app, pid, WEBM + b"old", "Book trailer")
    new = store_video(app, pid, WEBM + b"new", "Book trailer")
    own = store_video(app, pid, WEBM + b"mine", "my holiday.webm")  # the author's own upload: never left out
    jpg = forge._store_asset(app.store, "author", pid, BR, b"\xff\xd8\xff" + b"j" * 50, "image/jpeg",  # noqa: SLF001
                             "Ebook cover 1600 x 2560 (JPG)")
    set_trailer(app, pid, new)
    data = book_package.build(app, pid)
    pkg = book_package.read(data)  # still a package that opens
    rids = {r["record_id"] for r in pkg["tables"]["records"]}
    assert new["asset_id"] in rids and own["asset_id"] in rids
    assert old["asset_id"] not in rids and jpg["asset_id"] not in rids
    assert len(pkg["assets"]) == len(pkg["tables"]["binaries"])
    opened = book_package.import_package(app, data, "author", pkg=pkg)
    assert book_package.verify(app.store, opened["project_id"]) == []
    assert forge.picture_bytes(app.store, opened["project_id"], BR, new) == WEBM + b"new"


def test_a_package_too_big_to_reopen_is_a_plain_warning(sv, monkeypatch):
    app, pid = sv
    monkeypatch.setattr(book_package, "MAX_PACKAGE_BYTES", 100)
    out = app.saver.save_now(pid, BR)
    assert out["ok"] and "more than the 0 MB Akọwe can open again" in out["warning"]
    monkeypatch.undo()
    assert app.saver.save_now(pid, BR)["warning"] is None


# ====================================================================== 6. ⟳ update the one I have, while it saves
def test_update_waits_for_this_books_save_and_drops_its_pending_one(sv, monkeypatch):
    app, pid = sv
    app.saver.save_now(pid, BR)
    data = (app.saver.book_folder(pid, BR) / "book.akowe").read_bytes()
    gate, entered = threading.Event(), threading.Event()
    real = app.saver.save_now

    def held(pid_, branch="main", **kw):
        entered.set()
        gate.wait(10)
        return real(pid_, branch, **kw)
    monkeypatch.setattr(app.saver, "save_now", held)
    monkeypatch.setattr(book_open, "UPDATE_WAIT_S", 0.2)
    app.saver.start(pid, BR, kind="manual")
    assert entered.wait(5)
    with pytest.raises(AkoweError) as e:
        app.opener.import_bytes("author", data, mode="update")
    assert "is being saved right now" in e.value.errors[0]["message"]
    assert pid not in app.saver._hold  # noqa: SLF001 - refused: saves of it go on as before
    gate.set()
    assert app.saver.wait_idle(10)
    # a pending auto-save (timer) and a queued re-save of this book are dropped; nothing saves it meanwhile
    app.saver.interval_s = 60
    app.saver.auto(pid, BR, reason="approval")
    assert (pid, BR) in app.saver._timers  # noqa: SLF001
    n = app.saver.count.get((pid, BR), 0)
    up = app.opener.import_bytes("author", data, mode="update")
    assert up["mode"] == "update" and (pid, BR) not in app.saver._timers  # noqa: SLF001
    assert pid not in app.saver._hold and app.saver.count.get((pid, BR), 0) == n  # noqa: SLF001


def test_no_save_starts_while_the_book_is_replaced(sv):
    app, pid = sv
    assert app.saver.quiesce(pid, 1.0)
    try:
        app.saver.auto(pid, BR, force=True)
        assert not app.saver.busy((pid, BR))
        with pytest.raises(AkoweError):
            app.saver.start(pid, BR, kind="manual")
    finally:
        app.saver.release(pid)
    app.saver.start(pid, BR, kind="manual")
    assert app.saver.wait_idle(30) and app.saver.last(pid, BR)["ok"]


# ====================================================================== 8. the map's Word copy goes to the same map
def test_the_maps_word_copy_goes_to_the_same_map_when_candidates_shift(sv, monkeypatch):
    app, pid = sv
    svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'
    a = forge._store_asset(app.store, "author", pid, BR, svg, pictures.SVG_MIME, "Map (SVG)")  # noqa: SLF001
    pic_id = pictures.ensure_picture(app.store, pid, BR, "map", None, None)
    pictures.add_candidate(app.store, pid, BR, pic_id, dict(a, source="svg"), choose=True)
    other = forge.store_picture(app.store, "author", pid, BR, png(), "", "upload")

    def drawn(app_, principal, pid_, branch, svg_):  # meanwhile another map lands in front of it
        def fn(d):
            d["pictures"][pic_id]["candidates"].insert(0, dict(other, source="upload"))
        pictures._mutate(app.store, pid, BR, fn)  # noqa: SLF001
        return {"asset_id": "I01-png", "version": 1, "mime": "image/png", "width": 10, "height": 10}
    monkeypatch.setattr(pictures, "map_png", drawn)
    pictures.make_map_png(app, "author", pid, BR)
    cands = pictures.doc(app.store, pid, BR)["pictures"][pic_id]["candidates"]
    by_id = {c["asset_id"]: c for c in cands}
    assert by_id[a["asset_id"]]["png"]["asset_id"] == "I01-png" and "png" not in by_id[other["asset_id"]]


# ====================================================================== 12. a double-click makes one
def test_a_double_click_makes_one_dossier(sv, monkeypatch):
    app, pid = sv
    real = forge_kinds.mutate

    def slow(*a, **k):
        time.sleep(0.2)  # the window in which a second click used to pass the name check too
        return real(*a, **k)
    monkeypatch.setattr(forge_kinds, "mutate", slow)
    out, errs = [], []

    def click():
        try:
            out.append(forge_kinds.create(app.store, pid, BR, "item", {"name": "The Brass Key"}))
        except AkoweError as exc:
            errs.append(exc)
    ts = [threading.Thread(target=click) for _ in range(2)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(10)
    assert len(out) == 1 and len(errs) == 1 and "already" in errs[0].errors[0]["message"]
    assert [d["name"] for d in forge_kinds.list_dossiers(app.store, pid, BR, "item")] == ["The Brass Key"]


def test_a_double_click_makes_one_character(sv, monkeypatch):
    app, pid = sv
    from akowe.book_path import BookPath
    real = BookPath.create

    def slow(self, *a, **k):
        time.sleep(0.2)
        return real(self, *a, **k)
    monkeypatch.setattr(BookPath, "create", slow)
    out = []
    ts = [threading.Thread(target=lambda: out.append(forge.create_character(app, "author", pid, BR,
                                                                             {"name": "Ada Quill"})))
          for _ in range(2)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(10)
    assert sorted(o["created"] for o in out) == [False, True]
    assert out[0]["record_id"] == out[1]["record_id"]
    from akowe import characters as chars_mod
    assert [c["name"] for c in chars_mod.canon_characters(app.store, pid, BR)].count("Ada Quill") == 1
