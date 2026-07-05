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

- Node.js — the one thing you need installed. Get it free from
  [nodejs.org](https://nodejs.org/) (pick the **LTS** button), run the installer,
  click through with defaults, done. (This is what actually runs the app — there's
  no separate "AutoInjector install", it's not on an app store.)
- Windows, macOS, or Linux desktop (Electron doesn't run on Android/iOS — see the
  root `README.md` for the Android path, which reuses the browser extension in
  Kiwi Browser instead)

## Quick start (recommended — no typing commands)

1. Get the code onto your computer: on the GitHub page for this repo, click the
   green **Code** button → **Download ZIP**, then unzip it wherever you like.
   (If you already use git, `git clone` works too.)
2. Open the `desktop-app` folder.
3. Double-click:
   - **Windows** → `run-windows.bat`
   - **macOS** → `run-mac.command`
     (macOS will likely warn "unidentified developer" the first time — right-click
     the file → **Open** → **Open** to approve it once. See "macOS Gatekeeper" below
     if you still get blocked.)
   - **Linux** → open a terminal in that folder and run `./run-linux.sh`
     (or double-click it if your file manager runs `.sh` scripts)
4. First time only: a black/terminal window pops up and installs dependencies —
   this takes a minute or two and only happens once. After that it opens the app
   window automatically.
5. Every time after that, the same double-click just opens the app directly
   (a few seconds).

That's the "one click" version — the launcher script handles installing and
starting for you. Nothing gets installed system-wide; it all lives inside the
`desktop-app` folder (well, inside its `node_modules` subfolder), so deleting the
folder removes it cleanly.

### macOS Gatekeeper

If double-clicking `run-mac.command` does nothing or says it's damaged/blocked,
open Terminal, `cd` into the `desktop-app` folder, and run:
```bash
xattr -d com.apple.quarantine run-mac.command
```
then double-click it again.

## Run it manually (if you prefer the terminal)

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

The window is laid out with the **control panel as the main view** (left/center)
and the three AI panes stacked as a strip on the **right side** — you mostly work
from the control panel, and only need the panes themselves to sign in or eyeball
what's actually happening on a site.

1. Sign in to whichever sites you want to include, in their panes on the right.
2. **Participants** (top): uncheck any AI you want to sit out — everything below
   only applies to checked ones.
3. **Compose** (top-left): type a message and click **→ ChatGPT** / **→ Claude** /
   **→ Gemini** / **→ All** to send it to one, some, or all checked participants —
   this is also how you interject at any point, auto running or not.
4. Each AI has its own card. The moment a pane's reply finishes streaming (checked
   every ~1.5s, waits for the text to stop changing), it shows up in that card's
   preview and gets logged to the transcript. Forwarded replies always get labeled
   (`[ChatGPT says] ...`) so whoever receives it knows who said what.
5. **Global controls**:
   - **Auto** — turns on full back-and-forth forwarding between every checked
     participant: whatever one says gets forwarded to the others, whose replies
     get forwarded back, and so on — this is the "three-way conversation" mode.
     With 2+ participants it will run indefinitely once started.
   - **Pause** — halts all forwarding but keeps your participant selection, so
     hitting **Auto** again picks up where you left off.
   - **Stop** — halts all forwarding *and* unchecks every participant, forcing a
     deliberate restart.
   - A card's own **Forward**/**Auto → X** buttons still work independently, for
     fine-grained one-off or standing routes instead of the full-mesh version.
6. **Hide Browser Panes** shrinks the site panes to nothing so the control panel
   gets the whole window (they keep running in the background) — **Show Browser
   Panes** brings them back, e.g. to log in or check what a site is actually
   doing.
7. **Copy Transcript** / **Download .md** save the running conversation locally
   so you can share it elsewhere (e.g. email it to someone).

### Troubleshooting

The **Activity / Troubleshooting** panel next to the transcript logs every
internal action live — polls that captured a new reply, sends, forwards, errors,
routing/participant changes — each with a timestamp, so if something isn't
working you can see exactly where it's getting stuck instead of guessing.

If a specific AI's card never shows a captured reply even though its pane clearly
has one on screen, that means the DOM selector for reading its messages
(`selectors.js`) doesn't match that site's current layout — sites change their
markup without notice. Click the 🔍 button on that AI's card to open Chrome
DevTools on that exact pane, right-click the assistant's reply bubble → **Inspect**,
and send me the element's tag/class/attributes — that's what lets me fix the
selector for real instead of guessing again.

## How it's built

- `main.js` — Electron main process. Creates the window, one `WebContentsView` per
  AI site plus one for the control panel, lays them out (control panel main view,
  site panes as a collapsible side strip), polls each pane's latest reply every
  ~1.5s to detect when it's finished streaming, routes messages (manual, per-pane
  auto, or the global full-mesh Auto) between panes, and keeps an in-memory
  activity log of everything that happens.
- `automation.js` / `selectors.js` — build two small scripts run inside each AI's
  pane via `webContents.executeJavaScript()`: one to type text into the chat box
  and click send, one to just read whatever the latest reply currently says.
  Mirrors the selectors used by the browser extension's `content.js`/`selectors.js`.
- `controls.html` / `controls.js` / `preload.js` — the control panel UI, talking to
  the main process over `ipcRenderer`/`contextBridge` (no direct Node access from
  the page, same as the sites' own panes).

Selectors are best-effort with fallbacks, same caveat as the extension: if a site
redesigns its chat UI, `selectors.js` is the first place to fix — use the 🔍
Inspect button described above to get the real answer instead of guessing.

## Building a real installer (.exe / .dmg / .AppImage)

The `run-*` scripts above are the fastest way to get running (they still need
Node.js once), but if you want an actual double-clickable installer that bundles
Node/Electron so nothing needs to be installed at all, this repo is wired up for
that too, via [electron-builder](https://www.electron.build/):

```bash
cd desktop-app
npm install
npm run dist          # builds for whatever OS you're running this on
# or target a specific OS explicitly:
npm run dist:win      # -> dist/*.exe (NSIS installer)
npm run dist:mac      # -> dist/*.dmg
npm run dist:linux    # -> dist/*.AppImage
```

The output lands in `desktop-app/dist/`. That installer file is the thing you'd
actually hand someone else to install with one double-click, no Node.js required
on their end. Building for an OS other than the one you're on ("cross-building",
e.g. making a `.exe` from macOS/Linux) can need extra platform tooling — building
on the target OS itself is the most reliable option.

I wired up the config but haven't produced/tested an actual build here (this
dev environment can't download the Electron binaries needed to build) — if
`npm run dist` errors out for you, send me the output and I'll fix the config.
