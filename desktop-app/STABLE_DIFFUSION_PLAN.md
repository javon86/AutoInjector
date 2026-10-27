# Stable Diffusion integration — design plan

**Status (2026-10-25): BUILT for real — the 🎨 Images tab.** Setup guide for users:
[`docs/STABLE_DIFFUSION_SETUP.md`](../docs/STABLE_DIFFUSION_SETUP.md). Bridge contract for
Akọwe: [`docs/SD_IMAGE_API.md`](../docs/SD_IMAGE_API.md). The original design that guided the
first build is kept below ("Original design").

## What is built

| Piece | File | What it does |
|---|---|---|
| Backends | `sd-backends.js` | **detect/identify** what answers on localhost (7860–7865, 8188, 8000, 8888, 9090): Automatic1111 / Forge / reForge / SD.Next (`/sdapi/v1/*`), ComfyUI (`/system_stats`), a WebUI started **without `--api`** (gives the exact Stability Matrix / `webui-user.bat` fix), Fooocus / Fooocus-API (explained, not supported). **A1111 client:** sd-models, loras, samplers, schedulers, sd-vae, embeddings, options, txt2img / img2img with `override_settings` (checkpoint, VAE), `<lora:name:w>` tags, progress, interrupt. **ComfyUI client:** lists from `/object_info` (old and new COMBO shapes), a built-in txt2img graph (CheckpointLoaderSimple → LoraLoader chain → CLIPTextEncode ± → EmptyLatentImage → KSampler → [VAELoader] → VAEDecode → SaveImage), `/prompt` → poll `/history` → `/view`, progress from `/queue` (+ `/ws` when available), cancel = `/interrupt` + remove from `/queue`, A1111 sampler names mapped (DPM++ 2M Karras → dpmpp_2m + karras), `<lora:…>` tags turned into nodes, names resolved to ComfyUI's paths. Plain-English errors (nothing answering, API off, out of GPU memory, timeout, crashed, ComfyUI node errors). |
| Provider | `image-provider.js` | settings (backward compatible; `backend` a1111/comfy), `connect()`, `lists()`, `generate(prompt, opts)` with per-call options + LoRAs, `progress()`, `cancel()`, `testRender()`. Still used by the butler's `GENERATE_IMAGE`, the wizard and `/image/generate`. |
| Library | `sd-library.js` | the Model & LoRA library: Stability Matrix discovery (portable `Data`, `%APPDATA%\StabilityMatrix\library.json`, `settings.json` ModelDirectoryOverride), AutoInjector's `models/`, the backend's reported folders, folders the user adds (a WebUI / ComfyUI root is expanded into its typed folders). Reads only the safetensors header (`ss_base_model_version`, `ss_sd_model_name`, `ss_tag_frequency`, `modelspec.*`, tensor names) + sidecars (`.cm-info.json`, `.civitai.info`, `.json`, `.txt`, previews). Base model families SD1.5/SD2/SDXL/Pony/Illustrious/NoobAI/SD3/Flux, compatibility (hard / soft / ok). User tags, collections, ★, default weight, notes, base override, edited trigger words, **character locks** — one JSON file (`<userData>/sd-library.json`). Model files are opened read-only. |
| Saving | `sd-images.js` | PNG `iTXt` chunks (`parameters` in A1111 infotext format + `autoinjector` JSON) and a `.json` sidecar per picture, gallery listing, read a record back for **Remake**. |
| Studio | `sd-studio.js` | glues it together for the UI and the bridge: generate + save + record (db `recordImage`), character-lock merge, purpose sizes, mismatch warnings, gallery, the Akọwe request. |
| Runner | `sd-runner.js` | runs SD **from inside AutoInjector**, like `akowe-server.js` runs Akọwe: finds Stability Matrix packages (`settings.json` InstalledPackages + `Packages/`), launches the package's venv Python with its launch command, its saved Stability Matrix launch options, `--api` and `--port`; or the ComfyUI portable (`python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build`). Hidden start, health wait (≤15 min), reuse of an SD app already running, restart with backoff (3 s / 10 s / 30 s, max 3), stop on quit (whole process tree on Windows), log without secrets (`<userData>/logs/stable-diffusion.log`). |
| Installer | `sd-installer.js` | **⬇ Install Stable Diffusion**: GPU check (nvidia-smi, then WMI) → which official ComfyUI portable build; free-space check; resumable, cancellable download with size + SHA-256 from GitHub's release info; extract with 7-Zip or Windows `tar`; optional starter checkpoint (DreamShaper 8 SD1.5 / SDXL base 1.0) into `models/checkpoints`. Installs into `%LOCALAPPDATA%\AutoInjector\comfyui`. Never overwrites user files. |
| Parameters | `sd-params.js` | **every** setting in one schema (`GENERATE_SCHEMA`, `UPSCALE_SCHEMA`): types, ranges, enums, how each reaches A1111 (`x-a1111` payload fields) and ComfyUI (`x-comfy` yes / partial / no + note). `normalize()` (images from base64 / data: URL / a file path), `a1111Apply()` (hires, refiner, img2img/inpaint, ControlNet, ADetailer, styles, scripts, clip skip, variation, override settings, `extra`), `buildComfyGraph()` (LoRAs, CLIP skip, img2img/inpaint, ControlNet, refiner, hires), `unsupportedOn()`, and the pass-through checks against the server's own `/openapi.json` and options. |
| Control | `sd-control.js` | everything beyond "make a picture": A1111 options get/set (validated), upscalers + latent modes, Extras upscale, styles, embeddings, scripts + args, ControlNet models/modules, ADetailer models, interrupt, skip, refresh, memory, the txt2img/img2img payload schema, `a1111Check()` (every name in a request checked before sending). ComfyUI `/object_info`, `/queue`, `/interrupt`, `/free`, memory, uploads, upscale-model graph. |
| Workflows | `sd-workflows.js` | run **any** ComfyUI API-format workflow: saved in `<userData>/sd-workflows/`, named params via `"<node>.<input>"`, explicit bindings, `{{placeholders}}` or auto-detected names (prompt, negativePrompt, seed, steps, cfgScale, sampler, scheduler, denoise, width, height, batchSize, checkpoint, image, mask). UI-format saves refused with how to export the API format. |
| Module API | `sd-api.js` | one API for Alfred and other main-process callers (below), with `capabilities()` and `call()`. |
| UI | `controls.html` + `images-studio.js` | the **🎨 Images** app tab: connection bar (Find / Connect / Test 512px / Open SD UI / ▶ Start / ⏹ Stop), 🖌 Generate, 📚 Library, 🔒 Character locks, ⚙ Start & install. The Generate form has collapsible sections, all off by default: **Hires fix**, **Refiner**, **img2img / Inpaint** (with a mask brush), **ControlNet** units, **ADetailer**, **Upscale the result**, **Advanced** (CLIP skip, restore faces, tiling, styles, script + args, override settings JSON, extra fields JSON, read/set any settings-menu option), **ComfyUI workflow** (pick / run / save). Sections the connected app can't use are hidden. |
| Bridge | `service-bridge.js` | `GET /image/backend`, `GET /image/locks`, `POST /image/request` (character lock; `engine` auto / sd / chatgpt; `purpose` view + `view` / sheet) — `docs/SD_IMAGE_API.md`. |
| ChatGPT engine | `chatgpt-image.js` + `image-views.js` | the second image engine: ChatGPT's own image generation in its logged-in pane (typed with the app's send path, the finished `<img>` read from the page, bytes fetched with the page's session, WebP → PNG, saved with a sidecar; one job at a time; the pane is held while it draws). `image-views.js`: the framing for the ten reference views and the turnaround sheet, for both engines. |

Settings persisted in the app state: `imageConfig` (endpoint, backend, size, sampler…) and
`sdManaged` (`startWithApp`, default **off**; `targetId`). Env for tests/power users:
`AUTOINJECTOR_SD_MODEL_DIRS` (extra model folders, path-list), `AUTOINJECTOR_SD_HOME`
(installer folder), `AUTOINJECTOR_SD_AUTOSTART=0`.

## Module API (for Alfred and other callers)

```js
const imagesApi = require('./sd-api').get();   // registered by main.js at load; null in tests unless registered

// Discover everything (generate Alfred tools from this — nothing is left out):
await imagesApi.capabilities();
// → { ok, backend:'a1111'|'comfy'|'', label, connected, features:{controlnet, adetailer, openapi, nodes…},
//     operations:[{ name:'images.generate', description, params:<JSON schema>, args, supported, hint, code }],
//     generateParams:[{ name, supported:'yes'|'partial'|'no', note, a1111Fields }],
//     extraFields:{ txt2img:[…], img2img:[…], validated } }        // A1111: every pass-through field
await imagesApi.call('images.generate', { prompt: 'a cat', hires: { scale: 2 } });   // generic dispatcher (checks params)

// Pictures
await imagesApi.images.status();               // { ok, enabled, endpoint, backend, label, checkpoint, busy, managed:{phase,…} }
await imagesApi.images.generate({ prompt, negativePrompt, loras:[{name,weight}], characterLock:'Odile',
     purpose:'portrait', width, height, steps, cfgScale, seed, checkpoint, vae, sampler, scheduler, count, batchCount,
     clipSkip:2, restoreFaces, tiling, styles:['Cinematic'], variation:{ subseed, strength },
     hires:{ scale:2, upscaler:'R-ESRGAN 4x+', secondPassSteps:12, denoise:0.4, resizeX, resizeY, sampler, scheduler, checkpoint, prompt, negativePrompt, cfgScale },
     refiner:{ checkpoint:'sdxl_refiner_1.0', switchAt:0.8 },
     initImage:'<path|base64|data: URL>', denoise:0.6, resizeMode:'crop and resize', imageCfgScale,
     mask:'<path|base64>', inpaint:{ maskBlur:4, fill:'original'|'fill'|'latent noise'|'latent nothing', onlyMasked, padding, invertMask },
     controlnet:[{ image, module:'canny', model, weight, guidanceStart, guidanceEnd, controlMode, pixelPerfect, resizeMode, processorRes, thresholdA, thresholdB }],
     adetailer:[{ model:'face_yolov8n.pt', prompt, negativePrompt, confidence, denoise, maskBlur, inpaintOnlyMasked, inpaintPadding, steps, cfgScale }],
     script:{ name:'X/Y/Z plot', args:[…] }, alwaysonScripts:{ '<extension>':{ args:[…] } },
     overrideSettings:{ '<any option>': value }, extra:{ '<any txt2img/img2img field>': value }, from:'alfred' });
     // → { ok, images:[{ path, url, seed, sha256 }], seed, warnings, settings } | { ok:false, error, code, field?, message, hint? }
// Two engines + reference pictures: engine 'auto'|'sd'|'chatgpt', purpose 'view' + view, or purpose 'sheet'
await imagesApi.images.generate({ engine:'chatgpt', purpose:'view', view:'side', characterLock:'Odile', appearance, newChat, series });
     // → the POST /image/request answer: { ok, engine, purpose, view, paths:[…], images:[{ path, url, sha256, width, height }], seed:null, warnings, settings }
await imagesApi.images.chatgptStatus();        // { ok, ready, why?, busy, phase, drawingMs, queue, freshChatPerSeries, last }
await imagesApi.images.chatgptCancel();        // stop waiting for the picture being made
await imagesApi.images.chatgptSettings({ freshChatPerSeries: true });   // a new ChatGPT chat per view series (default off)
await imagesApi.images.img2img({ initImage, prompt, denoise, … });        // initImage required
await imagesApi.images.inpaint({ initImage, mask, prompt, inpaint:{…} });  // initImage + mask required
await imagesApi.images.upscale({ image, upscaler, factor, width, height, crop, upscaler2, upscaler2Visibility, gfpgan, codeformer, codeformerWeight });
await imagesApi.images.progress();  await imagesApi.images.cancel();  await imagesApi.images.gallery(20);  await imagesApi.images.test();

// The SD app
await imagesApi.sd.status();  await imagesApi.sd.detect();  await imagesApi.sd.connect('http://127.0.0.1:7860');  await imagesApi.sd.lists();
await imagesApi.sd.targets(); await imagesApi.sd.start(targetId?); await imagesApi.sd.stop();
await imagesApi.sd.install.check(); await imagesApi.sd.install.install(); await imagesApi.sd.install.downloadModel('sd15'|'sdxl'); await imagesApi.sd.install.cancel();
await imagesApi.sd.options.get(['CLIP_stop_at_last_layers']);   // all keys when no list
await imagesApi.sd.options.set({ CLIP_stop_at_last_layers: 2 }); // key must exist, type must match, choices checked
await imagesApi.sd.options.schema();                             // [{ key, type, current, description }]
await imagesApi.sd.controlnet.models(); await imagesApi.sd.controlnet.modules(); await imagesApi.sd.adetailer.models();
await imagesApi.sd.styles(); await imagesApi.sd.scripts(); await imagesApi.sd.embeddings(); await imagesApi.sd.upscalers();
await imagesApi.sd.extraFields('txt2img'|'img2img');             // every payload field + which structured param covers it
await imagesApi.sd.interrupt(); await imagesApi.sd.skip(); await imagesApi.sd.refresh('all'|'checkpoints'|'loras'|'vae'|'embeddings'); await imagesApi.sd.memory();
await imagesApi.sd.workflows.list(); await imagesApi.sd.workflows.get(id); await imagesApi.sd.workflows.delete(id);
await imagesApi.sd.workflows.save({ name, workflow /* API format */, bindings: { prompt: [{ node:'6', input:'text' }] } });
await imagesApi.sd.workflows.run({ id /* or workflow */, params: { prompt, seed: -1, '6.text': '…', image: '<path>' } });
await imagesApi.sd.comfy.objectInfo(node?); await imagesApi.sd.comfy.queue(); await imagesApi.sd.comfy.upload(image, name); await imagesApi.sd.comfy.free();

// Library
await imagesApi.library.find('odile', { kind:'lora', base:'SD1.5' });   // → items
await imagesApi.library.characterLock('Odile');                          // → lock | null
await imagesApi.library.locks();    await imagesApi.library.get('lora:odile_face');  await imagesApi.library.scan();
```

Every call resolves (never throws); failures carry a plain-English `message`. Error codes:
`INVALID_PARAM` (type / range / enum / unknown parameter, with `field` and a suggestion), `UNKNOWN_VALUE`
(a model, upscaler, style, script, ControlNet model/preprocessor or ADetailer model the server doesn't have —
`hint` lists the real ones), `UNKNOWN_FIELD` / `BAD_TYPE` / `BAD_VALUE` (pass-through `extra` checked against
`/openapi.json`), `UNKNOWN_OPTION` (options), `UNSUPPORTED_ON_BACKEND` (with a `hint` saying what to do instead),
`UNKNOWN_PARAM` / `MISSING_PARAM` / `UI_FORMAT` / `BAD_WORKFLOW` (workflows), plus the connection errors
(`NO_ENDPOINT`, `REFUSED`, `NO_API`, `TIMEOUT`, `HTTP_5xx`, `COMFY_REJECTED`, `CANCELLED`, …). Names are checked
**before** anything is sent, so a typo never costs a render. `extra` is sent unchecked (with a warning) only when
the server has no `/openapi.json`.

## Coverage: what can be controlled

Generated from `sd-params.js` (`x-a1111` / `x-comfy`) and checked by `test/sd-full.test.js`, including a test that
**every field of the server's txt2img and img2img OpenAPI schema is reachable** (fake A1111 1.10/Forge schema:
58 + 58 fields; 41 / 38 through structured params, the rest through the validated `extra` pass-through; 0 unreachable).

| Feature | A1111 / Forge / reForge / SD.Next | ComfyUI (built-in graph) |
|---|---|---|
| prompt, negative, LoRAs, checkpoint, VAE, sampler, scheduler, steps, CFG, size, seed, batch | ✅ payload + `<lora:>` tags + `override_settings` | ✅ LoraLoader chain, VAELoader, sampler names mapped |
| batch count (`n_iter`) | ✅ | ➖ use batchSize |
| hires fix (scale, upscaler, steps, denoise, resize-to, sampler, scheduler) | ✅ `enable_hr`, `hr_*`, `denoising_strength` | ✅ LatentUpscale or UpscaleModelLoader → ImageUpscaleWithModel → ImageScale → VAEEncode, + 2nd KSampler |
| hires checkpoint / prompt / negative / CFG | ✅ `hr_checkpoint_name`, `hr_prompt`, `hr_negative_prompt`, `hr_cfg` (Forge) | ❌ UNSUPPORTED (same model + prompt) |
| SDXL refiner | ✅ `refiner_checkpoint`, `refiner_switch_at` | ✅ two KSamplerAdvanced (switch step), refiner's own encoders |
| img2img (picture, denoise, resize mode) | ✅ `/img2img`, `init_images`, `resize_mode` | ✅ upload → LoadImage → ImageScale (crop for “crop and resize”) → VAEEncode (+ RepeatLatentBatch) |
| image CFG (instruct-pix2pix) | ✅ `image_cfg_scale` | ❌ |
| inpaint: mask, blur, masked content, invert | ✅ `mask`, `mask_blur`, `inpainting_fill`, `inpainting_mask_invert` | ✅ LoadImageMask (+ InvertMask); original → SetLatentNoiseMask, else VAEEncodeForInpaint (blur → `grow_mask_by`) |
| inpaint “only masked” + padding | ✅ `inpaint_full_res`, `inpaint_full_res_padding` | ❌ UNSUPPORTED |
| CLIP skip | ✅ `override_settings.CLIP_stop_at_last_layers` | ✅ CLIPSetLastLayer |
| restore faces / tiling / variation seed / styles | ✅ | ❌ UNSUPPORTED (hint: workflow / prompt) |
| ControlNet units (image, module, model, weight, start/end, control mode, pixel perfect, resize, processor res, thresholds) | ✅ `alwayson_scripts.controlnet` (models/modules listed and checked) | ✅ ControlNetLoader + ControlNetApplyAdvanced; preprocessors via `AIO_Preprocessor` (comfyui_controlnet_aux); control mode / per-unit mask ❌ |
| ADetailer (model, prompt, confidence, denoise, blur, only-masked, padding, steps, CFG) | ✅ `alwayson_scripts.ADetailer` (models checked) | ❌ UNSUPPORTED (use a FaceDetailer workflow) |
| any other extension | ✅ `alwaysonScripts` raw | ✅ via workflows |
| scripts (`script_name`, `script_args`) | ✅ (names checked per txt2img / img2img; args listed by `sd.scripts()`) | ❌ (workflows) |
| any settings-menu option | ✅ `sd.options.get/set/schema` (validated) + per-picture `overrideSettings` | ❌ no settings menu |
| any other payload field | ✅ `extra`, validated against `/openapi.json` | ❌ (use `"<node>.<input>"` workflow params) |
| upscale a picture | ✅ `/extra-single-image` (2 upscalers, GFPGAN, CodeFormer, resize-to, crop) | ✅ upscale model (+ ImageScaleBy to the factor) or lanczos; extras ❌ |
| run any workflow with named params | ❌ UNSUPPORTED (it's a ComfyUI graph) | ✅ `sd.workflows.*` |
| lists: upscalers, styles, scripts, embeddings, ControlNet, ADetailer | ✅ | ✅ upscalers, embeddings, ControlNet models/preprocessors; others ❌ |
| node types / queue / upload / free VRAM | ❌ | ✅ `/object_info`, `/queue`, `/upload/image`, `/free` |
| progress / cancel / interrupt / skip | ✅ / ✅ / ✅ / ✅ | ✅ / ✅ / ✅ / ❌ |
| refresh models / memory | ✅ refresh-checkpoints/loras/vae/embeddings, `/memory` | ✅ (lists re-read) / `/system_stats` |

## Problems / limits (honest)

- Tested against fake A1111 / ComfyUI servers and fake processes (the API shapes were checked
  against the projects' docs/source); **not yet run against a real GPU install** — the first
  run on the user's PC is the real test.
- The A1111-family "flavor" (Forge vs reForge vs A1111 vs SD.Next) is a best guess from
  `/sdapi/v1/options`, `/cmd-flags`, `/version`; only the label depends on it.
- ComfyUI: the built-in graph uses CheckpointLoaderSimple. **Flux / SD3 UNet-only models**
  (separate UNet + CLIP + VAE files) need a different graph — use a saved workflow
  (`sd.workflows.run`); all-in-one Flux checkpoints work in the built-in graph (use CFG ~1).
  Built-in graph limits (all answered with `UNSUPPORTED_ON_BACKEND` + a hint): no ADetailer,
  restore faces, tiling, variation seeds, styles, scripts, inpaint “only masked”, ControlNet
  control mode, hires checkpoint/prompt. Hires fix is txt2img-only on both backends (as in A1111).
  Inpainting on ComfyUI does not paste the result back over the original outside the mask
  (A1111 does). ControlNet preprocessors on ComfyUI need comfyui_controlnet_aux.
- The validated pass-through relies on the server's `/openapi.json` (A1111/Forge serve it);
  without it, `extra` fields are sent with a warning. Script arguments (`script_args`) are
  positional and passed as given — `sd.scripts()` shows each script's argument list.
- ControlNet / ADetailer payloads follow the sd-webui-controlnet and ADetailer API shapes; Forge's
  built-in ControlNet accepts the same unit fields. Tested against fake servers, not a real GPU.
- Launching Stability Matrix packages directly (venv Python + launch command + its saved
  options) mirrors what Stability Matrix does, but Stability Matrix may set extra environment
  for some packages; if a package won't start from AutoInjector, start it in Stability Matrix
  and press 🔍 Find. The installer's extract step needs 7-Zip or a Windows `tar` that reads .7z
  (Windows 11 / recent 10).
- Starter model URLs are Hugging Face links (no size/hash pinned); the ComfyUI download is
  verified against GitHub's published size + SHA-256 when GitHub provides the digest.
- `.ckpt` / `.pt` files are listed but never unpickled (base model unknown unless a sidecar says).
- Video (B2) now runs on the same ComfyUI as pictures: Wan 2.2 5B / Wan 2.1 1.3B through video-studio.js, video-installer.js and video-api.js (the 🎬 Video tab). The old video provider stays as the "endpoint" backend. See docs/VIDEO_API.md.

## Original design

## Why it fits

AutoInjector's thesis is *several AIs working a problem together*, with a shared
SQLite backend (messages, typed memory, versioned artifacts, files). Stable
Diffusion (SD) slots in as the **image worker**: the three chat AIs collaborate
on a prompt (the roundtable), SD renders it, and the result is stored as a
**versioned artifact** linked to the project — a character portrait, a location,
a scene illustration, a book cover.

The chat models can't draw; SD can't reason. Routing a refined prompt from the
roundtable into SD is the same move the app already makes with `[TO: X]`.

## Where SD actually runs (the backend)

SD needs a GPU, so — exactly like the manager/orchestrator — it's a
**configurable HTTP endpoint**, not bundled. Three supported shapes, in order of
effort:

| Backend | Endpoint | Notes |
|---|---|---|
| **Automatic1111 / Forge** (local) | `POST /sdapi/v1/txt2img` | Easiest to target; returns base64 PNGs. User runs it locally. |
| **ComfyUI** (local) | `POST /prompt` (+ `/history`, `/view`) | Workflow graph; more powerful, more wiring. |
| **RunPod pod** (cloud) | A1111/Comfy on a pod | **Reuse `manager-provider.js`'s existing RunPod start/stop/status helpers** — the pod lifecycle is already written. |

This mirrors `manager-provider.js` (RunPod / Ollama / LM Studio behind one
configurable URL). No new dependency in the app itself.

## Architecture (each piece has an existing sibling)

```
 Image Studio panel (controls.html/.js)     ← like the module panels just added
        │  window.api.sd*   (preload.js)
        ▼
 main.js  IPC  ── sdProvider.generate(prompt, opts) ──►  sd-provider.js
        │                                                 │ fetch() to A1111/Comfy/RunPod
        │  save result                                    ▼
        ▼                                            base64 PNG(s)
 FileManager.write() → project image file (MDC-009, atomic, policy-checked)
 ArtifactStore.put() → version + SHA-256 (MDC-008)
 MemoryStore.create('image', {...}) → prompt, seed, model, path (MDC-002, searchable)
```

New file **`sd-provider.js`** — a near-copy of `manager-provider.js`'s shape:
`generate(opts)`, `testConnection()`, error/timeout mapping, secret redaction,
and RunPod pod lifecycle reused from `manager-provider.js`.

Storage decisions:
- The PNG is written through **`FileManager`** (so authority/path rules and
  atomic writes apply) to e.g. `05_RESEARCH/images/…png`.
- **`ArtifactStore`** records each render as a hashed version — regenerate and
  you get v2, with full history and integrity checks, for free.
- A new **`image` memory entity** (add to `shared/entities.js`: prompt, negative,
  seed, model, steps, path) makes every image searchable and linkable to a
  character/scene via the existing memory + FTS layer.

## UI: an "Image Studio" panel

Collapsible, in the scrollable control panel, same as the new module panels:
- Prompt + negative-prompt boxes, and a **"use last reply from ChatGPT/Claude/
  Gemini as the prompt"** button (ties the roundtable to SD).
- Settings: model/checkpoint, size, steps, CFG, seed (lock for consistency).
- **Generate** → shows the image inline (data URI) → **Save to project** (writes
  the artifact + memory entity).
- A small gallery of this session's renders, backed by the artifacts table.

## Roundtable tie-in (the payoff)

- **Manual:** any AI reply → "Send to Image Studio" turns that text into a prompt.
- **Automatic (later):** a reply that starts with `[IMAGE: …]` (a new tag,
  parallel to `[TO: X]`) auto-routes to SD, and the resulting image is posted
  back into the conversation/transcript as an artifact reference. This makes
  "ChatGPT designs the character, Claude writes her, SD draws her" a single flow.
- **img2img (later):** feed a previous render back in for variations/consistency.

## Phasing

1. **Phase 1 — manual studio.** `sd-provider.js` + config + the Image Studio
   panel: type a prompt, generate against A1111, view, save as an artifact. One
   backend (A1111), txt2img only.
2. **Phase 2 — project-native.** `image` memory entity, gallery from the
   artifacts table, "use a pane's reply as prompt", RunPod backend via the
   reused pod lifecycle.
3. **Phase 3 — collaborative.** `[IMAGE: …]` auto-routing from the roundtable,
   img2img/inpaint, seed/LoRA for character consistency, batch renders.

## Honest constraints

- **Needs a GPU somewhere** — local A1111/Comfy (free, requires a capable GPU) or
  a paid RunPod pod. This is heavier than the text modules; it will be clearly
  optional and off unless configured, like the manager and ATELIER.
- **Binary handling** — SD returns base64; the app shows it via a data URI and
  saves bytes through `FileManager`. Electron's main process handles the file
  write; nothing new is needed in the renderer.
- **Licensing/ToS** — model licenses (SDXL, SD3, Flux each differ) are the user's
  responsibility, same disclaimer posture as driving the chat web UIs.
- **Testability** — `sd-provider.js` gets the same "mock the network boundary"
  unit tests as `manager-provider.js`; the actual image quality is a runtime,
  human-in-the-loop check.
