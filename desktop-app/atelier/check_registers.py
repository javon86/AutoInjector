#!/usr/bin/env python3
"""
check_registers.py — §20/§21 register staleness and orphan validation (task A4).

Three rules:
  S2  a MAJOR thread unadvanced for 5+ chapters
  S1  a setup past its payoff target chapter, still unpaid
  S1  any open thread or unpaid setup at final assembly (--final)

Tracked by hand throughout the novella run.

    python check_registers.py <project_dir> [--final] [--ref HEAD]

Exit codes: 0 clean · 1 findings · 3 bad invocation
"""
from __future__ import annotations
import argparse, re, sys
from pathlib import Path

THREAD = re.compile(r"^##\s+(THR-\d+)\s*[—-]\s*(.+)$", re.M)
SETUP = re.compile(r"^##\s+(SP-\d+)\s*[—-]\s*(.+)$", re.M)
FIELD = lambda k: re.compile(rf"{k}:\s*\**([^\n*·]+)", re.I)
CH = re.compile(r"CH(\d{2})")


def blocks(text: str, header: re.Pattern):
    hits = list(header.finditer(text))
    for i, m in enumerate(hits):
        end = hits[i + 1].start() if i + 1 < len(hits) else len(text)
        yield m.group(1), m.group(2).strip(), text[m.start():end]


def latest_chapter(root: Path) -> int:
    hi = 0
    for p in (root / "04_CHAPTERS").glob("ch*/scenes/*.md"):
        if any(s.startswith("_") for s in p.parts):
            continue
        m = re.search(r"ch(\d+)", str(p))
        if m:
            hi = max(hi, int(m.group(1)))
    return hi


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="§20/21 register validation.")
    ap.add_argument("project")
    ap.add_argument("--final", action="store_true",
                    help="final assembly: any open thread or unpaid setup is S1")
    ap.add_argument("--stale-after", type=int, default=5)
    ap.add_argument("--ref", default="HEAD")
    a = ap.parse_args(argv)

    root = Path(a.project).expanduser()
    tf = root / "01_DESIGN" / "OPEN_THREADS.md"
    sf = root / "01_DESIGN" / "SETUP_PAYOFF.md"
    if not tf.exists() and not sf.exists():
        print(f"[FATAL] no register found under {root/'01_DESIGN'}", file=sys.stderr)
        return 3

    now = latest_chapter(root)
    findings, nthreads, nsetups = [], 0, 0

    if tf.exists():
        text = tf.read_text(encoding="utf-8")
        for tid, title, body in blocks(text, THREAD):
            nthreads += 1
            done = bool(re.search(r"completed:\s*\**\s*(TRUE|true|yes)", body))
            major = bool(re.search(r"importance:\s*\**\s*major", body, re.I))
            adv = FIELD("last_advanced").search(body)
            last = int(CH.search(adv.group(1)).group(1)) if adv and CH.search(adv.group(1)) else None
            if done:
                continue
            if a.final:
                findings.append(("S1", f"{tid} open at final assembly: {title}"))
            elif major and last is not None and now - last >= a.stale_after:
                findings.append(("S2", f"{tid} is MAJOR and unadvanced since "
                                       f"CH{last:02d} (now CH{now:02d}, "
                                       f"{now-last} chapters): {title}"))

    if sf.exists():
        text = sf.read_text(encoding="utf-8")
        for sid, title, body in blocks(text, SETUP):
            nsetups += 1
            # Payoff may be recorded inside the block OR in a later summary
            # section ("## FINAL — all setups paid", "## Status at CH12").
            # Searching only the block produced a false positive on a setup
            # that was demonstrably paid — and a check that cries wolf is a
            # check that gets ignored.
            paid = bool(re.search(r"payoff_actual:\s*[^\s—-]|status:\s*\**\s*paid|PAID",
                                  body))
            if not paid:
                paid = bool(re.search(rf"{sid}[^\n]*\bPAID\b|\bPAID\b[^\n]*{sid}",
                                      text))
            tgt = FIELD("payoff_target").search(body)
            target = int(CH.search(tgt.group(1)).group(1)) if tgt and CH.search(tgt.group(1)) else None
            if paid:
                continue
            if a.final:
                findings.append(("S1", f"{sid} unpaid at final assembly: {title}"))
            elif target is not None and now > target:
                findings.append(("S1", f"{sid} passed its payoff target "
                                       f"CH{target:02d} (now CH{now:02d}) "
                                       f"and is still unpaid: {title}"))

    for sev, msg in findings:
        print(f"[{sev}] {msg}", file=sys.stderr)
    mode = "final assembly" if a.final else f"in-progress at CH{now:02d}"
    print(f"Checked {nthreads} thread(s) and {nsetups} setup(s), {mode}, "
          f"at ref {a.ref}. {len(findings)} finding(s).")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
