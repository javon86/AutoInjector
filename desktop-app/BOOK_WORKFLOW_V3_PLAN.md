# Book Workflow v3 — Implementation Plan

**Status:** PLAN ONLY. Nothing in this document has been applied to the program.
**Branch:** `claude/book-workflow-v3-plan` (do not merge to `main` until approved).

Governing rule for the whole effort:

> **Capture is not completion. Only a validated state transition advances production.**

And the design principle that makes the rules stick:

> **Never ask a model for something the program already knows. Move every
> mechanical rule off the model and into the program.**

---

## 0. Why this exists — what Book 16 proved

Book 16 was produced by the **old flat 11-step runner**, not the v3 derived-state
engine. It failed in a specific, diagnosable way *while reporting complete success*:

- Steps 2–5 (requirements, 24-ch outline, bible, roadmap) produced genuinely good content.
- Step 6 the writer **refused**: *"BLOCKING — cannot draft. INPUTS SUPPLIED: none."*
  The prior steps' outputs were never carried into the write prompt.
- Steps 7–11 cascaded — three CRITICAL/BLOCKED reviews, then a NOT-READY lock.
- The runner **ignored every refusal**, filed the refusal as `16 - Write the chapter.pdf`,
  passed the completion gate 10/10, and marked `workflow.status = done` — with
  `chapters: [], records: []` and **zero manuscript.**

The transcript (454 messages) adds the coordination-layer failures:

- **No project isolation** — one relay braided a book, an architecture debate, and an
  unrelated real legal matter; book identities collided ("Make Coffee Book" / "Go Home" / "14").
- **~4% envelope compliance** — `[FROM:]` on 18/454 messages; `[MSG #]` abandoned after 15 uses.
- **Watchdog false-positives** — "no ending tag received / resend" fired at the start of
  sessions where nothing had been produced (the single most-repeated failure).
- **Empty-body messages passed the guard** — the validator checked tag *presence*, not
  content *between* the tags.
- **Stage machine advanced on a fixed sequence, not on record state** — it even *regressed*
  stages against an empty record set.

Every fix below traces to one of these.

---

## 1. The two-bucket rule (how we actually make them follow the rules)

Split every "rule" into two buckets and treat them completely differently.

### Bucket A — Mechanical rules → **program-enforced (100%)**
Routing, message numbering, project/chapter identity, provenance, hashing, wrappers,
"who acts next." The program already knows all of this because it dispatched the job.
The program **stamps** it and **strips/re-stamps** anything the model emits. The model is
never the source of truth for a fact we already hold. This is deterministic code, so it is
reliable by construction — the model's discipline is irrelevant.

### Bucket B — Semantic rules → **gated-and-retried (detection)**
"Don't invent canon," "don't reveal the sender early," "keep continuity." These cannot be
guaranteed from any model. We don't require compliance — we require **detection**: a
violation is caught by a validator or reviewer and **cannot advance production**, and the
program re-requests with a filled-in template. Unreliable inputs, reliable outcomes.

Every task in this plan is tagged **[A]** or **[B]** so we always know whether we're
guaranteeing it or gating it.

---

## 2. Completion detection — the Turn-Complete Detector  **[A]**

**Problem history.** We tried two ways to know when a model is done; both *guess*, so both
truncate long responses (a whole chapter is exactly the failing case):

- **Stability timer** — mistakes a mid-stream pause for the end → partial capture.
- **`[FROM:]` end tag** — models emit it ~4% of the time → wait forever, time out on a
  partial, or the watchdog false-fires.

**Fix.** Read the signal the sites already publish. While generating, ChatGPT/Claude/Gemini
each show a **Stop button** and mark the streaming message node (a CSS class / `aria-busy` /
`result-streaming`). When generation finishes, **Stop flips back to Send**, the streaming
marker is removed, and copy/regenerate controls appear. That is deterministic ground truth.

### 2.1 Component contract
A per-pane **Turn-Complete Detector**, single responsibility: *"is this one turn finished?"* —
nothing about the book. Small state machine per pane:

```
IDLE → (we send) → GENERATING → COMPLETE
   GENERATING  entered when: site shows Stop button / streaming marker on the latest assistant node
   COMPLETE    entered when: Stop→Send flipped  AND  streaming marker gone  AND  text stable ~300ms
```

- Capture happens **only** on COMPLETE, and reads the **whole final message node once**
  (never a diff of the streamed text — reading the diff is itself a truncation cause).

### 2.2 Signal layering (reliability order)
1. **Primary:** site generation-complete DOM signal (button flip / streaming class).
2. **Confirm:** short ~300ms stability check *after* the signal (survives a late repaint).
3. **Bonus:** `[FROM:]` tag if present = extra confidence, **not** the trigger. Absence is
   fine — the UI already said it finished. (This kills the false "no ending tag" nag.)
4. **Backstop:** long absolute timeout for a genuine hang → raises a real
   "no completion detected on *this pane, this job*" state, never a blind resend into a fresh chat.

### 2.3 Two extra truncation causes to handle
- **"Continue generating"** — response hit the site's length cap. The detector must treat
  this as **NOT complete**, click Continue / re-prompt, and stitch the pieces. Chapter-length
  outputs are where this bites.
- **Virtualized long messages** — some UIs only render the on-screen part of a very long
  message. Read the underlying node, not the rendered viewport. Verify against a full chapter.

### 2.4 Where it lives
Selectors are per-site and change when the sites change — they live in the **selectors config
we already sync** (`selectors-sync`), so a site markup change is a one-place update.

### 2.5 Keep it single-purpose
"Is this turn done?" (per-pane, DOM-signal) is a different job from "what happens next in the
book?" (the derived-state engine). Do **not** let the detector grow into a second workflow
manager — that two-brains split is exactly what broke Book 16. The detector certifies a
complete capture; the engine decides what to do with it.

---

## 3. Make the governed engine the authoritative production path  **[A]**

(Consolidated-update §1, §8, §9, §12.)

- The live **Make Book** button runs the **v3 derived-state engine** (`atelier-engine.js` via
  `atelier-runner.js`), not the flat step runner.
- The Book Studio display, dispatch, saved status, PDF generation, and next-chapter
  progression are all **projections of one authoritative engine state**. No separate writable
  "current step" that can disagree.
- The flat 11-step runner remains only as an explicitly labeled **legacy/test mode**.
- **Multi-chapter loop:** after a chapter locks → persist locked manuscript + hash → update
  summaries/records via typed jobs → refresh status projection → select next planned chapter →
  dispatch its planning job if missing → dispatch the writer only when deps are approved →
  continue until every planned chapter is locked and final assembly passes.
- **Default-forward:** when the engine reports one unambiguous next safe action, dispatch it
  automatically. Silence or a transport failure is **never** approval.
- **Lock semantics:** every write/revision/import/PDF/next-prompt uses engine lock state.
  Reopening is an explicit authorized transition (identity, reason, authority, downstream
  stale actions). Ordinary conversation can never reopen locked material.

---

## 4. Validate meaning before materialization — typed jobs & schemas  **[A]+[B]**

(Consolidated-update §4. This is the section that alone would have prevented Book 16.)

- Every dispatched job carries a **program-owned expected artifact type + schema**
  (requirements set, master outline, bible update, roadmap, manuscript, story/canon/writing/
  honest-read review, correction list, revised manuscript, lock decision, PM checkpoint).
- The expected type comes from the **job**, never from a label the model invents.
- Validate the captured content against the schema **before** it becomes an artifact.
- **A response that says it can't do the job is stored as HELD/BLOCKED — never assigned the
  requested artifact identity.** (Refusal ≠ deliverable.)
- **Honest Read** must be authored by a non-author cold reader — name the site explicitly
  (engine `HONEST_SITE`), distinct from the Story reviewer even though both may be ChatGPT.

---

## 5. Boundaries & call-signs — as *tolerant aids*, not stall-gates  **[A read / [B] emit]**

(Consolidated-update §2, §3 — **demoted per the two-bucket rule.**)

- The book-context boundary `-<{####}>-` and the chapter call-signs
  `[BOOK: … | CHAPTER: n | TITLE: … | START/FINISHED]` are **stamped by the program** where it
  can, and **read tolerantly** where the model emits them (normalize + fuzzy-match, like the
  existing tolerant `[FROM:]` matcher).
- On a boundary/call-sign miss, the program does **best-effort extraction** (strip known
  wrapper noise, take the prose between the best markers) and then validates the *extracted*
  content against the §4 schema. The wrapper is a hint; **§4 is the real gate.**
- A failed extraction **teaches-and-retries** with the exact pre-filled skeleton
  ("put your answer in here, change nothing else"), bounded to 2–3 tries, then quarantine +
  escalate. It must **never** dead-end into the anti-stall loop.
- Guards must reject **empty body between tags** and **reversed/duplicated/nested** boundaries.
- Pick a sentinel that can't be visually confused with the `[MSG #NNNN]` counter.
- **Untitled chapters** use one canonical `TITLE: UNTITLED` — never sometimes-present /
  sometimes-absent. (This directly fixes Book 16's finish-line stall on an unpicked title.)

---

## 6. Prompts by (MODEL + DERIVED STATE + EXPECTED ARTIFACT TYPE)  **[A]**

(Consolidated-update §5. Extend the existing role prompts; do not replace them.)

Each dispatched packet includes only what that model needs now, and states: role · derived
stage · program-owned job & chapter identity · authoritative input artifact IDs+versions ·
exact task · permitted changes · prohibited changes · required output schema · acceptance
criteria · expected next state. Per-model additions per §5 (ChatGPT PM control packet with a
machine-readable action from the valid set; Claude writing/review packet with exact manuscript
version + corrections + prior locked chapter; Gemini canon packet with manuscript version +
governing artifact versions, verdict bound to the manuscript hash).

**Cold-start note (sequencing dependency):** §6's "supply relevant canon/character records"
depends on §9's records existing. In a real run those records don't exist until chapters lock
(Book 16's bible was empty templates). Chapter 1 must work from requirements + outline + bible +
roadmap only; structured records accrue as chapters lock. State the cold-start path explicitly.

---

## 7. PM checkpoints & status projection  **[A]**

(Consolidated-update §6, §7.)

- **Checkpoints** fire after *meaningful production transitions* (manuscript validated, review
  recorded, corrections resolved, ready-to-lock, locked, genuine blocker) — **not** because a
  message arrived. Generated from authoritative state; ChatGPT may be asked for a story-authority
  decision but **cannot assert that missing gates are complete.**
- **One status projection object** (extends `deriveBook`): title, planned/҃current chapter,
  drafted/reviewed/corrected/locked counts, remaining, word counts, gate & review completion,
  unresolved corrections, artifact versions & lock state, last valid transition, next safe
  actions, blockers, whether user authority is required. Rendered into both the checkpoint
  prompt and the Book Studio cockpit. Model-generated summaries never override structured records.

---

## 8. Session / project isolation  **[A]**  *(new — the transcript's biggest lesson)*

Not in the consolidated update, but higher-leverage than the wrappers:

- One relay session is bound to **exactly one project**.
- Every dispatch is gated on **project identity** before anything routes.
- Enclosed book content is associated with the active project + dispatched job (never promoted
  from stray conversation).

This is what prevents the "Make Coffee Book / Go Home / 14" collision and stops unrelated
material (an architecture debate, a real legal case) from contaminating a book's records.

---

## 9. Anti-stall + production tracking  **[A]+[B]**

(Consolidated-update §10, §11.)

- **Anti-stall:** extend the existing loop guard to *book-production state*. Track derived
  state, turns-in-state, manuscript/input versions, review verdicts, unresolved corrections,
  last dispatched job, last accepted transition, next safe actions, progress timestamp. Suppress
  repeated identical reviews/assignments, reopened-without-evidence issues, no-op discussion.
  Threshold ~3 meaningful turns without state change → stop repeating, emit a state diagnostic,
  send ChatGPT a constrained checkpoint, escalate to the user only if genuine user authority is
  required.
- **Tracking:** word counts (from extracted manuscript), versioned chapter + story-so-far
  summaries bound to locked versions, character/relationship/knowledge/setup change **proposals**
  routed through approval (never auto-canon from unreviewed prose), correction records that block
  lock until resolved, optional review scores that never override a critical finding.

---

## 10. Watchdog false-positive fix  **[A]**  *(fold in from the transcript)*

The most-repeated failure. A rejected capture must be **bound to a specific pane + session +
job** before any resend is requested. If it can't be associated, classify it as
`ORPHANED_CAPTURE / STALE_RELAY` and surface to the supervisor — **never** blind-resend into a
fresh session. (Directly complements the §2 detector: with real completion detection, the
"no ending tag" trigger goes away entirely.)

---

## 11. Tests — a reply producing a file must not be enough  **[A]+[B]**

(Consolidated-update §13.) Replace the Lorem-Ipsum fixture with **valid and invalid fixtures
for every artifact type.** Required cases:

1. A `write` reply that says it can't draft is HELD, never becomes a chapter artifact.
2. `BLOCKED`/`FAIL`/`NOT READY` review/lock responses prevent advancement.
3. A PDF made from a failure response satisfies no completion gate.
4. Missing/mismatched/duplicated/nested/reversed/wrong-chapter call-signs are rejected.
5. Only text inside valid chapter call-signs becomes manuscript prose.
6. Routing tags / wrappers / reviews / notes never leak into the manuscript.
7. A chapter can't start without program-owned identity + approved deps.
8. Reviews bind to the exact manuscript version; a revision makes affected reviews stale.
9. A chapter can't lock with unresolved mandatory corrections.
10. Locking Ch1 produces the Ch2 transition instead of ending the book.
11. The next chapter can't draft until the prior chapter is locked.
12. Repeated identical reviews/assignments are suppressed and raise the stall diagnostic.
13. Live Book Studio and exported `book.json` report the same derived state.
14. Final assembly uses only locked manuscript artifacts.
15. **Turn-Complete Detector:** a mid-stream pause is NOT captured; capture fires only on the
    site's done-signal; a "Continue generating" state is stitched, not truncated.

Plus: an unexpected wait timeout **fails** its integration test instead of warning and continuing.

---

## 12. Build order (correct & honest before strict)

The sections have a hidden dependency; sequence so the pipeline is *truthful* before it's *strict*.

1. **Foundation / honesty:** §3 (engine authoritative) · §4 (typed jobs, refusal=held) ·
   §8 (project isolation) · §11 core cases (1–3, 10–11, 13–14). — *A run can no longer lie.*
2. **Capture reliability:** §2 (Turn-Complete Detector) · §10 (watchdog fix). — *We get the
   whole response, every time, and stop false resends.*
3. **Richness:** §6 (state-aware prompts + cold-start) · §7 (checkpoints + status projection) ·
   §9 (anti-stall + tracking).
4. **Strictness last:** §5 (boundaries/call-signs as tolerant aids). — Added only once the
   honest pipeline runs, so strictness can never create an un-completable book.

Resumability is a first-class requirement throughout — the derived-state design already gives
it (state reconstructed from records), so state it and test a mid-run resume.

---

## Section → likely code touch-points (for the implementer)

| Plan § | Primary files |
| --- | --- |
| §2 Detector | new `turn-complete.js` (or in `main.js` pollSite), `selectors` config, `selectors-sync` |
| §3 Authoritative engine | `main.js` (Make Book IPC → `atelier-runner`), `atelier-engine.js`, `atelier-store.js`, `controls.js` cockpit |
| §4 Typed jobs/schemas | `atelier-runner.js` (compose/parse), `atelier-engine.js` (validator chain, HELD state) |
| §5 Boundaries/call-signs | `main.js` (frame/strip/extract), `atelier-runner.js` (parse), tolerant matcher |
| §6 Prompts | `atelier-runner.js` (composePrompt/composeReview), role prompt sources |
| §7 Checkpoints/status | `atelier-engine.js` (`deriveBook`), `controls.js`/`controls.html` cockpit |
| §8 Project isolation | `main.js` (relay dispatch gate), session/project binding |
| §9 Anti-stall/tracking | `main.js` loop guard → book state, `atelier-engine.js` records |
| §10 Watchdog | `main.js` (capture→resend association) |
| §11 Tests | `test/atelier-engine.test.js`, `test/atelier-runner.test.js`, `test/book-run-e2e.test.js`, new fixtures |

*All of the above is a plan. No program files have been modified.*
