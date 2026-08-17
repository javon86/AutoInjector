#!/usr/bin/env python3
"""
capture.py — execution-evidence capture (task B6 / control C-08).

Evidence: PDF-006, five occurrences of a model reporting results it could not
have produced; ISS-008, fabricated hashes; ISS-010, a fabricated test
transcript. Every one was refuted by checking an artifact, never by argument.

A reported result is a hypothesis. This makes the distinction mechanical: run
the command, capture stdout/stderr/exit/duration, hash the transcript. A claim
with no capture record cannot be cited as evidence.

    python capture.py run --label suites -- python harness.py suites
    python capture.py verify <record.json>
    from capture import capture, Claim

Exit codes: 0 captured (command's own code preserved in the record) · 3 bad args
"""
from __future__ import annotations
import argparse, hashlib, json, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path

CAPTURE_DIR = "00_CONTROL/evidence"


def capture(cmd: list[str], label: str, cwd: Path | None = None,
            timeout: int = 300) -> dict:
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    t0 = time.monotonic()
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                           timeout=timeout)
        rc, out, err, timed_out = r.returncode, r.stdout, r.stderr, False
    except subprocess.TimeoutExpired as e:
        rc, out, err, timed_out = 124, (e.stdout or ""), (e.stderr or ""), True
    dur = round(time.monotonic() - t0, 3)
    transcript = f"$ {' '.join(cmd)}\n{out}{err}"
    return {"label": label, "command": cmd, "cwd": str(cwd or Path.cwd()),
            "started_at": started, "duration_s": dur, "exit_code": rc,
            "timed_out": timed_out,
            "stdout": out, "stderr": err,
            "transcript_sha256": hashlib.sha256(transcript.encode()).hexdigest(),
            "summary": (out.strip().splitlines() or [""])[-1]}


def save(root: Path, rec: dict) -> Path:
    d = Path(root) / CAPTURE_DIR
    d.mkdir(parents=True, exist_ok=True)
    safe = "".join(c if c.isalnum() or c in "-_" else "-" for c in rec["label"])
    p = d / f"{safe}-{rec['started_at'].replace(':','')}.json"
    p.write_text(json.dumps(rec, indent=2), encoding="utf-8")
    return p


def verify(record: Path) -> tuple[bool, str]:
    """Re-derive the transcript hash. A record whose hash does not match its own
    stdout/stderr has been edited after capture."""
    rec = json.loads(Path(record).read_text(encoding="utf-8"))
    transcript = f"$ {' '.join(rec['command'])}\n{rec['stdout']}{rec['stderr']}"
    got = hashlib.sha256(transcript.encode()).hexdigest()
    if got != rec.get("transcript_sha256"):
        return False, (f"transcript hash mismatch: recorded "
                       f"{rec.get('transcript_sha256','')[:16]}… computed "
                       f"{got[:16]}… — the record was altered after capture")
    return True, f"{rec['label']}: exit {rec['exit_code']} in {rec['duration_s']}s"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="C-08 execution-evidence capture.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--label", required=True); r.add_argument("--root", default=".")
    r.add_argument("--timeout", type=int, default=300)
    r.add_argument("rest", nargs=argparse.REMAINDER)
    v = sub.add_parser("verify"); v.add_argument("record")
    a = ap.parse_args(argv)

    if a.cmd == "verify":
        ok, msg = verify(Path(a.record))
        print(("[OK] " if ok else "[S1] ") + msg, file=sys.stdout if ok else sys.stderr)
        return 0 if ok else 1

    cmd = [c for c in a.rest if c != "--"]
    if not cmd:
        print("[FATAL] no command given after --", file=sys.stderr); return 3
    rec = capture(cmd, a.label, timeout=a.timeout)
    p = save(Path(a.root), rec)
    print(f"[CAPTURED] {a.label}: exit {rec['exit_code']} in {rec['duration_s']}s")
    print(f"           {rec['summary']}")
    print(f"           evidence: {p}")
    print(f"           sha256:   {rec['transcript_sha256'][:32]}…")
    return 0


if __name__ == "__main__":
    sys.exit(main())
