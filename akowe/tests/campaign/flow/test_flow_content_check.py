"""The book's "Content check" step (H05) really checks: identical chapters, a manuscript that does not match the
chapter list (missing / reordered chapter) are flagged, a correct book passes."""
from __future__ import annotations

import pytest

import flowkit as fk


@pytest.fixture(autouse=True)
def _quiet(monkeypatch):
    fk.quiet_provider_sleep(monkeypatch)


def test_identical_chapters_fail_the_content_check(tmp_path):
    ai = fk.TraceAI(overrides={"C02": lambda ctx, out: dict(out, text="The same words.\n\nAgain the same words.")})
    app = fk.make_app(tmp_path, fake=ai)
    run = fk.run_book(app)
    assert run["status"] == "paused" and run["problem"]["step"] == "check"
    assert any("identical text" in d for d in run["problem"]["details"]), run["problem"]
    st = {s["id"]: s for s in fk.bp_of(app, run["project_id"]).status()["steps"]}
    assert st["check"]["result"] == "FAIL"


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
