"""🧠 Smart memory in the browser: a book planned with needs lists shows each chapter's list on the chapter page
(✅ Planned to page) and on the Book Bible's chapter page as a readable line whose codes are hoverable (their plain
name and the details they cover) and expandable, the run window's chapter rows and the ⏱ Time and AI use page say how
much smaller the writer's instructions were. Screenshots go to $BF_UI_SHOTS."""
from __future__ import annotations

from .test_ui_followthrough import autobook
from .ui_helpers import assert_clean, goto, open_app, overflow, shot


def _needs(ctx):
    n = int((ctx.get("chapter") or {}).get("number") or 1)
    return {"things": [{"thing": "Mara Vell", "kind": "character", "sections": ["C11", "C55(Tom)"], "note": "her looks"},
                       {"thing": "The brass key", "kind": "item", "sections": ["I22"], "note": "it is used"}],
            "earlier": [{"chapter": n - 1, "moment": "Mara climbed the lighthouse steps"}] if n > 1 else [],
            "notes": ["N11(Mara)"]}


def _chapter_record(server, pid, first_words):
    """The chapter (C02 prose record) whose text starts with these words (the fake writes the same chapters)."""
    recs = server.api("GET", f"/projects/{pid}/branches/main/records")
    recs = recs.get("records", recs) if isinstance(recs, dict) else recs
    for r in recs:
        if r.get("module_id") == "C02" and str(r.get("title") or "").startswith(first_words):
            return r["record_id"]
    raise AssertionError(f"no chapter starting “{first_words}”")


def test_needs_list_on_the_chapter_page_the_book_bible_and_the_time_page(make_context, ai_server, bridge):
    bridge.ai.needs = _needs
    try:
        pid = autobook(ai_server)
    finally:
        bridge.ai.needs = None
    rid = _chapter_record(ai_server, pid, "Down in the harbor")
    page = open_app(make_context(), ai_server, f"#/p/{pid}/main/write/{rid}")
    box = page.locator("[data-testid=needs-list]")
    box.wait_for(timeout=20000)
    line = page.inner_text("[data-testid=needs-list-line]")
    assert "Chapter 2 needs:" in line and "Mara C11, C55(Tom)" in line and "The brass key I22" in line, line
    assert "Notes N11(Mara)" in line and "Earlier: chapter 1" in line
    code = box.locator("abbr.nl-code[data-code=C11]").first
    title = code.get_attribute("title")
    assert title.startswith("C11 Looks:") and "C1c Eyes" in title  # hover: the plain name and its details
    code.focus()
    box.locator("summary", has_text="What these codes mean").click()
    assert "C1c Eyes" in box.inner_text() and "Overall look" in box.inner_text()
    assert "%" in page.inner_text("[data-testid=needs-list-saved]") or "about as much" in \
        page.inner_text("[data-testid=needs-list-saved]")
    shot(page, "needs_list_chapter_page")
    assert_clean(page, "chapter page needs list")

    # the Book Bible's chapter page
    goto(page, f"#/p/{pid}/main/bible/chapter-ch2")
    nb = page.locator("[data-testid=bnd-needs-list]").first
    nb.wait_for(timeout=30000)
    assert "needs:" in nb.inner_text() and nb.locator("abbr.nl-code").count() >= 2
    shot(page, "needs_list_book_bible")
    assert_clean(page, "book bible needs list")

    # ⏱ Time and AI use: the saving for the whole book
    goto(page, f"#/p/{pid}/main/costs")
    sm = page.locator("[data-testid=ct-smart-memory]")
    sm.wait_for(timeout=15000)
    txt = sm.inner_text()
    assert "smart memory" in txt.lower() and "needs list" in txt.lower() and "chapter 1" in txt.lower()
    shot(page, "needs_list_time_page")
    assert_clean(page, "time page smart memory")


def test_needs_list_on_a_phone(make_context, ai_server, bridge):
    bridge.ai.needs = _needs
    try:
        pid = autobook(ai_server)
    finally:
        bridge.ai.needs = None
    rid = _chapter_record(ai_server, pid, "Down in the harbor")
    page = open_app(make_context(width=390, height=844), ai_server, f"#/p/{pid}/main/write/{rid}")
    page.locator("[data-testid=needs-list]").wait_for(timeout=20000)
    assert overflow(page) <= 1, "the needs list scrolls sideways on a phone"
    shot(page, "needs_list_phone")
    assert_clean(page, "needs list on a phone")
