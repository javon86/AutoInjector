"""Smoke test of the stress harness (tools/stress) with Section D's quick ✅ / 🟡 cases (never the ❌ ones).

The full Section D run and its report: ``python -m tools.stress.run --section D`` (docs/stress/D-optional.md).
"""
from __future__ import annotations

import pytest

from tools.stress import core

QUICK = {  # result ID -> the results it may have (✅ HANDLED / 🟡 SAFE STOP)
    "D-11-b": {core.HANDLED},
    "D-11-h": {core.SAFE},
    "D-11-k": {core.HANDLED},
    "D-11-n": {core.HANDLED},
    "D-11-p": {core.SAFE},
}


@pytest.fixture(scope="module")
def section_d():
    yield core.load_section("D")
    core.cleanup_tmp()  # the harness's own /dev/shm folder …
    core.TMP_BASE.mkdir(parents=True, exist_ok=True)  # … made again: another stress smoke module may run after this


@pytest.mark.parametrize("rid", sorted(QUICK))
def test_section_d_quick_case(section_d, rid):
    _sec, part, letter = rid.split("-")
    stress = section_d.stresses[(part, letter)]
    o = core.run_one(section_d, stress, seed=0, verbose=False)
    assert o.result in QUICK[rid], (o.result, o.happened, o.issues, o.risks)
    assert not any("key" in i.lower() or "book text" in i for i in o.issues)


def test_registry_has_every_standard_and_five_more(section_d):
    letters = {s.letter for s in section_d.ordered() if s.part == "11"}
    assert set("abcdefghij") <= letters and len(letters - set("abcdefghij")) >= 5
    ids = [section_d.rid(s.part, s.letter) for s in section_d.ordered()]
    assert ids[0] == "D-11-a" and len(ids) == len(set(ids))
