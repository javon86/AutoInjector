# 🩺 Test pictures & video — the one-press self-test

One button checks everything pictures and video need, in a few minutes, and writes **one report**. One run on the
real PC gives all the answers, instead of many long test sessions.

## Where it is

- **🎬 Video → 🩺 Test pictures & video** (the main place: ▶ Quick, ▶ Full, ⏹ Stop, 📋 Copy report, 📄 Open report).
- **🎨 Images → 🩺 Test pictures & video** (opens the same view).
- **🎩 Alfred → 🩺 Check everything** shows the last result in one line (and its ❌ steps) and has a
  **🩺 Test pictures & video (quick)** button. Alfred can also run it himself (`app_control mediatest.run`,
  `app_info mediatest.status`).

## Quick or Full

| | Quick | Full |
|---|---|---|
| Time | about 10 seconds | a few minutes (the first FramePack load on Windows can take longer) |
| Renders | nothing | ONE tiny picture, ONE 1-second clip, a 2-second trailer |
| Use it | to see that everything is reachable and set up | to prove pictures and video really work end to end |

Options: **Unload FramePack afterwards** (on by default — frees the graphics card) and **Also make one ChatGPT
picture** (off by default; only in Full).

## What each step checks

Every step shows ✅ pass / ⚠️ to look at / ❌ failed / ⏭ skipped, the time it took, the exact error and **what to
try** in plain words. A failure never stops the run: the next steps still run; a step that needs an earlier
result is skipped with the reason. Each step has its own time limit, so the test can never hang.

### 🎨 Pictures

| Step | Checks | Quick | Full |
|---|---|---|---|
| Forge is reachable | a picture app is connected and answers (reads its lists) | ✔ | ✔ |
| Picture models listed | at least one checkpoint; which one is loaded (none → where your models are and how to point Forge at them) | ✔ | ✔ |
| One tiny picture | 512×512, 6 steps, the loaded checkpoint; saved in “stuff and thing/images” **with its settings file (.json)** | | ✔ |
| LoRA list | the LoRA list is readable (empty = ⚠️, fine if you don't use LoRAs) | ✔ | ✔ |
| Character-lock list | the character locks can be read | ✔ | ✔ |
| ChatGPT engine | the ChatGPT pane is ready for pictures (no picture is made unless you tick it) | ✔ | ✔ |
| One ChatGPT picture | only when ticked | | ✔ |

### 🎬 Video (FramePack)

| Step | Checks | Quick | Full |
|---|---|---|---|
| FramePack is found | its folder (Stability Matrix's Packages\FramePack, or the folder you chose). Not found but ComfyUI + Wan ready → ⚠️ | ✔ | ✔ |
| Python, PyTorch, models | its own Python (venv), the three model files, and the PyTorch check (version, the graphics card, CUDA build) once it has run | ✔ | ✔ |
| FramePack loads | the real load, with **the time of each stage** (PyTorch check, starting Python, text encoder, VAE, video model…); on failure: the stage, the error and FramePack's last printed lines | | ✔ |
| Attention kernel | which attention FramePack uses on this card (e.g. PyTorch's built-in SDPA) and which kernels it turned off (xFormers / flash-attn / SageAttention without kernels for an RTX 50xx) | after a load | ✔ |
| One tiny clip | 1 second, 6 steps, from a built-in test picture; the .mp4, its settings file and its poster are saved | | ✔ |
| The clip really plays | the .mp4 is loaded in a hidden video player: its length and size are read | | ✔ |
| Graphics-memory peak | the highest graphics memory used while loading and making the clip (NVIDIA, via nvidia-smi); ≥ 97 % → ⚠️ | | ✔ |

### 🎞 Trailer

| Step | Checks |
|---|---|
| A tiny trailer | a title card + the clip just made (nothing new is rendered), joined by the trailer recorder into a .webm; an .mp4 copy when ffmpeg is on the PC. Saved in videos/trailers/media-selftest |
| The trailer plays | the .webm (and .mp4) load in the hidden player: length and size |

### 🎩 Alfred

| Step | Checks |
|---|---|
| His AI | Quick: his AI is reachable and its model installed. Full: his model answers one short question (Ollama). Off → ⚠️ |
| His picture and video tools | `generate_image` and `video_call video.animate` accept a request — checked the way he calls them, nothing is rendered |

### 📖 Akọwe link

| Step | Checks |
|---|---|
| The bridge | the local bridge Akọwe calls answers (`GET /health`) |
| Picture routes | `POST /image/request` and `POST /image/locks` answer — an empty, check-only request that the route itself refuses (`NEED_PROMPT`), so nothing is drawn or saved |

### 🧹 Cleanup (Full)

| Step | Checks |
|---|---|
| ⏹ Stop works | a second tiny clip is started and stopped after ~3 s; it must stop (within 60 s) and save nothing |
| FramePack unloaded | after unloading, FramePack's Python process is gone and the graphics memory in use is shown |

Pressing **⏹ Stop** during the test stops the step that is running at once (its own stop is pressed too: Stable
Diffusion's interrupt, the video's stop, the trailer recorder) and skips the rest; the report is still written and
says it was stopped.

## The report

- Shown on screen; saved as **Markdown + JSON** in `stuff and thing/logs/media-selftest-<date>-<time>.md|json`.
- **📋 Copy report** puts the whole Markdown report on the clipboard.
- **📋 Extract** (any scope) ends with the latest self-test summary and its ❌/⚠️ steps.
- Private paths are hidden the same way as in 📋 Extract (your home folder becomes `~`, other private paths
  `[private path]`; keys and tokens are removed).
- Nothing is ever downloaded by the test.

## For developers

- Engine: `desktop-app/media-selftest.js` (Electron-free; every service is injected). Wiring: `main.js`
  (`mediatest:run|stop|status|copy|open-report`, live event `media-selftest`). Player check: `media-probe.js`
  (hidden window + `media-probe.html`). UI: `media-selftest-ui.js`.
- FramePack status now carries `attention`, `loadTimes` (the last load's stage times) and `pid`.
- Step time limits can be overridden with `AUTOINJECTOR_MEDIATEST_TIMEOUTS='{"fp-load":60000}'`.
- Tests: `node test/media-selftest.test.js` (fake Forge, the real FramePack engine with the fake runner, failing /
  hanging / stopped steps, redaction) and `xvfb-run -a node test/e2e/media-selftest.e2e.js` (the real app:
  Quick, Full with one failing step, ⏹ Stop mid-run, report files, 📋 Copy, 📋 Extract).
