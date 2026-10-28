"""🎞 B2 Book trailer in the browser: a made book's 🎞 Trailer page (More menu) starts empty; 🎬 Plan a trailer
builds the shots and title cards from the book; the author changes a shot, removes one, adds a title card and saves
the plan; 🎞 Make the trailer runs as a job through a fake AutoInjector (POST /video/trailer → GET /video/trailer)
with the shot it is making and Stop; the finished trailer plays on the page; a problem in AutoInjector is shown in
plain words with what to do; no browser problems, no unnamed controls, no sideways scrolling on a phone.
Screenshots go to $BF_UI_SHOTS (see ui_helpers.shot)."""
from __future__ import annotations

import shutil
import subprocess
import threading
import time
import types
from http.server import ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from .ui_helpers import assert_clean, bad_text, goto, overflow, settle, shot, unnamed_controls, watch

from test_failover_review import SlotFake, make_app, run_book
from test_server import TOKEN
from test_trailer import TrailerBridge


@pytest.fixture(scope="module")
def tb(tmp_path_factory):
    from akowe import forge, trailer
    from akowe import providers as prov_mod
    from akowe.server import make_handler
    mp = pytest.MonkeyPatch()
    mp.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic, time=time.time))
    mp.setattr(trailer, "POLL_S", 0.05)
    tmp = tmp_path_factory.mktemp("trailer-ui")
    app = make_app(tmp, SlotFake())
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", run.get("problem")
    out = tmp / "videos"
    out.mkdir()
    bridge = TrailerBridge(out)
    bridge.polls = 25
    # a real, playable trailer when ffmpeg is here (the screenshot shows a frame); else the stand-in bytes
    ff = shutil.which("ffmpeg")
    if ff:
        real = tmp / "real.webm"
        subprocess.run([ff, "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-t", "2",
                        "-c:v", "libvpx", "-b:v", "300k", str(real)], check=False)
        real4 = tmp / "real.mp4"
        subprocess.run([ff, "-loglevel", "error", "-y", "-i", str(real), "-c:v", "libx264", "-pix_fmt", "yuv420p",
                        str(real4)], check=False)
        import test_trailer  # noqa: PLC0415
        if real.exists() and real.stat().st_size:
            mp.setattr(test_trailer, "WEBM", real.read_bytes())
        if real4.exists() and real4.stat().st_size:
            mp.setattr(test_trailer, "MP4", real4.read_bytes())
    forge.save_bridge_settings(app, {"url": bridge.url, "token": "t"})
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    yield SimpleNamespace(app=app, pid=run["project_id"], bridge=bridge, url=f"http://127.0.0.1:{port}/#token={TOKEN}")
    httpd.shutdown()
    httpd.server_close()
    bridge.close()
    mp.undo()


def open_page(make_context, tb, **kw):
    page = watch(make_context(**kw).new_page())
    page.goto(tb.url)
    page.wait_for_selector("#main h1", timeout=15000)
    settle(page)
    goto(page, f"#/p/{tb.pid}/main/trailer")
    page.wait_for_selector("[data-testid=trailer-page] [data-testid=trailer-plan]", timeout=20000)
    return page


def test_trailer_page_plan_edit_make_and_play(make_context, tb):
    page = open_page(make_context, tb)
    assert page.locator("[data-testid=trailer-none]").count() == 1 and page.locator("[data-testid=trailer-empty]").count() == 1
    assert page.locator("#more-links a", has_text="🎞 Trailer").count() == 1
    # 🎬 Plan a trailer: built from the book
    page.click("[data-testid=trailer-plan-book]")
    page.wait_for_function("() => document.querySelectorAll('[data-testid=trailer-item]').length >= 7", timeout=15000)
    kinds = page.eval_on_selector_all("[data-testid=trailer-item]", "els => els.map(e => e.dataset.type)")
    assert kinds[0] == "card" and kinds[-1] == "card" and 5 <= kinds.count("shot") <= 8
    first_card = page.locator("[data-testid=trailer-item][data-type=card]").first
    assert first_card.locator("[data-testid=trailer-card-text]").input_value()
    assert "Coming soon" == page.locator("[data-testid=trailer-item][data-type=card]").last.locator(
        "[data-testid=trailer-card-subtitle]").input_value()
    assert "establishing shot" in page.locator("[data-testid=trailer-prompt]").first.input_value()
    # the author's changes: a prompt, remove the last shot, add a title card, shorter cards
    shots = page.locator("[data-testid=trailer-item][data-type=shot]")
    n_shots = shots.count()
    shots.nth(1).locator("[data-testid=trailer-prompt]").fill("Mara's lantern swings in the fog, the sea below")
    shots.nth(n_shots - 1).locator("[data-testid=trailer-remove]").click()
    page.click("[data-testid=trailer-add-card]")
    page.locator("[data-testid=trailer-item][data-type=card]").last.locator("[data-testid=trailer-card-text]").fill("This winter")
    assert "not saved yet" in page.inner_text("[data-testid=trailer-total]")
    page.click("[data-testid=trailer-save]")
    page.wait_for_function("() => !document.querySelector('[data-testid=trailer-total]').textContent.includes('not saved')",
                           timeout=10000)
    from akowe import trailer
    plan = trailer.doc(tb.app.store, tb.pid, "main")["plan"]
    assert plan["made_from"] == "author" and plan["items"][-1]["text"] == "This winter"
    assert sum(1 for x in plan["items"] if x["type"] == "shot") == n_shots - 1
    assert any(x.get("prompt") == "Mara's lantern swings in the fog, the sea below" for x in plan["items"])
    assert not bad_text(page) and not unnamed_controls(page)
    # 🎞 Make the trailer: a job that says which shot AutoInjector is making, then the player
    n = len(tb.bridge.requests)
    page.click("[data-testid=trailer-make]")
    page.wait_for_function("() => /AutoInjector is making shot \\d+ of \\d+/.test("
                           "(document.querySelector('[data-testid=trailer-phase]') || {}).textContent || '')", timeout=15000)
    assert page.locator("[data-testid=trailer-stop]").is_visible()
    page.wait_for_selector("[data-testid=trailer-video]", timeout=30000)
    body = tb.bridge.requests[n]
    assert body["from"] == "akowe-trailer" and body["items"][-1]["text"] == "This winter"
    assert "31.5 s" in page.inner_text("[data-testid=trailer-meta]") and "MP4 + WebM" in page.inner_text("[data-testid=trailer-meta]")
    page.wait_for_function("() => { const v = document.querySelector('[data-testid=trailer-video]'); return v && v.src.startsWith('blob:'); }",
                           timeout=10000)
    page.evaluate("() => { const v = document.querySelector('[data-testid=trailer-video]'); v.preload = 'auto'; v.currentTime = 1; }")
    settle(page, 800)
    shot(page, "trailer-page")
    assert_clean(page, "trailer page")
    # a problem in AutoInjector: plain words + what to do
    tb.bridge.results[len(tb.bridge.requests) + 1] = {"ok": False, "error": "VIDEO_MODEL_MISSING", "shot": 1,
                                                      "model": "wan22-ti2v-5b", "message": "Shot 1 could not be made: no model"}
    page.click("[data-testid=trailer-make]")
    page.wait_for_selector("[data-testid=trailer-progress] .state.problem", timeout=30000)
    txt = page.inner_text("[data-testid=trailer-progress]")
    assert "The video model is not downloaded yet" in txt and "download the video model" in txt and "Shot 1" in txt
    assert not bad_text(page)


def test_trailer_stop(make_context, tb):
    page = open_page(make_context, tb)
    tb.bridge.polls = 10_000
    try:
        page.click("[data-testid=trailer-make]")
        page.locator("[data-testid=trailer-stop]").wait_for(timeout=15000)
        page.wait_for_function("() => /AutoInjector is making shot/.test((document.querySelector('[data-testid=trailer-phase]') || {}).textContent || '')",
                               timeout=15000)
        cancels = tb.bridge.cancels
        page.click("[data-testid=trailer-stop]")
        page.wait_for_function("() => document.querySelector('[data-testid=trailer-progress]').textContent.includes('Stopped')",
                               timeout=15000)
        assert tb.bridge.cancels == cancels + 1
        assert "kept" in page.inner_text("[data-testid=trailer-progress]")
    finally:
        tb.bridge.polls = 25


def test_trailer_page_fits_a_phone(make_context, tb):
    page = open_page(make_context, tb, width=390, height=844)
    settle(page, 400)
    assert overflow(page) <= 1
    shot(page, "trailer-page-phone")
    assert_clean(page, "phone")
