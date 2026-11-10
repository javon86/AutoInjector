"""🧑‍⚖️ The stand-in vote on a 🧭 continuity checkpoint question (stand_in_checkpoint.py): a full fake-AI book run
pauses on CHECKPOINT_WAITING, the author does not answer, every working AI votes on each waiting problem with the
same rule (two AIs both agree, three all three) and the book goes on — or keeps waiting.

Unanimous "leave it as it is" decides and the run finishes; a split waits (and ▶ Continue settles the votes); a
unanimous "it needs you" waits; author-only topics (main character, ending, plot / plan, locked detail, lock list,
POV) wait without a vote, and one author-only problem keeps the whole checkpoint waiting; a safe offered fix is made
through the normal review and ↩ Undo takes it back out as a draft; ↩ Undo of "leave it" puts the problem back on the
author's list; the setting switches the checkpoint votes off; the forecast counts the votes; codes-only logs.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime

import pytest

import cc_fake
from akowe import attention, checker_record as cr, checkpoints, run_forecast, stand_in, status_push
from akowe import stand_in_checkpoint as sic
from akowe.book_path import BookPath
from akowe.errors import AkoweError

from autobook_fake import BookFakeAI
from test_autobook import make_app, run_book

BR = "main"
PROBLEM = "Nessa says the keeper went out, but chapter 1 shows him in the lamp room."
LEAVE = {"pick": "leave_as_is", "confident": 0.9, "why": "A small slip a reader will forgive for now."}
NEEDS = {"pick": "needs_author", "confident": 0.9, "why": "Later chapters build on it."}
FIX = {"pick": "apply_fix", "confident": 0.9, "why": "The fix matches chapter 1."}


def waiting_book(tmp_path, monkeypatch, extra=None):
    """A short book (3 chapters) whose final story check leaves problem(s) in chapter 2 waiting for the author."""
    cc_fake.remove(tmp_path, monkeypatch)
    fake = BookFakeAI()
    fake.story_ledger = True
    fake.checkpoint_extra = extra or [{"chapter": 2, "quote": "every captain looked away", "problem": PROBLEM}]
    fake.stand_in_default = dict(LEAVE)
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"checkers": "one", "length": "short_story", "pictures": False})
    assert run["status"] == "paused" and run["problem"]["code"] == "CHECKPOINT_WAITING", run.get("problem")
    return app, fake, run


def due(app, run, extra_min=1):
    at = datetime.fromisoformat(run["problem"]["at"].replace("Z", "+00:00")).timestamp()
    return at + 60 * (stand_in.settings(app.store)["wait_min"] + extra_min)


def turn_on(app, **kw):
    return stand_in.save_settings(app.store, dict({"enabled": True}, **kw))


def votes_asked(fake):
    return fake.kinds.count("stand_in")


def final_cp(app, run):
    return next(c for c in checkpoints.items(app.store, run["project_id"], BR) if c["id"] == "final")


def finish(app, run_id):
    app.autobook.wait_for(run_id, 120)
    return app.autobook.get(run_id)


# ---------------------------------------------------------------------------------------------- unanimous decides
def test_unanimous_leave_as_is_decides_the_run_goes_on_and_undo(tmp_path, monkeypatch):
    app, fake, run = waiting_book(tmp_path, monkeypatch)
    assert stand_in.tick(app, now=due(app, run, 120)) == []  # off by default: it waits, however long
    turn_on(app)
    assert stand_in.tick(app, now=due(app, run, -1)) == []  # not yet
    pub = app.autobook.public(app.autobook.get(run["id"]))
    assert pub["stand_in"]["pending"]["state"] == "waiting" and "the AIs vote" in pub["alert"]["next"]
    res = stand_in.tick(app, now=due(app, run))
    assert [r["code"] for r in res] == ["DECIDED"] and res[0]["picks"] == ["leave_as_is"]
    assert sorted(res[0]["voters"]) == ["AI-2", "claude"] and votes_asked(fake) == 2
    ctx = fake.prompts["stand_in"][0][1]
    assert ctx["finding"] == PROBLEM and "every captain looked away" in ctx["chapter_text"]
    assert {o["does"] for o in ctx["options"]} == {stand_in.OPTION_WORDS["leave_as_is"],
                                                   stand_in.OPTION_WORDS["needs_author"]}
    r = finish(app, run["id"])
    assert r["status"] == "done", r.get("problem")
    cp = final_cp(app, run)
    assert cp["status"] == "done" and cp["problems"][0]["status"] == "waiting"  # still in the report for the author
    assert cp["problems"][0]["stand_in"]["choice"] == "leave_as_is"
    assert any("your stand-in chose to go on" in e["message"] for e in r["events"])
    d = r["stand_in"]["decisions"][0]
    assert d["code"] == "CHECKPOINT_WAITING" and "both agreed to leave the story-check problem in chapter 2 as it is" \
        in d["line"] and "because you didn't answer for 20 minutes" in d["line"]
    assert any(e.get("code") == "STAND_IN_DECIDED" for e in r["events"])
    n = status_push._notice(r)  # noqa: SLF001 - "decided for you"
    assert n["title"].startswith("Decided for you") and "Open Akọwe to undo it." in n["body"]
    assert attention.of_book(app.store, run["project_id"], BR)["stand_in"][0]["id"] == d["id"]  # 🏠 Book home
    for fam in ("claude", "AI-2"):
        assert cr.stats_of(app.store, fam)["kinds"]["stand_in"]["confirmed"] == 1
    # ↩ Undo: the problem is back on the author's list
    out = stand_in.undo(app, "author", run["id"], {"decision_id": d["id"]})
    assert out["ok"] and "back on your list" in out["message"]
    r = app.autobook.get(run["id"])
    assert r["stand_in"]["decisions"][0]["undone"] is True and stand_in.notice(r) is None
    assert any("Chapter 2:" in x and "fix it yourself" in x for x in r["check_later"])
    assert final_cp(app, run)["problems"][0]["stand_in"]["undone"] is True
    for fam in ("claude", "AI-2"):
        assert cr.stats_of(app.store, fam)["kinds"]["stand_in"]["overruled"] == 1
    assert attention.of_book(app.store, run["project_id"], BR)["stand_in"][0]["undone"] is True
    with pytest.raises(AkoweError):
        stand_in.undo(app, "author", run["id"], {"decision_id": d["id"]})


def test_three_of_three_agree(tmp_path, monkeypatch):
    app, fake, run = waiting_book(tmp_path, monkeypatch)
    monkeypatch.setattr(stand_in, "voters", lambda *_a: [
        {"who": "ai", "family": f, "slot": s, "name": f} for f, s in (("claude", "AI-1"), ("chatgpt", "AI-2"),
                                                                      ("gemini", "AI-2"))])
    turn_on(app)
    res = stand_in.tick(app, now=due(app, run))
    assert res[0]["code"] == "DECIDED" and votes_asked(fake) == 3
    assert "claude, chatgpt and gemini all agreed" in finish(app, run["id"])["stand_in"]["decisions"][0]["line"]


# ---------------------------------------------------------------------------------------------- it keeps waiting
def test_split_waits_and_continue_settles_the_votes(tmp_path, monkeypatch):
    app, fake, run = waiting_book(tmp_path, monkeypatch)
    fake.stand_in_by_slot = {"AI-2": dict(NEEDS)}
    turn_on(app)
    assert stand_in.tick(app, now=due(app, run))[0]["code"] == "SPLIT"
    r = app.autobook.get(run["id"])
    assert r["status"] == "paused" and r["problem"]["code"] == "CHECKPOINT_WAITING"
    words = app.autobook.public(r)["stand_in"]["pending"]["words"]
    assert "Claude: leave it" in words and "AI-2: needs you" in words and "waiting for you" in words
    assert stand_in.tick(app, now=due(app, run, 30)) == []  # asked once per stop: no second vote
    app.autobook.resume("author", run["id"])  # ▶ Continue (the chapter unchanged: the author left it as it is)
    assert cr.stats_of(app.store, "claude")["kinds"]["stand_in"]["confirmed"] == 1
    assert cr.stats_of(app.store, "AI-2")["kinds"]["stand_in"]["overruled"] == 1
    assert finish(app, run["id"])["status"] == "done"


def test_all_agree_it_needs_the_author_waits(tmp_path, monkeypatch):
    app, fake, run = waiting_book(tmp_path, monkeypatch)
    fake.stand_in_default = dict(NEEDS)
    turn_on(app)
    assert stand_in.tick(app, now=due(app, run))[0]["code"] == "AGREED_WAIT"
    r = app.autobook.get(run["id"])
    assert r["status"] == "paused" and "all agreed chapter 2's problem needs you" in \
        app.autobook.public(r)["stand_in"]["pending"]["words"]
    app.autobook.decide("author", run["id"], {"action": "edited"})  # "I edited it": the votes are not counted
    k = (cr.stats_of(app.store, "claude").get("kinds") or {}).get("stand_in") or {}
    assert not k.get("confirmed") and not k.get("overruled")
    finish(app, run["id"])


@pytest.mark.parametrize("problem,code", [
    ("Mara Vell has no coat here, but she wore one a page before.", "MAIN_CHARACTER"),
    ("The tower clock strikes nine, which spoils the ending in the last chapter.", "ENDING"),
    ("The chapter strays off its plan: the harbour board never appears.", "PLOT"),
    ("Tom Reed's eyes are brown here, not storm-grey.", "APPROVED_FACT"),
    ("This contradicts the Book Bible about the harbour.", "APPROVED_FACT"),
    ("The chapter slips from past tense into present tense.", "POV_TENSE"),
])
def test_author_only_topics_wait_without_a_vote(tmp_path, monkeypatch, problem, code):
    app, fake, run = waiting_book(tmp_path, monkeypatch, [{"chapter": 2, "quote": "every captain looked away",
                                                           "problem": problem}])
    turn_on(app)
    assert stand_in.tick(app, now=due(app, run))[0]["code"] == "AUTHOR_ONLY:" + code
    assert votes_asked(fake) == 0
    words = app.autobook.public(app.autobook.get(run["id"]))["stand_in"]["pending"]["words"]
    assert words.startswith("Only you can decide chapter 2's problem")


def test_the_last_chapter_and_the_lock_list_are_the_authors(tmp_path, monkeypatch):
    app, _fake, run = waiting_book(tmp_path, monkeypatch, [{"chapter": 3, "quote": "x", "problem": PROBLEM}])
    turn_on(app)
    assert stand_in.tick(app, now=due(app, run))[0]["code"] == "AUTHOR_ONLY:ENDING"
    p = {"chapter_id": "ch2", "problem": "The harbour lantern burns green here.", "original": "", "replacement": ""}
    r = dict(app.autobook.get(run["id"]), settings={"locks": ["the harbour lantern burns green"]})
    assert sic.author_only_item(app, r, p, {"ch2": {}}, [], []) == "LOCK_LIST"
    assert sic.author_only_item(app, dict(r, settings={}), p, {"ch2": {}}, [], []) is None


def test_one_author_only_problem_keeps_the_whole_checkpoint_waiting(tmp_path, monkeypatch):
    app, fake, run = waiting_book(tmp_path, monkeypatch, [
        {"chapter": 2, "quote": "every captain looked away", "problem": PROBLEM},
        {"chapter": 2, "quote": "only the stranger had come back", "problem": "Mara Vell forgets her own oath."}])
    assert len(sic.waiting_items(final_cp(app, run))) == 2
    turn_on(app)
    assert stand_in.tick(app, now=due(app, run))[0]["code"] == "AUTHOR_ONLY:MAIN_CHARACTER"
    assert votes_asked(fake) == 0  # the checkpoint is answered as a whole: no vote on the safe one either
    assert app.autobook.get(run["id"])["status"] == "paused"


def test_too_many_problems_wait(tmp_path, monkeypatch):
    app, fake, run = waiting_book(tmp_path, monkeypatch, [{"chapter": 2, "quote": "q", "problem": f"Slip {i}."}
                                                          for i in range(sic.MAX_ITEMS + 1)])
    turn_on(app)
    assert stand_in.tick(app, now=due(app, run))[0]["code"] == "TOO_MANY" and votes_asked(fake) == 0


def test_the_checkpoint_votes_can_be_switched_off(tmp_path, monkeypatch):
    app, fake, run = waiting_book(tmp_path, monkeypatch)
    turn_on(app, checkpoints=False)
    assert stand_in.settings(app.store)["checkpoints"] is False
    assert stand_in.tick(app, now=due(app, run, 120)) == [] and votes_asked(fake) == 0
    assert app.autobook.public(app.autobook.get(run["id"]))["stand_in"]["pending"]["state"] == "off"
    with pytest.raises(AkoweError):
        stand_in.save_settings(app.store, {"checkpoints": "no"})


# ---------------------------------------------------------------------------------------------- a fix the AIs chose
def test_a_safe_offered_fix_is_made_reviewed_and_undo_takes_it_out(tmp_path, monkeypatch):
    app, fake, run = waiting_book(tmp_path, monkeypatch)
    # the check offered a small fix that is still safe (e.g. it was set aside because two fixes touched the same words)
    cp = final_cp(app, run)
    cp["problems"][0].update(original="every captain looked away", replacement="every captain stared at the deck")
    checkpoints._put(app.store, run["project_id"], BR, cp)  # noqa: SLF001
    fake.stand_in_default = dict(FIX)
    turn_on(app)
    res = stand_in.tick(app, now=due(app, run))
    assert res[0]["code"] == "DECIDED" and res[0]["picks"] == ["apply_fix"]
    ctx = fake.prompts["stand_in"][0][1]
    assert ctx["proposed_fix"]["replacement"] == "every captain stared at the deck"
    r = finish(app, run["id"])
    assert r["status"] == "done", r.get("problem")
    p = final_cp(app, run)["problems"][0]
    assert p["status"] == "fixed" and p["stand_in"]["choice"] == "apply_fix"
    bp = BookPath(app.engine, "author", run["project_id"], BR)
    p_rid = _rid(app, run, "ch2")
    rec = bp.rec(p_rid)
    assert "every captain stared at the deck" in rec["data"]["text"] and rec["lifecycle"] in ("APPROVED", "LOCKED")
    rep = "\n".join(checkpoints.markdown(checkpoints.report(app.store, run["project_id"], BR)))
    assert "fix chosen by your stand-in" in rep
    d = r["stand_in"]["decisions"][0]
    assert "make the suggested fix in chapter 2" in d["line"]
    out = stand_in.undo(app, "author", run["id"], {"decision_id": d["id"]})
    assert out["ok"] and "draft for you to approve" in out["message"]
    head = bp.rec(p_rid)
    assert "every captain looked away" in head["data"]["text"] and "stared at the deck" not in head["data"]["text"]
    assert head["lifecycle"] not in ("APPROVED", "LOCKED")  # it waits for the author's own approval
    assert final_cp(app, run)["problems"][0]["status"] == "waiting"


def _rid(app, run, cid):
    return next(c["record_id"] for c in checkpoints._texts(app.autobook, app.autobook.get(run["id"])).values()  # noqa: SLF001
                if c["chapter_id"] == cid)


def test_a_fix_on_the_authors_own_text_is_never_offered(tmp_path, monkeypatch):
    app, _fake, run = waiting_book(tmp_path, monkeypatch)
    r = app.autobook.get(run["id"])
    chapters = checkpoints._texts(app.autobook, r)  # noqa: SLF001
    p = {"chapter_id": "ch2", "original": "every captain looked away", "replacement": "every captain stared"}
    assert sic.kind_of(app, r, p, chapters) == "fix"
    monkeypatch.setattr(app.autobook, "_ai_made", lambda *_a: False)
    assert sic.kind_of(app, r, p, chapters) == "go_on"  # leave it / needs you: the AIs never change the author's text
    assert sic.kind_of(app, r, dict(p, original="not in the chapter"), chapters) == "go_on"


# ---------------------------------------------------------------------------------------------- forecast, API, logs
def test_the_forecast_counts_the_checkpoint_votes(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app = make_app(tmp_path, fake=BookFakeAI())
    opts = run_forecast.options_of(app, {})
    assert opts["stand_in_checkpoints"] == 0
    assert run_forecast.option_calls(opts, 20, 3)["stand_in"]["calls"] == 0
    turn_on(app)
    opts = run_forecast.options_of(app, {})
    assert opts["stand_in_checkpoints"] == 5
    assert run_forecast.option_calls(opts, 20, 3)["stand_in"]["calls"] == 15  # 5 checkpoints × 3 AIs
    assert run_forecast.option_calls(opts, 20, 1)["stand_in"]["calls"] == 0  # one AI never decides
    est = run_forecast.estimate(app, {})
    assert any(s["step"] == "option:stand_in" for s in est["steps"])


def test_codes_only_logs_and_outbox(tmp_path, monkeypatch, caplog):
    app, _fake, run = waiting_book(tmp_path, monkeypatch)
    turn_on(app)
    with caplog.at_level(logging.DEBUG, logger="akowe.stand_in"):
        stand_in.tick(app, now=due(app, run))
        finish(app, run["id"])
    logs = " ".join(x.getMessage() for x in caplog.records if x.name == "akowe.stand_in")
    assert "checkpoint vote DECIDED" in logs and "decided checkpoint (leave_as_is by" in logs
    for words in ("Nessa", "keeper", "captain", "slip"):
        assert words not in logs
    rows = app.store.query("SELECT payload FROM outbox WHERE event_type=?", ("autobook.stand_in_decided",))
    payload = json.loads(rows[0]["payload"])
    assert payload["choice"] == "checkpoint" and payload["picks"] == ["leave_as_is"]
    assert "Nessa" not in rows[0]["payload"] and "slip" not in rows[0]["payload"]
