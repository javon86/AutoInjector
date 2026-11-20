"""📖 Grow my start into a novel in the browser: My books → 📖 Start from my own chapters → paste two chapters → the
chapters Akọwe found + how long the finished book is → the book is made → ✨ Read my chapters → ONE screen "Here's
what I understood from your chapters — fix anything" (characters with their real lines, the magic rule's needs) →
✔ Use this → 🗺 Plan the rest → ✔ Use this plan → ⚡ Write the rest opens the run window. The fake AutoInjector
answers the grow flow's own requests with tests/grow_fake.GrowFakeAI (everything else with the stock fake)."""
from __future__ import annotations

import contextlib

from .ui_helpers import assert_clean, goto, open_app

from grow_fake import GrowFakeAI, opening_text


@contextlib.contextmanager
def grow_answers(bridge):
    g = GrowFakeAI()
    orig = bridge.ai._answer  # noqa: SLF001

    def answer(ctx, props, schema):
        if "chapter_summaries" in props or ("voices" in props and "narration" in ctx) or \
                ("how_many" in ctx and "from_chapter" in ctx):
            return g._answer(ctx, props, schema)  # noqa: SLF001
        return orig(ctx, props, schema)
    bridge.ai._answer = answer  # noqa: SLF001
    try:
        yield g
    finally:
        bridge.ai._answer = orig  # noqa: SLF001


def test_grow_my_start_into_a_novel(make_context, ai_server, bridge):
    with grow_answers(bridge) as g:
        page = open_app(make_context(), ai_server)
        if page.locator("[data-testid=home-grow]").count():
            page.click("[data-testid=home-grow]")
        elif page.locator("[data-testid=start-grow]").count():
            page.click("[data-testid=start-grow]")
        else:
            goto(page, "#/grow")
        page.wait_for_selector("[data-testid=gr-start]", timeout=15000)
        assert page.locator("h1").inner_text().strip() == "📖 Grow my start into a novel"
        page.click("[data-testid=gr-read]")  # nothing given: a plain hint
        page.wait_for_selector("text=Choose a file or paste your chapters first.", timeout=5000)
        page.fill("[data-testid=gr-paste]", opening_text())
        page.click("[data-testid=gr-read]")
        found = page.locator("[data-testid=gr-found]")
        found.wait_for(timeout=15000)
        assert "Akọwe found 2 chapters" in found.inner_text()
        assert page.locator("[data-testid=gr-chapters] li").count() == 2
        page.select_option("[data-testid=gr-length]", "short_story")
        page.fill("[data-testid=gr-total]", "4")
        page.fill("[data-testid=gr-title]", "The Keeper's Stones")
        page.click("[data-testid=gr-create]")
        page.wait_for_selector("[data-testid=gr-stage-imported]", timeout=15000)
        assert "/grow" in page.url
        # ✨ the AI reads the chapters: ONE screen to check
        page.click("[data-testid=gr-understand]")
        page.wait_for_selector("[data-testid=gr-stage-understood]", timeout=30000)
        assert page.locator("[data-testid=gr-understood-h]").inner_text().startswith(
            "Here’s what I understood from your chapters")
        assert page.locator("[data-testid=gr-u-char]").count() == 3
        assert "Who signed the log?" in page.locator("[data-testid=gr-u-characters]").inner_text()
        assert "2 tide-stones" in page.locator("[data-testid=gr-u-magic-needs]").input_value()
        assert page.locator("[data-testid=gr-u-title]").input_value() == "The Keeper's Stones"
        page.fill("[data-testid=gr-u-premise]", "Mara Vell spends her last tide-stones to find her master.")
        page.click("[data-testid=gr-u-use]")
        page.wait_for_selector("[data-testid=gr-stage-accepted]", timeout=15000)
        assert "1 magic rule" in page.locator("[data-testid=gr-accepted]").inner_text()
        # 🗺 the plan of the rest, from chapter 3
        assert page.locator("[data-testid=gr-plan-total]").input_value() == "4"
        page.click("[data-testid=gr-plan]")
        page.wait_for_selector("[data-testid=gr-stage-planned]", timeout=30000)
        assert page.locator("[data-testid=gr-p-chapter]").count() == 2
        assert g.plan_contexts and g.plan_contexts[-1]["from_chapter"] == 3
        assert_clean(page, "grow: the plan")
        page.click("[data-testid=gr-p-use]")
        page.wait_for_selector("[data-testid=gr-stage-ready]", timeout=30000)
        assert "your 2, then the AI's" in page.locator("[data-testid=gr-stage-ready]").inner_text()
        # the premise the author typed is the book's
        pid = page.url.split("#/p/")[1].split("/")[0]
        prof = ai_server.api("GET", f"/projects/{pid}/profile")
        assert prof["idea"].startswith("Mara Vell spends") and prof["title"] == "The Keeper's Stones"
        page.click("[data-testid=gr-write]")
        page.locator("#mab-dialog").wait_for(timeout=15000)
        st = ai_server.api("GET", f"/projects/{pid}/branches/main/grow")
        assert st["stage"] == "writing" and st["run_id"]
        with contextlib.suppress(Exception):
            ai_server.api("POST", f"/autobook/{st['run_id']}/cancel", {})
        goto(page, "#/")
        page.wait_for_selector("[data-testid=home-grow]", timeout=15000)
        assert_clean(page, "grow: home")
