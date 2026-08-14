#!/usr/bin/env python3
"""Run the full ATELIER verification set with bounded per-suite execution.

Designed for clean-machine qualification. Produces a machine-readable JSON
report and a concise console summary. A timeout is always a failure.
"""
from __future__ import annotations
import argparse, json, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SUITES = [
    "test_assembler.py", "test_provisional_classifier.py", "test_transaction.py",
    "test_controls.py", "test_propagation.py", "test_candidates.py",
    "test_timeline.py", "test_depgraph.py", "test_knowledge.py",
    "test_registers.py", "test_context.py", "test_refscope.py",
    "test_identity.py", "test_authority.py", "test_provenance.py",
    "test_instruction.py", "test_redelivery.py",
    "test_safe_write.py", "test_capture.py", "test_merge_guard.py",
    "test_concurrency.py", "test_adversarial.py",
    "test_autoinjector.py", "test_book_e2e.py", "test_autobook.py",
]


def run_one(name: str, timeout: int) -> dict:
    path = HERE / name
    started = time.time()
    if not path.exists():
        return {"suite": name, "status": "MISSING", "exit_code": 3,
                "seconds": 0, "stdout": "", "stderr": "file missing"}
    try:
        p = subprocess.run([sys.executable, str(path)], cwd=HERE,
                           capture_output=True, text=True, timeout=timeout)
        status = "PASS" if p.returncode == 0 else "FAIL"
        return {"suite": name, "status": status, "exit_code": p.returncode,
                "seconds": round(time.time()-started, 3),
                "stdout": p.stdout, "stderr": p.stderr}
    except subprocess.TimeoutExpired as e:
        return {"suite": name, "status": "TIMEOUT", "exit_code": 124,
                "seconds": round(time.time()-started, 3),
                "stdout": (e.stdout or "") if isinstance(e.stdout, str) else "",
                "stderr": (e.stderr or "") if isinstance(e.stderr, str) else ""}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeout", type=int, default=300,
                    help="per-suite timeout in seconds (default 300)")
    ap.add_argument("--output", default="CLEAN_VERIFY_RESULTS.json")
    args = ap.parse_args()

    results = []
    for name in SUITES:
        r = run_one(name, args.timeout)
        results.append(r)
        tail = (r["stdout"].strip().splitlines() or [r["stderr"].strip() or ""])[-1]
        print(f"{r['status']:<7} {name:<38} {tail[:80]}", flush=True)

    report = {
        "tool": "clean_verify.py",
        "suite_count": len(results),
        "passed": sum(r["status"] == "PASS" for r in results),
        "failed": sum(r["status"] != "PASS" for r in results),
        "results": results,
    }
    (HERE / args.output).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\n{report['passed']}/{report['suite_count']} suites passed")
    return 0 if report["failed"] == 0 else 1

if __name__ == "__main__":
    raise SystemExit(main())
