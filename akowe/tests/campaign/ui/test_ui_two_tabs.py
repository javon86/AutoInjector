"""Two tabs on the same book: an edit saved in one tab must not be silently overwritten by a stale tab; the other tab
sees the change (after its own refresh) and the stale save gets a clear conflict message."""
from __future__ import annotations

import json
import time

import pytest

from .ui_helpers import goto, open_app, settle, shot


@pytest.fixture(scope="module")
def book(ai_server):
    r = ai_server.api("POST", "/autobook", {"author_confirms": True})
    for _ in range(300):
        s = ai_server.api("GET", "/autobook/" + r["id"])
        if s["status"] not in ("queued", "running", "pausing"):
            break
        time.sleep(0.2)
    assert s["status"] == "done", s
    return s["project_id"]


def first_text_field(page):
    """The first visible, empty-able text area of the edit form (a prose field of the record)."""
    loc = page.locator("#main form textarea:visible")
    assert loc.count(), "no textarea on the edit page"
    return loc.first


def save(page):
    page.locator("#main form button[type=submit]").first.click()
    page.wait_for_function("""() => { const b = document.querySelector('#main form button[type=submit]');
        return b && !b.disabled; }""", timeout=15000)
    settle(page, 500)


def test_stale_tab_cannot_silently_overwrite(browser, ai_server, book):
    pid = book
    recs = ai_server.api("GET", f"/projects/{pid}/branches/main/records")
    rec = next(r for r in recs if r["module_id"] == "A01")
    rid = rec["record_id"]
    route = f"#/p/{pid}/main/edit/{rid}"
    ctx = browser.new_context(viewport={"width": 1366, "height": 900})   # two tabs of one browser profile
    try:
        a = open_app(ctx, ai_server, route)
        b = ctx.new_page()
        from .ui_helpers import watch
        watch(b)
        b.goto(ai_server.base + "#" + route[1:])
        b.wait_for_selector("#main form textarea", timeout=15000)
        settle(b)
        fa, fb = first_text_field(a), first_text_field(b)
        orig = fa.input_value()
        fa.fill(orig + " EDIT-FROM-TAB-A")
        save(a)
        head = ai_server.api("GET", f"/projects/{pid}/branches/main/records/{rid}")
        latest = head["versions"][-1]
        assert latest["version"] == rec["version"] + 1, "tab A's save did not make a new revision"
        assert "EDIT-FROM-TAB-A" in json.dumps(latest["data"])

        # tab B still shows v1 and saves its own change on top of it
        fb.fill(orig + " EDIT-FROM-TAB-B")
        save(b)
        head = ai_server.api("GET", f"/projects/{pid}/branches/main/records/{rid}")
        versions = head["versions"]
        if len(versions) != 2 or "EDIT-FROM-TAB-A" not in json.dumps(versions[-1]["data"]):
            shot(b, "two_tabs_stale_overwrite")
        assert [v["version"] for v in versions] == [1, 2], "the stale tab saved on top of the newer revision"
        assert "EDIT-FROM-TAB-A" in json.dumps(versions[-1]["data"])
        problem = b.locator("#main .error-summary, #main [role=alert]").first
        problem.wait_for(timeout=5000)
        assert "v2" in problem.inner_text() or "newer" in problem.inner_text().lower(), problem.inner_text()
        # tab B keeps the typed text (nothing lost), and a reload offers the draft as based on an older version
        assert "EDIT-FROM-TAB-B" in fb.input_value()
        b.reload()
        b.wait_for_selector("#main form textarea", timeout=15000)
        settle(b)
        assert "based on v1" in b.inner_text("#main"), "the reloaded stale tab does not say its draft is outdated"
    finally:
        ctx.close()


def test_other_tab_follows_approvals(browser, ai_server, book):
    """Tab B shows the book page; the format is redone and approved in tab A (the API here). Tab B's approvals
    count follows within its 10 s refresh, and pressing B's now outdated "Do the next step" (approve) does not
    fail or approve anything twice."""
    pid = book
    base = f"/projects/{pid}/branches/main"
    ai_server.api("POST", base + "/book/setup_format", {})
    ctx = browser.new_context(viewport={"width": 1366, "height": 900})
    try:
        b = open_app(ctx, ai_server, f"#/p/{pid}/main/book")
        q = ai_server.api("GET", base + "/review/summary")
        assert q["count"] >= 1
        b.wait_for_function("n => (document.querySelector('#nav-task .count-badge') || {}).textContent === '(' + n + ')'",
                            arg=q["count"], timeout=12000)
        nxt = b.locator("#main .book-top button", has_text="Do the next step")
        assert "Book format" in nxt.inner_text()
        bk = ai_server.api("GET", base + "/book")
        ids = [i["record_id"] for s in bk["steps"] if s["id"] == "format" for i in s.get("approve") or []]
        assert ids
        out = ai_server.api("POST", base + "/review/approve", {"record_ids": ids, "author_confirms": True})
        assert out.get("approved") or "Approved" in json.dumps(out)
        b.evaluate("() => document.dispatchEvent(new Event('visibilitychange'))")   # the author switches back to tab B
        q2 = ai_server.api("GET", base + "/review/summary")
        assert q2["count"] < q["count"], (q, q2)
        b.wait_for_function("n => (document.querySelector('#nav-task .count-badge') || {}).textContent === '(' + n + ')'",
                            arg=q2["count"], timeout=5000)
        nxt.click()
        b.wait_for_timeout(300)
        yes = b.get_by_role("button", name="✔ Yes, I approve")
        if yes.count():
            yes.click()
        b.wait_for_function("() => { const m = document.querySelector('#main .book-msg'); return m && !m.querySelector('.state.loading'); }",
                            timeout=15000)
        settle(b, 400)
        msg = b.inner_text("#main .book-msg")
        if "Failed" in msg or "did not work" in msg:
            shot(b, "two_tabs_double_approve")
        assert "Failed" not in msg and "did not work" not in msg, msg
        bk2 = ai_server.api("GET", base + "/book")
        assert bk2["done_count"] == bk2["total"]
        assert "Your book is made" in b.inner_text("#main .book-top")
    finally:
        ctx.close()
