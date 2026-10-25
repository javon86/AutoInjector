"""I01 canon database / AUXILIARY profile import tests (kernel-owned bootstrap path)."""
import hashlib

from conftest import PRINCIPAL, errors_of


def import_profile(h, kind, data, label="author-supplied profile"):
    payload = {
        "owner_operation": "I01", "source_ref": None, "approval_ref": None, "fact_type": "AUXILIARY",
        "fact_payload": {"summary": label, "facts": [], "links": []}, "requested_state": "DRAFT",
        "auxiliary_record": {"record_kind": kind, "data": data},
        "import_evidence": {"source_label": label, "source_sha256": hashlib.sha256(repr(data).encode()).hexdigest(),
                            "principal_id": PRINCIPAL, "imported_at": "2026-10-12T09:00:00Z"},
    }
    return h.create("I01", payload)


def test_auxiliary_import_and_canon_id(h):
    r = import_profile(h, "PAGE_PROFILE", {"width_mm": 152.4, "height_mm": 228.6, "bleed_mm": 0, "safe_margin_mm": 15})
    assert r["status"] == "DRAFT", r
    ref = r["output_refs"][0]
    assert r["result"]["canon_id"] == ref["record_id"] and r["result"]["revision"] == 1
    assert h.approve(ref)["status"] == "APPROVED"


def test_auxiliary_requires_evidence_principal(h):
    r = import_profile(h, "PAPER_STOCK", {"stock_id": "p80", "caliper_mm": 0.1})
    assert r["status"] == "DRAFT", r
    payload = {
        "owner_operation": "I01", "source_ref": None, "approval_ref": None, "fact_type": "AUXILIARY",
        "fact_payload": {"summary": "x", "facts": [], "links": []}, "requested_state": "DRAFT",
        "auxiliary_record": {"record_kind": "PAPER_STOCK", "data": {"stock_id": "p80", "caliper_mm": 0.1}},
        "import_evidence": {"source_label": "x", "source_sha256": "a" * 64, "principal_id": "someone-else",
                            "imported_at": "2026-10-12T09:00:00Z"}}
    assert errors_of(h.create("I01", payload))[0][0] == "PERMISSION_DENIED"


def test_approved_requires_approval(h):
    a = h.create("A01", {"concept": "Mara"})["output_refs"][0]
    payload = {"owner_operation": "A01", "source_ref": a, "approval_ref": None, "fact_type": "CHARACTER",
               "fact_payload": {"summary": "Mara", "facts": [], "links": []}, "requested_state": "APPROVED"}
    assert errors_of(h.create("I01", payload))[0][0] == "APPROVAL_REQUIRED"
    payload["requested_state"] = "DRAFT"
    assert h.create("I01", payload)["result"]["approval_state"] == "DRAFT"


def test_wrong_owner_source_rejected(h):
    a = h.create("A01", {"concept": "Mara"})["output_refs"][0]
    payload = {"owner_operation": "A02", "source_ref": a, "approval_ref": None, "fact_type": "SPECIES",
               "fact_payload": {"summary": "x", "facts": [], "links": []}, "requested_state": "DRAFT"}
    assert errors_of(h.create("I01", payload))[0] == ("INVALID_INPUT", "/payload/source_ref/module_id")
