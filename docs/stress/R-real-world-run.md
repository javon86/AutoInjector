# Section R — Real-world run (the “What the Ice Kept” log): stress results

Every part of this section was run through the standard stresses (a–j) and out-of-the-box stresses (k…) with the stress harness (`akowe/tools/stress`). Nothing in the product was changed; this is a list of findings for the author to decide on.

**Legend:** ✅ HANDLED — the book still finished, nothing lost · 🟡 SAFE STOP — paused with a clear problem; after the fault was removed, Resume finished the book · ❌ PROBLEM · ⚠️ WORKED BUT RISKY.

Re-run: `cd akowe && python -m tools.stress.run --section R` (one part: `--parts 1`; some stresses: `--stress a,k`).

## Summary

| ID | Part | ✅ | 🟡 | ❌ | ⚠️ |
|---|---|---|---|---|---|
| R-1 | one AI times out on every call of one kind while two others work | 0 | 0 | 0 | 7 |
| R-2 | an answer that arrives late | 2 | 0 | 0 | 1 |
| R-3 | every AI times out | 0 | 2 | 0 | 0 |
| R-4 | a stop while the author is away | 0 | 0 | 0 | 3 |
| R-5 | the finished book without a pen name | 1 | 0 | 0 | 1 |
| R-6 | a long sentence repeated across chapters | 0 | 0 | 0 | 1 |
| R-7 | a book over its length target and the cut pass | 2 | 0 | 0 | 1 |
| R-8 | the editor reads a version that is not the final one | 0 | 0 | 0 | 1 |
| R-9 | planned details missing from the page at the end | 1 | 0 | 0 | 1 |
| R-10 | out of the box: more from the log | 2 | 0 | 0 | 5 |
| **all** | | **8** | **2** | **0** | **21** |

## R-1 one AI times out on every call of one kind while two others work

**What it does:** The log's ChatGPT: the reply could not be read, so every request of that kind timed out (typed, no answer, late window expired). Claude and Gemini answered everything. Does the step move to a working AI, or stop the book — and how long does the run wait?

| ID | Stress | Result | What happened |
|---|---|---|---|
| R-1-a | ChatGPT times out on every review call while the two other AIs work | ⚠️ | ChatGPT timed out on every review call (typed, no answer, late window expired); the two other AIs worked. The run stopped 4× (TIMEOUT@canon, TIMEOUT@chapters, TIMEOUT@chapters, TIMEOUT@chapters); the author pressed 🔁 Try again each time, then the fault was removed. In the end the review calls were answered by Gemini. ⚠️ 4 stop(s) for the author (TIMEOUT@canon, TIMEOUT@chapters, TIMEOUT@chapters, TIMEOUT@chapters) although Claude and Gemini worked and could have answered; the run waited ≈ 4.8 h on the AI that could not answer before anything moved (limit 5.0 min when another AI works) Note: Measured: status done; 4 stop(s) (TIMEOUT@canon, TIMEOUT@chapters, TIMEOUT@chapters, TIMEOUT@chapters); time waited ≈ 4.8 h (simulated clock); 14 TIMEOUT / 14 LATE_EXPIRED / 0 late answer(s) used; answered in the end by Gemini. |
| R-1-b | ChatGPT times out on every scenes_check call while the two other AIs work | ⚠️ | ChatGPT timed out on every scenes_check call (typed, no answer, late window expired); the two other AIs worked. The run stopped 3× (TIMEOUT@chapters, TIMEOUT@chapters, TIMEOUT@chapters); the author pressed 🔁 Try again each time, then the fault was removed. In the end the scenes_check calls were answered by Gemini. ⚠️ 3 stop(s) for the author (TIMEOUT@chapters, TIMEOUT@chapters, TIMEOUT@chapters) although Claude and Gemini worked and could have answered; the run waited ≈ 2.0 h on the AI that could not answer before anything moved (limit 5.0 min when another AI works) Note: Measured: status done; 3 stop(s) (TIMEOUT@chapters, TIMEOUT@chapters, TIMEOUT@chapters); time waited ≈ 2.0 h (simulated clock); 6 TIMEOUT / 6 LATE_EXPIRED / 0 late answer(s) used; answered in the end by Gemini. |
| R-1-c | ChatGPT times out on every editor call while the two other AIs work | ⚠️ | ChatGPT timed out on every editor call (typed, no answer, late window expired); the two other AIs worked. The run never stopped. In the end the editor calls were answered by nobody. ⚠️ the run waited ≈ 2.0 h on the AI that could not answer before anything moved (limit 5.0 min when another AI works); that check was skipped (the step went on without it) — the working AIs were never asked Note: Measured: status done; 0 stop(s); time waited ≈ 2.0 h (simulated clock); 6 TIMEOUT / 6 LATE_EXPIRED / 0 late answer(s) used; answered in the end by nobody. |
| R-1-d | ChatGPT times out on every planned_check call while the two other AIs work | ⚠️ | ChatGPT timed out on every planned_check call (typed, no answer, late window expired); the two other AIs worked. The run never stopped. In the end the planned_check calls were answered by nobody. ⚠️ the run waited ≈ 2.0 h on the AI that could not answer before anything moved (limit 5.0 min when another AI works); that check was skipped (the step went on without it) — the working AIs were never asked Note: Measured: status done; 0 stop(s); time waited ≈ 2.0 h (simulated clock); 6 TIMEOUT / 6 LATE_EXPIRED / 0 late answer(s) used; answered in the end by nobody. |
| R-1-e | ChatGPT times out on every writers_room call while the two other AIs work | ⚠️ | ChatGPT timed out on every writers_room call (typed, no answer, late window expired); the two other AIs worked. The run never stopped. In the end the writers_room calls were answered by nobody. ⚠️ the run waited ≈ 2.0 h on the AI that could not answer before anything moved (limit 5.0 min when another AI works); that check was skipped (the step went on without it) — the working AIs were never asked Note: Measured: status done; 0 stop(s); time waited ≈ 2.0 h (simulated clock); 6 TIMEOUT / 6 LATE_EXPIRED / 0 late answer(s) used; answered in the end by nobody. |
| R-1-f | Claude times out on every bible-fill call while the two other AIs work | ⚠️ | Claude timed out on every bible-fill call (typed, no answer, late window expired); the two other AIs worked. The run never stopped. In the end the bible-fill calls were answered by ChatGPT. ⚠️ the run waited ≈ 40.8 min on the AI that could not answer before anything moved (limit 5.0 min when another AI works) Note: Measured: status done; 0 stop(s); time waited ≈ 40.8 min (simulated clock); 2 TIMEOUT / 2 LATE_EXPIRED / 0 late answer(s) used; answered in the end by ChatGPT. |
| R-1-g | Claude times out on every chapter-writer call while the two other AIs work | ⚠️ | Claude timed out on every chapter-writer call (typed, no answer, late window expired); the two other AIs worked. The run never stopped. In the end the chapter-writer calls were answered by ChatGPT. ⚠️ the run waited ≈ 32.7 min on the AI that could not answer before anything moved (limit 5.0 min when another AI works) Note: Measured: status done; 0 stop(s); time waited ≈ 32.7 min (simulated clock); 3 TIMEOUT / 3 LATE_EXPIRED / 0 late answer(s) used; answered in the end by ChatGPT. |

### Findings in R-1

**1. R-1-a ⚠️ — ChatGPT times out on every review call while the two other AIs work**

- **Where:** akowe/akowe/assist.py `_call_ai_once` (~line 695–745): the checker jobs (review, scenes_check, editor, planned_check, writers' room …) pick a slot themselves and call `prov.generate(..., slot_id=slot["slot_id"])` (line ~720); in akowe/akowe/providers.py `_generate` (~1590–1660) an explicit slot_id means `others=False` (line ~1637), so `_generate_timeout_safe` (~1688) asks the SAME web AI once more after TIMEOUT_RETRY_WAIT_S (60 s) instead of moving; back in assist the failover branch (line ~733) moves only on UPSTREAM_UNAVAILABLE / AI_DECLINED / unusable — `_unusable` explicitly excludes TIMEOUT — so the TIMEOUT is raised
- **What happens:** review: 4 stops while Claude and Gemini worked, ≈ 4.8 h lost (the log's review ×4). The author sees: ChatGPT timed out on every review call (typed, no answer, late window expired); the two other AIs worked. The run stopped 4× (TIMEOUT@canon, TIMEOUT@chapters, TIMEOUT@chapters, TIMEOUT@chapters); the author pressed 🔁 Try again each time, then the fault was removed. In the end the review calls were answered by Gemini. (run status paused → done; problem TIMEOUT; journal codes: VOICE_SET, TIMEOUT, VOICES_DISTINCT, DOCTOR_SCORED, DOCTOR_DONE, PREDICT_PROBED, LEDGER_EMPTY, SCOPE_SET, GRID_EMPTY, TRADE_CARD_MADE, PROTAGONIST_OK, FIRST_PAGE_PICKED, SECOND_REVIEW_FAILED, PLANNED_UNRESOLVED, PLANNED_MISSING, CHECKPOINT, ENDING_KEPT, VOICE_TEST_TOO_LITTLE, HUMAN_PASS, OPENING_UNRESOLVED, IMPROVE_UNRESOLVED, CLEAN_RUN_SCORE, BOOK_TOO_SHORT, QUALITY_TREND; log: 0 ERROR line(s), 0 traceback(s)).
- **How to reproduce:** `cd akowe && python -m tools.stress.run --section R --parts 1 --stress a` (ID R-1-a)
- **Likely cause:** TIMEOUT is treated as “ambiguous, the author decides” (contract rule from the paid-API days), but a web AI whose prompt was typed and whose late window expired (`late_expired` / `late_collect_tried`) is not ambiguous any more: nothing more will come. Each such call costs the full timeout (~895 s: `AutoInjectorAdapter.timeout_ms` caps at 900 s) + the late window (300 s) + 60 s + the same again on the -c1- try ≈ 41 min, then the checker stops the book or is skipped. The failed-slot hold (FAIL_HOLD_S = 15 s) is long over by the next call, so the next call of the same kind goes to the same AI again
- **Suggested fix:** in assist `_call_ai_once`, treat a TIMEOUT whose bridge body says typed + late_expired (or late_collect_tried) like UPSTREAM_UNAVAILABLE: add the slot to `failed` and move to another working AI (`_other_ai`), keeping the writer≠reviewer rule; do not do the 60 s same-AI retry when another AI could take the call; mark the slot failed for much longer than 15 s after a TIMEOUT (e.g. until its next successful probe), so the next call of any kind starts elsewhere (not implemented)
- **How likely:** likely in real use

**2. R-1-b ⚠️ — ChatGPT times out on every scenes_check call while the two other AIs work**

- **Where:** akowe/akowe/assist.py `_call_ai_once` (~line 695–745): the checker jobs (review, scenes_check, editor, planned_check, writers' room …) pick a slot themselves and call `prov.generate(..., slot_id=slot["slot_id"])` (line ~720); in akowe/akowe/providers.py `_generate` (~1590–1660) an explicit slot_id means `others=False` (line ~1637), so `_generate_timeout_safe` (~1688) asks the SAME web AI once more after TIMEOUT_RETRY_WAIT_S (60 s) instead of moving; back in assist the failover branch (line ~733) moves only on UPSTREAM_UNAVAILABLE / AI_DECLINED / unusable — `_unusable` explicitly excludes TIMEOUT — so the TIMEOUT is raised
- **What happens:** scenes_check: 3 stops, ≈ 2 h lost (the log's scenes_check stop). The author sees: ChatGPT timed out on every scenes_check call (typed, no answer, late window expired); the two other AIs worked. The run stopped 3× (TIMEOUT@chapters, TIMEOUT@chapters, TIMEOUT@chapters); the author pressed 🔁 Try again each time, then the fault was removed. In the end the scenes_check calls were answered by Gemini. (run status paused → done; problem TIMEOUT; journal codes: VOICE_SET, VOICES_DISTINCT, DOCTOR_SCORED, DOCTOR_DONE, PREDICT_PROBED, LEDGER_EMPTY, SCOPE_SET, GRID_EMPTY, TRADE_CARD_MADE, PROTAGONIST_OK, TIMEOUT, FIRST_PAGE_PICKED, SECOND_REVIEW, PLANNED_UNRESOLVED, PLANNED_MISSING, CHECKPOINT, ENDING_KEPT, VOICE_TEST_TOO_LITTLE, HUMAN_PASS, OPENING_UNRESOLVED, IMPROVE_UNRESOLVED, CLEAN_RUN_SCORE, BOOK_TOO_SHORT, QUALITY_TREND; log: 0 ERROR line(s), 0 traceback(s)).
- **How to reproduce:** `cd akowe && python -m tools.stress.run --section R --parts 1 --stress b` (ID R-1-b)
- **Likely cause:** TIMEOUT is treated as “ambiguous, the author decides” (contract rule from the paid-API days), but a web AI whose prompt was typed and whose late window expired (`late_expired` / `late_collect_tried`) is not ambiguous any more: nothing more will come. Each such call costs the full timeout (~895 s: `AutoInjectorAdapter.timeout_ms` caps at 900 s) + the late window (300 s) + 60 s + the same again on the -c1- try ≈ 41 min, then the checker stops the book or is skipped. The failed-slot hold (FAIL_HOLD_S = 15 s) is long over by the next call, so the next call of the same kind goes to the same AI again
- **Suggested fix:** in assist `_call_ai_once`, treat a TIMEOUT whose bridge body says typed + late_expired (or late_collect_tried) like UPSTREAM_UNAVAILABLE: add the slot to `failed` and move to another working AI (`_other_ai`), keeping the writer≠reviewer rule; do not do the 60 s same-AI retry when another AI could take the call; mark the slot failed for much longer than 15 s after a TIMEOUT (e.g. until its next successful probe), so the next call of any kind starts elsewhere (not implemented)
- **How likely:** likely in real use

**3. R-1-c ⚠️ — ChatGPT times out on every editor call while the two other AIs work**

- **Where:** akowe/akowe/assist.py `_call_ai_once` (~line 695–745): the checker jobs (review, scenes_check, editor, planned_check, writers' room …) pick a slot themselves and call `prov.generate(..., slot_id=slot["slot_id"])` (line ~720); in akowe/akowe/providers.py `_generate` (~1590–1660) an explicit slot_id means `others=False` (line ~1637), so `_generate_timeout_safe` (~1688) asks the SAME web AI once more after TIMEOUT_RETRY_WAIT_S (60 s) instead of moving; back in assist the failover branch (line ~733) moves only on UPSTREAM_UNAVAILABLE / AI_DECLINED / unusable — `_unusable` explicitly excludes TIMEOUT — so the TIMEOUT is raised
- **What happens:** editor: never stops but each chapter waits ≈ 41 min and then goes on WITHOUT the editor. The author sees: ChatGPT timed out on every editor call (typed, no answer, late window expired); the two other AIs worked. The run never stopped. In the end the editor calls were answered by nobody. (run status done → done; journal codes: VOICE_SET, VOICES_DISTINCT, DOCTOR_SCORED, DOCTOR_DONE, PREDICT_PROBED, LEDGER_EMPTY, SCOPE_SET, GRID_EMPTY, TRADE_CARD_MADE, PROTAGONIST_OK, FIRST_PAGE_PICKED, SECOND_REVIEW, EDITOR_FAILED, EDITOR_NOTES, PLANNED_UNRESOLVED, PLANNED_MISSING, CHECKPOINT, ENDING_KEPT, VOICE_TEST_TOO_LITTLE, HUMAN_PASS, OPENING_UNRESOLVED, IMPROVE_UNRESOLVED, CLEAN_RUN_SCORE, BOOK_TOO_SHORT, QUALITY_TREND; log: 0 ERROR line(s), 0 traceback(s)).
- **How to reproduce:** `cd akowe && python -m tools.stress.run --section R --parts 1 --stress c` (ID R-1-c)
- **Likely cause:** TIMEOUT is treated as “ambiguous, the author decides” (contract rule from the paid-API days), but a web AI whose prompt was typed and whose late window expired (`late_expired` / `late_collect_tried`) is not ambiguous any more: nothing more will come. Each such call costs the full timeout (~895 s: `AutoInjectorAdapter.timeout_ms` caps at 900 s) + the late window (300 s) + 60 s + the same again on the -c1- try ≈ 41 min, then the checker stops the book or is skipped. The failed-slot hold (FAIL_HOLD_S = 15 s) is long over by the next call, so the next call of the same kind goes to the same AI again
- **Suggested fix:** in assist `_call_ai_once`, treat a TIMEOUT whose bridge body says typed + late_expired (or late_collect_tried) like UPSTREAM_UNAVAILABLE: add the slot to `failed` and move to another working AI (`_other_ai`), keeping the writer≠reviewer rule; do not do the 60 s same-AI retry when another AI could take the call; mark the slot failed for much longer than 15 s after a TIMEOUT (e.g. until its next successful probe), so the next call of any kind starts elsewhere (not implemented)
- **How likely:** likely in real use

**4. R-1-d ⚠️ — ChatGPT times out on every planned_check call while the two other AIs work**

- **Where:** akowe/akowe/assist.py `_call_ai_once` (~line 695–745): the checker jobs (review, scenes_check, editor, planned_check, writers' room …) pick a slot themselves and call `prov.generate(..., slot_id=slot["slot_id"])` (line ~720); in akowe/akowe/providers.py `_generate` (~1590–1660) an explicit slot_id means `others=False` (line ~1637), so `_generate_timeout_safe` (~1688) asks the SAME web AI once more after TIMEOUT_RETRY_WAIT_S (60 s) instead of moving; back in assist the failover branch (line ~733) moves only on UPSTREAM_UNAVAILABLE / AI_DECLINED / unusable — `_unusable` explicitly excludes TIMEOUT — so the TIMEOUT is raised
- **What happens:** planned_check: ≈ 41 min per chapter, then skipped (PLANNED_CHECK_FAILED). The author sees: ChatGPT timed out on every planned_check call (typed, no answer, late window expired); the two other AIs worked. The run never stopped. In the end the planned_check calls were answered by nobody. (run status done → done; journal codes: VOICE_SET, VOICES_DISTINCT, DOCTOR_SCORED, DOCTOR_DONE, PREDICT_PROBED, LEDGER_EMPTY, SCOPE_SET, GRID_EMPTY, TRADE_CARD_MADE, PROTAGONIST_OK, FIRST_PAGE_PICKED, SECOND_REVIEW, PLANNED_CHECK_FAILED, CHECKPOINT, ENDING_KEPT, VOICE_TEST_TOO_LITTLE, PLANNED_MISSING, HUMAN_PASS, OPENING_UNRESOLVED, IMPROVE_UNRESOLVED, CLEAN_RUN_SCORE, BOOK_TOO_SHORT, QUALITY_TREND; log: 0 ERROR line(s), 0 traceback(s)).
- **How to reproduce:** `cd akowe && python -m tools.stress.run --section R --parts 1 --stress d` (ID R-1-d)
- **Likely cause:** TIMEOUT is treated as “ambiguous, the author decides” (contract rule from the paid-API days), but a web AI whose prompt was typed and whose late window expired (`late_expired` / `late_collect_tried`) is not ambiguous any more: nothing more will come. Each such call costs the full timeout (~895 s: `AutoInjectorAdapter.timeout_ms` caps at 900 s) + the late window (300 s) + 60 s + the same again on the -c1- try ≈ 41 min, then the checker stops the book or is skipped. The failed-slot hold (FAIL_HOLD_S = 15 s) is long over by the next call, so the next call of the same kind goes to the same AI again
- **Suggested fix:** in assist `_call_ai_once`, treat a TIMEOUT whose bridge body says typed + late_expired (or late_collect_tried) like UPSTREAM_UNAVAILABLE: add the slot to `failed` and move to another working AI (`_other_ai`), keeping the writer≠reviewer rule; do not do the 60 s same-AI retry when another AI could take the call; mark the slot failed for much longer than 15 s after a TIMEOUT (e.g. until its next successful probe), so the next call of any kind starts elsewhere (not implemented)
- **How likely:** likely in real use

**5. R-1-e ⚠️ — ChatGPT times out on every writers_room call while the two other AIs work**

- **Where:** akowe/akowe/assist.py `_call_ai_once` (~line 695–745): the checker jobs (review, scenes_check, editor, planned_check, writers' room …) pick a slot themselves and call `prov.generate(..., slot_id=slot["slot_id"])` (line ~720); in akowe/akowe/providers.py `_generate` (~1590–1660) an explicit slot_id means `others=False` (line ~1637), so `_generate_timeout_safe` (~1688) asks the SAME web AI once more after TIMEOUT_RETRY_WAIT_S (60 s) instead of moving; back in assist the failover branch (line ~733) moves only on UPSTREAM_UNAVAILABLE / AI_DECLINED / unusable — `_unusable` explicitly excludes TIMEOUT — so the TIMEOUT is raised
- **What happens:** writers' room: ≈ 41 min per room, ChatGPT's pitch/vote missing. The author sees: ChatGPT timed out on every writers_room call (typed, no answer, late window expired); the two other AIs worked. The run never stopped. In the end the writers_room calls were answered by nobody. (run status done → done; journal codes: VOICE_SET, VOICES_DISTINCT, WRITERS_ROOM, DOCTOR_SCORED, DOCTOR_DONE, PREDICT_PROBED, LEDGER_EMPTY, SCOPE_SET, GRID_EMPTY, TRADE_CARD_MADE, PROTAGONIST_OK, FIRST_PAGE_PICKED, SECOND_REVIEW, PLANNED_UNRESOLVED, PLANNED_MISSING, CHECKPOINT, ENDING_KEPT, VOICE_TEST_TOO_LITTLE, HUMAN_PASS, OPENING_UNRESOLVED, IMPROVE_UNRESOLVED, CLEAN_RUN_SCORE, BOOK_TOO_SHORT, QUALITY_TREND; log: 0 ERROR line(s), 0 traceback(s)).
- **How to reproduce:** `cd akowe && python -m tools.stress.run --section R --parts 1 --stress e` (ID R-1-e)
- **Likely cause:** TIMEOUT is treated as “ambiguous, the author decides” (contract rule from the paid-API days), but a web AI whose prompt was typed and whose late window expired (`late_expired` / `late_collect_tried`) is not ambiguous any more: nothing more will come. Each such call costs the full timeout (~895 s: `AutoInjectorAdapter.timeout_ms` caps at 900 s) + the late window (300 s) + 60 s + the same again on the -c1- try ≈ 41 min, then the checker stops the book or is skipped. The failed-slot hold (FAIL_HOLD_S = 15 s) is long over by the next call, so the next call of the same kind goes to the same AI again
- **Suggested fix:** in assist `_call_ai_once`, treat a TIMEOUT whose bridge body says typed + late_expired (or late_collect_tried) like UPSTREAM_UNAVAILABLE: add the slot to `failed` and move to another working AI (`_other_ai`), keeping the writer≠reviewer rule; do not do the 60 s same-AI retry when another AI could take the call; mark the slot failed for much longer than 15 s after a TIMEOUT (e.g. until its next successful probe), so the next call of any kind starts elsewhere (not implemented)
- **How likely:** likely in real use

**6. R-1-f ⚠️ — Claude times out on every bible-fill call while the two other AIs work**

- **Where:** akowe/akowe/providers.py `_generate` / `_generate_timeout_safe` (~1590–1710): the registry path (no slot_id) DOES move a TIMEOUT to the next working AI, but only after the whole timeout + late window (~20 min for a 900 s deadline, ~11 min for the writer's 355 s), and the bible batch got the 60 s same-AI retry first (book_bible fill → ~41 min, then BIBLE_FILL_LATER)
- **What happens:** bible fill: ≈ 41 min on the same AI, then a batch left for later. The author sees: Claude timed out on every bible-fill call (typed, no answer, late window expired); the two other AIs worked. The run never stopped. In the end the bible-fill calls were answered by ChatGPT. (run status done → done; journal codes: VOICE_SET, VOICES_DISTINCT, DOCTOR_SCORED, DOCTOR_DONE, PREDICT_PROBED, LEDGER_EMPTY, SCOPE_SET, GRID_EMPTY, TRADE_CARD_MADE, BIBLE_FILL_LATER, PROTAGONIST_OK, FIRST_PAGE_PICKED, INSTRUCTIONS_CUT, SECOND_REVIEW, PLANNED_UNRESOLVED, PLANNED_MISSING, CHECKPOINT, ENDING_KEPT, VOICE_TEST_TOO_LITTLE, HUMAN_PASS, OPENING_UNRESOLVED, IMPROVE_UNRESOLVED, CLEAN_RUN_SCORE, BOOK_TOO_SHORT, QUALITY_TREND; log: 0 ERROR line(s), 0 traceback(s)).
- **How to reproduce:** `cd akowe && python -m tools.stress.run --section R --parts 1 --stress f` (ID R-1-f)
- **Likely cause:** there is no early signal: Akọwe waits the full timeout it asked for, then the late window; the failed-slot hold is 15 s, so each new chapter starts on the AI that timed out again (3 chapters → 3 full timeouts)
- **Suggested fix:** after a TIMEOUT with late_expired, keep the slot “failed” until a probe says it answers again (not 15 s); give the writer's later chapters to the AI that took over; shorten timeout_ms when the bridge reports a stalled capture (see R-10-c) (not implemented)
- **How likely:** likely in real use

**7. R-1-g ⚠️ — Claude times out on every chapter-writer call while the two other AIs work**

- **Where:** akowe/akowe/providers.py `_generate` / `_generate_timeout_safe` (~1590–1710): the registry path (no slot_id) DOES move a TIMEOUT to the next working AI, but only after the whole timeout + late window (~20 min for a 900 s deadline, ~11 min for the writer's 355 s), and the bible batch got the 60 s same-AI retry first (book_bible fill → ~41 min, then BIBLE_FILL_LATER)
- **What happens:** chapter writer: moves to another AI, but only after ≈ 11 min per chapter, every chapter. The author sees: Claude timed out on every chapter-writer call (typed, no answer, late window expired); the two other AIs worked. The run never stopped. In the end the chapter-writer calls were answered by ChatGPT. (run status done → done; journal codes: VOICE_SET, VOICES_DISTINCT, DOCTOR_SCORED, DOCTOR_DONE, PREDICT_PROBED, LEDGER_EMPTY, SCOPE_SET, GRID_EMPTY, TRADE_CARD_MADE, PROTAGONIST_OK, FIRST_PAGE_PICKED, AI_MOVED, SECOND_REVIEW, PLANNED_UNRESOLVED, PLANNED_MISSING, CHECKPOINT, ENDING_KEPT, VOICE_TEST_TOO_LITTLE, HUMAN_PASS, OPENING_UNRESOLVED, IMPROVE_UNRESOLVED, CLEAN_RUN_SCORE, BOOK_TOO_SHORT, QUALITY_TREND; log: 0 ERROR line(s), 0 traceback(s)).
- **How to reproduce:** `cd akowe && python -m tools.stress.run --section R --parts 1 --stress g` (ID R-1-g)
- **Likely cause:** there is no early signal: Akọwe waits the full timeout it asked for, then the late window; the failed-slot hold is 15 s, so each new chapter starts on the AI that timed out again (3 chapters → 3 full timeouts)
- **Suggested fix:** after a TIMEOUT with late_expired, keep the slot “failed” until a probe says it answers again (not 15 s); give the writer's later chapters to the AI that took over; shorten timeout_ms when the bridge reports a stalled capture (see R-10-c) (not implemented)
- **How likely:** likely in real use

## R-2 an answer that arrives late

**What it does:** The prompt was typed, the answer came after the timeout: inside the late-answer window (is it used?) or only after LATE_EXPIRED (is it thrown away, and what does asking again cost?).

| ID | Stress | Result | What happened |
|---|---|---|---|
| R-2-a | the reviewer's answer arrives 2 min after the timeout, inside the late-answer window | ✅ | ChatGPT's first review answer came 2 min after the timeout (prompt typed, late window open): Akọwe re-joined the same request and USED the late answer; the run never stopped. Note: Measured: status done; 0 stop(s); time waited ≈ 16.9 min (simulated clock); 1 TIMEOUT / 0 LATE_EXPIRED / 1 late answer(s) used; answered in the end by ChatGPT, Gemini. |
| R-2-b | the reviewer's answer arrives only after LATE_EXPIRED (too late) | ⚠️ | ChatGPT's first review answer came only after the late window had closed (LATE_EXPIRED): it was thrown away (Akọwe forgets the late request; AutoInjector drops a reply after LATE_EXPIRED), and the same prompt was typed AGAIN into ChatGPT's chat (the -c1- try) 20.9 min after the first send; that answer was used; the run never stopped. ⚠️ the second try went to the SAME AI (ChatGPT, -c1-) after a 60 s wait, typing the whole prompt again into a chat that already holds the late answer, while Gemini and Claude were free; the run waited ≈ 20.9 min on the AI that could not answer before anything moved (limit 5.0 min when another AI works) Note: Measured: status done; 0 stop(s); time waited ≈ 20.9 min (simulated clock); 1 TIMEOUT / 1 LATE_EXPIRED / 0 late answer(s) used; answered in the end by ChatGPT, Gemini. |
| R-2-c | the writer's chapter arrives 2 min after the timeout (late window) | ✅ | Claude's first chapter came 2 min after the timeout: the late answer was used (nothing written twice); the run never stopped. Note: Measured: status done; 0 stop(s); time waited ≈ 7.9 min (simulated clock); 1 TIMEOUT / 0 LATE_EXPIRED / 1 late answer(s) used; answered in the end by Claude. |

### Findings in R-2

**8. R-2-b ⚠️ — the reviewer's answer arrives only after LATE_EXPIRED (too late)**

- **Where:** akowe/akowe/providers.py `_generate_timeout_safe` (~1688–1710) and `_post_collecting` (~1100): after LATE_EXPIRED the late request is forgotten (`_forget_late`) and, with an explicit slot, the whole prompt is sent again to the SAME AI after 60 s (bridge id -c1-)
- **What happens:** a late answer after LATE_EXPIRED is thrown away and the same AI is asked again: ≈ 21 min. The author sees: ChatGPT's first review answer came only after the late window had closed (LATE_EXPIRED): it was thrown away (Akọwe forgets the late request; AutoInjector drops a reply after LATE_EXPIRED), and the same prompt was typed AGAIN into ChatGPT's chat (the -c1- try) 20.9 min after the first send; that answer was used; the run never stopped. (run status done → done; journal codes: VOICE_SET, VOICES_DISTINCT, DOCTOR_SCORED, DOCTOR_DONE, PREDICT_PROBED, LEDGER_EMPTY, SCOPE_SET, GRID_EMPTY, TRADE_CARD_MADE, PROTAGONIST_OK, FIRST_PAGE_PICKED, SECOND_REVIEW, PLANNED_UNRESOLVED, PLANNED_MISSING, CHECKPOINT, ENDING_KEPT, VOICE_TEST_TOO_LITTLE, HUMAN_PASS, OPENING_UNRESOLVED, IMPROVE_UNRESOLVED, CLEAN_RUN_SCORE, BOOK_TOO_SHORT, QUALITY_TREND; log: 0 ERROR line(s), 0 traceback(s)).
- **How to reproduce:** `cd akowe && python -m tools.stress.run --section R --parts 2 --stress b` (ID R-2-b)
- **Likely cause:** the answer that arrives after LATE_EXPIRED is dropped by AutoInjector and Akọwe has no way to ask for it; the second try is a new prompt typed into the chat that already holds the late answer
- **Suggested fix:** move the second try to another working AI when one exists (see R-1); optionally ask AutoInjector for a reply that arrived after LATE_EXPIRED under the old request id before typing again (not implemented)
- **How likely:** likely in real use

## R-3 every AI times out

**What it does:** No AI can answer: the expected result is a safe stop (🟡) — how long before it?

| ID | Stress | Result | What happened |
|---|---|---|---|
| R-3-a | every AI times out on every review call (no AI can review) | 🟡 | No AI could review. The run stopped 1× (TIMEOUT@canon) after ≈ 40.8 min of timeouts; asked before the stop: ChatGPT. After the fault was removed, 🔁 Try again finished the book. Note: Only ChatGPT was/were asked before the stop (the writer Claude is never a reviewer of its own work while another AI works; Gemini was not tried) — still a safe stop because no AI could have answered. Measured: status done; 1 stop(s) (TIMEOUT@canon); time waited ≈ 40.8 min (simulated clock); 2 TIMEOUT / 2 LATE_EXPIRED / 0 late answer(s) used; answered in the end by Gemini, ChatGPT. |
| R-3-b | every AI times out on the chapter writer | 🟡 | No AI could write the chapter. The run stopped (TIMEOUT@chapters) after ≈ 44.6 min of timeouts; asked before the stop: ChatGPT, Claude, Gemini. After the fault was removed, 🔁 Try again finished the book. Note: Measured: status done; 1 stop(s) (TIMEOUT@chapters); time waited ≈ 44.6 min (simulated clock); 4 TIMEOUT / 4 LATE_EXPIRED / 0 late answer(s) used; answered in the end by Claude. |

## R-4 a stop while the author is away

**What it does:** The run stopped on a TIMEOUT at night. How long until anything happens on its own (no auto-retry, the stand-in vote off by default)?

| ID | Stress | Result | What happened |
|---|---|---|---|
| R-4-a | a TIMEOUT stop at night with the default settings (stand-in vote off) | ⚠️ | The run stopped on TIMEOUT@canon while Claude and Gemini worked. The author is away: +19 min: nothing happened (run paused, TIMEOUT); +21 min: nothing happened (run paused, TIMEOUT); +5 h: nothing happened (run paused, TIMEOUT). Nothing retries or moves the step on its own: the run waits for the author however long that is (the log: ~5 h). When the author came back (fault gone), 🔁 Try again finished the book. ⚠️ with the default settings a TIMEOUT stop waits for the author indefinitely (no automatic retry, no move to a working AI, the 🗳 stand-in vote is off by default): 5 h in the log; 1 stop(s) for the author (TIMEOUT@canon) although Claude and Gemini worked and could have answered; the run waited ≈ 40.8 min on the AI that could not answer before anything moved (limit 5.0 min when another AI works) Note: Measured: status done; 1 stop(s) (TIMEOUT@canon); time waited ≈ 40.8 min (simulated clock); 2 TIMEOUT / 2 LATE_EXPIRED / 0 late answer(s) used; answered in the end by Gemini, ChatGPT. |
| R-4-b | the same stop with 🗳 “when something goes wrong, the AIs vote” on (after 20 min) | ⚠️ | The run stopped on TIMEOUT@canon; 🗳 on. +19 min: nothing happened (run paused, TIMEOUT); +21 min: stand-in VOTE_MISSING (run paused, TIMEOUT); +5 h: nothing happened (run paused, TIMEOUT). ChatGPT (the AI that cannot answer) is one of the voters, so its vote times out too. ⚠️ the vote can never decide while the AI that cannot answer is one of the voters (its vote times out → no decision): the run still waits for the author; 1 stop(s) for the author (TIMEOUT@canon) although Claude and Gemini worked and could have answered; the run waited ≈ 81.6 min on the AI that could not answer before anything moved (limit 5.0 min when another AI works) Note: Stand-in words: “Not every AI could vote (Claude: another AI, Gemini: another AI, ChatGPT: no answer) — Claude, Gemini and ChatGPT were asked and all 3 must agree, so it waits f”. Measured: status done; 1 stop(s) (TIMEOUT@canon); time waited ≈ 81.6 min (simulated clock); 4 TIMEOUT / 4 LATE_EXPIRED / 0 late answer(s) used; answered in the end by Gemini, ChatGPT. |
| R-4-c | 🗳 on and the broken AI can still vote: the AIs agree on “another AI” | ⚠️ | The run stopped on TIMEOUT@canon; 🗳 on. +19 min: nothing happened (run paused, TIMEOUT); +21 min: stand-in DECIDED (run paused, TIMEOUT); +5 h: nothing happened (run paused, TIMEOUT). The AIs all agreed on “try again with another AI”, but the review was given to ChatGPT again (2 more timed-out call(s)) and the run stopped again on the same problem; that stop is not voted on a second time, so it waited for the author. ⚠️ the stand-in decision “another AI” does not reach the reviewer: the review went back to the AI that cannot answer and the run stopped again; 1 stop(s) for the author (TIMEOUT@canon) although Claude and Gemini worked and could have answered; the run waited ≈ 81.6 min on the AI that could not answer before anything moved (limit 5.0 min when another AI works) Note: Measured: status done; 1 stop(s) (TIMEOUT@canon); time waited ≈ 81.6 min (simulated clock); 4 TIMEOUT / 4 LATE_EXPIRED / 0 late answer(s) used; answered in the end by Gemini, ChatGPT. |

### Findings in R-4

**9. R-4-a ⚠️ — a TIMEOUT stop at night with the default settings (stand-in vote off)**

- **Where:** akowe/akowe/autobook.py `_pause_problem` (~1588): a TIMEOUT stop is a plain pause (options [retry]); akowe/akowe/stand_in.py DEFAULTS (`errors`: False) — nothing else ever resumes it
- **What happens:** a TIMEOUT stop at night waits for the author indefinitely (5 h in the log) while two AIs work. The author sees: The run stopped on TIMEOUT@canon while Claude and Gemini worked. The author is away: +19 min: nothing happened (run paused, TIMEOUT); +21 min: nothing happened (run paused, TIMEOUT); +5 h: nothing happened (run paused, TIMEOUT). Nothing retries or moves the step on its own: the run waits for the author however long that is (the log: ~5 h). When the author came back (fault gone), 🔁 Try again finished the book. (run status paused → done; problem TIMEOUT; journal codes: VOICE_SET, TIMEOUT, VOICES_DISTINCT, DOCTOR_SCORED, DOCTOR_DONE, PREDICT_PROBED, LEDGER_EMPTY, SCOPE_SET, GRID_EMPTY, TRADE_CARD_MADE, PROTAGONIST_OK, FIRST_PAGE_PICKED, SECOND_REVIEW, PLANNED_UNRESOLVED, PLANNED_MISSING, CHECKPOINT, ENDING_KEPT, VOICE_TEST_TOO_LITTLE, HUMAN_PASS, OPENING_UNRESOLVED, IMPROVE_UNRESOLVED, CLEAN_RUN_SCORE, BOOK_TOO_SHORT, QUALITY_TREND; log: 0 ERROR line(s), 0 traceback(s)).
- **How to reproduce:** `cd akowe && python -m tools.stress.run --section R --parts 4 --stress a` (ID R-4-a)
- **Likely cause:** no automatic retry or failover for an error stop unless the author switched 🗳 on in Settings › AI
- **Suggested fix:** for a TIMEOUT stop while another AI works: retry automatically once with another AI after a few minutes (or make 🗳 “another AI” the default for TIMEOUT); keep the alert (not implemented)
- **How likely:** likely in real use

**10. R-4-b ⚠️ — the same stop with 🗳 “when something goes wrong, the AIs vote” on (after 20 min)**

- **Where:** akowe/akowe/stand_in.py `voters` / `tally` and stand_in_errors.decide: every connected working AI votes, all must agree; a missing vote = VOTE_MISSING
- **What happens:** with 🗳 on, the vote fails (VOTE_MISSING) because the broken AI must vote too. The author sees: The run stopped on TIMEOUT@canon; 🗳 on. +19 min: nothing happened (run paused, TIMEOUT); +21 min: stand-in VOTE_MISSING (run paused, TIMEOUT); +5 h: nothing happened (run paused, TIMEOUT). ChatGPT (the AI that cannot answer) is one of the voters, so its vote times out too. (run status paused → done; problem TIMEOUT; journal codes: VOICE_SET, TIMEOUT, STAND_IN_WAITS, VOICES_DISTINCT, DOCTOR_SCORED, DOCTOR_DONE, PREDICT_PROBED, LEDGER_EMPTY, SCOPE_SET, GRID_EMPTY, TRADE_CARD_MADE, PROTAGONIST_OK, FIRST_PAGE_PICKED, SECOND_REVIEW, PLANNED_UNRESOLVED, PLANNED_MISSING, CHECKPOINT, ENDING_KEPT, VOICE_TEST_TOO_LITTLE, HUMAN_PASS, OPENING_UNRESOLVED, IMPROVE_UNRESOLVED, CLEAN_RUN_SCORE, BOOK_TOO_SHORT, QUALITY_TREND; log: 0 ERROR line(s), 0 traceback(s)).
- **How to reproduce:** `cd akowe && python -m tools.stress.run --section R --parts 4 --stress b` (ID R-4-b)
- **Likely cause:** the AI that cannot answer (its replies are unreadable) is itself a voter, so its vote times out (another ≈ 20–40 min) and the vote can never decide
- **Suggested fix:** leave out of the voters the AI whose failure caused the stop (run['last_failed_slot']) and any slot that timed out in the last hour (not implemented)
- **How likely:** likely in real use

**11. R-4-c ⚠️ — 🗳 on and the broken AI can still vote: the AIs agree on “another AI”**

- **Where:** akowe/akowe/stand_in_errors.py `apply` (pick other_ai, ~240–250) → autobook `_TimedProviders.avoid` (~632): only the run's writer pin / avoid set changes; the reviewer job (review.py `plan_reviewer`, assist `_choose_slot`) never reads it
- **What happens:** the AIs agree on “another AI”, but the review goes to the broken AI again and the run stops again. The author sees: The run stopped on TIMEOUT@canon; 🗳 on. +19 min: nothing happened (run paused, TIMEOUT); +21 min: stand-in DECIDED (run paused, TIMEOUT); +5 h: nothing happened (run paused, TIMEOUT). The AIs all agreed on “try again with another AI”, but the review was given to ChatGPT again (2 more timed-out call(s)) and the run stopped again on the same problem; that stop is not voted on a second time, so it waited for the author. (run status paused → done; problem TIMEOUT; journal codes: VOICE_SET, TIMEOUT, STAND_IN_DECIDED, VOICES_DISTINCT, DOCTOR_SCORED, DOCTOR_DONE, PREDICT_PROBED, LEDGER_EMPTY, SCOPE_SET, GRID_EMPTY, TRADE_CARD_MADE, PROTAGONIST_OK, FIRST_PAGE_PICKED, SECOND_REVIEW, PLANNED_UNRESOLVED, PLANNED_MISSING, CHECKPOINT, ENDING_KEPT, VOICE_TEST_TOO_LITTLE, HUMAN_PASS, OPENING_UNRESOLVED, IMPROVE_UNRESOLVED, CLEAN_RUN_SCORE, BOOK_TOO_SHORT, QUALITY_TREND; log: 0 ERROR line(s), 0 traceback(s)).
- **How to reproduce:** `cd akowe && python -m tools.stress.run --section R --parts 4 --stress c` (ID R-4-c)
- **Likely cause:** “try again with another AI” is applied to the run's provider view, not to the checker jobs, so the review goes back to the AI that timed out and the run stops again; the same stop key is not voted twice
- **Suggested fix:** pass the avoided slot(s) into the review / checker jobs (job.never_slots or avoid_slots) for the retried step (not implemented)
- **How likely:** unlikely but dangerous

## R-5 the finished book without a pen name

**What it does:** No pen name was typed: what do the title page, the running heads and the metadata of the PDF / EPUB / DOCX say?

| ID | Stress | Result | What happened |
|---|---|---|---|
| R-5-a | no pen name typed: what the PDF / EPUB / DOCX print as the author | ⚠️ | No pen name was typed. “Unknown author” is printed on 1 of 14 PDF page(s) (the title page: yes; this PDF's running heads carry the title and chapter, not the author), in the PDF's Author field (yes), in the EPUB (OEBPS/content.opf, OEBPS/text/s001.xhtml: the title page and the dc:creator metadata) and in the DOCX (docProps/core.xml, word/document.xml, word/header2.xml — word/header2.xml is the running head of every left-hand page). The run said nothing about the missing pen name. ⚠️ the finished files print the placeholder “Unknown author” as the author (title page, running heads, metadata) and the run never asked for or mentioned a pen name Note: Measured: status done; 0 stop(s); time waited ≈ 0.0 min (simulated clock). |
| R-5-b | control: a pen name typed for the run | ✅ | With the pen name typed, it is printed on 1 of 14 PDF page(s); “Unknown author” appears on 0 page(s), EPUB nowhere, DOCX nowhere. Note: Measured: status done; 0 stop(s); time waited ≈ 0.0 min (simulated clock). |

### Findings in R-5

**12. R-5-a ⚠️ — no pen name typed: what the PDF / EPUB / DOCX print as the author**

- **Where:** akowe/akowe/book_path.py `title_author` (line ~485): `... or "Unknown author"`; exporters print it on the title page, the EPUB dc:creator, the DOCX core.xml and the DOCX left-hand running head (word/header2.xml)
- **What happens:** “Unknown author” on the title page, metadata and DOCX running heads when no pen name was typed. The author sees: No pen name was typed. “Unknown author” is printed on 1 of 14 PDF page(s) (the title page: yes; this PDF's running heads carry the title and chapter, not the author), in the PDF's Author field (yes), in the EPUB (OEBPS/content.opf, OEBPS/text/s001.xhtml: the title page and the dc:creator metadata) and in the DOCX (docProps/core.xml, word/document.xml, word/header2.xml — word/header2.xml is the running head of every left-hand page). The run said nothing about the missing pen name. (run status done → done; journal codes: VOICE_SET, VOICES_DISTINCT, DOCTOR_SCORED, DOCTOR_DONE, PREDICT_PROBED, LEDGER_EMPTY, SCOPE_SET, GRID_EMPTY, TRADE_CARD_MADE, PROTAGONIST_OK, FIRST_PAGE_PICKED, CHAPTER_POLISH_KEPT, ONE_REVIEWER, PLANNED_UNRESOLVED, PLANNED_MISSING, CUT_PASS_NOTHING, CHECKPOINT, CHAPTER_POLISH_NOT_KEPT, INSTRUCTIONS_CUT, KEY_SCENE_NOT_USED, ENDING_KEPT, VOICE_TEST_TOO_LITTLE, CHAPTER_POLISH, REPEATS_TO_TRIM, HUMAN_PASS, OPENING_UNRESOLVED, IMPROVE_UNRESOLVED, CLEAN_RUN_SCORE, QUALITY_TREND; log: 0 ERROR line(s), 0 traceback(s)).
- **How to reproduce:** `cd akowe && python -m tools.stress.run --section R --parts 5 --stress a` (ID R-5-a)
- **Likely cause:** an empty pen name is replaced by a placeholder instead of being left out, and the run never asks for a pen name or warns
- **Suggested fix:** leave the author line out when there is no pen name (no title-page line, title-only running heads, no creator) and add a ⚠️ note “no pen name — type one in Book profile” to the run summary (not implemented)
- **How likely:** likely in real use

## R-6 a long sentence repeated across chapters

**What it does:** The same long sentence word for word in chapters 1 and 3: does any check catch it, and is it still in the finished book?

| ID | Stress | Result | What happened |
|---|---|---|---|
| R-6-a | the same long sentence word for word in chapters 1 and 3 | ⚠️ | The finished book still has the sentence 2× (chapters 1 and 3). The cross-chapter repeat check reported it only as 5 separate “same phrase in several chapters” finding(s) of 5-word pieces (minor), e.g. “a bell kept time with” — never as one whole sentence repeated word for word; the end pass offered rewrite suggestions; nothing was changed in the book. ⚠️ a long sentence repeated word for word in two chapters is still in the finished book; it is reported only as 5 minor 5-word phrase repeats Note: Measured: status done; 0 stop(s); time waited ≈ 0.0 min (simulated clock). |

### Findings in R-6

**13. R-6-a ⚠️ — the same long sentence word for word in chapters 1 and 3**

- **Where:** akowe/akowe/human_voice.py `_repeats` (~326–430): phrases are 5-word n-grams; overlapping grams of one sentence are partly merged (`kept`, ≥ 4 shared words) and reported as minor “same phrase in several chapters”; no whole-sentence comparison
- **What happens:** a long sentence repeated word for word in chapters 1 and 3 stays in the book. The author sees: The finished book still has the sentence 2× (chapters 1 and 3). The cross-chapter repeat check reported it only as 5 separate “same phrase in several chapters” finding(s) of 5-word pieces (minor), e.g. “a bell kept time with” — never as one whole sentence repeated word for word; the end pass offered rewrite suggestions; nothing was changed in the book. (run status done → done; journal codes: VOICE_SET, VOICES_DISTINCT, DOCTOR_SCORED, DOCTOR_DONE, PREDICT_PROBED, LEDGER_EMPTY, SCOPE_SET, GRID_EMPTY, TRADE_CARD_MADE, PROTAGONIST_OK, FIRST_PAGE_PICKED, ONE_REVIEWER, PLANNED_UNRESOLVED, PLANNED_MISSING, CHECKPOINT, CHAPTER_POLISH_NOT_KEPT, ENDING_KEPT, VOICE_TEST_TOO_LITTLE, CHAPTER_POLISH, HUMAN_PASS, OPENING_UNRESOLVED, IMPROVE_UNRESOLVED, CLEAN_RUN_SCORE, BOOK_TOO_SHORT, QUALITY_TREND; log: 0 ERROR line(s), 0 traceback(s)).
- **How to reproduce:** `cd akowe && python -m tools.stress.run --section R --parts 6 --stress a` (ID R-6-a)
- **Likely cause:** a repeated SENTENCE is seen only as several minor phrase repeats and nothing removes it (the end pass only suggests rewrites)
- **Suggested fix:** add an exact (normalised) sentence match across chapters for sentences of ≥ 12 words, reported as one major finding and fed to the cut pass / end pass as a must-fix (not implemented)
- **How likely:** likely in real use

## R-7 a book over its length target and the cut pass

**What it does:** Chapters written well over their share: does the cut pass keep any of the editor's cuts?

| ID | Stress | Result | What happened |
|---|---|---|---|
| R-7-a | chapters ~25 % over their share; the editor proposes valid labelled cuts | ✅ | Book 4589 words of a 4000-word target (115 %). The editor proposed cuts in 3 chapter(s); the cut pass KEPT cuts in 3 of 3 chapter(s) (ch1: 15 cut(s); ch2: 15 cut(s); ch3: 15 cut(s)). Note: Cut pass per chapter: [{"chapter": "ch1", "kept": true, "cuts": 15, "proposed": 15, "outcome": "kept", "refused": {}, "words": "1701→1528"}, {"chapter": "ch2", "kept": true, "cuts": 15, "proposed": 15, "outcome": "kept", "refused": {}, "words": "1707→1535"}, {"chapter": "ch3", "kept": true, "cuts": 15, "proposed": 15, "outcome": "kept", "refused": {}, "words": "1700→1526"}] Measured: status done; 0 stop(s); time waited ≈ 0.0 min (simulated clock). |
| R-7-b | the Practice AI's own cut pass on a book over its target (no scripted cuts) | ✅ | With the Practice AI's editor (it proposes no cuts) the cut pass kept cuts in 0 of 3 chapter(s). Note: The Practice AI never proposes a cut (cut_script empty): a run with it can never show the cut pass working — a test of the cut pass needs scripted cuts (R-7-a). Measured: status done; 0 stop(s); time waited ≈ 0.0 min (simulated clock). |
| R-7-c | the editor's cuts quote the chapter with straight apostrophes where the text has curly ones | ⚠️ | The editor proposed 42 cut(s), each the exact sentence except a straight apostrophe for the chapter's curly one; the cut pass kept cuts in 0 of 3 chapter(s); refused: {'NOT_FOUND': 42}. ⚠️ every cut was refused because its quote differs from the chapter only in typography (’ vs '): the book stays over its target with 0 cuts kept — the log's “0 cuts in all 3 chapters” Note: Cut pass per chapter: [{"chapter": "ch1", "kept": false, "cuts": 0, "proposed": 14, "outcome": "nothing", "refused": {"NOT_FOUND": 14}, "words": "1705→None"}, {"chapter": "ch2", "kept": false, "cuts": 0, "proposed": 14, "outcome": "nothing", "refused": {"NOT_FOUND": 14}, "words": "1708→None"}, {"chapter": "ch3", "kept": false, "cuts": 0, "proposed": 14, "outcome": "nothing", "refused": {"NOT_FOUND": 14}, "words": "1700→None"}] Measured: status done; 0 stop(s); time waited ≈ 0.0 min (simulated clock). |

### Findings in R-7

**14. R-7-c ⚠️ — the editor's cuts quote the chapter with straight apostrophes where the text has curly ones**

- **Where:** akowe/akowe/cut_pass.py `validate` (~173–215): `NOT_FOUND` when the quote is not in the chapter exactly
- **What happens:** all cuts refused (NOT_FOUND) for a ’ vs ' difference: 0 cuts kept, the book stays over its target. The author sees: The editor proposed 42 cut(s), each the exact sentence except a straight apostrophe for the chapter's curly one; the cut pass kept cuts in 0 of 3 chapter(s); refused: {'NOT_FOUND': 42}. (run status done → done; journal codes: VOICE_SET, VOICES_DISTINCT, DOCTOR_SCORED, DOCTOR_DONE, PREDICT_PROBED, LEDGER_EMPTY, SCOPE_SET, GRID_EMPTY, TRADE_CARD_MADE, PROTAGONIST_OK, FIRST_PAGE_PICKED, CHAPTER_POLISH_NOT_KEPT, ONE_REVIEWER, PLANNED_UNRESOLVED, PLANNED_MISSING, CUT_PASS_NOTHING, CHECKPOINT, INSTRUCTIONS_CUT, KEY_SCENE_NOT_USED, ENDING_KEPT, VOICE_TEST_TOO_LITTLE, CHAPTER_POLISH, REPEATS_TO_TRIM, HUMAN_PASS, OPENING_UNRESOLVED, IMPROVE_UNRESOLVED, CLEAN_RUN_SCORE, QUALITY_TREND; log: 0 ERROR line(s), 0 traceback(s)).
- **How to reproduce:** `cd akowe && python -m tools.stress.run --section R --parts 7 --stress c` (ID R-7-c)
- **Likely cause:** the match is byte-exact; web AIs routinely answer with straight quotes / apostrophes / hyphens where the book has typographic ones (or the reverse), so every cut is refused
- **Suggested fix:** match after normalising quotes, apostrophes, dashes and whitespace (map the hit back to the original span), like fact_checks does for rewrites; count NOT_FOUND refusals in the journal so a 0-cut pass says why (not implemented)
- **How likely:** likely in real use

## R-8 the editor reads a version that is not the final one

**What it does:** After the editor's read the chapter changes again (planned details, cuts, the opening pass): which version did the editor's notes describe?

| ID | Stress | Result | What happened |
|---|---|---|---|
| R-8-a | the chapter changes after the editor's read (planned details worked in, cuts kept) | ⚠️ | Editor's read vs the final version: ch1: editor read v2, final v4; ch2: editor read v1, final v3; ch3: editor read v1, final v3. ⚠️ the editor's notes (and the report's editor lines) describe an earlier version in 3 chapter(s) (ch1, ch2, ch3): the final text was changed after the editor read it and was not read again Note: Measured: status done; 0 stop(s); time waited ≈ 0.0 min (simulated clock). |

### Findings in R-8

**15. R-8-a ⚠️ — the chapter changes after the editor's read (planned details worked in, cuts kept)**

- **Where:** akowe/akowe/autobook.py `_review_until_approved` order: editor (~2281) → planned pass (~2460) → cut pass → approval; then opening / improve passes; craft_reviews:<book> keeps the read version (`<rid>:<version>`)
- **What happens:** the editor's notes describe v1–v2, the final chapters are v3–v4. The author sees: Editor's read vs the final version: ch1: editor read v2, final v4; ch2: editor read v1, final v3; ch3: editor read v1, final v3. (run status done → done; journal codes: VOICE_SET, VOICES_DISTINCT, DOCTOR_SCORED, DOCTOR_DONE, PREDICT_PROBED, LEDGER_EMPTY, SCOPE_SET, GRID_EMPTY, TRADE_CARD_MADE, PROTAGONIST_OK, FIRST_PAGE_PICKED, CHAPTER_POLISH_KEPT, ONE_REVIEWER, PLANNED_FIX_KEPT, CUT_PASS_KEPT, STORY_MAP, CHECKPOINT, CHAPTER_POLISH_NOT_KEPT, CONTINUITY_FLAG, INSTRUCTIONS_CUT, KEY_SCENE_NOT_USED, ENDING_KEPT, VOICE_TEST_TOO_LITTLE, CHAPTER_POLISH, REPEATS_TO_TRIM, HUMAN_PASS, OPENING_UNRESOLVED, IMPROVE_UNRESOLVED, CLEAN_RUN_SCORE, QUALITY_TREND; log: 0 ERROR line(s), 0 traceback(s)).
- **How to reproduce:** `cd akowe && python -m tools.stress.run --section R --parts 8 --stress a` (ID R-8-a)
- **Likely cause:** the chapter changes after the editor's read (planned details worked in, cuts kept, end rewrites) and the editor never reads the final version; the report shows the old notes
- **Suggested fix:** after a kept planned / cut / end rewrite, re-run the editor's read on the final version (notes only), or label the report's editor lines “read version N of M” (not implemented)
- **How likely:** likely in real use

## R-9 planned details missing from the page at the end

**What it does:** The planned-to-page check keeps finding the same planned details missing and the rewrites do not add them: what does the finished book / the author get?

| ID | Stress | Result | What happened |
|---|---|---|---|
| R-9-a | the writer's planned-detail fixes do not match the text (the default Practice AI writer) | ⚠️ | 10 planned detail(s) are not on the page in the finished book (ch1, ch2, ch3); the writer's fixes never matched the text word for word (PLANNED_UNRESOLVED), one round each. The journal and the report list them (PLANNED_MISSING); the book goes on. ⚠️ 10 planned detail(s) missing from the finished book after one failed fix round per chapter (no second try, no other AI asked to work them in) Note: Measured: status done; 0 stop(s); time waited ≈ 0.0 min (simulated clock). |
| R-9-b | a writer that does work the planned details in | ✅ | With a writer whose fixes match the text: 0 planned detail(s) still missing at the end (none). Note: Measured: status done; 0 stop(s); time waited ≈ 0.0 min (simulated clock). |

### Findings in R-9

**16. R-9-a ⚠️ — the writer's planned-detail fixes do not match the text (the default Practice AI writer)**

- **Where:** akowe/akowe/autobook.py `_planned_work` (~2460–2560), planned.ROUNDS
- **What happens:** planned details stay off the page after one failed fix round (listed as PLANNED_MISSING). The author sees: 10 planned detail(s) are not on the page in the finished book (ch1, ch2, ch3); the writer's fixes never matched the text word for word (PLANNED_UNRESOLVED), one round each. The journal and the report list them (PLANNED_MISSING); the book goes on. (run status done → done; journal codes: VOICE_SET, VOICES_DISTINCT, DOCTOR_SCORED, DOCTOR_DONE, PREDICT_PROBED, LEDGER_EMPTY, SCOPE_SET, GRID_EMPTY, TRADE_CARD_MADE, PROTAGONIST_OK, FIRST_PAGE_PICKED, ONE_REVIEWER, PLANNED_UNRESOLVED, PLANNED_MISSING, CHECKPOINT, ENDING_KEPT, VOICE_TEST_TOO_LITTLE, HUMAN_PASS, OPENING_UNRESOLVED, IMPROVE_UNRESOLVED, CLEAN_RUN_SCORE, BOOK_TOO_SHORT, QUALITY_TREND; log: 0 ERROR line(s), 0 traceback(s)).
- **How to reproduce:** `cd akowe && python -m tools.stress.run --section R --parts 9 --stress a` (ID R-9-a)
- **Likely cause:** one fix round; when the writer's replacements do not match the text word for word (PLANNED_UNRESOLVED) nothing else is tried — no second writer, no looser match
- **Suggested fix:** on PLANNED_UNRESOLVED ask once more with the exact paragraphs to change (or another working AI), and match the replacements' originals after normalising like R-7-c (not implemented)
- **How likely:** likely in real use

## R-10 out of the box: more from the log

**What it does:** The writer's AI pane broken for hours, the bridge reporting the stalled AI, ChatGPT failing every kind for the whole night with the author pressing Try again, and the clean-run score.

| ID | Stress | Result | What happened |
|---|---|---|---|
| R-10-a | Claude's pane broken for the whole run (SEND_NOT_CONFIRMED, pane-broken) | ✅ | AutoInjector reported Claude's pane as broken (SEND_NOT_CONFIRMED) all run. The writing went to ChatGPT; the run never stopped; Claude was sent 0 request(s) anyway. Note: Measured: status done; 0 stop(s); time waited ≈ 0.0 min (simulated clock); 0 TIMEOUT / 0 LATE_EXPIRED / 0 late answer(s) used; answered in the end by ChatGPT. |
| R-10-b | Claude's pane breaks in the middle of the chapters | ✅ | Claude's pane broke as the chapters began. The run never stopped. Chapters written by ChatGPT. Note: Measured: status done; 0 stop(s); time waited ≈ 0.0 min (simulated clock); 0 TIMEOUT / 0 LATE_EXPIRED / 0 late answer(s) used; answered in the end by ChatGPT. |
| R-10-c | the bridge reports ChatGPT as broken once its capture stalls (the suggested AutoInjector signal) | ⚠️ | Simulated hook (AutoInjector does not do this today): after ChatGPT's first stalled reply, the bridge's /v1/health says ChatGPT is broken (REPLY_UNREADABLE). The run never stopped. ChatGPT timed out 1× in all (vs 14× in R-1-a); reviews answered by Gemini. ⚠️ the run waited ≈ 14.9 min on the AI that could not answer before anything moved (limit 5.0 min when another AI works) Note: Shows what the fix on AutoInjector's side would buy: the stall becomes a site state Akọwe already routes around (P18.9), so only the first request is lost. Measured: status done; 0 stop(s); time waited ≈ 14.9 min (simulated clock); 1 TIMEOUT / 0 LATE_EXPIRED / 0 late answer(s) used; answered in the end by Gemini. |
| R-10-d | the log's night: ChatGPT cannot be read on ANY call; the author presses Try again on every stop | ⚠️ | ChatGPT timed out on every call of every kind (Claude and Gemini fine). 38 TIMEOUTs (review ×8, checkpoint ×8, generic ×6, craft ×6, book_review ×4, plan_review ×2, ending ×2, originality ×2); 1 stop(s) for the author (TIMEOUT@canon); clean-run score 8.0/10. ⚠️ 1 stop(s) for the author (TIMEOUT@canon) although Claude and Gemini worked and could have answered; the run waited ≈ 12.9 h on the AI that could not answer before anything moved (limit 5.0 min when another AI works) Note: Measured: status done; 1 stop(s) (TIMEOUT@canon); time waited ≈ 12.9 h (simulated clock); 38 TIMEOUT / 38 LATE_EXPIRED / 0 late answer(s) used. |
| R-10-e | the clean-run score after hours lost to a timed-out AI but no stop | ⚠️ | The editor and the planned-to-page check timed out on ChatGPT in every chapter (≈ 2.0 h lost, both checks skipped), no stop: the clean-run score says 10.0/10 “a clean run”. ⚠️ the clean-run score reads 10.0/10 (“a clean run”) although ≈ 2.0 h went on timeouts and the editor's read and the planned check were skipped in every chapter: TIMEOUTs, skipped checks and failovers cost nothing in the score; the run waited ≈ 2.0 h on the AI that could not answer before anything moved (limit 5.0 min when another AI works) Note: Measured: status done; 0 stop(s); time waited ≈ 2.0 h (simulated clock); 6 TIMEOUT / 6 LATE_EXPIRED / 0 late answer(s) used; answered in the end by Gemini. |
| R-10-f | crew members named by number (“Crewman Two”) | ⚠️ | A character the AI named “Crewman Two” is in the finished book 4×; no check flagged a name made of a role and a number. ⚠️ a character named by number (“Crewman Two”) reaches the finished book unflagged Note: Measured: status done; 0 stop(s); time waited ≈ 0.0 min (simulated clock). |
| R-10-g | Claude's health reads ok but every send fails (SEND_NOT_CONFIRMED on each request) | ⚠️ | AutoInjector's health said Claude was fine, but every prompt sent to Claude failed (SEND_NOT_CONFIRMED). Claude was tried 945× during the run; the run never stopped; chapters written by ChatGPT. 15 different jobs (checks that want every working AI: cross-check reviews, the editor, checkpoints, the book report …) sent to Claude and then WAITED for it (“Waiting for Claude (not reachable) — retrying”) because its health still read ok. ⚠️ 15 jobs waited and retried on Claude whose every send failed while its health read ok; with the default retry policy (15/30/60/120 s, up to 10 min per job) that is up to ≈ 2.5 h of waiting in real life (the harness's retry policy is milliseconds); the run waited ≈ 23.7 min on the AI that could not answer before anything moved (limit 5.0 min when another AI works) Note: Claude was tried 945× (a failed slot is put last only for FAIL_HOLD_S = 15 s, so each new call starts on the broken pane again; AutoInjector's own 3 send tries per prompt are not simulated). The simulated clock holds only Akọwe's 1–4 s provider retries. Measured: status done; 0 stop(s); time waited ≈ 23.7 min (simulated clock); 0 TIMEOUT / 0 LATE_EXPIRED / 0 late answer(s) used; answered in the end by ChatGPT. |

### Findings in R-10

**17. R-10-c ⚠️ — the bridge reports ChatGPT as broken once its capture stalls (the suggested AutoInjector signal)**

- **Where:** cross-side: AutoInjector's `capture-stalled` (3 min, “reply selector matches nothing”) is not reported to Akọwe; akowe/akowe/providers.py `SlotHealth` / `eligible` already skip a site whose /v1/health state is broken
- **What happens:** with the hook: 1 TIMEOUT instead of 14 and no stop — the remaining 15 min is the first timeout. The author sees: Simulated hook (AutoInjector does not do this today): after ChatGPT's first stalled reply, the bridge's /v1/health says ChatGPT is broken (REPLY_UNREADABLE). The run never stopped. ChatGPT timed out 1× in all (vs 14× in R-1-a); reviews answered by Gemini. (run status done → done; journal codes: VOICE_SET, AI_MOVED, AI_STOPPED, VOICES_DISTINCT, DOCTOR_SCORED, DOCTOR_DONE, PREDICT_PROBED, LEDGER_EMPTY, SCOPE_SET, GRID_EMPTY, TRADE_CARD_MADE, PROTAGONIST_OK, FIRST_PAGE_PICKED, ONE_REVIEWER, PLANNED_UNRESOLVED, PLANNED_MISSING, CHECKPOINT, ENDING_KEPT, VOICE_TEST_TOO_LITTLE, HUMAN_PASS, OPENING_UNRESOLVED, IMPROVE_UNRESOLVED, CLEAN_RUN_SCORE, BOOK_TOO_SHORT, QUALITY_TREND; log: 0 ERROR line(s), 0 traceback(s)).
- **How to reproduce:** `cd akowe && python -m tools.stress.run --section R --parts 10 --stress c` (ID R-10-c)
- **Likely cause:** today the stall stays inside AutoInjector and the request runs to its timeout
- **Suggested fix:** (simulated here) when the capture stalls, AutoInjector answers the pending request early (504 typed + late_expired, or 503 SITE_NOT_READY) and reports the site as broken / REPLY_UNREADABLE in /v1/health until a probe reads a reply again; Akọwe then routes around it (not implemented)
- **How likely:** likely in real use

**18. R-10-d ⚠️ — the log's night: ChatGPT cannot be read on ANY call; the author presses Try again on every stop**

- **Where:** see R-1 (assist `_call_ai_once`, providers `_generate_timeout_safe`)
- **What happens:** the log's night: ≈ 13 h of timeouts (38 TIMEOUTs), a stop while two AIs worked. The author sees: ChatGPT timed out on every call of every kind (Claude and Gemini fine). 38 TIMEOUTs (review ×8, checkpoint ×8, generic ×6, craft ×6, book_review ×4, plan_review ×2, ending ×2, originality ×2); 1 stop(s) for the author (TIMEOUT@canon); clean-run score 8.0/10. (run status paused → done; problem TIMEOUT; journal codes: VOICE_SET, TIMEOUT, VOICES_DISTINCT, WRITERS_ROOM, DOCTOR_AI_SKIPPED, DOCTOR_SCORED, DOCTOR_DONE, PREDICT_PROBED, LEDGER_EMPTY, SCOPE_SET, GRID_EMPTY, TRADE_CARD_MADE, PROTAGONIST_OK, FIRST_PAGE_PICKED, INSTRUCTIONS_CUT, SECOND_REVIEW_FAILED, PLANNED_UNRESOLVED, PLANNED_MISSING, CHECKPOINT_AI_SKIPPED, CHECKPOINT, ENDING_KEPT, VOICE_TEST_TOO_LITTLE, HUMAN_PASS, OPENING_UNRESOLVED, IMPROVE_UNRESOLVED, CLEAN_RUN_SCORE, BOOK_TOO_SHORT, QUALITY_TREND; log: 0 ERROR line(s), 0 traceback(s)).
- **How to reproduce:** `cd akowe && python -m tools.stress.run --section R --parts 10 --stress d` (ID R-10-d)
- **Likely cause:** every ChatGPT call of every kind waits the whole timeout + late window; checks that want every AI (checkpoints, book review, cross-check reviews) wait on it again in each chapter
- **Suggested fix:** the R-1 fix plus a long failed-slot hold after a TIMEOUT (not implemented)
- **How likely:** likely in real use

**19. R-10-e ⚠️ — the clean-run score after hours lost to a timed-out AI but no stop**

- **Where:** akowe/akowe/clean_run.py `COST` / `_counts` (line ~7–25)
- **What happens:** 10/10 “a clean run” after ≈ 2 h of timeouts and two checks skipped in every chapter. The author sees: The editor and the planned-to-page check timed out on ChatGPT in every chapter (≈ 2.0 h lost, both checks skipped), no stop: the clean-run score says 10.0/10 “a clean run”. (run status done → done; journal codes: VOICE_SET, VOICES_DISTINCT, DOCTOR_SCORED, DOCTOR_DONE, PREDICT_PROBED, LEDGER_EMPTY, SCOPE_SET, GRID_EMPTY, TRADE_CARD_MADE, PROTAGONIST_OK, FIRST_PAGE_PICKED, SECOND_REVIEW, EDITOR_FAILED, EDITOR_NOTES, PLANNED_UNRESOLVED, PLANNED_MISSING, CHECKPOINT, ENDING_KEPT, VOICE_TEST_TOO_LITTLE, HUMAN_PASS, OPENING_UNRESOLVED, IMPROVE_UNRESOLVED, CLEAN_RUN_SCORE, BOOK_TOO_SHORT, QUALITY_TREND; log: 0 ERROR line(s), 0 traceback(s)).
- **How to reproduce:** `cd akowe && python -m tools.stress.run --section R --parts 10 --stress e` (ID R-10-e)
- **Likely cause:** the score counts stops, fixes, repairs and waits; TIMEOUTs that moved on or were skipped, skipped checks (EDITOR_FAILED, PLANNED_CHECK_FAILED) and AI_MOVED cost nothing
- **Suggested fix:** count TIMEOUTs, failovers and skipped checks (e.g. 0.5 each) and show the time lost (not implemented)
- **How likely:** likely in real use

**20. R-10-f ⚠️ — crew members named by number (“Crewman Two”)**

- **Where:** no check: akowe/akowe/names.py / fresh_names.py / the canon checks never look at the form of a name
- **What happens:** “Crewman Two” reaches the finished book unflagged (the log: two crew members named by number). The author sees: A character the AI named “Crewman Two” is in the finished book 4×; no check flagged a name made of a role and a number. (run status done → done; journal codes: VOICE_SET, VOICES_DISTINCT, DOCTOR_SCORED, DOCTOR_DONE, PREDICT_PROBED, LEDGER_EMPTY, SCOPE_SET, GRID_EMPTY, TRADE_CARD_MADE, PROTAGONIST_OK, FIRST_PAGE_PICKED, ONE_REVIEWER, PLANNED_UNRESOLVED, PLANNED_MISSING, CHECKPOINT, ENDING_KEPT, VOICE_TEST_TOO_LITTLE, HUMAN_PASS, OPENING_UNRESOLVED, IMPROVE_UNRESOLVED, CLEAN_RUN_SCORE, BOOK_TOO_SHORT, QUALITY_TREND; log: 0 ERROR line(s), 0 traceback(s)).
- **How to reproduce:** `cd akowe && python -m tools.stress.run --section R --parts 10 --stress f` (ID R-10-f)
- **Likely cause:** a character named by a role and a number (“Crewman Two”) is accepted like any name
- **Suggested fix:** flag names made of a role word + a number word/digit in the canon check and ask the AI for a real name (fresh_names) (not implemented)
- **How likely:** unlikely but dangerous

**21. R-10-g ⚠️ — Claude's health reads ok but every send fails (SEND_NOT_CONFIRMED on each request)**

- **Where:** akowe/akowe/providers.py `_with_retries` (UPSTREAM_UNAVAILABLE without site_state is retried 3× with 1–4 s sleeps) and akowe/akowe/jobs.py `wait_and_retry` (DEFAULT_RETRY 15/30/60/120 s, max_total 600 s) for checks that want every AI
- **What happens:** a pane whose every send fails but whose health reads ok: 15 jobs wait on it (up to ≈ 2.5 h with the real retry policy). The author sees: AutoInjector's health said Claude was fine, but every prompt sent to Claude failed (SEND_NOT_CONFIRMED). Claude was tried 945× during the run; the run never stopped; chapters written by ChatGPT. 15 different jobs (checks that want every working AI: cross-check reviews, the editor, checkpoints, the book report …) sent to Claude and then WAITED for it (“Waiting for Claude (not reachable) — retrying”) because its health still read ok. (run status done → done; journal codes: AI_MOVED, VOICE_SET, VOICES_DISTINCT, DOCTOR_AI_SKIPPED, DOCTOR_SCORED, DOCTOR_DONE, PREDICT_PROBED, LEDGER_EMPTY, SCOPE_SET, GRID_EMPTY, TRADE_CARD_MADE, PROTAGONIST_OK, FIRST_PAGE_PICKED, SECOND_REVIEW_FAILED, PLANNED_UNRESOLVED, PLANNED_MISSING, CHECKPOINT_AI_SKIPPED, CHECKPOINT, ENDING_KEPT, VOICE_TEST_TOO_LITTLE, UPSTREAM_UNAVAILABLE, HUMAN_PASS, OPENING_UNRESOLVED, IMPROVE_UNRESOLVED, CLEAN_RUN_SCORE, BOOK_TOO_SHORT, QUALITY_TREND; log: 0 ERROR line(s), 0 traceback(s)).
- **How to reproduce:** `cd akowe && python -m tools.stress.run --section R --parts 10 --stress g` (ID R-10-g)
- **Likely cause:** the bridge's health says the pane is ok, so Claude stays a “working” AI; checker jobs that ask every working AI wait and retry on it
- **Suggested fix:** after N failed sends in a row mark the slot down (like site_state broken) until a probe succeeds; AutoInjector should report pane-broken in /v1/health (not implemented)
- **How likely:** likely in real use

## All findings in this section

Ordered by severity: would lose work > crash/hang > blocks the book needlessly > confusing message > cosmetic.

| # | ID | Result | Severity | How likely | One line |
|---|---|---|---|---|---|
| 1 | R-1-a | ⚠️ | blocks the book needlessly | likely in real use | review: 4 stops while Claude and Gemini worked, ≈ 4.8 h lost (the log's review ×4) |
| 2 | R-1-b | ⚠️ | blocks the book needlessly | likely in real use | scenes_check: 3 stops, ≈ 2 h lost (the log's scenes_check stop) |
| 3 | R-1-c | ⚠️ | blocks the book needlessly | likely in real use | editor: never stops but each chapter waits ≈ 41 min and then goes on WITHOUT the editor |
| 4 | R-1-d | ⚠️ | blocks the book needlessly | likely in real use | planned_check: ≈ 41 min per chapter, then skipped (PLANNED_CHECK_FAILED) |
| 5 | R-1-e | ⚠️ | blocks the book needlessly | likely in real use | writers' room: ≈ 41 min per room, ChatGPT's pitch/vote missing |
| 6 | R-1-f | ⚠️ | blocks the book needlessly | likely in real use | bible fill: ≈ 41 min on the same AI, then a batch left for later |
| 7 | R-1-g | ⚠️ | blocks the book needlessly | likely in real use | chapter writer: moves to another AI, but only after ≈ 11 min per chapter, every chapter |
| 17 | R-10-c | ⚠️ | blocks the book needlessly | likely in real use | with the hook: 1 TIMEOUT instead of 14 and no stop — the remaining 15 min is the first timeout |
| 18 | R-10-d | ⚠️ | blocks the book needlessly | likely in real use | the log's night: ≈ 13 h of timeouts (38 TIMEOUTs), a stop while two AIs worked |
| 21 | R-10-g | ⚠️ | blocks the book needlessly | likely in real use | a pane whose every send fails but whose health reads ok: 15 jobs wait on it (up to ≈ 2.5 h with the real retry policy) |
| 8 | R-2-b | ⚠️ | blocks the book needlessly | likely in real use | a late answer after LATE_EXPIRED is thrown away and the same AI is asked again: ≈ 21 min |
| 9 | R-4-a | ⚠️ | blocks the book needlessly | likely in real use | a TIMEOUT stop at night waits for the author indefinitely (5 h in the log) while two AIs work |
| 10 | R-4-b | ⚠️ | blocks the book needlessly | likely in real use | with 🗳 on, the vote fails (VOTE_MISSING) because the broken AI must vote too |
| 11 | R-4-c | ⚠️ | blocks the book needlessly | unlikely but dangerous | the AIs agree on “another AI”, but the review goes to the broken AI again and the run stops again |
| 19 | R-10-e | ⚠️ | confusing message | likely in real use | 10/10 “a clean run” after ≈ 2 h of timeouts and two checks skipped in every chapter |
| 15 | R-8-a | ⚠️ | confusing message | likely in real use | the editor's notes describe v1–v2, the final chapters are v3–v4 |
| 20 | R-10-f | ⚠️ | cosmetic | unlikely but dangerous | “Crewman Two” reaches the finished book unflagged (the log: two crew members named by number) |
| 12 | R-5-a | ⚠️ | cosmetic | likely in real use | “Unknown author” on the title page, metadata and DOCX running heads when no pen name was typed |
| 13 | R-6-a | ⚠️ | cosmetic | likely in real use | a long sentence repeated word for word in chapters 1 and 3 stays in the book |
| 14 | R-7-c | ⚠️ | cosmetic | likely in real use | all cuts refused (NOT_FOUND) for a ’ vs ' difference: 0 cuts kept, the book stays over its target |
| 16 | R-9-a | ⚠️ | cosmetic | likely in real use | planned details stay off the page after one failed fix round (listed as PLANNED_MISSING) |

