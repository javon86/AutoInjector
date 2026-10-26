"""🗂 B5 Character Forge in the browser: the empty list offers the Moki Vey example; the dossier page shows the hero
portrait, gold name, ten-view plate and lettered section cards; the letter filter; ✔ Approve / ✎ Edit of a proposal;
✔ Approve all → READY; ⬇ Dossier PDF downloads; the "🗂 Character Forge" link on the character's card; no browser
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
def fg(tmp_path):
    from akowe.server import make_handler
    app = make_app(tmp_path, SlotFake(), slots=("AI-1",))
    pid = app.engine.bootstrap_project("author", "Forge UI book")
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    yield SimpleNamespace(app=app, pid=pid, url=f"http://127.0.0.1:{port}/#token={TOKEN}")
    httpd.shutdown()
    httpd.server_close()


def open_page(make_context, fg, **kw):
    page = watch(make_context(**kw).new_page())
    page.goto(fg.url)
    page.wait_for_selector("#main h1", timeout=15000)
    settle(page)
    return page


def test_forge_example_dossier_page(make_context, fg):
    page = open_page(make_context, fg)
    goto(page, f"#/p/{fg.pid}/main/forge")
    assert page.locator("[data-testid=forge-list] .forge-empty").is_visible()
    page.click("[data-testid=forge-example]")
    page.wait_for_selector("[data-testid=forge-page] .forge-name", timeout=15000)
    settle(page, 600)
    assert page.inner_text(".forge-name").strip().upper() == "MOKI VEY"
    assert "THE MAN WHO HOLDS THE LINE" in page.inner_text(".forge-tagline")
    assert page.inner_text("[data-testid=forge-readiness]") == "DRAFT"
    page.wait_for_function("() => document.querySelectorAll('[data-testid=forge-views] img').length === 10", timeout=15000)
    page.wait_for_selector("[data-testid=forge-portrait] img", timeout=15000)
    assert page.locator(".forge-section").count() == 14
    assert "01 / Character record" in page.inner_text(".forge-section >> nth=0")
    assert page.locator("[data-testid=forge-card][data-status=proposed]").count() > 100
    assert page.locator("[data-key=supplied_canon] .forge-badge.lock").count() == 1
    shot(page, "forge-dossier")
    # the letter filter: only cards with an F
    page.click(".forge-chip[data-letter=F]")
    tags = page.locator("[data-testid=forge-card] .forge-tags").all_inner_texts()
    assert tags and all("F" in t for t in tags)
    page.click(".forge-chip.all")
    # ✔ Approve one proposal, ✎ edit another
    page.click("[data-key=wants] [data-testid=approve-one]")
    page.wait_for_selector("[data-key=wants][data-status=approved]", timeout=10000)
    page.locator("[data-key=fear]").hover()
    page.click("[data-key=fear] [data-testid=edit-one]")
    page.fill("#fe-fear", "Being held still while a machine fails.")
    page.click("[data-testid=save-one]")
    page.wait_for_selector("[data-key=fear][data-status=approved]", timeout=10000)
    assert "Being held still" in page.inner_text("[data-key=fear]")
    # ✔ Approve all → READY
    page.click("[data-testid=forge-approve-all]")
    page.click("dialog[open] button.primary")
    page.wait_for_function("() => document.querySelector('[data-testid=forge-readiness]').textContent === 'READY'",
                           timeout=10000)
    assert "REV 4" in page.inner_text("[data-testid=forge-code]")
    # ⬇ Dossier PDF
    with page.expect_download(timeout=20000) as dl:
        page.click("[data-testid=forge-pdf]")
    assert dl.value.suggested_filename.endswith("Character Forge dossier.pdf")
    assert not bad_text(page) and not unnamed_controls(page)
    assert_clean(page, "dossier page")
    # the list shows the tile; the character card links here
    goto(page, f"#/p/{fg.pid}/main/forge")
    page.wait_for_selector("[data-testid=forge-tile]")
    rid = page.get_attribute("[data-testid=forge-tile]", "data-rid")
    assert "CH-001" in page.inner_text("[data-testid=forge-tile]") and "READY" in page.inner_text("[data-testid=forge-tile]")
    goto(page, f"#/p/{fg.pid}/main/rec/{rid}")
    page.wait_for_selector("[data-testid=open-forge]", timeout=15000)
    page.click("[data-testid=open-forge]")
    page.wait_for_selector("[data-testid=forge-page] .forge-name", timeout=15000)
    assert_clean(page, "list and character card")


def test_forge_page_fits_a_phone(make_context, fg):
    from akowe import forge_example
    out = forge_example.load(fg.app, "author", fg.pid, "main", {})
    page = open_page(make_context, fg, width=390, height=844)
    goto(page, f"#/p/{fg.pid}/main/forge/{out['record_id']}")
    page.wait_for_function("() => document.querySelectorAll('[data-testid=forge-views] img').length === 10", timeout=15000)
    settle(page, 300)
    assert overflow(page) <= 1
    shot(page, "forge-dossier-phone")
    assert_clean(page, "phone")
