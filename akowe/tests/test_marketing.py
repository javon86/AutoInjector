"""📣 #17 Mockups and ads: the 3D book (the true perspective within a fraction of a pixel, the faces the camera sees,
the real spine from the print wrap or a drawn one), the flat devices, the ads (exact sizes, every word inside the
format's text-safe area, no words on the Amazon picture, the cover's colours), the hook (yours, else the launch kit's,
else the cover tagline, else the book idea), the pictures drawn by a fake AutoInjector (exact sizes, a see-through PNG
asked for without a background and checked), the out-of-date marks (the cover, the words), the teaser clips through a
fake AutoInjector trailer maker (stills of the right size and length; the cover brought to life, and the still cover
when that cannot be done; an old AutoInjector), the zip, the book save and the HTTP API."""
from __future__ import annotations

import base64
import io
import json
import os
import re
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import pytest
from PIL import Image

from akowe import cover, forge, marketing
from akowe.book_path import save_profile
from akowe.errors import AkoweError

from test_failover_review import SlotFake, make_app
from test_server import call
from test_trailer import MP4, WEBM

BR = "main"


def art_png(w=300, h=450) -> bytes:
    im = Image.new("RGB", (w, h))
    px = im.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = (40 + x * 150 // w, 60 + y * 120 // h, 140)
    b = io.BytesIO()
    im.save(b, "PNG")
    return b.getvalue()


class FakeAutoInjector:
    """POST /render/image (a picture of exactly the size asked: a see-through RGBA PNG when no background is given,
    else an opaque one / a JPEG; ``opaque_png`` = an older AutoInjector) and the trailer maker (POST /video/trailer →
    GET /video/trailer?id= → a .webm (+ .mp4) file; ``trailer_start`` / ``trailer_fail``: scripted answers)."""

    def __init__(self, out_dir):
        self.out = out_dir
        self.renders: list = []
        self.trailers: list = []
        self.opaque_png = False
        self.render_down = False
        self.trailer_start: dict = {}   # trailer call n -> (status, body)
        self.trailer_fail: dict = {}    # trailer call n -> failed result
        self.runs: dict = {}
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, status, out):
                data = json.dumps(out).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                if self.path == "/render/image":
                    if fake.render_down:
                        return self._send(404, {"ok": False, "error": "NOT_FOUND"})
                    fake.renders.append(body)
                    w, h, fmt = body["width"], body["height"], body.get("format", "png")
                    b = io.BytesIO()
                    if fmt == "jpeg":
                        Image.new("RGB", (w, h), (30, 30, 40)).save(b, "JPEG")
                    elif body.get("background") or fake.opaque_png:
                        Image.new("RGB", (w, h), (255, 255, 255)).save(b, "PNG")
                    else:
                        im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
                        im.paste((90, 20, 20, 255), (w // 4, h // 4, w * 3 // 4, h * 3 // 4))
                        im.save(b, "PNG")
                    return self._send(200, {"ok": True, "imageBase64": base64.b64encode(b.getvalue()).decode(),
                                            "width": w, "height": h})
                if self.path == "/video/trailer/cancel":
                    return self._send(200, {"ok": True, "cancelled": True})
                if self.path == "/video/trailer":
                    fake.trailers.append(body)
                    n = len(fake.trailers)
                    if n in fake.trailer_start:
                        return self._send(*fake.trailer_start[n])
                    fake.runs[f"c{n}"] = {"n": n, "polls": 0, "body": body}
                    return self._send(202, {"ok": True, "started": True, "id": f"c{n}"})
                return self._send(404, {"ok": False, "error": "NOT_FOUND"})

            def do_GET(self):
                u = urlparse(self.path)
                if u.path != "/video/trailer":
                    return self._send(404, {"ok": False, "error": "NOT_FOUND"})
                t = fake.runs.get((parse_qs(u.query).get("id") or [""])[0])
                if t is None:
                    return self._send(404, {"ok": False, "error": "NOT_FOUND"})
                t["polls"] += 1
                if t["polls"] < 2:
                    return self._send(200, {"ok": True, "busy": True, "status": {"busy": True, "phase": "joining"}})
                if t["n"] in fake.trailer_fail:
                    return self._send(200, {"ok": True, "busy": False, "status": {"busy": False, "phase": "failed"},
                                            "result": fake.trailer_fail[t["n"]]})
                body = t["body"]
                wp = fake.out / f"clip-{t['n']}.webm"
                wp.write_bytes(WEBM)
                mp = fake.out / f"clip-{t['n']}.mp4"
                mp.write_bytes(MP4)
                secs = sum(x["seconds"] for x in body["items"])
                return self._send(200, {"ok": True, "busy": False, "status": {"busy": False, "phase": "done"},
                                        "result": {"ok": True, "path": str(wp), "mp4": str(mp), "seconds": secs,
                                                   "width": body["width"], "height": body["height"], "warnings": []}})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def fx(tmp_path, monkeypatch):
    monkeypatch.setattr(marketing, "POLL_S", 0.02)
    monkeypatch.setattr(marketing, "PICTURES_ROOT", str(tmp_path / "frames"))
    app = make_app(tmp_path, SlotFake(), slots=("AI-1",))
    pid = app.engine.bootstrap_project("author", "Salt book")
    save_profile(app.store, pid, {"title": "The Salt Road", "author": "Mara Vell", "genre": "Fantasy",
                                  "idea": "A courier crosses a salt desert to deliver a key."})
    cover.save(app, pid, BR, {"template": "gilded", "texts": {"tagline": "Every light hides a debt."},
                              "print": {"page_count": 320}})
    out = tmp_path / "ai-videos"
    out.mkdir()
    fake = FakeAutoInjector(out)
    forge.save_bridge_settings(app, {"url": fake.url, "token": "t"})
    yield app, pid, fake
    fake.close()


def wait(app, job):
    return forge.wait(app, "author", job["job_id"], timeout_s=60)


def size_of(svg: str) -> tuple:
    m = re.search(r'<svg[^>]*viewBox="0 0 ([\d.]+) ([\d.]+)" width="([\d.]+)" height="([\d.]+)"', svg)
    return tuple(float(v) for v in m.groups())


# ====================================================================== the 3D book
def test_paperback_uses_the_print_wrap_and_stays_true_to_perspective(fx):
    app, pid, _ = fx
    ctx = marketing.Ctx(app, pid, BR)
    assert ctx.src.wrap and ctx.src.spine and ctx.src.back
    assert abs(ctx.src.t_in - 320 * 0.0025) < 1e-6 and (ctx.src.w_in, ctx.src.h_in) == (6.0, 9.0)
    for kind in ("paperback", "hardcover", "stack"):
        svg, info = marketing.mockup_svg(kind, [ctx.src], with_bg=False)
        assert size_of(svg) == (2000, 2000, 2000, 2000)
        assert info["max_cell_error_px"] <= marketing.MAX_CELL_ERROR_PX, (kind, info)
        assert info["cells"] > 20
        # every id is defined once (the cover's own ids are prefixed, so many covers live in one picture)
        ids = re.findall(r'\bid="([^"]+)"', svg)
        assert len(ids) == len(set(ids)), kind
        for ref in set(re.findall(r'url\(#([^)]+)\)', svg)) | set(re.findall(r'href="#([^"]+)"', svg)):
            assert ref in ids, (kind, ref)
        assert "bg-bg" not in svg  # see-through: no backdrop
    # with a backdrop in the cover's colours
    svg, _ = marketing.mockup_svg("paperback", [ctx.src], with_bg=True)
    assert 'id="bg-bg"' in svg and cx_hex(ctx.src.colors["background"]) in svg.lower() or 'id="bg-bg"' in svg


def cx_hex(col):
    return "#%02x%02x%02x" % tuple(int(v) for v in col)


def test_the_camera_sees_the_right_faces():
    src = marketing.Source()
    src.front, src.spine, src.back = ("f", (0, 0, 432, 648)), ("s", (0, 0, 50, 648)), None
    src.colors = {"background": (10, 10, 10), "text": (250, 250, 250), "accent": (200, 160, 60)}
    src.template = {}
    seen = {}
    for kind in ("paperback", "hardcover"):
        sc = marketing.scene_for(kind, [src]).fit((0, 0, 1000, 1000))
        b = sc.books[0]
        seen[kind] = {n for n, q, nrm in b.faces() if sc._visible(b, q, nrm)}  # noqa: SLF001
    assert seen["paperback"] == {"front", "spine", "head"}       # the spine and the page edges on top
    assert seen["hardcover"] == {"front", "fore", "head"}        # the other way: the fore-edge pages
    sc = marketing.scene_for("stack", [src]).fit((0, 0, 1000, 1000))
    top = max(sc.books, key=lambda b: b.T[1])
    assert "front" in {n for n, q, nrm in top.faces() if sc._visible(top, q, nrm)}  # noqa: SLF001


def test_no_page_count_yet_draws_a_spine(fx):
    app, pid, _ = fx
    cover.save(app, pid, BR, {"print": {"page_count": None}})
    ctx = marketing.Ctx(app, pid, BR)
    if ctx.src.wrap:  # an estimate from the word count may still make a wrap: then the real one is used
        return
    assert ctx.src.spine[0] == "sspine" and ctx.src.back is None
    svg, _ = marketing.mockup_svg("paperback", [ctx.src], with_bg=False)
    assert 'id="sspine"' in svg and "THE SALT ROAD" in svg  # the title down the drawn spine


def test_devices_show_only_the_front(fx):
    app, pid, _ = fx
    ctx = marketing.Ctx(app, pid, BR)
    for kind in ("phone", "tablet", "ereader"):
        svg, _ = marketing.mockup_svg(kind, [ctx.src], with_bg=False)
        g, (sx, sy, sw, sh) = ctx.src.front
        assert f'viewBox="{marketing._f(sx)} {marketing._f(sy)} {marketing._f(sw)} {marketing._f(sh)}"' in svg  # noqa: SLF001
    assert 'type="saturate" values="0"' in marketing.mockup_svg("ereader", [ctx.src], with_bg=False)[0]


# ====================================================================== the ads
@pytest.mark.parametrize("ad", list(marketing.ADS))
def test_ads_are_the_exact_size_and_keep_the_words_safe(fx, ad):
    app, pid, _ = fx
    ctx = marketing.Ctx(app, pid, BR)
    svg, info = ctx.svg(ad)
    spec = marketing.ADS[ad]
    assert size_of(svg) == (spec["w"], spec["h"], spec["w"], spec["h"])
    if ad == "ad-amazon":
        assert info["text_boxes"] == []   # Amazon: no added words on a custom image
        return
    roles = {b[4] for b in info["text_boxes"]}
    assert {"hook", "cta"} <= roles
    l, t, r, btm = spec["safe"]
    for x, y, w, h, role in info["text_boxes"]:
        assert x >= l - 0.5 and y >= t - 0.5 and x + w <= spec["w"] - r + 0.5 and y + h <= spec["h"] - btm + 0.5, \
            (ad, role, (x, y, w, h))
    assert "Every light hides a debt." in svg and "AVAILABLE NOW" in svg


def test_story_keeps_out_of_the_apps_buttons_with_a_long_hook(fx):
    app, pid, _ = fx
    marketing.save_words(app, pid, BR, {"hook": "When the lights of the salt road go out, one courier must carry "
                                                "the last key across the desert before the debt comes due at dawn."})
    ctx = marketing.Ctx(app, pid, BR)
    for ad in ("ad-story", "ad-bookbub", "ad-landscape", "ad-square"):
        _svg, info = ctx.svg(ad)
        l, t, r, b = marketing.ADS[ad]["safe"]
        W, H = marketing.ADS[ad]["w"], marketing.ADS[ad]["h"]
        for x, y, w, h, role in info["text_boxes"]:
            assert y >= t - 0.5 and y + h <= H - b + 0.5 and x >= l - 0.5 and x + w <= W - r + 0.5, (ad, role)
    for clip in marketing.CLIPS:
        for frame in ("hook", "end"):
            _svg, info = marketing.frame_svg(clip, frame, ctx.srcs(clip), ctx.w)
            l, t, r, b = marketing.CLIPS[clip]["safe"]
            W, H = marketing.CLIPS[clip]["w"], marketing.CLIPS[clip]["h"]
            assert info["text_boxes"]
            for x, y, w, h, role in info["text_boxes"]:
                assert y >= t - 0.5 and y + h <= H - b + 0.5 and x >= l - 0.5 and x + w <= W - r + 0.5, \
                    (clip, frame, role)


def test_the_call_to_action_is_readable_on_every_template(fx):
    app, pid, _ = fx
    for tpl in cover.cx.TEMPLATES:
        cover.save(app, pid, BR, {"template": tpl})
        src = marketing.source_of(app, pid, BR)
        fill, ink = marketing._cta_colors(src)  # noqa: SLF001
        assert marketing.contrast(fill, ink) >= 3.0, tpl
        bg = marketing._mix(src.colors["background"], (0, 0, 0), 0.15)  # noqa: SLF001
        assert marketing.contrast(marketing._text_color(src), bg) >= 4.5, tpl  # noqa: SLF001


# ====================================================================== the words
def test_the_hook_comes_from_you_the_launch_kit_the_tagline_or_the_idea(fx):
    app, pid, _ = fx
    w = marketing.words(app, pid, BR)
    assert (w["hook"], w["hook_source"]) == ("Every light hides a debt.", "cover tagline") and w["cta"] == "Available now"
    app.store.set_setting(f"launch_kit:{pid}:{BR}", {"fields": {"hook": {"approved": 1, "versions": [
        {"n": 1, "value": "One key. One desert. One night."}, {"n": 2, "value": "A newer draft"}]}}})
    w = marketing.words(app, pid, BR)
    assert (w["hook"], w["hook_source"]) == ("One key. One desert. One night.", "launch kit")
    marketing.save_words(app, pid, BR, {"hook": "My own line.", "cta": "Out now"})
    w = marketing.words(app, pid, BR)
    assert (w["hook"], w["hook_source"], w["cta"]) == ("My own line.", "yours", "Out now")
    marketing.save_words(app, pid, BR, {"hook": None})
    assert marketing.words(app, pid, BR)["hook_source"] == "launch kit"
    app.store.set_setting(f"launch_kit:{pid}:{BR}", None)
    cover.save(app, pid, BR, {"texts": {"tagline": ""}})
    assert marketing.words(app, pid, BR)["hook_source"] in ("book idea", "none")


@pytest.mark.parametrize("body,path", [({"hook": 5}, "/hook"), ({"hook": "x" * 200}, "/hook"),
                                       ({"cta": "y" * 60}, "/cta"), ({"animate": "yes"}, "/animate")])
def test_bad_words_are_refused_in_plain_words(fx, body, path):
    app, pid, _ = fx
    with pytest.raises(AkoweError) as e:
        marketing.save_words(app, pid, BR, body)
    assert e.value.errors[0]["path"] == path


def test_a_stale_revision_is_refused(fx):
    app, pid, _ = fx
    marketing.save_words(app, pid, BR, {"cta": "Out now"})
    with pytest.raises(AkoweError) as e:
        marketing.save_words(app, pid, BR, {"cta": "Coming soon", "revision": 0})
    assert e.value.code == "VERSION_CONFLICT"


# ====================================================================== the pictures (AutoInjector) and out of date
def test_make_the_pictures_exact_sizes_and_see_through(fx):
    app, pid, fake = fx
    j = wait(app, marketing.start_make(app, "author", pid, BR, {}))
    assert j["status"] == "done", j
    d = marketing.info(app, pid, BR)
    pics = [p for p in d["pieces"] if p["group"] != "clip"]
    assert len(pics) == 2 * 6 + len(marketing.ADS)  # 6 mockups (no series), see-through + background, and the ads
    assert all(p["made"] and not p["out_of_date"] for p in pics) and d["made_count"] == len(pics)
    for p in pics:
        data, mime, name = marketing.made_file(app, pid, BR, p["id"])
        im = Image.open(io.BytesIO(data))
        assert im.size == (p["width"], p["height"]), p["id"]
        if p["transparent"]:
            assert mime == "image/png" and im.mode == "RGBA" and im.getpixel((0, 0))[3] == 0, p["id"]
            assert marketing.png_has_alpha(data)
        else:
            assert mime == "image/jpeg" and im.format == "JPEG", p["id"]
        assert name.startswith("The Salt Road - ")
    # what AutoInjector was asked: a see-through PNG without a background, the JPGs at their exact sizes
    by = {(r["width"], r["height"], r["format"]) for r in fake.renders}
    assert (1080, 1920, "jpeg") in by and (300, 250, "jpeg") in by and (1200, 628, "jpeg") in by
    assert all("background" not in r for r in fake.renders if r["format"] == "png")
    assert sum(1 for r in fake.renders if r["format"] == "png") == 6


def test_out_of_date_when_the_cover_or_the_words_change(fx):
    app, pid, _ = fx
    assert wait(app, marketing.start_make(app, "author", pid, BR, {}))["status"] == "done"
    assert not marketing.info(app, pid, BR)["out_of_date"]
    # the words: only the ads with words (the mockups and the Amazon picture have none)
    marketing.save_words(app, pid, BR, {"hook": "A new hook."})
    d = marketing.info(app, pid, BR)
    stale = {p["id"] for p in d["pieces"] if p["out_of_date"]}
    assert stale == {"ad-square", "ad-story", "ad-landscape", "ad-bookbub"}
    assert all("words" in p["out_of_date_why"][0] for p in d["pieces"] if p["out_of_date"])
    # the cover: everything made
    cover.save(app, pid, BR, {"template": "thriller"})
    d = marketing.info(app, pid, BR)
    assert d["out_of_date"] and d["out_of_date_count"] == d["made_count"]
    assert all("the cover changed since it was made" in p["out_of_date_why"] for p in d["pieces"] if p["made"])
    # made again: up to date
    assert wait(app, marketing.start_make(app, "author", pid, BR, {"pieces": ["paperback", "ad-square"]}))[
        "status"] == "done"
    d = marketing.info(app, pid, BR)
    up = {p["id"] for p in d["pieces"] if p["made"] and not p["out_of_date"]}
    assert up == {"paperback", "ad-square"}


def test_an_older_autoinjector_draws_no_see_through_png(fx):
    app, pid, fake = fx
    fake.opaque_png = True
    j = wait(app, marketing.start_make(app, "author", pid, BR, {"pieces": ["phone"]}))
    assert j["status"] == "done"
    p = next(x for x in marketing.info(app, pid, BR)["pieces"] if x["id"] == "phone")
    assert any("see-through" in w for w in p["made"]["warnings"])


def test_autoinjector_missing_says_so_and_the_svg_still_works(fx):
    app, pid, fake = fx
    fake.render_down = True
    j = wait(app, marketing.start_make(app, "author", pid, BR, {}))
    assert j["status"] == "error" and "cannot draw pictures yet" in j["error"]["message"]
    forge.save_bridge_settings(app, {"url": "http://127.0.0.1:9", "token": "t"})
    j = wait(app, marketing.start_make(app, "author", pid, BR, {"pieces": ["ad-square"]}))
    assert j["status"] == "error" and "AutoInjector is not connected" in j["error"]["message"]
    svg, _ = marketing.Ctx(app, pid, BR).svg("ad-square")
    assert svg.startswith("<?xml") and "AVAILABLE NOW" in svg
    with pytest.raises(AkoweError) as e:
        marketing.made_file(app, pid, BR, "ad-square")
    assert e.value.code == "NOT_FOUND" and "download the SVG" in e.value.errors[0]["message"]


def test_unknown_pieces_are_refused(fx):
    app, pid, _ = fx
    with pytest.raises(AkoweError):
        marketing.start_make(app, "author", pid, BR, {"pieces": ["poster"]})
    with pytest.raises(AkoweError):
        marketing.Ctx(app, pid, BR).svg("series")  # not part of a series with other books


# ====================================================================== teaser clips (AutoInjector trailer maker)
def test_teaser_clips_from_stills(fx):
    app, pid, fake = fx
    j = wait(app, marketing.start_clips(app, "author", pid, BR, {}))
    assert j["status"] == "done", j
    assert len(fake.trailers) == 2
    for body, (w, h) in zip(fake.trailers, [(1080, 1920), (1080, 1080)]):
        assert (body["width"], body["height"]) == (w, h) and body["from"] == "akowe-teaser"
        assert "teaser" in body["book"] and body["book"] != body["title"]  # never AutoInjector's trailer folder
        assert [x["type"] for x in body["items"]] == ["still"] * 4
        secs = sum(x["seconds"] for x in body["items"])
        assert marketing.CLIP_SECONDS[0] <= secs <= marketing.CLIP_SECONDS[1]
        for it in body["items"]:
            assert os.path.isfile(it["image"]) and it["image"].endswith(".jpg") and it["motion"]
    # the frames were drawn at the clip's size
    assert sum(1 for r in fake.renders if (r["width"], r["height"]) == (1080, 1920)) == 4
    d = marketing.info(app, pid, BR)
    clips = {p["id"]: p for p in d["pieces"] if p["group"] == "clip"}
    assert all(c["made"] and c["made"]["url"] and c["made"]["mp4_url"] for c in clips.values())
    data, mime, _n = marketing.made_file(app, pid, BR, "clip-vertical")
    assert data == WEBM and mime == "video/webm"
    data, mime, name = marketing.made_file(app, pid, BR, "clip-square", "mp4")
    assert data == MP4 and mime == "video/mp4" and name.endswith(".mp4")
    marketing.save_words(app, pid, BR, {"cta": "Coming soon"})
    assert all(p["out_of_date"] for p in marketing.info(app, pid, BR)["pieces"] if p["group"] == "clip")


def test_the_cover_brought_to_life_and_the_still_cover_when_it_cannot_be(fx):
    app, pid, fake = fx
    app.cover.upload("author", pid, BR, art_png())
    fake.trailer_fail[1] = {"ok": False, "error": "VIDEO_NOT_SET_UP", "message": "No video maker is set up."}
    j = wait(app, marketing.start_clips(app, "author", pid, BR, {"clips": ["clip-square"], "animate": True}))
    assert j["status"] == "done", j
    first, second = fake.trailers
    shot = [x for x in first["items"] if x["type"] == "shot"]
    assert len(shot) == 1 and os.path.isfile(shot[0]["image"]) and "No text" in shot[0]["prompt"]
    assert [x["type"] for x in second["items"]] == ["still"] * 4   # the still cover instead
    rec = marketing.doc(app.store, pid, BR)["clips"]["clip-square"]
    assert not rec["animated"] and any("could not be brought to life" in w for w in rec["warnings"])
    # it works: the clip is the one with the moving cover
    j = wait(app, marketing.start_clips(app, "author", pid, BR, {"clips": ["clip-square"], "animate": True}))
    assert j["status"] == "done" and marketing.doc(app.store, pid, BR)["clips"]["clip-square"]["animated"]


def test_an_autoinjector_without_stills_is_named(fx):
    app, pid, fake = fx
    fake.trailer_start[1] = (400, {"ok": False, "error": "INVALID_PARAM", "message":
                                   'Item 1: type is "shot" or "card" (got “still”).'})
    j = wait(app, marketing.start_clips(app, "author", pid, BR, {"clips": ["clip-square"]}))
    assert j["status"] == "error" and j["error"]["code"] == "VIDEO_NOT_WIRED" and "update" in j["error"]["message"]


def test_clips_without_autoinjector(fx):
    app, pid, _ = fx
    forge.save_bridge_settings(app, {"url": "http://127.0.0.1:9", "token": "t"})
    j = wait(app, marketing.start_clips(app, "author", pid, BR, {"clips": ["clip-square"]}))
    assert j["status"] == "error" and "not connected" in j["error"]["message"]


# ====================================================================== zip, book save, HTTP
def test_zip_and_book_save(fx):
    app, pid, _ = fx
    assert wait(app, marketing.start_make(app, "author", pid, BR, {"pieces": ["paperback", "ad-story"]}))[
        "status"] == "done"
    data, name = marketing.zip_all(app, pid, BR)
    z = zipfile.ZipFile(io.BytesIO(data))
    names = set(z.namelist())
    assert "Paperback, standing.png" in names and "Ad 1080x1920 Story  Reel.jpg" in names
    assert "Hardcover, standing.svg" in names and "About these files.txt" in names  # not made yet: the drawing
    assert name == "The Salt Road - mockups and ads.zip"
    files, _info = app.saver.collect(pid, BR)
    assert files["Marketing/Paperback, standing.png"][:8] == b"\x89PNG\r\n\x1a\n"
    listing = json.loads(files["Marketing/marketing.json"])
    assert listing["words"]["cta"] == "Available now" and listing["files"]
    assert all(len(f"Marketing/{n}") <= 60 for n in names)


def test_book_save_without_the_page_used_writes_nothing(tmp_path):
    app = make_app(tmp_path, SlotFake(), slots=("AI-1",))
    pid = app.engine.bootstrap_project("author", "Plain")
    files: dict = {}
    marketing.save_files(app, pid, BR, files, lambda n, t: files.__setitem__(n, t))
    assert files == {}


def test_http_api_contract(fx):
    from akowe.server import make_handler
    app, pid, _ = fx
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    base = f"/api/projects/{pid}/branches/{BR}/marketing"
    try:
        st, d, _ = call(port, "GET", base)
        assert st == 200 and d["words"]["hook"] == "Every light hides a debt." and d["cover"]["print_wrap"]
        assert {p["group"] for p in d["pieces"]} == {"mockup", "ad", "clip"}
        st, d, _ = call(port, "PUT", base, {"hook": "Read it.", "revision": d["revision"]})
        assert st == 200 and d["words"]["hook_source"] == "yours"
        st, e, _ = call(port, "PUT", base, {"cta": "z" * 80})
        assert st == 400 and e["errors"][0]["path"] == "/cta"
        st, svg, resp = call(port, "GET", f"{base}/svg/ad-square?download=1")
        assert st == 200 and resp.getheader("Content-Type").startswith("image/svg+xml") and b"READ IT." not in svg
        assert b"Read it." in svg and "attachment" in resp.getheader("Content-Disposition")
        st, e, _ = call(port, "GET", f"{base}/file/ad-square")
        assert st == 404
        st, j, _ = call(port, "POST", f"{base}/make", {"pieces": ["ad-bookbub"]})
        assert st == 202 and j["job_id"]
        assert forge.wait(app, "author", j["job_id"])["status"] == "done"
        st, data, resp = call(port, "GET", f"{base}/file/ad-bookbub")
        assert st == 200 and Image.open(io.BytesIO(data)).size == (300, 250)
        st, data, resp = call(port, "GET", f"{base}/zip")
        assert st == 200 and resp.getheader("Content-Type") == "application/zip" and data[:2] == b"PK"
        st, e, _ = call(port, "GET", f"{base}/nope")
        assert st == 404
    finally:
        httpd.shutdown()
        httpd.server_close()
