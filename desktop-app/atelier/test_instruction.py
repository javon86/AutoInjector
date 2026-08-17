#!/usr/bin/env python3
"""test_instruction.py — regression for B4 (§4.13 stale-instruction detection)."""
from __future__ import annotations
import argparse, subprocess, sys, tempfile
from pathlib import Path
HERE=Path(__file__).resolve().parent
_r=[]
def run(proj,ins,*a,timeout=60):
    p=subprocess.run([sys.executable,str(HERE/"check_instruction.py"),str(proj),
                      "--instruction",str(ins),*a],capture_output=True,text=True,timeout=timeout)
    return p.returncode,p.stdout,p.stderr
def case(n):
    def deco(fn):
        def w():
            with tempfile.TemporaryDirectory() as td:
                try: fn(Path(td)); _r.append((n,True,""))
                except AssertionError as e: _r.append((n,False,str(e)))
                except Exception as e: _r.append((n,False,f"{type(e).__name__}: {e}"))
        return w
    return deco

def project(td, state: str) -> Path:
    p=td/"p"; (p/"00_CONTROL").mkdir(parents=True)
    (p/"00_CONTROL"/"STATE.md").write_text(state, encoding="utf-8")
    return p

@case("B4: an instruction quoting text that no longer exists is STALE")
def t1(td):
    proj=project(td,"Candidates pending: 106\n")
    ins=td/"i.md"; ins.write_text('1. Fix where it says "Candidates pending: 51".\n')
    c,_,e=run(proj,ins)
    assert c==1 and "STALE" in e and "51" in e, e

@case("B4: an instruction quoting CURRENT text may proceed")
def t2(td):
    proj=project(td,"Candidates pending: 106\n")
    ins=td/"i.md"; ins.write_text('1. Confirm "Candidates pending: 106".\n')
    c,o,e=run(proj,ins)
    assert c==0, f"fresh instruction must proceed: {e}"

@case("B4: mixed instruction — fresh and stale handled component-wise")
def t3(td):
    proj=project(td,"Candidates pending: 106\n")
    ins=td/"i.md"; ins.write_text(
        '1. Confirm "Candidates pending: 106".\n2. Fix "Candidates pending: 51".\n')
    c,o,e=run(proj,ins)
    assert c==1 and "1 fresh, 1 stale" in o, o

@case("B4: a stale version reference is detected")
def t4(td):
    proj=project(td,"spec v0.3.3 frozen\n")
    ins=td/"i.md"; ins.write_text("1. Apply against v0.2.9 baseline.\n")
    c,_,e=run(proj,ins)
    assert c==1 and "versions absent" in e, e

@case("B4: a conditional component is marked ATOMIC")
def t5(td):
    proj=project(td,"state\n")
    ins=td/"i.md"; ins.write_text('1. If the gate is green, apply "missing text here".\n')
    c,_,e=run(proj,ins)
    assert c==1 and "ATOMIC" in e, e

CASES=[t1,t2,t3,t4,t5]
def main()->int:
    ap=argparse.ArgumentParser(); ap.add_argument("-v","--verbose",action="store_true")
    ap.add_argument("--prove",action="store_true"); a=ap.parse_args()
    if a.prove:
        print("PDF-003 guard: deliberately wrong expectation.\n")
        @case("DELIBERATELY WRONG")
        def bad(td):
            proj=project(td,"Candidates pending: 106\n")
            ins=td/"i.md"; ins.write_text('1. Fix "Candidates pending: 51".\n')
            c,_,_=run(proj,ins); assert c==0,"expected failure — suite can go red"
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
