#!/usr/bin/env python3
"""
test_provisional_classifier.py — regression suite for PDF-001 detection.

Four fixtures required by the Showrunner ruling:
  1. attempted P3 blocked before creation  -> PROCESS_VIOLATION
  2. P3 provisional actually created       -> S0
  3. downstream inheritance from P3        -> S0
  4. approval gate remains blocked while any of the above is open

    python test_provisional_classifier.py [-v] [--prove]

--prove runs a deliberately wrong expectation and passes ONLY if it fails,
demonstrating this suite can go red (PDF-003 guard).
"""

from __future__ import annotations

import argparse
import sys

from check_jobs import (
    Decision, classify, gate_blocked, parse_log, PROCESS_VIOLATION, S0,
)

_results: list[tuple[str, bool, str]] = []


def case(name: str, fn) -> None:
    try:
        fn()
        _results.append((name, True, ""))
    except AssertionError as e:
        _results.append((name, False, str(e)))
    except Exception as e:  # noqa: BLE001
        _results.append((name, False, f"{type(e).__name__}: {e}"))


# --- fixture 1 -------------------------------------------------------------
def f1():
    """Attempt caught before adoption: nothing created, nothing inherited."""
    d = Decision("DEC-900", status="provisional", reversal_cost="HIGH",
                 scope="authority model change", created=False)
    got = classify(d)
    assert got == PROCESS_VIOLATION, (
        f"attempted-but-blocked P3 must be PROCESS_VIOLATION, got {got!r}")


# --- fixture 2 -------------------------------------------------------------
def f2():
    """P3 provisional actually created -> the mechanism failed -> S0."""
    d = Decision("DEC-901", status="provisional", reversal_cost="HIGH",
                 scope="authority model change", created=True)
    got = classify(d)
    assert got == S0, f"created P3 provisional must be S0, got {got!r}"


# --- fixture 3 -------------------------------------------------------------
def f3():
    """Downstream inheritance is S0 even if the entry itself wasn't 'created'."""
    d = Decision("DEC-902", status="provisional", reversal_cost="HIGH",
                 scope="canon-system architecture", created=False,
                 inherited_by=["SEC-18", "SEC-29", "SEC-30"])
    got = classify(d)
    assert got == S0, f"inherited P3 provisional must be S0, got {got!r}"


# --- fixture 4 -------------------------------------------------------------
def f4():
    """Gate stays blocked log-wide, not merely on the originating path."""
    clean = Decision("DEC-903", status="approved", reversal_cost="HIGH")
    p1 = Decision("DEC-904", status="provisional", reversal_cost="LOW",
                  scope="chapter title wording", created=True)
    assert classify(p1) is None, "P1 provisional must be permitted"
    assert not gate_blocked([clean, p1]), "clean + P1 must not block the gate"

    breach = Decision("DEC-905", status="provisional", reversal_cost="HIGH",
                      scope="ending", created=True)
    assert gate_blocked([clean, p1, breach]), \
        "gate must block while any improper P3 provisional is open"

    # A contained PROCESS_VIOLATION is recorded but must NOT block gates.
    # This fixture previously asserted the opposite and passed -- the test
    # encoded a rule the Showrunner later corrected. A green test proves
    # consistency with what you believed, not correctness.
    attempt = Decision("DEC-906", status="provisional", reversal_cost="HIGH",
                       scope="premise", created=False)
    assert classify(attempt) == PROCESS_VIOLATION, "attempt must be recorded"
    assert not gate_blocked([clean, attempt]), \
        "a contained PROCESS_VIOLATION must NOT block subsequent gates"


# --- catch-all coverage ----------------------------------------------------
def f5():
    """The governing catch-all: P3 by cost/propagation with no named scope."""
    by_cost = Decision("DEC-907", status="provisional", reversal_cost="HIGH",
                       scope="something not on the named list", created=True)
    assert classify(by_cost) == S0, "HIGH reversal cost alone must qualify as P3"

    by_prop = Decision("DEC-908", status="provisional", reversal_cost="LOW",
                       scope="unlisted topic", expensive_propagation=True,
                       created=True)
    assert classify(by_prop) == S0, \
        "expensive downstream propagation alone must qualify as P3"

    ordinary = Decision("DEC-909", status="provisional", reversal_cost="LOW",
                        scope="scene transition wording", created=True)
    assert classify(ordinary) is None, \
        "ordinary P1 must not be swept up by the catch-all"


# --- live document ---------------------------------------------------------
def f6():
    """The real DECISION_LOG must be clean: all six decisions are FINAL."""
    from pathlib import Path
    p = Path(__file__).resolve().parent / "DECISION_LOG.md"
    if not p.exists():
        return
    ds = parse_log(p.read_text(encoding="utf-8"))
    assert ds, "parser found no DEC- entries in the live log"
    offenders = [d.dec_id for d in ds if classify(d)]
    assert not offenders, f"live DECISION_LOG has open P3 provisionals: {offenders}"


CASES = [
    ("fixture 1: attempted P3 blocked -> PROCESS_VIOLATION", f1),
    ("fixture 2: P3 provisional created -> S0", f2),
    ("fixture 3: downstream inheritance -> S0", f3),
    ("fixture 4: approval gate blocked log-wide", f4),
    ("catch-all: HIGH cost / expensive propagation qualify as P3", f5),
    ("live DECISION_LOG.md is clean", f6),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--prove", action="store_true")
    args = ap.parse_args()

    if args.prove:
        print("PDF-003 guard: deliberately wrong expectation.\n"
              "If this does NOT fail, the suite proves nothing.\n")
        case("DELIBERATELY WRONG", lambda: (_ for _ in ()).throw(
            AssertionError("expected failure — suite can go red"))
            if classify(Decision("X", status="provisional",
                                 reversal_cost="HIGH", created=True)) == S0
            else None)
        name, ok, msg = _results[-1]
        print(f"  {'FAIL (correct)' if not ok else 'PASS (BROKEN SUITE!)'} — {msg}")
        return 0 if not ok else 1

    for name, fn in CASES:
        case(name, fn)

    failed = [(n, m) for n, ok, m in _results if not ok]
    for name, ok, msg in _results:
        if args.verbose or not ok:
            print(f"  {'PASS' if ok else 'FAIL'}  {name}")
            if not ok:
                print(f"        {msg}")
    print(f"\n{len(_results) - len(failed)}/{len(_results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
