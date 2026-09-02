# Open Interpreter — make it work with AutoInjector (minimal effort)

AutoInjector's `RUN_CODE` capability (and the `/interpreter/*` bridge routes, and
Jarvis's code arm) all talk to a small local endpoint. Open Interpreter doesn't
speak that shape out of the box, so this folder has a tiny **shim** that bridges
them — and AutoInjector can **run the shim for you**.

## Two ways to connect

### A) Let AutoInjector run it (recommended — least work)

Set these before launching AutoInjector and it spawns the shim on startup, waits
until it's healthy, and points itself at it. Nothing else to start.

```
AUTOINJECTOR_INTERPRETER_SPAWN=python           # the command to run the shim
AUTOINJECTOR_INTERPRETER_PORT=8231              # optional (default 8231)
# Optional: run fully local via Ollama (no cloud key needed)
AUTOINJECTOR_INTERPRETER_API_BASE=http://localhost:11434
AUTOINJECTOR_INTERPRETER_MODEL=ollama/llama3.1
```

(One-time: `pip install open-interpreter`.) AutoInjector runs
`python integrations/open-interpreter/interpreter_shim.py --port 8231`, then
`RUN_CODE` / `/interpreter/run` just work. It's stopped automatically on quit.

### B) Run the shim yourself, point AutoInjector at it

```
pip install open-interpreter
python integrations/open-interpreter/interpreter_shim.py --port 8231
```
Then set `AUTOINJECTOR_INTERPRETER_ENDPOINT=http://127.0.0.1:8231/run` (or
`POST /interpreter/settings`).

## The shim in one paragraph

`interpreter_shim.py` is stdlib + `open-interpreter` only. It exposes
`GET /health` and `POST /run {task, auto_run}`. On `/run` it calls
`interpreter.chat(task, stream=True)` and forwards each streamed event as one
JSON line — which is already the exact shape AutoInjector normalizes — then a
final `{"type":"done"}`. `auto_run` is **off** unless the request asks for it (or
`SHIM_AUTO_RUN=1`), so code waits for confirmation by default. Bind is
localhost-only.

## Running local (no cloud)

Point Open Interpreter at a model you already run locally — e.g. the same Ollama
you use for AutoInjector's System AI:

```
INTERPRETER_MODEL=ollama/llama3.1 INTERPRETER_API_BASE=http://localhost:11434 \
  python integrations/open-interpreter/interpreter_shim.py --port 8231
```

## Verify

```
curl -s http://127.0.0.1:8231/health
curl -s -X POST http://127.0.0.1:8231/run -H 'Content-Type: application/json' -d '{"task":"what is 2+2"}'
# through AutoInjector:
curl -s -X POST http://127.0.0.1:8765/interpreter/run -H 'Content-Type: application/json' -d '{"task":"what is 2+2"}'
```

## Note on the Rust build

Newer Open Interpreter is a Rust binary that speaks ACP. This shim targets the
**Python `open-interpreter` package** (the one with `interpreter.chat`). If you
run the Rust build, expose it however it supports and set
`AUTOINJECTOR_INTERPRETER_ENDPOINT` to a `/run`-compatible endpoint (a similar
~40-line shim over its API works the same way).
