#!/usr/bin/env python3
"""
harness.py — single end-to-end execution runner (task B6 / control C-24).

Replaces ad-hoc script invocation. Nine of the project's defects were found by
RUNNING the system in a way it had not been run before; this makes those runs a
command rather than a habit.

    python harness.py suites                 all regression suites
    python harness.py prove                  every red-state guard
    python harness.py validate <project>     every validator against a project
    python harness.py e2e                    scaffold -> build -> validate
    python harness.py all [<project>]        everything, one exit code

Exit codes: 0 all green · 1 one or more red · 3 bad invocation
"""
from __future__ import annotations
import argparse, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SUITES = ["test_assembler", "test_provisional_classifier", "test_transaction",
          "test_controls", "test_propagation", "test_candidates",
          "test_timeline", "test_depgraph", "test_knowledge", "test_registers",
          "test_context", "test_refscope", "test_identity", "test_authority",
          "test_provenance", "test_instruction", "test_redelivery",
          "test_safe_write", "test_capture", "test_merge_guard",
          "test_concurrency", "test_adversarial",
          "test_autoinjector", "test_book_e2e", "test_autobook"]
VALIDATORS = ["validate_timeline", "build_depgraph", "check_knowledge",
              "check_registers", "check_propagation", "check_candidates"]


def run(script: str, *args, timeout: int = 120) -> tuple[int, str]:
    p = HERE / f"{script}.py"
    if not p.exists():
        return 3, f"missing: {script}.py"
    try:
        r = subprocess.run([sys.executable, str(p), *args],
                           capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return 1, f"TIMEOUT after {timeout}s — a suite that cannot finish is red"
    last = (r.stdout.strip().splitlines() or [""])[-1]
    return r.returncode, last


def section(title: str) -> None:
    print(f"\n=== {title} ===")


def do_suites() -> int:
    section("REGRESSION SUITES")
    bad = 0
    for s in SUITES:
        rc, line = run(s)
        print(f"  {'PASS' if rc == 0 else 'FAIL'}  {s+'.py':<34} {line}")
        bad += rc != 0
    return bad


def do_prove() -> int:
    section("RED-STATE GUARDS (each MUST fail)")
    bad = 0
    for s in SUITES:
        rc, line = run(s, "--prove")
        ok = "FAIL (correct)" in line or "SKIP" in line
        print(f"  {'OK  ' if ok else 'BAD '}  {s+'.py':<34} {line[:60]}")
        bad += 0 if ok else 1
    return bad


def do_validate(project: str) -> int:
    section(f"VALIDATORS against {project}")
    bad = 0
    for v in VALIDATORS:
        rc, line = run(v, project)
        print(f"  {'PASS' if rc == 0 else 'FLAG'}  {v+'.py':<24} {line[:70]}")
        bad += rc not in (0, 1)          # 1 is a finding, not a harness failure
    rc, line = run("build_context", project, "--chapter", "CH01")
    print(f"  {'PASS' if rc == 0 else 'FAIL'}  build_context.py         {line[:70]}")
    return bad + (rc != 0)


def do_e2e() -> int:
    section("END-TO-END  scaffold -> build -> validate")
    with tempfile.TemporaryDirectory() as td:
        rc, line = run("init_project", "Harness Check", "--chapters", "6",
                       *(), timeout=60)
        # init_project writes into CWD, so run it inside the temp dir
        r = subprocess.run([sys.executable, str(HERE / "init_project.py"),
                            "Harness Check", "--chapters", "6"],
                           cwd=td, capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            print(f"  FAIL  scaffold: {r.stderr.strip()[:80]}"); return 1
        proj = Path(td) / "harness-check"
        print(f"  PASS  scaffold           {len(list(proj.rglob('*')))} entries")

        a = subprocess.run([sys.executable, str(HERE / "assemble_manuscript.py"),
                            "04_CHAPTERS", "-o", "07_BUILD/m.md", "--strict"],
                           cwd=proj, capture_output=True, text=True, timeout=60)
        if a.returncode != 1 or "STOP" not in a.stderr:
            print(f"  FAIL  empty build should STOP(1), got {a.returncode}"); return 1
        print("  PASS  empty scaffold      STOP(1), nothing written")

        (proj / "04_CHAPTERS" / "s.md").write_text(
            "}-----< Start >-----{\nProse here.\n}-----< finish >-----{\n",
            encoding="utf-8")
        b = subprocess.run([sys.executable, str(HERE / "assemble_manuscript.py"),
                            "04_CHAPTERS", "-o", "07_BUILD/m.md", "--strict"],
                           cwd=proj, capture_output=True, text=True, timeout=60)
        out = (proj / "07_BUILD" / "m.md")
        if b.returncode != 0 or out.read_text().strip() != "Prose here.":
            print(f"  FAIL  one-scene build: rc={b.returncode}"); return 1
        print("  PASS  one scene           exit 0, exact bytes")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="C-24 end-to-end execution harness.")
    ap.add_argument("mode", choices=["suites", "prove", "validate", "e2e", "all"])
    ap.add_argument("project", nargs="?")
    a = ap.parse_args(argv)

    bad = 0
    if a.mode in ("suites", "all"):
        bad += do_suites()
    if a.mode in ("prove", "all"):
        bad += do_prove()
    if a.mode == "validate" or (a.mode == "all" and a.project):
        if not a.project:
            print("[FATAL] validate needs a project path", file=sys.stderr); return 3
        bad += do_validate(a.project)
    if a.mode in ("e2e", "all"):
        bad += do_e2e()

    print(f"\n{'ALL GREEN' if bad == 0 else f'{bad} FAILURE(S)'}")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
