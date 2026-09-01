# PersonalJarvis ↔ AutoInjector integration (paste-in)

These are **ready-to-paste PersonalJarvis plugin tools** that make PersonalJarvis
drive AutoInjector as a capability. They live here because this session can only
commit to the AutoInjector repo — copy them into your PersonalJarvis checkout.

They match PersonalJarvis's real Tool protocol (`jarvis/core/protocols.py`:
a class with `name` / `description` / `risk_tier` / `schema` and an
`async execute(args, ctx) -> ToolResult`, registered as a `jarvis.tool`
entry point).

## What they add

| Tool | What it does | Risk tier |
| --- | --- | --- |
| `council-ask` | Ask AutoInjector's Council of web AIs (ChatGPT/Claude/Gemini) — one or all — or run a debate/brainstorm/rotation, and read the replies back. | `monitor` |
| `run-code` | Run a coding/computer task through Open Interpreter via AutoInjector's bridge, and get the summary + code + output. | `ask` |

Both go through PersonalJarvis's normal Critic / Kontrollierer gate, like any
tool — which matches AutoInjector's own "capture is not completion / validated
transition" principle.

## Install (in the PersonalJarvis repo)

1. Copy the two files, preserving the path:
   ```
   jarvis/plugins/tool/council_ask.py
   jarvis/plugins/tool/interpreter_run.py
   ```
2. Add the two entry points from `pyproject-entrypoints.snippet.toml` under the
   existing `[project.entry-points."jarvis.tool"]` table in PersonalJarvis's
   `pyproject.toml`.
3. Re-register the plugins:
   ```
   pip install -e . --no-deps
   ```
   (`httpx` is already a PersonalJarvis dependency, so nothing new to install.)

## Configure the bridge location

Both tools read, in order, `ExecutionContext.config` then environment:

```
AUTOINJECTOR_BRIDGE_URL    default http://127.0.0.1:8765
AUTOINJECTOR_BRIDGE_TOKEN  optional; set it if you started AutoInjector's bridge
                           with AUTOINJECTOR_BRIDGE_TOKEN
```

## Bring the system up

1. **AutoInjector** (this repo): launch the Electron app. Its service bridge
   starts on `http://127.0.0.1:8765` (see `desktop-app/SERVICE_BRIDGE.md`). Sign
   the three panes into ChatGPT/Claude/Gemini.
2. **Open Interpreter**: run it as a local server and point AutoInjector at it —
   `AUTOINJECTOR_INTERPRETER_ENDPOINT=http://127.0.0.1:<port>/run` (or
   `POST /interpreter/settings`). See `desktop-app/MERGE_ROADMAP.md`.
3. **PersonalJarvis**: start it with the two tools installed. The Supervisor can
   now delegate "ask the Council / run a debate" (`council-ask`) and "run this
   code / do this on the computer" (`run-code`).

## Verify quickly (without PersonalJarvis)

The AutoInjector side is testable on its own:

```bash
curl -s http://127.0.0.1:8765/status
curl -s -X POST http://127.0.0.1:8765/send -H 'Content-Type: application/json' -d '{"text":"hello Council"}'
curl -s -X POST http://127.0.0.1:8765/interpreter/run -H 'Content-Type: application/json' -d '{"task":"what is 2+2"}'
```

## Note on the reverse direction

AutoInjector's own repo already carries the AutoInjector→OI half (the
`interpreter-provider.js` adapter + `/interpreter/*` bridge routes, tested). These
two files complete the PersonalJarvis→AutoInjector half. Voice, shared memory, and
a single launcher are the remaining phases in `desktop-app/MERGE_ROADMAP.md`.
