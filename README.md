# AutoInjector

Automates the ChatGPT, Claude and Gemini **web UIs** by copy/paste-style DOM
injection — no API keys, it drives your already-logged-in browser sessions, so
you can get two or three AIs working on the same problem together and keep one
running local transcript you can copy or download (e.g. to send to someone).

Two ways to run it, same underlying automation:

|  | `extension/` | `desktop-app/` |
| --- | --- | --- |
| What it is | Chrome (MV3) browser extension | Standalone Electron program |
| Platforms | Desktop Chrome (and Kiwi Browser on **Android**, see below) | Desktop only (Windows/macOS/Linux) |
| UI | Extension popup + a roundtable tab, fixed turn order | One window, three AI panes side by side you watch live, message routing (send to one/some/all, one-off or on autopilot) |
| Setup | Load unpacked in Chrome | Double-click a launcher script — see below |

Plus a **fake OpenAI bridge** (`server/`) — a local WebSocket/HTTP server that lets
any OpenAI-API-compatible client talk to the ChatGPT web UI as if it were the real
API. That's separate from the roundtable feature and only ships with the extension.

> Automating these sites' web UIs may be against their terms of service. This tool
> only drives sessions where *you* are already signed in, in *your* own
> browser — use it at your own discretion and risk.

## Android

Mobile Chrome/Safari don't support installing extensions, and a native app
embedding these sites in a WebView **can't** log into Google (Google blocks
sign-in inside embedded WebViews), so Gemini wouldn't work that way. The one path
that actually works: install [**Kiwi Browser**](https://kiwibrowser.com/) (a real
Chromium browser for Android that supports loading desktop extensions), then load
the same `extension/` folder as an unpacked extension there (Kiwi → Extensions →
Developer mode → Load unpacked, point it at the `extension/` folder copied onto
the device). Because it's a genuine browser engine and not an embedded WebView,
sign-in to all three sites works normally, and the same roundtable page runs as-is.

## Desktop app

The easiest way to try this: go into `desktop-app/`, double-click `run-windows.bat`
(Windows) or `run-mac.command` (macOS) — it installs what it needs the first time
and opens one window with ChatGPT, Claude and Gemini as three live panes plus a
control panel for routing messages between them. No Chrome/extension needed, only
[Node.js](https://nodejs.org/) as a one-time prerequisite. Full walkthrough,
Linux instructions, and how to build a real `.exe`/`.dmg` installer are in
[`desktop-app/README.md`](desktop-app/README.md).

## Install the extension

1. Open `chrome://extensions`, enable **Developer mode**.
2. Click **Load unpacked** and select `AutoInjector/extension/`.
3. Sign in to [chatgpt.com](https://chatgpt.com), [claude.ai](https://claude.ai) and/or
   [gemini.google.com](https://gemini.google.com) in normal tabs.

## AI Roundtable (ChatGPT + Claude + Gemini) — extension version

1. Click the AutoInjector toolbar icon → **Open AI Roundtable**. This opens a full
   extension page (`roundtable.html`).
1. Under **Tabs**, hit **Refresh**, or use **Open ChatGPT / Open Claude / Open Gemini**
   to launch tabs for any site you don't already have open. Pick which tab to use per
   site if you have several.
1. Under **Setup**, enter a topic/opening message, pick which of the three AIs should
   participate (need at least two), who starts, and how many rounds to run.
1. Click **Start Roundtable**. The extension will, in order:
- inject the topic (or the running conversation so far) into the active
     participant's chat box,
- click send,
- watch the DOM until a reply finishes streaming,
- append that reply to the local transcript,
- hand the whole transcript to the next participant as context, and repeat.
1. Watch replies stream into the **Transcript** panel in real time. Use **Stop** to
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
