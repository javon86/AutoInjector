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
    # 🧭 the checkpoint report and 📒 the story so far (story_ledger.py, checkpoints.py)
    cp = page.locator("[data-testid=cont-checkpoints]")
    assert cp.count() == 1 and "Final check of the whole book after chapter 3" in cp.inner_text()
    assert page.locator("[data-testid=cont-story]").count() == 1
    assert "Chapter 1:" in page.inner_text("[data-testid=cont-story]")
    page.get_by_role("button", name="⚡ Quick read (no AI)").click()
    page.wait_for_function("() => /Akọwe read/.test(document.body.textContent)", timeout=10000)
    assert not bad_text(page, "#main"), bad_text(page, "#main")
    assert overflow(page) <= 1
    assert not unnamed_controls(page), unnamed_controls(page)
    # final sweep: "Save readings" with nothing written says what to do (it used to send an empty list -> HTTP 400)
    rd = page.locator("[data-testid=cont-readings]")
    for t in rd.locator("textarea").all():
        t.fill("")
    rd.get_by_role("button", name="Save readings").click()
    page.wait_for_function("() => /Nothing to save yet/.test(document.body.textContent)", timeout=5000)
    goto(page, f"#/p/{pid}/main/book")
    assert_clean(page, "continuity page")


def test_profile_sets_how_often_the_whole_story_is_checked(make_context, ai_server):
    """🧭 "Check the whole story every N chapters" in 📝 Book profile: plain choices, default every 5, saved."""
    from .test_ui_followthrough import autobook
    from .ui_helpers import shot
    pid = autobook(ai_server)
    page = open_app(make_context(), ai_server, f"#/p/{pid}/main/book")
    page.get_by_role("button", name="📝 Book profile").click()
    dlg = page.locator("dialog[open]")
    sel = dlg.locator("[data-testid=profile-checkpoint-every]")
    assert "Every 5 chapters (default)" in sel.locator("option").all_inner_texts()
    assert dlg.get_by_label("Check the whole story every N chapters").count() == 1
    sel.select_option("3")
    dlg.get_by_role("button", name="Save profile").click()
    page.locator("#toast:not([hidden])").wait_for(timeout=5000)
    assert ai_server.api("GET", f"/projects/{pid}/profile")["checkpoint_every"] == 3
    shot(page, "profile-checkpoint-every")
    goto(page, f"#/p/{pid}/main/continuity")
    page.locator("[data-testid=cont-checkpoints]").wait_for(timeout=10000)
    assert "every 3 chapters" in page.inner_text("[data-testid=cont-checkpoints]")
    assert_clean(page, "checkpoint setting")
