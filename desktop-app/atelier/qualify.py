#!/usr/bin/env python3
"""
qualify.py — final production qualification (finish-line task 11).

Runs every gate, reconciles documented state against the artifacts, and
produces a release manifest. Refuses to declare production-ready while any
blocker stands — a qualification that cannot fail qualifies nothing.

    python qualify.py <program_dir> [--project examples/salt-line] [--json]

Exit codes: 0 qualified · 1 blockers present · 3 bad invocation
"""
from __future__ import annotations
import argparse, hashlib, json, re, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path

BLOCKERS_FILE = "RELEASE_BLOCKERS.json"


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def run(root: Path, script: str, *a, timeout=400):
    p = root / script
    if not p.exists():
        return 3, f"missing {script}"
    try:
        r = subprocess.run([sys.executable, str(p), *a], cwd=root,
                           capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return 1, f"TIMEOUT after {timeout}s"
    return r.returncode, (r.stdout.strip().splitlines() or [""])[-1]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Final production qualification.")
    ap.add_argument("program", nargs="?", default=".")
    ap.add_argument("--project", default="examples/salt-line")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)

    root = Path(a.program).resolve()
    if not (root / "harness.py").exists():
        print(f"[FATAL] not a program directory: {root}", file=sys.stderr)
        return 3

    checks, blockers = [], []

    def check(name, ok, detail):
        checks.append({"check": name, "pass": bool(ok), "detail": detail})
        return ok

    rc, line = run(root, "clean_verify.py")
    check("full regression suite", rc == 0, line)
    if rc != 0:
        blockers.append(f"regression suite not green: {line}")

    rc, line = run(root, "harness.py", "prove")
    check("red-state guards", rc == 0, line)
    if rc != 0:
        blockers.append("one or more suites cannot detect failure")

    rc, line = run(root, "harness.py", "e2e")
    check("end-to-end scaffold and build", rc == 0, line)
    if rc != 0:
        blockers.append(f"e2e failed: {line}")

    proj = root / a.project
    if proj.is_dir():
        rc, line = run(root, "verify_freeze.py", str(proj))
        check("example freeze integrity", rc == 0, line)

    suites = sorted(p.name for p in root.glob("test_*.py"))
    for gate in ("harness.py", "clean_verify.py"):
        txt = (root / gate).read_text(encoding="utf-8")
        missing = [s for s in suites if s.replace(".py", "") not in txt]
        check(f"{gate} covers every suite", not missing,
              f"{len(suites)-len(missing)}/{len(suites)} suites listed")
        if missing:
            blockers.append(f"{gate} omits {', '.join(missing)} — a gate that "
                            f"skips a suite is a gate that passes for the "
                            f"wrong reason")

    # known blockers that cannot be closed from inside this program
    external = []
    readme = (root / "README.txt")
    if readme.exists():
        r = readme.read_text(encoding="utf-8")
        if "NOT ESTABLISHED" in r:
            external.append("cross-machine execution NOT ESTABLISHED "
                            "— requires a second machine")
        if re.search(r"Round 3.*0 of 6|Round 3 independent audit", r):
            external.append("Round 3 independent audit incomplete "
                            "— requires a working auditor channel")
    blockers += external

    tools = {p.name: sha(p) for p in sorted(root.glob("*.py"))}
    manifest = {
        "qualified_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "program_dir": str(root),
        "suites": len(suites),
        "tools": len([t for t in tools if not t.startswith("test_")]),
        "checks": checks,
        "blockers": blockers,
        "status": "QUALIFIED" if not blockers else "BLOCKED",
        "file_hashes": tools,
    }
    (root / BLOCKERS_FILE).write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    if a.json:
        print(json.dumps(manifest, indent=2))
    else:
        for c in checks:
            print(f"  {'PASS' if c['pass'] else 'FAIL'}  {c['check']:<36} {c['detail'][:44]}")
        print()
        if blockers:
            print("  BLOCKERS:")
            for b in blockers:
                print(f"    - {b}")
        print(f"\n  {len(suites)} suites · {manifest['tools']} tools")
        print(f"  STATUS: {manifest['status']}")
        if blockers:
            print("  Production-ready is NOT declared while any blocker stands.")
    return 0 if not blockers else 1


if __name__ == "__main__":
    sys.exit(main())
