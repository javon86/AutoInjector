#!/usr/bin/env python3
"""
safe_write.py — the single authorised write path (task B6 / control C-05).

authority.py could DECIDE whether a write was permitted, but nothing called it.
Any tool doing `path.write_text(...)` bypassed the whole control — which is the
same shape as ISS-002 itself: the rule existed, nothing enforced it.

Every writer in the program routes through write() here. Direct write_text on a
project path is now the exception that needs justifying, not the default.

    from safe_write import write, WriteRefused
    write(root, "04_CHAPTERS/ch01/scenes/s01.md", text, role="claude",
          job_id="CH01-S01-v1", project_id="salt-line")

Exit codes (CLI): 0 written · 1 refused · 3 bad invocation
"""
from __future__ import annotations
import argparse, sys
from pathlib import Path

from authority import can_write, guard, AuthorityViolation, QUARANTINE

try:
    from provenance import Provenance, extract, now as _now
except ImportError:                                   # standalone use
    Provenance = None


class WriteRefused(RuntimeError): ...


def write(root: Path, rel_path: str, content: str, *, role: str,
          job_id: str = "", project_id: str = "", base_version: str = "",
          stamp_provenance: bool = True) -> Path:
    """
    Authorised, attributed write. Two controls in one call, because separating
    them is how they drift apart: a write can be permitted and unattributed, or
    attributed and unpermitted, and both were live defects (ISS-002, PDF-006).
    """
    root = Path(root)
    if stamp_provenance and Provenance is not None and rel_path.endswith(".md"):
        if not extract(content):
            if not job_id:
                raise WriteRefused(
                    f"{rel_path}: provenance requires job_id — an artifact "
                    f"without attribution is not evidence (PDF-006)")
            content = Provenance(role, _now(), job_id, base_version,
                                 project_id).block() + content
    # SYMLINK ESCAPE. can_write() normalises the STRING; a symlink resolves at
    # the FILESYSTEM. "04_CHAPTERS/link/evil.md" is a clean relative path that
    # lands outside the project when `link` points elsewhere. Found by
    # adversarial sweep. String validation cannot see this — only resolution can.
    target = (root / rel_path)
    try:
        resolved_root = root.resolve(strict=False)
        resolved_target = target.resolve(strict=False)
        resolved_target.relative_to(resolved_root)
    except ValueError:
        raise WriteRefused(
            f"{rel_path}: resolves outside the project root "
            f"({resolved_target}) — symlink or traversal escape") from None

    try:
        return guard(role, root, rel_path, content)
    except AuthorityViolation as e:
        raise WriteRefused(str(e)) from None


def audit_writers(src_dir: Path) -> list[str]:
    """Report tools that write project paths without going through write()."""
    out = []
    for f in sorted(Path(src_dir).glob("*.py")):
        if f.name in ("safe_write.py", "authority.py") or f.name.startswith("test_"):
            continue
        t = f.read_text(encoding="utf-8", errors="replace")
        if ".write_text(" in t and "safe_write" not in t:
            out.append(f.name)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="C-05 authorised write path.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    w = sub.add_parser("write")
    w.add_argument("root"); w.add_argument("path")
    w.add_argument("--role", required=True); w.add_argument("--job-id", default="")
    w.add_argument("--project-id", default=""); w.add_argument("--content", required=True)
    a2 = sub.add_parser("audit"); a2.add_argument("dir", nargs="?", default=".")
    a = ap.parse_args(argv)

    if a.cmd == "audit":
        rogue = audit_writers(Path(a.dir))
        for r in rogue:
            print(f"[C-05] {r} writes directly without safe_write", file=sys.stderr)
        print(f"Audited {a.dir}: {len(rogue)} tool(s) bypass the write path.")
        return 1 if rogue else 0

    try:
        p = write(Path(a.root), a.path, a.content, role=a.role,
                  job_id=a.job_id, project_id=a.project_id)
        print(f"[OK] wrote {p}")
        return 0
    except WriteRefused as e:
        print(f"[REFUSED] {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
