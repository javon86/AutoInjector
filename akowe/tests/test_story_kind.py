"""📚 Kind of story (the seven basic plots): the data (all seven, each with stages, a promise and pitfalls), choosing
and validating it, the AI's pick when the author lets the AI decide, the stages placed on chapters (the planner's
answer checked, a fallback by position), what the planners / scene planner / writer / reviewer are told, the
planned-to-page item of each stage, the ending check's promise item, the plan page, the Book Bible and the report,
changing it on the plan page before chapters, and books without a kind (exactly as before)."""
from __future__ import annotations

import pytest

from akowe import planned as planned_mod
from akowe import story_choices, story_kind, story_shape
from akowe.book_path import BookPath, get_profile, save_profile
from akowe.errors import AkoweError

from test_failover_review import SlotFake
from test_world_planned import book, chapters

SEVEN = ("Overcoming the Monster", "Rags to Riches", "The Quest", "Voyage and Return", "Comedy", "Tragedy", "Rebirth")


# ====================================================================== the data
def test_all_seven_kinds_with_stages_promise_and_pitfalls():
    assert len(story_kind.IDS) == 7
    assert [story_kind.label_of(k) for k in story_kind.IDS] == list(SEVEN)
    for kid in story_kind.IDS:
        k = story_kind.kind(kid)
        assert k["about"] and k["promise"] and len(k["pitfalls"]) >= 2
        assert k["ending_question"].startswith("Does the ending deliver ")
        assert 4 <= len(k["stages"]) <= 6
        ats = [s["at"] for s in k["stages"]]
        assert ats == sorted(ats) and ats[0] == 0 and all(0 <= a <= 100 for a in ats)
        assert len({s["id"] for s in k["stages"]}) == len(k["stages"])
        assert all(s["name"] and s["what"] and "_" not in s["name"] for s in k["stages"])
    assert "downfall" in story_kind.kind("tragedy")["promise"] and "flaw" in story_kind.kind("tragedy")["promise"]
    assert "happy union" in story_kind.kind("comedy")["promise"]
    assert "redeemed" in story_kind.kind("rebirth")["promise"]
    assert "defeats" in story_kind.kind("monster")["promise"]
    assert "victory" in story_kind.kind("monster")["ending_question"]
    assert story_kind.kind("nope") is None and story_kind.kind(None) is None
    info = story_kind.info()
    assert info["key"] == "kind" and info["options"][0]["value"] == "" and info["options"][0]["label"] == \
        "Let the AI decide"
    assert [o["value"] for o in info["options"][1:]] == list(story_kind.IDS)
    assert story_choices.field_info()["story_kind"]["key"] == "kind"


def test_clean_choice_and_ai_pick_validation():
    assert story_kind.clean(None) == "" and story_kind.clean("") == "" and story_kind.clean("ai") == ""
    assert story_kind.clean("tragedy") == "tragedy"
    with pytest.raises(AkoweError) as e:
        story_kind.clean("space_opera")
    assert e.value.code == "INVALID_INPUT" and e.value.errors[0]["path"] == "/choices/kind"
    assert story_choices.clean({"kind": "quest", "shape": "three_acts"}) == {"kind": "quest", "shape": "three_acts"}
    assert story_choices.clean({"kind": ""}) == {}
    with pytest.raises(AkoweError):
        story_choices.clean({"kind": "bad"})
    assert "Kind of story: The Quest" in story_choices.summary({"kind": "quest"})
    assert story_choices.brief({"kind": "quest"}) is None and story_choices.rules({"kind": "quest"}) == []
    assert story_kind.clean_ai({}) == {}
    got = story_kind.clean_ai({"kind": "rebirth", "why": "x" * 900})
    assert got["kind"] == "rebirth" and len(got["why"]) <= story_kind.WHY_MAX and got["at"]
    with pytest.raises(AkoweError):
        story_kind.clean_ai({"kind": "nope"})
    # the kind in force: the author's choice, else the AI's pick
    assert story_kind.of_profile({}) == ("", None, "")
    assert story_kind.of_profile({"kind_ai": {"kind": "comedy", "why": "w"}}) == ("comedy", "ai", "w")
    assert story_kind.of_profile({"choices": {"kind": "tragedy"}, "kind_ai": {"kind": "comedy"}})[:2] == \
        ("tragedy", "author")


def test_validate_mapping_spans_and_fallback():
    n = 20
    stages = story_kind.kind("monster")["stages"]
    pos = [story_shape.chapter_for(s["at"], n) for s in stages]  # [1, 4, 8, 13, 17]
    good = [{"beat": s["id"], "chapter": c, "how": f"chapter {c}"} for s, c in zip(stages, pos)]
    out, probs = story_kind.validate("monster", good, n)
    assert probs == [] and [s["number"] for s in out] == pos and all(s["by"] == "ai" for s in out)
    bad = [{"beat": "nightmare", "chapter": 2, "how": "too early"}, {"beat": "nope", "chapter": 3, "how": ""}]
    out, probs = story_kind.validate("monster", bad, n)
    assert [s["number"] for s in out] == pos and all(s["by"] == "position" for s in out)
    assert any("unknown stage" in p for p in probs) and any("The nightmare" in p for p in probs)
    assert story_kind.validate("", good, n) == ([], [])
    story_kind._spans(out, n)  # noqa: SLF001
    assert [(s["number"], s["last"]) for s in out] == [(1, 3), (4, 7), (8, 12), (13, 16), (17, 20)]
    tiny = [dict(s, number=1) for s in story_kind.kind("comedy")["stages"]]
    story_kind._spans(tiny, 2)  # noqa: SLF001
    assert [s["last"] for s in tiny] == [1, 1, 1, 1, 2]
    assert story_kind.strip_label({"name": "X", "number": 3, "last": 5}) == "Ch 3–5 · X"
    assert story_kind.strip_label({"name": "X", "number": 3, "last": 3}) == "Ch 3 · X"


class _Store:
    def __init__(self, prof):
        self.prof = prof

    def get_setting(self, key):
        return self.prof if key.startswith("book_profile:") else None

    def project(self, pid):
        return None


def test_plan_brief():
    assert story_kind.plan_brief(_Store({}), "p", 10) is None
    b = story_kind.plan_brief(_Store({"choices": {"kind": "tragedy"}}), "p", 20)
    assert b["name"] == "Tragedy" and "downfall" in b["promise"] and b["pitfalls"]
    assert [s["stage"] for s in b["stages"]] == [s["id"] for s in story_kind.kind("tragedy")["stages"]]
    assert b["stages"][-1]["around_chapter"] == 18 and b["stages"][0]["where"] == "begins about 0% into the book"
    b = story_kind.plan_brief(_Store({"kind_ai": {"kind": "quest"}}), "p", None)
    assert b["name"] == "The Quest" and "around_chapter" not in b["stages"][0]


# ====================================================================== ⚡ a run with a kind
def _ctx_of(fake, kind):
    return [ctx for _sys, ctx in fake.prompts.get(kind) or []]


def test_make_a_book_with_a_kind_plans_places_tells_and_checks_it(tmp_path):
    fake = SlotFake()
    fake.planned_fix = True
    app, fake, run = book(tmp_path, fake, body={"choices": {"kind": "monster", "shape": "three_acts"}})
    pid = run["project_id"]
    assert get_profile(app.store, pid)["choices"]["kind"] == "monster"
    # 1. the invent step did not ask for a pick (the author chose); the planners got the kind
    assert not any("story_kinds" in c for c in _ctx_of(fake, "profile"))
    for op in ("B01", "B03", "B11"):
        ctxs = _ctx_of(fake, op)
        assert ctxs and ctxs[0]["story_kind"]["name"] == "Overcoming the Monster", op
        assert "defeats" in ctxs[0]["story_kind"]["promise"]
        assert any("kind of story" in sys_ for sys_, _c in fake.prompts[op]), op
    assert "around_chapter" in _ctx_of(fake, "B11")[0]["story_kind"]["stages"][0]
    assert "story_shape" in _ctx_of(fake, "B11")[0]  # both chosen: stages and beats both reach the outline
    # 2. the stages were placed (one call) and stored with the outline, next to the shape's beats
    assert len(fake.prompts.get("kind") or []) == 1 and len(fake.prompts.get("shape") or []) == 1
    bp, outline, chs = chapters(app, pid)
    n = len(chs)
    m = story_kind.mapping(app.store, pid, "main", outline)
    assert m["by"] == "ai" and m["problems"] == [] and len(m["stages"]) == 5
    assert m["stages"][0]["number"] == 1 and m["stages"][-1]["last"] == n
    assert any(e.get("code") == "KIND_PLACED" for e in run["events"])
    # 3. every chapter's scene planner, writer and reviewer was told the stage it serves
    scenes = _ctx_of(fake, "scenes")
    assert scenes and all(c.get("story_stage") for c in scenes)
    writers = _ctx_of(fake, "C02")
    briefs = [((c.get("writing_brief") or (c.get("request_payload") or {}).get("writing_brief")) or {})
              for c in writers]
    found = [b for b in briefs if b.get("story_stage")]
    assert found and found[0]["story_stage"][0].startswith("This chapter serves the stage “The threat and the call”")
    assert "BEGINS the stage" in found[0]["story_stage"][0]
    assert any("the ending must deliver" in x for x in found[0]["story_stage"])
    assert any(story_kind.WRITER_RULE in (b.get("rules") or []) for b in found)
    assert any(b.get("story_beats") for b in found)  # the shape's beats are still there too
    reviews = [c for c in _ctx_of(fake, "review") if c.get("story_stage")]
    assert reviews and reviews[0]["story_stage_note"] == story_kind.REVIEW_NOTE
    # 4. the planned-to-page check: the stage that BEGINS in a chapter is a required item there
    items = planned_mod.planned_items(bp, outline, chs[0][0])
    ss = [i for i in items if i["kind"] == "story_stage"]
    assert [i["stage"] for i in ss] == [s["id"] for s in m["stages"] if s["number"] == 1] and ss[0]["required"]
    assert ss[0]["stage"] == "call"
    assert ss[0]["label"].startswith("Story stage: The threat and the call — ")
    rows = story_kind.status(bp, outline)
    assert len(rows) == 5 and all(r["written"] and r["status"] == "on_page" for r in rows), rows
    # 5. the ending check carried the kind's promise and the stages
    from akowe import ending_check  # noqa: PLC0415
    ends = [c for c in _ctx_of(fake, "ending") if any(p["kind"] == "story_kind" for p in c.get("promises") or [])]
    assert ends and ends[-1]["story_kind"]["name"] == "Overcoming the Monster"
    p = next(p for p in ends[-1]["promises"] if p["kind"] == "story_kind")
    assert p["label"].startswith("Does the ending deliver Overcoming the Monster's victory")
    res = ending_check.get(app.store, pid, "main")
    assert next(i for i in res["items"] if i["kind"] == "story_kind")["status"] == "kept"
    assert len(res["stages"]) == 5
    line = ending_check.summary_line(res)
    assert "the kind of story's promise: kept" in line and "story stages on the page: 5 of 5" in line
    # 6. the plan page, the Book Bible and the report
    status = BookPath(app.engine, "author", pid, "main").status()
    kd = next(s for s in status["steps"] if s["id"] == "outline")["story_kind"]
    assert kd["value"] == "monster" and kd["by"] == "author" and kd["can_change"] is False
    assert kd["stages"][0]["label"].startswith("Ch 1") and all(s["landed"] is True for s in kd["stages"])
    from akowe import binder  # noqa: PLC0415
    page = next(p for p in binder.build(app, pid, "main")["pages"] if p["template"] == "10")
    assert page["story_kind"]["label"] == "Overcoming the Monster" and page["story_shape"]["label"] == "Three acts"
    rep = story_kind.report_info(app.store, pid, "main")
    assert rep["kept"] is True and "Kind of story: Overcoming the Monster — the ending keeps its promise" in \
        rep["line"]


def test_let_the_ai_decide_records_the_ai_pick(tmp_path):
    fake = SlotFake()
    fake.kind_pick = "quest"
    app, fake, run = book(tmp_path, fake)
    pid = run["project_id"]
    prof = get_profile(app.store, pid)
    assert "kind" not in (prof.get("choices") or {})
    assert prof["kind_ai"]["kind"] == "quest" and prof["kind_ai"]["why"]
    asked = _ctx_of(fake, "profile")
    assert asked and [o["id"] for o in asked[0]["story_kinds"]] == list(story_kind.IDS)
    assert any(e.get("code") == "KIND_PICKED" and "The Quest" in e["message"] for e in run["events"])
    assert _ctx_of(fake, "B03")[0]["story_kind"]["name"] == "The Quest"
    kd = next(s for s in BookPath(app.engine, "author", pid, "main").status()["steps"]
              if s["id"] == "outline")["story_kind"]
    assert kd["value"] == "quest" and kd["by"] == "ai" and kd["why"] and kd["chosen"] == ""
    assert "(picked by the AI)" in story_kind.report_info(app.store, pid, "main")["line"]


def test_an_ending_that_breaks_the_promise_is_fixed_once(tmp_path):
    fake = SlotFake()
    seen = []

    def ending(ctx):
        out = {"items": [], "arc": {"kept": True, "note": "", "fix": ""},
               "question": {"kept": True, "note": "", "fix": ""}}
        final = ctx.get("upto") is None
        if final:
            seen.append(ctx)
        for p in ctx.get("promises") or []:
            if p["kind"] == "story_kind" and final and len(seen) == 1:
                out["items"].append({"id": p["id"], "kept": False, "where": "", "note": "Mara survives untouched.",
                                     "fix": "Mara walks into the sea, ruined by her own pride.",
                                     "fix_chapter": ctx["fixable_chapters"][-1]})
            else:
                out["items"].append({"id": p["id"], "kept": True, "where": "", "note": "", "fix": ""})
        return out
    fake.ending_script = [ending] * 8
    app, fake, run = book(tmp_path, fake, body={"choices": {"kind": "tragedy"}, "checkers": "one"})
    assert len(seen) == 2  # checked, fixed once, checked again
    pid = run["project_id"]
    _bp, _outline, chs = chapters(app, pid)
    last = chs[-1][1]["data"]["text"]
    assert "ruined by her own pride" in last  # the ending check's own fix pass worked the promise in
    from akowe import ending_check  # noqa: PLC0415
    res = ending_check.get(app.store, pid, "main")
    assert next(i for i in res["items"] if i["kind"] == "story_kind")["status"] == "kept"
    assert any(e.get("code") == "ENDING_FIX" for e in app.autobook.get(run["id"])["events"])


def test_a_bad_stage_answer_falls_back_to_positions(tmp_path):
    fake = SlotFake()
    fake.kind_script = [{"placements": [{"beat": "union", "chapter": 1, "how": "too early"}]}]
    app, fake, run = book(tmp_path, fake, body={"choices": {"kind": "comedy"}})
    _bp, outline, chs = chapters(app, run["project_id"])
    m = story_kind.mapping(app.store, run["project_id"], "main", outline)
    assert [s["number"] for s in m["stages"]] == [story_shape.chapter_for(s["at"], len(chs))
                                                  for s in story_kind.kind("comedy")["stages"]]
    assert m["problems"] and all(s["by"] == "position" for s in m["stages"])


def test_a_stage_that_did_not_land_is_sent_back_once(tmp_path):
    fake = SlotFake()
    fake.planned_fix = True
    odd = "Zebulon juggles crimson pineapples beneath quivering gondolas"

    def placements(ctx):
        out = []
        for b in ctx["story_kind"]["stages"]:
            obj = next(c["objective"] for c in ctx["chapters"] if c["chapter"] == b["around_chapter"])
            out.append({"beat": b["stage"], "chapter": b["around_chapter"], "how": odd if b["stage"] == "nightmare"
                        else obj})
        return {"placements": out}
    fake.kind_script = [placements]
    # the planned-to-page step is off, so the checkpoint / final check are the ones that catch it
    app, fake, run = book(tmp_path, fake, body={"choices": {"kind": "monster"},
                                                "pipeline": {"flags": {"planned": False}}})
    pid = run["project_id"]
    bp, outline, chs = chapters(app, pid)
    fixes = [e for e in run["events"] if e.get("code") == "STAGE_FIX"]
    assert len([e for e in fixes if "The nightmare" in e["message"]]) == 1  # once, never twice
    assert app.autobook.get(run["id"])["stage_fixes"]["nightmare"]["status"] == "done"
    rows = {r["id"]: r for r in story_kind.status(bp, outline)}
    assert rows["nightmare"]["status"] == "on_page"
    text = next(rec for c, rec in chs if c == rows["nightmare"]["chapter_id"])["data"]["text"]
    assert "Zebulon juggles crimson pineapples" in text


# ====================================================================== without a kind: exactly as before
def test_a_book_without_a_kind_behaves_as_before(tmp_path):
    app, fake, run = book(tmp_path, SlotFake())  # the fake AI picks nothing
    pid = run["project_id"]
    assert "kind_ai" not in get_profile(app.store, pid)
    assert "kind" not in fake.prompts
    for op in ("B01", "B03", "B11", "scenes", "review", "ending"):
        assert all("story_kind" not in c and "story_stage" not in c for _s, c in fake.prompts.get(op) or []), op
    bp, outline, chs = chapters(app, pid)
    assert story_kind.mapping(app.store, pid, "main", outline) is None and story_kind.status(bp, outline) == []
    assert not [i for i in planned_mod.planned_items(bp, outline, chs[0][0]) if i["kind"] == "story_stage"]
    assert not [e for e in run["events"] if str(e.get("code") or "").startswith(("KIND", "STAGE"))]
    kd = next(s for s in BookPath(app.engine, "author", pid, "main").status()["steps"]
              if s["id"] == "outline")["story_kind"]
    assert kd["value"] == "" and kd["stages"] == [] and kd["can_change"] is False
    assert story_kind.report_info(app.store, pid, "main") is None


# ====================================================================== the plan page: change the kind
def test_change_the_kind_on_the_plan_page_only_before_chapters(tmp_path):
    from test_failover_review import make_app  # noqa: PLC0415
    app = make_app(tmp_path, SlotFake(), slots=("AI-1", "AI-2"))
    pid = "proj-kind"
    app.engine.bootstrap_project("author", "Kind book", project_id=pid, settings={}, features={},
                                 release_profiles=["MANUSCRIPT_PDF"])
    save_profile(app.store, pid, {"title": "Kind book", "idea": "A keeper loses her light.",
                                  "choices": {"ending": "open"}})
    bp = BookPath(app.engine, "author", pid, "main")
    out = bp.act("set_story_kind", {"kind": "rebirth"})
    assert out["ok"] and out["story_kind"] == "rebirth" and "Rebirth" in out["message"]
    assert get_profile(app.store, pid)["choices"] == {"ending": "open", "kind": "rebirth"}
    with pytest.raises(AkoweError):
        bp.act("set_story_kind", {"kind": "western"})
    save_profile(app.store, pid, {"kind_ai": {"kind": "comedy", "why": "funny"}})
    out = bp.act("set_story_kind", {"kind": ""})
    assert "kind" not in get_profile(app.store, pid)["choices"]
    assert "Comedy (picked by the AI)" in out["message"]  # the AI's earlier pick stays in force


def test_kind_cannot_change_once_a_chapter_is_written(tmp_path):
    app, fake, run = book(tmp_path, SlotFake(), body={"choices": {"kind": "quest"}})
    bp = BookPath(app.engine, "author", run["project_id"], "main")
    out = bp.act("set_story_kind", {"kind": "tragedy"})
    assert out["ok"] is False and "before the chapters are written" in out["message"]
    assert get_profile(app.store, run["project_id"])["choices"]["kind"] == "quest"
