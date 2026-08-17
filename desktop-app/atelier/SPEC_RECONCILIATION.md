# INTEGRATION SPECIFICATION — RECONCILIATION

```
FROZEN MANUSCRIPT MUTATION : NONE
FROZEN HASH                : c52f0508da12ae5ee878ea59a9d75c773e6b6cc72983625962beee49d39391c1
FREEZE INTEGRITY           : PRESERVED   (12/12 scene hashes unchanged)
```

This is a **reporting/schema discrepancy** between the requested 32-control
schema and the structure of `AUTOINJECTOR_INTEGRATION.md`. It is **not** evidence
that the frozen artifact is wrong.

## Root cause of the 8 / 7 / 10 = 25 figure

Two documents exist and were conflated:

| Document | Structure | Counts |
|---|---|---|
| `AUTOINJECTOR_INTEGRATION.md` | **12 thematic requirements** (C-01…C-08 portable + Atelier-specific table + not-built table) | 8 / 7 / 10 = 25 *entries*, not controls |
| `AUTOINJECTOR_CONTROL_MATRIX.md` | **32 controls**, one per requested item | 13 / 8 / 11 = 32 |

`INTEGRATION.md` grouped several requested controls under one heading — e.g. its
single "candidate integrity" requirement covers four requested controls. The 25
was a count of *its* rows, never a claim that seven controls were absent.

**No control is genuinely absent.** All 32 map to an entry.

## Mapping — requested control → specification entry

Separate = own row in `CONTROL_MATRIX.md`. Combined = grouped in `INTEGRATION.md`
under the named requirement. Status is carried through unchanged.

| Requested control | Matrix ID | In INTEGRATION.md | Separate / Combined | Implementation artifact | Status |
|---|---|---|---|---|---|
| Project identity | C-01 | §3 row 1 | **combined** with namespace isolation | `identity.py` | NOT BUILT |
| Namespace isolation | C-01 | §3 row 2 | **combined** with project identity | `identity.py` | NOT BUILT |
| Branch/base/spec identity | C-02 | §1 C-06 | separate | `transaction.py` | ADAPT |
| Write authority | C-03 | §3 row 3 | separate | `authority.py` | NOT BUILT |
| Provenance | C-04 | §3 row 4 | separate | provenance schema + validator | NOT BUILT |
| Contamination quarantine | C-05 | §3 row 6 | **combined** with C-21 exclusion | `99_ARCHIVE/` + path exclusion | ADAPT |
| Stale instruction | C-06 | §3 row 5 | separate | `check_instruction.py` | NOT BUILT |
| Stale job | C-07 | §1 C-06 | **combined** under transactions | `transaction.py check()` | PORTABLE NOW |
| Execution evidence | C-08 | §1 C-07 | separate | capture pattern (practice) | ADAPT |
| Four-state evidence | C-09 | §1 C-08 | separate | accounting model (practice) | PORTABLE NOW |
| Atomic transaction | C-10 | §1 C-06 | **combined** under transactions | `transaction.py` | PORTABLE NOW |
| Crash recovery | C-11 | §1 C-06 | **combined** under transactions | `transaction.py` startup detection | PORTABLE NOW |
| Merge-route enforcement | C-12 | §4 limitation 2 | **combined** — appeared only as a limitation | `transaction.py commit` | ADAPT |
| Transaction provenance | C-13 | §4 limitation 3 | **combined** — appeared only as a limitation | `merge_is_real()` | ADAPT |
| Propagation | C-14 | §1 C-02 | separate | `check_propagation.py` | PORTABLE NOW |
| Candidate extraction | C-15 | §1 C-03 | **combined** — one requirement, four controls | `check_candidates.py` | PORTABLE NOW |
| Record-boundary parsing | C-16 | §1 C-05 | separate | `check_candidates.py` | PORTABLE NOW |
| Load-bearing metadata | C-17 | §1 C-04 | separate | `check_candidates.py` | PORTABLE NOW |
| affects verification | C-18 | §1 C-04 | **combined** with load-bearing | `check_candidates.py` | PORTABLE NOW |
| Manuscript boundary | C-19 | §1 C-01 | separate | `assemble_manuscript.py` | PORTABLE NOW |
| Duplicate-delivery quarantine | C-20 | §3 row 10 | separate | redelivery guard | NOT BUILT |
| Quarantine exclusion | C-21 | §3 row 6 | **combined** with C-05 | `collect_files()` `_`-prefix | PORTABLE NOW |
| P1/P2/P3 | C-22 | §2 row 6 | separate | `check_jobs.py` | ADAPT |
| Strict gate | C-23 | §1 C-01 | **combined** with boundary rule | `--strict` | PORTABLE NOW |
| E2E harness | C-24 | §5 | **combined** — appeared only in the closing pattern | needs one runner | ADAPT |
| Cross-machine verification | C-25 | §4 limitation 1 | **combined** — appeared only as a limitation | CI on a distinct runner | NOT BUILT |
| Independent-audit separation | C-26 | §1 C-08 | **combined** with four-state | accounting model (practice) | PORTABLE NOW |
| `--ref` scoped evaluation | C-27 | §3 row 7 | separate | `refscope.py` | NOT BUILT |
| Dependency graph | C-28 | §3 row 9 | **combined** in "§4.12/§17/§18.4/§20/21" row | `build_depgraph.py` | NOT BUILT |
| Timeline validation | C-29 | §3 row 9 | **combined** in the same row | `validate_timeline.py` | NOT BUILT |
| Knowledge Matrix | C-30 | §3 row 9 | **combined** in the same row | `check_knowledge.py` | NOT BUILT |
| Register staleness/orphans | C-31 | §3 row 9 | **combined** in the same row | `check_registers.py` | NOT BUILT |
| Context-package builder | C-32 | §3 row 8 | separate | `components.py` (producer absent) | ADAPT |

## Findings

- **Requested controls: 32. Mapped rows: 33. Genuinely absent: 0.**
  (33 rows for 32 controls: project identity and namespace isolation are listed
  as two requested controls both mapping to C-01.)
- **Represented separately in `INTEGRATION.md`: 14.**
- **Combined under a shared requirement: 19.** The largest collapses were
  §3 row 9 (four controls: C-28…C-31) and §1 C-03/C-04 (four candidate controls).
- **Four controls appeared only as *limitations*, never as controls** — C-12,
  C-13, C-24, C-25. That is the reporting defect: a limitation is a statement
  about a control, not a substitute for listing it.
- **No status changed.** Mapping is not implementation. Row counts by status:
  **NOT BUILT 12** (C-01 twice, C-03, C-04, C-06, C-20, C-25,
  C-27, C-28, C-29, C-30, C-31 = 11 distinct controls) ·
  **ADAPT 8** · **PORTABLE NOW 13**.
  Distinct controls remain 11 / 8 / 13.

## Disposition

`AUTOINJECTOR_CONTROL_MATRIX.md` is the ordered deliverable — one row per
requested control, 0 gaps, 0 duplicates. `AUTOINJECTOR_INTEGRATION.md` is
retained as the narrative companion; its 25 entries are thematic groupings and
must not be read as a control count.
