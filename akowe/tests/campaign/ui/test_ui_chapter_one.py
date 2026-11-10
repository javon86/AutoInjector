"""✍ Chapter 1 in the browser: the Make-a-book switches "Two first pages, keep the better one" and "Rewrite chapter 1
last" (both on by default; only "off" is sent)."""
from __future__ import annotations

import json

from .ui_helpers import assert_clean, open_app, open_make_book


def _start_body(page, dlg):
    page.route("**/api/autobook", lambda route: route.fulfill(status=400, content_type="application/json",
                                                               body=json.dumps({"errors": [{"code": "INVALID_INPUT",
                                                                                            "path": "/x",
                                                                                            "message": "test stop"}]}))
               if route.request.method == "POST" else route.continue_())
    with page.expect_request(lambda r: r.url.endswith("/api/autobook") and r.method == "POST", timeout=20000) as req:
        dlg.locator("[data-testid=mb-start]").click()
    page.wait_for_timeout(300)
    page.bf_problems.clear()  # the stopped start is the test's own doing
    return json.loads(req.value.post_data or "{}")


def test_make_a_book_screen_has_the_chapter_one_switches(make_context, ai_server):
    page = open_app(make_context(), ai_server)
    open_make_book(page)
    dlg = page.locator("#mab-dialog")
    two = dlg.locator("[data-testid=mb-first-page]")
    last = dlg.locator("[data-testid=mb-opening-pass]")
    two.wait_for(timeout=10000)
    assert two.is_checked() and last.is_checked()
    assert dlg.get_by_label("Two first pages for chapter 1, keep the better one").count() == 1
    assert dlg.get_by_label("Rewrite chapter 1 last, with the whole book in view").count() == 1
    assert "Never a chapter you wrote yourself" in dlg.locator("#mb-opening-pass-hint").inner_text()
    body = _start_body(page, dlg)
    assert "first_page" not in body and "opening_pass" not in body  # on: nothing sent (the default)
    two.uncheck()
    last.uncheck()
    body = _start_body(page, dlg)
    assert body.get("first_page") is False and body.get("opening_pass") is False
    assert_clean(page, "make-a-book chapter one")
