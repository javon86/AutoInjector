#!/usr/bin/env python3
"""test_autobook.py — regression for automation phases 2-5."""
from __future__ import annotations
import argparse, json, subprocess, sys, tempfile
from pathlib import Path
HERE=Path(__file__).resolve().parent
_r=[]
S,F="}-----< Start >-----{","}-----< finish >-----{"

def run(*a,cwd=None,timeout=300):
    p=subprocess.run([sys.executable,str(HERE/"autobook.py"),*a],cwd=cwd,
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

def book(td: Path, chapters: int, extract_all: bool = True) -> Path:
    subprocess.run([sys.executable,str(HERE/"init_project.py"),"B","--chapters",
                    str(chapters)],cwd=td,capture_output=True,timeout=60)
    p=td/"b"
    for n in range(1,chapters+1):
        d=p/"04_CHAPTERS"/f"ch{n:02d}"/"scenes"; d.mkdir(parents=True,exist_ok=True)
        (d/"s01.md").write_text(f"{S}\n# Chapter {n}\n\nThe line moved {n*3} metres.\n{F}\n")
    led="# CANON CANDIDATES\n"
    for n in range(1,chapters+1):
        if not extract_all and n==2: continue
        led+=(f"\n## From CH{n:02d}-S01\n\n```yaml\n- id: CAND-{n:04d}  entity: E"
              f'  property: P\n  value: "{n*3}.0 m"  status: proposed\n```\n')
    (p/"03_MEMORY"/"CANDIDATES.md").write_text(led)
    for rel in ("00_CONTROL/STATE.md","03_MEMORY/STATE_SNAPSHOT.md",
                "01_DESIGN/SETUP_PAYOFF.md","01_DESIGN/OPEN_THREADS.md",
                "02_BIBLE/TIMELINE.md"):
        (p/rel).write_text(f"current as of CH{chapters:02d}\n")
    for c in (p/"02_BIBLE"/"characters").glob("*.md"):
        if not c.name.startswith("_"):
            c.write_text(c.read_text()+f"\nas of CH{chapters:02d}\n")
    return p

@case("AUTO: an unattended run completes a whole book and builds it")
def t1(td):
    p=book(td,4); run("plan",str(p),"--chapters","4")
    c,o,e=run("run",str(p))
    assert c==0, f"unattended run failed: {e[-300:]}"
    assert "COMPLETE — 4/4" in o, o
    assert (p/"07_BUILD"/"manuscript.md").exists()

@case("AUTO: the run HALTS on the first failing gate, it does not continue")
def t2(td):
    p=book(td,4,extract_all=False); run("plan",str(p),"--chapters","4")
    c,o,e=run("run",str(p))
    assert c==1, f"a failing gate must halt the run, got {c}"
    assert "HALT" in e and "candidates" in e, e
    assert not (p/"07_BUILD"/"manuscript.md").exists(), \
        "a book was built despite a failed gate"

@case("AUTO: halt state is durable and reports where it stopped")
def t3(td):
    p=book(td,4,extract_all=False); run("plan",str(p),"--chapters","4")
    run("run",str(p))
    c,o,_=run("status",str(p))
    assert "HALTED" in o, o
    st=json.loads((p/"00_CONTROL"/"AUTOBOOK.json").read_text())
    assert st["halted"]["reason"]=="candidates gate", st

@case("AUTO: resume continues after a repair without redoing finished chapters")
def t4(td):
    p=book(td,4,extract_all=False); run("plan",str(p),"--chapters","4")
    run("run",str(p))
    led=(p/"03_MEMORY"/"CANDIDATES.md")
    led.write_text(led.read_text().replace(
        "## From CH03-S01",
        '## From CH02-S01\n\n```yaml\n- id: CAND-0002  entity: E  property: P\n'
        '  value: "6.0 m"  status: proposed\n```\n\n## From CH03-S01',1))
    c,o,e=run("resume",str(p))
    assert c==0, f"resume failed: {e[-300:]}"
    assert "COMPLETE — 4/4" in o, o

@case("AUTO: a missing draft halts rather than inventing prose")
def t5(td):
    p=book(td,3)
    (p/"04_CHAPTERS"/"ch02"/"scenes"/"s01.md").unlink()
    run("plan",str(p),"--chapters","3")
    c,o,e=run("run",str(p))
    assert c==1 and "no drafted scene" in e, e
    assert "does not invent prose" in o+e, "must state the boundary plainly"

@case("AUTO: --dry-run executes nothing")
def t6(td):
    p=book(td,3); run("plan",str(p),"--chapters","3")
    c,o,_=run("run",str(p),"--dry-run")
    assert c==0 and "DRY RUN" in o, o
    assert not (p/"07_BUILD"/"manuscript.md").exists()

@case("AUTO: running without a plan is refused")
def t7(td):
    p=book(td,2)
    c,_,e=run("run",str(p))
    assert c==3 and "no plan" in e, e

CASES=[t1,t2,t3,t4,t5,t6,t7]
def main()->int:
    ap=argparse.ArgumentParser(); ap.add_argument("-v","--verbose",action="store_true")
    ap.add_argument("--prove",action="store_true"); a=ap.parse_args()
    if a.prove:
        print("PDF-003 guard: deliberately wrong expectation.\n")
        @case("DELIBERATELY WRONG")
        def bad(td):
            p=book(td,3,extract_all=False); run("plan",str(p),"--chapters","3")
            c,_,_=run("run",str(p))
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
