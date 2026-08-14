#!/usr/bin/env python3
"""
init_project.py — scaffold an Atelier book project.

Builds the repository structure from SYSTEM_SPEC.md §5.1 and drops in every
template with correct front matter and ownership.

Usage:
    python init_project.py "My Book Title"
    python init_project.py "My Book" --path ./books --dry-run
    python init_project.py "My Book" --chapters 32 --force

Exit codes:
    0  created
    1  nothing to do (already exists, no --force)
    2  error (permissions, bad path, partial write)
    3  bad invocation
"""

from __future__ import annotations

import argparse
import datetime
import re
import shutil
import sys
from pathlib import Path

TODAY = datetime.date.today().isoformat()

DIRS = [
    "00_CONTROL",
    "01_DESIGN",
    "02_BIBLE/characters",
    "02_BIBLE/turnarounds",
    "02_BIBLE/locations",
    "02_BIBLE/world",
    "03_MEMORY",
    "04_CHAPTERS",
    "05_RESEARCH",
    "06_AUDITS",
    "07_BUILD",
    "99_ARCHIVE",
]


def fm(doc_id: str, doc_type: str, owner: str, status: str = "draft") -> str:
    return (
        "---\n"
        f"doc_id: {doc_id}\n"
        f"doc_type: {doc_type}\n"
        f"owner: {owner}\n"
        "version: 1\n"
        f"last_updated: {TODAY}\n"
        f"canon_status: {status}\n"
        "supersedes: none\n"
        "affects: []\n"
        "---\n\n"
    )


def files(title: str, chapters: int) -> dict[str, str]:
    f: dict[str, str] = {}

    # ---------------- CONTROL ----------------
    f["00_CONTROL/STATE.md"] = fm("STATE", "state", "chatgpt", "approved") + f"""# PROJECT STATE

**Book:** {title}
**Stage:** INTAKE
**Next required action:** Collect intake answers (SYSTEM_SPEC §32), then
ChatGPT drafts BLUEPRINT v1.

## Progress
- Chapters planned: {chapters}
- Chapters approved: 0
- Words approved: 0
- Open S1 issues: 0
- Open AUTHORITY_CONFLICTs: 0

## Lifecycle position
INTAKE → concept → blueprint → world → characters → systems → roadmap →
chapter cards → production loop → full draft → developmental → sweep →
polish → assemble → final read → complete
         ^ here

## Blocked on
- Nothing.

> This file always names the current node and the next required action.
> That invariant is what lets the project resume cleanly after any interruption.
"""

    f["00_CONTROL/DECISION_LOG.md"] = fm("DECISION_LOG", "decision_log", "chatgpt", "approved") + """# DECISION LOG

Major decisions, alternatives considered, and — critically — why alternatives
were rejected. Prevents settled questions from being relitigated.

## Template

```
## DEC-000 — <one-line summary>
- date / stage / spec ref
- question:
- alternatives:
    A: {proposal, source, reasoning}
    B: {proposal, source, reasoning}
- positions:        each model's view, verbatim, unsummarized by opponents
- selected:
- reasoning:
- rejected_because: per alternative
- documents_affected: []
- downstream_impact: which chapters need reevaluation
- reversal_cost:    LOW | MEDIUM | HIGH — what breaks if overturned later
- status:           approved | provisional | superseded
```

Provisional entries (SYSTEM_SPEC §4.7) are binding until the owning role rules.

---
"""

    f["00_CONTROL/REVISION_LOG.md"] = fm("REVISION_LOG", "revision_log", "claude", "approved") + """# REVISION LOG

## Template

```
## REV-000 | <date> | level: L1-L8
- target:          what was revised
- trigger:         issue id, audit finding, or decision id
- change:          what actually changed
- documents_updated: []
- downstream_reevaluation_required: [CH12, CH19]
- verified_by:
```

A revision is not complete when the text changes. It is complete when every
document in the `affects` list is updated and this entry is written.

---
"""

    f["00_CONTROL/PROCESS_DEFECTS.md"] = fm("PROCESS_DEFECTS", "process_defect_register", "claude", "approved") + """# PROCESS DEFECT REGISTER

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
"""

    f["00_CONTROL/ISSUES.md"] = fm("ISSUES", "issues", "gemini", "approved") + """# ISSUE REGISTER

Severity: **S1** blocking · **S2** major · **S3** minor · **S4** note

## Template

```
## ISS-000 | S? | open | <one line>
- found_in:    CH07 S03
- found_by:    gemini
- type:        continuity | timeline | rule | voice | structure | AUTHORITY_CONFLICT
- detail:
- evidence:    citations to manuscript and ledger
- ruling:      accept | reject | escalate
- resolution:
- prevention:  what automated check would have caught this?
```

The `prevention` field is the one usually skipped and the one that compounds.
Every S1 should end by asking what script would have caught it.

---

## OPEN

*(none)*

## RESOLVED

*(none)*
"""

    # ---------------- DESIGN ----------------
    f["01_DESIGN/BLUEPRINT.md"] = fm("BLUEPRINT", "blueprint", "chatgpt") + f"""# BOOK BLUEPRINT — {title}

> Controlled source of truth for **prescriptive** facts (SYSTEM_SPEC §23).
> Changes to an approved Blueprint require a Decision Log entry.

## IDENTITY
- working_title: {title}
- genre / subgenre:
- audience:
- comp_titles:
- tone / style:
- narrative_perspective:
- tense:
- target_word_count:
- chapter_count: {chapters}

## CORE
- premise:
- story_question:        *the single question the reader wants answered*
- theme_primary:         *state as a tension, not a topic — "loyalty vs. truth"*
- theme_secondary:
- promise_to_reader:     *what the opening implicitly guarantees*

## CONFLICT
- protagonist_want:      *external, conscious, pursued*
- protagonist_need:      *internal, often unconscious, resisted*
- antagonistic_force:
- central_conflict:
- stakes_external:
- stakes_internal:
- stakes_escalation_path:

## SHAPE
- beginning_state:
- inciting_incident:
- first_turn:
- midpoint:
- low_point:
- final_escalation:
- climax:
- resolution:
- ending_state:          *must contrast with beginning_state*

## CAST
- character_arcs:        *per major character — from → through → to*

## WORLD
- world_overview:
- hard_rules: []         *inviolable; violation is S1*
- soft_rules: []         *tendencies; exceptions must be logged*

## MYSTERY & CRAFT
- major_mysteries: []
- reveals: []            *with target chapters*
- foreshadowing_requirements: []
- tonal_boundaries:      *what this book will never do*
"""

    f["01_DESIGN/ROADMAP.md"] = fm("ROADMAP", "roadmap", "chatgpt") + """# BOOK ROADMAP

Phases: Beginning → Development → Escalation → Midpoint → Consequences →
Final Escalation → Climax → Resolution

| Ch | Phase | Plot | Character | Relationship | World | Mystery | Tension | Reader knows | Reader doesn't | Setup/Payoff |
|----|-------|------|-----------|--------------|-------|---------|---------|--------------|----------------|--------------|
| 01 |       |      |           |              |       |         |         |              |                |              |

**Tension** is 1–10. This column is the only place whole-book pacing is visible.
A flat run (4-4-4-5-4) is a structural defect detectable at a glance and
invisible from inside any single chapter.

**Reader knows / doesn't** is the gap that produces suspense, dramatic irony, and
surprise. Nothing else tracks it, and without it a system will spoil its own
reveals without noticing.
"""

    f["01_DESIGN/STYLE_SHEET.md"] = fm("STYLE_SHEET", "style_sheet", "claude") + """# STYLE SHEET

Claude's instrument. The book must sound like one person wrote it.

## VOICE
- narrative_distance:    *close | medium | distant*
- sentence_rhythm:
- diction_register:
- imagery_density:
- humor:
- interiority_level:

## MECHANICS
- dialogue_punctuation:
- chapter_headings:
- scene_break_marker:
- numbers, dates, time formatting:
- profanity policy:
- italics usage:

## TABOOS — words and moves this book never uses
- *e.g. "somehow", "suddenly", "little did they know"*
- *e.g. no rhetorical-question paragraph openers*
- *e.g. no weather in the first line of a chapter*

Negative constraints hold voice across a long book far better than positive
description. "Never opens a chapter with weather" survives 300 pages;
"atmospheric prose" dissolves by chapter 5.

## SAMPLE PARAGRAPH
*(Written once, approved, and used as the voice anchor for every draft.)*
"""

    f["01_DESIGN/OPEN_THREADS.md"] = fm("OPEN_THREADS", "thread_register", "chatgpt") + """# OPEN THREAD REGISTER

```
## THR-000
- thread:
- origin:              CH00 S00
- characters: []
- importance:          major | moderate | minor
- current_status:      open | developing | resolving | closed
- planned_development:
- expected_payoff:
- target_chapter:
- completed:           false
- last_advanced:       CH00
```

**Automated staleness check:** any major thread not advanced in 5 chapters, or
any thread whose target chapter has passed while `completed: false`, raises an
S2. Threads rarely die by decision — they die because everyone forgot.

---
"""

    f["01_DESIGN/SETUP_PAYOFF.md"] = fm("SETUP_PAYOFF", "setup_payoff", "chatgpt") + """# SETUP / PAYOFF REGISTER

```
## SP-000
- setup:
- planted:         CH00 S00
- subtlety:        background | noticeable | flagged
- payoff_planned:
- payoff_target:   CH00
- payoff_actual:   —
- status:          planted | paid | orphaned | cut
```

Automated checks: **orphan** (planted, target passed, unpaid → S2) and
**unearned payoff** (payoff with no plant → S2 unless flagged as intentional
cold surprise).

Payoffs should generally land 3+ chapters after their setup. Closer and the
reader feels the machinery.

---
"""

    # ---------------- BIBLE ----------------
    f["02_BIBLE/characters/_TEMPLATE.md"] = fm("CHAR-template", "character_profile", "claude") + """# <CHARACTER NAME>

## STATIC
- full_name / aliases:
- age / dob:
- physical: height, build, hair, eyes, skin, distinguishing_marks
- appearance_notes:
- clothing_tendencies:
- voice: pitch, pace, accent
- speech_patterns:
    - verbal_tics: []
    - vocabulary_register:
    - profanity_use:
    - sentence_length:
    - **what_they_never_say:**   *← voice anchor; negative constraints hold*
- personality:
- strengths / weaknesses / skills: []
- beliefs: []
- motivation / desire (want) / need:
- fears / secrets: []
- backstory:
- internal_conflict / external_conflict:
- arc: from → through → to
- signature_possessions: []

## DYNAMIC — as of CH00
- current_location:
- current_condition:          *physical, including injuries*
- current_emotional_state:
- carrying: []
- knows: []                   *fact + chapter learned*
- **believes_incorrectly: []** *← the most valuable field in this document*
- relationships:              *per character — status, tension, last interaction*
- arc_position:

`believes_incorrectly` is where dramatic irony, betrayal, and misunderstanding
live. Models default to characters knowing whatever the narrative knows, which
flattens every scene that depends on that gap.
"""

    f["02_BIBLE/turnarounds/_TEMPLATE.md"] = fm("TURN-template", "turnaround", "claude") + """# TURNAROUND — <CHARACTER>

> §4.9 assumption: image identity consistency across generations is treated as
> **unreliable**. This sheet is canonical **as text**. Generated imagery is
> decorative and is never a source of truth.

- front / side / back:
- height_build:
- hair: cut, color, texture, how worn
- eyes / skin:
- distinguishing_features: []
- default_clothing / alternate_outfits: []
- equipment / accessories: []
- expressions: neutral, angry, afraid, amused, lying
- body_language / movement_style / posture:

## PHYSICAL CHANGES BY CHAPTER
- ch01: baseline

*This block prevents the classic failure where an injury from chapter 7 has
vanished by chapter 9 without healing.*

- image_prompt_base:      *locked descriptive string*
- reference_images: []    *path + chapter validity range*
"""

    f["02_BIBLE/locations/_TEMPLATE.md"] = fm("LOC-template", "location", "claude") + """# LOCATION — <NAME>

- name / purpose:
- controlled_by / inhabitants: []
- geography / layout / architecture / appearance:
- sensory:
    - light:
    - sound:
    - smell:
    - temperature:
    - texture:
- atmosphere:
- important_objects: []
- entrances_exits: []
- nearby_locations: []
- historical_significance:
- events_occurred_here: []
- **current_condition:**      *updated per chapter — damage persists*
- first_appearance: CH00

Consistent sensory anchors — one specific smell, a particular quality of light —
do more for a reader's recognition of a returning location than repeated
architectural description.
"""

    f["02_BIBLE/world/WORLD.md"] = fm("WORLD", "world_bible", "claude") + """# WORLD BIBLE

Layered so context assembly can pull a slice rather than the whole thing.
Every fact carries `established_in: CHnn` or `established_in: PLAN`.

## PHYSICAL
geography · climate · regions · cities · landscapes · transportation

## POLITICAL
governments · laws · factions · organizations · power structure

## SOCIAL
cultures · customs · class · religion · languages · taboos

## ECONOMIC
currency · trade · resources · who has what and why

## HISTORICAL
prior events · conflicts · myths

## MATERIAL
important objects · artifacts · everyday texture

## RULES
- hard_rules: []   *inviolable — violation is S1*
- soft_rules: []   *tendencies — exceptions must be logged*

A rule that is neither firmly hard nor explicitly soft becomes whatever the
current scene needs. That ambiguity is the root of most system failures.
"""

    f["02_BIBLE/world/MAGIC.md"] = fm("MAGIC", "magic_bible", "claude") + """# MAGIC SYSTEM

*(Delete this file if the genre has no magic.)*

- source:
- who_can_use / how determined:
- how_learned:
- hard_rules: []
- abilities: []           *effects and limits*
- limitations: []
- **costs: []**           *every use costs something — physical, temporal, moral*
- risks: []
- prohibited_uses: []
- power_progression:      *and what gates it*
- countermeasures: []
- artifacts: []
- social_consequences:    *law, class, religion, economy*
- known_exceptions: []    *each with logged justification*

**Enforcement:** every magic scene is checked against `hard_rules` and `costs`
before approval. A use with no cost is S1 unless an exception is logged.

`costs` is load-bearing. Magic without cost is not a system but a plot-hole
generator, and models reach for it precisely when the plot is stuck — exactly
when the constraint matters most.
"""

    f["02_BIBLE/world/TECHNOLOGY.md"] = fm("TECHNOLOGY", "tech_bible", "claude") + """# TECHNOLOGY SYSTEM

*(Delete this file if not applicable.)*

- tech_level:
- major_inventions / devices / weapons: []
- **transportation:**     *with speeds and ranges → feeds timeline validation*
- **communications:**     *with latency and range → answers "why not just call"*
- computing_ai / energy / medicine / manufacturing:
- capabilities / limitations: []
- availability / cost / controlled_by:
- societal_effects:

**Rule:** technology cannot gain a capability because the plot needs it. New
capabilities require a Decision Log entry and a Blueprint amendment.

Answer the communications question once, here, and every scene inherits the
answer instead of quietly dodging it.
"""

    f["02_BIBLE/TIMELINE.md"] = fm("TIMELINE", "timeline", "claude") + """# MASTER TIMELINE

In-world chronology, keyed to chapters.

| Ch | Scene | In-world date | Time | Duration | Elapsed since prev | Events |
|----|-------|---------------|------|----------|--------------------|--------|

## HISTORICAL (pre-story)

## ACTIVE DEADLINES

## FLASHBACKS / TIME JUMPS

## AUTOMATED CHECKS (validate_timeline.py)
1. Travel — distance ÷ transport speed vs. elapsed time
2. Simultaneity — no character in two places at once
3. Age — consistent with dates and stated events
4. Deadline — declared deadlines still arithmetically live
5. Duration — stated durations match elapsed time
6. Ordering — no effect precedes its cause

§4.9: arithmetic is necessary but not sufficient. Non-linear time, unreliable
narration, and relativistic settings are flagged for **manual** review, never
auto-passed.
"""

    # ---------------- MEMORY ----------------
    f["03_MEMORY/CONTINUITY.md"] = fm("CONTINUITY", "continuity_memory", "claude", "approved") + """# CONTINUITY MEMORY

**APPEND-ONLY.** Facts are never edited in place. A fact that becomes wrong is
superseded by a new entry pointing back at it. This preserves what was true
when — which is what's needed to fix a contradiction correctly rather than
paper over it.

Categories: INJURY · CLOTHING · OBJECT · OBJECT_LOCATION · CHARACTER_LOCATION ·
RELATIONSHIP · KNOWLEDGE · SECRET_REVEALED · PROMISE · DEATH · DAMAGE ·
ENVIRONMENT · MAGIC_USE · TECH_USE · TIME · QUESTION_OPEN

Format:
```
FACT-0001 | ch01 s01 | CATEGORY | <fact> | est: CH01 | status: active
                                          | expires: <if it has a lifetime>
FACT-0002 | ch03 s02 | SUPERSEDES FACT-0001 | <replacement fact>
```

**Expiry:** facts with natural lifetimes carry `expires`. On expiry the fact is
flagged for review, never auto-deleted — the system asks whether it healed,
scarred, or worsened, and a legible answer replaces the guess.

**Update discipline:** appended after every approved scene, by Claude, as a
distinct job. Never as a side effect of drafting — extraction while drafting is
unreliable because attention is on the prose.

---
"""

    f["03_MEMORY/CANDIDATES.md"] = fm("CANDIDATES", "canon_candidates", "claude", "draft") + """# CANON CANDIDATES

**Proposals only. Nothing here is canon.**

Written during extraction (after revision, before the gate). Audited by Gemini
for completeness at the gate. On a successful commit transaction, approved
candidates are appended to `CONTINUITY.md` and removed from this file. On
rollback, this file is discarded and `CONTINUITY.md` is untouched.

Kept physically separate from the authoritative ledger so that "is this canon?"
is answerable by location rather than by reading a status flag.

```yaml
candidate_id: CAND-0001
job_id:       CH01-S01-DRAFT-v1
entity_id:
property:
value:
valid_from:   CH01-S01
source:       04_CHAPTERS/ch01/scenes/s01.md
status:       proposed        # proposed | approved | rejected
```

A candidate appearing in `CONTINUITY.md` before commit, or surviving a
rollback, is **S0**.

---
"""

    f["03_MEMORY/STATE_SNAPSHOT.md"] = fm("STATE_SNAPSHOT", "story_state", "claude") + """# STORY STATE SNAPSHOT

Condition at the last approved point, so no model rereads the manuscript to
learn where things stand.

- as_of:
- in_world_datetime:
- chapter_position: 0 of ?
- phase:

## CHARACTERS
```
<name>:
  location / physical / emotional
  carrying: []
  knows_recently: []
  believes_wrongly: []
  arc_position:
```

## STORY
- active_threads: []
- imminent_deadlines: []
- reader_knows: []
- reader_suspects: []
- reader_doesnt_know: []
- tension_level:

## SEAM
- **last_scene_ending:**  *final 2-3 sentences, verbatim*
- next_scene_opens:       *required starting condition*

Verbatim last sentences are small and disproportionately valuable — transitions
are where seams show, and a summary cannot carry rhythm.
"""

    # ---------------- CHAPTER ----------------
    f["04_CHAPTERS/_TEMPLATE/CARD.md"] = fm("CH00-CARD", "chapter_card", "chatgpt") + """# CHAPTER CARD — CH00

- chapter / title / phase / pov:
- word_target:
- **purpose:**            *cut this chapter — what breaks?*
- starting_situation:
- characters_present: []
- locations: []
- timeframe:              *in-world date/time, duration*
- objectives:             *per character*
- conflict:
- major_events: []
- information_introduced:
- information_revealed_to_reader:
- information_withheld:
- character_development:
- relationship_changes:
- worldbuilding_introduced:
- foreshadowing: []
- setup: []  /  payoff: []
- turning_point:
- ending_condition:       *required state at close*
- hook:
- continuity_requirements: []
- open_threads_touched: []

`purpose` is a gate, not decoration. If no one can answer the question, the
chapter does not get written.
"""

    f["04_CHAPTERS/_TEMPLATE/ROADMAP.md"] = fm("CH00-ROADMAP", "chapter_roadmap", "chatgpt") + """# CHAPTER ROADMAP — CH00

```
Start → S1 → Development → S2 → Complication → S3 → Turning Point → End → Hook
```

- entry_state:
- scene_sequence:     *one line per scene: its function*
- the_turn:
- exit_state:
- delta:              *what is different*

**Gate: if entry_state == exit_state, the chapter is inert.** Something must
change — situation, knowledge, relationship, or resolve. This single check
catches the commonest structural failure in AI long fiction: chapters that are
pleasant, competent, and do nothing.
"""

    f["04_CHAPTERS/_TEMPLATE/beats.md"] = fm("CH00-BEATS", "beat_map", "chatgpt") + """# SCENE & BEAT MAP — CH00

## SCENE CH00-S01
- pov / location / in_world_time / duration:
- characters_present: []
- emotional_state_start:
- objective:              *what POV wants*
- obstacle: / conflict:
- dialogue_purpose:
- information_exchanged:  *who learns what*
- physical_action: / discovery: / decision:
- change:                 *what is different at scene end*
- emotional_state_end:
- continuity_updates: []
- setup_payoff: []
- transition:
- word_target:

### Beats
1.
2.
3.

**Anti-suffocation rule: plan what must be true, leave open how it feels.**
Beats describe motion, not prose. A beat map specifying a metaphor has
overreached; one leaving the scene's outcome undecided has underreached.
"""

    f["04_CHAPTERS/_TEMPLATE/scenes/s01.md"] = """[TO: NONE]

}-----< Start >-----{

}-----< finish >-----{

JOB_ID:
BASE_VERSION:
OUTPUT_VERSION:   1
TO:               FROM:
CANON REQUESTS:   none
CANON CANDIDATES: none
PROSE OBJECTIONS: none
CONFIDENCE:
RESPONSE REQUIRED: no
NOTES:

# Prose goes INSIDE the markers. Everything here is out-of-book.
# Never type anything inside the markers you would not publish.
# CANON CANDIDATES are proposals. They are not canon until approved and
# committed -- writing a fact here does not make it true.
"""

    f["05_RESEARCH/README.md"] = fm("RESEARCH", "research_index", "gemini") + """# RESEARCH LIBRARY

Gemini's workspace. One file per topic, sources cited.

```
## RES-000 — <topic>
- question:
- findings:
- sources: []
- confidence:   high | medium | low
- affects: []   *which bible documents or chapters*
```
"""

    f["06_AUDITS/README.md"] = fm("AUDITS", "audit_index", "gemini") + """# AUDIT REPORTS

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
"""

    f["07_BUILD/.gitkeep"] = ""
    f["99_ARCHIVE/README.md"] = """# ARCHIVE

Superseded documents. Nothing is deleted — deletion loses the reasoning.
Each archived file leaves a tombstone pointer at its original path.
"""

    f["README.md"] = f"""# {title}

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
}}-----< Start >-----{{   everything after this IS in the book
}}-----< finish >-----{{  everything after this is NOT
```
Position decides. Content is never interpreted. Never type anything inside the
markers you would not publish.

## Build
```
python assemble_manuscript.py 04_CHAPTERS -o 07_BUILD/manuscript.md \\
       --strict --report 07_BUILD/build_report.txt
```
"""
    return f


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Scaffold an Atelier book project.")
    ap.add_argument("title", help="book title")
    ap.add_argument("--path", default=".", help="parent directory")
    ap.add_argument("--chapters", type=int, default=30)
    ap.add_argument("--force", action="store_true", help="overwrite existing project")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    title = args.title.strip()
    if not title:
        print("[FATAL] title is empty", file=sys.stderr)
        return 3
    if args.chapters < 1 or args.chapters > 500:
        print("[FATAL] --chapters must be 1-500", file=sys.stderr)
        return 3

    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-") or "book"
    root = Path(args.path).expanduser().resolve() / slug

    if root.exists():
        if not args.force:
            print(f"[FATAL] {root} already exists. Use --force to overwrite.",
                  file=sys.stderr)
            return 1
        if not args.dry_run:
            try:
                shutil.rmtree(root)
            except OSError as e:
                print(f"[FATAL] could not remove {root}: {e}", file=sys.stderr)
                return 2

    payload = files(title, args.chapters)

    if args.dry_run:
        print(f"Would create {root} with {len(DIRS)} dirs, {len(payload)} files:")
        for k in sorted(payload):
            print(f"  {k}")
        return 0

    created: list[Path] = []
    try:
        for d in DIRS:
            (root / d).mkdir(parents=True, exist_ok=True)
        for rel, content in payload.items():
            p = root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content, encoding="utf-8")
            created.append(p)
    except OSError as e:
        print(f"[FATAL] write failed: {e}", file=sys.stderr)
        print(f"[FATAL] partial project at {root} — inspect or remove it.",
              file=sys.stderr)
        return 2

    print(f"Created {root}")
    print(f"  {len(DIRS)} directories, {len(created)} files")
    print(f"  Next: open 00_CONTROL/STATE.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
