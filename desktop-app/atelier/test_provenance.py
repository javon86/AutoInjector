#!/usr/bin/env python3
"""test_provenance.py — regression for B3 (artifact provenance). PDF-006."""
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

VALID = ("---\nauthored_by: claude\nauthored_at: 2026-08-13T00:00:00Z\n"
         "job_id: CH07-S01-v1\n---\nbody\n")

@case("B3: an artifact with no provenance is a finding")
def t1(td):
    from provenance import validate
    errs=validate("just text\n","x.md")
    assert errs and "not evidence" in errs[0], errs

@case("B3: each required field is independently required")
def t2(td):
    from provenance import validate
    for drop in ("authored_by","authored_at","job_id"):
        block="\n".join(l for l in VALID.splitlines() if not l.startswith(drop))
        errs=validate(block+"\n","x.md")
        assert errs and drop in errs[0], f"removing {drop} not caught: {errs}"

@case("B3: an unknown author role is rejected")
def t3(td):
    from provenance import validate
    errs=validate(VALID.replace("claude","mystery-model"),"x.md")
    assert errs and "unknown authored_by" in errs[0], errs

@case("B3: a non-ISO timestamp is rejected")
def t4(td):
    from provenance import validate
    errs=validate(VALID.replace("2026-08-13T00:00:00Z","last Tuesday"),"x.md")
    assert errs and "ISO-8601" in errs[0], errs

@case("B3: a well-formed block validates clean")
def t5(td):
    from provenance import validate
    assert validate(VALID,"x.md")==[]

@case("PDF-019: a future authored_at is rejected")
def t6(td):
    from provenance import validate
    errs = validate(VALID.replace("2026-08-13T00:00:00Z", "2099-01-01T00:00:00Z"), "x.md")
    assert errs and "future" in errs[0], \
        f"a timestamp ahead of now cannot describe completed work: {errs}"


@case("PDF-020: two provenance blocks are ambiguous attribution, not attribution")
def t7(td):
    from provenance import validate
    forged = ("---\nauthored_by: gemini\nauthored_at: 2026-08-13T00:00:00Z\n"
              "job_id: J1\n---\n" + VALID)
    errs = validate(forged, "x.md")
    assert errs and "more than one provenance block" in errs[0], \
        f"a prepended block silently won attribution: {errs}"


CASES=[t1,t2,t3,t4,t5,t6,t7]
def main()->int:
    ap=argparse.ArgumentParser(); ap.add_argument("-v","--verbose",action="store_true")
    ap.add_argument("--prove",action="store_true"); a=ap.parse_args()
    if a.prove:
        print("PDF-003 guard: deliberately wrong expectation.\n")
        @case("DELIBERATELY WRONG")
        def bad(td):
            from provenance import validate
            assert validate("no provenance at all\n","x.md")==[], "expected failure — suite can go red"
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
