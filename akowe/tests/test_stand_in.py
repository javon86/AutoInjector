"""🧑‍⚖️ The stand-in vote (stand_in.py): when the author does not answer an AI disagreement in time, every working AI
votes and it is decided only when they ALL agree ("two AIs have to agree; if there's three, all three have to").

Off by default; waits the configured time (an injected clock, never a real sleep); 2 of 2 agree → decided; 2 of 2
split → waits; 3 of 3 → decided; 2 of 3 agree and 1 differs → waits; 3 available and 1 fails → waits; only 1 AI →
waits; Claude Code + the Claude pane = one vote; the random A / B order is mapped back; unsure / low / malformed waits;
plot / ending / main character / POV-tense / content limits / lock list never voted on; the "reviewer still objects"
decision (REVIEW_NOT_PASSED) can be voted on too; ↩ Undo; the per-run cap; the votes in the track record; the notes in
the run window, the alert, Book home and the status push; codes-only logs.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime

import pytest

import cc_fake
from akowe import attention, checker_record as cr, stand_in, status_push
from akowe.errors import AkoweError

from autobook_fake import BookFakeAI
from test_autobook import make_app, run_book
from test_checkers import make_app3
from test_review_loop import SAME, scripted
from test_server import call, server  # noqa: F401


# ---------------------------------------------------------------------------------------------- helpers
def paused(tmp_path, three=False, body=None):
    fake = BookFakeAI()
    fake.verdicts = [scripted({"Tom Reed": [SAME, SAME, SAME]})] * 40
    app = (make_app3 if three else make_app)(tmp_path, fake=fake)
    run = run_book(app, dict({"pictures": False}, **(body or {})))
    assert run["status"] == "paused" and run["problem"]["code"] == "REVIEW_DECISION", run["phase"]
    return app, fake, run


def due(app, run, extra_min=1):
    at = datetime.fromisoformat(run["problem"]["at"].replace("Z", "+00:00")).timestamp()
    return at + 60 * (stand_in.settings(app.store)["wait_min"] + extra_min)


def turn_on(app, **kw):
    return stand_in.save_settings(app.store, dict({"enabled": True}, **kw))


def finish(app, run_id):
    app.autobook.wait_for(run_id, 120)
    return app.autobook.public(app.autobook.get(run_id))


def votes_asked(fake):
    return fake.kinds.count("stand_in")


def only_slots(app, monkeypatch, keep):
    """From now on only these slots are working (the run already paused)."""
    prov = getattr(app.engine.providers, "_base", app.engine.providers)
    orig = prov.eligible
    monkeypatch.setattr(prov, "eligible", lambda *a, **k: [s for s in orig(*a, **k) if s["slot_id"] in keep])


class Seq:
    """stand_in._rand: random() answers from a list (< 0.5 = B first)."""

    def __init__(self, *xs):
        self.xs = list(xs)

    def random(self):
        return self.xs.pop(0) if self.xs else 0.9


KEEP = {"pick": "keep_original", "confident": 0.9, "why": "The original was right."}


# ---------------------------------------------------------------------------------------------- the rule (no AI)
def V(pick, conf=0.9, state="voted"):
    return {"family": "x", "name": "X", "state": state, "pick": pick, "confident": conf}


@pytest.mark.parametrize("votes,available,want", [
    ([V("accept_change"), V("accept_change")], 2, ("accept_change", "DECIDED")),
    ([V("accept_change"), V("keep_original")], 2, (None, "SPLIT")),
    ([V("keep_original")] * 3, 3, ("keep_original", "DECIDED")),
    ([V("accept_change"), V("accept_change"), V("keep_original")], 3, (None, "SPLIT")),
    ([V("accept_change"), V("accept_change")], 3, (None, "VOTE_MISSING")),          # 3 at the start: 2 is not enough
    ([V("accept_change"), V("accept_change"), V(None, state="no_answer")], 3, (None, "VOTE_MISSING")),
    ([V("accept_change"), V(None, state="unclear")], 2, (None, "VOTE_MISSING")),
    ([V("accept_change"), V(None)], 2, (None, "UNSURE")),
    ([V("accept_change"), V("accept_change", 0.6)], 2, (None, "UNSURE")),
    ([V("accept_change")], 1, (None, "ONE_AI")),
    ([], 0, (None, "NO_VOTERS")),
])
def test_tally_is_the_authors_rule(votes, available, want):
    assert stand_in.tally(votes, available) == want


def test_the_random_order_is_mapped_back_to_the_option(monkeypatch):
    monkeypatch.setattr(stand_in, "_rand", Seq(0.9, 0.1))
    ctx, order = stand_in.ballot({"finding": "x"}, stand_in.OPTIONS["REVIEW_DECISION"])
    assert order == ["accept_change", "keep_original"]
    assert ctx["options"][0] == {"letter": "A", "does": stand_in.OPTION_WORDS["accept_change"]}
    ctx2, order2 = stand_in.ballot({"finding": "x"}, stand_in.OPTIONS["REVIEW_DECISION"])
    assert order2 == ["keep_original", "accept_change"]  # the other order for the next voter
    assert ctx2["options"][0]["does"] == stand_in.OPTION_WORDS["keep_original"]
    ans = stand_in.check_answer('{"choice": "a", "confident": 0.8, "why": "ok"}')
    assert stand_in.pick_of(ans, order) == "accept_change" and stand_in.pick_of(ans, order2) == "keep_original"
    assert stand_in.pick_of(stand_in.check_answer({"choice": "unsure", "confident": 1, "why": "?"}), order) is None
    for bad in ("accept it", {"choice": "accept_change", "confident": 0.9, "why": "x"},
                {"choice": "A", "confident": "high", "why": "x"}, {"choice": "A", "confident": 0.9, "why": ""}):
        with pytest.raises(ValueError):
            stand_in.check_answer(bad)


# ---------------------------------------------------------------------------------------------- off / timing
def test_off_by_default_waits_and_two_of_two_agree(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    assert stand_in.settings(app.store)["enabled"] is False and stand_in.settings(app.store)["wait_min"] == 20
    assert stand_in.tick(app, now=due(app, run, 120)) == []  # off: nothing, however long
    turn_on(app)
    assert stand_in.tick(app, now=due(app, run, -1)) == []  # 19 minutes: not yet
    pub = app.autobook.public(app.autobook.get(run["id"]))
    assert pub["stand_in"]["pending"]["state"] == "waiting"
    assert "If you don't answer by" in pub["alert"]["next"] and "the AIs vote" in pub["alert"]["next"]
    res = stand_in.tick(app, now=due(app, run, 1))
    assert [r["code"] for r in res] == ["DECIDED"] and res[0]["choice"] == "accept_change"
    assert sorted(res[0]["voters"]) == ["AI-2", "claude"]  # both AIs voted, the writer and the reviewer too
    assert votes_asked(fake) == 2
    ctx = fake.prompts["stand_in"][0][1]
    assert ctx["no_ai_checks"]["passed"] is True and ctx["changed_text"]["after"].endswith("(revised)")
    assert [o["letter"] for o in ctx["options"]] == ["A", "B"]
    d = app.autobook.get(run["id"])["stand_in"]["decisions"][0]
    assert d["line"].startswith(f"{d['votes'][0]['name']} and {d['votes'][1]['name']} both agreed to accept the "
                                "correction to Tom Reed (character) at ")
    assert "because you didn't answer for 20 minutes. Why: The correction answers" in d["line"]
    assert {v["family"] for v in d["votes"]} == {"claude", "AI-2"} and all(v["order"] for v in d["votes"])
    for fam in ("claude", "AI-2"):  # each vote counts in that AI's track record
        assert cr.stats_of(app.store, fam)["kinds"]["stand_in"]["confirmed"] == 1
    done = finish(app, run["id"])
    assert done["status"] == "done", done["phase"]


def test_a_shorter_wait_time_and_the_settings(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    turn_on(app, wait_min=10, local_model="qwen3.5:9b")  # the old Alfred fields are ignored
    assert "local_model" not in stand_in.settings(app.store)
    assert stand_in.tick(app, now=due(app, run, -1)) == []
    assert stand_in.tick(app, now=due(app, run, 0.5))[0]["code"] == "DECIDED"
    with pytest.raises(AkoweError):
        stand_in.save_settings(app.store, {"wait_min": 15})
    assert "all agree" in stand_in.public(app.store)["about"].lower() and "Alfred" not in stand_in.public(app.store)["about"]


# ---------------------------------------------------------------------------------------------- who votes, the rule
def test_two_of_two_split_waits_and_the_author_settles_the_votes(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    fake.stand_in_by_slot = {"AI-2": dict(KEEP)}
    turn_on(app)
    res = stand_in.tick(app, now=due(app, run))
    assert res[0]["code"] == "SPLIT"
    r = app.autobook.get(run["id"])
    assert r["status"] == "paused" and r["problem"]["code"] == "REVIEW_DECISION" and not r["stand_in"]["decisions"]
    assert r["stand_in"]["count"] == 0
    pub = app.autobook.public(r)
    words = pub["stand_in"]["pending"]["words"]
    assert words.startswith("The AIs didn't all agree (") and words.endswith(") — waiting for you.")
    assert "Claude: accept" in words and "AI-2: keep" in words
    assert words in pub["alert"]["next"]
    assert stand_in.tick(app, now=due(app, run, 30)) == []  # voted once for this decision: no retry loop
    # the author keeps the original: AI-2's vote matched, Claude's did not
    app.autobook.decide("author", run["id"], {"action": "keep_original", "author_confirms": True})
    assert cr.stats_of(app.store, "AI-2")["kinds"]["stand_in"]["confirmed"] == 1
    assert cr.stats_of(app.store, "claude")["kinds"]["stand_in"]["overruled"] == 1
    finish(app, run["id"])


def test_three_of_three_agree(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path, three=True)
    turn_on(app)
    res = stand_in.tick(app, now=due(app, run))
    assert res[0]["code"] == "DECIDED" and sorted(res[0]["voters"]) == ["AI-2", "AI-3", "claude"]
    assert votes_asked(fake) == 3
    d = app.autobook.get(run["id"])["stand_in"]["decisions"][0]
    assert " all agreed to accept the correction to Tom Reed (character)" in d["line"]
    assert d["line"].count(",") >= 1 and " and " in d["line"].split(" all agreed")[0]
    finish(app, run["id"])


def test_two_of_three_agree_and_one_differs_waits(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path, three=True)
    fake.stand_in_by_slot = {"AI-3": dict(KEEP)}
    turn_on(app)
    assert stand_in.tick(app, now=due(app, run))[0]["code"] == "SPLIT"
    r = app.autobook.get(run["id"])
    assert r["status"] == "paused" and not r["stand_in"]["decisions"]
    assert "AI-3: keep" in app.autobook.public(r)["stand_in"]["pending"]["words"]


def test_three_available_and_one_fails_waits(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path, three=True)

    def down(ctx):
        raise AkoweError("UPSTREAM_UNAVAILABLE", "/slot", "the site is down")
    fake.stand_in_by_slot = {"AI-3": down}
    turn_on(app)
    res = stand_in.tick(app, now=due(app, run))
    assert res[0]["code"] == "VOTE_MISSING"  # the other two agreeing is not enough: all three must
    r = app.autobook.get(run["id"])
    assert r["status"] == "paused" and not r["stand_in"]["decisions"]
    words = app.autobook.public(r)["stand_in"]["pending"]["words"]
    assert "AI-3: no answer" in words and "all 3 must agree" in words


def test_only_one_ai_waits(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    only_slots(app, monkeypatch, {"AI-2"})
    turn_on(app)
    res = stand_in.tick(app, now=due(app, run))
    assert res[0]["code"] == "ONE_AI" and votes_asked(fake) == 0  # never a vote of one
    r = app.autobook.get(run["id"])
    assert r["status"] == "paused"
    assert "Only AI-2 could be asked — at least two AIs must agree" in app.autobook.public(r)["alert"]["next"]


def test_no_ai_at_all_waits(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    only_slots(app, monkeypatch, set())
    turn_on(app)
    assert stand_in.tick(app, now=due(app, run))[0]["code"] == "NO_VOTERS"


def test_checker_order_off_is_not_asked(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path, three=True, body={"checker_order": {"mode": "auto", "off": ["AI-3"]}})
    turn_on(app)
    res = stand_in.tick(app, now=due(app, run))
    assert res[0]["code"] == "DECIDED" and sorted(res[0]["voters"]) == ["AI-2", "claude"]
    assert not [c for c in fake.calls if c["slot"] == "AI-3" and "confident" in c["props"]]
    finish(app, run["id"])


def test_claude_code_and_the_claude_pane_are_one_vote(tmp_path, monkeypatch):
    cc_fake.install(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    r = app.autobook.get(run["id"])
    assert [v["family"] for v in stand_in.voters(app, r, r["problem"])].count("claude") == 1
    assert "claude_code" not in [v["family"] for v in stand_in.voters(app, r, r["problem"])]
    # the Claude pane is not working: Claude Code votes for Claude instead (still one vote for Claude)
    only_slots(app, monkeypatch, {"AI-2"})
    vs = stand_in.voters(app, r, r["problem"])
    assert [v["family"] for v in vs] == ["AI-2", "claude_code"] and vs[1]["name"] == "Claude (Claude Code)"
    turn_on(app)
    res = stand_in.tick(app, now=due(app, run))
    assert res[0]["code"] == "DECIDED" and res[0]["voters"] == ["AI-2", "claude_code"]
    d = app.autobook.get(run["id"])["stand_in"]["decisions"][0]
    assert d["line"].startswith("AI-2 and Claude (Claude Code) both agreed to accept")
    assert "Claude Code read the finding" in d["votes"][1]["why"]
    finish(app, run["id"])


def test_claude_code_switched_off_for_checks_does_not_vote(tmp_path, monkeypatch):
    cc_fake.install(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path, body={"checker_order": {"mode": "auto", "off": ["claude"]}})
    r = app.autobook.get(run["id"])
    assert [v["family"] for v in stand_in.voters(app, r, r["problem"])] == ["AI-2"]


def test_each_ai_gets_its_own_random_order_and_the_letters_are_mapped_back(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    monkeypatch.setattr(stand_in, "_rand", Seq(0.1, 0.9))  # first voter: keep = A; second: keep = B
    fake.stand_in_by_slot = {"AI-1": {"choice": "A", "confident": 0.9, "why": "The original was right."},
                             "AI-2": {"choice": "B", "confident": 0.9, "why": "The original was right."}}
    turn_on(app)
    res = stand_in.tick(app, now=due(app, run))
    assert res[0]["code"] == "DECIDED" and res[0]["choice"] == "keep_original"
    d = app.autobook.get(run["id"])["stand_in"]["decisions"][0]
    assert [v["order"] for v in d["votes"]] == [["keep_original", "accept_change"], ["accept_change", "keep_original"]]
    assert {v["pick"] for v in d["votes"]} == {"keep_original"}
    seen = [ctx["options"][0]["does"] for _s, ctx in fake.prompts["stand_in"]]
    assert seen == [stand_in.OPTION_WORDS["keep_original"], stand_in.OPTION_WORDS["accept_change"]]
    done = finish(app, run["id"])
    hist = app.store.history(run["project_id"], "main", run["problem"]["record_id"])
    assert hist[-1]["data"] == hist[0]["data"] and done["status"] == "done"
    assert "both agreed to keep the original of Tom Reed (character)" in done["stand_in"]["decisions"][0]["line"]


# ---------------------------------------------------------------------------------------------- what keeps waiting
@pytest.mark.parametrize("answer,code", [
    ({"pick": "unsure", "confident": 0.9, "why": "Cannot tell."}, "UNSURE"),
    ({"pick": "accept", "confident": 0.5, "why": "Probably."}, "UNSURE"),
    ("I think you should accept it.", "VOTE_MISSING"),
    ({"choice": "A", "confident": "high", "why": "x"}, "VOTE_MISSING"),
    ({"choice": "approve", "confident": 0.9, "why": "x"}, "VOTE_MISSING"),
])
def test_unsure_low_or_malformed_keeps_waiting(tmp_path, monkeypatch, answer, code):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    fake.stand_in_by_slot = {"AI-2": answer}
    turn_on(app)
    res = stand_in.tick(app, now=due(app, run))
    assert res[0]["code"] == code
    r = app.autobook.get(run["id"])
    assert r["status"] == "paused" and not r["stand_in"]["decisions"] and r["stand_in"]["count"] == 0


def test_claude_code_malformed_is_a_missing_vote(tmp_path, monkeypatch):
    cc_fake.install(tmp_path, monkeypatch, FAKE_CLAUDE_MODE_STAND_IN="malformed")
    app, fake, run = paused(tmp_path)
    only_slots(app, monkeypatch, {"AI-2"})
    turn_on(app)
    assert stand_in.tick(app, now=due(app, run))[0]["code"] == "VOTE_MISSING"
    assert not app.autobook.get(run["id"])["stand_in"]["decisions"]


@pytest.mark.parametrize("change,code", [
    (lambda p: p["decision"].update(kind="canon"), "AUTHOR_ONLY:APPROVED_FACT"),
    (lambda p: p.update(module_id="B11"), "AUTHOR_ONLY:PLOT"),
    (lambda p: p.update(reasons=["The ending no longer pays off the lighthouse."]), "AUTHOR_ONLY:ENDING"),
    (lambda p: p.update(reasons=["The chapter slips into present tense."]), "AUTHOR_ONLY:POV_TENSE"),
    (lambda p: p.update(reasons=["This goes past the content limit."]), "AUTHOR_ONLY:CONTENT_LIMIT"),
    (lambda p: p.update(prev_version=None), "AUTHOR_ONLY:NOT_A_DECISION"),
])
def test_author_only_topics_are_never_voted_on(tmp_path, monkeypatch, change, code):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path, three=True)
    r = app.autobook.get(run["id"])
    change(r["problem"])
    app.autobook.save(r)
    turn_on(app)
    res = stand_in.tick(app, now=due(app, run))
    assert res[0]["code"] == code and votes_asked(fake) == 0
    pub = app.autobook.public(app.autobook.get(run["id"]))
    assert "Only you can decide this one" in pub["alert"]["next"]


def test_main_character_and_lock_list_wait_for_the_author(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path, three=True)
    r = app.autobook.get(run["id"])
    prob = dict(r["problem"])
    from akowe import story_roles
    monkeypatch.setattr(story_roles, "protagonist_of", lambda *a, **k: {"record_id": prob["record_id"]})
    assert stand_in.author_only(app, r, prob) == "MAIN_CHARACTER"
    monkeypatch.undo()
    cc_fake.remove(tmp_path, monkeypatch)
    ch = stand_in._change(app, r, prob)  # noqa: SLF001
    r["settings"]["locks"] = [ch["before"][:80]]
    assert stand_in.author_only(app, r, prob) == "LOCK_LIST"


def test_the_last_chapter_is_the_ending(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    from akowe.book_path import BookPath
    monkeypatch.setattr(BookPath, "outline_chapters", lambda self, o: [{"chapter_id": "ch1"}, {"chapter_id": "ch2"}])
    r = app.autobook.get(run["id"])
    prob = dict(r["problem"], module_id="C02", chapter_id="ch2")
    assert stand_in.author_only(app, r, prob) == "ENDING"
    assert stand_in.author_only(app, r, dict(prob, chapter_id="ch1")) is None


# ---------------------------------------------------------------------------------------------- reviewer still objects
def not_passed(app, run_id, **extra):
    """The run waits on "the reviewer still says REVISE after 2 fixes" (REVIEW_NOT_PASSED) for the same record."""
    r = app.autobook.get(run_id)
    p = r["problem"]
    r["problem"] = dict({"code": "REVIEW_NOT_PASSED", "message": "The AI reviewer still says REVISE.",
                         "record_id": p["record_id"], "version": p["version"], "module_id": p["module_id"],
                         "chapter_id": p.get("chapter_id"), "verdict": "REVISE",
                         "reasons": ["The pacing drags in the middle."], "subject": p["subject"], "at": p["at"],
                         "options": ["approve_anyway", "edit", "retry"],
                         "promise": {"pov_tense": False, "content_limits": False}}, **extra)
    app.autobook.save(r)
    return r


def test_reviewer_still_objects_all_agree_to_accept_the_writers_version_and_undo(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    r = not_passed(app, run["id"])
    rid = r["problem"]["record_id"]
    turn_on(app)
    res = stand_in.tick(app, now=due(app, run))
    assert res[0]["code"] == "DECIDED" and res[0]["choice"] == "approve_anyway"
    ctx = fake.prompts["stand_in"][0][1]
    assert ctx["current_text"] and ctx["reviewer_now"] == ["The pacing drags in the middle."]
    assert {o["does"] for o in ctx["options"]} == {stand_in.OPTION_WORDS["approve_anyway"],
                                                   stand_in.OPTION_WORDS["retry"]}
    done = finish(app, run["id"])
    d = done["stand_in"]["decisions"][0]
    assert "both agreed to accept the writer's version of Tom Reed (character)" in d["line"]
    out = stand_in.undo(app, "author", run["id"], {"decision_id": d["id"]})
    assert out["ok"] and "not approved any more" in out["message"]
    head = app.store.history(run["project_id"], "main", rid)[-1]
    assert head["lifecycle"] not in ("APPROVED", "LOCKED")  # it waits for the author's own approval again


def test_reviewer_still_objects_all_agree_to_fix_again(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    not_passed(app, run["id"])
    fake.stand_in_default = {"pick": "retry", "confident": 0.9, "why": "The notes are right."}
    turn_on(app)
    res = stand_in.tick(app, now=due(app, run))
    assert res[0]["code"] == "DECIDED" and res[0]["choice"] == "retry"
    app.autobook.wait_for(run["id"], 120)
    r = app.autobook.get(run["id"])
    d = r["stand_in"]["decisions"][0]
    assert "both agreed to send Tom Reed (character) back to the writer for two more fixes" in d["line"]
    assert d["approved_version"] is None and any(e.get("code") == "STAND_IN_DECIDED" for e in r["events"])


def test_reviewer_still_objects_split_then_the_author_tries_again(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    not_passed(app, run["id"])
    fake.stand_in_by_slot = {"AI-2": {"pick": "retry", "confident": 0.9, "why": "Fix it."}}
    turn_on(app)
    assert stand_in.tick(app, now=due(app, run))[0]["code"] == "SPLIT"
    words = app.autobook.public(app.autobook.get(run["id"]))["stand_in"]["pending"]["words"]
    assert "Claude: accept as it is" in words and "AI-2: fix again" in words
    app.autobook.resume("author", run["id"])  # 🔁 Try again
    assert cr.stats_of(app.store, "AI-2")["kinds"]["stand_in"]["confirmed"] == 1
    assert cr.stats_of(app.store, "claude")["kinds"]["stand_in"]["overruled"] == 1
    app.autobook.wait_for(run["id"], 120)


@pytest.mark.parametrize("extra,code", [
    ({"promise": {"pov_tense": True}}, "POV_TENSE"),
    ({"promise": {"content_limits": True}}, "CONTENT_LIMIT"),
    ({"options": ["approve_anyway", "retry"], "no_second_check": True}, "NOT_A_DECISION"),  # H6: only one AI checked
    ({"options": ["retry"]}, "NOT_A_DECISION"),
])
def test_reviewer_still_objects_author_only(tmp_path, monkeypatch, extra, code):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    r = not_passed(app, run["id"], **extra)
    assert stand_in.author_only(app, r, r["problem"]) == code


# ---------------------------------------------------------------------------------------------- undo, cap, notes, logs
def test_undo_puts_the_other_option_back_for_re_review(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    turn_on(app)
    stand_in.tick(app, now=due(app, run))
    done = finish(app, run["id"])
    d = done["stand_in"]["decisions"][0]
    rid = d["record_id"]
    out = stand_in.undo(app, "author", run["id"], {"decision_id": d["id"]})
    assert out["ok"] and "back as a draft" in out["message"]
    hist = app.store.history(run["project_id"], "main", rid)
    head = hist[-1]
    assert head["data"] == hist[0]["data"]  # the original is back …
    assert head["lifecycle"] not in ("APPROVED", "LOCKED")  # … as a draft: it waits for the author's approval
    r = app.autobook.get(run["id"])
    assert r["stand_in"]["decisions"][0]["undone"] is True
    assert any(e.get("code") == "STAND_IN_UNDONE" for e in r["events"])
    for fam in ("claude", "AI-2"):  # the undo counts against every AI that voted for it
        assert cr.stats_of(app.store, fam)["kinds"]["stand_in"]["overruled"] == 1
    with pytest.raises(AkoweError):
        stand_in.undo(app, "author", run["id"], {"decision_id": d["id"]})
    assert stand_in.notice(r) is None  # no "decided for you" notification for an undone decision
    assert attention.of_book(app.store, run["project_id"], "main")["stand_in"][0]["undone"] is True


def test_the_per_run_cap(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    turn_on(app, max_per_run=1)
    r = app.autobook.get(run["id"])
    r.setdefault("stand_in", {})["count"] = 1
    app.autobook.save(r)
    assert stand_in.tick(app, now=due(app, run))[0]["code"] == "CAP" and votes_asked(fake) == 0


def test_notes_everywhere_and_codes_only_logs(tmp_path, monkeypatch, caplog):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    turn_on(app)
    with caplog.at_level(logging.DEBUG, logger="akowe.stand_in"):
        stand_in.tick(app, now=due(app, run))
    logs = " ".join(r.getMessage() for r in caplog.records if r.name == "akowe.stand_in")
    assert "decided (accept_change by " in logs and "vote DECIDED" in logs
    for words in ("Tom Reed", "revised", "The correction answers", "wake"):
        assert words not in logs
    r = app.autobook.get(run["id"])
    # the desktop notification (status push): decided for you
    n = status_push._notice(r)  # noqa: SLF001
    assert n["title"].startswith("Decided for you") and "Open Akọwe to undo it." in n["body"]
    assert "both agreed" in n["body"]
    brief = status_push.run_brief(app, run["project_id"], "http://x/")
    assert brief["notice"]["key"] == r["stand_in"]["decisions"][0]["id"]
    # 🏠 Book home lists it (with Undo), and the approvals list says a stand-in decided it
    att = attention.of_book(app.store, run["project_id"], "main")
    assert "both agreed to accept the correction" in att["stand_in"][0]["line"]
    assert any("every working AI agreed" in x for x in att["lines"])
    # the outbox holds codes only
    rows = app.store.query("SELECT payload FROM outbox WHERE event_type=?", ("autobook.stand_in_decided",))
    payload = json.loads(rows[0]["payload"])
    assert payload["decider"] == "vote" and sorted(payload["voters"]) == ["AI-2", "claude"]
    assert "reason" not in payload and "Tom" not in rows[0]["payload"]
    finish(app, run["id"])
    # a later alert (any later stop) mentions the last decision of this run
    from akowe import alerts
    a = alerts.with_stand_in({"next": "x"}, stand_in.view(app, app.autobook.get(run["id"])))
    assert "both agreed" in a["stand_in"]["line"]


def test_the_api(server, monkeypatch, tmp_path):  # noqa: F811
    app, port = server
    st, body, _ = call(port, "GET", "/api/settings/stand-in")
    assert st == 200 and body["enabled"] is False and body["waits"] == [10, 20, 30, 60]
    assert body["min_voters"] == 2 and "local_endpoint" not in body
    st, body, _ = call(port, "PUT", "/api/settings/stand-in", {"enabled": True, "wait_min": 30, "max_per_run": 3})
    assert st == 200 and (body["enabled"], body["wait_min"], body["max_per_run"]) == (True, 30, 3)
    st, body, _ = call(port, "PUT", "/api/settings/stand-in", {"wait_min": 7})
    assert st == 400
    st, body, _ = call(port, "POST", "/api/autobook/nope/stand-in-undo", {"decision_id": "x"})
    assert st == 404
