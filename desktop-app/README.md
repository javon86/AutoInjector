# AutoInjector Desktop

One program, two windows: ChatGPT, Claude and Gemini as three real Chromium panes
side by side, with a control panel that lets you route messages between them —
by copy/paste-style DOM automation, no API keys, using your normal logged-in
sessions. It's built for using two (or three) AIs together as thinking partners:
you send them a problem, and route replies between them however you want —
one-off, or on autopilot.

Alongside the **Automation** window (the panes + control panel, the "engine
room") there's a **Conversation** window — a separate, resizable/maximizable
window that's the one you actually watch and type into day to day. It shows
just the clean back-and-forth between the three AIs (who's speaking, who's up
next, a message box, Send/Start/Pause/Resume/Stop) with all the internal
automation machinery — copy/paste operations, internal prompts, silent
acknowledgments — kept out of view.

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

Each AI gets one merged column: a compact control strip on top (status, preview,
Forward/Auto/Regenerate buttons), its actual live browser pane directly below.
There's no separate "cards row" and "browser strip" anymore — unchecking that
AI in **Participants** collapses just its pane, but its control strip (and its
last captured reply) stays visible and usable.

1. Sign in to whichever sites you want to include, right in their panes.
2. **Participants** (top): uncheck any AI you want to sit out of Auto/"All" —
   its pane collapses too, since there's nothing to watch if it's not in play.
3. **Compose** (top-left): type a message and click **→ ChatGPT** / **→ Claude** /
   **→ Gemini** / **→ All** to send it to one, some, or all checked participants —
   this is also how you interject at any point, auto running or not. It warns you
   if a message is long enough that a site might choke on it.
4. The moment a pane's reply finishes streaming (checked every ~1.5s, waits for
   the text to stop changing), a soft chime plays, its column's preview updates,
   and it's logged to the transcript. While waiting on a reply, that column shows
   a pulsing amber dot; the instant it sends something new to another AI, that
   AI's whole column glows briefly so you can actually follow who's talking to
   whom. Forwarded replies are always labeled (`[ChatGPT says] ...`).
5. **Global controls**:
   - **Auto** — turns on full back-and-forth forwarding between every checked
     participant: whatever one says gets forwarded to the others, whose replies
     get forwarded back, and so on — this is the "three-way conversation" mode.
     With 2+ participants it will run indefinitely once started.
   - **Pause** — halts all forwarding but keeps your participant selection, so
     hitting **Auto** again picks up where you left off.
   - **Stop** — halts all forwarding *and* unchecks every participant, forcing a
     deliberate restart.
   - A column's own **Forward**/**Auto → X**/**↻ Regenerate** buttons still work
     independently, for fine-grained one-off routes or resending a prompt that
     missed the mark, instead of the full-mesh version.
6. **📌** on any transcript turn pins it, so you can spot it again later without
   scrolling back through everything.
7. **Copy Transcript** / **Download .md** save the running conversation locally
   (pinned turns are marked in the export) so you can share it elsewhere.

### Collapsing things when one screen isn't enough room

Everything that takes up screen space can be shrunk out of the way without
losing anything — nothing closes or resets, it just gets small:

- **Each AI's column** — click the **⌄** button in that column's header
  (next to 🔍 and ⟳) to collapse it to a thin strip; click it again (now **›**)
  to bring it back. This is purely visual — a collapsed AI is still enabled,
  still participating in Auto/House Rules, still receiving and capturing
  replies, it's just out of view. Independent per column — collapsing Claude's
  doesn't touch ChatGPT's or Gemini's.
- **Each whole window** — both the Automation window and the Conversation
  window have their own **⌄** button in a thin titlebar at the very top.
  Clicking it shrinks that entire window down to just that titlebar (same
  screen position, just much shorter); clicking it again (now **›**) restores
  it to exactly the size and position it had before. Since a collapsed
  Automation window's panes are, by definition, too small to see, this also
  automatically hides the live embedded browser views — nothing extra to
  manage.

## House Rules

Instead of manually wiring up Forward/Auto buttons, **House Rules** (in the
Global area) structures the whole conversation for you — pick a format, hit
**Start**, and it runs itself. It uses whatever's typed in **Compose** as the
topic/goal. While a House Rules run is active, the manual Auto/Pause buttons
are disabled (Stop always works and ends both) so there's only one thing
driving the conversation at a time.

- **Who Wants to Speak?** — each round, every checked AI is asked whether it
  has something worth adding (reply YES or NO). Only the ones that say yes get
  asked for their real point, which then gets recapped to everyone before the
  next round's check-in. Nobody's forced to talk every round.
- **Debate** — a fixed, randomly-shuffled speaking order. Each speaker
  responds to whoever went right before them, then hands off to the next.
  Runs for the **Rounds** you set (0 = until you hit Stop).
- **Free-for-All** — everyone's told the topic and can jump in on each other
  at any point — the open, unstructured version. Runs until you Stop it (no
  rounds limit).
- **Devil & Angel** *(needs all 3 participants checked)* — roles are
  auto-assigned, not user-picked: one AI is **Middle** (has the goal), one is
  **Devil** (attacks it), one is **Angel** (defends it). Middle's statement
  goes to both Devil and Angel; their replies both come back to Middle only —
  Devil and Angel never see each other — and Middle responds to both at once
  before the cycle repeats.
- **Chargeback** *(needs all 3 checked, and a Rounds value)* — two AIs
  (auto-assigned) argue opposite sides of the topic directly with each other;
  the third is a neutral **Referee** who watches everything live but stays
  silent until the rounds run out, then delivers a verdict naming a winner
  (marked with a 🏆 in the transcript).
- **Brainstorm** — collaborative, not adversarial: everyone builds on what's
  already been suggested. Runs like Free-for-All until you click **Wrap Up**,
  at which point one participant (auto-picked) is asked to pull everything
  into one final, fully fleshed-out plan (marked with a ✅ in the transcript).
- **Rotation** *(needs all 3 checked)* — the format behind the **Conversation**
  window (see below): a fixed ChatGPT → Claude → Gemini → ChatGPT cycle. Each
  AI keeps its own full history; only the newest reply gets relayed. Whoever's
  next in the cycle gets it framed as **RESPOND** and produces the next visible
  reply; the third AI (not yet its turn) gets it framed as **UPDATE** — told
  explicitly not to join in yet, just to stay caught up — and its one-word
  `"UPDATED"` acknowledgment is swallowed entirely, never shown anywhere.
  Unlike the other formats, the order is fixed on purpose, not shuffled.

Role assignments show up as a small badge next to that AI's name once a mode
with roles is running (that's the *structural* role auto-assigned by these
formats, like Devil/Angel/Referee — not the same thing as the optional Role
Assignment persona feature described below, which you set yourself).

## The Conversation window

This is the primary window for actually using the app once everyone's signed
in on the Automation side. It shows only the natural conversation:

- The current topic/question, each AI's visible reply in order, and who said
  it — nothing else. "UPDATED" acknowledgments, RESPOND/UPDATE instructions,
  and any other internal prompting never appear here, by construction: the
  shared transcript main.js maintains never contains that content in the
  first place, so this window has nothing left to filter out on the way in.
- Two speaker indicators up top — the AI that spoke most recently, and (once
  Rotation is running) whichever AI is up next.
- **Send** — delivers whatever's in the message box to all three AIs
  immediately, independent of whether Rotation is running. Use this to kick
  off a one-off exchange or interject at any point.
- **Start** — begins the ChatGPT → Claude → Gemini Rotation using the message
  box's text as the opening topic. ChatGPT always goes first.
- **Pause** / **Resume** — halts the rotation's message flow without losing
  its place (mode, round count, whose turn is next are all preserved); Resume
  picks back up exactly where it left off.
- **Stop** — ends the run for good (asks you to confirm first, since unlike
  Pause there's no undo); starting again means a fresh Start.
- Press **Enter** in the message box to send; **Shift+Enter** for a newline.
- **Role Assignment** *(optional, collapsed by default)* — give each AI its
  own persona for this conversation (e.g. Project manager, Critic,
  Fact-checker, Financial analyst) by typing a role and clicking Apply, or
  Clear to send it back to general-purpose. This only shapes *what* each AI
  contributes — it has no effect on *when* they speak, which is entirely
  driven by the Rotation order above. Structural roles from other House Rules
  formats (Devil/Angel/Referee/etc., if you started one from the Automation
  side) show up as a small badge on the relevant speaker chip too.
- **Copy** / **Download** at the top export the visible conversation, same
  idea as the Automation window's transcript export.

**If something goes wrong**, a banner appears right under the topic line
instead of the conversation just silently stalling:
- A send/read problem on one AI shows a short, generic notice (which AI, and
  to check the Automation window's Activity Log) — never the raw internal
  error text.
- If an AI hasn't replied in a few minutes, a "may be stuck" warning appears
  — worth checking the Automation window, or trying Pause then Resume.
- If a reply looks like a rate-limit/usage-cap message (short text matching
  phrases like "usage limit" or "try again later"), the run **auto-pauses**
  instead of relaying that message to the other AIs as if it were a real
  reply — the turn still shows up in the transcript (marked ⚠ USAGE LIMIT) so
  you can see what happened, and Resume once the limit clears.

The Automation window's panes and control panel keep working normally
alongside this — you can still sign in, reload a stuck pane, or watch the
Activity log there. Both windows share the same live state, so a reply
captured on one side shows up on the other instantly. If the Conversation
window isn't focused (or is collapsed) when a new reply lands, it also plays
a soft chime and flashes the window title until you switch back to it.

### Picking up where you left off

Your transcript, any custom Role Assignments, and an in-progress House Rules
run (if one was going) are saved to disk automatically as you go, and
restored the next time you open the app. A restored run always comes back
**paused**, never active — the app will never auto-send anything just because
you relaunched it; you decide when to hit Resume. This is separate from
signing in — each site's own login session is already remembered by the
browser pane itself (see above), independent of this.

The saved file lives at:
- **Windows**: `%APPDATA%\autoinjector-desktop\autoinjector-state.json`
- **macOS**: `~/Library/Application Support/autoinjector-desktop/autoinjector-state.json`
- **Linux**: `~/.config/autoinjector-desktop/autoinjector-state.json`

Delete that file (app closed) if you ever want a completely clean slate.

### Troubleshooting

The **Activity / Troubleshooting** panel next to the transcript logs every
internal action live — polls that captured a new reply, sends, forwards, errors,
routing/participant changes — each with a timestamp, so if something isn't
working you can see exactly where it's getting stuck instead of guessing.

That panel only shows the current session, though — if the app crashes or you
close it before catching the problem, that log is gone. A rolling copy is
also written to disk (capped at ~2000 lines) right next to the state file
above, as `autoinjector-debug.log`. If something breaks and you want help
tracking it down, that file plus a description of what you were doing is the
most useful thing you can send.

If a specific AI's card never shows a captured reply even though its pane clearly
has one on screen, that means the DOM selector for reading its messages
(`selectors.js`) doesn't match that site's current layout — sites change their
markup without notice. Click the 🔍 button on that AI's card to open Chrome
DevTools on that exact pane, right-click the assistant's reply bubble → **Inspect**,
and send me the element's tag/class/attributes — that's what lets me fix the
selector for real instead of guessing again.

## How it's built

- `main.js` — Electron main process. Creates two `BaseWindow`s: the Automation
  window (one `WebContentsView` per AI site plus one full-window
  `WebContentsView` for the control panel) and the Conversation window (a
  single full-window `WebContentsView`). Each site's pane is positioned by
  measuring an empty placeholder div (`#pane-slot-<site>`) inside the control
  panel's own HTML and copying its exact on-screen rectangle, so the live pane
  sits directly under that AI's control strip and collapses cleanly when the
  participant is unchecked — no hardcoded split. Polls each pane's latest
  reply every ~1.5s to detect when it's finished streaming, routes messages
  (manual, per-pane auto, the global full-mesh Auto, or a House Rules format)
  between panes, and keeps an in-memory activity log of everything that
  happens. A generic `broadcast()` sends every UI update to both windows at
  once, so they always stay in sync. The House Rules formats (including
  Rotation) are small state machines layered on top of the same capture
  events — each one reacts to a new reply by deciding who gets sent what next.
  Captures can also be swallowed *silently* (never reaching the transcript or
  either window) — used for Chargeback's Referee acknowledgments and
  Rotation's "UPDATED" confirmations. A short list of rate-limit/usage-cap
  phrases is checked against every new reply while a House Rules run is
  active — a match auto-pauses the run instead of relaying it as a real
  contribution. Transcript, custom roles, and paused-run state are written to
  a debounced JSON snapshot in `app.getPath("userData")` on every meaningful
  change and reloaded on startup (always as **paused**, never active — a
  restart must never auto-send). `logEvent()` also appends every internal
  event to a capped, rolling debug log file in the same folder, so a real
  crash still leaves something to troubleshoot from.
- `automation.js` / `selectors.js` — build two small scripts run inside each AI's
  pane via `webContents.executeJavaScript()`: one to type text into the chat box
  and click send, one to just read whatever the latest reply currently says.
  Mirrors the selectors used by the browser extension's `content.js`/`selectors.js`.
- `controls.html` / `controls.js` — the Automation window's control panel UI.
- `conversation.html` / `conversation.js` — the Conversation window's UI:
  renders the shared transcript, current/next speaker, Send/Start/Pause/
  Resume/Stop, and Role Assignment.
- `preload.js` — the IPC bridge shared by both windows, talking to the main
  process over `ipcRenderer`/`contextBridge` (no direct Node access from
  either page, same as the sites' own panes).

Selectors are best-effort with fallbacks, same caveat as the extension: if a site
redesigns its chat UI, `selectors.js` is the first place to fix — use the 🔍
Inspect button described above to get the real answer instead of guessing.

## Running the test suite

```bash
npm test
```

This mocks out Electron itself (`test/mock-electron.js`) — no browser, no display
needed — and requires the real `main.js` against it, driving it through its
actual IPC handlers exactly like the control panel does: simulate a reply
appearing on a site, check what gets sent next. It covers the House Rules state
machines (Debate's turn order and round-ending, Devil & Angel's role isolation
and fan-in, Chargeback's silent Referee and final verdict, Who Wants to Speak's
opt-in filtering, Free-for-All/Brainstorm's mesh setup and teardown, Rotation's
fixed RESPOND/UPDATE cycle and its "UPDATED" acks never reaching the
transcript), Pause/Resume round-tripping routing state, Role Assignment's
persona clause injection, window-collapse bounds math (shrinks to a 44px
titlebar in place and restores the exact original bounds — including
temporarily relaxing the Conversation window's minHeight so it can actually
collapse, then putting it back), and a couple of routing edge cases (disabling
a participant mid-run, House Rules' own Stop button actually clearing the
mesh it set up).

`npm test` also runs `test/conversation.test.js`, which loads the *real*
`conversation.html`/`conversation.js` into a `jsdom` (an in-memory DOM, still
no real browser needed) with `window.api` stubbed the way `preload.js` exposes
it, then clicks real buttons and fires simulated `capture`/`houserule-state`
events to check what actually renders. This is what caught a real crash: the
Conversation window's transcript renderer looked up its "empty" placeholder
by ID on every render, which broke the instant that node was ever removed
from the page — i.e. the moment a second reply arrived in any real
conversation. Fixed and now covered by a regression test.

`npm test` also runs `test/controls.test.js`, the same jsdom approach applied
to `controls.html`/`controls.js` — currently focused on the collapse feature
(each AI column's own toggle, the Automation window's titlebar toggle, that a
collapse event for the *other* window is correctly ignored) and the Stop
confirmation prompt.

Finally, `npm test` runs `test/selectors-sync.test.js`, which loads *both*
copies of the selector config — `desktop-app/selectors.js` (CommonJS) and
`AutoInjector/extension/selectors.js` (loaded via Node's `vm` module with a
fake `window`, since it's written for a browser content script) — and diffs
every `INPUT_CANDIDATES`/`SEND_CANDIDATES`/`ASSISTANT_CANDIDATES` array
between them per site. The two files are hand-maintained copies of the same
information; nothing else catches it if one gets updated and the other
doesn't.

Every one of these runs automatically on push/PR via GitHub Actions
(`.github/workflows/desktop-app-tests.yml`) — a real CI runner (unlike this
dev environment) also has clean network access, so a second job in that
workflow installs Playwright fresh and runs `test:browser` (below) too.

### Optional: real-browser selector tests

```bash
npm install --no-save playwright   # one-time, NOT part of npm install/npm test
npx playwright install chromium    # skip if a browser is already installed
npm run test:browser
```

`test/browser.test.js` runs the *actual* `buildSendScript`/`buildReadScript`
output from `automation.js` inside a real Chromium (via
[Playwright](https://playwright.dev)) against static HTML fixtures in
`test/fixtures/` — as close to Electron's real `WebContentsView` as this
project can get without Electron itself. Unlike the two suites above, this
one exercises real `document.querySelector` matching, real contenteditable
typing, and real click events — the layer jsdom can't fully simulate. Right
now `test/fixtures/claude-reply.html` is a reconstruction of Claude's actual
DOM (captured via DevTools "Copy outerHTML" during troubleshooting the
selector bug) — if ChatGPT or Gemini selectors ever break the same way,
grabbing their outerHTML the same way and adding a fixture here lets this
get verified against real markup too, not just re-read by eye.

Playwright is deliberately **not** a listed `devDependency` — if it were,
every user's plain `npm install` (including the one the `run-*.bat`/
`.command`/`.sh` launchers do automatically) would trigger Playwright's own
postinstall browser download, the same multi-hundred-MB download problem
this project already works around for Electron. So this stays a manual,
opt-in step for whoever's actively debugging a selector, not something
regular users ever need to run.

What none of the three suites can fully replace: an actual logged-in session
against the real chatgpt.com/claude.ai/gemini.google.com — login walls, bot
detection, and live UI changes are outside what any local test can see.
These suites are about everything short of that: who gets sent what and in
what order, what the UI actually renders, and whether the DOM-reading logic
matches real markup — which is also where the subtlest bugs turned out to
live.

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

## A note on the Electron version

`package.json` pins Electron to `~43.0.0` (patch-level updates only, not
minor/major) rather than the usual `^43.0.0` caret range. `BaseWindow` /
`WebContentsView` — the multi-window architecture this app is built on — is
a newer part of Electron's API surface than the older `BrowserWindow`/
`BrowserView` pattern, so it's worth being deliberate about which minor
version this has actually been built and tested against instead of silently
picking up whatever's newest at install time.
