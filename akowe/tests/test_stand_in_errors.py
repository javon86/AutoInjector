"""🗳 "When something goes wrong, let the AIs vote instead of stopping" (stand_in_errors.py): the stand-in vote for
error stops — an AI timed out, Akọwe's checks refused a draft, a reviewer's OK did not count — with extra 🤖 Claude
Code helper voters that can only block.

Off by default (= the old behaviour); each newly voteable kind decides on unanimous votes and waits on a split;
author-only kinds still wait; "right away" vs the wait time; the extra helper voters (the fake `claude`): a single
dissent blocks, and they never make up the two AIs; ↩ Undo; the per-run cap of 10; the forecast; the settings API.
"""
from __future__ import annotations

import json
from datetime import datetime

import pytest

import cc_fake
from akowe import checker_record as cr, run_forecast, stand_in, stand_in_errors as se
from akowe.errors import AkoweError

from autobook_fake import BookFakeAI
from test_autobook import make_app, run_book, steps
from test_server import call, server  # noqa: F401
from test_stand_in import paused, only_slots, votes_asked


# ---------------------------------------------------------------------------------------------- helpers
def timed_out(tmp_path):
    """A run that stopped because the AI timed out writing the main plot (TIMEOUT, options ["retry"])."""
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake)
    fake.fail_kind("B03", AkoweError("TIMEOUT", "", "provider timed out"))
    run = run_book(app, {"pictures": False})
    assert run["status"] == "paused" and run["problem"]["code"] == "TIMEOUT", run["phase"]
    return app, fake, run


def at_of(run) -> float:
    return datetime.fromisoformat(run["problem"]["at"].replace("Z", "+00:00")).timestamp()


def errors_on(app, **kw):
    return stand_in.save_settings(app.store, dict({"errors": True}, **kw))


def vote(pick, why="It failed once; a second try usually works."):
    return {"pick": pick, "confident": 0.9, "why": why}


def finish(app, run_id):
    app.autobook.wait_for(run_id, 120)
    return app.autobook.get(run_id)


# ---------------------------------------------------------------------------------------------- off = the old way
def test_off_by_default_an_error_stop_waits_like_before(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = timed_out(tmp_path)
    st = stand_in.settings(app.store)
    assert st["errors"] is False and st["errors_when"] == "wait" and st["cc_voters"] == 1 and st["max_per_run"] == 5
    stand_in.save_settings(app.store, {"enabled": True})  # the stand-in on, but not 🗳: error stops are not voted on
    assert stand_in.tick(app, now=at_of(run) + 600 * 60) == []
    r = app.autobook.get(run["id"])
    assert r["status"] == "paused" and votes_asked(fake) == 0
    assert app.autobook.public(r)["stand_in"] is None  # nothing about a vote in the run window


# ---------------------------------------------------------------------------------------------- failure: try again
def test_unanimous_try_again_after_the_wait_time(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = timed_out(tmp_path)
    fake.stand_in_default = vote("try_again")
    errors_on(app)  # after the usual wait time (20 minutes)
    assert stand_in.tick(app, now=at_of(run) + 19 * 60) == []
    pend = app.autobook.public(app.autobook.get(run["id"]))["stand_in"]["pending"]
    assert pend["state"] == "waiting" and "the AIs vote" in pend["words"]
    res = stand_in.tick(app, now=at_of(run) + 21 * 60)
    assert [r["code"] for r in res] == ["DECIDED"] and res[0]["choice"] == "try_again"
    assert votes_asked(fake) == 2
    ctx = fake.prompts["stand_in"][0][1]
    assert ctx["error_code"] == "TIMEOUT" and "did not answer in time" in ctx["what_went_wrong"]
    assert {o["letter"] for o in ctx["options"]} == {"A", "B", "C"}  # try again / another AI / wait for you
    assert {o["does"] for o in ctx["options"]} == {stand_in.OPTION_WORDS[c] for c in
                                                   ("try_again", "other_ai", "wait_author")}
    r = finish(app, run["id"])
    assert r["status"] == "done", r["phase"]
    d = r["stand_in"]["decisions"][0]
    assert d["errors"] and d["icon"] == "🗳" and d["code"] == "TIMEOUT" and d["step"] == "plot"
    assert " both agreed: try again (the AI did not answer in time while writing the main plot) at " in d["line"]
    assert "because you didn't answer for 20 minutes" in d["line"]
    assert any(e.get("code") == "STAND_IN_DECIDED" and e["message"].startswith("🗳 ") for e in r["events"])
    for fam in {v["family"] for v in d["votes"]}:
        assert cr.stats_of(app.store, fam)["kinds"]["stand_in"]["confirmed"] == 1
    from akowe import attention
    assert attention.of_book(app.store, run["project_id"], "main")["stand_in"][0]["icon"] == "🗳"
    rows = app.store.query("SELECT payload FROM outbox WHERE event_type=?", ("autobook.stand_in_decided",))
    payload = json.loads(rows[0]["payload"])
    assert payload["code"] == "TIMEOUT" and payload["choice"] == "try_again" and "reason" not in payload


def test_right_away_does_not_wait(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = timed_out(tmp_path)
    fake.stand_in_default = vote("try_again")
    errors_on(app, errors_when="now")
    pend = app.autobook.public(app.autobook.get(run["id"]))["stand_in"]["pending"]
    assert "right away" in pend["words"]
    res = stand_in.tick(app, now=at_of(run) + 1)
    assert res[0]["code"] == "DECIDED"
    d = finish(app, run["id"])["stand_in"]["decisions"][0]
    assert "right away, as your settings ask" in d["line"] and d["waited_min"] == 0


def test_a_split_waits_and_the_authors_try_again_settles_the_votes(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = timed_out(tmp_path)
    fake.stand_in_by_slot = {"AI-1": vote("try_again"), "AI-2": vote("other_ai")}
    errors_on(app, errors_when="now")
    assert stand_in.tick(app, now=at_of(run) + 1)[0]["code"] == "SPLIT"
    r = app.autobook.get(run["id"])
    assert r["status"] == "paused" and not r["stand_in"]["decisions"]
    words = app.autobook.public(r)["stand_in"]["pending"]["words"]
    assert "Claude: try again" in words and "AI-2: another AI" in words
    assert stand_in.tick(app, now=at_of(run) + 600) == []  # voted once on this stop: no retry loop
    app.autobook.resume("author", run["id"])  # 🔁 Try again
    assert cr.stats_of(app.store, "claude")["kinds"]["stand_in"]["confirmed"] == 1
    assert cr.stats_of(app.store, "AI-2")["kinds"]["stand_in"]["overruled"] == 1
    finish(app, run["id"])


def test_another_ai_unpins_the_writer_and_undo_gives_it_back(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = timed_out(tmp_path)
    r = app.autobook.get(run["id"])
    r["settings"]["slot_id"] = "AI-1"
    r["last_failed_slot"] = "AI-1"
    app.autobook.save(r)
    fake.stand_in_default = vote("other_ai", "The same AI timed out; another one should write it.")
    errors_on(app, errors_when="now")
    res = stand_in.tick(app, now=at_of(run) + 1)
    assert res[0]["code"] == "DECIDED" and res[0]["choice"] == "other_ai"
    r = finish(app, run["id"])
    assert r["status"] == "done"
    assert r["settings"]["slot_id"] is None and r["settings"]["avoid_slots"] == ["AI-1"]
    d = r["stand_in"]["decisions"][0]
    assert "both agreed: try again with another AI (the AI did not answer in time" in d["line"]
    out = stand_in.undo(app, "author", run["id"], {"decision_id": d["id"]})
    assert out["ok"] and "AI choice is back" in out["message"]
    r = app.autobook.get(run["id"])
    assert r["settings"]["slot_id"] == "AI-1" and r["settings"]["avoid_slots"] == []
    for fam in {v["family"] for v in d["votes"]}:
        assert cr.stats_of(app.store, fam)["kinds"]["stand_in"]["overruled"] == 1


def test_the_avoided_ai_is_not_used_while_another_works(tmp_path):
    from akowe.autobook import _TimedProviders
    app = make_app(tmp_path, fake=BookFakeAI())
    p = _TimedProviders(app.engine.providers, None, lambda *a, **k: None)
    pid = app.engine.bootstrap_project("author", "x")
    both = [s["slot_id"] for s in p.eligible(pid, "text", 100)]
    assert set(both) == {"AI-1", "AI-2"}
    p.avoid = {"AI-1"}
    assert [s["slot_id"] for s in p.eligible(pid, "text", 100)] == ["AI-2"]
    p.avoid = {"AI-1", "AI-2"}  # nothing else works: the work still goes on (never no AI at all)
    assert len(p.eligible(pid, "text", 100)) == 2


def test_they_all_agree_it_needs_you_so_it_waits(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = timed_out(tmp_path)
    fake.stand_in_default = vote("wait_author", "It needs the novelist.")
    errors_on(app, errors_when="now")
    assert stand_in.tick(app, now=at_of(run) + 1)[0]["code"] == "AGREED_WAIT"
    r = app.autobook.get(run["id"])
    assert r["status"] == "paused" and not r["stand_in"]["decisions"]
    assert "needs you" in app.autobook.public(r)["stand_in"]["pending"]["words"]


def test_skip_an_optional_step(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = timed_out(tmp_path)
    r = app.autobook.get(run["id"])
    r["problem"]["step"] = "beta"  # as if the optional beta reader step had failed
    app.autobook.save(r)
    kind, opts, why = se.classify(app, r, r["problem"])
    assert kind == "failure" and "skip_step" in opts and why is None
    fake.stand_in_default = vote("skip_step", "The beta reader is optional.")
    errors_on(app, errors_when="now")
    assert stand_in.tick(app, now=at_of(run) + 1)[0]["choice"] == "skip_step"
    r = finish(app, run["id"])
    assert r["status"] == "done" and steps(r)["beta"]["state"] == "skipped"
    d = r["stand_in"]["decisions"][0]
    assert "both agreed: skip the optional step “Beta reader”" in d["line"]
    with pytest.raises(AkoweError):  # the run is done: the skipped step cannot run in it any more
        stand_in.undo(app, "author", run["id"], {"decision_id": d["id"]})
    # a paused run: the step goes back on the list
    r["status"] = "paused"
    out = se.undo(app, r, d)
    assert "back on the run's list" in out["what"] and steps(r)["beta"]["state"] == "pending"


def test_a_required_step_cannot_be_skipped_and_the_tries_run_out(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = timed_out(tmp_path)
    r = app.autobook.get(run["id"])
    assert "skip_step" not in se.classify(app, r, r["problem"])[1]  # the main plot is not optional
    r.setdefault("stand_in", {})["retries"] = {"plot:TIMEOUT": se.RETRIES}
    app.autobook.save(r)
    assert se.classify(app, r, r["problem"]) == (None, (), "NOTHING_LEFT")
    errors_on(app, errors_when="now")
    assert stand_in.tick(app, now=at_of(run) + 1)[0]["code"] == "AUTHOR_ONLY:NOTHING_LEFT"
    assert votes_asked(fake) == 0


# ---------------------------------------------------------------------------------------------- author-only waits
@pytest.mark.parametrize("change,code", [
    ({"code": "LOGGED_OUT"}, "AUTHOR_ONLY:SIGN_IN"),
    ({"code": "CAPTCHA"}, "AUTHOR_ONLY:SIGN_IN"),
    ({"code": "NO_SECOND_AI"}, "AUTHOR_ONLY:SINGLE_AI"),
    ({"code": "PROTAGONIST_MISSING"}, "AUTHOR_ONLY:MAIN_CHARACTER"),
    ({"code": "NOT_FOUND", "options": []}, "AUTHOR_ONLY:NOT_A_DECISION"),
])
def test_author_only_stops_still_wait(tmp_path, monkeypatch, change, code):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = timed_out(tmp_path)
    r = app.autobook.get(run["id"])
    r["problem"].update(change)
    app.autobook.save(r)
    errors_on(app, errors_when="now")
    assert stand_in.tick(app, now=at_of(run) + 1)[0]["code"] == code and votes_asked(fake) == 0
    assert "Only you can decide this one" in app.autobook.public(app.autobook.get(run["id"]))["alert"]["next"]


def test_review_kinds_author_only_still_wait_with_errors_on(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    r = app.autobook.get(run["id"])
    r["problem"]["decision"]["kind"] = "canon"  # an approved fact would change
    app.autobook.save(r)
    errors_on(app, errors_when="now")
    assert stand_in.tick(app, now=at_of(run) + 1)[0]["code"] == "AUTHOR_ONLY:APPROVED_FACT"


# ---------------------------------------------------------------------------------------------- a reviewer's OK that did not count
def no_reason(app, run_id, **extra):
    r = app.autobook.get(run_id)
    p = r["problem"]
    r["problem"] = dict({"code": "NO_REASON", "message": "The reviewer said OK without giving a reason.",
                         "record_id": p["record_id"], "version": p["version"], "module_id": p["module_id"],
                         "verdict": "APPROVE", "reasons": [], "subject": p["subject"], "at": p["at"],
                         "options": ["approve_anyway", "retry"], "no_second_check": True}, **extra)
    app.autobook.save(r)
    return r


def test_trust_stop_all_agree_to_approve_and_undo(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    r = no_reason(app, run["id"])
    assert se.classify(app, r, r["problem"])[:2] == ("trust", se.TRUST_OPTIONS)
    fake.stand_in_default = vote("approve_anyway", "It agrees with the canon.")
    errors_on(app, errors_when="now")
    res = stand_in.tick(app, now=at_of(run) + 1)
    assert res[0]["code"] == "DECIDED" and res[0]["choice"] == "approve_anyway"
    ctx = fake.prompts["stand_in"][0][1]
    assert ctx["current_text"] and "without giving a reason" in ctx["why_it_did_not_count"]
    done = finish(app, run["id"])
    d = done["stand_in"]["decisions"][0]
    assert "both agreed to accept the writer's version of Tom Reed (character)" in d["line"]
    assert stand_in.undo(app, "author", run["id"], {"decision_id": d["id"]})["ok"]


def test_trust_stop_split_waits_and_review_again_decides(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    no_reason(app, run["id"])
    fake.stand_in_by_slot = {"AI-1": vote("approve_anyway"), "AI-2": vote("review_again")}
    errors_on(app, errors_when="now")
    assert stand_in.tick(app, now=at_of(run) + 1)[0]["code"] == "SPLIT"
    app2, fake2, run2 = paused(tmp_path / "b")
    no_reason(app2, run2["id"])
    fake2.stand_in_default = vote("review_again", "Let the reviewers read it again.")
    errors_on(app2, errors_when="now")
    res = stand_in.tick(app2, now=at_of(run2) + 1)
    assert res[0]["code"] == "DECIDED" and res[0]["choice"] == "review_again"
    app2.autobook.wait_for(run2["id"], 120)
    d = app2.autobook.get(run2["id"])["stand_in"]["decisions"][0]
    assert "both agreed: ask the reviewers to read Tom Reed (character) again" in d["line"]


def test_trust_stop_on_the_plot_waits(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    r = no_reason(app, run["id"], module_id="B11")
    assert se.classify(app, r, r["problem"]) == (None, (), "PLOT")


def test_review_decisions_are_voted_on_with_only_errors_on(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    errors_on(app)  # the stand-in itself is off: 🗳 covers the review decisions too, after the wait time
    assert stand_in.tick(app, now=at_of(run) + 19 * 60) == []
    assert stand_in.tick(app, now=at_of(run) + 21 * 60)[0]["code"] == "DECIDED"
    finish(app, run["id"])


# ---------------------------------------------------------------------------------------------- Claude's agents vote too
def test_claude_code_helpers_vote_as_extra_voters(tmp_path, monkeypatch):
    cc_fake.install(tmp_path, monkeypatch, FAKE_CLAUDE_STANDIN_MATCH="same step again")
    app, fake, run = timed_out(tmp_path)
    fake.stand_in_default = vote("try_again")
    errors_on(app, errors_when="now")  # 1 helper voter by default
    r = app.autobook.get(run["id"])
    vs = stand_in.voters(app, r, r["problem"])
    assert [v["name"] for v in vs] == ["Claude", "AI-2", "Claude Code helper #1"] and vs[2]["extra"]
    res = stand_in.tick(app, now=at_of(run) + 1)
    assert res[0]["code"] == "DECIDED" and res[0]["voters"] == ["claude", "AI-2", "claude_code"]
    d = finish(app, run["id"])["stand_in"]["decisions"][0]
    assert d["line"].startswith("Claude, AI-2 and 1 Claude Code helper all agreed: try again (")
    assert [v["name"] for v in d["votes"]][-1] == "Claude Code helper #1" and d["votes"][-1]["extra"] is True
    assert "Claude Code read the finding" in d["votes"][-1]["why"]
    assert cr.stats_of(app.store, "claude_code")["kinds"]["stand_in"]["confirmed"] == 1


def test_a_single_helper_dissent_blocks(tmp_path, monkeypatch):
    cc_fake.install(tmp_path, monkeypatch, FAKE_CLAUDE_STANDIN_MATCH="same step again",
                    FAKE_CLAUDE_STANDIN_P2="another working AI")
    app, fake, run = timed_out(tmp_path)
    fake.stand_in_default = vote("try_again")
    errors_on(app, errors_when="now", cc_voters=2)
    res = stand_in.tick(app, now=at_of(run) + 1)
    assert res[0]["code"] == "SPLIT"
    r = app.autobook.get(run["id"])
    assert r["status"] == "paused" and not r["stand_in"]["decisions"]
    words = app.autobook.public(r)["stand_in"]["pending"]["words"]
    assert "Claude Code helper #1: try again" in words and "Claude Code helper #2: another AI" in words


def test_helpers_never_make_up_the_two_ais(tmp_path, monkeypatch):
    cc_fake.install(tmp_path, monkeypatch, FAKE_CLAUDE_STANDIN_MATCH="same step again")
    app, fake, run = timed_out(tmp_path)
    only_slots(app, monkeypatch, {"AI-2"})  # one AI + Claude Code for Claude + 3 helpers
    errors_on(app, errors_when="now", cc_voters=3)
    r = app.autobook.get(run["id"])
    vs = stand_in.voters(app, r, r["problem"])
    assert [v["family"] for v in stand_in.main_voters(vs)] == ["AI-2", "claude_code"] and len(vs) == 5
    only_slots(app, monkeypatch, set())  # no web AI at all: the helpers alone decide nothing
    vs = stand_in.voters(app, r, r["problem"])
    assert stand_in.too_few(vs) == "ONE_AI" and len(vs) == 4
    assert stand_in.tick(app, now=at_of(run) + 1)[0]["code"] == "ONE_AI"


def test_no_helper_voters_when_off_or_zero(tmp_path, monkeypatch):
    cc_fake.install(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    r = app.autobook.get(run["id"])
    stand_in.save_settings(app.store, {"enabled": True})
    assert not [v for v in stand_in.voters(app, r, r["problem"]) if v.get("extra")]  # 🗳 off: the old voters
    errors_on(app, cc_voters=0)
    assert not [v for v in stand_in.voters(app, r, r["problem"]) if v.get("extra")]


# ---------------------------------------------------------------------------------------------- settings, cap, forecast
def test_the_settings_and_the_cap(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app = make_app(tmp_path, fake=BookFakeAI())
    pub = errors_on(app)
    assert pub["errors"] and pub["max_per_run"] == stand_in.ERRORS_MAX_PER_RUN == 10
    assert "can only block" in pub["errors_about"] and pub["errors_whens"] == ["now", "wait"]
    stand_in.save_settings(app.store, {"errors": False})
    assert stand_in.settings(app.store)["max_per_run"] == 5  # off again: the usual cap
    stand_in.save_settings(app.store, {"errors": True, "max_per_run": 3})
    assert stand_in.settings(app.store)["max_per_run"] == 3  # the author's own cap wins
    for bad in ({"errors_when": "later"}, {"cc_voters": 4}, {"cc_voters": True}, {"errors": "yes"}):
        with pytest.raises(AkoweError):
            stand_in.save_settings(app.store, bad)


def test_the_cap_stops_error_votes(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = timed_out(tmp_path)
    errors_on(app, errors_when="now")
    r = app.autobook.get(run["id"])
    r.setdefault("stand_in", {})["count"] = 10
    app.autobook.save(r)
    assert stand_in.tick(app, now=at_of(run) + 1)[0]["code"] == "CAP" and votes_asked(fake) == 0


def test_the_forecast_counts_the_error_votes_and_the_helper_voters(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app = make_app(tmp_path, fake=BookFakeAI())
    opts = run_forecast.options_of(app, {"claude_code": True})
    assert opts["stand_in_errors"] == 0 and run_forecast.option_calls(opts, 20, 3)["stand_in_errors"]["calls"] == 0
    base_helpers = run_forecast.option_calls(opts, 20, 3)["helpers"]["calls"]
    errors_on(app, cc_voters=2)
    opts = run_forecast.options_of(app, {"claude_code": True})
    assert opts["stand_in_errors"] == 10 and opts["stand_in_cc_voters"] == 2
    calls = run_forecast.option_calls(opts, 20, 3)
    assert calls["stand_in_errors"]["calls"] == 4 * 3  # min(10, 20/10 + 2) stops × 3 AIs
    assert calls["helpers"]["calls"] == base_helpers + (4 + 5) * 2  # error stops + checkpoints, 2 helpers each
    assert run_forecast.option_calls(opts, 20, 1)["stand_in_errors"]["calls"] == 0  # one AI never decides
    est = run_forecast.estimate(app, {})
    assert any(s["step"] == "option:stand_in_errors" for s in est["steps"])


def test_the_api(server):  # noqa: F811
    app, port = server
    st, body, _ = call(port, "GET", "/api/settings/stand-in")
    assert st == 200 and body["errors"] is False and body["cc_voters"] == 1 and body["errors_when"] == "wait"
    st, body, _ = call(port, "PUT", "/api/settings/stand-in", {"errors": True, "errors_when": "now", "cc_voters": 3})
    assert st == 200 and (body["errors"], body["errors_when"], body["cc_voters"], body["max_per_run"]) == \
        (True, "now", 3, 10)
    st, body, _ = call(port, "PUT", "/api/settings/stand-in", {"cc_voters": 9})
    assert st == 400
