"""👥 Idea #14 in the browser: the panel of beta readers on the 📊 report page (choose 3 readers, rewrite one
reader's description, ask the panel, see the verdicts, the strong signals, the chapter heat map and the top fixes,
open one reader's own read) and the "How many readers" choice in the ⚡ Make-a-book form."""
from __future__ import annotations

from .test_ui_followthrough import autobook
from .ui_helpers import assert_clean, open_app, open_make_book, shot


def test_panel_of_beta_readers(make_context, ai_server):
    pid = autobook(ai_server)
    page = open_app(make_context(), ai_server, f"#/p/{pid}/main/report")
    card = page.locator("[data-testid=beta-card]")
    card.wait_for(timeout=20000)
    # one reader by default (as before): readers 2 and 3 are hidden
    assert page.locator("[data-testid=beta-size]").input_value() == "1"
    assert page.locator("[data-testid=beta-reader-2]").is_hidden()
    assert page.locator("[data-testid=beta-ask]").inner_text().startswith("📖 Ask a beta reader")
    page.locator("[data-testid=beta-size]").select_option("3")
    assert page.locator("[data-testid=beta-reader-3]").is_visible()
    assert page.locator("[data-testid=beta-ask]").inner_text() == "👥 Ask the panel of 3 readers"
    assert "picky" in page.locator("[data-testid=beta-persona-2]").input_value()
    assert "slow" in page.locator("[data-testid=beta-persona-3]").input_value()
    page.locator("[data-testid=beta-persona-2]").fill("a retired lighthouse keeper who knows every rock of the coast")
    page.locator("[data-testid=beta-ask]").click()
    page.locator("[data-testid=beta-headline]").wait_for(timeout=60000)
    text = card.inner_text()
    assert "3 readers:" in text and "would finish it" in text
    assert page.locator("[data-testid=beta-verdicts] tbody tr").count() == 3
    assert "reader you described" in page.locator("[data-testid=beta-verdicts]").inner_text()
    agree = page.locator("[data-testid=beta-agree]").inner_text()
    assert "Strong signal" in agree and "got lost in chapter 1" in agree
    assert page.locator("[data-testid=beta-heat] tbody tr").count() == 2 + 3  # lost, bored, one interest row each
    assert page.locator("[data-testid=beta-heat] td.s7-heat-3").count() >= 1  # all three got lost in chapter 1
    assert page.locator("[data-testid=beta-fixes] li").count() >= 1
    assert "Chapter 1" in page.locator("[data-testid=beta-fixes] li").first.inner_text()
    page.locator("[data-testid=beta-reader-read-1] > summary").click()
    assert page.locator("[data-testid=beta-reader-read-1] [data-testid=beta-findings]").is_visible()
    # the edited description is kept for this book
    st = ai_server.api("GET", f"/projects/{pid}/branches/main/beta")
    assert st["panel"]["size"] == 3 and st["panel"]["readers"][1]["persona"].startswith("a retired lighthouse")
    shot(page, "idea14_beta_panel")
    assert_clean(page, "beta panel")

    open_make_book(page)
    d = page.locator("#mab-dialog")
    d.locator("[data-testid=mb-beta-n]").wait_for(timeout=15000)
    assert not d.locator("[data-testid=mb-beta]").is_checked()
    d.locator("[data-testid=mb-beta-n]").select_option("2")
    assert d.locator("[data-testid=mb-beta]").is_checked()  # choosing a panel switches the beta reader on
    assert_clean(page, "make-a-book beta panel choice")
