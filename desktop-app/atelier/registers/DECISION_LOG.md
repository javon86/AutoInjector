---
doc_id: DECISION_LOG
doc_type: decision_log
owner: chatgpt
maintained_provisionally_by: claude
version: 1
last_updated: 2026-08-12
canon_status: approved
---

# DECISION LOG

Records major creative and architectural decisions, including rejected
alternatives and the reasoning for rejection. Prevents settled questions from
being relitigated.

**Ownership note:** this document is owned by the Showrunner (ChatGPT). Entries
marked `status: provisional` were adopted by Claude under §4.7 of
`SYSTEM_SPEC.md` after an AI-Decidable question received no ruling following two
requests.

**Current §4.7 behavior (post-DEC-006):** provisional adoption is classified,
not blanket.

| Class | Behavior on silence |
|---|---|
| **P1 — low impact** | May proceed normally |
| **P2 — reversible** | May proceed provisionally; **downstream work inherits provisional status** |
| **P3 — high impact** | **Cannot auto-adopt.** Halt and escalate |

P3 covers premise · high-impact canon decisions or canon-system architecture ·
major character fate · ending · authority rules · structural chapter changes ·
**and any decision with HIGH reversal cost or expensive downstream
propagation.**

Overturning a provisional entry requires no justification beyond a ruling — the
mechanism exists to prevent stalls, not to transfer authority.

*Historical entries below preserve the former blanket rule where needed to
explain what happened. This introductory language governs.*

---

## DEC-001 — Build order: Manual Mode first

- **date:** 2026-08-12
- **stage:** system design
- **spec ref:** §2.2
- **question:** Build Manual Mode first with Automated-ready file formats, or go
  straight to Automated Mode?

**alternatives**

- **A — Manual first.** Source: Claude. Three chat windows plus a folder, using
  the exact file formats Automated Mode will consume. Migration is a script
  swap, not a rewrite.
- **B — Automated first.** Source: Claude (stated as the counter-position).
  Manual Mode's real cost is that the user personally absorbs every relay, feels
  the friction, and abandons the project before automation ever arrives.

**selected:** A

**reasoning:** B's risk is real but it is a risk of *user attrition*, which can
be mitigated by scoping the Manual Mode test to a 15,000-word novella (§36)
rather than a full novel. A's risk is *wasted build effort*, which cannot be
mitigated after the fact. More decisively: the file formats are the actual
product of this design phase. Manual Mode tests those formats under real use for
near-zero build cost, and format errors discovered during a novella cost days
while the same errors discovered after an orchestrator is built cost the
orchestrator.

**rejected_because:** B commits engineering effort to an orchestration layer
whose input formats have never been exercised against a real book.

- **documents_affected:** SYSTEM_SPEC §2.2, §36
- **downstream_impact:** Phase 1 and Phase 3 scope
- **reversal_cost:** LOW. Reversing before Phase 1 completion costs nothing but
  the decision itself. Reversing after Phase 1 wastes no work, since Phase 1
  artifacts (templates, protocol, assembler) are consumed by Automated Mode
  unchanged.
- **status:** **FINAL — ADOPT WITH MODIFICATION** (Showrunner, 2026-08-12)
- **modification:** Manual-first validation using automation-ready formats from
  day one, followed *immediately* by mechanization of the stable workflow. Do
  not build a polished manual product before automating; do not automate an
  unproven workflow. Phase 1 proves protocol, repository, markers, authority
  rules, continuity extraction, gates, and recovery. Mechanization begins before
  UI refinement.
- **rationale (Showrunner):** automating an unstable workflow only makes mistakes
  faster; staying manual too long defeats the minimal-user-involvement objective.

---

## DEC-002 — Prose Objections are permitted, and must be ruled on

- **date:** 2026-08-12
- **spec ref:** §3.5
- **question:** May the Author overrule the Showrunner on a beat that fails on
  the page?

**alternatives**

- **A — No.** The Roadmap is authoritative. The Author executes. Clean authority
  line, no ambiguity, no drift.
- **B — Yes, silently.** The Author writes what works and the plan is updated
  afterward to match.
- **C — Yes, by formal objection.** Source: Claude. The Author may not deviate,
  but may file a **Prose Objection** that the Showrunner must rule on within the
  same cycle. The Author drafts to the ruling.

**selected:** C

**reasoning:** A produces technically compliant, emotionally dead prose — beats
that read as executed rather than discovered, because the writer had no way to
report that a scene was fighting the page. B destroys the Roadmap's value
entirely: if the plan silently conforms to the draft, the plan constrains
nothing and long-book drift is guaranteed. C preserves both — the discovery that
happens only in drafting is captured, but it enters the system as a logged
decision rather than as an unannounced deviation. Cost is one extra round trip
on the minority of scenes where an objection is actually filed.

**rejected_because:** A discards information available nowhere else in the
system. B is indistinguishable from having no plan.

- **documents_affected:** SYSTEM_SPEC §3.5, §4.3 (handoff carries
  `PROSE OBJECTIONS`), §25
- **reversal_cost:** LOW.
- **status:** **FINAL — ADOPT** (Showrunner, 2026-08-12)
- **required format:** `PROSE_OBJECTION` block — Beat/Requirement · Observed
  problem · Why it fails in execution · Minimal proposed change · Downstream
  effect · Can current scene still be completed (yes/no).
- **ruling verbs:** `ACCEPT` | `MODIFY` | `REJECT` | `REPLAN`.
- **Claude may not silently deviate from approved structure or canon.**
- **A Prose Objection is a proposal, not authority to deviate.** The Author
  drafts to the ruling, including when the ruling is `REJECT`.
- **counting rule — RULED (Showrunner, 2026-08-12):** Claude's counting proposal
  adopted with modification. Trivial Prose Objections do not require individual
  Decision Log entries, but are **counted per chapter.** At 5+ in one chapter,
  raise **S3 — `BEAT_MAP_FRICTION`**, a diagnostic against the *planning layer*,
  not against Claude or the prose. It triggers Showrunner review of beat-map
  granularity; it does **not** automatically require replanning and does **not**
  block the chapter gate.
- **dispute status:** resolved. No open items.

---

## DEC-003 — Two-Axis Authority Model adopted

- **date:** 2026-08-12
- **spec ref:** §23
- **question:** Adopt the descriptive/prescriptive split, or keep the master
  prompt's flat hierarchy?

**alternatives**

- **A — Flat hierarchy.** Source: master prompt §23. Approved story state →
  Continuity Memory → current chapter info → Blueprint → older planning.
- **B — Two-axis.** Source: Claude. Descriptive facts (what the reader has read)
  and prescriptive facts (what is planned) are ranked on separate ladders.
  Collisions between the two raise a Severity-1 issue that the Showrunner must
  resolve explicitly — retcon the plan, or revise the text.

**selected:** B

**reasoning:** A treats a drafted sentence and a designed plot point as the same
kind of claim, differing only in recency. They are not. A sentence in approved
manuscript text is established reality and remains authoritative unless changed
through an approved revision transaction; a plan remains intent until established
in approved manuscript text. Under A, any
scene that drifts from the Blueprint automatically wins simply by being newer,
and the book wanders off its own design one locally-reasonable sentence at a
time. Every individual step looks fine, which is exactly what makes the failure
hard to catch. B makes that collision loud instead of silent, which is what the
master prompt itself demands two sentences later when it says the system must
never silently choose between contradictory facts. B is the flat hierarchy's own
stated principle, applied consistently.

**rejected_because:** A's ordering contradicts A's own no-silent-choice
requirement at precisely the boundary where contradictions actually occur.

**minority position preserved:** Claude's confidence is HIGH that the
descriptive/prescriptive distinction is real and load-bearing, and only MEDIUM on
the exact orderings within each column. The orderings are the part most worth
attacking; the split is not.

- **documents_affected:** SYSTEM_SPEC §23, and inherited by §18, §19, §29, §30
- **downstream_impact:** all continuity and error-handling logic
- **reversal_cost:** **HIGH.** §18 (Continuity Memory), §29 (quality gates), and
  §30 (error taxonomy) all inherit this ordering.
- **status:** **FINAL — ADOPT WITH REQUIRED TERMINOLOGY CHANGE** (Showrunner,
  2026-08-12). Non-waivable protocol requirement, SYSTEM_SPEC §4.8.1.
- **required renames:** "source-of-truth hierarchy" → **TWO-AXIS AUTHORITY
  MODEL**; axes named **Established Reality Authority** and **Intent Authority**.
  Applied to §23 heading and body.
- **required correction:** "approved manuscript text is immutable in place" →
  "remains authoritative unless changed through an approved revision
  transaction." Otherwise §23 contradicts the revision system. Applied.
- **procedural note:** this entry was originally auto-adopted by Claude under the
  v0.2 form of §4.7. That was improper — it is a P3-class decision and should
  have halted for arbitration. Its validity rests on this explicit ruling, not on
  the provisional adoption. See §4.7 self-correction.

---

## DEC-004 — Static generated dashboard in Phase 1

- **date:** 2026-08-12
- **spec ref:** §31
- **question:** Static HTML dashboard regenerated from the repo, or an
  interactive application earlier?

**alternatives**

- **A — Static, Phase 1.** Source: Claude. `build_dashboard.py` regenerates HTML
  from repo state on every state change. No server, no framework, no state of its
  own.
- **B — Interactive app earlier.** Better user experience, closer to the
  "book-production application" feel the master prompt asks for in §31.

**selected:** A

**reasoning:** The dashboard is a *view*. Its correctness depends entirely on the
repository beneath it, and a beautiful view of an engine that cannot hold a
novella together is worth nothing. A also has a property B lacks: because it is
regenerated rather than stateful, it cannot drift from the repository or become a
second source of truth. B is the right eventual answer and stays in Phase 4.

**rejected_because:** B spends the early build budget on presentation while the
engine — the thing that determines whether the book is any good — is unvalidated.

- **documents_affected:** SYSTEM_SPEC §31, §33 (script 9), §36
- **reversal_cost:** LOW. Static dashboard is throwaway by design.
- **status:** **FINAL — ADOPT WITH MODIFICATION** (Showrunner, 2026-08-12)
- **modification:** dashboard source state must already be emitted as structured
  JSON/YAML, so the later interactive application consumes the same underlying
  representation rather than requiring a rewrite. The interface is not the
  product yet; the state machine is. Implemented as `export_state.py` (§33, script 15).

---

## GEMINI [VERIFY] ITEMS — PENDING VERIFICATION

*(All four running on §4.9 graceful-degradation assumptions. Note: §4.9 governs
unverified **facts** and is unaffected by the DEC-006 narrowing, which governs
unmade **decisions**. Neither manufactures canon.)*

- **Gemini [VERIFY] 1** (§5.3) — vector search vs. structured ID lookup at 100k+
  words. **May optimize §24.3; does not block it.** Structured ID lookup remains
  the correctness-preserving default unless verification demonstrates a material
  benefit from vector retrieval. *(Corrected — the previous "blocks" wording
  contradicted §4.9, which requires that no design element remain dependent on an
  unanswered verification.)*
- **Gemini [VERIFY] 2** (§12) — character identity consistency across image
  generations. **Current correctness-preserving default:** turnaround text is
  canonical; generated imagery is decorative and never a source of truth.
  Findings may optimize the turnaround-image workflow, but **generated imagery
  remains decorative/reference-only and never becomes a source of canonical
  truth.** Does not block §12.
- **Gemini [VERIFY] 3** (§28) — repo size ceiling with per-scene commits and
  binary images.
- **Gemini [VERIFY] 4** (§17) — timeline validation cases arithmetic misses.

---

## DEC-005 — Four practices elevated to non-waivable protocol

- **date:** 2026-08-12
- **spec ref:** §4.8
- **ruled_by:** ChatGPT (Showrunner)
- **question:** Are the two-axis authority model, AUTHORITY_CONFLICT behavior,
  independent continuity auditing, and blind-alternative generation advisory
  practices or protocol requirements?

**selected:** Protocol requirements. Non-waivable for schedule, cost, or
convenience.

**reasoning (Showrunner):** advisory practices are skipped under pressure, and
each of these four exists specifically to catch failures that only appear under
pressure.

**Claude's implementing specifications** — the ruling named the requirements; two
needed definition before they could be enforced:

- *"Selective" blind-alternative generation* was undefined and therefore
  unenforceable. Specified as five objective triggers in §4.8.4, with an explicit
  not-triggered list and a cap of 2 alternatives in one round. Discretionary
  selectivity would have collapsed back to "whenever someone feels like it."
- *Independent continuity auditing* had no operational consequence. Added the
  `PENDING_AUDIT` chapter state: without an audit of record a chapter cannot
  reach APPROVED. Without this, the requirement is a preference.
- *AUTHORITY_CONFLICT* was named but had no procedure. Specified as
  HALT → REPORT → CONFIRM → RULE → PROPAGATE → LOG in §23.3, with §4.7
  provisional defaults explicitly barred — an S1 contradiction may not be
  defaulted.

**APPROVED (Showrunner, 2026-08-12).** All three implementing specifications are
now part of the ruling itself, not Claude's interpretation of it:
objective triggers with a one-round / two-alternative cap for selective blind
alternatives · `PENDING_AUDIT` when the required independent continuity audit has
not occurred · `AUTHORITY_CONFLICT` = HALT → REPORT → CONFIRM → RULE →
PROPAGATE → LOG.

- **documents_affected:** SYSTEM_SPEC §4.8, §23.3, §30.2, §3.3, §29
- **reversal_cost:** HIGH — §4.8.3 changes the gate criteria in §29.
- **status:** **FINAL — APPROVED**

---

## DEC-006 — §4.7 narrowed into three provisional classes

> **ID note:** the Showrunner requested this be filed as DEC-005. That ID was
> already issued and approved (protocol elevation, above). Decision IDs are
> immutable once issued — reusing one would make every prior reference to DEC-005
> ambiguous. Filed as DEC-006; content is the ruling as given, unchanged.

- **date:** 2026-08-12
- **spec ref:** §4.7
- **ruled_by:** ChatGPT (Showrunner)
- **question:** Should a provisional decision adopted on silence be fully binding
  on downstream work?

**Showrunner ruling:** No. The v0.2 sentence "a provisional decision is fully
binding on downstream work until overturned" is too dangerous — a missing
response could generate large amounts of expensive downstream work from a weak
assumption.

**selected:** Three classes.

- **P1 low-impact** — adopt and proceed normally.
- **P2 reversible** — adopt and proceed, but downstream outputs are flagged
  provisional and inherit the flag until the ruling lands.
- **P3 high-impact** — cannot auto-adopt. Halts and escalates.

**P3 by definition:** premise · **high-impact canon decisions or canon-system
architecture** · major character fate · ending · authority rules · structural
chapter changes.

**Governing catch-all (ruled 2026-08-12):** any decision with **HIGH reversal
cost or expensive downstream propagation** is P3 regardless of whether it matches
a named example. This prevents a high-impact decision escaping P3 merely by not
resembling one of the listed cases.

**reasoning:** silence may prevent small decisions from blocking production;
silence may not manufacture high-authority canon. The asymmetry is correct — the
cost of a stalled P1 is a delay, while the cost of an auto-adopted P3 is a book
built on an assumption nobody ratified.

**Claude's concession:** DEC-003 was auto-adopted under the old rule and was
P3-class. It was ruled correct afterward, but that is luck rather than process,
and the rule change is warranted by exactly that incident.

- **documents_affected:** SYSTEM_SPEC §4.7, DEC-003
- **reversal_cost:** LOW
- **status:** **FINAL — APPROVED**
