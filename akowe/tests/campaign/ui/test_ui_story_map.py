"""🗺 The story map in the browser (storymap.js): a sample book of fifteen characters with locked, approved and draft
links, a conflict from a chapter, a link about a removed character and gap warnings. The map draws, a conflict is
decided with a reason, a draft is approved, a connection is added, the "as of chapter" slider and "only problems"
filter it, the Book Bible links to it, it fits 1280×720 and a phone, and 100+ entries stay quick with capped labels.
Screenshots go to $BF_UI_SHOTS."""
from __future__ import annotations

import shutil
import time

import pytest

from .ui_helpers import Server, assert_clean, goto, open_app, overflow, shot


@pytest.fixture(scope="module")
def sample(tmp_path_factory):
    from akowe import story_map as sm
    from akowe.server import App
    import storymap_sample
    data = tmp_path_factory.mktemp("storymap-ui") / "data"
    app = App(data, token="x")
    pid = storymap_sample.build(app)
    big = storymap_sample.build(app, "A crowded book")
    ids = {n["name"]: n["id"] for n in sm.view(app.store, big, "main")["nodes"]}
    prev = ids["Adaeze Okafor"]
    for i in range(110):  # 100+ entries: a long chain of extra people, each tied to the one before
        node = sm.add_node(app.store, big, "main", {"kind": "character", "name": f"Villager {i + 1:03d}"})
        sm.add_link(app.store, big, "main", {"from": prev, "to": node["id"], "kind": "ally" if i % 2 else "family"})
        prev = node["id"]
    try:
        app.store.close()
    except Exception:  # noqa: BLE001
        pass
    srv = Server(data, None)
    yield srv, pid, big
    srv.close()
    shutil.rmtree(data.parent, ignore_errors=True)


def _open(make_context, srv, pid, w=1280, h=720):
    page = open_app(make_context(width=w, height=h), srv, f"#/p/{pid}/main/storymap")
    page.locator("[data-testid=sm-node]").first.wait_for(timeout=20000)
    return page


def test_story_map_draws_and_conflicts_are_decided_with_a_reason(make_context, sample):
    srv, pid, _big = sample
    page = _open(make_context, srv, pid)
    assert "26 connections" in page.inner_text("[data-testid=sm-summary]")
    assert page.locator("[data-testid=sm-node]").count() >= 15
    assert page.locator("[data-testid=sm-node] text.sm-star").count() == 1  # ★ the main character
    assert page.locator(".sm-link.sm-st-draft").count() >= 5 and page.locator(".sm-link.sm-conflict").count() == 1
    assert page.locator(".sm-lock").count() >= 5
    gaps = page.inner_text("[data-testid=sm-gaps]")
    for words in ("seems to change story-map link L1", "has not moved for 10 chapters", "never paid off by chapter 6",
                  "Chief Oduya has no new connections", "cannot both be true", "no longer in the Book Bible"):
        assert words in gaps, words
    box = page.locator(".sm-canvas").bounding_box()
    assert box["y"] < 720 * 0.45, "the map starts in the top half of a 1280×720 screen"
    shot(page, "story_map_1280")
    assert_clean(page, "story map")
    # the conflict: no silent change — keep it, with a reason
    page.locator("[data-testid=sm-gaps] li[data-code=CONFLICT] button").click()
    card = page.locator("[data-testid=sm-link-card]")
    assert "L1" in card.inner_text() and page.locator("[data-testid=sm-conflict]").is_visible()
    assert page.locator("[data-testid=sm-edit]").count() == 0 and page.locator("[data-testid=sm-change]").count() == 1
    page.click("[data-testid=sm-keep]")
    page.click("[data-testid=sm-reason-ok]")  # empty reason: refused on the page
    assert page.get_attribute("[data-testid=sm-reason]", "aria-invalid") == "true"
    page.fill("[data-testid=sm-reason]", "She only pretends not to know him")
    page.click("[data-testid=sm-reason-ok]")
    page.wait_for_function("() => !document.querySelector('.sm-link.sm-conflict')")
    assert "conflict" not in page.inner_text("[data-testid=sm-summary]")
    page.click("[data-testid=sm-link-card] summary")
    assert "She only pretends not to know him" in page.inner_text("[data-testid=sm-link-card]")
    # a draft: ✔ approve makes it a rule (solid line)
    n_draft = page.locator(".sm-link.sm-st-draft").count()
    page.locator(".sm-link.sm-st-draft").first.dispatch_event("pointerdown")
    page.locator(".sm-link.sm-st-draft").first.dispatch_event("pointerup")
    page.click("[data-testid=sm-approve]")
    page.wait_for_function(f"() => document.querySelectorAll('.sm-link.sm-st-draft').length === {n_draft - 1}")
    assert "Approved" in page.inner_text("[data-testid=sm-status]")
    # drag a circle: its place is saved with the book (and an edit right after still works)
    node = page.locator("[data-testid=sm-node]").nth(3)
    nid = node.get_attribute("data-node")
    bb = node.bounding_box()
    page.mouse.move(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2)
    page.mouse.down()
    page.mouse.move(bb["x"] + 60, bb["y"] + 40, steps=6)
    page.mouse.up()
    page.wait_for_timeout(1200)
    saved = srv.api("GET", f"/projects/{pid}/branches/main/storymap")
    assert next(n for n in saved["nodes"] if n["id"] == nid)["pos"], "the dragged position was saved"
    # add a connection
    page.click("[data-testid=sm-add-link]")
    page.select_option("#sm-f-from", label="👤 Old Nkem")
    page.select_option("#sm-f-kind", "works_for")
    page.select_option("#sm-f-to", label="👤 Mama Ronke")
    page.fill("#sm-f-note", "sweeps her stall")
    page.click("[data-testid=sm-save]")
    page.wait_for_selector("[data-testid=sm-link-card]")
    assert "Old Nkem" in page.inner_text("[data-testid=sm-link-card]") and "27 connections" in page.inner_text(
        "[data-testid=sm-summary]")
    assert_clean(page, "story map edits")


def test_filters_as_of_chapter_and_only_problems(make_context, sample):
    srv, pid, _big = sample
    page = _open(make_context, srv, pid, 1920, 1080)
    total = page.locator("[data-testid=sm-link]").count()
    page.locator("[data-testid=sm-asof]").fill("2")
    assert page.inner_text("[data-testid=sm-asof-words]") == "After chapter 2"
    early = page.locator("[data-testid=sm-link]").count()
    assert 0 < early < total
    page.locator("[data-testid=sm-asof]").fill("12")
    page.check("[data-testid=sm-only-problems]")
    probs = page.locator("[data-testid=sm-link]").count()
    assert 0 < probs < total
    page.uncheck("[data-testid=sm-only-problems]")
    page.click("[data-testid=sm-kinds-sum]")
    page.uncheck("[data-testid=sm-filter-place]")
    assert "of" in page.inner_text("[data-testid=sm-kinds-sum]")
    assert page.locator(".sm-node.sm-k-place").count() == 0
    page.check("[data-testid=sm-filter-place]")
    shot(page, "story_map_1920")
    assert_clean(page, "story map filters")


def test_book_bible_links_to_the_story_map_and_phone_width(make_context, sample):
    srv, pid, _big = sample
    page = open_app(make_context(), srv, f"#/p/{pid}/main/bible")
    link = page.locator("[data-testid=bnd-rail-storymap]")
    link.wait_for(timeout=30000)
    link.click()
    page.locator("[data-testid=sm-node]").first.wait_for(timeout=20000)
    assert page.locator(".side-sublink[data-sub=storymap][aria-current=page]").count() == 1
    phone = _open(make_context, srv, pid, 390, 844)
    assert overflow(phone) <= 1, "the story map scrolls sideways on a phone"


def test_a_hundred_entries_stay_quick_and_readable(make_context, sample):
    srv, _pid, big = sample
    t0 = time.time()
    page = _open(make_context, srv, big)
    took = time.time() - t0
    n = page.locator("[data-testid=sm-node]").count()
    assert n >= 120 and took < 20, (n, took)
    shown = page.evaluate("() => [...document.querySelectorAll('.sm-label')].filter(l => l.style.display !== 'none').length")
    assert shown <= 45, shown  # labels are capped (the rest show on zoom / hover)
    for _ in range(3):
        page.click("button[aria-label='Zoom in']")
    more = page.evaluate("() => [...document.querySelectorAll('.sm-label')].filter(l => l.style.display !== 'none').length")
    assert more > shown
    shot(page, "story_map_crowded")
    assert_clean(page, "crowded story map")
