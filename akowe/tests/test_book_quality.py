"""📈 Book quality: the quality history and trend, 🧠 lessons carried forward, 🔁 the final improve pass, 🕰️ the
clock / tide check, 📏 special rules need scope / cost / limits, the reading-level floor, the cross-chapter avoid-list
and "approve anyway" notes kept for the improve pass (quality_history.py, improve_pass.py, clock_check.py,
story_rules.py)."""
from __future__ import annotations

import copy

import pytest

from akowe import clock_check as cc
from akowe import improve_pass as ip
from akowe import quality_history as qh
from akowe import run_forecast, story_rules
from akowe.book_path import BookPath
from akowe.book_report import DIM_KEYS, book_chapters
from akowe.editor import clock_findings

from test_failover_review import SlotFake, make_app, run_book  # noqa: F401

SALT_1 = ("# The porch\n\nIt was Friday. The tide table pinned in the porch said high water at 18:06.\n\n"
          "At 14:30 the tide was going out across the flats, and Wren watched the channel drain.")
SALT_2 = "# The pier\n\nOld Pell said high water would be about eight in the evening on Friday.\n\nNothing else."


# ====================================================================== 🕰️ the clock and tide check (no AI)
def test_tide_going_out_before_high_water_is_flagged_with_both_passages():
    b = cc.check_book([("c1", SALT_1)])
    f = [x for x in b["findings"] if x["check"] == "tide_direction"]
    assert len(f) == 1 and f[0]["severity"] == "major"
    assert "14:30" in f[0]["detail"] and "18:06" in f[0]["detail"] and "coming in" in f[0]["detail"]
    assert f[0]["passages"][-1]["quote"] in SALT_1  # word for word: the editor and the reviewer can act on it
    assert not [x for x in b["findings"] if x["check"] == "clock_back"]  # a tide-table time is not the scene's time


def test_the_next_days_morning_ebb_must_fit_the_high_water_before():
    ch1 = "It was Friday. High water would be at 20:00 that evening."
    bad = "On Saturday the boats waited.\n\nAt 07:10 the tide was going out."   # Sat HW ≈ 08:25: still rising
    good = "On Saturday the boats waited.\n\nAt 10:30 the tide was going out."  # after Sat HW: falling
    assert [f["check"] for f in cc.check_book([("c1", ch1), ("c2", bad)])["findings"]] == ["tide_direction"]
    assert cc.check_book([("c1", ch1), ("c2", good)])["findings"] == []


def test_a_turn_of_the_tide_and_an_ambiguous_time_are_never_flagged():
    ch = "High water was at 18:06.\n\nAt 18:30 the tide was going out."  # 24 min after: slack, fine either way
    assert cc.check_book([("c1", ch)])["findings"] == []
    # "half past two" can be 02:30 or 14:30; with high water at 06:00 the 02:30 reading (rising) is wrong but 14:30
    # (falling? no: 14:30 is 8.5 h after 06:00 -> rising) — both rising, so "coming in" is right and nothing is flagged
    ch2 = "High water was at 06:00.\n\nAt half past two the tide was coming in."
    assert cc.check_book([("c1", ch2)])["findings"] == []


def test_two_high_waters_that_cannot_both_be_true_and_the_clock_running_backwards():
    ch = ("It was Friday. High water was at 18:06.\n\nHigh tide that Friday came at 14:00, the keeper said.\n\n"
          "At 21:00 she ate. At 16:15 she went out again.")
    checks = sorted(f["check"] for f in cc.check_book([("c1", ch)])["findings"])
    assert checks == ["clock_back", "tide_times"]


def test_times_are_read_in_many_forms():
    ts = cc.times_in("at half past two in the afternoon, quarter to five, four o'clock, 2 pm, 07:10", tide=True)
    assert [t["minutes"] for t in ts] == [[870], [285, 1005], [240, 960], [840], [430]]


def test_tide_facts_for_the_writer_and_the_editor_note_for_a_contradiction():
    b = cc.check_book([("c1", SALT_1)])
    facts = cc.facts(b)
    assert facts[0].startswith("High water Friday at 18:06") and "12 h 25 min" in facts[-1]
    q = b["findings"][0]["passages"][-1]["quote"]
    flags = [{"name": "time", "message": "The tide runs the wrong way", "quote": q}]
    out = clock_findings([], flags, SALT_1)  # no editor note covers it -> a MAJOR note of its own
    assert len(out) == 1 and out[0]["severity"] == "major" and out[0]["passage"] == q
    minor = [{"id": "f1", "dimension": "timeline", "severity": "minor", "passage": q, "why": "x"}]
    assert clock_findings(minor, flags, SALT_1)[0]["severity"] == "major"  # covered -> raised to major


def test_clock_check_never_raises():
    assert cc.check_book([("c1", None)])["findings"] == []
    assert cc.check_book(object())["findings"] == []


# ====================================================================== 📏 special rules need scope, cost and limits
def test_a_ghost_rule_without_scope_cost_and_limits_is_major():
    rules = [{"id": "r1", "category": "hard_rule", "text": "The drowned keeper's ghost plays the salt organ.",
              "scope": "", "status": "active"},
             {"id": "r2", "category": "hard_rule", "text": "The ghost can only be heard at slack water.",
              "scope": "only in the organ loft, at slack water; each tune costs the listener a memory; it can never "
                       "touch the living", "status": "active"},
             {"id": "r3", "category": "belief", "text": "The ghost wants revenge.", "scope": "", "stated_by": "Pell",
              "status": "active"}]
    lint = story_rules.lint(rules)
    sp = [p for p in lint if p["code"] == "SPECIAL_UNBOUNDED"]
    assert [p["rule"] for p in sp] == ["r1"] and sp[0]["severity"] == "major"
    assert set(sp[0]["missing"]) == {"scope", "cost", "limits"}
    assert "SPECIAL_UNBOUNDED" in story_rules.MAJOR_LINT
    todo = story_rules.special_unbounded({"rules": rules})
    note = story_rules.bound_note(todo)
    assert "r1" in note and "scope" in note and "cost" in note and "limits" in note
    assert story_rules.special_missing({"category": "hard_rule", "text": "Boats float.", "scope": ""}) == []


def test_the_run_bounds_special_rules_with_one_ai_update(tmp_path):
    fake = SlotFake()
    ghost = {"rules": [{"id": "", "category": "hard_rule", "text": "The keeper's ghost rings the bell.", "scope": "",
                        "source": "premise", "stated_by": "the canon"}], "notes": []}
    bounded = {"rules": [{"id": "r1", "category": "hard_rule", "text": "The keeper's ghost rings the bell.",
                          "scope": "only at night in the lighthouse; each ring costs it strength; it can never leave "
                                   "the tower", "source": "premise", "stated_by": "the canon"}], "notes": []}
    fake.rules_script = [ghost, bounded, bounded, bounded]
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story", "improve_pass": False})
    assert run["status"] == "done", run.get("problem")
    codes = [e.get("code") for e in run["events"]]
    assert "RULES_BOUNDED" in codes
    entry = story_rules.get_entry(app.store, run["project_id"], "main")
    assert story_rules.special_unbounded(entry) == []


# ====================================================================== 📈 history, trend and 🧠 lessons
def _rep(overall, dims, editor=None, grade=6.0):
    return {"aggregate": {"overall": overall, "reviewers": 2,
                          "dimensions": [{"dimension": k, "median": v, "n": 2} for k, v in dims.items()]},
            "editor": {"dimensions": [{"dimension": k, "average": v} for k, v in (editor or {}).items()]},
            "readability": {"audience": {"key": "adult"}, "totals": {"grade": grade}},
            "patterns": {"findings": [{"check": "triad", "severity": "major"}]}}


def _three_books(store):
    base = {k: 8.0 for k in DIM_KEYS}
    for i, (ov, rr, peril) in enumerate(((8.0, 5.0, 8.0), (8.0, 5.0, 7.0), (7.6, 5.0, 6.0))):
        d = dict(base, rule_rigor=rr, peril_uncertainty=peril)
        qh.record(store, "author", qh.snapshot(_rep(ov, d, {"timeline": 5.0, "prose_variety": 7.0}, grade=2.8),
                                               book=f"book{i}", texts=["She went. " * 400 + "like a hook"]))


def test_history_keeps_numbers_only_and_the_trend_says_up_or_down(tmp_path):
    app = make_app(tmp_path, SlotFake())
    _three_books(app.store)
    rows = qh.books(app.store, "author")
    assert len(rows) == 3 and rows[-1]["overall"] == 7.6
    raw = str(app.store.get_setting("quality_history:author"))
    assert "hook" not in raw and "She went" not in raw  # never the book's words
    assert "word:went" in rows[-1]["habits"] and "simple" in rows[-1]["habits"] and "triad" in rows[-1]["habits"]
    tr = qh.trend(app.store, "author")
    assert tr["line"].startswith("7.6/10 — down 0.4 from your last book")
    assert tr["weakest"]["dimension"] == "rule_rigor" and tr["weakest"]["books"] == 3
    assert "Rule rigor is your weakest area for 3 books" in tr["text"]
    assert [f["dimension"] for f in tr["falling"]] == ["peril_uncertainty"]
    # the same book recorded again replaces its entry
    qh.record(app.store, "author", dict(rows[-1], overall=8.4))
    assert len(qh.books(app.store, "author")) == 3 and qh.trend(app.store, "author")["line"].startswith("8.4/10 — up")


def test_lessons_are_the_recurring_weak_spots_and_carry_onto_a_new_book(tmp_path):
    app = make_app(tmp_path, SlotFake())
    _three_books(app.store)
    ls = qh.lessons(app.store, "author")
    texts = " ".join(x["text"] for x in ls)
    assert "scope, cost and limits" in texts and "clock, tide and date arithmetic" in texts
    assert ls[0]["books"] == 3 and len(ls) <= qh.MAX_LESSONS
    assert "“went”" in texts
    assert qh.carry(app.store, "author", "newbook") == ls
    assert [x["text"] for x in qh.of_book(app.store, "newbook")] == [x["text"] for x in ls]
    pl = qh.planner_block(app.store, "newbook", budget=200)
    assert pl and len(str(pl)) <= 260


def test_avoid_list_carries_chapter_ones_similes_phrases_and_tics_into_chapter_two():
    ch1 = ("The rope hung like a hook over the board in the porch. She pressed it flat with a thumbnail. "
           "He went out. She went in. They went down. He went up. She went over. He went home. She went back. "
           "Then he pressed it flat with a thumbnail again. " + "The sea moved slowly under grey light. " * 40)
    av = qh.avoid_list([{"chapter_id": "c1", "number": 1, "text": ch1}])
    joined = " ".join(av)
    assert "like a hook" in joined and "pressed it flat" in joined and "went" in joined


def test_word_tics_count_plain_words_leant_on_too_often():
    t = qh.word_tics("She went to the door. " * 40 + "The harbour was grey and the boats were still. " * 30)
    assert t and t[0]["word"] == "went" and t[0]["count"] == 40
    assert qh.word_tics("short text") == []


# ====================================================================== 🔁 the improve pass: keep only when better
def _agg(overall, **dims):
    return {"overall": overall, "reviewers": 2, "dimensions": [{"dimension": k, "label": k, "median": v, "n": 2}
                                                               for k, v in dims.items()]}


def test_compare_keeps_only_a_real_improvement_with_no_big_drop():
    before = _agg(7.6, rule_rigor=5, peril_uncertainty=6)
    assert ip.compare(before, _agg(8.0, rule_rigor=7, peril_uncertainty=6))["keep"]
    worse = ip.compare(before, _agg(8.1, rule_rigor=9, peril_uncertainty=4.5))
    assert not worse["keep"] and worse["drops"][0]["dimension"] == "peril_uncertainty"
    assert not ip.compare(before, _agg(7.6, rule_rigor=5, peril_uncertainty=6))["keep"]  # no gain
    fewer = dict(_agg(9.0, rule_rigor=9), reviewers=1)
    assert not ip.compare(before, fewer)["keep"]  # one reviewer missing: not comparable
    assert "7.6 → 8/10 (kept)" in ip.line(dict(ip.compare(before, _agg(8.0, rule_rigor=7)), keep=True))


def test_targets_gather_queued_notes_clock_repeats_tics_reading_level_and_beta(tmp_path):
    app = make_app(tmp_path, SlotFake())
    chs = [{"chapter_id": "c1", "number": 1, "record_id": "R1", "version": 2, "text": SALT_1 + " It hung like a hook."},
           {"chapter_id": "c2", "number": 2, "record_id": "R2", "version": 1,
            "text": "The net hung like a hook. " + "She went. " * 30 + "The harbour lay grey and still. " * 60},
           {"chapter_id": "c3", "number": 3, "record_id": "R3", "version": 1, "text": "Written by the author."}]
    n = ip.queue(app.store, "P", "main", "c2", {"record_id": "R2", "version": 1},
                 [{"id": "f1", "dimension": "cause_effect", "severity": "major", "passage": "The net hung like a hook.",
                   "why": "No cause."}], "approved_anyway")
    assert n == 1 and ip.queue(app.store, "P", "main", "c2", {"record_id": "R2", "version": 1},
                               [{"passage": "The net hung like a hook.", "why": "No cause."}], "approved_anyway") == 1
    rep = {"readability": {"audience": {"key": "adult"}, "chapters": [{"number": 2, "grade": 1.5}]},
           "try_next": [{"from": "reviewers", "text": "Rule rigor (5/10): bound the ghost."}]}
    beta = {"fixes": [{"kind": "guessed", "chapter": 1, "strong": True, "text": "Chapter 1: hide the clue better.",
                       "quote": "", "quote_verified": True}]}
    rows = ip.targets(app.store, "P", "main", chs, rep, beta, {}, skip={3})
    by = {r["number"]: r for r in rows}
    assert set(by) == {1, 2}  # chapter 3 (the author's own) is never touched
    assert {"queued", "reading", "tic"} <= set(by[2]["sources"]) and {"clock", "beta_strong"} <= set(by[1]["sources"])
    assert all(f["passage"] == "" or f["passage"] in r["text"] for r in rows for f in r["findings"])
    assert any("bound the ghost" in f["why"] for r in rows for f in r["findings"])
    assert all(len(r["findings"]) <= ip.MAX_FINDINGS for r in rows)


def _better_review(ctx):
    quote = "The lamp room was cold."
    return {"book_scores": {d: (8 if d in ("peril_uncertainty", "subtext") else 9 if d in ("atmosphere", "premise")
                                else 8) for d in DIM_KEYS},
            "strengths": [{"point": "Vivid.", "quote": quote}],
            "weaknesses": [{"point": "Helpers cooperate.", "quote": "Only old Nessa at the net sheds would talk"},
                           {"point": "Thin.", "quote": quote}, {"point": "Quiet.", "quote": quote}],
            "try_next": [], "summary": "Better.",
            "score_evidence": [{"dimension": d, "quote": quote, "why": "vivid"} for d in ("atmosphere", "premise")]}


def _worse_review(ctx):
    r = _better_review(ctx)
    r["book_scores"] = {d: 5 for d in DIM_KEYS}
    r.pop("score_evidence", None)
    return r


def _rewrite_first(ctx):
    f = (ctx.get("findings") or [{}])[0]
    text = ctx.get("chapter_text") or ""
    orig = "The lamp room was cold." if "The lamp room was cold." in text else ""
    return {"replacements": [{"finding_id": f.get("id"), "original": orig,
                              "replacement": "The lamp room was colder than the reef at night."}]}


def test_the_improve_pass_keeps_a_rewrite_the_same_reviewers_score_higher(tmp_path):
    fake = SlotFake()
    fake.rewrite_script = [_rewrite_first]
    fake.book_review_script = [None, None, _better_review, _better_review]
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", run.get("problem")
    mem = app.autobook.get(run["id"])["improve"]
    assert mem["kept"] is True and mem["after"] > mem["before"], mem
    assert "→" in mem["line"] and "kept" in mem["line"]
    codes = [e.get("code") for e in run["events"]]
    assert "IMPROVE_KEPT" in codes and "QUALITY_TREND" in codes
    bp = BookPath(app.engine, "author", run["project_id"], "main")
    ch1 = book_chapters(bp)[0]
    assert "colder than the reef" in ch1["text"] and ch1["approved"]  # reviewed and approved under the run consent
    rep = app.reports.latest(run["project_id"], "main")
    assert rep["aggregate"]["overall"] == mem["after"] and rep.get("improve") == mem["line"]
    assert rep["version"]["key"] and all(c["approved"] for c in book_chapters(bp))
    st = {s["id"]: s for s in bp.status()["steps"]}
    assert st["export"]["state"] == "done" and st["assemble"]["state"] == "done"  # exported again with the new text
    hist = qh.books(app.store, "author")
    assert hist[-1]["improve"]["kept"] is True and hist[-1]["overall"] == mem["after"]


def test_the_improve_pass_keeps_the_original_when_the_score_drops(tmp_path):
    fake = SlotFake()
    fake.rewrite_script = [_rewrite_first]
    fake.book_review_script = [None, None, _worse_review, _worse_review]
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", run.get("problem")
    mem = app.autobook.get(run["id"])["improve"]
    assert mem["kept"] is False and mem["after"] == mem["before"] and mem["last_try"] < mem["before"]
    assert "not kept" in mem["line"]
    bp = BookPath(app.engine, "author", run["project_id"], "main")
    assert "colder than the reef" not in book_chapters(bp)[0]["text"]  # nothing changed in the book
    assert "IMPROVE_NOT_KEPT" in [e.get("code") for e in run["events"]]


def test_the_improve_pass_is_a_setting_and_counts_in_the_forecast(tmp_path):
    app = make_app(tmp_path, SlotFake())
    run = run_book(app, {"length": "short_story", "improve_pass": False})
    st = {s["id"]: s for s in run["steps"]}
    assert st["improve"]["state"] == "done" and st["improve"]["message"] == "Not asked for in this run"
    on = run_forecast.option_calls(run_forecast.options_of(app, {}), 3, 3)["improve"]
    off = run_forecast.option_calls(run_forecast.options_of(app, {"improve_pass": False}), 3, 3)["improve"]
    one = run_forecast.option_calls(run_forecast.options_of(app, {"improve_rounds": 1}), 3, 3)["improve"]
    assert on["calls"] > one["calls"] > off["calls"] == 0
    with pytest.raises(Exception):
        app.autobook.start("author", {"author_confirms": True, "improve_rounds": 9})


def test_a_second_book_gets_the_lessons_and_the_report_shows_the_trend(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake)
    _three_books(app.store)
    run = run_book(app, {"length": "short_story", "improve_pass": False})
    assert run["status"] == "done", run.get("problem")
    assert "LESSONS_CARRIED" in [e.get("code") for e in run["events"]]
    # the planners got them…
    plans = [c for k, rows in fake.prompts.items() for _t, c in rows if isinstance(c, dict) and c.get("lessons")]
    assert plans and any("scope, cost and limits" in " ".join(c["lessons"]) for c in plans)
    # …and every chapter's writer (with the reading floor for adult readers)
    briefs = [c.get("writing_brief") for _k, rows in fake.prompts.items() for _t, c in rows
              if isinstance(c, dict) and isinstance(c.get("writing_brief"), dict)]
    ql = [b["quality_lessons"] for b in briefs if b.get("quality_lessons")]
    assert ql and all(len(str(q)) < qh.BRIEF_BUDGET + 200 for q in ql)
    assert any("scope, cost and limits" in " ".join(q.get("from_your_last_books") or []) for q in ql)
    assert all("reading grade of at least 5" in q.get("reading_level", "") for q in ql)
    ov = app.reports.overview("author", run["project_id"], "main")
    assert ov["trend"] and ov["trend"]["books"] == 4 and "from your last book" in ov["trend"]["line"]
    s, book = app.route("GET", f"/api/projects/{run['project_id']}/branches/main/book", {}, None, "author", {})
    assert (book.get("quality_trend") or {}).get("line")
    md = __import__("akowe.book_report", fromlist=["render_markdown"]).render_markdown(app.reports.latest(
        run["project_id"], "main"))
    assert "Your books over time" in md


def test_approve_anyway_keeps_the_editors_major_notes_for_the_improve_pass(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story", "improve_pass": False})
    pid = run["project_id"]
    bp = BookPath(app.engine, "author", pid, "main")
    ch = book_chapters(bp)[2]
    svc = app.autobook
    live = svc.get(run["id"])
    live["notes_due"] = {ch["record_id"]: {"label": f"chapter {ch['chapter_id']}", "chapter_id": ch["chapter_id"],
                                           "approved_anyway": True, "reasons": ["The reef scene has no cost."]}}
    first = ch["text"].split("\n\n")[1].split(". ")[0] + "."
    fake.craft_script = [{"scores": {"subtext": 4, "cause_effect": 4}, "findings": [
        {"id": "f1", "dimension": "cause_effect", "severity": "major", "passage": first, "why": "No cause.",
         "suggestion": "Give it a cause.", "keep_nearby": []}], "keep": [], "verdict": "REVISE"}] * 2
    svc._tl.review, svc._tl.assist, svc._tl.engine = app.review, app.assist, app.engine  # noqa: SLF001
    try:
        svc._notes_after_approval(live, {}, ch["record_id"], f"chapter {ch['chapter_id']}", ch["chapter_id"])  # noqa: SLF001
    finally:
        svc._tl.review = svc._tl.assist = svc._tl.engine = None  # noqa: SLF001
    q = ip.queued(app.store, pid, "main")[ch["chapter_id"]]
    assert q["why"] == "approved_anyway" and q["record_id"] == ch["record_id"]
    whys = [f["why"] for f in q["findings"]]
    assert "The reef scene has no cost." in whys
    assert "IMPROVE_QUEUED" in [e.get("code") for e in live["events"]]
    rows = ip.targets(app.store, pid, "main", book_chapters(bp), None, None, {})
    assert any(r["chapter_id"] == ch["chapter_id"] and "queued" in r["sources"] for r in rows)


def test_snapshot_and_trend_without_a_score_are_safe(tmp_path):
    app = make_app(tmp_path, SlotFake())
    assert qh.trend(app.store, "nobody") is None
    assert qh.trend(app.store, "nobody", current={"overall": None}) is None
    s = qh.snapshot({}, book="b")
    assert s["overall"] is None and s["dims"] == {}
    assert qh.brief_block(app.store, "nope", "main", None, "c1") is None or isinstance(
        qh.brief_block(app.store, "nope", "main", None, "c1"), dict)
    big = {"avoid": ["“" + "x" * 300 + "”"] * 8, "from_your_last_books": ["y" * 300] * 4}
    cut: list = []
    out = qh._bounded(copy.deepcopy(big), 600, ("avoid", "from_your_last_books"), cut, "lessons")  # noqa: SLF001
    assert len(str(out)) < 700 and cut


def test_a_tide_contradiction_reaches_the_editor_as_must_fix_and_the_next_chapters_brief(tmp_path):
    fake = SlotFake()
    fake.chapter_texts = {"ch1": SALT_1 + "\n\nThe rope hung like a hook from the rail."}
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story", "improve_pass": False})
    assert run["status"] == "done", run.get("problem")
    sent = [c for c in fake.craft_contexts if "14:30" in str(c.get("chapter_text") or "")]
    assert sent and any(f.get("name") == "time" for f in sent[0].get("akowe_in_chapter") or [])
    crafts = app.review.editor.crafts(run["project_id"], "main")
    assert any(f.get("source") == "akowe_clock" and f["severity"] == "major" for c in crafts.values()
               for f in c.get("findings") or [])
    briefs = [c.get("writing_brief") for _k, rows in fake.prompts.items() for _t, c in rows
              if isinstance(c, dict) and isinstance(c.get("writing_brief"), dict)]
    later = [b["quality_lessons"] for b in briefs if (b.get("quality_lessons") or {}).get("clock")]
    assert later and "18:06" in later[0]["clock"][0]
    assert any("like a hook" in " ".join(b.get("avoid") or []) for b in later)
