#!/usr/bin/env python3
"""
test_propagation.py — regression suite for PDF-012 (world-model drift).

Three chapters were drafted against a story state that still said chapter zero,
while every chapter gate reported PASS. The gate checks the scene; nothing
checked whether the repository still matched the manuscript.

    python test_propagation.py [-v] [--prove]
"""
from __future__ import annotations
import argparse, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
S, F = "}-----< Start >-----{", "}-----< finish >-----{"
_r: list[tuple[str, bool, str]] = []


def run(tool, *a, cwd=None, timeout=60):
    try:
        p = subprocess.run([sys.executable, str(HERE / tool), *a], cwd=cwd,
                           capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise AssertionError(f"{tool} timed out after {timeout}s")
    return p.returncode, p.stdout, p.stderr


def case(name):
    def deco(fn):
        def w():
            with tempfile.TemporaryDirectory() as td:
                try: fn(Path(td)); _r.append((name, True, ""))
                except AssertionError as e: _r.append((name, False, str(e)))
                except Exception as e: _r.append((name, False, f"{type(e).__name__}: {e}"))
        return w
    return deco


def scaffold(td: Path) -> Path:
    code, _, err = run("init_project.py", "Prop Check", "--chapters", "6", cwd=td)
    assert code == 0, f"scaffold failed: {err}"
    return td / "prop-check"


def draft(proj: Path, n: int, text: str) -> None:
    d = proj / "04_CHAPTERS" / f"ch{n:02d}" / "scenes"
    d.mkdir(parents=True, exist_ok=True)
    (d / "s01.md").write_text(f"{S}\n{text}\n{F}\n", encoding="utf-8")


@case("PDF-012: drafting without propagating is detected as S1")
def t1(td: Path):
    proj = scaffold(td)
    draft(proj, 1, "First chapter prose.")
    draft(proj, 2, "Second chapter prose.")
    code, out, err = run("check_propagation.py", str(proj))
    assert code == 1, f"stale propagation must be S1 (exit 1), got {code}"
    assert "manuscript at CH02" in err, f"must name the manuscript position: {err!r}"
    assert "stale" in out, out
    # it must name the specific artifacts, not just complain
    for expect in ("STATE.md", "STATE_SNAPSHOT.md", "OPEN_THREADS.md"):
        assert expect in err, f"{expect} not reported stale"


@case("PDF-012: propagating every artifact clears the check")
def t2(td: Path):
    proj = scaffold(td)
    draft(proj, 1, "First chapter prose.")
    draft(proj, 2, "Second chapter prose.")
    assert run("check_propagation.py", str(proj))[0] == 1, "should start stale"
    for rel in ("00_CONTROL/STATE.md", "03_MEMORY/STATE_SNAPSHOT.md",
                "02_BIBLE/TIMELINE.md", "01_DESIGN/SETUP_PAYOFF.md",
                "01_DESIGN/OPEN_THREADS.md"):
        p = proj / rel
        p.write_text(p.read_text(encoding="utf-8") + "\n\ncurrent as of CH02\n",
                     encoding="utf-8")
    (proj / "02_BIBLE" / "characters" / "someone.md").write_text(
        "# Someone\n## DYNAMIC — as of CH02\n- arc_position: 1\n", encoding="utf-8")
    code, out, err = run("check_propagation.py", str(proj))
    assert code == 0, f"fully propagated project must pass: {err}"
    assert "0 stale" in out, out


@case("PDF-012: partial propagation still fails — one lagging artifact is enough")
def t3(td: Path):
    proj = scaffold(td)
    draft(proj, 1, "Prose.")
    draft(proj, 2, "Prose.")
    draft(proj, 3, "Prose.")
    for rel in ("00_CONTROL/STATE.md", "03_MEMORY/STATE_SNAPSHOT.md",
                "02_BIBLE/TIMELINE.md", "01_DESIGN/SETUP_PAYOFF.md"):
        p = proj / rel
        p.write_text(p.read_text(encoding="utf-8") + "\ncurrent as of CH03\n",
                     encoding="utf-8")
    # OPEN_THREADS deliberately left behind at CH01
    p = proj / "01_DESIGN" / "OPEN_THREADS.md"
    p.write_text(p.read_text(encoding="utf-8") + "\ncurrent as of CH01\n",
                 encoding="utf-8")
    code, _, err = run("check_propagation.py", str(proj))
    assert code == 1, "one lagging artifact must still fail the check"
    assert "OPEN_THREADS" in err and "CH01" in err, err


@case("PDF-012: an empty project has nothing to propagate")
def t4(td: Path):
    proj = scaffold(td)
    code, out, _ = run("check_propagation.py", str(proj))
    assert code == 0, "no chapters drafted -> nothing to propagate"
    assert "nothing to propagate" in out, out


CASES = [t1, t2, t3, t4]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--prove", action="store_true")
    a = ap.parse_args()
    if a.prove:
        print("PDF-003 guard: deliberately wrong expectation.\n"
              "If this does NOT fail, the suite proves nothing.\n")
        @case("DELIBERATELY WRONG")
        def bad(td: Path):
            proj = scaffold(td); draft(proj, 1, "Prose.")
            code, _, _ = run("check_propagation.py", str(proj))
            assert code == 0, "expected failure — suite can go red"
        bad()
        _, ok, msg = _r[-1]
        print(f"  {'FAIL (correct)' if not ok else 'PASS (BROKEN SUITE!)'} — {msg}")
        return 0 if not ok else 1
    for c in CASES: c()
    bad_ = [(n, m) for n, ok, m in _r if not ok]
    for n, ok, m in _r:
        if a.verbose or not ok:
            print(f"  {'PASS' if ok else 'FAIL'}  {n}")
            if not ok: print(f"        {m}")
    print(f"\n{len(_r) - len(bad_)}/{len(_r)} passed")
    return 1 if bad_ else 0


if __name__ == "__main__":
    sys.exit(main())
