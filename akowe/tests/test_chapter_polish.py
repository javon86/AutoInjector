"""📏 Chapter polish (chapter_polish.py): the no-AI reading-level and repeat checks of each fresh draft, ONE targeted
polish when it is needed, kept only when the checks improved and nothing protected changed; the repeat fixes of an
improve round that was not kept (improve_pass.repeat_only); the concrete reading-level brief; the forecast."""
from __future__ import annotations

from akowe import chapter_polish as cp
from akowe import improve_pass as ip
from akowe import quality_history as qh
from akowe import run_forecast
from akowe.book_path import BookPath
from akowe.book_report import book_chapters

from test_book_quality import _worse_review
from test_failover_review import SlotFake, make_app, run_book  # noqa: F401

# simple adult prose (grade under 5); chapter 3 repeats two phrases of chapter 1 (in two-sentence paragraphs, so
# the stretches of short sentences and the repeats are different passages)
CH1 = ("Mara walked on mill row the danso way at dawn, with the lamp swinging in her cold hand. Water ran off her "
       "elbows as she climbed the first of the steps.\n\n"
       "She went up the steps. The door was shut. She hit it once. Nobody came. The wind was loud.\n\n"
       "Tom Reed was gone. His log was on the desk. The ink was wet. She read the last line. It made no sense.")
CH2 = ("The harbor was grey. Boats knocked in the swell. Nessa sold fish at the shed. She would not talk. Mara asked "
       "her twice.\n\nThe gulls were loud. A dog ran past. The tide was low. Mara sat on a crate. She thought hard.")
CH3 = ("The tide went out before dawn.\n\n"
       "At low tide Mara walked on mill row the danso way again, toward the reef and the black stones. Water ran off "
       "her elbows while she searched the pools.\n\n"
       "The reef was wet. She saw a glint. It was a key. It was brass. She took it.\n\n"
       "She went back up. The lamp was dark. She put the key in. It turned. The light came on.")
SWAPS = {"on mill row the danso way": "past the shuttered weavers' sheds",
         "Water ran off her elbows": "Rain dripped from her sleeves"}
QUICK = {"length": "short_story", "improve_pass": False, "opening_pass": False, "first_page": False}
NAMES = ["Mara Vell", "Tom Reed", "Nessa Crane"]


def _fake(**kw):
    fake = SlotFake(**kw)
    fake.chapter_texts = {"ch1": CH1, "ch2": CH2, "ch3": CH3}
    return fake


def _texts(app, run):
    bp = BookPath(app.engine, "author", run["project_id"], "main")
    return {c["number"]: c for c in book_chapters(bp)}


# ====================================================================== the checks (no AI)
def test_the_checks_find_a_low_grade_and_the_phrases_repeated_from_earlier_chapters():
    m = cp.measure(CH3, [CH1, CH2])
    assert m["grade"] < 5 and m["repeats"] >= 2
    assert cp.needs(m, 5.0) == ["reading", "repeats"] and cp.needs(m, None) == ["repeats"]
    assert cp.needs(cp.measure(CH3, []), None) == []  # no floor (children) and no earlier chapter: nothing to do
    fs = cp.findings(CH3, m, 5.0, cp.needs(m, 5.0))
    assert {f["dimension"] for f in fs} == {"prose_variety", "reading_level"}
    assert all(f["passage"] in CH3 and "“" not in f["passage"] for f in fs) and len(fs) <= cp.MAX_FINDINGS
    # repeats among the earlier chapters themselves never count against this one
    assert cp.repeats_into(CH2, [CH1, CH3]) == []


def test_nothing_protected_may_change_and_a_polish_must_improve_without_making_anything_worse():
    old = 'Mara climbed 112 steps. “Who is there?” she said. Tom Reed was gone.'
    assert cp.protected_change(old, old.replace("Who is there?", "Who's there?"), NAMES) == "DIALOGUE"
    assert cp.protected_change(old, old.replace("Tom Reed", "The keeper"), NAMES) == "NAMES"
    assert cp.protected_change(old, old.replace("112", "113"), NAMES) == "NUMBERS"
    assert cp.protected_change(old, old + " It was late and cold and dark and she was very tired." * 3, NAMES) == \
        "LENGTH"
    assert cp.protected_change(old, old.replace("climbed", "hauled herself up"), NAMES) is None
    b = {"grade": 3.0, "repeats": 2, "tic_uses": 0, "ai": 0}
    assert cp.judge(b, dict(b, grade=5.2), 5.0, 10.0) == (True, "KEPT")
    assert cp.judge(b, dict(b, repeats=0), 5.0, 10.0) == (True, "KEPT")
    assert cp.judge(b, dict(b, grade=3.1), 5.0, 10.0) == (False, "NO_GAIN")
    assert cp.judge(b, dict(b, grade=6.0, repeats=3), 5.0, 10.0) == (False, "MORE_REPEATS")
    assert cp.judge(b, dict(b, grade=6.0, ai=1), 5.0, 10.0) == (False, "MORE_AI")
    assert cp.judge(b, dict(b, grade=2.0, repeats=0), 5.0, 10.0) == (False, "GRADE_DOWN")
    assert cp.judge(b, dict(b, grade=11.0), 5.0, 10.0) == (False, "TOO_HARD")


# ====================================================================== the run
def test_a_polish_is_kept_when_the_grade_rises_and_the_repeats_go(tmp_path):
    fake = _fake()
    fake.polish_swaps = dict(SWAPS)
    app = make_app(tmp_path, fake)
    run = run_book(app, QUICK)
    assert run["status"] == "done", run.get("problem")
    assert fake.kinds.count("polish") == 3  # one per chapter, never more
    mem = app.autobook.get(run["id"])["polish"]["chapters"]
    assert all(r["kept"] for r in mem.values()), mem
    r3 = mem["ch3"]
    assert r3["before"]["grade"] < 5 and r3["after"]["grade"] >= r3["before"]["grade"] + 4, r3
    assert r3["before"]["repeats"] >= 2 and r3["after"]["repeats"] == 0, r3
    ch = _texts(app, run)
    assert all(c["approved"] for c in ch.values())  # reviewed and approved as usual
    assert "weavers' sheds" in ch[3]["text"] and "danso" not in ch[3]["text"] and "danso" in ch[1]["text"]
    for n, orig in ((1, CH1), (2, CH2), (3, CH3)):  # nothing protected changed
        assert cp.protected_change(orig, ch[n]["text"], NAMES) is None
    codes = [e.get("code") for e in run["events"]]
    assert codes.count("CHAPTER_POLISH_KEPT") == 3 and "CHAPTER_POLISH" in codes
    line = app.autobook.get(run["id"])["report"]["polish"]
    assert line.startswith("📏 Reading level ") and "→" in line and "after polish in chapters 1, 2, 3" in line
    rep = app.reports.latest(run["project_id"], "main")
    assert rep.get("polish") == line  # the saved report says it too
    md = __import__("akowe.book_report", fromlist=["render_markdown"]).render_markdown(rep)
    assert line in md


def test_a_polish_that_changes_a_number_is_not_kept_and_the_draft_stays(tmp_path):
    fake = _fake()

    def adds_a_number(ctx):
        f = ctx["findings"][0]
        return {"replacements": [{"finding_id": f["id"], "original": f["passage"],
                                  "replacement": f["passage"].replace(".", ", all 40 of them.", 1)}]}
    fake.polish_script = [adds_a_number, adds_a_number, adds_a_number]
    app = make_app(tmp_path, fake)
    run = run_book(app, QUICK)
    assert run["status"] == "done", run.get("problem")
    mem = app.autobook.get(run["id"])["polish"]["chapters"]
    assert {r["code"] for r in mem.values()} == {"NUMBERS"} and not any(r["kept"] for r in mem.values())
    ch = _texts(app, run)
    assert ch[3]["text"] == CH3 and ch[1]["text"] == CH1  # the drafts as written
    assert [e.get("code") for e in run["events"]].count("CHAPTER_POLISH_NOT_KEPT") == 3
    assert "not kept" in app.autobook.get(run["id"])["report"]["polish"]


def test_switched_off_the_chapters_are_written_the_old_way(tmp_path):
    fake = _fake()
    fake.polish_swaps = dict(SWAPS)
    app = make_app(tmp_path, fake)
    run = run_book(app, dict(QUICK, chapter_polish=False))
    assert run["status"] == "done", run.get("problem")
    assert "polish" not in fake.kinds and not app.autobook.get(run["id"]).get("polish")
    assert _texts(app, run)[3]["text"] == CH3
    assert not any(str(e.get("code") or "").startswith("CHAPTER_POLISH") for e in run["events"])


def test_a_chapter_that_reads_well_and_repeats_nothing_costs_no_ai_answer(tmp_path):
    fake = SlotFake()  # the fake's own chapters: grade 7-9, no repeats
    app = make_app(tmp_path, fake)
    run = run_book(app, QUICK)
    assert run["status"] == "done", run.get("problem")
    assert "polish" not in fake.kinds
    mem = app.autobook.get(run["id"])["polish"]["chapters"]
    assert {r["state"] for r in mem.values()} == {"not_needed"}
    assert "polish" not in (app.autobook.get(run["id"]).get("report") or {})


def test_the_forecast_counts_at_most_one_polish_per_chapter_and_none_when_off(tmp_path):
    app = make_app(tmp_path, SlotFake())
    on = run_forecast.option_calls(run_forecast.options_of(app, {}), 8, 3)["chapter_polish"]
    off = run_forecast.option_calls(run_forecast.options_of(app, {"chapter_polish": False}), 8, 3)["chapter_polish"]
    assert on["calls"] == 2 and off["calls"] == 0 and on["to"] == "writer"  # no history: about a quarter
    # the author's last book read too simply: every chapter is expected to need its polish (never more than one)
    qh.record(app.store, "author", {"at": "2026-11-01T00:00:00Z", "book": "b1", "overall": 7.0, "grade": 2.9,
                                    "habits": ["simple", "phrase"]})
    full = run_forecast.option_calls(run_forecast.options_of(app, {}), 8, 3)["chapter_polish"]
    assert full["calls"] == 8
    est = run_forecast.estimate(app, {"length": "short_story"})
    assert any(r["step"] == "option:chapter_polish" for r in est["steps"])
    assert not any(r["step"] == "option:chapter_polish" for r in run_forecast.estimate(
        app, {"length": "short_story", "chapter_polish": False})["steps"])


# ====================================================================== the writer's brief
def test_the_reading_level_brief_names_a_target_a_sentence_mix_and_a_joined_example(tmp_path, monkeypatch):
    import akowe.book_path as bpm
    monkeypatch.setattr(bpm, "get_profile", lambda store, pid: {"audience": "Adult", "genre": "Mystery"})
    t = qh.reading_floor(None, "P")
    assert "reading grade of at least 5" in t and "about 6–8" in t and "10–20 words" in t and "25+ words" in t
    assert "He stopped at the mill door and listened" in t and len(t) < 500


# ====================================================================== 🔁 improve pass not kept: repeat fixes alone
def _chs():
    return [{"chapter_id": "ch1", "number": 1, "record_id": "R1", "version": 2, "text": CH1},
            {"chapter_id": "ch2", "number": 2, "record_id": "R2", "version": 2, "text": CH2},
            {"chapter_id": "ch3", "number": 3, "record_id": "R3", "version": 2, "text": CH3}]


def test_repeat_only_keeps_just_the_safe_repeat_fixes_of_a_round():
    s1 = "At low tide Mara walked on mill row the danso way again, toward the reef and the black stones."
    good = {"finding_id": "i3-1", "source": "repeat", "passage": s1, "original": s1,
            "replacement": s1.replace("on mill row the danso way", "past the shuttered weavers' sheds")}
    big = {"finding_id": "i3-2", "source": "reviewers", "passage": "", "original": "The reef was wet.",
           "replacement": "The reef was wet, and a stranger stood on it."}
    cand = {"chapter_id": "ch3", "number": 3, "record_id": "R3", "version": 2, "fixes": [good, big]}
    assert ip.repeat_only(_chs(), [cand], NAMES, {"ch3": [s1]}) == []  # a quote the editor said to keep stays
    out = ip.repeat_only(_chs(), [cand], NAMES)
    assert len(out) == 1 and out[0]["accept"] == ["i3-1"] and out[0]["after"] < out[0]["before"]
    assert "weavers' sheds" in out[0]["text"] and "stranger" not in out[0]["text"]  # only the repeat fix
    # a repeat "fix" that changes a line of dialogue, a name or a number, or fixes nothing, is never kept
    nm = dict(good, replacement=s1.replace("Mara", "the girl"))
    same = dict(good, replacement=s1.replace("black", "dark"))
    old = dict(cand, version=1)  # the chapter changed since: never applied to another version
    for c in (dict(cand, fixes=[nm]), dict(cand, fixes=[same]), dict(old, fixes=[good]), dict(cand, fixes=[big])):
        assert ip.repeat_only(_chs(), [c], NAMES) == []


def _repeat_and_more(ctx):
    """The improve rewrite: the repeat finding gets a fresh phrase, another finding a bigger change."""
    out = []
    text = ctx.get("chapter_text") or ""
    for f in ctx.get("findings") or []:
        p = f.get("passage") or ""
        if "danso" in p and p in text:
            out.append({"finding_id": f["id"], "original": p,
                        "replacement": p.replace("on mill row the danso way", "past the shuttered weavers' sheds")})
        elif not p and text.count("a glint") == 1 and not any(o["original"] == "a glint" for o in out):
            out.append({"finding_id": f["id"], "original": "a glint",
                        "replacement": "a glint of old brass under the weed"})
    return {"replacements": out}


def test_an_improve_round_not_kept_still_keeps_its_safe_repeat_fixes(tmp_path):
    fake = _fake()  # no polish swaps: the chapter polish only joins sentences, the repeats stay for the improve pass
    fake.rewrite_script = [_repeat_and_more] * 3
    fake.book_review_script = [None, None, _worse_review, _worse_review]
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story", "opening_pass": False, "first_page": False, "improve_rounds": 1,
                         "improve_mode": "chapters"})
    assert run["status"] == "done", run.get("problem")
    mem = app.autobook.get(run["id"])["improve"]
    assert mem["kept"] is False and mem["repeat_fixes"]["chapters"] == [3], mem
    ch = _texts(app, run)
    assert "weavers' sheds" in ch[3]["text"] and "old brass under the weed" not in ch[3]["text"]
    assert "danso" in ch[1]["text"] and all(c["approved"] for c in ch.values())
    assert "repeated phrases fixed alone in chapter(s) 3" in mem["line"]
    assert "IMPROVE_REPEATS_KEPT" in [e.get("code") for e in run["events"]]


def test_switched_off_an_improve_round_not_kept_changes_nothing(tmp_path):
    fake = _fake()
    fake.rewrite_script = [_repeat_and_more] * 3
    fake.book_review_script = [None, None, _worse_review, _worse_review]
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story", "opening_pass": False, "first_page": False, "improve_rounds": 1,
                         "improve_mode": "chapters",
                         "chapter_polish": False})
    assert run["status"] == "done", run.get("problem")
    mem = app.autobook.get(run["id"])["improve"]
    assert mem["kept"] is False and not mem.get("repeat_fixes")
    assert _texts(app, run)[3]["text"] == CH3


# ====================================================================== 📏 a chapter far over its share is trimmed
LONG = ("Mara stood at the rail and looked at the water for a long time, thinking about the lamp, the keeper, the "
        "missing log and everything that had gone wrong since the storm, and she knew again that the keeper was gone "
        "and that the log was gone, which she had known since the morning.\n\n"
        "“Where is he?” Nessa asked.\n\n"
        "The boat came in. Mara climbed down to meet it.")


def test_a_chapter_far_over_its_share_is_flagged_for_trimming_never_its_dialogue():
    m = cp.measure(LONG, [])
    w = m["plain_words"]
    assert cp.needs(m, None, None, target=w) == []                       # at its share: nothing to do
    assert cp.needs(m, None, None, target=int(w / 1.1)) == []            # 10 % over: still fine (the cap is 15 %)
    assert cp.needs(m, None, None, target=int(w / 1.3)) == ["long"]      # 30 % over: trim
    assert cp.needs(m, None, {"chapter_trim": False}, target=int(w / 1.3)) == []   # switched off
    fs = cp.findings(LONG, m, None, ["long"], target=int(w / 1.3))
    assert fs and all(f["dimension"] == "length" and f["passage"] in LONG and "“" not in f["passage"] for f in fs)
    assert "Mara stood at the rail" in fs[0]["passage"] and f"{w:,} words" in fs[0]["why"]
    # a trim counts as a gain only for a too-long chapter, and only when it really got shorter
    b = {"grade": 7.0, "repeats": 0, "tic_uses": 0, "ai": 0, "plain_words": 100}
    assert cp.judge(b, dict(b, plain_words=90), None, None, long=True) == (True, "KEPT")
    assert cp.judge(b, dict(b, plain_words=99), None, None, long=True) == (False, "NO_GAIN")
    assert cp.judge(b, dict(b, plain_words=90), None, None) == (False, "NO_GAIN")
    # a too-long chapter may shrink down to the bottom of its range (90 % of its share), more than the usual 20 %
    old = "word " * 100
    assert cp.protected_change(old, "word " * 70) == "LENGTH"
    assert cp.protected_change(old, "word " * 70, shrink=cp.trim_shrink(100, 60)) is None
    assert cp.protected_change(old, "word " * 50, shrink=cp.trim_shrink(100, 60)) == "LENGTH"
    assert cp.trim_shrink(100, 95) == cp.MAX_LENGTH_CHANGE


def test_a_draft_far_over_its_share_is_trimmed_in_its_one_polish(tmp_path, monkeypatch):
    fake = _fake()
    fake.chapter_texts = {"ch1": LONG, "ch2": CH2, "ch3": CH3}
    cut = ", thinking about the lamp, the keeper, the missing log and everything that had gone wrong since the storm"

    def trims(ctx):
        reps = [{"finding_id": f["id"], "original": f["passage"], "replacement": f["passage"].replace(cut, "")}
                for f in ctx["findings"] if f["dimension"] == "length" and cut in f["passage"]]
        return {"replacements": reps}
    fake.polish_script = [trims, trims, trims]
    app = make_app(tmp_path, fake)
    monkeypatch.setattr(cp, "chapter_target", lambda store, pid, outline: 30)   # each chapter's share: 30 words
    monkeypatch.setattr(cp, "audience", lambda store, pid: (None, None))       # no reading floor: length only
    run = run_book(app, QUICK)
    assert run["status"] == "done", run.get("problem")
    r1 = app.autobook.get(run["id"])["polish"]["chapters"]["ch1"]
    assert "long" in r1["why"] and r1["target"] == 30 and r1["kept"], {k: r1.get(k) for k in ("code", "reason", "state", "after", "before")}
    assert r1["after"]["plain_words"] < r1["before"]["plain_words"]
    ch = _texts(app, run)
    assert cut not in ch[1]["text"] and "“Where is he?” Nessa asked." in ch[1]["text"]   # dialogue untouched
    ev = [e for e in run["events"] if e.get("code") == "CHAPTER_POLISH_KEPT" and e.get("chapter_id") == "ch1"]
    assert ev and "length" in ev[0]["message"] and "share 30" in ev[0]["message"]
