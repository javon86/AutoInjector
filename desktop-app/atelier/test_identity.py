#!/usr/bin/env python3
"""test_identity.py — regression for B1 (project identity / namespace)."""
from __future__ import annotations
import argparse, subprocess, sys, tempfile
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

@case("B1: job ids are namespaced by project — no cross-book collision")
def t1(td):
    from identity import namespaced
    a=namespaced("book-a","CH07-S01-DRAFT-v1"); b=namespaced("book-b","CH07-S01-DRAFT-v1")
    assert a!=b, "identical job ids in two projects must not collide"
    assert a=="book-a/CH07-S01-DRAFT-v1", a

@case("B1: cross-project access is refused")
def t2(td):
    from identity import Identity, assert_same_project, NamespaceViolation, IDENTITY_FILE
    import json
    root=td/"p"; (root/"00_CONTROL").mkdir(parents=True)
    (root/IDENTITY_FILE).write_text(json.dumps(
        Identity("book-a","v0.3.3").to_dict()), encoding="utf-8")
    assert_same_project(root,"book-a")
    try:
        assert_same_project(root,"book-b")
        raise AssertionError("cross-project read must be refused")
    except NamespaceViolation as e:
        assert "cross-project access refused" in str(e), e

@case("B1: a project with no identity file is a violation, not a default")
def t3(td):
    from identity import load, NamespaceViolation
    (td/"p").mkdir()
    try:
        load(td/"p"); raise AssertionError("missing identity must raise")
    except NamespaceViolation as e:
        assert "no project identity" in str(e), e

@case("B1: malformed project_id is rejected")
def t4(td):
    from identity import Identity, NamespaceViolation
    for bad in ("Book A","x","../evil","UPPER"):
        try:
            Identity(bad,"v0.3.3"); raise AssertionError(f"{bad!r} must be rejected")
        except NamespaceViolation:
            pass

CASES=[t1,t2,t3,t4]
def main()->int:
    ap=argparse.ArgumentParser(); ap.add_argument("-v","--verbose",action="store_true")
    ap.add_argument("--prove",action="store_true"); a=ap.parse_args()
    if a.prove:
        print("PDF-003 guard: deliberately wrong expectation.\n")
        @case("DELIBERATELY WRONG")
        def bad(td):
            from identity import namespaced
            assert namespaced("book-a","J1")==namespaced("book-b","J1"), \
                "expected failure — suite can go red"
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
