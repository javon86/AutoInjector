# Developing Bookforge

Bookforge is one Python application with 11 independently owned modules (sets A-K, 142
operations) sharing a transactional storage kernel. It implements the BookForge Final Build
Plan (contract `BF-IRB-1.0.0`, closure `BF-CLOSURE-1.1`) bundled in `package/`.

## Layout

```
bookforge/
  package/                 delivered blueprint: contracts.zip (schemas, registries, cases),
                           Specifications/*.md, Build_Plan.md
  bookforge/
    canonical.py           canonical JSON + SHA-256, Reference helpers, JSON Pointer utils
    contracts.py           loads contracts.zip; per-op schema validators; error mapping
    store.py               SQLite storage kernel (records, heads, lifecycle, receipts,
                           audit, outbox, provenance, approvals, edges, module_state)
    engine.py              dispatch pipeline for all operations (see module docstring)
    providers.py           AI-1..AI-3 slots, Anthropic + AutoInjector bridge adapters, roles,
                           retry policy
    modules/base.py        OperationHandler / Context / Result (the handler API)
    modules/set_a.py ...   per-set domain handlers (set_a .. set_k)
    exporters/             PDF / EPUB / DOCX writers (pure Python)
    server.py, web/        local HTTP API + browser workspace
  tests/                   pytest suite (conftest.py has the Harness fixture `h`)
```

## Rules for module code

* Edit only your set's files: `bookforge/modules/set_<x>.py`, optional helpers in a new
  `bookforge/<x>_*.py` or `bookforge/exporters/`, and `tests/test_set_<x>.py`.
  Do not change engine.py / store.py / base.py / contracts.py / server.py; propose kernel
  changes instead.
* Read `package/Specifications/Shared_Contract.md` and your set's
  `Bookforge_Set_<X>_Final.md` (the "Set rules" section holds the real semantics; the
  per-operation sections are uniform boilerplate). Schemas: `get_package().schema(op)`.
* LOGIC operations are deterministic and never call an AI slot. AI/HYBRID creative work
  uses `OperationHandler.generate` (AI slot) or a manual candidate; never fabricate
  creative content in code.
* Never fabricate approvals or evidence; findings carry real evidence.
* Errors: raise `BookforgeError(code, json_pointer, message, status=...)` with codes from
  `errors.py`. BLOCKED for missing deps/capabilities/approvals; REJECTED for invalid input.

## Handler API (modules/base.py)

```python
from . import register
from .base import Context, OperationHandler, Result

@register("X01", "X02")
class MyHandler(OperationHandler):
    def applicability(self, ctx): ...            # -> (rule_id, reason) to return NOT_APPLICABLE
    def create(self, ctx) -> Result: ...         # build OUTPUT data (kernel validates & commits)
    def update(self, ctx) -> Result: ...         # full replacement (default: payload as-is)
    def validate(self, ctx, record) -> list: ... # owner semantic findings (ctx.finding(...))
    def accept_gate(self, ctx, record, approval) -> list: ...   # BLOCKING findings refuse ACCEPT
    def requires_explicit_approval(self, ctx, record) -> bool: ...
    def on_accept(self, ctx, record, tx): ...    # runs inside the ACCEPT transaction
```

Context gives: `ctx.payload`, `ctx.op_id`, `ctx.project_id`, `ctx.branch_id`,
`ctx.principal_id`, `ctx.manifest` (feature manifest), `ctx.manual_candidate`,
`ctx.resolved` (JSON-pointer -> stored record for every Reference in the request; already
checked for pin/owner/hash/producer binding/OUTPUT validity), `ctx.field_record("x_ref")`,
`ctx.field_records("x_refs")`, `ctx.record(ref)`, `ctx.binary(rec)` (verified bytes),
`ctx.records_of("A04", approved_only=True)`, `ctx.finding(rule_id, message, severity=,
decision=, evidence=, source_refs=, confidence=)`, `ctx.get_state(ns, key)`.

Writes are staged and committed atomically with the operation output:
`ctx.stage_json(module_id, data, record_kind="OUTPUT"|"CEventBundle"|"MapGraph"|...)`,
`ctx.stage_revision(record, data)`, `ctx.stage_binary(module_id, bytes, mime)` all return
the final canonical Reference immediately. `ctx.on_commit(lambda tx: tx.put_state(...))`
runs inside the same transaction (module-private durable state with CAS).

A stored record dict has: record_id, version, module_id, owner, record_kind,
representation (JSON_RECORD|BINARY_ARTIFACT), data, source_refs, content_hash, lifecycle
(DRAFT|VALIDATED|APPROVED|LOCKED|SUPERSEDED|REJECTED), stale, approved_version,
latest_version, ref (canonical Reference), binary (metadata for binaries).

Manual mode: the API accepts `manual_candidate` (a full OUTPUT document) alongside a CREATE
request; the base handler uses it after the kernel validates it against OUTPUT.

## AI slots, adapters and roles

* Adapters: `none`, `anthropic`, `manual`, `autoinjector` (experimental; local HTTP bridge to the
  AutoInjector desktop app, contract `../docs/BOOKFORGE_AUTOINJECTOR_BRIDGE.md`). Autoinjector
  slots need `site` (chatgpt|claude|gemini) and `bridge_url` (http://127.0.0.1 or
  http://localhost only, default `http://127.0.0.1:17891`); the bridge token uses the
  write-only `api_key` secret. They cost 0 and run one request at a time.
* `roles` (operation IDs like `C02` or set letters like `B`): when any eligible slot's roles
  match the operation, only those slots are used (`ProviderRegistry.eligible(...,
  operation)`); K11 applies the same rule using the K05 job's operation.
* Adapters that set `accepts_request_context = True` get `request_id`, `attempt`,
  `deadline` and `call` keywords in `submit()`; plain `submit(slot, system, user, schema)`
  adapters (and test fakes) keep working.
* The server listens on port 8780 by default (`--port`, `BOOKFORGE_PORT`).
  `POST /api/slots/connect-autoinjector` and `GET /api/slots/{id}/health` serve the Settings page.

## Tests

`python -m pytest -q tests` . Use the `h` fixture (tests/conftest.py): `h.create(op, payload)`,
`h.dispatch(op, action, ...)`, `h.validate(ref)`, `h.accept(ref)`, `h.approve(ref)`,
`h.create_approved(op, payload, manual_candidate=...)`, `h.set_features(magic=True)`.
For AI paths set `engine.providers.test_adapter` to a fake with
`submit(slot, system, user, schema) -> (dict, usage)` and configure a slot
(`engine.providers.configure_slot("AI-1", {"adapter_id": "anthropic"})`).
