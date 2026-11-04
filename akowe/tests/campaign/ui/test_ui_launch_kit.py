"""🚀 Launch kit in the browser: 📤 Export → 🚀 Launch kit opens an empty kit; ✨ Make the launch kit fills every part
through a stand-in AI (7 keyword boxes, 3 categories, comparable titles labelled "to verify", an A+ plan with its
module pictures); the author adds an invented name and a spoiler to the blurb and saves: ⚠️ says what is wrong and
how to fix it; 🔁 Fix with AI rewrites it with the problems; ✔ approve; 📋 Copy puts the field's text on the
clipboard; ⬇ launch-kit.md downloads; no browser problems, no unnamed controls, no sideways scrolling on a phone.
Screenshots go to $BF_UI_SHOTS (see ui_helpers.shot)."""
from __future__ import annotations

import threading
import time
import types
from http.server import ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from .ui_helpers import assert_clean, bad_text, goto, overflow, settle, shot, unnamed_controls, watch

from launch_fake import LaunchFake
from test_failover_review import make_app, run_book
from test_server import TOKEN


@pytest.fixture(scope="module")
def kb(tmp_path_factory):
    from akowe import providers as prov_mod
    from akowe.server import make_handler
    mp = pytest.MonkeyPatch()
    mp.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic, time=time.time))
    tmp = tmp_path_factory.mktemp("launch-ui")
    fake = LaunchFake()
    app = make_app(tmp, fake)
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", run.get("problem")
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    yield SimpleNamespace(app=app, fake=fake, pid=run["project_id"], url=f"http://127.0.0.1:{port}/#token={TOKEN}")
    httpd.shutdown()
    httpd.server_close()
    mp.undo()


def open_page(make_context, kb, **kw):
    page = watch(make_context(**kw).new_page())
    page.goto(kb.url)
    page.wait_for_selector("#main h1", timeout=15000)
    settle(page)
    goto(page, f"#/p/{kb.pid}/main/launch")
    page.wait_for_selector("[data-testid=launch-page] [data-testid=launch-top]", timeout=20000)
    return page


def card(page, f):
    return page.locator(f"[data-testid=launch-field][data-field={f}]")


def test_launch_kit_make_check_fix_approve_copy_download(make_context, kb):
    ctx = make_context()
    ctx.grant_permissions(["clipboard-read", "clipboard-write"])
    page = watch(ctx.new_page())
    page.goto(kb.url)
    page.wait_for_selector("#main h1", timeout=15000)
    settle(page)
    # 📤 Export lists the launch kit
    goto(page, f"#/p/{kb.pid}/main/export")
    page.click("[data-testid=land-launch]")
    page.wait_for_selector("[data-testid=launch-page] [data-testid=launch-top]", timeout=20000)
    settle(page)
    assert "Nothing made yet" in page.inner_text("[data-testid=launch-summary]")
    assert "Chapters 1–2 may be told; chapters 3–3 stay secret" in page.inner_text("[data-testid=launch-cut]")
    assert page.locator("#sidenav .side-link[aria-current=page]", has_text="Export").count() == 1
    # ✨ Make the launch kit
    page.click("[data-testid=launch-generate]")
    page.wait_for_function("() => { const c = document.querySelector('[data-field=keywords]');"
                           " return c && [...c.querySelectorAll('[data-testid=launch-keyword]')].filter(i => i.value).length === 7; }",
                           timeout=30000)
    settle(page, 400)
    assert card(page, "categories").locator("[data-testid=launch-category]").count() == 3
    assert card(page, "categories").locator("[data-testid=launch-category]").first.input_value().startswith("FICTION / Mystery")
    assert "Suggestions to verify" in card(page, "comps").inner_text()
    assert card(page, "age_content").locator("[data-testid=launch-age]").input_value() == "Adults (18+)"
    assert card(page, "aplus").locator("[data-testid=launch-aplus-module]").count() == 3
    page.wait_for_function("() => { const i = document.querySelector('[data-testid=launch-aplus-preview]'); return i && i.complete && i.naturalWidth > 0; }",
                           timeout=15000)
    assert "Draft — version 1" in card(page, "blurb_short").inner_text()
    assert "[bracket]" in card(page, "author_bio").inner_text()          # the bio's facts only the author knows
    assert not bad_text(page) and not unnamed_controls(page)
    shot(page, "launch-kit-made")
    assert_clean(page, "launch kit made")
    # an invented name and a spoiler: ⚠️ with a plain fix, at once
    ta = card(page, "blurb_short").locator("[data-testid=launch-text]")
    ta.fill(ta.input_value() + " With Captain Varrow she finds the brass key wedged in the reef and relights the lamp.")
    card(page, "blurb_short").locator("[data-testid=launch-save]").click()
    page.wait_for_selector("[data-field=blurb_short] [data-testid=launch-issues]", timeout=10000)
    issues = card(page, "blurb_short").locator("[data-testid=launch-issues]").inner_text()
    assert "“Captain Varrow” is not in your Book Bible" in issues and "Fix:" in issues
    assert "after your spoiler point" in issues
    assert "problem(s) to fix" in page.inner_text("[data-testid=launch-summary]")
    shot(page, "launch-kit-problems")
    # 🔁 Fix with AI: rewritten with the problems in the request
    n = len(kb.fake.launch_contexts)
    card(page, "blurb_short").locator("[data-testid=launch-regen]").click()
    page.wait_for_selector("[data-field=blurb_short] [data-testid=launch-ok]", timeout=30000)
    sent = kb.fake.launch_contexts[n]
    assert sent["fields"] == ["blurb_short"] and any("Captain Varrow" in p["problem"] for p in sent["problems"])
    assert "Draft — version 3" in card(page, "blurb_short").inner_text()
    # ✔ approve the hook
    card(page, "hook").locator("[data-testid=launch-approve]").click()
    page.wait_for_function("() => document.querySelector('[data-field=hook]').textContent.includes('Approved (version 1)')",
                           timeout=10000)
    from akowe import launch_kit as lk
    assert lk.doc(kb.app.store, kb.pid, "main")["fields"]["hook"]["approved"] == 1
    # 📋 Copy: the keywords, one per line
    card(page, "keywords").locator("[data-testid=launch-copy]").click()
    page.wait_for_timeout(300)
    clip = page.evaluate("() => navigator.clipboard.readText()")
    assert clip.splitlines()[0] == "cozy lighthouse mystery" and len(clip.splitlines()) == 7
    # ⬇ launch-kit.md
    with page.expect_download() as dl:
        page.click("[data-testid=launch-download]")
    path = dl.value.path()
    text = open(path, encoding="utf-8").read()
    assert text.startswith("# Launch kit: The Keeper of Gullhaven") and "## One-line hook ✔ (version 1)" in text
    # 🔎 Check with AI
    kb.fake.check_script.append({"issues": [{"field": "hook", "kind": "genre", "quote": "", "problem":
                                             "A bit dark for a cozy mystery.", "fix": "Add some warmth."}]})
    page.click("[data-testid=launch-ai-check-btn]")
    page.wait_for_selector("[data-testid=launch-ai-check]", timeout=30000)
    page.wait_for_function("() => document.querySelector('[data-field=hook]').textContent.includes('A bit dark for a cozy mystery')",
                           timeout=10000)
    assert "🔁 Fix with AI" in card(page, "hook").inner_text()
    assert not bad_text(page) and not unnamed_controls(page)
    shot(page, "launch-kit-checked")
    assert_clean(page, "launch kit")


def test_launch_kit_fits_a_phone(make_context, kb):
    page = open_page(make_context, kb, width=390, height=844)
    settle(page, 400)
    assert overflow(page) <= 1
    shot(page, "launch-kit-phone")
    assert_clean(page, "phone")
