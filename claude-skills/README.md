# AutoInjector Claude Code skills

These skills help **Claude Code** develop and maintain AutoInjector. They do not give Alfred any
abilities. Alfred gets abilities only from `desktop-app/alfred-tools.js`, `alfred-app-actions.js` and MCP servers.

## Installed in `.claude/skills/` (existing skills, unmodified)

| Skill | Source |
|---|---|
| systematic-debugging, test-driven-development, verification-before-completion | github.com/obra/superpowers @ 22f0b46 (MIT, LICENSE copied into each) |
| webapp-testing, mcp-builder, skill-creator | github.com/anthropics/skills @ ca45fc4 (LICENSE.txt in each) |

Note: webapp-testing assumes Python Playwright against a web server. AutoInjector's tests use
JavaScript Playwright's Electron launcher (`desktop-app/test/e2e/helpers.js`). Follow
`autoinjector-verify-change` for which tests to run.

## Custom skills (this folder → run `install-skills.cmd` to copy into `.claude/skills/`)

| Skill | Use it for |
|---|---|
| autoinjector-pane-repair | A site changed its page: box not found, send not confirmed, wrong or partial reply captured |
| autoinjector-relay-debug | Messages lost, doubled, looping, [TO:]/[FROM:] problems, hop limit, Stop/Resume |
| autoinjector-verify-change | Which tests to run for a change, packaging check, honest status report |
| alfred-add-tool | Adding a tool to Alfred's fixed registry the house way |
| autoinjector-media-diagnostics | Picture / video failures: endpoint, backend, models, GPU, job, output file |
| autoinjector-electron-review | Security / correctness review of main, preload, IPC, panes, secrets, processes |

To update a custom skill: edit its SKILL.md here, run `install-skills.cmd` again.
