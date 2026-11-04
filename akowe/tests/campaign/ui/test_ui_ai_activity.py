"""⚡ #116 the AI activity strip under the top bar: while an AI works (the fake AutoInjector holds its answer) a row
shows which AI, what it does in plain words, its stage, a time that ticks and "step N of M"; a click opens the run;
the row is keyboard-focusable and announced politely; at phone width it fits without sideways scrolling; when the
work is done the row says so and the strip disappears (no space taken when nothing works)."""
from __future__ import annotations

import re
import threading
import time

from .ui_helpers import assert_clean, open_app, overflow


def strip_height(page) -> float:
    return page.evaluate("document.querySelector('#ai-activity').getBoundingClientRect().height")


def wait_status(server, run_id, statuses, timeout=30):
    t0 = time.time()
    r = {}
    while time.time() - t0 < timeout:
        r = server.api("GET", f"/autobook/{run_id}")
        if r["status"] in statuses and not r.get("alive"):
            return r
        time.sleep(0.2)
    raise AssertionError(f"run {run_id} not in {statuses}: {r.get('status')} alive={r.get('alive')}")


def test_ai_activity_strip_live_rows_tick_and_vanish(make_context, ai_server, bridge):
    gate = threading.Event()
    bridge.gate = gate  # every AI answer waits until the test lets it go
    run_id = None
    try:
        ctx = make_context()
        page = open_app(ctx, ai_server)
        assert page.locator("#ai-activity").is_hidden() and strip_height(page) == 0  # nothing at work: no space
        top0 = page.evaluate("document.querySelector('.topbar').getBoundingClientRect().height")

        run_id = ai_server.api("POST", "/autobook", {"author_confirms": True, "length": "short_story",
                                                     "pictures": False})["id"]
        row = page.locator("[data-testid=aia-row]").first
        row.wait_for(timeout=20000)
        page.wait_for_function("() => /AI is answering/.test(document.querySelector('[data-testid=aia-row]').textContent)",
                               timeout=10000)
        text = row.inner_text()
        assert "Inventing the book" in text, text
        assert re.search(r"AI-\d", text) and re.search(r"step \d+ of \d+", text), text
        # directly under the top bar, inside its sticky area
        assert page.evaluate("document.querySelector('.topbar').contains(document.querySelector('#ai-activity'))")
        assert page.evaluate("document.querySelector('.topbar').getBoundingClientRect().height") > top0
        # the time ticks without a reload
        t1 = page.locator("[data-testid=aia-time]").first.inner_text()
        page.wait_for_timeout(2300)
        t2 = page.locator("[data-testid=aia-time]").first.inner_text()
        assert t1 != t2 and re.fullmatch(r"\d+ s|\d+ min \d\d s", t2), (t1, t2)
        # announced once, politely (start only, not every second)
        page.wait_for_function("() => /started: Inventing the book/.test(document.querySelector('#aia-live').textContent)",
                               timeout=5000)
        assert page.get_attribute("#aia-live", "aria-live") == "polite"
        # keyboard: the row is a button with a plain name; Enter opens the run's window
        row.focus()
        assert page.evaluate("document.activeElement.dataset.testid") == "aia-row"
        name = row.get_attribute("aria-label")
        assert "Inventing the book" in name and "AI is answering" in name and not re.search(r"\d+ s so far", name)
        page.wait_for_timeout(1600)  # a poll and a few ticks later the focus is still on the row
        assert page.evaluate("document.activeElement.dataset.testid") == "aia-row"
        page.keyboard.press("Enter")
        page.wait_for_selector("#mab-dialog[open]", timeout=10000)
        page.keyboard.press("Escape")
        page.wait_for_function("() => !document.querySelector('#mab-dialog').open", timeout=10000)
        # the ⚡ chip still says how far the whole run is; the strip says what the AI does inside it
        assert re.search(r"AI working \d+/\d+", page.inner_text("#mab-btn"))

        # phone width: the same row fits, no sideways scrolling
        pctx = make_context(width=390, height=844)
        phone = open_app(pctx, ai_server)
        prow = phone.locator("[data-testid=aia-row]").first
        prow.wait_for(timeout=10000)
        assert overflow(phone) <= 0
        box = prow.bounding_box()
        assert box and box["x"] >= 0 and box["x"] + box["width"] <= 390 + 0.5, box
        assert "Inventing the book" in prow.inner_text()

        # done: pause the run, let the AI answer; the row says it finished, then the strip goes away
        ai_server.api("POST", f"/autobook/{run_id}/pause", {})
        gate.set()
        wait_status(ai_server, run_id, ("paused", "done"))
        page.wait_for_function("() => [...document.querySelectorAll('#aia-rows li')].some(li => li.dataset.state === 'done')",
                               timeout=10000)
        done = page.locator("#aia-rows li[data-state=done]").first.inner_text()
        assert re.search(r"(✔ Done|■ Stopped): ", done), done
        page.wait_for_function("() => document.querySelector('#ai-activity').hidden", timeout=15000)
        assert strip_height(page) == 0
        phone.wait_for_function("() => document.querySelector('#ai-activity').hidden", timeout=15000)
        assert_clean(page, "desktop")
        assert_clean(phone, "phone")
    finally:
        gate.set()
        bridge.gate = None
        if run_id:
            ai_server.api("POST", f"/autobook/{run_id}/cancel", {}, expect_ok=False)
