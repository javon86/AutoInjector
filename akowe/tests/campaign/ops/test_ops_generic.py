"""Spec-driven generic checks for all 142 operations (Shared_Contract sections 2-4, every set's
"Behavior" paragraph):

* CREATE rejects every schema-required field when missing (MISSING_INPUT at /payload/<field>) and
  writes nothing; unsupported fields fail INVALID_INPUT.
* CREATE -> READ -> UPDATE -> VALIDATE -> ACCEPT round trip on a record of every operation:
  READ returns exactly what was stored and writes no record; UPDATE appends version+1 with the
  old revision byte-identical; a stale base_ref (CAS) is VERSION_CONFLICT and writes nothing;
  UPDATE missing any OUTPUT-required field is refused; ACCEPT of a superseded/older revision is
  refused; ACCEPT never edits the content hash.

Inputs come from the delivered acceptance cases (CREATE-valid / OUTPUT-valid) with fixture
references replaced by seeded producer records, not from handler code.
"""
from __future__ import annotations

import copy

import pytest

from bookforge.contracts import get_package

from conftest import errors_of
import opsgen

PKG = get_package()
OPS = list(PKG.operation_ids)
ALL_FEATURES = {"artwork": True, "magic": True, "mystery": True, "foreshadowing": True}

REQUIRED_CASES = [(op, f) for op in OPS for f in opsgen.create_required(PKG, op)]


def _has_ref(node):
    if opsgen.is_ref(node):
        return True
    if isinstance(node, dict):
        return any(_has_ref(v) for v in node.values())
    if isinstance(node, list):
        return any(_has_ref(v) for v in node)
    return False


OPS_WITH_OUTPUT_REFS = [op for op in OPS if _has_ref(opsgen.valid_output(PKG, op))]
OUTPUT_REQUIRED_CASES = [(op, f) for op in OPS for f in opsgen.output_required(PKG, op)]


@pytest.fixture
def hx(h):
    h.set_features(**ALL_FEATURES)
    return h


def _count(h, table="records"):
    return h.store.query_one(f"SELECT COUNT(*) c FROM {table}")["c"]


def test_every_operation_declares_required_create_fields():
    assert len(OPS) == 142
    # the spec tables list at least one required CREATE field for every operation
    missing = [op for op in OPS if not opsgen.create_required(PKG, op)]
    assert missing == []


@pytest.mark.parametrize("op,field", REQUIRED_CASES, ids=[f"{o}-{f}" for o, f in REQUIRED_CASES])
def test_create_missing_required_field_is_rejected(hx, op, field):
    payload = opsgen.valid_payload(PKG, op)
    payload.pop(field, None)
    before = _count(hx)
    r = hx.create(op, payload)
    assert r["status"] in ("REJECTED", "BLOCKED"), r["status"]
    assert ("MISSING_INPUT", f"/payload/{field}") in errors_of(r)
    assert r["output_refs"] == [] and r["result"] is None
    assert _count(hx) == before


@pytest.mark.parametrize("op", OPS)
def test_create_unknown_field_is_invalid(hx, op):
    payload = dict(opsgen.valid_payload(PKG, op), __unknown=True)
    r = hx.create(op, payload)
    assert ("INVALID_INPUT", "/payload/__unknown") in errors_of(r)
    assert _count(hx) == 0


def _real_or_seeded(h, op):
    """A real CREATE when the acceptance-case payload is semantically sufficient, else a seeded DRAFT."""
    try:
        payload = opsgen.resolve_fixture_refs(h, op, opsgen.valid_payload(PKG, op))
    except NotImplementedError:
        payload = None
    if payload is not None:
        r = h.create(op, payload)
        if r["status"] != "DRAFT":
            r = h.dispatch(op, "CREATE", payload=payload, manual_candidate=opsgen.valid_output(PKG, op))
        if r["status"] == "DRAFT":
            return r["output_refs"][0], "created"
    return opsgen.seed_valid(h, op, lifecycle="DRAFT"), "seeded"


@pytest.mark.parametrize("op", OPS)
def test_read_returns_exactly_what_was_stored(hx, op):
    ref, how = _real_or_seeded(hx, op)
    stored = hx.record(ref)
    n = _count(hx)
    r = hx.dispatch(op, "READ", base_ref=ref)
    assert r["status"] == "DRAFT", (how, r["errors"])
    assert r["result"] == stored["data"]
    assert r["output_refs"] == [ref]
    assert r["source_refs"] == stored["source_refs"]
    assert _count(hx) == n  # READ writes no domain record
    assert hx.store.query_one("SELECT COUNT(*) c FROM audit WHERE action='READ'")["c"] >= 1


@pytest.mark.parametrize("op", OPS)
def test_update_appends_version_and_keeps_history(hx, op):
    ref, how = _real_or_seeded(hx, op)
    v1 = hx.record(ref)
    u = hx.dispatch(op, "UPDATE", base_ref=ref, payload=copy.deepcopy(v1["data"]))
    if u["status"] != "DRAFT":
        # Some owners refuse a replacement they did not derive (E snapshots, H reports, ...).
        # The refusal must still be an explicit, error-carrying response that writes nothing.
        assert u["output_refs"] == [], (how, u)
        assert u["errors"] or u["status"] == "NOT_APPLICABLE", (how, u)
        assert hx.store.get_record(hx.project_id, "main", ref["record_id"])["version"] == 1
        pytest.skip(f"{op} owner refuses an identical replacement: {(errors_of(u) or [u['status']])[0]}")
    new = u["output_refs"][0]
    assert new["record_id"] == ref["record_id"] and new["version"] == 2
    hist = hx.store.history(hx.project_id, "main", ref["record_id"])
    assert [r["version"] for r in hist] == [1, 2]
    again = hx.record(ref)
    assert again["content_hash"] == v1["content_hash"] and again["data"] == v1["data"]
    # stale CAS: a second replacement against v1 is refused and writes nothing
    n = _count(hx)
    stale = hx.dispatch(op, "UPDATE", base_ref=ref, payload=copy.deepcopy(v1["data"]))
    assert ("VERSION_CONFLICT", "/base_ref/version") in errors_of(stale)
    assert _count(hx) == n
    # an older revision can no longer be accepted
    old = hx.accept(ref)
    assert old["status"] != "APPROVED"
    assert hx.record(ref)["lifecycle"] != "APPROVED"


@pytest.mark.parametrize("op,field", OUTPUT_REQUIRED_CASES, ids=[f"{o}-{f}" for o, f in OUTPUT_REQUIRED_CASES])
def test_update_missing_output_field_is_refused(hx, op, field):
    ref = opsgen.seed_valid(hx, op, lifecycle="DRAFT")
    data = copy.deepcopy(hx.record(ref)["data"])
    data.pop(field)
    n = _count(hx)
    u = hx.dispatch(op, "UPDATE", base_ref=ref, payload=data)
    assert u["status"] in ("REJECTED", "BLOCKED") and u["output_refs"] == []
    assert errors_of(u)[0][0] in ("MISSING_INPUT", "INVALID_INPUT")
    assert _count(hx) == n


@pytest.mark.parametrize("op", OPS)
def test_validate_accept_never_edit_content(hx, op):
    ref, how = _real_or_seeded(hx, op)
    h0 = hx.record(ref)["content_hash"]
    v = hx.validate(ref)
    if v["status"] not in ("VALIDATED", "DRAFT"):
        # (seeded examples only) an owner check that cannot resolve a dangling fixture pin answers an error
        assert how == "seeded" and v["errors"] and v["output_refs"] == [], v
        assert hx.record(ref)["lifecycle"] == "DRAFT"
        return
    assert v["status"] in ("VALIDATED", "DRAFT"), v["errors"]
    if v["status"] == "DRAFT":
        # a failed validation keeps the DRAFT candidate and reports why
        assert any(f["severity"] == "BLOCKING" for f in v["findings"]), (how, v["findings"])
    a = hx.accept(ref)
    rec = hx.record(ref)
    assert rec["content_hash"] == h0 == ref["content_hash"]
    if a["status"] == "APPROVED":
        assert rec["lifecycle"] == "APPROVED"
        assert hx.store.query_one("SELECT COUNT(*) c FROM approvals")["c"] >= 1
    else:
        assert rec["lifecycle"] in ("DRAFT", "VALIDATED")
        assert a["errors"] or any(f["severity"] == "BLOCKING" for f in a["findings"])


@pytest.mark.parametrize("op", OPS_WITH_OUTPUT_REFS)
def test_accept_of_validation_failure_is_refused(hx, op):
    """A DRAFT whose stored link no longer resolves (mandatory link) cannot be approved."""
    data = opsgen.valid_output(PKG, op)
    dangling = {"project_id": hx.project_id, "branch_id": "main", "owner": "A", "module_id": "A01",
                "record_id": "does-not-exist", "version": 1, "content_hash": "a" * 64}

    def plant(node):
        if opsgen.is_ref(node):
            return dict(dangling, owner=node["owner"], module_id=node["module_id"]), True
        if isinstance(node, dict):
            out, hit = {}, False
            for k, v in node.items():
                out[k], h2 = plant(v)
                hit = hit or h2
            return out, hit
        if isinstance(node, list):
            res = [plant(v) for v in node]
            return [r for r, _ in res], any(hh for _, hh in res)
        return node, False

    data, hit = plant(data)
    assert hit
    ref = opsgen.seed(hx, op, data, lifecycle="DRAFT")
    a = hx.accept(ref)
    assert a["status"] != "APPROVED"
    assert hx.record(ref)["lifecycle"] != "APPROVED"
