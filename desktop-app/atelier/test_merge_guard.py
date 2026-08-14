#!/usr/bin/env python3
"""test_merge_guard.py — regression for C-12/F-07 and C-13/F-08."""
from __future__ import annotations
import argparse, os, subprocess, sys, tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
HERE=Path(__file__).resolve().parent
_r=[]
GENV={**os.environ,"GIT_TERMINAL_PROMPT":"0","GIT_ASKPASS":"true"}

def git(cwd,*a): return subprocess.run(["git",*a],cwd=cwd,capture_output=True,text=True,timeout=20,env=GENV)
def have_git():
    try: return subprocess.run(["git","--version"],capture_output=True,timeout=10,env=GENV).returncode==0
    except Exception: return False
class Skip(Exception): ...

def case(n):
    def deco(fn):
        def w():
            with tempfile.TemporaryDirectory() as td:
                try: fn(Path(td)); _r.append((n,True,""))
                except Skip as e: _r.append((n,None,str(e)))
                except AssertionError as e: _r.append((n,False,str(e)))
                except Exception as e: _r.append((n,False,f"{type(e).__name__}: {e}"))
        return w
    return deco

def repo(td):
    if not have_git(): raise Skip("git unavailable")
    p=td/"r"; p.mkdir(); git(p,"init","-q","-b","main")
    git(p,"config","user.email","t@t"); git(p,"config","user.name","t")
    (p/"f.txt").write_text("base\n"); git(p,"add","-A"); git(p,"commit","-qm","base")
    return p, git(p,"rev-parse","HEAD").stdout.strip()

@case("F-08: ancestry alone does NOT prove this transaction caused the merge")
def t1(td):
    from merge_guard import mint, verify_merge
    p,base=repo(td); tok=mint("J1",base)
    git(p,"checkout","-qb","wb/J1"); (p/"f.txt").write_text("work\n")
    git(p,"add","-A"); git(p,"commit","-qm","work"); git(p,"checkout","-q","main")
    git(p,"merge","-q","--no-ff","wb/J1","-m","merge by some other process")
    ok,why=verify_merge(p,"J1",tok,"main","wb/J1")
    assert not ok and "not attributable" in why, why

@case("F-08: a merge carrying the transaction trailer IS attributable")
def t2(td):
    from merge_guard import mint, verify_merge, TRAILER
    p,base=repo(td); tok=mint("J1",base)
    git(p,"checkout","-qb","wb/J1"); (p/"f.txt").write_text("work\n")
    git(p,"add","-A"); git(p,"commit","-qm","work"); git(p,"checkout","-q","main")
    git(p,"merge","-q","--no-ff","wb/J1","-m",f"merge\n\n{TRAILER}: J1/{tok}")
    ok,why=verify_merge(p,"J1",tok,"main","wb/J1")
    assert ok and "provenance PROVEN" in why, why

@case("F-08: another job's token does not satisfy this job")
def t3(td):
    from merge_guard import mint, verify_merge, TRAILER
    p,base=repo(td); t1_=mint("J1",base); t2_=mint("J2",base)
    assert t1_!=t2_, "tokens must be job-specific"
    git(p,"checkout","-qb","wb/J1"); (p/"f.txt").write_text("w\n")
    git(p,"add","-A"); git(p,"commit","-qm","w"); git(p,"checkout","-q","main")
    git(p,"merge","-q","--no-ff","wb/J1","-m",f"merge\n\n{TRAILER}: J2/{t2_}")
    ok,_=verify_merge(p,"J1",t1_,"main","wb/J1")
    assert not ok, "a different job's trailer must not satisfy this job"

@case("F-08: broken ancestry fails before provenance is even considered")
def t4(td):
    from merge_guard import mint, verify_merge
    p,base=repo(td); tok=mint("J1",base)
    git(p,"checkout","-qb","wb/J1"); (p/"f.txt").write_text("w\n")
    git(p,"add","-A"); git(p,"commit","-qm","w"); git(p,"checkout","-q","main")
    ok,why=verify_merge(p,"J1",tok,"main","wb/J1")
    assert not ok and "ancestry FAILED" in why, why

@case("F-07: every COMMITTED-setting route is guarded")
def t5(td):
    from merge_guard import find_routes
    d=find_routes(HERE)
    assert d["routes"], "no commit route found — the check is not looking"
    unguarded=[f for f in d["files"] if f not in d["guarded_files"]]
    assert not unguarded, f"UNGUARDED merge route(s): {unguarded}"

@case("F-07: an unguarded route added anywhere is detected")
def t6(td):
    from merge_guard import find_routes
    (td/"rogue.py").write_text('rec["state"] = "COMMITTED"\n')
    d=find_routes(td)
    assert "rogue.py" in d["files"] and "rogue.py" not in d["guarded_files"]

CASES=[t1,t2,t3,t4,t5,t6]
def main()->int:
    ap=argparse.ArgumentParser(); ap.add_argument("-v","--verbose",action="store_true")
    ap.add_argument("--prove",action="store_true"); a=ap.parse_args()
    if a.prove:
        print("PDF-003 guard: deliberately wrong expectation.\n")
        @case("DELIBERATELY WRONG")
        def bad(td):
            from merge_guard import find_routes
            (td/"rogue.py").write_text('rec["state"] = "COMMITTED"\n')
            d=find_routes(td)
            assert "rogue.py" in d["guarded_files"], "expected failure — suite can go red"
        bad(); _,ok,msg=_r[-1]
        if ok is None: print(f"  SKIP — {msg}"); return 0
        print(f"  {'FAIL (correct)' if not ok else 'PASS (BROKEN SUITE!)'} — {msg}")
        return 0 if not ok else 1
    for c in CASES: c()
    bad_=[(n,m) for n,ok,m in _r if ok is False]
    skip=[(n,m) for n,ok,m in _r if ok is None]
    for n,ok,m in _r:
        if a.verbose or ok is False:
            print(f"  {'PASS' if ok else 'SKIP' if ok is None else 'FAIL'}  {n}")
            if ok is False: print(f"        {m}")
    for n,m in skip: print(f"  SKIP  {n}  ({m})")
    passed=sum(1 for _,ok,_ in _r if ok is True)
    print(f"\n{passed}/{len(_r)-len(skip)} passed"+(f", {len(skip)} skipped" if skip else ""))
    if skip: print("  NOTE: skipped cases are NOT passes.")
    return 1 if bad_ else 0
if __name__=="__main__": sys.exit(main())
