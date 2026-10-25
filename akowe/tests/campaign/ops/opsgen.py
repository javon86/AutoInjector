"""Generic per-operation input builders for the spec-driven ops campaign.

Everything here is derived from the delivered contract package (schemas, acceptance cases,
interface_registry bindings), not from the handler code, so the round-trip tests check the
operations against their specifications.
"""
from __future__ import annotations

import copy
import uuid

from akowe.store import new_id

FIXTURE_ID = "fixture-record"


def case(contracts, op, case_suffix):
    for c in contracts.cases(op):
        if c["id"] == f"{op}-{case_suffix}":
            return copy.deepcopy(c)
    raise KeyError(f"{op}-{case_suffix}")


def valid_payload(contracts, op, definition="CREATE"):
    return case(contracts, op, f"{definition}-valid")["input"]["payload"]


def valid_output(contracts, op):
    return case(contracts, op, "OUTPUT-valid")["input"]


def create_required(contracts, op):
    d = contracts.definition(op, "CREATE")
    payload = d.get("properties", {}).get("payload", {})
    payload = _deref(contracts, op, payload)
    return list(payload.get("required", []))


def output_required(contracts, op):
    d = _deref(contracts, op, contracts.definition(op, "OUTPUT"))
    return list(d.get("required", []))


def _deref(contracts, op, node):
    seen = 0
    while isinstance(node, dict) and "$ref" in node and seen < 10:
        ref = node["$ref"]
        if ref.startswith("#/$defs/"):
            node = contracts.schema(op)["$defs"][ref[len("#/$defs/"):]]
        else:
            break
        seen += 1
    return node


def is_ref(v):
    return isinstance(v, dict) and {"record_id", "content_hash", "module_id", "owner"} <= set(v)


def seed(h, module_id, data, *, source_refs=None, lifecycle="APPROVED", record=None, record_kind="OUTPUT"):
    """Insert a producer record through the storage kernel (evidence_origin=FIXTURE)."""
    if record_kind == "OUTPUT":
        errs = h.engine.contracts.check(module_id, "OUTPUT", data)
        assert not errs, (module_id, errs)
    if record is None:
        record_id, version, expected = f"{module_id}-fx-{uuid.uuid4().hex[:10]}", 1, None
    else:
        record_id, version, expected = record["record_id"], record["latest_version"] + 1, record["latest_version"]
    with h.store.transaction() as tx:
        ref = tx.insert_json_record(project_id=h.project_id, branch_id=h.branch_id, module_id=module_id,
                                    record_id=record_id, version=version, data=data,
                                    source_refs=list(source_refs or []), principal_id=h.principal,
                                    evidence_origin="FIXTURE", expected_latest=expected, record_kind=record_kind)
        if lifecycle in ("APPROVED", "LOCKED"):
            tx.set_lifecycle(ref, lifecycle, approval_id=new_id("appr-fx"))
            tx.set_approved_head(ref)
        elif lifecycle != "DRAFT":
            tx.set_lifecycle(ref, lifecycle)
    return ref


def localize(h, node):
    """Re-pin acceptance-case fixture references (project p1) into the test project (they stay dangling)."""
    if is_ref(node):
        return dict(node, project_id=h.project_id, branch_id=h.branch_id)
    if isinstance(node, dict):
        return {k: localize(h, v) for k, v in node.items()}
    if isinstance(node, list):
        return [localize(h, v) for v in node]
    return node


def seed_valid(h, module_id, lifecycle="APPROVED"):
    return seed(h, module_id, localize(h, valid_output(h.engine.contracts, module_id)), lifecycle=lifecycle)


def resolve_fixture_refs(h, op, payload):
    """Replace every fixture Reference in an acceptance-case payload with a seeded APPROVED record of
    the producer the case names (falling back to the first allowed producer of the binding)."""
    contracts = h.engine.contracts
    bindings = {b["input_path"]: b for b in contracts.bindings(op)}
    cache = {}

    def walk(node, path):
        if is_ref(node):
            tmpl = "/".join(p for p in path.split("/") if not p.isdigit())
            b = bindings.get(tmpl)
            mod = node["module_id"]
            if b and mod not in b["allowed_producers"]:
                mod = b["allowed_producers"][0]
            if b and b.get("required_record_kind"):
                raise NotImplementedError(f"{op}{path} needs an imported {b['required_record_kind']} profile")
            if mod not in cache:
                cache[mod] = seed_valid(h, mod)
            return cache[mod]
        if isinstance(node, dict):
            return {k: walk(v, f"{path}/{k}") for k, v in node.items()}
        if isinstance(node, list):
            return [walk(v, f"{path}/{i}") for i, v in enumerate(node)]
        return node

    return walk(payload, "/payload")
