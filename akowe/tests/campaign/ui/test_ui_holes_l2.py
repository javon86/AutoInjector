"""H6 / H14 in the browser: with only one AI working the ⚡ run stops at its first draft and asks the author in plain
words ("Only Claude is working, so nobody else checked this …"); "✔ Approve it myself" offers "this one" or "this and
the rest of the run"; afterwards 🏠 Book home lists the drafts approved without a second check."""
from __future__ import annotations

import time

import pytest

from .ui_helpers import Server, assert_clean, goto, open_app, open_make_book, settle, shot


def wait_status(server, run_id, statuses, timeout=60):
    t0 = time.time()
    r = {}
    while time.time() - t0 < timeout:
        r = server.api("GET", f"/autobook/{run_id}")
        if r["status"] in statuses and not r.get("alive"):
            return r
        time.sleep(0.2)
    raise AssertionError(f"run {run_id} not in {statuses}: {r.get('status')} {r.get('problem')}")


@pytest.fixture(scope="module")
def one_ai_server(tmp_path_factory, bridge):
    s = Server(tmp_path_factory.mktemp("bfui-l2") / "data", bridge)
    s.api("PUT", "/slots/AI-2", {"adapter_id": "none"})   # only AI-1 (Claude through AutoInjector) works
    s.api("PUT", "/slots/AI-3", {"adapter_id": "none"})
    yield s
    s.close()


def test_one_ai_asks_the_author_and_book_home_lists_what_was_not_checked(make_context, one_ai_server):
    s = one_ai_server
    r = s.api("POST", "/autobook", {"author_confirms": True, "length": "short_story", "pictures": False})
    run = wait_status(s, r["id"], ("paused",))
    assert run["problem"]["code"] == "NO_SECOND_AI", run["problem"]
    page = open_app(make_context(), s)
    open_make_book(page)
    dlg = page.locator("#mab-dialog")
    dlg.get_by_text("Only Claude is working, so nobody else checked this").first.wait_for(timeout=10000)
    dlg.get_by_role("button", name="✔ Approve it myself").click()
    ask = page.locator("dialog[open]", has_text="Approve it yourself?")
    ask.wait_for(timeout=5000)
    assert "approve it yourself, or wait for another AI" in ask.inner_text()
    shot(page, "l2-one-ai-decision")
    ask.get_by_role("button", name="✔ Approve this and trust this AI for the rest of the run").click()
    done = wait_status(s, r["id"], ("done",), 180)
    pid = done["project_id"]
    page.keyboard.press("Escape")
    goto(page, f"#/p/{pid}/main/book")
    settle(page)
    box = page.locator("[data-testid=book-attention]")
    box.wait_for(timeout=10000)
    assert "approved without checks" in box.inner_text()
    shot(page, "l2-book-home-needs-a-look")
    assert_clean(page, "book home")
