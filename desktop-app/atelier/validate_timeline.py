#!/usr/bin/env python3
"""
validate_timeline.py — §17 timeline validation (task A1).

Six checks. During the novella run every one of these was performed by hand,
which is exactly the failure class behind PDF-012/ISS-003/ISS-004: a step the
specification requires, performed by discipline, with nothing that fails when
discipline lapses.

    python validate_timeline.py <project_dir> [--ref HEAD]

Exit codes: 0 clean · 1 S1/S2 findings · 3 bad invocation
"""
from __future__ import annotations
import argparse, re, sys
from datetime import datetime, timedelta
from pathlib import Path

MONTHS = ("January February March April May June July August September "
          "October November December").split()
ROW = re.compile(r"^\|\s*(?:CH)?(\d+)\s*\|\s*([^|]+?)\s*\|([^|]*)\|", re.I)
DATE = re.compile(r"(\d{1,2})\s+(" + "|".join(MONTHS) + r")", re.I)
CLOCK = re.compile(r"\b([01]?\d|2[0-3]):([0-5]\d)\b")
# travel constraints declared in the timeline, e.g.
# "Kell Head -> Sanders Point is 6 km ... only within 2 h either side of low water"
WINDOW = re.compile(r"(\d+(?:\.\d+)?)\s*h\s+either side", re.I)


def parse_date(s: str, year: int = 2026) -> datetime | None:
    m = DATE.search(s)
    if not m:
        return None
    return datetime(year, MONTHS.index(m.group(2).capitalize()) + 1, int(m.group(1)))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="§17 timeline validation.")
    ap.add_argument("project")
    ap.add_argument("--ref", default="HEAD",
                    help="repository ref evaluated (§4.12.1); recorded")
    a = ap.parse_args(argv)

    root = Path(a.project).expanduser()
    tl = root / "02_BIBLE" / "TIMELINE.md"
    if not tl.exists():
        print(f"[FATAL] no timeline at {tl}", file=sys.stderr)
        return 3
    text = tl.read_text(encoding="utf-8")
    findings: list[tuple[str, str]] = []

    rows = []
    for line in text.splitlines():
        m = ROW.match(line)
        if not m:
            continue
        ch, when, tide = m.group(1), m.group(2), m.group(3)
        d = parse_date(when)
        if d:
            rows.append({"ch": int(ch), "date": d, "raw": when.strip(),
                         "tide": tide.strip()})

    if not rows:
        print(f"[WARN] no dated chapter rows found in {tl.name}")
        print(f"Checked 0 chapter rows at ref {a.ref}. 0 finding(s).")
        return 0

    # CHECK 1 — monotonic chapter dates
    for prev, cur in zip(rows, rows[1:]):
        if cur["date"] < prev["date"]:
            findings.append(("S1", f"CH{cur['ch']:02d} dated {cur['raw']} is "
                                   f"BEFORE CH{prev['ch']:02d} ({prev['raw']}) "
                                   f"— chapter dates must not go backwards"))

    # CHECK 2 — elapsed-time arithmetic against any stated span
    span = re.search(r"(\d{1,2})\s+(\w+)\s*\+\s*(\d+)\s*days?\s*=\s*(\d{1,2})\s+(\w+)",
                     text, re.I)
    if span:
        start = parse_date(f"{span.group(1)} {span.group(2)}")
        end = parse_date(f"{span.group(4)} {span.group(5)}")
        if start and end:
            claimed = int(span.group(3))
            actual = (end - start).days
            if claimed != actual:
                findings.append(("S1", f"stated elapsed {claimed} days, actual "
                                       f"{actual} days ({span.group(0).strip()})"))

    # CHECK 3 — travel feasibility inside a declared tide window
    win = WINDOW.search(text)
    if win:
        hours = float(win.group(1))
        for r in rows:
            times = CLOCK.findall(r["tide"])
            if not times:
                continue
            lw = timedelta(hours=int(times[0][0]), minutes=int(times[0][1]))
            for hh, mm in times[1:]:
                t = timedelta(hours=int(hh), minutes=int(mm))
                if abs((t - lw).total_seconds()) > hours * 3600:
                    findings.append(("S2", f"CH{r['ch']:02d}: {hh}:{mm} falls "
                                           f"outside the ±{hours} h window around "
                                           f"low water {times[0][0]}:{times[0][1]}"))

    # CHECK 4 — clock times are valid (regex guarantees range; catch 24:xx text)
    for bad in re.findall(r"\b(2[4-9]|[3-9]\d):[0-5]\d\b", text):
        findings.append(("S2", f"invalid clock time beginning {bad}:"))

    # CHECK 5 — no duplicate chapter rows
    seen: dict[int, str] = {}
    for r in rows:
        if r["ch"] in seen and seen[r["ch"]] != r["raw"]:
            findings.append(("S1", f"CH{r['ch']:02d} appears twice with "
                                   f"different dates: {seen[r['ch']]} / {r['raw']}"))
        seen[r["ch"]] = r["raw"]

    # CHECK 6 — chapter numbers contiguous from the first present
    nums = sorted(seen)
    gaps = [n for n in range(nums[0], nums[-1] + 1) if n not in seen]
    if gaps:
        findings.append(("S2", "timeline skips chapter(s): "
                               + ", ".join(f"CH{g:02d}" for g in gaps)))

    for sev, msg in findings:
        print(f"[{sev}] {msg}", file=sys.stderr)
    print(f"Checked {len(rows)} chapter rows, 6 checks, at ref {a.ref}. "
          f"{len(findings)} finding(s).")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
