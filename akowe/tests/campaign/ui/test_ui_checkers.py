"""🔎 PR #117 in the browser: the Make-a-book screen's "How many AIs check for mistakes" setting (All working AIs by
default, with a plain explanation of the extra AI time) — the start request carries only a non-default choice."""
from __future__ import annotations

import json

from .ui_helpers import assert_clean, open_app, open_make_book


def test_make_a_book_screen_has_the_checkers_setting(make_context, ai_server):
    page = open_app(make_context(), ai_server)
    open_make_book(page)
    dlg = page.locator("#mab-dialog")
    sel = dlg.locator("[data-testid=mb-checkers]")
    sel.wait_for(timeout=10000)
    assert sel.input_value() == "all"
    opts = sel.locator("option").all_inner_texts()
    assert opts == ["All working AIs (recommended)", "Two AIs", "One AI (the old way)"]
    assert dlg.get_by_label("How many AIs check for mistakes").count() == 1
    hint = dlg.locator("#mb-checkers-hint").inner_text()
    assert "AI time" in hint and "drift" in hint
    sel.select_option("two")
    page.route("**/api/autobook", lambda route: route.fulfill(status=400, content_type="application/json",
                                                               body=json.dumps({"errors": [{"code": "INVALID_INPUT",
                                                                                            "path": "/x",
                                                                                            "message": "test stop"}]}))
               if route.request.method == "POST" else route.continue_())
    with page.expect_request(lambda r: r.url.endswith("/api/autobook") and r.method == "POST", timeout=20000) as req:
        dlg.locator("[data-testid=mb-start]").click()
    body = json.loads(req.value.post_data or "{}")
    assert body.get("checkers") == "two"
    page.wait_for_timeout(300)
    page.bf_problems.clear()  # the stopped start is the test's own doing
    assert_clean(page, "make-a-book checkers")


def _wait(fn, timeout=60.0):
    import time
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = fn()
        if v:
            return v
        time.sleep(0.2)
    raise AssertionError("timed out")


def test_check_consistency_now_outside_a_run(make_context, ai_server):
    from .test_ui_followthrough import autobook
    pid = autobook(ai_server)
    page = open_app(make_context(), ai_server, f"#/p/{pid}/main/continuity")
    box = page.locator("[data-testid=cont-check-now-box]")
    box.wait_for(timeout=20000)
    btn = box.locator("[data-testid=cont-check-now]")
    page.wait_for_function("() => { const b = document.querySelector('[data-testid=cont-check-now]'); return b && !b.disabled; }",
                           timeout=10000)
    rng = box.locator("[data-testid=cont-check-now-range]")
    assert rng.input_value() == "last5"
    assert rng.locator("option").all_inner_texts() == ["Last 5 chapters", "Chapters X to Y", "Whole book so far"]
    assert box.locator("[data-testid=cont-check-now-from]").is_hidden()
    rng.select_option("range")
    assert box.locator("[data-testid=cont-check-now-from]").is_visible()
    box.locator("[data-testid=cont-check-now-from]").fill("1")
    box.locator("[data-testid=cont-check-now-to]").fill("2")
    with page.expect_request(lambda r: r.url.endswith("/check-now") and r.method == "POST", timeout=10000) as req:
        btn.click()
    assert json.loads(req.value.post_data) == {"range": "range", "from": 1, "to": 2}
    page.wait_for_function("() => /Consistency check done/.test((document.querySelector('[data-testid=cont-check-now-result]') || {}).textContent || '')",
                           timeout=60000)
    res = box.locator("[data-testid=cont-check-now-result]").inner_text()
    assert "Consistency check" in res and "chapters 1–2" in res
    assert not btn.is_disabled()
    st = ai_server.api("GET", f"/projects/{pid}/branches/main/review/continuity/check-now")
    assert st["latest"]["kind"] == "now" and st["request"]["from"] == 1 and st["request"]["to"] == 2
    # 🏠 Book home has the same button
    page2 = open_app(make_context(), ai_server, f"#/p/{pid}/main/book")
    page2.locator("[data-testid=home-check-now-box]").wait_for(timeout=20000)
    assert_clean(page, "check now (continuity page)")


def test_check_consistency_now_during_a_run_is_queued_and_the_button_says_why(make_context, ai_server, bridge):
    bridge.delay = 0.3
    try:
        r = ai_server.api("POST", "/autobook", {"author_confirms": True})
        pid = _wait(lambda: ai_server.api("GET", "/autobook/" + r["id"]).get("project_id"))
        # wait until a chapter is written while the run still works
        _wait(lambda: ai_server.api("GET", f"/projects/{pid}/branches/main/review/continuity/check-now")["chapters"] >= 1,
              120)
        page = open_app(make_context(), ai_server, f"#/p/{pid}/main/book")
        box = page.locator("[data-testid=home-check-now-box]")
        box.wait_for(timeout=20000)
        live = ai_server.api("GET", "/autobook/" + r["id"])
        if live["status"] == "done":
            import pytest
            pytest.skip("the run finished before the button could be pressed")
        page.wait_for_function("() => { const b = document.querySelector('[data-testid=home-check-now]'); return b && !b.disabled; }",
                               timeout=10000)
        assert "queued" in box.locator("[data-testid=home-check-now-why]").inner_text()
        box.locator("[data-testid=home-check-now]").click()
        page.wait_for_function("() => /queued|running|done/.test((document.querySelector('[data-testid=home-check-now-result]') || {}).textContent || '')",
                               timeout=20000)
        st = ai_server.api("GET", f"/projects/{pid}/branches/main/review/continuity/check-now")
        if st["state"] in ("queued", "running"):  # one at a time: the button is off with the reason
            assert box.locator("[data-testid=home-check-now]").is_disabled()
            assert box.locator("[data-testid=home-check-now-why]").inner_text().strip()
        bridge.delay = 0.0
        _wait(lambda: ai_server.api("GET", "/autobook/" + r["id"])["status"] not in ("queued", "running", "waiting",
                                                                                    "pausing"), 180)
        st = _wait(lambda: (lambda s: s if s["state"] in ("done", "failed") else None)(
            ai_server.api("GET", f"/projects/{pid}/branches/main/review/continuity/check-now")), 120)
        # it was queued for this run and ran inside it (or, when the run ended first, on its own)
        assert st["state"] == "done" and st["request"]["run_id"] == r["id"]
        assert st["request"]["in_run"] or st["request"].get("handed_over")
        assert st["latest"]["kind"] == "now" and st["latest"]["line"].startswith("🔎 Consistency check")
        assert_clean(page, "check now during a run")
    finally:
        bridge.delay = 0.0
