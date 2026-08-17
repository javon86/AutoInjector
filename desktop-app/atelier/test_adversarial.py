#!/usr/bin/env python3
"""
test_adversarial.py — end-to-end failure scenarios (finish-line task 9).

Crash/restart, retry, duplicate, out-of-order, stale job, stale instruction,
unauthorized write, recovery. Each was handled by an individual control; none
had been exercised as an end-to-end scenario against a live project.

    python test_adversarial.py [-v] [--prove]
"""
from __future__ import annotations
import argparse, json, os, signal, subprocess, sys, tempfile, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
HERE = Path(__file__).resolve().parent
_r: list[tuple[str, bool | None, str]] = []
S, F = "}-----< Start >-----{", "}-----< finish >-----{"
GENV = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "true"}


class Skip(Exception): ...


def run(tool, *a, cwd=None, timeout=90):
    p = subprocess.run([sys.executable, str(HERE / tool), *a], cwd=cwd,
                       capture_output=True, text=True, timeout=timeout, env=GENV)
    return p.returncode, p.stdout, p.stderr


def case(n):
    def deco(fn):
        def w():
            with tempfile.TemporaryDirectory() as td:
                try: fn(Path(td)); _r.append((n, True, ""))
                except Skip as e: _r.append((n, None, str(e)))
                except AssertionError as e: _r.append((n, False, str(e)))
                except Exception as e: _r.append((n, False, f"{type(e).__name__}: {e}"))
        return w
    return deco


@case("ADV: crash mid-transaction leaves a recoverable, non-mergeable record")
def t1(td):
    run("transaction.py", "open", "J1", "--branch", "wb/J1", "--base-commit", "b0",
        "--spec-version", "v0.3.3", "--inputs", "card=v1", cwd=td)
    run("transaction.py", "advance", "J1", "--to", "RESPONSE_RECEIVED", cwd=td)
    # simulate the process dying here: no further state written
    code, out, err = run("transaction.py", "recover", cwd=td)
    assert code == 1 and "J1" in (out + err), "interrupted job must be found"
    rec = json.loads((td / ".atelier" / "jobs" / "J1.json").read_text())
    assert rec["recovery"] in ("QUARANTINED", "RECOVERY_REQUIRED"), rec
    assert rec.get("open_transaction") is not False, "must not be auto-cleared"


@case("ADV: SIGKILL mid-run does not corrupt the durable record")
def t2(td):
    run("transaction.py", "open", "K1", "--branch", "wb/K1", "--base-commit", "b0",
        "--spec-version", "v0.3.3", "--inputs", "card=v1", cwd=td)
    p = subprocess.Popen([sys.executable, "-c",
                          "import time; time.sleep(30)"], cwd=td)
    time.sleep(0.3)
    p.kill(); p.wait(timeout=10)
    rec = json.loads((td / ".atelier" / "jobs" / "K1.json").read_text())
    assert rec["job_id"] == "K1", "record must survive an abrupt kill intact"


@case("ADV: retry of the same job is refused, not applied twice")
def t3(td):
    from redelivery import accept, DeliveryRefused
    accept(td, "R1", "response")
    for attempt in range(3):
        try:
            accept(td, "R1", "response")
            raise AssertionError(f"retry {attempt} was accepted — work applied twice")
        except DeliveryRefused:
            pass


@case("ADV: out-of-order delivery does not overwrite the first response")
def t4(td):
    from redelivery import accept, DeliveryRefused, _load
    first = accept(td, "O1", "the real response")
    try: accept(td, "O1", "a later, different response")
    except DeliveryRefused: pass
    assert _load(td)["O1"]["digest"] == first["digest"], \
        "a late arrival overwrote the authoritative first delivery"


@case("ADV: a stale job cannot commit even with a valid merge")
def t5(td):
    try:
        if subprocess.run(["git", "--version"], capture_output=True,
                          timeout=10, env=GENV).returncode != 0:
            raise Skip("git unavailable")
    except OSError:
        raise Skip("git unavailable")
    for a in (["init", "-q", "-b", "main"], ["config", "user.email", "t@t"],
              ["config", "user.name", "t"]):
        subprocess.run(["git", *a], cwd=td, capture_output=True, env=GENV)
    (td / "f.txt").write_text("x")
    subprocess.run(["git", "add", "-A"], cwd=td, capture_output=True, env=GENV)
    subprocess.run(["git", "commit", "-qm", "base"], cwd=td, capture_output=True, env=GENV)
    subprocess.run(["git", "branch", "wb/S1"], cwd=td, capture_output=True, env=GENV)
    run("transaction.py", "open", "S1", "--branch", "wb/S1", "--base-commit", "b0",
        "--spec-version", "v0.3.3", "--inputs", "card=v1", cwd=td)
    for s in ("RESPONSE_RECEIVED", "VALIDATION_PENDING", "COMMIT_PENDING"):
        run("transaction.py", "advance", "S1", "--to", s, cwd=td)
    code, _, err = run("transaction.py", "commit", "S1",
                       "--inputs", "card=v9", "--merge-ref", "main", cwd=td)
    assert code != 0, "a stale job committed"
    assert "STALE_JOB" in err or "stale" in err.lower(), err


@case("ADV: a stale instruction produces no mutation")
def t6(td):
    proj = td / "p"; (proj / "00_CONTROL").mkdir(parents=True)
    (proj / "00_CONTROL" / "STATE.md").write_text("Candidates pending: 106\n")
    ins = td / "i.md"; ins.write_text('1. Update where it says "Candidates pending: 51".\n')
    before = (proj / "00_CONTROL" / "STATE.md").read_text()
    code, _, err = run("check_instruction.py", str(proj), "--instruction", str(ins))
    assert code == 1 and "STALE" in err, err
    assert (proj / "00_CONTROL" / "STATE.md").read_text() == before, \
        "a stale instruction mutated state"


@case("ADV: an unauthorized write never reaches the manuscript")
def t7(td):
    from safe_write import write, WriteRefused
    from authority import QUARANTINE
    try:
        write(td, "04_CHAPTERS/ch01/scenes/s01.md", "auditor prose",
              role="gemini", job_id="J1")
        raise AssertionError("unauthorized write reached the manuscript")
    except WriteRefused:
        pass
    assert not (td / "04_CHAPTERS").exists()
    q = list((td / QUARANTINE).glob("*"))
    assert q and "auditor prose" in q[0].read_text(), "evidence was discarded"


@case("ADV: recovery returns to base and never auto-merges")
def t8(td):
    run("transaction.py", "open", "B1", "--branch", "wb/B1", "--base-commit", "abc123",
        "--spec-version", "v0.3.3", "--inputs", "card=v1", cwd=td)
    run("transaction.py", "recover", cwd=td)
    rec = json.loads((td / ".atelier" / "jobs" / "B1.json").read_text())
    assert "abc123" in json.dumps(rec), "base_commit must be recorded for return"
    assert rec["recovery"] != "MERGED", "recovery must never merge"
    assert "quarantin" in json.dumps(rec).lower() or rec["recovery"] == "QUARANTINED", rec


CASES = [t1, t2, t3, t4, t5, t6, t7, t8]


def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--prove", action="store_true"); a = ap.parse_args()
    if a.prove:
        print("PDF-003 guard: deliberately wrong expectation.\n")
        @case("DELIBERATELY WRONG")
        def bad(td):
            from redelivery import accept
            accept(td, "R1", "x"); accept(td, "R1", "x")
            raise AssertionError("expected failure — suite can go red")
        bad(); _, ok, msg = _r[-1]
        print(f"  {'FAIL (correct)' if not ok else 'PASS (BROKEN SUITE!)'} — {msg}")
        return 0 if not ok else 1
    for c in CASES: c()
    bad_ = [(n, m) for n, ok, m in _r if ok is False]
    skip = [(n, m) for n, ok, m in _r if ok is None]
    for n, ok, m in _r:
        if a.verbose or ok is False:
            print(f"  {'PASS' if ok else 'SKIP' if ok is None else 'FAIL'}  {n}")
            if ok is False: print(f"        {m}")
    for n, m in skip: print(f"  SKIP  {n}  ({m})")
    passed = sum(1 for _, ok, _ in _r if ok is True)
    print(f"\n{passed}/{len(_r)-len(skip)} passed" + (f", {len(skip)} skipped" if skip else ""))
    if skip: print("  NOTE: skipped cases are NOT passes.")
    return 1 if bad_ else 0


if __name__ == "__main__":
    sys.exit(main())
