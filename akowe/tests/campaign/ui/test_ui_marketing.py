"""📣 #17 Mockups & ads in the browser: the page is reached from 🖼 Pictures & cover and from 🎨 Cover; the gallery
shows every mockup, ad and clip with its live drawing; 🖼 Make the pictures runs as a job through a fake AutoInjector
(the made PNG / JPG then shows, ✔ Made); changing the hook marks the ads ⚠ Out of date (with why, and a notice on
top) and making them again clears it; 🎬 Make the teaser clips makes the two clips (a player each); ⬇ Download all
gives a zip; AutoInjector missing is said in plain words; no browser problems, no unnamed controls, no sideways
scrolling on a phone. Screenshots go to $BF_UI_SHOTS (see ui_helpers.shot)."""
from __future__ import annotations

import threading
from http.server import ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from .ui_helpers import assert_clean, bad_text, goto, overflow, settle, shot, unnamed_controls, watch

from test_failover_review import SlotFake, make_app
from test_server import TOKEN


@pytest.fixture
def mk(tmp_path, monkeypatch):
    from akowe import cover, forge, marketing
    from akowe.book_path import save_profile
    from akowe.server import make_handler
    from test_marketing import FakeAutoInjector, art_png
    monkeypatch.setattr(marketing, "POLL_S", 0.02)
    monkeypatch.setattr(marketing, "PICTURES_ROOT", str(tmp_path / "frames"))
    app = make_app(tmp_path, SlotFake(), slots=("AI-1",))
    pid = app.engine.bootstrap_project("author", "Mockup UI book")
    save_profile(app.store, pid, {"title": "The Salt Road", "author": "Mara Vell", "genre": "Fantasy",
                                  "idea": "A courier crosses a salt desert to deliver a key nobody may open."})
    cover.save(app, pid, "main", {"template": "fantasy", "texts": {"tagline": "Every light hides a debt."},
                                  "print": {"page_count": 300}})
    app.cover.upload("author", pid, "main", art_png())
    out = tmp_path / "videos"
    out.mkdir()
    fake = FakeAutoInjector(out)
    forge.save_bridge_settings(app, {"url": fake.url, "token": "t"})
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    yield SimpleNamespace(app=app, pid=pid, fake=fake, url=f"http://127.0.0.1:{port}/#token={TOKEN}")
    httpd.shutdown()
    httpd.server_close()
    fake.close()


def open_page(make_context, mk, **kw):
    page = watch(make_context(**kw).new_page())
    page.goto(mk.url)
    page.wait_for_selector("#main h1", timeout=15000)
    settle(page)
    goto(page, f"#/p/{mk.pid}/main/marketing")
    page.wait_for_selector("[data-testid=marketing-page] [data-testid=mk-piece]", timeout=20000)
    return page


def states(page, group=None):
    sel = "[data-testid=mk-piece]" + (f"[data-group={group}]" if group else "")
    return page.eval_on_selector_all(sel, "els => Object.fromEntries(els.map(e => [e.dataset.id, "
                                          "e.querySelector('[data-testid=mk-status]').dataset.state]))")


def wait_job(page):
    page.wait_for_function("() => !document.querySelector('[data-testid=mk-stop]')", timeout=60000)
    settle(page, 300)


def test_marketing_page_make_stale_again_clips_zip(make_context, mk):
    page = open_page(make_context, mk)
    assert page.locator("#sidenav .side-link[aria-current=page]", has_text="Pictures & cover").count() == 1
    st = states(page)
    assert len(st) == 12 + 5 + 2 and set(st.values()) == {"none"}
    assert page.input_value("[data-testid=mk-hook]") == ""            # empty: the automatic one is used …
    assert "Every light hides a debt." in page.inner_text("[data-testid=mk-hook-source]")  # … and named
    assert page.input_value("[data-testid=mk-cta]") == "Available now"
    # the live drawings load
    page.wait_for_function("() => [...document.querySelectorAll('[data-testid=mk-img]')].every(i => "
                           "i.src.startsWith('blob:'))", timeout=30000)
    page.wait_for_function("() => { const i = document.querySelector('[data-testid=mk-piece][data-id=paperback] "
                           "[data-testid=mk-img]'); return i.complete && i.naturalWidth > 0; }", timeout=30000)
    assert not bad_text(page) and not unnamed_controls(page)
    shot(page, "marketing-page")
    # 🖼 Make the pictures: a job through AutoInjector, then ✔ Made with the made picture
    page.click("[data-testid=mk-make]")
    wait_job(page)
    page.wait_for_function("() => [...document.querySelectorAll('[data-testid=mk-piece][data-group=ad] "
                           "[data-testid=mk-status]')].every(s => s.dataset.state === 'made')", timeout=20000)
    assert set(states(page, "mockup").values()) == {"made"}
    page.wait_for_function("() => document.querySelector('[data-testid=mk-piece][data-id=ad-square] [data-testid=mk-img]')"
                           ".dataset.src === 'made'", timeout=10000)
    assert page.locator("[data-testid=mk-stale]").count() == 0
    # the hook changes: the ads with words are out of date, with why
    page.fill("[data-testid=mk-hook]", "One key. One desert. One night.")
    page.click("[data-testid=mk-save-words]")
    page.wait_for_selector("[data-testid=mk-stale]", timeout=10000)
    st = states(page, "ad")
    assert st == {"ad-square": "stale", "ad-story": "stale", "ad-landscape": "stale", "ad-amazon": "made",
                  "ad-bookbub": "stale"}
    assert "words" in page.inner_text("[data-testid=mk-piece][data-id=ad-square] [data-testid=mk-why]")
    assert "4 file(s) are out of date" in page.inner_text("[data-testid=mk-stale]")
    shot(page, "marketing-stale")
    # 🔁 Make again (one piece), then all
    page.click("[data-testid=mk-piece][data-id=ad-square] [data-testid=mk-make-one]")
    wait_job(page)
    page.wait_for_function("() => document.querySelector('[data-testid=mk-piece][data-id=ad-square] "
                           "[data-testid=mk-status]').dataset.state === 'made'", timeout=10000)
    page.click("[data-testid=mk-make]")
    wait_job(page)
    page.wait_for_function("() => !document.querySelector('[data-testid=mk-stale]')", timeout=10000)
    # 🎬 the teaser clips
    page.click("[data-testid=mk-clips]")
    wait_job(page)
    page.wait_for_function("() => document.querySelectorAll('[data-testid=mk-video]').length === 2", timeout=20000)
    assert set(states(page, "clip").values()) == {"made"}
    assert page.locator("[data-testid=mk-piece][data-group=clip] [data-testid=mk-dl-mp4]").count() == 2
    # ⬇ Download all (zip)
    with page.expect_download() as dl:
        page.click("[data-testid=mk-zip]")
    assert dl.value.suggested_filename.endswith("mockups and ads.zip")
    with page.expect_download() as dl:
        page.click("[data-testid=mk-piece][data-id=paperback] [data-testid=mk-dl]")
    assert dl.value.suggested_filename.endswith(".png")
    assert_clean(page, "marketing page")


def test_marketing_is_linked_from_the_cover_and_the_art_page(make_context, mk):
    page = open_page(make_context, mk)
    goto(page, f"#/p/{mk.pid}/main/art")
    page.wait_for_selector("[data-testid=land-marketing]", timeout=10000)
    page.click("[data-testid=land-marketing]")
    page.wait_for_selector("[data-testid=marketing-page]", timeout=10000)
    goto(page, f"#/p/{mk.pid}/main/cover")
    page.wait_for_selector("[data-testid=cover-marketing-link]", timeout=10000)
    page.click("[data-testid=cover-marketing-link]")
    page.wait_for_selector("[data-testid=marketing-page]", timeout=10000)
    assert_clean(page, "links")


def test_autoinjector_missing_in_plain_words(make_context, mk):
    from akowe import forge
    forge.save_bridge_settings(mk.app, {"url": "http://127.0.0.1:9", "token": "t"})
    page = open_page(make_context, mk)
    page.click("[data-testid=mk-make]")
    page.wait_for_selector("[data-testid=mk-progress] .state.problem", timeout=30000)
    txt = page.inner_text("[data-testid=mk-progress]")
    assert "AutoInjector is not connected" in txt and "SVG" in txt
    assert not bad_text(page)


def test_marketing_page_fits_a_phone(make_context, mk):
    page = open_page(make_context, mk, width=390, height=844)
    settle(page, 400)
    assert overflow(page) <= 1
    shot(page, "marketing-phone")
    assert_clean(page, "phone")
