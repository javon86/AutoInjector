# MANUSCRIPT PROTOCOL — v2

Applies to: ChatGPT, Claude, Gemini, and every stage of the bookmaking system
(writing, editing, revision, AI-to-AI transfer, chapter transfer, storage,
retrieval, final assembly).

Synced to `SYSTEM_SPEC.md` v0.3. Supersedes v1.

---

## 1. THE STRICT MANUSCRIPT BOUNDARY RULE (ABSOLUTE)

```
}-----< Start >-----{     ← opens book content
        ...
}-----< finish >-----{    ← closes book content
```

**START → FINISH = IN THE BOOK.**
Everything appearing after `}-----< Start >-----{` and before
`}-----< finish >-----{` is book content and goes in the book.

**FINISH → NEXT START = NOT IN THE BOOK.**
Everything appearing after `}-----< finish >-----{` and before the next
`}-----< Start >-----{` is not book content and does not go in the book.

The out-of-book region may contain: AI-to-AI communication, instructions,
notes, context, memory information, character information, continuity
information, revision requests, critiques, research, planning, chapter
information, version information, explanations, questions, responses between
ChatGPT / Claude / Gemini, and anything else needed to create, review, revise,
organize, or understand the book.

No matter how much information appears there, **none of it goes in the book.**

The START and FINISH markers themselves are control markers. They are never
printed in the final book.

**This rule is unchanged from v1 and is not subject to amendment.**

## 2. THE NON-INTERPRETATION CLAUSE

The system must **never** decide whether something belongs in the book based on:

- what the text says
- how it is written
- what it appears to be
- how good or bad it is
- whether it "reads like" prose or "reads like" a note

**Position alone determines manuscript membership.**

Consequences that follow directly, and are not exceptions:

- Beautiful prose sitting outside the markers is **cut**. No rescue.
- A stray note, a stage direction, a typo, an AI apology, or the sentence "I
  think chapter 4 needs work" sitting inside the markers is **kept**. It is
  printed exactly as it stands.
- Therefore: **never type anything inside the markers that you do not want a
  reader to read.** If you need to say something to another AI or to the
  manager, close the block first.
- A system that detects notes inside the markers must **report** them, never
  silently remove them. Removal would require interpreting content, which this
  clause forbids.

## 3. MARKER DISCIPLINE

1. Every `Start` must be matched by a `finish`. No unclosed blocks.
2. No nesting. A `Start` inside an open block is an error, not a second block.
3. A `finish` with no open block is an error.
4. Markers sit alone on their own line. Nothing before, nothing after.
5. A file may contain many blocks. They are concatenated in file order.
6. Files are assembled in filename sort order — name chapters `ch01_...`,
   `ch02_...`, not `1`, `2`, `10`.

### 3.1 Canonical form and strict mode

```
}-----< Start >-----{
}-----< finish >-----{
```

Tolerant recognition (variant casing, spacing, dash count) remains available for
**diagnostics and recovery only.**

> **In `--strict` mode, any noncanonical marker spelling, casing, spacing, dash
> count, or formatting is a build error.** Strict production builds require the
> exact canonical markers.

Rationale: if tolerant parsing silently succeeds, malformed output becomes
culturally accepted because the build keeps working, and the canonical form
stops being canonical.

**Recovery path:** `assemble_manuscript.py --normalize-markers` rewrites
recoverable variants to canonical form in place and reports the count. Strict
mode fails; normalization fixes. Both are one command.

### 3.2 Limits on normalization

`--normalize-markers` is permitted **only** for mechanically recognizable
marker-format variants: casing, spacing, dash count, surrounding whitespace.

> **It must never normalize, delete, relocate, or reinterpret ordinary content.**

Operationally: it rewrites a line **only** when that entire line is a marker and
nothing else. Marker-like text appearing inside a sentence is never rewritten,
never removed, and never moved — it is *reported* under §3 rule 4 (markers must
sit alone on their own line) and corrected by a human or by the Author, never by
the tool.

The reason is §2. Any repair that requires deciding what a piece of text *means*
is content interpretation, and content interpretation is forbidden regardless of
how obvious the intended meaning appears. A tool permitted to fix "obvious" cases
is a tool permitted to be wrong about what is obvious.

**Corollary — injection 15** (notes accidentally inside manuscript markers):
`detect → report → halt for correction`. **Never semantic auto-repair.** Text
inside the markers is book content by definition, and removing it would require
judging that it does not belong — precisely the judgment §2 forbids.

## 4. HANDOFF FORMAT (AI → AI)

Routing metadata precedes the `Start` marker and is therefore **outside the
manuscript by position** — it cannot reach the book even in principle. This is
not a special case; it is §1 applied.

```
[TO: ALL] | [TO: CHATGPT] | [TO: CLAUDE] | [TO: GEMINI] | [TO: USER] | [TO: NONE]

}-----< Start >-----{
<the actual prose, and nothing else>
}-----< finish >-----{

JOB_ID:           <immutable>
BASE_VERSION:     <repository state this work was built on>
OUTPUT_VERSION:   <new version produced>
TO:               <role>        FROM: <role>
CANON REQUESTS:   <facts needed but not supplied, or "none">
CANON CANDIDATES: <facts this draft introduces — proposals, not canon>
PROSE OBJECTIONS: <PROSE_OBJECTION blocks, or "none">
CONFIDENCE:       <high|medium|low> on <what>
RESPONSE REQUIRED: <yes/no + recipient>
NOTES:
```

Prose block first, always. A truncated handoff then loses metadata rather than
manuscript — fail-safe by ordering.

**Untagged messages default to `[TO: USER]`. One routing tag, first line, never
two.** No acknowledgment-only messages: acknowledge by acting.

### 4.1 STALE_JOB

A returned job whose `BASE_VERSION` no longer matches current authoritative
state is **`STALE_JOB`** and **cannot commit.** It must be rebased on current
inputs, or the staleness explicitly accepted with logged reasoning.

Without this, a response arriving after its context moved overwrites work built
on newer information, and the overwrite looks exactly like ordinary progress.

### 4.2 STALE_INSTRUCTION

Distinct from `STALE_JOB`. A job can be current while carrying an instruction
written against an obsolete specification state.

**Before applying any received revision request, compare it against the current
authoritative version.** If the change is already implemented, superseded, or in
conflict with a later final ruling, record `STALE_INSTRUCTION` and **perform no
mutation.** New, nonconflicting information in the same message is processed
normally.

Never roll the specification backward to satisfy an older message.

## 5. CANON

### 5.1 Four stages

| Stage | Who | Note |
|---|---|---|
| **Canon Proposal** | Any authorized worker | Identifying or proposing a fact creates nothing |
| **Canon Approval** | Showrunner, unless an approved rule already determines it | The only step that creates canon |
| **Canon Recording** | Document Custodian | Records approved canon in the effective ledger and affected documents |
| **Canon Audit** | Auditor | Independently checks recorded state against approved manuscript and controlling decisions |

> **No model may create binding canon merely by recording it.**

The Canon Audit stage exists because recording and deciding are different acts
performed by different roles, and nothing otherwise verifies that what was
recorded is what was approved.

### 5.2 Ledger timing

Any worker who introduces a new fact about the world, a character, a timeline, or
an object **must report it as a canon candidate in the same handoff.**

It enters authoritative continuity **only after approval and successful commit.**

> Changed from v1, which required logging directly to the ledger in the same
> handoff. That allowed an Author's draft to promote its own invention to canon
> by the act of writing it down.

### 5.3 Effective continuity states

Ledger records carry:

```yaml
status:      active | superseded | disputed | retracted
valid_from:  CHnn-Snn
valid_until: CHnn-Snn | null
supersedes:  FACT-nnnn | null
```

- `disputed` — held during an open AUTHORITY_CONFLICT; neither trusted nor
  discarded while the Showrunner rules.
- `retracted` — removed by revision. Distinct from `superseded`: superseded means
  the story moved on, retracted means it never happened. Conflating them
  corrupts the history the ledger exists to preserve.

**Current truth** for any `(entity, property)` is the single record with
`status: active` and `valid_until: null`. More than one match is S0, not a
judgment call.

## 6. ASSEMBLY

> **Approved repository content plus the Strict Manuscript Boundary Rule
> determines manuscript membership.** `assemble_manuscript.py` mechanically
> enforces that rule and is the only authorized final-build path.

The assembler is the enforcer, not the authority. (v1 called it "the single
source of truth for what is in the book," which was wrong — it executes a rule
it does not own.)

No human or AI assembles by hand, copy-paste, or memory. Run `--strict` for any
build intended to be kept.

## 7. S0 — BUILD FAILURE

The following are **S0 BUILD FAILURE**, above story-error severity:

- malformed, unmatched, or nested markers
- noncanonical markers in a strict build
- stale jobs
- failed propagation transactions
- duplicate conflicting deliveries
- invalid state transitions
- version collisions
- more than one `active` record for a `(entity, property)` pair

**S0 prevents manuscript output.** It is never waivable and never subject to
§4.7 provisional defaults.

**Retroactive obligation:** a marker defect found late means prior builds may
have silently dropped prose or included notes. Any S0 marker error marks all
previous builds `SUSPECT` and forces a re-run before the finding closes.

## 8. IDEMPOTENCY

Duplicate delivery of the same immutable `JOB_ID` **must not create a second
write, a second canon entry, or a second state transition.**

Re-delivery of a committed job is ignored or quarantined, never re-applied. The
relay layer between three models duplicates and reorders messages in practice;
duplicate application of a committed revision is silent corruption.

## 9. TRANSACTIONAL COMMIT

State-changing handoffs move through:

```
OPEN → VALIDATED → COMMITTED
```

**Failure before COMMITTED leaves the last committed repository state
authoritative.** A revision touching manuscript + continuity + timeline +
registers is one transaction: all of it commits, or none of it becomes
authoritative.

Implemented git-natively — propagation runs on a working branch, the merge is
the commit, rollback is `git branch -D`.

## 10. CRASH AND RESUME

Job lifecycle:

```
DISPATCHED → RESPONSE_RECEIVED → VALIDATION_PENDING → COMMIT_PENDING → COMMITTED
```

**After interruption, restart from the last COMMITTED state — never from the
latest generated response or a partially written artifact.**
Generated-but-uncommitted work is re-validated from scratch or discarded.
Trusting an uncommitted artifact after a crash is how a system silently adopts
output that never passed a gate.

## 11. AUTHORITY_CONFLICT

Per the finalized **Two-Axis Authority Model** (`SYSTEM_SPEC.md` §23):

**Established Reality Authority**
approved manuscript → effective Continuity Ledger state → Story State →
bible/current-state documents → unapproved drafts

**Intent Authority**
approved Blueprint → latest controlling Decision Log ruling → Roadmap →
Chapter Card → Scene/Beat Map → superseded planning

A cross-axis contradiction raises **`AUTHORITY_CONFLICT`**. **Neither side
automatically wins.** The Showrunner rules whether to revise established text
through a revision transaction, or to amend future intent.

Approved manuscript text is authoritative established reality **until changed
through an approved revision transaction** — not immutable.

Procedure: `HALT → REPORT → CONFIRM → RULE → PROPAGATE → LOG`. An open
AUTHORITY_CONFLICT blocks every gate on the affected chapter, and provisional
defaults do not apply to it.

---

## THE RULE THAT DOES NOT CHANGE

```
START → FINISH  = everything between goes in the book
FINISH → START  = everything between does not go in the book
```

**Position alone determines manuscript membership.**
