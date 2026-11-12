"""🩺 Story doctor (story_doctor.py): the plan is scored by every working AI before chapter 1, revised through the
existing plan-revision path when it scores under the target, scored again, and the best plan kept. 🗣 Voice cards that
really differ (voice_contrast.py), the optional "deflects" field, the brief's cut note and the editor's own-card check."""
from __future__ import annotations

import copy

import pytest

import autobook_fake
from akowe import characters as chars_mod
from akowe import editor_rubric, run_forecast
from akowe import story_doctor as sd
from akowe import voice_contrast as vc
from akowe.book_path import BookPath
from akowe.book_report import DIM_KEYS
from akowe.errors import AkoweError

from test_failover_review import SlotFake, make_app, run_book

OFF = {"length": "short_story", "improve_pass": False, "first_page": False, "opening_pass": False,
       "human_pass": False}
PLAN = "Mara climbs to the dark lighthouse and finds the keeper's log"


def _codes(app, run):
    return [e.get("code") for e in app.autobook.get(run["id"])["events"]]


def _outline(app, run):
    return BookPath(app.engine, "author", run["project_id"], "main").outline()


def _first_summary(app, run):
    return _outline(app, run)["data"]["chapters"][0]["summary"]


# ====================================================================== no AI: the rules
def test_unproven_high_scores_count_as_7_and_a_proven_9_stays():
    tn = sd.calibration.norm(PLAN + " and the lamp")
    raw = autobook_fake.plan_review({"plan": {"outline": {"chapters": [{"summary": PLAN}]}}}, 9)
    ok = sd.clean(raw, tn)
    assert ok["trust"]["trusted"] and set(ok["scores"].values()) == {9} and sd.reviewer_score(ok["scores"]) == 9.0
    no_proof = dict(raw)
    no_proof.pop("score_evidence")
    c = sd.clean(no_proof, tn)
    assert not c["trust"]["trusted"] and set(c["scores"].values()) == {7} and c["scores_raw"]["premise"] == 9
    invented = copy.deepcopy(raw)
    for w in invented["weaknesses"]:
        w["quote"] = "a sentence that is nowhere in the plan at all"
    c2 = sd.clean(invented, tn)
    assert not any(w["verified"] for w in c2["weaknesses"])
    assert set(c2["scores"].values()) == {7}  # too clean: a near-perfect review needs 3 quoted weaknesses


def test_plan_score_is_the_lower_median_and_fixes_go_weakest_first_without_duplicates():
    assert sd.plan_score([{"score": 8.6}, {"score": 7.4}]) == 7.4
    assert sd.plan_score([{"score": 8.6}, {"score": 7.4}, {"score": 9.0}]) == 8.6
    assert sd.plan_score([]) is None
    rows = [{"name": "A", "scores": {"structure": 6, "ending": 8},
             "weaknesses": [{"dimension": "ending", "point": "Too neat.", "fix": "Let the ending cost the lamp.",
                             "quote": "x", "verified": False},
                            {"dimension": "structure", "point": "Sags.", "fix": "Cut chapter 4's wait.",
                             "quote": PLAN, "verified": True}]},
            {"name": "B", "scores": {"structure": 7, "ending": 7},
             "weaknesses": [{"dimension": "structure", "point": "Sags.", "fix": "Cut chapter 4's wait.",
                             "quote": PLAN, "verified": True}]}]
    fx = sd.combined_fixes(rows, 8.5)
    assert [f["fix"] for f in fx] == ["Cut chapter 4's wait.", "Let the ending cost the lamp."]
    assert fx[1]["quote"] == ""  # an unverified quote is not passed on
    note = sd.revision_note(rows, 7.0, 8.5, ["The author typed this idea; it must stay: a lighthouse"])
    assert note.startswith("🩺 Story doctor") and "1. [Structure] Cut chapter 4's wait." in note
    assert "never replace them" in note and note.endswith("it must stay: a lighthouse")


def test_the_plain_line_and_the_settings():
    m = {"target": 8.5, "revisions": 1, "best_score": 8.6, "rounds": [{"score": 7.4, "by": [1, 2]}, {"score": 8.6}]}
    assert sd.line(m) == "🩺 Plan scored 7.4 → 8.6 after 1 revision."
    assert sd.line({"target": 8.5, "revisions": 0, "rounds": [{"score": 8.7, "by": [1]}]}).startswith(
        "🩺 Plan scored 8.7/10 — ready to write from")
    assert "did not score higher" in sd.line(dict(m, best_score=7.4))
    assert "only scored it" in sd.line(dict(m, revisions=0, own_text=True))
    assert sd.clean_run_option({}) == {"story_doctor": True, "doctor_gate": True}
    assert sd.clean_run_option({"story_doctor": False, "doctor_rounds": 3, "doctor_target": 9}) == {
        "story_doctor": False, "doctor_gate": True, "doctor_rounds": 3, "doctor_target": 9.0}
    for bad in ({"story_doctor": "yes"}, {"doctor_gate": 1}, {"doctor_rounds": 4}, {"doctor_rounds": True}, {"doctor_target": 10}):
        with pytest.raises(AkoweError):
            sd.clean_run_option(bad)
    assert sd.rounds_of({}) == 2 and sd.target_of({}) == 8.5 and sd.target_of({"doctor_target": 8.0}) == 8.0


def test_the_forecast_counts_the_doctor_and_the_voice_check_and_their_switches():
    on = run_forecast.option_calls(run_forecast.options_of(None, {}), 10, 3)
    # three AIs: the two that did not write the plan score it, one revision (fix + review) and their new scores
    assert on["story_doctor"]["calls"] == 2 + 2 + 2 and "Story doctor" in on["story_doctor"]["label"]
    assert on["story_doctor"]["to"] == "others"
    assert on["voice_contrast"]["calls"] == run_forecast.VOICE_SHARE  # one answer, only when cards sound alike
    assert run_forecast.option_calls(run_forecast.options_of(None, {}), 10, 1)["story_doctor"]["calls"] == 1 + 2 + 1
    off = run_forecast.option_calls(run_forecast.options_of(None, {"story_doctor": False, "voice_contrast": False}),
                                    10, 3)
    assert off["story_doctor"]["calls"] == 0 and off["voice_contrast"]["calls"] == 0
    assert "up to 3 revisions" in run_forecast.option_calls(run_forecast.options_of(None, {"doctor_rounds": 3}), 10,
                                                            3)["story_doctor"]["label"]


# ====================================================================== in a run
def test_a_weak_plan_is_revised_through_the_plan_fix_scored_again_and_said_plainly(tmp_path):
    fake = SlotFake()
    fake.plan_review_script = [7, 7]  # round 1: both reviewers 7/10; round 2 (the fake's default): 9/10 with proof
    app = make_app(tmp_path, fake)
    run = run_book(app, dict(OFF, idea="A lighthouse keeper's apprentice and a brass key"))
    assert run["status"] == "done", run.get("problem")
    mem = app.autobook.get(run["id"])["story_doctor"]
    assert mem["line"] == "🩺 Plan scored 7.0 → 9.0 after 1 revision." and mem["revisions"] == 1
    assert [r["score"] for r in mem["rounds"]] == [7.0, 9.0] and len(mem["rounds"][0]["by"]) == 2
    assert fake.kinds.count("plan_review") == 4 and fake.doctor_fixes == 1
    writer = next(sl for sl, k in fake.per_slot if k == "B11")  # the AIs that did not write the plan score it
    assert writer not in {sl for sl, k in fake.per_slot if k == "plan_review"}
    # the revision went through the plan's own fix path, then the usual review, and is the approved outline
    i = fake.kinds.index("doctor_fix")
    assert fake.kinds[i + 1] == "review" and fake.kinds.index("doctor_fix") < fake.kinds.index("C02")
    assert _first_summary(app, run).endswith("(doctor fix)")
    _task, ctx = fake.prompts["doctor_fix"][0]
    note = ctx["author_note"]
    assert note.startswith("🩺 Story doctor") and "let the search cost Mara" in note
    assert "it must stay the book's idea" in note and "brass key" in note  # the author's typed idea is kept
    # the reviewers read the plan: premise, main plot and outline, rules and cast
    _t, pctx = fake.prompts["plan_review"][0]
    assert set(pctx["plan"]) == {"premise", "main_plot", "outline"} and pctx["plan"]["outline"]["chapters"]
    assert pctx["author_idea"].startswith("A lighthouse keeper")
    # the run window and the report say it
    st = {s["id"]: s for s in run["steps"]}
    assert "🩺 Plan scored 7.0 → 9.0" in st["outline"]["message"]
    assert run["report"]["doctor"] == mem["line"]
    rep = app.reports.latest(run["project_id"], "main")
    assert rep["doctor"] == mem["line"] and rep["doctor_notes"]
    from akowe.book_report import render_markdown
    assert mem["line"] in render_markdown(rep)
    assert "DOCTOR_DONE" in _codes(app, run)


def test_a_good_plan_is_only_scored_and_off_means_no_check(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake)
    run = run_book(app, OFF)
    assert run["status"] == "done", run.get("problem")
    mem = app.autobook.get(run["id"])["story_doctor"]
    assert mem["line"].startswith("🩺 Plan scored 9.0/10 — ready to write from") and mem["revisions"] == 0
    assert fake.kinds.count("plan_review") == 2 and "doctor_fix" not in fake.kinds
    fake2 = SlotFake()
    app2 = make_app(tmp_path, fake2, name="data2")
    run2 = run_book(app2, dict(OFF, story_doctor=False))
    assert run2["status"] == "done" and "plan_review" not in fake2.kinds
    assert not app2.autobook.get(run2["id"]).get("story_doctor")


def test_a_revision_that_scores_lower_is_undone_and_the_first_plan_kept(tmp_path):
    fake = SlotFake()
    fake.plan_review_script = [7, 7, 5, 5]
    app = make_app(tmp_path, fake)
    run = run_book(app, dict(OFF, doctor_rounds=1))
    assert run["status"] == "done", run.get("problem")
    mem = app.autobook.get(run["id"])["story_doctor"]
    assert [r["score"] for r in mem["rounds"]] == [7.0, 5.0] and mem["revisions"] == 1
    assert "did not score higher, so the first plan is kept" in mem["line"]
    assert not _first_summary(app, run).endswith("(doctor fix)")  # the first outline's text is approved again
    assert "DOCTOR_BEST_KEPT" in _codes(app, run)
    bp = BookPath(app.engine, "author", run["project_id"], "main")
    head = bp.rec(bp.outline()["record_id"])
    assert head["approved_version"] == head["version"]  # nothing left waiting


def test_unproven_nines_do_not_pass_the_target(tmp_path):
    fake = SlotFake()
    proofless = {"plan_scores": {d: 9 for d in DIM_KEYS}, "weaknesses": [], "strengths": [], "summary": "great"}
    fake.plan_review_script = [proofless] * 2
    app = make_app(tmp_path, fake)
    run = run_book(app, OFF)
    mem = app.autobook.get(run["id"])["story_doctor"]
    assert mem["rounds"][0]["score"] == 7.0 and mem["revisions"] == 1 and fake.doctor_fixes == 1


def test_a_revision_the_ai_cannot_make_leaves_the_plan_and_never_stops_the_book(tmp_path):
    fake = SlotFake()
    fake.plan_review_script = [6, 6]
    fake.fail_kind("doctor_fix", AkoweError("INVALID_INPUT", "/x", "refused"))
    app = make_app(tmp_path, fake)
    run = run_book(app, OFF)
    assert run["status"] == "done", run.get("problem")
    mem = app.autobook.get(run["id"])["story_doctor"]
    assert mem["revisions"] == 1 and len(mem["rounds"]) == 1
    assert "the AI's revision did not pass Akọwe's checks, so the plan stays as it was" in mem["line"]
    assert "DOCTOR_REVISION_FAILED" in _codes(app, run)
    bp = BookPath(app.engine, "author", run["project_id"], "main")
    head = bp.rec(bp.outline()["record_id"])
    assert head["approved_version"] == head["version"] and not head["data"]["chapters"][0]["summary"].endswith("fix)")


def test_the_authors_own_outline_is_only_scored(tmp_path, monkeypatch):
    fake = SlotFake()
    fake.plan_review_script = [6, 6]
    app = make_app(tmp_path, fake)
    orig = app.autobook._ai_made
    monkeypatch.setattr(app.autobook, "_ai_made",
                        lambda run, rec: False if rec.get("module_id") == "B11" else orig(run, rec))
    run = run_book(app, OFF)
    assert run["status"] == "done", run.get("problem")
    mem = app.autobook.get(run["id"])["story_doctor"]
    assert mem.get("own_text") and "only scored it" in mem["line"] and "doctor_fix" not in fake.kinds


# ====================================================================== 🗣 voice cards that differ
def test_alike_and_thin_cards_are_found_without_ai():
    m = autobook_fake.VOICES["Mara Vell"]
    t = autobook_fake.VOICES["Tom Reed"]
    assert vc.alike(m, t) == [] and vc.thin(m) == []
    twin = dict(m, vocabulary=["wick", "lens", "log"])
    why = vc.alike(m, twin)
    assert "the same rhythm and register" in why and any("Fair enough" in w or "fair enough" in w for w in why)
    assert "3 shared vocabulary words" in why
    assert vc.thin({"rhythm": "short"}) == ["no rhythm or register", "no favourite phrases or habits",
                                            "no words they would never use"]
    people = [{"name": "A", "entry": {"voice": m, "made_by": {"kind": "author"}}},
              {"name": "B", "entry": {"voice": twin, "made_by": {"kind": "ai"}}},
              {"name": "C", "entry": {"voice": {"rhythm": "x"}, "made_by": {"kind": "author"}}}]
    probs = vc.problems(people)
    assert {tuple(p["names"]) for p in probs} == {("C",), ("A", "B")}
    assert [p["name"] for p in vc.to_rewrite(people, probs)] == ["B"]  # never the author's own cards
    assert vc.clean_run_option({}) == {"voice_contrast": True}
    with pytest.raises(AkoweError):
        vc.clean_run_option({"voice_contrast": 1})


def test_two_cards_that_sound_alike_are_made_distinct_in_one_answer(tmp_path, monkeypatch):
    voices = copy.deepcopy(autobook_fake.VOICES)
    voices["Tom Reed"] = copy.deepcopy(voices["Mara Vell"])  # Tom talks exactly like Mara
    monkeypatch.setattr(autobook_fake, "VOICES", voices)
    fake = SlotFake()
    app = make_app(tmp_path, fake)
    run = run_book(app, dict(OFF, story_doctor=False))
    assert run["status"] == "done", run.get("problem")
    mem = app.autobook.get(run["id"])["voice_contrast"]
    assert fake.kinds.count("voice_contrast") == 1 and mem["rewritten"] == 1 and mem["left"] == 0
    assert mem["line"].startswith("🗣 Voice cards: Mara Vell and Tom Reed: the same rhythm and register")
    _t, ctx = fake.prompts["voice_contrast"][0]
    assert ctx["rewrite"] == ["Tom Reed"] and {c["name"] for c in ctx["cast"]} == {"Mara Vell", "Tom Reed"}
    pid = run["project_id"]
    tom = next(c for c in chars_mod.public(app.store, pid, "main") if c["name"] == "Tom Reed")
    assert "Tom Reed's own clipped rhythm" in tom["voice"]["rhythm"] and tom["voice"]["deflects"]
    assert "VOICES_MADE_DISTINCT" in _codes(app, run)
    st = {s["id"]: s for s in run["steps"]}
    assert "made distinct" in st["characters"]["message"]
    # switched off: no check, no answer
    fake2 = SlotFake()
    app2 = make_app(tmp_path, fake2, name="data2")
    run2 = run_book(app2, dict(OFF, story_doctor=False, voice_contrast=False))
    assert run2["status"] == "done" and "voice_contrast" not in fake2.kinds


def test_deflects_is_an_optional_card_field_the_ai_is_asked_for():
    assert "deflects" in chars_mod.VOICE_KEYS and "deflects" not in chars_mod.VOICE_SCHEMA["required"]
    assert "deflects (how they dodge a question" in chars_mod.COMPANION_TASK
    v = chars_mod.clean_voice(dict(autobook_fake.VOICES["Mara Vell"], deflects="answers with a question"))
    assert v["deflects"] == "answers with a question"
    assert "How they dodge a question" not in chars_mod.missing({"sheet": {}, "voice": autobook_fake.VOICES["Mara Vell"]})
    card = chars_mod.full_card({"name": "Mara"}, {"voice": v})
    assert card["voice"]["deflects"] == "answers with a question"


def test_the_editor_checks_each_speaker_against_their_own_card():
    q = editor_rubric.QUESTIONS["voice_distinction"]
    assert "against their OWN card" in q and "deflect" in q


def test_the_brief_names_whose_card_was_cut_to_one_line():
    from akowe.store import Store  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    from pathlib import Path  # noqa: PLC0415
    with tempfile.TemporaryDirectory() as d:
        store = Store(Path(d) / "s.db")
        pid = "p1"
        store.set_setting(f"characters:{pid}:main", {f"r{i}": {"voice": dict(autobook_fake.VOICES["Mara Vell"]),
                                                              "sheet": {"wants": "x"}} for i in range(6)})
        present = [{"record_id": f"r{i}", "name": f"Name{i}"} for i in range(6)]
        vb = chars_mod.voice_brief(store, pid, "main", present)
        assert vb["summarized"] and vb["short"] == ["Name4", "Name5"]


# ====================================================================== 🩺 + 🎯 / 🔁 together (the report is remade)
@pytest.mark.parametrize("mode", ["scenes", "chapters"])
def test_the_doctors_line_survives_the_improve_pass_and_the_final_reads(tmp_path, mode):
    import test_book_quality as bq
    import test_weak_scenes as tws
    from akowe.book_report import render_markdown
    fake = SlotFake()
    fake.plan_review_script = [7, 7]
    fake.weak_scene_script = [tws._nessa_bargains] * 3
    fake.rewrite_script = [bq._rewrite_first]
    fake.book_review_script = [None, None, tws._better_review, tws._better_review]
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story", "improve_mode": mode, "opening_pass": False, "first_page": False,
                         "beta_reader": True})
    assert run["status"] == "done", run.get("problem")
    run = app.autobook.get(run["id"])
    doc, imp = run["story_doctor"], run["improve"]
    assert doc["revisions"] == 1 and imp["kept"] is True, imp
    rep = app.reports.latest(run["project_id"], "main")
    assert rep.get("improve") == imp["line"] and "re-read in the final improve pass" in str(rep.get("note") or rep)
    assert rep.get("doctor") == doc["line"] and rep.get("doctor_notes")   # the remade report keeps both
    assert doc["line"] in render_markdown(rep) and run["report"]["doctor"] == doc["line"]
    assert "BETA_AGAIN" in _codes(app, run)   # the final re-read ran after the kept round
