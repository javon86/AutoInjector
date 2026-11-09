"""🔁 / 🔔 In the browser: when the AI reviewer and the writer go round in circles, the ⚡ run window shows ONE decision
card — the category with its icon, what it is about, what is wrong, before → after, why it stopped, what happens
next — and the card's own buttons decide it (✔ Accept change carries the book on). The top-bar chip names the
category too. At 1366x900 and at phone width."""
from __future__ import annotations

import time

import pytest

from .ui_helpers import assert_clean, open_app

SAME = {"verdict": "REVISE", "confidence": 0.9,
        "reasons": ["Its background contradicts the approved family timeline about the father's drowning and the "
                    "wake."],
        "suggested_changes": ["Move the private memory of the wake so it agrees with the family timeline of the "
                              "father's drowning."]}


def wait_stopped(server, run_id, timeout=90):
    s = None
    for _ in range(int(timeout / 0.2)):
        s = server.api("GET", "/autobook/" + run_id)
        if s["status"] not in ("queued", "running", "pausing", "waiting") and not s.get("alive"):
            return s
        time.sleep(0.2)
    raise AssertionError(f"the run did not stop: {s and s['status']}")


@pytest.mark.parametrize("size", [(1366, 900), (390, 844)], ids=["desktop", "phone"])
def test_the_decision_card_explains_and_decides(make_context, ai_server, bridge, size):
    bridge.ai.verdicts = [dict(SAME), dict(SAME)]  # the first record reviewed: the same finding twice
    try:
        r = ai_server.api("POST", "/autobook", {"author_confirms": True, "pictures": False})
        s = wait_stopped(ai_server, r["id"])
    finally:
        bridge.ai.verdicts = []
    try:
        assert s["status"] == "paused" and s["problem"]["code"] == "REVIEW_DECISION", (s["status"], s.get("problem"))
        a = s["alert"]
        page = open_app(make_context(*size), ai_server)
        page.wait_for_function("() => /AI needs you/.test(document.querySelector('#mab-btn').textContent)",
                               timeout=10000)
        chip = page.inner_text("#mab-btn")
        assert a["label"] in chip and a["icon"] in chip, chip
        page.click("#mab-btn")
        card = page.locator("#mab-dialog [data-testid=mb-decision]")
        card.wait_for(timeout=10000)
        assert page.inner_text("#mab-dialog [data-testid=mb-alert-label]") == a["label"]
        assert page.inner_text("#mab-dialog [data-testid=mb-alert-what]") == a["what"]
        assert "family timeline" in page.inner_text("#mab-dialog [data-testid=mb-alert-wrong]")
        change = page.inner_text("#mab-dialog [data-testid=mb-alert-change]")
        assert "Before:" in change and "After:" in change
        assert "disagreed twice" in page.inner_text("#mab-dialog [data-testid=mb-alert-why]")
        assert "accept the change, keep the original" in page.inner_text("#mab-dialog [data-testid=mb-alert-next]")
        for tid in ("mb-accept-change", "mb-keep-original", "mb-edit-it", "mb-edited"):
            assert card.locator(f"[data-testid={tid}]").is_visible(), tid
        # the card fits the window (no sideways scrolling on a phone)
        box = card.bounding_box()
        assert box and box["x"] >= 0 and box["x"] + box["width"] <= size[0] + 1, box
        card.locator("[data-testid=mb-accept-change]").click()
        page.wait_for_function("() => !document.querySelector('#mab-dialog [data-testid=mb-decision]')", timeout=15000)
        s = ai_server.api("GET", "/autobook/" + r["id"])
        assert s["status"] in ("running", "waiting", "done") or s.get("alive"), s["status"]
        assert any(e.get("code") == "CHANGE_ACCEPTED" for e in s["events"]), "the choice was not recorded"
        assert_clean(page, "decision card")
    finally:
        ai_server.api("POST", f"/autobook/{r['id']}/cancel", {})
        wait_stopped(ai_server, r["id"])
