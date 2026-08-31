# AutoInjector Service Bridge

AutoInjector can run as a **separately callable local service**. While the
Electron app is running, a small HTTP + Server-Sent-Events server exposes the
relay — participant status, message sending, captured responses, generation
state, Council control, errors and rate limits — so another local program (e.g.
PersonalJarvis) can drive it without touching its internals.

The bridge is a thin transport adapter (`service-bridge.js`). It owns no relay
logic: the browser panes, selectors, `sendTextTo`/`pollSite` routing, sessions,
retry, rate-limit detection, the message ledger and the Council/roundtable engine
all remain exactly as they are in `main.js`. The bridge only wraps them.

## Configuration (environment variables)

| Var | Default | Meaning |
| --- | --- | --- |
| `AUTOINJECTOR_BRIDGE` | on | Set to `0` to disable the bridge entirely. |
| `AUTOINJECTOR_BRIDGE_HOST` | `127.0.0.1` | Bind host. **Localhost-only by default** — do not expose publicly. |
| `AUTOINJECTOR_BRIDGE_PORT` | `8765` | TCP port. |
| `AUTOINJECTOR_BRIDGE_TOKEN` | _(none)_ | If set, every request needs `Authorization: Bearer <token>` (or `?token=` for the SSE stream). |

If the port is busy the app logs the failure and keeps running normally (the
bridge just doesn't come up) — it never crashes the app.

## HTTP API

All responses are JSON with an `ok` boolean. Participant ids are `chatgpt`,
`claude`, `gemini`.

| Method & path | Body | Returns |
| --- | --- | --- |
| `GET /health` | — | `{ ok, service, version }` |
| `GET /status` | — | `{ ok, participants:[…], council, routing, mesh }` |
| `GET /participants` | — | `{ ok, participants:[…] }` |
| `GET /responses?since=&limit=&site=` | — | `{ ok, responses:[…] }` — captured replies (newest last) |
| `POST /participants/:site/send` | `{ text }` | send to one participant |
| `POST /send` | `{ text, targets? }` | send to all enabled participants (or the given `targets`) |
| `POST /council/start` | `{ mode, topic, rounds? }` | start a Council/roundtable run |
| `POST /council/stop` | — | stop the current run |
| `GET /events` | — | **SSE** live event stream (see below) |

A **participant** entry: `{ id, label, enabled, ready, generating, waiting,
lastResponseId, rateLimited }`. `generating` is the live "is this AI still
producing a reply" signal (its Stop button is showing); `ready` means the pane is
loaded and responsive.

A **response** entry: `{ id, site, label, text, ts, roundtableTag, isRateLimited,
isVerdict }`. The envelope tags (`[TO:]`/`[FROM:]`) are already stripped from
`text`. Poll with `?since=<lastId>` to get only what's new.

**Council `mode`** is one of: `debate`, `devil-angel`, `chargeback`,
`who-wants-to-speak`, `free-for-all`, `brainstorm`, `rotation`, `blind-round`.
`topic` is required; `rounds` is required for `chargeback`.

## Event stream (`GET /events`, SSE)

Each event is `event: <type>` + `data: <json>`. Types:

| Event | Payload | Fires when |
| --- | --- | --- |
| `hello` | `{ service, version }` | on connect |
| `response` | a response entry | a participant's reply is captured (complete) |
| `generation` | `{ site, generating }` | a participant starts/stops producing a reply |
| `sent` | `{ target, from, … }` | a message is delivered to a participant |
| `status` | `{ site, waiting }` | a participant's waiting state changes |
| `council` | Council snapshot | the Council/roundtable state changes |
| `error` | `{ site?, error, kind? }` | a send fails, or an internal error is logged |
| `rate-limit` | a response entry | a participant returns a rate-limit/usage-cap notice |

## Examples

```bash
# status
curl -s http://127.0.0.1:8765/status

# send to one participant (token-protected instance)
curl -s -X POST http://127.0.0.1:8765/participants/claude/send \
  -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
  -d '{"text":"Summarize the last message."}'

# broadcast to everyone
curl -s -X POST http://127.0.0.1:8765/send \
  -H 'Content-Type: application/json' -d '{"text":"Round-table: best next step?"}'

# start a debate, then stream events
curl -s -X POST http://127.0.0.1:8765/council/start \
  -H 'Content-Type: application/json' -d '{"mode":"debate","topic":"X vs Y","rounds":2}'
curl -sN http://127.0.0.1:8765/events
```

```js
// A consumer streaming responses (Node / browser EventSource)
const es = new EventSource('http://127.0.0.1:8765/events'); // add ?token=… if set
es.addEventListener('response', (e) => console.log('reply:', JSON.parse(e.data)));
es.addEventListener('generation', (e) => console.log('gen:', JSON.parse(e.data)));
```

> Not yet merged into PersonalJarvis — this only makes AutoInjector *callable*.
> The consumer side lives in whatever program talks to this API.
