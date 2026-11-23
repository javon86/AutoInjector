"""CLI: run a section's stress scenarios and write its report.

    cd akowe
    python -m tools.stress.run --section A                 # every part and stress of section A
    python -m tools.stress.run --section A --parts 1       # only part 1
    python -m tools.stress.run --section A --stress a,k    # only stresses a and k (all parts)
    python -m tools.stress.run --section A --seed 7 --no-write

The report (docs/stress/<L>-<slug>.md + <L>-results.json, and the index docs/stress/README.md) is merged by result
ID, so a partial run updates only the rows it ran. Exit code 0 always (findings are results, not failures) unless the
harness itself broke (2).
"""
from __future__ import annotations

import argparse
import sys

from . import core


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m tools.stress.run", description=__doc__.split("\n")[0])
    ap.add_argument("--section", required=True, help="section letter A-G")
    ap.add_argument("--parts", default="", help="comma-separated part ids, e.g. 1 or 10.2,10.3")
    ap.add_argument("--stress", default="", help="comma-separated stress letters, e.g. a,k")
    ap.add_argument("--seed", type=int, default=0, help="seed for probabilistic faults")
    ap.add_argument("--no-write", action="store_true", help="print only; do not touch docs/stress")
    ap.add_argument("--list", action="store_true", help="list the section's scenarios and exit")
    ap.add_argument("--render", action="store_true", help="only rewrite the report from <L>-results.json (e.g. after "
                    "adding analysed findings with Section.finding) — runs nothing")
    a = ap.parse_args(argv)
    sec = core.load_section(a.section)
    parts = [p.strip() for p in a.parts.split(",") if p.strip()] or None
    stresses = [s.strip() for s in a.stress.split(",") if s.strip()] or None
    if a.render:
        md, js = core.write_reports(sec, [], 0)
        print(f"wrote {md} and {js}")
        return 0
    if a.list:
        for s in sec.ordered():
            print(f"{sec.rid(s.part, s.letter):10s} {s.title}" + (f"  ({s.likely})" if s.likely else ""))
        return 0
    try:
        outcomes = core.run_section(sec.letter, parts, stresses, a.seed)
    finally:
        core.cleanup_tmp()
    if not outcomes:
        print("nothing matched --parts/--stress", file=sys.stderr)
        return 2
    counts = {k: sum(1 for o in outcomes if o.result == k) for k in (core.HANDLED, core.SAFE, core.PROBLEM,
                                                                   core.RISKY)}
    print("  ".join(f"{k} {v}" for k, v in counts.items()))
    if not a.no_write:
        md, js = core.write_reports(sec, outcomes, a.seed)
        print(f"wrote {md} and {js}")
    harness_broke = any("HARNESS ERROR" in " ".join(o.notes) for o in outcomes)
    return 2 if harness_broke else 0


if __name__ == "__main__":
    sys.exit(main())
