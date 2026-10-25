"""Section 8 in the browser: P37.5 the "ChatGPT isn't working — here's why / fix" notice before a run (Cancel, Start
without it, the run window's AI notice) and P36 the editor card's calibration box (re-asked, capped, each editor's own
scores). An in-process BookForge with the deterministic fake AI and per-slot bridge states (v1.2), so a "logged out"
ChatGPT can be shown. Screenshots go to $BF_UI_SHOTS (see ui_helpers.shot)."""
from __future__ import annotations

import threading
import time
from http.server import ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from .ui_helpers import assert_clean, goto, settle, shot, watch

from test_failover_review import SlotFake, make_app, no_provider_sleep  # noqa: F401
from test_server import TOKEN

Q4 = "Mara asked every captain about the night the light went dark"


@pytest.fixture
def s8(tmp_path):
    from bookforge.server import make_handler
    fake = SlotFake()
    app = make_app(tmp_path, fake)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    yield SimpleNamespace(app=app, fake=fake, url=f"http://127.0.0.1:{port}/#token={TOKEN}")
    for svc in (app.autobook, app.write_all):
        for r in svc.active():
            try:
                svc.cancel("author", r["id"])
                svc.wait_for(r["id"], 30)
            except Exception:  # noqa: BLE001 - teardown
                pass
    httpd.shutdown()
    httpd.server_close()


def open_page(make_context, s8):
    page = watch(make_context().new_page())
    page.goto(s8.url)
    page.wait_for_selector("#main h1", timeout=15000)
    settle(page)
    return page


def test_ai_check_notice_cancel_and_start_without_it(make_context, s8):
    s8.fake.states["AI-2"], s8.fake.problems["AI-2"] = "needs_user", "LOGGED_OUT"
    s8.fake.after_probe = {"AI-2": "needs_user"}
    page = open_page(make_context, s8)
    page.click("#mab-btn")
    dlg = page.locator("#mab-dialog")
    dlg.get_by_role("button", name="⚡ Start — let the AI choose everything").click()
    notice = page.locator("[data-testid=ai-check-dialog]")
    notice.wait_for(timeout=10000)
    text = notice.inner_text()
    assert "ChatGPT isn't working" in text and "ChatGPT is logged out." in text and "log in" in text
    assert "✔ Claude" in text and "✔ Gemini" in text and "Claude and Gemini do all the work" in text
    shot(page, "s8-ai-check-notice")
    # 🔁 check again: still logged out -> the notice stays (AutoInjector was asked to check in first)
    notice.get_by_role("button", name="🔁 I fixed it — check again").click()
    page.wait_for_function("() => !document.querySelector('[data-testid=ai-check-dialog] .state-loading, "
                           "[data-testid=ai-check-dialog] .state.loading')", timeout=20000)
    assert s8.fake.probes and "ChatGPT is logged out." in notice.inner_text()
    # ✖ Cancel: nothing starts
    notice.get_by_role("button", name="✖ Cancel").click()
    page.wait_for_selector("[data-testid=ai-check-dialog]", state="detached", timeout=5000)
    assert not s8.app.autobook.list("author")
    # ▶ Start without ChatGPT: the run starts and its window says so
    orig = s8.fake.submit

    def slow(*a, **kw):
        time.sleep(0.25)
        return orig(*a, **kw)
    s8.fake.submit = slow
    dlg.get_by_role("button", name="⚡ Start — let the AI choose everything").click()
    notice.wait_for(timeout=10000)
    notice.get_by_role("button", name="▶ Start without ChatGPT").click()
    dlg.locator("[data-testid=mb-ai-alerts]").wait_for(timeout=20000)
    alert = dlg.locator("[data-testid=mb-ai-alerts]").inner_text()
    assert "ChatGPT isn't working" in alert and "You chose to start without it." in alert
    run = s8.app.autobook.list("author")[0]
    assert run["settings"]["ai_check"]["skipped"] == ["AI-2"]
    dlg.locator("[data-testid=mb-ai-alerts]").scroll_into_view_if_needed()
    page.screenshot(path=str(shot(page, "s8-run-window-ai-notice")))  # the viewport: the run window is a modal
    assert_clean(page, "AI check")


def test_editor_card_shows_calibration(make_context, s8):
    fake = s8.fake

    def too_clean(ctx, dims):  # every editor answer: 10/10, one note, no proof (book 2's Gemini)
        return {"scores": {d: 10 for d in dims}, "keep": [], "verdict": "PASS",
                "findings": [{"id": "f1", "dimension": dims[0], "severity": "minor", "passage": Q4, "why": "a bit flat",
                              "suggestion": "show it", "keep_nearby": []}] if Q4 in (ctx.get("chapter_text") or "") else []}
    fake._craft = too_clean
    s8.app.review.editor.save_settings({"rounds": 0})
    r = s8.app.autobook.start("author", {"author_confirms": True, "slot_id": "AI-1"})
    s8.app.autobook.wait_for(r["id"], 180)
    run = s8.app.autobook.get(r["id"])
    assert run["status"] == "done", run.get("problem")
    crafts = s8.app.review.editor.crafts(run["project_id"], "main")
    rid = next(c["record_id"] for c in crafts.values() if c["calibration"]["flagged"] and c["findings"])
    page = open_page(make_context, s8)
    goto(page, f"#/p/{run['project_id']}/main/write/{rid}")
    box = page.locator("[data-testid=ed-calibration]")
    box.wait_for(timeout=15000)
    t = box.inner_text()
    assert "too clean to trust" in t and "Two editors read it" in t and "asked once more" in t
    box.locator("summary", has_text="Each editor’s own scores").click()
    assert "10 → 7" in box.inner_text()
    box.scroll_into_view_if_needed()
    shot(page, "s8-editor-calibration")
    # the book report shows each AI's generosity
    goto(page, f"#/p/{run['project_id']}/main/report")
    page.locator("[data-testid=rp-leniency]").wait_for(timeout=15000)
    assert "How generous each AI reviewer is" in page.inner_text("[data-testid=rp-leniency]")
    # ... and a one-line "how generous" note under each whole-book reviewer (P36 extended to the whole-book review)
    assert "How generous:" in page.inner_text("[data-testid=rp-reviewers]")
    page.locator("[data-testid=rp-leniency]").scroll_into_view_if_needed()
    shot(page, "s8-report-leniency")
    assert_clean(page, "editor calibration")
