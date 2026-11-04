---
name: alfred-add-tool
description: Add or change a tool in Alfred (AutoInjector's butler) the same way every existing tool is built - entry in the fixed registry in alfred-tools.js with a JSON args schema, the changes / "I will" confirm card, allowAlways rules, a run() that only calls app code through ctx, plain-English errors, wiring in alfred-main.js, the catalog and the coverage test. Use when asked to give Alfred a new ability, expose an app feature to Alfred, or connect Alfred to an MCP server's tools.
---

# Add a tool to Alfred

All paths relative to `desktop-app/`. Alfred never runs free code: he picks from a **fixed registry**
(`alfred-tools.js`). Every ability is one `def({...})` entry there.

## First decide: registry tool, app action, or MCP?

- **Registry tool** (`alfred-tools.js`) - a capability with arguments (books, images, video, AI panes, files, code).
- **App action** (`alfred-app-actions.js`) - driving an existing control-panel button / IPC channel. Check there first; the feature may only need classifying.
- **MCP server** - a tool that lives outside the app. Do NOT add a registry entry; the user adds the server in ⚙ More settings → 🧰 Tools, `mcp-manager.js` registers its tools as `mcp:<server-id>/<tool>` (always "ask"). For building a new MCP server use the `mcp-builder` skill.

## Registry entry - required shape

Read 2-3 existing entries in the same `group` first and copy their style. Fields (see the header of `alfred-tools.js`):

```js
def({
  name: 'snake_case_name',            // unique; what the model calls
  title: 'Short fixed title',         // logged in the activity log - never put arguments in it
  group: 'books' | 'images' | 'video' | 'ais' | 'files' | 'code' | 'app',
  description: 'One plain sentence: what it does and when to use it. Say "Read-only." if it is.',
  args: { type: 'object', required: [...], properties: { ... }, additionalProperties: false },
  changes: true,                      // creates/changes anything -> shown on an "I will: ..." card first
  allowAlways: false,                 // true only for harmless tools; use allowAlwaysFor(a) for per-arg rules
  describe: (a) => `Plain-English "I will" line using q(a.x)`,   // required when changes: true
  async run(a, ctx) { ... },
});
```

Rules:
- **Schema is the validation.** Use `enum`, `minLength`/`maxLength`, `minimum`/`maximum`, `additionalProperties: false`. `validate()` runs it (lenient JSON via `smart-json.js`) before `run` is ever called.
- **`run` touches nothing directly.** No `require('electron')`, no `fs`, no `http` in the tool. Everything goes through `ctx` (built in `alfred-main.js`, e.g. `ctx.listOutputs`, `ctx.akowe`, `ctx.sendToAi`, `ctx.generateImage`). If the app function you need is not on `ctx`, add it in `alfred-main.js` where the ctx object is assembled.
- **Return shape:** `{ ok: true, message?, data? }` or `{ ok: false, error: 'UPPER_SNAKE_CODE', message: 'one plain sentence the user can act on' }`. Never throw out of `run`; never return a raw stack trace. For Akọwe calls reuse `akoweError()`.
- **Safety:** anything that can expose private data, delete, spend money or run code must be `changes: true` and must not be always-allowable (see `export_logs` → `allowAlwaysFor`).
- Use the helpers `str`, `clip`, `q` to keep text bounded; never put secrets or prompt text in `title` or logs.
- Default `timeoutMs` is 60000; set a longer one only for real long jobs.

## Wire it up

1. `alfred-tools.js` - the `def({...})`.
2. `alfred-main.js` - new `ctx` function if needed.
3. `alfred-catalog.js` - add it to the "❓ Everything I can do" list (description + example request) if it is user-facing.
4. `test/alfred-coverage.test.js` - this test FAILS when a user-facing capability is not mapped to a tool or a justified EXCLUDE. Map the capability to your tool; drive it end to end with the fake LLM in `test/alfred-fakes.js`.
5. `test/alfred.test.js` - cases for: valid call, bad args rejected by `validate`, the `describe` line, the `{ok:false}` path with a readable message.
6. New file? Add it to `package.json` `build.files` and run `node test/build-files.test.js`.

## Verify

```
node test/alfred.test.js
node test/alfred-coverage.test.js
node test/alfred-format.test.js
npm test
```
Optional GUI check: `node test/e2e/alfred.e2e.js` (needs Playwright). Then use `autoinjector-verify-change` for the report.

Reminder: Claude Code skills in `.claude/skills` help Claude *develop* AutoInjector. They do not give Alfred any ability - only the registry, app actions and MCP servers do.
