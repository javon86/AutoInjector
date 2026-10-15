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

## Verify

### One-command smoke test (no butler, no AutoInjector needed)

The fastest way to confirm voice works **on its own**, before the butler is ever
engaged:

```
node integrations/voice/smoke-test.js
```

It spawns the shim on a free port, checks `GET /health`, asserts the plumbing
(`POST /speak` empty → `400 NEED_TEXT`, bad JSON → `400 BAD_JSON`), then tries a
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
