---
name: autoinjector-pane-repair
description: Diagnose and fix AutoInjector's ChatGPT / Claude / Gemini pane automation when a site changes its page - message box not found, Send not clicking or not confirmed, half or empty replies, the user's own message or sidebar text captured as the answer, page pop-ups blocking sends. Use for any INPUT_NOT_FOUND, INJECT_FAILED, SEND_NOT_CONFIRMED, AI_BUSY, PROVIDER_PAUSED, reply-selector-ignored, reply-selector-fragment, capture-stalled or "it grabbed the wrong text" problem.
---

# AutoInjector pane repair

The three AI panes are real websites. AutoInjector drives them with small scripts it injects
(`webContents.executeJavaScript`). When a site changes its page, these scripts are what breaks.
All paths below are relative to `desktop-app/`.

## The pieces (read these before changing anything)

| File | What it owns |
|---|---|
| `selectors.js` | Per-site candidate lists: `INPUT_CANDIDATES`, `SEND_CANDIDATES`, `STOP_CANDIDATES`, `ASSISTANT_CANDIDATES`, `IMAGE_CANDIDATES`, `FILE_INPUT_CANDIDATES`, login lists. **First file to check when a site changes.** |
| `../AutoInjector/extension/selectors.js` | The browser-extension copy. Must match `selectors.js` exactly; `test/selectors-sync.test.js` fails if they drift. Change both. |
| `automation.js` | `buildSendScript` (type + send + prove arrival), `buildReadScript` (read latest reply, `generating`, `sendReady`, `composerEmpty`, `inputFound`, `count`, `fragmentFixed`, `overrideIgnored`), `buildProbeScript`, `buildPickScript`, `USER_TURNS`, `MESSAGE_CONTAINERS`, `SURVEY_PHRASES`, `DEFAULT_PAUSE_MARKERS`. |
| `transcript-rows.js` | `rowKit` - tells user rows from AI rows on row-based pages (Claude since 2026-10-29) and marks page chrome (sidebar, recents, nav). Embedded by source with `rowKit.toString()`, so it must stay **self-contained** (no references to module scope). |
| `reply-clean.js` | `EXCLUDE_SELECTORS` (DOM layer) and `cleanReplyText()` (text backup) that strip "ChatGPT said:", thinking summaries, code labels, timestamps. |
| `site-errors.js` | Tells a site's own error notice ("Something went wrong") from a real reply. |
| `self-repair.js` | Check-in probe, failure `CODES`, `PAGE_SIGNATURES` (login / captcha / usage-limit pages), `ALT_SELECTORS`, learned selectors. |
| `main.js` → `pollSite(site)` | Runs the read script, cleans the text, decides completion. `sendTextTo()` runs the send script with retries. |
| `tools/page-structure.js`, `tools/page-check.js` | Read-only page structure report with no message text. `page-check.js` is **generated** - regenerate with `node tools/page-structure.js --snippet > tools/page-check.js`, never hand-edit. |

## Step 1 - Name the failure from evidence, not guesses

Get the exact error code or log event first. Sources, in order:
1. The user's log or Relay Trace report (`autoinjector-debug.log` in the app's userData folder; Extract / Relay Trace from the app).
2. `logEvent` kinds in `main.js`: `send-error`, `send-unverified`, `send-saved-button-missing`, `send-retry`, `reply-unreadable`, `reply-selector-ignored`, `reply-selector-fragment`, `reply-redrawn`, `capture-stalled`, `provider-paused`, `popup-dismissed`, `site-error-detected`, `rate-limit-detected`, `selector-override-dropped`.
3. A page-structure report from the user (🎯 card → "📋 Copy page structure", or paste `tools/page-check.js` into the pane's DevTools console).

Map the symptom to its owner:

| Symptom / code | Look at |
|---|---|
| `INPUT_NOT_FOUND` | `INPUT_CANDIDATES`; if the composer is truly gone, `DEFAULT_PAUSE_MARKERS` (→ `PROVIDER_PAUSED`) and `self-repair.js` `PAGE_SIGNATURES` (logged out, captcha, limit). |
| `INJECT_FAILED` | Typing path in `buildSendScript` (native value setter → `via` fallbacks → `typeByKeyboard`). Rich editors that ignore raw DOM writes: fixtures `strict-editor.html`, `wrapped-editor*.html`. |
| `SEND_NOT_CONFIRMED` / `send-unverified` | Box emptied but no new user turn and no `[MSG #n]` seen: `USER_TURNS[site]`, `SEND_CANDIDATES` (hidden duplicate Send buttons). |
| `AI_BUSY` | Send locked while a reply is still streaming; check `STOP_CANDIDATES` and `busyHow`. Usually correct behavior, not a bug. |
| Captured text is the user's own message | `looksLikeEcho()` in `main.js`; `ASSISTANT_CANDIDATES` too broad; on row pages, `rowKit` role classification. |
| Captured text is sidebar / chat titles | `rowKit` `CHROME` list; `badRoleSelector`/`isChromeSelector` in `main.js`; fixture `reply-chrome.html`. |
| Only part of the reply | `MESSAGE_CONTAINERS[site]`, `fragmentFixed`; fixtures `split-reply.html`, `claude-reply-multiparagraph.html`. |
| Reply captured mid-stream | `STOP_CANDIDATES`/`generating`; fixture `no-stop-streaming.html`. |
| "Claude said:" etc. in the text | `reply-clean.js`. |
| Site error notice taken as an answer | `site-errors.js` (keep it narrow - short replies only). |

## Step 2 - Reproduce offline before fixing

Never fix a selector only against a description. Reproduce with a fixture:
1. Look for an existing fixture in `test/fixtures/` that matches (`fake-chat.html` is the parameterised fake for all three sites; `claude-rows.html` is Claude's row layout).
2. If none matches, add a new small static HTML fixture copying **only the structure** from the page-structure report (tags, `data-testid`, roles, classes). Never paste real conversation text.
3. Add a failing case in `test/browser.test.js` (runs the real generated scripts in real Chromium) or, for `rowKit`/self-repair page scripts, a case on `test/fake-dom.js`. Run it and watch it fail for the reason you expect.

## Step 3 - Fix at the right layer

- Prefer **adding** a candidate to the front of a list in `selectors.js` over replacing old ones (sites A/B test; old layouts linger). Mirror it in `../AutoInjector/extension/selectors.js`.
- Never use a bare tag selector (`span`, `div`, `p`) - `isBareTagSelector()` rejects them for a reason.
- Never let an assistant/user selector match inside page chrome.
- Keep the scripts' error codes stable; `main.js`, `pane-health.js` and `relay-trace.js` key off them.
- Keep the comment convention: say *why*, with the date / PC-test or ticket id (e.g. `// TR-24:`) that motivated it.
- If you touch `rowKit`, keep it closure-free so `rowKit.toString()` still runs inside the page.
- If you touch `tools/page-structure.js`, regenerate `tools/page-check.js`.

## Step 4 - Verify

Run, from `desktop-app/`:
```
node test/selectors-sync.test.js
node test/read-script.test.js
node test/reply-clean.test.js
node test/site-errors.test.js
node test/self-repair.test.js
node test/browser.test.js        # needs Playwright: npm install --no-save playwright
node test/stress.test.js         # full relay against fake sites in Chromium
```
Then `npm test` for the whole unit layer. Use the `autoinjector-verify-change` skill to decide what else applies.

State clearly in your report what was proven offline (fixtures) versus what still needs a live check on the real site, which only the user can do in the running app (🎯 picker / self-test on the real pane). Do not claim a site is fixed until a live check passes.
