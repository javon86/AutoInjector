"""Helpers that build canonical wire requests (used by the web API, CLI and tests)."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from . import CONTRACT_VERSION


def build_request(*, project_id: str, branch_id: str, op_id: str, action: str, principal_id: str,
                  payload: dict | None = None, base_ref: dict | None = None, input_refs: list | None = None,
                  idempotency_key: str | None = None, request_id: str | None = None,
                  correlation_id: str | None = None, causation_id: str | None = None,
                  timeout_ms: int = 180000) -> dict:
    request_id = request_id or f"req-{uuid.uuid4().hex[:16]}"
    deadline = datetime.now(timezone.utc) + timedelta(milliseconds=timeout_ms)
    return {
        "contract_version": CONTRACT_VERSION,
        "project_id": project_id,
        "branch_id": branch_id,
        "request_id": request_id,
        "correlation_id": correlation_id or request_id,
        "causation_id": causation_id,
        "source_set": op_id[0],
        "target_operation": op_id,
        "action": action,
        "input_refs": list(input_refs or []),
        "principal_id": principal_id,
        "deadline": deadline.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "idempotency_key": idempotency_key or f"idem-{uuid.uuid4().hex}",
        "base_ref": base_ref,
        "payload": payload if payload is not None else {},
    }


def candidate_payload(ref: dict, approval_ref: dict | None = None) -> dict:
    out = {"candidate_ref": ref}
    if approval_ref is not None:
        out["approval_ref"] = approval_ref
    return out
