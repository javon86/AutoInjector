"""Set I handlers: Brain / Storage / Context (I01-I15)."""
from __future__ import annotations

import re

from ..errors import BookforgeError
from . import register
from .base import Context, OperationHandler, Result

HEX64 = re.compile(r"^[a-f0-9]{64}$")


@register("I01")
class CanonDatabase(OperationHandler):
    """I01 - Canon Database: custodial canon registry and typed AUXILIARY profile imports.

    AUXILIARY: first import has source_ref=null and binds import_evidence (label, sha256 of the
    exact source bytes, authenticated importer, UTC time); later revisions pin the prior I01
    record. Non-AUXILIARY writes need a resolved source_ref owned by owner_operation. DRAFT
    permits approval_ref=null; APPROVED requires a valid approval (I10/K09). The caller
    cannot select an owner it is not authorized to write for.
    """

    def create(self, ctx: Context) -> Result:
        p = ctx.payload
        owner_op = p["owner_operation"]
        if not ctx.store.has_scope(ctx.principal_id, ctx.project_id, ctx.branch_id, f"{owner_op}:create"):
            raise BookforgeError("PERMISSION_DENIED", "/payload/owner_operation",
                                 f"not authorized to write canon for {owner_op}", status="REJECTED")
        if p["fact_type"] == "AUXILIARY":
            return self._auxiliary(ctx)
        src = ctx.field_record("source_ref")
        if src is None:
            raise BookforgeError("MISSING_INPUT", "/payload/source_ref", "source_ref is required for canon facts")
        if src["module_id"] != owner_op:
            raise BookforgeError("INVALID_INPUT", "/payload/source_ref/module_id",
                                 f"source must be a {owner_op} record (owner_operation)", status="REJECTED")
        for i, fact in enumerate(p["fact_payload"]["facts"]):
            frm, to = fact["effective_from"], fact["effective_to"]
            if frm is not None and to is not None and to <= frm:
                raise BookforgeError("INVALID_INPUT", f"/payload/fact_payload/facts/{i}/effective_to",
                                     "effective interval must satisfy to > from", status="REJECTED")
        state = self._approval_state(ctx)
        record_id = ctx.allocate_record_id()
        return Result(data={"canon_id": record_id, "revision": 1, "approval_state": state}, record_id=record_id)

    def _auxiliary(self, ctx: Context) -> Result:
        p = ctx.payload
        aux = p["auxiliary_record"]
        errs = ctx.contracts.check_shared(aux["record_kind"], aux["data"])
        if errs:
            raise BookforgeError(errs[0]["code"], "/payload/auxiliary_record/data" + errs[0]["path"],
                                 errs[0]["message"], status="REJECTED")
        src = ctx.field_record("source_ref")
        if src is None:
            ev = p.get("import_evidence")
            if not ev:
                raise BookforgeError("MISSING_INPUT", "/payload/import_evidence",
                                     "first AUXILIARY import needs import_evidence")
            if ev["principal_id"] != ctx.principal_id:
                raise BookforgeError("PERMISSION_DENIED", "/payload/import_evidence/principal_id",
                                     "import evidence must name the authenticated importer", status="REJECTED")
            if not HEX64.match(ev["source_sha256"]):
                raise BookforgeError("INVALID_INPUT", "/payload/import_evidence/source_sha256",
                                     "source_sha256 must be the SHA-256 of the imported bytes", status="REJECTED")
        else:
            if src["module_id"] != "I01":
                raise BookforgeError("INVALID_INPUT", "/payload/source_ref/module_id",
                                     "a later auxiliary revision pins its prior I01 record", status="REJECTED")
            prior = (src.get("data") or {}).get("auxiliary_record") or {}
            if prior.get("record_kind") != aux["record_kind"]:
                raise BookforgeError("INVALID_INPUT", "/payload/auxiliary_record/record_kind",
                                     "auxiliary kinds are incompatible across revisions", status="REJECTED")
        state = self._approval_state(ctx)
        record_id = ctx.allocate_record_id()
        return Result(data={"canon_id": record_id, "revision": 1, "approval_state": state,
                            "auxiliary_record": aux}, record_id=record_id)

    def _approval_state(self, ctx: Context) -> str:
        if ctx.payload["requested_state"] == "DRAFT":
            return "DRAFT"
        appr = ctx.field_record("approval_ref")
        if appr is None:
            raise BookforgeError("APPROVAL_REQUIRED", "/payload/approval_ref",
                                 "APPROVED canon requires a valid I10/K09 approval", status="BLOCKED")
        if appr["module_id"] not in ("I10", "K09"):
            raise BookforgeError("INVALID_INPUT", "/payload/approval_ref/module_id",
                                 "approval_ref must be an I10 or K09 decision", status="REJECTED")
        data = appr.get("data") or {}
        decision = data.get("decision") if appr["module_id"] == "K09" else (data.get("approval") or {}).get("decision")
        if decision != "APPROVED":
            raise BookforgeError("APPROVAL_REQUIRED", "/payload/approval_ref", f"approval decision is {decision}")
        return "APPROVED"

    def update(self, ctx: Context) -> Result:
        base = ctx.base
        data = dict(ctx.payload)
        if data.get("canon_id") != base["data"]["canon_id"]:
            raise BookforgeError("INVALID_INPUT", "/payload/canon_id", "canon_id is the stable record ID",
                                 status="REJECTED")
        if data.get("revision") != base["version"] + 1:
            raise BookforgeError("INVALID_INPUT", "/payload/revision", "revision must equal the new version",
                                 status="REJECTED")
        old_aux = base["data"].get("auxiliary_record")
        new_aux = data.get("auxiliary_record")
        if (old_aux is None) != (new_aux is None) or (old_aux and old_aux["record_kind"] != new_aux["record_kind"]):
            raise BookforgeError("INVALID_INPUT", "/payload/auxiliary_record",
                                 "auxiliary record kind cannot change", status="REJECTED")
        if new_aux:
            errs = ctx.contracts.check_shared(new_aux["record_kind"], new_aux["data"])
            if errs:
                raise BookforgeError(errs[0]["code"], "/payload/auxiliary_record/data" + errs[0]["path"],
                                     errs[0]["message"], status="REJECTED")
        return Result(data=data, transform="MANUAL")

    def validate(self, ctx: Context, record: dict) -> list[dict]:
        out = []
        data = record["data"]
        if data["canon_id"] != record["record_id"]:
            out.append(ctx.finding("CANON_ID", "canon_id must equal the stored record ID", severity="BLOCKING"))
        if data["revision"] != record["version"]:
            out.append(ctx.finding("REVISION", "revision must equal the stored version", severity="BLOCKING"))
        aux = data.get("auxiliary_record")
        if aux:
            for e in ctx.contracts.check_shared(aux["record_kind"], aux["data"]):
                out.append(ctx.finding("AUX_SCHEMA", f"{e['path']}: {e['message']}", severity="BLOCKING"))
        return out
