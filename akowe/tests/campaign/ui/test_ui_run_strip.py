"""⏳ The run progress strip at the top of every page (run-strip.js, run_clock.py): while a ⚡ run works it says the
book, "Step N of M — what it does", the time left against the start estimate, when it started and when it should
finish, with a thin bar; a click opens the run window; it waits plainly for the author ("the clock is paused");
several runs show "+1 more"; a finished run says how long it took against the estimate; at phone width it wraps and
never scrolls sideways."""
from __future__ import annotations

import json
import re
import threading
import time

from .ui_helpers import assert_clean, open_app, overflow, shot


def _iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


def wait_status(server, run_id, statuses, timeout=30):
    t0 = time.time()
    r = {}
    while time.time() - t0 < timeout:
        r = server.api("GET", f"/autobook/{run_id}")
        if r["status"] in statuses and not r.get("alive"):
            return r
        time.sleep(0.2)
    raise AssertionError(f"run {run_id} not in {statuses}: {r.get('status')}")


def fits(page, width):
    box = page.locator("#run-strip").bounding_box()
    return box and box["x"] >= 0 and box["x"] + box["width"] <= width + 0.5


def test_strip_follows_a_real_run(make_context, ai_server, bridge):
    gate = threading.Event()
    bridge.gate = gate  # the AI answers wait until the test lets them go
    run_id = None
    try:
        ctx = make_context()
        page = open_app(ctx, ai_server)
        assert page.locator("#run-strip").is_hidden()
        run_id = ai_server.api("POST", "/autobook", {"author_confirms": True, "length": "short_story",
                                                     "pictures": False})["id"]
        page.wait_for_function("() => !document.querySelector('#run-strip').hidden && /left/.test(document.querySelector('#run-strip').textContent)",
                               timeout=20000)
        text = page.inner_text("[data-testid=run-strip-text]")
        assert text.startswith("📖 "), text
        assert re.search(r"Step \d+ of \d+ — ", text), text
        assert re.search(r"⏳ about [\dhms ]+ left \(estimate at start: [\dhms ]+\)", text), text
        assert "started " in text and "should finish around " in text, text
        assert page.get_attribute("[data-testid=run-strip-bar]", "aria-valuenow") is not None
        # inside the sticky top bar, on every page
        assert page.evaluate("document.querySelector('.topbar').contains(document.querySelector('#run-strip'))")
        page.evaluate("location.hash = '#/settings'")
        page.wait_for_timeout(600)
        assert page.locator("#run-strip").is_visible()
        # a click opens the run window
        page.click("[data-testid=run-strip-open]")
        page.wait_for_selector("#mab-dialog[open]", timeout=10000)
        page.wait_for_selector("[data-testid=mb-eta]", timeout=10000)
        assert "estimate at start" in page.inner_text("[data-testid=mb-eta]")
        page.keyboard.press("Escape")
        page.wait_for_function("() => !document.querySelector('#mab-dialog').open", timeout=10000)

        # phone width: it wraps, no sideways scrolling
        phone = open_app(make_context(width=390, height=844), ai_server)
        phone.wait_for_function("() => !document.querySelector('#run-strip').hidden", timeout=15000)
        assert overflow(phone) <= 0 and fits(phone, 390)
        assert "should finish around" in phone.inner_text("[data-testid=run-strip-text]")

        # #/run/<id> (AutoInjector's top bar) opens the run window
        page.evaluate(f"location.hash = '#/run/{run_id}'")
        page.wait_for_selector("#mab-dialog[open]", timeout=10000)
        page.keyboard.press("Escape")

        # paused: it says it waits, the clock is paused, no finish time
        ai_server.api("POST", f"/autobook/{run_id}/pause", {})
        gate.set()
        wait_status(ai_server, run_id, ("paused", "done"))
        page.wait_for_function("() => /the clock is paused/.test(document.querySelector('#run-strip').textContent)",
                               timeout=15000)
        t = page.inner_text("[data-testid=run-strip-text]")
        assert re.search(r"⏸ paused since \d", t) and "should finish" not in t, t
        assert page.get_attribute("#run-strip", "data-tone") == "warn"
        assert_clean(page, "desktop")
        assert_clean(phone, "phone")
    finally:
        gate.set()
        bridge.gate = None
        if run_id:
            ai_server.api("POST", f"/autobook/{run_id}/cancel", {}, expect_ok=False)


def _runs():
    now = time.time()
    working = {"id": "run-w", "title": "The Salt Road", "state": "working", "status": "running", "alive": True,
               "steps": [], "started_at": _iso(now - 3600), "updated_at": _iso(now), "step_index": 12,
               "step_total": 19, "step_label": "Writing chapter 2 of 10", "left_s": 6000, "total_estimate_s": 15000,
               "percent": 40, "finish_at": _iso(now + 6000), "elapsed_active_s": 3600}
    waiting = {"id": "run-p", "title": "Second Book", "state": "needs_decision", "status": "paused", "alive": False,
               "steps": [], "started_at": _iso(now - 9000), "updated_at": _iso(now - 600), "step_index": 7,
               "step_total": 19, "step_label": "Writing the main plot", "left_s": 9000, "total_estimate_s": 12000,
               "percent": 25, "waiting_since": _iso(now - 600)}
    done = {"id": "run-d", "title": "Old Book", "state": "done", "status": "done", "alive": False, "steps": [],
            "started_at": _iso(now - 20000), "finished_at": _iso(now - 60), "updated_at": _iso(now - 60),
            "actual_s": 5 * 3600 + 120, "total_estimate_s": 4 * 3600 + 600, "percent": 100}
    return working, waiting, done


def test_strip_waiting_several_runs_and_finished(make_context, server):
    working, waiting, done = _runs()
    state = {"body": {"runs": [done, waiting], "active": [working], "current": working, "scheduled": {"state": "none"}}}

    def fake(route):
        route.fulfill(status=200, content_type="application/json", body=json.dumps(state["body"]))

    for width in (1280, 390):
        ctx = make_context(width=width, height=844)
        page = open_app(ctx, server)
        page.route(re.compile(r".*/api/autobook$"), fake)
        page.evaluate("location.hash = '#/settings'")
        page.wait_for_function("() => !document.querySelector('#run-strip').hidden", timeout=15000)
        t = page.inner_text("[data-testid=run-strip-text]")
        assert "“The Salt Road”" in t and "Step 12 of 19 — Writing chapter 2 of 10" in t, t
        assert "⏳ about 1 h 40 m left" in t and "should finish around" in t, t
        if width > 800:
            assert "(estimate at start: 4 h 10 m)" in t and "started " in t, t
        assert page.get_attribute("[data-testid=run-strip-bar]", "aria-valuenow") == "40"
        assert page.inner_text("[data-testid=run-strip-more]") == "+2 more"
        assert overflow(page) <= 0 and fits(page, width)
        shot(page, f"run-strip-{width}")
        # the next one: waiting for the author, plainly
        page.click("[data-testid=run-strip-more]")
        t = page.inner_text("[data-testid=run-strip-text]")
        assert re.search(r"⏸ waiting for you since \d.+? — the clock is paused", t) and "Second Book" in t, t
        assert "should finish" not in t
        # then the finished one: its real time against the estimate; ✕ hides it
        page.click("[data-testid=run-strip-more]")
        t = page.inner_text("[data-testid=run-strip-text]")
        assert t == "✔ “Old Book” finished in 5 h 2 m (estimated 4 h 10 m)", t
        assert overflow(page) <= 0 and fits(page, width)
        page.click("[data-testid=run-strip-hide]")
        assert page.inner_text("[data-testid=run-strip-more]") == "+1 more"
        # nothing left to show: no strip
        state["body"] = {"runs": [], "active": [], "current": None, "scheduled": {"state": "none"}}
        page.wait_for_function("() => document.querySelector('#run-strip').hidden", timeout=15000)
        assert_clean(page, f"width {width}")
        state["body"] = {"runs": [done, waiting], "active": [working], "current": working, "scheduled": {"state": "none"}}
