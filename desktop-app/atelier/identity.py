#!/usr/bin/env python3
"""
identity.py — project identity and namespace isolation (task B1).

transaction.py records branch and base_commit but NO project_id. Two concurrent
books share a job namespace: job "CH07-S01-DRAFT-v1" in book A collides
silently with the same id in book B, and a recovery sweep in one project can
see the other's open transactions.

Namespaces every record by project and refuses cross-project reads.

    python identity.py init <dir> --project-id salt-line --spec-version v0.3.3
    python identity.py stamp <file> --project-id salt-line
    python identity.py check <dir> --project-id salt-line
    from identity import Identity, namespaced, NamespaceViolation

Exit codes: 0 ok · 1 violation · 3 bad invocation
"""
from __future__ import annotations
import argparse, json, re, sys
from dataclasses import dataclass, asdict
from pathlib import Path

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")
IDENTITY_FILE = "00_CONTROL/IDENTITY.json"


class NamespaceViolation(RuntimeError): ...


@dataclass
class Identity:
    project_id: str
    spec_version: str
    branch: str = "main"
    base_commit: str = ""

    def __post_init__(self):
        if not ID_RE.match(self.project_id):
            raise NamespaceViolation(
                f"invalid project_id {self.project_id!r}: lowercase letters, "
                f"digits and hyphens, 2-64 chars")

    def key(self, job_id: str) -> str:
        """Namespaced job key. This is the whole control: an unnamespaced id
        is ambiguous the moment a second project exists."""
        return f"{self.project_id}/{job_id}"

    def to_dict(self) -> dict:
        return asdict(self)


def namespaced(project_id: str, job_id: str) -> str:
    return Identity(project_id, "unset").key(job_id)


def load(root: Path) -> Identity:
    p = root / IDENTITY_FILE
    if not p.exists():
        raise NamespaceViolation(f"no project identity at {p} — every artifact "
                                 f"must be attributable to a project")
    d = json.loads(p.read_text(encoding="utf-8"))
    return Identity(**{k: d[k] for k in ("project_id", "spec_version",
                                         "branch", "base_commit") if k in d})


def assert_same_project(root: Path, expected: str) -> Identity:
    ident = load(root)
    if ident.project_id != expected:
        raise NamespaceViolation(
            f"cross-project access refused: {root} belongs to "
            f"{ident.project_id!r}, caller declared {expected!r}")
    return ident


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Project identity / namespace.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    i = sub.add_parser("init"); i.add_argument("dir")
    i.add_argument("--project-id", required=True)
    i.add_argument("--spec-version", required=True)
    i.add_argument("--branch", default="main"); i.add_argument("--base-commit", default="")
    s = sub.add_parser("stamp"); s.add_argument("file")
    s.add_argument("--project-id", required=True)
    c = sub.add_parser("check"); c.add_argument("dir")
    c.add_argument("--project-id", required=True)
    k = sub.add_parser("key"); k.add_argument("job_id")
    k.add_argument("--project-id", required=True)
    a = ap.parse_args(argv)

    try:
        if a.cmd == "init":
            root = Path(a.dir)
            ident = Identity(a.project_id, a.spec_version, a.branch, a.base_commit)
            p = root / IDENTITY_FILE
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps(ident.to_dict(), indent=2), encoding="utf-8")
            print(f"[OK] {a.project_id} initialised at {p}")
            return 0
        if a.cmd == "check":
            ident = assert_same_project(Path(a.dir), a.project_id)
            print(f"[OK] {a.dir} belongs to {ident.project_id} "
                  f"(spec {ident.spec_version})")
            return 0
        if a.cmd == "key":
            print(namespaced(a.project_id, a.job_id)); return 0
        if a.cmd == "stamp":
            f = Path(a.file)
            if not f.exists():
                print(f"[FATAL] no such file: {f}", file=sys.stderr); return 3
            txt = f.read_text(encoding="utf-8")
            if "project_id:" in txt.split("\n---", 2)[0]:
                print(f"[OK] already stamped"); return 0
            f.write_text(f"---\nproject_id: {a.project_id}\n---\n{txt}",
                         encoding="utf-8")
            print(f"[OK] stamped {f} with {a.project_id}"); return 0
    except NamespaceViolation as e:
        print(f"[S1] {e}", file=sys.stderr); return 1
    return 3


if __name__ == "__main__":
    sys.exit(main())
