# Voice — make AutoInjector speak & listen (fully local)

The butler (System AI supervisor) can say its acknowledgment, status, and result
aloud, and you can talk to it. It talks to a small **local shim**
(`voice_shim.py`) that wraps offline text-to-speech and speech-to-text — no
cloud, matching AutoInjector's ethos. This mirrors the Open Interpreter
integration exactly (shim + provider + auto-spawn).

## Two ways to connect

### A) Let AutoInjector run it (recommended — least work)

Set these before launching AutoInjector and it spawns the shim on startup, waits
until it's healthy, and points itself at it. Nothing else to start.

```
AUTOINJECTOR_VOICE_SPAWN=python           # the command to run the shim
AUTOINJECTOR_VOICE_PORT=8232              # optional (default 8232)
# Optional: pick specific local models
AUTOINJECTOR_VOICE_TTS_MODEL=/path/to/piper-voice.onnx
AUTOINJECTOR_VOICE_STT_MODEL=base.en
```

Then turn Voice on in the **System AI panel** (the "🔊 Voice" section): check
"Speak the butler's replies aloud", Save. Use **🎤 Talk** to dictate a goal.

### B) Run the shim yourself, point AutoInjector at it

```
pip install piper-tts faster-whisper sounddevice
python integrations/voice/voice_shim.py --port 8232
```

Then set the endpoint `http://127.0.0.1:8232` in the System AI panel's Voice box
(or `POST /voice/settings {enabled:true, endpoint:"..."}` on the bridge).

## The shim in one paragraph

`voice_shim.py` is stdlib + optional `piper-tts` / `faster-whisper`. It exposes
`GET /health`, `POST /speak {text}`, and `POST /listen {seconds?}`. TTS uses
piper if available, else the OS `say`/`espeak`; STT uses faster-whisper. Every
backend is lazy-imported and degrades gracefully — with no backend the plumbing
still answers and `/speak` returns `{ok:false, error:"NO_TTS", hint:"..."}`
rather than crashing. Bind is localhost-only, and each response closes its
connection so strict HTTP/1.1 clients see a clean end.

## 🎤 / 🔊 in the control panel (`/transcribe`, `/synthesize`)

The control panel's 🎤 (title bar and each AI's header) records in the page and sends the audio here:

```
POST /transcribe  {"audio_b64": "<webm/opus, ogg or wav>", "mime": "audio/webm"}  -> {"ok":true,"text":"…","device":"cuda|cpu","model":"base.en"}
POST /synthesize  {"text": "…", "voice": "en_GB-alan-medium"}                       -> {"ok":true,"audio_b64":"<WAV>","mime":"audio/wav","voice":"…"}
GET  /voices                                                                        -> {"ok":true,"voices":["en_US-lessac-medium", …]}
```

- **Speech-to-text** decodes the recording with `faster_whisper.decode_audio` (PyAV) and runs whisper on the
  graphics card when CUDA works (`float16`), else on the CPU (`int8`) — also when CUDA only fails at the first
  transcription (missing cuBLAS/cuDNN). The model is loaded once and kept. `VOICE_STT_MODEL` picks it; the default is
  `small.en` on a graphics card and `base.en` (about 150 MB, downloaded on first use) on the CPU. `/health` says which
  model, whether it is loaded or already downloaded (`stt_model`, `stt_loaded`, `stt_cached`, `stt_mb`), so the app can
  say "the first time it downloads the speech model".
- **Piper voices:** `VOICE_MODELS_DIR` (the app passes `stuff and thing/models/voice`) — every `.onnx` there is a
  voice, named without `.onnx`; `VOICE_TTS_MODEL` is the default one. Voices are loaded once and kept. The page plays
  the WAV itself, so ⏹ Stop is instant. With no piper voice, `/synthesize` answers `NO_TTS_MODEL` and the page uses the
  PC's built-in voices instead.
- **✨ Kokoro (optional, best quality):** when `kokoro-onnx` is installed and `VOICE_KOKORO_DIR` (default
  `<VOICE_MODELS_DIR>/kokoro`) holds `kokoro-v1.0.onnx` + `voices-v1.0.bin`, `/synthesize {engine:"kokoro",
  kokoro_voice:"af_heart", device:"cpu"|"gpu"}` reads with Kokoro (24 kHz WAV, `engine:"kokoro"`). `cpu` (the
  default, also `VOICE_KOKORO_DEVICE`) uses half the processor's cores and leaves the graphics card alone; `gpu` uses
  a graphics-card onnxruntime provider when one is installed, else the processor. Any problem (no package, no model,
  an unknown voice, a crash) falls back to piper with the same request and adds `fallback_from:"kokoro"` and
  `kokoro_error`. `/health` adds `kokoro`, `kokoro_model`, `kokoro_ready`, `kokoro_loaded`, `kokoro_device`;
  `/voices` adds `kokoro_voices` once it is loaded. `/health` also reports `python` (`sys.executable`): the app
  installs Kokoro into exactly that interpreter. Tests with a fake Kokoro: `python -m pytest -q integrations/voice`.
- Errors are codes (`NEED_AUDIO`, `BAD_AUDIO`, `NO_STT`, `STT_FAILED`, `NEED_TEXT`, `BAD_VOICE`, `TEXT_TOO_LONG`,
  `NO_TTS`, `NO_TTS_MODEL`, `TTS_FAILED`); the app turns them into plain words. A `voice` is only ever a name from
  the folder, never a path.

## Verify

### One-command smoke test (no butler, no AutoInjector needed)

The fastest way to confirm voice works **on its own**, before the butler is ever
engaged:

```
node integrations/voice/smoke-test.js
```

It spawns the shim on a free port, checks `GET /health`, asserts the plumbing
(`POST /speak` empty → `400 NEED_TEXT`, bad JSON → `400 BAD_JSON`; `/transcribe` with no audio → `400 NEED_AUDIO`,
junk audio → a clean `{ok:false}`; `/synthesize` empty → `400 NEED_TEXT`, a path as the voice → `400 BAD_VOICE`, too
long → `413 TEXT_TOO_LONG`; `GET /voices`), then tries a
real `/speak` and reports whether a TTS backend is installed. No backend is not a
failure — it reports "shim OK, needs a backend". Options: `--port <n>`,
`--text "<words>"`; set `PYTHON=python3` if `python` isn't on PATH.

### By hand (curl)

```
curl -s http://127.0.0.1:8232/health
curl -s -X POST http://127.0.0.1:8232/speak  -H 'Content-Type: application/json' -d '{"text":"hello there"}'
curl -s -X POST http://127.0.0.1:8232/listen -H 'Content-Type: application/json' -d '{"seconds":5}'
# through AutoInjector's bridge (also independent of the butler):
curl -s -X POST http://127.0.0.1:8765/voice/speak -H 'Content-Type: application/json' -d '{"text":"hello"}'
```
