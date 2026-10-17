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
    assist.py              "Fill with AI" proposals (never committed) and the Bible Builder
                           (supports(): A + AI/HYBRID ops of B/C/D/F/G with fillable fields;
                           Bible runs accept optional per-run `guidance`)
    sets_guide.py          SET_GUIDE: plain-language data per set (name, icon, purpose, build order,
                           depends_on, op order, featured actions) -> GET /api/sets[?project_id&branch_id]
                           with per-op counts and "what's next" along the build-plan vertical slice
    book_path.py           book profile (GET/PUT /api/projects/{id}/profile, settings key
                           book_profile:<pid>) and "Make my book" (GET/POST .../branches/{b}/book[/action]);
                           every step is a normal engine.dispatch; approvals only with author_confirms
    review.py              review queue (GET .../branches/{b}/review), "Current task" (current_task() from
                           BookPath.status()), approvals via BookPath.a_approve/approve_ref, AI reviewer + "fix"
                           jobs through AssistService._call_ai, opt-in auto-approve (settings review_settings:<pid>),
                           WorkTracker ("working on")
    workflow_test.py       🧪 Test workflow runner (rows, separate "🧪 Workflow test" project, reports/workflow-test-*)
    status_push.py         status summary pushed to the AutoInjector bridge (POST /v1/status)
    selftest.py            "Test everything": real end-to-end self-test through engine.dispatch,
                           writes reports/selftest-<stamp>.md/.json (CLI: python -m bookforge selftest)
    server.py, web/        local HTTP API + browser workspace (web/app.js, web/clipboard.js = the one
                           clipboard helper with execCommand/paste-box fallbacks, hash routes #/p/<pid>/<branch>/...,
                           incl. #/start wizard and .../book)
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
* The server listens on port 8780 by default (`--port`, `BOOKFORGE_PORT`). Without an explicit port it
  reuses an already running BookForge on the same data folder, or moves to the next free port.
  `POST /api/slots/connect-autoinjector` and `GET /api/slots/{id}/health` serve the Settings page.

## Review queue, Current task, AI reviewer (review.py)

* `GET /api/projects/{pid}/branches/{b}/review` -> `{items, count, current_task, settings, ai_ready, book}`. Items are
  head OUTPUT records in DRAFT/VALIDATED, newest version not approved, not stale, not replaced by a newer draft of the
  same chapter; always the records BookPath steps ask to approve (incl. book-format I01 imports and assembly), plus
  drafts of non-LOGIC operations outside sets I/K (never C01, K09 or other helper records). Order: A, B, C, book
  format, G, E, F, H, D, J, I, K, then the set's guide op order.
* `GET .../review/summary` -> `{count, current_task, working_on, auto_approve, book}` (side bar, polled every 10 s
  while visible). `current_task = {step, action: review|profile|make|new|book_step|book, record_id, chapter_id,
  set, op, title, state: needs_you|ai_can|blocked|done, message, hash}`.
* `POST .../review/approve {record_ids (1-200), versions?: {id: version}, author_confirms: true, how?}`: refuses
  without `author_confirms`; a version mismatch is reported, not approved; otherwise `BookPath.a_approve` in chunks of
  40 (K09 for the exact version when ACCEPT asks). Outbox event `review.approved_by_author`.
* `POST .../review/ai {record_ids (1-40), slot_id?}` -> 202 job; `POST .../review/fix {record_id, slot_id?}` -> 202 job
  (AI returns a complete OUTPUT, references are copied from the original - `keep_refs` - and it is stored with a
  normal UPDATE dispatch as a new DRAFT); `GET .../review/ai/{job}`; `POST .../review/ai/{job}/cancel`;
  `GET .../review/record/{rid}` -> verdicts per version.
* Verdicts `{verdict: APPROVE|REVISE|REJECT, reasons, suggested_changes, confidence, slot, model, at}` are advice and
  are stored in the settings key `ai_reviews:<pid>:<branch>` (`<record_id>:<version>`), not as records: no
  specification operation records an AI opinion about an arbitrary record (K09 is the author's authorization, F
  reviews are anchored manuscript patches). Outbox `review.ai_verdict` (no reason text). AI fixes are noted in
  `ai_fixes:<pid>:<branch>`. Prompts/replies are never logged.
* Auto-approve: `GET/PUT .../review/settings {auto_approve, author_confirms}` -> project setting
  `review_settings:<pid> = {auto_approve, consent: {by, at, warning}, history}`; turning on needs `author_confirms`.
  `ReviewService.maybe_auto_approve` approves only when the setting is on AND the verdict for exactly that version is
  APPROVE; outbox `review.auto_approved` (with consent by/at and label) or `review.auto_approve_failed`; on/off changes
  are logged as `review.auto_approve_on/off`.

## 🧪 Test workflow (workflow_test.py)

`GET /api/workflow-test` (rows, project, report), `POST /api/workflow-test/run {rows: "all" | [ids]}` (202; 409 while
running; "all" makes a fresh "🧪 Workflow test <date>" project with setting `workflow_test: true` and archives the
previous test book), `POST /api/workflow-test/stop`, `GET /api/workflow-test/report?format=md|json`. Rows: ai,
premise, plot, outline, chapter, review, approvals, format, assemble, export, check. AI rows use a gated provider
registry (selftest's `SelfTestProviders`) limited to slots that pass the run's health check; without one they are
SKIPPED and a manual candidate keeps dependent rows going. Projects with `workflow_test`/`selftest` settings are
`test_book: true` in project summaries and never become the "last used" project.

## AutoInjector link: pairing and status push (BookForge side)

* Pairing: AutoInjector opens `http://127.0.0.1:<port>/#/pair?code=<CODE>&bridge=<urlencoded bridge url>`. The page
  reads the fragment, removes it with `history.replaceState` (address becomes `#/pair`), and calls
  `POST /api/slots/pair-autoinjector {code, bridge_url}` (normal bearer auth; the browser token is also kept in
  `localStorage` so tabs opened by AutoInjector are authenticated). The server checks the code
  (`^[A-Za-z0-9-]{8,32}$`) and the bridge URL (`validate_bridge_url`: http 127.0.0.1/localhost only), then
  `POST <bridge>/v1/pair {"code", "client": "bookforge"}` without Authorization (no proxy). 200
  `{"ok": true, "token"}` -> `connect_autoinjector(token)` (AI-1 claude, AI-2 chatgpt, AI-3 gemini) and a health check
  per slot; answer `{connected, bridge_url, slots: [{slot_id, site, ok, message, error, ...}], message}` - never the
  token. 401/404/410 -> 400 `EXPIRED_APPROVAL` "the pairing code expired or was already used — press Connect again in
  AutoInjector"; not reachable -> `UPSTREAM_UNAVAILABLE`.
* Status push (`StatusPusher`, daemon thread started by `main()`): when a slot uses the autoinjector adapter with a
  saved key, `POST <bridge>/v1/status` with `Authorization: Bearer <key>` and the body documented in
  `status_push.py` (`app, version: 1, bookforge_url, project {id, title}, current_task {set, op, title, state,
  message, url}, working_on, approvals {count, items (max 20, {op, set, title}), url}, checklist, done, total,
  updated_at`). Titles only (canon by concept name, other drafts by step name). On change at most every 5 s plus a
  30 s heartbeat; body < 32 KiB; refused/timeouts back off quietly up to 60 s; 401 stops pushing with that key until a
  new key is saved. The project is the most recently opened real book (`App.touch_project`, setting `last_project`).

## Tests

`python -m pytest -q tests` . Use the `h` fixture (tests/conftest.py): `h.create(op, payload)`,
`h.dispatch(op, action, ...)`, `h.validate(ref)`, `h.accept(ref)`, `h.approve(ref)`,
`h.create_approved(op, payload, manual_candidate=...)`, `h.set_features(magic=True)`.
For AI paths set `engine.providers.test_adapter` to a fake with
`submit(slot, system, user, schema) -> (dict, usage)` and configure a slot
(`engine.providers.configure_slot("AI-1", {"adapter_id": "anthropic"})`).
