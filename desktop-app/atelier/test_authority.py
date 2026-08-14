#!/usr/bin/env python3
"""test_authority.py — regression for B2 (role write authority). Closes ISS-002."""
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

@case("B2: ISS-002 — the Auditor cannot write manuscript prose")
def t1(td):
    from authority import guard, AuthorityViolation
    try:
        guard("gemini", td, "04_CHAPTERS/ch01/scenes/s01.md", "prose")
        raise AssertionError("§3.3 violation was NOT blocked — ISS-002 regressed")
    except AuthorityViolation as e:
        assert "may not write" in str(e), e
    assert not (td/"04_CHAPTERS").exists(), "refused write must not land"

@case("B2: a refused write is QUARANTINED, not silently dropped")
def t2(td):
    from authority import guard, AuthorityViolation, QUARANTINE
    try: guard("gemini", td, "02_BIBLE/characters/x.md", "invented canon")
    except AuthorityViolation: pass
    q=list((td/QUARANTINE).glob("*"))
    assert q, "refused write must be preserved as evidence"
    assert "REFUSED WRITE" in q[0].read_text() and "invented canon" in q[0].read_text()

@case("B2: the Author may write manuscript")
def t3(td):
    from authority import guard
    p=guard("claude", td, "04_CHAPTERS/ch01/scenes/s01.md", "prose")
    assert p.exists() and p.read_text()=="prose"

@case("B2: the Auditor MAY write to its own quarantine and audit area")
def t4(td):
    from authority import guard
    assert guard("gemini", td, "99_ARCHIVE/auditor-submissions/f.md", "finding").exists()
    assert guard("gemini", td, "06_AUDIT/round3.md", "report").exists()

@case("B2: deny by default — an unknown role and an unlisted path are refused")
def t5(td):
    from authority import can_write
    assert not can_write("random-model","04_CHAPTERS/x.md")[0]
    assert not can_write("gemini","some/unlisted/path.md")[0]

@case("B2: path traversal cannot escape the project root")
def t6(td):
    """
    Found by adversarial sweep, not by this suite. A prefix match on an
    unnormalised path checks where the string STARTS, not where it LANDS:
    04_CHAPTERS/../../../etc/x matched 04_CHAPTERS/** and wrote outside.
    """
    from authority import can_write
    for bad in ("../../etc/passwd", "04_CHAPTERS/../../../etc/x",
                "/etc/passwd", "04_CHAPTERS/..%2f..%2fx",
                "04_CHAPTERS/./../../x", "C:/Windows/x"):
        ok, why = can_write("claude", bad)
        assert not ok, f"{bad!r} escaped the write gate: {why}"


@case("B2: legitimate paths still resolve after normalisation")
def t7(td):
    from authority import can_write
    for good in ("04_CHAPTERS/ch01/scenes/s01.md",
                 "04_CHAPTERS/./ch01/scenes/s01.md",
                 "02_BIBLE/characters/x.md"):
        ok, why = can_write("claude", good)
        assert ok, f"{good!r} was wrongly refused: {why}"


CASES=[t1,t2,t3,t4,t5,t6,t7]
def main()->int:
    ap=argparse.ArgumentParser(); ap.add_argument("-v","--verbose",action="store_true")
    ap.add_argument("--prove",action="store_true"); a=ap.parse_args()
    if a.prove:
        print("PDF-003 guard: deliberately wrong expectation.\n")
        @case("DELIBERATELY WRONG")
        def bad(td):
            from authority import can_write
            assert can_write("gemini","04_CHAPTERS/x.md")[0], "expected failure — suite can go red"
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
