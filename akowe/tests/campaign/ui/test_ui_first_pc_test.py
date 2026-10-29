"""First real PC test (2026-10-28) in the browser: 💾 Save shows a confirmation that stays on screen, the book's page
has a way to the 🔎 Timeline card (at the bottom of 📘 Make my book), and the book report shows no doubled quote marks
and no "The editor did not read these chapter versions" for a book the editor read."""
from __future__ import annotations

from .test_ui_followthrough import autobook
from .ui_helpers import assert_clean, open_app, settle, shot


def test_save_confirmation_timeline_link_and_report(make_context, ai_server):
    pid = autobook(ai_server)
    page = open_app(make_context(), ai_server, f"#/p/{pid}/main")
    # the book's page -> 🔎 Timeline, trade facts and repeats: opens Make my book and scrolls down to the card
    page.locator("[data-testid=ov-timeline-link]").click()
    card = page.locator("[data-testid=book-facts]")
    card.wait_for(timeout=20000)
    settle(page, 400)
    assert page.evaluate("""() => { const r = document.querySelector('[data-testid=book-facts]').getBoundingClientRect();
                                    return r.top < window.innerHeight && r.bottom > 0; }"""), "the Timeline card is not in view"
    # 💾 Save -> a confirmation next to the button that does not vanish like the toast
    btn = page.locator("[data-testid=book-save-btn]")
    btn.scroll_into_view_if_needed()
    btn.click()
    done = page.locator("[data-testid=save-done]").first
    done.wait_for(timeout=30000)
    page.wait_for_function("() => /✔ Saved/.test(document.querySelector('[data-testid=save-done]').textContent)",
                           timeout=30000)
    page.wait_for_timeout(7000)  # longer than the toast
    assert "✔ Saved" in done.inner_text() and "just now" in done.inner_text()
    shot(page, "pc_test_save_confirmation")
    assert_clean(page, "make my book after save")
    # the report: the editor read the chapters, no ""doubled"" quote marks
    page.goto(f"{ai_server.base}#/p/{pid}/main/report")
    page.locator("[data-testid=rp-editor]").wait_for(timeout=20000)
    body = page.locator("#main").inner_text()
    assert '""' not in body and "The editor did not read these chapter versions" not in body
    assert_clean(page, "report")
