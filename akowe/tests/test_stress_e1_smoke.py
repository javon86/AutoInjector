"""Smoke test of Section E, first half (part 12.1–12.6 of the ⚡ Make-a-book stress test): its quick ✅ / 🟡 cases
(never the ❌ ones).

The full run and its report: ``python -m tools.stress.run --section E1`` (docs/stress/E1-writing-part-1.md).
"""
from __future__ import annotations

import pytest

from tools.stress import core

QUICK = {  # result ID -> the results it may have (✅ HANDLED / 🟡 SAFE STOP)
    "E-12.1-b": {core.HANDLED},
    "E-12.1-k": {core.HANDLED},
    "E-12.2-h": {core.SAFE},
    "E-12.3-j": {core.SAFE},
    "E-12.3-q": {core.HANDLED},
    "E-12.5-p": {core.HANDLED},
    "E-12.6-o": {core.HANDLED},
}


@pytest.fixture(scope="module")
def section_e1():
    sec = core.load_section("E1")
    yield sec
    core.cleanup_tmp()  # the harness's own /dev/shm folder …
    core.TMP_BASE.mkdir(parents=True, exist_ok=True)  # … made again: later smoke modules of this pytest run need it


@pytest.mark.parametrize("rid", sorted(QUICK))
def test_section_e1_quick_case(section_e1, rid):
    _sec, part, letter = rid.split("-")
    stress = section_e1.stresses[(part, letter)]
    o = core.run_one(section_e1, stress, seed=0, verbose=False)
    assert o.result in QUICK[rid], (o.result, o.happened, o.issues, o.risks)
    assert not any("key" in i.lower() or "book text" in i for i in o.issues)


def test_registry_ids_and_own_files(section_e1):
    ids = [section_e1.rid(s.part, s.letter) for s in section_e1.ordered()]
    assert ids[0] == "E-12.1-a" and len(ids) == len(set(ids))
    for part in ("12.1", "12.2", "12.3", "12.4", "12.5", "12.6"):
        letters = {s.letter for s in section_e1.ordered() if s.part == part}
        assert set("abcdefghij") <= letters and len(letters - set("abcdefghij")) >= 3, part
    assert core._results_path(section_e1).name == "E1-results.json"
    assert core._md_path(section_e1).name == "E1-writing-part-1.md"
    assert core.load_section("E1") is section_e1
