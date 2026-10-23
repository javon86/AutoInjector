"""Set K (K01-K12) orchestration tests: queue leases/fencing/generations, pause/restart/resume,
retry policy, approvals, scheduling, SCCs, resource selection and the quota race."""
from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone

import pytest

from bookforge import k_runtime as kr
from bookforge.engine import Engine
from bookforge.modules.set_k import tarjan_scc, verify_fence
from bookforge.store import Store

from conftest import PRINCIPAL, Harness, errors_of


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def future(minutes=30):
    return iso(datetime.now(timezone.utc) + timedelta(minutes=minutes))


def register(h, producer="A01", consumer="B01"):
    r = h.create("I03", {"producer": producer, "consumer": consumer, "contract_version": "BF-IRB-1.0.0",
                         "output_type": f"{producer}_record",
                         "dependency_predicate": {"stage": "CREATE", "kind": "HARD", "feature": None, "paths": []}})
    assert r["status"] == "DRAFT", r
    return r["output_refs"][0]


def a01(h, concept="Mara"):
    return h.create("A01", {"concept": concept})["output_refs"][0]


def complete_evidence(h, reg):
    out = a01(h, "finished output")
    h.approve(out)
    r = h.create("I12", {"operation_ref": reg, "phase": "PLANNING", "requirements": [], "evidence_ref": out,
                         "evidence_type": "COMMITTED_OUTPUT"})
    assert r["result"]["completion_state"] == "COMPLETE", r
    return r["output_refs"][0]


def transition(h, ref, state, attempt=None, input_refs=None, principal=None):
    data = h.record(ref)["data"]
    payload = {"queue_id": data["queue_id"], "attempt_id": attempt or data["attempt_id"], "lease_state": state}
    return h.dispatch("K05", "UPDATE", base_ref=ref, payload=payload, input_refs=input_refs or [],
                      principal=principal)


def enqueue(h, reg, job="job-1", sources=None):
    r = h.create("K05", {"job_id": job, "operation_ref": reg, "source_versions": sources or [], "priority": 5})
    assert r["status"] == "DRAFT" and r["result"]["lease_state"] == "QUEUED", r
    return r["output_refs"][0]


@pytest.fixture
def clock(monkeypatch):
    state = {"now": datetime.now(timezone.utc)}
    monkeypatch.setattr(kr, "now", lambda: state["now"])

    def advance(seconds):
        state["now"] = state["now"] + timedelta(seconds=seconds)
    state["advance"] = advance
    return state


# ---------------------------------------------------------------------------- K01
def test_k01_project_identity(engine):
    pid, r = kr.create_project(engine, PRINCIPAL, "Lighthouse",
                               {"locale": "en-GB", "default_mode": "AUTO", "max_parallel_jobs": 2})
    assert r["status"] == "DRAFT", r
    assert r["result"] == {"project_id": pid, "phase": "PLANNING", "revision": 1, "status": "ACTIVE"}
    h = Harness(engine, pid)
    again = h.create("K01", {"project_name": "x", "settings": {"locale": "en-US", "default_mode": "MANUAL",
                                                               "max_parallel_jobs": 1}, "owner_id": PRINCIPAL})
    assert errors_of(again)[0][0] == "VERSION_CONFLICT"
    assert kr.project_settings(engine.store, pid, "main")["max_parallel_jobs"] == 2


def test_k01_owner_must_match(h):
    r = h.create("K01", {"project_name": "x", "settings": {"locale": "en-US", "default_mode": "MANUAL",
                                                           "max_parallel_jobs": 1}, "owner_id": "mallory"})
    assert errors_of(r)[0] == ("PERMISSION_DENIED", "/payload/owner_id")


# ---------------------------------------------------------------------------- K02 / K08
def test_k02_schedules_manifest_membership_only(h):
    m = h.store.feature_manifest(h.project_id, "main")
    r = h.create("K02", {"project_id": h.project_id, "phase": m["phase"], "feature_manifest": m,
                         "completion_refs": [], "mode": "MANUAL"})
    assert r["status"] == "DRAFT", r
    sched, blocked = set(r["result"]["scheduled_jobs"]), set(r["result"]["blocked_jobs"])
    rev = m["revision"]
    assert f"A01@manifest-r{rev}" in sched           # no record prerequisites
    assert f"B03@manifest-r{rev}" in blocked         # needs an approved B01 premise
    assert not any(j.startswith("B08@") for j in sched | blocked)  # mystery=false: not required
    assert not any(j.startswith("D") for j in sched | blocked)
    stale = dict(m, phase="DRAFTING")
    assert errors_of(h.create("K02", {"project_id": h.project_id, "phase": "DRAFTING", "feature_manifest": stale,
                                      "completion_refs": [], "mode": "AUTO"}))[0][0] == "VERSION_CONFLICT"
    # completion evidence removes A01 from the schedule
    done = complete_evidence(h, register(h))
    r = h.create("K02", {"project_id": h.project_id, "phase": m["phase"], "feature_manifest": m,
                         "completion_refs": [done], "mode": "AUTO"})
    assert f"A01@manifest-r{rev}" not in r["result"]["scheduled_jobs"]


def test_k08_progress_counts_only_evidence(h):
    m = h.store.feature_manifest(h.project_id, "main")
    small = dict(m, required_operations=["A01", "A02"])
    m = h.engine.set_manifest(PRINCIPAL, h.project_id, "main", small)
    base = {"project_id": h.project_id, "feature_manifest": m, "completion_refs": [],
            "queue_states": [{"job_id": "A02-job", "state": "COMPLETE"}]}
    r = h.create("K08", base)
    assert r["result"] == {"progress": 0, "blockers": [], "phase_ready": False}
    done = complete_evidence(h, register(h))
    r = h.create("K08", dict(base, completion_refs=[done],
                             queue_states=[{"job_id": "A02-job", "state": "BLOCKED"}]))
    assert r["result"] == {"progress": 0.5, "blockers": ["A02-job"], "phase_ready": False}
    empty = h.engine.set_manifest(PRINCIPAL, h.project_id, "main", dict(small, required_operations=[]))
    r = h.create("K08", dict(base, feature_manifest=empty, queue_states=[]))
    assert r["result"]["phase_ready"] is False  # empty phase is not ready without explicit policy


# ---------------------------------------------------------------------------- K03 / K04
def test_k03_routes(h):
    reg = register(h)
    r = h.create("K03", {"job_id": "j", "operation_ref": reg, "registry_revision": 1, "capability_requirements": []})
    assert r["result"] == {"route": "CODE:A01", "adapter_ref": reg}
    stale = h.create("K03", {"job_id": "j", "operation_ref": reg, "registry_revision": 0,
                             "capability_requirements": []})
    assert errors_of(stale)[0] == ("VERSION_CONFLICT", "/payload/registry_revision")
    ai = register(h, producer="B01", consumer="B03")
    r = h.create("K03", {"job_id": "j", "operation_ref": ai, "registry_revision": 2,
                         "capability_requirements": ["text"]})
    assert r["result"]["route"] == "MANUAL:B01"  # no slot connected: manual candidate
    h.engine.providers.configure_slot("AI-2", {"adapter_id": "anthropic"})
    r = h.create("K03", {"job_id": "j", "operation_ref": ai, "registry_revision": 2,
                         "capability_requirements": ["text"]})
    assert r["result"]["route"] == "AI:B01"


def test_tarjan_scc_exact():
    comps = tarjan_scc(["a", "b", "c", "d", "e"], [("a", "b"), ("b", "c"), ("c", "a"), ("c", "d"), ("e", "e")])
    assert sorted(comps) == [["a", "b", "c"], ["d"], ["e"]]


def test_k04_cycles_bootstrap_and_missing(h):
    g = {"nodes": ["A01", "B01", "B03", "C02"],
         "hard_edges": [{"from": "A01", "to": "B01"}, {"from": "B01", "to": "B03"}, {"from": "B03", "to": "B01"},
                        {"from": "B03", "to": "C02"}],
         "bootstrap_edges": []}
    r = h.create("K04", {"job_id": "C02", "dependency_graph": g, "completion_refs": []})
    assert r["status"] == "DRAFT"
    assert r["result"]["ready"] is False and r["result"]["cycles"] == [["B01", "B03"]]
    assert any("B01->B03" in f["message"] and "B03->B01" in f["message"] for f in r["findings"])
    assert errors_of(r)[0][0] == "DEPENDENCY_CYCLE"
    g["bootstrap_edges"] = [{"from": "B03", "to": "B01"}]
    r = h.create("K04", {"job_id": "C02", "dependency_graph": g, "completion_refs": []})
    assert r["result"]["cycles"] == [] and r["result"]["missing"] == ["A01", "B01", "B03"]
    assert r["result"]["bootstrap_plan"] == ["A01", "B01", "B03", "C02", "REVISE:B01<-B03"]
    done = complete_evidence(h, register(h))
    r = h.create("K04", {"job_id": "C02", "dependency_graph": g, "completion_refs": [done]})
    assert r["result"]["missing"] == ["B01", "B03"]
    g["bootstrap_edges"] = [{"from": "C02", "to": "A01"}]
    assert errors_of(h.create("K04", {"job_id": "C02", "dependency_graph": g, "completion_refs": []}))[0][0] \
        == "INVALID_INPUT"


# ---------------------------------------------------------------------------- K05 queue
def test_k05_lifecycle_and_completion_requires_evidence(h, clock):
    reg = register(h)
    q = enqueue(h, reg)
    assert errors_of(h.create("K05", {"job_id": "job-1", "operation_ref": reg, "source_versions": [],
                                      "priority": 1}))[0][0] == "VERSION_CONFLICT"
    leased = transition(h, q, "LEASED")
    assert leased["status"] == "DRAFT", leased
    lq = leased["output_refs"][0]
    attempt = leased["result"]["attempt_id"]
    assert attempt != h.record(q)["data"]["attempt_id"]
    verify_fence(h.store, h.project_id, "main", q["record_id"], attempt, fencing_token=1)
    clock["advance"](30)
    renewed = transition(h, lq, "LEASED")
    assert renewed["status"] == "DRAFT" and renewed["result"]["attempt_id"] == attempt
    lq = renewed["output_refs"][0]
    # worker claims success without I12 evidence -> refused
    claim = transition(h, lq, "COMPLETED")
    assert errors_of(claim)[0][0] == "MISSING_INPUT"
    ev = complete_evidence(h, reg)
    done = transition(h, lq, "COMPLETED", input_refs=[ev])
    assert done["status"] == "DRAFT" and done["result"]["lease_state"] == "COMPLETED", done
    again = transition(h, done["output_refs"][0], "QUEUED")
    assert errors_of(again)[0][0] == "INVALID_INPUT"
    # job index released: same job_id may be enqueued again
    enqueue(h, reg)


def test_k05_lease_expiry_reclaim_and_fencing(h, clock):
    reg = register(h)
    q = enqueue(h, reg)
    l1 = transition(h, q, "LEASED")
    a1, ref1 = l1["result"]["attempt_id"], l1["output_refs"][0]
    early = transition(h, ref1, "QUEUED")
    assert errors_of(early)[0][0] == "INVALID_INPUT"  # lease still valid
    clock["advance"](kr.LEASE_SECONDS + 1)
    late = transition(h, ref1, "LEASED")  # heartbeat after expiry
    assert errors_of(late)[0][0] == "LEASE_EXPIRED"
    with pytest.raises(Exception):
        verify_fence(h.store, h.project_id, "main", q["record_id"], a1)
    rq = transition(h, ref1, "QUEUED")
    assert rq["status"] == "DRAFT", rq
    l2 = transition(h, rq["output_refs"][0], "LEASED")
    a2 = l2["result"]["attempt_id"]
    assert a2 != a1
    ev = complete_evidence(h, reg)
    # the late worker re-reads the head and tries to publish with its fenced attempt
    stale = transition(h, l2["output_refs"][0], "COMPLETED", attempt=a1, input_refs=[ev])
    assert errors_of(stale)[0][0] == "LEASE_EXPIRED"
    ok = transition(h, l2["output_refs"][0], "COMPLETED", input_refs=[ev])
    assert ok["result"]["lease_state"] == "COMPLETED"
    job = h.store.get_state(h.project_id, "main", kr.NS_JOBS, q["record_id"])
    assert job["fencing_token"] == 2 and job["attempts"] == [a1, a2]


def test_k05_concurrent_dispatch_single_lease(h):
    reg = register(h)
    q = enqueue(h, reg)
    results, barrier = [], threading.Barrier(4)

    def worker():
        barrier.wait()
        results.append(transition(h, q, "LEASED"))
    threads = [threading.Thread(target=worker) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    ok = [r for r in results if r["status"] == "DRAFT"]
    assert len(ok) == 1, [r["errors"] for r in results]
    assert all(errors_of(r)[0][0] == "VERSION_CONFLICT" for r in results if r["status"] != "DRAFT"), \
        [r["errors"] for r in results]
    job = h.store.get_state(h.project_id, "main", kr.NS_JOBS, q["record_id"])
    assert job["fencing_token"] == 1 and job["attempt_id"] == ok[0]["result"]["attempt_id"]


def test_k05_max_parallel_jobs(h):
    reg = register(h)
    q1, q2 = enqueue(h, reg, "j1"), enqueue(h, reg, "j2")
    assert transition(h, q1, "LEASED")["status"] == "DRAFT"
    r = transition(h, q2, "LEASED")
    assert errors_of(r)[0][0] == "RATE_LIMITED"  # default max_parallel_jobs=1


def test_k05_retry_flow_with_k07(h, clock):
    reg = register(h)
    q = enqueue(h, reg)
    l1 = transition(h, q, "LEASED")
    a1 = l1["result"]["attempt_id"]
    no_dec = transition(h, l1["output_refs"][0], "RETRYING")
    assert errors_of(no_dec)[0][0] == "MISSING_INPUT"
    dec = h.create("K07", {"job_id": "job-1", "attempt_id": a1, "error_code": "TIMEOUT",
                           "retry_policy": {"max_attempts": 3, "base_delay_ms": 1000, "max_delay_ms": 4000,
                                            "deadline": future()}})
    assert dec["result"]["decision"] == "RETRY"
    r = transition(h, l1["output_refs"][0], "RETRYING")
    assert r["result"]["lease_state"] == "RETRYING"
    early = transition(h, r["output_refs"][0], "QUEUED")
    assert errors_of(early)[0][0] == "RATE_LIMITED"
    clock["advance"](5)
    assert transition(h, r["output_refs"][0], "QUEUED")["result"]["lease_state"] == "QUEUED"


# ---------------------------------------------------------------------------- K10 pause/restart/resume
def test_k10_pause_restart_resume_rejects_old_worker(h, clock, tmp_path):
    reg = register(h)
    q = enqueue(h, reg)
    l1 = transition(h, q, "LEASED")
    a1, ref1 = l1["result"]["attempt_id"], l1["output_refs"][0]
    p = h.create("K10", {"project_id": h.project_id, "command": "PAUSE", "queue_generation": 0})
    assert p["result"] == {"paused": True, "generation": 1, "worker_disposition": "FINISH_AND_CHECKPOINT"}
    assert errors_of(h.create("K10", {"project_id": h.project_id, "command": "RESUME",
                                      "queue_generation": 0}))[0][0] == "VERSION_CONFLICT"
    # "restart": a brand-new engine over the same durable storage
    data_dir = h.store.data_dir
    h.store.close()
    eng2 = Engine(Store(data_dir), h.engine.contracts)
    h2 = Harness(eng2, h.project_id)
    ev = complete_evidence(h2, reg)
    old = transition(h2, ref1, "COMPLETED", input_refs=[ev])  # lease still unexpired but generation is stale
    assert errors_of(old)[0][0] == "LEASE_EXPIRED"
    rq = transition(h2, ref1, "QUEUED")  # reclaim the stale-generation lease
    assert rq["status"] == "DRAFT", rq
    blocked = transition(h2, rq["output_refs"][0], "LEASED")
    assert blocked["status"] == "BLOCKED"  # paused: no new dispatch
    res = h2.create("K10", {"project_id": h.project_id, "command": "RESUME", "queue_generation": 1})
    assert res["result"] == {"paused": False, "generation": 1, "worker_disposition": "REVALIDATE"}
    l2 = transition(h2, rq["output_refs"][0], "LEASED")
    assert l2["status"] == "DRAFT" and l2["result"]["attempt_id"] != a1
    done = transition(h2, l2["output_refs"][0], "COMPLETED", input_refs=[ev])
    assert done["result"]["lease_state"] == "COMPLETED"
    again = transition(h2, l2["output_refs"][0], "COMPLETED", input_refs=[ev])
    assert again["status"] != "DRAFT"  # committed exactly once
    job = eng2.store.get_state(h.project_id, "main", kr.NS_JOBS, q["record_id"])
    assert job["state"] == "COMPLETED" and job["generation"] == 1
    eng2.store.close()


# ---------------------------------------------------------------------------- K07
def test_k07_policy(h, clock):
    pol = {"max_attempts": 5, "base_delay_ms": 1000, "max_delay_ms": 10000, "deadline": future()}
    now = clock["now"]
    r1 = h.create("K07", {"job_id": "j", "attempt_id": "a1", "error_code": "TIMEOUT", "retry_policy": pol})
    assert r1["result"]["decision"] == "RETRY" and r1["result"]["repair_request"] is None
    t1 = datetime.fromisoformat(r1["result"]["next_attempt_at"].replace("Z", "+00:00")) - now
    assert timedelta(seconds=1) <= t1 <= timedelta(seconds=2)
    r2 = h.create("K07", {"job_id": "j", "attempt_id": "a2", "error_code": "TIMEOUT", "retry_policy": pol})
    t2 = datetime.fromisoformat(r2["result"]["next_attempt_at"].replace("Z", "+00:00")) - now
    assert timedelta(seconds=2) <= t2 <= timedelta(seconds=4)
    r3 = h.create("K07", {"job_id": "j", "attempt_id": "a3", "error_code": "TIMEOUT", "retry_policy": pol})
    assert r3["result"] == {"decision": "FAIL", "next_attempt_at": None, "repair_request": None}  # 3 attempts max
    blk = h.create("K07", {"job_id": "k", "attempt_id": "b1", "error_code": "VERSION_CONFLICT", "retry_policy": pol})
    assert blk["result"]["decision"] == "BLOCK" and blk["result"]["next_attempt_at"] is None
    assert blk["result"]["repair_request"].startswith("VERSION_CONFLICT")
    ie = h.create("K07", {"job_id": "k", "attempt_id": "b2", "error_code": "INTERNAL_ERROR", "retry_policy": pol})
    assert ie["result"] == {"decision": "FAIL", "next_attempt_at": None, "repair_request": None}
    near = dict(pol, deadline=iso(now + timedelta(milliseconds=500)))
    assert h.create("K07", {"job_id": "z", "attempt_id": "c1", "error_code": "TIMEOUT",
                            "retry_policy": near})["result"]["decision"] == "FAIL"


# ---------------------------------------------------------------------------- K06 / K09
def k09(h, refs, protected=True, roles=("editor",), ttl=3600):
    r = h.create("K09", {"action_id": "act-1", "impact": {"action_hash": "abc", "source_versions": refs,
                                                          "protected": protected},
                         "policy": {"policy_id": "pol", "authorized_roles": list(roles), "ttl_seconds": ttl},
                         "base_revision": 1})
    assert r["result"]["decision"] == "PENDING" and r["result"]["expiry"] is None, r
    return r["output_refs"][0]


def decide(h, ref, decision, expiry=None, principal=None):
    return h.dispatch("K09", "UPDATE", base_ref=ref, principal=principal,
                      payload={"approval_id": ref["record_id"], "decision": decision, "expiry": expiry})


def test_k09_transitions_and_engine_compatibility(h):
    subj = a01(h)
    cp = k09(h, [subj])
    assert errors_of(decide(h, cp, "APPROVED", None))[0] == ("INVALID_INPUT", "/payload/expiry")
    too_long = iso(datetime.now(timezone.utc) + timedelta(days=2))
    assert errors_of(decide(h, cp, "APPROVED", too_long))[0] == ("INVALID_INPUT", "/payload/expiry")
    assert errors_of(decide(h, cp, "REJECTED", future()))[0] == ("INVALID_INPUT", "/payload/expiry")
    with h.store.transaction() as tx:
        tx.ensure_principal("intern")
        tx.grant("intern", h.project_id, "main", "K09:update")
    assert errors_of(decide(h, cp, "APPROVED", future(), principal="intern"))[0][0] == "PERMISSION_DENIED"
    ok = decide(h, cp, "APPROVED", future())
    assert ok["status"] == "DRAFT", ok
    appr = ok["output_refs"][0]
    # kernel ACCEPT reads K09 decision/expiry
    assert h.validate(subj)["status"] == "VALIDATED"
    assert h.accept(subj, appr)["status"] == "APPROVED"
    rev = decide(h, appr, "REVOKED", None)
    assert rev["status"] == "DRAFT" and rev["result"]["expiry"] is None
    assert errors_of(decide(h, rev["output_refs"][0], "APPROVED", future()))[0][0] == "INVALID_INPUT"


def test_k06_modes(h):
    pol = {"policy_id": "p", "revision": 1, "requires_approval": False}
    auto = {"job_id": "j", "mode": "AUTO", "action_class": "DRAFT", "approval_policy": pol}
    # project default (no K01 identity) is MANUAL: AUTO cannot be self-selected
    r = h.create("K06", auto)
    assert r["result"]["decision"] == "HOLD" and "manual" in r["result"]["hold_reason"]
    with h.store.transaction() as tx:
        tx.put_state(h.project_id, "main", kr.NS_K01, "identity",
                     {"record_id": "x", "settings": {"locale": "en-US", "default_mode": "AUTO",
                                                     "max_parallel_jobs": 1}})
    assert h.create("K06", auto)["result"]["decision"] == "ALLOW"
    pub = h.create("K06", dict(auto, action_class="PUBLISH"))
    assert pub["result"]["decision"] == "HOLD"
    subj = a01(h)
    cp = k09(h, [subj])
    pend = h.create("K06", dict(auto, action_class="PUBLISH"), input_refs=[cp])
    assert pend["result"]["decision"] == "DENY"
    appr = decide(h, cp, "APPROVED", future())["output_refs"][0]
    assert h.create("K06", dict(auto, action_class="PUBLISH"), input_refs=[appr])["result"]["decision"] == "ALLOW"


# ---------------------------------------------------------------------------- K11
def res(rid, kind="AI", slot=None, cost=10, active=0, caps=("text",), currency="USD", adapter="anthropic",
        healthy=True, ctx=100000, reservation=None):
    return {"resource_kind": kind, "resource_id": rid, "ai_slot": slot, "adapter_id": adapter,
            "capabilities": list(caps), "context_limit_tokens": ctx, "healthy": healthy, "max_concurrent": 2,
            "active_jobs": active, "estimated_cost_minor_units": cost, "currency": currency,
            "reservation_ref": reservation}


def test_k11_selection_rules(h):
    pr = h.engine.providers
    for s in ("AI-1", "AI-2", "AI-3"):
        pr.configure_slot(s, {"adapter_id": "anthropic"})
    pr.configure_slot("AI-3", {"adapter_id": "anthropic", "healthy": False})
    ai = [res("r1", slot="AI-1", cost=20), res("r2", slot="AI-2", cost=10, active=1),
          res("r3", slot="AI-3", cost=1)]
    base = {"job_id": "j", "capabilities": ["text"], "context_requirement": 1000, "resource_registry": ai}
    r = h.create("K11", base)
    assert r["result"]["resource_id"] == "r2"  # AI-3 slot unhealthy; lowest cost among eligible
    tie = [res("r1", slot="AI-1", cost=10, active=1), res("r2", slot="AI-2", cost=10, active=0)]
    assert h.create("K11", dict(base, resource_registry=tie))["result"]["resource_id"] == "r2"
    tie = [res("r2", slot="AI-2", cost=10), res("r1", slot="AI-1", cost=10)]
    assert h.create("K11", dict(base, resource_registry=tie))["result"]["ai_slot"] == "AI-1"
    code = res("lint", kind="CODE", cost=0, caps=("text",), adapter="python")
    r = h.create("K11", dict(base, resource_registry=ai + [code]))
    assert r["result"]["resource_kind"] == "CODE" and r["result"]["ai_slot"] is None
    bad = h.create("K11", dict(base, resource_registry=[res("x", slot=None)]))
    assert errors_of(bad)[0][1] == "/payload/resource_registry/0/ai_slot"
    dup = h.create("K11", dict(base, resource_registry=[res("x", slot="AI-1"), res("y", slot="AI-1")]))
    assert errors_of(dup)[0][0] == "INVALID_INPUT"
    pr.configure_slot("AI-1", {"adapter_id": "none"})
    pr.configure_slot("AI-2", {"adapter_id": "none"})
    none = h.create("K11", dict(base, resource_registry=ai))
    assert none["status"] == "BLOCKED" and errors_of(none)[0][0] == "CAPABILITY_UNAVAILABLE"


def test_k11_agrees_with_provider_registry(h):
    pr = h.engine.providers
    pr.configure_slot("AI-1", {"adapter_id": "anthropic", "input_cost_minor_per_mtok": 900})
    pr.configure_slot("AI-2", {"adapter_id": "anthropic", "input_cost_minor_per_mtok": 300})
    need = 50000
    expected = pr.eligible(h.project_id, "text", need)[0]["slot_id"]
    reg = [res(f"r-{s['slot_id']}", slot=s["slot_id"], cost=need * s["input_cost_minor_per_mtok"] // 1_000_000,
               adapter=s["adapter_id"]) for s in pr.slots()]
    r = h.create("K11", {"job_id": "j", "capabilities": ["text"], "context_requirement": need,
                         "resource_registry": reg})
    assert r["result"]["ai_slot"] == expected == "AI-2"


def test_k11_and_provider_registry_pick_the_role_matched_slot(h):
    pr = h.engine.providers
    pr.configure_slot("AI-1", {"adapter_id": "anthropic", "input_cost_minor_per_mtok": 300})
    pr.configure_slot("AI-2", {"adapter_id": "anthropic", "input_cost_minor_per_mtok": 600, "roles": ["B"]})
    pr.configure_slot("AI-3", {"adapter_id": "anthropic", "input_cost_minor_per_mtok": 900, "roles": ["C02"]})
    need = 50000
    reg = [res(f"r-{s['slot_id']}", slot=s["slot_id"], cost=need * s["input_cost_minor_per_mtok"] // 1_000_000,
               adapter=s["adapter_id"]) for s in pr.slots()]
    enqueue(h, register(h, producer="C02"), job="job-c02")
    for job_id, op, slot in (("job-c02", "C02", "AI-3"), ("C03:ch1", "C03", "AI-1"), ("B07", "B07", "AI-2"),
                             ("j", None, "AI-1")):
        expected = pr.eligible(h.project_id, "text", need, op)[0]["slot_id"]
        r = h.create("K11", {"job_id": job_id, "capabilities": ["text"], "context_requirement": need,
                             "resource_registry": reg})
        assert r["result"]["ai_slot"] == expected == slot, (job_id, r)
    # CODE/TOOL still win over a role-matched AI slot.
    code = res("lint", kind="CODE", cost=0, adapter="python")
    r = h.create("K11", {"job_id": "job-c02", "capabilities": ["text"], "context_requirement": need,
                         "resource_registry": reg + [code]})
    assert r["result"]["resource_kind"] == "CODE"


def test_k11_currency_must_match_reservation(h):
    h.engine.providers.configure_slot("AI-1", {"adapter_id": "anthropic"})
    kr.configure_quota(h.store, PRINCIPAL, h.project_id, "main", account_id="acct", period="2026-10",
                       limit=1000, currency="USD")
    rr = h.create("K12", {"job_id": "j", "estimated_cost": 10, "quota": {"account_id": "acct", "limit": 1000,
                                                                       "period": "2026-10", "currency": "USD"},
                          "usage": {"spent": 0, "reserved": 0}})
    resv = rr["output_refs"][0]
    base = {"job_id": "j", "capabilities": ["text"], "context_requirement": 10}
    eur = h.create("K11", dict(base, resource_registry=[res("r1", slot="AI-1", currency="EUR", reservation=resv)]))
    assert eur["status"] == "BLOCKED" and "currency" in eur["errors"][0]["message"]
    usd = h.create("K11", dict(base, resource_registry=[res("r1", slot="AI-1", currency="USD", reservation=resv)]))
    assert usd["status"] == "DRAFT", usd


# ---------------------------------------------------------------------------- K12
def reserve(h, est, job="j", claimed=(0, 0, 0), currency="USD", key=None):
    limit, spent, reserved = claimed
    return h.create("K12", {"job_id": job, "estimated_cost": est,
                            "quota": {"account_id": "acct", "limit": limit, "period": "2026-10",
                                      "currency": currency},
                            "usage": {"spent": spent, "reserved": reserved}},
                    **({"idempotency_key": key} if key else {}))


def ledger(h):
    return kr.get_ledger(h.store, h.project_id, "main", "acct", "2026-10")[0]


def test_k12_trusted_ledger_semantics(h):
    assert errors_of(reserve(h, 10))[0][0] == "MISSING_INPUT"  # unknown quota blocks
    kr.configure_quota(h.store, PRINCIPAL, h.project_id, "main", account_id="acct", period="2026-10",
                       limit=100, currency="USD")
    # caller-supplied huge limit is ignored
    r = reserve(h, 150, claimed=(10 ** 9, 0, 0))
    assert r["result"] == {"reservation_id": None, "allowed": False, "remaining": 100}
    assert ledger(h)["reserved"] == 0 and ledger(h)["reservations"] == {}
    assert errors_of(reserve(h, 1, currency="EUR"))[0] == ("INVALID_INPUT", "/payload/quota/currency")
    ok = reserve(h, 70, key="k-70")
    assert ok["result"]["allowed"] is True and ok["result"]["remaining"] == 30
    rid = ok["result"]["reservation_id"]
    assert rid in ledger(h)["reservations"]
    replay = reserve(h, 70, key="k-70")  # duplicate delivery: same logical result, ledger unchanged
    assert replay["result"] == ok["result"] and ledger(h)["reserved"] == 70
    # settle with overrun: incurred charge recorded in full, next work held
    out = kr.settle(h.store, PRINCIPAL, h.project_id, "main", account_id="acct", period="2026-10",
                    reservation_id=rid, actual=75)
    assert out["overrun"] == 5 and out["ledger"]["spent"] == 75 and out["ledger"]["reserved"] == 0
    r2 = reserve(h, 20)
    assert r2["result"]["allowed"] is True and r2["result"]["remaining"] == 5
    led = kr.cancel_reservation(h.store, PRINCIPAL, h.project_id, "main", account_id="acct", period="2026-10",
                                reservation_id=r2["result"]["reservation_id"], spent=3)
    assert led["spent"] == 78 and led["reserved"] == 0
    with pytest.raises(Exception):
        kr.settle(h.store, PRINCIPAL, h.project_id, "main", account_id="acct", period="2026-10",
                  reservation_id=r2["result"]["reservation_id"], actual=1)
    assert h.validate(r2["output_refs"][0])["status"] == "VALIDATED"


def test_k12_quota_race_allows_at_most_one(h):
    kr.configure_quota(h.store, PRINCIPAL, h.project_id, "main", account_id="acct", period="2026-10",
                       limit=100, currency="USD")
    first = reserve(h, 70)
    kr.settle(h.store, PRINCIPAL, h.project_id, "main", account_id="acct", period="2026-10",
              reservation_id=first["result"]["reservation_id"], actual=70)
    for round_ in range(3):
        results, barrier = [], threading.Barrier(2)

        def worker(i):
            barrier.wait()
            results.append(reserve(h, 20, job=f"race-{round_}-{i}"))
        threads = [threading.Thread(target=worker, args=(i,)) for i in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        allowed = [r for r in results if r["result"] and r["result"]["allowed"]]
        assert len(allowed) <= 1
        losers = [r for r in results if r not in allowed]
        for r in losers:  # denied in-band, or lost the CAS race (no mutation) and must re-evaluate
            assert (r["result"] and r["result"]["allowed"] is False and r["result"]["reservation_id"] is None) \
                or errors_of(r)[0][0] == "VERSION_CONFLICT"
        led = ledger(h)
        assert led["spent"] + led["reserved"] <= led["limit"]
        active = [x for x in led["reservations"].values() if x["state"] == "RESERVED"]
        assert len(active) == (1 if round_ == 0 else 1) and led["reserved"] == 20
        # a retried loser now sees the trusted balance and is denied
        retry = reserve(h, 20, job="late")
        assert retry["result"] == {"reservation_id": None, "allowed": False, "remaining": 10}


def test_k12_crash_before_and_after_commit(h):
    from bookforge.store import CrashInjected
    kr.configure_quota(h.store, PRINCIPAL, h.project_id, "main", account_id="acct", period="2026-10",
                       limit=100, currency="USD")
    req = h.request("K12", "CREATE", payload={"job_id": "j", "estimated_cost": 40,
                                              "quota": {"account_id": "acct", "limit": 100, "period": "2026-10",
                                                        "currency": "USD"},
                                              "usage": {"spent": 0, "reserved": 0}})

    def crash(point):
        if point == "before_commit":
            raise CrashInjected(point)
    h.store.fault_hook = crash
    assert h.engine.dispatch(req, PRINCIPAL)["status"] == "BLOCKED"
    h.store.fault_hook = None
    assert ledger(h)["reserved"] == 0 and h.store.list_records(h.project_id, "main", module_id="K12") == []

    def crash_after(point):
        if point == "after_commit":
            raise CrashInjected(point)
    h.store.fault_hook = crash_after
    h.engine.dispatch(req, PRINCIPAL)
    h.store.fault_hook = None
    retry = h.engine.dispatch(dict(req, request_id="req-retry"), PRINCIPAL)  # same idempotency key
    assert retry["result"]["allowed"] is True
    assert ledger(h)["reserved"] == 40 and len(ledger(h)["reservations"]) == 1
    assert len(h.store.list_records(h.project_id, "main", module_id="K12")) == 1
