#!/usr/bin/env python3
"""
assemble_manuscript.py — enforces the STRICT MANUSCRIPT BOUNDARY RULE.

Everything between  }-----< Start >-----{  and  }-----< finish >-----{  is book.
Everything else is not. Position decides. Content is never interpreted.

Usage:
    python assemble_manuscript.py <path> [-o OUT] [--strict] [--report FILE]
                                         [--sep TEXT] [--ext .md,.txt]

    <path>      a file, or a directory of chapter files (recursed, sorted)
    -o          output manuscript path (default: manuscript.md)
    --strict    exit non-zero on ANY problem (use for real builds)
    --report    write a build report listing blocks, words, and problems
    --sep       text inserted between blocks (default: blank line)
    --ext       comma list of extensions to read from a directory

Exit codes:
    0  clean
    1  finished with warnings (non-strict) or nothing to assemble
    2  errors found (unmatched / nested markers, unreadable input)
    3  bad invocation
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------------------
# Marker recognition
#
# Canonical:  }-----< Start >-----{   and   }-----< finish >-----{
# Tolerated:  any dash count >= 1, any inner spacing, any case, trailing
#             whitespace, and a stray BOM. Deliberately NOT tolerated: markers
#             with other text on the same line — that is reported as suspicious
#             so a marker can never be swallowed inside a paragraph.
# ---------------------------------------------------------------------------

_MARKER_CORE = r"\}\s*-+\s*<\s*(start|finish)\s*>\s*-+\s*\{"
MARKER_LINE_RE = re.compile(rf"^\ufeff?\s*{_MARKER_CORE}\s*$", re.IGNORECASE)

# The canonical form. Tolerant parsing exists for recovery, not for normalising
# sloppiness into the culture: --strict fails on any noncanonical marker so the
# canonical form actually stays canonical.
CANONICAL = {"start": "}-----< Start >-----{", "finish": "}-----< finish >-----{"}
MARKER_ANYWHERE_RE = re.compile(_MARKER_CORE, re.IGNORECASE)

# Catches near-misses so a typo'd marker is loudly reported instead of
# silently dumping notes into the book (or silently deleting a chapter).
NEAR_MISS_RE = re.compile(
    r"(\}\s*-+\s*<|>\s*-+\s*\{|<\s*(start|finish)\s*>)", re.IGNORECASE
)

DEFAULT_EXTS = (".md", ".txt", ".markdown")


@dataclass
class Problem:
    level: str          # "ERROR" or "WARN"
    file: str
    line: int
    message: str

    def __str__(self) -> str:
        return f"[{self.level}] {self.file}:{self.line}: {self.message}"


@dataclass
class Block:
    file: str
    start_line: int
    end_line: int
    text: str

    @property
    def words(self) -> int:
        return len(self.text.split())


@dataclass
class Result:
    blocks: list[Block] = field(default_factory=list)
    problems: list[Problem] = field(default_factory=list)
    files_read: list[str] = field(default_factory=list)
    # Files with a nested or unclosed Start. Structural failure is
    # non-emitting in EVERY mode: detection is not the same as non-emission,
    # and a file whose block structure is ambiguous cannot be assembled from
    # at all. Scoped to the offending file; other files are unaffected.
    structural_failures: set[str] = field(default_factory=set)

    @property
    def errors(self) -> list[Problem]:
        return [p for p in self.problems if p.level == "ERROR"]

    @property
    def warnings(self) -> list[Problem]:
        return [p for p in self.problems if p.level == "WARN"]

    @property
    def noncanonical(self) -> list[Problem]:
        return [p for p in self.problems if p.level == "NONCANONICAL"]

    @property
    def words(self) -> int:
        return sum(b.words for b in self.blocks)


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def parse_text(text: str, label: str, result: Result) -> None:
    """Scan one file's text and append its in-book blocks to `result`."""
    open_at: int | None = None
    buffer: list[str] = []

    for lineno, raw in enumerate(text.splitlines(), start=1):
        m = MARKER_LINE_RE.match(raw)

        if m is None:
            # A marker hiding inside a line of other text is never honored,
            # but it is always reported — silence here is how manuscripts rot.
            if MARKER_ANYWHERE_RE.search(raw):
                result.problems.append(Problem(
                    "ERROR", label, lineno,
                    "marker found with other text on the same line; markers "
                    "must sit alone on their own line",
                ))
            elif NEAR_MISS_RE.search(raw):
                result.problems.append(Problem(
                    "WARN", label, lineno,
                    "line resembles a malformed marker; check spelling",
                ))
            if open_at is not None:
                buffer.append(raw)
            continue

        kind = m.group(1).lower()

        if raw.rstrip() != CANONICAL[kind]:
            result.problems.append(Problem(
                "NONCANONICAL", label, lineno,
                f"marker parsed but is not canonical form; expected "
                f"{CANONICAL[kind]!r} — run --normalize-markers to fix",
            ))

        if kind == "start":
            if open_at is not None:
                result.problems.append(Problem(
                    "ERROR", label, lineno,
                    f"nested Start (block still open from line {open_at}); "
                    "blocks cannot nest — file emits NOTHING",
                ))
                result.structural_failures.add(label)
                continue
            open_at = lineno
            buffer = []
        else:  # finish
            if open_at is None:
                result.problems.append(Problem(
                    "ERROR", label, lineno,
                    "finish with no matching Start",
                ))
                continue
            body = "\n".join(buffer).strip("\n")
            if body.strip():
                result.blocks.append(Block(label, open_at, lineno, body))
            else:
                result.problems.append(Problem(
                    "WARN", label, open_at,
                    "empty book block contributed nothing",
                ))
            open_at = None
            buffer = []

    if open_at is not None:
        result.problems.append(Problem(
            "ERROR", label, open_at,
            "Start never closed by a finish; file emits NOTHING "
            "(nothing is guessed into the book)",
        ))
        result.structural_failures.add(label)


def normalize(path: Path, exts: tuple[str, ...]) -> int:
    """Rewrite recoverable marker variants to canonical form, in place."""
    fixed = 0
    for f in collect_files(path, exts):
        try:
            # utf-8-sig strips a leading BOM. Without it the BOM sits before the Start
            # marker, the marker is not recognised at position 0, and a file saved
            # by any Windows editor fails with the misleading error
            # "finish with no matching Start" — pointing at the wrong line entirely.
            lines = f.read_text(encoding="utf-8-sig").splitlines(keepends=True)
        except (OSError, UnicodeDecodeError):
            continue
        changed = False
        for i, raw in enumerate(lines):
            m = MARKER_LINE_RE.match(raw)
            if m is None:
                continue
            canon = CANONICAL[m.group(1).lower()]
            if raw.rstrip("\r\n") != canon:
                nl = "\n" if raw.endswith("\n") else ""
                lines[i] = canon + nl
                changed = True
                fixed += 1
        if changed:
            try:
                f.write_text("".join(lines), encoding="utf-8")
            except OSError as e:
                print(f"[WARN] could not normalize {f}: {e}", file=sys.stderr)
    return fixed


def collect_files(path: Path, exts: tuple[str, ...]) -> list[Path]:
    if path.is_file():
        return [path]
    if path.is_dir():
        found = [
            p for p in sorted(path.rglob("*"), key=lambda q: str(q).lower())
            if p.is_file() and p.suffix.lower() in exts
            # Skip scaffolder templates. A directory or file whose name starts
            # with "_" is a template, not manuscript. Without this a freshly
            # scaffolded project fails its own --strict build on the empty
            # marker block shipped in _TEMPLATE/scenes/s01.md.
            and not any(part.startswith("_") for part in p.relative_to(path).parts)
        ]
        return found
    raise FileNotFoundError(f"no such file or directory: {path}")


def parse_path(path: Path, exts: tuple[str, ...]) -> Result:
    result = Result()
    files = collect_files(path, exts)

    if not files:
        # A directory with no manuscript files is an EMPTY state, not a build
        # error. A freshly scaffolded project is exactly this: templates are
        # excluded (PDF-008), leaving nothing to assemble until the first scene
        # is drafted. Treating empty as an error made every new project
        # unbuildable -- the over-correction of PDF-008 (see PDF-011).
        result.problems.append(Problem(
            "WARN", str(path), 0,
            f"no manuscript files yet (looked for {', '.join(exts)})",
        ))
        return result

    for f in files:
        try:
            text = f.read_text(encoding="utf-8-sig")
        except UnicodeDecodeError:
            try:
                text = f.read_text(encoding="utf-8-sig", errors="replace")
                result.problems.append(Problem(
                    "WARN", str(f), 0,
                    "file was not valid UTF-8; undecodable bytes replaced",
                ))
            except OSError as e:
                result.problems.append(Problem("ERROR", str(f), 0, f"unreadable: {e}"))
                continue
        except OSError as e:
            result.problems.append(Problem("ERROR", str(f), 0, f"unreadable: {e}"))
            continue

        result.files_read.append(str(f))
        parse_text(text, str(f), result)

    return result


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def build_report(result: Result, out_path: Path) -> str:
    lines = [
        "MANUSCRIPT BUILD REPORT",
        "=" * 60,
        f"output:      {out_path}",
        f"files read:  {len(result.files_read)}",
        f"book blocks: {len(result.blocks)}",
        f"word count:  {result.words:,}",
        f"errors:      {len(result.errors)}",
        f"warnings:    {len(result.warnings)}",
        "",
        "BLOCKS",
        "-" * 60,
    ]
    for b in result.blocks:
        lines.append(f"{b.file}:{b.start_line}-{b.end_line}  {b.words:>6,} words")
    if result.problems:
        lines += ["", "PROBLEMS", "-" * 60]
        lines += [str(p) for p in result.problems]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Assemble a manuscript using the strict boundary rule."
    )
    ap.add_argument("path", help="chapter file or directory of chapter files")
    ap.add_argument("-o", "--out", default="manuscript.md")
    ap.add_argument("--strict", action="store_true",
                    help="exit non-zero on any error or warning")
    ap.add_argument("--report", default=None, help="write build report to this file")
    ap.add_argument("--sep", default="\n\n", help="separator between blocks")
    ap.add_argument("--ext", default=",".join(DEFAULT_EXTS),
                    help="comma-separated extensions to read from a directory")
    ap.add_argument("--normalize-markers", action="store_true",
                    help="rewrite recoverable markers to canonical form, in place")
    args = ap.parse_args(argv)

    exts = tuple(
        e if e.startswith(".") else "." + e
        for e in (x.strip().lower() for x in args.ext.split(",")) if e
    )
    if not exts:
        print("[FATAL] --ext produced no extensions", file=sys.stderr)
        return 3

    src = Path(args.path).expanduser()

    if args.normalize_markers:
        try:
            fixed = normalize(src, exts)
        except (OSError, FileNotFoundError) as e:
            print(f"[FATAL] {e}", file=sys.stderr)
            return 2
        print(f"Normalized {fixed} marker(s) to canonical form.")
        if fixed == 0:
            return 0

    try:
        result = parse_path(src, exts)
    except FileNotFoundError as e:
        print(f"[FATAL] {e}", file=sys.stderr)
        return 3

    for p in result.problems:
        print(str(p), file=sys.stderr)

    if args.strict and result.noncanonical:
        print(
            f"[FATAL] strict mode: {len(result.noncanonical)} noncanonical "
            "marker(s); nothing written. Run --normalize-markers.",
            file=sys.stderr,
        )
        return 2

    if result.errors and args.strict:
        print(
            f"[FATAL] strict mode: {len(result.errors)} error(s); "
            "nothing written. Fix markers and rebuild.",
            file=sys.stderr,
        )
        return 2

    # F-06: drop every block originating in a structurally failed file,
    # in all modes. Reported, never repaired -- no content is interpreted.
    if result.structural_failures:
        dropped = [b for b in result.blocks if b.file in result.structural_failures]
        result.blocks = [b for b in result.blocks
                         if b.file not in result.structural_failures]
        for f in sorted(result.structural_failures):
            n = sum(1 for b in dropped if b.file == f)
            print(f"[STRUCTURAL] {f}: emits nothing ({n} block(s) withheld) — "
                  f"nested or unclosed marker", file=sys.stderr)

    if not result.blocks:
        if result.errors:
            print("[FATAL] no in-book content found; nothing written.", file=sys.stderr)
            return 2
        print("[STOP] no in-book content yet; nothing written.", file=sys.stderr)
        return 1

    out_path = Path(args.out).expanduser()
    manuscript = args.sep.join(b.text for b in result.blocks).rstrip() + "\n"

    try:
        if out_path.parent and not out_path.parent.exists():
            out_path.parent.mkdir(parents=True, exist_ok=True)
        # Write to a temp sibling then swap, so a crash never truncates a
        # good manuscript that already exists.
        tmp = out_path.with_suffix(out_path.suffix + ".tmp")
        tmp.write_text(manuscript, encoding="utf-8")
        tmp.replace(out_path)
    except OSError as e:
        print(f"[FATAL] could not write {out_path}: {e}", file=sys.stderr)
        return 2

    report = build_report(result, out_path)
    if args.report:
        try:
            Path(args.report).expanduser().write_text(report, encoding="utf-8")
        except OSError as e:
            print(f"[WARN] could not write report: {e}", file=sys.stderr)

    print(
        f"Wrote {out_path} — {len(result.blocks)} block(s), "
        f"{result.words:,} words, {len(result.errors)} error(s), "
        f"{len(result.warnings)} warning(s)."
    )

    if args.strict and (result.warnings or result.noncanonical):
        return 2
    return 1 if result.errors else 0


if __name__ == "__main__":
    sys.exit(main())
