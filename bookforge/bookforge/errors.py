"""Error model (Shared Contract section 5)."""
from __future__ import annotations

ERROR_CODES = {
    "MISSING_INPUT", "INVALID_INPUT", "NOT_FOUND", "VERSION_CONFLICT", "HASH_MISMATCH",
    "PERMISSION_DENIED", "UNSUPPORTED_CONTRACT", "UPSTREAM_UNAVAILABLE", "CAPABILITY_UNAVAILABLE",
    "TIMEOUT", "RATE_LIMITED", "INTERNAL_ERROR", "IDEMPOTENCY_CONFLICT", "EVENT_CONFLICT",
    "APPROVAL_REQUIRED", "EXPIRED_APPROVAL", "LOCKED_FACT", "SPAN_CONFLICT", "PATCH_OVERLAP",
    "DEPENDENCY_CYCLE", "LEASE_EXPIRED", "QUOTA_EXCEEDED", "CONTEXT_TOO_LARGE",
    "VALIDATOR_UNAVAILABLE", "TOC_NONCONVERGENCE",
}

RETRYABLE = {"TIMEOUT", "UPSTREAM_UNAVAILABLE", "RATE_LIMITED"}


def error(code: str, path: str = "", message: str | None = None) -> dict:
    if code not in ERROR_CODES:
        raise ValueError(f"unknown error code {code}")
    return {
        "code": code,
        "path": path,
        "message": message or code.replace("_", " ").lower(),
        "retryable": code in RETRYABLE,
    }


class BookforgeError(Exception):
    """Raised inside the kernel/handlers to abort an action with one or more errors.

    status selects the response status; BLOCKED is used for missing dependencies,
    capabilities or approvals (Shared Contract section 4), never APPROVED.
    """

    def __init__(self, code: str, path: str = "", message: str | None = None,
                 status: str = "BLOCKED", extra_errors: list | None = None,
                 findings: list | None = None, unresolved: list | None = None):
        super().__init__(message or code)
        self.errors = [error(code, path, message)] + list(extra_errors or [])
        self.status = status
        self.findings = list(findings or [])
        self.unresolved = list(unresolved or [])

    @property
    def code(self) -> str:
        return self.errors[0]["code"]
