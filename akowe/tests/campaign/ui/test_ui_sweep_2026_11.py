"""Browser regressions of the November 2026 sweep (docs/SWEEP_2026-11_AKOWE.md) at 1920x1080 and 1280x720: the 🖋
Editor card on the premise / main plot / outline pages no longer throws (and shows its button); Esc closes the jump
box even with text typed; ⚖️ Compare blind cannot be pressed without two finished books; a paused run's clock in ⚡
Make a book stands still."""
from __future__ import annotations

import re
import time

import pytest

from .ui_helpers import assert_clean, goto, open_app

SIZES = [(1920, 1080), (1280, 720)]


@pytest.fixture(scope="module")
def book(ai_server):
    r = ai_server.api("POST", "/autobook", {"author_confirms": True})
    for _ in range(300):
        s = ai_server.api("GET", "/autobook/" + r["id"])
        if s["status"] not in ("queued", "running", "pausing"):
            break
        time.sleep(0.2)
    assert s["status"] == "done", s
    recs = ai_server.api("GET", f"/projects/{s['project_id']}/branches/main/records")
    recs = recs.get("records", recs) if isinstance(recs, dict) else recs
    return {"pid": s["project_id"], "records": recs}


@pytest.mark.parametrize("size", SIZES, ids=["1920", "1280"])
def test_editor_card_on_plan_pages_draws_without_a_page_problem(make_context, ai_server, book, size):
    """Regression: the pattern check is for chapters only (null elsewhere) and the card appended null -> 'The page hit
    a problem' on every premise / main plot / outline page, and the 🖋 Editor review button was never drawn."""
    page = open_app(make_context(*size), ai_server)
    for mod in ("B01", "B03", "B11"):
        rid = next(r["record_id"] for r in book["records"] if r["module_id"] == mod)
        goto(page, f"#/p/{book['pid']}/main/rec/{rid}")
        page.wait_for_selector("[data-testid=ed-review]", timeout=10000)
        assert not page.locator("#global-problem").count(), page.inner_text("#global-problem")
    assert_clean(page, "editor card")


def test_escape_closes_the_jump_box_even_with_text_typed(make_context, ai_server, book):
    page = open_app(make_context(1280, 720), ai_server, f"#/p/{book['pid']}/main")
    page.keyboard.press("Control+k")
    page.wait_for_selector("#jump-dialog[open]")
    page.keyboard.type("chapter")
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)
    assert not page.locator("#jump-dialog[open]").count(), "one Esc only cleared the text"
    assert_clean(page, "jump")


def test_compare_needs_two_finished_books(make_context, server):
    page = open_app(make_context(1920, 1080), server, "#/compare")
    assert page.locator("[data-testid=cmp-start]").is_disabled()
    assert "finished books" in page.inner_text("[data-testid=cmp-need-two]")
    assert_clean(page, "compare")


def test_a_paused_runs_clock_stands_still(make_context, ai_server, bridge, book):
    bridge.ai.verdicts = ["REVISE", "REVISE", "REJECT"]
    try:
        r = ai_server.api("POST", "/autobook", {"author_confirms": True, "pictures": False})
        for _ in range(300):
            s = ai_server.api("GET", "/autobook/" + r["id"])
            if s["status"] not in ("queued", "running", "pausing") and not s.get("alive"):
                break
            time.sleep(0.2)
    finally:
        bridge.ai.verdicts = []
    assert s["status"] == "paused", s["status"]
    try:
        page = open_app(make_context(1280, 720), ai_server)
        page.click("#mab-btn")
        page.wait_for_selector("#mab-dialog .mb-elapsed")
        first = page.inner_text("#mab-dialog .mb-elapsed")
        page.wait_for_timeout(2600)   # the dialog's clock ticks every second while a run works
        assert page.inner_text("#mab-dialog .mb-elapsed") == first
        assert re.search(r"\d", first)
        assert_clean(page, "paused run")
    finally:
        ai_server.api("POST", f"/autobook/{r['id']}/cancel", {})
