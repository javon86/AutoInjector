# N1 — Live end-to-end verification (run on your machine)

Everything the butler needs is built and tested: the integration harness drives
the whole loop — classify → delegate → RUN_CODE → USE_TOOL → REMEMBER/RECALL →
FINISH — with a stubbed model, so the **orchestration is proven**. The one step a
CI sandbox can't do is let a *real* local model make the decisions. This is that
step, on your own machine (a real LLM + optional local voice/OI backends).

## 1. Bring up a local model (Ollama)

```
ollama serve                 # starts the server on http://localhost:11434
ollama pull llama3.1         # any instruct model works
```

## 2. (Optional) bring up the local capabilities

```
# Open Interpreter (RUN_CODE)
AUTOINJECTOR_INTERPRETER_SPAWN=python \
AUTOINJECTOR_INTERPRETER_API_BASE=http://localhost:11434 \
AUTOINJECTOR_INTERPRETER_MODEL=ollama/llama3.1 \
# Voice (speak/listen) — needs `pip install piper-tts faster-whisper sounddevice`
AUTOINJECTOR_VOICE_SPAWN=python \
  npm start   # (set the vars you want, then launch)
```

Or verify each independently, without the butler:

```
node integrations/open-interpreter/smoke-test.js
node integrations/voice/smoke-test.js
```

## 3. Configure the butler

In the **System AI (Supervisor)** panel:
- Endpoint `http://localhost:11434/v1/chat/completions`, pick your model, **Save**.
- Optional: check **Speak the butler's replies aloud** + Save (Voice section).

## 4. Give it a goal that exercises the whole stack

> *"Look up example.com, remember one key fact from it, compute 6×7, and tell me
> the result."*

Watch, in the panel's status/log:
- **Instant ack** ("On it — working on: …"), spoken aloud if Voice is on. **(N2)**
- **Awareness** line shows 🟢/🟡/⛔ per pane; the butler won't delegate to a
  busy or rate-limited one. **(N4)**
- **PLAN → DELEGATE** to ChatGPT/Claude/Gemini.
- **USE_TOOL** `http-fetch` for example.com. **(N5)**
- **REMEMBER** the fact, then **RECALL** it (Memory line count ticks up). **(N3)**
- **RUN_CODE** computes 42 (Open Interpreter). **(N1/OI)**
- **FINISH**, spoken ("Done.").

## 5. Capture evidence

Click **⤓ Extract All** to dump the full conversation + activity/error log to
`Documents/AutoInjector/output/logs/…txt`, and screenshot the panel. That dump +
screenshot is the live-run evidence.

> If a step doesn't fire, it's a model-prompting nuance (a small local model may
> not choose USE_TOOL/RECALL on its own) — not a wiring gap: the harness proves
> every action's plumbing. Nudge the goal (e.g. "use the http-fetch tool to …")
> or use a stronger model.
