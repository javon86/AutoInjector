"""Smoke test of Section G (Quality at the end) of the stress harness with its quick ✅ / 🟡 cases (never the ❌ ones).

The full run and its report: ``python -m tools.stress.run --section G`` (docs/stress/G-quality-at-the-end.md).
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from tools.stress import core

QUICK = {  # result ID -> the results it may have
    "G-18-g": {core.HANDLED},
    "G-18-j": {core.HANDLED},
    "G-18-m": {core.HANDLED},
    "G-19-g": {core.HANDLED},
    "G-19-l": {core.HANDLED},
    "G-20-j": {core.HANDLED},
    "G-21-j": {core.HANDLED},
    "G-21-n": {core.HANDLED},
    "G-22-h": {core.SAFE},
    "G-22-k": {core.HANDLED},
}


@pytest.fixture(scope="module")
def section_g():
    sec = core.load_section("G")
    yield sec
    core.cleanup_tmp()   # removes the harness's /dev/shm folder: make a fresh one for later modules
    core.TMP_BASE = Path("/dev/shm") / f"stG-{os.getpid()}"
    core.TMP_BASE.mkdir(parents=True, exist_ok=True)


@pytest.mark.parametrize("rid", sorted(QUICK))
def test_section_g_quick_case(section_g, rid):
    _sec, part, letter = rid.split("-")
    o = core.run_one(section_g, section_g.stresses[(part, letter)], seed=0, verbose=False)
    assert o.result in QUICK[rid], (o.result, o.happened, o.issues, o.risks)
    assert not any("key" in i.lower() or "book text" in i for i in o.issues)


def test_section_g_registry(section_g):
    ids = [section_g.rid(s.part, s.letter) for s in section_g.ordered()]
    assert len(ids) == len(set(ids))
    for part in ("18", "19", "20", "21", "22"):
        letters = {s.letter for s in section_g.ordered() if s.part == part}
        assert set("abcdefghij") <= letters and len(letters - set("abcdefghij")) >= 3
