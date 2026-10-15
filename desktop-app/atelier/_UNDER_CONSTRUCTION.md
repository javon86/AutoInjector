# 🚧 ATELIER — Under Construction / Parked

**This directory is NOT part of the running AutoInjector app.**

It's a self-contained **Python** book-production engine (governed gateway,
derived-state registers, `autobook.py`, the `salt-line` example manuscript,
specs). It was stripped out of the live product during the bare-bones pass and is
kept here **for reference and possible future integration** — nothing more.

## Why it can't interfere with the app
- The Electron app never loads it: no `require`, `spawn`, or `exec` of anything
  under `atelier/` anywhere in the JS. (Grep `atelier` across the `.js` files —
  only stale comments, no calls.)
- It is **not bundled** into packaged builds (removed from `package.json`
  `build.files`).
- Its only consumer is the optional, manual `npm run quality` gate — which is not
  part of the app and not in the CI 360-test run.

## If you pick it back up
Start from `INSTALL.md` / `OPERATOR_GUIDE.md` here, and see
`../ATELIER_INTEGRATION.md` for the (unbuilt) "governance on each reply"
integration idea. To re-wire it into the desktop app you'd add an
`atelier-bridge`-style module and call it from the send path in `../main.js`.

_Parked, not deleted — so the code stays here to build on later._
