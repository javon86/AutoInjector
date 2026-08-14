#!/usr/bin/env python3
"""test_refscope.py — regression for A6 (§4.12.1). Closes IMPL-GAP-001."""
from __future__ import annotations
import argparse, subprocess, sys, tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
HERE=Path(__file__).resolve().parent
_r: list[tuple[str,bool,str]]=[]
import os
GENV={**os.environ,"GIT_TERMINAL_PROMPT":"0","GIT_ASKPASS":"true"}

def git(cwd,*a,timeout=20):
    return subprocess.run(["git",*a],cwd=cwd,capture_output=True,text=True,
                          timeout=timeout,env=GENV)

def have_git()->bool:
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

def repo(td: Path) -> Path:
    if not have_git(): raise Skip("git unavailable")
    p=td/"r"; p.mkdir(); git(p,"init","-q","-b","main")
    git(p,"config","user.email","t@t"); git(p,"config","user.name","t")
    (p/"f.txt").write_text("version one\n"); git(p,"add","-A"); git(p,"commit","-qm","one")
    (p/"f.txt").write_text("version two\n"); git(p,"add","-A"); git(p,"commit","-qm","two")
    return p

@case("A6: read_at returns DIFFERENT content at different refs")
def t1(td):
    from refscope import read_at
    p=repo(td)
    assert read_at(p/"f.txt","HEAD",p).strip()=="version two"
    assert read_at(p/"f.txt","HEAD~1",p).strip()=="version one", \
        "the ref is being ignored — this is IMPL-GAP-001"

@case("A6: WORKTREE reads the working tree and is labelled as such")
def t2(td):
    from refscope import read_at
    p=repo(td); (p/"f.txt").write_text("uncommitted\n")
    assert read_at(p/"f.txt","WORKTREE",p).strip()=="uncommitted"
    assert read_at(p/"f.txt","HEAD",p).strip()=="version two"

@case("A6: an unresolvable ref is S0, not a silent working-tree read")
def t3(td):
    from refscope import read_at, RefError
    p=repo(td)
    try:
        read_at(p/"f.txt","no-such-ref",p)
        raise AssertionError("unresolvable ref must raise, not fall back to disk")
    except RefError:
        pass

@case("A6: a path absent at that ref raises PathNotAtRef")
def t4(td):
    from refscope import read_at, PathNotAtRef
    p=repo(td); (p/"new.txt").write_text("later\n")
    try:
        read_at(p/"new.txt","HEAD",p)
        raise AssertionError("must raise for a path not present at the ref")
    except PathNotAtRef:
        pass

@case("A6: check_manuscript.py EVALUATES --ref rather than reporting it")
def t5(td):
    p=repo(td)
    (p/"a.md").write_text("}-----< Start >-----{\nclean prose\n}-----< finish >-----{\n")
    git(p,"add","-A"); git(p,"commit","-qm","clean")
    (p/"a.md").write_text("}-----< Start >-----{\nTODO: fix this\n}-----< finish >-----{\n")
    r=subprocess.run([sys.executable,str(HERE/"check_manuscript.py"),str(p/"a.md"),
                      "--ref","HEAD"],capture_output=True,text=True,timeout=60)
    assert "IN_BOOK_EDITORIAL" not in r.stderr, \
        "reading the working tree despite --ref HEAD — IMPL-GAP-001 regressed"
    r2=subprocess.run([sys.executable,str(HERE/"check_manuscript.py"),str(p/"a.md")],
                      capture_output=True,text=True,timeout=60)
    assert "IN_BOOK_EDITORIAL" in r2.stderr, "working-tree read should see the TODO"

CASES=[t1,t2,t3,t4,t5]

def main()->int:
    ap=argparse.ArgumentParser(); ap.add_argument("-v","--verbose",action="store_true")
    ap.add_argument("--prove",action="store_true"); a=ap.parse_args()
    if a.prove:
        print("PDF-003 guard: deliberately wrong expectation.\n"
              "If this does NOT fail, the suite proves nothing.\n")
        @case("DELIBERATELY WRONG")
        def bad(td):
            from refscope import read_at
            p=repo(td)
            assert read_at(p/"f.txt","HEAD~1",p).strip()=="version two", \
                "expected failure — suite can go red"
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
    print(f"\n{passed}/{len(_r)-len(skip)} passed" + (f", {len(skip)} skipped" if skip else ""))
    if skip: print("  NOTE: skipped cases are NOT passes.")
    return 1 if bad_ else 0

if __name__=="__main__": sys.exit(main())
