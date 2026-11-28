# Fix list — stress test round 2 + the "What the Ice Kept" recommendations (not started)

Round 2 (2026-11-28) re-ran the standard 588 stresses on main (b4a0402): **unchanged, 586 ✅/🟡, 2 ⚠️** — and added
two new sections built from the real 3-chapter run of 2026-11-27 (10½ hours instead of ~2½), graded stricter (a
stop or a wait that another working AI could have avoided is ⚠️):

| Section | Results | ✅ | 🟡 | ❌ | ⚠️ | Report |
|---|---|---|---|---|---|---|
| R — the real-world run, Akọwe's side | 31 | 8 | 2 | 0 | 21 | [R-real-world-run.md](R-real-world-run.md) |
| RD — the real-world run, AutoInjector's side | 18 | 3 | 1 | 1 | 13 | [RD-desktop-real-run.md](RD-desktop-real-run.md) |

**Nothing below is implemented — waiting for the user's go-ahead.** Worst first.

## Batch 1 — Never wait on a dead AI (the 10½ hours)
| # | Problem | IDs | Where | Fix |
|---|---|---|---|---|
| 1.1 | A TIMEOUT asks the **same** AI again and then stops the book / skips the check while two other AIs work (~41 min per failure) | R-1-a…e, R-2-b, R-3-a, R-10-d | `assist._call_ai_once` (~695–745), `providers._generate` (`others=False` for an explicit slot, ~1637), `_generate_timeout_safe` (~1688) | A TIMEOUT whose late window expired counts like "AI down": move to another working AI (writer ≠ reviewer), skip the 60 s same-AI retry when another AI could answer |
| 1.2 | The AI that just timed out is asked first again at every chapter (15 s failed-slot hold) | R-1-f, R-1-g | providers failed-slot hold | Keep the slot marked failed until a check-in proves it works |
| 1.3 | AutoInjector knows "can't read the reply" after 3 min but lets the request run 20 + 10 min; health keeps saying "ready" | RD-1-a/b/d, R-10-c | main.js `healthTick` (~1254), bridge `siteStatus` | On "matches nothing": hand the request back early (`capture_stalled`), repair at once, show it in `/v1/health` (tested: 30 min → ~7 min; 14 timeouts → 1) |
| 1.4 | The stall's repair keeps making way for Akọwe's next request and never runs | RD-2-d, RD-1-b, RD-6-a | `selfRepairMakeWay` (~9585), `selfRepairBusy` (~9560) | A repair started by a stall / timeout doesn't yield; Akọwe gets "repairing" meanwhile |
| 1.5 | A stop waits for the author for ever; with 🗳 voting the broken AI is a voter; "another AI" isn't passed to the reviewer | R-4-a/b/c, RD-6-c | `autobook._pause_problem`, `stand_in` defaults, `stand_in_errors.apply` | Auto-retry a TIMEOUT stop on another working AI; the failed AI doesn't vote; the avoided AI is avoided by every job |
| 1.6 | Claude's pane: health says ok but every send fails (945 tries); "Claude needs you" 12× in 6 h | R-10-g, RD-3-b | providers slot health, run-guard | Mark the slot down after N failed sends; back the reminders off for a pane the book isn't using |

## Batch 2 — ChatGPT's reply reader
| # | Problem | IDs | Where | Fix |
|---|---|---|---|---|
| 2.1 | A working fragment reader is retired as "out of date", leaving nothing; then re-learned and retired again (~30 min per cycle) | RD-2-a…d | main.js `markCaptured` / `noteSavedSelectorOutcome` / `retireSavedSelector`, self-repair.js page-search learner | Count a fragment read as working; retire only when the built-in reader really reads; prefer the whole turn; don't re-learn a just-retired reader |
| 2.2 | Fresh chat held "busy" for ever by an unread reply; the chat grows to ~400 k characters | RD-4-c | `freshChatBusy` (~9835) | The same time limit as the repair check |
| 2.3 | "New chat" check fooled when the reader is broken | RD-4-b | `startFreshChatNow` (~9857) | Also require a positive sign (URL changed, old rows gone) |
| 2.4 | A page stuck on "writing" gets 12 min of grace | RD-6-b | pane health | Shorter when the text has stopped changing |

## Batch 3 — Safety
| # | Problem | IDs | Where | Fix |
|---|---|---|---|---|
| 3.1 | ❌ **The author's own question in a pane becomes Akọwe's answer** (the real answer is lost) | RD-5-b | main.js bridge capture (~4978), relay trace `openFor`, bridge `onCaptured` | Don't hand a reply to Akọwe when the author typed in that pane after the prompt — keep waiting or answer "busy" |

## Batch 4 — The finished book
| # | Problem | IDs | Where | Fix |
|---|---|---|---|---|
| 4.1 | "Unknown author" on the title page, metadata and Word running heads | R-5-a | `book_path.title_author` (~485) | Leave the author out when there is no pen name + a ⚠️ "no pen name" note |
| 4.2 | Cut pass keeps 0 cuts: quotes matched byte-exactly (' vs ’) | R-7-c | `cut_pass.validate` (~173–215) | Match after normalising quotes, dashes and spaces; journal the not-found count |
| 4.3 | A whole sentence repeated across chapters is only 5-word "minor" findings | R-6-a | `human_voice._repeats` | Whole-sentence match across chapters = one major finding, fixed by the editor |
| 4.4 | The editor reads an earlier version than the final one | R-8-a | editor pass ordering | Re-read after the later rewrites, or label "read version N of M" |
| 4.5 | Planned details missing get one fix round only | R-9-a | `planned.py` | One more round, or another AI |
| 4.6 | "Crewman Two" / "the fifth of us" style names aren't flagged | R-10-f | name checks | Flag role-plus-number names; ask for real names |

## Batch 5 — Honest numbers
| # | Problem | IDs | Where | Fix |
|---|---|---|---|---|
| 5.1 | 2 hours of timeouts still score "10/10 clean run" | R-10-e | `clean_run.COST` | Count timeouts, failovers, skipped checks and waiting time |

## Already on the waiting list (docs/WAITING_LIST.md)
Play-by-play step (10A) · short story collection book · desktop-app control (undecided) · CLI mode (back burner).
