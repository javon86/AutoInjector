# ATELIER Recovery Guide

## If a run hangs
1. Stop the process.
2. Record the command and elapsed time.
3. Treat the run as failed; never count a timeout as a pass.
4. Run `python clean_verify.py` after correction.

## If a transaction is interrupted
- Do not manually mark it complete.
- Use transaction recovery state and repository evidence.
- Preserve diagnostic/quarantine material before destructive cleanup.

## If duplicate or stale work arrives
- Duplicate delivery must be quarantined by job identity.
- Stale jobs/instructions must be rejected before mutation.

## If an unauthorized model produces an artifact
- Do not assemble or promote it.
- Route it to quarantine once the write-boundary integration is enabled.
- Establish provenance from the artifact, not conversational claims.

## If verification results disagree
- Re-run from a clean extract.
- Prefer artifact hashes, captured stdout/stderr, and repository state over status prose.
- Keep local, cross-machine, auditor-executed, and analytical evidence separate.
