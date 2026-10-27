# Developing Akọwe

Akọwe is one Python application with 11 independently owned modules (sets A-K, 142
operations) sharing a transactional storage kernel. It implements the Akọwe Final Build
Plan (contract `BF-IRB-1.0.0`, closure `BF-CLOSURE-1.1`) bundled in `package/`.

## Layout

```
akowe/
  package/                 delivered blueprint: contracts.zip (schemas, registries, cases),
                           Specifications/*.md, Build_Plan.md
  akowe/
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
    characters.py          🎭 P7/P17 character sheets + voice cards: fields, cleaning, companion storage (settings
                           characters:<pid>:<branch>, keyed by A01 record), AI generation, bounded voice brief,
                           voice words for the pattern checker
    scenes.py              🎬 P8 scene cards: fields, lint, light AI check, ScenePlanner (make/check/revise/save/approve),
                           companion storage (settings scene_cards:<pid>:<branch>, keyed <outline rid>:<chapter id>)
    chapter_brief.py       the C02 writing brief: POV name + planned backstory, voice cards of the characters present,
                           scene cards, planned details, story rules, world texture, must-show details, story choices,
                           rules (set_c ChapterWriter puts it in context.writing_brief)
    story_choices.py       🎚️ P12 ending and style choices (book profile ``choices``), the ending-state matrix, briefs,
                           planner/scene rules, editor notes and threshold changes (relax)
    story_rules.py         📏 P9 story-rules ledger: categories, cleaning, "bounded?" lint, companion storage (settings
                           story_rules:<pid>:<branch>), AI draft / update as proposals, bounded briefs
    texture.py             🧺 P10 world-texture list: kinds/causes, companion storage (world_texture:<pid>:<branch>), AI
                           draft, scene/chapter briefs, deterministic usage counts (lemma match)
    planned.py             ✅ P11 planned-to-page check: planned items per chapter, word check, independent AI check,
                           findings for the P5 rewrite (fix), book-level list (settings planned_checks:<pid>:<branch>)
    timeline_check.py      🕰️ P26 timeline checker: ages, birth/story years, "N years ago" arithmetic (no AI)
    terms.py               🔧 P31 trade facts (settings trade_terms:<pid>:<branch>) + the P26 terminology check
    repetition.py          🔁 P30 repetition sorter: voice / motif / filler / accident, trim plan, author labels
                           (settings repetition_labels:<pid>:<branch>)
    forge.py               🗂 B5 Character Forge dossiers: 14 sections / 148 lettered fields, storage (forge:<pid>:<b>), sync
                           with the sheet / voice card / canon, "Invent the rest" job, approvals, art via AutoInjector
                           POST /image/request, routes …/forge/…, chapter_brief helper; forge_pdf.py (the dark dossier PDF),
                           forge_example.py + examples/moki_vey/ (the Moki Vey example); web/forge.js; docs/CHARACTER_FORGE.md
    cover.py               🎨 B3 cover designer: design (settings cover:<pid>:<b>; blurb/author_bio in the profile), art job
                           (AutoInjector /image/request purpose "cover"), routes …/cover/…, book save Cover/;
                           exporters/cover.py (templates, layout, KDP print maths, PDF/SVG, cover added to PDF/EPUB/DOCX);
                           web/cover.js; docs/COVERS.md
    fact_checks.py         🔎 Section 7a glue: chapter/book views, editor context + keep list, fixes, run report, HTTP
    continuity.py          🧭 Section 7 P32-P35: tracked state storage (physical_state:/character_state:<pid>:<branch>),
                           AI tracking + run hooks (approved under the run consent), brief section, review context,
                           routes /review/continuity, Reports/Continuity.md; physical_state.py (🌊 P32 extraction +
                           checks), character_state.py (🫀 P35), ambiguity.py (🪞 P33 two readings,
                           ambiguity:<pid>:<b>), version_ledger.py (🧾 P34, version_ledger:<pid>:<b>); web/continuity.js
    lengths.py             📏 P15 length presets (words, chapters, scenes per chapter), chapter_plan, long-chapter settings
    long_chapter.py        📏 P15 scene-by-scene writing of long chapters + bounded continuation (used by set_c C02)
    pipeline.py            🧪 P14 run/book pipeline switches (editor, scenes, voices, rules, planned), presets
    book_report.py         📊 P13 book report: deterministic part, whole-book AI review, aggregation, Markdown/PDF
    compare.py             ⚖️ P14 blind comparison of two books / chapter versions
    scene_grid.py          🗂 P27 scene grid: chapters × scenes (scene cards, words + readability per scene, problems)
    costs.py               ⏱ P28 AI calls and minutes per AI / per run / per book, estimate before a run (web/grid.js)
    book_bible.py          📖 P20/P21 the book bible: build (versioned JSON), Markdown, clean (a file from outside),
                           summary, remap_refs
    book_package.py        📦 P20/P21 book.akowe: build, read + check, transplant into a NEW project, import, verify
    book_save.py           💾 P20 books folder settings, one folder per book, atomic writes, debounced auto-saves
    book_open.py           📂 P21 books-folder list, open a folder / upload (package or book-bible.json), resolve_bible
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
                           writes reports/selftest-<stamp>.md/.json (CLI: python -m akowe selftest)
    server.py, web/        local HTTP API + browser workspace (web/app.js, web/clipboard.js = the one
                           clipboard helper with execCommand/paste-box fallbacks, hash routes #/p/<pid>/<branch>/...,
                           incl. #/start wizard, .../book, .../journal, #/shelf); web/problems.js = the ONE
                           code -> plain words table (every errors.py code, provider/HTTP/network codes)
  tests/                   pytest suite (conftest.py has the Harness fixture `h`)
```

## Rules for module code

* Edit only your set's files: `akowe/modules/set_<x>.py`, optional helpers in a new
  `akowe/<x>_*.py` or `akowe/exporters/`, and `tests/test_set_<x>.py`.
  Do not change engine.py / store.py / base.py / contracts.py / server.py; propose kernel
  changes instead.
* Read `package/Specifications/Shared_Contract.md` and your set's
  `Akowe_Set_<X>_Final.md` (the "Set rules" section holds the real semantics; the
  per-operation sections are uniform boilerplate). Schemas: `get_package().schema(op)`.
* LOGIC operations are deterministic and never call an AI slot. AI/HYBRID creative work
  uses `OperationHandler.generate` (AI slot) or a manual candidate; never fabricate
  creative content in code.
* Never fabricate approvals or evidence; findings carry real evidence.
* Errors: raise `AkoweError(code, json_pointer, message, status=...)` with codes from
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
  AutoInjector desktop app, contract `../docs/AKOWE_AUTOINJECTOR_BRIDGE.md`). Autoinjector
  slots need `site` (chatgpt|claude|gemini) and `bridge_url` (http://127.0.0.1 or
  http://localhost only, default `http://127.0.0.1:17891`); the bridge token uses the
  write-only `api_key` secret. They cost 0 and run one request at a time.
* `roles` (operation IDs like `C02` or set letters like `B`): when any eligible slot's roles
  match the operation, only those slots are used (`ProviderRegistry.eligible(...,
  operation)`); K11 applies the same rule using the K05 job's operation.
* Adapters that set `accepts_request_context = True` get `request_id`, `attempt`,
  `deadline` and `call` keywords in `submit()`; plain `submit(slot, system, user, schema)`
  adapters (and test fakes) keep working.
* The server listens on port 8780 by default (`--port`, `AKOWE_PORT`). Without an explicit port it
  reuses an already running Akọwe on the same data folder, or moves to the next free port.
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
  older bridge: just read health; env `AKOWE_PRERUN_CHECKIN=0` skips the POST), then re-reads health until every probed site has a result (ok with
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
  whether each passage is in the text, and Akọwe's own `decide()` sets PASS/REVISE from `editor_rubric.STRICTNESS`
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

## 🎭 Character sheets, voice cards (P7 / P17) and 🎬 scene cards (P8)

* **Where the data lives (and why).** A01's OUTPUT is closed (`attributes` = identity/role/traits/appearance/
  background/goals/constraints; `facts` are canon claims with registered predicates, protected-fact rules and
  contradiction checks, copied into every C01 context). B05 needs an approved B03 and holds plan items; C12 is a text
  style per chapter/project scope. B12 is the spec's scene planner, but C02 cannot pin it (bindings: `outline_ref`,
  `context_ref` only), its plan items are kernel-checked canon plans (events ⊆ chapter, POV/location authority) and
  goals/hidden agendas/obstacles/subtext have no registered predicates. So both are **companion data** like the
  reviewer's verdicts and the editor's notes: settings `characters:<pid>:<branch>` (key: A01 record ID — a new version
  of the character keeps its sheet) and `scene_cards:<pid>:<branch>` (key: `<outline record>:<chapter id>`, with the
  outline version: cards made for an older outline revision are `out_of_date` and not used). Each entry has a version
  counter (author saves send the version they edited → `VERSION_CONFLICT` instead of overwriting), `made_by`, the last
  5 versions; scene entries also the light review of exactly that version and the approval (`author` or
  `run_consent` + run id). Outbox: `characters.sheet_saved`, `scenes.saved`, `scenes.reviewed`, `scenes.approved`
  (numbers/codes only; the journal lists them). Engine/store semantics are unchanged.
* **AI.** `assist.propose` adds optional `character_sheet` / `voice_card` to the A01 proposal schema (+
  `characters.COMPANION_TASK`); the result carries `companion`; `BibleSession.create` saves it for the new record; the
  Fill-with-AI form saves it after Create (`PUT .../review/characters/{rid}` with `from_ai`). `characters.generate`
  writes them for an existing character (`CHARACTER_TASK`, op roles A01). `ScenePlanner.make` (writer slot, roles of
  C02, `PLAN_TASK`), `.check` (`ReviewService.plan_reviewer` → another AI, `REVIEW_TASK`; Akọwe decides PASS only
  when every scene passes goal / obstacle_from_world / unsaid and `lint` has no major problem), `make(revise=True)`
  (earlier plan + notes; prefers the writer, avoids the checker).
* **Prompts.** `ChapterWriter.preconditions` builds `chapter_brief.build(...)` (never raises) and stores only IDs and
  numbers in `c_meta[...]["brief"]`; `ai_context` adds `writing_brief`, `ai_task` appends its rules. Voice cards: POV
  first, ≤ `MAX_FULL` (4) full cards, the rest one line each, JSON ≤ `BRIEF_BUDGET` (7 000 chars). Present characters =
  POV + scene-card names + names/IDs the outline chapter mentions (all characters when none can be told).
* **Editor / pattern check.** `editor_rubric`: `voice_distinction` uses `context.voice_cards` and the pattern report's
  voice stats and quotes the line that sounds like someone else; new `scene_plan` dimension only when the chapter has
  usable scene cards (`dimensions_for(..., scene_cards=True)`). `prose_audit`: `stats["voices"]` (per speaker lines,
  words per line, question/exclamation rate, top words, phrases/vocabulary used), `voice_sameness` (rhythm alike AND
  shared-word share ≥ 0.25 minor / 0.40 major) and `voice_never_word` (`settings["voices"]` from
  `characters.voice_words`).
* **Runs.** New step `characters` (after canon): any approved character without a complete sheet gets one; a failure is
  ⚠️ `CHARACTER_SHEET_FAILED` and the run goes on (TIMEOUT / busy / no AI pause as usual). In `chapters`, before C02:
  `_scene_cards` = plan → check → rework (≤ `MAX_FIXES`) → `planner.approve(how="run_consent")` after
  `_check_consent` (⚠️ `SCENES_NOTES` when still REVISE); failures other than TIMEOUT/busy → ⚠️ `SCENES_FAILED`, the
  chapter is written from the outline. Older saved runs get the new step on resume (`_ensure_steps`). Write all
  chapters plans missing scene cards first (no check, drafts).
* **API** (under `/api/projects/{pid}/branches/{b}/review`): `GET characters`, `GET|PUT characters/{rid}` (`{sheet?,
  voice?, version?}`), `POST characters/{rid}/ai` (202), `GET|PUT scenes/{chapter}` (`{cards, version?}`),
  `POST scenes/{chapter}/ai` (202, `{revise?, check? = true}`), `POST scenes/{chapter}/check` (202),
  `POST scenes/{chapter}/approve` (`{author_confirms: true, version}`). Jobs poll at `review/ai/{job}`. The book status
  adds `canon.sheets {complete,total}` and per chapter `scenes` (numbers only). UI: `characterCard` (A01 record page),
  `viewScenes` (`#/p/<pid>/<b>/scenes/<chapter>`), `scenesMini` (chapter page), `scenesBadge` (book rows, run window).
* Tests: `tests/test_characters_scenes.py`; the fake AI answers sheets/voices (`VOICES`, `companion`), scene plans
  (`scene_script`) and checks (`scene_verdicts`), `chapter_texts` for dialogue, a voice_distinction note from the
  pattern report, and records every prompt (`prompts[kind] = [(task, context)]`).

## 🌍 Section 4: story rules (P9), world texture (P10), planned to page (P11), ending and style (P12)

* **Where the data lives (and why).** *Choices* are author data of the book, so they live in the book profile
  (``book_profile:<pid>``, key ``choices`` = {ending, explain, darkness, dialogue, pace, humor, matrix?}; cleaned by
  ``story_choices.clean`` inside ``book_path.clean_profile``; "" = let the AI choose). The *ledger* and the *texture list*
  are companion data like the character sheets and scene cards: the spec's canon (A03 physical rules, A09 powers with
  costs/limits/exceptions, A08 beliefs, FACT/BELIEF/PLAN/UNKNOWN assertion types) is where the AI reads them FROM
  (``story_rules.canon_view``), but a ledger row has no home there — A facts are canon claims re-approved on every edit
  (and make chapters stale), "seen to happen" / "protected mystery" have no assertion type (UNKNOWN ≠ "must stay
  unexplained"), scope/limits and "stated by" have no field, B08 needs the ``mystery`` feature and an approved plot. A
  texture item is a writing resource (detail + what it can cause + match words), not a canon claim. So: settings
  ``story_rules:<pid>:<branch>`` and ``world_texture:<pid>:<branch>`` = one entry each {version, rules|items, made_by,
  updated_at, basis (canon hash + approved B01/B03/B11 versions it was made from), history (5), proposals (rules)};
  author saves send the version they edited (``VERSION_CONFLICT`` otherwise); outbox ``rules.saved``,
  ``rules.proposed``, ``rules.proposals_decided`` (``how`` author|run_consent), ``texture.saved`` (numbers only; the
  journal lists them). Planned checks are advice per record version like craft reviews: ``planned_checks:<pid>:<branch>``
  keyed ``<rid>:<version>`` (outbox ``planned.checked``, counts only); ``editor.restore`` copies them with the reviews.
  Character sheets gained ``must_show`` (≤ 5 items; optional in the AI schema). Engine/store semantics are unchanged.
* **P12 flow.** ``story_choices.matrix(choices)`` = ``PRESETS[ending]`` → ``explain`` sets the mystery row
  (explain→explained, hint→bounded, leave→protected) → ``choices.matrix`` row overrides. ``brief()`` (≤ ``BRIEF_MAX``
  1 600 chars) goes into ``assist.book_profile_brief`` (so every AI context with the profile has ``story_choices``), into
  ``set_b.PlanHandler`` (B01 without the matrix, B03/B11 with it; ``rules()`` appended to the task), into the scene
  planner (``scene_rules``: peril shapes obstacles, pace the scene count) and the C02 brief (matrix only in the last
  chapter). The editor gets ``editor_notes`` (appended to the dimension questions) and ``relax`` (per-dimension change of
  the minimum score in ``editor.decide``: explained mysteries −2, protected +1, gentle peril −1 on tension_stakes, open
  ending +1 on ending_openness; stored on the craft as ``relaxed``). ``GET /api/story-choices`` = labels, ⓘ help, the
  matrix rows and presets (UI ``choicesFields`` in the wizard, the profile dialog and ⚡ quick settings; ``POST
  /api/autobook`` takes ``choices``).
* **P9 flow.** ``story_rules.generate(assist, job, bp, update=)``: no ledger → saved (made_by ai, ``apply_choices``:
  "explain" adds "may be explained at the end" to mysteries' scope); a ledger → the AI returns the complete list with ids,
  ``propose()`` stores add/change/retire proposals (an AI id that is not a ledger id is always NEW), the author decides
  (``decide_proposals``, needs ``author_confirms``). ``lint`` = the deterministic "bounded?" check (``UNBOUNDED_EXCEPTION``
  major: an exception word and no scope; ``NO_LIMITS``; ``BELIEF_NO_HOLDER``; ``DUPLICATE``). Uses: ``plan_brief`` (≤ 3 500
  chars, + ``not_bounded``) in B03/B11 prompts and their consistency review / planning editor (new dimension
  ``rules_bounded``), ``chapter_rules`` (≤ 12 rules, ≤ 2 500 chars: mysteries and hard rules first, then beliefs/seen by
  word overlap) in the C02 brief, ``editor_view`` (rules + ``protected_mysteries`` + a note when mysteries may be
  explained in the last chapter) for the editor (new dimension ``story_rules``; ``protected_mysteries`` reads it) and the
  C02 consistency review (``REVIEW_TASK`` checks the rules when given).
* **P10 flow.** ``texture.generate`` (roles of A04) saves the list; ``scene_brief`` (≤ 3 500 chars) goes to
  ``ScenePlanner._context`` as ``world_texture`` with ``TEXTURE_PLAN`` appended to the plan task; a card may name the ids
  it used (optional ``texture`` in ``CARD_SCHEMA``); ``chapter_brief`` (≤ 4 items, ≤ 1 200 chars, the cards' ids first)
  goes to the writer with ``texture.RULE``; the editor's ``world_friction`` reads it. ``usage``/``book_usage``: lemma match
  of each item's words (plural/-ed/-ing/possessive stripped; phrases as token sequences); ``prose_audit`` gets
  ``settings["texture"]`` → ``stats["texture"]`` and a minor ``texture_overused`` finding (≥ 5 times and > 6 per 1 000
  words); the world page shows used/unused per item over the whole book.
* **P11 flow.** ``planned.planned_items(bp, outline, chapter)`` (≤ 16): beat (outline objective), POV name (required in
  the first chapter of that POV), per scene card obstacle + change (+ the POV's goal, optional), the sheets' must-show
  items spread over the chapters where that character is POV or present (``_must_show_assignment``; the C02 brief lists
  them as ``must_show``), the brief's planned details (optional). ``check_text``: names as words; text items on_page at ≥ 50 %
  of their content-word lemmas, unclear ≥ 25 %, else missing. ``PlannedChecker.check(job, rid)``: + ONE independent AI
  call (``plan_reviewer``: never the writer when another AI works; ``CHECK_TASK``, ≤ 12 items, chapter ≤ 60 000 chars) for
  open items; an AI "yes" counts only with a quote found in the text. ``propose_fix``: ``findings_for`` anchors each
  open required item at an exact, unique sentence (best word overlap; never two items on one sentence) → findings with
  dimension ``planned_to_page`` → ``editor.propose(craft=pseudo)`` → the author applies via ``/review/editor/apply``
  (or the run via ``editor.apply(how="run")``). ``book()``: per chapter counts (stored AI check or word check), the
  missing list and POV names that never appear in the book.
* **Runs** (``autobook``): new steps ``world`` (after ``characters``: ledger + texture once; failure → ⚠️
  ``RULES_FAILED`` / ``TEXTURE_FAILED``, TIMEOUT/busy/no AI pause) and ``planned`` (after ``chapters``: book-level report,
  ⚠️ ``PLANNED_MISSING``, never blocks); after the outline step ``_update_rules`` asks for proposals when the plan changed
  and accepts them under the run consent (``_check_consent``). In ``_review_until_approved`` (C02) after the editor pass:
  ``_planned_pass`` = check → while open items and rounds left (``planned.ROUNDS`` = 1; 0 when Settings › Editor rounds is
  0) → propose + apply → VALIDATE + consistency review + check again → kept only if checks pass, the reviewer says
  APPROVE and fewer items are open, else ``editor.restore`` (events ``PLANNED_FIX_KEPT`` / ``PLANNED_FIX_REJECTED`` /
  ``PLANNED_UNRESOLVED``); still open → ⚠️ ``PLANNED_MISSING``; chapter items get ``planned``; ``run["planned"]``,
  ``run["planned_summary"]`` {checked, fixed, flagged, book}. Older saved runs get both steps on resume.
* **API** (under ``/api/projects/{pid}/branches/{b}/review``): ``GET world`` (rules, lint, ``rules_changed``, texture,
  problems, ``texture_usage``, ``mystery_mode``, fields), ``PUT world/rules {rules, version}``, ``POST world/rules/proposals
  {author_confirms, version, accept?, reject?}``, ``PUT world/texture {items, version}``, ``POST world/{rules|texture}/ai
  {update?, note?}`` (202), ``GET planned`` (book), ``GET planned/{rid}`` (word check of the newest version + stored
  check), ``POST planned/{rid}/check`` (202), ``POST planned/{rid}/fix`` (202 → proposal at ``editor/{rid}``).
  UI: ``viewWorld`` (``#/p/<pid>/<b>/world``, More ▾), ``plannedCard`` (chapter page), ``bookSection4Card`` (book page),
  ``choicesFields`` / ``choicesSummary`` (wizard, profile card + dialog, ⚡ setup), run window ``planned_note``, item
  ``planned`` and ``plannedRunSummary``; problems.js ``RULES_*``, ``RULE_NOT_BOUNDED``, ``TEXTURE_*``, ``PLANNED_*``.
* **Prompt budget (characters of JSON added per prompt).** Chapter (C02) brief: story rules ≤ 2 500, texture ≤ 1 200,
  must-show ≤ 5 × 160, choices ≤ 1 600 (on top of Section 3's voice cards ≤ 7 000 and scene cards) → the whole brief stays
  under ~22 000. Scene planning: texture ≤ 3 500 + peril/pace one sentence each. Plot/outline + their review: rules
  ≤ 3 500. Editor: rules ≤ 3 500 + ≤ 8 mysteries + texture ≤ 1 200. Ledger draft: canon view ≤ 12 000 + plan view ≤ 6 000.
  Texture draft: the scenes' world view (≤ 30 records) + ≤ 10 characters. Planned check: chapter ≤ 60 000 + ≤ 12 items.
* Tests: ``tests/test_world_planned.py``; the fake AI answers rules (``RULES``, an update adds/changes one), texture
  (``TEXTURE``; scene plans then take obstacles from it), the planned checker (a sentence with the item's words), the
  planned fix (``planned_fix``; kind ``planned_rewrite``) and rule violations (``rule_flags``).

## 📊 Section 5: book report (P13), compare versions (P14), longer books (P15)

* **P15 lengths** (`lengths.py`): `PRESETS` (short_story 3–5k/3–5 ch, novelette 10–15k/5–8, novella 20–40k/8–15, novel
  60–90k/20–35; target, default chapters, scenes). `book_path.LENGTHS` / `WORD_TARGETS` / `chapter_target` derive from
  it (a profile without `chapters` gets the preset default). `chapter_plan(prof, n_chapters, store)` → target words,
  `min_words` (= `under_share` × target), scenes, words per scene, `scene_by_scene` (target > `per_call_words`),
  `expand_rounds`. Settings key `length_settings` (`GET/PUT /api/settings/length`; `scale` = test mode shrinking all
  targets), `GET /api/lengths`. Fed into: B11 (`target_length` + `set_b._length_rule`), scene planning
  (`scenes._context` scene_hint/target_words/words_per_scene + `LENGTH_PLAN`), the C02 brief (`length` + `lengths.rule`)
  and the C01/C02 instruction ("Length: about N words").
* **Long chapters** (`long_chapter.write`, called by `set_c.ChapterWriter.ai_prose`, inside the one C02 CREATE): whole
  chapter = one call (old behaviour); scene by scene = one call per scene card (`SCENE_SCHEMA` {scene_text}, the last
  also returns objective_assessments; context `scene_writing` with the previous scene's end ≤ 1 500 chars and the story
  so far ≤ 8 lines), joined with `***`; continuation (`EXPAND_SCHEMA` {continuation}, chapter end ≤ 6 000 chars) while
  under `min_words`, at most `expand_rounds`; `new_text_only` drops titles and repeated sentences; a failed
  continuation is noted (`expand_error`), never raised. `ProseWriter.create` merges `ctx.meta_extra` into `c_meta`
  (`length`: mode, calls, scenes, expand rounds, words — numbers only).
* **ETA**: the run's providers are `_TimedProviders` (PinnedProviders timing `_generate_on`) and the run's
  `assist._call_ai_once` times cross-pinned calls → `run["timing"]` {calls, call_s, chapter_s}; `_eta()` = average
  chapter × chapters left + 3 average calls + 5 s per remaining Akọwe step → `run["eta"]`, the chapters step message
  and `[data-testid=mb-eta]`.
* **P14 pipeline switches** (`pipeline.py`): `POST /api/autobook {pipeline: {preset|flags}, variant_of: {project_id}}`;
  stored in `run.settings.pipeline` and the book's `pipeline:<pid>`. Honoured: steps `characters`/`world`/`planned`
  skipped (`STEP_FLAGS`, state `skipped`), `_update_rules`, the editor pass, `_planned_pass`, `_scene_cards`,
  `WriteAllService._plan_scenes`, `chapter_brief.build` (no scene cards / voice cards / rules+texture / must-show),
  `set_b._guidance` (no rules). A variant copies title, author, genre, audience, tone, idea, length and choices; the
  project is named "<title> (variant: <preset>)"; project setting `variant_of`. `GET /api/pipeline`.
* **P13 report** (`book_report.ReportService`, `app.reports`): `book_chapters` (approved text, else newest draft),
  `version_key` (hash of the chapter revisions), `deterministic` (words, editor crafts of those versions, planned.book,
  prose_audit.audit_book, usage via `writer_of` + stored verdicts/crafts), reviewers = working AIs of another family than
  the majority writer (`pick`), one `assist._call_ai` per reviewer (explicit slot, `cross_pin`, no busy wait;
  schema `book_scores`/strengths/weaknesses/try_next/summary), `clean_review` + `verify_quote`, `aggregate` (median,
  range, disagree ≥ 3), `try_next`, `_warnings`. Stored in `book_reports:<pid>:<branch>` (10 kept), outbox
  `quality.book_report` (numbers). Budget: whole ≤ `WHOLE_MAX_CHARS` 60 000, else `book_view` digest ≤
  `DIGEST_MAX_CHARS` 48 000 (per chapter opening 45 % / middle 25 % / closing 30 % of its share) + profile ≤ 1 600 +
  numbers. Chunked review was not chosen (N+1 calls per reviewer, loses the whole-book view). API under
  `/api/projects/{pid}/branches/{b}/report`: `GET` (overview: latest, stale, reviewers, job), `POST {ai?, slots?,
  report_id?}` → 202 job (JobStore kind `book_review`, resumable), `GET job/{id}`, `GET {rid}?format=json|md|pdf
  &download=1` (`file_name`: "<title> - Akọwe report - <date>"; `server.content_disposition` adds the UTF-8 name).
  Run step `report` (`_s_report`, independent AIs only; failures ⚠️ `REPORT_FAILED`, none → `REPORT_NOT_INDEPENDENT`).
  The shelf adds `report`, `pipeline`, `variant_of`. PDF: `render_pdf` = the Markdown through `exporters.layout.paginate`
  + `exporters.pdf.render_pdf` (Helvetica, cp1252-safe text).
* **P14 compare** (`compare.CompareService`, `app.compare`): `POST /api/compare {a, b, scope: book|chapter, slots?}`
  (chapter: `{project_id, record_id, version?}`) → 202 job kind `compare`; `GET /api/compare`, `GET /api/compare/{id}`,
  `GET /api/compare/job/{id}`. Per reviewer `secrets.SystemRandom().choice` decides which side is Version 1; context is
  only `{version_1, version_2, dimensions}` (texts via `side_view`, ≤ `SIDE_MAX_CHARS` 30 000 each); `reveal` maps back;
  `aggregate` = median per side and dimension, winner per dimension, votes, overall winner. Stored in setting
  `comparisons` (30 kept), outbox `quality.compared` in both books.
* **UI**: `viewReport` (`#/p/<pid>/<b>/report`), `viewCompare` / `compareResult` (`#/compare[?a=&b=]`, `#/compare/<id>`),
  `openVariantDialog`, `pipelineFields`, `bookSection5Card`, `lengthSettingsCard`, run window `runVariantLine`,
  `runReportBox`, ETA and per-chapter `mb-item-length`; `LENGTH_INFO`/`LENGTH_TIP`; problems.js `REPORT_*`,
  `QUOTE_NOT_FOUND`, `COMPARE_*`, `BOOK_TOO_SHORT`, `CHAPTER_UNDER_TARGET`, `LENGTH_EXPAND_FAILED`.
* Tests: `tests/test_section5.py`; the fake AI answers `scene_text` (kind `scene_prose`), `continuation` (`expand`:
  empty unless `expand_text`), `book_scores` (`book_review`, `book_review_script`), `version_1/version_2` (`compare`:
  prefers the longer version, `compare_script`); `max_chapters` (default 6) caps B11.

## 💾 Section 6: save the book (P20), 📂 open a saved book / 🔁 rerun (P21)

* **Books folder** (`book_save.SaveService`, `app.saver`): settings key `books_folder` = {path?, auto_save?}; default
  `%USERPROFILE%\Documents\Akowe Books` on Windows when that Documents folder exists, else `~/Akowe Books`
  (`AKOWE_BOOKS_DIR` overrides the default, `AKOWE_AUTOSAVE=0` makes auto-save default to off — **tests/conftest.py
  sets both**, so the suite never writes into a real Documents folder and only `tests/test_section6.py` saves).
  `check_folder`: absolute, at most `MAX_PATH - 60` characters, writable (a probe file). API: `GET|PUT
  /api/settings/books-folder {path ("" = default), auto_save}` (+ `writable`, `problem`, `local`).
* **One folder per book**: named once `"<safe title ≤ 60> (<last 6 of the project id>)"` (`, <branch>` when not main),
  remembered in `book_folder:<pid>:<branch>`; a new title keeps the folder; a folder whose marker names another book
  gets a ` 2` suffix. `safe_name`: no `<>:"/\|?*`/control characters, no trailing dots/spaces, reserved names
  (CON, PRN, AUX, NUL, COM1-9, LPT1-9) get a `_` prefix; the title cap shrinks until base + folder + 60 ≤ 200;
  `save_now` refuses a longest path > `MAX_PATH` (200) with `SAVE_PATH_TOO_LONG`.
* **Contents** (`collect`, read-only): `Book/` (BookPath export files re-read with `read_binary`, sha256 checked; out of
  date ones named “(older version)”), `Chapters/NN - <title ≤ 40>.md` (`book_report.book_chapters`: approved text, else
  newest draft marked DRAFT), `Book Bible/` (`book_bible.build` → JSON + `render_markdown`), `Reports/` (latest book
  report MD/PDF, `Editor summary.md` from `craft_reviews`, `Planned to page.md` from `review.planned.book`), `Log/`
  (`journal.render_markdown`, `run-events.json` = the book's autobook/write_all jobs: steps, states, times, problems,
  `ai_per_step` from event slots, events without book text), `Progress/progress.json` (BookPath.status steps/next, words,
  chapters, the latest run's state), `book.akowe`, `README.txt`, `.akowe-folder.json` (marker: project, files
  written). Every text goes through `book_package.guard` (the saved API keys / connection keys and the access token →
  `[redacted]`).
* **Writes**: `write_atomic` = temp file in the same folder (`store.tmp_name`), flush + fsync, `store.replace_file`
  (Windows sharing-violation retries); unchanged bytes are not rewritten; files listed in the old marker and no longer
  produced are removed; nothing else in the folder is touched. `classify` maps OSError → `SAVE_DISK_FULL`
  (ENOSPC/EDQUOT, winerror 39/112), `SAVE_PATH_TOO_LONG` (ENAMETOOLONG, 206), `SAVE_FOLDER_NOT_WRITABLE` (EACCES,
  EPERM, EROFS, ENOENT, ENOTDIR, 3/5), else `SAVE_FAILED`.
* **Background / automatic saves**: `start(pid, branch, kind)` (one thread per book; a running save is returned; a
  manual press during a save runs once more after it) → `book_save:<pid>:<branch>` = {ok, at, kind, path, files, bytes,
  finished, problem}. `auto(pid, branch, reason, force)` never raises and returns at once: auto-save off → nothing
  (manual saves still work); `force` or the last save older than `interval_s` (120) → now; else one `threading.Timer`
  for the rest of the interval (the newest state is saved then); busy → once more afterwards. Hooks: after every
  Make-a-book step (`_autosave`), after each chapter, at the end of the run thread whatever the outcome (finished,
  paused, cancelled, a problem: `force`), Write all chapters (each chapter; force at the end), the author's approvals
  (`/review/approve`) and book steps (`book_act`; export forces), and `after_start` for runs found interrupted at
  start-up. Test projects (self-test / workflow test) are never auto-saved. The run's public view carries
  `save = saver.brief()`.
* **API**: `POST .../branches/{b}/save` → 202 job; `GET .../save` → {path, books_folder, last, job, auto_save, local,
  opened {finished, next_step, resumable_run}} (does not count as opening the book: no `touch_project`);
  `GET .../bible?format=summary|json|md[&download=1]`; `POST /api/books-folder/show {project_id?}` (opens the folder in
  Explorer/Finder/xdg-open via `saver.launch`, replaced in tests).
* **Localhost only**: the HTTP handler sets `app.set_client(client_address[0])` around each route; `App.is_local()` is
  true for 127.x, ::1, ::ffff:127.x and in-process calls. Listing the books folder, opening a folder, reading a folder's
  bible and showing a folder in the file manager answer 403 `PERMISSION_DENIED` with `problem: OPEN_NOT_LOCAL`
  otherwise (the UI offers 📋 Copy the folder path / an upload instead).
* **Problem codes**: API refusals keep a kernel code (`errors.py` stays closed) and add `errors[0].problem` (the
  problems.js code) and `fix`; `toProblem` in app.js prefers `problem`. New codes: `SAVE_FAILED`,
  `SAVE_FOLDER_NOT_WRITABLE`, `SAVE_PATH_TOO_LONG`, `SAVE_DISK_FULL`, `OPEN_NOT_LOCAL`, `OPEN_FAILED`,
  `OPEN_BAD_PACKAGE`, `OPEN_NEWER_VERSION`, `OPEN_TOO_LARGE`, `OPEN_NOT_FOUND`, `BIBLE_BAD`, `BIBLE_RERUN`,
  `BIBLE_ENTRY_REFUSED`, `BIBLE_PLAN_REFUSED`.
* **The book bible** (`book_bible.py`, `schema_version` 1, `kind: akowe-book-bible`, `app_version`, `saved_at`,
  `source`): profile (title … chapters), choices, pipeline, length plan; `characters` (A01: data + sheet + voice,
  approved version else newest draft with `approved: false`), `canon` (every other Set A head), `protected_facts`
  (from `protected_fact_flags`), `plan` {premise B01, main_plot B03, outline B11} (OUTPUT data), `scene_cards` of the
  current outline, `story_rules`, `world_texture`. `clean(raw)` (≤ 8 MB) refuses a newer schema (`OPEN_NEWER_VERSION`)
  or anything else (`BIBLE_BAD`) and cleans every part with the book's own cleaners (`clean_profile`,
  `story_choices.clean`, `pipeline.clean`, `clean_sheet/voice`, `scenes.clean_cards`, `story_rules.clean_rules`,
  `texture.clean_items`).
* **The package** (`book_package.py`, zip, `schema_version` 1): `manifest.json` (format, versions incl.
  `store_schema_version`, project id, title, counts, `files` = sha256 of every entry), `book/tables.json`
  (`Store.export_project_rows`: every row of the project in `Store.PACKAGE_TABLES`, one read transaction; BLOBs as
  `{"$blob": text}`), `book/settings.json` (settings whose key contains the project id + its autobook/write_all jobs;
  never `book_folder:`, `book_save:`, `rerun_bible:`), `assets/<sha256>.bin`, `book-bible.json`. `read` checks size
  (512 MB file, 1 GB unpacked, 50 000 entries), safe names, the manifest, every checksum, every JSON record's
  content hash, every binary's asset and refuses newer versions.
* **Opening = a NEW book** (`transplant` + `Store.import_project_rows` + `Store.write_asset`, both new store helpers:
  insert-only, one transaction, refuse an existing project id or a row of another book; the importer gets the owner
  grant): new project id; new ids for audit, provenance, events, approvals, edges, checkpoints and the jobs
  (`_new_id` keeps the prefix); record IDs/versions are kept. Records hash their project id, so JSON records are
  rewritten in dependency order (a record's content names the hashes it refers to) and every old hash → new hash is
  replaced everywhere (later records, lifecycle, audit, provenance, approvals, receipts, edges, module state, outbox
  with its `payload_hash`, feature manifests with their `content_hash`, settings such as the path memory). Imported
  runs that were live become `interrupted` (“Opened from a saved book — press ▶ Resume”). The project name gets
  “ (opened)” (“ (opened 2)” …) only when that name exists; the profile title is unchanged (so the exports stay
  current). `verify` re-hashes every record and file; a failing import is removed again (`OPEN_FAILED`).
  Known limit: an approval's `action_hash` (a hash over the action as it was signed) keeps its old value (history).
* **API**: `GET /api/books-folder` (folders with `book.akowe` and/or `Book Bible/book-bible.json`: title, saved_at,
  finished, chapters, `in_library`), `POST /api/books-folder/open {folder}` (a plain folder name inside the books
  folder, never a path), `GET /api/books-folder/bible?folder=`, `POST /api/books/open` (multipart/form-data, raw bytes
  or a JSON body; ≤ `MAX_BODY` 64 MB): a zip → package import (201 {kind: package, project_id, name, finished,
  next_step, resumable_run}), JSON → bible kept as `bible_upload:<id>` (newest 5) → {kind: bible, bible_id, summary};
  `GET /api/books/bible/{id}`.
* **Continue / rerun** (`AutoBookService`): `POST /api/autobook {author_confirms, continue_project}` = a run on that
  existing book (`run.project_id` preset, consent scope “continuing …”; every step is an idempotent ensure, so done
  work is skipped). `{author_confirms, from_bible: {project_id[, branch_id]} | {folder} | {bible_id}, reuse_plan}`
  (`OpenService.resolve_bible`) = a NEW book: the bible is stored as `rerun_bible:<pid>` (deleted with the book), the
  run takes its length, choices, pipeline and genre; `_s_profile` saves its profile (book named “<title> (rerun)”);
  `_seed_canon` creates its Set A entries as drafts (A03, A04, others, then A01; `linked_refs` remapped by old record ID
  with `book_bible.remap_refs`; sheets/voices saved) and the canon step reviews and approves them under the run
  consent (no Bible Builder while an A01 exists; extra Set A ops join `canon_ops`); `_seed_world` saves the rules and
  texture (the outline step may still update the rules for the plan); with `reuse_plan`, `_plan_from_bible` creates
  B01/B03/B11 with `manual_candidate` = the saved OUTPUT (once each; refused → event `BIBLE_PLAN_REFUSED` and the AI
  writes it) and `_seed_scenes` saves the scene cards for the new outline (checked and approved before each chapter).
  Events `BIBLE_RERUN` (start, with the consent wording), `bible`, `BIBLE_ENTRY_REFUSED`.
* **UI** (app.js): `booksFolderCard` (Settings), `saveBox` / `savedLine` / `runSave` / `folderButton`, `quickSave` (top
  bar 💾 while a book is open), `bookSaveCard` (book page: save, 🔁, ⬇ bible, ▶ continue / resume for an unfinished
  book), `runSaveLine` + `runBibleLine` (run window), shelf `sb-save` / `sb-rerun`, `openSavedBookDialog` (top bar 📂 /
  Your books), `openRerunDialog`, `continueBook`.
* Tests: `tests/test_section6.py` (folder layout and contents after a fake-AI run, secrets/prompts absent incl. inside
  the package, debounce + forced saves + pause, atomic writes with an injected ENOSPC, title change keeps the folder,
  Windows-unsafe titles and long paths, package round trip on the same and another data folder, continue an unfinished
  opened book and resume its imported run, damaged/newer/foreign packages refused, store helpers never overwrite,
  rerun with and without the plan, a book-bible.json upload (multipart) and refusals, localhost-only routes over HTTP).

## 🗂 B5 Character Forge dossiers (forge.py, forge_pdf.py, forge_example.py, web/forge.js)

The full description (model, sync rules, API, AI groups, pictures, PDF, letters in prompts) is
`../docs/CHARACTER_FORGE.md`; the shared contract with AutoInjector's `/image/request` is `../docs/SD_IMAGE_API.md`.
* **Data**: companion settings `forge:<pid>:<branch>` (per kind and A01 record id); mirrored fields keep `sync` (what
  the dossier last wrote to the sheet / voice card) so an edit on the character page wins; proposals are never written
  through (`mutate(..., write=False)`). Codes: the lowest free `CH-nnn` in canon order (`provisional_codes`).
* **Jobs** run in `ReviewService` (`ForgeJob(ReviewJob)` with `total`): poll `review/ai/{job}`; kind `review_forge` is
  resumable from the jobs list. Art jobs map bridge error codes to `ArtProblem` → `job.error {code, message, fix}`.
* **PDF writer**: `exporters/pdf.py` gained `Page.size` (per-page MediaBox), `Page.background`, ops `rect` / `line` and
  an optional colour on `text`; existing exports are unchanged.
* **Brief**: `chapter_brief._forge_details` → `forge.chapter_brief` (accepted fields only, ≤ 2 500 chars).
* **Book save**: `Character Forge/<code> <name> - Character Forge dossier.pdf/.json` and `<code> pictures/`.
* Tests: `tests/test_forge.py` (fake AI `ForgeFake`, fake image bridge `FakeImageBridge`), UI
  `tests/campaign/ui/test_ui_forge.py`. Example data was built once from the author's sample with Pillow (not a runtime
  dependency).

## 🖼 B3 interior pictures (pictures.py, web/pictures.js)

The full description is `../docs/PICTURES.md`.
* **Data**: companion settings `pictures:<pid>:<branch>` (style, pictures with candidates = I01 binary assets); the
  snapshot `pictures_snap:<pid>:<branch>:<G02 id>` is written by `book_path.a_assemble` and read by
  `set_g.assemble` → `pictures.overlay` → `exporters/book.place_pictures` (so G04/G07/G11-13 agree);
  `asm["pictures"]` holds the signature and `assembly_out_of_date` compares it.
* **Jobs** run in `ReviewService` like the forge art jobs (`PicturesJob` with `total` and `pic_id`); the bridge,
  `ArtProblem` codes and the NO_LOCK fallback are forge.py's.
* **Exporters**: block `img` gained optional `caption` / `alt`; new block `vmap` (SVG text) and section kind `plate`;
  the PDF writer gained the op `circle`; `layout.winansi` for captions and map labels. Pictures are kept apart from
  G03 art (`Assembly.pictures`), so `artwork_selected` is unchanged.
* **HTTP**: `DELETE` is accepted for `…/pictures/<pic_id>` only (every other DELETE stays 405).
* Tests: `tests/test_pictures.py` (fake bridge `Bridge` with `script` / `hold`), UI `tests/campaign/ui/test_ui_pictures.py`.

## 🔎 Section 7a: timeline (P26), trade facts (P31), repetition sorter (P30)

* **Modules.** `timeline_check.check_book([(cid, text)], names=, characters=, story_year=)` reads ages (with an age
  marker, tied to a known name in the sentence; past sentences kept apart), birth years, the story's year and "N years
  ago, in YEAR" → findings `age_conflict`, `age_backwards`, `age_gap`, `age_canon` (minor), `year_arithmetic`,
  `time_backwards` (flashback chapters skipped). `terms.py`: the list (companion data `trade_terms:<pid>:<branch>` =
  {version, items, story_year, history}), `scan` (built-in `CONFLICTS` — a wick on a gas lamp —, `ANACHRONISMS` when the
  story year is known, equipment compounds, world-texture work words), `check_text` (`term_wrong`, `term_conflict`,
  `term_anachronism`, `term_unverified`), `ai_find` / `ai_research` (one AI call each; research answers are stored as
  `ai_note`, never as a verification), `decide` (verified / wrong / research needed — needs `author_confirms`; `save`
  refuses a NEW verified/wrong status). `repetition.sort_repeats` (3–6-word phrases inside sentences, 2 words only as a
  dialogue opener, overlapping windows merged; classes voice → motif → filler → accident; the author's label in
  `repetition_labels:<pid>:<branch>` wins; trim plan per occurrence; `protected` = exact words of voice/motif uses).
* **Glue** (`fact_checks.py`): `FactChecker` (`ReviewService.facts`) — `chapter` / `book` views over the newest text of
  every outline chapter, `scan_terms`, `ai_find`, `ai_research`, `propose_fix(kind="terms"|"repeats")` → findings with
  dimension `terminology` / `repetition` (ids `term<n>` / `rep<n>`, anchored at an exact unique sentence) → `editor.
  propose(craft=pseudo)`; the author applies them with `/review/editor/apply`. Editor hooks (2 lines in editor.py):
  `craft_one` adds `fact_checks` (timeline brief, term findings, repeats to keep / may trim, a note) to the context;
  `propose` adds `protected_keep` (voice/motif words, minus `craft["except_keys"]` of a ✨ Trim) to the keep list, so a
  rewrite that cuts them is `KEEP_LOST`. Both never raise. The C02 brief gets `trade_terms` (wrong + verified terms,
  research-needed ones the plan names, ≤ 1 200 chars) and `terms.RULE`.
* **Runs.** `autobook._facts_report` at the end of the `planned` step: `run_book_check` adds scanned terms as research
  needed (`added_by: run`), `run["facts_summary"]` and ⚠️ notes `TIMELINE_PROBLEMS`, `TERMS_WRONG`,
  `TERMS_RESEARCH_NEEDED`, `REPEATS_TO_TRIM` (`FACTS_CHECK_FAILED` when it breaks). Never blocks, never rewrites.
* **API** (under `/api/projects/{pid}/branches/{b}/review`): `GET facts` (book), `GET facts/{rid}` (chapter), `PUT
  facts/terms {items, version, story_year?}`, `POST facts/terms/scan {record_id?}`, `POST facts/terms/verify {ids,
  status, note?, use_instead?, version?, author_confirms}`, `POST facts/terms/ai {ids?}` (202), `POST facts/{rid}/find`
  (202), `POST facts/{rid}/fix {kind: terms|repeats}` (202 → proposal at `editor/{rid}`), `PUT facts/repeats {labels,
  version?}`. Routed by one block in server.py (`fact_checks.route`). UI (one block at the end of app.js): `factsCard`
  (chapter page), `bookFactsCard` (book page), `factsRunSummary` (run window); problems.js codes above.
* Tests: `tests/test_section7a.py`; the fake AI answers the term finder (`terms_script`), research and the fact fixes.

## 🧪 Test workflow (workflow_test.py)

`GET /api/workflow-test` (rows, project, report), `POST /api/workflow-test/run {rows: "all" | [ids]}` (202; 409 while
running; "all" makes a fresh "🧪 Workflow test <date>" project with setting `workflow_test: true` and archives the
previous test book), `POST /api/workflow-test/stop`, `GET /api/workflow-test/report?format=md|json`. Rows: ai,
premise, plot, outline, chapter, review, approvals, format, assemble, export, check. AI rows use a gated provider
registry (selftest's `SelfTestProviders`) limited to slots that pass the run's health check; without one they are
SKIPPED and a manual candidate keeps dependent rows going. Projects with `workflow_test`/`selftest` settings are
`test_book: true` in project summaries and never become the "last used" project.

## AutoInjector link: pairing and status push (Akọwe side)

* Pairing: AutoInjector opens `http://127.0.0.1:<port>/#/pair?code=<CODE>&bridge=<urlencoded bridge url>`. The page
  reads the fragment, removes it with `history.replaceState` (address becomes `#/pair`), and calls
  `POST /api/slots/pair-autoinjector {code, bridge_url}` (normal bearer auth; the browser token is also kept in
  `localStorage` so tabs opened by AutoInjector are authenticated). The server checks the code
  (`^[A-Za-z0-9-]{8,32}$`) and the bridge URL (`validate_bridge_url`: http 127.0.0.1/localhost only), then
  `POST <bridge>/v1/pair {"code", "client": "akowe"}` without Authorization (no proxy). 200
  `{"ok": true, "token"}` -> `connect_autoinjector(token)` (AI-1 claude, AI-2 chatgpt, AI-3 gemini) and a health check
  per slot; answer `{connected, bridge_url, slots: [{slot_id, site, ok, message, error, ...}], message}` - never the
  token. 401/404/410 -> 400 `EXPIRED_APPROVAL` "the pairing code expired or was already used — press Connect again in
  AutoInjector"; not reachable -> `UPSTREAM_UNAVAILABLE`.
* Status push (`StatusPusher`, daemon thread started by `main()`): when a slot uses the autoinjector adapter with a
  saved key, `POST <bridge>/v1/status` with `Authorization: Bearer <key>` and the body documented in
  `status_push.py` (`app, version: 1, akowe_url, project {id, title}, current_task {set, op, title, state,
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

`python -m pytest -q tests` (test-only packages: `requirements-test.txt`; CI: `.github/workflows/akowe-tests.yml`). Use the `h` fixture (tests/conftest.py): `h.create(op, payload)`,
`h.dispatch(op, action, ...)`, `h.validate(ref)`, `h.accept(ref)`, `h.approve(ref)`,
`h.create_approved(op, payload, manual_candidate=...)`, `h.set_features(magic=True)`.
For AI paths set `engine.providers.test_adapter` to a fake with
`submit(slot, system, user, schema) -> (dict, usage)` and configure a slot
(`engine.providers.configure_slot("AI-1", {"adapter_id": "anthropic"})`).
