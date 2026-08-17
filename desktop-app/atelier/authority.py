#!/usr/bin/env python3
"""
authority.py — role-based write authority (task B2).

Evidence: ISS-002. §3.3 forbids the Auditor writing manuscript or bible content.
Nothing BLOCKED it — the rule held because a human noticed and a Custodian
checked. In an automated pipeline the write must be rejected at the boundary.

    python authority.py check --role gemini --path 04_CHAPTERS/ch01/scenes/s01.md
    from authority import can_write, guard, AuthorityViolation

Exit codes: 0 permitted · 1 refused · 3 bad invocation
"""
from __future__ import annotations
import argparse, fnmatch, shutil, sys
from datetime import datetime, timezone
from pathlib import Path

# §3.1-3.4. Deny is the default: a path matching no rule is refused.
POLICY: dict[str, list[str]] = {
    "claude":   ["04_CHAPTERS/**", "02_BIBLE/**", "03_MEMORY/**",
                 "01_DESIGN/OPEN_THREADS.md", "07_BUILD/**",
                 "00_CONTROL/ISSUES.md", "00_CONTROL/REVISION_LOG.md"],
    "chatgpt":  ["01_DESIGN/**", "00_CONTROL/**", "02_BIBLE/**"],
    "gemini":   ["99_ARCHIVE/auditor-submissions/**", "06_AUDIT/**"],
    "human":    ["**"],
}
QUARANTINE = "99_ARCHIVE/auditor-submissions"


class AuthorityViolation(RuntimeError): ...


def can_write(role: str, rel_path: str) -> tuple[bool, str]:
    role = role.lower()
    if role not in POLICY:
        return False, f"unknown role {role!r} — deny by default"

    raw = str(rel_path).replace("\\", "/")

    # PATH TRAVERSAL. Found by adversarial sweep, not by the suite:
    # "04_CHAPTERS/../../../etc/x" matches the 04_CHAPTERS/** pattern and
    # escapes the project. A prefix match on an unnormalised path checks where
    # the string STARTS, not where it LANDS.
    import posixpath, urllib.parse
    decoded = urllib.parse.unquote(raw)
    if decoded != raw:
        return False, f"percent-encoded path rejected: {rel_path!r}"
    if raw.startswith("/") or (len(raw) > 1 and raw[1] == ":"):
        return False, f"absolute path rejected: {rel_path!r}"
    norm = posixpath.normpath(decoded)
    if norm.startswith("..") or "/../" in f"/{norm}/":
        return False, (f"path escapes the project root: {rel_path!r} "
                       f"resolves to {norm!r}")
    if any(seg in ("", ".") for seg in norm.split("/")[:-1] if seg != norm):
        pass  # normpath already collapsed these
    rel = norm.lstrip("./")
    for pat in POLICY[role]:
        if fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(rel, pat.rstrip("/*") + "/*"):
            return True, pat
    return False, f"{role} may not write {rel} (§3.3)"


def guard(role: str, root: Path, rel_path: str, content: str,
          quarantine: bool = True) -> Path:
    """
    Write, or refuse and quarantine. Returns the path actually written.
    A refused write is NOT silently dropped — dropping it loses evidence that
    an unauthorised write was attempted.
    """
    ok, why = can_write(role, rel_path)
    target = root / rel_path
    if ok:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return target
    if not quarantine:
        raise AuthorityViolation(why)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    q = root / QUARANTINE / f"{role}-{stamp}-{Path(rel_path).name}"
    q.parent.mkdir(parents=True, exist_ok=True)
    q.write_text(f"REFUSED WRITE — {why}\nintended path: {rel_path}\n"
                 f"role: {role}\nat: {stamp}\n\n{content}", encoding="utf-8")
    raise AuthorityViolation(f"{why} — quarantined to {q.relative_to(root)}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Role-based write authority.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check")
    c.add_argument("--role", required=True); c.add_argument("--path", required=True)
    l = sub.add_parser("policy")
    a = ap.parse_args(argv)

    if a.cmd == "policy":
        for role, pats in POLICY.items():
            print(f"  {role:<10} {', '.join(pats)}")
        print("  (any path matching no rule is REFUSED — deny by default)")
        return 0
    ok, why = can_write(a.role, a.path)
    if ok:
        print(f"[OK] {a.role} may write {a.path} (matched {why})"); return 0
    print(f"[REFUSED] {why}", file=sys.stderr); return 1


if __name__ == "__main__":
    sys.exit(main())
