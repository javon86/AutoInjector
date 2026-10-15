# 🚧 Under Construction / Parked

A single place to find the parts of the repo that are **kept for reference or
future work but are NOT part of the running app right now**. Nothing listed here
is wired into the live Electron app, so none of it can affect how the program
runs — it's parked, not deleted, so the related code stays easy to find.

If you're looking for what the app *actually* does today, see the top-level
[`README.md`](README.md) and the System AI panel in the app.

---

## 1. ATELIER book-making engine — parked

- **Where:** [`desktop-app/atelier/`](desktop-app/atelier/) (see its
  [`_UNDER_CONSTRUCTION.md`](desktop-app/atelier/_UNDER_CONSTRUCTION.md)).
- **What it is:** a self-contained **Python** book-production engine (governed
  gateway / `authority.py`, derived-state registers, `autobook.py`, the
  `salt-line` example manuscript, specs, etc.).
- **Status:** **not wired into the app.** The Electron app has zero references to
  it (no `require`, `spawn`, or `exec`). It was stripped from the live product
  during the bare-bones pass and left here for possible future integration.
- **Inert by design:** it is no longer bundled into packaged builds (removed from
  `package.json` `build.files`), and its only consumer is the manual
  `npm run quality` gate (not part of the app or the CI 360). So it cannot
  interfere with anything.
- **Related doc:** [`desktop-app/ATELIER_INTEGRATION.md`](desktop-app/ATELIER_INTEGRATION.md)
  describes an "optional governance on each reply" feature that is **not built**.

## 2. Docs being updated — partially stale

These predate recent changes (the bare-bones strip + the butler/supervisor,
tools, memory, voice, and image-generation capabilities). They're accurate about
the relay basics but **describe some removed features (book/ATELIER) and miss the
new ones** — they carry a 🚧 banner at the top until reworked:

- [`USER_GUIDE.md`](USER_GUIDE.md) — end-user guide (mentions the removed book workflow).
- [`desktop-app/README.md`](desktop-app/README.md) — deep technical README.
- [`desktop-app/ATELIER_INTEGRATION.md`](desktop-app/ATELIER_INTEGRATION.md) — describes an unbuilt integration.

**Current & accurate** references in the meantime:
- [`README.md`](README.md) — product overview.
- [`desktop-app/FEATURES.md`](desktop-app/FEATURES.md) — built-inventory.
- [`desktop-app/SERVICE_BRIDGE.md`](desktop-app/SERVICE_BRIDGE.md) — matches the live bridge.
- [`desktop-app/MERGE_ROADMAP.md`](desktop-app/MERGE_ROADMAP.md) — the native-capabilities status.

## 3. Planning / roadmap docs (holding pens, by design)

Not stale so much as forward-looking; kept as-is: `desktop-app/FUTURE_PLANS.md`,
`desktop-app/STABLE_DIFFUSION_PLAN.md`, `desktop-app/LIVE_VERIFICATION.md`,
`desktop-app/QUALITY_AUDIT.md`, `AUTOINJECTOR_UPGRADE_TASKS.md`.

---

_None of the above is on the app's runtime path. To pick any of it back up, start
from the file linked above._
