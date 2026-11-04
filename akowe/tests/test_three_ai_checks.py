"""PR #117: all three AIs check for consistency and drift, and the report fixes A–G.

Unit tests: the merge / agreement rules (cross_check.merge), combining two chapter reviews, the quote check, the
"How many AIs check for mistakes" setting with 1 / 2 / 3 AIs and a missing AI, the in-chapter injury check
(story_ledger.in_chapter), the report PDF's letters and symbols, the beta panel (quotes checked again, the writer counts
half), the editor's must-fix habits (habits.py), the unbacked-scores counter and the report clean-ups. Then a fake-AI
⚡ run with three AIs: every chapter reviewed by the two AIs that did not write it, every chapter checked by all three,
the checkpoints and the ending check read by all three, and the review of the stretch of chapters.
"""
from __future__ import annotations

import types

import pytest

from akowe import beta_reader, book_report, calibration, checkpoints, cross_check, habits, story_ledger
from akowe.book_path import BookPath

from test_failover_review import SlotFake, make_app, run_book, stored_reviews  # noqa: F401
from test_failover_review import no_provider_sleep  # noqa: F401 - the fixture

CH = "Mara climbed the stairs. The lamp room was cold and Tom Reed's logbook lay open beside a cracked lens."


# ============================================================================================ merge / agreement
def _p(cid, quote, problem, sev=None, original="", replacement=""):
    out = {"chapter_id": cid, "number": 1, "quote": quote, "problem": problem, "original": original,
           "replacement": replacement}
    if sev:
        out["severity"] = sev
    return out


def test_merge_confirmed_single_verified_major_minor_and_unverified():
    texts = {"ch1": CH}
    per_ai = [
        {"slot": "AI-1", "name": "Claude", "problems": [
            _p("ch1", "The lamp room was cold", "The lamp room was warm in chapter 0", "minor",
               "was cold", "was warm"),
            _p("ch1", "Tom Reed's logbook lay open", "Tom's logbook was burned earlier", "major"),
            _p("ch1", "a line the book never had", "invented", "major")]},
        {"slot": "AI-2", "name": "ChatGPT", "problems": [
            _p("ch1", "lamp room was cold", "The lamp room temperature does not match", "minor"),
            _p("ch1", "Mara climbed the stairs", "Mara has a cracked knee but climbs", "minor")]},
        {"slot": "AI-3", "name": "Gemini", "problems": []}]
    m = cross_check.merge(per_ai, texts)
    by = {p["problem"]: p for p in m}
    conf = by["The lamp room was warm in chapter 0"]
    assert conf["agreement"] == "confirmed" and conf["plan"] == "fix" and conf["agree"] == 2 and conf["of"] == 3
    assert conf["found_by"] == ["Claude", "ChatGPT"] and conf["original"] == "was cold"
    assert by["Tom's logbook was burned earlier"]["plan"] == "fix"          # one AI, verified, major
    assert by["Mara has a cracked knee but climbs"]["plan"] == "listed"     # one AI, verified, minor
    dropped = by["invented"]
    assert dropped["plan"] == "dropped" and not dropped["verified"] and "not in the chapter" in dropped["plan_why"]
    assert "2 of 3 agree" in cross_check.who_line(conf)
    assert "found by Claude only" in cross_check.who_line(by["Tom's logbook was burned earlier"])


def test_same_problem_by_overlapping_quote_or_words_and_never_across_chapters():
    a = _p("ch1", "the lamp room was cold and quiet", "x")
    assert cross_check.same_problem(a, _p("ch1", "lamp room was cold", "y"))
    assert not cross_check.same_problem(a, _p("ch2", "lamp room was cold", "y"))
    assert cross_check.same_problem(_p("ch1", "", "Mara's ankle injury vanishes before the chase"),
                                    _p("ch1", "", "The ankle injury of Mara vanishes, she runs"))


def test_quote_check_ignores_curly_quotes_and_spacing():
    text = "She said, “Not burnt out. Empty.” and left."
    assert cross_check.quote_in('"Not burnt out.  Empty."', text)
    assert not cross_check.quote_in("Never burned out. Emptied. Or never filled.", text)


def test_two_chapter_reviews_combine_strictly():
    a = {"verdict": "APPROVE", "reasons": ["Fits the plan"], "confidence": 0.7, "slot": "AI-2", "independent": True}
    b = {"verdict": "REVISE", "reasons": ["Ilse kneels on a cracked knee"], "suggested_changes": ["Make her wince"],
         "confidence": 0.8, "slot": "AI-3", "independent": True}
    both = cross_check.combine(a, b, "ChatGPT", "Gemini")
    assert both["verdict"] == "REVISE" and both["reasons"] == ["Gemini: Ilse kneels on a cracked knee"]
    assert both["suggested_changes"] == ["Gemini: Make her wince"] and both["two_reviewers"]
    ok = cross_check.combine(a, dict(b, verdict="APPROVE", confidence=0.5), "ChatGPT", "Gemini")
    assert ok["verdict"] == "APPROVE" and ok["confidence"] == 0.7 and len(ok["reviewers"]) == 2


# ============================================================================================ the setting
def test_setting_clean_and_default():
    assert cross_check.clean(None) is None and cross_check.clean("two") == "two"
    assert cross_check.clean("five") is False
    assert cross_check.setting_of({"settings": {}}) == "all"
    assert cross_check.setting_of({"settings": {"checkers": "one"}}) == "one"


@pytest.mark.parametrize("slots,setting,want", [
    (("AI-1", "AI-2", "AI-3"), "all", 3), (("AI-1", "AI-2", "AI-3"), "two", 2), (("AI-1", "AI-2", "AI-3"), "one", 0),
    (("AI-1", "AI-2"), "all", 2), (("AI-1",), "all", 0)])
def test_checker_slots_with_one_two_three_ais(tmp_path, slots, setting, want):
    app = make_app(tmp_path, SlotFake(), slots=slots)
    svc = types.SimpleNamespace(app=app)
    got = cross_check.checker_slots(svc, {"project_id": "p", "settings": {"checkers": setting}}, writer="AI-1")
    assert len(got) == want
    if want == len(slots):
        assert got[-1] == "AI-1"  # the writer checks last
    elif want:
        assert "AI-1" not in got  # Two: the two AIs that did not write it


def test_a_missing_ai_is_left_out(tmp_path):
    fake = SlotFake()
    fake.states["AI-2"] = "broken"
    app = make_app(tmp_path, fake)
    svc = types.SimpleNamespace(app=app)
    got = cross_check.checker_slots(svc, {"project_id": "p", "settings": {}}, writer="AI-1")
    assert got == ["AI-3", "AI-1"]


def test_make_a_book_rejects_a_wrong_checkers_value(tmp_path):
    from akowe.errors import AkoweError
    app = make_app(tmp_path, SlotFake())
    with pytest.raises(AkoweError):
        app.autobook._clean_settings({"checkers": "everyone"})
    assert app.autobook._clean_settings({"checkers": "two"})["checkers"] == "two"
    assert "checkers" not in app.autobook._clean_settings({})


# ============================================================================================ B: inside a chapter
ILSE = ("Ilse slipped on the iron step and cracked her knee against the rail. She swore under her breath.\n\n"
        "Later she took the stairs down to the cellar two at a time and knelt by the grate to light it.")


def test_in_chapter_injury_then_stairs_and_kneeling_is_a_major_flag():
    f = story_ledger.in_chapter(ILSE, ["Ilse Marrow", "Mara Vell"], "ch2", 2)
    assert len(f) == 1 and f[0]["code"] == "IN_CHAPTER_STATE" and f[0]["severity"] == "major"
    assert f[0]["name"] == "Ilse Marrow" and "knee" in f[0]["message"] and "stairs" in f[0]["quote"]


def test_in_chapter_injury_that_the_page_keeps_is_fine():
    ok = ("Ilse cracked her knee on the rail. She limped down the stairs, wincing, and knelt by the grate.")
    assert story_ledger.in_chapter(ok, ["Ilse Marrow"]) == []
    other = "Mara cut her hand on the glass. Ilse ran down the stairs."
    assert story_ledger.in_chapter(other, ["Ilse Marrow", "Mara Vell"]) == []


def test_reviewer_and_editor_briefs_say_physical_state_must_persist():
    from akowe import editor_rubric, review
    assert "must persist" in review.IN_CHAPTER_RULE and "MAJOR" in review.IN_CHAPTER_RULE
    assert "MAJOR" in editor_rubric.IN_CHAPTER_WORDS
    from akowe.editor import _in_chapter_major
    f = _in_chapter_major([{"id": "f1", "severity": "minor", "passage": "knelt by the grate",
                            "why": "Her knee injury is forgotten: she kneels as if nothing happened"}], [])
    assert f[0]["severity"] == "major"


def test_checkpoint_brief_asks_about_drift_and_plan():
    t = checkpoints.CHECK_TASK
    for w in ("DRIFT", "traits", "voice", "goals", "tone", "timeline", "injuries", "belongings", "names"):
        assert w in t, w
    assert "plan" in checkpoints.PLAN_RULE


# ============================================================================================ A: the report PDF
def test_report_pdf_keeps_accented_letters_and_maps_symbols():
    s = book_report._pdf_safe("Akọwe ẹ ł Ωμέγα — 🎯 How generous ⚠️ careful 🙂 ok")
    for w in ("Akọwe", "ẹ", "ł", "Ωμέγα"):
        assert w in s
    assert "?" not in s and "(!)" in s and "* How generous" in s and "•" in s
    rep = {"title": "Akọwe ẹ ł Ωμέγα", "version": {"key": "k", "chapters": []}, "at": "2026-11-04T10:00",
           "warnings": ["🎯 How generous"], "words": {"chapters": [{"number": 1, "title": "One", "words": 100}]}}
    pdf = book_report.render_pdf(rep)
    assert pdf.startswith(b"%PDF") and b"DejaVuSerif" in pdf  # the Unicode font is embedded for ọ, ẹ, ł, Greek
    assert b"(- ? How" not in pdf


# ============================================================================================ G: report clean-ups
def test_table_rows_have_no_stray_dot_and_vague_advice_is_dropped():
    assert book_report.pdf_row("| 1 | The Lamp | 2,000 | |") == "1  ·  The Lamp  ·  2,000"
    assert not book_report.actionable("Maintain the same level of atmospheric tension throughout.")
    assert not book_report.actionable("Keep up the good pacing.")
    assert book_report.actionable("Cut the second harbour scene in chapter 4.")
    assert book_report.actionable("Give Nessa a reason of her own to help Mara.")
    rep = {"aggregate": {"dimensions": []}, "reviews": [{"name": "Gemini", "try_next": [
        "Maintain the same level of atmospheric tension throughout.", "Cut the second harbour scene in chapter 4."]}]}
    out = book_report.ReportService.try_next(rep) if hasattr(book_report, "ReportService") else None
    if out is None:  # the report service's class name
        cls = next(v for v in vars(book_report).values() if isinstance(v, type) and hasattr(v, "try_next"))
        out = cls.try_next(rep)
    assert [o["text"] for o in out] == ["Cut the second harbour scene in chapter 4."]


# ============================================================================================ E: unbacked scores
def test_unbacked_scores_are_counted_per_ai_across_books(tmp_path):
    app = make_app(tmp_path, SlotFake())
    assert calibration.note_unbacked(app.store, "gemini", "Gemini") == 1
    assert calibration.unbacked_line("Gemini", 1) == ""
    calibration.note_unbacked(app.store, "gemini", "Gemini")
    n = calibration.note_unbacked(app.store, "gemini", "Gemini")
    assert n == 3 and calibration.unbacked_of(app.store, "gemini") == 3
    assert "Gemini's whole-book scores were lowered 3 times in recent books" in calibration.unbacked_line("Gemini", n)


# ============================================================================================ C / D: beta panel
def _read(name, independent, quote, verified=True):
    return {"status": "done", "reader": {"name": name, "slot": name, "independent": independent},
            "persona": {"label": "fan"}, "reactions": [{"chapter": 2, "kind": "confused", "quote": quote,
                                                        "note": "lost", "verified": verified}],
            "interest": [], "guesses": [], "stop": {"would_finish": True}, "overall": None}


def test_beta_panel_quotes_checked_again_and_writer_counts_half():
    book = book_report._norm("Not burnt out. Empty. The lamp was cold.")
    # the writer + one other reader agree: weight 1.5 -> still a strong signal, the writer is named as such
    cmp_ = beta_reader.compare([_read("Claude", False, "Not burnt out. Empty."),
                                _read("ChatGPT", True, "Never burned out. Emptied. Or never filled.")], 3, book)
    names = [v["name"] for v in cmp_["verdicts"]]
    assert "Claude (wrote most of the book)" in names
    g = cmp_["agree"][0]
    assert g["weight"] == 1.5
    bad = [q for q in g["quotes"] if q["quote"].startswith("Never")]
    assert bad and bad[0]["verified"] is False
    assert cmp_["fixes"][0]["quote"] == "Not burnt out. Empty." and cmp_["fixes"][0]["quote_verified"]
    assert "counts half" in cmp_["headline"]
    # a quote no reader got right is shown, marked, and never used as the evidence of a fix
    only_bad = beta_reader.compare([_read("Claude", True, "Never burned out. Emptied."),
                                    _read("ChatGPT", True, "Never burned out. Emptied. Or never filled.")], 3, book)
    assert only_bad["fixes"][0]["quote_verified"] is False
    md = "\n".join(beta_reader.report_markdown({"kind": "panel", "comparison": only_bad}))
    assert "(not found word for word)" in md
    # two readers who both wrote the book are not a strong signal (weight 1.0)
    weak = beta_reader.compare([_read("Claude", False, "The lamp was cold."),
                                dict(_read("Claude-2", False, "The lamp was cold."))], 3, book)
    assert not weak["agree"]


def test_beta_guess_is_not_shown_as_a_quote():
    read = {"reactions": [], "interest": [], "stop": {"would_finish": True, "chapter": 0, "why": ""},
            "guesses": [{"guess": "Never burned out. Emptied.", "guessed_in_chapter": 1, "revealed_in_chapter": 3,
                         "came_true": "yes", "quote": "", "verified": False}]}
    f = next(x for x in beta_reader.findings(read, 3) if x["id"] == "guessed")
    assert "“Never burned out" not in f["detail"] and "Guessed: Never burned out" in f["detail"]


def test_beta_panel_prefers_ais_that_did_not_write_the_book():
    opts = [{"slot_id": "AI-1", "name": "Claude", "working": True, "independent": False},
            {"slot_id": "AI-2", "name": "ChatGPT", "working": True, "independent": True},
            {"slot_id": "AI-3", "name": "Gemini", "working": True, "independent": True}]
    picks = beta_reader.assign(opts, [None, None])
    assert [o["slot_id"] for o, _w in picks] == ["AI-2", "AI-3"]
    picks3 = beta_reader.assign(opts, [None, None, None])
    assert picks3[2][0]["slot_id"] == "AI-1"  # the writer only when it must, last


# ============================================================================================ F: must-fix habits
NOT_X = ("Mara climbed the stairs. Not burnt out. Empty. She stood by the lamp. It wasn't fear. It was hunger.\n\n"
         "Not a sound. Not a breath. The lamp was cold. Not anger. Not grief. Something else. She waited.\n\n"
         "Not here. Not now. The fog lifted over the harbour wall and the boats knocked together. Not the keeper. "
         "Not the stranger.\n\nNot today. Not ever. She turned the key. Not again. Not like this.")


def test_a_habit_two_checks_flag_is_a_must_fix_for_the_editor():
    must = habits.must_fix(NOT_X)
    m = next(x for x in must if x["habit"] == "not_x_not_y")
    assert len(m["flagged_by"]) >= 2 and m["count"] >= 9 and m["examples"]
    assert all(e in NOT_X for e in m["examples"])
    fs = habits.findings_for(must, [], ["prose_variety", "subtext"])
    assert fs and fs[0]["severity"] == "major" and fs[0]["passage"] in NOT_X and "Must fix" in fs[0]["why"]
    # an editor finding that already names the habit is not doubled
    covered = habits.findings_for(must, [{"why": "Negative parallelism everywhere", "passage": "x"}],
                                  ["prose_variety"])
    assert not [f for f in covered if f["habit"] == "not_x_not_y"]
    left = habits.remaining(NOT_X, must)
    assert left["targets"] == len(must) and left["remained"] >= 1
    clean = "Mara climbed the stairs. The lamp was cold. She turned the key and the light came on."
    assert habits.remaining(clean, must)["remained"] == 0
    assert habits.must_fix(clean) == []


# ============================================================================================ the ⚡ run, three AIs
def test_three_ai_run_all_check_reviews_by_two_and_stretch_review(tmp_path, monkeypatch):
    monkeypatch.setattr(checkpoints, "DEFAULT_EVERY", 2)  # a checkpoint after chapter 2 of 3 (and the final one)
    fake = SlotFake()
    fake.story_ledger = True
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    pid = run["project_id"]
    n = len(BookPath(app.engine, "author", pid, "main").outline_chapters(
        BookPath(app.engine, "author", pid, "main").outline()))
    assert n == 3
    # every chapter: reviewed by the two AIs that did not write it
    rv = [r for r in stored_reviews(app, run) if r.get("module_id") == "C02"]
    assert rv and all(r.get("two_reviewers") for r in rv), rv
    for r in rv:
        assert len({x["slot"] for x in r["reviewers"]}) == 2 and r["writer_slot"] not in {x["slot"] for x in
                                                                                          r["reviewers"]}
    # every chapter: checked by all three AIs (the writer too)
    cps = {c["id"]: c for c in checkpoints.items(app.store, pid, "main")}
    chs = [c for c in cps.values() if c.get("kind") == "chapter"]
    assert len(chs) == 3
    for c in chs:
        assert len(checkpoints.checked_by(c)) == 3, c
    # the checkpoints: read by all three, and the review of chapters 1–2
    for cid in ("after-2", "final"):
        assert len(checkpoints.checked_by(cps[cid])) == 3, cps[cid]
        assert all(len(p.get("by_ai") or {}) == 3 for p in cps[cid]["parts"])
    sr = cps["after-2"]["stretch"]
    assert sr["title"] == "Chapters 1–2 review" and len(sr["views"]) == 3 and len(sr["readers"]) == 3
    assert any(a["kind"] == "not_working" and len(a["names"]) >= 2 for a in sr["agree"])
    assert "stretch" not in cps["final"]
    # the ending check: all three
    from akowe import ending_check
    end = ending_check.get(app.store, pid, "main")
    assert len((end.get("ai") or {}).get("checked_by") or []) == 3, end.get("ai")
    # the report shows both, in plain words
    rep = app.reports.make("author", pid, "main", ai=False)
    md = book_report.render_markdown(rep)
    assert "## Checks for mistakes and drift (by the AIs)" in md and "Every chapter checked by all the AIs" in md
    assert "Chapters 1–2 review" in md
    # the run window lines
    ev = [e for e in run["events"] if e.get("code") == "STRETCH_REVIEW"]
    assert ev and "Chapters 1–2 review" in ev[0]["message"]


def test_one_ai_setting_is_the_old_way(tmp_path):
    fake = SlotFake()
    fake.story_ledger = True
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story", "checkers": "one"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    pid = run["project_id"]
    cps = checkpoints.items(app.store, pid, "main")
    assert cps and not [c for c in cps if c.get("kind") == "chapter"]
    assert all(not p.get("by_ai") for c in cps for p in c.get("parts") or [])
    rv = [r for r in stored_reviews(app, run) if r.get("module_id") == "C02"]
    assert rv and not any(r.get("two_reviewers") for r in rv)


def test_a_busy_or_broken_ai_never_stalls_the_checks(tmp_path):
    fake = SlotFake()
    fake.story_ledger = True
    app = make_app(tmp_path, fake)
    orig = fake.submit
    from akowe.errors import AkoweError

    def submit(slot, system, user, schema):  # Gemini times out on every checkpoint and ending check
        props = schema.get("properties") or {}
        if slot["slot_id"] == "AI-3" and ("problems" in props or ("arc" in props and "question" in props)):
            raise AkoweError("TIMEOUT", "", "too slow")
        return orig(slot, system, user, schema)
    fake.submit = submit
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    final = next(c for c in checkpoints.items(app.store, run["project_id"], "main") if c["id"] == "final")
    assert final["status"] == "done" and len(checkpoints.checked_by(final)) == 2
    assert any(e.get("code") == "CHECKPOINT_AI_SKIPPED" for e in run["events"])


# ============================================================================================ 🔎 Check consistency now
def _finished_book(tmp_path):
    fake = SlotFake()
    fake.story_ledger = True
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story", "checkers": "one"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    return app, fake, run["project_id"]


def _wait_now(app, pid, timeout=60):
    import time
    from akowe import check_now
    t0 = time.time()
    while time.time() - t0 < timeout:
        st = check_now.status(app, "author", pid, "main")
        if st["state"] in ("done", "failed"):
            return st
        time.sleep(0.05)
    raise AssertionError("the consistency check did not finish")


def test_check_now_ranges_are_chosen_in_plain_words():
    from akowe import check_now
    from akowe.errors import AkoweError
    assert check_now.pick_range(12, {}) == (8, 12, "chapters 8–12")
    assert check_now.pick_range(3, {"range": "last5"})[:2] == (1, 3)
    assert check_now.pick_range(12, {"range": "all"})[:2] == (1, 12)
    assert check_now.pick_range(12, {"range": "range", "from": 3, "to": 7}) == (3, 7, "chapters 3–7")
    for bad in ({"range": "range", "from": 7, "to": 3}, {"range": "range", "from": 0, "to": 3},
                {"range": "range", "from": 2, "to": 13}, {"range": "everything"}):
        with pytest.raises(AkoweError):
            check_now.pick_range(12, bad)
    with pytest.raises(AkoweError):
        check_now.pick_range(0, {})


def test_check_now_outside_a_run_all_ais_proposals_then_a_draft(tmp_path):
    from akowe import check_now
    from akowe.errors import AkoweError
    app, fake, pid = _finished_book(tmp_path)
    fake.checkpoint_extra = [{"chapter": 2, "quote": "every captain looked away", "severity": "major",
                              "problem": "Nessa says the keeper went out alone, but chapter 1 shows a stranger.",
                              "original": "every captain looked away", "replacement": "every captain looked down"}]
    s, st = app.route("GET", f"/api/projects/{pid}/branches/main/review/continuity/check-now", {}, None, "author", {})
    assert s == 200 and st["can_start"] and st["state"] == "idle" and st["chapters"] == 3 and not st["in_run"]
    s, st = app.route("POST", f"/api/projects/{pid}/branches/main/review/continuity/check-now", {}, {"range": "all"},
                      "author", {})
    assert s == 202
    # one at a time: a second start while it runs is refused in plain words
    if st["state"] == "running":
        with pytest.raises(AkoweError) as e:
            check_now.start(app, "author", pid, "main", {})
        assert "running now" in str(e.value.errors)
    st = _wait_now(app, pid)
    assert st["state"] == "done", st
    cp = st["latest"]
    assert cp["kind"] == "now" and len(cp["checked_by"]) == 3
    assert cp["stretch"]["title"] == "Chapters 1–3 review" and len(cp["stretch"]["views"]) == 3
    prop = [p for p in cp["problems"] if p["status"] == "proposed"]
    assert prop and prop[0]["agreement"] == "confirmed", cp["problems"]
    # nothing approved changed: the chapter is still the same approved text
    bp = BookPath(app.engine, "author", pid, "main")
    ch2 = next(c for c in book_report.book_chapters(bp) if c["number"] == 2)
    assert "every captain looked away" in ch2["text"] and ch2["approved"]
    out = check_now.apply(app, "author", pid, "main", {"cp_id": cp["id"]})
    assert out["drafts"] and out["drafts"][0]["fixes"] == 1
    head = app.review._head(pid, "main", out["drafts"][0]["record_id"])
    assert head["lifecycle"] in ("DRAFT", "VALIDATED") and "every captain looked down" in head["data"]["text"]
    assert head.get("approved_version") != head["version"]  # waits for the author's approval
    st = check_now.status(app, "author", pid, "main")
    assert all(p["status"] != "proposed" for p in st["latest"]["problems"])
    # it is in the continuity report and the book report
    rep = app.reports.make("author", pid, "main", ai=False)
    assert "Chapters 1–3 review" in book_report.render_markdown(rep)


def test_check_now_during_a_run_is_queued_and_runs_between_chapters(tmp_path):
    import threading
    from akowe import check_now
    from akowe.errors import AkoweError
    fake = SlotFake()
    fake.story_ledger = True
    app = make_app(tmp_path, fake)
    reached, release = threading.Event(), threading.Event()
    orig = fake.submit

    def submit(slot, system, user, schema):
        if fake.kinds.count("C02") >= 2 and not release.is_set():
            reached.set()
            release.wait(60)
        return orig(slot, system, user, schema)
    fake.submit = submit
    r = app.autobook.start("author", {"author_confirms": True, "length": "short_story", "checkers": "one"})
    assert reached.wait(60)
    pid = app.autobook.get(r["id"])["project_id"]
    st = check_now.start(app, "author", pid, "main", {})
    assert st["state"] == "queued" and st["in_run"] and not st["can_start"] and "queued" in st["why_not"]
    with pytest.raises(AkoweError):
        check_now.start(app, "author", pid, "main", {})
    release.set()
    app.autobook.wait_for(r["id"], 180)
    run = app.autobook.get(r["id"])
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    codes = [e.get("code") for e in run["events"]]
    assert "CHECK_NOW_QUEUED" in codes and "CHECK_NOW_RUNNING" in codes and "CHECK_NOW_DONE" in codes
    assert codes.index("CHECK_NOW_QUEUED") < codes.index("CHECK_NOW_RUNNING")
    st = check_now.status(app, "author", pid, "main")
    assert st["state"] == "done" and st["can_start"]
    cp = st["latest"]
    req = st["request"]
    assert cp["kind"] == "now" and len(cp["checked_by"]) == 3 and cp["chapters"] == req["to"] - req["from"] + 1
    assert cp["stretch"]["title"].endswith("review") and len(cp["stretch"]["views"]) == 3
    assert req["run_id"] == r["id"] and req["in_run"]
