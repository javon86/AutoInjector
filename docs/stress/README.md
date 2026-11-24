# ⚡ Make-a-book stress test — index

Every part of the book-making process (`akowe/akowe/autobook.py` `STEPS`) was stress-tested section by section with
the harness in `akowe/tools/stress` (see its README). **Findings only: no product code was changed by these tests.**
Start with **[SUMMARY.md](SUMMARY.md)** — the whole picture, the problems worst first, and the root causes they share. The fix plan for the book-quality findings is **[FIX_PLAN_QUALITY.md](FIX_PLAN_QUALITY.md)** (not started), and the new step before the book is written is **[PLAY_BY_PLAY_PLAN.md](PLAY_BY_PLAY_PLAN.md)** (not started).

Result IDs: `<Section>-<part>[.<subsection>]-<stress>` (e.g. `B-7-a`, `C-10.2-k`). Stresses a–j are the standard ones
(a timeout · b busy · c usage limit · d garbage answer · e empty answer · f refusals · g a crash in the part's own code ·
h program restart · i pause / cancel · j the most likely real-life problem); k, l, m… are out-of-the-box ones.

**Legend:** ✅ HANDLED (the book finished) · 🟡 SAFE STOP (clear message; Resume finished it, nothing lost) ·
❌ PROBLEM · ⚠️ WORKED BUT RISKY

| Section | Parts / subsections | Results | ✅ | 🟡 | ❌ | ⚠️ | Report |
|---|---|---|---|---|---|---|---|
| A. Getting started | A-1 backup · A-2 invent the book | 38 | 19 | 6 | 2 | 11 | [A-getting-started.md](A-getting-started.md) |
| B. Characters and world | B-3 characters & places · B-4 sheets & voices · B-5 looks · B-6 pictures · B-7 story rules & world texture | 77 | 39 | 14 | 3 | 21 | [B-characters-and-world.md](B-characters-and-world.md) |
| C. Planning the story | C-8 premise · C-9 plot · C-10 outline · C-10.1 story doctor · C-10.2 promise ledger · C-10.3 predictability probe · C-10.4 who-knows-what grid · C-10.5 story shape / kind placement · C-10.6 trade card | 128 | 73 | 24 | 6 | 25 | [C-planning-the-story.md](C-planning-the-story.md) |
| D. Optional | D-11 fill the whole Book Bible | 20 | 8 | 4 | 0 | 8 | [D-optional.md](D-optional.md) |
| E. Writing (part 1) | E-12.1 scene cards · E-12.2 the writer · E-12.3 review & fix loop · E-12.4 editor · E-12.5 cut pass · E-12.6 subtext check | 95 | 52 | 20 | 6 | 17 | [E1-writing-part-1.md](E1-writing-part-1.md) |
| E. Writing (part 2) | E-12.7 scope guard & knowledge check · E-12.8 voice test · E-12.9 key scenes twice · E-12.10 ending writer · E-12.11 keep briefs · E-12.12 continuity checkpoints · E-13 planned details on the page | 97 | 59 | 22 | 2 | 14 | [E2-writing-part-2.md](E2-writing-part-2.md) |
| F. Putting the book together | F-14 format · F-15 assemble · F-16 export · F-17 content check | 58 | 16 | 9 | 12 | 21 | [F-putting-the-book-together.md](F-putting-the-book-together.md) |
| G. Quality at the end | G-18 report · G-19 beta reader · G-20 rewrite chapter 1 last · G-21 improve · G-22 read again | 75 | 44 | 10 | 2 | 19 | [G-quality-at-the-end.md](G-quality-at-the-end.md) |
| **All** | **22 parts, 18 subsections** | **588** | **310** | **109** | **33** | **136** | |

Each section report has: a summary table, one section per part (what it does, every stress with its result, the ❌ / ⚠️
findings with Where / What happens / How to reproduce / Likely cause / Suggested fix / How likely) and all findings
ordered by severity. The JSON next to it (`<L>-results.json`) holds the same results for tools.

**Re-run** (from the `akowe` folder): `python -m tools.stress.run --section A` (B, C, D, E1, E2, F, G; options
`--parts`, `--stress`, `--seed`, `--render`). A section takes about 2–10 minutes. Quick checks:
`python -m pytest tests/test_stress_*_smoke.py`.
