"""Smoke test of the stress harness with Section F's quick ✅ / 🟡 cases (never the ❌ ones).

The full Section F run and its report: ``python -m tools.stress.run --section F``
(docs/stress/F-putting-the-book-together.md).
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from tools.stress import core

QUICK = {  # result ID -> the results it may have (✅ HANDLED / 🟡 SAFE STOP)
    "F-14-b": {core.HANDLED},
    "F-14-h": {core.SAFE},
    "F-14-l": {core.HANDLED},
    "F-15-b": {core.HANDLED},
    "F-15-h": {core.SAFE},
    "F-16-h": {core.SAFE},
    "F-17-b": {core.HANDLED},
    "F-17-h": {core.SAFE},
}


@pytest.fixture(scope="module")
def section_f():
    sec = core.load_section("F")        # moves core.TMP_BASE to /dev/shm/stF-<pid>
    core.TMP_BASE.mkdir(parents=True, exist_ok=True)
    yield sec
    core.cleanup_tmp()                  # the harness's own /dev/shm folder


@pytest.fixture(autouse=True)
def _tmp_base(section_f):
    core.TMP_BASE.mkdir(parents=True, exist_ok=True)  # another module's cleanup_tmp() may have removed it
    yield


@pytest.mark.parametrize("rid", sorted(QUICK))
def test_section_f_quick_case(section_f, rid):
    _sec, part, letter = rid.split("-")
    stress = section_f.stresses[(part, letter)]
    o = core.run_one(section_f, stress, seed=0, verbose=False)
    assert o.result in QUICK[rid], (o.result, o.happened, o.issues, o.risks)
    assert not any("key" in i.lower() or "book text" in i for i in o.issues)


def test_registry_covers_every_part_with_standard_and_extra_stresses(section_f):
    ids = [section_f.rid(s.part, s.letter) for s in section_f.ordered()]
    assert ids[0] == "F-14-a" and len(ids) == len(set(ids))
    for part in ("14", "15", "16", "17"):
        letters = {s.letter for s in section_f.ordered() if s.part == part}
        assert set("abcdefghij") <= letters and len(letters - set("abcdefghij")) >= 3
    # the harness works in its own per-process /dev/shm folder (stF-<pid>, or another section's st*-<pid> when that
    # section's module was imported first in the same pytest run: core.TMP_BASE is one module global)
    base = core.TMP_BASE
    assert base.parent == Path("/dev/shm") and base.name.startswith("st") and base.name.endswith(f"-{os.getpid()}")
