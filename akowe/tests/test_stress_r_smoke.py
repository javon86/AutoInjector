"""Smoke test of the stress harness's Section R (the real-world run) with its quick ✅ / 🟡 cases (never ❌ / ⚠️).

The full Section R run and its report: ``python -m tools.stress.run --section R`` (docs/stress/R-real-world-run.md).
"""
from __future__ import annotations

import pytest

from tools.stress import core

QUICK = {  # result ID -> the results it may have (✅ HANDLED / 🟡 SAFE STOP)
    "R-2-a": {core.HANDLED},   # a late reviewer answer inside the late window is used
    "R-2-c": {core.HANDLED},   # a late chapter inside the late window is used
    "R-3-a": {core.SAFE},      # no AI can review: a safe stop, Try again finishes
    "R-3-b": {core.SAFE},      # no AI can write: a safe stop, Try again finishes
    "R-5-b": {core.HANDLED},   # a typed pen name: no placeholder author anywhere
    "R-7-a": {core.HANDLED},   # valid exact cuts are kept
    "R-9-b": {core.HANDLED},   # matching planned-detail fixes put everything on the page
    "R-10-a": {core.HANDLED},  # Claude's pane broken all run: the work moves, no stop
}


@pytest.fixture(scope="module")
def section_r():
    yield core.load_section("R")
    core.cleanup_tmp()  # the harness's own /dev/shm folder


@pytest.mark.parametrize("rid", sorted(QUICK))
def test_section_r_quick_case(section_r, rid):
    _sec, part, letter = rid.split("-")
    o = core.run_one(section_r, section_r.stresses[(part, letter)], seed=0, verbose=False)
    assert o.result in QUICK[rid], (o.result, o.happened, o.issues, o.risks)
    assert not any("key" in i.lower() or "book text" in i for i in o.issues)


def test_clock_bridge_counts_a_real_timeout_and_its_late_window(section_r):
    from tools.stress import section_r as R  # noqa: PLC0415
    with core.Harness("R-0-z", "R", "0", "z", "clock", time_limit=120) as h:
        b = R.real_app(h)
        h.chaos.add(core.Rule(core.timeout(), kinds="review", slots="AI-2", times=1))
        res = R.author_loop(h)
        assert res["status"] == "done" and not res["hang"]
        assert b.outcomes("TIMEOUT") == 1 and b.outcomes("LATE_EXPIRED") == 1
        assert b.clock > 15 * 60   # the whole timeout Akọwe asked for + the late window + the 60 s wait


def test_generated_chapter_sentences_are_distinct():
    from tools.stress import section_r as R  # noqa: PLC0415
    a, b = R.gen_chapter(1, 1500), R.gen_chapter(3, 1500)
    sa = {s for p in a.split("\n\n") for s in p.split(". ")}
    sb = {s for p in b.split("\n\n") for s in p.split(". ")}
    assert len(a.split()) >= 1500 and not (sa & sb)
