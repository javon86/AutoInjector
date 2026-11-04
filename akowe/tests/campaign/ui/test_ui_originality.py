"""✨ #20 in the browser: the Originality check card on the 📊 report page — the one-line summary in the report, the
per-chapter scores, the findings with quotes and reasons, the "count dialogue too" switch and the optional AI pass
(ratings with a quote Akọwe could not find marked)."""
from __future__ import annotations

from autobook_fake import CHAPTER_TEXT

from .test_ui_followthrough import autobook
from .ui_helpers import assert_clean, open_app, shot

AI_PAR = ("The harbor was a testament to the town's long winters, a tapestry of nets and rope. Mara couldn't help but "
          "smile. She let out a breath she didn't know she was holding.")


def test_originality_card(make_context, ai_server, bridge):
    bridge.ai.chapter_texts["ch1"] = CHAPTER_TEXT[1][0] + "\n\n" + AI_PAR + "\n\n" + CHAPTER_TEXT[1][1]
    try:
        pid = autobook(ai_server)
    finally:
        bridge.ai.chapter_texts.pop("ch1", None)
    page = open_app(make_context(), ai_server, f"#/p/{pid}/main/report")
    card = page.locator("[data-testid=orig-card]")
    card.wait_for(timeout=20000)
    page.locator("[data-testid=orig-line]").wait_for(timeout=20000)
    assert page.locator("[data-testid=rp-originality]").inner_text().startswith("✨ Originality:")
    assert "most in chapter 1" in card.locator("[data-testid=orig-line]").inner_text()
    rows = card.locator("[data-testid=orig-chapters] tbody tr")
    assert rows.count() >= 2 and "/100" in rows.first.inner_text()
    found = card.locator("[data-testid=orig-findings]")
    if found.get_attribute("open") is None:
        found.locator("summary").click()
    text = found.inner_text()
    assert "Chapter 1 · Phrase that sounds machine-written" in text and "a testament to" in text
    card.locator("[data-testid=orig-dialogue]").check()
    page.wait_for_function("() => { const b = document.querySelector('[data-testid=orig-dialogue]'); return b && b.checked; }")
    page.locator("[data-testid=orig-ask]").click()
    page.locator("[data-testid=orig-ai]").wait_for(timeout=30000)
    ai = card.locator("[data-testid=orig-ai]").inner_text()
    assert "4/5" in ai and "Suggested:" in ai
    assert "rated" in card.locator("[data-testid=orig-ai-who]").inner_text()
    shot(page, "n20_originality")
    assert_clean(page, "originality card")
