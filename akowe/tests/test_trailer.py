"""🎞 B2 book trailers (trailer.py): the plan built from the book (title / logline / closing cards, an establishing
shot of the main place, key chapters but never the ending, the characters' approved looks and character locks, chosen
chapter pictures and portraits brought to life, 5-8 shots), checking the author's edits, the make job against a fake
AutoInjector bridge that follows the contract (POST /video/trailer → 202 + id, GET /video/trailer?id= until done,
POST /video/trailer/cancel): the request body, progress, storing trailer.webm + .mp4 with the book, Stop, a missing
character lock, every error code in plain words, AutoInjector restarting, the book save and the HTTP API."""
from __future__ import annotations

import io
import json
import os
import threading
import time
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import pytest
from PIL import Image

from akowe import forge, pictures, trailer
from akowe import providers as prov_mod
from akowe.errors import AkoweError

from test_failover_review import SlotFake, make_app, run_book
from test_server import call

BR = "main"
WEBM = b"\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x42\xf7\x81\x01\x42\x82\x84webm" + bytes(range(256)) * 4
MP4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + b"\x00\x00\x00\x08free" + bytes(range(200))


def png(w=40, h=30, color=(200, 40, 40)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, "PNG")
    return buf.getvalue()


class TrailerBridge:
    """AutoInjector's service bridge for 🎞 trailers (docs/VIDEO_API.md "Trailers"). ``start``: call n -> (status,
    body) for POST /video/trailer; ``results``: trailer n -> its result; ``polls``: GET answers that are still busy;
    ``lose``: trailer n is unknown (AutoInjector restarted)."""

    def __init__(self, out_dir):
        self.out = out_dir
        self.reset()
        bridge = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, status, out):
                data = json.dumps(out).encode()
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except OSError:
                    pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                bridge.auth.append(self.headers.get("Authorization"))
                if self.path == "/video/trailer/cancel":
                    bridge.cancels += 1
                    for t in bridge.runs.values():
                        t["cancelled"] = True
                    return self._send(200, {"ok": True, "cancelled": True})
                if self.path != "/video/trailer":
                    return self._send(404, {"ok": False, "error": "NOT_FOUND"})
                bridge.requests.append(body)
                bridge.seen.append([(it.get("image"), os.path.isfile(it["image"])) for it in body.get("items", [])
                                    if it.get("image")])
                n = len(bridge.requests)
                if n in bridge.start:
                    return self._send(*bridge.start[n])
                bridge.runs[f"t{n}"] = {"n": n, "polls": 0, "cancelled": False,
                                        "shots": sum(1 for x in body["items"] if x["type"] == "shot")}
                return self._send(202, {"ok": True, "started": True, "id": f"t{n}", "status": {"busy": True}})

            def do_GET(self):
                bridge.auth.append(self.headers.get("Authorization"))
                u = urlparse(self.path)
                if u.path != "/video/trailer":
                    return self._send(404, {"ok": False, "error": "NOT_FOUND"})
                tid = (parse_qs(u.query).get("id") or [""])[0]
                bridge.gets += 1
                t = bridge.runs.get(tid)
                if t is None or t["n"] in bridge.lose:
                    return self._send(404, {"ok": False, "error": "NOT_FOUND", "message": "That trailer is not known"})
                t["polls"] += 1
                if t["cancelled"]:
                    return self._send(200, {"ok": True, "busy": False, "status": {"busy": False, "phase": "cancelled"},
                                            "result": {"ok": False, "error": "VIDEO_CANCELLED", "message": "Stopped."}})
                if t["polls"] <= bridge.polls:
                    k = min(t["shots"], t["polls"])
                    return self._send(200, {"ok": True, "busy": True, "status": {
                        "busy": True, "phase": "shots", "shot": k, "shots": t["shots"], "shotsDone": k - 1}})
                res = bridge.results.get(t["n"])
                if res is None:
                    wp = bridge.out / f"trailer-{t['n']}.webm"
                    wp.write_bytes(WEBM)
                    mp = None
                    if bridge.mp4:
                        mp = bridge.out / f"trailer-{t['n']}.mp4"
                        mp.write_bytes(MP4)
                    res = {"ok": True, "path": str(wp), "mp4": str(mp) if mp else None, "seconds": 31.5,
                           "planned": 31.5, "width": 1280, "height": 720, "reused": bridge.reused,
                           "shots": [{} for _ in range(t["shots"])], "cards": [{}, {}],
                           "warnings": [{"level": "soft", "message": "No ffmpeg was found"}] if not bridge.mp4 else []}
                return self._send(200, {"ok": True, "busy": False, "status": {"busy": False, "phase": "done"},
                                        "result": res})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def reset(self):
        self.requests, self.seen, self.auth = [], [], []
        self.start, self.results, self.runs, self.lose = {}, {}, {}, set()
        self.polls, self.cancels, self.gets, self.reused, self.mp4 = 2, 0, 0, 0, True

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture(scope="module")
def made(tmp_path_factory):
    """One finished Make-a-book run (fake AIs: 3 chapters with scene cards, two characters, one place)."""
    mp = pytest.MonkeyPatch()
    mp.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic, time=time.time))
    mp.setattr(trailer, "POLL_S", 0.02)
    tmp = tmp_path_factory.mktemp("trailer")
    app = make_app(tmp, SlotFake())
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    out = tmp / "videos"
    out.mkdir()
    b = TrailerBridge(out)
    forge.save_bridge_settings(app, {"url": b.url, "token": "trl-token"})
    yield app, run["project_id"], b
    b.close()
    mp.undo()


@pytest.fixture
def bk(made):
    app, pid, b = made
    app.store.set_setting(trailer._key(pid, BR), trailer._empty())  # noqa: SLF001
    app.store.set_setting(pictures._key(pid, BR), pictures._empty())  # noqa: SLF001
    b.reset()
    return app, pid, b


def wait(app, job_id, timeout=30.0):
    return forge.wait(app, "author", job_id, timeout)


def make(app, pid, body=None):
    j = trailer.start_make(app, "author", pid, BR, body or {})
    return wait(app, j["job_id"]), j


def shots_of(items):
    return [x for x in items if x["type"] == "shot"]


# ====================================================================== the plan from the book
def test_plan_from_the_book(bk):
    app, pid, _b = bk
    chs = pictures.chapters(app, "author", pid, BR)
    p = trailer.plan_from_book(app, "author", pid, BR)
    items = p["items"]
    shots = shots_of(items)
    assert trailer.MIN_SHOTS <= len(shots) <= trailer.MAX_SHOTS
    title = (trailer._profile(app, pid).get("title"))  # noqa: SLF001
    assert items[0] == {"type": "card", "text": title, "subtitle": items[0]["subtitle"], "seconds": 3.0}
    assert items[-1]["type"] == "card" and items[-1]["subtitle"] == "Coming soon" and items[-1]["text"] == title
    # the logline card: the approved premise, early in the trailer
    line = trailer.logline(app, "author", pid, BR)
    assert line and any(x["type"] == "card" and x["text"] == line for x in items[1:4])
    # an establishing shot of the main place, no people
    assert shots[0]["label"].startswith("The world: ") and "establishing shot" in shots[0]["prompt"]
    assert shots[0]["character"] is None and shots[0]["seconds"] == 5.0
    # key chapters, never the last one (the ending is not shown)
    labels = " | ".join(s["label"] for s in shots)
    assert "Chapter 1" in labels and f"Chapter {chs[-1]['number']}" not in labels
    # scene → cinematic prompt with the place, the moment and the characters' approved looks + the main character's lock
    ch1 = next(s for s in shots if s["label"].startswith("Chapter 1"))
    ctx = pictures.scene_context(app, "author", pid, BR, chs[0]["chapter_id"], None)
    assert ch1["prompt"].startswith(trailer.CINEMA) and ctx["moment"][:40] in ch1["prompt"]
    assert ctx["place"] in ch1["prompt"] and ch1["prompt"].endswith(trailer.NO_TEXT)
    assert ch1["character"] == ctx["pov"] and f"{ctx['pov']} (" in ch1["prompt"]
    assert all(len(s["prompt"]) <= trailer.PROMPT_MAX and 1 <= s["seconds"] <= 5 for s in shots)
    assert any(s["label"] == f"{ctx['pov']}, close" for s in shots)
    assert p["notes"] == [] and p["made_from"] == "book"


def test_plan_uses_chosen_pictures_and_portraits_and_the_style(bk):
    app, pid, _b = bk
    chs = pictures.chapters(app, "author", pid, BR)
    pictures.set_style(app.store, pid, BR, {"style": "ink wash"})
    pic_id = pictures.ensure_picture(app.store, pid, BR, "chapter", chs[0]["chapter_id"], None)
    asset = forge.store_picture(app.store, "author", pid, BR, png(), "", "ch1")
    pictures.add_candidate(app.store, pid, BR, pic_id, dict(asset, source="upload"), choose=True)
    ctx = pictures.scene_context(app, "author", pid, BR, chs[0]["chapter_id"], None)
    main = next(c for c in ctx["characters"] if c["name"] == ctx["pov"])
    app.forge.upload("author", pid, BR, main["record_id"], "portrait", png(60, 90, (10, 20, 200)), {})
    shots = shots_of(trailer.plan_from_book(app, "author", pid, BR)["items"])
    ch1 = next(s for s in shots if s["label"].startswith("Chapter 1"))
    assert ch1["picture"] == {"kind": "chapter", "id": pic_id} and ch1["character"] is None
    assert "The picture comes to life" in ch1["prompt"]
    close = next(s for s in shots if s["label"] == f"{main['name']}, close")
    assert close["picture"] == {"kind": "portrait", "id": main["record_id"]} and close["character"] is None
    assert all("Art style: ink wash." in s["prompt"] for s in shots)
    # making it sends both pictures as temp files AutoInjector can read (gone afterwards)
    j, _ = make(app, pid)
    assert j["status"] == "done", j
    sent = _b.seen[0]
    assert len(sent) == 2 and all(ok for _p, ok in sent) and all(not os.path.exists(p) for p, _ok in sent)
    req_shots = shots_of(_b.requests[0]["items"])
    assert sum(1 for s in req_shots if s.get("image")) == 2 and not any(s.get("image") and s.get("characterLock")
                                                                         for s in req_shots)


def test_no_outline_no_plan(tmp_path):
    app = make_app(tmp_path, SlotFake())
    pid = app.engine.bootstrap_project("author", "Empty book")
    with pytest.raises(AkoweError) as e:
        trailer.plan_from_book(app, "author", pid, BR)
    assert e.value.code == "MISSING_INPUT" and "plan the chapters first" in e.value.errors[0]["message"]


# ====================================================================== checking the author's plan
@pytest.mark.parametrize("body,path,words", [
    ({}, "/items", "at least one"),
    ({"items": [{"type": "music"}]}, "/items/0/type", "shot or a title card"),
    ({"items": [{"type": "card", "text": " "}]}, "/items/0/text", "needs its text"),
    ({"items": [{"type": "card", "text": "x" * 121}]}, "/items/0/text", "at most 120"),
    ({"items": [{"type": "shot", "seconds": 4}]}, "/items/0/prompt", "needs a description"),
    ({"items": [{"type": "shot", "prompt": "x", "seconds": 9}]}, "/items/0/seconds", "1-5"),
    ({"items": [{"type": "card", "text": "T", "seconds": "long"}]}, "/items/0/seconds", "a number"),
    ({"items": [{"type": "shot", "prompt": "x", "picture": {"kind": "map", "id": "m"}}]}, "/items/0/picture", "portrait"),
    ({"items": [{"type": "card", "text": "T"}] * 25}, "/items", "at most 24"),
    ({"items": [{"type": "card", "text": "T"}], "music": "/nowhere/theme.mp3"}, "/music", "was not found"),
    ({"items": [{"type": "card", "text": "T"}], "music": "/x/theme.exe"}, "/music", "music file"),
])
def test_plan_edits_are_checked(bk, body, path, words):
    app, pid, _b = bk
    with pytest.raises(AkoweError) as e:
        trailer.save_plan(app, pid, BR, body)
    assert e.value.errors[0]["path"] == path and words in e.value.errors[0]["message"]


def test_plan_edits_are_saved(bk, tmp_path):
    app, pid, _b = bk
    song = tmp_path / "theme.ogg"
    song.write_bytes(b"OggS")
    out = trailer.save_plan(app, pid, BR, {"items": [
        {"type": "card", "text": "  The   Keeper  ", "subtitle": "a novel"},
        {"type": "shot", "prompt": "fog over the harbour", "seconds": 2.5, "character": "Mara Vell", "label": "Fog"}],
        "music": str(song)})
    plan = out["plan"]
    assert plan["items"][0] == {"type": "card", "text": "The Keeper", "subtitle": "a novel", "seconds": 3.0}
    assert plan["items"][1] == {"type": "shot", "prompt": "fog over the harbour", "seconds": 2.5,
                                "character": "Mara Vell", "picture": None, "label": "Fog"}
    assert plan["music"] == str(song) and plan["made_from"] == "author" and out["shots"] == 1 and out["seconds"] == 5.5


# ====================================================================== making it
def test_make_the_trailer_and_store_it(bk):
    app, pid, b = bk
    j, started = make(app, pid)  # no plan yet: planned from the book first
    assert started["kind"] == "trailer" and started["total"] >= trailer.MIN_SHOTS
    assert j["status"] == "done", j
    assert j["results"][-1]["message"] == "Trailer made (31.5 s) and stored with the book."
    body = b.requests[0]
    title = trailer._profile(app, pid)["title"]  # noqa: SLF001
    assert body["book"] == title and body["from"] == "akowe-trailer" and body["width"] == 1280 and body["height"] == 720
    plan = trailer.doc(app.store, pid, BR)["plan"]
    assert plan["made_from"] == "book" and len(body["items"]) == len(plan["items"])
    for sent, it in zip(body["items"], plan["items"]):
        assert sent["type"] == it["type"] and sent["seconds"] == it["seconds"]
        if it["type"] == "shot":
            assert sent.get("prompt") == it["prompt"] and sent.get("characterLock") == it["character"]
        else:
            assert sent["text"] == it["text"]
    assert b.auth[0] == "Bearer trl-token" and b.gets >= 3
    d = trailer.info(app, pid, BR)
    t = d["trailer"]
    assert t["seconds"] == 31.5 and t["width"] == 1280 and t["shots"] == len(shots_of(plan["items"]))
    assert t["webm"]["mime"] == "video/webm" and t["mp4"]["mime"] == "video/mp4"
    assert t["webm"]["url"].endswith(f"/assets/{t['webm']['asset_id']}/1") and d["out_of_date"] is False
    raw = trailer.doc(app.store, pid, BR)["trailer"]
    assert forge.picture_bytes(app.store, pid, BR, raw["webm"]) == WEBM
    assert forge.picture_bytes(app.store, pid, BR, raw["mp4"]) == MP4
    # the plan changes afterwards: the trailer is out of date
    time.sleep(1.1)
    trailer.save_plan(app, pid, BR, {"items": plan["items"][:3]})
    assert trailer.info(app, pid, BR)["out_of_date"] is True


def test_progress_while_autoinjector_works(bk):
    app, pid, b = bk
    b.polls = 60
    trailer.save_plan(app, pid, BR, {"items": [{"type": "shot", "prompt": f"shot {i}"} for i in range(4)]})
    j = trailer.start_make(app, "author", pid, BR, {})
    seen = set()
    end = time.time() + 10
    while time.time() < end:
        st = app.review.get_job("author", j["job_id"])
        seen.add(st["phase"])
        if st["status"] in ("done", "error", "cancelled"):
            break
        time.sleep(0.01)
    assert st["status"] == "done", st
    assert any(p.startswith("AutoInjector is making shot 2 of 4") for p in seen), seen
    assert st["total"] == 4 and st["done"] == 4


def test_stop_cancels_in_autoinjector(bk):
    app, pid, b = bk
    b.polls = 10_000
    trailer.save_plan(app, pid, BR, {"items": [{"type": "shot", "prompt": "slow"}]})
    j = trailer.start_make(app, "author", pid, BR, {})
    end = time.time() + 5
    while not b.gets and time.time() < end:
        time.sleep(0.01)
    app.review.cancel_job("author", j["job_id"])
    out = wait(app, j["job_id"])
    assert out["status"] == "cancelled" and b.cancels == 1
    assert trailer.doc(app.store, pid, BR)["trailer"] is None


def test_missing_character_lock_is_left_out(bk):
    app, pid, b = bk
    trailer.save_plan(app, pid, BR, {"items": [{"type": "shot", "prompt": "a", "character": "Mara Vell"},
                                               {"type": "shot", "prompt": "b", "character": "Nobody"}]})
    b.results[1] = {"ok": False, "error": "NO_LOCK", "shot": 2, "message": "Shot 2 could not be made: no lock"}
    j, _ = make(app, pid)
    assert j["status"] == "done", j
    assert len(b.requests) == 2
    assert shots_of(b.requests[0]["items"])[1]["characterLock"] == "Nobody"
    assert "characterLock" not in shots_of(b.requests[1]["items"])[1]
    assert shots_of(b.requests[1]["items"])[0]["characterLock"] == "Mara Vell"
    t = trailer.doc(app.store, pid, BR)["trailer"]
    assert any("no character lock named Nobody" in w for w in t["warnings"])


CODES = ["VIDEO_NOT_SET_UP", "VIDEO_MODEL_MISSING", "VIDEO_OOM", "VIDEO_TIMEOUT", "VIDEO_CANCELLED", "VIDEO_FAILED",
         "UNSUPPORTED_ON_BACKEND", "TRAILER_JOIN_FAILED"]


@pytest.mark.parametrize("code", CODES)
def test_every_video_code_in_plain_words(bk, code):
    app, pid, b = bk
    trailer.save_plan(app, pid, BR, {"items": [{"type": "shot", "prompt": "a"}, {"type": "shot", "prompt": "b"}]})
    b.results[1] = {"ok": False, "error": code, "shot": 2, "model": "wan22-ti2v-5b",
                    "message": "Shot 2 could not be made: Allocation on device 0\nTraceback (most recent call last)"}
    j, _ = make(app, pid)
    assert j["status"] == "error"
    e = j["error"]
    title, fix = trailer.PROBLEMS[code]
    assert e["code"] == code and e["fix"] == fix and e["message"].startswith("Shot 2: ")
    assert "Traceback" not in e["message"] and title.split()[0] in e["message"]
    if code == "VIDEO_MODEL_MISSING":
        assert "(model wan22-ti2v-5b)" in e["message"]
    if code in ("VIDEO_FAILED", "TRAILER_JOIN_FAILED"):
        assert "Allocation on device 0" in e["message"]  # AutoInjector's reason, first line only
    assert "Make the trailer" in fix or "🎬 Video" in fix
    assert trailer.doc(app.store, pid, BR)["trailer"] is None


@pytest.mark.parametrize("status,body,code", [
    (409, {"ok": False, "error": "BUSY", "message": "A trailer is already being made."}, "BUSY"),
    (404, {"ok": False, "error": "NOT_FOUND"}, "VIDEO_NOT_WIRED"),   # an AutoInjector without trailers
    (501, {"ok": False, "error": "VIDEO_NOT_WIRED"}, "VIDEO_NOT_WIRED"),
    (401, {"ok": False, "error": "UNAUTHORIZED"}, "IMAGE_BRIDGE_KEY"),
    (400, {"ok": False, "error": "INVALID_PARAM", "field": "items[0].prompt", "message": "Shot 1 needs a description"},
     "INVALID_PARAM"),
    (503, {"ok": False, "error": "VIDEO_NOT_SET_UP", "message": "Video is not set up"}, "VIDEO_NOT_SET_UP"),
])
def test_start_refused(bk, status, body, code):
    app, pid, b = bk
    trailer.save_plan(app, pid, BR, {"items": [{"type": "shot", "prompt": "a"}]})
    b.start[1] = (status, body)
    j, _ = make(app, pid)
    assert j["status"] == "error" and j["error"]["code"] == code and j["error"]["fix"] == trailer.PROBLEMS[code][1]


def test_autoinjector_unreachable_or_restarted(bk):
    app, pid, b = bk
    trailer.save_plan(app, pid, BR, {"items": [{"type": "shot", "prompt": "a"}]})
    b.lose.add(1)
    j, _ = make(app, pid)
    assert j["status"] == "error" and j["error"]["code"] == "TRAILER_LOST" and "kept" in j["error"]["fix"]
    forge.save_bridge_settings(app, {"url": "http://127.0.0.1:9"})
    try:
        j, _ = make(app, pid)
        assert j["status"] == "error" and j["error"]["code"] == "IMAGE_BRIDGE_UNREACHABLE"
        assert "Start the AutoInjector desktop app" in j["error"]["fix"]
    finally:
        forge.save_bridge_settings(app, {"url": b.url})


def test_webm_only_and_a_bad_answer(bk):
    app, pid, b = bk
    trailer.save_plan(app, pid, BR, {"items": [{"type": "card", "text": "Only a card"}]})
    b.mp4 = False
    j, _ = make(app, pid)
    assert j["status"] == "done", j
    t = trailer.info(app, pid, BR)["trailer"]
    assert t["mp4"] is None and t["webm"]["mime"] == "video/webm" and any("ffmpeg" in w for w in t["warnings"])
    b.results[2] = {"ok": True, "path": "/nowhere/trailer.webm", "seconds": 3}
    j, _ = make(app, pid)
    assert j["status"] == "error" and j["error"]["code"] == "VIDEO_BAD_ANSWER"


# ====================================================================== book save + HTTP
def test_book_save_has_the_trailer(bk):
    app, pid, _b = bk
    j, _ = make(app, pid)
    assert j["status"] == "done", j
    files, _info = app.saver.collect(pid, BR)
    assert files["Trailer/trailer.webm"] == WEBM and files["Trailer/trailer.mp4"] == MP4
    listing = json.loads(files["Trailer/trailer.json"])
    assert listing["trailer"]["webm"] == "trailer.webm" and listing["trailer"]["seconds"] == 31.5
    assert len(listing["plan"]["items"]) >= trailer.MIN_SHOTS + 2
    assert app.saver.save_now(pid, BR)["ok"]


def test_http_api_contract(bk):
    from akowe.server import make_handler
    app, pid, b = bk
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    base = f"/api/projects/{pid}/branches/{BR}/trailer"
    try:
        st, d, _ = call(port, "GET", base)
        assert st == 200 and d["plan"] is None and d["trailer"] is None and d["bridge"]["uses"] == [b.url]
        st, p, _ = call(port, "POST", f"{base}/plan")
        assert st == 200 and p["plan"]["made_from"] == "book" and trailer.MIN_SHOTS <= p["shots"] <= trailer.MAX_SHOTS
        assert p["notes"] == [] and p["seconds"] > 20
        items = p["plan"]["items"]
        items[1]["prompt"] = "the author's own words"
        st, s, _ = call(port, "PUT", f"{base}/plan", {"items": items})
        assert st == 200 and s["plan"]["made_from"] == "author" and s["plan"]["items"][1]["prompt"] == "the author's own words"
        st, e, _ = call(port, "PUT", f"{base}/plan", {"items": [{"type": "card"}]})
        assert st == 400 and e["errors"][0]["path"] == "/items/0/text"
        st, j, _ = call(port, "POST", f"{base}/make", {})
        assert st == 202 and j["job_id"] and j["kind"] == "trailer"
        assert wait(app, j["job_id"])["status"] == "done"
        st, j2, _ = call(port, "GET", f"/api/projects/{pid}/branches/{BR}/review/ai/{j['job_id']}")
        assert st == 200 and j2["status"] == "done" and j2["results"][-1]["ok"]
        assert any(s.get("prompt") == "the author's own words" for s in b.requests[-1]["items"])
        st, d, _ = call(port, "GET", base)
        assert st == 200 and d["trailer"]["webm"]["url"]
        st, raw, resp = call(port, "GET", d["trailer"]["webm"]["url"])
        assert st == 200 and raw == WEBM and resp.getheader("Content-Type").startswith("video/webm")
        st, e, _ = call(port, "GET", f"{base}/nope")
        assert st == 404
        st, _x, _ = call(port, "GET", base, token="wrong-token")
        assert st == 401
    finally:
        httpd.shutdown()
        httpd.server_close()
