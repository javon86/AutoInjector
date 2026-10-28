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
| `GET /interpreter/status` | — | Open Interpreter capability status |
| `POST /interpreter/settings` | `{endpoint, model, enabled, autoRun}` | configure Open Interpreter |
| `POST /interpreter/run` | `{task}` | run a coding/computer task; streams `interpreter` events |
| `GET /jarvis/status` | — | the native Jarvis supervisor state (`{manager:{…}}`) |
| `POST /jarvis/start` | `{goal}` | give Jarvis a goal; it plans, delegates to the Council, and runs code to reach it |
| `POST /jarvis/stop` | — | stop the current Jarvis task |
| `GET /image/status` · `POST /image/settings` · `POST /image/generate` | `{prompt, negativePrompt}` | Stable Diffusion: status / settings / a plain render (outcome only, no image bytes) |
| `GET /image/backend` | — | 🎨 which SD app is connected (`{connected, backend, label, base, checkpoint, busy}`) and both engines: `engines: {sd: {…}, chatgpt: {ready, busy, why?}}` |
| `GET /image/locks` | — | 🎨 the character locks (`{locks:[…]}`) |
| `POST /image/request` | `{engine, purpose, view, prompt, characterLock, appearance, …}` | 🎨 make + save a picture (portrait / cover / scene / one of ten reference views / a turnaround sheet) with Stable Diffusion or ChatGPT's own image generation (`engine`: auto / sd / chatgpt) → `{engine, view?, paths, images:[{path, seed, sha256}], settings, warnings}`. ChatGPT takes 30–180 s: use a ≥300 s client timeout — full contract: [`docs/SD_IMAGE_API.md`](../docs/SD_IMAGE_API.md) |
| `GET /video/backend` | — | 🎬 is video set up: `{ready, backend: "comfy-wan"\|"endpoint"\|"", message, busy, comfy: {connected, base, …}, endpoint: {configured, enabled}, installed: [model ids], defaultModel, models: [{id, installed, modes, vramGB}]}` |
| `POST /video/request` | `{prompt, negativePrompt, image?, seconds\|frames, fps, width, height, model, steps, cfgScale, seed, sampler, scheduler, shift, characterLock, purpose, from, book, returnPoster}` | 🎬 make + save a video: with `image` (a local path, or base64 / a `data:` URL; the body may be up to 40 MB) it animates the picture (picture→video), else text→video. Wan on the ComfyUI AutoInjector runs (or the old video endpoint). → `{engine, model, path (.mp4 or .webm), poster (.png), seconds, frames, fps, width, height, seed, warnings}`; `returnPoster:true` adds `posterBase64` (raw base64). Takes minutes: the server never times this request out — use a long client timeout. Errors: 400 `INVALID_PARAM` / `NO_LOCK` / `UNSUPPORTED_ON_BACKEND`, 503 `VIDEO_NOT_SET_UP` / `VIDEO_MODEL_MISSING` (+ `model`) / `BUSY`, 504 `VIDEO_TIMEOUT`, 507 `VIDEO_OOM`, 409 `VIDEO_CANCELLED`, 502 `VIDEO_FAILED` — each with `message` + `fix`. Full contract: [`docs/VIDEO_API.md`](../docs/VIDEO_API.md) |
| `POST /render/image` | `{svg\|html, width, height, format: "jpeg"\|"png", quality?, background?, timeoutMs?}` | 🖨 draws an SVG (or a small self-contained HTML page) at exactly width × height (16–4096 px each) in an offscreen, sandboxed Chromium page with JavaScript off and **no network** (only the page itself and `data:` URIs load) → `{format, mime, width, height, bytes, imageBase64}`. SVG/HTML up to 30 MB (JSON body up to 40 MB), one render at a time, time limit 20 s (≤ 60 s). Errors: 400 `INVALID_PARAM`, 504 `RENDER_TIMEOUT`, 502 `RENDER_FAILED`. Akọwe uses it for the ebook cover JPG and the Word copy of the map (`render-image.js`) |
| `POST /dialog/choose-path` | `{kind: "book", title?}` | 📂 a folder picker in AutoInjector's window → `{path}` or `{cancelled: true}` (Akọwe opens a big saved book from its folder; only the chosen path comes back) |
| `GET /events` | — | **SSE** live event stream (see below) |

**Jarvis** is AutoInjector's own supervisor (the System AI): given a goal it
plans, delegates writing/research to the Council (chatgpt/claude/gemini), and
uses the `RUN_CODE` action to run code / operate the computer through Open
Interpreter — all with a critic/verify gate. It needs a local supervisor model
configured (System AI panel) to think, and Open Interpreter configured for the
code arm. SSE events: `jarvis` (supervisor state) and `jarvis-log`.

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
