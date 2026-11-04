"""🔢 The Book Bible code map and 📖 "Fill the whole Book Bible" in the browser: ⋯ View options → Show codes in the
Book Bible, the ❓ Help → 🔢 Code map page (searchable table, ⬇ Markdown download), the ⚡ Make-a-book switch "Fill
the whole Book Bible before writing" (off by default; on sends fill_bible) and the 📖 At a glance button (progress,
Stop, "N sections filled, M still empty"). Screenshots go to $BF_UI_SHOTS."""
from __future__ import annotations

import json
import re

from .test_ui_binder import bd, open_binder, open_menu, goto_page  # noqa: F401 - the bd fixture
from .ui_helpers import assert_clean, goto, open_app, open_make_book, overflow, shot, watch


def test_show_codes_in_the_book_bible(make_context, bd):  # noqa: F811
    page = open_binder(make_context, bd, page_id="ch-maren")
    art = page.locator('.bnd-page[data-page-id="ch-maren"]')
    eyes = art.locator('[data-fid="5.2.8"] .bnd-code').first
    assert eyes.inner_text() == "C1c" and not eyes.is_visible()       # hidden until the author asks
    open_menu(page, "view")
    assert page.locator("[data-testid=binder-codemap-link]").get_attribute("href") == "#/help/codes"
    page.check("[data-testid=binder-codes]")
    assert eyes.is_visible()
    assert page.get_attribute("[data-testid=binder]", "data-codes") == "on"
    head = art.locator('section[data-sec="5.2"] .bnd-sec-code')
    assert head.inner_text() == "C00 · C11"                               # quick stats: identity and looks
    assert art.locator('[data-fid="5.7.1"] .bnd-code').first.inner_text() == "C3a"
    # every field box on the page has its code
    missing = page.evaluate("""() => [...document.querySelectorAll('.bnd-page [data-fid]')]
        .filter(e => !e.querySelector('.bnd-code')).map(e => e.getAttribute('data-fid'))""")
    assert missing == [], missing
    shot(page, "binder-show-codes")
    page.reload()
    page.wait_for_selector(".bnd-page", timeout=15000)
    assert page.get_attribute("[data-testid=binder]", "data-codes") == "on"   # remembered on this computer
    assert_clean(page, "show codes")


def test_help_code_map_page(make_context, bd):  # noqa: F811
    ctx = make_context(width=1280, height=900)
    page = watch(ctx.new_page())
    page.goto(bd.url)
    page.wait_for_selector("#main h1", timeout=15000)
    goto(page, "#/help")
    page.click("[data-testid=help-codemap-link]")
    page.wait_for_selector("[data-testid=codemap-table]", timeout=10000)
    assert page.inner_text("#main h1") == "🔢 Code map"
    count_text = page.inner_text("[data-testid=codemap-count]")
    total = int(re.search(r"(\d+)", count_text.replace(",", "")).group(1)) if re.search(r"\d", count_text) else count_text
    assert total > 500, (count_text, page.evaluate("[document.querySelector(\"#cm-kind\").value, document.querySelectorAll(\"[data-testid=codemap-table] tr\").length]"))
    page.fill("[data-testid=codemap-search]", "eyes")
    page.wait_for_function("() => /detail/.test(document.querySelector('[data-testid=codemap-count]').textContent)")
    rows = page.locator("[data-testid=codemap-table] tbody tr[data-code=C1c]")
    assert rows.count() == 1 and "5.2.8" in rows.inner_text() and "character:eyes" in rows.inner_text()
    page.fill("[data-testid=codemap-search]", "5.7.1")
    assert page.locator("[data-testid=codemap-table] tbody tr[data-code=C3a]").count() == 1
    page.fill("[data-testid=codemap-search]", "")
    page.select_option("[data-testid=codemap-kind]", "N")
    codes = page.evaluate("() => [...document.querySelectorAll('[data-testid=codemap-table] tbody tr:not(.codemap-sec)')].map(r => r.dataset.code)")
    assert codes and all(c.startswith("N") for c in codes) and "N1a" in codes
    page.fill("[data-testid=codemap-search]", "zzzz-nothing")
    assert "Nothing matches" in page.inner_text("[data-testid=codemap-count]")
    page.fill("[data-testid=codemap-search]", "")
    page.select_option("[data-testid=codemap-kind]", "C")
    with page.expect_download() as dl:
        page.click("[data-testid=codemap-download]")
    path = dl.value.path()
    text = open(path, encoding="utf-8").read()
    assert text.startswith("# Book Bible code map") and "`C1c` | Eyes | 5.2.8" in text
    shot(page, "help-code-map")
    assert_clean(page, "code map page")
    narrow = watch(make_context(width=390, height=800).new_page())
    narrow.goto(bd.url)
    narrow.wait_for_selector("#main h1", timeout=15000)
    goto(narrow, "#/help/codes")
    narrow.wait_for_selector("[data-testid=codemap-table]")
    assert not overflow(narrow), "no horizontal page scroll at phone width"
    shot(narrow, "help-code-map-390")
    assert_clean(narrow, "code map page at 390")


def test_make_a_book_switch_fill_the_whole_bible(make_context, ai_server):
    page = open_app(make_context(), ai_server)
    sent = []

    def handle(route):
        if route.request.method == "POST":
            sent.append(json.loads(route.request.post_data or "{}"))
            return route.fulfill(status=400, content_type="application/json", body=json.dumps(
                {"errors": [{"code": "INVALID_INPUT", "path": "/x", "message": "test stop"}]}))
        return route.continue_()
    page.route(re.compile(r"/api/autobook$"), handle)
    open_make_book(page)
    d = page.locator("#mab-dialog")
    sw = d.locator("[data-testid=mb-fill-bible]")
    sw.wait_for(timeout=15000)
    assert not sw.is_checked() and sw.get_attribute("role") == "switch"   # off by default: just in time
    assert "Off" in d.locator(".fb-switch").inner_text()
    d.get_by_role("button", name="⚡ Start with these settings").click()
    page.wait_for_function("() => /test stop/.test(document.querySelector('#mab-dialog').textContent)", timeout=15000)
    assert sent and "fill_bible" not in sent[-1]
    sw.check()
    assert "On" in d.locator(".fb-switch").inner_text()
    shot(page, "make-a-book-fill-bible-switch")
    d.get_by_role("button", name="⚡ Start with these settings").click()
    for _ in range(75):
        if len(sent) >= 2:
            break
        page.wait_for_timeout(200)
    assert len(sent) == 2 and sent[-1].get("fill_bible") is True
    # (the stubbed 400 answers are expected browser errors: no assert_clean here)


def test_at_a_glance_fill_the_whole_bible_button(make_context, bd):  # noqa: F811
    page = open_binder(make_context, bd)
    fake = page.bf_calls
    posts = []
    fake.jobs["job-all"] = {"job_id": "job-all", "kind": "bible_fill_all", "status": "running", "phase": "Filling “Maren Vey”",
                            "done": 1, "total": 3, "results": []}
    summary = {"filled_sections": 12, "empty_sections": 2, "reasons": [{"why": "the AI had nothing to add yet", "sections": 2}],
               "fields": 80, "codes": ["C11", "C66"], "message": "12 sections filled, 2 still empty (2: the AI had nothing to add yet)",
               "derived": "the pages Akọwe works out itself fill themselves as the book is planned and written"}

    def fill_all(route):
        posts.append(route.request.post_data)
        return route.fulfill(status=202, content_type="application/json", body=json.dumps(dict(fake.jobs["job-all"], done=0)))
    page.route(re.compile(r"/binder/fill_all$"), fill_all)
    btn = page.locator("[data-testid=binder-fill-all]")
    assert btn.inner_text() == "📖 Fill in the whole Book Bible"
    btn.click()
    page.wait_for_selector("[data-testid=binder-fill-all-progress]", timeout=10000)
    assert page.locator("[data-testid=binder-fill-all-stop]").is_visible()
    shot(page, "glance-fill-whole-bible-running")
    fake.jobs["job-all"] = dict(fake.jobs["job-all"], status="done", done=3, phase="Finished",
                                results=[{"ok": True, "summary": summary, "message": summary["message"] + ". The new details wait for your OK: ✔ approve or ✏ edit them on their pages."}])
    page.wait_for_selector("[data-testid=binder-msg] .bnd-ok-msg", timeout=15000)
    assert "wait for your OK" in page.inner_text("[data-testid=binder-msg]")
    note = page.locator("[data-testid=binder-fill-all-note]")
    note.wait_for(timeout=5000)
    assert "12 sections filled, 2 still empty" in note.inner_text() and "nothing to add yet" in note.inner_text()
    assert len(posts) == 1
    shot(page, "glance-fill-whole-bible-done")
    assert_clean(page, "fill the whole bible")


def test_at_a_glance_stop(make_context, bd):  # noqa: F811
    page = open_binder(make_context, bd)
    fake = page.bf_calls
    fake.jobs["job-all"] = {"job_id": "job-all", "kind": "bible_fill_all", "status": "running", "phase": "Filling", "done": 0,
                            "total": 4, "results": []}
    cancels = []
    page.route(re.compile(r"/binder/fill_all$"), lambda r: r.fulfill(status=202, content_type="application/json",
                                                                     body=json.dumps(fake.jobs["job-all"])))

    def cancel(route):
        cancels.append(1)
        fake.jobs["job-all"] = dict(fake.jobs["job-all"], status="cancelled", results=[{"ok": True, "summary": {
            "filled_sections": 3, "empty_sections": 9, "reasons": [{"why": "stopped before it was reached", "sections": 9}], "derived": ""},
            "message": "Stopped. 3 sections filled, 9 still empty (9: stopped before it was reached)."}])
        return route.fulfill(status=200, content_type="application/json", body="{}")
    page.route(re.compile(r"/review/ai/job-all/cancel$"), cancel)
    page.click("[data-testid=binder-fill-all]")
    page.click("[data-testid=binder-fill-all-stop]")
    page.wait_for_selector("[data-testid=binder-msg] .bnd-ok-msg", timeout=15000)
    assert cancels and "Stopped." in page.inner_text("[data-testid=binder-msg]")
    assert "3 sections filled, 9 still empty" in page.inner_text("[data-testid=binder-fill-all-note]")
    assert_clean(page, "stop")
