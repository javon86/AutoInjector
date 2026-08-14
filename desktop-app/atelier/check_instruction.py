#!/usr/bin/env python3
"""
check_instruction.py — stale-instruction detection (task B4, §4.13).

Evidence: roughly fifteen relay rounds spent correcting text that no longer
existed, plus repeated re-issues of completed stages. An instruction that
references a state the repository has moved past must not mutate anything.

Compares an instruction's quoted strings and version references against the
current artifacts. Stale portions produce no mutation; fresh portions proceed.
Components are split at structural boundaries only (§4.13.1) and any component
containing a conditional is atomic.

    python check_instruction.py <project> --instruction FILE [--json]

Exit codes: 0 all fresh · 1 stale portions found · 3 bad invocation
"""
from __future__ import annotations
import argparse, json, re, sys
from pathlib import Path

QUOTED = re.compile(r'["“]([^"”\n]{12,200})["”]|`([^`\n]{12,200})`')
VERSION = re.compile(r"\bv?(\d+\.\d+\.\d+)\b")
SHA = re.compile(r"\b([a-f0-9]{40,64})\b")
BOUNDARY = re.compile(r"^\s{0,3}(?:\d+[.)]|[-*+]|#{1,6})\s+\S", re.M)
CONDITIONAL = re.compile(r"\b(if|unless|only when|provided that|assuming|"
                         r"subject to|depends? on)\b", re.I)


def corpus(root: Path) -> str:
    parts = []
    for d in ("00_CONTROL", "01_DESIGN", "02_BIBLE", "03_MEMORY", "04_CHAPTERS",
              "07_BUILD", "docs", "registers"):
        p = root / d
        if p.is_dir():
            for f in p.rglob("*"):
                if f.is_file() and f.suffix in (".md", ".json", ".txt"):
                    parts.append(f.read_text(encoding="utf-8", errors="replace"))
    for f in root.glob("*.md"):
        parts.append(f.read_text(encoding="utf-8", errors="replace"))
    return "\n".join(parts)


def components(text: str) -> list[str]:
    idx = [m.start() for m in BOUNDARY.finditer(text)]
    if not idx:
        return [text]
    out = []
    for i, s in enumerate(idx):
        e = idx[i + 1] if i + 1 < len(idx) else len(text)
        out.append(text[s:e].strip())
    return [c for c in out if c]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="§4.13 stale-instruction detection.")
    ap.add_argument("project")
    ap.add_argument("--instruction", required=True)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)

    root = Path(a.project)
    ins = Path(a.instruction)
    if not root.is_dir() or not ins.exists():
        print("[FATAL] project directory or instruction file missing", file=sys.stderr)
        return 3

    body = ins.read_text(encoding="utf-8", errors="replace")
    now = corpus(root)
    results = []

    for comp in components(body):
        atomic = bool(CONDITIONAL.search(comp))
        quotes = [q1 or q2 for q1, q2 in QUOTED.findall(comp)]
        stale_q = [q for q in quotes if q.strip() and q.strip() not in now]
        stale_v = [v for v in VERSION.findall(comp) if v not in now]
        stale_h = [h for h in SHA.findall(comp) if h not in now]
        stale = bool(stale_q or stale_v or stale_h)
        results.append({
            "component": comp.splitlines()[0][:80],
            "atomic": atomic,
            "stale": stale,
            "stale_quotes": stale_q[:3],
            "stale_versions": stale_v[:3],
            "stale_hashes": [h[:12] + "…" for h in stale_h[:3]],
            "disposition": "NO MUTATION — stale" if stale else "may proceed"})

    stale_n = sum(1 for r in results if r["stale"])
    for r in results:
        if r["stale"]:
            det = []
            if r["stale_quotes"]:   det.append(f"quotes not in current state: {r['stale_quotes']}")
            if r["stale_versions"]: det.append(f"versions absent: {r['stale_versions']}")
            if r["stale_hashes"]:   det.append(f"hashes absent: {r['stale_hashes']}")
            print(f"[STALE] {r['component']}\n         " + "; ".join(det)
                  + ("\n         ATOMIC — applied or rejected whole (§4.13.1)"
                     if r["atomic"] else ""), file=sys.stderr)

    if a.json:
        print(json.dumps(results, indent=2))
    else:
        print(f"Checked {len(results)} component(s): {len(results)-stale_n} fresh, "
              f"{stale_n} stale. Stale portions produce NO mutation (§4.13).")
    return 1 if stale_n else 0


if __name__ == "__main__":
    sys.exit(main())
