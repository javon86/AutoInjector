---
name: autoinjector-media-diagnostics
description: Diagnose AutoInjector picture and video failures - Stable Diffusion (Forge / A1111 / SD.Next / ComfyUI), FramePack and Wan video, the trailer join, ChatGPT images - by checking the endpoint, the backend type, the model files, GPU memory, the job status and whether an output file really exists. Use for HTTP 500s, "no model", out-of-memory, timeouts, stuck or blank renders, wrong endpoint URLs, or a failed 🩺 Test pictures & video report.
---

# AutoInjector media diagnostics

All paths relative to `desktop-app/`. Work from the outside in: is the server up → is it the
backend we think → are the models there → is there GPU room → did the job run → is the file real.
Never conclude "it works" from an HTTP 200 alone - check the output file.

## Where things live

| Area | Files |
|---|---|
| One-press self-test | `media-selftest.js` (+ `media-selftest-ui.js`). Each step ✅/⚠️/❌/⏭ with the exact error and "what to try". Quick = reachability only; Full = one 512×512 picture + a short video. **Start here.** |
| Finding the server | `endpoint-detect.js` (presets, `detect(kind)`, `test(url)`), `sd-backends.js` `detect()` (also spots a WebUI started without `--api`) |
| Talking to SD | `sd-backends.js` (a1111 family via `/sdapi/v1/*`; ComfyUI via `/prompt` → `/history/<id>` → `/view`), `sd-api.js`, `sd-params.js`, `sd-workflows.js`, `sd-sanitize.js` |
| Starting SD itself | `sd-runner.js` (Stability Matrix packages or the installed ComfyUI portable; health wait, restart backoff), `sd-installer.js`. Log: `<userData>/logs/stable-diffusion.log` |
| Explaining SD errors | `sd-errors.js` `explainSdError()` → one cause + fix (bad VAE, missing model, OOM, refused…) |
| Video | `video-provider.js`, `video-api.js`, `video-studio.js`, `framepack.js` (`findFramePack`, `checkModels`, `FRAMEPACK_*` codes), `framepack` runner, `video-trailer.js`, `webm-tools.js` |
| Explaining video errors | `video-errors.js` → `VIDEO_NOT_SET_UP`, `VIDEO_MODEL_MISSING`, `VIDEO_OOM`, `VIDEO_TIMEOUT`, `VIDEO_CANCELLED`, `VIDEO_FAILED` (cause `NODE_MISSING` = ComfyUI too old) |
| GPU | `gpu-monitor.js` (nvidia-smi only; reports "not available" rather than guessing) |
| ChatGPT pictures | `chatgpt-image.js` (reads `IMAGE_CANDIDATES` from `selectors.js`; pane problems → `autoinjector-pane-repair`) |
| Output | `output-manager.js`; files land in the images / videos output folders |

## Diagnose in this order

1. **Get the report.** Ask for the 🩺 self-test report (Quick first, then Full) or the exact error code shown. If they only have a log, read `stable-diffusion.log` / `autoinjector-debug.log` around the failure time.
2. **Endpoint.** Which URL is configured, and does `endpoint-detect` / `sd-backends.detect()` find a server there? Refused = not running (check `sd-runner` state/log). 404 on `/sdapi/v1/*` with a page that answers = WebUI started without `--api`.
3. **Backend family.** a1111-family and ComfyUI take different requests. A ComfyUI URL treated as A1111 (or the reverse) fails in confusing ways.
4. **Models.** Checkpoint / VAE / LoRA names the request uses must exist on that server (`sd-models`, `sd-vae`, ComfyUI `/object_info`). FramePack: `checkModels(hfHome)` lists missing repos. Nothing is ever auto-downloaded - tell the user which file is missing and where it goes.
5. **GPU.** Read `gpu-monitor` (used / total VRAM). OOM text → lower resolution/frames, unload other models (FramePack `stop()` frees the card), close the other backend.
6. **Job.** For ComfyUI, `/history/<id>` holds `execution_error` with the failing node. For video, check the job's state and progress, not just the POST answer.
7. **Output.** Confirm the file exists in the output folder, has a non-zero size, and (for video) is playable - a 0-byte or poster-only result is a failure.

Run the explainers on the raw answer rather than reading it by eye: the real cause is usually inside a 500 body (`sd-errors.js` was built for exactly that).

## Fix and verify

- Error wording / new known cause → add a case to `sd-errors.js` or `video-errors.js` with a test using the real error body (redact paths and prompts).
- Detection / port → `endpoint-detect.js` presets + `test/endpoint-detect.test.js`.
- Fakes for tests: `test/fixtures/fake-sd.js`, `fake-sd-proc.js`, `a1111-openapi.js`, `fake-framepack.js`, `fake-framepack-runner.js`.

```
node test/sd-errors.test.js
node test/video.test.js
node test/framepack.test.js
node test/endpoint-detect.test.js
node test/gpu-monitor.test.js
node test/media-selftest.test.js
npm test
```
GUI: `test/e2e/sd-images.e2e.js`, `video.e2e.js`, `framepack.e2e.js`, `media-selftest.e2e.js`.

Fakes prove the app's handling; only a Full self-test on the user's PC proves the real GPU, models and backend. Say which one you have.
