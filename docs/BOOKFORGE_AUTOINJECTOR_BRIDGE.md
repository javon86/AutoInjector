# BookForge ⇄ AutoInjector bridge (contract v1)

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
* Every request needs `Authorization: Bearer <token>`. In both apps' UIs the token is
  called the **connection key** ("like a password that lets only your BookForge talk to
  this app; it never leaves your computer"). The token is a random
  >=24-byte URL-safe string generated on first enable, stored in the app's userData
  directory (`bookforge-bridge-token`, mode 0600), shown/copyable in the desktop app's
  controls UI, and replaceable there ("Make a new key"). Compare in constant time.
* Bridge disabled -> server not listening (connection refused).
* Reject request bodies over 1 MiB (413). Reject non-JSON (400).
* Never log prompt or reply text; log only site, request_id, chars, outcome, elapsed.
* Never put the token in URLs or logs.

## Endpoints

### `GET /v1/health`
`200 {"ok": true, "bridge_version": "1", "sites": {"chatgpt": {"ready": bool, "busy": bool},
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
2. The bridge sends the prompt to that site's pane through the existing send path,
   wrapped with the app's reply-envelope instruction so the reply ends with
   `[FROM: <SITE>]`, and waits for the NEXT captured reply from that site.
3. A captured reply that belongs to a bridge request is **owned by the bridge**: it
   is shown in the transcript but is NOT relayed to other AIs (no mesh routing,
   roundtable, house-rule, sequence or manager handling).
4. Success: `200 {"ok": true, "site", "request_id", "text": "<envelope-stripped reply>",
   "seq": "0007", "elapsed_ms": 1234}`.
5. Idempotency: results are cached by `request_id` for 15 minutes. Repeating a
   completed `request_id` returns the cached 200 response without re-sending. Repeating
   an in-flight `request_id` waits for (joins) the same in-flight result.
6. Errors (JSON `{"ok": false, "error": CODE, "message": "...", "ambiguous": bool}`):

| HTTP | error | meaning | ambiguous |
|---|---|---|---|
| 400 | BAD_REQUEST | invalid body/field | false |
| 401 | UNAUTHORIZED | missing/wrong token | false |
| 404 | UNKNOWN_SITE / NOT_FOUND | bad site / path | false |
| 409 | SITE_BUSY | another bridge request in flight for that site | false |
| 413 | TOO_LARGE | body over 1 MiB | false |
| 502 | SEND_FAILED | the prompt could not be delivered to the pane | false |
| 503 | SITE_NOT_READY | pane missing/destroyed/not loaded | false |
| 504 | TIMEOUT | sent, but no captured reply before timeout_ms | **true** |

On 504 the site may still be answering; the site stays `busy` until that reply is
captured (it is then stored under the request_id, so a later retry with the same
request_id returns it) or for at most timeout_ms more, then frees.

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
* **🧪 Test BookForge link** (bookforge-link-test.js): bridge listening; key file present;
  wrong key -> 401; right key -> `/v1/health` 200; per Active AI: pane ready, then a real
  `POST /v1/complete` with a JSON_SCHEMA prompt whose reply must be one JSON object echoing
  a random word; then `GET http://127.0.0.1:8780/api/ping` (`{"app":"bookforge",...}`;
  SKIPPED with instructions when unreachable). Reports: `<logs>/bookforge-link-test-<stamp>.md`
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

* `desktop-app/test/bookforge-bridge.test.js` (110 checks, incl. activity/last-contact with
  no text leakage) and `bookforge-main.test.js` (48 checks, real main.js under the
  mock-Electron harness: bridge-owned replies are not relayed, token never in state/log
  files, activity broadcasts, a full link-test run with its reports).
* `desktop-app/test/bookforge-link-test.test.js` (59 checks): the link test against the real
  bridge with fake panes — pass, wrong key accepted, pane not ready, timeout, bad JSON,
  BookForge not running, busy site, stop mid-run, reports contain no key/prompt.
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

## First real run (on your PC)

1. `git pull`, then start AutoInjector desktop (`desktop-app/run-windows.bat`) and log in
   to ChatGPT, Claude and Gemini in their panes. Turn routing/autopilot OFF.
2. In AutoInjector controls, open **BookForge bridge (experimental)**, tick **Turn the
   bridge on**, click **📋 Copy connection key**, then **🧪 Test BookForge link** (every
   Active AI should PASS; "BookForge is running?" is SKIPPED until step 3).
3. Start BookForge (`bookforge/run-bookforge.bat`, now on port 8780). Settings ->
   **Connect AutoInjector (all three)**, paste the connection key, then **Test connection**
   on each slot: all three should say Ready. The AutoInjector panel's step 4 ticks and the
   status turns to "BookForge is connected".
4. Create a project, open B01 Premise, fill idea/goals and Create. Watch the Claude pane
   receive the prompt; BookForge should show a DRAFT premise. If it reports TIMEOUT or a
   JSON error, note which site and what the pane showed.
