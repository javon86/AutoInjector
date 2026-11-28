# Section R-D — the desktop side of the real "What the Ice Kept" run: stress results

Round 2 of the stress test. These scenarios rebuild, on the AutoInjector desktop side, what went wrong in the real 3-chapter run of 2026-11-27 (build b4a0402): ChatGPT's replies that could not be read, the learned reply selector that flip-flopped, Claude's pane that could not send for ~6 hours, fresh chats that did not happen, and the author's own use of the panes. Nothing in the product was changed; this is a list of findings for the author to decide on. No book text appears anywhere in the test or here.

**Legend (round 2, stricter):** ✅ HANDLED — nothing lost and no needless waiting · 🟡 SAFE STOP — stopped only because no other AI could have answered · ⚠️ a stop or a wait > 5 min of the run's clock that another working AI could have avoided, or a problem the run knew about early and waited out anyway, or a cosmetic defect · ❌ work lost, a wrong answer used, a hang, or a run that never finishes.

**How it was run.** `desktop-app/test/stress-realrun.test.js` (not in `npm run test:unit`):

```
cd desktop-app && npm ci --ignore-scripts
NODE_PATH=$PWD/node_modules:/opt/node-tools/node_modules TMPDIR=/dev/shm node test/stress-realrun.test.js
# one group: RD_ONLY=1 (or 2,3,4,5,6); JSON results: RD_RESULTS=/path/results.json; a pane's event log: RD_DEBUG=chatgpt
```

- **Real code:** `akowe-bridge.js` (HTTP on 127.0.0.1), `pane-health.js`, `self-repair.js` (its page scripts run on `test/fake-dom.js` pages), `relay-trace.js`, `fresh-chat.js` (its page scripts too), `run-guard.js` (the notifier) and the **real reply reader** (`automation.js buildReadScript`) on fake ChatGPT / Claude / Gemini pages.
- **Simulated:** main.js's glue between them (sendTextTo, the poll loop, `healthTick`, `selfRepairBusy`, `selfRepairMakeWay`, `akoweFreshChatIfDue` / `startFreshChatNow`), copied rule by rule from main.js; and Akọwe's side from `akowe/akowe/providers.py` `submit()` / `_complete()` (timeout_ms = deadline − 5 s; a typed 504 is followed by one more request with the same request_id, which joins the late window). RD-2-b…d also copy main.js's retire rule (3 fragment / ignored reads in a row, never within an hour of learning).
- **The real main.js:** RD-2-a runs the real main.js under mock Electron in a child process (`test/stress-realrun-main-child.js`), with the real read / check-in / page-search scripts on a fake ChatGPT page.
- **Clock:** a virtual clock for every module, every timer scaled (the bridge's `timeScale`, self-repair's sleep, the poll loops); 6 hours of the run take ~11 s. **All times below are minutes of the real run.** Two full runs gave the same grades (39/39 checks pass, ~1.5 min wall time).

## Summary

| ID | Scenario | Result | What happened | Time waited (run min) |
|---|---|---|---|---|
| RD-1-a | ChatGPT's reply is on the page, the reply selector matches nothing — first try | ⚠️ | capture-stalled at 3.3 min, request still ran TIMEOUT 895 s → LATE_EXPIRED 1195 s; health kept ChatGPT ready | 20.1 (16.8 after the stall was known) |
| RD-1-b | …Akọwe retries at once (-c1-) — to ChatGPT again | ⚠️ | retry 504 at 5.0 / 9.9 min; the queued check-in never ran between the tries | 29.9 for one request |
| RD-1-c | …with a SIMULATED hand-back at the stall | ✅ | 504 at 3.1 min, reader re-learned at 4.9 min, retry answered | 7.2 in all |
| RD-1-d | …and page search cannot learn the reader | ⚠️ | two 504s while health said ready; only then "broken" and 503 at once | 29.8 |
| RD-2-a | REAL main.js: learned reader reads a fragment → retired → nothing → re-learned (same) → retired… | ⚠️ | flip-flop reproduced; "the built-in one works" — it matches nothing | – |
| RD-2-b | …while Akọwe asks ChatGPT every ~6 min | ⚠️ | retired 20 → learned 58 → retired 127 → learned 165; 4 timeouts | 59.7 in 3.3 h |
| RD-2-c | …every ~2 min | ⚠️ | retired 12 → learned 46; 4 timeouts | 29.9 in 1.7 h |
| RD-2-d | …back to back (30 s apart) | ⚠️ | retired at 9 min, never re-learned; 12 of 15 requests failed | 358.6 in 6.2 h |
| RD-3-a | Claude: SEND_NOT_CONFIRMED ×3, the reload does not fix it — Akọwe's requests | 🟡 | 502 SEND_FAILED (1.9 min), 409 for a second call, "broken" 5 min later, then 503 at once; Gemini answered | 3.6 |
| RD-3-b | …6 h with Claude broken while the others work: alerts, re-checks | ⚠️ | "Claude needs you" 12× in 6 h; 7 re-checks, 13 failed sends | – |
| RD-4-a | ChatGPT's "New chat" does not give an empty chat | ✅ | each fresh chat fell back to the new-chat address (reload by fresh-chat) | – |
| RD-4-b | …while the reply selector matches nothing | ⚠️ | the empty-chat check is fooled: the old chat taken as fresh | – |
| RD-4-c | an unread reply keeps the pane "waiting": fresh chat held, chat grows | ⚠️ | held "busy"; 319k → 358k → 398k characters | 49.8 |
| RD-5-a | the author chats in the pane: a due fresh chat is held for them | ✅ | held "user", all answered | 0 |
| RD-5-b | the author asks their own question while Akọwe's prompt waits | ❌ | the author's chat answer was handed to Akọwe as its reply; the real answer went nowhere | 1.4 |
| RD-6-a | the author presses 🩺 on the stalled ChatGPT while Akọwe waits | ⚠️ | skipped ("akowe") | 16.8 |
| RD-6-b | ChatGPT's page keeps saying it is writing (Stop button stuck) | ⚠️ | no stall for 12 min, request ran 19.9 min | 19.9 |
| RD-6-c | a stopped run waits ~5 h for the author | ⚠️ | notified 11× in 5 h; nothing on the desktop side can resume | 300 |
| **all** | **18 scenarios** | **✅ 3 · 🟡 1 · ⚠️ 13 · ❌ 1** | | |

## RD-1 — the AI answered, the reply selector matches nothing (capture-stalled)

**Set-up:** ChatGPT's page uses markup none of `selectors.js` or self-repair's `ALT_SELECTORS` know (`div.convo-turn[data-turn-role="model"]`). ChatGPT answers after 1.5 min and finishes writing at 2 min. Akọwe asks with a 900 s deadline, then retries with 300 s.

| ID | Stress | Result | What happened |
|---|---|---|---|
| RD-1-a | first try (deadline 900 s) | ⚠️ | capture-stalled at 3.3 min (textLen 0, generating false), yet the request ran to its deadline and the late window: TIMEOUT at 895 s, LATE_EXPIRED at 1195 s → 504 late_expired after 20.1 min. Nothing ends or hands back the request at the stall. The stall only queues a check-in, and that check-in cannot run while the request (and its late window) is open (self-repair busy reason "akowe"). /v1/health keeps ChatGPT ready=true (state unknown), so nothing tells Akọwe to use another AI. |
| RD-1-b | Akọwe retries at once (-c1-, deadline 300 s), to ChatGPT again | ⚠️ | The retry also timed out: 504 at 5.0 min, then 504 at 9.9 min (the log had TIMEOUT ~295 s, LATE_EXPIRED ~590 s). The check-in queued at 3.3 min never repaired anything between the tries, because Akọwe's retry took the site first. It ran only when nothing asked for ChatGPT any more: the page search re-learned the reader at 31.8 min. Both answers were on the page; 29.9 min lost for one request. |
| RD-1-c | the same with a **simulated** hand-back at the stall (`bridge.release(site)` called on capture-stalled; the product has no such hook) | ✅ | Akọwe got 504 at 3.1 min, the check-in ran at once and re-learned the reader at 4.9 min, and the retry was answered after 2.1 min: 7.2 min in all instead of ~30. Akọwe could also have moved to another AI at the 504. |
| RD-1-d | page search cannot learn the reader either (every reply flat in one container) | ⚠️ | c0: 504 after 19.9 min; c1: 504 after 9.8 min, both while health said ready=true. Only then did the check-in run (alternatives → page search → reload, all failed) and mark ChatGPT "broken" (NO_REPLY_FOUND) at 33.2 min, with ONE notice for the user. From then on /v1/health says ready=false and a request gets 503 SITE_NOT_READY at once, which is good — but ~30 min went first. |

## RD-2 — a learned reply selector that reads only a fragment: stale ×3 → retired → matches nothing (flip-flop)

**Set-up:** ChatGPT's page has a turn per message, and a long reply is split into one `div.prose-block` per paragraph. A check-in answer is a single block, so the page search learns `div.prose-block`. On a long reply that selector matches only one block; the reader's own fix ("climb") still reads the whole reply.

| ID | Stress | Result | What happened |
|---|---|---|---|
| RD-2-a | the REAL main.js (child process), user messages | ⚠️ | The learned `div.prose-block` (page-search) reads every split reply only through the reader's climb fix. main.js counts that as a failure (`reply-selector-fragment`), and after 3 replies it is retired with "the built-in one works" — it does not, it matches nothing. The next reply is unreadable (capture-stalled "matches nothing"), and the stall's check-in re-learns **the same** selector by page search. An hour later it is retired again (cycle 2: after 2 reads). The lost user reply was re-sent by the carry-on follow-up; an Akọwe request gets no such help (RD-2-b). |
| RD-2-b | Akọwe asks ChatGPT every ~6 min (Gemini / Claude in between) | ⚠️ | 16 requests in 3.3 h: retired 20 → learned 58 → retired 127 → learned 165 (min). 4 tries timed out (2 requests failed both tries): 59.7 min lost, ~30 min per cycle. |
| RD-2-c | every ~2 min | ⚠️ | retired 12 → learned 46; 4 tries timed out, 29.9 min lost in 1.7 h. |
| RD-2-d | back to back (30 s apart) | ⚠️ | Retired at 9 min and never re-learned. The check-in queued by every stall started in the short gaps but made way for Akọwe's next request 11× (selfRepairMakeWay). 12 of 15 requests failed both tries: 358.6 min lost in 6.2 h. The reader stays dead as long as Akọwe keeps ChatGPT busy. |

The real log (learned → stale-seen ×3 → retired → nothing, several times a day; 16 TIMEOUTs ≈ 159 min) sits between RD-2-b and RD-2-d.

## RD-3 — a send that is never confirmed, and a reload that does not fix it

**Set-up:** every send to Claude ends SEND_NOT_CONFIRMED after 3 tries (15 s each), and the self-repair reload does not help. Gemini and ChatGPT work. run-guard's notifier is fed the panes' health every 15 s while a run is writing.

| ID | Stress | Result | What happened |
|---|---|---|---|
| RD-3-a | Akọwe's requests to Claude | 🟡 | 1st request: 502 SEND_FAILED after 1.9 min. A 2nd call meanwhile: 409 SITE_BUSY (never queued, never handed on). A retry 20 s later: 502 SEND_FAILED after 1.7 min. Claude was marked "broken" (SEND_NOT_CONFIRMED) 5.0 min after the failure (alternatives, 1 reload, no automatic teach). From then on Akọwe gets 503 at once (state broken) and Gemini answered. The bridge never hands a request to another AI itself — that is Akọwe's job (502/503 say ambiguous:false). On the desktop side this is a clean stop for Claude alone. |
| RD-3-b | 6 hours with Claude broken while Gemini and ChatGPT work | ⚠️ | The author was notified "Claude needs you" **12 times in 6 h** (once, then every 30 min: notification + taskbar flash + sound), although the book did not need Claude. Self-repair re-checked 7 times (at 12, 27, 87, 147, 207, 267 and 328 min: after 5, 15, then every 60 min). Each re-check types a check-in that fails 3 tries: 13 SEND_NOT_CONFIRMED in all. Nothing changes the state until the author acts. |

## RD-4 — "New chat" does not give an empty chat; the chat grows past ~340 000 characters

| ID | Stress | Result | What happened |
|---|---|---|---|
| RD-4-a | ChatGPT's New chat button does nothing (fresh chat every 3 requests) | ✅ | Each fresh chat clicked New chat, waited 2.5 s, saw the old replies still there and opened the new-chat address instead ("reload by fresh-chat"). Every request went into an empty chat and was answered. Cost: one page reload (+2.5 s) per fresh chat. |
| RD-4-b | …while the reply selector matches nothing | ⚠️ | New chat did nothing, but the check "0 replies + a message box" passed: its reply selectors are the same ones that match nothing, so they found 0 replies. It was logged as a fresh chat (how=button), the counters were reset, and the prompt went into the OLD chat. The chat keeps growing while AutoInjector believes it is fresh. |
| RD-4-c | ChatGPT's chat already ~280k characters, replies unreadable, Akọwe prompts of ~30k | ⚠️ | From the 2nd try on the fresh chat was due (chars, 310k). But `freshChatBusy()` counts `state.waiting`, which stays true while no reply is captured, so the fresh chat was held "busy" (logged once: akowe-fresh-chat-held). Every new prompt went into the same chat: 319k → 358k → 398k characters in 49.8 min. A fresh chat (a new page) might even have fixed the reading. |

## RD-5 — the author uses the pane by hand while Akọwe waits

| ID | Stress | Result | What happened |
|---|---|---|---|
| RD-5-a | the author typed in ChatGPT's pane a minute before each of 6 requests; a fresh chat is due every 2 | ✅ | The fresh chat was held "user" (logged once), so Akọwe's prompts went into the author's chat and were all answered. The fresh chat waits until the author has left the pane alone for 10 min (a chat the site says is full would still be swapped). This is by design and loses no time; the chat grows meanwhile. |
| RD-5-b | the author asks ChatGPT their own question while Akọwe's prompt waits; ChatGPT answers it first, in the conversation's [TO:]/[FROM:] format | ❌ | The Relay Trace has only Akọwe's [MSG #] open, so the bridge took **the author's chat answer as Akọwe's reply** (200 after 1.4 min, same seq). The real answer came at 7.1 min and was treated as an ordinary relay reply, lost to Akọwe. Akọwe's JSON check would most likely refuse the text and ask again (a wasted try), but a reply that happens to fit is used. |

## RD-6 — out of the box (suggested by the log)

| ID | Stress | Result | What happened |
|---|---|---|---|
| RD-6-a | the author presses 🩺 Check on the stalled ChatGPT while Akọwe waits | ⚠️ | Skipped ("akowe"): even the author cannot start the repair while an Akọwe request (or its late window) is open. The request still ran 19.9 min (🩺 pressed at 3.1 min). |
| RD-6-b | ChatGPT's page keeps saying it is writing (Stop button stuck for 40 min) | ⚠️ | Pane health calls it "still writing" for 4× the stall time (12 min) before it counts as a stall (logged at 12.1 min). The request ran 19.9 min to 504. The "unfreeze" repair (press Stop) cannot run while the request is open. Another AI could have answered meanwhile. |
| RD-6-c | a run stopped on TIMEOUT (alert category ai) waits ~5 h for the author | ⚠️ | run-guard notifies 11× in 5 h (once, then every 30 min). The stop itself is Akọwe's (another section). On the desktop side nothing can resume it, and the AIs that work sit idle meanwhile. |

## All findings in this section

Ordered by severity: would lose work > crash/hang > blocks the book needlessly > confusing message > cosmetic.

| # | ID | Result | Severity | How likely | One line |
|---|---|---|---|---|---|
| 1 | RD-5-b | ❌ | wrong answer used / work lost | likely in real use | A reply to the author's own question in the pane is handed to Akọwe as its answer |
| 2 | RD-1-a/b, RD-6-a | ⚠️ | blocks the book needlessly | seen in the real run | A capture stall known at 3 min is waited out for 20 + 10 min; the repair cannot run, health says "ready" |
| 3 | RD-2-a…d | ⚠️ | blocks the book needlessly | seen in the real run | A working (fragment) reader is retired as "out of date", leaving nothing; the same selector is re-learned and retired again |
| 4 | RD-2-d, RD-1-b | ⚠️ | blocks the book needlessly | likely in real use | The stall's check-in is starved: it makes way for every Akọwe request, so busy ChatGPT never gets repaired |
| 5 | RD-4-c | ⚠️ | blocks the book needlessly | seen in the real run | An unread reply leaves the pane "waiting", so the fresh chat is held "busy" forever and the chat grows past 340k |
| 6 | RD-4-b | ⚠️ | confusing / silent | likely in real use | The empty-chat check uses the same broken reply selectors and takes the old chat for a fresh one |
| 7 | RD-6-b | ⚠️ | blocks the book needlessly | unlikely but dangerous | A stuck "writing" page is no stall for 12 min and the request runs 20 min |
| 8 | RD-3-b, RD-6-c | ⚠️ | confusing message (noise) | seen in the real run | Re-alerts every 30 min for hours: about a pane the book does not need, and for a stop nothing on the desktop can resume |

**1. RD-5-b ❌ — the author's own question and its answer become Akọwe's reply**

- **Where:** desktop-app/main.js capture path (`if (akoweBridge) {` ~line 4978: `owned = akoweBridge.onCaptured({ ...turn, answers })`); relay-trace.js `noteCapture` / `openFor` (a reply answers every open message); akowe-bridge.js `onCaptured`.
- **What happens:** While Akọwe's prompt waits, the author types a question into the pane by hand and the AI answers it first in the [TO:]/[FROM:] format it has been using. The Relay Trace knows only Akọwe's [MSG #], so that reply "answers" it and the bridge returns it to Akọwe (200, the same seq). The real answer arrives later and goes to the normal relay, lost to Akọwe.
- **How to reproduce:** `RD_ONLY=5 node test/stress-realrun.test.js` (RD-5-b).
- **Likely cause:** The author's own typing (`lastUserInputAt`, Electron before-input-event) is used for check-ins, fresh chats and follow-ups, but not for reply ownership. A message typed by hand has no [MSG #] and never enters the Relay Trace.
- **Suggested fix (NOT implemented):** When the user gave input to a pane after a bridge prompt was typed (`lastUserInputAt[site] > typedAt`), do not hand the next reply to Akọwe. Hold it as the user's, keep waiting for the reply that comes after it, or answer 409/503 "the author used this pane" so Akọwe asks another AI. Optionally count the user's own message rows (the send script's `userTurns()`) as an open message in the Relay Trace.
- **How likely:** likely in real use (the author watches the panes during a 10-hour run).

**2. RD-1-a / RD-1-b / RD-6-a ⚠️ — a capture stall known at 3 minutes is waited out for 20 + 10 minutes**

- **Where:** desktop-app/main.js `healthTick` (~line 1254: capture-stalled only logs and calls `selfRepair.requestCheck(site, "stalled")`); `selfRepairBusy` (~line 9552, lines 9560-9561: `"akowe"` while a bridge request or its late window is open); akowe-bridge.js `expire` (~line 588, late window = min(timeout, 5 min)) and `siteStatus` (~line 753: `ready` ignores pane health); pane-health.js (stall after 3 min).
- **What happens:** At 3.3 min pane health knows the reply is on the page and the reader sees nothing ("the reply selector matches nothing", textLen 0, generating false). The request still runs to TIMEOUT (895 s) and LATE_EXPIRED (1195 s). The queued repair cannot run during that time (even 🩺 is skipped "akowe"), and /v1/health says ChatGPT is ready. Akọwe's retry goes to ChatGPT again and loses another ~10 min. One request costs ~30 min; the log shows 16 TIMEOUTs ≈ 159 min.
- **How to reproduce:** `RD_ONLY=1 node test/stress-realrun.test.js` (RD-1-a/b/d), `RD_ONLY=6` (RD-6-a).
- **Likely cause:** Nothing connects the pane-health stall to the bridge. The bridge answers only on a capture, a send failure or its own timers. The self-repair "busy" rule protects an open Akọwe request even when that request is known to be stuck on an unreadable reply.
- **Suggested fix (NOT implemented):** On capture-stalled with reason "matches nothing" (or "only sees the start") for a site with a typed bridge request, end it early: `bridge.release(site, "stalled")` → 504 late_expired with a new `reason: "unreadable"` / `capture_stalled: true`, so Akọwe moves to another AI at once. Let the stall's check-in run right after, without waiting for the late window. Put the pane-health state into `/v1/health` (e.g. `state: "repairing"`, `problem: "NO_REPLY_FOUND"`, or `ready: false` while stalled), so Akọwe's retry does not pick the same AI. RD-1-c (simulated) shows ~7 min instead of ~30.
- **How likely:** seen in the real run.

**3. RD-2-a…d ⚠️ — a reader that works through the fragment fix is retired as "out of date", leaving nothing; then it is re-learned and retired again**

- **Where:** desktop-app/main.js `markCaptured` (~line 1158-1163: `noteSavedSelectorOutcome(site, "assistant", rf.ignored || rf.fragment, …)`), `lastReadFlags` (~line 4553: `fragment: !!res.fragmentFixed && savedReader`), `noteSavedSelectorOutcome` (~line 1792), `retireSavedSelector` (~line 1860: "the built-in one works"); self-repair.js `learnReplyFrom` / `validateBlocks` (~lines 348-412: the learned block selector passes because a split reply's blocks count as several "replies").
- **What happens:** The page search learns `div.prose-block` from a one-block check-in answer. Every long reply is read correctly through the reader's climb fix, yet each one counts as a failure of the saved selector. After 3 (and > 1 h after learning) it is retired with "the built-in one works", but the built-in selectors match nothing. The next request is unreadable (RD-1: ~20 + ~10 min). The check-in then learns the same selector again, and an hour later the cycle repeats.
- **How to reproduce:** `RD_ONLY=2 node test/stress-realrun.test.js` (RD-2-a is the real main.js).
- **Likely cause:** "Fragment" is treated like "ignored": the retire rule assumes the built-in reader produced the reply, but with a fragment fix the saved selector did (with help). Retirement never checks that the built-in reader reads anything on this page, and the page search does not remember that it learned the very selector that was just retired.
- **Suggested fix (NOT implemented):** Count `fragmentFixed` reads with a saved selector as "works" (or promote the climbed container instead of retiring). Retire only when the built-in reader really read that reply (`res.text` came from the built-ins: an `overrideIgnored` with text). Before retiring, run a read with only the built-ins and keep the saved one if they find nothing. In the page search, prefer the turn container over a block when a split reply is on the page, and never re-learn a selector retired in the last few hours without saying so.
- **How likely:** seen in the real run ("several times a day").

**4. RD-2-d / RD-1-b ⚠️ — the stall's check-in is starved by Akọwe's next request**

- **Where:** desktop-app/main.js `selfRepairMakeWay` (~line 9585) and the bridge's `sendToSite` (check-ins make way for Akọwe); self-repair.js `makeWay` / `probeOnce` (`yieldReq` → displaced).
- **What happens:** After the late window ends, the queued check-in starts in the few seconds before Akọwe's next request. That request withdraws it or waits for it to settle, and the check-in ends "displaced" without a repair. With ChatGPT asked back to back, its reader was never re-learned: 12 of 15 requests failed in 6.2 h.
- **How to reproduce:** `RD_ONLY=2` (RD-2-d), `RD_ONLY=1` (RD-1-b).
- **Likely cause:** Making way is right for a healthy AI, but a check-in for a known-broken reader (stall reason "matches nothing") should win over the next prompt, which will fail the same way.
- **Suggested fix (NOT implemented):** A check-in started for a stall or an Akọwe TIMEOUT/LATE_EXPIRED should not yield to Akọwe. Answer the bridge request 503 SITE_NOT_READY (`state: "repairing"`) while it runs, so Akọwe uses another AI for that minute.
- **How likely:** likely in real use (ChatGPT is asked often).

**5. RD-4-c ⚠️ — an unread reply leaves the pane "waiting", so the fresh chat is held "busy" and the chat grows past 340 000 characters**

- **Where:** desktop-app/main.js `freshChatBusy` (~line 9835: `state.waiting[site]`), `akoweFreshChatIfDue`; `state.waiting` is set by every send (~line 2366) and cleared only by a capture.
- **What happens:** The fresh chat is due by size, but it is held "busy" (logged once) because the last reply was never captured. Every new Akọwe prompt is typed into the same chat: 319k → 358k → 398k characters. That matches the log's `akowe-fresh-chat-held` at ~340k.
- **How to reproduce:** `RD_ONLY=4` (RD-4-c).
- **Likely cause:** `state.waiting` means "a reply is owed" and never expires. Between Akọwe requests it is stale once the bridge request ended (LATE_EXPIRED).
- **Suggested fix (NOT implemented):** In `freshChatBusy` use the same time limit as `selfRepairBusy` (`waitingSince` older than CHECKIN_OWED_MS counts as not busy), or ignore `state.waiting` when the owed message was a bridge prompt that already ended. Consider a fresh chat as one of the repairs for "reply unreadable".
- **How likely:** seen in the real run.

**6. RD-4-b ⚠️ — the empty-chat check is fooled when the reply selectors match nothing**

- **Where:** desktop-app/main.js `startFreshChatNow` (~line 9857: `chk.replies === 0 && chk.input` → "button"); fresh-chat.js `buildFreshCheckScript`.
- **What happens:** New chat did nothing, but the check counts replies with the same selectors that cannot see any. "0 replies" passes, the counters reset, and the prompt goes into the old chat, which keeps growing unseen.
- **How to reproduce:** `RD_ONLY=4` (RD-4-b).
- **Likely cause:** Emptiness is proven by the absence of matches, not by a change.
- **Suggested fix (NOT implemented):** Also require a positive sign: the URL changed to the site's new-chat address, or the page's user-message rows / [MSG #] markers are gone. Otherwise fall back to the address.
- **How likely:** likely in real use whenever RD-1 / RD-2 happens.

**7. RD-6-b ⚠️ — a page stuck on "writing" is no stall for 12 minutes**

- **Where:** desktop-app/pane-health.js `evaluate` (generating → "Still writing" until 4 × stallMs); self-repair STUCK_GENERATING ("unfreeze") is blocked by `selfRepairBusy` "busy" / "akowe".
- **What happens:** The request runs 19.9 min to 504. The stall is logged only at 12 min, and nothing presses Stop.
- **How to reproduce:** `RD_ONLY=6` (RD-6-b).
- **Likely cause:** A long chapter can take many minutes to write, so the 4× grace is deliberate. Nothing checks whether the text is still changing (self-repair has `stillWriting` for check-ins, pane health has not).
- **Suggested fix (NOT implemented):** In pane health, treat "generating" as a stall once the reply text has not changed for ~2 min (self-repair's stallMs idea), and let that end the bridge request early as in finding 2.
- **How likely:** unlikely but dangerous.

**8. RD-3-b / RD-6-c ⚠️ — re-alerts every 30 minutes for hours**

- **Where:** desktop-app/run-guard.js `createNotifier` (renotifyMs 30 min) and `conditionsFrom` (a broken pane counts while a run is going, even when other AIs carry the book); self-repair.js `brokenBackoffMs` (5 / 15 / 60 min re-checks).
- **What happens:** "Claude needs you" was shown 12× in 6 h (notification, taskbar flash, sound) while Gemini and ChatGPT wrote the book. Every hourly re-check types into the broken pane and fails 3 tries. A stopped run was re-announced 11× in 5 h, and nothing on the desktop side can resume it.
- **How to reproduce:** `RD_ONLY=3` (RD-3-b), `RD_ONLY=6` (RD-6-c).
- **Likely cause:** One repeat rule for everything; a pane problem is "needs you" even when the run does not need that pane.
- **Suggested fix (NOT implemented):** For a pane problem while other AIs work, tell the author once (and in the panel), then repeat only if it becomes the last working AI. Back the reminder off (30 min → 2 h → 6 h). For a stopped run, keep the 30-min reminder but say what would let it go on ("Gemini and Claude are working — press 🔁 Try again").
- **How likely:** seen in the real run.

## Not testable here, and why

- **Which AI Akọwe picks next, and whether a TIMEOUT stops the whole book** — Akọwe's registry and run logic (Python, another agent's section). Here Akọwe's retry policy was copied from providers.py, and the desktop side was checked for what it tells Akọwe (`/v1/health`, 502/503/504 bodies).
- **The finished book's defects** (Unknown author, repeated sentence, 121 % length, the editor reading version 7) — Akọwe side; nothing on the desktop side touches the text.
- **The real ChatGPT / Claude pages** — fake pages stand in for them. The send script itself (typing, the Enter fallback, the real SEND_NOT_CONFIRMED) is not run: the host returns its outcome, as main.js's tests do.
- **main.js's glue under the virtual clock** — main.js uses Date.now and real timers, so RD-1 / RD-3 / RD-4 / RD-5 / RD-6 use a host copied from it (line numbers above). RD-2-a checks the most intricate part (the retire rule, the capture path, the check-in) in the real main.js.
