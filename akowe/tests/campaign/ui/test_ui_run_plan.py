"""⚡ Make a book — planning before the start, in the browser: ⏱ the estimate box follows the options (time range,
answers per AI, usage-limit warnings), 📊 the usage meter per AI, ⏰ Start at… (countdown, the top-bar chip, Cancel)
and 📋 Paste starter sheet (summary first, then every field is filled; the lock list and a too-long idea)."""
from __future__ import annotations

import json

from .ui_helpers import assert_clean, open_app, open_make_book, overflow, shot

SHEET = """Sure! Here is your plan.

```
AKỌWE STARTER SHEET
**1. YOUR IDEA**
▶ A lighthouse keeper's daughter finds a drowned man who keeps waking up at low tide.
**2. GENRE:** Gothic mystery
3. LENGTH: Short story / Novelette / ▶ Novella / Novel
4. ENDING: ▶ Bittersweet (she saves the town but loses him)
5. HOW MUCH IS EXPLAINED: Hint
6. DARKNESS AND PERIL: Some danger
7. DIALOGUE: Lots
8. PACE: Fast
9. HUMOR: None
10. HOW THE STORY TREATS THE CHARACTERS: Character-led
11. STORY SHAPE: Save the Cat
12. KIND OF STORY: Voyage and Return
13. RUN OPTIONS
- Character pictures: Off
- Fill the whole Book Bible: On
- AIs checking for mistakes: Two
- Writers' room: On
- Beta readers: 2
- When only one AI works: Ask me
14. LOCK LIST
- The drowned man is never named.
- Mara is left-handed.
```
Let me know if you want changes!
"""


def _no_start(page):
    """Stop the real start (the test only looks at what would be sent)."""
    page.route("**/api/autobook", lambda route: route.fulfill(
        status=400, content_type="application/json",
        body=json.dumps({"errors": [{"code": "INVALID_INPUT", "path": "/x", "message": "test stop"}]}))
        if route.request.method == "POST" else route.continue_())


def test_estimate_box_and_usage_meter_follow_the_options(make_context, ai_server):
    page = open_app(make_context(), ai_server)
    open_make_book(page)
    dlg = page.locator("#mab-dialog")
    est = dlg.locator("[data-testid=mb-estimate]")
    est.filter(has_text="Estimate:").wait_for(timeout=15000)
    assert "AI answers" in est.inner_text() and "It is an estimate" in est.inner_text()
    ais = est.locator("[data-testid=mb-est-ais] li")
    assert ais.count() == 3
    text_all = est.inner_text()
    dlg.locator("#mb-checkers").select_option("one")
    page.wait_for_function("t => document.querySelector('[data-testid=mb-estimate]').innerText !== t", arg=text_all,
                           timeout=10000)
    assert est.inner_text() != text_all  # fewer checkers: fewer answers
    dlg.locator("#mb-checkers").select_option("all")
    dlg.locator("#mb-len-novel").check()
    lim = est.locator("[data-testid=mb-est-limits]")
    lim.filter(has_text="Usage limits").wait_for(timeout=10000)
    assert "Claude will probably" in lim.inner_text() and "chapter" in lim.inner_text()
    assert "25 chapters" in est.inner_text()
    # 📊 the usage meter: one row per AI with a colour and "used today"
    meter = dlg.locator("[data-testid=usage-meter]")
    meter.locator("[data-testid=um-row]").first.wait_for(timeout=10000)
    rows = meter.locator("[data-testid=um-row]")
    assert rows.count() >= 3
    assert "used today:" in rows.first.inner_text()
    assert rows.first.get_attribute("data-colour") in ("green", "amber", "red", "grey")
    assert "do not publish exact limits" in meter.inner_text()
    dlg.locator("#mb-len-short_story").check()
    shot(page, "run-plan-estimate")
    assert_clean(page, "estimate and meter")


def test_start_at_schedules_counts_down_and_cancels(make_context, ai_server):
    page = open_app(make_context(), ai_server)
    open_make_book(page)
    dlg = page.locator("#mab-dialog")
    dlg.locator("[data-testid=mb-later-on]").wait_for(timeout=10000)
    later = page.evaluate("() => { const d = new Date(Date.now() + 2 * 3600 * 1000); "
                          "return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }")
    dlg.locator("[data-testid=mb-later-on]").check()
    dlg.locator("#mb-start-at").fill(later)
    start = dlg.locator("[data-testid=mb-start]")
    assert start.inner_text().startswith("⏰ Schedule for")
    start.click()
    box = dlg.locator("[data-testid=mb-scheduled]")
    box.wait_for(timeout=15000)
    assert box.get_attribute("data-state") == "waiting"
    cd = box.locator("[data-testid=mb-countdown]")
    first = cd.inner_text()
    assert " h " in first or "min" in first
    page.wait_for_function("t => document.querySelector('[data-testid=mb-countdown]').innerText !== t", arg=first,
                           timeout=70000)  # it ticks
    assert "PC awake" in box.inner_text()
    assert ai_server.api("GET", "/autobook/schedule")["state"] == "waiting"
    # close: the top-bar chip says when it starts; it opens the countdown again
    dlg.get_by_role("button", name="Close (the run keeps going in the background)").click()
    chip = page.locator("#mab-btn")
    chip.filter(has_text="Book starts").wait_for(timeout=10000)
    chip.click()
    box.wait_for(timeout=10000)
    if overflow(page) > 0:
        raise AssertionError("sideways scroll in the scheduled view")
    box.locator("[data-testid=mb-sched-cancel]").click()
    dlg.locator("[data-testid=mb-start]").wait_for(timeout=10000)  # back to the setup
    assert ai_server.api("GET", "/autobook/schedule")["state"] == "cancelled"
    assert not ai_server.api("GET", "/autobook").get("active")
    dlg.get_by_role("button", name="Close (the run keeps going in the background)").click()
    page.wait_for_function("() => document.querySelector('#mab-btn').hidden", timeout=10000)
    assert_clean(page, "start later")


def test_paste_starter_sheet_shows_a_summary_then_fills_every_field(make_context, ai_server):
    page = open_app(make_context(), ai_server)
    open_make_book(page)
    dlg = page.locator("#mab-dialog")
    dlg.locator("[data-testid=mb-paste]").click()
    pd = page.locator("[data-testid=paste-dialog]")
    pd.wait_for(timeout=10000)
    pd.locator("[data-testid=mb-paste-read]").click()  # nothing pasted yet: a plain message
    pd.get_by_text("Paste the AI’s answer first.").wait_for(timeout=5000)
    pd.locator("[data-testid=mb-paste-text]").fill(SHEET)
    pd.locator("[data-testid=mb-paste-read]").click()
    summary = pd.locator("[data-testid=mb-paste-summary]")
    summary.wait_for(timeout=10000)
    st = summary.inner_text()
    assert "Akọwe understood" in st and "Genre: Gothic mystery" in st and "Lock list" in st
    assert "Writers' room: On" in st and "Beta readers: 2" in st
    assert "Story rules" in summary.locator("[data-testid=mb-paste-locks]").inner_text()
    # nothing changed in the form before ✔ Fill the form
    assert dlg.locator("#mb-genre").input_value() == ""
    pd.locator("[data-testid=mb-paste-apply]").click()
    pd.wait_for(state="detached", timeout=5000)
    assert dlg.locator("#mb-genre").input_value() == "Gothic mystery"
    assert dlg.locator("#mb-idea").input_value().startswith("A lighthouse keeper's daughter")
    assert dlg.locator("#mb-len-novella").is_checked()
    for sel, val in (("#mb-ch-ending", "bittersweet"), ("#mb-ch-explain", "hint"), ("#mb-ch-darkness", "some"),
                     ("#mb-ch-dialogue", "lots"), ("#mb-ch-pace", "fast"), ("#mb-ch-humor", "none"),
                     ("#mb-ch-characters", "character_led"), ("#mb-ch-shape", "save_the_cat"),
                     ("#mb-ch-kind", "voyage_return"), ("#mb-checkers", "two"), ("#mb-single-ai", "ask"),
                     ("#mb-beta-n", "2")):
        assert dlg.locator(sel).input_value() == val, sel
    assert dlg.locator("#mb-room").is_checked() and dlg.locator("#mb-beta").is_checked()
    assert dlg.locator("#mb-fill-bible").is_checked() and not dlg.locator("#mb-pictures").is_checked()
    locks = dlg.locator("[data-testid=mb-locks]")
    assert "Mara is left-handed." in locks.inner_text() and "Story rules" in locks.inner_text()
    # what Start would send: the choices, the run options and the lock list
    _no_start(page)
    with page.expect_request(lambda r: r.url.endswith("/api/autobook") and r.method == "POST", timeout=20000) as req:
        dlg.locator("[data-testid=mb-start]").click()
    body = json.loads(req.value.post_data or "{}")
    assert body["locks"] == ["The drowned man is never named.", "Mara is left-handed."]
    assert body["choices"]["ending"] == "bittersweet" and body["length"] == "novella" and body["checkers"] == "two"
    assert body["writers_room"] is True and body["beta_readers"] == 2 and body["fill_bible"] is True
    assert body["single_ai"] == "ask" and body["pictures"] is False
    page.wait_for_timeout(300)
    page.bf_problems.clear()  # the stopped start is the test's own doing
    shot(page, "run-plan-paste")
    assert_clean(page, "paste starter sheet")


def test_paste_a_too_long_idea_offers_to_trim(make_context, ai_server):
    page = open_app(make_context(), ai_server)
    open_make_book(page)
    dlg = page.locator("#mab-dialog")
    idea = " ".join(f"Sentence {i} of a very long idea about a ferry." for i in range(60))
    text = f"AKOWE STARTER SHEET\n1. YOUR IDEA\n{idea}\n2. GENRE: Fable\n8. PACE: so-so\n"
    dlg.locator("[data-testid=mb-paste]").click()
    pd = page.locator("[data-testid=paste-dialog]")
    pd.locator("[data-testid=mb-paste-text]").fill(text)
    pd.locator("[data-testid=mb-paste-read]").click()
    trim = pd.locator("[data-testid=mb-paste-trim-idea]")
    trim.wait_for(timeout=10000)
    assert trim.is_checked()
    assert "Not understood" in pd.inner_text() and "so-so" in pd.inner_text()
    pd.locator("[data-testid=mb-paste-apply]").click()
    v = dlg.locator("#mb-idea").input_value()
    assert 1000 < len(v) <= 2000 and v.endswith(".")
    assert dlg.locator("[data-testid=mb-idea-long]").is_hidden()
    assert_clean(page, "paste too long")
