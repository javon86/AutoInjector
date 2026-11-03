# Desktop app sweep — November 2026 (1920×1080 and 1280×720)

The whole AutoInjector desktop app (`desktop-app/`) was driven for real with Playwright under `xvfb-run`,
at a 1920×1080 window and again at 1280×720. It ran against the test fakes: fake chat sites (ChatGPT with a
changed page, Claude working, Gemini signed out), a fake Forge, a fake FramePack runner, a fake Ollama, a fake
OpenAI-style model for Alfred, and the real Akọwe server.

Each screen was screenshotted and checked by a script for: console errors, page errors, failed requests,
sideways scrolling (the page and every scroll box), controls off the screen, cut off or overlapping, text
reading `undefined` / `null` / `NaN` / `[object Object]`, raw error codes or stack traces, and icon-only
buttons with no tooltip. A second script (Chrome DevTools listener lookup) checked that every button has a
click handler. Separate probes covered restarting the app, FramePack failure states and running the 🩺 test
again and again.

## Screens visited (each at both sizes; 46 states × 2 = 92 screenshots)

- **🤖 AutoInjector:** the top bar, User Panel / compose, the Akọwe bridge panel (check-ins, the ⚠️ markers),
  the 🎯 picker card (with 🔢 "Do it for me with a number"), Butler, Alfred's AI setup (🩺 Check everything,
  🔎 the model cards with ★★★/★★/★/🐢, speed and verdict), personality and saved set-ups, ⚙ More settings
  (Downloads & creations, Safeguards, Tools / MCP tool servers with "Add a tool server"), the Activity log,
  Terminal, and the ⤓ Extract dialog.
- **📖 Akọwe:** the tab (a native view, captured from the screen), ⇱ Pop out and closing the popped-out
  window to bring it back.
- **🎨 Images:** Generate (with every advanced section open), the ChatGPT engine, Library, Character locks,
  Start & install (with Advanced: another server).
- **🎬 Video:** Make video (text→video and picture→video), Trailer, Setup & models with the FramePack card in
  each state: not found, ready, loading, stuck, stopped, loaded, failed to load, last clip failed. Also the
  Make tab after a failed clip, and 🩺 Test pictures & video (empty, then after Quick).
- **🎩 Alfred side panel:** the 8 buttons, 🩺 Check everything, ❓ Everything I can do, ⚙ his settings, the
  panel docked over the Images and Video tabs.
- The **"I will" card** and personality saving are covered by `alfred.e2e.js` and `llm-setup.e2e.js`. Both
  were re-run.

The final run found nothing at either size: no console errors, no page errors, no failed requests, no
sideways scrolling, no overlapping, cut-off or off-screen controls, no bad text, and no icon-only buttons
without a tooltip. The click-handler check found no dead buttons.

## Bugs found and fixed (each has a regression test)

1. **🎬 Video → "🩺 Test pictures & video" tab button did nothing.** The test view could only be opened from
   the button in 🎨 Images, because the tab button had no click handler (`videos-studio.js`).
   *Fix:* wired it to the same sub-tab switch as the others.
   *Tests:* `test/video.test.js` (every Video sub-tab button shows only its own view) and
   `test/e2e/media-selftest.e2e.js`.
2. **The 🩺 self-test view got stuck on "Running (12 of 12 done)…" after it had finished.** ▶ Quick and
   ▶ Full stayed greyed out and ⏹ Stop stayed on. This happened on every run in the real app. The last
   progress message can arrive after the run's answer, because the two travel on different IPC paths, and it
   put the view back into "busy". A run started by 🎩 Alfred (`mediatest.run`) never released the view at all,
   because the "finished" message was ignored.
   *Fix (`media-selftest-ui.js`):* progress messages from a run that has already finished are ignored, and a
   run started elsewhere frees the buttons and shows its summary when it ends.
   *Tests:* `test/media-selftest.test.js` (a jsdom test for both cases) and `media-selftest.e2e.js`.
3. **🎩 Alfred said "🎬 video not yet" next to "✔ Ready: FramePack".** His tool status only looked at the old
   "other video server" setting and ignored FramePack and Wan on ComfyUI.
   *Fix:* it now uses the same quick video status as the System Check (`videoQuickStatus`, passed to
   `alfred-main.js`). That status is now filled in the background the first time it is asked for, so it is
   right even before the Video tab is opened.
   *Test:* `test/e2e/framepack.e2e.js` (`alfredStatus().connected.video === true` when FramePack is ready).
4. **Settings in the control panel were lost every time the app closed.** These include the 🎨 picture engine
   (ChatGPT / SD), 🔔 sound, the activity-log filters and "Errors only", Alfred's panel open or closed, the
   Butler section folded or open, the last ⤓ Extract choice, which tab was open, the model-finder fold, and the
   AI Feed's saved presets. They are kept in `localStorage`, but the control panel used the partition
   `controls-ui` and the AI Feed used `feed-ui`. An Electron partition without `persist:` is an in-memory
   session, so it is wiped on every restart.
   *Fix:* changed them to `persist:controls-ui` and `persist:feed-ui`. Checked in the real app: the engine
   choice and sound setting are still there after a restart.
   *Test:* `test/pc-panes-main.test.js` checks the partition. `test/mock-electron.js` now records it.
5. **A ChatGPT picture download could hang the job forever.** When the page's own fetch is blocked, the app
   falls back to fetching through the session. That fallback had no timeout, unlike every page script. A
   server that accepts the request and never answers would hold the picture job and its queue.
   *Fix (`chatgpt-image.js`):* `fetchTimeoutMs` (120 s) gives up with `SESSION_FETCH_TIMEOUT`.
   *Test:* `test/chatgpt-image.test.js`.
6. **Alfred's 🩺 Check everything note scrolled sideways at 1280×720.** Long folder paths and addresses do not
   wrap. *Fix:* the note now wraps (`overflow-wrap:anywhere`, no sideways scroll).
   *Test:* `test/e2e/alfred.e2e.js`.
7. **The Terminal's 📤 "send last output" button was cut off at 1280×720 with Alfred's panel open.** Its row
   was `nowrap; overflow:hidden`. *Fix:* the row wraps instead. *Test:* `alfred.e2e.js` checks at 1280×720.
8. **Errors nobody caught in the main process were never logged.** A promise rejection nobody handled went to
   stderr only, so it was never seen and never in 📋 Extract. *Fix:* `process.on("unhandledRejection")` writes
   it to the activity and debug log as `main-unhandled-rejection`. It only logs; nothing else changes.
   *Test:* `test/pc-panes-main.test.js`.
9. **The capability results pop-up could only be closed with the mouse.** It is marked as a modal dialog, but
   Esc did nothing and focus stayed behind it. *Fix:* Close gets focus when it opens, and Esc closes it.
   *Test:* `test/controls.test.js`.

Small extra: the Alfred panel uses `color-scheme: dark`, so its scrollbars are dark instead of white.

## Cosmetic issues left as they are (and why)

- **The sticky User Panel takes about 250 px of a 720 px window.** At 1280×720 only about 470 px is left for
  the rest. This is the intended layout and the panel can be folded (⌄); changing it is a design decision.
- **Long `<select>` text is cut** ("Auto (ComfyUI + Wan; FramePack when Wan isn't ins…", "★★★ Excellen…" in
  the model cards). The browser's normal behaviour; the full text shows when the list is opened.
- **FramePack "seems stuck" box: its clock lags the header by up to 4 s** (e.g. 0:04 vs 0:07). The box is
  refreshed every 4 s and the header every second. It is harmless.
- **After a stopped load, the FramePack card still shows the earlier "✖ Failed to load (time)" line.** This is
  intended: it is the "last load" record, and it carries its time.
- **"Try again" after a failed FramePack load reuses the same FramePack Python process.** It does not start a
  new one, so a fix inside that Python (e.g. a reinstalled package) is only picked up after ⏏ Unload. Left
  as is: the real runner stays usable after a failed load, and the fix text for that case already tells
  people to restart. Worth a follow-up if it shows up on a real PC.
- **Bridge-panel rows read "Gemini is ready ✕ Signed out?"** It is a checklist: the label is the check, the
  mark is the result. The wording could be clearer, but it is consistent across all rows.
- **"Video is not set up yet" appears twice** (the status line and the hint box) when nothing is installed.
- **While Akọwe is popped out, the Akọwe tab area is empty (black).** ⇱ has become "Bring back" and the
  status line is right; a short "Akọwe is in its own window" note would be nicer.
- **Status lines like "Extract cancelled — nothing was saved." stay until the next action.** This is how the
  panel's status line works.
- **The Images and Video tabs still have light default scrollbars on some inner boxes.** Setting
  `color-scheme: dark` there would also restyle every form control; not worth the risk in a sweep.

## Checked and fine

- **Timeouts:** every network call in main has one (AbortController or a race); page scripts have one; FramePack
  load stages have a "seems stuck" watch.
- **Timers stop:** the Images and Video tickers, Alfred's busy line, and the FramePack tickers all stop when
  their work ends.
- **No dead buttons**, including the delegated ones such as the ⚠️ markers in the bridge panel.
- **Tooltips:** every icon-only button has a title or an aria-label.

## Tests run

| Suite | Result |
|---|---|
| `npm run test:unit` | 5798 passed, 0 failed |
| `node test/run.js` | 704 passed, 0 failed |
| `node test/alfred-coverage.test.js` | 203 passed, 0 failed |
| `smoke.e2e.js` | 119 passed, 0 failed |
| `alfred.e2e.js` | 60 passed, 0 failed |
| `framepack.e2e.js` | 69 passed, 0 failed |
| `media-selftest.e2e.js` | 37 passed, 0 failed |
| `chatgpt-image.e2e.js` | 17 passed, 0 failed |
