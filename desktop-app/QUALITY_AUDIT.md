# Quality audit — findings and status

This is the real, checkable record behind the "known issues fixed" claim in
any status report about this codebase. Every row here is independently
verifiable against the actual source — grep for the file/function named, not
just trust this document. Run `npm run quality` alongside this for the two
mechanically-computed numbers (test pass/fail, IPC handler test coverage)
that don't depend on this list being kept honest by hand.

Last updated against this codebase after the pass described below. If you
fix something new or find something new, add a row — don't let this drift
into aspirational documentation.

## How this list was built

Three research passes read the actual current source (not any prior audit's
prose) looking for: (1) whether six previously-raised, never-resolved
findings from an earlier design-review were still real, (2) bugs in
subsystems added since that review (the delivery ledger, auto-retry, Blind
Round, the Tuner, saved logins, the mesh+tag dedup fix), and (3) real test
coverage gaps, mapped by cross-referencing every `ipcMain.handle()`
registration in `main.js` against every `call()` site in `test/run.js`.

## Fixed in this pass

| Finding | Evidence | Fix |
|---|---|---|
| **↻ Regenerate bypassed the delivery ledger, retry, and send queue** | `send:regenerate` called the send script directly instead of through `sendTextTo()` | Routed through `sendTextTo(site, text, null, { raw: true })`; now gets the queue, 3-attempt retry, and a ledger entry (correctly flagged `duplicate: true`, since a regenerate is one) |
| **House Rules and mesh routing could duplicate a delivery** | The mesh-vs-tag dedup fix only covered tag routing; a House Rules stage's own send had nothing dedupe-checking it against a re-enabled per-pane Auto toggle | Added `hrSendTextTo()` + a `sentTargets` Set returned by every `handle*Capture` function; `pollSite()` now runs the House Rule's reaction first and dedupes the mesh loop against its real result. UI-level fix: per-pane `.auto-toggle` buttons disabled while `hr.active` (`controls.js`) |
| **A send failing all 3 retries left House Rules silently stuck forever** | `sendTextTo()`'s failure branch never touched `state.hr`, unlike the rate-limit path, which auto-pauses cleanly | `opts.hr`-tagged sends now auto-pause the run on exhausted failure (`pauseReason: "send-failed"`), reusing the same pause/resume machinery as a rate-limit pause |
| **Retry loop released the send queue during backoff** | Each retry attempt called `withSendQueue()` fresh; the backoff sleep happened outside it, letting a concurrent send to the same target jump ahead | The entire attempt+backoff sequence now runs inside one `withSendQueue()` call |
| **`houserule:start`'s catch block didn't log on failure** | Every sibling error path in `main.js` calls `logEvent()`; this one didn't | Added `logEvent("houserule-start-error", ...)` |
| **`site:reload`/`site:inspect`/`site:zoom`/`send:regenerate` missing `BAD_SITE` guard** | Comparable handlers (`routing:set`, `participants:set`, `selector:pick`) all validate the site first; these didn't (not exploitable, just inconsistent) | Added the same `if (!SITES[site]) return { ok: false, error: "BAD_SITE" }` guard to all four |

Regression tests for all of the above: `testHouseRulesVsMeshDedup`,
`testSendFailureAutoPausesHouseRule`, `testRetryHoldsQueueThroughBackoff`,
`testRegenerateGoesThroughLedgerQueueRetry` in `test/run.js`.

## Checked and found already correct — no action needed

| Old finding | Why it's not real (or already handled) |
|---|---|
| `pollSite()` re-entrancy | A real per-site in-flight guard already exists: `state.busy[site]`, set before any `await` and cleared in `finally` — same shape as `selftestInFlight` |
| "Capture guard module wired into nothing" | The module was never built. A prior commit's message explains it was deliberately declined in favor of the inline validation that exists today (the `STABLE_MS` stability gate, unconditional rate-limit detection, echo detection, the connectivity test's challenge/transform check). Nothing to wire up — there's no orphaned module |
| Blind Round | Traced end to end: no participant can see another's answer early (no `await` between the pending-check and the reveal), no self-leak in the reveal, `NEEDS_EXACTLY_THREE` enforced at start |
| The Tuner | Routing restoration covered on every exit path including thrown errors (`finally`); legs run strictly sequentially, no cross-leg interference; `tunerInFlight` guard set synchronously before any `await` |
| Saved logins | Every write path traced: encryption happens before the ciphertext ever touches `state.savedLogins`; decrypted plaintext only ever exists in a local variable for one `executeJavaScript` call; delete genuinely removes the blob (no orphaned reference elsewhere) |

## Real, but deliberately deferred — not fixed in this pass

| Finding | Why it's real | Why deferred |
|---|---|---|
| **Startup routing-prompt ack can be relayed via tag routing** before the user's first real message, if a model acks it against instructions not to | `sendStartupRoutingPromptOnce()` has no ack-suppression (unlike House Rules' `ignoreCaptureFrom`/`silentAckFrom`) and tag routing has no "has the user sent a real message yet" gate | Narrow — needs the model to break its own "don't acknowledge" instruction *and* tag that ack. Needs its own suppress-next-capture mechanism; a real follow-up, not worth rushing into this pass |
| **Prompt Sequence and Manager delegation aren't coordinated with mesh/tag dedup** | Only the House-Rules-vs-mesh gap (the one with a confirmed live repro) was closed this pass; a Sequence step or a Manager delegation can still independently send to a target mesh is also covering | Sequence steps are user-deliberate (you pick the target); Manager delegation + mesh routing being simultaneously active is an unusual combination. A real general "single routing arbiter" is worth building if this keeps coming up — not a rushed partial fix now |
| **Chrome extension side has zero automated test coverage** | No test infrastructure exists at all for `extension/background.js`, `content.js`, `popup.js`, `roundtable.js` — only a selector-data-parity check touches the extension, and that's not behavioral coverage | Standing up test infrastructure from nothing is a separate effort, not a quick addition. Noted here honestly rather than left silently unmeasured |

## Known coverage gaps (not bugs, just untested)

As of this pass, `test/run.js` calls 47 of `main.js`'s 52 `ipcMain.handle()`
channels at least once (up from 45 before `send:regenerate` and
`routing:set` gained coverage as a side effect of the new regression tests).
Run `npm run quality` for the live, current count and the exact list of
uncovered channels — this number moves as the code changes, so treat any
number written here as a snapshot, not a promise.

Still uncovered as of this pass: `send:forward`, `routing:pause-all`,
`transcript:toggle-pin`, `site:inspect`, `site:list`. None of these had a
bug found against them in this audit — they're gaps in the safety net, not
known-broken code.

## What this document can't tell you

Everything above is code-level correctness and test coverage. It cannot
answer the question that actually matters most: does the real relay between
real, signed-in ChatGPT/Claude/Gemini tabs actually work right now? That
requires a live Electron session with real logged-in panes — the **🎛️
Tuner** (Run Tuner, Global panel) is the genuine, already-built instrument
for that, reporting real X/3 site and Y/6 relay-leg results. Nothing in this
file substitutes for actually running it.
