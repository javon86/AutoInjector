#!/usr/bin/env python3
"""
verify_freeze.py — verify a project against its freeze manifest.

Written because an ad-hoc probe hardcoded a superseded key path
(`manuscript_sha256` at top level) and raised KeyError when the schema moved
the hash under `artifacts`. That was a schema/key-path failure reported as if
it might be a hash mismatch — the two must never be confused.

The probe resolves the manuscript hash by SEARCHING the manifest rather than
assuming a location, and reports schema resolution separately from integrity.

    python verify_freeze.py <project_dir> [--manifest PATH]

Exit codes:
    0  freeze integrity PRESERVED
    1  integrity BROKEN — a tracked artifact changed
    2  schema unresolvable — the manifest does not expose a manuscript hash
    3  bad invocation
"""
from __future__ import annotations
import argparse, hashlib, json, sys
from pathlib import Path

MANUSCRIPT_HINTS = ("07_BUILD/manuscript.md", "manuscript.md")
# Live registers are expected to change after a manuscript freeze; defect
# registration continues. Their drift is not an integrity failure.
EXPECT_MUTABLE = ("ISSUES.md", "PROCESS_DEFECTS.md", "PENDING_CHANGES.md")


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def resolve_manuscript(man: dict) -> tuple[str | None, str]:
    """Find the manuscript hash without assuming a key path."""
    arts = man.get("artifacts", {})
    for hint in MANUSCRIPT_HINTS:
        for k, v in arts.items():
            if k.endswith(hint):
                return v, f"artifacts['{k}']"
    for k in ("manuscript_sha256", "manuscript_hash"):   # superseded layouts
        if k in man:
            return man[k], f"{k} (SUPERSEDED top-level path)"
    return None, "unresolved"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Verify a freeze manifest.")
    ap.add_argument("project")
    ap.add_argument("--manifest", default="00_CONTROL/FREEZE.json")
    a = ap.parse_args(argv)

    root = Path(a.project).expanduser()
    mp = root / a.manifest
    if not mp.exists():
        print(f"[FATAL] no manifest at {mp}", file=sys.stderr)
        return 3
    man = json.loads(mp.read_text(encoding="utf-8"))

    frozen, path = resolve_manuscript(man)
    if frozen is None:
        print("[SCHEMA] manifest exposes no manuscript hash under any known "
              "key path — this is a SCHEMA failure, not a hash mismatch",
              file=sys.stderr)
        return 2
    print(f"schema lookup path : {path}")
    if "SUPERSEDED" in path:
        print("        NOTE: resolved via a superseded key path. Historical, "
              "not operative — update the manifest, not this probe.",
              file=sys.stderr)

    arts = man.get("artifacts", {})
    mkey = next(k for k in arts if any(k.endswith(h) for h in MANUSCRIPT_HINTS))
    cur = sha(root / mkey)
    ok_manu = cur == frozen
    print(f"frozen manuscript  : {frozen}")
    print(f"current manuscript : {cur}")
    print(f"manuscript match   : {ok_manu}")

    scenes = {k: v for k, v in arts.items() if "04_CHAPTERS" in k}
    bad = [k for k, v in scenes.items() if sha(root / k) != v]
    print(f"scene hashes       : {len(scenes)-len(bad)}/{len(scenes)} match")
    for b in bad:
        print(f"[BROKEN] scene changed since freeze: {b}", file=sys.stderr)

    others = {k: v for k, v in arts.items()
              if "04_CHAPTERS" not in k and k != mkey}
    drift, unexpected = [], []
    for k, v in others.items():
        if sha(root / k) != v:
            (drift if any(k.endswith(m) for m in EXPECT_MUTABLE)
             else unexpected).append(k)
    for d in drift:
        print(f"[EXPECTED] live register changed since freeze: {d}")
    for u in unexpected:
        print(f"[BROKEN] tracked artifact changed unexpectedly: {u}",
              file=sys.stderr)

    preserved = ok_manu and not bad and not unexpected
    print(f"freeze integrity   : {'PRESERVED' if preserved else 'BROKEN'}")
    return 0 if preserved else 1


if __name__ == "__main__":
    sys.exit(main())
