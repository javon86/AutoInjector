"""🎨 B3 cover designer in the browser: the "🎨 Cover" page shows a live preview (ebook front and print wrap), the
template picker, colours, texts, back-cover blurb, the picture buttons (Stable Diffusion through a fake AutoInjector
bridge, upload), print settings with the spine width, and the downloads; changes are saved by themselves; no browser
problems, no horizontal overflow on a phone. Screenshots go to $BF_UI_SHOTS (see ui_helpers.shot)."""
from __future__ import annotations

import threading
from http.server import ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from .ui_helpers import assert_clean, bad_text, goto, overflow, settle, shot, unnamed_controls, watch

from test_failover_review import SlotFake, make_app
from test_server import TOKEN


@pytest.fixture
def cv(tmp_path):
    from akowe.book_path import save_profile
    from akowe.server import make_handler
    app = make_app(tmp_path, SlotFake(), slots=("AI-1",))
    pid = app.engine.bootstrap_project("author", "Cover UI book")
    save_profile(app.store, pid, {"title": "The Salt Road", "author": "Mara Vell", "genre": "Fantasy",
                                  "idea": "A courier crosses a salt desert to deliver a key nobody may open."})
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    yield SimpleNamespace(app=app, pid=pid, url=f"http://127.0.0.1:{port}/#token={TOKEN}")
    httpd.shutdown()
    httpd.server_close()


def open_page(make_context, cv, **kw):
    page = watch(make_context(**kw).new_page())
    page.goto(cv.url)
    page.wait_for_selector("#main h1", timeout=15000)
    settle(page)
    return page


def preview_ready(page, after: int = 0):
    page.wait_for_function(f"() => {{ const i = document.querySelector('[data-testid=cover-preview-img]');"
                           f" return i && +(i.dataset.ready || 0) > {after} && i.complete && i.naturalWidth > 0; }}",
                           timeout=15000)
    return int(page.get_attribute("[data-testid=cover-preview-img]", "data-ready"))


def saved(page):
    page.wait_for_function("() => document.querySelector('[data-testid=cover-save-state]').textContent === 'Saved'",
                           timeout=10000)


def test_cover_page_designs_saves_and_downloads(make_context, cv):
    from akowe import cover, forge
    from akowe.forge_example import EXAMPLE_DIR
    from test_forge import FakeImageBridge
    b = FakeImageBridge()
    forge.save_bridge_settings(cv.app, {"url": b.url, "token": "t"})
    try:
        page = open_page(make_context, cv)
        goto(page, f"#/p/{cv.pid}/main/cover")
        page.wait_for_selector("[data-testid=cover-page] .cover-tpl", timeout=15000)
        n = preview_ready(page)
        assert page.locator(".cover-tpl").count() >= 6
        assert page.get_attribute(".cover-tpl[data-tpl=gilded]", "aria-pressed") == "true"
        assert page.get_attribute("[data-testid=cover-text-title]", "placeholder") == "The Salt Road"
        # template + texts: the preview changes and the design is saved by itself
        page.click(".cover-tpl[data-tpl=fantasy]")
        page.fill("[data-testid=cover-text-subtitle]", "A desert crossing")
        page.fill("[data-testid=cover-text-series]", "Salt Books - One")
        page.click("[data-testid=cover-blurb-idea]")
        page.fill("[data-testid=cover-bio]", "Mara Vell grew up between dunes.")
        n = preview_ready(page, n)
        saved(page)
        d = cover.get_design(cv.app.store, cv.pid, "main")
        assert d["template"] == "fantasy" and d["texts"]["subtitle"] == "A desert crossing"
        assert cover.resolved_texts(cv.app.store, cv.pid, d)["blurb"].startswith("A courier crosses")
        # a picture from Stable Diffusion (fake bridge), then the author's own upload
        page.select_option("[data-testid=cover-upscale]", "2")
        page.click("[data-testid=cover-art-sd]")
        page.wait_for_selector("[data-testid=cover-art-thumb] img", timeout=15000)
        assert b.requests[-1]["purpose"] == "cover" and b.requests[-1]["upscale"] == 2
        with page.expect_file_chooser() as fc:
            page.click("[data-testid=cover-art-upload]")
        fc.value.set_files(str(EXAMPLE_DIR / "portrait.jpg"))
        page.wait_for_function("() => /your upload/.test(document.querySelector('.cover-art-meta').textContent)",
                               timeout=15000)
        n = preview_ready(page, n)
        # print settings: page count -> spine width
        page.fill("[data-testid=cover-pages]", "320")
        saved(page)
        page.wait_for_function("() => (document.querySelector('[data-testid=cover-spine]') || {}).textContent"
                               " && document.querySelector('[data-testid=cover-spine]').textContent.startsWith('0.800 in')",
                               timeout=10000)
        settle(page, 400)
        shot(page, "cover-designer")
        page.click("[data-testid=cover-tab-print]")
        n = preview_ready(page, n)
        settle(page, 300)
        shot(page, "cover-print-wrap")
        # downloads
        with page.expect_download(timeout=20000) as dl:
            page.click("[data-testid=cover-dl-ebook]")
        assert dl.value.suggested_filename == "The Salt Road - ebook cover.pdf"
        with page.expect_download(timeout=20000) as dl:
            page.click("[data-testid=cover-dl-print]")
        assert dl.value.suggested_filename == "The Salt Road - print cover 6x9 cream 320p.pdf"
        path = dl.value.path()
        from akowe.exporters.pdf import inspect_pdf
        rep = inspect_pdf(open(path, "rb").read())
        assert not rep["errors"] and abs(rep["media_boxes"][0][2] - (12.25 + 0.8) * 72) < 0.01
        # the book files need an export first: a plain problem, not a crash
        page.click("[data-testid=cover-book-epub]")
        page.wait_for_selector("[data-testid=cover-dl-msg] .state, [data-testid=cover-dl-msg] .problem", timeout=10000)
        assert "export" in page.inner_text("[data-testid=cover-dl-msg]").lower()
        assert not bad_text(page) and not unnamed_controls(page)
        # the expected 400 of the book download (no export yet) is not a browser problem
        page.bf_problems[:] = [x for x in page.bf_problems if "/cover/book" not in x and "status of 400" not in x]
        assert_clean(page, "cover page")
    finally:
        b.close()


def test_cover_page_fits_a_phone(make_context, cv):
    page = open_page(make_context, cv, width=390, height=844)
    goto(page, f"#/p/{cv.pid}/main/cover")
    page.wait_for_selector("[data-testid=cover-page] .cover-tpl", timeout=15000)
    preview_ready(page)
    settle(page, 300)
    assert overflow(page) <= 1
    shot(page, "cover-designer-phone")
    assert_clean(page, "phone")
