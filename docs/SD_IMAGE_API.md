# Images for Akọwe — the local image contract (bridge routes)

AutoInjector can make a picture for another local program — first of all **Akọwe**
(character portraits, covers, scene illustrations, items B3/B5 of
`docs/AKOWE_IMPROVEMENT_PLAN.md`, and the **Character Forge**'s portrait, ten
full-body reference views and turnaround sheet). This is the contract.

There are **two image engines**:

| `engine` | Who draws | Notes |
|---|---|---|
| `"sd"` | **Stable Diffusion** — the SD app connected in 🎨 Images (Forge / A1111 / reForge / SD.Next / ComfyUI) | LoRAs, character locks, seeds, every advanced setting. |
| `"chatgpt"` | **ChatGPT's own image generation**, in the logged-in ChatGPT pane AutoInjector already drives (`desktop-app/chatgpt-image.js`) | Needs no GPU. One picture per request, 30–180 s each. Only the words of the request matter (no seeds / LoRAs). |
| `"auto"` (default) | Stable Diffusion when an SD app is connected, else ChatGPT when its pane is ready | Neither → `NO_IMAGE_ENGINE`. |

The routes live on AutoInjector's **service bridge** (`desktop-app/service-bridge.js`,
default `http://127.0.0.1:8765`, see `desktop-app/SERVICE_BRIDGE.md`): localhost only,
`Authorization: Bearer <token>` when the bridge has a token, browser pages from foreign
origins refused. Behind them is `sd-studio.js` — the same code as the 🎨 Images tab.

## `GET /image/backend`

Is an SD app connected — and can ChatGPT draw?

```json
{ "ok": true, "connected": true, "backend": "a1111", "label": "Forge",
  "base": "http://127.0.0.1:7860", "checkpoint": "dreamshaper_8.safetensors [879db523c3]", "busy": false,
  "engines": {
    "sd":      { "connected": true, "backend": "a1111", "label": "Forge", "base": "http://127.0.0.1:7860", "checkpoint": "…", "busy": false },
    "chatgpt": { "ready": false, "busy": false, "why": "ChatGPT looks signed out — open its window and log in" } } }
```

`backend` is `a1111` (Automatic1111 / Forge / reForge / SD.Next) or `comfy` (ComfyUI). The
top-level fields are the SD ones (unchanged); `engines.chatgpt.why` is there only when it isn't
ready (pane missing, still loading, logged out, no message box, a 🔢 teach running).

## `GET /image/locks`

The character locks the user made in 🎨 Images → 🔒 Character locks.

```json
{ "ok": true, "locks": [ {
  "id": "lock-mh3k2-ab12", "character": "Odile", "book": "The Lamplighter's Last Ferry",
  "loras": [ { "name": "odile_face", "weight": 0.75 } ],
  "triggerWords": [ "odile woman" ], "prompt": "short silver hair, green eyes, navy wool coat",
  "negative": "smiling", "checkpoint": "", "seed": 1234, "width": null, "height": null, "notes": "" } ] }
```

## `POST /image/request`

Make one or more pictures and save them in AutoInjector's `images/` folder.

Request body (all optional except a `prompt`, a `characterLock` or an `appearance`):

| Field | Meaning |
|---|---|
| `engine` | `"auto"` (default) · `"sd"` · `"chatgpt"` — see the table above. `sd` with no SD app → `SD_NOT_CONNECTED`; `chatgpt` with its pane not ready → `CHATGPT_NOT_READY`. |
| `purpose` | `portrait` · `cover` · `scene` · `illustration` · `free` (default) · **`view`** · **`sheet`**. Picks a size when none is given: portrait/cover tall (512×768 on SD 1.5, 832×1216 on SDXL-type models), scene/illustration wide, free = the Images-tab size. `view` = one full-body reference view (needs `view`; tall); `sheet` = ONE turnaround sheet holding all ten views (wide: 1024×512 / 1536×768 on SD — ChatGPT is usually better at sheets). |
| `view` | With `purpose:"view"`: `front` · `three_quarter_front` · `side` · `three_quarter_back` · `back` · `idle` · `draw` (reaching for a tool at the belt) · `attack` (empty-hand strike) · `dash` · `defend`. AutoInjector writes the framing itself, e.g. side = “full body, head to toe, standing, seen exactly from the side (profile), plain neutral light-grey studio background, even soft lighting, no text” (`desktop-app/image-views.js`). A `view` without `purpose` means `purpose:"view"`. |
| `appearance` | What the character looks like, in words — with or instead of a `characterLock`. |
| `prompt` | what to draw (the scene / pose / setting) |
| `characterLock` | a lock id **or** character name (any case). Its trigger words + fixed looks are put in front of `prompt`, its LoRAs added, its negative merged; its seed, checkpoint and size are used unless the request gives its own. |
| `keepSeed` | `false` = don't use the lock's seed (a new variation) |
| `negativePrompt` | added to the lock's negative |
| `loras` | extra `[{ "name": "ink_style", "weight": 0.5 }]` |
| `width`, `height`, `steps`, `cfgScale`, `seed`, `sampler`, `scheduler`, `checkpoint`, `vae` | override the Images-tab settings |
| `count` | 1–4 pictures in one go (SD; ChatGPT makes one per request and says so in `warnings`) |
| `newChat` | ChatGPT: start a fresh ChatGPT chat for this picture. By default every request goes into the **same** ChatGPT conversation, so ten views of one character stay consistent. |
| `series` | ChatGPT: a name for a view series. With the “new chat for each series” setting on (🎨 Images → Reference views, or `images.chatgptSettings`), a new series opens a new chat (once, not per view). Without a name, views of one lock / appearance count as one series. |
| `timeoutMs` | ChatGPT: how long to wait for the picture (default 240 000 = 240 s). |
| `book` | the book title, recorded with the picture |
| `from` | who asks (recorded as `bridge:<from>`, default `akowe`) |
| `returnImage` | `true` = also return each picture as base64 (otherwise only paths) |
| `hires`, `refiner`, `clipSkip`, `restoreFaces`, `tiling`, `styles`, `variation`, `initImage` + `denoise` (img2img), `mask` + `inpaint` (inpaint), `controlnet`, `adetailer`, `script`, `alwaysonScripts`, `overrideSettings`, `extra` | every advanced setting of `images.generate` — same names and shapes as the module API (`desktop-app/STABLE_DIFFUSION_PLAN.md` → "Module API" and the coverage table). Pictures (`initImage`, `mask`, ControlNet `image`) are a path to a picture file on the same PC (recommended: bridge bodies are limited to 1 MB), or small base64 / data: URLs. What the connected app can't do is refused with `UNSUPPORTED_ON_BACKEND` and a `hint`. |

Answer (200) — today's shape plus `engine` (the engine actually used), `view` (echoed for a
view) and `paths` (the saved files, in order):

```json
{ "ok": true, "engine": "sd", "purpose": "view", "view": "side", "backend": "a1111", "seed": 1234, "warnings": [],
  "paths": [ "…/stuff and thing/images/view-side-20261025-201500.png" ],
  "images": [ { "path": "…/stuff and thing/images/view-side-20261025-201500.png", "seed": 1234, "sha256": "…" } ],
  "settings": { "prompt": "odile woman, short silver hair, …, full body, head to toe, standing, seen exactly from the side (profile), …",
                "loras": [ … ], "width": 512, "height": 768, "engine": "sd", "view": "side",
                "characterLock": { "id": "lock-…", "character": "Odile", "book": "…" }, "from": "bridge:akowe", … } }
```

`images` stays a list of objects (`path`, `seed`, `sha256`, and `imageBase64` when
`returnImage` is true); `paths` is the same files as plain strings. With `engine:"chatgpt"`
`seed` is `null`, `backend` is `"chatgpt"`, and each image also has `width` / `height`.

**Keeping one character across a series of views (SD):** the lock's seed is used for every
view; without a lock, pass the `seed` the first view returned to the next nine (with
`keepSeed:false` when a lock has its own seed you want to override).
**ChatGPT:** send the ten views one after another; they go into the same ChatGPT chat, which
keeps the character consistent (or ask for one `sheet`).

`warnings` lists base-model mismatches (e.g. an SD 1.5 LoRA on an SDXL checkpoint) — the
picture is still made — and, for ChatGPT, the SD-only settings it ignored. Each picture has a
`.json` sidecar (SD PNGs also carry their settings inside), so it can be remade exactly; it is
also recorded as a project image in AutoInjector's database. ChatGPT pictures are fetched from
the page with ChatGPT's own session, checked to be a real PNG/JPEG (WebP / AVIF are converted to
PNG) and saved as `chatgpt-…png`, `view-<view>-…png`, `sheet-…png`, `portrait-…png` (a JPEG
keeps its bytes as `.jpg`); the sidecar records `engine:"chatgpt"`, the exact request typed
(`chatgptPrompt`), the size and how long it took.

Errors (always `{ ok:false, error, message }`, `message` is plain English for the user):

| Status | `error` | When |
|---|---|---|
| 400 | `NEED_PROMPT` | neither `prompt` nor `characterLock` |
| 400 | `NO_LOCK` | no character lock with that id/name |
| 400 | `INVALID_PARAM`, `UNKNOWN_VALUE`, `UNKNOWN_FIELD`, `BAD_TYPE`, `BAD_VALUE`, `UNKNOWN_OPTION`, `UNSUPPORTED_ON_BACKEND` | an advanced setting is wrong or not available on the connected app — `field` names it, `hint` says what would work (e.g. the real model names) |
| 400 | `INVALID_PARAM` with `field: "engine" \| "purpose" \| "view"` | an unknown engine / purpose, or `purpose:"view"` without one of the ten views (`hint` lists them) |
| 503 | `SD_NOT_CONNECTED` | `engine:"sd"` but no SD app is connected |
| 503 | `CHATGPT_NOT_READY` | `engine:"chatgpt"` but the ChatGPT pane is missing, still loading, logged out or has no message box (also when ChatGPT logs out mid-picture) |
| 503 | `NO_IMAGE_ENGINE` | `engine:"auto"` and neither engine is available (`message` says why each one isn't) |
| 503 | `NO_ENDPOINT` / `IMAGE_DISABLED` | the SD app went away between the check and the picture |
| 422 | `IMAGE_REFUSED` | ChatGPT declined — `message` holds its first sentence (“I can't create that image because …”); also when it answered only in words, with no picture |
| 429 | `IMAGE_LIMIT` | ChatGPT's usage / image cap is reached (“You've reached your image creation limit …”) |
| 504 | `IMAGE_TIMEOUT` | ChatGPT didn't finish a picture within the time limit (default 240 s) |
| 502 | `IMAGE_FETCH_FAILED` | ChatGPT made it, but the bytes couldn't be taken from the page or weren't a real picture |
| 502 | `REFUSED`, `TIMEOUT`, `NO_API`, `HTTP_500`, `COMFY_REJECTED`, `CANCELLED`, … | the SD app failed — `message` says what to do |
| 501 | `IMAGE_NOT_WIRED` | this AutoInjector build has no image module |

Every error has `ok:false`, `error` (the code), a plain-English `message` and, for the new
codes, a `hint` (what to do). `engine` says which engine failed when one was chosen.

**Timing.** A ChatGPT picture takes 30–180 s and the request stays synchronous: callers use a
client timeout of at least **300 s** (Akọwe runs these in a background job). The bridge server
itself has no request timeout (`requestTimeout = 0`), so a long request is never cut off.
ChatGPT requests run **one at a time** (a queue); while one runs, AutoInjector holds the
ChatGPT pane: other messages for ChatGPT (relays, Akọwe prompts) wait until the picture is in,
no self-repair check-in starts, and the image turn is never relayed or shown in the
conversation. Progress is broadcast as `image` events on the bridge's `/events` stream
(`{type:"request", engine, purpose, view}` … `{type:"done", ok, engine, error?}`).

### What can't be checked without the real ChatGPT site

The ChatGPT engine reads the page: the newest assistant turn
(`[data-message-author-role="assistant"]` / `article[data-turn="assistant"]`) and the finished
`<img>` in it — loaded, at least 200 px, not blurred (ChatGPT shows blurred previews while it
draws), not an avatar / icon, not one that was already on the page. These selectors
(`selectors.js` → `IMAGE_CANDIDATES`) are best-effort. If ChatGPT changes its page and pictures
stop being picked up (`IMAGE_TIMEOUT` while a picture is plainly in the pane), open ChatGPT's
🎯 card, choose **Generated picture**, press OK and click the picture: the saved selector is
tried first from then on.

Example:

```bash
curl -s -X POST http://127.0.0.1:8765/image/request \
  -H "Authorization: Bearer $AUTOINJECTOR_BRIDGE_TOKEN" -H "Content-Type: application/json" \
  -d '{"purpose":"portrait","characterLock":"Odile","prompt":"reading a letter by lamplight","book":"The Lamplighter'"'"'s Last Ferry"}'
```

Inside AutoInjector, the 🎨 Images tab has the same: **Engine** (Stable Diffusion / ChatGPT /
Auto) and **Reference views** (a character lock or a typed appearance → Portrait, any of the ten
views, All 10 views as one series, or a Turnaround sheet; “ChatGPT is drawing… 45 s” while it
works; failures in the same red box as SD errors). Alfred reaches it through `generate_image`
(`engine`, `purpose`, `view`, `appearance`) and `sd_call` (`images.generate` with the same
fields, `images.chatgptStatus`, `images.chatgptCancel`, `images.chatgptSettings`).

Inside AutoInjector's own main process, the same things — and much more: options get/set,
img2img / inpaint / upscale, ControlNet / ADetailer / styles / scripts lists, ComfyUI workflows,
and `capabilities()` (a machine-readable list of every operation + parameter schema for the
connected app) — are available without HTTP through `require('./sd-api').get()` — see
`desktop-app/STABLE_DIFFUSION_PLAN.md` ("Module API" and "Coverage").
