#!/usr/bin/env python3
"""
check_knowledge.py — §18.4 Knowledge Matrix enforcement (task A3).

A character must not act on a fact before the chapter in which they learn it.
During the novella this was tracked by hand in each character's DYNAMIC zone.

Reads `knows:` entries tagged with an acquisition chapter (e.g. "CH04 — ...")
from 02_BIBLE/characters/*.md, then scans manuscript scenes for the character
acting on that knowledge earlier.

    python check_knowledge.py <project_dir> [--ref HEAD]

Exit codes: 0 clean · 1 findings · 3 bad invocation
"""
from __future__ import annotations
import argparse, re, sys
from pathlib import Path

KNOW_BLOCK = re.compile(r"^\s*-\s*knows:\s*$|^\s*knows:\s*$", re.M)
KNOW_LINE = re.compile(r"^\s*-\s*\*{0,2}(CH(\d{2}))\*{0,2}\s*[—-]\s*(.+?)\s*$")
# a distinctive phrase = the longest quoted or capitalised span in the entry
KEY = re.compile(r"[A-Za-z][\w'’-]{4,}")
STOP = {"which","their","there","about","after","before","would","could",
        "chapter","knows","because","itself","those","these","being","under"}


def scenes(root: Path):
    for p in sorted((root / "04_CHAPTERS").glob("ch*/scenes/*.md")):
        if any(s.startswith("_") for s in p.parts):
            continue
        m = re.search(r"ch(\d+)", str(p))
        t = p.read_text(encoding="utf-8", errors="replace")
        try:
            s, e = t.index("}-----< Start"), t.index("}-----< finish")
        except ValueError:
            continue
        yield int(m.group(1)), p, t[s:e]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="§18.4 Knowledge Matrix.")
    ap.add_argument("project")
    ap.add_argument("--ref", default="HEAD")
    ap.add_argument("--min-key-hits", type=int, default=3,
                    help="distinct key terms that must co-occur to count as "
                         "acting on the fact (default 3, keeps it conservative)")
    a = ap.parse_args(argv)

    root = Path(a.project).expanduser()
    cdir = root / "02_BIBLE" / "characters"
    if not cdir.is_dir():
        print(f"[FATAL] no character bible at {cdir}", file=sys.stderr)
        return 3

    facts = []
    for cf in sorted(cdir.glob("*.md")):
        if cf.name.startswith("_"):
            continue
        name = cf.stem
        inblock = False
        for line in cf.read_text(encoding="utf-8").splitlines():
            if re.match(r"^\s*-?\s*knows:", line):
                inblock = True
                continue
            if inblock:
                m = KNOW_LINE.match(line)
                if m:
                    terms = {w.lower() for w in KEY.findall(m.group(3))
                             if w.lower() not in STOP}
                    if terms:
                        facts.append({"char": name, "ch": int(m.group(2)),
                                      "text": m.group(3), "terms": terms})
                elif line.strip() and not line.lstrip().startswith("-"):
                    inblock = False

    findings = []
    body = list(scenes(root))

    # Distinctiveness filter. Domain vocabulary ("stakes", "seaward") appears in
    # every chapter of a surveying novel; matching on it flags the whole book.
    # A term only counts as evidence of a SPECIFIC fact if it is rare across the
    # corpus. Terms in more than a third of scenes are treated as background.
    from collections import Counter
    df = Counter()
    for _, _, text in body:
        for w in {w.lower() for w in KEY.findall(text)}:
            df[w] += 1
    ceiling = max(1, len(body) // 3)
    for f in facts:
        f["terms"] = {t for t in f["terms"] if df.get(t, 0) <= ceiling}

    for f in facts:
        if not f["terms"]:
            continue
        for ch, path, text in body:
            if ch >= f["ch"]:
                continue
            low = text.lower()
            hits = {t for t in f["terms"] if t in low}
            if len(hits) >= a.min_key_hits:
                findings.append(("S1", f"{f['char']} learns this at CH{f['ch']:02d} "
                                       f"but CH{ch:02d} already contains "
                                       f"{len(hits)} of its key terms "
                                       f"({', '.join(sorted(hits)[:4])}) — "
                                       f"possible acting-on-unknown: {f['text'][:60]}"))

    for sev, msg in findings:
        print(f"[{sev}] {msg}", file=sys.stderr)
    print(f"Checked {len(facts)} dated knowledge fact(s) against {len(body)} "
          f"scene(s) at ref {a.ref}. {len(findings)} finding(s).")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
