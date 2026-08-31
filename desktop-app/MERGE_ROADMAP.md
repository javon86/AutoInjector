# Merging AutoInjector + PersonalJarvis + Open Interpreter

Goal: make these three work as **one system**. They are two languages and three
repos, so "merged" means one system through clean seams — not one fused codebase.
This session can only write to the AutoInjector repo; PersonalJarvis and Open
Interpreter are integrated *through their interfaces*, not by copying their code.

## The architecture (who does what)

```
                ┌───────────────────────────┐
   voice / chat │      PersonalJarvis        │  the HUB: voice, brain,
   ───────────► │  Supervisor → Mission →    │  Supervisor→Critic orchestration
                │  Critic → Kontrollierer     │  (Python + React; its own repo)
                └─────────────┬──────────────┘
                              │ drives capabilities over local APIs
              ┌───────────────┼─────────────────────┐
              ▼                                      ▼
   ┌─────────────────────┐              ┌──────────────────────────┐
   │     AutoInjector    │              │    Open Interpreter       │
   │  "Council" of 3 web │              │  "run code / control the  │
   │  AIs via browser    │              │   computer" code agent    │
   │  panes (this repo)  │              │  (Python/Rust; its repo)  │
   │  → service bridge   │              │  → local server / ACP     │
   └─────────────────────┘              └──────────────────────────┘
```

- **PersonalJarvis is the orchestrator.** It is literally built to route heavy
  work to capability-selected workers and gate the result through a Critic. It
  supplies voice, memory, and the "butler."
- **AutoInjector is the Council capability** — the three web AIs (ChatGPT,
  Claude, Gemini) driven by copy/paste, reachable via the **service bridge**
  (`service-bridge.js`, `SERVICE_BRIDGE.md`) already shipped on `main`.
- **Open Interpreter is the code-execution capability** — it runs Python/shell
  and controls the machine.

Why this shape: none of the three should be rewritten. Each already exposes a
local interface (PJ's control API; AutoInjector's bridge; OI's server/ACP), so we
connect them instead of merging source in two languages.

## What is built in THIS repo (phase 1 — done)

Open Interpreter is now a first-class capability *inside* AutoInjector, exposed
through the same service bridge, so the whole merged system can drive it:

- **`interpreter-provider.js`** — a tolerant adapter to a locally-running Open
  Interpreter (endpoint-configurable, like the manager supervisor). `run(task)`
  streams normalized execution events — `message` / `code` / `output` /
  `confirmation` / `done` — and accepts both OI's native "lmc" chunks and a small
  simple JSON contract, so it survives OI's version churn.
- **Service-bridge routes** (`service-bridge.js`): `GET /interpreter/status`,
  `POST /interpreter/settings`, `POST /interpreter/run {task}`. Each execution
  event is streamed live over the existing SSE `/events` channel as an
  `interpreter` event; the final result returns on the HTTP response.
- **main.js wiring**: the adapter is handed to the bridge; env-configurable at
  boot (`AUTOINJECTOR_INTERPRETER_ENDPOINT`, `_MODEL`, `_TOKEN`, `_AUTORUN`).
- **Tests**: `interpreter-provider.test.js` (15/0, stub OI server) and the bridge
  test's interpreter section (36/0 total). No real OI needed to test.

### Pointing it at a real Open Interpreter

Run Open Interpreter as a local server (its classic Python server, the Rust
build, or a ~30-line shim) that accepts `POST {task, auto_run}` and streams
events, then set `AUTOINJECTOR_INTERPRETER_ENDPOINT=http://127.0.0.1:<port>/run`
(or `POST /interpreter/settings`). Nothing else changes.

## PersonalJarvis side (phase 2 — glue, not in this repo)

PersonalJarvis already selects workers and grants tools by capability. Two small
additions on the PJ side (its repo, which this session cannot push to) complete
the merge — provided here as the contract to implement:

1. **A Council tool/worker** that calls AutoInjector's bridge:
   - `POST http://127.0.0.1:8765/send {text}` (or `/participants/<id>/send`),
   - `POST /council/start {mode, topic, rounds}` / `/council/stop`,
   - subscribe to `GET /events` for `response` / `generation` / `error`.
   Registered as a router-tier tool so the Supervisor can delegate "ask the
   Council" / "run a debate" and read the replies back.
2. **A code-execution tool** — either PJ drives Open Interpreter directly (it is
   ACP-compatible, and PJ already runs mission workers), or it calls AutoInjector's
   `POST /interpreter/run` so there is one code-exec path for the whole system.

Both go through PJ's normal Critic/Kontrollierer gate — which matches the
"capture is not completion / validated transition" principle we already use.

## Phase 3+ (later)

- Voice: reuse PJ's wake→STT→TTS so the merged system is voice-driven end to end.
- Memory: PJ's wiki/memory as the shared long-term store.
- One launcher that brings up PJ + AutoInjector + an OI server together.

## Honest status

Phase 1 (Open Interpreter inside AutoInjector, over the bridge) is built, tested,
and shippable. Phases 2–3 are cross-repo/cross-language integration that continue
from here — the seams are defined above so the work is incremental, not a rewrite.
Nothing was merged into PersonalJarvis; this only makes the pieces interoperable.
