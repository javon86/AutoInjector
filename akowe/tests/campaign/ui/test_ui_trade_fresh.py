"""🔧 / 🔁 in the browser: the Make-a-book switches "Get the main characters' trade right" (trade_card) and "Keep it
fresh" (fresh_names) under 🩺 Plan check — both on by default; only a change is sent."""
from __future__ import annotations

from .test_ui_chapter_one import _start_body
from .ui_helpers import assert_clean, open_app, open_make_book


def test_make_a_book_screen_has_the_trade_card_and_keep_fresh_switches(make_context, ai_server):
    page = open_app(make_context(), ai_server)
    open_make_book(page)
    dlg = page.locator("#mab-dialog")
    trade = dlg.locator("[data-testid=mb-trade-card]")
    fresh = dlg.locator("[data-testid=mb-fresh-names]")
    trade.wait_for(timeout=10000)
    assert trade.is_checked() and fresh.is_checked()
    assert dlg.get_by_label("🔧 Get the main characters' trade right").count() == 1
    assert dlg.get_by_label("🔁 Keep it fresh: don't reuse names, title words and settings from my recent books").count() == 1
    assert "Kept fresh: avoided Odile, Salt, coastal town" in dlg.locator("#mb-fresh-names-hint").inner_text()
    body = _start_body(page, dlg)
    assert not {"trade_card", "fresh_names"} & set(body)  # defaults: nothing sent
    trade.uncheck()
    fresh.uncheck()
    body = _start_body(page, dlg)
    assert body.get("trade_card") is False and body.get("fresh_names") is False
    assert_clean(page, "make-a-book trade card and keep fresh")
