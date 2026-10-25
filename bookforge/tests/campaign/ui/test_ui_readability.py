"""📖 P24 in the browser: a made book's 📊 report page shows the readability and pacing card (reading level vs the
audience, sentence length, dialogue, scenes, pace) with its per-chapter table, and nothing leaks or overflows."""
from __future__ import annotations

from .test_ui_followthrough import autobook
from .ui_helpers import assert_clean, open_app, shot


def test_report_page_shows_readability(make_context, ai_server):
    pid = autobook(ai_server)
    page = open_app(make_context(), ai_server, f"#/p/{pid}/main/report")
    card = page.locator("[data-testid=rp-readability]")
    card.wait_for(timeout=20000)
    text = card.inner_text()
    assert "Reading level about grade" in text and "words per sentence" in text and "pace:" in text
    assert "usual for" in text and "readers: grade" in text
    page.locator("[data-testid=rp-readability] summary").click()
    assert card.locator("tbody tr").count() >= 2
    shot(page, "p24_report_readability")
    assert_clean(page, "report readability")
