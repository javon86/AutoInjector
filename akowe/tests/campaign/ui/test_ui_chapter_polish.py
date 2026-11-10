"""📏 Chapter polish in the browser: the Make-a-book switch "Polish a chapter when it reads too simply or repeats
earlier chapters" (on by default; only "off" is sent)."""
from __future__ import annotations

from .test_ui_chapter_one import _start_body
from .ui_helpers import assert_clean, open_app, open_make_book


def test_make_a_book_screen_has_the_chapter_polish_switch(make_context, ai_server):
    page = open_app(make_context(), ai_server)
    open_make_book(page)
    dlg = page.locator("#mab-dialog")
    box = dlg.locator("[data-testid=mb-chapter-polish]")
    box.wait_for(timeout=10000)
    assert box.is_checked()
    assert dlg.get_by_label("Polish a chapter when it reads too simply or repeats earlier chapters").count() == 1
    hint = dlg.locator("#mb-chapter-polish-hint").inner_text()
    assert "never the story, the facts, the names, the numbers or the dialogue" in hint
    body = _start_body(page, dlg)
    assert "chapter_polish" not in body  # on: nothing sent (the default)
    box.uncheck()
    body = _start_body(page, dlg)
    assert body.get("chapter_polish") is False
    assert_clean(page, "make-a-book chapter polish")
