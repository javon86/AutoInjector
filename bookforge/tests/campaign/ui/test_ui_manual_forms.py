"""The manual path with NO AI connected: the wizard, "Do the next step" opening ready-made forms, empty/invalid/valid
submits with the problem shown at the field, autosaved drafts surviving a reload, approval through the confirm dialog,
and the Settings forms (backup keep, restore guard)."""
from __future__ import annotations

import re

import pytest

from .ui_helpers import assert_clean, goto, open_app, settle, shot


def book_top(page):
    t = page.inner_text("#main .book-top")
    m = re.search(r"(\d+) of (\d+) steps done", t)
    nxt = page.locator("#main .book-top button", has_text="Do the next step")
    return int(m.group(1)), (nxt.inner_text().split(":", 1)[-1].strip() if nxt.count() else None)


def submit(page):
    page.locator("#main form button[type=submit]").first.click()
    settle(page, 600)


def test_manual_path_forms(make_context, server):
    page = open_app(make_context(), server, "#/start")
    # BF-14: a fresh install (no book, no AI) is not a 💛 health warning: those are just not set up yet
    page.wait_for_function("() => document.querySelector('#health-btn').dataset.state !== 'unknown'", timeout=15000)
    assert page.get_attribute("#health-btn", "data-state") == "ok", page.get_attribute("#health-btn", "title")
    # wizard on a server without AI: step 2 says so and offers Manual
    page.fill("#wz-title", "Hand Made")
    page.fill("#wz-idea", "A keeper vanishes; his apprentice searches the harbor.")
    page.select_option("#wz-length", value="short_story")
    page.get_by_role("button", name="Next ▶").click()
    page.get_by_text("Manual — I’ll write it myself").wait_for()
    page.wait_for_function("() => !document.querySelector('#main .wz-card .spinner')", timeout=10000)
    assert "No AI is ready" in page.inner_text("#main .wz-card")
    # BF-14: with no AI ready, Manual is preselected (not "Automatic"), and the page says why
    assert page.locator("#main input[name=wz-ai][value=manual]").is_checked()
    assert not page.locator('#main input[name=wz-ai][value=""]').is_checked()
    assert "“Manual” is selected" in page.inner_text("#main .wz-card")
    page.get_by_text("Manual — I’ll write it myself").click()
    page.get_by_role("button", name="Next ▶").click()
    settle(page)
    # BF-14: manual mode does not promise ready-made forms nor ask for counts it would ignore
    step3 = page.inner_text("#main .wz-card")
    assert "ready-to-fill" not in step3 and "nothing is made for you now" in step3, step3
    assert page.locator("#main .wz-card input[type=number]").count() == 0
    page.get_by_role("button", name="Next ▶").click()
    settle(page)
    assert "I write it myself (no AI)" in page.inner_text("#main .wz-card")
    page.get_by_role("button", name="🚀 Create my book").click()
    page.wait_for_url(re.compile(r"/book$"), timeout=20000)
    settle(page)
    pid = page.url.split("#/p/")[1].split("/")[0]
    assert book_top(page) == (1, "Characters and places")
    # BF-14: the ⚡ on the yellow button sits in a dark disc (a yellow emoji on yellow was invisible)
    bolt = page.locator("#main .mab-cta .mab-cta-bolt").first
    assert bolt.inner_text() == "⚡"
    assert bolt.evaluate("e => getComputedStyle(e).backgroundColor") == "rgb(29, 22, 0)"
    assert page.locator("#main .mab-cta").first.get_attribute("class") and \
        page.get_by_role("button", name="Make a book for me").count() >= 1

    # Do the next step -> the A01 form
    page.locator("#main .book-top button", has_text="Do the next step").click()
    page.wait_for_function("() => location.hash.endsWith('/op/A01')", timeout=10000)
    settle(page, 400)
    concept = page.locator("#main form textarea[id$='_payload_concept']").first
    # empty submit: refused, the problem is at the Concept field, nothing saved
    submit(page)
    assert concept.get_attribute("aria-invalid") == "true"
    summary = page.locator("#main .error-summary").first
    assert "Concept" in summary.inner_text()
    assert server.api("GET", f"/projects/{pid}/branches/main/records") == []
    # typed text is autosaved: it survives a reload before submitting
    concept.fill("Mara Vell, apprentice lighthouse keeper")
    page.wait_for_timeout(1200)
    page.reload()
    page.wait_for_selector("#main form textarea[id$='_payload_concept']", timeout=15000)
    settle(page, 400)
    concept = page.locator("#main form textarea[id$='_payload_concept']").first
    assert concept.input_value() == "Mara Vell, apprentice lighthouse keeper", "the typed text was lost on reload"
    assert concept.get_attribute("aria-invalid") != "true"
    submit(page)
    recs = server.api("GET", f"/projects/{pid}/branches/main/records")
    assert [r["module_id"] for r in recs] == ["A01"] and recs[0]["title"].startswith("Mara Vell")
    # after the save the draft is gone: a reload shows an empty form and the record in the list
    page.reload()
    page.wait_for_selector("#main form textarea[id$='_payload_concept']", timeout=15000)
    settle(page, 400)
    assert page.locator("#main form textarea[id$='_payload_concept']").first.input_value() == ""
    assert "Mara Vell" in page.inner_text("#main")

    # back on the book: approve it with the confirm dialog (Escape first: nothing approved)
    goto(page, f"#/p/{pid}/main/book")
    assert book_top(page) == (1, "Characters and places")
    page.locator("#main .book-top button", has_text="Do the next step").click()
    dlg = page.locator("dialog[open]", has_text="Approve as the author?")
    dlg.wait_for(timeout=5000)
    assert "Mara Vell" in dlg.inner_text()
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)
    assert server.api("GET", f"/projects/{pid}/branches/main/records")[0]["approved_version"] is None
    page.locator("#main .book-top button", has_text="Do the next step").click()
    page.get_by_role("button", name="✔ Yes, I approve").click()
    page.wait_for_function("() => /2 of \\d+ steps done/.test(document.querySelector('#main .book-top').textContent)",
                           timeout=15000)
    assert book_top(page) == (2, "Premise")
    assert server.api("GET", f"/projects/{pid}/branches/main/records")[0]["approved_version"] == 1

    # premise: the next step prepares the B01 form in manual mode
    page.locator("#main .book-top button", has_text="Do the next step").click()
    page.wait_for_function("() => location.hash.endsWith('/op/B01')", timeout=15000)
    settle(page, 500)
    manual = page.locator("#main input[type=checkbox][id^=manual]").first
    assert manual.is_checked(), "the B01 form did not open in manual mode"
    out_fields = page.locator("#main form textarea:visible")
    assert out_fields.count() >= 2
    submit(page)                                # the output is empty: refused at the fields
    invalid = page.locator("#main [aria-invalid=true]").count()
    assert invalid >= 1
    assert not [r for r in server.api("GET", f"/projects/{pid}/branches/main/records") if r["module_id"] == "B01"]
    for i in range(out_fields.count()):
        f = out_fields.nth(i)
        if not f.input_value().strip():
            f.fill(f"Hand-written text {i}: an apprentice searches a foggy harbor.")
    submit(page)
    b01 = [r for r in server.api("GET", f"/projects/{pid}/branches/main/records") if r["module_id"] == "B01"]
    if not b01:
        shot(page, "manual_b01_not_saved")
    assert b01, page.inner_text("#main .error-summary") if page.locator("#main .error-summary").count() else "no B01"
    goto(page, f"#/p/{pid}/main/book")
    assert book_top(page)[1] == "Premise"
    assert_clean(page, "manual path")


def test_settings_backup_forms(make_context, server):
    page = open_app(make_context(), server, "#/settings")
    page.wait_for_selector("#bk-keep", timeout=10000)
    keep = page.locator("#bk-keep")
    orig = keep.input_value()
    # invalid: 0 is refused at the field, the stored value stays
    keep.fill("0")
    keep.locator("xpath=..").get_by_role("button", name="Save").click()
    page.wait_for_timeout(600)
    assert keep.get_attribute("aria-invalid") == "true" or page.locator("#main [role=alert]").count()
    assert str(server.api("GET", "/backups")["keep"]) == orig
    expected = [p for p in page.bf_problems if "/api/backups/settings" in p or "status of 400" in p]
    assert expected, "the invalid value did not reach the server's check"
    page.bf_problems.clear()
    # valid: saved and still there after a reload
    keep.fill("7")
    keep.locator("xpath=..").get_by_role("button", name="Save").click()
    page.locator("#toast:not([hidden])").wait_for(timeout=5000)
    assert server.api("GET", "/backups")["keep"] == 7
    page.reload()
    page.wait_for_selector("#bk-keep", timeout=10000)
    assert page.locator("#bk-keep").input_value() == "7"
    # back up now -> a verified backup is listed
    page.get_by_role("button", name="💾 Back up now").click()
    page.locator("#main .bk-list li").first.wait_for(timeout=15000)
    n = len(server.api("GET", "/backups")["backups"])
    assert n >= 1
    # restore is guarded: unticked / wrong word are refused at the field; Cancel does nothing
    page.locator("#main .bk-list button", has_text="Restore").first.click()
    dlg = page.locator("dialog[open]")
    dlg.get_by_role("button", name="↩ Restore this backup").click()
    page.wait_for_timeout(300)
    assert dlg.locator("input[type=checkbox][aria-invalid=true]").count() == 1
    dlg.locator("input[type=checkbox]").check()
    dlg.locator("input[type=text]").fill("restor")
    dlg.get_by_role("button", name="↩ Restore this backup").click()
    page.wait_for_timeout(300)
    assert dlg.locator("input[type=text][aria-invalid=true]").count() == 1
    dlg.get_by_role("button", name="Cancel").click()
    assert not page.locator("dialog[open]").count()
    assert len(server.api("GET", "/backups")["backups"]) == n, "something was restored or backed up"
    assert_clean(page, "settings")


def test_blank_required_text_is_refused(make_context, server):
    proj = server.api("POST", "/projects", {"name": "Blank Test", "profile": {"title": "Blank Test", "ai_slot": "manual"}})
    pid = proj["project_id"]
    page = open_app(make_context(), server, f"#/p/{pid}/main/op/A01")
    concept = page.locator("#main form textarea[id$='_payload_concept']").first
    concept.fill("   ")
    submit(page)
    recs = server.api("GET", f"/projects/{pid}/branches/main/records")
    if recs:
        goto(page, f"#/p/{pid}/main/op/A01")
        shot(page, "NEW-ui-5_blank_character_saved")
    assert recs == [], f"saved: {[r['title'] for r in recs]!r}"


JARGON = ["HYBRID", "T1 Schema", "Schema/Form Builder", "manual_candidate", "Accepts references from", "Accepts records from",
          "Field concept", "(null)", "for null", "Idempotency", "/base_ref", "stale base", "MISSING_INPUT", "INVALID_INPUT"]


@pytest.mark.parametrize("op", ["A01", "B11", "C01"])
def test_manual_forms_speak_plain_words(make_context, server, op):
    """BF-11: no contract jargon on the author's forms, a one-line hint on every required field, and the
    technical details still there behind 🔧 Details."""
    proj = server.api("POST", "/projects", {"name": f"Plain {op}", "profile": {"title": f"Plain {op}", "ai_slot": "manual"}})
    page = open_app(make_context(), server, f"#/p/{proj['project_id']}/main/op/{op}")
    page.evaluate("() => { try { localStorage.removeItem('bf:show-tech'); } catch (e) {} document.documentElement.classList.remove('show-tech'); }")
    goto(page, f"#/p/{proj['project_id']}/main/op/{op}")
    main = page.inner_text("#main")
    leaked = [w for w in JARGON if w in main]
    assert not leaked, leaked
    # every required field (the Required tag) carries a visible, non-empty hint
    missing = page.evaluate("""() => Array.from(document.querySelectorAll('#main form .field'))
        .filter(f => !f.closest('[hidden]') && f.querySelector(':scope > label .req-tag.required, :scope > legend .req-tag.required, :scope > .check-row label .req-tag.required'))
        .filter(f => { const hint = f.querySelector(':scope > .hint'); return !hint || !hint.innerText.trim(); })
        .map(f => (f.querySelector('label, legend') || f).innerText.trim())""")
    assert missing == [], missing
    # 🔧 Details shows the technical words again (and is remembered)
    page.locator("#main .tech-toggle").first.click()
    shown = page.inner_text("#main")
    assert "Execution" in shown and "Field " in shown, shown[:400]
    page.reload()
    page.wait_for_selector("#main h1", timeout=15000)
    settle(page)
    assert page.evaluate("() => document.documentElement.classList.contains('show-tech')")
    page.locator("#main .tech-toggle").first.click()
    assert not page.evaluate("() => document.documentElement.classList.contains('show-tech')")
    assert_clean(page, f"plain-{op}")


def test_server_refusal_is_shown_in_plain_words(make_context, server):
    """A refusal from the server (here a stale edit: the record changed in between) is explained in words at the
    form, with the error code and pointer only under 🔧 Details."""
    proj = server.api("POST", "/projects", {"name": "Stale Words", "profile": {"title": "Stale Words", "ai_slot": "manual"}})
    pid = proj["project_id"]
    page = open_app(make_context(), server, f"#/p/{pid}/main/op/A01")
    page.locator("#main form textarea[id$='_payload_concept']").first.fill("Ada Quill, cartographer")
    submit(page)
    recs = server.api("GET", f"/projects/{pid}/branches/main/records")
    assert len(recs) == 1, recs
    rid = recs[0]["record_id"]
    goto(page, f"#/p/{pid}/main/edit/{rid}")
    # someone else saves v2 meanwhile
    detail = server.api("GET", f"/projects/{pid}/branches/main/records/{rid}")
    v1 = detail["versions"][-1]
    req = {"project_id": pid, "branch_id": "main", "target_operation": "A01", "action": "UPDATE",
           "payload": dict(v1["data"], concept="Ada Quill, cartographer (other tab)"),
           "base_ref": v1["ref"], "input_refs": [], "idempotency_key": "other-tab-1"}
    out = server.api("POST", "/dispatch", {"request": req})
    assert out["response"]["status"] == "DRAFT", out
    box = page.locator("#main form textarea[id$='_payload_concept'], #main form input[id$='_payload_concept']").first
    box.fill("Ada Quill, cartographer (this tab)")
    page.locator("#main form button[type=submit]").first.click()
    problem = page.locator("#main .error-summary, #main .result-panel .error-list").first
    problem.wait_for(timeout=10000)
    settle(page, 300)
    text = page.inner_text("#main")
    assert "newer version" in text and "v2" in text, text[:1500]
    leaked = [w for w in ("stale base", "/base_ref", "VERSION_CONFLICT") if w in text]
    assert not leaked, leaked
    page.locator("#main .tech-toggle").first.click()
    assert "VERSION_CONFLICT" in page.inner_text("#main")
    page.locator("#main .tech-toggle").first.click()
