"""Crawl every route reachable from the UI on a fully made book (seeded by ⚡ Make a book for me through the API with
the fake AI): no console errors, no failed requests, no uncaught exceptions, no leaked JS values in the text, no
horizontal overflow at 1366 and 390 px, every visible control has an accessible name."""
from __future__ import annotations

import time

import pytest

from .ui_helpers import assert_clean, bad_text, goto, open_app, overflow, settle, shot, unnamed_controls

SETS = "ABCDEFGHIJK"


@pytest.fixture(scope="module")
def made_book(ai_server):
    r = ai_server.api("POST", "/autobook", {"author_confirms": True})
    t0 = time.time()
    while time.time() - t0 < 60:
        s = ai_server.api("GET", "/autobook/" + r["id"])
        if s["status"] not in ("queued", "running", "pausing"):
            break
        time.sleep(0.3)
    assert s["status"] == "done", s
    pid = s["project_id"]
    recs = ai_server.api("GET", f"/projects/{pid}/branches/main/records")
    ops = ai_server.api("GET", "/operations")
    return {"pid": pid, "run": s, "records": recs, "ops": ops}


@pytest.fixture(scope="module")
def pages(browser, ai_server, made_book):
    out = {}
    ctxs = []
    for w, hgt in ((1366, 900), (390, 844)):
        ctx = browser.new_context(viewport={"width": w, "height": hgt})
        ctxs.append(ctx)
        out[w] = open_app(ctx, ai_server)
    yield out
    for c in ctxs:
        c.close()


def check_page(page, label, width, problems):
    hits = bad_text(page)
    ov = overflow(page)
    unnamed = unnamed_controls(page)
    probs = list(page.bf_problems)
    page.bf_problems.clear()
    bad = []
    if probs:
        bad.append(f"browser: {probs[:5]}")
    if hits:
        bad.append(f"leaked values: {hits[:3]}")
    if ov > 1:
        bad.append(f"horizontal overflow {ov}px")
    if unnamed:
        bad.append(f"unnamed controls: {unnamed[:3]}")
    if bad:
        problems.append(f"[{width}] {label}: " + " | ".join(bad))
        shot(page, f"crawl_{width}_{label.replace('/', '_').replace('#', '')[:60]}")


def routes(pid):
    p = f"#/p/{pid}/main"
    return ["#/", "#/start", "#/settings", "#/shelf", "#/pair", p, p + "/book", p + "/review", p + "/journal",
            p + "/progress", p + "/activity", p + "/manifest", "#/nope/nothing"] + [f"{p}/set/{s}" for s in SETS]


@pytest.mark.parametrize("width", [1366, 390])
def test_main_routes_clean(pages, made_book, width):
    page = pages[width]
    problems = []
    for r in routes(made_book["pid"]):
        goto(page, r)
        assert page.locator("#main h1").count() >= 1, f"{r}: no heading"
        check_page(page, r, width, problems)
    assert not problems, "\n".join(problems)


@pytest.mark.parametrize("set_letter", list(SETS))
def test_operation_pages_clean(pages, made_book, set_letter):
    """Every operation page of the set at 1366 px; the first one of the set also at 390 px."""
    pid = made_book["pid"]
    ops = [o["id"] for o in made_book["ops"] if o["set"] == set_letter]
    problems = []
    for i, op in enumerate(ops):
        for w in ((1366, 390) if i == 0 else (1366,)):
            page = pages[w]
            goto(page, f"#/p/{pid}/main/op/{op}")
            assert op in page.inner_text("#main h1"), f"{op}: wrong page {page.inner_text('#main h1')!r}"
            check_page(page, f"op/{op}", w, problems)
    assert not problems, "\n".join(problems)


def test_record_and_edit_pages_clean(pages, made_book):
    """One record page (and its edit page) per operation that has records."""
    pid = made_book["pid"]
    seen = set()
    problems = []
    page = pages[1366]
    for r in made_book["records"]:
        if r["module_id"] in seen:
            continue
        seen.add(r["module_id"])
        goto(page, f"#/p/{pid}/main/rec/{r['record_id']}")
        assert r["record_id"] in page.inner_text("#main") or page.locator("#main h1").count(), r
        check_page(page, f"rec/{r['module_id']}", 1366, problems)
    for r in made_book["records"][:3]:
        goto(page, f"#/p/{pid}/main/edit/{r['record_id']}")
        check_page(page, f"edit/{r['module_id']}", 1366, problems)
    assert len(seen) >= 15
    assert not problems, "\n".join(problems)


DIALOG_OPENERS = [("#jump-btn", "#jump-dialog"), ("#mab-btn", "#mab-dialog"), ("#health-btn", "#health-dialog"),
                  ("#more-btn >> nth=0", "#more-pop"), ("#sets-btn", "#sets-pop"), ("#wf-btn", "#wf-drawer")]


@pytest.mark.parametrize("width", [1366, 390])
def test_topbar_popups_clean(pages, made_book, width):
    page = pages[width]
    goto(page, f"#/p/{made_book['pid']}/main")
    problems = []
    for btn, target in DIALOG_OPENERS:
        if width == 390 and not page.locator(btn).is_visible():
            problems.append(f"[{width}] {btn} is not reachable at phone width")
            continue
        page.click(btn)
        page.wait_for_selector(target, state="visible", timeout=5000)
        settle(page, 300)
        check_page(page, f"popup {target}", width, problems)
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        if page.locator(target).is_visible():   # drawers/popovers may need their own close
            page.click(btn) if target in ("#wf-drawer", "#more-pop", "#sets-pop") else None
            page.wait_for_timeout(200)
    for b in ("#bible-btn", "#selftest-btn"):
        page.click("#more-btn")
        page.click(b)
        dlg = "#bible-dialog" if b == "#bible-btn" else "#selftest-dialog"
        page.wait_for_selector(dlg, state="visible", timeout=5000)
        settle(page, 300)
        check_page(page, f"dialog {dlg}", width, problems)
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        assert not page.locator(dlg).is_visible(), f"{dlg} did not close on Escape"
    assert not problems, "\n".join(problems)
