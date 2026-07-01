# AutoInjector

A Chrome (MV3) extension that automates the ChatGPT, Claude and Gemini **web UIs** by
copy/paste-style DOM injection — no API keys needed, it drives your already-logged-in
browser tabs. It ships two things:

1. **Fake OpenAI bridge** — a local WebSocket/HTTP server (`server/`) that lets any
   OpenAI-API-compatible client talk to the ChatGPT web UI as if it were the real API.
2. **AI Roundtable** — a round-robin conversation runner that takes a topic, sends it
   to ChatGPT, feeds the reply to Claude, feeds *that* reply to Gemini, and so on,
   keeping one running local transcript you can copy or download.

> Automating these sites' web UIs may be against their terms of service. This tool
> only drives tabs where *you* are already signed in, in *your* own browser — use it
> at your own discretion and risk.

## Install the extension

1. Open `chrome://extensions`, enable **Developer mode**.
2. Click **Load unpacked** and select `AutoInjector/extension/`.
3. Sign in to [chatgpt.com](https://chatgpt.com), [claude.ai](https://claude.ai) and/or
   [gemini.google.com](https://gemini.google.com) in normal tabs.

## AI Roundtable (ChatGPT + Claude + Gemini)

1. Click the AutoInjector toolbar icon → **Open AI Roundtable**. This opens a full
   extension page (`roundtable.html`).
2. Under **Tabs**, hit **Refresh**, or use **Open ChatGPT / Open Claude / Open Gemini**
   to launch tabs for any site you don't already have open. Pick which tab to use per
   site if you have several.
3. Under **Setup**, enter a topic/opening message, pick which of the three AIs should
   participate (need at least two), who starts, and how many rounds to run.
4. Click **Start Roundtable**. The extension will, in order:
   - inject the topic (or the running conversation so far) into the active
     participant's chat box,
   - click send,
   - watch the DOM until a reply finishes streaming,
   - append that reply to the local transcript,
   - hand the whole transcript to the next participant as context, and repeat.
5. Watch replies stream into the **Transcript** panel in real time. Use **Stop** to
   end the run after the current reply. **Copy Transcript** copies a Markdown version
   to your clipboard; **Download .md** saves it as a file — handy for sending to
   someone (e.g. a teacher) or archiving.

The transcript is kept in the extension's local storage, so it survives closing and
reopening the roundtable page (it's cleared with the **Clear** button).

### How it works

- `selectors.js` holds a set of DOM selector candidates per site (input box, send
  button, assistant message container). Each site's UI can change at any time, so
  these are best-effort with several fallbacks — if a site updates its layout and
  injection stops working, this is the first file to fix.
- `content.js` is injected into ChatGPT/Claude/Gemini pages and exposes an
  `INJECT_AND_WAIT` message: it types/pastes text into the input, clicks send, and
  resolves once the DOM stops changing (i.e. the reply finished streaming).
- `background.js` (the MV3 service worker) discovers tabs per site, drives the
  round-robin loop, and broadcasts live updates to any open popup/roundtable page.

## Fake OpenAI bridge

See `server/` for the local HTTP/WebSocket bridge that exposes an
OpenAI-compatible `/v1/chat/completions` endpoint backed by the ChatGPT web UI tab.
Start it with `server/start_server.bat` (or `.ps1`) and use the extension popup's
Preflight/Self-Test/Dry-Run/Live Test buttons to verify connectivity.
