"""Follow-through in the browser: create a book with the 🚀 wizard, save the wizard's characters/places from the Bible
Builder, then press "▶ Do the next step" (and confirm approvals) until the book is made; download the files. After
every step the page must agree with the API (steps done, the next step, the approvals count) and survive a reload."""
from __future__ import annotations

import hashlib
import re
import time

import pytest

from .ui_helpers import assert_clean, goto, open_app, settle, shot

IDEA = "A lighthouse keeper vanishes; his apprentice searches the fog-bound harbor for him."


def fill_wizard(page, title, *, chars=1, places=1, world=0, ai="Automatic", length="short_story"):
    goto(page, "#/start")
    # empty title: the error is shown next to the form and the title gets the focus
    page.fill("#wz-title", "")
    page.get_by_role("button", name="Next ▶").click()
    err = page.locator("#main .wz-card [role=alert], #main .wz-card .state.failed")
    err.first.wait_for(timeout=3000)
    assert "title" in err.first.inner_text().lower()
    assert page.evaluate("document.activeElement && document.activeElement.id") == "wz-title"
    page.fill("#wz-title", title)
    page.fill("#wz-author", "K. C. Tester")
    page.fill("#wz-genre", "Mystery")
    page.select_option("#wz-audience", label="Adult")
    page.select_option("#wz-length", value=length)
    page.fill("#wz-tone", "Spooky")
    page.fill("#wz-idea", IDEA)
    page.get_by_role("button", name="Next ▶").click()
    page.get_by_text("Manual — I’ll write it myself").wait_for()
    page.get_by_text(ai, exact=True).first.click()
    page.get_by_role("button", name="Next ▶").click()
    settle(page)
    nums = page.locator("#main input.wz-num")
    for i, v in enumerate((chars, places, world)):
        nums.nth(i).fill(str(v))
        nums.nth(i).dispatch_event("change")
    page.get_by_role("button", name="Next ▶").click()
    settle(page)
    review = page.inner_text("#main .wz-card")
    assert title in review and "Short story" in review
    page.get_by_role("button", name="🚀 Create my book").click()
    page.wait_for_url(re.compile(r"#/p/[^/]+/main/book$"), timeout=20000)
    settle(page, 400)
    return page.url.split("#/p/")[1].split("/")[0]


def wait_bb_idle(server, pid, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = server.api("GET", f"/bible-builder?project_id={pid}&branch_id=main")
        s = r.get("session")
        if s and not s.get("busy") and s.get("items"):
            return s
        time.sleep(0.3)
    raise AssertionError(f"Bible Builder did not finish: {r}")


def wait_book_msg(page, timeout=60000):
    page.wait_for_function("""() => { const m = document.querySelector('#main .book-msg');
        return m && !m.querySelector('.state.loading, .spinner'); }""", timeout=timeout)
    settle(page, 250)


def ui_book(page):
    top = page.inner_text("#main .book-top")
    m = re.search(r"(\d+) of (\d+) steps done", top)
    nxt = page.locator("#main .book-top button", has_text="Do the next step")
    return {"done": int(m.group(1)), "total": int(m.group(2)),
            "next": nxt.inner_text().split("Do the next step:")[-1].strip() if nxt.count() else None,
            "made": "Your book is made" in top}


def api_book(server, pid):
    b = server.api("GET", f"/projects/{pid}/branches/main/book")
    step = next((s for s in b["steps"] if s["id"] == b["next"]), None)
    return {"done": b["done_count"], "total": b["total"], "next": step["title"] if step else None, "raw": b}


def approvals_count(page):
    t = page.locator("#nav-task .count-badge").inner_text()
    m = re.search(r"\d+", t)
    return int(m.group(0)) if m else None


def test_wizard_to_downloaded_book(make_context, ai_server, tmp_path):
    ctx = make_context()
    page = open_app(ctx, ai_server, "#/start")
    pid = fill_wizard(page, "The Lantern Test", chars=1, places=1, world=0)
    proj = ai_server.api("GET", f"/projects/{pid}")
    assert proj["profile"]["title"] == "The Lantern Test" and proj["profile"]["length"] == "short_story"
    assert proj["profile"]["author"] == "K. C. Tester"

    # the wizard asked the AI for 1 character + 1 place: save them from the Bible Builder
    wait_bb_idle(ai_server, pid)
    page.get_by_role("button", name="📖 Bible Builder").click()
    dlg = page.locator("#bible-dialog")
    dlg.get_by_role("button", name="Create selected as drafts").wait_for(timeout=15000)
    page.wait_for_function("() => !document.querySelector('#bible-dialog button.primary[disabled]')", timeout=15000)
    sel = dlg.locator("#bb-sel-count").inner_text()
    assert sel.startswith("2 of 2"), sel
    dlg.get_by_role("button", name="Create selected as drafts").click()
    dlg.locator(".bb-created").wait_for(timeout=15000)
    page.keyboard.press("Escape")
    assert not dlg.is_visible()
    goto(page, f"#/p/{pid}/main/book")
    recs = ai_server.api("GET", f"/projects/{pid}/branches/main/records")
    assert sorted(r["module_id"] for r in recs) == ["A01", "A04"], recs

    trail = []
    for i in range(40):
        ub, ab = ui_book(page), api_book(ai_server, pid)
        # the page shows what the API says (steps done, the next step)
        assert (ub["done"], ub["total"]) == (ab["done"], ab["total"]), (i, ub, ab, trail)
        assert ub["next"] == ab["next"], (i, ub, ab, trail)
        q = ai_server.api("GET", f"/projects/{pid}/branches/main/review/summary")
        page.wait_for_function("n => { const b = document.querySelector('#nav-task .count-badge'); return b && b.textContent.includes('(' + n + ')'); }",
                               arg=q["count"], timeout=12000)
        if ub["made"] or not ub["next"]:
            break
        trail.append(ub["next"])
        page.locator("#main .book-top button", has_text="Do the next step").click()
        page.wait_for_timeout(300)
        yes = page.get_by_role("button", name="✔ Yes, I approve")
        if yes.count():
            yes.click()
        if page.locator("#make-dialog[open]").count():
            pytest.fail(f"the next step opened the Make dialog although characters exist: {trail}")
        wait_book_msg(page)
        msg = page.inner_text("#main .book-msg")
        assert "Failed" not in msg and "did not work" not in msg, (trail, msg)
        if len(trail) > 4 and trail[-1] == trail[-2] == trail[-3] == trail[-4]:
            shot(page, "followthrough_stuck")
            pytest.fail(f"stuck on {trail[-1]}: {msg}")
    else:
        pytest.fail(f"book not made after 40 steps: {trail}")
    ab = api_book(ai_server, pid)
    assert ab["done"] == ab["total"]

    # download every file from the export step; bytes must be the exported, hash-checked files
    files = next(s for s in ab["raw"]["steps"] if s["id"] == "export")["files"]
    assert {f["format"] for f in files} == {"PDF", "EPUB", "DOCX"}
    for f in files:
        with page.expect_download(timeout=15000) as dl:
            page.locator("#step-export .downloads button", has_text=f["format"]).click()
        d = dl.value
        path = tmp_path / d.suggested_filename
        d.save_as(path)
        data = path.read_bytes()
        assert d.suggested_filename == f"The Lantern Test.{f['format'].lower()}"
        assert hashlib.sha256(data).hexdigest() == f["sha256"], f
        assert data[:4] == (b"%PDF" if f["format"] == "PDF" else b"PK\x03\x04")
    # after a reload the page still says the book is made
    page.reload()
    page.wait_for_selector("#main .book-top", timeout=15000)
    settle(page)
    assert ui_book(page)["made"]
    assert_clean(page, "follow-through")


def autobook(server):
    r = server.api("POST", "/autobook", {"author_confirms": True})
    for _ in range(300):
        s = server.api("GET", "/autobook/" + r["id"])
        if s["status"] not in ("queued", "running", "pausing"):
            break
        time.sleep(0.2)
    assert s["status"] == "done", s
    return s["project_id"]


@pytest.mark.xfail(strict=True, reason="NEW-ui-1: following 'Do the next step' (characters only, no places) leads to "
                   "a chapter outline that can never be approved: the B11 prompt says 'use null for an undecided "
                   "location' but approval refuses null (PLAN_UNDECIDED) and any invented id (CANON_UNRESOLVED); the "
                   "canon step is 'done' with A01 only (book_path.py:281-287, set_b.py:294-302, set_b.py:654)")
def test_guided_path_without_places_reaches_a_made_book(make_context, ai_server):
    ctx = make_context()
    page = open_app(ctx, ai_server, "#/start")
    pid = fill_wizard(page, "No Places Book", chars=0, places=0, world=0)
    # "Do the next step" on the canon step opens "Make up characters"
    page.locator("#main .book-top button", has_text="Do the next step").click()
    d = page.locator("#make-dialog")
    d.wait_for(state="visible")
    d.locator("select").first.select_option("1")
    d.get_by_role("button", name="✨ Generate").click()
    d.get_by_role("button", name="Save the ticked ones as drafts").wait_for(timeout=20000)
    page.wait_for_function("() => !document.querySelector('#make-dialog .mk-results button.primary[disabled]')",
                           timeout=20000)
    d.get_by_role("button", name="Save the ticked ones as drafts").click()
    d.get_by_text("Saved as draft").first.wait_for(timeout=15000)
    d.get_by_role("button", name="Close (running work continues)").click()
    goto(page, f"#/p/{pid}/main/book")
    msgs = []
    for _ in range(12):
        ub = ui_book(page)
        if ub["made"] or (ub["next"] or "").startswith("Write the chapters"):
            break
        page.locator("#main .book-top button", has_text="Do the next step").click()
        page.wait_for_timeout(300)
        yes = page.get_by_role("button", name="✔ Yes, I approve")
        if yes.count():
            yes.click()
        wait_book_msg(page)
        msgs.append(page.inner_text("#main .book-msg"))
        if "Failed" in msgs[-1]:
            shot(page, "NEW-ui-1_outline_dead_end")
            break
    b = api_book(ai_server, pid)["raw"]
    outline = next(s for s in b["steps"] if s["id"] == "outline")
    assert outline["state"] == "done", (outline, msgs[-1:])


def epub_title(data: bytes) -> str:
    import io
    import zipfile
    z = zipfile.ZipFile(io.BytesIO(data))
    opf = next(n for n in z.namelist() if n.endswith(".opf"))
    m = re.search(r"<dc:title[^>]*>([^<]*)</dc:title>", z.read(opf).decode("utf-8"))
    return m.group(1) if m else ""


def test_profile_dialog_validation_and_persistence(make_context, ai_server):
    pid = autobook(ai_server)
    ctx = make_context()
    page = open_app(ctx, ai_server, f"#/p/{pid}/main/book")
    page.get_by_role("button", name="📝 Book profile").click()
    dlg = page.locator("dialog[open]")
    title = dlg.locator("input[id$='-title']")
    assert title.input_value() == "The Keeper of Gullhaven"
    # Escape closes without saving
    title.fill("Not saved")
    page.keyboard.press("Escape")
    assert not page.locator("dialog[open]").count()
    assert ai_server.api("GET", f"/projects/{pid}/profile")["title"] == "The Keeper of Gullhaven"
    page.get_by_role("button", name="📝 Book profile").click()
    # valid: saved, survives a reload, shown in the page
    dlg = page.locator("dialog[open]")
    dlg.locator("input[id$='-title']").fill("The Lantern Keeper")
    dlg.locator("input[id$='-author']").fill("Ana Ö. Writer")
    dlg.get_by_role("button", name="Save profile").click()
    page.locator("#toast:not([hidden])").wait_for(timeout=5000)
    assert ai_server.api("GET", f"/projects/{pid}/profile")["title"] == "The Lantern Keeper"
    page.reload()
    page.wait_for_selector("#main .book-top", timeout=15000)
    page.get_by_role("button", name="📝 Book profile").click()
    dlg = page.locator("dialog[open]")
    assert dlg.locator("input[id$='-title']").input_value() == "The Lantern Keeper"
    assert dlg.locator("input[id$='-author']").input_value() == "Ana Ö. Writer"
    page.keyboard.press("Escape")
    assert_clean(page, "profile dialog")


@pytest.mark.xfail(strict=True, reason="NEW-ui-3: the 📝 Book profile dialog saves an empty title (no check in the "
                   "dialog, PUT /projects/{id}/profile accepts it: book_path.py:95 save_profile/clean_profile); the "
                   "wizard insists on a title, and the book page then drops the profile step back to 'needs you'")
def test_profile_dialog_refuses_an_empty_title(make_context, ai_server):
    pid = autobook(ai_server)
    ctx = make_context()
    page = open_app(ctx, ai_server, f"#/p/{pid}/main/book")
    # empty title: refused, the problem is shown at the title field, the dialog stays open
    page.get_by_role("button", name="📝 Book profile").click()
    dlg = page.locator("dialog[open]")
    dlg.locator("input[id$='-title']").fill("")
    dlg.get_by_role("button", name="Save profile").click()
    page.wait_for_timeout(600)
    profile = ai_server.api("GET", f"/projects/{pid}/profile")
    if dlg.count():
        txt = dlg.inner_text()
        assert dlg.locator("input[id$='-title'][aria-invalid=true]").count() or "title" in txt.lower(), txt
    assert profile["title"] == "The Keeper of Gullhaven", "an empty title was saved"


@pytest.mark.xfail(strict=True, reason="NEW-ui-2: after the title is changed on a finished book nothing becomes "
                   "stale: the book stays 'made' (10/10, no button to export again) and the download is named with "
                   "the NEW title but the EPUB inside still carries the OLD title (book_path status ignores the "
                   "profile's updated_at; app.js downloadAsset names the file from the current profile)")
def test_retitled_finished_book_is_not_downloaded_with_stale_metadata(make_context, ai_server, tmp_path):
    pid = autobook(ai_server)
    prof = ai_server.api("GET", f"/projects/{pid}/profile")
    prof["title"] = "A Brand New Title"
    ai_server.api("PUT", f"/projects/{pid}/profile", prof)
    ctx = make_context()
    page = open_app(ctx, ai_server, f"#/p/{pid}/main/book")
    still_made = ui_book(page)["made"]
    with page.expect_download(timeout=15000) as dl:
        page.locator("#step-export .downloads button", has_text="EPUB").click()
    d = dl.value
    p = tmp_path / d.suggested_filename
    d.save_as(p)
    inside = epub_title(p.read_bytes())
    if still_made:
        shot(page, "NEW-ui-2_retitled_book_still_made")
    # either the book asks to export again, or the file it hands out matches its name/title
    assert (not still_made) or inside == "A Brand New Title", (d.suggested_filename, inside)


@pytest.mark.xfail(strict=True, reason="NEW-ui-6: the characters/places the 🚀 wizard asks the AI for are generated "
                   "into a Bible Builder session but never saved or shown on the guided path: the book's step stays "
                   "'AI can do it' and 'Do the next step' opens an empty 'Make up characters' dialog (A01 only), so the "
                   "wizard's places are lost unless the author finds 📖 Bible Builder (app.js viewStart -> "
                   "POST /bible-builder without /create; book_path canon step counts only saved drafts)")
def test_wizard_canon_reaches_the_guided_path(make_context, ai_server):
    ctx = make_context()
    page = open_app(ctx, ai_server, "#/start")
    pid = fill_wizard(page, "Wizard Canon", chars=1, places=1, world=0)
    s = wait_bb_idle(ai_server, pid)
    names = [i["name"] for i in s["items"] if i["status"] == "done"]
    place = next(i["name"] for i in s["items"] if i["op"] == "A04")
    goto(page, f"#/p/{pid}/main/book")
    step_text = page.inner_text("#step-canon")
    page.locator("#main .book-top button", has_text="Do the next step").click()
    page.wait_for_timeout(800)
    shown = step_text + " " + " ".join(page.locator("dialog[open]").all_inner_texts())
    if place not in shown:
        shot(page, "NEW-ui-6_wizard_canon_hidden")
    assert place in shown, f"the wizard made {names}, the guided path shows none of the place {place!r}"


@pytest.mark.xfail(strict=True, reason="BF-12 (known): 'What's next' on operation pages contradicts the Current task "
                   "(book made, 0 approvals waiting, yet 'What's next: … drafts, none approved yet')")
def test_whats_next_agrees_with_current_task_on_a_made_book(make_context, ai_server):
    pid = autobook(ai_server)
    page = open_app(make_context(), ai_server, f"#/p/{pid}/main/op/B11")
    page.wait_for_function("() => /Your book is made/.test((document.querySelector('#nav-task') || {}).textContent || '')",
                           timeout=12000)
    nxt = page.locator("#main", has_text="What’s next").inner_text() if page.locator("#main", has_text="What’s next").count() else ""
    m = re.search(r"What’s next:[^\n]*", nxt)
    line = m.group(0) if m else ""
    assert not re.search(r"none approved|Validate it and Accept|drafts", line), line


@pytest.mark.xfail(strict=True, reason="BF-13 (known): a 'Short story (about 5,000 words)' of ~190 words is "
                   "reported as made with no length warning")
def test_made_book_far_below_its_length_is_flagged(make_context, ai_server):
    pid = autobook(ai_server)
    page = open_app(make_context(), ai_server, f"#/p/{pid}/main/book")
    b = ai_server.api("GET", f"/projects/{pid}/branches/main/book")
    w = b["words"]
    assert w["words"] < w["target_words"] / 4
    top = page.inner_text("#main .book-top")
    assert "Your book is made" not in top or re.search(r"short|below|too few|length", top, re.I), top
