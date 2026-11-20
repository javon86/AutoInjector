# Notes for Claude working in this repository

## 🚫 The Money lab never goes into AutoInjector

The owner's standing rule (2026-11-20): **never merge the Money lab into `main`, no matter what** — not in a pull
request, not as part of another branch, not partly.

- The Money lab (Claude Code + Codex in a Windows Sandbox: `money-lab*.js`, `money-lab-kit/`, `lab.html`,
  `lab.js`, the 🧪 Lab button, `lab:*` IPC) lives ONLY in its own repository: **javon86/money-lab**.
- `cli-mode` (⌨ command-line mode) is a separate branch WITHOUT the Money lab; it may be merged only when the owner
  says so, and must stay free of Money lab files.
- `desktop-app/test/no-money-lab.test.js` (part of `npm run test:unit`, so it runs on every pull request) fails if any
  Money lab file or wiring shows up here. Never weaken, skip or delete that check.
