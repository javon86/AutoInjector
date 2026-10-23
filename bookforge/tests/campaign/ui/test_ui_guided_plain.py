"""The guided path ("📘 Make my book") as an author meets it, from the acceptance run's findings:

- the book page follows the wizard's Bible Builder by itself (no reload): "still making…" turns into the drafts, and
  after "Create selected as drafts" + closing the dialog the canon step lists them to approve (not a loop back into the
  Bible Builder); the sidebar's Current task follows right away;
- a refused chapter outline is explained in plain words (which chapter, which place), offers Redo/Edit, a redo that is
  refused again is an amber "needs fixing" (not a green "Done"), and the outline editor is a plain one (what happens,
  whose eyes, where — chosen from the book's characters and places);
- a chapter is read and changed in a plain reader/editor, and the changed chapter waits on the book page with Approve;
- approval dialogs name drafts in words ("Book format: page size"), never record ids, and read as English;
- a restore says when the backup was made in words; the sidebar does not warn about out-of-date working drafts.
"""
from __future__ import annotations

import re
import threading
import time

from .test_ui_followthrough import autobook, fill_wizard, wait_bb_idle, wait_book_msg
from .ui_helpers import assert_clean, goto, open_app, settle, shot

CODE_RE = re.compile(r"\b[A-Z]{3,}(?:_[A-Z]+)+\b")          # error/rule codes such as CANON_UNRESOLVED
RID_RE = re.compile(r"\b[A-K]\d\d-[0-9a-f]{8,}\b")          # record ids such as B11-2426590719794f46


def book_api(server, pid):
    return server.api("GET", f"/projects/{pid}/branches/main/book")


def step_of(server, pid, sid):
    return next(s for s in book_api(server, pid)["steps"] if s["id"] == sid)


def yes(page):
    page.get_by_role("button", name="✔ Yes, I approve").click()


# ------------------------------------------------------------------------------------------------ item 1 + 5
def test_book_page_follows_the_wizard_bible_builder_without_reload(make_context, ai_server, bridge):
    bridge.gate = threading.Event()          # the AI "thinks" until the test lets it answer
    try:
        page = open_app(make_context(), ai_server, "#/start")
        pid = fill_wizard(page, "Follows By Itself", chars=1, places=1, world=0)
        page.wait_for_function("() => /still making/.test(document.querySelector('#step-canon').innerText)", timeout=10000)
    finally:
        bridge.gate.set()
        bridge.gate = None
    wait_bb_idle(ai_server, pid)
    # no reload: the note turns into the drafts by itself
    page.wait_for_function("""() => { const t = document.querySelector('#step-canon').innerText;
        return !/still making/.test(t) && /Review and save them/.test(t); }""", timeout=15000)
    note = page.inner_text("#step-canon .bb-wizard")
    assert "(character)" in note and "(place)" in note and not re.search(r"\(A0\d\)", note), note
    page.locator("#main .book-top button", has_text="Do the next step").click()
    dlg = page.locator("#bible-dialog")
    dlg.get_by_role("button", name="Create selected as drafts").wait_for(timeout=15000)
    page.wait_for_function("() => !document.querySelector('#bible-dialog button.primary[disabled]')", timeout=15000)
    dlg.get_by_role("button", name="Create selected as drafts").click()
    dlg.locator(".bb-created").wait_for(timeout=15000)
    page.keyboard.press("Escape")
    # the page redraws on close: the drafts are listed to approve, and the sidebar counts them at once
    page.wait_for_function("""() => { const t = document.querySelector('#step-canon').innerText;
        return !/not saved yet/.test(t) && /Approve/.test(t); }""", timeout=5000)
    page.wait_for_function("() => /\\((2|3)\\)/.test(document.querySelector('#nav-task .count-badge').innerText)", timeout=4000)
    # "Do the next step" now approves (it does not reopen the Bible Builder)
    page.locator("#main .book-top button", has_text="Do the next step").click()
    dialog = page.locator("dialog[open]")
    dialog.get_by_role("button", name="✔ Yes, I approve").wait_for(timeout=5000)
    txt = dialog.inner_text()
    assert "You are approving these characters and places." in txt, txt
    assert not RID_RE.search(txt) and not re.search(r"\bA0\d\b", txt), txt
    yes(page)
    wait_book_msg(page)
    assert step_of(ai_server, pid, "canon")["state"] == "done"
    # the sidebar's Current task is the premise now, without waiting for its 10 s refresh
    page.wait_for_function("() => /Premise/i.test(document.querySelector('#nav-task .task-btn').innerText)", timeout=4000)
    assert_clean(page, "wizard canon")


# ------------------------------------------------------------------------------------------------ items 2 + 3 + 4
def setup_refused_outline(server, bridge, title):
    """A book with one approved character and no places whose AI outline names an unknown place."""
    pid = server.api("POST", "/projects", {"name": title, "profile": {"title": title, "author": "T. Ester", "length": "short_story",
                                                                       "idea": "A cartographer maps a city that moves at night."},
                                           "features": {"character_arcs": True}, "release_profiles": ["MANUSCRIPT_PDF"]})["project_id"]
    sess = server.api("POST", "/bible-builder", {"project_id": pid, "branch_id": "main", "idea": "A cartographer maps a moving city.",
                                                 "counts": {"A01": 1}})
    s = wait_bb_idle(server, pid)
    server.api("POST", f"/bible-builder/{sess['session_id']}/create", {"items": [i["key"] for i in s["items"]]})
    b = f"/projects/{pid}/branches/main/book"
    canon = step_of(server, pid, "canon")
    server.api("POST", b + "/approve", {"record_ids": [i["record_id"] for i in canon["approve"]], "author_confirms": True})
    for op, sid in (("B01", "premise"), ("B03", "plot")):
        server.api("POST", b + "/create", {"op": op})
        server.api("POST", b + "/approve", {"record_ids": [i["record_id"] for i in step_of(server, pid, sid)["approve"]],
                                            "author_confirms": True})
        assert step_of(server, pid, sid)["state"] == "done"
    return pid


def test_refused_outline_in_plain_words_redo_and_plain_editor(make_context, ai_server, bridge):
    polite = bridge.ai._canon_ids
    bridge.ai._canon_ids = lambda ctx: (polite(ctx)[0], "gullhaven-harbor")   # the stock fake invents a place
    try:
        pid = setup_refused_outline(ai_server, bridge, "No Harbor Here")
        ai_server.api("POST", f"/projects/{pid}/branches/main/book/create", {"op": "B11"})
        assert step_of(ai_server, pid, "outline")["approve"][0].get("problems"), "the outline should be refused"
        page = open_app(make_context(), ai_server, f"#/p/{pid}/main/book")
        page.locator("#main .book-top button", has_text="Do the next step").click()
        page.wait_for_selector("#main .book-msg .state.failed", timeout=5000)
        msg = page.inner_text("#main .book-msg")
        assert not CODE_RE.search(msg) and not RID_RE.search(msg) and "/chapters/" not in msg, msg
        assert "Chapter 1" in msg and "Gullhaven Harbor" in msg and "place" in msg, msg
        assert "Redo with AI" in msg and "Edit it" in msg, msg
        step = page.inner_text("#step-outline")
        assert not RID_RE.search(step) and "Chapter outline" in step, step
        # 🔧 Details shows the rule text for power users
        page.locator("#main .tech-toggle").first.click()
        assert "CANON_UNRESOLVED" in page.inner_text("#main .book-msg")
        page.locator("#main .tech-toggle").first.click()
        # Redo with AI: refused again -> amber "needs fixing", not a green "Done"
        page.locator("#main .book-msg button", has_text="Redo with AI").first.click()
        wait_book_msg(page)
        box = page.locator("#main .book-msg .state").first
        cls = box.get_attribute("class")
        text = box.inner_text()
        assert "fix" in cls.split() and "ok" not in cls.split(), (cls, text)
        assert "needs fixing" in text and not CODE_RE.search(text), text
        assert "Redo with AI" in text and "Edit it" in text
        page.wait_for_function("() => /needs fixing/.test(document.querySelector('#live').textContent)", timeout=3000)
        assert not CODE_RE.search(page.text_content("#live")), "the screen-reader announcement carries no rule codes"
    finally:
        bridge.ai._canon_ids = polite
    # ✏️ Edit it: the plain outline editor, not the record view
    page.locator("#main .book-msg a", has_text="Edit it").first.click()
    page.wait_for_selector("#main fieldset.outline-chapter", timeout=10000)
    main = page.inner_text("#main")
    assert "What happens" in main and "Where it happens" in main and "Told through the eyes of" in main
    assert not re.search(r"[Vv]alue type|predicate|subject_id|content hash|Dependency", main), main
    place = page.locator("#sd-place-0")
    assert "not one of your places" in place.inner_text()
    for i in range(page.locator("fieldset.outline-chapter").count()):
        page.select_option(f"#sd-place-{i}", value="")
    page.get_by_role("button", name="💾 Save as a new version").click()
    page.wait_for_function("() => /Approve this version/.test(document.querySelector('#main').innerText)", timeout=10000)
    assert "BookForge’s checks found problems" not in page.inner_text("#main")
    page.get_by_role("button", name="✔ Approve this version").click()
    yes(page)
    page.wait_for_url(re.compile(r"/book$"), timeout=10000)
    settle(page, 400)
    assert step_of(ai_server, pid, "outline")["state"] == "done"
    assert_clean(page, "refused outline")


# ------------------------------------------------------------------------------------------------ items 3 + 7 + 2
def test_read_and_change_a_chapter_then_approve_it_on_the_book_page(make_context, ai_server):
    pid = autobook(ai_server)
    page = open_app(make_context(), ai_server, f"#/p/{pid}/main/book")
    chapters = page.inner_text("#step-chapters")
    assert "Chapter 1" in chapters and not re.search(r"\bch\d\b", chapters), chapters
    # the plain reader: the chapter as text, the developer view only behind 🔧 Details
    page.locator("#step-chapters li[data-chapter] a", has_text="Read").first.click()
    page.wait_for_selector("#main .simple-doc .prose", timeout=10000)
    reader = page.inner_text("#main")
    assert "Chapter 1" in reader and not re.search(r"content hash|Dependency edges|Provenance|Raw JSON", reader), reader
    assert not page.locator("#main a", has_text="Developer view").is_visible()
    page.get_by_role("button", name="✏️ Change it").click()
    page.fill("#sd-title", "The Dark Lamp")
    body = page.input_value("#sd-text")
    page.fill("#sd-text", body + "\n\nShe closed the log and listened to the sea.")
    page.get_by_role("button", name="💾 Save as a new version").click()
    page.wait_for_function("() => /waiting for your approval/.test(document.querySelector('#main').innerText)", timeout=10000)
    assert "listened to the sea" in page.inner_text("#main .simple-doc")
    # the book page shows the waiting revision of the approved chapter, with Approve
    goto(page, f"#/p/{pid}/main/book")
    li = page.locator("#step-chapters li[data-chapter]").first
    assert "Your changes wait for approval" in li.inner_text()
    li.get_by_role("button", name="✔ Approve the new version").click()
    dialog = page.locator("dialog[open]")
    txt = dialog.inner_text()
    assert "You are approving the new version of Chapter 1." in txt and not RID_RE.search(txt), txt
    yes(page)
    wait_book_msg(page)
    ch = step_of(ai_server, pid, "chapters")["chapters"][0]
    assert ch["approved"]["version"] == 2, ch
    assert "Your changes wait for approval" not in page.inner_text("#step-chapters")
    # the sidebar does not warn about out-of-date working drafts nobody approved
    for warn in page.locator("#sidenav .set-warn").all():
        assert "approved part" in (warn.get_attribute("title") or "")
    recs = ai_server.api("GET", f"/projects/{pid}/branches/main/records")
    used = {r["module_id"][0] for r in recs if r["stale"] and r["approved_version"]}
    shown = {g.get_attribute("class").split("set-")[-1][0] for g in page.locator("#sidenav .set-group:has(.set-warn)").all()}
    assert shown == used, (shown, used)
    assert_clean(page, "chapter edit")


def test_approval_dialogs_name_format_settings_in_words(make_context, ai_server):
    pid = autobook(ai_server)
    prof = ai_server.api("GET", f"/projects/{pid}/profile")
    ai_server.api("PUT", f"/projects/{pid}/profile", dict(prof, title="A New Title"))
    ai_server.api("POST", f"/projects/{pid}/branches/main/book/setup_format", {})
    page = open_app(make_context(), ai_server, f"#/p/{pid}/main/book")
    page.wait_for_function("() => /Book format: title and author/.test(document.querySelector('#step-format').innerText)", timeout=5000)
    fmt = page.inner_text("#step-format")
    assert not RID_RE.search(fmt) and "I01" not in fmt, fmt
    page.locator("#main .book-top button", has_text="Do the next step").click()
    dialog = page.locator("dialog[open]")
    dialog.get_by_role("button", name="✔ Yes, I approve").wait_for(timeout=5000)
    txt = dialog.inner_text()
    assert "You are approving the book format." in txt, txt
    assert "Book format: title and author" in txt and "Book format: PDF settings" in txt, txt
    assert not RID_RE.search(txt) and "I01" not in txt, txt
    dialog.get_by_role("button", name="Cancel").click()
    behind = page.locator("#main .book-tech .tech-block")
    assert not behind.is_visible() and "A01 → B01" in behind.inner_text()
    assert_clean(page, "format names")


# ------------------------------------------------------------------------------------------------ item 2 (restore) + 6
def test_restore_toast_and_settings_and_pairing_wording(make_context, server, bridge):
    server.api("POST", "/projects", {"name": "Backed Up Book", "profile": {"title": "Backed Up Book"}})
    server.api("POST", "/backups", {})
    page = open_app(make_context(), server, "#/settings")
    codes = set(CODE_RE.findall(page.inner_text("#main"))) - {"ANTHROPIC_API_KEY"}   # an env variable name is fine
    assert not codes, codes
    card = page.locator("section.card", has=page.locator("#bk-h"))
    card.get_by_role("button", name="↩ Restore").first.click()
    dlg = page.locator("dialog[open]")
    dlg.locator("input[type=checkbox]").check()
    dlg.locator("input[type=text]").fill("RESTORE")
    dlg.get_by_role("button", name="↩ Restore this backup").click()
    page.wait_for_function("() => !document.querySelector('dialog[open]')", timeout=60000)
    toast = page.inner_text("#toast")
    assert "restored from the backup of" in toast and not re.search(r"\d{4}-\d\d-\d\dT|bk-\d+", toast), toast
    # the server's own message is plain too (other clients show it as it is)
    names = [b["name"] for b in server.api("GET", "/backups")["backups"] if b["reason"] == "manual"]
    out = server.api("POST", f"/backups/{names[0]}/restore", {"author_confirms": True, "confirm": "RESTORE"})
    assert not re.search(r"\d{4}-\d\d-\d\dT|bk-\d+", out["message"]) and "UTC" in out["message"], out["message"]
    # the pairing question is a question, not a "Blocked" state
    page.goto(server.base + f"#/pair?code=GOOD-1234-5678&bridge={bridge.url}")
    page.get_by_role("button", name="Cancel").wait_for(timeout=10000)
    q = page.inner_text("#main .state")
    assert "Blocked" not in q and "Please confirm" in page.locator("#main .state h3").text_content(), q
    page.get_by_role("button", name="Cancel").click()
    page.bf_problems.clear()
