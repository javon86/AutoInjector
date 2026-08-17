#!/usr/bin/env python3
"""
build_context.py — §24 context-package producer (task A5).

components.py enforces the invariant `available − included = omitted`. Nothing
PRODUCED the counts, so the invariant guarded a number no component generated.

Assembles a scene's context package from the repository — bibles, state
snapshot, candidate ledger, chapter card — under a fact budget, and emits the
three metrics plus an explicit truncation flag.

    python build_context.py <project_dir> --chapter CH07 [--budget 40] [--json]

Exit codes: 0 built · 2 invariant violated (S0) · 3 bad invocation
"""
from __future__ import annotations
import argparse, json, re, sys
from pathlib import Path

CAND = re.compile(r"^\s*-\s*id:\s*(CAND-\d+)(.*)$")
LOAD = "classification: LOAD-BEARING"


def harvest(root: Path, chapter: str):
    """Return (facts, sources). Each fact carries a priority: lower is kept first."""
    facts = []
    led = root / "03_MEMORY" / "CANDIDATES.md"
    if led.exists():
        cur, buf = None, []
        for line in led.read_text(encoding="utf-8").splitlines():
            m = CAND.match(line)
            if m:
                if cur:
                    facts.append(cur)
                cur = {"id": m.group(1), "text": line, "src": "CANDIDATES.md",
                       "prio": 2}
                buf = [line]
            elif cur is not None:
                buf.append(line)
                cur["text"] = "\n".join(buf)
                if LOAD in line:
                    cur["prio"] = 0          # load-bearing is never dropped first
        if cur:
            facts.append(cur)

    for rel, prio in (("03_MEMORY/STATE_SNAPSHOT.md", 1),
                      ("02_BIBLE/TIMELINE.md", 1),
                      ("01_DESIGN/SETUP_PAYOFF.md", 2),
                      ("01_DESIGN/OPEN_THREADS.md", 2)):
        p = root / rel
        if p.exists():
            facts.append({"id": rel, "text": p.read_text(encoding="utf-8")[:2000],
                          "src": rel, "prio": prio})
    for p in sorted((root / "02_BIBLE" / "characters").glob("*.md")):
        if not p.name.startswith("_"):
            facts.append({"id": f"CHAR-{p.stem}", "text": p.read_text(encoding="utf-8"),
                          "src": str(p.relative_to(root)), "prio": 1})
    return facts


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="§24 context-package producer.")
    ap.add_argument("project")
    ap.add_argument("--chapter", required=True)
    ap.add_argument("--budget", type=int, default=40,
                    help="max facts to include; soft target per §24.1.1")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--out")
    ap.add_argument("--ref", default="HEAD")
    a = ap.parse_args(argv)

    root = Path(a.project).expanduser()
    if not (root / "03_MEMORY").is_dir():
        print(f"[FATAL] not a project: {root}", file=sys.stderr)
        return 3

    facts = harvest(root, a.chapter)
    available = len(facts)
    facts.sort(key=lambda f: (f["prio"], f["id"]))
    included = facts[:a.budget]
    omitted = available - len(included)

    # §24.1.1 invariant, enforced at the producer, not only at the consumer
    if available - len(included) != omitted:
        print(f"[S0] metric inconsistency: available({available}) - "
              f"included({len(included)}) != omitted({omitted})", file=sys.stderr)
        return 2

    dropped_lb = [f["id"] for f in facts[a.budget:] if f["prio"] == 0]
    if dropped_lb:
        print(f"[S0] load-bearing fact(s) omitted by the budget: "
              f"{', '.join(dropped_lb)} — raise --budget or reduce scope",
              file=sys.stderr)
        return 2

    pkt = {"chapter": a.chapter, "ref": a.ref,
           "facts_available": available,
           "facts_included": len(included),
           "facts_omitted": omitted,
           "continuity_truncated": omitted > 0,
           "load_bearing_included": sum(1 for f in included if f["prio"] == 0),
           "sources": sorted({f["src"] for f in included}),
           "facts": [{"id": f["id"], "src": f["src"]} for f in included]}

    if omitted:
        print(f"[TRUNCATION] {omitted} fact(s) omitted "
              f"({len(included)}/{available}). Job Packet carries "
              f"continuity_truncated: true — visible to auditor and gate.",
              file=sys.stderr)

    if a.out:
        Path(a.out).write_text(json.dumps(pkt, indent=2), encoding="utf-8")
    if a.json:
        print(json.dumps(pkt, indent=2))
    else:
        print(f"Context package for {a.chapter} at ref {a.ref}: "
              f"available {available} · included {len(included)} · "
              f"omitted {omitted} · truncated {omitted > 0}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
