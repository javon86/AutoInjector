#!/usr/bin/env python3
"""test_knowledge.py — regression for A3 (§18.4 Knowledge Matrix)."""
from __future__ import annotations
import argparse, subprocess, sys, tempfile
from pathlib import Path
HERE = Path(__file__).resolve().parent
_r: list[tuple[str,bool,str]] = []
S,F = "}-----< Start >-----{","}-----< finish >-----{"

def run(proj,*a,timeout=60):
    p=subprocess.run([sys.executable,str(HERE/"check_knowledge.py"),str(proj),*a],
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

def project(td, knows: str, chapters: dict) -> Path:
    p=td/"p"; (p/"02_BIBLE"/"characters").mkdir(parents=True)
    (p/"02_BIBLE"/"characters"/"x.md").write_text(
        f"# X\n## DYNAMIC\n- knows:\n{knows}", encoding="utf-8")
    for n,txt in chapters.items():
        d=p/"04_CHAPTERS"/f"ch{n:02d}"/"scenes"; d.mkdir(parents=True)
        (d/"s01.md").write_text(f"{S}\n{txt}\n{F}\n", encoding="utf-8")
    return p

@case("A3: acting on a fact before learning it is S1")
def t1(td):
    proj=project(td,"  - **CH05** — the lighthouse keeper poisoned the reservoir at Blackwater\n",
        {1:"She knew the lighthouse keeper had poisoned the reservoir at Blackwater.",
         5:"Ordinary weather prose."})
    c,_,e=run(proj); assert c==1 and "acting-on-unknown" in e, e

@case("A3: acting on a fact AFTER learning it passes")
def t2(td):
    proj=project(td,"  - **CH01** — the lighthouse keeper poisoned the reservoir at Blackwater\n",
        {1:"Ordinary weather prose.",
         5:"She knew the lighthouse keeper had poisoned the reservoir at Blackwater."})
    c,o,e=run(proj); assert c==0, f"must pass: {e}"

@case("A3: common domain vocabulary does NOT false-positive")
def t3(td):
    """The distinctiveness filter: terms in >1/3 of scenes are background."""
    proj=project(td,"  - **CH03** — the stakes are seaward of the level line\n",
        {1:"stakes seaward level line everywhere",2:"stakes seaward level line again",
         3:"stakes seaward level line once more",4:"stakes seaward level line"})
    c,o,e=run(proj); assert c==0, f"domain vocabulary must not fire: {e}"

@case("A3: an undated knows: entry is ignored, not guessed")
def t4(td):
    proj=project(td,"  - she knows about the lighthouse keeper at Blackwater\n",
        {1:"lighthouse keeper Blackwater reservoir poisoned"})
    c,o,_=run(proj); assert c==0 and "0 dated knowledge fact" in o, o

@case("A3: missing character bible is FATAL, not a pass")
def t5(td):
    (td/"p").mkdir(); c,_,e=run(td/"p")
    assert c==3 and "no character bible" in e, e

CASES=[t1,t2,t3,t4,t5]

def main()->int:
    ap=argparse.ArgumentParser(); ap.add_argument("-v","--verbose",action="store_true")
    ap.add_argument("--prove",action="store_true"); a=ap.parse_args()
    if a.prove:
        print("PDF-003 guard: deliberately wrong expectation.\n"
              "If this does NOT fail, the suite proves nothing.\n")
        @case("DELIBERATELY WRONG")
        def bad(td):
            proj=project(td,"  - **CH05** — the lighthouse keeper poisoned the reservoir at Blackwater\n",
                {1:"She knew the lighthouse keeper had poisoned the reservoir at Blackwater.",5:"x"})
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
