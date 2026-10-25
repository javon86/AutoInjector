"""Approval and waiver checks shared by Set F and Set J handlers.

Approvals are read from authoritative K09 (Approval Checkpoints) or I10 (Canon Approval/Lock)
records; F/J never create approvals themselves. A waiver (Contracts/shared/Waiver.schema.json)
binds the exact finding/source/action hashes and an expiry; schema, ownership, stale base,
hash mismatch and protected-lock violations are never waivable (Shared Contract section 9).
"""
from __future__ import annotations

from datetime import datetime, timezone

from .canonical import sha256_json
from .errors import AkoweError

APPROVAL_MODULES = ("K09", "I10")

# Rule IDs / error codes whose findings can never be waived.
NONWAIVABLE = {"SCHEMA", "OWNERSHIP", "STALE", "VERSION_CONFLICT", "HASH_MISMATCH", "SOURCE_PIN",
               "LINK_RESOLUTION", "LOCKED_FACT", "PROTECTED_LOCK", "PROTECTED_FACT_CHANGE", "SPAN_CONFLICT"}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def approval_view(rec: dict) -> dict:
    """Normalize a K09/I10 record into {decision, expiry, subjects, approval_id}."""
    data = rec.get("data") or {}
    if rec["module_id"] == "K09":
        return {"decision": data.get("decision"), "expiry": data.get("expiry"),
                "subjects": list(rec.get("source_refs") or []), "approval_id": data.get("approval_id"),
                "scopes": [], "body": None}
    if rec["module_id"] == "I10":
        body = data.get("approval") or {}
        decision = "REVOKED" if body.get("revoked") else body.get("decision")
        subj = body.get("subject_ref")
        return {"decision": decision, "expiry": body.get("expires_at"), "subjects": [subj] if subj else [],
                "approval_id": body.get("approval_id"), "scopes": list(body.get("scopes") or []), "body": body}
    raise AkoweError("INVALID_INPUT", "/module_id", "approval must be a K09 or I10 decision record",
                         status="REJECTED")


def covers(view: dict, ref: dict) -> bool:
    return any(s.get("record_id") == ref["record_id"] and s.get("version") == ref["version"]
               and s.get("content_hash") == ref["content_hash"] for s in view["subjects"])


def check_approval(rec: dict, path: str, subject: dict | None = None, now: datetime | None = None) -> dict:
    """Raise unless rec is an APPROVED, unrevoked, unexpired decision (covering subject if given)."""
    if rec["module_id"] not in APPROVAL_MODULES:
        raise AkoweError("APPROVAL_REQUIRED", path, "approval must be a K09 or I10 decision record")
    view = approval_view(rec)
    if view["decision"] != "APPROVED":
        raise AkoweError("APPROVAL_REQUIRED", path, f"approval decision is {view['decision']}")
    if not view["expiry"] or parse_time(view["expiry"]) <= (now or now_utc()):
        raise AkoweError("EXPIRED_APPROVAL", path, "approval has expired; a renewed authorization is required")
    if subject is not None and not covers(view, subject):
        raise AkoweError("APPROVAL_REQUIRED", path, "approval does not cover this exact revision; prior "
                             "approval cannot authorize changed output")
    return view


def approval_problem(rec: dict, subject: dict | None = None) -> tuple[str, str] | None:
    """Non-raising variant: (code, message) or None."""
    try:
        check_approval(rec, "", subject)
    except AkoweError as exc:
        return exc.code, exc.errors[0]["message"]
    return None


# ---------------------------------------------------------------------------- waivers
def finding_hash(finding: dict) -> str:
    """Hash of the finding's substance (excluding its volatile sequence id)."""
    return sha256_json({k: finding.get(k) for k in ("rule_id", "severity", "decision", "message", "evidence",
                                                     "source_refs")})


def waiver_action_hash(finding: dict, record_ref: dict, action: str = "WAIVE") -> str:
    return sha256_json({"action": action, "finding": finding_hash(finding), "record": record_ref})


def waivable(finding: dict) -> bool:
    rule = finding.get("rule_id", "")
    return not any(rule == n or rule.endswith("-" + n) or rule.startswith(n + ":") for n in NONWAIVABLE)


def waiver_applies(waiver: dict, finding: dict, record_ref: dict, source_refs: list,
                   now: datetime | None = None) -> tuple[bool, str]:
    """True when the waiver binds exactly this finding/record/sources and is unexpired."""
    if not waivable(finding):
        return False, f"{finding.get('rule_id')} is nonwaivable"
    try:
        if parse_time(waiver["expires_at"]) <= (now or now_utc()):
            return False, "waiver expired"
    except (KeyError, ValueError):
        return False, "waiver expiry invalid"
    fr = waiver.get("finding_ref") or {}
    if (fr.get("record_id"), fr.get("version"), fr.get("content_hash")) != (
            record_ref["record_id"], record_ref["version"], record_ref["content_hash"]):
        return False, "waiver pins a different record revision"
    if waiver.get("action_hash") != waiver_action_hash(finding, record_ref):
        return False, "waiver action hash does not bind this exact finding"
    want = {(r["record_id"], r["version"], r["content_hash"]) for r in source_refs}
    have = {(r["record_id"], r["version"], r["content_hash"]) for r in waiver.get("source_refs") or []}
    if want != have:
        return False, "waiver source pins differ from the checked sources"
    return True, "waived"
