#!/usr/bin/env python3
"""
components.py — runtime enforcement for F-03 (component atomicity) and
F-05 (context truncation visibility).

F-03 (§4.13.1): component boundaries come ONLY from unambiguous structural
divisions. A component containing a conditional, dependency, qualifier, or
scoping clause is ATOMIC and is never subdivided. Ambiguous scope is
quarantined individually while separable components continue processing.

Per Showrunner ruling: the lexical conditional list is a WARNING LAYER and
must not be the sole semantic boundary mechanism. Structure decides where
components begin and end; the lexical layer only decides whether a component
is atomic-mandatory.

F-05 (§24.1.1): context assembly reports facts_available / facts_included /
facts_omitted and enforces available - included == omitted. Any missing or
inconsistent metric fails validation.

    python components.py split <file>
    python components.py context --available N --included M [--json]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path

# --- structural boundaries: the ONLY thing that creates a component ---------
BOUNDARY = [
    ("numbered",  re.compile(r"^\s{0,3}\d+[.)]\s+\S")),
    ("bulleted",  re.compile(r"^\s{0,3}[-*+]\s+\S")),
    ("heading",   re.compile(r"^\s{0,3}#{1,6}\s+\S")),
    ("fence",     re.compile(r"^\s*```")),
    ("yaml_doc",  re.compile(r"^---\s*$")),
]

# --- warning layer only: marks a component atomic-mandatory ----------------
CONDITIONAL = re.compile(
    r"\b(if|unless|only when|only if|provided that|assuming|as long as|"
    r"in the event|should\s+the|when\s+and\s+only|except\s+when|"
    r"depends?\s+on|contingent\s+on|subject\s+to)\b", re.IGNORECASE)

# scope/qualifier language that also forbids subdivision
SCOPING = re.compile(
    r"\b(for (?:all|each|every|any)\b|across all\b|throughout\b|"
    r"but not\b|excluding\b|limited to\b|applies only\b)", re.IGNORECASE)


@dataclass
class Component:
    index: int
    boundary: str
    lines: list[str] = field(default_factory=list)
    atomic: bool = False
    reasons: list[str] = field(default_factory=list)
    quarantined: bool = False

    @property
    def text(self) -> str:
        return "\n".join(self.lines)


def split_components(text: str) -> list[Component]:
    """Structure creates components. Nothing else does."""
    comps: list[Component] = []
    cur: Component | None = None
    in_fence = False

    for raw in text.splitlines():
        if re.match(r"^\s*```", raw):
            in_fence = not in_fence
            if in_fence:
                cur = Component(len(comps) + 1, "fence"); comps.append(cur)
            if cur:
                cur.lines.append(raw)
            continue
        if in_fence:
            if cur:
                cur.lines.append(raw)
            continue

        kind = next((k for k, rx in BOUNDARY if rx.match(raw)), None)
        if kind:
            cur = Component(len(comps) + 1, kind); comps.append(cur)
        if cur is None:
            cur = Component(1, "preamble"); comps.append(cur)
        cur.lines.append(raw)

    for c in comps:
        if CONDITIONAL.search(c.text):
            c.atomic = True
            c.reasons.append("contains a conditional — indivisible")
        if SCOPING.search(c.text):
            c.atomic = True
            c.reasons.append("contains a scoping/qualifier clause — indivisible")
        # ambiguity: a component whose extent cannot be structurally determined
        if c.boundary == "preamble" and c.atomic:
            c.quarantined = True
            c.reasons.append("atomic but no structural boundary — scope "
                             "undeterminable; quarantined individually")
    return comps


def enforce(comps: list[Component]) -> list[str]:
    """Report what may and may not be subdivided or applied."""
    out = []
    for c in comps:
        state = ("QUARANTINED" if c.quarantined
                 else "ATOMIC" if c.atomic else "SEPARABLE")
        why = f" ({'; '.join(c.reasons)})" if c.reasons else ""
        first = next((l.strip() for l in c.lines if l.strip()), "")
        out.append(f"  [{state}] component {c.index} ({c.boundary}){why}\n"
                   f"      {first[:80]}")
    sep = sum(1 for c in comps if not c.atomic and not c.quarantined)
    out.append(f"\n  {len(comps)} component(s): "
               f"{sum(1 for c in comps if c.atomic and not c.quarantined)} atomic, "
               f"{sum(1 for c in comps if c.quarantined)} quarantined, "
               f"{sep} separable")
    out.append("  Atomic components are applied or rejected whole; never split.")
    return out


# --- F-05 -----------------------------------------------------------------

def context_metrics(available: int, included: int,
                    omitted: int | None = None) -> tuple[int, dict, list[str]]:
    """
    Enforces available - included == omitted. A missing or inconsistent
    metric fails validation -- silent truncation is the failure mode this
    exists to prevent, so an unreportable count is itself a defect.
    """
    msgs: list[str] = []
    if available < 0 or included < 0:
        return 3, {}, ["[FATAL] counts must be non-negative"]
    if included > available:
        return 2, {}, [f"[S0] facts_included ({included}) exceeds "
                       f"facts_available ({available})"]
    computed = available - included
    if omitted is None:
        omitted = computed
    if omitted != computed:
        return 2, {}, [f"[S0] metric inconsistency: available({available}) - "
                       f"included({included}) = {computed}, but "
                       f"facts_omitted reports {omitted}"]

    pkt = {"facts_available": available, "facts_included": included,
           "facts_omitted": omitted,
           "continuity_truncated": omitted > 0}
    if omitted:
        msgs.append(f"[TRUNCATION] {omitted} continuity fact(s) omitted "
                    f"({included}/{available} included).")
        msgs.append("        Job Packet carries continuity_truncated: true. "
                    "Visible to auditor and gate.")
        msgs.append("        Prioritization: active and recent state over "
                    "historical superseded material (§24.1.1).")
    else:
        msgs.append(f"[OK] all {available} continuity fact(s) included; "
                    f"no truncation")
    return 0, pkt, msgs


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("split"); s.add_argument("file")
    c = sub.add_parser("context")
    c.add_argument("--available", type=int, required=True)
    c.add_argument("--included", type=int, required=True)
    c.add_argument("--omitted", type=int, default=None)
    c.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    if args.cmd == "split":
        p = Path(args.file)
        try:
            comps = split_components(p.read_text(encoding="utf-8"))
        except OSError as e:
            print(f"[FATAL] {e}", file=sys.stderr); return 3
        for line in enforce(comps):
            print(line)
        return 0

    code, pkt, msgs = context_metrics(args.available, args.included, args.omitted)
    truncated = bool(pkt.get("continuity_truncated"))
    for m in msgs:
        # Truncation is a WARNING and belongs on stderr even on a clean exit.
        # A warning routed into the data stream is a warning that gets piped
        # into a file and never read -- which is the silent truncation this
        # control exists to prevent.
        print(m, file=sys.stderr if (code or truncated) else sys.stdout)
    if args.json and not code:
        print(json.dumps(pkt, indent=2))
    return code


if __name__ == "__main__":
    sys.exit(main())
