"""📈 Book quality, batch E ("AI novel quality beyond eight", recommendations 12 and 13 and "A single 1–10 score
cannot tell an 8 from a 9"): 🔮 the predictability probe on the approved plan, 🎭 key chapters written twice with the
better version kept, and ⚖ head-to-head (pairwise) comparisons with position-bias control — also in the 🩺 story
doctor's keep-the-best decision."""
from __future__ import annotations

import random

import pytest

from akowe import key_scenes, pairwise, predictability, run_forecast
from akowe.errors import AkoweError

from test_failover_review import SlotFake
from test_world_planned import book, chapters

MARK_TURN = "(a less expected turn)"
MARK_B = "The second take begins at the reef."


# ====================================================================== ⚖ pairwise: the pure part
def test_read_answer_maps_the_shown_order_back_and_refuses_garbage():
    assert pairwise.read_answer({"better": "1"}, ["a", "b"]) == "a"
    assert pairwise.read_answer({"better": "1"}, ["b", "a"]) == "b"
    assert pairwise.read_answer({"better": "2"}, ["b", "a"]) == "a"
    assert pairwise.read_answer({"better": "same"}, ["a", "b"]) == "tie"
    for junk in (None, "1", {"better": "3"}, {"better": ""}, {"pick": "1"}, {"better": "maybe"}):
        assert pairwise.read_answer(junk, ["a", "b"]) is None


def test_verdict_needs_agreement_across_orders_and_allows_ties():
    v = pairwise.verdict
    assert v([]) is None and v([None, None]) is None
    assert v(["a"]) == "a" and v(["b"]) == "b" and v(["tie"]) == "tie"
    assert v(["a", "a"]) == "a" and v(["b", None]) == "b"
    assert v(["a", "b"]) == "tie"        # the two orders disagree: position bias, no winner
    assert v(["a", "tie"]) == "tie"      # a win must hold both ways
    assert v(["a", "a", "tie"]) == "a" and v(["a", "b", "a"]) == "tie"


def test_orders_alternate_so_two_judges_see_both_orders():
    for seed in range(6):
        o = pairwise.orders(2, random.Random(seed))
        assert sorted(map(tuple, o)) == [("a", "b"), ("b", "a")]
    firsts = {tuple(pairwise.orders(1, random.Random(s))[0]) for s in range(40)}
    assert firsts == {("a", "b"), ("b", "a")}  # the first judge's order is random
    assert pairwise.orders(0) == []


def test_clean_run_option_defaults_on_and_validates():
    assert pairwise.clean_run_option({}) == {"predictability_probe": True, "key_scene_versions": True,
                                             "pairwise": True}
    assert pairwise.clean_run_option({"key_scene_versions": False})["key_scene_versions"] is False
    for k in pairwise.SETTINGS:
        with pytest.raises(AkoweError) as e:
            pairwise.clean_run_option({k: "yes"})
        assert e.value.code == "INVALID_INPUT" and e.value.errors[0]["path"] == f"/{k}"
    assert pairwise.enabled({"settings": {}}) and not pairwise.enabled({"settings": {"pairwise": False}})
    assert pairwise.enabled({}, "key_scene_versions")


def test_pick_without_a_version_or_a_judge_gives_no_verdict():
    class _Svc:
        def check(self, run):
            pass
    assert pairwise.pick(_Svc(), {}, "", "b", what="x", criteria=[], writer_slot=None)["code"] == "EMPTY_VERSION"
    # no judge can be listed (the service has no review service): no verdict, never an error
    res = pairwise.pick(_Svc(), {}, "a text", "b text", what="x", criteria=[], writer_slot="AI-1")
    assert res["winner"] is None and res["code"] == "NO_JUDGE"


# ====================================================================== 🔮 predictability: the pure part
CHS = [{"chapter_id": f"ch{i}", "objective": f"objective {i}", "summary": f"summary {i}"} for i in range(1, 9)]


def test_words_and_overlap():
    assert predictability.words("The keeper's brass keys, the KEY!") == {"keeper", "brass", "key"}
    assert "the" not in predictability.words("the and of")
    assert predictability.overlap("Mara opens the sealed lamp room with the brass key",
                                  "Mara uses the brass key to open the sealed lamp room") >= 0.5
    assert predictability.overlap("A storm sinks the ferry", "Mara uses the brass key to open the lamp room") == 0.0
    assert predictability.overlap("anything", "") == 0.0


def test_turns_from_the_story_shape_and_by_position():
    beats = [{"id": "opportunity", "name": "The opportunity", "at": 10, "number": 1},
             {"id": "change_of_plans", "name": "The change of plans", "at": 25, "number": 2},
             {"id": "point_of_no_return", "name": "The point of no return", "at": 50, "number": 4},
             {"id": "major_setback", "name": "The major setback", "at": 75, "number": 6},
             {"id": "climax", "name": "The climax", "at": 90, "number": 8}]
    ts = predictability.turns(CHS, beats)
    assert [(t["number"], t["name"]) for t in ts] == [(2, "The change of plans"), (4, "The point of no return"),
                                                     (6, "The major setback"), (8, "The climax")]
    assert ts[0]["planned"] == "objective 2 — summary 2" and [t["turn"] for t in ts] == [1, 2, 3, 4]
    by_pos = predictability.turns(CHS)
    assert [t["number"] for t in by_pos] == [2, 4, 6, 8]
    assert [t["number"] for t in predictability.turns(CHS[:3])] == [2, 3]  # deduped, never chapter 1
    assert predictability.turns(CHS[:1]) == []


def test_compare_counts_a_turn_only_with_enough_overlap():
    ts = [{"turn": 1, "number": 2, "name": "x", "planned": "Mara uses the brass key to open the sealed lamp room"},
          {"turn": 2, "number": 4, "name": "y", "planned": "Tom Reed is found alive on the outer rocks"},
          {"turn": 3, "number": 6, "name": "z", "planned": "The harbor master burns the logbook"}]
    raw = {"predictions": [
        {"turn": 1, "prediction": "Mara opens the sealed lamp room with the brass key", "matches": "no"},  # HIGH
        {"turn": 2, "prediction": "Tom Reed turns up hurt somewhere", "matches": "yes"},                   # yes+LOW
        {"turn": 3, "prediction": "A storm comes", "matches": "yes"},           # the AI flatters itself: not counted
        {"turn": 3, "prediction": "duplicate", "matches": "yes"}, "junk", {"turn": "x", "prediction": "y"}]}
    rows = predictability.compare(raw, ts)
    assert [r["guessed"] for r in rows] == [True, True, False]
    assert rows[2]["ai_match"] is True and rows[2]["overlap"] == 0.0
    assert predictability.too_predictable(rows, 3)
    assert not predictability.too_predictable(rows[:1], 3) and not predictability.too_predictable(rows, 1)
    assert predictability.compare("junk", ts) is None and predictability.compare({"predictions": []}, ts) is None
    note = predictability.revision_note(rows, 3, ts, ["The author typed this idea; keep it."])
    assert note.startswith("🔮") and "guessed 2 of 3" in note and "Chapter 2" in note and "Chapter 6" not in note
    assert "keep it." in note and "every chapter ID" in note


# ====================================================================== 🎭 key scenes: the pure part
def test_key_chapters_from_the_shape_or_the_last_chapter():
    beats = [{"id": "change_of_plans", "name": "The change of plans", "number": 2},
             {"id": "major_setback", "name": "The major setback", "number": 6},
             {"id": "climax", "name": "The climax", "number": 8}]
    assert key_scenes.key_chapters(8, beats) == [{"number": 6, "why": "The major setback"},
                                                 {"number": 8, "why": "The climax"}]
    assert key_scenes.key_chapters(8) == [{"number": 8, "why": "the last chapter"}]
    assert key_scenes.key_chapters(1) == []
    many = [{"id": b, "name": b, "number": i} for i, b in enumerate(key_scenes.KEY_BEATS, 2)]
    assert len(key_scenes.key_chapters(20, many)) == key_scenes.MAX_KEY
    assert key_scenes.key_chapters(5, [{"id": "climax", "name": "c", "number": 1}]) == \
        [{"number": 5, "why": "the last chapter"}]  # never chapter 1


def test_check_version_and_signals():
    a = " ".join(["Mara climbed the stair and listened to the sea."] * 40)
    assert key_scenes.check_version(a, "short") == "TOO_SHORT"
    assert key_scenes.check_version(a, a) == "SAME"
    assert key_scenes.check_version(a, a + " " + a) == "LENGTH"
    b = " ".join(["Tom waited below the light and counted the waves."] * 40)
    assert key_scenes.check_version(a, b) is None
    assert key_scenes.signals(a, a) == "tie"
    tells = " ".join(["Her heart hammered. A testament to resilience, it was a tapestry of dread."] * 30)
    assert key_scenes.signals(tells, b) == "b" and key_scenes.signals(b, tells) == "a"


# ====================================================================== the run forecast
def test_forecast_counts_the_new_steps_and_their_switches():
    on = run_forecast.option_calls(run_forecast.options_of(None, {}), 10, 3)
    assert on["predictability_probe"]["calls"] > 1 and on["key_scene_versions"]["calls"] == 2
    assert on["key_scene_picks"]["calls"] == 2 * 2 and on["key_scene_picks"]["to"] == "others"
    assert on["pairwise"]["calls"] > 0
    off = run_forecast.option_calls(run_forecast.options_of(None, {"predictability_probe": False,
                                                                   "key_scene_versions": False,
                                                                   "pairwise": False}), 10, 3)
    assert off["predictability_probe"]["calls"] == 0 and off["key_scene_versions"]["calls"] == 0
    assert off["pairwise"]["calls"] == 0 and off["key_scene_picks"]["calls"] == 0
    one = run_forecast.option_calls(run_forecast.options_of(None, {}), 10, 1)
    assert one["key_scene_versions"]["calls"] == 2 and one["key_scene_picks"]["calls"] == 0  # Akọwe's signals judge
    assert run_forecast.option_calls(run_forecast.options_of(None, {}), 3, 3)["key_scene_versions"]["calls"] == 1


# ====================================================================== in a ⚡ run
def _events(run, prefix):
    return [e for e in run["events"] if str(e.get("code") or "").startswith(prefix)]


def _all_guessed(ctx):
    return {"predictions": [{"turn": t["turn"], "prediction": p["planned"], "matches": "yes"}
                            for t, p in zip(ctx["turns"], ctx["planned_turns"])]}


def _prefer(marker, present=True):
    def pick(ctx):
        vs = ctx["versions"]
        hit = next((v["id"] for v in vs if (marker in v["text"]) == present), vs[0]["id"])
        return {"better": hit, "why": "It lands harder."}
    return pick


def _long(text_seed, n=34):
    return "# Chapter\n\n" + "\n\n".join(f"{text_seed} Mara counted the steps of the reef path, number {i}, while "
                                         "the tide turned below the old light." for i in range(n))


def test_default_run_probes_the_plan_and_changes_nothing(tmp_path):
    app, fake, run = book(tmp_path, SlotFake())
    assert len(fake.prompts.get("predictability_probe") or []) == 1
    _sys, ctx = fake.prompts["predictability_probe"][0]
    assert ctx["turns"] and ctx["planned_turns"] and "main_plot" not in ctx  # the plot summary would give it away
    assert all(len(ctx["story"]) >= t["chapter"] - 1 for t in ctx["turns"])
    assert _events(run, "PREDICT_PROBED") and not _events(run, "PREDICT_REVISING")
    assert fake.predict_fixes == 0
    line = run["report"]["predictability"]
    assert line.startswith("🔮") and "not easy to guess" in line
    rep = app.reports.latest(run["project_id"], "main")
    assert line in rep["plan_and_scenes"]
    assert "## 🔮 Plan surprises and key scenes" in pairwise.report_md(rep)
    # the fake's chapters are too short for a second version: no extra writer answer
    assert not fake.prompts.get("key_scene_version")
    assert (run.get("key_scenes") or {}).get("chapters", {}).get("ch3", {}).get("state") == "too_short"


def test_a_predictable_plan_is_revised_once_and_the_better_plan_kept(tmp_path):
    fake = SlotFake()
    fake.predict_script = [_all_guessed]          # the second probe (default) guesses nothing
    fake.pairwise_script = [_prefer(MARK_TURN)]
    app, fake, run = book(tmp_path, fake)
    assert fake.predict_fixes == 1 and len(fake.prompts["predictability_probe"]) == 2
    assert _events(run, "PREDICT_REVISING") and _events(run, "PREDICT_REVISED_KEPT")
    _sys, fix_ctx = next((s, c) for s, c in fake.prompts.get("predict_fix") or [])
    assert str(fix_ctx.get("author_note")).startswith("🔮") and "guessed 2 of 2" in fix_ctx["author_note"]
    _bp, outline, _chs = chapters(app, run["project_id"])
    assert MARK_TURN in outline["data"]["chapters"][-1]["summary"]
    mem = run_mem(app, run)
    assert mem["kept"] == "revised" and mem["guessed"] == 2 and mem["after"]["guessed"] == 0
    assert mem["pairwise"]["winner"] == "b" and mem["pairwise"]["judges"] == 1
    _s, pctx = fake.prompts["pairwise"][0]
    assert {v["id"] for v in pctx["versions"]} == {"1", "2"} and pctx["what"].startswith("the chapter-by-chapter")
    assert "revised plan is kept (head to head)" in run["report"]["predictability"]


def test_the_first_plan_comes_back_when_it_wins_head_to_head(tmp_path):
    fake = SlotFake()
    fake.predict_script = [_all_guessed, _all_guessed]
    fake.pairwise_script = [_prefer(MARK_TURN, present=False)]
    app, fake, run = book(tmp_path, fake)
    assert fake.predict_fixes == 1 and _events(run, "PREDICT_FIRST_KEPT")
    _bp, outline, _chs = chapters(app, run["project_id"])
    assert MARK_TURN not in outline["data"]["chapters"][-1]["summary"]
    assert outline["lifecycle"] in ("APPROVED", "LOCKED")
    assert "first plan was better (head to head)" in run["report"]["predictability"]


def run_mem(app, run):
    return app.autobook.get(run["id"])["predictability"]


def test_a_key_chapter_is_written_twice_and_the_winner_kept(tmp_path):
    fake = SlotFake()
    fake.chapter_texts = {"ch3": _long("First take.")}
    fake.key_scene_script = [lambda ctx: {"approach": "opens at the reef", "text": _long(MARK_B)}]
    fake.pairwise_script = [_prefer(MARK_B)]
    app, fake, run = book(tmp_path, fake)
    _sys, kctx = fake.prompts["key_scene_version"][0]
    assert kctx["chapter"]["number"] == 3 and kctx["first_version_opening"].startswith("# Chapter")
    assert "writing_brief" in kctx
    assert _events(run, "KEY_SCENE_SECOND")
    _bp, _outline, chs = chapters(app, run["project_id"])
    final = (chs[-1][1].get("data") or {}).get("text") or ""
    assert MARK_B in final and chs[-1][1]["lifecycle"] in ("APPROVED", "LOCKED")
    row = app.autobook.get(run["id"])["key_scenes"]["chapters"]["ch3"]
    assert row["kept"] == "second" and row["how"] == "ai" and row["why"] == "the last chapter"
    assert "second version was kept in chapter 3" in run["report"]["key_scenes"]
    # the writer wrote the second version; the judge was another AI
    assert [s for s, k in fake.per_slot if k == "key_scene_version"] == [row["writer"]]
    judges = [s for s, k in fake.per_slot if k == "pairwise"]
    assert judges and row["writer"] not in judges


def test_garbage_answers_leave_the_book_as_before(tmp_path):
    fake = SlotFake()
    fake.chapter_texts = {"ch3": _long("First take.")}
    fake.predict_script = [{"predictions": "junk"}]
    fake.key_scene_script = [{"approach": "x", "text": _long(MARK_B)}]
    fake.pairwise_script = [{"better": "maybe", "why": ""}]   # not a valid answer: Akọwe's own signals decide
    app, fake, run = book(tmp_path, fake)
    assert run["status"] == "done"
    assert _events(run, "PREDICT_NO_ANSWER") and fake.predict_fixes == 0
    row = app.autobook.get(run["id"])["key_scenes"]["chapters"]["ch3"]
    assert row["how"] == "signals" and row["kept"] == "first"
    _bp, _outline, chs = chapters(app, run["project_id"])
    assert MARK_B not in ((chs[-1][1].get("data") or {}).get("text") or "")
    # an AI that cannot answer at all
    fake2 = SlotFake()
    fake2.fail_kind("predictability_probe", *[AkoweError("UPSTREAM_UNAVAILABLE", "", "down") for _ in range(4)])
    app2, fake2, run2 = book(tmp_path, fake2, name="data2")
    assert run2["status"] == "done" and _events(run2, "PREDICT_NO_ANSWER")


def test_the_switches_turn_everything_off(tmp_path):
    fake = SlotFake()
    fake.chapter_texts = {"ch3": _long("First take.")}
    fake.predict_script = [_all_guessed]
    fake.key_scene_script = [lambda ctx: {"approach": "x", "text": _long(MARK_B)}]
    app, fake, run = book(tmp_path, fake, body={"predictability_probe": False, "key_scene_versions": False,
                                                "pairwise": False})
    assert not fake.prompts.get("predictability_probe") and not fake.prompts.get("key_scene_version")
    assert not fake.prompts.get("pairwise") and fake.predict_fixes == 0
    assert "predictability" not in (run.get("report") or {})
    with pytest.raises(AkoweError):
        app.autobook.start("author", {"author_confirms": True, "key_scene_versions": "yes"})


def test_the_doctor_keeps_the_plan_that_wins_head_to_head(tmp_path):
    fake = SlotFake()
    fake.plan_review_script = [6, 6]                   # round 1 under the target → one revision → round 2: 9s
    fake.pairwise_script = [_prefer("(doctor fix)", present=False)]
    app, fake, run = book(tmp_path, fake)
    assert fake.doctor_fixes == 1
    mem = app.autobook.get(run["id"])["story_doctor"]
    assert mem["pairwise"]["winner"] == "a" and mem["best_version"] == mem["rounds"][0]["version"]
    _bp, outline, _chs = chapters(app, run["project_id"])
    assert "(doctor fix)" not in outline["data"]["chapters"][0]["summary"]
    assert "head-to-head comparison preferred the first plan" in run["report"]["doctor"]
    assert _events(run, "DOCTOR_PAIRWISE")


def test_the_doctor_falls_back_to_the_scores_on_a_tie(tmp_path):
    fake = SlotFake()
    fake.plan_review_script = [6, 6]   # the default head-to-head answer is a tie
    app, fake, run = book(tmp_path, fake)
    mem = app.autobook.get(run["id"])["story_doctor"]
    assert mem["pairwise"]["winner"] == "tie" and mem["best_version"] == mem["rounds"][-1]["version"]
    _bp, outline, _chs = chapters(app, run["project_id"])
    assert "(doctor fix)" in outline["data"]["chapters"][0]["summary"]
    assert "head-to-head" not in run["report"]["doctor"]


def test_with_a_story_shape_the_turns_and_key_chapters_come_from_its_beats(tmp_path):
    fake = SlotFake()
    fake.chapter_texts = {"ch3": _long("First take.")}
    fake.key_scene_script = [lambda ctx: {"approach": "x", "text": _long(MARK_B)}]
    app, fake, run = book(tmp_path, fake, body={"choices": {"shape": "turning_points"}})
    _sys, ctx = fake.prompts["predictability_probe"][0]
    names = [t["name"] for t in ctx["turns"]]
    shape_names = {"The change of plans", "The point of no return", "The major setback", "The climax"}
    assert names and set(names) <= shape_names
    row = app.autobook.get(run["id"])["key_scenes"]["chapters"]["ch3"]
    assert row["why"] in ("The major setback", "The climax")
    assert row["kept"] == "first"  # the default head-to-head answer is a tie: the first version stays
    assert _events(run, "KEY_SCENE_FIRST")
