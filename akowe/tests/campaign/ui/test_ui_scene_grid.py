"""🗂 P27 scene grid and ⏱ P28 time and AI use in the browser: a made book's grid shows every scene with the plan,
words and problems, sorts and filters, turns into cards on a phone without sideways scrolling; the costs page and the
run window show AI answers and minutes per AI; the Make-a-book setup shows an estimate that follows the length."""
from __future__ import annotations

from .test_ui_followthrough import autobook
from .ui_helpers import assert_clean, goto, open_app, overflow, shot


def test_scene_grid_costs_and_estimate(make_context, ai_server):
    pid = autobook(ai_server)
    page = open_app(make_context(), ai_server, f"#/p/{pid}/main/grid")
    table = page.locator("[data-testid=sg-table]")
    table.wait_for(timeout=20000)
    summary = page.inner_text("[data-testid=sg-summary]")
    assert "chapter(s)" in summary and "scene row(s)" in summary and "problem(s) flagged" in summary
    rows = page.locator("[data-testid=sg-row]")
    n = rows.count()
    assert n >= 2
    assert page.locator(".sg-ch").count() >= 1  # chapter header rows in story order
    first = rows.first.inner_text()
    assert "1.1" in first and "Mara" in first  # POV name and goals from the scene cards
    # sort by problems: the chapter header rows go, every scene row stays
    page.select_option("[data-testid=sg-sort]", "problems")
    page.wait_for_timeout(100)
    assert page.locator(".sg-ch").count() == 0 and rows.count() == n
    page.select_option("[data-testid=sg-sort]", "story")
    page.check("[data-testid=sg-only]")
    page.wait_for_timeout(100)
    assert rows.count() <= n
    page.uncheck("[data-testid=sg-only]")
    shot(page, "p27_scene_grid")
    assert_clean(page, "scene grid")
    # printable: the print stylesheet hides the app's bars
    page.emulate_media(media="print")
    assert page.locator(".topbar").is_hidden() and page.locator("[data-testid=sg-print]").is_hidden()
    page.emulate_media(media="screen")

    # ⏱ time and AI use for the book: measured per AI
    goto(page, f"#/p/{pid}/main/costs")
    page.locator("[data-testid=ct-by-ai]").wait_for(timeout=15000)
    by_ai = page.inner_text("[data-testid=ct-by-ai]").lower()
    assert "ai-1" in by_ai and "answers" in by_ai and "minutes" in by_ai
    assert "AI answers in 1" in page.inner_text("[data-testid=ct-summary]")
    page.locator("[data-testid=mb-estimate]").filter(has_text="AI answers").wait_for(timeout=10000)
    assert_clean(page, "costs page")

    # a new run's setup shows the estimate, which follows the length; the run window shows answers and minutes per AI
    page.click("#mab-btn")
    dlg = page.locator("#mab-dialog")
    est = dlg.locator("[data-testid=mb-estimate]")
    est.filter(has_text="AI answers").wait_for(timeout=10000)
    short = est.inner_text()
    assert "3 chapters" in short
    dlg.locator("#mb-len-novel").check()
    est.filter(has_text="25 chapters").wait_for(timeout=10000)  # the estimate follows the length
    assert "written scene by scene" in est.inner_text() and est.inner_text() != short
    dlg.locator("#mb-len-short_story").check()
    dlg.get_by_role("button", name="⚡ Start with these settings").click()
    dlg.locator("[data-testid=mb-costs]").wait_for(timeout=30000)
    assert "AI answer" in dlg.locator("[data-testid=mb-costs]").inner_text()
    for _ in range(300):  # let the run finish (the next test makes its own book)
        runs = ai_server.api("GET", "/autobook")
        if not runs.get("active"):
            break
        page.wait_for_timeout(200)
    dlg.get_by_role("button", name="Close (the run keeps going in the background)").click()
    assert_clean(page, "estimate and run window")


def test_scene_grid_on_a_phone(make_context, ai_server):
    pid = autobook(ai_server)
    page = open_app(make_context(width=390, height=844), ai_server, f"#/p/{pid}/main/grid")
    page.locator("[data-testid=sg-table]").wait_for(timeout=20000)
    assert overflow(page) <= 1, "the grid scrolls sideways on a phone"
    row = page.locator("[data-testid=sg-row]").first
    # each scene is a card: its cells stack and say what they are
    label = row.locator("td").first.evaluate("e => getComputedStyle(e, '::before').content")
    assert "Point of view" in label
    box = row.bounding_box()
    assert box and box["width"] <= 390
    shot(page, "p27_scene_grid_phone")
    assert_clean(page, "scene grid phone")
