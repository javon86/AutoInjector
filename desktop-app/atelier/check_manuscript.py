#!/usr/bin/env python3
"""
check_manuscript.py — detectors for §36 injections 15 and 16.

Injection 15: non-publication material accidentally INSIDE the markers.
Injection 16: manuscript prose accidentally OUTSIDE the markers.

CRITICAL: this tool REPORTS. It never removes, moves, rewrites, or
reinterprets content. Text inside the markers is manuscript membership by
§4.2 regardless of what it says; removing it would require judging that it
does not belong, which the Non-Interpretation Clause forbids.

Detection is permitted and required (§36: detect -> report -> halt).
Correction is a human/Showrunner act, never this tool's.

    python check_manuscript.py <path> [--strict]

Exit codes:
    0  clean
    1  suspicious content reported (advisory)
    2  --strict and findings present  -> halt
    3  bad invocation
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

try:
    from refscope import read_at, RefError, PathNotAtRef
except ImportError:                              # standalone use
    read_at = None

MARKER = re.compile(r"^\ufeff?\s*\}\s*-+\s*<\s*(start|finish)\s*>\s*-+\s*\{\s*$",
                    re.IGNORECASE)

# Handoff/protocol field names (§4.3). Inside the markers these are almost
# certainly a misplaced metadata block, not prose.
FIELD = re.compile(
    r"^\s*(JOB_ID|BASE_VERSION|OUTPUT_VERSION|TO|FROM|CANON REQUESTS|"
    r"CANON CANDIDATES|PROSE OBJECTIONS|CONFIDENCE|RESPONSE REQUIRED|NOTES|"
    r"STATUS|SEVERITY|FINDING ID|SECTION)\s*:", re.IGNORECASE)

ROUTING = re.compile(r"^\s*\[TO:\s*(ALL|CHATGPT|CLAUDE|GEMINI|USER|NONE)\s*\]",
                     re.IGNORECASE)

EDITORIAL = re.compile(r"\b(TODO|FIXME|XXX|WIP|placeholder|\[?draft note\]?|"
                       r"rewrite this|needs work|check this)\b", re.IGNORECASE)

# Out-of-book prose heuristic: a long run of sentence-like text carrying no
# metadata markers is more likely misplaced manuscript than a note.
SENTENCE_END = re.compile(r"[.!?][\"')\]]?\s*$")


@dataclass
class Finding:
    kind: str          # IN_BOOK_METADATA | IN_BOOK_EDITORIAL | OUT_OF_BOOK_PROSE
    file: str
    line: int
    text: str
    why: str

    def __str__(self) -> str:
        return f"[{self.kind}] {self.file}:{self.line}: {self.why}\n    {self.text[:88]}"


def scan_text(text: str, label: str, prose_run: int = 3) -> list[Finding]:
    out: list[Finding] = []
    in_book = False
    run: list[tuple[int, str]] = []

    def flush_outside():
        """A sustained run of sentence-like lines outside the markers."""
        if len(run) >= prose_run:
            sentences = sum(1 for _, l in run if SENTENCE_END.search(l))
            if sentences >= max(2, len(run) // 2):
                n, first = run[0]
                out.append(Finding(
                    "OUT_OF_BOOK_PROSE", label, n, first,
                    f"{len(run)} consecutive prose-like lines outside the markers "
                    f"— possible misplaced manuscript; these bytes will be CUT"))
        run.clear()

    for n, raw in enumerate(text.splitlines(), 1):
        m = MARKER.match(raw)
        if m:
            if not in_book:
                flush_outside()
            in_book = (m.group(1).lower() == "start")
            continue

        line = raw.strip()

        if in_book:
            if not line:
                continue
            if ROUTING.match(raw):
                out.append(Finding("IN_BOOK_METADATA", label, n, line,
                                   "routing tag inside the publication zone"))
            elif FIELD.match(raw):
                out.append(Finding("IN_BOOK_METADATA", label, n, line,
                                   "handoff field inside the publication zone"))
            elif EDITORIAL.search(line):
                out.append(Finding("IN_BOOK_EDITORIAL", label, n, line,
                                   "editorial marker inside the publication zone"))
        else:
            if not line or ROUTING.match(raw) or FIELD.match(raw) or line.startswith("#"):
                flush_outside()
            else:
                run.append((n, line))
    if not in_book:
        flush_outside()
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Detect misplaced manuscript content.")
    ap.add_argument("path")
    ap.add_argument("--strict", action="store_true",
                    help="exit 2 if any finding is reported")
    ap.add_argument("--ref", default="WORKTREE",
                    help="ref to EVALUATE at (§4.12.1). WORKTREE reads the "
                         "working tree; any other value is read via git show")
    ap.add_argument("--prose-run", type=int, default=3)
    args = ap.parse_args(argv)

    p = Path(args.path).expanduser()
    files = ([p] if p.is_file()
             else sorted(f for f in p.rglob("*") if f.is_file()
                         and f.suffix.lower() in (".md", ".txt")))
    if not files:
        print(f"[FATAL] no files at {p}", file=sys.stderr)
        return 3

    # IMPL-GAP-001 CLOSED: --ref is now EVALUATED, not merely reported.
    # Previously this read the working tree and printed the ref in the summary,
    # which presents as compliance while scoping nothing.
    findings: list[Finding] = []
    for f in files:
        try:
            # HEAD is NOT exempt. Treating it as "close enough to disk" is
            # how IMPL-GAP-001 happened: a ref that is honoured only sometimes
            # is a ref that is not honoured. Only WORKTREE reads the tree.
            if read_at is not None and args.ref != "WORKTREE":
                text = read_at(f, args.ref)
            else:
                text = f.read_text(encoding="utf-8", errors="replace")
            findings += scan_text(text, str(f), args.prose_run)
        except OSError as e:
            print(f"[FATAL] {f}: {e}", file=sys.stderr)
            return 3
        except (RefError, PathNotAtRef) as e:
            print(f"[S0] {e}", file=sys.stderr)
            return 3

    for fi in findings:
        print(str(fi), file=sys.stderr)

    print(f"Checked {len(files)} file(s) at ref {args.ref}. "
          f"{len(findings)} finding(s).")
    if findings:
        print("REPORTED ONLY — nothing was removed, moved, or rewritten. "
              "Correction is a human act (§4.2 Non-Interpretation Clause).",
              file=sys.stderr)
    if not findings:
        return 0
    return 2 if args.strict else 1


if __name__ == "__main__":
    sys.exit(main())
