"""📈 Book quality, batch 1 ("AI novel quality beyond eight"): 📜 the promise ledger (every set-up with the chapters
where it must pay off, told to the writer and checked on the page), 📐 the "Five turning points" story shape (the
new-book default), and 🤖 the habits of AI-written books checked on the plan (🩺 story doctor) and on the finished
book (🎯 ending check)."""
from __future__ import annotations

import pytest

from akowe import ai_defaults, ending_check, promise_ledger, story_shape
from akowe import planned as planned_mod
from akowe import story_doctor as sd

import autobook_fake
from test_failover_review import SlotFake, make_app, run_book
from test_world_planned import book, chapters

KEY = "Mara hides the brass key under the third lighthouse stair"
PAYOFF = "Mara uses the brass key to open the sealed lamp room"


# ====================================================================== 📜 the ledger: checking the AI's answer
def test_validate_clamps_orders_dedupes_and_spreads_the_deadlines():
    raw = [{"promise": KEY, "plant": 1, "payoff": PAYOFF, "payoff_from": 2, "payoff_by": 3},
           {"promise": KEY.upper(), "plant": 1, "payoff": "again", "payoff_from": 2, "payoff_by": 3},  # duplicate
           {"promise": "", "plant": 1, "payoff": "x", "payoff_from": 2, "payoff_by": 3},                # no text
           {"promise": "The keeper's warning about the tide", "plant": 9, "payoff": "the tide traps them",
            "payoff_from": 1, "payoff_by": 0},                                                         # out of range
           "junk"]
    out, problems = promise_ledger.validate(raw, 6)
    assert [e["id"] for e in out] == ["p1", "p2"] and out[0]["promise"] == KEY
    assert (out[0]["plant"], out[0]["payoff_from"], out[0]["payoff_by"]) == (1, 2, 3)
    p2 = out[1]
    assert p2["plant"] == 5 and p2["payoff_from"] == 6 and p2["payoff_by"] == 6  # plant before payoff, inside the book
    assert problems == ["promise 2: its chapters were corrected"]
    # never more than MAX_DUE payoffs due in one chapter (the extra ones move one chapter on)
    many = [{"promise": f"set-up {i}", "plant": 1, "payoff": f"payoff {i}", "payoff_from": 2, "payoff_by": 3}
            for i in range(5)]
    out, _p = promise_ledger.validate(many, 8)
    due = [e["payoff_by"] for e in out]
    assert sorted(due) == [3, 3, 4, 4, 5]
    # the cap and the short book
    lots = [{"promise": f"p {i}", "plant": 1, "payoff": "y", "payoff_from": 2, "payoff_by": 40} for i in range(30)]
    assert len(promise_ledger.validate(lots, 40)[0]) == promise_ledger.MAX_PROMISES
    assert promise_ledger.validate(many, 1) == ([], ["the book has fewer than two chapters"])
    assert promise_ledger.validate("junk", 5) == ([], [])


# ====================================================================== 📜 in a ⚡ run
def _ledger(ctx):
    n = len(ctx["chapters"])
    return {"promises": [{"promise": KEY, "plant": 1, "payoff": PAYOFF, "payoff_from": 2, "payoff_by": min(3, n)},
                         {"promise": "The keeper's log names a second keeper", "plant": 2,
                          "payoff": "the second keeper is found on the rocks", "payoff_from": n, "payoff_by": n}]}


def test_make_a_book_builds_the_ledger_tells_the_writer_and_checks_the_page(tmp_path):
    fake = SlotFake()
    fake.planned_fix = True  # a payoff the first draft missed is worked in by the planned-to-page fix
    fake.ledger_script = [_ledger]
    app, fake, run = book(tmp_path, fake)
    pid = run["project_id"]
    assert run["status"] == "done", run.get("problem")
    # 1. one AI call after the outline, stored with the outline revision
    assert len(fake.prompts.get("ledger") or []) == 1
    _sys, ctx = fake.prompts["ledger"][0]
    assert ctx["chapters"] and "main_plot" in ctx and "premise" in ctx
    assert any(e.get("code") == "LEDGER_BUILT" for e in run["events"])
    bp, outline, chs = chapters(app, pid)
    led = promise_ledger.current(app.store, pid, "main", outline)
    assert led and [e["id"] for e in led["entries"]] == ["p1", "p2"]
    assert led["entries"][0]["plant_id"] == chs[0][0]
    # 2. the writer of chapter 1 was told to plant it, the reviewer got the same lines
    briefs = [((c.get("writing_brief") or (c.get("request_payload") or {}).get("writing_brief")) or {})
              for _s, c in fake.prompts.get("C02") or []]
    with_promises = [b for b in briefs if b.get("promises")]
    assert with_promises and any(f"Plant: {KEY}" in b["promises"] for b in with_promises)
    assert any(promise_ledger.WRITER_RULE in (b.get("rules") or []) for b in with_promises)
    reviews = [c for _s, c in fake.prompts.get("review") or [] if c.get("promises")]
    assert reviews and reviews[0]["promises_note"] == promise_ledger.REVIEW_NOTE
    # 3. the planned-to-page check lists the plant in chapter 1 (required, high priority, with the promise id)
    items = planned_mod.planned_items(bp, outline, chs[0][0])
    plant = [i for i in items if i["kind"] == "promise_plant"]
    assert plant and plant[0]["promise"] == "p1" and plant[0]["required"]
    assert plant[0]["label"].startswith("Set-up to plant: ")
    # 4. the status of each promise, the book report and the ending check
    rows = {r["id"]: r for r in promise_ledger.status(app.store, pid, "main", outline, len(chs))}
    assert set(rows) == {"p1", "p2"} and all(r["status"] in ("resolved", "planted", "open", "overdue")
                                             for r in rows.values())
    info = promise_ledger.report_info(app.store, pid, "main")
    assert info and info["total"] == 2 and info["line"].startswith("📜 Promise ledger: ")
    md = promise_ledger.report_md(info)
    assert md[0] == "## Promises and payoffs" and any(KEY in x for x in md)
    res = ending_check.get(app.store, pid, "main")
    assert res is not None


def test_no_ledger_answer_leaves_the_book_as_before(tmp_path):
    fake = SlotFake()  # the fake's default ledger answer is empty
    app, fake, run = book(tmp_path, fake)
    pid = run["project_id"]
    assert run["status"] == "done", run.get("problem")
    bp, outline, chs = chapters(app, pid)
    assert promise_ledger.current(app.store, pid, "main", outline) is None
    assert not any(e.get("code") == "LEDGER_BUILT" for e in run["events"])
    assert promise_ledger.chapter_items(app.store, pid, "main", outline, chs[0][0]) == []
    # Q3 (C-10.2-j): the run says so (LEDGER_EMPTY) and the report tells the author the payoffs were not tracked
    assert any(e.get("code") == "LEDGER_EMPTY" for e in run["events"])
    info = promise_ledger.report_info(app.store, pid, "main")
    assert info["missing"] and info["rows"] == [] and "not tracked" in info["line"]
    assert not [i for i in planned_mod.planned_items(bp, outline, chs[0][0]) if i["kind"].startswith("promise_")]


def test_a_ledger_for_an_older_outline_revision_is_not_used(tmp_path):
    fake = SlotFake()
    fake.ledger_script = [_ledger]
    app, fake, run = book(tmp_path, fake)
    pid = run["project_id"]
    bp, outline, chs = chapters(app, pid)
    assert promise_ledger.current(app.store, pid, "main", outline)
    older = dict(outline, version=outline["version"] + 1)
    assert promise_ledger.current(app.store, pid, "main", older) is None
    assert promise_ledger.writer_brief(app.store, pid, "main", older, chs[0][0]) == []


def test_chapter_items_plant_due_overdue_and_optional():
    class _St:
        def __init__(self):
            self.s = {}

        def get_setting(self, k):
            return self.s.get(k)

        def set_setting(self, k, v):
            self.s[k] = v
    st = _St()
    outline = {"record_id": "o1", "version": 1, "data": {"chapters": [
        {"chapter_id": f"ch{i}", "objective": f"objective {i}", "summary": f"summary {i}"} for i in range(1, 7)]}}
    chs = promise_ledger._chapters(outline)  # noqa: SLF001
    if len(chs) != 6:
        pytest.skip("outline shape differs from this engine's outline_chapters")
    entries, _p = promise_ledger.validate(
        [{"promise": "A", "plant": 1, "payoff": "pay A", "payoff_from": 2, "payoff_by": 4},
         {"promise": "B", "plant": 2, "payoff": "pay B", "payoff_from": 3, "payoff_by": 3}], 6)
    promise_ledger.save(st, "p", "main", {"outline": "o1", "version": 1, "chapters": 6, "entries": entries})
    ids = [c["chapter_id"] for c in chs]
    one = promise_ledger.chapter_items(st, "p", "main", outline, ids[0])
    assert [(i["id"], i["when"]) for i in one] == [("p1", "plant")]
    three = {(i["id"], i["when"]) for i in promise_ledger.chapter_items(st, "p", "main", outline, ids[2])}
    assert three == {("p1", "may"), ("p2", "now")}
    lines = promise_ledger.writer_brief(st, "p", "main", outline, ids[2])
    assert any(x.startswith("Pay off now: pay B") for x in lines) and any(x.startswith("May pay off: pay A")
                                                                            for x in lines)
    # chapter 5: A is overdue (still not found on the page) -> required, marked overdue
    five = promise_ledger.chapter_items(st, "p", "main", outline, ids[4])
    a = next(i for i in five if i["id"] == "p1")
    assert a["required"] and a.get("overdue") and "overdue" in promise_ledger.writer_brief(st, "p", "main", outline,
                                                                                           ids[4])[0]
    # once a planned-to-page check found A's payoff in chapter 3, later chapters are no longer asked for it
    st.s["planned_checks:p:main"] = {"r3:1": {"chapter_id": ids[2], "items": [
        {"kind": "promise_payoff", "promise": "p1", "status": "on_page"}]}}
    assert not [i for i in promise_ledger.chapter_items(st, "p", "main", outline, ids[4]) if i["id"] == "p1"]
    rows = {r["id"]: r for r in promise_ledger.status(st, "p", "main", outline, 6)}
    assert rows["p1"]["status"] == "resolved" and rows["p1"]["paid_in"] == ids[2]
    assert rows["p2"]["status"] == "overdue"
    # only the plants and the required payoffs are checked on the page
    assert all(i["required"] for i in promise_ledger.planned(st, "p", "main", outline, ids[2]))


# ====================================================================== 📐 five turning points
def test_five_turning_points_is_the_new_book_default():
    t = story_shape.template("turning_points")
    assert [b["name"] for b in t["beats"]] == ["The opportunity", "The change of plans", "The point of no return",
                                              "The major setback", "The climax"]
    info = story_shape.info()
    assert info["default"] == "turning_points" and info["options"][0]["value"] == ""  # None stays first and possible
    assert story_shape.clean("turning_points") == "turning_points" and story_shape.clean("") == ""
    assert story_shape.by_position("turning_points", 20) == [2, 5, 10, 15, 18]


def test_a_book_with_five_turning_points_places_and_checks_its_beats(tmp_path):
    fake = SlotFake()
    fake.planned_fix = True
    app, fake, run = book(tmp_path, fake, body={"choices": {"shape": "turning_points"}})
    assert run["status"] == "done", run.get("problem")
    bp, outline, chs = chapters(app, run["project_id"])
    m = story_shape.mapping(app.store, run["project_id"], "main", outline)
    assert m["label"] == "Five turning points" and len(m["beats"]) == 5
    assert any(e.get("code") == "SHAPE_PLACED" for e in run["events"])


# ====================================================================== 🤖 AI habits: the rules
def test_clean_answers_and_the_majority_vote():
    raw = [{"check": "subplot", "passed": False, "fix": "  Give Tam a  subplot in chapter 4. "},
           {"check": "subplot", "passed": True, "fix": ""},       # a second answer for the same check: ignored
           {"check": "nope", "passed": False, "fix": "x"},        # unknown check
           {"check": "costly_choice", "passed": "no", "fix": ""},  # not a boolean
           {"check": "theme_unstated", "passed": True, "fix": "ignored when passed"}]
    c = ai_defaults.clean_answers(raw)
    assert c == [{"check": "subplot", "passed": False, "fix": "Give Tam a subplot in chapter 4."},
                 {"check": "theme_unstated", "passed": True, "fix": ""}]
    assert ai_defaults.clean_answers("junk") == []
    rows = [{"name": "A", "ai_defaults": [{"check": "subplot", "passed": False, "fix": "fix A"},
                                          {"check": "allies_push_back", "passed": False, "fix": ""}]},
            {"name": "B", "ai_defaults": [{"check": "subplot", "passed": False, "fix": "fix B"},
                                          {"check": "allies_push_back", "passed": True, "fix": ""}]},
            {"name": "C", "ai_defaults": [{"check": "allies_push_back", "passed": True, "fix": ""}]}]
    f = ai_defaults.failed(rows)
    assert [x["check"] for x in f] == ["subplot"] and f[0]["fix"] == "fix A" and f[0]["by"] == ["A", "B"]
    assert ai_defaults.failed([]) == []
    items = ai_defaults.draft_items(5)
    assert items[0]["id"] == "a5" and all(i["kind"] == "ai_default" for i in items)
    assert "out_of_order" not in {i["check"] for i in items}  # a plan-only check
    assert len(ai_defaults.plan_checks()) == len(ai_defaults.IDS)


def test_failed_habits_lead_the_doctors_fixes_and_the_note():
    rows = [{"name": "A", "scores": {"structure": 6}, "weaknesses": [
        {"dimension": "structure", "point": "The middle waits.", "fix": "Cut chapter 5.", "quote": "", "verified": False}],
        "ai_defaults": [{"check": "antagonist_conviction", "passed": False, "fix": "Let Vane refuse to apologise."}]}]
    fixes = sd.combined_fixes(rows, 8.5)
    assert fixes[0]["habit"] == "antagonist_conviction" and fixes[0]["fix"] == "Let Vane refuse to apologise."
    note = sd.revision_note(rows, 9.0, 8.5, [])
    assert "Let Vane refuse to apologise." in note and "AI habit — An antagonist with conviction" in note
    assert note.index("Let Vane") < note.index("Cut chapter 5.")
    # the doctor asks for the habits (the schema and the task, without breaking the task's own placeholders)
    assert "ai_defaults" in sd.PLAN_SCHEMA["properties"] and "ai_defaults" not in sd.PLAN_SCHEMA["required"]
    assert "ai_defaults" in sd.TASK.format(rubric="R")


# ====================================================================== 🤖 in a run
OFF = {"length": "short_story", "improve_pass": False, "first_page": False, "opening_pass": False,
       "human_pass": False}


def _habit_review(ctx):
    out = autobook_fake.plan_review(ctx, 9)  # a strong plan: no revision for the score alone
    out["ai_defaults"] = [{"check": c["check"], "passed": c["check"] not in ("subplot", "ending_not_calm"),
                           "fix": "" if c["check"] not in ("subplot", "ending_not_calm") else f"Fix {c['check']}."}
                          for c in ctx["ai_default_checks"]]
    return out


def test_two_ai_habits_make_the_doctor_revise_once_even_over_the_target(tmp_path):
    fake = SlotFake()
    fake.plan_review_script = [_habit_review, _habit_review]  # round 1: 9/10 but two habits; round 2: the default
    app = make_app(tmp_path, fake)
    run = run_book(app, dict(OFF, idea="A lighthouse keeper's apprentice and a brass key"))
    assert run["status"] == "done", run.get("problem")
    mem = app.autobook.get(run["id"])["story_doctor"]
    assert mem["revisions"] == 1 and fake.doctor_fixes == 1
    assert mem["rounds"][0]["habits"] == ["subplot", "ending_not_calm"] and mem["rounds"][1]["habits"] == []
    _sys, ctx0 = fake.prompts["plan_review"][0]
    assert [c["check"] for c in ctx0["ai_default_checks"]] == list(ai_defaults.IDS)
    note = fake.prompts["doctor_fix"][0][1]["author_note"]
    assert "Fix subplot." in note and "Fix ending_not_calm." in note
    ev = [e for e in run["events"] if e.get("code") == "DOCTOR_AI_HABITS"]
    assert ev and "a live subplot" in ev[0]["message"]


def test_one_habit_alone_does_not_force_a_revision(tmp_path):
    def one(ctx):
        out = autobook_fake.plan_review(ctx, 9)
        out["ai_defaults"] = [{"check": "subplot", "passed": False, "fix": "Add one."}]
        return out
    fake = SlotFake()
    fake.plan_review_script = [one, one]
    app = make_app(tmp_path, fake)
    run = run_book(app, dict(OFF, idea="A lighthouse keeper's apprentice and a brass key"))
    assert run["status"] == "done", run.get("problem")
    mem = app.autobook.get(run["id"])["story_doctor"]
    assert mem["revisions"] == 0 and fake.doctor_fixes == 0 and mem["rounds"][0]["habits"] == ["subplot"]


def test_the_final_ending_check_reads_the_habits_and_lists_the_open_ones(tmp_path):
    def ending(ctx):
        return {"items": [{"id": p["id"], "kept": not (p["kind"] == "ai_default" and "allies" in p["label"].lower()),
                           "where": "", "note": "Checked.", "fix": "Let Tam refuse Mara once." if p["kind"] ==
                           "ai_default" and "allies" in p["label"].lower() else ""} for p in ctx["promises"]],
                "arc": {"kept": True, "note": "", "fix": ""}, "question": {"kept": True, "note": "", "fix": ""}}
    fake = SlotFake()
    fake.ending_script = [ending] * 4
    app, fake, run = book(tmp_path, fake)
    assert run["status"] == "done", run.get("problem")
    sys_, ctx = fake.prompts["ending"][0]
    kinds = [p["kind"] for p in ctx["promises"]]
    assert kinds.count("ai_default") == len(ai_defaults.draft_items())
    assert "kind ai_default" in sys_
    res = ending_check.get(app.store, run["project_id"], "main")
    line = ending_check.summary_line(res)
    assert "habits of AI-written books avoided: " in line


def test_habits_no_ai_could_check_are_not_listed_as_open():
    res = {"items": [{"id": "s1", "kind": "setup", "label": "x", "status": "unchecked"},
                     {"id": "a2", "kind": "ai_default", "label": "A live subplot: …", "status": "unchecked"},
                     {"id": "a3", "kind": "ai_default", "label": "Allies who push back: …", "status": "open",
                      "fix": "f", "fix_chapter": 3, "note": ""}]}
    ids = [o["id"] for o in ending_check.open_list(res)]
    assert ids == ["s1", "a3"]
    assert next(o for o in ending_check.open_list(res) if o["id"] == "a3")["line"].startswith(
        "A habit of AI-written books")
    assert "habits of AI-written books" not in ending_check.summary_line(
        {"items": [i for i in res["items"] if i["status"] == "unchecked"]})


def test_habit_fixes_never_push_a_promise_fix_out_of_the_capped_list():
    opens = [{"id": f"a{i}", "kind": "ai_default", "fix": f"habit fix {i}", "fix_chapter": 3, "line": "h"}
             for i in range(6)] + [{"id": "arc", "kind": "arc", "fix": "the arc fix", "fix_chapter": 3, "line": "a"}]
    f = ending_check.fix_findings({"open": opens}, 3, "One paragraph.\n\nThe last paragraph.")
    assert len(f) == 6 and f[0]["suggestion"] == "the arc fix"
