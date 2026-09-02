# ATELIER governance in AutoInjector Desktop

> 🚧 **Under construction — this describes an UNBUILT integration.** The app does
> **not** currently run replies through ATELIER; the ATELIER engine is parked (see
> [`../UNDER_CONSTRUCTION.md`](../UNDER_CONSTRUCTION.md) and
> [`atelier/_UNDER_CONSTRUCTION.md`](atelier/_UNDER_CONSTRUCTION.md)). This doc is
> kept as the design for a future integration. It has no effect on the running app.

This app can optionally run each AI reply through **ATELIER**, a book-production
governance toolkit (vendored under [`atelier/`](atelier/)). It's **off by
default** — with governance disabled, AutoInjector behaves exactly as it always
has. Turn it on only when you're using the three panes to *build a structured
book project* and you want the app to enforce who is allowed to write what.

## What it adds

AutoInjector routes raw replies between ChatGPT, Claude and Gemini. It has no
concept of **authority** (which AI may write which artifact). ATELIER does, and
it's proven by its own regression suites. The integration wires ATELIER's
write-authority gate into the reply path:

- When governance is **on** and a pane is **mapped to a target artifact**, every
  finished reply from that pane is checked against ATELIER's role→path policy
  *before* it is routed onward.
- A reply the pane is **not** allowed to write is **held**: it still appears in
  the Transcript (tagged `⛔ HELD`), but it is **not** forwarded to the other
  panes, the Roundtable relay, the mesh, a Prompt Sequence, or the manager.
- An **authorised** reply is tagged `✓ authorised` and routes normally.

The default role→path policy (from `atelier/authority.py`, deny-by-default):

| Pane (role) | May write |
| --- | --- |
| ChatGPT | `01_DESIGN/**`, `00_CONTROL/**`, `02_BIBLE/**` |
| Claude | `04_CHAPTERS/**`, `02_BIBLE/**`, `03_MEMORY/**`, `07_BUILD/**`, … |
| Gemini | `99_ARCHIVE/auditor-submissions/**`, `06_AUDIT/**` (auditor only) |

So, for example, if Gemini (the auditor) tries to hand back a *chapter*, that
reply is held rather than silently propagated as manuscript — the exact class of
failure (`ISS-002`) ATELIER was built to prevent.

## Requirements

- **Python 3** on your PATH. That's the same prerequisite ATELIER itself has.
  If Python 3 isn't found, governance **fails open**: replies pass through
  untouched (never blocked), and the panel says the toolkit is unavailable.
  Set the `ATELIER_PYTHON` environment variable to point at a specific
  interpreter if it isn't on PATH.

## How to use it

1. In the control panel, open **Book Governance (ATELIER)**.
2. Confirm the status line reads **✓ Toolkit ready**. (If not, install Python 3
   and click **Re-check toolkit**.)
3. Tick **Enable governance**.
4. Set **Book project folder** to your project directory (e.g. one created by
   `python atelier/init_project.py "My Book" --chapters 12`).
5. For each pane, set the **target artifact** it's expected to write, relative to
   the project — e.g. Claude → `04_CHAPTERS/ch01/scenes/s01.md`. Leave a pane
   blank to leave its replies ungoverned.
6. **Save.** From now on, replies are checked as they arrive.

## Architecture

```
 controls.html / controls.js         (the "Book Governance" panel + badges)
        │  window.api.atelier*  (preload.js)
        ▼
 main.js  pollSite()  ── await atelierGov.governTurn(turn) ──┐
        │  (held → skip all re-routing)                      │
        ▼                                                    ▼
 atelier-governance.js  ── settings + governTurn() ──►  atelier-bridge.js
        (per-pane targets, persisted JSON)                   │ execFileSync
                                                             ▼
                                          atelier/  (autoinjector.py, authority.py …)
                                          the vendored Python governance toolkit
```

- **`atelier-bridge.js`** — shells out to `atelier/authority.py` and
  `atelier/autoinjector.py`, mapping their exit codes (0 permitted · 1
  refused/held · 3 bad call) to JS results. Detects Python lazily and caches it.
- **`atelier-governance.js`** — owns the opt-in settings (enabled, project dir,
  per-pane targets), persists them to `atelier-governance.json` in the app's
  userData dir, and exposes `governTurn(turn)`.
- **`main.js`** — calls `governTurn` in `pollSite`, annotates the turn with the
  verdict, and gates the re-routing block on the result. Every call is wrapped
  so a governance error can never eat a reply (it falls open).

The full ATELIER toolkit is unchanged under `atelier/` and can still be driven
directly — see `atelier/README.txt` and `atelier/OPERATOR_GUIDE.md`. Its own
Python suites (`python atelier/test_authority.py`, etc.) remain runnable.

## Tests

`npm test` includes [`test/atelier-bridge.test.js`](test/atelier-bridge.test.js),
which exercises the real vendored Python through the bridge (authority gate,
delivery, duplicate-delivery guard, path-traversal rejection) plus the
governance settings, hold/pass decisions, and the graceful-degradation path when
Python is absent. It **skips** the live-Python assertions (rather than failing)
on a machine with no Python 3, matching the fail-open contract.
