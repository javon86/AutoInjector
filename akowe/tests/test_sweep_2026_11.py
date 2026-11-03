"""Regression tests for the November 2026 all-around sweep of the Akọwe web UI (docs/SWEEP_2026-11_AKOWE.md):
a second press of a job button gets the running job (not a second AI job / second set of pictures); ✍ Write all
chapters and 📊 the book report started twice at the same moment make ONE job; 📚 Start a sequel is refused (and its
button explains why) while the book has no written chapters; a paused Make-a-book run's clock stops."""
from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta, timezone

import pytest

from akowe import autobook as autobook_mod, book_report as report_mod, series
from akowe.book_path import save_profile
from akowe.errors import AkoweError

from autobook_fake import BookFakeAI
from test_autobook import make_app, run_book, steps  # noqa: F401

BR = "main"


@pytest.fixture
def made(tmp_path):
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "short_story", "pictures": False})
    assert run["status"] == "done", run.get("problem")
    return app, fake, run["project_id"]


def rec_of(app, pid, module):
    return next(r for r in app.store.query(
        "SELECT record_id, module_id FROM heads WHERE project_id=? AND branch_id=?", (pid, BR)) if r["module_id"] == module)


def at_once(*fns):
    """Call the functions at the same moment from separate threads -> their results (or exceptions)."""
    out = [None] * len(fns)
    go = threading.Barrier(len(fns))

    def call(i, fn):
        go.wait()
        try:
            out[i] = fn()
        except Exception as exc:  # noqa: BLE001 - the test looks at it
            out[i] = exc
    ts = [threading.Thread(target=call, args=(i, fn)) for i, fn in enumerate(fns)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(30)
    return out


# ====================================================================== a second press gets the running job
def test_a_second_press_while_the_job_runs_gets_that_job_not_a_second_one(made):
    """Double click / second tab on 🖋 Editor review, ✨ Invent the rest, 🖼 Illustrate…: the same AI work was
    started twice (two AI jobs, and for pictures every picture made twice)."""
    app, fake, pid = made
    b03 = rec_of(app, pid, "B03")["record_id"]
    a01 = rec_of(app, pid, "A01")["record_id"]
    fake.gate = threading.Event()
    fake.waiting.clear()
    try:
        j1 = app.review.start_editor("author", pid, BR, {"record_id": b03})
        assert fake.waiting.wait(30)
        j2 = app.review.start_editor("author", pid, BR, {"record_id": b03})
        assert j2["job_id"] == j1["job_id"]
        # a different job (another kind, or the same kind on another record) is its own job
        f1 = app.forge.start_forge("author", pid, BR, a01, {})
        f2 = app.forge.start_forge("author", pid, BR, a01, {})
        assert f2["job_id"] == f1["job_id"] != j1["job_id"]
    finally:
        fake.gate.set()
    for jid in {j1["job_id"], f1["job_id"]}:
        t0 = time.time()
        while app.review.get_job("author", jid)["status"] in ("queued", "running") and time.time() - t0 < 30:
            time.sleep(0.05)
    # finished: the next press starts a new job
    j3 = app.review.start_editor("author", pid, BR, {"record_id": b03})
    assert j3["job_id"] != j1["job_id"]


def test_jobs_with_different_settings_are_not_merged(made):
    app, fake, pid = made
    fake.gate = threading.Event()
    fake.waiting.clear()
    try:
        a = app.review.start_scenes_ai("author", pid, BR, "ch1", {"revise": False})
        assert fake.waiting.wait(30)
        b = app.review.start_scenes_ai("author", pid, BR, "ch1", {"revise": True})
        c = app.review.start_scenes_ai("author", pid, BR, "ch1", {"revise": False})
        assert a["job_id"] != b["job_id"] and c["job_id"] == a["job_id"]
        # ⏹ Stop, then the button again: a new job, not the one that is stopping
        app.review.cancel_job("author", a["job_id"])
        d = app.review.start_scenes_ai("author", pid, BR, "ch1", {"revise": False})
        assert d["job_id"] != a["job_id"]
    finally:
        fake.gate.set()


# ====================================================================== ✍ Write all chapters pressed twice at once
def test_write_all_started_twice_at_once_starts_one_writer(made, monkeypatch):
    app, _fake, pid = made
    hold = threading.Event()
    app.write_all._run = lambda job_id: hold.wait(20)   # the writer stays busy while the second press comes
    slow = autobook_mod.BookPath.outline_chapters

    def slow_chapters(self, *a, **k):
        time.sleep(0.3)  # widen the gap between "is one running?" and "start one"
        return slow(self, *a, **k)
    monkeypatch.setattr(autobook_mod.BookPath, "outline_chapters", slow_chapters)
    try:
        r1, r2 = at_once(lambda: app.write_all.start("author", pid, BR), lambda: app.write_all.start("author", pid, BR))
        assert not isinstance(r1, Exception) and not isinstance(r2, Exception), (r1, r2)
        assert r1["id"] == r2["id"], "two writers were started for the same book"
        assert len([r for r in app.write_all.active() if r["project_id"] == pid]) == 1
    finally:
        hold.set()


# ====================================================================== 📊 the book report pressed twice at once
def test_book_report_started_twice_at_once_makes_one_report(made, monkeypatch):
    app, _fake, pid = made
    hold = threading.Event()
    monkeypatch.setattr(app.reports, "_thread", lambda job, *a: hold.wait(20))
    real_now = report_mod.now_iso

    def slow_now():
        time.sleep(0.3)  # the old code read "is one running?", then built the job, then registered it
        return real_now()
    monkeypatch.setattr(report_mod, "now_iso", slow_now)
    try:
        r1, r2 = at_once(lambda: app.reports.start("author", pid, BR, {"ai": False}),
                         lambda: app.reports.start("author", pid, BR, {"ai": False}))
        errs = [r for r in (r1, r2) if isinstance(r, Exception)]
        assert len(errs) == 1 and isinstance(errs[0], AkoweError) and errs[0].code == "VERSION_CONFLICT", (r1, r2)
        assert len([j for j in app.reports._jobs.values() if j["project_id"] == pid]) == 1  # noqa: SLF001
    finally:
        hold.set()


# ====================================================================== 📚 a sequel needs a written book
def test_a_sequel_of_a_book_without_chapters_is_refused_in_plain_words(made):
    app, _fake, _pid = made
    pid = app.engine.bootstrap_project("author", "Unwritten")
    save_profile(app.store, pid, {"title": "The Unwritten", "author": "Mara Vell", "genre": "Fantasy"})
    st = series.sequel_status(app, pid, BR)
    assert st["possible"] is False and "no written chapters" in st["why"]
    with pytest.raises(AkoweError) as e:
        series.start_sequel(app, "author", pid, BR, {"author_confirms": True})
    assert e.value.code == "MISSING_INPUT" and "finish this book first" in str(e.value)
    assert not app.autobook.active()


def test_a_finished_book_can_still_start_its_sequel(made):
    app, _fake, pid = made
    st = series.sequel_status(app, pid, BR)
    assert st["possible"] is True, st


# ====================================================================== ⏱ a paused run's clock stops
def test_a_paused_run_and_its_paused_step_stop_counting(tmp_path):
    app = make_app(tmp_path, fake=BookFakeAI(verdicts=["REVISE", "REVISE", "REJECT"]))
    run = run_book(app, {"length": "short_story", "pictures": False})
    assert run["status"] == "paused" and not run["alive"]
    raw = app.autobook.get(run["id"])
    t0 = datetime.now(timezone.utc) - timedelta(hours=3)
    iso = lambda t: t.strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731
    raw["started_at"] = iso(t0)
    paused = next(s for s in raw["steps"] if s["state"] == "paused" or s.get("problem"))
    paused["started_at"], paused["finished_at"] = iso(t0 + timedelta(minutes=1)), None
    raw["updated_at"] = iso(t0 + timedelta(minutes=2))      # it stopped two minutes after the start, 3 h ago
    pub = app.autobook.public(raw)
    assert pub["elapsed_ms"] == 120_000
    assert steps(pub)[paused["id"]]["elapsed_ms"] == 60_000
