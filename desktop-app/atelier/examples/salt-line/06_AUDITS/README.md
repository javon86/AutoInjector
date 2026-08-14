---
doc_id: AUDITS
doc_type: audit_index
owner: gemini
version: 1
last_updated: 2026-08-12
canon_status: draft
supersedes: none
affects: []
---

# AUDIT REPORTS

One file per audit. Findings only — Gemini writes nothing into the manuscript
or the bibles.

```
## AUD-000 | CH07 S03 | <date>
- checked:      what was examined
- findings:     each with severity, evidence, citation
- passed:       what was checked and why it passed
- confidence:
```

Per §4.5, an audit returning zero findings must state what it checked and why
each check passed. Empty audits are re-run once with a sharper prompt.

Per §4.8.3, a chapter cannot reach APPROVED without an audit of record. Without
one it is held at `PENDING_AUDIT`.
