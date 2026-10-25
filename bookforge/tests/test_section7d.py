"""Section 7 (P27, P28): the 🗂 scene grid of the whole book and ⏱ time and AI use per book / per run, with an
estimate before a run starts. Numbers only: no prompt, reply or book text is stored or logged."""
from __future__ import annotations

import json
import time
import types

import pytest

from bookforge import costs
from bookforge import providers as prov_mod
from bookforge import scene_grid

from test_failover_review import SlotFake, make_app, run_book
from test_server import TOKEN, call, server  # noqa: F401


@pytest.fixture(autouse=True)
def no_provider_sleep(monkeypatch):
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))


@pytest.fixture(scope="module")
def made(tmp_path_factory):
    """One finished Make-a-book run (three AIs, deterministic fake), shared by the read-only tests below."""
    tmp = tmp_path_factory.mktemp("s7d")
    fake = SlotFake()
    app = make_app(tmp, fake)
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    return app, run


# ====================================================================== P28 measuring
def test_record_call_counts_per_ai_and_per_step():
    run = {"current": "chapters"}
    costs.record_call(run, 2.0, "AI-1")
    costs.record_call(run, 3.0, "AI-2", ok=False)
    run["current"] = "report"
    costs.record_call(run, 1.5, "AI-2")
    t = run["timing"]
    assert t["calls"] == 3 and t["call_s"] == 6.5
    assert t["by_ai"]["AI-1"] == {"calls": 1, "s": 2.0, "failed": 0}
    assert t["by_ai"]["AI-2"] == {"calls": 2, "s": 4.5, "failed": 1}
    assert t["by_step"]["chapters"]["calls"] == 2 and t["by_step"]["report"]["calls"] == 1


def test_old_runs_without_per_ai_numbers_still_show():
    old = {"id": "run-x", "status": "done", "started_at": "2026-10-01T10:00:00Z",
           "finished_at": "2026-10-01T10:30:00Z", "timing": {"calls": 12, "call_s": 600.0}, "steps": []}
    rc = costs.run_costs(old)
    assert rc["calls"] == 12 and rc["ai_minutes"] == 10.0 and rc["minutes"] == 30.0 and rc["ai_share"] == 0.33
    assert len(rc["ais"]) == 1 and rc["ais"][0]["slot"] is None and rc["ais"][0]["calls"] == 12
    assert "not recorded" in rc["ais"][0]["name"] and rc["measured"] is False


def test_a_run_measures_calls_and_minutes_per_ai(made):
    app, run = made
    c = run["costs"]
    t = app.autobook.get(run["id"])["timing"]
    assert c["calls"] == t["calls"] > 10 and c["measured"]
    named = {a["slot"]: a for a in c["ais"]}
    assert set(named) <= {"AI-1", "AI-2", "AI-3"} and len(named) >= 2  # writer and an independent reviewer
    assert sum(a["calls"] for a in c["ais"]) == c["calls"]
    assert all(a["name"].startswith(a["slot"]) for a in c["ais"])  # "AI-1 · Claude"
    steps = {s["id"]: s for s in c["steps"]}
    assert steps["chapters"]["calls"] > 0 and steps["profile"]["calls"] >= 1
    assert sum(s["calls"] for s in c["steps"]) <= c["calls"]
    assert c["chapters"]["timed"] >= 1


def test_book_costs_runs_journal_and_no_text(made):
    app, run = made
    pid = run["project_id"]
    c = costs.book_costs(app, pid, "main")
    assert c["totals"]["runs"] == 1 and c["totals"]["calls"] == run["costs"]["calls"]
    assert c["runs"][0]["run_id"] == run["id"]
    assert {a["slot"] for a in c["by_ai"]} == {a["slot"] for a in run["costs"]["ais"]}
    jr = {j["slot"]: j for j in c["journal"]}
    assert jr and all(j["total"] == sum(j["work"].values()) for j in jr.values())
    assert any("wrote" in j["work"] for j in jr.values()) and any("reviewed" in j["work"] for j in jr.values())
    assert c["tokens"] and all(t["cost_minor"] == 0 for t in c["tokens"])  # web AIs cost 0
    # numbers only: no chapter text, prompt or reply in the costs page or its Markdown
    texts = [str((r.get("data") or {}).get("text") or "") for r in app.store.list_records(pid, "main", module_id="C02")]
    blob = json.dumps(c) + costs.render_markdown(c)
    for t in texts:
        for sentence in [x for x in t.split(".") if len(x) > 40][:3]:
            assert sentence.strip() not in blob
    assert "Task:" not in blob and "context." not in blob


def test_estimate_before_a_run(made):
    app, _run = made
    short = costs.estimate(app, {"length": "short_story"})
    novel = costs.estimate(app, {"length": "novel"})
    base = costs.estimate(app, {"length": "novel", "pipeline": {"preset": "baseline"}})
    assert short["basis"] == "measured" and short["runs_measured"] == 1 and short["per_call_s"] > 0
    assert novel["calls"]["expected"] > 5 * short["calls"]["expected"]
    assert novel["chapters"] == 25 and novel["scene_by_scene"]
    assert base["calls"]["expected"] < novel["calls"]["expected"]
    for e in (short, novel, base):
        assert e["calls"]["low"] <= e["calls"]["expected"] <= e["calls"]["high"]
        assert 1 <= e["minutes"]["low"] <= e["minutes"]["expected"] <= e["minutes"]["high"]
        assert sum(r["calls"] for r in e["steps"]) == pytest.approx(e["calls"]["expected"], abs=len(e["steps"]))
    # the measured short-story run is close to the estimate for the same length
    assert abs(short["calls"]["expected"] - _run["costs"]["calls"]) <= max(3, 0.35 * _run["costs"]["calls"])


def test_estimate_first_guess_without_runs(tmp_path):
    app = make_app(tmp_path, SlotFake())
    e = costs.estimate(app, {"length": "novella", "chapters": 10})
    assert e["basis"] == "first_guess" and e["runs_measured"] == 0 and e["per_call_s"] == costs.DEFAULT_CALL_S
    assert e["chapters"] == 10 and all(r["basis"] == "model" for r in e["steps"])
    off = costs.estimate(app, {"length": "novella", "chapters": 10,
                               "pipeline": {"flags": {"editor": False, "scenes": False}}})
    extra = costs.PER_CHAPTER_EXTRA
    assert off["calls"]["expected"] == e["calls"]["expected"] - 10 * (extra["editor"] + extra["scenes"])
    assert costs.estimate(app, {"length": "nonsense"})["length"] == "short_story"


# ====================================================================== P27 scene grid
def test_scene_grid_of_a_made_book(made):
    app, run = made
    g = scene_grid.build(app, "author", run["project_id"], "main")
    assert g["outline"] and g["chapters"] and g["totals"]["chapters"] == len(g["chapters"])
    assert [r["number"] for r in g["chapters"]] == list(range(1, len(g["chapters"]) + 1))
    for r in g["chapters"]:
        assert r["state"] == "approved" and r["words"] > 0 and r["grade"] is not None
        assert r["pov"] and not r["pov"].startswith("char")  # a name, not an id
        assert r["cards"]["planned"] >= 1 and r["cards"]["usable"]
        assert r["scenes"] and all(s["n"] == i + 1 for i, s in enumerate(r["scenes"]))
        planned = [s for s in r["scenes"] if s["planned"]]
        assert planned and all(s["obstacle"] and s["goals"] for s in planned)
        written = [s for s in r["scenes"] if s["written"]]
        codes = {p["code"] for p in r["problems"]}
        if written:  # the page has scene breaks: the scenes' words add up to the chapter
            assert sum(s["words"] for s in written) == pytest.approx(r["words"], abs=5 * len(written))
        else:  # one piece without breaks (the fake writer): the plan is shown, the chapter says why no words
            assert "NO_BREAKS" in codes and r["cards"]["written"] == 1
        for s in r["scenes"]:
            for p in s["problems"]:
                assert p["code"] in scene_grid.PROBLEM_WORDS and p["severity"] in ("major", "minor", "info")
    assert g["povs"] and g["totals"]["scenes"] >= g["totals"]["chapters"]


def _card(**kw):
    c = {"place": "the quay", "time": "dusk", "characters": ["Mara"], "goals": [{"character": "Mara", "goal": "the log"}],
         "obstacle": "the tide", "change": "she loses it", "unsaid": "her debt"}
    c.update(kw)
    return c


def test_scene_rows_match_plan_and_page():
    page = [{"words": 900, "grade": 6.0, "dialogue_share": 0.3, "pace": "steady"},
            {"words": 80, "grade": 4.0, "dialogue_share": 0.0, "pace": "fast"}]
    cards = [_card(obstacle=""), _card(), _card()]
    from bookforge import scenes as scenes_mod
    lint = scenes_mod.lint(cards, ["Mara"])
    checker = {2: {"scene": 2, "goal": True, "obstacle_from_world": False, "unsaid": True, "note": "a random storm"}}
    rows, probs = scene_grid.scene_rows(cards, page, written_any=True, lint=lint, checker=checker, pov="Mara",
                                        place="Harbor")
    codes = [[p["code"] for p in r["problems"]] for r in rows]
    assert [r["words"] for r in rows] == [900, 80, None]
    assert "NO_OBSTACLE" in codes[0] and rows[0]["problems"][0]["severity"] == "major"
    assert "CHECKER_NOTE" in codes[1] and "SHORT_SCENE" in codes[1] and "a random storm" in str(rows[1]["problems"])
    assert codes[2] == ["NOT_ON_PAGE"]
    assert [p["code"] for p in probs] == ["SCENE_COUNT"] and "planned 3, on the page 2" in probs[0]["label"]
    assert rows[0]["place"] == "the quay" and rows[0]["pov"] == "Mara"
    # written in one piece: no words per scene, no "missing" flags, one chapter note
    rows, probs = scene_grid.scene_rows(cards[1:], page[:1], written_any=True, lint=[], checker={}, pov="Mara",
                                        place="Harbor")
    assert [p["code"] for p in probs] == ["NO_BREAKS"] and all(r["words"] is None and not r["problems"] for r in rows)
    # more scenes on the page than planned; nothing planned or written at all
    rows, probs = scene_grid.scene_rows([_card()], page, written_any=True, lint=[], checker={}, pov="", place="")
    assert [p["code"] for p in rows[1]["problems"]] == ["NOT_PLANNED", "SHORT_SCENE"]
    rows, probs = scene_grid.scene_rows([], [], written_any=False, lint=[], checker={}, pov="", place="Harbor")
    assert len(rows) == 1 and rows[0]["place"] == "Harbor" and not probs


def test_scene_grid_flags_an_out_of_date_plan_and_bad_cards(made):
    app, run = made
    pid = run["project_id"]
    from bookforge import scenes as scenes_mod
    from bookforge.book_path import BookPath
    bp = BookPath(app.engine, "author", pid, "main")
    outline = bp.outline()
    cid = bp.outline_chapters(outline)[0]["chapter_id"]
    key = f"scene_cards:{pid}:main"
    saved = app.store.get_setting(key)
    cur = json.loads(json.dumps(saved))
    entry = cur[scenes_mod.ekey(outline["record_id"], cid)]
    entry["cards"][0]["obstacle"] = ""
    entry["outline_version"] = -1
    app.store.set_setting(key, cur)
    try:
        g = scene_grid.build(app, "author", pid, "main")
    finally:
        app.store.set_setting(key, saved)
    ch = g["chapters"][0]
    assert "PLAN_OUT_OF_DATE" in {p["code"] for p in ch["problems"]} and ch["cards"]["usable"] is False
    assert "NO_OBSTACLE" in [p["code"] for p in ch["scenes"][0]["problems"]]
    assert g["totals"]["problems"] >= 2


def test_scene_grid_without_outline_and_csv(tmp_path):
    app = make_app(tmp_path, SlotFake())
    pid = app.create_project("author", {"name": "Empty"})["project_id"]
    g = scene_grid.build(app, "author", pid, "main")
    assert g["outline"] is False and g["chapters"] == [] and g["totals"]["scenes"] == 0
    csv = scene_grid.render_csv({"chapters": [{"number": 1, "problems": [], "scenes": [
        {"n": 1, "pov": "Mara", "place": "=cmd()", "time": "dusk", "goals": [{"character": "Mara", "goal": "-x"}],
         "obstacle": "@tide", "change": "", "words": 10, "grade": 3.0, "dialogue_share": 0.25, "pace": "fast",
         "problems": []}]}]})
    line = csv.splitlines()[1]
    assert "'=cmd()" in line and "'@tide" in line and ",25," in line


# ====================================================================== HTTP API
def test_api_grid_costs_and_estimate(server):  # noqa: F811
    _app, srv = server
    st, pr, _r = call(srv, "POST", "/api/projects", {"name": "API book"})
    assert st == 201
    pid = pr["project_id"]
    st, g, _r = call(srv, "GET", f"/api/projects/{pid}/branches/main/grid")
    assert st == 200 and g["outline"] is False
    st, c, _r = call(srv, "GET", f"/api/projects/{pid}/branches/main/costs")
    assert st == 200 and c["totals"]["runs"] == 0 and c["by_ai"] == []
    st, e, _r = call(srv, "POST", "/api/estimate", {"length": "novelette"})
    assert st == 200 and e["chapters"] == 6 and e["minutes"]["expected"] >= 1
    st, _b, _r = call(srv, "GET", f"/api/projects/{pid}/branches/main/grid?format=pdf")
    assert st == 400
    st, _b, _r = call(srv, "GET", "/api/projects/nope/branches/main/grid")
    assert st in (403, 404)
