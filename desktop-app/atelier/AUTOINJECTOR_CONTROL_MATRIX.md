# AUTOINJECTOR — CONTROL MATRIX

Reconciled mechanically from the registers: **14 process defects (PDF-001…014,
contiguous)**, **8 project issues (ISS-001…007 + ISS-002b)**.

**AutoInjector is NOT production-ready.** See BLOCKS at the end.

**PORTABLE NOW means a locally proven mechanism** — executed regression coverage
and a red-state proof on the Custodian's machine. It does **not** mean
cross-machine proven, independently audited, or AutoInjector-production proven.
Cross-machine verification is NOT ESTABLISHED for every control without
exception.

Format: CONTROL | SOURCE DEFECT/EVIDENCE | CURRENT IMPLEMENTATION | ENFORCEMENT POINT | REQUIRED DATA | FAILURE BEHAVIOR | REGRESSION TEST | PORTABILITY

---

### 1 · Project identity and namespace isolation
No defect — **a gap found by asking what breaks with two projects** | none | job/ledger/branch/quarantine key | `project_id` on every artifact | cross-project read rejected | none | **NOT BUILT**
→ artifact needed: `identity.py` + `project_id` field in every record writer

### 2 · Branch / base-commit / spec-version identity
F-08 | `transaction.py` records `branch`, `base_commit` | BRANCH | `branch`, `base_commit`, `spec_version` | S0 if absent at commit | `test_transaction.py` 18/18 | **ADAPT** (no `spec_version`)

### 3 · Role-based write authority
**ISS-002** — §3.3 forbade the write; nothing blocked it | none | artifact write boundary | `authored_by` + role→path policy | reject write, quarantine, log | none | **NOT BUILT**
→ artifact needed: `authority.py` write-gate wrapping every file writer

### 4 · Artifact provenance
**PDF-006** ×5 false work claims | prose handoff blocks only | every artifact write | `authored_by`, `authored_at`, `job_id`, `base_version` | artifact without provenance rejected | none | **NOT BUILT**
→ artifact needed: provenance header schema + validator

### 5 · Cross-model contamination rejection / quarantine
**ISS-002**, ISS-002b | `99_ARCHIVE/auditor-submissions/` + rule; containment proven empirically | write boundary | role of writer | divert to quarantine, never assembly | manual empirical test | **ADAPT** (directory exists; **nothing rejects a write**)

### 6 · Stale-instruction detection
~15 relay rounds correcting text that no longer existed | specified §4.13, **no code** | instruction intake | current artifact hash vs referenced state | stale portions produce no mutation | none | **NOT BUILT**
→ artifact needed: `check_instruction.py` diffing instruction against current state

### 7 · Stale-job / base-version detection
F-07 | `transaction.py check`, runs inside `commit` | commit/merge boundary | job inputs vs current versions | PROCESS_VIOLATION; S0 if stale reaches COMMITTED | `test_transaction.py` t7f–t7i | **PORTABLE NOW**

### 8 · Execution-claim evidence capture
**PDF-006** | `CANDIDATE_GATE_EVIDENCE.txt` pattern | any accepted result claim | captured stdout/stderr + timestamp + command | uncaptured claim = hypothesis, not evidence | practice, not code | **ADAPT** (formalize as a capture wrapper)

### 9 · Four-state evidence accounting
**PDF-010** — local ≠ portable | register model | status reporting | local / cross-machine / auditor-execution / analytical | states never collapsed to "verified" | none | **PORTABLE NOW** (accounting model)

### 10 · Transaction atomicity
F-07/F-08 | `transaction.py` — fsync + atomic rename | BRANCH→COMMIT | durable record | invalid transition = S0 | `test_transaction.py` 18/18 | **PORTABLE NOW**

### 11 · Crash / interruption recovery
**F-08**, **PDF-010** | startup detection, quarantine-before-destroy, bounded subprocesses | startup | `open_transaction`, `base_commit` | RECOVERY_REQUIRED, non-mergeable | SIGKILL ×4 stages; git-hang matrix | **PORTABLE NOW**

### 12 · Authoritative merge-route enforcement
F-07 | guard runs inside `transaction.py commit` | commit | `--inputs` required | S0 if omitted | t7h, t7i | **ADAPT** — unavoidable *in this entry point only*; another route bypasses it

### 13 · Transaction-specific merge provenance
F-08 | `git merge-base --is-ancestor` | commit | `--merge-ref` | S0 without repository proof | t8g, t8h | **ADAPT** — ancestry proves reachability, **not that this transaction caused the merge**

### 14 · Propagation enforcement
**PDF-012** — 3 chapters against a chapter-zero state | `check_propagation.py` | chapter gate | per-artifact current-chapter marker | S1 per stale artifact | `test_propagation.py` 4/4 | **PORTABLE NOW**

### 15 · Structured candidate / fact extraction
**ISS-003, ISS-004, ISS-006** | `check_candidates.py` | gate | `id`,`entity`,`property`,`value`,`status` | S1 missing extraction; S2 prose storage | `test_candidates.py` **23/23** (frozen candidate-gate total; see `CANDIDATE_GATE_FREEZE.json`) | **PORTABLE NOW**

### 16 · Structural record-boundary parsing
**PDF-014** — fixed window let a malformed record inherit its neighbour's fields | fixed in `check_candidates.py` | parser | record ends at next `- id:` | malformed reported at own line | t5b | **PORTABLE NOW**

### 17 · Load-bearing value units / precision / provenance
the 40.0 m climax figure was in **none** of six artifacts | `check_candidates.py` | gate | `classification`, `units`, `precision`, `provenance`, `source_chapter` | S1 per missing field | per-field mutation fixture t12 | **PORTABLE NOW**

### 18 · affects propagation verification
same | `check_candidates.py` | gate | `affects[]` | S1 if target lacks the value | t9 | **PORTABLE NOW**

### 19 · Boundary / metadata-leakage enforcement
none — prevented all leakage across 12 chapters | `assemble_manuscript.py` | assembly | marker position only | S0, zero output from offending file, all modes | `test_assembler.py` 16/16 | **PORTABLE NOW**

### 20 · Duplicate-delivery quarantine
§4.10.3 | immutable `job_id` records only | delivery intake | `job_id` seen-set | quarantine on redelivery | none | **NOT BUILT**
→ artifact needed: redelivery guard in the job intake path

### 21 · Quarantine exclusion from authoritative assembly
ISS-002 | `_`-prefix and path exclusion in `collect_files` | assembly | path policy | excluded silently by position | `t_scaffold`, empirical plant test | **PORTABLE NOW**

### 22 · Decision P1/P2/P3 enforcement
**PDF-001** — P3 auto-adopted on silence | `check_jobs.py` | decision log gate | class, ruling, status | P3 cannot auto-adopt | `test_provisional_classifier.py` 6/6 | **ADAPT** (classes are ATELIER semantics)

### 23 · Strict build / gate behavior
PDF-008, PDF-011 | `--strict` in assembler | build | marker structure | S0 zero output; empty = STOP not FATAL | `t13`, `t13b`, `t14b`, `t_e2e_scaffold` | **PORTABLE NOW**

### 24 · End-to-end execution harness
**PDF-008/009/010/011** — all seam defects | ad-hoc scripts only | CI | scaffold→build, extract→run, cross-machine | any stage red blocks | partially in suites | **ADAPT** → needs a single runner

### 25 · Cross-machine verification
**PDF-010** | none — **cannot be self-certified** | release gate | second machine | portability NOT ESTABLISHED until run elsewhere | none | **NOT BUILT**
→ artifact needed: CI job on a distinct runner + `EXPECTED_RESULTS.txt` comparison

### 26 · Independent-audit evidence separation
PDF-006, ISS-007 | register discipline | status reporting | who executed, what was captured | auditor claims without capture = hypotheses | none | **PORTABLE NOW** (model)

### 27 · `--ref` repository-scoped evaluation
**IMPL-GAP-001** — `check_manuscript.py` accepts `--ref` and ignores it | decorative only | every validator | ref + `git show <ref>:<path>` | S0 on mismatch | none | **NOT BUILT**
→ artifact needed: shared `refscope.py`; remove the flag until real

### 28 · Dependency graph (§4.12)
F-02 | none | propagation | node/edge derivation | fail on unresolved dependency | none | **NOT BUILT**
→ artifact needed: `build_depgraph.py` — derives the artifact dependency graph and emits the `affects` closure that controls 14 and 18 currently take on trust

### 29 · Timeline validation (§17)
run needed it at chapter 1; done by hand throughout | none | chapter gate | dates, durations, travel windows | S1 on impossible interval | none | **NOT BUILT**
→ artifact needed: `validate_timeline.py` — six §17 checks: monotonicity, elapsed-time arithmetic, travel feasibility, tide/window constraints, age/date consistency, event ordering

### 30 · Knowledge Matrix enforcement (§18.4)
none observed; managed manually | none | scene gate | who knows what, when | S1 on acting-on-unknown | none | **NOT BUILT**
→ artifact needed: `check_knowledge.py` — per-character knows/believes-incorrectly ledger with acquisition chapter; S1 when a character acts on a fact they have not yet learned

### 31 · Register staleness / orphan validation (§20/21)
threads tracked by hand | none | chapter gate | last-advanced, target chapter | S2 on stale major thread | none | **NOT BUILT**
→ artifact needed: `check_registers.py` — S2 when a major thread is unadvanced for 5 chapters, S1 when a setup passes its payoff target unpaid, S1 on any orphaned thread at final assembly

### 32 · Context-package builder (§24)
F-05 | metric invariant only (`components.py`); **`build_context.py` DOES NOT EXIST — supporting invariant logic is not the control** | job dispatch | facts available/included/omitted | validation fails if inconsistent | components tests | **ADAPT** → `build_context.py` does not exist

---

## SAFE TO INTEGRATE NOW
Controls **7, 9, 10, 11, 14, 15, 16, 17, 18, 19, 21, 23, 26** — thirteen.
Each has executed regression coverage and a red-state proof.

## MUST ADAPT BEFORE INTEGRATION
Controls **2, 5, 8, 12, 13, 22, 24, 32** — eight.
Mechanism exists; scope, vocabulary or coverage is ATELIER-shaped, or the
control is unavoidable only within a single entry point.

## BLOCKS PRODUCTION-READY STATUS
1. **Cross-machine verification NOT ESTABLISHED** — every result is from one machine
2. **Round 3: 0 of 6 targets** — ten auditor transport failures
3. **F-06** — audit closure outstanding
4. **F-07** — merge-route exclusivity unproven (another route bypasses the guard)
5. **F-08** — transaction-specific merge provenance unproven
6. **Eleven NOT BUILT controls** — 1, 3, 4, 6, 20, 25, 27, 28, 29, 30, 31
7. **§36 surfaces 1–11, 18, 21, 22 unproven**
8. **All 12 novella chapters PENDING_AUDIT**; 106 candidates unpromoted
9. **CH09–CH12 prospective gate enforcement NOT ESTABLISHED** — they satisfy the
   controls in the verified final state, but were drafted before the expanded
   candidate gate existed

**AutoInjector must not be described as production-ready while any of these stand.**
