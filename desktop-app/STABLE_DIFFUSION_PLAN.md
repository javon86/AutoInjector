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
| Module API | `sd-api.js` | one API for Alfred and other main-process callers (below). |
| UI | `controls.html` + `images-studio.js` | the **🎨 Images** app tab: connection bar (Find / Connect / Test 512px / Open SD UI / ▶ Start / ⏹ Stop), 🖌 Generate, 📚 Library, 🔒 Character locks, ⚙ Start & install. |
| Bridge | `service-bridge.js` | `GET /image/backend`, `GET /image/locks`, `POST /image/request` (character lock) — `docs/SD_IMAGE_API.md`. |

Settings persisted in the app state: `imageConfig` (endpoint, backend, size, sampler…) and
`sdManaged` (`startWithApp`, default **off**; `targetId`). Env for tests/power users:
`AUTOINJECTOR_SD_MODEL_DIRS` (extra model folders, path-list), `AUTOINJECTOR_SD_HOME`
(installer folder), `AUTOINJECTOR_SD_AUTOSTART=0`.

## Module API (for Alfred and other callers)

```js
const imagesApi = require('./sd-api').get();   // registered by main.js at load; null in tests unless registered
await imagesApi.images.status();               // { ok, enabled, endpoint, backend, label, checkpoint, busy, managed:{phase,…} }
await imagesApi.images.generate({ prompt, negativePrompt, loras:[{name,weight}], characterLock:'Odile',
                                  purpose:'portrait', width, height, steps, cfgScale, seed, checkpoint, sampler, count, from:'alfred' });
     // → { ok, images:[{ path, url, seed, sha256 }], seed, warnings, settings } | { ok:false, error, message }
await imagesApi.images.progress();  await imagesApi.images.cancel();
await imagesApi.images.gallery(20); await imagesApi.images.test();
await imagesApi.sd.status();        // { image, managed (runner), install }
await imagesApi.sd.detect();        await imagesApi.sd.connect('http://127.0.0.1:7860');
await imagesApi.sd.targets();       await imagesApi.sd.start(targetId?);  await imagesApi.sd.stop();
await imagesApi.sd.install.check(); await imagesApi.sd.install.install(); await imagesApi.sd.install.downloadModel('sd15'|'sdxl');
await imagesApi.library.find('odile', { kind:'lora', base:'SD1.5' });   // → items
await imagesApi.library.characterLock('Odile');                          // → lock | null
await imagesApi.library.locks();    await imagesApi.library.get('lora:odile_face');  await imagesApi.library.scan();
```

Every call resolves (never throws); failures carry a plain-English `message`.

## Problems / limits (honest)

- Tested against fake A1111 / ComfyUI servers and fake processes (the API shapes were checked
  against the projects' docs/source); **not yet run against a real GPU install** — the first
  run on the user's PC is the real test.
- The A1111-family "flavor" (Forge vs reForge vs A1111 vs SD.Next) is a best guess from
  `/sdapi/v1/options`, `/cmd-flags`, `/version`; only the label depends on it.
- ComfyUI: the built-in graph is plain txt2img with CheckpointLoaderSimple. **Flux / SD3
  UNet-only models** (separate UNet + CLIP + VAE files) need a different graph — not built;
  all-in-one Flux checkpoints should work (use CFG ~1). No img2img on ComfyUI yet (A1111 has it).
- Launching Stability Matrix packages directly (venv Python + launch command + its saved
  options) mirrors what Stability Matrix does, but Stability Matrix may set extra environment
  for some packages; if a package won't start from AutoInjector, start it in Stability Matrix
  and press 🔍 Find. The installer's extract step needs 7-Zip or a Windows `tar` that reads .7z
  (Windows 11 / recent 10).
- Starter model URLs are Hugging Face links (no size/hash pinned); the ComfyUI download is
  verified against GitHub's published size + SHA-256 when GitHub provides the digest.
- `.ckpt` / `.pt` files are listed but never unpickled (base model unknown unless a sidecar says).
- Video (B2) still uses the separate video provider.

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
