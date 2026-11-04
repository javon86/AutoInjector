"""📐 Story shape (story structure templates): the template data, placing beats on chapters (the planner's answer
checked, a fallback by position), validation, the prompts the beats flow into (outline, scene cards, writer,
reviewer), the planned-to-page check of each beat, the checkpoints / ending check report and the one targeted fix,
the plan page and the Book Bible, changing the shape before the chapters are written, and books without a shape."""
from __future__ import annotations

import pytest

from akowe import planned as planned_mod
from akowe import story_choices, story_shape
from akowe.book_path import BookPath, get_profile
from akowe.errors import AkoweError

from test_failover_review import SlotFake
from test_world_planned import book, chapters


# ====================================================================== the template data
def test_templates_are_plain_data_in_order():
    assert story_shape.IDS == ("three_acts", "save_the_cat", "heros_journey", "seven_point")
    sizes = {"three_acts": 7, "save_the_cat": 15, "heros_journey": 12, "seven_point": 7}
    for tid in story_shape.IDS:
        t = story_shape.template(tid)
        assert len(t["beats"]) == sizes[tid], tid
        ids = [b["id"] for b in t["beats"]]
        assert len(set(ids)) == len(ids)
        ats = [b["at"] for b in t["beats"]]
        assert ats == sorted(ats) and 0 <= ats[0] and ats[-1] == 100
        for b in t["beats"]:
            assert b["name"].strip() and len(b["what"]) > 20 and b["what"][-1] in ".?"
            assert "_" not in b["name"]  # plain words, no ids
    assert story_shape.template("nope") is None and story_shape.template(None) is None
    info = story_shape.info()
    assert info["options"][0]["value"] == "" and info["options"][0]["label"].startswith("None")
    assert [o["value"] for o in info["options"][1:]] == list(story_shape.IDS)
    assert any(b["name"] == "Dark night of the soul" for b in story_shape.template("save_the_cat")["beats"])
    # it comes with the story choices (one call for the forms)
    assert story_choices.field_info()["story_shape"]["key"] == "shape"


def test_clean_and_the_profile_choice():
    assert story_shape.clean(None) == "" and story_shape.clean("") == "" and story_shape.clean("none") == ""
    assert story_shape.clean("heros_journey") == "heros_journey"
    with pytest.raises(AkoweError) as e:
        story_shape.clean("five_acts")
    assert e.value.code == "INVALID_INPUT" and e.value.errors[0]["path"] == "/choices/shape"
    assert story_choices.clean({"shape": "three_acts", "ending": "open"}) == {"shape": "three_acts", "ending": "open"}
    assert story_choices.clean({"shape": ""}) == {}
    with pytest.raises(AkoweError):
        story_choices.clean({"shape": "bad"})
    assert "Story shape: Three acts" in story_choices.summary({"shape": "three_acts"})
    # the shape never leaks into the ending / style prompt parts
    assert story_choices.brief({"shape": "three_acts"}) is None and story_choices.rules({"shape": "three_acts"}) == []


# ====================================================================== placing beats
def test_by_position_and_chapter_for():
    assert story_shape.chapter_for(1, 3) == 1 and story_shape.chapter_for(100, 3) == 3
    assert story_shape.chapter_for(50, 24) == 12 and story_shape.chapter_for(78, 24) == 19
    assert story_shape.chapter_for(0, 10) == 1 and story_shape.chapter_for(50, 0) == 0
    assert story_shape.by_position("three_acts", 3) == [1, 1, 1, 2, 3, 3, 3]
    pos = story_shape.by_position("save_the_cat", 30)
    assert pos == sorted(pos) and pos[0] == 1 and pos[-1] == 30
    assert story_shape.by_position("", 10) == []


def test_validate_keeps_good_placements_and_falls_back_for_bad_ones():
    n = 20
    pos = story_shape.by_position("three_acts", n)  # [1, 3, 5, 10, 15, 18, 20]
    good = [{"beat": b["id"], "chapter": c, "how": f"how {i}"}
            for i, (b, c) in enumerate(zip(story_shape.template("three_acts")["beats"], pos))]
    beats, probs = story_shape.validate("three_acts", good, n)
    assert probs == [] and [b["number"] for b in beats] == pos and all(b["by"] == "ai" for b in beats)
    assert beats[3]["how"] == "how 3"
    # a nearby, different chapter is the planner's choice and is kept
    near = [dict(p) for p in good]
    near[3]["chapter"] = 11
    beats, probs = story_shape.validate("three_acts", near, n)
    assert probs == [] and beats[3]["number"] == 11
    bad = [dict(p) for p in good]
    del bad[1]                                   # left out
    bad[2]["chapter"] = 99                       # a chapter the outline does not have (was index 3: midpoint)
    bad[3]["chapter"] = 2                        # before an earlier beat (no going back -> beat index 4)
    bad.append({"beat": "climax", "chapter": 1, "how": "twice"})  # placed twice: the first place is kept
    bad.append({"beat": "five_acts", "chapter": 3, "how": ""})   # unknown beat
    beats, probs = story_shape.validate("three_acts", bad, n)
    text = " ".join(probs)
    assert "“Something happens” was left out" in text
    assert "a chapter the outline does not have" in text and "before an earlier beat" in text
    assert "placed twice" in text and "unknown beat" in text
    nums = [b["number"] for b in beats]
    assert nums == sorted(nums) and all(1 <= x <= n for x in nums)
    assert beats[1]["by"] == "position" and beats[1]["number"] == pos[1] and beats[1]["how"] == ""
    # far from where it belongs (the midpoint in the last chapter of 20)
    far = [dict(p) for p in good]
    far[3]["chapter"] = 20
    beats, probs = story_shape.validate("three_acts", far, n)
    assert "far from where it belongs" in " ".join(probs) and beats[3]["number"] == 10
    # nothing usable at all: every beat by position
    beats, probs = story_shape.validate("three_acts", "junk", n)
    assert [b["number"] for b in beats] == pos and all(b["by"] == "position" for b in beats) and len(probs) == 7
    assert story_shape.validate("", good, n) == ([], [])


class _Store:
    def __init__(self, prof):
        self.prof = prof

    def get_setting(self, key):
        return self.prof if key.startswith("book_profile:") else None

    def project(self, pid):
        return None


def test_outline_brief():
    assert story_shape.outline_brief(_Store({}), "p", 10) is None
    b = story_shape.outline_brief(_Store({"choices": {"shape": "save_the_cat"}}), "p", 24)
    assert b["name"] == "Save the Cat (15 beats)" and len(b["beats"]) == 15
    dark = next(x for x in b["beats"] if x["beat"] == "dark_night")
    assert dark["around_chapter"] == 19 and dark["where"] == "about 78% into the book"
    assert "around_chapter" not in story_shape.outline_brief(_Store({"choices": {"shape": "three_acts"}}), "p",
                                                             None)["beats"][0]


# ====================================================================== ⚡ a run with a shape
def _beats_ctx_of(fake, kind):
    return [ctx for _sys, ctx in fake.prompts.get(kind) or []]


def test_make_a_book_with_a_shape_places_tells_and_checks_the_beats(tmp_path):
    fake = SlotFake()
    fake.planned_fix = True  # a beat the first draft missed is worked in by the planned-to-page fix
    app, fake, run = book(tmp_path, fake, body={"choices": {"shape": "three_acts"}})
    pid = run["project_id"]
    assert get_profile(app.store, pid)["choices"]["shape"] == "three_acts"
    # 1. the outline planner was told the shape, then placed the beats (one call), stored with the outline
    b11 = [ctx for ctx in _beats_ctx_of(fake, "B11")]
    assert b11 and b11[0]["story_shape"]["name"] == "Three acts"
    assert [b["beat"] for b in b11[0]["story_shape"]["beats"]][:2] == ["setup", "inciting"]
    assert "around_chapter" in b11[0]["story_shape"]["beats"][0]
    assert any("story shape" in sys_ for sys_, _c in fake.prompts["B11"])
    assert len(fake.prompts.get("shape") or []) == 1
    bp, outline, chs = chapters(app, pid)
    n = len(chs)
    m = story_shape.mapping(app.store, pid, "main", outline)
    assert m["by"] == "ai" and m["problems"] == [] and len(m["beats"]) == 7
    assert [b["number"] for b in m["beats"]] == story_shape.by_position("three_acts", n)
    assert all(b["chapter_id"] and b["how"] for b in m["beats"])
    assert any(e.get("code") == "SHAPE_PLACED" for e in run["events"])
    # 2. every chapter's scene planner, writer and reviewer got its beats
    scenes = _beats_ctx_of(fake, "scenes")
    assert scenes and all(c.get("story_beats") for c in scenes)
    assert any("must deliver the story beat" in sys_ for sys_, _c in fake.prompts["scenes"])
    writers = [c for c in _beats_ctx_of(fake, "C02")]
    briefs = [((c.get("writing_brief") or (c.get("request_payload") or {}).get("writing_brief")) or {})
              for c in writers]
    found = [b for b in briefs if b.get("story_beats")]
    assert found and "This chapter must deliver the story beat “The setup”" in found[0]["story_beats"][0]
    assert any(story_shape.WRITER_RULE in (b.get("rules") or []) for b in found)
    reviews = [c for c in _beats_ctx_of(fake, "review") if c.get("story_beats")]
    assert reviews and reviews[0]["story_beats_note"] == story_shape.REVIEW_NOTE
    # 3. the planned-to-page check lists each beat of the chapter as a required item
    first = chs[0][0]
    items = planned_mod.planned_items(bp, outline, first)
    sb = [i for i in items if i["kind"] == "story_beat"]
    assert [i["beat"] for i in sb] == ["setup", "inciting", "act_one_turn"]
    assert all(i["required"] for i in sb) and sb[0]["label"].startswith("Story beat: The setup — ")
    rows = story_shape.status(bp, outline)
    assert len(rows) == 7 and all(r["written"] for r in rows), rows
    assert all(r["status"] == "on_page" for r in rows), [(r["id"], r["status"], r["how_checked"], r["how"]) for r in rows]
    # 4. the ending check reports the beats
    from akowe import ending_check  # noqa: PLC0415
    res = ending_check.get(app.store, pid, "main")
    assert res and len(res["beats"]) == 7 and "story beats on the page: 7 of 7" in ending_check.summary_line(res)
    # 5. the plan page and the Book Bible show the strip
    status = BookPath(app.engine, "author", pid, "main").status()
    sh = next(s for s in status["steps"] if s["id"] == "outline")["story_shape"]
    assert sh["value"] == "three_acts" and sh["can_change"] is False and sh["by"] == "ai"
    assert sh["beats"][0]["label"] == "Ch 1 · The setup" and sh["beats"][-1]["label"] == f"Ch {n} · After the storm"
    assert all(b["landed"] is True for b in sh["beats"])
    from akowe import binder  # noqa: PLC0415
    page = next(p for p in binder.build(app, pid, "main")["pages"] if p["template"] == "10")
    assert page["story_shape"]["beats"][0]["label"] == "Ch 1 · The setup"
    assert page["story_shape"]["label"] == "Three acts"


def test_a_bad_placement_answer_falls_back_to_positions(tmp_path):
    fake = SlotFake()
    fake.shape_script = [{"placements": [{"beat": "midpoint", "chapter": 1, "how": "too early"},
                                         {"beat": "nope", "chapter": 2, "how": ""}]}]
    app, fake, run = book(tmp_path, fake, body={"choices": {"shape": "seven_point"}})
    bp, outline, chs = chapters(app, run["project_id"])
    m = story_shape.mapping(app.store, run["project_id"], "main", outline)
    assert [b["number"] for b in m["beats"]] == story_shape.by_position("seven_point", len(chs))
    assert m["problems"] and all(b["by"] == "position" for b in m["beats"])
    assert any(e.get("code") == "SHAPE_PLACED" and "placed by their position" in e["message"] for e in run["events"])


def test_a_beat_that_did_not_land_is_sent_back_once(tmp_path):
    fake = SlotFake()
    fake.planned_fix = True
    odd = "Zebulon juggles crimson pineapples beneath quivering gondolas"

    def placements(ctx):
        out = []
        for b in ctx["story_shape"]["beats"]:
            obj = next(c["objective"] for c in ctx["chapters"] if c["chapter"] == b["around_chapter"])
            out.append({"beat": b["beat"], "chapter": b["around_chapter"], "how": odd if b["beat"] == "midpoint"
                        else obj})
        return {"placements": out}
    fake.shape_script = [placements]
    # the planned-to-page step is off, so the checkpoint / ending check are the ones that catch it
    app, fake, run = book(tmp_path, fake, body={"choices": {"shape": "three_acts"},
                                                "pipeline": {"flags": {"planned": False}}})
    pid = run["project_id"]
    bp, outline, chs = chapters(app, pid)
    fixes = [e for e in run["events"] if e.get("code") == "BEAT_FIX"]
    mid = [e for e in fixes if "The middle turn" in e["message"]]
    assert len(mid) == 1  # once, never twice
    assert len(fixes) == len({e["message"] for e in fixes})
    mem = app.autobook.get(run["id"])["beat_fixes"]
    assert mem["midpoint"]["status"] == "done"
    rows = {r["id"]: r for r in story_shape.status(bp, outline)}
    assert rows["midpoint"]["status"] == "on_page"
    cid = rows["midpoint"]["chapter_id"]
    text = next(rec for c, rec in chs if c == cid)["data"]["text"]
    assert "Zebulon juggles crimson pineapples" in text


def test_a_beat_still_missing_is_reported(tmp_path):
    fake = SlotFake()
    fake.planned_fix = False  # the writer does not manage to work it in
    odd = "Zebulon juggles crimson pineapples beneath quivering gondolas"
    fake.shape_script = [lambda ctx: {"placements": [
        {"beat": b["beat"], "chapter": b["around_chapter"], "how": odd if b["beat"] == "climax" else
         "Mara climbs the lighthouse steps"} for b in ctx["story_shape"]["beats"]]}]
    app, fake, run = book(tmp_path, fake, body={"choices": {"shape": "three_acts"}})
    pid = run["project_id"]
    from akowe import checkpoints, ending_check  # noqa: PLC0415
    res = ending_check.get(app.store, pid, "main")
    assert any(o["kind"] == "beat" and "The big showdown" in o["line"] for o in res["open"])
    assert any(e.get("code") == "BEAT_MISSING" and "The big showdown" in e["message"] for e in run["events"])
    rep = checkpoints.report(app.store, pid, "main")
    if rep:  # the final checkpoint lists it too
        assert any("The big showdown" in x for c in rep for x in c.get("beats") or [])
        assert any("story beat" in c["line"] for c in rep)
    # the planned-to-page check already tried its one fix, so no second one was made
    assert not [e for e in run["events"] if e.get("code") == "BEAT_FIX"]


# ====================================================================== without a shape: exactly as before
def test_a_book_without_a_shape_behaves_as_before(tmp_path):
    app, fake, run = book(tmp_path, SlotFake())
    pid = run["project_id"]
    assert "shape" not in fake.prompts
    assert all("story_shape" not in c for _s, c in fake.prompts["B11"])
    assert all("story_beats" not in c for _s, c in fake.prompts.get("scenes") or [])
    assert all("story_beats" not in c for _s, c in fake.prompts.get("review") or [])
    bp, outline, chs = chapters(app, pid)
    assert story_shape.mapping(app.store, pid, "main", outline) is None
    assert story_shape.status(bp, outline) == []
    assert not [i for i in planned_mod.planned_items(bp, outline, chs[0][0]) if i["kind"] == "story_beat"]
    assert not [e for e in run["events"] if str(e.get("code") or "").startswith(("SHAPE", "BEAT"))]
    status = BookPath(app.engine, "author", pid, "main").status()
    sh = next(s for s in status["steps"] if s["id"] == "outline")["story_shape"]  # only the picker (None chosen)
    assert sh == {"value": "", "label": story_shape.NONE_LABEL, "beats": [], "can_change": False}
    assert "beats" not in (__import__("akowe.ending_check", fromlist=["x"]).get(app.store, pid, "main") or {}) or \
        __import__("akowe.ending_check", fromlist=["x"]).get(app.store, pid, "main")["beats"] == []


# ====================================================================== the plan page: change the shape
def test_change_the_shape_on_the_plan_page_only_before_chapters(tmp_path):
    from test_failover_review import make_app  # noqa: PLC0415
    app = make_app(tmp_path, SlotFake(), slots=("AI-1", "AI-2"))
    pid = "proj-shape"
    app.engine.bootstrap_project("author", "Shape book", project_id=pid, settings={}, features={},
                                 release_profiles=["MANUSCRIPT_PDF"]) if not app.store.project(pid) else None
    from akowe.book_path import save_profile  # noqa: PLC0415
    save_profile(app.store, pid, {"title": "Shape book", "idea": "A keeper loses her light.",
                                  "choices": {"ending": "open"}})
    bp = BookPath(app.engine, "author", pid, "main")
    out = bp.act("set_story_shape", {"shape": "heros_journey"})
    assert out["ok"] and out["story_shape"] == "heros_journey"
    ch = get_profile(app.store, pid)["choices"]
    assert ch == {"ending": "open", "shape": "heros_journey"}  # the other choices are kept
    with pytest.raises(AkoweError):
        bp.act("set_story_shape", {"shape": "five_acts"})
    out = bp.act("set_story_shape", {"shape": ""})
    assert "shape" not in get_profile(app.store, pid)["choices"]
    assert "None" in out["message"]


def test_shape_cannot_change_once_a_chapter_is_written(tmp_path):
    app, fake, run = book(tmp_path, SlotFake(), body={"choices": {"shape": "three_acts"}})
    bp = BookPath(app.engine, "author", run["project_id"], "main")
    out = bp.act("set_story_shape", {"shape": "save_the_cat"})
    assert out["ok"] is False and "before the chapters are written" in out["message"]
    assert get_profile(app.store, run["project_id"])["choices"]["shape"] == "three_acts"
