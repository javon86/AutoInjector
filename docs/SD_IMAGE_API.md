# Images for Akọwe — the local image contract (bridge routes)

AutoInjector can make a picture for another local program — first of all **Akọwe**
(character portraits, covers, scene illustrations, items B3/B5 of
`docs/AKOWE_IMPROVEMENT_PLAN.md`). This is the contract; Akọwe's UI for it is not
built yet.

The routes live on AutoInjector's **service bridge** (`desktop-app/service-bridge.js`,
default `http://127.0.0.1:8765`, see `desktop-app/SERVICE_BRIDGE.md`): localhost only,
`Authorization: Bearer <token>` when the bridge has a token, browser pages from foreign
origins refused. Behind them is `sd-studio.js` — the same code as the 🎨 Images tab.

## `GET /image/backend`

Is an SD app connected?

```json
{ "ok": true, "connected": true, "backend": "a1111", "label": "Forge",
  "base": "http://127.0.0.1:7860", "checkpoint": "dreamshaper_8.safetensors [879db523c3]", "busy": false }
```

`backend` is `a1111` (Automatic1111 / Forge / reForge / SD.Next) or `comfy` (ComfyUI).

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

Request body (all optional except a `prompt` or a `characterLock`):

| Field | Meaning |
|---|---|
| `purpose` | `portrait` · `cover` · `scene` · `illustration` · `free` (default). Picks a size when none is given: portrait/cover tall (512×768 on SD 1.5, 832×1216 on SDXL-type models), scene/illustration wide, free = the Images-tab size. |
| `prompt` | what to draw (the scene / pose / setting) |
| `characterLock` | a lock id **or** character name (any case). Its trigger words + fixed looks are put in front of `prompt`, its LoRAs added, its negative merged; its seed, checkpoint and size are used unless the request gives its own. |
| `keepSeed` | `false` = don't use the lock's seed (a new variation) |
| `negativePrompt` | added to the lock's negative |
| `loras` | extra `[{ "name": "ink_style", "weight": 0.5 }]` |
| `width`, `height`, `steps`, `cfgScale`, `seed`, `sampler`, `scheduler`, `checkpoint`, `vae` | override the Images-tab settings |
| `count` | 1–4 pictures in one go |
| `book` | the book title, recorded with the picture |
| `from` | who asks (recorded as `bridge:<from>`, default `akowe`) |
| `returnImage` | `true` = also return each picture as base64 (otherwise only paths) |

Answer (200):

```json
{ "ok": true, "purpose": "portrait", "backend": "a1111", "seed": 1234, "warnings": [],
  "images": [ { "path": "…/stuff and thing/images/portrait-20261025-201500.png", "seed": 1234, "sha256": "…" } ],
  "settings": { "prompt": "odile woman, short silver hair, …, reading a letter", "loras": [ … ], "width": 512, "height": 768,
                "characterLock": { "id": "lock-…", "character": "Odile", "book": "…" }, "from": "bridge:akowe", … } }
```

`warnings` lists base-model mismatches (e.g. an SD 1.5 LoRA on an SDXL checkpoint) — the
picture is still made. Each PNG has its settings embedded and a `.json` sidecar, so it can be
remade exactly; it is also recorded as a project image in AutoInjector's database.

Errors (always `{ ok:false, error, message }`, `message` is plain English for the user):

| Status | `error` | When |
|---|---|---|
| 400 | `NEED_PROMPT` | neither `prompt` nor `characterLock` |
| 400 | `NO_LOCK` | no character lock with that id/name |
| 503 | `NO_ENDPOINT` / `IMAGE_DISABLED` | no SD app connected yet |
| 502 | `REFUSED`, `TIMEOUT`, `NO_API`, `HTTP_500`, `COMFY_REJECTED`, `CANCELLED`, … | the SD app failed — `message` says what to do |
| 501 | `IMAGE_NOT_WIRED` | this AutoInjector build has no image module |

A request can take minutes (the first picture after a start loads the model): use a long
client timeout. Progress is broadcast as `image` events on the bridge's `/events` stream
(`{type:"request"}` … `{type:"done", ok}`).

Example:

```bash
curl -s -X POST http://127.0.0.1:8765/image/request \
  -H "Authorization: Bearer $AUTOINJECTOR_BRIDGE_TOKEN" -H "Content-Type: application/json" \
  -d '{"purpose":"portrait","characterLock":"Odile","prompt":"reading a letter by lamplight","book":"The Lamplighter'"'"'s Last Ferry"}'
```

Inside AutoInjector's own main process, the same things are available without HTTP through
`require('./sd-api').get()` — see `desktop-app/STABLE_DIFFUSION_PLAN.md` ("Module API").
