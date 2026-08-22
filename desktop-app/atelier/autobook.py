#!/usr/bin/env python3
"""
autobook.py — validate & assemble drafted chapters (automation phases 2-5).

NOTE (BG-012): this does NOT generate prose. It is a gate/assembly runner: it
drives every chapter that already has a drafted block through the gates and the
strict assembler, halting on the first S0/S1. It halts (does not invent) when a
chapter's draft is missing. "Unattended" means unattended VALIDATION+ASSEMBLY of
drafted chapters, not autonomous writing.

Phase 1 was manual: a person ran each gate. This drives the whole pipeline
across every chapter, halting on the first S0/S1 rather than continuing and
reporting at the end — because a run that continues past a failure produces a
book nobody can trust and a log nobody reads.

    python autobook.py plan   <project> --chapters 12
    python autobook.py run    <project> [--from CH01] [--to CH12] [--dry-run]
    python autobook.py resume <project>
    python autobook.py status <project>

Phase 2  semi-automated dispatch — plan and run one chapter at a time
Phase 3  automated gates          — every gate invoked, none skippable
Phase 4  durable resume           — an interrupted run continues from state
Phase 5  unattended               — run to completion, halt on first failure

Exit codes: 0 complete · 1 halted on a gate · 2 halted on a control failure
            · 3 bad invocation
"""
from __future__ import annotations
import argparse, json, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATE = "00_CONTROL/AUTOBOOK.json"
S, F = "}-----< Start >-----{", "}-----< finish >-----{"

# Gates run after every chapter. Order matters: propagation before candidates,
# because a stale register makes the candidate count meaningless.
GATES = [
    ("propagation", "check_propagation.py", []),
    ("candidates",  "check_candidates.py",  []),
    ("timeline",    "validate_timeline.py", []),
    ("registers",   "check_registers.py",   []),
    ("depgraph",    "build_depgraph.py",    []),
    ("knowledge",   "check_knowledge.py",   []),
]


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def run_tool(tool: str, *a, cwd=None, timeout=180) -> tuple[int, str, str]:
    p = HERE / tool
    if not p.exists():
        # BG-009: a MISSING tool must not masquerade as a gate's own "not
        # applicable" (exit 3). Use 127 (command-not-found) so run_gates fails.
        return 127, "", f"missing tool: {tool}"
    try:
        r = subprocess.run([sys.executable, str(p), *a], cwd=cwd,
                           capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return 1, "", f"TIMEOUT after {timeout}s — a gate that cannot finish is red"
    return r.returncode, r.stdout, r.stderr


def load(root: Path) -> dict:
    p = root / STATE
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def save(root: Path, data: dict) -> None:
    p = root / STATE
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2), encoding="utf-8")


def plan(root: Path, chapters: int) -> dict:
    st = {"created_at": _now(), "chapters": chapters, "cursor": 1,
          "completed": [], "halted": None,
          "jobs": [{"chapter": n, "job_id": f"CH{n:02d}-S01-v1",
                    "stage": "PENDING"} for n in range(1, chapters + 1)]}
    save(root, st)
    return st


def run_gates(root: Path, chapter: int) -> tuple[bool, list]:
    results = []
    for name, tool, extra in GATES:
        rc, out, err = run_tool(tool, str(root), *extra)
        line = (out.strip().splitlines() or [""])[-1]
        # BG-009: distinguish the outcomes.
        #   0   -> pass
        #   3   -> the gate ran and reported "register absent / not applicable"
        #          (legitimate for an in-progress book) — OK, but LABELLED na
        #   127 -> the gate tool is MISSING — that is a broken pipeline, FAIL
        #   else (1, 2, timeout, invalid) -> a real finding/failure, FAIL
        if rc == 0:
            status, ok = "pass", True
        elif rc == 3:
            status, ok = "na", True
        elif rc == 127:
            status, ok = "missing", False
        else:
            status, ok = "fail", False
        results.append({"gate": name, "exit": rc, "ok": ok, "status": status,
                        "detail": (err.strip() or line)[:160]})
        if not ok:
            return False, results
    return True, results


def do_run(root: Path, first: int | None, last: int | None, dry: bool) -> int:
    st = load(root)
    if not st:
        print("[FATAL] no plan — run `autobook.py plan` first", file=sys.stderr)
        return 3
    lo = first or st.get("cursor", 1)
    hi = last or st["chapters"]

    for n in range(lo, hi + 1):
        job = st["jobs"][n - 1]
        scene = root / "04_CHAPTERS" / f"ch{n:02d}" / "scenes" / "s01.md"
        print(f"\n--- CH{n:02d} ---")

        if not scene.exists() or S not in scene.read_text(encoding="utf-8", errors="replace"):
            st["halted"] = {"chapter": n, "reason": "no drafted scene", "at": _now()}
            job["stage"] = "HALTED"
            save(root, st)
            print(f"[HALT] CH{n:02d}: no drafted scene at {scene.relative_to(root)}",
                  file=sys.stderr)
            print("       The pipeline drives gates; it does not invent prose.")
            return 1

        if dry:
            print(f"  would run {len(GATES)} gate(s) for CH{n:02d}")
            continue

        ok, results = run_gates(root, n)
        for r in results:
            print(f"  {'PASS' if r['ok'] else 'FAIL'}  {r['gate']:<12} {r['detail'][:60]}")
        if not ok:
            bad = [r for r in results if not r["ok"]][0]
            st["halted"] = {"chapter": n, "reason": f"{bad['gate']} gate",
                            "detail": bad["detail"], "at": _now()}
            job["stage"] = "HALTED"
            save(root, st)
            print(f"\n[HALT] CH{n:02d} failed the {bad['gate']} gate. Halting here "
                  f"rather than continuing — a run that passes a failure "
                  f"produces a book nobody can trust.", file=sys.stderr)
            return 1

        job["stage"] = "COMPLETE"
        st["completed"] = sorted(set(st["completed"] + [n]))
        st["cursor"] = n + 1
        st["halted"] = None
        save(root, st)

    if dry:
        print("\n[DRY RUN] nothing executed")
        return 0

    rc, out, err = run_tool("assemble_manuscript.py", "04_CHAPTERS",
                            "-o", "07_BUILD/manuscript.md", "--strict", cwd=root)
    print(f"\n  {'PASS' if rc == 0 else 'FAIL'}  final build   "
          f"{(out.strip().splitlines() or [err.strip()])[-1][:70]}")
    if rc != 0:
        return 2
    print(f"\nCOMPLETE — {len(st['completed'])}/{st['chapters']} chapters, "
          f"all gates green, strict build clean.")
    print("Chapters remain PENDING_AUDIT: local green is not independent approval.")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Validate and assemble drafted chapters (does not generate prose).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p1 = sub.add_parser("plan"); p1.add_argument("project")
    p1.add_argument("--chapters", type=int, required=True)
    p2 = sub.add_parser("run"); p2.add_argument("project")
    p2.add_argument("--from", dest="first", type=int)
    p2.add_argument("--to", dest="last", type=int)
    p2.add_argument("--dry-run", action="store_true")
    p3 = sub.add_parser("resume"); p3.add_argument("project")
    p4 = sub.add_parser("status"); p4.add_argument("project")
    a = ap.parse_args(argv)

    root = Path(a.project).resolve()
    if not root.is_dir():
        print(f"[FATAL] not a directory: {root}", file=sys.stderr); return 3

    if a.cmd == "plan":
        st = plan(root, a.chapters)
        print(f"planned {st['chapters']} chapter(s); cursor at CH01")
        return 0

    if a.cmd == "status":
        st = load(root)
        if not st:
            print("no plan"); return 0
        print(f"  {len(st['completed'])}/{st['chapters']} complete, "
              f"cursor CH{st['cursor']:02d}")
        if st.get("halted"):
            h = st["halted"]
            print(f"  HALTED at CH{h['chapter']:02d}: {h['reason']}")
        return 0

    if a.cmd == "resume":
        st = load(root)
        if not st:
            print("[FATAL] nothing to resume", file=sys.stderr); return 3
        start = st.get("cursor", 1)
        print(f"resuming at CH{start:02d} "
              f"({len(st['completed'])} chapter(s) already complete)")
        return do_run(root, start, None, False)

    return do_run(root, a.first, a.last, a.dry_run)


if __name__ == "__main__":
    sys.exit(main())
