"""Set I (I02-I15) handler tests plus backup/restore and migration rehearsal."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from akowe import i_maintenance as im
from akowe import k_runtime as kr
from akowe.store import CrashInjected, Store

from conftest import PRINCIPAL, errors_of


def future(minutes=30):
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")


def a01(h, concept="Mara, lighthouse keeper"):
    r = h.create("A01", {"concept": concept})
    assert r["status"] == "DRAFT", r
    return r["output_refs"][0]


def register(h, producer="A01", consumer="B01", kind="HARD", feature=None, paths=None):
    r = h.create("I03", {"producer": producer, "consumer": consumer, "contract_version": "BF-IRB-1.0.0",
                         "output_type": f"{producer}_record",
                         "dependency_predicate": {"stage": "CREATE", "kind": kind, "feature": feature,
                                                  "paths": paths or []}})
    assert r["status"] == "DRAFT", r
    return r["output_refs"][0]


SCHEMA_V1 = {"type": "object", "properties": {"name": {"type": "string"}, "age": {"type": "integer"}},
             "required": ["name"], "additionalProperties": False}


def schema(h, sid="character", ver="1.0.0", doc=SCHEMA_V1, policy="ADDITIVE"):
    return h.create("I02", {"schema_id": sid, "semantic_version": ver, "json_schema": doc,
                            "compatibility_policy": policy})


# ---------------------------------------------------------------------------- I02
def test_i02_check_schema_and_versions(h):
    r = schema(h)
    assert r["status"] == "DRAFT" and r["result"]["version"] == 1
    bad = schema(h, sid="x", doc={"type": 12})
    assert errors_of(bad)[0][0] == "INVALID_INPUT" and errors_of(bad)[0][1].startswith("/payload/json_schema")
    # same version is immutable
    assert errors_of(schema(h, ver="1.0.0"))[0][0] == "VERSION_CONFLICT"
    # additive change on the same major is fine
    v2 = dict(SCHEMA_V1, properties=dict(SCHEMA_V1["properties"], title={"type": "string"}))
    assert schema(h, ver="1.1.0", doc=v2)["result"]["version"] == 2
    # breaking change (new required field) refused on same major, accepted as new major
    v3 = dict(v2, required=["name", "age"])
    assert errors_of(schema(h, ver="1.2.0", doc=v3))[0] == ("INVALID_INPUT", "/payload/semantic_version")
    assert schema(h, ver="2.0.0", doc=v3, policy="BREAKING")["status"] == "DRAFT"
    # never mutate a version
    ref = r["output_refs"][0]
    upd = h.dispatch("I02", "UPDATE", base_ref=ref, payload=dict(r["result"], schema_hash="0" * 64))
    assert upd["status"] == "REJECTED"
    assert h.approve(ref)["status"] == "APPROVED"


# ---------------------------------------------------------------------------- I03
def test_i03_registry_rules(h):
    ref = register(h)
    assert h.record(ref)["data"]["registration_id"] == ref["record_id"]
    bad = h.create("I03", {"producer": "A01", "consumer": "B01", "contract_version": "BF-IRB-1.0.0",
                           "output_type": "B01_record",
                           "dependency_predicate": {"stage": "CREATE", "kind": "HARD", "feature": None, "paths": []}})
    assert errors_of(bad)[0] == ("INVALID_INPUT", "/payload/output_type")
    bad = h.create("I03", {"producer": "A01", "consumer": "B01", "contract_version": "BF-IRB-1.0.0",
                           "output_type": "A01_record",
                           "dependency_predicate": {"stage": "CREATE", "kind": "HARD", "feature": "dragons",
                                                    "paths": []}})
    assert errors_of(bad)[0][1] == "/payload/dependency_predicate/feature"
    assert errors_of(h.create("I03", {"producer": "Z99", "consumer": "B01", "contract_version": "BF-IRB-1.0.0",
                                      "output_type": "x", "dependency_predicate": {
                                          "stage": "CREATE", "kind": "HARD", "feature": None, "paths": []}}))
    from akowe.modules.set_i import registry_revision
    assert registry_revision(h.store, h.project_id, "main") == 1


# ---------------------------------------------------------------------------- I04
def test_i04_validates_against_exact_schema_and_subject_hash(h):
    sref = schema(h)["output_refs"][0]
    r = h.create("I04", {"schema_ref": sref, "subject_ref": None, "subject_payload": {"age": "old", "x": 1}})
    assert r["status"] == "DRAFT"
    res = r["result"]
    assert res["valid"] is False and res["schema_version"] == "character@1.0.0"
    paths = {(v["code"], v["path"]) for v in res["violations"]}
    assert ("MISSING_INPUT", "/name") in paths and ("INVALID_INPUT", "/x") in paths and ("INVALID_INPUT", "/age") in paths
    ok = h.create("I04", {"schema_ref": sref, "subject_ref": None, "subject_payload": {"name": "Mara"}})
    assert ok["result"] == {"valid": True, "violations": [], "schema_version": "character@1.0.0"}
    # subject_ref must be the staged content itself
    subj = a01(h)
    data = h.record(subj)["data"]
    good = h.create("I04", {"schema_ref": sref, "subject_ref": subj, "subject_payload": data})
    assert good["status"] == "DRAFT"
    mism = h.create("I04", {"schema_ref": sref, "subject_ref": subj, "subject_payload": {"name": "Other"}})
    assert errors_of(mism)[0] == ("HASH_MISMATCH", "/payload/subject_payload")
    # derived output cannot be replaced by a caller
    assert h.dispatch("I04", "UPDATE", base_ref=ok["output_refs"][0],
                      payload={"valid": True, "violations": [], "schema_version": "x"})["status"] == "REJECTED"


# ---------------------------------------------------------------------------- I05 / I08 / I09
def missing(h, subj, path="/premise", by="B01"):
    return h.create("I05", {"subject_ref": subj, "field_path": path, "required_by": by,
                            "blocking_class": "STRUCTURAL"})


def test_i05_dedupe_and_presence(h):
    subj = a01(h)
    r1 = missing(h, subj)
    assert r1["result"]["status"] == "OPEN"
    r2 = missing(h, subj)
    assert r2["result"]["status"] == "DUPLICATE" and r2["result"]["request_id"] == r1["result"]["request_id"]
    assert r2["result"]["dedupe_key"] == r1["result"]["dedupe_key"]
    other = missing(h, subj, by="B03")
    assert other["result"]["dedupe_key"] != r1["result"]["dedupe_key"]
    present = missing(h, subj, path="/concept")
    assert errors_of(present)[0] == ("INVALID_INPUT", "/payload/field_path")


def test_i08_routes_to_owner_and_deduplicates_outbox(h):
    subj = a01(h)
    mref = missing(h, subj)["output_refs"][0]
    wrong = h.create("I08", {"missing_request_ref": mref, "target_owner": "C", "deadline": future()})
    assert errors_of(wrong)[0] == ("INVALID_INPUT", "/payload/target_owner")
    r1 = h.create("I08", {"missing_request_ref": mref, "target_owner": "A", "deadline": future()})
    r2 = h.create("I08", {"missing_request_ref": mref, "target_owner": "A", "deadline": future(60)})
    assert r1["result"]["delivery_state"] == "ROUTED" and r1["result"]["route_id"] == r2["result"]["route_id"]
    rows = h.store.query("SELECT * FROM outbox WHERE event_type='missing_info.routed'")
    assert len(rows) == 1 and json.loads(rows[0]["payload"])["owning_operation"] == "A01"
    # at-least-once replay with consumer dedupe
    got = []
    assert im.replay_outbox(h.store, "B-consumer", got.append) >= 1
    assert im.replay_outbox(h.store, "B-consumer", got.append) == 0
    assert sum(1 for e in got if e["event_type"] == "missing_info.routed") == 1


def test_i09_fallback_candidate_cannot_self_approve(h):
    subj = a01(h)
    # ACCEPT needs validated HARD inputs (Shared s9 ALL_SELECTED_INPUTS_RESOLVED_AND_VALIDATED): the evidence is checked
    assert h.validate(subj)["status"] == "VALIDATED"
    mref = missing(h, subj)["output_refs"][0]
    value = {"summary": "A drowned-lighthouse premise", "facts": [], "links": []}
    noev = h.create("I09", {"missing_request_ref": mref, "candidate_value": value, "evidence_refs": [],
                            "confidence": 0.4})
    assert errors_of(noev)[0] == ("MISSING_INPUT", "/payload/evidence_refs")
    r = h.create("I09", {"missing_request_ref": mref, "candidate_value": value, "evidence_refs": [subj],
                         "confidence": 0.4})
    assert r["status"] == "DRAFT" and r["result"]["approval_state"] == "UNAPPROVED_FALLBACK"
    cand = [x for x in r["output_refs"] if x["record_id"] == r["result"]["candidate_id"]][0]
    stored = h.record(cand)
    assert stored["record_kind"] == "FallbackCandidate" and stored["data"]["label"] == "FALLBACK_CANDIDATE"
    ref = r["output_refs"][0]
    assert h.validate(ref)["status"] == "VALIDATED"
    acc = h.accept(ref)
    assert acc["status"] == "BLOCKED" and errors_of(acc)[0][0] == "APPROVAL_REQUIRED"
    upd = h.dispatch("I09", "UPDATE", base_ref=ref, payload=dict(r["result"], approval_state="APPROVED"))
    assert errors_of(upd)[0][0] == "APPROVAL_REQUIRED"
    # an explicit I10 approval of this exact candidate lets the owner accept it
    i10 = h.create("I10", {"candidate_ref": ref, "decision": "APPROVE", "approver_id": PRINCIPAL,
                           "reason": "author reviewed", "authorization_ref": None})
    assert i10["status"] == "DRAFT", i10
    assert h.accept(ref, i10["output_refs"][0])["status"] == "APPROVED"


# ---------------------------------------------------------------------------- I06
def test_i06_search_order_cursor_and_authorization(h):
    refs = [a01(h, f"Lighthouse keeper number {i}") for i in range(5)]
    a01(h, "Unrelated baker")
    q = {"record_ids": [], "owner_operations": ["A01"], "predicates": [], "text": "LIGHTHOUSE"}
    base = {"query": q, "branch_id": "main", "limit": 2, "source_version_policy": "EXACT", "cursor": None}
    p1 = h.create("I06", base)
    assert p1["status"] == "DRAFT"
    got = list(p1["result"]["records"])
    assert p1["result"]["next_cursor"]
    # new matching record after the first page does not change the snapshot
    a01(h, "Lighthouse latecomer")
    cur = p1["result"]["next_cursor"]
    while cur:
        page = h.create("I06", dict(base, cursor=cur))
        got += page["result"]["records"]
        cur = page["result"]["next_cursor"]
    assert [r["record_id"] for r in got] == sorted(r["record_id"] for r in refs)
    assert errors_of(h.create("I06", dict(base, cursor="garbage")))[0] == ("INVALID_INPUT", "/payload/cursor")
    changed = dict(base, query=dict(q, text="baker"), cursor=p1["result"]["next_cursor"])
    assert errors_of(h.create("I06", changed))[0] == ("INVALID_INPUT", "/payload/cursor")
    # a reader without A01:read sees nothing
    with h.store.transaction() as tx:
        tx.ensure_principal("reader")
        tx.grant("reader", h.project_id, "main", "I06:create")
    r = h.dispatch("I06", "CREATE", payload=dict(base, limit=100), principal="reader")
    assert r["status"] == "DRAFT" and r["result"]["records"] == []
    # CURRENT_APPROVED only returns approved heads
    h.approve(refs[0])
    r = h.create("I06", dict(base, limit=100, source_version_policy="CURRENT_APPROVED"))
    assert [x["record_id"] for x in r["result"]["records"]] == [refs[0]["record_id"]]


# ---------------------------------------------------------------------------- I07 / I15
def test_i07_protected_first_and_budget(h):
    task = a01(h, "Write the storm chapter at the lighthouse")
    req = a01(h, "Mara never leaves the lighthouse")
    rel = a01(h, "The storm at the lighthouse lasts three days")
    irr = a01(h, "Baker sells bread")
    locked = a01(h, "The lamp is red")
    h.approve(locked)
    assert h.create("I10", {"candidate_ref": locked, "decision": "LOCK", "approver_id": PRINCIPAL, "reason": "canon",
                            "authorization_ref": None})["status"] == "DRAFT"
    locked = h.record(locked)["ref"]
    from akowe.modules.set_i import record_tokens
    need = record_tokens(h.record(req)) + record_tokens(h.record(locked))
    r = h.create("I07", {"task_ref": task, "token_budget": need + record_tokens(h.record(rel)),
                         "required_facts": [req], "retrieval_refs": [irr, rel, locked]})
    assert r["status"] == "DRAFT", r
    inc = [x["record_id"] for x in r["result"]["included"]]
    assert inc == [req["record_id"], locked["record_id"], rel["record_id"]]
    assert [x["record_id"] for x in r["result"]["omitted"]] == [irr["record_id"]]
    small = h.create("I07", {"task_ref": task, "token_budget": need - 1, "required_facts": [req],
                             "retrieval_refs": [locked]})
    assert errors_of(small)[0][0] == "CONTEXT_TOO_LARGE"
    # I15: protected values verbatim, optional compressed with citation or omitted
    pkg = r["output_refs"][0]
    c = h.create("I15", {"context_package_ref": pkg, "protected_fact_refs": [], "max_tokens": 10000,
                         "compression_policy": "OPTIONAL_DESCRIPTIONS_ONLY"})
    assert c["status"] == "DRAFT", c
    text = c["result"]["compressed_text"]
    assert "Mara never leaves the lighthouse" in text and "The lamp is red" in text
    assert f"[PROTECTED A01:{req['record_id']}@v1" in text
    tight = h.create("I15", {"context_package_ref": pkg, "protected_fact_refs": [], "max_tokens": 5,
                             "compression_policy": "OPTIONAL_DESCRIPTIONS_ONLY"})
    assert errors_of(tight)[0][0] == "CONTEXT_TOO_LARGE"


# ---------------------------------------------------------------------------- I10 / I11
def test_i10_lock_unlock_with_k09_and_self_escalation(h):
    ref = a01(h, "Mara")
    with h.store.transaction() as tx:
        tx.ensure_principal("helper")
        tx.grant("helper", h.project_id, "main", "I10:create")
    esc = h.dispatch("I10", "CREATE", principal="helper",
                     payload={"candidate_ref": ref, "decision": "APPROVE", "approver_id": "helper",
                              "reason": "self", "authorization_ref": None})
    assert errors_of(esc)[0][0] == "PERMISSION_DENIED"
    imp = h.create("I10", {"candidate_ref": ref, "decision": "APPROVE", "approver_id": "someone",
                           "reason": "x", "authorization_ref": None})
    assert errors_of(imp)[0] == ("PERMISSION_DENIED", "/payload/approver_id")
    early = h.create("I10", {"candidate_ref": ref, "decision": "LOCK", "approver_id": PRINCIPAL,
                             "reason": "x", "authorization_ref": None})
    assert errors_of(early)[0] == ("INVALID_INPUT", "/payload/decision")
    h.approve(ref)
    lock = h.create("I10", {"candidate_ref": ref, "decision": "LOCK", "approver_id": PRINCIPAL,
                            "reason": "canon", "authorization_ref": None})
    assert lock["result"]["locked_revision"] == 1 and h.record(ref)["lifecycle"] == "LOCKED"
    upd = h.dispatch("A01", "UPDATE", base_ref=ref, payload=dict(h.record(ref)["data"], concept="Mara II"))
    assert errors_of(upd)[0][0] == "LOCKED_FACT"
    unlock = h.create("I10", {"candidate_ref": ref, "decision": "UNLOCK", "approver_id": PRINCIPAL,
                              "reason": "retcon", "authorization_ref": None})
    assert errors_of(unlock)[0][0] == "APPROVAL_REQUIRED"
    k09 = h.create("K09", {"action_id": "retcon-1", "impact": {"action_hash": "h1", "source_versions": [ref],
                                                               "protected": True},
                           "policy": {"policy_id": "p", "authorized_roles": ["editor"], "ttl_seconds": 3600},
                           "base_revision": 1})["output_refs"][0]
    pend = h.create("I10", {"candidate_ref": ref, "decision": "UNLOCK", "approver_id": PRINCIPAL,
                            "reason": "retcon", "authorization_ref": k09})
    assert errors_of(pend)[0][0] == "APPROVAL_REQUIRED"
    k09v2 = h.dispatch("K09", "UPDATE", base_ref=k09, payload={"approval_id": k09["record_id"],
                                                                "decision": "APPROVED", "expiry": future(30)})
    assert k09v2["status"] == "DRAFT", k09v2
    unlock = h.create("I10", {"candidate_ref": ref, "decision": "UNLOCK", "approver_id": PRINCIPAL,
                              "reason": "retcon", "authorization_ref": k09v2["output_refs"][0]})
    assert unlock["status"] == "DRAFT", unlock
    upd = h.dispatch("A01", "UPDATE", base_ref=ref, payload=dict(h.record(ref)["data"], concept="Mara II"))
    assert upd["status"] == "DRAFT", upd
    # I11: immutable diff + audit
    hist = h.create("I11", {"entity_ref": ref, "from_revision": 1, "to_revision": 2})
    assert "v1->v2 CHANGE /concept" in hist["result"]["diff"]
    assert any(" A01 UPDATE SUCCESS " in e for e in hist["result"]["audit_events"])
    assert any(" A01 ACCEPT " in e for e in hist["result"]["audit_events"])
    assert errors_of(h.create("I11", {"entity_ref": ref, "from_revision": 1, "to_revision": 9}))[0][0] == "NOT_FOUND"


# ---------------------------------------------------------------------------- I12
def test_i12_completion_from_storage_evidence(h):
    reg = register(h)
    out = a01(h)
    r = h.create("I12", {"operation_ref": reg, "phase": "PLANNING", "requirements": [], "evidence_ref": out,
                         "evidence_type": "COMMITTED_OUTPUT"})
    assert r["status"] == "DRAFT", r
    assert r["result"]["completion_state"] == "BLOCKED"  # committed but not validated
    ev = r["result"]["evidence"]
    assert ev["output_ref"] == out and ev["receipt_id"].startswith("rcpt-") and ev["operation_id"] == "A01"
    h.approve(out)
    r = h.create("I12", {"operation_ref": reg, "phase": "PLANNING", "requirements": [], "evidence_ref": out,
                         "evidence_type": "COMMITTED_OUTPUT"})
    assert r["result"]["completion_state"] == "COMPLETE" and r["result"]["unmet_requirements"] == []
    assert h.record(r["result"]["evidence"]["audit_ref"])["record_kind"] == "AuditReport"
    assert h.validate(r["output_refs"][0])["status"] == "VALIDATED"
    # unmet requirement blocks
    req = a01(h, "pending requirement")
    b = h.create("I12", {"operation_ref": reg, "phase": "PLANNING", "requirements": [req], "evidence_ref": out,
                         "evidence_type": "COMMITTED_OUTPUT"})
    assert b["result"]["completion_state"] == "BLOCKED" and b["result"]["unmet_requirements"] == [req]
    # audited read evidence
    h.dispatch("A01", "READ", base_ref=out)
    rd = h.create("I12", {"operation_ref": reg, "phase": "PLANNING", "requirements": [], "evidence_ref": out,
                          "evidence_type": "AUDITED_READ"})
    assert rd["result"]["completion_state"] == "COMPLETE"
    assert rd["result"]["evidence"]["evidence_type"] == "AUDITED_READ"
    # wrong producer for the registration and forged updates are refused
    other = schema(h)["output_refs"][0]  # an I02 record is not the registration's A01 producer output
    wrong = h.create("I12", {"operation_ref": reg, "phase": "P", "requirements": [],
                             "evidence_ref": other, "evidence_type": "COMMITTED_OUTPUT"})
    assert errors_of(wrong)[0] == ("INVALID_INPUT", "/payload/evidence_ref/module_id")
    forged = h.dispatch("I12", "UPDATE", base_ref=b["output_refs"][0], payload=dict(b["result"],
                                                                                   completion_state="COMPLETE"))
    assert forged["status"] == "REJECTED"


def test_i12_no_receipt_no_completion(h):
    reg = register(h)
    out = a01(h)
    # simulate a worker claim: delete the commit receipt (only the audit remains)
    with h.store.transaction() as tx:
        tx.execute("DELETE FROM receipts WHERE target_operation='A01'")
    r = h.create("I12", {"operation_ref": reg, "phase": "P", "requirements": [], "evidence_ref": out,
                         "evidence_type": "COMMITTED_OUTPUT"})
    assert r["status"] == "BLOCKED" and errors_of(r)[0] == ("MISSING_INPUT", "/payload/evidence_ref")


# ---------------------------------------------------------------------------- I13 / I14
def test_i13_typed_edges_cycles_and_invalidation(h):
    a, b = a01(h, "A"), a01(h, "B")
    pred = {"paths": ["/concept"], "kind": "HARD", "stage": "CREATE"}
    e1 = h.create("I13", {"source_ref": a, "target_ref": b, "predicate": pred, "reason": "b reads a"})
    assert e1["status"] == "DRAFT" and e1["result"]["invalidated_targets"] == []
    row = h.store.query_one("SELECT * FROM dependency_edges WHERE edge_id=?", (e1["result"]["edge_id"],))
    assert json.loads(row["paths"]) == ["/concept"] and row["kind"] == "HARD" and row["producer_record_id"] == a["record_id"]
    cyc = h.create("I13", {"source_ref": b, "target_ref": a, "predicate": pred, "reason": "loop"})
    assert errors_of(cyc)[0][0] == "DEPENDENCY_CYCLE"
    # source moved on with an overlapping change -> target marked stale
    a2 = h.dispatch("A01", "UPDATE", base_ref=a, payload=dict(h.record(a)["data"], concept="A2"))["output_refs"][0]
    c = a01(h, "C")
    e2 = h.create("I13", {"source_ref": a, "target_ref": c, "predicate": pred, "reason": "c reads old a"})
    assert e2["result"]["invalidated_targets"] == [f"{c['record_id']}@1"] and h.record(c)["stale"]
    assert a2["version"] == 2


def test_i14_provenance_chain(h):
    src = a01(h, "source")
    i04_schema = schema(h)["output_refs"][0]
    v = h.create("I04", {"schema_ref": i04_schema, "subject_ref": None, "subject_payload": {"name": "x"}})
    art = v["output_refs"][0]
    prov = h.store.query_one("SELECT * FROM provenance WHERE record_id=?", (art["record_id"],))
    good = {"artifact_ref": art, "source_refs": [i04_schema],
            "transform_chain": [{"operation": "I04", "attempt_id": prov["attempt_id"], "tool_version": "1"}],
            "decision_refs": []}
    r = h.create("I14", good)
    assert r["status"] == "DRAFT", r
    assert r["result"]["provenance_id"] == prov["provenance_id"] and len(r["result"]["chain_hash"]) == 64
    bad = dict(good, transform_chain=[{"operation": "I04", "attempt_id": "attempt-forged", "tool_version": "1"}])
    assert errors_of(h.create("I14", bad))[0] == ("INVALID_INPUT", "/payload/transform_chain/0")
    assert errors_of(h.create("I14", dict(good, source_refs=[src])))[0] == ("INVALID_INPUT", "/payload/source_refs/0")


# ---------------------------------------------------------------------------- crash / duplicates
def test_crash_before_and_after_commit_keeps_state_atomic(h):
    def payload():
        return {"schema_id": "s", "semantic_version": "1.0.0", "json_schema": SCHEMA_V1,
                "compatibility_policy": "ADDITIVE"}
    req = h.request("I02", "CREATE", payload=payload())

    def boom(point):
        if point == "before_commit":
            raise CrashInjected(point)
    h.store.fault_hook = boom
    r = h.engine.dispatch(req, PRINCIPAL)
    assert r["status"] == "BLOCKED"
    h.store.fault_hook = None
    assert h.store.list_state(h.project_id, "main", "I02.registry") == {}
    assert h.store.list_records(h.project_id, "main", module_id="I02") == []

    def after(point):
        if point == "after_commit":
            raise CrashInjected(point)
    h.store.fault_hook = after
    h.engine.dispatch(req, PRINCIPAL)  # committed, then the "process" crashed before replying
    h.store.fault_hook = None
    replay = h.engine.dispatch(dict(req, request_id="req-retry"), PRINCIPAL)
    assert replay["status"] == "DRAFT"
    assert len(h.store.list_records(h.project_id, "main", module_id="I02")) == 1
    assert list(h.store.list_state(h.project_id, "main", "I02.registry")["s"]["versions"]) == ["1.0.0"]


# ---------------------------------------------------------------------------- backup / restore / migration
def test_backup_restore_verification_and_corrupt_asset(h, tmp_path):
    a01(h)
    ctx_bytes = b"%PDF-1.7 fake"
    with h.store.transaction() as tx:
        tx.insert_binary_record(project_id=h.project_id, branch_id="main", module_id="G11", record_id="G11-x",
                                version=1, data=ctx_bytes, mime_type="application/pdf", source_refs=[],
                                principal_id=PRINCIPAL)
    acl = [(PRINCIPAL, h.project_id, "main", "A01:create", True), ("stranger", h.project_id, "main", "A01:read", False)]
    restored, info = im.backup_and_restore(h.store, tmp_path / "bk", tmp_path / "restored", acl)
    assert info["counts"]["records"] == im.table_counts(restored.db_path)["records"]
    restored.close()
    # corrupt one backed-up asset: promotion is refused, original untouched
    asset = next((tmp_path / "bk" / "assets").iterdir())
    asset.write_bytes(b"tampered")
    with pytest.raises(Exception):
        Store.restore(tmp_path / "bk", tmp_path / "restored2")
    assert not (tmp_path / "restored2").exists() or not any((tmp_path / "restored2").iterdir())
    assert h.store.read_binary(h.store.get_record(h.project_id, "main", "G11-x")) == ctx_bytes


def test_retention_plan():
    now = datetime(2026, 10, 14, 12, tzinfo=timezone.utc)
    snaps = [(f"s{i}", now - timedelta(days=i)) for i in range(40)]
    keep = im.retention_plan(snaps, now)
    assert {f"s{i}" for i in range(8)} <= keep
    assert "s39" not in keep and len(keep) <= 7 + 1 + 5


def test_migration_rehearsal_isolated_and_promoted(h, tmp_path, monkeypatch):
    ref = a01(h)
    pointer = tmp_path / "ACTIVE"

    def migrate(conn):
        conn.execute("CREATE TABLE IF NOT EXISTS search_index (record_id TEXT PRIMARY KEY)")
        conn.execute("INSERT INTO search_index SELECT DISTINCT record_id FROM records")
    rep = im.rehearse_migration(h.store, tmp_path / "mig", migration_id="m-0002", from_version=1, to_version=2,
                                migrate=migrate, principal_id=PRINCIPAL, pointer_file=pointer,
                                acl_checks=[(PRINCIPAL, h.project_id, "main", "A01:create", True)])
    assert rep["problems"] == [] and rep["promoted"] is True
    assert json.loads(pointer.read_text())["data_dir"] == rep["root"]
    # original is unchanged
    assert h.store.query_one("SELECT value FROM meta WHERE key='schema_version'")["value"] == "1"
    # A Store refuses a database from a newer schema (NEW-fault-13); the Akọwe that ships migration m-0002
    # understands version 2, so open the promoted root as that version.
    import akowe.store as store_mod
    with pytest.raises(Exception):
        Store(rep["root"])
    monkeypatch.setattr(store_mod, "SCHEMA_VERSION", 2)
    new = Store(rep["root"])
    assert new.query_one("SELECT value FROM meta WHERE key='migration_id'")["value"] == "m-0002"
    assert new.get_record(h.project_id, "main", ref["record_id"])["content_hash"] == ref["content_hash"]
    new.close()
    with pytest.raises(Exception):
        im.rehearse_migration(h.store, tmp_path / "mig2", migration_id="bad", from_version=5, to_version=6,
                              migrate=migrate, principal_id=PRINCIPAL)


def test_k_runtime_clock_is_utc():
    assert kr.now().tzinfo is not None
