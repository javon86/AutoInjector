"""📐 Story shape in the browser: picked when starting a book (⚡ Make a book, plain words, default "None — let the AI
decide"), the beats shown as a strip on the plan page ("Ch 3 · Midpoint") and on the Book Bible's story-plan page, and
changed on the plan page of a book whose chapters are not written yet. Screenshots go to $BF_UI_SHOTS."""
from __future__ import annotations

import time

from .test_ui_followthrough import fill_wizard
from .ui_helpers import assert_clean, goto, open_app, open_make_book, overflow, settle, shot


def _wait_run(server, before: set, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        runs = server.api("GET", "/autobook")["runs"]
        new = [r for r in runs if r["id"] not in before]
        if new and new[0]["status"] not in ("queued", "running", "pausing"):
            return new[0]
        time.sleep(0.3)
    raise AssertionError("the run did not finish")


def test_story_shape_from_make_a_book_to_the_plan_and_the_book_bible(make_context, ai_server):
    ctx = make_context()
    page = open_app(ctx, ai_server)
    open_make_book(page)
    dlg = page.locator("#mab-dialog")
    sel = dlg.locator("[data-testid=mb-story-shape]")
    sel.wait_for(timeout=10000)
    opts = sel.locator("option").all_inner_texts()
    assert opts[0] == "None — let the AI decide" and len(opts) == 5
    assert "Save the Cat (15 beats)" in opts and "Hero's Journey (12 stages)" in opts
    assert sel.input_value() == ""  # the default
    sel.select_option("save_the_cat")
    about = dlg.locator("[data-testid=mb-story-shape-about]").inner_text()
    assert "Dark night of the soul" in about and "_" not in about
    shot(page, "story-shape-make-a-book")
    assert_clean(page, "story shape on make a book")
    before = {r["id"] for r in ai_server.api("GET", "/autobook")["runs"]}
    dlg.locator("[data-testid=mb-start]").click()
    run = _wait_run(ai_server, before)
    assert run["status"] == "done", run
    pid = run["project_id"]
    assert ai_server.api("GET", f"/projects/{pid}/profile")["choices"]["shape"] == "save_the_cat"

    # the plan page: the beats on the chapters, no picker any more (the chapters are written)
    page.keyboard.press("Escape")
    goto(page, f"#/p/{pid}/main/book")
    strip = page.locator("[data-testid=plan-story-shape-strip]")
    strip.wait_for(timeout=15000)
    assert page.inner_text("[data-testid=plan-story-shape-name]") == "Save the Cat (15 beats)"
    items = strip.locator("li").all_inner_texts()
    assert len(items) == 15 and items[0].startswith("Ch 1 · Opening image")
    assert any("· Dark night of the soul" in x for x in items)
    assert page.locator("[data-testid=plan-story-shape-pick]").count() == 0
    shot(page, "story-shape-plan-page")
    assert_clean(page, "story shape plan page")

    # the Book Bible's story-plan page (S2 Plot line)
    bd = ai_server.api("GET", f"/projects/{pid}/branches/main/binder")
    plan = next(p for p in bd["pages"] if p["template"] == "10")
    goto(page, f"#/p/{pid}/main/bible/{plan['page_id']}")
    bs = page.locator("[data-testid=bnd-story-shape]").first
    bs.wait_for(timeout=30000)
    txt = bs.inner_text()
    assert "Story shape: Save the Cat (15 beats)" in txt and "· Dark night of the soul" in txt and "Ch 1" in txt
    shot(page, "story-shape-book-bible")
    assert_clean(page, "story shape book bible")


def test_change_the_story_shape_on_the_plan_page_before_chapters(make_context, ai_server):
    page = open_app(make_context(width=390, height=844), ai_server)
    fill_wizard(page, "Shape Book", chars=1, places=0, world=0)
    box = page.locator("[data-testid=plan-story-shape]")
    box.wait_for(timeout=15000)
    assert page.inner_text("[data-testid=plan-story-shape-name]") == "None — let the AI decide"
    pick = page.locator("[data-testid=plan-story-shape-pick]")
    pick.select_option("three_acts")
    page.locator("[data-testid=plan-story-shape-save]").click()
    page.wait_for_function("() => (document.querySelector('[data-testid=plan-story-shape-name]') || {}).textContent "
                           "=== 'Three acts'", timeout=15000)
    settle(page, 200)
    assert "once the chapter outline is approved" in page.inner_text("[data-testid=plan-story-shape]")
    pid = page.evaluate("location.hash").split("/")[2]
    assert ai_server.api("GET", f"/projects/{pid}/profile")["choices"]["shape"] == "three_acts"
    assert overflow(page) <= 1, "the story-shape box scrolls sideways on a phone"
    shot(page, "story-shape-change-phone")
    assert_clean(page, "story shape change")
