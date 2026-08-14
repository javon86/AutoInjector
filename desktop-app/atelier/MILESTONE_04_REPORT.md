# Milestone — Verification / Release / Operator Layer

Completed five non-overlapping production-readiness tasks:

1. `clean_verify.py` — bounded clean-machine runner for all 17 regression suites, JSON evidence output, timeout = failure.
2. `package_release.py` — reproducible drop-in release ZIP builder with SHA-256 manifest.
3. `INSTALL.md` — clean installation and verification procedure.
4. `OPERATOR_GUIDE.md` — start/build/pause/resume and evidence rules.
5. `RECOVERY_GUIDE.md` — timeout, interruption, stale/duplicate, unauthorized-write, and disagreement recovery procedures.

Verification performed:
- `python3 -m py_compile clean_verify.py package_release.py` — PASS.
- `python3 harness.py e2e` — ALL GREEN (scaffold, empty STOP, real-scene exact build).

Scope separation:
- Claude owns F-07/F-08 closure and merge/provenance work.
- These files do not modify transaction.py, candidate controls, manuscript content, or F-07/F-08 logic.
