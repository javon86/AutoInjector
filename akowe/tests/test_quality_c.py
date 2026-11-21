"""📈 Book quality, batch C ("AI novel quality beyond eight", recommendations 8 and 9): ✋ every AI rewrite of a chapter
is told which lines to KEEP (and is refused when it cuts one), stopping rules for revisions that do not improve the
chapter, 🎬 the ending / climax chapter written against its own checklist, and 📌 the facts each chapter relies on
listed, with their chapters, before it is written."""
from __future__ import annotations

import json

import pytest

from akowe import editor as editor_mod
from akowe import ending_writer, keep_brief, promise_ledger
from akowe.errors import AkoweError

import autobook_fake
from test_failover_review import SlotFake, make_app
from test_world_planned import book, chapters

KEEP_LINE = ("The fog rolled in over Gullhaven before dawn, and Mara Vell climbed the hundred and twelve steps of the "
             "old lighthouse with a lantern in one hand and her master's last letter in the other.")
TEXT = KEEP_LINE + "\n\nThe lamp room was cold. Tom Reed's logbook lay open beside a cracked lens."


class Store:
    def __init__(self):
        self.s = {}

    def get_setting(self, k):
        return self.s.get(k)

    def set_setting(self, k, v):
        self.s[k] = v


class Job:
    pass


# ====================================================================== ✋ pure: the KEEP lines
def test_merge_keeps_only_exact_usable_lines_once():
    got = keep_brief.merge([KEEP_LINE, KEEP_LINE, "The lamp room was cold.", "short", "Not in the chapter at all, "
                            "invented by the reviewer.", 42, "Tom Reed's logbook lay open"], TEXT)
    assert got == [KEEP_LINE, "The lamp room was cold.", "Tom Reed's logbook lay open"]
    # a line inside a longer one is dropped (the longer one keeps both)
    assert keep_brief.merge(["Mara Vell climbed the hundred", KEEP_LINE], TEXT) == [KEEP_LINE]
    assert keep_brief.merge([KEEP_LINE, "Mara Vell climbed the hundred"], TEXT) == [KEEP_LINE]
    assert keep_brief.clean_keep({"keep": "junk"}, TEXT) == [] and keep_brief.clean_keep(None, TEXT) == []
    assert keep_brief.clean_keep({"keep": [KEEP_LINE, "x" * 400]}, TEXT) == [KEEP_LINE]
    s = keep_brief.review_schema({"properties": {"verdict": {}}})
    assert set(s["properties"]) == {"verdict", "keep"} and "keep" not in (s.get("required") or [])


def test_a_line_the_rewrite_is_asked_to_change_is_not_kept():
    q = "The lamp room was cold."
    assert keep_brief.asked_to_change(q, ["Cut “The lamp room was cold.” — it tells."])
    assert keep_brief.asked_to_change(q, ['The line "lamp room was cold" is flat.'])
    assert not keep_brief.asked_to_change(q, ["Name the harbor in the first line."])
    # a flagged passage that overlaps the line in the text
    assert keep_brief.asked_to_change(q, [], TEXT, ["was cold. Tom Reed's logbook"])
    assert not keep_brief.asked_to_change(q, [], TEXT, ["Mara Vell climbed"])


def test_cosmetic_and_gain():
    assert keep_brief.cosmetic("She ran.  Then she hid.", "She ran — then she hid!")
    assert not keep_brief.cosmetic("She ran. Then she hid.", "She ran. Then she waited.")
    old = {"avg_score": 7.0, "min_score": 5, "counts": {"major": 2}}
    assert not keep_brief.gained(old, {"avg_score": 7.0, "min_score": 5, "counts": {"major": 2}})
    assert keep_brief.gained(old, {"avg_score": 7.2, "min_score": 5, "counts": {"major": 2}})
    assert keep_brief.gained(old, {"avg_score": 7.0, "min_score": 5, "counts": {"major": 1}})
    assert keep_brief.gained(None, old)


def test_run_options_are_validated():
    assert keep_brief.clean_run_option({}) == {"keep_briefs": True}
    assert keep_brief.clean_run_option({"keep_briefs": False}) == {"keep_briefs": False}
    assert ending_writer.clean_run_option({"fact_plan": False}) == {"ending_writer": True, "fact_plan": False}
    for mod, k in ((keep_brief, "keep_briefs"), (ending_writer, "ending_writer"), (ending_writer, "fact_plan")):
        with pytest.raises(AkoweError) as e:
            mod.clean_run_option({k: "yes"})
        assert e.value.code == "INVALID_INPUT"


def test_collect_reads_the_reviewer_the_editor_and_the_book_report():
    st = Store()
    st.set_setting("ai_reviews:p:main", {"r1:2": {"keep": ["The lamp room was cold."]}, "r9:1": {"keep": [KEEP_LINE]}})
    st.set_setting("craft_reviews:p:main", {"r1:1": {"keep_quotes": ["Tom Reed's logbook lay open beside"]}})
    st.set_setting("book_reports:p:main", {"reports": [{"aggregate": {"strengths": [
        {"point": "a strong opening", "quote": KEEP_LINE}]}}]})
    assert keep_brief.collect(st, "p", "main", "r1", TEXT) == [
        "The lamp room was cold.", "Tom Reed's logbook lay open beside", KEEP_LINE]
    assert keep_brief.collect(st, "p", "main", "r2", "") == []


def test_guard_fix_refuses_a_cut_keep_line_and_a_cosmetic_fix():
    notes, stopped = [], []
    job = Job()
    job.keep_kind, job.keep_label = "fix", "chapter ch1"
    job.keep_note = lambda code, msg, what=None: notes.append(code)
    job.keep_stop = lambda: stopped.append(True)
    rec = {"module_id": "C02", "data": {"text": TEXT}}
    with pytest.raises(AkoweError) as e:
        keep_brief.guard_fix(job, rec, {"text": TEXT.replace(KEEP_LINE, "Fog came.")}, [KEEP_LINE], {})
    assert notes == ["KEEP_LOST"] and e.value.check_problems[0].startswith("KEEP_LOST: ")
    with pytest.raises(AkoweError):
        keep_brief.guard_fix(job, rec, {"text": TEXT.replace("cold.", "cold!")}, [KEEP_LINE], {})
    assert notes[-1] == "FIX_COSMETIC" and stopped == [True]
    # a review about punctuation may change only punctuation; a real change passes
    keep_brief.guard_fix(job, rec, {"text": TEXT.replace("cold.", "cold!")}, [], {"reasons": ["Fix the punctuation."]})
    keep_brief.guard_fix(job, rec, {"text": TEXT + " A gull cried."}, [KEEP_LINE], {})
    # a job that is not armed is never touched
    keep_brief.guard_fix(Job(), rec, {"text": "x"}, [KEEP_LINE], {})


def test_a_rewrite_never_cuts_a_keep_line_the_findings_do_not_touch():
    notes = []
    job = Job()
    job.keep_kind, job.keep_label, job.keep_lines = "planned_fix", "chapter ch1", [KEEP_LINE, "The lamp room was cold."]
    job.keep_note = lambda code, msg, what=None: notes.append(code)
    findings = [{"id": "f1", "passage": "The lamp room was cold."}]
    keep = keep_brief.for_propose(job, TEXT, findings)
    assert keep == [KEEP_LINE]  # the flagged line itself may change
    reps = [{"finding_id": "f1", "original": KEEP_LINE + "\n\nThe lamp room was cold.",
             "replacement": "Fog. The lamp room was icy."}]
    res = editor_mod.apply_replacements(TEXT, reps, findings, keep)
    assert not res["applied"] and res["unresolved"][0]["reason"] == "KEEP_LOST"
    keep_brief.after_propose(job, res)
    assert notes == ["KEEP_SAVED"]
    assert keep_brief.for_propose(Job(), TEXT, findings) == []


def test_the_editor_stops_when_a_kept_rewrite_did_not_raise_the_scores():
    events = []

    class Svc:
        def event(self, run, kind, msg, **kw):
            events.append(kw.get("code"))
    run = {"settings": {}}
    old = {"verdict": "REVISE", "avg_score": 7.0, "min_score": 5, "counts": {"major": 1}}
    same = dict(old)
    assert keep_brief.editor_stop(Svc(), run, "r1", "chapter ch1", old, same)
    assert events == ["EDITOR_NO_GAIN"] and run["keep_brief"]["stopped"] == 1
    assert keep_brief.editor_stop(Svc(), run, "r1", "c", old, dict(old, avg_score=7.5)) is None
    assert keep_brief.editor_stop(Svc(), run, "r1", "c", old, dict(old, verdict="PASS")) is None
    assert keep_brief.editor_stop(Svc(), {"settings": {"keep_briefs": False}}, "r1", "c", old, same) is None
    assert "stopped" in keep_brief.report_line(run)
    assert keep_brief.report_line({}) is None


# ====================================================================== ✋ in a ⚡ run
def _first_chapter(ctx) -> tuple[bool, int]:
    d = ctx.get("draft") or {}
    if d.get("module_id") != "C02":
        return False, 0
    text = (json.loads(d.get("data_json") or "{}") or {}).get("text") or ""
    return KEEP_LINE in text or "Fog came." in text, int(d.get("version") or 0)


def _reviewer(revise_versions=(1,), keep=(KEEP_LINE,)):
    def v(ctx):
        first, ver = _first_chapter(ctx)
        if first and ver in revise_versions:
            return {"verdict": "REVISE", "reasons": ["The middle sags."], "suggested_changes": ["Cut the slack."],
                    "confidence": 0.8, "keep": list(keep)}
        return "APPROVE"
    return v


def _cut_keep(data, ctx):
    data["text"] = data["text"].replace(KEEP_LINE, "Fog came.") + " The harbor was called Gullhaven."
    return data


def _final_text(app, pid):
    _bp, _outline, chs = chapters(app, pid)
    return ((chs[0][1] or {}).get("data") or {}).get("text") or ""


def test_a_review_fix_that_cuts_a_keep_line_is_refused_and_the_next_fix_is_told(tmp_path):
    fake = SlotFake(default_verdict=_reviewer())
    fake.fix_script = [_cut_keep]
    app, fake, run = book(tmp_path, fake)
    pid = run["project_id"]
    codes = [e.get("code") for e in run["events"]]
    assert "KEEP_LOST" in codes
    # the reviewer was asked for its strongest lines; the fixes got them as context.keep
    assert any("keep" in c["props"] and "verdict" in c["props"] for c in fake.calls)
    fixes = [c for _s, c in fake.prompts.get("fix") or []]
    assert len(fixes) >= 2 and fixes[0]["keep"] == [KEEP_LINE]
    assert any("KEEP_LOST" in p for p in fixes[1].get("akowe_checks") or [])
    # the approved chapter still has the line (the cutting fix was never saved)
    assert KEEP_LINE in _final_text(app, pid)
    assert app.autobook.get(run["id"])["keep_brief"]["refused"] == 1
    assert any(e.get("code") == "KEEP_BRIEFS" for e in run["events"])


def test_a_cosmetic_fix_is_refused_and_ends_the_fixing(tmp_path):
    def punct(data, ctx):
        data["text"] = data["text"].replace("cold.", "cold!", 1)
        return data
    n = {"c": 0}

    def v(ctx):
        first, _ver = _first_chapter(ctx)
        if first:
            n["c"] += 1
            if n["c"] == 1:
                return {"verdict": "REVISE", "reasons": ["The middle sags."], "suggested_changes": ["Cut it."],
                        "confidence": 0.8}
        return "APPROVE"
    fake = SlotFake(default_verdict=v)
    fake.fix_script = [punct]
    app, fake, run = book(tmp_path, fake)
    codes = [e.get("code") for e in run["events"]]
    assert "FIX_COSMETIC" in codes
    full = app.autobook.get(run["id"])
    assert full["keep_brief"]["stopped"] == 1
    from akowe.autobook import MAX_FIXES  # noqa: PLC0415
    assert MAX_FIXES in (full.get("fix_counts") or {}).values()
    assert "cold!" not in _final_text(app, run["project_id"])


def test_garbage_keep_answers_leave_the_book_as_before(tmp_path):
    fake = SlotFake(default_verdict=_reviewer(keep=("invented, not in the chapter at all", 42)))
    fake.fix_script = [_cut_keep]
    app, fake, run = book(tmp_path, fake)
    codes = [e.get("code") for e in run["events"]]
    assert "KEEP_LOST" not in codes and "KEEP_BRIEFS" not in codes
    assert "Fog came." in _final_text(app, run["project_id"])  # nothing to keep: the fix is saved as before


def test_keep_briefs_off(tmp_path):
    fake = SlotFake(default_verdict=_reviewer())
    fake.fix_script = [_cut_keep]
    app, fake, run = book(tmp_path, fake, body={"keep_briefs": False})
    codes = [e.get("code") for e in run["events"]]
    assert "KEEP_LOST" not in codes
    assert not any("keep" in c["props"] and "verdict" in c["props"] for c in fake.calls)
    assert all("keep" not in c for _s, c in fake.prompts.get("fix") or [])
    assert "Fog came." in _final_text(app, run["project_id"])


def test_a_bad_setting_is_refused_at_the_start(tmp_path):
    app = make_app(tmp_path, SlotFake(), slots=("AI-1", "AI-2"))
    for k in ("keep_briefs", "ending_writer", "fact_plan"):
        with pytest.raises(AkoweError) as e:
            app.autobook.start("author", {"author_confirms": True, "slot_id": "AI-1", k: "on"})
        assert e.value.code == "INVALID_INPUT"


# ====================================================================== 🎬 the ending writer and 📌 the facts
KEY = "Mara hides the brass key under the third lighthouse stair"
PAYOFF = "Mara uses the brass key to open the sealed lamp room"


def _ledger(ctx):
    n = len(ctx["chapters"])
    return {"promises": [{"promise": KEY, "plant": 1, "payoff": PAYOFF, "payoff_from": 2, "payoff_by": n},
                         {"promise": "The keeper's log names a second keeper", "plant": 1,
                          "payoff": "the second keeper is found on the rocks", "payoff_from": n, "payoff_by": n}]}


def _briefs(fake):
    out = []
    for _s, c in fake.prompts.get("C02") or []:
        b = c.get("writing_brief") or (c.get("request_payload") or {}).get("writing_brief") or {}
        cid = (c.get("request_payload") or {}).get("chapter_id")
        out.append((cid, b))
    return out


def test_the_last_chapter_gets_the_ending_checklist_and_each_chapter_its_facts(tmp_path):
    fake = SlotFake()
    fake.ledger_script = [_ledger]
    fake.story_ledger = True
    app, fake, run = book(tmp_path, fake, body={"choices": {"shape": "turning_points"}})
    assert run["status"] == "done", run.get("problem")
    _bp, outline, chs = chapters(app, run["project_id"])
    last = chs[-1][0]
    briefs = _briefs(fake)
    ends = [b for cid, b in briefs if cid == last and b.get("ending_brief")]
    assert ends, [cid for cid, _b in briefs]
    eb = ends[0]["ending_brief"]
    assert eb["role"] == "ending" and eb["chapter"] == len(chs)
    assert any(x.startswith("Pay off: ") and "second keeper" in x for x in eb["checklist"])
    assert any(x.startswith("Must hold: ") and "calm scene" in x for x in eb["checklist"])
    assert ending_writer.ENDING_RULE in ends[0]["rules"]
    # no other chapter is told it is the ending
    assert not [b for cid, b in briefs if cid != last and (b.get("ending_brief") or {}).get("role") == "ending"]
    # the reviewer of the last chapter checks it against the same checklist
    revs = [c for _s, c in fake.prompts.get("review") or [] if c.get("ending_brief")]
    assert revs and revs[0]["ending_note"] == ending_writer.REVIEW_NOTE
    # 📌 chapter 2 relies on the set-up of chapter 1 (its payoff window is open)
    two = [b for cid, b in briefs if cid == chs[1][0] and b.get("facts_to_cite")]
    assert two and any(x == f"Chapter 1 (set-up): {KEY}" for x in two[0]["facts_to_cite"])
    assert ending_writer.FACT_RULE in two[0]["rules"]
    assert not [b for cid, b in briefs if cid == chs[0][0] and b.get("facts_to_cite")]  # nothing before chapter 1


def test_ending_writer_and_fact_plan_off(tmp_path):
    fake = SlotFake()
    fake.ledger_script = [_ledger]
    app, fake, run = book(tmp_path, fake, body={"ending_writer": False, "fact_plan": False})
    briefs = _briefs(fake)
    assert briefs and not [b for _c, b in briefs if b.get("ending_brief") or b.get("facts_to_cite")]
    assert not [c for _s, c in fake.prompts.get("review") or [] if c.get("ending_brief")]


def test_outside_a_run_the_brief_is_unchanged():
    st = Store()
    assert ending_writer.flags(st, "p", "main") == {"ending_writer": False, "fact_plan": False}
    assert ending_writer.writer_parts(st, "p", "main", None, "ch1", ["x"]) == ({}, [])
    assert ending_writer.review_extra(st, "p", "main", {"module_id": "B11"}) == {}
    assert keep_brief.book_on(st, "p", "main") is False


def _outline(n):
    from akowe.book_path import BookPath  # noqa: PLC0415
    items = [autobook_fake.plan_item(f"ch{i + 1}", i, f"objective {i + 1}") for i in range(n)]
    o = {"record_id": "o1", "version": 1, "data": {"chapters": items}}
    assert len(BookPath.outline_chapters(None, o)) == n
    return o


def test_chapter_role_and_the_climax_of_the_story_shape(monkeypatch):
    from akowe import story_shape  # noqa: PLC0415
    st = Store()
    o = _outline(5)
    ids = [f"ch{i + 1}" for i in range(5)]
    monkeypatch.setattr(story_shape, "mapping", lambda *a, **k: {"beats": [{"id": "climax", "chapter_id": "ch4"}]})
    assert ending_writer.chapter_role(st, "p", "main", o, ids[-1]) == ("ending", 5, 5)
    assert ending_writer.chapter_role(st, "p", "main", o, "ch4") == ("climax", 4, 5)
    assert ending_writer.chapter_role(st, "p", "main", o, "ch2") is None
    assert ending_writer.chapter_role(st, "p", "main", o, "nope") is None
    # the climax checklist leaves out the "calm ending" habit; a ledger set-up whose window is open is listed
    entries, _p = promise_ledger.validate([{"promise": KEY, "plant": 1, "payoff": PAYOFF, "payoff_from": 3,
                                            "payoff_by": 5}], 5)
    promise_ledger.save(st, "p", "main", {"outline": "o1", "version": 1, "chapters": 5, "entries": entries})
    st.list_records = lambda pid, branch: []
    lines = ending_writer.checklist(st, "p", "main", o, "climax", 4)
    assert lines[0].startswith("Pay off: " + PAYOFF) and not any("calm scene" in x for x in lines)
    assert any("calm scene" in x for x in ending_writer.checklist(st, "p", "main", o, "ending", 5))
    assert not [x for x in ending_writer.checklist(st, "p", "main", o, "climax", 2) if x.startswith("Pay off")]


def test_facts_to_cite_picks_the_ledger_facts_the_plan_shares():
    from akowe import story_ledger  # noqa: PLC0415
    st = Store()
    o = _outline(4)
    st.set_setting(ending_writer.FLAG_KEY.format(pid="p", branch="main"), {"ending_writer": True, "fact_plan": True})
    ledger = {"chapters": {
        "ch1": {"chapter_id": "ch1", "number": 1, "summary": ["Mara finds a brass key wedged in the reef stones.",
                                                              "Mara argues with Nessa about the weather."],
                "people": [{"name": "Tom Reed", "status": "dead", "injuries": [], "items_gained": [],
                            "items_lost": [], "carrying": []}], "knowledge": [], "relationships": []},
        "ch2": {"chapter_id": "ch2", "number": 2, "summary": ["Mara hears Nessa sing about the drowned keepers."],
                "people": [], "knowledge": [{"who": "Mara", "what": "the brass key opens the sealed lamp room",
                                             "how": "learns"}], "relationships": []}}}
    st.set_setting(story_ledger.KEY.format(pid="p", branch="main"), ledger)
    got = ending_writer.facts_to_cite(st, "p", "main", o, "ch3", ["Mara opens the sealed lamp room with the brass key"])
    assert got[0] == "Chapter 2: Mara learns: the brass key opens the sealed lamp room"
    assert "Chapter 1: Mara finds a brass key wedged in the reef stones." in got
    assert not [x for x in got if "weather" in x or "Tom Reed" in x]
    assert ending_writer.facts_to_cite(st, "p", "main", o, "ch1", ["brass key"]) == []
    st.set_setting(ending_writer.FLAG_KEY.format(pid="p", branch="main"), {"ending_writer": True, "fact_plan": False})
    assert ending_writer.facts_to_cite(st, "p", "main", o, "ch3", ["brass key lamp room"]) == []


class _TwoNotes(SlotFake):
    """The editor's first note is fixed, then it finds another one with exactly the same scores (no gain)."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.crafted = 0

    def _craft(self, ctx, dims):
        self.crafted += 1
        self.editor_flags = {1: {"was cold": "bit at her fingers"}, 2: {"the final line": "the last line"}}.get(
            self.crafted, {})
        return super()._craft(ctx, dims)


def _editor_book(tmp_path, body=None):
    fake = _TwoNotes()
    app = make_app(tmp_path, fake, slots=("AI-1", "AI-2"))
    app.review.editor.save_settings({"enabled": True, "rounds": 3})
    from test_failover_review import run_book  # noqa: PLC0415
    run = run_book(app, dict({"slot_id": "AI-1"}, **(body or {})))
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    return app, fake, run


def test_a_kept_editor_rewrite_with_no_gain_ends_the_editor_rounds(tmp_path):
    app, fake, run = _editor_book(tmp_path)
    codes = [e.get("code") for e in run["events"]]
    assert "EDITOR_REWRITE_KEPT" in codes and "EDITOR_NO_GAIN" in codes
    eds = list((app.autobook.get(run["id"]).get("editor") or {}).values())
    first = next(e for e in eds if e.get("rounds"))
    assert first["rounds"] == 1 and first["flagged"] and "stopping rule" in first["flag_reason"]
    assert "the final line" in _final_text(app, run["project_id"])  # the second note was not chased


def test_without_keep_briefs_the_editor_goes_on(tmp_path):
    app, fake, run = _editor_book(tmp_path, {"keep_briefs": False})
    codes = [e.get("code") for e in run["events"]]
    assert "EDITOR_NO_GAIN" not in codes
    eds = list((app.autobook.get(run["id"]).get("editor") or {}).values())
    assert max(int(e.get("rounds") or 0) for e in eds) >= 2


def test_a_chapter_with_a_needs_list_cites_only_the_set_ups(monkeypatch):
    from akowe import story_ledger  # noqa: PLC0415
    st = Store()
    o = _outline(3)
    st.set_setting(ending_writer.FLAG_KEY.format(pid="p", branch="main"), {"ending_writer": False, "fact_plan": True})
    st.set_setting(story_ledger.KEY.format(pid="p", branch="main"), {"chapters": {"ch1": {
        "chapter_id": "ch1", "number": 1, "summary": ["Mara finds the brass key wedged in the reef stones."]}}})
    plan = ["Mara opens the reef door with the brass key"]
    assert ending_writer.facts_to_cite(st, "p", "main", o, "ch2", plan)
    assert ending_writer.writer_parts(st, "p", "main", o, "ch2", plan, needs=True) == ({}, [])
