# AutoInjector Upgrade — Master Task Breakdown

**Owner:** Javon
**Document type:** Work breakdown structure (WBS)
**Structure:** 5 main TASKS. Each main task contains numbered SUBTASKS. Each subtask is independently assignable, independently testable, and independently completable.

---

## How to read this document

Every subtask uses the same block:

| Field | Meaning |
|---|---|
| **Type** | `PG` = ordinary program code (authoritative). `LM` = local AI model (judgment only). |
| **Depends on** | Subtasks that must be DONE before this one starts. `—` means nothing blocks it. |
| **Build** | What actually gets built. |
| **Done when** | The objective test that closes the subtask. No opinions — a pass/fail check. |
| **Error handling** | What the code must do when this subtask's component fails. Required, not optional. |

**Global rule for every subtask in this document:** nothing fails silently. Every failure writes a log row containing timestamp, component ID, error class, message, and the affected MSG/JOB/TASK ID, and every failure has a defined fallback state.

---

## Claims ledger

A subtask heading prefixed with `[x]` is **complete**; `[~]` means **claimed / in
progress**. The claimant's name follows the prefix. Do not start a subtask that
already carries someone's name — pick the next unclaimed one from the top.

| Subtask | Owner | Status | Evidence |
|---|---|---|---|
| MDC-001-PG | Claude | ✅ DONE | `desktop-app/shared/db.js` · test `test/shared-db.test.js` |
| SCS-001-PG | Claude | ✅ DONE | `desktop-app/shared/message-log.js` · test `test/shared-db.test.js` |
| SCS-002-PG | Claude | ✅ DONE | `desktop-app/shared/message-log.js` · 1,000-concurrent-insert proof |

---

## Master task order

| # | Task | Prefix | Difficulty | Blocked by |
|---|---|---|---|---|
| TASK 1 | Shared Conversation & Synchronization System | SCS | Easiest | — |
| TASK 2 | Shared Memory, Database & Context System | MDC | Easy → Moderate | Partially TASK 1 |
| TASK 3 | Local AI Supervisor & Intelligence Layer | LSI | Moderate | TASK 1, TASK 2 |
| TASK 4 | Unified User Interface & File Workflow | UIF | Moderate → Hard | TASK 1, TASK 2 |
| TASK 5 | Desktop Server, Integration & Runtime Infrastructure | SRI | Hardest | TASK 1–4 |

**Bootstrap exception:** MDC-001 (the SQLite database) is physically built first, because every SCS subtask writes into it. It is listed under TASK 2 for organizational reasons, but it is scheduled before SCS-001.

---
---

# TASK 1 — Shared Conversation & Synchronization System

**Prefix:** SCS
**Difficulty:** Easiest
**Why this is first:** almost all of it is ordinary programming — records, counters, routing, delivery state. It fixes the biggest current problem: the three AIs receiving delayed and disconnected pieces of the conversation.

**Task 1 is complete when:** a message can be created, numbered, routed, delivered, retried, deduplicated, and every model's read position is provably current before it is asked to work.

---

### [x] SUBTASK SCS-001-PG — Shared Ordered Message Log — Claimed by Claude

**Status:** ✅ DONE (Claude, 2026-08-15). Built in `desktop-app/shared/message-log.js` (table in `shared/db.js`). One `messages` table for all sources; seq-order read reproduces the conversation with no gaps; failed writes park in `messages_deadletter` in a single transaction. Verified by `desktop-app/test/shared-db.test.js`.

**Type:** PG
**Depends on:** MDC-001
**Build:** One `messages` table holding every user, ChatGPT, Claude, Gemini, local-AI, and system message in a single chronological conversation instead of separate chat histories. Columns: msg_id, project_id, seq, from, to, reply_to, body, created_at, status.
**Example:** `MSG-000124 — Claude completed Task 7.`
**Done when:** all five sources write to the same table, and reading the project in `seq` order reproduces the full conversation with no gaps.
**Error handling:** a write that fails is retried 3× with backoff, then parked in `messages_deadletter` with the raw payload; the message is never dropped and never partially committed (single transaction).

---

### [x] SUBTASK SCS-002-PG — Automatic Message ID Numbering — Claimed by Claude

**Status:** ✅ DONE (Claude, 2026-08-15). Numbering is assigned only by the log (`append()` rejects a caller-supplied seq/msgId), inside a transaction with `UNIQUE(project_id, seq)` and retry-against-max on collision. Proven by a real multi-process test in `desktop-app/test/shared-db.test.js`: 1,000 concurrent inserts across 8 processes produce IDs 1..1000 with zero duplicates and zero gaps.

**Type:** PG
**Depends on:** SCS-001
**Build:** AutoInjector alone assigns the next message number. No model, no human, and no external process may choose one.
**Example:** `MSG-000124 → MSG-000125`
**Done when:** 1,000 concurrent inserts produce 1,000 unique consecutive IDs with zero duplicates and zero gaps.
**Error handling:** numbering runs inside a database transaction with a UNIQUE constraint on seq. On collision the insert retries against the current max; after 5 failed attempts the message is parked and an alert is raised.

---

### SUBTASK SCS-003-PG — FROM / TO / REPLY-TO Tracking

**Type:** PG
**Depends on:** SCS-002
**Build:** Every message records sender, intended recipient(s), and which earlier message it answers.
**Example:** `MSG-000125 FROM Claude TO ChatGPT REPLY-TO MSG-000124`
**Done when:** any message can be walked backwards through REPLY-TO to the originating user message.
**Error handling:** unknown sender/recipient → message accepted but flagged `ROUTING_UNRESOLVED` and handed to LSI-002 rather than discarded. A REPLY-TO pointing at a nonexistent message is nulled and logged, never left dangling.

---

### SUBTASK SCS-004-PG — Per-Model Read Position Tracking

**Type:** PG
**Depends on:** SCS-001
**Build:** A `read_position` row per model per project recording exactly how far that model has actually read. Stops a model answering from stale context.
**Example:** `ChatGPT: MSG-130 / Claude: MSG-130 / Gemini: MSG-124`
**Done when:** the dashboard can state each model's exact lag in message count at any moment.
**Error handling:** read position only advances on CONFIRMED delivery (SCS-006), never on send. If the stored position is ahead of the log's max seq (corruption), it is clamped back and flagged for resync.

---

### SUBTASK SCS-005-PG — Automatic Model Synchronization

**Type:** PG
**Depends on:** SCS-004, MDC-006
**Build:** Before a model answers a new job, AutoInjector first supplies the messages it missed.
**Example:** Gemini at 124 → supply MSG-125–130 before Job 131.
**Done when:** no model can be issued a job while its read position is behind the log.
**Error handling:** if the catch-up bundle exceeds the model's context limit, fall back to LSI-003 summarization; if sync fails entirely, the job is held in `BLOCKED_UNSYNCED` and surfaced in the UI instead of being sent half-informed.

---

### SUBTASK SCS-006-PG — Message Delivery & Retry Tracking

**Type:** PG
**Depends on:** SCS-003
**Build:** Per-recipient delivery state: PENDING / DELIVERED / FAILED / TIMEOUT / RETRY-n.
**Example:** `MSG-131: Claude DELIVERED / Gemini RETRY-1`
**Done when:** every message shows a terminal state per recipient, and no message sits in PENDING past its timeout.
**Error handling:** exponential backoff (5s/15s/45s), maximum 3 retries, then FAILED_PERMANENT with UI alert. Retries reuse the same MSG ID so retrying can never create a second message.

---

### SUBTASK SCS-007-PG — Duplicate Message Prevention

**Type:** PG
**Depends on:** SCS-002
**Build:** Exact-match deduplication by message ID and by content hash within a time window.
**Example:** Second `MSG-131` → `DROP_DUPLICATE`
**Done when:** replaying the same message twice results in one stored message and one `DROP_DUPLICATE` log row.
**Error handling:** drops are logged with the reason and the original MSG ID so a wrongly-dropped message can be recovered from the log rather than lost.

---

### SUBTASK SCS-008-LM — Stale Message Detection

**Type:** LM
**Depends on:** SCS-012, LSI-001
**Build:** Local model judges whether a message relies on obsolete project information.
**Example:** Baseline A referenced; current baseline C → `STALE`
**Done when:** a message referencing a superseded baseline is flagged STALE before it reaches a cloud model.
**Error handling:** local model unavailable or low confidence → `STALE_UNKNOWN`, message passes through with a warning banner attached. The system degrades to working-but-noisy, never to blocked.

---

### SUBTASK SCS-009-LM — Acknowledgment Loop Suppression

**Type:** LM
**Depends on:** LSI-001
**Build:** Recognizes "standing by," "confirmed," "holding," and similar content that adds no new information.
**Example:** `"Standing by." → DROP_NO_NEW_STATE`
**Done when:** a two-model acknowledgment ping-pong terminates within 2 exchanges.
**Error handling:** suppressed messages are stored with status SUPPRESSED (not deleted) and remain visible in the UI under "show suppressed." If suppression rate exceeds a configured threshold, the filter auto-disables and alerts.

---

### SUBTASK SCS-010-LM — Response-Required Detection

**Type:** LM
**Depends on:** LSI-001
**Build:** Local model decides whether another AI actually needs to answer.
**Example:** status-only message → `RESPONSE_REQUIRED: NO`
**Done when:** status broadcasts stop generating obligatory replies.
**Error handling:** on uncertainty default to `RESPONSE_REQUIRED: YES` — a wasted reply is cheaper than a dropped instruction.

---

### SUBTASK SCS-011-LM — Contradiction Detection

**Type:** LM
**Depends on:** SCS-012, MDC-002
**Build:** Detects statements inconsistent with the authoritative project state in the database.
**Example:** message says 18 tests; database says 25 → `CONFLICT`
**Done when:** a contradicting claim raises CONFLICT and does not overwrite database state.
**Error handling:** the database always wins. A CONFLICT never auto-corrects the database; it raises a UI decision item. Detector failure downgrades to no-check plus a log entry.

---

### SUBTASK SCS-012-PG — Current-State / Baseline Tracking

**Type:** PG
**Depends on:** MDC-001
**Build:** Records the authoritative package, hash, stage, and task state for the project.
**Example:** `BASELINE = bdf111f5...`
**Done when:** exactly one baseline row is marked CURRENT per project, with full history retained.
**Error handling:** baseline changes are append-only with previous-hash linkage; a mismatched or unverifiable hash refuses promotion and keeps the prior baseline CURRENT.

---

### SUBTASK SCS-013-PG — Task Ownership & Collision Prevention

**Type:** PG
**Depends on:** MDC-002
**Build:** Records who owns each task so two models cannot independently perform the same work.
**Example:** `TASK-027 OWNER=Claude` → duplicate assignment rejected
**Done when:** a second assignment attempt on an owned task is rejected with a clear reason.
**Error handling:** ownership locks carry a lease/timeout so a crashed model does not hold a task forever; expired leases release with a logged `OWNER_LEASE_EXPIRED` and the task returns to the queue.

---
---

# TASK 2 — Shared Memory, Database & Context System

**Prefix:** MDC
**Difficulty:** Easy → Moderate
**Why:** this becomes the system's shared memory. Instead of expecting each AI to remember everything from its own chat window, AutoInjector stores project knowledge locally and hands each model only what that job needs.

**Task 2 is complete when:** any job can be assembled into a targeted context package from the local database, without pasting the whole project into a model.

---

### [x] SUBTASK MDC-001-PG — Local SQLite Project Database — Claimed by Claude

**Status:** ✅ DONE (Claude, 2026-08-15). Built in `desktop-app/shared/db.js` on Node's built-in `node:sqlite` (no new dependency). WAL mode on; versioned via `PRAGMA user_version` with a pre-migration snapshot; on corruption the open path refuses to run dirty and restores the last good snapshot (`VACUUM INTO`), or fails loudly if none exists. Survives restart with data intact. Verified by `desktop-app/test/shared-db.test.js`.

**Type:** PG
**Depends on:** —
**Build:** The central local database holding project state and shared information. Built FIRST — every other subtask writes here.
**Example:** `PROJECT-004 → Lighthouse Novel`
**Done when:** schema is created, migrations are versioned, and the database survives a service restart with all data intact.
**Error handling:** WAL mode on; automatic nightly backup plus pre-migration snapshot; on corruption detection the service refuses to start dirty and restores the last good snapshot rather than continuing on damaged data.

---

### SUBTASK MDC-002-PG — Structured Shared Memory

**Type:** PG
**Depends on:** MDC-001
**Build:** Typed tables for tasks, characters, decisions, messages, timelines, facts, statuses, artifacts.
**Example:** `CHAR-003 Mara Vey`
**Done when:** every entity type has a stable ID prefix, created/updated timestamps, and a project_id foreign key.
**Error handling:** foreign keys enforced; orphaned rows rejected at write time, not cleaned up later. Every write is validated against the type schema and rejected with a specific field-level reason.

---

### SUBTASK MDC-003-PG — Full-Text Project Search

**Type:** PG
**Depends on:** MDC-002
**Build:** Ordinary SQLite FTS5 exact word/phrase search. No model involved.
**Example:** search `"lighthouse lens"` → 14 records
**Done when:** search returns results across all entity types in under one second on the full project.
**Error handling:** if the FTS index is missing or stale it rebuilds automatically on startup; if rebuild fails, search falls back to slower LIKE scanning and warns rather than returning nothing.

---

### SUBTASK MDC-004-LM — Semantic / Vector Memory Search

**Type:** LM
**Depends on:** MDC-003, SRI-016
**Build:** Embedding-based search that finds related information when wording differs.
**Example:** query → `DEC-018, CH06, WORLD-004`
**Done when:** a paraphrased query returns the correct record that exact-text search misses.
**Error handling:** embedding service down → automatic fallback to MDC-003 full-text with a `DEGRADED_SEARCH` flag on the result set. Embeddings are versioned; a model change triggers reindex rather than mixing incompatible vectors.

---

### SUBTASK MDC-005-PG — Automatic Context Retrieval

**Type:** PG
**Depends on:** MDC-003, MDC-004
**Build:** For a given job, AutoInjector pulls the known required records automatically.
**Example:** `JOB-205 CH07` → chapter card + characters
**Done when:** a job of a known type retrieves its full required record set with no manual selection.
**Error handling:** a missing required record blocks the job with `CONTEXT_INCOMPLETE: <missing item>` and lists exactly what is absent — it does not send a partial package silently.

---

### SUBTASK MDC-006-PG — Context Package Builder

**Type:** PG
**Depends on:** MDC-005
**Build:** Assembles a targeted, size-bounded context package (`CTX-xxxx`) instead of the entire project.
**Example:** `CTX-0205 = chapter card + Mara + timeline + open threads`
**Done when:** every package is stored with its own ID, contents manifest, and token estimate, and is reproducible after the fact.
**Error handling:** if the package exceeds the target model's context budget it drops lowest-priority sections in a defined order and records what was dropped in the manifest; it never truncates mid-record.

---

### SUBTASK MDC-007-PG — AI File Request System

**Type:** PG
**Depends on:** MDC-009
**Build:** A model can request a project file directly from AutoInjector via a structured command.
**Example:** `MSG-206 REQUEST_FILE BLUEPRINT.md`
**Done when:** a request returns the authoritative current version, and every request is logged with requester, file, version, and result.
**Error handling:** unknown file → structured `FILE_NOT_FOUND` plus the closest matching names. Permission denied → explicit `ACCESS_DENIED` reason, never an empty response the model will misread as "file is blank."

---

### SUBTASK MDC-008-PG — Artifact Version & Hash Tracking

**Type:** PG
**Depends on:** MDC-002
**Build:** Versions and SHA-256 hashes for every artifact so models always receive the authoritative copy.
**Example:** `BLUEPRINT.md v7 SHA256=...`
**Done when:** any delivered file can be verified against its recorded hash, and version history is complete.
**Error handling:** hash mismatch on read blocks delivery and raises `ARTIFACT_INTEGRITY_FAIL`; the previous verified version is offered instead of serving a possibly-corrupted file.

---

### SUBTASK MDC-009-PG — Shared Project File Manager

**Type:** PG
**Depends on:** MDC-008
**Build:** Controls where files live and which model may read or write each path.
**Example:** Claude requests `CH04.md` → approved version returned
**Done when:** all file access flows through this layer; no component touches project files directly.
**Error handling:** writes are atomic (temp file + rename); concurrent writes are serialized per path with a lock; a failed write leaves the previous version untouched and logs the attempt.

---
---

# TASK 3 — Local AI Supervisor & Intelligence Layer

**Prefix:** LSI
**Difficulty:** Moderate
**Why:** this is the small local model running on the AI-server desktop's GPU. It does NOT perform work that ordinary software performs reliably. It handles only decisions that require understanding language, intent, meaning, or context.

**Task 3 is complete when:** the local supervisor can classify, route, summarize, and flag traffic — and the system still functions correctly when the local model is switched off.

---

### SUBTASK LSI-001-LM — Local Supervisor AI

**Type:** LM
**Depends on:** SRI-016
**Build:** Small local model monitors traffic and assists AutoInjector with fuzzy decisions. Fixed prompt contract in, strict JSON verdict out.
**Example:** `MSG-240 → analyze relevance and recipient`
**Done when:** every supervisor call returns schema-valid JSON with a confidence score, and the call is logged with input hash, verdict, and latency.
**Error handling:** invalid JSON → 1 reparse attempt, then `VERDICT_UNAVAILABLE` and the safe default for that check. Hard timeout (default 10s). If the supervisor is offline, the whole system runs in PG-only mode — degraded judgment, zero downtime.

---

### SUBTASK LSI-002-LM — Intelligent Message Routing

**Type:** LM
**Depends on:** LSI-001, SCS-003
**Build:** Decides where a message belongs when the intent or recipient is not explicit.
**Example:** `"Check continuity" → Gemini Auditor`
**Done when:** messages with no explicit TO field are routed correctly in a labelled test set at an agreed accuracy threshold.
**Error handling:** ambiguous or low confidence → route to the user as a decision item rather than guessing. A route to an offline/incapable model is rejected by LSI-006 before sending.

---

### SUBTASK LSI-003-LM — Message Summarization & Compression

**Type:** LM
**Depends on:** LSI-001, SCS-001
**Build:** Converts a message range into a compact state update to reduce context consumption.
**Example:** `MSG-241–255 → SUMMARY-0255`
**Done when:** summaries are stored as first-class records linked to the exact message range they cover, and can be expanded back to the originals.
**Error handling:** summaries never replace originals — originals are always retained. If summarization fails, send the raw range if it fits, otherwise block the job with `CONTEXT_TOO_LARGE` rather than silently omitting messages.

---

### SUBTASK LSI-004-LM — Semantic Duplicate Detection

**Type:** LM
**Depends on:** LSI-001, SCS-007
**Build:** Recognizes messages that mean the same thing despite different wording. Complements SCS-007's exact matching.
**Example:** `"Waiting for instructions" ≈ "Standing by" → suppress`
**Done when:** semantically identical acknowledgments are suppressed while genuinely new content passes through.
**Error handling:** suppression requires high confidence; below threshold the message passes. All suppressions are reversible and visible in the UI.

---

### SUBTASK LSI-005-LM — State Extraction

**Type:** LM
**Depends on:** LSI-001, MDC-002
**Build:** Extracts proposed state changes from natural-language messages for validation against the database.
**Example:** `"Chapter 7 completed" → proposed CH07 STATUS=COMPLETE`
**Done when:** extracted changes are written as PROPOSALS, never applied directly.
**Error handling:** every proposal is validated by PG code against the schema and the current state before commit. A proposal that conflicts (SCS-011) or lacks evidence (LSI-008) is held for user approval. The local model never writes authoritative values itself.

---

### SUBTASK LSI-006-LM — Capability Awareness

**Type:** LM
**Depends on:** LSI-001, MDC-002
**Build:** Tracks which model/service can actually perform which operations, so impossible routes are not attempted repeatedly.
**Example:** Gemini cannot access artifact → choose supported route
**Done when:** a known-impossible route is blocked before the request is sent.
**Error handling:** capability table is PG-owned and updated from observed failures; a capability marked unknown is attempted ONCE and the result recorded. Repeated identical failures auto-mark the route unsupported and alert.

---

### SUBTASK LSI-007-LM — Intelligent Failure Interpretation

**Type:** LM
**Depends on:** LSI-001, SCS-006
**Build:** Reads errors and recommends a recovery path instead of blind retrying.
**Example:** file unavailable → `REQUEST_FILE` instead of repeating the prompt
**Done when:** common failure classes map to a recommended action recorded on the failure row.
**Error handling:** recommendations are advisory — PG retry limits still apply and cannot be overridden by the model. If no confident interpretation exists, escalate to the user with the raw error attached.

---

### SUBTASK LSI-008-LM — Execution-Claim Verification Assistant

**Type:** LM
**Depends on:** LSI-001, SRI-010
**Build:** Identifies claims that something was executed or tested, and checks whether the required evidence record exists.
**Example:** `"Tests passed"` + no RUN evidence → `UNVERIFIED`
**Done when:** no claim of execution is accepted into project state without a matching evidence record.
**Error handling:** UNVERIFIED claims are stored and displayed as unverified — they never update task status. Missing evidence is a hold, not a rejection: the user can attach evidence or override with a logged reason.

---

### SUBTASK LSI-009-LM — Conversation Stopping Decision

**Type:** LM
**Depends on:** LSI-001, SCS-010
**Build:** Decides when continued model-to-model conversation adds no value.
**Example:** no state change + no action required → `STOP RELAY`
**Done when:** relay loops terminate automatically without user intervention.
**Error handling:** a hard PG-side cap on relay depth (default 6 exchanges) runs regardless of the model's opinion. Every stop is logged with its reason and can be manually resumed.

---

## TASK 3 — Authority split (binding rule)

**The local model does NOT control:** message numbering · timestamps · database storage · delivery state · retry counters · task ownership · file hashes · artifact versions · permissions.
→ Ordinary program code controls all of these.

**The local model DOES handle:** meaning · relevance · semantic duplicates · contradictions · summarization · intent · response necessity · failure interpretation.

**Enforcement subtask:** the write layer physically rejects any authoritative-field write originating from the LM path. This is a code-level guard, not a convention.

---

# TASK 4 — Unified User Interface & File Workflow

**Prefix:** UIF
**Difficulty:** Moderate → Hard
**Why:** turns AutoInjector into the main interface, instead of constantly operating separate AI windows, Stable Diffusion, photogrammetry software, folders, and server utilities.

**Task 4 is complete when:** a normal working session — upload, assign, watch, download — never requires leaving AutoInjector or touching a command line.

---

### SUBTASK UIF-001-PG — User File Upload System

**Type:** PG
**Depends on:** MDC-009
**Build:** Upload files directly into the active project.
**Example:** `research.pdf → PROJECT-004/Incoming/`
**Done when:** uploaded files appear in the project, are hashed, and are registered as artifacts automatically.
**Error handling:** size and type limits enforced with clear messages; interrupted uploads resume or clean up their partial file; duplicate content is detected by hash and offered as "already present" instead of silently duplicating.

---

### SUBTASK UIF-002-PG — Generated File / Download Manager

**Type:** PG
**Depends on:** MDC-008, SRI-021
**Build:** One place where all AI-created files appear for download.
**Example:** `ART-055 ATELIER.zip [Download]`
**Done when:** every generated artifact is downloadable from the UI with its version and hash shown.
**Error handling:** a missing file on disk shows `ARTIFACT_MISSING` with its last known path and job ID rather than a broken link; downloads verify hash before serving.

---

### SUBTASK UIF-003-PG — Unified ChatGPT / Claude / Gemini Interface

**Type:** PG
**Depends on:** SCS-006
**Build:** All three cloud models operated from inside one AutoInjector application.
**Example:** `ChatGPT / Claude / Gemini`
**Done when:** a message can be sent to any of the three and its reply captured, without opening a separate browser window.
**Error handling:** per-model connection status is always visible; auth expiry raises a specific `REAUTH_REQUIRED` prompt for that model only, and queued work for that model holds instead of failing.

---

### SUBTASK UIF-004-PG — Unified Conversation Timeline

**Type:** PG
**Depends on:** SCS-001
**Build:** Visual, ordered display of the single message stream.
**Example:** `MSG-300 → MSG-301 → MSG-302`
**Done when:** the timeline shows sender, recipient, delivery state, and suppressed/stale flags in order.
**Error handling:** if the live feed drops, the UI shows a stale-data banner with the last synced MSG ID and auto-reconnects — it never displays old data as current.

---

### SUBTASK UIF-005-PG — Project Status Dashboard

**Type:** PG
**Depends on:** SCS-012, MDC-002
**Build:** Shows where the project currently stands.
**Example:** `Blueprint ✓ / CH04 Drafting / Audit Pending`
**Done when:** the dashboard reads only from authoritative database state, with a visible last-updated timestamp.
**Error handling:** unavailable values render as `UNKNOWN`, never as zero or blank — a missing reading must never look like a real one.

---

### SUBTASK UIF-006-PG — Task / Milestone Dashboard

**Type:** PG
**Depends on:** SCS-013
**Build:** Active, completed, blocked, and assigned tasks in one view.
**Example:** `TASK-48 Claude ACTIVE`
**Done when:** every task shows owner, status, blocker, and age.
**Error handling:** tasks stalled beyond a threshold are highlighted automatically; expired ownership leases are shown as reclaimable rather than quietly reassigned.

---

### SUBTASK UIF-007-PG — Model Status Dashboard

**Type:** PG
**Depends on:** SCS-004, SCS-006
**Build:** What each AI is doing and how synchronized it is.
**Example:** `Claude: Working / Gemini: 4 messages behind`
**Done when:** sync lag and current job are shown per model, live.
**Error handling:** a model that stops responding flips to `UNRESPONSIVE` after a timeout with its last contact time; the UI distinguishes "idle" from "unreachable."

---

### SUBTASK UIF-008-PG — Start / Pause / Resume Controls

**Type:** PG
**Depends on:** SRI-009
**Build:** Workflow control without command-line work.
**Example:** `[START] [PAUSE] [RESUME] [STOP]`
**Done when:** each control produces the correct state transition and is reflected in the job record.
**Error handling:** PAUSE completes the in-flight step then holds at a checkpoint rather than killing mid-write; STOP requires confirmation and records who stopped it and when; a control that cannot be honoured returns a reason instead of appearing to succeed.

---

### SUBTASK UIF-009-PG — Unified AI-Server Tool Dashboard

**Type:** PG
**Depends on:** SRI-012
**Build:** Makes AutoInjector the primary interface for the other AI/server programs on the desktop.
**Example:** `AI / Images / 3D / Files / Jobs / Server`
**Done when:** every integrated service is reachable from one navigation surface with live status.
**Error handling:** an offline service shows OFFLINE with its last error and a restart control; its panel disables rather than throwing errors on click.

---

### SUBTASK UIF-010-PG — Stable Diffusion Interface

**Type:** PG
**Depends on:** SRI-017, SRI-018
**Build:** Generate images through AutoInjector without manually opening the underlying image software.
**Example:** `Images → Generate → ART-205.png`
**Done when:** a prompt submitted in AutoInjector returns a stored, project-linked artifact.
**Error handling:** VRAM exhaustion, model-file-missing, and workflow errors surface as distinct messages; failed generations keep the job record with the exact parameters so it can be requeued unchanged.

---

### SUBTASK UIF-011-PG — Advanced Stable Diffusion Access

**Type:** PG
**Depends on:** UIF-010
**Build:** Opens the full Stable Diffusion / ComfyUI interface when advanced control is needed.
**Example:** `Images → Advanced → ComfyUI`
**Done when:** the advanced interface opens with the current project context and outputs still land in project storage.
**Error handling:** if ComfyUI is not running, offer to start it rather than opening a dead link; work started in advanced mode is still registered as a job so it cannot escape tracking.

---

### SUBTASK UIF-012-PG — Photogrammetry Interface

**Type:** PG
**Depends on:** SRI-019, SRI-020, UIF-001
**Build:** Upload photographs and start a 3D reconstruction job from AutoInjector.
**Example:** `3D Scan → Upload 425 photos → BUILD MODEL`
**Done when:** a photo set uploads, validates, and starts a tracked reconstruction job.
**Error handling:** pre-flight validation for count, resolution, and format with a clear rejection list; partial uploads never start a job; estimated disk and VRAM requirements are checked before queueing.

---

### SUBTASK UIF-013-PG — 3D Job Results Viewer

**Type:** PG
**Depends on:** UIF-012, SRI-021
**Build:** Resulting 3D models and associated files available from AutoInjector.
**Example:** `SCAN-014 → MODEL.obj [Download]`
**Done when:** every completed scan exposes its model, textures, and logs as downloadable artifacts.
**Error handling:** a partially completed reconstruction publishes whatever finished plus a `PARTIAL_RESULT` flag and the failure reason — it is not presented as a completed model.

---

### SUBTASK UIF-014-PG — GPU Status Interface

**Type:** PG
**Depends on:** SRI-026
**Build:** Live GPU load, VRAM, temperature, fan info, and current GPU job.
**Example:** `GPU 72°C / VRAM 8.4 GB / SD ACTIVE`
**Done when:** readings refresh on a fixed interval with a visible timestamp.
**Error handling:** if the sensor read fails, display `NO READING` with the age of the last value — never a stale number shown as live, and never a default of 0°C.

---

### SUBTASK UIF-015-PG — Server Status Interface

**Type:** PG
**Depends on:** SRI-025
**Build:** Storage, temperatures, running services, errors, and overall health.
**Example:** `AutoInjector ONLINE / ComfyUI READY / Storage 63%`
**Done when:** every monitored service reports state, uptime, and last error in one panel.
**Error handling:** low-disk and failed-service conditions raise visible warnings at defined thresholds; the panel itself must render even when several probes fail, marking those entries UNKNOWN.

---
---

# TASK 5 — Desktop Server, Integration & Runtime Infrastructure

**Prefix:** SRI
**Difficulty:** Hardest
**Why:** the Windows desktop becomes the permanent AutoInjector/AI workstation and server. AutoInjector stays a program running on Windows — it does not replace Windows. The machine can run with a monitor or mostly headless while the phone and laptop act as remote clients.

**Task 5 is complete when:** the desktop can be powered on, left alone, and driven entirely from the phone or laptop — with jobs surviving disconnects and the GPU shared safely between services.

---

### SUBTASK SRI-001-PG — AutoInjector Desktop Server

**Type:** PG
**Depends on:** TASK 1–4 core
**Build:** Runs the overall system continuously on the Windows desktop as a long-lived service.
**Example:** `AutoInjector Server: ONLINE`
**Done when:** the service runs for 24 hours unattended without manual intervention.
**Error handling:** supervised process with automatic restart, crash-loop detection (stop after N restarts in M minutes and alert), and startup self-check of database, storage, and dependent services before accepting work.

---

### SUBTASK SRI-002-PG — Browser-Based AutoInjector Interface

**Type:** PG
**Depends on:** SRI-001, TASK 4
**Build:** Serves the unified UI as a local web application.
**Example:** desktop server → AutoInjector dashboard
**Done when:** the full UI loads in a browser on the desktop and on another device on the LAN.
**Error handling:** API failures render as inline errors in the affected panel only; the shell must never white-screen. Version mismatch between UI and API forces a reload with an explicit message.

---

### SUBTASK SRI-003-PG — Phone Remote Access

**Type:** PG
**Depends on:** SRI-002, SRI-005, SRI-006
**Build:** Phone connects to the desktop-hosted interface with a layout usable on a small screen.
**Example:** `Phone → Dashboard → PROJECT-004`
**Done when:** start, monitor, approve, and download all work from the phone.
**Error handling:** connection loss shows a clear offline state and queues the pending action for confirmation on reconnect — actions are never fired twice.

---

### SUBTASK SRI-004-PG — Laptop Remote Access

**Type:** PG
**Depends on:** SRI-002, SRI-005, SRI-006
**Build:** Laptop reaches the same server and projects without carrying the workload.
**Example:** `Laptop → AutoInjector server`
**Done when:** the laptop session is fully functional with no local GPU work.
**Error handling:** identical session/auth handling to phone; concurrent sessions are visible and do not clobber each other's edits (last-write-wins is not acceptable — conflicting edits prompt).

---

### SUBTASK SRI-005-PG — Secure VPN Remote Connection

**Type:** PG
**Depends on:** SRI-002
**Build:** Secure remote access without exposing AutoInjector directly to the public Internet.
**Example:** `Phone → VPN → Desktop`
**Done when:** remote access works from outside the home network with no port forwarded to the AutoInjector service itself.
**Error handling:** the service binds only to the trusted interface and refuses connections from unexpected sources; VPN down = no access rather than fallback to open access. Failed auth attempts are rate-limited and logged.

---

### SUBTASK SRI-006-PG — User Authentication & Access Control

**Type:** PG
**Depends on:** MDC-001
**Build:** Authenticated users and devices, with sensitive operations restricted by role.
**Example:** `USER-JAVON → ADMIN`
**Done when:** no state-changing endpoint is reachable unauthenticated.
**Error handling:** default deny on any unrecognized route or role; session expiry re-prompts without losing unsaved input; lockout after repeated failures with the events logged.

---

### SUBTASK SRI-007-PG — ATELIER Integration Layer

**Type:** PG
**Depends on:** MDC-008, SRI-012
**Build:** Connects AutoInjector orchestration to the bookmaking engine and its gates.
**Example:** `TASK-410 → ATELIER CH06 gate`
**Done when:** a gate run is triggered from AutoInjector and its PASS/FAIL result updates project state automatically.
**Error handling:** a gate that errors is recorded as ERROR, distinctly from FAIL — an error never counts as a pass. Gate output and exit codes are stored as evidence (SRI-010).

---

### SUBTASK SRI-008-PG — Multi-Project Isolation

**Type:** PG
**Depends on:** MDC-002, MDC-009
**Build:** Prevents information from one project leaking into another.
**Example:** `PROJECT-004 ≠ PROJECT-005`
**Done when:** every query, context package, and file path is project-scoped, verified by a cross-project leak test.
**Error handling:** a request without a valid project scope is rejected outright; cross-project references require explicit user action and are logged.

---

### SUBTASK SRI-009-PG — Persistent Background Jobs

**Type:** PG
**Depends on:** SRI-001
**Build:** The desktop keeps working after the phone or laptop disconnects.
**Example:** `JOB-500 RUNNING after client disconnects`
**Done when:** a job started from the phone completes with the phone off, and its result is waiting on reconnect.
**Error handling:** jobs are persisted to the database, not held in memory; checkpoints written at defined steps so a service restart resumes rather than restarts from zero.

---

### SUBTASK SRI-010-PG — Execution Evidence Tracking

**Type:** PG
**Depends on:** MDC-002
**Build:** Captures command, output, timestamps, hashes, exit codes, and logs for anything claimed to have been executed.
**Example:** `RUN-0051 exit=0 evidence saved`
**Done when:** every claimed execution has a retrievable evidence record, and claims without one are flagged by LSI-008.
**Error handling:** evidence records are append-only and immutable; if capture fails the run is marked `EVIDENCE_INCOMPLETE` and cannot be used to close a task.

---

### SUBTASK SRI-011-PG — Error / Failure Recovery System

**Type:** PG
**Depends on:** SRI-009
**Build:** Restarts or resumes interrupted jobs without losing project state.
**Example:** `JOB-500 CRASHED → RESUME CHECKPOINT-12`
**Done when:** killing the service mid-job results in correct resumption on restart with no duplicated side effects.
**Error handling:** all resumable operations are idempotent; unrecoverable jobs move to FAILED with a full diagnostic bundle rather than retrying forever.

---

### SUBTASK SRI-012-PG — Central AutoInjector API

**Type:** PG
**Depends on:** SRI-001, SRI-006
**Build:** The single controlled interface connecting UI, models, database, files, ATELIER, and server components.
**Example:** `POST /projects/004/jobs → JOB-501`
**Done when:** every component communicates through this API; no component reaches around it into the database or filesystem.
**Error handling:** structured error responses with stable machine-readable codes; input validation on every endpoint; version header so an outdated client fails loudly rather than behaving oddly.

---

### SUBTASK SRI-013-PG — Service & GPU Manager

**Type:** PG
**Depends on:** SRI-001
**Build:** Coordinates the programs competing for the GTX 1080 Ti / Titan GPU.
**Example:** `Local AI ACTIVE / Stable Diffusion QUEUED`
**Done when:** two GPU services cannot hold conflicting allocations at the same time.
**Error handling:** allocations are leased with timeouts; a crashed service's lease expires and is reclaimed automatically; deadlock detection with forced release plus alert.

---

### SUBTASK SRI-014-PG — GPU Job Queue

**Type:** PG
**Depends on:** SRI-013
**Build:** Prevents Stable Diffusion, local AI, and photogrammetry from exhausting VRAM simultaneously.
**Example:** `JOB-501 LLM → JOB-502 SD → JOB-503 3D`
**Done when:** submitting all three job types at once completes all three without an out-of-memory failure.
**Error handling:** each job declares an estimated VRAM need and is admitted only if it fits; OOM despite admission requeues the job once with a reduced profile, then fails with a clear reason.

---

### SUBTASK SRI-015-PG — GPU Resource Scheduling

**Type:** PG
**Depends on:** SRI-014
**Build:** Gives GPU resources to the right service and releases them when finished.
**Example:** LLM releases VRAM → SD job starts
**Done when:** VRAM is measurably released between jobs and the next job starts automatically.
**Error handling:** if memory is not released within a timeout, the service is restarted to reclaim it; priority rules prevent long image or 3D jobs from starving the supervisor model indefinitely.

---

### SUBTASK SRI-016-PG — Local AI Runtime Service

**Type:** PG
**Depends on:** SRI-013
**Build:** Keeps the local supervisor model available to AutoInjector as a separate local service.
**Example:** `AutoInjector → Local LLM → classification returned`
**Done when:** the supervisor answers requests within the latency target while other GPU services are running.
**Error handling:** health-checked and auto-restarted; model-load failure is reported distinctly from an inference failure; while unavailable, the system runs PG-only (see LSI-001) rather than stalling.

---

### SUBTASK SRI-017-PG — Stable Diffusion Service

**Type:** PG
**Depends on:** SRI-013
**Build:** Runs Stable Diffusion / ComfyUI as its own service, exposed to AutoInjector over its API.
**Example:** `AutoInjector → ComfyUI API → ART-205.png`
**Done when:** AutoInjector can query status, submit work, and retrieve output without the ComfyUI window being touched.
**Error handling:** startup verifies model files and API reachability; missing checkpoints, LoRAs, or nodes are reported by name; API timeouts do not leave orphaned jobs — the queue reconciles on reconnect.

---

### SUBTASK SRI-018-PG — Stable Diffusion Job Automation

**Type:** PG
**Depends on:** SRI-017, SRI-014
**Build:** Lets an AI or workflow request an image without anyone operating Stable Diffusion manually.
**Example:** `JOB-600 GENERATE_IMAGE → SD → image returned`
**Done when:** a message-triggered image request completes end to end and lands in project artifacts.
**Error handling:** prompts and parameters are validated before submission; every generation stores its full parameter set for reproducibility; failed jobs are requeueable with one click.

---

### SUBTASK SRI-019-PG — Photogrammetry / 3D Reconstruction Service

**Type:** PG
**Depends on:** SRI-013
**Build:** Runs photogrammetry and related 3D processing on the same desktop as a managed service.
**Example:** 425 photographs → reconstruction job
**Done when:** a reconstruction runs to completion under AutoInjector's control.
**Error handling:** pre-run disk-space and VRAM checks; long runs write progress checkpoints; a crash mid-reconstruction preserves intermediate output and the exact failure stage.

---

### SUBTASK SRI-020-PG — Photogrammetry Job Automation

**Type:** PG
**Depends on:** SRI-019, SRI-014
**Build:** AutoInjector submits, monitors, and retrieves 3D reconstruction jobs.
**Example:** `SCAN-014 PROCESSING 68%`
**Done when:** progress is reported to the UI and finished assets are registered as artifacts automatically.
**Error handling:** stalled progress (no change past a threshold) raises a warning rather than hanging silently; retrieval verifies expected output files exist before marking COMPLETE.

---

### SUBTASK SRI-021-PG — Shared AI Artifact Storage

**Type:** PG
**Depends on:** MDC-009
**Build:** Central storage for generated images, 3D models, documents, logs, and other outputs.
**Example:** `PROJECT-004/Artifacts/`
**Done when:** every service writes outputs through this layer with consistent naming and project scoping.
**Error handling:** disk-space check before write; failed writes do not register a database artifact row (no phantom artifacts); orphan sweeps reconcile disk and database on a schedule and report mismatches.

---

### SUBTASK SRI-022-PG — Automatic Windows Startup

**Type:** PG
**Depends on:** SRI-001
**Build:** Required services start automatically when Windows boots.
**Example:** `POWER ON → Windows → AutoInjector ONLINE`
**Done when:** a cold boot reaches full ONLINE state with no login-time manual steps.
**Error handling:** ordered startup with dependency waits and retries; a service that fails to start is retried on a schedule and reported in the health panel instead of leaving a half-running system.

---

### SUBTASK SRI-023-PG — Headless Operation Mode

**Type:** PG
**Depends on:** SRI-022, SRI-003, SRI-004
**Build:** The machine runs without a permanently attached monitor, keyboard, or mouse.
**Example:** server running → controlled from phone
**Done when:** the desktop runs a full workday disconnected from peripherals with no loss of function.
**Error handling:** anything that would normally require a desktop dialog is surfaced through the web UI instead; any component that blocks on a GUI prompt is identified and either replaced or explicitly flagged as requiring SRI-024.

---

### SUBTASK SRI-024-PG — Windows Remote Administration

**Type:** PG
**Depends on:** SRI-005
**Build:** Access to the actual Windows desktop for maintenance and manual configuration.
**Example:** `Laptop → remote Windows session`
**Done when:** a remote desktop session can be established over the secure channel and used to configure the machine.
**Error handling:** remote administration is available only over VPN, never publicly exposed; sessions are logged; loss of the remote session must not terminate running AutoInjector jobs.

---

### SUBTASK SRI-025-PG — Service Health Monitoring

**Type:** PG
**Depends on:** SRI-001
**Build:** Detects when AutoInjector, the local AI, Stable Diffusion, photogrammetry, or another required service stops responding.
**Example:** `ComfyUI OFFLINE → restart/recovery`
**Done when:** an intentionally killed service is detected and reported within the configured interval.
**Error handling:** graduated response — probe, restart, escalate, alert. Restart attempts are capped to avoid loops; unhealthy services are removed from the job queue's eligible targets until they recover.

---

### SUBTASK SRI-026-PG — GPU Thermal Monitoring

**Type:** PG
**Depends on:** SRI-013
**Build:** Continuously records GPU temperature and related operating data during sustained AI workloads.
**Example:** `GPU 73°C → NORMAL`
**Done when:** temperature history is recorded and queryable over a sustained multi-hour load.
**Error handling:** a failed sensor read records NULL, never a fabricated value; repeated read failures raise an alert because unmonitored thermals must not be treated as safe.

---

### SUBTASK SRI-027-PG — Thermal Safety Actions

**Type:** PG
**Depends on:** SRI-026, SRI-014
**Build:** Pauses or queues GPU work when configured temperature limits are exceeded.
**Example:** `GPU > limit → PAUSE JOB-503`
**Done when:** a simulated over-limit reading pauses GPU work and resumes it after the configured cooldown.
**Error handling:** fail-safe direction — if temperature data is unavailable, throttle to conservative limits rather than assuming everything is fine. Pauses checkpoint the job; every thermal action is logged with the readings that caused it.

---

### SUBTASK SRI-028-PG — GPU Fan / Cooling Integration

**Type:** PG
**Depends on:** SRI-026
**Build:** Exposes supported GPU/case cooling information to the monitoring system where software control is available.
**Example:** `GPU load HIGH → cooling profile HIGH`
**Done when:** available fan data is displayed and any supported profile change takes effect.
**Error handling:** unsupported hardware degrades to read-only monitoring with a clear "control unavailable" note; the system never claims to have applied a cooling change it could not verify, and SRI-027 remains the safety backstop.

---
---

# Reference — Lifecycle walkthroughs

These are acceptance scenarios. Each one is an end-to-end test that spans multiple tasks.

## Lifecycle A — One complete message

`USER: "Have Claude draft Chapter 7."`
→ AutoInjector creates `MSG-000501 FROM: USER TO: CLAUDE PROJECT: PROJECT-004`
→ Database checks: Claude read through `MSG-000497`
→ AutoInjector synchronizes: `MSG-000498–000500`
→ Context builder creates `CTX-0501` — CH07 card, relevant characters, timeline, open threads, last scene seam
→ Local Supervisor checks: `RECIPIENT: CLAUDE / DUPLICATE: NO / STALE: NO / CONFLICT: NO / RESPONSE_REQUIRED: YES`
→ Claude receives `MSG-000501 + CTX-0501`
→ Claude responds
→ AutoInjector assigns `MSG-000502`
→ Artifact created: `ART-0204 / CH07.md`
→ ATELIER runs gates → **PASS**
→ Project database updates
→ UI displays: `CHAPTER 7 COMPLETE ✓`

**Covers:** SCS-001–007, SCS-012, MDC-005, MDC-006, MDC-008, LSI-001, SRI-007, UIF-004, UIF-005.

## Lifecycle B — One Stable Diffusion job

`USER: "Create an image of the Chapter 7 lighthouse."`
→ AutoInjector creates `MSG-000650` / `JOB-000650`
→ Local AI determines `TYPE: IMAGE_GENERATION / SERVICE: STABLE_DIFFUSION`
→ Service & GPU Manager checks: `LOCAL AI ACTIVE / SD READY / PHOTOGRAMMETRY IDLE / VRAM AVAILABLE`
→ GPU Job Queue: `JOB-000650 → STABLE DIFFUSION`
→ Workflow sent to ComfyUI / Stable Diffusion
→ GPU generates image → `ART-0301.png`
→ Artifact stored in project
→ UI displays: `IMAGE COMPLETE ✓ [VIEW] [DOWNLOAD]`

**Covers:** LSI-002, SRI-013–015, SRI-017, SRI-018, SRI-021, UIF-010, UIF-002.

## Lifecycle C — One photogrammetry job

`USER uploads 425 photographs`
→ AutoInjector creates `SCAN-0014` in `PROJECT-004` → files stored
→ Photogrammetry job created: `JOB-000701`
→ GPU Manager checks current workload → job queued
→ Photogrammetry service processes photographs
→ AutoInjector monitors: 25% → 50% → 75% → 100%
→ Generated: `MODEL.obj`, texture files, project files → artifacts stored
→ Phone/laptop dashboard displays: `3D MODEL COMPLETE ✓ [VIEW] [DOWNLOAD]`

**Covers:** UIF-001, UIF-012, UIF-013, SRI-014, SRI-019–021, SRI-003, SRI-004, SRI-009.

---

# Subtask count

| Task | Prefix | Subtasks |
|---|---|---|
| TASK 1 | SCS | 13 |
| TASK 2 | MDC | 9 |
| TASK 3 | LSI | 9 (+ authority-split enforcement) |
| TASK 4 | UIF | 15 |
| TASK 5 | SRI | 28 |
| **Total** | | **74** |

---

*Every ID from the original upgrade list is preserved exactly, with its original name, purpose, and example. Dependencies, completion tests, and error handling were added so each subtask can be built and closed on its own.*
