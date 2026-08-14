#!/usr/bin/env python3
"""
merge_guard.py — merge-route exclusivity and transaction provenance
(tasks C-12 / F-07 and C-13 / F-08).

F-07: the stale guard runs inside `transaction.py commit`, so it is unavoidable
      IN THAT ENTRY POINT. Nothing proved no other route exists.
F-08: `git merge-base --is-ancestor` proves the branch is reachable from the
      target. It does NOT prove THIS transaction produced that merge — a branch
      merged by another process satisfies it.

Two mechanisms, honestly scoped:

  ROUTE EXCLUSIVITY (F-07) — enumerate every path that can advance a job to
  COMMITTED and assert exactly one exists. This is checkable; "no other route
  exists anywhere" is not, so the check reports what it inspected.

  MERGE PROVENANCE (F-08) — a commit-trailer token minted at BRANCH and required
  in the merge commit message. Ancestry says the commits are reachable; the
  trailer says THIS transaction put them there.

    python merge_guard.py routes <src_dir>
    python merge_guard.py token --job-id J1 --base-commit abc
    python merge_guard.py verify <repo> --job-id J1 --token T --merge-ref main

Exit codes: 0 proven · 1 unproven/violation · 3 bad invocation
"""
from __future__ import annotations
import argparse, hashlib, os, re, subprocess, sys
from pathlib import Path

TRAILER = "Atelier-Transaction"
COMMIT_MARKERS = (re.compile(r'["\']COMMITTED["\']'), re.compile(r'\bstate\s*=\s*["\']COMMITTED'))
GENV = {"GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "true"}


def _git(args, cwd, timeout=20):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True,
                          text=True, timeout=timeout, env={**os.environ, **GENV})


# ---------- F-07 -----------------------------------------------------------

def find_routes(src: Path) -> dict:
    """Every source location that can set a job to COMMITTED."""
    routes, guarded = [], []
    for f in sorted(Path(src).glob("*.py")):
        if f.name.startswith("test_") or f.name == "merge_guard.py":
            continue
        text = f.read_text(encoding="utf-8", errors="replace")
        for i, line in enumerate(text.splitlines(), 1):
            if any(m.search(line) for m in COMMIT_MARKERS):
                # is the enclosing file's commit path guarded?
                has_guard = ("check(" in text and "STALE_JOB" in text) or \
                            ("merge_is_real" in text)
                routes.append({"file": f.name, "line": i,
                               "guarded": has_guard,
                               "text": line.strip()[:70]})
                if has_guard:
                    guarded.append(f.name)
    return {"routes": routes, "files": sorted({r["file"] for r in routes}),
            "guarded_files": sorted(set(guarded))}


# ---------- F-08 -----------------------------------------------------------

def mint(job_id: str, base_commit: str, secret: str = "") -> str:
    """
    Transaction token. Minted at BRANCH, before any work exists, from the job
    identity and its base commit. A merge lacking it was not produced by this
    transaction — which is the gap ancestry cannot close.
    """
    src = f"{job_id}\x00{base_commit}\x00{secret or os.environ.get('ATELIER_SECRET','')}"
    return hashlib.sha256(src.encode()).hexdigest()[:32]


def verify_merge(repo: Path, job_id: str, token: str, merge_ref: str,
                 branch: str | None = None) -> tuple[bool, str]:
    """Ancestry AND provenance. Both, or the merge is not attributable."""
    ins = _git(["rev-parse", "--is-inside-work-tree"], repo)
    if ins.returncode != 0:
        return False, "not inside a git work tree; provenance unverifiable"
    if branch:
        anc = _git(["merge-base", "--is-ancestor", branch, merge_ref], repo)
        if anc.returncode != 0:
            return False, (f"ancestry FAILED: {branch!r} is not reachable from "
                           f"{merge_ref!r} — the merge did not happen")
    log = _git(["log", "-50", "--format=%H%x00%B%x00END", merge_ref], repo)
    if log.returncode != 0:
        return False, f"cannot read {merge_ref!r}"
    want = f"{TRAILER}: {job_id}/{token}"
    for entry in log.stdout.split("\x00END"):
        if want in entry:
            sha = entry.strip().split("\x00")[0][:12]
            return True, (f"provenance PROVEN: commit {sha} carries "
                          f"{TRAILER}: {job_id}/{token[:12]}…")
    return False, (f"ancestry may hold, but NO commit in {merge_ref!r} carries "
                   f"{TRAILER}: {job_id}/{token[:12]}… — this merge is not "
                   f"attributable to this transaction (F-08)")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="F-07 route exclusivity, F-08 provenance.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("routes"); r.add_argument("src", nargs="?", default=".")
    t = sub.add_parser("token")
    t.add_argument("--job-id", required=True); t.add_argument("--base-commit", required=True)
    v = sub.add_parser("verify"); v.add_argument("repo")
    v.add_argument("--job-id", required=True); v.add_argument("--token", required=True)
    v.add_argument("--merge-ref", required=True); v.add_argument("--branch")
    a = ap.parse_args(argv)

    if a.cmd == "token":
        print(mint(a.job_id, a.base_commit)); return 0

    if a.cmd == "routes":
        d = find_routes(Path(a.src))
        for rt in d["routes"]:
            flag = "guarded" if rt["guarded"] else "UNGUARDED"
            print(f"  [{flag}] {rt['file']}:{rt['line']}  {rt['text']}")
        n = len(d["files"])
        unguarded = [f for f in d["files"] if f not in d["guarded_files"]]
        print(f"\nInspected {len(list(Path(a.src).glob('*.py')))} source file(s). "
              f"{len(d['routes'])} COMMITTED-setting site(s) in {n} file(s).")
        if unguarded:
            print(f"[S1] UNGUARDED merge route(s): {', '.join(unguarded)} — "
                  f"F-07 requires every route to invoke the stale guard",
                  file=sys.stderr)
            return 1
        if n > 1:
            print(f"[S2] {n} distinct files can set COMMITTED. Exclusivity is "
                  f"NOT proven by inspection alone; each is guarded, but a "
                  f"single route is the stronger property.", file=sys.stderr)
            return 1
        print(f"[OK] exactly one guarded route to COMMITTED "
              f"({d['files'][0] if d['files'] else 'none'}). "
              f"Scope: this source tree only — a route outside it is not visible "
              f"to this check, and that limit is the honest residual of F-07.")
        return 0

    ok, msg = verify_merge(Path(a.repo), a.job_id, a.token, a.merge_ref, a.branch)
    print(("[OK] " if ok else "[S1] ") + msg, file=sys.stdout if ok else sys.stderr)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
