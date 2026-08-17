#!/usr/bin/env python3
"""test_redelivery.py — regression for B5 (§4.10.3 duplicate-delivery quarantine)."""
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

@case("B5: a first delivery is accepted and recorded")
def t1(td):
    from redelivery import accept
    rec=accept(td,"J1","content")
    assert rec["job_id"]=="J1" and len(rec["digest"])==64
    assert (td/"00_CONTROL"/"DELIVERIES.json").exists()

@case("B5: IDENTICAL redelivery is REFUSED, not silently accepted")
def t2(td):
    from redelivery import accept, DeliveryRefused
    accept(td,"J1","content")
    try:
        accept(td,"J1","content")
        raise AssertionError("idempotent redelivery must still be refused — "
                             "silently accepting hides a transport symptom")
    except DeliveryRefused as e:
        assert e.kind=="IDEMPOTENT", e.kind

@case("B5: DIFFERING redelivery is a CONFLICT, never auto-resolved")
def t3(td):
    from redelivery import accept, DeliveryRefused
    accept(td,"J1","first")
    try:
        accept(td,"J1","second")
        raise AssertionError("conflicting redelivery must be refused")
    except DeliveryRefused as e:
        assert e.kind=="CONFLICT" and "Showrunner ruling" in str(e), e

@case("B5: refused deliveries are QUARANTINED with both digests")
def t4(td):
    from redelivery import accept, DeliveryRefused, QUARANTINE
    accept(td,"J1","first")
    try: accept(td,"J1","second")
    except DeliveryRefused: pass
    q=list((td/QUARANTINE).glob("*.md"))
    assert q, "duplicate must be preserved as evidence"
    txt=q[0].read_text()
    assert "CONFLICT" in txt and "second" in txt and "first accepted" in txt

@case("B5: the original record is NOT overwritten by a redelivery")
def t5(td):
    from redelivery import accept, DeliveryRefused, _load
    first=accept(td,"J1","first")
    try: accept(td,"J1","second")
    except DeliveryRefused: pass
    assert _load(td)["J1"]["digest"]==first["digest"], \
        "the first delivery must remain authoritative"

@case("B5: the same job_id in DIFFERENT projects does not collide")
def t6(td):
    from redelivery import accept
    accept(td,"J1","a",project_id="book-a")
    accept(td,"J1","b",project_id="book-b")   # must not raise
    from redelivery import _load
    assert set(_load(td))=={"book-a/J1","book-b/J1"}

@case("PDF-021: a job_id that is a path or bare dots is refused")
def t7(td):
    """
    A job_id becomes a FILENAME. Unvalidated, "." and ".." produce ..json and
    ...json, and "../../evil" writes outside the store. Found by adversarial
    sweep: the traversal check rejected slashes but not bare dots.
    """
    from redelivery import accept, DeliveryRefused
    for bad in ("../../evil", "a/b/c", ".", "..", "", "J1 J2"):
        try:
            accept(td, bad, "x")
            raise AssertionError(f"job_id {bad!r} was accepted as a filename")
        except DeliveryRefused as e:
            assert e.kind == "INVALID_ID", e.kind
    accept(td, "CH07-S01-v1", "x")     # legitimate id still works


CASES=[t1,t2,t3,t4,t5,t6,t7]
def main()->int:
    ap=argparse.ArgumentParser(); ap.add_argument("-v","--verbose",action="store_true")
    ap.add_argument("--prove",action="store_true"); a=ap.parse_args()
    if a.prove:
        print("PDF-003 guard: deliberately wrong expectation.\n")
        @case("DELIBERATELY WRONG")
        def bad(td):
            from redelivery import accept
            accept(td,"J1","x"); accept(td,"J1","x")
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
