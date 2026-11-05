"""📚 Kind of story (the seven basic plots) in the browser: picked when starting a book (⚡ Make a book, plain words,
default "Let the AI decide", all seven kinds), shown on the plan page with its promise and its stages on the chapters
("Ch 1 · The threat and the call") and on the Book Bible's story-plan page, and changed on the plan page of a book
whose chapters are not written yet, at phone width. Screenshots go to $BF_UI_SHOTS."""
from __future__ import annotations

from .test_ui_followthrough import fill_wizard
from .test_ui_story_shape import _wait_run
from .ui_helpers import assert_clean, goto, open_app, open_make_book, overflow, settle, shot

SEVEN = ["Overcoming the Monster", "Rags to Riches", "The Quest", "Voyage and Return", "Comedy", "Tragedy", "Rebirth"]


def test_story_kind_from_make_a_book_to_the_plan_and_the_book_bible(make_context, ai_server):
    ctx = make_context()
    page = open_app(ctx, ai_server)
    open_make_book(page)
    dlg = page.locator("#mab-dialog")
    sel = dlg.locator("[data-testid=mb-story-kind]")
    sel.wait_for(timeout=10000)
    opts = sel.locator("option").all_inner_texts()
    assert opts[0] == "Let the AI decide" and opts[1:] == SEVEN
    assert sel.input_value() == ""  # the default
    sel.select_option("monster")
    about = dlg.locator("[data-testid=mb-story-kind-about]").inner_text()
    assert "The threat and the call" in about and "Victory over the monster" in about and "_" not in about
    assert "The ending must deliver" in about
    shot(page, "story-kind-make-a-book")
    assert_clean(page, "story kind on make a book")
    before = {r["id"] for r in ai_server.api("GET", "/autobook")["runs"]}
    dlg.locator("[data-testid=mb-start]").click()
    run = _wait_run(ai_server, before)
    assert run["status"] == "done", run
    pid = run["project_id"]
    assert ai_server.api("GET", f"/projects/{pid}/profile")["choices"]["kind"] == "monster"

    # the plan page: the kind, its promise and its stages on the chapters; no picker (the chapters are written)
    page.keyboard.press("Escape")
    goto(page, f"#/p/{pid}/main/book")
    strip = page.locator("[data-testid=plan-story-kind-strip]")
    strip.wait_for(timeout=15000)
    assert page.inner_text("[data-testid=plan-story-kind-name]") == "Overcoming the Monster"
    assert "defeats it" in page.inner_text("[data-testid=plan-story-kind-promise]")
    items = strip.locator("li").all_inner_texts()
    assert len(items) == 5 and items[0].startswith("Ch 1") and "· The threat and the call" in items[0]
    assert any("· Victory over the monster" in x for x in items)
    assert page.locator("[data-testid=plan-story-kind-pick]").count() == 0
    shot(page, "story-kind-plan-page")
    assert_clean(page, "story kind plan page")

    # the Book Bible's story-plan page (S2 Plot line)
    bd = ai_server.api("GET", f"/projects/{pid}/branches/main/binder")
    plan = next(p for p in bd["pages"] if p["template"] == "10")
    goto(page, f"#/p/{pid}/main/bible/{plan['page_id']}")
    bk = page.locator("[data-testid=bnd-story-kind]").first
    bk.wait_for(timeout=30000)
    txt = bk.inner_text()
    assert "Kind of story: Overcoming the Monster" in txt and "· The nightmare" in txt and "Ch 1" in txt
    shot(page, "story-kind-book-bible")
    assert_clean(page, "story kind book bible")


def test_change_the_story_kind_on_the_plan_page_at_phone_width(make_context, ai_server):
    page = open_app(make_context(width=390, height=844), ai_server)
    fill_wizard(page, "Kind Book", chars=1, places=0, world=0)
    box = page.locator("[data-testid=plan-story-kind]")
    box.wait_for(timeout=15000)
    assert page.inner_text("[data-testid=plan-story-kind-name]") == "Let the AI decide"
    pick = page.locator("[data-testid=plan-story-kind-pick]")
    assert pick.locator("option").all_inner_texts()[1:] == SEVEN
    pick.select_option("tragedy")
    page.locator("[data-testid=plan-story-kind-save]").click()
    page.wait_for_function("() => (document.querySelector('[data-testid=plan-story-kind-name]') || {}).textContent "
                           "=== 'Tragedy'", timeout=15000)
    settle(page, 200)
    txt = page.inner_text("[data-testid=plan-story-kind]")
    assert "once the chapter outline is approved" in txt and "downfall" in txt
    pid = page.evaluate("location.hash").split("/")[2]
    assert ai_server.api("GET", f"/projects/{pid}/profile")["choices"]["kind"] == "tragedy"
    assert overflow(page) <= 1, "the kind-of-story box scrolls sideways on a phone"
    shot(page, "story-kind-change-phone")
    assert_clean(page, "story kind change")
