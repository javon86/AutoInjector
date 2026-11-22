"""🧺 The world texture is extra colour, not a must: an AI that does not answer in time for it does not stop the book.
Akọwe tries once more after the chapter outline; a second failure is listed for the author's check later."""
from __future__ import annotations

from akowe import texture as texture_mod
from akowe.errors import AkoweError

from test_failover_review import SlotFake, make_app, run_book

OFF = {"length": "short_story", "improve_pass": False, "first_page": False, "opening_pass": False,
       "human_pass": False}


def _timeout():
    return AkoweError("TIMEOUT", "", "the AI did not answer in time")


def _codes(run):
    return [e.get("code") for e in run["events"]]


def test_a_texture_timeout_does_not_stop_the_book_and_the_retry_makes_it(tmp_path):
    fake = SlotFake()
    fake.fail_kind("texture", _timeout(), _timeout(), _timeout(), _timeout(), _timeout(), _timeout())
    app = make_app(tmp_path, fake)
    run = run_book(app, dict(OFF, idea="A lighthouse keeper's apprentice and a brass key"))
    assert run["status"] == "done", run.get("problem")
    codes = _codes(run)
    assert "TEXTURE_LATER" in codes
    # the second try came after the outline and either made it or listed it for later — never a stop
    assert "TEXTURE_RETRIED" in codes or "TEXTURE_FAILED" in codes
    if "TEXTURE_RETRIED" in codes:
        assert texture_mod.get_entry(app.store, run["project_id"], "main")


def test_a_texture_that_keeps_timing_out_is_listed_for_later(tmp_path):
    fake = SlotFake()
    fake.fail_kind("texture", *[_timeout() for _ in range(40)])
    app = make_app(tmp_path, fake)
    run = run_book(app, dict(OFF, idea="A lighthouse keeper's apprentice and a brass key"))
    assert run["status"] == "done", run.get("problem")
    codes = _codes(run)
    assert "TEXTURE_LATER" in codes and "TEXTURE_FAILED" in codes
    stored = app.autobook.get(run["id"])
    assert any("World texture" in x for x in stored.get("check_later") or [])
    assert texture_mod.get_entry(app.store, run["project_id"], "main") is None


def test_story_rules_timeout_still_asks_the_author(tmp_path):
    fake = SlotFake()
    fake.fail_kind("rules", *[_timeout() for _ in range(40)])
    app = make_app(tmp_path, fake)
    run = run_book(app, dict(OFF, idea="A lighthouse keeper's apprentice and a brass key"), timeout=120)
    assert run["status"] != "done"
    assert (run.get("problem") or {}).get("code") == "TIMEOUT"
