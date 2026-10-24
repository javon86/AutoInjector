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
    prose_audit.py         P6 pattern checker (no AI): repeated gestures, "Not X. Not Y.", triads, moral paragraph
                           endings, named emotions, said-bookisms, sentence-length uniformity, same openings, overused
                           words, dialogue share, reassurance; audit()/audit_book(), thresholds per 1 000 words
    editor_rubric.py       the AI editor's rubric (dimensions, questions, strictness) - the ONE editable place
    editor.py              🖋 AI editor: craft review (P4), rewrite proposals + exact apply (P5), restore; settings
                           editor_settings, advice keys craft_reviews / editor_proposals / editor_rewrites
    workflow_test.py       🧪 Test workflow runner (rows, separate "🧪 Workflow test" project, reports/workflow-test-*)
    status_push.py         status summary pushed to the AutoInjector bridge (POST /v1/status; incl. words {total, target})
    jobs.py                JobStore (persisted background work, settings keys job:<id>; mark_interrupted at start-up),
                           RetryPolicy + wait_and_retry (S10 busy/unreachable backoff; TIMEOUT never retried)
    autobook.py            ⚡ Make a book for me (AutoBookService, R14/S21) and ✍ Write all chapters (WriteAllService, S2)
    backups.py             BackupManager: automatic/daily backups, rotation (backup_keep), guarded live restore (S9)
    health.py              HealthService: ❤️ checks (db, disk, backups, AI slots, bridge/status push, exports, stuck jobs)
    diagnostics.py         📋 safe diagnostics report + ErrorLog (recent API errors); guard() strips secrets/titles
    journal.py             📜 per-book journal built from audit + provenance + outbox + job events (+ markdown)
    shelf.py               📚 finished books across projects (exports re-read and hash-checked)
    selftest.py            "Test everything": real end-to-end self-test through engine.dispatch,
                           writes reports/selftest-<stamp>.md/.json (CLI: python -m bookforge selftest)
    server.py, web/        local HTTP API + browser workspace (web/app.js, web/clipboard.js = the one
                           clipboard helper with execCommand/paste-box fallbacks, hash routes #/p/<pid>/<branch>/...,
                           incl. #/start wizard, .../book, .../journal, #/shelf); web/problems.js = the ONE
                           code -> plain words table (every errors.py code, provider/HTTP/network codes)
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

## AIs that break: failover (P18.9) and writer ≠ reviewer (P3.1 / P3.2)

* **Slot health** (`providers.SlotHealth`, one per registry, shared by `PinnedProviders` / `SelfTestProviders`):
  `ProviderRegistry.site_state(slot)` reads the bridge's `GET /v1/health` (contract v1.2: per site `state`
  ok|repairing|needs_user|broken|unknown, `problem`, `since`, `last_probe_ok_at`), cached `HEALTH_TTL_S` = 15 s per
  bridge+key (fetch failures cached too). A v1.1 bridge (no `state`) or an unreadable bridge gives `unknown`, which
  never makes a slot unavailable. Test fakes may implement `site_state(slot)` and `probe(slot_ids)`.
* `eligible()` skips slots whose state is repairing/needs_user/broken and sorts a slot whose last call failed with
  UPSTREAM_UNAVAILABLE (`health.mark_failed`, `FAIL_HOLD_S` = 15 s) last. `unavailable()` lists the skipped ones;
  when nothing else fits, `generate()` / `AssistService._choose_slot` raise UPSTREAM_UNAVAILABLE (`down_error`,
  a busy code) so the work **waits and retries** (jobs.wait_and_retry) instead of failing.
* **Failover:** `generate()` without an explicit slot tries the eligible slots in order (role slots first, then any
  other working slot); UPSTREAM_UNAVAILABLE (incl. 503 SITE_NOT_READY, which no longer gets the quick same-slot
  retries when the bridge says why) moves the call to the next slot. `AssistService._call_ai_once` does the same
  for automatic jobs (review, fix, profile, Bible Builder). A slot the author/run explicitly picked never moves (it
  waits). TIMEOUT is unchanged (ambiguous → author decides; a run step pauses). `health.set_listener(fn)`
  (thread-local) hears `{"event": "failover", "from": [...], "to", "to_name"}`; runs log it as event `failover`.
* **Probe before a run:** `probe_and_wait(timeout_s=60, poll_s=2)` → `POST /v1/probe {"sites"}` per bridge (404 =
  older bridge: just read health; env `BOOKFORGE_PRERUN_CHECKIN=0` skips the POST), then re-reads health until every probed site has a result (ok with
  `last_probe_ok_at`/`since` after the start, needs_user or broken) or the time is up. Make-a-book, Write all
  chapters (`_Runner.probe_ais`, run fields `probe`, `ais` = [{slot_id, name, state, word, problem, working}]) and
  the workflow test (`ais` in its status) call it. `GET /api/slots/states` returns `slot_status()` per AI slot;
  `health_check()` / ❤️ Health show the state (warn with the problem code).
* **Writer ≠ reviewer:** `ReviewService.writer_of(rec)` = AI-fix note, provenance `ai_slot`, or the Bible Builder
  note (`assist.note_writer`, settings `ai_writers:<pid>:<branch>`). `review_one` without a picked slot calls
  `plan_reviewer`: `job.avoid_slots = [writer]`, `job.avoid_families = {slot_family(writer)}` (site, or "claude" for
  the API), `job.prefer_slots = [Settings reviewer]` (`GET/PUT /api/settings/reviewer-ai {slot: auto|AI-1..3}`),
  `job.cross_pin = True` (a run pinned to one writer AI still gets another reviewer; gated self-test registries are
  never bypassed). Deterministic order: preferred slot → eligible order with a different family first → any other
  working slot → (another AI just busy: wait) → the writer itself. `_run_fix` prefers the writer and avoids the
  reviewer. Stored verdicts add `writer_slot, writer, reviewer, independent, warning`; outbox `review.ai_verdict`
  adds `writer_slot, independent` (never text). Runs keep `review_summary {independent, same_ai, warning}` and each
  step's `review_note`; the journal adds `reviews` and ⚠️ entries. UI: `aiStrip`, `reviewWho` (app.js),
  `SITE_PROBLEMS` / `siteProblemWords` / `AI_STATE` (problems.js).
* Tests: `tests/test_failover_review.py` (SlotFake with scripted site states; `V12Bridge` HTTP fake for the real
  adapter; the v1 `FakeBridge` as the older bridge).

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

## 🖋 The AI editor (editor.py, editor_rubric.py, prose_audit.py — P4 / P5 / P6)

* **P6 pattern checker** `prose_audit.audit(text, chapter=, settings={strictness, gestures, watch_words, thresholds},
  names=)` / `audit_book([(chapter_id, text)])` -> `{words, paragraphs, sentences, findings: [{id, check, label,
  severity: info|minor|major, count, per_1000, threshold, detail, advice, passages: [{chapter, paragraph (from 1),
  excerpt (<= 80 chars)}]}], stats, summary, strictness}`. Thresholds per 1 000 words (`THRESHOLDS`, minimum counts
  first), shares for tags/speakers, coefficient of variation for sentence length; strictness scales them (gentle
  1.5x, strict 0.7x). `brief()` is what the editor gets, `counts_only()` has no text (journal/events). Pure Python,
  a few ms per chapter.
* **P4 craft review** `EditorService.craft_one(job, rid)` (job: `review.ReviewJob`; `ReviewService.editor` is the
  service bound to the same engine/AIs). Context: chapter text (or the planning draft's JSON for B01/B03/B11, lighter
  rubric `editor_rubric.PLANNING`), book profile, approved canon + character sheets, protected facts, the outline
  place (`chapter_info`: number, of, last, objective, neighbours) and `prose_audit.brief`. Slot choice =
  `ReviewService.plan_reviewer` (editor != writer, P3.1). Schema `{scores, findings[{id, dimension, severity, passage,
  why, suggestion, keep_nearby}], keep, verdict}`; `clean_craft` clips scores 1-10, drops unknown dimensions, marks
  whether each passage is in the text, and BookForge's own `decide()` sets PASS/REVISE from `editor_rubric.STRICTNESS`
  (normal: any major or any score < 6) — the AI's verdict is kept as `ai_verdict`. Stored as ADVICE in
  `craft_reviews:<pid>:<branch>` (`<rid>:<version>`); outbox `editor.craft_review` (scores and counts, no text).
  Set F records were not used: F findings are anchored patch proposals that enter the approval queue and need an
  approval reference; a scored opinion has no field there and an accepted rewrite is a normal C02 UPDATE anyway.
* **P5 targeted rewrite** `propose(job, rid, craft=, finding_ids=)` asks the WRITER (`prefer_slots=[writer]`,
  `avoid_slots=[editor]`) for `{replacements: [{finding_id, original, replacement}]}`; `apply_replacements` uses an
  original only when it occurs exactly once, overlaps the finding's passage, is not far longer than it, changes
  something and keeps every keep quote; everything else is unresolved (`NOT_FOUND`, `AMBIGUOUS`, `NOT_AT_PASSAGE`,
  `TOO_LONG`, `KEEP_LOST`, `NO_CHANGE`, `NO_REPLACEMENT`). Stored in `editor_proposals`. `apply(principal, pid, branch,
  rid, version, accept)` re-applies exactly the accepted ones to that version and saves a DRAFT through
  `BookPath.dispatch(UPDATE)` (canon checks run); notes `ai_fixes` (`editor: true`) and `editor_rewrites`; outbox
  `editor.rewrite`. `restore()` saves an earlier revision's data again (copying its consistency and craft reviews,
  same content) with outbox `editor.rewrite_rejected`.
* **Runs** (`AutoBookService._editor_pass`, C02 only, settings snapshot `run["editor_settings"]`): after an APPROVE
  consistency verdict (review_one `auto=False`) -> craft -> PASS: approve; REVISE and rounds left -> propose + apply ->
  `_regression` (VALIDATE, consistency review, craft) -> `judge_rewrite` (keep only if checks pass, consistency
  APPROVE, no keep quote lost, average not lower and no dimension down by more than 1, flagged passages gone, no more
  major findings) -> else `restore`. Rounds used up / rewrite not kept / editor failed -> approve under the run
  consent and flag (`run["editor"][rid]`, `run["editor_summary"]`, chapter item `editor`, events `EDITOR_NOTES`,
  `EDITOR_REWRITE_REJECTED`, `EDITOR_FAILED`, `EDITOR_UNRESOLVED`). Never a StepProblem except when the earlier text
  cannot be restored.
* **API:** `GET/PUT /api/settings/editor {enabled, rounds 0-3, strictness}`; `POST .../review/editor {record_id}`
  (202 job), `POST .../review/editor/fix {record_id, finding_ids?}` (202 job, proposal), `POST .../review/editor/apply
  {record_id, version, accept: [finding ids]}` (200, new version; 409 when the version moved), `GET
  .../review/editor/{rid}` (craft per version, proposal and rewrite of the newest version, pattern report, settings).
  Queue items carry `craft` (numbers only) and `editable`. UI: `editorCard`, `fixesBox`, `craftBadge`,
  `editorRunSummary`, `editorSettingsCard` (app.js); codes `EDITOR_*` in problems.js.
* Tests: `tests/test_prose_audit.py`, `tests/test_editor.py`; the fake AI (`tests/autobook_fake.py`) answers editor
  and rewrite prompts from `editor_flags` (phrase -> replacement), `craft_script`, `rewrite_script`.

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

## Make a book for me, background work, health (autobook.py, jobs.py, health.py, backups.py ...)

* **Runs** (`AutoBookService`, kind `autobook`): `POST /api/autobook {author_confirms: true, genre?, length?,
  slot_id?, idea?}` -> 202 run (409 while another run works; 400 `CAPABILITY_UNAVAILABLE` without an AI);
  `GET /api/autobook` -> `{runs, active}`; `GET /api/autobook/{id}`; `POST .../{pause|resume|cancel}`;
  `POST .../decide {action: approve_anyway (needs author_confirms) | retry | edited}`. A run is one daemon thread;
  its whole state (steps with state/message/problem/items, consent `{by, at, run_id, scope}`, fix counts, files,
  events) is saved to the JobStore after every change. Steps: backup, profile (new project, AI-invented profile via
  `AssistService._call_ai`), canon (programmatic `BibleSession._run_sections` + `create`), premise/plot/outline
  (`BookPath.payload_for` + dispatch), chapters (`BookPath.prepare_chapter` + dispatch), format, assemble,
  export (all three release profiles), check. Each step is an idempotent "ensure" over BookPath state, so resume
  (also after a restart) continues where it stopped.
* **Consent:** `_approve()` refuses unless called from the live thread of that run, while it is running, for its
  own project (`PERMISSION_DENIED` otherwise). APPROVE verdict -> `BookPath.approve_ref` + outbox
  `autobook.approved_under_consent` (label with run id); REVISE/REJECT -> `ReviewService._run_fix` (max 2,
  `MAX_FIXES`) -> review again -> else `StepProblem("REVIEW_NOT_PASSED", options=[approve_anyway, edit, retry])`.
  Deterministic records (format, assembly, export approval manifest) are approved under the consent without review.
  TIMEOUT inside a run -> the step pauses with ⚠️ (`problem.options = ["retry"]`), never fails the run.
* **Retry queue (S10):** `AssistService(retry_busy=True)` (the App) and runner `ai_create` wrap AI calls in
  `jobs.wait_and_retry`: UPSTREAM_UNAVAILABLE / RATE_LIMITED / SITE_BUSY wait `ai_retry.delays_s` (default
  15/30/60/120, last repeats) up to `max_total_s` (600), showing `job.waiting = {code, retry_in_s, retry_at,
  message}`; checks cancel/pause every 0.5 s. `GET/PUT /api/settings/ai-retry`. Library callers (tests) default to
  no waiting.
* **Write all chapters:** `POST .../branches/{b}/book/write-all` (202), `GET .../book/write-all` (latest),
  `GET .../book/write-all/{id}`, `POST .../{id}/cancel|resume`. Drafts only.
* **Persistence (S11):** `JobStore` uses only `Store.get_setting/set_setting` (key `job:<id>`) and a read query - no
  schema change. Assist jobs, AI review/fix jobs and Bible sessions save summaries (+ a `resume` body). At App
  start `mark_interrupted()` turns live jobs into `interrupted`. `GET /api/jobs[?project_id]`,
  `POST /api/jobs/{id}/resume` (autobook/write_all resume in place; assist/review/bible start a new job from the
  saved body), `POST /api/jobs/{id}/dismiss`.
* **Health / diagnostics:** `GET /api/health[?force=1]` (cached 30 s; slot checks at most every 120 s);
  `GET|POST /api/diagnostics[?format=text&download=1]` (POST may add `{client: {user_agent, screen, page,
  errors}}`). Whitelisted fields only; `guard()` replaces saved keys, the token, project names and book titles.
* **Backups:** `GET /api/backups`, `POST /api/backups`, `PUT /api/backups/settings {keep}`,
  `POST /api/backups/{name}/restore {author_confirms: true, confirm: "RESTORE"}` (safety backup first, `Store.restore`
  into a new folder, then SQLite online backup into the live DB; refused while a run works). Automatic:
  `before-run`, `before-assemble`, `before-export` (also for the manual book actions), daily in `main()`.
* **Journal / shelf:** `GET .../branches/{b}/journal[?step=C02|C&problems=1&format=md&download=1]`, `GET /api/shelf`.
* **Errors:** every endpoint answers `{errors: [{code, path, message}]}`; unexpected exceptions are logged with the
  traceback server-side and answered 500 `INTERNAL_ERROR` without details; all errors go into `app.errors`.
* **Review queue fix:** C02 output has no `chapter_id`, so chapter drafts are keyed by their C01 context (several
  chapters now appear separately) and titled "Chapter <id>".
* Tests: `tests/test_autobook.py`; `tests/autobook_fake.py` is a deterministic schema-driven fake AI
  (`fail_kind`, scripted verdicts, `gate`, `delay`).

## Tests

`python -m pytest -q tests` . Use the `h` fixture (tests/conftest.py): `h.create(op, payload)`,
`h.dispatch(op, action, ...)`, `h.validate(ref)`, `h.accept(ref)`, `h.approve(ref)`,
`h.create_approved(op, payload, manual_candidate=...)`, `h.set_features(magic=True)`.
For AI paths set `engine.providers.test_adapter` to a fake with
`submit(slot, system, user, schema) -> (dict, usage)` and configure a slot
(`engine.providers.configure_slot("AI-1", {"adapter_id": "anthropic"})`).
