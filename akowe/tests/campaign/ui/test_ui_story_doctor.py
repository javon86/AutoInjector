"""🩺 Plan check in the browser: the Make-a-book switches "Story doctor" (with its revisions and aim) and "Make sure
every character sounds different" (both on by default; only a change is sent)."""
from __future__ import annotations

from .test_ui_chapter_one import _start_body
from .ui_helpers import assert_clean, open_app, open_make_book


def test_make_a_book_screen_has_the_plan_check_switches(make_context, ai_server):
    page = open_app(make_context(), ai_server)
    open_make_book(page)
    dlg = page.locator("#mab-dialog")
    doc = dlg.locator("[data-testid=mb-story-doctor]")
    voices = dlg.locator("[data-testid=mb-voice-contrast]")
    doc.wait_for(timeout=10000)
    assert doc.is_checked() and voices.is_checked()
    assert dlg.get_by_label("Story doctor: check and mend the plan before chapter 1").count() == 1
    assert dlg.get_by_label("Make sure every character sounds different").count() == 1
    assert "Plan scored 7.4 → 8.6" in dlg.locator("#mb-story-doctor-hint").inner_text()
    body = _start_body(page, dlg)
    assert not {"story_doctor", "doctor_rounds", "doctor_target", "voice_contrast"} & set(body)  # defaults: none sent
    dlg.locator("[data-testid=mb-story-doctor-rounds]").select_option("3")
    dlg.locator("[data-testid=mb-story-doctor-target]").select_option("9")
    body = _start_body(page, dlg)
    assert body.get("doctor_rounds") == 3 and body.get("doctor_target") == 9
    doc.uncheck()
    voices.uncheck()
    assert dlg.locator("[data-testid=mb-story-doctor-rounds]").is_disabled()
    body = _start_body(page, dlg)
    assert body.get("story_doctor") is False and body.get("voice_contrast") is False and "doctor_rounds" not in body
    assert_clean(page, "make-a-book plan check")
