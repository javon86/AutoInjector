#!/usr/bin/env python3
"""test_registers.py — regression for A4 (§20/21 register validation)."""
from __future__ import annotations
import argparse, subprocess, sys, tempfile
from pathlib import Path
HERE=Path(__file__).resolve().parent
_r: list[tuple[str,bool,str]]=[]

def run(proj,*a,timeout=60):
    p=subprocess.run([sys.executable,str(HERE/"check_registers.py"),str(proj),*a],
                     capture_output=True,text=True,timeout=timeout)
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

def project(td, threads="", setups="", upto=3) -> Path:
    p=td/"p"; (p/"01_DESIGN").mkdir(parents=True)
    if threads: (p/"01_DESIGN"/"OPEN_THREADS.md").write_text("# T\n\n"+threads, encoding="utf-8")
    if setups:  (p/"01_DESIGN"/"SETUP_PAYOFF.md").write_text("# S\n\n"+setups, encoding="utf-8")
    for n in range(1,upto+1):
        d=p/"04_CHAPTERS"/f"ch{n:02d}"/"scenes"; d.mkdir(parents=True); (d/"s01.md").touch()
    return p

@case("A4: a MAJOR thread unadvanced 5+ chapters is S2")
def t1(td):
    proj=project(td,threads="## THR-001 — the missing heir\n- importance: major\n- completed: false\n- last_advanced: **CH01**\n",upto=7)
    c,_,e=run(proj); assert c==1 and "MAJOR and unadvanced" in e, e

@case("A4: a MINOR thread unadvanced does NOT fire")
def t2(td):
    proj=project(td,threads="## THR-001 — a small thing\n- importance: moderate\n- completed: false\n- last_advanced: **CH01**\n",upto=7)
    c,_,e=run(proj); assert c==0, f"minor threads must not fire: {e}"

@case("A4: a setup past its payoff target unpaid is S1")
def t3(td):
    proj=project(td,setups="## SP-001 — a gun on the mantel\n- payoff_target: CH02\n- payoff_actual: —\n",upto=5)
    c,_,e=run(proj); assert c==1 and "passed its payoff target" in e, e

@case("A4: a setup paid in a LATER summary section is not flagged")
def t4(td):
    """Regression: payoff recorded outside its own block produced a false positive."""
    s=("## SP-001 — a gun on the mantel\n- payoff_target: CH02\n\n"
       "## SP-002 — a letter\n- payoff_target: CH09\n\n"
       "## FINAL\n- SP-001 PAID at CH02 as planned.\n")
    proj=project(td,setups=s,upto=5)
    c,_,e=run(proj); assert c==0, f"summary-recorded payoff must count: {e}"

@case("A4: --final flags any open thread and unpaid setup as S1")
def t5(td):
    proj=project(td,
        threads="## THR-001 — unresolved\n- importance: moderate\n- completed: false\n- last_advanced: **CH03**\n",
        setups="## SP-001 — unpaid\n- payoff_target: CH09\n",upto=3)
    c,_,e=run(proj,"--final")
    assert c==1 and "open at final assembly" in e and "unpaid at final assembly" in e, e

@case("A4: a clean register passes both modes")
def t6(td):
    proj=project(td,
        threads="## THR-001 — done\n- importance: major\n- completed: TRUE\n- last_advanced: **CH01**\n",
        setups="## SP-001 — done\n- payoff_target: CH02\n- status: paid\n",upto=5)
    assert run(proj)[0]==0 and run(proj,"--final")[0]==0

@case("A4: absent registers are FATAL, not a pass")
def t7(td):
    (td/"p"/"01_DESIGN").mkdir(parents=True); c,_,e=run(td/"p")
    assert c==3 and "no register found" in e, e

CASES=[t1,t2,t3,t4,t5,t6,t7]

def main()->int:
    ap=argparse.ArgumentParser(); ap.add_argument("-v","--verbose",action="store_true")
    ap.add_argument("--prove",action="store_true"); a=ap.parse_args()
    if a.prove:
        print("PDF-003 guard: deliberately wrong expectation.\n"
              "If this does NOT fail, the suite proves nothing.\n")
        @case("DELIBERATELY WRONG")
        def bad(td):
            proj=project(td,threads="## THR-001 — x\n- importance: major\n- completed: false\n- last_advanced: **CH01**\n",upto=9)
            c,_,_=run(proj); assert c==0,"expected failure — suite can go red"
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
