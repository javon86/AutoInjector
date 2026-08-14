#!/usr/bin/env python3
"""
transaction.py — job lifecycle, STALE_JOB enforcement, durable crash recovery.

Implements SYSTEM_SPEC v0.3.3 §4.1 (version-locked jobs), §4.10.1–4.10.3,
§4.11 (crash and resume), and §25 (VALIDATE gate), per Showrunner ruling on
audit findings F-07 and F-08.

    python transaction.py open   <job_id> --branch B --inputs k=v [k=v ...]
    python transaction.py advance <job_id> --to VALIDATION_PENDING
    python transaction.py check  <job_id> --inputs k=v [...]   # F-07 gate
    python transaction.py commit <job_id>
    python transaction.py recover [--discard]                  # F-08 startup

Exit codes:
    0  ok / clean
    1  PROCESS_VIOLATION — prohibited action detected and BLOCKED
    2  S0 — prohibited state actually exists (committed stale, orphan merged)
    3  bad invocation
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
try:
    from merge_guard import mint, verify_merge
except ImportError:
    mint = verify_merge = None
import sys
import time
from pathlib import Path

STATES = ["DISPATCHED", "RESPONSE_RECEIVED", "VALIDATION_PENDING",
          "COMMIT_PENDING", "COMMITTED"]
STORE = Path(".atelier/jobs")

PROCESS_VIOLATION, S0 = 1, 2


# ---------------------------------------------------------------------------
# Durable record. Written with fsync + atomic rename so a crash mid-write
# leaves either the old record or the new one, never a truncated file.
# A lifecycle record that can itself be corrupted by the crash it exists to
# survive is not a recovery mechanism.
# ---------------------------------------------------------------------------

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


def _path(job_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9._-]+", job_id):
        raise ValueError(f"unsafe job_id: {job_id!r}")
    return STORE / f"{job_id}.json"


def write_record(rec: dict) -> None:
    STORE.mkdir(parents=True, exist_ok=True)
    p = _path(rec["job_id"])
    tmp = p.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(rec, f, indent=2, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(p)
    try:                                  # durability of the rename itself
        d = os.open(str(STORE), os.O_RDONLY)
        os.fsync(d)
        os.close(d)
    except OSError:
        pass


def read_record(job_id: str) -> dict | None:
    p = _path(job_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def all_records() -> list[dict]:
    if not STORE.exists():
        return []
    out = []
    for p in sorted(STORE.glob("*.json")):
        try:
            out.append(json.loads(p.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            out.append({"job_id": p.stem, "state": "CORRUPT", "branch": None})
    return out


# ---------------------------------------------------------------------------
# F-07 — STALE_JOB enforcement
# ---------------------------------------------------------------------------

def staleness(rec: dict, current_inputs: dict[str, str]) -> list[str]:
    """Which controlling inputs moved since dispatch."""
    return sorted(
        k for k, v in rec.get("inputs", {}).items()
        if k in current_inputs and current_inputs[k] != v
    )


REQUIRED_ACCEPTANCE_FIELDS = ("override_reason", "stale_inputs",
                              "current_inputs", "rebase_unnecessary_because")


def acceptance_is_valid(rec: dict, decision_log: str,
                        current_inputs: dict[str, str] | None = None
                        ) -> tuple[bool, str]:
    """
    Authorized staleness acceptance, per §4.1 — 'the staleness is explicitly
    accepted with logged reasoning'.

    Represented in the existing Decision Log mechanism rather than a bespoke
    signed-override format: an entry naming this job_id, with status FINAL or
    APPROVED, and version-locked to the same inputs the job actually ran on.
    An acceptance that does not name the exact input versions accepts nothing
    in particular -- it would remain valid after the inputs moved again.
    """
    jid = rec["job_id"]
    blocks = re.split(r"^## (DEC-\d+)", decision_log, flags=re.M)
    for i in range(1, len(blocks) - 1, 2):
        dec_id, body = blocks[i], blocks[i + 1]
        if jid not in body:
            continue
        if not re.search(r"status:\*{0,2}\s*\**(FINAL|APPROVED)", body, re.I):
            return False, f"{dec_id} names the job but is not FINAL/APPROVED"
        locked = all(f"{k}@{v}" in body or f"{k}: {v}" in body
                     for k, v in rec.get("inputs", {}).items())
        if not locked:
            return False, f"{dec_id} is not version-locked to this job's inputs"

        # Ruled schema. Version-lock alone is NOT equivalent: it records what
        # the job ran on, not what changed, why the change is tolerable, or
        # why a rebase was not done. An acceptance missing those approves a
        # staleness nobody described.
        missing = [f for f in REQUIRED_ACCEPTANCE_FIELDS
                   if not re.search(rf"{f}\s*:", body, re.I)]
        if missing:
            return False, (f"{dec_id} omits required authorization field(s): "
                           f"{', '.join(missing)}")

        if current_inputs:
            absent = [f"{k}@{v}" for k, v in current_inputs.items()
                      if k in rec.get("inputs", {})
                      and rec["inputs"][k] != v
                      and f"{k}@{v}" not in body and f"{k}: {v}" not in body]
            if absent:
                return False, (f"{dec_id} does not record the CURRENT versions "
                               f"being accepted: {', '.join(absent)}")
        return True, dec_id
    return False, "no Decision Log entry names this job"


def check(job_id: str, current_inputs: dict[str, str], decision_log: str
          ) -> tuple[int, list[str]]:
    rec = read_record(job_id)
    msgs: list[str] = []
    if rec is None:
        return 3, [f"[FATAL] no lifecycle record for {job_id}"]

    stale = staleness(rec, current_inputs)
    if not stale:
        return 0, [f"[OK] {job_id}: inputs current; merge-eligible"]

    ok, why = acceptance_is_valid(rec, decision_log, current_inputs)
    if ok:
        msgs.append(f"[OK] {job_id}: STALE_JOB on {', '.join(stale)} — "
                    f"accepted by {why}, version-locked. Merge-eligible.")
        return 0, msgs

    committed = rec.get("state") == "COMMITTED"
    level = S0 if committed else PROCESS_VIOLATION
    tag = "S0" if committed else "PROCESS_VIOLATION"
    msgs.append(
        f"[{tag}] {job_id}: STALE_JOB — controlling inputs changed after "
        f"dispatch: {', '.join(stale)}. {why}."
    )
    msgs.append("        Rebase to current inputs, or record an authorized "
                "version-locked acceptance in DECISION_LOG.md.")
    if committed:
        msgs.append("        A stale job reached COMMITTED. The gate did not "
                    "hold — this is a machinery failure, not a blocked attempt.")
    else:
        msgs.append("        Commit BLOCKED. Nothing was mutated.")
    return level, msgs


# ---------------------------------------------------------------------------
# F-08 — durable crash recovery
# ---------------------------------------------------------------------------

def merge_is_real(branch: str | None, merge_ref: str | None
                  ) -> tuple[bool, str]:
    """
    Repository-grounded proof that the branch was actually merged.

    Replaces the previous --merge-verified caller assertion. An assertion by
    the party that benefits from it is not evidence; `git merge-base
    --is-ancestor` is checkable by anyone.
    """
    if not merge_ref:
        return False, ("--merge-ref not supplied; merge success must be "
                       "verified against the repository, not asserted")
    if not branch:
        return False, "record has no branch to verify"
    try:
        inside = subprocess.run(["git", "rev-parse", "--is-inside-work-tree"],
                                capture_output=True, text=True, timeout=10)
        if inside.returncode != 0:
            return False, "not inside a git work tree; cannot verify the merge"
        for ref in (branch, merge_ref):
            r = subprocess.run(["git", "rev-parse", "--verify", "--quiet", ref],
                               capture_output=True, text=True, timeout=10)
            if r.returncode != 0:
                return False, f"ref {ref!r} does not resolve"
        anc = subprocess.run(
            ["git", "merge-base", "--is-ancestor", branch, merge_ref],
            capture_output=True, text=True, timeout=10)
        if anc.returncode != 0:
            return False, (f"{branch!r} is NOT an ancestor of {merge_ref!r} — "
                           f"the authoritative merge did not happen")
        return True, f"{branch} verified merged into {merge_ref}"
    except (OSError, subprocess.SubprocessError) as e:
        return False, f"git verification failed: {e}"


def recover(destroy: bool = False) -> tuple[int, list[str]]:
    """
    On startup: any job without a COMMITTED transition that still holds a
    branch died mid-transaction. Its branch is evidence, not authority.

    try/finally cannot cover SIGKILL, power loss, or reboot -- so recovery is
    driven by the durable record on restart rather than by cleanup at crash
    time. Nothing is ever auto-merged.
    """
    msgs, worst = [], 0
    for rec in all_records():
        jid, state, branch = rec.get("job_id"), rec.get("state"), rec.get("branch")

        if state == "CORRUPT":
            msgs.append(f"[S0] {jid}: lifecycle record unreadable — "
                        f"RECOVERY_REQUIRED, manual disposition")
            worst = max(worst, S0)
            continue
        # Keys on the DURABLE OPEN-TRANSACTION RECORD, not on lifecycle state.
        # A job whose state was flipped to COMMITTED but whose merge then
        # failed still carries open_transaction: True and is caught here.
        if not rec.get("open_transaction", bool(branch)):
            continue

        rec["recovery"] = "RECOVERY_REQUIRED"
        rec["recovery_detected_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                                    time.gmtime())
        msgs.append(
            f"[RECOVERY_REQUIRED] {jid}: died at {state} holding branch "
            f"{branch!r}. NOT merge-eligible."
        )
        rec["base_commit"] = rec.get("base_commit")
        if destroy:
            rec["recovery"] = "DESTROYED"
            rec["disposition"] = (f"branch {branch} destroyed after diagnostic "
                                  f"capture; restore base {rec.get('base_commit')}")
            msgs.append(f"        DESTROY requested — capture diagnostics first, "
                        f"then: git branch -D {branch}")
        else:
            rec["recovery"] = "QUARANTINED"
            rec["disposition"] = (f"branch {branch} quarantined; diagnostics "
                                  f"preserved; base {rec.get('base_commit')}")
            msgs.append(f"        QUARANTINED (default) — branch preserved for "
                        f"diagnostics; return to base {rec.get('base_commit')}")
            msgs.append("        Options: discard the branch, or re-run full "
                        "validation against the current authoritative ref.")
            msgs.append("        Job/input versions must be re-checked before "
                        "the branch can become merge-eligible.")
        write_record(rec)
        worst = max(worst, PROCESS_VIOLATION)

    if not msgs:
        msgs.append("[OK] no interrupted transactions; nothing to recover")
    return worst, msgs


# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    sub = ap.add_subparsers(dest="cmd", required=True)

    o = sub.add_parser("open"); o.add_argument("job_id")
    o.add_argument("--branch", required=True)
    o.add_argument("--base-commit", required=True,
                   help="commit the transaction branches from; the recorded "
                        "target for 'return to the last COMMITTED state'")
    o.add_argument("--spec-version", required=True,
                   help="C-02: the spec a job was dispatched against. Without "
                        "it a record cannot be judged against the rules in "
                        "force when it was created")
    o.add_argument("--project-id", default="",
                   help="B1 namespace; job keys collide across books without it")
    o.add_argument("--inputs", nargs="*", default=[])
    a = sub.add_parser("advance"); a.add_argument("job_id")
    a.add_argument("--to", required=True, choices=STATES)
    c = sub.add_parser("check"); c.add_argument("job_id")
    c.add_argument("--inputs", nargs="*", default=[])
    c.add_argument("--log", default="DECISION_LOG.md")
    m = sub.add_parser("commit"); m.add_argument("job_id")
    m.add_argument("--inputs", nargs="*", default=None,
                   help="current controlling input versions. REQUIRED: commit "
                        "runs the STALE_JOB guard itself so it cannot be "
                        "skipped by a VALIDATE path that forgets to call it")
    m.add_argument("--log", default="DECISION_LOG.md")
    m.add_argument("--merge-ref", default=None,
                   help="authoritative ref the branch must already be merged "
                        "into. Verified against the repository, not asserted")
    r = sub.add_parser("recover")
    r.add_argument("--quarantine", action="store_true",
                   help="default disposition: preserve branch and diagnostics")
    r.add_argument("--destroy", action="store_true",
                   help="destroy the orphan branch — only AFTER diagnostics "
                        "have been captured")
    args = ap.parse_args(argv)

    jid = getattr(args, "job_id", None)
    if jid is not None:
        ok, why = valid_job_id(jid)
        if not ok:
            print(f"[FATAL] {why}", file=sys.stderr)
            return BAD_INVOCATION if "BAD_INVOCATION" in globals() else 3

    def kv(pairs):
        d = {}
        for p in pairs:
            if "=" not in p:
                raise SystemExit(f"[FATAL] --inputs expects k=v, got {p!r}")
            k, v = p.split("=", 1); d[k] = v
        return d

    try:
        if args.cmd == "open":
            write_record({"job_id": args.job_id, "branch": args.branch,
                          "base_commit": args.base_commit,
                          "spec_version": args.spec_version,
                          "txn_token": (mint(args.job_id, args.base_commit)
                                        if mint else ""),
                          "project_id": args.project_id,
                          "inputs": kv(args.inputs), "state": "DISPATCHED",
                          "open_transaction": True,
                          "opened_at": time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                                     time.gmtime())})
            print(f"[OK] {args.job_id}: DISPATCHED on branch {args.branch} "
                  f"(base {args.base_commit})")
            return 0

        if args.cmd == "advance":
            rec = read_record(args.job_id)
            if rec is None:
                print(f"[FATAL] no record for {args.job_id}", file=sys.stderr); return 3
            cur, nxt = STATES.index(rec["state"]), STATES.index(args.to)
            if nxt != cur + 1:
                print(f"[S0] invalid state transition {rec['state']} -> {args.to}",
                      file=sys.stderr)
                return S0
            rec["state"] = args.to; write_record(rec)
            print(f"[OK] {args.job_id}: {args.to}")
            return 0

        if args.cmd == "check":
            code, msgs = check(args.job_id, kv(args.inputs),
                               Path(args.log).read_text(encoding="utf-8")
                               if Path(args.log).exists() else "")
            for m_ in msgs: print(m_, file=sys.stderr if code else sys.stdout)
            return code

        if args.cmd == "commit":
            rec = read_record(args.job_id)
            if rec is None:
                print(f"[FATAL] no record for {args.job_id}", file=sys.stderr); return 3
            if rec["state"] != "COMMIT_PENDING":
                print(f"[S0] commit from {rec['state']}, expected COMMIT_PENDING",
                      file=sys.stderr)
                return S0
            # --- F-07: the guard runs HERE. Not callable-and-skippable. ---
            if args.inputs is None:
                print(f"[S0] {args.job_id}: --inputs is required at commit. "
                      f"The STALE_JOB guard runs at the merge boundary; a "
                      f"commit path that can omit it is not a guarantee.",
                      file=sys.stderr)
                return S0
            gcode, gmsgs = check(args.job_id, kv(args.inputs),
                                 Path(args.log).read_text(encoding="utf-8")
                                 if Path(args.log).exists() else "")
            if gcode:
                for g in gmsgs:
                    print(g, file=sys.stderr)
                print(f"[BLOCKED] {args.job_id}: STALE_JOB guard failed at the "
                      f"commit/merge boundary. Nothing committed.",
                      file=sys.stderr)
                return gcode

            # --- F-08: ancestry AND provenance. Ancestry proves the commits
            # are reachable; the transaction trailer proves THIS transaction
            # put them there. Ancestry alone is satisfied by a merge some other
            # process performed, which is the gap this closes.
            if verify_merge is not None and rec.get("txn_token") and args.merge_ref:
                pok, pwhy = verify_merge(Path("."), args.job_id,
                                         rec["txn_token"], args.merge_ref,
                                         rec.get("branch"))
                if not pok:
                    print(f"[S0] {args.job_id}: {pwhy}", file=sys.stderr)
                    return S0
            ok, why = merge_is_real(rec.get("branch"), args.merge_ref)
            if not ok:
                print(f"[S0] {args.job_id}: cannot clear the open transaction "
                      f"— {why}. The record is removed ONLY on repository "
                      f"evidence that the authoritative merge succeeded.",
                      file=sys.stderr)
                return S0
            rec["state"] = "COMMITTED"
            rec["open_transaction"] = False          # cleared only on merge
            rec.pop("recovery", None)
            write_record(rec)
            print(f"[OK] {args.job_id}: COMMITTED — {why}; stale guard passed")
            return 0

        if args.cmd == "recover":
            if args.destroy and not args.quarantine:
                code, msgs = recover(destroy=True)
            else:
                code, msgs = recover(destroy=False)
            for m_ in msgs: print(m_, file=sys.stderr if code else sys.stdout)
            return code
    except ValueError as e:
        print(f"[FATAL] {e}", file=sys.stderr); return 3
    except OSError as e:
        print(f"[FATAL] {e}", file=sys.stderr); return 2
    return 3


if __name__ == "__main__":
    sys.exit(main())
