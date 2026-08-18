# Stable Diffusion integration — design plan

**Status:** design only (nothing built yet). This lays out how image generation
fits AutoInjector, reusing patterns already in the app so it doesn't become a
bolt-on.

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
