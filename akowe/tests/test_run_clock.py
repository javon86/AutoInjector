"""⏳ run_clock.py — the always-visible progress strip's numbers: the start estimate kept on the run, the working clock
(the author's waiting time never counts), the time left corrected by the run's own speed over ALL the steps (incl. the
end steps: chapter 1 last, the weakest scenes / improve pass, the final reads, beta readers, the story doctor, the
chapter polish), the finish time, the run status API / status push fields and what the next estimate learns."""
from __future__ import annotations

import logging
import time
import types

import pytest

from akowe import run_clock, run_forecast, status_push, usage_limits, usage_meter
from akowe import providers as prov_mod

from test_failover_review import SlotFake, make_app, run_book

T0 = 1_800_000_000.0  # a fixed "now" for the math tests


def iso(t):
    return run_clock._iso(t)  # noqa: SLF001


def _run(states, est, current=None, chapters=None, settings=None):
    """A run with these step states and this kept estimate (seconds per step)."""
    steps = [{"id": sid, "title": sid, "state": st, "items": []} for sid, st in states]
    for s in steps:
        if s["id"] == "chapters" and chapters:
            s["items"] = [{"id": str(i + 1), "state": c} for i, c in enumerate(chapters)]
    return {"id": "run-t", "status": "running", "current": current, "started_at": iso(T0), "steps": steps,
            "settings": dict({"improve_pass": True, "opening_pass": True, "beta_reader": True}, **(settings or {})),
            "forecast": {"total_s": sum(est.values()), "steps": dict(est), "chapters": len(chapters or [])}}


# ====================================================================== the clock
def test_waiting_for_the_author_is_not_counted():
    run = {"started_at": iso(T0), "updated_at": iso(T0)}
    run_clock.clock_start(run, T0)
    run_clock.clock_stop(run, T0 + 600)            # 10 min of work, then paused for a decision
    assert run["clock"]["stopped_at"] == iso(T0 + 600)
    assert run_clock.active_s(run, alive=False, now=T0 + 4 * 3600) == 600   # 4 h later: still 10 min
    run_clock.clock_start(run, T0 + 4 * 3600)      # the author answered
    assert run_clock.active_s(run, alive=True, now=T0 + 4 * 3600 + 300) == 900


def test_a_crash_counts_up_to_the_last_save_only():
    run = {"started_at": iso(T0), "updated_at": iso(T0 + 200)}
    run_clock.clock_start(run, T0)
    # Akọwe closed at its last save (+200 s): not alive -> the clock reads up to the save, not to now
    assert run_clock.active_s(run, alive=False, now=T0 + 9000) == 200
    run_clock.clock_start(run, T0 + 9000)          # resumed: the 200 s are kept
    assert run_clock.active_s(run, alive=True, now=T0 + 9100) == 300


def test_steps_measure_their_own_working_time():
    run = {"started_at": iso(T0)}
    run_clock.clock_start(run, T0)
    st = {"id": "premise"}
    run_clock.step_start(run, st, T0 + 100)
    run_clock.step_done(run, st, T0 + 160)
    assert st["clock0"] == 100 and st["active_s"] == 60


# ====================================================================== the estimate math
EST = {"backup": 10, "profile": 100, "premise": 100, "outline": 400, "chapters": 2000, "report": 200,
       "beta": 100, "opening": 300, "improve": 500, "reread": 200}
ORDER = list(EST)


def test_time_left_covers_every_step_including_the_end_steps():
    run = _run([(s, "done" if s in ("backup", "profile") else "running" if s == "premise" else "pending")
                for s in ORDER], EST, current="premise")
    run["clock"] = {"active_s": 0, "since": iso(T0)}
    run["steps"][0].update(active_s=10, clock0=0)
    run["steps"][1].update(active_s=100, clock0=10)
    run["steps"][2]["clock0"] = 110
    p = run_clock.progress(run, True, "working", now=T0 + 140)   # 30 s into the premise
    # the run went exactly as estimated: left = 70 s of premise + every later step (the end steps too)
    later = sum(EST[s] for s in ORDER[3:])
    assert p["left_s"] == 70 + later and p["speed_ratio"] == 1.0
    assert p["total_estimate_s"] == sum(EST.values()) and p["elapsed_active_s"] == 140
    assert p["step_index"] == 3 and p["step_total"] == len(ORDER) and p["step_label"] == "Writing the premise"
    assert p["finish_at"] == iso(T0 + 140 + p["left_s"]) and 0 < p["percent"] < 10 and p["waiting_since"] is None
    # an end step switched off is not counted, and not a step of the run ("Step 3 of 9")
    run["settings"]["improve_pass"] = False
    q = run_clock.progress(run, True, "working", now=T0 + 140)
    assert q["left_s"] == p["left_s"] - EST["improve"] and q["step_total"] == len(ORDER) - 1


def test_a_slow_run_is_corrected_and_clamped():
    run = _run([(s, "done" if i < 4 else "running" if i == 4 else "pending") for i, s in enumerate(ORDER)], EST,
               current="chapters", chapters=["pending"] * 4)
    done = ORDER[:4]
    t = 0
    for s in run["steps"][:4]:   # each finished step took 1.5× its estimate
        s.update(clock0=t, active_s=EST[s["id"]] * 1.5)
        t += s["active_s"]
    run["steps"][4]["clock0"] = t
    run["clock"] = {"active_s": t, "since": None}
    plan = run["forecast"]
    w = min(1.0, sum(EST[s] for s in done) / (run_clock.TRUST_SHARE * plan["total_s"]))
    assert run_clock.ratio_of(run, plan) == pytest.approx(1 + w * 0.5)
    p = run_clock.progress(run, True, "working", now=T0)
    plain = sum(EST[s] for s in ORDER[4:])
    assert p["left_s"] > plain and p["speed_ratio"] > 1
    # 10× slower is clamped to 2×; 10× faster to 0.5×
    for s in run["steps"][:4]:
        s["active_s"] = EST[s["id"]] * 10
    assert run_clock.ratio_of(run, plan) <= 2.0
    for s in run["steps"][:4]:
        s["active_s"] = EST[s["id"]] / 10
    assert run_clock.ratio_of(run, plan) >= 0.5
    # too little measured work says nothing: 1.0
    tiny = _run([("backup", "done"), ("chapters", "pending")], {"backup": 10, "chapters": 1000})
    tiny["steps"][0]["active_s"] = 500
    assert run_clock.ratio_of(tiny, tiny["forecast"]) == 1.0


def test_measured_chapters_are_used_for_the_chapters_left():
    run = _run([("backup", "done"), ("chapters", "running"), ("report", "pending")],
               {"backup": 10, "chapters": 1000, "report": 100}, current="chapters",
               chapters=["done", "done", "running", "pending"])
    run["steps"][0].update(active_s=10, clock0=0)
    run["steps"][1]["clock0"] = 10
    run["timing"] = {"chapter_s": [400.0, 400.0]}   # 250 s estimated per chapter, 400 s measured
    run["clock"] = {"active_s": 810, "since": None}
    p = run_clock.progress(run, False, "paused", now=T0)
    assert p["step_label"] == "Writing chapter 3 of 4"
    ratio = run_clock.ratio_of(run, run["forecast"])
    assert ratio > 1
    assert p["left_s"] == round(2 * 400 + 100 * ratio)
    # waiting for the author: no finish time, the clock is paused since it stopped
    assert p["finish_at"] is None and p["waiting_since"] == run.get("updated_at")
    run["clock"]["stopped_at"] = iso(T0 - 60)
    assert run_clock.progress(run, False, "needs_decision", now=T0)["waiting_since"] == iso(T0 - 60)


def test_a_finished_run_says_its_real_time_and_the_estimate():
    run = _run([("backup", "done"), ("chapters", "done")], {"backup": 10, "chapters": 1000})
    run["clock"] = {"active_s": 0, "since": iso(T0)}
    run_clock.finish(run, T0 + 1500)
    assert run["forecast"]["actual_s"] == 1500 and run["clock"]["since"] is None
    p = run_clock.progress(run, False, "done", now=T0 + 9999)
    assert p["percent"] == 100 and p["left_s"] == 0 and p["actual_s"] == 1500 and p["total_estimate_s"] == 1010


def test_no_estimate_falls_back_to_the_measured_chapters():
    run = _run([("chapters", "running")], {}, current="chapters", chapters=["done", "running"])
    run["forecast"] = None
    run["eta"] = {"seconds_left": 321}
    p = run_clock.progress(run, True, "working", now=T0)
    assert p["left_s"] == 321 and p["total_estimate_s"] is None


def test_plan_maps_every_option_onto_its_step():
    est = {"per_call_s": 10.0, "overhead": 1.0, "minutes": {"expected": 0}, "chapters": 5, "wait_minutes": 0,
           "options": {"pictures": False},
           "steps": [{"step": "outline", "calls": 3}, {"step": "chapters", "calls": 20},
                     {"step": "option:improve", "calls": 6}, {"step": "option:opening", "calls": 3},
                     {"step": "option:reread", "calls": 2}, {"step": "option:beta", "calls": 1},
                     {"step": "option:story_doctor", "calls": 4}, {"step": "option:chapter_polish", "calls": 2},
                     {"step": "option:first_page", "calls": 2}, {"step": "option:helpers", "calls": 9}]}
    p = run_clock.plan_of(est)
    s = p["steps"]
    assert s["improve"] == 60 and s["opening"] == 30 and s["reread"] == 20 and s["beta"] == 10
    assert s["outline"] == 70 and s["chapters"] == 240 and "helpers" not in s
    assert s["export"] == run_clock.FIXED_S["export"] and p["total_s"] == sum(s.values())
    # with an expected total, every step is scaled to it (the strip's total = what the plan said)
    est["minutes"]["expected"] = 20
    assert run_clock.plan_of(est)["total_s"] == 1200


# ====================================================================== learning from finished runs
@pytest.fixture(autouse=True)
def fresh_meter(monkeypatch):
    usage_meter.reset_for_tests()
    usage_limits.clear()
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))
    yield
    usage_meter.reset_for_tests()


@pytest.fixture
def app(tmp_path):
    a = make_app(tmp_path, SlotFake())
    yield a
    a.store.close()


def test_the_next_estimate_learns_from_finished_runs(app):
    body = {"length": "short_story", "chapters": 3}
    before = run_forecast.estimate(app, body)
    assert before["learned"] == {"ratio": 1.0, "runs": 0}
    for i, (raw, act) in enumerate([(3600, 5400), (3600, 5000), (100, 900)]):   # the last one is too short to teach
        app.jobstore.save({"id": f"run-l{i}", "kind": "autobook", "status": "done", "principal": "author",
                           "started_at": "2026-11-01T10:00:00Z", "settings": {},
                           "forecast": {"raw_total_s": raw, "total_s": raw, "actual_s": act}})
    learned = run_clock.learned_ratio(app)
    assert learned["runs"] == 2 and learned["ratio"] == pytest.approx(1.44, abs=0.01)
    after = run_forecast.estimate(app, body)
    assert after["learned"]["runs"] == 2 and after["minutes"]["expected"] > before["minutes"]["expected"]
    assert "Corrected by your last 2 finished run(s)" in after["about"]
    # far off is clamped
    app.jobstore.save({"id": "run-lx", "kind": "autobook", "status": "done", "principal": "author",
                       "started_at": "2026-11-02T10:00:00Z", "settings": {},
                       "forecast": {"raw_total_s": 1000, "actual_s": 90000}})
    app.jobstore.save({"id": "run-ly", "kind": "autobook", "status": "done", "principal": "author",
                       "started_at": "2026-11-02T10:00:00Z", "settings": {},
                       "forecast": {"raw_total_s": 1000, "actual_s": 90000}})
    assert run_clock.learned_ratio(app)["ratio"] <= run_clock.LEARN_MAX


# ====================================================================== a real (fake-AI) run, the API, the push
def test_a_run_keeps_its_estimate_and_reports_progress_everywhere(app, caplog):
    caplog.set_level(logging.INFO)
    run = run_book(app, {"length": "short_story", "beta_reader": True})
    assert run["status"] == "done"
    fc = app.autobook.get(run["id"])["forecast"]
    assert fc["total_s"] > 0 and fc["actual_s"] >= 0
    # every step that does AI work has its share, the end steps included
    for sid in ("chapters", "outline", "opening", "improve", "reread", "beta", "report"):
        assert fc["steps"].get(sid, 0) > 0, sid
    # the steps measured their own working time
    stored = app.autobook.get(run["id"])
    assert all(s.get("active_s") is not None for s in stored["steps"] if s.get("clock0") is not None)
    assert stored["clock"]["since"] is None
    # the run status API: the new fields, r.eta kept
    out = app.route("GET", f"/api/autobook/{run['id']}", {}, None, "author", {})[1]
    for k in ("total_estimate_s", "elapsed_active_s", "left_s", "finish_at", "percent", "step_index", "step_total",
              "step_label", "waiting_since", "actual_s"):
        assert k in out, k
    assert out["percent"] == 100 and out["left_s"] == 0 and out["total_estimate_s"] == fc["total_s"]
    assert "eta" in out
    lst = app.route("GET", "/api/autobook", {}, None, "author", {})[1]
    assert lst["current"]["total_estimate_s"] == fc["total_s"]
    # AutoInjector's status push carries them, with a link that opens the run window
    app.last_project = lambda: {"project_id": run["project_id"], "branch_id": "main"}
    body = status_push.build_summary(app, "http://127.0.0.1:1/")
    r = body["run"]
    assert r["total_estimate_s"] == fc["total_s"] and r["percent"] == 100 and r["run_url"].endswith(f"#/run/{run['id']}")
    assert r["started_at"] and r["step_total"]
    # logs: numbers and codes only — never the book's title
    title = run.get("title") or ""
    text = "\n".join(rec.getMessage() for rec in caplog.records if rec.name == "akowe.run_clock")
    assert "estimate kept" in text and (not title or title not in text)


def test_a_paused_run_says_it_waits_for_the_author(app):
    run = run_book(app, {"length": "short_story"})
    stored = app.autobook.get(run["id"])
    stored.update(status="paused", pause_reason="author", finished_at=None)
    stored["clock"]["stopped_at"] = "2026-11-12T09:33:00Z"
    stored["steps"][-1]["state"] = "paused"
    out = app.autobook.public(stored)
    assert out["state"] == "paused" and out["waiting_since"] == "2026-11-12T09:33:00Z" and out["finish_at"] is None
    assert out["left_s"] is not None and out["percent"] < 100
