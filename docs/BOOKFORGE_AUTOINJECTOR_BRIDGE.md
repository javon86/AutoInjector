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
  (env `AUTOINJECTOR_BRIDGE_PORT` overrides). JSON bodies, UTF-8.
* Every request needs `Authorization: Bearer <token>`. The token is a random
  >=24-byte URL-safe string generated on first enable, stored in the app's userData
  directory (`bookforge-bridge-token`, mode 0600), shown/copyable in the desktop app's
  controls UI, and regenerable there. Compare in constant time.
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
