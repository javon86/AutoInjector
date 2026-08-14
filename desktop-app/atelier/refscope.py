#!/usr/bin/env python3
"""
refscope.py — §4.12.1 repository-scoped evaluation (task A6).

Closes IMPL-GAP-001. check_manuscript.py ACCEPTED --ref and ignored it, reading
the working tree instead. A flag accepted and ignored is worse than an absent
one: it presents as compliance, so a downstream check asking "was --ref passed?"
passes while nothing was scoped.

Shared helper. Validators import read_at() instead of Path.read_text() so the
ref is honoured rather than reported.

    python refscope.py --ref <ref> <path>...      # inspect
    from refscope import read_at, resolve_ref     # use

Exit codes: 0 read · 1 path not present at ref · 2 ref unresolvable · 3 bad args
"""
from __future__ import annotations
import argparse, subprocess, sys
from pathlib import Path

GIT_ENV_KEYS = {"GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "true"}


def _git(args: list[str], cwd: Path, timeout: int = 20):
    import os
    env = {**os.environ, **GIT_ENV_KEYS}
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True,
                          text=True, timeout=timeout, env=env)


def resolve_ref(ref: str, repo: Path) -> tuple[bool, str]:
    """Return (ok, resolved_sha_or_reason). HEAD with no repo is a valid
    working-tree read, which is the ONLY case where the working tree is used."""
    if ref == "WORKTREE":
        return True, "WORKTREE"
    try:
        inside = _git(["rev-parse", "--is-inside-work-tree"], repo)
        if inside.returncode != 0:
            return False, "not inside a git work tree"
        r = _git(["rev-parse", "--verify", "--quiet", ref], repo)
        if r.returncode != 0:
            return False, f"ref {ref!r} does not resolve"
        return True, r.stdout.strip()
    except (OSError, subprocess.SubprocessError) as e:
        return False, f"git unavailable: {e}"


def read_at(path: Path, ref: str = "WORKTREE", repo: Path | None = None) -> str:
    """
    Read a file AS OF a ref. This is the whole point of §4.12.1: a validator
    must evaluate the ref it was given, not the files that happen to be on disk.
    """
    path = Path(path)
    if ref == "WORKTREE":
        return path.read_text(encoding="utf-8", errors="replace")
    repo = repo or _repo_root(path)
    ok, why = resolve_ref(ref, repo)
    if not ok:
        raise RefError(f"cannot evaluate at ref {ref!r}: {why}")
    rel = path.resolve().relative_to(repo.resolve())
    r = _git(["show", f"{ref}:{rel.as_posix()}"], repo)
    if r.returncode != 0:
        raise PathNotAtRef(f"{rel.as_posix()} does not exist at ref {ref!r}")
    return r.stdout


class RefError(RuntimeError): ...
class PathNotAtRef(RuntimeError): ...


def _repo_root(start: Path) -> Path:
    p = start.resolve()
    for cand in [p, *p.parents]:
        if (cand / ".git").exists():
            return cand
    return p if p.is_dir() else p.parent


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="§4.12.1 ref-scoped evaluation.")
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--ref", default="WORKTREE",
                    help="ref to evaluate AT. WORKTREE reads the working tree "
                         "and says so; any other value is honoured, not recorded")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)

    first = Path(a.paths[0])
    repo = _repo_root(first)
    ok, resolved = resolve_ref(a.ref, repo)
    if not ok:
        print(f"[S0] {resolved}", file=sys.stderr)
        return 2
    if not a.quiet:
        print(f"evaluating at ref {a.ref} ({resolved[:12] if resolved != 'WORKTREE' else 'working tree'})")

    rc = 0
    for sp in a.paths:
        try:
            text = read_at(Path(sp), a.ref, repo)
            if not a.quiet:
                print(f"  {sp}: {len(text.splitlines())} lines, "
                      f"{len(text.encode())} bytes at {a.ref}")
        except PathNotAtRef as e:
            print(f"[S1] {e}", file=sys.stderr); rc = 1
        except RefError as e:
            print(f"[S0] {e}", file=sys.stderr); return 2
    return rc


if __name__ == "__main__":
    sys.exit(main())
