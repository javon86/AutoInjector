# 🎬 Video — the local video engine and its contract

AutoInjector makes short videos **on the same ComfyUI it already installs, starts and
connects for 🎨 Images**, with Wan models built from **core ComfyUI nodes only** (no custom
nodes). Text→video and picture→video. The model downloads inside the app, the engine finds
ComfyUI by itself, and 🎩 Alfred, Akọwe and the butler can drive all of it.

The old generic "POST a prompt to some URL" setting (`desktop-app/video-provider.js`) stays as
a fallback backend called **`endpoint`** (🎬 Video → Setup → *Advanced: other video server*).

| File (`desktop-app/`) | What it is |
|---|---|
| `video-studio.js` | The engine (Electron-free): params, the Wan graph, upload, queue, progress, cancel, save, gallery, both backends |
| `video-installer.js` | The model catalog + downloads into ComfyUI's model folders (reuses `sd-installer.js`) |
| `video-errors.js` | ComfyUI's answers → the contract's error codes, one plain sentence + a fix |
| `video-api.js` | The module API (`capabilities()`, `call()`, `video.*`) — shaped like `sd-api.js` |
| `videos-studio.js` | The 🎬 Video tab in the control panel |
| `service-bridge.js` | `GET /video/backend`, `POST /video/request` |

---

## 1. Research: running Wan with core ComfyUI nodes

Checked 2026-10-27. Sources:

* ComfyUI's own workflow templates (what the "Templates" menu loads):
  * Wan 2.2 TI2V 5B — <https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_wan2_2_5B_ti2v.json>
  * Wan 2.1 T2V 1.3B — <https://github.com/Comfy-Org/workflow_templates/blob/main/templates/text_to_video_wan.json>
* ComfyUI's core video nodes — <https://github.com/comfyanonymous/ComfyUI/blob/master/comfy_extras/nodes_video.py> (`CreateVideo`, `SaveVideo`, `SaveWEBM`)
* The repackaged model files — <https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged> and <https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged> (file list and byte sizes read from the Hugging Face Hub API)
* Stability Matrix's ComfyUI folder mapping — <https://github.com/LykosAI/StabilityMatrix/blob/main/StabilityMatrix.Core/Models/Packages/ComfyUI.cs>
* ComfyUI's model folder keys (`diffusion_models` also reads `unet`, `text_encoders` also reads `clip`) — `extra_model_paths.yaml.example` in ComfyUI

### The graph (both templates, same shape)

```
UNETLoader(unet_name, weight_dtype "default") ─► ModelSamplingSD3(shift 8) ─► KSampler.model
CLIPLoader(clip_name umt5…, type "wan", device "default") ─► CLIPTextEncode(+) ─► KSampler.positive
                                                         └► CLIPTextEncode(−) ─► KSampler.negative
VAELoader(vae_name) ─► latent node (5B) ─► KSampler.latent_image
                   └──────────────────────────► VAEDecode.vae
latent:  Wan 2.2 5B:  Wan22ImageToVideoLatent(vae, width, height, length, batch_size 1, start_image? ◄ LoadImage)
         Wan 2.1 1.3B: EmptyHunyuanLatentVideo(width, height, length, batch_size 1)
KSampler(seed, steps, cfg, sampler "uni_pc", scheduler "simple", denoise 1) ─► VAEDecode
VAEDecode ─► CreateVideo(fps) ─► SaveVideo(filename_prefix "video/…", format "auto", codec "auto")   → .mp4 (h264)
```

`Wan22ImageToVideoLatent` does both: without `start_image` it is text→video, with it
picture→video. In the template the `LoadImage` node is simply bypassed for text→video.

AutoInjector adds a **poster** branch: `VAEDecode ─► ImageFromBatch(batch_index 0, length 1) ─► SaveImage`
(both core nodes) — the first frame as a `.png`.

**Saving:** `CreateVideo` + `SaveVideo` are core nodes in current ComfyUI and write `.mp4`
(`format auto` → mp4 / h264). On a ComfyUI without them the engine uses the older core
`SaveWEBM` (`codec vp9`, `fps`, `crf 32`) → `.webm`. If a ComfyUI rejects `SaveVideo`'s inputs
(its `format` became a "dynamic combo" with nested codec options in late-2025 builds), the
engine retries once with `SaveWEBM` and says so in `warnings`. A ComfyUI that has neither, or
lacks the Wan nodes, gets `VIDEO_FAILED` with cause `NODE_MISSING` and "update ComfyUI".
History lists the saved clip under the save node's `images` key (with `animated: [true]`);
the engine also reads `videos` / `gifs` keys.

### Models

| id | Mode | Files (folder → name) | Bytes (exact, from Hugging Face) | Graphics memory |
|---|---|---|---|---|
| **`wan22-ti2v-5b`** (default) | text→video + picture→video | `diffusion_models/wan2.2_ti2v_5B_fp16.safetensors` | 9 999 658 848 | about 12 GB at 1280×704 (8 GB works with ComfyUI's offloading at 832×480, slowly) |
| | | `text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors` | 6 735 906 897 | |
| | | `vae/wan2.2_vae.safetensors` | 1 409 400 960 | |
| | | **total** | **18 144 966 705 (16.9 GB)** | |
| **`wan21-t2v-1.3b`** | text→video only | `diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors` | 2 838 303 560 | about 8 GB at 832×480 |
| | | `text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors` (shared) | 6 735 906 897 | |
| | | `vae/wan_2.1_vae.safetensors` | 253 815 318 | |
| | | **total** | **9 828 025 775 (9.2 GB)** | |

Download URLs (`…/resolve/main/split_files/<folder>/<name>`):

* `https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors`
* `https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors`
* `https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors`
* `https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors`
* `https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors`

The text encoder is the same file in both repos; it is downloaded once (the 2.2 repo's copy).
The paths and sizes were confirmed against the Hub's file listing (the build sandbox could not
send HEAD requests to huggingface.co itself; the download code checks every size again).

### Defaults (ComfyUI's templates) and limits

| | Wan 2.2 TI2V 5B | Wan 2.1 T2V 1.3B |
|---|---|---|
| size | 1280×704 (×32 grid, 256–1280 per side) | 832×480 (×16 grid, 256–1024) |
| fps | 24 | 16 |
| frames | 121 (5 s); 4n+1, at most 121 | 33 (2 s); 4n+1, at most 81 (5 s) |
| steps · cfg | 20 · 5 | 30 · 6 |
| sampler · scheduler · shift | uni_pc · simple · 8 | uni_pc · simple · 8 |

`seconds` → `frames = 4·round(seconds·fps / 4) + 1` (4 s at 24 fps = 97 frames). Purpose
`clip` → 4 s, `trailer_shot` → 5 s 16:9. For picture→video without a size the picture's shape
is kept inside the model's pixel budget (a 832×1216 portrait → 800×1152 on the 5B grid).

---

## 2. Install (inside the app)

🎬 Video → **⚙ Setup & models**:

* **⬇ Install ComfyUI + video model** — when this PC has no ComfyUI, the official ComfyUI
  portable (Windows; `sd-installer.js`, the same as 🎨 Images → Start & install), then the model.
* **⬇ Download** per model — into the ComfyUI that will run it:
  * AutoInjector's ComfyUI portable → `ComfyUI/models/diffusion_models|text_encoders|vae`;
  * a **Stability Matrix** ComfyUI → Stability Matrix's shared `Data/Models` with its own
    folder names: `DiffusionModels`, `TextEncoders` (ComfyUI reads it as `clip`), `VAE`
    (found the way the image library finds Stability Matrix);
  * `AUTOINJECTOR_VIDEO_MODEL_DIRS` adds more ComfyUI models folders.
  Resumable (`.part` + HTTP Range), cancellable (⏸ — continues where it stopped), every file's
  size checked before it is renamed into place, a free-space check first, never overwrites a
  different file.
* **Status** says what is missing: ComfyUI found or not, running or not, too old (missing
  nodes), each model's missing files. A model whose files the running ComfyUI lists counts as
  installed even when its folder is unknown.
* **▶ Start ComfyUI** — the installed ComfyUI (sd-runner.js). Making a video also starts it by
  itself when nothing answers and AutoInjector isn't already running another SD app.

The engine finds ComfyUI in this order: the address in 🎬 Video → Settings, the ComfyUI 🎨
Images is connected to, the one AutoInjector started, whatever answers on `:8188`.

The **Setup Wizard** catalog (`wizard:catalog` → `installers.video`) and the **🧪 capability
test** know video: the "Video generation" step says exactly what is missing (⚪), and when video
is set up it really renders a 1-second test clip (the smallest installed model, half size,
8 steps) and reports ✅ / ❌.

---

## 3. The module API (`video-api.js`)

```js
const videoApi = require('./video-api').get();   // registered by main.js; null before
await videoApi.capabilities();
await videoApi.call('video.animate', { image: 'C:/book/odile.png', seconds: 4, purpose: 'clip' });
await videoApi.video.generate({ prompt: 'fog rolls over the harbour at dawn' });
```

Exports `{ createVideoApi, register, get, operationNames, OPS }`. Every method resolves
(never throws) with `{ ok, … }`.

| Method | changes | What |
|---|---|---|
| `capabilities()` / `video.capabilities` | no | `{ok, ready, backend, message, installed, defaultModel, models:[{id, label, modes, vramGB, bytes, defaults, limits, installed}], errors, operations:[{name, description, params (JSON schema), args, changes, available, hint, code?}]}` |
| `call(name, params)` | — | dispatch with one params object; unknown keys → `INVALID_PARAM` (+ suggestion); required keys checked |
| `video.status` | no | ready? backend? ComfyUI (base, missing nodes, mp4/webm), endpoint, models installed/missing, busy job, settings, download state, last result |
| `video.models` | no | the catalog with each file's state, the models roots, where downloads go, free space |
| `video.progress` | no | `{busy, mode, model, phase (starting/uploading/queued/sampling/decoding/saving), seconds, step, steps, pct}` |
| `video.gallery({limit})` | no | recent videos (newest first) with `poster`, `url`, the sidecar `record` |
| `video.cancel` | yes | stop the video being made (ComfyUI `/interrupt` + removed from the queue) |
| `video.generate(params)` | yes | text→video |
| `video.animate(params)` | yes | picture→video (`image` required; Wan 2.2 5B) |
| `video.test` | yes | a 1-second test clip |
| `video.settings({backend, model, comfyUrl, timeoutMs})` | yes | `backend`: `auto` (default: Wan when ready, else the endpoint) / `comfy-wan` / `endpoint` |
| `video.install.check` | no | = `video.models` |
| `video.install.downloadModel({id})` | yes | download one model |
| `video.install.installAll({id})` | yes | ComfyUI (if none) + the model |
| `video.install.cancel` | yes | pause / cancel the download |
| `trailer.make(params)` | yes | 🎞 a book trailer (section 7): shots rendered one by one, joined with title cards → `trailer.webm` (+ `.mp4`) |
| `trailer.status({id})` | no | the trailer being made (phase, shot n of m, each part's state) or the last result |
| `trailer.cancel` | yes | stop the trailer (finished shots are kept for next time) |
| `trailer.list({book})` | no | the saved trailers |
| `trailer.plan({book})` | no | a book's saved trailer plan (to edit and make again) |

`available:false` operations carry `hint` and `code` (`VIDEO_NOT_SET_UP`, or
`UNSUPPORTED_ON_BACKEND` for `video.animate` on the endpoint backend).

### `video.generate` / `video.animate` params

| Param | Type | Notes |
|---|---|---|
| `prompt` | string | what happens (animate: optional — a gentle idle-motion prompt is used) |
| `negativePrompt` | string | default: a sensible Wan negative |
| `image` | string | animate: a file path (PNG / JPEG / WEBP, ≤ 25 MB), base64 or a `data:` URL |
| `width`, `height` | int | clamped to the model's grid and range |
| `seconds` or `frames` | number / int | frames snapped to 4n+1 |
| `fps` | int | 1–60 |
| `model` | `wan22-ti2v-5b` \| `wan21-t2v-1.3b` | default from settings (`wan22-ti2v-5b`) |
| `steps`, `cfgScale`, `seed`, `sampler`, `scheduler`, `shift` | | seed −1 = random (the used seed is returned); sampler / scheduler checked against ComfyUI's lists |
| `characterLock` | string | a 🎨 character lock (id or name): its trigger words + looks go before the prompt, its negative is added |
| `purpose` | `clip` \| `trailer_shot` \| `free` | |
| `from`, `book` | string | recorded (log + sidecar) |
| `returnPoster` | bool | adds `posterBase64` |
| `backend`, `timeoutMs` | | per request (default time limit 45 min) |

Every param is checked; changed values come back in `warnings: [{level, field, message}]`.

### Result

```json
{ "ok": true, "engine": "comfy-wan", "model": "wan22-ti2v-5b", "mode": "i2v",
  "path": "…/videos/clip-20261027-101500-3700735009.mp4", "poster": "…/videos/clip-20261027-101500-3700735009.png",
  "seconds": 4, "frames": 97, "fps": 24, "width": 800, "height": 1152, "seed": 3700735009,
  "url": "file:///…mp4", "posterUrl": "file:///…png", "json": "…/videos/clip-…json", "warnings": [] }
```

`path` is `.mp4` (or `.webm` from an older ComfyUI) in the `videos/` output folder; the `.json`
sidecar has every setting (prompt, model, seed, steps, cfg, sampler, scheduler, shift, size,
frames, fps, purpose, from, book, characterLock, sourceImage, ComfyUI prompt id). `poster` is the
first frame as `.png` (from ComfyUI; for picture→video without ImageFromBatch, the input picture;
otherwise `null` with a warning). The endpoint backend returns the same shape with
`engine:"endpoint", model:"endpoint"` (its own frames/fps/size).

### Errors

`{ ok:false, error, code, message, fix, model?, cause?, serverError? }` — `error` and `code`
are the same contract code:

| Code | When |
|---|---|
| `VIDEO_NOT_SET_UP` | no ComfyUI (and no endpoint), ComfyUI not running and couldn't be started, endpoint off |
| `VIDEO_MODEL_MISSING` | the model's files are not in ComfyUI (checked before queueing, and from ComfyUI's own answer); `model` = the id to download |
| `VIDEO_OOM` | the graphics card ran out of memory — fix: 832×480, fewer seconds, the 1.3B model, `--lowvram` |
| `VIDEO_TIMEOUT` | past `timeoutMs` |
| `VIDEO_CANCELLED` | stopped |
| `VIDEO_FAILED` | anything else, with the first useful line ComfyUI said (`cause:"NODE_MISSING"` → "update ComfyUI") |
| `UNSUPPORTED_ON_BACKEND` | picture→video on the endpoint backend |
| `INVALID_PARAM` (`field`, `hint`), `NEED_PROMPT`, `NO_LOCK`, `BUSY` | bad request / one video at a time |

---

## 4. Bridge routes

Same auth as `/image/*` (`Authorization: Bearer <token>`, localhost, foreign browser origins
refused). See `desktop-app/SERVICE_BRIDGE.md`.

* **`GET /video/backend`** → `{ok, ready, backend, message, busy, comfy, endpoint:{configured, enabled}, installed, defaultModel, models:[{id, installed, modes, vramGB}]}`
* **`POST /video/request`** — the `video.generate` / `video.animate` params; with `image` it
  animates. The body may be up to 40 MB (base64 pictures); prefer a file path. The server never
  times this out (it runs for minutes) — use a long client timeout. `returnPoster:true` adds
  `posterBase64` (raw base64, no `data:` prefix); `poster` stays the `.png` path.
  HTTP status: 200 ok · 400 `INVALID_PARAM` / `NEED_PROMPT` / `NO_LOCK` / `UNSUPPORTED_ON_BACKEND` ·
  503 `VIDEO_NOT_SET_UP` / `VIDEO_MODEL_MISSING` / `BUSY` · 504 `VIDEO_TIMEOUT` · 507 `VIDEO_OOM` ·
  409 `VIDEO_CANCELLED` · 502 `VIDEO_FAILED`. The body is always the JSON result.

Akọwe's character clip (contract §2):

```json
POST /video/request
{ "image": "C:/Users/me/AppData/Local/Temp/odile-portrait.png",
  "prompt": "red hair, green coat, upright posture, … subtle idle motion, breathing, cloth moving, camera still",
  "seconds": 4, "purpose": "clip", "from": "akowe-forge", "returnPoster": true, "book": "The Ferry" }
```

---

## 5. IPC channels (main.js → preload `window.api.video`)

Legacy (kept): `video:status` (videoProvider's old fields + `engine: {ready, backend, message, comfy, installed, busy}`),
`video:configure` (the endpoint settings), `video:generate` (now through video-studio: Wan when
ready, else the switched-on endpoint with its old codes; keeps `{ok, path, preview}` and adds the result fields).

New: `video:full-status`, `video:models`, `video:capabilities`, `video:settings`,
`video:generate-t2v`, `video:animate`, `video:progress`, `video:cancel`, `video:gallery`,
`video:test`, `video:install-check`, `video:install-model`, `video:install-all`,
`video:install-cancel`, `video:open-folder`, `video:show-file`. Events: `video-install`
(download progress), `video-done`.

Alfred: every new channel is mapped in `alfred-app-actions.js` (`TOOL_CHANNELS` →
`video_call:<method>`, `video.open_folder` / `video.show_file` as app actions,
`video:capabilities` excluded as internal).

---

## 6. What needs a real GPU to confirm

The tests drive the whole path against a fake ComfyUI (`test/fixtures/fake-sd.js`): graph
shape, uploads, progress, cancel, history parsing, `/view` downloads, every error mapping, the
installer against a fake file server. Not verifiable without a GPU and the real 17 GB of
models: the picture quality, real render times and VRAM use, that the current ComfyUI build
accepts `SaveVideo` with `format:"auto", codec:"auto"` in API format (the `SaveWEBM` retry
covers a refusal), and that ComfyUI's history really lists the clip under `images` (also read:
`videos`, `gifs`).

---

## 7. 🎞 Trailers (`video-trailer.js`, `trailer-recorder.js`, `webm-tools.js`)

A trailer = **shots** `{type:"shot", prompt | image, seconds 1–5 (default 4), characterLock?, negativePrompt?, seed?, model?}`
and **title cards** `{type:"card", text ≤ 120, subtitle? ≤ 160, seconds 1–10 (default 3)}` in order (`items`, at most 24
parts / 16 shots) — or `shots` + `cards` (a card's `at`: `"start"`, `"end"`, or after the n-th shot; default: the first
card opens, the rest close). Also: `book` (the folder), `title`, `music` (a local .mp3/.ogg/.opus/.wav/.m4a/.aac/.flac/.webm,
mixed in and faded out at the end), `musicVolume` 0–1 (0.8), `width`×`height` (1280×720; 320–1920 × 240–1080), `fps`
12–30 (24), `fade` 0–1 s (0.4, through black between parts), `model`, `resume` (true), `mp4` (true), `wait` (false).

1. **Shots** go through the normal engine (`video.generate`, or `video.animate` with `image`; `purpose: "trailer_shot"`,
   `from: "trailer…"`), one after the other. A video already being made in 🎬 Make video is waited for. Each finished
   shot is copied to `videos/trailers/<book>/shots/shot-<key>.mp4`; the key is a hash of the shot (prompt, picture,
   seconds, lock, model, seed), so the same shot asked for again is **reused** (resume after Stop or a failure; only
   changed shots are rendered; `resume:false` renders all).
2. **The join — no new dependency.** A hidden, offscreen `BrowserWindow` (`trailer-recorder.html` /
   `trailer-recorder-page.js`, preload `trailer-recorder-preload.js`, `webSecurity:false` so local clips don't taint
   the canvas) loads every clip, then plays the timeline onto a `<canvas>` in real time: clips cover-cropped to the
   frame, cards drawn as text on black, fades through black. `canvas.captureStream(fps)` (+ the music through WebAudio
   `MediaElementSource → Gain (fade-out) → MediaStreamDestination`) is recorded by `MediaRecorder` as WebM
   (`vp9,opus`, else `vp8`). Chunks come back over `ipcMain.on('trailer-rec:*')`; then `webm-tools.setWebmDuration`
   writes the missing Duration into the WebM (players can seek), checked against the frames (`probeWebm`).
   Recording takes as long as the trailer.
3. **MP4 (optional).** When an ffmpeg is found — `AUTOINJECTOR_FFMPEG` (`none` = never), `PATH`, the ComfyUI folders
   (`ffmpeg.exe`, `ffmpeg/bin`), `imageio_ffmpeg/binaries/ffmpeg-*` inside ComfyUI's `python_embeded` or a venv —
   `trailer.mp4` is made (`libx264 yuv420p +faststart`, AAC music). Without one: only the .webm, with a plain warning.

Saved in `videos/trailers/<book>/`: `trailer.webm`, `trailer.mp4`, `trailer.json` (the plan, every shot, the last
result), `shots/`. One trailer at a time (`BUSY`).

Result: `{ok, id, book, dir, path (.webm), url, mp4, mp4Url, seconds, planned, width, height, fps, mime, bytes, music,
shots:[{path, poster, seconds, reused}], cards, reused, warnings}`. A failed shot: the engine's code (`VIDEO_OOM`, …) with
`shot: n`, `message: "Shot n could not be made: …"` and a fix that says the made shots are kept; a failed join:
`TRAILER_JOIN_FAILED` (`cause`: `CLIP_UNREADABLE` / `MUSIC_UNREADABLE` / `NO_RECORDER` / `RECORD_FAILED` /
`RECORD_TIMEOUT`); Stop: `VIDEO_CANCELLED`.

Status (`trailer.status`): `{ok, busy, id, status:{phase: starting|shots|joining|mp4|done|failed|cancelled, shot, shots,
shotsDone, pct, seconds, message, items:[{type, status: waiting|ready|rendering|done|reused|failed|stopped, label,
path, error}]}, result?}`.

**Bridge** (same auth as the other routes):
* `POST /video/trailer` — the params above → **202** `{ok, started, id, status}` (or 200 with the finished trailer when
  `wait:true`). 400 `INVALID_PARAM` · 409 `BUSY` · 501 `NOT_WIRED` / `VIDEO_NOT_WIRED`.
* `GET /video/trailer?id=` → the status (+ `result` when finished); 404 `NOT_FOUND` for an id AutoInjector doesn't
  know (it restarted).
* `POST /video/trailer/cancel` → `{ok, cancelled}`.

Akọwe's 🎞 Trailer page (`akowe/akowe/trailer.py`) uses these three: it plans the shots from the book, sends pictures
as temp-file paths, follows `GET /video/trailer` every 2 s, and stores the finished .webm/.mp4 with the book.

**IPC** (`window.api.video`): `trailerMake` (`video:trailer-make`), `trailerStatus` (`video:trailer-status`),
`trailerCancel` (`video:trailer-cancel`), `trailerList` (`video:trailer-list`), `trailerPlan` (`video:trailer-plan`),
`trailerPickFile` (`video:trailer-pick-file`, a file chooser for music / a picture). The 🎬 Video tab's 🎞 Trailer
section (`videos-trailer.js`) is the UI. 🎩 Alfred: `video_call` with `trailer.*`, and `make_trailer` for a book.

Tests: `test/video-trailer.test.js` (plan, join plan, ffmpeg finder, webm-tools, the maker against the fake ComfyUI,
resume, Stop, errors, video-api, the bridge) and `test/e2e/trailer.e2e.js` (the real canvas + MediaRecorder join:
2 clips + 1 card → a playable 3 s ± 0.5 WebM, and the .mp4 when ffmpeg is there).
