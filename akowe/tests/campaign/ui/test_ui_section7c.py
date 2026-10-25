"""Section 7c in the browser: 📖 P23 the beta-reader card on the 📊 report page (ask a beta reader, its findings with
quotes, the interest bars) and ✒️ P25 the My writing style page (save and count samples, learn with the AI, switch a
book on) plus the two extras in the ⚡ Make-a-book form."""
from __future__ import annotations

from .test_ui_followthrough import autobook
from .ui_helpers import assert_clean, goto, open_app, shot

SAMPLE = ("I burned the toast again this morning. Of course I did. The kitchen smelled of smoke and of the rain that "
          "had come in under the door; my mother would have said something about it, and I was glad she couldn't. "
          "I didn't open the window. I stood there with the knife in my hand and listened to the kettle, which was "
          "the only thing in the house that still did what it was told. ") * 4


def test_beta_reader_card_and_style_page(make_context, ai_server):
    pid = autobook(ai_server)
    page = open_app(make_context(), ai_server, f"#/p/{pid}/main/report")
    card = page.locator("[data-testid=beta-card]")
    card.wait_for(timeout=20000)
    page.locator("[data-testid=beta-ask]").click()
    page.locator("[data-testid=beta-findings]").wait_for(timeout=30000)
    text = card.inner_text()
    assert "The reader got lost" in text and "Twists the reader saw coming" in text and "read it as a" in text
    assert card.locator(".s7-bar").count() >= 2
    card.locator("[data-testid=beta-reactions] summary").click()
    assert "Chapter 1" in card.locator("[data-testid=beta-reactions]").inner_text()
    shot(page, "p23_beta_reader")
    assert_clean(page, "beta reader card")

    goto(page, "#/style")
    assert page.locator("#main h1").inner_text().startswith("✒️ My writing style")
    page.locator("[data-testid=style-samples] textarea").first.fill(SAMPLE)
    page.locator("[data-testid=style-save]").click()
    page.locator("[data-testid=style-numbers]").wait_for(timeout=15000)
    assert "first person, past tense" in page.locator("[data-testid=style-numbers]").inner_text()
    page.locator("[data-testid=style-learn]").click()
    page.locator("[data-testid=style-ai]").wait_for(timeout=30000)
    box = page.locator(f"[data-testid=style-books] input[data-pid='{pid}']")
    box.check()
    page.wait_for_function("pid => { const b = document.querySelector(`[data-testid=style-books] input[data-pid='${pid}']`);"
                           " return b && b.checked && !b.disabled; }", arg=pid, timeout=15000)
    st = ai_server.api("GET", f"/projects/{pid}/branches/main/style")
    assert st["style"]["on"] is True
    shot(page, "p25_style_page")
    assert_clean(page, "style page")

    page.locator("#mab-btn").click()
    d = page.locator("#mab-dialog")
    d.locator("[data-testid=mb-beta]").wait_for(timeout=15000)
    assert d.locator("[data-testid=mb-style]").is_enabled() and d.locator("[data-testid=mb-style]").is_checked()
    assert not d.locator("[data-testid=mb-beta]").is_checked()
    assert_clean(page, "make-a-book extras")
