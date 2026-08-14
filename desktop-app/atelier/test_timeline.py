#!/usr/bin/env python3
"""test_timeline.py — regression for A1 (§17 timeline validation)."""
from __future__ import annotations
import argparse, subprocess, sys, tempfile
from pathlib import Path
HERE = Path(__file__).resolve().parent
_r: list[tuple[str, bool, str]] = []

HDR = "# MASTER TIMELINE\n\n| Ch | Date | Tide (low) |\n|----|------|-----------|\n"

def run(proj, *a, timeout=60):
    try:
        p = subprocess.run([sys.executable, str(HERE/"validate_timeline.py"), str(proj), *a],
                           capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise AssertionError(f"timed out after {timeout}s")
    return p.returncode, p.stdout, p.stderr

def case(n):
    def deco(fn):
        def w():
            with tempfile.TemporaryDirectory() as td:
                try: fn(Path(td)); _r.append((n, True, ""))
                except AssertionError as e: _r.append((n, False, str(e)))
                except Exception as e: _r.append((n, False, f"{type(e).__name__}: {e}"))
        return w
    return deco

def project(td: Path, timeline: str) -> Path:
    p = td / "p" / "02_BIBLE"; p.mkdir(parents=True)
    (p / "TIMELINE.md").write_text(timeline, encoding="utf-8")
    return td / "p"

@case("A1: monotonic dates — a backwards chapter is S1")
def t1(td):
    proj = project(td, HDR + "| 1 | 12 May | 06:40 |\n| 2 | 10 May | 07:25 |\n")
    c, _, e = run(proj)
    assert c == 1 and "BEFORE" in e, e

@case("A1: elapsed-time arithmetic mismatch is S1")
def t2(td):
    proj = project(td, HDR + "| 1 | 12 May | 06:40 |\n| 2 | 13 May | 07:25 |\n"
                   + "\n12 May + 30 days = 4 June\n")
    c, _, e = run(proj)
    assert c == 1 and "stated elapsed 30 days, actual 23" in e, e

@case("A1: travel outside a declared tide window is S2")
def t3(td):
    proj = project(td, HDR + "| 1 | 12 May | 06:40 · departed 14:00 |\n"
                   + "\npassable only within 2 h either side of low water\n")
    c, _, e = run(proj)
    assert c == 1 and "outside the ±2.0 h window" in e, e

@case("A1: duplicate chapter with conflicting dates is S1")
def t4(td):
    proj = project(td, HDR + "| 1 | 12 May | 06:40 |\n| 1 | 19 May | 07:25 |\n")
    c, _, e = run(proj)
    assert c == 1 and "appears twice" in e, e

@case("A1: a gap in chapter numbering is S2")
def t5(td):
    proj = project(td, HDR + "| 1 | 12 May | 06:40 |\n| 4 | 16 May | 09:50 |\n")
    c, _, e = run(proj)
    assert c == 1 and "skips chapter" in e and "CH02" in e, e

@case("A1: a sound timeline passes clean")
def t6(td):
    proj = project(td, HDR + "| 1 | 12 May | 06:40 |\n| 2 | 13 May | 07:25 |\n"
                   + "| 3 | 14 May | 08:12 |\n\n12 May + 2 days = 14 May\n")
    c, o, e = run(proj)
    assert c == 0, f"sound timeline must pass: {e}"
    assert "0 finding(s)" in o, o

@case("A1: missing timeline file is a FATAL invocation error, not a pass")
def t7(td):
    (td / "p" / "02_BIBLE").mkdir(parents=True)
    c, _, e = run(td / "p")
    assert c == 3 and "no timeline" in e, e

CASES = [t1, t2, t3, t4, t5, t6, t7]

def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("-v","--verbose",action="store_true")
    ap.add_argument("--prove", action="store_true")
    a = ap.parse_args()
    if a.prove:
        print("PDF-003 guard: deliberately wrong expectation.\n"
              "If this does NOT fail, the suite proves nothing.\n")
        @case("DELIBERATELY WRONG")
        def bad(td):
            proj = project(td, HDR + "| 1 | 12 May | 06:40 |\n| 2 | 10 May | 07:25 |\n")
            c, _, _ = run(proj)
            assert c == 0, "expected failure — suite can go red"
        bad()
        _, ok, msg = _r[-1]
        print(f"  {'FAIL (correct)' if not ok else 'PASS (BROKEN SUITE!)'} — {msg}")
        return 0 if not ok else 1
    for c in CASES: c()
    bad_ = [(n,m) for n,ok,m in _r if not ok]
    for n,ok,m in _r:
        if a.verbose or not ok:
            print(f"  {'PASS' if ok else 'FAIL'}  {n}")
            if not ok: print(f"        {m}")
    print(f"\n{len(_r)-len(bad_)}/{len(_r)} passed")
    return 1 if bad_ else 0

if __name__ == "__main__":
    sys.exit(main())
