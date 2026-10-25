"""🧭 Section 7 (P32–P35): the Continuity page in the browser after a fake-AI book — every chapter card, the checks,
the variables, the two-readings card; ⚡ Quick read (no AI) works; no console errors, no overflow, named controls."""
from __future__ import annotations

import time

from .ui_helpers import assert_clean, bad_text, goto, open_app, overflow, unnamed_controls


def test_continuity_page_after_a_book(make_context, ai_server):
    r = ai_server.api("POST", "/autobook", {"author_confirms": True, "length": "short_story"})
    t0 = time.time()
    while time.time() - t0 < 120:
        run = ai_server.api("GET", f"/autobook/{r['id']}")
        if run["status"] in ("done", "failed", "cancelled", "paused") and not run.get("alive"):
            break
        time.sleep(0.3)
    assert run["status"] == "done", run.get("problem")
    pid = run["project_id"]
    page = open_app(make_context(), ai_server, f"#/p/{pid}/main/continuity")
    assert page.inner_text("#main h1").startswith("🧭 Continuity")
    data = ai_server.api("GET", f"/projects/{pid}/branches/main/review/continuity")
    for row in data["chapters"]:
        assert page.locator(f"[data-testid=cont-ch-{row['chapter_id']}]").count() == 1
    assert page.locator("[data-testid=cont-checks]").count() == 1
    assert page.locator("[data-testid=cont-readings]").count() == 1
    page.get_by_role("button", name="⚡ Quick read (no AI)").click()
    page.wait_for_function("() => /Akọwe read/.test(document.body.textContent)", timeout=10000)
    assert not bad_text(page, "#main"), bad_text(page, "#main")
    assert overflow(page) <= 1
    assert not unnamed_controls(page), unnamed_controls(page)
    goto(page, f"#/p/{pid}/main/book")
    assert_clean(page, "continuity page")
