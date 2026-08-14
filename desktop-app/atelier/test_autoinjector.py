#!/usr/bin/env python3
"""test_autoinjector.py — regression for task 3 (orchestration adapter)."""
from __future__ import annotations
import argparse, sys, tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
_r=[]
def case(n):
    def deco(fn):
        def w():
            with tempfile.TemporaryDirectory() as td:
                try: fn(Path(td)); _r.append((n,True,""))
                except AssertionError as e: _r.append((n,False,str(e)))
                except Exception as e: _r.append((n,False,f"{type(e).__name__}: {e}"))
        return w
    return deco

def pipe(td, role="claude", target="04_CHAPTERS/ch01/scenes/s01.md"):
    from autoinjector import Pipeline
    p = Pipeline(td, "book-a", "v0.3.3")
    return p, p.create("J1", role, target)

PROV = ("---\nauthored_by: claude\nauthored_at: 2026-08-13T00:00:00Z\n"
        "job_id: J1\n---\nprose\n")

@case("AI: stages cannot be skipped — a skipped stage never ran")
def t1(td):
    from autoinjector import StageRefused
    p, j = pipe(td)
    try:
        j.advance("APPLY")
        raise AssertionError("jumping CREATE -> APPLY must be refused")
    except StageRefused as e:
        assert "cannot jump" in str(e), e

@case("AI: ROUTE refuses a job targeted at a path the role cannot write")
def t2(td):
    from autoinjector import StageRefused
    p, j = pipe(td, role="gemini")
    try:
        p.route(j); raise AssertionError("§3.3 violation routed successfully")
    except StageRefused as e:
        assert e.stage == "ROUTE" and "may not write" in str(e), e

@case("AI: DELIVER refuses a redelivered job before any work is applied")
def t3(td):
    from autoinjector import StageRefused
    p, j = pipe(td); p.route(j); p.deliver(j, "content")
    _, j2 = pipe(td)
    p.route(j2)
    try:
        p.deliver(j2, "content")
        raise AssertionError("duplicate delivery reached the pipeline")
    except StageRefused as e:
        assert e.stage == "DELIVER", e

@case("AI: VERIFY refuses content with no provenance")
def t4(td):
    from autoinjector import StageRefused
    p, j = pipe(td); p.route(j); p.deliver(j, "x"); j.advance("CAPTURE")
    try:
        p.verify(j, "bare prose, no attribution\n")
        raise AssertionError("unattributed content passed VERIFY")
    except StageRefused as e:
        assert e.stage == "VERIFY" and "not evidence" in str(e), e

@case("AI: a P3 classification places the job on HOLD, never auto-adopted")
def t5(td):
    from autoinjector import HOLD
    p, j = pipe(td); p.route(j); p.deliver(j, "x")
    j.advance("CAPTURE"); p.verify(j, PROV); p.classify(j, "P3")
    assert j.stage == HOLD, f"P3 must hold, got {j.stage}"

@case("AI: a held job cannot APPLY")
def t6(td):
    from autoinjector import StageRefused
    p, j = pipe(td); p.route(j); p.deliver(j, "x")
    j.advance("CAPTURE"); p.verify(j, PROV); p.classify(j, "P3")
    try:
        p.apply(j, PROV); raise AssertionError("a held job wrote to disk")
    except StageRefused as e:
        assert "HOLD" in str(e), e

@case("AI: the happy path completes and writes through the authorised path")
def t7(td):
    p, j = pipe(td); p.route(j); p.deliver(j, "x")
    j.advance("CAPTURE"); p.verify(j, PROV); p.classify(j, "P1"); p.apply(j, PROV)
    written = td / "04_CHAPTERS" / "ch01" / "scenes" / "s01.md"
    assert written.exists() and "authored_by: claude" in written.read_text()
    assert j.stage == "APPLY" and len(j.history) >= 5

@case("AI: pipeline state persists with the full transition history")
def t8(td):
    p, j = pipe(td); p.route(j); p.deliver(j, "x"); p.persist(j)
    import json
    data = json.loads((td/"00_CONTROL"/"PIPELINE.json").read_text())
    assert "book-a/J1" in data, data
    assert data["book-a/J1"]["stage"] == "DELIVER"
    assert len(data["book-a/J1"]["history"]) == 2

CASES=[t1,t2,t3,t4,t5,t6,t7,t8]
def main()->int:
    ap=argparse.ArgumentParser(); ap.add_argument("-v","--verbose",action="store_true")
    ap.add_argument("--prove",action="store_true"); a=ap.parse_args()
    if a.prove:
        print("PDF-003 guard: deliberately wrong expectation.\n")
        @case("DELIBERATELY WRONG")
        def bad(td):
            p,j=pipe(td,role="gemini"); p.route(j)
            raise AssertionError("expected failure — suite can go red")
        bad(); _,ok,msg=_r[-1]
        print(f"  {'FAIL (correct)' if not ok else 'PASS (BROKEN SUITE!)'} — {msg}")
        return 0 if not ok else 1
    for c in CASES: c()
    bad_=[(n,m) for n,ok,m in _r if not ok]
    for n,ok,m in _r:
        if a.verbose or not ok:
            print(f"  {'PASS' if ok else 'FAIL'}  {n}")
            if not ok: print(f"        {m}")
    print(f"\n{len(_r)-len(bad_)}/{len(_r)} passed")
    return 1 if bad_ else 0
if __name__=="__main__": sys.exit(main())
