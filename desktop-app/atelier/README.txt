ATELIER — bookmaking system
This archive SUPERSEDES every earlier ATELIER.zip.

  Program completion: ~99%  (MILESTONE 8 — automation phases 2-5)
  STATUS: BLOCKED on two external items. Run `python qualify.py .`

LAYOUT IS FLAT AND LOAD-BEARING
  Tools and tests sit together in the root ON PURPOSE. Moving them into
  bin/ and tests/ breaks three of six suites — that is defect PDF-009.
  If your old copy has bin/ and tests/ directories, it is the broken layout.

QUICK START
  python init_project.py "Your Title" --chapters 20
  cd your-title
  python ../assemble_manuscript.py 04_CHAPTERS -o 07_BUILD/manuscript.md --strict

RUN THE TESTS   (from the ATELIER root)
  python test_assembler.py                18/18   [+BOM, CRLF]
  python test_provisional_classifier.py    6/6
  python test_transaction.py              18/18
  python test_controls.py                  8/8
  python test_propagation.py               4/4
  python test_candidates.py               24/24   [+affects traversal]
  python test_timeline.py                   7/7   [NEW A1]
  python test_depgraph.py                   6/6   [NEW A2]
  python test_knowledge.py                  5/5   [NEW A3]
  python test_registers.py                  7/7   [NEW A4]
  python test_context.py                    7/7   [A5]
  python test_refscope.py                   5/5   [NEW A6]
  python test_identity.py                   4/4   [NEW B1]
  python test_authority.py                  7/7   [B2 + traversal]
  python test_provenance.py                 7/7   [B3 + forgery]
  python test_instruction.py                5/5   [B4]
  python test_redelivery.py                 7/7   [B5 + id validation]
  python test_transaction.py              21/21   [B6 + id validation]
  python test_safe_write.py                 7/7   [C-05 + symlink]
  python test_capture.py                    5/5   [C-08]
  python test_merge_guard.py                6/6   [F-07 + F-08]
  python test_concurrency.py                7/7   [NEW task 8]
  python test_adversarial.py                8/8   [task 9]
  python test_autoinjector.py               8/8   [NEW task 3]
  python test_book_e2e.py                   6/6   [task 10]
  python test_autobook.py                   7/7   [NEW automation 2-5]

UNATTENDED PRODUCTION
  python autobook.py plan <project> --chapters 12
  python autobook.py run <project>          runs every gate, every chapter
  python autobook.py resume <project>       continues after a repair
  python autobook.py status <project>

  It HALTS on the first failing gate rather than continuing and reporting at
  the end. A run that passes a failure produces a book nobody can trust.
  It drives gates; it does not invent prose — a missing draft halts the run.

FINAL QUALIFICATION
  python qualify.py .
      Runs every gate, checks that harness.py AND clean_verify.py list every
      suite on disk, and REFUSES to declare production-ready while any blocker
      stands. Writes RELEASE_BLOCKERS.json.

ONE COMMAND FOR ALL OF IT
  python harness.py all examples/salt-line     expect: ALL GREEN
  python harness.py suites                     17 regression suites
  python harness.py prove                      every red-state guard
  python harness.py e2e                        scaffold -> build -> verify
  Add --prove to any of them. It MUST report FAIL — that proves the suite
  is capable of detecting a failure at all.

VERIFY A FROZEN PROJECT
  python verify_freeze.py examples/salt-line
      expect: freeze integrity : PRESERVED

WHAT IS HERE
  15 tools        assembler, scaffolder, transaction manager, propagation
                  checker, candidate checker, manuscript detectors, component
                  splitter, job classifier, delivery verifier, freeze verifier,
                  timeline validator, dependency graph, knowledge matrix,
                  register validator, context producer
  25 test suites  210 tests, all with red-state proofs
                  PDF-015 path traversal · PDF-016 symlink escape ·
                  PDF-017 BOM handling · PDF-018 affects traversal ·
                  PDF-019 future timestamp · PDF-020 provenance forgery ·
                  PDF-021 job_id used as a filename
                  — seven defects found by adversarial sweep, all closed
  1 harness       harness.py — replaces ad-hoc script invocation (C-24)
  1 CI workflow   .github/workflows/cross-machine.yml — 6 runners (D2)
  4 docs          INSTALL.md, OPERATOR_GUIDE.md, RECOVERY_GUIDE.md,
                  MILESTONE_04_REPORT.md
  2 release tools clean_verify.py (full-suite gate), package_release.py

NEW VALIDATORS — usage
  python validate_timeline.py <project>          six §17 checks
  python build_depgraph.py <project> [--json]    §4.12 affects closure
  python check_knowledge.py <project>            §18.4 acting-on-unknown
  python check_registers.py <project> [--final]  §20/21 staleness, orphans
  python build_context.py <project> --chapter CH07 [--budget N] [--json]

AUTOINJECTOR CONTROLS — usage
  python refscope.py --ref HEAD~1 <file>              §4.12.1 real ref reads
  python identity.py init <dir> --project-id x --spec-version v0.3.3
  python identity.py key JOB-1 --project-id x         namespaced job key
  python authority.py check --role gemini --path 04_CHAPTERS/x.md
  python authority.py policy                          show the write matrix
  python provenance.py stamp <file> --authored-by claude --job-id J1
  python provenance.py check <dir> [--require-all]
  python check_instruction.py <project> --instruction FILE

  IMPL-GAP-001 IS CLOSED. check_manuscript.py now EVALUATES --ref via
  git show rather than reading the working tree and printing the ref.
  Default is --ref WORKTREE, which says plainly that it reads the tree.
  docs/           SYSTEM_SPEC.md v0.3.3 (36 sections), MANUSCRIPT_PROTOCOL.md
  registers/      decision log, 14 process defects, pending changes
  delivery/       hash-verified 5-part spec bundle
  examples/       salt-line — a complete 12-chapter validation run, frozen
  AUTOINJECTOR_*  32-control integration matrix and reconciliations

WHAT IS NOT BUILT — 12 remaining

  MILESTONE 1 DELIVERED (A1-A5): validate_timeline · build_depgraph ·
  check_knowledge · check_registers · build_context — with 32 new tests.
  These five were run BY HAND throughout the novella. They now run as gates.

  MILESTONE 2 DELIVERED (A6, B1-B4): refscope · identity · authority ·
  provenance · check_instruction — with 24 new tests.
  ISS-002 is now mechanically prevented: the Auditor CANNOT write manuscript.
  PDF-006 is now mechanically detectable: unattributed artifacts are findings.

  MILESTONE 3 DELIVERED (B5, B6, D2): redelivery guard · C-02 spec_version
  on transactions · C-24 execution harness · cross-machine CI across 6 runners.

  MILESTONE 4 DELIVERED (C-05, C-08):
    safe_write.py   the single authorised write path. authority.py could
                    DECIDE but nothing CALLED it — the same shape as ISS-002
                    itself. Combines authorisation and attribution in one call,
                    because separating them is how they drift apart.
                    `python safe_write.py audit .` lists tools that bypass it.
    capture.py      execution evidence. A reported result is a hypothesis;
                    a captured transcript with a hash is evidence. verify()
                    detects a record edited after capture — which is exactly
                    what ISS-008 and ISS-010 were.

  MILESTONE 5 DELIVERED (F-07, F-08): merge_guard.py

    F-07 route exclusivity — enumerates every source site that can set a job
    to COMMITTED and asserts each is guarded. Currently: one guarded route
    (transaction.py). The check states its own limit plainly — it sees this
    source tree only, and a route outside it is invisible. That residual is
    named rather than hidden.

    F-08 transaction provenance — a token is minted at BRANCH from the job id
    and base commit, and required as an `Atelier-Transaction:` trailer in the
    merge. Ancestry proves the commits are REACHABLE; the trailer proves THIS
    transaction put them there. Proven by test: a branch merged by another
    process passes ancestry and FAILS provenance.

  MILESTONE 6 DELIVERED (tasks 8, 9):
    test_concurrency.py  two books at once — job ids, delivery ledgers,
                         quarantine, recovery and candidate counts stay
                         isolated, including a real parallel-thread build.
    test_adversarial.py  crash mid-transaction · SIGKILL · retry · out-of-order
                         delivery · stale job · stale instruction ·
                         unauthorized write · recovery-to-base. Each control
                         existed; none had been run as an end-to-end scenario.

  MILESTONE 7 DELIVERED (tasks 3, 10, 11):
    autoinjector.py    the orchestration adapter. CREATE -> ROUTE -> DELIVER
                       -> CAPTURE -> VERIFY -> CLASSIFY -> APPLY -> PROPAGATE
                       -> AUDIT -> CLOSE. Stages cannot be skipped, a P3
                       classification HOLDs, and a held job never applies.
                       Adds no new enforcement — it makes the ORDER refusable.
    test_book_e2e.py   a fresh project from scaffold to assembled manuscript
                       with no manual repair, including proof that a defective
                       chapter fails the build rather than shipping.
    qualify.py         final qualification. Verifies both gates list every
                       suite on disk — the check that would have caught
                       clean_verify.py silently skipping three suites.

  REMAINING — neither closable from inside this program:
    Cross-machine execution   NOT ESTABLISHED. Needs a machine that is not the
                              author's. `python harness.py all examples/salt-line`
    Round 3 independent audit 0 of 6 targets. Needs an auditor channel that can
                              read a file.
  AUTOMATION PHASES 2-5 DELIVERED: autobook.py
    Phase 2 dispatch · Phase 3 every gate invoked · Phase 4 durable resume ·
    Phase 5 unattended run to completion. Proven on a fresh 4-chapter book:
    full run, deliberate gate failure, halt, repair, resume to COMPLETE.

  CROSS-MACHINE STILL NOT ESTABLISHED — run `python harness.py all` here.

  CROSS-MACHINE IS STILL NOT ESTABLISHED. The CI workflow exists but has never
  run. Running `python harness.py all examples/salt-line` on YOUR machine and
  getting ALL GREEN is the single cheapest open item in the project.

  Until these exist, every gate runs only when a human remembers to run it.
  That is the failure class behind defects PDF-012, ISS-003, ISS-004, ISS-006.

NOT ESTABLISHED
  Cross-machine verification   never run on a second machine
  Round 3 independent audit    0 of 6 targets
  F-06 / F-07 / F-08           closure conditions open
  Example novella              all 12 chapters PENDING_AUDIT, 106 facts unpromoted

  Running the six suites on YOUR machine and getting the numbers above IS the
  cross-machine verification. It is the cheapest open item in the project.
