"""★ Story roles in the browser: the guided "Make my book" canon step lists every character with its role chip and a
⚠️ while no main character is set; "★ Make this the main character" sets it; the character page shows the role
title and a role picker whose "Main character" moves the ★ after a confirm dialog; the record list and the Character
Forge show the role. No browser problems. Screenshots go to $BF_UI_SHOTS (see ui_helpers.shot)."""
from __future__ import annotations

import threading
from http.server import ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from .ui_helpers import assert_clean, goto, settle, shot, watch

from autobook_fake import fact
from test_failover_review import SlotFake, make_app
from test_server import TOKEN


@pytest.fixture
def rb(tmp_path):
    from akowe.book_path import BookPath, save_profile
    from akowe.server import make_handler
    app = make_app(tmp_path, SlotFake(), slots=("AI-1",))
    pid = app.engine.bootstrap_project("author", "Roles UI book")
    save_profile(app.store, pid, {"title": "The Lamplighter's Last Ferry", "length": "short_story",
                                  "idea": "Odile Marsh is the last lamplighter of Vell Harbour."})
    bp = BookPath(app.engine, "author", pid, "main")
    rids = {}
    for n, role in (("Odile Marsh", "The last lamplighter"), ("Tamsin Reed", "The ferry's villain")):
        sid = "-".join(n.lower().split())
        cand = {"concept": n, "attributes": {"role": role}, "linked_refs": [], "protected_fact_flags": [],
                "facts": [fact(sid, "entity.name", n)]}
        ref, _ = bp.create("A01", {"concept": n}, manual_candidate=cand)
        assert bp.act("approve", {"record_ids": [ref["record_id"]], "author_confirms": True})["results"][0]["ok"]
        rids[n] = ref["record_id"]
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    yield SimpleNamespace(app=app, pid=pid, rids=rids, url=f"http://127.0.0.1:{port}/#token={TOKEN}")
    httpd.shutdown()
    httpd.server_close()


def open_page(make_context, rb, **kw):
    page = watch(make_context(**kw).new_page())
    page.goto(rb.url)
    page.wait_for_selector("#main h1", timeout=15000)
    settle(page)
    return page


def test_roles_on_the_guided_path_the_character_page_and_the_forge(make_context, rb):
    from akowe import story_roles
    page = open_page(make_context, rb)
    goto(page, f"#/p/{rb.pid}/main/book")
    box = page.locator("#step-canon [data-testid=cast-roles]")
    box.wait_for(timeout=10000)
    assert "No main character is set yet" in box.inner_text() and "Odile Marsh" in box.inner_text()
    assert page.locator("#step-canon li[data-character='Tamsin Reed'] [data-role=antagonist]").count() == 1  # inferred
    shot(page, "roles-guided")
    page.click("#step-canon li[data-character='Odile Marsh'] [data-testid=make-main]")
    page.wait_for_function("() => !document.querySelector('#step-canon [data-testid=no-protagonist]')", timeout=10000)
    assert story_roles.tagged_protagonist(rb.app.store, rb.pid, "main") == rb.rids["Odile Marsh"]
    # the character page: title + picker; choosing Main character for Tamsin asks first, then moves the ★
    goto(page, f"#/p/{rb.pid}/main/rec/{rb.rids['Tamsin Reed']}")
    page.wait_for_selector("[data-testid=role-picker]", timeout=10000)
    assert "Villain" in page.inner_text("[data-testid=role-head]")
    page.select_option("[data-testid=role-picker]", "protagonist")
    dlg = page.locator("dialog[open]")
    dlg.get_by_role("button", name="★ Yes, make this the main character").wait_for(timeout=5000)
    assert "Odile Marsh" in dlg.inner_text()
    dlg.get_by_role("button", name="★ Yes, make this the main character").click()
    page.wait_for_function("() => /Main character/.test(document.querySelector('[data-testid=role-head]').innerText)",
                           timeout=10000)
    assert story_roles.protagonist_of(rb.app.store, rb.pid, "main")["record_id"] == rb.rids["Tamsin Reed"]
    assert story_roles.story_role(rb.app.store, rb.pid, "main", rb.rids["Odile Marsh"]) == "deuteragonist"
    shot(page, "roles-character-page")
    # the characters list and the Character Forge show the titles
    goto(page, f"#/p/{rb.pid}/main/op/A01")
    page.wait_for_selector("[data-testid=role-chip][data-role=protagonist]", timeout=10000)
    goto(page, f"#/p/{rb.pid}/main/forge")
    page.wait_for_selector("[data-testid=forge-role]", timeout=10000)
    assert "Main character" in " ".join(page.locator("[data-testid=forge-role]").all_inner_texts())
    assert_clean(page, "story roles")
