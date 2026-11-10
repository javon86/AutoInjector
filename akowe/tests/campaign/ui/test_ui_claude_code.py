"""🤖 Claude Code helpers in the browser: the Settings card (status in plain words, on/off, helpers at once, which
jobs, which specialist reviewers) and the Make-a-book tick (off and greyed when the helpers are not ready; the start request then carries nothing).
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
    assert card.locator("input[data-job]").count() == 11  # Step 1's four jobs and Step 2's seven
    specs = card.locator("[data-testid=cc-specialists] input[data-spec]")
    assert specs.count() == 4 and not card.locator("#cc-spec-pacing").is_checked()  # pacing is off by default
    assert card.locator("#cc-spec-dialogue").is_checked()
    card.locator("label[for=cc-spec-pacing]").click()
    assert "shares that plan" in card.inner_text()
    card.locator("[data-testid=cc-helpers]").fill("2")
    with page.expect_response(lambda r: r.url.endswith("/api/settings/claude-code") and r.request.method == "PUT",
                              timeout=15000) as resp:
        card.locator("[data-testid=cc-save]").click()
    sent = json.loads(resp.value.request.post_data)
    assert resp.value.status == 200 and sent["helpers"] == 2
    assert sent["specialists"]["pacing"] is True and sent["jobs"]["prepare"] is True
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


def test_open_claude_code_button_asks_the_server_and_shows_what_happens(make_context, ai_server):
    """⌨ Open Claude Code: one request to /settings/claude-code/window; its message is shown in plain words. The
    request is answered here, so no window opens on the test machine."""
    page = open_app(make_context(), ai_server)
    page.route("**/api/settings/claude-code/window", lambda route: route.fulfill(
        status=200, content_type="application/json",
        body=json.dumps({"ok": True, "kind": "claude", "message": "Claude Code is open in a new window."})))
    goto(page, "#/settings")
    card = page.locator("[data-testid=cc-card]")
    btn = card.locator("[data-testid=cc-open-window]")
    btn.wait_for(timeout=15000)
    with page.expect_request(lambda r: r.url.endswith("/api/settings/claude-code/window") and r.method == "POST",
                             timeout=15000) as req:
        btn.click()
    assert json.loads(req.value.post_data) == {"install": False}
    card.locator("[data-testid=cc-window-msg]").filter(has_text="open in a new window").wait_for(timeout=5000)
    assert "Open Claude Code" in card.inner_text()
    assert_clean(page, "claude code open window button")
