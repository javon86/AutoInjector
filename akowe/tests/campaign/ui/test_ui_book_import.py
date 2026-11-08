"""BACK BURNER (parked 2026-11-08 by the user's request): not loaded by the app; see docs/AKOWE_IMPROVEMENT_PLAN.md back-burner list.

📥 Bring in my book and 📝 Fix it with my notes in the browser: My books → 📥 Bring in my book → choose a .docx →
the chapters Akọwe found (rename, untick, join) → the book is made → ▶ Build the Book Bible → the summary and the three
offers; and Book home → 📝 Fix it with my notes → notes → what each note is about → proposed before/after changes
(checked by another AI) → ✔ Use the ticked changes → the summary line. The fake AutoInjector answers the import's own
AI tasks with tests/import_fake.ImportFake (everything else with the stock fake)."""
from __future__ import annotations

import pytest as _pytest_parked  # noqa: E402

pytestmark = _pytest_parked.mark.skip(reason="back burner: feature parked")


import contextlib
import io
import zipfile

from .ui_helpers import assert_clean, goto, open_app, settle

from import_fake import BOOK, ImportFake


@contextlib.contextmanager
def import_answers(bridge):
    imp = ImportFake()
    orig = bridge.ai.submit

    def submit(slot, system, user, schema):
        import json  # noqa: PLC0415
        package = json.loads(user.split("\n", 1)[1])
        kind = imp._kind(package.get("context") or {}, schema.get("properties") or {})  # noqa: SLF001
        if kind in ("details", "plan", "map", "revise", "check") or (kind == "track"):
            return imp.submit(slot, system, user, schema)
        return orig(slot, system, user, schema)
    bridge.ai.submit = submit
    try:
        yield imp
    finally:
        bridge.ai.submit = orig


def _docx() -> bytes:
    W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    paras = []
    for title, ps in BOOK:
        paras.append(f'<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>{title}</w:t></w:r></w:p>')
        for p in ps:
            t = p.replace("&", "&amp;").replace("<", "&lt;").replace('"', "&quot;")
            paras.append(f'<w:p><w:r><w:t xml:space="preserve">{t}</w:t></w:r></w:p>')
    doc = f'<?xml version="1.0" encoding="UTF-8"?><w:document {W}><w:body>{"".join(paras)}</w:body></w:document>'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("word/document.xml", doc)
        z.writestr("word/styles.xml", f'<w:styles {W}><w:style w:styleId="Heading1"><w:name w:val="heading 1"/>'
                                      '</w:style></w:styles>')
    return buf.getvalue()


def test_bring_in_my_book_from_a_word_file(make_context, ai_server, bridge):
    page = open_app(make_context(), ai_server)
    page.click("[data-testid=home-import]") if page.locator("[data-testid=home-import]").count() else goto(page, "#/import")
    page.wait_for_selector("[data-testid=imp-start]", timeout=15000)
    assert page.locator("h1").inner_text().strip() == "📥 Bring in my book"
    # nothing chosen: a plain hint, no request
    page.click("[data-testid=imp-read]")
    page.wait_for_selector("text=Choose a file or paste your text first.", timeout=5000)
    page.set_input_files("[data-testid=imp-file]", files=[{"name": "The Lighthouse.docx", "mimeType":
                                                          "application/vnd.openxmlformats-officedocument."
                                                          "wordprocessingml.document", "buffer": _docx()}])
    page.click("[data-testid=imp-read]")
    card = page.locator("[data-testid=imp-split-card]")
    card.wait_for(timeout=15000)
    assert "Akọwe found 3 chapters" in card.inner_text()
    assert page.locator("[data-testid=imp-title]").input_value() == "The Lighthouse"
    assert page.locator("[data-testid=imp-hero]").input_value() == "Mara Vell"
    assert page.locator("[data-testid=imp-chapter]").count() == 3
    # rename chapter 3, join 1 and 2, then split them again at a paragraph
    t3 = page.locator("[data-testid=imp-ch-title]").nth(2)
    t3.fill("The Reef at Low Tide")
    with page.expect_response(lambda r: "/api/import/" in r.url and r.request.method == "PUT", timeout=10000):
        t3.press("Tab")
    page.wait_for_function("() => [...document.querySelectorAll('[data-testid=imp-ch-title]')].some(e => e.value === 'The Reef at Low Tide')")
    with page.expect_response(lambda r: "/api/import/" in r.url and r.request.method == "PUT", timeout=10000):
        page.locator("[data-testid=imp-merge]").first.click()
    page.wait_for_function("() => document.querySelectorAll('[data-testid=imp-chapter]').length === 2")
    page.locator("[data-testid=imp-split]").first.click()
    sel = page.locator("[data-testid=imp-split-at]")
    sel.wait_for(timeout=10000)
    opt = page.locator("[data-testid=imp-split-at] option", has_text="Down in Gullhaven").first.get_attribute("value")
    sel.select_option(opt)
    page.fill("[data-testid=imp-split-title]", "The Harbour")
    page.click("[data-testid=imp-split-go]")
    page.wait_for_function("() => document.querySelectorAll('[data-testid=imp-chapter]').length === 3")
    titles = page.eval_on_selector_all("[data-testid=imp-ch-title]", "els => els.map(e => e.value)")
    assert titles == ["Chapter One: The Fog", "The Harbour", "The Reef at Low Tide"]
    assert "AI calls" in page.locator("[data-testid=imp-estimate]").inner_text()
    page.fill("[data-testid=imp-author]", "Jane Doe")
    page.click("[data-testid=imp-create]")
    page.wait_for_selector("[data-testid=imp-done]", timeout=30000)
    assert page.locator("h1").inner_text().strip() == "📥 Your brought-in book"
    assert "3 chapters" in page.locator("[data-testid=imp-done]").inner_text()
    # ▶ Build the Book Bible: progress, then the summary
    with import_answers(bridge):
        page.click("[data-testid=imp-bible-start]")
        page.wait_for_selector("[data-testid=imp-bible][data-state=done]", timeout=60000)
    summary = page.locator("[data-testid=imp-bible-summary]").inner_text()
    assert "3 chapters read" in summary and "🔒" in summary
    # the three offers
    for tid in ("imp-offer-checks", "imp-offer-orig", "imp-offer-continue"):
        assert page.locator(f"[data-testid={tid}]").is_visible(), tid
    assert page.locator("[data-testid=imp-check-now-range]").input_value() == "all"
    settle(page, 400)
    assert_clean(page, "bring in my book")
    # Book home of a brought-in book links back to this page
    page.click("a:has-text('🏠 Book home')")
    page.wait_for_selector("[data-testid=bk-imported]", timeout=15000)
    assert page.locator("[data-testid=bk-notes]").is_visible()


def test_bring_in_refuses_a_damaged_file(make_context, ai_server):
    page = open_app(make_context(), ai_server, "#/import")
    page.set_input_files("[data-testid=imp-file]", files=[{"name": "broken.docx", "mimeType": "application/octet-stream",
                                                          "buffer": b"PK\x03\x04 not really a zip"}])
    page.click("[data-testid=imp-read]")
    page.wait_for_selector("text=This file cannot be read", timeout=15000)
    page.bf_problems.clear()  # the 400 answer is the expected refusal


def _imported_book(server) -> str:
    text = "\n\n".join([t for title, ps in BOOK for t in [title] + ps])
    d = server.api("POST", "/import/read", {"text": text, "name": "pasted"})
    out = server.api("POST", f"/import/{d['draft_id']}/create", {"author_confirms": True, "title": "Notes Book",
                                                                 "main_character": "Mara Vell",
                                                                 "main_place": "Gullhaven"})
    return out["project_id"]


def test_fix_it_with_my_notes(make_context, ai_server, bridge):
    pid = _imported_book(ai_server)
    page = open_app(make_context(), ai_server, f"#/p/{pid}/main/book")
    page.wait_for_selector("[data-testid=bk-notes]", timeout=15000)
    page.click("[data-testid=bk-notes]")
    page.wait_for_selector("[data-testid=nf-start]", timeout=15000)
    assert page.locator("h1").inner_text().strip() == "📝 Fix it with my notes"
    with import_answers(bridge) as imp:
        imp.check_problems = [{"match": "slammed her fist", "problem": "Mara never shouts in the Book Bible"}]
        page.fill("[data-testid=nf-notes]", "cut the dream in ch 3\nmake Mara angrier in the harbour scene")
        page.click("[data-testid=nf-map]")
        page.wait_for_selector("[data-testid=nf-mapping]", timeout=30000)
        page.wait_for_selector("[data-testid=nf-state][data-state=mapped]", timeout=30000)
        notes = page.locator("[data-testid=nf-note]")
        assert notes.count() == 2
        assert notes.nth(0).locator("[data-testid=nf-chapters]").input_value() == "3"
        page.click("[data-testid=nf-revise]")
        page.wait_for_selector("[data-testid=nf-state][data-state=proposed]", timeout=60000)
    changes = page.locator("[data-testid=nf-change]")
    assert changes.count() == 2
    assert "(cut)" in page.locator("[data-testid=nf-changes]").inner_text()
    assert "Mara never shouts" in page.locator("[data-testid=nf-check]").first.inner_text()
    assert "did not write the changes" in page.locator("[data-testid=nf-checker]").inner_text()
    # leave the angrier change out, use the cut
    angry = page.locator("[data-testid=nf-change]", has_text="slammed").locator("input[type=checkbox]")
    angry.uncheck()
    with page.expect_response(lambda r: r.url.endswith("/notes-fix/decide"), timeout=20000) as resp:
        page.click("[data-testid=nf-use]")
    assert resp.value.status == 200
    page.wait_for_function("() => (document.querySelector('[data-testid=nf-summary]') || {}).textContent"
                           " && document.querySelector('[data-testid=nf-summary]').textContent.includes('1 accepted')",
                           timeout=15000)
    assert "2 notes → 2 changes proposed, 1 accepted, 1 left out." in page.locator("[data-testid=nf-summary]").inner_text()
    settle(page, 300)
    assert_clean(page, "fix it with my notes")
