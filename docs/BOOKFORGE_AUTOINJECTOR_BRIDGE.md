# BookForge ⇄ AutoInjector bridge (contract v1.1)

Lets BookForge's three AI slots (AI-1..AI-3) use the ChatGPT, Claude and Gemini web
sessions that the AutoInjector **desktop app** already drives, with no API keys.
Experimental: automating these sites' web UIs may be against their terms of service;
the bridge is OFF by default and the user must turn it on.

```
BookForge (Python, :8780)  --HTTP-->  AutoInjector desktop bridge (Node, 127.0.0.1:17891)
  providers.py adapter "autoinjector"        bookforge-bridge.js inside the Electron main process
                                             -> sendTextTo(site, prompt) -> reply captured by [FROM: X] tag
```

## Transport and security

* HTTP/1.1 on `127.0.0.1` only (never 0.0.0.0). Default port **17891**
  (env `AUTOINJECTOR_BOOKFORGE_PORT` overrides). JSON bodies, UTF-8.
* Every request needs `Authorization: Bearer <token>` — except `POST /v1/pair` (v1.1). In both apps' UIs the token is
  called the **connection key** ("like a password that lets only your BookForge talk to
  this app; it never leaves your computer"). The token is a random
  >=24-byte URL-safe string generated on first enable, stored in the app's userData
  directory (`bookforge-bridge-token`, mode 0600), shown/copyable in the desktop app's
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
`200 {"ok": true, "bridge_version": "1.1", "sites": {"chatgpt": {"ready": bool, "busy": bool},
"claude": {...}, "gemini": {...}}}` — `ready` = the pane exists and is loaded;
`busy` = a bridge request is in flight for that site.

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
   prompt was typed as, `reply_to` the one the reply answers. BookForge refuses a 200
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
  `409 SITE_BUSY` naming the pending request. BookForge's "Try again" re-uses the timed-out
  request_id for the same prompt, and its busy-retry budget (600 s) is twice the late window.

## Contract v1.1 additions (backward compatible)

v1.1 only adds endpoints; everything above is unchanged. `bridge_version` is now
`"1.1"` (a v1 client must not compare it for equality; treat any `1.x` as compatible).
New error codes: `PAIRING_CODE_INVALID` (401), `PAIRING_CODE_EXPIRED` (410),
`TOO_MANY_ATTEMPTS` (429), `NOT_READY` (503, the bridge has no key yet).

### Pairing — one-click connect without copying the key

1. In AutoInjector the user presses **🔗 Connect BookForge**. The desktop app turns the
   bridge on if needed, checks BookForge with `GET http://127.0.0.1:<port>/api/ping`
   (`<port>` = `BOOKFORGE_PORT` or 8780; with neither variable set it also tries
   BookForge's fallback ports 8781..8799), makes a pairing code with the bridge's
   `createPairingCode()` and opens the default browser at

   `http://127.0.0.1:<port>/#/pair?code=<CODE>&bridge=<encodeURIComponent(bridge url)>`

   e.g. `#/pair?code=Ab3dEf6hIj9k&bridge=http%3A%2F%2F127.0.0.1%3A17891`.
   **The connection key is never put in a URL.**
2. The code: 12 characters `[A-Za-z0-9]` (crypto random), valid **120 s**, **single use**.
   Only one code is live: making a new code invalidates any older unused one.
3. BookForge's `#/pair` page asks the author to confirm first (and warns when the link's
   bridge is not on port 17891; non-loopback bridges are refused), then BookForge's server
   calls (no Authorization header; `Content-Type: application/json` is required and a
   request carrying a browser `Origin` header is refused with 403 — neither counts toward
   the lockout below, so a web page cannot lock pairing):

   `POST <bridge>/v1/pair` `{"code": "<CODE>", "client": "bookforge"}`

| HTTP | body | when |
|---|---|---|
| 200 | `{"ok": true, "token": "<connection key>", "bridge_version": "1.1"}` | valid, unused, unexpired code — the code is now used up |
| 400 | `{"ok": false, "error": "BAD_REQUEST", ...}` | not JSON / not an object / `code` missing or not a string / `client` present but not a string |
| 401 | `{"ok": false, "error": "PAIRING_CODE_INVALID", ...}` | unknown, superseded or already-used code |
| 410 | `{"ok": false, "error": "PAIRING_CODE_EXPIRED", ...}` | the live code, but older than 120 s |
| 429 | `{"ok": false, "error": "TOO_MANY_ATTEMPTS", ...}` | 10 failed attempts (400/401/410) within 60 s lock pairing for 60 s — every attempt, even with the right code, gets 429 |
| 503 | `{"ok": false, "error": "NOT_READY", ...}` | the bridge has no connection key (the code is not used up) |

   BookForge stores the token exactly like a pasted key (the slot's write-only
   `api_key`, never in project data) and should then post its first status (below).
   The code is compared in constant time. Neither the code (live or presented) nor
   the key is ever logged; each attempt is recorded in the activity ring only as
   `{kind: "pair", outcome: PAIRED|PAIRING_CODE_INVALID|PAIRING_CODE_EXPIRED|TOO_MANY_ATTEMPTS|BAD_REQUEST|NOT_READY, http_status}`.
   Making a code records `{kind: "pair_code"}`.
4. The desktop panel moves waiting → paired (on the 200) → **Connected ✔** (on the first
   `/v1/status` after pairing). No pairing within 120 s -> "press Connect again"; paired but
   no status within 30 s -> "BookForge has the key but hasn't reported yet" (the AIs still work).

### `POST /v1/status` — what BookForge is doing (Bearer)

BookForge sends this whenever something changes and at least every ~30 s while it runs
(the desktop marks a status **stale** after 90 s without a new one). Body (JSON, under
32 KiB, otherwise 413 `TOO_LARGE`):

```json
{"app": "bookforge", "version": 1, "bookforge_url": "http://127.0.0.1:8780/",
 "project": {"id": "p-1", "title": "The Lantern Keeper"},
 "current_task": {"set": "B", "op": "B03", "title": "Main plot", "state": "running",
                  "message": "Drafting the main plot with Claude", "url": "http://127.0.0.1:8780/#/op/B03"},
 "working_on": {"op": "B03", "title": "Main plot", "started_at": "2026-10-17T10:00:00Z"},
 "approvals": {"count": 2, "items": [{"op": "B01", "set": "B", "title": "Premise"}], "url": "http://127.0.0.1:8780/#/approvals"},
 "checklist": [{"id": "A", "title": "Book profile", "set": "A", "state": "done"}],
 "done": 1, "total": 9, "updated_at": "2026-10-17T10:00:05Z"}
```

* `app` must be `"bookforge"` (else 400). Invalid JSON / not an object -> 400. Success -> `200 {"ok": true}`.
* Sanitizing (the bridge never rejects for these, it just cleans): only the fields above are
  kept (anything else is dropped); strings have control characters removed and are capped
  (titles 200, `message` 500, `op`/`state` 40, `set` 20, ids 60–100); `approvals.items` max 20,
  `checklist` max 40; `count`/`done`/`total` non-negative integers; every URL must be
  `http://127.0.0.1…` or `http://localhost…` (anything else becomes `null`);
  `started_at`/`updated_at` may be ISO 8601 or Unix epoch seconds/ms and are normalized to epoch ms.
  `working_on` may be `null`.
* Suggested `state` words (the panel maps synonyms): task — `running`, `waiting`,
  `needs_approval`, `done`, `error`, `idle`; checklist — `done`, `current`, `needs_approval`,
  `todo`, `blocked`, `skipped`.
* The bridge keeps only the latest status (+ `receivedAt`) and exposes it as `status().bookforge`
  (`null` until the first one) with `age_ms` and `stale` (`true` after 90 s). A status counts as
  contact from BookForge. Its content never goes to the logs or the activity ring — only
  `{kind: "status"}` ("BookForge sent an update on your book"), and only for the first status,
  the first after a 90 s gap, and the first after a pairing.

## Status, activity and the link test (desktop side, informative)

* `status()` (bookforge-bridge.js) additionally reports `lastContactAt` (any authenticated
  request), `lastExternalContactAt` (same, excluding the app's own link test), `counters`,
  the request in flight per site, each site's last result, and a ring buffer of the last 50
  events `{kind, site, request_id, outcome, elapsed_ms, http_status, at, selftest}` — never
  prompt/reply text, never the real or a presented key (fields are whitelisted). Wrong-key
  attempts are recorded as `unauthorized` events. main.js broadcasts each event to the
  panel as `bookforge-activity` (with a fresh status snapshot); the 4 s refresh remains.
* The app's own link test marks itself with header `X-AutoInjector-Selftest: 1` and
  request_ids `selftest-<stamp>-<site>`, so it never counts as "BookForge connected".
  BookForge must not use that header or prefix.
* **🧪 Test the connection** (bookforge-link-test.js; it ticks the panel's "Connection check" rows): bridge listening; key file present;
  wrong key -> 401; right key -> `/v1/health` 200; per Active AI: pane ready, then a real
  `POST /v1/complete` with a JSON_SCHEMA prompt whose reply must be one JSON object echoing
  a random word; then `GET http://127.0.0.1:8780/api/ping` (`{"app":"bookforge",...}`;
  SKIPPED with instructions when unreachable); then "BookForge is connected" (PASS when it has
  talked to the bridge with the current key / sent a fresh status, otherwise SKIPPED with
  "press Connect BookForge"). Reports: `<logs>/bookforge-link-test-<stamp>.md`
  and `.json` (no key, no prompt text; last 80 chars of each reply).

## BookForge side

* Slot `adapter_id: "autoinjector"`, extra slot fields `bridge_url`
  (default `http://127.0.0.1:17891`) and `site` (`chatgpt|claude|gemini`). The bridge
  token is saved through the slot's write-only `api_key` field (secret file, never in
  project data). Default mapping when connecting all three: AI-1=claude,
  AI-2=chatgpt, AI-3=gemini. Cost 0 minor units (web sessions, no per-use bill).
* `request_id` = deterministic from BookForge's request_id + attempt, so a retry of the
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
* BookForge default port moves 8765 -> **8780** (8765 collides with the extension's
  bridge WebSocket in `AutoInjector/server/fake_api_server.py`).

## Tested so far

* `desktop-app/test/bookforge-bridge.test.js` (164 checks, incl. activity/last-contact with
  no text leakage; v1.1: pairing codes — format, single use, superseded, expiry 410, bad
  bodies, rate limit 429 and recovery, no key yet 503, codes/key never in status/events/logs;
  `/v1/status` — auth, whitelist, caps, loopback-only URLs, 400/413, staleness, events
  without content; the fake host's `--pairing-code-file` / `--status-file`) and
  `bookforge-main.test.js` (73 checks, real main.js under the mock-Electron harness:
  bridge-owned replies are not relayed, token never in state/log files, activity broadcasts,
  a full link-test run with its reports; v1.1: Connect turns the bridge on, BookForge not
  running -> instructions + "Start BookForge for me" really runs the launcher, Connect opens
  `#/pair?code=…&bridge=…` (mocked `shell.openExternal`, never the key), pair -> status ->
  "connected" in the snapshot, open-url refuses non-loopback URLs, a new key disconnects).
* `desktop-app/test/bookforge-link-test.test.js` (64 checks): the link test against the real
  bridge with fake panes — pass, wrong key accepted, pane not ready, timeout, bad JSON,
  BookForge not running, busy site, stop mid-run, reports contain no key/prompt, and the
  optional "BookForge is connected" step.
* `bookforge/tests/test_autoinjector_adapter.py` (Python adapter vs an in-process fake).
* `bookforge/tests/test_bridge_cross_process.py`: real Python BookForge -> real Node
  `bookforge-bridge.js` (via `fake-bridge-host.js`, three fake panes): connect-all-three,
  health, a creative operation end to end, roles routing, invalid-then-valid re-ask,
  timeout -> user decision with nothing saved, busy, wrong token.
* NOT tested: the live ChatGPT/Claude/Gemini websites (needs your logged-in sessions).

## Known limitations

* If a pane is still finishing an earlier reply when BookForge sends, that earlier reply
  can be captured as the answer. Let panes go idle before using the bridge.
* Replies the app drops before capture (rate-limit notices, a bare NONE, an empty
  envelope, an exact duplicate of the previous reply) end as 504 TIMEOUT rather than a
  specific error.
* A custom role set on a pane in AutoInjector is still prefixed to BookForge prompts.
* One-click Connect needs a BookForge that has the `#/pair` page and `POST /v1/pair` client;
  an older BookForge opens normally but never pairs (the panel then says "press Connect
  again" after 2 minutes — use Other ways -> Copy connection key).
* "Start BookForge for me" uses BookForge's own launcher, which also opens its own browser
  tab, so you may briefly see two BookForge tabs. On macOS/Linux it runs in the background
  (no terminal window); stop it from BookForge or with your system's tools.

## First real run (on your PC)

1. `git pull`, then start AutoInjector desktop (`desktop-app/run-windows.bat`) and log in
   to ChatGPT, Claude and Gemini in their panes. Turn routing/autopilot OFF.
2. Start BookForge (`bookforge/run-bookforge.bat`, port 8780) — or skip this and let step 3
   offer **▶ Start BookForge for me**.
3. In AutoInjector's **BookForge** panel press **🔗 Connect BookForge**. Your browser opens
   BookForge's pairing page; confirm there if it asks. The panel shows **Connected ✔** and
   "Now working on" / "Book checklist" fill in. (Fallback: **Other ways → 📋 Copy connection
   key**, paste it in BookForge Settings -> Connect AutoInjector.) Then press **🧪 Test the
   connection**: every Active AI should PASS.
4. Create a project, open B01 Premise, fill idea/goals and Create. Watch the Claude pane
   receive the prompt; BookForge should show a DRAFT premise. If it reports TIMEOUT or a
   JSON error, note which site and what the pane showed.
