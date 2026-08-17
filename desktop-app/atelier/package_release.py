#!/usr/bin/env python3
"""Build a reproducible drop-in ATELIER release ZIP plus SHA-256 manifest."""
from __future__ import annotations
import argparse, hashlib, json, zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
EXCLUDE_DIRS = {"__pycache__", ".git", ".pytest_cache"}
EXCLUDE_FILES = {"CLEAN_VERIFY_RESULTS.json"}

def digest(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1024*1024), b""):
            h.update(chunk)
    return h.hexdigest()

def eligible(p: Path) -> bool:
    rel = p.relative_to(HERE)
    return (p.is_file() and not any(part in EXCLUDE_DIRS for part in rel.parts)
            and p.name not in EXCLUDE_FILES and not p.name.endswith(".zip"))

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", default="ATELIER_RELEASE.zip")
    args = ap.parse_args()
    out = HERE / args.output
    files = sorted(p for p in HERE.rglob("*") if eligible(p))
    manifest = {"root": "ATELIER", "file_count": len(files), "files": []}
    for p in files:
        rel = p.relative_to(HERE).as_posix()
        manifest["files"].append({"path": rel, "bytes": p.stat().st_size,
                                  "sha256": digest(p)})
    manifest_bytes = json.dumps(manifest, indent=2).encode()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for p in files:
            z.write(p, f"ATELIER/{p.relative_to(HERE).as_posix()}")
        z.writestr("ATELIER/RELEASE_MANIFEST.json", manifest_bytes)
    print(out)
    print(f"files={len(files)} sha256={digest(out)}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
