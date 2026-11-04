---
name: autoinjector-electron-review
description: Review an AutoInjector change for Electron safety and correctness across the main process, the preload bridge, the control-panel renderer, the external ChatGPT/Claude/Gemini panes and the Akọwe view, secret storage, the service bridge, and anything that spawns processes (terminal, AI lockers, Open Interpreter, SD/FramePack runners). Use before merging changes to main.js, preload.js, IPC handlers, webPreferences, navigation, secrets, HTTP servers or child processes, or when asked for a security or code review of the desktop app.
---

# AutoInjector Electron review

All paths relative to `desktop-app/`. Review the diff (`git diff`) against the checklist below.
Report findings ranked by severity with file:line, the concrete failure scenario, and the fix.
Only report what you can point to in code; mark anything unconfirmed as "needs check".

## Process boundaries in this app

| Surface | Where | Must hold |
|---|---|---|
| Control panel renderer | `controls.html/js`, `WebContentsView` in `main.js` (`partition: "persist:controls-ui"`) | `contextIsolation: true`, `nodeIntegration: false`, only `preload.js` APIs |
| Preload bridge | `preload.js` → `contextBridge.exposeInMainWorld("api", …)` | One named function per IPC channel. Never expose `ipcRenderer` itself, a generic `invoke(channel, …)`, `require`, or Node objects. |
| IPC handlers | `ipcMain.handle/on` in `main.js` (~300) and `alfred-main.js` | Validate every argument (type, enum, length); never trust a path, URL, site name or command from the renderer. |
| External AI panes | site `WebContentsView`s in `main.js` | Untrusted web content. No preload with app APIs; no Node. Everything injected comes from `automation.js` with data JSON-encoded (`JSON.stringify` payload), never string-concatenated user text. |
| Akọwe view | `persist:akowe` view, `will-navigate` guard + `setWindowOpenHandler` (~line 9038) | `sandbox: true`; navigation limited to the Akọwe origin; outside links open in the OS browser. |
| Secrets | `secret-store.js` (OS keychain via `safeStorage`), saved logins, MCP env/headers (`mcp-manager.js`) | Never written in plain text, logged, broadcast or returned to a renderer. If sealing is unavailable, keep in memory only. |
| Local HTTP | `service-bridge.js`, `akowe-server.js`, `akowe-bridge.js` | Bind `127.0.0.1` only; bearer token checked on every route (SSE accepts `?token=`); no CORS `*`. |
| Child processes | `terminal-provider.js`, `ai-lockers.js` (`checkCommand`), `interpreter-provider.js`, `sd-runner.js`, `framepack.js`, `ollama-manager.js` | Args as arrays (`spawn(cmd, args)`), no `shell: true` with untrusted text; AI commands only through the locker gate and approval; processes killed on quit. |
| Logs / bundles | `logEvent`, `log-bundle.js`, `log-extract.js` (redaction) | No secrets, tokens or full prompt text; exports go through redaction. |

## Checklist for a diff

1. **New/changed `webPreferences`:** `contextIsolation` true, `nodeIntegration` false, `sandbox` true where possible, no `webSecurity: false`, no `allowRunningInsecureContent`.
2. **New IPC channel:** handler validates input; preload exposes one specific function; the channel is classified in `test/alfred-coverage.test.js` (the test fails otherwise).
3. **Injected scripts:** user/AI text reaches the page only inside the JSON payload; no template-literal interpolation of untrusted strings into script code.
4. **Navigation / new windows** on any view: `will-navigate` and `setWindowOpenHandler` deny or route to `shell.openExternal` after URL scheme check (`https:` only).
5. **`shell.openExternal` / `openPath`:** scheme/extension checked; Alfred's `open_output` refuses programs and scripts - keep that.
6. **Paths from renderer/AI:** resolved and confined (`path.resolve` + prefix check) to the intended folder (output folders, AI lockers). Watch for `..`, absolute paths, symlinks.
7. **Spawning:** no shell string built from AI or renderer text; timeouts; stdout/stderr bounded; killed on stop/quit.
8. **Secrets:** sealed via `secret-store.js`; public views list names only; nothing in `broadcast(...)`, `logEvent(...)` or error messages.
9. **HTTP servers:** localhost bind, token check, body size limit, JSON parse errors handled.
10. **Error handling:** async handlers catch and return `{ ok: false, error }`; no unhandled rejections (`main-unhandled-rejection` events in the log mean something escaped).
11. **Packaging:** new files in `package.json` `build.files`; `integrations/**` stays in `asarUnpack` if it spawns from there.

## Verify

```
node test/build-files.test.js
node test/secret-store.test.js
node test/service-bridge.test.js
node test/terminal-provider.test.js
node test/ai-lockers.test.js
node test/alfred-coverage.test.js
npm test
```
GUI: `node test/e2e/smoke.e2e.js`. Use `autoinjector-verify-change` for the final status report.
