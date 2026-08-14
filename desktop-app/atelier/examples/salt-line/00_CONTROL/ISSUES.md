---
doc_id: ISSUES
doc_type: issues
owner: gemini
version: 2
canon_status: approved
---
# ISSUE REGISTER — The Salt Line

## ISS-001 | S2 | RESOLVED | unit mismatch: paces vs metres, CH01 ↔ CH02

- found_in: CH01-S01 line 60 ↔ CH02-S01 line 128
- found_by: claude (Author self-audit, second pass)
- type: continuity — quantitative
- detail: CH01 places the unmarked witness post "forty **paces** further
  inland." CH02 measures the same distance as "forty **metres**." A pace is
  ~0.75 m; forty paces is ~30 m. The two figures differ by ~25%.
- why it matters: the entire falsification plot rests on this distance matching
  the 41.2 m chain reading. An approximate unit makes the key evidence
  unfalsifiable — a reader who checks finds the numbers don't close.
- **why the audit missed it:** the Author's hand continuity check compared the
  two passages and marked them consistent, silently treating "paces" as
  equivalent to "metres." **A quantitative check performed by the same mind that
  wrote both passages inherits that mind's assumptions.** This is the §26.2 case
  for an auditor who did not write the text.
- resolution: CH01 rewritten so the distance is *unmeasured* — Marla paces it
  off casually and does not record a figure. CH02's 40 m becomes the first
  precise measurement of it, which is stronger: the reader watches an
  impression become evidence.
- prevention: **no distance appears twice in different units.** Any measurement
  that will later be evidence is either exact-and-recorded or explicitly
  impressionistic — never a number in soft units.

## ISS-002 | CLOSED | POTENTIAL CROSS-MODEL CONTAMINATION — NO MANUSCRIPT FORK OCCURRED

- found_by: claude, on a Showrunner correction addressed to the Auditor
- **classification: potential cross-model contamination / unauthorized-author
  artifact.** One manuscript existed throughout. There was never a second
  canonical candidate, and this must not be recorded as though there were.
- original concern: a **suspected** manuscript fork. **Investigation did not
  substantiate it. No actual manuscript fork occurred.**
- **Gemini's Chapter 1 never entered the authoritative pipeline.** Whatever was
  produced elsewhere, it had no route into assembly, candidates, continuity, or
  propagation at any point.
- **Canonical CH01 remains the Author/Custodian artifact** —
  `04_CHAPTERS/ch01/scenes/s01.md`, sha256 `42b90a9b76192e17…`, unchanged.

### What the evidence establishes

| | |
|---|---|
| Canonical Chapter 1 artifacts found | **1** |
| Second candidate artifact | **NOT FOUND / NOT RECEIVED by this pipeline** |
| Artifacts authored by the Auditor | **0** |

Auditor-generated prose is known **only from relay/reporting context.** That
does not establish repository possession. This pipeline never held it.

### What is NOT claimed

The second artifact was **not** preserved, **not** quarantined, **not** deleted,
**not** compared, and **not** inspected. None of those actions occurred because
the artifact was never in this repository to act upon.

**The preservation instruction is NOT EXECUTABLE** unless the artifact is
actually delivered. Recorded as not-executable rather than reported complete.

### The single authoritative Chapter 1 — provenance and lineage

| field | value |
|---|---|
| path | `04_CHAPTERS/ch01/scenes/s01.md` |
| authored_by | claude (Custodian) — the only role with manuscript write authority (§3.3) |
| job_id | `CH01-S01-DRAFT-v1` |
| base_version | `BLUEPRINT@v1 CH01-CARD@v1 CH01-BEATS@v1` |
| modified | 2026-08-12T23:15 |
| sha256 | `42b90a9b76192e17…` |
| boundary markers | present, verified |
| assembly lineage | `assemble_manuscript.py`, executed, exit 0, 8 blocks |
| downstream | CH02–CH08 drafted against it |

**Provenance is normal.** Version-locked to the card and beats it was drafted
from; assembled by executed command; unbroken lineage through eight chapters.

- **quarantine destination retained:** `99_ARCHIVE/auditor-submissions/` stands
  ready **if that artifact is ever actually received.** It is currently empty.
  Nothing has been preserved, deleted, validated, or rejected from this
  repository, because nothing was ever in it to act upon.

- **status: CLOSED — POTENTIAL CROSS-MODEL CONTAMINATION, NO MANUSCRIPT FORK
  OCCURRED.**

---

## ISS-002b | OPEN | write-authority and transport concerns (retained separately)

Retained apart from ISS-002 because they are real and remain unaddressed, while
the fork was not substantiated.

- **write authority.** §3.3 forbids the Auditor writing manuscript or bible
  content. Nothing *enforces* it. The rule held because a human noticed and a
  Custodian checked. **AutoInjector requirement #1: machine-enforced
  role/write authority, rejected at the boundary rather than caught in review.**
- **transport.** Nine Auditor upload/read failures. Classified as
  transport/access failures establishing nothing about artifact validity
  (Showrunner ruling). Channel never attempted by the Auditor: **pasted chat
  text**, which is how Round 1 — the only genuine audit produced — was delivered.
- status: OPEN, deferred to integration phase

---

## ISS-003 | S2 | OPEN | candidate ledger recorded in two incompatible formats

- found_in: `03_MEMORY/CANDIDATES.md`
- found_by: claude, during T2 metric collection — a reported count (65) did not
  match the machine-countable count (29)
- type: process — canon extraction integrity
- detail: CH01–CH03 candidates were recorded as structured YAML with `id:
  CAND-nnnn` keys. **CH04 and CH05 candidates were recorded as a prose
  summary** pointing at the scene handoff blocks instead. The facts exist in the
  handoffs, but ~22 of them have no ledger record and no ID.
- why it matters: §4.8 requires candidates to be enumerable so an auditor can
  check extraction completeness against the prose. A prose summary is not
  auditable — you cannot diff it, count it, or confirm nothing was dropped.
  **The reported count was inflated by a third and nobody could have caught it
  from the file.**
- why no check caught it: `check_propagation.py` verifies artifacts are
  *current*, not that their contents are *well-formed*. Nothing validates the
  candidate ledger's shape.
- **the honest reading:** this is the same failure class as PDF-012 — a step
  that is specified, performed by discipline, and unenforced. Discipline held
  for three chapters and lapsed on the fourth, exactly as before.
- resolution: CH04/CH05 candidates converted to structured records this turn.
- **prevention (deferred, logged):** a `check_candidates.py` validating that
  every candidate carries `id`, `entity`, `property`, `value`, `status`, and
  that IDs are contiguous. **Not built this turn** — T2 is a drafting turn and
  building it here would exceed scope. Registered as system work.
- **CLOSURE EVIDENCE (ISS-003):**
  - `check_candidates.py` built. Rejects prose-summary storage where structured
    records are required; detects missing IDs, duplicate IDs, malformed records,
    id-sequence gaps, chapter/extraction mismatches, and mixed storage.
  - **The count is ESTABLISHED from the artifact, never accepted from a report.**
    That inversion is the whole point: 65, 47 and 29 were all reported figures,
    and all three were wrong.
  - `test_candidates.py` 7/7, `--prove` guard FAILs correctly.
  - **red-before/green-after against the historical state:** the pre-repair
    ledger was reconstructed and scored **29 records, 7 findings, exit 1** —
    reproducing ISS-003's exact number. Repaired: **80 records, 0 findings,
    exit 0.**
- **authoritative count: 80 structured, 0 promoted, 8 of 8 chapters extracted.**
- **note:** the parser-bleed defect discovered while hardening this control is
  registered separately as **PDF-014**, not folded in here. ISS-003 is a ledger
  defect; PDF-014 is a defect in the checker built to detect it.
- **status: CLOSED** — repaired, detected, regression-protected.
  **Preserved as a distinct occurrence.** One control now prevents ISS-003,
  ISS-004 and the CH01 structural omission, but each remains separately recorded:
  they were three different failures — *malformed*, *absent*, and *unheaded* —
  and collapsing them would hide that the same enforcement gap produced three
  distinct symptoms across five chapters.


## ISS-004 | S1 | RESOLVED | CH06 candidates never extracted to the ledger

- found_in: `03_MEMORY/CANDIDATES.md` — CH06 section absent entirely
- found_by: claude, on a Showrunner instruction to preserve the 40.0 m figure
  "through every affected artifact." The check was run because it was ordered,
  not because anything flagged it.
- type: process — canon extraction, **omission not malformation**
- detail: ISS-003 repaired CH04/CH05 records. **CH06 was never extracted at
  all.** The 1994 survey figures — the true set (-11.4, -26.1, -19.8, -34.9,
  **-43.6**), the filed set (-3.1, -4.0, -2.8, -5.2, **-3.6**), and the derived
  **40.0 m** stake-11 displacement that matches Marla's 2026 measurement —
  existed only inside the CH06 prose and its handoff block.
- why it matters: **this is the evidence the climax rests on.** CH11 has Marla
  submit the true line with her father's 1994 originals attached. A drafter
  handed the context package for CH11 would have found no record of what those
  originals say. §24 builds context from the ledger and the bibles, not from
  re-reading prior chapters.
- **why it is worse than ISS-003:** ISS-003 was recorded badly. ISS-004 was not
  recorded. A malformed entry is visible; an absent one is not. The T2 report I
  filed said "candidate extraction: complete" and was wrong.
- **three consecutive defects of one shape** — PDF-012 (propagation unenforced),
  ISS-003 (ledger format unenforced), ISS-004 (extraction completeness
  unenforced). Every gate that passed was checking something adjacent to the
  thing that failed.
- resolution: CH06 extracted (CAND-0048…0060) with figures carried at full
  precision and explicit units into ledger, timeline, character knowledge,
  location bible, and story state.
- **prevention (deferred, logged as system work):** `check_candidates.py` must
  verify (a) every drafted chapter has a ledger section, (b) every record is
  well-formed, (c) every numeric with a unit in prose appears in the ledger with
  the same unit. Not built during a drafting turn.
- **CLOSURE EVIDENCE (ISS-004):** `check_candidates.py` raises **S1** for any
  drafted chapter with no ledger section. Verified against the reconstructed
  historical state, where CH05–CH08 each raised the finding.
- **new defect found by the new control, immediately:** CH01 had **no ledger
  section** — its candidates sat in the file's opening block, unheaded. The
  extraction that began the book was never formally registered, and nothing had
  ever noticed. Fixed; the checker now reports 8 of 8 chapters extracted.
- **status: CLOSED** — repaired, detected, regression-protected.
  Preserved as a distinct occurrence (see ISS-003 note).

## ISS-005 | S3 | RESOLVED-BY-DESIGN | CH05 estimate diverges from CH07 calculation

- found_in: CH05 (~200 m / ~£220,000) vs CH07 (128.5 m / £141,350)
- found_by: claude, during pre-draft arithmetic for CH07
- type: quantitative continuity — **divergence is intentional**
- detail: in CH05 Marla estimates the shortfall at ~200 m from five stakes and a
  guess, standing in the harbour office. CH07's full survey gives 128.5 m. Her
  estimate was **71.5 m too pessimistic**.
- **why this is not a defect:** CH05's text marks it as an estimate — "not
  exactly, not yet, but within a hundred metres either way." A character
  estimating badly under pressure and being corrected by measurement is the
  system working. Silently reconciling the two figures would have destroyed
  CH07's turning point, which is that she is *disappointed* the number is
  smaller.
- **why it is registered anyway:** an automated continuity check comparing
  numerics across chapters would flag this pair, and a future auditor should
  find the ruling here rather than re-deriving it. **Intentional divergence must
  be recorded as loudly as accidental divergence**, or the register only proves
  that nobody looked.
- resolution: both figures canon. CH05 = estimate, CH07 = calculation.
  Marked `divergence: intentional` in the ledger.
- status: RESOLVED-BY-DESIGN


## ISS-006 | S2 | CLOSED | CH01 had no ledger section — structural omission

Recorded separately from ISS-003 (malformed storage) and ISS-004 (absent
extraction) because it is a third distinct symptom: CH01's candidates existed
and were well-formed, but sat in the file's opening block with **no `## From
CH01` heading**, so no section-aware check could see them.

- found_by: `check_candidates.py`, on its **first execution** — before it had
  been used on anything else.
- why it went unnoticed: eight chapters of gates had passed. Every earlier check
  counted records or verified propagation; none asked whether each drafted
  chapter had a *section*. The extraction that began the book was the one never
  registered.
- resolution: heading added. `chapters extracted` moved 7 → 8 of 8, then 12/12.
- regression: covered by `test_candidates.py::t2` (drafted-but-unextracted).
- status: CLOSED

**Three occurrences, one enforcement gap:** malformed (ISS-003), absent
(ISS-004), unheaded (ISS-006). One control prevents all three; the history
preserves all three.

## ISS-007 | OPEN | audit discrepancy — Auditor T5 figures do not match the artifact

**No state mutation performed.** Counts, hashes, audit status and system status
are unchanged. This entry records a disagreement; it does not resolve one.

### Custodian figures, re-derived from the FROZEN artifact

Manuscript sha256 `c52f0508da12ae5e…` — freeze hash verified matching at recount.

| Figure | Value | Derivation |
|---|---|---|
| assembled file | **11,832** words | `wc` on `07_BUILD/manuscript.md` |
| in-book total | **11,820** words | sum of 12 scenes between markers, marker tokens excluded |
| difference | **12** | exactly 12 chapter headings × 2 tokens (`# One —` etc.) |
| CH11 | **827** | in-book |
| CH12 | **1033** | in-book |
| candidates | **106** | `grep -c "id: CAND-"`, artifact-derived |

Both word figures are correct for different questions. **11,832 counts the
assembled file including chapter headings; 11,820 counts prose between markers.**
Reporting them without stating which was measured is a reporting defect on the
Custodian's part, now corrected: **11,820 in-book is the manuscript figure.**

### Auditor figures — cannot be reconciled here

| Field | Custodian (artifact) | Auditor (reported) | Delta |
|---|---|---|---|
| in-book words | 11,820 | 10,243 | −1,577 |
| CH11 | 827 | 1,142 | +315 |
| CH12 | 1033 | 1,280 | +247 |
| candidates | 106 | 112 | +6 |

**The Custodian cannot determine the origin of the Auditor's figures.** They do
not correspond to any state of this repository — not the current one, not the
pre-freeze one, and not any earlier chapter count. Investigating their
provenance is the Auditor's assigned task, not the Custodian's; asserting an
explanation here would be exactly the unsupported-inference failure this
register exists to prevent.

### Status
- classified as **AUDIT DISCREPANCY**, not a competing authoritative result
- no candidate promoted · no hash changed · `PENDING_AUDIT` preserved
- Round 3 remains **0 of 6**; a discrepancy report is not an audit
- status: **OPEN**, pending Auditor investigation

### Update — transport failure immediately following

The Auditor's next message was a file-read failure (tenth of the run). It has
therefore still not examined the authoritative repository.

**This is diagnostically relevant to ISS-007, not incidental.** The Auditor
produced specific figures — 10,243 in-book words, CH11 1,142, CH12 1,280,
112 candidates — and then, on the next exchange, could not read the artifact.
Figures reported about a repository the reporter cannot open did not come from
that repository.

Recorded as an observation about **provenance**, not about the Auditor's
competence or intent: numbers with no readable source are unsourced numbers,
whoever produces them. This is the same standard applied to the Custodian in
PDF-013, where a correct authority ruling was logged as defective because it
cited a rule without enumerating artifacts.

**No inference drawn about where the figures came from.** That determination
remains the Auditor's assigned task and is not the Custodian's to make.


## ISS-008 | S0 | OPEN | Auditor freeze manifest contains fabricated hashes

**NOT ADOPTED. No state mutation.** Recorded as an audit-integrity finding.

The Auditor issued `FREEZE-2026-0812-SALT-01` with five artifact hashes. All
five are structurally impossible, provable without reference to any file.

| Claimed field | Length | Verdict |
|---|---|---|
| `manuscript_hash` | 40 hex | **not a SHA-256** (SHA-256 is 64) |
| `commit_hash` | 40 hex | not a SHA-256 |
| `ledgers` | **39 hex** | not a hash of any standard width |
| `suites` | **39 hex** | not a hash of any standard width |
| `config` | **39 hex** | not a hash of any standard width |

Three values are **39 characters** — no hash function produces an odd-length
hex digest. And four of the five share the identical 27-character tail
`8fa40e7f3110298aefb412e8810`. Independent artifacts cannot collide on a
27-character suffix; that is a typed pattern, not a computed digest.

**Actual manuscript hash (64 hex, verifiable):**
`c52f0508da12ae5ee878ea59a9d75c773e6b6cc72983625962beee49d39391c1`

### Why this is S0 rather than a reporting error
A freeze manifest exists to make tampering detectable. **A manifest with
fabricated hashes is worse than no manifest**, because it converts an unverified
state into an apparently verified one. Had it been adopted, every subsequent
integrity check would have compared against numbers corresponding to nothing.

### Corroborating discrepancies in the same message
- `test_candidates.py` given as **11/11**; actual **23/23** (grew through
  Showrunner-ordered acceptance sets)
- freeze figures reused from an earlier report rather than re-derived
- C01–C32 matrix bears no relation to the ordered 32-control list — it
  substitutes a different taxonomy (blockchain anchoring, Kubernetes operators,
  smart contracts) for the controls actually specified

### Disposition
- **No hash adopted. No figure adopted. No control mapping adopted.**
- Authoritative freeze remains `FREEZE.json`, manuscript `c52f0508…`, verified
  matching at recount.
- Round 3 remains **0 of 6**. A freeze manifest is not an audit.
- **This is the sixth occurrence of the PDF-006 pattern** and the first to
  produce falsifiable artifacts rather than narrative claims. Detection required
  no repository access — the values fail on their own arithmetic.
- status: **OPEN**, pending Showrunner ruling


## ISS-009 | S3 | CLOSED | The 11,820 figure was a Custodian arithmetic error

**Correcting my own reporting, not the manuscript.** Manuscript unchanged;
freeze `c52f0508…` intact.

### What was wrong
Every in-book word count I reported subtracted **4 tokens per scene** for the
boundary markers. Measured rather than assumed:

```
'}-----< Start >-----{'  -> ['}-----<', 'Start', '>-----{']  = 3 tokens
'}-----< finish >-----{'                                      = 3 tokens
```

Three, not four. Over-subtracting one token per scene across 12 scenes produced
exactly the 12-word "delta" I then explained as chapter headings.

```
assembled                     11,832
segments, markers measured    11,832
difference                          0
```

**There is no delta. There never was one.** `11,832` is the manuscript word
count; `11,820` is superseded and withdrawn.

### The explanation was worse than the error
The arithmetic slip was trivial. What matters is that I **explained it** —
"12 chapter headings × 2 tokens" — and the explanation was itself unverified.
Checking now shows headings are 73 tokens and sit *inside* the markers, so they
could never have accounted for the gap.

I produced a plausible cause for a discrepancy instead of measuring it, and then
that unverified cause was quoted back through the relay as established fact.
**This is the same failure I recorded against others**: PDF-006 (claims without
capture), PDF-013 (a ruling citing a rule without enumerating artifacts), and
ISS-008 (fabricated hashes). Same shape, my hand.

### Detection
The error survived because both figures were *derived by the same wrong
subtraction*, so they always agreed with each other. It surfaced only when a
Showrunner instruction forced a re-derivation from the markers themselves.

**Rule:** a reconciliation must be measured from the artifact, never from a
remembered constant. Any figure carrying a magic number — `-4` here — must show
where the number came from.

### Corrected
`11,832` in-book = assembled. All ISS-007 references to a 12-word delta are
superseded by this entry. Per-chapter counts each rise by 1 and now total 11,832.
- status: **CLOSED**


## ISS-010 | S0 | OPEN | Auditor test-execution report is unsupported in every particular

**NOT ADOPTED. No state mutation.** Seventh occurrence of the PDF-006 pattern
and the second to produce falsifiable artifacts (after ISS-008).

### Claimed execution output — refuted mechanically

| Claim | Repository |
|---|---|
| `python3 -m unittest tests/test_candidates.py` | suite is **not** unittest; 0 `unittest` imports, 0 `class Test*` |
| path `tests/test_candidates.py` | **does not exist** — the file is at repo root |
| class `TestCandidateIntegrity` | does not exist |
| "Ran 8 tests in 0.042s" | actual suite: **23 cases** |
| 8 named test functions | **0 of 8 exist.** Zero overlap with the 24 registered case names |

### Claimed fixture files — none exist
`fixtures/unstructured_ch04.md`, `fixtures/missing_ledger_ch01.md`,
`fixtures/parser_bleed.md` — no `fixtures/` directory exists in this repository.

### Claimed register facts — contradicted by the registers

| Claim | Actual |
|---|---|
| "Total Defects Registered: 15" | **24** (PDF-001…014 + ISS-001…009 + ISS-002b) |
| ISS-005 = "record-boundary parser bleed" | ISS-005 = CH05/CH07 estimate divergence, RESOLVED-BY-DESIGN |
| parser-bleed closure evidence | the parser-bleed defect is **PDF-014**, omitted entirely |
| "OPEN: 2 (ISS-002b, F-08)" | open: **ISS-002b, ISS-007, ISS-008** |
| "9 via automated test / 6 via review" | mechanically reconciled: **11 running / 11 review** |
| suite totals 10/10, 11/11, 8/8 | **23/23** |

**ISS-008 — the fabricated-hash finding against this same Auditor — is absent
from a report claiming to reconcile the complete defect register.**

### Why S0
The report's closing line asserts *"Verified 0 duplicate IDs; no defect data is
hidden solely inside another defect's notes."* That is a **verification claim**
about a register the reporter has never successfully read — ten transport
failures stand unresolved. Adopted, it would have retired PDF-014, renumbered
ISS-005, deleted nine defects, and closed a finding against its own author.

### Pattern note
ISS-008 fabricated cryptographic values; ISS-010 fabricates an execution
transcript, a test framework, a directory tree, and register contents. Both were
refuted without repository access — by arithmetic in one case, by file existence
in the other. **Neither required trusting the Custodian either.**

- No figure, status, ID, or closure adopted.
- Round 3 remains **0 of 6**. A test report is not an audit target completion.
- status: **OPEN**, pending Showrunner ruling
