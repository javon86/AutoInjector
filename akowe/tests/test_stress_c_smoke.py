"""Smoke test of Section C (planning the story) of the stress harness with its quick ✅ / 🟡 cases (never the ❌ ones).

The full Section C run and its report: ``python -m tools.stress.run --section C`` (docs/stress/C-planning-the-story.md).
"""
from __future__ import annotations

import pytest

from tools.stress import core

QUICK = {  # result ID -> the results it may have (✅ HANDLED / 🟡 SAFE STOP)
    "C-8-b": {core.HANDLED},
    "C-8-h": {core.SAFE},
    "C-8-k": {core.HANDLED},
    "C-9-m": {core.HANDLED},
    "C-10-b": {core.HANDLED},
    "C-10.1-j": {core.HANDLED},
    "C-10.2-k": {core.HANDLED},
    "C-10.3-j": {core.HANDLED},
    "C-10.4-k": {core.HANDLED},
    "C-10.5-k": {core.HANDLED},
    "C-10.6-b": {core.HANDLED},
}


@pytest.fixture(scope="module")
def section_c():
    sec = core.load_section("C")
    core.TMP_BASE.mkdir(parents=True, exist_ok=True)  # another section's cleanup may have removed it
    yield sec
    core.cleanup_tmp()  # the harness's own /dev/shm folder


@pytest.mark.parametrize("rid", sorted(QUICK))
def test_section_c_quick_case(section_c, rid):
    _sec, part, letter = rid.split("-")
    core.TMP_BASE.mkdir(parents=True, exist_ok=True)
    stress = section_c.stresses[(part, letter)]
    o = core.run_one(section_c, stress, seed=0, verbose=False)
    assert o.result in QUICK[rid], (o.result, o.happened, o.issues, o.risks)
    assert not any("key" in i.lower() or "book text" in i for i in o.issues)


def test_registry_has_every_part_and_enough_stresses(section_c):
    ids = [section_c.rid(s.part, s.letter) for s in section_c.ordered()]
    assert ids[0] == "C-8-a" and len(ids) == len(set(ids))
    for part in ("8", "9", "10", "10.1", "10.2", "10.3", "10.4", "10.5", "10.6"):
        letters = {s.letter for s in section_c.ordered() if s.part == part}
        assert set("abcdefghij") <= letters and len(letters - set("abcdefghij")) >= 3, part


def test_make_app_patch_is_restored(section_c):
    assert core.Harness.make_app is section_c_orig()


def section_c_orig():
    from tools.stress import section_c  # noqa: PLC0415
    return section_c._ORIG_MAKE  # noqa: SLF001
