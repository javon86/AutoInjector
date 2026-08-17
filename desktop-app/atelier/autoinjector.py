#!/usr/bin/env python3
"""
autoinjector.py — orchestration adapter (finish-line task 3).

The controls exist individually. Nothing composed them into the lifecycle
AutoInjector must enforce:

    CREATE -> ROUTE -> DELIVER -> CAPTURE -> VERIFY -> CLASSIFY
           -> APPLY/HOLD -> PROPAGATE -> AUDIT -> CLOSE

Every stage calls a control that already has its own regression suite. This
adds no new enforcement; it makes the ordering explicit and refusable, which is
the failure class behind PDF-012, ISS-003, ISS-004 and ISS-006 — a step that is
specified, performed by discipline, and never forced.

    python autoinjector.py route --role claude --path 04_CHAPTERS/x.md
    python autoinjector.py deliver <project> --job-id J1 --file r.md --role claude
    python autoinjector.py status <project>
    from autoinjector import Job, Pipeline, StageRefused

Exit codes: 0 stage completed · 1 refused/held · 3 bad invocation
"""
from __future__ import annotations
import argparse, json, sys
from dataclasses import dataclass, field, asdict
from pathlib import Path

from identity import Identity, namespaced, NamespaceViolation
from authority import can_write
from provenance import Provenance, extract, validate, now as _now
from redelivery import accept, DeliveryRefused
from safe_write import write, WriteRefused
from capture import capture, save as save_capture

STAGES = ["CREATE", "ROUTE", "DELIVER", "CAPTURE", "VERIFY", "CLASSIFY",
          "APPLY", "PROPAGATE", "AUDIT", "CLOSE"]
HOLD = "HOLD"


class StageRefused(RuntimeError):
    def __init__(self, stage, why): super().__init__(f"{stage}: {why}"); self.stage = stage


@dataclass
class Job:
    job_id: str
    project_id: str
    role: str
    target_path: str = ""
    spec_version: str = ""
    stage: str = "CREATE"
    history: list = field(default_factory=list)

    @property
    def key(self) -> str:
        return namespaced(self.project_id, self.job_id)

    def advance(self, to: str, note: str = "") -> None:
        if to not in STAGES and to != HOLD:
            raise StageRefused(to, "unknown stage")
        if to != HOLD:
            i, j = STAGES.index(self.stage) if self.stage in STAGES else -1, STAGES.index(to)
            if j != i + 1:
                raise StageRefused(to, f"cannot jump {self.stage} -> {to}; "
                                       f"stages are ordered and a skipped stage "
                                       f"is a stage that never ran")
        self.history.append({"from": self.stage, "to": to, "at": _now(), "note": note})
        self.stage = to


class Pipeline:
    """Composes existing controls. Each stage refuses rather than warning."""

    def __init__(self, root: Path, project_id: str, spec_version: str):
        self.root = Path(root)
        self.project_id = project_id
        self.spec_version = spec_version

    def create(self, job_id: str, role: str, target_path: str = "") -> Job:
        if not job_id.strip():
            raise StageRefused("CREATE", "job_id must not be empty")
        Identity(self.project_id, self.spec_version)      # validates the id
        return Job(job_id, self.project_id, role, target_path, self.spec_version)

    def route(self, job: Job) -> Job:
        """B2 — refuse a job routed to a role that may not write its target."""
        if job.target_path:
            ok, why = can_write(job.role, job.target_path)
            if not ok:
                raise StageRefused("ROUTE", why)
        job.advance("ROUTE", f"{job.role} -> {job.target_path or '(no write)'}")
        return job

    def deliver(self, job: Job, content: str) -> Job:
        """B5 — a redelivered job is refused before any work is applied."""
        try:
            accept(self.root, job.job_id, content, project_id=job.project_id)
        except DeliveryRefused as e:
            raise StageRefused("DELIVER", str(e)) from None
        job.advance("DELIVER", f"{len(content.encode())} bytes")
        return job

    def capture_stage(self, job: Job, cmd: list[str]) -> tuple[Job, dict]:
        """C-08 — a result is a hypothesis until it is captured."""
        rec = capture(cmd, f"{job.key}-{job.stage}")
        save_capture(self.root, rec)
        job.advance("CAPTURE", f"exit {rec['exit_code']} in {rec['duration_s']}s")
        return job, rec

    def verify(self, job: Job, content: str) -> Job:
        """B3 — an artifact without attribution is not evidence."""
        errs = validate(content, job.target_path or job.job_id)
        if errs:
            raise StageRefused("VERIFY", errs[0])
        job.advance("VERIFY", "provenance present")
        return job

    def classify(self, job: Job, severity: str = "P1") -> Job:
        if severity not in ("P1", "P2", "P3"):
            raise StageRefused("CLASSIFY", f"unknown class {severity!r}")
        job.advance("CLASSIFY", severity)
        if severity == "P3":
            job.advance(HOLD, "P3 cannot auto-adopt on silence (§4.7)")
        return job

    def apply(self, job: Job, content: str) -> Job:
        """C-05 — the single authorised write path."""
        if job.stage == HOLD:
            raise StageRefused("APPLY", "job is on HOLD; a held job never applies")
        try:
            write(self.root, job.target_path, content, role=job.role,
                  job_id=job.job_id, project_id=job.project_id)
        except WriteRefused as e:
            raise StageRefused("APPLY", str(e)) from None
        job.advance("APPLY", job.target_path)
        return job

    def state_path(self) -> Path:
        return self.root / "00_CONTROL" / "PIPELINE.json"

    def persist(self, job: Job) -> Path:
        p = self.state_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        data = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
        data[job.key] = asdict(job)
        p.write_text(json.dumps(data, indent=2), encoding="utf-8")
        return p


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="AutoInjector orchestration adapter.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("route")
    r.add_argument("--role", required=True); r.add_argument("--path", required=True)
    d = sub.add_parser("deliver"); d.add_argument("project")
    d.add_argument("--job-id", required=True); d.add_argument("--file", required=True)
    d.add_argument("--role", required=True); d.add_argument("--project-id", default="book")
    d.add_argument("--spec-version", default="v0.3.3"); d.add_argument("--target", default="")
    s = sub.add_parser("status"); s.add_argument("project")
    st = sub.add_parser("stages")
    a = ap.parse_args(argv)

    if a.cmd == "stages":
        print(" -> ".join(STAGES)); return 0

    if a.cmd == "route":
        ok, why = can_write(a.role, a.path)
        print(("[OK] " if ok else "[REFUSED] ") + why,
              file=sys.stdout if ok else sys.stderr)
        return 0 if ok else 1

    if a.cmd == "status":
        p = Path(a.project) / "00_CONTROL" / "PIPELINE.json"
        if not p.exists():
            print("no pipeline state"); return 0
        for k, v in json.loads(p.read_text(encoding="utf-8")).items():
            print(f"  {k:<40} {v['stage']:<10} {len(v['history'])} transition(s)")
        return 0

    root = Path(a.project)
    if not root.is_dir():
        print(f"[FATAL] not a directory: {root}", file=sys.stderr); return 3
    pipe = Pipeline(root, a.project_id, a.spec_version)
    try:
        job = pipe.create(a.job_id, a.role, a.target)
        pipe.route(job)
        content = Path(a.file).read_text(encoding="utf-8")
        pipe.deliver(job, content)
        pipe.persist(job)
        print(f"[OK] {job.key} at {job.stage}")
        return 0
    except (StageRefused, NamespaceViolation) as e:
        print(f"[REFUSED] {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
