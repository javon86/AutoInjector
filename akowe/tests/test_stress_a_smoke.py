"""Smoke test of the stress harness (tools/stress) with Section A's quick ✅ / 🟡 cases (never the ❌ ones).

The full Section A run and its report: ``python -m tools.stress.run --section A`` (docs/stress/A-getting-started.md).
"""
from __future__ import annotations

import pytest

from tools.stress import core

QUICK = {  # result ID -> the results it may have (✅ HANDLED / 🟡 SAFE STOP)
    "A-1-b": {core.HANDLED},
    "A-1-h": {core.SAFE},
    "A-1-o": {core.HANDLED},
    "A-1-p": {core.HANDLED},
    "A-2-b": {core.HANDLED},
    "A-2-c": {core.HANDLED},
    "A-2-h": {core.SAFE},
    "A-2-i": {core.SAFE},
    "A-2-j": {core.HANDLED},
    "A-2-k": {core.HANDLED},
}


@pytest.fixture(scope="module")
def section_a():
    yield core.load_section("A")
    core.cleanup_tmp()  # the harness's own /dev/shm folder


@pytest.mark.parametrize("rid", sorted(QUICK))
def test_section_a_quick_case(section_a, rid):
    _sec, part, letter = rid.split("-")
    stress = section_a.stresses[(part, letter)]
    o = core.run_one(section_a, stress, seed=0, verbose=False)
    assert o.result in QUICK[rid], (o.result, o.happened, o.issues, o.risks)
    assert not any("key" in i.lower() or "book text" in i for i in o.issues)


def test_registry_ids_and_report_render(section_a):
    ids = [section_a.rid(s.part, s.letter) for s in section_a.ordered()]
    assert ids[0] == "A-1-a" and len(ids) == len(set(ids))
    for part in ("1", "2"):
        letters = {s.letter for s in section_a.ordered() if s.part == part}
        assert set("abcdefghij") <= letters and len(letters - set("abcdefghij")) >= 3
    o = core.Outcome(id="A-2-z", section="A", part="2", stress="z", title="t", result=core.PROBLEM,
                     happened="The Keeper of Gullhaven", issues=["x"])
    md = core.render_markdown(section_a, [dict(core.asdict(o), happened=core.scrub(o.happened))])
    assert "Gullhaven" not in md and "A-2-z" in md and "## All findings in this section" in md


def test_chaos_rules_match_by_kind_step_call_slot_and_probability():
    import random  # noqa: PLC0415
    c = core.Call(n=3, kind="profile", slot="AI-1", step="profile", ctx={}, props=[])
    rng = random.Random(1)
    assert core.Rule(core.busy(), kinds="profile", step="profile", calls={3}, slots="AI-1").matches(c, rng)
    assert not core.Rule(core.busy(), kinds="canon").matches(c, rng)
    assert not core.Rule(core.busy(), slots="AI-2").matches(c, rng)
    once = core.Rule(core.busy(), times=1)
    assert once.matches(c, rng)
    once.fired = 1
    assert not once.matches(c, rng)
    assert not core.Rule(core.busy(), skip=1).matches(c, rng)
    hits = sum(core.Rule(core.busy(), prob=0.5).matches(c, rng) for _ in range(200))
    assert 60 < hits < 140
