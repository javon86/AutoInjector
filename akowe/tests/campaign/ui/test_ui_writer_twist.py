"""🏆 🤫 ✒️ In the browser: the "Who writes best" and "Hide the twist better" cards in Settings (plain words, the
switches save), and the ✒️ writing-style tip on the Make-a-book plan (a link to the page; "Don't show again")."""
from __future__ import annotations

import pytest

from .test_ui_checker_record import SIZES, InProcess
from .ui_helpers import assert_clean, open_app, open_make_book, overflow


@pytest.mark.parametrize("size", SIZES, ids=["desktop", "phone"])
def test_who_writes_best_and_twist_cards(make_context, tmp_path, size):
    from akowe import twist_guard, writer_record as wr
    srv = InProcess(tmp_path)
    try:
        for i in range(3):
            wr.note(srv.app.store, "claude", 8.1, f"c{i}:1")
            wr.note(srv.app.store, "chatgpt", 7.4, f"g{i}:1")
        page = srv.open(make_context(*size), "#/settings")
        card = page.locator("[data-testid=wr-record]")
        card.locator("[data-testid=wr-record-row]").first.wait_for(timeout=10000)
        rows = card.locator("[data-testid=wr-record-row]").all_inner_texts()
        assert any(r.startswith("Claude: its chapters score 8.1/10 on average (3 chapters)") for r in rows)
        order = card.locator("[data-testid=wr-record-order]").inner_text()
        assert order.startswith("Claude writes most chapters: its chapters score 8.1 vs ChatGPT 7.4")
        box = card.locator("[data-testid=wr-pick-on]")
        assert box.is_checked()
        box.uncheck()
        page.wait_for_function("() => /Switched off/.test(document.querySelector('[data-testid=wr-record-order]')"
                               ".textContent)", timeout=10000)
        assert wr.settings(srv.app.store) == {"enabled": False}
        tg = page.locator("[data-testid=tg-card]")
        tg.locator("[data-testid=tg-on]").wait_for(timeout=10000)
        assert tg.locator("[data-testid=tg-on]").is_checked() and "red herring" in tg.inner_text()
        tg.locator("[data-testid=tg-on]").uncheck()
        for _ in range(50):
            if twist_guard.settings(srv.app.store) == {"enabled": False}:
                break
            page.wait_for_timeout(100)
        assert twist_guard.settings(srv.app.store) == {"enabled": False}
        assert overflow(page) <= 1
        assert_clean(page, "writer and twist cards")
    finally:
        srv.close()


def test_style_tip_on_the_make_a_book_plan(make_context, ai_server):
    page = open_app(make_context(), ai_server)
    open_make_book(page)
    dlg = page.locator("#mab-dialog")
    tip = dlg.locator("[data-testid=mb-style-tip]")
    tip.wait_for(timeout=15000)
    assert tip.inner_text().startswith("💡 Tip: paste a few paragraphs of your own writing into ✒️ My writing style "
                                       "so every AI writes in your voice.")
    assert tip.locator("[data-testid=mb-style-tip-link]").get_attribute("href") == "#/style"
    tip.locator("[data-testid=mb-style-tip-hide]").click()
    page.wait_for_function("() => !document.querySelector('[data-testid=mb-style-tip]')", timeout=10000)
    assert_clean(page, "style tip")
