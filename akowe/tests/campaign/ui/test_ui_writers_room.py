"""🗳 The three-AI writers' room in the browser: opened from 🏠 Book home, on the main plot it shows each AI's pitch
(revealed after the blind vote), the votes with their reasons and the winner; ✔ Use the winner saves a NEW draft of the
main plot (the approved one stays), 🔁 Another round meets again; the ⚡ Make-a-book window has the switch "Use the
writers' room for the big twists", off by default. Screenshots go to $BF_UI_SHOTS."""
from __future__ import annotations

import json

from .test_ui_followthrough import autobook
from .ui_helpers import assert_clean, open_app, open_make_book, overflow, shot, unnamed_controls

PITCH = {"title", "idea", "why_it_fits", "changes_later"}


def _room_answers(bridge):
    """The session's fake AI answers the room's pitches and votes (every voter puts Claude's pitch first, Claude
    itself ChatGPT's). Returns the undo."""
    ai = bridge.ai
    orig = ai.submit

    def submit(slot, system, user, schema):
        props = set(schema.get("properties") or {})
        site = slot.get("slot_id") or "?"
        usage = {"model": "fake", "input_tokens": 1, "output_tokens": 1}
        if props == PITCH:
            return {"title": f"The {site} twist", "idea": f"The keeper is alive ({site}); she hid on the reef for "
                    "years.", "why_it_fits": "It fits the dark lighthouse.",
                    "changes_later": "Mara must choose between her and the town."}, usage
        if props == {"ranking"}:
            ctx = json.loads(user.split("\n", 1)[1]).get("context") or {}
            pref = ["chatgpt", "claude", "gemini"] if site == "claude" else ["claude", "chatgpt", "gemini"]
            ps = sorted(ctx.get("pitches") or [], key=lambda p: next((i for i, s in enumerate(pref)
                                                                     if s in p["title"]), 9))
            return {"ranking": [{"pitch": p["letter"], "reason": f"{site} thinks it surprises"} for p in ps]}, usage
        return orig(slot, system, user, schema)
    ai.submit = submit
    return lambda: ai.__dict__.pop("submit", None)


def test_writers_room_on_the_plot_and_the_make_a_book_switch(make_context, ai_server, bridge):
    pid = autobook(ai_server)
    undo = _room_answers(bridge)
    try:
        ctx = make_context()
        page = open_app(ctx, ai_server, f"#/p/{pid}/main/book")
        page.click("[data-testid=room-open]")
        dlg = page.locator("dialog[open]")
        dlg.locator("[data-testid=room-start]").wait_for(timeout=10000)
        assert dlg.locator("[data-testid=room-t-plot]").is_checked()
        assert "In the room:" in dlg.locator("[data-testid=room-ais]").inner_text()
        assert not unnamed_controls(page)
        dlg.locator("[data-testid=room-start]").click()
        dlg.locator("[data-testid=room-winner]").wait_for(timeout=60000)
        cards = dlg.locator(".wr-pitch")
        assert cards.count() == 3
        win = dlg.locator("[data-testid=room-winner]").inner_text()
        assert "The winner: pitch" in win and "claude twist" in win.lower(), win
        text = dlg.locator(".wr-pitches").inner_text()
        assert "How the others ranked it" in text and "thinks it surprises" in text and "1st" in text
        assert "Why it fits" in text and "What it changes later" in text
        shot(page, "writers-room-results")
        letter = page.locator(".wr-pitch.wr-win").get_attribute("data-letter")
        recs = ai_server.api("GET", f"/projects/{pid}/branches/main/records")
        before = [r for r in (recs.get("records", recs) if isinstance(recs, dict) else recs)
                  if r["module_id"] == "B03" and r.get("approved_version")][0]
        dlg.locator(f"[data-testid=room-use-{letter}]").click()
        used = dlg.locator("[data-testid=room-used]")
        used.wait_for(timeout=15000)
        assert "new draft" in used.inner_text() and "approved version stays" in used.inner_text()
        hist = ai_server.api("GET", f"/projects/{pid}/branches/main/records/{before['record_id']}")
        vers = hist.get("versions") or []
        assert vers[-1]["version"] == before["version"] + 1 and vers[-1]["lifecycle"] in ("DRAFT", "VALIDATED")
        assert "From the writers' room" in json.dumps(vers[-1].get("data"))
        dlg.locator("[data-testid=room-again]").click()
        dlg.locator("[data-testid=room-winner]").wait_for(timeout=60000)
        assert "round 2" in dlg.inner_text()
        assert overflow(page) <= 0
        assert_clean(page, "writers' room")
        page.keyboard.press("Escape")
    finally:
        undo()
    # ⚡ Make a book: the switch, off by default
    page = open_app(make_context(), ai_server)
    open_make_book(page)
    box = page.locator("#mab-dialog [data-testid=mb-room]")
    box.wait_for(timeout=10000)
    assert not box.is_checked()
    assert "big twists" in page.inner_text("#mab-dialog")
    shot(page, "writers-room-make-a-book")
    page.keyboard.press("Escape")
    assert_clean(page, "make a book")
