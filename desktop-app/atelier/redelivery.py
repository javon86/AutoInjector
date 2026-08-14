#!/usr/bin/env python3
"""
redelivery.py — duplicate-delivery quarantine (task B5, §4.10.3).

transaction.py holds immutable job_id records but nothing rejects the SAME job
arriving twice. A redelivered response either overwrites work silently or is
applied twice; both are indistinguishable from correct operation after the fact.

Records a delivery digest per (project, job_id). A second delivery is refused
and quarantined with the reason — identical content is IDEMPOTENT (safe to
ignore), differing content is a CONFLICT (never auto-resolved).

    python redelivery.py accept <project> --job-id J1 --file resp.md
    python redelivery.py status <project> [--job-id J1]
    from redelivery import accept, DeliveryRefused

Exit codes: 0 accepted · 1 refused (duplicate) · 2 conflict · 3 bad invocation
"""
from __future__ import annotations
import argparse, hashlib, json, os, re, sys, tempfile
from datetime import datetime, timezone
from pathlib import Path

JOB_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def valid_job_id(job_id: str) -> tuple[bool, str]:
    """
    A job_id becomes a FILENAME. Unvalidated, "." and ".." produce ..json and
    ...json, and "../../evil" writes outside the store entirely. Found by
    adversarial sweep: the traversal check rejected slashes but not bare dots.
    """
    if not JOB_ID_RE.match(job_id or ""):
        return False, (f"invalid job_id {job_id!r}: letters, digits, dot, dash "
                       f"and underscore only, must start alphanumeric")
    if job_id.strip(".") == "":
        return False, f"invalid job_id {job_id!r}: dots only"
    return True, ""


LEDGER = "00_CONTROL/DELIVERIES.json"
QUARANTINE = "99_ARCHIVE/duplicate-deliveries"


class DeliveryRefused(RuntimeError):
    def __init__(self, msg, kind): super().__init__(msg); self.kind = kind


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _load(root: Path) -> dict:
    p = root / LEDGER
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def _save(root: Path, data: dict) -> None:
    """Durable: temp file, fsync, atomic rename (same discipline as F-08)."""
    p = root / LEDGER
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(p.parent), suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
        fh.flush(); os.fsync(fh.fileno())
    os.replace(tmp, p)


def accept(root: Path, job_id: str, content: str, project_id: str = "") -> dict:
    """
    Register a delivery. Raises DeliveryRefused on any second arrival.
    Idempotent redelivery is still REFUSED — silently accepting it hides the
    fact that a duplicate was sent, which is itself a transport symptom.
    """
    ok, why = valid_job_id(job_id)
    if not ok:
        raise DeliveryRefused(why, "INVALID_ID")
    key = f"{project_id}/{job_id}" if project_id else job_id
    digest = hashlib.sha256(content.encode()).hexdigest()
    led = _load(root)
    prior = led.get(key)

    if prior is None:
        led[key] = {"job_id": job_id, "project_id": project_id,
                    "digest": digest, "accepted_at": _now(),
                    "bytes": len(content.encode())}
        _save(root, led)
        return led[key]

    same = prior["digest"] == digest
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    q = root / QUARANTINE / f"{job_id}-{stamp}.md"
    q.parent.mkdir(parents=True, exist_ok=True)
    q.write_text(
        f"REFUSED DUPLICATE DELIVERY\njob_id: {job_id}\nproject_id: {project_id}\n"
        f"kind: {'IDEMPOTENT' if same else 'CONFLICT'}\n"
        f"first accepted: {prior['accepted_at']} digest {prior['digest'][:16]}\n"
        f"this delivery:  {_now()} digest {digest[:16]}\n\n{content}",
        encoding="utf-8")
    kind = "IDEMPOTENT" if same else "CONFLICT"
    raise DeliveryRefused(
        f"job {key} was already delivered at {prior['accepted_at']}; this is a "
        f"{kind} redelivery — quarantined to {q.relative_to(root)}"
        + ("" if same else ". Content DIFFERS; a conflict is never auto-resolved "
                          "and requires a Showrunner ruling."), kind)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="§4.10.3 duplicate-delivery quarantine.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a1 = sub.add_parser("accept"); a1.add_argument("project")
    a1.add_argument("--job-id", required=True); a1.add_argument("--file", required=True)
    a1.add_argument("--project-id", default="")
    a2 = sub.add_parser("status"); a2.add_argument("project")
    a2.add_argument("--job-id")
    a = ap.parse_args(argv)

    root = Path(a.project)
    if not root.is_dir():
        print(f"[FATAL] not a directory: {root}", file=sys.stderr); return 3

    if a.cmd == "status":
        led = _load(root)
        if a.job_id:
            hits = {k: v for k, v in led.items() if v["job_id"] == a.job_id}
            if not hits:
                print(f"job {a.job_id}: never delivered"); return 0
            for k, v in hits.items():
                print(f"  {k}: accepted {v['accepted_at']} "
                      f"digest {v['digest'][:16]}… {v['bytes']} bytes")
            return 0
        print(f"{len(led)} delivery record(s)")
        for k, v in sorted(led.items()):
            print(f"  {k:<40} {v['accepted_at']}  {v['digest'][:12]}…")
        q = root / QUARANTINE
        n = len(list(q.glob("*.md"))) if q.is_dir() else 0
        print(f"{n} quarantined duplicate(s)")
        return 0

    f = Path(a.file)
    if not f.exists():
        print(f"[FATAL] no such file: {f}", file=sys.stderr); return 3
    try:
        rec = accept(root, a.job_id, f.read_text(encoding="utf-8"), a.project_id)
        print(f"[OK] accepted {a.job_id} digest {rec['digest'][:16]}…")
        return 0
    except DeliveryRefused as e:
        print(f"[REFUSED] {e}", file=sys.stderr)
        return 2 if e.kind == "CONFLICT" else 1


if __name__ == "__main__":
    sys.exit(main())
