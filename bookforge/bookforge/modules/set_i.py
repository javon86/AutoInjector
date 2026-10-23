"""Set I handlers: Brain / Storage / Context (I01-I15)."""
from __future__ import annotations

import json
import re
from datetime import timedelta

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import SchemaError

from .. import k_runtime as kr
from ..canonical import (canonical_bytes, changed_pointers, iter_references, json_pointer, pointers_overlap,
                         resolve_pointer, sha256_json)
from ..contracts import schema_errors
from ..errors import BookforgeError
from ..providers import estimate_tokens
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
        # Same rules as ACCEPT: the current decision, APPROVED, unexpired and bound to this exact source
        # revision (an AUXILIARY first import has no source record, so only the decision itself is checked).
        ctx.engine._check_approval(ctx, appr, ctx.field_record("source_ref"))
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


# ======================================================================================
# Shared helpers for I02-I15
# ======================================================================================
NS_I02 = "I02.registry"      # schema_id -> {versions:{semver:{...}}, order:[semver]}
NS_I02_DOCS = "I02.docs"     # schema_hash -> {json_schema} (content addressed, immutable)
NS_I03 = "I03.registrations"  # registration_id -> registration; key "_registry" -> {revision}
NS_I05 = "I05.requests"      # dedupe_key -> open missing-information request
NS_I07 = "I07.packages"      # I07 record_id -> {mandatory:[refs]}
NS_I14 = "I14.chains"        # "record_id@version" -> {chain_hash, record_id}
FEATURES = ("artwork", "magic", "mystery", "foreshadowing", "character_arcs")
DERIVED_UPDATE_MSG = "is a derived projection; recompute it with CREATE instead of replacing it"


def _state(ctx: Context, ns: str, key: str):
    return kr.read_state(ctx.store, ctx.project_id, ctx.branch_id, ns, key)


def _put_state(ctx: Context, ns: str, key: str, value, expected: int | None):
    pid, bid = ctx.project_id, ctx.branch_id
    ctx.on_commit(lambda tx: tx.put_state(pid, bid, ns, key, value, expected_revision=expected))


def _rkey(ref: dict) -> tuple:
    return (ref["record_id"], ref["version"], ref["content_hash"])


def _rej(code: str, path: str, msg: str, status: str = "REJECTED") -> BookforgeError:
    return BookforgeError(code, path, msg, status=status)


def _valid_pointer(p: str) -> bool:
    return p == "" or p.startswith("/")


def registration(store, project_id: str, branch_id: str, record_id: str) -> dict | None:
    """I03 registration details (producer/consumer/output_type/predicate) for an I03 record."""
    v, _ = kr.read_state(store, project_id, branch_id, NS_I03, record_id)
    return v


def registry_revision(store, project_id: str, branch_id: str) -> int:
    v, _ = kr.read_state(store, project_id, branch_id, NS_I03, "_registry")
    return (v or {}).get("revision", 0)


def completion_operation(i12_record: dict) -> str | None:
    ev = (i12_record.get("data") or {}).get("evidence") or {}
    return ev.get("operation_id")


def _texts(value, keys=None) -> list[str]:
    """All strings in a JSON value (optionally only under the given keys)."""
    out = []
    if isinstance(value, str):
        if keys is None:
            out.append(value)
    elif isinstance(value, dict):
        for k, v in value.items():
            if keys is not None and k in keys and isinstance(v, str):
                out.append(v)
            else:
                out.extend(_texts(v, keys))
    elif isinstance(value, list):
        for v in value:
            out.extend(_texts(v, keys))
    return out


def _search_texts(data) -> list[str]:
    """Summary/text of a record: every `summary`/`text` string plus the record's own top-level
    prose fields (domain OUTPUTs name their summary differently, e.g. A01 concept, B01 premise)."""
    out = _texts(data, {"summary", "text"})
    if isinstance(data, dict):
        out += [v for k, v in sorted(data.items()) if isinstance(v, str) and k not in ("summary", "text")]
    return out


def _predicates(value) -> set[str]:
    out = set()
    if isinstance(value, dict):
        if isinstance(value.get("predicate"), str) and "subject_id" in value:
            out.add(value["predicate"])
        for v in value.values():
            out |= _predicates(v)
    elif isinstance(value, list):
        for v in value:
            out |= _predicates(v)
    return out


class _DerivedProjection(OperationHandler):
    """Projection outputs (validation results, searches, packages, completion...) are recomputed,
    never hand-replaced: a caller-supplied replacement would let workers forge evidence."""

    def update(self, ctx: Context) -> Result:
        raise _rej("INVALID_INPUT", "/payload", f"{ctx.op_id} {DERIVED_UPDATE_MSG}")


# ======================================================================================
# I02 - Schema Manager
# ======================================================================================
def _semver(v: str) -> tuple[int, int, int]:
    a, b, c = v.split(".")
    return int(a), int(b), int(c)


def _type_set(t):
    if t is None:
        return None
    return set(t) if isinstance(t, list) else {t}


def breaking_changes(old, new, path: str = "") -> list[str]:
    """Structural incompatibilities of `new` against `old` (removals, new requirements, narrowing)."""
    where = path or "/"
    if not isinstance(old, dict) or not isinstance(new, dict):
        return [] if old == new else [f"{where}: schema replaced"]
    out = []
    ot, nt = _type_set(old.get("type")), _type_set(new.get("type"))
    if nt is not None and (ot is None or not ot <= nt):
        out.append(f"{where}: type narrowed")
    for r in sorted(set(new.get("required", [])) - set(old.get("required", []))):
        out.append(f"{path}/{r}: newly required")
    oprops, nprops = old.get("properties", {}), new.get("properties", {})
    for k in sorted(oprops):
        if k not in nprops:
            if new.get("additionalProperties") is False:
                out.append(f"{path}/{k}: property removed")
        else:
            out.extend(breaking_changes(oprops[k], nprops[k], f"{path}/{k}"))
    if old.get("additionalProperties") is not False and new.get("additionalProperties") is False:
        out.append(f"{where}: closed to additional properties")
    if "enum" in new:
        oe = {json.dumps(x, sort_keys=True) for x in old.get("enum", [])} if "enum" in old else None
        ne = {json.dumps(x, sort_keys=True) for x in new["enum"]}
        if oe is None or not oe <= ne:
            out.append(f"{where}: enum narrowed")
    if "const" in new and new.get("const") != old.get("const"):
        out.append(f"{where}: const changed")
    for k in ("minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties"):
        if k in new and (k not in old or new[k] > old[k]):
            out.append(f"{where}: {k} tightened")
    for k in ("maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties"):
        if k in new and (k not in old or new[k] < old[k]):
            out.append(f"{where}: {k} tightened")
    for k in ("pattern", "format"):
        if k in new and new.get(k) != old.get(k):
            out.append(f"{where}: {k} changed")
    if isinstance(old.get("items"), dict) and isinstance(new.get("items"), dict):
        out.extend(breaking_changes(old["items"], new["items"], f"{path}/items"))
    return out


def schema_document(store, project_id: str, branch_id: str, i02_record: dict) -> tuple[dict, str]:
    """(json_schema, semantic schema_version) for a pinned I02 record; hash verified."""
    data = i02_record["data"]
    doc, _ = kr.read_state(store, project_id, branch_id, NS_I02_DOCS, data["schema_hash"])
    if doc is None or sha256_json(doc["json_schema"]) != data["schema_hash"]:
        raise BookforgeError("VALIDATOR_UNAVAILABLE", "/payload/schema_ref",
                             "stored schema document is missing or does not match schema_hash")
    reg, _ = kr.read_state(store, project_id, branch_id, NS_I02, data["schema_id"])
    semver = next((v for v, e in (reg or {}).get("versions", {}).items()
                   if e["record_id"] == i02_record["record_id"]), None)
    return doc["json_schema"], f"{data['schema_id']}@{semver or data['version']}"


@register("I02")
class SchemaManager(_DerivedProjection):
    """Versioned JSON Schemas. check_schema (Draft 2020-12) before storing; a breaking change
    needs a new major version; an existing version is never mutated (UPDATE is refused)."""

    def create(self, ctx: Context) -> Result:
        p = ctx.payload
        try:
            Draft202012Validator.check_schema(p["json_schema"])
        except SchemaError as exc:
            raise _rej("INVALID_INPUT", "/payload/json_schema" + json_pointer(exc.path),
                       f"not a valid Draft 2020-12 schema: {exc.message}")
        schema_hash = sha256_json(p["json_schema"])
        semver = p["semantic_version"]
        reg, rev = _state(ctx, NS_I02, p["schema_id"])
        reg = reg or {"versions": {}, "order": []}
        findings = []
        if semver in reg["versions"]:
            raise _rej("VERSION_CONFLICT", "/payload/semantic_version",
                       f"{p['schema_id']}@{semver} already exists and is immutable; register a new version")
        if reg["order"]:
            latest_v = max(reg["order"], key=_semver)
            if _semver(semver) <= _semver(latest_v):
                raise _rej("VERSION_CONFLICT", "/payload/semantic_version",
                           f"version must be greater than the latest {latest_v}")
            old_doc, _ = _state(ctx, NS_I02_DOCS, reg["versions"][latest_v]["schema_hash"])
            changes = breaking_changes((old_doc or {}).get("json_schema", {}), p["json_schema"])
            if (changes or p["compatibility_policy"] == "BREAKING") and _semver(semver)[0] <= _semver(latest_v)[0]:
                raise _rej("INVALID_INPUT", "/payload/semantic_version",
                           "breaking change requires a new major version"
                           + (f": {'; '.join(changes[:5])}" if changes else ""))
            if changes and p["compatibility_policy"] == "ADDITIVE":
                raise _rej("INVALID_INPUT", "/payload/compatibility_policy",
                           f"change is not additive: {'; '.join(changes[:5])}")
        record_id = ctx.allocate_record_id()
        version = len(reg["order"]) + 1
        reg["versions"][semver] = {"schema_hash": schema_hash, "record_id": record_id, "version": version,
                                   "compatibility_policy": p["compatibility_policy"]}
        reg["order"].append(semver)
        _put_state(ctx, NS_I02, p["schema_id"], reg, rev)
        _put_state(ctx, NS_I02_DOCS, schema_hash, {"json_schema": p["json_schema"]}, None)
        return Result(data={"schema_id": p["schema_id"], "schema_hash": schema_hash, "version": version},
                      record_id=record_id, findings=findings)

    def update(self, ctx: Context) -> Result:
        raise _rej("INVALID_INPUT", "/payload", "schema versions are immutable; CREATE a new semantic version")

    def validate(self, ctx: Context, record: dict) -> list[dict]:
        try:
            schema_document(ctx.store, ctx.project_id, ctx.branch_id, record)
        except BookforgeError as exc:
            return [ctx.finding("SCHEMA_DOCUMENT", exc.errors[0]["message"], severity="BLOCKING")]
        return []


# ======================================================================================
# I03 - Module Input/Output Registry
# ======================================================================================
@register("I03")
class IORegistry(OperationHandler):
    """Producer/consumer registrations. Both IDs exist; output_type must equal the producer's
    registered output type; feature/paths are typed. Registration details are kept in I-owned
    module state keyed by registration_id (the record ID) and bump the registry revision."""

    def create(self, ctx: Context) -> Result:
        p = ctx.payload
        ops = ctx.contracts.operations
        for f in ("producer", "consumer"):
            if p[f] not in ops:
                raise _rej("NOT_FOUND", f"/payload/{f}", f"unknown operation {p[f]}")
        expected = ops[p["producer"]]["output_type"]
        if p["output_type"] != expected:
            raise _rej("INVALID_INPUT", "/payload/output_type",
                       f"{p['producer']} produces {expected}, not {p['output_type']}")
        pred = p["dependency_predicate"]
        if pred["feature"] is not None and pred["feature"] not in FEATURES:
            raise _rej("INVALID_INPUT", "/payload/dependency_predicate/feature", "unknown feature predicate")
        for i, path in enumerate(pred["paths"]):
            if not _valid_pointer(path):
                raise _rej("INVALID_INPUT", f"/payload/dependency_predicate/paths/{i}", "paths are JSON Pointers")
        if pred["kind"] == "HARD" and pred["stage"] == "CREATE" and p["producer"] == p["consumer"]:
            raise _rej("DEPENDENCY_CYCLE", "/payload/dependency_predicate",
                       "a HARD CREATE self-dependency is a cycle", status="BLOCKED")
        findings = []
        declared = any(p["producer"] in b["allowed_producers"] for b in ctx.contracts.bindings(p["consumer"]))
        if not declared:
            findings.append(ctx.finding("UNDECLARED_BINDING", f"interface_registry declares no {p['consumer']} "
                                        f"field accepting {p['producer']}", severity="INFO", decision="PASS"))
        counter, crev = _state(ctx, NS_I03, "_registry")
        revision = (counter or {}).get("revision", 0) + 1
        record_id = ctx.allocate_record_id()
        _put_state(ctx, NS_I03, "_registry", {"revision": revision}, crev)
        _put_state(ctx, NS_I03, record_id, {
            "registration_id": record_id, "producer": p["producer"], "consumer": p["consumer"],
            "output_type": p["output_type"], "dependency_predicate": pred, "registry_revision": revision,
            "contract_version": p["contract_version"]}, 0)
        return Result(data={"registration_id": record_id, "revision": 1}, record_id=record_id, findings=findings)

    def update(self, ctx: Context) -> Result:
        base, data = ctx.base, dict(ctx.payload)
        if data["registration_id"] != base["data"]["registration_id"]:
            raise _rej("INVALID_INPUT", "/payload/registration_id", "registration_id is stable")
        if data["revision"] != base["version"] + 1:
            raise _rej("INVALID_INPUT", "/payload/revision", "revision must equal the new version")
        return Result(data=data, transform="MANUAL")

    def validate(self, ctx: Context, record: dict) -> list[dict]:
        if registration(ctx.store, ctx.project_id, ctx.branch_id, record["data"]["registration_id"]) is None:
            return [ctx.finding("REGISTRATION", "registration details missing", severity="BLOCKING")]
        return []


# ======================================================================================
# I04 - Required-Field Validator
# ======================================================================================
@register("I04")
class RequiredFieldValidator(_DerivedProjection):
    """Validate subject_payload against the exact pinned I02 schema; exact field violations.
    A non-null subject_ref must be the very content being validated (hash-bound)."""

    def create(self, ctx: Context) -> Result:
        p = ctx.payload
        schema_rec = ctx.field_record("schema_ref")
        doc, schema_version = schema_document(ctx.store, ctx.project_id, ctx.branch_id, schema_rec)
        subj = ctx.field_record("subject_ref")
        if subj is not None:
            if subj["representation"] == "BINARY_ARTIFACT":
                try:
                    staged = json.loads(ctx.binary(subj).decode("utf-8"))
                except (UnicodeDecodeError, ValueError):
                    raise _rej("INVALID_INPUT", "/payload/subject_ref", "binary subject is not UTF-8 JSON")
            else:
                staged = subj["data"]
            if canonical_bytes(staged) != canonical_bytes(p["subject_payload"]):
                raise _rej("HASH_MISMATCH", "/payload/subject_payload",
                           "subject_payload differs from the content pinned by subject_ref.content_hash")
        validator = Draft202012Validator(doc, format_checker=FormatChecker())
        violations = [{"code": e["code"], "path": e["path"], "message": e["message"]}
                      for e in schema_errors(validator, p["subject_payload"])]
        return Result(data={"valid": not violations, "violations": violations, "schema_version": schema_version})


# ======================================================================================
# I05 - Missing-Information Detector
# ======================================================================================
def missing_request(ctx: Context, i05_record: dict) -> dict | None:
    v, _ = _state(ctx, NS_I05, i05_record["data"]["dedupe_key"])
    return v


@register("I05")
class MissingInfoDetector(OperationHandler):
    """One open request per (project, branch, subject revision, path, required_by)."""

    def create(self, ctx: Context) -> Result:
        p = ctx.payload
        subj = ctx.field_record("subject_ref")
        if not _valid_pointer(p["field_path"]):
            raise _rej("INVALID_INPUT", "/payload/field_path", "field_path is a JSON Pointer")
        if p["blocking_class"] == "STRUCTURAL" and subj["data"] is not None:
            try:
                present = resolve_pointer(subj["data"], p["field_path"])
            except (KeyError, IndexError, ValueError):
                present = None
            if present is not None:
                raise _rej("INVALID_INPUT", "/payload/field_path",
                           "the field is present in the pinned subject; nothing is missing")
        dedupe_key = sha256_json([ctx.project_id, ctx.branch_id, subj["record_id"], subj["version"],
                                  p["field_path"], p["required_by"]])
        existing, rev = _state(ctx, NS_I05, dedupe_key)
        if existing and existing["status"] == "OPEN":
            f = ctx.finding("DEDUPED", f"open request {existing['request_id']} already covers this field",
                            severity="INFO", decision="PASS")
            return Result(data={"request_id": existing["request_id"], "dedupe_key": dedupe_key,
                                "status": "DUPLICATE"}, findings=[f])
        record_id = ctx.allocate_record_id()
        _put_state(ctx, NS_I05, dedupe_key, {
            "request_id": record_id, "dedupe_key": dedupe_key, "subject_ref": subj["ref"],
            "field_path": p["field_path"], "required_by": p["required_by"], "blocking_class": p["blocking_class"],
            "status": "OPEN"}, rev)
        return Result(data={"request_id": record_id, "dedupe_key": dedupe_key, "status": "OPEN"},
                      record_id=record_id)

    def update(self, ctx: Context) -> Result:
        base, data = ctx.base["data"], dict(ctx.payload)
        for k in ("request_id", "dedupe_key"):
            if data[k] != base[k]:
                raise _rej("INVALID_INPUT", f"/payload/{k}", f"{k} is stable")
        if data["status"] not in ("OPEN", "RESOLVED", "WITHDRAWN", "DUPLICATE"):
            raise _rej("INVALID_INPUT", "/payload/status", "status is OPEN, RESOLVED, WITHDRAWN or DUPLICATE")
        st, rev = _state(ctx, NS_I05, data["dedupe_key"])
        if st and st["request_id"] == data["request_id"] and data["status"] != "DUPLICATE":
            _put_state(ctx, NS_I05, data["dedupe_key"], dict(st, status=data["status"]), rev)
        return Result(data=data, transform="MANUAL")


# ======================================================================================
# I06 - Context Retriever
# ======================================================================================
CURSOR_PREFIX = "i06c1."


@register("I06")
class ContextRetriever(_DerivedProjection):
    """Authorized literal search. Results are pinned, ordered by record ID then version;
    the opaque cursor is bound to the first page's result snapshot (stored durably)."""

    def create(self, ctx: Context) -> Result:
        p = ctx.payload
        if p["branch_id"] != ctx.branch_id:
            raise _rej("INVALID_INPUT", "/payload/branch_id", "cross-branch retrieval needs an explicit copy/merge "
                       "proposal; search the request branch")
        query_hash = sha256_json({"query": p["query"], "policy": p["source_version_policy"], "branch": p["branch_id"]})
        if p.get("cursor"):
            snap_id, offset = self._parse_cursor(p["cursor"])
            snap, _ = _state(ctx, "I06.cursors", snap_id)
            if snap is None or snap["query_hash"] != query_hash or snap["principal_id"] != ctx.principal_id:
                raise _rej("INVALID_INPUT", "/payload/cursor", "cursor is not valid for this query")
            matches = snap["refs"]
        else:
            matches, offset, snap_id = self._search(ctx, p), 0, None
        page = matches[offset:offset + p["limit"]]
        next_cursor = None
        if offset + p["limit"] < len(matches):
            if snap_id is None:
                snap_id = sha256_json({"q": query_hash, "refs": matches, "principal": ctx.principal_id})[:32]
                existing, rev = _state(ctx, "I06.cursors", snap_id)
                if existing is None:
                    _put_state(ctx, "I06.cursors", snap_id, {"query_hash": query_hash, "refs": matches,
                                                             "principal_id": ctx.principal_id}, rev)
            next_cursor = f"{CURSOR_PREFIX}{snap_id}.{offset + p['limit']}"
        return Result(data={"records": page, "next_cursor": next_cursor, "source_refs": page})

    @staticmethod
    def _parse_cursor(cursor: str) -> tuple[str, int]:
        try:
            if not cursor.startswith(CURSOR_PREFIX):
                raise ValueError
            snap_id, offset = cursor[len(CURSOR_PREFIX):].split(".")
            return snap_id, int(offset)
        except ValueError:
            raise _rej("INVALID_INPUT", "/payload/cursor", "malformed cursor")

    def _search(self, ctx: Context, p: dict) -> list[dict]:
        q = p["query"]
        text = q["text"].casefold()
        ids, owners, preds = set(q["record_ids"]), set(q["owner_operations"]), set(q["predicates"])
        scopes = ctx.store.scopes_for(ctx.principal_id, ctx.project_id, ctx.branch_id)
        out = []
        for rec in ctx.store.list_records(ctx.project_id, ctx.branch_id):
            if rec["representation"] != "JSON_RECORD":
                continue
            mod = rec["module_id"]
            if not (scopes & {f"{mod}:read", f"{mod}:*", f"{mod[0]}*:*", "*"}):
                continue  # unauthorized records are invisible
            if ids and rec["record_id"] not in ids:
                continue
            if owners and mod not in owners:
                continue
            if p["source_version_policy"] == "CURRENT_APPROVED":
                if not rec["approved_version"]:
                    continue
                if rec["approved_version"] != rec["version"]:
                    rec = ctx.store.get_record(ctx.project_id, ctx.branch_id, rec["record_id"],
                                               rec["approved_version"])
            if preds and not preds <= _predicates(rec["data"]):
                continue
            if text and not any(text in t.casefold() for t in _search_texts(rec["data"])):
                continue
            out.append(rec["ref"])
        out.sort(key=lambda r: (r["record_id"], r["version"]))
        return out


# ======================================================================================
# I07 - Context Package Builder
# ======================================================================================
def record_tokens(rec: dict) -> int:
    body = rec["data"] if rec["representation"] == "JSON_RECORD" else rec.get("binary")
    return estimate_tokens(canonical_bytes({"ref": rec["ref"], "data": body}).decode("utf-8"))


def _words(rec: dict) -> set[str]:
    return {w for t in _texts(rec.get("data")) for w in re.findall(r"\w{3,}", t.casefold())}


@register("I07")
class ContextPackageBuilder(_DerivedProjection):
    """Required and protected (LOCKED) facts first and never truncated; optional retrieval
    by relevance (shared terms with the task) then stable ID until the token budget is used."""

    def create(self, ctx: Context) -> Result:
        p = ctx.payload
        task = ctx.field_record("task_ref")
        required = ctx.field_records("required_facts")
        retrieved = ctx.field_records("retrieval_refs")
        seen, mandatory, optional = set(), [], []
        for rec in required + [r for r in retrieved if r["lifecycle"] == "LOCKED"]:
            k = (rec["record_id"], rec["version"])
            if k not in seen:
                seen.add(k)
                mandatory.append(rec)
        for rec in retrieved:
            k = (rec["record_id"], rec["version"])
            if k not in seen:
                seen.add(k)
                optional.append(rec)
        used = sum(record_tokens(r) for r in mandatory)
        if used > p["token_budget"]:
            raise BookforgeError("CONTEXT_TOO_LARGE", "/payload/token_budget",
                                 f"required/protected facts need ~{used} tokens > budget {p['token_budget']}; "
                                 "split the job on scene/pass boundaries (mandatory facts are never dropped)")
        task_words = _words(task)
        task_links = {(r["record_id"], r["version"]) for _, r in iter_references(task.get("data") or {})}

        def relevance(rec):
            score = len(task_words & _words(rec))
            if (rec["record_id"], rec["version"]) in task_links:
                score += 1000
            return score

        optional.sort(key=lambda r: (-relevance(r), r["record_id"], r["version"]))
        included, omitted = [r["ref"] for r in mandatory], []
        for rec in optional:
            cost = record_tokens(rec)
            if used + cost <= p["token_budget"]:
                used += cost
                included.append(rec["ref"])
            else:
                omitted.append(rec["ref"])
        record_id = ctx.allocate_record_id()
        _put_state(ctx, NS_I07, record_id, {"mandatory": [r["ref"] for r in mandatory]}, 0)
        return Result(data={"included": included, "omitted": omitted, "source_pins": [task["ref"]] + included,
                            "budget_used": used}, record_id=record_id)


# ======================================================================================
# I08 - Missing-Information Router
# ======================================================================================
@register("I08")
class MissingInfoRouter(OperationHandler):
    """Route one missing request to the operation owning its subject. The outbox event ID is
    derived from the request dedupe key, so duplicate routing delivers one event."""

    def create(self, ctx: Context) -> Result:
        p = ctx.payload
        mrec = ctx.field_record("missing_request_ref")
        if kr.parse_time(p["deadline"]) <= kr.now():
            raise _rej("INVALID_INPUT", "/payload/deadline", "deadline already passed")
        st = missing_request(ctx, mrec)
        if st is None:
            f = ctx.finding("UNKNOWN_OWNER", "request has no declared owner; held for user input",
                            severity="MAJOR", decision="UNKNOWN")
            return Result(data={"route_id": f"route-{mrec['data']['dedupe_key'][:40]}",
                                "delivery_state": "HELD_FOR_USER", "attempts": []}, findings=[f],
                          unresolved=[f"{mrec['record_id']}:owner"])
        if st["status"] != "OPEN":
            raise _rej("INVALID_INPUT", "/payload/missing_request_ref", f"request is {st['status']}")
        owner_op = st["subject_ref"]["module_id"]
        if p["target_owner"] != owner_op[0]:
            raise _rej("INVALID_INPUT", "/payload/target_owner",
                       f"declared owner of {st['field_path']} is {owner_op} (set {owner_op[0]})")
        event_id = f"route-{st['dedupe_key'][:40]}"
        event = {"missing_request_id": st["request_id"], "dedupe_key": st["dedupe_key"],
                 "owning_operation": owner_op, "subject_ref": st["subject_ref"], "field_path": st["field_path"],
                 "required_by": st["required_by"], "blocking_class": st["blocking_class"]}
        pid, bid = ctx.project_id, ctx.branch_id
        ctx.on_commit(lambda tx: tx.insert_outbox(pid, bid, "missing_info.routed", event, event_id=event_id))
        return Result(data={"route_id": event_id, "delivery_state": "ROUTED",
                            "attempts": [f"{owner_op}:{event_id}"]})

    def update(self, ctx: Context) -> Result:
        base, data = ctx.base["data"], dict(ctx.payload)
        if data["route_id"] != base["route_id"]:
            raise _rej("INVALID_INPUT", "/payload/route_id", "route_id is stable")
        if data["attempts"][:len(base["attempts"])] != base["attempts"]:
            raise _rej("INVALID_INPUT", "/payload/attempts", "attempt history is append-only")
        return Result(data=data, transform="MANUAL")


# ======================================================================================
# I09 - Backup Completion Engine (creative fallback candidate; NOT data backups)
# ======================================================================================
@register("I09")
class BackupCompletion(OperationHandler):
    """Store a labeled fallback candidate (value + evidence + confidence) for one open missing
    request. It never approves itself: ACCEPT needs a separate I10/K09 approval."""

    def create(self, ctx: Context) -> Result:
        p = ctx.payload
        mrec = ctx.field_record("missing_request_ref")
        st = missing_request(ctx, mrec)
        if st is None:
            raise BookforgeError("MISSING_INPUT", "/payload/missing_request_ref", "unknown missing request")
        if st["status"] != "OPEN":
            raise _rej("INVALID_INPUT", "/payload/missing_request_ref", f"request is {st['status']}")
        facts = p["candidate_value"]["facts"]
        if not p["evidence_refs"] and not any(f["source_refs"] for f in facts):
            raise BookforgeError("MISSING_INPUT", "/payload/evidence_refs",
                                 "a fallback candidate must cite evidence")
        for i, f in enumerate(facts):
            if f["effective_from"] is not None and f["effective_to"] is not None \
                    and f["effective_to"] <= f["effective_from"]:
                raise _rej("INVALID_INPUT", f"/payload/candidate_value/facts/{i}/effective_to",
                           "effective interval must satisfy to > from")
        cand = {"label": "FALLBACK_CANDIDATE", "missing_request_id": st["request_id"],
                "field_path": st["field_path"], "subject_ref": st["subject_ref"],
                "candidate_value": p["candidate_value"], "evidence_refs": p["evidence_refs"],
                "confidence": p["confidence"], "proposed_by": ctx.principal_id}
        cref = ctx.stage_json("I09", cand, record_kind="FallbackCandidate", source_refs=p["evidence_refs"])
        f = ctx.finding("FALLBACK_LABEL", "fallback candidate; not canon until separately approved",
                        severity="INFO", decision="PASS", confidence=p["confidence"])
        return Result(data={"candidate_id": cref["record_id"], "approval_state": "UNAPPROVED_FALLBACK"},
                      findings=[f], source_refs=[cref])

    def update(self, ctx: Context) -> Result:
        data = dict(ctx.payload)
        if data["candidate_id"] != ctx.base["data"]["candidate_id"]:
            raise _rej("INVALID_INPUT", "/payload/candidate_id", "candidate_id is stable")
        if data["approval_state"] in ("APPROVED", "LOCKED"):
            raise _rej("APPROVAL_REQUIRED", "/payload/approval_state",
                       "a fallback candidate cannot approve itself; use I10/K09", status="BLOCKED")
        return Result(data=data, transform="MANUAL")

    def requires_explicit_approval(self, ctx, record) -> bool:
        return True

    def accept_gate(self, ctx, record, approval) -> list[dict]:
        if approval is None or approval["source"]["module_id"] not in ("I10", "K09"):
            return [ctx.finding("SELF_APPROVAL", "fallback candidates need an I10/K09 approval",
                                severity="BLOCKING")]
        return []


# ======================================================================================
# I10 - Canon Approval/Lock Manager
# ======================================================================================
@register("I10")
class ApprovalLockManager(_DerivedProjection):
    """APPROVE/REJECT/LOCK/UNLOCK/SUPERSEDE decisions on an exact candidate revision.

    The approver is the authenticated principal and must already hold the owner's accept
    scope (no self-escalation); approval records cannot approve approval records. UNLOCK and
    SUPERSEDE need a current K09 authorization that binds the exact candidate pin. LOCK/
    REJECT/SUPERSEDE stage the lifecycle change in the same commit; UNLOCK issues a
    protected-change authorization the kernel honours for the next UPDATE."""

    TRANSITIONS = {"APPROVE": ("VALIDATED",), "REJECT": ("DRAFT", "VALIDATED"), "LOCK": ("APPROVED",),
                   "UNLOCK": ("LOCKED",), "SUPERSEDE": ("APPROVED", "LOCKED")}

    def create(self, ctx: Context) -> Result:
        p = ctx.payload
        cand = ctx.field_record("candidate_ref")
        mod, decision = cand["module_id"], p["decision"]
        if p["approver_id"] != ctx.principal_id:
            raise _rej("PERMISSION_DENIED", "/payload/approver_id", "approver must be the authenticated principal")
        if mod == "I10":
            raise _rej("INVALID_INPUT", "/payload/candidate_ref/module_id",
                       "approval records cannot approve approval records (self-escalation)")
        if not ctx.store.has_scope(ctx.principal_id, ctx.project_id, ctx.branch_id, f"{mod}:accept"):
            raise _rej("PERMISSION_DENIED", "/payload/approver_id",
                       f"approver lacks {mod}:accept; authority cannot be self-escalated")
        if cand["lifecycle"] not in self.TRANSITIONS[decision]:
            raise _rej("INVALID_INPUT", "/payload/decision",
                       f"{decision} is not allowed from {cand['lifecycle']}")
        if cand["stale"] and decision in ("APPROVE", "LOCK"):
            raise _rej("VERSION_CONFLICT", "/payload/candidate_ref", "candidate is stale; revalidate first")
        if decision == "APPROVE" and cand["version"] != cand["latest_version"]:
            raise _rej("VERSION_CONFLICT", "/payload/candidate_ref", "a newer revision exists")
        if decision == "LOCK" and cand["approved_version"] != cand["version"]:
            raise _rej("INVALID_INPUT", "/payload/candidate_ref", "only the approved head can be locked")
        auth = ctx.field_record("authorization_ref")
        prior_locked = False
        if decision == "APPROVE" and cand["approved_version"]:
            prev = ctx.store.get_record(ctx.project_id, ctx.branch_id, cand["record_id"], cand["approved_version"])
            prior_locked = prev is not None and prev["lifecycle"] == "LOCKED"
        needs_auth = decision in ("UNLOCK", "SUPERSEDE") or prior_locked
        expires = kr.iso(kr.now() + timedelta(days=3650))
        if auth is not None:
            kr.check_k09_authorization(ctx.store, auth, cand["ref"], "/payload/authorization_ref")
            expires = auth["data"]["expiry"]
        elif needs_auth:
            raise BookforgeError("APPROVAL_REQUIRED", "/payload/authorization_ref",
                                 f"{decision} of protected content needs a K09 authorization for this revision",
                                 unresolved=[f"K09:{cand['record_id']}@{cand['version']}"])
        if decision == "SUPERSEDE":
            latest = ctx.store.get_record(ctx.project_id, ctx.branch_id, cand["record_id"])
            if latest["version"] <= cand["version"] or latest["lifecycle"] not in ("VALIDATED", "APPROVED"):
                raise _rej("INVALID_INPUT", "/payload/candidate_ref",
                           "SUPERSEDE needs a newer validated revision", status="BLOCKED")
        scope = {"APPROVE": "accept", "REJECT": "reject", "LOCK": "lock", "UNLOCK": "protected_change",
                 "SUPERSEDE": "supersede"}[decision]
        approval = {
            "approval_id": kr.new_id("appr"), "subject_ref": cand["ref"],
            "action_hash": sha256_json({"decision": decision, "subject": cand["ref"], "reason": p["reason"]}),
            "policy_ref": auth["ref"] if auth else cand["ref"], "approver_id": ctx.principal_id,
            "scopes": [f"{mod}:{scope}"], "source_refs": list(cand["source_refs"]),
            "issued_at": kr.iso(kr.now()), "expires_at": expires, "revoked": False,
            "decision": "REJECTED" if decision == "REJECT" else "APPROVED", "evidence_origin": ctx.evidence_origin}
        ref, pid, bid = cand["ref"], ctx.project_id, ctx.branch_id
        if decision == "LOCK":
            ctx.on_commit(lambda tx: tx.set_lifecycle(ref, "LOCKED"))
        elif decision == "REJECT":
            ctx.on_commit(lambda tx: tx.set_lifecycle(ref, "REJECTED"))
        elif decision == "SUPERSEDE":
            ctx.on_commit(lambda tx: tx.set_lifecycle(ref, "SUPERSEDED"))
        elif decision == "UNLOCK":
            ctx.on_commit(lambda tx: tx.insert_approval(approval, pid, bid))
        return Result(data={"approval": approval,
                            "locked_revision": cand["version"] if decision == "LOCK" else None})


# ======================================================================================
# I11 - Version/Change History
# ======================================================================================
@register("I11")
class ChangeHistory(_DerivedProjection):
    """Immutable revision diffs (changed JSON Pointers per step) plus audit events from storage."""

    def create(self, ctx: Context) -> Result:
        p = ctx.payload
        ent = ctx.field_record("entity_ref")
        frm, to = p["from_revision"], p["to_revision"]
        if frm > to:
            raise _rej("INVALID_INPUT", "/payload/to_revision", "to_revision must be >= from_revision")
        hist = {r["version"]: r for r in ctx.store.history(ctx.project_id, ctx.branch_id, ent["record_id"])}
        for name, v in (("from_revision", frm), ("to_revision", to)):
            if v not in hist:
                raise _rej("NOT_FOUND", f"/payload/{name}", f"revision {v} does not exist")
        diff = []
        for v in range(frm, to):
            old, new = hist[v], hist[v + 1]
            diff.append(f"v{v}->v{v + 1} content_hash {old['content_hash']} -> {new['content_hash']}")
            for ptr in changed_pointers(old["data"], new["data"]):
                kind = "CHANGE"
                try:
                    resolve_pointer(old["data"], ptr)
                except (KeyError, IndexError, ValueError):
                    kind = "ADD"
                try:
                    resolve_pointer(new["data"], ptr)
                except (KeyError, IndexError, ValueError):
                    kind = "REMOVE"
                diff.append(f"v{v}->v{v + 1} {kind} {ptr or '/'}")
            if old["source_refs"] != new["source_refs"]:
                diff.append(f"v{v}->v{v + 1} CHANGE source_refs")
        rid = ent["record_id"]
        rows = ctx.store.query("SELECT * FROM audit WHERE project_id=? AND branch_id=? AND "
                               "(output_refs LIKE ? OR input_refs LIKE ?) ORDER BY recorded_at, audit_id",
                               (ctx.project_id, ctx.branch_id, f"%{rid}%", f"%{rid}%"))
        events = []
        for row in rows:
            refs = json.loads(row["output_refs"]) + json.loads(row["input_refs"])
            versions = sorted({r["version"] for r in refs if r.get("record_id") == rid and frm <= r["version"] <= to})
            if versions:
                events.append(f"{row['audit_id']} {row['recorded_at']} {row['operation_id']} {row['action']} "
                              f"{row['outcome']} {row['evidence_type']} v{','.join(map(str, versions))}")
        return Result(data={"diff": diff, "audit_events": events})


# ======================================================================================
# I12 - Module Completion Tracker
# ======================================================================================
def _audit_row_dict(row) -> dict:
    return {k: row[k] for k in row.keys()}


@register("I12")
class CompletionTracker(_DerivedProjection):
    """Completion is projected only from storage evidence: the commit audit + idempotency
    receipt (COMMITTED_OUTPUT) or an audited READ/VALIDATE receipt, plus validation and
    approval pins. A worker's claim is never evidence."""

    def create(self, ctx: Context) -> Result:
        p = ctx.payload
        reg_rec = ctx.field_record("operation_ref")
        reg = registration(ctx.store, ctx.project_id, ctx.branch_id, reg_rec["data"]["registration_id"])
        if reg is None:
            raise BookforgeError("MISSING_INPUT", "/payload/operation_ref", "registration details are missing")
        ev_rec = ctx.field_record("evidence_ref")
        if ev_rec["module_id"] != reg["producer"]:
            raise _rej("INVALID_INPUT", "/payload/evidence_ref/module_id",
                       f"evidence must be a {reg['producer']} output for this registration")
        unmet, stale = self._requirements(ctx)
        if p["evidence_type"] == "COMMITTED_OUTPUT":
            evidence, ok, ev_stale, extra = self._committed(ctx, ev_rec)
        else:
            evidence, ok, ev_stale, extra = self._audited(ctx, ev_rec, reg_rec, p["evidence_type"])
        if stale or ev_stale:
            state = "STALE"
        elif ok and not unmet:
            state = "COMPLETE"
        else:
            state = "BLOCKED"
            if not ok:
                unmet = unmet + [ev_rec["ref"]]
        findings = []
        if evidence["evidence_origin"] == "FIXTURE":
            findings.append(ctx.finding("FIXTURE_ORIGIN", "fixture-origin evidence cannot satisfy production "
                                        "approval", severity="MAJOR", decision="UNKNOWN"))
        return Result(data={"completion_state": state, "unmet_requirements": unmet, "evidence": evidence},
                      findings=findings, source_refs=extra)

    def _requirements(self, ctx: Context) -> tuple[list, bool]:
        unmet, stale = [], False
        for rec in ctx.field_records("requirements"):
            if rec["stale"] or rec["lifecycle"] == "SUPERSEDED":
                stale = True
                unmet.append(rec["ref"])
            elif rec["lifecycle"] not in ("APPROVED", "LOCKED") or rec["approved_version"] != rec["version"]:
                unmet.append(rec["ref"])
        return unmet, stale

    def _committed(self, ctx: Context, rec: dict):
        rid = rec["record_id"]
        rows = ctx.store.query("SELECT * FROM audit WHERE project_id=? AND branch_id=? AND "
                               "evidence_type='COMMITTED_OUTPUT' AND action IN ('CREATE','UPDATE') AND "
                               "output_refs LIKE ? ORDER BY recorded_at, audit_id",
                               (ctx.project_id, ctx.branch_id, f"%{rid}%"))
        audit = None
        for row in rows:
            if any(_rkey(r) == _rkey(rec["ref"]) for r in json.loads(row["output_refs"])):
                audit = row
                break
        receipt = None
        if audit is not None:
            for r in ctx.store.query("SELECT * FROM receipts WHERE project_id=? AND branch_id=? AND "
                                     "target_operation=? AND response LIKE ?",
                                     (ctx.project_id, ctx.branch_id, audit["operation_id"], f"%{rid}%")):
                resp = json.loads(r["response"])
                if resp.get("request_id") == audit["request_id"] and any(
                        _rkey(x) == _rkey(rec["ref"]) for x in resp.get("output_refs", [])):
                    receipt = r
                    break
        if audit is None or receipt is None:
            raise BookforgeError("MISSING_INPUT", "/payload/evidence_ref",
                                 "no durable commit receipt for this output pin; a worker's success claim is not "
                                 "evidence", unresolved=[f"commit:{rid}@{rec['version']}"])
        audit_ref = ctx.stage_json("I12", {"evidence_type": "COMMITTED_OUTPUT", "audit": _audit_row_dict(audit),
                                           "receipt_id": receipt["receipt_id"]}, record_kind="AuditReport")
        validation_ref, validated = rec["ref"], rec["lifecycle"] in ("VALIDATED", "APPROVED", "LOCKED")
        for v in ctx.store.list_records(ctx.project_id, ctx.branch_id, module_id="I04"):
            if v["data"] and v["data"].get("valid") and any(_rkey(s) == _rkey(rec["ref"]) for s in v["source_refs"]):
                validation_ref, validated = v["ref"], True
                break
        approvals = []
        for a in ctx.store.list_records(ctx.project_id, ctx.branch_id, module_id="I10"):
            body = (a["data"] or {}).get("approval") or {}
            if body.get("decision") == "APPROVED" and _rkey(body.get("subject_ref", {"record_id": None, "version": 0,
                                                                                      "content_hash": None})) == _rkey(rec["ref"]):
                approvals.append(a["ref"])
        evidence = {"receipt_id": receipt["receipt_id"], "operation_id": audit["operation_id"],
                    "request_id": audit["request_id"], "attempt_id": audit["attempt_id"], "output_ref": rec["ref"],
                    "input_refs": json.loads(audit["input_refs"]), "validation_ref": validation_ref,
                    "approval_refs": approvals, "audit_ref": audit_ref,
                    "committed_at": audit["recorded_at"], "evidence_origin": audit["evidence_origin"]}
        ev_stale = rec["stale"] or rec["lifecycle"] in ("SUPERSEDED", "REJECTED")
        return evidence, validated, ev_stale, [audit_ref]

    def _audited(self, ctx: Context, rec: dict, reg_rec: dict, evidence_type: str):
        rid = rec["record_id"]
        rows = ctx.store.query("SELECT * FROM audit WHERE project_id=? AND branch_id=? AND evidence_type=? AND "
                               "operation_id=? AND input_refs LIKE ? ORDER BY recorded_at DESC, audit_id DESC",
                               (ctx.project_id, ctx.branch_id, evidence_type, rec["module_id"], f"%{rid}%"))
        audit = next((r for r in rows if any(_rkey(x) == _rkey(rec["ref"]) for x in json.loads(r["input_refs"]))),
                     None)
        if audit is None:
            raise BookforgeError("MISSING_INPUT", "/payload/evidence_ref",
                                 f"no {evidence_type} audit receipt for this pin")
        outcome = {"SUCCESS": "SUCCESS", "REJECTED": "REJECTED"}.get(audit["outcome"], "BLOCKED")
        evidence = {"evidence_type": evidence_type, "request_id": audit["request_id"],
                    "operation_id": audit["operation_id"], "principal_id": audit["principal_id"],
                    "input_refs": json.loads(audit["input_refs"]), "outcome": outcome,
                    "schema_version": audit["schema_version"], "policy_ref": reg_rec["ref"],
                    "recorded_at": audit["recorded_at"], "evidence_origin": audit["evidence_origin"]}
        return evidence, outcome == "SUCCESS", bool(rec["stale"]), []

    def validate(self, ctx: Context, record: dict) -> list[dict]:
        ev = record["data"]["evidence"]
        out_ref = ev.get("output_ref")
        if out_ref:
            cur = ctx.store.get_record(ctx.project_id, ctx.branch_id, out_ref["record_id"], out_ref["version"])
            if cur is None or cur["stale"] or cur["lifecycle"] in ("SUPERSEDED", "REJECTED"):
                return [ctx.finding("STALE_EVIDENCE", "evidence output no longer current", severity="BLOCKING",
                                    decision="UNKNOWN")]
        return []


# ======================================================================================
# I13 - Dependency Tracker
# ======================================================================================
@register("I13")
class DependencyTracker(_DerivedProjection):
    """Typed dependency edge {producer_ref, consumer, paths, kind, stage} in the kernel edge table.
    HARD CREATE edges may not close a cycle. If the source already has a newer revision whose
    changes overlap the read paths, the target is marked stale immediately."""

    def create(self, ctx: Context) -> Result:
        p = ctx.payload
        src, tgt = ctx.field_record("source_ref"), ctx.field_record("target_ref")
        pred = p["predicate"]
        if src["record_id"] == tgt["record_id"]:
            raise _rej("INVALID_INPUT", "/payload/target_ref", "a record cannot depend on itself")
        findings = []
        for i, path in enumerate(pred["paths"]):
            if not _valid_pointer(path):
                raise _rej("INVALID_INPUT", f"/payload/predicate/paths/{i}", "paths are JSON Pointers")
            if src["data"] is not None and path:
                try:
                    resolve_pointer(src["data"], path)
                except (KeyError, IndexError, ValueError):
                    findings.append(ctx.finding("PATH_ABSENT", f"{path} is absent in the pinned source",
                                                severity="MINOR", decision="UNKNOWN"))
        if pred["kind"] == "HARD" and pred["stage"] == "CREATE":
            cycle = self._cycle(ctx, src["record_id"], tgt["record_id"])
            if cycle:
                raise BookforgeError("DEPENDENCY_CYCLE", "/payload/predicate",
                                     "HARD edge closes a cycle: " + " -> ".join(cycle))
        paths = pred["paths"] or [""]
        invalidated = []
        latest = ctx.store.get_record(ctx.project_id, ctx.branch_id, src["record_id"])
        if latest["version"] > src["version"]:
            changes = changed_pointers(src["data"], latest["data"])
            if any(pointers_overlap(c, rp) for c in changes for rp in paths):
                invalidated.append(f"{tgt['record_id']}@{tgt['version']}")
        edge_id = kr.new_id("edge")
        pid, bid = ctx.project_id, ctx.branch_id
        sref, tref = src["ref"], tgt["ref"]
        reason = f"input {src['module_id']}:{src['record_id']} v{src['version']} superseded by v{latest['version']}"

        def commit(tx):
            tx.execute("INSERT INTO dependency_edges VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (edge_id, pid, bid, sref["record_id"], sref["version"], sref["module_id"], tref["module_id"],
                        tref["record_id"], tref["version"], json.dumps(paths), pred["kind"], pred["stage"],
                        kr.utcnow()))
            if invalidated:
                tx.mark_stale(pid, bid, tref["record_id"], tref["version"], reason)
        ctx.on_commit(commit)
        return Result(data={"edge_id": edge_id, "invalidated_targets": invalidated}, findings=findings)

    @staticmethod
    def _cycle(ctx: Context, source_id: str, target_id: str) -> list[str] | None:
        """Path target ->* source over existing HARD CREATE edges (adding source->target closes it)."""
        rows = ctx.store.query("SELECT producer_record_id, consumer_record_id FROM dependency_edges WHERE "
                               "project_id=? AND branch_id=? AND kind='HARD' AND stage='CREATE'",
                               (ctx.project_id, ctx.branch_id))
        adj: dict[str, list[str]] = {}
        for r in rows:
            adj.setdefault(r["producer_record_id"], []).append(r["consumer_record_id"])
        stack, parent = [target_id], {target_id: None}
        while stack:
            n = stack.pop()
            if n == source_id:
                path = [n]
                while parent[path[-1]] is not None:
                    path.append(parent[path[-1]])
                return [source_id] + list(reversed(path))
            for m in sorted(adj.get(n, [])):
                if m not in parent:
                    parent[m] = n
                    stack.append(m)
        return None


# ======================================================================================
# I14 - Data Provenance
# ======================================================================================
@register("I14")
class DataProvenance(_DerivedProjection):
    """Provenance chain checked against stored provenance; chain_hash binds artifact, sources,
    transforms, decisions and the parents' recorded chain hashes."""

    def create(self, ctx: Context) -> Result:
        p = ctx.payload
        art = ctx.field_record("artifact_ref")
        prov = ctx.store.query_one("SELECT * FROM provenance WHERE project_id=? AND branch_id=? AND record_id=? "
                                   "AND version=?", (ctx.project_id, ctx.branch_id, art["record_id"], art["version"]))
        if prov is None:
            raise BookforgeError("MISSING_INPUT", "/payload/artifact_ref", "no stored provenance for this pin")
        chain = p["transform_chain"]
        if not chain:
            raise BookforgeError("MISSING_INPUT", "/payload/transform_chain", "transform chain is empty")
        last = chain[-1]
        if last["operation"] != prov["operation_id"] or last["attempt_id"] != prov["attempt_id"]:
            raise _rej("INVALID_INPUT", f"/payload/transform_chain/{len(chain) - 1}",
                       f"final transform must be {prov['operation_id']} attempt {prov['attempt_id']} (stored)")
        stored = {_rkey(r) for r in art["source_refs"]} | {_rkey(r) for r in json.loads(prov["input_refs"])}
        for i, rec in enumerate(ctx.field_records("source_refs")):
            if _rkey(rec["ref"]) not in stored:
                raise _rej("INVALID_INPUT", f"/payload/source_refs/{i}", "not an input of the stored artifact")
        findings = []
        supplied = {_rkey(r) for r in p["source_refs"]}
        if stored - supplied:
            findings.append(ctx.finding("SOURCES_OMITTED", f"{len(stored - supplied)} stored input pin(s) omitted",
                                        severity="MAJOR", decision="FAIL"))
        for i, rec in enumerate(ctx.field_records("decision_refs")):
            if rec["module_id"] not in ("I10", "K09") and rec["owner"] != "J":
                raise _rej("INVALID_INPUT", f"/payload/decision_refs/{i}", "decisions are I10/K09/J records")
        parents = []
        for r in p["source_refs"]:
            v, _ = _state(ctx, NS_I14, f"{r['record_id']}@{r['version']}")
            if v:
                parents.append(v["chain_hash"])
        chain_hash = sha256_json({"artifact": art["ref"], "provenance_id": prov["provenance_id"],
                                  "sources": sorted(p["source_refs"], key=lambda r: (r["record_id"], r["version"])),
                                  "transform_chain": chain, "decisions": p["decision_refs"],
                                  "parents": sorted(parents), "transform": prov["transform"]})
        key = f"{art['record_id']}@{art['version']}"
        _, rev = _state(ctx, NS_I14, key)
        _put_state(ctx, NS_I14, key, {"chain_hash": chain_hash}, rev)
        return Result(data={"provenance_id": prov["provenance_id"], "chain_hash": chain_hash}, findings=findings)


# ======================================================================================
# I15 - Context Compression
# ======================================================================================
def _first_sentence(text: str, limit: int = 200) -> str:
    text = " ".join(text.split())
    m = re.match(r"(.+?[.!?])(\s|$)", text)
    s = m.group(1) if m else text
    return s if len(s) <= limit else s[:limit - 1] + "…"


@register("I15")
class ContextCompression(_DerivedProjection):
    """Deterministic extractive compression: protected facts verbatim (canonical JSON), optional
    records reduced to a cited first sentence of their description, then omitted when over budget.
    Mandatory content over max_tokens blocks CONTEXT_TOO_LARGE; nothing protected is dropped."""

    def create(self, ctx: Context) -> Result:
        p = ctx.payload
        pkg = ctx.field_record("context_package_ref")
        protected = list(ctx.field_records("protected_fact_refs"))
        if pkg["module_id"] == "I07":
            st, _ = _state(ctx, NS_I07, pkg["record_id"])
            item_refs = pkg["data"]["included"]
            mandatory_keys = {_rkey(r) for r in (st or {}).get("mandatory", [])}
        else:
            item_refs = [r for _, r in iter_references(pkg["data"] or {})]
            mandatory_keys = set()
        prot_keys = {_rkey(r["ref"]) for r in protected}
        for r in item_refs:
            k = _rkey(r)
            if k in mandatory_keys and k not in prot_keys:
                protected.append(ctx.record(r))
                prot_keys.add(k)
        lines = [f"[CONTEXT {pkg['module_id']}:{pkg['record_id']}@v{pkg['version']}]"]
        preserved = []
        for rec in protected:
            body = canonical_bytes(rec["data"] if rec["data"] is not None else rec.get("binary")).decode("utf-8")
            lines.append(f"[PROTECTED {rec['module_id']}:{rec['record_id']}@v{rec['version']} "
                         f"{rec['content_hash']}] {body}")
            preserved.append(rec["ref"])
        used = estimate_tokens("\n".join(lines))
        if used > p["max_tokens"]:
            raise BookforgeError("CONTEXT_TOO_LARGE", "/payload/max_tokens",
                                 f"protected facts need ~{used} tokens > {p['max_tokens']}; split the job "
                                 "(protected values are never compressed or dropped)")
        omissions, seen = [], set(prot_keys)
        for r in item_refs:
            if _rkey(r) in seen:
                continue
            seen.add(_rkey(r))
            rec = ctx.record(r)
            descs = _texts(rec.get("data"), {"summary", "description", "text"})
            cite = f"[{rec['module_id']}:{rec['record_id']}@v{rec['version']}]"
            if not descs:
                omissions.append(f"{rec['record_id']}@v{rec['version']}: no optional description to compress")
                continue
            line = f"{cite} {_first_sentence(descs[0])}"
            cost = estimate_tokens("\n".join(lines + [line]))
            if cost <= p["max_tokens"]:
                lines.append(line)
                used = cost
                preserved.append(rec["ref"])
                if len(descs) > 1 or _first_sentence(descs[0]) != " ".join(descs[0].split()):
                    omissions.append(f"{rec['record_id']}@v{rec['version']}: description compressed to first "
                                     "sentence")
            else:
                omissions.append(f"{rec['record_id']}@v{rec['version']}: omitted (token budget)")
        return Result(data={"compressed_text": "\n".join(lines), "preserved_refs": preserved,
                            "omissions": omissions})
