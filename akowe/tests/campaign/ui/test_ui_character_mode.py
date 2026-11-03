"""🧑 ⚖ 🗺 "How the story treats the characters" in the browser: shown when starting a book (⚡ Make a book) and in the
book profile, in plain words with an ⓘ, default Balanced; a change is saved in the profile."""
from __future__ import annotations

from .ui_helpers import assert_clean, open_app, open_make_book, settle, shot
from .test_ui_followthrough import autobook


def test_character_mode_on_make_a_book_and_in_the_profile(make_context, ai_server):
    ctx = make_context()
    page = open_app(ctx, ai_server)
    open_make_book(page)
    dlg = page.locator("#mab-dialog")
    sel = dlg.locator("[data-testid=mb-character-mode]")
    sel.wait_for(timeout=10000)
    opts = sel.locator("option").all_inner_texts()
    assert len(opts) == 3 and any("Balanced (default)" in o for o in opts)
    assert sel.input_value() == "balanced"
    sel.select_option("character_led")
    assert "characters come first" in dlg.inner_text().lower()
    shot(page, "character-mode-make-a-book")
    page.keyboard.press("Escape")

    pid = autobook(ai_server)
    page = open_app(ctx, ai_server, f"#/p/{pid}/main/book")
    page.get_by_role("button", name="📝 Book profile").click()
    dlg = page.locator("dialog[open]")
    sel = dlg.locator("select[data-choice=characters]")
    assert sel.input_value() == "balanced"
    sel.select_option("plot_led")
    dlg.get_by_role("button", name="Save profile").click()
    page.locator("#toast:not([hidden])").wait_for(timeout=5000)
    assert ai_server.api("GET", f"/projects/{pid}/profile")["choices"]["characters"] == "plot_led"
    page.reload()
    page.wait_for_selector("#main .book-top", timeout=15000)
    settle(page, 300)
    shot(page, "character-mode-profile")
    if page.locator("[data-testid=profile-character-mode]").count():
        assert "Plot-led" in page.inner_text("[data-testid=profile-character-mode]")
    assert_clean(page, "character mode")
