"""📈 Book quality, batch 2-4 agent D ("AI novel quality beyond eight", recommendations 7 and 10): 🧭 the scope guard
(each chapter keeps to its plan; nothing new starts late in the book) and 🤫 who knows what (each secret with who
knows it from which chapter and when the reader may learn it), told to the writer and checked after each chapter."""
from __future__ import annotations

import pytest
from test_failover_review import SlotFake
from test_world_planned import book, chapters

from akowe import chapter_brief, knowledge_grid, scope_guard, story_guards
from akowe.errors import AkoweError

CAST = ["Mara Vell", "Tom Reed", "Nessa Crane", "Ilse Marrow"]
SECRET = "The stranger on the reef was the keeper's brother"
LEAK = "Mara already knew the stranger on the reef was the keeper's brother, and she said so."
NEWCOMER = "Bram Hollis strode up from the quay with a lantern."
CH2 = ("Down in the harbor the fishing boats knocked together like restless teeth. Mara asked every captain about the "
       "night the light went dark, and every captain looked away.\n\n" + LEAK + "\n\nOnly old Nessa at the net sheds "
       "would talk, and only in a whisper.")
CH3 = ("At low tide the reef rose out of the water like the spine of something sleeping. Mara found the keeper's brass "
       "key wedged between two stones.\n\n" + NEWCOMER + " When she turned the key in the lighthouse door that night, "
       "the great lamp blazed for the first time in a week.")


# ====================================================================== pure parts
def test_late_part_and_run_options():
    assert scope_guard.late_from(10) == 7 and scope_guard.late_from(3) == 3 and scope_guard.late_from(2) is None
    assert scope_guard.late_from("x") is None
    assert story_guards.clean_run_option({}) == {"scope_guard": True, "knowledge_grid": True}
    assert story_guards.clean_run_option({"scope_guard": False}) == {"scope_guard": False, "knowledge_grid": True}
    with pytest.raises(AkoweError) as e:
        story_guards.clean_run_option({"knowledge_grid": "yes"})
    assert e.value.errors[0]["path"] == "/knowledge_grid"


def test_new_names_only_counts_names_the_book_never_used():
    known = {"mara", "vell", "gullhaven", "tom", "reed"}
    text = ("Mara Vell climbed the stair. Then Bram Hollis waved from Gullhaven. Later, Bram Hollis left. "
            "Monday came. Tom Reed's log lay open. She met Ottoline at the Saltgate.")
    got = scope_guard.new_names(text, known)
    assert "Bram Hollis" in got and "Ottoline" in got and "Saltgate" in got
    assert not any(n.startswith(("Mara", "Tom", "Gullhaven", "Monday", "Then", "Later")) for n in got)
    assert scope_guard.new_names("", known) == []


def test_validate_matches_the_cast_clamps_and_drops():
    raw = [{"fact": SECRET, "kind": "secret", "reveal_chapter": 3,
            "knowers": [{"who": "Tom Reed", "from_chapter": 0}, {"who": "mara vell", "from_chapter": 3},
                        {"who": "Nobody Known", "from_chapter": 1}, {"who": "Tom Reed", "from_chapter": 2}]},
           {"fact": SECRET.upper(), "kind": "secret", "reveal_chapter": 1, "knowers": []},        # duplicate
           {"fact": "Ilse hid the log", "kind": "odd", "reveal_chapter": 99,
            "knowers": [{"who": "Ilse Marrow", "from_chapter": -4}]},                           # clamped
           {"fact": "no knower, no reveal", "kind": "other", "reveal_chapter": 0, "knowers": []},  # dropped
           {"fact": "", "kind": "secret", "reveal_chapter": 2, "knowers": []}, "junk"]
    out, problems = knowledge_grid.validate(raw, 4, CAST)
    assert [e["id"] for e in out] == ["k1", "k2"]
    assert out[0]["knowers"] == [{"who": "Tom Reed", "from": 0}, {"who": "Mara Vell", "from": 3}]
    assert out[0]["reveal"] == 3 and out[1]["kind"] == "other" and out[1]["reveal"] == 4
    assert out[1]["knowers"] == [{"who": "Ilse Marrow", "from": 0}]
    assert "fact 1: 1 name(s) not in the cast left out" in problems and "fact 2: its chapters were corrected" in problems
    assert knowledge_grid.validate("junk", 4, CAST) == ([], [])
    lots = [{"fact": f"fact {i}", "kind": "secret", "reveal_chapter": 2, "knowers": []} for i in range(30)]
    assert len(knowledge_grid.validate(lots, 4, CAST)[0]) == knowledge_grid.MAX_FACTS


def test_who_knows_what_states_and_lines():
    entries, _p = knowledge_grid.validate([{"fact": SECRET, "kind": "secret", "reveal_chapter": 3, "knowers": [
        {"who": "Tom Reed", "from_chapter": 0}, {"who": "Mara Vell", "from_chapter": 3}]}], 4, CAST)
    grid = {"entries": entries, "learned": {}}
    e = entries[0]
    assert knowledge_grid.state(grid, e, "Tom Reed", 1) == "knows"
    assert knowledge_grid.state(grid, e, "Mara Vell", 2) == "not_yet"
    assert knowledge_grid.state(grid, e, "Mara Vell", 3) == "learns_here"
    assert knowledge_grid.state(grid, e, "Nessa Crane", 4) == "never"
    line = knowledge_grid.writer_lines(grid, 2, ["Mara Vell", "Tom Reed", "Nessa Crane"])[0]
    assert "knows it: Tom Reed" in line and "Mara Vell (learns it in chapter 3)" in line
    assert "does not know it: Nessa Crane" in line and "hidden from the reader until chapter 3" in line
    three = knowledge_grid.writer_lines(grid, 3, ["Mara Vell"])[0]
    assert "learns it in this chapter: Mara Vell" in three and "the reader learns it in this chapter" in three
    # what the page really showed moves a character's learning earlier
    grid["learned"] = {"k1": {"Nessa Crane": 2}}
    assert knowledge_grid.state(grid, e, "Nessa Crane", 3) == "knows"
    assert knowledge_grid.match_fact(grid, "learns that the keeper's brother was the stranger on the reef") is e
    assert knowledge_grid.match_fact(grid, "learns the tide tables") is None


def test_findings_point_at_the_quoted_sentence():
    cands = [{"id": "c1", "kind": "new_name", "name": "Bram Hollis", "quote": NEWCOMER},
             {"id": "c2", "kind": "early_knowledge", "who": "Mara Vell", "fact": SECRET, "learns_in": 3,
              "quote": LEAK},
             {"id": "c3", "kind": "revealed_early", "fact": SECRET, "reveal": 3, "quote": LEAK},  # same sentence
             {"id": "c4", "kind": "new_name", "name": "Ottoline", "quote": None}]                  # nowhere to fix
    fs = story_guards.findings_for(cands, {"characters": ["Mara Vell"], "places": []})
    assert [f["passage"] for f in fs] == [NEWCOMER, LEAK]
    assert fs[0]["dimension"] == "story_scope" and "Mara Vell" in fs[0]["suggestion"]
    assert fs[1]["dimension"] == "who_knows" and "chapter 3" in fs[1]["why"]


# ====================================================================== in a ⚡ run
def _grid(ctx):
    n = len(ctx["chapters"])
    return {"who_knows": [{"fact": SECRET, "kind": "secret", "reveal_chapter": n,
                           "knowers": [{"who": "Tom Reed", "from_chapter": 0}, {"who": "Mara Vell", "from_chapter": n}]}]}


def _confirm_all(ctx):
    text = ctx["chapter_text"]
    out = []
    for c in ctx["candidates"]:
        q = LEAK if LEAK in text and c["kind"] != "new_name" else NEWCOMER if NEWCOMER in text else ""
        out.append({"id": c["id"], "confirmed": bool(q), "quote": q})
    return {"guard_checks": out}


def _briefs(fake):
    return [((c.get("writing_brief") or (c.get("request_payload") or {}).get("writing_brief")) or {})
            for _s, c in fake.prompts.get("C02") or []]


def test_make_a_book_guards_scope_and_who_knows_what_and_fixes_once(tmp_path):
    fake = SlotFake()
    fake.chapter_texts = {"ch2": CH2, "ch3": CH3}
    fake.grid_script = [_grid]
    fake.guard_script = [_confirm_all, _confirm_all]
    app, fake, run = book(tmp_path, fake)
    pid = run["project_id"]
    assert run["status"] == "done", run.get("problem")
    codes = [e.get("code") for e in run["events"]]
    # after the outline: the scope guard (no AI) and ONE grid call
    assert "SCOPE_SET" in codes and "GRID_BUILT" in codes
    assert len(fake.prompts.get("grid") or []) == 1
    _sys, gctx = fake.prompts["grid"][0]
    assert "Mara Vell" in gctx["cast"] and gctx["chapters"] and "secrets" in gctx
    _bp, _outline, chs = chapters(app, pid)
    n = len(chs)
    assert n == 3
    # the writers were told: scope (late in the book in chapter 3) and who knows what
    briefs = _briefs(fake)
    scoped = [b["scope"] for b in briefs if b.get("scope")]
    assert len(scoped) >= 1 and all(s["late_in_book"] for s in scoped)  # only the late part (chapter 3 of 3)
    assert "Mara Vell" in scoped[0]["plan_characters"]
    assert any(scope_guard.WRITER_RULE in (b.get("rules") or []) for b in briefs)
    knowing = [b for b in briefs if b.get("who_knows")]
    assert knowing and any("Mara Vell (learns it in chapter 3)" in ln for b in knowing for ln in b["who_knows"])
    assert any(knowledge_grid.WRITER_RULE in (b.get("rules") or []) for b in knowing)
    # after chapter 2 (a secret too early) and chapter 3 (a new name late): one confirm call each, one fix each
    assert len(fake.prompts.get("guard_check") or []) == 2
    kinds = {c["kind"] for _s, ctx in fake.prompts["guard_check"] for c in ctx["candidates"]}
    assert kinds >= {"early_knowledge", "new_name"}
    assert codes.count("GUARD_FIX") == 2
    texts = {cid: str((rec.get("data") or {}).get("text") or "") for cid, rec in chs}
    assert LEAK not in texts["ch2"] and NEWCOMER not in texts["ch3"]
    # the report
    info = story_guards.report_info(app.store, pid, "main")
    assert info and len(info["lines"]) == 2 and info["counts"]["facts"] == 1
    assert info["lines"][0].startswith("🧭 Scope guard: from chapter 3 of 3") and "1 fixed" in info["lines"][0]
    assert info["lines"][1].startswith("🤫 Who knows what: 1 secret(s)")
    assert all(i["status"] == "fixed" for i in info["items"])
    md = story_guards.report_md(info)
    assert md[0] == "## Scope and who knows what" and any(SECRET in x for x in md)
    from akowe.book_report import render_markdown
    latest = app.reports.latest(pid, "main")
    assert latest and (latest.get("story_guards") or {}).get("lines") == info["lines"]
    assert "## Scope and who knows what" in render_markdown(latest)
    # journal lines carry no book text
    for e in run["events"]:
        if str(e.get("code") or "").startswith(("GUARD", "GRID", "SCOPE")):
            assert "Bram" not in e["message"] and "brother" not in e["message"]


def test_no_or_garbage_answers_leave_the_book_as_before(tmp_path):
    fake = SlotFake()
    fake.chapter_texts = {"ch2": CH2, "ch3": CH3}
    fake.grid_script = [{"who_knows": "junk"}]
    fake.guard_script = [{"nope": 1}, {"guard_checks": [{"id": "c1", "confirmed": "yes", "quote": "x"}]}]
    app, fake, run = book(tmp_path, fake)
    pid = run["project_id"]
    assert run["status"] == "done", run.get("problem")
    codes = [e.get("code") for e in run["events"]]
    assert "GRID_BUILT" not in codes and "GRID_FAILED" in codes and "GUARD_FIX" not in codes
    _bp, outline, chs = chapters(app, pid)
    assert knowledge_grid.current(app.store, pid, "main", outline) is None
    texts = {cid: str((rec.get("data") or {}).get("text") or "") for cid, rec in chs}
    assert LEAK in texts["ch2"] and NEWCOMER in texts["ch3"]  # nothing changed
    # chapter 3's new name: the garbage confirm answer is "nothing confirmed" or "could not check" — never a fix
    info = story_guards.report_info(app.store, pid, "main")
    assert info and not [i for i in info["items"] if i["status"] == "fixed"]


def test_an_ai_that_cannot_answer_lists_the_candidates(tmp_path):
    fake = SlotFake()
    fake.chapter_texts = {"ch3": CH3}
    fake.fail_kind("guard_check", AkoweError("TIMEOUT", "/", "too slow"))
    app, fake, run = book(tmp_path, fake)
    pid = run["project_id"]
    assert run["status"] == "done", run.get("problem")
    codes = [e.get("code") for e in run["events"]]
    assert "GUARD_CHECK_FAILED" in codes and "GUARD_LISTED" in codes and "GUARD_FIX" not in codes
    info = story_guards.report_info(app.store, pid, "main")
    assert any(i["status"] == "possible" and "Bram Hollis" in i["what"] for i in info["items"])
    _bp, _o, chs = chapters(app, pid)
    assert NEWCOMER in str((chs[2][1].get("data") or {}).get("text") or "")


def test_switched_off_nothing_is_built_told_or_checked(tmp_path):
    fake = SlotFake()
    fake.chapter_texts = {"ch2": CH2, "ch3": CH3}
    fake.grid_script = [_grid]
    app, fake, run = book(tmp_path, fake, body={"scope_guard": False, "knowledge_grid": False})
    pid = run["project_id"]
    assert run["status"] == "done", run.get("problem")
    assert not fake.prompts.get("grid") and not fake.prompts.get("guard_check")
    assert not any(b.get("scope") or b.get("who_knows") for b in _briefs(fake))
    _bp, outline, chs = chapters(app, pid)
    assert scope_guard.current(app.store, pid, "main", outline) is None
    assert story_guards.report_info(app.store, pid, "main") is None
    brief, _meta = chapter_brief.build(app.store, pid, "main", outline, chs[2][0])
    assert not (brief or {}).get("scope")


def test_the_forecast_counts_the_guards_and_their_off_switch():
    from akowe import run_forecast
    on = run_forecast.option_calls({"scope_guard": True, "knowledge_grid": True}, 10, 2)["story_guards"]
    assert on["calls"] == pytest.approx(1 + (run_forecast.GUARD_SHARE + 2 * run_forecast.GUARD_FIX_SHARE) * 10)
    off = run_forecast.option_calls({"scope_guard": False, "knowledge_grid": False}, 10, 2)["story_guards"]
    assert off["calls"] == 0
    assert "story_guards" in run_forecast.INSIDE_MEASURED
