"""🎨 Interior design on Book home → Book format: the 8 designs (one per Book Bible look + Plain classic) with the
genre's design marked, the page size and body font pickers, a print preview of a chapter-opener spread and a normal
spread drawn from the real page layout (the note says which kind of picture it is), and saving the choice into the
book profile. No browser problems, no horizontal overflow on a phone. Screenshots go to $BF_UI_SHOTS."""
from __future__ import annotations

import threading
from http.server import ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from .ui_helpers import assert_clean, bad_text, goto, overflow, settle, shot, unnamed_controls, watch

from test_failover_review import SlotFake, make_app
from test_server import TOKEN


@pytest.fixture
def bk(tmp_path):
    from akowe.book_path import save_profile
    from akowe.server import make_handler
    app = make_app(tmp_path, SlotFake(), slots=("AI-1",))
    pid = app.engine.bootstrap_project("author", "Interior UI book")
    save_profile(app.store, pid, {"title": "The Salt Road", "author": "Mara Vell", "genre": "Fantasy",
                                  "idea": "A courier crosses a salt desert to deliver a key nobody may open."})
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    yield SimpleNamespace(app=app, pid=pid, url=f"http://127.0.0.1:{port}/#token={TOKEN}")
    httpd.shutdown()
    httpd.server_close()


def open_format(make_context, bk, **kw):
    page = watch(make_context(**kw).new_page())
    page.goto(bk.url)
    page.wait_for_selector("#main h1", timeout=15000)
    settle(page)
    goto(page, f"#/p/{bk.pid}/main/book")
    page.wait_for_selector("[data-testid=interior-design] .interior-theme", timeout=15000)
    page.wait_for_selector("[data-testid=interior-preview] .interior-spread svg, "
                           "[data-testid=interior-preview] .interior-spread img", timeout=20000)
    return page


def saved(page):
    """The saved choice is shown again (Book home redraws itself after a save, so the box can be rebuilt)."""
    page.wait_for_function("() => { const b = document.querySelector('[data-testid=interior-save]');"
                           " return b && /This is your design/.test(b.textContent); }", timeout=15000)


def test_interior_theme_picker_preview_and_save(make_context, bk):
    from akowe.book_path import get_profile
    page = open_format(make_context, bk)
    themes = page.locator("[data-testid=interior-design] .interior-theme")
    assert themes.count() == 8
    # the genre (Fantasy) picks the Fantasy design by default, and it is the checked one
    assert page.get_attribute(".interior-theme[data-theme=fantasy]", "aria-checked") == "true"
    assert "your genre" in page.inner_text(".interior-theme[data-theme=fantasy]")
    # two spreads (chapter opener + normal pages), two pages each; the note says how the preview was made
    assert page.locator("[data-testid=interior-preview] .interior-spread").count() == 2
    assert page.locator("[data-testid=interior-preview] .interior-page").count() == 4
    kind = page.get_attribute("[data-testid=interior-kind]", "data-kind")
    assert kind in ("pdf_image", "layout_svg")
    note = page.inner_text("[data-testid=interior-kind]")
    assert ("real PDF pages" in note) if kind == "pdf_image" else ("real page layout" in note)
    assert page.locator(".interior-page[data-role=opener]").count() == 1
    settle(page, 300)
    shot(page, "interior-fantasy")
    # pick Noir at 5 x 8: the preview is drawn again for that choice, then saved into the book profile
    page.click(".interior-theme[data-theme=noir]")
    page.select_option("[data-testid=interior-trim]", "5x8")
    page.wait_for_function("() => { const s = document.querySelector('[data-testid=interior-status]');"
                           " return s && !s.textContent; }", timeout=20000)
    assert page.get_attribute(".interior-theme[data-theme=noir]", "aria-checked") == "true"
    assert "5 × 8" in page.inner_text("[data-testid=interior-preview]")
    page.click("[data-testid=interior-save]")
    saved(page)
    prof = get_profile(bk.app.store, bk.pid)
    assert prof["interior_theme"] == "noir" and prof["trim_size"] == "5x8"
    settle(page, 300)
    shot(page, "interior-noir-5x8")
    # back to the genre's design: stored as "" (follows the genre)
    page.click("text=↺ Back to my genre’s design")
    page.click("[data-testid=interior-save]")
    saved(page)
    assert get_profile(bk.app.store, bk.pid)["interior_theme"] == ""
    assert not bad_text(page) and not unnamed_controls(page)
    assert_clean(page, "interior design")


def test_interior_preview_on_a_phone(make_context, bk):
    page = open_format(make_context, bk, width=390, height=844)
    settle(page, 300)
    assert not overflow(page)
    shot(page, "interior-phone")
    assert_clean(page, "interior design (phone)")
