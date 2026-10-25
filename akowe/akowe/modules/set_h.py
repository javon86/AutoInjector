"""Set H handlers: Final Quality Control (H01-H10).

Every H report has the same OUTPUT shape: operation, status, source_refs (exact input
pins in payload field order), findings, result_revision, checker_version, coverage_refs
(everything actually inspected) and policy_ref (the input that defines the acceptance
policy). Status is *derived* from findings, never asserted:

    FAIL            any FAIL finding with severity MAJOR/BLOCKING
    UNKNOWN         else any UNKNOWN finding with severity MAJOR/BLOCKING
    NOT_APPLICABLE  else any NOT_APPLICABLE finding (rule evidence)
    PASS            else at least one PASS finding and non-empty coverage
    UNKNOWN         otherwise (no evidence is never PASS)

H10 uses READY/BLOCKED: READY only when no MAJOR/BLOCKING FAIL/UNKNOWN finding exists.

Deterministic checks (H05, H07, H08, H09, H10) are re-run from the pinned inputs on
VALIDATE and UPDATE, so a stored or hand-edited result can never claim a status the
bytes do not support. Semantic checks (H01-H04, H06) combine deterministic coverage and
obligation bookkeeping with an AI slot or a manual reviewer candidate; every semantic
claim is re-verified against exact span hashes, skipped windows are never counted as
reviewed, and an unavailable reviewer yields UNKNOWN VALIDATOR_UNAVAILABLE.
"""
from __future__ import annotations

import copy
import json
import re
from datetime import datetime, timezone

from .. import h_checks as hc
from ..canonical import sha256_bytes, sha256_text
from ..errors import AkoweError
from . import register
from .base import Context, OperationHandler, Result

CHECKER_VERSION = "akowe-h/1.0.0"
SEMANTIC_OPS = ("H01", "H02", "H03", "H04", "H06")
DETERMINISTIC_OPS = ("H05", "H07", "H08", "H09", "H10")
PROSE_PRODUCERS = tuple(f"C{n:02d}" for n in range(2, 12))
EXPORT_PRODUCERS = ("G11", "G12", "G13")
BLOCK_SEV = ("MAJOR", "BLOCKING")

# Payload fields in schema order ("*" marks a list field); source_refs follow this order.
FIELDS = {
    "H01": ["manuscript_ref", "project_goals_ref"],
    "H02": ["manuscript_ref", "canon_snapshot_ref"],
    "H03": ["manuscript_ref", "plot_plan_ref"],
    "H04": ["manuscript_ref", "character_arcs_ref"],
    "H05": ["manuscript_ref", "chapter_manifest_ref"],
    "H06": ["asset_manifest_ref", "approved_visual_bible_ref"],
    "H07": ["export_ref", "layout_profile_ref"],
    "H08": ["export_ref", "toc_manifest_ref"],
    "H09": ["*export_refs", "expected_manifest_ref"],
    "H10": ["*check_report_refs", "release_profile_ref", "release_manifest_ref"],
}
POLICY_FIELD = {"H01": "project_goals_ref", "H02": "canon_snapshot_ref", "H03": "plot_plan_ref",
                "H04": "character_arcs_ref", "H05": "chapter_manifest_ref", "H06": "approved_visual_bible_ref",
                "H07": "layout_profile_ref", "H08": "toc_manifest_ref", "H09": "expected_manifest_ref"}
IMPLIED_EXPORTS = {"MANUSCRIPT_PDF": {"G11"}, "PRINT_INTERIOR": {"G11"}, "PRINT_WRAP_COVER": {"G10", "G11"},
                   "EPUB_REFLOWABLE": {"G12"}, "EDITABLE_DOCX": {"G13"}}
# Rule IDs produced by deterministic bookkeeping inside semantic reports; a reviewer
# candidate can never supply, remove or overturn them.
SEMANTIC_DET_RULES = {"COVERAGE", "COVERAGE_INCOMPLETE", "OBLIGATION_NOT_ASSESSED", "EVIDENCE_INVALID",
                      "EVIDENCE_REQUIRED", "VALIDATOR_UNAVAILABLE", "INPUT", "INPUT_STALE", "POLICY_NOT_APPROVED",
                      "NOT_APPLICABLE", "NO_EVIDENCE", "OBLIGATIONS", "INTENTIONALLY_OPEN", "CANON_NOT_APPROVED",
                      "ASSET_NOT_APPROVED", "ASSET_DUPLICATE", "PLACEMENT_DUPLICATE", "VISUAL_BIBLE",
                      "MANUSCRIPT", "UNKNOWN_CLAIM_TARGET"}
WINDOW_CHARS = 24000
BATCH_CHARS = 96000
NA_NO_OBLIGATIONS = "NO_SELECTED_OBLIGATIONS"


# ====================================================================== helpers
def ref_key(ref: dict) -> tuple:
    return (ref["record_id"], ref["version"], ref["content_hash"])


def same_pin(a: dict | None, b: dict | None) -> bool:
    return bool(a and b) and ref_key(a) == ref_key(b)


def aux(rec: dict | None) -> dict:
    return ((rec or {}).get("data") or {}).get("auxiliary_record") or {}


def aux_kind(rec: dict | None) -> str | None:
    return aux(rec).get("record_kind")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_time(v: str) -> datetime:
    return datetime.fromisoformat(v.replace("Z", "+00:00"))


def derive_status(findings: list, coverage_refs: list | None = None) -> str:
    if any(f["decision"] == "FAIL" and f["severity"] in BLOCK_SEV for f in findings):
        return "FAIL"
    if any(f["decision"] == "UNKNOWN" and f["severity"] in BLOCK_SEV for f in findings):
        return "UNKNOWN"
    if any(f["decision"] == "NOT_APPLICABLE" for f in findings):
        return "NOT_APPLICABLE"
    if any(f["decision"] == "PASS" for f in findings) and (coverage_refs is None or coverage_refs):
        return "PASS"
    return "UNKNOWN"


def derive_readiness(findings: list) -> str:
    if any(f["decision"] in ("FAIL", "UNKNOWN") and f["severity"] in BLOCK_SEV for f in findings):
        return "BLOCKED"
    return "READY" if any(f["decision"] == "PASS" for f in findings) else "BLOCKED"


def approval_valid(rec: dict | None) -> tuple[bool, str, list]:
    """(valid, reason, pinned refs) for a K09/I10 approval record."""
    if rec is None:
        return False, "no approval record", []
    data = rec.get("data") or {}
    if rec["module_id"] == "K09":
        decision, expiry, pins = data.get("decision"), data.get("expiry"), rec.get("source_refs") or []
    elif rec["module_id"] == "I10":
        body = data.get("approval") or {}
        decision = "REVOKED" if body.get("revoked") else body.get("decision")
        expiry = body.get("expires_at")
        pins = list(body.get("source_refs") or []) + ([body["subject_ref"]] if body.get("subject_ref") else [])
    else:
        return False, f"{rec['module_id']} is not a K09/I10 approval", []
    if decision != "APPROVED":
        return False, f"approval decision is {decision}", pins
    try:
        if not expiry or _parse_time(expiry) <= _now():
            return False, "approval has expired", pins
    except ValueError:
        return False, "approval expiry is not RFC3339", pins
    return True, "approved", pins


class Review:
    """Collects findings/coverage for one report run (CREATE, VALIDATE re-run or UPDATE)."""

    def __init__(self, ctx: Context, op: str):
        self.ctx = ctx
        self.op = op
        self.findings: list[dict] = []
        self.coverage: list[dict] = []
        self.extra_sources: list[dict] = []
        self.checker_notes: list[str] = []

    # -- findings
    def add(self, rule: str, message: str, severity: str = "BLOCKING", decision: str = "FAIL", *,
            evidence: list | None = None, source_refs: list | None = None, confidence=None) -> dict:
        f = self.ctx.finding(rule, message or rule, severity=severity, decision=decision, evidence=evidence,
                             source_refs=source_refs, confidence=confidence)
        f["id"] = f"{self.op}-{rule}-{len(self.findings) + 1}"
        self.findings.append(f)
        return f

    def ok(self, rule: str, message: str, source_refs: list | None = None) -> dict:
        return self.add(rule, message, "INFO", "PASS", source_refs=source_refs)

    def na(self, predicate: str, message: str) -> dict:
        return self.add(f"NOT_APPLICABLE:{predicate}", message, "INFO", "NOT_APPLICABLE")

    def from_issues(self, issues: list[dict], source_refs: list | None = None, prefix: str = ""):
        for i in issues:
            self.add(i["rule"], prefix + i["message"], i["severity"], i["decision"], source_refs=source_refs)

    def cover(self, ref: dict | None):
        if ref and not any(same_pin(ref, c) for c in self.coverage):
            self.coverage.append(ref)

    # -- loading
    def load(self, ref: dict | None, label: str, *, severity: str = "BLOCKING") -> dict | None:
        if ref is None:
            self.add("INPUT", f"{label}: reference is missing", severity, "FAIL")
            return None
        try:
            rec = self.ctx.record(ref)
        except OSError as exc:
            self.add("INPUT", f"{label}: stored bytes unreadable: {exc}", severity, "FAIL", source_refs=[ref])
            return None
        except AkoweError as exc:
            e = exc.errors[0]
            self.add("INPUT", f"{label} {ref.get('module_id')}:{ref.get('record_id')} v{ref.get('version')} does not "
                              f"resolve: {e['code']} {e['message']}", severity, "FAIL", source_refs=[ref])
            return None
        if rec is None:
            self.add("INPUT", f"{label}: record not found", severity, "FAIL", source_refs=[ref])
            return None
        if rec.get("stale"):
            self.add("INPUT_STALE", f"{label} {rec['record_id']} v{rec['version']} is stale: "
                                    f"{rec.get('stale_reason') or 'an input changed'}", "MAJOR", "UNKNOWN",
                     source_refs=[rec["ref"]])
        return rec

    def follow_descriptor(self, desc: dict, label: str) -> tuple[dict | None, bytes | None]:
        """Resolve a G descriptor to its distinct binary record and verified bytes."""
        d = desc.get("data") or {}
        aref = d.get("artifact_ref")
        src = [desc["ref"]]
        if not aref:
            self.add("DESCRIPTOR", f"{label}: descriptor has no artifact_ref", source_refs=src)
            return None, None
        bad = False
        if aref["record_id"] == desc["record_id"]:
            self.add("DESCRIPTOR_SELF_REFERENCE", f"{label}: artifact_ref points to its own descriptor",
                     source_refs=src)
            bad = True
        if aref["module_id"] != desc["module_id"]:
            self.add("ARTIFACT_PRODUCER", f"{label}: artifact produced by {aref['module_id']}, descriptor by "
                                          f"{desc['module_id']}", source_refs=src)
            bad = True
        if d.get("sha256") != aref["content_hash"]:
            self.add("SHA256_MISMATCH", f"{label}: descriptor sha256 {d.get('sha256')} != artifact_ref.content_hash "
                                        f"{aref['content_hash']}", source_refs=src)
            bad = True
        if d.get("revision") != aref["version"]:
            self.add("REVISION_MISMATCH", f"{label}: descriptor revision {d.get('revision')} != binary version "
                                          f"{aref['version']}", source_refs=src)
            bad = True
        binrec = self.load(aref, f"{label} artifact")
        if binrec is None:
            return None, None
        self.cover(binrec["ref"])
        if binrec["representation"] != "BINARY_ARTIFACT":
            self.add("ARTIFACT_REPRESENTATION", f"{label}: artifact_ref is not a BINARY_ARTIFACT", source_refs=src)
            return None, None
        try:
            data = self.ctx.binary(binrec)
        except (AkoweError, OSError) as exc:
            self.add("HASH_MISMATCH", f"{label}: stored bytes cannot be verified: {exc}", source_refs=[aref])
            return None, None
        if sha256_bytes(data) != aref["content_hash"]:
            self.add("HASH_MISMATCH", f"{label}: byte SHA-256 differs from the pinned hash", source_refs=[aref])
            return None, None
        mime = (binrec.get("binary") or {}).get("mime_type")
        expected = hc.MIME_BY_PRODUCER.get(desc["module_id"], "application/json")
        if mime != expected:
            self.add("MIME_MISMATCH", f"{label}: binary MIME {mime!r} != expected {expected!r}", source_refs=[aref])
            bad = True
        if (binrec.get("binary") or {}).get("byte_length") not in (None, len(data)):
            self.add("BYTE_LENGTH", f"{label}: stored byte_length differs from actual bytes", source_refs=[aref])
            bad = True
        if not bad:
            self.ok("DESCRIPTOR", f"{label}: descriptor -> {aref['record_id']} v{aref['version']} "
                                  f"sha256 {aref['content_hash'][:12]}.. {expected} verified", source_refs=[aref])
        return binrec, data

    def json_artifact(self, desc: dict, schema: str, label: str) -> tuple[dict | None, dict | None]:
        binrec, data = self.follow_descriptor(desc, label)
        if data is None:
            return None, binrec
        try:
            obj = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            self.add("ARTIFACT_JSON", f"{label}: artifact bytes are not UTF-8 JSON: {exc}",
                     source_refs=[binrec["ref"]])
            return None, binrec
        errs = self.ctx.contracts.check_shared(schema, obj)
        if errs:
            self.add("ARTIFACT_SCHEMA", f"{label}: {schema} invalid at {errs[0]['path']}: {errs[0]['message']}",
                     source_refs=[binrec["ref"]])
            return None, binrec
        return obj, binrec


def span_evidence(rec: dict, text: str, start: int, end: int) -> dict:
    return {"record_ref": rec["ref"], "span_id": f"{rec['record_id']}:{start}-{end}", "start": start, "end": end,
            "text_hash": sha256_text(text[start:end])}


# ====================================================================== base handler
class HReport(OperationHandler):
    """Shared H report behavior: input loading, output assembly, validate/update re-checks."""

    semantic = False

    # -- inputs
    def inputs_from_ctx(self, ctx: Context) -> dict:
        out = {}
        for f in FIELDS[self.op_id]:
            if f.startswith("*"):
                out[f[1:]] = ctx.field_records(f[1:])
            else:
                out[f] = ctx.field_record(f)
        return out

    def pins(self, inputs: dict) -> list[dict]:
        out = []
        for f in FIELDS[self.op_id]:
            v = inputs.get(f.lstrip("*"))
            if isinstance(v, list):
                out.extend(r["ref"] for r in v if r)
            elif v:
                out.append(v["ref"])
        return out

    def inputs_from_record(self, ctx: Context, record: dict, review: Review) -> dict | None:
        """Rebuild field -> record from a stored report's source_refs (payload order)."""
        refs = list((record.get("data") or {}).get("source_refs") or [])
        fields = FIELDS[self.op_id]
        singles = [f for f in fields if not f.startswith("*")]
        out: dict = {}
        if fields[0].startswith("*"):
            n_list = len(refs) - len(singles)
            if n_list < 1:
                review.add("RERUN_INPUT", "stored source_refs do not match the input contract")
                return None
            out[fields[0][1:]] = [review.load(r, fields[0][1:]) for r in refs[:n_list]]
            if any(r is None for r in out[fields[0][1:]]):
                return None
            refs = refs[n_list:]
        if len(refs) != len(singles):
            review.add("RERUN_INPUT", "stored source_refs do not match the input contract")
            return None
        for f, r in zip(singles, refs):
            out[f] = review.load(r, f)
            if out[f] is None:
                return None
        return out

    def policy_ref(self, ctx: Context, inputs: dict) -> dict:
        return inputs[POLICY_FIELD[self.op_id]]["ref"]

    # -- applicability: subclasses override
    def run(self, ctx: Context, review: Review, inputs: dict, candidate: dict | None = None) -> Result | None:
        raise NotImplementedError

    def assemble(self, ctx: Context, review: Review, inputs: dict, version: int, policy_ref: dict,
                 checker: str | None = None) -> dict:
        if not review.coverage and not any(f["decision"] in ("FAIL", "NOT_APPLICABLE") for f in review.findings):
            review.add("NO_EVIDENCE", "nothing was inspected; a report without evidence is never PASS", "MAJOR",
                       "UNKNOWN")
        status = derive_status(review.findings, review.coverage)
        if status == "PASS" and not review.coverage:
            status = "UNKNOWN"
        return {"operation": self.op_id, "status": status, "source_refs": self.pins(inputs),
                "findings": review.findings, "result_revision": version,
                "checker_version": checker or CHECKER_VERSION, "coverage_refs": review.coverage,
                "policy_ref": policy_ref}

    # -- CREATE
    def create(self, ctx: Context) -> Result:
        inputs = self.inputs_from_ctx(ctx)
        review = Review(ctx, self.op_id)
        for name, rec in inputs.items():
            for r in (rec if isinstance(rec, list) else [rec]):
                if r and r.get("stale"):
                    review.add("INPUT_STALE", f"{name} {r['record_id']} v{r['version']} is stale: "
                                              f"{r.get('stale_reason') or 'input changed'}", "MAJOR", "UNKNOWN",
                               source_refs=[r["ref"]])
        extra = self.run(ctx, review, inputs, ctx.manual_candidate)
        data = self.assemble(ctx, review, inputs, 1, self.policy_ref(ctx, inputs),
                             checker=(extra.data or {}).get("checker_version") if extra else None)
        transform = extra.transform if extra else "LOGIC"
        resource = extra.resource if extra else None
        return Result(data=data, transform=transform, resource=resource, source_refs=list(review.coverage))

    # -- VALIDATE
    def validate(self, ctx: Context, record: dict) -> list[dict]:
        out = []
        data = record["data"] or {}
        if data.get("operation") != self.op_id:
            out.append(ctx.finding("OPERATION", "operation must equal the producing operation", severity="BLOCKING"))
        if data.get("result_revision") != record["version"]:
            out.append(ctx.finding("RESULT_REVISION", "result_revision must equal the stored version",
                                   severity="BLOCKING"))
        derived = (derive_readiness(data.get("findings", [])) if self.op_id == "H10"
                   else derive_status(data.get("findings", []), data.get("coverage_refs")))
        if data.get("status") != derived:
            out.append(ctx.finding("STATUS_DERIVATION", f"status {data.get('status')} is not derived from findings "
                                                        f"({derived})", severity="BLOCKING"))
        if data.get("status") in ("PASS", "READY") and not data.get("coverage_refs"):
            out.append(ctx.finding("NO_EVIDENCE", "PASS requires inspected coverage", severity="BLOCKING"))
        if self.op_id in DETERMINISTIC_OPS:
            review = Review(ctx, self.op_id)
            inputs = self.inputs_from_record(ctx, record, review)
            if inputs is None:
                out.append(ctx.finding("RERUN_INPUT", "; ".join(f["message"] for f in review.findings)[:1900]
                                       or "inputs unavailable", severity="BLOCKING", decision="UNKNOWN"))
            else:
                self.run(ctx, review, inputs, None)
                rerun = self.assemble(ctx, review, inputs, record["version"], data.get("policy_ref"))
                if rerun["status"] != data.get("status"):
                    out.append(ctx.finding("RERUN_MISMATCH", f"stored status {data.get('status')} but the "
                                                             f"deterministic re-check gives {rerun['status']}",
                                           severity="BLOCKING"))
        else:
            out.extend(self.validate_semantic(ctx, record))
        return out

    def validate_semantic(self, ctx: Context, record: dict) -> list[dict]:
        return []

    # -- UPDATE (complete replacement; human disposition for semantic reports)
    def update(self, ctx: Context) -> Result:
        base = ctx.base
        new = copy.deepcopy(ctx.payload)
        old = base["data"]
        for k in ("operation", "source_refs", "policy_ref"):
            if new.get(k) != old.get(k):
                raise AkoweError("INVALID_INPUT", f"/payload/{k}", f"{k} is fixed by the original check run; "
                                     "create a new report for different inputs", status="REJECTED")
        if new.get("result_revision") != base["version"] + 1:
            raise AkoweError("INVALID_INPUT", "/payload/result_revision",
                                 "result_revision must equal the new version", status="REJECTED")
        derived = derive_readiness(new["findings"]) if self.op_id == "H10" else derive_status(
            new["findings"], new.get("coverage_refs"))
        if new.get("status") != derived:
            raise AkoweError("INVALID_INPUT", "/payload/status", f"status must be derived from findings "
                                 f"({derived})", status="REJECTED")
        if self.op_id in DETERMINISTIC_OPS:
            review = Review(ctx, self.op_id)
            inputs = self.inputs_from_record(ctx, base, review)
            if inputs is None:
                raise AkoweError("MISSING_INPUT", "/base_ref", "pinned inputs no longer resolve; create a new "
                                     "report", status="BLOCKED")
            self.run(ctx, review, inputs, None)
            rerun = self.assemble(ctx, review, inputs, base["version"] + 1, old.get("policy_ref"))

            def blocking(fs):
                return sorted((f["rule_id"], f["decision"], f["severity"], f["message"]) for f in fs
                              if f["decision"] in ("FAIL", "UNKNOWN") and f["severity"] in BLOCK_SEV)

            if rerun["status"] != new["status"] or blocking(rerun["findings"]) != blocking(new["findings"]):
                raise AkoweError("INVALID_INPUT", "/payload/findings",
                                     "deterministic check results cannot be overridden; only INFO/MINOR notes may "
                                     "change", status="REJECTED")
            if new.get("coverage_refs") != old.get("coverage_refs"):
                raise AkoweError("INVALID_INPUT", "/payload/coverage_refs", "coverage is fixed by the check run",
                                     status="REJECTED")
        else:
            def det(fs):
                return sorted((f["rule_id"], f["decision"], f["severity"], f["message"]) for f in fs
                              if f["rule_id"].split(":")[0] in SEMANTIC_DET_RULES)

            if det(new["findings"]) != det(old["findings"]):
                raise AkoweError("INVALID_INPUT", "/payload/findings", "deterministic coverage/evidence/obligation "
                                     "findings cannot be removed or changed by disposition", status="REJECTED")
            if new.get("coverage_refs") != old.get("coverage_refs"):
                raise AkoweError("INVALID_INPUT", "/payload/coverage_refs",
                                     "coverage cannot be extended by disposition; run a new review", status="REJECTED")
            problems = self.check_evidence(ctx, new["findings"], self.claim_targets(ctx, base))
            if problems:
                raise AkoweError("INVALID_INPUT", "/payload/findings", problems[0], status="REJECTED")
        return Result(data=new, transform="MANUAL")

    def claim_targets(self, ctx: Context, record: dict) -> dict:
        return {}

    def check_evidence(self, ctx: Context, findings: list, targets: dict) -> list[str]:
        """Verify every span evidence item: known record, code-point range and exact text hash."""
        problems = []
        for f in findings:
            for ev in f.get("evidence") or []:
                t = targets.get(ev["record_ref"]["record_id"])
                if t is None or not same_pin(t["ref"], ev["record_ref"]):
                    problems.append(f"finding {f['id']}: evidence record is not an inspected input")
                    continue
                text = t["text"]
                if not (0 <= ev["start"] <= ev["end"] <= len(text)):
                    problems.append(f"finding {f['id']}: span [{ev['start']},{ev['end']}) outside text")
                elif sha256_text(text[ev["start"]:ev["end"]]) != ev["text_hash"]:
                    problems.append(f"finding {f['id']}: span text_hash does not match the exact text")
        return problems

    # -- ACCEPT
    def requires_explicit_approval(self, ctx: Context, record: dict) -> bool:
        # A semantic report revised after generation carries human disposition of
        # claims/uncertainty; its acceptance needs a separate authorization for that exact candidate.
        return self.semantic and record["version"] > 1


# ====================================================================== manuscript helpers
def load_manuscript(review: Review, man: dict | None) -> list[dict]:
    """[{id, rec, text}] for the selected chapters (C prose record or G01 compiled manuscript)."""
    if man is None:
        return []
    review.cover(man["ref"])
    if man["module_id"] in PROSE_PRODUCERS:
        return [{"id": man["record_id"], "rec": man, "text": (man.get("data") or {}).get("text", "")}]
    if man["module_id"] != "G01":
        review.add("MANUSCRIPT", f"{man['module_id']} is not a manuscript producer", source_refs=[man["ref"]])
        return []
    art, _ = review.json_artifact(man, "G01Artifact", "compiled manuscript")
    if art is None:
        return []
    chunks = []
    for s in art["sections"]:
        crec = review.load(s["chapter_ref"], f"section {s['section_id']}")
        if crec is None:
            continue
        if crec["module_id"] not in PROSE_PRODUCERS:
            review.add("MANUSCRIPT", f"section {s['section_id']} pins {crec['module_id']}, not C prose",
                       source_refs=[crec["ref"]])
            continue
        chunks.append({"id": s["section_id"], "rec": crec, "text": (crec.get("data") or {}).get("text", "")})
    return chunks


def gather_facts(value, out: list):
    if isinstance(value, dict):
        if {"subject_id", "predicate", "value", "assertion_type"} <= set(value):
            out.append(value)
        else:
            for v in value.values():
                gather_facts(v, out)
    elif isinstance(value, list):
        for v in value:
            gather_facts(v, out)


# ====================================================================== semantic handlers
class SemanticCheck(HReport):
    """H01-H04/H06: deterministic coverage/obligations + AI slot or manual reviewer claims."""

    semantic = True
    capability = "text"

    # subclasses: obligations(review, inputs) -> list[(id, description)] | None (None => policy unusable)
    def obligations(self, review: Review, inputs: dict) -> list[tuple[str, str]]:
        return []

    def targets(self, review: Review, inputs: dict) -> list[dict]:
        """Review units with text: [{id, rec, text}] (chapters for H01-H04)."""
        return load_manuscript(review, inputs.get("manuscript_ref"))

    def claim_targets(self, ctx: Context, record: dict) -> dict:
        review = Review(ctx, self.op_id)
        inputs = self.inputs_from_record(ctx, record, review) or {}
        return {t["rec"]["record_id"]: {"ref": t["rec"]["ref"], "text": t["text"]}
                for t in self.targets(review, inputs) if t.get("text") is not None}

    def policy_lifecycle(self, review: Review, inputs: dict):
        pol = inputs.get(POLICY_FIELD[self.op_id])
        if pol and pol["lifecycle"] not in ("APPROVED", "LOCKED"):
            review.add("POLICY_NOT_APPROVED", f"{POLICY_FIELD[self.op_id]} {pol['record_id']} v{pol['version']} is "
                                              f"{pol['lifecycle']}; checks run against approved intent only",
                       "MAJOR", "UNKNOWN", source_refs=[pol["ref"]])

    def run(self, ctx: Context, review: Review, inputs: dict, candidate: dict | None = None) -> Result | None:
        self.policy_lifecycle(review, inputs)
        obligations = self.obligations(review, inputs)
        if obligations is None:
            return None
        targets = self.targets(review, inputs)
        if not obligations:
            review.na(NA_NO_OBLIGATIONS, f"{self.op_id}: the pinned {POLICY_FIELD[self.op_id]} selects no "
                                         "obligations (explicit no-selected-obligations reason)")
            return None
        review.ok("OBLIGATIONS", f"{len(obligations)} selected obligation(s): "
                                 + ", ".join(o for o, _ in obligations)[:1500])
        if not targets:
            review.add("NO_EVIDENCE", "no reviewable content resolved", "BLOCKING", "UNKNOWN")
            return None
        tmap = {t["rec"]["record_id"]: t for t in targets}
        if candidate is not None:
            claims, covered = self.manual_claims(review, candidate, targets)
            result = Result(transform="MANUAL", data={"checker_version": CHECKER_VERSION + "+manual-review"})
        else:
            claims, covered, result = self.ai_claims(ctx, review, inputs, obligations, targets)
        # record claims, verifying evidence
        for c in claims:
            f = review.add(c["rule_id"], c["message"], c["severity"], c["decision"], evidence=c["evidence"],
                           source_refs=c["source_refs"], confidence=c.get("confidence"))
            probs = self.check_evidence(ctx, [f], {k: {"ref": t["rec"]["ref"], "text": t["text"]}
                                                   for k, t in tmap.items()})
            for p in probs:
                review.add("EVIDENCE_INVALID", p, "BLOCKING", "UNKNOWN")
            if f["decision"] == "FAIL" and f["severity"] in BLOCK_SEV and not f["evidence"] and not f["source_refs"]:
                review.add("EVIDENCE_REQUIRED", f"claim {f['id']} ({f['rule_id']}) cites no exact evidence",
                           "BLOCKING", "UNKNOWN")
        # coverage: every selected unit must be reviewed in full
        missing = [t["id"] for t in targets if t["rec"]["record_id"] not in covered]
        for t in targets:
            if t["rec"]["record_id"] in covered:
                review.cover(t["rec"]["ref"])
        if missing:
            review.add("COVERAGE_INCOMPLETE", f"not reviewed (never counted as reviewed): {missing}"[:1900],
                       "BLOCKING", "UNKNOWN")
        else:
            review.ok("COVERAGE", f"all {len(targets)} selected unit(s) reviewed in full")
        assessed = {c["rule_id"] for c in claims if c["decision"] in ("PASS", "FAIL", "UNKNOWN")}
        unassessed = [o for o, _ in obligations if o not in assessed]
        if unassessed:
            review.add("OBLIGATION_NOT_ASSESSED", f"no reviewer decision for: {unassessed}"[:1900], "MAJOR",
                       "UNKNOWN")
        return result

    def manual_claims(self, review: Review, candidate: dict, targets: list) -> tuple[list, set]:
        claims = []
        for f in candidate.get("findings", []):
            if f["rule_id"].split(":")[0] in SEMANTIC_DET_RULES:
                continue  # deterministic bookkeeping is recomputed, never taken from a candidate
            claims.append({k: f[k] for k in ("rule_id", "severity", "decision", "message", "evidence",
                                             "source_refs", "confidence")})
        target_pins = {t["rec"]["record_id"]: t["rec"]["ref"] for t in targets}
        covered = {r["record_id"] for r in candidate.get("coverage_refs", [])
                   if same_pin(target_pins.get(r["record_id"]), r)}
        return claims, covered

    # -- AI path
    def ai_schema(self) -> dict:
        finding = {"type": "object", "additionalProperties": False,
                   "required": ["rule_id", "severity", "decision", "message", "chunk_id", "start", "end",
                                "confidence"],
                   "properties": {"rule_id": {"type": "string", "minLength": 1},
                                  "severity": {"enum": ["INFO", "MINOR", "MAJOR", "BLOCKING"]},
                                  "decision": {"enum": ["PASS", "FAIL", "UNKNOWN"]},
                                  "message": {"type": "string", "minLength": 1},
                                  "chunk_id": {"type": ["string", "null"]},
                                  "start": {"type": ["integer", "null"], "minimum": 0},
                                  "end": {"type": ["integer", "null"], "minimum": 0},
                                  "confidence": {"type": ["number", "null"], "minimum": 0, "maximum": 1}}}
        return {"type": "object", "additionalProperties": False, "required": ["reviewed_chunk_ids", "findings"],
                "properties": {"reviewed_chunk_ids": {"type": "array", "items": {"type": "string"}},
                               "findings": {"type": "array", "items": finding}}}

    def ai_task(self, ctx: Context) -> str:
        return (f"Operation {self.op_id} - {ctx.op['name']}. {ctx.op['purpose']} Review every supplied chunk in full. "
                "For every obligation emit at least one finding whose rule_id equals the obligation id with decision "
                "PASS (realized) or FAIL (violated/missing) or UNKNOWN (uncertain). Cite exact evidence with chunk_id "
                "and code-point offsets [start,end) into that chunk's text. List in reviewed_chunk_ids only chunks you "
                "read completely. You cannot set the report status.")

    def ai_policy_context(self, inputs: dict) -> dict:
        pol = inputs.get(POLICY_FIELD[self.op_id])
        return {"policy_record": (pol or {}).get("data")}

    def ai_claims(self, ctx: Context, review: Review, inputs: dict, obligations: list, targets: list):
        windows = []
        for t in targets:
            if t["text"] is None:  # non-text unit (artwork): metadata only, no span offsets
                meta = {"record_id": t["rec"]["record_id"], "module_id": t["rec"]["module_id"],
                        "mime_type": (t["rec"].get("binary") or {}).get("mime_type")}
                windows.append({"wid": f"{t['id']}@0", "target": t, "start": 0, "text": json.dumps(meta)})
                continue
            text = t["text"]
            starts = list(range(0, max(len(text), 1), WINDOW_CHARS))
            for s in starts:
                windows.append({"wid": f"{t['id']}@{s}", "target": t, "start": s,
                                "text": text[s:s + WINDOW_CHARS]})
        batches, cur, size = [], [], 0
        for w in windows:
            if cur and size + len(w["text"]) > BATCH_CHARS:
                batches.append(cur)
                cur, size = [], 0
            cur.append(w)
            size += len(w["text"])
        if cur:
            batches.append(cur)
        claims: list = []
        reviewed_windows: set = set()
        resources = []
        for batch in batches:
            context = {"obligations": [{"id": o, "description": d} for o, d in obligations],
                       **self.ai_policy_context(inputs),
                       "chunks": [{"chunk_id": w["wid"], "text": w["text"]} for w in batch]}
            try:
                out, resource = ctx.ai_generate(task=self.ai_task(ctx), output_schema=self.ai_schema(),
                                                context=context, capability=self.capability)
            except AkoweError as exc:
                if exc.code in ("CAPABILITY_UNAVAILABLE", "CONTEXT_TOO_LARGE"):
                    review.add("VALIDATOR_UNAVAILABLE", f"semantic reviewer unavailable ({exc.code}): "
                                                        f"{exc.errors[0]['message']}; supply a manual review",
                               "BLOCKING", "UNKNOWN")
                    continue
                raise
            resources.append(resource)
            bmap = {w["wid"]: w for w in batch}
            for wid in out.get("reviewed_chunk_ids", []):
                if wid in bmap:
                    reviewed_windows.add(wid)
            for f in out.get("findings", []):
                w = bmap.get(f.get("chunk_id")) if f.get("chunk_id") else None
                ev = []
                if w is not None and w["target"]["text"] is not None and f.get("start") is not None \
                        and f.get("end") is not None:
                    s, e = w["start"] + f["start"], w["start"] + f["end"]
                    t = w["target"]
                    if f["start"] <= f["end"] <= len(w["text"]):
                        ev = [span_evidence(t["rec"], t["text"], s, e)]
                    else:
                        review.add("EVIDENCE_INVALID", f"AI claim {f['rule_id']}: span outside chunk {w['wid']}",
                                   "BLOCKING", "UNKNOWN")
                elif f.get("chunk_id") and w is None:
                    review.add("EVIDENCE_INVALID", f"AI claim {f['rule_id']}: unknown chunk {f.get('chunk_id')}",
                               "BLOCKING", "UNKNOWN")
                claims.append({"rule_id": f["rule_id"], "severity": f["severity"], "decision": f["decision"],
                               "message": f["message"], "evidence": ev,
                               "source_refs": [w["target"]["rec"]["ref"]] if w else [],
                               "confidence": f.get("confidence")})
        covered = set()
        for t in targets:
            wids = [w["wid"] for w in windows if w["target"] is t]
            if wids and all(w in reviewed_windows for w in wids):
                covered.add(t["rec"]["record_id"])
        slot = resources[0]["ai_slot"] if resources else "none"
        resource = None
        if resources:
            resource = dict(resources[0])
            resource["input_tokens"] = sum(r.get("input_tokens", 0) for r in resources)
            resource["output_tokens"] = sum(r.get("output_tokens", 0) for r in resources)
            resource["calls"] = len(resources)
        result = Result(transform="AI" if resources else "LOGIC", resource=resource,
                        data={"checker_version": f"{CHECKER_VERSION}+ai:{slot}"})
        return claims, covered, result

    def validate_semantic(self, ctx: Context, record: dict) -> list[dict]:
        out = []
        data = record["data"]
        targets = self.claim_targets(ctx, record)
        for p in self.check_evidence(ctx, data["findings"], targets):
            out.append(ctx.finding("EVIDENCE_INVALID", p, severity="BLOCKING", decision="FAIL"))
        if data["status"] == "PASS":
            covered = {r["record_id"] for r in data["coverage_refs"]}
            missing = [k for k in targets if k not in covered]
            if missing:
                out.append(ctx.finding("COVERAGE_INCOMPLETE", f"PASS without full coverage: {missing}",
                                       severity="BLOCKING", decision="FAIL"))
        return out


@register("H01")
class FullReadThrough(SemanticCheck):
    """H01: holistic read against PROJECT_GOALS goals and required obligation IDs."""

    def obligations(self, review, inputs):
        goals = aux(inputs.get("project_goals_ref")).get("data") or {}
        review.cover(inputs["project_goals_ref"]["ref"])
        open_ids = set(goals.get("intentionally_unresolved_ids", []))
        obs = [(f"GOAL:{i + 1}", g) for i, g in enumerate(goals.get("goals", []))]
        obs += [(f"OBLIGATION:{o}", o) for o in goals.get("required_obligation_ids", []) if o not in open_ids]
        if open_ids:
            review.add("INTENTIONALLY_OPEN", f"intentionally unresolved by project goals: {sorted(open_ids)}",
                       "INFO", "PASS")
        return obs


@register("H02")
class CanonVerification(SemanticCheck):
    """H02: approved canon facts (I01 snapshot -> pinned owner records) must not be violated."""

    def obligations(self, review, inputs):
        canon = inputs.get("canon_snapshot_ref")
        review.cover(canon["ref"])
        data = canon.get("data") or {}
        if data.get("auxiliary_record") is not None:
            review.add("CANON_NOT_APPROVED", "canon_snapshot_ref is an auxiliary profile import, not canon",
                       source_refs=[canon["ref"]])
            return None
        if data.get("approval_state") != "APPROVED":
            review.add("CANON_NOT_APPROVED", f"canon snapshot approval_state is {data.get('approval_state')}; only "
                                             "approved/locked canon is authoritative", "MAJOR", "UNKNOWN",
                       source_refs=[canon["ref"]])
        facts: list = []
        for ref in canon.get("source_refs") or []:
            src = review.load(ref, "canon source")
            if src is not None and src.get("data") is not None:
                review.cover(src["ref"])
                gather_facts(src["data"], facts)
        seen, obs = set(), []
        for f in facts:
            if f.get("assertion_type") != "FACT":
                continue
            oid = f"FACT:{f['subject_id']}:{f['predicate']}"
            if oid not in seen:
                seen.add(oid)
                obs.append((oid, f"{f['subject_id']} {f['predicate']} = {json.dumps(f['value'])}"))
        return obs

    def policy_lifecycle(self, review, inputs):
        return None  # canon approval is checked through approval_state above


@register("H03")
class PlotResolution(SemanticCheck):
    """H03: required plot/subplot obligations resolved or intentionally left open (B03/B14)."""

    def obligations(self, review, inputs):
        plan = inputs.get("plot_plan_ref")
        review.cover(plan["ref"])
        d = plan.get("data") or {}
        if plan["module_id"] == "B14":
            if d.get("unresolved_obligation_ids"):
                review.add("INTENTIONALLY_OPEN", f"intentionally open: {d['unresolved_obligation_ids']}", "INFO",
                           "PASS")
            ids = [o for o in d.get("resolved_obligation_ids", []) if o not in d.get("unresolved_obligation_ids", [])]
        else:
            ids = list(d.get("plot_obligations", []))
        return [(f"OBLIGATION:{o}", o) for o in dict.fromkeys(ids)]


@register("H04")
class ArcCompletion(SemanticCheck):
    """H04: intended arc milestones/end states (B05) realized in the finished work."""

    def applicability(self, ctx):
        feats = (ctx.manifest or {}).get("features", {})
        if feats.get("character_arcs") is False:
            return ("FEATURE_TRUE:character_arcs",
                    f"H04 requires character_arcs=true in feature manifest revision {ctx.manifest['revision']}")
        return None

    def obligations(self, review, inputs):
        arcs_rec = inputs.get("character_arcs_ref")
        review.cover(arcs_rec["ref"])
        obs = []
        for i, arc in enumerate((arcs_rec.get("data") or {}).get("arcs", []), 1):
            facts = arc.get("facts") or []
            if not facts:
                obs.append((f"ARC{i}", arc.get("summary") or f"arc {i}"))
            for f in facts:
                obs.append((f"ARC{i}:{f['subject_id']}:{f['predicate']}",
                            f"{f['subject_id']} {f['predicate']} = {json.dumps(f['value'])} ({f['assertion_type']})"))
        return list(dict.fromkeys(obs))


@register("H06")
class ArtworkConsistency(SemanticCheck):
    """H06: selected assets match the approved visual bible (metadata logic + vision review)."""

    capability = "vision"

    def applicability(self, ctx):
        feats = (ctx.manifest or {}).get("features", {})
        if feats.get("artwork") is True:
            return None
        ref = ctx.payload.get("asset_manifest_ref")
        rec = ctx.store.get_record(ctx.project_id, ctx.branch_id, ref["record_id"], ref["version"]) if ref else None
        assets = (aux(rec).get("data") or {}).get("assets", []) if rec else None
        if assets == [] or (rec is not None and not assets):
            return ("FEATURE_TRUE:artwork",
                    f"H06 applies only to selected art: artwork=false in feature manifest revision "
                    f"{ctx.manifest['revision']} and the asset manifest selects no assets")
        return None

    def targets(self, review, inputs):
        out = []
        am = aux(inputs.get("asset_manifest_ref")).get("data") or {}
        for ref in am.get("assets", []):
            rec = review.load(ref, "asset")
            if rec is not None:
                out.append({"id": rec["record_id"], "rec": rec, "text": None})
        return out

    def claim_targets(self, ctx, record):
        return {}

    def obligations(self, review, inputs):
        am_rec, vb_rec = inputs.get("asset_manifest_ref"), inputs.get("approved_visual_bible_ref")
        review.cover(am_rec["ref"])
        review.cover(vb_rec["ref"])
        am, vb = aux(am_rec).get("data") or {}, aux(vb_rec).get("data") or {}
        obs = []
        keys = [(r["record_id"], r["version"]) for r in am.get("assets", [])]
        if len(set(keys)) != len(keys):
            review.add("ASSET_DUPLICATE", "asset manifest lists the same asset more than once", "MAJOR")
        if len(set(am.get("placement_ids", []))) != len(am.get("placement_ids", [])):
            review.add("PLACEMENT_DUPLICATE", "duplicate placement IDs", "MAJOR")
        for ref in am.get("assets", []):
            rec = review.load(ref, "asset")
            if rec is None:
                continue
            if rec["lifecycle"] not in ("APPROVED", "LOCKED"):
                review.add("ASSET_NOT_APPROVED", f"asset {rec['record_id']} v{rec['version']} is {rec['lifecycle']}; "
                                                 "no output may silently include an unapproved asset", "MAJOR",
                           source_refs=[rec["ref"]])
            obs.append((f"ASSET:{rec['record_id']}", f"{rec['module_id']} asset v{rec['version']}"))
        obs += [(f"PLACEMENT:{p}", p) for p in am.get("placement_ids", [])]
        style = review.load(vb.get("style_ref"), "visual bible style_ref", severity="MAJOR")
        if style is not None and style["module_id"] != "D01":
            review.add("VISUAL_BIBLE", f"style_ref is {style['module_id']}; a visual style is D01", "MAJOR",
                       source_refs=[style["ref"]])
        for r in vb.get("reference_refs", []):
            if review.load(r, "visual reference", severity="MAJOR") is not None:
                review.cover(r)
        approvals = [review.load(r, "visual bible approval", severity="MAJOR") for r in vb.get("approval_refs", [])]
        if not approvals or not all(approval_valid(a)[0] for a in approvals):
            review.add("VISUAL_BIBLE", "visual bible has no valid K09/I10 approval", "MAJOR", "UNKNOWN",
                       source_refs=[vb_rec["ref"]])
        return obs

    def policy_lifecycle(self, review, inputs):
        return None  # visual bible approval is checked through approval_refs

    def ai_policy_context(self, inputs):
        am = aux(inputs.get("asset_manifest_ref")).get("data") or {}
        vb = aux(inputs.get("approved_visual_bible_ref")).get("data") or {}
        return {"asset_manifest": am, "visual_bible": vb}


# ====================================================================== H05
@register("H05")
class MissingDuplicateContent(HReport):
    """H05: selected chapter IDs/order/pins vs manuscript; empty and duplicated content."""

    def run(self, ctx, review, inputs, candidate=None):
        man, cm = inputs["manuscript_ref"], inputs["chapter_manifest_ref"]
        review.cover(cm["ref"])
        art, _ = review.json_artifact(cm, "G02Artifact", "chapter manifest")
        chunks = load_manuscript(review, man)
        if art is None:
            return None
        ids, refs = art["ordered_chapter_ids"], art["chapter_refs"]
        bad = False
        dup_ids = sorted({i for i in ids if ids.count(i) > 1})
        if dup_ids:
            review.add("DUPLICATE_CHAPTER_ID", f"chapter manifest repeats IDs {dup_ids}", source_refs=[cm["ref"]])
            bad = True
        ref_keys = [ref_key(r) for r in refs]
        if len(set(ref_keys)) != len(ref_keys):
            review.add("DUPLICATE_CHAPTER_REF", "chapter manifest selects the same chapter revision under more than "
                                                "one ID", source_refs=[cm["ref"]])
            bad = True
        if len(ids) != len(refs):
            review.add("MANIFEST_SHAPE", f"{len(ids)} chapter IDs but {len(refs)} chapter refs",
                       source_refs=[cm["ref"]])
            bad = True
        expected = dict(zip(ids, refs))
        for cid, ref in expected.items():
            rec = review.load(ref, f"chapter {cid}")
            if rec is None:
                bad = True
                continue
            review.cover(rec["ref"])
            if rec["module_id"] not in PROSE_PRODUCERS:
                review.add("CHAPTER_PRODUCER", f"chapter {cid} pins {rec['module_id']}, not C prose",
                           source_refs=[rec["ref"]])
                bad = True
            elif rec["lifecycle"] not in ("APPROVED", "LOCKED"):
                review.add("CHAPTER_NOT_APPROVED", f"chapter {cid} {rec['record_id']} v{rec['version']} is "
                                                   f"{rec['lifecycle']}", "MAJOR", source_refs=[rec["ref"]])
                bad = True
        if man["module_id"] == "G01":
            g01 = None
            try:
                binrec = ctx.record(man["data"]["artifact_ref"])
                g01 = json.loads(ctx.binary(binrec).decode("utf-8"))
            except (AkoweError, ValueError, OSError):
                g01 = None
            if g01 is not None and not same_pin(g01.get("source_manifest_ref"), cm["ref"]):
                review.add("MANUSCRIPT_MANIFEST_MISMATCH", "compiled manuscript was built from a different chapter "
                                                           "manifest pin", "MAJOR", source_refs=[man["ref"], cm["ref"]])
                bad = True
            sec_ids = [c["id"] for c in chunks]
            pin_of = {c["id"]: c["rec"]["ref"] for c in chunks}
        else:
            # A single prose record: identify its chapter by exact pin.
            sec_ids = [cid for cid, ref in expected.items() if chunks and same_pin(ref, chunks[0]["rec"]["ref"])]
            if chunks and not sec_ids:
                review.add("EXTRA_CONTENT", f"manuscript {man['record_id']} is not a selected chapter",
                           source_refs=[man["ref"]])
                bad = True
            pin_of = {cid: chunks[0]["rec"]["ref"] for cid in sec_ids}
        missing = [i for i in ids if i not in sec_ids]
        extra = [s for s in sec_ids if s not in expected]
        dup_secs = sorted({s for s in sec_ids if sec_ids.count(s) > 1})
        if missing:
            review.add("MISSING_CHAPTER", f"selected chapter(s) missing from the manuscript: {missing}",
                       source_refs=[man["ref"]])
            bad = True
        if extra:
            review.add("EXTRA_CONTENT", f"manuscript section(s) not in the chapter manifest: {extra}",
                       source_refs=[man["ref"]])
            bad = True
        if dup_secs:
            review.add("DUPLICATE_SECTION", f"manuscript repeats section(s) {dup_secs}", source_refs=[man["ref"]])
            bad = True
        got_order = [s for s in dict.fromkeys(sec_ids) if s in expected]
        want_order = [i for i in dict.fromkeys(ids) if i in sec_ids]
        if got_order != want_order:
            review.add("ORDER_MISMATCH", f"chapter order {got_order} != manifest order {want_order}",
                       source_refs=[man["ref"], cm["ref"]])
            bad = True
        for cid in sec_ids:
            if cid in expected and not same_pin(pin_of.get(cid), expected[cid]):
                review.add("CHAPTER_PIN_MISMATCH", f"section {cid} pins a different chapter revision than the "
                                                   "manifest", source_refs=[pin_of.get(cid), expected[cid]])
                bad = True
        if not bad:
            review.ok("CHAPTER_SET", f"{len(ids)} selected chapter(s) present once, in order, at manifest pins")
        # empty / duplicated content
        dup_found = False
        by_text: dict = {}
        for c in chunks:
            text = c["text"] or ""
            if not text.strip():
                review.add("EMPTY_CHAPTER", f"section {c['id']} is empty", source_refs=[c["rec"]["ref"]])
                dup_found = True
                continue
            norm = " ".join(text.split())
            if norm in by_text and by_text[norm]["rec"]["record_id"] != c["rec"]["record_id"]:
                o = by_text[norm]
                review.add("DUPLICATE_CHAPTER_TEXT", f"sections {o['id']} and {c['id']} have identical text",
                           evidence=[span_evidence(o["rec"], o["text"], 0, len(o["text"])),
                                     span_evidence(c["rec"], text, 0, len(text))])
                dup_found = True
            by_text.setdefault(norm, c)
        seen: dict = {}
        prev = None
        for c in chunks:
            for m in re.finditer(r"\S(?:.*?\S)?(?=\s*\n\s*\n|\s*$)", c["text"] or "", re.S):
                para = " ".join(m.group(0).split())
                if len(para) < 40:
                    prev = None
                    continue
                here = (c, m.start(), m.end())
                if prev is not None and prev[0] == para:
                    p = prev[1]
                    review.add("REPEATED_BLOCK", f"paragraph repeated consecutively in section {c['id']}", "MAJOR",
                               evidence=[span_evidence(p[0]["rec"], p[0]["text"], p[1], p[2]),
                                         span_evidence(c["rec"], c["text"], m.start(), m.end())])
                    dup_found = True
                elif para in seen:
                    p = seen[para]
                    review.add("DUPLICATE_BLOCK", f"paragraph in section {c['id']} duplicates one in section "
                                                  f"{p[0]['id']}", "MINOR",
                               evidence=[span_evidence(p[0]["rec"], p[0]["text"], p[1], p[2]),
                                         span_evidence(c["rec"], c["text"], m.start(), m.end())])
                seen.setdefault(para, here)
                prev = (para, here)
        if chunks and not dup_found:
            review.ok("DUPLICATE_CONTENT", f"no empty, duplicated or consecutively repeated content in "
                                           f"{len(chunks)} section(s)")
        return None


# ====================================================================== H07
@register("H07")
class PageLayoutInspection(HReport):
    """H07: page size/bleed vs PAGE_PROFILE, safe-margin crossings with page and bbox."""

    def applicability(self, ctx):
        ref = ctx.payload.get("export_ref") or {}
        if ref.get("module_id") == "G12":
            return ("PROFILE_REFLOWABLE_EPUB", "print/page layout checks are inapplicable to reflowable EPUB; "
                                               "anchor/link checks remain in H08/H09")
        return None

    def run(self, ctx, review, inputs, candidate=None):
        exp, prof_rec = inputs["export_ref"], inputs["layout_profile_ref"]
        review.cover(exp["ref"])
        review.cover(prof_rec["ref"])
        prof = aux(prof_rec).get("data") or {}
        ptype = prof.get("profile_type")
        if ptype == "EPUB_REFLOWABLE":
            review.na("PROFILE_REFLOWABLE_EPUB", "layout profile is EPUB_REFLOWABLE; page layout is not applicable")
            return None
        allowed = {"G11"} if ptype in ("MANUSCRIPT_PDF", "PRINT_INTERIOR", "PRINT_WRAP_COVER") else {"G13"}
        allowed |= set(prof.get("required_export_operations", [])) & {"G11", "G13"}
        if exp["module_id"] not in allowed:
            review.add("PROFILE_FORMAT_MISMATCH", f"{exp['module_id']} export is not produced by profile {ptype}",
                       "MAJOR", source_refs=[exp["ref"], prof_rec["ref"]])
        page_ref = prof.get("page_profile_ref")
        if page_ref is None:
            review.add("PAGE_PROFILE_MISSING", f"{ptype} requires a page profile (null only for reflowable EPUB)",
                       source_refs=[prof_rec["ref"]])
            return None
        page_rec = review.load(page_ref, "page profile")
        if page_rec is None:
            return None
        if aux_kind(page_rec) != "PAGE_PROFILE":
            review.add("PAGE_PROFILE_MISSING", "page_profile_ref is not an imported PAGE_PROFILE",
                       source_refs=[page_ref])
            return None
        review.cover(page_rec["ref"])
        page = aux(page_rec)["data"]
        if ptype in ("PRINT_INTERIOR", "PRINT_WRAP_COVER") and prof.get("printer_profile_ref") is None:
            review.add("PRINTER_PROFILE_MISSING", "print profiles require a printer profile", "MAJOR",
                       source_refs=[prof_rec["ref"]])
        binrec, data = review.follow_descriptor(exp, "export")
        if data is None:
            return None
        if exp["module_id"] == "G11":
            issues = hc.pdf_layout(data, page, print_profile=ptype in ("PRINT_INTERIOR", "PRINT_WRAP_COVER"))
        else:
            issues = hc.docx_layout(data, page)
        review.from_issues(issues, source_refs=[binrec["ref"]])
        return None


# ====================================================================== H08
def _norm_title(s: str) -> str:
    return " ".join((s or "").split()).casefold()


@register("H08")
class TocReferenceCheck(HReport):
    """H08: every TOC entry vs exact export anchors and page map; internal links resolve."""

    def run(self, ctx, review, inputs, candidate=None):
        exp, toc_rec = inputs["export_ref"], inputs["toc_manifest_ref"]
        review.cover(exp["ref"])
        review.cover(toc_rec["ref"])
        toc, _ = review.json_artifact(toc_rec, "G07Artifact", "TOC")
        binrec, data = review.follow_descriptor(exp, "export")
        if toc is None or data is None:
            return None
        entries = toc["entries"]
        if not toc["converged"]:
            review.add("TOC_NONCONVERGENCE", f"TOC did not converge after {toc['passes']} pass(es); unstable page "
                                             "numbers are never published", source_refs=[toc_rec["ref"]])
        for key in ("heading_id", "anchor_id"):
            vals = [e[key] for e in entries]
            dups = sorted({v for v in vals if vals.count(v) > 1})
            if dups:
                review.add("TOC_DUPLICATE", f"duplicate TOC {key}s {dups}", source_refs=[toc_rec["ref"]])
        if not entries:
            review.na("NO_NAVIGABLE_HEADINGS", "TOC manifest selects no navigable headings")
        fmt = hc.FORMAT_BY_PRODUCER[exp["module_id"]]
        failures = 0
        if fmt == "PDF":
            heading_pages = {}
            pag = review.load(toc["pagination_ref"], "pagination", severity="MAJOR")
            if pag is not None and pag["module_id"] == "G04":
                review.cover(pag["ref"])
                part, _ = review.json_artifact(pag, "G04Artifact", "pagination")
                if part is not None:
                    heading_pages = {h["heading_id"]: h["page"] for h in part["heading_pages"]}
            try:
                doc = hc.PdfDocument(data)
                dests = hc.pdf_named_destinations(doc)
                links = hc.pdf_internal_links(doc)
                outline = hc.pdf_outline_titles(doc)
            except (hc.PdfError, RecursionError, ValueError, TypeError, KeyError) as exc:
                review.add("PDF_STRUCTURE", f"PDF navigation cannot be read: {exc}", source_refs=[binrec["ref"]])
                return None
            for e in entries:
                target = dests.get(e["anchor_id"], "missing")
                if target == "missing":
                    review.add("TOC_ANCHOR_MISSING", f"TOC entry {e['heading_id']} anchor {e['anchor_id']!r} is not a "
                                                     "named destination in the PDF", "MAJOR")
                    failures += 1
                    continue
                if target is None:
                    review.add("TOC_ANCHOR_TARGET", f"anchor {e['anchor_id']!r} targets no page", "MAJOR")
                    failures += 1
                elif e["page"] is not None and e["page"] != target:
                    review.add("TOC_PAGE_MISMATCH", f"TOC entry {e['heading_id']} says page {e['page']} but anchor "
                                                    f"{e['anchor_id']!r} is on page {target}", "MAJOR")
                    failures += 1
                if e["page"] is not None and e["heading_id"] in heading_pages and \
                        heading_pages[e["heading_id"]] != e["page"]:
                    review.add("PAGINATION_MISMATCH", f"TOC page {e['page']} for {e['heading_id']} differs from "
                                                      f"pagination page {heading_pages[e['heading_id']]}", "MAJOR")
                    failures += 1
                if e["anchor_id"] in outline and _norm_title(outline[e["anchor_id"]]) != _norm_title(e["title"]):
                    review.add("TOC_TITLE_MISMATCH", f"outline title {outline[e['anchor_id']]!r} != TOC title "
                                                     f"{e['title']!r}", "MAJOR")
                    failures += 1
            for page_no, dest in links:
                if isinstance(dest, list):
                    ok_ = bool(dest) and (isinstance(dest[0], hc.Ref) or isinstance(dest[0], int))
                else:
                    ok_ = dests.get(hc.pdf_text(dest)) is not None
                if not ok_:
                    review.add("BROKEN_LINK", f"page {page_no}: internal link to {hc.pdf_text(dest) if not isinstance(dest, list) else dest!r} does not resolve", "MAJOR")
                    failures += 1
            checked = f"{len(entries)} TOC entr(ies) against {len(dests)} named destination(s) and {len(links)} link(s)"
        elif fmt == "EPUB":
            issues, info = hc.epub_check(data, run_external=False)
            for i in issues:
                if i["rule"] in ("EPUB_BROKEN_LINK", "EPUB_NAV") or (i["decision"] == "FAIL"
                                                                      and i["severity"] == "BLOCKING"):
                    review.add(i["rule"], i["message"], i["severity"], i["decision"], source_refs=[binrec["ref"]])
                    failures += 1
            nav_frags = [(p, f, t) for p, f, t in info.nav_links]
            order = []
            for e in entries:
                hits = [n for n in nav_frags if n[1] == e["anchor_id"]]
                if not hits:
                    review.add("NAV_ENTRY_MISSING", f"TOC entry {e['heading_id']} anchor {e['anchor_id']!r} is not in "
                                                    "the EPUB nav", "MAJOR")
                    failures += 1
                    continue
                path, frag, text = hits[0]
                order.append(nav_frags.index(hits[0]))
                if frag not in info.ids.get(path, set()):
                    review.add("TOC_ANCHOR_MISSING", f"nav target {path}#{frag} does not exist", "MAJOR")
                    failures += 1
                if _norm_title(text) != _norm_title(e["title"]):
                    review.add("TOC_TITLE_MISMATCH", f"nav text {text!r} != TOC title {e['title']!r}", "MAJOR")
                    failures += 1
            if order != sorted(order):
                review.add("NAV_ORDER", "EPUB nav order differs from the TOC manifest order", "MAJOR")
                failures += 1
            if any(e["page"] is not None for e in entries):
                review.add("PAGE_NUMBERS", "print page numbers are not applicable to reflowable EPUB navigation",
                           "INFO", "PASS")
            checked = f"{len(entries)} TOC entr(ies) against {len(nav_frags)} nav link(s)"
        else:
            issues, info = hc.docx_check(data)
            for i in issues:
                if i["rule"] == "DOCX_BROKEN_ANCHOR" or (i["decision"] == "FAIL" and i["severity"] == "BLOCKING"):
                    review.add(i["rule"], i["message"], i["severity"], i["decision"], source_refs=[binrec["ref"]])
                    failures += 1
            for e in entries:
                if e["anchor_id"] not in info.bookmarks:
                    review.add("TOC_ANCHOR_MISSING", f"TOC entry {e['heading_id']} anchor {e['anchor_id']!r} has no "
                                                     "bookmark in the DOCX", "MAJOR")
                    failures += 1
            if any(e["page"] is not None for e in entries):
                review.add("PAGE_NUMBERS", "DOCX page numbers are computed by the word processor; not verifiable "
                                           "from fixed pagination", "INFO", "PASS")
            checked = f"{len(entries)} TOC entr(ies) against {len(info.bookmarks)} bookmark(s)"
        if not failures and entries:
            review.ok("TOC_TARGETS", f"{fmt}: all {checked} resolve", source_refs=[binrec["ref"]])
        return None


# ====================================================================== H09
@register("H09")
class ExportIntegrity(HReport):
    """H09: every selected export's exact bytes, MIME/profile, staged validation and parser result."""

    def run(self, ctx, review, inputs, candidate=None):
        exports, man_rec = inputs["export_refs"], inputs["expected_manifest_ref"]
        review.cover(man_rec["ref"])
        if aux_kind(man_rec) != "RELEASE_MANIFEST":
            review.add("MANIFEST_KIND", "expected_manifest_ref is not a RELEASE_MANIFEST", source_refs=[man_rec["ref"]])
            return None
        m = aux(man_rec)["data"]
        man_exports = [r for r in m["export_refs"] if r["module_id"] in EXPORT_PRODUCERS]
        profiles = []
        for pref in m["profile_refs"]:
            prec = review.load(pref, "release profile", severity="MAJOR")
            if prec is not None and aux_kind(prec) == "OUTPUT_PROFILE":
                profiles.append(aux(prec)["data"])
        print_selected = any(p["profile_type"] in ("PRINT_INTERIOR", "PRINT_WRAP_COVER") for p in profiles)
        validator_notes = []
        for exp in exports:
            label = f"{exp['module_id']} export {exp['record_id']} v{exp['version']}"
            review.cover(exp["ref"])
            if not any(same_pin(exp["ref"], r) for r in m["export_refs"]):
                same_id = [r for r in m["export_refs"] if r["record_id"] == exp["record_id"]]
                review.add("STALE_EXPORT_PIN" if same_id else "EXPORT_NOT_IN_MANIFEST",
                           f"{label} is not the export pinned by the release manifest", source_refs=[exp["ref"]])
            atype = {"G11": "pdf_export_ref", "G12": "epub_export_ref", "G13": "docx_export_ref"}[exp["module_id"]]
            if exp["data"].get("artifact_type") not in (None, atype):
                review.add("ARTIFACT_TYPE", f"{label}: artifact_type {exp['data'].get('artifact_type')}")
            binrec, data = review.follow_descriptor(exp, label)
            vrec = review.load(exp["data"].get("validation_report_ref"), f"{label} staged validation report",
                               severity="MAJOR")
            if vrec is not None:
                review.cover(vrec["ref"])
                if vrec["module_id"] != "I04":
                    review.add("STAGED_VALIDATION", f"{label}: validation_report_ref is {vrec['module_id']}, not I04",
                               "MAJOR")
                elif not (vrec.get("data") or {}).get("valid"):
                    review.add("STAGED_VALIDATION", f"{label}: I04 staged validation reports invalid: "
                               f"{(vrec.get('data') or {}).get('violations')}"[:1900], "MAJOR")
                elif binrec is not None and not any(same_pin(binrec["ref"], r) for r in vrec.get("source_refs", [])):
                    review.add("STAGED_VALIDATION", f"{label}: I04 report does not pin this exact binary", "MAJOR")
            if data is None:
                continue
            fmt = hc.FORMAT_BY_PRODUCER[exp["module_id"]]
            src = [binrec["ref"]]
            if fmt == "PDF":
                doc, issues = hc.pdf_structure(data)
                review.from_issues(issues, src, f"{label}: ")
                if doc is not None:
                    try:
                        fonts = hc.pdf_fonts(doc)
                    except (hc.PdfError, RecursionError, ValueError, TypeError, KeyError) as exc:
                        review.add("PDF_FONTS", f"{label}: fonts unreadable: {exc}", "MAJOR", "UNKNOWN", source_refs=src)
                        fonts = []
                    missing = sorted({f.name for f in fonts if not f.embedded})
                    if missing:
                        review.add("FONT_NOT_EMBEDDED", f"{label}: fonts not embedded: {missing}",
                                   "MAJOR" if print_selected else "MINOR", source_refs=src)
            elif fmt == "EPUB":
                issues, info = hc.epub_check(data, run_external=True)
                validator_notes.append(f"epubcheck={info.validator}")
                review.from_issues(issues, src, f"{label}: ")
            else:
                issues, _ = hc.docx_check(data)
                review.from_issues(issues, src, f"{label}: ")
        checked = {(e["record_id"], e["version"], e["content_hash"]) for e in (x["ref"] for x in exports)}
        unchecked = [r for r in man_exports if ref_key(r) not in checked]
        if unchecked:
            review.add("EXPORT_NOT_CHECKED", "release manifest exports without integrity check: "
                       + ", ".join(f"{r['module_id']}:{r['record_id']} v{r['version']}" for r in unchecked))
        for p in profiles:
            need = (set(p["required_export_operations"]) | IMPLIED_EXPORTS.get(p["profile_type"], set())) \
                & set(EXPORT_PRODUCERS)
            have = {e["module_id"] for e in exports}
            for op in sorted(need - have):
                review.add("SELECTED_EXPORT_MISSING", f"profile {p['profile_id']} ({p['profile_type']}) requires a "
                                                      f"{op} export")
        if exports and not unchecked:
            review.ok("EXPORT_SET", f"{len(exports)} export(s) checked; every manifest export covered")
        review.checker_notes = validator_notes
        return Result(data={"checker_version": ";".join([CHECKER_VERSION, hc.CHECKER_VERSION] + validator_notes)})


# ====================================================================== H10
@register("H10")
class FinalReadiness(HReport):
    """H10: aggregate selected H reports against the frozen RELEASE_MANIFEST + OUTPUT_PROFILE.

    READY only when every selected mandatory check has a non-stale report that pins exactly
    the manifest's sources/exports, is PASS (NOT_APPLICABLE only with rule evidence the
    profile accepts), has no unresolved blocking/unknown finding, and the manifest carries a
    valid publication authorization covering its exact exports/sources. required_checks can
    never waive H09 or the profile's export operations. ACCEPT (release approval) requires an
    explicit K09/I10 approval for this exact H10 candidate and authoritative evidence only.
    """

    def policy_ref(self, ctx, inputs):
        return (aux(inputs["release_manifest_ref"]).get("data") or {}).get("policy_ref") \
            or inputs["release_manifest_ref"]["ref"]

    def assemble(self, ctx, review, inputs, version, policy_ref, checker=None):
        data = super().assemble(ctx, review, inputs, version, policy_ref, checker)
        data["status"] = derive_readiness(review.findings)
        return data

    def run(self, ctx, review, inputs, candidate=None):
        reports, prof_rec, man_rec = inputs["check_report_refs"], inputs["release_profile_ref"], \
            inputs["release_manifest_ref"]
        review.cover(prof_rec["ref"])
        review.cover(man_rec["ref"])
        P, M = aux(prof_rec).get("data") or {}, aux(man_rec).get("data") or {}
        features = (ctx.manifest or {}).get("features", {})
        origins: list = []

        def note_origin(rec):
            if rec is not None and rec.get("evidence_origin") != "AUTHORITATIVE":
                origins.append(f"{rec['module_id']}:{rec['record_id']} v{rec['version']}")

        for r in [prof_rec, man_rec] + reports:
            note_origin(r)
        if man_rec["lifecycle"] not in ("APPROVED", "LOCKED"):
            review.add("MANIFEST_NOT_FROZEN", f"release manifest is {man_rec['lifecycle']}; a release candidate "
                                              "must be an approved, frozen manifest", "MAJOR", "UNKNOWN",
                       source_refs=[man_rec["ref"]])
        if not any(same_pin(prof_rec["ref"], r) for r in M.get("profile_refs", [])):
            review.add("PROFILE_NOT_IN_MANIFEST", "release_profile_ref is not pinned by the release manifest",
                       source_refs=[prof_rec["ref"]])
        ptype = P.get("profile_type")
        # ---- profile rules
        if ptype != "EPUB_REFLOWABLE" and P.get("page_profile_ref") is None:
            review.add("PROFILE_RULE", f"{ptype} requires page_profile_ref (null only for reflowable EPUB)")
        if ptype in ("PRINT_INTERIOR", "PRINT_WRAP_COVER") and P.get("printer_profile_ref") is None:
            review.add("PROFILE_RULE", f"{ptype} requires a nonnull printer_profile_ref")
        if P.get("page_profile_ref") is not None:
            pg = review.load(P["page_profile_ref"], "page profile")
            if pg is not None:
                d = aux(pg).get("data") or {}
                if aux_kind(pg) != "PAGE_PROFILE" or d.get("width_mm", 0) - 2 * d.get("safe_margin_mm", 0) <= 0 or \
                        d.get("height_mm", 0) - 2 * d.get("safe_margin_mm", 0) <= 0:
                    review.add("PROFILE_RULE", "page profile must leave positive usable width/height")
        # ---- manifest pins
        frozen: dict = {}
        for key in ("source_refs", "export_refs", "profile_refs"):
            for r in M.get(key, []):
                frozen[r["record_id"]] = r
        frozen[man_rec["record_id"]] = man_rec["ref"]
        exports = []
        for r in M.get("export_refs", []):
            rec = review.load(r, f"manifest export {r['module_id']}")
            note_origin(rec)
            if rec is not None:
                exports.append(rec)
                review.cover(rec["ref"])
                a = (rec.get("data") or {}).get("artifact_ref")
                if a:
                    try:
                        note_origin(ctx.record(a))
                    except AkoweError:
                        pass
        for r in M.get("source_refs", []):
            note_origin(review.load(r, f"manifest source {r['module_id']}"))
        # ---- required exports (cannot be waived)
        prof_ops = set(P.get("required_export_operations", [])) | IMPLIED_EXPORTS.get(ptype, set())
        for op in sorted(prof_ops):
            if not any(e["module_id"] == op for e in exports):
                review.add("SELECTED_EXPORT_MISSING", f"profile {ptype} requires a {op} output in the manifest")
        if ptype == "PRINT_WRAP_COVER":
            for e in (e for e in exports if e["module_id"] == "G10"):
                art, _ = review.json_artifact(e, "G10Artifact", "print cover")
                if art is not None and (art["cover_mode"] != "PRINT" or art["spine_mm"] is None):
                    review.add("PRINT_COVER", "PRINT_WRAP_COVER needs a PRINT cover with spine from the interior "
                                              "page count")
        profile_exports = [e for e in exports if e["module_id"] in prof_ops and e["module_id"] in EXPORT_PRODUCERS]
        all_exports = [e for e in exports if e["module_id"] in EXPORT_PRODUCERS]
        # ---- applicability per check
        art_selected = bool(P.get("artwork_selected")) or features.get("artwork") is True
        listed = set(P.get("required_checks", []))
        required: dict[str, str] = {"H09": "mandatory format integrity for every actual output"}
        na: dict[str, str] = {}
        for c in sorted(listed):
            if c == "H06" and not art_selected:
                na[c] = "H06:ARTWORK_NOT_SELECTED"
            elif c == "H07" and ptype == "EPUB_REFLOWABLE":
                na[c] = "H07:PROFILE_REFLOWABLE_EPUB"
            elif c == "H04" and features.get("character_arcs") is False:
                na[c] = "H04:FEATURE_TRUE:character_arcs"
            else:
                required.setdefault(c, "selected by release profile")
        if art_selected:
            required.setdefault("H06", "artwork selected")
        if ptype == "EPUB_REFLOWABLE":
            required.setdefault("H08", "EPUB navigation is always selected")
        if any(r["module_id"] == "G07" for r in M.get("source_refs", [])):
            required.setdefault("H08", "TOC selected in the manifest")
        if any(r["module_id"] == "G02" for r in M.get("source_refs", [])):
            required.setdefault("H05", "chapter manifest selected")
        for c in ("H02", "H03", "H04"):
            if c in required or c in na:
                continue
            if c == "H04" and features.get("character_arcs") is False:
                na[c] = "H04:FEATURE_TRUE:character_arcs"
                continue
            reason = [r for r in reports if r["module_id"] == c and r["data"]["status"] == "NOT_APPLICABLE" and any(
                f["rule_id"] == f"NOT_APPLICABLE:{NA_NO_OBLIGATIONS}" for f in r["data"]["findings"])]
            if reason:
                required[c] = "NA_EVIDENCE"
            else:
                review.add("NO_OBLIGATION_REASON_MISSING", f"{c} is not selected and no explicit "
                                                           "no-selected-obligations reason is pinned", "BLOCKING",
                           "UNKNOWN")
        for c, rule in sorted(na.items()):
            review.add(f"NOT_APPLICABLE_RULE:{c}", f"{c} not applicable by rule {rule}", "INFO", "PASS")
        # ---- evaluate reports
        by_op: dict = {}
        for r in reports:
            by_op.setdefault(r["module_id"], []).append(r)
        for op, why in sorted(required.items()):
            rs = by_op.get(op, [])
            if not rs:
                review.add("REPORT_MISSING", f"{op} ({why}) has no report", "BLOCKING", "UNKNOWN")
                continue
            for r in rs:
                self._check_report(review, r, frozen, M, accept_na=(why == "NA_EVIDENCE"))
            if op == "H09":
                covered = set()
                for r in rs:
                    covered |= {ref_key(x) for x in r["data"]["source_refs"] if x["module_id"] in EXPORT_PRODUCERS}
                miss = [e for e in all_exports if ref_key(e["ref"]) not in covered]
                if miss:
                    review.add("EXPORT_NOT_CHECKED", "H09 does not cover: " + ", ".join(
                        f"{e['module_id']}:{e['record_id']} v{e['version']}" for e in miss))
            elif op in ("H07", "H08"):
                targets = [e for e in profile_exports if not (op == "H07" and e["module_id"] == "G12")]
                covered = {ref_key(r["data"]["source_refs"][0]) for r in rs}
                for e in targets:
                    if ref_key(e["ref"]) not in covered:
                        review.add("EXPORT_NOT_CHECKED", f"{op} has no report for {e['module_id']}:{e['record_id']} "
                                                         f"v{e['version']}", "BLOCKING", "UNKNOWN")
        for op, rs in sorted(by_op.items()):
            if op not in required:
                review.add("REPORT_NOT_SELECTED", f"{op} report(s) supplied but not selected by this profile",
                           "INFO", "PASS")
        # ---- publication authorization
        auth_ref = M.get("publication_authorization_ref")
        if auth_ref is None:
            review.add("PUBLICATION_AUTHORIZATION", "release manifest has no publication authorization",
                       "BLOCKING", "UNKNOWN")
        else:
            auth = review.load(auth_ref, "publication authorization")
            note_origin(auth)
            valid, why, pins = approval_valid(auth)
            if not valid:
                review.add("PUBLICATION_AUTHORIZATION", f"publication authorization invalid: {why}")
            else:
                need = [r for r in M.get("export_refs", [])] + [r for r in M.get("source_refs", [])]
                missing = [r for r in need if not any(same_pin(r, p) for p in pins)]
                if missing:
                    review.add("PUBLICATION_AUTHORIZATION", "authorization does not cover the exact candidate pins: "
                               + ", ".join(f"{r['module_id']}:{r['record_id']} v{r['version']}" for r in missing))
                else:
                    review.ok("PUBLICATION_AUTHORIZATION", "publication authorization covers every frozen export and "
                                                           "source pin")
                    review.cover(auth["ref"])
        if origins:
            review.add("FIXTURE_EVIDENCE", "non-authoritative evidence (allowed in isolated tests; release approval "
                       "refuses it): " + ", ".join(sorted(set(origins)))[:1800], "MINOR", "UNKNOWN")
        return None

    def _check_report(self, review: Review, r: dict, frozen: dict, M: dict, accept_na: bool):
        d = r["data"]
        label = f"{r['module_id']} {r['record_id']} v{r['version']}"
        review.cover(r["ref"])
        problems = 0
        if r.get("stale"):
            review.add("STALE_REPORT", f"{label} is stale: {r.get('stale_reason')}", "BLOCKING", "UNKNOWN",
                       source_refs=[r["ref"]])
            problems += 1
        need_lc = ("APPROVED", "LOCKED") if (r["module_id"] in SEMANTIC_OPS and not accept_na) \
            else ("VALIDATED", "APPROVED", "LOCKED")
        if r["lifecycle"] not in need_lc:
            review.add("REPORT_NOT_REVIEWED", f"{label} is {r['lifecycle']}; requires {'/'.join(need_lc)}",
                       "BLOCKING", "UNKNOWN", source_refs=[r["ref"]])
            problems += 1
        if d["status"] != derive_status(d["findings"], d["coverage_refs"]):
            review.add("STATUS_MISMATCH", f"{label} status is not derived from its findings", source_refs=[r["ref"]])
            problems += 1
        if accept_na:
            if d["status"] != "NOT_APPLICABLE":
                review.add("REPORT_STATUS", f"{label} is {d['status']}", source_refs=[r["ref"]])
                problems += 1
        elif d["status"] == "NOT_APPLICABLE":
            review.add("NOT_APPLICABLE_NOT_PERMITTED", f"{label} is NOT_APPLICABLE but the profile selects this "
                                                       "check", source_refs=[r["ref"]])
            problems += 1
        elif d["status"] != "PASS":
            review.add("REPORT_STATUS", f"{label} is {d['status']}", "BLOCKING",
                       "FAIL" if d["status"] == "FAIL" else "UNKNOWN", source_refs=[r["ref"]])
            problems += 1
        unresolved = [f["id"] for f in d["findings"] if f["decision"] in ("FAIL", "UNKNOWN")
                      and f["severity"] in BLOCK_SEV]
        if unresolved and d["status"] in ("PASS", "NOT_APPLICABLE"):
            review.add("UNRESOLVED_FINDING", f"{label} has unresolved blocking findings {unresolved}",
                       source_refs=[r["ref"]])
            problems += 1
        pins = list(d["source_refs"]) + list(d["coverage_refs"]) + [d["policy_ref"]] + list(r.get("source_refs") or [])
        for p in pins:
            f = frozen.get(p["record_id"])
            if f is not None and not same_pin(f, p):
                review.add("STALE_PIN", f"{label} pins {p['module_id']}:{p['record_id']} v{p['version']} but the "
                                        f"frozen manifest pins v{f['version']}", "BLOCKING", "FAIL",
                           source_refs=[r["ref"]])
                problems += 1
                break
        src0 = d["source_refs"][0] if d["source_refs"] else None
        if r["module_id"] in ("H01", "H02", "H03", "H04", "H05") and src0 is not None and not accept_na:
            if not any(same_pin(src0, x) for x in M.get("source_refs", [])):
                review.add("SOURCE_NOT_IN_MANIFEST", f"{label} reviewed {src0['module_id']}:{src0['record_id']} "
                                                     f"v{src0['version']}, which is not a frozen source",
                           source_refs=[r["ref"]])
                problems += 1
        if r["module_id"] in ("H07", "H08") and src0 is not None:
            if not any(same_pin(src0, x) for x in M.get("export_refs", [])):
                review.add("EXPORT_NOT_IN_MANIFEST", f"{label} checked an export that is not frozen in the manifest",
                           source_refs=[r["ref"]])
                problems += 1
        if r["module_id"] == "H07" and not any(same_pin(d["policy_ref"], x) for x in M.get("profile_refs", [])):
            review.add("POLICY_MISMATCH", f"{label} used a layout profile not frozen in the manifest",
                       source_refs=[r["ref"]])
            problems += 1
        if not problems:
            review.ok(f"REPORT_OK:{r['module_id']}", f"{label} {d['status']} at frozen pins", source_refs=[r["ref"]])

    # -- release approval
    def requires_explicit_approval(self, ctx, record):
        return True

    def accept_gate(self, ctx, record, approval):
        out = []
        data = record["data"]
        if data["status"] != "READY":
            out.append(ctx.finding("NOT_READY", f"H10 status is {data['status']}; only READY can be released",
                                   severity="BLOCKING"))
        appr = ctx.resolved.get("/payload/approval_ref")
        valid, why, pins = approval_valid(appr)
        if not valid:
            out.append(ctx.finding("RELEASE_APPROVAL", f"release approval invalid: {why}", severity="BLOCKING"))
        elif not any(same_pin(record["ref"], p) for p in pins):
            out.append(ctx.finding("RELEASE_APPROVAL", "approval does not pin this exact H10 candidate",
                                   severity="BLOCKING"))
        fixture = [f for f in data["findings"] if f["rule_id"] == "FIXTURE_EVIDENCE"]
        if fixture or record.get("evidence_origin") != "AUTHORITATIVE" or \
                (appr is not None and appr.get("evidence_origin") != "AUTHORITATIVE"):
            out.append(ctx.finding("FIXTURE_EVIDENCE", "release approval requires evidence_origin=AUTHORITATIVE for "
                                                       "the candidate, its evidence and the approval",
                                   severity="BLOCKING"))
        return out
