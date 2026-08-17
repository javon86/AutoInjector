#!/usr/bin/env python3
"""
check_propagation.py — detects world-model drift (PDF-012).

SYSTEM_SPEC §25 lists PROPAGATE and ADVANCE as pipeline stages and §27 requires
a revision to update every document in its `affects` set. Nothing enforced
either, so three chapters were drafted against a story state that still said
chapter zero.

    python check_propagation.py <project_dir> [--ref HEAD]

Exit codes:
    0  propagation current
    1  S1 — one or more required artifacts lag the manuscript
    3  bad invocation
"""
from __future__ import annotations
import argparse, re, sys
from pathlib import Path

# artifact -> human name. Each must record the chapter it is current as of.
REQUIRED = {
    "00_CONTROL/STATE.md":            "project state",
    "03_MEMORY/STATE_SNAPSHOT.md":    "story state snapshot",
    "02_BIBLE/TIMELINE.md":           "timeline",
    "01_DESIGN/SETUP_PAYOFF.md":      "setup/payoff register",
    "01_DESIGN/OPEN_THREADS.md":      "open thread register",
}
CH = re.compile(r"\bCH(\d{2})\b")


def highest_drafted(root: Path) -> int:
    hi = 0
    for p in (root / "04_CHAPTERS").glob("ch*/scenes/*.md"):
        if any(seg.startswith("_") for seg in p.relative_to(root).parts):
            continue
        m = re.search(r"ch(\d+)", str(p))
        if m:
            hi = max(hi, int(m.group(1)))
    return hi


def recorded_chapter(p: Path) -> int | None:
    try:
        found = [int(m) for m in CH.findall(p.read_text(encoding="utf-8"))]
    except OSError:
        return None
    return max(found) if found else None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Detect world-model drift.")
    ap.add_argument("project")
    ap.add_argument("--ref", default="HEAD",
                    help="repository ref evaluated (§4.12.1); recorded")
    args = ap.parse_args(argv)

    root = Path(args.project).expanduser()
    if not (root / "04_CHAPTERS").is_dir():
        print(f"[FATAL] not a project: {root}", file=sys.stderr)
        return 3

    hi = highest_drafted(root)
    if hi == 0:
        print("[OK] no chapters drafted; nothing to propagate")
        return 0

    lag = []
    for rel, name in REQUIRED.items():
        p = root / rel
        if not p.exists():
            lag.append((rel, name, None)); continue
        rec = recorded_chapter(p)
        if rec is None or rec < hi:
            lag.append((rel, name, rec))

    # character DYNAMIC zones must also name the current chapter
    for p in sorted((root / "02_BIBLE" / "characters").glob("*.md")):
        if p.name.startswith("_"):
            continue
        rec = recorded_chapter(p)
        if rec is None or rec < hi:
            lag.append((str(p.relative_to(root)), f"{p.stem} DYNAMIC zone", rec))

    for rel, name, rec in lag:
        at = "never" if rec is None else f"CH{rec:02d}"
        print(f"[S1] {rel}: {name} current as of {at}, manuscript at CH{hi:02d}",
              file=sys.stderr)

    print(f"Checked {len(REQUIRED)} registers + character bibles at ref "
          f"{args.ref}. Manuscript at CH{hi:02d}. {len(lag)} stale.")
    if lag:
        print("        A chapter may not pass its gate with a stale propagation "
              "set (§25 PROPAGATE, §27). The repository is the memory (§1).",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
