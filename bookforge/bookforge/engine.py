"""Bootstrap kernel dispatch for all 142 operations (Shared Contract sections 2-6, 8-10).

Order of checks for every request:
 1. contract_version and envelope/payload schema (#/$defs/<ACTION>) -> MISSING/INVALID_INPUT
 2. operation exists and supports the action                     -> NOT_FOUND / INVALID_INPUT
 3. authenticated principal matches body, project/branch access, OP:action scope
 4. deadline not already passed                                   -> TIMEOUT
 5. idempotency receipt (identical replay / IDEMPOTENCY_CONFLICT)
 6. feature applicability from the pinned manifest                 -> NOT_APPLICABLE
 7. resolve every canonical Reference (pin, owner, hash, producer binding, OUTPUT)
 8. action semantics via the operation handler
 9. one atomic commit: record(s), heads, lifecycle, provenance, audit, edges, outbox, receipt
"""
from __future__ import annotations

import copy
import json
import logging
import sqlite3
import threading
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from . import CONTRACT_VERSION
from .canonical import (canonical_bytes, changed_pointers, iter_references, json_pointer, make_reference,
                        pointers_overlap, sha256_bytes, sha256_json)
from .contracts import ACTIONS, ContractPackage, get_package
from .errors import BookforgeError, error
from .modules import get_handler
from .modules.base import Context, Result
from .store import Store, new_id, utcnow

log = logging.getLogger("bookforge.engine")

STATUS_FROM_LIFECYCLE = {"DRAFT": "DRAFT", "VALIDATED": "VALIDATED", "APPROVED": "APPROVED",
                         "LOCKED": "APPROVED", "SUPERSEDED": "APPROVED", "REJECTED": "REJECTED"}

# Kernel-level feature predicates (Shared Contract section 6). Modules may add more.
FEATURE_RULES = {
    "B08": ("FEATURE_TRUE:mystery", "mystery"),
    "B09": ("FEATURE_TRUE:foreshadowing", "foreshadowing"),
    "E08": ("FEATURE_TRUE:magic", "magic"),
}

# Record kinds stored with a shared schema instead of the producer OUTPUT definition.
SHARED_KIND_SCHEMAS = {"CEventBundle": "CEventBundle", "MapGraph": "MapGraph", "MapSidecar": "MapSidecar"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _ptr_template(ptr: str) -> str:
    """'/payload/linked_refs/3' -> '/payload/linked_refs' (drop list indices for binding lookup)."""
    return "/".join(p for p in ptr.split("/") if not p.isdigit())


class Engine:
    def __init__(self, store: Store, contracts: ContractPackage | None = None, providers=None):
        self.store = store
        self.contracts = contracts or get_package()
        if providers is None:
            from .providers import ProviderRegistry
            providers = ProviderRegistry(store)
        self.providers = providers
        self._lock = threading.RLock()

    # ================================================================== public API
    def dispatch(self, request: Any, principal_id: str, *, manual_candidate: dict | None = None,
                 evidence_origin: str = "AUTHORITATIVE") -> dict:
        """Execute one wire request for an authenticated principal and return a RESPONSE."""
        request_id = request.get("request_id") if isinstance(request, dict) and isinstance(
            request.get("request_id"), str) and request.get("request_id") else "unknown-request"
        attempt_id = new_id("attempt")
        try:
            return self._dispatch(request, principal_id, attempt_id, manual_candidate, evidence_origin)
        except BookforgeError as exc:
            return self._error_response(request_id, attempt_id, exc.errors, exc.status, exc.findings,
                                        exc.unresolved)
        except sqlite3.OperationalError as exc:
            log.exception("storage unavailable")
            return self._error_response(request_id, attempt_id,
                                        [error("UPSTREAM_UNAVAILABLE", "", f"storage unavailable: {exc}")],
                                        "BLOCKED")
        except Exception as exc:  # noqa: BLE001 - classified as nonretryable INTERNAL_ERROR
            log.exception("internal error in dispatch")
            return self._error_response(request_id, attempt_id,
                                        [error("INTERNAL_ERROR", "", f"{type(exc).__name__}: {exc}")], "BLOCKED")

    # ================================================================== pipeline
    def _dispatch(self, request, principal_id, attempt_id, manual_candidate, evidence_origin) -> dict:
        if not isinstance(request, dict):
            raise BookforgeError("INVALID_INPUT", "", "request must be a JSON object", status="REJECTED")
        if "contract_version" in request and request["contract_version"] != CONTRACT_VERSION:
            raise BookforgeError("UNSUPPORTED_CONTRACT", "/contract_version",
                                 f"only {CONTRACT_VERSION} is accepted", status="REJECTED")
        op_id = request.get("target_operation")
        op = self.contracts.operation(op_id) if isinstance(op_id, str) else None
        if op is None:
            raise BookforgeError("NOT_FOUND", "/target_operation", "unknown operation", status="REJECTED")
        action = request.get("action")
        if action not in op["modes"]:
            raise BookforgeError("INVALID_INPUT", "/action", f"{op_id} does not support action {action!r}",
                                 status="REJECTED")
        errs = self.contracts.check(op_id, action, request)
        if errs:
            early = self._early_not_applicable(request, op, action, principal_id, attempt_id, errs)
            if early is not None:
                return early
            raise BookforgeError(errs[0]["code"], errs[0]["path"], errs[0]["message"], status="REJECTED",
                                 extra_errors=errs[1:])
        if evidence_origin == "FIXTURE":
            pass
        elif request["principal_id"] != principal_id:
            raise BookforgeError("PERMISSION_DENIED", "/principal_id",
                                 "principal_id must match the authenticated principal", status="REJECTED")
        project_id, branch_id = request["project_id"], request["branch_id"]
        self._authorize(principal_id, project_id, branch_id, op["permission_scopes"][action])
        if _parse_time(request["deadline"]) <= _now():
            raise BookforgeError("TIMEOUT", "/deadline", "deadline already passed before dispatch")

        request_hash = sha256_json({"action": action, "base_ref": request["base_ref"],
                                    "payload": request["payload"], "input_refs": request["input_refs"],
                                    "manual_candidate": manual_candidate})
        replay = self._check_receipt(project_id, branch_id, op_id, request["idempotency_key"], request_hash)
        if replay is not None:
            return replay

        ctx = Context(self, request, principal_id, action=action, manual_candidate=manual_candidate,
                      evidence_origin=evidence_origin)
        handler = get_handler(op_id)

        if action in ("CREATE", "UPDATE"):
            na = self._applicability(ctx, handler)
            if na is not None:
                return self._not_applicable(ctx, attempt_id, *na)

        self._resolve_all(ctx)
        if action == "CREATE":
            return self._create(ctx, handler, attempt_id, request_hash)
        if action == "UPDATE":
            return self._update(ctx, handler, attempt_id, request_hash)
        if action == "READ":
            return self._read(ctx, attempt_id, request_hash)
        if action == "VALIDATE":
            return self._validate(ctx, handler, attempt_id, request_hash)
        if action == "ACCEPT":
            return self._accept(ctx, handler, attempt_id, request_hash)
        raise BookforgeError("INVALID_INPUT", "/action", "unsupported action", status="REJECTED")

    # ------------------------------------------------------------------ authorization
    def _authorize(self, principal_id: str, project_id: str, branch_id: str, scope: str):
        # Without any grant on the project we answer PERMISSION_DENIED and do not reveal existence.
        if not self.store.has_project_access(principal_id, project_id):
            raise BookforgeError("PERMISSION_DENIED", "/project_id", "no access to this project", status="REJECTED")
        if self.store.project(project_id) is None:
            raise BookforgeError("NOT_FOUND", "/project_id", "project not found", status="REJECTED")
        if not self.store.branch_exists(project_id, branch_id):
            raise BookforgeError("NOT_FOUND", "/branch_id", "branch not found", status="REJECTED")
        if not self.store.has_project_access(principal_id, project_id, branch_id):
            raise BookforgeError("PERMISSION_DENIED", "/branch_id", "no access to this branch", status="REJECTED")
        if not self.store.has_scope(principal_id, project_id, branch_id, scope):
            raise BookforgeError("PERMISSION_DENIED", "", f"missing scope {scope}", status="REJECTED")

    # ------------------------------------------------------------------ idempotency
    def _check_receipt(self, project_id, branch_id, op_id, key, request_hash) -> dict | None:
        row = self.store.receipt(project_id, branch_id, op_id, key)
        if row is None:
            return None
        if row["request_hash"] != request_hash:
            raise BookforgeError("IDEMPOTENCY_CONFLICT", "/idempotency_key",
                                 "idempotency key reused with a different request", status="REJECTED")
        return json.loads(row["response"])

    # ------------------------------------------------------------------ applicability
    def _applicability(self, ctx: Context, handler) -> tuple[str, str] | None:
        rule = FEATURE_RULES.get(ctx.op_id)
        manifest = ctx.manifest
        if rule:
            rule_id, feature = rule
            if manifest is None or feature not in manifest.get("features", {}):
                raise BookforgeError("MISSING_INPUT", "/feature_manifest/features/" + feature,
                                     f"feature '{feature}' state is unknown; set it in the project feature manifest")
            if manifest["features"][feature] is not True:
                return rule_id, f"{ctx.op_id} requires {feature}=true in feature manifest revision {manifest['revision']}"
        return handler.applicability(ctx)

    def _early_not_applicable(self, request, op, action, principal_id, attempt_id, errs) -> dict | None:
        """A disabled feature op answers NOT_APPLICABLE even before its payload is complete.

        Only when the envelope itself is valid (errors are confined to /payload) and the caller
        is authorized, so the answer never leaks project state to unauthorized principals.
        """
        rule = FEATURE_RULES.get(op["id"])
        if rule is None or action not in ("CREATE", "UPDATE"):
            return None
        if any(not e["path"].startswith("/payload") for e in errs):
            return None
        if request.get("principal_id") != principal_id:
            return None
        try:
            self._authorize(principal_id, request["project_id"], request["branch_id"],
                            op["permission_scopes"][action])
        except BookforgeError:
            return None
        manifest = self.store.feature_manifest(request["project_id"], request["branch_id"])
        feature = rule[1]
        if manifest is None or manifest.get("features", {}).get(feature) is not False:
            return None
        ctx = Context(self, request, principal_id, action=action)
        return self._not_applicable(ctx, attempt_id, rule[0], f"{op['id']} requires {feature}=true in feature "
                                    f"manifest revision {manifest['revision']}")

    def _not_applicable(self, ctx: Context, attempt_id: str, rule_id: str, reason: str) -> dict:
        finding = ctx.finding("NOT_APPLICABLE", reason, severity="INFO", decision="NOT_APPLICABLE")
        with self.store.transaction() as tx:
            tx.insert_audit(project_id=ctx.project_id, branch_id=ctx.branch_id, request_id=ctx.request["request_id"],
                            attempt_id=attempt_id, operation_id=ctx.op_id, action=ctx.action,
                            principal_id=ctx.principal_id, input_refs=ctx.request["input_refs"], output_refs=[],
                            outcome="NOT_APPLICABLE", evidence_type="AUDITED_VALIDATION",
                            evidence_origin=ctx.evidence_origin)
        return self._response(ctx.request["request_id"], attempt_id, "NOT_APPLICABLE", [], None, [finding], [],
                              [], [], rule_id)

    # ------------------------------------------------------------------ reference resolution
    def resolve_ref(self, ref: dict, project_id: str, branch_id: str, path: str) -> dict:
        if ref["owner"] != ref["module_id"][0]:
            raise BookforgeError("INVALID_INPUT", path + "/owner", "owner must equal module_id[0]", status="REJECTED")
        if ref["project_id"] != project_id or ref["branch_id"] != branch_id:
            raise BookforgeError("INVALID_INPUT", path, "foreign project/branch pin; use an explicit copy/merge "
                                 "proposal for cross-branch content", status="REJECTED")
        rec = self.store.get_record(project_id, branch_id, ref["record_id"], ref["version"])
        if rec is None:
            raise BookforgeError("NOT_FOUND", path, f"record {ref['record_id']} v{ref['version']} not found")
        if rec["module_id"] != ref["module_id"]:
            raise BookforgeError("INVALID_INPUT", path + "/module_id", "pinned module does not own this record",
                                 status="REJECTED")
        if rec["content_hash"] != ref["content_hash"]:
            raise BookforgeError("HASH_MISMATCH", path + "/content_hash", "content hash does not match the pin",
                                 status="REJECTED")
        if rec["representation"] == "BINARY_ARTIFACT":
            self.store.read_binary(rec)  # verifies exact bytes
        elif rec["record_kind"] == "OUTPUT":
            errs = self.contracts.check(rec["module_id"], "OUTPUT", rec["data"])
            if errs:
                raise BookforgeError("INVALID_INPUT", path, f"pinned record fails producer OUTPUT: {errs[0]['path']}",
                                     status="REJECTED")
        elif rec["record_kind"] in SHARED_KIND_SCHEMAS:
            errs = self.contracts.check_shared(SHARED_KIND_SCHEMAS[rec["record_kind"]], rec["data"])
            if errs:
                raise BookforgeError("INVALID_INPUT", path, f"pinned {rec['record_kind']} fails its schema",
                                     status="REJECTED")
        return rec

    def _resolve_all(self, ctx: Context):
        req = ctx.request
        bindings = {b["input_path"]: b for b in self.contracts.bindings(ctx.op_id)}
        found = []
        for i, ref in enumerate(req["input_refs"]):
            found.append((f"/input_refs/{i}", ref))
        if req.get("base_ref"):
            found.append(("/base_ref", req["base_ref"]))
        for parts, ref in iter_references(req["payload"], ("payload",)):
            found.append((json_pointer(parts), ref))
        for ptr, ref in found:
            rec = self.resolve_ref(ref, ctx.project_id, ctx.branch_id, ptr)
            binding = bindings.get(_ptr_template(ptr))
            if binding:
                if rec["module_id"] not in binding["allowed_producers"]:
                    raise BookforgeError("INVALID_INPUT", ptr + "/module_id",
                                         f"{rec['module_id']} is not a permitted producer for {binding['input_path']}",
                                         status="REJECTED")
                kind = binding.get("required_record_kind")
                if kind:
                    aux = (rec.get("data") or {}).get("auxiliary_record") or {}
                    if aux.get("record_kind") != kind:
                        raise BookforgeError("INVALID_INPUT", ptr, f"requires an imported {kind} profile",
                                             status="REJECTED")
                    errs = self.contracts.check_shared(kind, aux.get("data"))
                    if errs:
                        raise BookforgeError("INVALID_INPUT", ptr, f"{kind} data invalid at {errs[0]['path']}",
                                             status="REJECTED")
            ctx.resolved[ptr] = rec
        if req.get("base_ref"):
            ctx.base = ctx.resolved["/base_ref"]

    # ------------------------------------------------------------------ CREATE
    def _create(self, ctx: Context, handler, attempt_id: str, request_hash: str) -> dict:
        if ctx.manual_candidate is not None:
            errs = [dict(e, path="/manual_candidate" + e["path"])
                    for e in self.contracts.check(ctx.op_id, "OUTPUT", ctx.manual_candidate)]
            if errs:
                raise BookforgeError(errs[0]["code"], errs[0]["path"], errs[0]["message"],
                                     status="REJECTED", extra_errors=errs[1:])
        result = handler.create(ctx)
        return self._publish(ctx, result, attempt_id, request_hash, version=1, record_id=result.record_id)

    # ------------------------------------------------------------------ UPDATE
    def _update(self, ctx: Context, handler, attempt_id: str, request_hash: str) -> dict:
        base = ctx.base
        if base["module_id"] != ctx.op_id or base["record_kind"] != "OUTPUT":
            raise BookforgeError("INVALID_INPUT", "/base_ref/module_id",
                                 f"UPDATE replaces {ctx.op_id} output records only", status="REJECTED")
        if base["version"] != base["latest_version"]:
            raise BookforgeError("VERSION_CONFLICT", "/base_ref/version",
                                 f"stale base v{base['version']}; head is v{base['latest_version']}", status="REJECTED")
        head_lc = base["lifecycle"]
        if head_lc == "LOCKED" and not self._protected_change_authorized(ctx, base):
            raise BookforgeError("LOCKED_FACT", "/base_ref", "record is LOCKED; a protected-change authorization "
                                 "(I10/K09 approval with scope OP:protected_change) is required", status="BLOCKED")
        result = handler.update(ctx)
        return self._publish(ctx, result, attempt_id, request_hash, version=base["version"] + 1,
                             record_id=base["record_id"], expected_latest=base["version"])

    def _protected_change_authorized(self, ctx: Context, base: dict) -> bool:
        rows = self.store.query("SELECT body FROM approvals WHERE project_id=? AND branch_id=? AND decision='APPROVED' "
                                "AND revoked=0", (ctx.project_id, ctx.branch_id))
        for r in rows:
            body = json.loads(r["body"])
            subj = body["subject_ref"]
            if (subj["record_id"] == base["record_id"] and subj["version"] == base["version"]
                    and subj["content_hash"] == base["content_hash"]
                    and f"{ctx.op_id}:protected_change" in body["scopes"]
                    and _parse_time(body["expires_at"]) > _now()):
                return True
        return False

    # ------------------------------------------------------------------ publish (shared by CREATE/UPDATE)
    def _publish(self, ctx: Context, result: Result, attempt_id: str, request_hash: str, *, version: int,
                 record_id: str | None, expected_latest: int | None = None) -> dict:
        req = ctx.request
        if result.status in ("BLOCKED", "PARTIAL") and result.data is None:
            # Nothing to publish; durable checkpoints (if any) were staged by the handler.
            if ctx.staged or ctx.post_commit:
                self._commit_side_records(ctx, attempt_id)
            return self._response(req["request_id"], attempt_id, result.status, [], None, result.findings,
                                  result.errors or [error("MISSING_INPUT", "", "operation blocked")],
                                  self._source_refs(ctx, result), result.unresolved, None)
        if result.data is None:
            raise BookforgeError("INTERNAL_ERROR", "", "handler returned no data")
        errs = self.contracts.check(ctx.op_id, "OUTPUT", result.data)
        if errs:
            code = "INVALID_INPUT" if result.transform == "MANUAL" else "INTERNAL_ERROR"
            raise BookforgeError(code, errs[0]["path"], f"result does not satisfy {ctx.op_id} OUTPUT: "
                                 f"{errs[0]['message']}", extra_errors=errs[1:])
        record_id = record_id or f"{ctx.op_id}-{uuid.uuid4().hex[:16]}"
        source_refs = self._source_refs(ctx, result)
        provenance_id = new_id("prov")
        lifecycle_findings = result.findings
        try:
            with self.store.transaction() as tx:
                ref = tx.insert_json_record(
                    project_id=ctx.project_id, branch_id=ctx.branch_id, module_id=ctx.op_id, record_id=record_id,
                    version=version, data=result.data, source_refs=source_refs, principal_id=ctx.principal_id,
                    request_id=req["request_id"], provenance_id=provenance_id, evidence_origin=ctx.evidence_origin,
                    expected_latest=expected_latest, findings=lifecycle_findings)
                staged_refs = self._insert_staged(ctx, tx, provenance_id)
                tx.insert_provenance(provenance_id=provenance_id, ref=ref, operation_id=ctx.op_id,
                                     request_id=req["request_id"], attempt_id=attempt_id,
                                     principal_id=ctx.principal_id, input_refs=source_refs,
                                     transform=result.transform, resource=result.resource)
                for ptr, rec in ctx.resolved.items():
                    if ptr == "/base_ref":
                        continue
                    tx.insert_edge(project_id=ctx.project_id, branch_id=ctx.branch_id, producer_ref=rec["ref"],
                                   consumer_operation=ctx.op_id, consumer_ref=ref,
                                   paths=self._read_paths(ctx.op_id, ptr), kind=self._edge_kind(ctx.op_id, ptr),
                                   stage="DRAFT")
                for fn in ctx.post_commit:
                    fn(tx)
                output_refs = [ref] + staged_refs
                audit_id = tx.insert_audit(project_id=ctx.project_id, branch_id=ctx.branch_id,
                                           request_id=req["request_id"], attempt_id=attempt_id,
                                           operation_id=ctx.op_id, action=ctx.action, principal_id=ctx.principal_id,
                                           input_refs=source_refs, output_refs=output_refs, outcome="SUCCESS",
                                           evidence_type="COMMITTED_OUTPUT", evidence_origin=ctx.evidence_origin)
                tx.insert_outbox(ctx.project_id, ctx.branch_id, f"record.{ctx.action.lower()}d",
                                 {"operation_id": ctx.op_id, "output_refs": output_refs, "audit_id": audit_id,
                                  "request_id": req["request_id"]})
                status = result.status if result.status in ("DRAFT", "PARTIAL") else "DRAFT"
                response = self._response(req["request_id"], attempt_id, status, output_refs, result.data,
                                          result.findings, result.errors, source_refs, result.unresolved, None)
                tx.insert_receipt(ctx.project_id, ctx.branch_id, ctx.op_id, req["idempotency_key"], request_hash,
                                  response)
        except sqlite3.IntegrityError:
            # A concurrent identical request committed first: return its receipt (or conflict).
            replay = self._check_receipt(ctx.project_id, ctx.branch_id, ctx.op_id, req["idempotency_key"],
                                         request_hash)
            if replay is not None:
                return replay
            raise
        return response

    def _commit_side_records(self, ctx: Context, attempt_id: str):
        with self.store.transaction() as tx:
            self._insert_staged(ctx, tx, None)
            for fn in ctx.post_commit:
                fn(tx)

    def _insert_staged(self, ctx: Context, tx, provenance_id: str | None) -> list[dict]:
        refs = []
        for s in ctx.staged:
            if s.kind == "BINARY_ARTIFACT":
                ref = tx.insert_binary_record(project_id=ctx.project_id, branch_id=ctx.branch_id,
                                              module_id=s.module_id, record_id=s.record_id, version=s.version,
                                              data=s.data, mime_type=s.mime_type, source_refs=s.source_refs,
                                              principal_id=ctx.principal_id, record_kind=s.record_kind,
                                              request_id=ctx.request["request_id"], provenance_id=provenance_id,
                                              evidence_origin=ctx.evidence_origin, expected_latest=s.expected_latest)
            else:
                if s.record_kind == "OUTPUT":
                    errs = self.contracts.check(s.module_id, "OUTPUT", s.data)
                elif s.record_kind in SHARED_KIND_SCHEMAS:
                    errs = self.contracts.check_shared(SHARED_KIND_SCHEMAS[s.record_kind], s.data)
                else:
                    errs = []
                if errs:
                    raise BookforgeError("INTERNAL_ERROR", errs[0]["path"],
                                         f"staged {s.module_id} {s.record_kind} invalid: {errs[0]['message']}")
                ref = tx.insert_json_record(project_id=ctx.project_id, branch_id=ctx.branch_id, module_id=s.module_id,
                                            record_id=s.record_id, version=s.version, data=s.data,
                                            source_refs=s.source_refs, principal_id=ctx.principal_id,
                                            record_kind=s.record_kind, request_id=ctx.request["request_id"],
                                            provenance_id=provenance_id, evidence_origin=ctx.evidence_origin,
                                            expected_latest=s.expected_latest, state=s.state)
            if ref != s.ref:
                raise BookforgeError("INTERNAL_ERROR", "", "staged reference changed during commit")
            refs.append(ref)
        return refs

    def _source_refs(self, ctx: Context, result: Result) -> list[dict]:
        seen, out = set(), []
        for rec in list(ctx.resolved.values()):
            k = (rec["record_id"], rec["version"])
            if k not in seen:
                seen.add(k)
                out.append(rec["ref"])
        for ref in result.source_refs:
            k = (ref["record_id"], ref["version"])
            if k not in seen:
                seen.add(k)
                out.append(ref)
        return out

    def _read_paths(self, op_id: str, ptr: str) -> list[str]:
        # Whole-record read unless the dependency matrix narrows it.
        return [""]

    def _edge_kind(self, op_id: str, ptr: str) -> str:
        tmpl = _ptr_template(ptr)
        for d in self.contracts.dependencies(op_id, "CREATE"):
            if d["input_field"] == tmpl:
                return d["dependency_kind"]
        return "CONDITIONAL"

    # ------------------------------------------------------------------ READ
    def _read(self, ctx: Context, attempt_id: str, request_hash: str) -> dict:
        rec = ctx.base
        if rec["module_id"] != ctx.op_id:
            raise BookforgeError("INVALID_INPUT", "/base_ref/module_id",
                                 f"{ctx.op_id} READ retrieves {ctx.op_id} records", status="REJECTED")
        findings = list(rec["findings"])
        if rec["lifecycle"] == "SUPERSEDED":
            findings.append(ctx.finding("SUPERSEDED", f"superseded; approved head is v{rec['approved_version']}",
                                        severity="INFO", decision="PASS"))
        if rec["stale"]:
            findings.append(ctx.finding("STALE", rec["stale_reason"] or "input pins changed", severity="MAJOR",
                                        decision="UNKNOWN"))
        result = rec["data"] if rec["record_kind"] == "OUTPUT" else None
        status = STATUS_FROM_LIFECYCLE.get(rec["lifecycle"], "DRAFT")
        response = self._response(ctx.request["request_id"], attempt_id, status, [rec["ref"]], result, findings, [],
                                  rec["source_refs"], [], None)
        with self.store.transaction() as tx:
            tx.insert_audit(project_id=ctx.project_id, branch_id=ctx.branch_id, request_id=ctx.request["request_id"],
                            attempt_id=attempt_id, operation_id=ctx.op_id, action="READ",
                            principal_id=ctx.principal_id, input_refs=[rec["ref"]], output_refs=[],
                            outcome="SUCCESS", evidence_type="AUDITED_READ", evidence_origin=ctx.evidence_origin)
            self._store_receipt(tx, ctx, request_hash, response)
        return response

    def _store_receipt(self, tx, ctx, request_hash, response):
        try:
            tx.insert_receipt(ctx.project_id, ctx.branch_id, ctx.op_id, ctx.request["idempotency_key"],
                              request_hash, response)
        except sqlite3.IntegrityError:
            pass

    # ------------------------------------------------------------------ VALIDATE
    def _candidate(self, ctx: Context) -> dict:
        cand = ctx.resolved.get("/payload/candidate_ref")
        base = ctx.base
        if cand is None:
            raise BookforgeError("MISSING_INPUT", "/payload/candidate_ref", "candidate_ref is required")
        if cand["record_id"] != base["record_id"] or cand["version"] != base["version"]:
            raise BookforgeError("INVALID_INPUT", "/payload/candidate_ref",
                                 "candidate_ref must pin the same revision as base_ref", status="REJECTED")
        if cand["module_id"] != ctx.op_id:
            raise BookforgeError("INVALID_INPUT", "/payload/candidate_ref/module_id",
                                 f"{ctx.op_id} validates its own records", status="REJECTED")
        return cand

    def run_validation(self, ctx: Context, handler, rec: dict) -> list[dict]:
        findings: list[dict] = []
        if rec["record_kind"] == "OUTPUT":
            for e in self.contracts.check(rec["module_id"], "OUTPUT", rec["data"]):
                findings.append(ctx.finding("SCHEMA", f"{e['code']} at {e['path']}: {e['message']}",
                                            severity="BLOCKING", decision="FAIL"))
        # Every link inside the stored data must still resolve (mandatory links for approval).
        for parts, ref in iter_references(rec.get("data") or {}, ()):
            try:
                self.resolve_ref(ref, ctx.project_id, ctx.branch_id, json_pointer(parts))
            except BookforgeError as exc:
                findings.append(ctx.finding("LINK_RESOLUTION", f"{json_pointer(parts)}: {exc.errors[0]['message']}",
                                            severity="BLOCKING", decision="FAIL"))
        for ref in rec["source_refs"]:
            src = self.store.get_record(ctx.project_id, ctx.branch_id, ref["record_id"], ref["version"])
            if src is None or src["content_hash"] != ref["content_hash"]:
                findings.append(ctx.finding("SOURCE_PIN", f"source {ref['record_id']} v{ref['version']} unresolved",
                                            severity="BLOCKING", decision="FAIL"))
        if rec["stale"]:
            findings.append(ctx.finding("STALE", rec["stale_reason"] or "an input changed after creation; "
                                        "create a replacement against current approved inputs",
                                        severity="BLOCKING", decision="UNKNOWN"))
        findings.extend(handler.validate(ctx, rec))
        return findings

    @staticmethod
    def blocking(findings: list[dict]) -> list[dict]:
        return [f for f in findings if f["severity"] == "BLOCKING" and f["decision"] in ("FAIL", "UNKNOWN")]

    def _validate(self, ctx: Context, handler, attempt_id: str, request_hash: str) -> dict:
        rec = self._candidate(ctx)
        findings = self.run_validation(ctx, handler, rec)
        passed = not self.blocking(findings)
        current = rec["lifecycle"]
        if current in ("APPROVED", "LOCKED", "SUPERSEDED", "REJECTED"):
            new_state = current  # rechecking an approved/rejected revision never demotes or promotes it
        else:
            new_state = "VALIDATED" if passed else "DRAFT"
        status = STATUS_FROM_LIFECYCLE[new_state] if passed else "DRAFT"
        response = self._response(ctx.request["request_id"], attempt_id, status, [rec["ref"]],
                                  rec["data"] if rec["record_kind"] == "OUTPUT" else None, findings, [],
                                  rec["source_refs"], [], None)
        with self.store.transaction() as tx:
            audit_id = tx.insert_audit(project_id=ctx.project_id, branch_id=ctx.branch_id,
                                       request_id=ctx.request["request_id"], attempt_id=attempt_id,
                                       operation_id=ctx.op_id, action="VALIDATE", principal_id=ctx.principal_id,
                                       input_refs=[rec["ref"]], output_refs=[],
                                       outcome="SUCCESS" if passed else "REJECTED",
                                       evidence_type="AUDITED_VALIDATION", evidence_origin=ctx.evidence_origin)
            tx.set_lifecycle(rec["ref"], new_state, findings=findings, validation_audit_id=audit_id)
            if rec["stale"]:
                # Rechecking a stale approved revision must not clear its stale flag (set_lifecycle resets
                # stale on APPROVED/LOCKED); only a replacement against current inputs does.
                tx.mark_stale(ctx.project_id, ctx.branch_id, rec["record_id"], rec["version"],
                              rec.get("stale_reason") or "an input changed after creation")
            self._store_receipt(tx, ctx, request_hash, response)
        return response

    # ------------------------------------------------------------------ ACCEPT
    def _accept(self, ctx: Context, handler, attempt_id: str, request_hash: str) -> dict:
        rec = self._candidate(ctx)
        if rec["lifecycle"] in ("APPROVED", "LOCKED"):
            response = self._response(ctx.request["request_id"], attempt_id, "APPROVED", [rec["ref"]],
                                      rec["data"] if rec["record_kind"] == "OUTPUT" else None, rec["findings"], [],
                                      rec["source_refs"], [], None)
            with self.store.transaction() as tx:
                self._store_receipt(tx, ctx, request_hash, response)
            return response
        if rec["lifecycle"] in ("SUPERSEDED", "REJECTED"):
            raise BookforgeError("INVALID_INPUT", "/payload/candidate_ref",
                                 f"candidate is {rec['lifecycle']} and cannot be accepted", status="REJECTED")
        if rec["version"] != rec["latest_version"]:
            raise BookforgeError("VERSION_CONFLICT", "/payload/candidate_ref",
                                 "a newer revision exists; accept the latest candidate", status="REJECTED")
        findings = self.run_validation(ctx, handler, rec)
        if self.blocking(findings):
            with self.store.transaction() as tx:
                tx.set_lifecycle(rec["ref"], "DRAFT", findings=findings)
            return self._response(ctx.request["request_id"], attempt_id, "DRAFT", [rec["ref"]], rec["data"],
                                  findings, [error("APPROVAL_REQUIRED", "/payload/candidate_ref",
                                                   "candidate has unresolved blocking findings")],
                                  rec["source_refs"], [f["id"] for f in self.blocking(findings)], None)
        approval = None
        approval_rec = ctx.resolved.get("/payload/approval_ref")
        if approval_rec is not None:
            approval = self._check_approval(ctx, approval_rec, rec)
        elif handler.requires_explicit_approval(ctx, rec):
            raise BookforgeError("APPROVAL_REQUIRED", "/payload/approval_ref",
                                 f"{ctx.op_id} acceptance needs a valid approval record for this exact candidate",
                                 unresolved=[f"{ctx.op_id}:approval"])
        gate = handler.accept_gate(ctx, rec, approval)
        if self.blocking(gate):
            return self._response(ctx.request["request_id"], attempt_id, "BLOCKED", [], None, findings + gate,
                                  [error("APPROVAL_REQUIRED", "/payload", "owner acceptance gate refused")],
                                  rec["source_refs"], [f["id"] for f in self.blocking(gate)], None)
        findings = findings + gate
        now = _now()
        approval_body = {
            "approval_id": new_id("appr"), "subject_ref": rec["ref"],
            "action_hash": sha256_json({"action": "ACCEPT", "operation": ctx.op_id, "subject": rec["ref"]}),
            "policy_ref": approval_rec["ref"] if approval_rec else rec["ref"],
            "approver_id": ctx.principal_id, "scopes": [f"{ctx.op_id}:accept"],
            "source_refs": rec["source_refs"], "issued_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "expires_at": (now + timedelta(days=3650)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "revoked": False, "decision": "APPROVED", "evidence_origin": ctx.evidence_origin,
        }
        response = None
        with self.store.transaction() as tx:
            tx.insert_approval(approval_body, ctx.project_id, ctx.branch_id)
            audit_id = tx.insert_audit(project_id=ctx.project_id, branch_id=ctx.branch_id,
                                       request_id=ctx.request["request_id"], attempt_id=attempt_id,
                                       operation_id=ctx.op_id, action="ACCEPT", principal_id=ctx.principal_id,
                                       input_refs=[rec["ref"]], output_refs=[rec["ref"]], outcome="SUCCESS",
                                       evidence_type="COMMITTED_OUTPUT", evidence_origin=ctx.evidence_origin)
            tx.set_lifecycle(rec["ref"], "APPROVED", findings=findings, validation_audit_id=audit_id,
                             approval_id=approval_body["approval_id"])
            prev_version = tx.set_approved_head(rec["ref"])
            invalidated = self._invalidate_consumers(tx, ctx, rec, prev_version)
            handler.on_accept(ctx, rec, tx)
            staged_refs = self._insert_staged(ctx, tx, None)
            for fn in ctx.post_commit:
                fn(tx)
            tx.insert_outbox(ctx.project_id, ctx.branch_id, "record.approved",
                             {"operation_id": ctx.op_id, "ref": rec["ref"], "approval_id": approval_body["approval_id"],
                              "invalidated": invalidated})
            response = self._response(ctx.request["request_id"], attempt_id, "APPROVED", [rec["ref"]] + staged_refs,
                                      rec["data"] if rec["record_kind"] == "OUTPUT" else None, findings, [],
                                      rec["source_refs"], [], None)
            self._store_receipt(tx, ctx, request_hash, response)
        return response

    def _check_approval(self, ctx: Context, approval_rec: dict, rec: dict) -> dict:
        """approval_ref must be the CURRENT K09/I10 decision, APPROVED, unexpired, binding this exact candidate."""
        path = "/payload/approval_ref"
        latest = self.store.get_record(ctx.project_id, ctx.branch_id, approval_rec["record_id"])
        if latest is None or latest["version"] != approval_rec["version"]:
            raise BookforgeError("APPROVAL_REQUIRED", path, "approval has a newer revision (revoked or "
                                 "superseded); pin the current decision")
        if approval_rec["module_id"] == "K09":
            from .k_runtime import check_k09_authorization
            check_k09_authorization(self.store, approval_rec, None, path)  # head, decision, expiry
            if not self._k09_binds(ctx, approval_rec, rec):
                raise BookforgeError("APPROVAL_REQUIRED", path, "authorization does not bind this exact "
                                     "candidate revision; prior approval cannot authorize changed output")
            data = approval_rec["data"]
            return {"source": approval_rec["ref"], "decision": data["decision"], "expiry": data["expiry"]}
        if approval_rec["module_id"] == "I10":
            body = (approval_rec.get("data") or {}).get("approval") or {}
            if body.get("revoked") or body.get("decision") != "APPROVED":
                raise BookforgeError("APPROVAL_REQUIRED", path, f"approval decision is {body.get('decision')}")
            expiry = body.get("expires_at")
            if not expiry or _parse_time(expiry) <= _now():
                raise BookforgeError("EXPIRED_APPROVAL", path, "approval has expired")
            subject = body.get("subject_ref") or {}
            if (subject.get("record_id"), subject.get("version"), subject.get("content_hash")) != (
                    rec["record_id"], rec["version"], rec["content_hash"]):
                raise BookforgeError("APPROVAL_REQUIRED", path, "approval covers a different revision; prior "
                                     "approval cannot authorize changed output")
            return {"source": approval_rec["ref"], "decision": "APPROVED", "expiry": expiry}
        raise BookforgeError("APPROVAL_REQUIRED", path, "approval_ref must be a K09 or I10 approval decision")

    def _k09_binds(self, ctx: Context, approval_rec: dict, rec: dict) -> bool:
        """A K09 decision covers the exact pin named in its stored binding or in its request's source pins."""
        from .k_runtime import k09_checkpoint
        want = (rec["record_id"], rec["version"], rec["content_hash"])
        binding = k09_checkpoint(self.store, ctx.project_id, ctx.branch_id, approval_rec["record_id"]) or {}
        pins = [(r["record_id"], r["version"], r["content_hash"])
                for r in binding.get("impact", {}).get("source_versions", [])]
        for version in self.store.history(ctx.project_id, ctx.branch_id, approval_rec["record_id"]):
            pins += [(r["record_id"], r["version"], r["content_hash"]) for r in version["source_refs"]]
        return want in pins

    def _invalidate_consumers(self, tx, ctx: Context, rec: dict, prev_version: int | None) -> list[dict]:
        """Mark consumers of the previous approved revision stale when read paths changed (section 6)."""
        if not prev_version or prev_version == rec["version"]:
            return []
        prev = self.store.get_record(ctx.project_id, ctx.branch_id, rec["record_id"], prev_version)
        changed = changed_pointers((prev or {}).get("data"), rec.get("data"))
        edges = tx.execute("SELECT * FROM dependency_edges WHERE project_id=? AND branch_id=? AND "
                           "producer_record_id=? AND producer_version<?",
                           (ctx.project_id, ctx.branch_id, rec["record_id"], rec["version"])).fetchall()
        out, visited = [], set()
        root = f"{rec['module_id']}:{rec['record_id']} changed from v{prev_version} to v{rec['version']}"
        queue = [(e, changed) for e in edges]
        while queue:
            edge, changes = queue.pop(0)
            key = (edge["consumer_record_id"], edge["consumer_version"])
            if key in visited:
                continue
            paths = json.loads(edge["paths"])
            if not any(pointers_overlap(c, p) for c in changes for p in paths):
                continue
            visited.add(key)
            if edge["producer_record_id"] == rec["record_id"]:
                reason = (f"input {edge['producer_module']}:{edge['producer_record_id']} changed from "
                          f"v{edge['producer_version']} to v{rec['version']}")
            else:  # transitive: name the stale input and the change that caused it
                reason = (f"input {edge['producer_module']}:{edge['producer_record_id']} "
                          f"v{edge['producer_version']} is stale ({root})")
            tx.mark_stale(ctx.project_id, ctx.branch_id, edge["consumer_record_id"], edge["consumer_version"], reason)
            out.append({"record_id": edge["consumer_record_id"], "version": edge["consumer_version"],
                        "operation": edge["consumer_operation"]})
            # Transitive descendants see a whole-record change of the stale consumer.
            for e2 in tx.execute("SELECT * FROM dependency_edges WHERE project_id=? AND branch_id=? AND "
                                 "producer_record_id=? AND producer_version=?",
                                 (ctx.project_id, ctx.branch_id, edge["consumer_record_id"],
                                  edge["consumer_version"])).fetchall():
                queue.append((e2, [""]))
        if out:
            tx.insert_outbox(ctx.project_id, ctx.branch_id, "record.invalidated",
                             {"producer": rec["ref"], "changed_paths": changed, "stale": out})
        return out

    # ------------------------------------------------------------------ responses
    def _response(self, request_id, attempt_id, status, output_refs, result, findings, errors, source_refs,
                  unresolved, selection_rule_id) -> dict:
        return {
            "contract_version": CONTRACT_VERSION, "request_id": request_id, "attempt_id": attempt_id,
            "status": status, "output_refs": list(output_refs), "result": result,
            "findings": list(findings), "errors": list(errors), "source_refs": list(source_refs),
            "unresolved_requests": list(unresolved), "selection_rule_id": selection_rule_id,
        }

    def _error_response(self, request_id, attempt_id, errors, status, findings=None, unresolved=None) -> dict:
        if status not in ("BLOCKED", "REJECTED", "PARTIAL", "NOT_APPLICABLE"):
            status = "BLOCKED"
        return self._response(request_id, attempt_id, status, [], None, findings or [], errors, [], unresolved or [],
                              None)

    # ================================================================== kernel services
    def bootstrap_project(self, principal_id: str, name: str, *, project_id: str | None = None,
                          settings: dict | None = None, features: dict | None = None,
                          release_profiles: list | None = None, story_time_unit: str = "seconds",
                          currency: str = "USD") -> str:
        """Kernel path used by K01: create project, main branch, owner grants and first manifest."""
        project_id = project_id or f"proj-{uuid.uuid4().hex[:12]}"
        feats = {"artwork": False, "magic": False, "mystery": False, "foreshadowing": False, "character_arcs": True}
        feats.update(features or {})
        with self.store.transaction() as tx:
            tx.ensure_principal(principal_id)
            tx.create_project(project_id, name, principal_id, settings or {}, story_time_unit, currency)
            tx.grant(principal_id, project_id, "*", "*")
            tx.put_feature_manifest(self.default_manifest(project_id, "main", feats, release_profiles))
            tx.insert_outbox(project_id, "main", "project.created", {"project_id": project_id, "name": name})
        return project_id

    def default_manifest(self, project_id: str, branch_id: str, features: dict,
                         release_profiles: list | None = None) -> dict:
        required = []
        for op in self.contracts.operation_ids:
            if op in ("B08",) and not features.get("mystery"):
                continue
            if op in ("B09",) and not features.get("foreshadowing"):
                continue
            if op in ("E08", "A09") and not features.get("magic"):
                continue
            if op.startswith("D") and not features.get("artwork"):
                continue
            if op == "H06" and not features.get("artwork"):
                continue
            if op in ("G10", "G14"):
                continue
            required.append(op)
        return {"manifest_id": f"manifest-{project_id}-{branch_id}", "project_id": project_id,
                "branch_id": branch_id, "revision": 1, "phase": "PLANNING", "required_operations": required,
                "required_output_refs": [], "features": features,
                "release_profiles": release_profiles or ["MANUSCRIPT_PDF"], "allow_empty_phase": False}

    def set_manifest(self, principal_id: str, project_id: str, branch_id: str, manifest: dict) -> dict:
        if not self.store.has_scope(principal_id, project_id, branch_id, "K02:create"):
            raise BookforgeError("PERMISSION_DENIED", "", "missing scope K02:create", status="REJECTED")
        manifest = dict(manifest, project_id=project_id, branch_id=branch_id, revision=1)
        errs = self.contracts.check_shared("FeatureManifest", manifest)
        if errs:
            raise BookforgeError(errs[0]["code"], errs[0]["path"], errs[0]["message"], status="REJECTED")
        with self.store.transaction() as tx:
            stored = tx.put_feature_manifest(manifest)
            tx.insert_outbox(project_id, branch_id, "manifest.changed", {"revision": stored["revision"]})
        return stored

    def lock_record(self, ctx: Context, tx, ref: dict):
        tx.set_lifecycle(ref, "LOCKED")
