"""Kernel safety tests: lifecycle, CAS, idempotency, permissions, crash injection, invalidation."""
from __future__ import annotations

import pytest

from bookforge.store import CrashInjected, Store

from conftest import PRINCIPAL, errors_of


def test_structural_acceptance_cases_match(contracts):
    """Every delivered STRUCTURAL_INSTANCE case validates exactly as expected (1988 cases)."""
    bad = []
    for op in contracts.operation_ids:
        for case in contracts.cases(op):
            if case["kind"] != "STRUCTURAL_INSTANCE":
                continue
            errs = contracts.check(op, case["definition"], case["input"])
            if (not errs) != case["expected_valid"]:
                bad.append(case["id"])
            elif errs and not any(e["code"] == case["expected_code"] and e["path"] == case["expected_path"]
                                  for e in errs):
                bad.append(case["id"])
    assert bad == []


def test_lifecycle_create_validate_accept_read(h):
    r = h.create("A01", {"concept": "Mara, lighthouse keeper"})
    assert r["status"] == "DRAFT" and r["result"]["concept"] == "Mara, lighthouse keeper"
    ref = r["output_refs"][0]
    assert ref["owner"] == "A" and ref["version"] == 1
    assert h.validate(ref)["status"] == "VALIDATED"
    assert h.accept(ref)["status"] == "APPROVED"
    read = h.dispatch("A01", "READ", base_ref=ref)
    assert read["status"] == "APPROVED" and read["result"] == r["result"]


def test_accept_does_not_change_content_hash(h):
    ref, _ = h.create_approved("A01", {"concept": "Mara"})
    assert h.record(ref)["content_hash"] == ref["content_hash"]


def test_stale_update_writes_nothing(h):
    r = h.create("A01", {"concept": "Mara"})
    ref = r["output_refs"][0]
    u = h.dispatch("A01", "UPDATE", base_ref=ref, payload=dict(r["result"], concept="Mara Vell"))
    assert u["status"] == "DRAFT" and u["output_refs"][0]["version"] == 2
    stale = h.dispatch("A01", "UPDATE", base_ref=ref, payload=dict(r["result"], concept="Other"))
    assert ("VERSION_CONFLICT", "/base_ref/version") in errors_of(stale)
    assert len(h.store.history(h.project_id, "main", ref["record_id"])) == 2


def test_idempotent_replay_and_conflict(h):
    req = h.request("A01", "CREATE", payload={"concept": "x"}, idempotency_key="key-1")
    a = h.engine.dispatch(req, PRINCIPAL)
    b = h.engine.dispatch(req, PRINCIPAL)
    assert a["output_refs"] == b["output_refs"]
    assert h.store.query_one("SELECT COUNT(*) c FROM records")["c"] == 1
    assert h.store.query_one("SELECT COUNT(*) c FROM outbox WHERE event_type='record.created'")["c"] == 1
    c = h.engine.dispatch(dict(req, payload={"concept": "y"}), PRINCIPAL)
    assert errors_of(c)[0][0] == "IDEMPOTENCY_CONFLICT"


def test_permission_denied_and_principal_mismatch(h):
    ref = h.create("A01", {"concept": "x"})["output_refs"][0]
    denied = h.dispatch("A01", "READ", base_ref=ref, principal="intruder")
    assert errors_of(denied)[0][0] == "PERMISSION_DENIED"
    req = h.request("A01", "READ", base_ref=ref)
    assert errors_of(h.engine.dispatch(req, "someone-else"))[0] == ("PERMISSION_DENIED", "/principal_id")


def test_scope_required(h):
    with h.store.transaction() as tx:
        tx.ensure_principal("reader")
        tx.grant("reader", h.project_id, "main", "A01:read")
    ref = h.create("A01", {"concept": "x"})["output_refs"][0]
    assert h.dispatch("A01", "READ", base_ref=ref, principal="reader")["status"] == "DRAFT"
    w = h.dispatch("A01", "CREATE", payload={"concept": "y"}, principal="reader")
    assert errors_of(w)[0][0] == "PERMISSION_DENIED"


def test_hash_mismatch_and_foreign_pin(h):
    ref = h.create("A01", {"concept": "x"})["output_refs"][0]
    assert errors_of(h.dispatch("A01", "READ", base_ref=dict(ref, content_hash="0" * 64)))[0][0] == "HASH_MISMATCH"
    assert errors_of(h.dispatch("A01", "READ", base_ref=dict(ref, branch_id="other")))[0][0] == "INVALID_INPUT"


def test_unsupported_contract_version(h):
    req = h.request("A01", "CREATE", payload={"concept": "x"})
    req["contract_version"] = "BF-OLD"
    assert errors_of(h.engine.dispatch(req, PRINCIPAL))[0][0] == "UNSUPPORTED_CONTRACT"


def test_crash_before_commit_leaves_old_head(h):
    h.store.fault_hook = lambda p: (_ for _ in ()).throw(CrashInjected(p)) if p == "before_commit" else None
    r = h.create("A01", {"concept": "x"})
    h.store.fault_hook = None
    assert r["errors"] and r["output_refs"] == []
    for t in ("records", "heads", "audit", "receipts", "provenance"):
        assert h.store.query_one(f"SELECT COUNT(*) c FROM {t}")["c"] == 0, t
    assert h.store.query_one("SELECT COUNT(*) c FROM outbox WHERE event_type!='project.created'")["c"] == 0


def test_crash_after_commit_replays_receipt(h):
    req = h.request("A01", "CREATE", payload={"concept": "x"}, idempotency_key="crash-key")
    h.store.fault_hook = lambda p: (_ for _ in ()).throw(CrashInjected(p)) if p == "after_commit" else None
    first = h.engine.dispatch(req, PRINCIPAL)
    h.store.fault_hook = None
    assert first["errors"]  # caller saw a failure...
    again = h.engine.dispatch(req, PRINCIPAL)  # ...but the commit is durable; retry returns it
    assert again["status"] == "DRAFT"
    assert h.store.query_one("SELECT COUNT(*) c FROM records")["c"] == 1


def test_not_applicable_feature(h):
    plot = {"main_plot": {"summary": "x", "facts": [], "links": []}, "objectives": [], "plot_obligations": []}
    # B08 requires mystery=true; with a valid B03 pin it returns NOT_APPLICABLE when disabled.
    b01 = h.dispatch("B01", "CREATE", payload={"idea": "i", "goals": ["g"]},
                     manual_candidate={"premise": "p", "dramatic_question": "q?", "concept_summary": "s"})
    p_ref = b01["output_refs"][0]
    h.approve(p_ref)
    b03 = h.dispatch("B03", "CREATE", payload={"premise_ref": p_ref, "canon_refs": [], "constraints": []},
                     manual_candidate=plot)
    assert b03["status"] == "DRAFT", b03
    r = h.create("B08", {"main_plot_ref": b03["output_refs"][0], "feature_selected": True})
    assert r["status"] == "NOT_APPLICABLE" and r["selection_rule_id"] == "FEATURE_TRUE:mystery"


def test_invalidation_marks_consumer_stale(h):
    a_ref, a = h.create_approved("A01", {"concept": "Mara"})
    b = h.create("A02", {"concept": "Selkies", "linked_refs": [a_ref]})
    b_ref = b["output_refs"][0]
    u = h.dispatch("A01", "UPDATE", base_ref=a_ref, payload=dict(a["result"], concept="Mara Vell"))
    new = u["output_refs"][0]
    assert h.approve(new)["status"] == "APPROVED"
    rec = h.record(b_ref)
    assert rec["stale"] is True
    v = h.validate(b_ref)
    assert v["status"] == "DRAFT" and any(f["rule_id"] == "STALE" for f in v["findings"])
    assert h.record(a_ref)["lifecycle"] == "SUPERSEDED"


def test_backup_restore_and_corruption(h, tmp_path):
    h.create("A01", {"concept": "x"})
    dest = tmp_path / "bk"
    h.store.backup(dest)
    assert Store.verify_backup(dest) == []
    restored = Store.restore(dest, tmp_path / "restored")
    assert restored.query_one("SELECT COUNT(*) c FROM records")["c"] == 1
    db = dest / "bookforge.sqlite3"
    db.write_bytes(db.read_bytes() + b"x")
    assert Store.verify_backup(dest)


def test_locked_record_requires_protected_change(h):
    ref, r = h.create_approved("A01", {"concept": "Mara"})
    with h.store.transaction() as tx:
        tx.set_lifecycle(ref, "LOCKED")
    u = h.dispatch("A01", "UPDATE", base_ref=ref, payload=dict(r["result"], concept="changed"))
    assert errors_of(u)[0][0] == "LOCKED_FACT"
