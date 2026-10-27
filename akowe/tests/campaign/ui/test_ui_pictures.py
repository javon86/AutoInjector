"""🖼 B3 Pictures in the browser: a made book's Pictures page lists its chapters; the art style is saved; 🖼 Illustrate
makes 2 candidates through a fake AutoInjector bridge and the author picks one, adds a caption and a placement; the
map is drawn from the places (SVG); "Illustrate every chapter" runs as a job with progress and Stop; the page tells
when the book must be put together again; no browser problems, no unnamed controls, no sideways scrolling on a
phone. Screenshots go to $BF_UI_SHOTS (see ui_helpers.shot)."""
from __future__ import annotations

import threading
import time
import types
from http.server import ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from .ui_helpers import assert_clean, bad_text, goto, overflow, settle, shot, unnamed_controls, watch

from test_failover_review import SlotFake, make_app, run_book
from test_pictures import Bridge
from test_server import TOKEN


@pytest.fixture(scope="module")
def pb(tmp_path_factory):
    from akowe import forge
    from akowe import providers as prov_mod
    from akowe.server import make_handler
    mp = pytest.MonkeyPatch()
    mp.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic, time=time.time))
    app = make_app(tmp_path_factory.mktemp("pics-ui"), SlotFake())
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", run.get("problem")
    bridge = Bridge()
    forge.save_bridge_settings(app, {"url": bridge.url, "token": "t"})
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    yield SimpleNamespace(app=app, pid=run["project_id"], bridge=bridge,
                          url=f"http://127.0.0.1:{port}/#token={TOKEN}")
    httpd.shutdown()
    httpd.server_close()
    bridge.close()
    mp.undo()


def open_page(make_context, pb, **kw):
    page = watch(make_context(**kw).new_page())
    page.goto(pb.url)
    page.wait_for_selector("#main h1", timeout=15000)
    settle(page)
    goto(page, f"#/p/{pb.pid}/main/pictures")
    page.wait_for_selector("[data-testid=pictures-page] [data-testid=pics-chapter]", timeout=20000)
    return page


def test_pictures_page_illustrate_pick_map_and_batch(make_context, pb):
    page = open_page(make_context, pb)
    assert page.locator("[data-testid=pics-chapter]").count() == 3
    assert "0 of 3 chapter(s) have a picture" in page.inner_text("[data-testid=pics-all-left]")
    # the art style
    page.fill("#pics-style", "ink wash")
    page.click("[data-testid=pics-style-save]")
    page.wait_for_function("() => document.querySelector('#pics-style').value === 'ink wash'", timeout=10000)
    # 👁 the prompt of chapter 1, then 🖼 Illustrate with two candidates
    ch1 = page.locator("[data-testid=pics-chapter]").first
    ch1.locator("[data-testid=pics-prompt]").click()
    ch1.locator(".pics-prompt-text").wait_for(timeout=10000)
    assert ch1.locator(".pics-prompt-text").inner_text().startswith("Art style: ink wash.")
    assert "Character lock: Mara Vell" in ch1.inner_text()
    ch1.locator("[data-testid=pics-count]").select_option("2")
    ch1.locator("[data-testid=pics-illustrate]").click()
    page.wait_for_function("() => document.querySelectorAll('[data-testid=pics-chapter]')[0]"
                           ".querySelectorAll('[data-testid=pics-cand]').length === 2", timeout=20000)
    ch1 = page.locator("[data-testid=pics-chapter]").first
    assert "not in the book" in ch1.locator("[data-testid=pics-pic]").inner_text()
    body = pb.bridge.requests[-1]
    assert body["purpose"] == "illustration" and body["characterLock"] == "Mara Vell"
    # pick the second one, caption it and place it after scene 1
    ch1.locator("[data-testid=pics-cand]").nth(1).click()
    page.wait_for_function("() => { const c = document.querySelectorAll('[data-testid=pics-chapter]')[0]"
                           ".querySelectorAll('[data-testid=pics-cand]'); return c.length === 2 && "
                           "c[1].getAttribute('aria-pressed') === 'true'; }", timeout=10000)
    pic = page.locator("[data-testid=pics-chapter]").first.locator("[data-testid=pics-pic]")
    pic.locator("input[id^=pc-]").fill("Mara climbs to the lamp room")
    pic.locator("input[id^=pa-]").fill("A woman with a lantern on a spiral stair")
    pic.locator("select[id^=pp-]").select_option("after_scene:1")
    pic.locator("[data-testid=pics-save]").click()
    page.wait_for_function("() => document.querySelector('[data-testid=pics-chapter] input[id^=pc-]').value === "
                           "'Mara climbs to the lamp room'", timeout=10000)
    assert "✔ in the book" in page.locator("[data-testid=pics-chapter]").first.inner_text()
    page.wait_for_function("() => document.querySelectorAll('[data-testid=pics-chapter] .pics-img.big img')"
                           ".length >= 1", timeout=10000)
    # the map drawn from the places
    page.click("[data-testid=pics-map-svg]")
    page.wait_for_selector("[data-testid=pics-map] [data-testid=pics-pic] .pics-img.big img", timeout=15000)
    assert "drawn from your places" in page.inner_text("[data-testid=pics-map]")
    # the page says the book must be put together again
    page.locator("[data-testid=pics-stale]").wait_for(timeout=10000)
    settle(page, 400)
    shot(page, "pictures-page")
    assert not bad_text(page) and not unnamed_controls(page)
    assert_clean(page, "pictures page")
    # Illustrate every chapter: a job with progress and Stop; the first one is held until Stop is pressed
    n = len(pb.bridge.requests)
    pb.bridge.arrived[n + 1], pb.bridge.hold[n + 1] = threading.Event(), threading.Event()
    page.click("[data-testid=pics-all]")
    stop = page.locator("[data-testid=pics-all-progress] button", has_text="Stop")
    stop.wait_for(timeout=10000)
    assert pb.bridge.arrived[n + 1].wait(10)
    stop.click()
    pb.bridge.hold[n + 1].set()
    page.wait_for_function("() => document.querySelector('[data-testid=pics-all-left]').textContent"
                           ".includes('2 of 3 chapter(s) have a picture')", timeout=20000)
    assert len(pb.bridge.requests) == n + 1  # stopped after chapter 2: chapter 3 was never asked for
    page.click("[data-testid=pics-all]")
    page.wait_for_function("() => document.querySelector('[data-testid=pics-all-left]').textContent"
                           ".includes('3 of 3 chapter(s) have a picture')", timeout=20000)
    assert page.locator("[data-testid=pics-all]").is_disabled()
    assert_clean(page, "batch")


def test_pictures_page_fits_a_phone(make_context, pb):
    page = open_page(make_context, pb, width=390, height=844)
    settle(page, 400)
    assert overflow(page) <= 1
    shot(page, "pictures-page-phone")
    assert_clean(page, "phone")
