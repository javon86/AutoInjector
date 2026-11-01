"""🖼 Character pictures in the ⚡ Make-a-book run and the Book Bible's "Make the rest of the pictures" (book_pictures.py),
with a fake AutoInjector picture bridge: a portrait for every character and the full set (portrait, front / side /
back views, sheet) for the ★ protagonist, made with Stable Diffusion and each portrait saved as the character's 🔒 lock;
Stable Diffusion down -> the run still finishes, the pictures go on the book's to-make list and the binder shows
"picture waiting"; Make the rest fills every gap; pause / resume never makes a finished picture again; the setting
switches the run's pictures off."""
from __future__ import annotations

import base64
import io
import json
import threading
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from PIL import Image

from akowe import binder, book_pictures, forge
from akowe.book_path import BookPath

from autobook_fake import BookFakeAI
from test_autobook import make_app, no_provider_sleep, run_book, steps  # noqa: F401

BR = "main"


def png() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (40, 60), (90, 100, 110)).save(buf, "PNG")
    return buf.getvalue()


class PictureBridge:
    """A fake AutoInjector: GET /image/backend, POST /image/request (engine sd), POST /image/locks.
    ``sd_on``: Stable Diffusion connected; ``fail_from``: image request number (1-based) from which SD is gone;
    ``gate``: an Event every image request waits on (``waiting`` is set while one waits)."""

    def __init__(self, sd_on=True):
        self.sd_on = sd_on
        self.chatgpt_ready = False
        self.fail_from: int | None = None
        self.requests: list = []
        self.ok: list = []  # the requests that got a picture
        self.locks: dict = {}
        self.lock_posts: list = []
        self.gate: threading.Event | None = None
        self.waiting = threading.Event()
        bridge = self

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

            def do_GET(self):
                if self.path == "/image/backend":
                    sd = {"connected": bridge.sd_on}
                    return self._send(200, {"ok": True, "connected": bridge.sd_on,
                                            "engines": {"sd": sd, "chatgpt": {"ready": bridge.chatgpt_ready}}})
                return self._send(404, {"ok": False, "error": "NOT_FOUND"})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                if self.path == "/image/locks":
                    bridge.lock_posts.append(body)
                    k = body["character"].lower()
                    if k in bridge.locks:
                        return self._send(200, {"ok": True, "created": False, "lock": bridge.locks[k]})
                    bridge.locks[k] = dict(body, id=f"lock-{len(bridge.locks) + 1}")
                    return self._send(200, {"ok": True, "created": True, "lock": bridge.locks[k]})
                if self.path != "/image/request":
                    return self._send(404, {"ok": False, "error": "NOT_FOUND"})
                if bridge.gate is not None:
                    bridge.waiting.set()
                    bridge.gate.wait(30)
                bridge.requests.append(body)
                n = len(bridge.requests)
                sd_ok = bridge.sd_on and not (bridge.fail_from and n >= bridge.fail_from)
                if body.get("engine") == "sd" and not sd_ok:
                    return self._send(503, {"ok": False, "engine": "sd", "error": "SD_NOT_CONNECTED",
                                            "message": "No Stable Diffusion app is connected."})
                if body.get("engine") == "auto" and not sd_ok and not bridge.chatgpt_ready:
                    return self._send(503, {"ok": False, "error": "NO_IMAGE_ENGINE", "message": "nothing"})
                lock = bridge.locks.get(str(body.get("characterLock") or "").lower())
                seed = lock["seed"] if lock and lock.get("seed") is not None else 7000 + n
                eng = "sd" if sd_ok else "chatgpt"
                bridge.ok.append(body)
                return self._send(200, {"ok": True, "engine": eng, "purpose": body.get("purpose"),
                                        "view": body.get("view"), "seed": seed, "warnings": [],
                                        "images": [{"seed": seed, "imageBase64": base64.b64encode(png()).decode()}]})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def made(self):
        """Counter of (character, what) over the successful requests."""
        return Counter((r.get("characterLock"), r.get("view") or r.get("purpose")) for r in self.ok)

    def close(self):
        if self.gate is not None:
            self.gate.set()
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def world(tmp_path):
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake)
    b = PictureBridge()
    forge.save_bridge_settings(app, {"url": b.url})
    yield app, fake, b
    b.close()


def people(app, pid):
    return {r["record_id"]: r for r in BookPath(app.engine, "author", pid, BR).approved("A01")}


def slots_of(app, pid, rid):
    return book_pictures.have(app.store, pid, BR, rid)


# ---------------------------------------------------------------------------------------------- during the run
def test_run_makes_a_portrait_each_full_set_for_the_protagonist_and_locks(world):
    app, _fake, b = world
    run = run_book(app, {"genre": "Mystery", "length": "short_story"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    pid = run["project_id"]
    st = steps(run)["pictures"]
    assert st["state"] == "done" and st["started_at"] and st["finished_at"]
    ids = [s["id"] for s in run["steps"]]
    assert ids.index("characters") < ids.index("pictures") < ids.index("world")
    chars = people(app, pid)
    assert len(chars) >= 2
    prot = book_pictures.protagonist_id(app.store, pid, BR)
    assert prot in chars
    for rid in chars:
        have = slots_of(app, pid, rid)
        if rid == prot:
            assert have == set(book_pictures.FULL), have
        else:
            assert have == {"portrait"}, have
    # every picture was asked of Stable Diffusion, each once, the protagonist first
    assert b.requests and all(r["engine"] == "sd" and r["from"] == "akowe-forge" for r in b.requests)
    made = b.made()
    assert all(n == 1 for n in made.values()), made
    prot_name = forge.public(app.store, pid, BR, prot)["name"]
    assert b.requests[0]["characterLock"] == prot_name and b.requests[0]["purpose"] == "portrait"
    assert sum(1 for k in made if k[1] == "portrait") == len(chars)
    assert {k[1] for k in made if k[0] == prot_name} == {"portrait", "front", "side", "back", "sheet"}
    # each portrait became that character's lock (looks + the portrait's seed); later views use it
    assert len(b.lock_posts) == len(chars)
    assert all(p["from"] == "akowe" and isinstance(p.get("seed"), int) and p["prompt"] for p in b.lock_posts)
    s = book_pictures.state(app.store, pid, BR)
    assert set(s["locks"]) == set(chars) and all(x["created"] for x in s["locks"].values())
    pt_seed = forge.raw_entry(app.store, pid, BR, prot)["art"]["portrait"]["seed"]
    assert b.locks[prot_name.lower()]["seed"] == pt_seed
    assert forge.raw_entry(app.store, pid, BR, prot)["art"]["views"]["side"]["seed"] == pt_seed
    assert not s["waiting"] and s["made"] == len(chars) + 4
    evs = app.autobook.get(run["id"])["events"]
    assert any(e["step"] == "pictures" and "character lock" in e["message"] for e in evs)
    # the binder shows the portraits; nothing is waiting
    data = binder.build(app, pid, BR)
    assert data["pictures"]["waiting_count"] == 0
    char_pages = [p for p in data["pages"] if p["template"] == "5"]
    assert char_pages and all(p["pics"].get("5.1.1") for p in char_pages)
    assert not any("pictures_waiting" in p for p in char_pages)


def test_forge_down_the_run_finishes_and_the_pictures_wait(world):
    app, _fake, b = world
    b.sd_on = False
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    pid = run["project_id"]
    st = steps(run)["pictures"]
    assert st["state"] == "done" and "waiting on the to-make list" in st["message"]
    assert all(i["state"] == "later" for i in st["items"])
    assert not b.requests  # one look at the picture maker, then nothing is asked
    ev = [e for e in app.autobook.get(run["id"])["events"] if e.get("code") == "PICTURES_WAITING"]
    assert ev and "Make the rest of the pictures" in ev[0]["message"] and "the book goes on" in ev[0]["message"]
    chars = people(app, pid)
    prot = book_pictures.protagonist_id(app.store, pid, BR)
    waiting = book_pictures.state(app.store, pid, BR)["waiting"]
    assert set(waiting) == set(chars)
    assert waiting[prot]["slots"] == list(book_pictures.FULL)
    assert all(w["slots"] == ["portrait"] for rid, w in waiting.items() if rid != prot)
    assert all(w["code"] == "SD_NOT_CONNECTED" for w in waiting.values())
    # the binder: "picture waiting" on those pages, in the to-do list and in the numbers
    data = binder.build(app, pid, BR)
    assert data["pictures"]["waiting_count"] == len(chars) + 4
    pages = {p["entry_id"]: p for p in data["pages"] if p["template"] == "5"}
    assert pages[prot]["pictures_waiting"] == list(book_pictures.FULL)
    assert all(pages[rid]["pictures_waiting"] == ["portrait"] for rid in chars if rid != prot)
    assert any(t["kind"] == "picture" and "waiting" in t["what"] for t in data["todo"])
    # the summary the button reads
    summ = book_pictures.summary(app.store, pid, BR)
    assert summ["missing"] == 5 * len(chars) and summ["characters"] == len(chars)


def test_forge_goes_down_mid_run_and_make_the_rest_fills_every_gap(world):
    app, _fake, b = world
    b.fail_from = 3  # the protagonist's portrait and first view are made, then Stable Diffusion is gone
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    pid = run["project_id"]
    chars = people(app, pid)
    prot = book_pictures.protagonist_id(app.store, pid, BR)
    assert slots_of(app, pid, prot) == {"portrait", "front"}
    waiting = book_pictures.waiting_by_record(app.store, pid, BR)
    assert waiting[prot] == ["side", "back", "sheet"]
    assert all(waiting[rid] == ["portrait"] for rid in chars if rid != prot)
    asked = len(b.requests)
    assert asked == 3  # after the picture maker went away, nothing more was asked in the run
    # 🖼 Make the rest of the pictures (Stable Diffusion is back): every character's full set
    b.fail_from = None
    job = book_pictures.start_rest(app, "author", pid, BR)
    assert job["total"] == 5 * len(chars) - 2
    out = forge.wait(app, "author", job["job_id"], 60)
    assert out["status"] == "done", out
    last = out["results"][-1]
    assert last["ok"] and last["made"] == 5 * len(chars) - 2 and "picture(s) made" in last["message"]
    for rid in chars:
        assert slots_of(app, pid, rid) == set(book_pictures.FULL)
    assert not book_pictures.state(app.store, pid, BR)["waiting"]
    made = b.made()
    assert all(n == 1 for n in made.values()), made  # nothing made twice (the failed request got no picture)
    data = binder.build(app, pid, BR)
    assert data["pictures"]["waiting_count"] == 0 and data["pictures"]["rest"] == 0
    # pressed again: nothing to make
    out2 = forge.wait(app, "author", book_pictures.start_rest(app, "author", pid, BR)["job_id"], 30)
    assert "already has all" in out2["results"][-1]["message"]


def test_make_the_rest_with_forge_still_down_says_so_and_keeps_the_list(world):
    app, _fake, b = world
    b.sd_on = False
    run = run_book(app, {"length": "short_story"})
    pid = run["project_id"]
    out = forge.wait(app, "author", book_pictures.start_rest(app, "author", pid, BR)["job_id"], 30)
    assert out["status"] == "done"
    last = out["results"][-1]
    assert last["ok"] is False and "Stable Diffusion" in last["message"]
    assert len(book_pictures.state(app.store, pid, BR)["waiting"]) == len(people(app, pid))
    assert not b.requests


def test_make_the_rest_can_be_stopped_and_keeps_what_was_made(world):
    app, _fake, b = world
    b.sd_on = False
    run = run_book(app, {"length": "short_story"})
    pid = run["project_id"]
    b.sd_on = True
    b.gate = threading.Event()
    job = book_pictures.start_rest(app, "author", pid, BR)
    assert b.waiting.wait(30)
    app.review.cancel_job("author", job["job_id"])
    b.gate.set()
    out = forge.wait(app, "author", job["job_id"], 30)
    assert out["status"] == "cancelled"
    assert len(b.requests) == 1
    prot = book_pictures.protagonist_id(app.store, pid, BR)
    assert "portrait" in slots_of(app, pid, prot)  # the picture in flight when Stop was pressed is kept


def test_pause_and_resume_never_make_a_finished_picture_again(world):
    app, _fake, b = world
    b.gate = threading.Event()
    r = app.autobook.start("author", {"author_confirms": True, "length": "short_story"})
    assert b.waiting.wait(60), "the run never asked for a picture"
    app.autobook.pause("author", r["id"])
    b.gate.set()
    app.autobook.wait_for(r["id"], 60)
    run = app.autobook.get(r["id"])
    assert run["status"] == "paused" and steps(run)["pictures"]["state"] == "paused"
    assert len(b.requests) == 1
    b.gate = None
    app.autobook.resume("author", r["id"])
    app.autobook.wait_for(r["id"], 120)
    run = app.autobook.public(app.autobook.get(r["id"]))
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    made = b.made()
    assert all(n == 1 for n in made.values()), made
    pid = run["project_id"]
    prot = book_pictures.protagonist_id(app.store, pid, BR)
    assert slots_of(app, pid, prot) == set(book_pictures.FULL)
    assert len(b.lock_posts) == len(people(app, pid))


def test_the_setting_switches_the_run_pictures_off(world):
    app, _fake, b = world
    info = forge.save_bridge_settings(app, {"run_pictures": {"run": False}})
    assert info["run_pictures"] == {"run": False, "engine": "sd"}
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done"
    st = steps(run)["pictures"]
    assert st["state"] == "done" and st["message"].startswith("Off")
    assert not b.requests and not b.lock_posts
    # a run can still ask for them itself
    run2 = run_book(app, {"length": "short_story", "pictures": True})
    assert run2["status"] == "done" and b.requests
    with pytest.raises(Exception):
        forge.save_bridge_settings(app, {"run_pictures": {"engine": "dalle"}})


def test_auto_engine_falls_back_only_when_the_setting_allows(world):
    app, _fake, b = world
    b.sd_on = False
    b.chatgpt_ready = True
    forge.save_bridge_settings(app, {"run_pictures": {"engine": "auto"}})
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done"
    pid = run["project_id"]
    assert b.requests and all(r["engine"] == "auto" for r in b.requests)
    assert all("portrait" in slots_of(app, pid, rid) for rid in people(app, pid))
    assert not book_pictures.state(app.store, pid, BR)["waiting"]
