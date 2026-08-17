#!/usr/bin/env python3
"""
test_book_e2e.py — fresh book generation, new project to final output
(finish-line task 10).

The novella validation run proved the pipeline works with a human driving every
gate. This proves a NEW project goes from scaffold to assembled manuscript with
no manual repair — every gate invoked programmatically, every failure fatal.

    python test_book_e2e.py [-v] [--prove]
"""
from __future__ import annotations
import argparse, json, subprocess, sys, tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
HERE = Path(__file__).resolve().parent
_r: list[tuple[str, bool, str]] = []
S, F = "}-----< Start >-----{", "}-----< finish >-----{"


def run(tool, *a, cwd=None, timeout=120):
    p = subprocess.run([sys.executable, str(HERE / tool), *a], cwd=cwd,
                       capture_output=True, text=True, timeout=timeout)
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


def build_book(td: Path, title: str, chapters: int) -> Path:
    """Scaffold a project and draft it through the authorised write path."""
    rc, _, err = run("init_project.py", title, "--chapters", str(chapters), cwd=td)
    assert rc == 0, f"scaffold failed: {err}"
    proj = td / title.lower().replace(" ", "-")

    from safe_write import write
    for n in range(1, chapters + 1):
        prose = (f"# Chapter {n}\n\nThe survey line moved {n * 3} metres inland "
                 f"that spring, and nobody wrote it down until she did.\n")
        write(proj, f"04_CHAPTERS/ch{n:02d}/scenes/s01.md",
              f"{S}\n{prose}{F}\n",
              role="claude", job_id=f"CH{n:02d}-S01-v1", project_id="e2e-book",
              stamp_provenance=False)

    # registers the gates require
    (proj / "02_BIBLE" / "TIMELINE.md").write_text(
        "# MASTER TIMELINE — current as of CH%02d\n\n| Ch | Date | Tide |\n"
        "|----|------|------|\n" % chapters +
        "".join(f"| {n} | {n+11} May | 06:{40+n:02d} |\n" for n in range(1, chapters + 1)),
        encoding="utf-8")
    (proj / "03_MEMORY" / "CANDIDATES.md").write_text(
        "# CANON CANDIDATES\n\n" + "".join(
            f"\n## From CH{n:02d}-S01\n\n```yaml\n"
            f"- id: CAND-{n:04d}  entity: SURVEY  property: drift\n"
            f'  value: "{n*3}.0 m"  status: proposed\n```\n'
            for n in range(1, chapters + 1)), encoding="utf-8")
    for rel, txt in (
        ("00_CONTROL/STATE.md", f"current as of CH{chapters:02d}\n"),
        ("03_MEMORY/STATE_SNAPSHOT.md", f"as of CH{chapters:02d}\n"),
        ("01_DESIGN/SETUP_PAYOFF.md", f"# SETUP/PAYOFF — current as of CH{chapters:02d}\n"),
        ("01_DESIGN/OPEN_THREADS.md", f"# THREADS — current as of CH{chapters:02d}\n"),
    ):
        (proj / rel).write_text(txt, encoding="utf-8")
    for p in (proj / "02_BIBLE" / "characters").glob("*.md"):
        if not p.name.startswith("_"):
            p.write_text(p.read_text() + f"\n## DYNAMIC — as of CH{chapters:02d}\n",
                         encoding="utf-8")
    return proj


@case("E2E: a fresh 6-chapter book builds with no manual repair")
def t1(td):
    proj = build_book(td, "Fresh Book", 6)
    rc, out, err = run("assemble_manuscript.py", "04_CHAPTERS",
                       "-o", "07_BUILD/manuscript.md", "--strict", cwd=proj)
    assert rc == 0, f"strict build failed: {err}"
    text = (proj / "07_BUILD" / "manuscript.md").read_text()
    assert text.count("# Chapter") == 6, f"expected 6 chapters, got {text.count('# Chapter')}"


@case("E2E: no metadata leaks into the assembled manuscript")
def t2(td):
    proj = build_book(td, "Leak Check", 4)
    run("assemble_manuscript.py", "04_CHAPTERS", "-o", "07_BUILD/m.md",
        "--strict", cwd=proj)
    text = (proj / "07_BUILD" / "m.md").read_text()
    for tok in ("JOB_ID", "authored_by", "CANON", "[TO:", "---"):
        assert tok not in text, f"{tok!r} leaked into the book"


@case("E2E: every gate passes on the generated project")
def t3(td):
    proj = build_book(td, "Gate Check", 5)
    run("assemble_manuscript.py", "04_CHAPTERS", "-o", "07_BUILD/m.md",
        "--strict", cwd=proj)
    for tool in ("check_propagation.py", "check_candidates.py",
                 "validate_timeline.py"):
        rc, out, err = run(tool, str(proj))
        assert rc == 0, f"{tool} failed on a freshly generated book:\n{err}"


@case("E2E: chapters are assembled in canonical order")
def t4(td):
    proj = build_book(td, "Order Check", 8)
    run("assemble_manuscript.py", "04_CHAPTERS", "-o", "07_BUILD/m.md",
        "--strict", cwd=proj)
    import re
    nums = [int(m) for m in re.findall(r"# Chapter (\d+)", 
                                       (proj / "07_BUILD" / "m.md").read_text())]
    assert nums == sorted(nums) == list(range(1, 9)), f"out of order: {nums}"


@case("E2E: a defective chapter fails the build rather than shipping")
def t5(td):
    proj = build_book(td, "Defect Check", 3)
    bad = proj / "04_CHAPTERS" / "ch02" / "scenes" / "s01.md"
    bad.write_text(f"{S}\nouter\n{S}\nnested\n{F}\n", encoding="utf-8")
    rc, _, err = run("assemble_manuscript.py", "04_CHAPTERS",
                     "-o", "07_BUILD/m.md", "--strict", cwd=proj)
    assert rc == 2, f"a nested marker must fail the build, got {rc}"
    assert not (proj / "07_BUILD" / "m.md").exists(), "a defective book was written"


@case("E2E: two fresh books built in sequence do not contaminate each other")
def t6(td):
    a = build_book(td, "Book One", 3)
    b = build_book(td, "Book Two", 3)
    for proj, mark in ((a, "3.0 m"), (b, "3.0 m")):
        run("assemble_manuscript.py", "04_CHAPTERS", "-o", "07_BUILD/m.md",
            "--strict", cwd=proj)
    ta = (a / "07_BUILD" / "m.md").read_text()
    tb = (b / "07_BUILD" / "m.md").read_text()
    assert ta.count("# Chapter") == 3 and tb.count("# Chapter") == 3
    assert "Book One" not in tb and "Book Two" not in ta


CASES = [t1, t2, t3, t4, t5, t6]


def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--prove", action="store_true"); a = ap.parse_args()
    if a.prove:
        print("PDF-003 guard: deliberately wrong expectation.\n")
        @case("DELIBERATELY WRONG")
        def bad(td):
            proj = build_book(td, "Prove Book", 2)
            b = proj / "04_CHAPTERS" / "ch01" / "scenes" / "s01.md"
            b.write_text(f"{S}\nouter\n{S}\nnested\n{F}\n", encoding="utf-8")
            rc, _, _ = run("assemble_manuscript.py", "04_CHAPTERS",
                           "-o", "07_BUILD/m.md", "--strict", cwd=proj)
            assert rc == 0, "expected failure — suite can go red"
        bad(); _, ok, msg = _r[-1]
        print(f"  {'FAIL (correct)' if not ok else 'PASS (BROKEN SUITE!)'} — {msg}")
        return 0 if not ok else 1
    for c in CASES: c()
    bad_ = [(n, m) for n, ok, m in _r if not ok]
    for n, ok, m in _r:
        if a.verbose or not ok:
            print(f"  {'PASS' if ok else 'FAIL'}  {n}")
            if not ok: print(f"        {m}")
    print(f"\n{len(_r)-len(bad_)}/{len(_r)} passed")
    return 1 if bad_ else 0


if __name__ == "__main__":
    sys.exit(main())
