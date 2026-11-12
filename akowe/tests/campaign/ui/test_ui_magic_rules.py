"""✨ Magic rules in the browser: the author ticks "This rule is an ability, spell or magical device" in the Story
rules form, types the teleport rule (2 anchor stones, at night only, 3 times a day), saves, and sees the rule's ✨
line and the ✨ Magic rules card (abilities, the on/off tick box, deliberate rule-breaks), at phone width too."""
from __future__ import annotations

from .ui_helpers import assert_clean, goto, open_app, overflow, shot


def test_write_a_magic_rule_and_see_the_magic_card(make_context, ai_server):
    pid = ai_server.api("POST", "/projects", {"name": "Magic Book", "profile": {"title": "Magic Book"}})["project_id"]
    ctx = make_context()
    page = open_app(ctx, ai_server)
    goto(page, f"#/p/{pid}/main/world")
    card = page.locator("[data-testid=magic-card]")
    card.wait_for(timeout=20000)
    page.locator("[data-testid=magic-card] >> text=No magic rule yet").wait_for(timeout=10000)
    page.locator("[data-testid=rules-edit]").click()
    form = page.locator("[data-testid=rules-card] fieldset.rule-edit").first
    form.locator("[data-k=text]").fill("Teleportation carries Mara to a place she can see.")
    form.locator("[data-testid=magic-fields] summary").click()
    form.locator("[data-mk=name]").fill("Teleportation")
    form.locator("[data-mk=requires]").fill("2 anchor stones\nline of sight\nat night only")
    form.locator("[data-mk=limits]").fill("3 times a day")
    form.locator("[data-mk=price]").fill("a nosebleed")
    form.locator("[data-mk=start]").fill("Mara: 3 anchor stones")
    shot(page, "magic-rule-form")
    page.locator("[data-testid=rules-save]").click()
    line = page.locator("[data-testid=magic-summary]")
    line.wait_for(timeout=15000)
    txt = line.inner_text()
    assert "Teleportation" in txt and "2 anchor stones" in txt and "no exceptions" in txt
    page.locator("[data-testid=magic-line]").wait_for(timeout=15000)
    assert page.inner_text("[data-testid=magic-line]").startswith("✨ Magic rules kept: 0 use(s), 0 broken")
    assert "Mara has three anchor stones." in page.inner_text("[data-testid=magic-state]")
    rules = ai_server.api("GET", f"/projects/{pid}/branches/main/review/world")["rules"]["rules"]
    assert rules[0]["magic"]["requires"] == ["2 anchor stones", "line of sight", "at night only"]
    shot(page, "magic-card")
    assert_clean(page, "magic rules card")
    page.locator("[data-testid=magic-enabled]").uncheck()
    page.locator("[data-testid=magic-card] >> text=switched off").wait_for(timeout=10000)
    assert ai_server.api("GET", f"/projects/{pid}/branches/main/review/magic")["enabled"] is False
    page.set_viewport_size({"width": 390, "height": 844})
    assert not overflow(page)
