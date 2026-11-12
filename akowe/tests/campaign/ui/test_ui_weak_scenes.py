"""🎯 The weakest scenes in the browser: the Make-a-book "Improve until better" switch rewrites the 3 weakest scenes
by default (nothing sent), "Whole chapters" sends improve_mode "chapters", 2 rounds sends improve_rounds 2."""
from __future__ import annotations

from .test_ui_chapter_one import _start_body
from .ui_helpers import assert_clean, open_app, open_make_book


def test_make_a_book_improve_switch_picks_the_weakest_scenes_by_default(make_context, ai_server):
    page = open_app(make_context(), ai_server)
    open_make_book(page)
    dlg = page.locator("#mab-dialog")
    mode = dlg.locator("[data-testid=mb-improve-mode]")
    mode.wait_for(timeout=10000)
    assert mode.input_value() == "scenes"
    assert dlg.locator("[data-testid=mb-improve-rounds]").input_value() == "1"
    assert "3 weakest scenes" in dlg.locator("#mb-improve-hint").inner_text()
    body = _start_body(page, dlg)
    assert "improve_mode" not in body and "improve_rounds" not in body  # the default: nothing sent
    dlg.locator("[data-testid=mb-improve-rounds]").select_option("2")
    body = _start_body(page, dlg)
    assert body.get("improve_rounds") == 2 and "improve_mode" not in body
    mode.select_option("chapters")
    body = _start_body(page, dlg)
    assert body.get("improve_mode") == "chapters" and body.get("improve_rounds") == 2
    assert_clean(page, "make-a-book weakest scenes")
