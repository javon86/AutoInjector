#!/usr/bin/env python3
"""test_context.py — regression for A5 (§24 context-package producer)."""
from __future__ import annotations
import argparse, json, subprocess, sys, tempfile
from pathlib import Path
HERE=Path(__file__).resolve().parent
_r: list[tuple[str,bool,str]]=[]

def run(proj,*a,timeout=60):
    p=subprocess.run([sys.executable,str(HERE/"build_context.py"),str(proj),*a],
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

def project(td, n_facts=10, load_bearing=0) -> Path:
    p=td/"p"; (p/"03_MEMORY").mkdir(parents=True)
    rows=[]
    for i in range(1,n_facts+1):
        lb = "\n  classification: LOAD-BEARING" if i<=load_bearing else ""
        rows.append(f'- id: CAND-{i:04d}  entity: E  property: P\n  value: "v"{lb}\n  status: proposed')
    (p/"03_MEMORY"/"CANDIDATES.md").write_text(
        "# C\n\n## From CH01\n\n```yaml\n"+"\n".join(rows)+"\n```\n", encoding="utf-8")
    return p

@case("A5: metrics satisfy available - included = omitted")
def t1(td):
    proj=project(td,20)
    c,o,_=run(proj,"--chapter","CH01","--budget","8","--json")
    assert c==0, o
    d=json.loads(o)
    assert d["facts_available"]-d["facts_included"]==d["facts_omitted"], d

@case("A5: truncation sets continuity_truncated and warns on stderr")
def t2(td):
    proj=project(td,20)
    c,o,e=run(proj,"--chapter","CH01","--budget","3","--json")
    assert c==0 and json.loads(o)["continuity_truncated"] is True
    assert "TRUNCATION" in e, e

@case("A5: no truncation reports the flag false")
def t3(td):
    proj=project(td,3)
    c,o,e=run(proj,"--chapter","CH01","--budget","500","--json")
    assert c==0 and json.loads(o)["continuity_truncated"] is False
    assert "TRUNCATION" not in e

@case("A5: dropping a LOAD-BEARING fact to fit the budget is S0")
def t4(td):
    proj=project(td,20,load_bearing=6)
    c,_,e=run(proj,"--chapter","CH01","--budget","2")
    assert c==2, f"omitting load-bearing facts must be S0, got {c}"
    assert "load-bearing fact(s) omitted" in e, e

@case("A5: load-bearing facts are kept FIRST under a tight budget")
def t5(td):
    proj=project(td,20,load_bearing=3)
    c,o,_=run(proj,"--chapter","CH01","--budget","3","--json")
    assert c==0, o
    assert json.loads(o)["load_bearing_included"]==3, o

@case("A5: --out writes the package to disk")
def t6(td):
    proj=project(td,5)
    out=td/"pkt.json"
    c,_,_=run(proj,"--chapter","CH01","--out",str(out))
    assert c==0 and out.exists() and json.loads(out.read_text())["chapter"]=="CH01"

@case("A5: a non-project directory is FATAL, not an empty package")
def t7(td):
    (td/"p").mkdir(); c,_,e=run(td/"p","--chapter","CH01")
    assert c==3 and "not a project" in e, e

CASES=[t1,t2,t3,t4,t5,t6,t7]

def main()->int:
    ap=argparse.ArgumentParser(); ap.add_argument("-v","--verbose",action="store_true")
    ap.add_argument("--prove",action="store_true"); a=ap.parse_args()
    if a.prove:
        print("PDF-003 guard: deliberately wrong expectation.\n"
              "If this does NOT fail, the suite proves nothing.\n")
        @case("DELIBERATELY WRONG")
        def bad(td):
            proj=project(td,20,load_bearing=6)
            c,_,_=run(proj,"--chapter","CH01","--budget","2")
            assert c==0,"expected failure — suite can go red"
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
