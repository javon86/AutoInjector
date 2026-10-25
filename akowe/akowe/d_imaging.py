"""Image-provider bridge for Set D with durable provider-job checkpoints.

providers.py only ships text/json adapters, so image generation is available only when an
AI slot advertises the "image" capability AND its adapter implements this duck-typed
protocol (none is bundled; tests inject one through ProviderRegistry.test_adapter):

  submit_image(slot, request: dict) -> dict      # one paid submission
  image_status(slot, provider_job_id) -> dict    # OPTIONAL status/deduplication lookup

Both return {"status": "RUNNING"|"COMPLETED"|"FAILED", "provider_job_id": str|None,
"image_bytes": bytes (COMPLETED), "mime_type": str, "license": str|None, "usage": dict}.

Checkpoint (module_state namespace "d_provider_jobs", key "<op>:<idempotency_key>") records
the submission so a retried logical request never pays twice: a known provider_job_id is
resumed through image_status; an ambiguous timeout on a provider without status support
blocks for an explicit user decision (re-run under a NEW idempotency key).
"""
from __future__ import annotations

from .canonical import sha256_json
from .d_assets import sniff_mime
from .errors import BookforgeError, error
from .modules.base import Result
from .store import utcnow

NAMESPACE = "d_provider_jobs"


def _key(ctx) -> str:
    return f"{ctx.op_id}:{ctx.request['idempotency_key']}"


def _request_hash(ctx) -> str:
    r = ctx.request
    return sha256_json({"action": r["action"], "payload": r["payload"], "input_refs": r["input_refs"]})


def _checkpoint(ctx, state: dict):
    key = _key(ctx)

    def write(tx):
        tx.put_state(ctx.project_id, ctx.branch_id, NAMESPACE, key, state)
    ctx.on_commit(write)


def _hold(ctx, status: str, code: str, message: str, unresolved: list) -> Result:
    return Result(status=status, data=None, errors=[error(code, "/payload", message)], unresolved=unresolved)


def image_slot(ctx, request: dict):
    reg = ctx.engine.providers
    est = max(1, len(str(request)) // 4)
    for slot in reg.eligible(ctx.project_id, "image", est):
        adapter = reg.adapter(slot)
        if adapter is not None and hasattr(adapter, "submit_image"):
            return slot, adapter
    return None, None


def generate(ctx, request: dict):
    """Return (bytes, mime, resource, license) or a held Result. Raises CAPABILITY_UNAVAILABLE."""
    slot, adapter = image_slot(ctx, request)
    rh = _request_hash(ctx)
    cp = ctx.get_state(NAMESPACE, _key(ctx))
    if cp is not None and cp.get("request_hash") != rh:
        raise BookforgeError("IDEMPOTENCY_CONFLICT", "/idempotency_key", "a provider job already ran under this "
                             "key for different content; use a new idempotency key", status="REJECTED")
    if cp is not None and cp["status"] in ("SUBMITTED", "AMBIGUOUS"):
        if slot is None or slot["slot_id"] != cp["slot_id"]:
            slot = next((s for s in ctx.engine.providers.slots() if s["slot_id"] == cp["slot_id"]), None)
            adapter = ctx.engine.providers.adapter(slot) if slot else None
        job = cp.get("provider_job_id")
        if not job or adapter is None or not hasattr(adapter, "image_status"):
            # Shared Contract section 5: no status/dedup support -> never silently pay again.
            return _hold(ctx, "BLOCKED", "TIMEOUT",
                         "an earlier paid image generation for this request timed out and its outcome is unknown; "
                         "the provider offers no status lookup. Re-run with a new idempotency key to pay for a new "
                         "attempt, or supply the image manually.",
                         [f"user_decision:{ctx.op_id}:retry_ambiguous_generation", f"{ctx.op_id}:manual_image"])
        try:
            res = adapter.image_status(slot, job)
        except BookforgeError as exc:
            return _hold(ctx, "BLOCKED", exc.code, f"provider status lookup for job {job} failed: {exc}",
                         [f"provider_job:{job}"])
        return _finish(ctx, slot, cp, res, rh)
    if slot is None:
        raise BookforgeError("CAPABILITY_UNAVAILABLE", "/payload", "no connected AI slot offers 'image'")
    state = {"status": "SUBMITTED", "slot_id": slot["slot_id"], "adapter_id": slot["adapter_id"],
             "provider_job_id": None, "request_hash": rh, "submitted_at": utcnow(), "attempts": 1}
    if cp is not None:  # previous attempt confirmed FAILED by the provider: a new submission is safe
        state["attempts"] = cp.get("attempts", 1) + 1
    try:
        res = adapter.submit_image(slot, request)
    except BookforgeError as exc:
        if exc.code == "TIMEOUT":
            state["status"] = "AMBIGUOUS"
            _checkpoint(ctx, state)
            return _hold(ctx, "BLOCKED", "TIMEOUT", "image provider timed out; the paid generation may have run. "
                         "Retrying this request resumes from the checkpoint instead of paying again.",
                         [f"{ctx.op_id}:provider_checkpoint"])
        raise
    return _finish(ctx, slot, state, res, rh)


def _finish(ctx, slot, state: dict, res: dict, rh: str):
    state = dict(state, provider_job_id=res.get("provider_job_id") or state.get("provider_job_id"),
                 request_hash=rh, updated_at=utcnow())
    status = res.get("status")
    if status == "RUNNING":
        state["status"] = "SUBMITTED"
        _checkpoint(ctx, state)
        return _hold(ctx, "PARTIAL", "TIMEOUT", f"provider job {state['provider_job_id']} is still running; resume "
                     "this request later", [f"provider_job:{state['provider_job_id']}"])
    if status == "FAILED":
        state["status"] = "FAILED"
        _checkpoint(ctx, state)
        return _hold(ctx, "BLOCKED", "UPSTREAM_UNAVAILABLE", "the provider reported the image job as failed; "
                     "retry or supply the image manually", [f"{ctx.op_id}:manual_image"])
    if status != "COMPLETED" or not isinstance(res.get("image_bytes"), (bytes, bytearray)):
        raise BookforgeError("INTERNAL_ERROR", "", "image provider returned an unclassified result")
    blob = bytes(res["image_bytes"])
    mime = sniff_mime(blob)
    if mime is None or (res.get("mime_type") and res["mime_type"] != mime):
        raise BookforgeError("INTERNAL_ERROR", "", "image provider returned bytes that are not the declared image "
                             "type")
    state["status"] = "COMPLETED"
    _checkpoint(ctx, state)
    usage = res.get("usage") or {}
    resource = {"resource_kind": "AI", "ai_slot": slot["slot_id"], "adapter_id": slot["adapter_id"],
                "capability": "image", "provider_job_id": state["provider_job_id"], "usage": usage, "at": utcnow()}
    return blob, mime, resource, res.get("license")
