---
name: autoinjector-relay-debug
description: Trace an AutoInjector message from send through capture to hand-off between ChatGPT, Claude, Gemini, the Butler and the Terminal, and find where it stopped, doubled or looped. Use for duplicate deliveries, messages that never arrived or never got answered, AIs stuck in a loop, [TO:]/[FROM:] tag problems, [TO: USER] replies being forwarded, hop-limit pauses, Stop/Resume not working, or any Relay Trace / Bucket Brigade report.
---

# AutoInjector relay debugging

All paths are relative to `desktop-app/`. The relay is in `main.js`; the rules it follows are in
small pure modules that are unit-tested on their own.

## The path one message takes

```
sendTextTo(target, text, fromSite)        main.js  - queued per target (withSendQueue),
  │  adds "[MSG #n]" header                          waits for a pending capture first (waitForPendingCapture, TR-28)
  ▼
buildSendScript → page                    automation.js - typed, sent, arrival proven by [MSG #n] / new user turn
  ▼
pollSite(site) every POLL_MS              main.js  - buildReadScript; `generating` blocks capture while streaming
  │  cleanReplyText → completion gate: reply is done when it ends with [FROM: X] (envelope.js)
  │  missing end tag → missingEndTagReprompt / untagged-reply-accepted
  ▼
captured turn
  │  parseRoundtableTag: [TO: GEMINI|CHATGPT|CLAUDE|BUTLER|TERMINAL|ALL|USER|NONE]  (envelope.js)
  │  no tag → USER (Rule 1)
  ▼
routing
  ├─ tag relay      handleRoundtableCapture → roundtableTargetsFor
  ├─ Auto mesh      meshTargetsFor (relay-policy.js) - never forwards an explicit [TO: USER] (TR-05)
  ├─ House Rules    handleHouseRuleCapture / debate / rotation / blind round … (own rules)
  ├─ Butler         deliverToButler
  └─ Terminal       deliverToTerminal (ai-lockers.js gate)
  guards: hop counter createHopCounter (TR-06, default 30), loopSuppressRelay (short repeated bodies),
          relayTrace duplicate detection (same body hash, same target, 2-minute window)
```

## Rule modules (change rules here, not inline in main.js)

| File | Owns |
|---|---|
| `envelope.js` | `[TO:]` / `[FROM:]` parsing, tolerant matching, stripping. |
| `relay-policy.js` | `meshTargetsFor`, `createHopCounter`, `DEFAULT_MAX_AUTO_HOPS`. |
| `relay-trace.js` | TR-13 stage tracking per `[MSG #n]`: typed → proven → started → answered → handed on / held (and why). Records only. |
| `pane-health.js` | One honest status light per pane: idle / ok / waiting / warn / stalled / error. |
| `bucket-brigade.js` | TR-14 scored live relay run; blames APP vs AI per hop. |
| `prompt-sequence.js`, House Rules handlers in `main.js` | Ordered / staged runs. |

## Step 1 - Get the trace, then read it

Ask for or locate, in this order:
1. The **Relay Trace** report (saved by `saveRelayTraceReport()`). It already says, per AI, how many messages reached each stage and where the rest stopped. Start there.
2. `autoinjector-debug.log` (userData folder). Relevant `logEvent` kinds: `sent`, `send-retry`, `send-waiting-capture`, `send-waiting-busy`, `send-capture-wait-timeout`, `captured`, `capture-stalled`, `endtag-missing`, `endtag-missing-giveup`, `totag-missing`, `untagged-reply-accepted`, `mesh-skip-to-user`, `roundtable-skip`, `roundtable-skip-repeat`, `loop-suppressed`, `hop-limit`, `hop-count-reset`, `relay-silenced`, `relay-error`, `stopped`, `paused`, `sequence-stale-capture-ignored`, `to-butler`, `terminal-request*`.
3. A Bucket Brigade report if the user ran one - it separates APP faults from AI faults.

Follow ONE `[MSG #n]` end to end before generalising. Write down the last stage it provably reached.

## Step 2 - Classify the fault

| What the trace shows | Likely cause | Where |
|---|---|---|
| Same body, same target, twice (`duplicateOf`) | Retry after a send that actually landed, or the tag sent as a separate operation | `sendTextTo` retry path, send proof in `automation.js` |
| typed but never proven | Send didn't land | use `autoinjector-pane-repair` |
| proven, never answered, AI idle | Reply never captured: end tag missing, wrong reader, `generating` stuck | `pollSite`, `envelope.js`, pane-repair |
| Answer captured from an earlier round | Stale capture | `waitForPendingCapture`, `hasUncapturedReply`, `markCaptured` |
| `[TO: USER]` forwarded to another AI | Mesh rule bypassed | `meshTargetsFor` / caller passing `stageActive` |
| Endless short ping-pong | Loop guard thresholds | `loopSuppressRelay` (`AUTOINJECTOR_LOOP_*` env) |
| Relay stops at N hops | Hop limit working as designed - confirm `hops`/`max` | `createHopCounter`, `resetAutoHops` |
| Stop / Resume ignored | Handler doesn't check stop state | `silenceAllRelay`, `stopCouncil`, `carryOnBlocked`, House Rules stop/pause |

## Step 3 - Reproduce, then fix

1. Rules bug → failing case in the module's own unit test (`test/relay-policy.test.js`, `test/envelope.test.js`, `test/relay-trace.test.js`, `test/pane-health.test.js`). These are fast and pure.
2. Orchestration bug in `main.js` → failing case in `test/run.js` (real `main.js` under `test/mock-electron.js`, fast clock via `AUTOINJECTOR_POLL_MS` etc.).
3. Timing / real-DOM interaction → `test/stress.test.js` (real `main.js` + real scripts in Chromium against `test/fixtures/fake-chat.html`, seeded, reproducible).
4. Fix in the rule module when the fix is a rule. Keep `main.js` changes small and commented with the ticket id.
5. Never "fix" a duplicate by dropping retries blindly: a lost message is worse than a visible duplicate. Prove whether the first attempt landed.

## Step 4 - Verify

```
node test/envelope.test.js
node test/relay-policy.test.js
node test/relay-trace.test.js
node test/pane-health.test.js
node test/bucket-brigade.test.js
node test/run.js
node test/stress.test.js     # needs Playwright
```
Then `npm test`. Report what was proven with fakes and what needs a live run (a Bucket Brigade on the real sites is the live proof; only the user can start it).
