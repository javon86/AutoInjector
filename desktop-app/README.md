# AutoInjector Desktop

One program, one window: ChatGPT, Claude and Gemini as three real Chromium panes
side by side, with a control panel that lets you route messages between them —
by copy/paste-style DOM automation, no API keys, using your normal logged-in
sessions. It's built for using two (or three) AIs together as thinking partners:
you send them a problem, and route replies between them however you want —
one-off, or on autopilot.

This is the desktop counterpart to the `AutoInjector/extension` Chrome extension —
same automation idea (type into the chat box, click send, watch for the reply),
just packaged as a standalone app instead of a browser extension, so you don't
need Chrome open with three tabs.

## Requirements

- Node.js 18+
- Windows, macOS, or Linux desktop (Electron doesn't run on Android/iOS — see the
  root `README.md` for the Android path, which reuses the browser extension in
  Kiwi Browser instead)

## Run it

```bash
cd desktop-app
npm install
npm start
```

On first launch each pane loads its site's normal web login page — sign in to
ChatGPT, Claude and Gemini directly in their panes, the same as any browser tab.
Each site gets its own isolated, persistent session (`persist:chatgpt`,
`persist:claude`, `persist:gemini`), so you only need to sign in once; it's
remembered across restarts. Use each pane's **Reload** button in the control panel
if a pane gets stuck or you need to re-navigate.

## Using it

1. Sign in to whichever sites you want to include, in their panes.
2. **Compose** (top-left): type an opening message and click **→ ChatGPT** /
   **→ Claude** / **→ Gemini** / **→ All** to kick things off with one, some, or
   all of them.
3. Each AI has its own card in the control panel. The moment a pane's reply
   finishes streaming (checked every ~1.5s, waits for the text to stop changing),
   it shows up in that card's preview and gets logged to the transcript.
4. From a card you can:
   - **Forward** — one-off: send that AI's latest reply to one specific other AI,
     or to both, right now.
   - **Auto → X** — toggle on to make *every future reply* from that AI get
     forwarded to X automatically, no clicking needed. Turning this on in both
     directions between two AIs makes them talk to each other indefinitely —
     use **Pause All Auto-Forward** (top right) to stop everything at once.
5. **Copy Transcript** / **Download .md** save the running conversation locally
   so you can share it elsewhere (e.g. email it to someone).

Nothing is forced into a fixed turn order — you decide per-message whether it's
one AI, a broadcast to all, or a standing auto-forward rule, so you can run two
AIs bouncing ideas off each other, broadcast one prompt to all three, or manually
curate which replies matter enough to forward on.

## How it's built

- `main.js` — Electron main process. Creates the window, one `WebContentsView` per
  AI site plus one for the control panel, lays them out, polls each pane's latest
  reply every ~1.5s to detect when it's finished streaming, and routes messages
  (manual or auto) between panes.
- `automation.js` / `selectors.js` — build two small scripts run inside each AI's
  pane via `webContents.executeJavaScript()`: one to type text into the chat box
  and click send, one to just read whatever the latest reply currently says.
  Mirrors the selectors used by the browser extension's `content.js`/`selectors.js`.
- `controls.html` / `controls.js` / `preload.js` — the control panel UI, talking to
  the main process over `ipcRenderer`/`contextBridge` (no direct Node access from
  the page, same as the sites' own panes).

Selectors are best-effort with fallbacks, same caveat as the extension: if a site
redesigns its chat UI, `selectors.js` is the first place to fix.

## Packaging an installer (optional, not set up yet)

This repo only wires up `npm start` for local/dev use. To ship a double-clickable
installer, add `electron-builder` or `electron-forge` and a build config — not
included here to keep the surface area small; happy to add it if you want a
distributable `.exe`/`.dmg`/`.AppImage`.
