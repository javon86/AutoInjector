---
name: autoinjector-verify-change
description: Decide and run the right AutoInjector tests for a change before calling it done - unit, integration (mock Electron), real-Chromium browser and stress tests, Electron GUI e2e, packaging (build files) and the quality scorecard - and report honestly what was verified, what was only mocked, and what needs a live check. Use after any code change in desktop-app, before committing, or when asked "does it work" / "is it done".
---

# Verify an AutoInjector change

Run everything from `desktop-app/`. Never report "done" or "fixed" without running the commands
below and reading their output. Use `verification-before-completion` alongside this skill.

## Test layers (from fastest to closest-to-real)

| Layer | Command | What it really proves | What it does NOT prove |
|---|---|---|---|
| Unit | `npm test` (= `test:unit`) or `node test/<name>.test.js` | Pure modules and small harnesses | Real DOM, real Electron |
| Integration | `npm run test:integration` (`test/run.js`) | Real `main.js` IPC handlers, routing, House Rules, under `test/mock-electron.js` | Page scripts (they are string-matched, not executed) |
| Browser | `npm run test:browser` (`test/browser.test.js`) | Real generated send/read scripts in real Chromium on `test/fixtures/*.html` | Real ChatGPT/Claude/Gemini pages |
| Stress | `npm run test:stress` (`test/stress.test.js`) | Real `main.js` relay + real scripts in Chromium on fake sites, seeded | Real sites |
| GUI e2e | `npm run test:e2e` | The real Electron app launches and the UI renders/responds | Live AI sites |
| Scorecard | `npm run quality` (`--e2e` to include GUI) | Runs every layer, marks layers that could not run as UNVERIFIED | - |
| Live sites | `node scripts/live-check.js` (needs internet) | Outside sites the app depends on still look as expected | The relay itself |

Browser, stress and e2e need Playwright, which is deliberately **not** a dependency:
`npm install --no-save playwright`. On Linux run e2e under `xvfb-run -a`. If Playwright or a display
is not available, say that layer is UNVERIFIED - do not skip it silently.

## Pick the tests for the files you changed

| Changed | Run at least |
|---|---|
| `selectors.js` | `test/selectors-sync.test.js` (and update `../AutoInjector/extension/selectors.js`), browser, stress |
| `automation.js`, `transcript-rows.js`, `reply-clean.js` | `read-script`, `reply-clean`, browser, stress |
| `self-repair.js`, `tools/page-structure.js` | `self-repair`, `self-repair-main`, browser; regenerate `tools/page-check.js` |
| `envelope.js`, `relay-policy.js`, `relay-trace.js`, `pane-health.js` | its own test, `test/run.js`, stress |
| `main.js` relay / routing / House Rules | `test/run.js`, `relay-*`, `pc-panes-main`, stress |
| `alfred*.js` | `alfred`, `alfred-format`, `alfred-coverage`, `alfred-current-book`, `alfred-shortcut`, `alfred-ollama`, e2e `alfred.e2e.js` |
| `mcp-client.js`, `mcp-manager.js`, `tool-provider.js` | `mcp-client`, `tool-provider`, e2e `mcp.e2e.js` |
| `sd-*`, `video-*`, `framepack*`, `media-selftest.js`, `gpu-monitor.js` | the matching `sd-*`/`video*`/`framepack*`/`media-selftest` tests, e2e `sd-images`, `video`, `framepack`, `media-selftest` |
| `akowe-*` | the `akowe-*` tests, e2e `akowe-oneapp` |
| `terminal-provider.js`, `ai-lockers.js` | `terminal-provider`, `ai-lockers` |
| `controls.html/js`, any `*.html` UI | `controls` test, e2e `smoke.e2e.js` (screenshots in `test/e2e/__screenshots__/`) |
| `preload.js` or a new IPC channel | `alfred-coverage` (it fails when a new user-facing channel is not classified), e2e smoke |

Always finish with the full `npm test`.

## New files: packaging check (easy to miss)

The installed app only ships files listed in `package.json` → `build.files`. A new module that
works from source will crash the installed app if it is not listed.
- Add every new runtime `.js` / `.html` file to `build.files`.
- Run `node test/build-files.test.js` - it follows every local `require()` and `<script>` and fails on anything not shipped.
- Add every new unit test file to the `test:unit` script in `package.json`, or it never runs. (`scripts/quality-check.js` reads the list from `package.json`.)

## Report format

End with a short, honest status:
```
Verified:   <layers + commands that passed, with pass/fail counts>
Mocked only: <what was proven only against fakes/fixtures>
Not run:    <layers that could not run here and why>
Needs live check by you: <exact thing to try in the running app, e.g. send one message to Claude and watch the pane light>
```
If any test fails, the change is not done: say which test, show the failing line, and fix or stop.
