"""🧭 The short guided tour of My books (web/tour.js): it never opens by itself under automation (so the other UI tests
are not interrupted); forced, it opens on My books with one sentence per step, steps through Next to Done, does not
come back after Done (remembered in localStorage), and ❓ Help → 🧭 Take the tour plays it again. Fits at 1280×720."""
from __future__ import annotations

from .ui_helpers import goto, open_app, settle


def test_tour_not_by_itself_under_automation(make_context, server):
    page = open_app(make_context(1280, 720), server)
    page.wait_for_timeout(900)
    assert page.locator('[data-testid="tour"]').count() == 0, "the tour must not open by itself under automation"


def test_tour_steps_through_and_stays_away_after_done(make_context, server):
    ctx = make_context(1280, 720)
    ctx.add_init_script("try { localStorage.setItem('akowe:tour-force', '1'); } catch (e) {}")
    page = open_app(ctx, server)
    page.wait_for_selector('[data-testid="tour"]', timeout=5000)
    texts = []
    for _ in range(8):
        texts.append(page.locator('[data-testid="tour-text"]').inner_text())
        tip = page.locator('#ak-tour .ak-tour-tip').bounding_box()
        assert tip and tip["x"] >= 0 and tip["x"] + tip["width"] <= 1280 and tip["y"] + tip["height"] <= 720, f"the bubble fits: {tip}"
        if page.locator('[data-testid="tour-done"]').count():
            page.click('[data-testid="tour-done"]')
            break
        page.click('[data-testid="tour-next"]')
    assert 3 <= len(texts) <= 5 and texts[0].startswith("📚 My books"), texts
    assert page.locator('[data-testid="tour"]').count() == 0
    assert page.evaluate("localStorage.getItem('akowe:tour-seen')") == "1"
    goto(page, "#/settings")
    goto(page, "#/")
    page.wait_for_timeout(800)
    assert page.locator('[data-testid="tour"]').count() == 0, "after Done it does not come back"
    # ❓ Help → 🧭 Take the tour plays it again
    goto(page, "#/help")
    page.click('[data-testid="help-tour"]')
    page.wait_for_selector('[data-testid="tour"]', timeout=5000)
    settle(page)
    assert page.locator('[data-testid="tour-text"]').inner_text().startswith("📚 My books")
    page.click('[data-testid="tour-skip"]')
    assert page.locator('[data-testid="tour"]').count() == 0
