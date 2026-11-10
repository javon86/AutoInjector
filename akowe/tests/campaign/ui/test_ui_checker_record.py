"""📊 🔢 🧑‍⚖️ In the browser: the "How good is each checker" card (Settings, plain words, small samples labelled), the
checker order on the Make-a-book screen (compact line → order and "don't use for checks" → the start body), and the
stand-in's note with ↩ Undo in the run window and on Book home. At 1366x900 and at phone width."""
from __future__ import annotations

import json
import threading
from datetime import datetime
from http.server import ThreadingHTTPServer

import pytest

from .ui_helpers import assert_clean, goto, open_make_book, overflow, settle, watch

TOKEN = "ui-checkers-token-123"


class InProcess:
    """An Akọwe App served in this process (so the test can drive the stand-in's clock directly)."""

    def __init__(self, tmp_path, fake=None, three=False):
        from akowe.jobs import RetryPolicy
        from akowe.server import App, make_handler
        self.app = App(tmp_path / "data", token=TOKEN)
        prov = self.app.engine.providers
        prov.secret_path = tmp_path / "secrets.json"
        if fake is not None:
            prov.test_adapter = fake
            prov.configure_slot("AI-1", {"adapter_id": "anthropic"})
            prov.configure_slot("AI-2", {"adapter_id": "manual", "input_cost_minor_per_mtok": 9000,
                                         "output_cost_minor_per_mtok": 40000})
        fast = RetryPolicy([0.01, 0.02], 5)
        self.app.autobook.retry_policy = self.app.assist.retry_policy = fast
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.app))
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}/"

    def open(self, ctx, hash_="#/"):
        page = watch(ctx.new_page())
        page.goto(f"{self.base}#token={TOKEN}")
        page.wait_for_selector("#main h1", timeout=15000)
        if hash_ != "#/":
            goto(page, hash_)
        return page

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


SIZES = [(1366, 900), (390, 844)]


@pytest.mark.parametrize("size", SIZES, ids=["desktop", "phone"])
def test_how_good_is_each_checker_card(make_context, tmp_path, size):
    from akowe import checker_record as cr
    srv = InProcess(tmp_path)
    try:
        cr.note_many(srv.app.store, [("chatgpt", "chapter", "confirmed")] * 9 + [("chatgpt", "chapter", "overruled")]
                     + [("gemini", "continuity", "overruled")] * 2)
        page = srv.open(make_context(*size), "#/settings")
        card = page.locator("[data-testid=ck-record]")
        card.wait_for(timeout=10000)
        page.wait_for_function("() => document.querySelectorAll('[data-testid=ck-record-row]').length >= 3",
                               timeout=10000)
        rows = card.locator("[data-testid=ck-record-row]").all_inner_texts()
        assert any(r.startswith("ChatGPT: 90% of its corrections held up · 1 false alarm in the last 10") for r in rows)
        assert any(r.startswith("Gemini: needs more data — only 2 judged") and "small sample" in r for r in rows)
        assert any(r.startswith("Claude: needs more data (nothing checked yet)") for r in rows)
        assert "Not enough data yet" in card.locator("[data-testid=ck-record-order]").inner_text()
        # 🔢 the order card: Gemini switched off for checks, saved
        oc = page.locator("[data-testid=ck-order-card]")
        oc.locator("[data-testid=st-ck-off-gemini]").check()
        oc.locator("[data-testid=ck-order-save]").click()
        page.wait_for_function("() => /Never checks: Gemini/.test(document.querySelector('[data-testid=ck-order-line]')"
                               ".textContent)", timeout=10000)
        assert srv.app.store.get_setting("checker_order")["off"] == ["gemini"]
        # 🧑‍⚖️ the stand-in card: off by default, 20 minutes
        si = page.locator("[data-testid=si-card]")
        si.locator("[data-testid=si-on]").wait_for(timeout=10000)
        assert not si.locator("[data-testid=si-on]").is_checked()
        assert si.locator("[data-testid=si-wait]").input_value() == "20"
        si_text = si.inner_text()  # the new rule: the AIs decide only when they all agree; no Alfred any more
        assert "all agree" in si_text.lower() and "Alfred" not in si_text and not si.locator("#si-model").count()
        # 🧭 the story checks are on by default (when the stand-in is on) and can be left to the author
        assert si.locator("[data-testid=si-cp]").is_checked() and "story checks" in si_text
        si.locator("[data-testid=si-cp]").uncheck()
        si.locator("[data-testid=si-save]").click()
        for _ in range(100):  # the PUT lands
            if (srv.app.store.get_setting("stand_in") or {}).get("checkpoints") is False:
                break
            page.wait_for_timeout(100)
        assert srv.app.store.get_setting("stand_in")["checkpoints"] is False
        assert overflow(page) <= 1
        assert_clean(page, "checker cards")
    finally:
        srv.close()


def test_make_a_book_checker_order(make_context, ai_server):
    page = watch(make_context().new_page())
    page.goto(ai_server.start_url)
    page.wait_for_selector("#main h1", timeout=15000)
    open_make_book(page)
    dlg = page.locator("#mab-dialog")
    line = dlg.locator("[data-testid=mb-ck-line]")
    line.wait_for(timeout=10000)
    page.wait_for_function("() => /Checkers: Automatic/.test(document.querySelector('[data-testid=mb-ck-line]')"
                           ".textContent)", timeout=10000)
    dlg.locator("[data-testid=mb-ck-change]").click()
    ed = dlg.locator("[data-testid=mb-ck-editor]")
    ed.locator("[data-testid=mb-ck-mode]").select_option("manual")
    ed.locator("[data-testid=mb-ck-up-gemini]").click()  # Gemini up one
    ed.locator("[data-testid=mb-ck-off-claude]").check()
    words = line.inner_text()
    assert "Claude never checks" in words and "→" in words, words
    page.route("**/api/autobook", lambda route: route.fulfill(status=400, content_type="application/json",
                                                               body=json.dumps({"errors": [{"code": "INVALID_INPUT",
                                                                                            "path": "/x",
                                                                                            "message": "test stop"}]}))
               if route.request.method == "POST" else route.continue_())
    with page.expect_request(lambda r: r.url.endswith("/api/autobook") and r.method == "POST", timeout=20000) as req:
        dlg.locator("[data-testid=mb-start]").click()
    body = json.loads(req.value.post_data or "{}")
    co = body["checker_order"]
    assert co["mode"] == "manual" and co["off"] == ["claude"] and len(co["order"]) == 3
    assert co["order"].index("gemini") < 2
    assert_clean(page, "make-a-book checker order")


@pytest.mark.parametrize("size", SIZES, ids=["desktop", "phone"])
def test_stand_in_note_with_undo(make_context, tmp_path, size):
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from autobook_fake import BookFakeAI
    from test_review_loop import SAME, scripted
    from akowe import stand_in

    fake = BookFakeAI()
    fake.verdicts = [scripted({"Tom Reed": [SAME, SAME, SAME]})] * 40
    srv = InProcess(tmp_path, fake=fake)
    app = srv.app
    asked = []

    def vote(ctx):  # every AI votes "accept"; after the last vote the resumed run waits on its next AI answer
        asked.append(1)
        if len(asked) == 2:
            fake.gate = threading.Event()
        return {"pick": "accept", "confident": 0.9, "why": "The correction answers the finding."}
    try:
        r = app.autobook.start("author", {"author_confirms": True, "pictures": False})
        app.autobook.wait_for(r["id"], 120)
        run = app.autobook.get(r["id"])
        assert run["problem"]["code"] == "REVIEW_DECISION", run["phase"]
        stand_in.save_settings(app.store, {"enabled": True})
        fake.stand_in_script = [vote, vote]
        at = datetime.fromisoformat(run["problem"]["at"].replace("Z", "+00:00")).timestamp()
        res = stand_in.tick(app, now=at + 21 * 60)
        assert res and res[0]["code"] == "DECIDED", res
        page = srv.open(make_context(*size))
        page.wait_for_selector("#mab-btn:not([hidden])", timeout=15000)
        page.click("#mab-btn")
        note = page.locator("#mab-dialog [data-testid=si-note]")
        note.wait_for(timeout=15000)
        txt = note.inner_text()
        assert "both agreed to accept the correction to Tom Reed (character)" in txt
        assert "because you didn't answer for 20 minutes. Why:" in txt
        box = note.bounding_box()
        assert box and box["x"] >= 0 and box["x"] + box["width"] <= size[0] + 1, box
        note.locator("[data-testid=si-note-undo]").click()
        page.wait_for_function("() => /undone/.test((document.querySelector('#mab-dialog [data-testid=si-note]') || {})"
                               ".textContent || '')", timeout=15000)
        assert app.autobook.get(r["id"])["stand_in"]["decisions"][0]["undone"] is True
        # 🏠 Book home lists it too (already undone)
        page.keyboard.press("Escape")
        goto(page, f"#/p/{run['project_id']}/main/book")
        settle(page)
        home = page.locator("[data-testid=si-book-note]")
        home.wait_for(timeout=15000)
        assert "undone" in home.inner_text()
        assert overflow(page) <= 1
        assert_clean(page, "stand-in note")
    finally:
        fake.gate.set() if fake.gate else None
        try:
            app.autobook.cancel("author", r["id"])
            app.autobook.wait_for(r["id"], 60)
        except Exception:  # noqa: BLE001
            pass
        srv.close()
