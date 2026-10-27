"""🎬 B5 / B2 Character Forge motion clips (docs/CHARACTER_FORGE.md "Motion clip", contract: AutoInjector
POST /video/request): the request body (the portrait as a temp-file path, the prompt from the appearance / posture /
gait / expressions fields + the fixed idle-motion words, 4 s, purpose clip), storing the clip and its poster as book
assets, every video error code in plain words, Stop while AutoInjector works, the author's own clip (type and size
checks), the PDF with and without a clip, the book save and the HTTP API. AutoInjector is a fake bridge that follows
the contract."""
from __future__ import annotations

import base64
import io
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pypdf
import pypdfium2 as pdfium
import pytest

from akowe import forge, forge_pdf
from akowe.errors import AkoweError

from test_failover_review import make_app, no_provider_sleep  # noqa: F401
from test_forge import BR, ForgeFake, make_char, png, put
from test_server import call

MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00\x00\x00\x08free" + bytes(range(256)) * 8
WEBM = b"\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x42\xf7\x81\x01\x42\x82\x84webm" + b"\x00" * 600
RED = (200, 30, 40)


class FakeVideoBridge:
    """AutoInjector's service bridge for POST /video/request (CONTRACT section 1): writes the clip and its poster into
    an output folder and answers {ok, engine, model, path, poster, seconds, frames, fps, width, height, seed} (+ the
    poster as base64 with returnPoster). ``script``: call number -> (status, body); ``delay``: seconds before answering;
    ``poster_mode``: "base64" | "path" | "none"."""

    def __init__(self, out_dir):
        self.requests: list = []
        self.seen_image: list = []   # (path existed?, bytes) at the time of the request
        self.auth: list = []
        self.script: dict = {}
        self.delay = 0.0
        self.poster_mode = "base64"
        self.video = MP4
        self.poster = png(48, 60, RED)
        self.out = out_dir
        bridge = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                bridge.requests.append(body)
                bridge.auth.append(self.headers.get("Authorization"))
                img = body.get("image")
                ok = isinstance(img, str) and os.path.isfile(img)
                bridge.seen_image.append((ok, open(img, "rb").read() if ok else None))
                n = len(bridge.requests)
                if bridge.delay:
                    time.sleep(bridge.delay)
                if self.path != "/video/request":
                    status, out = 404, {"ok": False, "error": "NOT_FOUND"}
                elif n in bridge.script:
                    status, out = bridge.script[n]
                else:
                    ext = ".webm" if bridge.video[:4] == b"\x1a\x45\xdf\xa3" else ".mp4"
                    vp = bridge.out / f"clip-{n}{ext}"
                    vp.write_bytes(bridge.video)
                    pp = bridge.out / f"clip-{n}.png"
                    poster = bridge.poster
                    pp.write_bytes(poster)
                    status, out = 200, {"ok": True, "engine": "comfy-wan", "model": "wan22-ti2v-5b", "path": str(vp),
                                        "poster": str(pp), "seconds": 4, "frames": 97, "fps": 24, "width": 480,
                                        "height": 640, "seed": 77}
                    if bridge.poster_mode == "base64" and body.get("returnPoster"):
                        out["posterBase64"] = base64.b64encode(poster).decode()
                        pp.unlink()  # only the base64 can be the poster now
                    elif bridge.poster_mode == "none":
                        pp.unlink()
                        out.pop("poster")
                data = json.dumps(out).encode()
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except OSError:
                    pass  # the client gave up (timeout test)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def vb(tmp_path):
    app = make_app(tmp_path, ForgeFake(), slots=("AI-1",))
    pid = app.engine.bootstrap_project("author", "Clip book")
    out = tmp_path / "videos"
    out.mkdir()
    b = FakeVideoBridge(out)
    forge.save_bridge_settings(app, {"url": b.url, "token": "vid-token-1"})
    yield app, pid, b
    b.close()


def with_portrait(app, pid, name="Moki Vey", color=(120, 130, 140)):
    rid = make_char(app, pid, name)
    app.forge.upload("author", pid, BR, rid, "portrait", png(60, 90, color), {})
    return rid


def run_clip(app, pid, rid, body=None):
    j = app.forge.start_art("author", pid, BR, rid, body or {"what": "clip", "engine": "auto"})
    return forge.wait(app, "author", j["job_id"])


def asset_bytes(app, pid, a):
    rec = app.store.get_record(pid, BR, a["asset_id"], a.get("version") or 1)
    return rec["binary"]["mime_type"], app.store.read_binary(rec)


# ====================================================================== the request and storing the clip
def test_clip_request_body_and_stored_clip_and_poster(vb):
    app, pid, b = vb
    rid = with_portrait(app, pid)
    put(app, pid, rid, {"record": {"appearance": {"text": "Compact build, platinum twists."}},
                        "appearance_detail": {"posture": {"text": "Weight on the back foot."},
                                              "gait": {"text": "Short, quiet steps."},
                                              "presence": {"text": "A wary half-smile."},
                                              "face": {"text": "Not in the motion prompt."}}})
    rev = forge.public(app.store, pid, BR, rid)["revision"]
    j = run_clip(app, pid, rid)
    assert j["status"] == "done", j
    assert j["results"][-1]["message"] == "Motion clip made and stored with the book."
    body = b.requests[0]
    assert body["seconds"] == 4 and body["purpose"] == "clip" and body["from"] == "akowe-forge"
    assert body["returnPoster"] is True and "characterLock" not in body and "engine" not in body
    # the portrait went as a temp-file path (the bridge body limit is 1 MB), readable while AutoInjector worked
    assert isinstance(body["image"], str) and not body["image"].startswith("data:")
    existed, sent = b.seen_image[0]
    assert existed and sent == png(60, 90, (120, 130, 140))
    assert not os.path.exists(body["image"])  # cleaned up afterwards
    p = body["prompt"]
    assert p.startswith("Moki Vey. Appearance: Compact build, platinum twists")
    assert "Posture: Weight on the back foot" in p and "Gait: Short, quiet steps" in p
    assert "Expressions: A wary half-smile" in p and "Not in the motion prompt" not in p
    assert p.endswith(forge.CLIP_MOTION) and forge.CLIP_MOTION == "subtle idle motion, breathing, cloth moving, camera still"
    assert b.auth == ["Bearer vid-token-1"]
    d = forge.public(app.store, pid, BR, rid)
    c = d["art"]["clip"]
    assert c["mime"] == "video/mp4" and c["model"] == "wan22-ti2v-5b" and c["engine"] == "comfy-wan"
    assert c["seconds"] == 4 and c["fps"] == 24 and c["width"] == 480 and c["seed"] == 77
    assert c["url"].endswith(f"/assets/{c['asset_id']}/1") and c["poster"]["mime"] == "image/png"
    assert asset_bytes(app, pid, c) == ("video/mp4", MP4)
    assert asset_bytes(app, pid, c["poster"]) == ("image/png", png(48, 60, RED))
    assert d["revision"] == rev  # pictures and clips never bump the revision
    item = next(x for x in forge.list_dossiers(app.store, pid, BR) if x["record_id"] == rid)
    assert item["has_clip"] is True
    assert forge.raw_entry(app.store, pid, BR, rid)["art"]["clip"]["made_from"] == "portrait"
    assert forge.raw_entry(app.store, pid, BR, rid)["history"][-1]["what"] == "art"


def test_clip_from_the_front_view_webm_and_poster_shapes(vb):
    app, pid, b = vb
    rid = make_char(app, pid, "Bo Rook")
    # no portrait and no front view: nothing to animate, refused before any job
    with pytest.raises(AkoweError) as e:
        app.forge.start_art("author", pid, BR, rid, {"what": "clip", "engine": "auto"})
    assert e.value.code == "MISSING_INPUT" and "portrait" in e.value.errors[0]["message"]
    with pytest.raises(AkoweError) as e:
        app.forge.start_art("author", pid, BR, rid, {"what": "clip", "engine": "sd"})
    assert e.value.code == "INVALID_INPUT"
    app.forge.upload("author", pid, BR, rid, "front", png(30, 40, (10, 200, 10), fmt="JPEG"), {})
    b.video, b.poster_mode = WEBM, "path"
    j = run_clip(app, pid, rid)
    assert j["status"] == "done", j
    assert b.requests[0]["image"].endswith(".jpg") and b.seen_image[0][1][:3] == b"\xff\xd8\xff"
    assert b.requests[0]["prompt"] == f"Bo Rook. {forge.CLIP_MOTION}"  # no appearance text yet: the fixed words
    c = forge.public(app.store, pid, BR, rid)["art"]["clip"]
    assert c["mime"] == "video/webm" and asset_bytes(app, pid, c["poster"])[1] == png(48, 60, RED)
    assert forge.raw_entry(app.store, pid, BR, rid)["art"]["clip"]["made_from"] == "front"
    # no poster in the answer: the source picture is the poster (picture→video starts from it), with a warning
    b.poster_mode = "none"
    j = run_clip(app, pid, rid)
    assert j["status"] == "done", j
    c = forge.public(app.store, pid, BR, rid)["art"]["clip"]
    assert asset_bytes(app, pid, c["poster"])[0] == "image/jpeg" and "no poster" in " ".join(c["warnings"])


def test_clip_files_reads_every_answer_shape(tmp_path):
    v = tmp_path / "c.mp4"
    v.write_bytes(MP4)
    pp = tmp_path / "c.png"
    pp.write_bytes(png())
    b64 = base64.b64encode(png(5, 5)).decode()
    assert forge.clip_files({"path": str(v), "poster": str(pp)}) == (MP4, png())
    assert forge.clip_files({"path": str(v), "posterBase64": b64}) == (MP4, png(5, 5))
    assert forge.clip_files({"path": str(v), "poster": "data:image/png;base64," + b64}) == (MP4, png(5, 5))
    assert forge.clip_files({"path": str(v), "poster": "/no/such.png"}) == (MP4, None)
    for bad in ({}, {"path": "/no/such.mp4"}, {"path": str(pp)}):
        with pytest.raises(forge.ArtProblem) as e:
            forge.clip_files(bad)
        assert e.value.code == "VIDEO_BAD_ANSWER"
    assert forge.sniff_video(MP4) == "video/mp4" and forge.sniff_video(WEBM) == "video/webm"
    assert forge.sniff_video(png()) is None and forge.sniff_video(b"") is None


# ====================================================================== error codes in plain words
FIXES = {
    "VIDEO_NOT_SET_UP": "set up video",
    "VIDEO_MODEL_MISSING": "In AutoInjector's 🎬 Video tab, download the video model (one click)",
    "VIDEO_OOM": "graphics card",
    "VIDEO_TIMEOUT": "Try again",
    "VIDEO_CANCELLED": "Make the motion clip again",
    "VIDEO_FAILED": "upload it here",
    "UNSUPPORTED_ON_BACKEND": "built-in ComfyUI video",
}


@pytest.mark.parametrize("code", sorted(FIXES))
def test_every_video_error_code_is_plain(vb, code):
    app, pid, b = vb
    rid = with_portrait(app, pid)
    b.script[1] = (500 if code in ("VIDEO_FAILED", "VIDEO_OOM") else 200,
                   {"ok": False, "error": code, "message": "first useful line\nTraceback: noise",
                    "hint": "a developer hint", "model": "wan22-ti2v-5b"})
    j = run_clip(app, pid, rid)
    assert j["status"] == "error" and j["error"]["code"] == code, j
    assert FIXES[code] in j["error"]["fix"] and "developer hint" not in j["error"]["fix"]
    assert j["error"]["message"].startswith("first useful line") and "Traceback" not in j["error"]["message"]
    if code == "VIDEO_MODEL_MISSING":
        assert "wan22-ti2v-5b" in j["error"]["message"]
    assert forge.public(app.store, pid, BR, rid)["art"]["clip"] is None
    assert forge.ART_PROBLEMS[code][1] == j["error"]["fix"]
    js = (forge.Path(forge.__file__).parent / "web" / "problems.js").read_text(encoding="utf-8")
    assert f"  {code}: {{" in js  # the page has plain words for it too


def test_video_bridge_problems_of_akowe_own(vb, monkeypatch):
    app, pid, b = vb
    rid = with_portrait(app, pid)
    b.script[1] = (404, {"ok": False, "error": "NOT_FOUND"})       # an AutoInjector without /video/request
    assert run_clip(app, pid, rid)["error"]["code"] == "VIDEO_NOT_WIRED"
    b.script[2] = (401, {"ok": False, "error": "UNAUTHORIZED"})
    assert run_clip(app, pid, rid)["error"]["code"] == "IMAGE_BRIDGE_KEY"
    b.script[3] = (200, {"ok": True, "engine": "comfy-wan", "path": "/no/such/clip.mp4"})
    j = run_clip(app, pid, rid)
    assert j["error"]["code"] == "VIDEO_BAD_ANSWER" and "upload it here" in j["error"]["fix"]
    # the 900 s timeout is the one sent to the bridge call; a slower answer is VIDEO_TIMEOUT
    seen = []
    real = forge._post
    monkeypatch.setattr(forge, "_post", lambda *a, **k: seen.append((a[3], k.get("route"))) or real(*a, **k))
    b.delay = 1.0
    monkeypatch.setattr(forge, "CLIP_TIMEOUT_S", 0.3)
    j = run_clip(app, pid, rid)
    assert j["error"]["code"] == "VIDEO_TIMEOUT" and seen[-1] == (0.3, "/video/request")
    monkeypatch.undo()
    assert forge.CLIP_TIMEOUT_S == 900.0
    b.delay = 0.0
    b.close()
    j = run_clip(app, pid, rid)
    assert j["error"]["code"] == "IMAGE_BRIDGE_UNREACHABLE"
    b.close = lambda: None  # already closed


def test_stop_while_autoinjector_works_stores_nothing(vb):
    app, pid, b = vb
    rid = with_portrait(app, pid)
    b.delay = 1.5
    j = app.forge.start_art("author", pid, BR, rid, {"what": "clip", "engine": "auto"})
    deadline = time.time() + 5
    while not b.requests and time.time() < deadline:
        time.sleep(0.02)
    app.review.cancel_job("author", j["job_id"])
    t0 = time.time()
    j = forge.wait(app, "author", j["job_id"])
    assert j["status"] == "cancelled" and time.time() - t0 < 1.2  # Akọwe lets go at once
    time.sleep(1.6)
    assert forge.public(app.store, pid, BR, rid)["art"]["clip"] is None


# ====================================================================== the author's own clip
def test_upload_own_clip_type_and_size_checks(vb, monkeypatch):
    app, pid, _b = vb
    rid = make_char(app, pid, "Moki Vey")
    with pytest.raises(AkoweError) as e:  # a poster needs a clip first
        app.forge.upload("author", pid, BR, rid, "clip_poster", png(), {})
    assert e.value.code == "MISSING_INPUT"
    out = app.forge.upload("author", pid, BR, rid, "clip", MP4, {})
    assert out["ok"] and out["art"]["clip"]["source"] == "upload" and out["art"]["clip"]["mime"] == "video/mp4"
    assert out["art"]["clip"]["poster"] is None and out["message"] == "Clip saved with the book."
    out = app.forge.upload("author", pid, BR, rid, "clip_poster", png(20, 25, RED), {})
    assert out["art"]["clip"]["poster"]["mime"] == "image/png" and out["art"]["clip"]["asset_id"]
    assert app.forge.upload("author", pid, BR, rid, "clip", WEBM, {})["art"]["clip"]["mime"] == "video/webm"
    for slot, data in (("clip", png()), ("clip", b"GIF89a....."), ("clip", b""), ("clip", "text"),
                       ("clip", b"RIFF\x00\x00\x00\x00AVI LIST"), ("clip_poster", MP4), ("clip_poster", b"")):
        with pytest.raises(AkoweError) as e:
            app.forge.upload("author", pid, BR, rid, slot, data, {})
        assert e.value.code in ("INVALID_INPUT", "MISSING_INPUT"), (slot, data[:8])
    monkeypatch.setattr(forge, "MAX_CLIP_BYTES", 1000)
    with pytest.raises(AkoweError) as e:
        app.forge.upload("author", pid, BR, rid, "clip", MP4 + b"\x00" * 1000, {})
    assert "larger than" in e.value.errors[0]["message"]
    assert forge.public(app.store, pid, BR, rid)["art"]["clip"]["mime"] == "video/webm"  # the last good one stays


# ====================================================================== the PDF
def test_pdf_with_and_without_a_clip(vb):
    app, pid, _b = vb
    rid = with_portrait(app, pid, color=(40, 90, 200))
    put(app, pid, rid, {"inner_life": {"fear": {"text": "Deep water."}}})
    before, _ = forge.pdf_bytes(app, pid, BR, rid)
    r0 = pypdf.PdfReader(io.BytesIO(before))
    t0 = r0.pages[0].extract_text()
    assert "MOTION STUDY" not in t0 and "/XObject" in r0.pages[0]["/Resources"]
    p0 = pdfium.PdfDocument(before)[0].render(scale=1).to_pil()
    # a clip without a poster changes nothing
    app.forge.upload("author", pid, BR, rid, "clip", MP4, {})
    same, _ = forge.pdf_bytes(app, pid, BR, rid)
    assert pypdf.PdfReader(io.BytesIO(same)).pages[0].extract_text() == t0
    app.forge.upload("author", pid, BR, rid, "clip_poster", png(48, 60, RED), {})
    after, _ = forge.pdf_bytes(app, pid, BR, rid)
    r1 = pypdf.PdfReader(io.BytesIO(after))
    assert len(r1.pages) == len(r0.pages)  # the page count is unchanged
    t1 = r1.pages[0].extract_text()
    assert "MOTION STUDY" in t1 and "Clip, first frame" in t1
    assert len(r1.pages[0]["/Resources"]["/XObject"]) == 2 and len(r0.pages[0]["/Resources"]["/XObject"]) == 1
    for i in range(1, len(r0.pages)):
        assert r1.pages[i].extract_text() == r0.pages[i].extract_text()
    p1 = pdfium.PdfDocument(after)[0].render(scale=1).to_pil()
    # the poster is drawn: red in the motion-study frame, right of the portrait; the portrait moved left
    w, hgt = p1.size
    x_mid = forge_pdf.MARGIN + 360 + 16 + (w - forge_pdf.MARGIN - (forge_pdf.MARGIN + 376)) / 2
    reds = [p1.getpixel((int(x_mid), int(hgt - y)))[:3] for y in range(200, 420, 10)]
    assert any(r > 170 and g < 70 and b < 80 for r, g, b in reds), reds
    blue = lambda px: px[2] > 160 and px[0] < 80  # noqa: E731
    assert blue(p1.getpixel((forge_pdf.MARGIN + 20, hgt // 2))) and not blue(p0.getpixel((forge_pdf.MARGIN + 20, hgt // 2)))
    assert blue(p0.getpixel((126 + 180, hgt // 2)))  # without a clip the portrait stays centred as before
    # with the made clip's seconds in the caption
    d = forge.public(app.store, pid, BR, rid)
    d["art"]["clip"]["seconds"] = 4
    t = pypdf.PdfReader(io.BytesIO(forge_pdf.render(d, {"clip_poster": png(48, 60, RED)}))).pages[0].extract_text()
    assert "4-second loop, first frame" in t
    # a broken poster is left out (never a failure)
    t = pypdf.PdfReader(io.BytesIO(forge_pdf.render(d, {"clip_poster": b"\x89PNG\r\n\x1a\nbroken"}))).pages[0]
    assert "MOTION STUDY" not in t.extract_text()


# ====================================================================== the book save and HTTP
def test_book_save_includes_the_clip(vb):
    app, pid, b = vb
    rid = with_portrait(app, pid)
    assert run_clip(app, pid, rid)["status"] == "done"
    files, _info = app.saver.collect(pid, BR)
    names = sorted(k for k in files if k.startswith("Character Forge/"))
    assert files["Character Forge/CH-001 pictures/motion clip.mp4"] == MP4
    assert files["Character Forge/CH-001 pictures/motion clip poster.png"] == png(48, 60, RED)
    assert "Character Forge/CH-001 pictures/portrait.png" in names
    j = json.loads(files["Character Forge/CH-001 Moki Vey - Character Forge dossier.json"])
    assert j["art"]["clip"]["mime"] == "video/mp4"


def test_http_clip_routes(vb, no_provider_sleep):  # noqa: F811
    from akowe.server import make_handler
    app, pid, _b = vb
    rid = make_char(app, pid, "Moki Vey")
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    base = f"/api/projects/{pid}/branches/{BR}/forge/characters/{rid}"
    try:
        st, e, _ = call(port, "POST", f"{base}/art", {"what": "clip", "engine": "auto"})
        assert st == 400 and e["errors"][0]["code"] == "MISSING_INPUT"  # no portrait yet
        st, _u, _ = call(port, "PUT", f"{base}/art/portrait", png(), content_type="image/png")
        assert st == 200
        st, j, _ = call(port, "POST", f"{base}/art", {"what": "clip", "engine": "auto"})
        assert st == 202 and j["job_id"]
        assert forge.wait(app, "author", j["job_id"])["status"] == "done"
        st, d, _ = call(port, "GET", base)
        assert st == 200 and set(d["art"]) == {"portrait", "views", "sheet", "clip"}
        st, vid, resp = call(port, "GET", d["art"]["clip"]["url"])
        assert st == 200 and vid == MP4 and resp.getheader("Content-Type") == "video/mp4"
        st, u, _ = call(port, "PUT", f"{base}/art/clip", WEBM, content_type="video/webm")
        assert st == 200 and u["art"]["clip"]["mime"] == "video/webm"
        st, u, _ = call(port, "PUT", f"{base}/art/clip_poster", png(), content_type="image/png")
        assert st == 200 and u["art"]["clip"]["poster"]["asset_id"]
        st, e, _ = call(port, "PUT", f"{base}/art/clip", png(), content_type="video/mp4")
        assert st == 400 and "MP4 and WebM" in e["errors"][0]["message"]
        st, lst, _ = call(port, "GET", f"/api/projects/{pid}/branches/{BR}/forge/characters")
        assert lst["characters"][0]["has_clip"] is True
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_field_keys_used_by_the_prompt_exist():
    assert all(k in forge.FIELDS for k, _w in forge.CLIP_PROMPT_FIELDS)
    assert forge.FIELDS["presence"]["label"].startswith("Expressions")
    d = {"name": "X", "sections": [{"fields": [{"key": "posture", "text": "p" * 5000}]}]}
    p = forge.clip_prompt(d)
    assert len(p) <= 1200 and p.endswith(forge.CLIP_MOTION)
