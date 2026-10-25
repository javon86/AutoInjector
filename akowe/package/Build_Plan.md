# Bookforge build plan
Revision BF-IRB-1.0.0

## Entry point
Start with README.md, Specifications/Shared_Contract.md and Contracts/operation_registry.json. Run python3 verify_contracts.py before coding. The 11 module PDFs/Markdown files are independently reviewable; use the same shared wire contract in every module. History is source evidence only.

## 1. Application shell and trusted kernel
Implement persistent project/branch identity, authorization, immutable Record/Reference, deterministic JSON-schema validator, CAS/idempotency/audit/outbox transaction and asset staging. Load I02/I03 files before queues. Support kernel-level validation without an I04 job. Choose database/framework based on deployment; preserve shared transaction semantics. Exit: schema package loads offline; first record create/update/read, permission denial and duplicate receipt tests pass against actual storage.

## 2. I infrastructure and K execution foundation
Implement I01-I15, then K01-K12 against stub domain adapters. Record completion from commit receipts, queue leases/generations, hard SCCs, feature manifest, resource reservation and exactly three AI slots plus code/tools. Supply backup/restore and migration rehearsal. Exit: crash-before/after-commit, lease expiry, pause/restart/resume, duplicate outbox, quota race and protected-context budget cases pass. Domain calls can be manual/stubbed here; mocks cannot grant production approval.

## 3. A universe and B planning
Build independently callable A operations with draft shells/resolved approval links, then B staged planning. Preserve all original IDs and separate workspaces. Exit: empty-project bootstraps, reciprocal references, optional mystery/foreshadowing and initial ending without prose work; protected canon checks reject invalid changes.

## 4. C writing and E accepted state
Build C context/prose/style and C-owned manuscript acceptance; E baseline, typed event validation, snapshots, supersession/replay and conflict reports. Configure provider adapter or manual candidate input. Exit: first/last chapter boundaries, nonmagical action, candidate vs accepted events, chronology and rewrite replay pass. Unrelated source hashes remain unchanged.

## 5. J reconciliation and F editing
Implement J findings/classification/minimal-impact plans/owner commit/revalidation; F reviews and anchored patch proposals through C. Exit: branch/time nonconflicts, stale/overlapping edits, protected approval expiry, interrupted multi-owner prepare and selective invalidation pass. Final polish renews downstream evidence.

## 6. D assets and deterministic maps
D may be developed after A in parallel with later prose work, but is integrated here. Build correctly identified art operations, rights/protected appearance checks, provider checkpoint/status, map graph/text/sidecar validators. Exit: empty scene, no weapon/creature feature, exact labels/geometry, ownership and ambiguous paid retries pass. Text-only projects remain usable without connected art provider.

## 7. G output profiles
Implement ordering, compilation, typography, pagination/TOC convergence, optional assets/matter, final cover geometry and exact-byte PDF/EPUB/DOCX export. Exit: selected formats open/read correctly; provenance binds exact bytes; no art/cover/print-spine requirement leaks into manuscript PDF/EPUB. Run real EPUBCheck where EPUB is selected.

## 8. H evidence and book release
Implement full coverage semantic review and deterministic file/layout/reference checks, applicability and H10 frozen-manifest aggregation. Exit: actual PASS/FAIL/UNKNOWN/NOT_APPLICABLE evidence correctly gates book release; changed bytes/source invalidate affected reports; no stale report permits release. User/release owner approves the exact candidate under policy.

## Acceptance execution and implementation artifacts
For every operation implement its delivered CREATE/UPDATE/READ/VALIDATE/ACCEPT semantics. Convert FUTURE_RUNTIME_TEST cases to runnable integration tests, retaining IDs and actual results. Each test records setup input, action, expected result, observed result, affected stored revisions, source/artifact hashes, command/tool version and reviewer. Add provider capability and privacy tests when configuring a real adapter. Replace fixtures with real provider output only in integration tests; do not treat fixtures as canon approval.

Use a dependency-aware implementation board with operation IDs and prerequisite milestones. Estimates follow the chosen stack/providers/team; this blueprint does not invent a fixed cost/date. No database migration SQL is promised before a storage engine is selected. Migration behavior and restore-only downgrade are already specified; implementation must provide the engine-specific migration and rehearse it before release.

The first usable vertical slice is I/K kernel -> A01 -> B01/B03/B11 -> C01/C02 -> E01/E02 -> F01/F11 -> G02/G01/G11 -> H05/H09/H10, with other selected checks honored before publication. Remaining 142-operation scope is completed by the milestones above; the slice does not count as full product completion.

## Closure implementation exits
Load predicate_registry, artifact_registry and typed auxiliary schemas with the kernel. Seed/import user-approved profiles before consumers, then create G02 manifest, compile G01 and apply G05/G04. Implement C event extraction as a separate resumable bundle. Implement E facts projection with optional replay checkpoint. Run verify_closure.py alongside structural verifiers before coding; execute closure_runtime.cases.json against the built application before release. A profile import or structural compatibility fixture cannot satisfy an actual production approval.
