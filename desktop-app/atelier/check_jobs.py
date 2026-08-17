#!/usr/bin/env python3
"""
check_jobs.py — provisional-decision classifier and gate guard.

Implements SYSTEM_SPEC §4.7 (P1/P2/P3 provisional classes), §29
(PROCESS_VIOLATION vs S0), and the PDF-001 detection rule.

    python check_jobs.py DECISION_LOG.md

Exit codes:
    0  clean
    1  PROCESS_VIOLATION present (attempt blocked; nothing propagated)
    2  S0 present (a P3 provisional was created or inherited)
    3  bad invocation
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

# §4.7 — P3 scope. The named list is illustrative; the catch-all is governing.
P3_SCOPE_TERMS = (
    "premise",
    "canon architecture",
    "canon-system architecture",
    "high-impact canon",
    "major character fate",
    "character fate",
    "ending",
    "authority rule",
    "authority model",
    "structural chapter change",
)

PROCESS_VIOLATION = "PROCESS_VIOLATION"
S0 = "S0"
CLEAN = None


@dataclass
class Decision:
    """A Decision Log entry, reduced to what classification needs."""
    dec_id: str
    status: str = "approved"          # approved | provisional | superseded
    reversal_cost: str = "LOW"        # LOW | MEDIUM | HIGH
    scope: str = ""                   # free text; matched against P3_SCOPE_TERMS
    expensive_propagation: bool = False
    created: bool = False             # entry actually written to the log
    inherited_by: list[str] = field(default_factory=list)  # downstream artifacts

    @property
    def is_p3(self) -> bool:
        """
        P3 by named scope OR by the governing catch-all.

        The catch-all exists because the named list is illustrative. A decision
        that matches nothing on the list but carries HIGH reversal cost or
        expensive downstream propagation is still P3 -- that gap is exactly how
        PDF-001 occurred.
        """
        if self.reversal_cost.upper() == "HIGH":
            return True
        if self.expensive_propagation:
            return True
        s = self.scope.lower()
        return any(term in s for term in P3_SCOPE_TERMS)


def classify(d: Decision) -> str | None:
    """
    Returns S0, PROCESS_VIOLATION, or None.

    The ordering matters: creation/propagation is checked BEFORE the
    attempt case, because a created P3 has by definition also been attempted,
    and reporting the lesser classification would understate a breach.
    """
    if d.status != "provisional":
        return CLEAN
    if not d.is_p3:
        return CLEAN                       # P1/P2 provisional is permitted
    if d.created or d.inherited_by:
        return S0                          # authority mechanism failed
    return PROCESS_VIOLATION               # attempt caught before it took effect


def gate_blocked(decisions: list[Decision]) -> bool:
    """
    Sec.29: no approval gate may pass while an improperly provisional P3 decision
    ACTUALLY EXISTS anywhere in the log, or has propagated downstream. That
    condition is S0.

    A PROCESS_VIOLATION -- an attempt intercepted before creation or propagation
    -- is recorded but does NOT block subsequent gates once contained. If it did,
    a working guard would be indistinguishable in effect from a breach, and the
    incentive would run toward not recording interceptions at all.
    """
    return any(classify(d) == S0 for d in decisions)


# ---------------------------------------------------------------------------
# Minimal Decision Log parser (markdown bullets, as written by the Custodian)
# ---------------------------------------------------------------------------

def parse_log(text: str) -> list[Decision]:
    out: list[Decision] = []
    blocks = re.split(r"^## (DEC-\d+)", text, flags=re.M)
    for i in range(1, len(blocks) - 1, 2):
        dec_id, body = blocks[i], blocks[i + 1]
        low = body.lower()

        status = "approved"
        if re.search(r"\*\*status:\*\*\s*provisional", low) or "status: provisional" in low:
            status = "provisional"

        cost = "LOW"
        m = re.search(r"reversal[_ ]cost:?\*{0,2}\s*\**(low|medium|high)", low)
        if m:
            cost = m.group(1).upper()

        out.append(Decision(
            dec_id=dec_id,
            status=status,
            reversal_cost=cost,
            scope=body,
            expensive_propagation="expensive downstream propagation" in low,
            created=(status == "provisional"),   # present in the log = created
        ))
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Classify provisional decisions.")
    ap.add_argument("log", help="path to DECISION_LOG.md")
    args = ap.parse_args(argv)

    p = Path(args.log).expanduser()
    try:
        text = p.read_text(encoding="utf-8")
    except OSError as e:
        print(f"[FATAL] cannot read {p}: {e}", file=sys.stderr)
        return 3

    decisions = parse_log(text)
    if not decisions:
        print(f"[WARN] no DEC- entries found in {p}", file=sys.stderr)

    worst = CLEAN
    for d in decisions:
        c = classify(d)
        if c:
            print(f"[{c}] {d.dec_id}: P3 provisional "
                  f"(reversal_cost={d.reversal_cost}, created={d.created}, "
                  f"inherited_by={len(d.inherited_by)})", file=sys.stderr)
            if c == S0:
                worst = S0
            elif worst is CLEAN:
                worst = PROCESS_VIOLATION

    if gate_blocked(decisions):
        print("[GATE] BLOCKED — improperly provisional P3 decision open",
              file=sys.stderr)

    print(f"Checked {len(decisions)} decision(s). "
          f"Result: {worst or 'clean'}.")
    return {CLEAN: 0, PROCESS_VIOLATION: 1, S0: 2}[worst]


if __name__ == "__main__":
    sys.exit(main())
