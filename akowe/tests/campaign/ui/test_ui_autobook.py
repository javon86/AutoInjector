"""⚡ Make a book for me in the browser with the fake AI (slowed down): progress updates live without a reload,
Pause/Resume, a reload while paused shows the same run, Cancel mid-run (with its confirmation) leaves a sane state
(run cancelled, book in Your books, its page consistent with the API, a new run can start)."""
from __future__ import annotations

import re
import time

import pytest
from playwright.sync_api import TimeoutError as PWTimeout

from .ui_helpers import assert_clean, goto, open_app, settle, shot


def run_steps_done(page):
    t = page.inner_text("#mab-dialog .mb-head")
    m = re.search(r"(\d+) of (\d+) steps", t)
    return int(m.group(1)), int(m.group(2))


def api_run(server):
    out = server.api("GET", "/autobook")
    runs = out["runs"]
    return runs[0] if runs else None


def wait_status(server, run_id, statuses, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = server.api("GET", f"/autobook/{run_id}")
        if r["status"] in statuses and not r.get("alive"):
            return r
        time.sleep(0.2)
    raise AssertionError(f"run {run_id} not in {statuses}: {r['status']} alive={r.get('alive')}")


@pytest.fixture
def slow_ai(bridge):
    bridge.delay = 0.35
    yield bridge
    bridge.delay = 0.0


def test_make_a_book_live_pause_reload_resume_cancel(make_context, ai_server, slow_ai):
    ctx = make_context()
    page = open_app(ctx, ai_server)
    page.click("#mab-btn")
    dlg = page.locator("#mab-dialog")
    dlg.get_by_role("button", name="⚡ Start — let the AI choose everything").click()
    dlg.locator(".mb-steps").wait_for(timeout=10000)

    # live progress: the counter goes up without any reload
    seen = []
    t0 = time.time()
    while time.time() - t0 < 20 and (len(set(seen)) < 3):
        seen.append(run_steps_done(page)[0])
        page.wait_for_timeout(300)
    assert len(set(seen)) >= 3, f"progress did not move in the open window: {seen}"
    assert seen == sorted(seen), f"progress went backwards: {seen}"
    chip = page.inner_text("#mab-btn")
    assert "Making" in chip, chip

    # Pause: the run stops after the current answer; the window and the API agree
    run_id = api_run(ai_server)["id"]
    dlg.get_by_role("button", name="⏸ Pause").click()
    r = wait_status(ai_server, run_id, ("paused",))
    page.wait_for_function("() => !!document.querySelector('#mab-dialog [data-testid=mb-resume]')", timeout=10000)
    assert run_steps_done(page)[0] == sum(1 for s in r["steps"] if s["state"] == "done")
    time.sleep(1.0)
    assert ai_server.api("GET", f"/autobook/{run_id}")["status"] == "paused", "a paused run kept working"

    # reload while paused: the top bar says Paused and ⚡ opens the same run at the same step
    page.reload()
    page.wait_for_selector("#main h1", timeout=15000)
    page.wait_for_function("() => /Paused/.test(document.querySelector('#mab-btn').textContent)", timeout=10000)
    page.click("#mab-btn")
    dlg.locator(".mb-steps").wait_for(timeout=10000)
    assert run_steps_done(page)[0] == sum(1 for s in r["steps"] if s["state"] == "done")

    # Resume, let it move on, then Cancel mid-run (a confirmation first; dismissing it keeps the run going)
    dlg.get_by_role("button", name="▶ Resume").click()
    n0 = run_steps_done(page)[0]
    page.wait_for_function(f"() => {{ const m = /(\\d+) of \\d+ steps/.exec(document.querySelector('#mab-dialog .mb-head').textContent); return m && +m[1] > {n0}; }}",
                           timeout=20000)
    dlg.get_by_role("button", name="✖ Cancel").click()
    confirm = page.locator("dialog[open]", has_text="Cancel this run?")
    confirm.wait_for(timeout=3000)
    page.keyboard.press("Escape")
    assert not confirm.count()
    assert ai_server.api("GET", f"/autobook/{run_id}")["status"] in ("running", "waiting", "done")
    st = ai_server.api("GET", f"/autobook/{run_id}")
    if st["status"] == "done":
        pytest.skip("the run finished before Cancel could be pressed")
    dlg.get_by_role("button", name="✖ Cancel").click()
    page.get_by_role("button", name="✖ Yes, cancel it").click()
    r = wait_status(ai_server, run_id, ("cancelled",))
    page.wait_for_function("() => /Make another book/.test(document.querySelector('#mab-dialog').textContent)",
                           timeout=10000)
    txt = dlg.inner_text()
    assert "Resume" not in txt and "Pause" not in txt, txt
    done_in_run = sum(1 for s in r["steps"] if s["state"] == "done")
    assert 0 < done_in_run < len(r["steps"])

    # sane state: the book is in Your books and its page agrees with the API; nothing keeps running
    pid = r["project_id"]
    page.keyboard.press("Escape")
    goto(page, "#/")
    assert r["title"] in page.inner_text("#main")
    goto(page, f"#/p/{pid}/main/book")
    b = ai_server.api("GET", f"/projects/{pid}/branches/main/book")
    m = re.search(r"(\d+) of (\d+) steps done", page.inner_text("#main .book-top"))
    assert (int(m.group(1)), int(m.group(2))) == (b["done_count"], b["total"])
    calls = slow_ai.completes
    time.sleep(1.5)
    assert slow_ai.completes == calls, "the AI was still being called after Cancel"
    assert "Making" not in page.inner_text("#mab-btn")

    # a new run can start after the cancelled one
    page.click("#mab-btn")
    dlg.locator("button", has_text="Make another book").or_(dlg.get_by_role("button", name="⚡ Start — let the AI choose everything")).first.wait_for(timeout=5000)
    another = dlg.locator("button", has_text="Make another book")
    if another.count():
        try:  # the dialog can re-render to the start form between count() and click(): then there is nothing to click
            another.click(timeout=5000)
        except PWTimeout:
            pass
    slow_ai.delay = 0.0
    dlg.get_by_role("button", name="⚡ Start — let the AI choose everything").click()
    dlg.locator(".mb-done").wait_for(timeout=60000)
    assert dlg.locator(".mb-done .downloads button").count() == 3
    assert_clean(page, "make a book")
