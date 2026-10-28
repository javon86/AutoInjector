"""F10 "finish what's started": the ebook cover JPG and the Word copy of the map (drawn by AutoInjector's
POST /render/image, render.py), DELETE of the style card over HTTP (it answered 405), motion clips for items /
places / magic systems, and the book save gaps (the 10-minute quiet save, "update the one I have / open as a copy",
opening a big book straight from its folder)."""
from __future__ import annotations

import base64
import io
import json
import socket
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from PIL import Image

from akowe import book_package, cover, forge, forge_kinds, pictures, render
from akowe.errors import AkoweError
from akowe.exporters import cover as cx
from akowe.exporters.docx import build_docx, inspect_docx
from akowe.exporters.epub import inspect_epub
from akowe.exporters.images import load_image

from test_cover import book_files, fx  # noqa: F401
from test_failover_review import SlotFake, make_app
from test_forge import png
from test_forge_clip import FakeVideoBridge
from test_server import call, server  # noqa: F401

BR = "main"


def picture(w, h, fmt="JPEG", color=(30, 90, 160)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, fmt)
    return buf.getvalue()


class RenderBridge:
    """A fake AutoInjector with POST /render/image (draws a plain picture of the size asked), POST /image/request
    (one small PNG) and POST /dialog/choose-path. ``script``: path -> (status, body) for the next call there."""

    def __init__(self):
        self.requests: list = []
        self.script: dict = {}
        self.chosen = "/books/Salt (ab12)"
        bridge = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                bridge.requests.append((self.path, body, self.headers.get("Authorization")))
                if self.path in bridge.script:
                    status, out = bridge.script.pop(self.path)
                elif self.path == "/render/image":
                    fmt = body.get("format") or "png"
                    data = picture(body["width"], body["height"], "JPEG" if fmt == "jpeg" else "PNG")
                    status, out = 200, {"ok": True, "format": fmt, "mime": f"image/{fmt}", "width": body["width"],
                                        "height": body["height"], "bytes": len(data),
                                        "imageBase64": base64.b64encode(data).decode()}
                elif self.path == "/image/request":
                    status, out = 200, {"ok": True, "engine": "sd", "seed": 5,
                                        "images": [{"imageBase64": base64.b64encode(png()).decode(), "seed": 5}]}
                elif self.path == "/dialog/choose-path":
                    status, out = 200, ({"ok": True, "path": bridge.chosen} if bridge.chosen else
                                        {"ok": True, "cancelled": True})
                else:
                    status, out = 404, {"ok": False, "error": "NOT_FOUND"}
                data = json.dumps(out).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def renders(self):
        return [b for p, b, _a in self.requests if p == "/render/image"]

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def closed_port_url() -> str:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return f"http://127.0.0.1:{port}"


@pytest.fixture
def rb(fx):  # noqa: F811
    app, pid = fx
    b = RenderBridge()
    forge.save_bridge_settings(app, {"url": b.url, "token": "render-token"})
    yield app, pid, b
    b.close()


# ====================================================================== 🖨 render.py
def test_render_image_checks_what_comes_back(rb):
    app, _pid, b = rb
    data = render.render_image(app, "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 16'/>", 100, 160)
    assert data[:3] == b"\xff\xd8\xff" and load_image(data).width == 100
    path, body, auth = b.requests[-1]
    assert path == "/render/image" and auth == "Bearer render-token"
    assert body["format"] == "jpeg" and body["quality"] == 92 and body["width"] == 100 and body["height"] == 160
    png_ = render.render_image(app, b"<svg/>", 64, 48, fmt="png")
    assert png_[:4] == b"\x89PNG" and "quality" not in b.requests[-1][1]
    wrong = picture(50, 50)
    b.script["/render/image"] = (200, {"ok": True, "imageBase64": base64.b64encode(wrong).decode()})
    with pytest.raises(forge.ArtProblem) as e:
        render.render_image(app, "<svg/>", 100, 160)
    assert e.value.code == "RENDER_BAD_ANSWER" and "50 × 50" in e.value.message
    b.script["/render/image"] = (200, {"ok": True, "imageBase64": "%%%"})
    with pytest.raises(forge.ArtProblem) as e:
        render.render_image(app, "<svg/>", 100, 160)
    assert e.value.code == "RENDER_BAD_ANSWER"
    b.script["/render/image"] = (504, {"ok": False, "error": "RENDER_TIMEOUT", "message": "took 20 s"})
    with pytest.raises(forge.ArtProblem) as e:
        render.render_image(app, "<svg/>", 100, 160)
    assert e.value.code == "RENDER_TIMEOUT" and "Try again" in e.value.hint
    b.script["/render/image"] = (404, {"ok": False, "error": "NOT_FOUND"})
    with pytest.raises(forge.ArtProblem) as e:
        render.render_image(app, "<svg/>", 100, 160)
    assert e.value.code == "RENDER_NOT_WIRED" and "Update AutoInjector" in e.value.hint
    err = render.as_error(e.value, "JPG cover")
    assert "this AutoInjector cannot draw pictures yet" in err.errors[0]["message"]


# ====================================================================== 🖨 the ebook cover as a JPG
def test_ebook_cover_jpg_is_drawn_kept_and_used_by_the_epub_and_the_save(rb, monkeypatch):
    app, pid, b = rb
    cover.save(app, pid, BR, {"template": "fantasy", "print": {"page_count": 200}})
    app.cover.upload("author", pid, BR, png(300, 480))
    data, mime, name = cover.ebook_jpg(app, "author", pid, BR)
    assert mime == "image/jpeg" and name.endswith("ebook cover 1600x2560.jpg")
    im = Image.open(io.BytesIO(data))
    assert im.format == "JPEG" and im.size == (1600, 2560)
    req = b.renders()[-1]
    assert req["width"] == 1600 and req["height"] == 2560 and req["format"] == "jpeg" and req["quality"] == 92
    assert req["svg"].lstrip().startswith(("<?xml", "<svg")) and "data:image/png;base64," in req["svg"]  # art inside
    assert "THE SALT" in req["svg"] or "The Salt" in req["svg"]
    # the same cover again: the kept JPG, no new drawing
    n = len(b.renders())
    assert cover.ebook_jpg(app, "author", pid, BR)[0] == data and len(b.renders()) == n
    # another KDP size, then a changed design: drawn again
    big = cover.ebook_jpg(app, "author", pid, BR, "2560x4096")[0]
    assert Image.open(io.BytesIO(big)).size == (2560, 4096) and len(b.renders()) == n + 1
    cover.save(app, pid, BR, {"template": "thriller"})
    assert cover.cached_jpg(app, pid, BR) is None
    data2 = cover.ebook_jpg(app, "author", pid, BR)[0]
    assert len(b.renders()) == n + 2 and cover.cached_jpg(app, pid, BR) == data2
    with pytest.raises(AkoweError) as e:
        cover.ebook_jpg(app, "author", pid, BR, "999x999")
    assert "1600x2560" in str(e.value)
    # the page lists the sizes
    sizes = cover.public(app, pid, BR)["ebook"]["jpg_sizes"]
    assert [s["id"] for s in sizes][:2] == ["1600x2560", "2560x4096"]
    # HTTP: GET …/cover/ebook?format=jpg&size=…
    st, out = app.route("GET", f"/api/projects/{pid}/branches/{BR}/cover/ebook", {"format": ["jpg"],
                                                                                  "download": ["1"]}, None, "author", {})
    assert st == 200 and out[0] == "__binary__" and out[1] == "image/jpeg" and out[2] == data2 and out[4] == "attachment"
    # the EPUB with the cover uses the JPG as its cover image (and its cover page shows it)
    built = book_files()
    monkeypatch.setattr(cover, "_export_bytes", lambda a, p, br, fmt: (built[fmt], {"title": "The Salt Road"}))
    ep, _m, _n = cover.book_with_cover(app, pid, BR, "EPUB")
    assert not inspect_epub(ep)["errors"]
    z = zipfile.ZipFile(io.BytesIO(ep))
    opf = z.read("OEBPS/content.opf").decode()
    assert 'href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"' in opf
    assert z.read("OEBPS/images/cover.jpg") == data2
    xhtml = z.read("OEBPS/text/cover.xhtml").decode()
    assert '<img src="../images/cover.jpg"' in xhtml and "<svg" not in xhtml
    import lxml.etree as LET
    LET.fromstring(xhtml.encode())
    # the book save writes it
    files, _info = app.saver.collect(pid, BR)
    assert files["Cover/ebook cover.jpg"] == data2


def test_ebook_cover_jpg_says_plainly_when_autoinjector_is_not_there(fx):  # noqa: F811
    app, pid = fx
    cover.save(app, pid, BR, {"template": "fantasy"})
    forge.save_bridge_settings(app, {"url": closed_port_url(), "token": "x"})
    with pytest.raises(AkoweError) as e:
        cover.ebook_jpg(app, "author", pid, BR)
    msg = e.value.errors[0]["message"]
    assert "AutoInjector is not connected" in msg and "Start the AutoInjector" in msg
    assert cover.cached_jpg(app, pid, BR) is None
    # the EPUB falls back to the picture / SVG cover; the save has no JPG
    built = book_files()
    cover._export_bytes = lambda a, p, br, fmt: (built[fmt], {"title": "x"})  # noqa: SLF001
    try:
        ep = cover.book_with_cover(app, pid, BR, "EPUB")[0]
        assert "images/cover.svg" in zipfile.ZipFile(io.BytesIO(ep)).read("OEBPS/content.opf").decode()
    finally:
        del cover._export_bytes  # noqa: SLF001 - back to the module function
    import importlib
    importlib.reload(cover)


def test_add_cover_epub_with_a_jpg_directly():
    built = book_files()
    jpg = picture(160, 256)
    out = cx.add_cover_epub(built["EPUB"], svg_inline="<svg/>", art=None, svg_file="<svg/>", title="T & co", jpg=jpg)
    z = zipfile.ZipFile(io.BytesIO(out))
    opf = z.read("OEBPS/content.opf").decode()
    assert '<meta name="cover" content="cover-image"/>' in opf and 'properties="svg"' not in opf
    assert 'alt="T &amp; co"' in z.read("OEBPS/text/cover.xhtml").decode()
    assert not inspect_epub(out)["errors"]


# ====================================================================== 🖨 the Word copy of the map
def test_docx_places_the_png_copy_of_a_drawn_map():
    from akowe.exporters import book as bookmod
    book = bookmod.build_book({"title": "T", "author": "A", "identifier": "urn:uuid:1", "language": "en"},
                              [{"id": "c1", "text": "# One\nText."}], toc=False)
    raw = picture(400, 300, "PNG")
    info = load_image(raw)
    blk = {"t": "vmap", "id": "map", "svg": "<svg/>", "w_mm": 150, "h_mm": 120, "caption": "The coast",
           "alt": "A map", "png_key": "pk"}
    bookmod.place_pictures(book["sections"], [{"block": blk, "section_id": "c1", "where": "before"}])
    page = {"width_mm": 152.4, "height_mm": 228.6, "bleed_mm": 0, "safe_margin_mm": 15}
    dx = build_docx(book, created="2026-10-28T00:00:00Z", images={"pk": (raw, info)}, page=page)
    assert not inspect_docx(dx)["errors"]
    doc = zipfile.ZipFile(io.BytesIO(dx)).read("word/document.xml").decode()
    assert doc.count("<w:drawing>") == 1 and "The coast" in doc and "PDF and EPUB editions" not in doc
    no = build_docx(book, created="2026-10-28T00:00:00Z", images={}, page=page)
    assert "the map is in the PDF and EPUB editions" in zipfile.ZipFile(io.BytesIO(no)).read(
        "word/document.xml").decode()
    assert pictures.map_png_size(b'<svg viewBox="0 0 400 300">') == (2000, 1500)
    assert pictures.map_png_size(b'<svg viewBox="-10 -20 100 1000">') == (410, 4096)
    assert pictures.map_png_size(b"<svg>") == (2000, 1500)


@pytest.fixture(scope="module")
def made_book(tmp_path_factory):
    import types
    import time

    from akowe import providers as prov_mod
    from test_failover_review import run_book
    mp = pytest.MonkeyPatch()
    mp.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic, time=time.time))
    app = make_app(tmp_path_factory.mktemp("f10map"), SlotFake())
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    yield app, run["project_id"]
    mp.undo()


def test_the_drawn_map_reaches_word_as_a_png(made_book):
    from test_pictures import assemble_and_export
    app, pid = made_book
    # AutoInjector not there: the map is made, its Word copy is not (the note says how to get it)
    forge.save_bridge_settings(app, {"url": closed_port_url(), "token": "t"})
    out = pictures.make_svg_map(app, "author", pid, BR)
    assert "Make the Word copy" in out["message"] and out["picture"]["picture"]["word_copy"] is False
    b = RenderBridge()
    try:
        forge.save_bridge_settings(app, {"url": b.url, "token": "t"})
        out = app.route("POST", f"/api/projects/{pid}/branches/{BR}/pictures/map", {}, {"kind": "png"}, "author",
                        {})[1]
        assert out["picture"]["picture"]["word_copy"] is True and "put the book together again" in out["message"]
        req = b.renders()[-1]
        assert req["format"] == "png" and req["width"] == 2000 and "<svg" in req["svg"]
        files = assemble_and_export(app, pid)
        doc = zipfile.ZipFile(io.BytesIO(files["DOCX"])).read("word/document.xml").decode()
        assert doc.count("<w:drawing>") == 1 and "PDF and EPUB editions" not in doc
        # PDF and EPUB keep the vector map
        assert 'media-type="image/svg+xml"' in zipfile.ZipFile(io.BytesIO(files["EPUB"])).read(
            "OEBPS/content.opf").decode()
        # a new drawn map gets its Word copy at once; the book save has map.svg + map.png
        out = pictures.make_svg_map(app, "author", pid, BR)
        assert "Word files show a PNG copy" in out["message"]
        saved, _ = app.saver.collect(pid, BR)
        assert saved["Pictures/map.png"][:4] == b"\x89PNG" and "Pictures/map.svg" in saved
    finally:
        b.close()


# ====================================================================== ✒️ the style card DELETE (was HTTP 405)
def test_delete_style_card_over_http(server):  # noqa: F811
    app, port = server
    from test_section7c import SAMPLE
    st, out, _ = call(port, "PUT", "/api/style-card", {"samples": [{"name": "Diary", "text": SAMPLE}]})
    assert st == 200, out
    st, out, _ = call(port, "DELETE", "/api/style-card")
    assert st == 200 and out["card"] is None, out
    st, out, _ = call(port, "GET", "/api/style-card")
    assert st == 200 and out["card"] is None
    # an item dossier can be deleted with DELETE too; other paths still answer 405
    pid = app.engine.bootstrap_project("author", "Del book")
    rid = forge_kinds.create(app.store, pid, BR, "item", {"name": "Lamp"})["record_id"]
    st, out, _ = call(port, "DELETE", f"/api/projects/{pid}/branches/{BR}/forge/items/{rid}")
    assert st == 200 and not forge_kinds.list_dossiers(app.store, pid, BR, "item")
    st, _o, resp = call(port, "DELETE", "/api/projects")
    assert st == 405 and resp.getheader("Allow") == "GET, POST, PUT"


# ====================================================================== 🎬 motion clips for items, places, magic
@pytest.fixture
def kv(tmp_path):
    from test_forge import ForgeFake
    app = make_app(tmp_path, ForgeFake(), slots=("AI-1",))
    pid = app.engine.bootstrap_project("author", "Kind clip book")
    out = tmp_path / "videos"
    out.mkdir()
    b = FakeVideoBridge(out)
    forge.save_bridge_settings(app, {"url": b.url, "token": "vid"})
    yield app, pid, b
    b.close()


def kind_clip(app, pid, kind, rid):
    j = app.forge.start_kind_art("author", pid, BR, kind, rid, {"what": "clip"})
    return forge.wait(app, "author", j["job_id"], 30)


def test_motion_clips_for_items_places_and_magic(kv):
    app, pid, b = kv
    item = forge_kinds.create(app.store, pid, BR, "item", {"name": "Rescue baton"})["record_id"]
    with pytest.raises(AkoweError) as e:
        app.forge.start_kind_art("author", pid, BR, "item", item, {"what": "clip"})
    assert "item portrait" in str(e.value)
    app.forge.upload_kind("author", pid, BR, "item", item, "portrait", png(60, 60, (10, 200, 10)))
    with pytest.raises(AkoweError):
        app.forge.start_kind_art("author", pid, BR, "item", item, {"what": "clip", "engine": "sd"})
    j = kind_clip(app, pid, "item", item)
    assert j["status"] == "done", j
    body = b.requests[-1]
    assert body["purpose"] == "clip" and body["seconds"] == 4 and "turntable" in body["prompt"]
    assert body["prompt"].startswith("Rescue baton (item)") and b.seen_image[-1][0]
    d = forge_kinds.public(app.store, pid, BR, "item", item)
    assert d["art"]["clip"]["mime"] == "video/mp4" and d["art"]["clip"]["poster"]["url"]
    assert forge_kinds.list_dossiers(app.store, pid, BR, "item")[0]["has_clip"] is True
    # a place from its day view (no establishing shot yet); a magic system prefers the in-use picture
    place = forge_kinds.create(app.store, pid, BR, "place", {"name": "Nacre"})["record_id"]
    app.forge.upload_kind("author", pid, BR, "place", place, "day", png(80, 50))
    assert kind_clip(app, pid, "place", place)["status"] == "done"
    assert "establishing pan" in b.requests[-1]["prompt"]
    assert forge_kinds.raw_entry(app.store, pid, BR, "place", place)["art"]["clip"]["made_from"] == "day"
    magic = forge_kinds.create(app.store, pid, BR, "magic", {"name": "Tide magic"})["record_id"]
    app.forge.upload_kind("author", pid, BR, "magic", magic, "sigil", png(50, 50))
    app.forge.upload_kind("author", pid, BR, "magic", magic, "in_use", png(70, 50))
    assert kind_clip(app, pid, "magic", magic)["status"] == "done"
    assert "the power in use" in b.requests[-1]["prompt"]
    assert forge_kinds.raw_entry(app.store, pid, BR, "magic", magic)["art"]["clip"]["made_from"] == "in_use"
    # a video error is plain
    b.script[len(b.requests) + 1] = (503, {"ok": False, "error": "VIDEO_MODEL_MISSING", "message": "no model"})
    j = kind_clip(app, pid, "magic", magic)
    assert j["status"] == "error" and j["error"]["code"] == "VIDEO_MODEL_MISSING" and "download" in j["error"]["fix"]
    # the author's own clip and poster
    from test_forge_clip import WEBM
    out = app.forge.upload_kind("author", pid, BR, "place", place, "clip", WEBM)
    assert out["art"]["clip"]["mime"] == "video/webm" and out["art"]["clip"]["poster"] is None
    out = app.forge.upload_kind("author", pid, BR, "place", place, "clip_poster", png(40, 30))
    assert out["art"]["clip"]["poster"]["url"]
    with pytest.raises(AkoweError):
        app.forge.upload_kind("author", pid, BR, "item", item, "clip", b"not a video")
    # the PDF shows the MOTION STUDY still; the book save carries the clip and its poster
    import pypdf
    for kind, rid in (("item", item), ("place", place), ("magic", magic)):
        pdf, _name = forge_kinds.pdf_bytes(app, pid, BR, kind, rid)
        assert "MOTION STUDY" in pypdf.PdfReader(io.BytesIO(pdf)).pages[0].extract_text(), kind
    files, _ = app.saver.collect(pid, BR)
    names = sorted(files)
    assert any(n.endswith("pictures/motion clip.mp4") and "/AR-" in n for n in names), names
    assert any(n.endswith("pictures/motion clip.webm") and "/PL-" in n for n in names)
    assert any(n.endswith("pictures/motion clip poster.png") and "/MG-" in n for n in names)


# ====================================================================== 💾 the book save
@pytest.fixture
def saver_app(tmp_path):
    app = make_app(tmp_path, SlotFake(), slots=("AI-1",))
    app.route("PUT", "/api/settings/books-folder", {}, {"path": str(tmp_path / "books"), "auto_save": True},
              "author", {})
    app.saver.launch = lambda p: None
    pid = app.engine.bootstrap_project("author", "Salt book")
    from akowe.book_path import save_profile
    save_profile(app.store, pid, {"title": "The Salt Road", "author": "Mara Vell"})
    yield app, pid
    app.saver.stop_periodic()


def test_the_quiet_ten_minute_save_only_saves_a_changed_book(saver_app):
    app, pid = saver_app
    assert app.saver.settings()["periodic_s"] == 600 and app.saver._ticker is not None  # noqa: SLF001
    first = app.saver.periodic_tick()
    assert (pid, BR) in first and app.saver.wait_idle(30)
    last = app.saver.last(pid, BR)
    assert last["ok"] and last["fp"] and last["fp"] == app.saver.fingerprint(pid, BR)  # saving changes nothing
    assert app.saver.periodic_tick() == []  # unchanged: left alone
    cover.save(app, pid, BR, {"template": "thriller"})  # work by hand (no run)
    assert app.saver.periodic_tick() == [(pid, BR)] and app.saver.wait_idle(30)
    assert (Path(app.saver.last(pid, BR)["path"]) / "Cover" / "cover-design.json").is_file()
    assert app.saver.periodic_tick() == []
    app.route("PUT", "/api/settings/books-folder", {}, {"auto_save": False}, "author", {})
    cover.save(app, pid, BR, {"template": "fantasy"})
    assert app.saver.periodic_tick() == []  # auto-save off: nothing


def test_open_a_book_that_is_already_here_update_or_copy_and_from_its_folder(saver_app, tmp_path):
    app, pid = saver_app
    cover.save(app, pid, BR, {"template": "thriller"})
    app.saver.save_now(pid, BR)
    folder = app.saver.book_folder(pid, BR)
    app.store.set_setting(f"book_save:{pid}:{BR}", {"ok": True, "at": "2026-10-28T00:00:00Z", "path": str(folder)})
    data = (folder / "book.akowe").read_bytes()
    n_books = len(app.store.query("SELECT project_id FROM projects"))
    # it is already here: ask first
    out = app.opener.import_bytes("author", data)
    assert out["needs_choice"] and out["existing"]["project_id"] == pid and out["saved"]["saved_at"]
    with pytest.raises(AkoweError):
        app.opener.import_bytes("author", data, mode="merge")
    # ⟳ update the one I have: the same id, back to the saved state, the folder and last-save note kept
    cover.save(app, pid, BR, {"template": "fantasy"})
    assert cover.get_design(app.store, pid, BR)["template"] == "fantasy"
    up = app.opener.import_bytes("author", data, mode="update")
    assert up["project_id"] == pid and up["mode"] == "update" and "updated" in up["message"]
    assert cover.get_design(app.store, pid, BR)["template"] == "thriller"
    assert app.store.project(pid)["name"] == "Salt book"
    assert len(app.store.query("SELECT project_id FROM projects")) == n_books  # the checked copy is gone
    assert app.saver.book_folder(pid, BR) == folder and app.saver.last(pid, BR)["at"] == "2026-10-28T00:00:00Z"
    assert book_package.verify(app.store, pid) == []
    # 📄 open as a copy (upload with ?mode=copy)
    st, cp = app.route("POST", "/api/books/open", {"mode": ["copy"]}, data, "author",
                       {"Content-Type": "application/octet-stream"})
    assert st == 201 and cp["project_id"] != pid and cp["mode"] == "copy"
    # 📂 straight from its folder (no upload): the folder or the book.akowe itself
    st, ch = app.route("POST", "/api/books/open-path", {}, {"path": str(folder)}, "author", {})
    assert st == 200 and ch["needs_choice"]
    st, op = app.route("POST", "/api/books/open-path", {}, {"path": str(folder / "book.akowe"), "mode": "copy"},
                       "author", {})
    assert st == 201 and op["kind"] == "package" and op["project_id"] not in (pid, cp["project_id"])
    for bad in ("", str(tmp_path / "nowhere"), str(tmp_path)):
        with pytest.raises(AkoweError) as e:
            app.route("POST", "/api/books/open-path", {}, {"path": bad}, "author", {})
        assert e.value.errors[0].get("problem") == "OPEN_NOT_FOUND"
    # only on this computer
    app.set_client("192.168.1.20")
    try:
        with pytest.raises(AkoweError) as e:
            app.route("POST", "/api/books/open-path", {}, {"path": str(folder)}, "author", {})
        assert e.value.errors[0].get("problem") == "OPEN_NOT_LOCAL"
    finally:
        app.set_client(None)
    # a book not on this computer any more opens as a new book without asking
    app.store.delete_project(pid)
    out = app.opener.import_bytes("author", data)
    assert out["kind"] == "package" and out["mode"] == "new" and not out.get("needs_choice")


def test_choose_the_folder_in_autoinjector(saver_app):
    app, _pid = saver_app
    b = RenderBridge()
    try:
        forge.save_bridge_settings(app, {"url": b.url, "token": "t"})
        st, out = app.route("POST", "/api/books/choose-path", {}, {}, "author", {})
        assert st == 200 and out == {"path": "/books/Salt (ab12)"}
        assert b.requests[-1][0] == "/dialog/choose-path" and b.requests[-1][1]["kind"] == "book"
        b.chosen = None
        assert app.route("POST", "/api/books/choose-path", {}, {}, "author", {})[1] == {"cancelled": True}
    finally:
        b.close()
    forge.save_bridge_settings(app, {"url": closed_port_url(), "token": "t"})
    with pytest.raises(AkoweError) as e:
        app.route("POST", "/api/books/choose-path", {}, {}, "author", {})
    assert "type the folder's path instead" in e.value.errors[0]["message"]


# ====================================================================== 🧑 a new character (POST /forge/characters)
def test_create_a_new_character_with_its_dossier(fx):  # noqa: F811
    app, pid = fx
    base = f"/api/projects/{pid}/branches/{BR}/forge/characters"
    st, out = app.route("POST", base, {}, {"name": "Ada Quill", "aliases": ["The Quill"], "role": "the harbour master",
                                           "about": "Fifty, one grey eye, never without her ledger."}, "author", {})
    assert st == 201 and out["created"] and out["record_id"].startswith("A01")
    d = out["dossier"]
    assert d["name"] == "Ada Quill" and d["code"] == "CH-001"
    f = {x["key"]: x for s in d["sections"] for x in s["fields"]}
    assert f["role"]["text"] == "the harbour master" and f["role"]["status"] == "supplied"
    assert f["supplied_canon"]["text"].startswith("Fifty") and "The Quill" in f["name"]["text"]
    assert d["counts"]["proposed"] == 0  # nothing invented
    from akowe import characters as chars_mod
    c = next(c for c in chars_mod.canon_characters(app.store, pid, BR) if c["record_id"] == out["record_id"])
    assert c["name"] == "Ada Quill" and c["approved"] is False  # a draft: approved by the author like any other
    # the list shows it (GET unchanged); the same name again returns it; a second one gets CH-002
    lst = app.route("GET", base, {}, None, "author", {})[1]
    assert [x["name"] for x in lst["characters"]] == ["Ada Quill"]
    st, again = app.route("POST", base, {}, {"name": "ada quill"}, "author", {})
    assert st == 200 and again["created"] is False and again["record_id"] == out["record_id"]
    st, fr = app.route("POST", base, {}, {"from": out["record_id"]}, "author", {})
    assert st == 200 and fr["record_id"] == out["record_id"]
    st, two = app.route("POST", base, {}, {"name": "Bo Reed"}, "author", {})
    assert st == 201 and two["dossier"]["code"] == "CH-002"
    for bad in ({}, {"name": "  "}, {"name": "X", "role": 5}, {"from": "A01-nope"}):
        with pytest.raises(AkoweError):
            app.route("POST", base, {}, bad, "author", {})
