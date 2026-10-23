"""Operation handler base class and the per-request context handed to domain code.

A handler owns its operation's semantics (Shared Contract section 2): CREATE produces
the immutable OUTPUT data, UPDATE produces a complete replacement, VALIDATE returns
owner semantic findings and ACCEPT may add approval gates. The kernel (engine.py) does
envelope validation, authorization, reference resolution, idempotency, storage, audit
and outbox; handlers never write storage directly except through ctx staging helpers,
which are committed atomically with the operation's own output.
"""
from __future__ import annotations

import copy
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from ..canonical import canonical_bytes, make_reference, sha256_bytes, sha256_text
from ..errors import BookforgeError
from .. import CONTRACT_VERSION

if TYPE_CHECKING:  # pragma: no cover
    from ..engine import Engine


@dataclass
class Result:
    """Outcome of a handler action.

    data: OUTPUT document for CREATE/UPDATE (None when blocked).
    status: DRAFT (normal), BLOCKED or PARTIAL. Handlers never return APPROVED.
    """
    data: dict | None = None
    status: str = "DRAFT"
    findings: list = field(default_factory=list)
    errors: list = field(default_factory=list)
    source_refs: list = field(default_factory=list)
    unresolved: list = field(default_factory=list)
    resource: dict | None = None
    transform: str = "LOGIC"
    # CREATE only: pre-allocated record ID (from ctx.allocate_record_id) when the OUTPUT
    # must cite its own identity, e.g. I01 canon_id.
    record_id: str | None = None


@dataclass
class Staged:
    kind: str  # JSON_RECORD | BINARY_ARTIFACT | REVISION
    module_id: str
    record_id: str
    version: int
    ref: dict
    record_kind: str
    data: Any
    source_refs: list
    mime_type: str | None = None
    expected_latest: int | None = None
    state: str = "DRAFT"


class Context:
    """Everything a handler may read during one request (built by the engine)."""

    def __init__(self, engine: "Engine", request: dict, principal_id: str, *, action: str,
                 manual_candidate: dict | None = None, evidence_origin: str = "AUTHORITATIVE"):
        self.engine = engine
        self.store = engine.store
        self.contracts = engine.contracts
        self.request = request
        self.action = action
        self.op_id: str = request["target_operation"]
        self.op = self.contracts.operation(self.op_id)
        self.project_id: str = request["project_id"]
        self.branch_id: str = request["branch_id"]
        self.principal_id = principal_id
        self.payload: dict = request.get("payload") or {}
        self.manual_candidate = manual_candidate
        self.evidence_origin = evidence_origin
        self.resolved: dict[str, dict] = {}  # pointer -> stored record
        self.base: dict | None = None
        self.staged: list[Staged] = []
        self.post_commit: list = []  # callables(tx) run inside the commit transaction
        self.project = self.store.project(self.project_id)
        self.manifest = self.store.feature_manifest(self.project_id, self.branch_id)
        self._finding_seq = 0

    # ------------------------------------------------------------------ reading inputs
    def record(self, ref: dict | None) -> dict | None:
        """Return the stored record for a pin that the kernel already resolved."""
        if ref is None:
            return None
        for rec in self.resolved.values():
            if rec["record_id"] == ref["record_id"] and rec["version"] == ref["version"]:
                return rec
        return self.engine.resolve_ref(ref, self.project_id, self.branch_id, "/")

    def field_record(self, name: str) -> dict | None:
        """Resolved record for payload field `name` (single *_ref)."""
        return self.resolved.get(f"/payload/{name}")

    def field_records(self, name: str) -> list[dict]:
        """Resolved records for payload list field `name` (*_refs), in order."""
        prefix = f"/payload/{name}/"
        items = [(int(k[len(prefix):].split("/")[0]), v) for k, v in self.resolved.items()
                 if k.startswith(prefix) and k[len(prefix):].split("/")[0].isdigit() and k.count("/") == 3]
        return [v for _, v in sorted(items, key=lambda x: x[0])]

    def binary(self, rec: dict) -> bytes:
        return self.store.read_binary(rec)

    def records_of(self, module_id: str, approved_only: bool = False) -> list[dict]:
        recs = self.store.list_records(self.project_id, self.branch_id, module_id=module_id)
        if approved_only:
            out = []
            for r in recs:
                if r["approved_version"]:
                    out.append(self.store.get_record(self.project_id, self.branch_id, r["record_id"],
                                                     r["approved_version"]))
            return out
        return recs

    # ------------------------------------------------------------------ findings
    def finding(self, rule_id: str, message: str, *, severity: str = "MAJOR", decision: str = "FAIL",
                evidence: list | None = None, source_refs: list | None = None,
                confidence: float | None = None) -> dict:
        self._finding_seq += 1
        return {
            "id": f"{self.op_id}-{rule_id}-{self._finding_seq}",
            "rule_id": rule_id, "severity": severity, "decision": decision,
            "message": message[:2000] or rule_id, "evidence": list(evidence or []),
            "source_refs": list(source_refs or []), "confidence": confidence,
        }

    def block(self, code: str, path: str, message: str, **kw) -> BookforgeError:
        return BookforgeError(code, path, message, status=kw.pop("status", "BLOCKED"), **kw)

    # ------------------------------------------------------------------ staging writes
    def _new_record_id(self, module_id: str) -> str:
        return f"{module_id}-{uuid.uuid4().hex[:16]}"

    def allocate_record_id(self) -> str:
        """Pre-allocate this operation's CREATE record ID (return it as Result.record_id)."""
        return self._new_record_id(self.op_id)

    def stage_json(self, module_id: str, data: Any, *, record_kind: str = "OUTPUT",
                   source_refs: list | None = None) -> dict:
        """Allocate a new JSON record committed atomically with this operation's output."""
        record_id = self._new_record_id(module_id)
        body = {"project_id": self.project_id, "branch_id": self.branch_id, "owner": module_id[0],
                "module_id": module_id, "record_id": record_id, "version": 1,
                "contract_version": CONTRACT_VERSION, "data": data, "source_refs": list(source_refs or [])}
        ref = make_reference(self.project_id, self.branch_id, module_id, record_id, 1,
                             sha256_bytes(canonical_bytes(body)))
        self.staged.append(Staged("JSON_RECORD", module_id, record_id, 1, ref, record_kind,
                                  copy.deepcopy(data), list(source_refs or [])))
        return ref

    def stage_revision(self, record: dict, data: Any, *, source_refs: list | None = None,
                       state: str = "DRAFT") -> dict:
        """Stage version+1 of an existing JSON record (CAS against its current latest)."""
        version = record["latest_version"] + 1
        srcs = list(record["source_refs"] if source_refs is None else source_refs)
        body = {"project_id": self.project_id, "branch_id": self.branch_id, "owner": record["owner"],
                "module_id": record["module_id"], "record_id": record["record_id"], "version": version,
                "contract_version": CONTRACT_VERSION, "data": data, "source_refs": srcs}
        ref = make_reference(self.project_id, self.branch_id, record["module_id"], record["record_id"], version,
                             sha256_bytes(canonical_bytes(body)))
        self.staged.append(Staged("JSON_RECORD", record["module_id"], record["record_id"], version, ref,
                                  record["record_kind"], copy.deepcopy(data), srcs,
                                  expected_latest=record["latest_version"], state=state))
        return ref

    def stage_binary(self, module_id: str, data: bytes, mime_type: str, *, record_kind: str = "BINARY",
                     source_refs: list | None = None) -> dict:
        record_id = self._new_record_id(module_id)
        ref = make_reference(self.project_id, self.branch_id, module_id, record_id, 1, sha256_bytes(data))
        self.staged.append(Staged("BINARY_ARTIFACT", module_id, record_id, 1, ref, record_kind, bytes(data),
                                  list(source_refs or []), mime_type=mime_type))
        return ref

    def staged_record(self, ref: dict) -> Staged | None:
        for s in self.staged:
            if s.record_id == ref["record_id"] and s.version == ref["version"]:
                return s
        return None

    # ------------------------------------------------------------------ module state
    def get_state(self, namespace: str, key: str, default=None):
        return self.store.get_state(self.project_id, self.branch_id, namespace, key, default)

    def on_commit(self, fn):
        """Register fn(tx) to run inside the same commit transaction (e.g. module_state CAS)."""
        self.post_commit.append(fn)

    # ------------------------------------------------------------------ AI slots
    def ai_generate(self, *, task: str, output_schema: dict, context: dict, capability: str = "text",
                    protected_facts: list | None = None) -> tuple[dict, dict]:
        """Run a creative/semantic task on the best eligible configured AI slot.

        Returns (json_output, resource_info). Raises BookforgeError(CAPABILITY_UNAVAILABLE)
        when no connected slot has the capability; callers then hold for manual input.
        """
        return self.engine.providers.generate(self, task=task, output_schema=output_schema, context=context,
                                              capability=capability, protected_facts=protected_facts or [])

    @staticmethod
    def text_hash(text: str) -> str:
        return sha256_text(text)


# How prose "text" is laid out: the exporters (exporters/book.py) read exactly these conventions, so the AI is told
# them instead of guessing Markdown/HTML that would otherwise be printed literally in the book.
PROSE_OPS = {f"C{n:02d}" for n in range(2, 12)}
CHAPTER_TITLE_CONVENTION = ("Start the text with one line '# ' followed by a short title for this chapter (just the "
                            "title, without 'Chapter' or a number; numbering is added when the book is assembled).")
PROSE_CONVENTIONS = ("Write the prose as plain text: one paragraph per line (a blank line between paragraphs is "
                     "fine), a line with only *** for a scene break, '## ' only for a sub-heading. For emphasis "
                     "use *italic* or **bold** sparingly; no other Markdown, no HTML, no code fences, no notes or "
                     "commentary outside the story.")


class OperationHandler:
    """Default behavior used by every operation unless a module overrides it."""

    op_id: str = ""
    # Execution class from the registry: LOGIC ops must be deterministic; AI/HYBRID ops may
    # use an AI slot for creative completion or accept a manual candidate.
    creative = False

    def __init__(self, op_id: str | None = None):
        if op_id:
            self.op_id = op_id

    # -- applicability --------------------------------------------------------------
    def applicability(self, ctx: Context) -> tuple[str, str] | None:
        """Return (selection_rule_id, reason) when the pinned manifest disables this op."""
        return None

    # -- CREATE -----------------------------------------------------------------------
    def create(self, ctx: Context) -> Result:
        if ctx.manual_candidate is not None:
            return Result(data=ctx.manual_candidate, transform="MANUAL")
        out = ctx.contracts.definition(ctx.op_id, "OUTPUT")
        data, missing = normalize_to_output(ctx.payload, out)
        if not missing:
            return Result(data=data, transform="LOGIC")
        if self.creative or ctx.op["execution"] in ("AI", "HYBRID", "AI/HYBRID"):
            return self.generate(ctx, data, missing)
        raise BookforgeError("MISSING_INPUT", "/payload/" + missing[0],
                             f"cannot derive required output field '{missing[0]}' from the request")

    def generate(self, ctx: Context, partial: dict, missing: list[str]) -> Result:
        """AI path: ask the selected slot for the missing OUTPUT fields; else hold."""
        out_schema = ctx.contracts.definition(ctx.op_id, "OUTPUT")
        context = self.ai_context(ctx)
        try:
            generated, resource = ctx.ai_generate(
                task=self.ai_task(ctx), output_schema=out_schema, context=context)
        except BookforgeError as exc:
            if exc.code == "CAPABILITY_UNAVAILABLE":
                raise BookforgeError(
                    "CAPABILITY_UNAVAILABLE", "/payload",
                    f"{ctx.op_id} needs an AI slot for {', '.join(missing)}; configure AI-1..AI-3 or "
                    "supply a manual candidate.", unresolved=[f"{ctx.op_id}:manual_candidate"]) from exc
            raise
        data = dict(partial)
        for k in out_schema.get("properties", {}):
            if k in generated and (k in missing or k not in data):
                data[k] = generated[k]
        return Result(data=data, resource=resource, transform="AI")

    def ai_task(self, ctx: Context) -> str:
        op = ctx.op
        task = (f"Operation {op['id']} - {op['name']}. Purpose: {op['purpose']} "
                f"AI policy: {op.get('ai', '')} Return only JSON matching the output schema.")
        if op["id"] in PROSE_OPS:
            task += " " + (CHAPTER_TITLE_CONVENTION + " " if op["id"] == "C02" else "") + PROSE_CONVENTIONS
        return task

    def ai_context(self, ctx: Context) -> dict:
        refs = {}
        for ptr, rec in ctx.resolved.items():
            if rec.get("data") is not None:
                refs[ptr] = {"module_id": rec["module_id"], "record_id": rec["record_id"],
                             "version": rec["version"], "lifecycle": rec["lifecycle"], "data": rec["data"]}
        return {"request_payload": ctx.payload, "resolved_inputs": refs}

    # -- UPDATE -----------------------------------------------------------------------
    def update(self, ctx: Context) -> Result:
        return Result(data=copy.deepcopy(ctx.payload), transform="MANUAL")

    # -- VALIDATE / ACCEPT -------------------------------------------------------------
    def validate(self, ctx: Context, record: dict) -> list[dict]:
        """Owner semantic findings for a stored candidate (structural checks done by kernel)."""
        return []

    def accept_gate(self, ctx: Context, record: dict, approval: dict | None) -> list[dict]:
        """Extra approval gates; return BLOCKING findings to refuse acceptance."""
        return []

    def requires_explicit_approval(self, ctx: Context, record: dict) -> bool:
        """True when ACCEPT needs a separate approval_ref (protected changes, release)."""
        return False

    def on_accept(self, ctx: Context, record: dict, tx) -> None:
        """Hook inside the ACCEPT transaction (e.g. publish a state head)."""
        return None


def normalize_to_output(payload: dict, out_schema: dict) -> tuple[dict, list[str]]:
    """Copy payload fields that the OUTPUT declares; fill known-empty collections.

    Absent optional fields stay absent; required arrays/objects become known-empty only
    when their schema allows it (minItems 0 / no required keys). Other missing required
    fields are reported so the caller can generate them or ask for input.
    """
    props = out_schema.get("properties", {})
    data = {k: copy.deepcopy(v) for k, v in payload.items() if k in props}
    missing = []
    for name in out_schema.get("required", []):
        if name in data:
            continue
        s = props.get(name, {})
        t = s.get("type")
        if t == "array" and s.get("minItems", 0) == 0:
            data[name] = []
        elif t == "object" and not s.get("required"):
            data[name] = {}
        else:
            missing.append(name)
    return data, missing
