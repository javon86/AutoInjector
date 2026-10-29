# Akọwe ⇄ AutoInjector bridge (contract v1.2)

> Formerly BookForge — renamed to Akọwe on 2026-10-25.

Lets Akọwe's three AI slots (AI-1..AI-3) use the ChatGPT, Claude and Gemini web
sessions that the AutoInjector **desktop app** already drives, with no API keys.
Experimental: automating these sites' web UIs may be against their terms of service;
the bridge is OFF by default and the user must turn it on.

**Names from before the rename (compatibility).** Both sides now say `akowe`; the receivers still accept
what a BookForge-era peer sends, and an existing pairing is kept: the bridge takes over a key file saved as
`bookforge-bridge-token` as `akowe-bridge-token`; `POST /v1/status` accepts `"app": "bookforge"` and
`"bookforge_url"` (stored as `"app": "akowe"` / `"akowe_url"`); `/api/ping` answering `"app": "bookforge"`
still counts as Akọwe running; `AUTOINJECTOR_BOOKFORGE_*` and `BOOKFORGE_PORT` are read when the
`AUTOINJECTOR_AKOWE_*` / `AKOWE_PORT` variable is not set; the saved setting `{"bookforge": {"enabled"}}` is read;
log events written as `bookforge-*` still count as Akọwe events for Extract. (desktop-app/akowe-legacy.js,
akowe/akowe/legacy.py.)

```
Akọwe (Python, :8780)  --HTTP-->  AutoInjector desktop bridge (Node, 127.0.0.1:17891)
  providers.py adapter "autoinjector"        akowe-bridge.js inside the Electron main process
                                             -> sendTextTo(site, prompt) -> reply captured by [FROM: X] tag
```

## Transport and security

* HTTP/1.1 on `127.0.0.1` only (never 0.0.0.0). Default port **17891**
  (env `AUTOINJECTOR_AKOWE_PORT` overrides). JSON bodies, UTF-8.
* Every request needs `Authorization: Bearer <token>` — except `POST /v1/pair` (v1.1). In both apps' UIs the token is
  called the **connection key** ("like a password that lets only your Akọwe talk to
  this app; it never leaves your computer"). The token is a random
  >=24-byte URL-safe string generated on first enable, stored in the app's userData
  directory (`akowe-bridge-token`, mode 0600), shown/copyable in the desktop app's
  controls UI, and replaceable there ("Make a new key"). Compare in constant time.
* Bridge disabled -> server not listening (connection refused).
* Reject request bodies over 1 MiB (413). Reject non-JSON (400).
* Never log prompt or reply text; log only site, request_id, chars, outcome, elapsed.
* Never put the token in URLs or logs.
* Only requests whose `Host` is `127.0.0.1`, `localhost` or `[::1]` (optionally with the
  bridge's own port) are served; anything else gets `403 FORBIDDEN` (DNS-rebinding guard).
* The token is checked from the headers **before** the body is read (a wrong key gets 401
  at once); a body must arrive within 30 s (else `408`).

## Endpoints

### `GET /v1/health`
`200 {"ok": true, "bridge_version": "1.2", "sites": {"chatgpt": {"ready": bool, "busy": bool, "state": …,
"problem": …, "since": …, "last_probe_ok_at": …}, "claude": {...}, "gemini": {...}}}` — `ready` = the pane exists,
is loaded and its message box is on the page (and, since v1.2, its self-repair state is `ok`/`unknown`);
`busy` = a bridge request is in flight for that site. The v1.2 fields are described below.

### `POST /v1/complete`
Request:
```json
{"site": "claude", "prompt": "full prompt text", "request_id": "bf-req-123", "timeout_ms": 240000}
```
* `site` in `chatgpt|claude|gemini` (required). `prompt` non-empty string (required).
  `request_id` 1..128 chars `[A-Za-z0-9._:-]` (required). `timeout_ms` integer
  10000..900000 (default 240000).

Behavior:
1. At most ONE in-flight bridge request per site. A second request for a busy site ->
   `409 SITE_BUSY` (unless it is the same `request_id`, see 5).
2. The bridge sends the prompt to that site's pane through the existing send path —
   verbatim, with only the `[MSG #n]` line in front and the app's reply-envelope
   instruction after it (no role clause, no tag reminders) — and waits for the captured
   reply that ANSWERS that message. A bridge send never resets the AI-to-AI hop count.
3. A captured reply is **owned by the bridge** only if it answers the bridge's own
   prompt: the prompt was typed as `[MSG #n]` and the Relay Trace says the reply answers
   `#n`. A reply captured while the prompt is still queued (e.g. the AI is finishing an
   answer to the user) is never taken. An owned reply is shown in the transcript but is
   NOT relayed to other AIs (no mesh routing, roundtable, house-rule, sequence or manager
   handling), and its missing `[FROM:]` tag is never nagged about.
4. Success: `200 {"ok": true, "site", "request_id", "text": "<envelope-stripped reply>",
   "seq": "0007", "reply_to": "0007", "elapsed_ms": 1234}` — `seq` is the `[MSG #]` the
   prompt was typed as, `reply_to` the one the reply answers. Akọwe refuses a 200
   without `seq` or with `reply_to != seq`.
5. Idempotency: results are cached by `request_id` for 15 minutes. Repeating a
   completed `request_id` returns the cached 200 response without re-sending. Repeating
   an in-flight `request_id` waits for (joins) the same in-flight result.
6. Errors (JSON `{"ok": false, "error": CODE, "message": "...", "ambiguous": bool}`):

| HTTP | error | meaning | ambiguous |
|---|---|---|---|
| 400 | BAD_REQUEST | invalid body/field | false |
| 401 | UNAUTHORIZED | missing/wrong token | false |
| 404 | UNKNOWN_SITE / NOT_FOUND | bad site / path | false |
| 403 | FORBIDDEN | wrong `Host`, or a `/v1/pair` from a browser (see Pairing) | false |
| 409 | SITE_BUSY | another bridge request in flight for that site (the message names it) | false |
| 413 | TOO_LARGE | body over 1 MiB | false |
| 502 | SEND_FAILED | the prompt could not be delivered to the pane | false |
| 503 | SITE_NOT_READY | pane missing/destroyed/not loaded | false |
| 504 | TIMEOUT | no captured answer before timeout_ms; `typed` says whether the prompt was typed | **true** if typed |

Every 504 says `"typed": true|false`.
* `typed: false` — the AI was still busy, so the prompt was never typed: the queued send is
  withdrawn, the site is free at once and asking again (any request_id) is safe.
* `typed: true` (+ `seq`, `late_window_ms`) — the site may still be answering; it stays
  `busy` until that answer is captured (stored under the request_id, so a retry with the
  same request_id returns it) or for `late_window_ms` = min(timeout_ms, 300 s), then frees
  (joiners then get a 504 with `late_expired: true`). A different request_id meanwhile gets
  `409 SITE_BUSY` naming the pending request. Akọwe's "Try again" re-uses the timed-out
  request_id for the same prompt, and its busy-retry budget (600 s) is twice the late window.

## Contract v1.1 additions (backward compatible)

v1.1 only adds endpoints; everything above is unchanged. `bridge_version` is now
`"1.1"` (a v1 client must not compare it for equality; treat any `1.x` as compatible).
New error codes: `PAIRING_CODE_INVALID` (401), `PAIRING_CODE_EXPIRED` (410),
`TOO_MANY_ATTEMPTS` (429), `NOT_READY` (503, the bridge has no key yet).

### Pairing — one-click connect without copying the key

1. In AutoInjector the user presses **🔗 Connect Akọwe**. The desktop app turns the
   bridge on if needed, checks Akọwe with `GET http://127.0.0.1:<port>/api/ping`
   (`<port>` = `AKOWE_PORT` or 8780; with neither variable set it also tries
   Akọwe's fallback ports 8781..8799), makes a pairing code with the bridge's
   `createPairingCode()` and opens the default browser at

   `http://127.0.0.1:<port>/#/pair?code=<CODE>&bridge=<encodeURIComponent(bridge url)>`

   e.g. `#/pair?code=Ab3dEf6hIj9k&bridge=http%3A%2F%2F127.0.0.1%3A17891`.
   **The connection key is never put in a URL.**
2. The code: 12 characters `[A-Za-z0-9]` (crypto random), valid **120 s**, **single use**.
   Only one code is live: making a new code invalidates any older unused one.
3. Akọwe's `#/pair` page asks the author to confirm first (and warns when the link's
   bridge is not on port 17891; non-loopback bridges are refused), then Akọwe's server
   calls (no Authorization header; `Content-Type: application/json` is required and a
   request carrying a browser `Origin` header is refused with 403 — neither counts toward
   the lockout below, so a web page cannot lock pairing):

   `POST <bridge>/v1/pair` `{"code": "<CODE>", "client": "akowe"}`

| HTTP | body | when |
|---|---|---|
| 200 | `{"ok": true, "token": "<connection key>", "bridge_version": "1.1"}` | valid, unused, unexpired code — the code is now used up |
| 400 | `{"ok": false, "error": "BAD_REQUEST", ...}` | not JSON / not an object / `code` missing or not a string / `client` present but not a string |
| 401 | `{"ok": false, "error": "PAIRING_CODE_INVALID", ...}` | unknown, superseded or already-used code |
| 410 | `{"ok": false, "error": "PAIRING_CODE_EXPIRED", ...}` | the live code, but older than 120 s |
| 429 | `{"ok": false, "error": "TOO_MANY_ATTEMPTS", ...}` | 10 failed attempts (400/401/410) within 60 s lock pairing for 60 s — every attempt, even with the right code, gets 429 |
| 503 | `{"ok": false, "error": "NOT_READY", ...}` | the bridge has no connection key (the code is not used up) |

   Akọwe stores the token exactly like a pasted key (the slot's write-only
   `api_key`, never in project data) and should then post its first status (below).
   The code is compared in constant time. Neither the code (live or presented) nor
   the key is ever logged; each attempt is recorded in the activity ring only as
   `{kind: "pair", outcome: PAIRED|PAIRING_CODE_INVALID|PAIRING_CODE_EXPIRED|TOO_MANY_ATTEMPTS|BAD_REQUEST|NOT_READY, http_status}`.
   Making a code records `{kind: "pair_code"}`.
4. The desktop panel moves waiting → paired (on the 200) → **Connected ✔** (on the first
   `/v1/status` after pairing). No pairing within 120 s -> "press Connect again"; paired but
   no status within 30 s -> "Akọwe has the key but hasn't reported yet" (the AIs still work).

### `POST /v1/status` — what Akọwe is doing (Bearer)

Akọwe sends this whenever something changes and at least every ~30 s while it runs
(the desktop marks a status **stale** after 90 s without a new one). Body (JSON, under
32 KiB, otherwise 413 `TOO_LARGE`):

```json
{"app": "akowe", "version": 1, "akowe_url": "http://127.0.0.1:8780/",
 "project": {"id": "p-1", "title": "The Lantern Keeper"},
 "current_task": {"set": "B", "op": "B03", "title": "Main plot", "state": "running",
                  "message": "Drafting the main plot with Claude", "url": "http://127.0.0.1:8780/#/op/B03"},
 "working_on": {"op": "B03", "title": "Main plot", "started_at": "2026-10-17T10:00:00Z"},
 "approvals": {"count": 2, "items": [{"op": "B01", "set": "B", "title": "Premise"}], "url": "http://127.0.0.1:8780/#/approvals"},
 "checklist": [{"id": "A", "title": "Book profile", "set": "A", "state": "done"}],
 "done": 1, "total": 9, "updated_at": "2026-10-17T10:00:05Z"}
```

* `app` must be `"akowe"` (else 400). Invalid JSON / not an object -> 400. Success -> `200 {"ok": true}`.
* Sanitizing (the bridge never rejects for these, it just cleans): only the fields above are
  kept (anything else is dropped); strings have control characters removed and are capped
  (titles 200, `message` 500, `op`/`state` 40, `set` 20, ids 60–100); `approvals.items` max 20,
  `checklist` max 40; `count`/`done`/`total` non-negative integers; every URL must be
  `http://127.0.0.1…` or `http://localhost…` (anything else becomes `null`);
  `started_at`/`updated_at` may be ISO 8601 or Unix epoch seconds/ms and are normalized to epoch ms.
  `working_on` may be `null`.
* `run` (Akọwe sends it since the first PC test; the bridge must add it to `sanitizeAkoweStatus` to keep it): the
  newest ⚡ Make-a-book run of this book, or `null` —
  `{"id", "title", "state", "state_words", "status", "needs_you", "needs_decision", "steps_done", "steps_total",
  "phase", "problem", "updated_at", "finished_at", "url"}`. `checklist`/`done`/`total` are the BOOK's steps (Make my
  book): a book can be 10/10 while its last run stopped part-way, so show the run from `run`, never from the
  checklist. `run.state` is one of `working`, `waiting`, `pausing`, `paused` (by the author), `needs_decision` (the AI
  reviewer did not pass a draft: approve anyway / edit / try again), `problem` (stopped on a problem: Try again),
  `interrupted` (Akọwe was closed while it worked: Resume), `done`, `cancelled`; `needs_you` is true for paused,
  needs_decision, problem and interrupted. `state_words` is a plain sentence to show as it is.
* Suggested `state` words (the panel maps synonyms): task — `running`, `waiting`,
  `needs_approval`, `done`, `error`, `idle`; checklist — `done`, `current`, `needs_approval`,
  `todo`, `blocked`, `skipped`.
* The bridge keeps only the latest status (+ `receivedAt`) and exposes it as `status().akowe`
  (`null` until the first one) with `age_ms` and `stale` (`true` after 90 s). A status counts as
  contact from Akọwe. Its content never goes to the logs or the activity ring — only
  `{kind: "status"}` ("Akọwe sent an update on your book"), and only for the first status,
  the first after a 90 s gap, and the first after a pairing.

## Contract v1.2 additions — self-repair (backward compatible)

v1.2 adds the AutoInjector self-repair (plan Section 1, P18.1–P18.8; `desktop-app/self-repair.js`).
`bridge_version` is `"1.2"`; nothing earlier changes meaning. A v1.1 client simply ignores the new fields.

**Check-ins.** AutoInjector sends each Active AI a tiny message — `[MSG #n]` + `Reply with only this word: <word>`
+ the usual reply-envelope line — at start (once its page has loaded), every 20 minutes while the AI is idle
(configurable in the panel: off/10/20/30/60 min) and on demand (🩺 Check now, or `POST /v1/probe`). Never while the
user typed in that pane within the last 2 minutes or its message box holds text, while it is writing, waiting for a
reply, getting another message, answering Akọwe, or during a test. A check-in's answer is owned by the
self-repair: it is not shown in the conversation, never relayed to another AI, never nagged about tags.

**States per AI** (`state`): `unknown` (no check-in yet) · `ok` (the last check-in was answered) · `repairing`
(a check-in failed and an automatic fix is running) · `needs_user` (only the user can fix it — logged out, a
captcha, a usage limit — or the user is being asked to show AutoInjector the page) · `broken` (every automatic
fix failed). `problem` is one code, exactly one of: `TYPE_FAILED`, `SEND_NOT_CONFIRMED`, `NO_REPLY_FOUND`,
`FALSE_DUPLICATE`, `STUCK_GENERATING`, `LOGGED_OUT`, `CAPTCHA`, `USAGE_LIMIT`, `NETWORK_ERROR`, `PAGE_ERROR`,
`UNKNOWN` (or `null`). `since` = when the current state began (epoch ms, `null` while `unknown`);
`last_probe_ok_at` = the last answered check-in (epoch ms or `null`). Malformed values are never sent (an
unknown state becomes `unknown`, a malformed problem `null`).

### `GET /v1/health` (changed)
Each site additionally has `"state"`, `"problem"`, `"since"`, `"last_probe_ok_at"`. `ready` keeps its v1 meaning
but is `false` whenever `state` is not `"ok"`/`"unknown"`.

### `POST /v1/probe` (new, Bearer)
Body (optional; empty body or `{}` = every Active AI): `{"sites": ["chatgpt", "claude", "gemini"]}` (≤ 10 names,
duplicates collapsed, body ≤ 4 KiB). Starts check-ins and answers at once:
`202 {"ok": true, "started": ["claude"], "skipped": {"chatgpt": "busy"}}`. Results appear later in `/v1/health`
(`state`, `last_probe_ok_at`). Skip reasons: `inactive`, `busy`, `typing`, `checking` (one is already running),
`teaching`, `akowe` (a bridge request is in flight there), `waiting`, `sending`, `test`, `not_ready`,
`unsupported` (a host without self-repair). Errors: 401 (key), 400 `BAD_REQUEST` (not JSON / not an object /
`sites` not a list of strings), 404 `UNKNOWN_SITE`, 413 `TOO_LARGE`. Each started/skipped AI is an activity
event `{kind: "probe", site, outcome: STARTED|SKIPPED}`.

### `POST /v1/complete` (changed)
To a site whose `state` is `repairing`, `needs_user` or `broken`: `503` with
`{"ok": false, "error": "SITE_NOT_READY", "message": "...", "ambiguous": false, "state": "needs_user", "problem": "LOGGED_OUT"}`
— nothing is typed; Akọwe routes the work to another AI. (This check comes after the cache / join / `409
SITE_BUSY` checks; `ok`/`unknown` behave exactly as in v1.1.)

### What the desktop does on a failure (informative)
Classifier evidence: page signals from one table (`PAGE_SIGNATURES`: log-in URLs/buttons/texts, captcha frames
and texts, usage-limit and error notices — notices only, never a reply's own words), the send result, what the
reply reader sees, and whether the check-in word is on the page outside the user's message. Repair ladders:
`TYPE_FAILED`/`SEND_NOT_CONFIRMED` → built-in alternative selectors → reload → teach step;
`NO_REPLY_FOUND` → alternatives → page search (find the word in a new block, derive + verify a stable selector,
save it) → reload → teach; `FALSE_DUPLICATE` → a fresh check-in → page search → reload → teach;
`STUCK_GENERATING` → press Stop, wait, send once more → reload → broken; `PAGE_ERROR`/`NETWORK_ERROR` → reload →
fresh page → broken; `LOGGED_OUT`/`CAPTCHA`/`USAGE_LIMIT` → `needs_user` with what to do, a cheap signature
re-check every 60 s (and whenever the page changes), one check-in once the signature is gone. Every step after a
fix attempt is confirmed by a new check-in. Learned selectors are stored per site (versioned, with the time and
how they were learned) and used before the built-in ones. The teach step asks the user to type
`Repeat this number: ####` into the AI (a pop-up in the panel and a banner in the AI's window) and learns the
message box, how it was sent, the user's message and the reply from where the number appears. An Akọwe
request that times out / fails, or an AI whose reply stalls, gets a check-in once it is free.

**P18.5 (no more false duplicates).** A reply captured while a prompt's send script was still confirming it (the
AI answered during a `SEND_NOT_CONFIRMED` retry — the Gemini case of the first real run) now answers that prompt:
the Relay Trace counts a message being typed into an idle AI as the one a capture answers, the host hands the
bridge the `[MSG #]` number as soon as it is stamped (`cancelToken.seq`), and the bridge also remembers a declined
reply briefly so a send that confirms a moment later still collects its answer. A reply whose words equal the
previous one is new when the AI was seen writing (≥ 2 reads) after the message went out.

**Logging (P18.10).** Detections, steps and results are logged as `self-repair` events with site, step, code and
outcome only, listed in the panel's AI cards (⚠️ pop-over: "What AutoInjector already tried") and in 📋 Copy
diagnostics — never the check-in word, prompts, replies or the key. The `capture-stalled` log line no longer
carries the reply's last characters.

### Fake host (tests)
`test/fixtures/fake-bridge-host.js --site-state chatgpt=needs_user:LOGGED_OUT,gemini=repairing:NO_REPLY_FOUND`
pins states (SIGUSR1 clears them); `POST /v1/probe` makes the other sites `ok` after `--delay-ms`.
`test/fixtures/fake-chat.html` answers check-ins (`Reply with only this word: X` → X) and teach prompts
(`Repeat this number: 1234` → 1234), so the real-Chromium e2e (`akowe-e2e.test.js`) passes Akọwe's
pre-run check-in.

## Status, activity and the link test (desktop side, informative)

* `status()` (akowe-bridge.js) additionally reports `lastContactAt` (any authenticated
  request), `lastExternalContactAt` (same, excluding the app's own link test), `counters`,
  the request in flight per site, each site's last result, and a ring buffer of the last 50
  events `{kind, site, request_id, outcome, elapsed_ms, http_status, at, selftest}` — never
  prompt/reply text, never the real or a presented key (fields are whitelisted). Wrong-key
  attempts are recorded as `unauthorized` events. main.js broadcasts each event to the
  panel as `akowe-activity` (with a fresh status snapshot); the 4 s refresh remains.
* The app's own link test marks itself with header `X-AutoInjector-Selftest: 1` and
  request_ids `selftest-<stamp>-<site>`, so it never counts as "Akọwe connected".
  Akọwe must not use that header or prefix.
* **🧪 Test the connection** (akowe-link-test.js; it ticks the panel's "Connection check" rows): bridge listening; key file present;
  wrong key -> 401; right key -> `/v1/health` 200; per Active AI: pane ready, then a real
  `POST /v1/complete` with a JSON_SCHEMA prompt whose reply must be one JSON object echoing
  a random word; then `GET http://127.0.0.1:8780/api/ping` (`{"app":"akowe",...}`;
  SKIPPED with instructions when unreachable); then "Akọwe is connected" (PASS when it has
  talked to the bridge with the current key / sent a fresh status, otherwise SKIPPED with
  "press Connect Akọwe"). Reports: `<logs>/akowe-link-test-<stamp>.md`
  and `.json` (no key, no prompt text; last 80 chars of each reply).

## Akọwe side

* Slot `adapter_id: "autoinjector"`, extra slot fields `bridge_url`
  (default `http://127.0.0.1:17891`) and `site` (`chatgpt|claude|gemini`). The bridge
  token is saved through the slot's write-only `api_key` field (secret file, never in
  project data). Default mapping when connecting all three: AI-1=claude,
  AI-2=chatgpt, AI-3=gemini. Cost 0 minor units (web sessions, no per-use bill).
* `request_id` = deterministic from Akọwe's request_id + attempt, so a retry of the
  same logical call joins/reuses the bridge result instead of sending twice.
* The adapter puts the system text, the context package and the JSON output schema in
  one prompt and requires a single JSON object answer. It extracts JSON (code fences
  and surrounding prose tolerated), validates it against the sanitized schema, and on
  failure re-asks the same site up to 2 more times with the exact validation errors
  (free re-asks). The kernel still validates the full OUTPUT schema afterwards.
* Error mapping: connection refused / 503 -> UPSTREAM_UNAVAILABLE (retryable);
  409 -> RATE_LIMITED (retryable); 401 -> CAPABILITY_UNAVAILABLE; 400/413 ->
  INVALID_INPUT; 502 -> UPSTREAM_UNAVAILABLE; 504 -> TIMEOUT (ambiguous: user decides).
* "All three": each slot may declare `roles` (list of operation IDs or set letters,
  e.g. `["B", "C02"]`). When any eligible slot's roles match the operation, only those
  slots are used; otherwise normal cost/load/slot-id order applies.
* Akọwe default port moves 8765 -> **8780** (8765 collides with the extension's
  bridge WebSocket in `AutoInjector/server/fake_api_server.py`).

## Tested so far

* `desktop-app/test/akowe-bridge.test.js` (164 checks, incl. activity/last-contact with
  no text leakage; v1.1: pairing codes — format, single use, superseded, expiry 410, bad
  bodies, rate limit 429 and recovery, no key yet 503, codes/key never in status/events/logs;
  `/v1/status` — auth, whitelist, caps, loopback-only URLs, 400/413, staleness, events
  without content; the fake host's `--pairing-code-file` / `--status-file`) and
  `akowe-main.test.js` (73 checks, real main.js under the mock-Electron harness:
  bridge-owned replies are not relayed, token never in state/log files, activity broadcasts,
  a full link-test run with its reports; v1.1: Connect turns the bridge on, Akọwe not
  running -> instructions + "Start Akọwe for me" really runs the launcher, Connect opens
  `#/pair?code=…&bridge=…` (mocked `shell.openExternal`, never the key), pair -> status ->
  "connected" in the snapshot, open-url refuses non-loopback URLs, a new key disconnects).
* `desktop-app/test/akowe-link-test.test.js` (64 checks): the link test against the real
  bridge with fake panes — pass, wrong key accepted, pane not ready, timeout, bad JSON,
  Akọwe not running, busy site, stop mid-run, reports contain no key/prompt, and the
  optional "Akọwe is connected" step.
* `akowe/tests/test_autoinjector_adapter.py` (Python adapter vs an in-process fake).
* `akowe/tests/test_bridge_cross_process.py`: real Python Akọwe -> real Node
  `akowe-bridge.js` (via `fake-bridge-host.js`, three fake panes): connect-all-three,
  health, a creative operation end to end, roles routing, invalid-then-valid re-ask,
  timeout -> user decision with nothing saved, busy, wrong token.
* v1.2: `desktop-app/test/akowe-bridge-v12.test.js` (health fields, cleaning, `/v1/probe` incl. errors and a
  v1.1 host, 503 `{state, problem}`, the P18.5 ownership incl. the exact Gemini reply, fake host `--site-state`),
  `test/self-repair.test.js` (classifier, signals, alternatives, page search, teach learner, engine flows),
  `test/self-repair-main.test.js` (real main.js: the Gemini regression end to end, identical answers, check-ins
  hidden + not relayed, page search repair, needs_user → 503, diagnostics without text) and the real-Electron
  `test/e2e/self-repair.e2e.js`.
* NOT tested: the live ChatGPT/Claude/Gemini websites (needs your logged-in sessions).

## Known limitations

* If a pane is still finishing an earlier reply when Akọwe sends, that earlier reply
  can be captured as the answer. Let panes go idle before using the bridge.
* Replies the app drops before capture (rate-limit notices, a bare NONE, an empty
  envelope, an exact duplicate of the previous reply) end as 504 TIMEOUT rather than a
  specific error.
* A custom role set on a pane in AutoInjector is still prefixed to Akọwe prompts.
* One-click Connect needs an Akọwe that has the `#/pair` page and `POST /v1/pair` client;
  an older Akọwe opens normally but never pairs (the panel then says "press Connect
  again" after 2 minutes — use Other ways -> Copy connection key).
* "Start Akọwe for me" uses Akọwe's own launcher, which also opens its own browser
  tab, so you may briefly see two Akọwe tabs. On macOS/Linux it runs in the background
  (no terminal window); stop it from Akọwe or with your system's tools.

## One app: AutoInjector runs Akọwe and pairs it by itself (2026-10-25)

AutoInjector now starts Akọwe's server itself (`desktop-app/akowe-server.js`; reuses an Akọwe
that already answers on 8780..8799) and shows it in its **📖 Akọwe** tab. When that server is up and
AutoInjector knows its access token (read from Akọwe's "Open:" line, or from its data folder's
`local_token` after the `/api/ping?challenge=` proof matches), it pairs without the browser: bridge on,
`createPairingCode()`, then Akọwe's own `POST /api/slots/pair-autoinjector {code, bridge_url}` (Bearer =
Akọwe's access token) — the same call the `#/pair` page makes, so the key still never appears in a URL.
It skips this when one of Akọwe's slots uses another adapter (an API key) — 🔗 Connect still does it on
request — and when the user turned the Bridge switch off. The contract above is unchanged.

## First real run (on your PC)

1. `git pull`, then start AutoInjector desktop (`desktop-app/run-windows.bat`) and log in
   to ChatGPT, Claude and Gemini in their panes. Turn routing/autopilot OFF. Akọwe starts
   with it (📖 Akọwe tab) and connects by itself — then skip to the 🧪 test in step 3.
2. (Only for an Akọwe you run on its own) Start Akọwe (`akowe/run-akowe.bat`, port 8780) — or skip this and let step 3
   offer **▶ Start Akọwe for me**.
3. In AutoInjector's **Akọwe** panel press **🔗 Connect Akọwe**. Your browser opens
   Akọwe's pairing page; confirm there if it asks. The panel shows **Connected ✔** and
   "Now working on" / "Book checklist" fill in. (Fallback: **Other ways → 📋 Copy connection
   key**, paste it in Akọwe Settings -> Connect AutoInjector.) Then press **🧪 Test the
   connection**: every Active AI should PASS.
4. Create a project, open B01 Premise, fill idea/goals and Create. Watch the Claude pane
   receive the prompt; Akọwe should show a DRAFT premise. If it reports TIMEOUT or a
   JSON error, note which site and what the pane showed.

## Akọwe side of v1.2 (notes from Akọwe, P18.9)

* Akọwe reads `state`/`problem`/`since`/`last_probe_ok_at` from `GET /v1/health` (cached 15 s per bridge) and
  skips a slot whose site is `repairing`, `needs_user` or `broken`; `ok` and `unknown` (or a bridge without these
  fields) keep the old behaviour. Timestamps may be epoch seconds, epoch milliseconds or ISO 8601.
* Before a Make-a-book run, Write all chapters and the workflow test Akọwe sends `POST /v1/probe` once with the
  sites of its AutoInjector slots and polls `/v1/health` every 2 s for at most 60 s. A probed site counts as
  answered when its state is `needs_user`/`broken`, or `ok` with `last_probe_ok_at` (or `since`) not older than the
  probe; `repairing`/`unknown` keep it waiting. A 404 on `/v1/probe` is treated as an older bridge.
* A `503 SITE_NOT_READY` with `state`/`problem` moves the call to another working slot at once (no same-site
  retries); without `state` it is treated as `broken` for this call.
* Problem codes Akọwe has plain words for (akowe/web/problems.js `SITE_PROBLEMS`; others are shown as the
  code in plain letters): the self-repair codes `TYPE_FAILED`, `SEND_NOT_CONFIRMED`, `NO_REPLY_FOUND`,
  `FALSE_DUPLICATE`, `STUCK_GENERATING`, `LOGGED_OUT`, `CAPTCHA`, `USAGE_LIMIT`, `NETWORK_ERROR`, `PAGE_ERROR`,
  `UNKNOWN`, plus a few older names. Codes must match `[A-Za-z][A-Za-z0-9_.:-]{0,63}`; anything else is ignored.
