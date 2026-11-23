# ⚡ Make-a-book stress test — index

Every part of the book-making process (`akowe/akowe/autobook.py` `STEPS`) is stress-tested section by section with the harness in `akowe/tools/stress` (see its README). Findings only: no product code is changed by these tests.

Result IDs: `<Section>-<part>[.<subsection>]-<stress>` (e.g. `B-7-a`, `C-10.2-k`). Stresses a–j are the standard ones; k, l, m… are out-of-the-box ones.

**Legend:** ✅ HANDLED · 🟡 SAFE STOP · ❌ PROBLEM · ⚠️ WORKED BUT RISKY

| Section | Parts / subsections | Status | ✅ | 🟡 | ❌ | ⚠️ | Report |
|---|---|---|---|---|---|---|---|
| A. Getting started | A-1 backup · A-2 profile (invent the book) | done (38 results, 2026-11-23) | 19 | 6 | 2 | 11 | [A-getting-started.md](A-getting-started.md) |
| B. Characters and world | B-3 canon (characters & places) · B-4 characters (sheets & voices) · B-5 looks · B-6 pictures · B-7 world (story rules & world texture) | not run yet |  |  |  |  |  |
| C. Planning the story | C-8 premise · C-9 plot · C-10 outline · C-10.1 story doctor · C-10.2 promise ledger · C-10.3 predictability probe · C-10.4 who-knows-what grid · C-10.5 story shape / kind placement · C-10.6 trade card | not run yet |  |  |  |  |  |
| D. Optional | D-11 bible (fill the whole Book Bible) | not run yet |  |  |  |  |  |
| E. Writing | E-12 chapters · E-12.1 scene cards · E-12.2 the writer (C01/C02) · E-12.3 review & fix loop · E-12.4 editor · E-12.5 cut pass · E-12.6 subtext check · E-12.7 scope guard & knowledge check · E-12.8 voice test · E-12.9 key scenes written twice · E-12.10 ending writer · E-12.11 keep briefs · E-12.12 continuity checkpoints · E-13 planned (planned details on the page) | not run yet |  |  |  |  |  |
| F. Putting the book together | F-14 format · F-15 assemble · F-16 export · F-17 check (content check) | not run yet |  |  |  |  |  |
| G. Quality at the end | G-18 report · G-19 beta (beta reader) · G-20 opening (rewrite chapter 1 last) · G-21 improve · G-22 reread | not run yet |  |  |  |  |  |

Each section report has: a summary table, one section per part (what it does, every stress with its result, the ❌ / ⚠️ findings with Where / What happens / How to reproduce / Likely cause / Suggested fix / How likely) and all findings ordered by severity. The JSON next to it (`<L>-results.json`) holds the same results for tools.
