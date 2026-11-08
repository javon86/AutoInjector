"""🤖 Claude Code helpers in the browser: the Settings card (status in plain words, on/off, helpers at once, which
jobs) and the Make-a-book tick (off and greyed when the helpers are not ready; the start request then carries nothing).
The suite switches the helpers off (AKOWE_CLAUDE_CODE=off), so the card says so."""
from __future__ import annotations

import json

from .ui_helpers import assert_clean, goto, open_app, open_make_book


def test_settings_card_shows_the_status_and_saves(make_context, ai_server):
    page = open_app(make_context(), ai_server)
    goto(page, "#/settings")
    card = page.locator("[data-testid=cc-card]")
    card.wait_for(timeout=15000)
    st = card.locator("[data-testid=cc-status]")
    st.wait_for(timeout=15000)
    assert st.get_attribute("data-state") == "off" and "Switched off" in st.inner_text()
    assert card.locator("[data-testid=cc-helpers]").input_value() == "3"
    assert card.locator("input[data-job]").count() == 4
    assert "shares that plan" in card.inner_text()
    card.locator("[data-testid=cc-helpers]").fill("2")
    with page.expect_response(lambda r: r.url.endswith("/api/settings/claude-code") and r.request.method == "PUT",
                              timeout=15000) as resp:
        card.locator("[data-testid=cc-save]").click()
    assert resp.value.status == 200 and json.loads(resp.value.request.post_data)["helpers"] == 2
    page.wait_for_timeout(300)
    assert card.locator("[data-testid=cc-helpers]").input_value() == "2"
    assert_clean(page, "claude code settings card")


def test_make_a_book_tick_is_off_when_the_helpers_are_not_ready(make_context, ai_server):
    page = open_app(make_context(), ai_server)
    open_make_book(page)
    dlg = page.locator("#mab-dialog")
    box = dlg.locator("[data-testid=mb-cc]")
    box.wait_for(timeout=10000, state="attached")
    dlg.locator("[data-testid=mb-cc-status]").wait_for(timeout=10000)
    assert box.is_disabled() and not box.is_checked()
    page.route("**/api/autobook", lambda route: route.fulfill(status=400, content_type="application/json",
                                                               body=json.dumps({"errors": [{"code": "INVALID_INPUT",
                                                                                            "path": "/x",
                                                                                            "message": "test stop"}]}))
               if route.request.method == "POST" else route.continue_())
    with page.expect_request(lambda r: r.url.endswith("/api/autobook") and r.method == "POST", timeout=20000) as req:
        dlg.locator("[data-testid=mb-start]").click()
    assert "claude_code" not in json.loads(req.value.post_data or "{}")
    page.wait_for_timeout(300)
    page.bf_problems.clear()
    assert_clean(page, "make-a-book claude code tick")
