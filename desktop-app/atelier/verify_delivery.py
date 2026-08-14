#!/usr/bin/env python3
"""
verify_delivery.py — validate a multipart specification delivery.

Checks, in order:
  1. every part 01..NN present, exactly once, no duplicates
  2. each part's recomputed SHA-256 matches its stated PART_SHA256
  3. all parts state the same SOURCE_VERSION and WHOLE_SHA256
  4. byte ranges are contiguous, non-overlapping, and cover the whole
  5. reassembled bytes match WHOLE_BYTES and WHOLE_SHA256
  6. (optional) reassembly is byte-identical to a reference source file

    python verify_delivery.py delivery/
    python verify_delivery.py delivery/ --against SYSTEM_SPEC.md

Exit codes:
    0  integrity validated
    2  S0 BUILD FAILURE — do not review this input
    3  bad invocation
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path

BEGIN = re.compile(r"^===== BEGIN PART (\d+) CONTENT =====$", re.M)
END = re.compile(r"^===== END PART (\d+) OF (\d+) =====$", re.M)


def field(text: str, name: str) -> str | None:
    m = re.search(rf"^{re.escape(name)}:\s*(.+)$", text, re.M)
    return m.group(1).strip() if m else None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Verify a multipart delivery.")
    ap.add_argument("directory", help="folder containing SPEC_*_PARTnn_of_NN.txt")
    ap.add_argument("--against", help="reference source file for byte comparison")
    args = ap.parse_args(argv)

    d = Path(args.directory).expanduser()
    if not d.is_dir():
        print(f"[FATAL] not a directory: {d}", file=sys.stderr)
        return 3

    files = sorted(d.glob("SPEC_*_PART*_of_*.txt"))
    if not files:
        print(f"[FATAL] no part files found in {d}", file=sys.stderr)
        return 3

    problems: list[str] = []
    parts: dict[int, dict] = {}

    for f in files:
        try:
            t = f.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as e:
            problems.append(f"{f.name}: unreadable ({e})")
            continue

        mb, me = BEGIN.search(t), END.search(t)
        if not mb or not me:
            problems.append(f"{f.name}: missing BEGIN or END marker — truncated?")
            continue

        num = int(mb.group(1))
        total = int(me.group(2))
        body = t[mb.end() + 1 : me.start()]
        # the newline immediately preceding the END marker belongs to the marker
        if body.endswith("\n\n"):
            body = body[:-1]

        if num in parts:
            problems.append(f"PART {num:02d}: DUPLICATE (also in {parts[num]['file']})")
            continue

        rng = field(t, "BYTE_RANGE") or ""
        rm = re.match(r"\[(\d+),\s*(\d+)\)", rng)
        parts[num] = {
            "file": f.name,
            "total": total,
            "body": body,
            "stated_sha": field(t, "PART_SHA256"),
            "stated_bytes": field(t, "PART_BYTES"),
            "version": field(t, "SOURCE_VERSION"),
            "whole_sha": field(t, "WHOLE_SHA256"),
            "whole_bytes": field(t, "WHOLE_BYTES"),
            "range": (int(rm.group(1)), int(rm.group(2))) if rm else None,
        }

    if not parts:
        print("[FATAL] no parsable parts", file=sys.stderr)
        return 2

    totals = {p["total"] for p in parts.values()}
    if len(totals) != 1:
        problems.append(f"parts disagree on total count: {sorted(totals)}")
    N = max(totals)

    missing = [i for i in range(1, N + 1) if i not in parts]
    if missing:
        problems.append(f"MISSING parts: {', '.join(f'{i:02d}' for i in missing)}")

    versions = {p["version"] for p in parts.values()}
    if len(versions) != 1:
        problems.append(f"parts disagree on SOURCE_VERSION: {sorted(versions)}")

    wholes = {p["whole_sha"] for p in parts.values()}
    if len(wholes) != 1:
        problems.append(f"parts disagree on WHOLE_SHA256: {len(wholes)} distinct")

    # per-part hash and range checks
    prev_end = 0
    for i in sorted(parts):
        p = parts[i]
        b = p["body"].encode("utf-8")
        actual = hashlib.sha256(b).hexdigest()
        if p["stated_sha"] and actual != p["stated_sha"]:
            problems.append(
                f"PART {i:02d}: CORRUPT — sha {actual[:16]}... != stated "
                f"{p['stated_sha'][:16]}...")
        if p["stated_bytes"] and int(p["stated_bytes"]) != len(b):
            problems.append(
                f"PART {i:02d}: byte count {len(b)} != stated {p['stated_bytes']}")
        if p["range"]:
            s, e = p["range"]
            if s != prev_end:
                problems.append(
                    f"PART {i:02d}: range gap/overlap — starts {s}, expected {prev_end}")
            if e - s != len(b):
                problems.append(
                    f"PART {i:02d}: range width {e-s} != body {len(b)}")
            prev_end = e

    rebuilt = "".join(parts[i]["body"] for i in sorted(parts) if i in parts)
    rb = rebuilt.encode("utf-8")
    ref_sha = next(iter(wholes)) if len(wholes) == 1 else None
    actual_whole = hashlib.sha256(rb).hexdigest()

    if not missing and ref_sha and actual_whole != ref_sha:
        problems.append(
            f"REASSEMBLY MISMATCH — got {actual_whole[:16]}..., "
            f"expected {ref_sha[:16]}...")

    stated_wb = next(iter({p["whole_bytes"] for p in parts.values()}), None)
    if not missing and stated_wb and int(stated_wb) != len(rb):
        problems.append(
            f"REASSEMBLY SIZE — got {len(rb)}, expected {stated_wb}")

    if args.against:
        ref = Path(args.against).expanduser()
        try:
            orig = ref.read_bytes()
            if orig != rb:
                problems.append(f"NOT byte-identical to {ref.name}")
            else:
                print(f"  byte-identical to {ref.name}: yes")
        except OSError as e:
            problems.append(f"cannot read reference {ref}: {e}")

    print(f"\nParts found:    {len(parts)} of {N:02d}")
    print(f"SOURCE_VERSION: {next(iter(versions), '?')}")
    print(f"Reassembled:    {len(rb)} bytes")
    print(f"SHA-256:        {actual_whole}")

    if problems:
        print("\nS0 BUILD FAILURE — do not review this input:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 2

    print(f"\nINTEGRITY VALIDATED — {N:02d}/{N:02d} parts, "
          f"{next(iter(versions))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
