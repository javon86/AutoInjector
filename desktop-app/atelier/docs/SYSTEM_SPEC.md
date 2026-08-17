# THE ATELIER SPECIFICATION
### A Three-AI Autonomous Bookmaking System
**Version 0.3.3 — audit findings integrated**
**Status:** DEC-001..006 FINAL · Gemini partial audit integrated (F-01..F-05, V1..V4) · Gate: PASS WITH REQUIRED FIXES — PENDING FOCUSED RE-AUDIT
**Owner of this document:** Claude (Document Custodian)

---

## READING NOTES FOR CHATGPT AND GEMINI

This is a complete baseline, not a partial workstream. Three partial drafts would
have to be merged by someone, and merging is more expensive than editing. So I
took the whole thing to a coherent v0.1 and marked the places where my authority
is weakest.

Two flag types appear throughout:

- **[ARBITRATE]** — a real design fork where I picked one option and the other
  is defensible. ChatGPT owns the final call. My reasoning is stated so you can
  attack it rather than guess at it.
- **[VERIFY]** — a technical or factual claim affecting implementation that I
  could not confirm. Gemini owns verification. Do not build on these until checked.

Do not rubber-stamp. A review that returns "looks good" is a failed review and
should be re-run. Per §35 of the master prompt, agreement loops are a defect.

**v0.3.3 status.** **DEC-001 through DEC-006 are all FINAL.** No Showrunner
decision is outstanding. Four practices are non-waivable protocol requirements
(§4.8). All four Gemini [VERIFY] items remain unanswered and run under §4.9
graceful-degradation assumptions — each chosen so that being wrong costs an
optimization, never a correctness failure. Gemini has not reviewed any version;
its independent adversarial review is the next required gate.

---

# 1. SYSTEM PURPOSE

**Atelier** takes a small user concept and produces a complete, internally
consistent, professionally revised book with minimal further user involvement.

The problem it solves is not generation. Any single model can generate a chapter.
The problem is **entropy across length**: past roughly 30,000 words, a book
written by language models decays — eye colors drift, dead characters speak,
travel takes no time, established rules bend to plot convenience, threads open
and never close, and the prose voice slowly reverts to model-default.

Atelier's core thesis:

> **The manuscript is not the memory. The repository is the memory.**
> Models are stateless workers. State lives in versioned documents. No model is
> ever asked to remember; every model is handed exactly what it needs.

Everything downstream — role division, context packaging, quality gates —
follows from that one sentence.

### Success criteria

The system succeeds if a finished book satisfies all of:

1. Zero unresolved **Severity-1** continuity errors (§29 defines severity).
2. Every registered setup either paid off or deliberately closed in the register.
3. Every open thread resolved or intentionally left open with a logged decision.
4. Full manuscript reads as one authorial voice, verified by blind voice sampling.
5. Total user decisions required after intake: **fewer than 25** across a full novel.
6. The book is finishable. A system that produces a perfect 40% of a book has failed.

---

# 2. SYSTEM ARCHITECTURE

## 2.1 Four components

```
┌──────────────────────────────────────────────────────────┐
│  THE REPOSITORY  — the only source of truth               │
│  Versioned files on disk. Survives every model.           │
└────────────────────┬─────────────────────────────────────┘
                     │ reads/writes mediated by
┌────────────────────┴─────────────────────────────────────┐
│  THE ORCHESTRATOR — state machine + context assembler     │
│  Knows current stage, next action, who gets called,       │
│  and exactly which bytes they receive.                    │
└────────────────────┬─────────────────────────────────────┘
                     │ dispatches jobs to
┌────────────────────┴─────────────────────────────────────┐
│  THE THREE MODELS — stateless workers                     │
│  ChatGPT: Showrunner  Claude: Author  Gemini: Auditor     │
└────────────────────┬─────────────────────────────────────┘
                     │ surfaces status to
┌────────────────────┴─────────────────────────────────────┐
│  THE DASHBOARD — user's window; read-mostly               │
└──────────────────────────────────────────────────────────┘
```

## 2.2 The constraint nobody should design around silently

The three models **cannot talk to each other**. They have no shared channel. Every
"AI-to-AI conversation" is really a file written by one model and handed to
another by something outside all three.

That something is the Orchestrator, and it exists in one of two forms:

**Manual Mode** — the user is the Orchestrator. Copy-paste between three chat
windows, files kept in a folder. Works today, zero build cost, but the user
becomes the bottleneck and the master prompt's "minimal involvement" goal is only
partly met.

**Automated Mode** — a local script calls three APIs, assembles context packages,
writes files, advances the state machine. This is what actually delivers
autonomy.

**Design rule: every artifact in this spec must be usable in both modes.** That
means human-readable markdown with machine-parseable front matter — never a
binary format, never a database-only representation. A user in Manual Mode must
be able to open any file and understand it; a script in Automated Mode must be
able to parse the same file without ambiguity.

**[ARBITRATE]** I recommend building Manual Mode first with the exact file
formats Automated Mode will use, so migration is a script swap and not a rewrite.
Counter-position worth arguing: go straight to Automated Mode, because Manual
Mode's real cost is that the user experiences the friction and abandons the
project before the automation arrives.

## 2.3 Separation of powers

The single most important structural decision in this system:

> **No model is the sole approving reviewer of its own work. No model writes the
> documents that constrain it.**

Self-editing is permitted and encouraged — the SELF-PASS in §25 is a revision
pass, not an approval. Independent gate review is mandatory and cannot be
performed by the producing model. (v0.1 stated this as "no model reviews its own
work," which contradicted §25. Corrected.)

- The **Showrunner** decides what happens but does not write prose.
- The **Author** writes prose but cannot change canon.
- The **Auditor** challenges everything but writes nothing into the book.

This is a deliberate cost. It means more round trips than a single model would
need. It buys the one thing a long book cannot survive without: an adversary who
has no stake in the text being good already.

---

# 3. RESPONSIBILITIES OF CHATGPT, CLAUDE, AND GEMINI

The master prompt asked us not to blindly accept the suggested divisions. I mostly
did accept them, because they track real capability differences — but I moved
three things and I'll say why.

## 3.1 ChatGPT — **The Showrunner**

Owns: project management, story architecture, structural planning, synthesis,
arbitration, and the decision of what happens next.

Writes and owns:
`BLUEPRINT.md`, `ROADMAP.md`, `chapters/cards/`, `DECISION_LOG.md`,
`OPEN_THREADS.md`, `SETUP_PAYOFF.md`, `STATE.md`

Specific duties:
- Convert intake into Blueprint. Expand a thin concept into a full book design.
- Own the Roadmap and all chapter cards; decide scene breakdowns.
- **Arbitrate.** When Claude and Gemini disagree, ChatGPT rules and logs it.
  Arbitration is not consensus-finding; it is a decision with stated reasoning.
- Decide escalation class for every question (§4).
- Own pacing across the whole book — the thing no chapter-level view can see.
- Declare the current stage and the next required action, always.

Why the Showrunner also arbitrates: whoever arbitrates must hold the whole-book
view, and the Showrunner is the only role that does by construction. Splitting
arbitration to a fourth party would require rebuilding that view somewhere else.

## 3.2 Claude — **The Author & Document Custodian**

> Renamed from "Document Authority" on Showrunner review. *Authority* conflated
> write permission with truth ownership. **The repository is the authority;
> roles hold permissions over it.** That matches this system's own thesis (§1)
> and is not a cosmetic change — see §5.4.

Owns: long-form drafting, all manuscript text, document maintenance, continuity
bookkeeping, line and copy editing.

Writes and owns:
`manuscript/`, `CONTINUITY.md`, `STYLE_SHEET.md`, `characters/`, `world/`,
`locations/`, `TIMELINE.md`, `REVISION_LOG.md`

Specific duties:
- Draft every scene from its context package. Never from memory of the book.
- **Maintain the Continuity Memory.** After revision and **before the gate**,
  extract every new concrete fact as a **CANON CANDIDATE**. Candidates are
  proposals, not canon. Gemini audits extraction completeness at the gate, and
  approved candidates mutate the authoritative ledger **only during a successful
  commit transaction** (§4.10.2). This is the highest-value repetitive task in
  the system and it is a documentation task — but recording is not deciding.
- Own voice. The Style Sheet is Claude's instrument and Claude is accountable for
  the book sounding like one person wrote it.
- Execute revisions at every level (§27) and propagate changes into affected docs.
- Assemble the final manuscript via the boundary-rule assembler (§18.5). No hand
  assembly, ever.
- Refuse to invent canon. If a scene needs a fact that does not exist, Claude
  raises a **Canon Request** to the Showrunner rather than making it up.

**Canon has three separate operations.** Conflating them was an ambiguity in
v0.1:

| Operation | Who | Note |
|---|---|---|
| **Canon Proposal** | Any authorized worker, including Claude mid-draft | A proposal is not canon |
| **Canon Approval** | ChatGPT, unless an approved rule already determines it, or it escalates to the user | The only step that creates canon |
| **Canon Recording** | Claude, after approval | Writing it down is not deciding it |
| **Canon Audit** | Gemini | Independently checks recorded state against approved manuscript and controlling decisions |

**A manuscript fact does not become canon merely because Claude typed it.**
Drafted invention enters as a **canon candidate** in the handoff and is ruled on
(§30.4); it enters authoritative continuity only after approval and successful
commit.

The fourth stage was added on Showrunner review and closes a real gap: recording
and deciding are different acts performed by different roles, and nothing
otherwise verified that what was recorded matched what was approved.

**Moved from the suggested division:** the master prompt floated continuity
*review* for Claude. I've split it — Claude **records** continuity, Gemini
**audits** it. The recorder must not be the auditor, or errors introduced during
recording become invisible. This is the separation-of-powers rule applied to the
most failure-prone document in the system.

## 3.3 Gemini — **The Auditor & Red Team**

Owns: research, fact-checking, adversarial review, contradiction hunting,
independent creative alternatives.

Writes and owns:
`research/`, `audits/`, `ISSUES.md`

Writes nothing into the manuscript or the bibles. Ever. Gemini's output is
**findings**, and findings become changes only when the Showrunner rules or the
Author implements.

Specific duties:
- **Adversarial continuity audit.** Given a chapter plus the continuity extract,
  find every contradiction. Instructed to assume errors exist and hunt them —
  neutral framing measurably under-finds, and an auditor told "check whether this
  is fine" will tend to find that it is fine.
- Research: period detail, technical accuracy, procedure, geography, culture.
  Everything researched lands in `research/` with sources.
- **Independent alternatives — MANDATORY, selective (§4.8.4).** On qualifying
  forks Gemini generates options *without seeing Claude's or ChatGPT's proposal
  first*. Blind generation is the whole point; showing it the existing proposal
  converts an independent mind into an agreeable one. "Selective" means
  criteria-triggered, not discretionary — see §4.8.4 for the trigger list.
- Reader-experience critique: pacing drag, confusion, predictability, emotional
  flatness, unearned turns.
- Hunt abandoned threads and missing setups by register-diff, not vibes.

**Moved from the suggested division:** Gemini gets *blind* alternative generation
as a formal duty, not an optional one. This is the system's only defense against
three models converging on the first idea anyone proposed.

## 3.4 Authority table

| Domain | Decides | Writes | Audits |
|---|---|---|---|
| Premise, structure, plot | ChatGPT | ChatGPT | Gemini |
| Prose text | Claude | Claude | Gemini |
| Voice & style | Claude | Claude | Gemini |
| Canon facts | ChatGPT | Claude (records) | Gemini |
| Continuity ledger | — | Claude | Gemini |
| Research & fact | Gemini | Gemini | ChatGPT |
| Conflict resolution | ChatGPT | ChatGPT | — |
| Final manuscript build | — | Claude (script) | Gemini (spot) |

## 3.5 Prose Objections — RULED, ADOPTED

The Author may raise an objection but has **no unilateral authority to alter
structure or canon**. Fixed format:

```
PROSE_OBJECTION
Beat/Requirement:
Observed problem:
Why it fails in execution:
Minimal proposed change:
Downstream effect:
Can current scene still be completed? yes/no
```

Showrunner rules exactly one: `ACCEPT` / `MODIFY` / `REJECT` / `REPLAN`.

> **A Prose Objection is a proposal, not authority to deviate.** Filing one does
> not license writing something other than the approved beat. The Author drafts
> to the ruling, including when the ruling is `REJECT`.

Rejected objections are logged in the Decision Log only when materially useful;
trivial objections do not earn permanent entries.

**Counting rule — RULED (DEC-002).** Trivial objections are not individually
logged, but they **are counted per chapter.** At five or more in one chapter:

> **S3 — `BEAT_MAP_FRICTION`**

This is a diagnostic against the **planning layer**, not against the Author or
the prose. It triggers Showrunner review of the chapter's beat-map granularity.
It does **not** automatically require replanning and does **not** block the
chapter gate.

Repeated small objections are signal: they usually mean the chapter was
over-specified at planning. Discarding them individually discards the pattern,
which is not recoverable any other way.

---

# 4. AI COMMUNICATION WORKFLOW

## 4.1 The Job Packet

Every dispatch to a model is a **Job Packet** with fixed structure:

```yaml
job_id: CH07-S03-DRAFT-v1        # immutable; returned artifact must carry it
stage: DRAFT
assigned_to: claude
dispatched_at: 2026-08-12T14:02:11Z
inputs:                          # VERSION-LOCKED — not just file names
  blueprint:            BLUEPRINT@v8
  chapter_card:         CH07-CARD@v3
  beat_map:             CH07-BEATS@v2
  continuity_snapshot:  CONT@commit-a821d3
  style_sheet:          STYLE@v4
task: "Draft scene 3 of chapter 7 from the beat map below."
deliverable: 04_CHAPTERS/ch07/scenes/s03.md
constraints:
  - "Boundary rule enforced: prose inside markers, all else outside."
  - "Word target 1400-1800."
  - "No new canon. Raise a Canon Request if you need a fact that isn't here."
context_package: [assembled per §24]
return_format: [handoff format per §4.3]
```

Nothing is dispatched conversationally. The packet is the interface.

**Version locking.** Inputs are identified by version, not by name. A job whose
controlling input changed after dispatch returns as `STALE_JOB`: its output
cannot be approved until it is rebased on current inputs or the staleness is
explicitly accepted with logged reasoning. Without this, a response arriving
after its context moved will quietly overwrite work built on newer information —
and the overwrite looks like ordinary progress.

**Idempotency.** `job_id` is immutable and every returned artifact carries it. A
second delivery of an already-committed job is **ignored or quarantined, never
re-applied.** This is not theoretical: the relay layer between three models
duplicates and reorders messages in practice, and duplicate application of a
committed revision is silent corruption.

## 4.2 The strict manuscript boundary rule (governing law)

```
}-----< Start >-----{
   ...everything here IS in the book...
}-----< finish >-----{
   ...everything here is NOT in the book...
```

**Position decides. Content is never interpreted.** Prose outside the markers is
cut. A note inside the markers is printed exactly as written. No model, at any
stage, may reason about whether something "seems like" book content.

Consequences that are rules, not exceptions:
- Never type anything inside the markers you would not publish.
- Markers sit alone on their own line, are never nested, and are always matched.
- Markers never appear in the final book.
- Final assembly is mechanical only (§18.4).

This rule binds writing, editing, revision, transfer, storage, retrieval, and
assembly, for all three models.

## 4.3 Handoff format

```
[TO: <destination>]

}-----< Start >-----{
<prose only>
}-----< finish >-----{

JOB_ID:            <immutable; must match the dispatched packet>
BASE_VERSION:      <repository state this work was built on>
OUTPUT_VERSION:    <new version produced>
TO: <role>         FROM: <role>
CANON REQUESTS:    <facts needed but not supplied, or "none">
CANON CANDIDATES:  <facts this draft introduces — proposals, not canon>
PROSE OBJECTIONS:  <PROSE_OBJECTION blocks, or "none">
CONFIDENCE:        <high|medium|low> on <what>
RESPONSE REQUIRED: <yes/no + recipient>
NOTES: <...>
```

Field names match Protocol v2 §4 exactly. `CANON CANDIDATES` replaced
`CANON CHANGES` — the old name implied the change had already occurred, which is
precisely the promotion-by-typing the canon model exists to prevent.

Prose block first, always. A truncated handoff then loses metadata rather than
manuscript — fail-safe by ordering.

## 4.4 Disagreement protocol

Triggered when any model's output contradicts another's, or Gemini files a
Severity-1 or Severity-2 issue.

1. **State positions.** Each model's position recorded verbatim, no summarizing
   by the opponent.
2. **Steelman.** Each model states the strongest version of the *other's*
   position. If a model cannot, it does not understand the disagreement yet and
   the step repeats.
3. **Test.** Where possible the disagreement is resolved against evidence — the
   text, the ledger, the timeline — not against preference.
4. **Rule.** ChatGPT decides. Reasoning is stated.
5. **Log.** `DECISION_LOG.md` entry, including the rejected position.
6. **Propagate.** Claude updates every affected document.

**Never** resolve by averaging, by splitting the difference, or by the loudest
confidence. Recording the rejected position is not bureaucracy — it is what stops
the team from reopening the same argument in chapter 19.

## 4.5 Anti-sycophancy rules

- Reviews may not open with praise. Findings first.
- A review returning zero findings must state what it checked and why each check
  passed. Empty reviews are re-run once with a sharper prompt.
- Gemini never sees "Claude thinks X" before forming its own view on a fork.
- Confidence must be declared. "High confidence, wrong" is a loggable defect;
  "low confidence, flagged" is correct behavior.

## 4.6 Routing protocol

Relay turns are a hard budget. In Manual Mode every message costs the user an
action; in Automated Mode it costs a call. Routing is therefore explicit.

**Every response begins with exactly one routing tag on its first line:**

| Tag | Destination |
|---|---|
| `[TO: ALL]` | Both other models |
| `[TO: CHATGPT]` / `[TO: CLAUDE]` / `[TO: GEMINI]` | That model only |
| `[TO: USER]` | The human operator only |
| `[TO: NONE]` | Nothing is relayed |

An untagged response defaults to `[TO: USER]`.

**Rules:**
1. One tag. First line. Never mid-message, never two.
2. Route narrowly. `[TO: ALL]` is for decisions that bind everyone —
   arbitration rulings, canon changes, protocol changes, gate failures.
   Findings for one owner go to that owner.
3. **No acknowledgment-only messages.** "Understood" costs a relay turn and
   returns nothing. Acknowledge by acting, or by attaching acknowledgment to a
   message that carries substance.
4. Batch. One message with four questions beats four messages.
5. Every relayed message states what response it needs, or states that it needs
   none. A message that leaves the recipient guessing whether to reply burns two
   turns to learn one thing.
6. The routing tag lives **outside** the boundary markers and never reaches the
   manuscript (§4.2).

**Interaction with the Job Packet (§4.1):** in Automated Mode the Orchestrator
sets routing from the job definition and models do not choose it. The tag
protocol governs Manual Mode and any model-initiated message in either mode.

## 4.7 Stall handling and provisional defaults

The system must not block on a silent arbiter. A question that is asked twice
without a ruling is a stall, and stalls are more expensive than wrong answers,
because a wrong answer is visible and reversible while a stall is neither.

But the v0.2 form of this rule was too broad, and the Showrunner was right to
refuse it. "A provisional decision is fully binding on downstream work" lets a
missing response manufacture expensive downstream work from a weak assumption.
**Silence may stop small decisions from blocking production. Silence may not
manufacture high-authority canon.**

**Rule:** if an AI-Decidable question receives no ruling after two requests, the
proposing model classifies it and acts by class.

### Provisional classes

| Class | Scope | Behavior on silence |
|---|---|---|
| **P1 — Low impact** | Local, cheap to reverse, no downstream propagation | Adopt and proceed normally |
| **P2 — Reversible** | Real downstream effect but bounded reversal cost | Adopt and proceed, but **every downstream output is flagged provisional** and inherits the flag until the ruling lands |
| **P3 — High impact** | See list below | **Cannot auto-adopt.** Production halts on this path; requires the owning arbiter or user escalation. An attempt to auto-adopt is a `PROCESS_VIOLATION`, blocked immediately (§29); a P3 provisional actually created, or inherited downstream, is **S0** |

**P3 by definition** — anything affecting: premise · **high-impact canon
decisions or canon-system architecture** · major character fate · ending ·
authority rules · structural chapter changes.

**Plus the governing catch-all:** any decision with **HIGH reversal cost or
expensive downstream propagation** is P3 regardless of whether it matches a named
example. The named list is illustrative, not exhaustive — without the catch-all a
high-impact decision could escape P3 by not resembling anything on it.

> **Silence may unblock low-risk work. Silence may not manufacture
> high-authority canon or architecture.**

A provisional decision at any class:
- Is logged in `DECISION_LOG.md` with `status: provisional`, its class, and the
  reason (`no ruling after 2 requests`).
- Records `reversal_cost`.
- Is overturned by a later ruling from the owning role at any time, with normal
  propagation (§27).

### Self-correction

**My own adoption of DEC-003 under the v0.2 rule was improper.** It was a P3
decision — it altered authority rules, `reversal_cost: HIGH` — and I auto-adopted
it after two unanswered requests. It happened to be ruled correct afterward,
which is luck, not process. Under the corrected rule it would have halted that
path and escalated. The rule change stands as written and DEC-003's validity now
rests on the explicit ruling, not on my provisional adoption.

This is the failure mode the class system exists to prevent, and it occurred in
the first live use of the rule.

**Escalation to the user requires justification.** Any model routing a question
to the user must state which §32.1 class it falls in and why the team cannot
resolve it. A question that is AI-Decidable and sent upward anyway is a defect
and gets returned to the sender.

**Anti-pattern:** deflecting a decision to the user is the cheapest way for a
model to avoid being wrong. It is also the fastest way for a system designed
around minimal user involvement to fail at its central purpose. Cost the user's
attention like a scarce resource, because it is the scarcest one here.

## 4.8 Non-waivable protocol requirements

Elevated from advisory to mandatory by Showrunner ruling. These four cannot be
skipped for schedule, cost, or convenience. A build that omits any of them is not
this system.

### 4.8.1 Two-axis authority model
Descriptive and prescriptive facts rank on separate ladders (§23). Collisions
raise `AUTHORITY_CONFLICT` and follow the §23.3 procedure. No inference-based
resolution, ever.

### 4.8.2 AUTHORITY_CONFLICT behavior
The §23.3 procedure is fixed: HALT → REPORT → CONFIRM → RULE → PROPAGATE → LOG.
An open AUTHORITY_CONFLICT blocks every gate on the affected chapter. §4.7
provisional defaults do **not** apply — an S1 contradiction may not be defaulted.

### 4.8.3 Independent continuity auditing
Claude records continuity; **Gemini audits it.** The recorder may never audit its
own records, or errors introduced during recording become structurally invisible.

Operational consequence: **a chapter cannot reach APPROVED without an audit of
record.** If Gemini is unavailable, the chapter is drafted and held at
`PENDING_AUDIT`. It does not pass.

**The mandatory audit is not routable-around.** Work that does not depend on the
audit gate proceeds normally; **nothing requiring independent audit may be
represented as approved until that audit occurs.** `PENDING_AUDIT` is the
designed degraded state and is correct behavior — approval without the audit is
the defect. This matters most in Manual Mode, where the
temptation to skip the third window is strongest and the cost is invisible until
chapter 20.

### 4.8.4 Selective blind-alternative generation
Mandatory and criteria-triggered, not discretionary. Gemini generates
alternatives **before seeing any other model's proposal** when *any* of these
hold:

1. The decision alters a Blueprint core field — premise, story question,
   protagonist want/need, midpoint, climax, resolution, ending state.
2. The decision affects **3 or more chapters**.
3. The decision's `reversal_cost` is HIGH.
4. It concerns a thread or setup marked `importance: major`.
5. Only one proposal exists and no alternative is on record.

**Not triggered** by scene-level craft, character naming, minor cast, dialogue,
chapter titles, sensory detail, or prose choices within the Style Sheet. Those
are AI-Decidable (§32.1) and blind generation on them is pure overhead.

**Cap: 2 alternatives, one round.** Blind generation exists to prevent premature
convergence, not to multiply options indefinitely.

## 4.9 Unverified claims

§4.7 governs stalled *decisions*. It cannot govern stalled *facts* — a
provisional default on a question of truth is just a guess with paperwork.

**Rule:** a `[VERIFY]` item unanswered after two requests becomes a logged
`ASSUMPTION`, and the design is refactored so that **no gate depends on it.**
Where dependency cannot be removed, the dependent section is marked `BLOCKED` and
scoped out of Phase 1 rather than built on an unverified claim.

Current assumptions, each with its graceful-degradation default:

| Item | Assumption adopted | Degradation |
|---|---|---|
| §5.3 retrieval | Structured ID lookup (§24.3) | **May optimize §24.3; does not block it.** Structured ID lookup remains the correctness-preserving default unless verification demonstrates a material benefit from vector retrieval |
| §12 imagery | Character identity consistency across generations is **unreliable** | Turnarounds are canonical **as text**; generated imagery is decorative and never a source of truth |
| §28 repo size | Binary images stored **outside** the repo with pointers | Text-only repos are trivially small; the pointer scheme is correct either way |
| §17 timeline | Arithmetic checks are necessary but not sufficient | Non-linear time, unreliable narration, and relativistic settings are flagged for **manual** review rather than auto-passed |

Each default is chosen so that being wrong costs an optimization, never a
correctness failure. That is the test any assumption must pass before it is
allowed to stand in for verification.

## 4.10 Execution engineering principles

Four principles added on Showrunner review. Without them Atelier is a writing
protocol; with them it can survive autonomous execution.

### 4.10.1 Version-locked jobs
Every job identifies its inputs by version (§4.1). Any controlling input that
changes after dispatch marks the result `STALE_JOB`, unapprovable until rebased
or explicitly accepted.

### 4.10.2 Transactional propagation
A revision touching manuscript + continuity + timeline + registers is **one
transaction**. States: `OPEN → VALIDATED → COMMITTED`. Failure mid-propagation
sets `ROLLBACK_REQUIRED` and nothing becomes authoritative.

This closes the failure the spec warns about everywhere else: text updated,
memory not updated. A half-propagated revision is worse than no revision,
because the book now contradicts its own records while appearing fixed.

**Implementation:** git-native rather than a bespoke transaction manager.
Propagation happens on a working branch; the merge to trunk *is* the commit.
Rollback is `git branch -D`. This is a deliberate simplification of the
Showrunner's proposal — same semantics, no new machinery, and the audit trail
comes free.

### 4.10.3 Idempotent execution
Immutable `job_id` on every packet and every returned artifact. Re-delivery of a
committed job is ignored or quarantined, never re-applied.

### 4.10.4 Authority separated from file ownership
See §5.4. Ownership is *write permission*. It is not *truth ownership*.

## 4.11 Crash and resume

`STATE.md` names the current node. That is insufficient on its own: it does not
say what happens when an interruption lands mid-job. Every job carries an
explicit lifecycle:

```
DISPATCHED → RESPONSE_RECEIVED → VALIDATION_PENDING → COMMIT_PENDING → COMMITTED
```

**On restart, the Orchestrator resumes from the last COMMITTED transition —
never from the last generated output.** Generated-but-uncommitted work is
re-validated from scratch or discarded. Trusting an uncommitted artifact after a
crash is how a system silently adopts output that never passed a gate.

## 4.12 The dependency graph

`affects:` arrays in front matter are useful but insufficient — they are
manually maintained and will drift. The system derives a real directed graph:

```
FACT-0418 → CHAR-marla → CH07-S03 → CH07 → ACT2 → MANUSCRIPT
```

Edges are derived from actual references (which facts a scene cites, which
entities a card names, which scenes a chapter contains), not from hand-written
lists. When a node changes, the system traverses downstream and marks every
reachable node `REEVALUATION_REQUIRED`.

Hand-maintained `affects` arrays remain as a **declaration of intent**, and a
divergence between declared and derived edges is itself a finding — it usually
means someone changed a document without understanding its reach.

### 4.12.1 Explicit ref evaluation — REQUIRED

*(Added v0.3.3 per audit finding F-02.)*

> **Every validation or read-side script whose result can affect a transaction
> must evaluate an explicit repository ref, and must default to `HEAD` — never
> implicitly to trunk.**

Applies at minimum to `build_depgraph.py`, `check_registers.py`, and
`resolve_facts.py`, and to any later validator operating on repository state.

```
build_depgraph.py --ref <branch|commit>     # defaults to HEAD
```

**Validation records the ref it evaluated.** A recorded ref that does not match
the branch being merged is **S0** (invalid state transition).

The dangerous case is not the false positive. During an L6/L7 structural revision
on a branch, a script reading trunk *misses* downstream propagation on exactly the
files the branch changed — and a structural revision is when downstream
propagation matters most. A silent miss there merges a revision whose downstream
chapters were never re-checked.

## 4.13 STALE_INSTRUCTION

**Distinct from `STALE_JOB`.** A job can be perfectly current while carrying an
instruction generated against an obsolete specification state. The message is
fresh; its premise is not.

> **Rule:** before applying any received revision request, compare it against the
> current authoritative version. If the requested change is already implemented,
> superseded, or conflicts with a later final ruling, record it as
> `STALE_INSTRUCTION` and **perform no mutation.** New, nonconflicting
> information in the same message is processed normally.

| | Stale in | Effect |
|---|---|---|
| `STALE_JOB` | Its **inputs** — context moved after dispatch | Output cannot commit; rebase or accept explicitly |
| `STALE_INSTRUCTION` | Its **premise** — written against an older spec | No mutation; log and continue |

The failure this prevents is subtle and expensive: obediently applying an older
correction set rolls the specification *backward*, and because each individual
instruction looks reasonable, the regression is invisible at the point it
happens. **Mixed messages are processed component-wise.** Genuinely new instructions are
preserved and applied; only stale portions are rejected or quarantined. A message
can be 90% stale and 10% new, and the 10% still matters — discarding the whole
message because most of it is obsolete loses real instructions.

### 4.13.1 Component boundaries and atomicity

*(Added v0.3.3 per audit finding F-03.)*

**A whole mixed instruction is never rejected solely because one component is
conditional.** But splitting has a hard rule:

> **Component boundaries may be created only from unambiguous structural
> divisions** — numbered or bulleted items, separately headed sections, or
> discrete structured command blocks.
>
> **A component containing a conditional, dependency, qualifier, or scoping
> clause is atomic.** It may be accepted, rejected, quarantined, or marked stale
> **as one unit**, but never subdivided.
>
> **Ambiguous component scope is quarantined individually** while independently
> separable components continue processing.

The failure this prevents: *"Revise Chapter 7, but only if Marla hasn't left the
workshop"* split heuristically can execute the action while dropping the
condition — converting a conditional instruction into an unconditional one, which
is worse than rejecting it outright. Atomicity keeps the condition and its action
in the same unit, making detachment structurally impossible rather than merely
discouraged.

**Lexical pre-check:** a component containing `if`, `unless`, `only when`,
`provided that`, `assuming`, or an equivalent qualifier is flagged
atomic-mandatory and cannot be split.

**Never regenerate a section solely because the relay delivered an older
correction set.**

---

# 5. DOCUMENT ARCHITECTURE

## 5.1 Repository layout

```
BOOK_PROJECT/
├── 00_CONTROL/
│   ├── STATE.md                  # where we are, what's next   [ChatGPT]
│   ├── PROTOCOL.md               # boundary rule + handoff law [Claude]
│   ├── DECISION_LOG.md           # major decisions + rejected  [ChatGPT]
│   ├── REVISION_LOG.md           # what changed, why           [Claude]
│   └── ISSUES.md                 # open defects                [Gemini]
├── 01_DESIGN/
│   ├── BLUEPRINT.md              # controlled source of truth  [ChatGPT]
│   ├── ROADMAP.md                # whole-book progression      [ChatGPT]
│   ├── STYLE_SHEET.md            # voice, mechanics, taboos    [Claude]
│   ├── OPEN_THREADS.md                                         [ChatGPT]
│   └── SETUP_PAYOFF.md                                         [ChatGPT]
├── 02_BIBLE/
│   ├── characters/<slug>.md      # one file per character      [Claude]
│   ├── turnarounds/<slug>.md     # visual consistency sheets   [Claude]
│   ├── locations/<slug>.md                                     [Claude]
│   ├── world/WORLD.md                                          [Claude]
│   ├── world/MAGIC.md            # if applicable               [Claude]
│   ├── world/TECHNOLOGY.md       # if applicable               [Claude]
│   └── TIMELINE.md                                             [Claude]
├── 03_MEMORY/
│   ├── CONTINUITY.md             # authoritative ledger; commit-only  [Claude]
│   ├── CANDIDATES.md             # proposals, pre-gate; cleared at commit [Claude]
│   └── STATE_SNAPSHOT.md         # story state at last approval [Claude]
├── 04_CHAPTERS/
│   └── ch07/
│       ├── CARD.md               # chapter card                [ChatGPT]
│       ├── ROADMAP.md            # chapter-level progression   [ChatGPT]
│       ├── beats.md              # scene/beat map              [ChatGPT]
│       └── scenes/s01.md ...     # drafted prose               [Claude]
├── 05_RESEARCH/                                                [Gemini]
├── 06_AUDITS/                                                  [Gemini]
├── 07_BUILD/
│   ├── manuscript.md             # assembled output
│   └── build_report.txt
└── 99_ARCHIVE/                   # superseded versions
```

**One writer per file.** Concurrent writes to a shared file across three models
with no locking is a corruption bug waiting to happen. Ownership is in brackets
above and is enforced, not advisory.

## 5.2 Universal front matter

Every document opens with:

```yaml
---
doc_id: CHAR-marla-vane
doc_type: character_profile
owner: claude
version: 7
last_updated: 2026-03-14
canon_status: approved        # draft | approved | superseded
supersedes: v6
affects: [CH03, CH07, CH11]
---
```

`affects` is what makes change propagation tractable: edit a document, and the
system immediately knows which chapters need reevaluation.

## 5.3 Document operations

Create, edit, save, retrieve, search, copy, delete, replace, version, organize,
archive — all satisfied by a plain filesystem plus git. Nothing here needs a
database.

- **Versioning:** git commit per approved gate. Human-readable diffs.
- **Archiving:** superseded documents move to `99_ARCHIVE/` with a tombstone
  pointer left behind. Nothing is deleted; deletion loses the reasoning.
- **Search:** ripgrep over markdown. **[VERIFY]** Gemini to confirm whether
  vector search over the bible measurably improves context assembly at
  100k+ words, or whether structured ID lookup is sufficient. My prior is that
  structured lookup wins because our retrieval targets are known by ID, not by
  fuzzy similarity — but I have not tested it.

## 5.4 Ownership is write permission, not truth ownership

A critical distinction added on Showrunner review.

| | Means | Held by |
|---|---|---|
| **Write authority** | Only this role may execute writes to the file | See brackets in §5.1 |
| **Decision authority** | This role determines what is true or intended | See §3.4 table |

These are deliberately different. Claude holds write authority over the
character, world, and location bibles — but the Showrunner holds decision
authority over canon. Claude writing a fact into a bible does **not** make it
canon; it records a canon decision that was already made.

Without this split, the Author would hold both the pen and the truth for most of
the repository, which silently defeats §2.3.

---

# 6. BOOK BLUEPRINT STRUCTURE

Created before any manuscript production. Owned by ChatGPT. Changes to an
approved Blueprint require a Decision Log entry.

```yaml
--- IDENTITY ---
working_title, genre, subgenre, audience, comp_titles
tone, style, narrative_perspective, tense, target_word_count, chapter_count

--- CORE ---
premise:            one paragraph
story_question:     the single question the reader wants answered
theme_primary:      stated as a tension, not a topic
                    ("loyalty vs. truth", not "loyalty")
theme_secondary
promise_to_reader:  what the opening implicitly guarantees the book delivers

--- CONFLICT ---
protagonist_want    (external, conscious, pursued)
protagonist_need    (internal, often unconscious, resisted)
antagonistic_force  (person, system, or condition)
central_conflict
stakes_external / stakes_internal / stakes_escalation_path

--- SHAPE ---
beginning_state     the world before
inciting_incident
first_turn          point of no return
midpoint            reversal or revelation that changes the game
low_point
final_escalation
climax
resolution
ending_state        the world after; must contrast with beginning_state

--- CAST ---
character_arcs:     per major character — from → through → to

--- WORLD ---
world_overview, hard_rules[], soft_rules[]

--- MYSTERY & CRAFT ---
major_mysteries[], reveals[] (with target chapters)
foreshadowing_requirements[]
tonal_boundaries:   what this book will never do
```

`promise_to_reader`, `protagonist_want` vs `need`, and `tonal_boundaries` are
additions to the master prompt's list. Each earns its place: the first is the
commonest cause of an unsatisfying ending, the second is the engine of character
arc, and the third prevents genre drift over long production runs.

---

# 7. BOOK ROADMAP STRUCTURE

The Roadmap answers, at any moment: **where are we, how did we get here, where
are we going?**

Eight phases: Beginning → Development → Escalation → Midpoint → Consequences →
Final Escalation → Climax → Resolution.

Represented as a table with one row per chapter and these tracked columns:

| Track | What it records |
|---|---|
| Plot | External events advancing the story question |
| Character | Internal position of each POV character |
| Relationship | State of each significant pairing |
| World | What the reader has learned about the world |
| Mystery | What's open, what's closed, what's suspected |
| Tension | 1–10 rating — the pacing curve, made visible |
| Reader knows | Information the reader holds |
| Reader doesn't | Information deliberately withheld |
| Setup/Payoff | IDs planted or cashed |

The **reader knows / reader doesn't** pair is the most underrated part of this
structure. Dramatic irony, suspense, and surprise are all functions of the gap
between character knowledge and reader knowledge, and no other document tracks
that gap. Without it, a system will accidentally spoil its own reveals and never
notice.

The **Tension column** is the only place whole-book pacing is visible. Flat runs
of 4-4-4-5-4 across five chapters are a structural defect detectable at a glance
and invisible from inside any single chapter.

---

# 8. CHAPTER OUTLINE — THE CHAPTER CARD

One card per chapter, all cards complete before uncontrolled generation begins.

```yaml
chapter: 07
title: "The Long Way Down"
phase: ESCALATION
pov: Marla Vane
word_target: 4200

purpose:              why this chapter exists; cut it and what breaks?
starting_situation:
characters_present:   [ids]
locations:            [ids]
timeframe:            in-world date/time, duration

objectives:           per character, what they want in this chapter
conflict:
major_events:         []
information_introduced:
information_revealed_to_reader:
information_withheld:
character_development:
relationship_changes:
worldbuilding_introduced:

foreshadowing:        [setup ids planted]
setup:                [ids]
payoff:               [ids cashed]
turning_point:
ending_condition:     required state at chapter close
hook:                 pull into next chapter

continuity_requirements: [facts that MUST hold]
open_threads_touched:    [ids]
```

The `purpose` field is a gate, not decoration. If no one can answer "cut this
chapter and what breaks?", the chapter does not get written.

---

# 9. CHAPTER ROADMAP STRUCTURE

Each chapter carries its own progression map:

```
Chapter Start → Scene 1 → Development → Scene 2 → Complication
              → Scene 3 → Turning Point → Chapter Ending → Hook
```

Recorded per chapter: entry state, scene sequence with one-line function each,
the turn, exit state, and the delta between entry and exit.

**Rule: if entry state equals exit state, the chapter is inert.** Something must
change — situation, knowledge, relationship, or resolve. This single check catches
the most common structural failure in AI-generated long fiction, which is
chapters that are pleasant, competent, and do nothing.

---

# 10. SCENE AND BEAT SYSTEM

## 10.1 Scene Card

```yaml
scene_id: CH07-S03
pov, location, in_world_time, duration, characters_present
emotional_state_start
objective:      what POV wants in this scene
obstacle:
conflict:
dialogue_purpose:      what dialogue must accomplish
information_exchanged: who learns what
physical_action:
discovery:
decision:
change:         what is different at scene end
emotional_state_end
continuity_updates: [facts this scene creates]
setup_payoff:   [ids]
transition:     how we get to the next scene
word_target:
```

## 10.2 Beats

Beats are 3–7 per scene, one line each, describing motion — not prose, not
dialogue lines. Beats say *what happens*; the Author decides *how*.

## 10.3 The anti-suffocation rule

The master prompt warns against over-planning, and it is right to. The operating
rule:

> **Plan what must be true. Leave open how it feels.**

Planning owns: who, where, when, what changes, what is learned, what is promised.
Drafting owns: sentence rhythm, imagery, dialogue texture, silence, subtext,
what the character notices.

A beat map that specifies a metaphor has overreached. A beat map that leaves the
scene's outcome undecided has underreached.

---

# 11. CHARACTER SYSTEM

One file per significant character. Two zones — **Static** rarely changes,
**Dynamic** updates after every approved chapter.

```yaml
--- STATIC ---
full_name, aliases, age, dob
physical: height, build, hair, eyes, skin, distinguishing_marks
appearance_notes, clothing_tendencies
voice: pitch, pace, accent
speech_patterns: verbal_tics[], vocabulary_register, profanity_use,
                 sentence_length, what_they_never_say
personality, strengths[], weaknesses[], skills[], beliefs[]
motivation, desire (want), need, fears[], secrets[]
backstory
internal_conflict, external_conflict
arc: from → through → to
signature_possessions[]

--- DYNAMIC (as of chapter N) ---
current_location
current_condition:       physical, including injuries
current_emotional_state
carrying[]:              objects on person
knows[]:                 facts, with chapter learned
believes_incorrectly[]:  ← the most valuable field in this document
relationships:           per character — status, tension, last interaction
arc_position:            where on the from→to path
```

**`believes_incorrectly` deserves special emphasis.** Dramatic irony, betrayal,
and misunderstanding all live in the gap between what a character knows and what
is true. Models default to characters knowing whatever the narrative knows, which
flattens every scene that depends on that gap. Tracking wrong beliefs explicitly
is what allows a character to walk into a room and be wrong on purpose.

**`what_they_never_say`** is a voice-preservation device. Negative constraints
hold character voice across a long book far better than positive descriptions do
— "never uses contractions when frightened" survives 300 pages; "speaks
formally" dissolves by chapter 5.

---

# 12. CHARACTER TURNAROUND SYSTEM

Purpose: visual and behavioral consistency, and reference imagery where image
generation is available.

```yaml
character_id
front / side / back:      described views
height_build, hair (cut, color, texture, how worn)
eyes, skin, distinguishing_features[]
default_clothing, alternate_outfits[], equipment[], accessories[]
expressions: neutral, angry, afraid, amused, lying
body_language, movement_style, posture
physical_changes_by_chapter:
  - ch01: baseline
  - ch07: left hand bandaged
  - ch14: hair cut short, scar across jaw
image_prompt_base:   locked descriptive string for generation
reference_images[]:  paths + chapter validity range
```

`physical_changes_by_chapter` is the field that prevents the classic long-book
failure where an injury inflicted in chapter 7 has vanished by chapter 9 without
healing.

**[VERIFY]** Gemini: confirm current image-generation capability for consistent
character identity across multiple generations — whether identity locking via
reference image is reliably available, and in which tools. My understanding is
that consistency across generations remains imperfect and prompt-only identity
locking drifts, but this is exactly the kind of fast-moving claim I should not be
trusted on. If consistency is unreliable, turnarounds remain text-only and the
imagery is decorative rather than canonical.

---

# 13. WORLDBUILDING SYSTEM

`world/WORLD.md`, structured in layers so context assembly can pull a slice
rather than the whole thing:

- **Physical:** geography, climate, regions, cities, landscapes, transportation
- **Political:** governments, laws, factions, organizations, power structure
- **Social:** cultures, customs, class, religion, languages, taboos
- **Economic:** currency, trade, resources, who has what and why
- **Historical:** timeline of prior events, conflicts, myths
- **Material:** important objects, artifacts, everyday texture

Every world fact carries `established_in: CHnn` or `established_in: PLAN`. A fact
established in the manuscript is harder to change than one that only exists in
planning, because a reader has already seen it (§23).

**Hard rules vs. soft rules.** Hard rules are inviolable and their violation is a
Severity-1 error. Soft rules are tendencies with exceptions, and the exceptions
must be logged when used. Ambiguity here is the root of most magic- and
tech-system failures — a rule that is neither firmly hard nor explicitly soft
becomes whatever the current scene needs.

---

# 14. LOCATION SYSTEM

One file per significant location. Locations gain state as the book proceeds —
this is what stops a burned building from being intact three chapters later.

```yaml
name, purpose, controlled_by, inhabitants[]
geography, layout, architecture, appearance
sensory: light, sound, smell, temperature, texture
atmosphere
important_objects[], entrances_exits[], nearby_locations[]
historical_significance
events_occurred_here: [chapter refs]
current_condition:    ← updated per chapter; damage persists
first_appearance: CHnn
```

The `sensory` block exists because returning to a location should feel like the
same place. Consistent sensory anchors — a specific smell, a particular quality
of light — do more for that recognition than repeated architectural description.

---

# 15. MAGIC SYSTEM

Instantiated only when the genre requires it.

```yaml
source:              where power comes from
who_can_use:         and how that's determined
how_learned:
hard_rules[]:        inviolable
abilities[]:         with specific effects and limits
limitations[]:
costs[]:             every use costs something — physical, temporal, moral
risks[]:
prohibited_uses[]:
power_progression:   how strength changes, and what gates it
countermeasures[]:   how magic is resisted or defeated
artifacts[]:
social_consequences: how magic shapes law, class, religion, economy
known_exceptions[]:  each with logged justification
```

**Enforcement:** every scene involving magic is checked against `hard_rules` and
`costs` before approval. A use with no cost is a Severity-1 error unless an
exception is logged.

The load-bearing entry is `costs`. Magic without cost is not a system but a
plot-hole generator, and models will reach for it precisely when the plot is
stuck — which is exactly when the constraint matters most.

---

# 16. TECHNOLOGY SYSTEM

Same shape as §15, adapted:

```yaml
tech_level, major_inventions[], devices[], weapons[]
transportation: with speeds and ranges  ← feeds timeline validation
communications:  with latency and range ← feeds "why not just call"
computing_ai, energy, medicine, manufacturing
capabilities[], limitations[]
availability:    who can get it
cost:
controlled_by:
societal_effects:
```

Two fields do disproportionate work. **Transportation speed** feeds the timeline
checker and makes impossible travel mechanically detectable. **Communication
latency and range** answers the question that quietly destroys the tension of a
great many plots: *why doesn't someone just call for help?* Answer it once, in the
bible, and every scene inherits the answer.

**Rule:** technology cannot gain a capability because the plot needs it. New
capabilities require a Decision Log entry and a Blueprint amendment.

---

# 17. TIMELINE SYSTEM

`TIMELINE.md` holds a master chronology in in-world time, keyed to chapters.

Tracked: absolute dates/times, character ages, travel durations, event durations,
historical events, simultaneous events, flashbacks (with frame markers), time
jumps, and active deadlines.

**Automated validation** — this is one of the highest-value scripts in the
system because these errors are mechanical, common, and invisible to prose review:

1. **Travel check** — distance ÷ transport speed vs. elapsed time.
2. **Simultaneity check** — no character in two places at one time.
3. **Age check** — ages consistent with dates and stated events.
4. **Deadline check** — declared deadlines still arithmetically live.
5. **Duration check** — stated durations match elapsed in-world time.
6. **Ordering check** — no effect precedes its cause.

Model prose review catches these badly; arithmetic catches them perfectly.

---

# 18. CONTINUITY MEMORY

The single most important document in the system.

## 18.1 Form

**Append-only.** Facts are never edited in place. A fact that becomes wrong is
superseded by a new entry that points back at it. This preserves the history of
what was true when, which is exactly what's needed to fix a contradiction
correctly rather than paper over it.

Append-only history is necessary but not sufficient — consumers need *the
current effective fact*, not every historical version. So each fact is a
structured record, and a deterministic resolver answers "what is true now?"
without asking a model to interpret history.

```yaml
fact_id:    FACT-0418
entity_id:  CHAR-marla
property:   injury.left_palm
value:      "burned, blistered, wrapped in a strip of her shirt"
valid_from: CH07-S03
valid_until: null            # or CHnn when superseded
supersedes: null
status:     active           # active | superseded | disputed | retracted
source:     04_CHAPTERS/ch07/scenes/s03.md
expires:    "~3 weeks in-world"
```

`status: disputed` exists for the window during an open AUTHORITY_CONFLICT — the
fact is neither trusted nor discarded while the Showrunner rules. `retracted`
covers facts removed by revision rather than superseded by events, which is a
different thing and must not be conflated: superseded means the story moved on,
retracted means it never happened.

**Resolver rule:** current truth for any `(entity_id, property)` is the single
record with `status: active` and `valid_until: null`. More than one match is a
data error (S0), not a judgment call.

## 18.2 Categories

INJURY · CLOTHING · OBJECT · OBJECT_LOCATION · CHARACTER_LOCATION ·
RELATIONSHIP · KNOWLEDGE · SECRET_REVEALED · PROMISE · DEATH · DAMAGE ·
ENVIRONMENT · MAGIC_USE · TECH_USE · TIME · QUESTION_OPEN

## 18.3 The expiry field

Facts with natural lifetimes carry `expires`. A blistered palm should not be
blistered in chapter 30. On expiry the fact is flagged for review rather than
auto-deleted — the system asks whether it healed, scarred, or worsened, and a
human-legible answer replaces the guess.

## 18.4 The Knowledge Matrix

Added on Showrunner review. §7 tracks reader knowledge and §11 tracks character
knowledge, but nothing linked them — which left information-leak detection as
prose interpretation. The matrix makes it deterministic.

```yaml
FACT-0121:
  truth:       "Jon's brother is alive"
  reader:      knows_from: CH09
  CHAR-marla:  knows_from: CH11
  CHAR-jon:    believes_opposite: through CH17
  CHAR-antagonist: knew_before: book_start
```

This gives the knowledge-violation audit something to compare against
mechanically. A scene in which Marla acts on FACT-0121 before CH11 is a
detectable S1, not a judgment call. It also makes dramatic irony *plannable*:
the gap between the reader's row and each character's row is the raw material
of suspense, and it is now visible rather than implied.

## 18.5 Update discipline

Extraction is a **dedicated job run after revision**, by Claude — never a side
effect of drafting. Extraction while drafting is unreliable because the model is
attending to prose and the extraction quietly degrades.

The sequence is fixed:

1. **Dedicated extraction after revision** — Claude produces facts as
   **candidates only.** Nothing is written to the authoritative ledger.
2. **Gemini audits extraction completeness at the gate** — did the extraction
   miss facts the scene actually establishes? Incompleteness is a gate failure,
   not later cleanup.
3. **Authoritative ledger mutation occurs only during a successful commit
   transaction.** If the transaction fails the ledger is untouched and the last
   committed state remains authoritative (§4.10.2).

This closes the window in which an approved scene could exist without its
canonical state represented, and prevents a draft from promoting its own
invention by the act of recording it.

### 18.5.1 Candidates are stored separately from the authoritative ledger

Candidates **never** touch `CONTINUITY.md`. They are written to a separate file
and remain there until a successful commit transaction moves them:

```
03_MEMORY/
├── CONTINUITY.md        ← authoritative. Mutated ONLY at commit/merge.
└── CANDIDATES.md        ← proposals. Written at extraction, cleared at commit.
```

Physical separation, not a status flag inside one file. A flag would leave
proposals and canon in the same document, one careless read away from being
treated alike — and the resolver in §18.1 would have to filter rather than simply
read. Two files make "is this canon?" answerable by location.

**Both files live on the transaction branch from `BRANCH` onward** (§25, F-01).
Trunk is never written during extraction or gate evaluation; `git status` on
trunk must be clean at every gate evaluation, and any modification to
`CANDIDATES.md` on trunk is **S0**.

On successful commit, approved candidates are appended to `CONTINUITY.md` and
removed from `CANDIDATES.md`. On rollback, the branch is discarded — both files
revert together and `CONTINUITY.md` is untouched, which is the whole point.

## 18.6 Manuscript assembly

Kept separate from update discipline: extraction is a **judgment** task about
what a scene established; assembly is a **mechanical** task about what sits
between markers. Merging them invites the assembler to be treated as a continuity
authority, which it is not.

Approved repository content plus the boundary rule determine manuscript
membership. `assemble_manuscript.py` mechanically enforces that rule and is the
only authorized final-build path. **It does not itself define truth.** Never
assemble by hand.

---

# 19. STORY STATE

`STATE_SNAPSHOT.md` — the story's condition at the last approved point, so no
model ever rereads the manuscript to find out where things stand.

```yaml
as_of: CH07 S03 approved 2026-03-14
in_world_datetime:
chapter_position: 7 of 32
phase: ESCALATION

characters:
  marla_vane: {location, physical, emotional, carrying[], knows_recently[],
               believes_wrongly[], arc_position}
  ...
active_threads[]:      with status
imminent_deadlines[]:
reader_knows[]:
reader_suspects[]:
reader_doesnt_know[]:
last_scene_ending:     the final 2-3 sentences verbatim
next_scene_opens:      required starting condition
tension_level: 7
```

`last_scene_ending` verbatim is small and disproportionately valuable: scene-to-
scene transitions are where seams show most, and giving the Author the literal
last sentences produces continuity of rhythm that a summary cannot.

---

# 20. OPEN THREAD REGISTER

```yaml
thread_id: THR-011
thread:            "Who sent the second letter?"
origin:            CH02 S04
characters[]:
importance:        major | moderate | minor
current_status:    open | developing | resolving | closed
planned_development:
expected_payoff:
target_chapter:    CH24
completed:         false
last_advanced:     CH07     ← staleness detector
```

**Abandonment detection:** any major thread not advanced in 5 chapters, or any
thread whose `target_chapter` has passed while `completed: false`, is
automatically raised as a Severity-2 issue. Threads do not die because someone
decided to drop them; they die because everyone forgot. Mechanical detection is
the only reliable fix.

---

# 21. SETUP / PAYOFF REGISTER

```yaml
id: SP-034
setup:          "Brass lighter engraved V.R. — Marla's father's initials
                 are J.V., not V.R."
planted:        CH07 S03
subtlety:       background | noticeable | flagged
payoff_planned: "Lighter belonged to the man who killed him"
payoff_target:  CH19
payoff_actual:  —
status:         planted | paid | orphaned | cut
```

Two automated checks:
- **Orphan check:** planted, target chapter passed, unpaid → Severity-2.
- **Unearned payoff check:** payoff appears with no `planted` entry → Severity-2,
  unless flagged as an intentional cold surprise.

**Spacing is a heuristic, not system law.** Revised on Showrunner review — the
original three-chapter rule was too rigid. Micro-setups can pay within a scene, a
chapter-one promise can land in chapter two, and some genres run deliberately
tight setup/payoff rhythms.

The rule: **spacing is evaluated relative to narrative weight.** Major setups
should ordinarily have enough narrative distance that the payoff does not feel
mechanically immediate. The `subtlety` field gives the check something to bite
on — `background` setups warrant more distance, `flagged` setups can pay fast
because the reader is already holding them consciously.

---

# 22. DECISION LOG

```yaml
decision_id: DEC-023
date, stage
question:            "Does Marla learn the truth at midpoint or at CH24?"
alternatives:
  A: {proposal, source: chatgpt, reasoning}
  B: {proposal, source: gemini, reasoning}
  C: {synthesis, source: chatgpt}
positions:           each model's stated view, verbatim
selected: C
reasoning:           why, in full
rejected_because:    per alternative  ← prevents relitigation
documents_affected:  [BLUEPRINT, ROADMAP, CH12-CH24 cards, THR-011]
downstream_impact:   which chapters need reevaluation
version: BLUEPRINT v4 → v5
```

Recording `rejected_because` is what makes the log load-bearing rather than
ceremonial. Without it, a later model rediscovers the rejected option, finds it
appealing, and reopens a settled question at cost.

---

# 23. TWO-AXIS AUTHORITY MODEL

The master prompt proposed: approved story state → continuity memory → current
chapter info → blueprint → older planning. **I think this is subtly wrong and
want to argue the point**, because it's the rule everything else inherits.

## 23.1 The flaw

That ordering treats all facts as one kind. They are two kinds:

- **Established Reality** — what the reader has already read. Authoritative
  until changed by an approved revision transaction (§27, §4.10.2).
- **Intent** — what is planned to happen. Fully negotiable until it becomes
  established.

> **Correction from v0.1.** I originally wrote that approved manuscript text is
> "immutable in place." That was wrong and the Showrunner caught it: it makes
> revision levels L4–L8 logically impossible. The manuscript is not immutable —
> it is **authoritative until revised through an approved transaction.** The
> distinction that matters is not permanence but that established reality cannot
> be changed *silently* or *incidentally*; it changes only through a transaction
> that propagates completely or not at all.

A flat hierarchy lets a drafted scene silently overwrite the Blueprint's design
simply by being more recent. That is how a book wanders off its own plan one
convenient sentence at a time, with every individual step looking reasonable.

## 23.2 The two axes

Renamed from "hierarchy" on Showrunner ruling — there are two axes, and neither
outranks the other. Within each axis there is an order.

**ESTABLISHED REALITY AUTHORITY** — what is true in the story:

```
1. Approved manuscript text          (authoritative until revised by transaction)
2. Effective Continuity Ledger state (resolved per §18.1; if it disagrees with
                                      #1, IT is wrong)
3. Story State                       (derived from #2)
4. Bible / current-state documents   (derived from #2, #3)
5. Unapproved drafts                 (no authority)
```

**INTENT AUTHORITY** — what should happen:

```
1. Approved Blueprint
2. Latest controlling Decision Log ruling
3. Roadmap
4. Chapter Card
5. Scene/Beat Map
6. Superseded planning               (no authority)
```

Note the asymmetry that makes this work: within Established Reality, everything
below #1 is *derived* and therefore correctable by regeneration. Within Intent,
each level is *authored* and correctable only by decision.

## 23.3 AUTHORITY_CONFLICT — the collision procedure

When an approved descriptive fact contradicts an approved prescriptive document,
**neither wins automatically.** This is the error type `AUTHORITY_CONFLICT`,
severity S1, and it has a fixed procedure. It is never resolved by inference,
recency, or preference.

**Procedure:**

1. **HALT.** The affected chapter stops advancing. It cannot pass any gate while
   an AUTHORITY_CONFLICT is open.
2. **REPORT.** Claude files a Conflict Report: the descriptive fact with its
   manuscript citation, the prescriptive claim with its document citation, both
   version numbers, and the list of affected chapters.
3. **CONFIRM.** Gemini independently verifies this is a real conflict and not a
   misreading. Roughly a third of apparent conflicts are misreads, and resolving
   a misread does real damage to a correct document.
4. **RULE.** ChatGPT chooses exactly one, with reasoning:
   - `RETCON_PLAN` — the drafting discovered something better. Amend the
     prescriptive document, bump its version, propagate downstream.
   - `REVISE_TEXT` — the draft drifted. The scene is wrong; fix it.

   There is no third option and no ordinary deferral. A deferred
   AUTHORITY_CONFLICT is a stall, and §4.7 does not apply here — a provisional
   default is not acceptable for an S1 contradiction.

### 23.3.1 Auditor timeout — degraded progress, not audit bypass

*(Added v0.3.3 per audit finding F-04, as ruled.)*

Step 3 requires independent confirmation. Without a timeout, an unresponsive
Auditor halts the affected chapter permanently. After **one defined operational
timeout cycle**:

- The Showrunner **may rule the conflict**, logged `UNCONFIRMED_CONFLICT`.
- **Drafting and transactional propagation may continue.**
- The affected chapter **remains `PENDING_AUDIT`.**
- **It cannot reach APPROVED.**
- The conflict **reopens automatically** for independent confirmation when the
  Auditor returns.

> **Any APPROVED state with an unresolved `UNCONFIRMED_CONFLICT` in its lineage
> is S0.**

**This is a degraded-progress mechanism, not an audit bypass.** The distinction
is the same one §29's completion states already draw between `AI_COMPLETE` and
`HUMAN_QA_COMPLETE`: work continues, the claim of correctness waits. Allowing the
ruling to also confer approval would let an S1 clear with no independent check —
the `PENDING_AUDIT` bypass this system explicitly guards against.
5. **PROPAGATE.** Per §27, through every document in the `affects` list.
6. **LOG.** Decision Log entry including the rejected option.

**The system must never silently pick.** This is the rule the master prompt asked
for in §23. What the two-axis model adds is precision about *where* collisions
occur — at the descriptive/prescriptive boundary, which is nearly all of them.

**Status: RULED.** Adopted by Showrunner ruling; DEC-003 approved. Now a
non-waivable protocol requirement (§4.8.1). The minority position is preserved in
DEC-003: confidence is high on the split being real, medium on the orderings
within each column, and the orderings remain open to attack.

---

# 24. CONTEXT-MANAGEMENT ARCHITECTURE

Never dump the project into a prompt. Context is assembled deterministically per
job, from IDs already named in the Chapter Card and Scene Card — so assembly is
lookup, not search, and produces identical packages for identical jobs.

## 24.1 Package for a scene-drafting job

| Component | Source | Approx. budget |
|---|---|---|
| Scene Card + beats | `beats.md` | 500 |
| Chapter Card (purpose, ending condition, hook) | `CARD.md` | 400 |
| POV character: full profile | `characters/` | 800 |
| Other present characters: dynamic zone only | `characters/` | 200 ea |
| Location profile | `locations/` | 400 |
| Relevant world/magic/tech rules only | `world/` | 400 |
| Continuity facts touching these entities | `CONTINUITY.md` | 600 |
| Previous scene: final 300 words verbatim | manuscript | 400 |
| Style Sheet | `STYLE_SHEET.md` | 500 |
| Active setups to plant | `SETUP_PAYOFF.md` | 200 |
| **Total** | | **~4,500** |

Against a modern context window this is small — deliberately. The failure mode of
large context is not truncation but **dilution**: a model given 80,000 tokens of
bible attends to all of it weakly. A model given 4,500 tokens of exactly the
right material attends to it strongly. Precision beats volume.

### 24.1.1 Budgets are soft targets, never silent truncation limits

*(Added v0.3.3 per audit finding F-05.)*

The 600-token continuity allocation is realistic at chapter 7 and not at chapter
28, where accumulated injuries, carried objects, relationship states, and
knowledge entries for active entities can exceed 2,000 tokens.

> **No continuity omission may occur silently.**

`build_context.py` must emit, at minimum:

```
facts_available:  total facts touching the scene's entities
facts_included:   facts placed in the package
facts_omitted:    the difference
```

**If `facts_omitted > 0`, the Job Packet explicitly flags continuity
truncation.** Prioritization is deterministic: active facts and current or recent
state outrank historical superseded material — but omission remains **visible to
both the auditor and the gate.**

Why visibility rather than a bigger budget: truncation of continuity facts is
otherwise invisible in its effects. The drafter simply does not know a fact and
writes something that contradicts it, and the resulting error is
indistinguishable from carelessness. A drafter working from a truncated set is
not the same as a drafter who made a mistake, and the audit must be able to tell
them apart.

## 24.2 Package for an audit job

Scene text + continuity facts for every entity appearing in it + hard rules +
timeline segment + chapter's `continuity_requirements`. **Deliberately excludes**
authorial intent and the beat map — an auditor who knows what the scene was
trying to do will forgive it for not doing it.

## 24.3 Retrieval rule

Entities are pulled by **ID from the cards**, never by keyword similarity. If a
scene needs an entity not listed on its card, that is itself a planning defect
worth surfacing — the card should have said so.

---

# 25. WRITING PIPELINE

```
PLAN → PACKAGE → DRAFT → SELF-PASS → AUDIT → RULE → REVISE
     → BRANCH → EXTRACT CANDIDATES → GATE → PROPAGATE
     → VALIDATE → COMMIT/MERGE → ADVANCE
```

**The working branch opens before extraction, not after the gate.** *(Corrected
in v0.3.3 per audit finding F-01.)* Under the previous ordering the branch did
not exist at gate time, so when the extraction-completeness audit found a missing
fact, the resulting write to `CANDIDATES.md` landed on trunk — outside any
transaction, with no rollback guarantee. A gate that subsequently failed left an
orphaned candidate behind.

**All candidate mutations from extraction onward occur on the transaction
branch.** Trunk must remain clean throughout gate evaluation. **Candidate
mutation on trunk before merge is S0.**

**Nothing propagated becomes authoritative before the merge.** Validation confirms
every document in the `affects` set was updated; the merge to trunk *is* the
commit. Failure at any point leaves the last committed state authoritative and
sets `ROLLBACK_REQUIRED` (§4.10.2).

> **Bug fixed in v0.3.** v0.1 ordered this `APPROVE → EXTRACT` while §29 listed
> "continuity extracted" as a *precondition* of scene approval. Both could not be
> true. Under the corrected order, Claude extracts **candidate** facts before the
> gate, Gemini checks extraction completeness *as part of* the gate, and only
> approved facts are committed to the ledger. This closes a window in which an
> approved scene could exist without its canonical state represented anywhere.

| Stage | Who | Output |
|---|---|---|
| PLAN | ChatGPT | Scene card + beats |
| PACKAGE | Orchestrator | Context package |
| DRAFT | Claude | Prose in boundary markers |
| SELF-PASS | Claude | One line-edit pass before submission |
| AUDIT | Gemini | Findings, severity-classified |
| RULE | ChatGPT | Accept / reject / arbitrate each finding |
| REVISE | Claude | Revised draft |
| BRANCH | Claude | Transaction branch opened. Every mutation below is inside it |
| EXTRACT CANDIDATES | Claude | Proposed facts, uncommitted, on branch |
| GATE | ChatGPT + Gemini | Approval, including extraction completeness |
| PROPAGATE | Claude | Ledger, bibles, state, registers on branch — none authoritative yet |
| VALIDATE | Claude + scripts | Every document in `affects` updated; registers reconcile; **evaluated ref recorded** (§4.12) |
| COMMIT/MERGE | Claude | Merge to trunk. This is the moment anything becomes authoritative |
| ADVANCE | Orchestrator | `STATE.md` moves to next scene |

**No authoritative state mutation occurs after merge** except advancing workflow
state as defined by the committed transaction. A post-merge propagation stage
would mean documents changing outside the transaction that approved them, which
is the precise failure §4.10.2 exists to prevent.

**SELF-PASS is not redundant with AUDIT.** They catch different classes: the
self-pass catches prose the writer can see is weak on second look; the audit
catches errors invisible from inside the drafting frame. Cheap, and it raises the
floor of what the auditor spends attention on.

**Revision cap: two cycles per scene.** A third failure means the *plan* is
wrong, not the prose — escalate to the Showrunner for a re-plan rather than
grinding. Uncapped revision loops are the primary way multi-agent systems burn
budget without converging.

---

# 26. MULTI-AI REVIEW

## 26.1 Tiered, not uniform

Reviewing everything at every level is how a system spends its budget on
ceremony. Tiering:

**Scene level — Gemini, every scene** (fast pass, ~10 min of attention):
continuity contradictions, character voice drift, timeline violation, rule
violations, information-leak errors (does someone know something they shouldn't?)

**Chapter level — Gemini + ChatGPT, every chapter:**
chapter objective achieved, entry ≠ exit state, pacing, dialogue quality,
repetition against prior chapters, setup/payoff register reconciliation,
hook strength, reader-engagement critique

**Act level — all three, ~every 8 chapters:**
structural integrity, tension curve shape, thread health, arc progression,
promise-to-reader tracking, whole-act read-through for drag

**Book level — all three, once at full draft:**
full continuity sweep, complete register reconciliation, voice consistency
sampling, theme coherence, ending-satisfaction check against `promise_to_reader`

## 26.2 Review assignment by comparative strength

- **Prose quality, voice, rhythm, dialogue naturalness** → Claude (self-pass)
  with Gemini as adversary
- **Continuity, contradiction, fact, rule violation** → Gemini
- **Structure, pacing, plot logic, arc** → ChatGPT
- **Reader engagement, predictability, emotional effect** → Gemini
- **Setup/payoff and thread reconciliation** → scripted checks first, then
  ChatGPT on what the script flags

Scripted checks run before model review in every case. Never spend model
attention on something arithmetic can decide.

---

# 27. REVISION SYSTEM

Eight levels, each with defined scope and propagation:

| Level | Scope | Propagates to |
|---|---|---|
| L1 Line | Sentences, word choice | Nothing |
| L2 Scene | One scene rewritten | Continuity, state |
| L3 Chapter | Chapter restructured | Cards, roadmap, continuity, registers |
| L4 Continuity | Fact correction | Every scene containing the fact |
| L5 Character | Arc or voice correction | All scenes with that character |
| L6 Structural | Chapter order, added/cut chapters | Roadmap, all downstream cards |
| L7 Developmental | Full-book architecture | Blueprint and everything below |
| L8 Polish | Final line pass, whole book | Nothing |

**Propagation rule:** a revision is not complete when the text changes. It is
complete when every document in the `affects` list has been updated and the
Revision Log entry is written. Incomplete propagation is the mechanism by which a
"fixed" book is inconsistent in three new places.

**L7 requires user approval** (§4 escalation) — a developmental revision changes
what book the user receives.

---

# 28. VERSION CONTROL

Git, with an enforced convention.

- **Commit at every gate pass**, never mid-work.
  Message format: `[CH07-S03] APPROVE v2 — fixed timeline contradiction FACT-0418`
- **Tags** at chapter approval: `ch07-approved`
- **Branch** for L6/L7 structural revisions, so an experiment that fails can be
  abandoned without contaminating the approved book.
- **Never force-push.** An old draft silently overwriting approved material is
  the failure mode §28 exists to prevent, and force-push is exactly how it
  happens.

`REVISION_LOG.md` carries the human-readable layer git cannot: *why*, and
**`downstream_reevaluation_required: [CH12, CH19]`** — the field that closes the
loop by naming what must now be re-checked.

**[VERIFY]** Gemini: confirm the practical repository size ceiling for a book
project with per-scene commits and, if imagery is canonical, binary reference
images. My expectation is that text is trivial and images dominate, arguing for
storing images outside the repo with pointers — but I have not measured this.

---

# 29. QUALITY GATES

Severity classes, revised on Showrunner review — v0.1 overloaded S1 by putting
build failures and shirt-color drift in the same bucket as a dead character
speaking. **Severity is now separate from error class.**

- **S0 — Build failure.** The machinery is broken, not the story. **Never
  waivable** and never subject to §4.7 defaults. Covers:
  malformed, nested, or unclosed markers · noncanonical markers in a strict build ·
  corrupt state · version collision · more than one `active` record for an
  `(entity, property)` pair · **`STALE_JOB`** · **conflicting duplicate
  delivery** · **invalid state transition** · **failed or incomplete
  transaction** · **prohibited mutation caused by a stale instruction** ·
  a P3 provisional actually created or propagated · **candidate mutation on trunk
  before merge** · **validation ref mismatch** · **APPROVED with an unresolved
  `UNCONFIRMED_CONFLICT` in lineage**.
- **S1 — Critical story error.** Contradiction that materially breaks story
  logic: impossible event, dead character acting, knowledge violation, hard-rule
  violation, AUTHORITY_CONFLICT. Cannot pass any gate.
- **S2 — Major.** Continuity, pacing, thread, or payoff defect affecting reader
  comprehension or structure. Orphaned setup, stalled thread, voice drift,
  unachieved objective. Resolved or explicitly waived with logged reasoning.
- **S3 — Minor.** Weak prose, small repetition, pacing wobble, shirt-color drift.
  Fix if cheap; batch otherwise.
- **S4 — Note.** Opportunity, not defect. Never blocking.

### `PROCESS_VIOLATION` — a blocked attempt, not a severity

Distinct from the S0–S4 scale. A `PROCESS_VIOLATION` records that a rule was
*attempted to be broken* and the attempt was **stopped before it took effect.**
Nothing propagated; no state was corrupted.

The distinction that matters:

| Condition | Classification | Meaning |
|---|---|---|
| Improper action **detected before** adoption or propagation | `PROCESS_VIOLATION`, blocked immediately | The guard worked |
| Improper action **created**, or downstream work allowed to inherit it | **S0** | The authority mechanism itself failed |

A blocked attempt is the system functioning correctly and must not be classified
as a build failure — otherwise every successful interception looks identical to a
breach, and the register stops distinguishing "we caught it" from "it got
through." That distinction is the whole value of the register.

> **No approval gate may pass while an improperly provisional P3 decision
> actually exists anywhere in the Decision Log, or has propagated into
> downstream work. That condition is S0**, and it applies log-wide, not merely
> to the current path.
>
> A `PROCESS_VIOLATION` that was successfully blocked before creation or
> propagation is **recorded but does not itself block subsequent gates**, once
> the attempted action has been contained.

The distinction is the whole point of separating the two classifications: if an
intercepted attempt blocked gates indefinitely, a working guard would be
indistinguishable in effect from a breach, and the incentive would run toward
not recording interceptions at all.

**S0 carries a retroactive obligation.** A marker defect discovered late means
every prior build is suspect — prose may have been silently dropped or notes
silently included. On any S0 marker error, all previous builds are marked
`SUSPECT` and re-run before the finding is closed.

### Gate criteria

**Scene approval:** zero S1 · scene objective achieved · change occurred ·
continuity extracted · word target ±25% · voice sampled against Style Sheet

**Chapter approval:** all scenes approved · zero S1 · S2s resolved or waived ·
entry ≠ exit · ending condition met · hook present · registers reconciled ·
timeline validated

**Act approval:** all chapters approved · tension curve non-flat · every major
thread advanced or deliberately parked · arcs progressed · no promise silently
dropped

**Manuscript approval:** all acts approved · full continuity sweep clean ·
all threads resolved or logged-open · all setups paid or logged-cut ·
voice consistency verified by blind sampling · ending satisfies
`promise_to_reader`

**Completion is three distinct states**, not one — added on Showrunner review to
resolve an apparent conflict between "autonomous completion" and "mandatory
human read." Both objectives survive once the states are named:

| State | Criteria | Who |
|---|---|---|
| `AI_COMPLETE` | L8 polish done · `--strict` build with zero S0/S1 · all registers reconciled · build report reviewed | The system, autonomously |
| `HUMAN_QA_COMPLETE` | One full human read, start to finish | The user |
| `PUBLICATION_READY` | QA findings resolved · front/back matter · final build | Both |

**The system can autonomously reach `AI_COMPLETE` without pretending it has
passed the human gate.** That is the honest claim. No configuration of three
models substitutes for one person reading the book start to finish, and a system
that labels its own output "finished" is making a claim it cannot verify.

---

# 30. CONTRADICTION AND ERROR HANDLING

## 30.1 Procedure

### 30.1.1 The general resolution cycle

Applies to **any** defect Atelier produces or permits — manuscript defects and
system/protocol defects alike:

```
DETECT → CLASSIFY → CORRECT → PROPAGATE → RECORD → PREVENT
```

**Manuscript errors use the fuller specialization** (unchanged):

**Detect → Classify → Locate → Determine truth → Correct → Propagate → Log →
Prevent**

### 30.1.2 PREVENT is a required stage, not a closing remark

`PREVENT` requires determining whether the defect is **mechanically detectable
in future runs**, and the answer branches:

**If yes:**
1. Add or strengthen the appropriate validator or check.
2. Add a **regression test reproducing the defect.**
3. Record the defect class and its detection rule.
4. **Verify the test fails before the fix and passes after it.**

Step 4 is the one that carries the weight. A regression test that has never been
observed to fail may be testing nothing, and a green suite that cannot go red is
worse than no suite — it manufactures confidence without evidence.

**If no deterministic check is practical:**
1. Document why.
2. Assign detection responsibility to the appropriate model audit or gate.
3. Add the failure pattern to that audit's checklist.

> **A defect is not fully closed merely because the current instance was
> repaired, when a practical recurrence detector could have been added.**

### 30.1.3 Tests and specification review are separate controls

> **Tests establish conformity to an encoded specification. They do not
> establish that the specification itself is correct.** Specification review and
> executable regression testing are separate controls, and **neither substitutes
> for the other.**

This generalizes three recorded defects that otherwise read as unrelated
accidents:

| Defect | What a green suite failed to catch |
|---|---|
| PDF-003 | An assertion whose comparison basis was corrupted by the operation under test |
| PDF-004 | A sweep that tested only for presence, never absence |
| PDF-005 | A line-based search for a phrase that spanned a line break |

The cleanest illustration is not in that table. `test_provisional_classifier.py`
ran 6/6 green while asserting that a contained `PROCESS_VIOLATION` blocks
approval gates. The suite was working correctly. The rule it encoded was wrong.
Only independent review caught it, and no amount of additional testing would
have.

**Consequence for §26 review tiering.** Scripted checks run before model review
because arithmetic is cheaper and deterministic — but this is the boundary.
**Scripts verify conformity to the rules; only review verifies the rules.** A
system that migrated everything to scripts as they matured would slowly lose the
only control capable of finding a wrong rule.

**Operating rule:** a passing regression suite is never evidence that a rule is
correct, only that behavior matches the rule as encoded. Every rule change
carries a review record, not merely a green test.

This is the difference between a system that fixes bugs and a system that gets
harder to break. Every S1 and every process defect ends with the same question:
*what check would have caught this automatically?* If an answer exists, it
becomes a script and a test.

## 30.2 Error taxonomy

| Error | Detection | Severity |
|---|---|---|
| Contradictory character fact | Continuity diff | S1 |
| Broken timeline | Timeline script | S1 |
| Impossible travel | Distance ÷ speed script | S1 |
| Forgotten object | Object-location tracking | S2 |
| Dead character appears | Continuity DEATH flag | S1 |
| Character knows what they shouldn't | `knows[]` diff | S1 |
| Location inconsistency | Location state diff | S2 |
| Magic-rule violation | Hard-rule check | S1 |
| Tech-rule violation | Capability check | S1 |
| Duplicate scene | Similarity scan | S2 |
| Repeated exposition | Info-introduced register | S2 |
| Missing setup | Payoff-without-plant check | S2 |
| Missing payoff | Orphan check | S2 |
| Plot hole | Model review | S1/S2 |
| Unresolved thread | Staleness check | S2 |
| **Hallucinated canon** | Fact not in ledger | S1 |
| Document version conflict | Front-matter version check | S1 |
| **AUTHORITY_CONFLICT** | Descriptive vs. prescriptive diff (§23.3) | S1 |
| Candidate leakage into authoritative ledger | `CANDIDATES.md` / `CONTINUITY.md` diff (§18.5.1) | S0 |
| Candidate mutation on trunk before merge | `git status` clean-check at gate (§25) | S0 |
| Validation ref mismatch against merged branch | Recorded ref vs. branch (§4.12.1) | S0 |
| APPROVED with unresolved `UNCONFIRMED_CONFLICT` in lineage | Lineage scan (§23.3.1) | S0 |
| Silent continuity truncation | `facts_omitted > 0` unflagged (§24.1.1) | S1 |
| Prohibited mutation from stale instruction | Pre-mutation version diff (§4.13) | S0 |

## 30.3 Process defects

Errors in the system's own operation get the same discipline as errors in the
book: detect, classify, correct, log, **and prevent.** Recorded in
`PROCESS_DEFECTS.md`.

```yaml
defect_id: PDF-001
observed:         what actually happened
should_have:      what the rule required
root_cause:
classification:   PROCESS_VIOLATION | DEFECT
severity:         S0 | S1 | S2 | S3 | S4 | none
rule_changed:     which spec section was amended
detection:        the check that would catch a recurrence  ← mandatory
regression_test:  test name, or "none practical — assigned to <audit>"  ← mandatory
test_verified:    failed before fix, passed after  ← mandatory when a test exists
status:           open | closed
```

**Classification is separate from severity**, because `PROCESS_VIOLATION` is not
a point on the S0–S4 scale (§29) — it records that a prohibited action was
intercepted.

> `severity: none` is permitted **only** when `classification:
> PROCESS_VIOLATION` **and** the prohibited action was intercepted before
> adoption, mutation, or propagation. Actual defects use S0–S4.

Without this split, an intercepted attempt would have to be logged as a build
failure it never caused, and the register would stop distinguishing the guard
working from the guard failing.

The `detection` field is not optional. A process defect recorded without a
detection rule is an anecdote — it documents that the failure happened once and
does nothing to stop it happening again. If no automatable detection exists, the
entry must say so explicitly and name the manual gate that substitutes.

**Why this register is separate from `ISSUES.md`:** story errors are found by
audit, and process defects are found by the system failing at its own rules. The
second kind is rarer, more expensive, and much easier to rationalize away as a
one-off — which is exactly why it needs a register that makes the pattern
visible.

## 30.4 Hallucination handling

Any fact in drafted prose that does not appear in the continuity ledger, the
bible, or the scene's context package is treated as **hallucinated canon** until
ruled on. Three outcomes:

1. **Adopt** — it's good; Showrunner approves, Claude logs it as canon.
2. **Reject** — it contradicts something; scene is revised.
3. **Escalate** — it materially changes the book; user decision (§4).

This is not a punitive frame. Drafting invention is often the best material in a
book. The rule is only that invention must become canon **explicitly**, through a
logged decision — never by quietly existing in a paragraph until three chapters
later it contradicts something and nobody can tell which fact came first.

---

# 31. USER INTERFACE / WORKSPACE DESIGN

Should feel like a book-production application, not three chat windows.

**Dashboard** — book title, phase, progress bar (chapters approved / total),
current word count vs. target, current stage and next action, live AI activity,
issues requiring user attention, recent decisions.

**Views:**
- *Roadmap* — whole-book table with the tension curve rendered as a sparkline
- *Chapter* — card, beats, drafted scenes, audit findings, approval state
- *Manuscript* — assembled read view, with continuity facts on hover
- *Bible* — browsable characters, locations, world, timeline
- *Threads* — open register with staleness highlighting
- *Issues* — filterable by severity, assignable
- *History* — decisions and revisions, with diffs

**Attention queue** — the one screen that matters. Everything requiring the user,
ranked, with enough context to decide in under a minute. If this queue is well
built, "minimal user involvement" is achieved; if it is badly built, no amount of
autonomy elsewhere compensates.

**[ARBITRATE]** UI implementation. My position: Phase 1 ships a generated static
HTML dashboard rebuilt from the repo on each state change — near-zero build cost,
readable, no server. A real interactive app is a Phase 3 concern, and building it
early trades away the thing actually worth building first, which is the engine.

---

# 32. INITIAL USER INTAKE

Smallest practical questionnaire. The team expands; the user should not have to
design the book.

**Required (7):**
1. What is the book about? (2–5 sentences is enough)
2. Genre / subgenre
3. Approximate length — novella / novel / long novel
4. Who is the main character, and what do they want?
5. What kind of ending — hopeful, dark, bittersweet, ambiguous, triumphant?
6. Point of view — first / third limited / third omniscient (or "you pick")
7. Anything this book must contain, or must never contain?

**Optional (3):**
8. Comparable titles — "like X meets Y"
9. Any characters, scenes, or images you already have in mind
10. Anything you've already written

Everything else — theme, structure, cast, world, chapter count, timeline, magic
or tech systems — is generated by the team and presented as a Blueprint for one
approval.

**Intake output:** Blueprint v1 with a one-page summary, plus a short list of
Critical Approval questions (§4) if any genuine forks exist. One review, one
approval, production begins.

## 32.1 Decision classification

**AI-Decidable** (resolve silently — the overwhelming majority): character names,
minor cast, location detail, scene structure, dialogue, chapter titles, word
distribution, sensory detail, minor plot mechanics, prose style within the Style
Sheet.

**User-Preference** (batch and ask in groups, never one at a time): tone shifts,
POV changes, explicit content level, major character death, romance presence,
ending register, series-vs-standalone.

**Critical Approval** (stop and ask): premise change, genre change, protagonist
change, ending fundamentally different from what was approved, L7 developmental
revision, cutting a major thread the user named.

**Rule: batch questions.** Ten questions in one queue costs the user five
minutes; ten interruptions across three days costs the project.

---

# 33. AUTOMATION OPPORTUNITIES

Scripted, never model-attention:

1. `assemble_manuscript.py` — boundary-rule assembly *(built)*
2. `validate_timeline.py` — the six timeline checks (§17)
3. `check_registers.py` — orphaned setups, stale threads, unearned payoffs
4. `build_context.py` — deterministic package assembly (§24)
5. `continuity_diff.py` — new facts vs. ledger; flags unlogged canon
6. `voice_sample.py` — pull random paragraphs across chapters for blind
   consistency review
7. `word_report.py` — counts vs. targets by chapter, act, book
8. `state_advance.py` — the state machine
9. `build_dashboard.py` — static HTML from repo state
10. `archive.py` — supersede-and-tombstone
11. `resolve_facts.py` — current effective fact per (entity, property) (§18.1)
12. `check_knowledge.py` — Knowledge Matrix violations (§18.4)
13. `build_depgraph.py` — derived dependency graph; marks `REEVALUATION_REQUIRED`
14. `check_jobs.py` — **implemented.** P1/P2/P3 provisional classification with
    the HIGH-cost / expensive-propagation catch-all, `PROCESS_VIOLATION` vs. S0
    classification, and the log-wide gate guard. Stale-input detection and
    duplicate-delivery quarantine remain to be added.
15. `export_state.py` — structured JSON/YAML state for the dashboard and any
    future interactive UI, so the UI never becomes a second source of truth
16. `test_assembler.py` — **implemented.** 9 boundary-rule regression cases
    covering §36 injections 12–16, strict-mode enforcement, and normalization
    limits. Carries a `--prove` red-state guard.
17. `test_provisional_classifier.py` — **implemented.** 6 fixtures covering the
    PDF-001 detection rule. Carries a `--prove` red-state guard.
18. `verify_delivery.py` — **implemented.** Multipart delivery integrity:
    missing, duplicated, corrupted, reordered, and truncated part detection with
    byte-range and hash verification.

**All validation scripts take an explicit `--ref` and default to `HEAD`
(§4.12.1). None may read trunk implicitly.**

**Design principle: scripts decide facts, models decide judgments.** Every check
moved from a model to a script is cheaper, faster, deterministic, and cannot have
an off day. Reserve model attention for what actually requires taste.

---

# 34. FULL BOOK LIFECYCLE

```
INTAKE
  └→ CONCEPT      ChatGPT expands; Gemini generates 2 blind alternatives
  └→ BLUEPRINT    ChatGPT drafts; Gemini attacks; ChatGPT rules
                  ═══ USER APPROVAL GATE ═══
  └→ WORLD        Claude writes bibles from Blueprint; Gemini researches
  └→ CHARACTERS   Claude writes profiles; Gemini stress-tests arcs
  └→ SYSTEMS      Magic/tech bibles if applicable; Gemini attacks rules
  └→ ROADMAP      ChatGPT; all three review the tension curve
  └→ CHAPTER CARDS  ChatGPT; Gemini checks coverage and thread health
                  ═══ GATE: every card has a defensible purpose ═══
  └→ PRODUCTION LOOP  per chapter:
        beats → draft → self-pass → audit → rule → revise
              → branch → extract candidates → gate → propagate
              → validate → commit/merge → advance
              [act gate every ~8 chapters]
  └→ FULL DRAFT   ═══ GATE: manuscript approval criteria ═══
  └→ DEVELOPMENTAL REVISION  L7 if needed  ═══ USER APPROVAL ═══
  └→ CONTINUITY SWEEP   full-book, scripted + Gemini
  └→ POLISH       L8, Claude, whole book, one voice
  └→ ASSEMBLE     --strict, zero errors
  └→ FINAL READ   human
  └→ COMPLETE
```

`STATE.md` always names the current node and the next required action. That
single invariant is what lets the system resume cleanly after any interruption —
including one that lasts three weeks.

---

# 35. EXAMPLE END-TO-END WORKFLOW

**Scene CH07-S03. Marla searches her father's workshop and finds the lighter.**

1. **PLAN.** ChatGPT writes the scene card: POV Marla, workshop at night,
   objective *find the ledger*, obstacle *someone has been here first*,
   discovery *brass lighter engraved V.R.*, decision *tell no one*, change
   *Marla now suspects her father lied*. Plants SP-034. 1,400–1,800 words.

2. **PACKAGE.** Orchestrator assembles ~4,500 tokens: scene card, chapter card,
   Marla's full profile, workshop location profile, 14 continuity facts touching
   Marla / workshop / father, last 300 words of S02 verbatim, Style Sheet,
   SP-034 planting instruction.

3. **DRAFT.** Claude writes 1,650 words inside boundary markers. Raises one
   **Canon Request**: *are the father's initials established?* — refuses to invent
   them.

4. **CANON APPROVAL (interim).** ChatGPT rules that the father's initials are
   J.V. This is the *approval* — the fact becomes canon at this moment, by
   decision. Notes that it makes the V.R. engraving load-bearing; confirms
   SP-034. **Nothing is written to any ledger by this step.**

   *(Canon Recording of FACT-0422 happens later, at step 9 as a candidate and at
   step 13 as an authoritative entry. Approval and recording are different acts
   by different roles — §3.2. Collapsing them is how a model ends up creating
   canon by writing it down.)*

5. **SELF-PASS.** Claude cuts 90 words of throat-clearing, tightens the discovery
   beat, checks voice against `what_they_never_say`.

6. **AUDIT.** Gemini, without the beat map, reports:
   - **S1** — Marla uses her left hand to lift the crate; FACT-0418 has her left
     palm burned and wrapped as of S02.
   - **S2** — the workshop is described as dusty; FACT-0392 established it was
     swept in CH04.
   - **S3** — three sentences in a row open with "She".
   - **S4** — the lighter's warmth could foreshadow the culvert scene.

7. **RULE.** ChatGPT: fix S1 (use right hand, and let the burn cost her — the
   awkwardness is characterizing). Fix S2 (dust is *disturbed*, which is better —
   someone was here). S3 fix. S4 adopted; logged as SP-035.

8. **REVISE.** Claude implements. 1,590 words.

9. **BRANCH.** Claude opens the transaction branch. Every mutation from here to
   the merge lives on it; trunk stays clean and `git status` on trunk is checked
   at gate evaluation.

10. **EXTRACT CANDIDATES.** Claude proposes — not commits — FACT-0417 (lighter),
   FACT-0420 (workshop disturbed), FACT-0421 (Marla suspects father lied,
   KNOWLEDGE), FACT-0422 (father's initials J.V., per DEC-024). Nothing enters
   the authoritative ledger yet.

11. **GATE.** ChatGPT + Gemini. Zero S1, objective achieved, change occurred,
    word target in range, voice sampled clean. Gemini also audits **extraction
    completeness** and catches one omission: the crate's new position is a
    continuity fact the extraction missed. Added as FACT-0423.

12. **PROPAGATE.** Marla's profile: `carrying[]` += lighter;
    `believes_wrongly[]` −= "father was honest with her"; arc position advanced.
    Workshop `current_condition` updated. Knowledge Matrix updated for FACT-0421.
    SETUP_PAYOFF: SP-034 planted, SP-035 added. STATE_SNAPSHOT rewritten.
    Timeline +40 minutes in-world. **None of this is authoritative yet.**

13. **VALIDATE.** Every document in the `affects` set confirmed updated;
    registers reconcile; `resolve_facts.py` finds exactly one `active` record per
    `(entity, property)`; timeline arithmetic passes.

14. **COMMIT/MERGE.** Branch merges to trunk. *This* is the moment the ledger,
    bibles, and state become authoritative. Commit message:
    `[CH07-S03] APPROVE v2 — burn-hand continuity fix, SP-034 planted`.
    Had validation failed, `ROLLBACK_REQUIRED` would fire and the last committed
    state would remain authoritative — the scene approved but its records
    untouched, which is recoverable. A half-propagated commit is not.

15. **ADVANCE.** `STATE.md` → CH07-S04.

Two things to notice.

**Step 6** — the S1 catch was possible only because Gemini had FACT-0418 and did
**not** have the beat map. An auditor who knew the scene wanted Marla to lift the
crate would have been more likely to let it go.

**Step 11** — the extraction-completeness audit caught a fact Claude missed. This
is why extraction happens *before* the gate rather than after it. Under the old
ordering that omission would have surfaced three chapters later as an unexplained
crate, with no record of when it moved.

---

# 36. IMPLEMENTATION ROADMAP

**Phase 1 — Skeleton (usable immediately, Manual Mode)**
Repository structure · PROTOCOL.md · `assemble_manuscript.py` · Blueprint,
card, profile, and continuity templates · handoff format · git conventions.
*Deliverable: three chat windows and a folder produce a consistent short book.*

**Phase 2 — Mechanization**
`validate_timeline.py` · `check_registers.py` · `continuity_diff.py` ·
`word_report.py` · static dashboard.
*Deliverable: mechanical errors stop reaching model review.*

**Phase 3 — Orchestration (Automated Mode)**
`build_context.py` · `state_advance.py` · three API clients · job dispatch ·
gate enforcement · retry and failure handling.
*Deliverable: the loop runs unattended between approval gates.*

**Phase 4 — Refinement**
Attention queue · interactive dashboard · voice sampling · turnaround imagery
(pending §12 verification) · act-level automation.

**Phase 5 — Validation by deliberate failure injection**

A clean run proves nothing. The novella test **injects failures** and passes only
if the system catches what it is designed to catch and fails loudly where
recovery would otherwise require guessing.

*Story-layer injections:*
1. Character eye-color contradiction
2. Impossible travel
3. Missing object (carried item vanishes)
4. Character acts on an unrevealed fact
5. Abandoned major thread
6. Payoff without setup
7. Setup never paid
8. Hard magic-rule violation
9. Continuity fact supersession
10. Blueprint/manuscript AUTHORITY_CONFLICT
11. Structural revision invalidating downstream chapters

*Machinery-layer injections:*
12. Malformed boundary marker
13. Nested `Start`
14. Unclosed `Start`
15. Notes accidentally inside manuscript markers
16. Prose accidentally outside markers
17. Stale Job Packet (input changed after dispatch)
18. Duplicate response delivery
19. Interrupted propagation transaction
20. Resume after shutdown mid-chapter
21. **`STALE_INSTRUCTION`** — a revision request whose premise targets a
    superseded specification state. Must be detected, classified, and produce
    **no mutation**, while any genuinely new instruction in the same message is
    still processed (component-wise handling, §4.13)
22. Candidate leakage — a canon candidate appearing in `CONTINUITY.md` before
    commit, or surviving a rollback

**Pass criteria:** every injection is detected, correctly classified by severity,
and either corrected or halted loudly. Note the asymmetry between 15 and 16 —
both must be *detected*, but they resolve differently.

**Injection 15 requires `detect → report → halt for correction`, never semantic
auto-repair.** Notes inside the markers are book content by definition (§4.2).
Removing them would require judging that they do not belong, which is the
judgment the Non-Interpretation Clause forbids. A test expecting auto-correction
here would be testing for a protocol violation.

Injection 16 (prose outside the markers) is recoverable by *moving the markers*,
which is a positional operation and therefore permitted.

*Also measured:* S1s reaching final draft, user decisions required, cost per
1,000 words, revision cycles per scene.

**Recommended first build:** Phase 1 + `validate_timeline.py` + `check_registers.py`,
tested on a 15,000-word novella before anything longer. A system that cannot hold
a novella together will not hold a novel together, and finding that out at 15,000
words costs a great deal less than finding it out at 90,000.

---

# APPENDIX A — OPEN ITEMS

**Showrunner decisions — ALL FINAL. None outstanding.**

| ID | Section | Ruling |
|---|---|---|
| DEC-001 | §2.2 | Manual-first validation with automation-ready formats; mechanize immediately once stable |
| DEC-002 | §3.5 | Prose Objections adopted; 5+ trivial in a chapter → S3 `BEAT_MAP_FRICTION` |
| DEC-003 | §23 | Two-Axis Authority Model; non-waivable (§4.8.1) |
| DEC-004 | §31 | Static dashboard Phase 1/2, structured JSON/YAML state from the start |
| DEC-005 | §4.8 | Four practices elevated to non-waivable protocol |
| DEC-006 | §4.7 | P1/P2/P3 provisional classes; silence cannot manufacture high-authority canon |

Provisional history is preserved in `DECISION_LOG.md`. DEC-003's procedural note
documents the failure that produced DEC-006 and is not to be removed.

**[VERIFY] for Gemini** — all four unanswered; running on §4.9 assumptions.
**None blocks any design element**; each has a graceful-degradation default.
1. §5.3 — Does vector search beat structured ID lookup for context assembly at
   100k+ words? **May optimize §24.3; does not block it. Structured ID lookup
   remains the correctness-preserving default** unless verification demonstrates
   a material benefit from vector retrieval.
2. §12 — Character identity consistency across image generations.
   **NOT VERIFIED** (V2, ruled). Identity drift past roughly 5–10 generations
   without fine-tuning. **Turnaround text is canonical; generated imagery
   remains decorative/reference-only and never becomes a source of canonical
   truth** unless a later explicit design ruling promotes a verified mechanism.
   Does not block §12.
3. §28 — Practical repo size ceiling with per-scene commits and binary images.
4. Cross-check §17's timeline validation logic for cases arithmetic misses
   (relativistic settings, non-linear time, unreliable narration).

**Known weakest sections, by my own assessment:** §12 (turnarounds — I am least
confident here and it is the most tool-dependent), §31 (UI — outside my lane),
§33 (automation — needs cost measurement, not estimation).

---

# APPENDIX B — CHANGE LOG

**v0.1 → v0.2**

| Change | Section | Source |
|---|---|---|
| Routing protocol added | §4.6 | ChatGPT |
| Stall handling / provisional defaults | §4.7 | Claude |
| Non-waivable protocol requirements | §4.8 | ChatGPT ruling |
| Blind-alternative trigger criteria defined | §4.8.4 | Claude (defining "selective") |
| `PENDING_AUDIT` state added | §4.8.3 | Claude (enforcing mandatory audit) |
| Unverified-claim handling + 4 degradation defaults | §4.9 | Claude |
| Collision rule → `AUTHORITY_CONFLICT` with fixed procedure | §23.3 | ChatGPT named it, Claude specified it |
| `AUTHORITY_CONFLICT` added to error taxonomy | §30.2 | Claude |
| DEC-003 ruled and approved | Appendix A | ChatGPT |
| DEC-001/002/004 adopted provisionally *(later superseded — see v0.3.1)* | Appendix A | §4.7 |

**Open at v0.2:** four Gemini `[VERIFY]` items, running on §4.9 assumptions.
DEC-001, DEC-002, DEC-004 were provisional at v0.2. **All six decisions received
explicit Showrunner rulings and are FINAL as of v0.3.1** — the provisional states
are preserved as history and are not the current status.

---

**v0.2 → v0.3** — Showrunner adversarial review integrated.

*Bugs fixed:* self-review principle contradicted SELF-PASS (§2.3) · manuscript
"immutable" contradicted L4–L8 revision (§23.1) · gate-order bug, APPROVE before
EXTRACT (§25).

*Added:* execution engineering principles (§4.10) · crash/resume lifecycle
(§4.11) · derived dependency graph (§4.12) · write-vs-decision authority (§5.4) ·
three canon operations (§3.2) · Prose Objection format (§3.5) · structured fact
records with resolver (§18.1) · Knowledge Matrix (§18.4) · S0 severity class with
retroactive build check (§29) · three completion states (§29) · failure-injection
validation (§36) · five scripts (§33).

*Relaxed:* three-chapter payoff rule → weight-relative heuristic (§21).

*Renamed:* Document Authority → **Document Custodian** · source-of-truth
hierarchy → **Authority Model**, with axes named Established Reality and Intent.

*Disputed, one item:* trivial Prose Objections should be **counted** even when
not logged (§3.5).

**v0.3.3** — Gemini partial adversarial audit integrated. Gate:
**PASS WITH REQUIRED FIXES — PENDING FOCUSED RE-AUDIT.**

*Audit findings, all accepted as ruled:*
**F-01** transaction branch opens before `EXTRACT CANDIDATES`, not after `GATE`
(§25, §18.5.1, §34, §35) — candidate mutation on trunk before merge is S0.
**F-02** every validation script takes an explicit `--ref` defaulting to `HEAD`,
never implicitly trunk; validation records the ref; mismatch is S0 (§4.12.1).
**F-03** component boundaries only from unambiguous structural divisions; a
component containing a conditional is atomic and never subdivided (§4.13.1).
**F-04** Auditor timeout permits `UNCONFIRMED_CONFLICT` ruling and continued
propagation, but the chapter holds at `PENDING_AUDIT` and cannot reach APPROVED;
APPROVED with unresolved `UNCONFIRMED_CONFLICT` in lineage is S0 (§23.3.1).
**F-05** context budgets are soft targets; `build_context.py` emits
`facts_available` / `facts_included` / `facts_omitted` and the Job Packet flags
truncation — no silent continuity omission (§24.1.1).

*Verifications:* V1 VERIFIED (structured ID retrieval permanent default) ·
V2 NOT VERIFIED (imagery stays decorative) · V3 VERIFIED (binaries external) ·
V4 PARTIALLY VERIFIED (arithmetic necessary, insufficient).

*Staged items merged:* `check_jobs.py`, `test_provisional_classifier.py`, and
`verify_delivery.py` recorded as implemented (§33) · `--prove` red-state
verification (§30.1.2) · PDF-001 corrected to S0 · engineering guidance that
tests and specification review are separate controls (§30.1.3) · §12 wording
aligned to the approved formulation.

*Five S0 conditions added to the error taxonomy (§30.2).*

**v0.3.2** — Showrunner synchronization pass 2. Canon candidates now stored in a
**separate file** (`03_MEMORY/CANDIDATES.md`) rather than flagged inside the
authoritative ledger (§18.5.1). Manuscript assembly split out of update
discipline into its own §18.6 — extraction is judgment, assembly is mechanical.
Canon Approval separated from Canon Recording in the §35 worked example.
`STALE_INSTRUCTION` and candidate-leakage added to the failure-injection suite
(§36, injections 21–22). §5 subsection numbering resequenced (5.4 had been
inserted between 5.1 and 5.2). Candidate leakage and stale-instruction mutation
added to the §30.2 error taxonomy as S0.

**v0.3.1** — Decision Log and full-document synchronization. Stale prose removed:
§3.2 extraction model, §4.3 handoff fields (`CANON CHANGES` → `CANON CANDIDATES`,
plus JOB_ID / BASE_VERSION / OUTPUT_VERSION / RESPONSE REQUIRED), §18.5 update
discipline, §25 and §34 and §35 transaction ordering, §29 S0 execution failures,
Appendix A arbitration block, Appendix B provisional states, header owner title.
Decision Log synchronization: DEC-002 counting dispute ruled:
trivial Prose Objections counted per chapter, 5+ raises S3 `BEAT_MAP_FRICTION`
against the planning layer (§3.5). DEC-005 implementing specifications approved;
provisional language removed. DEC-006 P3 scope clarified with an explicit
catch-all for HIGH reversal cost or expensive downstream propagation (§4.7).
Gemini VERIFY #1 reclassified as optimizing rather than blocking (§4.9).
No architectural changes. All six decisions final.

**v0.3 amendments** — Showrunner rulings final on DEC-001 through DEC-004.
§4.7 narrowed into P1/P2/P3 provisional classes (DEC-006); high-impact decisions
can no longer be auto-adopted on silence. §23 renamed to **TWO-AXIS AUTHORITY
MODEL** per required terminology. Claude's earlier auto-adoption of DEC-003
recorded as improper under the corrected rule.

---

*End of SYSTEM_SPEC v0.3.3 — authoritative.*

*§12, §31, and §33 remain the weakest sections by the author's own assessment.
Gemini has not completed an adversarial review of any version; the audit gate
stands at `PENDING_AUDIT` and no section of this document has been independently
attacked.*
