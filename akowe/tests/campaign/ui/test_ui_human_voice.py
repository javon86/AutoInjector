"""✍ How Akọwe keeps the book sounding human, in the browser: the Make-a-book switch for the end-of-book pass (on by
default; only "off" is sent), the 🔎 check-now box showing the "Sounds like a person" score, each AI's reasons with
quotes and Akọwe's own repeats across chapters, and 🏠 Book home's line after a ⚡ run."""
from __future__ import annotations

import json

from .ui_helpers import assert_clean, open_app, open_make_book


def test_make_a_book_screen_has_the_end_pass_switch(make_context, ai_server):
    page = open_app(make_context(), ai_server)
    open_make_book(page)
    dlg = page.locator("#mab-dialog")
    box = dlg.locator("[data-testid=mb-human-pass]")
    box.wait_for(timeout=10000)
    assert box.is_checked()
    assert dlg.get_by_label("At the end, check that the book sounds like a person wrote it").count() == 1
    hint = dlg.locator("#mb-human-pass-hint").inner_text()
    assert "Nothing changes until you approve" in hint and "up to 20" in hint
    box.uncheck()
    page.route("**/api/autobook", lambda route: route.fulfill(status=400, content_type="application/json",
                                                               body=json.dumps({"errors": [{"code": "INVALID_INPUT",
                                                                                            "path": "/x",
                                                                                            "message": "test stop"}]}))
               if route.request.method == "POST" else route.continue_())
    with page.expect_request(lambda r: r.url.endswith("/api/autobook") and r.method == "POST", timeout=20000) as req:
        dlg.locator("[data-testid=mb-start]").click()
    assert json.loads(req.value.post_data or "{}").get("human_pass") is False
    page.wait_for_timeout(300)
    page.bf_problems.clear()  # the stopped start is the test's own doing
    assert_clean(page, "make-a-book human pass")


STATUS = {
    "request": {"id": "now-x", "status": "done", "label": "chapters 1–5", "cp_id": "now-x"}, "state": "done",
    "can_start": True, "why_not": None, "chapters": 5, "in_run": False, "last": 5, "markdown": "",
    "latest": {"id": "now-x", "line": "🔎 Consistency check (chapters 1–5): nothing to fix", "problems": [],
               "stretch": {"title": "Chapters 1–5 review", "readers": ["Claude", "Gemini"], "agree": [],
                           "scores": [{"key": "human", "label": "Sounds like a person", "average": 6, "low": 5,
                                       "high": 7, "agree": True, "by": {"Claude": 5, "Gemini": 7}}],
                           "views": [{"name": "Claude", "human": "The same jaw-clench in every chapter.",
                                      "human_quotes": ["Her jaw tightened."], "pacing": "It moves."},
                                     {"name": "Gemini", "human": "", "human_quotes": [], "pacing": "Fine."}],
                           "repeats": [{"id": "rp1", "message": "“jaw tightened” 5× in chapters 1, 2 and 4.",
                                        "status": "confirmed", "examples": [{"chapter": 2, "quote": "Her jaw tightened."}]},
                                       {"id": "rp2", "message": "3 chapters open with the weather (chapters 1, 3 and 5).",
                                        "status": "rejected", "examples": []}]}}}


def test_check_now_shows_the_person_score_reasons_and_repeats(make_context, ai_server):
    pid = ai_server.api("POST", "/projects", {"name": "Human Voice Book", "profile": {"title": "Human Voice Book"}})[
        "project_id"]
    ctx = make_context()
    page = open_app(ctx, ai_server)
    page.route("**/review/continuity/check-now", lambda route: route.fulfill(
        status=200, content_type="application/json", body=json.dumps(STATUS)) if route.request.method == "GET"
        else route.continue_())
    from .ui_helpers import goto
    goto(page, f"#/p/{pid}/main/continuity")
    box = page.locator("[data-testid=cont-check-now-box]")
    box.wait_for(timeout=20000)
    page.locator("[data-testid=cont-check-now-review]").wait_for(timeout=10000)
    page.locator("[data-testid=cont-check-now-review] summary").click()
    rev = page.locator("[data-testid=cont-check-now-review]").inner_text()
    assert "Sounds like a person: 6/10" in rev and "Claude 5" in rev
    human = page.locator("[data-testid=cont-check-now-human]").inner_text()
    assert "The same jaw-clench in every chapter." in human and "“Her jaw tightened.”" in human
    assert "Gemini" not in human  # an AI with nothing to say is left out
    reps = page.locator("[data-testid=cont-check-now-repeats]")
    txt = reps.inner_text()
    assert "Repeated across chapters" in txt and "jaw tightened" in txt and "the AIs agree a reader would notice" in txt
    assert "the AIs think it is fine" in txt and "(chapter 2)" in txt
    assert reps.locator("li[data-status=rejected]").count() == 1
    assert_clean(page, "check now: sounds like a person")


def test_book_home_shows_the_sounds_like_a_person_line_after_a_run(make_context, ai_server):
    from .test_ui_followthrough import autobook
    pid = autobook(ai_server)
    book = ai_server.api("GET", f"/projects/{pid}/branches/main/book")
    hv = book.get("human_voice")
    assert hv and hv["line"].startswith("✍ Sounds like a person:"), hv
    page = open_app(make_context(), ai_server, f"#/p/{pid}/main/book")
    line = page.locator("[data-testid=home-human-voice]")
    line.wait_for(timeout=20000)
    assert line.inner_text().startswith("✍ Sounds like a person:")
    assert_clean(page, "book home: sounds like a person")
