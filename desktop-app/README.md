# AutoInjector Desktop

One program, one window: ChatGPT, Claude and Gemini as three real Chromium panes
side by side, with a control panel that round-robins a topic between them by
copy/paste-style DOM automation — no API keys, uses your normal logged-in sessions.

This is the desktop counterpart to the `AutoInjector/extension` Chrome extension —
same automation idea (type into the chat box, click send, wait for the reply,
hand it to the next AI), just packaged as a standalone app instead of a browser
extension, so you don't need Chrome open with three tabs.

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

## Using the roundtable

1. Sign in to whichever sites you want to include.
2. In the control panel (top strip): enter a topic, pick participants (need at
   least two), who starts, and how many rounds.
3. Click **Start**. Watch it work live in the panes below — you'll literally see
   the text get typed into each AI's box, sent, and the reply stream in.
4. **Copy Transcript** / **Download .md** in the control panel save the running
   conversation locally so you can share it elsewhere (e.g. email it to someone).

## How it's built

- `main.js` — Electron main process. Creates the window, one `WebContentsView` per
  AI site plus one for the control panel, lays them out, and runs the round-robin
  loop.
- `automation.js` / `selectors.js` — build the one-shot script injected into each
  AI's pane via `webContents.executeJavaScript()` to type text, click send, and
  wait for the DOM to stop changing (i.e. the reply finished). Mirrors the same
  selectors used by the browser extension's `content.js`/`selectors.js`.
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
