"""The book's "Content check" step (H05) really checks: identical chapters, a manuscript that does not match the
chapter list (missing / reordered chapter) are flagged, a correct book passes."""
from __future__ import annotations

import pytest

import flowkit as fk


@pytest.fixture(autouse=True)
def _quiet(monkeypatch):
    fk.quiet_provider_sleep(monkeypatch)


SAME = ("The fog came in off the sea and Mara climbed the hundred steps of the lighthouse with the cold lantern. "
        "\n\nAt the top she found the logbook open on the desk, the last line written in her master's hand.")


def test_identical_chapters_are_refused_before_their_review(tmp_path):
    """🧹 E-12.2-l: a writer that repeats chapter 1 is caught while the chapters are written (set aside, written again,
    then a clear pause naming the chapters), no longer only by the content check after every chapter was approved.
    The content check itself still refuses identical chapters (tests/test_set_h.py)."""
    ai = fk.TraceAI(overrides={"C02": lambda ctx, out: dict(out, text=SAME)})
    app = fk.make_app(tmp_path, fake=ai)
    run = fk.run_book(app)
    assert run["status"] == "paused" and run["problem"]["step"] == "chapters", run["problem"]
    assert run["problem"]["code"] == "CHECKS_REFUSED"
    assert "same as chapter 1's" in run["problem"]["message"] and "chapter 2" in run["problem"]["message"]


def _h05(bp, manuscript_ref, manifest_ref):
    ref, r = bp.create("H05", {"manuscript_ref": manuscript_ref, "chapter_manifest_ref": manifest_ref})
    return r["result"]


@pytest.mark.parametrize("change", ["missing", "swapped"])
def test_manuscript_that_does_not_match_the_chapter_list_is_flagged(tmp_path, change):
    app = fk.make_app(tmp_path, fake=fk.TraceAI())
    run = fk.run_book(app)
    assert run["status"] == "done"
    pid = run["project_id"]
    bp = fk.bp_of(app, pid)
    asm = bp.mem["assembly"]
    g01 = bp._appr(asm["G01"])
    assert _h05(bp, g01, bp._appr(asm["G02"]))["status"] == "PASS"
    refs = [rec["ref"] for _c, rec in fk.approved_chapters(app, pid)]
    refs = refs[:2] if change == "missing" else [refs[1], refs[0], refs[2]]
    m = app.store.feature_manifest(pid, "main")
    g02, _ = bp.create("G02", {"approved_chapter_refs": refs, "ordered_chapter_ids": [r["record_id"] for r in refs],
                               "manifest_revision": m["revision"]})
    assert bp.approve_ref(g02)["ok"]
    res = _h05(fk.bp_of(app, pid), g01, fk.bp_of(app, pid)._appr(g02))
    assert res["status"] == "FAIL", res
    rules = {f.get("rule_id") for f in res.get("findings") or [] if f.get("decision") == "FAIL"}
    assert "MANUSCRIPT_MANIFEST_MISMATCH" in rules or rules & {"EXTRA_CONTENT", "ORDER_MISMATCH"}, rules
