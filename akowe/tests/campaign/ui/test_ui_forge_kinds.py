"""🗂 B5 lane C in the browser: the item / place / magic tabs of the Character Forge, an item dossier (hero picture,
turnaround plate, 8 lettered sections, a link chip to the character who holds it, ✔ Approve all), 🔎 Check against
the book (progress, findings with chapter, field and quote; Fix / Fine / Change dossier → a proposal in the dossier),
a new item from the book's own character weapon, and the item page on a phone. Screenshots go to $BF_UI_SHOTS."""
from __future__ import annotations

import threading
from http.server import ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from .ui_helpers import assert_clean, bad_text, goto, overflow, settle, shot, unnamed_controls, watch

from test_failover_review import SlotFake, make_app
from test_server import TOKEN  # noqa: F401

CH1 = "\n\n".join([
    "Moki Vey checked the intake while the pumps hammered below.",
    "Oren Sael gripped the rescue baton and smiled at the crew.",
    "Moki gripped the rescue baton and waited for the double click.",
])
CH2 = "\n\n".join([
    "The rescue baton had been forged in 2170, the quartermaster said, long before the trial.",
    "Moki clipped the rescue baton back on his belt.",
])


@pytest.fixture
def fk(tmp_path):
    from akowe import forge, forge_check, forge_example, forge_kinds
    from akowe.server import make_handler
    from test_forge import make_char
    app = make_app(tmp_path, SlotFake(), slots=("AI-1",))
    pid = app.engine.bootstrap_project("author", "Forge kinds UI book")
    out = forge_example.load(app, "author", pid, "main", {})
    make_char(app, pid, "Oren Sael")
    world = {w["kind"]: w["record_id"] for w in out["world"]}
    forge_kinds.approve(app.store, pid, "main", "item", world["item"], {"all": True})
    forge_kinds.edit(app.store, pid, "main", "item", world["item"], {"sections": {"history": {
        "made_when": {"text": "Made in 2181 on the Eastern service deck."}}}})
    forge.edit(app.store, pid, "main", out["record_id"], {"sections": {"weapons": {
        "backup_weapon": {"text": "Unused."}}}})
    chapters = [{"chapter_id": "ch1", "number": 1, "text": CH1}, {"chapter_id": "ch2", "number": 2, "text": CH2}]
    real = forge_check.book_chapters
    forge_check.book_chapters = lambda _a, _p, _pid, _b: chapters
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    yield SimpleNamespace(app=app, pid=pid, moki=out["record_id"], world=world,
                          url=f"http://127.0.0.1:{port}/#token={TOKEN}")
    forge_check.book_chapters = real
    httpd.shutdown()
    httpd.server_close()


def open_page(make_context, fk, **kw):
    page = watch(make_context(**kw).new_page())
    page.goto(fk.url)
    page.wait_for_selector("#main h1", timeout=15000)
    settle(page)
    return page


def test_item_dossier_links_and_check_against_the_book(make_context, fk):
    page = open_page(make_context, fk)
    goto(page, f"#/p/{fk.pid}/main/forge")
    page.wait_for_selector("[data-testid=forge-tabs]", timeout=15000)
    page.click("[data-testid=forge-tabs] [data-seg=items]")
    page.wait_for_selector("[data-testid=forge-list][data-seg=items] [data-testid=forge-tile]", timeout=15000)
    assert "AR-001" in page.inner_text("[data-testid=forge-tile]") and "READY" in page.inner_text("[data-testid=forge-tile]")
    # the character's weapon is offered as a dossier of its own
    assert page.locator("[data-testid=forge-candidate]").count() == 1
    assert "Telescoping rescue baton" in page.inner_text("[data-testid=forge-candidates]")
    page.click("[data-testid=forge-tile]")
    page.wait_for_selector("[data-testid=forge-page][data-kind=item] .forge-name", timeout=15000)
    settle(page, 400)
    assert page.inner_text(".forge-name").strip().upper() == "RESCUE BATON"
    assert "ITEM FORGE" in page.inner_text(".forge-tagline")
    page.wait_for_function("() => document.querySelectorAll('[data-testid=forge-views] img').length === 4", timeout=15000)
    page.wait_for_selector("[data-testid=forge-portrait] img", timeout=15000)
    assert "TURNAROUND REFERENCE" in page.inner_text(".forge-plate h2")
    assert page.locator(".forge-section").count() == 8
    assert "01 / Item record" in page.inner_text(".forge-section >> nth=0")
    assert page.locator("[data-key=supplied_canon] .forge-badge.lock").count() == 1
    # cross-links: the holder is a clickable chip, and the dossier says who names it
    chip = page.locator("[data-key=current_holder] [data-testid=forge-link]")
    assert chip.count() == 1 and "CH-001" in chip.inner_text()
    assert "CH-001" in page.inner_text("[data-testid=forge-links]")
    # 🔎 the check: rules only (no AI in this book)
    assert page.inner_text("[data-testid=forge-check]").count("Not checked yet") == 1
    page.uncheck("[data-testid=check-ai]")
    page.click("[data-testid=check-run]")
    page.wait_for_selector("[data-testid=finding]", timeout=20000)
    settle(page, 300)
    texts = page.locator("[data-testid=finding]").all_inner_texts()
    holder = next(t for t in texts if "Oren Sael gripped" in t)
    assert "CHAPTER 1" in holder.upper() and "Who must never have it" in holder and "rule" in holder
    assert any("forged in 2170" in t and "When and where it was made" in t for t in texts)
    shot(page, "forge-item-check")
    # Fix the book
    first = page.locator("[data-testid=finding]", has_text="Oren Sael gripped")
    first.locator("[data-testid=verdict-fix]").click()
    page.wait_for_selector("[data-testid=finding][data-verdict=fix]", timeout=10000)
    assert "1 to fix" in page.inner_text("[data-testid=check-summary]")
    # Change dossier: a proposal, shown on the field card with the old text
    year = page.locator("[data-testid=finding]", has_text="forged in 2170")
    year.locator("[data-testid=verdict-change_dossier]").click()
    page.wait_for_selector("dialog[open] [data-testid=change-text]")
    assert "2170" in page.input_value("dialog[open] [data-testid=change-text]")
    page.click("dialog[open] button.primary")
    page.wait_for_selector("[data-testid=finding][data-verdict=change_dossier]", timeout=10000)
    card = page.locator("[data-key=made_when]")
    page.wait_for_selector("[data-key=made_when][data-status=proposed]", timeout=10000)
    assert "CHANGE PROPOSED" in card.inner_text().upper() and "Was:" in card.inner_text() and "2181" in card.inner_text()
    assert page.inner_text("[data-testid=forge-readiness]") == "DRAFT"
    card.scroll_into_view_if_needed()
    shot(page, "forge-item-change-dossier")
    page.click("[data-key=made_when] [data-testid=approve-one]")
    page.wait_for_selector("[data-key=made_when][data-status=approved]", timeout=10000)
    assert "2170" in page.inner_text("[data-key=made_when]")
    assert not bad_text(page) and not unnamed_controls(page)
    assert_clean(page, "item dossier and check")
    # the chip opens the character's dossier, which links back to the item
    page.click("[data-key=current_holder] [data-testid=forge-link]")
    page.wait_for_selector("[data-testid=forge-page][data-kind=character] .forge-name", timeout=15000)
    page.wait_for_selector("[data-key=primary_weapon] [data-testid=forge-link][data-code=AR-001]", timeout=10000)
    assert page.locator(".forge-section").count() == 14
    assert_clean(page, "character links")


def test_new_item_from_the_book_and_the_place_and_magic_pages(make_context, fk):
    page = open_page(make_context, fk)
    goto(page, f"#/p/{fk.pid}/main/forge/items")
    page.wait_for_selector("[data-testid=forge-create-from]", timeout=15000)
    page.click("[data-testid=forge-create-from]")
    page.wait_for_selector("[data-testid=forge-page][data-kind=item] .forge-name", timeout=15000)
    assert page.inner_text(".forge-name").strip().upper() == "TELESCOPING RESCUE BATON"
    assert "AR-002" in page.inner_text("[data-testid=forge-code]")
    assert "Moki Vey / CH-001" in page.inner_text("[data-key=current_holder]")
    # a brand-new place by name
    goto(page, f"#/p/{fk.pid}/main/forge/places")
    page.wait_for_selector("[data-testid=forge-new-name]", timeout=15000)
    page.fill("[data-testid=forge-new-name]", "The Intake Halls")
    page.click("[data-testid=forge-new]")
    page.wait_for_selector("[data-testid=forge-page][data-kind=place] .forge-name", timeout=15000)
    assert "PL-002" in page.inner_text("[data-testid=forge-code]") and page.locator(".forge-section").count() == 9
    assert "MOOD VIEWS" in page.inner_text(".forge-plate h2")
    # the example magic system with its sigil
    goto(page, f"#/p/{fk.pid}/main/forge/magic/{fk.world['magic']}")
    page.wait_for_selector("[data-testid=forge-portrait] img", timeout=15000)
    assert page.locator(".forge-section").count() == 11 and "IN USE" in page.inner_text(".forge-plate h2")
    settle(page, 300)
    shot(page, "forge-magic")
    assert not unnamed_controls(page)
    assert_clean(page, "new item, place and magic pages")


def test_item_page_fits_a_phone(make_context, fk):
    page = open_page(make_context, fk, width=390, height=844)
    goto(page, f"#/p/{fk.pid}/main/forge/items/{fk.world['item']}")
    page.wait_for_function("() => document.querySelectorAll('[data-testid=forge-views] img').length === 4", timeout=15000)
    settle(page, 300)
    assert overflow(page) <= 1
    shot(page, "forge-item-phone")
    assert_clean(page, "phone")
