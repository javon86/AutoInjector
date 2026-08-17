#!/usr/bin/env python3
"""
provenance.py — artifact provenance schema and validator (task B3).

Evidence: PDF-006, five occurrences of a model reporting work another had done.
Every one was refuted by checking a file, never by argument. Provenance makes
that check mechanical: an artifact without attribution is not evidence.

    python provenance.py stamp <file> --authored-by claude --job-id CH07-S01-v1
    python provenance.py check <dir> [--require-all]
    from provenance import Provenance, extract, validate

Exit codes: 0 ok · 1 findings · 3 bad invocation
"""
from __future__ import annotations
import argparse, re, sys
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path

ROLES = ("claude", "chatgpt", "gemini", "human")
FIELDS = ("authored_by", "authored_at", "job_id")
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
FM = re.compile(r"\A---\n(.*?)\n---\n", re.S)


class ProvenanceError(RuntimeError): ...


@dataclass
class Provenance:
    authored_by: str
    authored_at: str
    job_id: str
    base_version: str = ""
    project_id: str = ""

    def __post_init__(self):
        if self.authored_by.lower() not in ROLES:
            raise ProvenanceError(f"unknown authored_by {self.authored_by!r}; "
                                  f"expected one of {', '.join(ROLES)}")
        if not ISO.match(self.authored_at):
            raise ProvenanceError(f"authored_at {self.authored_at!r} is not "
                                  f"ISO-8601 UTC (YYYY-MM-DDTHH:MM:SSZ)")
        # A future timestamp cannot describe work that has happened.
        from datetime import datetime, timezone, timedelta
        try:
            when = datetime.strptime(self.authored_at, "%Y-%m-%dT%H:%M:%SZ").replace(
                tzinfo=timezone.utc)
            if when > datetime.now(timezone.utc) + timedelta(minutes=5):
                raise ProvenanceError(
                    f"authored_at {self.authored_at} is in the future — a "
                    f"timestamp ahead of now cannot describe completed work")
        except ValueError:
            raise ProvenanceError(f"authored_at {self.authored_at!r} is not a "
                                  f"real date") from None
        if not self.job_id.strip():
            raise ProvenanceError("job_id must not be empty")

    def block(self) -> str:
        d = {k: v for k, v in asdict(self).items() if v}
        return "---\n" + "\n".join(f"{k}: {v}" for k, v in d.items()) + "\n---\n"


def extract(text: str) -> dict:
    m = FM.match(text)
    if not m:
        return {}
    out = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            out[k.strip()] = v.strip()
    return out


def validate(text: str, path: str = "") -> list[str]:
    # Two provenance blocks means two claims of authorship on one artifact.
    # extract() reads the first, so a forged block prepended to a genuine one
    # silently wins. Ambiguous attribution is not attribution.
    if FM.match(text):
        rest = text[FM.match(text).end():]
        if FM.match(rest) and "authored_by" in rest[:400]:
            return [f"{path}: more than one provenance block — attribution is "
                    f"ambiguous and the first block would silently win"]
    d = extract(text)
    if not d:
        return [f"{path}: no provenance block — an artifact without "
                f"attribution is not evidence (PDF-006)"]
    missing = [f for f in FIELDS if f not in d]
    if missing:
        return [f"{path}: provenance missing {', '.join(missing)}"]
    try:
        Provenance(d["authored_by"], d["authored_at"], d["job_id"],
                   d.get("base_version", ""), d.get("project_id", ""))
    except ProvenanceError as e:
        return [f"{path}: {e}"]
    return []


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Artifact provenance.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("stamp"); s.add_argument("file")
    s.add_argument("--authored-by", required=True); s.add_argument("--job-id", required=True)
    s.add_argument("--base-version", default=""); s.add_argument("--project-id", default="")
    c = sub.add_parser("check"); c.add_argument("dir")
    c.add_argument("--glob", default="**/*.md")
    c.add_argument("--require-all", action="store_true",
                   help="every matched file must carry provenance")
    a = ap.parse_args(argv)

    if a.cmd == "stamp":
        f = Path(a.file)
        if not f.exists():
            print(f"[FATAL] no such file: {f}", file=sys.stderr); return 3
        txt = f.read_text(encoding="utf-8")
        if extract(txt):
            print("[OK] already carries provenance"); return 0
        try:
            p = Provenance(a.authored_by, now(), a.job_id, a.base_version, a.project_id)
        except ProvenanceError as e:
            print(f"[S1] {e}", file=sys.stderr); return 1
        f.write_text(p.block() + txt, encoding="utf-8")
        print(f"[OK] stamped {f}"); return 0

    root = Path(a.dir)
    if not root.is_dir():
        print(f"[FATAL] not a directory: {root}", file=sys.stderr); return 3
    files = [f for f in root.glob(a.glob)
             if f.is_file() and not any(s.startswith("_") for s in f.parts)]
    findings, stamped = [], 0
    for f in files:
        txt = f.read_text(encoding="utf-8", errors="replace")
        if not extract(txt) and not a.require_all:
            continue
        errs = validate(txt, str(f.relative_to(root)))
        if errs:
            findings += errs
        else:
            stamped += 1
    for msg in findings:
        print(f"[S2] {msg}", file=sys.stderr)
    print(f"Checked {len(files)} file(s); {stamped} carry valid provenance. "
          f"{len(findings)} finding(s).")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
