#!/usr/bin/env python3
"""test_depgraph.py — regression for A2 (§4.12 derived dependency graph)."""
from __future__ import annotations
import argparse, subprocess, sys, tempfile
from pathlib import Path
HERE = Path(__file__).resolve().parent
_r: list[tuple[str, bool, str]] = []

def run(proj, *a, timeout=60):
    p = subprocess.run([sys.executable, str(HERE/"build_depgraph.py"), str(proj), *a],
                       capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout, p.stderr

def case(n):
    def deco(fn):
        def w():
            with tempfile.TemporaryDirectory() as td:
                try: fn(Path(td)); _r.append((n,True,""))
                except AssertionError as e: _r.append((n,False,str(e)))
                except Exception as e: _r.append((n,False,f"{type(e).__name__}: {e}"))
        return w
    return deco

def project(td: Path, ledger: str, bible: dict) -> Path:
    p = td/"p"; (p/"03_MEMORY").mkdir(parents=True); (p/"02_BIBLE").mkdir()
    (p/"03_MEMORY"/"CANDIDATES.md").write_text(ledger, encoding="utf-8")
    for name, txt in bible.items():
        (p/"02_BIBLE"/name).write_text(txt, encoding="utf-8")
    return p

LB = ('# C\n\n## From CH01\n\n```yaml\n'
      '- id: CAND-0001  entity: E  property: P\n'
      '  value: "40.0 m"\n  units: metres  precision: 0.1 m\n'
      '  provenance: CH01  source_chapter: CH01\n'
      '  classification: LOAD-BEARING\n  affects: [{aff}]\n  status: proposed\n```\n')

@case("A2: affects declares a target the value does NOT reach -> S1")
def t1(td):
    proj = project(td, LB.format(aff="02_BIBLE/TIMELINE.md"),
                   {"TIMELINE.md": "no figure here\n"})
    c,_,e = run(proj)
    assert c == 1 and "does not appear there" in e, e

@case("A2: value reaches an artifact NOT declared in affects -> S2")
def t2(td):
    proj = project(td, LB.format(aff="02_BIBLE/TIMELINE.md"),
                   {"TIMELINE.md": "40.0 m\n", "WORLD.md": "also 40.0 m\n"})
    c,_,e = run(proj)
    assert c == 1 and "NOT declared in affects" in e and "WORLD.md" in e, e

@case("A2: declared == derived passes clean")
def t3(td):
    proj = project(td, LB.format(aff="02_BIBLE/TIMELINE.md"),
                   {"TIMELINE.md": "40.0 m\n"})
    c,o,e = run(proj)
    assert c == 0, f"aligned graph must pass: {e}"
    assert "1 load-bearing" in o and "0 finding(s)" in o, o

@case("A2: non-load-bearing records are counted but not traced")
def t4(td):
    led = ('# C\n\n## From CH01\n\n```yaml\n'
           '- id: CAND-0001  entity: E  property: P\n'
           '  value: "ordinary 40.0 m"  status: proposed\n```\n')
    proj = project(td, led, {"TIMELINE.md": "40.0 m everywhere\n"})
    c,o,_ = run(proj)
    assert c == 0 and "0 load-bearing" in o, o

@case("A2: --json emits nodes and edges")
def t5(td):
    proj = project(td, LB.format(aff="02_BIBLE/TIMELINE.md"),
                   {"TIMELINE.md": "40.0 m\n"})
    c,o,_ = run(proj, "--json")
    assert '"nodes"' in o and '"edges"' in o and '"declared": true' in o, o

@case("A2: missing ledger is FATAL, not a pass")
def t6(td):
    (td/"p").mkdir()
    c,_,e = run(td/"p")
    assert c == 3 and "no candidate ledger" in e, e

CASES=[t1,t2,t3,t4,t5,t6]

def main() -> int:
    ap=argparse.ArgumentParser(); ap.add_argument("-v","--verbose",action="store_true")
    ap.add_argument("--prove",action="store_true"); a=ap.parse_args()
    if a.prove:
        print("PDF-003 guard: deliberately wrong expectation.\n"
              "If this does NOT fail, the suite proves nothing.\n")
        @case("DELIBERATELY WRONG")
        def bad(td):
            proj = project(td, LB.format(aff="02_BIBLE/TIMELINE.md"),
                           {"TIMELINE.md": "no figure\n"})
            c,_,_ = run(proj)
            assert c == 0, "expected failure — suite can go red"
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

if __name__ == "__main__":
    sys.exit(main())
