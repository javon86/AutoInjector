"""Set K handlers: Workflow Orchestration (K01-K12).

All K operations are deterministic LOGIC. Durable orchestration state (project settings,
queue jobs/leases/generations, retry decisions, approval checkpoints and the quota
ledger) lives in K-owned module state and is written with compare-and-set through
ctx.on_commit, i.e. atomically with the operation's record, audit, receipt and outbox.
A concurrent writer therefore fails with VERSION_CONFLICT and mutates nothing.

K never edits domain records; completion is taken only from I12 evidence records.
"""
from __future__ import annotations

from datetime import timedelta

from .. import k_runtime as kr
from ..canonical import canonical_bytes
from ..errors import BookforgeError
from . import register
from .base import Context, OperationHandler, Result
from .set_i import completion_operation, registration, registry_revision

TERMINAL = ("FAILED", "CANCELLED", "COMPLETED")
DERIVED = "is a derived decision; recompute it with CREATE instead of replacing it"


def _rej(code: str, path: str, msg: str, status: str = "REJECTED") -> BookforgeError:
    return BookforgeError(code, path, msg, status=status)


def _state(ctx: Context, ns: str, key: str):
    return kr.read_state(ctx.store, ctx.project_id, ctx.branch_id, ns, key)


def _put_state(ctx: Context, ns: str, key: str, value, expected: int | None):
    pid, bid = ctx.project_id, ctx.branch_id
    ctx.on_commit(lambda tx: tx.put_state(pid, bid, ns, key, value, expected_revision=expected))


def _rkey(ref: dict) -> tuple:
    return (ref["record_id"], ref["version"], ref["content_hash"])


def _input_records(ctx: Context, module_id: str) -> list[dict]:
    out = [r for p, r in sorted(ctx.resolved.items()) if p.startswith("/input_refs/") and r["module_id"] == module_id]
    return out


def _check_manifest(ctx: Context, supplied: dict, path: str = "/payload/feature_manifest") -> dict:
    """The scheduling predicate is the TRUSTED stored manifest; a supplied copy must match it exactly."""
    stored = ctx.manifest
    if stored is None:
        raise BookforgeError("MISSING_INPUT", path, "project has no feature manifest")
    if supplied.get("project_id") != ctx.project_id or supplied.get("branch_id") != ctx.branch_id:
        raise _rej("INVALID_INPUT", path, "manifest belongs to another project/branch")
    if canonical_bytes(supplied) != canonical_bytes(stored):
        raise _rej("VERSION_CONFLICT", path + "/revision",
                   f"manifest does not match stored revision {stored['revision']}")
    return stored


def _completed_ops(ctx: Context, field: str = "completion_refs") -> tuple[set, list]:
    """Operations with current COMPLETE I12 evidence; plus operations whose I12 is BLOCKED/STALE."""
    done, blockers = set(), []
    for rec in ctx.field_records(field):
        op = completion_operation(rec)
        if rec["data"]["completion_state"] == "COMPLETE" and not rec["stale"]:
            done.add(op)
        elif op:
            blockers.append(op)
    return done, blockers


# ======================================================================================
# K01 - Project Manager
# ======================================================================================
@register("K01")
class ProjectManager(OperationHandler):
    """Records the explicit project identity/configuration for the envelope project.

    The storage identity (projects row, main branch, owner grants, first manifest) is
    created by the kernel bootstrap (Engine.bootstrap_project, via k_runtime.create_project)
    because every wire request must already address an existing authorized project. K01
    CREATE then binds the explicit settings (locale, default mode, parallelism) used by
    K05/K06; owner_id must be the project's owner. One K01 identity per project/branch."""

    def create(self, ctx: Context) -> Result:
        p = ctx.payload
        if p["owner_id"] != ctx.project["owner_id"]:
            raise _rej("PERMISSION_DENIED", "/payload/owner_id", "owner_id must be the project owner")
        existing, rev = _state(ctx, kr.NS_K01, "identity")
        if existing:
            raise _rej("VERSION_CONFLICT", "/payload", f"project identity already recorded as "
                       f"{existing['record_id']}; use UPDATE")
        manifest = ctx.manifest
        record_id = ctx.allocate_record_id()
        _put_state(ctx, kr.NS_K01, "identity", {"record_id": record_id, "project_name": p["project_name"],
                                                "settings": p["settings"], "owner_id": p["owner_id"]}, rev)
        return Result(data={"project_id": ctx.project_id, "phase": manifest["phase"] if manifest else "PLANNING",
                            "revision": 1, "status": "ACTIVE" if manifest else "BLOCKED"}, record_id=record_id)

    def update(self, ctx: Context) -> Result:
        data, base = dict(ctx.payload), ctx.base
        if data["project_id"] != ctx.project_id:
            raise _rej("INVALID_INPUT", "/payload/project_id", "project_id is stable")
        if data["revision"] != base["version"] + 1:
            raise _rej("INVALID_INPUT", "/payload/revision", "revision must equal the new version")
        if ctx.manifest and data["phase"] != ctx.manifest["phase"]:
            raise _rej("INVALID_INPUT", "/payload/phase",
                       "phase follows the feature manifest; change it with a manifest revision")
        return Result(data=data, transform="MANUAL")


# ======================================================================================
# K02 - Module-Set Scheduler
# ======================================================================================
def missing_hard_prerequisites(ctx: Context, op_id: str) -> list[str]:
    """HARD, always-required reference inputs with no approved record from an allowed producer."""
    bindings = {b["input_path"]: b for b in ctx.contracts.bindings(op_id)}
    missing = []
    for dep in ctx.contracts.dependencies(op_id, "CREATE"):
        if dep["dependency_kind"] != "HARD" or dep["empty_allowed"] or dep["required_when"]["operator"] != "ALWAYS":
            continue
        b = bindings.get(dep["input_field"])
        if b is None:
            continue  # user-supplied value, not a prerequisite record
        allowed = set(b["allowed_producers"])
        row = ctx.store.query_one(
            "SELECT 1 FROM heads WHERE project_id=? AND branch_id=? AND approved_version IS NOT NULL AND module_id IN "
            f"({','.join('?' * len(allowed))}) LIMIT 1", (ctx.project_id, ctx.branch_id, *sorted(allowed)))
        if row is None:
            missing.append(dep["input_field"])
    return missing


@register("K02")
class Scheduler(OperationHandler):
    """Schedules exactly the operations in the pinned manifest's required_operations; an op is
    blocked only by its own missing HARD record prerequisites, never by another set's completion."""

    def create(self, ctx: Context) -> Result:
        p = ctx.payload
        if p["project_id"] != ctx.project_id:
            raise _rej("INVALID_INPUT", "/payload/project_id", "project_id must match the request project")
        m = _check_manifest(ctx, p["feature_manifest"])
        if p["phase"] != m["phase"]:
            raise _rej("INVALID_INPUT", "/payload/phase", f"manifest phase is {m['phase']}")
        done, _ = _completed_ops(ctx)
        scheduled, blocked, findings = [], [], []
        for op in sorted(set(m["required_operations"])):
            if op in done:
                continue
            job = f"{op}@manifest-r{m['revision']}"
            miss = missing_hard_prerequisites(ctx, op)
            if miss:
                blocked.append(job)
                findings.append(ctx.finding("PREREQUISITE", f"{op} waits for {', '.join(miss)}",
                                            severity="INFO", decision="UNKNOWN"))
            else:
                scheduled.append(job)
        if p["mode"] == "MANUAL" and scheduled:
            findings.append(ctx.finding("MANUAL_MODE", "scheduled jobs need user initiation (K06)",
                                        severity="INFO", decision="PASS"))
        return Result(data={"scheduled_jobs": scheduled, "blocked_jobs": blocked}, findings=findings)

    def update(self, ctx: Context) -> Result:
        raise _rej("INVALID_INPUT", "/payload", f"K02 {DERIVED}")


# ======================================================================================
# K03 - Module Router
# ======================================================================================
@register("K03")
class ModuleRouter(OperationHandler):
    """Resolve the registry adapter for a job. Deterministic work (LOGIC, LOGIC/HYBRID, HYBRID with
    no AI capability requirement) routes to CODE; AI work routes to a connected healthy AI slot
    offering the capabilities, else holds for MANUAL input. Registry revision must be current."""

    def create(self, ctx: Context) -> Result:
        p = ctx.payload
        reg_rec = ctx.field_record("operation_ref")
        reg = registration(ctx.store, ctx.project_id, ctx.branch_id, reg_rec["data"]["registration_id"])
        if reg is None:
            raise BookforgeError("MISSING_INPUT", "/payload/operation_ref", "registration details are missing")
        current = registry_revision(ctx.store, ctx.project_id, ctx.branch_id)
        if p["registry_revision"] != current:
            raise _rej("VERSION_CONFLICT", "/payload/registry_revision", f"registry is at revision {current}")
        op = ctx.contracts.operation(reg["producer"])
        findings = []
        deterministic = op["execution"] in ("LOGIC", "LOGIC/HYBRID") or (
            op["execution"] == "HYBRID" and not p["capability_requirements"])
        if deterministic:
            route = f"CODE:{reg['producer']}"
        else:
            needs = set(p["capability_requirements"])
            ok = [s for s in ctx.engine.providers.slots()
                  if s["connected"] and s["healthy"] and needs <= set(s["capabilities"])]
            if ok:
                route = f"AI:{reg['producer']}"
            else:
                route = f"MANUAL:{reg['producer']}"
                findings.append(ctx.finding("CAPABILITY_UNAVAILABLE", "no connected AI slot offers "
                                            f"{sorted(needs)}; manual candidate input", severity="MAJOR",
                                            decision="UNKNOWN"))
        return Result(data={"route": route, "adapter_ref": reg_rec["ref"]}, findings=findings)

    def update(self, ctx: Context) -> Result:
        raise _rej("INVALID_INPUT", "/payload", f"K03 {DERIVED}")


# ======================================================================================
# K04 - Dependency Resolver
# ======================================================================================
def tarjan_scc(nodes: list[str], edges: list[tuple[str, str]]) -> list[list[str]]:
    """Strongly connected components in O(V+E) (iterative Tarjan); deterministic order."""
    adj: dict[str, list[str]] = {n: [] for n in nodes}
    for a, b in edges:
        adj.setdefault(a, []).append(b)
        adj.setdefault(b, [])
    for k in adj:
        adj[k].sort()
    index, low, on, stack, out, counter = {}, {}, set(), [], [], [0]
    for root in sorted(adj):
        if root in index:
            continue
        work = [(root, 0)]
        while work:
            v, i = work.pop()
            if i == 0:
                index[v] = low[v] = counter[0]
                counter[0] += 1
                stack.append(v)
                on.add(v)
            recurse = False
            for j in range(i, len(adj[v])):
                w = adj[v][j]
                if w not in index:
                    work.append((v, j + 1))
                    work.append((w, 0))
                    recurse = True
                    break
                if w in on:
                    low[v] = min(low[v], index[w])
            if recurse:
                continue
            if low[v] == index[v]:
                comp = []
                while True:
                    w = stack.pop()
                    on.discard(w)
                    comp.append(w)
                    if w == v:
                        break
                out.append(sorted(comp))
            if work:
                u = work[-1][0]
                low[u] = min(low[u], low[v])
    return out


@register("K04")
class DependencyResolver(OperationHandler):
    """Edges are prerequisite -> dependent. bootstrap_edges are the declared staged exceptions
    (must also be hard edges): they are deferred to a REVISION step after first outputs exist.
    Remaining hard cycles are reported as exact SCC nodes (and edges in findings) and hold the job."""

    def create(self, ctx: Context) -> Result:
        g = ctx.payload["dependency_graph"]
        nodes = list(dict.fromkeys(g["nodes"]))
        node_set = set(nodes)
        hard = [(e["from"], e["to"]) for e in g["hard_edges"]]
        boot = [(e["from"], e["to"]) for e in g["bootstrap_edges"]]
        for name, edges in (("hard_edges", hard), ("bootstrap_edges", boot)):
            for i, (a, b) in enumerate(edges):
                if a not in node_set or b not in node_set:
                    raise _rej("INVALID_INPUT", f"/payload/dependency_graph/{name}/{i}", "edge endpoint not a node")
        hard_set = set(hard)
        for i, e in enumerate(boot):
            if e not in hard_set:
                raise _rej("INVALID_INPUT", f"/payload/dependency_graph/bootstrap_edges/{i}",
                           "only declared hard CREATE-stage edges can be staged for bootstrap")
        effective = sorted(set(hard) - set(boot))
        sccs = [c for c in tarjan_scc(nodes, effective) if len(c) > 1 or (c[0], c[0]) in set(effective)]
        findings = []
        for comp in sccs:
            cs = set(comp)
            cyc_edges = [f"{a}->{b}" for a, b in effective if a in cs and b in cs]
            findings.append(ctx.finding("DEPENDENCY_CYCLE", f"hard cycle nodes {comp} edges {cyc_edges}",
                                        severity="BLOCKING", decision="FAIL"))
        done, _ = _completed_ops(ctx)
        job = ctx.payload["job_id"]
        if job in node_set:
            preds: dict[str, set] = {}
            for a, b in effective:
                preds.setdefault(b, set()).add(a)
            need, todo = set(), [job]
            while todo:
                for a in preds.get(todo.pop(), ()):
                    if a not in need:
                        need.add(a)
                        todo.append(a)
        else:
            need = node_set
        missing = sorted(n for n in need if n not in done)
        plan = self._plan(nodes, effective, boot) if not sccs else []
        errors = []
        if sccs:
            from ..errors import error
            errors = [error("DEPENDENCY_CYCLE", "/payload/dependency_graph/hard_edges",
                            f"{len(sccs)} hard cycle(s); jobs held for correction")]
        return Result(data={"ready": not sccs and not missing, "missing": missing, "cycles": sccs,
                            "bootstrap_plan": plan}, findings=findings, errors=errors)

    @staticmethod
    def _plan(nodes, edges, boot) -> list[str]:
        indeg = {n: 0 for n in nodes}
        adj: dict[str, list[str]] = {n: [] for n in nodes}
        for a, b in edges:
            adj[a].append(b)
            indeg[b] += 1
        ready = sorted(n for n in nodes if indeg[n] == 0)
        out = []
        while ready:
            n = ready.pop(0)
            out.append(n)
            for m in sorted(adj[n]):
                indeg[m] -= 1
                if indeg[m] == 0:
                    ready.append(m)
                    ready.sort()
        out += [f"REVISE:{b}<-{a}" for a, b in sorted(boot)]
        return out

    def update(self, ctx: Context) -> Result:
        raise _rej("INVALID_INPUT", "/payload", f"K04 {DERIVED}")


# ======================================================================================
# K05 - Job Queue
# ======================================================================================
TRANSITIONS = {
    "QUEUED": {"LEASED", "WAITING", "CANCELLED"},
    "LEASED": {"LEASED", "WAITING", "RETRYING", "FAILED", "COMPLETED", "QUEUED", "CANCELLED"},
    "WAITING": {"QUEUED", "FAILED", "CANCELLED"},
    "RETRYING": {"QUEUED", "FAILED", "CANCELLED"},
}


def job_state(store, project_id: str, branch_id: str, queue_id: str) -> dict | None:
    v, _ = kr.read_state(store, project_id, branch_id, kr.NS_JOBS, queue_id)
    return v


def verify_fence(store, project_id: str, branch_id: str, queue_id: str, attempt_id: str,
                 fencing_token: int | None = None) -> None:
    """Raise LEASE_EXPIRED unless attempt_id holds the current, unexpired lease of the current
    queue generation (and fencing_token, when given, matches). Workers call this before publishing;
    see the report for the proposed in-transaction kernel hook."""
    job = job_state(store, project_id, branch_id, queue_id)
    ctrl, _ = kr.queue_control(store, project_id, branch_id)
    _fence(job, ctrl, attempt_id, fencing_token)


def _fence(job: dict | None, ctrl: dict, attempt_id: str, fencing_token: int | None = None):
    if job is None:
        raise BookforgeError("NOT_FOUND", "/payload/queue_id", "unknown queue job", status="REJECTED")
    if job["state"] != "LEASED" or job["attempt_id"] != attempt_id:
        raise _rej("LEASE_EXPIRED", "/payload/attempt_id", f"attempt {attempt_id} is fenced; current attempt is "
                   f"{job['attempt_id']} ({job['state']})")
    if fencing_token is not None and fencing_token != job["fencing_token"]:
        raise _rej("LEASE_EXPIRED", "/payload/attempt_id", "fencing token is stale")
    if job["generation"] != ctrl["generation"]:
        raise _rej("LEASE_EXPIRED", "/payload/attempt_id",
                   f"attempt belongs to queue generation {job['generation']}; current is {ctrl['generation']}")
    if kr.parse_time(job["lease_expires_at"]) <= kr.now():
        raise _rej("LEASE_EXPIRED", "/payload/attempt_id", "lease expired")


@register("K05")
class JobQueue(OperationHandler):
    """Durable queue projection. CREATE enqueues (QUEUED). UPDATE is a fenced state transition
    whose payload is the expected projection: dispatch (->LEASED) allocates a new attempt_id,
    fencing token and lease against the current queue generation; LEASED->LEASED renews; every
    worker transition requires the current unexpired attempt of the current generation; an expired
    or stale-generation lease may be reclaimed (LEASED->QUEUED); COMPLETED needs a current
    COMPLETE I12 record (in input_refs) for the job's operation and pinned sources."""

    def create(self, ctx: Context) -> Result:
        p = ctx.payload
        reg_rec = ctx.field_record("operation_ref")
        reg = registration(ctx.store, ctx.project_id, ctx.branch_id, reg_rec["data"]["registration_id"])
        if reg is None:
            raise BookforgeError("MISSING_INPUT", "/payload/operation_ref", "registration details are missing")
        idx, idx_rev = _state(ctx, kr.NS_JOBIDX, p["job_id"])
        if idx and idx.get("active"):
            raise _rej("VERSION_CONFLICT", "/payload/job_id", f"job already queued as {idx['queue_id']}")
        for i, rec in enumerate(ctx.field_records("source_versions")):
            if rec["stale"] or rec["lifecycle"] in ("SUPERSEDED", "REJECTED"):
                raise _rej("VERSION_CONFLICT", f"/payload/source_versions/{i}", "source pin is not current")
        queue_id = ctx.allocate_record_id()
        attempt_id = f"{queue_id}-a0"
        job = {"queue_id": queue_id, "job_id": p["job_id"], "operation": reg["producer"],
               "registration_id": reg["registration_id"], "priority": p["priority"],
               "source_versions": p["source_versions"], "state": "QUEUED", "attempt_id": attempt_id,
               "attempts": [], "fencing_token": 0, "generation": None, "lease_expires_at": None,
               "next_attempt_at": None, "enqueued_at": kr.iso(kr.now())}
        _put_state(ctx, kr.NS_JOBS, queue_id, job, 0)
        _put_state(ctx, kr.NS_JOBIDX, p["job_id"], {"queue_id": queue_id, "active": True}, idx_rev)
        return Result(data={"queue_id": queue_id, "attempt_id": attempt_id, "lease_state": "QUEUED"},
                      record_id=queue_id)

    def update(self, ctx: Context) -> Result:
        p, base = ctx.payload, ctx.base["data"]
        if p["queue_id"] != base["queue_id"]:
            raise _rej("INVALID_INPUT", "/payload/queue_id", "queue_id is stable")
        job, jrev = _state(ctx, kr.NS_JOBS, p["queue_id"])
        if job is None:
            raise BookforgeError("NOT_FOUND", "/payload/queue_id", "unknown queue job", status="REJECTED")
        ctrl, crev = kr.queue_control(ctx.store, ctx.project_id, ctx.branch_id)
        cur, new, now = job["state"], p["lease_state"], kr.now()
        if p["attempt_id"] != job["attempt_id"]:
            raise _rej("LEASE_EXPIRED", "/payload/attempt_id",
                       f"attempt {p['attempt_id']} is fenced; current attempt is {job['attempt_id']}")
        if cur in TERMINAL or new not in TRANSITIONS.get(cur, set()):
            raise _rej("INVALID_INPUT", "/payload/lease_state", f"transition {cur} -> {new} is not allowed")
        job = dict(job)
        findings, check_ctrl = [], False
        if cur == "LEASED" and new == "QUEUED":
            expired = kr.parse_time(job["lease_expires_at"]) <= now
            if not expired and job["generation"] == ctrl["generation"]:
                raise _rej("INVALID_INPUT", "/payload/lease_state", "lease is still valid; cannot reclaim")
            job.update(state="QUEUED", lease_expires_at=None)
        elif cur == "LEASED" and new != "CANCELLED":
            _fence(job, ctrl, p["attempt_id"])
            check_ctrl = True
            if new == "LEASED":
                job["lease_expires_at"] = kr.lease_expiry(now)
            elif new == "WAITING":
                job.update(state="WAITING", lease_expires_at=None)
            elif new == "RETRYING":
                dec, _ = _state(ctx, kr.NS_K07, f"{job['job_id']}|{job['attempt_id']}")
                if not dec or dec["decision"] != "RETRY":
                    raise BookforgeError("MISSING_INPUT", "/payload/lease_state",
                                         "RETRYING needs a K07 RETRY decision for this attempt")
                job.update(state="RETRYING", lease_expires_at=None, next_attempt_at=dec["next_attempt_at"])
            elif new == "FAILED":
                job.update(state="FAILED", lease_expires_at=None)
            elif new == "COMPLETED":
                self._check_completion(ctx, job)
                job.update(state="COMPLETED", lease_expires_at=None)
        elif new == "LEASED":  # QUEUED -> LEASED dispatch
            self._dispatch_checks(ctx, job, ctrl)
            check_ctrl = True
            attempt = kr.new_id("attempt")
            job.update(state="LEASED", attempt_id=attempt, attempts=job["attempts"] + [attempt],
                       fencing_token=job["fencing_token"] + 1, generation=ctrl["generation"],
                       lease_expires_at=kr.lease_expiry(now), leased_at=kr.iso(now), next_attempt_at=None)
        elif cur == "RETRYING" and new == "QUEUED":
            if job["next_attempt_at"] and kr.parse_time(job["next_attempt_at"]) > now:
                raise BookforgeError("RATE_LIMITED", "/payload/lease_state",
                                     f"retry not before {job['next_attempt_at']}")
            job["state"] = "QUEUED"
        else:
            job.update(state=new, lease_expires_at=None)
        job["state"] = new
        if new == "LEASED":
            findings.append(ctx.finding("LEASE", f"attempt {job['attempt_id']} fencing_token {job['fencing_token']} "
                                        f"generation {job['generation']} lease_expires_at {job['lease_expires_at']} "
                                        f"heartbeat_every {kr.HEARTBEAT_SECONDS}s", severity="INFO",
                                        decision="PASS"))
        pid, bid, max_par = ctx.project_id, ctx.branch_id, None
        if cur != "LEASED" and new == "LEASED":
            max_par = kr.project_settings(ctx.store, pid, bid)["max_parallel_jobs"]
        queue_id, job_id = job["queue_id"], job["job_id"]

        def commit(tx):
            if check_ctrl:
                _, now_rev = kr.tx_read_state(tx, pid, bid, kr.NS_CTRL, kr.CTRL_KEY)
                if now_rev != crev:
                    raise _rej("LEASE_EXPIRED", "/payload/attempt_id", "queue generation changed concurrently")
            if max_par is not None:
                t = kr.now()
                leased = [j for k, j in kr.tx_list_state(tx, pid, bid, kr.NS_JOBS).items() if k != queue_id
                          and j["state"] == "LEASED" and j["generation"] == job["generation"]
                          and kr.parse_time(j["lease_expires_at"]) > t]
                if len(leased) >= max_par:
                    raise BookforgeError("RATE_LIMITED", "/payload/lease_state",
                                         f"max_parallel_jobs={max_par} leases already active")
            tx.put_state(pid, bid, kr.NS_JOBS, queue_id, job, expected_revision=jrev)
            if new in TERMINAL:
                tx.put_state(pid, bid, kr.NS_JOBIDX, job_id, {"queue_id": queue_id, "active": False})
        ctx.on_commit(commit)
        return Result(data={"queue_id": queue_id, "attempt_id": job["attempt_id"], "lease_state": new},
                      findings=findings, transform="LOGIC")

    def _dispatch_checks(self, ctx: Context, job: dict, ctrl: dict):
        if ctrl["paused"]:
            raise BookforgeError("APPROVAL_REQUIRED", "/payload/lease_state", "queue is paused; RESUME first (K10)")
        if not ctx.store.has_scope(ctx.principal_id, ctx.project_id, ctx.branch_id, f"{job['operation']}:create"):
            raise _rej("PERMISSION_DENIED", "/payload/lease_state", f"missing scope {job['operation']}:create")
        for i, ref in enumerate(job["source_versions"]):
            rec = ctx.store.get_record(ctx.project_id, ctx.branch_id, ref["record_id"], ref["version"])
            if rec is None or rec["content_hash"] != ref["content_hash"] or rec["stale"] \
                    or rec["lifecycle"] in ("SUPERSEDED", "REJECTED"):
                raise BookforgeError("VERSION_CONFLICT", f"/source_versions/{i}",
                                     "a pinned source changed; submit a new logical request")

    def _check_completion(self, ctx: Context, job: dict):
        want = {_rkey(r) for r in job["source_versions"]}
        for rec in _input_records(ctx, "I12"):
            data = rec["data"]
            ev = data["evidence"]
            if data["completion_state"] != "COMPLETE" or rec["stale"] or ev.get("operation_id") != job["operation"]:
                continue
            if want - {_rkey(r) for r in ev.get("input_refs", [])}:
                continue
            out = ev.get("output_ref")
            if out:
                cur = ctx.store.get_record(ctx.project_id, ctx.branch_id, out["record_id"], out["version"])
                if cur is None or cur["stale"]:
                    continue
            return
        raise BookforgeError("MISSING_INPUT", "/input_refs",
                             f"COMPLETED needs a current COMPLETE I12 record for {job['operation']} matching the "
                             "job's source pins (a worker claim is not evidence)")


# ======================================================================================
# K06 - Automatic/Manual Mode Controller
# ======================================================================================
@register("K06")
class ModeController(OperationHandler):
    """AUTO allows READ/DRAFT/PROPOSE; PUBLISH/PROTECTED_WRITE/DELETE hold for a K09 authorization.
    MANUAL needs a user initiation per job (a current APPROVED K09 in input_refs). A project in
    MANUAL default mode cannot be escalated to AUTO by the request."""

    SAFE = ("READ", "DRAFT", "PROPOSE")

    def create(self, ctx: Context) -> Result:
        p = ctx.payload
        project_mode = kr.project_settings(ctx.store, ctx.project_id, ctx.branch_id)["default_mode"]
        mode = "MANUAL" if project_mode == "MANUAL" else p["mode"]
        auths, denied = [], None
        for rec in _input_records(ctx, "K09"):
            try:
                kr.check_k09_authorization(ctx.store, rec, None, "/input_refs")
                auths.append(rec)
            except BookforgeError as exc:
                denied = exc.errors[0]["message"]
        if denied and not auths:
            return Result(data={"decision": "DENY", "hold_reason": f"authorization refused: {denied}"})
        needs_auth = mode == "MANUAL" or p["action_class"] not in self.SAFE or p["approval_policy"]["requires_approval"]
        if needs_auth and not auths:
            why = ("manual mode: user must initiate this job" if mode == "MANUAL"
                   else f"{p['action_class']} needs K09 authorization under policy "
                        f"{p['approval_policy']['policy_id']} r{p['approval_policy']['revision']}")
            return Result(data={"decision": "HOLD", "hold_reason": why},
                          unresolved=[f"K09:{p['job_id']}:{p['action_class']}"])
        reason = (f"allowed by K09 {auths[0]['record_id']}" if auths
                  else f"AUTO mode permits {p['action_class']}")
        return Result(data={"decision": "ALLOW", "hold_reason": reason})

    def update(self, ctx: Context) -> Result:
        raise _rej("INVALID_INPUT", "/payload", f"K06 {DERIVED}")


# ======================================================================================
# K07 - Retry/Failure Handler
# ======================================================================================
REPAIR = {
    "MISSING_INPUT": "supply the missing prerequisite/input, then resubmit",
    "INVALID_INPUT": "correct the invalid input, then resubmit as a new logical request",
    "VERSION_CONFLICT": "rebase on the current head/pins and resubmit",
    "PERMISSION_DENIED": "grant the required scope or reassign the job",
    "APPROVAL_REQUIRED": "obtain the required K09/I10 approval",
    "QUOTA_EXCEEDED": "raise the quota or wait for the next period",
    "CAPABILITY_UNAVAILABLE": "connect an AI slot with the capability or supply a manual candidate",
    "LEASE_EXPIRED": "reclaim the expired lease and dispatch a new fenced attempt after revalidation",
}


@register("K07")
class RetryHandler(OperationHandler):
    """At most 3 attempts; delays before attempts 2 and 3 are base*2^(n-1) plus deterministic
    jitter in [0, base], capped at min(max_delay, 4s) and the deadline. Only TIMEOUT (of this
    enum; also UPSTREAM_UNAVAILABLE/RATE_LIMITED by contract) retries; INTERNAL_ERROR fails."""

    RETRYABLE = ("TIMEOUT", "UPSTREAM_UNAVAILABLE", "RATE_LIMITED")

    def create(self, ctx: Context) -> Result:
        p = ctx.payload
        pol = p["retry_policy"]
        number, attempts_update = self._attempt_number(ctx, p)
        code = p["error_code"]
        next_at, repair, decision = None, None, None
        if code in self.RETRYABLE:
            max_attempts = min(pol["max_attempts"], 3)
            if number >= max_attempts:
                decision = "FAIL"
            else:
                base = pol["base_delay_ms"] * (2 ** (number - 1))
                jitter = kr.deterministic_fraction(p["job_id"], p["attempt_id"]) * base
                delay = min(base + jitter, pol["max_delay_ms"], 4000)
                at = kr.now() + timedelta(milliseconds=delay)
                if at >= kr.parse_time(pol["deadline"]):
                    decision = "FAIL"
                else:
                    decision, next_at = "RETRY", at.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        elif code == "INTERNAL_ERROR":
            decision = "FAIL"
        else:
            decision, repair = "BLOCK", f"{code}: {REPAIR[code]}"
        data = {"decision": decision, "next_attempt_at": next_at, "repair_request": repair}
        _, rev = _state(ctx, kr.NS_K07, f"{p['job_id']}|{p['attempt_id']}")
        _put_state(ctx, kr.NS_K07, f"{p['job_id']}|{p['attempt_id']}", dict(data, attempt_number=number), rev)
        if attempts_update:
            _put_state(ctx, kr.NS_K07_ATTEMPTS, p["job_id"], *attempts_update)
        return Result(data=data)

    def _attempt_number(self, ctx: Context, p: dict):
        idx, _ = _state(ctx, kr.NS_JOBIDX, p["job_id"])
        if idx:
            job, _ = _state(ctx, kr.NS_JOBS, idx["queue_id"])
            if job and p["attempt_id"] in job["attempts"]:
                return job["attempts"].index(p["attempt_id"]) + 1, None
            if job:
                raise _rej("INVALID_INPUT", "/payload/attempt_id", "attempt does not belong to this queued job")
        seen, rev = _state(ctx, kr.NS_K07_ATTEMPTS, p["job_id"])
        seen = list(seen or [])
        if p["attempt_id"] in seen:
            return seen.index(p["attempt_id"]) + 1, None
        return len(seen) + 1, (seen + [p["attempt_id"]], rev)

    def update(self, ctx: Context) -> Result:
        raise _rej("INVALID_INPUT", "/payload", f"K07 {DERIVED}")


# ======================================================================================
# K08 - Progress Manager
# ======================================================================================
@register("K08")
class ProgressManager(OperationHandler):
    """progress = accepted required evidence / selected applicable required operations.
    Queue states are caller claims: they can only add blockers, never progress."""

    def create(self, ctx: Context) -> Result:
        p = ctx.payload
        if p["project_id"] != ctx.project_id:
            raise _rej("INVALID_INPUT", "/payload/project_id", "project_id must match the request project")
        m = _check_manifest(ctx, p["feature_manifest"])
        required = sorted(set(m["required_operations"]))
        done, i12_blockers = _completed_ops(ctx)
        num = len([op for op in required if op in done])
        den = len(required)
        blockers = sorted({q["job_id"] for q in p["queue_states"] if q["state"] in ("BLOCKED", "FAILED")}
                          | {op for op in i12_blockers if op in required and op not in done})
        if den == 0:
            return Result(data={"progress": 0, "blockers": blockers, "phase_ready": bool(m["allow_empty_phase"])})
        return Result(data={"progress": num / den, "blockers": blockers,
                            "phase_ready": num == den and not blockers})

    def update(self, ctx: Context) -> Result:
        raise _rej("INVALID_INPUT", "/payload", f"K08 {DERIVED}")


# ======================================================================================
# K09 - Approval Checkpoints
# ======================================================================================
K09_TRANSITIONS = {"PENDING": {"APPROVED", "REJECTED"}, "APPROVED": {"REVOKED", "EXPIRED"}}


@register("K09")
class ApprovalCheckpoints(OperationHandler):
    """CREATE opens a PENDING checkpoint (expiry null) binding action hash, source versions,
    policy and requester. UPDATE records the decision: APPROVED needs an authorized role and a
    future expiry within ttl_seconds; PENDING/REJECTED/REVOKED keep expiry null."""

    def create(self, ctx: Context) -> Result:
        p = ctx.payload
        record_id = ctx.allocate_record_id()
        _put_state(ctx, kr.NS_K09, record_id, {
            "action_id": p["action_id"], "impact": p["impact"], "policy": p["policy"],
            "base_revision": p["base_revision"], "requester": ctx.principal_id, "created_at": kr.iso(kr.now()),
            "decisions": []}, 0)
        return Result(data={"approval_id": record_id, "decision": "PENDING", "expiry": None}, record_id=record_id)

    def update(self, ctx: Context) -> Result:
        data, base = dict(ctx.payload), ctx.base["data"]
        if data["approval_id"] != base["approval_id"]:
            raise _rej("INVALID_INPUT", "/payload/approval_id", "approval_id is stable")
        cur, new = base["decision"], data["decision"]
        if new not in K09_TRANSITIONS.get(cur, set()):
            raise _rej("INVALID_INPUT", "/payload/decision", f"{cur} -> {new} is not allowed")
        cp, rev = _state(ctx, kr.NS_K09, base["approval_id"])
        if cp is None:
            raise BookforgeError("NOT_FOUND", "/payload/approval_id", "checkpoint binding missing")
        now = kr.now()
        if new in ("APPROVED", "REJECTED", "REVOKED"):
            self._authorize(ctx, cp)
        if new == "APPROVED":
            if not data["expiry"]:
                raise _rej("INVALID_INPUT", "/payload/expiry", "APPROVED requires a future UTC expiry")
            exp = kr.parse_time(data["expiry"])
            if exp <= now or exp > now + timedelta(seconds=cp["policy"]["ttl_seconds"] + 60):
                raise _rej("INVALID_INPUT", "/payload/expiry",
                           f"expiry must be in the future and within ttl_seconds={cp['policy']['ttl_seconds']}")
        elif new == "EXPIRED":
            if not data["expiry"] or kr.parse_time(data["expiry"]) > now:
                raise _rej("INVALID_INPUT", "/payload/expiry", "EXPIRED needs the past expiry")
        elif data["expiry"] is not None:
            raise _rej("INVALID_INPUT", "/payload/expiry", f"{new} decisions carry expiry=null")
        cp = dict(cp, decisions=cp["decisions"] + [{"decision": new, "by": ctx.principal_id, "at": kr.iso(now)}])
        _put_state(ctx, kr.NS_K09, base["approval_id"], cp, rev)
        # The decision revision pins the exact subject versions it decides on (the checkpoint
        # binding), so readers of the stored decision (H10 publication/release authorization,
        # F/J approval checks) see the same subjects the kernel's ACCEPT binding check sees.
        return Result(data=data, transform="MANUAL", source_refs=list(cp["impact"].get("source_versions") or []))

    @staticmethod
    def _authorize(ctx: Context, cp: dict):
        owner = ctx.project["owner_id"] == ctx.principal_id
        scopes = ctx.store.scopes_for(ctx.principal_id, ctx.project_id, ctx.branch_id)
        roles = cp["policy"]["authorized_roles"]
        has_role = owner or "*" in scopes or any(f"role:{r}" in scopes for r in roles)
        if not has_role:
            raise _rej("PERMISSION_DENIED", "/payload/decision", f"decider lacks an authorized role {roles}")
        if cp["impact"]["protected"] and cp["requester"] == ctx.principal_id and not owner:
            raise _rej("PERMISSION_DENIED", "/payload/decision",
                       "a protected action cannot be authorized by its own requester (self-escalation)")


# ======================================================================================
# K10 - Pause/Resume
# ======================================================================================
@register("K10")
class PauseResume(OperationHandler):
    """PAUSE increments the queue generation (old attempts can no longer publish) and blocks new
    dispatch; running work may checkpoint (FINISH_AND_CHECKPOINT). RESUME re-opens dispatch;
    each new attempt revalidates pins/permissions and is fenced to the current generation."""

    def create(self, ctx: Context) -> Result:
        p = ctx.payload
        if p["project_id"] != ctx.project_id:
            raise _rej("INVALID_INPUT", "/payload/project_id", "project_id must match the request project")
        ctrl, rev = kr.queue_control(ctx.store, ctx.project_id, ctx.branch_id)
        if p["queue_generation"] != ctrl["generation"]:
            raise _rej("VERSION_CONFLICT", "/payload/queue_generation",
                       f"queue generation is {ctrl['generation']}")
        if p["command"] == "PAUSE":
            if ctrl["paused"]:
                return Result(data={"paused": True, "generation": ctrl["generation"], "worker_disposition": "NONE"})
            new = {"paused": True, "generation": ctrl["generation"] + 1, "paused_at": kr.iso(kr.now())}
            disp = "FINISH_AND_CHECKPOINT"
        else:
            if not ctrl["paused"]:
                return Result(data={"paused": False, "generation": ctrl["generation"], "worker_disposition": "NONE"})
            new = {"paused": False, "generation": ctrl["generation"], "resumed_at": kr.iso(kr.now())}
            disp = "REVALIDATE"
        _put_state(ctx, kr.NS_CTRL, kr.CTRL_KEY, new, rev)
        return Result(data={"paused": new["paused"], "generation": new["generation"], "worker_disposition": disp})

    def update(self, ctx: Context) -> Result:
        raise _rej("INVALID_INPUT", "/payload", "K10 state changes use CREATE PAUSE/RESUME commands")


# ======================================================================================
# K11 - Model/Tool Selector
# ======================================================================================
def resource_eligible(ctx: Context, r: dict, caps: set, need: int, slots: dict) -> str | None:
    """None when eligible, else the reason. AI entries are checked against the provider slot
    registry exactly like ProviderRegistry.eligible (connected, healthy, capability, project
    authorization, concurrency, context)."""
    if not caps <= set(r["capabilities"]):
        return "capability"
    if not r["healthy"]:
        return "unhealthy"
    if r["active_jobs"] >= r["max_concurrent"]:
        return "concurrency"
    if r["resource_kind"] != "AI":
        return None
    s = slots[r["ai_slot"]]
    providers = ctx.engine.providers
    if s["adapter_id"] == "none" or (s["adapter_id"] == "manual" and providers.test_adapter is None):
        return "slot not connected"
    if s["adapter_id"] != r["adapter_id"]:
        return "adapter mismatch with slot configuration"
    if not s["healthy"] or not caps <= set(s["capabilities"]):
        return "slot unhealthy or lacks capability"
    if "*" not in s["authorized_projects"] and ctx.project_id not in s["authorized_projects"]:
        return "slot not authorized for project"
    if max(r["active_jobs"], s["active_jobs"]) >= min(r["max_concurrent"], s["max_concurrent"]):
        return "slot concurrency"
    if need > min(r["context_limit_tokens"], s["context_limit_tokens"]):
        return "context"
    return None


@register("K11")
class ResourceSelector(OperationHandler):
    """CODE/TOOL first whenever eligible (deterministic); else among eligible AI slots lowest
    estimated cost, then active load, then slot ID. Exactly three AI slots exist (AI-1..AI-3);
    CODE/TOOL never occupy a slot. Resource currency must match the reservation quota currency."""

    def create(self, ctx: Context) -> Result:
        p = ctx.payload
        caps, need = set(p["capabilities"]), p["context_requirement"]
        reg = p["resource_registry"]
        seen_slots, seen_ids = set(), set()
        for i, r in enumerate(reg):
            path = f"/payload/resource_registry/{i}"
            if r["resource_id"] in seen_ids:
                raise _rej("INVALID_INPUT", path + "/resource_id", "duplicate resource_id")
            seen_ids.add(r["resource_id"])
            if r["resource_kind"] == "AI":
                if r["ai_slot"] is None:
                    raise _rej("INVALID_INPUT", path + "/ai_slot", "AI resources occupy one of AI-1..AI-3")
                if r["ai_slot"] in seen_slots:
                    raise _rej("INVALID_INPUT", path + "/ai_slot", "each AI slot appears once")
                seen_slots.add(r["ai_slot"])
            elif r["ai_slot"] is not None:
                raise _rej("INVALID_INPUT", path + "/ai_slot", "CODE/TOOL resources are not AI slots")
        slots = {s["slot_id"]: s for s in ctx.engine.providers.slots()}
        job_currencies = self._job_reservation_currencies(ctx, p["job_id"])
        eligible, reasons = [], {}
        for i, r in enumerate(reg):
            why = resource_eligible(ctx, r, caps, need, slots)
            if why is None:
                why = self._currency_mismatch(ctx, i, r, job_currencies)
            if why is None:
                eligible.append(r)
            else:
                reasons[r["resource_id"]] = why
        if not eligible:
            msg = "; ".join(f"{k}: {v}" for k, v in sorted(reasons.items()))
            code = "QUOTA_EXCEEDED" if reasons and all("currency" in v for v in reasons.values()) \
                else "CAPABILITY_UNAVAILABLE"
            raise BookforgeError(code, "/payload/resource_registry", f"no eligible resource ({msg})",
                                 unresolved=[f"{p['job_id']}:resource"])
        eligible.sort(key=lambda r: (0 if r["resource_kind"] in ("CODE", "TOOL") else 1,
                                     r["estimated_cost_minor_units"], r["active_jobs"],
                                     r["ai_slot"] or "", r["resource_id"]))
        return Result(data=dict(eligible[0]))

    def _job_reservation_currencies(self, ctx: Context, job_id: str) -> set[str]:
        out = set()
        for led in ctx.store.list_state(ctx.project_id, ctx.branch_id, kr.NS_LEDGER).values():
            if any(res["job_id"] == job_id and res["state"] in ("RESERVED", "AMBIGUOUS")
                   for res in led["reservations"].values()):
                out.add(led["currency"])
        return out

    def _currency_mismatch(self, ctx: Context, i: int, r: dict, job_currencies: set) -> str | None:
        currencies = set(job_currencies)
        rec = ctx.resolved.get(f"/payload/resource_registry/{i}/reservation_ref")
        if rec is not None:
            if rec["module_id"] != "K12" or not (rec["data"] or {}).get("allowed"):
                return "reservation_ref is not an allowed K12 reservation"
            res = find_reservation(ctx, rec["data"]["reservation_id"])
            if res is None:
                return "reservation not in ledger"
            currencies.add(res[0]["currency"])
        if currencies and currencies != {r["currency"]}:
            return f"currency {r['currency']} does not match reservation quota {sorted(currencies)}"
        return None

    def update(self, ctx: Context) -> Result:
        raise _rej("INVALID_INPUT", "/payload", f"K11 {DERIVED}")


# ======================================================================================
# K12 - Cost/Resource Controller
# ======================================================================================
def find_reservation(ctx: Context, reservation_id: str):
    for led in ctx.store.list_state(ctx.project_id, ctx.branch_id, kr.NS_LEDGER).values():
        res = led["reservations"].get(reservation_id)
        if res is not None:
            return led, res
    return None


@register("K12")
class CostController(OperationHandler):
    """Atomic reservation against the trusted ledger: allowed iff spent+reserved+estimate <= limit
    (integer minor units, one currency). Caller-supplied limit/usage are ignored (a finding notes
    disagreement). Denied: allowed=false, reservation_id=null, remaining=max(0,limit-spent-reserved),
    no mutation. Concurrent reservations CAS the ledger revision, so two cannot both pass."""

    def create(self, ctx: Context) -> Result:
        p = ctx.payload
        q = p["quota"]
        key = kr.ledger_key(q["account_id"], q["period"])
        led, rev = _state(ctx, kr.NS_LEDGER, key)
        if led is None:
            raise BookforgeError("MISSING_INPUT", "/payload/quota/account_id",
                                 "quota/usage unknown in trusted storage; configure the ledger before reserving")
        if q["currency"] != led["currency"]:
            raise _rej("INVALID_INPUT", "/payload/quota/currency",
                       f"ledger currency is {led['currency']}; no exchange-rate conversion")
        findings = []
        claimed = (q["limit"], p["usage"]["spent"], p["usage"]["reserved"])
        if claimed != (led["limit"], led["spent"], led["reserved"]):
            findings.append(ctx.finding("TRUSTED_BALANCES", f"caller balances {claimed} ignored; ledger has "
                                        f"limit={led['limit']} spent={led['spent']} reserved={led['reserved']}",
                                        severity="INFO", decision="PASS"))
        est = p["estimated_cost"]
        if led["spent"] + led["reserved"] + est > led["limit"]:
            findings.append(ctx.finding("QUOTA_EXCEEDED", f"estimate {est} exceeds remaining quota",
                                        severity="INFO", decision="FAIL"))
            return Result(data={"reservation_id": None, "allowed": False,
                                "remaining": max(0, led["limit"] - led["spent"] - led["reserved"])},
                          findings=findings)
        reservation_id = kr.new_id("resv")
        new = dict(led, reserved=led["reserved"] + est,
                   reservations=dict(led["reservations"], **{reservation_id: {
                       "job_id": p["job_id"], "amount": est, "state": "RESERVED", "currency": led["currency"],
                       "account_id": q["account_id"], "period": q["period"], "at": kr.iso(kr.now())}}))
        _put_state(ctx, kr.NS_LEDGER, key, new, rev)
        return Result(data={"reservation_id": reservation_id, "allowed": True,
                            "remaining": new["limit"] - new["spent"] - new["reserved"]}, findings=findings)

    def update(self, ctx: Context) -> Result:
        raise _rej("INVALID_INPUT", "/payload", "K12 outputs are ledger projections; settle/cancel through the "
                   "ledger service")

    def validate(self, ctx: Context, record: dict) -> list[dict]:
        rid = record["data"]["reservation_id"]
        if rid and find_reservation(ctx, rid) is None:
            return [ctx.finding("LEDGER", "reservation not present in the trusted ledger", severity="BLOCKING")]
        return []
