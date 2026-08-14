---
doc_id: PENDING_CHANGES
doc_type: staged_revision
owner: claude
version: 1
last_updated: 2026-08-12
canon_status: draft
affects: [SYSTEM_SPEC, PROCESS_DEFECTS]
---

# PENDING CHANGES — MERGED INTO v0.3.3

**Status: ALL ITEMS APPLIED. This file is now a historical record.**

PC-001 through PC-006 were merged into SYSTEM_SPEC v0.3.3 in a single
transaction alongside audit findings F-01 through F-05, per Showrunner
authorization. Retained for provenance; add new staged items below the
historical section as they arise.

---

**Original staging note (historical):**

SYSTEM_SPEC v0.3.2 is frozen (`delivery/FROZEN.txt`) and under audit. Applying
these would change the artifact Gemini is auditing mid-audit, invalidating the
delivered part set and its hashes.

This file exists because the Showrunner issued two directives that conflict on
timing:

1. *"Record this implementation in the next synchronized spec/change-log
   revision."*
2. *"Do not make further architectural changes before Gemini's adversarial
   review... v0.3.2 should otherwise remain stable so Gemini audits a fixed
   target."*

Both are satisfied by staging rather than committing — the same pattern
§18.5.1 applies to canon candidates. A change is recorded where it can be
found, held physically separate from the authoritative document, and merged
only at an approved commit point. **Recording is not committing.**

**Merge trigger:** after Gemini's audit returns and the Showrunner rules on its
findings. These entries fold into that same revision, so the audit findings and
this record land in one transaction rather than two.

**None of these are architectural changes.** All four are records of work already
completed and verified. No rule, ruling, or structure changes.

---

## PC-001 — `check_jobs.py` is implemented, not planned

**Target:** SYSTEM_SPEC §33, script 14.

**Current text** lists `check_jobs.py` among scripts to be built ("stale-input
detection and duplicate-delivery quarantine").

**Change:** mark as **implemented**. Now provides:
- §4.7 P1/P2/P3 provisional classification, including the governing catch-all
  (HIGH reversal cost **or** expensive downstream propagation)
- §29 `PROCESS_VIOLATION` vs. S0 classification
- log-wide gate guard (`gate_blocked`)
- a Decision Log parser
- CLI: `python check_jobs.py DECISION_LOG.md`, exit 0 clean / 1
  `PROCESS_VIOLATION` / 2 S0

---

## PC-002 — `test_provisional_classifier.py` and its six fixture classes

**Target:** SYSTEM_SPEC §33 (new entry) and §30.1.2.

**Change:** record the suite as the PDF-001 regression test.

| # | Fixture | Asserts |
|---|---|---|
| 1 | attempted P3 blocked before creation | `PROCESS_VIOLATION` |
| 2 | P3 provisional actually created | **S0** |
| 3 | downstream inheritance from a P3 provisional | **S0** |
| 4 | approval gate blocked log-wide | gate blocks on S0; a contained `PROCESS_VIOLATION` does **not** block |
| 5 | catch-all coverage | HIGH cost **or** expensive propagation qualifies as P3 with no named-scope match; ordinary P1 is not swept up |
| 6 | live `DECISION_LOG.md` | clean — all six decisions FINAL |

Result at time of staging: **6/6 passing.**

**Note carried forward:** fixture 4 originally asserted that a
`PROCESS_VIOLATION` *does* block gates, and passed. The Showrunner later ruled
the opposite. The test encoded a belief, not a truth. This is the third instance
of that pattern (PDF-003, PDF-004, and this), and the common thread is that a
suite defends against regression from a baseline it cannot itself validate.

---

## PC-003 — `--prove` red-state verification

**Target:** SYSTEM_SPEC §30.1.2, step 4.

**Change:** record that both suites carry a standing self-check.
`test_assembler.py --prove` and `test_provisional_classifier.py --prove` each run
a deliberately wrong expectation and **pass only if that case fails**.

This makes §30.1.2's "verify the test fails before the fix and passes after it"
continuously checkable rather than a one-time claim at authoring. A green suite
that cannot go red is worse than no suite: it manufactures confidence without
evidence.

---

## PC-004 — PDF-001 corrected to S0

**Target:** already applied in `PROCESS_DEFECTS.md`; record in the SYSTEM_SPEC
change-log.

**Change:** PDF-001 reclassified S1 → **S0**. The defect crossed from attempted
violation into actual provisional adoption **and downstream propagation** —
§18, §29, and §30 were built on DEC-003 before it was ruled.

Historical reasoning preserved in the entry, including that the decision was
subsequently ruled correct. That is the dangerous case: a bad process producing
a good outcome is much harder to notice, and would not have surfaced at all had
the ruling never arrived.

---

## PC-005 — Tests and specification review are separate controls

**Target:** SYSTEM_SPEC §30.1.2 and §26 (engineering guidance).
**Source:** Showrunner process finding, 2026-08-12.

> **Tests establish conformity to an encoded specification. They do not
> establish that the specification itself is correct.**
>
> Specification review and executable regression testing are therefore separate
> controls, and **neither substitutes for the other.**

**Why this earns a place in the spec rather than a footnote:** it is the
generalization of three recorded defects, and without it the register reads as
three unrelated accidents.

| Defect | What a green suite failed to catch |
|---|---|
| PDF-003 | An assertion whose comparison basis was corrupted by the operation under test |
| PDF-004 | A sweep that only tested for presence, never absence |
| Fixture 4 (§4.7 gate rule) | A test that encoded the gate rule the Author believed, and passed, while the rule itself was wrong |

The third is the cleanest illustration: `test_provisional_classifier.py` ran 6/6
green while asserting that a contained `PROCESS_VIOLATION` blocks approval gates.
The suite was working correctly. The specification it encoded was wrong. Only
Showrunner review caught it, and no amount of additional testing would have.

**Implication for §26 review tiering:** scripted checks run before model review
because arithmetic is cheaper and deterministic — but this establishes the
boundary. Scripts verify conformity to the rules; only review verifies the
rules. A system that pushed everything to scripts as they matured would slowly
lose the only control capable of finding a wrong rule.

**Practical rule to add:** a passing regression suite is never evidence that a
rule is correct — only that behavior matches the rule as encoded. Rule
correctness is established by independent review, and every rule change must
carry a review record, not merely a green test.

---

## PC-006 — SYSTEM_SPEC Appendix A item 2 carries superseded §12 wording

**Target:** SYSTEM_SPEC Appendix A, `[VERIFY]` item 2.
**Severity:** S3 (wording consistency). **Not S0/S1 — staged, not applied.**

**Current spec text (frozen, unchanged):**
> §12 — Character identity consistency across image generations. **Current
> correctness-preserving default: turnaround text is canonical; generated imagery
> is decorative and never a source of truth.** Verification may determine whether
> reliable reference imagery can later be promoted through an explicit design
> ruling; **it does not block §12.**

**Approved replacement for the trailing clause:**
> Findings may optimize the turnaround-image workflow, but generated imagery
> remains decorative/reference-only and never becomes a source of canonical
> truth. Does not block §12.

**Why staged and not applied:** the Showrunner directed that no edits be made to
the frozen audit target except for S0/S1 defects. This is S3 — the *operative*
clause ("generated imagery is decorative and never a source of truth") is already
correct and matches the new formulation's substance. Only the trailing sentence
differs, and the superseded phrasing is weaker rather than wrong: it leaves open
that imagery "can later be promoted," which the replacement forecloses.

**Known divergence while staged:** `DECISION_LOG.md` now carries the approved
wording; `SYSTEM_SPEC.md` Appendix A carries the superseded wording. Recorded
here so the divergence is deliberate and visible rather than discovered later.
Both are corrected in the same v0.3.3 transaction.

**Provenance note:** the superseded phrasing was not an unsynchronized leftover —
it is verbatim the wording the Showrunner prescribed in an earlier ruling and has
since revised. Recording this so the change reads as a refinement rather than a
missed correction.

---

## Draft change-log entry for the next revision

> **v0.3.3** — Implementation record and engineering guidance; no architectural
> change.
> `check_jobs.py` implemented (§33, script 14): P1/P2/P3 classification with the
> HIGH-cost / expensive-propagation catch-all, `PROCESS_VIOLATION` vs. S0
> classification, and log-wide gate guard. `test_provisional_classifier.py`
> added as the PDF-001 regression test, six fixtures, 6/6 passing. Both test
> suites carry `--prove` red-state verification, making §30.1.2 step 4
> continuously checkable. PDF-001 corrected S1 → S0 with historical reasoning
> preserved. Engineering guidance added (§30.1.2, §26): tests establish
> conformity to an encoded specification, not the correctness of the
> specification itself; specification review and executable regression testing
> are separate controls and neither substitutes for the other.


---

## IMPLEMENTATION GAP — §4.12.1 `--ref` is specified but not built

Surfaced while refuting a false status claim (PDF-006, third occurrence).

§4.12.1 mandates that every validation script take an explicit `--ref` defaulting
to `HEAD`. **No script implements this yet:**

| Script | Status |
|---|---|
| `check_jobs.py` | exists; no `--ref` handling |
| `build_depgraph.py` | not written |
| `check_registers.py` | not written |
| `resolve_facts.py` | not written |

**This is not a defect.** The specification legitimately runs ahead of the code —
Phase 2 is where these are built (§36). It is recorded so the gap is visible and
so no future status report can claim the rule is implemented without a check.

**Closing condition:** each script, when written, ships with `--ref` and a test
asserting it refuses to default to trunk.


---

## PC-007 — SYSTEM_SPEC header status label (STAGED — do not apply during audit)

**Target:** SYSTEM_SPEC.md header, `**Status:**` line.

**Current (frozen, unchanged):**
> Status: DEC-001..006 FINAL · Gemini partial audit integrated (F-01..F-05,
> V1..V4) · Gate: PASS WITH REQUIRED FIXES — PENDING FOCUSED RE-AUDIT

**Correct label per Showrunner ruling:**
> Gate: PENDING_AUDIT — PASS WITH REQUIRED FIXES · FAILURE-INJECTION COVERAGE
> PARTIAL

*(Updated: an earlier revision of this staged record named
`PENDING_AUDIT — FOCUSED RE-AUDIT`, which has since been superseded. Because
PC-007 is **prescriptive** — it states the label to be written at the post-audit
transaction — leaving the old form would have applied a superseded label at
merge time. The quotation above it is historical and is unchanged.)*

**Why staged rather than applied:** *PASS WITH REQUIRED FIXES* is the disposition
of the prior cycle against v0.3.2, not a PASS for v0.3.3 — so the header is
misleading. But correcting it would alter `WHOLE_SHA256` and invalidate the exact
candidate Gemini has been dispatched to audit. The Showrunner directive is
explicit: no specification mutations while Gemini audits this hash; newly
discovered issues are staged separately.

**Operative correction is recorded in `PROCESS_DEFECTS.md`**, which is outside
the audit payload and therefore authoritative on gate state in the interim.

**Merge trigger:** on close of the focused re-audit, folded into the same
transaction as its findings.


---

## F-07 / F-08 IMPLEMENTED — `transaction.py` (2026-08-12)

Per Showrunner ruling on Round 2. **Script-layer only; SYSTEM_SPEC v0.3.3
unchanged and still frozen.**

**F-07 — STALE_JOB is now a hard blocker.** `transaction.py check` compares a
job's version-locked inputs against current controlling inputs and blocks the
commit unless *either* the job was rebased, *or* an authorized acceptance exists
in `DECISION_LOG.md` that names the job **and is version-locked to the exact
inputs it ran on**.

*Correction adopted from the ruling:* I had invented a signed `override_reason`
format. The existing Decision Log mechanism represents authorized acceptance
cleanly, so no new format was introduced. The version-lock requirement is the
load-bearing part — an acceptance that does not name the exact input versions
accepts nothing in particular and would remain valid after the inputs moved
again.

*Severity split per §29:* blocked attempt → `PROCESS_VIOLATION` (exit 1);
a stale job that actually reached COMMITTED → **S0** (exit 2).

**F-08 — durable crash recovery.** The ruling correctly rejected `try/finally`:
it does not survive SIGKILL, power loss, or reboot. Recovery is now driven by a
**durable job lifecycle record** written with `fsync` + atomic rename, so a crash
mid-write leaves either the old record or the new one, never a truncated file.

On startup, `transaction.py recover` finds every job lacking a COMMITTED
transition that still holds a branch, marks it `RECOVERY_REQUIRED`, and **never
auto-merges**. Disposition is recorded durably. A branch containing partial
propagation is evidence, not authority.

**F-06 — NOT implemented,** per ruling. Nested-marker handling already exists
and was verified by execution; the proposed correction for injection 15 would
have the assembler strip content, violating the Non-Interpretation Clause.

**Tests:** `test_transaction.py`, 9/9 passing, `--prove` red-state guard
confirmed. Crashes are simulated by `SIGKILL` of a real subprocess at four
lifecycle stages — not by raising an exception, since the entire point of F-08
is that cleanup handlers do not run.

### Fail-before / pass-after evidence (Showrunner requirement)

`test_transaction.py` accepts `ATELIER_TX=<path>` so the identical suite can be
run against an alternate implementation. A **pre-fix build** was constructed with
only the two controls removed — F-07 staleness made advisory, F-08 startup
recovery reduced to the `try/finally`-era no-op — everything else byte-identical.

```
BEFORE FIX (controls removed)          AFTER FIX
  FAIL  F-07a stale -> BLOCKED           PASS  F-07a
  PASS  F-07b rebased -> eligible        PASS  F-07b
  FAIL  F-07c authorized acceptance      PASS  F-07c
  FAIL  F-07d unlocked -> still BLOCKED  PASS  F-07d
  FAIL  F-07e committed stale -> S0      PASS  F-07e
  FAIL  F-08  SIGKILL -> RECOVERY_REQ    PASS  F-08
  PASS  F-08b committed not flagged      PASS  F-08b
  FAIL  F-08c disposition durable        PASS  F-08c
  PASS  state machine invalid -> S0      PASS  state machine
       3/9 passed, exit 1                     9/9 passed, exit 0
```

**Six of nine fail before and pass after.** The three that pass in both builds
are correctly insensitive to these controls: F-07b exercises the current-inputs
path that never blocked; F-08b passes trivially when recovery does nothing; the
state-machine case tests an unrelated control.

That last point matters — a suite where *every* test flipped would be evidence
the tests were coupled to the implementation rather than to the requirement.

**Staged for the post-audit transaction:** record `transaction.py` and
`test_transaction.py` in §33, and reference the recovery procedure from §4.11.


---

# STAGED FOR NEXT SYNCHRONIZED TRANSACTION

Per Showrunner ruling on AUDIT_TRIAGE_002. **Nothing applied. SYSTEM_SPEC
unmutated at `25cf6d739b6f5238…`.** PC-001–PC-007 untouched.

## PC-008 — F-06 residual: non-emitting structural failure in all modes

**ACCEPTED.** Disposition: **F-06 — ORIGINAL FINDING STALE; MODIFIED S3
RESIDUAL OPEN.**

Required behavior: nested or unclosed manuscript markers are non-emitting
structural failures **in all modes**. The offending file contributes zero
manuscript output until corrected. **Other valid files in the same run may
continue** unless another rule independently requires whole-build failure.

**Injection 15 semantics unchanged** — notes inside markers remain manuscript
content by position and may not be semantically removed by the assembler.

**Regression matrix — all four required cases, executed:**

| Case | Mode | Exit | Output written |
|---|---|---|---|
| nested `Start` | non-strict | 2 | **none** |
| nested `Start` | `--strict` | 2 | **none** |
| unclosed `Start` | non-strict | 2 | **none** |
| unclosed `Start` | `--strict` | 2 | **none** |

Tests: `test_assembler.py::t13` (nested, both modes), `::t13b` (scoping — a
clean file in the same run still assembles), `::t14` / `::t14b` (unclosed, both
modes). Suite 11/11.

**Residual remains OPEN pending independent audit.** Implemented ≠ audited.

---

## PC-009 — F-07: CORE STALE_JOB DETECTOR IMPLEMENTED + TESTED; VALIDATE-INTEGRATION INCOMPLETE

**Split state, per ruling. Do not label F-07 globally implemented or
unimplemented.**

**IMPLEMENTED + TESTED — preserved:** `transaction.py` establishes the stale-input
decision logic and its regression evidence. Blocked stale commit attempt →
`PROCESS_VIOLATION`; a stale result reaching authoritative COMMITTED → **S0**.

**INCOMPLETE — mechanical integration.** A real VALIDATE path must invoke the
detector **automatically before merge**. *A safeguard that exists only as a
separately invokable command does not satisfy the pipeline guarantee.* Nothing
today forces the call; a VALIDATE stage that omits it passes.

**Authorized acceptance record** — repository-recorded in `DECISION_LOG.md`,
identifying: `job_id` · stale controlling input versions · current controlling
versions · reason rebase is unnecessary · **exact output/input version set being
accepted**. The last field is not yet enforced.

**Terminology:** "signed" not used. Role-authorized and repository-recorded.

---

## PC-010 — F-08: DURABLE RECOVERY CORE IMPLEMENTED + TESTED; RECOVERY METADATA/DISPOSITION INCOMPLETE

**Split state, per ruling.**

**IMPLEMENTED + TESTED — preserved:** `fsync` + atomic-rename lifecycle records;
SIGKILL regression evidence at four lifecycle stages; startup detection of
surviving non-COMMITTED transactions; non-mergeable marking; `base_commit`
recorded; clearing conditioned on `--merge-verified`; QUARANTINE as default
disposition.

**INCOMPLETE:**

| Requirement | State |
|---|---|
| Record removed only after **authoritative** merge success | `--merge-verified` is a **caller assertion**, not verified against git |
| Recovery returns workflow authority to recorded last committed/base state | `base_commit` recorded; no mechanism returns authority to it |
| Diagnostics preserved before optional destruction | QUARANTINE is default; **capture step itself not implemented** |
| Destruction as explicit later disposition | flag exists; no separate post-capture stage |

`try/finally` and signal handlers remain **secondary cleanup only** — not the
recovery guarantee.

---

## PC-011 — Evidence ruling

**ACCEPTED.** Gemini's claims about execution it could not perform remain **audit
hypotheses, not runtime evidence.** Specification review is not converted into
test evidence.

**§4.12.1 `--ref` remains SPECIFIED, IMPLEMENTATION-UNPROVEN.**
`check_manuscript.py` accepting and printing `--ref` without reading that ref
**is not an implementation of §4.12.1.** The decorative argument must either be
made real through ref-scoped reads **or removed until real support exists** —
real ref-scoped evaluation preferred when the validator is brought into scope.


---

# CLOSURE-CONDITION WORK — F-06 / F-07 / F-08 (staged; NONE closed)

All three remain **PARTIAL / IMPLEMENTED-CORE WITH OPEN CLOSURE CONDITIONS**.
Local results do not close them. Author-run tests are **not** converted into
independent-audit coverage. `SYSTEM_SPEC` unmutated at `25cf6d739b6f5238…`.

## Priority 1 — F-07 validation made unavoidable at the merge boundary

**Was:** `check` existed as a separately invokable command; a VALIDATE path that
never called it passed.

**Now:** the guard runs *inside* `commit`. `--inputs` is **required**; omitting
it is S0 with the reason stated. A stale job is blocked at the commit/merge
boundary even when the merge itself is valid.

`test_transaction.py::t7h` (omitting the guard is S0) · `::t7i` (stale blocked at
commit despite a real merge).

**Closure condition remaining:** the guard is unavoidable *in this entry point*.
A different merge path that bypasses `transaction.py commit` entirely would
still bypass it. Full closure needs the pipeline to have no other authoritative
merge route.

## Priority 2 — F-08 `--merge-verified` replaced with repository evidence

**Was:** `--merge-verified` was a caller assertion.

**Now:** `--merge-ref <ref>` and verification via
`git merge-base --is-ancestor <branch> <ref>`, inside a real work tree, with both
refs required to resolve. The open-transaction record clears **only** on that
evidence.

*An assertion by the party that benefits from it is not evidence;
`merge-base --is-ancestor` is checkable by anyone.*

`::t8g` (unmerged branch → S0, citing "NOT an ancestor") · `::t8h` (genuinely
merged branch clears the record). Both build real git repositories.

**Closure condition remaining:** ancestry proves the commits are reachable, not
that *this* transaction's merge produced them. A branch merged by some other
process satisfies the check.

## Priority 3 — F-06 × `--normalize-markers` interaction coverage

**Now covered:** a file that is *both* noncanonical *and* structurally broken is
normalized in form and still emits **zero output**. Normalization repairs marker
form; it must never convert a structural failure into an emitting build.

`::t_norm_struct` (noncanonical + nested) · `::t_norm_unclosed` (noncanonical +
unclosed). Both assert normalization occurred **and** that no file was written.

## Regression evidence

```
assembler suite:          13/13   (was 11/11; +2 normalize interaction cases)
transaction PRE-FIX:      11/18
transaction POST-FIX:     18/18
earlier F-07/F-08 round:  PRE-FIX 1/14 -> POST-FIX 14/14  (preserved)
```

The earlier 1/14 → 14/14 result and the pre-fix build used to establish it are
preserved as recorded regression evidence.

## Evidence notes carried forward

**`t13` correction** — additional evidence for the existing rule that a green
regression test proves conformity to its encoded expectation, not the
correctness of that expectation. `t13` asserted the outer block still assembled
and passed while encoding the defect. **No duplicate process defect created**;
the existing control did not fail in a materially new way.

**`t8e`** remains specifically identified as evidence that recovery keys on
**surviving transaction authority** rather than a mutable lifecycle label: it
forges a record whose state was flipped to `COMMITTED` while the merge failed,
and the surviving `open_transaction` flag catches it.


---

# EXECUTION REPORT — three priorities

**No SYSTEM_SPEC mutation.** Frozen at `25cf6d739b6f5238…`.

## 1. What changed

| File | Change |
|---|---|
| `transaction.py` | Priority 1 — the STALE_JOB guard runs **inside** `commit`; `--inputs` required, omission is S0. Priority 2 — `merge_is_real()` verifies `git merge-base --is-ancestor` inside a real work tree; `--merge-verified` assertion removed |
| `test_transaction.py` | `t7h`, `t7i`, `t8g`, `t8h` added; helpers build **real git repositories** (merged and unmerged) |
| `test_assembler.py` | Priority 3 — `t_norm_struct`, `t_norm_unclosed`: normalization repairs marker form and never rescues a structural failure |
| `test_controls.py` | `--prove` red-state guard added — it was the one suite that could not demonstrate its own capacity to fail |

## 2. Proof

```
test_assembler.py               13/13     --prove: FAIL (correct)
test_provisional_classifier.py   6/6      --prove: FAIL (correct)
test_transaction.py             18/18     --prove: FAIL (correct)
test_controls.py                 8/8      --prove: FAIL (correct)
```

**All four suites now demonstrably capable of going red.**

Targeted evidence:

```
PASS  F-07h  commit without --inputs is S0 — guard cannot be skipped
PASS  F-07i  stale job BLOCKED at commit even with a valid merge
PASS  F-08g  unmerged branch cannot clear the open transaction ("NOT an ancestor")
PASS  F-08h  genuinely merged branch clears it
```

Before/after, transaction suite: **PRE-FIX 11/18 → POST-FIX 18/18**. Earlier
round preserved: **1/14 → 14/14**.

F-06 matrix, all four cases, zero output: nested/unclosed × non-strict/`--strict`.
Pre-fix non-strict **wrote a file**; post-fix writes none.

## 3. Remaining gaps

| Gap | State |
|---|---|
| F-07 VALIDATE integration | Guard unavoidable **in this entry point**. Another authoritative merge route would still bypass it |
| F-08 merge verification | Ancestry proves commits are reachable, **not that this transaction's merge produced them** |
| §4.12.1 `--ref` | SPECIFIED, IMPLEMENTATION-UNPROVEN. IMPL-GAP-001 open |
| §4.12, §17, §18.4, §20/21 | Specified, no code |
| §4.10.3, §24 | Partial |
| §36 surfaces 1–11, 18, 21, 22 | Unproven |
| **All local proof** | **Awaiting independent audit. No surface has auditor execution credit** |

## 4. State changes that legitimately advance

- `test_controls.py` gains red-state proof → **§30.1.2 step 4 satisfied for all four suites.**
- Surfaces 13 and 14: local execution **PROVEN** (already recorded).
- **No F/PC finding advances to closed.** F-06, F-07, F-08 retain their split
  states — executed evidence advances *local* proof only, and closure for all
  three requires independent audit or the named integration work.

## 5. Gate impact

**None. The audit gate does not advance.**

`PENDING_AUDIT — PASS WITH REQUIRED FIXES · FAILURE-INJECTION COVERAGE PARTIAL`

Author-run execution is not independent evidence. Every result above is local
proof and is recorded as such.
