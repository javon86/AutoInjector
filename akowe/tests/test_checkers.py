"""📊 How good is each checker (checker_record.py) and 🔢 which AI checks first / never checks (checker_order.py).

* Each outcome kind is counted (confirmed / overruled / missed) from what really happened: a fix that settled it, a
  checkpoint merge where two AIs agree, a quote that is not in the chapter, the author keeping the original.
* Scores and plain words, "needs more data" under the minimum sample, numbers only in storage, persistence.
* The automatic order follows the data (and keeps the usual order until two AIs have enough of it).
* The manual order and "don't use for checks" are respected wherever reviewers are chosen, with a plain fallback line.
* The writer never reviews its own work while another AI may.
"""
from __future__ import annotations

import json

import pytest

from akowe import checker_order, checker_record as cr, cross_check
from akowe.errors import AkoweError
from akowe.review import ReviewJob

from autobook_fake import BookFakeAI
from cc_fake import MemStore
from test_autobook import make_app, run_book
from test_review_loop import SAME, scripted
from test_server import call, server  # noqa: F401


def make_app3(tmp_path, fake, **kw):
    """Three AIs: AI-1 (Claude, the cheapest: it writes), AI-2 and AI-3 (two other AIs, dearer)."""
    app = make_app(tmp_path, fake=fake, **kw)
    app.engine.providers.configure_slot("AI-3", {"adapter_id": "manual", "input_cost_minor_per_mtok": 9500,
                                                 "output_cost_minor_per_mtok": 41000})
    return app


def calls_of(fake, slot, prop):
    return [c for c in fake.calls if c["slot"] == slot and prop in c["props"]]


def seed(store, fam, confirmed=0, overruled=0, missed=0, kind="chapter"):
    cr.note_many(store, [(fam, kind, "confirmed")] * confirmed + [(fam, kind, "overruled")] * overruled
                 + [(fam, kind, "missed")] * missed)


# ---------------------------------------------------------------------------------------------- counting
def test_each_outcome_is_counted_and_worded():
    st = MemStore()
    seed(st, "chatgpt", confirmed=13, overruled=2)
    seed(st, "chatgpt", missed=1, kind="continuity")
    s = cr.stats_of(st, "chatgpt")
    assert (s["confirmed"], s["overruled"], s["missed"], s["judged"]) == (13, 2, 1, 16)
    assert s["held_pct"] == 87 and s["enough"]
    assert s["words"] == ("ChatGPT: 87% of its corrections held up · 2 false alarms in the last 16 · missed 1 that "
                          "another AI found")
    assert s["kinds"]["chapter"]["judged"] == 15 and s["kinds"]["continuity"]["missed"] == 1
    assert "needs more data" in s["kinds"]["continuity"]["words"]
    # storage: codes and times only — never book text
    raw = json.dumps(st.d[cr.SETTING])
    assert set(st.d[cr.SETTING]["ais"]["chatgpt"]["ev"][0]) <= {"k", "o", "t", "i"}
    assert "quote" not in raw and "problem" not in raw


def test_small_samples_are_labelled_and_nothing_is_not_a_score():
    st = MemStore()
    seed(st, "gemini", confirmed=3, overruled=1)
    g = cr.stats_of(st, "gemini")
    assert not g["enough"] and g["words"].startswith("Gemini: needs more data — only 4 judged")
    assert "a small sample" in g["words"]
    assert cr.stats_of(st, "claude")["words"] == "Claude: needs more data (nothing checked yet)"
    card = cr.card(st)
    assert [r["family"] for r in card["ais"]][:3] == ["chatgpt", "claude", "gemini"]
    assert card["uses_data"] is False and "Not enough data" in card["order_words"]


def test_window_keeps_the_last_200_and_persists(tmp_path):
    from akowe.store import Store
    store = Store(tmp_path / "d")
    seed(store, "claude", overruled=50)
    seed(store, "claude", confirmed=200)
    store.close()
    store = Store(tmp_path / "d")  # a new process reads what was saved
    s = cr.stats_of(store, "claude")
    assert s["judged"] == cr.WINDOW and s["overruled"] == 0 and s["held_pct"] == 100  # old outcomes fell out
    assert store.get_setting(cr.SETTING)["ais"]["claude"]["total"]["overruled"] == 50  # lifetime totals kept
    store.close()


def test_settle_turns_review_verdicts_into_outcomes():
    st = MemStore()
    run = {}
    # v1: ChatGPT objects, Gemini approves; the fix (v2) is approved by both -> ChatGPT confirmed, Gemini missed it
    cr.remember_verdicts(run, "r1", 1, "C02", {"reviewers": [{"slot": "x-chatgpt", "verdict": "REVISE"},
                                                              {"slot": "x-gemini", "verdict": "APPROVE"}]}, None)
    cr.remember_verdicts(run, "r1", 2, "C02", {"reviewers": [{"slot": "x-chatgpt", "verdict": "APPROVE"},
                                                              {"slot": "x-gemini", "verdict": "APPROVE"}]}, None)
    rows = cr.settle(st, run, "r1", 2, chapter_id="ch1")
    assert sorted(rows) == [("x-chatgpt", "chapter", "confirmed"), ("x-gemini", "chapter", "missed")]
    assert run["ck_approved"]["ch1"] == {"n": 2, "f": ["x-chatgpt", "x-gemini"], "r": "r1"}
    # the version an AI rejected is approved after all (the author accepted the change) -> overruled
    cr.remember_verdicts(run, "r2", 3, "A01", {"slot": "x-gemini", "verdict": "REVISE"}, None)
    assert cr.settle(st, run, "r2", 3, how="accept_change") == [("x-gemini", "bible", "overruled")]
    # the author kept the original -> every objection overruled
    cr.remember_verdicts(run, "r3", 1, "A01", {"slot": "x-claude", "verdict": "REVISE"}, None)
    cr.remember_verdicts(run, "r3", 2, "A01", {"slot": "x-claude", "verdict": "REVISE"}, None)
    assert cr.settle(st, run, "r3", 3, how="keep_original") == [("x-claude", "bible", "overruled")] * 2
    # the writer reviewing its own draft is not a check of anyone's work
    cr.remember_verdicts(run, "r4", 1, "A01", {"slot": "x-claude", "verdict": "REVISE", "independent": False}, None)
    assert "r4" not in run["ck_verdicts"]


def test_checkpoint_merge_confirms_misses_and_false_alarms():
    st = MemStore()
    run = {"ck_approved": {"ch2": {"n": 4, "f": ["x-claude"]}}}
    merged = [{"chapter_id": "ch2", "agreement": "confirmed", "plan": "fix", "verified": True,
               "slots": ["x-chatgpt", "x-gemini"]},
              {"chapter_id": "ch2", "agreement": "one_ai", "plan": "dropped", "verified": False, "slots": ["x-gemini"]},
              {"chapter_id": "ch2", "agreement": "one_ai", "plan": "listed", "verified": True, "slots": ["x-chatgpt"]}]
    rows = cr.from_merge(st, run, merged, ["x-chatgpt", "x-gemini", "x-claude"], None, versions={"ch2": 4})
    assert sorted(rows) == sorted([("x-chatgpt", "continuity", "confirmed"), ("x-gemini", "continuity", "confirmed"),
                                   ("x-claude", "continuity", "missed"), ("x-claude", "chapter", "missed"),
                                   ("x-gemini", "continuity", "overruled")])
    # a newer version than the one the reviewer approved is not "clearly the same passage"
    rows = cr.from_merge(st, run, merged[:1], ["x-chatgpt", "x-gemini"], None, versions={"ch2": 5})
    assert ("x-claude", "chapter", "missed") not in rows


def test_flip_turns_a_decision_round():
    st = MemStore()
    cr.note(st, "local", "stand_in", "confirmed", ref="dec-1")
    cr.note_many(st, [("chatgpt", "bible", "confirmed"), ("gemini", "bible", "overruled")], ref="dec-1")
    assert cr.flip_all(st, "dec-1", skip_kind="stand_in") == 2
    assert cr.flip(st, "local", "dec-1", "overruled")
    assert cr.stats_of(st, "local")["kinds"]["stand_in"]["overruled"] == 1
    assert cr.stats_of(st, "chatgpt")["overruled"] == 1 and cr.stats_of(st, "gemini")["confirmed"] == 1


# ---------------------------------------------------------------------------------------------- the order
def test_automatic_order_follows_the_data():
    st = MemStore()
    fams = ["chatgpt", "claude", "gemini"]
    pol = checker_order.DEFAULT
    assert checker_order.order_families(st, pol, fams) == (fams, "usual")  # no data: the usual order
    seed(st, "gemini", confirmed=12)
    assert checker_order.order_families(st, pol, fams) == (fams, "usual")  # one AI with data is not a ranking
    seed(st, "chatgpt", confirmed=6, overruled=6)
    assert checker_order.order_families(st, pol, fams) == (["gemini", "chatgpt", "claude"], "track_record")
    seed(st, "gemini", overruled=30)
    assert checker_order.order_families(st, pol, fams)[0][0] == "chatgpt"  # Gemini's false alarms pushed it down
    # with ChatGPT switched off only Gemini has enough data: no ranking, the usual order (without ChatGPT)
    assert checker_order.order_families(st, {"mode": "auto", "off": ["chatgpt"]}, fams) == (["claude", "gemini"],
                                                                                             "usual")


def test_manual_order_and_off():
    st = MemStore()
    seed(st, "gemini", confirmed=40)
    seed(st, "claude", overruled=40)
    pol = checker_order.clean({"mode": "manual", "order": ["ChatGPT", "claude", "gemini"], "off": ["gemini"]})
    assert pol == {"mode": "manual", "order": ["chatgpt", "claude", "gemini"], "off": ["gemini"]}
    assert checker_order.order_families(st, pol, ["gemini", "claude", "chatgpt"]) == (["chatgpt", "claude"], "manual")
    with pytest.raises(AkoweError):
        checker_order.clean({"mode": "loudest"})
    with pytest.raises(AkoweError):
        checker_order.clean({"off": "gemini"})


def test_shortfall_says_why_in_plain_words():
    line = checker_order.shortfall_line(can=["chatgpt"], off=["gemini"], writer="claude", down=[], want=2)
    assert line == ("Only ChatGPT can check right now because Gemini is switched off for checks and Claude is the "
                    "writer.")
    assert checker_order.shortfall_line(can=["chatgpt", "gemini"], off=[], writer="claude", down=[], want=2) is None
    none = checker_order.shortfall_line(can=[], off=["gemini"], writer="claude", down=["chatgpt"], want=1)
    assert none.startswith("No AI can check right now because Gemini is switched off for checks, Claude is the "
                           "writer and ChatGPT is not working right now.")


# ---------------------------------------------------------------------------------------------- where reviewers are chosen
def _svc_run(app, pol=None, checkers="all"):
    pid = app.engine.bootstrap_project("author", "Order book")
    run = {"id": "run-x", "project_id": pid, "branch_id": "main", "settings": {"checkers": checkers}, "events": []}
    if pol:
        run["settings"]["checker_order"] = pol
    return app.autobook, run


def test_reviewer_choice_follows_the_order_everywhere(tmp_path):
    app = make_app3(tmp_path, BookFakeAI())
    svc, run = _svc_run(app)
    rv = app.review
    # the usual order: the two AIs that did not write it, the writer last at checkpoints, never the writer as reviewer
    job = ReviewJob("review", "author", run["project_id"], "main", ["r"], None)
    rv.plan_reviewer(job, {"slot": "AI-1"})
    assert job.prefer_slots == [] and "AI-1" in job.avoid_slots and job.never_slots == []
    assert cross_check.checker_slots(svc, run, writer="AI-1") == ["AI-2", "AI-3", "AI-1"]
    # automatic, with data: AI-3's corrections held up better -> it checks first everywhere
    seed(app.store, "AI-3", confirmed=15)
    seed(app.store, "AI-2", confirmed=5, overruled=10)
    rv.plan_reviewer(job, {"slot": "AI-1"})
    assert job.prefer_slots[:2] == ["AI-3", "AI-2"]
    assert cross_check.checker_slots(svc, run, writer="AI-1") == ["AI-3", "AI-2", "AI-1"]
    assert cross_check.second_slot(svc, run, {"writer_slot": "AI-1", "slot": "AI-3"}) == "AI-2"
    # the author's own order wins over the data
    run["settings"]["checker_order"] = {"mode": "manual", "order": ["AI-2", "AI-3"]}
    assert cross_check.checker_slots(svc, run, writer="AI-1") == ["AI-2", "AI-3", "AI-1"]
    rv.checker_policy = checker_order.of_run(run, app.store)
    rv.plan_reviewer(job, {"slot": "AI-1"})
    assert job.prefer_slots[0] == "AI-2"
    # switched off for checks: never asked, and the run says why once
    run["settings"]["checker_order"] = {"mode": "auto", "off": ["AI-2"]}
    assert cross_check.checker_slots(svc, run, writer="AI-1") == ["AI-3", "AI-1"]
    assert cross_check.second_slot(svc, run, {"writer_slot": "AI-1", "slot": "AI-3"}) is None
    rv.checker_policy = checker_order.of_run(run, app.store)
    rv.plan_reviewer(job, {"slot": "AI-1"})
    assert job.never_slots == ["AI-2"] and "AI-2" not in job.prefer_slots
    notes = [e for e in run["events"] if e.get("code") == "CHECKERS_SHORT"]
    assert len(notes) == 1 and notes[0]["message"] == ("🔢 Only AI-3 can check right now because AI-2 is switched off "
                                                       "for checks and Claude is the writer.")
    cross_check.checker_slots(svc, run, writer="AI-1")
    assert len([e for e in run["events"] if e.get("code") == "CHECKERS_SHORT"]) == 1  # said once


def test_a_run_never_asks_a_switched_off_ai_and_the_writer_never_reviews(tmp_path):
    fake = BookFakeAI()
    app = make_app3(tmp_path, fake)
    run = run_book(app, {"checker_order": {"mode": "auto", "off": ["AI-3"]}, "pictures": False})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    assert run["settings"]["checker_order"] == {"mode": "auto", "order": [], "off": ["AI-3"]}
    assert not calls_of(fake, "AI-3", "verdict") and not calls_of(fake, "AI-3", "problems")
    assert calls_of(fake, "AI-2", "verdict")
    assert not calls_of(fake, "AI-1", "verdict")  # the writer never reviewed its own drafts
    assert any(e.get("code") == "CHECKERS_SHORT" and "AI-3 is switched off for checks" in e["message"]
               for e in app.autobook.get(run["id"])["events"])


def test_manual_order_in_a_run_puts_that_ai_first(tmp_path):
    fake = BookFakeAI()
    app = make_app3(tmp_path, fake)
    run = run_book(app, {"checker_order": {"mode": "manual", "order": ["AI-3", "AI-2"]}, "checkers": "one",
                         "pictures": False})
    assert run["status"] == "done", run["phase"]
    # record reviews (Book Bible records, chapters): the chosen first AI; the editor's first opinion too
    assert calls_of(fake, "AI-3", "canon_change") and not calls_of(fake, "AI-2", "canon_change")
    assert calls_of(fake, "AI-3", "score_evidence")


def test_the_start_body_checks_the_order(tmp_path):
    app = make_app(tmp_path, fake=BookFakeAI())
    with pytest.raises(AkoweError) as e:
        app.autobook.start("author", {"author_confirms": True, "checker_order": {"mode": "fastest"}})
    assert e.value.errors[0]["path"] == "/checker_order/mode"


def test_a_run_writes_the_track_record(tmp_path):
    fake = BookFakeAI()
    fake.verdicts = [scripted({"Tom Reed": [{"verdict": "REVISE", "reasons": ["His age is missing."],
                                             "suggested_changes": ["Add his age."]}]})] * 60
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"pictures": False})
    assert run["status"] == "done", run["phase"]
    s = cr.stats_of(app.store, "AI-2")  # AI-2 reviewed; its REVISE was fixed and the fix approved
    assert s["confirmed"] >= 1 and s["kinds"]["bible"]["confirmed"] >= 1


def test_a_loop_decision_kept_original_is_a_false_alarm(tmp_path):
    fake = BookFakeAI()
    fake.verdicts = [scripted({"Tom Reed": [SAME, SAME, SAME]})] * 40
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"pictures": False})
    assert run["problem"]["code"] == "REVIEW_DECISION"
    assert run["problem"]["parties"] == {"writer_slot": "AI-1", "writer": "claude", "reviewer_slots": ["AI-2"],
                                         "reviewers": ["AI-2"]}
    before = cr.stats_of(app.store, "AI-2")["overruled"]
    app.autobook.decide("author", run["id"], {"action": "keep_original", "author_confirms": True})
    app.autobook.wait_for(run["id"], 120)
    assert cr.stats_of(app.store, "AI-2")["overruled"] == before + 2


# ---------------------------------------------------------------------------------------------- the API
def test_the_api_endpoints(server):  # noqa: F811
    app, port = server
    seed(app.store, "chatgpt", confirmed=9, overruled=1)
    st, body, _ = call(port, "GET", "/api/checkers/record")
    assert st == 200 and body["min_sample"] == cr.MIN_SAMPLE
    row = next(r for r in body["ais"] if r["family"] == "chatgpt")
    assert row["words"].startswith("ChatGPT: 90% of its corrections held up")
    st, body, _ = call(port, "PUT", "/api/settings/checkers", {"mode": "manual", "order": ["gemini", "chatgpt"],
                                                               "off": ["claude"]})
    assert st == 200 and body["policy"]["off"] == ["claude"] and body["how"] == "manual"
    assert body["order_words"].startswith("Gemini → ChatGPT")
    st, body, _ = call(port, "GET", "/api/settings/checkers")
    assert body["policy"]["order"] == ["gemini", "chatgpt"]
    st, body, _ = call(port, "PUT", "/api/settings/checkers", {"mode": "nope"})
    assert st == 400
