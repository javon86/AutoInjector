"""💡 By Start in ⚡ Make a book: "pick the strongest model in each AI window" — shown until the author hides it
(remembered in this browser)."""
from __future__ import annotations

from .ui_helpers import assert_clean, open_app, open_make_book


def test_model_tip_shows_and_can_be_hidden(make_context, ai_server):
    ctx = make_context()
    page = open_app(ctx, ai_server)
    open_make_book(page)
    dlg = page.locator("#mab-dialog")
    tip = dlg.locator("[data-testid=mb-model-tip]")
    tip.wait_for(timeout=10000)
    text = tip.inner_text()
    assert "pick the strongest model in each AI window (ChatGPT, Claude, Gemini) before you start" in text
    assert "thinking" in text
    dlg.locator("[data-testid=mb-model-tip-hide]").click()
    assert dlg.locator("[data-testid=mb-model-tip]").count() == 0
    # remembered: the next time the window opens it stays hidden
    page.reload()
    page.wait_for_load_state()
    open_make_book(page)
    page.locator("#mab-dialog [data-testid=mb-start]").wait_for(timeout=10000)
    assert page.locator("#mab-dialog [data-testid=mb-model-tip]").count() == 0
    assert_clean(page)
