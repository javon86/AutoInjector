"""Round-2 review: the plain chapter editor after a version conflict. A newer version saved while the author was typing
(another window, an AI job) made the save fail with "Reload it, then make your change again" - and the reload threw the
author's typed draft away (it was kept only for the version it was started on). Now the save says the text is kept,
offers to load the newest version, and the draft comes back on top of it with a notice; saving then works."""
from __future__ import annotations

from .test_ui_followthrough import autobook
from .ui_helpers import assert_clean, open_app


def test_conflict_keeps_the_typed_chapter_and_saves_it_on_the_newest_version(make_context, ai_server):
    pid = autobook(ai_server)
    ch = ai_server.api("GET", f"/projects/{pid}/branches/main/book")
    ch = next(s for s in ch["steps"] if s["id"] == "chapters")["chapters"][0]
    rid = ch["approved"]["record_id"]
    page = open_app(make_context(), ai_server, f"#/p/{pid}/main/write/{rid}/edit")
    page.wait_for_selector("#sd-text", timeout=10000)
    body = page.input_value("#sd-text")
    page.fill("#sd-text", body + "\n\nMY TYPED PARAGRAPH survives a conflict.")
    # meanwhile another window saves a newer version
    det = ai_server.api("GET", f"/projects/{pid}/branches/main/records/{rid}")
    cur = det["versions"][-1]
    out = ai_server.api("POST", "/dispatch", {"request": {
        "project_id": pid, "branch_id": "main", "target_operation": "C02", "action": "UPDATE",
        "payload": dict(cur["data"], text=cur["data"]["text"] + "\n\nOTHER WINDOW paragraph."),
        "base_ref": cur["ref"], "input_refs": [], "idempotency_key": "other-window-1"}})
    assert out["response"]["output_refs"], out
    page.get_by_role("button", name="💾 Save as a new version").click()
    page.wait_for_selector("[data-load-newest]", timeout=10000)
    txt = page.inner_text("#main")
    assert "Your changes are kept" in txt and "make your change again" not in txt, txt
    page.click("[data-load-newest]")
    page.wait_for_function("() => /Your unsaved changes are back, on top of the newest version/.test(document.querySelector('#main').innerText)",
                           timeout=10000)
    assert "MY TYPED PARAGRAPH" in page.input_value("#sd-text")
    # a plain reload also brings it back (never silently discarded)
    page.reload()
    page.wait_for_selector("#sd-text", timeout=10000)
    assert "MY TYPED PARAGRAPH" in page.input_value("#sd-text")
    page.get_by_role("button", name="💾 Save as a new version").click()
    page.wait_for_function("() => /waiting for your approval/.test(document.querySelector('#main').innerText)", timeout=10000)
    det = ai_server.api("GET", f"/projects/{pid}/branches/main/records/{rid}")
    assert det["versions"][-1]["version"] == cur["version"] + 2
    assert "MY TYPED PARAGRAPH" in det["versions"][-1]["data"]["text"]
    assert_clean(page, "edit conflict")


def test_discard_shows_the_newest_version(make_context, ai_server):
    pid = autobook(ai_server)
    ch = ai_server.api("GET", f"/projects/{pid}/branches/main/book")
    rid = next(s for s in ch["steps"] if s["id"] == "chapters")["chapters"][0]["approved"]["record_id"]
    page = open_app(make_context(), ai_server, f"#/p/{pid}/main/write/{rid}/edit")
    page.wait_for_selector("#sd-text", timeout=10000)
    page.fill("#sd-text", "DRAFT ON OLD VERSION")
    det = ai_server.api("GET", f"/projects/{pid}/branches/main/records/{rid}")
    cur = det["versions"][-1]
    ai_server.api("POST", "/dispatch", {"request": {
        "project_id": pid, "branch_id": "main", "target_operation": "C02", "action": "UPDATE",
        "payload": dict(cur["data"], text=cur["data"]["text"] + "\n\nNEWEST paragraph."),
        "base_ref": cur["ref"], "input_refs": [], "idempotency_key": "other-window-2"}})
    page.reload()
    page.wait_for_selector("[data-discard-draft]", timeout=10000)
    page.click("[data-discard-draft]")
    page.wait_for_function("() => /NEWEST paragraph/.test(document.querySelector('#sd-text').value)", timeout=10000)
    assert "DRAFT ON OLD VERSION" not in page.input_value("#sd-text")
