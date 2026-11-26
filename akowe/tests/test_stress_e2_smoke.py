"""Smoke test of the stress harness with Section E (second half: 12.7–12.12 and 13)'s quick ✅ / 🟡 cases (never the
❌ ones).

The full run and its report: ``python -m tools.stress.run --section E2`` (docs/stress/E2-writing-part-2.md).
"""
from __future__ import annotations

import pytest

from tools.stress import core

QUICK = {  # result ID -> the results it may have (✅ HANDLED / 🟡 SAFE STOP)
    "E-12.7-b": {core.HANDLED},
    "E-12.7-g": {core.HANDLED},
    "E-12.7-j": {core.HANDLED},
    "E-12.8-g": {core.HANDLED},
    "E-12.8-j": {core.HANDLED},
    "E-12.9-g": {core.HANDLED},
    "E-12.9-j": {core.HANDLED},
    "E-12.10-b": {core.HANDLED},
    "E-12.10-l": {core.HANDLED},
    "E-12.11-k": {core.HANDLED},
    "E-12.12-g": {core.HANDLED},
    "E-12.12-j": {core.SAFE},
    "E-13-k": {core.HANDLED},
}


@pytest.fixture(scope="module")
def section_e2():
    yield core.load_section("E2")
    core.cleanup_tmp()                                   # the harness's own /dev/shm folder …
    core.TMP_BASE.mkdir(parents=True, exist_ok=True)     # … made again: later smoke modules of this run still use it


def _key(rid: str) -> tuple[str, str]:
    _sec, part, letter = rid.split("-")
    return part, letter


@pytest.mark.parametrize("rid", sorted(QUICK))
def test_section_e2_quick_case(section_e2, rid):
    o = core.run_one(section_e2, section_e2.stresses[_key(rid)], seed=0, verbose=False)
    assert o.result in QUICK[rid], (o.result, o.happened, o.issues, o.risks)
    assert not any("key" in i.lower() or "book text" in i for i in o.issues)
    assert any(n.startswith("Exercised") or "key chapters" in n for n in o.notes) or rid.endswith(("-g", "-b")), o.notes


def test_registry_ids_and_files(section_e2):
    ids = [section_e2.rid(s.part, s.letter) for s in section_e2.ordered()]
    assert ids[0] == "E-12.7-a" and len(ids) == len(set(ids))
    for part in ("12.7", "12.8", "12.9", "12.10", "12.11", "12.12", "13"):
        letters = {s.letter for s in section_e2.ordered() if s.part == part}
        assert set("abcdefghij") <= letters and len(letters - set("abcdefghij")) >= 3, (part, letters)
    assert core._results_path(section_e2).name == "E2-results.json"
    assert core._md_path(section_e2).name == "E2-writing-part-2.md"
    assert core.load_section("E2") is section_e2
