#!/usr/bin/env python3
"""
build_depgraph.py — §4.12 derived dependency graph (task A2).

check_candidates.py verifies that a load-bearing value reaches the targets a
record DECLARES in its `affects` set. Nothing verifies the declaration itself.
This derives the graph from the artifacts and reports declared-vs-derived
divergence, so an under-declared `affects` set is visible.

    python build_depgraph.py <project_dir> [--ref HEAD] [--json]

Exit codes: 0 clean · 1 findings · 3 bad invocation
"""
from __future__ import annotations
import argparse, json, re, sys
from pathlib import Path

REC = re.compile(r"^\s*-\s*id:\s*(CAND-\S+)")
AFFECTS = re.compile(r"affects:\s*\[([^\]]+)\]")
VALUE = re.compile(r'value:\s*"?([^"\n]+)')
NUM = re.compile(r"\d+(?:\.\d+)?")
# Canon-bearing artifacts only. 00_CONTROL holds registers and issue logs that
# quote figures incidentally; treating those as propagation targets produces
# false positives, and a check that cries wolf gets ignored.
SCAN = ("02_BIBLE", "03_MEMORY", "01_DESIGN")


def records(led: Path):
    out, cur = [], None
    for i, line in enumerate(led.read_text(encoding="utf-8").splitlines(), 1):
        m = REC.match(line)
        if m:
            cur = {"id": m.group(1), "line": i, "body": [line]}
            out.append(cur)
        elif cur is not None and line.strip() and not line.startswith("```"):
            cur["body"].append(line)
        elif line.startswith("```"):
            cur = None
    for r in out:
        r["text"] = "\n".join(r["body"])
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="§4.12 derived dependency graph.")
    ap.add_argument("project")
    ap.add_argument("--ref", default="HEAD")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)

    root = Path(a.project).expanduser()
    led = root / "03_MEMORY" / "CANDIDATES.md"
    if not led.exists():
        print(f"[FATAL] no candidate ledger at {led}", file=sys.stderr)
        return 3

    artifacts = []
    for d in SCAN:
        p = root / d
        if p.is_dir():
            artifacts += [f for f in p.rglob("*.md")
                          if not any(s.startswith("_") for s in f.parts)]
    contents = {str(f.relative_to(root)): f.read_text(encoding="utf-8", errors="replace")
                for f in artifacts}

    nodes, edges, findings = [], [], []
    for r in records(led):
        lb = "classification: LOAD-BEARING" in r["text"]
        nodes.append({"id": r["id"], "load_bearing": lb, "line": r["line"]})
        if not lb:
            continue
        vm = VALUE.search(r["text"])
        keys = NUM.findall(vm.group(1)) if vm else []
        keys = [k for k in keys if len(k) >= 3]      # ignore trivial digits
        if not keys:
            continue
        declared = set()
        am = AFFECTS.search(r["text"])
        if am:
            declared = {x.strip() for x in am.group(1).split(",") if x.strip()}
        derived = {rel for rel, txt in contents.items()
                   if any(k in txt for k in keys)}
        derived.discard("03_MEMORY/CANDIDATES.md")   # the ledger itself
        for d in sorted(derived):
            edges.append({"from": r["id"], "to": d,
                          "declared": d in declared})
        under = derived - declared
        if under:
            findings.append(("S2", f"{r['id']}: value appears in "
                                   f"{len(under)} artifact(s) NOT declared in "
                                   f"affects: {', '.join(sorted(under))}"))
        over = declared - derived
        if over:
            findings.append(("S1", f"{r['id']}: affects declares "
                                   f"{', '.join(sorted(over))} but the value "
                                   f"does not appear there"))

    for sev, msg in findings:
        print(f"[{sev}] {msg}", file=sys.stderr)
    if a.json:
        print(json.dumps({"nodes": nodes, "edges": edges}, indent=2))
    else:
        lb = sum(1 for n in nodes if n["load_bearing"])
        print(f"Derived graph at ref {a.ref}: {len(nodes)} node(s), "
              f"{lb} load-bearing, {len(edges)} edge(s), "
              f"{len(artifacts)} artifact(s) scanned. {len(findings)} finding(s).")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
