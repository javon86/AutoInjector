# ATELIER Operator Guide

ATELIER is the autonomous bookmaking program. Example manuscripts are regression/validation material, not the product.

## Core lifecycle
CREATE → ROUTE → DELIVER → CAPTURE → VERIFY → CLASSIFY → APPLY/HOLD → PROPAGATE → AUDIT → CLOSE

## Start a project
`python init_project.py "Book Title" --chapters 20`

## Verify the program
`python clean_verify.py`
`python harness.py e2e`

## Build a manuscript
From the project directory:
`python ../assemble_manuscript.py 04_CHAPTERS -o 07_BUILD/manuscript.md --strict`

## Required operating rules
- Only prose inside exact Start/finish boundary markers can enter the manuscript.
- Never accept an uncaptured execution claim as proof.
- Never promote unaudited candidate facts to continuity/canon.
- A stale job/instruction must not mutate current state.
- Unauthorized model writes must be rejected or quarantined.
- Do not call local execution cross-machine or independent-audit evidence.

## Pause/resume
A paused project remains authoritative at its last committed transaction and repository state. Resume only after running recovery/state checks and validating current inputs.
