"""Test fixtures shared by test_set_f.py / test_set_j.py.

Producer records owned by other sets (C prose, A canon, K09 approvals) are seeded straight
through the storage kernel with evidence_origin=FIXTURE so these tests do not depend on the
other modules' handlers (implemented concurrently). Every seeded record still satisfies its
producer OUTPUT schema, so the kernel resolves it exactly like a real record.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from akowe.store import new_id


def seed(h, module_id, data, *, source_refs=None, lifecycle="APPROVED", record=None):
    """Insert a record (new, or next version of `record`) and optionally approve it."""
    errs = h.engine.contracts.check(module_id, "OUTPUT", data)
    assert not errs, errs
    if record is None:
        record_id, version, expected = f"{module_id}-fx-{uuid.uuid4().hex[:10]}", 1, None
    else:
        record_id, version, expected = record["record_id"], record["latest_version"] + 1, record["latest_version"]
    with h.store.transaction() as tx:
        ref = tx.insert_json_record(project_id=h.project_id, branch_id=h.branch_id, module_id=module_id,
                                    record_id=record_id, version=version, data=data,
                                    source_refs=list(source_refs or []), principal_id=h.principal,
                                    evidence_origin="FIXTURE", expected_latest=expected)
        if lifecycle in ("APPROVED", "LOCKED"):
            tx.set_lifecycle(ref, lifecycle, approval_id=new_id("appr-fx"))
            tx.set_approved_head(ref)
        elif lifecycle != "DRAFT":
            tx.set_lifecycle(ref, lifecycle)
    return ref


def prose(h, text, module_id="C07", **kw):
    return seed(h, module_id, {"text": text, "candidate_events": [], "findings": []}, **kw)


def fact(subject, predicate, value, frm=None, to=None, kind="FACT"):
    return {"subject_id": subject, "predicate": predicate, "value": value, "assertion_type": kind,
            "effective_from": frm, "effective_to": to, "source_refs": []}


def canon(h, module_id="A01", facts=(), flags=(), concept="canon", **kw):
    data = {"concept": concept, "attributes": {}, "linked_refs": [], "protected_fact_flags": list(flags),
            "facts": list(facts)}
    return seed(h, module_id, data, **kw)


def iso(delta_seconds):
    return (datetime.now(timezone.utc) + timedelta(seconds=delta_seconds)).strftime("%Y-%m-%dT%H:%M:%SZ")


def k09(h, subjects, *, decision="APPROVED", expires_in=3600):
    data = {"approval_id": new_id("k09"), "decision": decision,
            "expiry": iso(expires_in) if decision == "APPROVED" or expires_in is not None else None}
    return seed(h, "K09", data, source_refs=subjects)


def rec(h, ref, version=None):
    return h.store.get_record(h.project_id, h.branch_id, ref["record_id"], version or ref["version"])


class FakeAI:
    """Fake provider adapter: returns canned JSON per operation (keyed by 'Operation Xnn')."""

    def __init__(self, by_op):
        self.by_op = by_op
        self.calls = []

    def submit(self, slot, system, user, schema):
        self.calls.append((system, user))
        for op, out in self.by_op.items():
            if f"Operation {op}" in system:
                return out, {"input_tokens": 10, "output_tokens": 10, "model": "fake"}
        raise AssertionError("unexpected AI call")


def use_ai(h, by_op):
    fake = FakeAI(by_op)
    h.engine.providers.test_adapter = fake
    h.engine.providers.configure_slot("AI-1", {"adapter_id": "anthropic"})
    return fake
