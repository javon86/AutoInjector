"""C-owned event candidate bundles (Shared Contract sections 3, 9 and 10).

C02-C11 prose OUTPUT always has candidate_events=[]. Extracted candidate events live in a
separate C-owned record of record_kind "CEventBundle" whose prose_ref, every event.source_ref
and every evidence span record_ref pin the already-stored prose revision. The bundle's own
hash is never cited inside it, so there is no self-reference.

Two paths create a bundle, both committing through the storage kernel:

* In the prose CREATE itself. The handler pre-allocates the prose record ID and predicts the
  prose pin exactly as the kernel will hash it (``predict_output_ref``). The kernel inserts the
  prose record first and then the staged bundle in the same transaction, so one logical
  receipt lists both output IDs and a duplicate delivery replays both. A commit hook verifies
  the stored prose hash equals the predicted pin (a mismatch rolls the whole commit back).
* ``extract_event_bundle`` for an existing prose pin. If extraction failed during CREATE (no
  AI slot, provider timeout, or the author wants to enter events manually) the prose record
  is still committed as a DRAFT checkpoint with candidate_events=[], and this resumable step
  adds the bundle later without repeating paid prose generation.

Extraction itself is AI (or manual author input). Code never invents events: it only
normalizes what the AI/author supplied, re-anchors quoted evidence by exact substring, drops
events whose evidence cannot be anchored or whose path is unregistered (with findings), and
assigns deterministic event/span IDs. Spans are Unicode code point offsets [start, end) with
text_hash = SHA-256 of that exact substring.
"""
from __future__ import annotations

import copy
from . import CONTRACT_VERSION
from .canonical import canonical_bytes, make_reference, sha256_bytes, sha256_text
from .errors import BookforgeError

PROSE_OPS = ("C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09", "C10", "C11")
EXTRACTION_NS = "c_extraction"
BUNDLE_KIND = "CEventBundle"

SCALAR_OR_LIST = {"anyOf": [{"type": "string"}, {"type": "number"}, {"type": "boolean"}, {"type": "null"},
                            {"type": "array", "items": {"type": ["string", "number", "boolean", "null"]}}]}

# What the AI (or a manual author) supplies per event; code completes the typed Event.
RAW_EVENT_SCHEMA = {
    "type": "object",
    "properties": {
        "events": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "entity_id": {"type": "string"},
                    "path": {"type": "string"},
                    "operation": {"enum": ["SET", "ADD", "REMOVE"]},
                    "before": SCALAR_OR_LIST,
                    "after": SCALAR_OR_LIST,
                    "story_time": {"type": "integer"},
                    "scene_id": {"type": "string"},
                    "scene_order": {"type": "integer"},
                    "event_order": {"type": "integer"},
                    "evidence": {"type": "array", "items": {
                        "type": "object",
                        "properties": {"start": {"type": "integer"}, "end": {"type": "integer"},
                                       "quote": {"type": "string"}},
                        "required": ["quote"]}},
                },
                "required": ["entity_id", "path", "operation", "before", "after", "story_time", "scene_id",
                             "scene_order", "event_order", "evidence"],
            },
        },
    },
    "required": ["events"],
}

RAW_FIELDS = ("entity_id", "path", "operation", "before", "after", "story_time", "scene_id", "scene_order",
              "event_order", "evidence")


def event_paths(ctx) -> dict:
    return dict(ctx.contracts.predicate_registry.get("event_paths", {}))


def predict_output_ref(ctx, result) -> dict:
    """The exact Reference the kernel will assign to this CREATE's OUTPUT record (version 1).

    Mirrors store.insert_json_record: sha256 of canonical {project, branch, owner, module,
    record_id, version, contract_version, data, source_refs}; source_refs as engine computes.
    """
    if not result.record_id:
        raise BookforgeError("INTERNAL_ERROR", "", "prose record ID must be pre-allocated")
    source_refs = ctx.engine._source_refs(ctx, result)
    body = {"project_id": ctx.project_id, "branch_id": ctx.branch_id, "owner": ctx.op_id[0],
            "module_id": ctx.op_id, "record_id": result.record_id, "version": 1,
            "contract_version": CONTRACT_VERSION, "data": result.data, "source_refs": source_refs}
    return make_reference(ctx.project_id, ctx.branch_id, ctx.op_id, result.record_id, 1,
                          sha256_bytes(canonical_bytes(body)))


def make_span(prose_ref: dict, text: str, start: int, end: int, span_id: str) -> dict:
    return {"record_ref": prose_ref, "span_id": span_id, "start": start, "end": end,
            "text_hash": sha256_text(text[start:end])}


def _anchor(text: str, ev: dict) -> tuple[int, int] | str:
    """Return (start, end) for one evidence item or an error rule id."""
    quote = ev.get("quote")
    start, end = ev.get("start"), ev.get("end")
    if isinstance(quote, str) and quote:
        if isinstance(start, int) and isinstance(end, int) and 0 <= start <= end <= len(text) \
                and text[start:end] == quote:
            return start, end
        hits, i = [], text.find(quote)
        while i != -1:
            hits.append(i)
            i = text.find(quote, i + 1)
        if len(hits) == 1:
            return hits[0], hits[0] + len(quote)
        return "SPAN_NOT_FOUND" if not hits else "SPAN_CONFLICT"
    if isinstance(start, int) and isinstance(end, int) and 0 <= start < end <= len(text):
        return start, end
    return "SPAN_INVALID"


def build_bundle(ctx, prose_ref: dict, text: str, raw_events: list, *, op_id: str) -> tuple[dict, list]:
    """Normalize AI/manual raw events into a CEventBundle for prose_ref.

    Returns (bundle, findings). Events whose evidence cannot be anchored exactly, whose path
    is not in predicate_registry.event_paths, or that address several entities are left out
    with a finding; nothing is invented.
    """
    paths = event_paths(ctx)
    findings: list[dict] = []
    events: list[dict] = []
    rid, ver = prose_ref["record_id"], prose_ref["version"]
    seen_ids: set[str] = set()
    for n, raw in enumerate(raw_events):
        if not isinstance(raw, dict) or any(k not in raw for k in RAW_FIELDS if k != "evidence"):
            findings.append(ctx.finding("EVENT_SHAPE", f"event #{n} lacks required typed fields; not extracted",
                                        severity="MAJOR", decision="UNKNOWN"))
            continue
        if raw["path"] not in paths:
            findings.append(ctx.finding(
                "UNKNOWN_PREDICATE", f"event #{n} path {raw['path']!r} has no registered event_paths mapping; "
                "left for review", severity="MAJOR", decision="UNKNOWN"))
            continue
        entity = raw.get("entity_id")
        if not isinstance(entity, str) or not entity:
            findings.append(ctx.finding("EVENT_ENTITY", f"event #{n} must address exactly one entity",
                                        severity="MAJOR", decision="FAIL"))
            continue
        spans, bad = [], None
        for k, ev in enumerate(raw.get("evidence") or []):
            anchored = _anchor(text, ev if isinstance(ev, dict) else {})
            if isinstance(anchored, str):
                bad = anchored
                break
            spans.append(make_span(prose_ref, text, anchored[0], anchored[1], f"{rid}-v{ver}-sp{n:03d}-{k}"))
        if bad or not spans:
            findings.append(ctx.finding(
                bad or "SPAN_MISSING", f"event #{n} evidence cannot be anchored to an exact substring of the "
                "prose; not extracted", severity="MAJOR", decision="UNKNOWN"))
            continue
        event_id = raw.get("event_id") or f"{rid}-v{ver}-ev{n:03d}"
        if event_id in seen_ids:
            findings.append(ctx.finding("DUPLICATE_EVENT_ID", f"event id {event_id} repeated; second dropped",
                                        severity="MAJOR", decision="FAIL"))
            continue
        seen_ids.add(event_id)
        events.append({
            "event_id": event_id, "scene_id": raw["scene_id"], "branch_id": ctx.branch_id,
            "story_time": raw["story_time"], "scene_order": raw["scene_order"], "event_order": raw["event_order"],
            "entity_ids": [entity], "operation": raw["operation"], "path": raw["path"],
            "before": copy.deepcopy(raw["before"]), "after": copy.deepcopy(raw["after"]),
            "source_ref": prose_ref, "evidence": spans, "status": "CANDIDATE",
        })
    if op_id == "C08":
        for ev in events:
            findings.append(ctx.finding(
                "TRANSITION_EVENT", f"transition prose implies state change {ev['event_id']}; transitions must "
                "not invent intervening events - review", severity="MAJOR", decision="UNKNOWN",
                evidence=ev["evidence"], source_refs=[prose_ref]))
    bundle = {"prose_ref": prose_ref, "events": events, "extraction_findings": findings}
    errs = ctx.contracts.check_shared(BUNDLE_KIND, bundle)
    if errs:
        raise BookforgeError("INVALID_INPUT", errs[0]["path"],
                             f"event bundle invalid: {errs[0]['message']}", status="REJECTED")
    return bundle, findings


def ai_extract(ctx, text: str, *, op_id: str, hints: dict | None = None) -> tuple[list, dict]:
    """Ask the selected AI slot for raw events. Raises CAPABILITY_UNAVAILABLE without a slot."""
    paths = event_paths(ctx)
    preds = ctx.contracts.predicate_registry.get("predicates", {})
    vocab = {p: {"predicate": pred, **{k: v for k, v in preds.get(pred, {}).items()}} for p, pred in paths.items()}
    task = ("Extract story-state change events stated explicitly in the prose. One event per entity. Use only "
            "these paths: " + ", ".join(sorted(paths)) + ". SET replaces the value (give full before/after); "
            "ADD/REMOVE change exactly one list item with the full old list as before and full new list as "
            "after. Use null before when the prior value is not established. evidence.quote must be an exact, "
            "unique substring of the prose. Do not infer events that the prose does not state. Return JSON only.")
    context = {"prose": text, "event_path_vocabulary": vocab, "hints": hints or {}}
    out, resource = ctx.ai_generate(task=task, output_schema=RAW_EVENT_SCHEMA, context=context)
    events = out.get("events") if isinstance(out, dict) else None
    if not isinstance(events, list):
        raise BookforgeError("UPSTREAM_UNAVAILABLE", "", "AI extraction returned no event list")
    return events, resource


def find_bundles(store, project_id: str, branch_id: str, prose_ref: dict) -> list[dict]:
    """C-owned bundles whose prose_ref is exactly this prose pin."""
    out = []
    for rec in store.list_records(project_id, branch_id, module_id=prose_ref["module_id"], record_kind=BUNDLE_KIND):
        if rec["owner"] == "C" and (rec["data"] or {}).get("prose_ref") == prose_ref:
            out.append(rec)
    return out


def _state_revision(store, project_id, branch_id, namespace, key) -> int:
    row = store.query_one("SELECT revision FROM module_state WHERE project_id=? AND branch_id=? AND namespace=? "
                          "AND key=?", (project_id, branch_id, namespace, key))
    return row["revision"] if row else 0


def extraction_key(prose_ref: dict) -> str:
    return f"{prose_ref['record_id']}:{prose_ref['version']}"


def extract_event_bundle(engine, principal_id: str, prose_ref: dict, *, events: list | None = None,
                         request_id: str | None = None) -> dict:
    """Resumable bundle creation against an existing C prose pin (no prose regeneration).

    events=None asks the AI slot; a list supplies manual raw events (same shape as the AI
    output). Commits bundle + provenance + audit + outbox + dependency edge atomically and
    records the extraction checkpoint DONE; a repeated call for a completed pin replays the
    stored response (same bundle ID). Returns a RESPONSE-shaped dict.
    """
    from .modules.base import Context
    from .requests import build_request
    from .store import new_id

    attempt_id = new_id("attempt")
    request_id = request_id or new_id("req")
    try:
        op = prose_ref.get("module_id")
        if op not in PROSE_OPS:
            raise BookforgeError("INVALID_INPUT", "/prose_ref/module_id", "event bundles derive from C02-C11 prose",
                                 status="REJECTED")
        project_id, branch_id = prose_ref["project_id"], prose_ref["branch_id"]
        engine._authorize(principal_id, project_id, branch_id, f"{op}:create")
        rec = engine.resolve_ref(prose_ref, project_id, branch_id, "/prose_ref")
        if rec["record_kind"] != "OUTPUT":
            raise BookforgeError("INVALID_INPUT", "/prose_ref", "a bundle is not prose; pin the prose record",
                                 status="REJECTED")
        key = extraction_key(prose_ref)
        state = engine.store.get_state(project_id, branch_id, EXTRACTION_NS, key)
        if state and state.get("status") == "DONE" and state.get("response"):
            return state["response"]
        req = build_request(project_id=project_id, branch_id=branch_id, op_id=op, action="CREATE",
                            principal_id=principal_id, payload={}, request_id=request_id)
        ctx = Context(engine, req, principal_id, action="CREATE")
        ctx.resolved["/prose_ref"] = rec
        text = rec["data"]["text"]
        resource, transform = None, "MANUAL"
        if events is None:
            try:
                events, resource = ai_extract(ctx, text, op_id=op)
                transform = "AI"
            except BookforgeError as exc:
                if exc.code == "CAPABILITY_UNAVAILABLE":
                    raise BookforgeError("CAPABILITY_UNAVAILABLE", "/events",
                                         "event extraction needs an AI slot or manual events",
                                         unresolved=[f"{op}:event_extraction"]) from exc
                raise
        bundle, findings = build_bundle(ctx, rec["ref"], text, events, op_id=op)
        bundle_ref = ctx.stage_json(op, bundle, record_kind=BUNDLE_KIND, source_refs=[rec["ref"]])
        response = engine._response(request_id, attempt_id, "DRAFT", [bundle_ref], bundle, findings, [],
                                    [rec["ref"]], [], None)
        rev = _state_revision(engine.store, project_id, branch_id, EXTRACTION_NS, key)
        provenance_id = new_id("prov")
        with engine.store.transaction() as tx:
            refs = engine._insert_staged(ctx, tx, provenance_id)
            tx.insert_provenance(provenance_id=provenance_id, ref=refs[0], operation_id=op, request_id=request_id,
                                 attempt_id=attempt_id, principal_id=principal_id, input_refs=[rec["ref"]],
                                 transform=transform, resource=resource)
            tx.insert_edge(project_id=project_id, branch_id=branch_id, producer_ref=rec["ref"],
                           consumer_operation=op, consumer_ref=refs[0], paths=["/text"], kind="HARD", stage="DRAFT")
            tx.put_state(project_id, branch_id, EXTRACTION_NS, key,
                         {"status": "DONE", "bundle_ref": refs[0], "response": response}, expected_revision=rev)
            audit_id = tx.insert_audit(project_id=project_id, branch_id=branch_id, request_id=request_id,
                                       attempt_id=attempt_id, operation_id=op, action="CREATE",
                                       principal_id=principal_id, input_refs=[rec["ref"]], output_refs=refs,
                                       outcome="SUCCESS", evidence_type="COMMITTED_OUTPUT",
                                       evidence_origin="AUTHORITATIVE")
            tx.insert_outbox(project_id, branch_id, "record.created",
                             {"operation_id": op, "output_refs": refs, "audit_id": audit_id,
                              "request_id": request_id, "record_kind": BUNDLE_KIND})
        return response
    except BookforgeError as exc:
        return engine._error_response(request_id, attempt_id, exc.errors, exc.status, exc.findings, exc.unresolved)

