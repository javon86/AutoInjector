# AutoInjector Desktop

One program, one window: ChatGPT, Claude and Gemini as three real Chromium panes
side by side, with a control panel that lets you route messages between them —
by copy/paste-style DOM automation, no API keys, using your normal logged-in
sessions. It's built for using two (or three) AIs together as thinking partners:
you send them a problem, and route replies between them however you want —
one-off, or on autopilot.

Everything lives in one **Automation** window: the three live panes, the
control panel, the shared Transcript/Activity Log, House Rules, the Prompt
Library — all in one place, with panes and panels you don't need right now
collapsible so the ones you do care about get more screen space. A few
features (editing a Prompt Library entry, previewing a document before
sending it, building a Prompt Sequence) open their own small on-demand popup
window, but there's no separate always-open second window anymore.

By default, every reply any AI sends is read for a `[TO: X]` tag at the very
start — this is **Roundtable v2**, and unlike everything else in this app
it's not a mode you turn on: it's just how the program behaves, all the time,
for as long as it's running. See "Roundtable v2: the always-on baseline"
below for exactly how that works, and how it relates to House Rules.

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

Each AI gets one merged column: a compact control strip on top (zoom,
status, preview, Forward/Auto/Regenerate buttons), its actual live browser
pane directly below. There's no separate "cards row" and "browser strip" —
unchecking that AI in **Participants** collapses just its pane, but its
control strip (and its last captured reply) stays visible and usable.

1. Sign in to whichever sites you want to include, right in their panes.
2. The moment each pane finishes loading for the first time, the app
   automatically sends it a short routing-explainer prompt (see "Roundtable
   v2" below) explaining the `[TO: X]` tag system — this happens once per
   app launch, before you do anything else, with no reply expected. It also
   lives in the **Prompt Library** (as "System Prompt (How Routing Works)")
   so you can resend it manually any time an AI seems to have forgotten it.
3. **Participants** (top): uncheck any AI you want to sit out of Auto/"All" —
   its pane collapses too, since there's nothing to watch if it's not in play.
4. **Compose** (top-left): type a message and click **→ ChatGPT** / **→ Claude** /
   **→ Gemini** / **→ All** to send it to one, some, or all checked participants —
   this is also how you interject at any point, auto running or not. It warns you
   if a message is long enough that a site might choke on it.
5. The moment a pane's reply finishes streaming (checked every ~1.5s, waits for
   the text to stop changing), a soft chime plays, its column's preview updates,
   and it's logged to the transcript. While waiting on a reply, that column shows
   a pulsing amber dot; the instant it sends something new to another AI, that
   AI's whole column glows briefly so you can actually follow who's talking to
   whom. Forwarded replies are always labeled (`[ChatGPT says] ...`).
6. **Zoom** — each column's header has **－** / **＋** buttons (and a live
   percentage) that zoom the *actual embedded page* in that pane, not just
   the app's own UI — handy for fitting more of a long conversation on
   screen at once. Ranges from 40% to 200%, independent per pane.
7. **Global controls**:
   - **Auto** — turns on full back-and-forth forwarding between every checked
     participant: whatever one says gets forwarded to the others, whose replies
     get forwarded back, and so on — this is the "three-way conversation" mode.
     With 2+ participants it will run indefinitely once started.
   - **Pause** — halts all forwarding but keeps your participant selection, so
     hitting **Auto** again picks up where you left off.
   - **Stop** — halts all forwarding *and* unchecks every participant, forcing a
     deliberate restart.
   - A column's own **Forward**/**Auto → X**/**Auto → Both**/**↻ Regenerate**
     buttons are **always visible and always clickable**, no matter what's
     going on — including while a House Rules format is actively running.
     There's no mode where they hide or get disabled; if you want to
     override or interject on top of whatever House Rules or Roundtable v2
     is doing, you always can. **Auto → Both** is a single toggle that turns
     both of that column's individual Auto routes on (or off) together,
     instead of clicking each one separately.
8. **Role Assignment** *(collapsed by default, in its own panel)* — give each
   AI an optional persona (e.g. "Skeptical Engineer," "Project Manager") that
   gets prepended to every message sent to it, however it's sent (Compose,
   Forward, Auto, a House Rules format, Prompt Library, a Prompt Sequence
   step). Type a role and click **Apply**, or **Clear** to remove it. This
   only shapes *what* that AI contributes — it has no effect on *who* it
   addresses, which is entirely up to its own `[TO: X]` tag choice.
9. **🧵 Prompt Sequence** *(top of the House Rules panel)* — opens a small
   popup window where you build a numbered list of prompts, each aimed at a
   specific AI or **All**. Hit **Run Sequence** and it sends step 1, waits
   for that step's target to actually reply (for an **All** step, the
   *first* of the three to reply is enough), then sends step 2, and so on —
   it never fires everything at once. The popup's status line tracks
   progress ("step 2 of 4…") and the Run button disables itself while a
   sequence is active; **Close** just hides the window, it doesn't stop a
   run in progress. Each step's dispatch is stamped with a generation
   number, so a reply that's still in flight for a step the sequence has
   already advanced past (most easily triggered by an **All** step, where
   the other two replies are still coming after the first one advances
   things) gets recognized as stale and discarded rather than misread as
   satisfying whatever step comes next.
10. **Prompt Library**: saved, reusable prompts you can fire off with one
   click, without retyping them or going through House Rules. It's a compact
   dropdown (pick a saved prompt by name) plus **Send** / **+ New** / **Edit**
   / **Delete** — no big text boxes cluttering the main window. **+ New** and
   **Edit** open a small separate popup window with the actual editing
   surface: a name field, one text box *per AI* (ChatGPT, Claude, and Gemini
   can each get different wording — leaving a box blank skips that AI
   entirely on Send), and a **→ All** shortcut that copies one shared draft
   into all three boxes at once if you *do* want them all the same. **Save**
   there closes the popup and updates the dropdown back in the main window
   immediately. Ships with two built-ins: **System Test**, a one-click
   sanity check that tells all three AIs this is a diagnostic (not a real
   task) and asks them to confirm they received it and report whether
   messages from the other two are actually arriving; and **System Prompt
   (How Routing Works)**, the same routing-explainer text that's auto-sent
   on startup, so you can resend it any time it's useful. Saved prompts
   persist across restarts, same as the transcript and custom roles.
11. **📎 Attach Document**: pick a real file (image, PDF, text, or anything
   else) via a normal file picker, and preview it in its own popup window
   before deciding what to do with it. Images and text get a genuine inline
   preview; PDFs embed via Chromium's built-in viewer; anything else just
   shows the filename — you can still send it either way. For images and
   text, you can **highlight** parts of it (click-drag a rectangle on an
   image, or select text and hit **Mark Selection**) purely as a visual note
   to yourself — highlights never get sent anywhere and never touch the
   actual file, they just help you remember what you meant to mention. When
   you're ready, check off ChatGPT/Claude/Gemini (defaults to whichever are
   currently enabled) and hit **Send** — the real file lands in each
   checked AI's chat the same way it would if you'd dragged it there
   yourself, delivered underneath via the Chrome DevTools Protocol (the same
   technique browser-automation tools use for file uploads), not typed as a
   path. This is genuinely new, less-tested territory — see the note on file
   upload selectors in "How it's built" below.
12. **📌** on any transcript turn pins it, so you can spot it again later without
   scrolling back through everything.
13. **Copy Transcript** / **Download .md** save the running conversation locally
   (pinned turns are marked in the export) so you can share it elsewhere.

### Collapsing things when one screen isn't enough room

Everything that takes up screen space can be shrunk out of the way without
losing anything — nothing closes or resets, it just gets small:

- **Each AI's column** — click the **⌄** button in that column's header
  (next to 🔍 and ⟳) to collapse it down to a short bar; click it again (now
  **›**) to bring it back to full size. This is purely visual — a collapsed
  AI is still enabled, still participating in Auto/House Rules, still
  sending, receiving, and capturing replies exactly as before, it's just out
  of view. Independent per column — collapsing Claude's doesn't touch
  ChatGPT's or Gemini's. Collapsed columns move up into the mostly-empty
  space beside the House Rules panel and share it evenly — one collapsed
  column gets the whole width, two split it in half, three in thirds —
  instead of piling up as separate rows the way a fully expanded column
  would. Whatever's still expanded stays in the main row below, full height,
  side by side. Once all three are collapsed that row is empty, so it
  collapses down to nothing and the Transcript/Activity Log panel grows to
  fill the space instead of leaving it unused.
- **The whole window** — the Automation window has its own **⌄** button in a
  thin titlebar at the very top. Clicking it shrinks the entire window down
  to just that titlebar (same screen position, just much shorter); clicking
  it again (now **›**) restores it to exactly the size and position it had
  before.
- **The Transcript/Activity Log panel** — its own header has a **⌄**
  collapse button too, independent of the AI panes: shrink it out of the way
  when you want the panes to have more room and don't need to watch the log
  right now, and bring it back the same way.
- **Role Assignment** — collapsed by default (a small **▾**/**▴** header
  toggle), since it's an occasional-use panel, not something you need open
  all the time.

Collapsed panes are moved off-screen rather than shrunk to nothing, on
purpose: a zero-size browser view risks Chromium treating it as hidden and
throttling it, which would quietly break the very automation collapsing is
supposed to leave alone. Whether a column is collapsed individually or the
whole window is collapsed to its titlebar, every AI keeps sending and
receiving in the background exactly the same as when fully visible.

## Roundtable v2: the always-on baseline

This is the program's default, permanent behavior — not a House Rules format
you start and stop. Every reply any AI gives is checked for a `[TO: X]` tag
on its own line at the very start: `[TO: CHATGPT]`, `[TO: CLAUDE]`, `[TO:
GEMINI]`, `[TO: ALL]`, `[TO: USER]`, or `[TO: NONE]`. The app strips that tag
before showing the message and routes it accordingly:

- **`[TO: CLAUDE]`/`[TO: CHATGPT]`/`[TO: GEMINI]`** — relayed to just that one
  AI. Still shown to you in the transcript, marked with a small "→ Claude"
  style badge so you know who it was for.
- **`[TO: ALL]`** — relayed to both of the other AIs. Badged "→ Everyone".
- **`[TO: USER]`** — meant for you, not another AI. Shown with no badge (this
  is the common case — badging every single message "→ You" would just be
  noise). Nothing gets relayed onward from it.
- **`[TO: NONE]`** — "I have nothing to add." Fully hidden — never shown,
  never relayed.
- **No tag at all** — treated as `[TO: USER]` and shown as-is (this is a
  deliberate fallback, not a silent drop, so a model that forgets the format
  doesn't just vanish).

This runs unconditionally, on every site, for the entire time the app is
open — there's no "start" button for it and nothing to configure. The one
thing that ever suspends it is a **House Rules format** (see below) actively
running: while one of those seven is active, it drives replies with its own
state machine instead, and a `[TO: X]`-looking line in a reply is just left
as plain text, not parsed as a tag. The moment that format is stopped,
tag-routing resumes automatically underneath — there's no separate action
needed to "turn it back on."

The app auto-sends a short prompt explaining this whole system to all three
AIs the first time each pane finishes loading after the app starts (once per
launch, no reply expected) — see step 2 under "Using it" above. That same
text lives in the Prompt Library as **"System Prompt (How Routing Works)"**
if you ever need to resend it.

**Tag routing and mesh routing (Auto/Auto-Both/manual `routing:set`) don't
double up.** Both can independently point at the same target for the same
reply — full mesh routing on, and the AI's own `[TO: X]` tag also naming a
site already covered by that mesh. If you turn a mesh direction on, tag
routing always takes priority for any target it already covers; mesh only
forwards to whatever's left. This used to genuinely duplicate deliveries (a
target getting sent to twice for one reply — once via mesh with the raw,
un-stripped tag still in the body, once via tag routing with the clean,
stripped version) until it was root-caused and fixed.

## House Rules

Instead of manually wiring up Forward/Auto buttons, **House Rules** (in the
Global area) lets you temporarily layer a structured format on top of the
Roundtable v2 baseline above — pick one, hit **Start**, and it runs itself,
suspending tag-routing for as long as it's active. It uses whatever's typed
in **Compose** as the topic/goal. The manual Forward/Auto buttons stay
visible and clickable the whole time (see "Global controls" above) — Stop
always ends the run and hands control back to tag-routing.

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
- **Rotation** *(needs all 3 checked)* — a fixed ChatGPT → Claude → Gemini →
  ChatGPT cycle. Each AI keeps its own full history; only the newest reply
  gets relayed. Whoever's next in the cycle gets it framed as **RESPOND** and
  produces the next visible reply; the third AI (not yet its turn) gets it
  framed as **UPDATE** — told explicitly not to join in yet, just to stay
  caught up — and its one-word `"UPDATED"` acknowledgment is swallowed
  entirely, never shown anywhere. Unlike the other formats, the order is
  fixed on purpose, not shuffled.
- **Blind Round** *(needs all 3 checked)* — for a decision that actually
  matters: all three get the exact same question at the exact same time, and
  none of them can see any answer — not even a hint that the others have
  answered — until all three have independently responded. Only once the
  last one is in does each AI get shown what the *other* two said (never its
  own answer echoed back to it). This exists because three AIs agreeing
  isn't worth much if the second and third only formed their answer after
  seeing the first's — that's anchoring, not independent agreement. It's a
  one-shot technique, not an ongoing mode: it ends itself automatically the
  moment the reveal goes out.

Role assignments show up as a small badge next to that AI's name once a
format with structural roles is running (that's the auto-assigned
Devil/Angel/Referee-style role — not the same thing as the optional Role
Assignment persona feature described above, which you set yourself).

If a reply looks like a rate-limit/usage-cap message (short text matching
phrases like "usage limit" or "try again later"), it's caught **everywhere**
— not just while a House Rules format is active. The turn still shows up in
the transcript (marked ⚠ USAGE LIMIT / `isRateLimited`) so you can see what
happened, but it's never relayed onward: not to routing/Auto's targets, not
into a House Rule's state machine, not as a Prompt Sequence step's reply, not
to a waiting manager task. While a House Rules format is active, it
additionally **auto-pauses** the run (same as before) so you can Resume once
the limit clears; outside one (plain Auto-routing, Prompt Sequence, or no
routing at all), there's nothing structured to pause, so routing/mesh state
is left exactly as it was — only that one message is swallowed.

## Manager / Orchestrator (Phase 1 — backend only, no UI panel yet)

A supervisory layer on top of everything above: instead of you deciding
what to send to which AI and reading through the results yourself, a
**manager** — its own model, separate from ChatGPT/Claude/Gemini — plans a
task, delegates pieces of it to whichever of the three fit, watches what
comes back, asks for corrections or a second opinion when something looks
wrong or the AIs disagree, and saves the result to a real project folder on
disk. It's a supervisor, not a fourth worker: it only writes/researches/
analyzes itself when there's genuinely nothing to delegate.

**The one deliberate exception to "no API keys."** Everywhere else in this
app, that rule means "don't call ChatGPT/Claude/Gemini's official APIs —
drive their real web UIs instead," because that's the entire premise of the
project. The manager is a *different* model — one you run yourself, since
this app assumes you don't have local GPU hardware for it — reached via a
real HTTP API: **RunPod** (serverless or a dedicated pod you rent), **Ollama**
or **LM Studio** (if you ever do get local hardware), or any other
OpenAI-compatible chat-completions endpoint. ChatGPT/Claude/Gemini
themselves are still never touched by anything but `sendTextTo()`/
`pollSite()` — the manager delegates to them exactly the same way Forward,
Auto, House Rules, and Prompt Sequence already do.

**Current status: this is backend + IPC only.** There's no Manager panel in
`controls.html` yet — driving it today means calling the IPC handlers below
directly (e.g. from DevTools console via `window.api`). The two-column
Manager Activity Log / Communication panel, the full automatic 0-4 tier
ladder, RunPod pod idle-shutdown automation, and desktop notifications are
all deferred to a later phase, once this core loop has been used for real.
None of it has been run against an actual RunPod/Ollama/LM Studio backend
from this dev environment either — same caveat as every DOM selector in
this app, the shapes are carefully matched to each provider's documented
API, but real verification needs your actual account/instance.

### Configuring it

`window.api.configureManagerProvider({ provider, endpoint, apiKey, model, tier, timeoutMs, podId, approvalMode, maximumTurns, costLimit, adjudicatorSite })`
— `provider` is one of `"runpod-serverless"`, `"runpod-pod"`, or
`"openai-compatible"` (this last one also covers Ollama/LM Studio, since
both already speak the OpenAI chat-completions shape natively). `endpoint`
is the **full URL** to POST to — this app never guesses or constructs a
RunPod endpoint id into a URL itself, since that composition is
worker-template-specific and is your deployment's call, not this app's.
`window.api.testManagerConnection()` sends a trivial request and reports
whether the endpoint is reachable at all, independent of whether the model
actually followed the JSON-only format.

### Running a task

- `window.api.startManagedTask(userRequest)` — starts a new task (rejected
  with `NOT_CONFIGURED` if no endpoint/model is set, `NEEDS_REQUEST` if the
  request is blank, `ALREADY_RUNNING` if one's already in progress). Creates
  a real folder under your **Documents/AutoInjector Projects/** for this
  task (`project.json` checkpoint, `manager-log.jsonl`, `raw-responses/`,
  `working/`, `sources/`, `versions/`, `final/`) — every response any AI
  gives is preserved raw in `raw-responses/` regardless of what the manager
  later does with it, kept separate from whatever ends up in `final/`.
- `window.api.pauseManagedTask()` / `resumeManagedTask()` / `stopManagedTask()`
  — pausing holds the loop exactly where it is (mid-wait-for-a-reply or
  between turns); resuming picks back up from there, not from the start.
- **Approval mode** (`approvalMode: true`) holds every proposed action
  (except one the manager itself flagged `REQUEST_APPROVAL` for, which is
  always held) for a real decision before it does anything — critically,
  *nothing is sent to any AI pane until approved*, not just hidden from
  view. `window.api.approveManagerAction()` / `rejectManagerAction(reason)`.
- `window.api.getManagerState()` (or the `manager`/`managerConfig`/
  `managerLog` fields already included in the regular `getState()`) reads
  current status, plan, assignments, responses, tier, and any pending
  approval. `onManagerState`/`onManagerLog` subscribe to live updates.

### What the manager can actually do

A fixed action vocabulary — `CLASSIFY, PLAN, DELEGATE, SEND, FORWARD,
COMPARE, CRITIQUE, VERIFY, EXTRACT, ASSEMBLE, REVISE, VALIDATE, SAVE,
EXPORT, ESCALATE, WAIT, FINISH, PAUSE, REQUEST_APPROVAL` — nothing else.
Every decision is validated twice before anything executes: once by
`manager-provider.js` (is this valid JSON with a real action name), then
again by `main.js` (are the targets actually chatgpt/claude/gemini, is a
`SAVE`/`EXPORT` path actually a safe relative path inside this task's own
project folder — no `..`, no absolute paths, ever — does any field contain
something that looks like an attempt at code injection or credential
exposure). A decision that fails either check is logged with the specific
reason and never executed; repeated failures escalate the tier rather than
retrying the same broken thing forever, and a `maximumTurns` cap (default
20) or `costLimit` ends the task outright if it truly can't make progress.

### Tiers, simplified for this phase

The full spec's automatic 0-4 ladder (routing cheaper/more-expensive
provider configs to different situations) is deferred — Phase 1 has one
configurable tier (`managerConfig.tier`, default 2) that escalates by
exactly one step on a provider failure or a repeatedly invalid decision,
and an explicit `ESCALATE` action can jump straight to a requested tier.
**Tier 4 is special even in this phase**: instead of calling the configured
RunPod/Ollama/LM Studio endpoint, it routes the specific question straight
to a real ChatGPT/Claude/Gemini pane (`adjudicatorSite`, default Claude) —
matching the spec's "cloud adjudication" — and steps back down toward the
configured baseline tier automatically once a response lands and the task
is making progress again.

## Picking up where you left off

Your transcript, any custom Role Assignments, and an in-progress House Rules
run (if one was going) are saved to disk automatically as you go, and
restored the next time you open the app. A restored run always comes back
**paused**, never active — the app will never auto-send anything just because
you relaunched it; you decide when to hit Resume. This is separate from
signing in — each site's own login session is already remembered by the
browser pane itself (see above), independent of this.

Each save writes to a temporary file next to the real one, then renames it
into place — so a crash or power loss mid-write can't leave you with a
corrupted, unreadable state file; the real file only ever gets updated as a
complete write. The transcript itself is capped at the 1,000 most recent
turns (oldest dropped first, on both save and load) so a long-running relay
session can't grow it — or the file it's saved into — without bound.

The saved file lives at:
- **Windows**: `%APPDATA%\autoinjector-desktop\autoinjector-state.json`
- **macOS**: `~/Library/Application Support/autoinjector-desktop/autoinjector-state.json`
- **Linux**: `~/.config/autoinjector-desktop/autoinjector-state.json`

Delete that file (app closed) if you ever want a completely clean slate.

## Troubleshooting

The **Activity / Troubleshooting** panel next to the transcript logs every
internal action live — polls that captured a new reply, sends, forwards, errors,
routing/participant changes — each with a timestamp, so if something isn't
working you can see exactly where it's getting stuck instead of guessing.
Picking a selector and running the connectivity Test both log in detail, not
just "started"/"done": a pick logs which role was requested, and on success
the exact selector it landed on plus a sample of the text/element it actually
captured; a Test run logs the token it sent, when it started waiting on a
reply, and on failure exactly what went wrong — including, for a mismatch,
what text it *did* capture instead of the token, which is usually the
fastest way to tell whether a selector is finding nothing at all versus
finding the wrong element.

That panel only shows the current session, though — if the app crashes or you
close it before catching the problem, that log is gone. A rolling copy is
also written to disk (capped at ~2000 lines) right next to the state file
above, as `autoinjector-debug.log`. If something breaks and you want help
tracking it down, that file plus a description of what you were doing is the
most useful thing you can send.

If a specific AI's card never shows a captured reply even though its pane
clearly has one on screen, or messages seem to stop going out entirely, that
means the DOM selector for reading (or typing into/sending) that site
(`selectors.js`) doesn't match its current layout anymore — sites change
their markup without notice, and this app has no way to detect *why*
something isn't matching, only that it isn't. A send that doesn't actually
go through gets reported distinctly, as `SEND_NOT_CONFIRMED` in the Activity
Log, rather than silently pretending to succeed — `automation.js` checks
that clicking Send (or pressing Enter) actually cleared the input box (now
polled over ~2.5s rather than a single fixed 500ms snapshot, so a
genuinely-slow-but-real send has room to confirm instead of being falsely
flagged), which every real chat UI does the instant a message is genuinely
submitted, instead of just trusting that the click didn't throw an error.
`SEND_NOT_CONFIRMED` used to spike hard under mesh routing (a real session's
Activity Log showed roughly a 50% failure rate) — the actual cause was two
different sites capturing a reply in the same ~1.5s poll cycle and both
routing to the same third target, firing two send scripts against that
target's pane at once and stomping on each other's typing. Every send now
goes through a per-target queue (`sendQueues`/`withSendQueue()` in
`main.js`) so only one send script ever runs against a given pane at a
time; a second concurrent call for the same target simply waits its turn
instead of colliding with the first. The common case (nothing else already
sending to that target) still calls straight through with zero added
overhead — only genuinely concurrent sends to the same site pay for
serialization.

### The delivery ledger: the program's own record of what actually happened

Every send the app ever makes — Compose, Forward, a House Rules dispatch, a
tag-routed relay, a Prompt Sequence step, a manager delegation, all of it —
gets its own entry in a delivery ledger, recorded from one place
(`recordLedgerEntry()`, called from inside `sendTextTo()` itself) so nothing
needs separate bookkeeping to stay covered. Each entry carries a
program-assigned id (`MSG-<n>`), the real source site (or `null` for
something you sent directly), the target, a preview of what was actually
sent, whether it was confirmed delivered or failed (and the specific error
if it failed), and whether it looks like a duplicate of something sent to
the same target within the last 5 seconds. This is deliberately the
program's own record, not any AI's — an AI's own reasoning about whether its
message "got through" is never trustworthy on its own, since it has no real
visibility into browser automation succeeding or failing. The ledger is
available via `state:get` (`ledger`) and broadcasts a `ledger-entry` event
live as each one is recorded, ready for a future UI panel; this pass is
data-only, on purpose — nothing in this app currently injects delivery
status back into what gets sent to an AI, since that's a real behavior
change worth deciding deliberately rather than bundling in silently.

### 🧪 Checking whether it's actually working: the connectivity test

Every AI column has a **🧪 Test** button (inside the 🎯 menu described
below). Click it and the app sends that site a real prompt containing a
fresh, one-off token — but instead of asking for that token back verbatim,
it asks the AI to reply with the token **reversed**. That's deliberate: a
too-broad reply selector that's actually reading the sent prompt back (not
a real reply) would trivially "pass" a plain echo test, since the token is
right there in the outgoing message. Asking for a transformed version and
checking for it — while confirming the *original*, untransformed token is
**absent** — closes that hole. A small dot next to the AI's name turns
**amber** while it's running, **green** the moment a reply containing the
reversed token (and not the original) lands, or **red** with one of four
distinct failure reasons spelled out inline:
- **too broad** — both the original and reversed token came back (almost
  always means the selector is reading the whole thread, prompt included,
  not just the actual reply)
- **echo** — only the original token came back (the selector is very likely
  reading the outgoing message, not any reply at all)
- **mismatch** — something came back, but it matches neither form (reading
  is probably picking up the wrong element entirely)
- **timeout** — nothing came back within 45 seconds

This is the fast way to answer "is this AI actually hooked up right now"
without having to read anything yourself or guess from the Activity Log —
and, unlike a plain token echo, it can't be fooled by a selector that's
merely reading something back.

### 🎛️ The Tuner: testing the whole relay, not just one AI at a time

The 🧪 Test button proves "can I reach this one AI" — it says nothing about
whether a message actually gets from one AI to another. **Run Tuner**
(Global panel) answers that: it runs the connectivity test on all three
sites, then genuinely tests all **6 directed pairs**
(chatgpt→claude, claude→chatgpt, chatgpt→gemini, gemini→chatgpt,
claude→gemini, gemini→claude) — not just whichever routing you currently
have turned on. It takes a few minutes; the Global panel shows live
progress, and every individual check lands in the Activity Log in detail
(`tuner-leg-started`/`-ok`/`-error`), with a one-line pass/fail summary at
the end.

Proving delivery is harder than it sounds: `pollSite()` only ever reads
what an AI's own reply *says*, never what it *received* — there's no way to
directly observe "did B get A's message" without B producing some checkable
reply. Asking a model to relay text literally, without answering it, is
fragile in practice — models tend to answer what's in front of them rather
than pass it through inertly, so a naive version of this test would be
testing "did the AI follow a weird meta-instruction," not "does the relay
work."

The trick that avoids that: each leg asks **one question that works for
both hops**. Source, addressed directly, is asked to reply with `RELAY-TEST
<token>` plus one trailing conditional line: *"if you're seeing this
because it was forwarded to you by another AI, instead reply with
RELAY-RECEIVED `<token>`."* The leg temporarily turns on mesh routing for
just that pair (restored afterward — never touches routing you've set up
yourself), which forwards source's entire reply, conditional instruction
included, to target — now wrapped in the usual "[Source says] ..." framing.
Target, seeing itself addressed via a forward rather than directly, follows
the *else* branch and replies `RELAY-RECEIVED <token>` instead. Neither AI
is ever asked to suppress its own reasoning and blindly forward something —
both just answer the message actually in front of them, and which branch
fires tells you, unambiguously, whether the message actually arrived.

A failed leg is reported with the exact stage it failed at: `source-send`
(couldn't even send to the source), `source-reply` (source never answered
its own half correctly — that's the same class of problem the 🧪 Test
button would catch), or `relay` (source answered fine, but target never got
the forward, or got it and didn't reply as expected — this is the one that
specifically points at the relay path itself, not either AI's own
connection). That's the "what do we need to fix to get to 100%" breakdown —
a broken relay leg looks different from a broken individual connection, and
now you can tell which one you're looking at.

### 🎯 Fixing it yourself: the selector picker

The same button also opens a small menu with **Pick Input**, **Pick Send**,
**Pick Reply**, and **Clear Overrides**. Click one of the first three, then
click the real element live in that pane — the input box you type into, the
actual Send button, or the text of an actual reply. The app captures that
exact click (it never actually submits anything — the click's default
action is prevented), works out a selector for it, and — before saving
anything — validates it against the live page right then, in the same tick
as the click: the generated selector actually has to resolve back to (at
least) the clicked element, that element has to be visibly on screen (not
zero-size/hidden), and it has to be the right *kind* of element for the role
(an editable box for Input, a real button for Send). A **Pick Reply** also
gets checked against whatever was most recently sent to that site — if the
captured sample just echoes that outgoing message, the pick is rejected
rather than saved as if it read a genuine reply. Any of these failures shows
the specific reason inline (e.g. "that looks like it's just the last message
sent, not a real reply") instead of silently saving a bad override. Once a
pick passes every check, the selector (and, for a reply pick, a short sample
of its text) is shown right there as confirmation. **Clear Overrides** drops
all three roles for that site back to the built-in defaults if a pick turns
out wrong anyway. Overrides persist across restarts the same way everything
else does. Run 🧪 Test again afterward to confirm the pick actually fixed
things.

This replaces needing to open DevTools yourself for the common case (a site
renamed a class or restructured its composer). If picking doesn't land on
the right element (rare, but a heavily nested or virtualized UI can confuse
the "find the nearest meaningful ancestor" heuristic it uses), or if you'd
rather hand me the fix directly, the manual route still works: click the 🔍
button on that AI's card to open Chrome DevTools on that exact pane,
right-click the actual input box, Send button, or a reply bubble →
**Inspect**, and send the element's tag/class/attributes — that's what lets
me fix `selectors.js` itself for real, rather than guessing again.

## How it's built

- `main.js` — Electron main process. Each site's pane is positioned by
  measuring an empty placeholder div (`#pane-slot-<site>`) inside the control
  panel's own HTML and copying its exact on-screen rectangle, so the live pane
  sits directly under that AI's control strip and collapses cleanly when the
  participant is unchecked — no hardcoded split. Polls each pane's latest
  reply every ~1.5s to detect when it's finished streaming, routes messages
  (manual, per-pane auto, the global full-mesh Auto, or a House Rules format)
  between panes, and keeps an in-memory activity log of everything that
  happens. Everything lives in one `BaseWindow` — one `WebContentsView` per
  AI site plus one full-window `WebContentsView` for the control panel —
  plus three on-demand popup windows (Prompt Editor, Document Viewer, Prompt
  Sequence) that only get created the first time they're actually needed. A
  generic `broadcast()` sends every UI update to every open window at once,
  so they all stay in sync. Roundtable v2's `[TO: X]` tag-parsing is the
  program's permanent baseline: `pollSite()` runs it on every captured reply
  from every site unconditionally, *unless* one of the seven House Rules
  "stage" formats (tracked in a `STAGE_MODES` set) is currently active, in
  which case that format's own state machine takes over instead — there's no
  separate "start Roundtable" event, so the instant a stage is stopped,
  tag-routing is simply what runs on the next captured reply, automatically.
  A `[TO: NONE]` reply, or a stage's own internal "swallow" cases
  (Chargeback's Referee acknowledgments, Rotation's `"UPDATED"`
  confirmations), never reach the transcript at all. Each site view gets a
  one-time `did-finish-load` listener that fires
  `sendStartupRoutingPromptOnce()` — sends the routing-explainer prompt
  (Prompt Library id 2) once per app launch, guarded by a `Set` so a later
  manual reload doesn't re-trigger it. A short list of rate-limit/usage-cap
  phrases is checked against every new reply unconditionally, not just while
  a House Rules stage is active — a match is always captured/shown
  (`isRateLimited`) but never relayed onward (routing, House Rules, Prompt
  Sequence, and a waiting manager task all skip it); a House Rules stage
  additionally auto-pauses itself on a match, same as before. Transcript,
  custom roles, saved Prompt Library entries, and paused-run state are
  written to a debounced JSON snapshot in `app.getPath("userData")` on every
  meaningful change (atomically — a temp file is written and renamed into
  place, never an in-place write, so a crash mid-save can't corrupt it) and
  reloaded on startup (always as **paused**, never active — a restart must
  never auto-send). The transcript itself is capped at `MAX_TRANSCRIPT`
  (1,000) entries, oldest evicted first, both on push and on load. Prompt
  Library sends (`prompts:send`) reuse the same
  `sendTextTo()` every other manual send goes through, just once per AI with
  that AI's own text instead of one shared message — an empty/blank field for
  a site is treated as "don't send to it," not "send nothing." Saving or
  deleting a prompt also broadcasts `prompts-changed` to every open window,
  which is how the Automation window's dropdown stays in sync when a save
  actually happened from the separate prompt-editor popup. The **Prompt
  Sequence** backend (`startSequence()`/`sendSequenceStep()`/
  `handleSequenceCapture()`) is a linear queue of `{target, text}` steps,
  sent one at a time — each step's target's next captured reply (or, for an
  "all" step, the first of the three to reply) advances to the next step,
  rather than firing on a timer. Each dispatch stamps `seq.generation` (a
  monotonic counter) into `seq.dispatchGen[site]` for every site it sends
  to; `handleSequenceCapture()` requires a capturing site's own
  `dispatchGen` entry to match the sequence's *current* generation before
  accepting it, discarding (and logging,
  `sequence-stale-capture-ignored`) anything that doesn't — the same
  stale-continuation guard pattern the manager loop uses via `taskId`,
  applied here to stop an in-flight reply for a step the sequence has
  already advanced past from being misread as satisfying whatever step
  comes next. **Zoom** (`site:zoom`) calls
  `webContents.setZoomFactor()` directly on the live site view, clamped to
  [0.4, 2.0] — it zooms the real embedded page, not the app's own UI. The
  **selector picker** (`selector:pick`/`selector:clear`) is the self-service
  alternative to sending me a DevTools screenshot: it runs
  `buildPickScript()` (see `automation.js` below) in the target pane, which
  resolves once the user clicks the real element for that role — and, in
  that same click handler, also resolves `matchCount` (does the generated
  selector actually find the element back), `visible` (is it on-screen with
  real dimensions), and `roleOk` (is it the right kind of element for
  `input`/`send`; always true for `assistant`, which has no fixed tag).
  `selector:pick`'s handler rejects the pick (never saving anything) if any
  of those come back bad, or — for an `assistant` pick specifically — if the
  captured sample `looksLikeEcho()` the last thing actually sent to that
  site (`state.lastSentTo[site]`), the same shared helper the connectivity
  test's echo detection uses. Only once a pick clears all of that does it
  get stored in `state.selectorOverrides[site][role]`
  (`input`/`send`/`assistant`), persisted the same way as everything else.
  `sendTextTo()` and `pollSite()` both pass `state.selectorOverrides[site]`
  into `buildSendScript()`/`buildReadScript()`, which try it *before*
  `selectors.js`'s built-in candidates rather than instead of them, so a bad
  pick never fully locks you out — clearing the override (or just picking
  again) falls straight back to the built-ins. The **connectivity test**
  (`selftest:run`) is a genuine end-to-end check, not a ping: it generates a
  fresh, effectively-unique token and sends a prompt asking that site to
  reply with the token **reversed** — not echoed verbatim — via the same
  `sendTextTo()` every other manual send uses, bypassing routing entirely,
  then polls `state.captured[site]` — which `pollSite()` already keeps
  current on its normal cycle — for a capture at or after the send.
  `waitForTestReply()` classifies whatever lands into one of four outcomes:
  the reversed token present *without* the original is `ok: true`; both
  present is `SELECTOR_TOO_BROAD` (almost always reading the whole thread,
  prompt included); only the original is `REPLY_ECHO` (reading the outgoing
  message, not any reply); neither is `REPLY_MISMATCH` (something came back,
  but it's not a match either way); nothing at all is `TIMEOUT`. Asking for
  a transformation instead of an echo, and requiring the original token's
  *absence*, closes the specific false-positive a plain echo test can't
  catch: a too-broad `assistant` selector that reads the sent prompt back
  would trivially "pass" a verbatim-echo test, since the token is right
  there in what was sent. A `selftestInFlight` set
  keyed by site rejects a second concurrent run for the same site
  (`ALREADY_RUNNING`) rather than crossing two tests' results. The
  connectivity test's own send/wait/log logic is factored out into
  `runConnectivityTest(site)` so the **🎛️ Tuner** (`tuner:run`) can reuse it
  verbatim across all three sites rather than duplicating it. The Tuner's
  own relay-leg check (`runRelayLegTest(source, target)`) proves actual
  A-to-B delivery, not just individual reachability, by temporarily adding
  `target` to `state.routing[source]` (restored in a `finally` block,
  never touching a routing pair that was already there) and asking source
  ONE question whose answer works for both hops: answered directly, source
  replies `RELAY-TEST <token>`; mesh then forwards that whole reply
  (including its own trailing conditional instruction) to target, which —
  seeing itself addressed via a forward rather than directly — follows the
  else-branch and replies `RELAY-RECEIVED <token>` instead. Neither AI is
  ever asked to blindly relay text without answering it, which is the
  fragile approach that tends to fail in practice; both hops just answer
  the message actually in front of them. `tunerInFlight` guards against a
  manual 🧪 Test colliding with a Tuner run touching the same site (checked
  in the `selftest:run` handler, not inside `runConnectivityTest()` itself,
  since the Tuner's own internal calls need to go through even while it's
  the one holding that flag).
  `logEvent()`
  also appends every internal
  event to a capped, rolling debug log file in the same folder, so a real
  crash still leaves something to troubleshoot from. Delivering an actual
  *file* into a pane (📎 Attach Document) can't go through
  `executeJavaScript()` like everything else, since that can only inject
  text — `attachFileToSite()` instead drives the Chrome DevTools Protocol
  directly (`webContents.debugger`), the same underlying technique
  Puppeteer/Playwright use for file uploads: find the page's file input,
  then `DOM.setFileInputFiles` it with the real path, which fires the same
  `input`/`change` events a genuine drag-drop would. The attach/detach cycle
  is scoped to a single Send click, but it shares its underlying CDP slot
  with the 🔍 Inspect DevTools feature — having both attached to the same
  pane at once can make the attach fail (reported as `ATTACH_FAILED`), a
  rare, self-resolving collision rather than something worth special-casing.
  The **manager/orchestrator loop** (`runManagerTurn()`/`executeManagerAction()`/
  `handleManagerCapture()`, see the section above) is event-driven the same
  way Prompt Sequence is: a `DELEGATE`-family action sends via `sendTextTo()`
  and returns immediately, and `handleManagerCapture()` — hooked into
  `pollSite()`'s dispatch exactly like `handleSequenceCapture()` — resumes
  the loop once every pending target has actually replied, rather than
  blocking on a wait. Because `runManagerTurn()`/`handleManagerCapture()`
  are always fire-and-forget from whatever triggers them (`manager:stop`,
  a reject/approve, a captured reply), each one captures its task's id
  before its first `await` and re-checks `state.manager.taskId` (and that
  the task hasn't been stopped) immediately after — otherwise a slow
  provider response arriving after the user stops or replaces the task
  could still go on to mutate whatever task is running *now*.
- `manager-provider.js` — the manager's interchangeable backend
  (`askManager()`), the one deliberate exception to "no API keys" in this
  app (see the Manager section above for why). Every supported provider —
  RunPod Serverless's own OpenAI-compatible workers, a dedicated RunPod pod,
  Ollama, LM Studio, or any other OpenAI-compatible endpoint — speaks the
  same request/response shape, so there's no provider switch in the HTTP
  logic itself, only `config.endpoint`/`config.apiKey` change; a separate
  `startPod`/`getPodStatus`/`waitUntilReady`/`stopPod` group handles a
  dedicated RunPod pod's own lifecycle via RunPod's REST API, kept isolated
  since it's the least-standardized, least-tested part of this file. A
  response is only ever treated as a decision once it round-trips through
  real JSON parsing (recovering a `{...}` block even if the model wrapped it
  in stray prose) and its `action` is confirmed to be one this app actually
  knows — main.js's own, deeper validation (safe paths, real targets, no
  injection attempts) happens on top of this, not instead of it.
- `automation.js` / `selectors.js` — build two small scripts run inside each AI's
  pane via `webContents.executeJavaScript()`: one to type text into the chat box
  and click send, one to just read whatever the latest reply currently says.
  The send script doesn't trust that clicking Send "worked" just because the
  click didn't throw — it checks that the input box actually went empty
  afterward (what every real chat UI does on a genuine submit), retrying via
  Enter if a wrong/disabled button was clicked instead, and only reports
  success once that's confirmed. Mirrors the selectors used by the browser
  extension's `content.js`/`selectors.js`. A third builder,
  `buildFileInputFinderExpression`, is different in kind from the other
  two — it's not run via `executeJavaScript()`, it's the `expression` field
  of a CDP `Runtime.evaluate` call (see `attachFileToSite()` above), since
  that's what hands back the raw `objectId` `DOM.setFileInputFiles` needs.
  Each site's `FILE_INPUT_CANDIDATES` in `selectors.js` are **best-effort
  guesses, not yet verified against the real sites** — same caveat as every
  other selector list here, fix the same way (🔍 Inspect on the live pane,
  find the actual upload input, update the list). A fourth builder,
  `buildPickScript(role)`, backs the 🎯 selector picker: it's an IIFE that
  returns a `Promise`, which `executeJavaScript()` awaits automatically —
  it shows a small on-page banner, then resolves once the user clicks a real
  element in that pane (capturing that click with `preventDefault`/
  `stopImmediatePropagation` so nothing actually submits or navigates), or
  after a 30s timeout with no click. Selector generation prefers
  `data-testid`/`aria-label`/a non-hashed-looking `id`, then a couple of
  short, non-numeric class names, falling back to a bare tag name; for the
  `input`/`send` roles it first walks up to the nearest `textarea`/
  `[contenteditable="true"]` or `button`/`[role="button"]` ancestor (since a
  click usually lands on an inner text node or icon, not the actual editable
  container or button itself), while `assistant` climbs through plain
  single-child wrapper elements so clicking inner reply text still resolves
  to the smallest element containing the *whole* reply.
- `controls.html` / `controls.js` — the Automation window's control panel UI:
  the AI columns (with zoom, the 🎯 selector-picker menu including 🧪 Test and
  its green/amber/red indicator dot, Forward/Auto/Auto-Both, collapse), Role
  Assignment, House Rules, the Prompt Library's compact dropdown +
  Send/New/Edit/Delete, the 🧵 Prompt Sequence trigger, the collapsed-pane
  strip that shares House Rules' unused space, and the collapsible
  Transcript/Activity Log panel. This is the only window now — there's no
  separate always-open Conversation window anymore, so everything that used
  to live there (the transcript, Role Assignment, Send/Start/Pause/Resume/
  Stop-equivalent controls) is here instead.
- `prompt-editor.html` / `prompt-editor.js` — the small, on-demand popup
  window for creating/editing one Prompt Library entry: a name field, one
  text box per AI, a `→ All` shortcut that copies a shared draft into all
  three, and Save/Cancel. Only created the first time `+ New` or `Edit` is
  clicked; re-navigates the same window (via a `?id=<n>` query string, or
  none for a blank prompt) instead of opening a second one if it's already
  open.
- `prompt-sequence.html` / `prompt-sequence.js` — the small, on-demand popup
  for building a Prompt Sequence: an add/remove-able list of `{target, text}`
  step rows (target picked from a dropdown: All/ChatGPT/Claude/Gemini), a
  Run button that calls `runSequence()` and disables itself while active, a
  status line reflecting `sequence-state` broadcasts from `main.js`, and
  Close. This window doesn't run the sequence itself — `main.js` owns all of
  that state, same division of labor as everywhere else in this app.
- `document-viewer.html` / `document-viewer.js` — the on-demand popup for
  previewing a file before sending it, same lazy single-instance pattern as
  the prompt editor (`?path=<encoded path>` query string). Renders
  differently by file type: images get an `<img>` plus a transparent
  `<canvas>` overlay for click-drag highlight rectangles; text files (capped
  at 500KB) render as real, selectable text with a `Mark Selection` button
  that wraps the current selection in a `<mark>`; PDFs embed via an
  `<iframe>` pointed at a `file://` URL, relying on Chromium's built-in PDF
  viewer — **no highlighting support for PDFs in this version**, since doing
  that properly would mean rendering pages to a canvas ourselves (bundling
  pdf.js) instead of using the built-in viewer, a meaningfully bigger lift
  than "a visual note to yourself" called for; anything else just shows the
  filename, no preview, Send still works. Every highlight (canvas rectangles
  or `<mark>` tags) lives only in that page's own memory/DOM — never
  persisted, never sent to any AI, never touches the actual file on disk.
- `preload.js` — the IPC bridge shared by every window (the Automation
  window and all three popups), talking to the main process over
  `ipcRenderer`/`contextBridge` (no direct Node access from either page,
  same as the sites' own panes).

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
titlebar in place and restores the exact original bounds), and a couple of
routing edge cases (disabling a participant mid-run, House Rules' own Stop
button actually clearing the mesh it set up).

It also covers Roundtable v2's always-on baseline: the routing-explainer
prompt getting auto-sent to every site exactly once on startup, before
anything else; routing for every `[TO: X]` tag with no House Rule ever
started (`CLAUDE`/`CHATGPT`/`GEMINI` relay to just that one and strip the tag
before display, `ALL` relays to the other two, `USER` stays purely visible
with no relay, `NONE` never reaches the transcript at all), a missing-tag
reply falling back to `USER` per the routing prompt's own documented
default, case-insensitive tag matching, and an AI addressing itself being a
no-op instead of a self-relay; and — the core of the stage-vs-baseline
model — that starting a House Rules format (e.g. Debate) suspends
tag-parsing entirely (a `[TO: X]`-looking line in a reply during Debate is
left as plain, untouched text, and the format's own state machine drives the
next send instead of a tag-routed relay), and that stopping it hands control
back to tag-routing automatically on the very next captured reply, with no
separate action needed to re-enable it.

It also covers the mesh/tag double-dispatch bugfix directly: with full mesh
routing on (`routing:auto-all`) and a `[TO: CLAUDE]` tag also naming a
mesh-covered target, that target gets exactly one delivery (the clean,
tag-stripped one from tag routing, not the raw mesh copy) while an
unaddressed site in the same mesh still correctly gets its own separate
mesh copy — checked against `sentLog` counts, the actual message content,
and the delivery ledger (exactly one entry, not flagged `duplicate:true`);
and the same for a `[TO: ALL]` reply with full mesh on, where both other
sites still get exactly one copy each, not two.

It also covers the Prompt Sequence backend: `sequence:open`/
`sequence-editor:close` managing a single popup window instance the same way
the other popups do; steps firing one at a time, each waiting for that
step's actual target to reply before advancing (an unaddressed site's reply
is correctly ignored); an "all" step advancing on the *first* of the three
replies rather than waiting for all three; `sequence:run` rejecting a second
run while one's already active (`ALREADY_RUNNING`) and filtering out
malformed steps (bad target, blank-after-trim text) before rejecting an
empty result (`NO_VALID_STEPS`); and `sequence:stop` marking a run inactive
mid-flight. It also covers the `site:zoom` handler: an in-range factor
passing straight through to `webContents.setZoomFactor()`, and out-of-range
values clamping to the documented [0.4, 2.0] range rather than being
rejected outright.

It also covers the 🎯 selector picker, at two levels. A pure unit-level check
on `automation.js` itself (no Electron mocking involved) confirms a picked
override is embedded *ahead* of the built-in candidates in the scripts
`buildSendScript`/`buildReadScript` actually produce, with the built-ins
still present as fallback, and that omitting the overrides argument
entirely doesn't throw. Then, against the mocked `main.js` orchestration
(`test/mock-electron.js` gained a settable `_nextPickResult` and a
`pickCalls` log, recognizing a pick script by its `__AUTOINJECTOR_PICK__`
marker the same way it recognizes a send script via `typeByKeyboard` —
never simulating real DOM, same fidelity as the rest of that mock): a
successful pick stores the override, reflects it in `state:get`, and
survives to the persisted state file; different sites/roles pick
independently without clobbering each other; a timed-out pick reports
`TIMEOUT` and never stores anything; `selector:pick`/`selector:clear` reject
an unknown site or role; and clearing an override actually removes it. A
separate scenario covers the post-pick validation specifically: a
`matchCount: 0` pick is rejected as `NOT_FOUND`; `visible: false` as
`NOT_VISIBLE`; `roleOk: false` as `WRONG_ELEMENT_TYPE`; an `assistant` pick
whose sample echoes `state.lastSentTo[site]` as `LOOKS_LIKE_ECHO`; none of
these ever become a stored override; and a pick that clears every check
still saves normally.

It also covers the 🧪 connectivity test end to end: the sent prompt actually
asks for the token **reversed**, not echoed, and embeds a real one; a reply
containing the reversed token (and not the original) is a pass; a reply
containing *both* forms is `SELECTOR_TOO_BROAD`; a reply containing only the
original (unreversed) token is `REPLY_ECHO`; a reply that arrives but
matches neither form is `REPLY_MISMATCH`, not miscounted as a pass or a
timeout; `test/mock-electron.js` gained a `_forceSendFail` flag (mirroring
the CDP mock's existing `_forceAttachFail`/`_forceSetFilesFail`) so a send
that never actually submits is reported at the `send` stage without the
test needing to wait out anything; an unknown site is rejected; and starting
a second test for a site that already has one in flight is rejected as
`ALREADY_RUNNING` rather than the two crossing results, with the original
run still resolving normally afterward.

It also covers the 🎛️ Tuner end to end: driving a full run means answering
all three connectivity checks AND all 6 relay legs as they're reached, in
the exact order the Tuner issues them (scripted by watching each site's
`sentLog` grow, extracting the real token from what was actually sent, and
replying as the AI would) — checking the relay prompt itself asks for the
self-selecting conditional reply (never a literal "relay this" instruction),
that the target genuinely receives the forwarded reply verbatim, that the
final summary reports all 3 sites and all 6 legs passing, that mesh routing
is fully cleaned up afterward (nothing left on that wasn't already there),
and that both the start and the final tally land in the Activity Log. A
second scenario proves a concurrent second Tuner run is rejected
(`ALREADY_RUNNING`) and, further, that a manual 🧪 Test is refused
(`TUNER_RUNNING`) while one is in flight rather than racing it.

It also covers rate-limit detection outside House Rules: with plain
Auto-routing wired up (no House Rule active), a usage-cap-looking reply is
still captured and marked `isRateLimited`, but never relayed to any routed
target — and, since there's no House Rule to pause, the mesh routing itself
is left untouched rather than being cleared. And it covers the persisted
state file: on load, a transcript longer than `MAX_TRANSCRIPT` (1,000) gets
capped to the newest 1,000 entries, oldest evicted first — checked by
seeding a 1,051-entry file and confirming both the count and which specific
entries survive.

It also covers the per-target send queue deterministically:
`mock-electron.js` gained a `_sendDelayQueue` (an array of ms to
artificially delay each successive send script against a site, shifted per
call) so a test can fire two sends at the SAME target where the first is
slow (300ms) and the second is instant (0ms), and prove they still land in
`sentLog` in the order they were issued — not the order they'd individually
finish in — with the combined wall-clock time showing they ran one after
another rather than in parallel. This is exactly the scenario that used to
produce a real ~50% `SEND_NOT_CONFIRMED` rate under mesh routing before the
queue existed.

It also covers the delivery ledger: a successful compose records exactly
one entry with the real target, `source:null`, `status:"delivered"`, and a
program-assigned `MSG-<n>` id; a tag-routed relay records the actual
originating site as `source`, never left null or trusted from anything
inside the message text; a forced `SEND_NOT_CONFIRMED` failure still gets
recorded (with the real error), not silently dropped; and sending the exact
same text to the exact same target twice in quick succession flags the
second entry `duplicate:true` while leaving the first alone.

It also covers Blind Round end to end: refuses to start with fewer than 3
participants enabled; all three get the identical prompt in the same
kickoff, each framed as an independent ask; the first (and second) reply to
land does NOT get shown to anyone — `pendingReplies` in the House Rule
snapshot tracks exactly who's left, verified after each of the first two
answers — until the third and final independent answer arrives, at which
point each site's own reveal is checked to contain the OTHER two answers
(correctly labeled) and specifically NOT its own; and the run marks itself
inactive automatically once the reveal goes out, with no further action
needed to end it.

It also covers the manager/orchestrator loop, stubbing out
`manager-provider.js`'s `askManager()` at the module level (main.js's own
`require("./manager-provider")` resolves to the exact same module-cache
entry, so this intercepts every call main.js makes without touching main.js
itself) so full task lifecycles run against a scripted sequence of
decisions instead of a real backend: a complete classify→delegate→capture
a real reply→finish run, checking that the real project folder, checkpoint
file, and raw response actually land on disk; approval mode holding a
proposed action until approved (with an assertion that nothing was actually
sent while it was pending, not just hidden) or discarded on rejection, with
the rejection itself recorded in the manager's own action history; a
decision that's syntactically valid but targets something outside chatgpt/
claude/gemini being rejected and, if it keeps happening, escalating the
tier and eventually ending the task via `maximumTurns` rather than looping
forever; an explicit `ESCALATE` action jumping straight to a requested
tier, Tier 4 routing to a real AI pane instead of the configured provider
and never touching it while at that tier, then de-escalating back down and
resuming the configured provider once a response lands; a `SAVE` action
writing real content to disk under that task's own `final/` folder, and a
path-traversal attempt being refused rather than ever landing outside it;
and pause/resume/stop leaving an in-flight delegation exactly where it was
rather than re-sending anything. `test/manager-provider.test.js` covers the
provider layer directly with a mocked `global.fetch` (no Electron needed at
all): the exact request shape sent (endpoint, Bearer auth, model/messages),
recovering a JSON decision even when wrapped in stray prose, distinguishing
an unparseable reply, a non-2xx response, a network error, and a timeout
from each other, redacting the API key from every error path, and the
RunPod dedicated-pod lifecycle calls hitting the right REST routes.

It also covers the Prompt Library backend: both built-ins existing by
default ("System Test," with each AI's own version correctly naming the
*other* two; "System Prompt (How Routing Works)," whose text for every AI
actually mentions the `[TO: X]` tag syntax), saving a new prompt with
different text per AI, sending it and confirming each AI got its own exact
text with no forwarding wrapper while a blank field's AI got nothing at all,
rejecting a send where every field is blank/whitespace-only instead of
silently doing nothing, editing an existing prompt in place (no duplicate),
deleting one, and that the deletion actually lands in the persisted state
file on disk. It also covers the standalone prompt-editor popup window
itself at the `main.js` level: opening it targets the right prompt (its id
riding along in the URL as a query string), re-opening while it's already
open re-navigates that same window instead of spawning a second one, saving
from it broadcasts `prompts-changed` so the Automation window's dropdown
picks up the change without polling, and closing it actually destroys the
window.

It also covers the 📎 Attach Document backend, using a mocked
`webContents.debugger` (`test/mock-electron.js` records what CDP command was
sent with what params, the same level of fidelity as the rest of that mock —
real DOM stays Playwright's job): a successful send delivers the file to
exactly the checked targets and nothing to the ones left unchecked;
`NO_FILE_INPUT_FOUND`, `SET_FILES_FAILED`, and `ATTACH_FAILED` are each
reported distinctly rather than one generic failure, and — critically — the
debugger session actually detaches even on the failure paths (proving the
`finally` block runs, not just the happy path); a missing file or an empty
target list are both rejected before any per-site work happens;
`document:read` classifies files correctly by extension (text, including
respecting the 500KB preview cap; image and PDF, both getting a `file://`
URL rather than bytes shuttled through IPC; anything else falling back to
filename-only); and `document:choose` opens the file dialog, then the
viewer window targeting whatever was picked, re-targets that same window
(not a second one) if a different file is chosen while it's still open, and
closing it actually destroys the window.

`npm test` also runs `test/controls.test.js`, the same jsdom approach applied
to `controls.html`/`controls.js`: the collapse feature (each AI column's own
toggle relocating it between the collapsed and expanded strips rather than
just adding a class, and that `#collapsed-strip` actually lives inside the
House Rules box; the Automation window's titlebar toggle; that a collapse
event for a different window id is correctly ignored; the Transcript/Log
panel expanding only once *all three* panes are collapsed; the
Transcript/Log panel's own independent collapse button), the Stop
confirmation prompt, that Roundtable v2 has **no** dropdown option anymore
(it isn't a stage you start/stop) while the seven real stage formats still
are, the `→ Claude`/`→ Everyone`-style routing badge rendering on captured
turns, that the manual Forward/Auto/Auto-Both buttons stay visible *and*
genuinely clickable no matter what a House Rules stage is doing (clicking
Auto mid-stage still calls `setRouting`) — proving the old hide-while-active
behavior is gone for good, the combined Auto → Both toggle (one click turns
both individual routes on together, lights up once both are on, a second
click turns both off), the zoom buttons (clicking calls `setZoom` and the
on-screen percentage label updates to match), the 🎯 selector-picker menu
(collapsed by default and toggles open/closed; Pick Input/Send/Reply call
`pickSelector` with the right site/role and show the returned selector plus
sample text inline as confirmation; a failed/timed-out pick shows the real
error instead of pretending success; Clear Overrides clears all three roles
for that site; 🧪 Test calls `runSelfTest`, flips its indicator dot to
pending immediately and to green/red once the result lands, and a failure
shows the specific reason rather than a bare red light), that the Activity
Log itself renders the rich detail these two features log (role, selector,
captured sample, token, and — on a mismatch — the actual text that was
captured instead) rather than just the bare event name, with a `*-error`
entry visibly styled as an error line, the Role Assignment panel
(starts collapsed, Apply/Clear call `setRole` and update the "current: X"
label, the collapse toggle works both ways), the 🧵 Prompt Sequence trigger
button calling `openSequenceEditor`, and the Prompt Library dropdown —
options rendering from the saved list (and a placeholder + disabled buttons
when there are none), Send using the *selected* prompt's saved text, `+
New`/`Edit` calling `openPromptEditor` with the right id (`null` for new)
rather than editing anything inline, Delete removing the selected entry, and
a `prompts-changed` event (simulating the popup window having saved
elsewhere) re-rendering the dropdown live.

`npm test` also runs `test/prompt-editor.test.js`, the same jsdom approach
applied to the standalone `prompt-editor.html`/`prompt-editor.js` popup:
fields start blank with no `?id=` in the URL, populate correctly from the
matching saved prompt when one's given (and degrade gracefully — blank, no
crash — if that id no longer exists), `→ All` copies one shared draft into
all three per-AI boxes, Save passes the id/name/text to `savePrompt` (`null`
id for a new prompt, the original id for an edit — so it updates in place
instead of duplicating) and then closes the window, an empty name is saved
as "Untitled" rather than blank, and Cancel closes without ever calling
`savePrompt` at all.

`npm test` also runs `test/document-viewer.test.js`, the same jsdom approach
applied to the standalone document-preview popup: a missing `?path=` degrades
gracefully instead of crashing; each `kind` from `document:read` renders the
right thing (image → `<img>` + highlight canvas with Clear Highlights, text →
the real content with a working Mark Selection that wraps a selection in
`<mark>`, oversized text → the size-limit message with no mark tool, PDF →
an iframe with *no* highlight tools since those aren't supported there,
unrecognized types → no preview element at all); the image highlight
interaction (mousedown → mousemove → mouseup on the canvas) wires up without
throwing — deliberately not asserted pixel-by-pixel, since jsdom doesn't
implement a real 2D canvas context and the real rendering only matters
inside actual Chromium anyway, same division of labor as everywhere else in
this suite; Send collects only the checked boxes and calls `sendDocument`
with the real decoded path; and the checkboxes default to whichever
participants are currently enabled.

`npm test` also runs `test/prompt-sequence.test.js`, the same jsdom approach
applied to the standalone `prompt-sequence.html`/`prompt-sequence.js` popup:
starts with a single blank "all" step; `+ Add Step` adds rows and removing
one renumbers the rest so there's never a gap; each step's target dropdown
offers All plus each of the three sites; Run Sequence collects every step
with actual text and calls `runSequence` with the right target/text pairs,
per step; blank/whitespace-only steps are filtered out before that call;
Run with nothing filled in shows a status message instead of ever calling
the backend; a rejected run (e.g. `ALREADY_RUNNING`) re-enables the Run
button and surfaces the real error; `sequence-state` broadcasts drive the
status line's progress text and the Run button's disabled state, both while
running and once finished; and Close calls `closeSequenceEditor`.

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

It also has one check for `buildFileInputFinderExpression` — confirming its
selector-matching logic actually resolves to a real `<input type="file">`
element against genuine Chromium DOM, not just in theory. That's the limit
of what this suite can verify for 📎 Attach Document, though: the actual CDP
wiring (`Runtime.evaluate` → `DOM.setFileInputFiles`) has no Playwright
equivalent, since `webContents.debugger` is an Electron main-process-only
API — that part is covered by the mocked orchestration tests in
`test/run.js` instead, plus manual testing against the real app.

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
