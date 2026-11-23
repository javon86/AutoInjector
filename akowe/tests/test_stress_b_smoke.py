"""Smoke test of Section B's stress scenarios (characters and world) — the quick ✅ / 🟡 cases only (never the ❌ ones).

The full Section B run and its report: ``python -m tools.stress.run --section B``
(docs/stress/B-characters-and-world.md).
"""
from __future__ import annotations

import atexit
import shutil

import pytest

from tools.stress import core

QUICK = {  # result ID -> the results it may have (✅ HANDLED / 🟡 SAFE STOP)
    "B-3-b": {core.HANDLED},
    "B-3-n": {core.HANDLED},
    "B-4-k": {core.HANDLED},
    "B-5-a": {core.HANDLED},
    "B-5-c": {core.HANDLED},
    "B-6-b": {core.HANDLED},
    "B-6-h": {core.SAFE},
    "B-6-k": {core.HANDLED},
    "B-7-j": {core.HANDLED},
    "B-7-m": {core.SAFE},
}


@pytest.fixture(scope="module")
def section_b():
    core.TMP_BASE.mkdir(parents=True, exist_ok=True)  # an earlier module may have cleaned it up
    yield core.load_section("B")
    core.cleanup_tmp()  # the harness's own /dev/shm folder
    # a later stress module in the same session still needs the folder; it is removed when the session ends
    core.TMP_BASE.mkdir(parents=True, exist_ok=True)
    atexit.register(shutil.rmtree, core.TMP_BASE, True)


@pytest.mark.parametrize("rid", sorted(QUICK))
def test_section_b_quick_case(section_b, rid):
    _sec, part, letter = rid.split("-")
    stress = section_b.stresses[(part, letter)]
    o = core.run_one(section_b, stress, seed=0, verbose=False)
    assert o.result in QUICK[rid], (o.result, o.happened, o.issues, o.risks)
    assert not any("key" in i.lower() or "book text" in i for i in o.issues)


def test_registry_has_every_standard_and_three_more_per_part(section_b):
    ids = [section_b.rid(s.part, s.letter) for s in section_b.ordered()]
    assert ids[0] == "B-3-a" and len(ids) == len(set(ids))
    for part in ("3", "4", "5", "6", "7"):
        letters = {s.letter for s in section_b.ordered() if s.part == part}
        assert set("abcdefghij") <= letters and len(letters - set("abcdefghij")) >= 3, part
    for rid, f in section_b.findings.items():
        assert f["severity"] in core.SEVERITIES and f["where"] and f["fix"], rid


def test_fake_image_bridge_answers_like_autoinjector(section_b):
    import json
    import urllib.request

    from tools.stress import section_b as sb
    br = sb.FakeImageBridge()
    try:
        req = urllib.request.Request(br.url + "/image/request", data=json.dumps({"prompt": "x"}).encode(),
                                     method="POST", headers={"Authorization": f"Bearer {sb.IMG_KEY}"})
        out = json.loads(urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=5).read())
        assert out["ok"] and out["images"] and br.n == 1
    finally:
        br.close()
