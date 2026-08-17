---
doc_id: PROCESS_DEFECTS
doc_type: process_defect_register
owner: claude
version: 1
last_updated: 2026-08-12
canon_status: approved
supersedes: none
affects: []
---

# PROCESS DEFECT REGISTER

Failures of the **system** at its own rules. Distinct from `ISSUES.md`, which
records failures of the **book**.

```yaml
## PDF-000 | <classification>/<severity> | <one line>
classification:   PROCESS_VIOLATION | DEFECT
severity:         S0 | S1 | S2 | S3 | S4 | none
observed:         what actually happened
should_have:      what the rule required
root_cause:
rule_changed:     which document was amended
detection:        the check that catches a recurrence      # MANDATORY
regression_test:  test name, or "none practical - assigned to <gate>"  # MANDATORY
test_verified:    failed before fix, passed after
status:           open | closed
```

**Classification is separate from severity.** PROCESS_VIOLATION is not a point
on the S0-S4 scale (SYSTEM_SPEC Sec.29) - it records that a prohibited action
was intercepted before it took effect.

`severity: none` is permitted ONLY when classification is PROCESS_VIOLATION and
the action was intercepted before adoption, mutation, or propagation. Actual
defects use S0-S4.

A contained PROCESS_VIOLATION is recorded but does NOT block subsequent approval
gates. Only an S0 blocks.

`detection` is not optional. Without it the entry documents that a failure
happened and does nothing to prevent recurrence. If no automatable check exists,
say so explicitly and name the manual gate that substitutes.

---

## OPEN

*(none)*
