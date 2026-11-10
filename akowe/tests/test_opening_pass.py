"""✍ Chapter 1 rewritten last with the whole book in view (opening_pass.py) and ✍ two first pages, keep the better one
(first_page.py): kept / not kept, the tie rule, fallbacks, the author's own chapter 1, settings off and the forecast."""
from __future__ import annotations

import copy

import pytest

from akowe import first_page as fp
from akowe import opening_pass as op
from akowe import chapter_brief, run_forecast
from akowe.book_path import BookPath
from akowe.book_report import DIM_KEYS, book_chapters
from akowe.errors import AkoweError

from autobook_fake import OPENING_A, OPENING_B
from test_failover_review import SlotFake, make_app, run_book  # noqa: F401

FIRST = "The fog rolled in over Gullhaven before dawn"
NEW_OPENING = ("Mara Vell stood on the hundred and twelfth step of Gullhaven lighthouse at dawn, the lantern in one "
               "hand and her master Tom Reed's last letter in the other, because a week ago the light had gone dark "
               "and nobody in the harbour would say why.")


def _agg(overall, reviewers=2, **dims):
    return {"overall": overall, "reviewers": reviewers,
            "dimensions": [{"dimension": k, "label": k, "median": v, "n": 2} for k, v in dims.items()]}


def _review(score, quote="The lamp room was cold."):
    def answer(ctx):
        return {"book_scores": {d: (9 if score >= 8 and d in ("atmosphere", "premise") else score) for d in DIM_KEYS},
                "strengths": [{"point": "Vivid.", "quote": quote}],
                "weaknesses": [{"point": "Helpers cooperate.", "quote": "Only old Nessa at the net sheds would talk"}],
                "try_next": [], "summary": "Read again.",
                "score_evidence": [{"dimension": d, "quote": quote, "why": "vivid"} for d in ("atmosphere", "premise")]}
    return answer


def _rewrite_opening(ctx):
    """The writer reworks the opening stretch (the first finding) into a clearer first moment."""
    f = next(f for f in ctx["findings"] if f["dimension"] == "opening")
    first = f["passage"].split("\n")[0]
    assert ctx["keep"] and all(k in first for k in ctx["keep"])  # the editor's best line: kept, as the save checks
    return {"replacements": [{"finding_id": f["id"], "original": first, "replacement": NEW_OPENING + " " + first}]}


def _ch1(app, run):
    return book_chapters(BookPath(app.engine, "author", run["project_id"], "main"))[0]


def _codes(run):
    return [e.get("code") for e in run["events"]]


# ====================================================================== the keep rule (no AI)
def test_the_keep_rule_up_tie_and_down():
    before = _agg(7.6, rule_rigor=6, peril=6)
    up = op.decide(before, _agg(7.8, rule_rigor=6, peril=7), 1, 1)
    assert up["keep"] and "went up" in up["why"]
    tie_better = op.decide(before, _agg(7.6, rule_rigor=6, peril=6), 2, 0)
    assert tie_better["keep"] and "2 → 0" in tie_better["why"]
    tie_same = op.decide(before, _agg(7.6, rule_rigor=6, peril=6), 1, 1)
    assert not tie_same["keep"] and "did not go down" in tie_same["why"]
    down = op.decide(before, _agg(7.4, rule_rigor=6, peril=6), 3, 0)
    assert not down["keep"] and "went down" in down["why"]
    drop = op.decide(before, _agg(7.9, rule_rigor=9, peril=4.5), 3, 0)  # higher overall, but a dimension fell
    assert not drop["keep"] and drop["drops"]
    fewer = op.decide(before, _agg(8.5, reviewers=1, rule_rigor=9, peril=9), 3, 0)
    assert not fewer["keep"]  # not every reviewer read it: not comparable
    assert not op.decide(before, {}, 3, 0)["keep"]
    assert op.line(dict(up)).startswith("✍ Chapter 1 rewritten with the whole book in view: kept (7.6 → 7.8/10)")
    assert "not kept, the original chapter 1 stays" in op.line(down)


def test_chapter_notes_count_quotes_from_chapter_1_and_points_that_name_it():
    ch1 = "The fog rolled in over Gullhaven before dawn. The lamp room was cold."
    reviews = [{"status": "done", "weaknesses": [
        {"point": "Slow start.", "quote": "The lamp room was cold."},          # quotes chapter 1
        {"point": "The opening chapter is confusing.", "quote": ""},           # names it
        {"point": "Helpers cooperate.", "quote": "Only old Nessa would talk"},  # another chapter
    ]}, {"status": "failed", "weaknesses": [{"point": "Chapter 1 drags.", "quote": ""}]}]
    assert op.chapter_notes(reviews, ch1) == 2


def test_the_opening_stretch_is_the_first_paragraphs_word_for_word():
    text = "# The light\n\n" + "A short line. " * 10 + "\n\n" + "Second paragraph here. " * 30 + "\n\nThird."
    s = op.opening_stretch(text)
    assert s in text and s.startswith("A short line.") and op.OPENING_MIN <= len(s) <= op.OPENING_MAX
    assert s.endswith(".")
    assert op.opening_stretch("Just one line.") == "Just one line."


# ====================================================================== ✍ chapter 1 rewritten last: kept / not kept
def test_a_new_chapter_1_the_same_reviewers_score_higher_is_kept_reviewed_and_exported(tmp_path):
    fake = SlotFake()
    fake.opening_rewrite_script = [_rewrite_opening]
    fake.book_review_script = [None, None, _review(8), _review(8)]
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story", "improve_pass": False, "first_page": False})
    assert run["status"] == "done", run.get("problem")
    mem = app.autobook.get(run["id"])["opening"]
    assert mem["kept"] is True and mem["result"]["after"] > mem["result"]["before"], mem
    assert mem["line"].startswith("✍ Chapter 1 rewritten with the whole book in view: kept")
    assert "OPENING_KEPT" in _codes(run)
    ch1 = _ch1(app, run)
    assert ch1["text"].startswith(NEW_OPENING) and ch1["approved"]  # reviewed and approved in the run
    st = {s["id"]: s for s in run["steps"]}
    assert st["opening"]["message"] == mem["line"] and st["export"]["state"] == "done"
    assert run["report"]["opening"] == mem["line"]
    rep = app.reports.latest(run["project_id"], "main")
    assert rep["opening"] == mem["line"] and rep["aggregate"]["overall"] == mem["result"]["after"]
    # what the writer was sent: the whole book in view and the rules
    _task, ctx = fake.prompts["opening_rewrite"][0]
    ob = ctx["opening_brief"]
    assert "Chapter 3:" in ob["summary"] and ob["ending"]["chapter"] == 3 and ob["ending"]["last_lines"]
    assert any("who is there, where we are and what just happened" in r for r in ob["rules"])
    assert any("every name" in r for r in ob["rules"])
    assert ctx["findings"][0]["dimension"] == "opening" and ctx["findings"][0]["passage"] in ctx["chapter_text"]
    assert "OPENING PASS" in _task
    # the step runs after the beta readers and before the improve pass
    ids = [s["id"] for s in run["steps"]]
    assert ids.index("beta") < ids.index("opening") < ids.index("improve")


def test_the_original_chapter_1_stays_when_the_score_drops(tmp_path):
    fake = SlotFake()
    fake.opening_rewrite_script = [_rewrite_opening]
    fake.book_review_script = [None, None, _review(5), _review(5)]
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story", "improve_pass": False, "first_page": False})
    assert run["status"] == "done", run.get("problem")
    mem = app.autobook.get(run["id"])["opening"]
    assert mem["kept"] is False and mem["result"]["after"] < mem["result"]["before"]
    assert "not kept, the original chapter 1 stays" in mem["line"]
    assert "OPENING_NOT_KEPT" in _codes(run)
    assert _ch1(app, run)["text"].startswith(FIRST)  # nothing changed in the book


def test_the_beta_readers_notes_and_the_twist_reach_the_brief(tmp_path):
    fake = SlotFake()
    fake.plot_obligations = ["The brass key must open the lighthouse door."]
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story", "improve_pass": False, "first_page": False, "beta_reader": True,
                         "beta_readers": 3})
    assert run["status"] == "done", run.get("problem")
    _task, ctx = fake.prompts["opening_rewrite"][0]
    ob = ctx["opening_brief"]
    assert ob["chapter_1_notes"] and all(n["from"] in ("beta readers", "book reviewers", "editor")
                                         for n in ob["chapter_1_notes"])
    assert any(n["from"] == "beta readers" for n in ob["chapter_1_notes"])
    assert any("guessed the twist" in h for h in ob["keep_hidden"])
    assert any("brass key" in s for s in ob["setups"])
    dims = [f["dimension"] for f in ctx["findings"]]
    assert dims[0] == "opening" and "setup" in dims and "keep_hidden" in dims and len(dims) <= op.MAX_FINDINGS


def test_the_writers_changes_that_do_not_match_leave_chapter_1_as_it_was(tmp_path):
    fake = SlotFake()  # the default fake writer returns no usable replacement
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story", "improve_pass": False, "first_page": False})
    mem = app.autobook.get(run["id"])["opening"]
    assert mem["kept"] is False and "OPENING_UNRESOLVED" in _codes(run)
    assert "book_review" not in fake.kinds[fake.kinds.index("opening_rewrite"):]  # no re-read was needed
    assert _ch1(app, run)["text"].startswith(FIRST)


def test_an_ai_problem_in_the_opening_pass_never_stops_the_book(tmp_path):
    fake = SlotFake()
    fake.fail_kind("opening_rewrite", *[AkoweError("INVALID_INPUT", "", "bad answer")] * 6)
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story", "improve_pass": False, "first_page": False})
    assert run["status"] == "done", run.get("problem")
    mem = app.autobook.get(run["id"])["opening"]
    assert mem["kept"] is False and _ch1(app, run)["text"].startswith(FIRST)
    assert {"OPENING_PROPOSE_FAILED", "OPENING_FAILED"} & set(_codes(run))


def test_a_chapter_1_the_author_wrote_is_never_touched(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story", "improve_pass": False, "opening_pass": False, "first_page": False})
    assert run["status"] == "done", run.get("problem")
    pid = run["project_id"]
    bp = BookPath(app.engine, "author", pid, "main")
    ch = book_chapters(bp)[0]
    rec = bp.rec(ch["record_id"], ch["version"])
    data = copy.deepcopy(rec["data"])
    data["text"] = "I wrote this chapter myself. " + data["text"]
    resp = bp.dispatch("C02", "UPDATE", base_ref=rec["ref"], payload=data)
    assert resp["status"] == "DRAFT", resp
    assert bp.approve_ref(resp["output_refs"][0]).get("ok")
    svc = app.autobook
    live = svc.get(run["id"])
    live["settings"]["opening_pass"] = True
    st = {}
    n = len(fake.kinds)
    svc._tl.review, svc._tl.assist, svc._tl.engine = app.review, app.assist, app.engine  # noqa: SLF001
    try:
        op.run_step(svc, live, st)
    finally:
        svc._tl.review = svc._tl.assist = svc._tl.engine = None  # noqa: SLF001
    assert live["opening"]["skipped"] == "AUTHOR_CHAPTER" and "wrote chapter 1 yourself" in st["message"]
    assert fake.kinds[n:] == []  # no AI was asked
    assert book_chapters(bp)[0]["text"].startswith("I wrote this chapter myself.")


# ====================================================================== ✍ two first pages, keep the better one
def test_two_first_pages_one_reviewer_picks_and_chapter_1_starts_from_it(tmp_path):
    fake = SlotFake()
    fake.use_first_page = True
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story", "improve_pass": False, "opening_pass": False})
    assert run["status"] == "done", run.get("problem")
    mem = app.autobook.get(run["id"])["first_page"]
    assert mem["state"] == "picked" and mem["pick"] == "B" and "concrete moment" in mem["why"]
    assert mem["reviewer"] and mem["writer"] and mem["reviewer"] != mem["writer"]
    assert mem["on_page"] is True and "FIRST_PAGE_PICKED" in _codes(run)
    assert "picked opening B" in mem["line"]
    item = next(i for s in run["steps"] if s["id"] == "chapters" for i in s["items"] if i["id"] == "ch1")
    assert item["first_page"]["pick"] == "B"
    # one request for both openings, before chapter 1; the pick by another AI; then the chapter
    k = fake.kinds
    assert k.count("openings") == 1 and k.count("first_page_pick") == 1
    assert k.index("openings") < k.index("first_page_pick") < k.index("C02")
    _t, pick_ctx = fake.prompts["first_page_pick"][0]
    assert [o["id"] for o in pick_ctx["openings"]] == ["A", "B"] and pick_ctx["openings"][1]["text"] == OPENING_B
    # the chapter writer got the chosen opening in its brief; chapter 1 starts with it
    c02 = [c for _t, c in fake.prompts["C02"] if (c.get("request_payload") or {}).get("chapter_id") == "ch1"]
    assert c02 and c02[0]["writing_brief"]["first_page"]["text"] == OPENING_B
    assert any("First page" in r for r in c02[0]["writing_brief"]["rules"])
    assert _ch1(app, run)["text"].startswith(OPENING_B[:60])
    # only chapter 1, and the opening leaves the brief once it is approved
    assert all("first_page" not in (c.get("writing_brief") or {}) for _t, c in fake.prompts["C02"]
               if (c.get("request_payload") or {}).get("chapter_id") != "ch1")
    outline = BookPath(app.engine, "author", run["project_id"], "main").outline()
    b, _m = chapter_brief.build(app.store, run["project_id"], "main", outline, "ch1")
    assert "first_page" not in (b or {})


@pytest.mark.parametrize("setup,code", [
    (lambda f: f.openings_script.append({"openings": [{"approach": "x", "text": OPENING_A}]}), "OPENINGS_MISSING"),
    (lambda f: f.openings_script.append({"openings": [{"approach": "x", "text": "Too short."},
                                                      {"approach": "y", "text": OPENING_B}]}), "OPENINGS_LENGTH"),
    (lambda f: f.openings_script.append({"openings": [{"approach": "x", "text": OPENING_A},
                                                      {"approach": "y", "text": OPENING_A}]}), "OPENINGS_SAME"),
    (lambda f: f.pick_script.append({"pick": "C", "why": "neither"}), "PICK_INVALID"),
    (lambda f: f.fail_kind("openings", *[AkoweError("INVALID_INPUT", "", "bad")] * 6), "INVALID_INPUT"),
])
def test_a_first_page_problem_falls_back_to_writing_chapter_1_as_before(tmp_path, setup, code):
    fake = SlotFake()
    fake.use_first_page = True
    setup(fake)
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story", "improve_pass": False, "opening_pass": False})
    assert run["status"] == "done", run.get("problem")
    mem = app.autobook.get(run["id"])["first_page"]
    assert mem["state"] == "fallback" and mem["code"] == code
    assert "FIRST_PAGE_PICKED" not in _codes(run) and "line" not in mem
    assert all("first_page" not in (c.get("writing_brief") or {}) for _t, c in fake.prompts["C02"])
    assert _ch1(app, run)["text"].startswith(FIRST)  # chapter 1 written exactly as before


def test_with_one_ai_no_reviewer_picks_and_chapter_1_is_written_as_before(tmp_path):
    fake = SlotFake()
    fake.use_first_page = True
    app = make_app(tmp_path, fake, slots=("AI-1",))
    run = run_book(app, {"length": "short_story", "improve_pass": False, "opening_pass": False})
    assert run["status"] == "done", run.get("problem")
    mem = app.autobook.get(run["id"])["first_page"]
    assert mem["state"] == "fallback" and mem["code"] == "NO_REVIEWER"
    assert "first_page_pick" not in fake.kinds  # the writer never judges its own openings


# ====================================================================== settings off = the old behaviour; forecast
def test_both_switched_off_is_the_old_behaviour(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story", "improve_pass": False, "opening_pass": False, "first_page": False})
    assert run["status"] == "done", run.get("problem")
    st = {s["id"]: s for s in run["steps"]}
    assert st["opening"]["state"] == "done" and st["opening"]["message"] == "Not asked for in this run"
    assert not {"openings", "first_page_pick", "opening_rewrite"} & set(fake.kinds)
    live = app.autobook.get(run["id"])
    assert "first_page" not in live and "opening" not in live
    assert live["settings"]["opening_pass"] is False and live["settings"]["first_page"] is False
    # an older run (no setting stored) does neither
    assert not fp.enabled({"settings": {}}) and not op.enabled({"settings": {}})
    with pytest.raises(AkoweError):
        app.autobook.start("author", {"author_confirms": True, "opening_pass": "yes"})
    with pytest.raises(AkoweError):
        app.autobook.start("author", {"author_confirms": True, "first_page": 1})


def test_both_are_on_by_default_and_counted_in_the_forecast(tmp_path):
    app = make_app(tmp_path, SlotFake())
    on = run_forecast.option_calls(run_forecast.options_of(app, {}), 3, 3)
    off = run_forecast.option_calls(run_forecast.options_of(app, {"opening_pass": False, "first_page": False}), 3, 3)
    assert on["first_page"]["calls"] == 2 and off["first_page"]["calls"] == 0
    assert on["opening"]["calls"] == 1 + 2 + 1 and off["opening"]["calls"] == 0  # rewrite + 2 re-reads + review
    assert run_forecast.option_calls(run_forecast.options_of(app, {}), 3, 1)["opening"]["calls"] == 3
    est_on = run_forecast.estimate(app, {"length": "short_story"})
    est_off = run_forecast.estimate(app, {"length": "short_story", "opening_pass": False, "first_page": False})
    assert est_on["calls"]["expected"] - est_off["calls"]["expected"] == 6
    assert {"option:opening", "option:first_page"} <= {r["step"] for r in est_on["steps"]}
    assert app.autobook._clean_settings({})["opening_pass"] is True  # noqa: SLF001
    assert app.autobook._clean_settings({})["first_page"] is True  # noqa: SLF001
