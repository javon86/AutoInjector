# Novella Validation

An Atelier book project. See `SYSTEM_SPEC.md` for the full system design.

## Where things live
- `00_CONTROL/STATE.md` — **start here.** Current stage and next action.
- `01_DESIGN/` — Blueprint, Roadmap, Style Sheet, registers
- `02_BIBLE/` — characters, locations, world, timeline
- `03_MEMORY/` — continuity ledger, story state
- `04_CHAPTERS/` — cards, beats, drafted scenes
- `07_BUILD/` — assembled manuscript

## Ownership — one writer per file
- **ChatGPT** (Showrunner): STATE, DECISION_LOG, BLUEPRINT, ROADMAP, cards,
  registers
- **Claude** (Author): manuscript, CONTINUITY, STYLE_SHEET, bibles, TIMELINE,
  REVISION_LOG
- **Gemini** (Auditor): research, audits, ISSUES

## The rule that governs everything
```
}-----< Start >-----{   everything after this IS in the book
}-----< finish >-----{  everything after this is NOT
```
Position decides. Content is never interpreted. Never type anything inside the
markers you would not publish.

## Build
```
python assemble_manuscript.py 04_CHAPTERS -o 07_BUILD/manuscript.md \
       --strict --report 07_BUILD/build_report.txt
```
