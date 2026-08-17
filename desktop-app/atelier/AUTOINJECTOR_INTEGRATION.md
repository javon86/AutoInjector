# AUTOINJECTOR — INTEGRATION SPECIFICATION

Derived from the ATELIER production run (12-chapter novella, 11,832 words,
14 process defects, 6 project issues). Every control below is traced to a
failure that actually occurred in this repository.

**This package is NOT production-ready.** Section 4 lists unresolved
limitations. Nothing here has been executed on a machine other than the
Custodian's.

Frozen manuscript: sha256 `c52f0508da12ae5e…` · 62,672 bytes · 11,832 words

---

## ORDERED CONTROL MAPPING — C-01 … C-32

One row per requested control. **Several rows point to the same underlying
artifact**; that is expected and is not consolidation. Status is carried
through unchanged — mapping never upgrades NOT BUILT to implemented.

| ID | CONTROL | STATUS | IMPLEMENTATION ARTIFACT | SHARES MECHANISM WITH |
|---|---|---|---|---|
| C-01 | Project identity and namespace isolation | **NOT BUILT** | `identity.py` + `project_id` field in every record writer | — |
| C-02 | Branch / base-commit / spec-version identity | **ADAPT FOR AUTOINJECTOR** | `transaction.py` | C-10 |
| C-03 | Role-based write authority | **NOT BUILT** | `authority.py` write-gate wrapping every file writer | — |
| C-04 | Artifact provenance | **NOT BUILT** | provenance header schema + validator | — |
| C-05 | Cross-model contamination rejection / quarantine | **ADAPT FOR AUTOINJECTOR** | practice / register discipline | — |
| C-06 | Stale-instruction detection | **NOT BUILT** | `check_instruction.py` diffing instruction against current state | — |
| C-07 | Stale-job / base-version detection | **PORTABLE NOW** | `transaction.py check` | — |
| C-08 | Execution-claim evidence capture | **ADAPT FOR AUTOINJECTOR** | practice / register discipline | — |
| C-09 | Four-state evidence accounting | **PORTABLE NOW** | practice / register discipline | — |
| C-10 | Transaction atomicity | **PORTABLE NOW** | `transaction.py` | C-02 |
| C-11 | Crash / interruption recovery | **PORTABLE NOW** | practice / register discipline | — |
| C-12 | Authoritative merge-route enforcement | **ADAPT FOR AUTOINJECTOR** | `transaction.py commit` | — |
| C-13 | Transaction-specific merge provenance | **ADAPT FOR AUTOINJECTOR** | practice / register discipline | — |
| C-14 | Propagation enforcement | **PORTABLE NOW** | `check_propagation.py` | — |
| C-15 | Structured candidate / fact extraction | **PORTABLE NOW** | `check_candidates.py` | C-16, C-17, C-18 |
| C-16 | Structural record-boundary parsing | **PORTABLE NOW** | `check_candidates.py` | C-15, C-17, C-18 |
| C-17 | Load-bearing value units / precision / provenance | **PORTABLE NOW** | `check_candidates.py` | C-15, C-16, C-18 |
| C-18 | affects propagation verification | **PORTABLE NOW** | `check_candidates.py` | C-15, C-16, C-17 |
| C-19 | Boundary / metadata-leakage enforcement | **PORTABLE NOW** | `assemble_manuscript.py` | — |
| C-20 | Duplicate-delivery quarantine | **NOT BUILT** | redelivery guard in the job intake path | — |
| C-21 | Quarantine exclusion from authoritative assembly | **PORTABLE NOW** | practice / register discipline | — |
| C-22 | Decision P1/P2/P3 enforcement | **ADAPT FOR AUTOINJECTOR** | `check_jobs.py` | — |
| C-23 | Strict build / gate behavior | **PORTABLE NOW** | practice / register discipline | — |
| C-24 | End-to-end execution harness | **ADAPT FOR AUTOINJECTOR** | practice / register discipline | — |
| C-25 | Cross-machine verification | **NOT BUILT** | CI job on a distinct runner + `EXPECTED_RESULTS.txt` comparison | — |
| C-26 | Independent-audit evidence separation | **PORTABLE NOW** | practice / register discipline | — |
| C-27 | `--ref` repository-scoped evaluation | **NOT BUILT** | shared `refscope.py`; remove the flag until real | — |
| C-28 | Dependency graph (§4.12) | **NOT BUILT** | `build_depgraph.py` — derives the artifact dependency graph and emits the `affects` closure that controls 14 and 18 currently take on trust | — |
| C-29 | Timeline validation (§17) | **NOT BUILT** | `validate_timeline.py` — six §17 checks: monotonicity, elapsed-time arithmetic, travel feasibility, tide/window constraints, age/date consistency, event ordering | — |
| C-30 | Knowledge Matrix enforcement (§18.4) | **NOT BUILT** | `check_knowledge.py` — per-character knows/believes-incorrectly ledger with acquisition chapter; S1 when a character acts on a fact they have not yet learned | — |
| C-31 | Register staleness / orphan validation (§20/21) | **NOT BUILT** | `check_registers.py` — S2 when a major thread is unadvanced for 5 chapters, S1 when a setup passes its payoff target unpaid, S1 on any orphaned thread at final assembly | — |
| C-32 | Context-package builder (§24) | **ADAPT FOR AUTOINJECTOR** | `components.py` | — |

### Shared-mechanism groups

- **`check_candidates.py`** → C-15, C-16, C-17, C-18 (4 requested controls, one component)
- **`transaction.py`** → C-02, C-10 (2 requested controls, one component)

Each remains a separate control because each fails differently and
requires its own regression evidence. Sharing an implementation file is not
sharing a failure mode.

